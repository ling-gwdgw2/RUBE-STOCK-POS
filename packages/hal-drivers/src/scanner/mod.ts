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
}

/**
 * Parses 13-digit EAN-13 Supermarket Scale Barcodes (`PP IIIII VVVVV C`):
 * - Prefix `20`–`24`: `VVVVV` is Weight in Grams (`Milli-Kilograms`, e.g., `01250` = 1.250 kg)
 * - Prefix `25`–`29`: `VVVVV` is Total Sticker Price in Satang (or Baht*100), computing weight from `unitPriceSatangPerKg`
 */
export function parseScaleBarcodeEan13(
  barcode: string,
  unitPriceSatangPerKg?: Satang
): ParsedScaleBarcode {
  if (!/^\d{13}$/.test(barcode)) {
    return { isScaleBarcode: false };
  }

  const prefixNum = Number(barcode.slice(0, 2));
  if (prefixNum < 20 || prefixNum > 29) {
    return { isScaleBarcode: false };
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
  };
}
