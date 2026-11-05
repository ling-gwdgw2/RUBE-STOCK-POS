/**
 * RUBE-STOCK-POS v3.1 Phase 1 Embedded SQLite Read/Write Split Pool & Domain Engine
 *
 * Implements WBS-02, WBS-03, WBS-05 & WBS-06 on real SQLite (`node:sqlite`):
 * 1. 5-Step FK-Safe Migration Runner executing `0001_initial_v3_1_schema.sql` (34 tables + 3 immutable triggers)
 * 2. Read/Write Split Pool:
 *    - 1 Dedicated Writer Connection serialized via an In-Memory FIFO Queue using `BEGIN IMMEDIATE TRANSACTION;`
 *    - 4–8 Concurrent Reader Connections configured with `PRAGMA query_only = ON;`
 * 3. `PO_SVC` & `INV_SVC`:
 *    - Exact Landed Cost Apportionment (`i128` Largest Remainder Method)
 *    - Moving Weighted Average Cost (MAC) with Negative/Zero Stock Guard (`Q_curr <= 0`)
 *    - Immutable Double-Entry Audit Ledger (`inventory_transactions`)
 * 4. `BOM_SVC`:
 *    - Real-time DFS Cycle Detection (`HTTP 422 Circular BOM Dependency`) persisted in `item_components`
 *    - Pre-Built Batch Production (`PRODUCTION_BUILD` for `use_production = 1` items)
 *    - Multi-Level BOM Recipe COGS Rollup & Deduction with Role-Based Modifiers (`ROLE_SCALE_BPS`)
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  allocateLandedCostExact,
  computeNewMovingAverageCost,
  type BasisPoints,
  type MicroBaht,
  type MilliUnit,
  type Satang,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
} from '../../../shared-contracts/src/fixed-point.ts';
import {
  calculateOrderLineDeductions,
  validateBomDagAcyclic,
  type BomEdgeDto,
  type ComponentRole,
  type ItemVariantDto,
  type ModifierDto,
} from '../../../shared-contracts/src/ipc-commands.ts';
import {
  SEED_BOM_EDGES,
  SEED_MODIFIERS,
  SEED_VARIANTS,
} from '../../../shared-contracts/src/mocks/mock-ipc-bridge.ts';

export const DEV_SQLCIPHER_RAW_HEX_KEY_64 =
  '98483C6EB40B6C31A448C22A66DED3B5E5E8D5119CAC8327B655C8B5C4836489';

export interface CreatePurchaseOrderInput {
  poNumber: string;
  outletId: string;
  supplierId: string;
  createdByUserId: string;
  items: ReadonlyArray<{
    variantId: string;
    orderedQtyMilli: MilliUnit;
    receivedQtyMilli: MilliUnit;
    baseUnitCostMicroBaht: MicroBaht;
  }>;
  landedCosts: ReadonlyArray<{
    costType: 'FREIGHT' | 'CUSTOMS_DUTY' | 'INSURANCE' | 'HANDLING' | 'OTHER';
    description: string;
    amountSatang: Satang;
  }>;
}

export interface PoReceivePreviewLine {
  variantId: string;
  itemName: string;
  receivedQtyMilli: MilliUnit;
  baseUnitCostMicroBaht: MicroBaht;
  allocatedLandedCostMicroBaht: bigint;
  effectiveUnitCostMicroBaht: MicroBaht;
  stockBeforeMilli: MilliUnit;
  stockAfterMilli: MilliUnit;
  macBeforeMicroBaht: MicroBaht;
  macAfterMicroBaht: MicroBaht;
  triggeredNegativeStockGuard: boolean;
}

export interface PoReceiveResult {
  purchaseOrderId: string;
  poNumber: string;
  totalLandedCostSatang: Satang;
  totalAllocatedLandedMicroBaht: bigint;
  lines: PoReceivePreviewLine[];
}

export interface ProductionBuildResult {
  compositeVariantId: string;
  builtQtyMilli: MilliUnit;
  batchUnitCostMicroBaht: MicroBaht;
  newCompositeStockMilli: MilliUnit;
  newCompositeMacMicroBaht: MicroBaht;
  consumedComponents: ReadonlyArray<{
    componentVariantId: string;
    consumedQtyMilli: MilliUnit;
    componentCostMicroBaht: MicroBaht;
  }>;
}

export class SqliteReadWritePoolEngine {
  private readonly dbPath: string;
  private readonly writerConn: DatabaseSync;
  private readonly readerConns: DatabaseSync[] = [];
  private nextReaderIndex = 0;
  private writerQueue: Promise<unknown> = Promise.resolve();

  constructor(
    dbPath: string,
    rawHexKey64: string = DEV_SQLCIPHER_RAW_HEX_KEY_64,
    readerPoolSize: number = 4
  ) {
    if (rawHexKey64.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(rawHexKey64)) {
      throw new Error('SQLCipher Raw Hex Key must be exactly 64 hexadecimal characters');
    }
    this.dbPath = dbPath;

    // 1. Open Dedicated Single-Writer Connection
    this.writerConn = new DatabaseSync(dbPath);
    this.configureConnectionPragmas(this.writerConn, rawHexKey64, false);

    // 2. Run 5-Step FK-Safe Initial Migration on Writer before opening Readers
    this.runInitialSchemaMigrationIfNeeded();

    // 3. Open 4–8 Concurrent Reader Connections (`query_only = ON`)
    const clampedReaders = Math.max(4, Math.min(8, readerPoolSize));
    for (let i = 0; i < clampedReaders; i++) {
      // For in-memory `:memory:` testing, share the writer handle or open file-backed readers
      const reader = dbPath === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(dbPath);
      this.configureConnectionPragmas(reader, rawHexKey64, true);
      this.readerConns.push(reader);
    }
  }

  private configureConnectionPragmas(
    conn: DatabaseSync,
    rawHexKey64: string,
    queryOnly: boolean
  ): void {
    conn.exec(`
      PRAGMA key = "x'${rawHexKey64}'";
      PRAGMA cipher_page_size = 4096;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA query_only = ${queryOnly ? 'ON' : 'OFF'};
    `);
  }

  /**
   * Section 8.2: 5-Step Foreign-Key Safe Atomic Schema Migration Protocol
   */
  private runInitialSchemaMigrationIfNeeded(): void {
    const existingTable = this.writerConn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() as { name?: string } | undefined;

    if (existingTable?.name === 'schema_migrations') {
      return;
    }

    const sqlPath = resolve('packages/core-engine/migrations/0001_initial_v3_1_schema.sql');
    const sqlContent = readFileSync(sqlPath, 'utf8');
    const checksum = createHash('sha256').update(sqlContent).digest('hex');
    const startMs = Date.now();

    // Strip connection-level PRAGMA statements (journal_mode, synchronous, foreign_keys)
    // because SQLite prohibits changing safety level (PRAGMA synchronous/journal_mode) inside a transaction.
    const transactionalDdl = sqlContent.replace(/^\s*PRAGMA\s+[^;]+;\s*$/gim, '');

    // Step 2: Disable Foreign Keys OUTSIDE transaction
    this.writerConn.exec('PRAGMA foreign_keys = OFF;');

    try {
      // Step 3: Execute Transactional DDL & Foreign Key Check
      this.writerConn.exec('BEGIN EXCLUSIVE TRANSACTION;');
      this.writerConn.exec(transactionalDdl);

      const fkViolations = this.writerConn.prepare('PRAGMA foreign_key_check;').all();
      if (fkViolations.length > 0) {
        throw new Error(`Foreign key check failed during migration: ${JSON.stringify(fkViolations)}`);
      }

      const elapsedMs = Date.now() - startMs;
      this.writerConn
        .prepare(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?, ?, ?, ?)'
        )
        .run(1, '0001_initial_v3_1_schema.sql', checksum, elapsedMs);

      this.writerConn.exec('COMMIT;');
    } catch (err) {
      this.writerConn.exec('ROLLBACK;');
      throw err;
    } finally {
      // Step 4: Re-enable Foreign Keys
      this.writerConn.exec('PRAGMA foreign_keys = ON;');
    }
  }

  /**
   * Executes a write transaction through the Single-Writer FIFO Serialization Queue
   * wrapped in `BEGIN IMMEDIATE TRANSACTION; ... COMMIT;`.
   */
  public executeWriteImmediate<T>(fn: (writer: DatabaseSync) => T): Promise<T> {
    const nextTask = this.writerQueue.then(() => {
      this.writerConn.exec('BEGIN IMMEDIATE TRANSACTION;');
      try {
        const result = fn(this.writerConn);
        this.writerConn.exec('COMMIT;');
        return result;
      } catch (err) {
        try {
          this.writerConn.exec('ROLLBACK;');
        } catch {
          // ignore rollback error if already rolled back by RAISE(ABORT)
        }
        throw err;
      }
    });

    // Keep queue alive even if a task throws
    this.writerQueue = nextTask.catch(() => undefined);
    return nextTask;
  }

  /**
   * Executes a read query on the round-robin Concurrent Reader Pool (`query_only = ON`).
   */
  public executeRead<T>(fn: (reader: DatabaseSync) => T): T {
    if (this.dbPath === ':memory:') {
      return fn(this.writerConn);
    }
    const reader = this.readerConns[this.nextReaderIndex % this.readerConns.length]!;
    this.nextReaderIndex = (this.nextReaderIndex + 1) % this.readerConns.length;
    return fn(reader);
  }

  public getReaderConnectionForTest(index: number = 0): DatabaseSync {
    return this.readerConns[index % this.readerConns.length]!;
  }

  public close(): void {
    for (const r of this.readerConns) {
      r.close();
    }
    this.writerConn.close();
  }

  /**
   * Seeds the default Outlet, Terminal, Users, Suppliers, Catalog Variants, BOM Edges & Modifiers.
   */
  public async seedDefaultWarehouseAndCatalog(outletId: string = 'OUTLET-HQ'): Promise<void> {
    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO outlets (id, code, name, tax_id, branch_code, rd_pos_reg_no, is_warehouse)
         VALUES (?, 'HQ-01', 'RUBE Flagship Store & Warehouse', '0105566001234', '00000', 'RD-POS-2026-001', 1)`
      ).run(outletId);

      db.prepare(
        `INSERT OR IGNORE INTO pos_terminals (id, outlet_id, terminal_name, role, cluster_epoch)
         VALUES ('POS-TERM-01', ?, 'Main Counter Leader POS', 'LEADER', 1)`
      ).run(outletId);

      db.prepare(
        `INSERT OR IGNORE INTO users (id, username, display_name, role, pin_hash)
         VALUES
           ('USR-OWNER-01', 'owner', 'เจ้าของร้าน (Owner)', 'OWNER', 'sha256:owner_pin'),
           ('USR-CASHIER-01', 'cashier1', 'แคชเชียร์กะเช้า', 'CASHIER', 'sha256:cashier_pin'),
           ('USR-WH-01', 'warehouse1', 'หัวหน้าคลังสินค้า', 'WAREHOUSE', 'sha256:wh_pin')`
      ).run();

      db.prepare(
        `INSERT OR IGNORE INTO suppliers (id, code, name, tax_id, phone)
         VALUES ('SUP-001', 'SUP-THAI-FOODS', 'บริษัท ไทยฟู้ดส์ แอนด์ เบฟเวอเรจ จำกัด', '0105559998887', '02-123-4567')`
      ).run();

      db.prepare(
        `INSERT OR IGNORE INTO categories (id, name, display_color, kitchen_station, sort_order)
         VALUES
           ('CAT-RETAIL', 'สินค้าค้าปลีก & อาหารสด', '#2563EB', 'NONE', 1),
           ('CAT-CAFE', 'เครื่องดื่มคาเฟ่', '#D97706', 'BAR', 2),
           ('CAT-RAW', 'วัตถุดิบและของกึ่งสำเร็จรูป', '#059669', 'PREP', 3)`
      ).run();

      const insertItem = db.prepare(
        `INSERT OR IGNORE INTO items (id, name, category_id, unit_name, track_stock, is_composite, use_production, is_weighted_scale)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
      );
      const insertVariant = db.prepare(
        `INSERT OR IGNORE INTO item_variants (id, item_id, variant_name, sku, barcode, price_satang, default_purchase_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertInvLevel = db.prepare(
        `INSERT OR IGNORE INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht, optimal_stock_milli, low_stock_threshold_milli)
         VALUES (?, ?, ?, ?, ?, 200000, 10000)`
      );
      const insertInvTx = db.prepare(
        `INSERT OR IGNORE INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, 'PO_RECEIVE', ?, 0, ?, ?, 'INITIAL_SEED', 'SEED-001', 'USR-WH-01')`
      );

      for (const v of SEED_VARIANTS) {
        const catId = v.id.includes('RET')
          ? 'CAT-RETAIL'
          : v.id.includes('CAFE')
            ? 'CAT-CAFE'
            : 'CAT-RAW';

        insertItem.run(
          v.itemId,
          v.itemName,
          catId,
          v.unitName,
          v.isComposite ? 1 : 0,
          v.useProduction ? 1 : 0,
          v.isWeightedScale ? 1 : 0
        );
        insertVariant.run(
          v.id,
          v.itemId,
          v.variantName,
          v.sku,
          v.barcode,
          v.priceSatang,
          v.averageCostMicroBaht
        );
        insertInvLevel.run(
          `INV-${outletId}-${v.id}`,
          outletId,
          v.id,
          v.inStockMilli,
          v.averageCostMicroBaht
        );

        if (v.inStockMilli !== 0) {
          insertInvTx.run(
            `TX-SEED-${v.id}`,
            outletId,
            v.id,
            v.inStockMilli,
            v.inStockMilli,
            v.averageCostMicroBaht
          );
        }
      }

      const insertBomEdge = db.prepare(
        `INSERT OR IGNORE INTO item_components (id, composite_variant_id, component_variant_id, component_role, quantity_milli, wastage_basis_points)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const edge of SEED_BOM_EDGES) {
        insertBomEdge.run(
          `BOM-${edge.compositeVariantId}-${edge.componentVariantId}`,
          edge.compositeVariantId,
          edge.componentVariantId,
          edge.componentRole,
          edge.quantityMilli,
          edge.wastageBasisPoints
        );
      }

      db.prepare(
        `INSERT OR IGNORE INTO modifier_groups (id, name, selection_type, min_selections, max_selections)
         VALUES
           ('GRP-SWEETNESS', 'ระดับความหวาน', 'SINGLE', 1, 1),
           ('GRP-TOPPING', 'ท็อปปิ้งเพิ่มเติม', 'MULTIPLE', 0, 3)`
      ).run();

      const insertModifier = db.prepare(
        `INSERT OR IGNORE INTO modifiers (
           id, modifier_group_id, name, price_delta_satang, modifier_mode,
           component_variant_id, quantity_delta_milli, target_component_role, scale_basis_points
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const mod of SEED_MODIFIERS) {
        insertModifier.run(
          mod.id,
          mod.modifierGroupId,
          mod.name,
          mod.priceDeltaSatang,
          mod.modifierMode,
          mod.componentVariantId,
          mod.quantityDeltaMilli,
          mod.targetComponentRole,
          mod.scaleBasisPoints
        );
      }
    });
  }

  /**
   * Reads all variants & their current inventory levels for an outlet using the Reader Pool.
   */
  public listInventoryCatalog(outletId: string = 'OUTLET-HQ'): ItemVariantDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT
             v.id,
             v.item_id AS itemId,
             i.name AS itemName,
             v.variant_name AS variantName,
             v.sku,
             v.barcode,
             i.unit_name AS unitName,
             v.price_satang AS priceSatang,
             COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht) AS averageCostMicroBaht,
             COALESCE(il.in_stock_milli, 0) AS inStockMilli,
             i.is_composite AS isComposite,
             i.use_production AS useProduction,
             i.is_weighted_scale AS isWeightedScale
           FROM item_variants v
           JOIN items i ON i.id = v.item_id
           LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?
           ORDER BY v.id`
        )
        .all(outletId) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        itemId: String(r.itemId),
        itemName: String(r.itemName),
        variantName: String(r.variantName),
        sku: String(r.sku),
        barcode: r.barcode === null ? null : String(r.barcode),
        unitName: String(r.unitName),
        priceSatang: Number(r.priceSatang),
        averageCostMicroBaht: Number(r.averageCostMicroBaht),
        inStockMilli: Number(r.inStockMilli),
        isComposite: Number(r.isComposite) === 1,
        useProduction: Number(r.useProduction) === 1,
        isWeightedScale: Number(r.isWeightedScale) === 1,
      }));
    });
  }

  /**
   * Previews Landed Cost Apportionment & New Moving Average Cost (MAC) in real time before confirming PO Receive.
   */
  public previewPurchaseOrderCosting(input: CreatePurchaseOrderInput): PoReceivePreviewLine[] {
    const catalogMap = new Map(
      this.listInventoryCatalog(input.outletId).map((item) => [item.id, item])
    );

    const totalLandedSatang = input.landedCosts.reduce((sum, lc) => sum + lc.amountSatang, 0);
    const allocated = allocateLandedCostExact(
      input.items.map((i) => ({
        id: i.variantId,
        receivedQtyMilli: i.receivedQtyMilli,
        baseUnitCostMicroBaht: i.baseUnitCostMicroBaht,
      })),
      totalLandedSatang
    );

    return input.items.map((line, idx) => {
      const alloc = allocated[idx]!;
      const existing = catalogMap.get(line.variantId);
      const stockBeforeMilli = existing?.inStockMilli ?? 0;
      const macBeforeMicroBaht = existing?.averageCostMicroBaht ?? 0;
      const macAfterMicroBaht = computeNewMovingAverageCost(
        stockBeforeMilli,
        macBeforeMicroBaht,
        line.receivedQtyMilli,
        alloc.effectiveUnitCostMicroBaht
      );

      return {
        variantId: line.variantId,
        itemName: existing?.itemName ?? line.variantId,
        receivedQtyMilli: line.receivedQtyMilli,
        baseUnitCostMicroBaht: line.baseUnitCostMicroBaht,
        allocatedLandedCostMicroBaht: alloc.allocatedLandedCostMicroBaht,
        effectiveUnitCostMicroBaht: alloc.effectiveUnitCostMicroBaht,
        stockBeforeMilli,
        stockAfterMilli: stockBeforeMilli + line.receivedQtyMilli,
        macBeforeMicroBaht,
        macAfterMicroBaht,
        triggeredNegativeStockGuard: stockBeforeMilli <= 0,
      };
    });
  }

  /**
   * Executes PO Creation + Exact Landed Cost Allocation + MAC Update + Immutable Ledger Recording
   * inside a single serialized `BEGIN IMMEDIATE` transaction (`PO_SVC` & `INV_SVC`).
   */
  public async receivePurchaseOrderWithLandedCosts(
    input: CreatePurchaseOrderInput
  ): Promise<PoReceiveResult> {
    return this.executeWriteImmediate((db) => {
      const poId = `PO-${randomUUID()}`;
      const totalLandedCostSatang = input.landedCosts.reduce((s, c) => s + c.amountSatang, 0);

      const allocated = allocateLandedCostExact(
        input.items.map((i) => ({
          id: i.variantId,
          receivedQtyMilli: i.receivedQtyMilli,
          baseUnitCostMicroBaht: i.baseUnitCostMicroBaht,
        })),
        totalLandedCostSatang
      );

      // Compute subtotal in satang from base Value micro-baht
      const sumBaseMicro = allocated.reduce((acc, a) => acc + a.baseValueMicroBaht, 0n);
      const subtotalSatang = Number(roundDivBigInt(sumBaseMicro, 10_000n));
      const grandTotalSatang = subtotalSatang + totalLandedCostSatang;

      db.prepare(
        `INSERT INTO purchase_orders (
           id, po_number, outlet_id, supplier_id, status,
           subtotal_satang, total_landed_cost_satang, grand_total_satang,
           received_at, created_by
         ) VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`
      ).run(
        poId,
        input.poNumber,
        input.outletId,
        input.supplierId,
        subtotalSatang,
        totalLandedCostSatang,
        grandTotalSatang,
        input.createdByUserId
      );

      const insertLanded = db.prepare(
        `INSERT INTO purchase_order_landed_costs (id, purchase_order_id, cost_type, description, amount_satang)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const lc of input.landedCosts) {
        insertLanded.run(`LC-${randomUUID()}`, poId, lc.costType, lc.description, lc.amountSatang);
      }

      const insertPoItem = db.prepare(
        `INSERT INTO purchase_order_items (
           id, purchase_order_id, variant_id, ordered_qty_milli, received_qty_milli,
           base_unit_cost_micro_baht, allocated_landed_cost_micro_baht, effective_unit_cost_micro_baht
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const getInvLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht, i.name AS item_name
         FROM item_variants v
         JOIN items i ON i.id = v.item_id
         LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?
         WHERE v.id = ?`
      );

      const upsertInvLevel = db.prepare(
        `INSERT INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(outlet_id, variant_id) DO UPDATE SET
           in_stock_milli = excluded.in_stock_milli,
           average_cost_micro_baht = excluded.average_cost_micro_baht,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );

      const insertTx = db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, 'PO_RECEIVE', ?, ?, ?, ?, 'PURCHASE_ORDER', ?, ?)`
      );

      const resultLines: PoReceivePreviewLine[] = [];
      let totalAllocatedLandedMicroBaht = 0n;

      for (let idx = 0; idx < input.items.length; idx++) {
        const line = input.items[idx]!;
        const alloc = allocated[idx]!;
        totalAllocatedLandedMicroBaht += alloc.allocatedLandedCostMicroBaht;

        insertPoItem.run(
          `POI-${randomUUID()}`,
          poId,
          line.variantId,
          line.orderedQtyMilli,
          line.receivedQtyMilli,
          line.baseUnitCostMicroBaht,
          Number(alloc.allocatedLandedCostMicroBaht),
          alloc.effectiveUnitCostMicroBaht
        );

        const row = getInvLevel.get(input.outletId, line.variantId) as
          | { in_stock_milli: number | null; average_cost_micro_baht: number | null; item_name: string }
          | undefined;

        const stockBefore = Number(row?.in_stock_milli ?? 0);
        const macBefore = Number(row?.average_cost_micro_baht ?? 0);
        const stockAfter = stockBefore + line.receivedQtyMilli;
        const macAfter = computeNewMovingAverageCost(
          stockBefore,
          macBefore,
          line.receivedQtyMilli,
          alloc.effectiveUnitCostMicroBaht
        );

        upsertInvLevel.run(
          `INV-${input.outletId}-${line.variantId}`,
          input.outletId,
          line.variantId,
          stockAfter,
          macAfter
        );

        insertTx.run(
          `TX-${randomUUID()}`,
          input.outletId,
          line.variantId,
          line.receivedQtyMilli,
          stockBefore,
          stockAfter,
          alloc.effectiveUnitCostMicroBaht,
          poId,
          input.createdByUserId
        );

        resultLines.push({
          variantId: line.variantId,
          itemName: row?.item_name ?? line.variantId,
          receivedQtyMilli: line.receivedQtyMilli,
          baseUnitCostMicroBaht: line.baseUnitCostMicroBaht,
          allocatedLandedCostMicroBaht: alloc.allocatedLandedCostMicroBaht,
          effectiveUnitCostMicroBaht: alloc.effectiveUnitCostMicroBaht,
          stockBeforeMilli: stockBefore,
          stockAfterMilli: stockAfter,
          macBeforeMicroBaht: macBefore,
          macAfterMicroBaht: macAfter,
          triggeredNegativeStockGuard: stockBefore <= 0,
        });
      }

      return {
        purchaseOrderId: poId,
        poNumber: input.poNumber,
        totalLandedCostSatang,
        totalAllocatedLandedMicroBaht,
        lines: resultLines,
      };
    });
  }

  /**
   * Adds or updates a BOM recipe component edge after running DFS DAG Cycle Detection
   * against all existing edges in SQLite (`BOM_SVC` Section 5.2.1).
   */
  public async upsertBomComponentEdge(edge: BomEdgeDto): Promise<void> {
    await this.executeWriteImmediate((db) => {
      const existingRows = db
        .prepare(
          `SELECT
             composite_variant_id AS compositeVariantId,
             component_variant_id AS componentVariantId,
             component_role AS componentRole,
             quantity_milli AS quantityMilli,
             wastage_basis_points AS wastageBasisPoints
           FROM item_components`
        )
        .all() as unknown as BomEdgeDto[];

      const filtered = existingRows.filter(
        (e) =>
          !(
            e.compositeVariantId === edge.compositeVariantId &&
            e.componentVariantId === edge.componentVariantId
          )
      );
      filtered.push(edge);

      const dagCheck = validateBomDagAcyclic(filtered);
      if (!dagCheck.valid) {
        throw new Error(
          `HTTP 422 Circular BOM Dependency detected: ${dagCheck.cyclePath?.join(' -> ')}`
        );
      }

      db.prepare(
        `INSERT INTO item_components (
           id, composite_variant_id, component_variant_id, component_role, quantity_milli, wastage_basis_points
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(composite_variant_id, component_variant_id) DO UPDATE SET
           component_role = excluded.component_role,
           quantity_milli = excluded.quantity_milli,
           wastage_basis_points = excluded.wastage_basis_points`
      ).run(
        `BOM-${edge.compositeVariantId}-${edge.componentVariantId}`,
        edge.compositeVariantId,
        edge.componentVariantId,
        edge.componentRole,
        edge.quantityMilli,
        edge.wastageBasisPoints
      );
    });
  }

  /**
   * Executes a Pre-Built Sub-Assembly Batch (`PRODUCTION_BUILD`, e.g., cooking a 2,000g pot of Taiwan Boba),
   * deducting raw ingredients and updating the sub-assembly's stock and MAC in `inventory_levels`.
   */
  public async executeProductionBuildBatch(params: {
    outletId: string;
    compositeVariantId: string;
    buildQtyMilli: MilliUnit;
    performedByUserId: string;
  }): Promise<ProductionBuildResult> {
    return this.executeWriteImmediate((db) => {
      const components = db
        .prepare(
          `SELECT component_variant_id, quantity_milli, wastage_basis_points
           FROM item_components
           WHERE composite_variant_id = ?`
        )
        .all(params.compositeVariantId) as Array<{
        component_variant_id: string;
        quantity_milli: number;
        wastage_basis_points: number;
      }>;

      if (components.length === 0) {
        throw new Error(`No BOM components defined for ${params.compositeVariantId}`);
      }

      const getLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht
         FROM inventory_levels
         WHERE outlet_id = ? AND variant_id = ?`
      );
      const updateLevel = db.prepare(
        `UPDATE inventory_levels
         SET in_stock_milli = ?, average_cost_micro_baht = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE outlet_id = ? AND variant_id = ?`
      );
      const insertTx = db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, 'PRODUCTION_BUILD', ?, ?, ?, ?, 'PRODUCTION_BATCH', ?, ?)`
      );

      const batchId = `PROD-${randomUUID()}`;
      const qBuild = BigInt(params.buildQtyMilli);
      let totalBatchCostMicro = 0n;
      const consumedComponents: Array<{
        componentVariantId: string;
        consumedQtyMilli: MilliUnit;
        componentCostMicroBaht: MicroBaht;
      }> = [];

      for (const comp of components) {
        const consumedMilliBig = roundDivBigInt(
          qBuild *
            BigInt(comp.quantity_milli) *
            (SCALE_BASIS_POINTS + BigInt(comp.wastage_basis_points)),
          SCALE_MILLI * SCALE_BASIS_POINTS
        );
        const consumedMilli = Number(consumedMilliBig);

        const lvl = getLevel.get(params.outletId, comp.component_variant_id) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;
        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const unitCostMicro = Number(lvl?.average_cost_micro_baht ?? 0);
        const stockAfter = stockBefore - consumedMilli;

        updateLevel.run(stockAfter, unitCostMicro, params.outletId, comp.component_variant_id);
        insertTx.run(
          `TX-${randomUUID()}`,
          params.outletId,
          comp.component_variant_id,
          -consumedMilli,
          stockBefore,
          stockAfter,
          unitCostMicro,
          batchId,
          params.performedByUserId
        );

        const compTotalCostMicro = roundDivBigInt(
          consumedMilliBig * BigInt(unitCostMicro),
          SCALE_MILLI
        );
        totalBatchCostMicro += compTotalCostMicro;
        consumedComponents.push({
          componentVariantId: comp.component_variant_id,
          consumedQtyMilli: consumedMilli,
          componentCostMicroBaht: Number(compTotalCostMicro),
        });
      }

      // Compute unit cost per 1,000 milli of the newly built composite batch
      const batchUnitCostMicroBaht = Number(
        roundDivBigInt(totalBatchCostMicro * SCALE_MILLI, qBuild)
      );

      const parentLvl = getLevel.get(params.outletId, params.compositeVariantId) as
        | { in_stock_milli: number; average_cost_micro_baht: number }
        | undefined;
      const parentStockBefore = Number(parentLvl?.in_stock_milli ?? 0);
      const parentMacBefore = Number(parentLvl?.average_cost_micro_baht ?? 0);
      const parentStockAfter = parentStockBefore + params.buildQtyMilli;
      const parentMacAfter = computeNewMovingAverageCost(
        parentStockBefore,
        parentMacBefore,
        params.buildQtyMilli,
        batchUnitCostMicroBaht
      );

      updateLevel.run(
        parentStockAfter,
        parentMacAfter,
        params.outletId,
        params.compositeVariantId
      );
      insertTx.run(
        `TX-${randomUUID()}`,
        params.outletId,
        params.compositeVariantId,
        params.buildQtyMilli,
        parentStockBefore,
        parentStockAfter,
        batchUnitCostMicroBaht,
        batchId,
        params.performedByUserId
      );

      return {
        compositeVariantId: params.compositeVariantId,
        builtQtyMilli: params.buildQtyMilli,
        batchUnitCostMicroBaht,
        newCompositeStockMilli: parentStockAfter,
        newCompositeMacMicroBaht: parentMacAfter,
        consumedComponents,
      };
    });
  }

  /**
   * Records a direct stock deduction or stock adjustment (`SALE_DIRECT`, `ADJUSTMENT`, etc.)
   * inside the Single-Writer queue.
   */
  public async recordStockDelta(params: {
    outletId: string;
    variantId: string;
    transactionType: 'SALE_DIRECT' | 'SALE_BOM' | 'SALE_MODIFIER' | 'ADJUSTMENT';
    quantityDeltaMilli: MilliUnit;
    referenceType: string;
    referenceId: string;
    performedByUserId: string;
  }): Promise<{ stockBeforeMilli: MilliUnit; stockAfterMilli: MilliUnit; unitCostMicroBaht: MicroBaht }> {
    return this.executeWriteImmediate((db) => {
      const lvl = db
        .prepare(
          `SELECT in_stock_milli, average_cost_micro_baht
           FROM inventory_levels
           WHERE outlet_id = ? AND variant_id = ?`
        )
        .get(params.outletId, params.variantId) as
        | { in_stock_milli: number; average_cost_micro_baht: number }
        | undefined;

      const stockBeforeMilli = Number(lvl?.in_stock_milli ?? 0);
      const unitCostMicroBaht = Number(lvl?.average_cost_micro_baht ?? 0);
      const stockAfterMilli = stockBeforeMilli + params.quantityDeltaMilli;

      db.prepare(
        `UPDATE inventory_levels
         SET in_stock_milli = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE outlet_id = ? AND variant_id = ?`
      ).run(stockAfterMilli, params.outletId, params.variantId);

      db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `TX-${randomUUID()}`,
        params.outletId,
        params.variantId,
        params.transactionType,
        params.quantityDeltaMilli,
        stockBeforeMilli,
        stockAfterMilli,
        unitCostMicroBaht,
        params.referenceType,
        params.referenceId,
        params.performedByUserId
      );

      return { stockBeforeMilli, stockAfterMilli, unitCostMicroBaht };
    });
  }

  /**
   * Queries SQLite directly to verify Section 9.2 Invariant 1 (`Ledger Conservation Invariant`)
   * across every single variant in the database!
   */
  public verifyLedgerConservationInvariant(outletId: string = 'OUTLET-HQ'): {
    valid: boolean;
    checkedVariantsCount: number;
    mismatches: Array<{ variantId: string; ledgerSumMilli: number; levelStockMilli: number }>;
  } {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT
             il.variant_id AS variantId,
             il.in_stock_milli AS levelStockMilli,
             COALESCE(SUM(tx.quantity_change_milli), 0) AS ledgerSumMilli
           FROM inventory_levels il
           LEFT JOIN inventory_transactions tx
             ON tx.outlet_id = il.outlet_id AND tx.variant_id = il.variant_id
           WHERE il.outlet_id = ?
           GROUP BY il.variant_id, il.in_stock_milli`
        )
        .all(outletId) as Array<{
        variantId: string;
        levelStockMilli: number;
        ledgerSumMilli: number;
      }>;

      const mismatches = rows.filter(
        (r) => Number(r.levelStockMilli) !== Number(r.ledgerSumMilli)
      );

      return {
        valid: mismatches.length === 0,
        checkedVariantsCount: rows.length,
        mismatches,
      };
    });
  }

  /**
   * Lists all BOM edges currently persisted in SQLite (`item_components`).
   */
  public listBomEdges(): BomEdgeDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT
             composite_variant_id AS compositeVariantId,
             component_variant_id AS componentVariantId,
             component_role AS componentRole,
             quantity_milli AS quantityMilli,
             wastage_basis_points AS wastageBasisPoints
           FROM item_components
           ORDER BY composite_variant_id, component_variant_id`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        compositeVariantId: String(r.compositeVariantId),
        componentVariantId: String(r.componentVariantId),
        componentRole: String(r.componentRole) as ComponentRole,
        quantityMilli: Number(r.quantityMilli),
        wastageBasisPoints: Number(r.wastageBasisPoints) as BasisPoints,
      }));
    });
  }

  /**
   * Computes live recipe COGS and ingredient deductions for a composite item in `BOM_VIEW`.
   */
  public computeLiveRecipePreview(
    outletId: string,
    compositeVariantId: string,
    qtyMilli: MilliUnit = 1_000,
    selectedModifierIds: readonly string[] = []
  ) {
    const catalog = new Map(this.listInventoryCatalog(outletId).map((v) => [v.id, v]));
    const rootVariant = catalog.get(compositeVariantId);
    if (!rootVariant) {
      throw new Error(`Variant not found: ${compositeVariantId}`);
    }
    const edges = this.listBomEdges();
    const mods = SEED_MODIFIERS.filter((m) => selectedModifierIds.includes(m.id));
    const deductions = calculateOrderLineDeductions(rootVariant, qtyMilli, mods, catalog, edges);
    const totalCogsMicroBaht = deductions.reduce((sum, d) => sum + d.lineCogsMicroBaht, 0);

    return {
      compositeVariantId,
      itemName: rootVariant.itemName,
      priceSatang: rootVariant.priceSatang,
      totalCogsMicroBaht,
      grossMarginSatang:
        rootVariant.priceSatang - Number(roundDivBigInt(BigInt(totalCogsMicroBaht), 10_000n)),
      deductions,
    };
  }
}
