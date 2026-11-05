/**
 * RUBE-STOCK-POS v3.1 Phase 2 End-to-End POS Terminal, Shift, ABB Tax Invoice & Anti-Fraud Assembly Suite
 *
 * Tests all 4 Squads working together on a real file-backed WAL SQLite database:
 * - Squad A: `SHIFT_SVC`, `CHECKOUT_SVC` (Idempotent + Thai ABB + KDS Queue), `VOID_RETURN` (Historical Cost Mirroring)
 * - Squad B: `PRINTER_HAL` (`renderThaiReceiptAbbEscPosJob` Chunked 203-DPI `GS v 0` + `ESC J` + `ESC p` Drawer Kick)
 *            & `PAYMENT_HAL` (`generateOfflinePromptPayDynamicQr` + Two-Phase BOT Slip Mini-QR Anti-Fraud)
 * - Squad C: `PosTerminalViewController` (with First-Char Rollback & Scale Barcode) & `ShiftDrawerViewController` (Blind Drop)
 * - Squad D: `LocalIpcBridge` + Global Ledger Conservation Verification
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
  PosTerminalViewController,
  PurchaseOrderViewController,
  ShiftDrawerViewController,
} from '../../packages/ui-presentation/src/index.ts';
import { computeEan13CheckDigit } from '../../packages/hal-drivers/src/scanner/mod.ts';

function createTempSqliteDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rube-pos-p2-${prefix}-`));
  return path.join(dir, 'pos_phase2.db');
}

test('Phase 2 Assembly 1: Thai Layout Scancode + First-Char Rollback, Scale Barcode, ABB Tax Invoice, KDS Queue & Chunked 203-DPI Print', async () => {
  const dbPath = createTempSqliteDbPath('checkout');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
    const bridge = new LocalIpcBridge(engine);
    const shiftView = new ShiftDrawerViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');
    const posView = new PosTerminalViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');

    // 1. Open Morning Shift with 2,000.00 THB (200,000 Satang)
    const shift = await shiftView.openShift({
      shiftNumber: '20261105-S1',
      openingCashSatang: 200_000,
    });
    assert.equal(shift.status, 'OPEN');

    const blindVm = shiftView.getActiveShiftBlindViewModel();
    assert.ok(blindVm);
    assert.equal(blindVm.expectedCashHiddenForBlindDrop, true);

    // 2. Cashier types "ชา" slowly into the focused search box, then fires the USB barcode scanner
    // on "8851952350161" (Crystal Water 7.00 THB) while Windows keyboard is stuck on Thai layout!
    posView.searchInputText = 'ชา';
    const crystalBarcode = '8851952350161';
    const thaiGarbledChars = ['_', '_', 'ถ', 'ๅ', 'ต', 'ถ', '/', 'ุ', 'ถ', 'จ', 'ๅ', 'ต', 'ๅ'];
    let t = 1_000;
    for (let i = 0; i < crystalBarcode.length; i++) {
      posView.handleKeyDownWithFocusedSearchInput(
        `Digit${crystalBarcode[i]}`,
        thaiGarbledChars[i]!,
        t
      );
      t += 12; // 12ms inter-key scanner cadence (< 50ms threshold)
    }
    posView.handleKeyDownWithFocusedSearchInput('Enter', '\n', t + 12);

    assert.equal(
      posView.searchInputText,
      'ชา',
      'First-Char Rollback must strip the leaked Thai character "_" from the search input box'
    );
    assert.equal(posView.firstCharRollbackCount, 1);

    // 3. Scan a Weight-Embedded Scale Barcode (Prefix 20, SKU 10045 Sliced Pork, 1.250 kg @ 180.00 THB/kg = 225.00 THB)
    const scalePrefix12 = '201004501250';
    const scaleBarcode13 = `${scalePrefix12}${computeEan13CheckDigit(scalePrefix12)}`;
    posView.addBarcodeStringToCart(scaleBarcode13);

    // 4. Add 1 cup of Taiwan Milk Tea (65.00 THB) with "หวานน้อย 50%" (MOD-SWEET-50) + "เพิ่มไข่มุก (+15฿)" (MOD-EXTRA-BOBA)
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-MILKTEA',
      quantityMilli: 1_000,
      selectedModifierIds: ['MOD-SWEET-50', 'MOD-EXTRA-BOBA'],
    });

    // 5. Apply 12.00 THB (1,200 Satang) discount:
    // Subtotal = 7.00 + 225.00 + (65.00 + 15.00) = 312.00 THB (31,200 Satang)
    // Total after discount = 300.00 THB (30,000 Satang)
    posView.setBillDiscount(1_200);
    const cartSummary = posView.getCartSummaryViewModel();
    assert.equal(cartSummary.subtotalSatang, 31_200);
    assert.equal(cartSummary.totalSatang, 30_000);
    assert.equal(cartSummary.taxSatang, 1_963); // round(30,000 * 700 / 10,700) = 1,963 Satang
    assert.equal(cartSummary.netBeforeTaxSatang, 28_037);

    // 6. Confirm Cash Checkout (Customer pays 500.00 THB -> Change 200.00 THB)
    const { checkoutResult, printJob } = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-POS-ORDER-001',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 50_000,
    });

    assert.equal(checkoutResult.replayedFromIdempotencyKey, false);
    assert.match(checkoutResult.abbTaxInvoiceNo, /^ABB-\d{8}-000001$/);
    assert.equal(checkoutResult.totalSatang, 30_000);
    assert.equal(checkoutResult.changeGivenSatang, 20_000);
    assert.equal(checkoutResult.kitchenOrderSequenceId, 1, 'Hospitality item must enqueue KDS sequence_id = 1');

    // Verify 203-DPI Chunked Raster Print Job
    assert.equal(printJob.kickDrawerCommandIncluded, true, 'Cash payment must kick RJ11 cash drawer');
    assert.equal(printJob.cutPaperCommandIncluded, true);
    assert.ok(
      printJob.maxPacketByteLength <= 8_192,
      `Every raster band must fit inside an 8KB thermal printer buffer (max was ${printJob.maxPacketByteLength})`
    );
    assert.ok(
      printJob.packets.some((p) => p.type === 'ESC_J_WHITESPACE_FEED'),
      'Print job must emit ESC J whitespace feed commands for blank gaps'
    );

    // 7. Replay the exact same Idempotency-Key and verify zero duplicate stock deduction or shift cash inflation
    const replay = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-POS-ORDER-001',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 50_000,
    });
    assert.equal(replay.checkoutResult.replayedFromIdempotencyKey, true);
    assert.equal(replay.checkoutResult.salesOrderId, checkoutResult.salesOrderId);

    const conservation = bridge.verifyLedgerConservationInvariant('OUTLET-HQ');
    assert.equal(conservation.valid, true);
  } finally {
    engine.close();
  }
});

test('Phase 2 Assembly 2: Two-Phase Anti-Fraud PromptPay QR & BOT Slip Mini-QR Verification (Cancel Safe + Duplicate Block)', async () => {
  const dbPath = createTempSqliteDbPath('promptpay');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
    const bridge = new LocalIpcBridge(engine);
    const shiftView = new ShiftDrawerViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');
    const posView = new PosTerminalViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');

    const shift = await shiftView.openShift({
      shiftNumber: '20261105-S2',
      openingCashSatang: 100_000,
    });

    // 1. Add Jasmine Honey Green Tea (75.00 THB = 7,500 Satang)
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-HONEYTEA',
      quantityMilli: 1_000,
    });

    const qr = posView.generatePromptPayQrForCart('0105566001234');
    assert.equal(qr.totalSatang, 7_500);
    assert.ok(qr.payload.includes('010212'), 'Must be Dynamic EMVCo QR (Tag 01 = 12)');
    assert.ok(qr.payload.includes('540575.00'), 'Must embed exact amount 75.00 THB in Tag 54');

    // 2. Scan BOT Slip Mini-QR in Step 1 (Bank 004 KBANK, TransRef "2026110599887766" length 16 -> outer TLV length = 21 + 16 = 37)
    const validSlipMiniQr = '00370006000001010300402162026110599887766';
    const step1ModalFirst = posView.verifyScannedSlipStep1(validSlipMiniQr);
    assert.equal(step1ModalFirst.canProceedToStep2Confirm, true);
    assert.equal(step1ModalFirst.senderBankCode, '004');
    assert.equal(step1ModalFirst.senderBankNameThai, 'ธนาคารกสิกรไทย (KBANK)');
    assert.equal(step1ModalFirst.transRefLast4, '7766');
    assert.equal(step1ModalFirst.expectedAmountFormatted, '฿75.00');

    // 3. Cashier clicks Cancel before confirming Step 2 -> verify slip hash was NOT prematurely locked!
    posView.cancelSlipVerificationModal();
    const step1ModalSecond = posView.verifyScannedSlipStep1(validSlipMiniQr);
    assert.equal(
      step1ModalSecond.canProceedToStep2Confirm,
      true,
      'Cancelling Step-1 modal must NOT lock the slip as duplicate'
    );

    // 4. Confirm Step-2 Checkout with the verified slip
    const { checkoutResult, printJob } = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-PP-ORDER-001',
      shiftId: shift.id,
      paymentMethod: 'PROMPTPAY_QR',
    });
    assert.equal(checkoutResult.senderBankCode, '004');
    assert.equal(checkoutResult.slipTransRefLast4, '7766');
    assert.equal(printJob.kickDrawerCommandIncluded, false, 'PromptPay QR must NOT kick cash drawer');

    // 5. Fraudster attempts to reuse the exact same slip on a new order:
    posView.clearCart();
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-HONEYTEA',
      quantityMilli: 1_000,
    });

    const dupModal = posView.verifyScannedSlipStep1(validSlipMiniQr);
    assert.equal(dupModal.canProceedToStep2Confirm, false);
    assert.equal(dupModal.verification.isDuplicate, true);

    await assert.rejects(
      async () => {
        await posView.confirmCheckoutAndPrint({
          idempotencyKey: 'IDEMP-PP-ORDER-002-FRAUD',
          shiftId: shift.id,
          paymentMethod: 'PROMPTPAY_QR',
          slipTransRefRaw: validSlipMiniQr,
        });
      },
      /HTTP 409 Duplicate Slip TransRef detected/,
      'SQLite payment_transactions must block duplicate slip TransRef hash across orders'
    );
  } finally {
    engine.close();
  }
});

test('Phase 2 Assembly 3: Historical Cost Mirror VOID_RETURN & Blind Drop Shift Cash Conservation', async () => {
  const dbPath = createTempSqliteDbPath('void-shift');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
    const bridge = new LocalIpcBridge(engine);
    const shiftView = new ShiftDrawerViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');
    const posView = new PosTerminalViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');
    const poView = new PurchaseOrderViewController(bridge);

    // 1. Open shift with 2,000.00 THB (200,000 Satang)
    const shift = await shiftView.openShift({
      shiftNumber: '20261105-S3',
      openingCashSatang: 200_000,
    });

    // 2. Sell 1 cup of Milk Tea (6,500 Satang Cash) when VAR-RAW-TEA MAC is 450,000 Micro-Baht/g
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-MILKTEA',
      quantityMilli: 1_000,
    });
    const { checkoutResult: saleToVoid } = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-VOID-TARGET-001',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 6_500,
    });

    // 3. Receive a new Purchase Order for VAR-RAW-TEA at a much higher cost (900,000 Micro-Baht/g)
    // so that current MAC changes BEFORE the customer voids the original sale!
    await poView.confirmPurchaseOrderReceipt({
      poNumber: 'PO-TEA-INFLATION-01',
      outletId: 'OUTLET-HQ',
      supplierId: 'SUP-001',
      createdByUserId: 'USR-WH-01',
      items: [
        {
          variantId: 'VAR-RAW-TEA',
          orderedQtyMilli: 5_000_000,
          receivedQtyMilli: 5_000_000,
          baseUnitCostMicroBaht: 900_000,
        },
      ],
      landedCosts: [],
    });

    // 4. Void the original Milk Tea sale and verify VOID_RETURN uses the historical 450,000 Micro-Baht/g cost!
    const voidResult = await shiftView.voidCompletedOrder({
      salesOrderId: saleToVoid.salesOrderId,
      voidReason: 'ลูกค้าขอเปลี่ยนเมนู',
    });
    assert.equal(voidResult.refundedTotalSatang, 6_500);
    const teaReversal = voidResult.reversedLedgerEntries.find(
      (e) => e.variantId === 'VAR-RAW-TEA'
    )!;
    assert.equal(teaReversal.restoredQtyMilli, 18_360);
    assert.equal(
      teaReversal.historicalUnitCostMicroBaht,
      450_000,
      'VOID_RETURN must mirror the exact historical unit_cost_micro_baht (450,000) from the original sale, NOT the post-PO MAC!'
    );

    // 5. Perform one kept Cash sale (2 bottles of Crystal Water = 1,400 Satang) + Drawer Movements:
    // - PAID_IN: +10,000 Satang (แลกเหรียญเพิ่ม)
    // - PAID_OUT: -5,000 Satang (ซื้อน้ำแข็งหลอดฉุกเฉิน)
    // - CASH_DROP: -50,000 Satang (ดรอปเงินสดเข้าตู้เซฟระหว่างวัน)
    posView.clearCart();
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-RET-001',
      quantityMilli: 2_000,
    });
    await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-KEPT-CASH-002',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 2_000,
    });

    await shiftView.recordDrawerMovement({
      shiftId: shift.id,
      movementType: 'PAID_IN',
      amountSatang: 10_000,
      reason: 'เติมเหรียญทอน',
    });
    await shiftView.recordDrawerMovement({
      shiftId: shift.id,
      movementType: 'PAID_OUT',
      amountSatang: 5_000,
      reason: 'ซื้อน้ำแข็งหลอด',
    });
    await shiftView.recordDrawerMovement({
      shiftId: shift.id,
      movementType: 'CASH_DROP',
      amountSatang: 50_000,
      reason: 'นำฝากตู้เซฟรอบบ่าย',
    });

    // Expected Cash = 200,000 (Open) + 1,400 (Net Kept Cash Sale) + 10,000 (Paid In) - 5,000 (Paid Out) - 50,000 (Cash Drop)
    // = 156,400 Satang (1,564.00 THB)
    // Cashier submits Blind Drop count of 156,000 Satang (short by 4.00 THB = -400 Satang)
    const closedShift = await shiftView.closeShiftWithBlindDrop({
      shiftId: shift.id,
      countedCashSatang: 156_000,
      notes: 'ปิดกะเย็น',
    });
    assert.equal(closedShift.status, 'CLOSED');
    assert.equal(closedShift.expectedCashSatang, 156_400);
    assert.equal(closedShift.countedCashSatang, 156_000);
    assert.equal(closedShift.cashVarianceSatang, -400);
    assert.equal(closedShift.varianceStatus, 'SHORT');

    // 6. Verify 100% Global Ledger Conservation Invariant across all variants
    const conservation = bridge.verifyLedgerConservationInvariant('OUTLET-HQ');
    assert.equal(conservation.valid, true);
    assert.equal(conservation.mismatches.length, 0);
  } finally {
    engine.close();
  }
});
