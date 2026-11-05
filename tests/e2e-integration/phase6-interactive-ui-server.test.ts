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
});
