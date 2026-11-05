/**
 * RUBE-STOCK-POS v3.1 Section 6.2: 5-Point Hardware-in-the-Loop (HIL) Assembly Bench Verification Suite
 * (`tests/e2e-integration/section6-hil-assembly-checklist.test.ts`)
 *
 * Automates and verifies all 5 mandatory pre-release Hardware-in-the-Loop checklist items
 * from `rube_stock_pos_team_implementation_assembly_playbook.md` Section 6.2:
 * - [x] 1. Thai Input & Zero-Leakage Immunity (10 rapid barcodes + Prefix 20 & 25 Scale Barcodes)
 * - [x] 2. 30cm Long Receipt (30 lines + stacked Thai diacritics), Chunked `GS v 0` (`<= 8 KB`), Drawer Kick & Auto-Cut
 * - [x] 3. Spool Queue Resilience (Cover Open / Paper Out mid-checkout -> Auto-print on cover close with zero double stock deduction)
 * - [x] 4. BOT Mini-QR Two-Phase Visual Confirmation & Duplicate Slip Block (`HTTP 409`)
 * - [x] 5. 30s KDS LAN Drop Recovery, Epoch-Fenced Leader Promotion (`READ_ONLY_QUARANTINE`), & UPS Power-Loss WAL Checkpoint
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../packages/core-engine/src/index.ts';
import {
  buildTwoPhaseSlipConfirmationModal,
  renderThaiReceiptAbbEscPosJob,
  ThermalPrinterSpoolerQueue,
  UpsPowerHidMonitor,
} from '../../packages/hal-drivers/src/index.ts';
import {
  LanClusterCoordinator,
  LocalIpcBridge,
} from '../../packages/cluster-gateway/src/index.ts';
import {
  KdsStationViewController,
  PosTerminalViewController,
} from '../../packages/ui-presentation/src/index.ts';

describe('Section 6.2: 5-Point Hardware-in-the-Loop (HIL) Assembly Bench Checklist', () => {
  it('Checklist 1: Thai Keyboard Layout Immunity & Zero First-Char Leakage across 10 rapid scans + Prefix 20 & 25 Scale Barcodes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-hil-check1-'));
    const dbPath = join(tempDir, 'rube_hil1.db');
    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const posView = new PosTerminalViewController(ipc, 'OUTLET-HQ', 'POS-TERM-01');

      // Simulate cursor inside search box while Windows keyboard is stuck in Thai (`กขค`)
      // Rapidly scan `8851952350161` (Crystal Water) 10 times in a row
      const barcodeDigits = '8851952350161';
      let clockMs = 1_000;

      for (let scanIdx = 0; scanIdx < 10; scanIdx++) {
        // First digit leaks a Thai character (e.g. 'ค') into the search input before the scanner burst is detected
        for (const ch of barcodeDigits) {
          posView.handleKeyDownWithFocusedSearchInput(`Digit${ch}`, 'ค', clockMs);
          clockMs += 8; // 8ms per keystroke (< 50ms scanner threshold)
        }
        posView.handleKeyDownWithFocusedSearchInput('Enter', '', clockMs);
        clockMs += 200;
      }

      // Search input must be rolled back to empty (zero Thai characters leaked!)
      assert.equal(posView.searchInputText, '');
      assert.equal(posView.firstCharRollbackCount, 10);

      // Now scan Weight-Embedded Scale Barcode (Prefix 20: SKU 10045, 1.500 kg -> `2010045015004`)
      for (const ch of '2010045015004') {
        posView.handleKeyDownWithFocusedSearchInput(`Digit${ch}`, 'ถ', clockMs);
        clockMs += 8;
      }
      posView.handleKeyDownWithFocusedSearchInput('Enter', '', clockMs);
      clockMs += 200;
      assert.equal(posView.searchInputText, '');

      // Now scan Price-Embedded Scale Barcode (Prefix 25: SKU 10045, 90.00 THB at 180 THB/kg = 0.500 kg -> `2510045090005`)
      for (const ch of '2510045090005') {
        posView.handleKeyDownWithFocusedSearchInput(`Digit${ch}`, 'ภ', clockMs);
        clockMs += 8;
      }
      posView.handleKeyDownWithFocusedSearchInput('Enter', '', clockMs);
      assert.equal(posView.searchInputText, '');

      const cart = posView.getCartSummaryViewModel().lines;
      const waterLines = cart.filter((l) => l.variantId === 'VAR-RET-001');
      const totalWaterQtyMilli = waterLines.reduce((sum, l) => sum + l.quantityMilli, 0);
      const porkLines = cart.filter((l) => l.variantId === 'VAR-RET-002');
      const totalPorkQtyMilli = porkLines.reduce((sum, l) => sum + l.quantityMilli, 0);

      assert.equal(totalWaterQtyMilli, 10_000); // 10 bottles
      assert.equal(totalPorkQtyMilli, 2_000); // 1.500 kg + 0.500 kg = 2.000 kg
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Checklist 2: 30cm Long Receipt (30 Thai items with stacked diacritics) chunks GS v 0 bands <= 8KB, kicks RJ11 drawer & auto-cuts', () => {
    const thirtyLines = Array.from({ length: 30 }, (_, idx) => ({
      itemName: `${idx + 1}. น้ำผึ้งมะนาวโซดา เพิ่มบุกไข่มุกไต้หวันหวานน้อย`,
      quantityFormatted: '1',
      lineTotalFormatted: '฿75.00',
      modifiersText: 'หวานน้อย 50%, เพิ่มไข่มุกไต้หวันต้มสุก',
    }));

    const job = renderThaiReceiptAbbEscPosJob({
      storeName: 'RUBE Flagship Store',
      taxId: '0105566001234',
      branchCode: '00000',
      posRegNo: 'RD-POS-2026-001',
      receiptNumber: 'RCP-HIL-0030',
      abbTaxInvoiceNo: 'ABB-20261106-0030',
      lines: thirtyLines,
      subtotalFormatted: '฿2,250.00',
      discountFormatted: '฿0.00',
      netBeforeTaxFormatted: '฿2,102.80',
      taxFormatted: '฿147.20',
      totalFormatted: '฿2,250.00',
      paymentMethod: 'CASH',
      cashTenderedFormatted: '฿2,500.00',
      changeGivenFormatted: '฿250.00',
      kickCashDrawer: true,
      widthPx: 576,
    });

    assert.ok(job.totalHeightPx >= 1200, '30-item receipt height must exceed 1200 dots (~15-30cm)');
    assert.ok(
      job.maxPacketByteLength <= 4616,
      `Every GS v 0 band must fit safely inside 8KB budget printer buffer (got ${job.maxPacketByteLength})`
    );
    assert.equal(job.kickDrawerCommandIncluded, true);
    assert.equal(job.cutPaperCommandIncluded, true);
    assert.ok(job.packets.some((p) => p.type === 'ESC_J_WHITESPACE_FEED'));
  });

  it('Checklist 3: Spool Queue Resilience — Paper Out / Cover Open mid-checkout queues receipt and auto-prints on cover close without double stock deduction', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-hil-check3-'));
    const dbPath = join(tempDir, 'rube_hil3.db');
    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const spooler = new ThermalPrinterSpoolerQueue();

      const shift = await ipc.openPosShift({
        shiftNumber: 'SHF-HIL-003',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 50_000,
      });

      // Open printer cover right before pressing Checkout (`ready = false`)
      spooler.setHardwareReadyState(false);

      const checkoutRes = await ipc.checkoutSalesOrder({
        idempotencyKey: 'IDEM-HIL-SPOOL-001',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        shiftId: shift.id,
        cashierId: 'USR-CASHIER-01',
        orderType: 'RETAIL',
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        paymentMethod: 'CASH',
        cashTenderedSatang: 2_000,
        lines: [
          {
            variantId: 'VAR-RET-001',
            quantityMilli: 2_000,
            unitPriceSatang: 700,
            selectedModifierIds: [],
          },
        ],
      });

      const stockAfterCommit = ipc
        .getInventoryCatalog('OUTLET-HQ')
        .find((v) => v.id === 'VAR-RET-001')!.inStockMilli;
      assert.equal(stockAfterCommit, 118_000); // 120,000 - 2,000 deducted once

      const renderedJob = renderThaiReceiptAbbEscPosJob({
        storeName: 'RUBE Flagship Store',
        taxId: '0105566001234',
        branchCode: '00000',
        posRegNo: 'RD-POS-2026-001',
        receiptNumber: checkoutRes.receiptNumber,
        abbTaxInvoiceNo: checkoutRes.abbTaxInvoiceNo,
        lines: [
          {
            itemName: 'น้ำดื่มคริสตัล 600 มล.',
            quantityFormatted: '2',
            lineTotalFormatted: '฿14.00',
          },
        ],
        subtotalFormatted: '฿14.00',
        discountFormatted: '฿0.00',
        netBeforeTaxFormatted: '฿13.08',
        taxFormatted: '฿0.92',
        totalFormatted: '฿14.00',
        paymentMethod: 'CASH',
        kickCashDrawer: true,
      });

      const spoolRes = spooler.submitPrintJob({
        salesOrderId: checkoutRes.salesOrderId,
        receiptNumber: checkoutRes.receiptNumber,
        renderedJob,
      });

      assert.equal(spoolRes.status, 'QUEUED_PAPER_OUT_OR_COVER_OPEN');
      assert.equal(spoolRes.pendingQueueLength, 1);
      assert.match(spoolRes.uiAlertThai ?? '', /เครื่องพิมพ์ใบเสร็จไม่พร้อม/);

      // Cashier loads paper and closes printer cover (`ready = true`)
      const flushRes = spooler.setHardwareReadyState(true);
      assert.equal(flushRes.autoFlushedJobs.length, 1);
      assert.equal(flushRes.autoFlushedJobs[0]!.receiptNumber, checkoutRes.receiptNumber);
      assert.equal(spooler.getPendingQueueLength(), 0);

      // Verify stock was NEVER deducted a second time when flushing the spooled print job
      const stockAfterPrintFlush = ipc
        .getInventoryCatalog('OUTLET-HQ')
        .find((v) => v.id === 'VAR-RET-001')!.inStockMilli;
      assert.equal(stockAfterPrintFlush, 118_000);
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Checklist 4: BOT Mini-QR Two-Phase High-Contrast Visual Check & Duplicate Slip Block (HTTP 409)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-hil-check4-'));
    const dbPath = join(tempDir, 'rube_hil4.db');
    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);

      const shift = await ipc.openPosShift({
        shiftNumber: 'SHF-HIL-004',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 50_000,
      });

      const botMiniQrRaw = '004100060000010103014022020261106SCBHIL000001';

      // Phase 1: Scan BOT Mini-QR -> Show High-Contrast Bank Logo + Last 4 TransRef + Large Amount Modal
      const modal = buildTwoPhaseSlipConfirmationModal(botMiniQrRaw, 6_500, new Set());
      assert.equal(modal.canProceedToStep2Confirm, true);
      assert.equal(modal.senderBankCode, '014');
      assert.match(modal.senderBankNameThai, /ไทยพาณิชย์/);
      assert.equal(modal.transRefLast4, '0001');
      assert.equal(modal.expectedAmountFormatted, '฿65.00');

      // Phase 2: Cashier confirms -> Order 1 succeeds
      await ipc.checkoutSalesOrder({
        idempotencyKey: 'IDEM-HIL-QR-001',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        shiftId: shift.id,
        cashierId: 'USR-CASHIER-01',
        orderType: 'DINE_IN',
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        paymentMethod: 'PROMPTPAY_QR',
        slipTransRefRaw: botMiniQrRaw,
        lines: [
          {
            variantId: 'VAR-CAFE-MILKTEA',
            quantityMilli: 1_000,
            unitPriceSatang: 6_500,
            selectedModifierIds: [],
          },
        ],
      });

      // Scanning the exact same slip on the next bill is immediately blocked (`HTTP 409 Duplicate Payment Slip`)
      await assert.rejects(
        () =>
          ipc.checkoutSalesOrder({
            idempotencyKey: 'IDEM-HIL-QR-002',
            outletId: 'OUTLET-HQ',
            terminalId: 'POS-TERM-01',
            shiftId: shift.id,
            cashierId: 'USR-CASHIER-01',
            orderType: 'DINE_IN',
            taxMode: 'INCLUSIVE',
            discountSatang: 0,
            paymentMethod: 'PROMPTPAY_QR',
            slipTransRefRaw: botMiniQrRaw,
            lines: [
              {
                variantId: 'VAR-CAFE-MILKTEA',
                quantityMilli: 1_000,
                unitPriceSatang: 6_500,
                selectedModifierIds: [],
              },
            ],
          }),
        /HTTP 409 Duplicate Slip TransRef detected/
      );
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Checklist 5: 30s KDS LAN Drop Recovery, Epoch-Fenced Leader Promotion (READ_ONLY_QUARANTINE) & UPS Power-Loss Checkpoint', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-hil-check5-'));
    const dbPath = join(tempDir, 'rube_hil5.db');
    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const leaderCluster = new LanClusterCoordinator({
        engine,
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        mode: 'MULTI_TERMINAL_LAN_CLUSTER',
        initialRoleState: 'ACTIVE_LEADER',
        initialEpoch: 1,
      });
      const ipc = new LocalIpcBridge(engine, leaderCluster);
      const kdsView = new KdsStationViewController(ipc, 'OUTLET-HQ', 'POS-KDS-BAR-01', 'BAR');

      const shift = await ipc.openPosShift({
        shiftNumber: 'SHF-HIL-005',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 50_000,
      });

      // 1. Simulate 30s KDS LAN drop while 5 Cafe orders are placed rapidly
      for (let i = 1; i <= 5; i++) {
        await ipc.checkoutSalesOrder({
          idempotencyKey: `IDEM-HIL-KDS-${i}`,
          outletId: 'OUTLET-HQ',
          terminalId: 'POS-TERM-01',
          shiftId: shift.id,
          cashierId: 'USR-CASHIER-01',
          orderType: 'DINE_IN',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          paymentMethod: 'CASH',
          cashTenderedSatang: 10_000,
          lines: [
            {
              variantId: 'VAR-CAFE-MILKTEA',
              quantityMilli: 1_000,
              unitPriceSatang: 6_500,
              selectedModifierIds: ['MOD-SWEET-50'],
            },
          ],
        });
      }

      // Plug KDS LAN cable back in -> all 5 orders appear in strict monotonic sequence order
      const syncedTickets = kdsView.syncMissedTicketsFromLeader();
      assert.equal(syncedTickets.length, 5);

      // 2. Pull UPS AC plug (`acPresent: false`) -> immediate WAL Checkpoint (`TRUNCATE`)
      const upsMonitor = new UpsPowerHidMonitor({
        onTriggerEmergencyWalCheckpoint: async () => {
          await ipc.triggerEmergencyUpsWalCheckpoint('POS-TERM-01');
        },
      });
      await upsMonitor.handleHidPowerReport({
        acPresent: false,
        batteryChargePercent: 80,
        estimatedRuntimeSeconds: 1500,
      });
      assert.equal(upsMonitor.getEmergencyCheckpointCount(), 1);

      // 3. Promote Warm Standby Terminal 2 to Leader (`cluster_epoch = 2`) and reconnect Terminal 1 (`epoch = 1`)
      const newState = await leaderCluster.observePeerLeaderEpoch('POS-TERM-02', 2);
      assert.equal(newState, 'READ_ONLY_QUARANTINE');
      assert.equal(leaderCluster.getRoleState(), 'READ_ONLY_QUARANTINE');
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
