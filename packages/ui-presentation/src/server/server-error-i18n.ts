/**
 * RUBE-STOCK-POS v3.1 Server-Side HTTP Error & Warning Localization (`th` | `lo` | `en`)
 *
 * Preserves exact HTTP status codes and interpolated identifiers/quantities while translating
 * thrown server/engine errors and warning strings into Lao (`lo`) or English (`en`) whenever
 * requested via `X-Rube-Locale` or active store `uiLocale`. Leaves `'th'` untouched for 100%
 * backward compatibility with Thai-language assertions and existing tests.
 */

import type http from 'node:http';
import { normalizeLocaleCode, type LocaleCode } from '../../../shared-contracts/src/currency.ts';

export function resolveRequestLocale(
  req: http.IncomingMessage | undefined,
  fallbackLocale: LocaleCode = 'th',
  explicitHint?: unknown
): LocaleCode {
  if (explicitHint !== undefined && explicitHint !== null && String(explicitHint).trim()) {
    return normalizeLocaleCode(explicitHint, fallbackLocale);
  }
  const headerVal = req?.headers?.['x-rube-locale'];
  const rawHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (rawHeader && rawHeader.trim()) {
    return normalizeLocaleCode(rawHeader, fallbackLocale);
  }
  return fallbackLocale;
}

function pickErr(locale: LocaleCode, loText: string, enText: string, thFallback: string): string {
  if (locale === 'lo') return loText;
  if (locale === 'en') return enText;
  return thFallback;
}

interface PatternRule {
  readonly regex: RegExp;
  readonly render: (m: RegExpExecArray, locale: LocaleCode, original: string) => string;
}

const EXACT_TRANSLATIONS: ReadonlyArray<readonly [string, string, string]> = [
  [
    'HTTP 401 Unauthorized: รูปแบบ Session Token ไม่ถูกต้อง',
    'HTTP 401 Unauthorized: ຮູບແບບ Session Token ບໍ່ຖືກຕ້ອງ',
    'HTTP 401 Unauthorized: Invalid session token format',
  ],
  [
    'HTTP 401 Unauthorized: ลายเซ็น Session Token ไม่ถูกต้อง',
    'HTTP 401 Unauthorized: ລາຍເຊັນ Session Token ບໍ່ຖືກຕ້ອງ',
    'HTTP 401 Unauthorized: Invalid session token signature',
  ],
  [
    'HTTP 401 Unauthorized: ไม่สามารถอ่าน Session Token ได้',
    'HTTP 401 Unauthorized: ບໍ່ສາມາດອ່ານ Session Token ໄດ້',
    'HTTP 401 Unauthorized: Unable to read session token payload',
  ],
  [
    'HTTP 401 Unauthorized: ข้อมูล Session Token ไม่สมบูรณ์',
    'HTTP 401 Unauthorized: ຂໍ້ມູນ Session Token ບໍ່ຄົບຖ້ວນ',
    'HTTP 401 Unauthorized: Incomplete session token payload',
  ],
  [
    'HTTP 401 Unauthorized: เซสชันหมดอายุแล้ว กรุณากดรหัส PIN ใหม่',
    'HTTP 401 Unauthorized: ເຊສຊັນໝົດອາຍຸແລ້ວ ກະລຸນາປ້ອນລະຫັດ PIN ໃໝ່',
    'HTTP 401 Unauthorized: Session expired. Please sign in again with your PIN',
  ],
  [
    'HTTP 401 Unauthorized: เซสชันถูกออกจากระบบแล้ว',
    'HTTP 401 Unauthorized: ເຊສຊັນໄດ້ອອກຈາກລະບົບແລ້ວ',
    'HTTP 401 Unauthorized: Session has been signed out',
  ],
  [
    'HTTP 401 Unauthorized: ไม่พบบัญชีพนักงานหรือบัญชีถูกระงับการใช้งาน',
    'HTTP 401 Unauthorized: ບໍ່ພົບບັນຊີພະນັກງານ ຫຼື ບັນຊີຖືກລະງັບ',
    'HTTP 401 Unauthorized: Staff account not found or deactivated',
  ],
  [
    'HTTP 401 Unauthorized: ต้องส่ง Bearer Token ในส่วนหัว Authorization',
    'HTTP 401 Unauthorized: ຕ້ອງສົ່ງ Bearer Token ໃນສ່ວນຫົວ Authorization',
    'HTTP 401 Unauthorized: Missing Bearer token in Authorization header',
  ],
  [
    'HTTP 401 Unauthorized: กรุณายืนยันรหัส PIN พนักงานก่อนทำรายการ',
    'HTTP 401 Unauthorized: ກະລຸນາຢືນຢັນລະຫັດ PIN ພະນັກງານກ່ອນທຳລາຍການ',
    'HTTP 401 Unauthorized: Staff PIN authentication required',
  ],
  [
    'HTTP 403 Forbidden: ต้องใช้รหัสอนุมัติของ MANAGER หรือ OWNER เท่านั้น',
    'HTTP 403 Forbidden: ຕ້ອງໃຊ້ລະຫັດອະນຸມັດຂອງ MANAGER ຫຼື OWNER ເທົ່ານັ້ນ',
    'HTTP 403 Forbidden: MANAGER or OWNER approval PIN is required',
  ],
  [
    'HTTP 403 Forbidden: เฉพาะ OWNER เท่านั้นที่สามารถสร้างบัญชี OWNER ได้',
    'HTTP 403 Forbidden: ສະເພາະ OWNER ເທົ່ານັ້ນທີ່ສາມາດສ້າງບັນຊີ OWNER ໄດ້',
    'HTTP 403 Forbidden: Only OWNER can create an OWNER account',
  ],
  [
    'HTTP 403 Forbidden: เฉพาะ OWNER เท่านั้นที่สามารถแก้ไขบัญชี OWNER ได้',
    'HTTP 403 Forbidden: ສະເພາະ OWNER ເທົ່ານັ້ນທີ່ສາມາດແກ້ໄຂບັນຊີ OWNER ໄດ້',
    'HTTP 403 Forbidden: Only OWNER can modify an OWNER account',
  ],
  [
    'HTTP 403 Forbidden: สิทธิ์ CASHIER ต้องให้ MANAGER หรือ OWNER กดรหัส PIN อนุมัติลบ/ลดรายการในบิลพัก',
    'HTTP 403 Forbidden: ສິດ CASHIER ຕ້ອງໃຫ້ MANAGER ຫຼື OWNER ປ້ອນລະຫັດ PIN ອະນຸມັດລຶບ/ຫຼຸດລາຍການໃນບິນພັກ',
    'HTTP 403 Forbidden: CASHIER must obtain MANAGER or OWNER PIN override to reduce or remove held bill items',
  ],
  [
    'HTTP 403 Forbidden: สิทธิ์ CASHIER ต้องให้ MANAGER หรือ OWNER กดรหัส PIN อนุมัติยกเลิกบิลพัก',
    'HTTP 403 Forbidden: ສິດ CASHIER ຕ້ອງໃຫ້ MANAGER ຫຼື OWNER ປ້ອນລະຫັດ PIN ອະນຸມັດຍົກເລີກບິນພັກ',
    'HTTP 403 Forbidden: CASHIER must obtain MANAGER or OWNER PIN override to void a held bill',
  ],
  [
    'HTTP 403 Forbidden: สิทธิ์ CASHIER ต้องให้ MANAGER หรือ OWNER กดรหัส PIN อนุมัติยกเลิกบิล',
    'HTTP 403 Forbidden: ສິດ CASHIER ຕ້ອງໃຫ້ MANAGER ຫຼື OWNER ປ້ອນລະຫັດ PIN ອະນຸມັດຍົກເລີກບິນ',
    'HTTP 403 Forbidden: CASHIER must obtain MANAGER or OWNER PIN override to void a bill',
  ],
  [
    'HTTP 400 กรุณาระบุเหตุผลการลดหรือยกเลิกรายการในบิลพัก',
    'HTTP 400 ກະລຸນາລະບຸເຫດຜົນການຫຼຸດ ຫຼື ຍົກເລີກລາຍການໃນບິນພັກ',
    'HTTP 400 Please provide a reason for reducing or voiding the held bill item',
  ],
  [
    'HTTP 400 กรุณาระบุเหตุผลการลดหรือลบรายการในบิลพัก',
    'HTTP 400 ກະລຸນາລະບຸເຫດຜົນການຫຼຸດ ຫຼື ລຶບລາຍການໃນບິນພັກ',
    'HTTP 400 Please provide a reason for reducing or removing the held bill item',
  ],
  [
    'HTTP 400 กรุณาระบุเหตุผลการยกเลิกบิลพัก',
    'HTTP 400 ກະລຸນາລະບຸເຫດຜົນການຍົກເລີກບິນພັກ',
    'HTTP 400 Please provide a reason for voiding the held bill',
  ],
  [
    'HTTP 404 ไม่พบบิลพักที่ระบุ (อาจถูกชำระเงินหรือยกเลิกไปแล้ว)',
    'HTTP 404 ບໍ່ພົບບິນພັກທີ່ລະບຸ (ອາດຖືກຊຳລະເງິນ ຫຼື ຍົກເລີກໄປແລ້ວ)',
    'HTTP 404 Held bill not found (it may already be settled or voided)',
  ],
  [
    'HTTP 404 ไม่พบบิลพักที่ต้องการยกเลิก',
    'HTTP 404 ບໍ່ພົບບິນພັກທີ່ຕ້ອງການຍົກເລີກ',
    'HTTP 404 Target held bill not found',
  ],
  [
    'HTTP 404 ไม่พบบิลพักที่ระบุ',
    'HTTP 404 ບໍ່ພົບບິນພັກທີ່ລະບຸ',
    'HTTP 404 Held bill not found',
  ],
  [
    'HTTP 404 ไม่พบรายการสินค้าที่ต้องการลด/ลบในบิลพัก',
    'HTTP 404 ບໍ່ພົບລາຍການສິນຄ້າທີ່ຕ້ອງການຫຼຸດ/ລຶບໃນບິນພັກ',
    'HTTP 404 Target item not found in held bill',
  ],
  [
    'HTTP 400 จำนวนใหม่ต้องน้อยกว่าจำนวนเดิมในบิลพัก',
    'HTTP 400 ຈຳນວນໃໝ່ຕ້ອງໜ້ອຍກວ່າຈຳນວນເດີມໃນບິນພັກ',
    'HTTP 400 New quantity must be less than the current quantity in the held bill',
  ],
  [
    'HTTP 409 บิลพักที่ระบุถูกชำระเงินปิดบิลหรือถูกยกเลิกไปแล้ว',
    'HTTP 409 ບິນພັກທີ່ລະບຸຖືກຊຳລະເງິນປິດບິນ ຫຼື ຖືກຍົກເລີກໄປແລ້ວ',
    'HTTP 409 This held bill has already been settled or voided',
  ],
  [
    'HTTP 409 บิลพักมีการอัปเดตรายการใหม่ (เช่น ออเดอร์ QR สั่งเพิ่ม) กรุณากดอัปเดตยอดล่าสุดก่อนรับชำระ',
    'HTTP 409 ບິນພັກມີການອັບເດດລາຍການໃໝ່ (ເຊັ່ນ ອໍເດີ QR ສັ່ງເພີ່ມ) ກະລຸນາກົດອັບເດດຍອດຫຼ້າສຸດກ່ອນຮັບຊຳລະ',
    'HTTP 409 Held bill was updated externally (e.g. a new QR order). Sync the latest bill before checkout',
  ],
  [
    'HTTP 409 บิลพักมีการอัปเดตรายการใหม่ กรุณารีเฟรชบิลก่อนแก้ไข',
    'HTTP 409 ບິນພັກມີການອັບເດດລາຍການໃໝ່ ກະລຸນາໂຫຼດບິນຄືນໃໝ່ກ່ອນແກ້ໄຂ',
    'HTTP 409 Held bill was updated elsewhere. Refresh the bill before editing',
  ],
  [
    'HTTP 409 ออเดอร์ครัวนี้ถูกยกเลิกบิลแล้ว',
    'HTTP 409 ອໍເດີຄົວນີ້ຖືກຍົກເລີກບິນແລ້ວ',
    'HTTP 409 This kitchen ticket belongs to a voided bill',
  ],
  [
    'HTTP 409 ไม่สามารถลบสินค้าที่มีใบโอนสาขากำลังรอรับเข้า (IN_TRANSIT)',
    'HTTP 409 ບໍ່ສາມາດລຶບສິນຄ້າທີ່ມີໃບໂອນສາຂາກຳລັງລໍຖ້າຮັບເຂົ້າ (IN_TRANSIT)',
    'HTTP 409 Cannot delete an item with pending IN_TRANSIT branch transfers',
  ],
  [
    'HTTP 409 กรุณาเปิดกะการขายก่อนรับออเดอร์เข้าจอครัว KDS',
    'HTTP 409 ກະລຸນາເປີດກະການຂາຍກ່ອນຮັບອໍເດີເຂົ້າຈໍຄົວ KDS',
    'HTTP 409 Please open a POS shift before accepting orders to KDS',
  ],
  [
    'HTTP 413 Payload Too Large: ขนาดคำขอเกินขีดจำกัด 5 MB',
    'HTTP 413 Payload Too Large: ຂະໜາດຄຳຂໍເກີນຂີດຈຳກັດ 5 MB',
    'HTTP 413 Payload Too Large: Request body exceeds the 5 MB limit',
  ],
  [
    'HTTP 423 Locked: ระบบอยู่ในโหมดป้องกันไฟดับ (แบตเตอรี่ UPS ต่ำมาก)',
    'HTTP 423 Locked: ລະບົບຢູ່ໃນໂໝດປ້ອງກັນໄຟດັບ (ແບັດເຕີຣີ UPS ຕ່ຳຫຼາຍ)',
    'HTTP 423 Locked: System is in low-battery Read-Only protection mode (critical UPS battery)',
  ],
  [
    'รองรับเฉพาะไฟล์รูปภาพ JPEG, PNG หรือ WebP เท่านั้น',
    'ຮອງຮັບສະເພາະໄຟລ໌ຮູບພາບ JPEG, PNG ຫຼື WebP ເທົ່ານັ້ນ',
    'Only JPEG, PNG, or WebP image files are supported',
  ],
  [
    'ขนาดรูปภาพใหญ่เกิน 2 MB กรุณาเลือกรูปที่เล็กลง',
    'ຂະໜາດຮູບພາບໃຫຍ່ເກີນ 2 MB ກະລຸນາເລືອກຮູບທີ່ນ້ອຍລົງ',
    'Image file exceeds 2 MB. Please choose a smaller image',
  ],
  [
    'พาธโฟลเดอร์สำรองข้อมูลต้องเป็นพาธเต็ม (Absolute Path เช่น E:\\RubePOS_Backups)',
    'ພາດໂຟນເດີສຳຮອງຂໍ້ມູນຕ້ອງເປັນພາດເຕັມ (Absolute Path ເຊັ່ນ E:\\RubePOS_Backups)',
    'Backup folder path must be an absolute path (e.g., E:\\RubePOS_Backups)',
  ],
  [
    'ไม่อนุญาตให้เลือกโฟลเดอร์ระบบ Windows เป็นปลายทางสำรองข้อมูล',
    'ບໍ່ອະນຸຍາດໃຫ້ເລືອກໂຟນເດີລະບົບ Windows ເປັນປາຍທາງສຳຮອງຂໍ້ມູນ',
    'Windows system folders cannot be used as the backup destination',
  ],
  [
    'กรุณาเลือกสินค้าอย่างน้อย 1 รายการก่อนสั่งพิมพ์บาร์โค้ด',
    'ກະລຸນາເລືອກສິນຄ້າຢ່າງໜ້ອຍ 1 ລາຍການກ່ອນສັ່ງພິມບາໂຄດ',
    'Please select at least 1 product before printing barcode labels',
  ],
  [
    'จำกัดจำนวนรายการต่อชุดพิมพ์ไม่เกิน 500 รายการต่อครั้ง',
    'ຈຳກັດຈຳນວນລາຍການຕໍ່ຊຸດພິມບໍ່ເກີນ 500 ລາຍການຕໍ່ຄັ້ງ',
    'Print batch is limited to at most 500 items per job',
  ],
  [
    'ตรวจพบการใช้สลิปโอนเงินซ้ำ! (Duplicate Slip Fraud Alert)',
    'ກວດພົບການໃຊ້ສະລິບໂອນເງິນຊ້ຳ! (Duplicate Slip Fraud Alert)',
    'Duplicate transfer slip detected! (Duplicate Slip Fraud Alert)',
  ],
  [
    'ข้อมูลสลิปไม่ถูกต้อง',
    'ຂໍ້ມູນສະລິບບໍ່ຖືກຕ້ອງ',
    'Invalid transfer slip payload',
  ],
  [
    'จำลองการดึงแฟลชไดรฟ์ USB ออกกลางคันสำเร็จ (ทิ้งไฟล์ .part ชำรุดไว้ในไดเรกทอรีสำรองข้อมูล)',
    'ຈຳລອງການດຶງແຟລຊໄດຣຟ USB ອອກກາງຄັນສຳເລັດ (ປະໄຟລ໌ .part ເສຍຫາຍໄວ້ໃນໂຟນເດີສຳຮອງຂໍ້ມູນ)',
    'Simulated unexpected USB removal successfully (left a partial .part file in the backup directory)',
  ],
  [
    'HTTP 400 กรุณาระบุหมายเลขโต๊ะสำหรับสร้าง QR Session',
    'HTTP 400 ກະລຸນາລະບຸເລກໂຕະສຳລັບສ້າງ QR Session',
    'HTTP 400 Please specify a table label to open a QR session',
  ],
  [
    'HTTP 400 กรุณาเลือกเมนูอย่างน้อย 1 รายการก่อนส่งออเดอร์',
    'HTTP 400 ກະລຸນາເລືອກເມນູຢ່າງໜ້ອຍ 1 ລາຍການກ່ອນສົ່ງອໍເດີ',
    'HTTP 400 Please select at least 1 menu item before submitting',
  ],
  [
    'HTTP 400 จำนวนรายการต่อคำสั่งซื้อเกินขีดจำกัด 50 รายการ',
    'HTTP 400 ຈຳນວນລາຍການຕໍ່ຄຳສັ່ງຊື້ເກີນຂີດຈຳກັດ 50 ລາຍການ',
    'HTTP 400 Order exceeds the maximum of 50 line items',
  ],
  [
    'HTTP 503 ระบบสั่งอาหารผ่าน QR ปิดรับออเดอร์ชั่วคราว',
    'HTTP 503 ລະບົບສັ່ງອາຫານຜ່ານ QR ປິດຮັບອໍເດີຊົ່ວຄາວ',
    'HTTP 503 QR table ordering is currently paused',
  ],
  [
    'HTTP 503 ระบบสั่งอาหารผ่าน QR ปิดรับชั่วคราว',
    'HTTP 503 ລະບົບສັ່ງອາຫານຜ່ານ QR ປິດຮັບຊົ່ວຄາວ',
    'HTTP 503 QR table ordering service is currently disabled',
  ],
  [
    'HTTP 400 กรุณาเลือกหมายเลขโต๊ะก่อนส่งออเดอร์',
    'HTTP 400 ກະລຸນາເລືອກເລກໂຕະກ່ອນສົ່ງອໍເດີ',
    'HTTP 400 Please select a table before placing your order',
  ],
  [
    'HTTP 400 กรุณาเลือกหมายเลขโต๊ะก่อนเรียกพนักงาน',
    'HTTP 400 ກະລຸນາເລືອກເລກໂຕະກ່ອນເອີ້ນພະນັກງານ',
    'HTTP 400 Please select a table before calling staff',
  ],
  [
    'HTTP 403 QR โต๊ะนี้หมดอายุหรือถูกปิดบิลแล้ว กรุณาขอใบ QR ใหม่จากพนักงาน',
    'HTTP 403 QR ໂຕະນີ້ໝົດອາຍຸ ຫຼື ຖືກປິດບິນແລ້ວ ກະລຸນາຂໍ QR ໃໝ່ຈາກພະນັກງານ',
    'HTTP 403 This table QR code has expired or the bill was closed. Please ask staff for a new QR code',
  ],
  [
    'HTTP 403 ร้านนี้เปิดรับเฉพาะออเดอร์ที่สแกนจากใบ QR ประจำโต๊ะเท่านั้น',
    'HTTP 403 ຮ້ານນີ້ເປີດຮັບສະເພາະອໍເດີທີ່ສະແກນຈາກ QR ປະຈຳໂຕະເທົ່ານັ້ນ',
    'HTTP 403 This store only accepts orders scanned from a valid table QR slip',
  ],
  [
    'HTTP 403 ร้านนี้เปิดรับเฉพาะการสแกนจากใบ QR ประจำโต๊ะเท่านั้น',
    'HTTP 403 ຮ້ານນີ້ເປີດຮັບສະເພາະການສະແກນຈາກ QR ປະຈຳໂຕະເທົ່ານັ້ນ',
    'HTTP 403 This store requires scanning a valid table QR slip to call staff',
  ],
  [
    'HTTP 400 ข้อมูลจำนวนเมนูไม่ถูกต้อง',
    'HTTP 400 ຂໍ້ມູນຈຳນວນເມນູບໍ່ຖືກຕ້ອງ',
    'HTTP 400 Invalid item quantity',
  ],
  [
    'HTTP 403 ไม่อนุญาตให้สั่งรายการวัตถุดิบหลังร้าน',
    'HTTP 403 ບໍ່ອະນຸຍາດໃຫ້ສັ່ງລາຍການວັດຖຸດິບຫຼັງຮ້ານ',
    'HTTP 403 Back-of-house raw ingredients cannot be ordered directly',
  ],
  [
    'HTTP 400 สินค้าชั่งน้ำหนักตามจริงไม่สามารถสั่งผ่าน QR ประจำโต๊ะได้',
    'HTTP 400 ສິນຄ້າຊັ່ງນ້ຳໜັກຕາມຈິງບໍ່ສາມາດສັ່ງຜ່ານ QR ປະຈຳໂຕະໄດ້',
    'HTTP 400 Weighted-scale items cannot be ordered via Table QR',
  ],
  [
    'HTTP 404 ไม่พบรายการเรียกพนักงานที่ระบุ',
    'HTTP 404 ບໍ່ພົບລາຍການເອີ້ນພະນັກງານທີ່ລະບຸ',
    'HTTP 404 Staff call request not found',
  ],
  [
    'HTTP 404 ไม่พบออเดอร์ QR ที่ระบุ',
    'HTTP 404 ບໍ່ພົບອໍເດີ QR ທີ່ລະບຸ',
    'HTTP 404 Guest QR order not found',
  ],
  [
    'HTTP 503 Service Unavailable: ระบบสำรองไฟฉุกเฉินกำลังบันทึกข้อมูล งดรับออเดอร์ชั่วคราว',
    'HTTP 503 Service Unavailable: ລະບົບໄຟສຳຮອງສຸກເສີນກຳລັງບັນທຶກຂໍ້ມູນ ງົດຮັບອໍເດີຊົ່ວຄາວ',
    'HTTP 503 Service Unavailable: Emergency UPS backup protection active — orders temporarily paused',
  ],
  [
    'HTTP 503 Service Unavailable: ระบบสำรองไฟฉุกเฉิน งดรับคำขอชั่วคราว',
    'HTTP 503 Service Unavailable: ລະບົບໄຟສຳຮອງສຸກເສີນ ງົດຮັບຄຳຂໍຊົ່ວຄາວ',
    'HTTP 503 Service Unavailable: Emergency UPS protection active — requests temporarily paused',
  ],
  [
    'HTTP 429 Too Many Requests: ส่งคำสั่งซื้อถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
    'HTTP 429 Too Many Requests: ສົ່ງຄຳສັ່ງຊື້ຖີ່ເກີນໄປ ກະລຸນາລໍຖ້າຈັກໜ່ອຍແລ້ວລອງໃໝ່',
    'HTTP 429 Too Many Requests: Too many orders submitted. Please wait a moment and try again',
  ],
  [
    'HTTP 429 Too Many Requests: กดเรียกพนักงานถี่เกินไป กรุณารอสักครู่',
    'HTTP 429 Too Many Requests: ກົດເອີ້ນພະນັກງານຖີ່ເກີນໄປ ກະລຸນາລໍຖ້າຈັກໜ່ອຍ',
    'HTTP 429 Too Many Requests: Too many staff call requests. Please wait a moment',
  ],
];

const EXACT_MAP = new Map<string, readonly [string, string]>(
  EXACT_TRANSLATIONS.map(([th, lo, en]) => [th, [lo, en]])
);

const PATTERN_RULES: ReadonlyArray<PatternRule> = [
  {
    regex: /^HTTP 403 Forbidden: สิทธิ์การใช้งาน \((.+)\) ไม่ได้รับอนุญาตให้ทำรายการนี้$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 403 Forbidden: ສິດການໃຊ້ງານ (${m[1]}) ບໍ່ໄດ້ຮັບອະນຸຍາດໃຫ້ທຳລາຍການນີ້`,
        `HTTP 403 Forbidden: Role (${m[1]}) is not permitted to perform this action`,
        orig
      ),
  },
  {
    regex: /^HTTP 429 Too Many Requests: กดรหัส PIN ผิดเกิน 5 ครั้ง ระบบล็อกหน้าจอชั่วคราว \(รออีก (\d+) วินาที\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 429 Too Many Requests: ປ້ອນລະຫັດ PIN ຜິດເກີນ 5 ຄັ້ງ ລະບົບລັອກຊົ່ວຄາວ (ລໍຖ້າອີກ ${m[1]} ວິນາທີ)`,
        `HTTP 429 Too Many Requests: Too many failed PIN attempts. Terminal temporarily locked (wait ${m[1]}s)`,
        orig
      ),
  },
  {
    regex: /^HTTP 429 Too Many Requests: กดรหัส PIN ผิดครบ 5 ครั้ง ระบบล็อกหน้าจอชั่วคราว (\d+) วินาที$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 429 Too Many Requests: ປ້ອນລະຫັດ PIN ຜິດຄົບ 5 ຄັ້ງ ລະບົບລັອກຊົ່ວຄາວ ${m[1]} ວິນາທີ`,
        `HTTP 429 Too Many Requests: 5 failed PIN attempts reached. Terminal locked for ${m[1]}s`,
        orig
      ),
  },
  {
    regex: /^HTTP 403 Forbidden: ห้ามลบหรือลดรายการในบิลพักขณะชำระเงิน ต้องขออนุมัติ PIN ผู้จัดการก่อน \((.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 403 Forbidden: ຫ້າມລຶບ ຫຼື ຫຼຸດລາຍການໃນບິນພັກຂະນະຊຳລະເງິນ ຕ້ອງຂໍອະນຸມັດ PIN ຜູ້ຈັດການກ່ອນ (${m[1]})`,
        `HTTP 403 Forbidden: Cannot remove or reduce locked held-bill items during checkout without MANAGER PIN override (${m[1]})`,
        orig
      ),
  },
  {
    regex: /^HTTP 403 Forbidden: ห้ามลบหรือลดรายการในบิลพักโดยไม่มีรหัสอนุมัติ PIN ผู้จัดการ \((.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 403 Forbidden: ຫ້າມລຶບ ຫຼື ຫຼຸດລາຍການໃນບິນພັກໂດຍບໍ່ມີລະຫັດອະນຸມັດ PIN ຜູ້ຈັດການ (${m[1]})`,
        `HTTP 403 Forbidden: Cannot reduce or delete locked held-bill items without MANAGER PIN override (${m[1]})`,
        orig
      ),
  },
  {
    regex: /^HTTP 409 บิลพัก "(.+)" กำลังถูกเรียกคิดเงินอยู่โดย (.+)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 409 ບິນພັກ "${m[1]}" ກຳລັງຖືກເອີ້ນຄິດເງິນຢູ່ໂດຍ ${m[2]}`,
        `HTTP 409 Held bill "${m[1]}" is currently claimed by ${m[2]}`,
        orig
      ),
  },
  {
    regex: /^HTTP 409 บิลพัก "(.+)" ถูกเรียกใช้งานโดยเครื่องอื่นแล้ว$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 409 ບິນພັກ "${m[1]}" ຖືກເອີ້ນໃຊ້ງານໂດຍເຄື່ອງອື່ນແລ້ວ`,
        `HTTP 409 Held bill "${m[1]}" is already claimed by another terminal`,
        orig
      ),
  },
  {
    regex: /^ไม่พบสินค้าที่ต้องการลบ \((.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `ບໍ່ພົບສິນຄ້າທີ່ຕ້ອງການລຶບ (${m[1]})`,
        `Product to delete was not found (${m[1]})`,
        orig
      ),
  },
  {
    regex: /^ไม่สามารถลบหมวดหมู่นี้ได้ เนื่องจากยังมีสินค้าใช้งานอยู่ (\d+) รายการ กรุณาย้ายหรือลบสินค้าก่อน$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `ບໍ່ສາມາດລຶບໝວດໝູ່ນີ້ໄດ້ ເນື່ອງຈາກຍັງມີສິນຄ້າໃຊ້ງານຢູ່ ${m[1]} ລາຍການ ກະລຸນາຍ້າຍ ຫຼື ລຶບສິນຄ້າກ່ອນ`,
        `Cannot delete this category because ${m[1]} item(s) still reference it. Reassign or remove them first`,
        orig
      ),
  },
  {
    regex: /^ไม่สามารถเขียนไฟล์ลงโฟลเดอร์ "(.+)" ได้ \((.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `ບໍ່ສາມາດຂຽນໄຟລ໌ລົງໂຟນເດີ "${m[1]}" ໄດ້ (${m[2]})`,
        `Unable to write files into folder "${m[1]}" (${m[2]})`,
        orig
      ),
  },
  {
    regex: /^ไม่พบหรือเขียนข้อมูลลงไดรฟ์สำรองภายนอก \((.+)\) ไม่ได้ — ระบบสำรองข้อมูลลงโฟลเดอร์สำรองในเครื่องชั่วคราวแล้ว กรุณาตรวจสอบแฟลชไดรฟ์ USB$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `ບໍ່ພົບ ຫຼື ຂຽນຂໍ້ມູນລົງໄດຣຟສຳຮອງພາຍນອກ (${m[1]}) ບໍ່ໄດ້ — ລະບົບໄດ້ສຳຮອງຂໍ້ມູນລົງໂຟນເດີໃນເຄື່ອງຊົ່ວຄາວແລ້ວ ກະລຸນາກວດສອບ USB`,
        `External backup drive (${m[1]}) is unavailable or not writable — backup saved to local fallback folder instead. Please check the USB drive`,
        orig
      ),
  },
  {
    regex: /^โหมด "(.+)" พิมพ์ผ่านหน้าต่างเบราว์เซอร์โดยตรง ไม่ต้องส่งคำสั่ง RAW มายังเซิร์ฟเวอร์$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `ໂໝດ "${m[1]}" ພິມຜ່ານໜ້າຕ່າງບຣາວເຊີໂດຍຕົງ ບໍ່ຈຳເປັນຕ້ອງສົ່ງຄຳສັ່ງ RAW ຫາເຊີບເວີ`,
        `Mode "${m[1]}" prints directly via the browser dialog without sending RAW commands to the server`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 เมนูที่เลือกไม่พร้อมจำหน่าย \((.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ເມນູທີ່ເລືອກບໍ່ພ້ອມຈຳໜ່າຍ (${m[1]})`,
        `HTTP 400 Selected menu item is currently unavailable (${m[1]})`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 ไม่พบตัวเลือกเสริมที่เลือก \((.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ບໍ່ພົບຕົວເລືອກເສີມທີ່ເລືອກ (${m[1]})`,
        `HTTP 400 Selected modifier was not found (${m[1]})`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 กลุ่มตัวเลือก "(.+)" เลือกได้เพียง 1 รายการ$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ກຸ່ມຕົວເລືອກ "${m[1]}" ເລືອກໄດ້ພຽງ 1 ລາຍການ`,
        `HTTP 400 Modifier group "${m[1]}" allows only 1 selection`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 กลุ่มตัวเลือก "(.+)" เลือกได้ไม่เกิน (\d+) รายการ$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ກຸ່ມຕົວເລືອກ "${m[1]}" ເລືອກໄດ້ບໍ່ເກີນ ${m[2]} ລາຍການ`,
        `HTTP 400 Modifier group "${m[1]}" allows at most ${m[2]} selections`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 กรุณาเลือก "(.+)" อย่างน้อย (\d+) รายการ$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ກະລຸນາເລືອກ "${m[1]}" ຢ່າງໜ້ອຍ ${m[2]} ລາຍການ`,
        `HTTP 400 Please select at least ${m[2]} option(s) for "${m[1]}"`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 ไม่พบหมายเลขโต๊ะ "(.+)" ในรายการโต๊ะของร้าน$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ບໍ່ພົບເລກໂຕະ "${m[1]}" ໃນລາຍການໂຕະຂອງຮ້ານ`,
        `HTTP 400 Table "${m[1]}" was not found in the store table list`,
        orig
      ),
  },
  {
    regex: /^HTTP 400 สั่งได้สูงสุด (\d+) ที่ต่อเมนูในหนึ่งครั้ง$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 400 ສັ່ງໄດ້ສູງສຸດ ${m[1]} ທີ່ຕໍ່ເມນູໃນໜຶ່ງຄັ້ງ`,
        `HTTP 400 Maximum ${m[1]} units per item allowed per order`,
        orig
      ),
  },
  {
    regex: /^HTTP 409 สินค้าหรือวัตถุดิบ "(.+)" คงเหลือไม่เพียงพอสำหรับการรับออเดอร์นี้$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 409 ສິນຄ້າ ຫຼື ວັດຖຸດິບ "${m[1]}" ຄົງເຫຼືອບໍ່ພຽງພໍສຳລັບການຮັບອໍເດີນີ້`,
        `HTTP 409 Insufficient stock of "${m[1]}" to accept this order`,
        orig
      ),
  },
  {
    regex: /^HTTP 409 สินค้าหรือวัตถุดิบ "(.+)" คงเหลือไม่เพียงพอ$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 409 ສິນຄ້າ ຫຼື ວັດຖຸດິບ "${m[1]}" ຄົງເຫຼືອບໍ່ພຽງພໍ`,
        `HTTP 409 Insufficient stock for "${m[1]}"`,
        orig
      ),
  },
  {
    regex: /^HTTP 409 ออเดอร์ (.+) ถูกดำเนินการไปแล้ว \(สถานะ: (.+)\)$/,
    render: (m, loc, orig) =>
      pickErr(
        loc,
        `HTTP 409 ອໍເດີ ${m[1]} ຖືກດຳເນີນການໄປແລ້ວ (ສະຖານະ: ${m[2]})`,
        `HTTP 409 Order ${m[1]} has already been processed (status: ${m[2]})`,
        orig
      ),
  },
];

export function localizeServerMessage(rawMessage: string, locale: LocaleCode): string {
  if (locale === 'th' || !rawMessage) {
    return rawMessage;
  }
  const exact = EXACT_MAP.get(rawMessage);
  if (exact) {
    return locale === 'lo' ? exact[0] : exact[1];
  }
  for (const rule of PATTERN_RULES) {
    const match = rule.regex.exec(rawMessage);
    if (match) {
      return rule.render(match, locale, rawMessage);
    }
  }
  // Substring fallback inside custom error messages
  return rawMessage
    .replace('กรุณาตรวจสอบว่าเสียบแฟลชไดรฟ์ USB แล้ว', locale === 'lo' ? 'ກະລຸນາກວດສອບວ່າສຽບແຟລຊໄດຣຟ USB ແລ້ວ' : 'Please check that the USB drive is connected')
    .replace('เครื่องอื่น', locale === 'lo' ? 'ເຄື່ອງອື່ນ' : 'another terminal');
}
