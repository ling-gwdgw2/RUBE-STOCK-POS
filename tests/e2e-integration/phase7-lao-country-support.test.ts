/**
 * RUBE-STOCK-POS v3.1 Phase 7: Lao PDR (`LA`) Country Support End-to-End & Invariant Test Suite
 *
 * Covers Phases 1–4:
 * 1. LAK Fixed-Point formatting (0 decimals retail, 2-decimal sub-Kip BOM MAC, 500M+ LAK PO overflow safety)
 * 2. Dynamic VAT (10% / 1000 bps standard Laos, 0% exempt) & LAK Cash Rounding (500 ₭ / 1,000 ₭) conservation
 * 3. Gregorian (CE) date formatting in `Asia/Vientiane` for `LA` vs Buddhist Era (BE) for `TH`
 * 4. Offline Static-to-Dynamic LAOQR / BCEL OnePay EMVCo QR (`Tag 01=12`, `Tag 53=418`, `Tag 54`, `Tag 58=LA`, CRC16)
 * 5. Lao Bank Transfer Slip Reference SHA-256 Deduplication & replay blocking
 * 6. Configurable Price-Embedded Scale Barcode Multiplier (`Prefix 25–29`) for LAK
 * 7. Win32 Lao Standard Keyboard (`KBDLAO.DLL`) & Lao Unicode digits (`໐–໙`)
 * 8. Localized Lao (`lo`) ESC/POS receipt job generation
 * 9. Full HTTP E2E server lifecycle in `LA` mode:
 *    Clean-Start Onboarding (`LA`, `lo`, 10% VAT, 500 ₭ rounding, LAOQR static template, Lao demo catalog) ->
 *    `/api/bootstrap` -> `/api/pos/validate-laoqr-template` -> `/api/pos/promptpay-qr` ->
 *    CASH checkout with 500 ₭ cash rounding & `INV-LA-` invoice ->
 *    LAOQR checkout + slip SHA-256 deduplication -> Duplicate slip rejection (`HTTP 409`) ->
 *    Live locale switch (`/api/settings/locale`) -> Z-Report & TaxRIS report formatting in `₭` ->
 *    100% SQLite ledger & financial conservation checks.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_LA_FISCAL_CONFIG,
  baseLakMinorToRequiredForeignMinor,
  computeOrderFinancialTotals,
  foreignMinorToBaseLakMinor,
  formatFiscalDateTime,
  formatForeignMoney,
  formatFxTenderReceiptLine,
  formatMicroUnitCost,
  formatMicroUnitCostForInput,
  formatMinorAmountForInput,
  formatMoney,
  formatVatRatePercent,
  getCashDenominationsForCountry,
  getQuickCashTenderButtonsForCountry,
  parseMoneyInputToMinor,
} from '../../packages/shared-contracts/src/currency.ts';
import {
  buildSampleStaticLaoQrTemplate,
  buildTwoPhaseLaoSlipConfirmationModal,
  computeCrc16CcittHex,
  generateOfflineLaoQrDynamicQr,
  parseEmvCoTlv,
  validateLaoQrStaticTemplate,
  verifyOfflineLaoTransferSlip,
} from '../../packages/hal-drivers/src/payment/mod.ts';
import { parseScaleBarcodeEan13 } from '../../packages/hal-drivers/src/scanner/mod.ts';
import { renderThaiReceiptAbbEscPosJob } from '../../packages/hal-drivers/src/printer/mod.ts';
import {
  mapThaiLaoKeyboardDigitInput,
  sanitizePinInput,
} from '../../packages/ui-presentation/src/app/utils/keyboard-digits.ts';
import { RubePosInteractiveAppServer } from '../../packages/ui-presentation/src/server/pos-desktop-server.ts';

describe('Phase 7: Lao PDR (LA) Country Support — Currency, VAT, Rounding, LAOQR, Keyboard & E2E Server', () => {
  it('1. formats LAK (0 decimals), sub-Kip BOM MAC, large 500M+ LAK PO safety & Gregorian CE dates', () => {
    assert.equal(formatMoney(3_500_000, 'LAK'), '35,000 ₭');
    assert.equal(formatMoney(0, 'LAK'), '0 ₭');
    assert.equal(formatMoney(-50_000, 'LAK'), '-500 ₭');
    assert.equal(formatMoney(4_550, 'THB'), '฿45.50');

    assert.equal(formatMinorAmountForInput(3_500_000, 'LAK'), '35000');
    assert.equal(parseMoneyInputToMinor('35000', 'LAK'), 3_500_000);
    assert.equal(parseMoneyInputToMinor('35000.40', 'LAK'), 3_500_000); // snaps stray fractional Kip

    // Sub-Kip micro-unit cost preservation for BOM raw materials (e.g. 25.50 ₭ per gram)
    assert.equal(formatMicroUnitCost(25_500_000, 'LAK'), '25.50 ₭');
    assert.equal(formatMicroUnitCost(18_000_000_000, 'LAK'), '18,000 ₭');
    assert.equal(formatMicroUnitCostForInput(25_500_000, 'LAK'), '25.50');
    assert.equal(formatMicroUnitCostForInput(18_000_000_000, 'LAK'), '18000');

    // Large PO safety: 500,000,000 LAK = 50,000,000,000 minor units (well within Number.MAX_SAFE_INTEGER)
    const largePoMinor = parseMoneyInputToMinor('500000000', 'LAK');
    assert.equal(largePoMinor, 50_000_000_000);
    assert.ok(Number.isSafeInteger(largePoMinor));
    assert.equal(formatMoney(largePoMinor, 'LAK'), '500,000,000 ₭');

    // VAT basis-points formatting
    assert.equal(formatVatRatePercent(1000), '10');
    assert.equal(formatVatRatePercent(700), '7');
    assert.equal(formatVatRatePercent(0), '0');

    // Lao PDR defaults & denominations
    assert.equal(DEFAULT_LA_FISCAL_CONFIG.countryCode, 'LA');
    assert.equal(DEFAULT_LA_FISCAL_CONFIG.currencyCode, 'LAK');
    assert.equal(DEFAULT_LA_FISCAL_CONFIG.uiLocale, 'lo');
    assert.equal(DEFAULT_LA_FISCAL_CONFIG.receiptLocale, 'lo');
    assert.equal(DEFAULT_LA_FISCAL_CONFIG.vatRateBps, 1000);
    const laoDenoms = getCashDenominationsForCountry('LA');
    assert.equal(laoDenoms.length, 8);
    assert.equal(laoDenoms[0]!.satang, 10_000_000); // 100,000 ₭
    assert.equal(laoDenoms[laoDenoms.length - 1]!.satang, 50_000); // 500 ₭
    assert.ok(laoDenoms.every((d) => d.kind === 'NOTE')); // No coins in Laos
    const quickBtns = getQuickCashTenderButtonsForCountry('LA');
    assert.deepEqual(
      quickBtns.map((b) => b.majorValue),
      [10_000, 20_000, 50_000, 100_000, 200_000]
    );

    // Date formatting: Gregorian CE (`2026`) in `Asia/Vientiane` for LA vs Buddhist Era (`2569`) for TH
    const sampleIso = '2026-05-15T07:30:00.000Z';
    const laDate = formatFiscalDateTime(sampleIso, 'LA', 'lo');
    assert.ok(laDate.includes('2026'), `Expected Gregorian year 2026 in LA date, got: ${laDate}`);
    assert.ok(!laDate.includes('2569'), `LA date must not use Thai Buddhist Era 2569: ${laDate}`);
    const thDate = formatFiscalDateTime(sampleIso, 'TH', 'th');
    assert.ok(thDate.includes('2569'), `Expected Thai BE year 2569 in TH date, got: ${thDate}`);
  });

  it('2. computes dynamic 10%/0% VAT and LAK cash rounding (500 ₭ / 1,000 ₭) with exact accounting conservation', () => {
    // 10% INCLUSIVE: 110,000 LAK -> Net 100,000 + VAT 10,000
    const inc10 = computeOrderFinancialTotals({
      subtotalSatang: 11_000_000,
      discountSatang: 0,
      vatRateBps: 1000,
      taxMode: 'INCLUSIVE',
      currencyCode: 'LAK',
      applyCashRounding: false,
    });
    assert.equal(inc10.totalSatang, 11_000_000);
    assert.equal(inc10.netBeforeTaxSatang, 10_000_000);
    assert.equal(inc10.taxSatang, 1_000_000);
    assert.equal(inc10.netBeforeTaxSatang + inc10.taxSatang, inc10.totalSatang);

    // 10% EXCLUSIVE: 100,000 LAK -> Net 100,000 + VAT 10,000 = 110,000 LAK
    const exc10 = computeOrderFinancialTotals({
      subtotalSatang: 10_000_000,
      discountSatang: 0,
      vatRateBps: 1000,
      taxMode: 'EXCLUSIVE',
      currencyCode: 'LAK',
      applyCashRounding: false,
    });
    assert.equal(exc10.netBeforeTaxSatang, 10_000_000);
    assert.equal(exc10.taxSatang, 1_000_000);
    assert.equal(exc10.totalSatang, 11_000_000);

    // 0% Exempt (NONE)
    const exempt = computeOrderFinancialTotals({
      subtotalSatang: 3_500_000,
      discountSatang: 0,
      vatRateBps: 1000,
      taxMode: 'NONE',
      currencyCode: 'LAK',
      applyCashRounding: false,
    });
    assert.equal(exempt.taxSatang, 0);
    assert.equal(exempt.netBeforeTaxSatang, 3_500_000);
    assert.equal(exempt.totalSatang, 3_500_000);

    // LAK Cash Rounding (500 ₭ step, INCLUSIVE): 35,400 LAK -> 35,000 LAK (rounding discount 400 LAK)
    const roundedInc500 = computeOrderFinancialTotals({
      subtotalSatang: 3_540_000,
      discountSatang: 0,
      vatRateBps: 1000,
      taxMode: 'INCLUSIVE',
      currencyCode: 'LAK',
      applyCashRounding: true,
      cashRoundingStepMajor: 500,
    });
    assert.equal(roundedInc500.totalSatang, 3_500_000);
    assert.equal(roundedInc500.cashRoundingDiscountSatang, 40_000);
    assert.equal(roundedInc500.effectiveDiscountSatang, 40_000);
    assert.equal(
      roundedInc500.subtotalSatang - roundedInc500.effectiveDiscountSatang,
      roundedInc500.totalSatang
    );
    assert.equal(
      roundedInc500.netBeforeTaxSatang + roundedInc500.taxSatang,
      roundedInc500.totalSatang
    );

    // LAK Cash Rounding (1,000 ₭ step, EXCLUSIVE): 35,000 + 10% = 38,500 -> rounds down to 38,000 LAK
    const roundedExc1000 = computeOrderFinancialTotals({
      subtotalSatang: 3_500_000,
      discountSatang: 0,
      vatRateBps: 1000,
      taxMode: 'EXCLUSIVE',
      currencyCode: 'LAK',
      applyCashRounding: true,
      cashRoundingStepMajor: 1000,
    });
    assert.equal(roundedExc1000.totalSatang, 3_800_000);
    assert.equal(roundedExc1000.cashRoundingDiscountSatang, 50_000);
    assert.equal(
      roundedExc1000.netBeforeTaxSatang + roundedExc1000.taxSatang,
      roundedExc1000.totalSatang
    );

    // Small-bill safety guard: 300 LAK with 500 ₭ rounding step MUST NOT round down to 0 LAK
    const smallBill = computeOrderFinancialTotals({
      subtotalSatang: 30_000,
      discountSatang: 0,
      vatRateBps: 1000,
      taxMode: 'INCLUSIVE',
      currencyCode: 'LAK',
      applyCashRounding: true,
      cashRoundingStepMajor: 500,
    });
    assert.equal(smallBill.totalSatang, 30_000);
    assert.equal(smallBill.cashRoundingDiscountSatang, 0);
  });

  it('3. upgrades Static LAOQR / BCEL OnePay template to Dynamic EMVCo QR (Tag 01=12, 53=418, 54, CRC16) & rejects invalid QR', () => {
    const staticTpl = buildSampleStaticLaoQrTemplate('VIENTIANE COFFEE', 'VIENTIANE', 'BCEL-VTE-888');
    const validation = validateLaoQrStaticTemplate(staticTpl);
    assert.equal(validation.valid, true);
    assert.equal(validation.countryCode, 'LA');
    assert.equal(validation.currencyNumeric, '418');
    assert.equal(validation.merchantAccountTag, '38');
    assert.equal(validation.merchantName, 'VIENTIANE COFFEE');
    assert.equal(validation.crcValid, true);

    const dynamic = generateOfflineLaoQrDynamicQr(staticTpl, 3_500_000, 'LA-BILL-001');
    assert.equal(dynamic.wholeLakAmount, 35_000);
    const parsedNodes = parseEmvCoTlv(dynamic.payload);
    assert.ok(parsedNodes !== null);
    assert.equal(parsedNodes.find((n) => n.tag === '01')?.value, '12'); // Dynamic
    assert.equal(parsedNodes.find((n) => n.tag === '53')?.value, '418'); // LAK
    assert.equal(parsedNodes.find((n) => n.tag === '54')?.value, '35000'); // Whole Kip, no decimals
    assert.equal(parsedNodes.find((n) => n.tag === '58')?.value, 'LA');
    assert.equal(parsedNodes.find((n) => n.tag === '63')?.value, dynamic.crcHex);
    assert.equal(
      computeCrc16CcittHex(dynamic.payload.slice(0, dynamic.payload.length - 4)),
      dynamic.crcHex
    );

    // Reject tampered CRC
    const tampered = `${staticTpl.slice(0, -4)}FFFF`;
    const tamperedRes = validateLaoQrStaticTemplate(tampered);
    assert.equal(tamperedRes.valid, false);
    assert.equal(tamperedRes.crcValid, false);

    // Reject Thai PromptPay QR (`5802TH`) imported into Laos template slot
    const thaiQr =
      '00020101021129370016A0000006770101110113006681234567853037645802TH6304' +
      computeCrc16CcittHex(
        '00020101021129370016A0000006770101110113006681234567853037645802TH6304'
      );
    const thaiRes = validateLaoQrStaticTemplate(thaiQr);
    assert.equal(thaiRes.valid, false);
    assert.equal(thaiRes.countryCode, 'TH');
  });

  it('4. verifies Lao Bank Transfer Slip references with SHA-256 deduplication and two-phase modal', () => {
    const usedHashes = new Set<string>();

    // Step 1 preview does not commit hash yet
    const modal = buildTwoPhaseLaoSlipConfirmationModal(
      'BCEL2026112700199',
      'BCEL',
      3_500_000,
      usedHashes,
      'lo'
    );
    assert.equal(modal.canProceedToStep2Confirm, true);
    assert.equal(modal.expectedAmountFormatted, '35,000 ₭');
    assert.equal(modal.senderBankCode, 'BCEL');
    assert.equal(modal.transRefLast4, '0199');
    assert.equal(usedHashes.size, 0);

    // Step 2 commits hash
    const firstCommit = verifyOfflineLaoTransferSlip(
      'BCEL2026112700199',
      'BCEL',
      3_500_000,
      usedHashes,
      { commitSlipHash: true, locale: 'lo' }
    );
    assert.equal(firstCommit.validFormat, true);
    assert.equal(firstCommit.isDuplicate, false);
    assert.equal(usedHashes.size, 1);

    // Reusing the exact same slip reference (even lowercase with spaces) is blocked
    const replay = verifyOfflineLaoTransferSlip(
      '  bcel2026112700199 ',
      'BCEL',
      3_500_000,
      usedHashes,
      { commitSlipHash: false, locale: 'lo' }
    );
    assert.equal(replay.validFormat, true);
    assert.equal(replay.isDuplicate, true);

    // Short invalid reference rejected
    const tooShort = verifyOfflineLaoTransferSlip('12', 'LDB', 3_500_000, usedHashes);
    assert.equal(tooShort.validFormat, false);
  });

  it('5. supports Laos scale barcode multiplier (Prefix 25), Win32 KBDLAO.DLL digits & Lao ESC/POS receipt', () => {
    // Prefix 25 with Laos multiplier 10,000: `01500` -> `150,000 ₭` (15,000,000 minor units)
    const laScale = parseScaleBarcodeEan13('2510045015009', undefined, {
      priceEmbeddedMultiplier: 10_000,
    });
    assert.equal(laScale.isScaleBarcode, true);
    assert.equal(laScale.mode, 'PRICE_EMBEDDED');
    assert.equal(laScale.sku, '10045');
    assert.equal(laScale.totalPriceSatang, 15_000_000);

    // Default Thailand multiplier (1): `22500` -> `฿225.00` (22,500 satang)
    const thScale = parseScaleBarcodeEan13('2510045225009');
    assert.equal(thScale.isScaleBarcode, true);
    assert.equal(thScale.totalPriceSatang, 22_500);

    // Hardware-verified Win32 KBDLAO.DLL unshifted top-row (`ຢຟໂຖຸູຄຕຈຂ` -> `1234567890`)
    assert.equal(mapThaiLaoKeyboardDigitInput('ຢຟໂຖຸູຄຕຈຂ'), '1234567890');
    assert.equal(sanitizePinInput('ຢຟໂຖຸູ'), '123456');
    // Lao Unicode numerals (`໐–໙`)
    assert.equal(sanitizePinInput('໑໒໓໔໕໖໗໘', 8), '12345678');

    // Localized Lao (`lo`) ESC/POS receipt job
    const job = renderThaiReceiptAbbEscPosJob({
      countryCode: 'LA',
      receiptLocale: 'lo',
      storeName: 'ຮ້ານກາເຟ ວຽງຈັນ',
      storeAddress: 'ຖະໜົນລ້ານຊ້າງ, ນະຄອນຫຼວງວຽງຈັນ',
      taxId: '100234567890',
      posRegNo: 'POS-LA-001',
      abbTaxInvoiceNo: 'INV-LA-20261127-0001',
      receiptNumber: 'RCP-0001',
      vatRatePercentLabel: '10',
      taxMode: 'INCLUSIVE',
      lines: [{ itemName: 'ກາເຟລາວເຢັນ', quantityFormatted: '1 ຈອກ', lineTotalFormatted: '35,000 ₭' }],
      subtotalFormatted: '35,400 ₭',
      discountFormatted: '0 ₭',
      cashRoundingDiscountFormatted: '400 ₭',
      netBeforeTaxFormatted: '31,818 ₭',
      taxFormatted: '3,182 ₭',
      totalFormatted: '35,000 ₭',
      paymentMethod: 'CASH',
      cashTenderedFormatted: '50,000 ₭',
      changeGivenFormatted: '15,000 ₭',
    });
    const joined = job.formattedTextLines.join('\n');
    assert.ok(joined.includes('ໃບບິນຮັບເງິນ / ໃບອາກອນມູນຄ່າເພີ່ມ'));
    assert.ok(joined.includes('TIN: 100234567890'));
    assert.ok(joined.includes('ປັດເສດເງິນສົດ'));
    assert.ok(joined.includes('ອມພ 10%'));
    assert.ok(joined.includes('35,000 ₭'));
    assert.ok(job.maxPacketByteLength <= 8_192);
  });

  it('6. runs full E2E Lao PDR desktop server lifecycle (Clean-Start LA -> LAOQR -> 500 ₭ Cash Rounding -> Slip Dedup -> TaxRIS/Z-Report)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-lao-e2e-'));
    const dbPath = path.join(tmpDir, 'rube_lao.db');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      requireFirstRunWizard: true,
      enforceApiSessionAuth: true,
    });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // A. Validate Static LAOQR template before onboarding (public wizard endpoint)
      const staticLaoQr = buildSampleStaticLaoQrTemplate('LAO COFFEE HOUSE', 'VIENTIANE', 'BCEL-LA-999');
      const validateRes = await fetch(`${url}/api/pos/validate-laoqr-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawTemplate: staticLaoQr, previewAmountSatang: 3_500_000 }),
      });
      assert.equal(validateRes.status, 200);
      const validated = (await validateRes.json()) as {
        valid: boolean;
        merchantName: string;
        previewWholeLakAmount: number;
      };
      assert.equal(validated.valid, true);
      assert.equal(validated.merchantName, 'LAO COFFEE HOUSE');
      assert.equal(validated.previewWholeLakAmount, 35_000);

      // B. Complete First-Run Onboarding as Lao PDR (`LA`, `LAK`, `lo` UI & receipt, 10% VAT, 500 ₭ cash rounding)
      const onboardRes = await fetch(`${url}/api/onboarding/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: 'ຮ້ານກາເຟ ວຽງຈັນ 3.1',
          storeAddress: 'ບ້ານໂພນສີນວນ, ນະຄອນຫຼວງວຽງຈັນ',
          taxId: '100998877665',
          branchCode: '00001',
          rdPosRegNo: 'POS-LA-VTE-01',
          promptPayId: '',
          businessProfile: 'HYBRID',
          countryCode: 'LA',
          currencyCode: 'LAK',
          uiLocale: 'lo',
          receiptLocale: 'lo',
          vatRateBps: 1000,
          defaultTaxMode: 'INCLUSIVE',
          cashRoundingStepMajor: 500,
          scalePriceEmbeddedMultiplier: 10_000,
          laoQrStaticTemplate: staticLaoQr,
          laoQrVerificationPolicy: 'STRICT_REF',
          ownerDisplayName: 'ທ້າວ ບຸນມີ (Owner)',
          ownerPin: '123456',
          openingCashSatang: 50_000_000, // 500,000 ₭
          loadDemoSampleCatalog: true,
          recoveryPassphrase: 'Vientiane-Strong-Recovery-2026!',
        }),
      });
      const onboardBodyText = await onboardRes.text();
      assert.equal(onboardRes.status, 200, `Onboarding failed: ${onboardBodyText}`);
      const onboardData = JSON.parse(onboardBodyText) as {
        ok: boolean;
        sessionToken: string;
        ownerUser: { id: string };
      };
      assert.equal(onboardData.ok, true);
      assert.ok(onboardData.sessionToken);

      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${onboardData.sessionToken}`,
      };

      // C. Verify `/api/bootstrap` reflects Lao PDR profile, `lo` default locale & LAK catalog
      const bootRes = await fetch(`${url}/api/bootstrap`, { headers: authHeaders });
      assert.equal(bootRes.status, 200);
      const boot = (await bootRes.json()) as {
        onboarded: boolean;
        fiscalConfig: {
          countryCode: string;
          currencyCode: string;
          uiLocale: string;
          receiptLocale: string;
          vatRateBps: number;
          cashRoundingStepMajor: number;
          scalePriceEmbeddedMultiplier: number;
        };
        catalogDetailed: Array<{ id: string; itemName: string; priceSatang: number; unitName: string }>;
        ledgerInvariant: { valid: boolean };
      };
      assert.equal(boot.onboarded, true);
      assert.equal(boot.fiscalConfig.countryCode, 'LA');
      assert.equal(boot.fiscalConfig.currencyCode, 'LAK');
      assert.equal(boot.fiscalConfig.uiLocale, 'lo');
      assert.equal(boot.fiscalConfig.receiptLocale, 'lo');
      assert.equal(boot.fiscalConfig.vatRateBps, 1000);
      assert.equal(boot.fiscalConfig.cashRoundingStepMajor, 500);
      assert.equal(boot.fiscalConfig.scalePriceEmbeddedMultiplier, 10_000);
      assert.ok(boot.catalogDetailed.length >= 4);
      assert.equal(boot.ledgerInvariant.valid, true);

      const retailItem = boot.catalogDetailed.find((v) => v.priceSatang > 0)!;
      assert.ok(retailItem);

      // D. Checkout CASH with an odd Kip price (`35,400 ₭`) to verify 500 ₭ cash rounding & `INV-LA-` invoice
      const cashCheckoutRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'CASH',
          cashTenderedSatang: 5_000_000, // 50,000 ₭ banknote
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: retailItem.id,
              itemName: retailItem.itemName,
              unitName: retailItem.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 3_540_000, // 35,400 ₭ -> rounds down to 35,000 ₭
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(cashCheckoutRes.status, 200);
      const cashCheckout = (await cashCheckoutRes.json()) as {
        order: {
          abbTaxInvoiceNo: string;
          subtotalSatang: number;
          discountSatang: number;
          cashRoundingDiscountSatang: number;
          netBeforeTaxSatang: number;
          taxSatang: number;
          totalSatang: number;
          changeGivenSatang: number;
        };
        printJob: { formattedTextLines: string[] };
      };
      assert.ok(
        cashCheckout.order.abbTaxInvoiceNo.startsWith('INV-LA-'),
        `Expected INV-LA- invoice prefix, got ${cashCheckout.order.abbTaxInvoiceNo}`
      );
      assert.equal(cashCheckout.order.cashRoundingDiscountSatang, 40_000); // 400 ₭ rounded off
      assert.equal(cashCheckout.order.totalSatang, 3_500_000); // 35,000 ₭ payable
      assert.equal(cashCheckout.order.changeGivenSatang, 1_500_000); // 15,000 ₭ change
      assert.equal(
        cashCheckout.order.netBeforeTaxSatang + cashCheckout.order.taxSatang,
        cashCheckout.order.totalSatang
      );
      assert.ok(cashCheckout.printJob.formattedTextLines.join('\n').includes('35,000 ₭'));
      assert.ok(cashCheckout.printJob.formattedTextLines.join('\n').includes('ປັດເສດເງິນສົດ'));

      // E. Generate Dynamic LAOQR (`/api/pos/promptpay-qr`) for `45,000 ₭`
      const qrRes = await fetch(`${url}/api/pos/promptpay-qr`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: retailItem.id,
              quantityMilli: 1_000,
              unitPriceSatang: 4_500_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(qrRes.status, 200);
      const qrData = (await qrRes.json()) as {
        payload: string;
        qrScheme: string;
        currencyCode: string;
      };
      assert.equal(qrData.qrScheme, 'LAOQR');
      assert.equal(qrData.currencyCode, 'LAK');
      const qrNodes = parseEmvCoTlv(qrData.payload)!;
      assert.equal(qrNodes.find((n) => n.tag === '53')?.value, '418');
      assert.equal(qrNodes.find((n) => n.tag === '54')?.value, '45000');

      // F. Verify Lao Bank Slip Step 1 & Complete LAOQR Checkout (no cash rounding on QR!)
      const slipStep1Res = await fetch(`${url}/api/pos/verify-slip-step1`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          miniQrRaw: 'BCEL-TICKET-20261127-7788',
          senderBankCode: 'BCEL',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: retailItem.id,
              quantityMilli: 1_000,
              unitPriceSatang: 4_540_000, // 45,400 ₭ (exact on QR, NOT rounded!)
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(slipStep1Res.status, 200);
      const slipStep1 = (await slipStep1Res.json()) as {
        valid: boolean;
        expectedAmountFormatted: string;
      };
      assert.equal(slipStep1.valid, true);
      assert.equal(slipStep1.expectedAmountFormatted, '45,400 ₭');

      const qrCheckoutRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'PROMPTPAY_QR',
          slipTransRefRaw: 'BCEL-TICKET-20261127-7788',
          slipSenderBankCode: 'BCEL',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: retailItem.id,
              itemName: retailItem.itemName,
              unitName: retailItem.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 4_540_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(qrCheckoutRes.status, 200);
      const qrCheckout = (await qrCheckoutRes.json()) as {
        order: { totalSatang: number; cashRoundingDiscountSatang?: number };
      };
      assert.equal(qrCheckout.order.totalSatang, 4_540_000); // exact LAK, no rounding on QR!
      assert.equal(qrCheckout.order.cashRoundingDiscountSatang ?? 0, 0);

      // G. Replay the exact same Lao slip ref -> MUST be rejected (HTTP 409)
      const replayCheckoutRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'PROMPTPAY_QR',
          slipTransRefRaw: 'BCEL-TICKET-20261127-7788',
          slipSenderBankCode: 'BCEL',
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: retailItem.id,
              itemName: retailItem.itemName,
              unitName: retailItem.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 4_540_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(replayCheckoutRes.status, 409);

      // H. Switch live UI locale `lo` -> `th` -> `lo` via `/api/settings/locale`
      const localeRes = await fetch(`${url}/api/settings/locale`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ uiLocale: 'th' }),
      });
      assert.equal(localeRes.status, 200);
      const localeData = (await localeRes.json()) as { fiscalConfig: { uiLocale: string } };
      assert.equal(localeData.fiscalConfig.uiLocale, 'th');

      // I. Verify Z-Report & TaxRIS Sales Report formatted in LAK (`₭`) with exact total (`35,000 + 45,400 = 80,400 ₭`)
      const repRes = await fetch(`${url}/api/reports`, { headers: authHeaders });
      assert.equal(repRes.status, 200);
      const rep = (await repRes.json()) as {
        zReport: {
          netSalesTotalSatang: number;
          netSalesTotalFormatted: string;
          cashSalesFormatted: string;
          promptPaySalesFormatted: string;
        };
        abbReport: {
          totalGrossFormatted: string;
          invoices: Array<{ abbTaxInvoiceNo: string; totalFormatted: string }>;
        };
      };
      assert.equal(rep.zReport.netSalesTotalSatang, 8_040_000); // 80,400 ₭
      assert.equal(rep.zReport.netSalesTotalFormatted, '80,400 ₭');
      assert.equal(rep.zReport.cashSalesFormatted, '35,000 ₭');
      assert.equal(rep.zReport.promptPaySalesFormatted, '45,400 ₭');
      assert.equal(rep.abbReport.totalGrossFormatted, '80,400 ₭');
      assert.equal(rep.abbReport.invoices.length, 2);
      assert.ok(rep.abbReport.invoices.every((r) => r.abbTaxInvoiceNo.startsWith('INV-LA-')));

      // J. Confirm SQLite ledger conservation remains 100% balanced
      const finalBootRes = await fetch(`${url}/api/bootstrap`, { headers: authHeaders });
      const finalBoot = (await finalBootRes.json()) as {
        ledgerInvariant: { valid: boolean; mismatches: unknown[] };
      };
      assert.equal(finalBoot.ledgerInvariant.valid, true);
      assert.equal(finalBoot.ledgerInvariant.mismatches.length, 0);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('7. computes Phase 5 Multi-Currency FX BigInt conversions (THB & USD -> LAK) with zero float drift', () => {
    // ฿100.00 @ 640 ₭ = 64,000 ₭
    assert.equal(foreignMinorToBaseLakMinor(10_000, 640), 6_400_000);
    // $20.00 @ 21,500 ₭ = 430,000 ₭
    assert.equal(foreignMinorToBaseLakMinor(2_000, 21_500), 43_000_000);
    // Fractional foreign cash: ฿25.50 @ 640 ₭ = 16,320 ₭
    assert.equal(foreignMinorToBaseLakMinor(2_550, 640), 1_632_000);

    // Ceiling inverse: 35,000 ₭ @ 640 ₭ -> requires ฿54.69 (converts back to >= 35,000 ₭)
    const reqThb = baseLakMinorToRequiredForeignMinor(3_500_000, 640);
    assert.equal(reqThb, 5_469);
    assert.ok(foreignMinorToBaseLakMinor(reqThb, 640) >= 3_500_000);

    assert.equal(formatForeignMoney(10_000, 'THB'), '฿100.00');
    assert.equal(formatForeignMoney(2_000, 'USD'), '$20.00');
    assert.equal(formatForeignMoney(6_400_000, 'LAK'), '64,000 ₭');

    const lineLo = formatFxTenderReceiptLine(
      {
        currency: 'THB',
        foreignAmountSatang: 10_000,
        exchangeRateWholeLak: 640,
        equivalentBaseSatang: 6_400_000,
        changeGivenBaseSatang: 2_900_000,
      },
      'lo'
    );
    assert.equal(lineLo, 'ຮັບເງິນສົດ ฿100.00 (@ 640 ₭) = 64,000 ₭');
  });

  it('8. runs Phase 5 Multi-Currency FX E2E lifecycle (HMAC rates -> THB & USD cash -> LAK change -> Reprint -> Void -> Z-Report Drawer Breakdown)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-lao-fx-e2e-'));
    const dbPath = path.join(tmpDir, 'rube_lao_fx.db');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      requireFirstRunWizard: true,
      enforceApiSessionAuth: true,
    });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      const staticLaoQr = buildSampleStaticLaoQrTemplate('VIENTIANE FX CAFE', 'VIENTIANE', 'BCEL-FX-01');
      const onboardRes = await fetch(`${url}/api/onboarding/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: 'ຮ້ານກາເຟ FX ວຽງຈັນ',
          storeAddress: 'ນະຄອນຫຼວງວຽງຈັນ',
          taxId: '100998877001',
          branchCode: '00001',
          rdPosRegNo: 'POS-LA-FX-01',
          promptPayId: '',
          businessProfile: 'HYBRID',
          countryCode: 'LA',
          uiLocale: 'lo',
          receiptLocale: 'lo',
          vatRateBps: 1000,
          defaultTaxMode: 'INCLUSIVE',
          cashRoundingStepMajor: 500,
          scalePriceEmbeddedMultiplier: 10_000,
          laoQrStaticTemplate: staticLaoQr,
          laoQrVerificationPolicy: 'STRICT_REF',
          fxRates: { enabled: true, thbToLakRate: 640, usdToLakRate: 21_500 },
          ownerDisplayName: 'Owner FX',
          ownerPin: '123456',
          openingCashSatang: 50_000_000, // 500,000 ₭ float
          loadDemoSampleCatalog: true,
          recoveryPassphrase: 'Vientiane-FX-Recovery-2026!',
        }),
      });
      assert.equal(onboardRes.status, 200);
      const onboard = (await onboardRes.json()) as {
        sessionToken: string;
        ownerUser: { id: string };
      };
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${onboard.sessionToken}`,
      };

      const bootRes = await fetch(`${url}/api/bootstrap`, { headers: authHeaders });
      const boot = (await bootRes.json()) as {
        fiscalConfig: { fxRates: { enabled: boolean; thbToLakRate: number; usdToLakRate: number } };
        catalogDetailed: Array<{ id: string; itemName: string; unitName: string; priceSatang: number }>;
      };
      assert.equal(boot.fiscalConfig.fxRates.enabled, true);
      assert.equal(boot.fiscalConfig.fxRates.thbToLakRate, 640);
      assert.equal(boot.fiscalConfig.fxRates.usdToLakRate, 21_500);
      const item = boot.catalogDetailed.find((v) => v.priceSatang > 0)!;

      // 1. Reject underpaid foreign cash (฿10 = 6,400 ₭ < 35,000 ₭ bill)
      const underpaidRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'CASH',
          foreignTenderCurrency: 'THB',
          foreignTenderAmountSatang: 1_000, // ฿10
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: item.id,
              itemName: item.itemName,
              unitName: item.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 3_500_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(underpaidRes.status, 400);

      // 2. Checkout #1: 35,000 ₭ bill paid with ฿100 (@ 640 ₭ = 64,000 ₭) -> Change 29,000 ₭
      const thbPayRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'CASH',
          foreignTenderCurrency: 'THB',
          foreignTenderAmountSatang: 10_000, // ฿100.00
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: item.id,
              itemName: item.itemName,
              unitName: item.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 3_500_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(thbPayRes.status, 200);
      const thbPay = (await thbPayRes.json()) as {
        order: {
          salesOrderId: string;
          totalSatang: number;
          cashTenderedSatang: number;
          changeGivenSatang: number;
          fxTender: { currency: string; foreignAmountSatang: number; exchangeRateWholeLak: number };
        };
        printJob: { formattedTextLines: string[] };
      };
      assert.equal(thbPay.order.totalSatang, 3_500_000);
      assert.equal(thbPay.order.cashTenderedSatang, 6_400_000);
      assert.equal(thbPay.order.changeGivenSatang, 2_900_000);
      assert.equal(thbPay.order.fxTender.currency, 'THB');
      assert.equal(thbPay.order.fxTender.exchangeRateWholeLak, 640);
      assert.ok(thbPay.printJob.formattedTextLines.join('\n').includes('฿100.00 (@ 640 ₭) = 64,000 ₭'));

      // 3. Checkout #2: 40,000 ₭ bill paid with $5.00 (@ 21,500 ₭ = 107,500 ₭) -> Change 67,500 ₭
      const usdPayRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'CASH',
          foreignTenderCurrency: 'USD',
          foreignTenderAmountSatang: 500, // $5.00
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: item.id,
              itemName: item.itemName,
              unitName: item.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 4_000_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(usdPayRes.status, 200);
      const usdPay = (await usdPayRes.json()) as {
        order: { salesOrderId: string; cashTenderedSatang: number; changeGivenSatang: number };
        printJob: { formattedTextLines: string[] };
      };
      assert.equal(usdPay.order.cashTenderedSatang, 10_750_000);
      assert.equal(usdPay.order.changeGivenSatang, 6_750_000);
      assert.ok(usdPay.printJob.formattedTextLines.join('\n').includes('$5.00 (@ 21,500 ₭) = 107,500 ₭'));

      // 4. Reprint Checkout #1 -> verifies Lao reprint keeps FX line and ₭ currency
      const reprintRes = await fetch(`${url}/api/pos/reprint`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ salesOrderId: thbPay.order.salesOrderId }),
      });
      assert.equal(reprintRes.status, 200);
      const reprintData = (await reprintRes.json()) as {
        printJob: { formattedTextLines: string[] };
      };
      const reprintText = reprintData.printJob.formattedTextLines.join('\n');
      assert.ok(reprintText.includes('฿100.00 (@ 640 ₭) = 64,000 ₭'));
      assert.ok(reprintText.includes('35,000 ₭'));

      // 5. Verify Z-Report Multi-Currency Drawer Breakdown:
      // Float 500,000 + Sales (35,000 + 40,000) = 575,000 ₭ Expected Total
      // Foreign Banknotes in Drawer: ฿100 (64,000 ₭) + $5 (107,500 ₭) = 171,500 ₭
      // Physical Native Kip in Drawer: 500,000 - 29,000 - 67,500 = 403,500 ₭ (403,500 + 171,500 = 575,000 ₭!)
      const rep1Res = await fetch(`${url}/api/reports`, { headers: authHeaders });
      const rep1 = (await rep1Res.json()) as {
        zReport: {
          expectedCashSatang: number;
          fxCashSummaryFormatted: {
            fxTransactionsCount: number;
            thbCollectedFormatted: string;
            thbEquivalentFormatted: string;
            usdCollectedFormatted: string;
            usdEquivalentFormatted: string;
            totalForeignEquivalentFormatted: string;
            expectedNativeBaseCashFormatted: string;
          };
        };
      };
      assert.equal(rep1.zReport.expectedCashSatang, 57_500_000);
      assert.equal(rep1.zReport.fxCashSummaryFormatted.fxTransactionsCount, 2);
      assert.equal(rep1.zReport.fxCashSummaryFormatted.thbCollectedFormatted, '฿100.00');
      assert.equal(rep1.zReport.fxCashSummaryFormatted.thbEquivalentFormatted, '64,000 ₭');
      assert.equal(rep1.zReport.fxCashSummaryFormatted.usdCollectedFormatted, '$5.00');
      assert.equal(rep1.zReport.fxCashSummaryFormatted.usdEquivalentFormatted, '107,500 ₭');
      assert.equal(rep1.zReport.fxCashSummaryFormatted.totalForeignEquivalentFormatted, '171,500 ₭');
      assert.equal(rep1.zReport.fxCashSummaryFormatted.expectedNativeBaseCashFormatted, '403,500 ₭');

      // 6. Void USD order -> Z-Report automatically excludes voided FX order
      const voidRes = await fetch(`${url}/api/pos/void`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          salesOrderId: usdPay.order.salesOrderId,
          voidReason: 'Customer returned USD bill',
        }),
      });
      assert.equal(voidRes.status, 200);

      const rep2Res = await fetch(`${url}/api/reports`, { headers: authHeaders });
      const rep2 = (await rep2Res.json()) as {
        zReport: {
          fxCashSummaryFormatted: {
            fxTransactionsCount: number;
            thbCollectedSatang: number;
            usdCollectedSatang: number;
          };
        };
      };
      assert.equal(rep2.zReport.fxCashSummaryFormatted.fxTransactionsCount, 1);
      assert.equal(rep2.zReport.fxCashSummaryFormatted.thbCollectedSatang, 10_000);
      assert.equal(rep2.zReport.fxCashSummaryFormatted.usdCollectedSatang, 0);

      // 7. Disabling FX via `/api/settings/fiscal` blocks further foreign tenders
      const disableRes = await fetch(`${url}/api/settings/fiscal`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ fxRates: { enabled: false } }),
      });
      assert.equal(disableRes.status, 200);
      const blockedRes = await fetch(`${url}/api/pos/checkout`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          paymentMethod: 'CASH',
          foreignTenderCurrency: 'THB',
          foreignTenderAmountSatang: 10_000,
          taxMode: 'INCLUSIVE',
          discountSatang: 0,
          lines: [
            {
              variantId: item.id,
              itemName: item.itemName,
              unitName: item.unitName,
              quantityMilli: 1_000,
              unitPriceSatang: 3_500_000,
              selectedModifierIds: [],
            },
          ],
        }),
      });
      assert.equal(blockedRes.status, 400);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
