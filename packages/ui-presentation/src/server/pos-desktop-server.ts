/**
 * RUBE-STOCK-POS v3.1 Interactive Full-Stack POS & Warehouse Desktop/Web Application Server
 *
 * Supports:
 * - Production Clean-Start Mode (`requireFirstRunWizard: true`) + Dual-KEK `.recovery-kit` generation
 * - Real Thermal Printer Hardware Dispatch (`LAN TCP :9100`, `Windows Raw USB winspool.drv`, & `203-DPI HTML5 Canvas Raster`)
 * - Split-Tender Payments (`CASH` + `PROMPTPAY_QR` + `CARD`), Modifier Groups CRUD, Catalog CRUD, PIN Auth & Full WMS
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  type UpsertCatalogVariantInput,
} from '../../../core-engine/src/runtime/sqlite-engine.ts';
import { LanClusterCoordinator } from '../../../cluster-gateway/src/lan-cluster-coordinator.ts';
import { LocalIpcBridge } from '../../../cluster-gateway/src/local-ipc-bridge.ts';
import {
  buildTwoPhaseSlipConfirmationModal,
  commitVerifiedBotSlipHash,
  generateOfflinePromptPayDynamicQr,
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
  computeVatSatang,
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
  type TaxMode,
} from '../../../shared-contracts/src/fixed-point.ts';
import type {
  BomEdgeDto,
  BusinessProfile,
  CheckoutOrderRequest,
  ComponentRole,
  SplitPaymentLegInput,
  UserRole,
} from '../../../shared-contracts/src/ipc-commands.ts';
import { resolveProfileFeatureFlags } from '../profiles/profile-config.ts';
import { PosTerminalViewController } from '../views/pos-terminal/PosTerminalView.ts';
import { FinancialAndBackupReportViewController } from '../views/reports/FinancialAndBackupReportView.ts';
import { SystemSecurityAndProfileViewController } from '../views/settings/SystemSecurityAndProfileView.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
}

export class RubePosInteractiveAppServer {
  public readonly engine: SqliteReadWritePoolEngine;
  public readonly clusterCoordinator: LanClusterCoordinator;
  public readonly ipc: LocalIpcBridge;
  public readonly posController: PosTerminalViewController;
  public readonly reportsController: FinancialAndBackupReportViewController;
  public readonly securityController: SystemSecurityAndProfileViewController;
  public readonly printerSpooler: ThermalPrinterSpoolerQueue;
  public readonly upsMonitor: UpsPowerHidMonitor;

  private readonly dbPath: string;
  private readonly usbBackupDir: string;
  private readonly keystoreManifestPath: string;
  private readonly requireFirstRunWizard: boolean;
  private forceWizardPreview = false;

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
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.usbBackupDir =
      options.usbBackupDir ?? path.join(path.dirname(options.dbPath), 'usb-backups');
    this.keystoreManifestPath = path.join(path.dirname(options.dbPath), 'keystore.manifest.json');
    fs.mkdirSync(this.usbBackupDir, { recursive: true });

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
      const shiftRow = this.engine.executeRead((db) => {
        return db.prepare('SELECT count(*) as cnt FROM pos_shifts').get() as
          | { cnt: number }
          | undefined;
      });
      if (shiftRow && typeof shiftRow.cnt === 'number') {
        this.shiftSequenceCounter = Math.max(1, shiftRow.cnt + 1);
      }
      const poRow = this.engine.executeRead((db) => {
        return db.prepare('SELECT count(*) as cnt FROM purchase_orders').get() as
          | { cnt: number }
          | undefined;
      });
      if (poRow && typeof poRow.cnt === 'number') {
        this.poSequenceCounter = Math.max(1, poRow.cnt + 1);
      }
      const trRow = this.engine.executeRead((db) => {
        return db.prepare('SELECT count(*) as cnt FROM transfer_orders').get() as
          | { cnt: number }
          | undefined;
      });
      if (trRow && typeof trRow.cnt === 'number') {
        this.transferSequenceCounter = Math.max(1, trRow.cnt + 1);
      }
      const cntRow = this.engine.executeRead((db) => {
        return db.prepare('SELECT count(*) as cnt FROM inventory_counts').get() as
          | { cnt: number }
          | undefined;
      });
      if (cntRow && typeof cntRow.cnt === 'number') {
        this.countSequenceCounter = Math.max(1, cntRow.cnt + 1);
      }
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
    } catch {
      // schema might be uninitialized
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

  private async ensureSeededIfAppropriate(): Promise<void> {
    if (this.requireFirstRunWizard && !this.ipc.isSystemOnboarded()) {
      return;
    }
    if (!this.seeded && !this.ipc.isSystemOnboarded()) {
      await this.engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      this.seeded = true;
    }
  }

  private async ensureActiveShiftOpen(): Promise<void> {
    if (this.requireFirstRunWizard && !this.ipc.isSystemOnboarded()) {
      return;
    }
    await this.ensureSeededIfAppropriate();
    const active = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01');
    if (!active && this.ipc.isSystemOnboarded()) {
      const users = this.ipc.listStaffUsers();
      const openerId =
        users.find((u) => u.id === 'USR-CASHIER-01')?.id ??
        users[0]?.id ??
        'USR-OWNER-01';
      let opened = false;
      while (!opened) {
        const shiftNo = `SHF-LIVE-${String(this.shiftSequenceCounter++).padStart(3, '0')}`;
        try {
          await this.ipc.openPosShift({
            outletId: 'OUTLET-HQ',
            terminalId: 'POS-TERM-01',
            shiftNumber: shiftNo,
            openedByUserId: openerId,
            openingCashSatang: 100_000,
          });
          opened = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('UNIQUE') || msg.includes('shift_number')) {
            continue;
          }
          throw err;
        }
      }
    }
  }

  private listUsbBackupFiles(): Array<{ filename: string; sizeBytes: number; modifiedAt: string }> {
    try {
      if (!fs.existsSync(this.usbBackupDir)) return [];
      return fs
        .readdirSync(this.usbBackupDir)
        .filter((f) => f.startsWith('rube_backup_'))
        .map((filename) => {
          const full = path.join(this.usbBackupDir, filename);
          const st = fs.statSync(full);
          return {
            filename,
            sizeBytes: st.size,
            modifiedAt: st.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    } catch {
      return [];
    }
  }

  private computeCartTotals(
    lines: Array<{
      variantId: string;
      itemName?: string | undefined;
      unitName?: string | undefined;
      quantityMilli: number;
      unitPriceSatang: number;
      selectedModifierIds?: string[] | undefined;
    }>,
    discountSatang: number,
    taxMode: TaxMode
  ) {
    const modifiersMap = new Map(this.ipc.listModifiers().map((m) => [m.id, m]));
    let subtotalSatang = 0;

    const formattedLines = lines.map((line) => {
      const mods = (line.selectedModifierIds ?? [])
        .map((id) => modifiersMap.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined);
      const modDeltaSatang = mods.reduce((sum, m) => sum + m.priceDeltaSatang, 0);
      const lineTotalSatang = Number(
        roundDivBigInt(
          BigInt(line.quantityMilli) * BigInt(line.unitPriceSatang + modDeltaSatang),
          SCALE_MILLI
        )
      );
      subtotalSatang += lineTotalSatang;
      const modsJoined = mods.map((m) => m.name).join(', ');
      return {
        itemName: line.itemName ?? line.variantId,
        quantityFormatted: formatMilliUnitsToQtyString(
          line.quantityMilli,
          line.unitName ?? 'ชิ้น'
        ),
        lineTotalFormatted: `฿${formatSatangToThbString(lineTotalSatang)}`,
        ...(modsJoined ? { modifiersText: modsJoined } : {}),
      };
    });

    const afterDiscount = Math.max(0, subtotalSatang - Math.max(0, discountSatang));
    const taxSatang = computeVatSatang(afterDiscount, 700, taxMode);
    const netBeforeTaxSatang = taxMode === 'INCLUSIVE' ? afterDiscount - taxSatang : afterDiscount;
    const totalSatang = taxMode === 'EXCLUSIVE' ? afterDiscount + taxSatang : afterDiscount;

    return {
      subtotalSatang,
      taxSatang,
      netBeforeTaxSatang,
      totalSatang,
      formattedLines,
    };
  }

  private formatZReportForUi(z: ShiftZReportDto) {
    const thb = (satang: number) => `฿${formatSatangToThbString(satang)}`;
    return {
      ...z,
      openingCashFormatted: thb(z.openingCashSatang),
      grossSalesFormatted: thb(z.grossSalesSatang),
      discountsFormatted: thb(z.discountTotalSatang),
      netBeforeTaxFormatted: thb(z.netBeforeTaxSatang),
      vat7PercentFormatted: thb(z.vatTotalSatang),
      netSalesTotalFormatted: thb(z.netSalesTotalSatang),
      cashSalesFormatted: thb(z.cashSalesSatang),
      promptPaySalesFormatted: thb(z.promptPayQrSalesSatang),
      cardSalesFormatted: thb(z.cardSalesSatang),
      voucherSalesFormatted: thb(z.voucherSalesSatang),
      paidInFormatted: thb(z.paidInSatang),
      paidOutFormatted: thb(z.paidOutSatang),
      cashDropFormatted: thb(z.cashDropSatang),
      voidedTotalFormatted: thb(z.voidedTotalSatang),
      expectedDrawerCashFormatted: thb(z.expectedCashSatang),
      countedDrawerCashFormatted: z.countedCashSatang === null ? null : thb(z.countedCashSatang),
      cashVarianceFormatted: z.cashVarianceSatang === null ? null : thb(z.cashVarianceSatang),
    };
  }

  private formatAbbReportForUi(abb: AbbSalesTaxReportDto) {
    const thb = (satang: number) => `฿${formatSatangToThbString(satang)}`;
    return {
      ...abb,
      totalTaxableBaseFormatted: thb(abb.totalNetBeforeTaxSatang),
      totalVatFormatted: thb(abb.totalVatSatang),
      totalGrossFormatted: thb(abb.totalGrossAmountSatang),
      invoices: abb.invoices.map((inv) => ({
        ...inv,
        netBeforeTaxFormatted: thb(inv.netBeforeTaxSatang),
        taxFormatted: thb(inv.taxSatang),
        totalFormatted: thb(inv.totalSatang),
      })),
    };
  }

  private formatValuationReportForUi(val: InventoryValuationReportDto) {
    return {
      ...val,
      totalWarehouseValuationFormatted: `฿${formatSatangToThbString(val.totalWarehouseValuationSatang)}`,
      lines: val.lines.map((l) => ({
        ...l,
        stockFormatted: formatMilliUnitsToQtyString(l.inStockMilli, l.unitName),
        macFormatted: `฿${formatMicroBahtToThbString(l.averageCostMicroBaht)}`,
        valuationFormatted: `฿${formatSatangToThbString(l.totalValuationSatang)}`,
      })),
    };
  }

  private formatMarginReportForUi(m: MenuGrossMarginReportDto) {
    const thb = (satang: number) => `฿${formatSatangToThbString(satang)}`;
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
      totalRevenueFormatted: thb(m.totalRevenueSatang),
      totalCogsFormatted: thb(m.totalCogsSatang),
      totalGrossProfitFormatted: thb(m.totalGrossProfitSatang),
      totalGrossMarginPercentFormatted: `${(totalGpBps / 100).toFixed(2)}%`,
      lines: m.lines.map((l) => ({
        ...l,
        soldQtyFormatted: formatMilliUnitsToQtyString(l.soldQtyMilli),
        revenueFormatted: thb(l.grossRevenueSatang),
        cogsFormatted: thb(l.totalCogsSatang),
        grossProfitFormatted: thb(l.grossProfitSatang),
        grossMarginPercentFormatted: `${(l.grossMarginBasisPoints / 100).toFixed(2)}%`,
      })),
    };
  }

  private async readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

  private tryServeStaticUi(pathname: string, res: http.ServerResponse): boolean {
    const distDir = path.resolve(__dirname, '../../dist');
    const distIndex = path.join(distDir, 'index.html');
    const fallbackHtml = path.resolve(__dirname, '../web/index.html');

    if (fs.existsSync(distIndex)) {
      if (pathname === '/' || pathname === '/index.html') {
        this.setCorsHeaders(res);
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
        this.setCorsHeaders(res);
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
      this.setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(fallbackHtml, 'utf8'));
      return true;
    }

    return false;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';

      if (method === 'OPTIONS') {
        this.setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (this.tryServeStaticUi(url.pathname, res)) {
          return;
        }
      }

      // ----------------------------------------------------------------------
      // 0. First-Run Setup Wizard & Production Clean-Start Onboarding
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/onboarding/preview-wizard') {
        const body = await this.readJsonBody<{ show: boolean }>(req);
        this.forceWizardPreview = Boolean(body.show);
        this.sendJson(res, 200, { ok: true, forceWizardPreview: this.forceWizardPreview });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/onboarding/complete') {
        const body = await this.readJsonBody<
          FirstRunOnboardingInput & {
            recoveryPassphrase: string;
            printerConfig?: Partial<PrinterHardwareConfig>;
          }
        >(req);

        const onboardRes = await this.ipc.initializeFirstRunOnboarding(body);
        this.forceWizardPreview = false;

        if (body.printerConfig) {
          await this.savePrinterConfig({
            ...this.getPrinterConfig(),
            ...body.printerConfig,
          });
        }

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

        this.sendJson(res, 200, {
          ok: true,
          ...onboardRes,
          recoveryKitFilename,
          recoveryKitContent,
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 1. Bootstrap & System State
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/bootstrap') {
        const isCurrentlyOnboarded = this.ipc.isSystemOnboarded();
        const isPreviewWizard = this.forceWizardPreview && isCurrentlyOnboarded;
        if ((this.requireFirstRunWizard && !isCurrentlyOnboarded) || this.forceWizardPreview) {
          const previewStoreSettings = isCurrentlyOnboarded
            ? this.ipc.getStoreIdentitySettings('OUTLET-HQ')
            : {
                outletId: 'OUTLET-HQ',
                outletCode: 'HQ-01',
                storeName: '',
                taxId: '',
                branchCode: '00000',
                rdPosRegNo: '',
                promptPayId: '',
                businessProfile: 'HYBRID' as BusinessProfile,
              };
          const previewProfile = previewStoreSettings.businessProfile;
          this.sendJson(res, 200, {
            onboarded: false,
            isPreviewWizard,
            profile: previewProfile,
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
            shiftsHistory: [],
            drawerMovements: [],
            staffUsers: isCurrentlyOnboarded ? this.ipc.listStaffUsers() : [],
            storeSettings: previewStoreSettings,
            printerConfig: this.getPrinterConfig(),
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

        const autoOpenShift = url.searchParams.get('autoOpenShift') !== 'false';
        if (autoOpenShift) {
          await this.ensureActiveShiftOpen();
        } else {
          await this.ensureSeededIfAppropriate();
        }

        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const { profile, featureFlags } =
          this.securityController.getActiveProfileWithFeatureFlags();
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        const catalog = this.ipc.getInventoryCatalog(outletId);
        const catalogDetailed = this.ipc.listCatalogVariantsDetailed(outletId);
        const categories = this.ipc.listCategories();
        const suppliers = this.ipc.listSuppliers();
        const outlets = this.ipc.listOutlets();
        const bomEdges = this.ipc.listBomEdges();
        const modifiers = this.ipc.listModifiers();
        const modifierGroups = this.ipc.listModifierGroupsWithModifiers();
        const kdsTickets = this.ipc.listKitchenOrdersAllStations(outletId, false);
        const recentOrders = this.ipc.listRecentSalesOrders(outletId, 30);
        const shiftsHistory = this.ipc.listShiftsHistory(outletId, 15);
        const drawerMovements = activeShift
          ? this.ipc.listCashDrawerMovements(activeShift.id)
          : [];
        const staffUsers = this.ipc.listStaffUsers();
        const storeSettings = this.ipc.getStoreIdentitySettings(outletId);
        const ledgerInvariant = this.ipc.verifyLedgerConservationInvariant(outletId);
        const upsBanner = this.upsMonitor.getActiveUiAlertBanner();

        this.sendJson(res, 200, {
          onboarded: true,
          profile,
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
          shiftsHistory,
          drawerMovements,
          staffUsers,
          storeSettings,
          printerConfig: this.getPrinterConfig(),
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
        this.sendJson(res, 200, { printerConfig: this.getPrinterConfig() });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/printer/config') {
        const body = await this.readJsonBody<PrinterHardwareConfig>(req);
        const saved = await this.savePrinterConfig(body);
        this.sendJson(res, 200, { printerConfig: saved });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/printer/windows-list') {
        const printers = await listWindowsInstalledPrinters();
        this.sendJson(res, 200, { printers });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/kick-drawer') {
        const cfg = this.getPrinterConfig();
        const outcome = await dispatchEscPosPayloadToHardware(
          cfg,
          ESC_POS_KICK_DRAWER_BYTES,
          'RUBE-POS Cash Drawer Kick'
        );
        this.sendJson(res, 200, { ok: true, outcome });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/print-canvas-raster') {
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
            hardwareOutcome = await dispatchEscPosPayloadToHardware(
              cfg,
              renderedJob.wirePayloadBytes,
              `RUBE-POS ${body.receiptNumber ?? 'Receipt'}`
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
        const body = await this.readJsonBody<{ pin: string; userId?: string }>(req);
        const user = await this.ipc.authenticateStaffByPin({
          pin: String(body.pin ?? ''),
          userId: body.userId,
          terminalId: 'POS-TERM-01',
        });
        this.sendJson(res, 200, { user });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/auth/users') {
        await this.ensureSeededIfAppropriate();
        this.sendJson(res, 200, { users: this.ipc.listStaffUsers() });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/users') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          id?: string;
          username: string;
          displayName: string;
          role: UserRole;
          pin?: string;
          active?: boolean;
          actorUserId?: string;
        }>(req);
        const user = await this.ipc.upsertStaffUser(body);
        this.sendJson(res, 200, { user });
        return;
      }

      // ----------------------------------------------------------------------
      // 4. Hardware Simulator & POS Checkout (with Split Payment) / Void / Reprint
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/hal/simulate-scan') {
        await this.ensureSeededIfAppropriate();
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

      if (method === 'POST' && url.pathname === '/api/pos/promptpay-qr') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          outletId?: string;
          overrideAmountSatang?: number;
          taxMode?: TaxMode;
          discountSatang?: number;
          lines?: Array<{
            variantId: string;
            quantityMilli: number;
            unitPriceSatang: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);
        const settings = this.ipc.getStoreIdentitySettings(body.outletId ?? 'OUTLET-HQ');
        const totals = this.computeCartTotals(
          body.lines ?? [],
          Number(body.discountSatang ?? 0),
          body.taxMode ?? 'INCLUSIVE'
        );
        const targetAmountSatang =
          body.overrideAmountSatang && body.overrideAmountSatang > 0
            ? Number(body.overrideAmountSatang)
            : totals.totalSatang;

        const qr = generateOfflinePromptPayDynamicQr(settings.promptPayId, targetAmountSatang);
        this.sendJson(res, 200, {
          ...qr,
          promptPayId: settings.promptPayId,
          storeName: settings.storeName,
          totalSatang: targetAmountSatang,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/verify-slip-step1') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          miniQrRaw: string;
          overrideAmountSatang?: number;
          taxMode?: TaxMode;
          discountSatang?: number;
          lines?: Array<{
            variantId: string;
            quantityMilli: number;
            unitPriceSatang: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);
        const totals = this.computeCartTotals(
          body.lines ?? [],
          Number(body.discountSatang ?? 0),
          body.taxMode ?? 'INCLUSIVE'
        );
        const expectedSatang =
          body.overrideAmountSatang && body.overrideAmountSatang > 0
            ? Number(body.overrideAmountSatang)
            : totals.totalSatang;

        const modal = buildTwoPhaseSlipConfirmationModal(
          String(body.miniQrRaw ?? ''),
          expectedSatang,
          this.usedSlipHashes
        );
        this.sendJson(res, 200, modal);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/checkout') {
        await this.ensureActiveShiftOpen();
        const body = await this.readJsonBody<{
          outletId?: string;
          cashierId?: string;
          orderType?: CheckoutOrderRequest['orderType'];
          tableOrQueueNo?: string;
          paymentMethod: CheckoutOrderRequest['paymentMethod'];
          cashTenderedSatang?: number;
          slipTransRefRaw?: string;
          splitPayments?: SplitPaymentLegInput[];
          taxMode?: TaxMode;
          discountSatang?: number;
          paperWidthPx?: 384 | 576;
          lines: Array<{
            variantId: string;
            itemName?: string;
            unitName?: string;
            quantityMilli: number;
            unitPriceSatang: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);

        const outletId = body.outletId ?? 'OUTLET-HQ';
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        if (!activeShift) {
          throw new Error('No active OPEN cashier shift found. Please open a shift before checkout.');
        }

        const taxMode: TaxMode = body.taxMode ?? 'INCLUSIVE';
        const discountSatang = Number(body.discountSatang ?? 0);
        const totals = this.computeCartTotals(body.lines ?? [], discountSatang, taxMode);
        const checkoutLines = (body.lines ?? []).map((l) => ({
          variantId: l.variantId,
          quantityMilli: Number(l.quantityMilli),
          unitPriceSatang: Number(l.unitPriceSatang),
          selectedModifierIds: l.selectedModifierIds ?? [],
        }));

        const idempotencyKey = `IDEM-UI-${Date.now()}-${this.checkoutSequenceCounter++}`;
        const hasSplit = Boolean(body.splitPayments && body.splitPayments.length > 0);
        const cashTendered =
          !hasSplit && body.paymentMethod === 'CASH'
            ? Math.max(totals.totalSatang, Number(body.cashTenderedSatang ?? totals.totalSatang))
            : undefined;

        const order = await this.ipc.checkoutSalesOrder({
          idempotencyKey,
          outletId,
          terminalId: 'POS-TERM-01',
          shiftId: activeShift.id,
          cashierId: body.cashierId ?? 'USR-CASHIER-01',
          orderType: body.orderType ?? 'TAKEAWAY',
          ...(body.tableOrQueueNo !== undefined ? { tableOrQueueNo: body.tableOrQueueNo } : {}),
          taxMode,
          discountSatang,
          paymentMethod: body.paymentMethod,
          ...(cashTendered !== undefined ? { cashTenderedSatang: cashTendered } : {}),
          ...(body.slipTransRefRaw !== undefined ? { slipTransRefRaw: body.slipTransRefRaw } : {}),
          ...(hasSplit ? { splitPayments: body.splitPayments } : {}),
          lines: checkoutLines,
        });

        if (order.slipTransRefHash) {
          commitVerifiedBotSlipHash(order.slipTransRefHash, this.usedSlipHashes);
        }

        const settings = this.ipc.getStoreIdentitySettings(outletId);
        const printerCfg = this.getPrinterConfig();
        const widthPx: 384 | 576 =
          body.paperWidthPx ?? (printerCfg.paperWidthMm === 58 ? 384 : 576);
        const hasCashLeg = order.payments.some((p) => p.paymentMethod === 'CASH');

        const renderedJob = renderThaiReceiptAbbEscPosJob({
          storeName: settings.storeName,
          taxId: settings.taxId,
          branchCode: settings.branchCode,
          posRegNo: settings.rdPosRegNo,
          receiptNumber: order.receiptNumber,
          abbTaxInvoiceNo: order.abbTaxInvoiceNo,
          lines: totals.formattedLines,
          subtotalFormatted: `฿${formatSatangToThbString(order.subtotalSatang)}`,
          discountFormatted: `฿${formatSatangToThbString(order.discountSatang)}`,
          netBeforeTaxFormatted: `฿${formatSatangToThbString(order.netBeforeTaxSatang)}`,
          taxFormatted: `฿${formatSatangToThbString(order.taxSatang)}`,
          totalFormatted: `฿${formatSatangToThbString(order.totalSatang)}`,
          paymentMethod: order.paymentMethod,
          ...(order.cashTenderedSatang !== null
            ? { cashTenderedFormatted: `฿${formatSatangToThbString(order.cashTenderedSatang)}` }
            : {}),
          ...(order.changeGivenSatang !== null
            ? { changeGivenFormatted: `฿${formatSatangToThbString(order.changeGivenSatang)}` }
            : {}),
          ...(order.slipTransRefLast4 ? { slipRefLast4: order.slipTransRefLast4 } : {}),
          kickCashDrawer: hasCashLeg && printerCfg.autoKickDrawerOnCash,
          widthPx,
        });

        // Append explicit split payment lines onto formattedTextLines when multiple legs exist
        if (order.payments.length > 1) {
          renderedJob.formattedTextLines.splice(
            renderedJob.formattedTextLines.length - 1,
            0,
            ...order.payments.map(
              (p) =>
                `  • แยกจ่าย ${p.paymentMethod}: ฿${formatSatangToThbString(p.amountSatang)}${p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''}`
            )
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
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const limit = Number(url.searchParams.get('limit') ?? 40);
        this.sendJson(res, 200, {
          orders: this.ipc.listRecentSalesOrders(outletId, limit),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/reprint') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{ salesOrderId: string; outletId?: string }>(req);
        const outletId = body.outletId ?? 'OUTLET-HQ';
        const target = this.ipc
          .listRecentSalesOrders(outletId, 200)
          .find((o) => o.salesOrderId === body.salesOrderId);
        if (!target) {
          throw new Error(`Sales order ${body.salesOrderId} not found`);
        }

        const settings = this.ipc.getStoreIdentitySettings(outletId);
        const printerCfg = this.getPrinterConfig();
        const renderedJob = renderThaiReceiptAbbEscPosJob({
          storeName: `${settings.storeName} [สำเนา/REPRINT]`,
          taxId: settings.taxId,
          branchCode: settings.branchCode,
          posRegNo: settings.rdPosRegNo,
          receiptNumber: target.receiptNumber,
          abbTaxInvoiceNo: target.abbTaxInvoiceNo ?? '-',
          lines: target.lines.map((l) => {
            const modsText = l.modifiers.map((m) => m.name).join(', ');
            return {
              itemName: l.itemName,
              quantityFormatted: formatMilliUnitsToQtyString(l.quantityMilli, l.unitName),
              lineTotalFormatted: `฿${formatSatangToThbString(l.lineTotalSatang)}`,
              ...(modsText ? { modifiersText: modsText } : {}),
            };
          }),
          subtotalFormatted: `฿${formatSatangToThbString(target.subtotalSatang)}`,
          discountFormatted: `฿${formatSatangToThbString(target.discountSatang)}`,
          netBeforeTaxFormatted: `฿${formatSatangToThbString(target.netBeforeTaxSatang)}`,
          taxFormatted: `฿${formatSatangToThbString(target.taxSatang)}`,
          totalFormatted: `฿${formatSatangToThbString(target.totalSatang)}`,
          paymentMethod: target.paymentMethod,
          ...(target.cashTenderedSatang !== null
            ? { cashTenderedFormatted: `฿${formatSatangToThbString(target.cashTenderedSatang)}` }
            : {}),
          ...(target.changeGivenSatang !== null
            ? { changeGivenFormatted: `฿${formatSatangToThbString(target.changeGivenSatang)}` }
            : {}),
          ...(target.slipTransRefLast4 ? { slipRefLast4: target.slipTransRefLast4 } : {}),
          kickCashDrawer: false,
          widthPx: printerCfg.paperWidthMm === 58 ? 384 : 576,
        });

        if (target.payments && target.payments.length > 1) {
          renderedJob.formattedTextLines.splice(
            renderedJob.formattedTextLines.length - 1,
            0,
            ...target.payments.map(
              (p) =>
                `  • แยกจ่าย ${p.paymentMethod}: ฿${formatSatangToThbString(p.amountSatang)}${p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''}`
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
        const body = await this.readJsonBody<{
          salesOrderId: string;
          voidedByUserId?: string;
          voidReason?: string;
        }>(req);
        const voidRes = await this.ipc.voidSalesOrder({
          salesOrderId: String(body.salesOrderId),
          voidedByUserId: body.voidedByUserId ?? 'USR-OWNER-01',
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
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const includeServed = url.searchParams.get('includeServed') === 'true';
        this.sendJson(res, 200, {
          tickets: this.ipc.listKitchenOrdersAllStations(outletId, includeServed),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/kds/bump') {
        await this.ensureSeededIfAppropriate();
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
      // 6. Master Catalog, Categories, Suppliers & Modifier Groups CRUD
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/catalog') {
        await this.ensureSeededIfAppropriate();
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        this.sendJson(res, 200, {
          variants: this.ipc.listCatalogVariantsDetailed(outletId),
          categories: this.ipc.listCategories(),
          suppliers: this.ipc.listSuppliers(),
          modifierGroups: this.ipc.listModifierGroupsWithModifiers(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/variant') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<UpsertCatalogVariantInput>(req);
        const variant = await this.ipc.upsertCatalogVariant(body);
        this.sendJson(res, 200, { variant });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/category') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          id?: string;
          name: string;
          displayColor?: string;
          kitchenStation?: string;
          sortOrder?: number;
        }>(req);
        const category = await this.ipc.upsertCategory(body);
        this.sendJson(res, 200, { category });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/catalog/supplier') {
        await this.ensureSeededIfAppropriate();
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
          createdByUserId: 'USR-WH-01',
          items: body.items ?? [],
          landedCosts: body.landedCosts ?? [],
        });
        this.sendJson(res, 200, { lines: preview });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/receive-po') {
        await this.ensureSeededIfAppropriate();
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
          body.createdByUserId ??
          this.ipc.listStaffUsers()[0]?.id ??
          'USR-OWNER-01';

        let poRes;
        let createdPo = false;
        while (!createdPo) {
          const poNumber = `PO-LIVE-${String(this.poSequenceCounter++).padStart(4, '0')}`;
          try {
            poRes = await this.ipc.receivePurchaseOrderWithLandedCosts({
              poNumber,
              outletId: body.outletId ?? 'OUTLET-HQ',
              supplierId: body.supplierId ?? 'SUP-001',
              createdByUserId: actorId,
              items,
              landedCosts,
            });
            createdPo = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('UNIQUE') || msg.includes('po_number')) {
              continue;
            }
            throw err;
          }
        }
        this.sendJson(res, 200, poRes);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/warehouse/po-history') {
        await this.ensureSeededIfAppropriate();
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        this.sendJson(res, 200, {
          purchaseOrders: this.ipc.listPurchaseOrdersHistory(outletId, 40),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/build-prep') {
        await this.ensureSeededIfAppropriate();
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
            body.performedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, {
          ...buildRes,
          CompositeStockAfterMilli: buildRes.newCompositeStockMilli,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/bom-edge') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<BomEdgeDto>(req);
        await this.ipc.upsertBomComponentEdge(body);
        this.sendJson(res, 200, { ok: true, bomEdges: this.ipc.listBomEdges() });
        return;
      }

      if (method === 'DELETE' && url.pathname === '/api/warehouse/bom-edge') {
        await this.ensureSeededIfAppropriate();
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
            body.performedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, resDelta);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/stocktake') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          outletId?: string;
          createdByUserId?: string;
          items: ExecuteInventoryCountInput['items'];
        }>(req);
        const countNumber = `CNT-${String(this.countSequenceCounter++).padStart(4, '0')}`;
        const countRes = await this.ipc.executePhysicalInventoryCount({
          countNumber,
          outletId: body.outletId ?? 'OUTLET-HQ',
          createdByUserId:
            body.createdByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
          items: body.items ?? [],
        });
        this.sendJson(res, 200, countRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/outlet') {
        await this.ensureSeededIfAppropriate();
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
        this.sendJson(res, 200, {
          transfers: this.ipc.listTransferOrdersHistory(40),
          outlets: this.ipc.listOutlets(),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/transfer-dispatch') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          sourceOutletId: string;
          destinationOutletId: string;
          dispatchedByUserId?: string;
          items: DispatchTransferOrderInput['items'];
        }>(req);
        const transferNumber = `TRF-${String(this.transferSequenceCounter++).padStart(4, '0')}`;
        const dispatchRes = await this.ipc.dispatchTransferOrder({
          transferNumber,
          sourceOutletId: body.sourceOutletId,
          destinationOutletId: body.destinationOutletId,
          dispatchedByUserId:
            body.dispatchedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
          items: body.items ?? [],
        });
        this.sendJson(res, 200, dispatchRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/transfer-receive') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<ReceiveTransferOrderInput>(req);
        const recvRes = await this.ipc.receiveTransferOrder({
          transferOrderId: body.transferOrderId,
          receivedByUserId:
            body.receivedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, recvRes);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/warehouse/ledger') {
        await this.ensureSeededIfAppropriate();
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
      // 8. Shift Management, Cash Drawer & USB Ring-Buffer Backup
      // ----------------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/api/shift/open') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          outletId?: string;
          openedByUserId?: string;
          openingCashSatang: number;
          notes?: string;
        }>(req);
        const shiftNo = `SHF-LIVE-${String(this.shiftSequenceCounter++).padStart(3, '0')}`;
        const shift = await this.ipc.openPosShift({
          outletId: body.outletId ?? 'OUTLET-HQ',
          terminalId: 'POS-TERM-01',
          shiftNumber: shiftNo,
          openedByUserId:
            body.openedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
          openingCashSatang: Math.max(0, Number(body.openingCashSatang ?? 100_000)),
          ...(body.notes ? { notes: body.notes } : {}),
        });
        this.sendJson(res, 200, { shift });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/cash-movement') {
        await this.ensureActiveShiftOpen();
        const body = await this.readJsonBody<{
          shiftId?: string;
          movementType: 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
          amountSatang: number;
          reason: string;
          performedByUserId?: string;
        }>(req);
        const activeShift = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01');
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
            body.performedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
        });
        this.sendJson(res, 200, {
          movement,
          activeShift: this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01'),
          drawerMovements: this.ipc.listCashDrawerMovements(shiftId),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/shift/movements') {
        await this.ensureSeededIfAppropriate();
        const shiftId = url.searchParams.get('shiftId') ?? '';
        this.sendJson(res, 200, {
          movements: shiftId ? this.ipc.listCashDrawerMovements(shiftId) : [],
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/simulate-yank-usb') {
        const corruptPartPath = path.join(
          this.usbBackupDir,
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
        await this.ensureActiveShiftOpen();
        const activeShift = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01')!;
        const body = await this.readJsonBody<{
          countedCashSatang?: number;
          cashVarianceOffsetSatang?: number;
          closedByUserId?: string;
          reopenNextShift?: boolean;
          notes?: string;
        }>(req);
        let countedCashSatang = activeShift.expectedCashSatang;
        if (typeof body.countedCashSatang === 'number') {
          countedCashSatang = body.countedCashSatang;
        } else if (typeof body.cashVarianceOffsetSatang === 'number') {
          countedCashSatang = Math.max(
            0,
            activeShift.expectedCashSatang + Number(body.cashVarianceOffsetSatang)
          );
        }
        const closeRes = await this.reportsController.closeShiftWithAutoUsbBackup({
          shiftId: activeShift.id,
          closedByUserId:
            body.closedByUserId ?? this.ipc.listStaffUsers()[0]?.id ?? 'USR-OWNER-01',
          countedCashSatang,
          usbBackupDir: this.usbBackupDir,
          notes: body.notes ?? 'Closed from POS Shift Drawer',
        });
        if (body.reopenNextShift !== false) {
          await this.ensureActiveShiftOpen();
        }
        this.sendJson(res, 200, {
          closedShift: closeRes.closedShift,
          zReport: this.formatZReportForUi(closeRes.zReport),
          usbBackup: closeRes.usbBackup,
          usbBackups: this.listUsbBackupFiles(),
        });
        return;
      }

      // ----------------------------------------------------------------------
      // 9. Financial Reports, Store Settings, Security Audit & Cluster Mode
      // ----------------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/api/reports') {
        await this.ensureActiveShiftOpen();
        const outletId = url.searchParams.get('outletId') ?? 'OUTLET-HQ';
        const requestedShiftId = url.searchParams.get('shiftId');
        const activeShift = this.ipc.getActiveShift(outletId, 'POS-TERM-01');
        const shiftsHistory = this.ipc.listShiftsHistory(outletId, 20);
        const targetShiftId = requestedShiftId || activeShift?.id || shiftsHistory[0]?.id;

        const zReport = targetShiftId
          ? this.formatZReportForUi(this.reportsController.getShiftZReportView(targetShiftId))
          : null;
        const abbReport = this.formatAbbReportForUi(
          this.reportsController.getAbbSalesTaxReportView(outletId)
        );
        const valuationReport = this.formatValuationReportForUi(
          this.reportsController.getInventoryValuationReportView(outletId)
        );
        const marginReport = this.formatMarginReportForUi(
          this.reportsController.getMenuCogsAndMarginReportView(outletId)
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
        const body = await this.readJsonBody<{
          profile: BusinessProfile;
          updatedByUserId?: string;
        }>(req);
        const switchRes = await this.securityController.switchBusinessProfile(
          body.profile,
          body.updatedByUserId ?? 'USR-OWNER-01'
        );
        this.sendJson(res, 200, switchRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/settings/store') {
        await this.ensureSeededIfAppropriate();
        const body = await this.readJsonBody<{
          outletId?: string;
          storeName: string;
          taxId: string;
          branchCode: string;
          rdPosRegNo: string;
          promptPayId: string;
          updatedByUserId?: string;
        }>(req);
        const storeSettings = await this.ipc.updateStoreIdentitySettings(body);
        this.sendJson(res, 200, { storeSettings });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/security/audit-logs') {
        await this.ensureSeededIfAppropriate();
        const limit = Number(url.searchParams.get('limit') ?? 60);
        this.sendJson(res, 200, {
          auditLogs: this.ipc.listSecurityAuditLogs(limit),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/cluster/open-pin') {
        await this.ensureSeededIfAppropriate();
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
        const body = await this.readJsonBody<{ ready: boolean }>(req);
        const stateRes = this.printerSpooler.setHardwareReadyState(Boolean(body.ready));
        const cfg = this.getPrinterConfig();
        if (stateRes.printerReady && stateRes.autoFlushedJobs.length > 0) {
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
        }
        this.sendJson(res, 200, {
          ready: stateRes.printerReady,
          autoFlushedCount: stateRes.autoFlushedJobs.length,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/ups-state') {
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

      this.sendJson(res, 404, { error: `Route not found: ${method} ${url.pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = message.includes('401')
        ? 401
        : message.includes('403')
          ? 403
          : message.includes('409') || message.includes('Duplicate')
            ? 409
            : message.includes('422') || message.includes('Circular')
              ? 422
              : message.includes('423') || message.includes('QUARANTINE')
                ? 423
                : 400;
      this.sendJson(res, statusCode, { error: message });
    }
  }

  public async start(
    port = 4173,
    host = '127.0.0.1'
  ): Promise<{ url: string; port: number }> {
    await this.ensureActiveShiftOpen();

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      srv.once('error', reject);
      srv.listen(port, host, () => {
        this.server = srv;
        const addr = srv.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({
          url: `http://${host}:${boundPort}`,
          port: boundPort,
        });
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    this.engine.close();
  }
}
