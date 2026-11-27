import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  buildTableMenuUrl,
  buildWifiQrPayload,
  computeGuestOrderLineSatang,
  normalizeQrOrderingConfig,
} from '../../packages/shared-contracts/src/qr-ordering.ts';
import { RubePosInteractiveAppServer } from '../../packages/ui-presentation/src/server/pos-desktop-server.ts';

function getFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

test('Phase 8A: QR ordering shared contracts — Wi-Fi QR escaping, config guardrails & BigInt fixed-point pricing', () => {
  const wpa = buildWifiQrPayload('Cafe;Rube:5G', 'P@ss\\word,1"', 'WPA');
  assert.equal(wpa, 'WIFI:T:WPA;S:Cafe\\;Rube\\:5G;P:P@ss\\\\word\\,1\\";;');

  const openWifi = buildWifiQrPayload('Guest Free', 'ignored', 'NOPASS');
  assert.equal(openWifi, 'WIFI:T:nopass;S:Guest Free;;');

  assert.equal(buildWifiQrPayload('   ', '1234', 'WPA'), '');

  const cfg = normalizeQrOrderingConfig({
    enabled: true,
    port: 4173, // must be rejected so Guest server never collides with POS port 4173
    maxQtyPerItem: 500, // invalid (>99) -> falls back to default 20
    tableLabels: ['T01', 't01', 'T02', 'TAKEAWAY'],
  });
  assert.equal(cfg.port, 4174);
  assert.equal(cfg.maxQtyPerItem, 20);
  assert.deepEqual(cfg.tableLabels, ['T01', 'T02', 'TAKEAWAY']);

  const url = buildTableMenuUrl('http://192.168.1.50:4174/', 'T04', 'abc.123');
  assert.equal(url, 'http://192.168.1.50:4174/m?t=T04&s=abc.123');

  const pricing = computeGuestOrderLineSatang({
    quantityMilli: 3_000,
    unitPriceSatang: 6_500,
    modifierPriceDeltasSatang: [1_000, -500],
  });
  assert.equal(pricing.baseLineSatang, 19_500);
  assert.equal(pricing.modifiersTotalSatang, 1_500);
  assert.equal(pricing.lineTotalSatang, 21_000);
});

test('Phase 8B: Full E2E Isolated Guest LAN Server, Captive Portal, Signed Table QR, Held Bill + KDS, Auto-Revoke & Rate Limiting', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-pos-phase8-qr-'));
  const dbPath = path.join(tmpDir, 'rube_qr_e2e.db');
  const guestPort = await getFreeTcpPort();

  const server = new RubePosInteractiveAppServer({
    dbPath,
    requireFirstRunWizard: false,
    enforceApiSessionAuth: true,
    guestQrRateLimitPerMinute: 6,
  });

  try {
    const { url: posBase } = await server.start(0, '127.0.0.1');

    // 1. Login as Owner (seeded default Owner PIN 999999)
    const loginRes = await fetch(`${posBase}/api/auth/pin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '999999', userId: 'USR-OWNER-01' }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = (await loginRes.json()) as { sessionToken: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loginData.sessionToken}`,
    };

    // 2. Verify Guest Server is OFF by default (Zero-Trust Default)
    const bootRes = await fetch(`${posBase}/api/bootstrap`, { headers: authHeaders });
    assert.equal(bootRes.status, 200);
    const boot = (await bootRes.json()) as {
      qrOrderingConfig: { enabled: boolean };
      qrOrderingStatus: { running: boolean };
      catalogDetailed: Array<{
        id: string;
        itemName: string;
        categoryId: string | null;
        priceSatang: number;
        active: boolean;
      }>;
      modifiers: Array<{ id: string; name: string; priceDeltaSatang: number }>;
    };
    assert.equal(boot.qrOrderingConfig.enabled, false);
    assert.equal(boot.qrOrderingStatus.running, false);

    // 3. Enable Guest LAN Server LIVE without restart
    const saveCfgRes = await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        enabled: true,
        port: guestPort,
        wifiSsid: 'RubeCafe_Guest',
        wifiPassword: 'coffee2026',
        wifiSecurity: 'WPA',
        approvalMode: 'CASHIER_CONFIRM',
        allowOpenTableSelection: true,
        maxQtyPerItem: 10,
        tableLabels: ['T01', 'T04', 'T05', 'TAKEAWAY'],
      }),
    });
    assert.equal(saveCfgRes.status, 200);
    const saveCfgData = (await saveCfgRes.json()) as {
      status: { running: boolean; port: number };
    };
    assert.equal(saveCfgData.status.running, true);
    assert.equal(saveCfgData.status.port, guestPort);

    const guestBase = `http://127.0.0.1:${guestPort}`;

    // 4. Zero-Trust Port Isolation: POS/Admin routes MUST be blocked with HTTP 403 on Guest Port
    for (const forbiddenPath of [
      '/api/bootstrap',
      '/api/settings/store',
      '/api/pos/checkout',
      '/api/auth/users',
      '/api/warehouse/ledger',
      '/api/reports',
    ]) {
      const isoRes = await fetch(`${guestBase}${forbiddenPath}`);
      assert.equal(
        isoRes.status,
        403,
        `Guest port MUST reject ${forbiddenPath} with HTTP 403`
      );
    }

    // 5. Captive Portal OS Connectivity Probes MUST redirect (302) to /m?captive=1
    for (const probe of [
      '/generate_204',
      '/hotspot-detect.html',
      '/ncsi.txt',
      '/connecttest.txt',
    ]) {
      const capRes = await fetch(`${guestBase}${probe}`, { redirect: 'manual' });
      assert.equal(capRes.status, 302, `Captive probe ${probe} must respond 302`);
      const loc = capRes.headers.get('location') ?? '';
      assert.ok(loc.includes('/m?captive=1'), `Unexpected redirect Location: ${loc}`);
    }

    // 6. Offline Mobile Menu HTML + Offline Noto Sans Lao Font + Sanitized Menu API
    const htmlRes = await fetch(`${guestBase}/m`);
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes('/fonts/noto-sans-lao-400.woff2'));
    assert.ok(!htmlBody.includes('https://'), 'Guest HTML must have zero external CDN URLs');
    assert.ok(!htmlBody.includes('window.alert('), 'Guest HTML must not use window.alert');

    const fontRes = await fetch(`${guestBase}/fonts/noto-sans-lao-400.woff2`);
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers.get('content-type'), 'font/woff2');

    // Open Signed Table QR Session for Table T04
    const openT04Res = await fetch(`${posBase}/api/qr-ordering/table-session`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tableLabel: 'T04' }),
    });
    assert.equal(openT04Res.status, 200);
    const openT04Data = (await openT04Res.json()) as {
      session: { tableLabel: string; token: string; wifiQrPayload: string };
    };
    assert.equal(openT04Data.session.tableLabel, 'T04');
    assert.equal(
      openT04Data.session.wifiQrPayload,
      'WIFI:T:WPA;S:RubeCafe_Guest;P:coffee2026;;'
    );

    const menuRes = await fetch(
      `${guestBase}/api/guest/menu?t=T04&s=${encodeURIComponent(openT04Data.session.token)}`
    );
    assert.equal(menuRes.status, 200);
    const menuText = await menuRes.text();
    assert.ok(!menuText.includes('averageCostMicroBaht'), 'Guest menu must never leak MAC costs');
    assert.ok(!menuText.includes('CAT-RAW'), 'Guest menu must exclude raw material category');
    const menu = JSON.parse(menuText) as {
      signedTableValid: boolean;
      lockedTableLabel: string | null;
      items: Array<{ variantId: string; itemName: string; priceSatang: number; isAvailable: boolean }>;
      modifierGroups: Array<{ modifiers: Array<{ id: string; priceDeltaSatang: number }> }>;
    };
    assert.equal(menu.signedTableValid, true);
    assert.equal(menu.lockedTableLabel, 'T04');
    assert.ok(menu.items.length > 0);

    const sellableItem = menu.items.find((i) => i.isAvailable)!;
    assert.ok(sellableItem);
    const firstMod = menu.modifierGroups[0]?.modifiers[0];

    // Trying to order a CAT-RAW raw material MUST be rejected with HTTP 403
    const rawVariant = boot.catalogDetailed.find((v) => v.categoryId === 'CAT-RAW');
    if (rawVariant) {
      const rawAttempt = await fetch(`${guestBase}/api/guest/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableLabel: 'T04',
          signedToken: openT04Data.session.token,
          lines: [{ variantId: rawVariant.id, quantityCount: 1 }],
        }),
      });
      assert.equal(rawAttempt.status, 403);
    }

    // 7. Customer submits Signed Table QR order (Cashier Confirm mode -> PENDING_CONFIRM)
    const submitRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        signedToken: openT04Data.session.token,
        customerName: 'Khun Noi',
        customerNote: 'เสิร์ฟพร้อมกัน',
        lines: [
          {
            variantId: sellableItem.variantId,
            quantityCount: 2,
            selectedModifierIds: firstMod ? [firstMod.id] : [],
            note: 'หวานน้อย',
          },
        ],
      }),
    });
    assert.equal(submitRes.status, 201);
    const submitData = (await submitRes.json()) as {
      order: {
        id: string;
        orderCode: string;
        status: string;
        isSignedTableSession: boolean;
        subtotalSatang: number;
      };
    };
    assert.equal(submitData.order.status, 'PENDING_CONFIRM');
    assert.equal(submitData.order.isSignedTableSession, true);
    const expectedSub =
      (sellableItem.priceSatang + (firstMod?.priceDeltaSatang ?? 0)) * 2;
    assert.equal(submitData.order.subtotalSatang, expectedSub);

    // 8. Cashier accepts order -> Merged Held Bill + Real KDS Ticket (zero financial report pollution!)
    const acceptRes = await fetch(`${posBase}/api/qr-ordering/orders/accept`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ guestOrderId: submitData.order.id }),
    });
    assert.equal(acceptRes.status, 200);
    const acceptData = (await acceptRes.json()) as {
      order: { status: string; heldBillId: string; kdsSequenceIds: number[] };
      heldBills: Array<{
        id: string;
        referenceLabel: string;
        cart: Array<{ variantId: string; quantityMilli: number; kdsDispatched?: boolean }>;
      }>;
      kdsTickets: Array<{
        kitchenOrderId: string;
        sequenceId: number;
        queueNumber: string;
        status: string;
      }>;
    };
    assert.equal(acceptData.order.status, 'ACCEPTED');
    assert.ok(acceptData.order.heldBillId);
    assert.ok(acceptData.order.kdsSequenceIds.length >= 1);

    const t04HeldBill = acceptData.heldBills.find((b) => b.referenceLabel === 'T04');
    assert.ok(t04HeldBill, 'Accepted QR order must appear in Table T04 Held Bill');
    assert.equal(t04HeldBill.cart[0]?.kdsDispatched, true);

    const kdsTicket = acceptData.kdsTickets.find(
      (t) => t.sequenceId === acceptData.order.kdsSequenceIds[0]
    );
    assert.ok(kdsTicket, 'Accepted QR order must dispatch a real KDS ticket');
    assert.ok(kdsTicket.queueNumber.includes('T04'));

    // Verify 'OPEN' KDS placeholder order does NOT leak into Recent Orders or ABB Tax Report
    const recentBeforePay = await (
      await fetch(`${posBase}/api/pos/orders`, { headers: authHeaders })
    ).json() as { orders: unknown[] };
    assert.equal(recentBeforePay.orders.length, 0);

    const reportsBeforePay = await (
      await fetch(`${posBase}/api/reports`, { headers: authHeaders })
    ).json() as { abbReport: { invoices: unknown[] } };
    assert.equal(reportsBeforePay.abbReport.invoices.length, 0);

    // 9. Kitchen bumps KDS ticket -> Customer mobile order status updates live!
    await fetch(`${posBase}/api/kds/bump`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        kitchenOrderId: kdsTicket.kitchenOrderId,
        ackedSequenceId: kdsTicket.sequenceId,
        newStatus: 'PREPARING',
      }),
    });
    const statusPrep = (await (
      await fetch(`${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}`)
    ).json()) as { order: { status: string } };
    assert.equal(statusPrep.order.status, 'PREPARING');

    await fetch(`${posBase}/api/kds/bump`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        kitchenOrderId: kdsTicket.kitchenOrderId,
        ackedSequenceId: kdsTicket.sequenceId,
        newStatus: 'READY',
      }),
    });
    const statusReady = (await (
      await fetch(`${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}`)
    ).json()) as { order: { status: string } };
    assert.equal(statusReady.order.status, 'READY');

    // 10. Cashier settles Table T04 bill (skipKdsEnqueue=true) -> No duplicate KDS ticket + T04 QR auto-revoked!
    const kdsCountBeforeCheckout = acceptData.kdsTickets.length;
    const checkoutRes = await fetch(`${posBase}/api/pos/checkout`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        orderType: 'DINE_IN',
        tableOrQueueNo: 'T04',
        paymentMethod: 'CASH',
        cashTenderedSatang: 500_000,
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        skipKdsEnqueue: true,
        lines: [
          {
            variantId: sellableItem.variantId,
            itemName: sellableItem.itemName,
            unitName: 'แก้ว',
            quantityMilli: 2_000,
            unitPriceSatang: sellableItem.priceSatang,
            selectedModifierIds: firstMod ? [firstMod.id] : [],
          },
        ],
      }),
    });
    assert.equal(checkoutRes.status, 200);
    const checkoutData = (await checkoutRes.json()) as {
      order: { receiptNumber: string; kitchenOrderSequenceId: number | null };
    };
    assert.ok(
      checkoutData.order.receiptNumber.endsWith('-000001'),
      `Expected sequential -000001 receipt number without gap, got ${checkoutData.order.receiptNumber}`
    );
    assert.equal(checkoutData.order.kitchenOrderSequenceId, null);

    const kdsAfterCheckout = (await (
      await fetch(`${posBase}/api/kds/tickets`, { headers: authHeaders })
    ).json()) as { tickets: unknown[] };
    assert.equal(kdsAfterCheckout.tickets.length, kdsCountBeforeCheckout);

    // Old T04 Signed QR token MUST now be rejected (auto-revoked on checkout!)
    const staleT04Res = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        signedToken: openT04Data.session.token,
        lines: [{ variantId: sellableItem.variantId, quantityCount: 1 }],
      }),
    });
    assert.equal(staleT04Res.status, 403);

    // 11. Walk-in Captive order Reject flow & Auto-Accept Signed Table mode
    await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        approvalMode: 'AUTO_ACCEPT_SIGNED_TABLE',
      }),
    });

    // Unsigned walk-in Captive order MUST STILL stay PENDING_CONFIRM even in Auto-Accept mode!
    const walkinRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T01',
        lines: [{ variantId: sellableItem.variantId, quantityCount: 1 }],
      }),
    });
    assert.equal(walkinRes.status, 201);
    const walkinData = (await walkinRes.json()) as { order: { id: string; status: string } };
    assert.equal(walkinData.order.status, 'PENDING_CONFIRM');

    // Reject walk-in order
    const rejectRes = await fetch(`${posBase}/api/qr-ordering/orders/reject`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        guestOrderId: walkinData.order.id,
        reason: 'โต๊ะ T01 ยังไม่ได้เปิดโต๊ะ',
      }),
    });
    assert.equal(rejectRes.status, 200);
    const rejectedStatus = (await (
      await fetch(`${guestBase}/api/guest/order-status?id=${encodeURIComponent(walkinData.order.id)}`)
    ).json()) as { order: { status: string; rejectionReason: string } };
    assert.equal(rejectedStatus.order.status, 'REJECTED');
    assert.equal(rejectedStatus.order.rejectionReason, 'โต๊ะ T01 ยังไม่ได้เปิดโต๊ะ');

    // Signed Table T05 order in AUTO_ACCEPT_SIGNED_TABLE mode auto-accepts immediately!
    const openT05 = (await (
      await fetch(`${posBase}/api/qr-ordering/table-session`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ tableLabel: 'T05' }),
      })
    ).json()) as { session: { token: string } };

    const autoAcceptRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T05',
        signedToken: openT05.session.token,
        lines: [{ variantId: sellableItem.variantId, quantityCount: 1 }],
      }),
    });
    assert.equal(autoAcceptRes.status, 201);
    const autoAcceptData = (await autoAcceptRes.json()) as {
      order: { status: string; heldBillId: string | null; kdsSequenceIds: number[] };
    };
    assert.equal(autoAcceptData.order.status, 'ACCEPTED');
    assert.ok(autoAcceptData.order.heldBillId);
    assert.ok(autoAcceptData.order.kdsSequenceIds.length >= 1);

    // 12. Per-IP Rate Limiter enforcement (guestQrRateLimitPerMinute = 6; already used 4-5)
    let hit429 = false;
    for (let i = 0; i < 6; i++) {
      const rlRes = await fetch(`${guestBase}/api/guest/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableLabel: 'T05',
          signedToken: openT05.session.token,
          lines: [{ variantId: sellableItem.variantId, quantityCount: 1 }],
        }),
      });
      if (rlRes.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, 'Guest server MUST enforce per-IP HTTP 429 rate limiting');

    // 13. Disabling QR Ordering stops the Guest LAN Server cleanly
    const disableRes = await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableRes.status, 200);
    const disableData = (await disableRes.json()) as { status: { running: boolean } };
    assert.equal(disableData.status.running, false);
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
