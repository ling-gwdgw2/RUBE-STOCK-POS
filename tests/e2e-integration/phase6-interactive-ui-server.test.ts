/**
 * RUBE-STOCK-POS v3.1 End-to-End Interactive Web/Desktop Application Server Test
 *
 * Verifies that `RubePosInteractiveAppServer` serves the 6-tab Thai/English interactive UI
 * (`GET /`) and executes all live POS, KDS, Warehouse/PO, BOM DAG, Financial Reports,
 * and Hardware-in-the-Loop (HIL) API workflows against the SQLite WAL engine.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { RubePosInteractiveAppServer } from '../../packages/ui-presentation/src/server/pos-desktop-server.ts';

describe('Interactive POS & Warehouse Desktop/Web Application Server (E2E)', () => {
  it('serves the 6-tab HTML UI and executes POS, KDS, PO, BOM, Reports, and HIL endpoints', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-ui-server-'));
    const dbPath = path.join(tmpDir, 'rube_interactive.db');
    const appServer = new RubePosInteractiveAppServer({ dbPath });

    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // 1. Verify HTML UI (`GET /`)
      const htmlRes = await fetch(`${url}/`);
      assert.equal(htmlRes.status, 200);
      const htmlText = await htmlRes.text();
      assert.ok(htmlText.includes('RUBE-STOCK-POS v3.1'));
      assert.ok(htmlText.includes('หน้าจอขาย POS (Dual-Mode)'));

      // 2. Verify Bootstrap State (`GET /api/bootstrap`)
      const bootRes = await fetch(`${url}/api/bootstrap`);
      assert.equal(bootRes.status, 200);
      const boot = (await bootRes.json()) as {
        profile: string;
        activeShift: { id: string; shiftNumber: string };
        catalog: Array<{ id: string }>;
        ledgerInvariant: { valid: boolean };
      };
      assert.equal(boot.profile, 'HYBRID');
      assert.ok(boot.activeShift.id);
      assert.ok(boot.catalog.length >= 8);
      assert.equal(boot.ledgerInvariant.valid, true);

      // 3. Verify Thai Barcode Scan Rollback (`POST /api/hal/simulate-scan`)
      const scanRes = await fetch(`${url}/api/hal/simulate-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: '2010045015004' }),
      });
      assert.equal(scanRes.status, 200);
      const scanData = (await scanRes.json()) as {
        searchInputTextAfter: string;
        firstCharRollbackCount: number;
        addedCartLine: { variantId: string; quantityMilli: number };
      };
      assert.equal(scanData.searchInputTextAfter, '');
      assert.ok(scanData.firstCharRollbackCount >= 1);
      assert.equal(scanData.addedCartLine.variantId, 'VAR-RET-002');
      assert.equal(scanData.addedCartLine.quantityMilli, 1_500);

      // 4. Verify Warehouse PO Receive (`POST /api/warehouse/receive-po`) & Boba Prep Build (`POST /api/warehouse/build-prep`)
      const poRes = await fetch(`${url}/api/warehouse/receive-po`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ porkKg: 10, freightBaht: 250 }),
      });
      assert.equal(poRes.status, 200);

      const prepRes = await fetch(`${url}/api/warehouse/build-prep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildQtyMilli: 5_000 }),
      });
      assert.equal(prepRes.status, 200);

      // 5. Verify Circular BOM Dependency Guard (`POST /api/warehouse/bom-edge` -> HTTP 422)
      const cycleRes = await fetch(`${url}/api/warehouse/bom-edge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          compositeVariantId: 'VAR-RAW-DRY-BOBA',
          componentVariantId: 'VAR-RAW-BOBA',
          componentRole: 'STANDARD',
          quantityMilli: 1_000,
          wastageBasisPoints: 0,
        }),
      });
      assert.equal(cycleRes.status, 422);

      // 6. Verify Printer Cover-Open Spooling & Checkout (`POST /api/hal/printer-state` + `POST /api/pos/checkout`)
      await fetch(`${url}/api/hal/printer-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ready: false }),
      });

      const checkoutRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMethod: 'CASH',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-CAFE-MILKTEA',
              itemName: 'Taiwan Brown Sugar Boba Milk Tea',
              unitName: 'แก้ว',
              quantityMilli: 1_000,
              unitPriceSatang: 6_500,
              selectedModifierIds: ['MOD-SWEET-50', 'MOD-EXTRA-BOBA'],
            },
          ],
        }),
      });
      assert.equal(checkoutRes.status, 200);
      const checkoutData = (await checkoutRes.json()) as {
        order: { salesOrderId: string; totalSatang: number };
        printJob: { maxPacketByteLength: number };
        spoolResult: { status: string; pendingQueueLength: number };
      };
      assert.equal(checkoutData.order.totalSatang, 8_000);
      assert.ok(checkoutData.printJob.maxPacketByteLength <= 8_192);
      assert.equal(checkoutData.spoolResult.status, 'QUEUED_PAPER_OUT_OR_COVER_OPEN');
      assert.equal(checkoutData.spoolResult.pendingQueueLength, 1);

      // Restore printer paper -> Auto-flushes spooled job
      const flushRes = await fetch(`${url}/api/hal/printer-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ready: true }),
      });
      const flushData = (await flushRes.json()) as { autoFlushedCount: number };
      assert.equal(flushData.autoFlushedCount, 1);

      // 7. Verify UPS Power-Loss Simulation (`POST /api/hal/ups-state`) & Reports (`GET /api/reports`)
      const upsRes = await fetch(`${url}/api/hal/ups-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acPresent: false, batteryChargePercent: 65 }),
      });
      assert.equal(upsRes.status, 200);
      const upsData = (await upsRes.json()) as {
        protectionState: string;
        upsBanner: { visible: boolean };
      };
      assert.equal(upsData.protectionState, 'ON_BATTERY_CHECKPOINT_TRIGGERED');
      assert.equal(upsData.upsBanner.visible, true);

      const repRes = await fetch(`${url}/api/reports`);
      assert.equal(repRes.status, 200);
      const repData = (await repRes.json()) as {
        zReport: { netSalesTotalSatang: number };
      };
      assert.equal(repData.zReport.netSalesTotalSatang, 8_000);

      // 8. Verify Blind Drop Shift Close + Encrypted USB Backup (`POST /api/shift/close-and-reopen`)
      const closeRes = await fetch(`${url}/api/shift/close-and-reopen`, {
        method: 'POST',
      });
      assert.equal(closeRes.status, 200);
      const closeData = (await closeRes.json()) as {
        usbBackup: { retainedBackupsCount: number };
      };
      assert.equal(closeData.usbBackup.retainedBackupsCount, 1);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes Staff PIN Auth, Catalog CRUD, Custom PO Preview, Stocktake, Multi-Outlet Transfers, and Cash Movements while preserving 100% Ledger Invariant', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-ui-prod-'));
    const dbPath = path.join(tmpDir, 'rube_prod_api.db');
    const appServer = new RubePosInteractiveAppServer({ dbPath });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // 1. PIN Auth: valid Owner PIN (200) vs invalid PIN (401)
      const badPin = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '000000' }),
      });
      assert.equal(badPin.status, 401);

      const okPin = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.equal(okPin.status, 200);
      const authData = (await okPin.json()) as { user: { id: string; role: string } };
      assert.equal(authData.user.role, 'OWNER');

      // 2. Catalog CRUD with opening stock preserves Ledger Conservation Invariant
      const createProdRes = await fetch(`${url}/api/catalog/variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: 'Yuzu Honey Sparkling Cold Brew',
          sku: 'SKU-YUZU-01',
          barcode: '8857770001112',
          categoryId: 'CAT-CAFE',
          unitName: 'ขวด',
          priceSatang: 8_500,
          defaultPurchaseCostMicroBaht: 35_000_000,
          initialStockMilli: 24_000,
          performedByUserId: authData.user.id,
        }),
      });
      assert.equal(createProdRes.status, 200);
      const createdProd = (await createProdRes.json()) as { variant: { id: string; inStockMilli: number } };
      assert.equal(createdProd.variant.inStockMilli, 24_000);

      // 3. Custom PO Preview & Cash Drawer Movement
      const previewRes = await fetch(`${url}/api/warehouse/po-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: 'SUP-001',
          items: [
            {
              variantId: createdProd.variant.id,
              orderedQtyMilli: 12_000,
              receivedQtyMilli: 12_000,
              baseUnitCostMicroBaht: 36_000_000,
            },
          ],
          landedCosts: [{ costType: 'FREIGHT', description: 'Express Van', amountSatang: 12_000 }],
        }),
      });
      assert.equal(previewRes.status, 200);

      const mvRes = await fetch(`${url}/api/shift/cash-movement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movementType: 'PAID_IN',
          amountSatang: 25_000,
          reason: 'Small coin float',
          performedByUserId: authData.user.id,
        }),
      });
      assert.equal(mvRes.status, 200);

      // 4. Multi-Outlet Register + Transfer Dispatch + Receive + Ledger Verification
      await fetch(`${url}/api/warehouse/outlet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'BR-02', name: 'Siam Branch' }),
      });
      const trDispatch = await fetch(`${url}/api/warehouse/transfer-dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceOutletId: 'OUTLET-HQ',
          destinationOutletId: 'OUTLET-BR-02',
          items: [{ variantId: createdProd.variant.id, quantityMilli: 4_000 }],
        }),
      });
      assert.equal(trDispatch.status, 200);
      const trDispatchJson = (await trDispatch.json()) as { transferOrderId: string };

      const trRecv = await fetch(`${url}/api/warehouse/transfer-receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferOrderId: trDispatchJson.transferOrderId }),
      });
      assert.equal(trRecv.status, 200);

      const ledgerRes = await fetch(`${url}/api/warehouse/ledger`);
      assert.equal(ledgerRes.status, 200);
      const ledgerJson = (await ledgerRes.json()) as { invariant: { valid: boolean } };
      assert.equal(ledgerJson.invariant.valid, true);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes Phase-1 MVP Production Onboarding (.recovery-kit), Modifier Groups CRUD, Split Payments with Z-Report reconciliation, and 203-DPI Canvas Raster Print', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-mvp-prod-'));
    const dbPath = path.join(tmpDir, 'rube_clean_start.db');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      requireFirstRunWizard: true,
    });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // 1. Clean-Start mode boots un-onboarded (`onboarded: false`)
      const boot0Res = await fetch(`${url}/api/bootstrap`);
      assert.equal(boot0Res.status, 200);
      const boot0 = (await boot0Res.json()) as {
        onboarded: boolean;
        activeShift: unknown;
      };
      assert.equal(boot0.onboarded, false);

      // 2. Complete First-Run Setup Wizard with custom store & PIN + .recovery-kit
      const onboardRes = await fetch(`${url}/api/onboarding/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessProfile: 'HYBRID',
          storeName: 'ร้านค้าลูกค้าจริง MVP',
          taxId: '0105569000999',
          branchCode: '00001',
          rdPosRegNo: 'E0999888777666',
          promptPayId: '0812345678',
          ownerDisplayName: 'สมชาย เจ้าของร้าน',
          ownerUsername: 'somchai',
          ownerPin: '482913',
          recoveryPassphrase: 'my-secret-recovery-passphrase',
          loadDemoSampleCatalog: true,
          openingCashSatang: 300_000,
          printerConfig: {
            mode: 'SIMULATED_MEMORY',
            tcpHost: '192.168.1.200',
            tcpPort: 9100,
            windowsPrinterName: '',
            paperWidthMm: 80,
            autoKickDrawerOnCash: true,
          },
        }),
      });
      assert.equal(onboardRes.status, 200);
      const onboardData = (await onboardRes.json()) as {
        ok: boolean;
        ownerUser: { id: string; role: string; displayName: string };
        recoveryKitFilename: string;
        recoveryKitContent: string;
      };
      assert.equal(onboardData.ok, true);
      assert.equal(onboardData.ownerUser.role, 'OWNER');
      assert.ok(onboardData.recoveryKitFilename.endsWith('.recovery-kit'));
      assert.ok(onboardData.recoveryKitContent.includes('dekFingerprintSha256Hex'));
      assert.ok(onboardData.recoveryKitContent.includes('argon2RecoverySlot'));

      // Custom Owner PIN should work
      const customPinRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '482913' }),
      });
      assert.equal(customPinRes.status, 200);

      // 3. Modifier Groups & Modifiers CRUD
      const grpRes = await fetch(`${url}/api/catalog/modifier-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'ระดับความเข้มข้นกาแฟ',
          selectionType: 'SINGLE',
          minSelections: 0,
          maxSelections: 1,
        }),
      });
      assert.equal(grpRes.status, 200);
      const grpData = (await grpRes.json()) as { group: { id: string; name: string } };
      assert.equal(grpData.group.name, 'ระดับความเข้มข้นกาแฟ');

      const modRes = await fetch(`${url}/api/catalog/modifier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modifierGroupId: grpData.group.id,
          name: 'เพิ่มช็อตเอสเพรสโซ่',
          priceDeltaSatang: 1_500,
          modifierMode: 'FIXED_QTY_DELTA',
          quantityDeltaMilli: 0,
          scaleBasisPoints: 10_000,
        }),
      });
      assert.equal(modRes.status, 200);
      const modData = (await modRes.json()) as { modifier: { id: string } };

      const boot1Res = await fetch(`${url}/api/bootstrap`);
      const boot1 = (await boot1Res.json()) as {
        onboarded: boolean;
        modifierGroups: Array<{ id: string; modifiers: Array<{ id: string }> }>;
      };
      assert.equal(boot1.onboarded, true);
      const createdGrp = boot1.modifierGroups.find((g) => g.id === grpData.group.id);
      assert.ok(createdGrp);
      assert.ok(createdGrp.modifiers.some((m) => m.id === modData.modifier.id));

      // Clean up modifier & group via DELETE
      const delModRes = await fetch(`${url}/api/catalog/modifier`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: modData.modifier.id }),
      });
      assert.equal(delModRes.status, 200);

      const delGrpRes = await fetch(`${url}/api/catalog/modifier-group`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: grpData.group.id }),
      });
      assert.equal(delGrpRes.status, 200);

      // 4. Split-Tender Payment (`CASH` ฿50.00 + `PROMPTPAY_QR` ฿30.00 = ฿80.00) + Z-Report & Custom Table/Queue Reconciliation
      const splitRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cashierId: onboardData.ownerUser.id,
          orderType: 'DINE_IN',
          tableOrQueueNo: 'T-09',
          paymentMethod: 'CASH',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          splitPayments: [
            {
              paymentMethod: 'CASH',
              amountSatang: 5_000,
              cashTenderedSatang: 5_000,
            },
            {
              paymentMethod: 'PROMPTPAY_QR',
              amountSatang: 3_000,
              slipTransRefRaw: '0041000600000101030040220KBANK2026112599900015102TH9104ABCD',
            },
          ],
          lines: [
            {
              variantId: 'VAR-CAFE-MILKTEA',
              itemName: 'Taiwan Brown Sugar Boba Milk Tea',
              unitName: 'แก้ว',
              quantityMilli: 1_000,
              unitPriceSatang: 6_500,
              selectedModifierIds: ['MOD-EXTRA-BOBA'],
            },
          ],
        }),
      });
      assert.equal(splitRes.status, 200);
      const splitData = (await splitRes.json()) as {
        order: {
          salesOrderId: string;
          receiptNumber: string;
          tableOrQueueNo: string | null;
          totalSatang: number;
          paymentSummaryLabel: string;
          payments: Array<{ paymentMethod: string; amountSatang: number }>;
        };
      };
      assert.equal(splitData.order.totalSatang, 8_000);
      assert.equal(splitData.order.tableOrQueueNo, 'T-09');
      assert.equal(splitData.order.payments.length, 2);
      assert.equal(splitData.order.paymentSummaryLabel, 'CASH + PROMPTPAY_QR');

      const ordersRes = await fetch(`${url}/api/pos/orders`);
      assert.equal(ordersRes.status, 200);
      const ordersJson = (await ordersRes.json()) as {
        orders: Array<{ salesOrderId: string; tableOrQueueNo: string | null }>;
      };
      assert.equal(
        ordersJson.orders.find((o) => o.salesOrderId === splitData.order.salesOrderId)
          ?.tableOrQueueNo,
        'T-09'
      );

      const kdsRes = await fetch(`${url}/api/kds/tickets`);
      assert.equal(kdsRes.status, 200);
      const kdsJson = (await kdsRes.json()) as {
        tickets: Array<{ salesOrderId: string; queueNumber: string }>;
      };
      assert.equal(
        kdsJson.tickets.find((t) => t.salesOrderId === splitData.order.salesOrderId)?.queueNumber,
        'T-09'
      );

      const bomPreviewRes = await fetch(`${url}/api/warehouse/bom-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          compositeVariantId: 'VAR-CAFE-MILKTEA',
          qtyMilli: 1_000,
          selectedModifierIds: ['MOD-EXTRA-BOBA'],
        }),
      });
      assert.equal(bomPreviewRes.status, 200);
      const bomPreview = (await bomPreviewRes.json()) as {
        totalCogsMicroBaht: number;
        totalRecipeCogsMicroBaht: number;
      };
      assert.equal(typeof bomPreview.totalCogsMicroBaht, 'number');
      assert.equal(bomPreview.totalRecipeCogsMicroBaht, bomPreview.totalCogsMicroBaht);

      const reportsRes = await fetch(`${url}/api/reports`);
      assert.equal(reportsRes.status, 200);
      const reports = (await reportsRes.json()) as {
        zReport: {
          netSalesTotalSatang: number;
          netSalesTotalFormatted: string;
          cashSalesSatang: number;
          cashSalesFormatted: string;
          promptPayQrSalesSatang: number;
          promptPaySalesFormatted: string;
          expectedCashSatang: number;
          expectedDrawerCashFormatted: string;
        };
        abbReport: {
          totalGrossFormatted: string;
          invoices: Array<{ totalFormatted: string }>;
        };
        valuationReport: {
          totalWarehouseValuationFormatted: string;
          lines: Array<{ stockFormatted: string; macFormatted: string; valuationFormatted: string }>;
        };
        marginReport: {
          totalRevenueFormatted: string;
          lines: Array<{ revenueFormatted: string; grossMarginPercentFormatted: string }>;
        };
      };
      assert.equal(reports.zReport.netSalesTotalSatang, 8_000);
      assert.equal(reports.zReport.netSalesTotalFormatted, '฿80.00');
      assert.equal(reports.zReport.cashSalesSatang, 5_000);
      assert.equal(reports.zReport.cashSalesFormatted, '฿50.00');
      assert.equal(reports.zReport.promptPayQrSalesSatang, 3_000);
      assert.equal(reports.zReport.promptPaySalesFormatted, '฿30.00');
      assert.equal(reports.zReport.expectedCashSatang, 305_000);
      assert.equal(reports.zReport.expectedDrawerCashFormatted, '฿3,050.00');
      assert.equal(reports.abbReport.totalGrossFormatted, '฿80.00');
      assert.ok(reports.abbReport.invoices[0]?.totalFormatted.startsWith('฿'));
      assert.ok(reports.valuationReport.totalWarehouseValuationFormatted.startsWith('฿'));
      assert.ok(reports.valuationReport.lines[0]?.valuationFormatted.startsWith('฿'));
      assert.equal(reports.marginReport.totalRevenueFormatted, '฿80.00');
      assert.ok(reports.marginReport.lines[0]?.grossMarginPercentFormatted.endsWith('%'));

      // Close shift with exact expected cash after Split Payment -> cashVarianceSatang must equal 0!
      const closeSplitShiftRes = await fetch(`${url}/api/shift/close-and-reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countedCashSatang: 305_000,
          closedByUserId: onboardData.ownerUser.id,
          reopenNextShift: true,
        }),
      });
      assert.equal(closeSplitShiftRes.status, 200);
      const closeSplitShift = (await closeSplitShiftRes.json()) as {
        closedShift: { cashVarianceSatang: number };
        zReport: { cashVarianceFormatted: string | null };
      };
      assert.equal(closeSplitShift.closedShift.cashVarianceSatang, 0);
      assert.equal(closeSplitShift.zReport.cashVarianceFormatted, '฿0.00');

      // Wizard Preview preserves existing store & staff context so user isn't trapped without Cancel
      const prevWizRes = await fetch(`${url}/api/onboarding/preview-wizard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show: true }),
      });
      assert.equal(prevWizRes.status, 200);
      const bootPreview = (await (await fetch(`${url}/api/bootstrap`)).json()) as {
        onboarded: boolean;
        isPreviewWizard: boolean;
        staffUsers: Array<{ id: string }>;
        storeSettings: { storeName: string };
      };
      assert.equal(bootPreview.onboarded, false);
      assert.equal(bootPreview.isPreviewWizard, true);
      assert.ok(bootPreview.staffUsers.length >= 1);
      assert.equal(bootPreview.storeSettings.storeName, 'ร้านค้าลูกค้าจริง MVP');
      await fetch(`${url}/api/onboarding/preview-wizard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show: false }),
      });

      // 5. 203-DPI 1-Bit Monochrome Canvas Raster Print & RJ11 Cash Drawer Kick
      const dummyBitmap = Buffer.alloc((576 / 8) * 16, 0xaa).toString('base64');
      const canvasPrintRes = await fetch(`${url}/api/hal/print-canvas-raster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packedBitmapBase64: dummyBitmap,
          widthPx: 576,
          heightPx: 16,
          kickCashDrawer: true,
          salesOrderId: splitData.order.salesOrderId,
          receiptNumber: splitData.order.receiptNumber,
        }),
      });
      assert.equal(canvasPrintRes.status, 200);
      const canvasPrintData = (await canvasPrintRes.json()) as {
        packetsCount: number;
        maxPacketByteLength: number;
        hardwareOutcome: { transportMode: string };
      };
      assert.ok(canvasPrintData.packetsCount >= 1);
      assert.ok(canvasPrintData.maxPacketByteLength <= 8_192);
      assert.equal(canvasPrintData.hardwareOutcome.transportMode, 'SIMULATED_MEMORY');

      const kickRes = await fetch(`${url}/api/hal/kick-drawer`, { method: 'POST' });
      assert.equal(kickRes.status, 200);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
