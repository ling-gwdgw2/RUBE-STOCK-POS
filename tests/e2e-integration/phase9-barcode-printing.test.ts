/**
 * RUBE-STOCK-POS v3.1 Product Barcode Printing System E2E & Verification Suite
 *
 * Verifies:
 * 1. Pure 1D Barcode Encoders (`EAN_13`, `EAN_8`, `CODE_128`, Scale `20..29`) + Round-Trip ZXing Scanner Decoding
 * 2. TSPL2, ZPL II, and ESC/POS 203-DPI Thermal Label Wire Generators (polarity, dimensions, batch copies, <= 8KB packets)
 * 3. Server APIs (`/api/bootstrap`, `/api/warehouse/barcode-label-config`, `/api/warehouse/print-barcode-labels`,
 *    `/api/printer/windows-list` for WAREHOUSE role, and RBAC enforcement)
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import {
  buildScaleBarcodeEan13,
  encodeCode128Modules,
  encodeEan13Modules,
  encodeEan8Modules,
  generateValidInternalEan13,
  getInternalEan13PrefixForCountry,
  resolveBarcodeEncoding,
  type BarcodeModuleEncoding,
} from '../../packages/hal-drivers/src/barcode/mod.ts';
import {
  buildEscPosLabelBatchWirePayload,
  buildTsplLabelBatchWirePayload,
  buildZplLabelBatchWirePayload,
} from '../../packages/hal-drivers/src/printer/barcode-label.ts';
import {
  matchesScaleBarcodePlu,
  parseScaleBarcodeEan13,
  verifyEan13CheckDigit,
} from '../../packages/hal-drivers/src/scanner/mod.ts';
import {
  BARCODE_LABEL_SIZE_PRESETS,
  normalizeBarcodeLabelConfig,
} from '../../packages/shared-contracts/src/barcode-printing.ts';
import { RubePosInteractiveAppServer } from '../../packages/ui-presentation/src/server/pos-desktop-server.ts';

function decodeModulesWithZxing(encoding: BarcodeModuleEncoding): {
  text: string;
  format: BarcodeFormat;
} {
  const scaleX = 3;
  const height = 64;
  const qz = encoding.quietZoneModules;
  const width = (encoding.modules.length + qz * 2) * scaleX;
  const luminances = new Uint8ClampedArray(width * height);
  luminances.fill(255);

  for (let m = 0; m < encoding.modules.length; m += 1) {
    if (encoding.modules[m] === 1) {
      const xStart = (qz + m) * scaleX;
      for (let y = 6; y < height - 6; y += 1) {
        const rowBase = y * width;
        for (let dx = 0; dx < scaleX; dx += 1) {
          luminances[rowBase + xStart + dx] = 0;
        }
      }
    }
  }

  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.CODE_128,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);

  const source = new RGBLuminanceSource(luminances, width, height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const result = reader.decodeWithState(bitmap);
  return {
    text: result.getText(),
    format: result.getBarcodeFormat(),
  };
}

describe('Product Barcode Label Printing System (Phase 9 E2E)', () => {
  it('encodes EAN-13, EAN-8, Code 128, and Scale EAN-13 barcodes that round-trip decode cleanly via ZXing', () => {
    // 1. EAN-13 (existing Thai retail water bottle + 12-digit auto check digit)
    const ean13 = encodeEan13Modules('8851952350161');
    assert.equal(ean13.modules.length, 95);
    const decodedEan13 = decodeModulesWithZxing(ean13);
    assert.equal(decodedEan13.text, '8851952350161');
    assert.equal(decodedEan13.format, BarcodeFormat.EAN_13);

    const ean13From12 = encodeEan13Modules('885999000123');
    assert.ok(verifyEan13CheckDigit(ean13From12.normalizedValue));
    assert.equal(decodeModulesWithZxing(ean13From12).text, ean13From12.normalizedValue);

    // 2. EAN-8
    const ean8 = encodeEan8Modules('9638507');
    assert.equal(ean8.modules.length, 67);
    const decodedEan8 = decodeModulesWithZxing(ean8);
    assert.equal(decodedEan8.text, ean8.normalizedValue);
    assert.equal(decodedEan8.format, BarcodeFormat.EAN_8);

    // 3. Code 128 Auto (alphanumeric SKUs & numeric runs)
    for (const sku of ['SKU-YUZU-01', 'CAFE-MT-16', 'RAW-TEA-01', 'A12345678B', '0011223344']) {
      const c128 = encodeCode128Modules(sku);
      const decoded = decodeModulesWithZxing(c128);
      assert.equal(decoded.text, sku);
      assert.equal(decoded.format, BarcodeFormat.CODE_128);
    }

    // 4. Scale EAN-13 weight & price embedded -> verify compatibility with SCANNER_HAL parser
    const weightBarcode = buildScaleBarcodeEan13({
      mode: 'WEIGHT_EMBEDDED',
      skuOrPlu: '10045',
      weightMilliKg: 1_250,
    });
    assert.ok(verifyEan13CheckDigit(weightBarcode));
    assert.equal(decodeModulesWithZxing(resolveBarcodeEncoding(weightBarcode, 'AUTO')).text, weightBarcode);
    const parsedWeight = parseScaleBarcodeEan13(weightBarcode, 18_000);
    assert.equal(parsedWeight.isScaleBarcode, true);
    assert.equal(parsedWeight.mode, 'WEIGHT_EMBEDDED');
    assert.equal(parsedWeight.sku, '10045');
    assert.equal(parsedWeight.weightMilliKg, 1_250);

    const priceBarcode = buildScaleBarcodeEan13({
      mode: 'PRICE_EMBEDDED',
      skuOrPlu: '10045',
      totalPriceSatang: 22_500,
      priceEmbeddedMultiplier: 1,
    });
    assert.ok(verifyEan13CheckDigit(priceBarcode));
    assert.equal(decodeModulesWithZxing(resolveBarcodeEncoding(priceBarcode, 'AUTO')).text, priceBarcode);
    const parsedPrice = parseScaleBarcodeEan13(priceBarcode, 18_000);
    assert.equal(parsedPrice.isScaleBarcode, true);
    assert.equal(parsedPrice.mode, 'PRICE_EMBEDDED');
    assert.equal(parsedPrice.totalPriceSatang, 22_500);

    // 5. Internal EAN-13 generator collision avoidance, country prefixes & check-digit validity
    const existing = new Set<string>(['8851952350161']);
    assert.equal(getInternalEan13PrefixForCountry('TH'), '885999');
    assert.equal(getInternalEan13PrefixForCountry('LA'), '029999');
    const gen1 = generateValidInternalEan13(existing, getInternalEan13PrefixForCountry('TH'));
    assert.ok(verifyEan13CheckDigit(gen1));
    assert.ok(gen1.startsWith('885999'));
    assert.equal(existing.has(gen1), false);

    const genLa = generateValidInternalEan13(existing, getInternalEan13PrefixForCountry('LA'));
    assert.ok(verifyEan13CheckDigit(genLa));
    assert.ok(genLa.startsWith('029999'));

    // 6. Scale PLU padded SKU matching & strict range validation
    assert.equal(matchesScaleBarcodePlu({ sku: 'SKU-45' }, '00045'), true);
    assert.equal(matchesScaleBarcodePlu({ sku: '10045' }, '10045'), true);
    assert.equal(matchesScaleBarcodePlu({ sku: 'SKU-46' }, '00045'), false);
    assert.equal(matchesScaleBarcodePlu({ sku: 'ALT-1', barcode: '88500045' }, '00045'), true);
    assert.throws(
      () =>
        buildScaleBarcodeEan13({
          mode: 'PRICE_EMBEDDED',
          skuOrPlu: '10045',
          totalPriceSatang: 100_000,
          priceEmbeddedMultiplier: 1,
        }),
      RangeError
    );
    assert.throws(
      () =>
        buildScaleBarcodeEan13({
          mode: 'WEIGHT_EMBEDDED',
          skuOrPlu: '10045',
          weightMilliKg: 100_000,
        }),
      RangeError
    );
  });

  it('builds valid TSPL2 (inverted active-low bitmap), ZPL II (^GFA hex), and chunked ESC/POS label payloads', () => {
    // 16px wide (2 bytes/row) x 4px tall synthetic 1-bit monochrome bitmap (1 = black dot)
    const widthPx = 16;
    const heightPx = 4;
    const bitmap = new Uint8Array([0xff, 0x00, 0xaa, 0x55, 0xf0, 0x0f, 0x00, 0xff]);

    // TSPL2: verify SIZE/GAP/BITMAP/PRINT and bit inversion (0xff -> 0x00, 0x00 -> 0xff)
    const tsplBytes = buildTsplLabelBatchWirePayload([
      {
        packedMonochromeBitmap: bitmap,
        widthPx,
        heightPx,
        labelWidthMm: 50,
        labelHeightMm: 30,
        gapMm: 2,
        copies: 3,
      },
    ]);
    const tsplPrefixText = new TextDecoder().decode(tsplBytes.subarray(0, 120));
    assert.ok(tsplPrefixText.includes('SIZE 50 mm,30 mm'));
    assert.ok(tsplPrefixText.includes('GAP 2 mm,0 mm'));
    assert.ok(tsplPrefixText.includes('BITMAP 0,0,2,4,0,'));
    const marker = Buffer.from('BITMAP 0,0,2,4,0,', 'ascii');
    const markerIdx = Buffer.from(tsplBytes).indexOf(marker);
    assert.ok(markerIdx >= 0);
    const wireBitmapStart = markerIdx + marker.length;
    const wireBitmapSlice = tsplBytes.subarray(wireBitmapStart, wireBitmapStart + bitmap.length);
    for (let i = 0; i < bitmap.length; i += 1) {
      assert.equal(wireBitmapSlice[i], bitmap[i]! ^ 0xff);
    }
    const tsplTailText = new TextDecoder().decode(tsplBytes.subarray(wireBitmapStart + bitmap.length));
    assert.ok(tsplTailText.includes('PRINT 3,1'));

    // ZPL II: verify ^XA / ^PW / ^LL / ^GFA hex / ^PQ / ^XZ
    const zplBytes = buildZplLabelBatchWirePayload([
      {
        packedMonochromeBitmap: bitmap,
        widthPx,
        heightPx,
        labelWidthMm: 50,
        labelHeightMm: 30,
        copies: 4,
      },
    ]);
    const zplText = new TextDecoder().decode(zplBytes);
    assert.ok(zplText.includes('^XA'));
    assert.ok(zplText.includes('^PW16'));
    assert.ok(zplText.includes('^LL4'));
    assert.ok(zplText.includes('^FO0,0^GFA,8,8,2,FF00AA55F00F00FF^FS'));
    assert.ok(zplText.includes('^PQ4,0,1,Y'));
    assert.ok(zplText.includes('^XZ'));

    // ESC/POS 80mm receipt printer (576px = 72 bytes/row)
    const escBitmap = new Uint8Array(72 * 280);
    escBitmap.fill(0x81);
    const escJob = buildEscPosLabelBatchWirePayload([
      {
        packedMonochromeBitmap: escBitmap,
        widthPx: 576,
        heightPx: 280,
        labelWidthMm: 72,
        labelHeightMm: 35,
        copies: 2,
      },
    ]);
    assert.ok(escJob.packetsCount >= 2);
    assert.ok(escJob.maxPacketByteLength <= 8_192);
    assert.ok(escJob.wirePayloadBytes.byteLength > escBitmap.byteLength);

    // Every thermal/receipt preset width must be a multiple of 8px for 203-DPI byte packing
    for (const preset of BARCODE_LABEL_SIZE_PRESETS) {
      assert.equal(preset.widthPx203Dpi % 8, 0, `Preset ${preset.id} widthPx must be divisible by 8`);
    }
  });

  it('persists barcode label config, enforces RBAC, and executes print-barcode-labels API end-to-end', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rube-barcode-print-'));
    const dbPath = path.join(tmpDir, 'rube_barcode.db');
    const appServer = new RubePosInteractiveAppServer({
      dbPath,
      enforceApiSessionAuth: true,
    });
    const { url } = await appServer.start(0, '127.0.0.1');

    try {
      // Login as OWNER (default seeded PIN 999999) and check WAREHOUSE / CASHIER roles
      const ownerLoginRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.equal(ownerLoginRes.status, 200);
      const ownerAuth = (await ownerLoginRes.json()) as { sessionToken: string; user: { id: string } };
      const ownerHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.sessionToken}`,
      };

      // Create WAREHOUSE and CASHIER staff users to verify RBAC
      const whCreateRes = await fetch(`${url}/api/auth/users`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          username: 'wh_staff',
          displayName: 'Warehouse Staff',
          role: 'WAREHOUSE',
          pin: '223344',
        }),
      });
      assert.equal(whCreateRes.status, 200);

      const whLoginRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '223344' }),
      });
      assert.equal(whLoginRes.status, 200);
      const whAuth = (await whLoginRes.json()) as { sessionToken: string };
      const whHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${whAuth.sessionToken}`,
      };

      // Default seeded Cashier (111111) must be denied barcode printer endpoints (403)
      const cashierLoginRes = await fetch(`${url}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '111111' }),
      });
      assert.equal(cashierLoginRes.status, 200);
      const cashierAuth = (await cashierLoginRes.json()) as { sessionToken: string };
      const cashierHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cashierAuth.sessionToken}`,
      };

      // 1. Bootstrap returns normalized default barcodeLabelConfig
      const bootRes = await fetch(`${url}/api/bootstrap`, { headers: whHeaders });
      assert.equal(bootRes.status, 200);
      const boot = (await bootRes.json()) as {
        barcodeLabelConfig: ReturnType<typeof normalizeBarcodeLabelConfig>;
        ledgerInvariant: { valid: boolean };
      };
      assert.equal(boot.barcodeLabelConfig.mode, 'A4_SHEET');
      assert.equal(boot.barcodeLabelConfig.defaultPresetId, 'A4_30UP');

      // 2. WAREHOUSE user can query Windows printers list (previously restricted to CASHIER/MANAGER/OWNER)
      const winListRes = await fetch(`${url}/api/printer/windows-list`, { headers: whHeaders });
      assert.equal(winListRes.status, 200);

      // 3. CASHIER cannot save or print barcode labels
      const cashierSaveDenied = await fetch(`${url}/api/warehouse/barcode-label-config`, {
        method: 'POST',
        headers: cashierHeaders,
        body: JSON.stringify({ mode: 'TSPL_RAW_USB' }),
      });
      assert.equal(cashierSaveDenied.status, 403);

      // 4. WAREHOUSE saves TSPL config and verifies persistence
      const saveCfgRes = await fetch(`${url}/api/warehouse/barcode-label-config`, {
        method: 'POST',
        headers: whHeaders,
        body: JSON.stringify({
          mode: 'TSPL_RAW_USB',
          windowsPrinterName: 'Xprinter XP-365B',
          defaultPresetId: '50x30mm',
          gapMm: 3,
          template: {
            showStoreName: true,
            showItemName: true,
            showVariantName: true,
            showPrice: true,
            showSku: false,
            showUnit: true,
            showBarcodeText: true,
            symbology: 'EAN_13',
          },
        }),
      });
      assert.equal(saveCfgRes.status, 200);
      const savedCfgData = (await saveCfgRes.json()) as {
        barcodeLabelConfig: ReturnType<typeof normalizeBarcodeLabelConfig>;
      };
      assert.equal(savedCfgData.barcodeLabelConfig.mode, 'TSPL_RAW_USB');
      assert.equal(savedCfgData.barcodeLabelConfig.windowsPrinterName, 'Xprinter XP-365B');
      assert.equal(savedCfgData.barcodeLabelConfig.defaultPresetId, '50x30mm');
      assert.equal(savedCfgData.barcodeLabelConfig.gapMm, 3);
      assert.equal(savedCfgData.barcodeLabelConfig.template.symbology, 'EAN_13');

      const getCfgRes = await fetch(`${url}/api/warehouse/barcode-label-config`, {
        headers: whHeaders,
      });
      assert.equal(getCfgRes.status, 200);
      const getCfgData = (await getCfgRes.json()) as {
        barcodeLabelConfig: ReturnType<typeof normalizeBarcodeLabelConfig>;
      };
      assert.equal(getCfgData.barcodeLabelConfig.windowsPrinterName, 'Xprinter XP-365B');

      // 5. Print barcode labels via TSPL dryRun and ESC/POS SIMULATED_MEMORY
      const labelBitmap400x240 = Buffer.alloc((400 / 8) * 240, 0x55).toString('base64');
      const tsplDryRunRes = await fetch(`${url}/api/warehouse/print-barcode-labels`, {
        method: 'POST',
        headers: whHeaders,
        body: JSON.stringify({
          targetMode: 'TSPL_RAW_USB',
          dryRun: true,
          frames: [
            {
              variantId: 'VAR-RET-001',
              sku: '8851952350161',
              barcodeValue: '8851952350161',
              packedBitmapBase64: labelBitmap400x240,
              widthPx: 400,
              heightPx: 240,
              labelWidthMm: 50,
              labelHeightMm: 30,
              copies: 5,
            },
          ],
        }),
      });
      assert.equal(tsplDryRunRes.status, 200);
      const tsplDryRunJson = (await tsplDryRunRes.json()) as {
        ok: boolean;
        protocol: string;
        totalLabelsCount: number;
        wireByteLength: number;
        dispatchedToHardware: boolean;
      };
      assert.equal(tsplDryRunJson.ok, true);
      assert.equal(tsplDryRunJson.protocol, 'TSPL');
      assert.equal(tsplDryRunJson.totalLabelsCount, 5);
      assert.ok(tsplDryRunJson.wireByteLength > 12_000);
      assert.equal(tsplDryRunJson.dispatchedToHardware, false);

      const labelBitmap576x280 = Buffer.alloc((576 / 8) * 280, 0x33).toString('base64');
      const escposRes = await fetch(`${url}/api/warehouse/print-barcode-labels`, {
        method: 'POST',
        headers: whHeaders,
        body: JSON.stringify({
          targetMode: 'ESCPOS_RECEIPT_PRINTER',
          frames: [
            {
              variantId: 'VAR-RET-001',
              sku: '8851952350161',
              barcodeValue: '8851952350161',
              packedBitmapBase64: labelBitmap576x280,
              widthPx: 576,
              heightPx: 280,
              labelWidthMm: 72,
              labelHeightMm: 35,
              copies: 2,
            },
          ],
        }),
      });
      assert.equal(escposRes.status, 200);
      const escposJson = (await escposRes.json()) as {
        ok: boolean;
        protocol: string;
        totalLabelsCount: number;
        maxPacketByteLength: number;
      };
      assert.equal(escposJson.ok, true);
      assert.equal(escposJson.protocol, 'ESC_POS');
      assert.equal(escposJson.totalLabelsCount, 2);
      assert.ok(escposJson.maxPacketByteLength <= 8_192);

      // 6. Reject loopback / reserved POS internal ports for LAN TCP label printers (SSRF guard)
      const loopbackTcpRes = await fetch(`${url}/api/warehouse/print-barcode-labels`, {
        method: 'POST',
        headers: whHeaders,
        body: JSON.stringify({
          targetMode: 'TSPL_LAN_9100',
          tcpHost: '127.0.0.1',
          tcpPort: 9100,
          dryRun: true,
          frames: [
            {
              variantId: 'VAR-RET-001',
              sku: '8851952350161',
              barcodeValue: '8851952350161',
              packedBitmapBase64: labelBitmap400x240,
              widthPx: 400,
              heightPx: 240,
              labelWidthMm: 50,
              labelHeightMm: 30,
              copies: 1,
            },
          ],
        }),
      });
      assert.equal(loopbackTcpRes.status, 400);

      const reservedPortTcpRes = await fetch(`${url}/api/warehouse/print-barcode-labels`, {
        method: 'POST',
        headers: whHeaders,
        body: JSON.stringify({
          targetMode: 'TSPL_LAN_9100',
          tcpHost: '192.168.1.200',
          tcpPort: 4173,
          dryRun: true,
          frames: [
            {
              variantId: 'VAR-RET-001',
              sku: '8851952350161',
              barcodeValue: '8851952350161',
              packedBitmapBase64: labelBitmap400x240,
              widthPx: 400,
              heightPx: 240,
              labelWidthMm: 50,
              labelHeightMm: 30,
              copies: 1,
            },
          ],
        }),
      });
      assert.equal(reservedPortTcpRes.status, 400);
    } finally {
      await appServer.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
