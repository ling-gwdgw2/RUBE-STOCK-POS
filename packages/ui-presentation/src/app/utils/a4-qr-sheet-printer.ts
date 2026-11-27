/**
 * RUBE-STOCK-POS v3.1.1 Offline A4 Printable Table QR Stand / Tent Sheet Generator
 *
 * Generates a crisp, cut-ready A4 HTML sheet containing every configured store table card:
 * - Store name & localized customer scan guide (`lo` / `th` / `en`)
 * - Step 1: Store Guest Wi-Fi Auto-Join QR (`WIFI:T:WPA;S:...;P:...;;`) + SSID / Password
 * - Step 2: Direct LAN Menu Table QR (`http://<LAN-IP>:4174/m?t=T01&s=<token>`)
 * Zero external CDN URLs, zero `window.alert`, pure offline base64 QR data URLs.
 */

import QRCode from 'qrcode';
import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import {
  buildTableMenuUrl,
  buildWifiQrPayload,
  type QrOrderingConfigDto,
  type TableQrSessionDto,
} from '../../../../shared-contracts/src/qr-ordering.ts';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface A4TableQrSheetInput {
  storeName: string;
  locale: LocaleCode;
  baseUrl: string;
  config: QrOrderingConfigDto;
  activeSessions: readonly TableQrSessionDto[];
}

export async function openA4TableQrPrintWindow(input: A4TableQrSheetInput): Promise<boolean> {
  const wifiPayload = buildWifiQrPayload(
    input.config.wifiSsid,
    input.config.wifiPassword,
    input.config.wifiSecurity
  );
  const wifiQrDataUrl = wifiPayload
    ? await QRCode.toDataURL(wifiPayload, { width: 220, margin: 1, errorCorrectionLevel: 'M' })
    : '';

  const sessionMap = new Map<string, TableQrSessionDto>(
    input.activeSessions.map((s) => [s.tableLabel.trim().toUpperCase(), s])
  );

  const labels =
    input.locale === 'lo'
      ? {
          pageTitle: 'ປ້າຍ QR ຕັ້ງໂຕະ (A4)',
          subtitle: 'ສະແກນເຊື່ອມ Wi-Fi ຮ້ານ ແລ້ວສະແກນສັ່ງເມນູໄດ້ທັນທີ',
          step1: '1. ສະແກນເຊື່ອມ Wi-Fi ຮ້ານ',
          step2: '2. ສະແກນເປີດເມນູສັ່ງອາຫານ',
          tablePrefix: 'ໂຕະ',
          wifiPass: 'ລະຫັດຜ່ານ:',
          openWifi: 'Wi-Fi ເປີດ (ບໍ່ມີລະຫັດ)',
          signedTag: 'Signed Table QR',
          staticTag: 'Table Menu QR',
          printBtn: 'ພິມແຜ່ນປ້າຍ QR (A4)',
          closeBtn: 'ປິດໜ້າຕ່າງ',
        }
      : input.locale === 'en'
        ? {
            pageTitle: 'Printable Table QR Cards (A4)',
            subtitle: 'Scan to join Store Wi-Fi, then scan to order directly from your table',
            step1: '1. Scan to Join Store Wi-Fi',
            step2: '2. Scan to Open Menu & Order',
            tablePrefix: 'TABLE',
            wifiPass: 'Password:',
            openWifi: 'Open Wi-Fi (No Password)',
            signedTag: 'Signed Table QR',
            staticTag: 'Table Menu QR',
            printBtn: 'Print A4 Table QR Sheet',
            closeBtn: 'Close',
          }
        : {
            pageTitle: 'แผ่นป้าย QR ตั้งโต๊ะสั่งอาหาร (A4)',
            subtitle: 'สแกนเชื่อม Wi-Fi ร้าน แล้วสแกนเปิดเมนูสั่งอาหารได้ทันทีผ่านวง LAN',
            step1: '1. สแกนเชื่อม Wi-Fi ร้าน',
            step2: '2. สแกนเปิดเมนูสั่งอาหาร',
            tablePrefix: 'โต๊ะ',
            wifiPass: 'รหัสผ่าน:',
            openWifi: 'Wi-Fi เปิด (ไม่มีรหัสผ่าน)',
            signedTag: 'Signed Table QR',
            staticTag: 'Table Menu QR',
            printBtn: 'พิมพ์แผ่นป้าย QR ทั้งหมด (A4)',
            closeBtn: 'ปิดหน้าต่าง',
          };

  const cardsHtmlParts: string[] = [];
  for (const tableLabel of input.config.tableLabels) {
    const activeSess = sessionMap.get(tableLabel.trim().toUpperCase());
    const menuUrl = activeSess
      ? activeSess.menuUrl
      : buildTableMenuUrl(input.baseUrl, tableLabel, null);
    const menuQrDataUrl = await QRCode.toDataURL(menuUrl, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
    });

    cardsHtmlParts.push(`
      <article class="qr-card">
        <div class="card-head">
          <div class="store-name">${escHtml(input.storeName)}</div>
          <div class="table-badge">${escHtml(labels.tablePrefix)} ${escHtml(tableLabel)}</div>
        </div>
        <div class="card-sub">${escHtml(labels.subtitle)}</div>
        <div class="qr-row ${wifiQrDataUrl ? 'two-col' : 'one-col'}">
          ${
            wifiQrDataUrl
              ? `<div class="qr-box">
                   <div class="step-label">${escHtml(labels.step1)}</div>
                   <img src="${wifiQrDataUrl}" alt="Wi-Fi QR" />
                   <div class="meta-line"><strong>${escHtml(input.config.wifiSsid)}</strong></div>
                   <div class="meta-sub">${
                     input.config.wifiSecurity === 'NOPASS'
                       ? escHtml(labels.openWifi)
                       : `${escHtml(labels.wifiPass)} ${escHtml(input.config.wifiPassword || '-')}`
                   }</div>
                 </div>`
              : ''
          }
          <div class="qr-box">
            <div class="step-label">${escHtml(labels.step2)}</div>
            <img src="${menuQrDataUrl}" alt="Menu QR ${escHtml(tableLabel)}" />
            <div class="meta-line"><strong>${escHtml(activeSess ? labels.signedTag : labels.staticTag)}</strong></div>
            <div class="meta-url">${escHtml(input.baseUrl)}</div>
          </div>
        </div>
      </article>
    `);
  }

  const html = `<!DOCTYPE html>
<html lang="${escHtml(input.locale)}">
<head>
  <meta charset="utf-8" />
  <title>${escHtml(labels.pageTitle)} — ${escHtml(input.storeName)}</title>
  <style>
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: #ffffff;
      color: #202124;
      font-family: "Noto Sans Lao", "Leelawadee UI", "Segoe UI", Tahoma, sans-serif;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      margin-bottom: 16px;
      border: 1px solid #dadce0;
      border-radius: 8px;
      background: #f8f9fa;
    }
    .toolbar-title { font-size: 16px; font-weight: 700; }
    .toolbar-actions { display: flex; gap: 8px; }
    .btn {
      height: 40px;
      padding: 0 18px;
      border-radius: 48px;
      border: 1px solid #dadce0;
      background: #ffffff;
      color: #202124;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-primary {
      border-color: #1a73e8;
      background: #1a73e8;
      color: #ffffff;
    }
    .sheet-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .qr-card {
      border: 1px dashed #9aa0a6;
      border-radius: 8px;
      padding: 12px;
      break-inside: avoid;
      page-break-inside: avoid;
      background: #ffffff;
    }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid #dadce0;
      padding-bottom: 8px;
      margin-bottom: 6px;
    }
    .store-name {
      font-size: 14px;
      font-weight: 700;
      color: #202124;
    }
    .table-badge {
      border-radius: 48px;
      background: #202124;
      color: #ffffff;
      font-size: 14px;
      font-weight: 700;
      padding: 3px 12px;
      white-space: nowrap;
    }
    .card-sub {
      font-size: 11px;
      color: #5f6368;
      margin-bottom: 8px;
      text-align: center;
    }
    .qr-row {
      display: grid;
      gap: 10px;
      align-items: start;
    }
    .qr-row.two-col { grid-template-columns: 1fr 1fr; }
    .qr-row.one-col { grid-template-columns: 1fr; }
    .qr-box {
      border: 1px solid #dadce0;
      border-radius: 6px;
      padding: 8px;
      text-align: center;
      background: #f8f9fa;
    }
    .step-label {
      font-size: 11px;
      font-weight: 700;
      color: #1a73e8;
      margin-bottom: 6px;
    }
    .qr-box img {
      width: 116px;
      height: 116px;
      display: block;
      margin: 0 auto 6px;
      background: #ffffff;
      padding: 4px;
      border: 1px solid #dadce0;
      border-radius: 4px;
    }
    .meta-line { font-size: 11px; color: #202124; word-break: break-all; }
    .meta-sub { font-size: 10px; color: #5f6368; margin-top: 2px; word-break: break-all; }
    .meta-url { font-size: 9px; color: #5f6368; margin-top: 2px; word-break: break-all; }
    @media print {
      body { padding: 0; }
      .toolbar { display: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">${escHtml(labels.pageTitle)} · ${escHtml(input.storeName)} (${input.config.tableLabels.length})</div>
    <div class="toolbar-actions">
      <button type="button" class="btn btn-primary" onclick="window.print()">${escHtml(labels.printBtn)}</button>
      <button type="button" class="btn" onclick="window.close()">${escHtml(labels.closeBtn)}</button>
    </div>
  </div>
  <div class="sheet-grid">
    ${cardsHtmlParts.join('\n')}
  </div>
</body>
</html>`;

  const printWin = window.open('', '_blank', 'width=960,height=780');
  if (!printWin) {
    return false;
  }
  printWin.document.open();
  printWin.document.write(html);
  printWin.document.close();
  return true;
}
