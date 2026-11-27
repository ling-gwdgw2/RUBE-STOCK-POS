/**
 * RUBE-STOCK-POS v3.1 Multi-Country Fiscal, Currency & Cash-Rounding Core (`TH` | `LA`)
 *
 * Keeps internal fixed-point storage scales (`*_satang` = x100, `*_micro_baht` = x1,000,000)
 * 100% consistent across Thailand (`THB`, 2 decimals) and Lao PDR (`LAK`, 0 retail decimals),
 * guaranteeing zero schema changes and zero IEEE-754 floating-point drift.
 */

import {
  type BasisPoints,
  type MicroBaht,
  type Satang,
  type TaxMode,
  SCALE_BASIS_POINTS,
  computeVatSatang,
  formatMicroBahtToThbString,
  formatSatangToThbString,
  parseDecimalStringToScaledInt,
  roundDivBigInt,
  toSafeFixedPointNumber,
} from './fixed-point.ts';

export type CountryCode = 'TH' | 'LA';
export type CurrencyCode = 'THB' | 'LAK';
export type ForeignTenderCurrencyCode = 'THB' | 'USD';
export type CashTenderCurrencyCode = 'LAK' | 'THB' | 'USD';
export type LocaleCode = 'th' | 'lo' | 'en';
export type CashRoundingStepMajor = 0 | 500 | 1000;
export type LaoQrVerificationPolicy = 'STRICT_REF' | 'VISUAL_CONFIRM_ALLOWED';

export interface FxRatesConfigDto {
  /** Enables accepting THB / USD cash tender with change returned in LAK (Lao PDR mode only) */
  enabled: boolean;
  /** Whole LAK per 1 THB (fixed-point integer, e.g., 640 -> 1 THB = 640 ₭) */
  thbToLakRate: number;
  /** Whole LAK per 1 USD (fixed-point integer, e.g., 21500 -> 1 USD = 21,500 ₭) */
  usdToLakRate: number;
}

export interface FxCashTenderDetailDto {
  currency: ForeignTenderCurrencyCode;
  /** Foreign currency amount tendered in x100 minor units (e.g., 10_000 = ฿100.00 or 2_000 = $20.00) */
  foreignAmountSatang: Satang;
  /** Authoritative store rate in whole LAK per 1 foreign unit at checkout time */
  exchangeRateWholeLak: number;
  /** Equivalent LAK tendered in x100 minor units (exact BigInt conversion) */
  equivalentBaseSatang: Satang;
  /** Change returned to customer in LAK (x100 minor units) */
  changeGivenBaseSatang: Satang;
}

export interface ShiftFxCashSummaryDto {
  fxTransactionsCount: number;
  thbCollectedSatang: Satang;
  thbEquivalentBaseSatang: Satang;
  usdCollectedSatang: Satang;
  usdEquivalentBaseSatang: Satang;
  totalForeignEquivalentBaseSatang: Satang;
  /** Physical native LAK cash expected in drawer = expectedCashSatang - totalForeignEquivalentBaseSatang */
  expectedNativeBaseCashInDrawerSatang: Satang;
}

export const DEFAULT_FX_RATES_CONFIG: Readonly<FxRatesConfigDto> = {
  enabled: false,
  thbToLakRate: 640,
  usdToLakRate: 21_500,
};

export interface FiscalConfigDto {
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  currencySymbol: '฿' | '₭';
  currencyDecimals: 2 | 0;
  uiLocale: LocaleCode;
  receiptLocale: LocaleCode;
  vatRateBps: BasisPoints;
  defaultTaxMode: TaxMode;
  cashRoundingStepMajor: CashRoundingStepMajor;
  /**
   * Minor units per 1 integer unit of the 5-digit `VVVVV` field on Prefix 25–29 price-embedded scale barcodes.
   * - Thailand (THB): `1` (1 unit = 0.01 THB = 1 satang; e.g. `22500` -> ฿225.00)
   * - Laos (LAK): `100` (= 1 LAK), `10_000` (= 100 LAK, max 9,999,900 ₭), or `100_000` (= 1,000 LAK)
   */
  scalePriceEmbeddedMultiplier: number;
  storeAddress: string;
  /** HMAC-protected static EMVCo LAOQR / BCEL OnePay string imported by owner */
  laoQrStaticTemplate: string;
  laoQrVerificationPolicy: LaoQrVerificationPolicy;
  /** Phase 5: HMAC-protected offline Multi-Currency FX rates (`THB`/`USD` -> `LAK`) */
  fxRates: FxRatesConfigDto;
}

export const DEFAULT_TH_FISCAL_CONFIG: Readonly<FiscalConfigDto> = {
  countryCode: 'TH',
  currencyCode: 'THB',
  currencySymbol: '฿',
  currencyDecimals: 2,
  uiLocale: 'th',
  receiptLocale: 'th',
  vatRateBps: 700,
  defaultTaxMode: 'INCLUSIVE',
  cashRoundingStepMajor: 0,
  scalePriceEmbeddedMultiplier: 1,
  storeAddress: '',
  laoQrStaticTemplate: '',
  laoQrVerificationPolicy: 'STRICT_REF',
  fxRates: { ...DEFAULT_FX_RATES_CONFIG, enabled: false },
};

export const DEFAULT_LA_FISCAL_CONFIG: Readonly<FiscalConfigDto> = {
  countryCode: 'LA',
  currencyCode: 'LAK',
  currencySymbol: '₭',
  currencyDecimals: 0,
  uiLocale: 'lo',
  receiptLocale: 'lo',
  vatRateBps: 1000,
  defaultTaxMode: 'INCLUSIVE',
  cashRoundingStepMajor: 0,
  scalePriceEmbeddedMultiplier: 10_000,
  storeAddress: '',
  laoQrStaticTemplate: '',
  laoQrVerificationPolicy: 'STRICT_REF',
  fxRates: { ...DEFAULT_FX_RATES_CONFIG, enabled: false },
};

export function normalizeCountryCode(raw: unknown): CountryCode {
  return String(raw ?? '').trim().toUpperCase() === 'LA' ? 'LA' : 'TH';
}

export function normalizeCurrencyCode(raw: unknown, countryCode: CountryCode): CurrencyCode {
  const up = String(raw ?? '').trim().toUpperCase();
  if (up === 'LAK') return 'LAK';
  if (up === 'THB') return 'THB';
  return countryCode === 'LA' ? 'LAK' : 'THB';
}

export function normalizeLocaleCode(raw: unknown, fallback: LocaleCode = 'th'): LocaleCode {
  const low = String(raw ?? '').trim().toLowerCase();
  if (low === 'lo' || low === 'lo-la') return 'lo';
  if (low === 'en' || low === 'en-us' || low === 'en-gb') return 'en';
  if (low === 'th' || low === 'th-th') return 'th';
  return fallback;
}

export function normalizeCashRoundingStepMajor(raw: unknown): CashRoundingStepMajor {
  const num = Number(raw);
  if (num === 500) return 500;
  if (num === 1000) return 1000;
  return 0;
}

export function normalizeLaoQrVerificationPolicy(raw: unknown): LaoQrVerificationPolicy {
  return String(raw ?? '').trim().toUpperCase() === 'VISUAL_CONFIRM_ALLOWED'
    ? 'VISUAL_CONFIRM_ALLOWED'
    : 'STRICT_REF';
}

export function normalizeScalePriceEmbeddedMultiplier(
  raw: unknown,
  countryCode: CountryCode
): number {
  const num = Number(raw);
  if (Number.isSafeInteger(num) && (num === 1 || num === 100 || num === 10_000 || num === 100_000)) {
    return num;
  }
  return countryCode === 'LA' ? 10_000 : 1;
}

export function getDefaultFiscalConfigForCountry(countryCode: CountryCode): FiscalConfigDto {
  return countryCode === 'LA'
    ? { ...DEFAULT_LA_FISCAL_CONFIG }
    : { ...DEFAULT_TH_FISCAL_CONFIG };
}

export function getCurrencySymbol(currencyCode: CurrencyCode): '฿' | '₭' {
  return currencyCode === 'LAK' ? '₭' : '฿';
}

export function getCurrencyDecimals(currencyCode: CurrencyCode): 2 | 0 {
  return currencyCode === 'LAK' ? 0 : 2;
}

/**
 * Snaps an internal minor-unit amount (`*_satang`) to the currency's smallest retail unit:
 * - `THB`: exact `1` minor unit (0.01 THB)
 * - `LAK`: nearest `100` minor units (1 whole LAK)
 */
export function roundMinorToCurrencyUnit(
  minorSatang: Satang,
  currencyCode: CurrencyCode
): Satang {
  if (currencyCode !== 'LAK') {
    return minorSatang;
  }
  const wholeMajor = roundDivBigInt(BigInt(minorSatang), 100n);
  return toSafeFixedPointNumber(wholeMajor * 100n, 'roundMinorToCurrencyUnit');
}

export interface OrderFinancialComputationInput {
  subtotalSatang: Satang;
  discountSatang: Satang;
  vatRateBps: BasisPoints;
  taxMode: TaxMode;
  currencyCode: CurrencyCode;
  applyCashRounding?: boolean | undefined;
  cashRoundingStepMajor?: CashRoundingStepMajor | undefined;
}

export interface OrderFinancialComputationResult {
  subtotalSatang: Satang;
  discountSatang: Satang;
  effectiveDiscountSatang: Satang;
  cashRoundingDiscountSatang: Satang;
  netBeforeTaxSatang: Satang;
  taxSatang: Satang;
  rawTotalSatang: Satang;
  totalSatang: Satang;
}

/**
 * Computes exact fixed-point order totals (Subtotal -> Discount -> Dynamic VAT -> Optional LAK Cash Rounding)
 * preserving 100% exact SQLite ledger & Z-report invariants (`gross - effectiveDiscount = netBeforeTax` and
 * `netBeforeTax + tax = total`) with zero floating-point math.
 */
export function computeOrderFinancialTotals(
  input: OrderFinancialComputationInput
): OrderFinancialComputationResult {
  const subtotalSatang = Math.max(0, roundMinorToCurrencyUnit(input.subtotalSatang, input.currencyCode));
  const baseDiscountSatang = Math.max(
    0,
    Math.min(subtotalSatang, roundMinorToCurrencyUnit(input.discountSatang, input.currencyCode))
  );
  const afterDiscount = Math.max(0, subtotalSatang - baseDiscountSatang);
  const effectiveVatBps = Math.max(0, input.vatRateBps);

  const rawTax = computeVatSatang(afterDiscount, effectiveVatBps, input.taxMode);
  const taxSatang = roundMinorToCurrencyUnit(rawTax, input.currencyCode);
  const netBeforeTaxSatang =
    input.taxMode === 'INCLUSIVE' ? Math.max(0, afterDiscount - taxSatang) : afterDiscount;
  const rawTotalSatang =
    input.taxMode === 'EXCLUSIVE' ? afterDiscount + taxSatang : afterDiscount;

  const stepMajor = input.cashRoundingStepMajor ?? 0;
  const shouldRoundCash =
    Boolean(input.applyCashRounding) &&
    input.currencyCode === 'LAK' &&
    stepMajor > 0 &&
    rawTotalSatang > 0;

  if (!shouldRoundCash) {
    return {
      subtotalSatang,
      discountSatang: baseDiscountSatang,
      effectiveDiscountSatang: baseDiscountSatang,
      cashRoundingDiscountSatang: 0,
      netBeforeTaxSatang,
      taxSatang,
      rawTotalSatang,
      totalSatang: rawTotalSatang,
    };
  }

  const stepMinor = BigInt(stepMajor) * 100n;
  const rawTotalBig = BigInt(rawTotalSatang);
  // Guard against rounding tiny items below 1 step down to 0 (violates payment amount > 0)
  if (rawTotalBig < stepMinor) {
    return {
      subtotalSatang,
      discountSatang: baseDiscountSatang,
      effectiveDiscountSatang: baseDiscountSatang,
      cashRoundingDiscountSatang: 0,
      netBeforeTaxSatang,
      taxSatang,
      rawTotalSatang,
      totalSatang: rawTotalSatang,
    };
  }

  const remainderMinor = rawTotalBig % stepMinor;
  if (remainderMinor === 0n) {
    return {
      subtotalSatang,
      discountSatang: baseDiscountSatang,
      effectiveDiscountSatang: baseDiscountSatang,
      cashRoundingDiscountSatang: 0,
      netBeforeTaxSatang,
      taxSatang,
      rawTotalSatang,
      totalSatang: rawTotalSatang,
    };
  }

  const roundedTotalSatang = toSafeFixedPointNumber(
    rawTotalBig - remainderMinor,
    'computeOrderFinancialTotals:roundedTotal'
  );
  const cashRoundingDiscountSatang = rawTotalSatang - roundedTotalSatang;

  if (input.taxMode === 'EXCLUSIVE' && effectiveVatBps > 0) {
    // Re-derive exact Net + VAT so Net + VAT === roundedTotalSatang and subtotal - effectiveDiscount === Net
    const rateBig = BigInt(effectiveVatBps);
    const derivedNet = roundMinorToCurrencyUnit(
      toSafeFixedPointNumber(
        roundDivBigInt(BigInt(roundedTotalSatang) * SCALE_BASIS_POINTS, SCALE_BASIS_POINTS + rateBig),
        'computeOrderFinancialTotals:exclusiveNet'
      ),
      input.currencyCode
    );
    const derivedTax = Math.max(0, roundedTotalSatang - derivedNet);
    const effectiveDiscountSatang = Math.max(baseDiscountSatang, subtotalSatang - derivedNet);
    return {
      subtotalSatang,
      discountSatang: baseDiscountSatang,
      effectiveDiscountSatang,
      cashRoundingDiscountSatang,
      netBeforeTaxSatang: derivedNet,
      taxSatang: derivedTax,
      rawTotalSatang,
      totalSatang: roundedTotalSatang,
    };
  }

  // INCLUSIVE or NONE: adding cashRoundingDiscountSatang directly into effectiveDiscountSatang yields exact roundedTotalSatang
  const effectiveDiscountSatang = Math.min(subtotalSatang, baseDiscountSatang + cashRoundingDiscountSatang);
  const adjustedAfterDiscount = Math.max(0, subtotalSatang - effectiveDiscountSatang);
  const adjustedTax = roundMinorToCurrencyUnit(
    computeVatSatang(adjustedAfterDiscount, effectiveVatBps, input.taxMode),
    input.currencyCode
  );
  const adjustedNet =
    input.taxMode === 'INCLUSIVE'
      ? Math.max(0, adjustedAfterDiscount - adjustedTax)
      : adjustedAfterDiscount;

  return {
    subtotalSatang,
    discountSatang: baseDiscountSatang,
    effectiveDiscountSatang,
    cashRoundingDiscountSatang,
    netBeforeTaxSatang: adjustedNet,
    taxSatang: adjustedTax,
    rawTotalSatang,
    totalSatang: adjustedAfterDiscount,
  };
}

/**
 * Formats an internal minor-unit amount (`*_satang`) WITHOUT currency symbol.
 * - `THB`: `"1,250.00"`
 * - `LAK`: `"35,000"`
 */
export function formatMinorAmountPlain(
  minorSatang: Satang,
  currencyCode: CurrencyCode = 'THB'
): string {
  if (currencyCode === 'LAK') {
    const roundedMajor = Number(roundDivBigInt(BigInt(minorSatang), 100n));
    return roundedMajor.toLocaleString('en-US');
  }
  return formatSatangToThbString(minorSatang);
}

/**
 * Formats an internal minor-unit amount (`*_satang`) WITH currency symbol.
 * - `THB`: `"฿1,250.00"` / `"-฿1,250.00"`
 * - `LAK`: `"35,000 ₭"` / `"-35,000 ₭"`
 */
export function formatMoney(
  minorSatang: Satang,
  currencyCode: CurrencyCode = 'THB'
): string {
  if (currencyCode === 'LAK') {
    const roundedMajor = Number(roundDivBigInt(BigInt(minorSatang), 100n));
    const sign = roundedMajor < 0 ? '-' : '';
    return `${sign}${Math.abs(roundedMajor).toLocaleString('en-US')} ₭`;
  }
  const sign = minorSatang < 0 ? '-' : '';
  return `${sign}฿${formatSatangToThbString(Math.abs(minorSatang))}`;
}

/**
 * Formats an input field string value (no thousands commas) from internal minor units.
 * - `THB`: `"1250.00"`
 * - `LAK`: `"35000"`
 */
export function formatMinorAmountForInput(
  minorSatang: Satang,
  currencyCode: CurrencyCode = 'THB'
): string {
  if (currencyCode === 'LAK') {
    const roundedMajor = Number(roundDivBigInt(BigInt(minorSatang), 100n));
    return String(roundedMajor);
  }
  return formatSatangToThbString(minorSatang).replace(/,/g, '');
}

/**
 * Formats a unit cost (`*_micro_baht`, x10^6) WITH currency symbol.
 * - `THB`: `"฿25.0000"`
 * - `LAK`: `"25,000 ₭"` when whole, or `"25.50 ₭"` when sub-Kip fractional cost exists (BOM raw materials)
 */
export function formatMicroUnitCost(
  microUnits: MicroBaht,
  currencyCode: CurrencyCode = 'THB'
): string {
  if (currencyCode === 'LAK') {
    const sign = microUnits < 0 ? '-' : '';
    const abs = Math.abs(microUnits);
    const scaled2 = Number(roundDivBigInt(BigInt(abs), 10_000n)); // 2 decimals of Kip
    const whole = Math.floor(scaled2 / 100);
    const frac = scaled2 % 100;
    if (frac === 0) {
      return `${sign}${whole.toLocaleString('en-US')} ₭`;
    }
    return `${sign}${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')} ₭`;
  }
  const sign = microUnits < 0 ? '-' : '';
  return `${sign}฿${formatMicroBahtToThbString(Math.abs(microUnits))}`;
}

/**
 * Formats a micro unit cost for numeric `<input>` editing (no commas).
 */
export function formatMicroUnitCostForInput(
  microUnits: MicroBaht,
  currencyCode: CurrencyCode = 'THB'
): string {
  if (currencyCode === 'LAK') {
    const sign = microUnits < 0 ? '-' : '';
    const abs = Math.abs(microUnits);
    const scaled2 = Number(roundDivBigInt(BigInt(abs), 10_000n));
    const whole = Math.floor(scaled2 / 100);
    const frac = scaled2 % 100;
    return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(frac).padStart(2, '0')}`;
  }
  return formatMicroBahtToThbString(microUnits).replace(/,/g, '');
}

/**
 * Parses user money text into internal minor units (`*_satang` = major * 100).
 * For `LAK`, snaps any stray decimals cleanly to whole Kip (`major * 100`).
 */
export function parseMoneyInputToMinor(
  rawInput: string,
  currencyCode: CurrencyCode = 'THB'
): Satang {
  const parsedMinor = parseDecimalStringToScaledInt(rawInput, 2);
  return roundMinorToCurrencyUnit(parsedMinor, currencyCode);
}

/**
 * Formats a basis-points VAT rate (`700` -> `"7"`, `1000` -> `"10"`, `750` -> `"7.5"`).
 */
export function formatVatRatePercent(vatRateBps: BasisPoints): string {
  const abs = Math.max(0, Math.round(vatRateBps));
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  if (rem === 0) return String(whole);
  return `${whole}.${String(rem).padStart(2, '0').replace(/0+$/, '')}`;
}

/**
 * Formats an ISO timestamp for UI & thermal receipts respecting country calendar conventions:
 * - `TH`: `th-TH` (Buddhist Era + Asia/Bangkok)
 * - `LA`: Gregorian / CE year (`dd/MM/yyyy HH:mm`) in `Asia/Vientiane` (Laos uses ค.ศ. / ຄ.ສ.)
 */
export function formatFiscalDateTime(
  isoOrDate: string | Date,
  countryCode: CountryCode,
  locale?: LocaleCode
): string {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) {
    return typeof isoOrDate === 'string' ? isoOrDate : '';
  }
  if (countryCode === 'LA') {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Vientiane',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(d);
    } catch {
      return d.toLocaleString('en-GB');
    }
  }
  const loc = locale === 'en' ? 'en-GB' : 'th-TH';
  try {
    return new Intl.DateTimeFormat(loc, {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return d.toLocaleString(loc);
  }
}

export interface CashDenominationPreset {
  id: string;
  majorValue: number;
  satang: Satang;
  kind: 'NOTE' | 'COIN';
}

export const THAI_CASH_DENOMINATIONS: ReadonlyArray<CashDenominationPreset> = [
  { id: 'B1000', majorValue: 1000, satang: 100_000, kind: 'NOTE' },
  { id: 'B500', majorValue: 500, satang: 50_000, kind: 'NOTE' },
  { id: 'B100', majorValue: 100, satang: 10_000, kind: 'NOTE' },
  { id: 'B50', majorValue: 50, satang: 5_000, kind: 'NOTE' },
  { id: 'B20', majorValue: 20, satang: 2_000, kind: 'NOTE' },
  { id: 'C10', majorValue: 10, satang: 1_000, kind: 'COIN' },
  { id: 'C5', majorValue: 5, satang: 500, kind: 'COIN' },
  { id: 'C2', majorValue: 2, satang: 200, kind: 'COIN' },
  { id: 'C1', majorValue: 1, satang: 100, kind: 'COIN' },
  { id: 'C050', majorValue: 0.5, satang: 50, kind: 'COIN' },
  { id: 'C025', majorValue: 0.25, satang: 25, kind: 'COIN' },
];

export const LAO_CASH_DENOMINATIONS: ReadonlyArray<CashDenominationPreset> = [
  { id: 'LAK100000', majorValue: 100_000, satang: 10_000_000, kind: 'NOTE' },
  { id: 'LAK50000', majorValue: 50_000, satang: 5_000_000, kind: 'NOTE' },
  { id: 'LAK20000', majorValue: 20_000, satang: 2_000_000, kind: 'NOTE' },
  { id: 'LAK10000', majorValue: 10_000, satang: 1_000_000, kind: 'NOTE' },
  { id: 'LAK5000', majorValue: 5_000, satang: 500_000, kind: 'NOTE' },
  { id: 'LAK2000', majorValue: 2_000, satang: 200_000, kind: 'NOTE' },
  { id: 'LAK1000', majorValue: 1_000, satang: 100_000, kind: 'NOTE' },
  { id: 'LAK500', majorValue: 500, satang: 50_000, kind: 'NOTE' },
];

export function getCashDenominationsForCountry(
  countryCode: CountryCode
): ReadonlyArray<CashDenominationPreset> {
  return countryCode === 'LA' ? LAO_CASH_DENOMINATIONS : THAI_CASH_DENOMINATIONS;
}

export function getQuickCashTenderButtonsForCountry(
  countryCode: CountryCode
): ReadonlyArray<{ majorValue: number; satang: Satang }> {
  if (countryCode === 'LA') {
    return [
      { majorValue: 10_000, satang: 1_000_000 },
      { majorValue: 20_000, satang: 2_000_000 },
      { majorValue: 50_000, satang: 5_000_000 },
      { majorValue: 100_000, satang: 10_000_000 },
      { majorValue: 200_000, satang: 20_000_000 },
    ];
  }
  return [
    { majorValue: 100, satang: 10_000 },
    { majorValue: 500, satang: 50_000 },
    { majorValue: 1_000, satang: 100_000 },
  ];
}

export function getSplitCashQuickPresetsForCountry(
  countryCode: CountryCode
): ReadonlyArray<{ majorValue: number; satang: Satang }> {
  if (countryCode === 'LA') {
    return [
      { majorValue: 20_000, satang: 2_000_000 },
      { majorValue: 50_000, satang: 5_000_000 },
      { majorValue: 100_000, satang: 10_000_000 },
    ];
  }
  return [
    { majorValue: 50, satang: 5_000 },
    { majorValue: 100, satang: 10_000 },
    { majorValue: 200, satang: 20_000 },
  ];
}

// ============================================================================
// Phase 5: Multi-Currency Cash Tender (`THB` / `USD` -> `LAK` Base Accounting)
// ============================================================================

export function normalizeFxRatesConfig(
  raw: unknown,
  countryCode: CountryCode
): FxRatesConfigDto {
  const base: FxRatesConfigDto = { ...DEFAULT_FX_RATES_CONFIG };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const rawThb = Math.round(Number(obj.thbToLakRate));
    const rawUsd = Math.round(Number(obj.usdToLakRate));
    if (Number.isSafeInteger(rawThb) && rawThb >= 1 && rawThb <= 10_000_000) {
      base.thbToLakRate = rawThb;
    }
    if (Number.isSafeInteger(rawUsd) && rawUsd >= 1 && rawUsd <= 100_000_000) {
      base.usdToLakRate = rawUsd;
    }
    base.enabled = countryCode === 'LA' && Boolean(obj.enabled);
  }
  if (countryCode !== 'LA') {
    base.enabled = false;
  }
  return base;
}

export function normalizeForeignTenderCurrency(
  raw: unknown
): ForeignTenderCurrencyCode | undefined {
  const up = String(raw ?? '').trim().toUpperCase();
  if (up === 'THB') return 'THB';
  if (up === 'USD') return 'USD';
  return undefined;
}

export function getFxRateForCurrency(
  fxRates: FxRatesConfigDto,
  currency: ForeignTenderCurrencyCode
): number {
  return currency === 'USD' ? fxRates.usdToLakRate : fxRates.thbToLakRate;
}

/**
 * Exact BigInt conversion from foreign cash tender (`THB` or `USD`, x100 minor units)
 * to whole Lao Kip (`LAK`, x100 minor units) using the store's integer rate (whole LAK per 1 unit).
 */
export function foreignMinorToBaseLakMinor(
  foreignMinor: Satang,
  rateWholeLakPerUnit: number
): Satang {
  if (!Number.isSafeInteger(foreignMinor) || foreignMinor < 0) {
    throw new RangeError(`foreignMinor must be a non-negative safe integer, got ${foreignMinor}`);
  }
  if (!Number.isSafeInteger(rateWholeLakPerUnit) || rateWholeLakPerUnit <= 0) {
    throw new RangeError(
      `rateWholeLakPerUnit must be a positive safe integer, got ${rateWholeLakPerUnit}`
    );
  }
  if (foreignMinor === 0) return 0;
  const wholeLak = roundDivBigInt(BigInt(foreignMinor) * BigInt(rateWholeLakPerUnit), 100n);
  return toSafeFixedPointNumber(wholeLak * 100n, 'foreignMinorToBaseLakMinor');
}

/**
 * Computes the minimum foreign currency amount (`x100` minor units, ceiling-rounded)
 * required so its converted LAK value covers `>= lakMinor`.
 */
export function baseLakMinorToRequiredForeignMinor(
  lakMinor: Satang,
  rateWholeLakPerUnit: number
): Satang {
  if (!Number.isSafeInteger(lakMinor) || lakMinor <= 0) {
    return 0;
  }
  if (!Number.isSafeInteger(rateWholeLakPerUnit) || rateWholeLakPerUnit <= 0) {
    throw new RangeError(
      `rateWholeLakPerUnit must be a positive safe integer, got ${rateWholeLakPerUnit}`
    );
  }
  const lakWhole = (BigInt(lakMinor) + 99n) / 100n;
  const rate = BigInt(rateWholeLakPerUnit);
  const foreignMinor = (lakWhole * 100n + rate - 1n) / rate;
  return toSafeFixedPointNumber(foreignMinor, 'baseLakMinorToRequiredForeignMinor');
}

/**
 * Formats an amount in `LAK`, `THB`, or `USD` (`x100` minor units) with currency symbol.
 */
export function formatForeignMoney(
  minorSatang: Satang,
  currency: CashTenderCurrencyCode
): string {
  if (currency === 'LAK') return formatMoney(minorSatang, 'LAK');
  if (currency === 'THB') return formatMoney(minorSatang, 'THB');
  const sign = minorSatang < 0 ? '-' : '';
  return `${sign}$${formatSatangToThbString(Math.abs(minorSatang))}`;
}

export function formatForeignAmountForInput(
  minorSatang: Satang,
  currency: CashTenderCurrencyCode
): string {
  if (currency === 'LAK') return formatMinorAmountForInput(minorSatang, 'LAK');
  return formatSatangToThbString(minorSatang).replace(/,/g, '');
}

export function getForeignQuickCashButtons(
  currency: ForeignTenderCurrencyCode
): ReadonlyArray<{ majorValue: number; satang: Satang; label: string }> {
  if (currency === 'USD') {
    return [
      { majorValue: 1, satang: 100, label: '$1' },
      { majorValue: 5, satang: 500, label: '$5' },
      { majorValue: 10, satang: 1_000, label: '$10' },
      { majorValue: 20, satang: 2_000, label: '$20' },
      { majorValue: 50, satang: 5_000, label: '$50' },
      { majorValue: 100, satang: 10_000, label: '$100' },
    ];
  }
  return [
    { majorValue: 20, satang: 2_000, label: '฿20' },
    { majorValue: 50, satang: 5_000, label: '฿50' },
    { majorValue: 100, satang: 10_000, label: '฿100' },
    { majorValue: 500, satang: 50_000, label: '฿500' },
    { majorValue: 1_000, satang: 100_000, label: '฿1,000' },
  ];
}

export function formatFxTenderReceiptLine(
  fx: FxCashTenderDetailDto,
  locale: LocaleCode = 'lo'
): string {
  const foreignStr = formatForeignMoney(fx.foreignAmountSatang, fx.currency);
  const rateStr = `${fx.exchangeRateWholeLak.toLocaleString('en-US')} ₭`;
  const equivStr = formatMoney(fx.equivalentBaseSatang, 'LAK');
  if (locale === 'lo') {
    return `ຮັບເງິນສົດ ${foreignStr} (@ ${rateStr}) = ${equivStr}`;
  }
  if (locale === 'en') {
    return `FX Cash ${foreignStr} (@ ${rateStr}) = ${equivStr}`;
  }
  return `รับเงินสด ${foreignStr} (@ ${rateStr}) = ${equivStr}`;
}
