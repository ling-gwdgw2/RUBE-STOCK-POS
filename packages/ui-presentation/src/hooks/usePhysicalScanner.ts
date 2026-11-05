/**
 * RUBE-STOCK-POS v3.1 Physical Scanner Buffer with First-Char Input Leakage Rollback (`usePhysicalScanner.ts`)
 *
 * Solves `ARCHITECTURE.md` Section 6.1.2:
 * - Decodes physical `KeyboardEvent.code` (`Digit0`..`Digit9`) instead of `.key` so Thai layout (`_-ๅ/-ภถ`) never corrupts barcodes.
 * - Rolls back the leaked first character from a focused input element the instant a `< 50ms` second keystroke arrives.
 */

import { decodePhysicalKeyCodesToBarcode } from '../../../hal-drivers/src/scanner/mod.ts';

export interface KeystrokeSample {
  code: string;
  timestampMs: number;
}

export class PhysicalScannerStreamBuffer {
  private bufferCodes: string[] = [];
  private lastKeyTimestampMs = 0;
  private rolledBackFirstLeakedChar = false;
  private readonly interKeyThresholdMs: number;
  private readonly minBarcodeLength: number;

  constructor(interKeyThresholdMs: number = 50, minBarcodeLength: number = 4) {
    this.interKeyThresholdMs = interKeyThresholdMs;
    this.minBarcodeLength = minBarcodeLength;
  }

  public pushKeystroke(
    sample: KeystrokeSample,
    onRollbackFirstChar?: () => void
  ): { completedBarcode: string | null; shouldPreventDefault: boolean } {
    const deltaMs = sample.timestampMs - this.lastKeyTimestampMs;

    if (this.bufferCodes.length > 0 && deltaMs > this.interKeyThresholdMs) {
      // Previous keystroke was manual human typing, reset buffer
      this.bufferCodes = [];
      this.rolledBackFirstLeakedChar = false;
    }

    this.lastKeyTimestampMs = sample.timestampMs;

    if (sample.code === 'Enter' || sample.code === 'NumpadEnter') {
      if (this.bufferCodes.length >= this.minBarcodeLength) {
        const barcode = decodePhysicalKeyCodesToBarcode(this.bufferCodes);
        this.bufferCodes = [];
        this.rolledBackFirstLeakedChar = false;
        return { completedBarcode: barcode, shouldPreventDefault: true };
      }
      this.bufferCodes = [];
      this.rolledBackFirstLeakedChar = false;
      return { completedBarcode: null, shouldPreventDefault: false };
    }

    this.bufferCodes.push(sample.code);

    // When the 2nd character arrives within `< 50ms`, roll back the 1st character that leaked into `<input>`
    if (this.bufferCodes.length === 2 && !this.rolledBackFirstLeakedChar) {
      this.rolledBackFirstLeakedChar = true;
      onRollbackFirstChar?.();
    }

    return {
      completedBarcode: null,
      shouldPreventDefault: this.bufferCodes.length >= 2,
    };
  }
}

