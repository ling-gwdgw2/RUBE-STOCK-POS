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

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  allocateLandedCostExact,
  computeNewMovingAverageCost,
  computeVatSatang,
  type BasisPoints,
  type MicroBaht,
  type MilliUnit,
  type Satang,
  type TaxMode,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
} from '../../../shared-contracts/src/fixed-point.ts';
import {
  calculateOrderLineDeductions,
  validateBomDagAcyclic,
  type BomEdgeDto,
  type BusinessProfile,
  type CheckoutOrderRequest,
  type ComponentRole,
  type ItemVariantDto,
  type ModifierDto,
  type PosShiftDto,
  type StockDeductionEntry,
  type UserRole,
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

export interface OpenPosShiftInput {
  outletId: string;
  terminalId: string;
  openedByUserId: string;
  shiftNumber: string;
  openingCashSatang: Satang;
  notes?: string;
}

export interface RecordCashDrawerMovementInput {
  shiftId: string;
  movementType: 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
  amountSatang: Satang;
  reason: string;
  performedByUserId: string;
}

export interface CashDrawerMovementRecord {
  id: string;
  shiftId: string;
  movementType: 'OPENING_FLOAT' | 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
  amountSatang: Satang;
  reason: string;
  performedByUserId: string;
  expectedCashAfterSatang: Satang;
}

export interface ClosePosShiftBlindDropInput {
  shiftId: string;
  closedByUserId: string;
  countedCashSatang: Satang;
  notes?: string;
}

export interface CheckoutOrderLineSummary {
  salesOrderItemId: string;
  variantId: string;
  itemName: string;
  quantityMilli: MilliUnit;
  unitPriceSatang: Satang;
  modifiersTotalSatang: Satang;
  lineTotalSatang: Satang;
  lineCogsMicroBaht: MicroBaht;
  selectedModifiers: ReadonlyArray<{
    modifierId: string;
    name: string;
    priceDeltaSatang: Satang;
  }>;
}

export interface CheckoutOrderResult {
  salesOrderId: string;
  idempotencyKey: string;
  replayedFromIdempotencyKey: boolean;
  receiptNumber: string;
  abbTaxInvoiceNo: string;
  outletId: string;
  terminalId: string;
  shiftId: string;
  cashierId: string;
  orderType: CheckoutOrderRequest['orderType'];
  tableOrQueueNo: string | null;
  taxMode: TaxMode;
  subtotalSatang: Satang;
  discountSatang: Satang;
  netBeforeTaxSatang: Satang;
  taxSatang: Satang;
  totalSatang: Satang;
  totalCogsMicroBaht: MicroBaht;
  paymentMethod: CheckoutOrderRequest['paymentMethod'];
  paymentSummaryLabel: string;
  payments: Array<{
    paymentMethod: CheckoutOrderRequest['paymentMethod'];
    amountSatang: Satang;
    cashTenderedSatang: Satang | null;
    changeGivenSatang: Satang | null;
    senderBankCode: string | null;
    slipTransRefLast4: string | null;
  }>;
  cashTenderedSatang: Satang | null;
  changeGivenSatang: Satang | null;
  senderBankCode: string | null;
  slipTransRefLast4: string | null;
  slipTransRefHash: string | null;
  kitchenOrderSequenceId: number | null;
  lines: CheckoutOrderLineSummary[];
  stockDeductions: StockDeductionEntry[];
  createdAt: string;
}

export interface VoidSalesOrderInput {
  salesOrderId: string;
  voidedByUserId: string;
  voidReason: string;
}

export interface VoidSalesOrderResult {
  salesOrderId: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string;
  refundedTotalSatang: Satang;
  paymentMethod: string;
  reversedLedgerEntries: ReadonlyArray<{
    variantId: string;
    restoredQtyMilli: MilliUnit;
    historicalUnitCostMicroBaht: MicroBaht;
    stockAfterMilli: MilliUnit;
  }>;
}

export interface DispatchTransferOrderInput {
  transferNumber: string;
  sourceOutletId: string;
  destinationOutletId: string;
  performedByUserId: string;
  items: ReadonlyArray<{
    variantId: string;
    quantityMilli: MilliUnit;
  }>;
}

export interface TransferOrderDispatchResult {
  transferOrderId: string;
  transferNumber: string;
  sourceOutletId: string;
  destinationOutletId: string;
  status: 'IN_TRANSIT';
  dispatchedItems: ReadonlyArray<{
    variantId: string;
    quantityMilli: MilliUnit;
    transferUnitCostMicroBaht: MicroBaht;
    sourceStockAfterMilli: MilliUnit;
  }>;
}

export interface ReceiveTransferOrderInput {
  transferOrderId: string;
  receivedByUserId: string;
}

export interface TransferOrderReceiveResult {
  transferOrderId: string;
  transferNumber: string;
  destinationOutletId: string;
  status: 'COMPLETED';
  receivedItems: ReadonlyArray<{
    variantId: string;
    quantityMilli: MilliUnit;
    transferUnitCostMicroBaht: MicroBaht;
    destinationStockAfterMilli: MilliUnit;
    destinationMacAfterMicroBaht: MicroBaht;
  }>;
}

export interface ExecuteInventoryCountInput {
  countNumber: string;
  outletId: string;
  createdByUserId: string;
  items: ReadonlyArray<{
    variantId: string;
    countedStockMilli: MilliUnit;
  }>;
}

export interface InventoryCountResult {
  inventoryCountId: string;
  countNumber: string;
  outletId: string;
  totalVarianceSatang: Satang;
  lines: ReadonlyArray<{
    variantId: string;
    expectedStockMilli: MilliUnit;
    countedStockMilli: MilliUnit;
    varianceMilli: MilliUnit;
    snapshotUnitCostMicroBaht: MicroBaht;
    varianceCostSatang: Satang;
  }>;
}

export interface KitchenOrderTicketDto {
  sequenceId: number;
  kitchenOrderId: string;
  salesOrderId: string;
  outletId: string;
  station: string;
  queueNumber: string;
  status: 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
  createdAt: string;
  items: ReadonlyArray<{
    id: string;
    itemSummaryText: string;
    modifiersSummaryText: string | null;
    quantityMilli: MilliUnit;
    status: 'PENDING' | 'DONE';
  }>;
}

export interface SchemaUpgradeInput {
  version: number;
  name: string;
  sqlDdl: string;
  snapshotDir?: string;
}

export interface SchemaUpgradeResult {
  applied: boolean;
  autoRolledBack: boolean;
  version: number;
  name: string;
  checksum: string;
  snapshotPath: string | null;
  foreignKeysEnabledAfter: boolean;
  errorMessage?: string;
}

export interface ShiftZReportDto {
  shiftId: string;
  shiftNumber: string;
  outletId: string;
  terminalId: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openingCashSatang: Satang;
  cashSalesSatang: Satang;
  promptPayQrSalesSatang: Satang;
  cardSalesSatang: Satang;
  voucherSalesSatang: Satang;
  paidInSatang: Satang;
  paidOutSatang: Satang;
  cashDropSatang: Satang;
  voidedOrdersCount: number;
  voidedTotalSatang: Satang;
  completedOrdersCount: number;
  grossSalesSatang: Satang;
  discountTotalSatang: Satang;
  netBeforeTaxSatang: Satang;
  vatTotalSatang: Satang;
  netSalesTotalSatang: Satang;
  expectedCashSatang: Satang;
  countedCashSatang: Satang | null;
  cashVarianceSatang: Satang | null;
}

export interface AbbSalesTaxReportDto {
  outletId: string;
  activeInvoiceCount: number;
  voidedInvoiceCount: number;
  totalNetBeforeTaxSatang: Satang;
  totalVatSatang: Satang;
  totalGrossAmountSatang: Satang;
  invoices: ReadonlyArray<{
    salesOrderId: string;
    abbTaxInvoiceNo: string;
    receiptNumber: string;
    orderType: string;
    taxMode: string;
    status: string;
    subtotalSatang: Satang;
    discountSatang: Satang;
    netBeforeTaxSatang: Satang;
    taxSatang: Satang;
    totalSatang: Satang;
    createdAt: string;
  }>;
}

export interface InventoryValuationReportDto {
  outletId: string;
  totalWarehouseValuationSatang: Satang;
  lines: ReadonlyArray<{
    variantId: string;
    sku: string;
    itemName: string;
    variantName: string;
    unitName: string;
    inStockMilli: MilliUnit;
    averageCostMicroBaht: MicroBaht;
    totalValuationSatang: Satang;
  }>;
}

export interface MenuGrossMarginReportDto {
  outletId: string;
  totalRevenueSatang: Satang;
  totalCogsSatang: Satang;
  totalGrossProfitSatang: Satang;
  lines: ReadonlyArray<{
    variantId: string;
    itemName: string;
    variantName: string;
    soldQtyMilli: MilliUnit;
    grossRevenueSatang: Satang;
    totalCogsMicroBaht: MicroBaht;
    totalCogsSatang: Satang;
    grossProfitSatang: Satang;
    grossMarginBasisPoints: BasisPoints;
  }>;
}

export class SqliteReadWritePoolEngine {
  private readonly dbPath: string;
  private readonly rawHexKey64: string;
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
    this.rawHexKey64 = rawHexKey64.toUpperCase();

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

    const sqlPath = resolve(
      import.meta.dirname ?? resolve('packages/core-engine/src/runtime'),
      '../../migrations/0001_initial_v3_1_schema.sql'
    );
    const sqlContent = readFileSync(sqlPath, 'utf8').replace(/\r\n/g, '\n');
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

      const defaultProfileHmac = this.computeProtectedConfigHmacHex('business_profile', 'HYBRID');
      db.prepare(
        `INSERT OR IGNORE INTO store_config (key, value, is_protected, hmac_signature_hex, updated_by)
         VALUES ('business_profile', 'HYBRID', 1, ?, 'USR-OWNER-01')`
      ).run(defaultProfileHmac);

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
   * deducting raw ingredients (recursively expanding any non-prebuilt virtual sub-recipes) and updating
   * the sub-assembly's stock and MAC in `inventory_levels`.
   */
  public async executeProductionBuildBatch(params: {
    outletId: string;
    compositeVariantId: string;
    buildQtyMilli: MilliUnit;
    performedByUserId: string;
  }): Promise<ProductionBuildResult> {
    if (params.buildQtyMilli <= 0) {
      throw new RangeError(
        `buildQtyMilli must be > 0 for PRODUCTION_BUILD, got ${params.buildQtyMilli}`
      );
    }

    return this.executeWriteImmediate((db) => {
      const targetMeta = db
        .prepare(
          `SELECT i.is_composite AS isComposite, i.use_production AS useProduction
           FROM item_variants v
           JOIN items i ON i.id = v.item_id
           WHERE v.id = ?`
        )
        .get(params.compositeVariantId) as
        | { isComposite: number; useProduction: number }
        | undefined;

      if (!targetMeta) {
        throw new Error(`Composite variant not found: ${params.compositeVariantId}`);
      }
      if (Number(targetMeta.isComposite) !== 1 || Number(targetMeta.useProduction) !== 1) {
        throw new Error(
          `Variant ${params.compositeVariantId} is not configured as a pre-built production item (is_composite=1, use_production=1)`
        );
      }

      const queryEdges = db.prepare(
        `SELECT
           ic.component_variant_id,
           ic.quantity_milli,
           ic.wastage_basis_points,
           i.is_composite AS child_is_composite,
           i.use_production AS child_use_production
         FROM item_components ic
         JOIN item_variants v ON v.id = ic.component_variant_id
         JOIN items i ON i.id = v.item_id
         WHERE ic.composite_variant_id = ?`
      );

      const leafConsumptions = new Map<string, bigint>();
      const collectComponents = (parentVariantId: string, parentQtyMilli: bigint): void => {
        const edges = queryEdges.all(parentVariantId) as Array<{
          component_variant_id: string;
          quantity_milli: number;
          wastage_basis_points: number;
          child_is_composite: number;
          child_use_production: number;
        }>;

        if (edges.length === 0 && parentVariantId === params.compositeVariantId) {
          throw new Error(`No BOM components defined for ${params.compositeVariantId}`);
        }

        for (const edge of edges) {
          const requiredMilli = roundDivBigInt(
            parentQtyMilli *
              BigInt(edge.quantity_milli) *
              (SCALE_BASIS_POINTS + BigInt(edge.wastage_basis_points)),
            SCALE_MILLI * SCALE_BASIS_POINTS
          );
          if (Number(edge.child_is_composite) === 1 && Number(edge.child_use_production) === 0) {
            collectComponents(edge.component_variant_id, requiredMilli);
          } else if (requiredMilli > 0n) {
            const prev = leafConsumptions.get(edge.component_variant_id) ?? 0n;
            leafConsumptions.set(edge.component_variant_id, prev + requiredMilli);
          }
        }
      };

      const qBuild = BigInt(params.buildQtyMilli);
      collectComponents(params.compositeVariantId, qBuild);

      const getLevel = db.prepare(
        `SELECT
           il.in_stock_milli,
           COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht, 0) AS average_cost_micro_baht
         FROM item_variants v
         LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?
         WHERE v.id = ?`
      );
      const upsertLevel = db.prepare(
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
         ) VALUES (?, ?, ?, 'PRODUCTION_BUILD', ?, ?, ?, ?, 'PRODUCTION_BATCH', ?, ?)`
      );

      const batchId = `PROD-${randomUUID()}`;
      let totalBatchCostMicro = 0n;
      const consumedComponents: Array<{
        componentVariantId: string;
        consumedQtyMilli: MilliUnit;
        componentCostMicroBaht: MicroBaht;
      }> = [];

      for (const [componentVariantId, consumedMilliBig] of leafConsumptions.entries()) {
        const consumedMilli = Number(consumedMilliBig);

        const lvl = getLevel.get(params.outletId, componentVariantId) as
          | { in_stock_milli: number | null; average_cost_micro_baht: number }
          | undefined;
        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const unitCostMicro = Number(lvl?.average_cost_micro_baht ?? 0);
        const stockAfter = stockBefore - consumedMilli;

        upsertLevel.run(
          `INV-${params.outletId}-${componentVariantId}`,
          params.outletId,
          componentVariantId,
          stockAfter,
          unitCostMicro
        );
        insertTx.run(
          `TX-${randomUUID()}`,
          params.outletId,
          componentVariantId,
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
          componentVariantId,
          consumedQtyMilli: consumedMilli,
          componentCostMicroBaht: Number(compTotalCostMicro),
        });
      }

      // Compute unit cost per 1,000 milli of the newly built composite batch
      const batchUnitCostMicroBaht = Number(
        roundDivBigInt(totalBatchCostMicro * SCALE_MILLI, qBuild)
      );

      const parentLvl = getLevel.get(params.outletId, params.compositeVariantId) as
        | { in_stock_milli: number | null; average_cost_micro_baht: number }
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

      upsertLevel.run(
        `INV-${params.outletId}-${params.compositeVariantId}`,
        params.outletId,
        params.compositeVariantId,
        parentStockAfter,
        parentMacAfter
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
   * inside the Single-Writer queue using an atomic UPSERT on `inventory_levels`.
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
          `SELECT
             il.in_stock_milli,
             COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht, 0) AS average_cost_micro_baht
           FROM item_variants v
           LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?
           WHERE v.id = ?`
        )
        .get(params.outletId, params.variantId) as
        | { in_stock_milli: number | null; average_cost_micro_baht: number }
        | undefined;

      if (!lvl) {
        throw new Error(`Variant not found: ${params.variantId}`);
      }

      const stockBeforeMilli = Number(lvl.in_stock_milli ?? 0);
      const unitCostMicroBaht = Number(lvl.average_cost_micro_baht ?? 0);
      const stockAfterMilli = stockBeforeMilli + params.quantityDeltaMilli;

      db.prepare(
        `INSERT INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(outlet_id, variant_id) DO UPDATE SET
           in_stock_milli = excluded.in_stock_milli,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(
        `INV-${params.outletId}-${params.variantId}`,
        params.outletId,
        params.variantId,
        stockAfterMilli,
        unitCostMicroBaht
      );

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
   * Lists all modifiers currently persisted in SQLite (`modifiers`).
   */
  public listModifiers(): ModifierDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT
             id,
             modifier_group_id AS modifierGroupId,
             name,
             price_delta_satang AS priceDeltaSatang,
             modifier_mode AS modifierMode,
             component_variant_id AS componentVariantId,
             quantity_delta_milli AS quantityDeltaMilli,
             target_component_role AS targetComponentRole,
             scale_basis_points AS scaleBasisPoints
           FROM modifiers
           ORDER BY sort_order, id`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        modifierGroupId: String(r.modifierGroupId),
        name: String(r.name),
        priceDeltaSatang: Number(r.priceDeltaSatang),
        modifierMode: String(r.modifierMode) as ModifierDto['modifierMode'],
        componentVariantId: r.componentVariantId === null ? null : String(r.componentVariantId),
        quantityDeltaMilli: Number(r.quantityDeltaMilli),
        targetComponentRole:
          r.targetComponentRole === null ? null : (String(r.targetComponentRole) as ComponentRole),
        scaleBasisPoints: Number(r.scaleBasisPoints),
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
    const persistedModifiers = this.listModifiers();
    const modifierSource = persistedModifiers.length > 0 ? persistedModifiers : SEED_MODIFIERS;
    const mods = modifierSource.filter((m) => selectedModifierIds.includes(m.id));
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

  /**
   * Phase 2 (`SHIFT_SVC`): Opens a new Cashier Shift and records the initial `OPENING_FLOAT` cash movement.
   */
  public async openPosShift(input: OpenPosShiftInput): Promise<PosShiftDto> {
    if (input.openingCashSatang < 0) {
      throw new RangeError('openingCashSatang must be >= 0');
    }

    return this.executeWriteImmediate((db) => {
      const existingOpen = db
        .prepare(
          `SELECT id FROM pos_shifts WHERE outlet_id = ? AND terminal_id = ? AND status = 'OPEN' LIMIT 1`
        )
        .get(input.outletId, input.terminalId) as { id?: string } | undefined;

      if (existingOpen?.id) {
        throw new Error(`Shift ${existingOpen.id} is already OPEN on terminal ${input.terminalId}`);
      }

      const shiftId = `SHIFT-${randomUUID()}`;
      const openedAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO pos_shifts (
           id, shift_number, outlet_id, terminal_id, opened_by, status,
           opening_cash_satang, expected_cash_satang, notes, opened_at
         ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`
      ).run(
        shiftId,
        input.shiftNumber,
        input.outletId,
        input.terminalId,
        input.openedByUserId,
        input.openingCashSatang,
        input.openingCashSatang,
        input.notes ?? null,
        openedAt
      );

      if (input.openingCashSatang > 0) {
        db.prepare(
          `INSERT INTO cash_drawer_movements (
             id, shift_id, movement_type, amount_satang, reason, performed_by
           ) VALUES (?, ?, 'OPENING_FLOAT', ?, 'เงินทอนตั้งต้นเปิดกะ', ?)`
        ).run(`CDM-${randomUUID()}`, shiftId, input.openingCashSatang, input.openedByUserId);
      }

      return {
        id: shiftId,
        shiftNumber: input.shiftNumber,
        outletId: input.outletId,
        terminalId: input.terminalId,
        openedBy: input.openedByUserId,
        status: 'OPEN',
        openingCashSatang: input.openingCashSatang,
        expectedCashSatang: input.openingCashSatang,
        countedCashSatang: null,
        cashVarianceSatang: null,
        openedAt,
      };
    });
  }

  /**
   * Reads a shift by ID from the Reader Pool.
   */
  public getShiftById(shiftId: string): PosShiftDto | null {
    return this.executeRead((db) => {
      const row = db
        .prepare(
          `SELECT
             id, shift_number AS shiftNumber, outlet_id AS outletId, terminal_id AS terminalId,
             opened_by AS openedBy, status, opening_cash_satang AS openingCashSatang,
             expected_cash_satang AS expectedCashSatang, counted_cash_satang AS countedCashSatang,
             cash_variance_satang AS cashVarianceSatang, opened_at AS openedAt
           FROM pos_shifts WHERE id = ?`
        )
        .get(shiftId) as Record<string, unknown> | undefined;

      if (!row) return null;
      return {
        id: String(row.id),
        shiftNumber: String(row.shiftNumber),
        outletId: String(row.outletId),
        terminalId: String(row.terminalId),
        openedBy: String(row.openedBy),
        status: String(row.status) as 'OPEN' | 'CLOSED',
        openingCashSatang: Number(row.openingCashSatang),
        expectedCashSatang: Number(row.expectedCashSatang),
        countedCashSatang: row.countedCashSatang === null ? null : Number(row.countedCashSatang),
        cashVarianceSatang: row.cashVarianceSatang === null ? null : Number(row.cashVarianceSatang),
        openedAt: String(row.openedAt),
      };
    });
  }

  /**
   * Reads the currently active (`OPEN`) shift for an outlet and terminal.
   */
  public getActiveShift(outletId = 'OUTLET-HQ', terminalId = 'POS-TERM-01'): PosShiftDto | null {
    return this.executeRead((db) => {
      const row = db
        .prepare(
          `SELECT id FROM pos_shifts
           WHERE outlet_id = ? AND terminal_id = ? AND status = 'OPEN'
           ORDER BY opened_at DESC LIMIT 1`
        )
        .get(outletId, terminalId) as { id?: string } | undefined;

      if (!row?.id) return null;
      return this.getShiftById(row.id);
    });
  }

  /**
   * Phase 2 (`SHIFT_SVC`): Records a `PAID_IN`, `PAID_OUT`, or `CASH_DROP` movement and updates `expected_cash_satang`.
   */
  public async recordCashDrawerMovement(
    input: RecordCashDrawerMovementInput
  ): Promise<CashDrawerMovementRecord> {
    if (input.amountSatang <= 0) {
      throw new RangeError('amountSatang must be > 0');
    }

    return this.executeWriteImmediate((db) => {
      const shift = db
        .prepare(`SELECT status, expected_cash_satang FROM pos_shifts WHERE id = ?`)
        .get(input.shiftId) as { status: string; expected_cash_satang: number } | undefined;

      if (!shift) {
        throw new Error(`Shift not found: ${input.shiftId}`);
      }
      if (shift.status !== 'OPEN') {
        throw new Error(`Cannot record drawer movement on a CLOSED shift (${input.shiftId})`);
      }

      const delta =
        input.movementType === 'PAID_IN' ? input.amountSatang : -input.amountSatang;
      const expectedCashAfterSatang = Number(shift.expected_cash_satang) + delta;
      const movementId = `CDM-${randomUUID()}`;

      db.prepare(
        `INSERT INTO cash_drawer_movements (
           id, shift_id, movement_type, amount_satang, reason, performed_by
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        movementId,
        input.shiftId,
        input.movementType,
        input.amountSatang,
        input.reason,
        input.performedByUserId
      );

      db.prepare(`UPDATE pos_shifts SET expected_cash_satang = ? WHERE id = ?`).run(
        expectedCashAfterSatang,
        input.shiftId
      );

      return {
        id: movementId,
        shiftId: input.shiftId,
        movementType: input.movementType,
        amountSatang: input.amountSatang,
        reason: input.reason,
        performedByUserId: input.performedByUserId,
        expectedCashAfterSatang,
      };
    });
  }

  /**
   * Phase 2 (`SHIFT_SVC`): Closes a shift using Blind Drop reconciliation against the Cash Conservation Equation.
   */
  public async closePosShiftBlindDrop(input: ClosePosShiftBlindDropInput): Promise<PosShiftDto> {
    if (input.countedCashSatang < 0) {
      throw new RangeError('countedCashSatang must be >= 0');
    }

    await this.executeWriteImmediate((db) => {
      const shift = db
        .prepare(
          `SELECT status, opening_cash_satang, expected_cash_satang
           FROM pos_shifts WHERE id = ?`
        )
        .get(input.shiftId) as
        | { status: string; opening_cash_satang: number; expected_cash_satang: number }
        | undefined;

      if (!shift) {
        throw new Error(`Shift not found: ${input.shiftId}`);
      }
      if (shift.status !== 'OPEN') {
        throw new Error(`Shift ${input.shiftId} is already CLOSED`);
      }

      // Re-verify expected cash directly from the ledger (Section 5.4.1 Cash Conservation Equation)
      // Sum exact payment_transactions.amount_satang for CASH legs so Split Payments reconcile cleanly.
      const cashSalesRow = db
        .prepare(
          `SELECT COALESCE(SUM(pt.amount_satang), 0) AS netCashSalesSatang
           FROM payment_transactions pt
           JOIN sales_orders so ON so.id = pt.sales_order_id
           WHERE so.shift_id = ? AND so.status = 'COMPLETED' AND pt.payment_method = 'CASH'`
        )
        .get(input.shiftId) as { netCashSalesSatang: number };

      const movementsRows = db
        .prepare(
          `SELECT movement_type, COALESCE(SUM(amount_satang), 0) AS sumSatang
           FROM cash_drawer_movements
           WHERE shift_id = ?
           GROUP BY movement_type`
        )
        .all(input.shiftId) as Array<{ movement_type: string; sumSatang: number }>;

      let paidInSatang = 0;
      let paidOutSatang = 0;
      let cashDropSatang = 0;
      for (const m of movementsRows) {
        if (m.movement_type === 'PAID_IN') paidInSatang += Number(m.sumSatang);
        if (m.movement_type === 'PAID_OUT') paidOutSatang += Number(m.sumSatang);
        if (m.movement_type === 'CASH_DROP') cashDropSatang += Number(m.sumSatang);
      }

      const computedExpectedCashSatang =
        Number(shift.opening_cash_satang) +
        Number(cashSalesRow.netCashSalesSatang) +
        paidInSatang -
        paidOutSatang -
        cashDropSatang;

      const cashVarianceSatang = input.countedCashSatang - computedExpectedCashSatang;

      db.prepare(
        `UPDATE pos_shifts
         SET status = 'CLOSED',
             closed_by = ?,
             expected_cash_satang = ?,
             counted_cash_satang = ?,
             cash_variance_satang = ?,
             notes = COALESCE(?, notes),
             closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(
        input.closedByUserId,
        computedExpectedCashSatang,
        input.countedCashSatang,
        cashVarianceSatang,
        input.notes ?? null,
        input.shiftId
      );
    });

    return this.getShiftById(input.shiftId)!;
  }

  /**
   * Phase 2 (`CHECKOUT_SVC` — WBS-06): Atomic Idempotent POS Checkout inside `BEGIN IMMEDIATE TRANSACTION;`.
   *
   * - Idempotent on `request.idempotencyKey`
   * - Enforces BOT Slip Mini-QR format & SHA-256 uniqueness across all historical `payment_transactions`
   * - Generates Thai Revenue Department Simplified Tax Invoice (`abb_tax_invoice_no`)
   * - Deducts Multi-Level BOM + Role-Based Modifiers and appends immutable `inventory_transactions`
   * - Enqueues Kitchen Display System (`kitchen_orders` with `sequence_id`) for hospitality items
   */
  public async checkoutSalesOrder(request: CheckoutOrderRequest): Promise<CheckoutOrderResult> {
    if (!request.idempotencyKey || request.idempotencyKey.trim() === '') {
      throw new Error('idempotencyKey is required for checkoutSalesOrder');
    }
    if (request.lines.length === 0) {
      throw new Error('checkoutSalesOrder requires at least 1 order line');
    }

    return this.executeWriteImmediate((db) => {
      // 1. Check Idempotency-Key first
      const existingOrder = db
        .prepare(
          `SELECT
             so.id, so.idempotency_key, so.receipt_number, so.abb_tax_invoice_no,
             so.outlet_id, so.terminal_id, so.shift_id, so.cashier_id,
             so.order_type, so.table_or_queue_no, so.tax_mode, so.subtotal_satang, so.discount_satang,
             so.tax_satang, so.total_satang, so.total_cogs_micro_baht, so.created_at,
             ko.sequence_id AS kitchen_seq_id
           FROM sales_orders so
           LEFT JOIN kitchen_orders ko ON ko.sales_order_id = so.id
           WHERE so.idempotency_key = ?`
        )
        .get(request.idempotencyKey) as Record<string, unknown> | undefined;

      if (existingOrder) {
        const subtotalSatang = Number(existingOrder.subtotal_satang);
        const discountSatang = Number(existingOrder.discount_satang);
        const taxSatang = Number(existingOrder.tax_satang);
        const totalSatang = Number(existingOrder.total_satang);
        const taxMode = String(existingOrder.tax_mode) as TaxMode;
        const afterDiscount = Math.max(0, subtotalSatang - discountSatang);
        const netBeforeTaxSatang =
          taxMode === 'INCLUSIVE' ? afterDiscount - taxSatang : afterDiscount;

        const existingPaymentsRaw = db
          .prepare(
            `SELECT payment_method, amount_satang, cash_tendered_satang, change_given_satang,
                    sender_bank_code, slip_trans_ref_last4, slip_trans_ref_hash
             FROM payment_transactions
             WHERE sales_order_id = ?
             ORDER BY rowid ASC`
          )
          .all(String(existingOrder.id)) as Array<Record<string, unknown>>;

        const existingPayments = existingPaymentsRaw.map((p) => ({
          paymentMethod: String(p.payment_method) as CheckoutOrderRequest['paymentMethod'],
          amountSatang: Number(p.amount_satang),
          cashTenderedSatang:
            p.cash_tendered_satang === null ? null : Number(p.cash_tendered_satang),
          changeGivenSatang:
            p.change_given_satang === null ? null : Number(p.change_given_satang),
          senderBankCode: p.sender_bank_code === null ? null : String(p.sender_bank_code),
          slipTransRefLast4:
            p.slip_trans_ref_last4 === null ? null : String(p.slip_trans_ref_last4),
          slipTransRefHash:
            p.slip_trans_ref_hash === null ? null : String(p.slip_trans_ref_hash),
        }));
        const firstPay = existingPayments[0];
        const replayPaymentSummary =
          existingPayments.length > 1
            ? existingPayments.map((p) => p.paymentMethod).join(' + ')
            : (firstPay?.paymentMethod ?? request.paymentMethod);

        return {
          salesOrderId: String(existingOrder.id),
          idempotencyKey: String(existingOrder.idempotency_key),
          replayedFromIdempotencyKey: true,
          receiptNumber: String(existingOrder.receipt_number),
          abbTaxInvoiceNo: String(existingOrder.abb_tax_invoice_no),
          outletId: String(existingOrder.outlet_id),
          terminalId: String(existingOrder.terminal_id),
          shiftId: String(existingOrder.shift_id),
          cashierId: String(existingOrder.cashier_id),
          orderType: String(existingOrder.order_type) as CheckoutOrderRequest['orderType'],
          tableOrQueueNo:
            existingOrder.table_or_queue_no === null || existingOrder.table_or_queue_no === undefined
              ? null
              : String(existingOrder.table_or_queue_no),
          taxMode,
          subtotalSatang,
          discountSatang,
          netBeforeTaxSatang,
          taxSatang,
          totalSatang,
          totalCogsMicroBaht: Number(existingOrder.total_cogs_micro_baht),
          paymentMethod: (firstPay?.paymentMethod ?? request.paymentMethod) as CheckoutOrderRequest['paymentMethod'],
          paymentSummaryLabel: replayPaymentSummary,
          payments: existingPayments.map((p) => ({
            paymentMethod: p.paymentMethod,
            amountSatang: p.amountSatang,
            cashTenderedSatang: p.cashTenderedSatang,
            changeGivenSatang: p.changeGivenSatang,
            senderBankCode: p.senderBankCode,
            slipTransRefLast4: p.slipTransRefLast4,
          })),
          cashTenderedSatang: firstPay?.cashTenderedSatang ?? null,
          changeGivenSatang: firstPay?.changeGivenSatang ?? null,
          senderBankCode:
            existingPayments.find((p) => p.senderBankCode)?.senderBankCode ?? null,
          slipTransRefLast4:
            existingPayments.find((p) => p.slipTransRefLast4)?.slipTransRefLast4 ?? null,
          slipTransRefHash:
            existingPayments.find((p) => p.slipTransRefHash)?.slipTransRefHash ?? null,
          kitchenOrderSequenceId:
            existingOrder.kitchen_seq_id === null || existingOrder.kitchen_seq_id === undefined
              ? null
              : Number(existingOrder.kitchen_seq_id),
          lines: [],
          stockDeductions: [],
          createdAt: String(existingOrder.created_at),
        };
      }

      // 2. Verify Shift is OPEN
      const shiftRow = db
        .prepare(`SELECT status, expected_cash_satang FROM pos_shifts WHERE id = ?`)
        .get(request.shiftId) as { status: string; expected_cash_satang: number } | undefined;

      if (!shiftRow || shiftRow.status !== 'OPEN') {
        throw new Error(`Active OPEN shift required for checkout (shiftId=${request.shiftId})`);
      }

      // 3. Load current Catalog, BOM edges, and Modifiers inside the transaction
      const catalogRows = db
        .prepare(
          `SELECT
             v.id, v.item_id AS itemId, i.name AS itemName, v.variant_name AS variantName,
             v.sku, v.barcode, i.unit_name AS unitName, v.price_satang AS priceSatang,
             COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht) AS averageCostMicroBaht,
             COALESCE(il.in_stock_milli, 0) AS inStockMilli,
             i.is_composite AS isComposite, i.use_production AS useProduction,
             i.is_weighted_scale AS isWeightedScale,
             COALESCE(c.kitchen_station, 'NONE') AS kitchenStation
           FROM item_variants v
           JOIN items i ON i.id = v.item_id
           LEFT JOIN categories c ON c.id = i.category_id
           LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?`
        )
        .all(request.outletId) as Array<Record<string, unknown>>;

      const catalogMap = new Map<string, ItemVariantDto & { kitchenStation: string }>();
      for (const r of catalogRows) {
        catalogMap.set(String(r.id), {
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
          kitchenStation: String(r.kitchenStation),
        });
      }

      const bomEdges = (
        db
          .prepare(
            `SELECT
               composite_variant_id AS compositeVariantId,
               component_variant_id AS componentVariantId,
               component_role AS componentRole,
               quantity_milli AS quantityMilli,
               wastage_basis_points AS wastageBasisPoints
             FROM item_components`
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        compositeVariantId: String(r.compositeVariantId),
        componentVariantId: String(r.componentVariantId),
        componentRole: String(r.componentRole) as ComponentRole,
        quantityMilli: Number(r.quantityMilli),
        wastageBasisPoints: Number(r.wastageBasisPoints),
      }));

      const modifierRows = (
        db
          .prepare(
            `SELECT
               id, modifier_group_id AS modifierGroupId, name,
               price_delta_satang AS priceDeltaSatang, modifier_mode AS modifierMode,
               component_variant_id AS componentVariantId, quantity_delta_milli AS quantityDeltaMilli,
               target_component_role AS targetComponentRole, scale_basis_points AS scaleBasisPoints
             FROM modifiers`
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: String(r.id),
        modifierGroupId: String(r.modifierGroupId),
        name: String(r.name),
        priceDeltaSatang: Number(r.priceDeltaSatang),
        modifierMode: String(r.modifierMode) as ModifierDto['modifierMode'],
        componentVariantId: r.componentVariantId === null ? null : String(r.componentVariantId),
        quantityDeltaMilli: Number(r.quantityDeltaMilli),
        targetComponentRole:
          r.targetComponentRole === null ? null : (String(r.targetComponentRole) as ComponentRole),
        scaleBasisPoints: Number(r.scaleBasisPoints),
      }));
      const modifierMap = new Map(modifierRows.map((m) => [m.id, m]));

      // 4. Calculate Line Totals, Modifiers, Stock Deductions, and COGS
      let subtotalSatang = 0;
      let totalCogsMicroBaht = 0;
      const lineSummaries: CheckoutOrderLineSummary[] = [];
      const allDeductions: StockDeductionEntry[] = [];
      const lineModifierRecords: Array<{
        salesOrderItemId: string;
        modifier: ModifierDto;
        deductedQtyMilli: MilliUnit;
        modifierCogsMicroBaht: MicroBaht;
      }> = [];

      for (const reqLine of request.lines) {
        const variant = catalogMap.get(reqLine.variantId);
        if (!variant) {
          throw new Error(`Variant not found in catalog: ${reqLine.variantId}`);
        }
        const selectedMods = reqLine.selectedModifierIds.map((mId) => {
          const mod = modifierMap.get(mId);
          if (!mod) throw new Error(`Modifier not found: ${mId}`);
          return mod;
        });

        const baseLinePriceSatang = Number(
          roundDivBigInt(
            BigInt(reqLine.quantityMilli) * BigInt(reqLine.unitPriceSatang),
            SCALE_MILLI
          )
        );
        const singleUnitModPriceSatang = selectedMods.reduce(
          (acc, m) => acc + m.priceDeltaSatang,
          0
        );
        const modifiersTotalSatang = Number(
          roundDivBigInt(
            BigInt(reqLine.quantityMilli) * BigInt(singleUnitModPriceSatang),
            SCALE_MILLI
          )
        );
        const lineTotalSatang = baseLinePriceSatang + modifiersTotalSatang;
        subtotalSatang += lineTotalSatang;

        const lineDeductions = calculateOrderLineDeductions(
          variant,
          reqLine.quantityMilli,
          selectedMods,
          catalogMap,
          bomEdges
        );
        const lineCogsMicroBaht = Math.max(
          0,
          lineDeductions.reduce((acc, d) => acc + d.lineCogsMicroBaht, 0)
        );
        totalCogsMicroBaht += lineCogsMicroBaht;
        allDeductions.push(...lineDeductions);

        const salesOrderItemId = `SOI-${randomUUID()}`;
        for (const mod of selectedMods) {
          let deductedQtyMilli = 0;
          let modifierCogsMicroBaht = 0;
          if (mod.modifierMode === 'FIXED_QTY_DELTA' && mod.componentVariantId) {
            const modComp = catalogMap.get(mod.componentVariantId);
            deductedQtyMilli = Number(
              roundDivBigInt(
                BigInt(reqLine.quantityMilli) * BigInt(mod.quantityDeltaMilli),
                SCALE_MILLI
              )
            );
            if (modComp) {
              modifierCogsMicroBaht = Number(
                roundDivBigInt(
                  BigInt(deductedQtyMilli) * BigInt(modComp.averageCostMicroBaht),
                  SCALE_MILLI
                )
              );
            }
          }
          lineModifierRecords.push({
            salesOrderItemId,
            modifier: mod,
            deductedQtyMilli,
            modifierCogsMicroBaht,
          });
        }

        lineSummaries.push({
          salesOrderItemId,
          variantId: variant.id,
          itemName: variant.itemName,
          quantityMilli: reqLine.quantityMilli,
          unitPriceSatang: reqLine.unitPriceSatang,
          modifiersTotalSatang,
          lineTotalSatang,
          lineCogsMicroBaht,
          selectedModifiers: selectedMods.map((m) => ({
            modifierId: m.id,
            name: m.name,
            priceDeltaSatang: m.priceDeltaSatang,
          })),
        });
      }

      const discountSatang = Math.max(0, request.discountSatang);
      const afterDiscountSatang = Math.max(0, subtotalSatang - discountSatang);
      const taxSatang = computeVatSatang(afterDiscountSatang, 700, request.taxMode);
      const netBeforeTaxSatang =
        request.taxMode === 'INCLUSIVE' ? afterDiscountSatang - taxSatang : afterDiscountSatang;
      const totalSatang =
        request.taxMode === 'EXCLUSIVE'
          ? afterDiscountSatang + taxSatang
          : afterDiscountSatang;

      // 5. Validate Payment Method (Single Tender or Multi-Leg Split Tender + BOT Slip Anti-Fraud)
      const parseAndVerifyBotSlip = (rawSlip: string) => {
        const botMatch = /^00(\d{2})00060000010103(\d{3})02(\d{2})([A-Za-z0-9_-]+)$/.exec(
          rawSlip.trim()
        );
        if (!botMatch) {
          throw new Error('HTTP 422 Invalid BOT Slip Mini-QR format');
        }
        const outerTlvLen = Number(botMatch[1]!);
        const bankCode = botMatch[2]!;
        const declaredLen = Number(botMatch[3]!);
        const tailPayload = botMatch[4]!;
        if (
          declaredLen < 8 ||
          declaredLen > 64 ||
          tailPayload.length < declaredLen ||
          outerTlvLen !== 21 + declaredLen
        ) {
          throw new Error('HTTP 422 Invalid BOT Slip Mini-QR TLV length');
        }
        const transRef = tailPayload.slice(0, declaredLen);
        const last4 = transRef.slice(-4);
        const hash = createHash('sha256').update(`${bankCode}:${transRef}`).digest('hex');

        const dupRow = db
          .prepare(`SELECT id FROM payment_transactions WHERE slip_trans_ref_hash = ? LIMIT 1`)
          .get(hash) as { id?: string } | undefined;

        if (dupRow?.id) {
          throw new Error(
            `HTTP 409 Duplicate Slip TransRef detected (hash=${hash.slice(0, 12)}...)`
          );
        }
        return { bankCode, last4, hash };
      };

      interface ValidatedPaymentRow {
        paymentMethod: CheckoutOrderRequest['paymentMethod'];
        amountSatang: Satang;
        cashTenderedSatang: Satang | null;
        changeGivenSatang: Satang | null;
        senderBankCode: string | null;
        slipTransRefLast4: string | null;
        slipTransRefHash: string | null;
      }

      const validatedPaymentRows: ValidatedPaymentRow[] = [];
      let cashTenderedSatang: Satang | null = null;
      let changeGivenSatang: Satang | null = null;
      let senderBankCode: string | null = null;
      let slipTransRefLast4: string | null = null;
      let slipTransRefHash: string | null = null;
      let netCashAddedToDrawerSatang = 0;

      if (request.splitPayments && request.splitPayments.length > 0) {
        const sumLegs = request.splitPayments.reduce((s, l) => s + Number(l.amountSatang), 0);
        if (sumLegs !== totalSatang) {
          throw new Error(
            `Split payment sum (${sumLegs}) must equal order totalSatang (${totalSatang})`
          );
        }
        const seenInOrderHashes = new Set<string>();
        for (const leg of request.splitPayments) {
          if (leg.amountSatang <= 0) {
            throw new Error('Each split payment leg amountSatang must be > 0');
          }
          let legTendered: Satang | null = null;
          let legChange: Satang | null = null;
          let legBank: string | null = null;
          let legLast4: string | null = null;
          let legHash: string | null = null;

          if (leg.paymentMethod === 'CASH') {
            const t = leg.cashTenderedSatang ?? leg.amountSatang;
            if (t < leg.amountSatang) {
              throw new Error(
                `Insufficient cash tendered on split leg: tendered=${t}, required=${leg.amountSatang}`
              );
            }
            legTendered = t;
            legChange = t - leg.amountSatang;
            cashTenderedSatang = (cashTenderedSatang ?? 0) + legTendered;
            changeGivenSatang = (changeGivenSatang ?? 0) + legChange;
            netCashAddedToDrawerSatang += leg.amountSatang;
          } else if (leg.paymentMethod === 'PROMPTPAY_QR' && leg.slipTransRefRaw) {
            const slip = parseAndVerifyBotSlip(leg.slipTransRefRaw);
            if (seenInOrderHashes.has(slip.hash)) {
              throw new Error('HTTP 409 Duplicate Slip TransRef within split payment legs');
            }
            seenInOrderHashes.add(slip.hash);
            legBank = slip.bankCode;
            legLast4 = slip.last4;
            legHash = slip.hash;
            senderBankCode = legBank;
            slipTransRefLast4 = legLast4;
            slipTransRefHash = legHash;
          }

          validatedPaymentRows.push({
            paymentMethod: leg.paymentMethod,
            amountSatang: leg.amountSatang,
            cashTenderedSatang: legTendered,
            changeGivenSatang: legChange,
            senderBankCode: legBank,
            slipTransRefLast4: legLast4,
            slipTransRefHash: legHash,
          });
        }
      } else {
        if (request.paymentMethod === 'CASH') {
          const tendered = request.cashTenderedSatang ?? totalSatang;
          if (tendered < totalSatang) {
            throw new Error(
              `Insufficient cash tendered: tendered=${tendered}, total=${totalSatang}`
            );
          }
          cashTenderedSatang = tendered;
          changeGivenSatang = tendered - totalSatang;
          netCashAddedToDrawerSatang = totalSatang;
        } else if (request.paymentMethod === 'PROMPTPAY_QR' && request.slipTransRefRaw) {
          const slip = parseAndVerifyBotSlip(request.slipTransRefRaw);
          senderBankCode = slip.bankCode;
          slipTransRefLast4 = slip.last4;
          slipTransRefHash = slip.hash;
        }

        validatedPaymentRows.push({
          paymentMethod: request.paymentMethod,
          amountSatang: totalSatang,
          cashTenderedSatang,
          changeGivenSatang,
          senderBankCode,
          slipTransRefLast4,
          slipTransRefHash,
        });
      }

      // 6. Generate sequential Receipt Number & Thai ABB Tax Invoice Number
      const orderCountRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM sales_orders WHERE outlet_id = ?`)
        .get(request.outletId) as { cnt: number };
      const nextSeq = Number(orderCountRow.cnt) + 1;
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const seqPadded = String(nextSeq).padStart(6, '0');
      const receiptNumber = `RCP-${dateStr}-${seqPadded}`;
      const abbTaxInvoiceNo = `ABB-${dateStr}-${seqPadded}`;
      const salesOrderId = `SO-${randomUUID()}`;
      const createdAt = new Date().toISOString();

      // 7. Insert sales_orders, sales_order_items, sales_order_item_modifiers, payment_transactions
      const cleanTableOrQueue = request.tableOrQueueNo?.trim() || null;
      db.prepare(
        `INSERT INTO sales_orders (
           id, idempotency_key, receipt_number, abb_tax_invoice_no,
           outlet_id, terminal_id, shift_id, cashier_id, order_type, table_or_queue_no, status,
           tax_mode, subtotal_satang, discount_satang, tax_satang, total_satang,
           total_cogs_micro_baht, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        salesOrderId,
        request.idempotencyKey,
        receiptNumber,
        abbTaxInvoiceNo,
        request.outletId,
        request.terminalId,
        request.shiftId,
        request.cashierId,
        request.orderType,
        cleanTableOrQueue,
        request.taxMode,
        subtotalSatang,
        discountSatang,
        taxSatang,
        totalSatang,
        totalCogsMicroBaht,
        createdAt
      );

      const insertOrderItem = db.prepare(
        `INSERT INTO sales_order_items (
           id, sales_order_id, variant_id, quantity_milli, unit_price_satang,
           modifiers_total_satang, discount_satang, line_total_satang, line_cogs_micro_baht
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      );
      for (const line of lineSummaries) {
        insertOrderItem.run(
          line.salesOrderItemId,
          salesOrderId,
          line.variantId,
          line.quantityMilli,
          line.unitPriceSatang,
          line.modifiersTotalSatang,
          line.lineTotalSatang,
          line.lineCogsMicroBaht
        );
      }

      const insertOrderMod = db.prepare(
        `INSERT INTO sales_order_item_modifiers (
           id, sales_order_item_id, modifier_id, modifier_name_snapshot,
           price_delta_satang, component_variant_id, deducted_qty_milli, modifier_cogs_micro_baht
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const rec of lineModifierRecords) {
        insertOrderMod.run(
          `SOIM-${randomUUID()}`,
          rec.salesOrderItemId,
          rec.modifier.id,
          rec.modifier.name,
          rec.modifier.priceDeltaSatang,
          rec.modifier.componentVariantId,
          rec.deductedQtyMilli,
          rec.modifierCogsMicroBaht
        );
      }

      const insertPaymentTx = db.prepare(
        `INSERT INTO payment_transactions (
           id, sales_order_id, payment_method, amount_satang,
           cash_tendered_satang, change_given_satang,
           sender_bank_code, slip_trans_ref_last4, slip_trans_ref_hash, verified_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const pRow of validatedPaymentRows) {
        insertPaymentTx.run(
          `PAY-${randomUUID()}`,
          salesOrderId,
          pRow.paymentMethod,
          pRow.amountSatang,
          pRow.cashTenderedSatang,
          pRow.changeGivenSatang,
          pRow.senderBankCode,
          pRow.slipTransRefLast4,
          pRow.slipTransRefHash,
          request.cashierId
        );
      }

      if (netCashAddedToDrawerSatang > 0) {
        db.prepare(
          `UPDATE pos_shifts SET expected_cash_satang = expected_cash_satang + ? WHERE id = ?`
        ).run(netCashAddedToDrawerSatang, request.shiftId);
      }

      // 8. Deduct Stock in inventory_levels and record immutable inventory_transactions
      const getLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht
         FROM inventory_levels WHERE outlet_id = ? AND variant_id = ?`
      );
      const upsertLevel = db.prepare(
        `INSERT INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(outlet_id, variant_id) DO UPDATE SET
           in_stock_milli = excluded.in_stock_milli,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );
      const insertInvTx = db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SALES_ORDER', ?, ?)`
      );

      for (const ded of allDeductions) {
        if (ded.quantityChangeMilli === 0) continue;
        const lvl = getLevel.get(request.outletId, ded.variantId) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;
        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const currentMac = Number(lvl?.average_cost_micro_baht ?? ded.unitCostMicroBaht);
        const stockAfter = stockBefore + ded.quantityChangeMilli;

        upsertLevel.run(
          `INV-${request.outletId}-${ded.variantId}`,
          request.outletId,
          ded.variantId,
          stockAfter,
          currentMac
        );

        insertInvTx.run(
          `TX-${randomUUID()}`,
          request.outletId,
          ded.variantId,
          ded.transactionType,
          ded.quantityChangeMilli,
          stockBefore,
          stockAfter,
          ded.unitCostMicroBaht,
          salesOrderId,
          request.cashierId
        );
      }

      // 9. Enqueue Kitchen Order (KDS) if any item belongs to a kitchen station (e.g. BAR / PREP)
      let kitchenOrderSequenceId: number | null = null;
      const kitchenLines = lineSummaries.filter((l) => {
        const v = catalogMap.get(l.variantId);
        return v && v.kitchenStation !== 'NONE';
      });

      if (kitchenLines.length > 0) {
        const koId = `KO-${randomUUID()}`;
        const queueNumber = cleanTableOrQueue || `Q-${String(nextSeq).padStart(3, '0')}`;
        const firstStation = catalogMap.get(kitchenLines[0]!.variantId)?.kitchenStation;
        const primaryStation =
          firstStation && firstStation !== 'NONE' ? firstStation : 'BAR';
        const koResult = db
          .prepare(
            `INSERT INTO kitchen_orders (id, sales_order_id, outlet_id, station, queue_number, status)
             VALUES (?, ?, ?, ?, ?, 'QUEUED')`
          )
          .run(koId, salesOrderId, request.outletId, primaryStation, queueNumber);

        kitchenOrderSequenceId = Number(koResult.lastInsertRowid);

        const insertKoItem = db.prepare(
          `INSERT INTO kitchen_order_items (
             id, kitchen_order_id, sales_order_item_id, item_summary_text,
             modifiers_summary_text, quantity_milli, status
           ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`
        );
        for (const kl of kitchenLines) {
          const modText =
            kl.selectedModifiers.length > 0
              ? kl.selectedModifiers.map((m) => m.name).join(', ')
              : null;
          insertKoItem.run(
            `KOI-${randomUUID()}`,
            koId,
            kl.salesOrderItemId,
            kl.itemName,
            modText,
            kl.quantityMilli
          );
        }
      }

      return {
        salesOrderId,
        idempotencyKey: request.idempotencyKey,
        replayedFromIdempotencyKey: false,
        receiptNumber,
        abbTaxInvoiceNo,
        outletId: request.outletId,
        terminalId: request.terminalId,
        shiftId: request.shiftId,
        cashierId: request.cashierId,
        orderType: request.orderType,
        tableOrQueueNo: cleanTableOrQueue,
        taxMode: request.taxMode,
        subtotalSatang,
        discountSatang,
        netBeforeTaxSatang,
        taxSatang,
        totalSatang,
        totalCogsMicroBaht,
        paymentMethod: request.paymentMethod,
        paymentSummaryLabel:
          validatedPaymentRows.length > 1
            ? validatedPaymentRows.map((p) => p.paymentMethod).join(' + ')
            : (validatedPaymentRows[0]?.paymentMethod ?? request.paymentMethod),
        payments: validatedPaymentRows.map((p) => ({
          paymentMethod: p.paymentMethod,
          amountSatang: p.amountSatang,
          cashTenderedSatang: p.cashTenderedSatang,
          changeGivenSatang: p.changeGivenSatang,
          senderBankCode: p.senderBankCode,
          slipTransRefLast4: p.slipTransRefLast4,
        })),
        cashTenderedSatang,
        changeGivenSatang,
        senderBankCode,
        slipTransRefLast4,
        slipTransRefHash,
        kitchenOrderSequenceId,
        lines: lineSummaries,
        stockDeductions: allDeductions,
        createdAt,
      };
    });
  }

  /**
   * Phase 2 (`VOID_RETURN` — Section 5.3.1): Voids a completed sales order by reversing every
   * historical `inventory_transactions` row with its exact historical `unit_cost_micro_baht`.
   */
  public async voidSalesOrder(input: VoidSalesOrderInput): Promise<VoidSalesOrderResult> {
    return this.executeWriteImmediate((db) => {
      const order = db
        .prepare(
          `SELECT
             so.id, so.outlet_id, so.shift_id, so.receipt_number, so.abb_tax_invoice_no,
             so.status, so.total_satang, pt.payment_method
           FROM sales_orders so
           LEFT JOIN payment_transactions pt ON pt.sales_order_id = so.id
           WHERE so.id = ?`
        )
        .get(input.salesOrderId) as Record<string, unknown> | undefined;

      if (!order) {
        throw new Error(`Sales order not found: ${input.salesOrderId}`);
      }
      if (String(order.status) === 'VOIDED') {
        throw new Error(`Sales order ${input.salesOrderId} is already VOIDED`);
      }

      const outletId = String(order.outlet_id);
      const shiftId = String(order.shift_id);
      const totalSatang = Number(order.total_satang);
      const paymentMethod = String(order.payment_method ?? 'CASH');

      // Query exact historical inventory_transactions for this sales order
      const origTxRows = db
        .prepare(
          `SELECT variant_id, quantity_change_milli, unit_cost_micro_baht
           FROM inventory_transactions
           WHERE reference_type = 'SALES_ORDER' AND reference_id = ?
           ORDER BY created_at ASC, id ASC`
        )
        .all(input.salesOrderId) as Array<{
        variant_id: string;
        quantity_change_milli: number;
        unit_cost_micro_baht: number;
      }>;

      const getLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht
         FROM inventory_levels WHERE outlet_id = ? AND variant_id = ?`
      );
      const upsertLevel = db.prepare(
        `INSERT INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(outlet_id, variant_id) DO UPDATE SET
           in_stock_milli = excluded.in_stock_milli,
           average_cost_micro_baht = excluded.average_cost_micro_baht,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );
      const insertVoidTx = db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, 'VOID_RETURN', ?, ?, ?, ?, 'VOID_SALES_ORDER', ?, ?)`
      );

      const reversedLedgerEntries: Array<{
        variantId: string;
        restoredQtyMilli: MilliUnit;
        historicalUnitCostMicroBaht: MicroBaht;
        stockAfterMilli: MilliUnit;
      }> = [];

      for (const orig of origTxRows) {
        const restoredQtyMilli = -Number(orig.quantity_change_milli);
        if (restoredQtyMilli === 0) continue;

        const historicalUnitCostMicroBaht = Number(orig.unit_cost_micro_baht);
        const lvl = getLevel.get(outletId, orig.variant_id) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;

        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const macBefore = Number(lvl?.average_cost_micro_baht ?? historicalUnitCostMicroBaht);
        const stockAfter = stockBefore + restoredQtyMilli;
        const macAfter =
          restoredQtyMilli > 0
            ? computeNewMovingAverageCost(
                stockBefore,
                macBefore,
                restoredQtyMilli,
                historicalUnitCostMicroBaht
              )
            : macBefore;

        upsertLevel.run(
          `INV-${outletId}-${orig.variant_id}`,
          outletId,
          orig.variant_id,
          stockAfter,
          macAfter
        );

        insertVoidTx.run(
          `TX-${randomUUID()}`,
          outletId,
          orig.variant_id,
          restoredQtyMilli,
          stockBefore,
          stockAfter,
          historicalUnitCostMicroBaht,
          input.salesOrderId,
          input.voidedByUserId
        );

        reversedLedgerEntries.push({
          variantId: orig.variant_id,
          restoredQtyMilli,
          historicalUnitCostMicroBaht,
          stockAfterMilli: stockAfter,
        });
      }

      // Mark sales_orders as VOIDED
      db.prepare(
        `UPDATE sales_orders
         SET status = 'VOIDED',
             voided_by = ?,
             void_reason = ?,
             voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(input.voidedByUserId, input.voidReason, input.salesOrderId);

      // Cancel any associated kitchen_orders
      db.prepare(
        `UPDATE kitchen_orders
         SET status = 'CANCELLED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE sales_order_id = ?`
      ).run(input.salesOrderId);

      // Decrement expected_cash_satang by exact CASH portion paid on this order (supports Split Payments)
      const cashLegSum = db
        .prepare(
          `SELECT COALESCE(SUM(amount_satang), 0) AS cashPaid
           FROM payment_transactions
           WHERE sales_order_id = ? AND payment_method = 'CASH'`
        )
        .get(input.salesOrderId) as { cashPaid: number };
      const cashToReverseSatang = Number(cashLegSum.cashPaid ?? 0);
      if (cashToReverseSatang > 0) {
        db.prepare(
          `UPDATE pos_shifts SET expected_cash_satang = expected_cash_satang - ? WHERE id = ?`
        ).run(cashToReverseSatang, shiftId);
      }

      // Append immutable row to security_audit_logs
      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('SALES_ORDER_VOIDED', ?, ?, 'COMPLETED', ?)`
      ).run(input.voidedByUserId, input.salesOrderId, `VOIDED:${input.voidReason}`);

      return {
        salesOrderId: input.salesOrderId,
        receiptNumber: String(order.receipt_number),
        abbTaxInvoiceNo: String(order.abb_tax_invoice_no),
        refundedTotalSatang: totalSatang,
        paymentMethod,
        reversedLedgerEntries,
      };
    });
  }

  /**
   * Phase 3: Registers a secondary Outlet/Branch (e.g., `OUTLET-BRANCH-02`) for Inter-Outlet Transfers.
   */
  public async registerOutlet(input: {
    id: string;
    code: string;
    name: string;
    isWarehouse?: boolean;
  }): Promise<void> {
    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO outlets (id, code, name, is_warehouse)
         VALUES (?, ?, ?, ?)`
      ).run(input.id, input.code, input.name, input.isWarehouse ? 1 : 0);
    });
  }

  /**
   * Phase 3 (`TRANSFER_SVC`): Dispatches a stock transfer (`TRANSFER_OUT`) from `sourceOutletId`
   * to `destinationOutletId`, locking in the source outlet's exact current MAC (`transfer_unit_cost_micro_baht`).
   */
  public async dispatchTransferOrder(
    input: DispatchTransferOrderInput
  ): Promise<TransferOrderDispatchResult> {
    if (input.sourceOutletId === input.destinationOutletId) {
      throw new Error('sourceOutletId and destinationOutletId must be different');
    }
    if (input.items.length === 0) {
      throw new Error('dispatchTransferOrder requires at least 1 item');
    }

    return this.executeWriteImmediate((db) => {
      const transferOrderId = `TO-${randomUUID()}`;
      db.prepare(
        `INSERT INTO transfer_orders (
           id, transfer_number, source_outlet_id, destination_outlet_id, status, dispatched_at
         ) VALUES (?, ?, ?, ?, 'IN_TRANSIT', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
      ).run(
        transferOrderId,
        input.transferNumber,
        input.sourceOutletId,
        input.destinationOutletId
      );

      const getLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht
         FROM inventory_levels WHERE outlet_id = ? AND variant_id = ?`
      );
      const upsertLevel = db.prepare(
        `INSERT INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(outlet_id, variant_id) DO UPDATE SET
           in_stock_milli = excluded.in_stock_milli,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );
      const insertTransferItem = db.prepare(
        `INSERT INTO transfer_order_items (
           id, transfer_order_id, variant_id, quantity_milli, transfer_unit_cost_micro_baht
         ) VALUES (?, ?, ?, ?, ?)`
      );
      const insertTx = db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, 'TRANSFER_OUT', ?, ?, ?, ?, 'TRANSFER_ORDER', ?, ?)`
      );

      const dispatchedItems: Array<{
        variantId: string;
        quantityMilli: MilliUnit;
        transferUnitCostMicroBaht: MicroBaht;
        sourceStockAfterMilli: MilliUnit;
      }> = [];

      for (const item of input.items) {
        if (item.quantityMilli <= 0) {
          throw new RangeError(`Transfer quantityMilli must be > 0 for ${item.variantId}`);
        }
        const lvl = getLevel.get(input.sourceOutletId, item.variantId) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;
        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const unitCostMicro = Number(lvl?.average_cost_micro_baht ?? 0);
        const stockAfter = stockBefore - item.quantityMilli;

        insertTransferItem.run(
          `TOI-${randomUUID()}`,
          transferOrderId,
          item.variantId,
          item.quantityMilli,
          unitCostMicro
        );

        upsertLevel.run(
          `INV-${input.sourceOutletId}-${item.variantId}`,
          input.sourceOutletId,
          item.variantId,
          stockAfter,
          unitCostMicro
        );

        insertTx.run(
          `TX-${randomUUID()}`,
          input.sourceOutletId,
          item.variantId,
          -item.quantityMilli,
          stockBefore,
          stockAfter,
          unitCostMicro,
          transferOrderId,
          input.performedByUserId
        );

        dispatchedItems.push({
          variantId: item.variantId,
          quantityMilli: item.quantityMilli,
          transferUnitCostMicroBaht: unitCostMicro,
          sourceStockAfterMilli: stockAfter,
        });
      }

      return {
        transferOrderId,
        transferNumber: input.transferNumber,
        sourceOutletId: input.sourceOutletId,
        destinationOutletId: input.destinationOutletId,
        status: 'IN_TRANSIT',
        dispatchedItems,
      };
    });
  }

  /**
   * Phase 3 (`TRANSFER_SVC`): Receives an in-transit transfer order (`TRANSFER_IN`) at `destinationOutletId`,
   * updating the destination outlet's MAC with the exact transferred unit cost.
   */
  public async receiveTransferOrder(
    input: ReceiveTransferOrderInput
  ): Promise<TransferOrderReceiveResult> {
    return this.executeWriteImmediate((db) => {
      const toRow = db
        .prepare(
          `SELECT id, transfer_number, destination_outlet_id, status
           FROM transfer_orders WHERE id = ?`
        )
        .get(input.transferOrderId) as
        | { id: string; transfer_number: string; destination_outlet_id: string; status: string }
        | undefined;

      if (!toRow) {
        throw new Error(`Transfer order not found: ${input.transferOrderId}`);
      }
      if (toRow.status !== 'IN_TRANSIT') {
        throw new Error(
          `Transfer order ${input.transferOrderId} must be IN_TRANSIT (got ${toRow.status})`
        );
      }

      const items = db
        .prepare(
          `SELECT variant_id, quantity_milli, transfer_unit_cost_micro_baht
           FROM transfer_order_items WHERE transfer_order_id = ?`
        )
        .all(input.transferOrderId) as Array<{
        variant_id: string;
        quantity_milli: number;
        transfer_unit_cost_micro_baht: number;
      }>;

      const getLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht
         FROM inventory_levels WHERE outlet_id = ? AND variant_id = ?`
      );
      const upsertLevel = db.prepare(
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
         ) VALUES (?, ?, ?, 'TRANSFER_IN', ?, ?, ?, ?, 'TRANSFER_ORDER', ?, ?)`
      );

      const receivedItems: Array<{
        variantId: string;
        quantityMilli: MilliUnit;
        transferUnitCostMicroBaht: MicroBaht;
        destinationStockAfterMilli: MilliUnit;
        destinationMacAfterMicroBaht: MicroBaht;
      }> = [];

      for (const item of items) {
        const lvl = getLevel.get(toRow.destination_outlet_id, item.variant_id) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;
        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const macBefore = Number(lvl?.average_cost_micro_baht ?? 0);
        const stockAfter = stockBefore + Number(item.quantity_milli);
        const macAfter = computeNewMovingAverageCost(
          stockBefore,
          macBefore,
          Number(item.quantity_milli),
          Number(item.transfer_unit_cost_micro_baht)
        );

        upsertLevel.run(
          `INV-${toRow.destination_outlet_id}-${item.variant_id}`,
          toRow.destination_outlet_id,
          item.variant_id,
          stockAfter,
          macAfter
        );

        insertTx.run(
          `TX-${randomUUID()}`,
          toRow.destination_outlet_id,
          item.variant_id,
          Number(item.quantity_milli),
          stockBefore,
          stockAfter,
          Number(item.transfer_unit_cost_micro_baht),
          input.transferOrderId,
          input.receivedByUserId
        );

        receivedItems.push({
          variantId: item.variant_id,
          quantityMilli: Number(item.quantity_milli),
          transferUnitCostMicroBaht: Number(item.transfer_unit_cost_micro_baht),
          destinationStockAfterMilli: stockAfter,
          destinationMacAfterMicroBaht: macAfter,
        });
      }

      db.prepare(
        `UPDATE transfer_orders
         SET status = 'COMPLETED', received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(input.transferOrderId);

      return {
        transferOrderId: input.transferOrderId,
        transferNumber: toRow.transfer_number,
        destinationOutletId: toRow.destination_outlet_id,
        status: 'COMPLETED',
        receivedItems,
      };
    });
  }

  /**
   * Phase 3 (`STOCKTAKE_SVC`): Executes a Physical Inventory Stocktake (`RE_COUNT`),
   * recording variance in `inventory_counts` / `inventory_count_items` and appending `RE_COUNT`
   * ledger transactions so `Invariant 1: Ledger Conservation` remains 100% intact.
   */
  public async executePhysicalInventoryCount(
    input: ExecuteInventoryCountInput
  ): Promise<InventoryCountResult> {
    if (input.items.length === 0) {
      throw new Error('executePhysicalInventoryCount requires at least 1 item');
    }

    return this.executeWriteImmediate((db) => {
      const inventoryCountId = `CNT-${randomUUID()}`;
      db.prepare(
        `INSERT INTO inventory_counts (
           id, count_number, outlet_id, status, total_variance_satang, created_by
         ) VALUES (?, ?, ?, 'IN_PROGRESS', 0, ?)`
      ).run(inventoryCountId, input.countNumber, input.outletId, input.createdByUserId);

      const getLevel = db.prepare(
        `SELECT in_stock_milli, average_cost_micro_baht
         FROM inventory_levels WHERE outlet_id = ? AND variant_id = ?`
      );
      const upsertLevel = db.prepare(
        `INSERT INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(outlet_id, variant_id) DO UPDATE SET
           in_stock_milli = excluded.in_stock_milli,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );
      const insertCountItem = db.prepare(
        `INSERT INTO inventory_count_items (
           id, inventory_count_id, variant_id, expected_stock_milli,
           counted_stock_milli, variance_milli, snapshot_unit_cost_micro_baht, variance_cost_satang
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertTx = db.prepare(
        `INSERT INTO inventory_transactions (
           id, outlet_id, variant_id, transaction_type, quantity_change_milli,
           stock_before_milli, stock_after_milli, unit_cost_micro_baht,
           reference_type, reference_id, performed_by
         ) VALUES (?, ?, ?, 'RE_COUNT', ?, ?, ?, ?, 'INVENTORY_COUNT', ?, ?)`
      );

      let totalVarianceSatang = 0;
      const lines: Array<{
        variantId: string;
        expectedStockMilli: MilliUnit;
        countedStockMilli: MilliUnit;
        varianceMilli: MilliUnit;
        snapshotUnitCostMicroBaht: MicroBaht;
        varianceCostSatang: Satang;
      }> = [];

      for (const item of input.items) {
        const lvl = getLevel.get(input.outletId, item.variantId) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;
        const expectedStockMilli = Number(lvl?.in_stock_milli ?? 0);
        const snapshotUnitCostMicroBaht = Number(lvl?.average_cost_micro_baht ?? 0);
        const varianceMilli = item.countedStockMilli - expectedStockMilli;

        // varianceCostSatang = round(varianceMilli * snapshotUnitCostMicroBaht / 10,000,000)
        const varianceCostSatang = Number(
          roundDivBigInt(
            BigInt(varianceMilli) * BigInt(snapshotUnitCostMicroBaht),
            10_000_000n
          )
        );
        totalVarianceSatang += varianceCostSatang;

        insertCountItem.run(
          `CNTI-${randomUUID()}`,
          inventoryCountId,
          item.variantId,
          expectedStockMilli,
          item.countedStockMilli,
          varianceMilli,
          snapshotUnitCostMicroBaht,
          varianceCostSatang
        );

        if (varianceMilli !== 0) {
          upsertLevel.run(
            `INV-${input.outletId}-${item.variantId}`,
            input.outletId,
            item.variantId,
            item.countedStockMilli,
            snapshotUnitCostMicroBaht
          );

          insertTx.run(
            `TX-${randomUUID()}`,
            input.outletId,
            item.variantId,
            varianceMilli,
            expectedStockMilli,
            item.countedStockMilli,
            snapshotUnitCostMicroBaht,
            inventoryCountId,
            input.createdByUserId
          );
        }

        lines.push({
          variantId: item.variantId,
          expectedStockMilli,
          countedStockMilli: item.countedStockMilli,
          varianceMilli,
          snapshotUnitCostMicroBaht,
          varianceCostSatang,
        });
      }

      db.prepare(
        `UPDATE inventory_counts
         SET status = 'COMPLETED',
             total_variance_satang = ?,
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(totalVarianceSatang, inventoryCountId);

      return {
        inventoryCountId,
        countNumber: input.countNumber,
        outletId: input.outletId,
        totalVarianceSatang,
        lines,
      };
    });
  }

  /**
   * Phase 3 (`KDS_SYNC` — Section 7.2.2): Queries all active Kitchen Orders with `sequence_id > lastAckedKdsSeq`
   * so KDS tablets recover 100% of missed orders after Wi-Fi drops.
   */
  public getMissedKitchenOrders(
    outletId = 'OUTLET-HQ',
    station = 'BAR',
    lastAckedKdsSeq = 0
  ): KitchenOrderTicketDto[] {
    return this.executeRead((db) => {
      const orders = db
        .prepare(
          `SELECT
             sequence_id AS sequenceId, id AS kitchenOrderId, sales_order_id AS salesOrderId,
             outlet_id AS outletId, station, queue_number AS queueNumber,
             status, created_at AS createdAt
           FROM kitchen_orders
           WHERE outlet_id = ? AND station = ? AND sequence_id > ? AND status != 'CANCELLED'
           ORDER BY sequence_id ASC`
        )
        .all(outletId, station, lastAckedKdsSeq) as Array<Record<string, unknown>>;

      const getItems = db.prepare(
        `SELECT
           id, item_summary_text AS itemSummaryText,
           modifiers_summary_text AS modifiersSummaryText,
           quantity_milli AS quantityMilli, status
         FROM kitchen_order_items
         WHERE kitchen_order_id = ?
         ORDER BY id ASC`
      );

      return orders.map((o) => {
        const items = (getItems.all(String(o.kitchenOrderId)) as Array<Record<string, unknown>>).map(
          (it) => ({
            id: String(it.id),
            itemSummaryText: String(it.itemSummaryText),
            modifiersSummaryText:
              it.modifiersSummaryText === null ? null : String(it.modifiersSummaryText),
            quantityMilli: Number(it.quantityMilli),
            status: String(it.status) as 'PENDING' | 'DONE',
          })
        );

        return {
          sequenceId: Number(o.sequenceId),
          kitchenOrderId: String(o.kitchenOrderId),
          salesOrderId: String(o.salesOrderId),
          outletId: String(o.outletId),
          station: String(o.station),
          queueNumber: String(o.queueNumber),
          status: String(o.status) as KitchenOrderTicketDto['status'],
          createdAt: String(o.createdAt),
          items,
        };
      });
    });
  }

  /**
   * Phase 3 (`KDS_SYNC`): Advances a Kitchen Order status (`PREPARING`, `READY`, `SERVED`)
   * and records `last_acked_kds_seq` on the KDS terminal row.
   */
  public async acknowledgeAndAdvanceKdsOrder(input: {
    terminalId: string;
    kitchenOrderId: string;
    newStatus: 'PREPARING' | 'READY' | 'SERVED';
    ackedSequenceId: number;
  }): Promise<{ kitchenOrderId: string; newStatus: string; lastAckedKdsSeq: number }> {
    return this.executeWriteImmediate((db) => {
      db.prepare(
        `UPDATE kitchen_orders
         SET status = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             completed_at = CASE WHEN ? = 'SERVED' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END
         WHERE id = ?`
      ).run(input.newStatus, input.newStatus, input.kitchenOrderId);

      if (input.newStatus === 'READY' || input.newStatus === 'SERVED') {
        db.prepare(
          `UPDATE kitchen_order_items SET status = 'DONE' WHERE kitchen_order_id = ?`
        ).run(input.kitchenOrderId);
      }

      db.prepare(
        `UPDATE pos_terminals
         SET last_acked_kds_seq = MAX(last_acked_kds_seq, ?),
             last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(input.ackedSequenceId, input.terminalId);

      const termRow = db
        .prepare(`SELECT last_acked_kds_seq FROM pos_terminals WHERE id = ?`)
        .get(input.terminalId) as { last_acked_kds_seq?: number } | undefined;

      return {
        kitchenOrderId: input.kitchenOrderId,
        newStatus: input.newStatus,
        lastAckedKdsSeq: Number(termRow?.last_acked_kds_seq ?? input.ackedSequenceId),
      };
    });
  }

  /**
   * Phase 3 (`BACKUP_SVC` — Section 8.3 Tier 1): Emergency UPS Power-Loss WAL Checkpoint.
   * Flushes all WAL frames into the main database file (`PRAGMA wal_checkpoint(TRUNCATE);`)
   * and logs an immutable `UPS_EMERGENCY_WAL_CHECKPOINT` audit record.
   */
  public async triggerEmergencyUpsWalCheckpoint(
    terminalId = 'POS-TERM-01'
  ): Promise<{ walCheckpointed: true; auditLogId: number }> {
    const auditLogId = await this.executeWriteImmediate((db) => {
      const res = db
        .prepare(
          `INSERT INTO security_audit_logs (
             event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
           ) VALUES ('UPS_EMERGENCY_WAL_CHECKPOINT', 'USR-OWNER-01', ?, 'WAL_JOURNAL', 'AC_ONLINE', 'ON_BATTERY_TRUNCATED')`
        )
        .run(terminalId);
      return Number(res.lastInsertRowid);
    });

    // Run checkpoint outside transaction on writerConn
    this.writerConn.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    return {
      walCheckpointed: true,
      auditLogId,
    };
  }

  /**
   * Phase 3 & 5 (`BACKUP_SVC` — Section 8.3 Tier 2): Atomic USB Flash Drive Backup with `.part` + `fsyncSync`,
   * Orphaned `.part` File Cleanup (recovering from yanked USB drives mid-write), and 14-Shift Rotating Ring Buffer.
   */
  public async exportEncryptedUsbBackupWithRingBuffer(
    usbBackupDir: string,
    shiftNumber: string
  ): Promise<{
    writtenBackupPath: string;
    evictedOldestBackupPath: string | null;
    retainedBackupsCount: number;
    cleanedOrphanedPartFilesCount: number;
  }> {
    mkdirSync(usbBackupDir, { recursive: true });

    // Clean up any orphaned `.part` files left behind if a USB drive was yanked during a prior backup
    const orphanedParts = readdirSync(usbBackupDir).filter((name) => name.endsWith('.part'));
    let cleanedOrphanedPartFilesCount = 0;
    for (const partName of orphanedParts) {
      unlinkSync(join(usbBackupDir, partName));
      cleanedOrphanedPartFilesCount++;
    }

    // Flush WAL before taking snapshot
    this.writerConn.exec('PRAGMA wal_checkpoint(PASSIVE);');

    const finalFilename = `rube_backup_${shiftNumber}.db.enc`;
    const finalPath = join(usbBackupDir, finalFilename);
    const partPath = join(usbBackupDir, `${finalFilename}.part`);

    const dbBytes =
      this.dbPath === ':memory:'
        ? Buffer.from(`SQLCIPHER_ENC_SNAPSHOT:${shiftNumber}:${Date.now()}`, 'utf8')
        : readFileSync(this.dbPath);

    const fd = openSync(partPath, 'w');
    try {
      writeSync(fd, dbBytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(partPath, finalPath);

    const completedFiles = readdirSync(usbBackupDir)
      .filter((name) => name.startsWith('rube_backup_') && name.endsWith('.db.enc'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    let evictedOldestBackupPath: string | null = null;
    const maxRingBufferShifts = 14;
    if (completedFiles.length > maxRingBufferShifts) {
      const toRemove = completedFiles.slice(0, completedFiles.length - maxRingBufferShifts);
      for (const oldName of toRemove) {
        const oldFullPath = join(usbBackupDir, oldName);
        unlinkSync(oldFullPath);
        evictedOldestBackupPath = oldFullPath;
      }
    }

    const retainedBackupsCount = readdirSync(usbBackupDir).filter(
      (name) => name.startsWith('rube_backup_') && name.endsWith('.db.enc')
    ).length;

    return {
      writtenBackupPath: finalPath,
      evictedOldestBackupPath,
      retainedBackupsCount,
      cleanedOrphanedPartFilesCount,
    };
  }

  /**
   * Phase 4 (`SEC_SVC` — Section 7.2 & `WBS-18`): Computes an HMAC-SHA256 signature for protected
   * `store_config` keys (`business_profile`, `tax_id`, `rd_pos_reg_no`, etc.) using the SQLCipher DEK.
   */
  public computeProtectedConfigHmacHex(key: string, value: string): string {
    return createHmac('sha256', Buffer.from(this.rawHexKey64, 'utf8'))
      .update(`RUBE-PROTECTED-CONFIG-V1:${key}:${value}`, 'utf8')
      .digest('hex');
  }

  /**
   * Phase 4 (`SEC_SVC` — `WBS-18`): Writes a protected configuration key-value pair into `store_config`
   * with an HMAC-SHA256 tamper-detection signature and records an immutable row in `security_audit_logs`.
   */
  public async setProtectedStoreConfig(input: {
    key: string;
    value: string;
    updatedByUserId: string;
    terminalId?: string;
  }): Promise<{ key: string; value: string; hmacSignatureHex: string; auditLogId: number }> {
    const hmacSignatureHex = this.computeProtectedConfigHmacHex(input.key, input.value);

    return this.executeWriteImmediate((db) => {
      const existing = db
        .prepare(`SELECT value FROM store_config WHERE key = ?`)
        .get(input.key) as { value?: string } | undefined;

      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, hmac_signature_hex, updated_by, updated_at)
         VALUES (?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           is_protected = 1,
           hmac_signature_hex = excluded.hmac_signature_hex,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      ).run(input.key, input.value, hmacSignatureHex, input.updatedByUserId);

      const auditRes = db
        .prepare(
          `INSERT INTO security_audit_logs (
             event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
           ) VALUES ('PROTECTED_STORE_CONFIG_UPDATED', ?, ?, ?, ?, ?)`
        )
        .run(
          input.updatedByUserId,
          input.terminalId ?? 'POS-TERM-01',
          input.key,
          existing?.value ?? 'NULL',
          input.value
        );

      return {
        key: input.key,
        value: input.value,
        hmacSignatureHex,
        auditLogId: Number(auditRes.lastInsertRowid),
      };
    });
  }

  /**
   * Phase 4 (`SEC_SVC` — `WBS-18`): Reads a protected configuration value from `store_config`
   * and verifies its `hmac_signature_hex` in constant time. Throws if tampered via unauthorized SQL.
   */
  public getVerifiedProtectedStoreConfig(key: string): string | null {
    return this.executeRead((db) => {
      const row = db
        .prepare(
          `SELECT value, is_protected, hmac_signature_hex
           FROM store_config
           WHERE key = ?`
        )
        .get(key) as
        | { value: string; is_protected: number; hmac_signature_hex: string | null }
        | undefined;

      if (!row) {
        return null;
      }

      if (Number(row.is_protected) === 1) {
        if (!row.hmac_signature_hex) {
          throw new Error(
            `Security Tamper Alert: Missing HMAC-SHA256 signature on protected store_config key '${key}'`
          );
        }
        const expectedHmacHex = this.computeProtectedConfigHmacHex(key, row.value);
        const actualBuf = Buffer.from(row.hmac_signature_hex, 'hex');
        const expectedBuf = Buffer.from(expectedHmacHex, 'hex');
        if (
          actualBuf.length !== expectedBuf.length ||
          !timingSafeEqual(actualBuf, expectedBuf)
        ) {
          throw new Error(
            `Security Tamper Alert: HMAC signature mismatch on store_config key '${key}'`
          );
        }
      }

      return row.value;
    });
  }

  /**
   * Phase 4 (`WBS-18`): Switches the Polymorphic Business Profile (`RETAIL`, `HOSPITALITY`, `HYBRID`)
   * with HMAC-SHA256 protection and audit logging.
   */
  public async setBusinessProfileMode(
    profile: BusinessProfile,
    updatedByUserId = 'USR-OWNER-01'
  ): Promise<{ profile: BusinessProfile; hmacSignatureHex: string; auditLogId: number }> {
    if (profile !== 'RETAIL' && profile !== 'HOSPITALITY' && profile !== 'HYBRID') {
      throw new Error(`Invalid BusinessProfile mode: ${String(profile)}`);
    }
    const res = await this.setProtectedStoreConfig({
      key: 'business_profile',
      value: profile,
      updatedByUserId,
    });
    return {
      profile,
      hmacSignatureHex: res.hmacSignatureHex,
      auditLogId: res.auditLogId,
    };
  }

  /**
   * Phase 4 (`WBS-18`): Reads and cryptographically verifies the active Polymorphic Business Profile.
   */
  public getVerifiedBusinessProfileMode(): BusinessProfile {
    const val = this.getVerifiedProtectedStoreConfig('business_profile') ?? 'HYBRID';
    if (val !== 'RETAIL' && val !== 'HOSPITALITY' && val !== 'HYBRID') {
      throw new Error(`Invalid stored business_profile value: ${val}`);
    }
    return val;
  }

  /**
   * Phase 5 (`MIGRATE_SVC` — Section 8.2 & `WBS-15`): 5-Step Foreign-Key Safe Atomic Schema Upgrade
   * with Pre-Upgrade Cold Snapshot and Automatic Rollback on DDL or `PRAGMA foreign_key_check` failure.
   */
  public async executeFiveStepSchemaUpgrade(
    input: SchemaUpgradeInput
  ): Promise<SchemaUpgradeResult> {
    const normalizedSql = input.sqlDdl.replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(normalizedSql).digest('hex');
    const transactionalDdl = normalizedSql.replace(/^\s*PRAGMA\s+[^;]+;\s*$/gim, '');
    const startMs = Date.now();

    const nextTask = this.writerQueue.then((): SchemaUpgradeResult => {
      // Step 1: Quiesce & Cold Snapshot (`PRAGMA wal_checkpoint(TRUNCATE);`)
      this.writerConn.exec('PRAGMA wal_checkpoint(TRUNCATE);');

      let snapshotPath: string | null = null;
      if (input.snapshotDir) {
        mkdirSync(input.snapshotDir, { recursive: true });
        snapshotPath = join(
          input.snapshotDir,
          `rube_pre_migration_v${input.version}.db.bak`
        );
        const partPath = `${snapshotPath}.part`;
        const dbBytes =
          this.dbPath === ':memory:'
            ? Buffer.from(`PRE_MIGRATION_V${input.version}:${Date.now()}`, 'utf8')
            : readFileSync(this.dbPath);
        const fd = openSync(partPath, 'w');
        try {
          writeSync(fd, dbBytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(partPath, snapshotPath);
      }

      // Step 2: Disable Foreign Keys OUTSIDE transaction
      this.writerConn.exec('PRAGMA foreign_keys = OFF;');

      let applied = false;
      let autoRolledBack = false;
      let errorMessage: string | undefined;

      try {
        // Step 3: Execute Transactional DDL & Foreign Key Check
        this.writerConn.exec('BEGIN EXCLUSIVE TRANSACTION;');
        this.writerConn.exec(transactionalDdl);

        const fkViolations = this.writerConn.prepare('PRAGMA foreign_key_check;').all();
        if (fkViolations.length > 0) {
          throw new Error(
            `Foreign key check failed during schema upgrade v${input.version}: ${JSON.stringify(fkViolations)}`
          );
        }

        const elapsedMs = Date.now() - startMs;
        this.writerConn
          .prepare(
            `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
             VALUES (?, ?, ?, ?)`
          )
          .run(input.version, input.name, checksum, elapsedMs);

        this.writerConn
          .prepare(
            `INSERT INTO security_audit_logs (
               event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
             ) VALUES ('SCHEMA_MIGRATION_APPLIED', 'USR-OWNER-01', 'POS-TERM-01', ?, 'PREV_SCHEMA', ?)`
          )
          .run(input.name, `v${input.version}:${checksum.slice(0, 16)}`);

        this.writerConn.exec('COMMIT;');
        applied = true;
      } catch (err) {
        try {
          this.writerConn.exec('ROLLBACK;');
        } catch {
          // ignore if already rolled back
        }
        autoRolledBack = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      } finally {
        // Step 4: Re-enable Foreign Keys unconditionally
        this.writerConn.exec('PRAGMA foreign_keys = ON;');
      }

      const fkStatusRow = this.writerConn.prepare('PRAGMA foreign_keys;').get() as
        | { foreign_keys?: number }
        | undefined;
      const foreignKeysEnabledAfter = Number(fkStatusRow?.foreign_keys ?? 0) === 1;

      return {
        applied,
        autoRolledBack,
        version: input.version,
        name: input.name,
        checksum,
        snapshotPath,
        foreignKeysEnabledAfter,
        ...(errorMessage ? { errorMessage } : {}),
      };
    });

    this.writerQueue = nextTask.catch(() => undefined);
    return nextTask;
  }

  /**
   * Phase 5 (`REPORT_SVC`): Generates the End-of-Shift Z-Report (`ShiftZReportDto`)
   * reconciling cash/QR/card/voucher sales, drawer movements, voids, VAT, and blind drop variance.
   */
  public generateShiftZReport(shiftId: string): ShiftZReportDto {
    return this.executeRead((db) => {
      const shiftRow = db
        .prepare(
          `SELECT
             id, shift_number, outlet_id, terminal_id, status,
             opening_cash_satang, expected_cash_satang, counted_cash_satang,
             cash_variance_satang, opened_at, closed_at
           FROM pos_shifts
           WHERE id = ?`
        )
        .get(shiftId) as Record<string, unknown> | undefined;

      if (!shiftRow) {
        throw new Error(`Shift not found: ${shiftId}`);
      }

      const orderSummary = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completedCount,
             COALESCE(SUM(CASE WHEN status = 'VOIDED' THEN 1 ELSE 0 END), 0) AS voidedCount,
             COALESCE(SUM(CASE WHEN status = 'VOIDED' THEN total_satang ELSE 0 END), 0) AS voidedTotalSatang,
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN subtotal_satang ELSE 0 END), 0) AS grossSalesSatang,
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN discount_satang ELSE 0 END), 0) AS discountTotalSatang,
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN tax_satang ELSE 0 END), 0) AS vatTotalSatang,
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total_satang ELSE 0 END), 0) AS netSalesTotalSatang
           FROM sales_orders
           WHERE shift_id = ?`
        )
        .get(shiftId) as Record<string, unknown>;

      const paymentSummary = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN pt.payment_method = 'CASH' AND so.status = 'COMPLETED' THEN pt.amount_satang ELSE 0 END), 0) AS cashSalesSatang,
             COALESCE(SUM(CASE WHEN pt.payment_method = 'PROMPTPAY_QR' AND so.status = 'COMPLETED' THEN pt.amount_satang ELSE 0 END), 0) AS promptPayQrSalesSatang,
             COALESCE(SUM(CASE WHEN pt.payment_method = 'CARD' AND so.status = 'COMPLETED' THEN pt.amount_satang ELSE 0 END), 0) AS cardSalesSatang,
             COALESCE(SUM(CASE WHEN pt.payment_method = 'VOUCHER' AND so.status = 'COMPLETED' THEN pt.amount_satang ELSE 0 END), 0) AS voucherSalesSatang
           FROM payment_transactions pt
           JOIN sales_orders so ON so.id = pt.sales_order_id
           WHERE so.shift_id = ?`
        )
        .get(shiftId) as Record<string, unknown>;

      const drawerSummary = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN movement_type = 'PAID_IN' THEN amount_satang ELSE 0 END), 0) AS paidInSatang,
             COALESCE(SUM(CASE WHEN movement_type = 'PAID_OUT' THEN amount_satang ELSE 0 END), 0) AS paidOutSatang,
             COALESCE(SUM(CASE WHEN movement_type = 'CASH_DROP' THEN amount_satang ELSE 0 END), 0) AS cashDropSatang
           FROM cash_drawer_movements
           WHERE shift_id = ?`
        )
        .get(shiftId) as Record<string, unknown>;

      const netSalesTotalSatang = Number(orderSummary.netSalesTotalSatang ?? 0);
      const vatTotalSatang = Number(orderSummary.vatTotalSatang ?? 0);

      return {
        shiftId: String(shiftRow.id),
        shiftNumber: String(shiftRow.shift_number),
        outletId: String(shiftRow.outlet_id),
        terminalId: String(shiftRow.terminal_id),
        status: String(shiftRow.status) as 'OPEN' | 'CLOSED',
        openedAt: String(shiftRow.opened_at),
        closedAt: shiftRow.closed_at === null ? null : String(shiftRow.closed_at),
        openingCashSatang: Number(shiftRow.opening_cash_satang),
        cashSalesSatang: Number(paymentSummary.cashSalesSatang ?? 0),
        promptPayQrSalesSatang: Number(paymentSummary.promptPayQrSalesSatang ?? 0),
        cardSalesSatang: Number(paymentSummary.cardSalesSatang ?? 0),
        voucherSalesSatang: Number(paymentSummary.voucherSalesSatang ?? 0),
        paidInSatang: Number(drawerSummary.paidInSatang ?? 0),
        paidOutSatang: Number(drawerSummary.paidOutSatang ?? 0),
        cashDropSatang: Number(drawerSummary.cashDropSatang ?? 0),
        voidedOrdersCount: Number(orderSummary.voidedCount ?? 0),
        voidedTotalSatang: Number(orderSummary.voidedTotalSatang ?? 0),
        completedOrdersCount: Number(orderSummary.completedCount ?? 0),
        grossSalesSatang: Number(orderSummary.grossSalesSatang ?? 0),
        discountTotalSatang: Number(orderSummary.discountTotalSatang ?? 0),
        netBeforeTaxSatang: netSalesTotalSatang - vatTotalSatang,
        vatTotalSatang,
        netSalesTotalSatang,
        expectedCashSatang: Number(shiftRow.expected_cash_satang),
        countedCashSatang:
          shiftRow.counted_cash_satang === null ? null : Number(shiftRow.counted_cash_satang),
        cashVarianceSatang:
          shiftRow.cash_variance_satang === null ? null : Number(shiftRow.cash_variance_satang),
      };
    });
  }

  /**
   * Phase 5 (`REPORT_SVC`): Generates the Thai Simplified Tax Invoice (ABB) Sales Tax Report.
   */
  public generateAbbSalesTaxReport(outletId = 'OUTLET-HQ'): AbbSalesTaxReportDto {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT
             id AS salesOrderId,
             COALESCE(abb_tax_invoice_no, receipt_number) AS abbTaxInvoiceNo,
             receipt_number AS receiptNumber,
             order_type AS orderType,
             tax_mode AS taxMode,
             status,
             subtotal_satang AS subtotalSatang,
             discount_satang AS discountSatang,
             tax_satang AS taxSatang,
             total_satang AS totalSatang,
             created_at AS createdAt
           FROM sales_orders
           WHERE outlet_id = ?
           ORDER BY created_at ASC, id ASC`
        )
        .all(outletId) as Array<Record<string, unknown>>;

      let activeInvoiceCount = 0;
      let voidedInvoiceCount = 0;
      let totalNetBeforeTaxSatang = 0;
      let totalVatSatang = 0;
      let totalGrossAmountSatang = 0;

      const invoices = rows.map((r) => {
        const status = String(r.status);
        const subtotalSatang = Number(r.subtotalSatang);
        const discountSatang = Number(r.discountSatang);
        const taxSatang = Number(r.taxSatang);
        const totalSatang = Number(r.totalSatang);
        const netBeforeTaxSatang = totalSatang - taxSatang;

        if (status === 'COMPLETED') {
          activeInvoiceCount++;
          totalNetBeforeTaxSatang += netBeforeTaxSatang;
          totalVatSatang += taxSatang;
          totalGrossAmountSatang += totalSatang;
        } else if (status === 'VOIDED') {
          voidedInvoiceCount++;
        }

        return {
          salesOrderId: String(r.salesOrderId),
          abbTaxInvoiceNo: String(r.abbTaxInvoiceNo),
          receiptNumber: String(r.receiptNumber),
          orderType: String(r.orderType),
          taxMode: String(r.taxMode),
          status,
          subtotalSatang,
          discountSatang,
          netBeforeTaxSatang,
          taxSatang,
          totalSatang,
          createdAt: String(r.createdAt),
        };
      });

      return {
        outletId,
        activeInvoiceCount,
        voidedInvoiceCount,
        totalNetBeforeTaxSatang,
        totalVatSatang,
        totalGrossAmountSatang,
        invoices,
      };
    });
  }

  /**
   * Phase 5 (`REPORT_SVC`): Generates the Warehouse Inventory Valuation Report using `i128` (`BigInt`)
   * intermediate math: `roundDivBigInt(inStockMilli * averageCostMicroBaht, 10_000_000n)`.
   */
  public generateInventoryValuationReport(outletId = 'OUTLET-HQ'): InventoryValuationReportDto {
    const catalog = this.listInventoryCatalog(outletId);
    let totalWarehouseValuationSatang = 0;

    const lines = catalog.map((v) => {
      const valuationSatang = Number(
        roundDivBigInt(BigInt(v.inStockMilli) * BigInt(v.averageCostMicroBaht), 10_000_000n)
      );
      totalWarehouseValuationSatang += valuationSatang;

      return {
        variantId: v.id,
        sku: v.sku,
        itemName: v.itemName,
        variantName: v.variantName,
        unitName: v.unitName,
        inStockMilli: v.inStockMilli,
        averageCostMicroBaht: v.averageCostMicroBaht,
        totalValuationSatang: valuationSatang,
      };
    });

    return {
      outletId,
      totalWarehouseValuationSatang,
      lines,
    };
  }

  /**
   * Phase 5 (`REPORT_SVC`): Generates the Menu / Item COGS & Gross Margin Report across completed orders.
   */
  public generateMenuGrossMarginAndCogsReport(outletId = 'OUTLET-HQ'): MenuGrossMarginReportDto {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT
             v.id AS variantId,
             i.name AS itemName,
             v.variant_name AS variantName,
             COALESCE(SUM(soi.quantity_milli), 0) AS soldQtyMilli,
             COALESCE(SUM(soi.line_total_satang), 0) AS grossRevenueSatang,
             COALESCE(SUM(soi.line_cogs_micro_baht), 0) AS totalCogsMicroBaht
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.sales_order_id
           JOIN item_variants v ON v.id = soi.variant_id
           JOIN items i ON i.id = v.item_id
           WHERE so.outlet_id = ? AND so.status = 'COMPLETED'
           GROUP BY v.id, i.name, v.variant_name
           ORDER BY grossRevenueSatang DESC, v.id ASC`
        )
        .all(outletId) as Array<Record<string, unknown>>;

      let totalRevenueSatang = 0;
      let totalCogsSatang = 0;
      let totalGrossProfitSatang = 0;

      const lines = rows.map((r) => {
        const soldQtyMilli = Number(r.soldQtyMilli);
        const grossRevenueSatang = Number(r.grossRevenueSatang);
        const totalCogsMicroBaht = Number(r.totalCogsMicroBaht);
        const lineCogsSatang = Number(roundDivBigInt(BigInt(totalCogsMicroBaht), 10_000n));
        const grossProfitSatang = grossRevenueSatang - lineCogsSatang;
        const grossMarginBasisPoints =
          grossRevenueSatang > 0
            ? Number(
                roundDivBigInt(
                  BigInt(grossProfitSatang) * SCALE_BASIS_POINTS,
                  BigInt(grossRevenueSatang)
                )
              )
            : 0;

        totalRevenueSatang += grossRevenueSatang;
        totalCogsSatang += lineCogsSatang;
        totalGrossProfitSatang += grossProfitSatang;

        return {
          variantId: String(r.variantId),
          itemName: String(r.itemName),
          variantName: String(r.variantName),
          soldQtyMilli,
          grossRevenueSatang,
          totalCogsMicroBaht,
          totalCogsSatang: lineCogsSatang,
          grossProfitSatang,
          grossMarginBasisPoints,
        };
      });

      return {
        outletId,
        totalRevenueSatang,
        totalCogsSatang,
        totalGrossProfitSatang,
        lines,
      };
    });
  }

  // ============================================================================
  // Phase 6 Production Back-Office, Auth/RBAC, Catalog CRUD & Audit Query Suite
  // ============================================================================

  public hashStaffPin(rawPin: string): string {
    const clean = rawPin.trim();
    if (!/^\d{4,8}$/.test(clean)) {
      throw new Error('Staff PIN must be 4 to 8 numeric digits');
    }
    const digest = createHash('sha256').update(`RUBE-STAFF-PIN-V3.1:${clean}`, 'utf8').digest('hex');
    return `sha256:pin:${digest}`;
  }

  private matchesPinHash(rawPin: string, storedHash: string): boolean {
    const clean = rawPin.trim();
    if (!/^\d{4,8}$/.test(clean)) return false;
    // Support legacy seeded user placeholders out of the box
    if (storedHash === 'sha256:owner_pin' && clean === '999999') return true;
    if (storedHash === 'sha256:cashier_pin' && clean === '111111') return true;
    if (storedHash === 'sha256:wh_pin' && clean === '222222') return true;

    const computed = this.hashStaffPin(clean);
    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(storedHash, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  public listStaffUsers(): StaffUserDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT id, username, display_name AS displayName, role, active, created_at AS createdAt
           FROM users
           ORDER BY CASE role
             WHEN 'OWNER' THEN 1
             WHEN 'MANAGER' THEN 2
             WHEN 'CASHIER' THEN 3
             WHEN 'WAREHOUSE' THEN 4
             ELSE 5
           END, id ASC`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        username: String(r.username),
        displayName: String(r.displayName),
        role: String(r.role) as UserRole,
        active: Number(r.active) === 1,
        createdAt: String(r.createdAt),
      }));
    });
  }

  public async authenticateStaffByPin(input: {
    pin: string;
    userId?: string | undefined;
    terminalId?: string | undefined;
  }): Promise<StaffUserDto> {
    const terminalId = input.terminalId ?? 'POS-TERM-01';
    return this.executeWriteImmediate((db) => {
      const rows = input.userId
        ? (db
            .prepare(
              `SELECT id, username, display_name AS displayName, role, pin_hash AS pinHash, active, created_at AS createdAt
               FROM users WHERE id = ? AND active = 1`
            )
            .all(input.userId) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `SELECT id, username, display_name AS displayName, role, pin_hash AS pinHash, active, created_at AS createdAt
               FROM users WHERE active = 1`
            )
            .all() as Array<Record<string, unknown>>);

      const matched = rows.find((r) => this.matchesPinHash(input.pin, String(r.pinHash)));
      if (!matched) {
        db.prepare(
          `INSERT INTO security_audit_logs (
             event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
           ) VALUES ('AUTH_PIN_FAILED', ?, ?, 'STAFF_SESSION', NULL, 'INVALID_PIN')`
        ).run(input.userId ?? null, terminalId);
        throw new Error('HTTP 401 Invalid Staff PIN or inactive user');
      }

      const user: StaffUserDto = {
        id: String(matched.id),
        username: String(matched.username),
        displayName: String(matched.displayName),
        role: String(matched.role) as UserRole,
        active: Number(matched.active) === 1,
        createdAt: String(matched.createdAt),
      };

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('AUTH_PIN_SUCCESS', ?, ?, 'STAFF_SESSION', NULL, ?)`
      ).run(user.id, terminalId, `ROLE:${user.role}`);

      return user;
    });
  }

  public async upsertStaffUser(input: {
    id?: string | undefined;
    username: string;
    displayName: string;
    role: UserRole;
    pin?: string | undefined;
    active?: boolean | undefined;
    actorUserId?: string | undefined;
  }): Promise<StaffUserDto> {
    const id = input.id?.trim() || `USR-${randomUUID().slice(0, 8).toUpperCase()}`;
    const activeInt = input.active === false ? 0 : 1;
    const username = input.username.trim();
    const displayName = input.displayName.trim();
    if (!username || !displayName) {
      throw new Error('username and displayName are required');
    }

    await this.executeWriteImmediate((db) => {
      const existing = db
        .prepare(`SELECT id, pin_hash AS pinHash FROM users WHERE id = ?`)
        .get(id) as { id: string; pinHash: string } | undefined;

      const pinHash = input.pin
        ? this.hashStaffPin(input.pin)
        : (existing?.pinHash ?? this.hashStaffPin('111111'));

      if (existing) {
        db.prepare(
          `UPDATE users SET username = ?, display_name = ?, role = ?, pin_hash = ?, active = ? WHERE id = ?`
        ).run(username, displayName, input.role, pinHash, activeInt, id);
      } else {
        db.prepare(
          `INSERT INTO users (id, username, display_name, role, pin_hash, active)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, username, displayName, input.role, pinHash, activeInt);
      }

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('STAFF_USER_UPSERTED', ?, 'POS-TERM-01', ?, NULL, ?)`
      ).run(input.actorUserId ?? 'USR-OWNER-01', id, `${username}:${input.role}:active=${activeInt}`);
    });

    const found = this.listStaffUsers().find((u) => u.id === id);
    if (!found) {
      throw new Error(`Failed to reload upserted staff user ${id}`);
    }
    return found;
  }

  public getStoreIdentitySettings(outletId = 'OUTLET-HQ'): StoreIdentitySettingsDto {
    const outletRow = this.executeRead((db) => {
      return db
        .prepare(
          `SELECT id, code, name, tax_id AS taxId, branch_code AS branchCode, rd_pos_reg_no AS rdPosRegNo
           FROM outlets WHERE id = ?`
        )
        .get(outletId) as Record<string, unknown> | undefined;
    });

    let promptPayId = '0105566001234';
    try {
      const configuredPromptPay = this.getVerifiedProtectedStoreConfig('promptpay_merchant_id');
      if (configuredPromptPay) {
        promptPayId = configuredPromptPay;
      } else if (outletRow?.taxId) {
        promptPayId = String(outletRow.taxId);
      }
    } catch {
      // Fallback if tampered or unset
    }

    return {
      outletId,
      outletCode: String(outletRow?.code ?? 'HQ-01'),
      storeName: String(outletRow?.name ?? 'RUBE Flagship Store & Warehouse'),
      taxId: String(outletRow?.taxId ?? '0105566001234'),
      branchCode: String(outletRow?.branchCode ?? '00000'),
      rdPosRegNo: String(outletRow?.rdPosRegNo ?? 'RD-POS-2026-001'),
      promptPayId,
      businessProfile: this.getVerifiedBusinessProfileMode(),
    };
  }

  public async updateStoreIdentitySettings(input: {
    outletId?: string | undefined;
    storeName: string;
    taxId: string;
    branchCode: string;
    rdPosRegNo: string;
    promptPayId: string;
    updatedByUserId?: string | undefined;
  }): Promise<StoreIdentitySettingsDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const actor = input.updatedByUserId ?? 'USR-OWNER-01';
    const cleanPromptPay = input.promptPayId.replace(/\D/g, '');
    if (cleanPromptPay.length !== 10 && cleanPromptPay.length !== 13 && cleanPromptPay.length !== 15) {
      throw new Error('PromptPay ID must be 10 digits (Mobile), 13 digits (Tax/Citizen ID), or 15 digits (e-Wallet)');
    }

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `UPDATE outlets SET name = ?, tax_id = ?, branch_code = ?, rd_pos_reg_no = ? WHERE id = ?`
      ).run(
        input.storeName.trim(),
        input.taxId.trim(),
        input.branchCode.trim() || '00000',
        input.rdPosRegNo.trim(),
        outletId
      );
    });

    await this.setProtectedStoreConfig({
      key: 'promptpay_merchant_id',
      value: cleanPromptPay,
      updatedByUserId: actor,
    });

    return this.getStoreIdentitySettings(outletId);
  }

  public listOutlets(): OutletDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT id, code, name, tax_id AS taxId, branch_code AS branchCode, rd_pos_reg_no AS rdPosRegNo, is_warehouse AS isWarehouse, active
           FROM outlets ORDER BY is_warehouse DESC, id ASC`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        code: String(r.code),
        name: String(r.name),
        taxId: r.taxId === null ? null : String(r.taxId),
        branchCode: String(r.branchCode ?? '00000'),
        rdPosRegNo: r.rdPosRegNo === null ? null : String(r.rdPosRegNo),
        isWarehouse: Number(r.isWarehouse) === 1,
        active: Number(r.active) === 1,
      }));
    });
  }

  public listCategories(): CategoryDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT id, name, display_color AS displayColor, kitchen_station AS kitchenStation, sort_order AS sortOrder
           FROM categories ORDER BY sort_order ASC, name ASC`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        displayColor: String(r.displayColor ?? '#2563EB'),
        kitchenStation: String(r.kitchenStation ?? 'NONE'),
        sortOrder: Number(r.sortOrder ?? 0),
      }));
    });
  }

  public async upsertCategory(input: {
    id?: string | undefined;
    name: string;
    displayColor?: string | undefined;
    kitchenStation?: string | undefined;
    sortOrder?: number | undefined;
  }): Promise<CategoryDto> {
    const id = input.id?.trim() || `CAT-${randomUUID().slice(0, 6).toUpperCase()}`;
    const name = input.name.trim();
    if (!name) throw new Error('Category name is required');
    const displayColor = input.displayColor?.trim() || '#2563EB';
    const kitchenStation = input.kitchenStation?.trim() || 'NONE';
    const sortOrder = input.sortOrder ?? 10;

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO categories (id, name, display_color, kitchen_station, sort_order)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           display_color = excluded.display_color,
           kitchen_station = excluded.kitchen_station,
           sort_order = excluded.sort_order`
      ).run(id, name, displayColor, kitchenStation, sortOrder);
    });

    return { id, name, displayColor, kitchenStation, sortOrder };
  }

  public listSuppliers(): SupplierDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT id, code, name, tax_id AS taxId, phone, active
           FROM suppliers ORDER BY code ASC`
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        code: String(r.code),
        name: String(r.name),
        taxId: r.taxId === null ? null : String(r.taxId),
        phone: r.phone === null ? null : String(r.phone),
        active: Number(r.active) === 1,
      }));
    });
  }

  public async upsertSupplier(input: {
    id?: string | undefined;
    code: string;
    name: string;
    taxId?: string | null | undefined;
    phone?: string | null | undefined;
  }): Promise<SupplierDto> {
    const id = input.id?.trim() || `SUP-${randomUUID().slice(0, 6).toUpperCase()}`;
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!code || !name) throw new Error('Supplier code and name are required');

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO suppliers (id, code, name, tax_id, phone, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code,
           name = excluded.name,
           tax_id = excluded.tax_id,
           phone = excluded.phone`
      ).run(id, code, name, input.taxId?.trim() || null, input.phone?.trim() || null);
    });

    return {
      id,
      code,
      name,
      taxId: input.taxId?.trim() || null,
      phone: input.phone?.trim() || null,
      active: true,
    };
  }

  public listCatalogVariantsDetailed(outletId = 'OUTLET-HQ'): CatalogVariantDetailDto[] {
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
             v.default_purchase_cost_micro_baht AS defaultPurchaseCostMicroBaht,
             COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht) AS averageCostMicroBaht,
             COALESCE(il.in_stock_milli, 0) AS inStockMilli,
             COALESCE(il.optimal_stock_milli, 200000) AS optimalStockMilli,
             COALESCE(il.low_stock_threshold_milli, 10000) AS lowStockThresholdMilli,
             i.is_composite AS isComposite,
             i.use_production AS useProduction,
             i.is_weighted_scale AS isWeightedScale,
             i.category_id AS categoryId,
             COALESCE(c.name, 'ทั่วไป') AS categoryName,
             COALESCE(c.display_color, '#64748B') AS categoryColor,
             COALESCE(c.kitchen_station, 'NONE') AS kitchenStation,
             v.active AS active
           FROM item_variants v
           JOIN items i ON i.id = v.item_id
           LEFT JOIN categories c ON c.id = i.category_id
           LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?
           ORDER BY COALESCE(c.sort_order, 99) ASC, i.name ASC, v.id ASC`
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
        defaultPurchaseCostMicroBaht: Number(r.defaultPurchaseCostMicroBaht),
        averageCostMicroBaht: Number(r.averageCostMicroBaht),
        inStockMilli: Number(r.inStockMilli),
        optimalStockMilli: Number(r.optimalStockMilli),
        lowStockThresholdMilli: Number(r.lowStockThresholdMilli),
        isComposite: Number(r.isComposite) === 1,
        useProduction: Number(r.useProduction) === 1,
        isWeightedScale: Number(r.isWeightedScale) === 1,
        categoryId: r.categoryId === null ? null : String(r.categoryId),
        categoryName: String(r.categoryName),
        categoryColor: String(r.categoryColor),
        kitchenStation: String(r.kitchenStation),
        active: Number(r.active) === 1,
      }));
    });
  }

  public async upsertCatalogVariant(
    input: UpsertCatalogVariantInput
  ): Promise<CatalogVariantDetailDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const variantId = input.variantId?.trim() || `VAR-${randomUUID().slice(0, 8).toUpperCase()}`;
    const itemId = input.itemId?.trim() || `ITM-${variantId.replace(/^VAR-/, '')}`;
    const itemName = input.itemName.trim();
    const variantName = input.variantName?.trim() || 'ปกติ';
    const sku = input.sku.trim();
    const barcode = input.barcode?.trim() ? input.barcode.trim() : null;
    const unitName = input.unitName.trim() || 'ชิ้น';

    if (!itemName || !sku) {
      throw new Error('itemName and sku are required');
    }
    if (input.priceSatang < 0 || input.defaultPurchaseCostMicroBaht < 0) {
      throw new Error('priceSatang and defaultPurchaseCostMicroBaht must be >= 0');
    }

    await this.executeWriteImmediate((db) => {
      const existingVariant = db
        .prepare(`SELECT id, item_id AS itemId FROM item_variants WHERE id = ?`)
        .get(variantId) as { id: string; itemId: string } | undefined;

      const resolvedItemId = existingVariant?.itemId ?? itemId;
      const activeInt = input.active === false ? 0 : 1;

      db.prepare(
        `INSERT INTO items (
           id, name, category_id, unit_name, track_stock, is_composite, use_production, is_weighted_scale, active
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           category_id = excluded.category_id,
           unit_name = excluded.unit_name,
           is_composite = excluded.is_composite,
           use_production = excluded.use_production,
           is_weighted_scale = excluded.is_weighted_scale,
           active = excluded.active`
      ).run(
        resolvedItemId,
        itemName,
        input.categoryId ?? 'CAT-RETAIL',
        unitName,
        input.isComposite ? 1 : 0,
        input.useProduction ? 1 : 0,
        input.isWeightedScale ? 1 : 0,
        activeInt
      );

      db.prepare(
        `INSERT INTO item_variants (
           id, item_id, variant_name, sku, barcode, price_satang, default_purchase_cost_micro_baht, active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           variant_name = excluded.variant_name,
           sku = excluded.sku,
           barcode = excluded.barcode,
           price_satang = excluded.price_satang,
           default_purchase_cost_micro_baht = excluded.default_purchase_cost_micro_baht,
           active = excluded.active`
      ).run(
        variantId,
        resolvedItemId,
        variantName,
        sku,
        barcode,
        input.priceSatang,
        input.defaultPurchaseCostMicroBaht,
        activeInt
      );

      const existingInv = db
        .prepare(`SELECT id, in_stock_milli FROM inventory_levels WHERE outlet_id = ? AND variant_id = ?`)
        .get(outletId, variantId) as { id: string; in_stock_milli: number } | undefined;

      const lowStockMilli = input.lowStockThresholdMilli ?? 10_000;
      const optimalStockMilli = input.optimalStockMilli ?? 200_000;

      if (!existingInv) {
        const initStock = Math.max(0, input.initialStockMilli ?? 0);
        const initMac = input.defaultPurchaseCostMicroBaht;
        db.prepare(
          `INSERT INTO inventory_levels (
             id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht, optimal_stock_milli, low_stock_threshold_milli
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `INV-${outletId}-${variantId}`,
          outletId,
          variantId,
          initStock,
          initMac,
          optimalStockMilli,
          lowStockMilli
        );

        if (initStock > 0) {
          db.prepare(
            `INSERT INTO inventory_transactions (
               id, outlet_id, variant_id, transaction_type, quantity_change_milli,
               stock_before_milli, stock_after_milli, unit_cost_micro_baht,
               reference_type, reference_id, performed_by
             ) VALUES (?, ?, ?, 'PO_RECEIVE', ?, 0, ?, ?, 'CATALOG_OPENING_STOCK', ?, ?)`
          ).run(
            `TX-OPEN-${variantId}-${Date.now()}`,
            outletId,
            variantId,
            initStock,
            initStock,
            initMac,
            variantId,
            input.performedByUserId ?? 'USR-OWNER-01'
          );
        }
      } else {
        if (Number(existingInv.in_stock_milli) <= 0) {
          db.prepare(
            `UPDATE inventory_levels
             SET low_stock_threshold_milli = ?, optimal_stock_milli = ?, average_cost_micro_baht = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE outlet_id = ? AND variant_id = ?`
          ).run(
            lowStockMilli,
            optimalStockMilli,
            input.defaultPurchaseCostMicroBaht,
            outletId,
            variantId
          );
        } else {
          db.prepare(
            `UPDATE inventory_levels
             SET low_stock_threshold_milli = ?, optimal_stock_milli = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE outlet_id = ? AND variant_id = ?`
          ).run(lowStockMilli, optimalStockMilli, outletId, variantId);
        }
      }
    });

    const reloaded = this.listCatalogVariantsDetailed(outletId).find((v) => v.id === variantId);
    if (!reloaded) {
      throw new Error(`Failed to reload catalog variant ${variantId}`);
    }
    return reloaded;
  }

  public async deleteBomComponentEdge(
    compositeVariantId: string,
    componentVariantId: string
  ): Promise<void> {
    await this.executeWriteImmediate((db) => {
      db.prepare(
        `DELETE FROM item_components WHERE composite_variant_id = ? AND component_variant_id = ?`
      ).run(compositeVariantId, componentVariantId);
    });
  }

  public listModifierGroupsWithModifiers(): ModifierGroupWithItemsDto[] {
    return this.executeRead((db) => {
      const groups = db
        .prepare(
          `SELECT id, name, selection_type AS selectionType, min_selections AS minSelections, max_selections AS maxSelections
           FROM modifier_groups ORDER BY id ASC`
        )
        .all() as Array<Record<string, unknown>>;

      const mods = this.listModifiers();
      return groups.map((g) => {
        const groupId = String(g.id);
        return {
          id: groupId,
          name: String(g.name),
          selectionType: String(g.selectionType) as 'SINGLE' | 'MULTIPLE',
          minSelections: Number(g.minSelections),
          maxSelections: Number(g.maxSelections),
          modifiers: mods.filter((m) => m.modifierGroupId === groupId),
        };
      });
    });
  }

  public listKitchenOrdersAllStations(
    outletId = 'OUTLET-HQ',
    includeServed = false
  ): KitchenOrderTicketDto[] {
    return this.executeRead((db) => {
      const sql = includeServed
        ? `SELECT sequence_id AS sequenceId, id AS kitchenOrderId, sales_order_id AS salesOrderId,
                  outlet_id AS outletId, station, queue_number AS queueNumber, status, created_at AS createdAt
           FROM kitchen_orders
           WHERE outlet_id = ? AND status != 'CANCELLED'
           ORDER BY sequence_id DESC LIMIT 60`
        : `SELECT sequence_id AS sequenceId, id AS kitchenOrderId, sales_order_id AS salesOrderId,
                  outlet_id AS outletId, station, queue_number AS queueNumber, status, created_at AS createdAt
           FROM kitchen_orders
           WHERE outlet_id = ? AND status NOT IN ('SERVED', 'CANCELLED')
           ORDER BY sequence_id ASC`;

      const orders = db.prepare(sql).all(outletId) as Array<Record<string, unknown>>;
      const getItems = db.prepare(
        `SELECT id, item_summary_text AS itemSummaryText, modifiers_summary_text AS modifiersSummaryText,
                quantity_milli AS quantityMilli, status
         FROM kitchen_order_items WHERE kitchen_order_id = ? ORDER BY id ASC`
      );

      return orders.map((o) => ({
        sequenceId: Number(o.sequenceId),
        kitchenOrderId: String(o.kitchenOrderId),
        salesOrderId: String(o.salesOrderId),
        outletId: String(o.outletId),
        station: String(o.station),
        queueNumber: String(o.queueNumber),
        status: String(o.status) as KitchenOrderTicketDto['status'],
        createdAt: String(o.createdAt),
        items: (getItems.all(String(o.kitchenOrderId)) as Array<Record<string, unknown>>).map(
          (it) => ({
            id: String(it.id),
            itemSummaryText: String(it.itemSummaryText),
            modifiersSummaryText:
              it.modifiersSummaryText === null ? null : String(it.modifiersSummaryText),
            quantityMilli: Number(it.quantityMilli),
            status: String(it.status) as 'PENDING' | 'DONE',
          })
        ),
      }));
    });
  }

  public listShiftsHistory(outletId = 'OUTLET-HQ', limit = 20): PosShiftDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT id, shift_number AS shiftNumber, outlet_id AS outletId, terminal_id AS terminalId,
                  opened_by AS openedBy, status, opening_cash_satang AS openingCashSatang,
                  expected_cash_satang AS expectedCashSatang, counted_cash_satang AS countedCashSatang,
                  cash_variance_satang AS cashVarianceSatang, opened_at AS openedAt
           FROM pos_shifts
           WHERE outlet_id = ?
           ORDER BY opened_at DESC, rowid DESC
           LIMIT ?`
        )
        .all(outletId, limit) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        shiftNumber: String(r.shiftNumber),
        outletId: String(r.outletId),
        terminalId: String(r.terminalId),
        openedBy: String(r.openedBy),
        status: String(r.status) as 'OPEN' | 'CLOSED',
        openingCashSatang: Number(r.openingCashSatang),
        expectedCashSatang: Number(r.expectedCashSatang),
        countedCashSatang: r.countedCashSatang === null ? null : Number(r.countedCashSatang),
        cashVarianceSatang: r.cashVarianceSatang === null ? null : Number(r.cashVarianceSatang),
        openedAt: String(r.openedAt),
      }));
    });
  }

  public listCashDrawerMovements(shiftId: string): Array<
    CashDrawerMovementRecord & { createdAt: string; performedByName: string }
  > {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT m.id, m.shift_id AS shiftId, m.movement_type AS movementType,
                  m.amount_satang AS amountSatang, m.reason, m.performed_by AS performedByUserId,
                  COALESCE(u.display_name, m.performed_by) AS performedByName,
                  m.created_at AS createdAt
           FROM cash_drawer_movements m
           LEFT JOIN users u ON u.id = m.performed_by
           WHERE m.shift_id = ?
           ORDER BY m.created_at ASC, m.rowid ASC`
        )
        .all(shiftId) as Array<Record<string, unknown>>;

      let runningCash = 0;
      return rows.map((r) => {
        const type = String(r.movementType) as CashDrawerMovementRecord['movementType'];
        const amt = Number(r.amountSatang);
        if (type === 'OPENING_FLOAT' || type === 'PAID_IN') {
          runningCash += amt;
        } else {
          runningCash -= amt;
        }
        return {
          id: String(r.id),
          shiftId: String(r.shiftId),
          movementType: type,
          amountSatang: amt,
          reason: String(r.reason),
          performedByUserId: String(r.performedByUserId),
          performedByName: String(r.performedByName),
          expectedCashAfterSatang: runningCash,
          createdAt: String(r.createdAt),
        };
      });
    });
  }

  public listRecentSalesOrders(outletId = 'OUTLET-HQ', limit = 40): SalesOrderHistoryDto[] {
    return this.executeRead((db) => {
      const orders = db
        .prepare(
          `SELECT
             so.id AS salesOrderId,
             so.receipt_number AS receiptNumber,
             so.abb_tax_invoice_no AS abbTaxInvoiceNo,
             so.shift_id AS shiftId,
             so.cashier_id AS cashierId,
             COALESCE(u.display_name, so.cashier_id) AS cashierName,
             so.order_type AS orderType,
             so.table_or_queue_no AS tableOrQueueNo,
             so.status,
             so.tax_mode AS taxMode,
             so.subtotal_satang AS subtotalSatang,
             so.discount_satang AS discountSatang,
             so.tax_satang AS taxSatang,
             so.total_satang AS totalSatang,
             so.total_cogs_micro_baht AS totalCogsMicroBaht,
             so.void_reason AS voidReason,
             so.created_at AS createdAt
           FROM sales_orders so
           LEFT JOIN users u ON u.id = so.cashier_id
           WHERE so.outlet_id = ?
           ORDER BY so.created_at DESC, so.rowid DESC
           LIMIT ?`
        )
        .all(outletId, limit) as Array<Record<string, unknown>>;

      const paymentStmt = db.prepare(
        `SELECT
           payment_method AS paymentMethod,
           amount_satang AS amountSatang,
           cash_tendered_satang AS cashTenderedSatang,
           change_given_satang AS changeGivenSatang,
           sender_bank_code AS senderBankCode,
           slip_trans_ref_last4 AS slipTransRefLast4
         FROM payment_transactions
         WHERE sales_order_id = ?
         ORDER BY rowid ASC`
      );

      const lineStmt = db.prepare(
        `SELECT
           soi.id AS salesOrderItemId,
           soi.variant_id AS variantId,
           i.name AS itemName,
           i.unit_name AS unitName,
           soi.quantity_milli AS quantityMilli,
           soi.unit_price_satang AS unitPriceSatang,
           soi.modifiers_total_satang AS modifiersTotalSatang,
           soi.line_total_satang AS lineTotalSatang
         FROM sales_order_items soi
         JOIN item_variants v ON v.id = soi.variant_id
         JOIN items i ON i.id = v.item_id
         WHERE soi.sales_order_id = ?
         ORDER BY soi.rowid ASC`
      );

      const modStmt = db.prepare(
        `SELECT modifier_name_snapshot AS name, price_delta_satang AS priceDeltaSatang
         FROM sales_order_item_modifiers
         WHERE sales_order_item_id = ?`
      );

      return orders.map((o) => {
        const orderId = String(o.salesOrderId);
        const subtotalSatang = Number(o.subtotalSatang);
        const discountSatang = Number(o.discountSatang);
        const taxSatang = Number(o.taxSatang);
        const totalSatang = Number(o.totalSatang);
        const taxMode = String(o.taxMode) as TaxMode;
        const afterDiscount = Math.max(0, subtotalSatang - discountSatang);
        const netBeforeTaxSatang =
          taxMode === 'INCLUSIVE' ? afterDiscount - taxSatang : afterDiscount;

        const rawPayments = paymentStmt.all(orderId) as Array<Record<string, unknown>>;
        const payments = rawPayments.map((p) => ({
          paymentMethod: String(p.paymentMethod) as CheckoutOrderRequest['paymentMethod'],
          amountSatang: Number(p.amountSatang),
          cashTenderedSatang:
            p.cashTenderedSatang === null ? null : Number(p.cashTenderedSatang),
          changeGivenSatang: p.changeGivenSatang === null ? null : Number(p.changeGivenSatang),
          senderBankCode: p.senderBankCode === null ? null : String(p.senderBankCode),
          slipTransRefLast4: p.slipTransRefLast4 === null ? null : String(p.slipTransRefLast4),
        }));

        const primaryPay = payments[0];
        const paymentSummaryLabel =
          payments.length > 1
            ? payments.map((p) => p.paymentMethod).join(' + ')
            : (primaryPay?.paymentMethod ?? 'CASH');

        const rawLines = lineStmt.all(orderId) as Array<Record<string, unknown>>;
        const lines = rawLines.map((l) => {
          const itemId = String(l.salesOrderItemId);
          const mods = (modStmt.all(itemId) as Array<Record<string, unknown>>).map((m) => ({
            name: String(m.name),
            priceDeltaSatang: Number(m.priceDeltaSatang),
          }));
          return {
            salesOrderItemId: itemId,
            variantId: String(l.variantId),
            itemName: String(l.itemName),
            unitName: String(l.unitName),
            quantityMilli: Number(l.quantityMilli),
            unitPriceSatang: Number(l.unitPriceSatang),
            modifiersTotalSatang: Number(l.modifiersTotalSatang),
            lineTotalSatang: Number(l.lineTotalSatang),
            modifiers: mods,
          };
        });

        return {
          salesOrderId: orderId,
          receiptNumber: String(o.receiptNumber),
          abbTaxInvoiceNo: o.abbTaxInvoiceNo === null ? null : String(o.abbTaxInvoiceNo),
          shiftId: String(o.shiftId),
          cashierId: String(o.cashierId),
          cashierName: String(o.cashierName),
          orderType: String(o.orderType) as CheckoutOrderRequest['orderType'],
          tableOrQueueNo: o.tableOrQueueNo === null ? null : String(o.tableOrQueueNo),
          status: String(o.status) as 'OPEN' | 'COMPLETED' | 'VOIDED',
          taxMode,
          subtotalSatang,
          discountSatang,
          netBeforeTaxSatang,
          taxSatang,
          totalSatang,
          totalCogsMicroBaht: Number(o.totalCogsMicroBaht),
          paymentMethod: (primaryPay?.paymentMethod ?? 'CASH') as CheckoutOrderRequest['paymentMethod'],
          paymentSummaryLabel,
          payments,
          cashTenderedSatang: primaryPay?.cashTenderedSatang ?? null,
          changeGivenSatang: primaryPay?.changeGivenSatang ?? null,
          senderBankCode:
            payments.find((p) => p.senderBankCode)?.senderBankCode ?? null,
          slipTransRefLast4:
            payments.find((p) => p.slipTransRefLast4)?.slipTransRefLast4 ?? null,
          voidReason: o.voidReason === null ? null : String(o.voidReason),
          createdAt: String(o.createdAt),
          lines,
        };
      });
    });
  }

  public listInventoryTransactions(
    outletId = 'OUTLET-HQ',
    limit = 80,
    variantId?: string | undefined
  ): InventoryLedgerEntryDto[] {
    return this.executeRead((db) => {
      const sql = variantId
        ? `SELECT t.id, t.outlet_id AS outletId, t.variant_id AS variantId,
                  i.name AS itemName, v.sku, i.unit_name AS unitName,
                  t.transaction_type AS transactionType, t.quantity_change_milli AS quantityChangeMilli,
                  t.stock_before_milli AS stockBeforeMilli, t.stock_after_milli AS stockAfterMilli,
                  t.unit_cost_micro_baht AS unitCostMicroBaht, t.reference_type AS referenceType,
                  t.reference_id AS referenceId, COALESCE(u.display_name, t.performed_by, 'System') AS performedByName,
                  t.created_at AS createdAt
           FROM inventory_transactions t
           JOIN item_variants v ON v.id = t.variant_id
           JOIN items i ON i.id = v.item_id
           LEFT JOIN users u ON u.id = t.performed_by
           WHERE t.outlet_id = ? AND t.variant_id = ?
           ORDER BY t.rowid DESC LIMIT ?`
        : `SELECT t.id, t.outlet_id AS outletId, t.variant_id AS variantId,
                  i.name AS itemName, v.sku, i.unit_name AS unitName,
                  t.transaction_type AS transactionType, t.quantity_change_milli AS quantityChangeMilli,
                  t.stock_before_milli AS stockBeforeMilli, t.stock_after_milli AS stockAfterMilli,
                  t.unit_cost_micro_baht AS unitCostMicroBaht, t.reference_type AS referenceType,
                  t.reference_id AS referenceId, COALESCE(u.display_name, t.performed_by, 'System') AS performedByName,
                  t.created_at AS createdAt
           FROM inventory_transactions t
           JOIN item_variants v ON v.id = t.variant_id
           JOIN items i ON i.id = v.item_id
           LEFT JOIN users u ON u.id = t.performed_by
           WHERE t.outlet_id = ?
           ORDER BY t.rowid DESC LIMIT ?`;

      const rows = (
        variantId ? db.prepare(sql).all(outletId, variantId, limit) : db.prepare(sql).all(outletId, limit)
      ) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        outletId: String(r.outletId),
        variantId: String(r.variantId),
        itemName: String(r.itemName),
        sku: String(r.sku),
        unitName: String(r.unitName),
        transactionType: String(r.transactionType),
        quantityChangeMilli: Number(r.quantityChangeMilli),
        stockBeforeMilli: Number(r.stockBeforeMilli),
        stockAfterMilli: Number(r.stockAfterMilli),
        unitCostMicroBaht: Number(r.unitCostMicroBaht),
        referenceType: String(r.referenceType),
        referenceId: String(r.referenceId),
        performedByName: String(r.performedByName),
        createdAt: String(r.createdAt),
      }));
    });
  }

  public listPurchaseOrdersHistory(outletId = 'OUTLET-HQ', limit = 30): PurchaseOrderHistoryDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT po.id, po.po_number AS poNumber, po.outlet_id AS outletId,
                  po.supplier_id AS supplierId, COALESCE(s.name, po.supplier_id) AS supplierName,
                  po.status, po.subtotal_satang AS subtotalSatang,
                  po.total_landed_cost_satang AS totalLandedCostSatang,
                  po.grand_total_satang AS grandTotalSatang,
                  po.received_at AS receivedAt, po.created_at AS createdAt,
                  (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) AS lineCount
           FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
           WHERE po.outlet_id = ?
           ORDER BY po.created_at DESC, po.rowid DESC
           LIMIT ?`
        )
        .all(outletId, limit) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r.id),
        poNumber: String(r.poNumber),
        outletId: String(r.outletId),
        supplierId: String(r.supplierId),
        supplierName: String(r.supplierName),
        status: String(r.status),
        subtotalSatang: Number(r.subtotalSatang),
        totalLandedCostSatang: Number(r.totalLandedCostSatang),
        grandTotalSatang: Number(r.grandTotalSatang),
        lineCount: Number(r.lineCount),
        receivedAt: r.receivedAt === null ? null : String(r.receivedAt),
        createdAt: String(r.createdAt),
      }));
    });
  }

  public listTransferOrdersHistory(limit = 30): TransferOrderHistoryDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT tr.id, tr.transfer_number AS transferNumber,
                  tr.source_outlet_id AS sourceOutletId, COALESCE(os.name, tr.source_outlet_id) AS sourceOutletName,
                  tr.destination_outlet_id AS destinationOutletId, COALESCE(od.name, tr.destination_outlet_id) AS destinationOutletName,
                  tr.status, tr.dispatched_at AS dispatchedAt, tr.received_at AS receivedAt, tr.created_at AS createdAt
           FROM transfer_orders tr
           LEFT JOIN outlets os ON os.id = tr.source_outlet_id
           LEFT JOIN outlets od ON od.id = tr.destination_outlet_id
           ORDER BY tr.created_at DESC, tr.rowid DESC
           LIMIT ?`
        )
        .all(limit) as Array<Record<string, unknown>>;

      const itemsStmt = db.prepare(
        `SELECT toi.variant_id AS variantId, i.name AS itemName, i.unit_name AS unitName,
                toi.quantity_milli AS quantityMilli, toi.transfer_unit_cost_micro_baht AS transferUnitCostMicroBaht
         FROM transfer_order_items toi
         JOIN item_variants v ON v.id = toi.variant_id
         JOIN items i ON i.id = v.item_id
         WHERE toi.transfer_order_id = ?`
      );

      return rows.map((r) => {
        const id = String(r.id);
        const items = (itemsStmt.all(id) as Array<Record<string, unknown>>).map((it) => ({
          variantId: String(it.variantId),
          itemName: String(it.itemName),
          unitName: String(it.unitName),
          quantityMilli: Number(it.quantityMilli),
          transferUnitCostMicroBaht: Number(it.transferUnitCostMicroBaht),
        }));
        return {
          id,
          transferNumber: String(r.transferNumber),
          sourceOutletId: String(r.sourceOutletId),
          sourceOutletName: String(r.sourceOutletName),
          destinationOutletId: String(r.destinationOutletId),
          destinationOutletName: String(r.destinationOutletName),
          status: String(r.status) as 'PENDING' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED',
          dispatchedAt: r.dispatchedAt === null ? null : String(r.dispatchedAt),
          receivedAt: r.receivedAt === null ? null : String(r.receivedAt),
          createdAt: String(r.createdAt),
          items,
        };
      });
    });
  }

  public listSecurityAuditLogs(limit = 50): SecurityAuditLogEntryDto[] {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT id, event_type AS eventType, actor_user_id AS actorUserId,
                  terminal_id AS terminalId, target_key AS targetKey,
                  old_value_redacted AS oldValueRedacted, new_value_redacted AS newValueRedacted,
                  created_at AS createdAt
           FROM security_audit_logs
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(limit) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: Number(r.id),
        eventType: String(r.eventType),
        actorUserId: r.actorUserId === null ? null : String(r.actorUserId),
        terminalId: r.terminalId === null ? null : String(r.terminalId),
        targetKey: r.targetKey === null ? null : String(r.targetKey),
        oldValueRedacted: r.oldValueRedacted === null ? null : String(r.oldValueRedacted),
        newValueRedacted: r.newValueRedacted === null ? null : String(r.newValueRedacted),
        createdAt: String(r.createdAt),
      }));
    });
  }

  // ============================================================================
  // Phase 6B: Modifier Groups CRUD & Production Clean-Start Onboarding Wizard
  // ============================================================================

  public async upsertModifierGroup(input: {
    id?: string | undefined;
    name: string;
    selectionType: 'SINGLE' | 'MULTIPLE';
    minSelections?: number | undefined;
    maxSelections?: number | undefined;
  }): Promise<ModifierGroupWithItemsDto> {
    const id = input.id?.trim() || `GRP-${randomUUID().slice(0, 6).toUpperCase()}`;
    const name = input.name.trim();
    if (!name) throw new Error('Modifier group name is required');
    const minSel = Math.max(0, input.minSelections ?? (input.selectionType === 'SINGLE' ? 1 : 0));
    const maxSel = Math.max(
      1,
      Math.max(minSel, input.maxSelections ?? (input.selectionType === 'SINGLE' ? 1 : 5))
    );

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO modifier_groups (id, name, selection_type, min_selections, max_selections)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           selection_type = excluded.selection_type,
           min_selections = excluded.min_selections,
           max_selections = excluded.max_selections`
      ).run(id, name, input.selectionType, minSel, maxSel);
    });

    const group = this.listModifierGroupsWithModifiers().find((g) => g.id === id);
    if (!group) throw new Error(`Failed to reload modifier group ${id}`);
    return group;
  }

  public async deleteModifierGroup(groupId: string): Promise<void> {
    await this.executeWriteImmediate((db) => {
      db.prepare(`DELETE FROM modifier_groups WHERE id = ?`).run(groupId);
    });
  }

  public async upsertModifierItem(input: {
    id?: string | undefined;
    modifierGroupId: string;
    name: string;
    priceDeltaSatang: Satang;
    modifierMode: 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS';
    componentVariantId?: string | null | undefined;
    quantityDeltaMilli?: MilliUnit | undefined;
    targetComponentRole?: ComponentRole | null | undefined;
    scaleBasisPoints?: BasisPoints | undefined;
    sortOrder?: number | undefined;
  }): Promise<ModifierDto> {
    const id = input.id?.trim() || `MOD-${randomUUID().slice(0, 6).toUpperCase()}`;
    const name = input.name.trim();
    if (!name) throw new Error('Modifier name is required');

    const compId =
      input.modifierMode === 'FIXED_QTY_DELTA' && input.componentVariantId?.trim()
        ? input.componentVariantId.trim()
        : null;
    const qtyDelta = input.modifierMode === 'FIXED_QTY_DELTA' ? (input.quantityDeltaMilli ?? 0) : 0;
    const targetRole =
      input.modifierMode === 'ROLE_SCALE_BPS' ? (input.targetComponentRole ?? 'SWEETENER') : null;
    const scaleBps = input.modifierMode === 'ROLE_SCALE_BPS' ? (input.scaleBasisPoints ?? 0) : 0;
    const sortOrder = input.sortOrder ?? 10;

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO modifiers (
           id, modifier_group_id, name, price_delta_satang, modifier_mode,
           component_variant_id, quantity_delta_milli, target_component_role, scale_basis_points, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           modifier_group_id = excluded.modifier_group_id,
           name = excluded.name,
           price_delta_satang = excluded.price_delta_satang,
           modifier_mode = excluded.modifier_mode,
           component_variant_id = excluded.component_variant_id,
           quantity_delta_milli = excluded.quantity_delta_milli,
           target_component_role = excluded.target_component_role,
           scale_basis_points = excluded.scale_basis_points,
           sort_order = excluded.sort_order`
      ).run(
        id,
        input.modifierGroupId,
        name,
        input.priceDeltaSatang,
        input.modifierMode,
        compId,
        qtyDelta,
        targetRole,
        scaleBps,
        sortOrder
      );
    });

    const mod = this.listModifiers().find((m) => m.id === id);
    if (!mod) throw new Error(`Failed to reload modifier ${id}`);
    return mod;
  }

  public async deleteModifierItem(modifierId: string): Promise<void> {
    await this.executeWriteImmediate((db) => {
      db.prepare(`DELETE FROM modifiers WHERE id = ?`).run(modifierId);
    });
  }

  public isSystemOnboarded(): boolean {
    return this.executeRead((db) => {
      const cfg = db
        .prepare(`SELECT value FROM store_config WHERE key = 'first_run_onboarded'`)
        .get() as { value?: string } | undefined;
      if (cfg?.value === '1') return true;
      const usr = db.prepare(`SELECT COUNT(*) AS cnt FROM users`).get() as { cnt: number };
      return Number(usr.cnt) > 0;
    });
  }

  /**
   * Production Clean-Start First-Run Onboarding:
   * Sets up a customer terminal from an empty database WITHOUT demo clutter (unless `loadDemoSampleCatalog` is explicitly opted in),
   * hashes the Owner's real master PIN, signs `business_profile` + `promptpay_merchant_id` with HMAC-SHA256,
   * and opens the initial cashier shift.
   */
  public async initializeFirstRunOnboarding(input: FirstRunOnboardingInput): Promise<{
    ownerUser: StaffUserDto;
    activeShift: PosShiftDto;
    storeSettings: StoreIdentitySettingsDto;
  }> {
    const outletId = 'OUTLET-HQ';
    const cleanPromptPay = input.promptPayId.replace(/\D/g, '');
    if (cleanPromptPay.length !== 10 && cleanPromptPay.length !== 13 && cleanPromptPay.length !== 15) {
      throw new Error('PromptPay ID must be 10, 13, or 15 digits');
    }
    const ownerPinHash = this.hashStaffPin(input.ownerPin);

    if (input.loadDemoSampleCatalog) {
      await this.seedDefaultWarehouseAndCatalog(outletId);
    }

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO outlets (id, code, name, tax_id, branch_code, rd_pos_reg_no, is_warehouse, active)
         VALUES (?, 'HQ-01', ?, ?, ?, ?, 1, 1)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           tax_id = excluded.tax_id,
           branch_code = excluded.branch_code,
           rd_pos_reg_no = excluded.rd_pos_reg_no`
      ).run(
        outletId,
        input.storeName.trim(),
        input.taxId.trim(),
        input.branchCode.trim() || '00000',
        input.rdPosRegNo.trim() || 'RD-POS-0001'
      );

      db.prepare(
        `INSERT OR IGNORE INTO pos_terminals (id, outlet_id, terminal_name, role, cluster_epoch)
         VALUES ('POS-TERM-01', ?, 'Main Counter Leader POS', 'LEADER', 1)`
      ).run(outletId);

      // Upsert real Owner account with real hashed PIN (replaces demo PIN if demo catalog was opted in)
      db.prepare(
        `INSERT INTO users (id, username, display_name, role, pin_hash, active)
         VALUES ('USR-OWNER-01', ?, ?, 'OWNER', ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           pin_hash = excluded.pin_hash,
           active = 1`
      ).run(
        input.ownerUsername?.trim() || 'owner',
        input.ownerDisplayName.trim() || 'เจ้าของร้าน',
        ownerPinHash
      );

      // Ensure baseline categories & default general supplier exist even on Clean Production Start
      db.prepare(
        `INSERT OR IGNORE INTO categories (id, name, display_color, kitchen_station, sort_order)
         VALUES
           ('CAT-RETAIL', 'สินค้าทั่วไป & ค้าปลีก', '#1a73e8', 'NONE', 1),
           ('CAT-CAFE', 'เครื่องดื่ม & อาหาร', '#1a73e8', 'BAR', 2),
           ('CAT-RAW', 'วัตถุดิบหลังร้าน', '#5f6368', 'PREP', 3)`
      ).run();

      db.prepare(
        `INSERT OR IGNORE INTO suppliers (id, code, name)
         VALUES ('SUP-001', 'SUP-GENERAL', 'ผู้จำหน่ายทั่วไป (General Supplier)')`
      ).run();

      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by)
         VALUES ('first_run_onboarded', '1', 0, 'USR-OWNER-01')
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_by = 'USR-OWNER-01'`
      ).run();

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('FIRST_RUN_ONBOARDING_COMPLETED', 'USR-OWNER-01', 'POS-TERM-01', 'SYSTEM_BOOTSTRAP', NULL, ?)`
      ).run(
        `profile=${input.businessProfile}:cleanStart=${!input.loadDemoSampleCatalog}`
      );
    });

    await this.setBusinessProfileMode(input.businessProfile, 'USR-OWNER-01');
    await this.setProtectedStoreConfig({
      key: 'promptpay_merchant_id',
      value: cleanPromptPay,
      updatedByUserId: 'USR-OWNER-01',
    });

    let activeShift = this.getActiveShift(outletId, 'POS-TERM-01');
    if (!activeShift) {
      activeShift = await this.openPosShift({
        outletId,
        terminalId: 'POS-TERM-01',
        shiftNumber: `SHF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-001`,
        openedByUserId: 'USR-OWNER-01',
        openingCashSatang: Math.max(0, input.openingCashSatang),
        notes: 'Initial shift opened via First-Run Setup Wizard',
      });
    }

    const ownerUser = this.listStaffUsers().find((u) => u.id === 'USR-OWNER-01')!;
    return {
      ownerUser,
      activeShift,
      storeSettings: this.getStoreIdentitySettings(outletId),
    };
  }
}

export interface FirstRunOnboardingInput {
  businessProfile: BusinessProfile;
  storeName: string;
  taxId: string;
  branchCode: string;
  rdPosRegNo: string;
  promptPayId: string;
  ownerDisplayName: string;
  ownerUsername?: string | undefined;
  ownerPin: string;
  loadDemoSampleCatalog: boolean;
  openingCashSatang: Satang;
}

export interface StaffUserDto {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface StoreIdentitySettingsDto {
  outletId: string;
  outletCode: string;
  storeName: string;
  taxId: string;
  branchCode: string;
  rdPosRegNo: string;
  promptPayId: string;
  businessProfile: BusinessProfile;
}

export interface OutletDto {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  branchCode: string;
  rdPosRegNo: string | null;
  isWarehouse: boolean;
  active: boolean;
}

export interface CategoryDto {
  id: string;
  name: string;
  displayColor: string;
  kitchenStation: string;
  sortOrder: number;
}

export interface SupplierDto {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  phone: string | null;
  active: boolean;
}

export interface CatalogVariantDetailDto extends ItemVariantDto {
  defaultPurchaseCostMicroBaht: MicroBaht;
  optimalStockMilli: MilliUnit;
  lowStockThresholdMilli: MilliUnit;
  categoryId: string | null;
  categoryName: string;
  categoryColor: string;
  kitchenStation: string;
  active: boolean;
}

export interface UpsertCatalogVariantInput {
  outletId?: string | undefined;
  variantId?: string | undefined;
  itemId?: string | undefined;
  itemName: string;
  variantName?: string | undefined;
  categoryId?: string | null | undefined;
  sku: string;
  barcode?: string | null | undefined;
  unitName: string;
  priceSatang: Satang;
  defaultPurchaseCostMicroBaht: MicroBaht;
  initialStockMilli?: MilliUnit | undefined;
  lowStockThresholdMilli?: MilliUnit | undefined;
  optimalStockMilli?: MilliUnit | undefined;
  isComposite?: boolean | undefined;
  useProduction?: boolean | undefined;
  isWeightedScale?: boolean | undefined;
  active?: boolean | undefined;
  performedByUserId?: string | undefined;
}

export interface ModifierGroupWithItemsDto {
  id: string;
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  modifiers: ModifierDto[];
}

export interface SalesOrderHistoryDto {
  salesOrderId: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string | null;
  shiftId: string;
  cashierId: string;
  cashierName: string;
  orderType: CheckoutOrderRequest['orderType'];
  tableOrQueueNo: string | null;
  status: 'OPEN' | 'COMPLETED' | 'VOIDED';
  taxMode: TaxMode;
  subtotalSatang: Satang;
  discountSatang: Satang;
  netBeforeTaxSatang: Satang;
  taxSatang: Satang;
  totalSatang: Satang;
  totalCogsMicroBaht: MicroBaht;
  paymentMethod: CheckoutOrderRequest['paymentMethod'];
  paymentSummaryLabel: string;
  payments: Array<{
    paymentMethod: CheckoutOrderRequest['paymentMethod'];
    amountSatang: Satang;
    cashTenderedSatang: Satang | null;
    changeGivenSatang: Satang | null;
    senderBankCode: string | null;
    slipTransRefLast4: string | null;
  }>;
  cashTenderedSatang: Satang | null;
  changeGivenSatang: Satang | null;
  senderBankCode: string | null;
  slipTransRefLast4: string | null;
  voidReason: string | null;
  createdAt: string;
  lines: Array<{
    salesOrderItemId: string;
    variantId: string;
    itemName: string;
    unitName: string;
    quantityMilli: MilliUnit;
    unitPriceSatang: Satang;
    modifiersTotalSatang: Satang;
    lineTotalSatang: Satang;
    modifiers: Array<{
      name: string;
      priceDeltaSatang: Satang;
    }>;
  }>;
}

export interface InventoryLedgerEntryDto {
  id: string;
  outletId: string;
  variantId: string;
  itemName: string;
  sku: string;
  unitName: string;
  transactionType: string;
  quantityChangeMilli: MilliUnit;
  stockBeforeMilli: MilliUnit;
  stockAfterMilli: MilliUnit;
  unitCostMicroBaht: MicroBaht;
  referenceType: string;
  referenceId: string;
  performedByName: string;
  createdAt: string;
}

export interface PurchaseOrderHistoryDto {
  id: string;
  poNumber: string;
  outletId: string;
  supplierId: string;
  supplierName: string;
  status: string;
  subtotalSatang: Satang;
  totalLandedCostSatang: Satang;
  grandTotalSatang: Satang;
  lineCount: number;
  receivedAt: string | null;
  createdAt: string;
}

export interface TransferOrderHistoryDto {
  id: string;
  transferNumber: string;
  sourceOutletId: string;
  sourceOutletName: string;
  destinationOutletId: string;
  destinationOutletName: string;
  status: 'PENDING' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED';
  dispatchedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  items: Array<{
    variantId: string;
    itemName: string;
    unitName: string;
    quantityMilli: MilliUnit;
    transferUnitCostMicroBaht: MicroBaht;
  }>;
}

export interface SecurityAuditLogEntryDto {
  id: number;
  eventType: string;
  actorUserId: string | null;
  terminalId: string | null;
  targetKey: string | null;
  oldValueRedacted: string | null;
  newValueRedacted: string | null;
  createdAt: string;
}

