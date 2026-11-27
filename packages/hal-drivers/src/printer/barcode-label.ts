/**
 * RUBE-STOCK-POS v3.1 Thermal Barcode Label Wire Encoders (`TSPL2`, `ZPL II`, `ESC/POS`)
 *
 * Converts 203-DPI 1-bit packed monochrome bitmaps (`1` = black dot, `0` = white paper)
 * into native hardware payloads for:
 * 1. TSPL / TSPL2 printers (Xprinter XP-365B / XP-420B / TSC / Gprinter)
 * 2. ZPL II printers (Zebra ZD220 / ZD420 / GK420t)
 * 3. ESC/POS 80mm / 58mm thermal receipt printers (reusing chunked `GS v 0`)
 */

import { encodeChunkedRasterGsV0, ESC_POS_CUT_PAPER_BYTES } from './mod.ts';

export interface BitmapLabelFrameInput {
  packedMonochromeBitmap: Uint8Array;
  widthPx: number;
  heightPx: number;
  labelWidthMm: number;
  labelHeightMm: number;
  gapMm?: number | undefined;
  copies: number;
}

function validateBitmapDimensions(frame: BitmapLabelFrameInput): number {
  if (frame.widthPx <= 0 || frame.widthPx % 8 !== 0) {
    throw new Error(`Invalid label bitmap widthPx (${frame.widthPx}): must be positive multiple of 8`);
  }
  if (frame.heightPx <= 0) {
    throw new Error(`Invalid label bitmap heightPx (${frame.heightPx}): must be positive`);
  }
  const widthBytes = frame.widthPx / 8;
  const expectedLen = widthBytes * frame.heightPx;
  if (frame.packedMonochromeBitmap.length !== expectedLen) {
    throw new Error(
      `Invalid label bitmap length: expected ${expectedLen} bytes (${widthBytes}x${frame.heightPx}), got ${frame.packedMonochromeBitmap.length}`
    );
  }
  return widthBytes;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Encodes one or more 1-bit monochrome product label bitmaps into a TSPL2 batch payload.
 * Note: TSPL `BITMAP` uses active-low dots (`0` = black dot burned, `1` = white paper),
 * so canonical `1 = black` bitmaps are bitwise-inverted (`b ^ 0xff`) on the wire.
 */
export function buildTsplLabelBatchWirePayload(
  frames: ReadonlyArray<BitmapLabelFrameInput>
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('At least one label frame is required for TSPL output');
  }
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const frame of frames) {
    const widthBytes = validateBitmapDimensions(frame);
    const copies = Math.max(1, Math.min(999, Math.trunc(frame.copies || 1)));
    const gapMm = Math.max(0, Math.min(15, Math.trunc(frame.gapMm ?? 2)));

    const header = [
      `SIZE ${frame.labelWidthMm} mm,${frame.labelHeightMm} mm`,
      `GAP ${gapMm} mm,0 mm`,
      'DIRECTION 1,0',
      'REFERENCE 0,0',
      'SET TEAR ON',
      'CLS',
      `BITMAP 0,0,${widthBytes},${frame.heightPx},0,`,
    ].join('\r\n');

    const invertedBitmap = new Uint8Array(frame.packedMonochromeBitmap.length);
    for (let i = 0; i < frame.packedMonochromeBitmap.length; i += 1) {
      invertedBitmap[i] = frame.packedMonochromeBitmap[i]! ^ 0xff;
    }

    const footer = `\r\nPRINT ${copies},1\r\n`;

    chunks.push(encoder.encode(header));
    chunks.push(invertedBitmap);
    chunks.push(encoder.encode(footer));
  }

  return concatChunks(chunks);
}

const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, '0')
);

/**
 * Encodes one or more 1-bit monochrome product label bitmaps into a ZPL II (`^XA ... ^GFA ... ^XZ`) batch payload.
 * ZPL `^GFA` uses `1` = black dot, `0` = white paper (matches canonical bitmap directly).
 */
export function buildZplLabelBatchWirePayload(
  frames: ReadonlyArray<BitmapLabelFrameInput>
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('At least one label frame is required for ZPL output');
  }
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const frame of frames) {
    const widthBytes = validateBitmapDimensions(frame);
    const totalBytes = widthBytes * frame.heightPx;
    const copies = Math.max(1, Math.min(999, Math.trunc(frame.copies || 1)));

    const hexParts: string[] = new Array(frame.packedMonochromeBitmap.length);
    for (let i = 0; i < frame.packedMonochromeBitmap.length; i += 1) {
      hexParts[i] = HEX_TABLE[frame.packedMonochromeBitmap[i]!]!;
    }
    const hexData = hexParts.join('');

    const zpl = [
      '^XA',
      `^PW${frame.widthPx}`,
      `^LL${frame.heightPx}`,
      '^LH0,0',
      `^FO0,0^GFA,${totalBytes},${totalBytes},${widthBytes},${hexData}^FS`,
      `^PQ${copies},0,1,Y`,
      '^XZ',
      '',
    ].join('\r\n');

    chunks.push(encoder.encode(zpl));
  }

  return concatChunks(chunks);
}

const MAX_ESCPOS_BATCH_LABELS = 500;

/**
 * Encodes a batch of 203-DPI label bitmaps for standard 80mm (`576px`) or 58mm (`384px`) ESC/POS receipt printers,
 * encoding each unique label frame once via chunked `GS v 0` (`<= 8 KB` per band) and repeating references up to 500 labels.
 */
export function buildEscPosLabelBatchWirePayload(
  frames: ReadonlyArray<BitmapLabelFrameInput>
): {
  wirePayloadBytes: Uint8Array;
  packetsCount: number;
  maxPacketByteLength: number;
} {
  if (frames.length === 0) {
    throw new Error('At least one label frame is required for ESC/POS output');
  }

  const normalizedCopies = frames.map((f) =>
    Math.max(1, Math.min(200, Math.trunc(f.copies || 1)))
  );
  const totalCopies = normalizedCopies.reduce((sum, c) => sum + c, 0);
  if (totalCopies > MAX_ESCPOS_BATCH_LABELS) {
    throw new RangeError(
      'จำกัดจำนวนสติกเกอร์รวมต่อครั้งสำหรับเครื่องพิมพ์ใบเสร็จ ESC/POS ไม่เกิน 500 ดวง'
    );
  }

  const chunks: Uint8Array[] = [new Uint8Array([0x1b, 0x40])]; // ESC @ initialize once
  const feedGapBytes = new Uint8Array([0x1b, 0x4a, 24]);
  let packetsCount = 0;
  let maxPacketByteLength = 0;

  for (let fIdx = 0; fIdx < frames.length; fIdx += 1) {
    const frame = frames[fIdx]!;
    validateBitmapDimensions(frame);
    if (frame.widthPx !== 384 && frame.widthPx !== 576) {
      throw new Error(
        `ESC/POS receipt printer requires 384px (58mm) or 576px (80mm) label width, got ${frame.widthPx}px`
      );
    }

    const packets = encodeChunkedRasterGsV0(
      frame.packedMonochromeBitmap,
      frame.widthPx,
      frame.heightPx,
      96
    );
    let frameMaxPacket = 0;
    const packetRawChunks = packets.map((p) => {
      if (p.rawBytes.byteLength > frameMaxPacket) {
        frameMaxPacket = p.rawBytes.byteLength;
      }
      return p.rawBytes;
    });
    const singleFrameBodyBytes = concatChunks(packetRawChunks);

    const copies = normalizedCopies[fIdx]!;
    packetsCount += packets.length * copies;
    maxPacketByteLength = Math.max(maxPacketByteLength, frameMaxPacket);

    for (let c = 0; c < copies; c += 1) {
      chunks.push(singleFrameBodyBytes);
      const isVeryLastLabel = fIdx === frames.length - 1 && c === copies - 1;
      if (!isVeryLastLabel) {
        chunks.push(feedGapBytes);
      }
    }
  }

  chunks.push(new Uint8Array([0x1b, 0x64, 0x04]));
  chunks.push(ESC_POS_CUT_PAPER_BYTES);

  return {
    wirePayloadBytes: concatChunks(chunks),
    packetsCount,
    maxPacketByteLength,
  };
}
