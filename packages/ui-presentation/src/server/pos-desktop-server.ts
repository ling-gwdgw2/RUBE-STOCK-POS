/**
 * RUBE-STOCK-POS v3.1 Interactive Full-Stack POS & Warehouse Desktop/Web Application Server
 *
 * Serves the interactive Thai/English POS Terminal, KDS, Warehouse/PO, Multi-Level BOM DAG,
 * Financial Reports, and Hardware-in-the-Loop (HIL) Simulation Bench UI (`index.html`),
 * wired directly to `SqliteReadWritePoolEngine`, `LocalIpcBridge`, and HAL Drivers.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../../core-engine/src/runtime/sqlite-engine.ts';
import { LocalIpcBridge } from '../../../cluster-gateway/src/local-ipc-bridge.ts';
import {
  buildTwoPhaseSlipConfirmationModal,
  commitVerifiedBotSlipHash,
  generateOfflinePromptPayDynamicQr,
} from '../../../hal-drivers/src/payment/mod.ts';
import {
  renderThaiReceiptAbbEscPosJob,
  ThermalPrinterSpoolerQueue,
} from '../../../hal-drivers/src/printer/mod.ts';
import { UpsPowerHidMonitor } from '../../../hal-drivers/src/ups/mod.ts';
import {
  computeVatSatang,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  roundDivBigInt,
  SCALE_MILLI,
  type TaxMode,
} from '../../../shared-contracts/src/fixed-point.ts';
import type {
  BomEdgeDto,
  BusinessProfile,
  CheckoutLineItemInput,
} from '../../../shared-contracts/src/ipc-commands.ts';
import { PosTerminalViewController } from '../views/pos-terminal/PosTerminalView.ts';
import { FinancialAndBackupReportViewController } from '../views/reports/FinancialAndBackupReportView.ts';
import { SystemSecurityAndProfileViewController } from '../views/settings/SystemSecurityAndProfileView.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RubePosInteractiveServerOptions {
  dbPath: string;
  usbBackupDir?: string;
}

export class RubePosInteractiveAppServer {
  public readonly engine: SqliteReadWritePoolEngine;
  public readonly ipc: LocalIpcBridge;
  public readonly posController: PosTerminalViewController;
  public readonly reportsController: FinancialAndBackupReportViewController;
  public readonly securityController: SystemSecurityAndProfileViewController;
  public readonly printerSpooler: ThermalPrinterSpoolerQueue;
  public readonly upsMonitor: UpsPowerHidMonitor;

  private readonly usbBackupDir: string;
  private readonly usedSlipHashes = new Set<string>();
  private shiftSequenceCounter = 1;
  private poSequenceCounter = 1;
  private checkoutSequenceCounter = 1;
  private seeded = false;
  private server: http.Server | null = null;

  constructor(options: RubePosInteractiveServerOptions) {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.usbBackupDir =
      options.usbBackupDir ?? path.join(path.dirname(options.dbPath), 'usb-backups');
    fs.mkdirSync(this.usbBackupDir, { recursive: true });

    this.engine = new SqliteReadWritePoolEngine(
      options.dbPath,
      DEV_SQLCIPHER_RAW_HEX_KEY_64,
      4
    );
    this.ipc = new LocalIpcBridge(this.engine);
    this.posController = new PosTerminalViewController(this.ipc, 'OUTLET-HQ', 'POS-TERM-01');
    this.reportsController = new FinancialAndBackupReportViewController(this.ipc);
    this.securityController = new SystemSecurityAndProfileViewController(this.ipc);
    this.printerSpooler = new ThermalPrinterSpoolerQueue();
    this.upsMonitor = new UpsPowerHidMonitor({
      onTriggerEmergencyWalCheckpoint: async () => {
        await this.ipc.triggerEmergencyUpsWalCheckpoint('POS-TERM-01');
      },
    });
  }

  private async ensureActiveShiftOpen(): Promise<void> {
    if (!this.seeded) {
      await this.engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      this.seeded = true;
    }
    const active = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01');
    if (!active) {
      const shiftNo = `SHF-LIVE-${String(this.shiftSequenceCounter).padStart(3, '0')}`;
      await this.ipc.openPosShift({
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        shiftNumber: shiftNo,
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 100_000, // 1,000.00 THB
      });
    }
  }

  private computeCartTotals(
    lines: Array<{
      variantId: string;
      itemName?: string;
      unitName?: string;
      quantityMilli: number;
      unitPriceSatang: number;
      selectedModifierIds?: string[];
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
      return {
        itemName: line.itemName ?? line.variantId,
        quantityFormatted: formatMilliUnitsToQtyString(
          line.quantityMilli,
          line.unitName ?? 'ชิ้น'
        ),
        lineTotalFormatted: `฿${formatSatangToThbString(lineTotalSatang)}`,
        modifiersText: mods.map((m) => m.name).join(', ') || undefined,
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

  private async readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload, (_key, val) =>
      typeof val === 'bigint' ? val.toString() : val
    );
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';

      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const htmlPath = path.resolve(__dirname, '../web/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/bootstrap') {
        await this.ensureActiveShiftOpen();
        const { profile, featureFlags } = this.securityController.getActiveProfileWithFeatureFlags();
        const activeShift = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01');
        const catalog = this.ipc.getInventoryCatalog('OUTLET-HQ');
        const bomEdges = this.ipc.listBomEdges();
        const modifiers = this.ipc.listModifiers();
        const kdsTickets = this.ipc
          .getMissedKitchenOrders('OUTLET-HQ', 'BAR', 0)
          .filter((t) => t.status !== 'SERVED');
        const ledgerInvariant = this.ipc.verifyLedgerConservationInvariant('OUTLET-HQ');
        const upsBanner = this.upsMonitor.getActiveUiAlertBanner();

        this.sendJson(res, 200, {
          profile,
          featureFlags,
          activeShift,
          catalog,
          bomEdges,
          modifiers,
          kdsTickets,
          ledgerInvariant,
          upsBanner,
          printer: {
            ready: this.printerSpooler.isPrinterReady(),
            pendingQueueLength: this.printerSpooler.getPendingQueueLength(),
          },
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/simulate-scan') {
        const body = await this.readJsonBody<{ barcode: string }>(req);
        const barcode = String(body.barcode ?? '8851952350161');

        this.posController.clearCart();
        this.posController.searchInputText = '';
        let t = 5_000;
        for (let i = 0; i < barcode.length; i++) {
          const digit = barcode[i]!;
          const leakedThaiChar = i === 0 ? 'ค' : digit;
          this.posController.handleKeyDownWithFocusedSearchInput(`Digit${digit}`, leakedThaiChar, t);
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
        const body = await this.readJsonBody<{
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
        const qr = generateOfflinePromptPayDynamicQr('0105566001234', totals.totalSatang);
        this.sendJson(res, 200, {
          ...qr,
          totalSatang: totals.totalSatang,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/verify-slip-step1') {
        const body = await this.readJsonBody<{
          miniQrRaw: string;
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
        const modal = buildTwoPhaseSlipConfirmationModal(
          String(body.miniQrRaw ?? ''),
          totals.totalSatang,
          this.usedSlipHashes
        );
        this.sendJson(res, 200, modal);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/checkout') {
        await this.ensureActiveShiftOpen();
        const activeShift = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01')!;
        const body = await this.readJsonBody<{
          paymentMethod: 'CASH' | 'PROMPTPAY_QR';
          slipTransRefRaw?: string;
          taxMode?: TaxMode;
          discountSatang?: number;
          lines: Array<{
            variantId: string;
            itemName?: string;
            unitName?: string;
            quantityMilli: number;
            unitPriceSatang: number;
            selectedModifierIds?: string[];
          }>;
        }>(req);

        const taxMode: TaxMode = body.taxMode ?? 'INCLUSIVE';
        const discountSatang = Number(body.discountSatang ?? 0);
        const totals = this.computeCartTotals(body.lines ?? [], discountSatang, taxMode);
        const checkoutLines: CheckoutLineItemInput[] = (body.lines ?? []).map((l) => ({
          variantId: l.variantId,
          quantityMilli: Number(l.quantityMilli),
          unitPriceSatang: Number(l.unitPriceSatang),
          selectedModifierIds: l.selectedModifierIds ?? [],
        }));

        const idempotencyKey = `IDEM-UI-${Date.now()}-${this.checkoutSequenceCounter++}`;
        const order = await this.ipc.checkoutSalesOrder({
          idempotencyKey,
          outletId: 'OUTLET-HQ',
          terminalId: 'POS-TERM-01',
          shiftId: activeShift.id,
          cashierId: 'USR-CASHIER-01',
          orderType: 'TAKEAWAY',
          taxMode,
          discountSatang,
          paymentMethod: body.paymentMethod,
          cashTenderedSatang: body.paymentMethod === 'CASH' ? totals.totalSatang : undefined,
          slipTransRefRaw: body.slipTransRefRaw,
          lines: checkoutLines,
        });

        if (order.slipTransRefHash) {
          commitVerifiedBotSlipHash(order.slipTransRefHash, this.usedSlipHashes);
        }

        const renderedJob = renderThaiReceiptAbbEscPosJob({
          storeName: 'RUBE Flagship Store & Warehouse',
          taxId: '0105566001234',
          branchCode: '00000',
          posRegNo: 'RD-POS-2026-001',
          receiptNumber: order.receiptNumber,
          abbTaxInvoiceNo: order.abbTaxInvoiceNo,
          lines: totals.formattedLines,
          subtotalFormatted: `฿${formatSatangToThbString(order.subtotalSatang)}`,
          discountFormatted: `฿${formatSatangToThbString(order.discountSatang)}`,
          netBeforeTaxFormatted: `฿${formatSatangToThbString(order.netBeforeTaxSatang)}`,
          taxFormatted: `฿${formatSatangToThbString(order.taxSatang)}`,
          totalFormatted: `฿${formatSatangToThbString(order.totalSatang)}`,
          paymentMethod: order.paymentMethod,
          cashTenderedFormatted:
            order.cashTenderedSatang !== null
              ? `฿${formatSatangToThbString(order.cashTenderedSatang)}`
              : undefined,
          changeGivenFormatted:
            order.changeGivenSatang !== null
              ? `฿${formatSatangToThbString(order.changeGivenSatang)}`
              : undefined,
          slipRefLast4: order.slipTransRefLast4 ?? undefined,
          kickCashDrawer: order.paymentMethod === 'CASH',
          widthPx: 576,
        });

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
          },
          spoolResult,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/pos/void') {
        const body = await this.readJsonBody<{ salesOrderId: string }>(req);
        const voidRes = await this.ipc.voidSalesOrder({
          salesOrderId: String(body.salesOrderId),
          voidedByUserId: 'USR-OWNER-01',
          voidReason: 'Voided from Interactive POS UI',
        });
        this.sendJson(res, 200, voidRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/kds/bump') {
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

      if (method === 'POST' && url.pathname === '/api/warehouse/receive-po') {
        const body = await this.readJsonBody<{ porkKg?: number; freightBaht?: number }>(req);
        const porkQtyMilli = Math.max(1, Math.round(Number(body.porkKg ?? 10) * 1_000));
        const freightSatang = Math.max(0, Math.round(Number(body.freightBaht ?? 250) * 100));
        const poNumber = `PO-LIVE-${String(this.poSequenceCounter++).padStart(4, '0')}`;

        const poRes = await this.ipc.receivePurchaseOrderWithLandedCosts({
          poNumber,
          outletId: 'OUTLET-HQ',
          supplierId: 'SUP-001',
          createdByUserId: 'USR-WH-01',
          items: [
            {
              variantId: 'VAR-RET-002',
              orderedQtyMilli: porkQtyMilli,
              receivedQtyMilli: porkQtyMilli,
              baseUnitCostMicroBaht: 125_000_000, // 125.00 THB/kg
            },
            {
              variantId: 'VAR-RAW-TEA',
              orderedQtyMilli: 5_000,
              receivedQtyMilli: 5_000,
              baseUnitCostMicroBaht: 300_000, // 0.30 THB/g
            },
          ],
          landedCosts: [
            {
              costType: 'FREIGHT',
              description: 'Freight & Cold-Chain Delivery',
              amountSatang: freightSatang,
            },
          ],
        });
        this.sendJson(res, 200, poRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/build-prep') {
        const body = await this.readJsonBody<{ buildQtyMilli?: number }>(req);
        const buildRes = await this.ipc.executeProductionBuildBatch({
          outletId: 'OUTLET-HQ',
          compositeVariantId: 'VAR-RAW-BOBA',
          buildQtyMilli: Number(body.buildQtyMilli ?? 5_000),
          performedByUserId: 'USR-WH-01',
        });
        this.sendJson(res, 200, {
          ...buildRes,
          CompositeStockAfterMilli: buildRes.newCompositeStockMilli,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/warehouse/bom-edge') {
        const body = await this.readJsonBody<BomEdgeDto>(req);
        await this.ipc.upsertBomComponentEdge(body);
        this.sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/reports') {
        await this.ensureActiveShiftOpen();
        const activeShift = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01')!;
        const zReport = this.reportsController.getShiftZReportView(activeShift.id);
        const abbReport = this.reportsController.getAbbSalesTaxReportView('OUTLET-HQ');
        const valuationReport = this.reportsController.getInventoryValuationReportView('OUTLET-HQ');
        const marginReport = this.reportsController.getMenuCogsAndMarginReportView('OUTLET-HQ');
        this.sendJson(res, 200, {
          zReport,
          abbReport,
          valuationReport,
          marginReport,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/shift/close-and-reopen') {
        await this.ensureActiveShiftOpen();
        const activeShift = this.ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01')!;
        const closeRes = await this.reportsController.closeShiftWithAutoUsbBackup({
          shiftId: activeShift.id,
          closedByUserId: 'USR-CASHIER-01',
          countedCashSatang: activeShift.expectedCashSatang,
          usbBackupDir: this.usbBackupDir,
          notes: 'Closed from Interactive POS UI',
        });
        this.shiftSequenceCounter++;
        await this.ensureActiveShiftOpen();
        this.sendJson(res, 200, closeRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/profile/switch') {
        const body = await this.readJsonBody<{ profile: BusinessProfile }>(req);
        const switchRes = await this.securityController.switchBusinessProfile(
          body.profile,
          'USR-OWNER-01'
        );
        this.sendJson(res, 200, switchRes);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/hal/printer-state') {
        const body = await this.readJsonBody<{ ready: boolean }>(req);
        const stateRes = this.printerSpooler.setHardwareReadyState(Boolean(body.ready));
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
      const statusCode = message.includes('422') || message.includes('Circular') ? 422 : 400;
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
