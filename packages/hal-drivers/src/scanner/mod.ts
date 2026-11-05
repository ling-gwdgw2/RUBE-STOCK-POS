/**
 * RUBE-STOCK-POS v3.1 Physical Scancode Mapper & Dual-Mode Scale Barcode Parser (`SCANNER_HAL`)
 *
 * Solves:
 * 1. Thai Keyboard Layout Interference (`_-ๅ/-ภถุึคตจข` -> `8850123456789` via `KeyboardEvent.code`)
 * 2. First-Char Input Leakage Rollback when `< 50ms` inter-key cadence is detected
 * 3. Supermarket Scale Barcodes (Prefix `20`–`24` Weight-Embedded vs Prefix `25`–`29` Price-Embedded)
 */

import { type MilliUnit, type Satang, roundDiv } from '../../../shared-contracts/src/fixed-point.ts';

const PHYSICAL_CODE_MAP: Readonly<Record<string, string>> = {
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Numpad0: '0',
  Numpad1: '1',
  Numpad2: '2',
  Numpad3: '3',
  Numpad4: '4',
  Numpad5: '5',
  Numpad6: '6',
  Numpad7: '7',
  Numpad8: '8',
  Numpad9: '9',
  Minus: '-',
  NumpadSubtract: '-',
  KeyA: 'A',
  KeyB: 'B',
  KeyC: 'C',
  KeyD: 'D',
  KeyE: 'E',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyI: 'I',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  KeyM: 'M',
  KeyN: 'N',
  KeyO: 'O',
  KeyP: 'P',
  KeyQ: 'Q',
  KeyR: 'R',
  KeyS: 'S',
  KeyT: 'T',
  KeyU: 'U',
  KeyV: 'V',
  KeyW: 'W',
  KeyX: 'X',
  KeyY: 'Y',
  KeyZ: 'Z',
};

/**
 * Maps a sequence of physical `KeyboardEvent.code` values to an ASCII barcode string,
 * completely immune to Windows Thai Kedmanee/Pattachote keyboard layouts.
 */
export function decodePhysicalKeyCodesToBarcode(codes: readonly string[]): string {
  let result = '';
  for (const code of codes) {
    if (code === 'Enter' || code === 'NumpadEnter') break;
    const mapped = PHYSICAL_CODE_MAP[code];
    if (mapped !== undefined) {
      result += mapped;
    }
  }
  return result;
}

export interface ParsedScaleBarcode {
  isScaleBarcode: boolean;
  mode?: 'WEIGHT_EMBEDDED' | 'PRICE_EMBEDDED';
  prefix?: string;
  sku?: string;
  weightMilliKg?: MilliUnit;
  totalPriceSatang?: Satang;
  computedWeightMilliFromPrice?: MilliUnit;
  checkDigitValid?: boolean;
}

/**
 * Computes the standard GS1 EAN-13 Modulo-10 Check Digit from the first 12 digits.
 * Odd positions (1-indexed: 1,3,5,7,9,11 -> 0-indexed even: 0,2,4,6,8,10) have weight 1;
 * Even positions (1-indexed: 2,4,6,8,10,12 -> 0-indexed odd: 1,3,5,7,9,11) have weight 3.
 */
export function computeEan13CheckDigit(first12Digits: string): number {
  if (!/^\d{12}$/.test(first12Digits)) {
    throw new Error(`E_INVALID_EAN13_PAYLOAD: expected 12 digits, got '${first12Digits}'`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(first12Digits[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Verifies a 13-digit EAN-13 barcode against its Modulo-10 Check Digit.
 */
export function verifyEan13CheckDigit(barcode13: string): boolean {
  if (!/^\d{13}$/.test(barcode13)) return false;
  const expected = computeEan13CheckDigit(barcode13.slice(0, 12));
  return Number(barcode13[12]) === expected;
}

/**
 * Parses 13-digit EAN-13 Supermarket Scale Barcodes (`PP IIIII VVVVV C`):
 * - Prefix `20`–`24`: `VVVVV` is Weight in Grams (`Milli-Kilograms`, e.g., `01250` = 1.250 kg)
 * - Prefix `25`–`29`: `VVVVV` is Total Sticker Price in Satang (or Baht*100), computing weight from `unitPriceSatangPerKg`
 */
export function parseScaleBarcodeEan13(
  barcode: string,
  unitPriceSatangPerKg?: Satang,
  options?: { enforceCheckDigit?: boolean }
): ParsedScaleBarcode {
  if (!/^\d{13}$/.test(barcode)) {
    return { isScaleBarcode: false };
  }

  const checkDigitValid = verifyEan13CheckDigit(barcode);
  if (options?.enforceCheckDigit && !checkDigitValid) {
    return { isScaleBarcode: false, checkDigitValid: false };
  }

  const prefixNum = Number(barcode.slice(0, 2));
  if (prefixNum < 20 || prefixNum > 29) {
    return { isScaleBarcode: false, checkDigitValid };
  }

  const prefix = barcode.slice(0, 2);
  const sku = barcode.slice(2, 7);
  const embeddedValue = Number(barcode.slice(7, 12));

  if (prefixNum >= 20 && prefixNum <= 24) {
    return {
      isScaleBarcode: true,
      mode: 'WEIGHT_EMBEDDED',
      prefix,
      sku,
      weightMilliKg: embeddedValue, // 1 gram = 1 Milli-Kilogram
      checkDigitValid,
    };
  }

  // Prefix 25-29: Price-Embedded (embeddedValue in Satang, e.g., 22500 = 225.00 THB)
  const totalPriceSatang = embeddedValue;
  const computedWeightMilliFromPrice =
    unitPriceSatangPerKg && unitPriceSatangPerKg > 0
      ? roundDiv(BigInt(totalPriceSatang) * 1_000n, BigInt(unitPriceSatangPerKg))
      : undefined;

  return {
    isScaleBarcode: true,
    mode: 'PRICE_EMBEDDED',
    prefix,
    sku,
    totalPriceSatang,
    computedWeightMilliFromPrice,
    checkDigitValid,
  };
}
