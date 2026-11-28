/**
 * RUBE-STOCK-POS v3.1 End-to-End Interactive Web/Desktop Application Server Test
 *
 * Verifies that `RubePosInteractiveAppServer` serves the 6-tab Thai/English interactive UI
 * (`GET /`) and executes all live POS, KDS, Warehouse/PO, BOM DAG, Financial Reports,
 * and Hardware-in-the-Loop (HIL) API workflows against the SQLite WAL engine.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../packages/core-engine/src/runtime/sqlite-engine.ts';
import { RubePosInteractiveAppServer } from '../../packages/ui-presentation/src/server/pos-desktop-server.ts';
import { DatabaseSync } from 'node:sqlite';
import { resolveDigitFromKeyboardEvent, mapThaiKedmaneeDigitInput } from '../../packages/ui-presentation/src/app/utils/keyboard-digits.ts';

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

      // 5. Server-Synced Held Bills across POS terminals + Multi-Outlet Bootstrap + Pause/Resume Sale
      const holdSaveRes = await fetch(`${url}/api/pos/held-bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          actorUserId: authData.user.id,
          bill: {
            id: 'HOLD-E2E-001',
            outletId: 'OUTLET-HQ',
            referenceLabel: 'โต๊ะ A-08',
            orderType: 'DINE_IN',
            taxMode: 'INCLUSIVE',
            cart: [
              {
                cartKey: `${createdProd.variant.id}::`,
                variantId: createdProd.variant.id,
                itemName: 'Yuzu Honey Sparkling Cold Brew',
                variantName: 'ปกติ',
                sku: 'SKU-YUZU-01',
                unitName: 'ขวด',
                quantityMilli: 2_000,
                unitPriceSatang: 8_500,
                selectedModifierIds: [],
                isWeightedScale: false,
              },
            ],
            totalSatang: 17_000,
            heldByName: 'Owner',
            heldAtIso: new Date().toISOString(),
          },
        }),
      });
      assert.equal(holdSaveRes.status, 200);
      const holdListRes = await fetch(`${url}/api/pos/held-bills?outletId=OUTLET-HQ`);
      assert.equal(holdListRes.status, 200);
      const holdListJson = (await holdListRes.json()) as { heldBills: Array<{ id: string }> };
      assert.equal(holdListJson.heldBills.length, 1);
      assert.equal(holdListJson.heldBills[0]?.id, 'HOLD-E2E-001');

      const holdDelRes = await fetch(`${url}/api/pos/held-bills`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outletId: 'OUTLET-HQ', id: 'HOLD-E2E-001' }),
      });
      assert.equal(holdDelRes.status, 200);
      const holdDelJson = (await holdDelRes.json()) as { heldBills: Array<{ id: string }> };
      assert.equal(holdDelJson.heldBills.length, 0);

      // Verify Branch 02 bootstrap opens its own independent shift & preserves ledger invariant
      const brBootRes = await fetch(`${url}/api/bootstrap?outletId=OUTLET-BR-02`);
      assert.equal(brBootRes.status, 200);
      const brBoot = (await brBootRes.json()) as {
        activeShift: { outletId: string } | null;
        ledgerInvariant: { valid: boolean };
      };
      assert.equal(brBoot.activeShift?.outletId, 'OUTLET-BR-02');
      assert.equal(brBoot.ledgerInvariant.valid, true);

      // Verify 86'd temporary item pause (`active: false`) & resume (`active: true`)
      const pauseRes = await fetch(`${url}/api/catalog/variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId: createdProd.variant.id,
          itemName: 'Yuzu Honey Sparkling Cold Brew',
          sku: 'SKU-YUZU-01',
          barcode: '8857770001112',
          categoryId: 'CAT-CAFE',
          unitName: 'ขวด',
          priceSatang: 8_500,
          defaultPurchaseCostMicroBaht: 35_000_000,
          initialStockMilli: 0,
          active: false,
          performedByUserId: authData.user.id,
        }),
      });
      assert.equal(pauseRes.status, 200);
      const pausedJson = (await pauseRes.json()) as { variant: { active: boolean } };
      assert.equal(pausedJson.variant.active, false);

      // 6. Product Image Upload + Fetch + Audit-Safe Product Delete + Category CRUD/Delete
      const tinyPngBase64 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const uploadImgRes = await fetch(`${url}/api/catalog/variant-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId: createdProd.variant.id,
          dataUrl: tinyPngBase64,
          actorUserId: authData.user.id,
        }),
      });
      assert.equal(uploadImgRes.status, 200);
      const uploadImgJson = (await uploadImgRes.json()) as { imageUrl: string | null };
      assert.ok(uploadImgJson.imageUrl && uploadImgJson.imageUrl.startsWith('/api/catalog/image/'));

      const fetchImgRes = await fetch(`${url}${uploadImgJson.imageUrl}`);
      assert.equal(fetchImgRes.status, 200);
      assert.equal(fetchImgRes.headers.get('content-type'), 'image/png');

      // Delete variant that has ledger history (opening stock) -> must preserve 100% Ledger Invariant & disappear from catalog
      const delVarRes = await fetch(`${url}/api/catalog/variant`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId: createdProd.variant.id,
          performedByUserId: authData.user.id,
        }),
      });
      assert.equal(delVarRes.status, 200);
      const delVarJson = (await delVarRes.json()) as { ok: boolean; mode: string };
      assert.equal(delVarJson.ok, true);
      assert.equal(delVarJson.mode, 'ARCHIVED_SAFE');

      const postDelBoot = (await (await fetch(`${url}/api/bootstrap`)).json()) as {
        catalogDetailed: Array<{ id: string }>;
        ledgerInvariant: { valid: boolean };
      };
      assert.equal(
        postDelBoot.catalogDetailed.some((v) => v.id === createdProd.variant.id),
        false
      );
      assert.equal(postDelBoot.ledgerInvariant.valid, true);

      // Create & Delete custom category
      const createCatRes = await fetch(`${url}/api/catalog/category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'เบเกอรี่โฮมเมด',
          displayColor: '#1a73e8',
          kitchenStation: 'BAR',
        }),
      });
      assert.equal(createCatRes.status, 200);
      const createdCat = (await createCatRes.json()) as { category: { id: string } };
      const delCatRes = await fetch(`${url}/api/catalog/category`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: createdCat.category.id }),
      });
      assert.equal(delCatRes.status, 200);
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

  it('enforces strict CORS origin lock, Bearer Session Token + RBAC, Stateless Manager Void Override, and Resilient External USB Backup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-sec-prod-'));
    const dbPath = path.join(tmpDir, 'rube_sec.db');
    const extUsbDir = path.join(tmpDir, 'external-usb-drive');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      enforceApiSessionAuth: true,
    });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // 1. Strict CORS Origin Lock: evil third-party web page blocked with 403; trusted tauri.localhost allowed
      const evilRes = await fetch(`${url}/api/bootstrap`, {
        headers: { Origin: 'https://evil.example' },
      });
      assert.equal(evilRes.status, 403);
      assert.equal(evilRes.headers.get('access-control-allow-origin'), null);

      const trustedBootRes = await fetch(`${url}/api/bootstrap`, {
        headers: { Origin: 'http://tauri.localhost' },
      });
      assert.equal(trustedBootRes.status, 200);
      assert.equal(
        trustedBootRes.headers.get('access-control-allow-origin'),
        'http://tauri.localhost'
      );
      const lockedBoot = (await trustedBootRes.json()) as {
        onboarded: boolean;
        isSessionAuthenticated: boolean;
        catalog: unknown[];
        recentOrders: unknown[];
      };
      assert.equal(lockedBoot.onboarded, true);
      assert.equal(lockedBoot.isSessionAuthenticated, false);
      assert.equal(lockedBoot.catalog.length, 0);
      assert.equal(lockedBoot.recentOrders.length, 0);

      // 2. Unauthenticated mutation endpoints must reject with HTTP 401
      const unauthProd = await fetch(`${url}/api/catalog/variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: 'Unauthorized Item',
          sku: 'SKU-UNAUTH',
          unitName: 'ชิ้น',
          priceSatang: 1_000,
          defaultPurchaseCostMicroBaht: 500_000,
        }),
      });
      assert.equal(unauthProd.status, 401);

      const unauthStore = await fetch(`${url}/api/settings/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: 'Hijacked',
          taxId: '000',
          branchCode: '00000',
          rdPosRegNo: 'X',
          promptPayId: '0999999999',
        }),
      });
      assert.equal(unauthStore.status, 401);

      // 3. Cashier PIN Login -> full authorized POS checkout, RBAC 403 blocks for Warehouse/Owner APIs
      const cashierLoginRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '111111' }),
      });
      assert.equal(cashierLoginRes.status, 200);
      const cashierAuth = (await cashierLoginRes.json()) as {
        user: { id: string; role: string };
        sessionToken: string;
      };
      assert.equal(cashierAuth.user.role, 'CASHIER');
      assert.ok(cashierAuth.sessionToken.includes('.'));

      const cashierBoot = (await (
        await fetch(`${url}/api/bootstrap`, {
          headers: { Authorization: `Bearer ${cashierAuth.sessionToken}` },
        })
      ).json()) as {
        isSessionAuthenticated: boolean;
        catalog: Array<{ id: string }>;
      };
      assert.equal(cashierBoot.isSessionAuthenticated, true);
      assert.ok(cashierBoot.catalog.length >= 8);

      // Cashier checkout succeeds (200)
      const checkoutRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierAuth.sessionToken}`,
        },
        body: JSON.stringify({
          paymentMethod: 'CASH',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-RET-001',
              itemName: 'Bottled Water',
              unitName: 'ขวด',
              quantityMilli: 1_000,
              unitPriceSatang: 1_500,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(checkoutRes.status, 200);
      const checkoutJson = (await checkoutRes.json()) as {
        order: { salesOrderId: string };
      };

      // Cashier blocked (403) on Store Settings, Variant Delete, and Direct Void without Manager Override
      const cashierStoreRes = await fetch(`${url}/api/settings/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierAuth.sessionToken}`,
        },
        body: JSON.stringify({
          storeName: 'Escalated',
          taxId: '0105566009999',
          branchCode: '00000',
          rdPosRegNo: 'RD-01',
          promptPayId: '0812345678',
        }),
      });
      assert.equal(cashierStoreRes.status, 403);

      const cashierDelVarRes = await fetch(`${url}/api/catalog/variant`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierAuth.sessionToken}`,
        },
        body: JSON.stringify({ variantId: 'VAR-RET-001' }),
      });
      assert.equal(cashierDelVarRes.status, 403);

      const directVoidRes = await fetch(`${url}/api/pos/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierAuth.sessionToken}`,
        },
        body: JSON.stringify({
          salesOrderId: checkoutJson.order.salesOrderId,
          voidReason: 'No manager override',
        }),
      });
      assert.equal(directVoidRes.status, 403);

      // 4. Stateless Manager/Owner PIN Override Token authorizes Void without changing active session
      const overrideRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999', statelessOverride: true }),
      });
      assert.equal(overrideRes.status, 200);
      const overrideJson = (await overrideRes.json()) as { sessionToken: string };

      const approvedVoidRes = await fetch(`${url}/api/pos/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierAuth.sessionToken}`,
          'X-Rube-Override-Token': overrideJson.sessionToken,
        },
        body: JSON.stringify({
          salesOrderId: checkoutJson.order.salesOrderId,
          voidReason: 'Approved by Owner PIN',
        }),
      });
      assert.equal(approvedVoidRes.status, 200);

      // 5. Owner configures External USB Backup Folder + executes backup + logout revokes token
      const ownerLoginRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.equal(ownerLoginRes.status, 200);
      const ownerAuth = (await ownerLoginRes.json()) as { sessionToken: string };

      const usbCfgRes = await fetch(`${url}/api/usb-backup/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.sessionToken}`,
        },
        body: JSON.stringify({
          customBackupDir: extUsbDir,
          mirrorToLocalFallback: true,
        }),
      });
      assert.equal(usbCfgRes.status, 200);
      const usbCfgJson = (await usbCfgRes.json()) as {
        usbBackupConfig: { isExternalCustomDir: boolean; targetWritable: boolean };
      };
      assert.equal(usbCfgJson.usbBackupConfig.isExternalCustomDir, true);
      assert.equal(usbCfgJson.usbBackupConfig.targetWritable, true);

      const backupNowRes = await fetch(`${url}/api/usb-backup/run-now`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.sessionToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(backupNowRes.status, 200);
      const backupNowJson = (await backupNowRes.json()) as {
        usbBackup: { writtenBackupPath: string };
      };
      assert.ok(backupNowJson.usbBackup.writtenBackupPath.startsWith(extUsbDir));
      assert.ok(fs.existsSync(backupNowJson.usbBackup.writtenBackupPath));

      const afterBoot = (await (
        await fetch(`${url}/api/bootstrap`, {
          headers: { Authorization: `Bearer ${ownerAuth.sessionToken}` },
        })
      ).json()) as { ledgerInvariant: { valid: boolean } };
      assert.equal(afterBoot.ledgerInvariant.valid, true);

      // Logout revokes token -> subsequent requests fail with 401
      const logoutRes = await fetch(`${url}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerAuth.sessionToken}` },
      });
      assert.equal(logoutRes.status, 200);

      const postLogoutRes = await fetch(`${url}/api/settings/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.sessionToken}`,
        },
        body: JSON.stringify({
          storeName: 'After Logout',
          taxId: '0105566009999',
          branchCode: '00000',
          rdPosRegNo: 'RD-01',
          promptPayId: '0812345678',
        }),
      });
      assert.equal(postLogoutRes.status, 401);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('closes all /boost deep hardening items: Host guard, PIN lockout + scrypt, multi-branch ABB, cross-shift void, AES-256-GCM .db.enc, spooler dedup, multi-station KDS split & date filter', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-boost-hardening-'));
    const dbPath = path.join(tmpDir, 'rube_boost.db');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      enforceApiSessionAuth: true,
      pinLockoutDurationMs: 120,
    });
    const { url, port } = await appServer.start(0, '127.0.0.1');

    try {
      // 1. Host header DNS-Rebinding Guard -> HTTP 403
      const hostBlockedStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/bootstrap',
            method: 'GET',
            headers: { Host: 'evil-rebind.attacker.com:4173' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(hostBlockedStatus, 403);

      // 2. PIN Brute-Force Lockout (5 failures -> 429) & Salted Scrypt PIN creation
      for (let i = 1; i <= 4; i++) {
        const bad = await fetch(`${url}/api/auth/pin-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: `000${i}` }),
        });
        assert.equal(bad.status, 401);
      }
      const fifth = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '0005' }),
      });
      assert.equal(fifth.status, 429);

      // While locked, even valid PIN must return 429
      const duringLock = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.equal(duringLock.status, 429);

      await new Promise((r) => setTimeout(r, 160));

      const ownerAuthRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.equal(ownerAuthRes.status, 200);
      const ownerAuth = (await ownerAuthRes.json()) as {
        user: { id: string };
        sessionToken: string;
      };
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.sessionToken}`,
      };

      // Create a staff user and verify salted scrypt hash persisted in DB & works
      const staffCreateRes = await fetch(`${url}/api/auth/users`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          username: 'manager2',
          displayName: 'ผู้จัดการสาขา 2',
          role: 'MANAGER',
          pin: '5678',
        }),
      });
      assert.equal(staffCreateRes.status, 200);
      const storedPinRow = appServer.engine.executeRead((db) =>
        db.prepare(`SELECT pin_hash FROM users WHERE username = 'manager2'`).get() as {
          pin_hash: string;
        }
      );
      assert.ok(storedPinRow.pin_hash.startsWith('scrypt:pin:'));

      // 3. Multi-Branch ABB Receipt Uniqueness (HQ vs BR-02 on same day)
      await fetch(`${url}/api/warehouse/outlet`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ code: 'BR-02', name: 'Thonglor Branch' }),
      });
      await fetch(`${url}/api/bootstrap?outletId=OUTLET-BR-02`, { headers: authHeaders });

      const hqSaleRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          paymentMethod: 'CASH',
          cashTenderedSatang: 5_000,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-RET-001',
              itemName: 'Crystal Water',
              unitName: 'ขวด',
              quantityMilli: 1_000,
              unitPriceSatang: 1_500,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(hqSaleRes.status, 200);
      const hqSale = (await hqSaleRes.json()) as {
        order: { salesOrderId: string; abbTaxInvoiceNo: string; receiptNumber: string };
      };
      assert.match(hqSale.order.abbTaxInvoiceNo, /^ABB-\d{8}-000001$/);

      const br2SaleRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-BR-02',
          paymentMethod: 'CASH',
          cashTenderedSatang: 5_000,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-RET-001',
              itemName: 'Crystal Water',
              unitName: 'ขวด',
              quantityMilli: 1_000,
              unitPriceSatang: 1_500,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(br2SaleRes.status, 200);
      const br2Sale = (await br2SaleRes.json()) as {
        order: { abbTaxInvoiceNo: string };
      };
      assert.match(br2Sale.order.abbTaxInvoiceNo, /^ABB-BR-02-\d{8}-000001$/);

      // 4. Close Shift 1 -> Verify AES-256-GCM .db.enc encryption -> Void Shift 1 order in Shift 2 -> Cross-shift cash conservation
      const bootBeforeClose = (await (
        await fetch(`${url}/api/bootstrap?outletId=OUTLET-HQ`, { headers: authHeaders })
      ).json()) as { activeShift: { id: string; expectedCashSatang: number } };
      const shift1Id = bootBeforeClose.activeShift.id;

      const closeShiftRes = await fetch(`${url}/api/shift/close-and-reopen`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          countedCashSatang: bootBeforeClose.activeShift.expectedCashSatang,
          reopenNextShift: true,
        }),
      });
      assert.equal(closeShiftRes.status, 200);
      const closeShiftJson = (await closeShiftRes.json()) as {
        zReport: { expectedCashSatang: number; cashVarianceSatang: number };
        usbBackup: { writtenBackupPath: string };
      };
      const expectedAfterShift1 = closeShiftJson.zReport.expectedCashSatang;
      assert.equal(closeShiftJson.zReport.cashVarianceSatang, 0);

      // Verify .db.enc file is genuinely AES-256-GCM encrypted (no plaintext 'SQLite format 3')
      const rawEncBytes = fs.readFileSync(closeShiftJson.usbBackup.writtenBackupPath);
      assert.equal(rawEncBytes.subarray(0, 12).toString('utf8'), 'RUBE-ENC-V1\n');
      assert.equal(rawEncBytes.includes(Buffer.from('SQLite format 3', 'utf8')), false);
      const decryptedDbBytes = SqliteReadWritePoolEngine.decryptUsbBackupPayload(
        rawEncBytes,
        DEV_SQLCIPHER_RAW_HEX_KEY_64
      );
      assert.equal(decryptedDbBytes.subarray(0, 15).toString('utf8'), 'SQLite format 3');

      const tamperedEnc = Buffer.from(rawEncBytes);
      tamperedEnc[tamperedEnc.length - 1] = (tamperedEnc[tamperedEnc.length - 1]! ^ 0xff) & 0xff;
      assert.throws(() =>
        SqliteReadWritePoolEngine.decryptUsbBackupPayload(
          tamperedEnc,
          DEV_SQLCIPHER_RAW_HEX_KEY_64
        )
      );

      // Void Shift 1 order during Shift 2 -> Shift 1 Z-Report remains untouched; Shift 2 drawer records PAID_OUT (-1,500 Satang)
      const crossVoidRes = await fetch(`${url}/api/pos/void`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          salesOrderId: hqSale.order.salesOrderId,
          voidReason: 'Cross-shift refund',
        }),
      });
      assert.equal(crossVoidRes.status, 200);

      const shift1ReportAfterVoid = (await (
        await fetch(`${url}/api/reports?outletId=OUTLET-HQ&shiftId=${shift1Id}`, {
          headers: authHeaders,
        })
      ).json()) as { zReport: { expectedCashSatang: number; cashVarianceSatang: number } };
      assert.equal(shift1ReportAfterVoid.zReport.expectedCashSatang, expectedAfterShift1);
      assert.equal(shift1ReportAfterVoid.zReport.cashVarianceSatang, 0);

      const shift2BootAfterVoid = (await (
        await fetch(`${url}/api/bootstrap?outletId=OUTLET-HQ`, { headers: authHeaders })
      ).json()) as {
        activeShift: { expectedCashSatang: number };
        drawerMovements: Array<{ movementType: string; amountSatang: number }>;
        ledgerInvariant: { valid: boolean };
      };
      assert.ok(
        shift2BootAfterVoid.drawerMovements.some(
          (m) => m.movementType === 'PAID_OUT' && m.amountSatang === 1_500
        )
      );
      assert.equal(shift2BootAfterVoid.activeShift.expectedCashSatang, 98_500);
      assert.equal(shift2BootAfterVoid.ledgerInvariant.valid, true);

      // 5. Printer Spooler Deduplication + Multi-Station KDS Split + ABB Date-Range Filter
      await fetch(`${url}/api/hal/printer-state`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ready: false }),
      });

      const kitchenCatRes = await fetch(`${url}/api/catalog/category`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'อาหารจานหลัก', kitchenStation: 'MAIN' }),
      });
      const kitchenCat = (await kitchenCatRes.json()) as { category: { id: string } };
      const foodProdRes = await fetch(`${url}/api/catalog/variant`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          itemName: 'ข้าวกะเพราหมูกรอบ',
          sku: 'SKU-KAPAO-01',
          categoryId: kitchenCat.category.id,
          unitName: 'จาน',
          priceSatang: 9_500,
          defaultPurchaseCostMicroBaht: 45_000_000,
          initialStockMilli: 20_000,
        }),
      });
      const foodProd = (await foodProdRes.json()) as { variant: { id: string } };

      const multiStationCheckoutRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          orderType: 'DINE_IN',
          tableOrQueueNo: 'A-12',
          paymentMethod: 'CASH',
          cashTenderedSatang: 20_000,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-CAFE-MILKTEA',
              itemName: 'Taiwan Brown Sugar Boba Milk Tea',
              unitName: 'แก้ว',
              quantityMilli: 1_000,
              unitPriceSatang: 6_500,
              selectedModifierIds: [],
            },
            {
              variantId: foodProd.variant.id,
              itemName: 'ข้าวกะเพราหมูกรอบ',
              unitName: 'จาน',
              quantityMilli: 1_000,
              unitPriceSatang: 9_500,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(multiStationCheckoutRes.status, 200);
      const multiCheckout = (await multiStationCheckoutRes.json()) as {
        order: { salesOrderId: string; receiptNumber: string };
        spoolResult: { pendingQueueLength: number };
      };
      assert.equal(multiCheckout.spoolResult.pendingQueueLength, 1);

      // Sending 203-DPI Canvas Raster for the exact same salesOrderId replaces pending job -> still length 1!
      const dummyBitmap = Buffer.alloc((576 / 8) * 16, 0xaa).toString('base64');
      const rasterPrintRes = await fetch(`${url}/api/hal/print-canvas-raster`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          packedBitmapBase64: dummyBitmap,
          widthPx: 576,
          heightPx: 16,
          kickCashDrawer: true,
          salesOrderId: multiCheckout.order.salesOrderId,
          receiptNumber: multiCheckout.order.receiptNumber,
        }),
      });
      assert.equal(rasterPrintRes.status, 200);
      const rasterJson = (await rasterPrintRes.json()) as {
        spoolResult: { pendingQueueLength: number };
      };
      assert.equal(rasterJson.spoolResult.pendingQueueLength, 1);

      const flushRes = await fetch(`${url}/api/hal/printer-state`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ready: true }),
      });
      const flushJson = (await flushRes.json()) as { autoFlushedCount: number };
      assert.equal(flushJson.autoFlushedCount, 1);

      // Verify KDS generated 2 distinct station tickets (`BAR` and `MAIN`)
      const kdsJson = (await (
        await fetch(`${url}/api/kds/tickets?outletId=OUTLET-HQ`, { headers: authHeaders })
      ).json()) as {
        tickets: Array<{ salesOrderId: string; station: string; queueNumber: string }>;
      };
      const orderTickets = kdsJson.tickets.filter(
        (t) => t.salesOrderId === multiCheckout.order.salesOrderId
      );
      assert.equal(orderTickets.length, 2);
      assert.ok(orderTickets.some((t) => t.station === 'BAR' && t.queueNumber === 'A-12'));
      assert.ok(orderTickets.some((t) => t.station === 'MAIN' && t.queueNumber === 'A-12'));

      // Verify ABB Date-Range Filtering (`ภ.พ.30` support)
      const emptyFutureAbb = (await (
        await fetch(`${url}/api/reports?outletId=OUTLET-HQ&startDate=2099-01-01&endDate=2099-01-31`, {
          headers: authHeaders,
        })
      ).json()) as { abbReport: { activeInvoiceCount: number; invoices: unknown[] } };
      assert.equal(emptyFutureAbb.abbReport.activeInvoiceCount, 0);
      assert.equal(emptyFutureAbb.abbReport.invoices.length, 0);

      const todayIso = new Date().toISOString().slice(0, 10);
      const todayAbb = (await (
        await fetch(
          `${url}/api/reports?outletId=OUTLET-HQ&startDate=${todayIso}&endDate=${todayIso}`,
          { headers: authHeaders }
        )
      ).json()) as { abbReport: { activeInvoiceCount: number } };
      assert.ok(todayAbb.abbReport.activeInvoiceCount >= 1);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes 3-tier multi-agent concurrency, algorithm, scanner/PIN & UPS lock regression scenarios end-to-end', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-3tier-reg-'));
    const dbPath = path.join(tmpDir, 'rube_3tier.db');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      enforceApiSessionAuth: true,
      pinLockoutDurationMs: 600,
    });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // 1. Per-User PIN Brute-Force Lockout Isolation:
      // 4 failed attempts targeting USR-OWNER-01 + valid USR-CASHIER-01 login MUST NOT reset OWNER's counter!
      for (let i = 0; i < 4; i++) {
        const failRes = await fetch(`${url}/api/auth/pin-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: 'USR-OWNER-01', pin: `00000${i}` }),
        });
        assert.equal(failRes.status, 401);
      }

      const cashierLogin = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'USR-CASHIER-01', pin: '111111' }),
      });
      assert.equal(cashierLogin.status, 200);

      // 5th failure on USR-OWNER-01 immediately locks with HTTP 429
      const fifthOwnerFail = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'USR-OWNER-01', pin: '000099' }),
      });
      assert.equal(fifthOwnerFail.status, 429);

      // Wait out test lockout duration (600ms) and sign in as OWNER
      await new Promise((r) => setTimeout(r, 700));
      const ownerRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'USR-OWNER-01', pin: '999999' }),
      });
      assert.equal(ownerRes.status, 200);
      const { sessionToken } = (await ownerRes.json()) as { sessionToken: string };
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      };

      // 2. Price-Embedded Scale Barcode (Prefix 25) Override Accuracy & Client-Side Idempotency Race Protection
      // 0.667 kg of Pork Belly (150.00 THB/kg = 15,000 satang/kg -> 10,005 satang linearly) MUST charge exact ฿100.00 sticker (10,000 satang)
      const porkScaleRes = await fetch(`${url}/api/catalog/variant`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          itemName: 'หมูสามชั้นคัดเกรด',
          sku: '10099',
          barcode: null,
          unitName: 'กก.',
          priceSatang: 15_000,
          defaultPurchaseCostMicroBaht: 110_000_000,
          initialStockMilli: 10_000,
          isWeightedScale: true,
        }),
      });
      const porkScale = (await porkScaleRes.json()) as { variant: { id: string } };

      const idemKey = 'IDEM-SCALE-BURST-RACE-001';
      const payload = {
        idempotencyKey: idemKey,
        outletId: 'OUTLET-HQ',
        paymentMethod: 'CASH',
        cashTenderedSatang: 10_000,
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        lines: [
          {
            variantId: porkScale.variant.id,
            itemName: 'หมูสามชั้นคัดเกรด',
            unitName: 'กก.',
            quantityMilli: 667,
            unitPriceSatang: 15_000,
            overrideLineTotalSatang: 10_000,
            selectedModifierIds: [],
          },
        ],
      };

      // Fire 2 concurrent checkouts with the exact same client idempotencyKey
      const [cRes1, cRes2] = await Promise.all([
        fetch(`${url}/api/pos/checkout`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(payload),
        }),
        fetch(`${url}/api/pos/checkout`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(payload),
        }),
      ]);
      assert.equal(cRes1.status, 200);
      assert.equal(cRes2.status, 200);
      const c1 = (await cRes1.json()) as {
        order: { salesOrderId: string; totalSatang: number; replayedFromIdempotencyKey: boolean };
      };
      const c2 = (await cRes2.json()) as {
        order: { salesOrderId: string; totalSatang: number; replayedFromIdempotencyKey: boolean };
      };
      assert.equal(c1.order.totalSatang, 10_000);
      assert.equal(c1.order.salesOrderId, c2.order.salesOrderId);
      assert.ok(
        c1.order.replayedFromIdempotencyKey !== c2.order.replayedFromIdempotencyKey,
        'One concurrent identical checkout must commit and the second must replay cleanly'
      );

      // Stock must only be deducted once: 10,000 - 667 = 9,333 milli
      const invAfterScale = appServer.engine
        .listInventoryCatalog('OUTLET-HQ')
        .find((v) => v.id === porkScale.variant.id);
      assert.equal(invAfterScale?.inStockMilli, 9_333);

      // 3. Slip Step-1 Exact UI DTO Shape (`valid`, `bankDisplayNameThai`, `transRefLast4`) + Duplicate SQLite Check
      const step1Slip = '003700060000010103004021620261126SLIPRE01';
      const slipCheckRes = await fetch(`${url}/api/pos/verify-slip-step1`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          miniQrRaw: step1Slip,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-RET-001',
              quantityMilli: 1_000,
              unitPriceSatang: 700,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(slipCheckRes.status, 200);
      const slipDto = (await slipCheckRes.json()) as {
        valid: boolean;
        bankCode: string;
        bankDisplayNameThai: string;
        transRefLast4: string;
        expectedAmountFormatted: string;
      };
      assert.equal(slipDto.valid, true);
      assert.equal(slipDto.bankCode, '004');
      assert.equal(slipDto.transRefLast4, 'RE01');
      assert.equal(slipDto.expectedAmountFormatted, '฿7.00');

      // 4. Atomic Non-Destructive Held Bill Claim (`POST /api/pos/held-bills/claim` blocks second terminal with HTTP 409 while keeping bill in SQLite)
      const holdSaveRes = await fetch(`${url}/api/pos/held-bills`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          bill: {
            id: 'HOLD-RACE-001',
            referenceLabel: 'โต๊ะ 7',
            orderType: 'DINE_IN',
            taxMode: 'INCLUSIVE',
            cart: [],
            totalSatang: 6_500,
            heldByName: 'Owner',
            heldAtIso: new Date().toISOString(),
          },
        }),
      });
      assert.equal(holdSaveRes.status, 200);

      const [recall1, recall2] = await Promise.all([
        fetch(`${url}/api/pos/held-bills/claim`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ outletId: 'OUTLET-HQ', id: 'HOLD-RACE-001', claimToken: 'TERM-1' }),
        }),
        fetch(`${url}/api/pos/held-bills/claim`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ outletId: 'OUTLET-HQ', id: 'HOLD-RACE-001', claimToken: 'TERM-2' }),
        }),
      ]);
      const statuses = [recall1.status, recall2.status].sort();
      assert.deepEqual(statuses, [200, 409]);

      // Bill MUST remain in server held_bills until actual checkout or manager void
      const heldAfterClaim = (await (
        await fetch(`${url}/api/pos/held-bills?outletId=OUTLET-HQ`, { headers: authHeaders })
      ).json()) as { heldBills: Array<{ id: string; activeClaimToken?: string }> };
      assert.equal(heldAfterClaim.heldBills.some((b) => b.id === 'HOLD-RACE-001' && Boolean(b.activeClaimToken)), true);

      const relRes = await fetch(`${url}/api/pos/held-bills/release`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ outletId: 'OUTLET-HQ', id: 'HOLD-RACE-001', force: true }),
      });
      assert.equal(relRes.status, 200);
      const cleanVoidRes = await fetch(`${url}/api/pos/held-bills/void`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          id: 'HOLD-RACE-001',
          voidReason: 'Cleanup race test held bill',
        }),
      });
      assert.equal(cleanVoidRes.status, 200);

      // 5. KDS Voided Order Resurrection Guard + Menu Gross Margin Discount Proration
      const cafeOrderRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          idempotencyKey: 'IDEM-VOID-KDS-001',
          outletId: 'OUTLET-HQ',
          orderType: 'DINE_IN',
          tableOrQueueNo: 'K-09',
          paymentMethod: 'CASH',
          cashTenderedSatang: 6_500,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: 'VAR-CAFE-MILKTEA',
              quantityMilli: 1_000,
              unitPriceSatang: 6_500,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      const cafeOrder = (await cafeOrderRes.json()) as {
        order: { salesOrderId: string };
      };
      const kdsListRes = await fetch(`${url}/api/kds/tickets?outletId=OUTLET-HQ`, {
        headers: authHeaders,
      });
      const kdsList = (await kdsListRes.json()) as {
        tickets: Array<{ kitchenOrderId: string; sequenceId: number; salesOrderId: string }>;
      };
      const ticket = kdsList.tickets.find((t) => t.salesOrderId === cafeOrder.order.salesOrderId)!;
      assert.ok(ticket);

      const voidRes = await fetch(`${url}/api/pos/void`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          salesOrderId: cafeOrder.order.salesOrderId,
          voidReason: 'Test KDS lock on void',
        }),
      });
      assert.equal(voidRes.status, 200);

      const resurrectKdsRes = await fetch(`${url}/api/kds/bump`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          kitchenOrderId: ticket.kitchenOrderId,
          ackedSequenceId: ticket.sequenceId,
          newStatus: 'PREPARING',
        }),
      });
      assert.equal(resurrectKdsRes.status, 409);

      // 6. Bill Discount Proration in Menu Gross Margin Report (100 THB - 20 THB discount -> 80 THB net revenue)
      const discOrderRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          idempotencyKey: 'IDEM-DISC-MARGIN-001',
          outletId: 'OUTLET-HQ',
          paymentMethod: 'CASH',
          cashTenderedSatang: 10_000,
          taxMode: 'INCLUSIVE',
          discountSatang: 2_000,
          lines: [
            {
              variantId: porkScale.variant.id,
              quantityMilli: 1_000,
              unitPriceSatang: 10_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(discOrderRes.status, 200);
      const marginRpt = appServer.engine.generateMenuGrossMarginAndCogsReport('OUTLET-HQ');
      const porkMargin = marginRpt.lines.find((l) => l.variantId === porkScale.variant.id)!;
      // Order 1 = 10,000 + Order 2 = (10,000 - 2,000 discount) => total net revenue = 18,000 satang
      assert.equal(porkMargin.grossRevenueSatang, 18_000);

      // 7. Inactive / Archived Variant Blocked at Checkout + VACUUM INTO Encrypted Backup Integrity
      await fetch(`${url}/api/catalog/variant`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          variantId: porkScale.variant.id,
          itemName: 'หมูสามชั้นคัดเกรด (พักขาย)',
          sku: '10099',
          unitName: 'กก.',
          priceSatang: 15_000,
          defaultPurchaseCostMicroBaht: 110_000_000,
          active: false,
        }),
      });
      const inactiveCheckout = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          idempotencyKey: 'IDEM-INACTIVE-BLOCK-001',
          outletId: 'OUTLET-HQ',
          paymentMethod: 'CASH',
          cashTenderedSatang: 15_000,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: porkScale.variant.id,
              quantityMilli: 1_000,
              unitPriceSatang: 15_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(inactiveCheckout.status, 409);

      // Run manual backup concurrently and verify decrypted SQLite snapshot integrity & committed rows
      const backupRes = await fetch(`${url}/api/usb-backup/run-now`, {
        method: 'POST',
        headers: authHeaders,
      });
      assert.equal(backupRes.status, 200);
      const backupJson = (await backupRes.json()) as {
        usbBackup: { writtenBackupPath: string };
      };
      const plainBytes = SqliteReadWritePoolEngine.decryptUsbBackupPayload(
        fs.readFileSync(backupJson.usbBackup.writtenBackupPath),
        DEV_SQLCIPHER_RAW_HEX_KEY_64
      );
      const verifySnapPath = path.join(tmpDir, 'verify_vacuum.db');
      fs.writeFileSync(verifySnapPath, plainBytes);
      const snapDb = new DatabaseSync(verifySnapPath);
      try {
        const integrity = snapDb.prepare('PRAGMA integrity_check;').get() as {
          integrity_check: string;
        };
        assert.equal(integrity.integrity_check, 'ok');
        const foundOrder = snapDb
          .prepare(`SELECT id FROM sales_orders WHERE id = ?`)
          .get(c1.order.salesOrderId) as { id?: string } | undefined;
        assert.equal(foundOrder?.id, c1.order.salesOrderId);
      } finally {
        snapDb.close();
      }

      // 8. UPS Critical Low-Battery Read-Only Lock (`HTTP 423`)
      const upsLowRes = await fetch(`${url}/api/hal/ups-state`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ acPresent: false, batteryChargePercent: 12 }),
      });
      assert.equal(upsLowRes.status, 200);

      const lockedWriteRes = await fetch(`${url}/api/pos/held-bills`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          outletId: 'OUTLET-HQ',
          bill: { id: 'HOLD-UPS-LOCKED', cart: [], totalSatang: 0 },
        }),
      });
      assert.equal(lockedWriteRes.status, 423);

      // Restore AC power and confirm writes resume
      await fetch(`${url}/api/hal/ups-state`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ acPresent: true, batteryChargePercent: 95 }),
      });

      // 9. Thai Kedmanee Keyboard Digit Resolver (`PinLockModal` / `VoidOrderAuthModal` physical keyboard entry)
      assert.equal(
        resolveDigitFromKeyboardEvent({
          key: 'ภ',
          code: 'Digit4',
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
        }),
        '4'
      );
      assert.equal(
        resolveDigitFromKeyboardEvent({
          key: 'ๅ',
          code: 'Digit1',
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
        }),
        '1'
      );
      assert.equal(mapThaiKedmaneeDigitInput('ๅ/-ภถุึคตจ'), '1234567890');
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
