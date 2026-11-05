# Changelog: RUBE-STOCK-POS

All notable changes to the **RUBE-STOCK-POS** system specification, architecture blueprints, and implementation codebase will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] - 2026-11-05

### Architectural Hardening & Production Upgrades (Specification v3.0 -> v3.1)

#### Added
- **External Keystore Manifest (`keystore.manifest.json`)**:
  - แก้ปัญหา **Bootstrap Paradox** ของ SQLCipher โดยแยกส่วนหัวกุญแจเข้ารหัส (Envelope Header) ออกจากไฟล์ฐานข้อมูลมาเก็บไว้ที่ `%PROGRAMDATA%\RubePOS\keystore.manifest.json`
  - รองรับ 2 Slot: `dpapi_slot` (Windows DPAPI + TPM 2.0 สำหรับเปิดเครื่องตอนเช้าแบบ Unattended Kiosk Boot) และ `argon2_recovery_slot` (Argon2id KEK สำหรับกู้คืนข้ามเครื่องหรือปลดล็อกเมื่อรหัสผ่าน Windows บนเครื่องเดิมถูกรีเซ็ต)
- **128-bit Intermediate Integer Math Mandate (`math_i128.rs` / `roundDivBigInt`)**:
  - ป้องกันปัญหา **Integer Overflow** ในระดับ `i64` และ JavaScript `MAX_SAFE_INTEGER` โดยบังคับใช้ `i128` สำหรับตัวแปรระหว่างการคูณและหารในสูตร MAC, Landed Cost, และ BOM ก่อนย่อสเกลกลับเป็น `i64`
  - ฟังก์ชันการปัดเศษสมมาตรแบบ Round-Half-Away-From-Zero บนค่าสัมบูรณ์ (`round_div(a, b)`)
- **Complete Cashier Shift & Cash Drawer Tracking**:
  - เพิ่มตาราง `pos_shifts` (บันทึกยอดเงินทอนตั้งต้น `opening_cash_satang`, ยอดคาดหวัง `expected_cash_satang`, ยอดนับจริง `counted_cash_satang`, และผลต่าง `cash_variance_satang`)
  - เพิ่มตาราง `cash_drawer_movements` สำหรับบันทึกรายการนำเงินเข้า-ออกลิ้นชัก (`OPENING_FLOAT`, `PAID_IN`, `PAID_OUT`, `CASH_DROP`)
- **Thai VAT & Simplified Tax Invoice (ใบกำกับภาษีอย่างย่อ - ABB)**:
  - เพิ่มฟิลด์ `tax_mode` (`INCLUSIVE`, `EXCLUSIVE`, `NONE`) และ `abb_tax_invoice_no` ในตาราง `sales_orders`
  - สูตรคำนวณถอดภาษีมูลค่าเพิ่ม 7% แบบสตางค์แม่นยำ
- **Pre-Built Sub-Assembly Stopping Rule & Role-Based Modifiers**:
  - กำหนดกฎการเดินกราฟ BOM ให้ **หยุดแตกแขนงที่โหนดลูกที่มี `use_production = 1`** เพื่อตัดสต็อกของสำเร็จรูปกึ่งผลิต (เช่น เบสชานมต้มสุก หรือไข่มุกต้มสุก) โดยไม่ตัดสต็อกวัตถุดิบตั้งต้นซ้ำซ้อน
  - เพิ่มระบบ `component_role` (`SWEETENER`, `MILK_BASE`, `TEA_BASE`, ฯลฯ) และ `modifier_mode` (`ROLE_SCALE_BPS`) ทำให้ตัวเลือกเสริมอย่าง "หวานน้อย 50%" สามารถปรับลดปริมาณความหวานได้ถูกต้องทุกเมนู ไม่ว่าจะใช้น้ำเชื่อม น้ำผึ้ง หรือนมข้นหวาน
- **Thai Hardware Real-World Hardening**:
  - **Scanner HAL**: ดักจับระดับ USB Raw Input (`WM_INPUT`) ร่วมกับรหัสปุ่มกายภาพ (`KeyboardEvent.code`) แก้ปัญหาบาร์โค้ดเพี้ยนเมื่อแป้นพิมพ์ Windows ค้างที่ภาษาไทย พร้อมระบบ **First-Char Rollback** ลบอักษรแรกที่รั่วเข้าช่องค้นหาเมื่อตรวจพบความเร็ว `< 50ms`
  - **Scale Barcode**: รองรับบาร์โค้ดตราชั่ง EAN-13 ทั้งแบบฝังน้ำหนัก (Prefix `20`–`24`) และแบบฝังราคารวม (Prefix `25`–`29` คำนวณน้ำหนักย้อนกลับจากราคาต่อหน่วย)
  - **Printer HAL**: โหมด **Chunked Band 203-DPI Raster (`GS v 0`)** แบ่งแถบภาพแนวนอนละ $64\text{--}128\text{ px}$ พร้อมคำสั่งข้ามพื้นที่สีขาว `ESC J n` ป้องกันบัฟเฟอร์ขนาด $4\text{--}8\text{ KB}$ ของเครื่องพิมพ์ราคาประหยัดล้น
  - **Payment HAL**: ตรวจสอบโครงสร้าง TLV ของ **BOT Slip Mini-QR** (ธนาคารแห่งประเทศไทย) ถอดรหัส `sender_bank_code` และ `TransRef` ทำแฮช SHA-256 ป้องกันสลิปซ้ำ พร้อมหน้าต่างยืนยันโลโก้ธนาคารและยอดเงินขนาดใหญ่ ป้องกันสลิป 1 บาทตัดต่อตัวเลข
- **Cluster Gateway Logical Sync & Epoch Fencing**:
  - เปลี่ยนจาก Raw WAL Streaming เป็น **Logical Transaction Stream (`global_tx_seq`)** ป้องกันฐานข้อมูลสำรองพังหลังเกิด `wal_checkpoint(TRUNCATE)`
  - เพิ่ม `cluster_epoch` Fencing Token ป้องกันปัญหา Split-Brain เมื่อกู้คืนระบบ (เครื่อง Leader เดิมจะลดสถานะเป็น Read-Only Quarantine อัตโนมัติหากพบโหนดที่มี Epoch สูงกว่า)

#### Changed
- ขยายโครงสร้างฐานข้อมูล SQLite DDL ใน `0001_initial_v3_1_schema.sql` จาก 24 ตาราง เป็น **34 ตาราง** พร้อม 3 Immutable Triggers (ห้ามแก้ไข/ลบ `inventory_transactions` และ `security_audit_logs`)
- ล็อกมาตรฐานสถาปัตยกรรมเป็น **Tauri v2 + Rust Core** ร่วมกับ React 19 + TypeScript (`specta` Type-Safe IPC) แทนตัวเลือกรันไทม์แบบเปิด
- ย้ายการเปิดใช้งาน SQLCipher และ Connection Pool แยกอ่าน-เขียนมาไว้ใน **เฟสที่ 1** (เริ่มตั้งแต่สัปดาห์ที่ 2) โดยใช้กุญแจ Hex Key ตั้งแต่วันแรก

---

### Phase 0 Monorepo Scaffold & Core Implementation

#### Monorepo Foundation & Workspaces
- สร้างโครงสร้าง Monorepo มาตรฐานตาม `IMPLEMENTATION_PLAYBOOK.md`:
  - `package.json` (Node.js Workspace รองรับ Node >= 22.6.0)
  - `Cargo.toml` (Rust Workspace รวม 4 crates)
  - `tsconfig.base.json` (TypeScript Project Configuration)
  - `.gitignore` (กรองไฟล์แคช, ไบนารี, ฐานข้อมูล และ keystore)

#### Package Implementations
1. **`packages/shared-contracts`**:
   - `src/lib.rs`: Rust Type definitions (`MilliUnit`, `Satang`, `MicroBaht`, `BasisPoints`, `KeystoreManifest`)
   - `src/fixed-point.ts`: ฟังก์ชัน `roundDivBigInt`, `allocateLandedCostExact` (Largest Remainder Method), `computeNewMovingAverageCost` (พร้อม Negative Stock Guard), `computeVatSatang`
   - `src/ipc-commands.ts`: โครงสร้าง DTOs, `validateBomDagAcyclic` (DFS Cycle Detection), `calculateOrderLineDeductions` (Pre-Built Boundary & Role Modifiers)
   - `src/hal-events.ts`: โครงสร้าง Event ฮาร์ดแวร์ครบวงจร
   - `src/mocks/mock-ipc-bridge.ts`: แค็ตตาล็อกจำลอง (สินค้าปลีก, สินค้าชั่งน้ำหนัก, วัตถุดิบคาเฟ่, ไข่มุกต้มสุก Pre-built, สูตรเครื่องดื่ม, ตัวเลือกเสริม)

2. **`packages/core-engine`**:
   - `migrations/0001_initial_v3_1_schema.sql`: โครงสร้างฐานข้อมูล DDL ฉบับสมบูรณ์ 34 ตาราง
   - `migrations/0001_initial_v3_1_schema.sha256`: ลายเซ็นดิจิทัล SHA-256 ของสคริปต์ DDL (`18dc97cf92b4afe6cd6ad875f91e1464c8f620f136355de83d6f001aa26533f2`)
   - `src/domains/math_i128.rs`: เอนจินคณิตศาสตร์จำนวนเต็ม `i128` ป้องกัน Overflow
   - `src/domains/costing_mac.rs`: เอนจินคำนวณต้นทุน MAC และการปันส่วน Landed Cost
   - `src/domains/bom_dag.rs`: อัลกอริทึมตรวจสอบกราฟ DAG ป้องกันสูตรวนลูป
   - `src/domains/sales_shift.rs`: เอนจินคำนวณภาษี ABB, การยกเลิกบิลย้อนกลับแบบสะท้อนประวัติจริง (`VOID_RETURN`), และสมการอนุรักษ์เงินสดในกะ
   - `src/domains/backup.rs`: โมดูลสำรองข้อมูลลงแฟลชไดรฟ์ USB แบบ `.part` + `fsync` พร้อม Ring Buffer หมุนเวียน 14 กะย้อนหลัง
   - `src/db/pool.rs`: ตัวสร้าง PRAGMA Initialization สำหรับ SQLCipher Raw Hex Key + Read/Write Split Pool
   - `src/db/keyring.rs`: ตัวจัดการอ่าน-เขียนไฟล์ `keystore.manifest.json` แบบ Atomic
   - `src/db/migrator.rs`: ตัวรัน Migration 5 ขั้นตอนที่จัดการ `PRAGMA foreign_keys` นอก Transaction อย่างปลอดภัย

3. **`packages/hal-drivers`**:
   - `src/scanner/mod.ts`: ตัวแปลง `KeyboardEvent.code` ป้องกันแป้นพิมพ์ไทย และตัวแยกบาร์โค้ดตราชั่ง EAN-13 (น้ำหนัก/ราคา)
   - `src/printer/mod.ts`: ตัวแปลงและหั่นภาพบิตแมปเป็นคำสั่ง `GS v 0` แถบละ 64–128 dots พร้อมแปลงช่องว่างเป็นคำสั่งเลื่อนกระดาษ `ESC J n`
   - `src/payment/mod.ts`: ตัวสร้าง Dynamic QR พร้อมเพย์ออฟไลน์ (CRC16-CCITT `0x1021`) และตัวตรวจสอบโครงสร้าง BOT Mini-QR ป้องกันสลิปซ้ำ
   - `src/simulators/virtual-hardware-bench.ts`: ชุดจำลองฮาร์ดแวร์เสมือน (ปืนบาร์โค้ด, พิมพ์ใบเสร็จ, จำลองไฟดับ UPS `AC_PRESENT = 0`, จำลองเสียบ USB สำรองข้อมูล 14 กะ)

4. **`packages/cluster-gateway`**:
   - `src/ipc_router.rs`: โครงสร้าง Standalone IPC Isolation (ปิดพอร์ต TCP ในโหมดเครื่องเดียว)
   - `src/mdns_discovery.rs`: ตัวจัดรูปแบบ TXT Record สำหรับ mDNS `_rube-pos._tcp.local.`
   - `src/mtls_ca.rs`: ฟังก์ชันตรวจสอบรหัส 6-Digit Pairing PIN สำหรับออกใบรับรอง mTLS
   - `src/kds_sync.rs`: ฟังก์ชันกรองดึงออเดอร์ตกหล่นในครัว (`sequence_id > last_acked_kds_seq`)
   - `src/tx_replicator.rs`: ตัวจัดการซิงค์สตรีมธุรกรรมเชิงตรรกะ และตัวป้องกัน Split-Brain ด้วย `cluster_epoch`

5. **`packages/ui-presentation`**:
   - `src/profiles/profile-config.ts`: แมทริกซ์ Feature Flags ตามโปรไฟล์ธุรกิจ (`RETAIL`, `HOSPITALITY`, `HYBRID`)
   - `src/hooks/usePhysicalScanner.ts`: สตรีมบัฟเฟอร์ดักจับบาร์โค้ด `< 50ms` พร้อมระบบ First-Char Rollback

#### Automated Verification & Testing
- `scripts/verify-schema-checksum.mjs`: สคริปต์ตรวจสอบความถูกต้องของโครงสร้าง 34 ตารางและ 3 ทริกเกอร์ พร้อมบันทึก SHA-256
- `tests/property-invariants/accounting-invariants.test.ts`:
  - ทดสอบ Invariant 1: Ledger Conservation และ Negative Stock Guard ของ MAC
  - ทดสอบ Invariant 2: Landed Cost Exact Apportionment ด้วยสุ่มฟัซซิ่ง 500 รอบ และคำสั่งซื้อขนาดใหญ่พิเศษระดับ `i128` โดยไม่มีเศษตกหล่น
  - ทดสอบ Invariant 3: บล็อกสูตร BOM วนลูป, หยุดเดินกราฟที่โหนด `use_production = true`, และปรับลดความหวานตามบทบาท `SWEETENER` ถูกต้องข้ามเมนู
  - ทดสอบ Invariant 4: ความแม่นยำของภาษีมูลค่าเพิ่ม 7% ทั้ง Inclusive และ Exclusive
- `tests/e2e-integration/phase0-assembly.test.ts`:
  - ยืนยันสคริปต์ SQL DDL 34 ตาราง
  - ยืนยันการยิงบาร์โค้ดขณะแป้นพิมพ์เป็นภาษาไทยและลบอักษรตัวแรกที่รั่วเข้าช่องค้นหาออกสำเร็จ
  - ยืนยันตัวแยกบาร์โค้ดตราชั่งทั้งแบบน้ำหนักและราคา
  - ยืนยันการหั่นภาพใบเสร็จ Chunked Raster 203-DPI ไม่เกินบัฟเฟอร์ 8KB ของเครื่องพิมพ์
  - ยืนยันการสร้าง QR พร้อมเพย์และบล็อกสลิป BOT Mini-QR ซ้ำ
  - ยืนยันการตัดเข้าโหมดสำรองไฟ UPS และการหมุนเวียนไฟล์สำรองใน USB Flash Drive คงเหลือ 14 กะล่าสุด
- **ผลการทดสอบทั้งหมด**: ผ่านครบ **10/10 tests (100% pass)** ในเวลา ~116ms

