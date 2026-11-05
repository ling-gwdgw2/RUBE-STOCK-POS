/**
 * RUBE-STOCK-POS v3.1 Phase 5 Production Release Assembly Test Suite
 * (`WBS-15` & Production Release Checklist — Weeks 14–16)
 *
 * Verifies:
 * 1. `MIGRATE_SVC`: 5-Step FK-Safe Air-Gapped Database Schema Upgrade with Pre-Upgrade Cold Snapshot
 *    and Automatic Rollback when a migration fails `PRAGMA foreign_key_check` or DDL validation.
 * 2. `BACKUP_SVC`: Automatic Encrypted USB Backup on Shift Close, Orphaned `.part` File Recovery
 *    when a USB Flash Drive is yanked mid-write, and 14-Shift Ring Buffer rotation.
 * 3. `UPS_HAL` & `REPORT_VIEW`: UPS Power-Loss (`AC_PRESENT = 0`) immediate `PRAGMA wal_checkpoint(TRUNCATE);`
 *    with On-Screen Thai Alert Banner, plus all 4 Financial & Accounting Reports:
 *    - End-of-Shift Z-Report
 *    - Simplified Tax Invoice (ABB) Sales Tax Report
 *    - Warehouse Stock Valuation Report
 *    - Menu COGS & Gross Margin Report
 * 4. `RELEASE_PIPELINE`: Air-Gapped Windows 11 `.msi` / `.exe` Installer Packaging, Hardware Token
 *    EV Code Signing (`Authenticode SHA-256`), and Offline UAT Tamper Rejection.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../packages/core-engine/src/index.ts';
import { UpsPowerHidMonitor } from '../../packages/hal-drivers/src/index.ts';
import {
  AirGappedReleasePackager,
  LocalIpcBridge,
} from '../../packages/cluster-gateway/src/index.ts';
import { FinancialAndBackupReportViewController } from '../../packages/ui-presentation/src/index.ts';

describe('Phase 5: 5-Step FK-Safe Schema Upgrade, Auto USB Backup, UPS Banner, Financial Reports & EV Signed MSI Release', () => {
  it('1. executes 5-Step FK-Safe Air-Gapped Schema Upgrade with pre-upgrade snapshot and auto-rolls back on FK violation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-phase5-migrate-'));
    const dbPath = join(tempDir, 'rube_pos_migrate.db');
    const snapshotDir = join(tempDir, 'snapshots');

    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);
    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const reportAndAdminView = new FinancialAndBackupReportViewController(ipc);

      // Step 1: Apply valid v2 schema migration (`0002_customer_loyalty_wallets.sql`)
      const v2Sql = `
        PRAGMA foreign_keys = OFF;
        CREATE TABLE customer_loyalty_wallets (
          id TEXT PRIMARY KEY,
          outlet_id TEXT NOT NULL REFERENCES outlets(id),
          member_phone TEXT NOT NULL UNIQUE,
          points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0)
        );
        INSERT INTO customer_loyalty_wallets (id, outlet_id, member_phone, points_balance)
        VALUES ('WAL-001', 'OUTLET-HQ', '0812345678', 250);
      `;

      const v2Res = await reportAndAdminView.applyAirGappedSchemaUpgrade({
        version: 2,
        name: '0002_customer_loyalty_wallets.sql',
        sqlDdl: v2Sql,
        snapshotDir,
      });

      assert.equal(v2Res.applied, true);
      assert.equal(v2Res.autoRolledBack, false);
      assert.equal(v2Res.foreignKeysEnabledAfter, true);
      assert.ok(v2Res.snapshotPath && existsSync(v2Res.snapshotPath));

      // Step 2: Simulate a broken v3 migration that inserts an orphan FK reference
      const v3BrokenFkSql = `
        INSERT INTO customer_loyalty_wallets (id, outlet_id, member_phone, points_balance)
        VALUES ('WAL-ORPHAN', 'OUTLET-NON-EXISTENT-999', '0899999999', 100);
      `;

      const v3Res = await reportAndAdminView.applyAirGappedSchemaUpgrade({
        version: 3,
        name: '0003_broken_fk_upgrade.sql',
        sqlDdl: v3BrokenFkSql,
        snapshotDir,
      });

      assert.equal(v3Res.applied, false);
      assert.equal(v3Res.autoRolledBack, true);
      assert.equal(v3Res.foreignKeysEnabledAfter, true);
      assert.match(v3Res.errorMessage ?? '', /Foreign key check failed/);

      // Verify v2 data is 100% intact and v3 orphan was rolled back
      const walletCount = engine.executeRead((db) => {
        const row = db
          .prepare(`SELECT COUNT(*) AS cnt FROM customer_loyalty_wallets`)
          .get() as { cnt: number };
        return Number(row.cnt);
      });
      assert.equal(walletCount, 1);
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. recovers cleanly from yanked USB Flash Drive (.part file) and auto-rotates 14-Shift Ring Buffer on Shift Close', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-phase5-usb-'));
    const dbPath = join(tempDir, 'rube_pos_usb.db');
    const usbDir = join(tempDir, 'usb_drive');

    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);
    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const reportAndAdminView = new FinancialAndBackupReportViewController(ipc);

      // Simulate a previously yanked USB Flash Drive that left an incomplete `.part` file behind
      writeFileSync(
        join(tempDir, 'dummy_init.txt'),
        'init'
      );
      await ipc.exportEncryptedUsbBackupWithRingBuffer(usbDir, 'SHF-2026-0001');
      const corruptPartPath = join(usbDir, 'rube_backup_SHF-2026-INTERRUPTED.db.enc.part');
      writeFileSync(corruptPartPath, 'PARTIAL_CORRUPT_BYTES_FROM_YANKED_USB');
      assert.equal(existsSync(corruptPartPath), true);

      // Open and close Shift #2 via `closeShiftWithAutoUsbBackup`
      const shift2 = await ipc.openPosShift({
        shiftNumber: 'SHF-2026-0002',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 50_000,
      });

      const closeRes = await reportAndAdminView.closeShiftWithAutoUsbBackup({
        shiftId: shift2.id,
        closedByUserId: 'USR-CASHIER-01',
        countedCashSatang: 50_000,
        usbBackupDir: usbDir,
      });

      // Orphaned `.part` file must be cleaned up automatically and never counted as a valid backup
      assert.equal(closeRes.usbBackup.cleanedOrphanedPartFilesCount, 1);
      assert.equal(existsSync(corruptPartPath), false);
      assert.equal(closeRes.usbBackup.retainedBackupsCount, 2);

      // Write shifts 3 through 15 and verify 14-Shift Ring Buffer evicts only SHF-2026-0001
      let lastBackup = closeRes.usbBackup;
      for (let i = 3; i <= 15; i++) {
        const shiftNum = `SHF-2026-${String(i).padStart(4, '0')}`;
        lastBackup = await ipc.exportEncryptedUsbBackupWithRingBuffer(usbDir, shiftNum);
      }

      assert.equal(lastBackup.retainedBackupsCount, 14);
      const remainingFiles = readdirSync(usbDir).sort();
      assert.equal(remainingFiles.includes('rube_backup_SHF-2026-0001.db.enc'), false);
      assert.equal(remainingFiles.includes('rube_backup_SHF-2026-0002.db.enc'), true);
      assert.equal(remainingFiles.includes('rube_backup_SHF-2026-0015.db.enc'), true);
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. triggers UPS Power-Loss Checkpoint + UI Alert Banner and generates accurate Z-Report, ABB Tax Report, Stock Valuation & Menu Margin Reports', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-phase5-reports-'));
    const dbPath = join(tempDir, 'rube_pos_reports.db');
    const usbDir = join(tempDir, 'usb_reports');

    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);
    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const reportView = new FinancialAndBackupReportViewController(ipc);

      // Connect UPS USB-HID Monitor
      const upsMonitor = new UpsPowerHidMonitor({
        onTriggerEmergencyWalCheckpoint: async () => {
          await ipc.triggerEmergencyUpsWalCheckpoint('POS-TERM-01');
        },
      });
      assert.equal(upsMonitor.getActiveUiAlertBanner().visible, false);

      // Open Shift with 1,000.00 THB (100,000 Satang)
      const shift = await ipc.openPosShift({
        shiftNumber: 'SHF-REP-001',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 100_000,
      });

      // Record Paid-In (+200.00 THB) and Paid-Out (-50.00 THB)
      await ipc.recordCashDrawerMovement({
        shiftId: shift.id,
        movementType: 'PAID_IN',
        amountSatang: 20_000,
        reason: 'เติมเหรียญย่อย',
        performedByUserId: 'USR-CASHIER-01',
      });
      await ipc.recordCashDrawerMovement({
        shiftId: shift.id,
        movementType: 'PAID_OUT',
        amountSatang: 5_000,
        reason: 'ซื้อน้ำแข็งหลอดฉุกเฉิน',
        performedByUserId: 'USR-CASHIER-01',
      });

      // Order 1: Cash Sale of 2 bottles Crystal Water (2 x 7.00 THB = 14.00 THB = 1,400 Satang)
      const order1 = await ipc.checkoutSalesOrder({
        idempotencyKey: 'IDEM-P5-ORD-001',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        shiftId: shift.id,
        cashierId: 'USR-CASHIER-01',
        orderType: 'RETAIL',
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        paymentMethod: 'CASH',
        cashTenderedSatang: 2_000,
        lines: [
          {
            variantId: 'VAR-RET-001',
            quantityMilli: 2_000,
            unitPriceSatang: 700,
            selectedModifierIds: [],
          },
        ],
      });

      // Order 2: PromptPay QR Sale of 2 cups Taiwan Milk Tea with Extra Boba (2 x (65 + 15) = 160.00 THB = 16,000 Satang)
      await ipc.checkoutSalesOrder({
        idempotencyKey: 'IDEM-P5-ORD-002',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        shiftId: shift.id,
        cashierId: 'USR-CASHIER-01',
        orderType: 'DINE_IN',
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        paymentMethod: 'PROMPTPAY_QR',
        slipTransRefRaw: '004100060000010103014022020261106KBNKP5QR00002',
        lines: [
          {
            variantId: 'VAR-CAFE-MILKTEA',
            quantityMilli: 2_000,
            unitPriceSatang: 6_500,
            selectedModifierIds: ['MOD-SWEET-50', 'MOD-EXTRA-BOBA'],
          },
        ],
      });

      // Order 3: Cash Sale that gets Voided (1 bottle Crystal Water = 700 Satang)
      const order3 = await ipc.checkoutSalesOrder({
        idempotencyKey: 'IDEM-P5-ORD-003',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        shiftId: shift.id,
        cashierId: 'USR-CASHIER-01',
        orderType: 'RETAIL',
        taxMode: 'INCLUSIVE',
        discountSatang: 0,
        paymentMethod: 'CASH',
        cashTenderedSatang: 700,
        lines: [
          {
            variantId: 'VAR-RET-001',
            quantityMilli: 1_000,
            unitPriceSatang: 700,
            selectedModifierIds: [],
          },
        ],
      });
      await ipc.voidSalesOrder({
        salesOrderId: order3.salesOrderId,
        voidedByUserId: 'USR-OWNER-01',
        voidReason: 'ลูกค้าเปลี่ยนใจ',
      });

      // Simulate UPS Power Outage (`acPresent: false`, 65% battery)
      await upsMonitor.handleHidPowerReport({
        acPresent: false,
        batteryChargePercent: 65,
        estimatedRuntimeSeconds: 900,
      });
      const banner = upsMonitor.getActiveUiAlertBanner();
      assert.equal(banner.visible, true);
      assert.equal(banner.severity, 'WARNING_ON_BATTERY');
      assert.equal(banner.walCheckpointFlushed, true);
      assert.match(banner.headlineThai, /แจ้งเตือนไฟดับ/);

      // Close Shift with Auto USB Backup & verify Z-Report
      // Expected cash = 100,000 (open) + 20,000 (paid in) - 5,000 (paid out) + 1,400 (order1 cash) = 116,400 Satang
      const closedBundle = await reportView.closeShiftWithAutoUsbBackup({
        shiftId: shift.id,
        closedByUserId: 'USR-CASHIER-01',
        countedCashSatang: 116_400,
        usbBackupDir: usbDir,
      });

      assert.equal(closedBundle.closedShift.cashVarianceSatang, 0);
      assert.equal(closedBundle.zReport.openingCashSatang, 100_000);
      assert.equal(closedBundle.zReport.cashSalesSatang, 1_400);
      assert.equal(closedBundle.zReport.promptPayQrSalesSatang, 16_000);
      assert.equal(closedBundle.zReport.paidInSatang, 20_000);
      assert.equal(closedBundle.zReport.paidOutSatang, 5_000);
      assert.equal(closedBundle.zReport.completedOrdersCount, 2);
      assert.equal(closedBundle.zReport.voidedOrdersCount, 1);
      assert.equal(closedBundle.zReport.voidedTotalSatang, 700);
      assert.equal(closedBundle.zReport.netSalesTotalSatang, 17_400);

      // Verify ABB Sales Tax Report
      const abbReport = reportView.getAbbSalesTaxReportView('OUTLET-HQ');
      assert.equal(abbReport.activeInvoiceCount, 2);
      assert.equal(abbReport.voidedInvoiceCount, 1);
      assert.equal(abbReport.totalGrossAmountSatang, 17_400);
      assert.equal(
        abbReport.totalNetBeforeTaxSatang + abbReport.totalVatSatang,
        abbReport.totalGrossAmountSatang
      );
      assert.ok(abbReport.invoices.some((inv) => inv.abbTaxInvoiceNo === order1.abbTaxInvoiceNo));

      // Verify Warehouse Stock Valuation Report
      const valuationReport = reportView.getInventoryValuationReportView('OUTLET-HQ');
      assert.ok(valuationReport.totalWarehouseValuationSatang > 0);
      const waterValuation = valuationReport.lines.find((l) => l.variantId === 'VAR-RET-001')!;
      // 120,000 milli initial - 2,000 milli net sold = 118,000 milli (118 bottles * 4.25 THB = 501.50 THB = 50,150 Satang)
      assert.equal(waterValuation.inStockMilli, 118_000);
      assert.equal(waterValuation.totalValuationSatang, 50_150);

      // Verify Menu COGS & Gross Margin Report
      const marginReport = reportView.getMenuCogsAndMarginReportView('OUTLET-HQ');
      assert.equal(marginReport.totalRevenueSatang, 17_400);
      assert.ok(marginReport.totalCogsSatang > 0);
      assert.equal(
        marginReport.totalGrossProfitSatang,
        marginReport.totalRevenueSatang - marginReport.totalCogsSatang
      );
      assert.equal(marginReport.lines.length, 2);
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. signs Air-Gapped Windows 11 .msi installer with EV Hardware Token and blocks tampered binaries offline', () => {
    const schemaChecksum = '866a600d3e5eaf0351712c2e7d3085dc6abd68f39f800a1dc7d7ada1895b8d37';
    const evTokenKey = 'HSM-EV-TOKEN-SECRET-RUBE-POS-2026-PROD';
    const evCertThumbprint = 'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';
    const msiPayload = Buffer.from(
      'MSI_INSTALLER_BINARY_V3_1_0_WEBVIEW2_131_SQLCIPHER_4_6_1_AIRGAPPED',
      'utf8'
    );

    const manifest = AirGappedReleasePackager.buildEvSignedInstallerManifest({
      appVersion: '3.1.0',
      installerFormat: 'MSI',
      installerBinaryPayload: msiPayload,
      schemaMigrationChecksumSha256: schemaChecksum,
      evHardwareTokenSecretKey: evTokenKey,
      evCertThumbprintSha256: evCertThumbprint,
    });

    assert.equal(manifest.installerFilename, 'RubeStockPOS_3.1.0_x64_AirGapped.msi');
    assert.equal(manifest.offlineAirGappedReady, true);

    // Offline verification on a clean Windows 11 terminal succeeds
    const verified = AirGappedReleasePackager.verifyAirGappedInstallerPackage({
      manifest,
      installerBinaryPayload: msiPayload,
      evHardwareTokenVerifyKey: evTokenKey,
      expectedEvCertThumbprintSha256: evCertThumbprint,
      expectedSchemaChecksumSha256: schemaChecksum,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.smartScreenReputationTrusted, true);

    // Tampered .msi binary must be blocked immediately
    const tamperedMsi = Buffer.from(
      'MSI_INSTALLER_BINARY_V3_1_0_MALICIOUS_MODIFICATION',
      'utf8'
    );
    assert.throws(
      () =>
        AirGappedReleasePackager.verifyAirGappedInstallerPackage({
          manifest,
          installerBinaryPayload: tamperedMsi,
          evHardwareTokenVerifyKey: evTokenKey,
          expectedEvCertThumbprintSha256: evCertThumbprint,
          expectedSchemaChecksumSha256: schemaChecksum,
        }),
      /INSTALLER_VERIFY_FAILED: Binary payload SHA-256 hash mismatch/
    );
  });
});

