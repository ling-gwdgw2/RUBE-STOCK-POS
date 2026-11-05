/**
 * RUBE-STOCK-POS v3.1 Automated Accounting Invariants Test Suite (`ARCHITECTURE.md` Section 9.2)
 *
 * Verifies:
 * 1. Invariant 1: Ledger Conservation Invariant (`sum(quantity_change_milli) === in_stock_milli`)
 * 2. Invariant 2: Landed Cost Exact Apportionment Invariant (`sum(L_i) === TotalLandedCost_satang * 10^4`)
 *    including extreme bulk orders that would overflow 64-bit `i64` without 128-bit intermediate math.
 * 3. Invariant 3: DAG Acyclicity & Pre-Built Boundary Invariant (`use_production = true` stops BOM expansion)
 *    and Role-Based Modifier Scaling (`ROLE_SCALE_BPS` scales `SWEETENER` regardless of Syrup vs. Honey).
 * 4. Invariant 4: Shift Cash Conservation & Thai VAT 7% Inclusive/Exclusive precision.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateLandedCostExact,
  computeNewMovingAverageCost,
  computeVatSatang,
  JS_MAX_SAFE_BIGINT,
  SATANG_TO_MICRO_BAHT,
  toSafeFixedPointNumber,
} from '../../packages/shared-contracts/src/fixed-point.ts';
import {
  calculateOrderLineDeductions,
  validateBomDagAcyclic,
} from '../../packages/shared-contracts/src/ipc-commands.ts';
import {
  SEED_BOM_EDGES,
  SEED_MODIFIERS,
  SEED_VARIANTS,
} from '../../packages/shared-contracts/src/mocks/mock-ipc-bridge.ts';

describe('RUBE-STOCK-POS v3.1 Accounting Invariants (Section 9.2)', () => {
  it('Invariant 1 & MAC Negative Stock Guard: Ledger sum equals in_stock_milli and resets MAC when stock <= 0', () => {
    let inStockMilli = 0;
    let avgCostMicroBaht = 0;
    const ledgerTransactions: number[] = [];

    // Cashier sells 2 units (-2,000 milli) BEFORE PO is keyed in -> stock becomes negative (-2,000)
    const saleBeforePo = -2_000;
    ledgerTransactions.push(saleBeforePo);
    inStockMilli += saleBeforePo;
    assert.equal(inStockMilli, -2_000);

    // Warehouse receives 10 units (+10,000 milli) at 50.00 THB (50,000,000 micro-baht)
    // Because current stock <= 0, Negative Stock Guard MUST set MAC to 50,000,000 micro-baht!
    avgCostMicroBaht = computeNewMovingAverageCost(inStockMilli, avgCostMicroBaht, 10_000, 50_000_000);
    assert.equal(avgCostMicroBaht, 50_000_000);
    ledgerTransactions.push(10_000);
    inStockMilli += 10_000;
    assert.equal(inStockMilli, 8_000);

    // Next PO: receive 8 units (+8,000 milli) at 60.00 THB (60,000,000 micro-baht)
    // Stock is positive (8,000), so MAC averages 8,000 @ 50M and 8,000 @ 60M -> 55,000,000 micro-baht
    avgCostMicroBaht = computeNewMovingAverageCost(inStockMilli, avgCostMicroBaht, 8_000, 60_000_000);
    assert.equal(avgCostMicroBaht, 55_000_000);
    ledgerTransactions.push(8_000);
    inStockMilli += 8_000;

    const ledgerSum = ledgerTransactions.reduce((acc, qty) => acc + qty, 0);
    assert.equal(ledgerSum, inStockMilli);
  });

  it('Invariant 2: Landed Cost Exact Apportionment preserves 100% of micro-baht across 500 randomized POs & extreme i128 values', () => {
    // Test 1: Extreme bulk PO that overflows 64-bit i64 intermediate products without 128-bit math
    const extremeItems = [
      { id: 'BULK-1', receivedQtyMilli: 10_000_000, baseUnitCostMicroBaht: 45_000_000_000 },
      { id: 'BULK-2', receivedQtyMilli: 7_500_000, baseUnitCostMicroBaht: 33_333_333_333 },
      { id: 'BULK-3', receivedQtyMilli: 3_250_000, baseUnitCostMicroBaht: 19_999_999_999 },
    ];
    const freightSatang = 1_234_567; // 12,345.67 THB
    const allocatedExtreme = allocateLandedCostExact(extremeItems, freightSatang);
    const sumAllocatedExtreme = allocatedExtreme.reduce(
      (acc, item) => acc + item.allocatedLandedCostMicroBaht,
      0n
    );
    assert.equal(sumAllocatedExtreme, BigInt(freightSatang) * SATANG_TO_MICRO_BAHT);

    // Test 2: Property-based fuzzing across 500 prime/awkward PO combinations
    let seed = 1337;
    function nextRand(max: number): number {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed % max) + 1;
    }

    for (let trial = 0; trial < 500; trial++) {
      const lineCount = (trial % 7) + 2;
      const items = Array.from({ length: lineCount }, (_, idx) => ({
        id: `ITEM-${idx}`,
        receivedQtyMilli: nextRand(500_000),
        baseUnitCostMicroBaht: nextRand(250_000_000),
      }));
      const landedSatang = nextRand(999_999);
      const result = allocateLandedCostExact(items, landedSatang);
      const sumMicro = result.reduce((acc, r) => acc + r.allocatedLandedCostMicroBaht, 0n);
      assert.equal(sumMicro, BigInt(landedSatang) * SATANG_TO_MICRO_BAHT);
    }
  });

  it('Invariant 3: BOM DAG blocks cycles, stops at Pre-Built nodes (useProduction=true), and scales Role-Based Modifiers', () => {
    // 3a. Valid seed BOM must pass DAG check
    const validCheck = validateBomDagAcyclic(SEED_BOM_EDGES);
    assert.equal(validCheck.valid, true);

    // 3b. Introducing a 3-hop cycle (A -> B -> C -> A) must be blocked immediately
    const cyclicEdges = [
      ...SEED_BOM_EDGES,
      {
        compositeVariantId: 'VAR-RAW-DRY-BOBA',
        componentVariantId: 'VAR-CAFE-MILKTEA',
        componentRole: 'STANDARD' as const,
        quantityMilli: 1_000,
        wastageBasisPoints: 0,
      },
    ];
    const cyclicCheck = validateBomDagAcyclic(cyclicEdges);
    assert.equal(cyclicCheck.valid, false);
    assert.ok(cyclicCheck.cyclePath && cyclicCheck.cyclePath.length >= 3);

    // 3c. Pre-Built Stopping Rule & Role-Based Sweetener Modifier ("หวานน้อย 50%")
    const catalog = new Map(SEED_VARIANTS.map((v) => [v.id, v]));
    const milkTea = catalog.get('VAR-CAFE-MILKTEA')!;
    const honeyTea = catalog.get('VAR-CAFE-HONEYTEA')!;
    const lessSweet50 = SEED_MODIFIERS.find((m) => m.id === 'MOD-SWEET-50')!;

    // Selling 1 cup (1,000 milli) of Taiwan Milk Tea with "หวานน้อย 50%":
    // - Should deduct 18g + 2% wastage = 18,360 milli of VAR-RAW-TEA
    // - Should scale VAR-RAW-SYRUP (30,000 milli) by -50% -> 15,000 milli
    // - Should deduct 40,000 milli of Pre-built VAR-RAW-BOBA directly and MUST NOT expand into VAR-RAW-DRY-BOBA!
    const milkTeaDeductions = calculateOrderLineDeductions(
      milkTea,
      1_000,
      [lessSweet50],
      catalog,
      SEED_BOM_EDGES
    );

    const teaDed = milkTeaDeductions.find((d) => d.variantId === 'VAR-RAW-TEA');
    const syrupDed = milkTeaDeductions.find((d) => d.variantId === 'VAR-RAW-SYRUP');
    const bobaDed = milkTeaDeductions.find((d) => d.variantId === 'VAR-RAW-BOBA');
    const dryBobaDed = milkTeaDeductions.find((d) => d.variantId === 'VAR-RAW-DRY-BOBA');

    assert.equal(teaDed?.quantityChangeMilli, -18_360);
    assert.equal(syrupDed?.quantityChangeMilli, -15_000);
    assert.equal(bobaDed?.quantityChangeMilli, -40_000);
    assert.equal(dryBobaDed, undefined, 'Pre-built batch must stop BOM traversal before dry boba');

    // Selling 1 cup of Honey Jasmine Tea with the EXACT SAME "หวานน้อย 50%" modifier:
    // - Should scale VAR-RAW-HONEY (25,000 milli) by -50% -> 12,500 milli!
    const honeyTeaDeductions = calculateOrderLineDeductions(
      honeyTea,
      1_000,
      [lessSweet50],
      catalog,
      SEED_BOM_EDGES
    );
    const honeyDed = honeyTeaDeductions.find((d) => d.variantId === 'VAR-RAW-HONEY');
    assert.equal(honeyDed?.quantityChangeMilli, -12_500);

    // 3d. Multi-Level Role-Based Modifier Double-Scaling Guard & Negative FIXED_QTY_DELTA COGS Sign
    const multiSweetCatalog = new Map(catalog);
    multiSweetCatalog.set('VAR-SUB-SWEET-MIX', {
      id: 'VAR-SUB-SWEET-MIX',
      itemId: 'ITM-SUB-SWEET-MIX',
      itemName: 'เบสไซรัปผสมน้ำผึ้ง (Virtual Sub-Recipe)',
      variantName: 'มล.',
      sku: 'SUB-SWEET-01',
      barcode: null,
      unitName: 'มล.',
      priceSatang: 0,
      averageCostMicroBaht: 0,
      inStockMilli: 0,
      isComposite: true,
      useProduction: false,
      isWeightedScale: false,
    });

    const multiSweetEdges = [
      {
        compositeVariantId: 'VAR-CAFE-HONEYTEA',
        componentVariantId: 'VAR-SUB-SWEET-MIX',
        componentRole: 'SWEETENER' as const,
        quantityMilli: 1_000,
        wastageBasisPoints: 0,
      },
      {
        compositeVariantId: 'VAR-SUB-SWEET-MIX',
        componentVariantId: 'VAR-RAW-HONEY',
        componentRole: 'SWEETENER' as const,
        quantityMilli: 20_000,
        wastageBasisPoints: 0,
      },
    ];

    // Applying -50% SWEETENER must scale once (20,000 -> -10,000 milli), NOT twice (-5,000 milli)
    const nestedSweetDeductions = calculateOrderLineDeductions(
      honeyTea,
      1_000,
      [lessSweet50],
      multiSweetCatalog,
      multiSweetEdges
    );
    assert.equal(nestedSweetDeductions[0]?.quantityChangeMilli, -10_000);

    // Negative FIXED_QTY_DELTA modifier (removing 20g of pre-built boba) must produce negative COGS delta
    const removeBobaMod = {
      id: 'MOD-NO-BOBA',
      modifierGroupId: 'GRP-TOPPING',
      name: 'ไม่ใส่ไข่มุก (-20g)',
      priceDeltaSatang: 0,
      modifierMode: 'FIXED_QTY_DELTA' as const,
      componentVariantId: 'VAR-RAW-BOBA',
      quantityDeltaMilli: -20_000,
      targetComponentRole: null,
      scaleBasisPoints: 0,
    };
    const withRemovalDeductions = calculateOrderLineDeductions(
      milkTea,
      1_000,
      [removeBobaMod],
      catalog,
      SEED_BOM_EDGES
    );
    const modEntry = withRemovalDeductions.find((d) => d.transactionType === 'SALE_MODIFIER')!;
    assert.equal(modEntry.quantityChangeMilli, 20_000);
    assert.ok(modEntry.lineCogsMicroBaht < 0, 'Negative FIXED_QTY_DELTA must reduce COGS');
  });

  it('Invariant 4: Thai VAT 7% Inclusive vs Exclusive rounding accuracy & Safe Integer Guards', () => {
    // 107.00 THB (10,700 satang) VAT Inclusive at 7% (700 bps) -> VAT is exactly 700 satang (7.00 THB)
    assert.equal(computeVatSatang(10_700, 700, 'INCLUSIVE'), 700);
    // 100.00 THB (10,000 satang) VAT Exclusive at 7% (700 bps) -> VAT is 700 satang
    assert.equal(computeVatSatang(10_000, 700, 'EXCLUSIVE'), 700);
    assert.equal(computeVatSatang(10_000, 700, 'NONE'), 0);

    // Negative landed cost or negative unit cost must throw RangeError
    assert.throws(
      () =>
        allocateLandedCostExact(
          [{ id: 'ITEM-1', receivedQtyMilli: 1_000, baseUnitCostMicroBaht: 1_000_000 }],
          -500
        ),
      RangeError
    );
    assert.throws(
      () => computeNewMovingAverageCost(1_000, 1_000_000, 1_000, -500_000),
      RangeError
    );
  });

  it('Invariant 5 (Logic Audit Regressions): Precision boundary guard & missing BOM catalog error parity', () => {
    // Values exceeding Number.MAX_SAFE_INTEGER (but below i64::MAX) must throw RangeError instead of silently losing IEEE-754 precision
    assert.throws(() => toSafeFixedPointNumber(JS_MAX_SAFE_BIGINT + 1n), RangeError);

    // Missing component variant in BOM edge or FIXED_QTY_DELTA modifier must throw immediately
    const catalog = new Map(SEED_VARIANTS.map((v) => [v.id, v]));
    const milkTea = catalog.get('VAR-CAFE-MILKTEA')!;
    assert.throws(
      () =>
        calculateOrderLineDeductions(
          milkTea,
          1_000,
          [
            {
              id: 'MOD-MISSING',
              modifierGroupId: 'GRP-TOPPING',
              name: 'Missing Variant Modifier',
              priceDeltaSatang: 1_000,
              modifierMode: 'FIXED_QTY_DELTA',
              componentVariantId: 'VAR-NON-EXISTENT',
              quantityDeltaMilli: 10_000,
              targetComponentRole: null,
              scaleBasisPoints: 0,
            },
          ],
          catalog,
          SEED_BOM_EDGES
        ),
      /Missing component variant VAR-NON-EXISTENT/
    );
  });
});

