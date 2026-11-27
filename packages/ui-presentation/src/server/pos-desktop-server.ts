/**
 * RUBE-STOCK-POS v3.1 Interactive Full-Stack POS & Warehouse Desktop/Web Application Server
 *
 * Supports:
 * - Production Clean-Start Mode (`requireFirstRunWizard: true`) + Dual-KEK `.recovery-kit` generation
 * - Real Thermal Printer Hardware Dispatch (`LAN TCP :9100`, `Windows Raw USB winspool.drv`, & `203-DPI HTML5 Canvas Raster`)
 * - Split-Tender Payments (`CASH` + `PROMPTPAY_QR` + `CARD`), Modifier Groups CRUD, Catalog CRUD, PIN Auth & Full WMS
 */

import { execFile } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KeystoreEnvelopeManager } from '../../../core-engine/src/runtime/keystore-envelope.ts';
import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
  type AbbSalesTaxReportDto,
  type CreatePurchaseOrderInput,
  type DispatchTransferOrderInput,
  type ExecuteInventoryCountInput,
  type FirstRunOnboardingInput,
  type InventoryValuationReportDto,
  type MenuGrossMarginReportDto,
  type ReceiveTransferOrderInput,
  type ShiftZReportDto,
  type StaffUserDto,
  type UpsertCatalogVariantInput,
} from '../../../core-engine/src/runtime/sqlite-engine.ts';
import { LanClusterCoordinator } from '../../../cluster-gateway/src/lan-cluster-coordinator.ts';
import { LocalIpcBridge } from '../../../cluster-gateway/src/local-ipc-bridge.ts';
import {
  buildSampleStaticLaoQrTemplate,
  buildTwoPhaseLaoSlipConfirmationModal,
  buildTwoPhaseSlipConfirmationModal,
  commitVerifiedBotSlipHash,
  generateOfflineLaoQrDynamicQr,
  generateOfflinePromptPayDynamicQr,
  validateLaoQrStaticTemplate,
} from '../../../hal-drivers/src/payment/mod.ts';
import {
  buildEscPosWireJobFrom1BitBitmap,
  dispatchEscPosPayloadToHardware,
  ESC_POS_KICK_DRAWER_BYTES,
  listWindowsInstalledPrinters,
  renderThaiReceiptAbbEscPosJob,
  ThermalPrinterSpoolerQueue,
  type PrinterHardwareConfig,
} from '../../../hal-drivers/src/printer/mod.ts';
import { UpsPowerHidMonitor } from '../../../hal-drivers/src/ups/mod.ts';
import {
  formatMilliUnitsToQtyString,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
  type TaxMode,
} from '../../../shared-contracts/src/fixed-point.ts';
import {
  type CashRoundingStepMajor,
  type CountryCode,
  type FiscalConfigDto,
  type ForeignTenderCurrencyCode,
  type FxRatesConfigDto,
  type LaoQrVerificationPolicy,
  type LocaleCode,
  computeOrderFinancialTotals,
  formatForeignMoney,
  formatFxTenderReceiptLine,
  formatMicroUnitCost,
  formatMoney,
  formatVatRatePercent,
} from '../../../shared-contracts/src/currency.ts';
import type {
  BomEdgeDto,
  BusinessProfile,
  CheckoutOrderRequest,
  ComponentRole,
  SplitPaymentLegInput,
  UserRole,
} from '../../../shared-contracts/src/ipc-commands.ts';
import { resolveProfileFeatureFlags } from '../profiles/profile-config.ts';
import type { QrOrderingConfigDto } from '../../../shared-contracts/src/qr-ordering.ts';
import { GuestQrOrderingServer } from './guest-qr-server.ts';
import { PosTerminalViewController } from '../views/pos-terminal/PosTerminalView.ts';
import { FinancialAndBackupReportViewController } from '../views/reports/FinancialAndBackupReportView.ts';
import { SystemSecurityAndProfileViewController } from '../views/settings/SystemSecurityAndProfileView.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

export interface UsbBackupConfigStatusDto {
  customBackupDir: string;
  defaultLocalBackupDir: string;
  activeEffectiveDir: string;
  isExternalCustomDir: boolean;
  targetWritable: boolean;
  mirrorToLocalFallback: boolean;
}

export interface DiscoveredStorageDriveDto {
  driveLetter: string;
  volumeName: string;
  driveKind: 'REMOVABLE_USB' | 'FIXED_DISK' | 'NETWORK_DRIVE' | 'OTHER';
  freeBytes: number;
  totalBytes: number;
  suggestedBackupPath: string;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const DEFAULT_PRINTER_CONFIG: PrinterHardwareConfig = {
  mode: 'SIMULATED_MEMORY',
  tcpHost: '192.168.1.200',
  tcpPort: 9100,
  windowsPrinterName: '',
  paperWidthMm: 80,
  autoKickDrawerOnCash: true,
};

export interface RubePosInteractiveServerOptions {
  dbPath: string;
  usbBackupDir?: string | undefined;
  /**
   * When true (used in real production launches via `npm start` / Tauri desktop),
   * an empty database boots into the First-Run Setup Wizard instead of auto-seeding demo products.
   * Defaults to `false` so existing automated E2E suites remain 100% compatible.
   */
  requireFirstRunWizard?: boolean | undefined;
  /**
   * When true (enabled automatically in `scripts/start-pos-app.ts` / Desktop shell),
   * every `/api/*` endpoint requires a verified HMAC Bearer session token and enforces server-side RBAC.
   */
  enforceApiSessionAuth?: boolean | undefined;
  /**
   * Lockout duration in milliseconds after 5 consecutive failed PIN attempts (defaults to 30,000 ms).
   */
  pinLockoutDurationMs?: number | undefined;
  /**
   * Optional per-IP rate limit (orders/minute) for the isolated Guest LAN Server (default 10).
   */
  guestQrRateLimitPerMinute?: number | undefined;
}

export class RubePosInteractiveAppServer {
  public readonly engine: SqliteReadWritePoolEngine;
  public readonly clusterCoordinator: LanClusterCoordinator;
  public readonly ipc: LocalIpcBridge;
  public readonly guestQrServer: GuestQrOrderingServer;
  public readonly posController: PosTerminalViewController;
  public readonly reportsController: FinancialAndBackupReportViewController;
  public readonly securityController: SystemSecurityAndProfileViewController;
  public readonly printerSpooler: ThermalPrinterSpoolerQueue;
  public readonly upsMonitor: UpsPowerHidMonitor;

  private readonly dbPath: string;
  private readonly defaultUsbBackupDir: string;
  private readonly productImagesDir: string;
  private readonly keystoreManifestPath: string;
  private readonly requireFirstRunWizard: boolean;
  private readonly enforceApiSessionAuth: boolean;
  private readonly pinLockoutDurationMs: number;
  private forceWizardPreview = false;

  private cachedSessionHmacSecret: string | null = null;
  private sessionHmacSecretPersisted = false;
  private persistSecretPromise: Promise<void> | null = null;
  private readonly fallbackProcessSessionSecret = randomBytes(32).toString('hex');
  private readonly revokedTokenNonces = new Set<string>();
  private readonly pinFailTrackers = new Map<
    string,
    { count: number; firstFailedAtMs: number; lockedUntilMs: number }
  >();
  private pinAuthQueue: Promise<unknown> = Promise.resolve();
  private onboardingQueue: Promise<unknown> = Promise.resolve();
  private hardwarePrintQueue: Promise<unknown> = Promise.resolve();
  private seedingPromise: Promise<void> | null = null;
  private readonly openingShiftByOutlet = new Map<string, Promise<void>>();
  private engineClosed = false;
  private lastUsbWriteProbeCache: { dir: string; ok: boolean; checkedAtMs: number } | null = null;

  private readonly usedSlipHashes = new Set<string>();
  private shiftSequenceCounter = 1;
  private poSequenceCounter = 1;
  private transferSequenceCounter = 1;
  private countSequenceCounter = 1;
  private checkoutSequenceCounter = 1;
  private seeded = false;
  private server: http.Server | null = null;

  constructor(options: RubePosInteractiveServerOptions) {
    this.dbPath = options.dbPath;
    this.requireFirstRunWizard = options.requireFirstRunWizard === true;
    this.enforceApiSessionAuth = options.enforceApiSessionAuth === true;
    this.pinLockoutDurationMs = Math.max(50, Number(options.pinLockoutDurationMs ?? 30_000));
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.defaultUsbBackupDir =
      options.usbBackupDir ?? path.join(path.dirname(options.dbPath), 'usb-backups');
    this.productImagesDir = path.join(path.dirname(options.dbPath), 'product-images');
    this.keystoreManifestPath = path.join(path.dirname(options.dbPath), 'keystore.manifest.json');
    fs.mkdirSync(this.defaultUsbBackupDir, { recursive: true });
    fs.mkdirSync(this.productImagesDir, { recursive: true });

    this.engine = new SqliteReadWritePoolEngine(
      options.dbPath,
      DEV_SQLCIPHER_RAW_HEX_KEY_64,
      4
    );
    this.clusterCoordinator = new LanClusterCoordinator({
      engine: this.engine,
      outletId: 'OUTLET-HQ',
      terminalId: 'POS-TERM-01',
    });
    this.ipc = new LocalIpcBridge(this.engine, this.clusterCoordinator);
    this.guestQrServer = new GuestQrOrderingServer({
      ipc: this.ipc,
      outletId: 'OUTLET-HQ',
      productImagesDir: this.productImagesDir,
      getProductImagesMap: () => this.getProductImagesMap(),
      ...(options.guestQrRateLimitPerMinute !== undefined
        ? { rateLimitMaxOrdersPerMinute: options.guestQrRateLimitPerMinute }
        : {}),
    });
    this.posController = new PosTerminalViewController(this.ipc, 'OUTLET-HQ', 'POS-TERM-01');
    this.reportsController = new FinancialAndBackupReportViewController(this.ipc);
    this.securityController = new SystemSecurityAndProfileViewController(this.ipc);
    this.printerSpooler = new ThermalPrinterSpoolerQueue();
    this.upsMonitor = new UpsPowerHidMonitor({
      onTriggerEmergencyWalCheckpoint: async () => {
        await this.ipc.triggerEmergencyUpsWalCheckpoint('POS-TERM-01');
      },
    });

    try {
      const shiftRows = this.engine.executeRead((db) => {
        return db.prepare('SELECT shift_number AS docNo FROM pos_shifts').all() as Array<{
          docNo?: unknown;
        }>;
      });
      this.shiftSequenceCounter = this.computeNextSequenceCounter(
        shiftRows.map((r) => String(r.docNo ?? '')),
        'SHF-LIVE-'
      );

      const poRows = this.engine.executeRead((db) => {
        return db.prepare('SELECT po_number AS docNo FROM purchase_orders').all() as Array<{
          docNo?: unknown;
        }>;
      });
      this.poSequenceCounter = this.computeNextSequenceCounter(
        poRows.map((r) => String(r.docNo ?? '')),
        'PO-LIVE-'
      );

      const trRows = this.engine.executeRead((db) => {
        return db.prepare('SELECT transfer_number AS docNo FROM transfer_orders').all() as Array<{
          docNo?: unknown;
        }>;
      });
      this.transferSequenceCounter = this.computeNextSequenceCounter(
        trRows.map((r) => String(r.docNo ?? '')),
        'TRF-'
      );

      const cntRows = this.engine.executeRead((db) => {
        return db.prepare('SELECT count_number AS docNo FROM inventory_counts').all() as Array<{
          docNo?: unknown;
        }>;
      });
      this.countSequenceCounter = this.computeNextSequenceCounter(
        cntRows.map((r) => String(r.docNo ?? '')),
        'CNT-'
      );

      const slipRows = this.engine.executeRead((db) => {
        return db
          .prepare(
            `SELECT slip_trans_ref_hash AS h FROM payment_transactions WHERE slip_trans_ref_hash IS NOT NULL`
          )
          .all() as Array<{ h: string }>;
      });
      for (const r of slipRows) {
        if (r.h) this.usedSlipHashes.add(r.h);
      }
      const secRow = this.engine.executeRead((db) => {
        return db
          .prepare(`SELECT value FROM store_config WHERE key = 'api_session_hmac_secret'`)
          .get() as { value?: string } | undefined;
      });
      if (secRow?.value) {
        this.cachedSessionHmacSecret = secRow.value;
        this.sessionHmacSecretPersisted = true;
      }
    } catch {
      // schema might be uninitialized
    }
  }

  private computeNextSequenceCounter(docNumbers: ReadonlyArray<string>, prefix: string): number {
    let maxSuffix = 0;
    for (const raw of docNumbers) {
      if (!raw.startsWith(prefix)) continue;
      const match = /(\d+)$/.exec(raw);
      if (match?.[1]) {
        const parsed = Number(match[1]);
        if (Number.isSafeInteger(parsed) && parsed > maxSuffix) {
          maxSuffix = parsed;
        }
      }
    }
    return Math.max(docNumbers.length + 1, maxSuffix + 1, 1);
  }

  private async executeWithUniqueDocRetry<T>(
    uniqueColumnHint: string,
    attemptFn: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return await attemptFn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if ((msg.includes('UNIQUE') || msg.includes(uniqueColumnHint)) && attempt < 99) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Exceeded max sequence retry attempts (${uniqueColumnHint})`);
  }

  private enqueueSerialized<T>(
    getHead: () => Promise<unknown>,
    setHead: (next: Promise<unknown>) => void,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = getHead().catch(() => {});
    const current = prev.then(() => fn());
    setHead(current.catch(() => {}));
    return current;
  }

  private enqueuePinAuth<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(
      () => this.pinAuthQueue,
      (next) => {
        this.pinAuthQueue = next;
      },
      fn
    );
  }

  private enqueueOnboarding<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(
      () => this.onboardingQueue,
      (next) => {
        this.onboardingQueue = next;
      },
      fn
    );
  }

  private enqueueHardwarePrint<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(
      () => this.hardwarePrintQueue,
      (next) => {
        this.hardwarePrintQueue = next;
      },
      fn
    );
  }

  private getOrCreateSessionHmacSecret(): string {
    if (this.cachedSessionHmacSecret) {
      return this.cachedSessionHmacSecret;
    }
    try {
      const row = this.engine.executeRead((db) => {
        return db
          .prepare(`SELECT value FROM store_config WHERE key = 'api_session_hmac_secret'`)
          .get() as { value?: string } | undefined;
      });
      if (row?.value) {
        this.cachedSessionHmacSecret = row.value;
        this.sessionHmacSecretPersisted = true;
        return row.value;
      }
    } catch {
      // ignore read failure
    }
    this.cachedSessionHmacSecret = this.fallbackProcessSessionSecret;
    return this.cachedSessionHmacSecret;
  }

  private async ensureSessionHmacSecretPersisted(): Promise<void> {
    if (this.sessionHmacSecretPersisted && this.cachedSessionHmacSecret) {
      return;
    }
    if (this.persistSecretPromise) {
      return this.persistSecretPromise;
    }
    this.persistSecretPromise = (async () => {
      try {
        const existing = this.engine.executeRead((db) => {
          return db
            .prepare(`SELECT value FROM store_config WHERE key = 'api_session_hmac_secret'`)
            .get() as { value?: string } | undefined;
        });
        if (existing?.value) {
          this.cachedSessionHmacSecret = existing.value;
          this.sessionHmacSecretPersisted = true;
          return;
        }
      } catch {
        this.cachedSessionHmacSecret =
          this.cachedSessionHmacSecret ?? this.fallbackProcessSessionSecret;
        return;
      }

      const candidate = this.cachedSessionHmacSecret ?? this.fallbackProcessSessionSecret;
      try {
        await this.engine.executeWriteImmediate((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO store_config (key, value, is_protected, updated_by)
             VALUES ('api_session_hmac_secret', ?, 0, 'SYSTEM')`
          ).run(candidate);
        });
        const stored = this.engine.executeRead((db) => {
          return db
            .prepare(`SELECT value FROM store_config WHERE key = 'api_session_hmac_secret'`)
            .get() as { value?: string } | undefined;
        });
        this.cachedSessionHmacSecret = stored?.value ?? candidate;
        if (stored?.value) {
          this.sessionHmacSecretPersisted = true;
        }
      } catch {
        this.cachedSessionHmacSecret = candidate;
      }
    })();

    try {
      await this.persistSecretPromise;
    } finally {
      this.persistSecretPromise = null;
    }
  }

  private issueAuthToken(
    userId: string,
    purpose: 'SESSION' | 'OVERRIDE'
  ): { token: string; expiresAt: string } {
    const ttlMs = purpose === 'OVERRIDE' ? 3 * 60 * 1000 : 16 * 60 * 60 * 1000;
    const exp = Date.now() + ttlMs;
    const nonce = randomBytes(12).toString('hex');
    const payload = { uid: userId, purpose, exp, nonce };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sigHex = createHmac('sha256', this.getOrCreateSessionHmacSecret())
      .update(payloadB64)
      .digest('hex');
    return {
      token: `${payloadB64}.${sigHex}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  private verifyAuthToken(rawToken: string, expectedPurpose: 'SESSION' | 'OVERRIDE'): StaffUserDto {
    const parts = rawToken.trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error('HTTP 401 Unauthorized: รูปแบบ Session Token ไม่ถูกต้อง');
    }
    const [payloadB64, providedSigHex] = parts;
    const expectedSigHex = createHmac('sha256', this.getOrCreateSessionHmacSecret())
      .update(payloadB64)
      .digest('hex');

    const providedBuf = Buffer.from(providedSigHex, 'hex');
    const expectedBuf = Buffer.from(expectedSigHex, 'hex');
    if (
      providedBuf.length === 0 ||
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new Error('HTTP 401 Unauthorized: ลายเซ็น Session Token ไม่ถูกต้อง');
    }

    let parsed: { uid?: unknown; purpose?: unknown; exp?: unknown; nonce?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
        uid?: unknown;
        purpose?: unknown;
        exp?: unknown;
        nonce?: unknown;
      };
    } catch {
      throw new Error('HTTP 401 Unauthorized: ไม่สามารถอ่าน Session Token ได้');
    }

    if (
      parsed.purpose !== expectedPurpose ||
      typeof parsed.uid !== 'string' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.nonce !== 'string'
    ) {
      throw new Error('HTTP 401 Unauthorized: ข้อมูล Session Token ไม่สมบูรณ์');
    }
    if (Date.now() >= parsed.exp) {
      throw new Error('HTTP 401 Unauthorized: เซสชันหมดอายุแล้ว กรุณากดรหัส PIN ใหม่');
    }
    if (this.revokedTokenNonces.has(parsed.nonce)) {
      throw new Error('HTTP 401 Unauthorized: เซสชันถูกออกจากระบบแล้ว');
    }

    const activeUser = this.ipc
      .listStaffUsers()
      .find((u) => u.id === parsed.uid && u.active);
    if (!activeUser) {
      throw new Error('HTTP 401 Unauthorized: ไม่พบบัญชีพนักงานหรือบัญชีถูกระงับการใช้งาน');
    }
    return activeUser;
  }

  private resolveRequestSessionUser(req: http.IncomingMessage): StaffUserDto | null {
    const authHeader = req.headers.authorization;
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!raw || !raw.trim()) {
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    if (!match?.[1]) {
      throw new Error('HTTP 401 Unauthorized: ต้องส่ง Bearer Token ในส่วนหัว Authorization');
    }
    return this.verifyAuthToken(match[1], 'SESSION');
  }

  private requireRole(
    sessionUser: StaffUserDto | null,
    allowedRoles: ReadonlyArray<UserRole>
  ): StaffUserDto | null {
    if (sessionUser === null) {
      if (this.enforceApiSessionAuth) {
        throw new Error('HTTP 401 Unauthorized: กรุณายืนยันรหัส PIN พนักงานก่อนทำรายการ');
      }
      return null;
    }
    if (!allowedRoles.includes(sessionUser.role)) {
      throw new Error(
        `HTTP 403 Forbidden: สิทธิ์การใช้งาน (${sessionUser.role}) ไม่ได้รับอนุญาตให้ทำรายการนี้`
      );
    }
    return sessionUser;
  }

  private revokeAuthTokenFromRequest(req: http.IncomingMessage): void {
    const authHeader = req.headers.authorization;
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!raw) return;
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    if (!match?.[1]) return;
    try {
      const payloadB64 = match[1].split('.')[0];
      if (!payloadB64) return;
      const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
        nonce?: unknown;
      };
      if (typeof parsed.nonce === 'string' && parsed.nonce) {
        if (this.revokedTokenNonces.size >= 2000) {
          this.revokedTokenNonces.clear();
        }
        this.revokedTokenNonces.add(parsed.nonce);
      }
    } catch {
      // ignore malformed token on logout
    }
  }

  private getPrinterConfig(): PrinterHardwareConfig {
    try {
      const row = this.engine.executeRead((db) => {
        return db
          .prepare(`SELECT value FROM store_config WHERE key = 'printer_hardware_config'`)
          .get() as { value?: string } | undefined;
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Partial<PrinterHardwareConfig>;
        return {
          mode: parsed.mode ?? DEFAULT_PRINTER_CONFIG.mode,
          tcpHost: parsed.tcpHost ?? DEFAULT_PRINTER_CONFIG.tcpHost,
          tcpPort: Number(parsed.tcpPort ?? DEFAULT_PRINTER_CONFIG.tcpPort),
          windowsPrinterName: parsed.windowsPrinterName ?? '',
          paperWidthMm: parsed.paperWidthMm === 58 ? 58 : 80,
          autoKickDrawerOnCash: parsed.autoKickDrawerOnCash !== false,
        };
      }
    } catch {
      // ignore fallback
    }
    return { ...DEFAULT_PRINTER_CONFIG };
  }

  private async savePrinterConfig(cfg: PrinterHardwareConfig): Promise<PrinterHardwareConfig> {
    const clean: PrinterHardwareConfig = {
      mode: cfg.mode,
      tcpHost: cfg.tcpHost.trim() || '192.168.1.200',
      tcpPort: Math.max(1, Math.min(65535, Number(cfg.tcpPort || 9100))),
      windowsPrinterName: cfg.windowsPrinterName.trim(),
      paperWidthMm: cfg.paperWidthMm === 58 ? 58 : 80,
      autoKickDrawerOnCash: cfg.autoKickDrawerOnCash !== false,
    };
    await this.engine.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by)
         VALUES ('printer_hardware_config', ?, 0, 'USR-OWNER-01')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(JSON.stringify(clean));
    });
    return clean;
  }

  private getHeldBillsForOutlet(outletId = 'OUTLET-HQ'): Array<Record<string, unknown>> {
    try {
      const cfgKey = `held_bills_${outletId}`;
      const row = this.engine.executeRead((db) => {
        return db
          .prepare(`SELECT value FROM store_config WHERE key = ?`)
          .get(cfgKey) as { value?: string } | undefined;
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed)) {
          return parsed as Array<Record<string, unknown>>;
        }
      }
    } catch {
      // ignore fallback
    }
    return [];
  }

  private parseHeldBillsJson(raw: string | undefined): Array<Record<string, unknown>> {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }

  private async upsertHeldBillForOutlet(
    outletId: string,
    bill: Record<string, unknown>,
    actorUserId = 'USR-CASHIER-01'
  ): Promise<Array<Record<string, unknown>>> {
    const cfgKey = `held_bills_${outletId}`;
    return this.engine.executeWriteImmediate((db) => {
      const existingRow = db
        .prepare(`SELECT value FROM store_config WHERE key = ?`)
        .get(cfgKey) as { value?: string } | undefined;
      const list = this.parseHeldBillsJson(existingRow?.value);
      const rawId =
        typeof bill.id === 'string'
          ? bill.id.trim()
          : bill.id !== undefined && bill.id !== null
            ? String(bill.id).trim()
            : '';
      const billId = rawId || `HOLD-${Date.now()}-${randomBytes(3).toString('hex')}`;
      const cleanBill = { ...bill, id: billId, outletId };
      const filtered = list.filter((item) => String(item.id) !== billId);
      const next = [cleanBill, ...filtered].slice(0, 100);
      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(cfgKey, JSON.stringify(next), actorUserId);
      return next;
    });
  }

  private async deleteHeldBillForOutlet(
    outletId: string,
    billId: string,
    actorUserId = 'USR-CASHIER-01',
    requireExisted = false
  ): Promise<Array<Record<string, unknown>>> {
    const cfgKey = `held_bills_${outletId}`;
    return this.engine.executeWriteImmediate((db) => {
      const existingRow = db
        .prepare(`SELECT value FROM store_config WHERE key = ?`)
        .get(cfgKey) as { value?: string } | undefined;
      const list = this.parseHeldBillsJson(existingRow?.value);
      const next = list.filter((item) => String(item.id) !== billId);
      if (requireExisted && next.length === list.length) {
        throw new Error('HTTP 409 บิลพักนี้ถูกเรียกใช้งานจากเครื่องอื่นไปแล้ว');
      }
      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(cfgKey, JSON.stringify(next), actorUserId);
      return next;
    });
  }

  private getProductImagesMap(): Record<string, string> {
    try {
      const row = this.engine.executeRead((db) => {
        return db
          .prepare(`SELECT value FROM store_config WHERE key = 'catalog_product_images'`)
          .get() as { value?: string } | undefined;
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, string>;
        }
      }
    } catch {
      // ignore fallback
    }
    return {};
  }

  private hydrateCatalogVariantImages<T extends { id: string }>(
    variants: T[]
  ): Array<T & { imageUrl: string | null }> {
    const imgMap = this.getProductImagesMap();
    return variants.map((v) => {
      const fname = imgMap[v.id];
      return {
        ...v,
        imageUrl: fname ? `/api/catalog/image/${encodeURIComponent(fname)}` : null,
      };
    });
  }

  private async saveOrRemoveProductImage(
    variantId: string,
    dataUrl: string | null,
    actorUserId = 'USR-OWNER-01'
  ): Promise<string | null> {
    const safeVariantId = variantId.replace(/[^A-Za-z0-9_-]/g, '');
    if (!safeVariantId) throw new Error('Invalid variantId');

    let nextFilename: string | null = null;

    if (dataUrl && dataUrl.trim()) {
      const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
        dataUrl.trim()
      );
      if (!match) {
        throw new Error('รองรับเฉพาะไฟล์รูปภาพ JPEG, PNG หรือ WebP เท่านั้น');
      }
      const mime = match[1]!;
      const b64 = match[2]!;
      const buf = Buffer.from(b64, 'base64');
      if (buf.byteLength > 2 * 1024 * 1024) {
        throw new Error('ขนาดรูปภาพใหญ่เกิน 2 MB กรุณาเลือกรูปที่เล็กลง');
      }
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      nextFilename = `${safeVariantId}-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`;
      fs.mkdirSync(this.productImagesDir, { recursive: true });
      fs.writeFileSync(path.join(this.productImagesDir, nextFilename), buf);
    }

    let prevFilename: string | undefined;
    try {
      prevFilename = await this.engine.executeWriteImmediate((db) => {
        const row = db
          .prepare(`SELECT value FROM store_config WHERE key = 'catalog_product_images'`)
          .get() as { value?: string } | undefined;
        let imgMap: Record<string, string> = {};
        if (row?.value) {
          try {
            const parsed = JSON.parse(row.value) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              imgMap = parsed as Record<string, string>;
            }
          } catch {
            imgMap = {};
          }
        }
        const existing = imgMap[variantId];
        if (nextFilename) {
          imgMap[variantId] = nextFilename;
        } else {
          delete imgMap[variantId];
        }
        db.prepare(
          `INSERT INTO store_config (key, value, is_protected, updated_by)
           VALUES ('catalog_product_images', ?, 0, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        ).run(JSON.stringify(imgMap), actorUserId);
        return existing;
      });
    } catch (err) {
      if (nextFilename) {
        try {
          const orphanPath = path.join(this.productImagesDir, path.basename(nextFilename));
          if (fs.existsSync(orphanPath)) {
            fs.unlinkSync(orphanPath);
          }
        } catch {
          // ignore orphan cleanup failure
        }
      }
      throw err;
    }

    if (prevFilename && prevFilename !== nextFilename) {
      try {
        const oldFull = path.join(this.productImagesDir, path.basename(prevFilename));
        if (fs.existsSync(oldFull)) {
          fs.unlinkSync(oldFull);
        }
      } catch {
        // ignore cleanup failure
      }
    }

    return nextFilename ? `/api/catalog/image/${encodeURIComponent(nextFilename)}` : null;
  }

  private async ensureSeededIfAppropriate(): Promise<void> {
    if (this.seeded) {
      return;
    }
    if (this.requireFirstRunWizard && !this.ipc.isSystemOnboarded()) {
      return;
    }
    if (this.seedingPromise) {
      return this.seedingPromise;
    }
    this.seedingPromise = (async () => {
      if (!this.seeded && !this.ipc.isSystemOnboarded()) {
        await this.engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      }
      if (this.ipc.isSystemOnboarded()) {
        this.seeded = true;
      }
    })();
    try {
      await this.seedingPromise;
    } finally {
      this.seedingPromise = null;
    }
  }

  private async ensureActiveShiftOpen(outletId = 'OUTLET-HQ'): Promise<void> {
    if (this.requireFirstRunWizard && !this.ipc.isSystemOnboarded()) {
      return;
    }
    await this.ensureSeededIfAppropriate();
    if (!this.ipc.isSystemOnboarded()) {
      return;
    }
    if (this.ipc.getActiveShift(outletId, 'POS-TERM-01')) {
      return;
    }
    const inflight = this.openingShiftByOutlet.get(outletId);
    if (inflight) {
      return inflight;
    }

    const openTask = (async () => {
      const active = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
      if (active) {
        return;
      }
      const users = this.ipc.listStaffUsers();
      const openerId =
        users.find((u) => u.id === 'USR-CASHIER-01')?.id ??
        users[0]?.id ??
        'USR-OWNER-01';
      await this.executeWithUniqueDocRetry('shift_number', async () => {
        const shiftNo = `SHF-LIVE-${String(this.shiftSequenceCounter++).padStart(3, '0')}`;
        try {
          await this.ipc.openPosShift({
            outletId,
            terminalId: 'POS-TERM-01',
            shiftNumber: shiftNo,
            openedByUserId: openerId,
            openingCashSatang: 100_000,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('already OPEN')) {
            return;
          }
          throw err;
        }
      });
    })();

    this.openingShiftByOutlet.set(outletId, openTask);
    try {
      await openTask;
    } finally {
      this.openingShiftByOutlet.delete(outletId);
    }
  }

  private probeDirectoryWritable(dirPath: string): { ok: boolean; error?: string } {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const probeFile = path.join(
        dirPath,
        `.rube_write_probe_${process.pid}_${Date.now()}.tmp`
      );
      fs.writeFileSync(probeFile, 'RUBE_PROBE');
      fs.unlinkSync(probeFile);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private readStoredUsbBackupConfig(): {
    customBackupDir: string;
    mirrorToLocalFallback: boolean;
  } {
    try {
      const row = this.engine.executeRead((db) => {
        return db
          .prepare(`SELECT value FROM store_config WHERE key = 'usb_backup_config'`)
          .get() as { value?: string } | undefined;
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as {
          customBackupDir?: unknown;
          mirrorToLocalFallback?: unknown;
        };
        return {
          customBackupDir:
            typeof parsed.customBackupDir === 'string' ? parsed.customBackupDir.trim() : '',
          mirrorToLocalFallback: parsed.mirrorToLocalFallback !== false,
        };
      }
    } catch {
      // ignore fallback
    }
    return { customBackupDir: '', mirrorToLocalFallback: true };
  }

  private getUsbBackupConfigStatus(runWriteProbe = false): UsbBackupConfigStatusDto {
    const stored = this.readStoredUsbBackupConfig();
    const customDir = stored.customBackupDir;
    const isCustomNormalizedDiff =
      Boolean(customDir) &&
      path.resolve(customDir).toLowerCase() !==
        path.resolve(this.defaultUsbBackupDir).toLowerCase();

    let targetWritable = true;
    let activeEffectiveDir = this.defaultUsbBackupDir;

    if (customDir) {
      if (runWriteProbe) {
        const probe = this.probeDirectoryWritable(customDir);
        targetWritable = probe.ok;
        this.lastUsbWriteProbeCache = {
          dir: customDir,
          ok: probe.ok,
          checkedAtMs: Date.now(),
        };
      } else {
        const dirExists = fs.existsSync(customDir);
        if (this.lastUsbWriteProbeCache && this.lastUsbWriteProbeCache.dir === customDir) {
          targetWritable = dirExists && this.lastUsbWriteProbeCache.ok;
        } else {
          targetWritable = dirExists;
        }
      }
      if (targetWritable) {
        activeEffectiveDir = customDir;
      }
    }

    return {
      customBackupDir: customDir,
      defaultLocalBackupDir: this.defaultUsbBackupDir,
      activeEffectiveDir,
      isExternalCustomDir: isCustomNormalizedDiff,
      targetWritable,
      mirrorToLocalFallback: stored.mirrorToLocalFallback,
    };
  }

  private async saveUsbBackupConfig(params: {
    customBackupDir: string;
    mirrorToLocalFallback?: boolean | undefined;
    actorUserId?: string | undefined;
  }): Promise<UsbBackupConfigStatusDto> {
    const trimmedDir = params.customBackupDir.trim();
    if (trimmedDir) {
      if (!path.isAbsolute(trimmedDir)) {
        throw new Error(
          'พาธโฟลเดอร์สำรองข้อมูลต้องเป็นพาธเต็ม (Absolute Path เช่น E:\\RubePOS_Backups)'
        );
      }
      const lower = path.resolve(trimmedDir).toLowerCase();
      if (
        lower.includes('\\windows\\') ||
        lower.endsWith('\\windows') ||
        lower.includes('\\system32') ||
        lower.includes('\\program files')
      ) {
        throw new Error('ไม่อนุญาตให้เลือกโฟลเดอร์ระบบ Windows เป็นปลายทางสำรองข้อมูล');
      }
      const probe = this.probeDirectoryWritable(trimmedDir);
      if (!probe.ok) {
        throw new Error(
          `ไม่สามารถเขียนไฟล์ลงโฟลเดอร์ "${trimmedDir}" ได้ (${probe.error ?? 'กรุณาตรวจสอบว่าเสียบแฟลชไดรฟ์ USB แล้ว'})`
        );
      }
    }

    const nextCfg = {
      customBackupDir: trimmedDir,
      mirrorToLocalFallback: params.mirrorToLocalFallback !== false,
    };
    await this.engine.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO store_config (key, value, is_protected, updated_by)
         VALUES ('usb_backup_config', ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(JSON.stringify(nextCfg), params.actorUserId ?? 'USR-OWNER-01');
    });

    return this.getUsbBackupConfigStatus(true);
  }

  private async listWindowsStorageDrives(): Promise<DiscoveredStorageDriveDto[]> {
    if (process.platform !== 'win32') {
      return [];
    }
    try {
      const psScript =
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,FreeSpace,Size | ConvertTo-Json -Compress';
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 5_000, windowsHide: true }
      );
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed) as
        | Record<string, unknown>
        | Array<Record<string, unknown>>;
      const rows = Array.isArray(parsed) ? parsed : [parsed];

      const drives: DiscoveredStorageDriveDto[] = [];
      for (const r of rows) {
        const deviceId = String(r.DeviceID ?? '').trim();
        if (!deviceId) continue;
        const driveType = Number(r.DriveType ?? 0);
        const driveKind: DiscoveredStorageDriveDto['driveKind'] =
          driveType === 2
            ? 'REMOVABLE_USB'
            : driveType === 3
              ? 'FIXED_DISK'
              : driveType === 4
                ? 'NETWORK_DRIVE'
                : 'OTHER';
        drives.push({
          driveLetter: deviceId,
          volumeName: String(r.VolumeName ?? '').trim(),
          driveKind,
          freeBytes: Math.max(0, Number(r.FreeSpace ?? 0)),
          totalBytes: Math.max(0, Number(r.Size ?? 0)),
          suggestedBackupPath: `${deviceId}\\RubePOS_Backups`,
        });
      }

      const priority: Record<DiscoveredStorageDriveDto['driveKind'], number> = {
        REMOVABLE_USB: 0,
        NETWORK_DRIVE: 1,
        FIXED_DISK: 2,
        OTHER: 3,
      };
      return drives.sort((a, b) => {
        const diff = priority[a.driveKind] - priority[b.driveKind];
        return diff !== 0 ? diff : a.driveLetter.localeCompare(b.driveLetter);
      });
    } catch {
      return [];
    }
  }

  private async executeResilientBackupForLabel(shiftOrManualLabel: string): Promise<{
    usbBackup: {
      writtenBackupPath: string;
      evictedOldestBackupPath: string | null;
      retainedBackupsCount: number;
      cleanedOrphanedPartFilesCount: number;
    };
    usedFallbackLocal: boolean;
    backupWarningThai?: string | undefined;
  }> {
    const stored = this.readStoredUsbBackupConfig();
    const customDir = stored.customBackupDir;

    if (customDir) {
      try {
        const primary = await this.ipc.exportEncryptedUsbBackupWithRingBuffer(
          customDir,
          shiftOrManualLabel
        );
        this.lastUsbWriteProbeCache = {
          dir: customDir,
          ok: true,
          checkedAtMs: Date.now(),
        };
        if (
          stored.mirrorToLocalFallback &&
          path.resolve(customDir).toLowerCase() !==
            path.resolve(this.defaultUsbBackupDir).toLowerCase()
        ) {
          await this.ipc
            .exportEncryptedUsbBackupWithRingBuffer(this.defaultUsbBackupDir, shiftOrManualLabel)
            .catch(() => {});
        }
        return {
          usbBackup: primary,
          usedFallbackLocal: false,
        };
      } catch {
        this.lastUsbWriteProbeCache = {
          dir: customDir,
          ok: false,
          checkedAtMs: Date.now(),
        };
        const fallback = await this.ipc.exportEncryptedUsbBackupWithRingBuffer(
          this.defaultUsbBackupDir,
          shiftOrManualLabel
        );
        return {
          usbBackup: fallback,
          usedFallbackLocal: true,
          backupWarningThai: `ไม่พบหรือเขียนข้อมูลลงไดรฟ์สำรองภายนอก (${customDir}) ไม่ได้ — ระบบสำรองข้อมูลลงโฟลเดอร์สำรองในเครื่องชั่วคราวแล้ว กรุณาตรวจสอบแฟลชไดรฟ์ USB`,
        };
      }
    }

    const usbBackup = await this.ipc.exportEncryptedUsbBackupWithRingBuffer(
      this.defaultUsbBackupDir,
      shiftOrManualLabel
    );
    return {
      usbBackup,
      usedFallbackLocal: false,
    };
  }

  private listUsbBackupFiles(): Array<{ filename: string; sizeBytes: number; modifiedAt: string }> {
    const status = this.getUsbBackupConfigStatus();
    const dirsToTry =
      status.activeEffectiveDir !== this.defaultUsbBackupDir
        ? [status.activeEffectiveDir, this.defaultUsbBackupDir]
        : [this.defaultUsbBackupDir];

    for (const dir of dirsToTry) {
      try {
        if (!fs.existsSync(dir)) continue;
        return fs
          .readdirSync(dir)
          .filter((f) => f.startsWith('rube_backup_'))
          .map((filename) => {
            const full = path.join(dir, filename);
            const st = fs.statSync(full);
            return {
              filename,
              sizeBytes: st.size,
              modifiedAt: st.mtime.toISOString(),
            };
          })
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      } catch {
        // try next directory
      }
    }
    return [];
  }

  private isValidOverrideLineTotalSatang(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }

  private computeCartTotals(
    lines: Array<{
      variantId: string;
      itemName?: string | undefined;
      unitName?: string | undefined;
      quantityMilli: number;
      unitPriceSatang: number;
      overrideLineTotalSatang?: number | undefined;
      selectedModifierIds?: string[] | undefined;
    }>,
    discountSatang: number,
    taxMode: TaxMode,
    options?: { applyCashRounding?: boolean | undefined }
  ) {
    const fiscal = this.ipc.getFiscalConfig();
    const modifiersMap = new Map(this.ipc.listModifiers().map((m) => [m.id, m]));
    let subtotalSatang = 0;

    const formattedLines = lines.map((line) => {
      const mods = (line.selectedModifierIds ?? [])
        .map((id) => modifiersMap.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined);
      const singleUnitModPriceSatang = mods.reduce((sum, m) => sum + m.priceDeltaSatang, 0);
      const baseLinePriceSatang = Number(
        roundDivBigInt(BigInt(line.quantityMilli) * BigInt(line.unitPriceSatang), SCALE_MILLI)
      );
      const modifiersTotalSatang = Number(
        roundDivBigInt(
          BigInt(line.quantityMilli) * BigInt(singleUnitModPriceSatang),
          SCALE_MILLI
        )
      );
      const lineTotalSatang = this.isValidOverrideLineTotalSatang(line.overrideLineTotalSatang)
        ? line.overrideLineTotalSatang
        : Math.max(0, baseLinePriceSatang + modifiersTotalSatang);
      subtotalSatang += lineTotalSatang;
      const modsJoined = mods.map((m) => m.name).join(', ');
      const defaultUnit = fiscal.countryCode === 'LA' ? 'ອັນ' : 'ชิ้น';
      return {
        itemName: line.itemName ?? line.variantId,
        quantityFormatted: formatMilliUnitsToQtyString(
          line.quantityMilli,
          line.unitName ?? defaultUnit
        ),
        lineTotalFormatted: formatMoney(lineTotalSatang, fiscal.currencyCode),
        ...(modsJoined ? { modifiersText: modsJoined } : {}),
      };
    });

    const financials = computeOrderFinancialTotals({
      subtotalSatang,
      discountSatang: Math.max(0, discountSatang),
      vatRateBps: fiscal.vatRateBps,
      taxMode,
      currencyCode: fiscal.currencyCode,
      applyCashRounding: Boolean(options?.applyCashRounding),
      cashRoundingStepMajor: fiscal.cashRoundingStepMajor,
    });

    return {
      subtotalSatang: financials.subtotalSatang,
      discountSatang: financials.effectiveDiscountSatang,
      cashRoundingDiscountSatang: financials.cashRoundingDiscountSatang,
      taxSatang: financials.taxSatang,
      netBeforeTaxSatang: financials.netBeforeTaxSatang,
      totalSatang: financials.totalSatang,
      formattedLines,
      fiscal,
    };
  }

  private formatZReportForUi(z: ShiftZReportDto) {
    const fiscal = this.ipc.getFiscalConfig();
    const money = (satang: number) => formatMoney(satang, fiscal.currencyCode);
    return {
      ...z,
      openingCashFormatted: money(z.openingCashSatang),
      grossSalesFormatted: money(z.grossSalesSatang),
      discountsFormatted: money(z.discountTotalSatang),
      netBeforeTaxFormatted: money(z.netBeforeTaxSatang),
      vat7PercentFormatted: money(z.vatTotalSatang),
      netSalesTotalFormatted: money(z.netSalesTotalSatang),
      cashSalesFormatted: money(z.cashSalesSatang),
      promptPaySalesFormatted: money(z.promptPayQrSalesSatang),
      cardSalesFormatted: money(z.cardSalesSatang),
      voucherSalesFormatted: money(z.voucherSalesSatang),
      paidInFormatted: money(z.paidInSatang),
      paidOutFormatted: money(z.paidOutSatang),
      cashDropFormatted: money(z.cashDropSatang),
      voidedTotalFormatted: money(z.voidedTotalSatang),
      expectedDrawerCashFormatted: money(z.expectedCashSatang),
      countedDrawerCashFormatted: z.countedCashSatang === null ? null : money(z.countedCashSatang),
      cashVarianceFormatted: z.cashVarianceSatang === null ? null : money(z.cashVarianceSatang),
      ...(z.fxCashSummary
        ? {
            fxCashSummaryFormatted: {
              ...z.fxCashSummary,
              thbCollectedFormatted: formatForeignMoney(z.fxCashSummary.thbCollectedSatang, 'THB'),
              thbEquivalentFormatted: money(z.fxCashSummary.thbEquivalentBaseSatang),
              usdCollectedFormatted: formatForeignMoney(z.fxCashSummary.usdCollectedSatang, 'USD'),
              usdEquivalentFormatted: money(z.fxCashSummary.usdEquivalentBaseSatang),
              totalForeignEquivalentFormatted: money(
                z.fxCashSummary.totalForeignEquivalentBaseSatang
              ),
              expectedNativeBaseCashFormatted: money(
                z.fxCashSummary.expectedNativeBaseCashInDrawerSatang
              ),
            },
          }
        : {}),
    };
  }

  private formatAbbReportForUi(abb: AbbSalesTaxReportDto) {
    const fiscal = this.ipc.getFiscalConfig();
    const money = (satang: number) => formatMoney(satang, fiscal.currencyCode);
    return {
      ...abb,
      totalTaxableBaseFormatted: money(abb.totalNetBeforeTaxSatang),
      totalVatFormatted: money(abb.totalVatSatang),
      totalGrossFormatted: money(abb.totalGrossAmountSatang),
      invoices: abb.invoices.map((inv) => ({
        ...inv,
        netBeforeTaxFormatted: money(inv.netBeforeTaxSatang),
        taxFormatted: money(inv.taxSatang),
        totalFormatted: money(inv.totalSatang),
      })),
    };
  }

  private formatValuationReportForUi(val: InventoryValuationReportDto) {
    const fiscal = this.ipc.getFiscalConfig();
    return {
      ...val,
      totalWarehouseValuationFormatted: formatMoney(
        val.totalWarehouseValuationSatang,
        fiscal.currencyCode
      ),
      lines: val.lines.map((l) => ({
        ...l,
        stockFormatted: formatMilliUnitsToQtyString(l.inStockMilli, l.unitName),
        macFormatted: formatMicroUnitCost(l.averageCostMicroBaht, fiscal.currencyCode),
        valuationFormatted: formatMoney(l.totalValuationSatang, fiscal.currencyCode),
      })),
    };
  }

  private formatMarginReportForUi(m: MenuGrossMarginReportDto) {
    const fiscal = this.ipc.getFiscalConfig();
    const money = (satang: number) => formatMoney(satang, fiscal.currencyCode);
    const totalGpBps =
      m.totalRevenueSatang > 0
        ? Number(
            roundDivBigInt(
              BigInt(m.totalGrossProfitSatang) * SCALE_BASIS_POINTS,
              BigInt(m.totalRevenueSatang)
            )
          )
        : 0;
    return {
      ...m,
      totalRevenueFormatted: money(m.totalRevenueSatang),
      totalCogsFormatted: money(m.totalCogsSatang),
      totalGrossProfitFormatted: money(m.totalGrossProfitSatang),
      totalGrossMarginPercentFormatted: `${(totalGpBps / 100).toFixed(2)}%`,
      lines: m.lines.map((l) => ({
        ...l,
        soldQtyFormatted: formatMilliUnitsToQtyString(l.soldQtyMilli),
        revenueFormatted: money(l.grossRevenueSatang),
        cogsFormatted: money(l.totalCogsSatang),
        grossProfitFormatted: money(l.grossProfitSatang),
        grossMarginPercentFormatted: `${(l.grossMarginBasisPoints / 100).toFixed(2)}%`,
      })),
    };
  }

  private async readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB safety limit
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        throw new Error('HTTP 413 Payload Too Large: ขนาดคำขอเกินขีดจำกัด 5 MB');
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private isAllowedLocalOrigin(origin: string): boolean {
    const trimmed = origin.trim();
    if (!trimmed) return false;
    return (
      /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(trimmed) ||
      /^https?:\/\/([a-z0-9-]+\.)?tauri\.localhost(:\d+)?$/i.test(trimmed) ||
      /^tauri:\/\/localhost$/i.test(trimmed)
    );
  }

  private setCorsHeaders(res: http.ServerResponse, req?: http.IncomingMessage): void {
    const request = req ?? (res as unknown as { req?: http.IncomingMessage }).req;
    const originHeader = request?.headers?.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (origin && this.isAllowedLocalOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Rube-Override-Token'
      );
    }
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    this.setCorsHeaders(res);
    const body = JSON.stringify(payload, (_key, val) =>
      typeof val === 'bigint' ? val.toString() : val
    );
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  private tryServeStaticUi(
    pathname: string,
    res: http.ServerResponse,
    req?: http.IncomingMessage
  ): boolean {
    const distDir = path.resolve(__dirname, '../../dist');
    const distIndex = path.join(distDir, 'index.html');
    const fallbackHtml = path.resolve(__dirname, '../web/index.html');

    if (fs.existsSync(distIndex)) {
      if (pathname === '/' || pathname === '/index.html') {
        this.setCorsHeaders(res, req);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(fs.readFileSync(distIndex));
        return true;
      }

      const safeRel = path
        .normalize(pathname)
        .replace(/^(\.\.(\/|\\|$))+/, '')
        .replace(/^[/\\]+/, '');
      const candidate = path.join(distDir, safeRel);
      if (
        candidate.startsWith(distDir) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
      ) {
        const ext = path.extname(candidate).toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
        this.setCorsHeaders(res, req);
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        });
        res.end(fs.readFileSync(candidate));
        return true;
      }
    } else if (pathname === '/' || pathname === '/index.html') {
      this.setCorsHeaders(res, req);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(fallbackHtml, 'utf8'));
      return true;
    }

    return false;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const hostHeader = req.headers.host;
      const requestHost = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)?.trim() ?? '';
      if (requestHost && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(requestHost)) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'HTTP 403 Forbidden: Untrusted Host header blocked (DNS rebinding protection)',
          })
        );
        return;
      }

      const originHeader = req.headers.origin;
      const requestOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
      if (requestOrigin && !this.isAllowedLocalOrigin(requestOrigin)) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({ error: 'HTTP 403 Forbidden: Untrusted cross-origin request blocked' })
        );
        return;
      }

      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite === 'cross-site' && (!requestOrigin || !this.isAllowedLocalOrigin(requestOrigin))) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'HTTP 403 Forbidden: Cross-site request blocked' }));
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';

      if (method === 'OPTIONS') {
        this.setCorsHeaders(res, req);
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (this.tryServeStaticUi(url.pathname, res, req)) {
          return;
        }
      }

      const sessionUser =
        url.pathname === '/api/auth/pin-login' ||
        url.pathname === '/api/auth/logout' ||
        url.pathname.startsWith('/api/catalog/image/')
          ? null
          : this.resolveRequestSessionUser(req);

      if (
        (method === 'POST' || method === 'PUT' || method === 'DELETE') &&
        url.pathname !== '/api/hal/ups-state' &&
        url.pathname !== '/api/auth/pin-login' &&
        url.pathname !== '/api/auth/logout' &&
        this.upsMonitor.isWriteLockedByLowBattery()
      ) {
        throw new Error(
          'HTTP 423 Locked: ระบบอยู่ในโหมดป้องกันไฟดับ (แบตเตอรี่ UPS ต่ำมาก)'
        );
      }

      // ----------------------------------------------------------------------
      // 0. First-Run Setup Wizard & Production Clean-Start Onboarding
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/onboarding/preview-wizard') {
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{ show: boolean }>(req);
        this.forceWizardPreview = Boolean(body.show);
        this.sendJson(res, 200, { ok: true, forceWizardPreview: this.forceWizardPreview });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/onboarding/complete') {
        if (this.ipc.isSystemOnboarded()) {
          this.requireRole(sessionUser, ['OWNER']);
        }
        const body = await this.readJsonBody<
          FirstRunOnboardingInput & {
            recoveryPassphrase: string;
            printerConfig?: Partial<PrinterHardwareConfig>;
          }
        >(req);

        const responsePayload = await this.enqueueOnboarding(async () => {
          if (this.ipc.isSystemOnboarded()) {
            this.requireRole(sessionUser, ['OWNER']);
          }
          const onboardRes = await this.ipc.initializeFirstRunOnboarding(body);
          this.forceWizardPreview = false;

          if (body.printerConfig) {
            await this.savePrinterConfig({
              ...this.getPrinterConfig(),
              ...body.printerConfig,
            });
          }

          await this.ensureSessionHmacSecretPersisted();
          const issuedSession = this.issueAuthToken(onboardRes.ownerUser.id, 'SESSION');

          const machineSecret = `WIN11-DPAPI-${os.hostname()}-POS-TERM-01`;
          const keystoreManifest = KeystoreEnvelopeManager.initializeDualKekManifest({
            manifestPath: this.keystoreManifestPath,
            rawHexKey64: DEV_SQLCIPHER_RAW_HEX_KEY_64,
            machineDpapiSecret: machineSecret,
            ownerRecoveryPassphrase: body.recoveryPassphrase,
          });

          const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const recoveryKitFilename = `RubePOS_RecoveryKit_${body.taxId.replace(/\D/g, '') || 'STORE'}_${dateTag}.recovery-kit`;
          const recoveryKitContent = JSON.stringify(
            {
              recoveryKitVersion: '3.1.1',
              product: 'RUBE-STOCK-POS',
              storeName: onboardRes.storeSettings.storeName,
              taxId: onboardRes.storeSettings.taxId,
              exportedAt: new Date().toISOString(),
              keyId: keystoreManifest.keyId,
              dekFingerprintSha256Hex: keystoreManifest.dekFingerprintSha256Hex,
              argon2RecoverySlot: keystoreManifest.argon2RecoverySlot,
            },
            null,
            2
          );

          return {
            ok: true,
            ...onboardRes,
            recoveryKitFilename,
            recoveryKitContent,
            sessionToken: issuedSession.token,
            expiresAt: issuedSession.expiresAt,
          };
        });

        this.sendJson(res, 200, responsePayload);
        return;
      }

      // ----------------------------------------------------------------------
      // 1. Bootstrap & System State
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/bootstrap') {
        const isCurrentlyOnboarded = this.ipc.isSystemOnboarded();
        const isPreviewWizard = this.forceWizardPreview && isCurrentlyOnboarded;
        if ((this.requireFirstRunWizard && !isCurrentlyOnboarded) || this.forceWizardPreview) {
          const previewFiscalConfig = this.ipc.getFiscalConfig();
          const previewStoreSettings = isCurrentlyOnboarded
            ? this.ipc.getStoreIdentitySettings('OUTLET-HQ')
            : {
                outletId: 'OUTLET-HQ',
                outletCode: 'HQ-01',
                storeName: '',
                storeAddress: '',
                taxId: '',
                branchCode: '00000',
                rdPosRegNo: '',
                promptPayId: '',
                businessProfile: 'HYBRID' as BusinessProfile,
                fiscalConfig: previewFiscalConfig,
              };
          const previewProfile = previewStoreSettings.businessProfile;
          this.sendJson(res, 200, {
            onboarded: false,
            isSessionAuthenticated: Boolean(sessionUser) || !this.enforceApiSessionAuth,
            isPreviewWizard,
            profile: previewProfile,
            fiscalConfig: previewFiscalConfig,
            featureFlags: resolveProfileFeatureFlags(previewProfile),
            activeShift: null,
            catalog: [],
            catalogDetailed: [],
            categories: [],
            suppliers: [],
            outlets: [],
            bomEdges: [],
            modifiers: [],
            modifierGroups: [],
            kdsTickets: [],
            recentOrders: [],
            heldBills: [],
            shiftsHistory: [],
            drawerMovements: [],
            staffUsers: isCurrentlyOnboarded ? this.ipc.listStaffUsers() : [],
            storeSettings: previewStoreSettings,
            printerConfig: this.getPrinterConfig(),
            usbBackupConfig: this.getUsbBackupConfigStatus(),
            usbBackups: this.listUsbBackupFiles(),
            ledgerInvariant: { valid: true, mismatches: [] },
            upsBanner: this.upsMonitor.getActiveUiAlertBanner(),
            printer: {
              ready: this.printerSpooler.isPrinterReady(),
              pendingQueueLength: this.printerSpooler.getPendingQueueLength(),
            },
            cluster: {
              operatingMode: this.clusterCoordinator.getOperatingMode(),
              roleState: this.clusterCoordinator.getRoleState(),
              currentEpoch: this.clusterCoordinator.getCurrentEpoch(),
              terminalId: this.clusterCoordinator.getTerminalId(),
              globalTxSeq: this.clusterCoordinator.getGlobalTxSeq(),
              ipcStats: {
                readsRouted: this.ipc.totalReadsRouted,
                writesRouted: this.ipc.totalWritesRouted,
              },
            },
          });
          return;
        }

        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        if (this.enforceApiSessionAuth && isCurrentlyOnboarded && !sessionUser) {
          const { profile, featureFlags } =
            this.securityController.getActiveProfileWithFeatureFlags();
          const rawSettings = this.ipc.getStoreIdentitySettings(outletId);
          const lockedFiscal = this.ipc.getFiscalConfig();
          this.sendJson(res, 200, {
            onboarded: true,
            isSessionAuthenticated: false,
            profile,
            fiscalConfig: {
              ...lockedFiscal,
              laoQrStaticTemplate: lockedFiscal.laoQrStaticTemplate ? 'CONFIGURED' : '',
            },
            featureFlags,
            activeShift: null,
            catalog: [],
            catalogDetailed: [],
            categories: [],
            suppliers: [],
            outlets: this.ipc.listOutlets(),
            bomEdges: [],
            modifiers: [],
            modifierGroups: [],
            kdsTickets: [],
            recentOrders: [],
            heldBills: [],
            shiftsHistory: [],
            drawerMovements: [],
            staffUsers: this.ipc.listStaffUsers(),
            storeSettings: {
              ...rawSettings,
              promptPayId: '',
            },
            printerConfig: this.getPrinterConfig(),
            usbBackupConfig: this.getUsbBackupConfigStatus(),
            usbBackups: [],
            ledgerInvariant: { valid: true, mismatches: [] },
            upsBanner: this.upsMonitor.getActiveUiAlertBanner(),
            printer: {
              ready: this.printerSpooler.isPrinterReady(),
              pendingQueueLength: this.printerSpooler.getPendingQueueLength(),
            },
            cluster: {
              operatingMode: this.clusterCoordinator.getOperatingMode(),
              roleState: this.clusterCoordinator.getRoleState(),
              currentEpoch: this.clusterCoordinator.getCurrentEpoch(),
              terminalId: this.clusterCoordinator.getTerminalId(),
              globalTxSeq: this.clusterCoordinator.getGlobalTxSeq(),
              ipcStats: {
                readsRouted: this.ipc.totalReadsRouted,
                writesRouted: this.ipc.totalWritesRouted,
              },
            },
          });
          return;
        }

        const autoOpenShift = url.searchParams.get('autoOpenShift') !== 'false';
        if (autoOpenShift) {
          await this.ensureActiveShiftOpen(outletId);
        } else {
          await this.ensureSeededIfAppropriate();
        }

        const { profile, featureFlags } =
          this.securityController.getActiveProfileWithFeatureFlags();
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        const catalog = this.ipc.getInventoryCatalog(outletId);
        const catalogDetailed = this.hydrateCatalogVariantImages(
          this.ipc.listCatalogVariantsDetailed(outletId)
        );
        const categories = this.ipc.listCategories();
        const suppliers = this.ipc.listSuppliers();
        const outlets = this.ipc.listOutlets();
        const bomEdges = this.ipc.listBomEdges();
        const modifiers = this.ipc.listModifiers();
        const modifierGroups = this.ipc.listModifierGroupsWithModifiers();
        const kdsTickets = this.ipc.listKitchenOrdersAllStations(outletId, false);
        const recentOrders = this.ipc.listRecentSalesOrders(outletId, 100);
        const heldBills = this.getHeldBillsForOutlet(outletId);
        const shiftsHistory = this.ipc.listShiftsHistory(outletId, 15);
        const drawerMovements = activeShift
          ? this.ipc.listCashDrawerMovements(activeShift.id)
          : [];
        const staffUsers = this.ipc.listStaffUsers();
        const storeSettings = this.ipc.getStoreIdentitySettings(outletId);
        const fiscalConfig = this.ipc.getFiscalConfig();
        const qrOrderingConfig = this.ipc.getQrOrderingConfig();
        const qrOrderingStatus = this.guestQrServer.getRuntimeStatus(qrOrderingConfig);
        const qrGuestOrders = this.ipc.listGuestOrders(outletId);
        const qrTableSessions = this.ipc.listTableQrSessions(outletId, qrOrderingStatus.baseUrl);
        const ledgerInvariant = this.ipc.verifyLedgerConservationInvariant(outletId);
        const upsBanner = this.upsMonitor.getActiveUiAlertBanner();

        this.sendJson(res, 200, {
          onboarded: true,
          isSessionAuthenticated: true,
          profile,
          fiscalConfig,
          featureFlags,
          activeShift,
          catalog,
          catalogDetailed,
          categories,
          suppliers,
          outlets,
          bomEdges,
          modifiers,
          modifierGroups,
          kdsTickets,
          recentOrders,
          heldBills,
          shiftsHistory,
          drawerMovements,
          staffUsers,
          storeSettings,
          printerConfig: this.getPrinterConfig(),
          qrOrderingConfig,
          qrOrderingStatus,
          qrGuestOrders,
          qrTableSessions,
          usbBackupConfig: this.getUsbBackupConfigStatus(),
          usbBackups: this.listUsbBackupFiles(),
          ledgerInvariant,
          upsBanner,
          printer: {
            ready: this.printerSpooler.isPrinterReady(),
            pendingQueueLength: this.printerSpooler.getPendingQueueLength(),
          },
          cluster: {
            operatingMode: this.clusterCoordinator.getOperatingMode(),
            roleState: this.clusterCoordinator.getRoleState(),
            currentEpoch: this.clusterCoordinator.getCurrentEpoch(),
            terminalId: this.clusterCoordinator.getTerminalId(),
            globalTxSeq: this.clusterCoordinator.getGlobalTxSeq(),
            ipcStats: {
              readsRouted: this.ipc.totalReadsRouted,
              writesRouted: this.ipc.totalWritesRouted,
            },
          },
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 2. Physical Printer Config, Windows Printer Discovery, Canvas Raster & Kick Drawer
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/printer/config') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        this.sendJson(res, 200, { printerConfig: this.getPrinterConfig() });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/printer/config') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const body = await this.readJsonBody<PrinterHardwareConfig>(req);
        const saved = await this.savePrinterConfig(body);
        this.sendJson(res, 200, { printerConfig: saved });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/printer/windows-list') {
        if (this.ipc.isSystemOnboarded()) {
          this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        }
        const printers = await listWindowsInstalledPrinters();
        this.sendJson(res, 200, { printers });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/kick-drawer') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const cfg = this.getPrinterConfig();
        const outcome = await this.enqueueHardwarePrint(() =>
          dispatchEscPosPayloadToHardware(
            cfg,
            ESC_POS_KICK_DRAWER_BYTES,
            'RUBE-POS Cash Drawer Kick'
          )
        );
        this.sendJson(res, 200, { ok: true, outcome });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/print-canvas-raster') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          packedBitmapBase64: string;
          widthPx: 384 | 576;
          heightPx: number;
          kickCashDrawer?: boolean;
          salesOrderId?: string;
          receiptNumber?: string;
        }>(req);

        const bitmapBytes = new Uint8Array(Buffer.from(body.packedBitmapBase64, 'base64'));
        const cfg = this.getPrinterConfig();
        const renderedJob = buildEscPosWireJobFrom1BitBitmap({
          packedMonochromeBitmap: bitmapBytes,
          widthPx: body.widthPx,
          heightPx: body.heightPx,
          kickCashDrawer: Boolean(body.kickCashDrawer && cfg.autoKickDrawerOnCash),
          cutPaper: true,
        });

        let hardwareOutcome = {
          dispatchedToHardware: false,
          transportMode: cfg.mode,
          bytesWritten: renderedJob.wirePayloadBytes.byteLength,
          errorMessage: undefined as string | undefined,
        };

        if (this.printerSpooler.isPrinterReady()) {
          try {
            hardwareOutcome = await this.enqueueHardwarePrint(() =>
              dispatchEscPosPayloadToHardware(
                cfg,
                renderedJob.wirePayloadBytes,
                `RUBE-POS ${body.receiptNumber ?? 'Receipt'}`
              )
            );
          } catch (hwErr) {
            // Hardware port unreachable -> mark spooler offline and queue receipt automatically!
            this.printerSpooler.setHardwareReadyState(false);
            hardwareOutcome.errorMessage =
              hwErr instanceof Error ? hwErr.message : String(hwErr);
          }
        }

        const spoolResult = this.printerSpooler.submitPrintJob({
          salesOrderId: body.salesOrderId ?? `MANUAL-${Date.now()}`,
          receiptNumber: body.receiptNumber ?? `RCP-CANVAS-${Date.now()}`,
          renderedJob,
        });

        this.sendJson(res, 200, {
          packetsCount: renderedJob.packets.length,
          maxPacketByteLength: renderedJob.maxPacketByteLength,
          wireByteLength: renderedJob.wirePayloadBytes.byteLength,
          spoolResult,
          hardwareOutcome,
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 3. Staff PIN Authentication & RBAC Management
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/auth/pin-login') {
        await this.ensureSeededIfAppropriate();
        await this.ensureSessionHmacSecretPersisted();
        const body = await this.readJsonBody<{
          pin: string;
          userId?: string;
          statelessOverride?: boolean;
        }>(req);

        const explicitUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const targetKey = explicitUserId || '__ANY__';
        const GLOBAL_LOCK_KEY = '__GLOBAL__';
        const PIN_WINDOW_MS = 5 * 60 * 1000;

        const user = await this.enqueuePinAuth(async () => {
          const now = Date.now();
          const pruneBucket = (key: string) => {
            const entry = this.pinFailTrackers.get(key);
            if (!entry) return undefined;
            if (entry.lockedUntilMs > 0 && now >= entry.lockedUntilMs) {
              this.pinFailTrackers.delete(key);
              return undefined;
            }
            if (entry.lockedUntilMs === 0 && now - entry.firstFailedAtMs > PIN_WINDOW_MS) {
              this.pinFailTrackers.delete(key);
              return undefined;
            }
            return entry;
          };

          const targetEntry = pruneBucket(targetKey);
          const globalEntry = pruneBucket(GLOBAL_LOCK_KEY);
          const activeLockUntil = Math.max(
            targetEntry && now < targetEntry.lockedUntilMs ? targetEntry.lockedUntilMs : 0,
            globalEntry && now < globalEntry.lockedUntilMs ? globalEntry.lockedUntilMs : 0
          );
          if (activeLockUntil > now) {
            const remainSec = Math.max(1, Math.ceil((activeLockUntil - now) / 1000));
            throw new Error(
              `HTTP 429 Too Many Requests: กดรหัส PIN ผิดเกิน 5 ครั้ง ระบบล็อกหน้าจอชั่วคราว (รออีก ${remainSec} วินาที)`
            );
          }

          try {
            const authed = await this.ipc.authenticateStaffByPin({
              pin: String(body.pin ?? ''),
              ...(explicitUserId ? { userId: explicitUserId } : {}),
              terminalId: 'POS-TERM-01',
            });
            if (explicitUserId) {
              const clearedExplicitCount = this.pinFailTrackers.get(explicitUserId)?.count ?? 0;
              if (clearedExplicitCount > 0) {
                const g = this.pinFailTrackers.get(GLOBAL_LOCK_KEY);
                if (g && g.lockedUntilMs === 0) {
                  g.count = Math.max(0, g.count - clearedExplicitCount);
                  if (g.count === 0) {
                    this.pinFailTrackers.delete(GLOBAL_LOCK_KEY);
                  }
                }
              }
            }
            this.pinFailTrackers.delete(authed.id);
            this.pinFailTrackers.delete(targetKey);
            return authed;
          } catch (authErr) {
            const errMsg = authErr instanceof Error ? authErr.message : String(authErr);
            if (errMsg.includes('401')) {
              const recordFailure = (key: string): boolean => {
                const cur = this.pinFailTrackers.get(key) ?? {
                  count: 0,
                  firstFailedAtMs: now,
                  lockedUntilMs: 0,
                };
                if (now - cur.firstFailedAtMs > PIN_WINDOW_MS) {
                  cur.count = 0;
                  cur.firstFailedAtMs = now;
                }
                if (cur.count === 0) {
                  cur.firstFailedAtMs = now;
                }
                cur.count += 1;
                let triggeredLock = false;
                if (cur.count >= 5) {
                  cur.lockedUntilMs = now + this.pinLockoutDurationMs;
                  triggeredLock = true;
                }
                this.pinFailTrackers.set(key, cur);
                return triggeredLock;
              };

              const targetLocked = recordFailure(targetKey);
              const globalLocked = recordFailure(GLOBAL_LOCK_KEY);
              if (targetLocked || globalLocked) {
                const lockSec = Math.max(1, Math.ceil(this.pinLockoutDurationMs / 1000));
                throw new Error(
                  `HTTP 429 Too Many Requests: กดรหัส PIN ผิดครบ 5 ครั้ง ระบบล็อกหน้าจอชั่วคราว ${lockSec} วินาที`
                );
              }
            }
            throw authErr;
          }
        });

        const issued = this.issueAuthToken(
          user.id,
          body.statelessOverride ? 'OVERRIDE' : 'SESSION'
        );
        this.sendJson(res, 200, {
          user,
          sessionToken: issued.token,
          expiresAt: issued.expiresAt,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/logout') {
        this.revokeAuthTokenFromRequest(req);
        this.sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/auth/users') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        this.sendJson(res, 200, { users: this.ipc.listStaffUsers() });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/users') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const body = await this.readJsonBody<{
          id?: string;
          username: string;
          displayName: string;
          role: UserRole;
          pin?: string;
          active?: boolean;
          actorUserId?: string;
        }>(req);
        if (sessionUser && sessionUser.role !== 'OWNER') {
          if (body.role === 'OWNER') {
            throw new Error('HTTP 403 Forbidden: เฉพาะ OWNER เท่านั้นที่สามารถสร้างบัญชี OWNER ได้');
          }
          if (body.id) {
            const targetUser = this.ipc.listStaffUsers().find((u) => u.id === body.id);
            if (targetUser?.role === 'OWNER') {
              throw new Error('HTTP 403 Forbidden: เฉพาะ OWNER เท่านั้นที่สามารถแก้ไขบัญชี OWNER ได้');
            }
          }
        }
        const user = await this.ipc.upsertStaffUser({
          ...body,
          actorUserId: sessionUser?.id ?? body.actorUserId ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, { user });
        return;
      }

      // ----------------------------------------------------------------------
      // 4. Hardware Simulator & POS Checkout (with Split Payment) / Void / Reprint
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/hal/simulate-scan') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{ barcode: string }>(req);
        const barcode = String(body.barcode ?? '8851952350161');

        this.posController.clearCart();
        this.posController.searchInputText = '';
        let t = 5_000;
        for (let i = 0; i < barcode.length; i++) {
          const digit = barcode[i]!;
          const leakedThaiChar = i === 0 ? 'ค' : digit;
          this.posController.handleKeyDownWithFocusedSearchInput(
            `Digit${digit}`,
            leakedThaiChar,
            t
          );
          t += 12;
        }
        this.posController.handleKeyDownWithFocusedSearchInput('Enter', '\n', t);

        const summary = this.posController.getCartSummaryViewModel();
        const addedCartLine = summary.lines[summary.lines.length - 1];
        this.sendJson(res, 200, {
          searchInputTextAfter: this.posController.searchInputText,
          firstCharRollbackCount: this.posController.firstCharRollbackCount,
          addedCartLine,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/validate-laoqr-template') {
        if (this.ipc.isSystemOnboarded()) {
          this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        }
        const body = await this.readJsonBody<{
          rawTemplate?: string;
          generateSample?: boolean;
          merchantName?: string;
          merchantCity?: string;
          previewAmountSatang?: number;
        }>(req);

        const candidateTemplate = body.generateSample
          ? buildSampleStaticLaoQrTemplate(
              body.merchantName || 'RUBE LAO SHOP',
              body.merchantCity || 'VIENTIANE'
            )
          : String(body.rawTemplate ?? '').trim();

        const validation = validateLaoQrStaticTemplate(candidateTemplate);
        if (!validation.valid) {
          this.sendJson(res, 200, {
            valid: false,
            errorReason: validation.errorReason ?? 'Invalid LAOQR template',
          });
          return;
        }
        const previewAmount =
          body.previewAmountSatang && body.previewAmountSatang > 0
            ? Number(body.previewAmountSatang)
            : 3_500_000; // 35,000 LAK sample
        const dynamicPreview = generateOfflineLaoQrDynamicQr(
          validation.normalizedTemplate,
          previewAmount
        );
        this.sendJson(res, 200, {
          valid: true,
          normalizedTemplate: validation.normalizedTemplate,
          merchantAccountTag: validation.merchantAccountTag,
          merchantName: validation.merchantName,
          merchantCity: validation.merchantCity,
          currencyNumeric: validation.currencyNumeric,
          previewPayload: dynamicPreview.payload,
          previewCrcHex: dynamicPreview.crcHex,
          previewWholeLakAmount: dynamicPreview.wholeLakAmount,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/promptpay-qr') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          overrideAmountSatang?: number;
          taxMode?: TaxMode;
          discountSatang?: number;
          lines?: Array<{
            variantId: string;
            quantityMilli: number;
            unitPriceSatang: number;
            overrideLineTotalSatang?: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);
        const settings = this.ipc.getStoreIdentitySettings(body.outletId ?? 'OUTLET-HQ');
        const fiscal = this.ipc.getFiscalConfig();
        const totals = this.computeCartTotals(
          body.lines ?? [],
          Number(body.discountSatang ?? 0),
          body.taxMode ?? fiscal.defaultTaxMode
        );
        const targetAmountSatang =
          body.overrideAmountSatang && body.overrideAmountSatang > 0
            ? Number(body.overrideAmountSatang)
            : totals.totalSatang;

        if (fiscal.countryCode === 'LA') {
          if (!fiscal.laoQrStaticTemplate) {
            throw new Error(
              'HTTP 422 ຍັງບໍ່ໄດ້ຕັ້ງຄ່າ LAOQR / BCEL OnePay ຂອງຮ້ານ — ກະລຸນານຳເຂົ້າ QR ໃນໜ້າຕັ້ງຄ່າລະບົບ (LAOQR static template not configured)'
            );
          }
          const qr = generateOfflineLaoQrDynamicQr(
            fiscal.laoQrStaticTemplate,
            targetAmountSatang
          );
          this.sendJson(res, 200, {
            payload: qr.payload,
            crcHex: qr.crcHex,
            qrScheme: 'LAOQR',
            promptPayId: qr.merchantName || settings.storeName,
            storeName: settings.storeName,
            totalSatang: targetAmountSatang,
            currencyCode: 'LAK',
          });
          return;
        }

        const qr = generateOfflinePromptPayDynamicQr(settings.promptPayId, targetAmountSatang);
        this.sendJson(res, 200, {
          ...qr,
          qrScheme: 'PROMPTPAY',
          promptPayId: settings.promptPayId,
          storeName: settings.storeName,
          totalSatang: targetAmountSatang,
          currencyCode: 'THB',
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/verify-slip-step1') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          miniQrRaw: string;
          senderBankCode?: string;
          overrideAmountSatang?: number;
          taxMode?: TaxMode;
          discountSatang?: number;
          lines?: Array<{
            variantId: string;
            quantityMilli: number;
            unitPriceSatang: number;
            overrideLineTotalSatang?: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);
        const fiscal = this.ipc.getFiscalConfig();
        const totals = this.computeCartTotals(
          body.lines ?? [],
          Number(body.discountSatang ?? 0),
          body.taxMode ?? fiscal.defaultTaxMode
        );
        const expectedSatang =
          body.overrideAmountSatang && body.overrideAmountSatang > 0
            ? Number(body.overrideAmountSatang)
            : totals.totalSatang;

        const modal =
          fiscal.countryCode === 'LA'
            ? buildTwoPhaseLaoSlipConfirmationModal(
                String(body.miniQrRaw ?? ''),
                String(body.senderBankCode ?? 'BCEL'),
                expectedSatang,
                this.usedSlipHashes,
                fiscal.uiLocale
              )
            : buildTwoPhaseSlipConfirmationModal(
                String(body.miniQrRaw ?? ''),
                expectedSatang,
                this.usedSlipHashes
              );

        let isDuplicateInDb = false;
        if (modal.verification.validFormat && modal.verification.transRefSha256Hex) {
          const dupRow = this.engine.executeRead((db) =>
            db
              .prepare(
                `SELECT 1 AS found FROM payment_transactions WHERE slip_trans_ref_hash = ? LIMIT 1`
              )
              .get(modal.verification.transRefSha256Hex)
          ) as { found?: number } | undefined;
          if (dupRow) {
            isDuplicateInDb = true;
            this.usedSlipHashes.add(modal.verification.transRefSha256Hex);
          }
        }

        const isDuplicate = modal.verification.isDuplicate || isDuplicateInDb;
        const valid = modal.canProceedToStep2Confirm && !isDuplicateInDb;
        const dupMsg =
          fiscal.uiLocale === 'lo'
            ? 'ກວດພົບການໃຊ້ສະລິບໂອນເງິນຊ້ຳ! (Duplicate Slip Fraud Alert)'
            : fiscal.uiLocale === 'en'
              ? 'Duplicate transfer slip detected! (Duplicate Slip Fraud Alert)'
              : 'ตรวจพบการใช้สลิปโอนเงินซ้ำ! (Duplicate Slip Fraud Alert)';
        const errorMessageThai = isDuplicateInDb ? dupMsg : modal.verification.errorReason;

        this.sendJson(res, 200, {
          valid,
          ...(!valid
            ? {
                errorCode: isDuplicate
                  ? 'DUPLICATE_SLIP'
                  : fiscal.countryCode === 'LA'
                    ? 'INVALID_LAO_SLIP'
                    : 'INVALID_BOT_QR',
                errorMessageThai: errorMessageThai ?? 'ข้อมูลสลิปไม่ถูกต้อง',
              }
            : {}),
          bankCode: modal.senderBankCode,
          bankDisplayNameThai: modal.senderBankNameThai,
          transRefLast4: modal.transRefLast4,
          slipTransRefHash: modal.verification.transRefSha256Hex,
          expectedAmountFormatted: modal.expectedAmountFormatted,
          visualPromptThai: modal.antiFraudWarningBannerThai,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/checkout') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          idempotencyKey?: string;
          outletId?: string;
          cashierId?: string;
          orderType?: CheckoutOrderRequest['orderType'];
          tableOrQueueNo?: string;
          paymentMethod: CheckoutOrderRequest['paymentMethod'];
          cashTenderedSatang?: number;
          foreignTenderCurrency?: ForeignTenderCurrencyCode;
          foreignTenderAmountSatang?: number;
          slipTransRefRaw?: string;
          slipSenderBankCode?: string;
          splitPayments?: SplitPaymentLegInput[];
          taxMode?: TaxMode;
          discountSatang?: number;
          paperWidthPx?: 384 | 576;
          skipKdsEnqueue?: boolean;
          lines: Array<{
            variantId: string;
            itemName?: string;
            unitName?: string;
            quantityMilli: number;
            unitPriceSatang: number;
            overrideLineTotalSatang?: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);

        const outletId = body.outletId ?? 'OUTLET-HQ';
        await this.ensureActiveShiftOpen(outletId);
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        if (!activeShift) {
          throw new Error('No active OPEN cashier shift found. Please open a shift before checkout.');
        }

        const fiscal = this.ipc.getFiscalConfig();
        const taxMode: TaxMode = body.taxMode ?? fiscal.defaultTaxMode;
        const discountSatang = Number(body.discountSatang ?? 0);
        const hasSplit = Boolean(body.splitPayments && body.splitPayments.length > 0);
        const isPureCash = !hasSplit && body.paymentMethod === 'CASH';
        const totals = this.computeCartTotals(body.lines ?? [], discountSatang, taxMode, {
          applyCashRounding: isPureCash,
        });
        const checkoutLines = (body.lines ?? []).map((l) => ({
          variantId: l.variantId,
          quantityMilli: Number(l.quantityMilli),
          unitPriceSatang: Number(l.unitPriceSatang),
          ...(this.isValidOverrideLineTotalSatang(l.overrideLineTotalSatang)
            ? { overrideLineTotalSatang: l.overrideLineTotalSatang }
            : {}),
          selectedModifierIds: l.selectedModifierIds ?? [],
        }));

        const idempotencyKey =
          typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim().length >= 8
            ? body.idempotencyKey.trim()
            : `IDEM-UI-${Date.now()}-${this.checkoutSequenceCounter++}`;
        const hasForeignCashTender = isPureCash && Boolean(body.foreignTenderCurrency);
        const cashTendered =
          isPureCash && !hasForeignCashTender
            ? Math.max(totals.totalSatang, Number(body.cashTenderedSatang ?? totals.totalSatang))
            : undefined;

        const order = await this.ipc.checkoutSalesOrder({
          idempotencyKey,
          outletId,
          terminalId: 'POS-TERM-01',
          shiftId: activeShift.id,
          cashierId: sessionUser?.id ?? body.cashierId ?? 'USR-CASHIER-01',
          orderType: body.orderType ?? 'TAKEAWAY',
          ...(body.tableOrQueueNo !== undefined ? { tableOrQueueNo: body.tableOrQueueNo } : {}),
          taxMode,
          discountSatang,
          paymentMethod: body.paymentMethod,
          ...(cashTendered !== undefined ? { cashTenderedSatang: cashTendered } : {}),
          ...(hasForeignCashTender && body.foreignTenderCurrency
            ? {
                foreignTenderCurrency: body.foreignTenderCurrency,
                foreignTenderAmountSatang: Number(body.foreignTenderAmountSatang ?? 0),
              }
            : {}),
          ...(body.slipTransRefRaw !== undefined ? { slipTransRefRaw: body.slipTransRefRaw } : {}),
          ...(body.slipSenderBankCode !== undefined
            ? { slipSenderBankCode: body.slipSenderBankCode }
            : {}),
          ...(hasSplit ? { splitPayments: body.splitPayments } : {}),
          ...(body.skipKdsEnqueue ? { skipKdsEnqueue: true } : {}),
          lines: checkoutLines,
        });

        if (order.slipTransRefHash) {
          commitVerifiedBotSlipHash(order.slipTransRefHash, this.usedSlipHashes);
        }

        // Automatically expire/revoke any active Signed Table QR session when that table settles its bill
        if (body.tableOrQueueNo && body.tableOrQueueNo.trim()) {
          await this.ipc
            .revokeTableQrSession({
              outletId,
              tableLabel: body.tableOrQueueNo.trim(),
              actorUserId: sessionUser?.id ?? body.cashierId ?? 'USR-CASHIER-01',
            })
            .catch(() => {});
        }

        const settings = this.ipc.getStoreIdentitySettings(outletId);
        const printerCfg = this.getPrinterConfig();
        const widthPx: 384 | 576 =
          body.paperWidthPx ?? (printerCfg.paperWidthMm === 58 ? 384 : 576);
        const hasCashLeg = order.payments.some((p) => p.paymentMethod === 'CASH');
        const fmt = (satang: number) => formatMoney(satang, fiscal.currencyCode);
        const vatPctLabel = formatVatRatePercent(fiscal.vatRateBps);

        const renderedJob = renderThaiReceiptAbbEscPosJob({
          storeName: settings.storeName,
          storeAddress: fiscal.storeAddress,
          taxId: settings.taxId,
          branchCode: settings.branchCode,
          posRegNo: settings.rdPosRegNo,
          receiptNumber: order.receiptNumber,
          abbTaxInvoiceNo: order.abbTaxInvoiceNo,
          countryCode: fiscal.countryCode,
          receiptLocale: fiscal.receiptLocale,
          vatRatePercentLabel: vatPctLabel,
          taxMode: order.taxMode,
          lines: totals.formattedLines,
          subtotalFormatted: fmt(order.subtotalSatang),
          discountFormatted: fmt(order.discountSatang),
          ...(order.cashRoundingDiscountSatang && order.cashRoundingDiscountSatang > 0
            ? { cashRoundingDiscountFormatted: fmt(order.cashRoundingDiscountSatang) }
            : {}),
          netBeforeTaxFormatted: fmt(order.netBeforeTaxSatang),
          taxFormatted: fmt(order.taxSatang),
          totalFormatted: fmt(order.totalSatang),
          paymentMethod: order.paymentMethod,
          ...(order.cashTenderedSatang !== null
            ? { cashTenderedFormatted: fmt(order.cashTenderedSatang) }
            : {}),
          ...(order.changeGivenSatang !== null
            ? { changeGivenFormatted: fmt(order.changeGivenSatang) }
            : {}),
          ...(order.fxTender
            ? { fxTenderSummaryLine: formatFxTenderReceiptLine(order.fxTender, fiscal.receiptLocale) }
            : {}),
          ...(order.slipTransRefLast4 ? { slipRefLast4: order.slipTransRefLast4 } : {}),
          kickCashDrawer: hasCashLeg && printerCfg.autoKickDrawerOnCash,
          widthPx,
        });

        // Append explicit split payment lines onto formattedTextLines when multiple legs exist
        if (order.payments.length > 1) {
          const splitPrefix =
            fiscal.receiptLocale === 'lo'
              ? '  • ແຍກຈ່າຍ'
              : fiscal.receiptLocale === 'en'
                ? '  • Split'
                : '  • แยกจ่าย';
          renderedJob.formattedTextLines.splice(
            renderedJob.formattedTextLines.length - 1,
            0,
            ...order.payments.map((p) => {
              const methodDisplay =
                p.paymentMethod === 'PROMPTPAY_QR' && fiscal.countryCode === 'LA'
                  ? 'LAOQR / OnePay'
                  : p.paymentMethod;
              return `${splitPrefix} ${methodDisplay}: ${fmt(p.amountSatang)}${p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''}`;
            })
          );
        }

        const spoolResult = this.printerSpooler.submitPrintJob({
          salesOrderId: order.salesOrderId,
          receiptNumber: order.receiptNumber,
          renderedJob,
        });

        this.sendJson(res, 200, {
          order,
          printJob: {
            formattedTextLines: renderedJob.formattedTextLines,
            packetsCount: renderedJob.packets.length,
            maxPacketByteLength: renderedJob.maxPacketByteLength,
            widthPx: renderedJob.widthPx,
            totalHeightPx: renderedJob.totalHeightPx,
            kickDrawerCommandIncluded: renderedJob.kickDrawerCommandIncluded,
            cutPaperCommandIncluded: renderedJob.cutPaperCommandIncluded,
          },
          spoolResult,
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/pos/orders') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const limit = Number(url.searchParams.get('limit') ?? 100);
        this.sendJson(res, 200, {
          orders: this.ipc.listRecentSalesOrders(outletId, limit),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/pos/held-bills') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        this.sendJson(res, 200, {
          heldBills: this.getHeldBillsForOutlet(outletId),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/held-bills') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          actorUserId?: string;
          bill: Record<string, unknown>;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const heldBills = await this.upsertHeldBillForOutlet(
          outletId,
          body.bill ?? {},
          sessionUser?.id ?? body.actorUserId ?? 'USR-CASHIER-01'
        );
        this.sendJson(res, 200, { ok: true, heldBills });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/pos/held-bills') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          actorUserId?: string;
          id: string;
          recall?: boolean;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const heldBills = await this.deleteHeldBillForOutlet(
          outletId,
          String(body.id ?? ''),
          sessionUser?.id ?? body.actorUserId ?? 'USR-CASHIER-01',
          body.recall === true
        );
        this.sendJson(res, 200, { ok: true, heldBills });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/reprint') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{ salesOrderId: string; outletId?: string }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const target = this.ipc
          .listRecentSalesOrders(outletId, 200)
          .find((o) => o.salesOrderId === body.salesOrderId);
        if (!target) {
          throw new Error(`Sales order ${body.salesOrderId} not found`);
        }

        const settings = this.ipc.getStoreIdentitySettings(outletId);
        const fiscal = this.ipc.getFiscalConfig();
        const printerCfg = this.getPrinterConfig();
        const fmt = (satang: number) => formatMoney(satang, fiscal.currencyCode);
        const copyTag =
          fiscal.receiptLocale === 'lo'
            ? '[ສຳເນົາ/REPRINT]'
            : fiscal.receiptLocale === 'en'
              ? '[COPY/REPRINT]'
              : '[สำเนา/REPRINT]';
        const renderedJob = renderThaiReceiptAbbEscPosJob({
          storeName: `${settings.storeName} ${copyTag}`,
          storeAddress: fiscal.storeAddress,
          taxId: settings.taxId,
          branchCode: settings.branchCode,
          posRegNo: settings.rdPosRegNo,
          receiptNumber: target.receiptNumber,
          abbTaxInvoiceNo: target.abbTaxInvoiceNo ?? '-',
          countryCode: fiscal.countryCode,
          receiptLocale: fiscal.receiptLocale,
          vatRatePercentLabel: formatVatRatePercent(fiscal.vatRateBps),
          taxMode: target.taxMode,
          lines: target.lines.map((l) => {
            const modsText = l.modifiers.map((m) => m.name).join(', ');
            return {
              itemName: l.itemName,
              quantityFormatted: formatMilliUnitsToQtyString(l.quantityMilli, l.unitName),
              lineTotalFormatted: fmt(l.lineTotalSatang),
              ...(modsText ? { modifiersText: modsText } : {}),
            };
          }),
          subtotalFormatted: fmt(target.subtotalSatang),
          discountFormatted: fmt(target.discountSatang),
          netBeforeTaxFormatted: fmt(target.netBeforeTaxSatang),
          taxFormatted: fmt(target.taxSatang),
          totalFormatted: fmt(target.totalSatang),
          paymentMethod: target.paymentMethod,
          ...(target.cashTenderedSatang !== null
            ? { cashTenderedFormatted: fmt(target.cashTenderedSatang) }
            : {}),
          ...(target.changeGivenSatang !== null
            ? { changeGivenFormatted: fmt(target.changeGivenSatang) }
            : {}),
          ...(target.fxTender
            ? { fxTenderSummaryLine: formatFxTenderReceiptLine(target.fxTender, fiscal.receiptLocale) }
            : {}),
          ...(target.slipTransRefLast4 ? { slipRefLast4: target.slipTransRefLast4 } : {}),
          kickCashDrawer: false,
          widthPx: printerCfg.paperWidthMm === 58 ? 384 : 576,
        });

        if (target.payments && target.payments.length > 1) {
          const splitPrefix =
            fiscal.receiptLocale === 'lo'
              ? '  • ແຍກຈ່າຍ'
              : fiscal.receiptLocale === 'en'
                ? '  • Split'
                : '  • แยกจ่าย';
          renderedJob.formattedTextLines.splice(
            renderedJob.formattedTextLines.length - 1,
            0,
            ...target.payments.map(
              (p) =>
                `${splitPrefix} ${p.paymentMethod === 'PROMPTPAY_QR' && fiscal.countryCode === 'LA' ? 'LAOQR / OnePay' : p.paymentMethod}: ${fmt(p.amountSatang)}${p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''}`
            )
          );
        }

        const spoolResult = this.printerSpooler.submitPrintJob({
          salesOrderId: target.salesOrderId,
          receiptNumber: `${target.receiptNumber}-COPY`,
          renderedJob,
        });

        this.sendJson(res, 200, {
          printJob: {
            formattedTextLines: renderedJob.formattedTextLines,
            packetsCount: renderedJob.packets.length,
            maxPacketByteLength: renderedJob.maxPacketByteLength,
          },
          spoolResult,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/void') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          salesOrderId: string;
          voidedByUserId?: string;
          voidReason?: string;
        }>(req);

        let effectiveVoidedByUserId =
          sessionUser?.id ?? body.voidedByUserId ?? 'USR-OWNER-01';
        const overrideHeader = req.headers['x-rube-override-token'];
        const overrideToken = Array.isArray(overrideHeader)
          ? overrideHeader[0]
          : overrideHeader;

        if (overrideToken && overrideToken.trim()) {
          const approver = this.verifyAuthToken(overrideToken.trim(), 'OVERRIDE');
          if (approver.role !== 'OWNER' && approver.role !== 'MANAGER') {
            throw new Error(
              'HTTP 403 Forbidden: ต้องใช้รหัสอนุมัติของ MANAGER หรือ OWNER สำหรับยกเลิกบิล'
            );
          }
          effectiveVoidedByUserId = approver.id;
        } else if (
          (this.enforceApiSessionAuth || sessionUser !== null) &&
          sessionUser?.role !== 'OWNER' &&
          sessionUser?.role !== 'MANAGER'
        ) {
          throw new Error(
            'HTTP 403 Forbidden: สิทธิ์ CASHIER ต้องให้ MANAGER หรือ OWNER กดรหัส PIN อนุมัติยกเลิกบิล'
          );
        }

        const voidRes = await this.ipc.voidSalesOrder({
          salesOrderId: String(body.salesOrderId),
          voidedByUserId: effectiveVoidedByUserId,
          voidReason: body.voidReason?.trim() || 'Voided from POS UI',
        });
        this.sendJson(res, 200, voidRes);
        return;
      }

      // ----------------------------------------------------------------------
      // 5. Kitchen Display System (KDS)
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/kds/tickets') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER', 'WAREHOUSE', 'KITCHEN']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const includeServed = url.searchParams.get('includeServed') === 'true';
        this.sendJson(res, 200, {
          tickets: this.ipc.listKitchenOrdersAllStations(outletId, includeServed),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/kds/bump') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER', 'WAREHOUSE', 'KITCHEN']);
        const body = await this.readJsonBody<{
          kitchenOrderId: string;
          ackedSequenceId: number;
          newStatus: 'PREPARING' | 'READY' | 'SERVED';
        }>(req);
        const kdsRes = await this.ipc.acknowledgeAndAdvanceKdsOrder({
          terminalId: 'POS-TERM-01',
          kitchenOrderId: String(body.kitchenOrderId),
          ackedSequenceId: Number(body.ackedSequenceId),
          newStatus: body.newStatus,
        });
        this.sendJson(res, 200, kdsRes);
        return;
      }

      // ----------------------------------------------------------------------
      // 6. Master Catalog, Product Images, Categories, Suppliers & Modifier Groups CRUD
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname.startsWith('/api/catalog/image/')) {
        const rawName = decodeURIComponent(url.pathname.slice('/api/catalog/image/'.length));
        if (!/^[A-Za-z0-9._-]+$/.test(rawName)) {
          this.sendJson(res, 400, { error: 'Invalid image filename' });
          return;
        }
        const fullPath = path.join(this.productImagesDir, rawName);
        if (!fullPath.startsWith(this.productImagesDir) || !fs.existsSync(fullPath)) {
          this.sendJson(res, 404, { error: 'Image not found' });
          return;
        }
        const ext = path.extname(fullPath).toLowerCase();
        const mime =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        this.setCorsHeaders(res, req);
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(fs.readFileSync(fullPath));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/catalog') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER', 'WAREHOUSE', 'KITCHEN']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        this.sendJson(res, 200, {
          variants: this.hydrateCatalogVariantImages(
            this.ipc.listCatalogVariantsDetailed(outletId)
          ),
          categories: this.ipc.listCategories(),
          suppliers: this.ipc.listSuppliers(),
          modifierGroups: this.ipc.listModifierGroupsWithModifiers(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/variant') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<UpsertCatalogVariantInput>(req);
        const variant = await this.ipc.upsertCatalogVariant({
          ...body,
          performedByUserId: sessionUser?.id ?? body.performedByUserId ?? 'USR-OWNER-01',
        });
        const [hydrated] = this.hydrateCatalogVariantImages([variant]);
        this.sendJson(res, 200, { variant: hydrated ?? variant });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/catalog/variant') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          variantId: string;
          performedByUserId?: string;
        }>(req);
        const actorId = sessionUser?.id ?? body.performedByUserId ?? 'USR-OWNER-01';
        const delRes = await this.ipc.deleteCatalogVariant(String(body.variantId ?? ''), actorId);
        await this.saveOrRemoveProductImage(delRes.variantId, null, actorId).catch(() => {});
        this.sendJson(res, 200, { ok: true, ...delRes });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/variant-image') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          variantId: string;
          dataUrl: string | null;
          actorUserId?: string;
        }>(req);
        const imageUrl = await this.saveOrRemoveProductImage(
          String(body.variantId ?? ''),
          body.dataUrl ?? null,
          sessionUser?.id ?? body.actorUserId ?? 'USR-OWNER-01'
        );
        this.sendJson(res, 200, { ok: true, variantId: body.variantId, imageUrl });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/category') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          id?: string;
          name: string;
          displayColor?: string;
          kitchenStation?: string;
          sortOrder?: number;
        }>(req);
        const category = await this.ipc.upsertCategory(body);
        this.sendJson(res, 200, { category, categories: this.ipc.listCategories() });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/catalog/category') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{ id: string }>(req);
        const delRes = await this.ipc.deleteCategory(String(body.id ?? ''));
        this.sendJson(res, 200, {
          ok: true,
          ...delRes,
          categories: this.ipc.listCategories(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/supplier') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          id?: string;
          code: string;
          name: string;
          taxId?: string | null;
          phone?: string | null;
        }>(req);
        const supplier = await this.ipc.upsertSupplier(body);
        this.sendJson(res, 200, { supplier });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/modifier-group') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          id?: string;
          name: string;
          selectionType: 'SINGLE' | 'MULTIPLE';
          minSelections?: number;
          maxSelections?: number;
        }>(req);
        const group = await this.ipc.upsertModifierGroup(body);
        this.sendJson(res, 200, {
          group,
          modifierGroups: this.ipc.listModifierGroupsWithModifiers(),
        });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/catalog/modifier-group') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{ id: string }>(req);
        await this.ipc.deleteModifierGroup(body.id);
        this.sendJson(res, 200, {
          ok: true,
          modifierGroups: this.ipc.listModifierGroupsWithModifiers(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/modifier') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          id?: string;
          modifierGroupId: string;
          name: string;
          priceDeltaSatang: number;
          modifierMode: 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS';
          componentVariantId?: string | null;
          quantityDeltaMilli?: number;
          targetComponentRole?: ComponentRole | null;
          scaleBasisPoints?: number;
          sortOrder?: number;
        }>(req);
        const modifier = await this.ipc.upsertModifierItem(body);
        this.sendJson(res, 200, {
          modifier,
          modifierGroups: this.ipc.listModifierGroupsWithModifiers(),
        });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/catalog/modifier') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{ id: string }>(req);
        await this.ipc.deleteModifierItem(body.id);
        this.sendJson(res, 200, {
          ok: true,
          modifierGroups: this.ipc.listModifierGroupsWithModifiers(),
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 7. Warehouse: Purchase Orders (Landed Cost), Prep Build, BOM DAG, Transfers, Stocktake & Ledger
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/warehouse/po-preview') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          outletId?: string;
          supplierId?: string;
          items: CreatePurchaseOrderInput['items'];
          landedCosts?: CreatePurchaseOrderInput['landedCosts'];
        }>(req);
        const preview = this.ipc.previewPurchaseOrderCosting({
          poNumber: 'PO-PREVIEW',
          outletId: body.outletId ?? 'OUTLET-HQ',
          supplierId: body.supplierId ?? 'SUP-001',
          createdByUserId: sessionUser?.id ?? 'USR-WH-01',
          items: body.items ?? [],
          landedCosts: body.landedCosts ?? [],
        });
        this.sendJson(res, 200, { lines: preview });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/receive-po') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          outletId?: string;
          supplierId?: string;
          createdByUserId?: string;
          items?: CreatePurchaseOrderInput['items'];
          landedCosts?: CreatePurchaseOrderInput['landedCosts'];
          porkKg?: number;
          freightBaht?: number;
        }>(req);

        const items: CreatePurchaseOrderInput['items'] =
          body.items && body.items.length > 0
            ? body.items
            : [
                {
                  variantId: 'VAR-RET-002',
                  orderedQtyMilli: Math.max(1, Math.round(Number(body.porkKg ?? 10) * 1_000)),
                  receivedQtyMilli: Math.max(1, Math.round(Number(body.porkKg ?? 10) * 1_000)),
                  baseUnitCostMicroBaht: 125_000_000,
                },
                {
                  variantId: 'VAR-RAW-TEA',
                  orderedQtyMilli: 5_000,
                  receivedQtyMilli: 5_000,
                  baseUnitCostMicroBaht: 300_000,
                },
              ];

        const landedCosts: CreatePurchaseOrderInput['landedCosts'] =
          body.landedCosts !== undefined
            ? body.landedCosts
            : [
                {
                  costType: 'FREIGHT',
                  description: 'Freight & Cold-Chain Delivery',
                  amountSatang: Math.max(0, Math.round(Number(body.freightBaht ?? 250) * 100)),
                },
              ].filter((c) => c.amountSatang > 0);

        const actorId =
          sessionUser?.id ??
          body.createdByUserId ??
          this.ipc.listStaffUsers()[0]?.id ??
          'USR-OWNER-01';

        const poRes = await this.executeWithUniqueDocRetry('po_number', () => {
          const poNumber = `PO-LIVE-${String(this.poSequenceCounter++).padStart(4, '0')}`;
          return this.ipc.receivePurchaseOrderWithLandedCosts({
            poNumber,
            outletId: body.outletId ?? 'OUTLET-HQ',
            supplierId: body.supplierId ?? 'SUP-001',
            createdByUserId: actorId,
            items,
            landedCosts,
          });
        });
        this.sendJson(res, 200, poRes);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/warehouse/po-history') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        this.sendJson(res, 200, {
          purchaseOrders: this.ipc.listPurchaseOrdersHistory(outletId, 40),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/build-prep') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          outletId?: string;
          compositeVariantId?: string;
          buildQtyMilli?: number;
          performedByUserId?: string;
        }>(req);
        const buildRes = await this.ipc.executeProductionBuildBatch({
          outletId: body.outletId ?? 'OUTLET-HQ',
          compositeVariantId: body.compositeVariantId ?? 'VAR-RAW-BOBA',
          buildQtyMilli: Number(body.buildQtyMilli ?? 5_000),
          performedByUserId:
            sessionUser?.id ??
            body.performedByUserId ??
            this.ipc.listStaffUsers()[0]?.id ??
            'USR-OWNER-01',
        });
        this.sendJson(res, 200, {
          ...buildRes,
          CompositeStockAfterMilli: buildRes.newCompositeStockMilli,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/bom-edge') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const body = await this.readJsonBody<BomEdgeDto>(req);
        await this.ipc.upsertBomComponentEdge(body);
        this.sendJson(res, 200, { ok: true, bomEdges: this.ipc.listBomEdges() });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/warehouse/bom-edge') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const body = await this.readJsonBody<{
          compositeVariantId: string;
          componentVariantId: string;
        }>(req);
        await this.ipc.deleteBomComponentEdge(body.compositeVariantId, body.componentVariantId);
        this.sendJson(res, 200, { ok: true, bomEdges: this.ipc.listBomEdges() });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/bom-preview') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          outletId?: string;
          compositeVariantId: string;
          qtyMilli?: number;
          selectedModifierIds?: string[];
        }>(req);
        const preview = this.ipc.computeLiveRecipePreview(
          body.outletId ?? 'OUTLET-HQ',
          body.compositeVariantId,
          Number(body.qtyMilli ?? 1_000),
          body.selectedModifierIds ?? []
        );
        this.sendJson(res, 200, {
          ...preview,
          totalRecipeCogsMicroBaht: preview.totalCogsMicroBaht,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/adjust-stock') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          outletId?: string;
          variantId: string;
          quantityDeltaMilli: number;
          reason: string;
          performedByUserId?: string;
        }>(req);
        const resDelta = await this.ipc.adjustInventoryStock({
          outletId: body.outletId ?? 'OUTLET-HQ',
          variantId: body.variantId,
          transactionType: 'ADJUSTMENT',
          quantityDeltaMilli: Number(body.quantityDeltaMilli),
          referenceType: 'MANUAL_ADJUSTMENT',
          referenceId: body.reason?.trim() || `ADJ-${Date.now()}`,
          performedByUserId:
            sessionUser?.id ??
            body.performedByUserId ??
            this.ipc.listStaffUsers()[0]?.id ??
            'USR-OWNER-01',
        });
        this.sendJson(res, 200, resDelta);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/stocktake') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          outletId?: string;
          createdByUserId?: string;
          items: ExecuteInventoryCountInput['items'];
        }>(req);
        const actorId =
          sessionUser?.id ??
          body.createdByUserId ??
          this.ipc.listStaffUsers()[0]?.id ??
          'USR-OWNER-01';
        const countRes = await this.executeWithUniqueDocRetry('count_number', () => {
          const countNumber = `CNT-${String(this.countSequenceCounter++).padStart(4, '0')}`;
          return this.ipc.executePhysicalInventoryCount({
            countNumber,
            outletId: body.outletId ?? 'OUTLET-HQ',
            createdByUserId: actorId,
            items: body.items ?? [],
          });
        });
        this.sendJson(res, 200, countRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/outlet') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const body = await this.readJsonBody<{
          id?: string;
          code: string;
          name: string;
          isWarehouse?: boolean;
        }>(req);
        const id = body.id?.trim() || `OUTLET-${body.code.trim().toUpperCase()}`;
        await this.ipc.registerOutlet({
          id,
          code: body.code.trim().toUpperCase(),
          name: body.name.trim(),
          ...(body.isWarehouse !== undefined ? { isWarehouse: body.isWarehouse } : {}),
        });
        this.sendJson(res, 200, { outlets: this.ipc.listOutlets() });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/warehouse/transfers') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        this.sendJson(res, 200, {
          transfers: this.ipc.listTransferOrdersHistory(40),
          outlets: this.ipc.listOutlets(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/transfer-dispatch') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<{
          sourceOutletId: string;
          destinationOutletId: string;
          performedByUserId?: string;
          dispatchedByUserId?: string;
          items: DispatchTransferOrderInput['items'];
        }>(req);
        const actorId =
          sessionUser?.id ??
          body.performedByUserId ??
          body.dispatchedByUserId ??
          this.ipc.listStaffUsers()[0]?.id ??
          'USR-OWNER-01';
        const dispatchRes = await this.executeWithUniqueDocRetry('transfer_number', () => {
          const transferNumber = `TRF-${String(this.transferSequenceCounter++).padStart(4, '0')}`;
          return this.ipc.dispatchTransferOrder({
            transferNumber,
            sourceOutletId: body.sourceOutletId,
            destinationOutletId: body.destinationOutletId,
            performedByUserId: actorId,
            items: body.items ?? [],
          });
        });
        this.sendJson(res, 200, dispatchRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/transfer-receive') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const body = await this.readJsonBody<ReceiveTransferOrderInput>(req);
        const recvRes = await this.ipc.receiveTransferOrder({
          transferOrderId: body.transferOrderId,
          receivedByUserId:
            sessionUser?.id ??
            body.receivedByUserId ??
            this.ipc.listStaffUsers()[0]?.id ??
            'USR-OWNER-01',
        });
        this.sendJson(res, 200, recvRes);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/warehouse/ledger') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'WAREHOUSE']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const variantId = url.searchParams.get('variantId') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 100);
        this.sendJson(res, 200, {
          ledger: this.ipc.listInventoryTransactions(outletId, limit, variantId),
          invariant: this.ipc.verifyLedgerConservationInvariant(outletId),
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 8. Shift Management, Cash Drawer & Resilient External USB Ring-Buffer Backup
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/usb-backup/drives') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const drives = await this.listWindowsStorageDrives();
        this.sendJson(res, 200, {
          drives,
          usbBackupConfig: this.getUsbBackupConfigStatus(true),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/usb-backup/config') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{
          customBackupDir: string;
          mirrorToLocalFallback?: boolean;
        }>(req);
        const usbBackupConfig = await this.saveUsbBackupConfig({
          customBackupDir: String(body.customBackupDir ?? ''),
          ...(body.mirrorToLocalFallback !== undefined
            ? { mirrorToLocalFallback: body.mirrorToLocalFallback }
            : {}),
          actorUserId: sessionUser?.id ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, {
          ok: true,
          usbBackupConfig,
          usbBackups: this.listUsbBackupFiles(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/usb-backup/run-now') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const label = `MANUAL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;
        const backupRes = await this.executeResilientBackupForLabel(label);
        this.sendJson(res, 200, {
          ok: true,
          usbBackup: backupRes.usbBackup,
          ...(backupRes.backupWarningThai ? { backupWarningThai: backupRes.backupWarningThai } : {}),
          usbBackupConfig: this.getUsbBackupConfigStatus(),
          usbBackups: this.listUsbBackupFiles(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/open') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          openedByUserId?: string;
          openingCashSatang: number;
          notes?: string;
        }>(req);
        const actorId =
          sessionUser?.id ??
          body.openedByUserId ??
          this.ipc.listStaffUsers()[0]?.id ??
          'USR-OWNER-01';
        const shift = await this.executeWithUniqueDocRetry('shift_number', () => {
          const shiftNo = `SHF-LIVE-${String(this.shiftSequenceCounter++).padStart(3, '0')}`;
          return this.ipc.openPosShift({
            outletId: body.outletId ?? 'OUTLET-HQ',
            terminalId: 'POS-TERM-01',
            shiftNumber: shiftNo,
            openedByUserId: actorId,
            openingCashSatang: Math.max(0, Number(body.openingCashSatang ?? 100_000)),
            ...(body.notes ? { notes: body.notes } : {}),
          });
        });
        this.sendJson(res, 200, { shift });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/cash-movement') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          shiftId?: string;
          movementType: 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
          amountSatang: number;
          reason: string;
          performedByUserId?: string;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        await this.ensureActiveShiftOpen(outletId);
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        const shiftId = body.shiftId ?? activeShift?.id;
        if (!shiftId) {
          throw new Error('No active OPEN shift found for cash drawer movement');
        }
        const movement = await this.ipc.recordCashDrawerMovement({
          shiftId,
          movementType: body.movementType,
          amountSatang: Number(body.amountSatang),
          reason: body.reason.trim(),
          performedByUserId:
            sessionUser?.id ??
            body.performedByUserId ??
            this.ipc.listStaffUsers()[0]?.id ??
            'USR-OWNER-01',
        });
        this.sendJson(res, 200, {
          movement,
          activeShift: this.ipc.getActiveShift(outletId, 'POS-TERM-01'),
          drawerMovements: this.ipc.listCashDrawerMovements(shiftId),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/shift/movements') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const shiftId = url.searchParams.get('shiftId') ?? '';
        this.sendJson(res, 200, {
          movements: shiftId ? this.ipc.listCashDrawerMovements(shiftId) : [],
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/simulate-yank-usb') {
        this.requireRole(sessionUser, ['OWNER']);
        const corruptPartPath = path.join(
          this.defaultUsbBackupDir,
          `rube_backup_SHF-LIVE-YANKED-${Date.now()}.db.enc.part`
        );
        fs.writeFileSync(corruptPartPath, 'CORRUPT_BYTES_FROM_YANKED_USB_FLASH_DRIVE_SIMULATION');
        this.sendJson(res, 200, {
          ok: true,
          corruptFilename: path.basename(corruptPartPath),
          usbBackups: this.listUsbBackupFiles(),
          message:
            'จำลองการดึงแฟลชไดรฟ์ USB ออกกลางคันสำเร็จ (ทิ้งไฟล์ .part ชำรุดไว้ในไดเรกทอรีสำรองข้อมูล)',
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/close-and-reopen') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          countedCashSatang?: number;
          cashVarianceOffsetSatang?: number;
          closedByUserId?: string;
          reopenNextShift?: boolean;
          notes?: string;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        await this.ensureActiveShiftOpen(outletId);
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01')!;
        let countedCashSatang = activeShift.expectedCashSatang;
        if (typeof body.countedCashSatang === 'number') {
          countedCashSatang = body.countedCashSatang;
        } else if (typeof body.cashVarianceOffsetSatang === 'number') {
          countedCashSatang = Math.max(
            0,
            activeShift.expectedCashSatang + Number(body.cashVarianceOffsetSatang)
          );
        }
        const closedShift = await this.ipc.closePosShiftBlindDrop({
          shiftId: activeShift.id,
          closedByUserId:
            sessionUser?.id ??
            body.closedByUserId ??
            this.ipc.listStaffUsers()[0]?.id ??
            'USR-OWNER-01',
          countedCashSatang,
          notes: body.notes ?? 'Closed from POS Shift Drawer',
        });
        const zReport = this.reportsController.getShiftZReportView(activeShift.id);
        const backupRes = await this.executeResilientBackupForLabel(closedShift.shiftNumber);
        if (body.reopenNextShift !== false) {
          await this.ensureActiveShiftOpen(outletId);
        }
        this.sendJson(res, 200, {
          closedShift,
          zReport: this.formatZReportForUi(zReport),
          usbBackup: backupRes.usbBackup,
          ...(backupRes.backupWarningThai ? { backupWarningThai: backupRes.backupWarningThai } : {}),
          usbBackupConfig: this.getUsbBackupConfigStatus(),
          usbBackups: this.listUsbBackupFiles(),
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 9. Financial Reports, Store Settings, Security Audit & Cluster Mode
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/reports') {
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        await this.ensureActiveShiftOpen(outletId);
        const requestedShiftId = url.searchParams.get('shiftId');
        const startDate = url.searchParams.get('startDate') || undefined;
        const endDate = url.searchParams.get('endDate') || undefined;
        const dateRangeFilter = {
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
        };
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        const shiftsHistory = this.ipc.listShiftsHistory(outletId, 20);
        const targetShiftId = requestedShiftId || activeShift?.id || shiftsHistory[0]?.id;

        const zReport = targetShiftId
          ? this.formatZReportForUi(this.reportsController.getShiftZReportView(targetShiftId))
          : null;
        const abbReport = this.formatAbbReportForUi(
          this.reportsController.getAbbSalesTaxReportView(outletId, dateRangeFilter)
        );
        const valuationReport = this.formatValuationReportForUi(
          this.reportsController.getInventoryValuationReportView(outletId)
        );
        const marginReport = this.formatMarginReportForUi(
          this.reportsController.getMenuCogsAndMarginReportView(outletId, dateRangeFilter)
        );
        this.sendJson(res, 200, {
          zReport,
          abbReport,
          valuationReport,
          marginReport,
          shiftsHistory,
          usbBackups: this.listUsbBackupFiles(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/profile/switch') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{
          profile: BusinessProfile;
          updatedByUserId?: string;
        }>(req);
        const switchRes = await this.securityController.switchBusinessProfile(
          body.profile,
          sessionUser?.id ?? body.updatedByUserId ?? 'USR-OWNER-01'
        );
        this.sendJson(res, 200, switchRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/settings/store') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          storeName: string;
          storeAddress?: string;
          taxId: string;
          branchCode: string;
          rdPosRegNo: string;
          promptPayId: string;
          countryCode?: CountryCode;
          uiLocale?: LocaleCode;
          receiptLocale?: LocaleCode;
          vatRateBps?: number;
          defaultTaxMode?: TaxMode;
          cashRoundingStepMajor?: CashRoundingStepMajor;
          scalePriceEmbeddedMultiplier?: number;
          laoQrStaticTemplate?: string;
          laoQrVerificationPolicy?: LaoQrVerificationPolicy;
          fxRates?: Partial<FxRatesConfigDto>;
          updatedByUserId?: string;
        }>(req);
        const storeSettings = await this.ipc.updateStoreIdentitySettings({
          ...body,
          updatedByUserId: sessionUser?.id ?? body.updatedByUserId ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, {
          storeSettings,
          fiscalConfig: this.ipc.getFiscalConfig(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/settings/fiscal') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<
          Partial<FiscalConfigDto> & { updatedByUserId?: string }
        >(req);
        const fiscalConfig = await this.ipc.updateFiscalConfig({
          ...body,
          updatedByUserId: sessionUser?.id ?? body.updatedByUserId ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, { fiscalConfig });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/settings/locale') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER', 'WAREHOUSE', 'KITCHEN']);
        const body = await this.readJsonBody<{
          uiLocale: LocaleCode;
          receiptLocale?: LocaleCode;
        }>(req);
        const fiscalConfig = await this.ipc.updateUiLocale({
          uiLocale: body.uiLocale,
          ...(body.receiptLocale !== undefined ? { receiptLocale: body.receiptLocale } : {}),
          updatedByUserId: sessionUser?.id ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, { fiscalConfig });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/security/audit-logs') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const limit = Number(url.searchParams.get('limit') ?? 60);
        this.sendJson(res, 200, {
          auditLogs: this.ipc.listSecurityAuditLogs(limit),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/cluster/open-pin') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        this.clusterCoordinator.enableMultiTerminalLanCluster();
        const pin = this.clusterCoordinator.openPairingWindowWith6DigitPin();
        const mdns = this.clusterCoordinator.buildMdnsLeaderAdvertisement('192.168.1.10', 3001);
        this.sendJson(res, 200, {
          pairingPin: pin,
          operatingMode: this.clusterCoordinator.getOperatingMode(),
          mdnsAdvertisement: mdns,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/printer-state') {
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{ ready: boolean }>(req);
        const stateRes = this.printerSpooler.setHardwareReadyState(Boolean(body.ready));
        const cfg = this.getPrinterConfig();
        if (stateRes.printerReady && stateRes.autoFlushedJobs.length > 0) {
          await this.enqueueHardwarePrint(async () => {
            for (const flushed of stateRes.autoFlushedJobs) {
              try {
                await dispatchEscPosPayloadToHardware(
                  cfg,
                  flushed.renderedJob.wirePayloadBytes,
                  `RUBE-POS Flushed ${flushed.receiptNumber}`
                );
              } catch {
                // ignore flush transport errors in simulation
              }
            }
          });
        }
        this.sendJson(res, 200, {
          ready: stateRes.printerReady,
          autoFlushedCount: stateRes.autoFlushedJobs.length,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/ups-state') {
        this.requireRole(sessionUser, ['OWNER']);
        const body = await this.readJsonBody<{
          acPresent: boolean;
          batteryChargePercent: number;
        }>(req);
        const state = await this.upsMonitor.handleHidPowerReport({
          acPresent: Boolean(body.acPresent),
          batteryChargePercent: Number(body.batteryChargePercent ?? 100),
          estimatedRuntimeSeconds: Boolean(body.acPresent) ? 3600 : 900,
        });
        this.sendJson(res, 200, {
          protectionState: state,
          upsBanner: this.upsMonitor.getActiveUiAlertBanner(),
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 10. Local QR Table Ordering & Captive Portal Management (POS Port 4173)
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/qr-ordering/config') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const config = this.ipc.getQrOrderingConfig();
        const status = this.guestQrServer.getRuntimeStatus(config);
        const tableSessions = this.ipc.listTableQrSessions(outletId, status.baseUrl);
        this.sendJson(res, 200, { config, status, tableSessions });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/qr-ordering/config') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER']);
        const body = await this.readJsonBody<
          Partial<QrOrderingConfigDto> & { outletId?: string }
        >(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const config = await this.ipc.updateQrOrderingConfig({
          ...body,
          updatedByUserId: sessionUser?.id ?? 'USR-OWNER-01',
        });
        const status = await this.guestQrServer.syncWithConfig(config);
        const tableSessions = this.ipc.listTableQrSessions(outletId, status.baseUrl);
        this.sendJson(res, 200, { ok: true, config, status, tableSessions });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/qr-ordering/table-session') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          tableLabel: string;
          openedByName?: string;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const status = this.guestQrServer.getRuntimeStatus();
        const session = await this.ipc.openTableQrSession({
          outletId,
          tableLabel: String(body.tableLabel ?? ''),
          openedByName:
            sessionUser?.displayName ?? body.openedByName ?? 'Staff',
          baseUrl: status.baseUrl,
          actorUserId: sessionUser?.id ?? 'USR-CASHIER-01',
        });
        const tableSessions = this.ipc.listTableQrSessions(outletId, status.baseUrl);
        this.sendJson(res, 200, { ok: true, session, tableSessions });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/qr-ordering/table-session') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          tableLabel: string;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const resRevoke = await this.ipc.revokeTableQrSession({
          outletId,
          tableLabel: String(body.tableLabel ?? ''),
          actorUserId: sessionUser?.id ?? 'USR-CASHIER-01',
        });
        const status = this.guestQrServer.getRuntimeStatus();
        const tableSessions = this.ipc.listTableQrSessions(outletId, status.baseUrl);
        this.sendJson(res, 200, { ok: true, revoked: resRevoke.revoked, tableSessions });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/qr-ordering/orders') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN']);
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const orders = this.ipc.listGuestOrders(outletId);
        const pendingCount = orders.filter((o) => o.status === 'PENDING_CONFIRM').length;
        const status = this.guestQrServer.getRuntimeStatus();
        const tableSessions = this.ipc.listTableQrSessions(outletId, status.baseUrl);
        this.sendJson(res, 200, { orders, pendingCount, tableSessions, status });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/qr-ordering/orders/accept') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          guestOrderId: string;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        await this.ensureActiveShiftOpen(outletId);
        const accepted = await this.ipc.acceptGuestOrderToHeldBillAndKds({
          outletId,
          guestOrderId: String(body.guestOrderId ?? ''),
          actorUserId: sessionUser?.id ?? 'USR-CASHIER-01',
          actorDisplayName: sessionUser?.displayName ?? 'Cashier',
        });
        this.sendJson(res, 200, {
          ok: true,
          ...accepted,
          orders: this.ipc.listGuestOrders(outletId),
          heldBills: this.getHeldBillsForOutlet(outletId),
          kdsTickets: this.ipc.listKitchenOrdersAllStations(outletId, false),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/qr-ordering/orders/reject') {
        await this.ensureSeededIfAppropriate();
        this.requireRole(sessionUser, ['OWNER', 'MANAGER', 'CASHIER']);
        const body = await this.readJsonBody<{
          outletId?: string;
          guestOrderId: string;
          reason?: string;
        }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const order = await this.ipc.rejectGuestOrder({
          outletId,
          guestOrderId: String(body.guestOrderId ?? ''),
          reason: String(body.reason ?? ''),
          actorUserId: sessionUser?.id ?? 'USR-CASHIER-01',
          actorDisplayName: sessionUser?.displayName ?? 'Cashier',
        });
        this.sendJson(res, 200, {
          ok: true,
          order,
          orders: this.ipc.listGuestOrders(outletId),
        });
        return;
      }

      this.sendJson(res, 404, { error: `Route not found: ${method} ${url.pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = message.includes('401')
        ? 401
        : message.includes('403')
          ? 403
          : message.includes('409') || message.includes('Duplicate')
            ? 409
            : message.includes('413')
              ? 413
              : message.includes('422') || message.includes('Circular')
                ? 422
                : message.includes('423') || message.includes('QUARANTINE')
                  ? 423
                  : message.includes('429')
                    ? 429
                    : 400;
      this.sendJson(res, statusCode, { error: message });
    }
  }

  public async start(
    port = 4173,
    host = '127.0.0.1'
  ): Promise<{ url: string; port: number }> {
    try {
      await this.ensureSessionHmacSecretPersisted();
      await this.ensureActiveShiftOpen();
      const qrCfg = this.ipc.getQrOrderingConfig();
      if (qrCfg.enabled) {
        await this.guestQrServer.syncWithConfig(qrCfg);
      }

      return await new Promise<{ url: string; port: number }>((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          void this.handleRequest(req, res);
        });
        const onError = (err: Error) => {
          try {
            srv.close();
          } catch {
            // ignore close error during failed startup
          }
          reject(err);
        };
        srv.once('error', onError);
        srv.listen(port, host, () => {
          srv.removeListener('error', onError);
          this.server = srv;
          const addr = srv.address();
          const boundPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve({
            url: `http://${host}:${boundPort}`,
            port: boundPort,
          });
        });
      });
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }
  }

  public async stop(): Promise<void> {
    await this.guestQrServer.stop().catch(() => {});
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    if (!this.engineClosed) {
      this.engineClosed = true;
      try {
        this.engine.close();
      } catch {
        // ignore if already closed
      }
    }
  }
}
