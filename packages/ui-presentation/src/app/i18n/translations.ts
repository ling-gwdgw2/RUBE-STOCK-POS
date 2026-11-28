/**
 * RUBE-STOCK-POS v3.1 Offline Multi-Language Translation Dictionary (`th` | `lo` | `en`)
 * Zero external runtime dependencies; bundled directly into the offline desktop UI.
 */

import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';

export type LocalizedTriple = Readonly<{
  th: string;
  lo: string;
  en: string;
}>;

export const UI_STRINGS = {
  // Navigation & App Shell
  'nav.pos': { th: 'หน้าขาย POS', lo: 'ໜ້າຂາຍ POS', en: 'POS Register' },
  'nav.kds': { th: 'จอครัว KDS', lo: 'ຈໍຄົວ KDS', en: 'Kitchen KDS' },
  'nav.warehouse': { th: 'คลังสินค้า & PO', lo: 'ສາງສິນຄ້າ & PO', en: 'Inventory & PO' },
  'nav.bom': { th: 'สูตร BOM', lo: 'ສູດ BOM', en: 'BOM Recipes' },
  'nav.shifts': { th: 'ปิดกะ & รายงาน', lo: 'ປິດກະ & ລາຍງານ', en: 'Shifts & Reports' },
  'nav.settings': { th: 'ตั้งค่าระบบ', lo: 'ຕັ້ງຄ່າລະບົບ', en: 'Settings' },
  'nav.noOpenShift': { th: 'ยังไม่เปิดกะ', lo: 'ຍັງບໍ່ເປີດກະ', en: 'Shift Closed' },
  'nav.switchUser': { th: 'สลับผู้ใช้งาน / ล็อกเครื่อง', lo: 'ປ່ຽນພະນັກງານ / ລັອກເຄື່ອງ', en: 'Switch Staff / Lock' },
  'nav.lockedTerminal': { th: 'เครื่องถูกล็อก', lo: 'ເຄື່ອງຖືກລັອກ', en: 'Terminal Locked' },
  'nav.loading': { th: 'กำลังเชื่อมต่อฐานข้อมูล SQLite & ระบบฮาร์ดแวร์ POS...', lo: 'ກຳລັງເຊື່ອມຕໍ່ຖານຂໍ້ມູນ SQLite & ລະບົບ POS...', en: 'Connecting to local SQLite & POS hardware...' },
  'nav.printerReady': { th: 'พร้อมใช้งาน', lo: 'ພ້ອມໃຊ້ງານ', en: 'Ready' },
  'nav.printerOffline': { th: 'ออฟไลน์', lo: 'ອອບໄລນ໌', en: 'Offline' },
  'nav.printerLabel': { th: 'เครื่องพิมพ์', lo: 'ເຄື່ອງພິມ', en: 'Printer' },
  'nav.ledgerOk': { th: 'Ledger Invariant: 100% ตรงตามสมการบัญชี', lo: 'Ledger Invariant: 100% ຖືກຕ້ອງຕາມບັນຊີ', en: 'Ledger Invariant: 100% Balanced' },
  'nav.ledgerErr': { th: 'ตรวจพบความคลาดเคลื่อนสต็อก', lo: 'ກວດພົບຄວາມຄາດເຄື່ອນສະຕັອກ', en: 'Stock mismatch detected' },
  'nav.shortcuts': {
    th: 'คีย์ลัด: F2 ค้นหา · F4 ตัวคูณ · F8 พักบิล · F9 ส่วนลด · F10 แยกจ่าย/เลือกชำระ · F12 รับเงินสดด่วน',
    lo: 'ຄີລັດ: F2 ຄົ້ນຫາ · F4 ຕົວຄູນ · F8 ພັກບິນ · F9 ສ່ວນຫຼຸດ · F10 ຊຳລະ/ແຍກຈ່າຍ · F12 ຮັບເງິນສົດດ່ວນ',
    en: 'Keys: F2 Search · F4 Qty · F8 Hold · F9 Discount · F10 Pay/Split · F12 Quick Cash',
  },
  'nav.taxIdPrefix.TH': { th: 'เลขผู้เสียภาษี', lo: 'ເລກຜູ້ເສຍພາສີ', en: 'Tax ID' },
  'nav.taxIdPrefix.LA': { th: 'เลข TIN', lo: 'ເລກ TIN', en: 'TIN' },

  // Country & Language Labels
  'country.TH': { th: 'ประเทศไทย (THB ฿ · VAT 7%)', lo: 'ປະເທດໄທ (THB ฿ · VAT 7%)', en: 'Thailand (THB ฿ · VAT 7%)' },
  'country.LA': { th: 'สปป.ลาว (LAK ₭ · ອມພ 10%)', lo: 'ສປປ.ລາວ (LAK ₭ · ອມພ 10%)', en: 'Lao PDR (LAK ₭ · VAT 10%)' },
  'currency.unit.THB': { th: 'บาท', lo: 'ບາດ', en: 'THB' },
  'currency.unit.LAK': { th: 'กีบ', lo: 'ກີບ', en: 'LAK' },
  'locale.th': { th: 'ไทย', lo: 'ໄທ (TH)', en: 'Thai' },
  'locale.lo': { th: 'ລາວ (Lao)', lo: 'ລາວ', en: 'Lao' },
  'locale.en': { th: 'English', lo: 'ອັງກິດ (EN)', en: 'English' },

  // POS Register
  'pos.tab.catalog': { th: 'รายการขาย', lo: 'ລາຍການຂາຍ', en: 'Catalog' },
  'pos.tab.retailTable': { th: 'ตารางสแกนด่วน', lo: 'ຕາຕະລາງສະແກນດ່ວນ', en: 'Fast Scan Grid' },
  'pos.tab.heldBills': { th: 'บิลพักไว้', lo: 'ບິນພັກໄວ້', en: 'Held Bills' },
  'pos.tab.history': { th: 'ใบเสร็จย้อนหลัง', lo: 'ໃບບິນຍ້ອນຫຼັງ', en: 'Receipts' },
  'pos.searchPlaceholder': {
    th: 'ยิงบาร์โค้ด (ป้องกันคีย์ไทย/ลาวอัตโนมัติ) หรือพิมพ์ชื่อสินค้า / SKU... (กด F2)',
    lo: 'ຍິງບາໂຄດ (ປ້ອງກັນຄີລາວ/ໄທອັດຕະໂນມັດ) ຫຼື ພິມຊື່ສິນຄ້າ / SKU... (ກົດ F2)',
    en: 'Scan barcode (auto layout guard) or search item / SKU... (F2)',
  },
  'pos.allItems': { th: 'รายการขายทั้งหมด', lo: 'ສິນຄ້າທັງໝົດ', en: 'All Items' },
  'pos.qtyMultiplier': { th: 'ตัวคูณสแกน (F4):', lo: 'ຕົວຄູນສະແກນ (F4):', en: 'Scan Qty (F4):' },
  'pos.netPayable': { th: 'ยอดชำระสุทธิ', lo: 'ຍອດຊຳລະສຸດທິ', en: 'Net Total' },
  'pos.itemsUnit': { th: 'รายการ', lo: 'ລາຍການ', en: 'items' },
  'pos.subtotal': { th: 'ยอดรวมสินค้า (Subtotal)', lo: 'ລວມລາຄາສິນຄ້າ (Subtotal)', en: 'Subtotal' },
  'pos.discount': { th: 'ส่วนลด (F9)', lo: 'ສ່ວນຫຼຸດ (F9)', en: 'Discount (F9)' },
  'pos.cashRounding': { th: 'ปัดเศษเงินสด', lo: 'ປັດເສດເງິນສົດ', en: 'Cash Rounding' },
  'pos.readyForOrder': { th: 'พร้อมรับรายการขายใหม่', lo: 'ພ້ອມຮັບລາຍການຂາຍໃໝ່', en: 'Ready for New Order' },
  'pos.readyForOrderHint': {
    th: 'แตะเลือกสินค้าด้านซ้าย หรือยิงบาร์โค้ดเข้าสู่รายการขายทันที',
    lo: 'ແຕະເລືອກສິນຄ້າດ້ານຊ້າຍ ຫຼື ຍິງບາໂຄດເຂົ້າລາຍການຂາຍທັນທີ',
    en: 'Tap an item on the left or scan a barcode to add it immediately',
  },
  'pos.payButton': { th: 'ชำระเงิน / แยกจ่าย', lo: 'ຊຳລະເງິນ / ແຍກຈ່າຍ', en: 'Checkout / Split' },
  'pos.quickCash': { th: 'รับเงินสดด่วน (F12)', lo: 'ຮັບເງິນສົດດ່ວນ (F12)', en: 'Quick Cash (F12)' },
  'pos.splitPay': { th: 'แยกจ่าย (เงินสด + QR/บัตร)', lo: 'ແຍກຈ່າຍ (ເງິນສົດ + QR/ບັດ)', en: 'Split Pay' },
  'pos.holdBill': { th: 'พักบิล (F8)', lo: 'ພັກບິນ (F8)', en: 'Hold (F8)' },
  'pos.clearCart': { th: 'ล้างบิล', lo: 'ລ້າງບິນ', en: 'Clear' },
  'pos.qrLabel.TH': { th: 'Thai QR / PromptPay', lo: 'Thai QR / PromptPay', en: 'Thai QR / PromptPay' },
  'pos.qrLabel.LA': { th: 'LAOQR / OnePay', lo: 'LAOQR / OnePay', en: 'LAOQR / OnePay' },
  'pos.cashTab': { th: 'เงินสด (Cash)', lo: 'ເງິນສົດ (Cash)', en: 'Cash' },
  'pos.cardTab': { th: 'บัตร / EDC', lo: 'ບັດ / EDC', en: 'Card / EDC' },
  'pos.splitTab': { th: 'แยกจ่าย (Split)', lo: 'ແຍກຈ່າຍ (Split)', en: 'Split Tender' },
  'pos.exactAmount': { th: 'รับพอดี', lo: 'ຮັບພໍດີ', en: 'Exact' },
  'pos.changeLabel': { th: 'เงินทอน', lo: 'ເງິນທອນ', en: 'Change' },
  'pos.receivedCash': { th: 'รับเงินสดจากลูกค้า', lo: 'ຮັບເງິນສົດຈາກລູກຄ້າ', en: 'Cash Tendered' },
  'pos.confirmPayCash': { th: 'ยืนยันรับเงินสด & พิมพ์ใบเสร็จ', lo: 'ຢືນຢັນຮັບເງິນສົດ & ພິມໃບບິນ', en: 'Confirm Cash & Print' },
  'pos.confirmPayQr': { th: 'ยืนยันรับเงินโอน QR & พิมพ์ใบเสร็จ', lo: 'ຢືນຢັນຮັບເງິນໂອນ QR & ພິມໃບບິນ', en: 'Confirm QR Payment & Print' },
  'pos.confirmPayCard': { th: 'ยืนยันชำระด้วยบัตร & พิมพ์ใบเสร็จ', lo: 'ຢືນຢັນຊຳລະດ້ວຍບັດ & ພິມໃບບິນ', en: 'Confirm Card & Print' },
  'pos.halfBill': { th: 'ครึ่งบิล', lo: 'ເຄິ່ງບິນ', en: 'Half Bill' },
  'pos.tableQueuePlaceholder': { th: 'ป้ายคิว / โต๊ะ (เช่น A-04)', lo: 'ເລກຄິວ / ໂຕະ (ເຊັ່ນ A-04)', en: 'Queue / Table (e.g. A-04)' },
  'pos.orderType.RETAIL': { th: 'ขายปลีกหน้าร้าน (Retail)', lo: 'ຂາຍຍ່ອຍໜ້າຮ້ານ (Retail)', en: 'Retail Counter' },
  'pos.orderType.TAKEAWAY': { th: 'สั่งกลับบ้าน (Takeaway)', lo: 'ສັ່ງກັບບ້ານ (Takeaway)', en: 'Takeaway' },
  'pos.orderType.DINE_IN': { th: 'ทานที่ร้าน (Dine-In)', lo: 'ທານທີ່ຮ້ານ (Dine-In)', en: 'Dine-In' },
  'pos.orderType.DELIVERY': { th: 'เดลิเวอรี (Delivery)', lo: 'ສົ່ງເຖິງທີ່ (Delivery)', en: 'Delivery' },
  'pos.taxMode.INCLUSIVE': { th: 'รวมในราคา', lo: 'ລວມໃນລາຄາ', en: 'Inclusive' },
  'pos.taxMode.EXCLUSIVE': { th: 'แยกนอก', lo: 'ແຍກນອກ', en: 'Exclusive' },
  'pos.taxMode.NONE': { th: 'ไม่คิด VAT (ยกเว้น)', lo: 'ບໍ່ຄິດອາກອນ (ຍົກເວັ້ນ)', en: 'No VAT (Exempt)' },
  'pos.laoSlipBankLabel': { th: 'ธนาคารผู้โอน (สปป.ลาว)', lo: 'ທະນາຄານຜູ້ໂອນ (ສປປ.ລາວ)', en: 'Sender Bank (Laos)' },
  'pos.laoSlipRefPlaceholder': {
    th: 'สแกน QR สลิป หรือกรอกเลข Ticket / Ref อย่างน้อย 4 ตัว...',
    lo: 'ສະແກນ QR ສະລິບ ຫຼື ປ້ອນເລກອ້າງອີງ Ticket / Ref (ຢ່າງໜ້ອຍ 4 ຕົວ)...',
    en: 'Scan slip QR or enter Ticket / Ref ID (min 4 chars)...',
  },
  'pos.verifySlipBtn': { th: 'ตรวจสอบสลิป', lo: 'ກວດສອບສະລິບ', en: 'Verify Slip' },
  'pos.visualConfirmOnePay': {
    th: 'ยืนยันเห็นเงินเข้าแล้ว (OnePay Alert / ไม่กรอก Ref)',
    lo: 'ຢືນຢັນເຫັນເງິນເຂົ້າແລ້ວ (ແຈ້ງເຕືອນ OnePay / ບໍ່ປ້ອນ Ref)',
    en: 'Visual Confirm Received (OnePay Alert)',
  },

  // Warehouse
  'wms.tab.catalog': { th: 'ทะเบียนสินค้า & คลัง', lo: 'ທະບຽນສິນຄ້າ & ສາງ', en: 'Catalog & Stock' },
  'wms.tab.categories': { th: 'หมวดหมู่ร้าน', lo: 'ໝວດໝູ່ຮ້ານ', en: 'Categories' },
  'wms.tab.modifiers': { th: 'ตัวเลือกเสริม (Modifiers)', lo: 'ຕົວເລືອກເສີມ (Modifiers)', en: 'Modifiers' },
  'wms.tab.po': { th: 'รับของ PO & ค่าขนส่ง', lo: 'ຮັບສິນຄ້າ PO & ຄ່າຂົນສົ່ງ', en: 'PO & Landed Cost' },
  'wms.tab.prep': { th: 'ผลิตเตรียมขาย (Prep)', lo: 'ຜະລິດກຽມຂາຍ (Prep)', en: 'Prep Production' },
  'wms.tab.stocktake': { th: 'ตรวจนับ & โอนสาขา', lo: 'ກວດນັບ & ໂອນສາຂາ', en: 'Stocktake & Transfer' },
  'wms.tab.barcodes': { th: 'พิมพ์บาร์โค้ดสินค้า', lo: 'ພິມບາໂຄດສິນຄ້າ', en: 'Barcode Labels' },
  'wms.tab.ledger': { th: 'สมุดบัญชีสต็อก', lo: 'ປຶ້ມບັນຊີສະຕັອກ', en: 'Stock Ledger' },
  'wms.addProduct': { th: 'เพิ่มสินค้า / วัตถุดิบใหม่', lo: 'ເພີ່ມສິນຄ້າ / ວັດຖຸດິບໃໝ່', en: 'Add Product / Material' },

  // Shift & Reports
  'rep.tab.drawer': { th: 'ลิ้นชัก & ปิดกะ (Blind Drop)', lo: 'ລິ້ນຊັກ & ປິດກະ (Blind Drop)', en: 'Drawer & Blind Drop' },
  'rep.tab.zreport': { th: 'รายงานปิดกะ (Z-Report)', lo: 'ລາຍງານປິດກະ (Z-Report)', en: 'Z-Report' },
  'rep.tab.tax.TH': { th: 'รายงานภาษีขาย (ภ.พ.30 / ABB)', lo: 'ລາຍງານອາກອນຂາຍ (ABB)', en: 'Sales Tax Report (ABB)' },
  'rep.tab.tax.LA': { th: 'รายงานภาษีมูลค่าเพิ่ม (TaxRIS / ອມພ)', lo: 'ລາຍງານອາກອນມູນຄ່າເພີ່ມ (TaxRIS / ອມພ)', en: 'VAT Sales Report (TaxRIS)' },
  'rep.tab.valuation': { th: 'มูลค่าคลังสินค้า (MAC)', lo: 'ມູນຄ່າສາງສິນຄ້າ (MAC)', en: 'Inventory Valuation' },
  'rep.tab.margin': { th: 'กำไรขั้นต้น & ต้นทุน COGS', lo: 'ກຳໄລຂັ້ນຕົ້ນ & ຕົ້ນທຶນ COGS', en: 'Gross Margin & COGS' },
  'rep.noteLabel': { th: 'แบงก์', lo: 'ໃບ', en: 'Note' },
  'rep.coinLabel': { th: 'เหรียญ', lo: 'ຫຼຽນ', en: 'Coin' },
  'rep.openShift': { th: 'เปิดกะใหม่', lo: 'ເປີດກະໃໝ່', en: 'Open Shift' },
  'rep.closeShift': { th: 'ยืนยันปิดกะ (Blind Drop)', lo: 'ຢືນຢັນປິດກະ (Blind Drop)', en: 'Close Shift (Blind Drop)' },

  // Settings
  'set.countrySectionTitle': {
    th: 'ประเทศ สกุลเงิน ภาษา ภาษี VAT และระบบชำระเงิน QR (HMAC Protected)',
    lo: 'ປະເທດ, ສະກຸນເງິນ, ພາສາ, ອາກອນ ອມພ ແລະ ລະບົບຊຳລະ QR (HMAC Protected)',
    en: 'Country, Currency, Language, VAT & QR Payment (HMAC Protected)',
  },
  'set.saveFiscal': {
    th: 'บันทึกข้อมูลกิจการ ประเทศ ภาษี & ลายเซ็น HMAC-SHA256',
    lo: 'ບັນທຶກຂໍ້ມູນຮ້ານ, ປະເທດ, ອາກອນ & ລາຍເຊັນ HMAC-SHA256',
    en: 'Save Store, Country, VAT & Sign HMAC-SHA256',
  },
  'set.cashRoundingLabel': {
    th: 'ปัดเศษเงินสดหน้าร้าน (สำหรับเงินกีบ LAK ไม่มีเหรียญ)',
    lo: 'ປັດເສດເງິນສົດໜ້າຮ້ານ (ສຳລັບເງິນກີບ LAK)',
    en: 'LAK Cash Rounding (No Coins)',
  },
  'set.cashRounding.0': { th: 'ไม่ปัดเศษ (คิดตามจริง)', lo: 'ບໍ່ປັດເສດ (ຄິດຕາມຈິງ)', en: 'No rounding (exact LAK)' },
  'set.cashRounding.500': { th: 'ปัดเศษลงทุก 500 ₭ (ให้ลูกค้าได้เปรียบ)', lo: 'ປັດເສດລົງທຸກ 500 ₭', en: 'Round down to 500 ₭' },
  'set.cashRounding.1000': { th: 'ปัดเศษลงทุก 1,000 ₭ (ให้ลูกค้าได้เปรียบ)', lo: 'ປັດເສດລົງທຸກ 1,000 ₭', en: 'Round down to 1,000 ₭' },
  'set.laoQrTitle': {
    th: 'แม่แบบ Static LAOQR / BCEL OnePay (ล็อกด้วย HMAC)',
    lo: 'ແມ່ແບບ Static LAOQR / BCEL OnePay (ລັອກດ້ວຍ HMAC)',
    en: 'Static LAOQR / BCEL OnePay Template (HMAC Locked)',
  },
  'set.laoQrVerifyPolicy': {
    th: 'นโยบายตรวจสลิปโอนเงิน LAOQR',
    lo: 'ນະໂຍບາຍກວດສອບສະລິບໂອນເງິນ LAOQR',
    en: 'LAOQR Slip Verification Policy',
  },
  'set.laoQrPolicy.STRICT_REF': {
    th: 'บังคับสแกน/กรอกเลข Ref สลิป (ป้องกันโอนซ้ำสูงสุด)',
    lo: 'ບັງຄັບສະແກນ/ປ້ອນເລກ Ref ສະລິບ (ປ້ອງກັນໂອນຊ້ຳສູງສຸດ)',
    en: 'Require Slip Ref / QR (Strict Anti-Duplicate)',
  },
  'set.laoQrPolicy.VISUAL_CONFIRM_ALLOWED': {
    th: 'อนุญาตยืนยันด้วยสายตา / เสียงแจ้งเตือน OnePay (ไม่ต้องกรอก Ref)',
    lo: 'ອະນຸຍາດຢືນຢັນດ້ວຍສາຍຕາ / ສຽງແຈ້ງເຕືອນ OnePay',
    en: 'Allow Visual / OnePay Soundbox Confirmation',
  },
  'set.scaleMultLabel': {
    th: 'ตัวคูณบาร์โค้ดตราชั่งแบบฝังราคา (Prefix 25–29)',
    lo: 'ຕົວຄູນບາໂຄດຊິງຊັ່ງແບບຝັງລາຄາ (Prefix 25–29)',
    en: 'Price-Embedded Scale Barcode Multiplier (Prefix 25–29)',
  },
  'fx.sectionTitle': {
    th: 'รับชำระเงินสดหลายสกุลเงิน (Multi-Currency FX — THB / USD ทอนเป็น LAK)',
    lo: 'ຮັບຊຳລະເງິນສົດຫຼາຍສະກຸນເງິນ (THB / USD ທອນເປັນກີບ LAK)',
    en: 'Multi-Currency Cash Tender (THB / USD -> Change in LAK)',
  },
  'fx.enableToggle': {
    th: 'เปิดใช้งานรับเงินสด THB / USD หน้าร้าน (ทอนเป็นกีบ LAK)',
    lo: 'ເປີດໃຊ້ງານຮັບເງິນສົດ THB / USD ໜ້າຮ້ານ (ທອນເປັນກີບ LAK)',
    en: 'Enable THB / USD Cash Tender (Change in LAK)',
  },
  'fx.thbRateLabel': {
    th: 'อัตราแลกเปลี่ยนร้าน: 1 บาทไทย (THB) = กี่กีบ (LAK)',
    lo: 'ອັດຕາແລກປ່ຽນຮ້ານ: 1 ບາດໄທ (THB) = ຈັກກີບ (LAK)',
    en: 'Store FX Rate: 1 THB = LAK',
  },
  'fx.usdRateLabel': {
    th: 'อัตราแลกเปลี่ยนร้าน: 1 ดอลลาร์ (USD) = กี่กีบ (LAK)',
    lo: 'ອັດຕາແລກປ່ຽນຮ້ານ: 1 ໂດລາ (USD) = ຈັກກີບ (LAK)',
    en: 'Store FX Rate: 1 USD = LAK',
  },
  'fx.tenderCurrencyLabel': {
    th: 'สกุลเงินสดที่ลูกค้ายื่น',
    lo: 'ສະກຸນເງິນສົດທີ່ລູກຄ້າຈ່າຍ',
    en: 'Customer Cash Currency',
  },
  'fx.convertedLakLabel': {
    th: 'เทียบเท่าเงินกีบ (LAK)',
    lo: 'ທຽບເທົ່າເງິນກີບ (LAK)',
    en: 'Equivalent in LAK',
  },
  'fx.drawerSummaryTitle': {
    th: 'สรุปเงินสดในลิ้นชักแยกตามสกุลเงิน (Multi-Currency Drawer)',
    lo: 'ສະຫຼຸບເງິນສົດໃນລິ້ນຊັກແຍກຕາມສະກຸນເງິນ (Multi-Currency)',
    en: 'Multi-Currency Drawer Cash Breakdown',
  },

  // Common Buttons & Dialogs
  'common.cancel': { th: 'ยกเลิก', lo: 'ຍົກເລີກ', en: 'Cancel' },
  'common.confirm': { th: 'ยืนยัน', lo: 'ຢືນຢັນ', en: 'Confirm' },
  'common.save': { th: 'บันทึก', lo: 'ບັນທຶກ', en: 'Save' },
  'common.close': { th: 'ปิด', lo: 'ປິດ', en: 'Close' },
  'common.delete': { th: 'ลบ', lo: 'ລຶບ', en: 'Delete' },
  'common.edit': { th: 'แก้ไข', lo: 'ແກ້ໄຂ', en: 'Edit' },
  'common.print': { th: 'พิมพ์', lo: 'ພິມ', en: 'Print' },
  'common.next': { th: 'ถัดไป', lo: 'ຕໍ່ໄປ', en: 'Next' },
  'common.back': { th: 'ย้อนกลับ', lo: 'ຍ້ອນກັບ', en: 'Back' },

  // PIN Lock & Void & App Shell Status
  'app.windowTitle': {
    th: 'RUBE-STOCK-POS v3.1 — ระบบขายหน้าร้านและคลังสินค้าอัจฉริยะ',
    lo: 'RUBE-STOCK-POS v3.1 — ລະບົບຂາຍໜ້າຮ້ານ ແລະ ສາງສິນຄ້າອັດສະລິຍະ',
    en: 'RUBE-STOCK-POS v3.1 — Unified Local-First Warehouse & POS System',
  },
  'nav.mainNavAria': { th: 'เมนูหลัก', lo: 'ເມນູຫຼັກ', en: 'Main navigation' },
  'nav.mobileNavAria': { th: 'เมนูหลักมือถือ', lo: 'ເມນູຫຼັກມືຖື', en: 'Mobile navigation' },
  'nav.languageLabel': { th: 'ภาษาหน้าจอ', lo: 'ພາສາໜ້າຈໍ', en: 'Display language' },
  'nav.selectOutletAria': { th: 'เลือกสาขาประจำเครื่อง', lo: 'ເລືອກສາຂາປະຈຳເຄື່ອງ', en: 'Select active outlet' },
  'nav.branchPrefix': { th: 'สาขา', lo: 'ສາຂາ', en: 'Branch' },
  'nav.printQueue': { th: 'คิวพิมพ์', lo: 'ຄິວພິມ', en: 'Print Queue' },
  'nav.openHilAria': { th: 'เปิดแผงจำลองฮาร์ดแวร์ HIL Bench', lo: 'ເປີດແຜງຈຳລອງຮາດແວ HIL Bench', en: 'Open HIL Hardware Simulator' },
  'nav.lockTerminalTitle': { th: 'ล็อกหน้าจอเครื่องจุดขายทันที', lo: 'ລັອກໜ້າຈໍເຄື່ອງ POS ທັນທີ', en: 'Lock terminal immediately' },
  'nav.lockedAria': {
    th: 'หน้าจอถูกล็อก กรุณาปลดล็อกด้วยรหัส PIN',
    lo: 'ໜ້າຈໍຖືກລັອກ ກະລຸນາປົດລັອກດ້ວຍລະຫັດ PIN',
    en: 'Terminal locked — unlock with staff PIN',
  },
  'nav.lockedBannerTitle': {
    th: 'หน้าจอเครื่องจุดขายถูกล็อกเพื่อความปลอดภัย',
    lo: 'ໜ້າຈໍເຄື່ອງ POS ຖືກລັອກເພື່ອຄວາມປອດໄພ',
    en: 'POS Terminal Locked for Security',
  },
  'nav.lockedBannerHint': {
    th: 'กรุณายืนยันรหัส PIN พนักงานเพื่อปลดล็อกและเข้าถึงข้อมูลหน้าร้าน',
    lo: 'ກະລຸນາຢືນຢັນລະຫັດ PIN ພະນັກງານເພື່ອປົດລັອກ ແລະ ເຂົ້າໃຊ້ລະບົບໜ້າຮ້ານ',
    en: 'Enter a valid staff PIN to unlock and access POS operations.',
  },
  'nav.bootErrorTitle': {
    th: 'ไม่สามารถเชื่อมต่อฐานข้อมูลท้องถิ่นได้',
    lo: 'ບໍ່ສາມາດເຊື່ອມຕໍ່ຖານຂໍ້ມູນທ້ອງຖິ່ນໄດ້',
    en: 'Unable to Connect to Local Database',
  },
  'nav.retryConnect': { th: 'ลองเชื่อมต่อใหม่', lo: 'ລອງເຊື່ອມຕໍ່ໃໝ່', en: 'Retry Connection' },
  'nav.shiftOpenBadge': { th: 'กะเปิดอยู่', lo: 'ກະເປີດຢູ່', en: 'Shift Open' },
  'toast.warnPrefix': { th: 'แจ้งเตือน:', lo: 'ແຈ້ງເຕືອນ:', en: 'Warning:' },
  'toast.errorPrefix': { th: 'ข้อผิดพลาด:', lo: 'ຂໍ້ຜິດພາດ:', en: 'Error:' },
  'toast.regionAria': { th: 'การแจ้งเตือนระบบ', lo: 'ການແຈ້ງເຕືອນລະບົບ', en: 'System notifications' },
  'role.OWNER': { th: 'เจ้าของร้าน (Owner)', lo: 'ເຈົ້າຂອງຮ້ານ (Owner)', en: 'Owner' },
  'role.MANAGER': { th: 'ผู้จัดการร้าน (Manager)', lo: 'ຜູ້ຈັດການຮ້ານ (Manager)', en: 'Manager' },
  'role.CASHIER': { th: 'แคชเชียร์ (Cashier)', lo: 'ພະນັກງານຂາຍ (Cashier)', en: 'Cashier' },
  'role.WAREHOUSE': { th: 'คลังสินค้า (Warehouse)', lo: 'ສາງສິນຄ້າ (Warehouse)', en: 'Warehouse' },
  'role.KITCHEN': { th: 'ฝ่ายครัว/บาร์ (Kitchen)', lo: 'ຝ່າຍຄົວ/ບາ (Kitchen)', en: 'Kitchen' },
  'pin.title': { th: 'ปลดล็อกเครื่อง / สลับพนักงาน', lo: 'ປົດລັອກເຄື່ອງ / ປ່ຽນພະນັກງານ', en: 'Unlock Terminal / Switch Staff' },
  'pin.enterPin': { th: 'กรอกรหัส PIN 4–8 หลัก', lo: 'ປ້ອນລະຫັດ PIN 4–8 ຫຼັກ', en: 'Enter 4–8 digit PIN' },
  'pin.unlockBtn': { th: 'ยืนยันเข้าใช้งาน', lo: 'ຢືນຢັນເຂົ້າໃຊ້ງານ', en: 'Unlock & Sign In' },
  'pin.minDigitsErr': { th: 'กรุณากรอกรหัส PIN อย่างน้อย 4 หลัก', lo: 'ກະລຸນາປ້ອນລະຫັດ PIN ຢ່າງໜ້ອຍ 4 ຫຼັກ', en: 'Please enter at least 4 PIN digits' },
  'void.title': { th: 'ยกเลิกบิลและคืนสต็อกอัตโนมัติ (Void Reversal)', lo: 'ຍົກເລີກບິນ ແລະ ຄືນສະຕັອກອັດຕະໂນມັດ', en: 'Void Order & Reverse Stock' },
} as const satisfies Record<string, LocalizedTriple>;

export type UiStringKey = keyof typeof UI_STRINGS;

export function translateKey(key: UiStringKey, locale: LocaleCode): string {
  const entry = UI_STRINGS[key];
  return entry[locale] ?? entry.th;
}

export function pickLocaleText(
  locale: LocaleCode,
  thText: string,
  loText: string,
  enText: string
): string {
  if (locale === 'lo') return loText;
  if (locale === 'en') return enText;
  return thText;
}
