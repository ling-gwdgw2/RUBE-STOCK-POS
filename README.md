# RUBE-STOCK-POS (v3.1)

Unified Local-First Warehouse & POS System (Enterprise Production & Audit-Hardened Blueprint)

[![Phase 0 & 1 Tests](https://img.shields.io/badge/Phase%200%20%26%201%20Tests-13%2F13%20Passing-brightgreen)](#automated-testing)
[![Architecture Version](https://img.shields.io/badge/Architecture-v3.1.0-blue)](#key-architectural-pillars)
[![Platform](https://img.shields.io/badge/Platform-Windows%20Standalone%20%7C%20Local%20LAN-orange)](#overview)

---

## 📌 ภาพรวมโครงการ (Project Overview)

**RUBE-STOCK-POS** เป็นระบบจัดการคลังสินค้าและจุดขาย (WMS & POS) แบบ **Local-First** ที่ทำงานได้เสถียร 100% แม้ไม่มีอินเทอร์เน็ต (100% Air-Gapped Capable) ออกแบบมาเพื่อธุรกิจค้าปลีก/ซูเปอร์มาร์เก็ต (Retail) และคาเฟ่/ร้านอาหาร (Hospitality) ภายใต้แกนประมวลผลเดี่ยว (Single Unified Engine)

### 🛡️ จุดเด่นด้านสถาปัตยกรรม (Key Architectural Pillars - v3.1)

1. **Fixed-Point Scaled Integer & `i128` Intermediate Math**:
   - ป้องกันปัญหา Floating-Point Drift และ Integer Overflow โดยจัดเก็บสต็อกในหน่วยมิลลิยูนิต ($\text{Milli-Units}, \times 10^3$), ยอดเงินในหน่วยสตางค์ ($\text{Satang}, \times 10^2$), และต้นทุนในหน่วยไมโครบาท ($\text{Micro-Baht}, \times 10^6$)
   - คำนวณระหว่างทางด้วย `i128` แบบ Round-Half-Away-From-Zero บนค่าสัมบูรณ์
2. **External Keystore Manifest (`keystore.manifest.json`)**:
   - แยกส่วนหัวกุญแจเข้ารหัส SQLCipher ออกจากฐานข้อมูลเพื่อขจัด Bootstrap Paradox
   - รองรับ **Windows DPAPI + TPM 2.0** สำหรับเปิดเครื่องกะเช้าอัตโนมัติ (Unattended Boot) และ **Argon2id Recovery Kit** สำหรับกู้คืนข้ามเครื่อง
3. **Thai Hardware Real-World Edge-Case Immunity**:
   - **Scanner HAL**: ดักจับระดับ USB Raw Input (`WM_INPUT`) และ `KeyboardEvent.code` แก้ปัญหาแป้นพิมพ์ Windows ค้างที่ภาษาไทย พร้อมระบบ **First-Char Rollback**
   - **Scale Barcode Parser**: รองรับบาร์โค้ดตราชั่ง EAN-13 ทั้งแบบฝังน้ำหนัก (Prefix `20`–`24`) และฝังราคารวม (Prefix `25`–`29`)
   - **Printer HAL**: พิมพ์ภาษาไทยโหมดบิตแมป 203-DPI แบบหั่นแถบ (**Chunked `GS v 0`** แถบละ 64–128 dots) ป้องกันบัฟเฟอร์เครื่องพิมพ์ล้น
   - **Payment HAL**: ตรวจสอบโครงสร้าง TLV ของสลิป **BOT Mini-QR** ออฟไลน์ ป้องกันสลิปซ้ำ และมีหน้าต่างยืนยันโลโก้ธนาคารและยอดเงิน
4. **Local LAN Cluster & Epoch Fencing**:
   - ค้นหาเครื่องแม่ข่ายอัตโนมัติด้วย mDNS (`_rube-pos._tcp.local.`) และเข้ารหัส mTLS
   - ซิงค์เครื่องสำรองด้วยสตรีมธุรกรรมเชิงตรรกะ (`global_tx_seq`) และกั้น Split-Brain ด้วย `cluster_epoch`
5. **Complete Shift Management & Thai VAT (ABB)**:
   - ตาราง `pos_shifts` และ `cash_drawer_movements` ควบคุมเงินสดในลิ้นชักแม่นยำ
   - รองรับใบกำกับภาษีอย่างย่อ (ABB) พร้อมสูตรถอด VAT 7% สตางค์ตรงเป๊ะ

---

## 📂 โครงสร้าง Monorepo (Monorepo Directory Structure)

```text
rube-stock-pos/
├── Cargo.toml                                                # Rust Workspace (Tauri v2 + Core Crates)
├── package.json                                              # Monorepo Workspace configuration
├── tsconfig.base.json                                        # TypeScript Base Config
├── Changelog.md                                              # บันทึกประวัติการพัฒนาและอัปเกรดทั้งหมด
├── rube_stock_pos_complete_architecture_specification (1).md # Blueprint สถาปัตยกรรมฉบับสมบูรณ์ (v3.1)
├── rube_stock_pos_team_implementation_assembly_playbook.md   # คู่มือแบ่งงานและขั้นตอนประกอบร่าง
│
├── packages/
│   ├── shared-contracts/      # [ทุกทีมใช้ร่วมกัน] Fixed-Point Math, Types, DTOs, Mock Catalog
│   ├── core-engine/           # [Squad A] 34-Table SQLite DDL, SQLCipher Pool, i128 MAC, BOM DAG
│   ├── hal-drivers/           # [Squad B] Scanner, Chunked Raster Printer, PromptPay, Virtual Bench
│   ├── cluster-gateway/       # [Squad D] Zero-Port IPC, mDNS, mTLS CA, KDS Sync, Epoch Replicator
│   └── ui-presentation/       # [Squad C] React 19 Frontend, Profiles, usePhysicalScanner Hook
│
├── scripts/
│   └── verify-schema-checksum.mjs  # ตรวจสอบความถูกต้องและสร้าง SHA-256 ของ Schema
│
└── tests/
    ├── property-invariants/   # Automated Invariants Test Suite (Ledger, MAC, Landed Cost, BOM DAG)
    └── e2e-integration/       # Phase 0 & Phase 1 Integration Assembly Checkpoint Tests
```

---

## 🧪 การทดสอบระบบอัตโนมัติ (Automated Testing)

รันคำสั่งตรวจสอบความถูกต้องของโครงสร้างฐานข้อมูลและชุดทดสอบทางบัญชี/ฮาร์ดแวร์:

```bash
# ตรวจสอบ SHA-256 Checksum ของ Schema (34 ตาราง + 3 Triggers)
npm run verify:schema

# รันชุดทดสอบเฉพาะเฟสที่ 1 (SQLite WAL Split Pool + Landed Cost + Multi-Level BOM + Scale Barcode)
npm run test:phase1

# รันชุดทดสอบทั้งหมด (Phase 0 + Phase 1 + Accounting Invariants)
npm test
```

ผลการทดสอบ: **13/13 Tests ผ่านครบ 100%**

---

## 📚 เอกสารอ้างอิงหลัก (Core Specifications)

- [ARCHITECTURE.md](rube_stock_pos_complete_architecture_specification%20(1).md) - สถาปัตยกรรมระบบโดยละเอียด (v3.1)
- [IMPLEMENTATION_PLAYBOOK.md](rube_stock_pos_team_implementation_assembly_playbook.md) - แผนผังทีมงานและตาราง Master WBS 16 สัปดาห์
- [Changelog.md](Changelog.md) - รายการอัปเกรดและประวัติการเปลี่ยนแปลง

