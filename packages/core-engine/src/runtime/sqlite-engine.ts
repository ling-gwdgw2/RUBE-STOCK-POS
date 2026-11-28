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

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
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
  type BasisPoints,
  type MicroBaht,
  type MilliUnit,
  type Satang,
  type TaxMode,
  parseDecimalStringToScaledInt,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
} from '../../../shared-contracts/src/fixed-point.ts';
import {
  type CashRoundingStepMajor,
  type CountryCode,
  type CurrencyCode,
  type FiscalConfigDto,
  type FxCashTenderDetailDto,
  type FxRatesConfigDto,
  type LaoQrVerificationPolicy,
  type LocaleCode,
  type ShiftFxCashSummaryDto,
  computeOrderFinancialTotals,
  foreignMinorToBaseLakMinor,
  getCurrencyDecimals,
  getCurrencySymbol,
  getDefaultFiscalConfigForCountry,
  getFxRateForCurrency,
  normalizeCashRoundingStepMajor,
  normalizeCountryCode,
  normalizeCurrencyCode,
  normalizeForeignTenderCurrency,
  normalizeFxRatesConfig,
  normalizeLaoQrVerificationPolicy,
  normalizeLocaleCode,
  normalizeScalePriceEmbeddedMultiplier,
  parseMoneyInputToMinor,
} from '../../../shared-contracts/src/currency.ts';
import {
  type GuestEntryChannel,
  type GuestOrderLineInputDto,
  type GuestOrderLineSnapshotDto,
  type GuestOrderRecordDto,
  type GuestServiceCallDto,
  type GuestServiceCallType,
  type QrGuestOrderStatus,
  type QrOrderingConfigDto,
  type TableQrSessionDto,
  buildTableMenuUrl,
  buildTableNfcUrl,
  buildWifiQrPayload,
  computeGuestOrderLineSatang,
  normalizeGuestEntryChannel,
  normalizeQrOrderingConfig,
  sanitizeGuestText,
} from '../../../shared-contracts/src/qr-ordering.ts';
import {
  calculateOrderLineDeductions,
  validateBomDagAcyclic,
  type BomEdgeDto,
  type BusinessProfile,
  type CheckoutOrderRequest,
  type ComponentRole,
  type HeldBillCartLineDto,
  type HeldBillRecordDto,
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
  skipKds?: boolean | undefined;
  notes?: string | null | undefined;
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
  cashRoundingDiscountSatang?: Satang | undefined;
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
  fxTender?: FxCashTenderDetailDto | null | undefined;
  senderBankCode: string | null;
  slipTransRefLast4: string | null;
  slipTransRefHash: string | null;
  kitchenOrderSequenceId: number | null;
  settledHeldBillTableLabel?: string | null | undefined;
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
  fxCashSummary?: ShiftFxCashSummaryDto | undefined;
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

export interface ReportDateRangeFilter {
  startDate?: string | undefined;
  endDate?: string | undefined;
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
   * Chains non-transactional writer tasks (e.g. VACUUM INTO, WAL checkpoint, schema upgrade)
   * onto the Single-Writer FIFO Serialization Queue so they never contend with active transactions.
   */
  private enqueueWriterTask<T>(fn: () => T): Promise<T> {
    const nextTask = this.writerQueue.then(fn);
    // Keep queue alive even if a task throws
    this.writerQueue = nextTask.catch(() => undefined);
    return nextTask;
  }

  /**
   * Executes a write transaction through the Single-Writer FIFO Serialization Queue
   * wrapped in `BEGIN IMMEDIATE TRANSACTION; ... COMMIT;`.
   */
  public executeWriteImmediate<T>(fn: (writer: DatabaseSync) => T): Promise<T> {
    return this.enqueueWriterTask(() => {
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
      this.seedDefaultWarehouseAndCatalogOnDb(db, outletId);
    });
  }

  private seedDefaultWarehouseAndCatalogOnDb(
    db: DatabaseSync,
    outletId: string = 'OUTLET-HQ'
  ): void {
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
  }

  /**
   * Reads all variants & their current inventory levels for an outlet using the Reader Pool.
   */
  private readDeletedVariantIdSet(db: DatabaseSync): Set<string> {
    try {
      const row = db
        .prepare(`SELECT value FROM store_config WHERE key = 'deleted_catalog_variant_ids'`)
        .get() as { value?: string } | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed)) {
          return new Set(parsed.map((id) => String(id)));
        }
      }
    } catch {
      // ignore malformed config
    }
    return new Set();
  }

  public listInventoryCatalog(outletId: string = 'OUTLET-HQ'): ItemVariantDto[] {
    return this.executeRead((db) => {
      const deletedIds = this.readDeletedVariantIdSet(db);
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

      return rows
        .filter((r) => !deletedIds.has(String(r.id)))
        .map((r) => ({
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

    const rollingLevels = new Map<string, { stockMilli: number; macMicro: number }>();

    return input.items.map((line, idx) => {
      const alloc = allocated[idx]!;
      const existing = catalogMap.get(line.variantId);
      const current = rollingLevels.get(line.variantId) ?? {
        stockMilli: existing?.inStockMilli ?? 0,
        macMicro: existing?.averageCostMicroBaht ?? 0,
      };
      const stockBeforeMilli = current.stockMilli;
      const macBeforeMicroBaht = current.macMicro;
      const stockAfterMilli = stockBeforeMilli + line.receivedQtyMilli;
      const macAfterMicroBaht = computeNewMovingAverageCost(
        stockBeforeMilli,
        macBeforeMicroBaht,
        line.receivedQtyMilli,
        alloc.effectiveUnitCostMicroBaht
      );
      rollingLevels.set(line.variantId, {
        stockMilli: stockAfterMilli,
        macMicro: macAfterMicroBaht,
      });

      return {
        variantId: line.variantId,
        itemName: existing?.itemName ?? line.variantId,
        receivedQtyMilli: line.receivedQtyMilli,
        baseUnitCostMicroBaht: line.baseUnitCostMicroBaht,
        allocatedLandedCostMicroBaht: alloc.allocatedLandedCostMicroBaht,
        effectiveUnitCostMicroBaht: alloc.effectiveUnitCostMicroBaht,
        stockBeforeMilli,
        stockAfterMilli,
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
  private insertOpenPosShiftOnDb(db: DatabaseSync, input: OpenPosShiftInput): PosShiftDto {
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
  }

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

      return this.insertOpenPosShiftOnDb(db, input);
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
             (SELECT MIN(ko.sequence_id) FROM kitchen_orders ko WHERE ko.sales_order_id = so.id) AS kitchen_seq_id
           FROM sales_orders so
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

      // 2.5. Validate Held Bill settlement constraints BEFORE inventory or ledger mutations
      let settledHeldBillTableLabel: string | null = null;
      const targetHeldBillId = request.heldBillId?.trim() || '';
      if (targetHeldBillId) {
        const currentHeldBills = this.readHeldBillsOnDb(db, request.outletId);
        const heldBill = currentHeldBills.find((b) => b.id === targetHeldBillId);
        if (!heldBill) {
          throw new Error(
            'HTTP 409 บิลพักที่ระบุถูกชำระเงินปิดบิลหรือถูกยกเลิกไปแล้ว'
          );
        }
        if (
          request.expectedHeldBillVersion !== undefined &&
          Number(heldBill.version ?? 1) !== request.expectedHeldBillVersion
        ) {
          throw new Error(
            'HTTP 409 บิลพักมีการอัปเดตรายการใหม่ (เช่น ออเดอร์ QR สั่งเพิ่ม) กรุณากดอัปเดตยอดล่าสุดก่อนรับชำระ'
          );
        }
        const deficits = this.findHeldBillLineDeficits(heldBill.cart, request.lines);
        if (deficits.length > 0) {
          throw new Error(
            `HTTP 403 Forbidden: ห้ามลบหรือลดรายการในบิลพักขณะชำระเงิน ต้องขออนุมัติ PIN ผู้จัดการก่อน (${deficits.join(', ')})`
          );
        }
        settledHeldBillTableLabel = heldBill.referenceLabel;
      }

      // 3. Load current Catalog, BOM edges, and Modifiers inside the transaction
      const deletedIds = this.readDeletedVariantIdSet(db);
      const catalogRows = db
        .prepare(
          `SELECT
             v.id, v.item_id AS itemId, i.name AS itemName, v.variant_name AS variantName,
             v.sku, v.barcode, i.unit_name AS unitName, v.price_satang AS priceSatang,
             COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht) AS averageCostMicroBaht,
             COALESCE(il.in_stock_milli, 0) AS inStockMilli,
             i.is_composite AS isComposite, i.use_production AS useProduction,
             i.is_weighted_scale AS isWeightedScale,
             COALESCE(c.kitchen_station, 'NONE') AS kitchenStation,
             v.active AS active
           FROM item_variants v
           JOIN items i ON i.id = v.item_id
           LEFT JOIN categories c ON c.id = i.category_id
           LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?`
        )
        .all(request.outletId) as Array<Record<string, unknown>>;

      const catalogMap = new Map<
        string,
        ItemVariantDto & { kitchenStation: string; active: boolean }
      >();
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
          active: Number(r.active) === 1,
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
        if (deletedIds.has(reqLine.variantId) || !variant.active) {
          throw new Error(`HTTP 409 Variant ${reqLine.variantId} is inactive or deleted`);
        }
        const selectedMods = reqLine.selectedModifierIds.map((mId) => {
          const mod = modifierMap.get(mId);
          if (!mod) throw new Error(`Modifier not found: ${mId}`);
          return mod;
        });

        const rawOverrideLineTotal = (reqLine as { overrideLineTotalSatang?: unknown })
          .overrideLineTotalSatang;
        const baseLinePriceSatang =
          typeof rawOverrideLineTotal === 'number' &&
          Number.isSafeInteger(rawOverrideLineTotal) &&
          rawOverrideLineTotal >= 0
            ? rawOverrideLineTotal
            : Number(
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
        const lineTotalSatang = Math.max(0, baseLinePriceSatang + modifiersTotalSatang);
        subtotalSatang += lineTotalSatang;

        const hasBomEdges = bomEdges.some((e) => e.compositeVariantId === variant.id);
        const effectiveVariantForDeduction =
          variant.isComposite && !variant.useProduction && !hasBomEdges
            ? { ...variant, isComposite: false }
            : variant;
        const lineDeductions = calculateOrderLineDeductions(
          effectiveVariantForDeduction,
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
          skipKds: Boolean(reqLine.skipKds),
          notes: reqLine.notes ? sanitizeGuestText(reqLine.notes, 160) || null : null,
          selectedModifiers: selectedMods.map((m) => ({
            modifierId: m.id,
            name: m.name,
            priceDeltaSatang: m.priceDeltaSatang,
          })),
        });
      }

      const fiscal = this.getFiscalConfigOnDb(db);
      const isPureCashOrder =
        (!request.splitPayments || request.splitPayments.length === 0) &&
        request.paymentMethod === 'CASH';
      const financials = computeOrderFinancialTotals({
        subtotalSatang,
        discountSatang: Math.max(0, request.discountSatang),
        vatRateBps: fiscal.vatRateBps,
        taxMode: request.taxMode,
        currencyCode: fiscal.currencyCode,
        applyCashRounding: isPureCashOrder,
        cashRoundingStepMajor: fiscal.cashRoundingStepMajor,
      });
      const discountSatang = financials.effectiveDiscountSatang;
      const cashRoundingDiscountSatang = financials.cashRoundingDiscountSatang;
      const taxSatang = financials.taxSatang;
      const netBeforeTaxSatang = financials.netBeforeTaxSatang;
      const totalSatang = financials.totalSatang;

      // 5. Validate Payment Method (Single Tender or Multi-Leg Split Tender + Country-Aware Slip Anti-Fraud)
      const parseAndVerifySlip = (rawSlip: string, explicitBankCode?: string) => {
        if (fiscal.countryCode === 'LA') {
          const bankCode =
            (explicitBankCode || 'BCEL')
              .trim()
              .toUpperCase()
              .replace(/[^A-Z0-9_]/g, '') || 'BCEL';
          const cleanedRef = rawSlip.trim().replace(/\s+/g, '').toUpperCase();
          if (cleanedRef.length < 4 || cleanedRef.length > 160) {
            throw new Error('HTTP 422 Invalid Lao bank transfer slip reference');
          }
          const last4 = cleanedRef.slice(-4);
          const hash = createHash('sha256')
            .update(`LA:${bankCode}:${cleanedRef}`)
            .digest('hex');

          const dupRow = db
            .prepare(`SELECT id FROM payment_transactions WHERE slip_trans_ref_hash = ? LIMIT 1`)
            .get(hash) as { id?: string } | undefined;

          if (dupRow?.id) {
            throw new Error(
              `HTTP 409 Duplicate Slip TransRef detected (hash=${hash.slice(0, 12)}...)`
            );
          }
          return { bankCode, last4, hash };
        }

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
      let fxTender: FxCashTenderDetailDto | null = null;

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
            const slip = parseAndVerifySlip(leg.slipTransRefRaw, leg.slipSenderBankCode);
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
          } else if (
            leg.paymentMethod === 'PROMPTPAY_QR' &&
            fiscal.countryCode === 'LA' &&
            leg.slipSenderBankCode
          ) {
            legBank = leg.slipSenderBankCode.trim().toUpperCase().slice(0, 16) || null;
            senderBankCode = legBank;
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
          const requestedForeignCurr = normalizeForeignTenderCurrency(
            request.foreignTenderCurrency
          );
          if (requestedForeignCurr) {
            if (fiscal.countryCode !== 'LA' || !fiscal.fxRates.enabled) {
              throw new Error(
                'HTTP 400 Multi-Currency FX cash tender is disabled for this store'
              );
            }
            const foreignAmt = Number(request.foreignTenderAmountSatang ?? 0);
            if (!Number.isSafeInteger(foreignAmt) || foreignAmt <= 0) {
              throw new Error(
                `HTTP 400 Invalid foreignTenderAmountSatang for ${requestedForeignCurr}: ${foreignAmt}`
              );
            }
            const exchangeRateWholeLak = getFxRateForCurrency(
              fiscal.fxRates,
              requestedForeignCurr
            );
            const equivalentBaseSatang = foreignMinorToBaseLakMinor(
              foreignAmt,
              exchangeRateWholeLak
            );
            if (equivalentBaseSatang < totalSatang) {
              throw new Error(
                `HTTP 400 Insufficient foreign cash tendered (${requestedForeignCurr}): converted=${equivalentBaseSatang}, required=${totalSatang}`
              );
            }
            cashTenderedSatang = equivalentBaseSatang;
            changeGivenSatang = equivalentBaseSatang - totalSatang;
            netCashAddedToDrawerSatang = totalSatang;
            fxTender = {
              currency: requestedForeignCurr,
              foreignAmountSatang: foreignAmt,
              exchangeRateWholeLak,
              equivalentBaseSatang,
              changeGivenBaseSatang: changeGivenSatang,
            };
          } else {
            const tendered = request.cashTenderedSatang ?? totalSatang;
            if (tendered < totalSatang) {
              throw new Error(
                `Insufficient cash tendered: tendered=${tendered}, total=${totalSatang}`
              );
            }
            cashTenderedSatang = tendered;
            changeGivenSatang = tendered - totalSatang;
            netCashAddedToDrawerSatang = totalSatang;
          }
        } else if (request.paymentMethod === 'PROMPTPAY_QR' && request.slipTransRefRaw) {
          const slip = parseAndVerifySlip(request.slipTransRefRaw, request.slipSenderBankCode);
          senderBankCode = slip.bankCode;
          slipTransRefLast4 = slip.last4;
          slipTransRefHash = slip.hash;
        } else if (
          request.paymentMethod === 'PROMPTPAY_QR' &&
          fiscal.countryCode === 'LA' &&
          request.slipSenderBankCode
        ) {
          senderBankCode = request.slipSenderBankCode.trim().toUpperCase().slice(0, 16) || null;
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

      // 6. Generate sequential Receipt Number & Country Tax Invoice Number (`ABB-` for TH, `INV-LA-` for LA)
      const orderCountRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM sales_orders WHERE outlet_id = ? AND status != 'OPEN'`)
        .get(request.outletId) as { cnt: number };
      let branchPrefix = '';
      if (request.outletId !== 'OUTLET-HQ') {
        const outletRow = db
          .prepare(`SELECT code FROM outlets WHERE id = ?`)
          .get(request.outletId) as { code?: string } | undefined;
        const rawCode =
          outletRow?.code ??
          request.outletId.replace(/^OUTLET-/i, '');
        branchPrefix = rawCode.replace(/[^A-Za-z0-9-]/g, '').toUpperCase() || 'BR';
      }

      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const invoiceSeriesPrefix = fiscal.countryCode === 'LA' ? 'INV-LA' : 'ABB';
      const checkDupReceipt = db.prepare(
        `SELECT 1 FROM sales_orders WHERE receipt_number = ? OR abb_tax_invoice_no = ? LIMIT 1`
      );
      let nextSeq = Number(orderCountRow.cnt) + 1;
      let receiptNumber = '';
      let abbTaxInvoiceNo = '';
      while (true) {
        const seqPadded = String(nextSeq).padStart(6, '0');
        receiptNumber = branchPrefix
          ? `RCP-${branchPrefix}-${dateStr}-${seqPadded}`
          : `RCP-${dateStr}-${seqPadded}`;
        abbTaxInvoiceNo = branchPrefix
          ? `${invoiceSeriesPrefix}-${branchPrefix}-${dateStr}-${seqPadded}`
          : `${invoiceSeriesPrefix}-${dateStr}-${seqPadded}`;
        if (!checkDupReceipt.get(receiptNumber, abbTaxInvoiceNo)) {
          break;
        }
        nextSeq += 1;
      }
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
           modifiers_total_satang, discount_satang, line_total_satang, line_cogs_micro_baht, notes
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
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
          line.lineCogsMicroBaht,
          line.notes ?? null
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

      if (fxTender) {
        db.prepare(
          `INSERT INTO security_audit_logs (
             event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
           ) VALUES ('FX_CASH_TENDER', ?, ?, ?, ?, ?)`
        ).run(
          request.cashierId,
          request.terminalId,
          salesOrderId,
          request.shiftId,
          JSON.stringify(fxTender)
        );
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

      // 9. Enqueue Kitchen Orders (KDS) split automatically per station (BAR / MAIN / etc.)
      let kitchenOrderSequenceId: number | null = null;
      const kitchenLines = lineSummaries.filter((l) => {
        if (l.skipKds) return false;
        const v = catalogMap.get(l.variantId);
        return v && v.kitchenStation !== 'NONE';
      });

      if (kitchenLines.length > 0 && !request.skipKdsEnqueue) {
        const queueNumber = cleanTableOrQueue || `Q-${String(nextSeq).padStart(3, '0')}`;
        const linesByStation = new Map<string, typeof kitchenLines>();
        for (const kl of kitchenLines) {
          const st = catalogMap.get(kl.variantId)?.kitchenStation;
          const station = st && st !== 'NONE' ? st : 'BAR';
          const bucket = linesByStation.get(station) ?? [];
          bucket.push(kl);
          linesByStation.set(station, bucket);
        }

        const insertKo = db.prepare(
          `INSERT INTO kitchen_orders (id, sales_order_id, outlet_id, station, queue_number, status)
           VALUES (?, ?, ?, ?, ?, 'QUEUED')`
        );
        const insertKoItem = db.prepare(
          `INSERT INTO kitchen_order_items (
             id, kitchen_order_id, sales_order_item_id, item_summary_text,
             modifiers_summary_text, quantity_milli, status
           ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`
        );

        for (const [station, stationLines] of linesByStation.entries()) {
          const koId = `KO-${randomUUID()}`;
          const koResult = insertKo.run(
            koId,
            salesOrderId,
            request.outletId,
            station,
            queueNumber
          );
          if (kitchenOrderSequenceId === null) {
            kitchenOrderSequenceId = Number(koResult.lastInsertRowid);
          }

          for (const kl of stationLines) {
            const modParts: string[] = [];
            if (kl.selectedModifiers.length > 0) {
              modParts.push(kl.selectedModifiers.map((m) => m.name).join(', '));
            }
            if (kl.notes) {
              modParts.push(`[Note: ${kl.notes}]`);
            }
            const modText = modParts.length > 0 ? modParts.join(' · ') : null;
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
      }

      if (targetHeldBillId) {
        const currentHeldBills = this.readHeldBillsOnDb(db, request.outletId);
        const nextHeldBills = currentHeldBills.filter((b) => b.id !== targetHeldBillId);
        this.writeHeldBillsOnDb(db, request.outletId, nextHeldBills, request.cashierId);
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
        cashRoundingDiscountSatang,
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
        fxTender,
        senderBankCode,
        slipTransRefLast4,
        slipTransRefHash,
        kitchenOrderSequenceId,
        settledHeldBillTableLabel,
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
             so.status, so.total_satang
           FROM sales_orders so
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
      const paymentRows = db
        .prepare(
          `SELECT payment_method
           FROM payment_transactions
           WHERE sales_order_id = ?
           ORDER BY rowid ASC`
        )
        .all(input.salesOrderId) as Array<{ payment_method: string }>;
      const paymentMethod =
        paymentRows.map((r) => String(r.payment_method)).join(' + ') || 'CASH';

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

      // Aggregate net restored qty & weighted historical cost per variant so MAC updates once per variant without sub-step drift
      const aggByVariant = new Map<
        string,
        { netRestoredQtyMilli: number; weightedCostNum: bigint; fallbackUnitCostMicroBaht: number }
      >();
      for (const orig of origTxRows) {
        const restoredQtyMilli = -Number(orig.quantity_change_milli);
        if (restoredQtyMilli === 0) continue;
        const unitCost = Number(orig.unit_cost_micro_baht);
        const cur = aggByVariant.get(orig.variant_id) ?? {
          netRestoredQtyMilli: 0,
          weightedCostNum: 0n,
          fallbackUnitCostMicroBaht: unitCost,
        };
        cur.netRestoredQtyMilli += restoredQtyMilli;
        cur.weightedCostNum += BigInt(restoredQtyMilli) * BigInt(unitCost);
        aggByVariant.set(orig.variant_id, cur);
      }

      const runningStockByVariant = new Map<string, number>();
      for (const [variantId, agg] of aggByVariant.entries()) {
        const weightedUnitCostMicroBaht =
          agg.netRestoredQtyMilli > 0
            ? Math.max(
                0,
                Number(roundDivBigInt(agg.weightedCostNum, BigInt(agg.netRestoredQtyMilli)))
              )
            : agg.fallbackUnitCostMicroBaht;
        const lvl = getLevel.get(outletId, variantId) as
          | { in_stock_milli: number; average_cost_micro_baht: number }
          | undefined;
        const stockBefore = Number(lvl?.in_stock_milli ?? 0);
        const macBefore = Number(lvl?.average_cost_micro_baht ?? weightedUnitCostMicroBaht);
        const stockAfter = stockBefore + agg.netRestoredQtyMilli;
        const macAfter =
          agg.netRestoredQtyMilli > 0
            ? computeNewMovingAverageCost(
                stockBefore,
                macBefore,
                agg.netRestoredQtyMilli,
                weightedUnitCostMicroBaht
              )
            : macBefore;

        upsertLevel.run(
          `INV-${outletId}-${variantId}`,
          outletId,
          variantId,
          stockAfter,
          macAfter
        );
        runningStockByVariant.set(variantId, stockBefore);
      }

      // Emit exact individual VOID_RETURN ledger rows so the historical audit mirror invariant holds 100%
      for (const orig of origTxRows) {
        const restoredQtyMilli = -Number(orig.quantity_change_milli);
        if (restoredQtyMilli === 0) continue;

        const historicalUnitCostMicroBaht = Number(orig.unit_cost_micro_baht);
        const stockBefore = runningStockByVariant.get(orig.variant_id) ?? 0;
        const stockAfter = stockBefore + restoredQtyMilli;
        runningStockByVariant.set(orig.variant_id, stockAfter);

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
        const origShift = db
          .prepare(`SELECT status FROM pos_shifts WHERE id = ?`)
          .get(shiftId) as { status?: string } | undefined;

        if (origShift?.status === 'OPEN') {
          db.prepare(
            `UPDATE pos_shifts SET expected_cash_satang = expected_cash_satang - ? WHERE id = ?`
          ).run(cashToReverseSatang, shiftId);
        } else {
          // Cross-shift void: never mutate historical CLOSED shift totals; deduct from active OPEN drawer with PAID_OUT audit movement
          const currentOpenShift = db
            .prepare(
              `SELECT id FROM pos_shifts
               WHERE outlet_id = ? AND status = 'OPEN'
               ORDER BY opened_at DESC LIMIT 1`
            )
            .get(outletId) as { id?: string } | undefined;

          if (currentOpenShift?.id) {
            db.prepare(
              `INSERT INTO cash_drawer_movements (
                 id, shift_id, movement_type, amount_satang, reason, performed_by
               ) VALUES (?, ?, 'PAID_OUT', ?, ?, ?)`
            ).run(
              `CDM-VOID-${randomUUID()}`,
              currentOpenShift.id,
              cashToReverseSatang,
              `คืนเงินสดยกเลิกบิลข้ามกะ ${String(order.receipt_number)} (${input.voidReason})`,
              input.voidedByUserId
            );
            db.prepare(
              `UPDATE pos_shifts SET expected_cash_satang = expected_cash_satang - ? WHERE id = ?`
            ).run(cashToReverseSatang, currentOpenShift.id);
          }
        }
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
      const existing = db
        .prepare(`SELECT status FROM kitchen_orders WHERE id = ?`)
        .get(input.kitchenOrderId) as { status?: string } | undefined;

      if (!existing) {
        throw new Error('HTTP 404 Kitchen order not found');
      }

      const curStatus = String(existing.status);
      if (curStatus === 'CANCELLED') {
        throw new Error('HTTP 409 ออเดอร์ครัวนี้ถูกยกเลิกบิลแล้ว');
      }

      const statusRank: Record<string, number> = {
        QUEUED: 0,
        PREPARING: 1,
        READY: 2,
        SERVED: 3,
      };
      const curRank = statusRank[curStatus] ?? -1;
      const nextRank = statusRank[input.newStatus] ?? -1;

      if (nextRank > curRank) {
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
        newStatus: nextRank > curRank ? input.newStatus : curStatus,
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
    return this.enqueueWriterTask(() => {
      this.writerConn.exec('BEGIN IMMEDIATE TRANSACTION;');
      let auditLogId: number;
      try {
        const res = this.writerConn
          .prepare(
            `INSERT INTO security_audit_logs (
               event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
             ) VALUES ('UPS_EMERGENCY_WAL_CHECKPOINT', 'USR-OWNER-01', ?, 'WAL_JOURNAL', 'AC_ONLINE', 'ON_BATTERY_TRUNCATED')`
          )
          .run(terminalId);
        auditLogId = Number(res.lastInsertRowid);
        this.writerConn.exec('COMMIT;');
      } catch (err) {
        try {
          this.writerConn.exec('ROLLBACK;');
        } catch {
          // ignore rollback error
        }
        throw err;
      }

      // Run checkpoint after COMMIT inside the same serialized writerQueue task
      this.writerConn.exec('PRAGMA wal_checkpoint(TRUNCATE);');

      return {
        walCheckpointed: true,
        auditLogId,
      };
    });
  }

  /**
   * Phase 3 & 5 (`BACKUP_SVC` — Section 8.3 Tier 2): Atomic USB Flash Drive Backup with `.part` + `fsyncSync`,
   * Orphaned `.part` File Cleanup (recovering from yanked USB drives mid-write), and 14-Shift Rotating Ring Buffer.
   */
  private static readonly USB_BACKUP_MAGIC = Buffer.from('RUBE-ENC-V1\n', 'utf8');
  private static readonly USB_BACKUP_AAD = Buffer.from('RUBE-USB-BACKUP-AES256GCM-V3.1', 'utf8');

  public static encryptUsbBackupPayload(plainDbBytes: Buffer, rawHexKey64: string): Buffer {
    const key32 = Buffer.from(rawHexKey64, 'hex');
    if (key32.byteLength !== 32) {
      throw new Error('SQLCipher Raw Hex Key must decode to 32 bytes for AES-256-GCM backup');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key32, iv);
    cipher.setAAD(SqliteReadWritePoolEngine.USB_BACKUP_AAD);
    const ciphertext = Buffer.concat([cipher.update(plainDbBytes), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([SqliteReadWritePoolEngine.USB_BACKUP_MAGIC, iv, authTag, ciphertext]);
  }

  public static decryptUsbBackupPayload(
    encryptedBytes: Buffer,
    rawHexKey64: string = DEV_SQLCIPHER_RAW_HEX_KEY_64
  ): Buffer {
    if (
      encryptedBytes.byteLength < 40 ||
      !encryptedBytes.subarray(0, 12).equals(SqliteReadWritePoolEngine.USB_BACKUP_MAGIC)
    ) {
      throw new Error('Invalid or corrupted RUBE-ENC-V1 USB backup envelope');
    }
    const key32 = Buffer.from(rawHexKey64, 'hex');
    if (key32.byteLength !== 32) {
      throw new Error('Decryption key must be 64 hexadecimal characters (256 bits)');
    }
    const iv = encryptedBytes.subarray(12, 24);
    const authTag = encryptedBytes.subarray(24, 40);
    const ciphertext = encryptedBytes.subarray(40);
    const decipher = createDecipheriv('aes-256-gcm', key32, iv);
    decipher.setAAD(SqliteReadWritePoolEngine.USB_BACKUP_AAD);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  public async exportEncryptedUsbBackupWithRingBuffer(
    usbBackupDir: string,
    shiftNumber: string
  ): Promise<{
    writtenBackupPath: string;
    evictedOldestBackupPath: string | null;
    retainedBackupsCount: number;
    cleanedOrphanedPartFilesCount: number;
  }> {
    return this.enqueueWriterTask(() => {
      mkdirSync(usbBackupDir, { recursive: true });

      // Clean up any orphaned `.part` files left behind if a USB drive was yanked during a prior backup
      const orphanedParts = readdirSync(usbBackupDir).filter((name) => name.endsWith('.part'));
      let cleanedOrphanedPartFilesCount = 0;
      for (const partName of orphanedParts) {
        unlinkSync(join(usbBackupDir, partName));
        cleanedOrphanedPartFilesCount++;
      }

      const finalFilename = `rube_backup_${shiftNumber}.db.enc`;
      const finalPath = join(usbBackupDir, finalFilename);
      const partPath = join(usbBackupDir, `${finalFilename}.part`);

      let dbBytes: Buffer;
      if (this.dbPath === ':memory:') {
        dbBytes = Buffer.from(`SQLCIPHER_ENC_SNAPSHOT:${shiftNumber}:${Date.now()}`, 'utf8');
      } else {
        const rawSnapPath = join(usbBackupDir, `.tmp_vacuum_${randomUUID()}.part`);
        try {
          this.writerConn.exec(`VACUUM INTO '${rawSnapPath.replace(/'/g, "''")}';`);
          dbBytes = readFileSync(rawSnapPath);
        } finally {
          try {
            unlinkSync(rawSnapPath);
          } catch {
            // ignore if temp snapshot was not created
          }
        }
      }
      const encryptedPayload = SqliteReadWritePoolEngine.encryptUsbBackupPayload(
        dbBytes,
        this.rawHexKey64
      );

      const fd = openSync(partPath, 'w');
      try {
        writeSync(fd, encryptedPayload);
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
    });
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

  private upsertProtectedStoreConfigOnDb(
    db: DatabaseSync,
    input: {
      key: string;
      value: string;
      hmacSignatureHex: string;
      updatedByUserId: string;
      terminalId?: string;
    }
  ): { key: string; value: string; hmacSignatureHex: string; auditLogId: number } {
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
    ).run(input.key, input.value, input.hmacSignatureHex, input.updatedByUserId);

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
      hmacSignatureHex: input.hmacSignatureHex,
      auditLogId: Number(auditRes.lastInsertRowid),
    };
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

    return this.executeWriteImmediate((db) =>
      this.upsertProtectedStoreConfigOnDb(db, {
        ...input,
        hmacSignatureHex,
      })
    );
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
    const transactionalDdl = normalizedSql
      .replace(/^\s*PRAGMA\s+[^;]+;\s*$/gim, '')
      .replace(
        /^\s*BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;\s*$/gim,
        ''
      )
      .replace(/^\s*COMMIT(?:\s+TRANSACTION)?\s*;\s*$/gim, '');
    const startMs = Date.now();

    return this.enqueueWriterTask((): SchemaUpgradeResult => {
      // Step 1: Quiesce & Cold Snapshot (`PRAGMA wal_checkpoint(TRUNCATE);`)
      const ckptRow = this.writerConn.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | undefined;

      let snapshotPath: string | null = null;
      if (input.snapshotDir) {
        mkdirSync(input.snapshotDir, { recursive: true });
        snapshotPath = join(
          input.snapshotDir,
          `rube_pre_migration_v${input.version}.db.bak`
        );
        const partPath = `${snapshotPath}.part`;
        try {
          unlinkSync(partPath);
        } catch {
          // ignore if no stale .part exists
        }
        if (this.dbPath === ':memory:') {
          const dbBytes = Buffer.from(`PRE_MIGRATION_V${input.version}:${Date.now()}`, 'utf8');
          const fd = openSync(partPath, 'w');
          try {
            writeSync(fd, dbBytes);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } else if (
          Number(ckptRow?.busy ?? 1) === 0 &&
          Number(ckptRow?.log ?? -1) >= 0 &&
          Number(ckptRow?.log ?? -1) === Number(ckptRow?.checkpointed ?? -2)
        ) {
          const dbBytes = readFileSync(this.dbPath);
          const fd = openSync(partPath, 'w');
          try {
            writeSync(fd, dbBytes);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } else {
          // Active readers prevented full WAL truncation: VACUUM INTO includes 100% of WAL frames atomically
          try {
            this.writerConn.exec(`VACUUM INTO '${partPath.replace(/'/g, "''")}';`);
          } catch (err) {
            try {
              unlinkSync(partPath);
            } catch {
              // ignore cleanup failure
            }
            throw err;
          }
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
      const expectedCashSatang = Number(shiftRow.expected_cash_satang);

      // Phase 5: Multi-Currency FX Drawer Summary (joins sales_orders so VOIDED bills are excluded atomically)
      const fxRows = db
        .prepare(
          `SELECT sal.new_value_redacted AS fxJson
           FROM security_audit_logs sal
           JOIN sales_orders so ON so.id = sal.target_key
           WHERE sal.event_type = 'FX_CASH_TENDER'
             AND sal.old_value_redacted = ?
             AND so.status = 'COMPLETED'`
        )
        .all(shiftId) as Array<{ fxJson?: string }>;

      let fxTransactionsCount = 0;
      let thbCollectedSatang = 0;
      let thbEquivalentBaseSatang = 0;
      let usdCollectedSatang = 0;
      let usdEquivalentBaseSatang = 0;
      for (const row of fxRows) {
        if (!row.fxJson) continue;
        try {
          const parsed = JSON.parse(row.fxJson) as Partial<FxCashTenderDetailDto>;
          if (parsed.currency === 'THB') {
            fxTransactionsCount += 1;
            thbCollectedSatang += Number(parsed.foreignAmountSatang ?? 0);
            thbEquivalentBaseSatang += Number(parsed.equivalentBaseSatang ?? 0);
          } else if (parsed.currency === 'USD') {
            fxTransactionsCount += 1;
            usdCollectedSatang += Number(parsed.foreignAmountSatang ?? 0);
            usdEquivalentBaseSatang += Number(parsed.equivalentBaseSatang ?? 0);
          }
        } catch {
          // ignore malformed historical row
        }
      }
      const totalForeignEquivalentBaseSatang = thbEquivalentBaseSatang + usdEquivalentBaseSatang;
      const fxCashSummary: ShiftFxCashSummaryDto = {
        fxTransactionsCount,
        thbCollectedSatang,
        thbEquivalentBaseSatang,
        usdCollectedSatang,
        usdEquivalentBaseSatang,
        totalForeignEquivalentBaseSatang,
        expectedNativeBaseCashInDrawerSatang: expectedCashSatang - totalForeignEquivalentBaseSatang,
      };

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
        expectedCashSatang,
        countedCashSatang:
          shiftRow.counted_cash_satang === null ? null : Number(shiftRow.counted_cash_satang),
        cashVarianceSatang:
          shiftRow.cash_variance_satang === null ? null : Number(shiftRow.cash_variance_satang),
        fxCashSummary,
      };
    });
  }

  private normalizeDateBound(dateStr?: string): string | null {
    const trimmed = dateStr?.trim();
    if (!trimmed) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
  }

  /**
   * Phase 5 (`REPORT_SVC`): Generates the Thai Simplified Tax Invoice (ABB) Sales Tax Report.
   */
  public generateAbbSalesTaxReport(
    outletId = 'OUTLET-HQ',
    dateRange?: ReportDateRangeFilter
  ): AbbSalesTaxReportDto {
    const startBound = this.normalizeDateBound(dateRange?.startDate);
    const endBound = this.normalizeDateBound(dateRange?.endDate);
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
             AND status != 'OPEN'
             AND (? IS NULL OR substr(created_at, 1, 10) >= ?)
             AND (? IS NULL OR substr(created_at, 1, 10) <= ?)
           ORDER BY created_at ASC, id ASC`
        )
        .all(outletId, startBound, startBound, endBound, endBound) as Array<Record<string, unknown>>;

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

  private prorateOrderDiscountSatang(
    orderDiscountSatang: number,
    lineTotalsSatang: readonly number[]
  ): number[] {
    if (orderDiscountSatang <= 0 || lineTotalsSatang.length === 0) {
      return lineTotalsSatang.map(() => 0);
    }
    const sumLines = lineTotalsSatang.reduce((acc, v) => acc + BigInt(Math.max(0, v)), 0n);
    if (sumLines <= 0n) {
      return lineTotalsSatang.map(() => 0);
    }
    const rawDiscount = BigInt(orderDiscountSatang);
    const effectiveDiscount = rawDiscount > sumLines ? sumLines : rawDiscount;

    const provisional = lineTotalsSatang.map((val, idx) => {
      const lineAmt = BigInt(Math.max(0, val));
      const prod = effectiveDiscount * lineAmt;
      return {
        idx,
        share: prod / sumLines,
        remainder: prod % sumLines,
      };
    });

    let remaining = effectiveDiscount - provisional.reduce((acc, p) => acc + p.share, 0n);
    if (remaining > 0n) {
      const byRem = [...provisional].sort((a, b) => {
        if (b.remainder !== a.remainder) {
          return b.remainder > a.remainder ? 1 : -1;
        }
        return a.idx - b.idx;
      });
      for (const entry of byRem) {
        if (remaining <= 0n) break;
        entry.share += 1n;
        remaining -= 1n;
      }
    }

    return provisional.map((p) => Number(p.share));
  }

  /**
   * Phase 5 (`REPORT_SVC`): Generates the Menu / Item COGS & Gross Margin Report across completed orders.
   */
  public generateMenuGrossMarginAndCogsReport(
    outletId = 'OUTLET-HQ',
    dateRange?: ReportDateRangeFilter
  ): MenuGrossMarginReportDto {
    const startBound = this.normalizeDateBound(dateRange?.startDate);
    const endBound = this.normalizeDateBound(dateRange?.endDate);
    return this.executeRead((db) => {
      const rawItems = db
        .prepare(
          `SELECT
             so.id AS salesOrderId,
             so.subtotal_satang AS orderSubtotalSatang,
             so.discount_satang AS orderDiscountSatang,
             v.id AS variantId,
             i.name AS itemName,
             v.variant_name AS variantName,
             soi.quantity_milli AS quantityMilli,
             soi.line_total_satang AS lineTotalSatang,
             soi.line_cogs_micro_baht AS lineCogsMicroBaht
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.sales_order_id
           JOIN item_variants v ON v.id = soi.variant_id
           JOIN items i ON i.id = v.item_id
           WHERE so.outlet_id = ? AND so.status = 'COMPLETED'
             AND (? IS NULL OR substr(so.created_at, 1, 10) >= ?)
             AND (? IS NULL OR substr(so.created_at, 1, 10) <= ?)
           ORDER BY so.id ASC, soi.rowid ASC`
        )
        .all(outletId, startBound, startBound, endBound, endBound) as Array<
        Record<string, unknown>
      >;

      // Group line items per sales order so order-level discount_satang is prorated with BigInt Largest Remainder
      const itemsByOrder = new Map<
        string,
        {
          orderSubtotalSatang: number;
          orderDiscountSatang: number;
          items: Array<{
            variantId: string;
            itemName: string;
            variantName: string;
            quantityMilli: number;
            lineTotalSatang: number;
            lineCogsMicroBaht: number;
          }>;
        }
      >();

      for (const r of rawItems) {
        const orderId = String(r.salesOrderId);
        let group = itemsByOrder.get(orderId);
        if (!group) {
          group = {
            orderSubtotalSatang: Number(r.orderSubtotalSatang),
            orderDiscountSatang: Number(r.orderDiscountSatang),
            items: [],
          };
          itemsByOrder.set(orderId, group);
        }
        group.items.push({
          variantId: String(r.variantId),
          itemName: String(r.itemName),
          variantName: String(r.variantName),
          quantityMilli: Number(r.quantityMilli),
          lineTotalSatang: Number(r.lineTotalSatang),
          lineCogsMicroBaht: Number(r.lineCogsMicroBaht),
        });
      }

      const aggByVariant = new Map<
        string,
        {
          variantId: string;
          itemName: string;
          variantName: string;
          soldQtyMilli: number;
          grossRevenueSatang: number;
          totalCogsMicroBaht: number;
        }
      >();

      for (const orderGroup of itemsByOrder.values()) {
        const discounts =
          orderGroup.orderDiscountSatang > 0 && orderGroup.orderSubtotalSatang > 0
            ? this.prorateOrderDiscountSatang(
                orderGroup.orderDiscountSatang,
                orderGroup.items.map((it) => it.lineTotalSatang)
              )
            : orderGroup.items.map(() => 0);

        for (let i = 0; i < orderGroup.items.length; i++) {
          const it = orderGroup.items[i]!;
          const netLineSatang = Math.max(0, it.lineTotalSatang - (discounts[i] ?? 0));
          const existing = aggByVariant.get(it.variantId);
          if (existing) {
            existing.soldQtyMilli += it.quantityMilli;
            existing.grossRevenueSatang += netLineSatang;
            existing.totalCogsMicroBaht += it.lineCogsMicroBaht;
          } else {
            aggByVariant.set(it.variantId, {
              variantId: it.variantId,
              itemName: it.itemName,
              variantName: it.variantName,
              soldQtyMilli: it.quantityMilli,
              grossRevenueSatang: netLineSatang,
              totalCogsMicroBaht: it.lineCogsMicroBaht,
            });
          }
        }
      }

      const rows = Array.from(aggByVariant.values()).sort((a, b) => {
        if (b.grossRevenueSatang !== a.grossRevenueSatang) {
          return b.grossRevenueSatang - a.grossRevenueSatang;
        }
        return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;
      });

      let totalRevenueSatang = 0;
      let totalCogsSatang = 0;
      let totalGrossProfitSatang = 0;

      const lines = rows.map((r) => {
        const soldQtyMilli = r.soldQtyMilli;
        const grossRevenueSatang = r.grossRevenueSatang;
        const totalCogsMicroBaht = r.totalCogsMicroBaht;
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
          variantId: r.variantId,
          itemName: r.itemName,
          variantName: r.variantName,
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
    const saltHex = randomBytes(16).toString('hex');
    const derivedHex = scryptSync(
      `RUBE-STAFF-PIN-V3.1:${clean}`,
      Buffer.from(saltHex, 'hex'),
      32,
      { N: 16384, r: 8, p: 1 }
    ).toString('hex');
    return `scrypt:pin:${saltHex}:${derivedHex}`;
  }

  private matchesPinHash(rawPin: string, storedHash: string): boolean {
    const clean = rawPin.trim();
    if (!/^\d{4,8}$/.test(clean)) return false;
    // Support legacy seeded user placeholders out of the box
    if (storedHash === 'sha256:owner_pin' && clean === '999999') return true;
    if (storedHash === 'sha256:cashier_pin' && clean === '111111') return true;
    if (storedHash === 'sha256:wh_pin' && clean === '222222') return true;

    if (storedHash.startsWith('scrypt:pin:')) {
      const parts = storedHash.split(':');
      if (parts.length !== 4 || !parts[2] || !parts[3]) return false;
      const saltHex = parts[2];
      const expectedHex = parts[3];
      const derived = scryptSync(
        `RUBE-STAFF-PIN-V3.1:${clean}`,
        Buffer.from(saltHex, 'hex'),
        32,
        { N: 16384, r: 8, p: 1 }
      );
      const expected = Buffer.from(expectedHex, 'hex');
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    }

    const legacyDigest = createHash('sha256')
      .update(`RUBE-STAFF-PIN-V3.1:${clean}`, 'utf8')
      .digest('hex');
    const computedLegacy = `sha256:pin:${legacyDigest}`;
    const a = Buffer.from(computedLegacy, 'utf8');
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
    const rows = this.executeRead((db) => {
      return input.userId
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
    });

    // Run CPU-intensive scryptSync outside writerQueue so concurrent PIN checks never block checkouts/warehouse writes
    const matched = rows.find((r) => this.matchesPinHash(input.pin, String(r.pinHash)));
    if (!matched) {
      await this.executeWriteImmediate((db) => {
        db.prepare(
          `INSERT INTO security_audit_logs (
             event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
           ) VALUES ('AUTH_PIN_FAILED', ?, ?, 'STAFF_SESSION', NULL, 'INVALID_PIN')`
        ).run(input.userId ?? null, terminalId);
      });
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

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('AUTH_PIN_SUCCESS', ?, ?, 'STAFF_SESSION', NULL, ?)`
      ).run(user.id, terminalId, `ROLE:${user.role}`);
    });

    return user;
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

  private readRawStoreConfigOnDb(db: DatabaseSync, key: string): string | null {
    const row = db
      .prepare(`SELECT value, is_protected, hmac_signature_hex FROM store_config WHERE key = ?`)
      .get(key) as
      | { value: string; is_protected: number; hmac_signature_hex: string | null }
      | undefined;
    if (!row) return null;
    if (Number(row.is_protected) === 1) {
      const expected = this.computeProtectedConfigHmacHex(key, row.value);
      if (!row.hmac_signature_hex) return null;
      const a = Buffer.from(row.hmac_signature_hex, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return null;
      }
    }
    return row.value;
  }

  private getFiscalConfigOnDb(db: DatabaseSync): FiscalConfigDto {
    const countryCode = normalizeCountryCode(this.readRawStoreConfigOnDb(db, 'country_code'));
    const defaults = getDefaultFiscalConfigForCountry(countryCode);
    const currencyCode = normalizeCurrencyCode(
      this.readRawStoreConfigOnDb(db, 'currency_code'),
      countryCode
    );
    const uiLocale = normalizeLocaleCode(
      this.readRawStoreConfigOnDb(db, 'ui_locale'),
      defaults.uiLocale
    );
    const receiptLocale = normalizeLocaleCode(
      this.readRawStoreConfigOnDb(db, 'receipt_locale'),
      defaults.receiptLocale
    );
    const rawVat = this.readRawStoreConfigOnDb(db, 'vat_rate_bps');
    const parsedVat = rawVat !== null && rawVat !== '' ? Number(rawVat) : defaults.vatRateBps;
    const vatRateBps =
      Number.isSafeInteger(parsedVat) && parsedVat >= 0 && parsedVat <= 5000
        ? parsedVat
        : defaults.vatRateBps;
    const rawTaxMode = this.readRawStoreConfigOnDb(db, 'default_tax_mode');
    const defaultTaxMode: TaxMode =
      rawTaxMode === 'NONE' || rawTaxMode === 'INCLUSIVE' || rawTaxMode === 'EXCLUSIVE'
        ? rawTaxMode
        : defaults.defaultTaxMode;
    const cashRoundingStepMajor = normalizeCashRoundingStepMajor(
      this.readRawStoreConfigOnDb(db, 'cash_rounding_step_major')
    );
    const scalePriceEmbeddedMultiplier = normalizeScalePriceEmbeddedMultiplier(
      this.readRawStoreConfigOnDb(db, 'scale_price_embedded_multiplier'),
      countryCode
    );
    const storeAddress = this.readRawStoreConfigOnDb(db, 'store_address') ?? '';
    const laoQrStaticTemplate = this.readRawStoreConfigOnDb(db, 'lao_qr_static_template') ?? '';
    const laoQrVerificationPolicy = normalizeLaoQrVerificationPolicy(
      this.readRawStoreConfigOnDb(db, 'lao_qr_verification_policy')
    );
    let parsedFxRaw: unknown = null;
    const rawFxJson = this.readRawStoreConfigOnDb(db, 'fx_rates_json');
    if (rawFxJson) {
      try {
        parsedFxRaw = JSON.parse(rawFxJson);
      } catch {
        parsedFxRaw = null;
      }
    }
    const fxRates = normalizeFxRatesConfig(parsedFxRaw, countryCode);

    return {
      countryCode,
      currencyCode,
      currencySymbol: getCurrencySymbol(currencyCode),
      currencyDecimals: getCurrencyDecimals(currencyCode),
      uiLocale,
      receiptLocale,
      vatRateBps,
      defaultTaxMode,
      cashRoundingStepMajor: currencyCode === 'LAK' ? cashRoundingStepMajor : 0,
      scalePriceEmbeddedMultiplier,
      storeAddress,
      laoQrStaticTemplate,
      laoQrVerificationPolicy,
      fxRates,
    };
  }

  public getFiscalConfig(): FiscalConfigDto {
    return this.executeRead((db) => this.getFiscalConfigOnDb(db));
  }

  private assertValidLaoQrStaticTemplateIfNonEmpty(rawTemplate: string): string {
    const trimmed = rawTemplate.trim();
    if (!trimmed) return '';
    if (!trimmed.startsWith('000201') || trimmed.length < 24) {
      throw new Error('HTTP 422 Invalid LAOQR static template: missing EMVCo header 000201');
    }
    const crcHeaderIdx = trimmed.length - 8;
    if (trimmed.slice(crcHeaderIdx, crcHeaderIdx + 4) !== '6304') {
      throw new Error('HTTP 422 Invalid LAOQR static template: missing CRC16 tag 6304');
    }
    const bodyForCrc = trimmed.slice(0, trimmed.length - 4);
    let crc = 0xffff;
    for (let i = 0; i < bodyForCrc.length; i++) {
      crc ^= bodyForCrc.charCodeAt(i) << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    const expectedHex = crc.toString(16).toUpperCase().padStart(4, '0');
    const actualHex = trimmed.slice(trimmed.length - 4).toUpperCase();
    if (expectedHex !== actualHex) {
      throw new Error(
        `HTTP 422 Invalid LAOQR static template CRC16 (expected ${expectedHex}, got ${actualHex})`
      );
    }
    if (!trimmed.includes('5802LA')) {
      throw new Error('HTTP 422 Invalid LAOQR static template: country tag 58 must be LA');
    }
    return trimmed;
  }

  public async updateUiLocale(input: {
    uiLocale: LocaleCode;
    receiptLocale?: LocaleCode | undefined;
    updatedByUserId?: string | undefined;
  }): Promise<FiscalConfigDto> {
    const actor = input.updatedByUserId ?? 'USR-OWNER-01';
    const cleanUi = normalizeLocaleCode(input.uiLocale, 'th');
    const cleanReceipt = input.receiptLocale
      ? normalizeLocaleCode(input.receiptLocale, cleanUi)
      : undefined;

    await this.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
         VALUES ('ui_locale', ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(cleanUi, actor);
      if (cleanReceipt) {
        db.prepare(
          `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
           VALUES ('receipt_locale', ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_by = excluded.updated_by,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        ).run(cleanReceipt, actor);
      }
    });
    return this.getFiscalConfig();
  }

  public async updateFiscalConfig(input: {
    countryCode?: CountryCode | undefined;
    currencyCode?: CurrencyCode | undefined;
    uiLocale?: LocaleCode | undefined;
    receiptLocale?: LocaleCode | undefined;
    vatRateBps?: BasisPoints | undefined;
    defaultTaxMode?: TaxMode | undefined;
    cashRoundingStepMajor?: CashRoundingStepMajor | undefined;
    scalePriceEmbeddedMultiplier?: number | undefined;
    storeAddress?: string | undefined;
    laoQrStaticTemplate?: string | undefined;
    laoQrVerificationPolicy?: LaoQrVerificationPolicy | undefined;
    fxRates?: Partial<FxRatesConfigDto> | undefined;
    updatedByUserId?: string | undefined;
  }): Promise<FiscalConfigDto> {
    const actor = input.updatedByUserId ?? 'USR-OWNER-01';
    const current = this.getFiscalConfig();
    const countryCode = input.countryCode
      ? normalizeCountryCode(input.countryCode)
      : current.countryCode;
    const countryChanged = countryCode !== current.countryCode;
    const defaultsForCountry = getDefaultFiscalConfigForCountry(countryCode);
    const currencyCode = input.currencyCode
      ? normalizeCurrencyCode(input.currencyCode, countryCode)
      : countryChanged
        ? defaultsForCountry.currencyCode
        : current.currencyCode;
    const uiLocale = input.uiLocale
      ? normalizeLocaleCode(input.uiLocale, defaultsForCountry.uiLocale)
      : countryChanged
        ? defaultsForCountry.uiLocale
        : current.uiLocale;
    const receiptLocale = input.receiptLocale
      ? normalizeLocaleCode(input.receiptLocale, defaultsForCountry.receiptLocale)
      : countryChanged
        ? defaultsForCountry.receiptLocale
        : current.receiptLocale;
    const vatRateBps =
      input.vatRateBps !== undefined
        ? Math.max(0, Math.min(5000, Math.round(Number(input.vatRateBps))))
        : countryChanged
          ? defaultsForCountry.vatRateBps
          : current.vatRateBps;
    const defaultTaxMode: TaxMode =
      input.defaultTaxMode === 'NONE' ||
      input.defaultTaxMode === 'INCLUSIVE' ||
      input.defaultTaxMode === 'EXCLUSIVE'
        ? input.defaultTaxMode
        : current.defaultTaxMode;
    const cashRoundingStepMajor =
      currencyCode === 'LAK'
        ? input.cashRoundingStepMajor !== undefined
          ? normalizeCashRoundingStepMajor(input.cashRoundingStepMajor)
          : current.cashRoundingStepMajor
        : 0;
    const scalePriceEmbeddedMultiplier =
      input.scalePriceEmbeddedMultiplier !== undefined
        ? normalizeScalePriceEmbeddedMultiplier(input.scalePriceEmbeddedMultiplier, countryCode)
        : countryChanged
          ? defaultsForCountry.scalePriceEmbeddedMultiplier
          : current.scalePriceEmbeddedMultiplier;
    const storeAddress =
      input.storeAddress !== undefined ? input.storeAddress.trim() : current.storeAddress;
    const laoQrStaticTemplate =
      input.laoQrStaticTemplate !== undefined
        ? this.assertValidLaoQrStaticTemplateIfNonEmpty(input.laoQrStaticTemplate)
        : current.laoQrStaticTemplate;
    const laoQrVerificationPolicy =
      input.laoQrVerificationPolicy !== undefined
        ? normalizeLaoQrVerificationPolicy(input.laoQrVerificationPolicy)
        : current.laoQrVerificationPolicy;
    const fxRates = normalizeFxRatesConfig(
      input.fxRates ? { ...current.fxRates, ...input.fxRates } : current.fxRates,
      countryCode
    );

    const protectedPairs: Array<[string, string]> = [
      ['country_code', countryCode],
      ['currency_code', currencyCode],
      ['vat_rate_bps', String(vatRateBps)],
      ['default_tax_mode', defaultTaxMode],
      ['cash_rounding_step_major', String(cashRoundingStepMajor)],
      ['scale_price_embedded_multiplier', String(scalePriceEmbeddedMultiplier)],
      ['lao_qr_static_template', laoQrStaticTemplate],
      ['lao_qr_verification_policy', laoQrVerificationPolicy],
      ['fx_rates_json', JSON.stringify(fxRates)],
    ];
    const signedPairs = protectedPairs.map(([key, value]) => ({
      key,
      value,
      hmac: this.computeProtectedConfigHmacHex(key, value),
    }));

    await this.executeWriteImmediate((db) => {
      for (const pair of signedPairs) {
        this.upsertProtectedStoreConfigOnDb(db, {
          key: pair.key,
          value: pair.value,
          hmacSignatureHex: pair.hmac,
          updatedByUserId: actor,
        });
      }
      const upsertPlain = db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
         VALUES (?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );
      upsertPlain.run('ui_locale', uiLocale, actor);
      upsertPlain.run('receipt_locale', receiptLocale, actor);
      upsertPlain.run('store_address', storeAddress, actor);

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('FISCAL_CONFIG_UPDATED', ?, 'POS-TERM-01', 'country_fiscal_config', ?, ?)`
      ).run(
        actor,
        `${current.countryCode}/${current.currencyCode}/VAT:${current.vatRateBps}/ROUND:${current.cashRoundingStepMajor}`,
        `${countryCode}/${currencyCode}/VAT:${vatRateBps}/ROUND:${cashRoundingStepMajor}`
      );
    });

    return this.getFiscalConfig();
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

    const fiscal = this.getFiscalConfig();
    let promptPayId = fiscal.countryCode === 'LA' ? '' : '0105566001234';
    try {
      const configuredPromptPay = this.getVerifiedProtectedStoreConfig('promptpay_merchant_id');
      if (configuredPromptPay) {
        promptPayId = configuredPromptPay;
      } else if (fiscal.countryCode === 'TH' && outletRow?.taxId) {
        promptPayId = String(outletRow.taxId);
      }
    } catch {
      // Fallback if tampered or unset
    }

    return {
      outletId,
      outletCode: String(outletRow?.code ?? 'HQ-01'),
      storeName: String(outletRow?.name ?? 'RUBE Flagship Store & Warehouse'),
      storeAddress: fiscal.storeAddress,
      taxId: String(outletRow?.taxId ?? (fiscal.countryCode === 'LA' ? '' : '0105566001234')),
      branchCode: String(outletRow?.branchCode ?? '00000'),
      rdPosRegNo: String(outletRow?.rdPosRegNo ?? (fiscal.countryCode === 'LA' ? 'LA-POS-0001' : 'RD-POS-2026-001')),
      promptPayId,
      businessProfile: this.getVerifiedBusinessProfileMode(),
      fiscalConfig: fiscal,
    };
  }

  public async updateStoreIdentitySettings(input: {
    outletId?: string | undefined;
    storeName: string;
    storeAddress?: string | undefined;
    taxId: string;
    branchCode: string;
    rdPosRegNo: string;
    promptPayId: string;
    countryCode?: CountryCode | undefined;
    uiLocale?: LocaleCode | undefined;
    receiptLocale?: LocaleCode | undefined;
    vatRateBps?: BasisPoints | undefined;
    defaultTaxMode?: TaxMode | undefined;
    cashRoundingStepMajor?: CashRoundingStepMajor | undefined;
    scalePriceEmbeddedMultiplier?: number | undefined;
    laoQrStaticTemplate?: string | undefined;
    laoQrVerificationPolicy?: LaoQrVerificationPolicy | undefined;
    fxRates?: Partial<FxRatesConfigDto> | undefined;
    updatedByUserId?: string | undefined;
  }): Promise<StoreIdentitySettingsDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const actor = input.updatedByUserId ?? 'USR-OWNER-01';
    const currentFiscal = this.getFiscalConfig();
    const targetCountry = input.countryCode
      ? normalizeCountryCode(input.countryCode)
      : currentFiscal.countryCode;

    const cleanPromptPay = (input.promptPayId ?? '').replace(/\D/g, '');
    if (
      targetCountry === 'TH' &&
      cleanPromptPay.length !== 10 &&
      cleanPromptPay.length !== 13 &&
      cleanPromptPay.length !== 15
    ) {
      throw new Error(
        'PromptPay ID must be 10 digits (Mobile), 13 digits (Tax/Citizen ID), or 15 digits (e-Wallet)'
      );
    }

    if (
      input.countryCode !== undefined ||
      input.uiLocale !== undefined ||
      input.receiptLocale !== undefined ||
      input.vatRateBps !== undefined ||
      input.defaultTaxMode !== undefined ||
      input.cashRoundingStepMajor !== undefined ||
      input.scalePriceEmbeddedMultiplier !== undefined ||
      input.storeAddress !== undefined ||
      input.laoQrStaticTemplate !== undefined ||
      input.laoQrVerificationPolicy !== undefined ||
      input.fxRates !== undefined
    ) {
      await this.updateFiscalConfig({
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.uiLocale !== undefined ? { uiLocale: input.uiLocale } : {}),
        ...(input.receiptLocale !== undefined ? { receiptLocale: input.receiptLocale } : {}),
        ...(input.vatRateBps !== undefined ? { vatRateBps: input.vatRateBps } : {}),
        ...(input.defaultTaxMode !== undefined ? { defaultTaxMode: input.defaultTaxMode } : {}),
        ...(input.cashRoundingStepMajor !== undefined
          ? { cashRoundingStepMajor: input.cashRoundingStepMajor }
          : {}),
        ...(input.scalePriceEmbeddedMultiplier !== undefined
          ? { scalePriceEmbeddedMultiplier: input.scalePriceEmbeddedMultiplier }
          : {}),
        ...(input.storeAddress !== undefined ? { storeAddress: input.storeAddress } : {}),
        ...(input.laoQrStaticTemplate !== undefined
          ? { laoQrStaticTemplate: input.laoQrStaticTemplate }
          : {}),
        ...(input.laoQrVerificationPolicy !== undefined
          ? { laoQrVerificationPolicy: input.laoQrVerificationPolicy }
          : {}),
        ...(input.fxRates !== undefined ? { fxRates: input.fxRates } : {}),
        updatedByUserId: actor,
      });
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

    if (cleanPromptPay) {
      await this.setProtectedStoreConfig({
        key: 'promptpay_merchant_id',
        value: cleanPromptPay,
        updatedByUserId: actor,
      });
    }

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

  public async deleteCategory(categoryId: string): Promise<{ deletedCategoryId: string }> {
    const targetId = categoryId.trim();
    if (!targetId) throw new Error('Category id is required');

    await this.executeWriteImmediate((db) => {
      const deletedIds = this.readDeletedVariantIdSet(db);
      const variantsInCat = db
        .prepare(
          `SELECT v.id FROM item_variants v JOIN items i ON i.id = v.item_id WHERE i.category_id = ?`
        )
        .all(targetId) as Array<{ id: string }>;

      const activeUsingCount = variantsInCat.filter((r) => !deletedIds.has(String(r.id))).length;
      if (activeUsingCount > 0) {
        throw new Error(
          `ไม่สามารถลบหมวดหมู่นี้ได้ เนื่องจากยังมีสินค้าใช้งานอยู่ ${activeUsingCount} รายการ กรุณาย้ายหรือลบสินค้าก่อน`
        );
      }

      // Detach any soft-deleted items referencing this category before deleting
      db.prepare(`UPDATE items SET category_id = NULL WHERE category_id = ?`).run(targetId);
      db.prepare(`DELETE FROM categories WHERE id = ?`).run(targetId);
    });

    return { deletedCategoryId: targetId };
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
      const deletedIds = this.readDeletedVariantIdSet(db);
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

      return rows
        .filter((r) => !deletedIds.has(String(r.id)))
        .map((r) => ({
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
            `TX-OPEN-${variantId}-${randomUUID().slice(0, 8)}`,
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

      if (activeInt === 1) {
        const deletedSet = this.readDeletedVariantIdSet(db);
        if (deletedSet.delete(variantId)) {
          db.prepare(
            `INSERT INTO store_config (key, value, is_protected, updated_by)
             VALUES ('deleted_catalog_variant_ids', ?, 0, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_by = excluded.updated_by,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
          ).run(JSON.stringify(Array.from(deletedSet)), input.performedByUserId ?? 'USR-OWNER-01');
        }
      }
    });

    const reloaded = this.listCatalogVariantsDetailed(outletId).find((v) => v.id === variantId);
    if (!reloaded) {
      throw new Error(`Failed to reload catalog variant ${variantId}`);
    }
    return reloaded;
  }

  /**
   * Deletes a catalog variant safely while strictly preserving SQLite immutable ledger invariants:
   * - If the variant has zero historical ledger/sales/PO references, performs a clean HARD DELETE.
   * - If immutable audit history exists (e.g., opening stock or past receipts), zeros out remaining stock
   *   with a balanced write-off ledger entry, frees its barcode/SKU for immediate reuse, marks inactive,
   *   and registers the variant in `deleted_catalog_variant_ids` so it disappears from all operational views.
   */
  public async deleteCatalogVariant(
    variantId: string,
    performedByUserId = 'USR-OWNER-01'
  ): Promise<{ variantId: string; mode: 'HARD_DELETED' | 'ARCHIVED_SAFE' }> {
    const targetId = variantId.trim();
    if (!targetId) {
      throw new Error('variantId is required');
    }

    let mode: 'HARD_DELETED' | 'ARCHIVED_SAFE' = 'HARD_DELETED';

    await this.executeWriteImmediate((db) => {
      const existing = db
        .prepare(`SELECT id, item_id AS itemId, sku FROM item_variants WHERE id = ?`)
        .get(targetId) as { id: string; itemId: string; sku: string } | undefined;

      if (!existing) {
        throw new Error(`ไม่พบสินค้าที่ต้องการลบ (${targetId})`);
      }

      const inTransitRow = db
        .prepare(
          `SELECT count(*) AS cnt
           FROM transfer_orders tr
           JOIN transfer_order_items toi ON toi.transfer_order_id = tr.id
           WHERE toi.variant_id = ? AND tr.status IN ('PENDING', 'IN_TRANSIT')`
        )
        .get(targetId) as { cnt?: number } | undefined;
      if (Number(inTransitRow?.cnt ?? 0) > 0) {
        throw new Error('HTTP 409 ไม่สามารถลบสินค้าที่มีใบโอนสาขากำลังรอรับเข้า (IN_TRANSIT)');
      }

      // Detach BOM graph edges and modifier links
      db.prepare(
        `DELETE FROM item_components WHERE composite_variant_id = ? OR component_variant_id = ?`
      ).run(targetId, targetId);
      db.prepare(
        `UPDATE modifiers SET component_variant_id = NULL WHERE component_variant_id = ?`
      ).run(targetId);

      const countRef = (sql: string): number => {
        const row = db.prepare(sql).get(targetId) as { cnt?: number } | undefined;
        return Number(row?.cnt ?? 0);
      };

      const totalRefs =
        countRef(`SELECT count(*) AS cnt FROM inventory_transactions WHERE variant_id = ?`) +
        countRef(`SELECT count(*) AS cnt FROM sales_order_items WHERE variant_id = ?`) +
        countRef(`SELECT count(*) AS cnt FROM purchase_order_items WHERE variant_id = ?`) +
        countRef(`SELECT count(*) AS cnt FROM transfer_order_items WHERE variant_id = ?`) +
        countRef(`SELECT count(*) AS cnt FROM inventory_count_items WHERE variant_id = ?`) +
        countRef(`SELECT count(*) AS cnt FROM stock_adjustment_items WHERE variant_id = ?`);

      if (totalRefs === 0) {
        mode = 'HARD_DELETED';
        db.prepare(`DELETE FROM inventory_levels WHERE variant_id = ?`).run(targetId);
        db.prepare(`DELETE FROM item_variants WHERE id = ?`).run(targetId);

        const siblingCount = Number(
          (
            db
              .prepare(`SELECT count(*) AS cnt FROM item_variants WHERE item_id = ?`)
              .get(existing.itemId) as { cnt?: number } | undefined
          )?.cnt ?? 0
        );
        if (siblingCount === 0) {
          db.prepare(`DELETE FROM item_modifier_groups WHERE item_id = ?`).run(existing.itemId);
          db.prepare(`DELETE FROM items WHERE id = ?`).run(existing.itemId);
        }
      } else {
        mode = 'ARCHIVED_SAFE';
        // Write balanced zero-out ledger entries so Ledger Conservation Invariant stays 100% valid
        const levels = db
          .prepare(
            `SELECT outlet_id AS outletId, in_stock_milli AS inStockMilli, average_cost_micro_baht AS mac
             FROM inventory_levels WHERE variant_id = ?`
          )
          .all(targetId) as Array<{ outletId: string; inStockMilli: number; mac: number }>;

        for (const lvl of levels) {
          const curStock = Number(lvl.inStockMilli);
          if (curStock !== 0) {
            const delta = -curStock;
            db.prepare(
              `INSERT INTO inventory_transactions (
                 id, outlet_id, variant_id, transaction_type, quantity_change_milli,
                 stock_before_milli, stock_after_milli, unit_cost_micro_baht,
                 reference_type, reference_id, performed_by
               ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, 0, ?, 'CATALOG_DELETE_WRITEOFF', ?, ?)`
            ).run(
              `TX-DEL-${targetId}-${lvl.outletId}-${randomUUID().slice(0, 8)}`,
              lvl.outletId,
              targetId,
              delta,
              curStock,
              Number(lvl.mac),
              targetId,
              performedByUserId
            );

            db.prepare(
              `UPDATE inventory_levels
               SET in_stock_milli = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE outlet_id = ? AND variant_id = ?`
            ).run(lvl.outletId, targetId);
          }
        }

        // Release barcode & SKU so user can immediately scan/re-create a fresh product with the same barcode
        const archivedSku = `${existing.sku}__DEL_${randomUUID().slice(0, 8)}`;
        db.prepare(
          `UPDATE item_variants SET active = 0, barcode = NULL, sku = ? WHERE id = ?`
        ).run(archivedSku, targetId);

        const deletedSet = this.readDeletedVariantIdSet(db);
        deletedSet.add(targetId);
        db.prepare(
          `INSERT INTO store_config (key, value, is_protected, updated_by)
           VALUES ('deleted_catalog_variant_ids', ?, 0, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        ).run(JSON.stringify(Array.from(deletedSet)), performedByUserId);

        const activeSiblings = (
          db
            .prepare(`SELECT id FROM item_variants WHERE item_id = ? AND active = 1`)
            .all(existing.itemId) as Array<{ id: string }>
        ).filter((r) => !deletedSet.has(String(r.id)));
        if (activeSiblings.length === 0) {
          db.prepare(`UPDATE items SET active = 0 WHERE id = ?`).run(existing.itemId);
        }
      }

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('CATALOG_VARIANT_DELETED', ?, 'POS-TERM-01', ?, ?, ?)`
      ).run(performedByUserId, targetId, existing.sku, mode);
    });

    return { variantId: targetId, mode };
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
           WHERE so.outlet_id = ? AND so.status != 'OPEN'
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
      const fxAuditStmt = db.prepare(
        `SELECT new_value_redacted AS fxJson
         FROM security_audit_logs
         WHERE event_type = 'FX_CASH_TENDER' AND target_key = ?
         ORDER BY id DESC LIMIT 1`
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

        const fxRow = fxAuditStmt.get(orderId) as { fxJson?: string } | undefined;
        let fxTender: FxCashTenderDetailDto | null = null;
        if (fxRow?.fxJson) {
          try {
            fxTender = JSON.parse(fxRow.fxJson) as FxCashTenderDetailDto;
          } catch {
            fxTender = null;
          }
        }

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
          fxTender,
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

  private seedLaoDemoCatalogOnDb(db: DatabaseSync, outletId: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO categories (id, name, display_color, kitchen_station, sort_order)
       VALUES
         ('CAT-RETAIL', 'ສິນຄ້າຂາຍຍ່ອຍ & ອາຫານສົດ', '#1a73e8', 'NONE', 1),
         ('CAT-CAFE', 'ກາເຟ & ເຄື່ອງດື່ມຄາເຟ່', '#1a73e8', 'BAR', 2),
         ('CAT-RAW', 'ວັດຖຸດິບຫຼັງຮ້ານ', '#5f6368', 'PREP', 3)`
    ).run();

    db.prepare(
      `INSERT OR IGNORE INTO suppliers (id, code, name, tax_id, phone)
       VALUES ('SUP-001', 'SUP-LAO-GEN', 'ຜູ້ສະໜອງສິນຄ້າທົ່ວໄປ (Vientiane Wholesale)', '123456789012', '020-5555-8888')`
    ).run();

    const insertItem = db.prepare(
      `INSERT OR IGNORE INTO items (id, name, category_id, unit_name, track_stock, is_composite, use_production, is_weighted_scale)
       VALUES (?, ?, ?, ?, 1, ?, 0, ?)`
    );
    const insertVar = db.prepare(
      `INSERT OR IGNORE INTO item_variants (id, item_id, sku, barcode, variant_name, price_satang, default_purchase_cost_micro_baht)
       VALUES (?, ?, ?, ?, 'Standard', ?, ?)`
    );
    const insertLvl = db.prepare(
      `INSERT OR IGNORE INTO inventory_levels (id, outlet_id, variant_id, in_stock_milli, average_cost_micro_baht, optimal_stock_milli, low_stock_threshold_milli)
       VALUES (?, ?, ?, ?, ?, 50000, 10000)`
    );
    const insertTx = db.prepare(
      `INSERT OR IGNORE INTO inventory_transactions (
         id, outlet_id, variant_id, transaction_type, quantity_change_milli,
         stock_before_milli, stock_after_milli, unit_cost_micro_baht,
         reference_type, reference_id, performed_by
       ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, 0, ?, ?, 'DEMO_SEED', 'LAO-SEED-INIT', 'USR-OWNER-01')`
    );

    const demoProducts: Array<{
      itemId: string;
      varId: string;
      name: string;
      catId: string;
      unit: string;
      sku: string;
      barcode: string | null;
      priceLak: number;
      costLak: number;
      stockMilli: number;
      isWeighted: number;
    }> = [
      {
        itemId: 'ITM-LA-WATER',
        varId: 'VAR-LA-WATER',
        name: 'ນ້ຳດື່ມ 600ml (Water 600ml)',
        catId: 'CAT-RETAIL',
        unit: 'ຂວດ',
        sku: 'LA-RET-001',
        barcode: '8850123456789',
        priceLak: 8_000,
        costLak: 4_500,
        stockMilli: 100_000,
        isWeighted: 0,
      },
      {
        itemId: 'ITM-LA-BEER',
        varId: 'VAR-LA-BEER',
        name: 'ເບຍລາວ 640ml (Beerlao Lager)',
        catId: 'CAT-RETAIL',
        unit: 'ຂວດ',
        sku: 'LA-RET-002',
        barcode: '8851234000012',
        priceLak: 25_000,
        costLak: 18_000,
        stockMilli: 60_000,
        isWeighted: 0,
      },
      {
        itemId: 'ITM-LA-PORK',
        varId: 'VAR-LA-PORK',
        name: 'ຊີ້ນໝູສາມຊັ້ນສົດ (Fresh Pork Belly)',
        catId: 'CAT-RETAIL',
        unit: 'ກກ.',
        sku: '00123',
        barcode: null,
        priceLak: 120_000,
        costLak: 95_000,
        stockMilli: 25_000,
        isWeighted: 1,
      },
      {
        itemId: 'ITM-LA-COFFEE',
        varId: 'VAR-LA-COFFEE',
        name: 'ກາເຟເຢັນລາວ (Iced Lao Coffee)',
        catId: 'CAT-CAFE',
        unit: 'ຈອກ',
        sku: 'LA-CAF-001',
        barcode: null,
        priceLak: 35_000,
        costLak: 12_000,
        stockMilli: 80_000,
        isWeighted: 0,
      },
      {
        itemId: 'ITM-LA-MILKTEA',
        varId: 'VAR-LA-MILKTEA',
        name: 'ຊານົມໄຂ່ມຸກ (Brown Sugar Milk Tea)',
        catId: 'CAT-CAFE',
        unit: 'ຈອກ',
        sku: 'LA-CAF-002',
        barcode: null,
        priceLak: 40_000,
        costLak: 15_000,
        stockMilli: 80_000,
        isWeighted: 0,
      },
    ];

    for (const p of demoProducts) {
      const priceMinor = p.priceLak * 100;
      const costMicro = p.costLak * 1_000_000;
      insertItem.run(p.itemId, p.name, p.catId, p.unit, 0, p.isWeighted);
      insertVar.run(p.varId, p.itemId, p.sku, p.barcode, priceMinor, costMicro);
      insertLvl.run(`INV-${outletId}-${p.varId}`, outletId, p.varId, p.stockMilli, costMicro);
      insertTx.run(
        `TX-SEED-${p.varId}`,
        outletId,
        p.varId,
        p.stockMilli,
        p.stockMilli,
        costMicro
      );
    }
  }

  /**
   * Production Clean-Start First-Run Onboarding:
   * Sets up a customer terminal from an empty database WITHOUT demo clutter (unless `loadDemoSampleCatalog` is explicitly opted in),
   * hashes the Owner's real master PIN, signs `business_profile` + country fiscal settings + QR payment ID with HMAC-SHA256,
   * and opens the initial cashier shift.
   */
  public async initializeFirstRunOnboarding(input: FirstRunOnboardingInput): Promise<{
    ownerUser: StaffUserDto;
    activeShift: PosShiftDto;
    storeSettings: StoreIdentitySettingsDto;
  }> {
    const outletId = 'OUTLET-HQ';
    const countryCode = normalizeCountryCode(input.countryCode);
    const countryDefaults = getDefaultFiscalConfigForCountry(countryCode);
    const currencyCode = countryDefaults.currencyCode;
    const uiLocale = normalizeLocaleCode(input.uiLocale, countryDefaults.uiLocale);
    const receiptLocale = normalizeLocaleCode(input.receiptLocale, countryDefaults.receiptLocale);
    const vatRateBps =
      input.vatRateBps !== undefined
        ? Math.max(0, Math.min(5000, Math.round(Number(input.vatRateBps))))
        : countryDefaults.vatRateBps;
    const defaultTaxMode: TaxMode =
      input.defaultTaxMode === 'NONE' ||
      input.defaultTaxMode === 'INCLUSIVE' ||
      input.defaultTaxMode === 'EXCLUSIVE'
        ? input.defaultTaxMode
        : vatRateBps === 0
          ? 'NONE'
          : countryDefaults.defaultTaxMode;
    const cashRoundingStepMajor =
      currencyCode === 'LAK'
        ? normalizeCashRoundingStepMajor(input.cashRoundingStepMajor)
        : 0;
    const scalePriceEmbeddedMultiplier = normalizeScalePriceEmbeddedMultiplier(
      input.scalePriceEmbeddedMultiplier,
      countryCode
    );
    const storeAddress = (input.storeAddress ?? '').trim();
    const laoQrStaticTemplate =
      countryCode === 'LA'
        ? this.assertValidLaoQrStaticTemplateIfNonEmpty(input.laoQrStaticTemplate ?? '')
        : '';
    const laoQrVerificationPolicy = normalizeLaoQrVerificationPolicy(input.laoQrVerificationPolicy);
    const fxRates = normalizeFxRatesConfig(input.fxRates, countryCode);

    const cleanPromptPay = (input.promptPayId ?? '').replace(/\D/g, '');
    if (
      countryCode === 'TH' &&
      cleanPromptPay.length !== 10 &&
      cleanPromptPay.length !== 13 &&
      cleanPromptPay.length !== 15
    ) {
      throw new Error('PromptPay ID must be 10, 13, or 15 digits');
    }
    if (
      input.businessProfile !== 'RETAIL' &&
      input.businessProfile !== 'HOSPITALITY' &&
      input.businessProfile !== 'HYBRID'
    ) {
      throw new Error(`Invalid BusinessProfile mode: ${String(input.businessProfile)}`);
    }

    // Precompute scrypt PIN hash and HMAC signatures outside the writer transaction
    const ownerPinHash = this.hashStaffPin(input.ownerPin);
    const protectedEntries: Array<[string, string]> = [
      ['business_profile', input.businessProfile],
      ['country_code', countryCode],
      ['currency_code', currencyCode],
      ['vat_rate_bps', String(vatRateBps)],
      ['default_tax_mode', defaultTaxMode],
      ['cash_rounding_step_major', String(cashRoundingStepMajor)],
      ['scale_price_embedded_multiplier', String(scalePriceEmbeddedMultiplier)],
      ['lao_qr_static_template', laoQrStaticTemplate],
      ['lao_qr_verification_policy', laoQrVerificationPolicy],
      ['fx_rates_json', JSON.stringify(fxRates)],
      ...(cleanPromptPay ? ([['promptpay_merchant_id', cleanPromptPay]] as Array<[string, string]>) : []),
    ];
    const signedEntries = protectedEntries.map(([key, value]) => ({
      key,
      value,
      hmac: this.computeProtectedConfigHmacHex(key, value),
    }));
    const openingCashSatang = Math.max(0, input.openingCashSatang);

    const activeShift = await this.executeWriteImmediate((db) => {
      if (input.loadDemoSampleCatalog && countryCode === 'TH') {
        this.seedDefaultWarehouseAndCatalogOnDb(db, outletId);
      }

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
        input.rdPosRegNo.trim() || (countryCode === 'LA' ? 'LA-POS-0001' : 'RD-POS-0001')
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
        input.ownerDisplayName.trim() || (countryCode === 'LA' ? 'ເຈົ້າຂອງຮ້ານ (Owner)' : 'เจ้าของร้าน'),
        ownerPinHash
      );

      if (input.loadDemoSampleCatalog && countryCode === 'LA') {
        this.seedLaoDemoCatalogOnDb(db, outletId);
      } else {
        // Ensure baseline categories & default general supplier exist even on Clean Production Start
        if (countryCode === 'LA') {
          db.prepare(
            `INSERT OR IGNORE INTO categories (id, name, display_color, kitchen_station, sort_order)
             VALUES
               ('CAT-RETAIL', 'ສິນຄ້າທົ່ວໄປ & ຂາຍຍ່ອຍ', '#1a73e8', 'NONE', 1),
               ('CAT-CAFE', 'ເຄື່ອງດື່ມ & ອາຫານ', '#1a73e8', 'BAR', 2),
               ('CAT-RAW', 'ວັດຖຸດິບຫຼັງຮ້ານ', '#5f6368', 'PREP', 3)`
          ).run();

          db.prepare(
            `INSERT OR IGNORE INTO suppliers (id, code, name)
             VALUES ('SUP-001', 'SUP-GENERAL', 'ຜູ້ສະໜອງສິນຄ້າທົ່ວໄປ (General Supplier)')`
          ).run();
        } else {
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
        }
      }

      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by)
         VALUES ('first_run_onboarded', '1', 0, 'USR-OWNER-01')
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_by = 'USR-OWNER-01'`
      ).run();

      const upsertPlain = db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
         VALUES (?, ?, 0, 'USR-OWNER-01', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );
      upsertPlain.run('ui_locale', uiLocale);
      upsertPlain.run('receipt_locale', receiptLocale);
      upsertPlain.run('store_address', storeAddress);

      for (const entry of signedEntries) {
        this.upsertProtectedStoreConfigOnDb(db, {
          key: entry.key,
          value: entry.value,
          hmacSignatureHex: entry.hmac,
          updatedByUserId: 'USR-OWNER-01',
        });
      }

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('FIRST_RUN_ONBOARDING_COMPLETED', 'USR-OWNER-01', 'POS-TERM-01', 'SYSTEM_BOOTSTRAP', NULL, ?)`
      ).run(
        `country=${countryCode}:currency=${currencyCode}:vat=${vatRateBps}:profile=${input.businessProfile}:cleanStart=${!input.loadDemoSampleCatalog}`
      );

      const existingOpenShift = db
        .prepare(
          `SELECT
             id, shift_number AS shiftNumber, outlet_id AS outletId, terminal_id AS terminalId,
             opened_by AS openedBy, status, opening_cash_satang AS openingCashSatang,
             expected_cash_satang AS expectedCashSatang, counted_cash_satang AS countedCashSatang,
             cash_variance_satang AS cashVarianceSatang, opened_at AS openedAt
           FROM pos_shifts
           WHERE outlet_id = ? AND terminal_id = 'POS-TERM-01' AND status = 'OPEN'
           ORDER BY opened_at DESC LIMIT 1`
        )
        .get(outletId) as Record<string, unknown> | undefined;

      if (existingOpenShift) {
        return {
          id: String(existingOpenShift.id),
          shiftNumber: String(existingOpenShift.shiftNumber),
          outletId: String(existingOpenShift.outletId),
          terminalId: String(existingOpenShift.terminalId),
          openedBy: String(existingOpenShift.openedBy),
          status: String(existingOpenShift.status) as 'OPEN' | 'CLOSED',
          openingCashSatang: Number(existingOpenShift.openingCashSatang),
          expectedCashSatang: Number(existingOpenShift.expectedCashSatang),
          countedCashSatang:
            existingOpenShift.countedCashSatang === null
              ? null
              : Number(existingOpenShift.countedCashSatang),
          cashVarianceSatang:
            existingOpenShift.cashVarianceSatang === null
              ? null
              : Number(existingOpenShift.cashVarianceSatang),
          openedAt: String(existingOpenShift.openedAt),
        } satisfies PosShiftDto;
      }

      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const checkDupShift = db.prepare(`SELECT 1 FROM pos_shifts WHERE shift_number = ? LIMIT 1`);
      let shiftSeq = 1;
      let shiftNumber = '';
      while (true) {
        shiftNumber = `SHF-${dateStr}-${String(shiftSeq).padStart(3, '0')}`;
        if (!checkDupShift.get(shiftNumber)) {
          break;
        }
        shiftSeq += 1;
      }

      return this.insertOpenPosShiftOnDb(db, {
        outletId,
        terminalId: 'POS-TERM-01',
        shiftNumber,
        openedByUserId: 'USR-OWNER-01',
        openingCashSatang,
        notes: 'Initial shift opened via First-Run Setup Wizard',
      });
    });

    const ownerUser = this.listStaffUsers().find((u) => u.id === 'USR-OWNER-01')!;
    return {
      ownerUser,
      activeShift,
      storeSettings: this.getStoreIdentitySettings(outletId),
    };
  }

  // ============================================================================
  // Local QR Table Ordering & Captive Portal Engine (Zero-Schema, HMAC-Protected)
  // ============================================================================

  private getQrOrderingConfigOnDb(db: DatabaseSync): QrOrderingConfigDto {
    const rawJson = this.readRawStoreConfigOnDb(db, 'qr_ordering_config');
    if (!rawJson) {
      return normalizeQrOrderingConfig(null);
    }
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      return normalizeQrOrderingConfig(parsed);
    } catch {
      return normalizeQrOrderingConfig(null);
    }
  }

  public getQrOrderingConfig(): QrOrderingConfigDto {
    return this.executeRead((db) => this.getQrOrderingConfigOnDb(db));
  }

  public async updateQrOrderingConfig(
    input: Partial<QrOrderingConfigDto> & { updatedByUserId?: string | undefined }
  ): Promise<QrOrderingConfigDto> {
    const actor = input.updatedByUserId ?? 'USR-OWNER-01';
    const current = this.getQrOrderingConfig();
    const merged = normalizeQrOrderingConfig({
      ...current,
      ...input,
    });
    const serialized = JSON.stringify(merged);
    const hmacSignatureHex = this.computeProtectedConfigHmacHex('qr_ordering_config', serialized);

    await this.executeWriteImmediate((db) => {
      this.upsertProtectedStoreConfigOnDb(db, {
        key: 'qr_ordering_config',
        value: serialized,
        hmacSignatureHex,
        updatedByUserId: actor,
      });
      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('QR_ORDERING_CONFIG_UPDATED', ?, 'POS-TERM-01', 'qr_ordering_config', ?, ?)`
      ).run(
        actor,
        `enabled=${current.enabled}:port=${current.port}:mode=${current.approvalMode}:nfc=${Boolean(current.nfcEnabled)}`,
        `enabled=${merged.enabled}:port=${merged.port}:mode=${merged.approvalMode}:nfc=${Boolean(merged.nfcEnabled)}:ssid=${merged.wifiSsid || '-'}:tables=${merged.tableLabels.length}`
      );
    });

    return merged;
  }

  private computeTableQrToken(outletId: string, tableLabel: string, sessionNonce: string): string {
    const sig = createHmac('sha256', Buffer.from(this.rawHexKey64, 'utf8'))
      .update(
        `RUBE-QR-TABLE-V1:${outletId}:${tableLabel.trim().toUpperCase()}:${sessionNonce}`,
        'utf8'
      )
      .digest('hex')
      .slice(0, 24);
    return `${sessionNonce}.${sig}`;
  }

  private readTableSessionsMapOnDb(
    db: DatabaseSync,
    outletId: string
  ): Record<
    string,
    { tableLabel: string; sessionNonce: string; openedByName: string; openedAtIso: string }
  > {
    const key = `qr_table_sessions_${outletId}`;
    const row = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    if (!row?.value) return {};
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<
          string,
          { tableLabel: string; sessionNonce: string; openedByName: string; openedAtIso: string }
        >;
      }
    } catch {
      // ignore corrupted fallback
    }
    return {};
  }

  private writeTableSessionsMapOnDb(
    db: DatabaseSync,
    outletId: string,
    map: Record<
      string,
      { tableLabel: string; sessionNonce: string; openedByName: string; openedAtIso: string }
    >,
    actorUserId: string
  ): void {
    const key = `qr_table_sessions_${outletId}`;
    db.prepare(
      `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
       VALUES (?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(key, JSON.stringify(map), actorUserId);
  }

  public async openTableQrSession(input: {
    outletId?: string | undefined;
    tableLabel: string;
    openedByName?: string | undefined;
    baseUrl?: string | undefined;
    actorUserId?: string | undefined;
  }): Promise<TableQrSessionDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const cleanTable = sanitizeGuestText(input.tableLabel, 24);
    if (!cleanTable) {
      throw new Error('HTTP 400 กรุณาระบุหมายเลขโต๊ะสำหรับสร้าง QR Session');
    }
    const actor = input.actorUserId ?? 'USR-CASHIER-01';
    const openedByName = sanitizeGuestText(input.openedByName ?? 'Staff', 60) || 'Staff';
    const sessionNonce = randomBytes(8).toString('hex');
    const openedAtIso = new Date().toISOString();

    const cfg = await this.executeWriteImmediate((db) => {
      const qrCfg = this.getQrOrderingConfigOnDb(db);
      const map = this.readTableSessionsMapOnDb(db, outletId);
      const mapKey = cleanTable.toUpperCase();
      map[mapKey] = {
        tableLabel: cleanTable,
        sessionNonce,
        openedByName,
        openedAtIso,
      };
      this.writeTableSessionsMapOnDb(db, outletId, map, actor);
      return qrCfg;
    });

    const token = this.computeTableQrToken(outletId, cleanTable, sessionNonce);
    const effectiveBase = (input.baseUrl ?? `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, '');
    return {
      outletId,
      tableLabel: cleanTable,
      sessionNonce,
      token,
      menuUrl: buildTableMenuUrl(effectiveBase, cleanTable, token, outletId),
      nfcMenuUrl: buildTableNfcUrl(effectiveBase, cleanTable, token, outletId),
      wifiQrPayload: buildWifiQrPayload(cfg.wifiSsid, cfg.wifiPassword, cfg.wifiSecurity),
      openedByName,
      openedAtIso,
    };
  }

  public listTableQrSessions(
    outletId = 'OUTLET-HQ',
    baseUrl?: string | undefined
  ): TableQrSessionDto[] {
    return this.executeRead((db) => {
      const cfg = this.getQrOrderingConfigOnDb(db);
      const map = this.readTableSessionsMapOnDb(db, outletId);
      const effectiveBase = (baseUrl ?? `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, '');
      const wifiQrPayload = buildWifiQrPayload(cfg.wifiSsid, cfg.wifiPassword, cfg.wifiSecurity);
      return Object.values(map)
        .map((entry) => {
          const token = this.computeTableQrToken(outletId, entry.tableLabel, entry.sessionNonce);
          return {
            outletId,
            tableLabel: entry.tableLabel,
            sessionNonce: entry.sessionNonce,
            token,
            menuUrl: buildTableMenuUrl(effectiveBase, entry.tableLabel, token, outletId),
            nfcMenuUrl: buildTableNfcUrl(effectiveBase, entry.tableLabel, token, outletId),
            wifiQrPayload,
            openedByName: entry.openedByName,
            openedAtIso: entry.openedAtIso,
          } satisfies TableQrSessionDto;
        })
        .sort((a, b) => a.tableLabel.localeCompare(b.tableLabel));
    });
  }

  public async revokeTableQrSession(input: {
    outletId?: string | undefined;
    tableLabel: string;
    actorUserId?: string | undefined;
  }): Promise<{ revoked: boolean; tableLabel: string }> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const cleanTable = sanitizeGuestText(input.tableLabel, 24);
    if (!cleanTable) {
      return { revoked: false, tableLabel: '' };
    }
    const actor = input.actorUserId ?? 'USR-CASHIER-01';
    const revoked = await this.executeWriteImmediate((db) => {
      const map = this.readTableSessionsMapOnDb(db, outletId);
      const mapKey = cleanTable.toUpperCase();
      if (!(mapKey in map)) {
        return false;
      }
      delete map[mapKey];
      this.writeTableSessionsMapOnDb(db, outletId, map, actor);
      return true;
    });
    return { revoked, tableLabel: cleanTable };
  }

  private verifyTableQrTokenOnDb(
    db: DatabaseSync,
    outletId: string,
    tableLabel: string,
    rawToken: string
  ): { valid: boolean; expired: boolean; sessionNonce: string | null } {
    const cleanTable = sanitizeGuestText(tableLabel, 24);
    const cleanToken = rawToken.trim();
    if (!cleanTable || !cleanToken) {
      return { valid: false, expired: false, sessionNonce: null };
    }
    const parts = cleanToken.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { valid: false, expired: true, sessionNonce: null };
    }
    const [nonce] = parts;
    const expectedToken = this.computeTableQrToken(outletId, cleanTable, nonce);
    const a = Buffer.from(cleanToken, 'utf8');
    const b = Buffer.from(expectedToken, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, expired: true, sessionNonce: null };
    }
    const map = this.readTableSessionsMapOnDb(db, outletId);
    const activeSession = map[cleanTable.toUpperCase()];
    if (!activeSession || activeSession.sessionNonce !== nonce) {
      return { valid: false, expired: true, sessionNonce: null };
    }
    return { valid: true, expired: false, sessionNonce: nonce };
  }

  public verifyTableQrToken(
    outletId: string,
    tableLabel: string,
    rawToken: string
  ): { valid: boolean; expired: boolean; sessionNonce: string | null } {
    return this.executeRead((db) =>
      this.verifyTableQrTokenOnDb(db, outletId, tableLabel, rawToken)
    );
  }

  private readGuestOrdersOnDb(db: DatabaseSync, outletId: string): GuestOrderRecordDto[] {
    const key = `qr_guest_orders_${outletId}`;
    const row = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return Array.isArray(parsed) ? (parsed as GuestOrderRecordDto[]) : [];
    } catch {
      return [];
    }
  }

  private writeGuestOrdersOnDb(
    db: DatabaseSync,
    outletId: string,
    orders: GuestOrderRecordDto[],
    actorUserId: string
  ): void {
    const key = `qr_guest_orders_${outletId}`;
    const trimmed = orders.slice(0, 200);
    db.prepare(
      `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
       VALUES (?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(key, JSON.stringify(trimmed), actorUserId);
  }

  private hydrateGuestOrderKdsStatusOnDb(
    db: DatabaseSync,
    order: GuestOrderRecordDto
  ): GuestOrderRecordDto {
    if (order.settledAtIso && order.status !== 'REJECTED') {
      return { ...order, status: 'SETTLED' };
    }
    if (
      !order.kdsSalesOrderId ||
      order.status === 'PENDING_CONFIRM' ||
      order.status === 'REJECTED'
    ) {
      return order;
    }
    const rows = db
      .prepare(
        `SELECT status FROM kitchen_orders WHERE sales_order_id = ? AND status != 'CANCELLED'`
      )
      .all(order.kdsSalesOrderId) as Array<{ status?: unknown }>;
    if (rows.length === 0) {
      return order;
    }
    const statuses = rows.map((r) => String(r.status ?? 'QUEUED'));
    let derived: QrGuestOrderStatus = 'ACCEPTED';
    if (statuses.every((s) => s === 'SERVED')) {
      derived = 'SERVED';
    } else if (statuses.every((s) => s === 'READY' || s === 'SERVED')) {
      derived = 'READY';
    } else if (statuses.some((s) => s === 'PREPARING' || s === 'READY' || s === 'SERVED')) {
      derived = 'PREPARING';
    } else {
      derived = 'ACCEPTED';
    }
    return derived === order.status ? order : { ...order, status: derived };
  }

  private readHeldBillsOnDb(db: DatabaseSync, outletId: string): HeldBillRecordDto[] {
    const cfgKey = `held_bills_${outletId}`;
    const row = db
      .prepare(`SELECT value, is_protected, hmac_signature_hex FROM store_config WHERE key = ?`)
      .get(cfgKey) as
      | { value?: string; is_protected?: number; hmac_signature_hex?: string | null }
      | undefined;
    if (!row?.value) {
      return [];
    }
    if (Number(row.is_protected ?? 0) === 1) {
      if (!row.hmac_signature_hex) {
        throw new Error(`Security Tamper Alert: Missing HMAC-SHA256 signature on '${cfgKey}'`);
      }
      const expectedHex = this.computeProtectedConfigHmacHex(cfgKey, row.value);
      const actualBuf = Buffer.from(row.hmac_signature_hex, 'hex');
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      if (
        actualBuf.length === 0 ||
        actualBuf.length !== expectedBuf.length ||
        !timingSafeEqual(actualBuf, expectedBuf)
      ) {
        throw new Error(
          `Security Tamper Alert: Held bills HMAC-SHA256 verification failed for '${cfgKey}'`
        );
      }
    }
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return Array.isArray(parsed) ? (parsed as HeldBillRecordDto[]) : [];
    } catch {
      return [];
    }
  }

  private writeHeldBillsOnDb(
    db: DatabaseSync,
    outletId: string,
    bills: HeldBillRecordDto[],
    actorUserId: string
  ): void {
    const cfgKey = `held_bills_${outletId}`;
    const trimmed = bills.slice(0, 100);
    const serialized = JSON.stringify(trimmed);
    const hmacHex = this.computeProtectedConfigHmacHex(cfgKey, serialized);
    db.prepare(
      `INSERT INTO store_config (key, value, is_protected, hmac_signature_hex, updated_by, updated_at)
       VALUES (?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         is_protected = 1,
         hmac_signature_hex = excluded.hmac_signature_hex,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(cfgKey, serialized, hmacHex, actorUserId);
  }

  private buildHeldLineSignature(line: {
    variantId: string;
    selectedModifierIds?: readonly string[] | undefined;
    overrideLineTotalSatang?: number | undefined;
  }): string {
    const sortedMods = [...(line.selectedModifierIds ?? [])].map((x) => String(x)).sort();
    const ov =
      typeof line.overrideLineTotalSatang === 'number' &&
      Number.isSafeInteger(line.overrideLineTotalSatang) &&
      line.overrideLineTotalSatang >= 0
        ? String(line.overrideLineTotalSatang)
        : '';
    return `${String(line.variantId)}::${sortedMods.join(',')}::${ov}`;
  }

  private normalizeHeldCartLine(
    raw: Partial<HeldBillCartLineDto> | Record<string, unknown>,
    billId: string,
    lockAll: boolean,
    preserveShrinkFrom?: HeldBillCartLineDto | null
  ): HeldBillCartLineDto {
    const variantId = sanitizeGuestText(String(raw.variantId ?? ''), 80);
    const selectedMods = Array.isArray(raw.selectedModifierIds)
      ? raw.selectedModifierIds.map((id) => sanitizeGuestText(String(id), 80)).filter(Boolean).sort()
      : [];
    const quantityMilli = Math.max(1, Math.floor(Number(raw.quantityMilli ?? 1_000)));
    const unitPriceSatang = Math.max(0, Math.floor(Number(raw.unitPriceSatang ?? 0)));
    const overrideLineTotalSatang =
      typeof raw.overrideLineTotalSatang === 'number' &&
      Number.isSafeInteger(raw.overrideLineTotalSatang) &&
      raw.overrideLineTotalSatang >= 0
        ? raw.overrideLineTotalSatang
        : undefined;
    const isKds = raw.kdsDispatched === true;
    const locked = lockAll ? true : Boolean(raw.heldLineLocked || isKds);
    const rawLockedMin =
      typeof raw.lockedMinQtyMilli === 'number' &&
      Number.isSafeInteger(raw.lockedMinQtyMilli) &&
      raw.lockedMinQtyMilli > 0
        ? raw.lockedMinQtyMilli
        : 0;
    const prevMin = preserveShrinkFrom
      ? Math.max(0, Number(preserveShrinkFrom.lockedMinQtyMilli ?? preserveShrinkFrom.quantityMilli))
      : 0;
    const lockedMinQtyMilli = locked
      ? Math.max(quantityMilli, rawLockedMin, prevMin)
      : undefined;

    const rawCartKey = sanitizeGuestText(String(raw.cartKey ?? ''), 180);
    const defaultCartKey = `${variantId}::${selectedMods.join(',')}`;
    const guestNote =
      typeof raw.guestNote === 'string' && raw.guestNote.trim()
        ? sanitizeGuestText(raw.guestNote, 160)
        : undefined;
    const scaleBadgeText =
      typeof raw.scaleBadgeText === 'string' && raw.scaleBadgeText.trim()
        ? sanitizeGuestText(raw.scaleBadgeText, 80)
        : undefined;

    return {
      cartKey: rawCartKey || defaultCartKey,
      variantId,
      itemName: sanitizeGuestText(String(raw.itemName ?? variantId), 120) || variantId,
      variantName: sanitizeGuestText(String(raw.variantName ?? ''), 80),
      sku: sanitizeGuestText(String(raw.sku ?? ''), 64),
      unitName: sanitizeGuestText(String(raw.unitName ?? 'ชิ้น'), 32) || 'ชิ้น',
      quantityMilli,
      unitPriceSatang,
      ...(overrideLineTotalSatang !== undefined ? { overrideLineTotalSatang } : {}),
      selectedModifierIds: selectedMods,
      isWeightedScale: Boolean(raw.isWeightedScale),
      ...(scaleBadgeText !== undefined ? { scaleBadgeText } : {}),
      ...(isKds ? { kdsDispatched: true } : {}),
      ...(guestNote !== undefined ? { guestNote } : {}),
      ...(locked ? { heldLineLocked: true } : {}),
      ...(lockedMinQtyMilli !== undefined ? { lockedMinQtyMilli } : {}),
      heldBillOriginId:
        typeof raw.heldBillOriginId === 'string' && raw.heldBillOriginId.trim()
          ? raw.heldBillOriginId.trim()
          : billId,
    };
  }

  private findHeldBillLineDeficits(
    committedCart: ReadonlyArray<HeldBillCartLineDto>,
    incomingLines: ReadonlyArray<{
      variantId: string;
      quantityMilli: number;
      unitPriceSatang: number;
      overrideLineTotalSatang?: number | undefined;
      selectedModifierIds?: readonly string[] | undefined;
      heldLineLocked?: boolean | undefined;
      lockedMinQtyMilli?: number | undefined;
      itemName?: string | undefined;
    }>
  ): string[] {
    if (!Array.isArray(committedCart) || committedCart.length === 0) {
      return [];
    }
    const requiredBySig = new Map<
      string,
      { itemName: string; requiredQtyMilli: number; minUnitPriceSatang: number }
    >();
    for (const prevLine of committedCart) {
      if (prevLine.heldLineLocked === false) continue;
      const committedQty = Math.max(
        0,
        Number(prevLine.lockedMinQtyMilli ?? prevLine.quantityMilli ?? 0)
      );
      if (committedQty <= 0) continue;
      const sig = this.buildHeldLineSignature(prevLine);
      const prevPrice = Math.max(0, Number(prevLine.unitPriceSatang ?? 0));
      const existing = requiredBySig.get(sig);
      if (existing) {
        existing.requiredQtyMilli += committedQty;
        existing.minUnitPriceSatang = Math.min(existing.minUnitPriceSatang, prevPrice);
      } else {
        requiredBySig.set(sig, {
          itemName: String(prevLine.itemName ?? prevLine.variantId),
          requiredQtyMilli: committedQty,
          minUnitPriceSatang: prevPrice,
        });
      }
    }

    const incomingBySig = new Map<
      string,
      { totalQtyMilli: number; minUnitPriceSatang: number }
    >();
    for (const nextLine of incomingLines) {
      const sig = this.buildHeldLineSignature(nextLine);
      const qty = Math.max(0, Number(nextLine.quantityMilli ?? 0));
      const price = Math.max(0, Number(nextLine.unitPriceSatang ?? 0));
      const existing = incomingBySig.get(sig);
      if (existing) {
        existing.totalQtyMilli += qty;
        existing.minUnitPriceSatang = Math.min(existing.minUnitPriceSatang, price);
      } else {
        incomingBySig.set(sig, {
          totalQtyMilli: qty,
          minUnitPriceSatang: price,
        });
      }
    }

    const deficits: string[] = [];
    for (const [sig, req] of requiredBySig.entries()) {
      const got = incomingBySig.get(sig);
      const gotQty = got?.totalQtyMilli ?? 0;
      if (gotQty < req.requiredQtyMilli) {
        deficits.push(`${req.itemName} (${req.requiredQtyMilli} -> ${gotQty})`);
      } else if (got && got.minUnitPriceSatang < req.minUnitPriceSatang) {
        deficits.push(`${req.itemName} @${req.minUnitPriceSatang}->${got.minUnitPriceSatang}`);
      }
    }
    return deficits;
  }

  private computeHeldBillTotalSatangOnDb(
    db: DatabaseSync,
    cart: ReadonlyArray<HeldBillCartLineDto>,
    taxMode: TaxMode,
    discountMode?: 'BAHT' | 'PERCENT' | undefined,
    discountInput?: string | undefined
  ): Satang {
    const fiscal = this.getFiscalConfigOnDb(db);
    const modRows = db
      .prepare(`SELECT id, price_delta_satang AS priceDeltaSatang FROM modifiers`)
      .all() as Array<{ id: string; priceDeltaSatang: number }>;
    const modPriceMap = new Map<string, number>(
      modRows.map((m) => [String(m.id), Number(m.priceDeltaSatang)])
    );

    let subtotalSatang = 0;
    for (const item of cart) {
      const qMilli = Math.max(1, Number(item.quantityMilli ?? 1_000));
      const unitSatang = Math.max(0, Number(item.unitPriceSatang ?? 0));
      const modIds = Array.isArray(item.selectedModifierIds) ? item.selectedModifierIds : [];
      const modDeltas = modIds.map((id) => modPriceMap.get(id) ?? 0);
      const override = item.overrideLineTotalSatang;
      if (typeof override === 'number' && Number.isSafeInteger(override) && override >= 0) {
        const modsTotal = modIds.reduce(
          (sum, id) =>
            sum +
            Number(
              roundDivBigInt(BigInt(qMilli) * BigInt(modPriceMap.get(id) ?? 0), SCALE_MILLI)
            ),
          0
        );
        subtotalSatang += Math.max(0, override + modsTotal);
      } else {
        const calc = computeGuestOrderLineSatang({
          quantityMilli: qMilli,
          unitPriceSatang: unitSatang,
          modifierPriceDeltasSatang: modDeltas,
        });
        subtotalSatang += calc.lineTotalSatang;
      }
    }

    let discountSatang = 0;
    const rawDisc = (discountInput ?? '').trim();
    if (rawDisc && rawDisc !== '0') {
      try {
        if (discountMode === 'PERCENT') {
          const pctBps = Math.min(10_000, Math.max(0, parseDecimalStringToScaledInt(rawDisc, 2)));
          discountSatang = Number(
            roundDivBigInt(BigInt(subtotalSatang) * BigInt(pctBps), SCALE_BASIS_POINTS)
          );
        } else {
          discountSatang = Math.min(
            subtotalSatang,
            Math.max(0, parseMoneyInputToMinor(rawDisc, fiscal.currencyCode))
          );
        }
      } catch {
        discountSatang = 0;
      }
    }

    return computeOrderFinancialTotals({
      subtotalSatang,
      discountSatang,
      vatRateBps: fiscal.vatRateBps,
      taxMode,
      currencyCode: fiscal.currencyCode,
      applyCashRounding: false,
      cashRoundingStepMajor: 0,
    }).totalSatang;
  }

  private voidAndCleanupHeldBillOnDb(
    db: DatabaseSync,
    outletId: string,
    heldBills: HeldBillRecordDto[],
    targetIdx: number,
    voidedByUserId: string,
    voidReason: string
  ): {
    voidedBillId: string;
    heldBills: HeldBillRecordDto[];
    cancelledKdsOrderIds: string[];
  } {
    const target = heldBills[targetIdx]!;
    const remaining = heldBills.filter((_, idx) => idx !== targetIdx);
    this.writeHeldBillsOnDb(db, outletId, remaining, voidedByUserId);

    const cleanReason = sanitizeGuestText(voidReason, 220) || 'ยกเลิกบิลพักจาก POS';
    const kdsIdsSet = new Set<string>(
      Array.isArray(target.linkedKdsSalesOrderIds) ? target.linkedKdsSalesOrderIds : []
    );
    const linkedGuestSet = new Set<string>(
      Array.isArray(target.linkedGuestOrderIds) ? target.linkedGuestOrderIds : []
    );

    const qrOrders = this.readGuestOrdersOnDb(db, outletId);
    let qrOrdersChanged = false;
    const nowIso = new Date().toISOString();
    const nextQrOrders = qrOrders.map((o) => {
      const matched = o.heldBillId === target.id || linkedGuestSet.has(o.id);
      if (matched && o.kdsSalesOrderId) {
        kdsIdsSet.add(o.kdsSalesOrderId);
      }
      if (matched && o.status !== 'SETTLED' && o.status !== 'REJECTED') {
        qrOrdersChanged = true;
        return {
          ...o,
          status: 'REJECTED' as const,
          rejectionReason: cleanReason,
          updatedAtIso: nowIso,
        };
      }
      return o;
    });
    if (qrOrdersChanged) {
      this.writeGuestOrdersOnDb(db, outletId, nextQrOrders, voidedByUserId);
    }

    const cancelledKdsOrderIds = Array.from(kdsIdsSet);
    if (cancelledKdsOrderIds.length > 0) {
      const voidSoStmt = db.prepare(
        `UPDATE sales_orders
         SET status = 'VOIDED',
             voided_by = ?,
             void_reason = ?,
             voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'OPEN'`
      );
      const cancelKoStmt = db.prepare(
        `UPDATE kitchen_orders
         SET status = 'CANCELLED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE sales_order_id = ? AND status != 'CANCELLED'`
      );
      for (const kdsSoId of cancelledKdsOrderIds) {
        voidSoStmt.run(voidedByUserId, cleanReason, kdsSoId);
        cancelKoStmt.run(kdsSoId);
      }
    }

    const oldSummary = JSON.stringify({
      table: target.referenceLabel,
      totalSatang: target.totalSatang,
      items: target.cart.map((c) => `${c.itemName}x${c.quantityMilli}`),
    }).slice(0, 400);

    db.prepare(
      `INSERT INTO security_audit_logs (
         event_type, actor_user_id, target_key, old_value_redacted, new_value_redacted
       ) VALUES ('HELD_BILL_VOIDED', ?, ?, ?, ?)`
    ).run(
      voidedByUserId,
      `${target.id} (${target.referenceLabel})`,
      oldSummary,
      `VOIDED:${cleanReason}`
    );

    return {
      voidedBillId: target.id,
      heldBills: remaining,
      cancelledKdsOrderIds,
    };
  }

  public listHeldBills(outletId = 'OUTLET-HQ'): HeldBillRecordDto[] {
    return this.executeRead((db) => this.readHeldBillsOnDb(db, outletId));
  }

  public async upsertHeldBill(input: {
    outletId?: string | undefined;
    actorUserId?: string | undefined;
    bill: Record<string, unknown>;
    claimToken?: string | undefined;
    keepClaim?: boolean | undefined;
    authorizedByManagerId?: string | undefined;
    voidReason?: string | undefined;
  }): Promise<HeldBillRecordDto[]> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const actorUserId = input.actorUserId ?? 'USR-CASHIER-01';
    const rawBill = input.bill ?? {};

    return this.executeWriteImmediate((db) => {
      const heldBills = this.readHeldBillsOnDb(db, outletId);
      const rawId =
        typeof rawBill.id === 'string'
          ? rawBill.id.trim()
          : rawBill.id !== undefined && rawBill.id !== null
            ? String(rawBill.id).trim()
            : '';
      const billId = rawId || `HOLD-${Date.now()}-${randomBytes(3).toString('hex')}`;
      const existingIdx = heldBills.findIndex((b) => b.id === billId);
      const existingBill = existingIdx >= 0 ? heldBills[existingIdx]! : null;

      if (existingBill?.activeClaimToken && input.claimToken && existingBill.activeClaimToken !== input.claimToken) {
        throw new Error(
          `HTTP 409 บิลพัก "${existingBill.referenceLabel}" กำลังถูกเรียกคิดเงินอยู่โดย ${existingBill.activeClaimedByName ?? 'เครื่องอื่น'}`
        );
      }

      const rawCart = Array.isArray(rawBill.cart) ? rawBill.cart : [];
      let allowAuthorizedShrink = false;
      if (existingBill) {
        const preliminaryLines = rawCart.map((item) =>
          this.normalizeHeldCartLine(item as Record<string, unknown>, billId, true)
        );
        const deficits = this.findHeldBillLineDeficits(existingBill.cart, preliminaryLines);
        if (deficits.length > 0) {
          const cleanReason = sanitizeGuestText(input.voidReason ?? '', 220);
          if (!input.authorizedByManagerId || !cleanReason) {
            throw new Error(
              `HTTP 403 Forbidden: ห้ามลบหรือลดรายการในบิลพักโดยไม่มีรหัสอนุมัติ PIN ผู้จัดการ (${deficits.join(', ')})`
            );
          }
          allowAuthorizedShrink = true;
          db.prepare(
            `INSERT INTO security_audit_logs (
               event_type, actor_user_id, target_key, old_value_redacted, new_value_redacted
             ) VALUES ('HELD_BILL_ITEM_VOIDED', ?, ?, ?, ?)`
          ).run(
            input.authorizedByManagerId,
            `${billId} (${existingBill.referenceLabel})`,
            deficits.join('; ').slice(0, 400),
            `AUTHORIZED:${cleanReason}`
          );
        }
      }

      const normalizedCart: HeldBillCartLineDto[] = rawCart.map((rawLine) => {
        const obj = rawLine as Record<string, unknown>;
        const matchedPrev = existingBill && !allowAuthorizedShrink
          ? existingBill.cart.find(
              (c) =>
                c.cartKey === String(obj.cartKey ?? '') ||
                this.buildHeldLineSignature(c) ===
                  this.buildHeldLineSignature({
                    variantId: String(obj.variantId ?? ''),
                    selectedModifierIds: Array.isArray(obj.selectedModifierIds)
                      ? (obj.selectedModifierIds as string[])
                      : [],
                    overrideLineTotalSatang:
                      typeof obj.overrideLineTotalSatang === 'number'
                        ? obj.overrideLineTotalSatang
                        : undefined,
                  })
            )
          : null;
        const normalized = this.normalizeHeldCartLine(obj, billId, true, matchedPrev);
        if (allowAuthorizedShrink) {
          return {
            ...normalized,
            lockedMinQtyMilli: normalized.quantityMilli,
          };
        }
        return normalized;
      });

      const orderTypeRaw = String(rawBill.orderType ?? existingBill?.orderType ?? 'DINE_IN');
      const orderType: CheckoutOrderRequest['orderType'] =
        orderTypeRaw === 'RETAIL' ||
        orderTypeRaw === 'TAKEAWAY' ||
        orderTypeRaw === 'DELIVERY'
          ? orderTypeRaw
          : 'DINE_IN';
      const taxModeRaw = String(rawBill.taxMode ?? existingBill?.taxMode ?? 'INCLUSIVE');
      const taxMode: TaxMode =
        taxModeRaw === 'NONE' || taxModeRaw === 'EXCLUSIVE' ? taxModeRaw : 'INCLUSIVE';
      const discountMode: 'BAHT' | 'PERCENT' | undefined =
        rawBill.discountMode === 'PERCENT' || rawBill.discountMode === 'BAHT'
          ? rawBill.discountMode
          : existingBill?.discountMode;
      const discountInput =
        typeof rawBill.discountInput === 'string'
          ? rawBill.discountInput
          : existingBill?.discountInput;

      const mergedGuestIds = Array.from(
        new Set([
          ...(existingBill?.linkedGuestOrderIds ?? []),
          ...(Array.isArray(rawBill.linkedGuestOrderIds)
            ? (rawBill.linkedGuestOrderIds as unknown[]).map((x) => String(x)).filter(Boolean)
            : []),
        ])
      );
      const mergedKdsIds = Array.from(
        new Set([
          ...(existingBill?.linkedKdsSalesOrderIds ?? []),
          ...(Array.isArray(rawBill.linkedKdsSalesOrderIds)
            ? (rawBill.linkedKdsSalesOrderIds as unknown[]).map((x) => String(x)).filter(Boolean)
            : []),
        ])
      );

      const recomputedTotalSatang =
        normalizedCart.length > 0
          ? this.computeHeldBillTotalSatangOnDb(
              db,
              normalizedCart,
              taxMode,
              discountMode,
              discountInput
            )
          : Math.max(0, Math.floor(Number(rawBill.totalSatang ?? 0)));

      const keepClaim = input.keepClaim === true && existingBill?.activeClaimToken;
      const nextBill: HeldBillRecordDto = {
        id: billId,
        outletId,
        referenceLabel:
          sanitizeGuestText(rawBill.referenceLabel ?? existingBill?.referenceLabel ?? 'บิลพัก', 60) ||
          'บิลพัก',
        orderType,
        taxMode,
        ...(discountMode ? { discountMode } : {}),
        ...(discountInput !== undefined ? { discountInput } : {}),
        cart: normalizedCart,
        totalSatang: recomputedTotalSatang,
        heldByName:
          sanitizeGuestText(rawBill.heldByName ?? existingBill?.heldByName ?? 'Staff', 60) || 'Staff',
        heldAtIso:
          typeof rawBill.heldAtIso === 'string' && rawBill.heldAtIso
            ? rawBill.heldAtIso
            : existingBill?.heldAtIso ?? new Date().toISOString(),
        version: Number(existingBill?.version ?? 0) + 1,
        ...(keepClaim
          ? {
              activeClaimToken: existingBill.activeClaimToken,
              ...(existingBill.activeClaimedByUserId
                ? { activeClaimedByUserId: existingBill.activeClaimedByUserId }
                : {}),
              ...(existingBill.activeClaimedByName
                ? { activeClaimedByName: existingBill.activeClaimedByName }
                : {}),
              ...(existingBill.activeClaimedAtIso
                ? { activeClaimedAtIso: existingBill.activeClaimedAtIso }
                : {}),
            }
          : {}),
        ...(mergedGuestIds.length > 0 ? { linkedGuestOrderIds: mergedGuestIds } : {}),
        ...(mergedKdsIds.length > 0 ? { linkedKdsSalesOrderIds: mergedKdsIds } : {}),
      };

      const nextList = [nextBill, ...heldBills.filter((b) => b.id !== billId)];
      this.writeHeldBillsOnDb(db, outletId, nextList, actorUserId);
      return nextList;
    });
  }

  public async claimHeldBill(input: {
    outletId?: string | undefined;
    id: string;
    claimToken?: string | undefined;
    claimedByUserId?: string | undefined;
    claimedByName?: string | undefined;
    forceTakeover?: boolean | undefined;
  }): Promise<{ heldBill: HeldBillRecordDto; heldBills: HeldBillRecordDto[] }> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const targetId = String(input.id ?? '').trim();
    const claimedByUserId = input.claimedByUserId ?? 'USR-CASHIER-01';
    const claimedByName = sanitizeGuestText(input.claimedByName ?? 'Cashier', 60) || 'Cashier';
    const claimToken =
      sanitizeGuestText(input.claimToken ?? '', 80) || `CLAIM-${randomBytes(8).toString('hex')}`;

    return this.executeWriteImmediate((db) => {
      const heldBills = this.readHeldBillsOnDb(db, outletId);
      const idx = heldBills.findIndex((b) => b.id === targetId);
      if (idx < 0) {
        throw new Error('HTTP 404 ไม่พบบิลพักที่ระบุ (อาจถูกชำระเงินหรือยกเลิกไปแล้ว)');
      }
      const target = heldBills[idx]!;
      if (
        target.activeClaimToken &&
        target.activeClaimToken !== claimToken &&
        input.forceTakeover !== true
      ) {
        throw new Error(
          `HTTP 409 บิลพัก "${target.referenceLabel}" กำลังถูกเรียกคิดเงินอยู่โดย ${target.activeClaimedByName ?? 'เครื่องอื่น'}`
        );
      }

      const claimedBill: HeldBillRecordDto = {
        ...target,
        cart: target.cart.map((c) => this.normalizeHeldCartLine(c, target.id, true)),
        version: Number(target.version ?? 1),
        activeClaimToken: claimToken,
        activeClaimedByUserId: claimedByUserId,
        activeClaimedByName: claimedByName,
        activeClaimedAtIso: new Date().toISOString(),
      };
      const nextList = heldBills.map((b, i) => (i === idx ? claimedBill : b));
      this.writeHeldBillsOnDb(db, outletId, nextList, claimedByUserId);
      return { heldBill: claimedBill, heldBills: nextList };
    });
  }

  public async releaseHeldBillClaim(input: {
    outletId?: string | undefined;
    id: string;
    claimToken?: string | undefined;
    actorUserId?: string | undefined;
    force?: boolean | undefined;
  }): Promise<HeldBillRecordDto[]> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const targetId = String(input.id ?? '').trim();
    const actorUserId = input.actorUserId ?? 'USR-CASHIER-01';

    return this.executeWriteImmediate((db) => {
      const heldBills = this.readHeldBillsOnDb(db, outletId);
      const idx = heldBills.findIndex((b) => b.id === targetId);
      if (idx < 0) {
        return heldBills;
      }
      const target = heldBills[idx]!;
      if (
        target.activeClaimToken &&
        input.claimToken &&
        target.activeClaimToken !== input.claimToken &&
        input.force !== true
      ) {
        throw new Error(
          `HTTP 409 บิลพัก "${target.referenceLabel}" ถูกเรียกใช้งานโดยเครื่องอื่นแล้ว`
        );
      }
      if (!target.activeClaimToken) {
        return heldBills;
      }
      const {
        activeClaimToken: _omitTok,
        activeClaimedByUserId: _omitUid,
        activeClaimedByName: _omitName,
        activeClaimedAtIso: _omitIso,
        ...released
      } = target;
      const nextList = heldBills.map((b, i) => (i === idx ? released : b));
      this.writeHeldBillsOnDb(db, outletId, nextList, actorUserId);
      return nextList;
    });
  }

  public async voidHeldBill(input: {
    outletId?: string | undefined;
    id: string;
    voidedByUserId: string;
    voidReason: string;
  }): Promise<{
    voidedBillId: string;
    heldBills: HeldBillRecordDto[];
    cancelledKdsOrderIds: string[];
  }> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const targetId = String(input.id ?? '').trim();

    return this.executeWriteImmediate((db) => {
      const heldBills = this.readHeldBillsOnDb(db, outletId);
      const idx = heldBills.findIndex((b) => b.id === targetId);
      if (idx < 0) {
        throw new Error('HTTP 404 ไม่พบบิลพักที่ต้องการยกเลิก');
      }
      return this.voidAndCleanupHeldBillOnDb(
        db,
        outletId,
        heldBills,
        idx,
        input.voidedByUserId,
        input.voidReason
      );
    });
  }

  public async voidHeldBillItem(input: {
    outletId?: string | undefined;
    id: string;
    expectedVersion?: number | undefined;
    targetCartKey: string;
    nextQuantityMilli: number;
    voidedByUserId: string;
    voidReason: string;
  }): Promise<{
    heldBill: HeldBillRecordDto | null;
    heldBills: HeldBillRecordDto[];
    billVoidedCompletely: boolean;
  }> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const targetId = String(input.id ?? '').trim();
    const cleanReason = sanitizeGuestText(input.voidReason, 220);
    if (cleanReason.length < 2) {
      throw new Error('HTTP 400 กรุณาระบุเหตุผลการลดหรือลบรายการในบิลพัก');
    }

    return this.executeWriteImmediate((db) => {
      const heldBills = this.readHeldBillsOnDb(db, outletId);
      const idx = heldBills.findIndex((b) => b.id === targetId);
      if (idx < 0) {
        throw new Error('HTTP 404 ไม่พบบิลพักที่ระบุ');
      }
      const bill = heldBills[idx]!;
      if (input.expectedVersion !== undefined && Number(bill.version ?? 1) !== input.expectedVersion) {
        throw new Error(
          'HTTP 409 บิลพักมีการอัปเดตรายการใหม่ กรุณารีเฟรชบิลก่อนแก้ไข'
        );
      }

      const lineIdx = bill.cart.findIndex((c) => c.cartKey === input.targetCartKey);
      if (lineIdx < 0) {
        throw new Error('HTTP 404 ไม่พบรายการสินค้าที่ต้องการลด/ลบในบิลพัก');
      }
      const targetLine = bill.cart[lineIdx]!;
      const nextQty = Math.max(0, Math.floor(Number(input.nextQuantityMilli ?? 0)));
      if (nextQty >= targetLine.quantityMilli) {
        throw new Error('HTTP 400 จำนวนใหม่ต้องน้อยกว่าจำนวนเดิมในบิลพัก');
      }

      const nextCart: HeldBillCartLineDto[] = [];
      for (let i = 0; i < bill.cart.length; i++) {
        const line = bill.cart[i]!;
        if (i !== lineIdx) {
          nextCart.push(this.normalizeHeldCartLine(line, bill.id, true));
          continue;
        }
        if (nextQty > 0) {
          const { overrideLineTotalSatang: _omitOv, scaleBadgeText: _omitSb, ...rest } = line;
          nextCart.push({
            ...rest,
            quantityMilli: nextQty,
            heldLineLocked: true,
            lockedMinQtyMilli: nextQty,
            heldBillOriginId: bill.id,
          });
        }
      }

      if (nextCart.length === 0) {
        const voided = this.voidAndCleanupHeldBillOnDb(
          db,
          outletId,
          heldBills,
          idx,
          input.voidedByUserId,
          cleanReason
        );
        return {
          heldBill: null,
          heldBills: voided.heldBills,
          billVoidedCompletely: true,
        };
      }

      const nextTotalSatang = this.computeHeldBillTotalSatangOnDb(
        db,
        nextCart,
        bill.taxMode,
        bill.discountMode,
        bill.discountInput
      );
      const updatedBill: HeldBillRecordDto = {
        ...bill,
        cart: nextCart,
        totalSatang: nextTotalSatang,
        version: Number(bill.version ?? 1) + 1,
      };
      const nextList = heldBills.map((b, i) => (i === idx ? updatedBill : b));
      this.writeHeldBillsOnDb(db, outletId, nextList, input.voidedByUserId);

      db.prepare(
        `INSERT INTO security_audit_logs (
           event_type, actor_user_id, target_key, old_value_redacted, new_value_redacted
         ) VALUES ('HELD_BILL_ITEM_VOIDED', ?, ?, ?, ?)`
      ).run(
        input.voidedByUserId,
        `${bill.id} (${bill.referenceLabel})`,
        `${targetLine.itemName} qty ${targetLine.quantityMilli} -> ${nextQty} (${bill.totalSatang} -> ${nextTotalSatang})`.slice(0, 400),
        `AUTHORIZED:${cleanReason}`
      );

      return {
        heldBill: updatedBill,
        heldBills: nextList,
        billVoidedCompletely: false,
      };
    });
  }

  private mergeGuestOrderIntoHeldBillOnDb(
    db: DatabaseSync,
    outletId: string,
    guestOrder: GuestOrderRecordDto,
    fiscal: FiscalConfigDto,
    actorUserId: string,
    actorDisplayName: string,
    links?: { guestOrderId?: string | undefined; kdsSalesOrderId?: string | undefined }
  ): string {
    const heldBills = this.readHeldBillsOnDb(db, outletId);

    const targetLabelUpper = guestOrder.tableLabel.trim().toUpperCase();
    const existingIdx = heldBills.findIndex(
      (b) => String(b.referenceLabel ?? '').trim().toUpperCase() === targetLabelUpper
    );

    const existingBill = existingIdx >= 0 ? heldBills[existingIdx]! : null;
    const heldBillId = existingBill
      ? existingBill.id
      : `HOLD-QR-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const existingCart: HeldBillCartLineDto[] =
      existingBill && Array.isArray(existingBill.cart)
        ? existingBill.cart.map((c) => this.normalizeHeldCartLine(c, heldBillId, true))
        : [];

    for (const line of guestOrder.lines) {
      const sortedMods = [...line.selectedModifierIds].sort();
      const noteTag = line.note ? `::note:${line.note}` : '';
      const cartKey = `${line.variantId}::${sortedMods.join(',')}${noteTag}::kds`;
      const existingLineIdx = existingCart.findIndex((c) => c.cartKey === cartKey);
      if (existingLineIdx >= 0) {
        const prev = existingCart[existingLineIdx]!;
        const nextQty = prev.quantityMilli + line.quantityMilli;
        existingCart[existingLineIdx] = {
          ...prev,
          quantityMilli: nextQty,
          kdsDispatched: true,
          heldLineLocked: true,
          lockedMinQtyMilli: Math.max(prev.lockedMinQtyMilli ?? prev.quantityMilli, nextQty),
          heldBillOriginId: heldBillId,
        };
      } else {
        existingCart.push({
          cartKey,
          variantId: line.variantId,
          itemName: line.itemName,
          variantName: line.variantName,
          sku: line.sku,
          unitName: line.unitName,
          quantityMilli: line.quantityMilli,
          unitPriceSatang: line.unitPriceSatang,
          selectedModifierIds: sortedMods,
          isWeightedScale: false,
          kdsDispatched: true,
          heldLineLocked: true,
          lockedMinQtyMilli: line.quantityMilli,
          heldBillOriginId: heldBillId,
          ...(line.note ? { guestNote: line.note } : {}),
        });
      }
    }

    const billTaxMode: TaxMode =
      existingBill &&
      (existingBill.taxMode === 'NONE' ||
        existingBill.taxMode === 'INCLUSIVE' ||
        existingBill.taxMode === 'EXCLUSIVE')
        ? existingBill.taxMode
        : fiscal.defaultTaxMode;

    const mergedTotalSatang = this.computeHeldBillTotalSatangOnDb(
      db,
      existingCart,
      billTaxMode,
      existingBill?.discountMode,
      existingBill?.discountInput
    );

    const linkedGuestOrderIds = Array.from(
      new Set([
        ...(existingBill?.linkedGuestOrderIds ?? []),
        ...(links?.guestOrderId ? [links.guestOrderId] : [guestOrder.id]),
      ])
    );
    const linkedKdsSalesOrderIds = Array.from(
      new Set([
        ...(existingBill?.linkedKdsSalesOrderIds ?? []),
        ...(links?.kdsSalesOrderId ? [links.kdsSalesOrderId] : []),
      ])
    );

    const updatedBill: HeldBillRecordDto = {
      ...(existingBill ?? {}),
      id: heldBillId,
      outletId,
      referenceLabel: guestOrder.tableLabel,
      orderType: guestOrder.orderType,
      taxMode: billTaxMode,
      cart: existingCart,
      totalSatang: mergedTotalSatang,
      heldByName: existingBill
        ? String(existingBill.heldByName ?? actorDisplayName)
        : `QR · ${actorDisplayName}`,
      heldAtIso: existingBill
        ? String(existingBill.heldAtIso ?? new Date().toISOString())
        : new Date().toISOString(),
      version: Number(existingBill?.version ?? 0) + 1,
      linkedGuestOrderIds,
      ...(linkedKdsSalesOrderIds.length > 0 ? { linkedKdsSalesOrderIds } : {}),
    };

    const nextList = [
      updatedBill,
      ...heldBills.filter((b) => b.id !== heldBillId),
    ];

    this.writeHeldBillsOnDb(db, outletId, nextList, actorUserId);

    return heldBillId;
  }

  private dispatchGuestOrderToKdsOnDb(
    db: DatabaseSync,
    outletId: string,
    guestOrder: GuestOrderRecordDto,
    actorUserId: string
  ): { kdsSalesOrderId: string; kdsSequenceIds: number[] } {
    const shiftRow = db
      .prepare(
        `SELECT id FROM pos_shifts
         WHERE outlet_id = ?
         ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END ASC, opened_at DESC
         LIMIT 1`
      )
      .get(outletId) as { id?: string } | undefined;
    if (!shiftRow?.id) {
      throw new Error('HTTP 409 กรุณาเปิดกะการขายก่อนรับออเดอร์เข้าจอครัว KDS');
    }

    const userRow =
      (db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).get(actorUserId) as
        | { id?: string }
        | undefined) ??
      (db.prepare(`SELECT id FROM users ORDER BY rowid ASC LIMIT 1`).get() as
        | { id?: string }
        | undefined);
    const validCashierId = userRow?.id ?? 'USR-OWNER-01';

    const terminalRow =
      (db
        .prepare(`SELECT id FROM pos_terminals WHERE outlet_id = ? ORDER BY rowid ASC LIMIT 1`)
        .get(outletId) as { id?: string } | undefined) ??
      (db.prepare(`SELECT id FROM pos_terminals ORDER BY rowid ASC LIMIT 1`).get() as
        | { id?: string }
        | undefined);
    const terminalId = terminalRow?.id ?? 'POS-TERM-01';

    const kdsSalesOrderId = `SO-QRKDS-${randomUUID()}`;
    const kdsReceiptNo = `QRKDS-${guestOrder.orderCode}-${randomBytes(3).toString('hex').toUpperCase()}`;

    db.prepare(
      `INSERT INTO sales_orders (
         id, idempotency_key, receipt_number, abb_tax_invoice_no,
         outlet_id, terminal_id, shift_id, cashier_id,
         order_type, table_or_queue_no, status, tax_mode,
         subtotal_satang, discount_satang, tax_satang, total_satang, total_cogs_micro_baht
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'OPEN', 'NONE', 0, 0, 0, 0, 0)`
    ).run(
      kdsSalesOrderId,
      `QR-KDS-${guestOrder.id}`,
      kdsReceiptNo,
      outletId,
      terminalId,
      shiftRow.id,
      validCashierId,
      guestOrder.orderType,
      guestOrder.tableLabel
    );

    const stationLookup = db.prepare(
      `SELECT COALESCE(c.kitchen_station, 'MAIN') AS kitchenStation
       FROM item_variants v
       JOIN items i ON i.id = v.item_id
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE v.id = ?`
    );
    const insertSoItem = db.prepare(
      `INSERT INTO sales_order_items (
         id, sales_order_id, variant_id, quantity_milli, unit_price_satang,
         modifiers_total_satang, discount_satang, line_total_satang, line_cogs_micro_baht, notes
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`
    );

    const linesByStation = new Map<
      string,
      Array<{
        salesOrderItemId: string;
        itemName: string;
        modifiersSummary: string | null;
        quantityMilli: number;
      }>
    >();

    for (const line of guestOrder.lines) {
      const soiId = `SOI-QR-${randomUUID()}`;
      const combinedNotes = [line.note, guestOrder.customerNote].filter(Boolean).join(' | ') || null;
      insertSoItem.run(
        soiId,
        kdsSalesOrderId,
        line.variantId,
        line.quantityMilli,
        line.unitPriceSatang,
        line.modifiersTotalSatang,
        line.lineTotalSatang,
        combinedNotes
      );

      const stRow = stationLookup.get(line.variantId) as { kitchenStation?: string } | undefined;
      const rawStation = String(stRow?.kitchenStation ?? 'MAIN').trim().toUpperCase();
      const station = rawStation && rawStation !== 'NONE' && rawStation !== 'PREP' ? rawStation : 'MAIN';

      const summaryParts: string[] = [];
      if (line.modifierNames.length > 0) {
        summaryParts.push(line.modifierNames.join(', '));
      }
      if (line.note) {
        summaryParts.push(`[Note: ${line.note}]`);
      }
      if (guestOrder.customerNote) {
        summaryParts.push(`[${guestOrder.customerNote}]`);
      }

      const bucket = linesByStation.get(station) ?? [];
      bucket.push({
        salesOrderItemId: soiId,
        itemName: line.itemName,
        modifiersSummary: summaryParts.length > 0 ? summaryParts.join(' · ') : null,
        quantityMilli: line.quantityMilli,
      });
      linesByStation.set(station, bucket);
    }

    const insertKo = db.prepare(
      `INSERT INTO kitchen_orders (id, sales_order_id, outlet_id, station, queue_number, status)
       VALUES (?, ?, ?, ?, ?, 'QUEUED')`
    );
    const insertKoItem = db.prepare(
      `INSERT INTO kitchen_order_items (
         id, kitchen_order_id, sales_order_item_id, item_summary_text,
         modifiers_summary_text, quantity_milli, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`
    );

    const kdsSequenceIds: number[] = [];
    const queueLabel = `${guestOrder.tableLabel} · ${guestOrder.orderCode}`;

    for (const [station, stationLines] of linesByStation.entries()) {
      const koId = `KO-QR-${randomUUID()}`;
      const koRes = insertKo.run(koId, kdsSalesOrderId, outletId, station, queueLabel);
      kdsSequenceIds.push(Number(koRes.lastInsertRowid));
      for (const sl of stationLines) {
        insertKoItem.run(
          `KOI-QR-${randomUUID()}`,
          koId,
          sl.salesOrderItemId,
          sl.itemName,
          sl.modifiersSummary,
          sl.quantityMilli
        );
      }
    }

    return { kdsSalesOrderId, kdsSequenceIds };
  }

  private computeRequiredDeductionsForLinesOnDb(
    db: DatabaseSync,
    outletId: string,
    lines: ReadonlyArray<{
      variantId: string;
      quantityMilli: number;
      selectedModifierIds: readonly string[];
    }>
  ): Map<string, { itemName: string; requiredMilli: number; availableMilli: number }> {
    const catalogRows = db
      .prepare(
        `SELECT
           v.id, v.item_id AS itemId, i.name AS itemName, v.variant_name AS variantName,
           v.sku, v.barcode, i.unit_name AS unitName, v.price_satang AS priceSatang,
           COALESCE(il.average_cost_micro_baht, v.default_purchase_cost_micro_baht) AS averageCostMicroBaht,
           COALESCE(il.in_stock_milli, 0) AS inStockMilli,
           i.is_composite AS isComposite, i.use_production AS useProduction,
           i.is_weighted_scale AS isWeightedScale
         FROM item_variants v
         JOIN items i ON i.id = v.item_id
         LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?`
      )
      .all(outletId) as Array<Record<string, unknown>>;
    const catalogMap = new Map<string, ItemVariantDto>();
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
    const modifierMap = new Map<string, ModifierDto>(
      (
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
      ).map((r) => [
        String(r.id),
        {
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
        } satisfies ModifierDto,
      ])
    );

    const result = new Map<string, { itemName: string; requiredMilli: number; availableMilli: number }>();
    for (const line of lines) {
      const variant = catalogMap.get(line.variantId);
      if (!variant) {
        throw new Error(`HTTP 400 เมนูที่เลือกไม่พร้อมจำหน่าย (${line.variantId})`);
      }
      const selectedMods = line.selectedModifierIds
        .map((id) => modifierMap.get(id))
        .filter((m): m is ModifierDto => m !== undefined);
      const hasBomEdges = bomEdges.some((e) => e.compositeVariantId === variant.id);
      const noBomComposite = variant.isComposite && !variant.useProduction && !hasBomEdges;
      let deductions: StockDeductionEntry[];
      if (noBomComposite) {
        // Composite parent without wired BOM: only modifier components can be checked
        deductions = calculateOrderLineDeductions(
          { ...variant, isComposite: false },
          line.quantityMilli,
          selectedMods,
          catalogMap,
          bomEdges
        ).filter((d) => d.variantId !== variant.id);
      } else {
        deductions = calculateOrderLineDeductions(
          variant,
          line.quantityMilli,
          selectedMods,
          catalogMap,
          bomEdges
        );
      }
      for (const d of deductions) {
        if (d.quantityChangeMilli >= 0) continue;
        const target = catalogMap.get(d.variantId);
        const prev = result.get(d.variantId);
        result.set(d.variantId, {
          itemName: target?.itemName ?? d.variantId,
          requiredMilli: (prev?.requiredMilli ?? 0) + -d.quantityChangeMilli,
          availableMilli: target?.inStockMilli ?? 0,
        });
      }
    }
    return result;
  }

  public computeGuestMenuAvailabilityMap(outletId = 'OUTLET-HQ'): Record<string, boolean> {
    return this.executeRead((db) => {
      const rows = db
        .prepare(
          `SELECT v.id AS id
           FROM item_variants v
           JOIN items i ON i.id = v.item_id
           WHERE v.active = 1 AND i.active = 1 AND i.is_weighted_scale = 0`
        )
        .all() as Array<{ id: string }>;
      const map: Record<string, boolean> = {};
      for (const row of rows) {
        const vid = String(row.id);
        try {
          const req = this.computeRequiredDeductionsForLinesOnDb(db, outletId, [
            { variantId: vid, quantityMilli: 1_000, selectedModifierIds: [] },
          ]);
          let ok = true;
          for (const entry of req.values()) {
            if (entry.availableMilli < entry.requiredMilli) {
              ok = false;
              break;
            }
          }
          map[vid] = ok;
        } catch {
          map[vid] = false;
        }
      }
      return map;
    });
  }

  private validateModifierSelectionsOnDb(
    db: DatabaseSync,
    isHospitalityItem: boolean,
    selectedModifierIds: readonly string[]
  ): Array<{ id: string; name: string; priceDeltaSatang: number }> {
    const groups = db
      .prepare(
        `SELECT g.id AS id, g.name AS name, g.selection_type AS selectionType,
                g.min_selections AS minSelections, g.max_selections AS maxSelections,
                (SELECT COUNT(*) FROM modifiers m WHERE m.modifier_group_id = g.id) AS modifiersCount
         FROM modifier_groups g`
      )
      .all() as Array<Record<string, unknown>>;
    const modRows = db
      .prepare(
        `SELECT id, modifier_group_id AS groupId, name, price_delta_satang AS priceDeltaSatang FROM modifiers`
      )
      .all() as Array<Record<string, unknown>>;
    const modMap = new Map(modRows.map((m) => [String(m.id), m]));

    const picked: Array<{ id: string; name: string; priceDeltaSatang: number }> = [];
    const selectedByGroup = new Map<string, number>();
    for (const modId of selectedModifierIds) {
      const m = modMap.get(modId);
      if (!m) {
        throw new Error(`HTTP 400 ไม่พบตัวเลือกเสริมที่เลือก (${modId})`);
      }
      picked.push({
        id: String(m.id),
        name: String(m.name),
        priceDeltaSatang: Number(m.priceDeltaSatang),
      });
      const gid = String(m.groupId);
      selectedByGroup.set(gid, (selectedByGroup.get(gid) ?? 0) + 1);
    }

    for (const g of groups) {
      const gid = String(g.id);
      const count = selectedByGroup.get(gid) ?? 0;
      const gName = String(g.name);
      if (count > 0) {
        if (String(g.selectionType) === 'SINGLE' && count > 1) {
          throw new Error(`HTTP 400 กลุ่มตัวเลือก "${gName}" เลือกได้เพียง 1 รายการ`);
        }
        if (count > Number(g.maxSelections)) {
          throw new Error(
            `HTTP 400 กลุ่มตัวเลือก "${gName}" เลือกได้ไม่เกิน ${Number(g.maxSelections)} รายการ`
          );
        }
      }
      if (isHospitalityItem && Number(g.minSelections) > 0 && Number(g.modifiersCount) > 0) {
        if (count < Number(g.minSelections)) {
          throw new Error(
            `HTTP 400 กรุณาเลือก "${gName}" อย่างน้อย ${Number(g.minSelections)} รายการ`
          );
        }
      }
    }
    return picked;
  }

  public async submitGuestOrder(input: {
    outletId?: string | undefined;
    tableLabel: string;
    signedToken?: string | null | undefined;
    customerName?: string | undefined;
    customerNote?: string | undefined;
    clientSubmissionKey?: string | undefined;
    entryChannel?: GuestEntryChannel | undefined;
    lines: GuestOrderLineInputDto[];
  }): Promise<GuestOrderRecordDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const rawLines = Array.isArray(input.lines) ? input.lines : [];
    if (rawLines.length === 0) {
      throw new Error('HTTP 400 กรุณาเลือกเมนูอย่างน้อย 1 รายการก่อนส่งออเดอร์');
    }
    if (rawLines.length > 50) {
      throw new Error('HTTP 400 จำนวนรายการต่อคำสั่งซื้อเกินขีดจำกัด 50 รายการ');
    }

    return this.executeWriteImmediate((db) => {
      const qrCfg = this.getQrOrderingConfigOnDb(db);
      if (!qrCfg.enabled) {
        throw new Error('HTTP 503 ระบบสั่งอาหารผ่าน QR ปิดรับออเดอร์ชั่วคราว');
      }
      const fiscal = this.getFiscalConfigOnDb(db);
      const requestedTable = sanitizeGuestText(input.tableLabel, 24);
      if (!requestedTable) {
        throw new Error('HTTP 400 กรุณาเลือกหมายเลขโต๊ะก่อนส่งออเดอร์');
      }

      const providedToken = typeof input.signedToken === 'string' ? input.signedToken.trim() : '';
      let isSignedTableSession = false;
      let tableSessionNonce: string | null = null;

      if (providedToken) {
        const verified = this.verifyTableQrTokenOnDb(db, outletId, requestedTable, providedToken);
        if (!verified.valid) {
          throw new Error(
            'HTTP 403 QR โต๊ะนี้หมดอายุหรือถูกปิดบิลแล้ว กรุณาขอใบ QR ใหม่จากพนักงาน'
          );
        }
        isSignedTableSession = true;
        tableSessionNonce = verified.sessionNonce;
      } else if (!qrCfg.allowOpenTableSelection) {
        throw new Error(
          'HTTP 403 ร้านนี้เปิดรับเฉพาะออเดอร์ที่สแกนจากใบ QR ประจำโต๊ะเท่านั้น'
        );
      }

      const matchedCanonicalTable = qrCfg.tableLabels.find(
        (lbl) => lbl.trim().toUpperCase() === requestedTable.toUpperCase()
      );
      if (!isSignedTableSession && !matchedCanonicalTable) {
        throw new Error(`HTTP 400 ไม่พบหมายเลขโต๊ะ "${requestedTable}" ในรายการโต๊ะของร้าน`);
      }
      const canonicalTable = matchedCanonicalTable ?? requestedTable;
      const orderType: 'DINE_IN' | 'TAKEAWAY' =
        canonicalTable.toUpperCase() === 'TAKEAWAY' || canonicalTable.includes('กลับบ้าน')
          ? 'TAKEAWAY'
          : 'DINE_IN';

      const existingOrders = this.readGuestOrdersOnDb(db, outletId);
      const cleanSubKey = sanitizeGuestText(input.clientSubmissionKey ?? '', 64);
      if (cleanSubKey) {
        const dup = existingOrders.find(
          (o) =>
            o.clientSubmissionKey === cleanSubKey &&
            o.tableLabel.toUpperCase() === canonicalTable.toUpperCase()
        );
        if (dup) {
          return this.hydrateGuestOrderKdsStatusOnDb(db, dup);
        }
      }

      const variantStmt = db.prepare(
        `SELECT
           v.id,
           v.sku,
           v.variant_name AS variantName,
           v.price_satang AS priceSatang,
           v.active AS variantActive,
           i.name AS itemName,
           i.unit_name AS unitName,
           i.is_composite AS isComposite,
           i.is_weighted_scale AS isWeightedScale,
           i.active AS itemActive,
           i.category_id AS categoryId,
           COALESCE(c.kitchen_station, 'MAIN') AS kitchenStation,
           COALESCE(il.in_stock_milli, 0) AS inStockMilli
         FROM item_variants v
         JOIN items i ON i.id = v.item_id
         LEFT JOIN categories c ON c.id = i.category_id
         LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.outlet_id = ?
         WHERE v.id = ?`
      );
      const snapshots: GuestOrderLineSnapshotDto[] = [];
      let subtotalSatang = 0;

      for (const reqLine of rawLines) {
        const variantId = sanitizeGuestText(reqLine.variantId, 80);
        const qtyCount = Math.floor(Number(reqLine.quantityCount));
        if (!variantId || !Number.isSafeInteger(qtyCount) || qtyCount < 1) {
          throw new Error('HTTP 400 ข้อมูลจำนวนเมนูไม่ถูกต้อง');
        }
        if (qtyCount > qrCfg.maxQtyPerItem) {
          throw new Error(
            `HTTP 400 สั่งได้สูงสุด ${qrCfg.maxQtyPerItem} ที่ต่อเมนูในหนึ่งครั้ง`
          );
        }

        const vRow = variantStmt.get(outletId, variantId) as Record<string, unknown> | undefined;
        if (!vRow || Number(vRow.variantActive) !== 1 || Number(vRow.itemActive) !== 1) {
          throw new Error(`HTTP 400 เมนูที่เลือกไม่พร้อมจำหน่าย (${variantId})`);
        }
        const catId = String(vRow.categoryId ?? '');
        const kStation = String(vRow.kitchenStation ?? '').toUpperCase();
        if (catId === 'CAT-RAW' || kStation === 'PREP') {
          throw new Error('HTTP 403 ไม่อนุญาตให้สั่งรายการวัตถุดิบหลังร้าน');
        }

        const quantityMilli = qtyCount * 1_000;
        const isComposite = Number(vRow.isComposite) === 1;
        if (Number(vRow.isWeightedScale) === 1) {
          throw new Error('HTTP 400 สินค้าชั่งน้ำหนักตามจริงไม่สามารถสั่งผ่าน QR ประจำโต๊ะได้');
        }

        const uniqueModIds = Array.from(
          new Set(
            (Array.isArray(reqLine.selectedModifierIds) ? reqLine.selectedModifierIds : [])
              .map((id) => sanitizeGuestText(id, 80))
              .filter(Boolean)
          )
        );
        const validatedMods = this.validateModifierSelectionsOnDb(
          db,
          isComposite,
          uniqueModIds
        );
        const modNames: string[] = validatedMods.map((m) => m.name);
        const modDeltas: Satang[] = validatedMods.map((m) => m.priceDeltaSatang);

        const unitPriceSatang = Number(vRow.priceSatang);
        const calc = computeGuestOrderLineSatang({
          quantityMilli,
          unitPriceSatang,
          modifierPriceDeltasSatang: modDeltas,
        });
        subtotalSatang += calc.lineTotalSatang;

        snapshots.push({
          variantId,
          itemName: String(vRow.itemName),
          variantName: String(vRow.variantName ?? ''),
          sku: String(vRow.sku),
          unitName: String(vRow.unitName ?? 'ชิ้น'),
          quantityMilli,
          unitPriceSatang,
          modifiersTotalSatang: calc.modifiersTotalSatang,
          lineTotalSatang: calc.lineTotalSatang,
          selectedModifierIds: uniqueModIds,
          modifierNames: modNames,
          note: sanitizeGuestText(reqLine.note ?? '', 120),
        });
      }

      const stockCheck = this.computeRequiredDeductionsForLinesOnDb(
        db,
        outletId,
        snapshots.map((s) => ({
          variantId: s.variantId,
          quantityMilli: s.quantityMilli,
          selectedModifierIds: s.selectedModifierIds,
        }))
      );
      for (const entry of stockCheck.values()) {
        if (entry.availableMilli < entry.requiredMilli) {
          throw new Error(`HTTP 409 สินค้าหรือวัตถุดิบ "${entry.itemName}" คงเหลือไม่เพียงพอ`);
        }
      }

      const financials = computeOrderFinancialTotals({
        subtotalSatang,
        discountSatang: 0,
        vatRateBps: fiscal.vatRateBps,
        taxMode: fiscal.defaultTaxMode,
        currencyCode: fiscal.currencyCode,
        applyCashRounding: false,
        cashRoundingStepMajor: 0,
      });

      let maxOrderNum = existingOrders.length;
      for (const ord of existingOrders) {
        const m = /^QR-(\d+)$/.exec(ord.orderCode);
        if (m?.[1]) {
          const n = Number(m[1]);
          if (Number.isSafeInteger(n) && n > maxOrderNum) {
            maxOrderNum = n;
          }
        }
      }
      const orderCode = `QR-${String(maxOrderNum + 1).padStart(3, '0')}`;
      const nowIso = new Date().toISOString();

      const record: GuestOrderRecordDto = {
        id: `GORD-${randomUUID()}`,
        orderCode,
        outletId,
        tableLabel: canonicalTable,
        orderType,
        customerName: sanitizeGuestText(input.customerName ?? '', 50),
        customerNote: sanitizeGuestText(input.customerNote ?? '', 160),
        isSignedTableSession,
        tableSessionNonce,
        entryChannel: normalizeGuestEntryChannel(
          input.entryChannel,
          isSignedTableSession ? 'QR' : 'DIRECT'
        ),
        status: 'PENDING_CONFIRM',
        lines: snapshots,
        subtotalSatang,
        estimatedTotalSatang: financials.totalSatang,
        heldBillId: null,
        kdsSalesOrderId: null,
        kdsSequenceIds: [],
        acceptedByName: null,
        acceptedAtIso: null,
        rejectionReason: null,
        createdAtIso: nowIso,
        updatedAtIso: nowIso,
        trackingToken: randomBytes(8).toString('hex'),
        clientSubmissionKey: cleanSubKey || null,
        settledAtIso: null,
      };

      // Auto-Accept ONLY when store enabled AUTO_ACCEPT_SIGNED_TABLE AND guest has valid HMAC-signed Table QR
      if (qrCfg.approvalMode === 'AUTO_ACCEPT_SIGNED_TABLE' && isSignedTableSession) {
        const kdsRes = this.dispatchGuestOrderToKdsOnDb(db, outletId, record, 'USR-OWNER-01');
        const heldBillId = this.mergeGuestOrderIntoHeldBillOnDb(
          db,
          outletId,
          record,
          fiscal,
          'USR-OWNER-01',
          'Auto-QR',
          { guestOrderId: record.id, kdsSalesOrderId: kdsRes.kdsSalesOrderId }
        );
        record.status = 'ACCEPTED';
        record.heldBillId = heldBillId;
        record.kdsSalesOrderId = kdsRes.kdsSalesOrderId;
        record.kdsSequenceIds = kdsRes.kdsSequenceIds;
        record.acceptedByName = 'Auto-Accept (Signed QR)';
        record.acceptedAtIso = nowIso;
      }

      this.writeGuestOrdersOnDb(db, outletId, [record, ...existingOrders], 'GUEST-QR');
      return record;
    });
  }

  public listGuestOrders(outletId = 'OUTLET-HQ'): GuestOrderRecordDto[] {
    return this.executeRead((db) => {
      const orders = this.readGuestOrdersOnDb(db, outletId);
      return orders.map((ord) => this.hydrateGuestOrderKdsStatusOnDb(db, ord));
    });
  }

  public getGuestOrderStatusById(
    outletId: string,
    guestOrderId: string,
    trackingToken?: string | undefined
  ): GuestOrderRecordDto | null {
    return this.executeRead((db) => {
      const orders = this.readGuestOrdersOnDb(db, outletId);
      const found = orders.find((o) => o.id === guestOrderId);
      if (!found) return null;
      if (found.trackingToken && (!trackingToken || trackingToken.trim() !== found.trackingToken)) {
        return null;
      }
      return this.hydrateGuestOrderKdsStatusOnDb(db, found);
    });
  }

  public async settleTableQrOrdersAndSessions(input: {
    outletId?: string | undefined;
    tableLabel: string;
    actorUserId?: string | undefined;
  }): Promise<{ revokedSession: boolean; settledOrdersCount: number }> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const cleanTable = sanitizeGuestText(input.tableLabel, 24);
    if (!cleanTable) return { revokedSession: false, settledOrdersCount: 0 };
    const actor = input.actorUserId ?? 'USR-CASHIER-01';
    const upper = cleanTable.toUpperCase();

    return this.executeWriteImmediate((db) => {
      const map = this.readTableSessionsMapOnDb(db, outletId);
      let revokedSession = false;
      if (upper in map) {
        delete map[upper];
        this.writeTableSessionsMapOnDb(db, outletId, map, actor);
        revokedSession = true;
      }

      const nowIso = new Date().toISOString();
      const orders = this.readGuestOrdersOnDb(db, outletId);
      let settledOrdersCount = 0;
      const nextOrders = orders.map((o) => {
        if (
          o.tableLabel.toUpperCase() === upper &&
          !o.settledAtIso &&
          (o.status === 'ACCEPTED' ||
            o.status === 'PREPARING' ||
            o.status === 'READY' ||
            o.status === 'SERVED')
        ) {
          settledOrdersCount += 1;
          return { ...o, status: 'SETTLED' as const, settledAtIso: nowIso, updatedAtIso: nowIso };
        }
        return o;
      });
      if (settledOrdersCount > 0) {
        this.writeGuestOrdersOnDb(db, outletId, nextOrders, actor);
      }

      const calls = this.readServiceCallsOnDb(db, outletId);
      let callsChanged = false;
      const nextCalls = calls.map((c) => {
        if (c.tableLabel.toUpperCase() === upper && c.status === 'PENDING') {
          callsChanged = true;
          return {
            ...c,
            status: 'ACKNOWLEDGED' as const,
            acknowledgedByName: 'Auto (Bill Settled)',
            acknowledgedAtIso: nowIso,
          };
        }
        return c;
      });
      if (callsChanged) {
        this.writeServiceCallsOnDb(db, outletId, nextCalls, actor);
      }
      return { revokedSession, settledOrdersCount };
    });
  }

  private readServiceCallsOnDb(db: DatabaseSync, outletId: string): GuestServiceCallDto[] {
    const key = `qr_service_calls_${outletId}`;
    const row = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return Array.isArray(parsed) ? (parsed as GuestServiceCallDto[]) : [];
    } catch {
      return [];
    }
  }

  private writeServiceCallsOnDb(
    db: DatabaseSync,
    outletId: string,
    calls: GuestServiceCallDto[],
    actorUserId: string
  ): void {
    const key = `qr_service_calls_${outletId}`;
    db.prepare(
      `INSERT INTO store_config (key, value, is_protected, updated_by, updated_at)
       VALUES (?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(key, JSON.stringify(calls.slice(0, 50)), actorUserId);
  }

  public listGuestServiceCalls(outletId = 'OUTLET-HQ'): GuestServiceCallDto[] {
    return this.executeRead((db) => this.readServiceCallsOnDb(db, outletId));
  }

  public async submitGuestServiceCall(input: {
    outletId?: string | undefined;
    tableLabel: string;
    signedToken?: string | null | undefined;
    callType: GuestServiceCallType;
    note?: string | undefined;
    entryChannel?: GuestEntryChannel | undefined;
  }): Promise<GuestServiceCallDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const callType: GuestServiceCallType =
      input.callType === 'REQUEST_BILL' ? 'REQUEST_BILL' : 'CALL_STAFF';

    return this.executeWriteImmediate((db) => {
      const qrCfg = this.getQrOrderingConfigOnDb(db);
      if (!qrCfg.enabled) {
        throw new Error('HTTP 503 ระบบสั่งอาหารผ่าน QR ปิดรับชั่วคราว');
      }
      const requestedTable = sanitizeGuestText(input.tableLabel, 24);
      if (!requestedTable) {
        throw new Error('HTTP 400 กรุณาเลือกหมายเลขโต๊ะก่อนเรียกพนักงาน');
      }
      const providedToken = typeof input.signedToken === 'string' ? input.signedToken.trim() : '';
      let isSigned = false;
      if (providedToken) {
        const verified = this.verifyTableQrTokenOnDb(db, outletId, requestedTable, providedToken);
        if (!verified.valid) {
          throw new Error('HTTP 403 QR โต๊ะนี้หมดอายุหรือถูกปิดบิลแล้ว กรุณาขอใบ QR ใหม่จากพนักงาน');
        }
        isSigned = true;
      } else if (!qrCfg.allowOpenTableSelection) {
        throw new Error('HTTP 403 ร้านนี้เปิดรับเฉพาะการสแกนจากใบ QR ประจำโต๊ะเท่านั้น');
      }
      const canonical = qrCfg.tableLabels.find(
        (l) => l.trim().toUpperCase() === requestedTable.toUpperCase()
      );
      if (!isSigned && !canonical) {
        throw new Error(`HTTP 400 ไม่พบหมายเลขโต๊ะ "${requestedTable}" ในรายการโต๊ะของร้าน`);
      }
      const tableLabel = canonical ?? requestedTable;

      const calls = this.readServiceCallsOnDb(db, outletId);
      const nowMs = Date.now();
      const existing = calls.find(
        (c) =>
          c.status === 'PENDING' &&
          c.callType === callType &&
          c.tableLabel.toUpperCase() === tableLabel.toUpperCase() &&
          nowMs - Date.parse(c.createdAtIso) < 120_000
      );
      if (existing) return existing;

      const record: GuestServiceCallDto = {
        id: `SCALL-${randomUUID()}`,
        outletId,
        tableLabel,
        callType,
        note: sanitizeGuestText(input.note ?? '', 120),
        isSignedTableSession: isSigned,
        entryChannel: normalizeGuestEntryChannel(
          input.entryChannel,
          isSigned ? 'QR' : 'DIRECT'
        ),
        status: 'PENDING',
        createdAtIso: new Date(nowMs).toISOString(),
        acknowledgedByName: null,
        acknowledgedAtIso: null,
      };
      this.writeServiceCallsOnDb(db, outletId, [record, ...calls], 'GUEST-QR');
      return record;
    });
  }

  public async acknowledgeGuestServiceCall(input: {
    outletId?: string | undefined;
    callId: string;
    actorUserId?: string | undefined;
    actorDisplayName?: string | undefined;
  }): Promise<GuestServiceCallDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const actor = input.actorUserId ?? 'USR-CASHIER-01';
    const actorName = sanitizeGuestText(input.actorDisplayName ?? 'Cashier', 60) || 'Cashier';
    return this.executeWriteImmediate((db) => {
      const calls = this.readServiceCallsOnDb(db, outletId);
      const idx = calls.findIndex((c) => c.id === input.callId);
      if (idx < 0) {
        throw new Error('HTTP 404 ไม่พบรายการเรียกพนักงานที่ระบุ');
      }
      const target = calls[idx]!;
      if (target.status === 'ACKNOWLEDGED') return target;
      const updated: GuestServiceCallDto = {
        ...target,
        status: 'ACKNOWLEDGED',
        acknowledgedByName: actorName,
        acknowledgedAtIso: new Date().toISOString(),
      };
      calls[idx] = updated;
      this.writeServiceCallsOnDb(db, outletId, calls, actor);
      return updated;
    });
  }

  public async acceptGuestOrderToHeldBillAndKds(input: {
    outletId?: string | undefined;
    guestOrderId: string;
    actorUserId?: string | undefined;
    actorDisplayName?: string | undefined;
  }): Promise<{ order: GuestOrderRecordDto; heldBillId: string; kdsSequenceIds: number[] }> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const actorUserId = input.actorUserId ?? 'USR-CASHIER-01';
    const actorDisplayName = sanitizeGuestText(input.actorDisplayName ?? 'Cashier', 60) || 'Cashier';

    return this.executeWriteImmediate((db) => {
      const orders = this.readGuestOrdersOnDb(db, outletId);
      const idx = orders.findIndex((o) => o.id === input.guestOrderId);
      if (idx < 0) {
        throw new Error('HTTP 404 ไม่พบออเดอร์ QR ที่ระบุ');
      }
      const target = orders[idx]!;
      if (target.status !== 'PENDING_CONFIRM') {
        throw new Error(
          `HTTP 409 ออเดอร์ ${target.orderCode} ถูกดำเนินการไปแล้ว (สถานะ: ${target.status})`
        );
      }

      const fiscal = this.getFiscalConfigOnDb(db);
      const acceptStock = this.computeRequiredDeductionsForLinesOnDb(
        db,
        outletId,
        target.lines.map((l) => ({
          variantId: l.variantId,
          quantityMilli: l.quantityMilli,
          selectedModifierIds: l.selectedModifierIds,
        }))
      );
      for (const entry of acceptStock.values()) {
        if (entry.availableMilli < entry.requiredMilli) {
          throw new Error(
            `HTTP 409 สินค้าหรือวัตถุดิบ "${entry.itemName}" คงเหลือไม่เพียงพอสำหรับการรับออเดอร์นี้`
          );
        }
      }
      const kdsRes = this.dispatchGuestOrderToKdsOnDb(db, outletId, target, actorUserId);
      const heldBillId = this.mergeGuestOrderIntoHeldBillOnDb(
        db,
        outletId,
        target,
        fiscal,
        actorUserId,
        actorDisplayName,
        { guestOrderId: target.id, kdsSalesOrderId: kdsRes.kdsSalesOrderId }
      );

      const nowIso = new Date().toISOString();
      const updated: GuestOrderRecordDto = {
        ...target,
        status: 'ACCEPTED',
        heldBillId,
        kdsSalesOrderId: kdsRes.kdsSalesOrderId,
        kdsSequenceIds: kdsRes.kdsSequenceIds,
        acceptedByName: actorDisplayName,
        acceptedAtIso: nowIso,
        updatedAtIso: nowIso,
      };
      orders[idx] = updated;
      this.writeGuestOrdersOnDb(db, outletId, orders, actorUserId);
      return {
        order: updated,
        heldBillId,
        kdsSequenceIds: kdsRes.kdsSequenceIds,
      };
    });
  }

  public async rejectGuestOrder(input: {
    outletId?: string | undefined;
    guestOrderId: string;
    reason: string;
    actorUserId?: string | undefined;
    actorDisplayName?: string | undefined;
  }): Promise<GuestOrderRecordDto> {
    const outletId = input.outletId ?? 'OUTLET-HQ';
    const actorUserId = input.actorUserId ?? 'USR-CASHIER-01';
    const cleanReason =
      sanitizeGuestText(input.reason, 160) || 'ร้านไม่สามารถรับออเดอร์รายการนี้ได้ในขณะนี้';

    return this.executeWriteImmediate((db) => {
      const orders = this.readGuestOrdersOnDb(db, outletId);
      const idx = orders.findIndex((o) => o.id === input.guestOrderId);
      if (idx < 0) {
        throw new Error('HTTP 404 ไม่พบออเดอร์ QR ที่ระบุ');
      }
      const target = orders[idx]!;
      if (target.status !== 'PENDING_CONFIRM') {
        throw new Error(
          `HTTP 409 ออเดอร์ ${target.orderCode} ถูกดำเนินการไปแล้ว (สถานะ: ${target.status})`
        );
      }
      const nowIso = new Date().toISOString();
      const updated: GuestOrderRecordDto = {
        ...target,
        status: 'REJECTED',
        rejectionReason: cleanReason,
        updatedAtIso: nowIso,
      };
      orders[idx] = updated;
      this.writeGuestOrdersOnDb(db, outletId, orders, actorUserId);
      return updated;
    });
  }
}

export interface FirstRunOnboardingInput {
  businessProfile: BusinessProfile;
  countryCode?: CountryCode | undefined;
  uiLocale?: LocaleCode | undefined;
  receiptLocale?: LocaleCode | undefined;
  vatRateBps?: BasisPoints | undefined;
  defaultTaxMode?: TaxMode | undefined;
  cashRoundingStepMajor?: CashRoundingStepMajor | undefined;
  scalePriceEmbeddedMultiplier?: number | undefined;
  storeName: string;
  storeAddress?: string | undefined;
  taxId: string;
  branchCode: string;
  rdPosRegNo: string;
  promptPayId: string;
  laoQrStaticTemplate?: string | undefined;
  laoQrVerificationPolicy?: LaoQrVerificationPolicy | undefined;
  fxRates?: Partial<FxRatesConfigDto> | undefined;
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
  storeAddress?: string | undefined;
  taxId: string;
  branchCode: string;
  rdPosRegNo: string;
  promptPayId: string;
  businessProfile: BusinessProfile;
  fiscalConfig?: FiscalConfigDto | undefined;
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
  cashRoundingDiscountSatang?: Satang | undefined;
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
  fxTender?: FxCashTenderDetailDto | null | undefined;
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

