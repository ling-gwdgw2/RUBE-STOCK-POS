/**
 * RUBE-STOCK-POS v3.1 Phase 0 Integration Assembly Checkpoint Test (`IMPLEMENTATION_PLAYBOOK.md` Section 4)
 *
 * Verifies:
 * 1. SQL DDL Schema v3.1 has all 26 tables and 3 immutable ledger triggers.
 * 2. Physical Barcode Scanner (`KeyboardEvent.code`) decodes digits accurately while keyboard is in Thai mode,
 *    and rolls back the leaked first character on `< 50ms` inter-key cadence.
 * 3. Dual-Mode Supermarket Scale Barcode Parser handles both Prefix `20-24` (Weight) and `25-29` (Price).
 * 4. Chunked 203-DPI Thermal Raster Printer (`GS v 0`) slices bands (`<= 96px`) and skips white rows (`ESC J`).
 * 5. Offline EMVCo PromptPay Dynamic QR CRC16-CCITT (`0x1021`) & BOT Slip Mini-QR deduplication + bank extraction.
 * 6. Virtual UPS Power-Loss (`AC_PRESENT=0`) & 14-Shift USB Flash Drive Ring-Buffer rotation.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  generateOfflinePromptPayDynamicQr,
  parseScaleBarcodeEan13,
  verifyOfflineBotSlipMiniQr,
  VirtualHardwareBench,
} from '../../packages/hal-drivers/src/index.ts';
import { PhysicalScannerStreamBuffer } from '../../packages/ui-presentation/src/hooks/usePhysicalScanner.ts';
import { resolveProfileFeatureFlags } from '../../packages/ui-presentation/src/profiles/profile-config.ts';

describe('Phase 0 Integration Assembly Checkpoint (v3.1)', () => {
  it('1. Validates 0001_initial_v3_1_schema.sql contains all 34 tables and 3 immutable triggers', () => {
    const sqlPath = resolve('packages/core-engine/migrations/0001_initial_v3_1_schema.sql');
    const sql = readFileSync(sqlPath, 'utf8');
    const tables = [...sql.matchAll(/CREATE\s+TABLE\s+([a-z_]+)/gi)].map((m) => m[1]);
    const triggers = [...sql.matchAll(/CREATE\s+TRIGGER\s+([a-z_]+)/gi)].map((m) => m[1]);

    assert.equal(tables.length, 34);
    assert.ok(tables.includes('pos_shifts'));
    assert.ok(tables.includes('cash_drawer_movements'));
    assert.equal(triggers.length, 3);
  });

  it('2. Decodes barcode immune to Thai layout and rolls back leaked first character in search input', () => {
    const scanner = new PhysicalScannerStreamBuffer(50, 4);
    let searchInputBoxValue = '';

    // Simulate scanning '8851952350161' while Windows keyboard is set to Thai ('_' leaked on 1st key)
    const codes = [
      'Digit8',
      'Digit8',
      'Digit5',
      'Digit1',
      'Digit9',
      'Digit5',
      'Digit2',
      'Digit3',
      'Digit5',
      'Digit0',
      'Digit1',
      'Digit6',
      'Digit1',
      'Enter',
    ];

    let timestamp = 1_000;
    let detectedBarcode: string | null = null;

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (i === 0) {
        // First keystroke leaks Thai char '_' into the active search input before we know it's a scanner
        searchInputBoxValue += '_';
      }
      const res = scanner.pushKeystroke({ code, timestampMs: timestamp }, () => {
        // First-Char Rollback callback triggered when 2nd key arrives in 12ms (< 50ms)
        searchInputBoxValue = searchInputBoxValue.slice(0, -1);
      });
      if (res.completedBarcode) {
        detectedBarcode = res.completedBarcode;
      }
      timestamp += 12; // 12ms per keystroke from USB barcode gun
    }

    assert.equal(detectedBarcode, '8851952350161');
    assert.equal(searchInputBoxValue, '', 'Leaked Thai character must be rolled back to empty string');
  });

  it('3. Parses both Weight-Embedded (Prefix 20-24) and Price-Embedded (Prefix 25-29) Scale Barcodes', () => {
    // Prefix 20: SKU 10045, Weight 01250g (1.250 kg)
    const weightParsed = parseScaleBarcodeEan13('2010045012507');
    assert.equal(weightParsed.isScaleBarcode, true);
    assert.equal(weightParsed.mode, 'WEIGHT_EMBEDDED');
    assert.equal(weightParsed.sku, '10045');
    assert.equal(weightParsed.weightMilliKg, 1_250);

    // Prefix 25: SKU 10045, Total Price 270.00 THB (27000 satang), Unit Price 180.00 THB/kg (18000 satang) -> 1.500 kg
    const priceParsed = parseScaleBarcodeEan13('2510045270004', 18_000);
    assert.equal(priceParsed.isScaleBarcode, true);
    assert.equal(priceParsed.mode, 'PRICE_EMBEDDED');
    assert.equal(priceParsed.sku, '10045');
    assert.equal(priceParsed.totalPriceSatang, 27_000);
    assert.equal(priceParsed.computedWeightMilliFromPrice, 1_500);
  });

  it('4. Chunks 203-DPI Thermal Receipt bitmap into safe bands and skips whitespace with ESC J', () => {
    const bench = new VirtualHardwareBench();
    const printResult = bench.simulateThermalReceiptPrint(600);

    assert.equal(printResult.widthPx, 576);
    assert.ok(printResult.packetCount >= 6);
    // Each 96-dot band on 576px (72 bytes/row) is 8 + (72 * 96) = 6,920 bytes (< 8KB printer buffer!)
    assert.ok(
      printResult.maxPacketBytes <= 7_000,
      `Expected packet size <= 7000 bytes to prevent buffer overflow, got ${printResult.maxPacketBytes}`
    );
  });

  it('5. Generates Offline EMVCo PromptPay QR and blocks duplicate/invalid slips via BOT Mini-QR', () => {
    const qr = generateOfflinePromptPayDynamicQr('0812345678', 6_500);
    assert.ok(qr.payload.startsWith('000201010212'));
    assert.ok(qr.payload.includes('540565.00'));
    assert.equal(qr.crcHex.length, 4);

    const usedSlips = new Set<string>();
    const validBotSlip = '0041000600000101030040220202611051234567890AB5102TH';

    // 1st scan: valid & fresh, extracts KBANK (004) and last 4 of TransRef for Visual Amount Check
    const firstCheck = verifyOfflineBotSlipMiniQr(validBotSlip, 6_500, usedSlips);
    assert.equal(firstCheck.validFormat, true);
    assert.equal(firstCheck.isDuplicate, false);
    assert.equal(firstCheck.senderBankCode, '004');
    assert.ok(firstCheck.senderBankNameThai.includes('กสิกรไทย'));
    assert.equal(firstCheck.transRefLast4, '90AB');
    assert.equal(firstCheck.requiresVisualAmountConfirmation, true);

    // 2nd scan of the same slip: blocked immediately as Duplicate Slip Fraud!
    const secondCheck = verifyOfflineBotSlipMiniQr(validBotSlip, 6_500, usedSlips);
    assert.equal(secondCheck.validFormat, true);
    assert.equal(secondCheck.isDuplicate, true);
  });

  it('6. Simulates UPS Power-Loss checkpoint and 14-Shift USB Ring-Buffer rotation', () => {
    const bench = new VirtualHardwareBench();
    const upsEvent = bench.simulateUpsPowerLoss(20);
    assert.equal(upsEvent.acPresent, false);
    assert.equal(upsEvent.triggeredWalCheckpoint, true);
    assert.equal(upsEvent.triggeredEmergencyUsbBackup, true);

    // Write 16 shift backups -> ring buffer must retain exactly 14 and evict the oldest
    let lastEvent = bench.simulateAtomicUsbShiftBackup('20261105_shift01');
    for (let s = 2; s <= 16; s++) {
      lastEvent = bench.simulateAtomicUsbShiftBackup(`20261105_shift${String(s).padStart(2, '0')}`);
    }
    assert.equal(lastEvent.retainedRingFilesCount, 14);
    assert.equal(lastEvent.evictedOldestFilename, 'rube_backup_20261105_shift02.db.enc');

    // Verify Polymorphic Business Profiles
    assert.equal(resolveProfileFeatureFlags('RETAIL').enableScaleBarcodeParser, true);
    assert.equal(resolveProfileFeatureFlags('HOSPITALITY').enableRoleBasedModifiers, true);
  });
});
