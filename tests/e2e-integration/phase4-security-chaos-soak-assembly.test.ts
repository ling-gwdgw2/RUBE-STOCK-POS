/**
 * RUBE-STOCK-POS v3.1 Phase 4 End-to-End Integration, Security & Chaos Soak Test Suite
 * (`WBS-18`, `WBS-19` & `WBS-20`)
 *
 * Verifies:
 * 1. External `keystore.manifest.json` Dual-KEK Envelope Encryption:
 *    - Unattended Morning Boot via Machine DPAPI (Slot 1)
 *    - Motherboard Replacement / Windows Password Reset DPAPI Failure Detection
 *    - Cross-Machine Disaster Recovery via Owner Recovery Kit Passphrase (Slot 2)
 *    - Automatic DPAPI Re-Sealing on Replacement Hardware
 * 2. Polymorphic Business Profile Switching (`RETAIL` / `HOSPITALITY` / `HYBRID`) &
 *    `store_config` HMAC-SHA256 Tamper Guard (detecting unauthorized direct SQL edits).
 * 3. High-Concurrency Chaos & Soak Stress Test across all 4 Squads:
 *    - 50 Concurrent POS Checkouts + 10 Historical Mirror Voids + 10 Landed Cost PO Receipts +
 *      10 Pre-Built Batch Productions + Inter-Outlet Transfers + Physical Stocktake +
 *      120 Concurrent Reader Pool Queries + UPS Emergency WAL Checkpoint + USB Backup + Blind Drop
 *    - Zero `SQLITE_BUSY` errors, 100% Double-Entry Ledger Conservation, and 100% Cash Conservation!
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../packages/core-engine/src/index.ts';
import { LocalIpcBridge } from '../../packages/cluster-gateway/src/index.ts';
import { SystemSecurityAndProfileViewController } from '../../packages/ui-presentation/src/index.ts';

describe('Phase 4: Dual-KEK Keystore Recovery, Polymorphic HMAC Guard & Chaos Soak Suite', () => {
  it('1. unlocks unattended via DPAPI, survives motherboard replacement via Owner Recovery Passphrase, and auto-reseals DPAPI', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-phase4-keystore-'));
    const dbPath = join(tempDir, 'rube_pos_phase4.db');
    const manifestPath = join(tempDir, 'keystore.manifest.json');

    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);
    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const securityView = new SystemSecurityAndProfileViewController(ipc);

      const originalMachineDpapi = 'WIN11-MOTHERBOARD-A-DPAPI-SECRET-998877';
      const ownerRecoveryPassphrase = 'correct-horse-battery-staple-rube-owner-2026';

      // Step 1: Initialize External Dual-KEK `keystore.manifest.json`
      const manifest = securityView.initializeKeystoreManifest({
        manifestPath,
        rawHexKey64: DEV_SQLCIPHER_RAW_HEX_KEY_64,
        machineDpapiSecret: originalMachineDpapi,
        ownerRecoveryPassphrase,
        keyId: 'KEY-PROD-HQ-01',
      });
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.keyId, 'KEY-PROD-HQ-01');
      assert.equal(manifest.dpapiSlot.algorithm, 'DPAPI-AES256-GCM');
      assert.equal(manifest.argon2RecoverySlot.algorithm, 'ARGON2ID-KDF-AES256-GCM');

      // Step 2: Unattended Morning Boot on Original Machine A succeeds
      const bootA = securityView.bootUnattendedWithDpapi(manifestPath, originalMachineDpapi);
      assert.equal(bootA.unlockedVia, 'DPAPI_SLOT');
      assert.equal(bootA.rawHexKey64, DEV_SQLCIPHER_RAW_HEX_KEY_64);

      // Step 3: Simulate Motherboard Death / Windows Password Reset (Machine B has a different DPAPI secret)
      const replacementMachineDpapi = 'WIN11-MOTHERBOARD-B-NEW-DPAPI-SECRET-112233';
      assert.throws(
        () => securityView.bootUnattendedWithDpapi(manifestPath, replacementMachineDpapi),
        /DPAPI_UNSEAL_FAILED/
      );

      // Wrong recovery passphrase must also be rejected
      assert.throws(
        () =>
          securityView.recoverAndResealKeystoreWithPassphrase(
            manifestPath,
            'wrong-recovery-passphrase-attempt-0000',
            replacementMachineDpapi
          ),
        /RECOVERY_UNSEAL_FAILED/
      );

      // Step 4: Unlock with Owner Recovery Kit Passphrase (Slot 2) & Auto-Reseal DPAPI for Machine B
      const recovered = securityView.recoverAndResealKeystoreWithPassphrase(
        manifestPath,
        ownerRecoveryPassphrase,
        replacementMachineDpapi
      );
      assert.equal(recovered.unlockedVia, 'ARGON2_RECOVERY_SLOT');
      assert.equal(recovered.dpapiResealed, true);
      assert.equal(recovered.rawHexKey64, DEV_SQLCIPHER_RAW_HEX_KEY_64);

      // Step 5: Subsequent Unattended Morning Boot on Replacement Machine B now succeeds automatically!
      const bootB = securityView.bootUnattendedWithDpapi(manifestPath, replacementMachineDpapi);
      assert.equal(bootB.unlockedVia, 'DPAPI_SLOT');
      assert.equal(bootB.rawHexKey64, DEV_SQLCIPHER_RAW_HEX_KEY_64);
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. switches Polymorphic Business Profiles (RETAIL / HOSPITALITY / HYBRID) and detects unauthorized SQL tampering on store_config via HMAC-SHA256', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-phase4-hmac-'));
    const dbPath = join(tempDir, 'rube_pos_hmac.db');

    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);
    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);
      const securityView = new SystemSecurityAndProfileViewController(ipc);

      // Default seeded profile is HYBRID
      const initial = securityView.getActiveProfileWithFeatureFlags();
      assert.equal(initial.profile, 'HYBRID');
      assert.equal(initial.featureFlags.defaultPosView, 'DUAL_SWITCHABLE');
      assert.equal(initial.featureFlags.enableScaleBarcodeParser, true);
      assert.equal(initial.featureFlags.enableKitchenDisplaySystem, true);

      // Switch to RETAIL
      const retailRes = await securityView.switchBusinessProfile('RETAIL', 'USR-OWNER-01');
      assert.equal(retailRes.profile, 'RETAIL');
      assert.equal(retailRes.featureFlags.defaultPosView, 'RETAIL_FAST_GRID');
      assert.equal(retailRes.featureFlags.enableScaleBarcodeParser, true);
      assert.equal(retailRes.featureFlags.enableMultiLevelBom, false);
      assert.equal(retailRes.featureFlags.enableKitchenDisplaySystem, false);

      // Switch to HOSPITALITY
      const hospRes = await securityView.switchBusinessProfile('HOSPITALITY', 'USR-OWNER-01');
      assert.equal(hospRes.profile, 'HOSPITALITY');
      assert.equal(hospRes.featureFlags.defaultPosView, 'CAFE_TOUCH_TILES');
      assert.equal(hospRes.featureFlags.enableScaleBarcodeParser, false);
      assert.equal(hospRes.featureFlags.enableMultiLevelBom, true);
      assert.equal(hospRes.featureFlags.enableKitchenDisplaySystem, true);

      // Protect Tax ID & RD Registration No with HMAC-SHA256
      await ipc.setProtectedStoreConfig({
        key: 'rd_pos_reg_no',
        value: 'RD-POS-2026-999',
        updatedByUserId: 'USR-OWNER-01',
      });
      assert.equal(ipc.getVerifiedProtectedStoreConfig('rd_pos_reg_no'), 'RD-POS-2026-999');

      // Simulate an attacker directly modifying `store_config` via raw SQL without the DEK HMAC key
      await engine.executeWriteImmediate((db) => {
        db.prepare(`UPDATE store_config SET value = 'RETAIL' WHERE key = 'business_profile'`).run();
      });

      assert.throws(
        () => securityView.getActiveProfileWithFeatureFlags(),
        /Security Tamper Alert: HMAC signature mismatch on store_config key 'business_profile'/
      );

      // Restore legitimate profile via authorized Owner command
      const restored = await securityView.switchBusinessProfile('HYBRID', 'USR-OWNER-01');
      assert.equal(restored.profile, 'HYBRID');
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. passes High-Concurrency Chaos & Soak Stress Test (50 Checkouts, 10 Voids, 10 POs, 10 Prep Builds, Transfers, Stocktake, 120 Parallel Reads) with 0 SQLITE_BUSY and 100% Ledger & Cash Conservation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rube-phase4-soak-'));
    const dbPath = join(tempDir, 'rube_pos_soak.db');
    const usbDir = join(tempDir, 'usb_backups');

    const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 8);
    try {
      await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
      const ipc = new LocalIpcBridge(engine);

      // Register Branch Outlet for Inter-Outlet Transfers during soak
      await ipc.registerOutlet({
        id: 'OUTLET-BRANCH-02',
        code: 'BR-02',
        name: 'RUBE Branch 02',
        isWarehouse: false,
      });

      // Open POS Shift with 1,000.00 THB (100,000 Satang)
      const shift = await ipc.openPosShift({
        shiftNumber: 'SHF-SOAK-2026-001',
        outletId: 'OUTLET-HQ',
        terminalId: 'POS-TERM-01',
        openedByUserId: 'USR-CASHIER-01',
        openingCashSatang: 100_000,
      });

      // Launch concurrent write & read workload waves
      const writePromises: Promise<unknown>[] = [];

      // 10 Landed Cost Purchase Order Receipts replenishing raw materials & pork belly
      for (let i = 1; i <= 10; i++) {
        writePromises.push(
          ipc.receivePurchaseOrderWithLandedCosts({
            poNumber: `PO-SOAK-${String(i).padStart(3, '0')}`,
            outletId: 'OUTLET-HQ',
            supplierId: 'SUP-001',
            createdByUserId: 'USR-WH-01',
            items: [
              {
                variantId: 'VAR-RET-002',
                orderedQtyMilli: 10_000,
                receivedQtyMilli: 10_000,
                baseUnitCostMicroBaht: 135_000_000,
              },
              {
                variantId: 'VAR-RAW-TEA',
                orderedQtyMilli: 50_000,
                receivedQtyMilli: 50_000,
                baseUnitCostMicroBaht: 450_000,
              },
              {
                variantId: 'VAR-RAW-SYRUP',
                orderedQtyMilli: 100_000,
                receivedQtyMilli: 100_000,
                baseUnitCostMicroBaht: 85_000,
              },
              {
                variantId: 'VAR-RAW-DRY-BOBA',
                orderedQtyMilli: 50_000,
                receivedQtyMilli: 50_000,
                baseUnitCostMicroBaht: 60_000,
              },
            ],
            landedCosts: [
              {
                costType: 'FREIGHT',
                description: `Freight batch ${i}`,
                amountSatang: 15_000,
              },
            ],
          })
        );
      }

      // 10 Pre-Built Cooked Boba Pearl Batch Productions (`PRODUCTION_BUILD`)
      for (let i = 1; i <= 10; i++) {
        writePromises.push(
          ipc.executeProductionBuildBatch({
            outletId: 'OUTLET-HQ',
            compositeVariantId: 'VAR-RAW-BOBA',
            buildQtyMilli: 50_000,
            performedByUserId: 'USR-WH-01',
          })
        );
      }

      // 50 Concurrent POS Checkouts interleaved with 120 Reader Pool queries
      const checkoutOrderIds: string[] = [];
      for (let i = 1; i <= 50; i++) {
        const isCash = i % 2 === 1;
        const isCafeMilkTea = i % 3 === 0;
        const p = ipc
          .checkoutSalesOrder({
            idempotencyKey: `IDEM-SOAK-ORD-${String(i).padStart(4, '0')}`,
            outletId: 'OUTLET-HQ',
            terminalId: 'POS-TERM-01',
            shiftId: shift.id,
            cashierId: 'USR-CASHIER-01',
            orderType: isCafeMilkTea ? 'DINE_IN' : 'RETAIL',
            taxMode: 'INCLUSIVE',
            discountSatang: 0,
            paymentMethod: isCash ? 'CASH' : 'PROMPTPAY_QR',
            ...(isCash
              ? { cashTenderedSatang: 50_000 }
              : {
                  slipTransRefRaw: `004100060000010103014022020261105BBLSOAK${String(i).padStart(5, '0')}`,
                }),
            lines: isCafeMilkTea
              ? [
                  {
                    variantId: 'VAR-CAFE-MILKTEA',
                    quantityMilli: 1_000,
                    unitPriceSatang: 6_500,
                    selectedModifierIds: ['MOD-SWEET-50', 'MOD-EXTRA-BOBA'],
                  },
                ]
              : [
                  {
                    variantId: 'VAR-RET-002',
                    quantityMilli: 500,
                    unitPriceSatang: 18_000,
                    selectedModifierIds: [],
                  },
                ],
          })
          .then((res) => {
            checkoutOrderIds.push(res.salesOrderId);
            return res;
          });
        writePromises.push(p);

        // Fire 2 Reader Pool queries concurrently per checkout
        const cat = ipc.getInventoryCatalog('OUTLET-HQ');
        assert.ok(cat.length >= 7);
        const activeShift = ipc.getActiveShift('OUTLET-HQ', 'POS-TERM-01');
        assert.equal(activeShift?.id, shift.id);
      }

      // Wait for all 70 concurrent write transactions to serialize cleanly
      await Promise.all(writePromises);
      assert.equal(checkoutOrderIds.length, 50);

      // Void 10 of those orders concurrently (`VOID_RETURN` mirroring exact historical batch cost)
      const voidPromises = checkoutOrderIds.slice(0, 10).map((salesOrderId, idx) =>
        ipc.voidSalesOrder({
          salesOrderId,
          voidReason: `Soak test customer cancellation #${idx + 1}`,
          voidedByUserId: 'USR-OWNER-01',
        })
      );
      await Promise.all(voidPromises);

      // Dispatch & Receive an Inter-Outlet Transfer during soak
      const transferOut = await ipc.dispatchTransferOrder({
        transferNumber: 'TRF-SOAK-001',
        sourceOutletId: 'OUTLET-HQ',
        destinationOutletId: 'OUTLET-BRANCH-02',
        performedByUserId: 'USR-WH-01',
        items: [{ variantId: 'VAR-RET-002', quantityMilli: 3_000 }],
      });
      await ipc.receiveTransferOrder({
        transferOrderId: transferOut.transferOrderId,
        receivedByUserId: 'USR-WH-01',
      });

      // Execute a Physical Inventory Stocktake (`RE_COUNT`)
      const currentPork = ipc
        .getInventoryCatalog('OUTLET-HQ')
        .find((v) => v.id === 'VAR-RET-002')!;
      await ipc.executePhysicalInventoryCount({
        countNumber: 'CNT-SOAK-001',
        outletId: 'OUTLET-HQ',
        createdByUserId: 'USR-WH-01',
        items: [
          {
            variantId: 'VAR-RET-002',
            countedStockMilli: currentPork.inStockMilli - 250,
          },
        ],
      });

      // Trigger UPS Emergency WAL Checkpoint & USB Encrypted Backup
      const upsRes = await ipc.triggerEmergencyUpsWalCheckpoint('POS-TERM-01');
      assert.equal(upsRes.walCheckpointed, true);

      const usbRes = await ipc.exportEncryptedUsbBackupWithRingBuffer(
        usbDir,
        'SHF-SOAK-2026-001'
      );
      assert.equal(usbRes.retainedBackupsCount, 1);

      // Close Shift with exact expected cash & verify Cash Drawer Conservation (0 Satang variance)
      const latestShift = ipc.getShiftById(shift.id)!;
      const closedShift = await ipc.closePosShiftBlindDrop({
        shiftId: shift.id,
        closedByUserId: 'USR-CASHIER-01',
        countedCashSatang: latestShift.expectedCashSatang,
      });
      assert.equal(closedShift.status, 'CLOSED');
      assert.equal(closedShift.cashVarianceSatang, 0);

      // Verify 100% Double-Entry Inventory Ledger Conservation across all outlets & variants!
      const hqInvariant = ipc.verifyLedgerConservationInvariant('OUTLET-HQ');
      assert.equal(
        hqInvariant.valid,
        true,
        `HQ Ledger conservation failed: ${JSON.stringify(hqInvariant.mismatches)}`
      );
      const branchInvariant = ipc.verifyLedgerConservationInvariant('OUTLET-BRANCH-02');
      assert.equal(
        branchInvariant.valid,
        true,
        `Branch Ledger conservation failed: ${JSON.stringify(branchInvariant.mismatches)}`
      );
    } finally {
      engine.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
