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
- ขยายโครงสร้างฐานข้อมูล SQLite DDL ใน `0001_initial_v3_1_schema.sql` จาก 24 ตาราง เป็น **34 ตาราง** พร้อม **4 Immutable Triggers** (ห้ามแก้ไข/ลบ `inventory_transactions` และ `security_audit_logs`)
- ล็อกมาตรฐานสถาปัตยกรรมเป็น **Tauri v2 + Rust Core** ร่วมกับ React 19 + TypeScript (`specta` Type-Safe IPC) แทนตัวเลือกรันไม์แบบเปิด
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
   - `migrations/0001_initial_v3_1_schema.sql`: โครงสร้างฐานข้อมูล DDL ฉบับสมบูรณ์ 34 ตาราง พร้อม 4 Immutable Triggers
   - `migrations/0001_initial_v3_1_schema.sha256`: ลายเซ็นดิจิทัล SHA-256 แบบ Normalized LF ของสคริปต์ DDL (`866a600d3e5eaf0351712c2e7d3085dc6abd68f39f800a1dc7d7ada1895b8d37`)
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
- **ผลการทดสอบทั้งหมด (Phase 0)**: ผ่านครบ **10/10 tests (100% pass)** ในเวลา ~116ms

---

### Phase 1: High-Speed SQLCipher Read/Write Split Pool & `i128` Costing/BOM Engine (Weeks 2–4)

#### Squad A: Core Database & Accounting Engine (`packages/core-engine`)
- **`src/db/pool.rs` & `src/runtime/sqlite-engine.ts` (`WBS-01` & `WBS-02`)**:
  - พัฒนา `SqliteReadWriteSplitPool` และ `SqliteReadWritePoolEngine` (ใช้ `node:sqlite` `DatabaseSync` บนฐานข้อมูลไฟล์จริงโหมด WAL)
  - แยก **1 Dedicated Writer Connection** ที่ทำงานผ่านคิว FIFO แบบอนุกรมด้วย `BEGIN IMMEDIATE TRANSACTION;` ออกจาก **4–8 Concurrent Reader Connections** ที่ล็อก `PRAGMA query_only = ON;` และกระจายโหลดแบบ Round-Robin ขจัดปัญหา `SQLITE_BUSY` 100%
  - ปรับปรุงตัวรัน Migration 5 ขั้นตอนให้คัดกรองคำสั่งระดับการเชื่อมต่อ (`PRAGMA journal_mode`, `PRAGMA synchronous`) ออกก่อนรัน DDL ภายใน `BEGIN EXCLUSIVE TRANSACTION;` และตรวจสอบ `PRAGMA foreign_key_check;` ก่อน `COMMIT`
- **`src/domains/costing_mac.rs` & `src/runtime/sqlite-engine.ts` (`WBS-04`)**:
  - เชื่อมต่อระบบรับสินค้าเข้าคลัง (`receivePurchaseOrderWithLandedCosts`) และระบบจำลองต้นทุนก่อนรับจริง (`previewPurchaseOrderCosting`) เข้ากับตาราง `purchase_orders`, `purchase_order_items`, `purchase_order_landed_costs`, `inventory_levels`, และ `inventory_transactions`
  - บังคับใช้ **Negative/Zero Stock Guard** รีเซ็ตค่าเฉลี่ยเคลื่อนที่ (MAC) เป็นต้นทุนล็อตใหม่ทันทีเมื่อสต็อกก่อนรับติดลบหรือเป็นศูนย์
- **`src/domains/bom_dag.rs` & `src/runtime/sqlite-engine.ts` (`WBS-05`)**:
  - เพิ่มฟังก์ชัน `compute_multilevel_bom_deductions` (Rust) และ `executeProductionBuildBatch` / `computeLiveRecipePreview` (SQLite Runtime)
  - รองรับการต้ม/ผลิตวัตถุดิบเตรียมไว้ล่วงหน้า (`PRODUCTION_BUILD` สำหรับสินค้า `use_production = 1`) พร้อมคำนวณต้นทุน MAC ของล็อตที่ผลิตจากวัตถุดิบย่อยและเปอร์เซ็นต์สูญเสีย (`wastage_basis_points`)
  - บังคับใช้กฎ **Pre-Built Stopping Rule** (หยุดแตกแขนงที่โหนด `use_production = 1`) และ **Role-Based Modifiers** (`ROLE_SCALE_BPS` ปรับสัดส่วนเฉพาะบทบาท เช่น `SWEETENER`)

#### Squad B: Hardware Abstraction Layer (`packages/hal-drivers`)
- **`src/scanner/mod.ts` (`WBS-07`)**:
  - เพิ่มอัลกอริทึมคำนวณและตรวจสอบเลขตรวจสอบมาตรฐาน GS1 EAN-13 Modulo-10 (`computeEan13CheckDigit`, `verifyEan13CheckDigit`)
  - อัปเกรด `parseScaleBarcodeEan13` ให้คืนค่าสถานะ `checkDigitValid` และรองรับโหมดบังคับตรวจเลข Check Digit (`enforceCheckDigit`) สำหรับบาร์โค้ดตราชั่งทั้งแบบฝังน้ำหนัก (`Prefix 20–24`) และแบบฝังราคารวม (`Prefix 25–29`)

#### Squad C: UI Presentation Views (`packages/ui-presentation` — `WBS-12`)
- **`src/views/inventory/InventoryView.ts` (`INV_VIEW`)**:
  - สร้าง `InventoryViewController` แปลงข้อมูลคงคลังในหน่วย `Milli-Units` และต้นทุน `Micro-Baht` เป็น ViewModel พร้อมแจ้งเตือนสต็อกต่ำ/ติดลบ และจับคู่บาร์โค้ดตราชั่งจากรหัสปุ่มกายภาพ (`resolveScannedKeyCodes`)
- **`src/views/inventory/PurchaseOrderView.ts` (`PO_VIEW`)**:
  - สร้าง `PurchaseOrderViewController` แสดงตัวอย่างการปันส่วนค่าขนส่ง/ค่าธรรมเนียม (Landed Cost Preview) และเปรียบเทียบ `MAC เดิม -> ต้นทุนสุทธิล็อตใหม่ -> MAC ใหม่` ก่อนกดยืนยันรับของเข้าคลัง
- **`src/views/bom-editor/BomEditorView.ts` (`BOM_VIEW`)**:
  - สร้าง `BomEditorViewController` สำหรับผูกสูตรการผลิตหลายระดับ (Multi-Level BOM), บล็อกสูตรวนลูปแบบทันที, คำนวณต้นทุนสูตร (Live Recipe COGS & Gross Margin Preview), และสั่งผลิตวัตถุดิบเตรียมขาย (`runPrepBatchBuild`)

#### Squad D: Local IPC Bridge & Phase 1 Assembly Verification (`packages/cluster-gateway` & `tests/e2e-integration`)
- **`packages/cluster-gateway/src/local-ipc-bridge.ts`**:
  - สร้าง `LocalIpcBridge` เชื่อมต่อ View Controllers ของ Squad C เข้ากับ `SqliteReadWritePoolEngine` ของ Squad A พร้อมตัวนับสถิติ Read/Write IPC
- **`tests/e2e-integration/phase1-warehouse-assembly.test.ts`**:
  - ทดสอบการทำงานร่วมกันของทั้ง 4 ทีมบนฐานข้อมูล SQLite โหมด WAL จริง:
    1. ทดสอบ Read/Write Split Pool (`1 Writer` + `4 Readers`), ยืนยันว่า Reader บล็อกการเขียนด้วย `PRAGMA query_only = ON`, และยืนยันว่า Immutable Triggers บล็อกการ `UPDATE`/`DELETE` บน `inventory_transactions`
    2. ทดสอบรับใบสั่งซื้อพร้อมปันส่วน Landed Cost (`FREIGHT` + `HANDLING`) ครบทุกไมโครบาท และทดสอบ Negative Stock Guard เมื่อรับสินค้าเข้าสต็อกที่ติดลบ
    3. ทดสอบผูกสูตร BOM 2 ระดับ, บล็อกวงจรปิด 3 โหนด (`HTTP 422 Circular BOM Dependency`), สั่งต้มไข่มุก (`PRODUCTION_BUILD`), คำนวณตัดสต็อกชานมหวาน 50% (`MOD-SWEET-50`), สแกนบาร์โค้ดตราชั่ง (`Prefix 20` & `Prefix 25`), และยืนยันสมการอนุรักษ์สต็อก (`verifyLedgerConservationInvariant`)
- **ผลการทดสอบทั้งหมด (Phase 0 + Phase 1 + Property Invariants)**: ผ่านครบ **14/14 tests (100% pass)**

---

### Logic Audit & Regression Fixes (Post-Phase 1 Hardening)

#### Fixed (การแก้ไขจุดบกพร่องทางตรรกะทั้ง 14 รายการ)
1. **Rust 5-Step Migrator `PRAGMA` Stripping & Line-Ending Normalization (`packages/core-engine/src/db/migrator.rs`)**:
   - เพิ่มฟังก์ชัน `strip_connection_level_pragmas` เพื่อคัดกรองคำสั่งระดับการเชื่อมต่อ (`PRAGMA foreign_keys`, `PRAGMA journal_mode`, `PRAGMA synchronous`) ออกก่อนรัน DDL ภายใน `BEGIN EXCLUSIVE TRANSACTION;` ป้องกันข้อผิดพลาด `Safety level may not be changed inside a transaction` ในฝั่ง Rust ให้สอดคล้องกับฝั่ง TypeScript
   - ปรับ `compute_migration_checksum_hex` ให้แปลง `\r\n` เป็น `\n` ก่อนคำนวณ SHA-256 เพื่อให้ได้ค่า Checksum เดียวกันทุกระบบปฏิบัติการ
2. **Atomic `UPSERT` on `inventory_levels` & Pre-Built Production Validation (`packages/core-engine/src/runtime/sqlite-engine.ts`)**:
   - เปลี่ยนคำสั่งอัปเดตยอดคงคลังใน `executeProductionBuildBatch` และ `recordStockDelta` จาก `UPDATE inventory_levels` เป็น `INSERT INTO inventory_levels ... ON CONFLICT(outlet_id, variant_id) DO UPDATE` ป้องกันกรณีสินค้าหรือสาขาใหม่ยังไม่มีแถวตั้งต้นใน `inventory_levels` ซึ่งจะทำให้สมการอนุรักษ์สต็อก (`Invariant 1`) คลาดเคลื่อน
   - เพิ่มการตรวจสอบ `buildQtyMilli > 0` และตรวจสอบว่าสินค้าที่สั่งผลิตต้องมี `is_composite = 1` และ `use_production = 1` เท่านั้น พร้อมรองรับการแตกสูตรย่อยแบบ Recursive หากวัตถุดิบลูกเป็นสูตรเสมือน (`is_composite = 1, use_production = 0`)
3. **Signed COGS Calculation for Negative `FIXED_QTY_DELTA` Modifiers (`packages/shared-contracts/src/ipc-commands.ts` & `packages/core-engine/src/domains/bom_dag.rs`)**:
   - แก้ไขการคำนวณ `lineCogsMicroBaht` ของตัวเลือกเสริมโหมด `FIXED_QTY_DELTA` ให้คงเครื่องหมายบวก/ลบตาม `deltaMilli` (แทนการใช้ค่าสัมบูรณ์ `absDelta`) เพื่อให้ตัวเลือกเสริมแบบลดวัตถุดิบ (เช่น "ไม่ใส่ไข่มุก" `quantityDeltaMilli < 0`) ลดต้นทุน COGS ลงอย่างถูกต้อง
4. **Complete Immutable Triggers on `security_audit_logs` (`packages/core-engine/migrations/0001_initial_v3_1_schema.sql`)**:
   - เพิ่มทริกเกอร์ `trg_prevent_sec_audit_update` (`BEFORE UPDATE ON security_audit_logs`) ควบคู่กับ `trg_prevent_sec_audit_mutation` (`BEFORE DELETE`) รวมเป็น **4 Immutable Triggers** ป้องกันการแก้ไขหรือลบประวัติความปลอดภัยย้อนหลัง 100%
5. **Multi-Level BOM `ROLE_SCALE_BPS` Double-Scaling Guard & Leaf Aggregation (`ipc-commands.ts` & `bom_dag.rs`)**:
   - เพิ่มชุดติดตาม `scaledRolesInAncestors` ระหว่างเดินกราฟ BOM หลายระดับ เพื่อป้องกันไม่ให้บทบาทเดียวกัน (เช่น `SWEETENER`) ถูกคูณลดสัดส่วนซ้ำสองรอบเมื่อทั้งโหนดแม่และโหนดลูกต่างระบุบทบาท `SWEETENER`
   - รวมยอดรายการตัดสต็อก `SALE_BOM` ที่มี `variantId` เดียวกันในออเดอร์เดียวกันเข้าด้วยกัน ป้องกันข้อมูลทับกันเมื่อแปลงเป็น `Map`
6. **Missing Catalog Variant Error Parity (`bom_dag.rs`, `math_i128.rs`, `ipc-commands.ts`)**:
   - เพิ่ม `FixedPointError::MissingComponentVariant(String)` ในฝั่ง Rust และปรับให้ทั้ง Rust และ TypeScript โยน Error ทันทีเมื่อไม่พบรหัสวัตถุดิบของสูตร BOM หรือ Modifier ในแค็ตตาล็อก แทนการข้ามไปเงียบๆ (`continue`)
7. **Database-Driven Modifiers in `computeLiveRecipePreview` (`sqlite-engine.ts`)**:
   - เพิ่มเมธอด `listModifiers()` ดึงข้อมูลจากตาราง `modifiers` ใน SQLite โดยตรงแทนการอ้างอิงเฉพาะ `SEED_MODIFIERS`
8. **BOT Slip Mini-QR Exact TLV Length Validation & Two-Phase Hash Commit (`packages/hal-drivers/src/payment/mod.ts`)**:
   - ตรวจสอบความยาว TLV ของ BOT Mini-QR อย่างเคร่งครัด (`outerTlvLen === 21 + declaredLen` และ `transRef.length === declaredLen`) ป้องกันข้อมูล QR ที่ถูกตัดทอนหรือยาวเกิน 35 ตัวอักษร
   - เพิ่มตัวเลือก `commitSlipHash?: boolean` และฟังก์ชัน `commitVerifiedBotSlipHash` เพื่อรองรับการตรวจสอบสลิปแบบ 2 ขั้นตอน (Two-Phase Confirmation) โดยไม่ล็อกสลิปเป็นซ้ำหากแคชเชียร์กดยกเลิกหน้าต่างยืนยันยอดเงินก่อนบันทึกบิล
   - เพิ่มการตรวจสอบ `amountSatang > 0` ใน `generateOfflinePromptPayDynamicQr`
9. **Mid-Band Whitespace Splitting in Thermal Printer Driver (`packages/hal-drivers/src/printer/mod.ts`)**:
   - ปรับปรุง `encodeChunkedRasterGsV0` ให้ตรวจสอบล่วงหน้าภายในแถบภาพ หากพบบรรทัดสีขาวติดต่อกัน `>= 16 dots` เริ่มต้นขึ้นกลางแถบ จะตัดจบแถบ `GS v 0` ปัจจุบันทันทีเพื่อส่งคำสั่งเลื่อนกระดาษ `ESC J n` ในรอบถัดไป
10. **Modifier Key Filtering in Physical Scanner Stream Buffer (`packages/ui-presentation/src/hooks/usePhysicalScanner.ts`)**:
    - กรองปุ่มควบคุม (`ShiftLeft`, `ShiftRight`, `Control`, `Alt`, `Meta`, `CapsLock`, `Tab`, `Escape`) และปุ่มที่ไม่อยู่ในตารางบาร์โค้ดออกก่อนเข้าบัฟเฟอร์ ป้องกันการกด `Shift + ตัวอักษร` ของพนักงานไปกระตุ้น `onRollbackFirstChar` โดยไม่ตั้งใจ
11. **Weighted Scale SKU Resolution Priority (`packages/ui-presentation/src/views/inventory/InventoryView.ts`)**:
    - จัดลำดับความสำคัญในการค้นหาสินค้าจากบาร์โค้ดตราชั่ง (`Prefix 20–29`) ให้เลือกสินค้าที่มี `isWeightedScale === true` เป็นอันดับแรก ป้องกันการจับคู่ผิดไปโดนสินค้าปลีกทั่วไปที่มีรหัส EAN-13 ลงท้ายด้วยเลข 5 หลักเดียวกัน
12. **JavaScript `MAX_SAFE_INTEGER` Precision Guard & Negative Cost Validation (`fixed-point.ts` & `costing_mac.rs`)**:
    - เพิ่มฟังก์ชัน `toSafeFixedPointNumber` ตรวจสอบทั้งขอบเขต `i64` และ `Number.MAX_SAFE_INTEGER` ก่อนแปลง `bigint` เป็น `number`
    - บังคับตรวจสอบ `totalLandedCostSatang >= 0` และต้นทุนต่อหน่วย `>= 0` ทั้งในฝั่ง TypeScript และ Rust
13. **Natural Numeric Sorting for 14-Shift USB Ring Buffer (`backup.rs` & `virtual-hardware-bench.ts`)**:
    - เพิ่ม `compare_backup_filenames_natural` (Rust) และ `localeCompare(..., { numeric: true })` (TypeScript) เพื่อให้ชื่อไฟล์กะที่ไม่ได้เติมศูนย์นำหน้า (เช่น `20261105-S2` กับ `20261105-S10`) เรียงตามลำดับตัวเลขจริง ไม่ลบไฟล์ `S10` ก่อน `S2`
14. **Deterministic Schema Checksum Verification (`scripts/verify-schema-checksum.mjs` & `tx_replicator.rs`)**:
    - ปรับสคริปต์ `verify-schema-checksum.mjs` ให้ตรวจสอบเทียบค่ากับไฟล์ `.sha256` เป็นค่าเริ่มต้น (และอัปเดตเมื่อระบุ `--update`) พร้อมบังคับกักกันโหนด `ActiveLeader` ทันทีหากตรวจพบ `peer_epoch >= current_epoch` และบล็อกการเลื่อนสถานะตัวเองขณะอยู่ในโหมด `ReadOnlyQuarantine`



