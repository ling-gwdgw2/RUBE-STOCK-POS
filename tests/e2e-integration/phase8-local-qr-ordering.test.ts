import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as vm from 'node:vm';
import {
  buildNfcTableTagPackage,
  buildTableMenuUrl,
  buildTableNfcUrl,
  buildWifiQrPayload,
  buildWifiWscCredentialBytes,
  computeGuestOrderLineSatang,
  DEFAULT_QR_ORDERING_CONFIG,
  encodeNdefMessageBytes,
  encodeNdefUriRecordSpec,
  NFC_CHIP_USABLE_NDEF_BYTES,
  normalizeQrOrderingConfig,
  sanitizeHostOverride,
  wrapNdefInType2TlvBytes,
} from '../../packages/shared-contracts/src/qr-ordering.ts';
import {
  openA4TableQrPrintWindow,
  renderA4TableQrCardsHtml,
} from '../../packages/ui-presentation/src/app/utils/a4-qr-sheet-printer.ts';
import {
  buildUtf8BomCsvContent,
  escapeCsvCell,
} from '../../packages/ui-presentation/src/app/utils/csv-exporter.ts';
import {
  buildWebNfcRecordsFromPackage,
  isWebNfcSupported,
  writeNfcPackageViaBrowserReader,
} from '../../packages/ui-presentation/src/app/utils/web-nfc-writer.ts';
import { renderGuestMenuHtml } from '../../packages/ui-presentation/src/server/guest-menu-html.ts';
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

function parseWscTlvs(buf: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  assert.equal(buf[0], 0x10);
  assert.equal(buf[1], 0x0e);
  const innerLen = (buf[2]! << 8) | buf[3]!;
  assert.equal(innerLen + 4, buf.length);
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const tag = (buf[pos]! << 8) | buf[pos + 1]!;
    const len = (buf[pos + 2]! << 8) | buf[pos + 3]!;
    pos += 4;
    out.set(tag, buf.slice(pos, pos + len));
    pos += len;
  }
  assert.equal(pos, buf.length);
  return out;
}

test('Phase 8G: Unit tests — UTF-8 boundary WSC truncation, WPA key guard, case-insensitive NDEF URI, SR=0 long NDEF, :port strip & formula-safe CSV', () => {
  // 1. UTF-8 whole-character boundary truncation for multi-byte Lao & Thai SSID (<=32B) and Password (<=64B)
  const longLaoSsid = 'ຮ້ານກາເຟລາວສະບາຍດີທຸກຄົນ'; // 24 Lao chars (3B each = 72B)
  const longThaiPass = 'รหัสผ่านไวไฟร้านกาแฟรูบสต็อกพส'; // 30 Thai chars (3B each = 90B)
  const wscUtf8 = buildWifiWscCredentialBytes(longLaoSsid, longThaiPass, 'WPA');
  assert.ok(wscUtf8.length > 0);
  const tlvs = parseWscTlvs(wscUtf8);
  const ssidBytes = tlvs.get(0x1045)!;
  const passBytes = tlvs.get(0x1027)!;
  assert.ok(ssidBytes.length <= 32, `SSID bytes ${ssidBytes.length} must be <= 32`);
  assert.ok(passBytes.length <= 64, `Password bytes ${passBytes.length} must be <= 64`);
  const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
  const decodedSsid = utf8Fatal.decode(ssidBytes);
  const decodedPass = utf8Fatal.decode(passBytes);
  assert.ok(longLaoSsid.startsWith(decodedSsid));
  assert.ok(longThaiPass.startsWith(decodedPass));

  // 2. WPA requires non-empty >= 8-char key; empty or short returns empty Uint8Array(0) & triggers URI_ONLY fallback
  assert.equal(buildWifiWscCredentialBytes('RubeCafe', '', 'WPA').length, 0);
  assert.equal(buildWifiWscCredentialBytes('RubeCafe', '1234567', 'WPA').length, 0);
  assert.equal(buildWifiWscCredentialBytes('RubeCafe', 'กขค', 'WPA').length, 0);
  const minWpa = buildWifiWscCredentialBytes('RubeCafe', '12345678', 'WPA');
  assert.ok(minWpa.length > 0);
  assert.equal(parseWscTlvs(minWpa).get(0x1027)?.length, 8);

  // NOPASS allows empty password with Auth=0x0001 / Enc=0x0001
  const openWsc = buildWifiWscCredentialBytes('RubeCafe_Open', '', 'NOPASS');
  assert.ok(openWsc.length > 0);
  const openTlvs = parseWscTlvs(openWsc);
  assert.deepEqual(Array.from(openTlvs.get(0x1003)!), [0x00, 0x01]);
  assert.equal(openTlvs.has(0x1027), false);

  const fallbackPkg = buildNfcTableTagPackage({
    baseUrl: 'http://192.168.1.50:4174',
    tableLabel: 'T04',
    config: {
      ...DEFAULT_QR_ORDERING_CONFIG,
      wifiSsid: 'RubeCafe',
      wifiPassword: 'short',
      wifiSecurity: 'WPA',
      nfcEnabled: true,
      nfcRecordLayout: 'WIFI_WSC_ONLY',
    },
  });
  assert.equal(fallbackPkg.wscBase64, null);
  assert.equal(fallbackPkg.recordLayout, 'URI_ONLY');

  // 3. Case-insensitive HTTP/HTTPS/www prefix compression preserving path & query casing
  const u1 = encodeNdefUriRecordSpec('HTTP://WWW.Example.COM/Menu?t=T04&s=AbCdEf');
  assert.equal(u1.payloadBytes[0], 0x01);
  assert.equal(new TextDecoder().decode(u1.payloadBytes.slice(1)), 'Example.COM/Menu?t=T04&s=AbCdEf');

  const u2 = encodeNdefUriRecordSpec('HTTPS://WWW.Example.COM/M?X=y');
  assert.equal(u2.payloadBytes[0], 0x02);
  assert.equal(new TextDecoder().decode(u2.payloadBytes.slice(1)), 'Example.COM/M?X=y');

  const u3 = encodeNdefUriRecordSpec('HTTP://192.168.1.50:4174/m?t=T04&via=nfc');
  assert.equal(u3.payloadBytes[0], 0x03);
  assert.equal(new TextDecoder().decode(u3.payloadBytes.slice(1)), '192.168.1.50:4174/m?t=T04&via=nfc');

  const u4 = encodeNdefUriRecordSpec('HTTPS://Shop.Local/Order?Token=XyZ');
  assert.equal(u4.payloadBytes[0], 0x04);
  assert.equal(new TextDecoder().decode(u4.payloadBytes.slice(1)), 'Shop.Local/Order?Token=XyZ');

  // 4. Long NDEF record (>255 bytes) sets SR=0 and uses 3-byte Type 2 TLV length (0x03 0xFF hi lo)
  const longPayload = new Uint8Array(300).fill(0x41);
  const longNdef = encodeNdefMessageBytes([
    { tnf: 0x02, typeBytes: new TextEncoder().encode('text/plain'), payloadBytes: longPayload },
  ]);
  assert.equal((longNdef[0]! & 0x10) === 0, true, 'SR bit must be 0 when payload > 255 bytes');
  assert.equal(longNdef[1], 10);
  const len32 =
    ((longNdef[2]! << 24) | (longNdef[3]! << 16) | (longNdef[4]! << 8) | longNdef[5]!) >>> 0;
  assert.equal(len32, 300);
  const longTlv = wrapNdefInType2TlvBytes(longNdef);
  assert.equal(longTlv[0], 0x03);
  assert.equal(longTlv[1], 0xff);
  assert.equal((longTlv[2]! << 8) | longTlv[3]!, longNdef.length);
  assert.equal(longTlv[longTlv.length - 1], 0xfe);

  // 5. sanitizeHostOverride / normalizeQrOrderingConfig strips :port, query & hash while preserving/bracketing IPv6
  assert.equal(sanitizeHostOverride('http://192.168.1.88:4174/m?t=T01'), '192.168.1.88');
  assert.equal(sanitizeHostOverride('192.168.1.88:4174?t=T01#top'), '192.168.1.88');
  assert.equal(sanitizeHostOverride('192.168.1.88:abc'), '192.168.1.88');
  assert.equal(sanitizeHostOverride('pos.local:8080'), 'pos.local');
  assert.equal(sanitizeHostOverride('[::1]:4174'), '[::1]');
  assert.equal(sanitizeHostOverride('::1'), '[::1]');
  assert.equal(
    sanitizeHostOverride('https://my-pos-terminal-01.local:4174/m?t=T01&via=nfc'),
    'my-pos-terminal-01.local'
  );
  assert.equal(buildTableMenuUrl('  http://192.168.1.88:4174/ ', 'T04'), 'http://192.168.1.88:4174/m?t=T04');
  const normHostCfg = normalizeQrOrderingConfig({
    customHostOverride: 'https://192.168.10.22:4174/menu',
  });
  assert.equal(normHostCfg.customHostOverride, '192.168.10.22');

  // 6. UTF-8 BOM + formula-safe CSV quoting
  assert.equal(escapeCsvCell('=CMD("calc")'), `"'=CMD(""calc"")"`);
  assert.equal(escapeCsvCell('+1+1'), "'+1+1");
  assert.equal(escapeCsvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeCsvCell('-CMD()'), "'-CMD()");
  assert.equal(escapeCsvCell('-50.00'), '-50.00');
  const csv = buildUtf8BomCsvContent(['col1', 'col2'], [['=HYPERLINK("x")', '-125.50']]);
  assert.ok(csv.startsWith('\uFEFFcol1,col2\r\n'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('-125.50'));
});

test('Phase 8H: Unit tests — web-nfc-writer.ts (support check, NDEF records, capacity reject, timeout AbortError localization, external AbortSignal)', async () => {
  const g = globalThis as unknown as {
    window?: Record<string, unknown> | undefined;
    NDEFReader?: unknown;
  };
  const hadWindow = Object.prototype.hasOwnProperty.call(g, 'window');
  const prevWindow = g.window;
  const hadNdef = Object.prototype.hasOwnProperty.call(g, 'NDEFReader');
  const prevNdef = g.NDEFReader;

  try {
    delete g.window;
    delete g.NDEFReader;
    assert.equal(isWebNfcSupported(), false);

    const cfg: typeof DEFAULT_QR_ORDERING_CONFIG = {
      ...DEFAULT_QR_ORDERING_CONFIG,
      wifiSsid: 'RubeCafe_5G',
      wifiPassword: 'password123',
      wifiSecurity: 'WPA',
      nfcEnabled: true,
      nfcTagMode: 'STATIC_TABLE',
      nfcRecordLayout: 'URI_AND_WIFI_WSC',
      nfcChipType: 'NTAG215',
    };
    const comboPkg = buildNfcTableTagPackage({
      baseUrl: 'http://192.168.1.50:4174',
      tableLabel: 'T04',
      config: cfg,
    });
    const uriOnlyPkg = buildNfcTableTagPackage({
      baseUrl: 'http://192.168.1.50:4174',
      tableLabel: 'T04',
      config: { ...cfg, nfcRecordLayout: 'URI_ONLY' },
    });
    const wscOnlyPkg = buildNfcTableTagPackage({
      baseUrl: 'http://192.168.1.50:4174',
      tableLabel: 'T04',
      config: { ...cfg, nfcRecordLayout: 'WIFI_WSC_ONLY' },
    });

    assert.deepEqual(buildWebNfcRecordsFromPackage(uriOnlyPkg), [
      { recordType: 'url', data: uriOnlyPkg.menuUrl },
    ]);
    const wscRecords = buildWebNfcRecordsFromPackage(wscOnlyPkg);
    assert.equal(wscRecords.length, 1);
    assert.equal(wscRecords[0]?.recordType, 'mime');
    assert.equal(wscRecords[0]?.mediaType, 'application/vnd.wfa.wsc');
    assert.ok(wscRecords[0]?.data instanceof ArrayBuffer);
    assert.equal(
      Buffer.from(wscRecords[0].data as ArrayBuffer).toString('base64'),
      wscOnlyPkg.wscBase64
    );
    const comboRecords = buildWebNfcRecordsFromPackage(comboPkg);
    assert.equal(comboRecords.length, 2);
    assert.equal(comboRecords[0]?.recordType, 'url');
    assert.equal(comboRecords[1]?.recordType, 'mime');

    // Unsupported browser error
    await assert.rejects(() => writeNfcPackageViaBrowserReader(comboPkg), /ไม่รองรับ Web NFC/);

    // Mock window.NDEFReader
    let lastWriteCall = null as {
      records: unknown[];
      options?: { overwrite?: boolean; signal?: AbortSignal };
    } | null;
    let mockMode: 'OK' | 'TIMEOUT_ABORT_ERROR' | 'EXTERNAL_ABORT' = 'OK';

    class MockNdefReader {
      async write(
        message: { records: unknown[] },
        options?: { overwrite?: boolean; signal?: AbortSignal }
      ): Promise<void> {
        lastWriteCall = { records: message.records, ...(options ? { options } : {}) };
        if (mockMode === 'OK') {
          return;
        }
        return new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true }
          );
        });
      }
    }

    g.window = { NDEFReader: MockNdefReader };
    assert.equal(isWebNfcSupported(), true);

    // 1. Successful write
    const okRes = await writeNfcPackageViaBrowserReader(comboPkg);
    assert.equal(okRes.recordsCount, 2);
    assert.equal(okRes.ndefByteLength, comboPkg.ndefByteLength);
    assert.equal(lastWriteCall?.options?.overwrite, true);
    assert.ok(lastWriteCall?.options?.signal instanceof AbortSignal);

    // 2. Capacity reject before touching reader
    const overflowPkg = { ...comboPkg, fitsSelectedChip: false, chipType: 'NTAG213' as const, chipCapacityBytes: 137 };
    await assert.rejects(() => writeNfcPackageViaBrowserReader(overflowPkg), /ใหญ่เกินความจุชิป NTAG213/);

    // 3. Timeout AbortError localization
    mockMode = 'TIMEOUT_ABORT_ERROR';
    await assert.rejects(
      () => writeNfcPackageViaBrowserReader(comboPkg, 30),
      /หมดเวลาแตะแท็ก NFC/
    );

    // 4. Pre-aborted external AbortSignal
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => writeNfcPackageViaBrowserReader(comboPkg, 5_000, preAborted.signal),
      /ยกเลิกการเขียนแท็ก NFC แล้ว/
    );

    // 5. Mid-flight external AbortSignal (modal close / unmount cleanup)
    mockMode = 'EXTERNAL_ABORT';
    const extController = new AbortController();
    const pendingWrite = writeNfcPackageViaBrowserReader(comboPkg, 10_000, extController.signal);
    setTimeout(() => extController.abort(), 25);
    await assert.rejects(() => pendingWrite, /ยกเลิกการเขียนแท็ก NFC แล้ว/);

    // 6. globalThis.NDEFReader + globalThis.atob works even when window is absent; insecure context returns false
    delete g.window;
    g.NDEFReader = MockNdefReader;
    mockMode = 'OK';
    assert.equal(isWebNfcSupported(), true);
    const globalRes = await writeNfcPackageViaBrowserReader(comboPkg);
    assert.equal(globalRes.recordsCount, 2);

    g.window = { NDEFReader: MockNdefReader, isSecureContext: false };
    assert.equal(isWebNfcSupported(), false);

    delete g.window;
    const hadSecureCtx = Object.prototype.hasOwnProperty.call(g, 'isSecureContext');
    const prevSecureCtx = (g as { isSecureContext?: boolean }).isSecureContext;
    try {
      (g as { isSecureContext?: boolean }).isSecureContext = false;
      assert.equal(isWebNfcSupported(), false);
    } finally {
      if (hadSecureCtx) (g as { isSecureContext?: boolean }).isSecureContext = prevSecureCtx;
      else delete (g as { isSecureContext?: boolean }).isSecureContext;
    }

    // 7. Missing globalThis.atob throws explicit error when decoding WSC base64
    const prevAtob = globalThis.atob;
    try {
      Object.defineProperty(globalThis, 'atob', { value: undefined, configurable: true, writable: true });
      assert.throws(() => buildWebNfcRecordsFromPackage(wscOnlyPkg), /globalThis\.atob/);
    } finally {
      Object.defineProperty(globalThis, 'atob', { value: prevAtob, configurable: true, writable: true });
    }
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadNdef) g.NDEFReader = prevNdef;
    else delete g.NDEFReader;
  }
});

test('Phase 8I: Unit tests — a4-qr-sheet-printer.ts (lo/th/en, XSS escaping, nfcEnabled=false, outletId propagation, overflow & WIFI_WSC_ONLY hints)', async () => {
  const baseCfg = {
    ...DEFAULT_QR_ORDERING_CONFIG,
    enabled: true,
    wifiSsid: 'Rube<script>alert(1)</script>',
    wifiPassword: 'pass"1234',
    wifiSecurity: 'WPA' as const,
    tableLabels: ['T01', 'T04<img src=x onerror=alert(2)>'],
    nfcEnabled: true,
    nfcTagMode: 'STATIC_TABLE' as const,
    nfcRecordLayout: 'URI_ONLY' as const,
    nfcChipType: 'NTAG213' as const,
  };

  // 1. Multi-outlet & XSS escaping across th / lo / en
  const htmlTh = await renderA4TableQrCardsHtml({
    outletId: 'OUTLET-BR-02',
    storeName: 'Rube <script>evil()</script> Cafe',
    locale: 'th',
    baseUrl: 'http://192.168.1.50:4174',
    config: baseCfg,
    activeSessions: [],
  });
  assert.ok(!htmlTh.includes('<script>evil()</script>'));
  assert.ok(!htmlTh.includes('<script>alert(1)</script>'));
  assert.ok(!htmlTh.includes('<img src=x onerror=alert(2)>'));
  assert.ok(htmlTh.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  assert.ok(htmlTh.includes('o=OUTLET-BR-02'), 'Multi-outlet &o= must propagate to static A4 QR cards');
  assert.ok(htmlTh.includes('class="nfc-zone"'));

  const htmlLo = await renderA4TableQrCardsHtml({
    outletId: 'OUTLET-HQ',
    storeName: 'ຮ້ານກາເຟລາວ',
    locale: 'lo',
    baseUrl: 'http://192.168.1.50:4174',
    config: baseCfg,
    activeSessions: [],
  });
  assert.ok(htmlLo.includes('<html lang="lo">'));
  assert.ok(htmlLo.includes('ປ້າຍ QR ຕັ້ງໂຕະ (A4)'));

  const htmlEn = await renderA4TableQrCardsHtml({
    outletId: 'OUTLET-HQ',
    storeName: 'Rube Cafe',
    locale: 'en',
    baseUrl: 'http://192.168.1.50:4174',
    config: baseCfg,
    activeSessions: [],
  });
  assert.ok(htmlEn.includes('<html lang="en">'));
  assert.ok(htmlEn.includes('Printable Table QR Cards (A4)'));

  // 2. nfcEnabled: false omits .nfc-zone elements completely
  const noNfcHtml = await renderA4TableQrCardsHtml({
    storeName: 'Rube Cafe',
    locale: 'en',
    baseUrl: 'http://192.168.1.50:4174',
    config: { ...baseCfg, nfcEnabled: false },
    activeSessions: [],
  });
  assert.ok(!noNfcHtml.includes('class="nfc-zone'));

  // 3. Overflow warning when !nfcPkg.fitsSelectedChip (long combo on NTAG213)
  const overflowHtml = await renderA4TableQrCardsHtml({
    outletId: 'OUTLET-BR-02',
    storeName: 'Rube Cafe',
    locale: 'en',
    baseUrl: 'http://192.168.1.50:4174',
    config: {
      ...baseCfg,
      wifiSsid: 'RubeCafe_Super_Long_Guest_WiFi_SSID',
      wifiPassword: 'SuperLongWifiPassword2026',
      tableLabels: ['T04'],
      nfcRecordLayout: 'URI_AND_WIFI_WSC',
      nfcChipType: 'NTAG213',
    },
    activeSessions: [],
  });
  assert.ok(overflowHtml.includes('nfc-zone-overflow'));
  assert.ok(overflowHtml.includes('Exceeds chip capacity NTAG213'));
  assert.ok(overflowHtml.includes('Recommend NTAG215'));

  // 4. WIFI_WSC_ONLY adjusts iPhone hint text
  const wscOnlyHtml = await renderA4TableQrCardsHtml({
    storeName: 'Rube Cafe',
    locale: 'en',
    baseUrl: 'http://192.168.1.50:4174',
    config: {
      ...baseCfg,
      wifiSsid: 'RubeCafe_5G',
      wifiPassword: 'password123',
      tableLabels: ['T04'],
      nfcRecordLayout: 'WIFI_WSC_ONLY',
      nfcChipType: 'NTAG215',
    },
    activeSessions: [],
  });
  assert.ok(wscOnlyHtml.includes('TAP NFC TO JOIN WI-FI (Android)'));
  assert.ok(wscOnlyHtml.includes('Does not read Wi-Fi WSC NFC'));

  // 4b. Active session card uses live input.baseUrl and outletId overrides consistently
  const liveOverrideActiveHtml = await renderA4TableQrCardsHtml({
    outletId: 'OUTLET-BR-02',
    storeName: 'Rube Cafe',
    locale: 'en',
    baseUrl: 'http://10.0.0.88:4188',
    config: { ...baseCfg, tableLabels: ['T04'], nfcRecordLayout: 'URI_ONLY', nfcChipType: 'NTAG215' },
    activeSessions: [
      {
        outletId: 'OUTLET-BR-02',
        tableLabel: 'T04',
        sessionNonce: 'nonce123',
        token: 'nonce123.sigabc',
        menuUrl: 'http://192.168.1.50:4174/m?t=T04&s=nonce123.sigabc&o=OUTLET-BR-02',
        wifiQrPayload: 'WIFI:T:WPA;S:Rube;P:pass1234;;',
        openedByName: 'Cashier',
        openedAtIso: '2026-11-28T00:00:00.000Z',
      },
    ],
  });
  assert.ok(
    liveOverrideActiveHtml.includes('http://10.0.0.88:4188/m?t=T04&amp;s=nonce123.sigabc&amp;o=OUTLET-BR-02'),
    'Active session A4 Menu QR must use live input.baseUrl rather than stale activeSess.menuUrl'
  );
  assert.ok(!liveOverrideActiveHtml.includes('192.168.1.50:4174'));

  // 5. openA4TableQrPrintWindow popup-blocked vs popup-opened
  const g = globalThis as unknown as { window?: { open?: unknown } | undefined };
  const hadWindow = Object.prototype.hasOwnProperty.call(g, 'window');
  const prevWindow = g.window;
  try {
    g.window = { open: () => null };
    const blocked = await openA4TableQrPrintWindow({
      storeName: 'Rube Cafe',
      locale: 'en',
      baseUrl: 'http://192.168.1.50:4174',
      config: { ...baseCfg, tableLabels: ['T01'] },
      activeSessions: [],
    });
    assert.equal(blocked, false);

    let writtenHtml = '';
    let openedCalled = false;
    let closedCalled = false;
    g.window = {
      open: () => ({
        document: {
          open: () => {
            openedCalled = true;
          },
          write: (h: string) => {
            writtenHtml += h;
          },
          close: () => {
            closedCalled = true;
          },
        },
      }),
    };
    const okWin = await openA4TableQrPrintWindow({
      outletId: 'OUTLET-BR-02',
      storeName: 'Rube Cafe',
      locale: 'en',
      baseUrl: 'http://192.168.1.50:4174',
      config: { ...baseCfg, tableLabels: ['T01'] },
      activeSessions: [],
    });
    assert.equal(okWin, true);
    assert.equal(openedCalled, true);
    assert.equal(closedCalled, true);
    assert.ok(writtenHtml.includes('o=OUTLET-BR-02'));
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  }
});

test('Phase 8J: RBAC (401/403/200), Bootstrap Wi-Fi Password Redaction, HTTP 404 Mapping, HMAC Tamper Fail-Closed & Multi-Outlet SIGNED_SESSION NFC Rotation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-pos-phase8j-nfc-'));
  const dbPath = path.join(tmpDir, 'rube_nfc_rbac.db');
  const guestPort = await getFreeTcpPort();

  const server = new RubePosInteractiveAppServer({
    dbPath,
    requireFirstRunWizard: false,
    enforceApiSessionAuth: true,
  });

  try {
    const { url: posBase } = await server.start(0, '127.0.0.1');

    const pinLogin = async (pin: string, userId?: string) => {
      const r = await fetch(`${posBase}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, ...(userId ? { userId } : {}) }),
      });
      assert.equal(r.status, 200);
      const data = (await r.json()) as { sessionToken: string };
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.sessionToken}`,
      };
    };

    const ownerHeaders = await pinLogin('999999', 'USR-OWNER-01');

    // Provision CASHIER, MANAGER, KITCHEN, WAREHOUSE users + secondary outlet OUTLET-BR-02
    const createStaff = async (username: string, displayName: string, role: string, pin: string) => {
      const res = await fetch(`${posBase}/api/auth/users`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ username, displayName, role, pin, active: true }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as { user: { id: string } };
      return data.user.id;
    };
    const mgrId = await createStaff('mgr8j', 'Manager 8J', 'MANAGER', '111111');
    const cashId = await createStaff('cash8j', 'Cashier 8J', 'CASHIER', '222222');
    const kitchenId = await createStaff('kit8j', 'Kitchen 8J', 'KITCHEN', '333333');
    const whId = await createStaff('wh8j', 'Warehouse 8J', 'WAREHOUSE', '444444');

    const mgrHeaders = await pinLogin('111111', mgrId);
    const cashierHeaders = await pinLogin('222222', cashId);
    const kitchenHeaders = await pinLogin('333333', kitchenId);
    const whHeaders = await pinLogin('444444', whId);

    const brOutletRes = await fetch(`${posBase}/api/warehouse/outlet`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ code: 'BR-02', name: 'Branch Two' }),
    });
    assert.equal(brOutletRes.status, 200);

    // Enable Guest LAN Server + SIGNED_SESSION NFC + AUTO_ACCEPT_SIGNED_TABLE
    const cfgRes = await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: mgrHeaders,
      body: JSON.stringify({
        enabled: true,
        port: guestPort,
        wifiSsid: 'RubeCafe_SecretNet',
        wifiPassword: 'SuperSecretWifiPassword2026',
        wifiSecurity: 'WPA',
        approvalMode: 'AUTO_ACCEPT_SIGNED_TABLE',
        allowOpenTableSelection: true,
        tableLabels: ['T01', 'T04'],
        nfcEnabled: true,
        nfcTagMode: 'SIGNED_SESSION',
        nfcRecordLayout: 'URI_AND_WIFI_WSC',
        nfcChipType: 'NTAG215',
      }),
    });
    assert.equal(cfgRes.status, 200);

    // 1. RBAC on GET /api/qr-ordering/nfc-tags: 401 unauth, 403 KITCHEN/WAREHOUSE, 200 CASHIER/MANAGER/OWNER
    assert.equal((await fetch(`${posBase}/api/qr-ordering/nfc-tags`)).status, 401);
    assert.equal((await fetch(`${posBase}/api/qr-ordering/nfc-tags`, { headers: kitchenHeaders })).status, 403);
    assert.equal((await fetch(`${posBase}/api/qr-ordering/nfc-tags`, { headers: whHeaders })).status, 403);
    assert.equal((await fetch(`${posBase}/api/qr-ordering/nfc-tags`, { headers: cashierHeaders })).status, 200);
    assert.equal((await fetch(`${posBase}/api/qr-ordering/nfc-tags`, { headers: mgrHeaders })).status, 200);
    assert.equal((await fetch(`${posBase}/api/qr-ordering/nfc-tags`, { headers: ownerHeaders })).status, 200);

    // 2. Open Table T04 session on OUTLET-BR-02 & verify bootstrap redacts wifiPassword for KITCHEN / WAREHOUSE only
    const openBrT04 = (await (
      await fetch(`${posBase}/api/qr-ordering/table-session`, {
        method: 'POST',
        headers: cashierHeaders,
        body: JSON.stringify({ outletId: 'OUTLET-BR-02', tableLabel: 'T04' }),
      })
    ).json()) as { session: { token: string; nfcMenuUrl: string; menuUrl: string } };
    assert.ok(openBrT04.session.nfcMenuUrl.includes('o=OUTLET-BR-02'));
    assert.ok(openBrT04.session.nfcMenuUrl.includes('via=nfc'));
    assert.ok(openBrT04.session.nfcMenuUrl.includes(`s=${encodeURIComponent(openBrT04.session.token)}`));

    for (const [roleLabel, hdrs, expectSecret] of [
      ['KITCHEN', kitchenHeaders, false],
      ['WAREHOUSE', whHeaders, false],
      ['CASHIER', cashierHeaders, true],
      ['MANAGER', mgrHeaders, true],
      ['OWNER', ownerHeaders, true],
    ] as const) {
      const bRes = await fetch(`${posBase}/api/bootstrap?outletId=OUTLET-BR-02`, { headers: hdrs });
      assert.equal(bRes.status, 200);
      const bJson = (await bRes.json()) as {
        qrOrderingConfig: { wifiPassword: string };
        qrTableSessions: Array<{ wifiQrPayload: string }>;
      };
      if (expectSecret) {
        assert.equal(bJson.qrOrderingConfig.wifiPassword, 'SuperSecretWifiPassword2026', `${roleLabel} keeps wifiPassword`);
        assert.ok(bJson.qrTableSessions[0]?.wifiQrPayload.includes('SuperSecretWifiPassword2026'));
      } else {
        assert.equal(bJson.qrOrderingConfig.wifiPassword, '', `${roleLabel} must have wifiPassword redacted`);
        assert.equal(bJson.qrTableSessions[0]?.wifiQrPayload ?? '', '', `${roleLabel} must not receive wifiQrPayload`);
      }
    }

    // 3. HTTP 404 mapping on pos-desktop-server.ts for nonexistent QR order/service call IDs
    const accept404 = await fetch(`${posBase}/api/qr-ordering/orders/accept`, {
      method: 'POST',
      headers: cashierHeaders,
      body: JSON.stringify({ guestOrderId: 'GORD-DOES-NOT-EXIST' }),
    });
    assert.equal(accept404.status, 404);
    const reject404 = await fetch(`${posBase}/api/qr-ordering/orders/reject`, {
      method: 'POST',
      headers: cashierHeaders,
      body: JSON.stringify({ guestOrderId: 'GORD-DOES-NOT-EXIST', reason: 'test' }),
    });
    assert.equal(reject404.status, 404);
    const ack404 = await fetch(`${posBase}/api/qr-ordering/service-calls/ack`, {
      method: 'POST',
      headers: cashierHeaders,
      body: JSON.stringify({ callId: 'SCALL-DOES-NOT-EXIST' }),
    });
    assert.equal(ack404.status, 404);

    // 4. OUTLET-BR-02 isolation + AUTO_ACCEPT_SIGNED_TABLE via NFC + SIGNED_SESSION rotation
    const guestBase = `http://127.0.0.1:${guestPort}`;
    // Seed a menu item with stock in OUTLET-BR-02 so BR-02 can order
    const brProdRes = await fetch(`${posBase}/api/catalog/variant`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        outletId: 'OUTLET-BR-02',
        itemName: 'Branch2 Iced Latte',
        sku: 'SKU-BR2-LATTE',
        categoryId: 'CAT-CAFE',
        unitName: 'แก้ว',
        priceSatang: 7_500,
        defaultPurchaseCostMicroBaht: 25_000_000,
        initialStockMilli: 20_000,
      }),
    });
    assert.equal(brProdRes.status, 200);
    const brProd = (await brProdRes.json()) as { variant: { id: string } };

    // Cross-outlet token (OUTLET-BR-02 token submitted to OUTLET-HQ) MUST fail with 403
    const crossOutletRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outletId: 'OUTLET-HQ',
        tableLabel: 'T04',
        signedToken: openBrT04.session.token,
        entryChannel: 'NFC',
        lines: [{ variantId: brProd.variant.id, quantityCount: 1 }],
      }),
    });
    assert.equal(crossOutletRes.status, 403);

    // Valid signed NFC order on OUTLET-BR-02 auto-accepts into BR-02 Held Bill + KDS immediately!
    const brAutoRes = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outletId: 'OUTLET-BR-02',
        tableLabel: 'T04',
        signedToken: openBrT04.session.token,
        entryChannel: 'NFC',
        lines: [{ variantId: brProd.variant.id, quantityCount: 1 }],
      }),
    });
    assert.equal(brAutoRes.status, 201);
    const brAutoData = (await brAutoRes.json()) as {
      order: { outletId: string; status: string; entryChannel: string; heldBillId: string | null; kdsSequenceIds: number[] };
    };
    assert.equal(brAutoData.order.outletId, 'OUTLET-BR-02');
    assert.equal(brAutoData.order.status, 'ACCEPTED');
    assert.equal(brAutoData.order.entryChannel, 'NFC');
    assert.ok(brAutoData.order.heldBillId);
    assert.ok(brAutoData.order.kdsSequenceIds.length >= 1);

    // Verify OUTLET-HQ inbox remains isolated (0 orders from OUTLET-BR-02)
    const hqInbox = (await (
      await fetch(`${posBase}/api/qr-ordering/orders?outletId=OUTLET-HQ`, { headers: cashierHeaders })
    ).json()) as { orders: unknown[] };
    assert.equal(hqInbox.orders.length, 0);

    // Rotate T04 on OUTLET-BR-02 -> old token fails (403), new token succeeds (201)
    const rotatedBrT04 = (await (
      await fetch(`${posBase}/api/qr-ordering/table-session`, {
        method: 'POST',
        headers: cashierHeaders,
        body: JSON.stringify({ outletId: 'OUTLET-BR-02', tableLabel: 'T04' }),
      })
    ).json()) as { session: { token: string } };
    assert.notEqual(rotatedBrT04.session.token, openBrT04.session.token);

    const oldTokenOrder = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outletId: 'OUTLET-BR-02',
        tableLabel: 'T04',
        signedToken: openBrT04.session.token,
        entryChannel: 'NFC',
        lines: [{ variantId: brProd.variant.id, quantityCount: 1 }],
      }),
    });
    assert.equal(oldTokenOrder.status, 403);

    const newTokenOrder = await fetch(`${guestBase}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outletId: 'OUTLET-BR-02',
        tableLabel: 'T04',
        signedToken: rotatedBrT04.session.token,
        entryChannel: 'NFC',
        lines: [{ variantId: brProd.variant.id, quantityCount: 1 }],
      }),
    });
    assert.equal(newTokenOrder.status, 201);

    // 5. SQLite HMAC tamper on `qr_ordering_config` MUST fail closed to defaults
    await server.engine.executeWriteImmediate((db) => {
      db.prepare(`UPDATE store_config SET value = ? WHERE key = 'qr_ordering_config'`).run(
        JSON.stringify({ ...DEFAULT_QR_ORDERING_CONFIG, enabled: true, port: 5555, nfcEnabled: true })
      );
    });
    const afterTamper = server.ipc.getQrOrderingConfig();
    assert.equal(afterTamper.enabled, false, 'Tampered qr_ordering_config must fail closed (enabled=false)');
    assert.equal(afterTamper.nfcEnabled, false, 'Tampered qr_ordering_config must fail closed (nfcEnabled=false)');
    assert.equal(afterTamper.port, 4174);
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8K: Captive URL &via=nfc normalization + Guest SPA client state guards (case-insensitive tableSelect, captive=1 forward, locked ordering & expired token preservation)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-pos-phase8k-html-'));
  const dbPath = path.join(tmpDir, 'rube_guest_html.db');
  const guestPort = await getFreeTcpPort();
  const server = new RubePosInteractiveAppServer({
    dbPath,
    requireFirstRunWizard: false,
    enforceApiSessionAuth: true,
  });

  // Minimal DOM + VM runner for the inline script inside renderGuestMenuHtml
  function runGuestHtmlScriptInVm(
    html: string,
    href: string,
    mockFetch: (url: string, init?: { method?: string; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
    vmOpts?: { rejectClipboard?: boolean; disableUrlCtor?: boolean }
  ) {
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch?.[1], 'Expected inline script inside guest menu HTML');

    const elements = new Map<string, Record<string, unknown>>();
    const makeEl = (id: string) => {
      const classSet = new Set<string>();
      const el: Record<string, unknown> = {
        id,
        style: {},
        value: '',
        textContent: '',
        _innerHTML: '',
        disabled: false,
        select: () => {},
        children: [] as Array<Record<string, unknown>>,
        classList: {
          toggle: (cls: string, force?: boolean) => {
            if (force === undefined) {
              if (classSet.has(cls)) classSet.delete(cls);
              else classSet.add(cls);
            } else if (force) classSet.add(cls);
            else classSet.delete(cls);
          },
          add: (cls: string) => classSet.add(cls),
          remove: (cls: string) => classSet.delete(cls),
          contains: (cls: string) => classSet.has(cls),
        },
        querySelectorAll: (selector: string) => {
          if (selector === '.card[data-vid]') {
            const matched: Array<Record<string, unknown>> = [];
            const re = /data-vid="([^"]+)"/g;
            let m: RegExpExecArray | null;
            const htmlText = String(el._innerHTML);
            while ((m = re.exec(htmlText)) !== null) {
              const vid = m[1]!;
              matched.push({
                getAttribute: (name: string) => (name === 'data-vid' ? vid : null),
              });
            }
            el._cardNodes = matched;
            return matched;
          }
          return [];
        },
        getAttribute: () => null,
        set innerHTML(val: string) {
          this._innerHTML = val;
        },
        get innerHTML() {
          return String(this._innerHTML);
        },
      };
      return el;
    };

    for (const id of [
      'storeNameEl',
      'storeSubEl',
      'captiveBanner',
      'alertBanner',
      'tabMenuBtn',
      'tabOrdersBtn',
      'serviceBar',
      'menuSection',
      'ordersSection',
      'searchInput',
      'catStrip',
      'menuGrid',
      'cartDock',
      'openCartBtn',
      'cartDockLabel',
      'cartDockTotal',
      'itemSheetBackdrop',
      'itemSheetContent',
      'cartSheetBackdrop',
      'cartSheetContent',
    ]) {
      elements.set(id, makeEl(id));
    }

    const copiedTexts: string[] = [];
    let lastCreatedTextarea: Record<string, unknown> | null = null;
    const doc = {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id)!;
      },
      querySelectorAll: () => [],
      createElement: (tag: string) => {
        const created = makeEl(`tmp-${tag}`);
        if (tag === 'textarea') lastCreatedTextarea = created;
        return created;
      },
      execCommand: (cmd: string) => {
        if (cmd === 'copy' && lastCreatedTextarea) {
          copiedTexts.push(String(lastCreatedTextarea.value ?? ''));
          return true;
        }
        return false;
      },
      body: { appendChild: () => {}, removeChild: () => {} },
    };

    const windowObj = {
      location: { href },
      localStorage: { getItem: () => null, setItem: () => {} },
      setInterval: () => 0,
      clearInterval: () => {},
    };

    const ctx = vm.createContext({
      window: windowObj,
      document: doc,
      navigator: {
        clipboard: {
          writeText: (txt: string) => {
            if (vmOpts?.rejectClipboard) {
              return Promise.reject(new Error('NotAllowedError'));
            }
            copiedTexts.push(txt);
            return Promise.resolve();
          },
        },
      },
      fetch: mockFetch,
      ...(vmOpts?.disableUrlCtor ? {} : { URL }),
      URLSearchParams,
      console,
      Math,
      Number,
      String,
      Array,
      Object,
      JSON,
      Date,
      Promise,
    });

    vm.runInContext(scriptMatch[1], ctx, { timeout: 1000 });
    return { elements, copiedTexts };
  }

  try {
    const { url: posBase } = await server.start(0, '127.0.0.1');
    const loginRes = await fetch(`${posBase}/api/auth/pin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '999999', userId: 'USR-OWNER-01' }),
    });
    const { sessionToken } = (await loginRes.json()) as { sessionToken: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    };

    await fetch(`${posBase}/api/qr-ordering/config`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        enabled: true,
        port: guestPort,
        allowOpenTableSelection: true,
        tableLabels: ['T01', 'T04'],
      }),
    });

    const guestBase = `http://127.0.0.1:${guestPort}`;

    // 1. Live Captive URL with &t=t04&via=nfc -> Copy Link preserves /m?t=t04&via=nfc (NOT /m&t=t04&via=nfc!)
    const captiveHtmlRes = await fetch(`${guestBase}/m?captive=1&t=t04&via=nfc`);
    assert.equal(captiveHtmlRes.status, 200);
    const captiveHtml = await captiveHtmlRes.text();
    const vmCaptive = runGuestHtmlScriptInVm(
      captiveHtml,
      `${guestBase}/m?captive=1&t=t04&via=nfc`,
      async (reqUrl) => {
        const res = await fetch(`${guestBase}${reqUrl}`);
        const json = await res.json();
        return { ok: res.ok, status: res.status, json: async () => json };
      }
    );
    await new Promise((r) => setTimeout(r, 40));

    // Trigger copyUrlBtn click inside captiveBanner HTML
    const capBannerHtml = String(vmCaptive.elements.get('captiveBanner')!._innerHTML);
    assert.ok(capBannerHtml.includes('id="copyUrlBtn"'));
    const copyBtn = vmCaptive.elements.get('copyUrlBtn') as { onclick?: () => void };
    assert.equal(typeof copyBtn.onclick, 'function');
    copyBtn.onclick!();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(vmCaptive.copiedTexts[0], `${guestBase}/m?t=t04&via=nfc`);
    const normalizedFetch = await fetch(vmCaptive.copiedTexts[0]!);
    assert.equal(normalizedFetch.status, 200, 'Normalized captive link MUST return HTTP 200');

    // 1b. Insecure LAN HTTP clipboard rejection falls back to document.execCommand('copy') + relative #hash strip
    const vmFallbackCopy = runGuestHtmlScriptInVm(
      captiveHtml,
      '/m?captive=1&t=t04#menu',
      async (reqUrl) => {
        const res = await fetch(`${guestBase}${reqUrl}`);
        const json = await res.json();
        return { ok: res.ok, status: res.status, json: async () => json };
      },
      { rejectClipboard: true, disableUrlCtor: true }
    );
    await new Promise((r) => setTimeout(r, 40));
    const fallbackCopyBtn = vmFallbackCopy.elements.get('copyUrlBtn') as { onclick?: () => void };
    fallbackCopyBtn.onclick!();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(vmFallbackCopy.copiedTexts[0], '/m?t=t04#menu');

    // 2. loadMenu() forwards captive=1 when BOOT.entryChannel === 'CAPTIVE'
    const pureCaptiveHtml = renderGuestMenuHtml({
      storeName: 'Rube',
      initialTableLabel: '',
      initialSignedToken: '',
      isCaptiveMode: true,
      entryChannel: 'CAPTIVE',
      defaultLocale: 'en',
    });
    const fetchedUrls: string[] = [];
    runGuestHtmlScriptInVm(pureCaptiveHtml, `${guestBase}/m?captive=1`, async (reqUrl) => {
      fetchedUrls.push(reqUrl);
      const res = await fetch(`${guestBase}${reqUrl}`);
      const json = await res.json();
      return { ok: res.ok, status: res.status, json: async () => json };
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(
      fetchedUrls.some((u) => u.startsWith('/api/guest/menu') && u.includes('captive=1')),
      `loadMenu() must forward captive=1 when entryChannel==='CAPTIVE'; got ${fetchedUrls.join(', ')}`
    );

    // 3. Case-insensitive tableSelect match (?t=t04&via=nfc selects 'T04')
    const menuItemsSample = [
      {
        variantId: 'V1',
        itemName: 'Iced Americano',
        variantName: 'Reg',
        categoryId: 'CAT-CAFE',
        categoryName: 'Coffee',
        unitName: 'cup',
        priceSatang: 6000,
        imageUrl: null,
        isAvailable: true,
        isComposite: false,
        kitchenStation: 'BAR',
      },
    ];
    const htmlLowerT = renderGuestMenuHtml({
      storeName: 'Rube',
      initialTableLabel: 't04',
      initialSignedToken: '',
      isCaptiveMode: false,
      entryChannel: 'NFC',
      defaultLocale: 'en',
    });
    // Check that rendered code matches case-insensitively when rendering <select id="tableSelect">
    assert.ok(htmlLowerT.includes('tbl.toUpperCase() === String(state.selectedTable'));
    const vmLowerT = runGuestHtmlScriptInVm(htmlLowerT, `${guestBase}/m?t=t04&via=nfc`, async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        storeName: 'Rube',
        storeAddress: '',
        outletId: 'OUTLET-HQ',
        countryCode: 'TH',
        currencyCode: 'THB',
        currencySymbol: '฿',
        currencyDecimals: 2,
        defaultLocale: 'en',
        taxMode: 'INCLUSIVE',
        vatRateBps: 700,
        wifiSsid: 'RubeWiFi',
        maxQtyPerItem: 20,
        allowOpenTableSelection: true,
        tableLabels: ['T01', 'T04'],
        lockedTableLabel: null,
        signedTableValid: false,
        signedTableExpired: false,
        nfcEnabled: true,
        entryChannel: 'NFC',
        categories: [],
        items: menuItemsSample,
        modifierGroups: [],
      }),
    }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(String(vmLowerT.elements.get('storeSubEl')!._innerHTML).includes('Table T04'));
    // Open item V1 -> add to cart -> open cart sheet -> verify <option value="T04" selected>
    const lowerCards = vmLowerT.elements.get('menuGrid')!._cardNodes as Array<{ onclick?: () => void }>;
    assert.equal(lowerCards.length, 1);
    lowerCards[0]!.onclick!();
    (vmLowerT.elements.get('confirmAddItemBtn') as { onclick: () => void }).onclick();
    (vmLowerT.elements.get('openCartBtn') as { onclick: () => void }).onclick();
    const cartHtml = String(vmLowerT.elements.get('cartSheetContent')!._innerHTML);
    assert.ok(
      cartHtml.includes('<option value="T04" selected>T04</option>'),
      `Expected case-insensitive ?t=t04 match to select T04 in cart sheet, got: ${cartHtml}`
    );

    // 4. !allowOpenTableSelection && !signedTableValid -> topbar hides Table T04, menu cards disabled, ordering locked
    const vmLocked = runGuestHtmlScriptInVm(htmlLowerT, `${guestBase}/m?t=t04&via=nfc`, async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        storeName: 'Rube',
        storeAddress: '',
        outletId: 'OUTLET-HQ',
        countryCode: 'TH',
        currencyCode: 'THB',
        currencySymbol: '฿',
        currencyDecimals: 2,
        defaultLocale: 'en',
        taxMode: 'INCLUSIVE',
        vatRateBps: 700,
        wifiSsid: 'RubeWiFi',
        maxQtyPerItem: 20,
        allowOpenTableSelection: false,
        tableLabels: ['T01', 'T04'],
        lockedTableLabel: null,
        signedTableValid: false,
        signedTableExpired: false,
        nfcEnabled: true,
        entryChannel: 'NFC',
        categories: [],
        items: menuItemsSample,
        modifierGroups: [],
      }),
    }));
    await new Promise((r) => setTimeout(r, 30));
    const lockedTopbar = String(vmLocked.elements.get('storeSubEl')!._innerHTML);
    assert.ok(!lockedTopbar.includes('Table T04'), 'Topbar must NOT print unverified Table T04 when !allowOpenTableSelection');
    const lockedGrid = String(vmLocked.elements.get('menuGrid')!._innerHTML);
    assert.ok(lockedGrid.includes(' disabled>'), 'Menu cards must be disabled when ordering is locked');
    assert.ok(!lockedGrid.includes('plus-chip'), 'Menu cards must hide + chip when ordering is locked');
    assert.equal((vmLocked.elements.get('serviceBar')!.style as { display?: string }).display, 'none');
    const lockedCards = vmLocked.elements.get('menuGrid')!._cardNodes as Array<{ onclick?: () => void }>;
    lockedCards[0]?.onclick?.();
    assert.equal(
      (vmLocked.elements.get('itemSheetBackdrop')!.classList as { contains: (c: string) => boolean }).contains('open'),
      false,
      'Clicking locked menu card must not open item sheet'
    );

    // 5. signedTableExpired && allowOpenTableSelection -> ordering locked & never strips token into Walk-in
    const htmlExpired = renderGuestMenuHtml({
      storeName: 'Rube',
      initialTableLabel: 'T04',
      initialSignedToken: 'expired.sig',
      isCaptiveMode: false,
      entryChannel: 'NFC',
      defaultLocale: 'en',
    });
    const postedBodies: string[] = [];
    const vmExpired = runGuestHtmlScriptInVm(
      htmlExpired,
      `${guestBase}/m?t=T04&s=expired.sig&via=nfc`,
      async (_u, init) => {
        if (init?.method === 'POST' && init.body) {
          postedBodies.push(init.body);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            storeName: 'Rube',
            storeAddress: '',
            outletId: 'OUTLET-HQ',
            countryCode: 'TH',
            currencyCode: 'THB',
            currencySymbol: '฿',
            currencyDecimals: 2,
            defaultLocale: 'en',
            taxMode: 'INCLUSIVE',
            vatRateBps: 700,
            wifiSsid: 'RubeWiFi',
            maxQtyPerItem: 20,
            allowOpenTableSelection: true,
            tableLabels: ['T01', 'T04'],
            lockedTableLabel: null,
            signedTableValid: false,
            signedTableExpired: true,
            nfcEnabled: true,
            entryChannel: 'NFC',
            categories: [],
            items: menuItemsSample,
            modifierGroups: [],
          }),
        };
      }
    );
    await new Promise((r) => setTimeout(r, 30));
    const expiredGrid = String(vmExpired.elements.get('menuGrid')!._innerHTML);
    assert.ok(expiredGrid.includes(' disabled>'), 'Expired signed table must lock ordering even when allowOpenTableSelection=true');
    const expiredCards = vmExpired.elements.get('menuGrid')!._cardNodes as Array<{ onclick?: () => void }>;
    expiredCards[0]?.onclick?.();
    assert.equal(
      (vmExpired.elements.get('itemSheetBackdrop')!.classList as { contains: (c: string) => boolean }).contains('open'),
      false,
      'Clicking card on expired signed table must not open item sheet'
    );
    assert.equal(postedBodies.length, 0);
    assert.ok(!htmlExpired.includes('signedToken: state.menu.signedTableValid ? BOOT.initialToken : \'\''));

    // 6. Unlisted ?t=T99 in open mode falls back to first configured tableLabel ('T01') in topbar and <select>
    const htmlUnlisted = renderGuestMenuHtml({
      storeName: 'Rube',
      initialTableLabel: 'T99',
      initialSignedToken: '',
      isCaptiveMode: false,
      entryChannel: 'DIRECT',
      defaultLocale: 'en',
    });
    const vmUnlisted = runGuestHtmlScriptInVm(htmlUnlisted, `${guestBase}/m?t=T99`, async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        storeName: 'Rube',
        storeAddress: '',
        outletId: 'OUTLET-HQ',
        countryCode: 'TH',
        currencyCode: 'THB',
        currencySymbol: '฿',
        currencyDecimals: 2,
        defaultLocale: 'en',
        taxMode: 'INCLUSIVE',
        vatRateBps: 700,
        wifiSsid: 'RubeWiFi',
        maxQtyPerItem: 20,
        allowOpenTableSelection: true,
        tableLabels: ['T01', 'T04'],
        lockedTableLabel: null,
        signedTableValid: false,
        signedTableExpired: false,
        nfcEnabled: true,
        entryChannel: 'DIRECT',
        categories: [],
        items: menuItemsSample,
        modifierGroups: [],
      }),
    }));
    await new Promise((r) => setTimeout(r, 30));
    const unlistedTopbar = String(vmUnlisted.elements.get('storeSubEl')!._innerHTML);
    assert.ok(unlistedTopbar.includes('Table T01'), `Expected fallback to T01 in topbar, got ${unlistedTopbar}`);
    assert.ok(!unlistedTopbar.includes('T99'));
    const unlistedCards = vmUnlisted.elements.get('menuGrid')!._cardNodes as Array<{ onclick?: () => void }>;
    unlistedCards[0]!.onclick!();
    (vmUnlisted.elements.get('confirmAddItemBtn') as { onclick: () => void }).onclick();
    (vmUnlisted.elements.get('openCartBtn') as { onclick: () => void }).onclick();
    const unlistedCartHtml = String(vmUnlisted.elements.get('cartSheetContent')!._innerHTML);
    assert.ok(unlistedCartHtml.includes('<option value="T01" selected>T01</option>'));
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8L: React SSR verification of QrOrderingSettingsCard & TableQrSlipModal (host preview, warnings, static NFC without activeSession, WIFI_WSC_ONLY & overflow)', async () => {
  const esbuild = await import('esbuild');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createRequire } = await import('node:module');

  const appDir = path.resolve(import.meta.dirname, '../../packages/ui-presentation/src/app');
  const toImport = (rel: string) => path.join(appDir, rel);

  const entrySource = [
    `export { I18nProvider } from ${JSON.stringify(toImport('i18n/index.tsx'))};`,
    `export { QrOrderingSettingsCard } from ${JSON.stringify(toImport('components/QrOrderingSettingsCard.tsx'))};`,
    `export { TableQrSlipModal } from ${JSON.stringify(toImport('components/QrOrderingInboxPanel.tsx'))};`,
  ].join('\n');

  const built = await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: appDir,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    packages: 'external',
    logLevel: 'silent',
  });

  const cjsCode = built.outputFiles[0]!.text;
  const req = createRequire(import.meta.url);
  const cjsModule: { exports: Record<string, unknown> } = { exports: {} };
  const fn = new Function('exports', 'require', 'module', cjsCode);
  fn(cjsModule.exports, req, cjsModule);
  const mod = cjsModule.exports as {
    I18nProvider: React.FC<{ fiscalConfig: unknown; children: React.ReactNode }>;
    QrOrderingSettingsCard: React.FC<Record<string, unknown>>;
    TableQrSlipModal: React.FC<Record<string, unknown>>;
  };

  const baseFiscal = {
    countryCode: 'TH',
    currencyCode: 'THB',
    currencySymbol: '฿',
    currencyDecimals: 2,
    uiLocale: 'en',
    receiptLocale: 'en',
    defaultTaxMode: 'INCLUSIVE',
    vatRateBps: 700,
    storeAddress: '',
    laoQrStaticTemplate: '',
  };

  const makeBootstrap = (qrCfg: Record<string, unknown>, sessions: unknown[] = []) => ({
    storeSettings: { storeName: 'Rube Cafe' },
    printerConfig: { paperWidthMm: 80 },
    qrOrderingConfig: qrCfg,
    qrOrderingStatus: {
      running: true,
      port: Number(qrCfg.port ?? 4174),
      detectedLanIpv4s: ['192.168.1.50'],
      activeHost: String(qrCfg.customHostOverride || '192.168.1.50'),
      baseUrl: `http://${qrCfg.customHostOverride || '192.168.1.50'}:${qrCfg.port ?? 4174}`,
    },
    qrTableSessions: sessions,
  });

  const renderWithI18n = (el: React.ReactElement) =>
    renderToStaticMarkup(React.createElement(mod.I18nProvider, { fiscalConfig: baseFiscal }, el));

  // 1. QrOrderingSettingsCard: STATIC_TABLE + !allowOpenTableSelection + WIFI_WSC_ONLY with short WPA key
  const settingsWarnHtml = renderWithI18n(
    React.createElement(mod.QrOrderingSettingsCard, {
      outletId: 'OUTLET-HQ',
      bootstrap: makeBootstrap({
        ...DEFAULT_QR_ORDERING_CONFIG,
        enabled: true,
        customHostOverride: '10.0.0.88',
        port: 4199,
        wifiSsid: 'RubeCafe',
        wifiPassword: 'short',
        wifiSecurity: 'WPA',
        allowOpenTableSelection: false,
        tableLabels: ['T01', 'T04'],
        nfcEnabled: true,
        nfcTagMode: 'STATIC_TABLE',
        nfcRecordLayout: 'WIFI_WSC_ONLY',
        nfcChipType: 'NTAG215',
      }),
      canManage: true,
      onRefreshState: async () => {},
      onToast: () => {},
    })
  );
  assert.ok(settingsWarnHtml.includes('http://10.0.0.88:4199/m'));
  assert.ok(settingsWarnHtml.includes('STATIC_TABLE NFC tags are unsigned'));
  assert.ok(settingsWarnHtml.includes('WPA password must be at least 8 characters'));

  // 2. QrOrderingSettingsCard: SIGNED_SESSION unopened tables warning + blank SSID warning
  const settingsSignedHtml = renderWithI18n(
    React.createElement(mod.QrOrderingSettingsCard, {
      outletId: 'OUTLET-HQ',
      bootstrap: makeBootstrap({
        ...DEFAULT_QR_ORDERING_CONFIG,
        enabled: true,
        wifiSsid: '',
        wifiPassword: '',
        tableLabels: ['T01', 'T04'],
        nfcEnabled: true,
        nfcTagMode: 'SIGNED_SESSION',
        nfcRecordLayout: 'URI_AND_WIFI_WSC',
        nfcChipType: 'NTAG215',
      }),
      canManage: true,
      onRefreshState: async () => {},
      onToast: () => {},
    })
  );
  assert.ok(settingsSignedHtml.includes('Wi-Fi SSID is blank'));
  assert.ok(settingsSignedHtml.includes('2 table(s) have no active HMAC session yet'));

  // 3. TableQrSlipModal: STATIC_TABLE renders NFC Tools WITHOUT activeSession, shows capacity & static warning
  const modalStaticHtml = renderWithI18n(
    React.createElement(mod.TableQrSlipModal, {
      open: true,
      outletId: 'OUTLET-HQ',
      bootstrap: makeBootstrap({
        ...DEFAULT_QR_ORDERING_CONFIG,
        enabled: true,
        wifiSsid: 'RubeCafe_Super_Long_Guest_WiFi_SSID',
        wifiPassword: 'SuperLongWifiPassword2026',
        wifiSecurity: 'WPA',
        allowOpenTableSelection: false,
        tableLabels: ['T01', 'T04'],
        nfcEnabled: true,
        nfcTagMode: 'STATIC_TABLE',
        nfcRecordLayout: 'URI_AND_WIFI_WSC',
        nfcChipType: 'NTAG213',
      }),
      currentUser: { id: 'U1', displayName: 'Cashier', role: 'CASHIER' },
      tableSessions: [],
      onClose: () => {},
      onSessionsChanged: async () => {},
      onToast: () => {},
    })
  );
  assert.ok(
    modalStaticHtml.includes('NFC Tools (T01)'),
    'NFC Tools panel must render without activeSession in STATIC_TABLE mode'
  );
  assert.ok(modalStaticHtml.includes('Static URL'));
  assert.ok(modalStaticHtml.includes('137 B (NTAG213)'));
  assert.ok(modalStaticHtml.includes('NDEF size exceeds NTAG213'));
  assert.ok(
    modalStaticHtml.includes('STATIC_TABLE tags are unsigned while open table selection is disabled')
  );
  assert.ok(modalStaticHtml.includes('Copy NFC URL'));

  // 4. TableQrSlipModal: WIFI_WSC_ONLY shows Copy WSC Base64 & Android-only note
  const modalWscOnlyHtml = renderWithI18n(
    React.createElement(mod.TableQrSlipModal, {
      open: true,
      outletId: 'OUTLET-HQ',
      bootstrap: makeBootstrap({
        ...DEFAULT_QR_ORDERING_CONFIG,
        enabled: true,
        wifiSsid: 'RubeCafe_5G',
        wifiPassword: 'password123',
        wifiSecurity: 'WPA',
        tableLabels: ['T01'],
        nfcEnabled: true,
        nfcTagMode: 'STATIC_TABLE',
        nfcRecordLayout: 'WIFI_WSC_ONLY',
        nfcChipType: 'NTAG215',
      }),
      currentUser: { id: 'U1', displayName: 'Cashier', role: 'CASHIER' },
      tableSessions: [],
      onClose: () => {},
      onSessionsChanged: async () => {},
      onToast: () => {},
    })
  );
  assert.ok(modalWscOnlyHtml.includes('WIFI_WSC_ONLY'));
  assert.ok(modalWscOnlyHtml.includes('Copy WSC Base64'));
  assert.ok(modalWscOnlyHtml.includes('492 B (NTAG215)'));

  // 5. TableQrSlipModal: SIGNED_SESSION with active tableSessions renders Rotate, Signed Token & Slip immediately
  const modalSignedActiveHtml = renderWithI18n(
    React.createElement(mod.TableQrSlipModal, {
      open: true,
      outletId: 'OUTLET-HQ',
      bootstrap: makeBootstrap({
        ...DEFAULT_QR_ORDERING_CONFIG,
        enabled: true,
        wifiSsid: 'RubeCafe_5G',
        wifiPassword: 'password123',
        wifiSecurity: 'WPA',
        tableLabels: ['T01', 'T04'],
        nfcEnabled: true,
        nfcTagMode: 'SIGNED_SESSION',
        nfcRecordLayout: 'URI_ONLY',
        nfcChipType: 'NTAG215',
      }),
      currentUser: { id: 'U1', displayName: 'Cashier', role: 'CASHIER' },
      tableSessions: [
        {
          outletId: 'OUTLET-HQ',
          tableLabel: 'T01',
          sessionNonce: 'abc12345',
          token: 'abc12345.deadbeef1234',
          menuUrl: 'http://192.168.1.50:4174/m?t=T01&s=abc12345.deadbeef1234',
          nfcMenuUrl: 'http://192.168.1.50:4174/m?t=T01&s=abc12345.deadbeef1234&via=nfc',
          wifiQrPayload: 'WIFI:T:WPA;S:RubeCafe_5G;P:password123;;',
          openedByName: 'Cashier',
          openedAtIso: '2026-11-28T00:00:00.000Z',
        },
      ],
      onClose: () => {},
      onSessionsChanged: async () => {},
      onToast: () => {},
    })
  );
  assert.ok(modalSignedActiveHtml.includes('Rotate Table QR for T01'));
  assert.ok(modalSignedActiveHtml.includes('Signed Token'));
  assert.ok(!modalSignedActiveHtml.includes('Open table above first to generate a rotating HMAC token'));
});
