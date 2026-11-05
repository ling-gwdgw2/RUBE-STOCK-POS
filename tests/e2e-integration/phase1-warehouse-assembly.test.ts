/**
 * RUBE-STOCK-POS v3.1 Phase 1 End-to-End Warehouse & Costing Assembly Suite
 *
 * Tests all 4 Squads working together against a real file-backed SQLite WAL database:
 * - Squad A: `SqliteReadWritePoolEngine` (`1 Writer BEGIN IMMEDIATE` + `4 Readers query_only = ON`),
 *   34 tables + 3 immutable triggers, `COSTING_MAC`, and `BOM_DAG`
 * - Squad B: `SCANNER_HAL` (`computeEan13CheckDigit`, `verifyEan13CheckDigit`, `parseScaleBarcodeEan13`)
 * - Squad C: `InventoryViewController`, `PurchaseOrderViewController`, `BomEditorViewController`
 * - Squad D: `LocalIpcBridge` + End-to-End Ledger Conservation Verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../packages/core-engine/src/runtime/sqlite-engine.ts';
import { LocalIpcBridge } from '../../packages/cluster-gateway/src/local-ipc-bridge.ts';
import {
  InventoryViewController,
  PurchaseOrderViewController,
  BomEditorViewController,
} from '../../packages/ui-presentation/src/index.ts';
import {
  computeEan13CheckDigit,
  verifyEan13CheckDigit,
} from '../../packages/hal-drivers/src/scanner/mod.ts';

function createTempSqliteDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rube-pos-${prefix}-`));
  return path.join(dir, 'warehouse_phase1.db');
}

test('Phase 1 Assembly: Read/Write Split Pool (1 Writer + 4 Readers), WAL Mode, query_only Guard & Immutable Triggers', async () => {
  const dbPath = createTempSqliteDbPath('pool');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');

    // Verify Reader connections strictly enforce PRAGMA query_only = ON
    assert.throws(
      () => {
        engine.executeRead((readerDb) => {
          readerDb.exec("UPDATE outlets SET name = 'HACKED' WHERE id = 'OUTLET-HQ';");
        });
      },
      /attempt to write a readonly database/i,
      'Reader connection must reject any SQL mutation due to PRAGMA query_only = ON'
    );

    // Verify Immutable Triggers block UPDATE and DELETE on inventory_transactions even on Writer
    await assert.rejects(
      async () => {
        await engine.executeWriteImmediate((writerDb) => {
          writerDb.exec('UPDATE inventory_transactions SET quantity_change_milli = 999999;');
        });
      },
      /Immutable Ledger Violation/,
      'trg_prevent_inv_tx_update must block direct UPDATE on inventory_transactions'
    );

    await assert.rejects(
      async () => {
        await engine.executeWriteImmediate((writerDb) => {
          writerDb.exec('DELETE FROM inventory_transactions;');
        });
      },
      /Immutable Ledger Violation/,
      'trg_prevent_inv_tx_delete must block direct DELETE on inventory_transactions'
    );

    // Verify concurrent interleaved writes (BEGIN IMMEDIATE) and round-robin reads across all 4 readers
    const initialCatalog = engine.listInventoryCatalog('OUTLET-HQ');
    const initialWater = initialCatalog.find((v) => v.id === 'VAR-RET-001')!;
    assert.equal(initialWater.inStockMilli, 120_000);

    for (let i = 0; i < 20; i++) {
      await engine.recordStockDelta({
        outletId: 'OUTLET-HQ',
        variantId: 'VAR-RET-001',
        transactionType: 'ADJUSTMENT',
        quantityDeltaMilli: 1_000,
        referenceType: 'STOCK_ADJUST',
        referenceId: `ADJ-${i}`,
        performedByUserId: 'USR-WH-01',
      });

      const catalog = engine.listInventoryCatalog('OUTLET-HQ');
      const waterRow = catalog.find((r) => r.id === 'VAR-RET-001');
      assert.ok(waterRow);
      assert.equal(waterRow.inStockMilli, 120_000 + (i + 1) * 1_000);
    }

    const conservation = engine.verifyLedgerConservationInvariant('OUTLET-HQ');
    assert.equal(conservation.valid, true);
    assert.equal(conservation.mismatches.length, 0);
  } finally {
    engine.close();
  }
});

test('Phase 1 Assembly: Squad A + C + D Purchase Order Landed Cost Apportionment & Negative Stock Guard', async () => {
  const dbPath = createTempSqliteDbPath('costing');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');

    const ipcBridge = new LocalIpcBridge(engine);
    const invView = new InventoryViewController(ipcBridge, 'OUTLET-HQ');
    const poView = new PurchaseOrderViewController(ipcBridge);

    // 1. Force VAR-RET-001 (120,000 Milli in stock) into Negative Stock (-5,000 Milli = -5 bottles)
    const negAdjust = await invView.adjustStock({
      variantId: 'VAR-RET-001',
      transactionType: 'SALE_DIRECT',
      quantityDeltaMilli: -125_000,
      referenceType: 'OFFLINE_BURST_SALE',
      referenceId: 'SALE-NEG-001',
      performedByUserId: 'USR-CASHIER-01',
    });
    assert.equal(negAdjust.stockAfterMilli, -5_000);

    // 2. Preview PO Receipt with Landed Costs across VAR-RET-001 (recovering from -5,000 Milli),
    // VAR-RAW-TEA (+2,000,000 Milli), and VAR-RAW-SYRUP (+5,000,000 Milli)
    const poInput = {
      poNumber: 'PO-2026-0001',
      outletId: 'OUTLET-HQ',
      supplierId: 'SUP-001',
      createdByUserId: 'USR-WH-01',
      items: [
        {
          variantId: 'VAR-RET-001',
          orderedQtyMilli: 50_000,
          receivedQtyMilli: 50_000, // +50 bottles -> new stock +45 bottles (45,000 Milli)
          baseUnitCostMicroBaht: 4_500_000, // 4.5000 THB/bottle
        },
        {
          variantId: 'VAR-RAW-TEA',
          orderedQtyMilli: 2_000_000,
          receivedQtyMilli: 2_000_000, // +2,000 g
          baseUnitCostMicroBaht: 500_000, // 0.5000 THB/g
        },
        {
          variantId: 'VAR-RAW-SYRUP',
          orderedQtyMilli: 5_000_000,
          receivedQtyMilli: 5_000_000, // +5,000 mL
          baseUnitCostMicroBaht: 90_000, // 0.0900 THB/mL
        },
      ],
      landedCosts: [
        {
          costType: 'FREIGHT' as const,
          description: 'ค่าขนส่งห้องเย็น',
          amountSatang: 10_000, // 100.00 THB
        },
        {
          costType: 'HANDLING' as const,
          description: 'ค่าน้ำแข็งแห้งและแพ็คกิ้ง',
          amountSatang: 5_000, // 50.00 THB
        },
      ],
    };

    const previewLines = poView.previewLandedCostReceipt(poInput);
    assert.equal(previewLines.length, 3);
    const waterPreview = previewLines.find((p) => p.variantId === 'VAR-RET-001')!;
    assert.equal(
      waterPreview.triggeredNegativeStockGuard,
      true,
      'VAR-RET-001 must trigger Negative Stock Guard because stockBeforeMilli = -5,000'
    );
    assert.equal(
      waterPreview.macAfterMicroBaht,
      waterPreview.effectiveUnitCostMicroBaht,
      'When recovering from negative stock, MAC must reset cleanly to the new batch Effective Landed Unit Cost'
    );

    // 3. Confirm PO Receipt and verify 100% Landed Cost Micro-Baht conservation
    const poResult = await poView.confirmPurchaseOrderReceipt(poInput);
    assert.equal(poResult.totalLandedCostSatang, 15_000);
    assert.equal(
      poResult.totalAllocatedLandedMicroBaht,
      150_000_000n,
      'Largest Remainder Method must allocate 100% of 15,000 Satang (150,000,000 Micro-Baht) with zero rounding leak'
    );

    const conservation = ipcBridge.verifyLedgerConservationInvariant('OUTLET-HQ');
    assert.equal(conservation.valid, true);
  } finally {
    engine.close();
  }
});

test('Phase 1 Assembly: Multi-Level BOM DAG, Circular Dependency Block, Pre-Built Boba Build, Role-Based Modifiers & Scale Barcodes', async () => {
  const dbPath = createTempSqliteDbPath('bom');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');

    const ipcBridge = new LocalIpcBridge(engine);
    const bomView = new BomEditorViewController(ipcBridge, 'OUTLET-HQ');
    const invView = new InventoryViewController(ipcBridge, 'OUTLET-HQ');

    // 1. Attempt to create a 3-node Circular BOM: VAR-RAW-DRY-BOBA -> VAR-CAFE-MILKTEA
    // (since VAR-CAFE-MILKTEA -> VAR-RAW-BOBA -> VAR-RAW-DRY-BOBA already exists in SEED_BOM_EDGES)
    await assert.rejects(
      async () => {
        await bomView.upsertRecipeIngredient({
          compositeVariantId: 'VAR-RAW-DRY-BOBA',
          componentVariantId: 'VAR-CAFE-MILKTEA',
          componentRole: 'STANDARD',
          quantityMilli: 1_000,
          wastageBasisPoints: 0,
        });
      },
      /HTTP 422 Circular BOM Dependency detected/,
      'Circular BOM must be blocked by DFS cycle detector before writing to SQLite'
    );

    // 2. Execute Prep Kitchen Batch Build (`PRODUCTION_BUILD`) for 1,000g (`1,000,000 Milli`) of `VAR-RAW-BOBA`
    // In SEED_BOM_EDGES: VAR-RAW-BOBA uses 600 Milli of VAR-RAW-DRY-BOBA per 1,000 Milli with 500 bps (5%) wastage
    const buildRes = await bomView.runPrepBatchBuild({
      compositeVariantId: 'VAR-RAW-BOBA',
      buildQtyMilli: 1_000_000,
      performedByUserId: 'USR-WH-01',
    });
    assert.equal(buildRes.builtQtyMilli, 1_000_000);
    assert.equal(buildRes.newCompositeStockMilli, 3_000_000); // 2,000,000 initial + 1,000,000 built
    assert.equal(buildRes.consumedComponents.length, 1);
    assert.equal(buildRes.consumedComponents[0]!.componentVariantId, 'VAR-RAW-DRY-BOBA');
    assert.equal(buildRes.consumedComponents[0]!.consumedQtyMilli, 630_000); // 600,000 * 1.05 = 630,000 Milli

    // 3. Preview 1 cup (`1,000 Milli`) of `VAR-CAFE-MILKTEA` with Role-Based Modifier `MOD-SWEET-50` ("หวานน้อย 50%")
    // Verify:
    // - VAR-RAW-BOBA (`useProduction = true`) stops at Level 1 (`40,000 Milli`) and does NOT deduct `VAR-RAW-DRY-BOBA` again!
    // - VAR-RAW-SYRUP (`SWEETENER`) is scaled to 50% (`-15,000 Milli` instead of `-30,000 Milli`)
    // - VAR-RAW-TEA (`TEA_BASE`) stays at 100% (`18,000 * 1.02 = -18,360 Milli`)
    const recipePreview = bomView.previewRecipeDeductionsAndCogs('VAR-CAFE-MILKTEA', 1_000, [
      'MOD-SWEET-50',
    ]);
    const byVariant = new Map(recipePreview.deductions.map((d) => [d.variantId, d]));

    assert.equal(
      byVariant.has('VAR-RAW-DRY-BOBA'),
      false,
      'Pre-built Stopping Rule must prevent exploding VAR-RAW-BOBA into VAR-RAW-DRY-BOBA at sale time'
    );
    assert.equal(byVariant.get('VAR-RAW-BOBA')?.quantityChangeMilli, -40_000);
    assert.equal(byVariant.get('VAR-RAW-SYRUP')?.quantityChangeMilli, -15_000);
    assert.equal(byVariant.get('VAR-RAW-TEA')?.quantityChangeMilli, -18_360);

    // 4. Verify Scale Barcodes (Prefix 20 Weight-Embedded & Prefix 25 Price-Embedded) via InventoryViewController
    // SKU `10045` is `VAR-RET-002` ('สันคอหมูสไลซ์สด (ชั่งน้ำหนัก)', 180.00 THB/kg = 18,000 Satang/kg)
    const weightPrefix12 = '201004501250'; // Prefix 20, SKU 10045, Weight 01250 (1.250 kg)
    const weightCheckDigit = computeEan13CheckDigit(weightPrefix12);
    const weightBarcode13 = `${weightPrefix12}${weightCheckDigit}`;
    assert.equal(verifyEan13CheckDigit(weightBarcode13), true);

    const scannedWeight = invView.resolveScannedKeyCodes(
      weightBarcode13.split('').map((d) => `Digit${d}`)
    );
    assert.equal(scannedWeight.scaleInfo.isScaleBarcode, true);
    assert.equal(scannedWeight.scaleInfo.mode, 'WEIGHT_EMBEDDED');
    assert.equal(scannedWeight.scaleInfo.checkDigitValid, true);
    assert.equal(scannedWeight.matchedItem?.id, 'VAR-RET-002');
    assert.equal(scannedWeight.effectiveQtyMilli, 1_250); // 1.250 kg
    assert.equal(scannedWeight.effectiveTotalPriceSatang, 22_500); // 1.250 kg * 180.00 THB/kg = 225.00 THB

    const pricePrefix12 = '251004522500'; // Prefix 25, SKU 10045, Price 22500 Satang (225.00 THB)
    const priceCheckDigit = computeEan13CheckDigit(pricePrefix12);
    const priceBarcode13 = `${pricePrefix12}${priceCheckDigit}`;
    assert.equal(verifyEan13CheckDigit(priceBarcode13), true);

    const scannedPrice = invView.resolveScannedKeyCodes(
      priceBarcode13.split('').map((d) => `Digit${d}`)
    );
    assert.equal(scannedPrice.scaleInfo.isScaleBarcode, true);
    assert.equal(scannedPrice.scaleInfo.mode, 'PRICE_EMBEDDED');
    assert.equal(scannedPrice.scaleInfo.checkDigitValid, true);
    assert.equal(scannedPrice.matchedItem?.id, 'VAR-RET-002');
    assert.equal(scannedPrice.effectiveTotalPriceSatang, 22_500); // 225.00 THB
    assert.equal(scannedPrice.effectiveQtyMilli, 1_250); // 225.00 THB / 180.00 THB/kg = 1.250 kg

    // 5. Verify Global Ledger Conservation Invariant across all 9 seeded variants in SQLite
    const conservation = ipcBridge.verifyLedgerConservationInvariant('OUTLET-HQ');
    assert.equal(conservation.valid, true);
    assert.equal(conservation.checkedVariantsCount, 9);
    assert.equal(conservation.mismatches.length, 0);
  } finally {
    engine.close();
  }
});
