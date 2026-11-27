/**
 * RUBE-STOCK-POS v3.1 Pure Offline 1D Barcode Encoders (`BARCODE_HAL`)
 *
 * Implements standard-compliant, deterministic binary module generators:
 * - GS1 EAN-13 (with Modulo-10 Check Digit computation & verification)
 * - GS1 EAN-8 (with Modulo-10 Check Digit computation & verification)
 * - Code 128 Auto (Code C 2-digit numeric compression + Code B full ASCII 32..126)
 * - Dual-Mode Scale EAN-13 Label Builder (Prefix 20–24 Weight, Prefix 25–29 Price)
 *
 * Zero external CDN dependencies, zero `parseFloat`, 100% offline & Node/Browser compatible.
 */

import type { BarcodeSymbology } from '../../../shared-contracts/src/barcode-printing.ts';
import {
  roundDivBigInt,
  type MilliUnit,
  type Satang,
} from '../../../shared-contracts/src/fixed-point.ts';
import { computeEan13CheckDigit, verifyEan13CheckDigit } from '../scanner/mod.ts';

export type Resolved1DBarcodeFormat = 'EAN_13' | 'EAN_8' | 'CODE_128';

export interface BarcodeModuleEncoding {
  readonly format: Resolved1DBarcodeFormat;
  readonly normalizedValue: string;
  readonly displayDigits: string;
  /**
   * Array of modules where `1` = black bar, `0` = white space.
   * Excludes leading/trailing quiet zones (stored separately in `quietZoneModules`).
   */
  readonly modules: readonly (0 | 1)[];
  /**
   * Same length as `modules`: `true` for EAN guard bars (start/center/end)
   * so renderers can extend guard bars slightly downward when rendering EAN-13/EAN-8.
   */
  readonly guardMask: readonly boolean[];
  readonly quietZoneModules: number;
}

const EAN_L_CODES: readonly string[] = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];

const EAN_G_CODES: readonly string[] = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];

const EAN_R_CODES: readonly string[] = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];

const EAN13_PARITY_PATTERNS: readonly string[] = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

/**
 * Standard Code 128 symbol width table (indices 0..106).
 * Each string lists alternating bar/space module widths (1..4); symbol 106 (STOP) has 7 elements (13 modules).
 */
const CODE128_WIDTH_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

function appendBitString(
  bits: string,
  isGuard: boolean,
  modulesOut: (0 | 1)[],
  guardMaskOut: boolean[]
): void {
  for (let i = 0; i < bits.length; i += 1) {
    modulesOut.push(bits[i] === '1' ? 1 : 0);
    guardMaskOut.push(isGuard);
  }
}

function expandWidthPatternToBits(widthPattern: string): string {
  let out = '';
  for (let i = 0; i < widthPattern.length; i += 1) {
    const count = Number(widthPattern[i]);
    const bitChar = i % 2 === 0 ? '1' : '0';
    for (let c = 0; c < count; c += 1) {
      out += bitChar;
    }
  }
  return out;
}

/**
 * Computes the standard GS1 EAN-8 Modulo-10 check digit from the first 7 digits.
 */
export function computeEan8CheckDigit(first7Digits: string): number {
  if (!/^\d{7}$/.test(first7Digits)) {
    throw new Error(`E_INVALID_EAN8_PAYLOAD: expected 7 digits, got '${first7Digits}'`);
  }
  let sum = 0;
  for (let i = 0; i < 7; i += 1) {
    const digit = Number(first7Digits[i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function verifyEan8CheckDigit(barcode8: string): boolean {
  if (!/^\d{8}$/.test(barcode8)) return false;
  return Number(barcode8[7]) === computeEan8CheckDigit(barcode8.slice(0, 7));
}

/**
 * Encodes a 12- or 13-digit numeric value as a standard 95-module GS1 EAN-13 barcode.
 */
export function encodeEan13Modules(raw: string): BarcodeModuleEncoding {
  const digits = raw.trim();
  let normalized = digits;
  if (/^\d{12}$/.test(digits)) {
    normalized = `${digits}${computeEan13CheckDigit(digits)}`;
  } else if (/^\d{13}$/.test(digits)) {
    if (!verifyEan13CheckDigit(digits)) {
      throw new Error(
        `E_INVALID_EAN13_CHECKDIGIT: barcode '${digits}' failed GS1 Modulo-10 check digit`
      );
    }
  } else {
    throw new Error(`E_INVALID_EAN13_LENGTH: expected 12 or 13 digits, got '${raw}'`);
  }

  const firstDigit = Number(normalized[0]);
  const parity = EAN13_PARITY_PATTERNS[firstDigit]!;
  const modules: (0 | 1)[] = [];
  const guardMask: boolean[] = [];

  appendBitString('101', true, modules, guardMask);
  for (let i = 1; i <= 6; i += 1) {
    const d = Number(normalized[i]);
    const pat = parity[i - 1] === 'G' ? EAN_G_CODES[d]! : EAN_L_CODES[d]!;
    appendBitString(pat, false, modules, guardMask);
  }
  appendBitString('01010', true, modules, guardMask);
  for (let i = 7; i <= 12; i += 1) {
    const d = Number(normalized[i]);
    appendBitString(EAN_R_CODES[d]!, false, modules, guardMask);
  }
  appendBitString('101', true, modules, guardMask);

  return {
    format: 'EAN_13',
    normalizedValue: normalized,
    displayDigits: normalized,
    modules,
    guardMask,
    quietZoneModules: 11,
  };
}

/**
 * Encodes a 7- or 8-digit numeric value as a standard 67-module GS1 EAN-8 barcode.
 */
export function encodeEan8Modules(raw: string): BarcodeModuleEncoding {
  const digits = raw.trim();
  let normalized = digits;
  if (/^\d{7}$/.test(digits)) {
    normalized = `${digits}${computeEan8CheckDigit(digits)}`;
  } else if (/^\d{8}$/.test(digits)) {
    if (!verifyEan8CheckDigit(digits)) {
      throw new Error(
        `E_INVALID_EAN8_CHECKDIGIT: barcode '${digits}' failed GS1 Modulo-10 check digit`
      );
    }
  } else {
    throw new Error(`E_INVALID_EAN8_LENGTH: expected 7 or 8 digits, got '${raw}'`);
  }

  const modules: (0 | 1)[] = [];
  const guardMask: boolean[] = [];

  appendBitString('101', true, modules, guardMask);
  for (let i = 0; i < 4; i += 1) {
    const d = Number(normalized[i]);
    appendBitString(EAN_L_CODES[d]!, false, modules, guardMask);
  }
  appendBitString('01010', true, modules, guardMask);
  for (let i = 4; i < 8; i += 1) {
    const d = Number(normalized[i]);
    appendBitString(EAN_R_CODES[d]!, false, modules, guardMask);
  }
  appendBitString('101', true, modules, guardMask);

  return {
    format: 'EAN_8',
    normalizedValue: normalized,
    displayDigits: normalized,
    modules,
    guardMask,
    quietZoneModules: 7,
  };
}

function countLeadingDigits(text: string, startIndex: number): number {
  let count = 0;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch >= 48 && ch <= 57) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Encodes any printable ASCII string (code points 32..126) into Code 128 Auto (B + C subsets).
 * Automatically uses Code C (2 digits per symbol) for long numeric runs.
 */
export function encodeCode128Modules(rawValue: string): BarcodeModuleEncoding {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error('E_EMPTY_CODE128_VALUE: barcode value cannot be empty');
  }

  let sanitized = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new Error(
        `E_INVALID_CODE128_CHAR: character '${trimmed[i]}' is outside printable ASCII (32..126)`
      );
    }
    sanitized += trimmed[i];
  }

  const symbolCodes: number[] = [];
  let idx = 0;
  const initialDigits = countLeadingDigits(sanitized, 0);
  const startInC = initialDigits >= 4 || (initialDigits >= 2 && initialDigits === sanitized.length);
  let mode: 'B' | 'C' = startInC ? 'C' : 'B';
  symbolCodes.push(mode === 'C' ? 105 : 104);

  while (idx < sanitized.length) {
    if (mode === 'C') {
      const remDigits = countLeadingDigits(sanitized, idx);
      if (remDigits >= 2) {
        const pairVal = Number(sanitized.slice(idx, idx + 2));
        symbolCodes.push(pairVal);
        idx += 2;
      } else {
        symbolCodes.push(100); // Switch to Code B
        mode = 'B';
      }
      continue;
    }

    const runDigits = countLeadingDigits(sanitized, idx);
    if (runDigits >= 4 && runDigits % 2 === 0) {
      symbolCodes.push(99); // Switch to Code C
      mode = 'C';
      continue;
    }
    if (runDigits >= 5) {
      // Emit 1 digit in Code B so remaining even run enters Code C
      symbolCodes.push(sanitized.charCodeAt(idx) - 32);
      idx += 1;
      symbolCodes.push(99);
      mode = 'C';
      continue;
    }

    symbolCodes.push(sanitized.charCodeAt(idx) - 32);
    idx += 1;
  }

  // Modulo-103 Checksum
  let checksum = symbolCodes[0]!;
  for (let pos = 1; pos < symbolCodes.length; pos += 1) {
    checksum += symbolCodes[pos]! * pos;
  }
  symbolCodes.push(checksum % 103);
  symbolCodes.push(106); // STOP

  const modules: (0 | 1)[] = [];
  const guardMask: boolean[] = [];
  for (const sym of symbolCodes) {
    const widthPat = CODE128_WIDTH_PATTERNS[sym]!;
    const bitStr = expandWidthPatternToBits(widthPat);
    appendBitString(bitStr, false, modules, guardMask);
  }

  return {
    format: 'CODE_128',
    normalizedValue: sanitized,
    displayDigits: sanitized,
    modules,
    guardMask,
    quietZoneModules: 10,
  };
}

/**
 * Resolves a product barcode or SKU into an encoded 1D module pattern.
 * In `AUTO` mode:
 * - Valid 13-digit EAN-13 (or 12-digit numeric) -> `EAN_13`
 * - Valid 8-digit EAN-8 -> `EAN_8`
 * - Everything else (or invalid check digit numeric strings) -> `CODE_128`
 */
export function resolveBarcodeEncoding(
  rawValue: string,
  preferredSymbology: BarcodeSymbology = 'AUTO'
): BarcodeModuleEncoding {
  const clean = rawValue.trim();
  if (!clean) {
    throw new Error('E_EMPTY_BARCODE: no barcode or SKU provided');
  }

  if (preferredSymbology === 'EAN_13') {
    return encodeEan13Modules(clean);
  }
  if (preferredSymbology === 'EAN_8') {
    return encodeEan8Modules(clean);
  }
  if (preferredSymbology === 'CODE_128') {
    return encodeCode128Modules(clean);
  }

  // AUTO resolution
  if (/^\d{13}$/.test(clean) && verifyEan13CheckDigit(clean)) {
    return encodeEan13Modules(clean);
  }
  if (/^\d{12}$/.test(clean)) {
    return encodeEan13Modules(clean);
  }
  if (/^\d{8}$/.test(clean) && verifyEan8CheckDigit(clean)) {
    return encodeEan8Modules(clean);
  }

  return encodeCode128Modules(clean);
}

let internalEan13Seq = 0;

/**
 * Returns the store's internal EAN-13 prefix by country:
 * - `'TH'`: `'885999'` (Thailand internal store range)
 * - `'LA'`: `'029999'` (GS1 Restricted Circulation in-store prefix, safely outside 20–29 scale range)
 */
export function getInternalEan13PrefixForCountry(countryCode: 'TH' | 'LA'): string {
  return countryCode === 'LA' ? '029999' : '885999';
}

/**
 * Generates a collision-free valid GS1 internal EAN-13 barcode (default prefix `885999` for Thailand store tags)
 * with a true Modulo-10 check digit verified by `verifyEan13CheckDigit`.
 */
export function generateValidInternalEan13(
  existingBarcodes?: ReadonlySet<string>,
  prefix = '885999'
): string {
  const cleanPrefix = prefix.replace(/\D/g, '').slice(0, 6).padEnd(6, '9');
  const neededBodyLen = 12 - cleanPrefix.length;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    internalEan13Seq = (internalEan13Seq + 1) % 1_000_000;
    const mixed = Date.now() + internalEan13Seq * 7919 + Math.floor(Math.random() * 1_000_000) + attempt;
    const body = String(mixed).slice(-neededBodyLen).padStart(neededBodyLen, '0');
    const first12 = `${cleanPrefix}${body}`;
    const checkDigit = computeEan13CheckDigit(first12);
    const candidate = `${first12}${checkDigit}`;
    if (!existingBarcodes || !existingBarcodes.has(candidate)) {
      return candidate;
    }
  }

  internalEan13Seq = (internalEan13Seq + 1) % 1_000_000;
  const fallback12 = `${cleanPrefix}${String((internalEan13Seq + Math.floor(Math.random() * 999_999)) % 1_000_000).padStart(neededBodyLen, '0')}`;
  return `${fallback12}${computeEan13CheckDigit(fallback12)}`;
}

/**
 * Builds a valid 13-digit GS1 Scale EAN-13 barcode (`PP IIIII VVVVV C`) with Modulo-10 check digit,
 * matching `parseScaleBarcodeEan13` in `hal-drivers/src/scanner/mod.ts`.
 */
export function buildScaleBarcodeEan13(params: {
  mode: 'WEIGHT_EMBEDDED' | 'PRICE_EMBEDDED';
  skuOrPlu: string;
  weightMilliKg?: MilliUnit | undefined;
  totalPriceSatang?: Satang | undefined;
  priceEmbeddedMultiplier?: number | undefined;
  prefix?: string | undefined;
}): string {
  const rawDigits = params.skuOrPlu.replace(/\D/g, '');
  if (!rawDigits) {
    throw new Error(
      `E_INVALID_SCALE_PLU: SKU '${params.skuOrPlu}' must contain at least 1 digit for Scale EAN-13`
    );
  }
  const pluDigits = rawDigits.slice(-5).padStart(5, '0');
  const prefix =
    params.prefix && /^\d{2}$/.test(params.prefix)
      ? params.prefix
      : params.mode === 'WEIGHT_EMBEDDED'
        ? '20'
        : '25';

  let embeddedValue = 0;
  if (params.mode === 'WEIGHT_EMBEDDED') {
    const w = Math.trunc(params.weightMilliKg ?? 0);
    if (w <= 0 || w > 99_999) {
      throw new RangeError(
        `E_SCALE_WEIGHT_OUT_OF_RANGE: weightMilliKg (${w}) must be between 1 and 99999 (0.001–99.999 kg)`
      );
    }
    embeddedValue = w;
  } else {
    const mult =
      params.priceEmbeddedMultiplier &&
      Number.isSafeInteger(params.priceEmbeddedMultiplier) &&
      params.priceEmbeddedMultiplier > 0
        ? params.priceEmbeddedMultiplier
        : 1;
    const totalSatang = Math.trunc(params.totalPriceSatang ?? 0);
    const unitsBig = roundDivBigInt(BigInt(Math.max(0, totalSatang)), BigInt(mult));
    if (unitsBig <= 0n || unitsBig > 99_999n) {
      throw new RangeError(
        `E_SCALE_PRICE_OUT_OF_RANGE: embedded price units (${unitsBig}) must be between 1 and 99999`
      );
    }
    embeddedValue = Number(unitsBig);
  }

  const first12 = `${prefix}${pluDigits}${String(embeddedValue).padStart(5, '0')}`;
  return `${first12}${computeEan13CheckDigit(first12)}`;
}
