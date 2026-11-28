import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  buildNfcTableTagPackage,
  buildTableMenuUrl,
  buildTableNfcUrl,
  buildWifiQrPayload,
  buildWifiWscCredentialBytes,
  computeGuestOrderLineSatang,
  encodeNdefUriRecordSpec,
  NFC_CHIP_USABLE_NDEF_BYTES,
  normalizeQrOrderingConfig,
} from '../../packages/shared-contracts/src/qr-ordering.ts';
import { checkSlidingWindowBucketLimit } from '../../packages/ui-presentation/src/server/guest-qr-server.ts';
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
  assert.equal(cfg.nfcEnabled, false);
  assert.equal(cfg.nfcTagMode, 'STATIC_TABLE');
  assert.equal(cfg.nfcRecordLayout, 'URI_ONLY');
  assert.equal(cfg.nfcChipType, 'NTAG215');

  const url = buildTableMenuUrl('http://192.168.1.50:4174/', 'T04', 'abc.123');
  assert.equal(url, 'http://192.168.1.50:4174/m?t=T04&s=abc.123');

  const nfcUrl = buildTableNfcUrl('http://192.168.1.50:4174/', 'T04', 'abc.123');
  assert.equal(nfcUrl, 'http://192.168.1.50:4174/m?t=T04&s=abc.123&via=nfc');

  // NDEF URI compression (0x03 = http://) + WFA WSC Credential TLV + NTAG213/215 fit guardrails
  const uriRec = encodeNdefUriRecordSpec('http://192.168.1.50:4174/m?t=T04&via=nfc');
  assert.equal(uriRec.tnf, 0x01);
  assert.equal(uriRec.typeBytes[0], 0x55); // 'U'
  assert.equal(uriRec.payloadBytes[0], 0x03); // 'http://'

  const wscBytes = buildWifiWscCredentialBytes('RubeCafe_WiFi', 'secret2026', 'WPA');
  assert.equal(wscBytes[0], 0x10);
  assert.equal(wscBytes[1], 0x0e); // Credential TLV
  assert.ok(wscBytes.length > 40);

  const staticUriPkg = buildNfcTableTagPackage({
    baseUrl: 'http://192.168.1.50:4174',
    tableLabel: 'T04',
    config: { ...cfg, nfcEnabled: true, nfcTagMode: 'STATIC_TABLE', nfcRecordLayout: 'URI_ONLY', nfcChipType: 'NTAG213' },
  });
  assert.equal(staticUriPkg.fitsSelectedChip, true);
  assert.ok(staticUriPkg.ndefByteLength <= NFC_CHIP_USABLE_NDEF_BYTES.NTAG213);
  assert.ok(staticUriPkg.ndefType2TlvHex.startsWith('03'));
  assert.ok(staticUriPkg.ndefType2TlvHex.endsWith('FE'));

  const longComboNtag213 = buildNfcTableTagPackage({
    baseUrl: 'http://192.168.1.50:4174',
    tableLabel: 'T04',
    signedToken: '1234567890abcdef.1234567890abcdef12345678',
    config: {
      ...cfg,
      wifiSsid: 'RubeCafe_Super_Fast_5GHz_Main_Hall',
      wifiPassword: 'SuperLongWifiPasswordForGuests2026',
      wifiSecurity: 'WPA',
      nfcEnabled: true,
      nfcTagMode: 'SIGNED_SESSION',
      nfcRecordLayout: 'URI_AND_WIFI_WSC',
      nfcChipType: 'NTAG213',
    },
  });
  assert.equal(longComboNtag213.fitsSelectedChip, false);
  assert.equal(longComboNtag213.recommendedChipType, 'NTAG215');

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
        trackingToken: string;
        status: string;
        isSignedTableSession: boolean;
        subtotalSatang: number;
      };
    };
    assert.equal(submitData.order.status, 'PENDING_CONFIRM');
    assert.equal(submitData.order.isSignedTableSession, true);
    assert.ok(submitData.order.trackingToken, 'Guest order must include trackingToken');
    const expectedSub =
      (sellableItem.priceSatang + (firstMod?.priceDeltaSatang ?? 0)) * 2;
    assert.equal(submitData.order.subtotalSatang, expectedSub);

    // 7B. Guest Table Service Call (CALL_STAFF -> POS inbox -> Acknowledge, then REQUEST_BILL pending until checkout)
    const callStaffRes = await fetch(`${guestBase}/api/guest/service-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        signedToken: openT04Data.session.token,
        callType: 'CALL_STAFF',
        note: 'ขอน้ำดื่มเพิ่ม',
      }),
    });
    assert.equal(callStaffRes.status, 201);
    const callStaffData = (await callStaffRes.json()) as {
      ok: boolean;
      call: { id: string; status: string; callType: string; tableLabel: string };
    };
    assert.equal(callStaffData.ok, true);
    assert.equal(callStaffData.call.status, 'PENDING');

    const inboxBeforeAck = (await (
      await fetch(`${posBase}/api/qr-ordering/orders`, { headers: authHeaders })
    ).json()) as {
      serviceCalls: Array<{ id: string; status: string }>;
      pendingServiceCallsCount: number;
    };
    assert.equal(inboxBeforeAck.pendingServiceCallsCount, 1);
    assert.equal(inboxBeforeAck.serviceCalls[0]?.id, callStaffData.call.id);

    const ackCallRes = await fetch(`${posBase}/api/qr-ordering/service-calls/ack`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ callId: callStaffData.call.id }),
    });
    assert.equal(ackCallRes.status, 200);
    const ackCallData = (await ackCallRes.json()) as {
      ok: boolean;
      call: { status: string };
    };
    assert.equal(ackCallData.call.status, 'ACKNOWLEDGED');

    // Leave a REQUEST_BILL call pending so checkout auto-acknowledges it cleanly
    const requestBillRes = await fetch(`${guestBase}/api/guest/service-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        signedToken: openT04Data.session.token,
        callType: 'REQUEST_BILL',
      }),
    });
    assert.equal(requestBillRes.status, 201);

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

    // 9. Kitchen bumps KDS ticket -> Customer mobile order status updates live (token-gated!)
    const missingTokenStatus = await fetch(
      `${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}`
    );
    assert.equal(missingTokenStatus.status, 404, 'Order status without trackingToken MUST fail closed (404)');
    const wrongTokenStatus = await fetch(
      `${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}&token=invalid-token`
    );
    assert.equal(wrongTokenStatus.status, 404, 'Order status with wrong trackingToken MUST fail closed (404)');

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
      await fetch(
        `${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}&token=${encodeURIComponent(submitData.order.trackingToken)}`
      )
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
      await fetch(
        `${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}&token=${encodeURIComponent(submitData.order.trackingToken)}`
      )
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

    // Table T04 order MUST now report SETTLED and pending service calls MUST be auto-acknowledged
    const settledStatus = (await (
      await fetch(
        `${guestBase}/api/guest/order-status?id=${encodeURIComponent(submitData.order.id)}&token=${encodeURIComponent(submitData.order.trackingToken)}`
      )
    ).json()) as { order: { status: string; settledAtIso: string | null } };
    assert.equal(settledStatus.order.status, 'SETTLED');
    assert.ok(settledStatus.order.settledAtIso, 'Settled order must include settledAtIso timestamp');

    const inboxAfterCheckout = (await (
      await fetch(`${posBase}/api/qr-ordering/orders`, { headers: authHeaders })
    ).json()) as { pendingServiceCallsCount: number };
    assert.equal(
      inboxAfterCheckout.pendingServiceCallsCount,
      0,
      'Pending REQUEST_BILL service calls must auto-acknowledge when table checks out'
    );

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
    const walkinData = (await walkinRes.json()) as {
      order: { id: string; trackingToken: string; status: string };
    };
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
      await fetch(
        `${guestBase}/api/guest/order-status?id=${encodeURIComponent(walkinData.order.id)}&token=${encodeURIComponent(walkinData.order.trackingToken)}`
      )
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

test('Phase 8C: Guest submission idempotency (clientSubmissionKey) & mixed skipKds checkout', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-pos-phase8c-qr-'));
  const dbPath = path.join(tmpDir, 'rube_qr_e2e_8c.db');
  const guestPort = await getFreeTcpPort();

  const server = new RubePosInteractiveAppServer({
    dbPath,
    requireFirstRunWizard: false,
    enforceApiSessionAuth: true,
    guestQrRateLimitPerMinute: 20,
  });

  try {
    const { url: posBase } = await server.start(0, '127.0.0.1');
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

    const cfgRes = await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        enabled: true,
        port: guestPort,
        approvalMode: 'CASHIER_CONFIRM',
        tableLabels: ['T04'],
      }),
    });
    assert.equal(cfgRes.status, 200);
    const guestBase = `http://127.0.0.1:${guestPort}`;

    const openT04 = (await (
      await fetch(`${posBase}/api/qr-ordering/table-session`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ tableLabel: 'T04' }),
      })
    ).json()) as { session: { token: string } };

    const menu = (await (
      await fetch(`${guestBase}/api/guest/menu?t=T04&s=${encodeURIComponent(openT04.session.token)}`)
    ).json()) as {
      items: Array<{
        variantId: string;
        itemName: string;
        priceSatang: number;
        isAvailable: boolean;
        isComposite: boolean;
        kitchenStation: string;
      }>;
      modifierGroups: Array<{
        minSelections: number;
        modifiers: Array<{ id: string }>;
      }>;
    };
    const item = menu.items.find((i) => i.isAvailable && i.kitchenStation !== 'NONE')!;
    assert.ok(item, 'Expected an available kitchen-routed menu item');
    const requiredModIds = item.isComposite
      ? menu.modifierGroups
          .filter((g) => g.minSelections > 0)
          .flatMap((g) => g.modifiers.slice(0, g.minSelections).map((m) => m.id))
      : [];

    // 1. Idempotent guest order submission with clientSubmissionKey
    const payload = {
      tableLabel: 'T04',
      signedToken: openT04.session.token,
      clientSubmissionKey: 'idem-t04-phase8c-001',
      lines: [{ variantId: item.variantId, quantityCount: 1, selectedModifierIds: requiredModIds }],
    };
    const firstRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(firstRes.status, 201);
    const firstData = (await firstRes.json()) as { order: { id: string; orderCode: string } };

    const retryRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(retryRes.status, 201);
    const retryData = (await retryRes.json()) as { order: { id: string; orderCode: string } };
    assert.equal(retryData.order.id, firstData.order.id);
    assert.equal(retryData.order.orderCode, firstData.order.orderCode);

    // 2. Accept QR order -> 1 KDS ticket, then mixed checkout (line 1 skipKds: true, line 2 skipKds: false)
    const acceptRes = await fetch(`${posBase}/api/qr-ordering/orders/accept`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ guestOrderId: firstData.order.id }),
    });
    assert.equal(acceptRes.status, 200);
    const acceptData = (await acceptRes.json()) as { kdsTickets: unknown[] };
    const kdsAfterAccept = acceptData.kdsTickets.length;

    const mixedCheckoutRes = await fetch(`${posBase}/api/pos/checkout`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        orderType: 'DINE_IN',
        tableOrQueueNo: 'T04',
        paymentMethod: 'CASH',
        cashTenderedSatang: 500_000,
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        lines: [
          {
            variantId: item.variantId,
            itemName: item.itemName,
            unitName: 'แก้ว',
            quantityMilli: 1_000,
            unitPriceSatang: item.priceSatang,
            selectedModifierIds: requiredModIds,
            skipKds: true,
          },
          {
            variantId: item.variantId,
            itemName: item.itemName,
            unitName: 'แก้ว',
            quantityMilli: 1_000,
            unitPriceSatang: item.priceSatang,
            selectedModifierIds: requiredModIds,
            skipKds: false,
            notes: 'แยกน้ำแข็ง',
          },
        ],
      }),
    });
    assert.equal(mixedCheckoutRes.status, 200);
    const kdsAfterMixed = (await (
      await fetch(`${posBase}/api/kds/tickets`, { headers: authHeaders })
    ).json()) as {
      tickets: Array<{
        sequenceId: number;
        items: Array<{ itemSummaryText: string; modifiersSummaryText: string | null }>;
      }>;
    };
    assert.equal(
      kdsAfterMixed.tickets.length,
      kdsAfterAccept + 1,
      'Mixed checkout must enqueue KDS ONLY for lines without skipKds: true'
    );
    const latestTicket = kdsAfterMixed.tickets[kdsAfterMixed.tickets.length - 1]!;
    assert.equal(
      latestTicket.items.length,
      1,
      'Skipped QR line must not be re-added to checkout KDS ticket'
    );
    assert.ok(
      (latestTicket.items[0]?.modifiersSummaryText ?? '').includes('แยกน้ำแข็ง'),
      'Counter line note must appear on KDS ticket'
    );
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8D: Unit test — Sliding-window rate limiter burst behavior, non-extending rejections, window reset & FIFO eviction', () => {
  const buckets = new Map<string, number[]>();
  const ipA = '192.168.1.25';
  const ipB = '192.168.1.26';
  const windowMs = 60_000;
  const maxPerWindow = 4;

  // 1. Burst of 10 calls at the exact same millisecond: first 4 allowed, next 6 blocked
  const burstResults = Array.from({ length: 10 }, () =>
    checkSlidingWindowBucketLimit(buckets, ipA, maxPerWindow, {
      nowMs: 1_000_000,
      windowMs,
    })
  );
  assert.deepEqual(burstResults, [true, true, true, true, false, false, false, false, false, false]);
  assert.equal(buckets.get(ipA)?.length, 4);

  // 2. Retry burst mid-window must stay blocked and MUST NOT extend lockout timestamps
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      checkSlidingWindowBucketLimit(buckets, ipA, maxPerWindow, {
        nowMs: 1_030_000,
        windowMs,
      }),
      false
    );
  }
  assert.deepEqual(buckets.get(ipA), [1_000_000, 1_000_000, 1_000_000, 1_000_000]);

  // 3. Another client IP stays completely independent
  assert.equal(
    checkSlidingWindowBucketLimit(buckets, ipB, maxPerWindow, {
      nowMs: 1_030_000,
      windowMs,
    }),
    true
  );

  // 4. Boundary: 1ms before reset is still blocked; exact windowMs reset reopens full burst quota
  assert.equal(
    checkSlidingWindowBucketLimit(buckets, ipA, maxPerWindow, {
      nowMs: 1_059_999,
      windowMs,
    }),
    false
  );
  const afterResetResults = Array.from({ length: 5 }, () =>
    checkSlidingWindowBucketLimit(buckets, ipA, maxPerWindow, {
      nowMs: 1_060_000,
      windowMs,
    })
  );
  assert.deepEqual(afterResetResults, [true, true, true, true, false]);

  // 5. Staggered sliding-window partial reset
  const staggered = new Map<string, number[]>();
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 10_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 10_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 40_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 40_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 40_000, windowMs }), false);

  // At t=70_000: the 2 entries from t=10_000 expire, opening 2 slots while t=40_000 remain active
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 70_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 70_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 70_000, windowMs }), false);

  // At t=100_000: the 2 entries from t=40_000 expire, opening 2 more slots
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 100_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 100_000, windowMs }), true);
  assert.equal(checkSlidingWindowBucketLimit(staggered, ipA, 4, { nowMs: 100_000, windowMs }), false);

  // 6. Bounded FIFO key eviction prevents unbounded memory growth under IP flooding
  const bounded = new Map<string, number[]>();
  for (let i = 1; i <= 505; i += 1) {
    assert.equal(
      checkSlidingWindowBucketLimit(bounded, `10.0.0.${i}`, 2, {
        nowMs: 2_000_000,
        windowMs,
        maxTrackedKeys: 500,
      }),
      true
    );
  }
  assert.equal(bounded.size, 500);
  assert.equal(bounded.has('10.0.0.1'), false);
  assert.equal(bounded.has('10.0.0.5'), false);
  assert.equal(bounded.has('10.0.0.6'), true);
  assert.equal(bounded.has('10.0.0.505'), true);
});

test('Phase 8E: Concurrent HTTP burst (Promise.all) & clock-driven time-window reset on Guest LAN Server', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-pos-phase8e-burst-'));
  const dbPath = path.join(tmpDir, 'rube_qr_burst_e2e.db');
  const guestPort = await getFreeTcpPort();
  let fakeNowMs = 1_700_000_000_000;

  const server = new RubePosInteractiveAppServer({
    dbPath,
    requireFirstRunWizard: false,
    enforceApiSessionAuth: true,
    guestQrRateLimitPerMinute: 4,
    guestQrRateLimitWindowMs: 60_000,
    guestQrNowProvider: () => fakeNowMs,
  });

  try {
    const { url: posBase } = await server.start(0, '127.0.0.1');
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

    const cfgRes = await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        enabled: true,
        port: guestPort,
        approvalMode: 'CASHIER_CONFIRM',
        tableLabels: ['T04'],
      }),
    });
    assert.equal(cfgRes.status, 200);
    const guestBase = `http://127.0.0.1:${guestPort}`;

    const openT04 = (await (
      await fetch(`${posBase}/api/qr-ordering/table-session`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ tableLabel: 'T04' }),
      })
    ).json()) as { session: { token: string } };

    const menu = (await (
      await fetch(`${guestBase}/api/guest/menu?t=T04&s=${encodeURIComponent(openT04.session.token)}`)
    ).json()) as {
      items: Array<{
        variantId: string;
        isAvailable: boolean;
        isComposite: boolean;
      }>;
      modifierGroups: Array<{
        minSelections: number;
        modifiers: Array<{ id: string }>;
      }>;
    };
    const item = menu.items.find((i) => i.isAvailable)!;
    assert.ok(item);
    const requiredModIds = item.isComposite
      ? menu.modifierGroups
          .filter((g) => g.minSelections > 0)
          .flatMap((g) => g.modifiers.slice(0, g.minSelections).map((m) => m.id))
      : [];

    const submitOrder = (key: string) =>
      fetch(`${guestBase}/api/guest/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableLabel: 'T04',
          signedToken: openT04.session.token,
          clientSubmissionKey: key,
          lines: [{ variantId: item.variantId, quantityCount: 1, selectedModifierIds: requiredModIds }],
        }),
      });

    // 1. Fire 10 simultaneous guest order requests via Promise.all -> exactly 4 succeed (201) & 6 get 429
    const burst1 = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => submitOrder(`burst1-${idx}`))
    );
    const burst1Statuses = burst1.map((r) => r.status);
    assert.equal(burst1Statuses.filter((s) => s === 201).length, 4);
    assert.equal(burst1Statuses.filter((s) => s === 429).length, 6);

    // 2. Just before 60s expiry (+59_999ms): rejected requests must not extend window, all 3 still 429
    fakeNowMs += 59_999;
    const preReset = await Promise.all(
      Array.from({ length: 3 }, (_, idx) => submitOrder(`prereset-${idx}`))
    );
    assert.deepEqual(
      preReset.map((r) => r.status),
      [429, 429, 429]
    );

    // 3. Exact 60s window reset (+1ms -> +60_000ms): full 4-request quota resets; 6 concurrent -> 4x201 + 2x429
    fakeNowMs += 1;
    const postReset = await Promise.all(
      Array.from({ length: 6 }, (_, idx) => submitOrder(`postreset-${idx}`))
    );
    const postResetStatuses = postReset.map((r) => r.status);
    assert.equal(postResetStatuses.filter((s) => s === 201).length, 4);
    assert.equal(postResetStatuses.filter((s) => s === 429).length, 2);

    // 4. Service-call bucket concurrent burst (Promise.all x6 -> 4x201 + 2x429) & window reset recovery
    const callBurst = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        fetch(`${guestBase}/api/guest/service-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tableLabel: 'T04',
            signedToken: openT04.session.token,
            callType: idx % 2 === 0 ? 'CALL_STAFF' : 'REQUEST_BILL',
          }),
        })
      )
    );
    const callBurstStatuses = callBurst.map((r) => r.status);
    assert.equal(callBurstStatuses.filter((s) => s === 201).length, 4);
    assert.equal(callBurstStatuses.filter((s) => s === 429).length, 2);

    fakeNowMs += 60_000;
    const afterCallReset = await fetch(`${guestBase}/api/guest/service-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        signedToken: openT04.session.token,
        callType: 'CALL_STAFF',
      }),
    });
    assert.equal(afterCallReset.status, 201);
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8F: Full E2E NFC Tag Table Ordering (NDEF URI + WFA WSC, Zero-Trust Isolation, &via=nfc Entry Tracking, Signed Rotation & Held Bill + KDS)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-pos-phase8f-nfc-'));
  const dbPath = path.join(tmpDir, 'rube_nfc_e2e.db');
  const guestPort = await getFreeTcpPort();

  const server = new RubePosInteractiveAppServer({
    dbPath,
    requireFirstRunWizard: false,
    enforceApiSessionAuth: true,
  });

  try {
    const { url: posBase } = await server.start(0, '127.0.0.1');
    const loginRes = await fetch(`${posBase}/api/auth/pin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '999999', userId: 'USR-OWNER-01' }),
    });
    assert.equal(loginRes.status, 200);
    const { sessionToken } = (await loginRes.json()) as { sessionToken: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    };

    // 1. Enable Guest LAN Server + NFC Ordering (Combo URI + Wi-Fi WSC on NTAG215)
    const cfgRes = await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        enabled: true,
        port: guestPort,
        wifiSsid: 'RubeCafe_NFC_5G',
        wifiPassword: 'nfcpass2026',
        wifiSecurity: 'WPA',
        approvalMode: 'CASHIER_CONFIRM',
        allowOpenTableSelection: true,
        tableLabels: ['T01', 'T04'],
        nfcEnabled: true,
        nfcTagMode: 'STATIC_TABLE',
        nfcRecordLayout: 'URI_AND_WIFI_WSC',
        nfcChipType: 'NTAG215',
      }),
    });
    assert.equal(cfgRes.status, 200);

    const guestBase = `http://127.0.0.1:${guestPort}`;

    // 2. Zero-Trust Isolation: Guest Port 4174 MUST reject /api/qr-ordering/nfc-tags with 403
    const isolatedNfcRes = await fetch(`${guestBase}/api/qr-ordering/nfc-tags`);
    assert.equal(isolatedNfcRes.status, 403);

    // 3. Authenticated POS Loopback Port 4173 returns NFC tag packages & WFA WSC payload
    const nfcTagsRes = await fetch(`${posBase}/api/qr-ordering/nfc-tags`, { headers: authHeaders });
    assert.equal(nfcTagsRes.status, 200);
    const nfcTagsData = (await nfcTagsRes.json()) as {
      wifiOnlyWscBase64: string | null;
      tags: Array<{
        tableLabel: string;
        recordLayout: string;
        chipType: string;
        fitsSelectedChip: boolean;
        ndefByteLength: number;
        menuUrl: string;
        wscBase64: string | null;
      }>;
    };
    assert.ok(nfcTagsData.wifiOnlyWscBase64);
    assert.equal(nfcTagsData.tags.length, 2);
    const t04Tag = nfcTagsData.tags.find((t) => t.tableLabel === 'T04')!;
    assert.ok(t04Tag);
    assert.equal(t04Tag.recordLayout, 'URI_AND_WIFI_WSC');
    assert.equal(t04Tag.chipType, 'NTAG215');
    assert.equal(t04Tag.fitsSelectedChip, true);
    assert.ok(t04Tag.menuUrl.includes('t=T04'));
    assert.ok(t04Tag.menuUrl.includes('via=nfc'));
    assert.ok(t04Tag.wscBase64);

    // 4. Guest taps Static NFC tag -> opens HTML & menu API without leaking Wi-Fi password
    const htmlRes = await fetch(`${guestBase}/m?t=T04&via=nfc`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('"entryChannel":"NFC"'));
    assert.ok(!html.includes('nfcpass2026'), 'Guest HTML must never leak Wi-Fi passphrase');

    const menuRes = await fetch(`${guestBase}/api/guest/menu?t=T04&via=nfc`);
    assert.equal(menuRes.status, 200);
    const menuText = await menuRes.text();
    assert.ok(!menuText.includes('nfcpass2026'), 'Guest menu API must never leak Wi-Fi passphrase');
    const menu = JSON.parse(menuText) as {
      nfcEnabled: boolean;
      entryChannel: string;
      items: Array<{ variantId: string; isAvailable: boolean; isComposite: boolean }>;
      modifierGroups: Array<{ minSelections: number; modifiers: Array<{ id: string }> }>;
    };
    assert.equal(menu.nfcEnabled, true);
    assert.equal(menu.entryChannel, 'NFC');
    const sellable = menu.items.find((i) => i.isAvailable)!;
    const reqMods = sellable.isComposite
      ? menu.modifierGroups
          .filter((g) => g.minSelections > 0)
          .flatMap((g) => g.modifiers.slice(0, g.minSelections).map((m) => m.id))
      : [];

    // 5. Submit guest order & service call tagged with entryChannel: NFC
    const orderRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        entryChannel: 'NFC',
        customerName: 'NFC Guest',
        lines: [{ variantId: sellable.variantId, quantityCount: 1, selectedModifierIds: reqMods }],
      }),
    });
    assert.equal(orderRes.status, 201);
    const orderData = (await orderRes.json()) as {
      order: { id: string; status: string; entryChannel: string; isSignedTableSession: boolean };
    };
    assert.equal(orderData.order.entryChannel, 'NFC');
    assert.equal(orderData.order.status, 'PENDING_CONFIRM');
    assert.equal(orderData.order.isSignedTableSession, false);

    const callRes = await fetch(`${guestBase}/api/guest/service-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableLabel: 'T04',
        callType: 'REQUEST_BILL',
        entryChannel: 'NFC',
      }),
    });
    assert.equal(callRes.status, 201);
    const callData = (await callRes.json()) as { call: { entryChannel: string; callType: string } };
    assert.equal(callData.call.entryChannel, 'NFC');

    // Verify POS inbox preserves NFC channel tag and can accept into Held Bill + KDS cleanly
    const inboxData = (await (
      await fetch(`${posBase}/api/qr-ordering/orders`, { headers: authHeaders })
    ).json()) as {
      orders: Array<{ id: string; entryChannel: string }>;
      serviceCalls: Array<{ tableLabel: string; entryChannel: string }>;
    };
    assert.equal(inboxData.orders.find((o) => o.id === orderData.order.id)?.entryChannel, 'NFC');
    assert.equal(inboxData.serviceCalls.find((c) => c.tableLabel === 'T04')?.entryChannel, 'NFC');

    const acceptRes = await fetch(`${posBase}/api/qr-ordering/orders/accept`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ guestOrderId: orderData.order.id }),
    });
    assert.equal(acceptRes.status, 200);

    // 6. Signed Table Session exposes nfcMenuUrl with token & ?via=nfc when rotated
    const openT04 = (await (
      await fetch(`${posBase}/api/qr-ordering/table-session`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ tableLabel: 'T04' }),
      })
    ).json()) as { session: { menuUrl: string; nfcMenuUrl: string; token: string } };
    assert.ok(openT04.session.nfcMenuUrl.includes('via=nfc'));
    assert.ok(openT04.session.nfcMenuUrl.includes(`s=${encodeURIComponent(openT04.session.token)}`));
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
