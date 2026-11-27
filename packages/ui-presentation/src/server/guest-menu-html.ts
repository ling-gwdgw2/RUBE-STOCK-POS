/**
 * RUBE-STOCK-POS v3.1.1 Offline-First Mobile Customer Self-Ordering Web App (Port 4174)
 *
 * Zero external CDN dependencies, zero build step required, < 30KB HTML payload.
 * Strict `google.design.md` visual grammar:
 * - Pure white `#ffffff` canvas, `#f8f9fa` subtle surfaces, `#dadce0` 1px hairline borders
 * - `#202124` primary ink, `#5f6368` muted ink, singular `#1a73e8` Google Blue primary action
 * - Offline bundled Noto Sans Lao (`/fonts/noto-sans-lao-*.woff2`) + 3 languages (`lo` / `th` / `en`)
 * - Pure integer minor-unit (satang / att) math — zero floating-point parsing
 */

export interface GuestHtmlRenderOptions {
  storeName: string;
  initialOutletId?: string | undefined;
  initialTableLabel: string;
  initialSignedToken: string;
  isCaptiveMode: boolean;
  defaultLocale: 'th' | 'lo' | 'en';
}

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForInlineScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function renderGuestMenuHtml(options: GuestHtmlRenderOptions): string {
  const safeTitle = escapeHtmlAttr(options.storeName || 'RUBE-STOCK-POS Menu');
  const bootJson = safeJsonForInlineScript({
    outletId: options.initialOutletId || 'OUTLET-HQ',
    initialTable: options.initialTableLabel,
    initialToken: options.initialSignedToken,
    isCaptiveMode: options.isCaptiveMode,
    defaultLocale: options.defaultLocale,
  });

  return `<!DOCTYPE html>
<html lang="${escapeHtmlAttr(options.defaultLocale)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#ffffff" />
  <title>${safeTitle}</title>
  <style>
    @font-face {
      font-family: 'Noto Sans Lao Local';
      src: url('/fonts/noto-sans-lao-400.woff2') format('woff2');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Noto Sans Lao Local';
      src: url('/fonts/noto-sans-lao-700.woff2') format('woff2');
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }
    :root {
      --canvas: #ffffff;
      --surface-1: #f8f9fa;
      --surface-2: #f1f3f4;
      --hairline: #dadce0;
      --ink: #202124;
      --ink-soft: #3c4043;
      --ink-muted: #5f6368;
      --primary: #1a73e8;
      --primary-hover: #1557b0;
      --primary-soft: #e8f0fe;
      --danger: #d93025;
      --danger-soft: #fce8e6;
      --ok: #137333;
      --ok-soft: #e6f4ea;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--canvas);
      color: var(--ink);
      font-family: 'Noto Sans Lao Local', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans Thai', sans-serif;
      font-size: 15px;
      line-height: 1.45;
      min-height: 100%;
    }
    .tnum { font-variant-numeric: tabular-nums; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--canvas);
      border-bottom: 1px solid var(--hairline);
      padding: 12px 16px;
    }
    .topbar-row {
      max-width: 720px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .store-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--ink);
      margin: 0;
      line-height: 1.25;
    }
    .store-sub {
      font-size: 12px;
      color: var(--ink-muted);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 48px;
      padding: 2px 10px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--hairline);
      background: var(--surface-1);
      color: var(--ink-soft);
    }
    .badge-primary {
      border-color: var(--primary);
      background: var(--primary-soft);
      color: var(--primary-hover);
    }
    .badge-ok {
      border-color: #ceead6;
      background: var(--ok-soft);
      color: var(--ok);
    }
    .badge-danger {
      border-color: #fad2cf;
      background: var(--danger-soft);
      color: var(--danger);
    }
    .lang-bar {
      display: inline-flex;
      border: 1px solid var(--hairline);
      border-radius: 48px;
      overflow: hidden;
      background: var(--surface-1);
      flex-shrink: 0;
    }
    .lang-btn {
      border: 0;
      background: transparent;
      color: var(--ink-muted);
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .lang-btn.active {
      background: var(--primary);
      color: #ffffff;
    }
    .wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 12px 16px 112px;
    }
    .banner {
      border: 1px solid var(--hairline);
      background: var(--surface-1);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
      font-size: 13px;
      color: var(--ink-soft);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .banner-warn {
      border-color: var(--danger);
      background: var(--danger-soft);
      color: var(--danger);
    }
    .banner-ok {
      border-color: #ceead6;
      background: var(--ok-soft);
      color: var(--ok);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 40px;
      padding: 0 16px;
      border-radius: 48px;
      border: 1px solid var(--hairline);
      background: var(--canvas);
      color: var(--ink);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
    }
    .btn-primary {
      border-color: var(--primary);
      background: var(--primary);
      color: #ffffff;
    }
    .btn-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn-sm { min-height: 32px; padding: 0 12px; font-size: 12px; }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .tab-btn {
      flex: 1;
      min-height: 40px;
      border-radius: 48px;
      border: 1px solid var(--hairline);
      background: var(--canvas);
      color: var(--ink-muted);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .tab-btn.active {
      border-color: var(--primary);
      background: var(--primary-soft);
      color: var(--primary-hover);
    }
    .search-box {
      width: 100%;
      height: 42px;
      border-radius: 48px;
      border: 1px solid var(--hairline);
      background: var(--surface-1);
      padding: 0 16px;
      font-size: 14px;
      color: var(--ink);
      outline: none;
      margin-bottom: 10px;
    }
    .search-box:focus {
      border-color: var(--primary);
      background: var(--canvas);
    }
    .cat-strip {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 8px;
      margin-bottom: 10px;
      scrollbar-width: none;
    }
    .cat-strip::-webkit-scrollbar { display: none; }
    .cat-pill {
      white-space: nowrap;
      border: 1px solid var(--hairline);
      background: var(--canvas);
      color: var(--ink-soft);
      border-radius: 48px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .cat-pill.active {
      border-color: var(--primary);
      background: var(--primary);
      color: #ffffff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    @media (min-width: 600px) {
      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    .card {
      border: 1px solid var(--hairline);
      border-radius: 8px;
      background: var(--canvas);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      cursor: pointer;
      text-align: left;
      padding: 0;
      width: 100%;
    }
    .card.soldout { opacity: 0.55; cursor: not-allowed; }
    .card-img-wrap {
      height: 112px;
      width: 100%;
      background: var(--surface-1);
      border-bottom: 1px solid var(--hairline);
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .card-img-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .card-placeholder {
      font-size: 24px;
      font-weight: 700;
      color: var(--ink-muted);
      letter-spacing: 0.5px;
    }
    .card-body {
      padding: 10px;
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 4px;
    }
    .card-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
      line-height: 1.3;
    }
    .card-cat {
      font-size: 11px;
      color: var(--ink-muted);
    }
    .card-price-row {
      margin-top: auto;
      padding-top: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .card-price {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary-hover);
    }
    .plus-chip {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--primary-soft);
      color: var(--primary-hover);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
    }
    .cart-dock {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 25;
      background: var(--canvas);
      border-top: 1px solid var(--hairline);
      padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
    }
    .cart-dock-inner {
      max-width: 720px;
      margin: 0 auto;
    }
    .cart-dock-btn {
      width: 100%;
      min-height: 48px;
      border-radius: 48px;
      border: 0;
      background: var(--primary);
      color: #ffffff;
      font-size: 15px;
      font-weight: 700;
      padding: 0 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
    }
    .sheet-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
      background: rgba(32, 33, 36, 0.45);
      display: none;
      align-items: flex-end;
      justify-content: center;
    }
    .sheet-backdrop.open { display: flex; }
    .sheet {
      width: 100%;
      max-width: 640px;
      max-height: 88vh;
      overflow-y: auto;
      background: var(--canvas);
      border-top-left-radius: 16px;
      border-top-right-radius: 16px;
      border-top: 1px solid var(--hairline);
      padding: 18px 16px calc(18px + env(safe-area-inset-bottom, 0px));
    }
    .sheet-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--hairline);
      margin-bottom: 14px;
    }
    .sheet-title {
      font-size: 17px;
      font-weight: 700;
      margin: 0;
      color: var(--ink);
    }
    .close-btn {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 1px solid var(--hairline);
      background: var(--canvas);
      color: var(--ink-muted);
      font-size: 18px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .mod-group {
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--surface-2);
    }
    .mod-group-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
    }
    .mod-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      margin-bottom: 6px;
      cursor: pointer;
      background: var(--canvas);
    }
    .mod-option.selected {
      border-color: var(--primary);
      background: var(--primary-soft);
    }
    .field-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .input, .select {
      width: 100%;
      height: 42px;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 0 12px;
      font-size: 14px;
      color: var(--ink);
      background: var(--canvas);
      margin-bottom: 12px;
    }
    .qty-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 14px 0;
    }
    .stepper {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--hairline);
      border-radius: 48px;
      overflow: hidden;
    }
    .stepper button {
      width: 38px;
      height: 36px;
      border: 0;
      background: var(--surface-1);
      color: var(--ink);
      font-size: 18px;
      font-weight: 700;
      cursor: pointer;
    }
    .stepper span {
      min-width: 38px;
      text-align: center;
      font-weight: 700;
    }
    .cart-line {
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
    }
    .tracker-card {
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
      background: var(--canvas);
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin: 12px 0;
    }
    .step {
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 8px 4px;
      text-align: center;
      font-size: 11px;
      color: var(--ink-muted);
      background: var(--surface-1);
    }
    .step.done {
      border-color: var(--primary);
      background: var(--primary-soft);
      color: var(--primary-hover);
      font-weight: 700;
    }
    .step.ready {
      border-color: var(--ok);
      background: var(--ok-soft);
      color: var(--ok);
      font-weight: 700;
    }
    .empty-state {
      border: 1px dashed var(--hairline);
      border-radius: 8px;
      padding: 32px 16px;
      text-align: center;
      color: var(--ink-muted);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-row">
      <div>
        <h1 class="store-title" id="storeNameEl">${safeTitle}</h1>
        <div class="store-sub" id="storeSubEl"></div>
      </div>
      <div class="lang-bar" role="group" aria-label="Language">
        <button type="button" class="lang-btn" data-lang="lo">ລາວ</button>
        <button type="button" class="lang-btn" data-lang="th">ไทย</button>
        <button type="button" class="lang-btn" data-lang="en">EN</button>
      </div>
    </div>
  </header>

  <main class="wrap">
    <div id="captiveBanner" class="banner" style="display:none;"></div>
    <div id="alertBanner" class="banner" style="display:none;"></div>

    <div class="tabs">
      <button type="button" id="tabMenuBtn" class="tab-btn active"></button>
      <button type="button" id="tabOrdersBtn" class="tab-btn"></button>
    </div>

    <div id="serviceBar" style="display:none;gap:8px;margin-bottom:12px;"></div>

    <section id="menuSection">
      <input type="search" id="searchInput" class="search-box" autocomplete="off" />
      <div id="catStrip" class="cat-strip"></div>
      <div id="menuGrid" class="grid"></div>
    </section>

    <section id="ordersSection" style="display:none;"></section>
  </main>

  <div id="cartDock" class="cart-dock" style="display:none;">
    <div class="cart-dock-inner">
      <button type="button" id="openCartBtn" class="cart-dock-btn">
        <span id="cartDockLabel"></span>
        <span id="cartDockTotal" class="tnum"></span>
      </button>
    </div>
  </div>

  <!-- Item Detail & Modifiers Bottom Sheet -->
  <div id="itemSheetBackdrop" class="sheet-backdrop" role="dialog" aria-modal="true">
    <div class="sheet" id="itemSheetContent"></div>
  </div>

  <!-- Cart & Submit Order Bottom Sheet -->
  <div id="cartSheetBackdrop" class="sheet-backdrop" role="dialog" aria-modal="true">
    <div class="sheet" id="cartSheetContent"></div>
  </div>

  <script>
    (function () {
      const BOOT = ${bootJson};
      const STORAGE_ORDERS_KEY = 'rube_guest_qr_orders_v1';
      const STORAGE_TOKENS_KEY = 'rube_guest_qr_tokens_v1';

      const TEXT = {
        th: {
          tabMenu: 'เลือกเมนูอาหาร',
          tabOrders: 'สถานะออเดอร์',
          searchPlaceholder: 'ค้นหาเมนูอาหารหรือเครื่องดื่ม...',
          allCat: 'ทั้งหมด',
          soldOut: 'หมดชั่วคราว',
          tablePrefix: 'โต๊ะ',
          signedOk: 'ยืนยันโต๊ะอัตโนมัติ',
          signedExpired: 'QR โต๊ะนี้หมดอายุหรือปิดบิลแล้ว กรุณาขอใบ QR ใหม่จากพนักงาน',
          captiveTip: 'หากกำลังเปิดผ่านหน้าต่าง Wi-Fi แนะนำให้คัดลอกลิงก์ไปเปิดใน Safari / Chrome เพื่อให้สั่งเพิ่มได้สะดวก',
          copyLink: 'คัดลอกลิงก์เมนู',
          copied: 'คัดลอกลิงก์แล้ว',
          viewCart: 'ดูตะกร้าสั่งอาหาร',
          itemsUnit: 'รายการ',
          addToCart: 'เพิ่มลงตะกร้า',
          noteLabel: 'โน้ตถึงครัว (เช่น ไม่ใส่ผัก / หวานน้อย)',
          notePlaceholder: 'ระบุคำขอเพิ่มเติม (ถ้ามี)',
          qtyLabel: 'จำนวน',
          cartTitle: 'ตะกร้าออเดอร์ของคุณ',
          selectTableLabel: 'เลือกหมายเลขโต๊ะ / รับกลับบ้าน',
          customerNameLabel: 'ชื่อผู้สั่ง (ไม่บังคับ)',
          customerNamePlaceholder: 'เช่น คุณเอ / โต๊ะริมหน้าต่าง',
          orderNoteLabel: 'หมายเหตุรวมทั้งออเดอร์ (ไม่บังคับ)',
          subtotal: 'ยอดรวมเมนู',
          estimatedTotal: 'ยอดประมาณการ (ชำระเงินตอนเช็กบิล)',
          placeOrder: 'ส่งออเดอร์เข้าครัว',
          sending: 'กำลังส่งออเดอร์...',
          orderSuccess: 'ส่งออเดอร์เรียบร้อยแล้ว! เลขออเดอร์:',
          noOrdersYet: 'ยังไม่มีรายการออเดอร์ที่ส่งจากเครื่องนี้',
          orderMore: 'สั่งเมนูเพิ่มเติม',
          stepPending: 'รอร้านรับ',
          stepAccepted: 'รับออเดอร์แล้ว',
          stepPreparing: 'กำลังทำ',
          stepReady: 'พร้อมเสิร์ฟ',
          statusServed: 'เสิร์ฟเรียบร้อยแล้ว',
          statusSettled: 'ชำระเงินปิดบิลเรียบร้อยแล้ว',
          statusRejected: 'ร้านไม่สามารถรับออเดอร์ได้',
          callStaff: 'เรียกพนักงาน',
          requestBill: 'ขอเช็กบิล',
          serviceCallSent: 'ส่งคำขอไปยังเคาน์เตอร์เรียบร้อยแล้ว',
          reasonPrefix: 'เหตุผล:',
          loadingMenu: 'กำลังโหลดรายการเมนู...',
          loadError: 'ไม่สามารถเชื่อมต่อระบบร้านค้าในวง Wi-Fi ได้ กรุณาลองใหม่',
          remove: 'ลบ',
          free: 'ฟรี',
          pickOne: 'เลือกได้ 1 อย่าง',
          pickMany: 'เลือกได้หลายอย่าง',
          emptyMenu: 'ไม่พบเมนูที่ค้นหา',
        },
        lo: {
          tabMenu: 'ເລືອກເມນູອາຫານ',
          tabOrders: 'ສະຖານະອໍເດີ',
          searchPlaceholder: 'ຄົ້ນຫາເມນູອາຫານ ຫຼື ເຄື່ອງດື່ມ...',
          allCat: 'ທັງໝົດ',
          soldOut: 'ໝົດຊົ່ວຄາວ',
          tablePrefix: 'ໂຕະ',
          signedOk: 'ຢືນຢັນໂຕະອັດຕະໂນມັດ',
          signedExpired: 'QR ໂຕະນີ້ໝົດອາຍຸ ຫຼື ປິດບິນແລ້ວ ກະລຸນາຂໍໃບ QR ໃໝ່ຈາກພະນັກງານ',
          captiveTip: 'ຫາກເປີດຜ່ານໜ້າຕ່າງ Wi-Fi ແນະນຳໃຫ້ຄັດລອກລິ້ງໄປເປີດໃນ Safari / Chrome ເພື່ອສັ່ງເພີ່ມໄດ້ສະດວກ',
          copyLink: 'ຄັດລອກລິ້ງເມນູ',
          copied: 'ຄັດລອກລິ້ງແລ້ວ',
          viewCart: 'ເບິ່ງກະຕ່າສັ່ງອາຫານ',
          itemsUnit: 'ລາຍການ',
          addToCart: 'ເພີ່ມລົງກະຕ່າ',
          noteLabel: 'ໝາຍເຫດເຖິງຄົວ (ເຊັ່ນ ບໍ່ໃສ່ຜັກ / ຫວານໜ້ອຍ)',
          notePlaceholder: 'ລະບຸຄຳຂໍເພີ່ມເຕີມ (ຖ້າມີ)',
          qtyLabel: 'ຈຳນວນ',
          cartTitle: 'ກະຕ່າອໍເດີຂອງທ່ານ',
          selectTableLabel: 'ເລືອກເລກໂຕະ / ກັບບ້ານ',
          customerNameLabel: 'ຊື່ຜູ້ສັ່ງ (ບໍ່ບັງຄັບ)',
          customerNamePlaceholder: 'ເຊັ່ນ ທ້າວ ກ / ໂຕະແຄມປ່ອງຢ້ຽມ',
          orderNoteLabel: 'ໝາຍເຫດລວມທັງອໍເດີ (ບໍ່ບັງຄັບ)',
          subtotal: 'ລວມລາຄາເມນູ',
          estimatedTotal: 'ຍອດປະມານການ (ຊຳລະເງິນຕອນເຊັກບິນ)',
          placeOrder: 'ສົ່ງອໍເດີເຂົ້າຄົວ',
          sending: 'ກຳລັງສົ່ງອໍເດີ...',
          orderSuccess: 'ສົ່ງອໍເດີສຳເລັດແລ້ວ! ເລກອໍເດີ:',
          noOrdersYet: 'ຍັງບໍ່ມີລາຍການອໍເດີຈາກເຄື່ອງນີ້',
          orderMore: 'ສັ່ງເມນູເພີ່ມເຕີມ',
          stepPending: 'ລໍຖ້າຮ້ານຮັບ',
          stepAccepted: 'ຮັບອໍເດີແລ້ວ',
          stepPreparing: 'ກຳລັງປຸງແຕ່ງ',
          stepReady: 'ພ້ອມເສີບ',
          statusServed: 'ເສີບສຳເລັດແລ້ວ',
          statusSettled: 'ຊຳລະເງິນປິດບິນສຳເລັດແລ້ວ',
          statusRejected: 'ຮ້ານບໍ່ສາມາດຮັບອໍເດີໄດ້',
          callStaff: 'ເອີ້ນພະນັກງານ',
          requestBill: 'ຂໍເຊັກບິນ',
          serviceCallSent: 'ສົ່ງຄຳຂໍໄປຍັງເຄົາເຕີສຳເລັດແລ້ວ',
          reasonPrefix: 'ເຫດຜົນ:',
          loadingMenu: 'ກຳລັງໂຫຼດລາຍການເມນູ...',
          loadError: 'ບໍ່ສາມາດເຊື່ອມຕໍ່ລະບົບຮ້ານໃນວົງ Wi-Fi ໄດ້',
          remove: 'ລຶບ',
          free: 'ຟຣີ',
          pickOne: 'ເລືອກໄດ້ 1 ຢ່າງ',
          pickMany: 'ເລືອກໄດ້ຫຼາຍຢ່າງ',
          emptyMenu: 'ບໍ່ພົບເມນູທີ່ຄົ້ນຫາ',
        },
        en: {
          tabMenu: 'Menu',
          tabOrders: 'Order Status',
          searchPlaceholder: 'Search food or drinks...',
          allCat: 'All',
          soldOut: 'Sold Out',
          tablePrefix: 'Table',
          signedOk: 'Verified Table',
          signedExpired: 'This Table QR has expired or been settled. Please ask staff for a new QR slip.',
          captiveTip: 'Opened inside Wi-Fi login popup? Copy the menu link to open full-screen in Safari or Chrome.',
          copyLink: 'Copy Link',
          copied: 'Link Copied',
          viewCart: 'View Cart',
          itemsUnit: 'items',
          addToCart: 'Add to Cart',
          noteLabel: 'Kitchen Note (e.g. Less sweet / No ice)',
          notePlaceholder: 'Optional preparation note',
          qtyLabel: 'Quantity',
          cartTitle: 'Your Order Cart',
          selectTableLabel: 'Select Table / Takeaway',
          customerNameLabel: 'Your Name (Optional)',
          customerNamePlaceholder: 'e.g. Alex',
          orderNoteLabel: 'Order Note (Optional)',
          subtotal: 'Subtotal',
          estimatedTotal: 'Estimated Total (Pay at counter)',
          placeOrder: 'Place Order',
          sending: 'Submitting order...',
          orderSuccess: 'Order sent! Order Code:',
          noOrdersYet: 'No orders submitted from this device yet.',
          orderMore: 'Order More Items',
          stepPending: 'Pending',
          stepAccepted: 'Accepted',
          stepPreparing: 'Preparing',
          stepReady: 'Ready',
          statusServed: 'Served',
          statusSettled: 'Bill Settled',
          statusRejected: 'Order Declined',
          callStaff: 'Call Staff',
          requestBill: 'Request Bill',
          serviceCallSent: 'Request sent to staff',
          reasonPrefix: 'Reason:',
          loadingMenu: 'Loading menu...',
          loadError: 'Unable to reach the store Wi-Fi ordering server.',
          remove: 'Remove',
          free: 'Free',
          pickOne: 'Choose 1',
          pickMany: 'Multiple allowed',
          emptyMenu: 'No matching menu items',
        },
      };

      const state = {
        lang: BOOT.defaultLocale || 'th',
        tab: 'menu',
        menu: null,
        selectedCategoryId: 'ALL',
        search: '',
        cart: [],
        selectedTable: BOOT.initialTable || '',
        customerName: '',
        customerNote: '',
        submitting: false,
        activeItem: null,
        itemQty: 1,
        itemMods: {},
        itemNote: '',
        trackedOrderIds: [],
        trackedOrderTokens: {},
        cartSubmissionKey: '',
        trackedOrders: {},
        bannerText: '',
        bannerTone: 'info',
      };

      try {
        const savedIds = JSON.parse(window.localStorage.getItem(STORAGE_ORDERS_KEY) || '[]');
        if (Array.isArray(savedIds)) {
          state.trackedOrderIds = savedIds.slice(0, 15);
        }
        const savedTokens = JSON.parse(window.localStorage.getItem(STORAGE_TOKENS_KEY) || '{}');
        if (savedTokens && typeof savedTokens === 'object') {
          state.trackedOrderTokens = savedTokens;
        }
      } catch (_e) {}

      function resetCartSubmissionKey() {
        state.cartSubmissionKey =
          'GSUB-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }

      function L() {
        return TEXT[state.lang] || TEXT.th;
      }

      function esc(str) {
        return String(str == null ? '' : str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatSatang(satang) {
        const amt = Number(satang || 0);
        const abs = Math.abs(Math.trunc(amt));
        const sign = amt < 0 ? '-' : '';
        if (state.menu && state.menu.currencyCode === 'LAK') {
          const wholeKip = Math.round(abs / 100);
          return sign + wholeKip.toLocaleString('en-US') + ' ₭';
        }
        const baht = Math.floor(abs / 100);
        const rem = abs % 100;
        return sign + '฿' + baht.toLocaleString('en-US') + '.' + String(rem).padStart(2, '0');
      }

      function setBanner(text, tone) {
        state.bannerText = text;
        state.bannerTone = tone || 'info';
        renderBanner();
      }

      function renderBanner() {
        const el = document.getElementById('alertBanner');
        if (!state.bannerText) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'flex';
        el.className = 'banner' + (state.bannerTone === 'error' ? ' banner-warn' : state.bannerTone === 'ok' ? ' banner-ok' : '');
        el.innerHTML = '<span>' + esc(state.bannerText) + '</span>';
      }

      function renderCaptiveBanner() {
        const el = document.getElementById('captiveBanner');
        if (!BOOT.isCaptiveMode) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'flex';
        el.innerHTML =
          '<span>' + esc(L().captiveTip) + '</span>' +
          '<button type="button" id="copyUrlBtn" class="btn btn-sm">' + esc(L().copyLink) + '</button>';
        const btn = document.getElementById('copyUrlBtn');
        if (btn) {
          btn.onclick = function () {
            const targetUrl = window.location.href.replace(/[?&]captive=1/, '');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(targetUrl).then(function () {
                btn.textContent = L().copied;
              }).catch(function () {});
            }
          };
        }
      }

      function renderTopbar() {
        document.querySelectorAll('.lang-btn').forEach(function (btn) {
          btn.classList.toggle('active', btn.getAttribute('data-lang') === state.lang);
        });
        const titleEl = document.getElementById('storeNameEl');
        const subEl = document.getElementById('storeSubEl');
        if (state.menu) {
          titleEl.textContent = state.menu.storeName;
          const badges = [];
          if (state.menu.lockedTableLabel && state.menu.signedTableValid) {
            badges.push('<span class="badge badge-primary">' + esc(L().tablePrefix) + ' ' + esc(state.menu.lockedTableLabel) + ' · ' + esc(L().signedOk) + '</span>');
          } else if (state.selectedTable) {
            badges.push('<span class="badge">' + esc(L().tablePrefix) + ' ' + esc(state.selectedTable) + '</span>');
          }
          if (state.menu.wifiSsid) {
            badges.push('<span class="badge">Wi-Fi: ' + esc(state.menu.wifiSsid) + '</span>');
          }
          subEl.innerHTML = badges.join('');
        }
      }

      function renderTabs() {
        const tMenu = document.getElementById('tabMenuBtn');
        const tOrd = document.getElementById('tabOrdersBtn');
        tMenu.textContent = L().tabMenu;
        const count = state.trackedOrderIds.length;
        tOrd.textContent = count > 0 ? L().tabOrders + ' (' + count + ')' : L().tabOrders;
        tMenu.classList.toggle('active', state.tab === 'menu');
        tOrd.classList.toggle('active', state.tab === 'orders');
        document.getElementById('menuSection').style.display = state.tab === 'menu' ? 'block' : 'none';
        document.getElementById('ordersSection').style.display = state.tab === 'orders' ? 'block' : 'none';
        renderServiceBar();
      }

      function renderServiceBar() {
        const bar = document.getElementById('serviceBar');
        if (!bar) return;
        const canCall = Boolean(
          state.menu &&
          ((state.menu.lockedTableLabel && state.menu.signedTableValid) || state.menu.allowOpenTableSelection)
        );
        if (!canCall) {
          bar.style.display = 'none';
          bar.innerHTML = '';
          return;
        }
        bar.style.display = 'flex';
        bar.innerHTML =
          '<button type="button" id="callStaffBtn" class="btn btn-sm" style="flex:1;">' + esc(L().callStaff) + '</button>' +
          '<button type="button" id="requestBillBtn" class="btn btn-sm" style="flex:1;">' + esc(L().requestBill) + '</button>';
        document.getElementById('callStaffBtn').onclick = function () { void sendServiceCall('CALL_STAFF'); };
        document.getElementById('requestBillBtn').onclick = function () { void sendServiceCall('REQUEST_BILL'); };
      }

      async function sendServiceCall(callType) {
        if (!state.menu) return;
        const tableToSend = (state.menu.lockedTableLabel && state.menu.signedTableValid)
          ? state.menu.lockedTableLabel
          : (state.selectedTable || (state.menu.tableLabels && state.menu.tableLabels[0]) || 'T01');
        try {
          const res = await fetch('/api/guest/service-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              outletId: BOOT.outletId,
              tableLabel: tableToSend,
              signedToken: state.menu.signedTableValid ? BOOT.initialToken : '',
              callType: callType,
            }),
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          setBanner(L().serviceCallSent + ' (' + tableToSend + ')', 'ok');
        } catch (err) {
          setBanner(err && err.message ? err.message : L().loadError, 'error');
        }
      }

      function renderCategoriesAndMenu() {
        const searchEl = document.getElementById('searchInput');
        searchEl.placeholder = L().searchPlaceholder;

        const strip = document.getElementById('catStrip');
        const grid = document.getElementById('menuGrid');
        if (!state.menu) {
          grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">' + esc(L().loadingMenu) + '</div>';
          return;
        }

        const catButtons = [
          '<button type="button" class="cat-pill' + (state.selectedCategoryId === 'ALL' ? ' active' : '') + '" data-cat="ALL">' + esc(L().allCat) + '</button>'
        ];
        state.menu.categories.forEach(function (c) {
          catButtons.push(
            '<button type="button" class="cat-pill' + (state.selectedCategoryId === c.id ? ' active' : '') + '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</button>'
          );
        });
        strip.innerHTML = catButtons.join('');
        strip.querySelectorAll('.cat-pill').forEach(function (btn) {
          btn.onclick = function () {
            state.selectedCategoryId = btn.getAttribute('data-cat') || 'ALL';
            renderCategoriesAndMenu();
          };
        });

        const q = state.search.trim().toLowerCase();
        const filtered = state.menu.items.filter(function (it) {
          if (state.selectedCategoryId !== 'ALL' && it.categoryId !== state.selectedCategoryId) {
            return false;
          }
          if (q && it.itemName.toLowerCase().indexOf(q) === -1 && it.categoryName.toLowerCase().indexOf(q) === -1) {
            return false;
          }
          return true;
        });

        if (filtered.length === 0) {
          grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">' + esc(L().emptyMenu) + '</div>';
          return;
        }

        grid.innerHTML = filtered.map(function (it) {
          const initials = (it.itemName || 'M').slice(0, 2).toUpperCase();
          const imgHtml = it.imageUrl
            ? '<img src="' + esc(it.imageUrl) + '" alt="' + esc(it.itemName) + '" loading="lazy" />'
            : '<div class="card-placeholder">' + esc(initials) + '</div>';
          const rightAction = it.isAvailable
            ? '<span class="plus-chip">+</span>'
            : '<span class="badge badge-danger">' + esc(L().soldOut) + '</span>';
          return (
            '<button type="button" class="card' + (it.isAvailable ? '' : ' soldout') + '" data-vid="' + esc(it.variantId) + '"' + (it.isAvailable ? '' : ' disabled') + '>' +
              '<div class="card-img-wrap">' + imgHtml + '</div>' +
              '<div class="card-body">' +
                '<div class="card-cat">' + esc(it.categoryName) + '</div>' +
                '<div class="card-name">' + esc(it.itemName) + '</div>' +
                '<div class="card-price-row">' +
                  '<span class="card-price tnum">' + esc(formatSatang(it.priceSatang)) + '</span>' +
                  rightAction +
                '</div>' +
              '</div>' +
            '</button>'
          );
        }).join('');

        grid.querySelectorAll('.card[data-vid]').forEach(function (card) {
          card.onclick = function () {
            const vid = card.getAttribute('data-vid');
            const found = state.menu.items.find(function (x) { return x.variantId === vid; });
            if (found && found.isAvailable) {
              openItemSheet(found);
            }
          };
        });
      }

      function computeCartLineTotalSatang(line) {
        const modSum = line.modifiers.reduce(function (s, m) { return s + Number(m.priceDeltaSatang || 0); }, 0);
        return Math.max(0, (Number(line.unitPriceSatang || 0) + modSum) * Number(line.quantityCount || 1));
      }

      function renderCartDock() {
        const dock = document.getElementById('cartDock');
        const totalCount = state.cart.reduce(function (s, l) { return s + l.quantityCount; }, 0);
        if (totalCount === 0 || state.tab !== 'menu') {
          dock.style.display = 'none';
          return;
        }
        const totalSatang = state.cart.reduce(function (s, l) { return s + computeCartLineTotalSatang(l); }, 0);
        dock.style.display = 'block';
        document.getElementById('cartDockLabel').textContent = L().viewCart + ' (' + totalCount + ' ' + L().itemsUnit + ')';
        document.getElementById('cartDockTotal').textContent = formatSatang(totalSatang);
      }

      function openItemSheet(item) {
        state.activeItem = item;
        state.itemQty = 1;
        state.itemMods = {};
        state.itemNote = '';
        renderItemSheet();
        document.getElementById('itemSheetBackdrop').classList.add('open');
      }

      function closeItemSheet() {
        document.getElementById('itemSheetBackdrop').classList.remove('open');
        state.activeItem = null;
      }

      function renderItemSheet() {
        const item = state.activeItem;
        if (!item || !state.menu) return;
        const maxQty = state.menu.maxQtyPerItem || 20;
        const groups = item.isComposite || item.kitchenStation === 'BAR' || item.kitchenStation === 'MAIN'
          ? state.menu.modifierGroups
          : [];

        let modDeltaPerUnit = 0;
        const selectedModObjs = [];
        groups.forEach(function (g) {
          const picked = state.itemMods[g.id] || [];
          picked.forEach(function (mid) {
            const m = g.modifiers.find(function (x) { return x.id === mid; });
            if (m) {
              modDeltaPerUnit += Number(m.priceDeltaSatang || 0);
              selectedModObjs.push(m);
            }
          });
        });
        const lineTotal = Math.max(0, (Number(item.priceSatang) + modDeltaPerUnit) * state.itemQty);

        let html =
          '<div class="sheet-header">' +
            '<div>' +
              '<h2 class="sheet-title">' + esc(item.itemName) + '</h2>' +
              '<div class="store-sub tnum">' + esc(formatSatang(item.priceSatang)) + ' · ' + esc(item.categoryName) + '</div>' +
            '</div>' +
            '<button type="button" class="close-btn" id="closeItemSheetBtn" aria-label="Close">&times;</button>' +
          '</div>';

        groups.forEach(function (g) {
          const picked = state.itemMods[g.id] || [];
          html += '<div class="mod-group">';
          html += '<div class="mod-group-title"><span>' + esc(g.name) + '</span><span style="color:var(--ink-muted);font-weight:500;">' + esc(g.selectionType === 'SINGLE' ? L().pickOne : L().pickMany) + '</span></div>';
          g.modifiers.forEach(function (m) {
            const isSel = picked.indexOf(m.id) !== -1;
            const deltaText = m.priceDeltaSatang > 0 ? '+' + formatSatang(m.priceDeltaSatang) : (m.priceDeltaSatang < 0 ? formatSatang(m.priceDeltaSatang) : L().free);
            html +=
              '<div class="mod-option' + (isSel ? ' selected' : '') + '" data-gid="' + esc(g.id) + '" data-mid="' + esc(m.id) + '" data-seltype="' + esc(g.selectionType) + '">' +
                '<span>' + esc(m.name) + '</span>' +
                '<span class="tnum" style="font-size:13px;color:var(--ink-soft);">' + esc(deltaText) + '</span>' +
              '</div>';
          });
          html += '</div>';
        });

        html +=
          '<label class="field-label" for="itemNoteInput">' + esc(L().noteLabel) + '</label>' +
          '<input type="text" id="itemNoteInput" class="input" maxlength="120" value="' + esc(state.itemNote) + '" placeholder="' + esc(L().notePlaceholder) + '" />' +
          '<div class="qty-row">' +
            '<span style="font-weight:600;">' + esc(L().qtyLabel) + '</span>' +
            '<div class="stepper">' +
              '<button type="button" id="qtyMinusBtn">&minus;</button>' +
              '<span class="tnum">' + state.itemQty + '</span>' +
              '<button type="button" id="qtyPlusBtn">+</button>' +
            '</div>' +
          '</div>' +
          '<button type="button" id="confirmAddItemBtn" class="btn btn-primary" style="width:100%;min-height:46px;font-size:15px;">' +
            esc(L().addToCart) + ' · <span class="tnum">' + esc(formatSatang(lineTotal)) + '</span>' +
          '</button>';

        const container = document.getElementById('itemSheetContent');
        container.innerHTML = html;

        document.getElementById('closeItemSheetBtn').onclick = closeItemSheet;
        document.getElementById('itemNoteInput').oninput = function (e) {
          state.itemNote = e.target.value;
        };
        document.getElementById('qtyMinusBtn').onclick = function () {
          if (state.itemQty > 1) { state.itemQty -= 1; renderItemSheet(); }
        };
        document.getElementById('qtyPlusBtn').onclick = function () {
          if (state.itemQty < maxQty) { state.itemQty += 1; renderItemSheet(); }
        };
        container.querySelectorAll('.mod-option').forEach(function (opt) {
          opt.onclick = function () {
            const gid = opt.getAttribute('data-gid');
            const mid = opt.getAttribute('data-mid');
            const selType = opt.getAttribute('data-seltype');
            const cur = state.itemMods[gid] || [];
            if (selType === 'SINGLE') {
              state.itemMods[gid] = cur[0] === mid ? [] : [mid];
            } else {
              if (cur.indexOf(mid) !== -1) {
                state.itemMods[gid] = cur.filter(function (x) { return x !== mid; });
              } else {
                state.itemMods[gid] = cur.concat([mid]);
              }
            }
            renderItemSheet();
          };
        });
        document.getElementById('confirmAddItemBtn').onclick = function () {
          const modIds = selectedModObjs.map(function (m) { return m.id; }).sort();
          const noteTrim = state.itemNote.trim();
          const lineKey = item.variantId + '::' + modIds.join(',') + '::' + noteTrim;
          const existing = state.cart.find(function (l) { return l.lineKey === lineKey; });
          if (existing) {
            existing.quantityCount = Math.min(maxQty, existing.quantityCount + state.itemQty);
          } else {
            state.cart.push({
              lineKey: lineKey,
              variantId: item.variantId,
              itemName: item.itemName,
              unitPriceSatang: item.priceSatang,
              quantityCount: state.itemQty,
              selectedModifierIds: modIds,
              modifiers: selectedModObjs,
              note: noteTrim,
            });
          }
          closeItemSheet();
          resetCartSubmissionKey();
          renderCartDock();
        };
      }

      function openCartSheet() {
        renderCartSheet();
        document.getElementById('cartSheetBackdrop').classList.add('open');
      }

      function closeCartSheet() {
        document.getElementById('cartSheetBackdrop').classList.remove('open');
      }

      function renderCartSheet() {
        const container = document.getElementById('cartSheetContent');
        if (!state.menu) return;
        const maxQty = state.menu.maxQtyPerItem || 20;
        const isLockedTable = Boolean(state.menu.lockedTableLabel && state.menu.signedTableValid);
        const subtotal = state.cart.reduce(function (s, l) { return s + computeCartLineTotalSatang(l); }, 0);

        let html =
          '<div class="sheet-header">' +
            '<h2 class="sheet-title">' + esc(L().cartTitle) + '</h2>' +
            '<button type="button" class="close-btn" id="closeCartSheetBtn" aria-label="Close">&times;</button>' +
          '</div>';

        if (isLockedTable) {
          html += '<div class="banner banner-ok" style="margin-bottom:12px;"><span>' + esc(L().tablePrefix) + ' <strong>' + esc(state.menu.lockedTableLabel) + '</strong> · ' + esc(L().signedOk) + '</span></div>';
        } else {
          html += '<label class="field-label" for="tableSelect">' + esc(L().selectTableLabel) + '</label>';
          html += '<select id="tableSelect" class="select">';
          (state.menu.tableLabels || []).forEach(function (tbl) {
            const sel = tbl === state.selectedTable ? ' selected' : '';
            html += '<option value="' + esc(tbl) + '"' + sel + '>' + esc(tbl) + '</option>';
          });
          html += '</select>';
        }

        state.cart.forEach(function (line, idx) {
          const modsStr = line.modifiers.map(function (m) { return m.name; }).join(', ');
          const lineTotal = computeCartLineTotalSatang(line);
          html +=
            '<div class="cart-line">' +
              '<div style="flex:1;">' +
                '<div style="font-weight:600;">' + esc(line.itemName) + '</div>' +
                (modsStr ? '<div style="font-size:12px;color:var(--ink-muted);">+ ' + esc(modsStr) + '</div>' : '') +
                (line.note ? '<div style="font-size:12px;color:var(--primary-hover);">Note: ' + esc(line.note) + '</div>' : '') +
                '<div class="tnum" style="font-size:13px;font-weight:700;margin-top:4px;">' + esc(formatSatang(lineTotal)) + '</div>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">' +
                '<div class="stepper">' +
                  '<button type="button" data-cidx="' + idx + '" data-cdelta="-1">&minus;</button>' +
                  '<span class="tnum">' + line.quantityCount + '</span>' +
                  '<button type="button" data-cidx="' + idx + '" data-cdelta="1">+</button>' +
                '</div>' +
                '<button type="button" class="btn btn-sm" data-cremove="' + idx + '">' + esc(L().remove) + '</button>' +
              '</div>' +
            '</div>';
        });

        html +=
          '<label class="field-label" for="custNameInput" style="margin-top:10px;">' + esc(L().customerNameLabel) + '</label>' +
          '<input type="text" id="custNameInput" class="input" maxlength="50" value="' + esc(state.customerName) + '" placeholder="' + esc(L().customerNamePlaceholder) + '" />' +
          '<label class="field-label" for="custNoteInput">' + esc(L().orderNoteLabel) + '</label>' +
          '<input type="text" id="custNoteInput" class="input" maxlength="160" value="' + esc(state.customerNote) + '" />' +
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid var(--hairline);margin-bottom:10px;">' +
            '<span style="font-size:13px;color:var(--ink-muted);">' + esc(L().estimatedTotal) + '</span>' +
            '<strong class="tnum" style="font-size:18px;color:var(--ink);">' + esc(formatSatang(subtotal)) + '</strong>' +
          '</div>' +
          '<button type="button" id="submitOrderBtn" class="btn btn-primary" style="width:100%;min-height:48px;font-size:15px;"' + (state.submitting || state.cart.length === 0 ? ' disabled' : '') + '>' +
            esc(state.submitting ? L().sending : L().placeOrder) +
          '</button>';

        container.innerHTML = html;
        document.getElementById('closeCartSheetBtn').onclick = closeCartSheet;
        const tblSel = document.getElementById('tableSelect');
        if (tblSel) {
          tblSel.onchange = function (e) {
            state.selectedTable = e.target.value;
            renderTopbar();
          };
        }
        document.getElementById('custNameInput').oninput = function (e) { state.customerName = e.target.value; };
        document.getElementById('custNoteInput').oninput = function (e) { state.customerNote = e.target.value; };
        container.querySelectorAll('button[data-cidx]').forEach(function (btn) {
          btn.onclick = function () {
            const idx = Number(btn.getAttribute('data-cidx'));
            const delta = Number(btn.getAttribute('data-cdelta'));
            const item = state.cart[idx];
            if (!item) return;
            const nextQty = item.quantityCount + delta;
            if (nextQty <= 0) {
              state.cart.splice(idx, 1);
            } else {
              item.quantityCount = Math.min(maxQty, nextQty);
            }
            if (state.cart.length === 0) {
              closeCartSheet();
            } else {
              renderCartSheet();
            }
            resetCartSubmissionKey();
            renderCartDock();
          };
        });
        container.querySelectorAll('button[data-cremove]').forEach(function (btn) {
          btn.onclick = function () {
            const idx = Number(btn.getAttribute('data-cremove'));
            state.cart.splice(idx, 1);
            if (state.cart.length === 0) {
              closeCartSheet();
            } else {
              renderCartSheet();
            }
            resetCartSubmissionKey();
            renderCartDock();
          };
        });
        document.getElementById('submitOrderBtn').onclick = submitGuestOrder;
      }

      async function submitGuestOrder() {
        if (state.submitting || state.cart.length === 0 || !state.menu) return;
        const tableToSend = (state.menu.lockedTableLabel && state.menu.signedTableValid)
          ? state.menu.lockedTableLabel
          : (state.selectedTable || (state.menu.tableLabels && state.menu.tableLabels[0]) || 'T01');
        if (!state.cartSubmissionKey) {
          resetCartSubmissionKey();
        }

        state.submitting = true;
        renderCartSheet();
        try {
          const payload = {
            outletId: BOOT.outletId,
            tableLabel: tableToSend,
            signedToken: state.menu.signedTableValid ? BOOT.initialToken : '',
            customerName: state.customerName.trim(),
            customerNote: state.customerNote.trim(),
            clientSubmissionKey: state.cartSubmissionKey,
            lines: state.cart.map(function (l) {
              return {
                variantId: l.variantId,
                quantityCount: l.quantityCount,
                selectedModifierIds: l.selectedModifierIds,
                note: l.note,
              };
            }),
          };
          const res = await fetch('/api/guest/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) {
            throw new Error(data.error || ('HTTP ' + res.status));
          }
          const created = data.order;
          if (created && created.id) {
            state.trackedOrders[created.id] = created;
            if (created.trackingToken) {
              state.trackedOrderTokens[created.id] = created.trackingToken;
            }
            state.trackedOrderIds = [created.id].concat(
              state.trackedOrderIds.filter(function (x) { return x !== created.id; })
            ).slice(0, 15);
            try {
              window.localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(state.trackedOrderIds));
              window.localStorage.setItem(STORAGE_TOKENS_KEY, JSON.stringify(state.trackedOrderTokens));
            } catch (_e) {}
            setBanner(L().orderSuccess + ' ' + created.orderCode, 'ok');
          }
          state.cart = [];
          state.cartSubmissionKey = '';
          state.customerNote = '';
          closeCartSheet();
          state.tab = 'orders';
          renderTabs();
          renderCartDock();
          renderOrdersTracker();
        } catch (err) {
          setBanner(err && err.message ? err.message : L().loadError, 'error');
        } finally {
          state.submitting = false;
          if (document.getElementById('cartSheetBackdrop').classList.contains('open')) {
            renderCartSheet();
          }
        }
      }

      function renderOrdersTracker() {
        const sec = document.getElementById('ordersSection');
        if (state.trackedOrderIds.length === 0) {
          sec.innerHTML =
            '<div class="empty-state">' +
              '<div style="margin-bottom:12px;">' + esc(L().noOrdersYet) + '</div>' +
              '<button type="button" class="btn btn-primary" id="backToMenuBtn">' + esc(L().orderMore) + '</button>' +
            '</div>';
          const btn = document.getElementById('backToMenuBtn');
          if (btn) btn.onclick = function () { state.tab = 'menu'; renderTabs(); renderCartDock(); };
          return;
        }

        const cards = state.trackedOrderIds.map(function (id) {
          const ord = state.trackedOrders[id];
          if (!ord) return '';
          const stepIndex =
            ord.status === 'PENDING_CONFIRM' ? 0
              : ord.status === 'ACCEPTED' ? 1
                : ord.status === 'PREPARING' ? 2
                  : (ord.status === 'READY' || ord.status === 'SERVED') ? 3 : -1;

          let statusHtml = '';
          if (ord.status === 'REJECTED') {
            statusHtml =
              '<div class="banner banner-warn" style="margin:10px 0 6px;">' +
                '<div><strong>' + esc(L().statusRejected) + '</strong>' +
                (ord.rejectionReason ? '<div>' + esc(L().reasonPrefix) + ' ' + esc(ord.rejectionReason) + '</div>' : '') +
                '</div>' +
              '</div>';
          } else if (ord.status === 'SETTLED') {
            statusHtml =
              '<div class="banner banner-ok" style="margin:10px 0 6px;">' +
                '<strong>' + esc(L().statusSettled) + '</strong>' +
              '</div>';
          } else {
            statusHtml =
              '<div class="steps">' +
                '<div class="step' + (stepIndex >= 0 ? ' done' : '') + '">' + esc(L().stepPending) + '</div>' +
                '<div class="step' + (stepIndex >= 1 ? ' done' : '') + '">' + esc(L().stepAccepted) + '</div>' +
                '<div class="step' + (stepIndex >= 2 ? ' done' : '') + '">' + esc(L().stepPreparing) + '</div>' +
                '<div class="step' + (stepIndex >= 3 ? ' ready' : '') + '">' + esc(ord.status === 'SERVED' ? L().statusServed : L().stepReady) + '</div>' +
              '</div>';
          }

          const linesHtml = (ord.lines || []).map(function (ln) {
            const qty = Math.max(1, Math.round(Number(ln.quantityMilli || 1000) / 1000));
            const mods = ln.modifierNames && ln.modifierNames.length > 0 ? ' (' + ln.modifierNames.join(', ') + ')' : '';
            return (
              '<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:3px 0;">' +
                '<span>' + qty + 'x ' + esc(ln.itemName + mods) + (ln.note ? ' [' + esc(ln.note) + ']' : '') + '</span>' +
                '<span class="tnum" style="font-weight:600;">' + esc(formatSatang(ln.lineTotalSatang)) + '</span>' +
              '</div>'
            );
          }).join('');

          return (
            '<div class="tracker-card">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                '<div><strong style="font-size:16px;">' + esc(ord.orderCode) + '</strong> · <span class="badge badge-primary">' + esc(L().tablePrefix) + ' ' + esc(ord.tableLabel) + '</span></div>' +
                '<strong class="tnum" style="color:var(--primary-hover);">' + esc(formatSatang(ord.estimatedTotalSatang)) + '</strong>' +
              '</div>' +
              statusHtml +
              '<div style="border-top:1px solid var(--surface-2);padding-top:8px;">' + linesHtml + '</div>' +
            '</div>'
          );
        }).join('');

        sec.innerHTML =
          cards +
          '<button type="button" class="btn btn-primary" id="orderMoreBtn" style="width:100%;min-height:46px;">' + esc(L().orderMore) + '</button>';
        const btn = document.getElementById('orderMoreBtn');
        if (btn) btn.onclick = function () { state.tab = 'menu'; renderTabs(); renderCartDock(); };
      }

      async function pollTrackedOrders() {
        if (state.trackedOrderIds.length === 0) return;
        let changed = false;
        for (let i = 0; i < state.trackedOrderIds.length; i++) {
          const id = state.trackedOrderIds[i];
          const existing = state.trackedOrders[id];
          if (existing && (existing.status === 'SERVED' || existing.status === 'SETTLED' || existing.status === 'REJECTED')) {
            continue;
          }
          try {
            const tok = state.trackedOrderTokens[id] || (existing && existing.trackingToken) || '';
            let statusUrl = '/api/guest/order-status?id=' + encodeURIComponent(id);
            if (tok) statusUrl += '&token=' + encodeURIComponent(tok);
            if (BOOT.outletId && BOOT.outletId !== 'OUTLET-HQ') {
              statusUrl += '&o=' + encodeURIComponent(BOOT.outletId);
            }
            const res = await fetch(statusUrl);
            if (res.ok) {
              const data = await res.json();
              if (data.order) {
                state.trackedOrders[id] = data.order;
                changed = true;
              }
            }
          } catch (_e) {}
        }
        if (changed && state.tab === 'orders') {
          renderOrdersTracker();
        }
      }

      async function loadMenu() {
        try {
          const qs = new URLSearchParams();
          if (BOOT.outletId && BOOT.outletId !== 'OUTLET-HQ') qs.set('o', BOOT.outletId);
          if (BOOT.initialTable) qs.set('t', BOOT.initialTable);
          if (BOOT.initialToken) qs.set('s', BOOT.initialToken);
          const res = await fetch('/api/guest/menu' + (qs.toString() ? '?' + qs.toString() : ''));
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || L().loadError);
          state.menu = data;
          if (!state.selectedTable) {
            state.selectedTable = data.lockedTableLabel || (data.tableLabels && data.tableLabels[0]) || 'T01';
          }
          if (data.signedTableExpired) {
            setBanner(L().signedExpired, 'error');
          }
          renderTopbar();
          renderCaptiveBanner();
          renderTabs();
          renderCategoriesAndMenu();
          renderCartDock();
        } catch (err) {
          setBanner(err && err.message ? err.message : L().loadError, 'error');
        }
      }

      // Wire events
      document.querySelectorAll('.lang-btn').forEach(function (btn) {
        btn.onclick = function () {
          state.lang = btn.getAttribute('data-lang') || 'th';
          renderTopbar();
          renderCaptiveBanner();
          renderTabs();
          renderCategoriesAndMenu();
          renderCartDock();
          if (state.tab === 'orders') renderOrdersTracker();
        };
      });
      document.getElementById('tabMenuBtn').onclick = function () {
        state.tab = 'menu';
        renderTabs();
        renderCartDock();
      };
      document.getElementById('tabOrdersBtn').onclick = function () {
        state.tab = 'orders';
        renderTabs();
        renderCartDock();
        renderOrdersTracker();
        void pollTrackedOrders();
      };
      document.getElementById('searchInput').oninput = function (e) {
        state.search = e.target.value;
        renderCategoriesAndMenu();
      };
      document.getElementById('openCartBtn').onclick = openCartSheet;
      document.getElementById('itemSheetBackdrop').onclick = function (e) {
        if (e.target === e.currentTarget) closeItemSheet();
      };
      document.getElementById('cartSheetBackdrop').onclick = function (e) {
        if (e.target === e.currentTarget) closeCartSheet();
      };

      renderTopbar();
      renderCaptiveBanner();
      renderTabs();
      void loadMenu();
      void pollTrackedOrders();
      window.setInterval(function () { void pollTrackedOrders(); }, 4000);
    })();
  </script>
</body>
</html>`;
}
