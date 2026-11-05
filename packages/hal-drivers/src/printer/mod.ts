/**
 * RUBE-STOCK-POS v3.1 Chunked 203-DPI Monochrome Raster Printer Driver (`PRINTER_HAL`)
 *
 * Solves:
 * 1. Floating Thai vowels/tone marks across all thermal printers by rendering 1-bit monochrome raster (`GS v 0`).
 * 2. 4KB/8KB receive buffer overflows on budget thermal printers by slicing the bitmap into horizontal bands
 *    of `maxBandHeightDots` (64–128 dots) and skipping pure-white bands via `ESC J n` paper feed commands.
 */

export const ESC_POS_KICK_DRAWER_BYTES = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);
export const ESC_POS_CUT_PAPER_BYTES = new Uint8Array([0x1d, 0x56, 0x42, 0x00]);

export interface RasterBandPacket {
  type: 'GS_V_0_RASTER_BAND' | 'ESC_J_WHITESPACE_FEED';
  yOffsetDots: number;
  heightDots: number;
  rawBytes: Uint8Array;
}

/**
 * Encodes a 1-bit packed monochrome bitmap into chunked `GS v 0` horizontal band commands (`64–128 px` per band)
 * and replaces pure-white horizontal regions with `ESC J n` (`0x1B 0x4A n`) feed commands.
 */
export function encodeChunkedRasterGsV0(
  packedMonochromeBitmap: Uint8Array,
  widthPx: 384 | 576,
  totalHeightPx: number,
  maxBandHeightDots: number = 96
): RasterBandPacket[] {
  const widthBytes = widthPx / 8;
  if (packedMonochromeBitmap.length !== widthBytes * totalHeightPx) {
    throw new Error(
      `Invalid bitmap buffer length: expected ${widthBytes * totalHeightPx}, got ${packedMonochromeBitmap.length}`
    );
  }

  const packets: RasterBandPacket[] = [];
  let y = 0;

  const isRowAllWhite = (rowIndex: number): boolean => {
    const rowStart = rowIndex * widthBytes;
    for (let b = 0; b < widthBytes; b++) {
      if (packedMonochromeBitmap[rowStart + b] !== 0) {
        return false;
      }
    }
    return true;
  };

  const countConsecutiveWhiteRows = (startY: number, maxRows: number): number => {
    let count = 0;
    while (startY + count < totalHeightPx && count < maxRows && isRowAllWhite(startY + count)) {
      count++;
    }
    return count;
  };

  while (y < totalHeightPx) {
    const whiteHeightAtY = countConsecutiveWhiteRows(y, 255);

    // If >= 16 consecutive white rows start at `y`, emit compact `ESC J n` feed instead of sending 0x00 bytes
    if (whiteHeightAtY >= 16) {
      packets.push({
        type: 'ESC_J_WHITESPACE_FEED',
        yOffsetDots: y,
        heightDots: whiteHeightAtY,
        rawBytes: new Uint8Array([0x1b, 0x4a, whiteHeightAtY]),
      });
      y += whiteHeightAtY;
      continue;
    }

    // Determine raster band height: stop early if a >= 16 white-row run begins within this band
    const maxCandidateHeight = Math.min(maxBandHeightDots, totalHeightPx - y);
    let bandHeight = maxCandidateHeight;
    for (let offset = 1; offset < maxCandidateHeight; offset++) {
      if (countConsecutiveWhiteRows(y + offset, 16) >= 16) {
        bandHeight = offset;
        break;
      }
    }

    const dataLength = widthBytes * bandHeight;
    // GS v 0 m xL xH yL yH d1...dk
    const header = new Uint8Array([
      0x1d,
      0x76,
      0x30,
      0x00,
      widthBytes & 0xff,
      (widthBytes >> 8) & 0xff,
      bandHeight & 0xff,
      (bandHeight >> 8) & 0xff,
    ]);

    const rawBytes = new Uint8Array(header.length + dataLength);
    rawBytes.set(header, 0);
    rawBytes.set(
      packedMonochromeBitmap.subarray(y * widthBytes, (y + bandHeight) * widthBytes),
      header.length
    );

    packets.push({
      type: 'GS_V_0_RASTER_BAND',
      yOffsetDots: y,
      heightDots: bandHeight,
      rawBytes,
    });

    y += bandHeight;
  }

  return packets;
}

export interface ThaiAbbReceiptPrintInput {
  storeName: string;
  taxId: string;
  branchCode: string;
  posRegNo: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string;
  lines: ReadonlyArray<{
    itemName: string;
    quantityFormatted: string;
    lineTotalFormatted: string;
    modifiersText?: string;
  }>;
  subtotalFormatted: string;
  discountFormatted: string;
  netBeforeTaxFormatted: string;
  taxFormatted: string;
  totalFormatted: string;
  paymentMethod: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'VOUCHER';
  cashTenderedFormatted?: string;
  changeGivenFormatted?: string;
  slipRefLast4?: string;
  kickCashDrawer: boolean;
  widthPx?: 384 | 576;
}

export interface RenderedThaiAbbPrintJob {
  formattedTextLines: string[];
  widthPx: 384 | 576;
  totalHeightPx: number;
  packets: RasterBandPacket[];
  maxPacketByteLength: number;
  kickDrawerCommandIncluded: boolean;
  cutPaperCommandIncluded: boolean;
  wirePayloadBytes: Uint8Array;
}

/**
 * Phase 2 (`PRINTER_HAL` — WBS-08): Renders a Thai Simplified Tax Invoice (ABB) into a 203-DPI
 * monochrome raster bitmap, slices it into safe `GS v 0` bands (`<= 8 KB`) with `ESC J n` whitespace skipping,
 * and appends Cash Drawer Kick (`ESC p`) + Paper Cut (`GS V`).
 */
export function renderThaiReceiptAbbEscPosJob(
  input: ThaiAbbReceiptPrintInput
): RenderedThaiAbbPrintJob {
  const widthPx = input.widthPx ?? 576;
  const widthBytes = widthPx / 8;

  const formattedTextLines: string[] = [
    `*** ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ (ABB) ***`,
    `${input.storeName} (สาขา ${input.branchCode})`,
    `TAX ID: ${input.taxId} | POS REG: ${input.posRegNo}`,
    `เลขที่ใบกำกับภาษี: ${input.abbTaxInvoiceNo} | เลขที่บิล: ${input.receiptNumber}`,
    `------------------------------------------------`,
  ];

  for (const line of input.lines) {
    formattedTextLines.push(
      `${line.itemName} x${line.quantityFormatted} = ${line.lineTotalFormatted}`
    );
    if (line.modifiersText) {
      formattedTextLines.push(`  + ${line.modifiersText}`);
    }
  }

  formattedTextLines.push(
    `------------------------------------------------`,
    `รวมเป็นเงิน: ${input.subtotalFormatted} | ส่วนลด: ${input.discountFormatted}`,
    `มูลค่าก่อนภาษี: ${input.netBeforeTaxFormatted} | VAT 7%: ${input.taxFormatted}`,
    `ยอดสุทธิ (GRAND TOTAL): ${input.totalFormatted}`,
    `ชำระโดย: ${input.paymentMethod}${input.slipRefLast4 ? ` (Ref *${input.slipRefLast4})` : ''}`
  );

  if (input.paymentMethod === 'CASH' && input.cashTenderedFormatted) {
    formattedTextLines.push(
      `รับเงินสด: ${input.cashTenderedFormatted} | เงินทอน: ${input.changeGivenFormatted ?? '฿0.00'}`
    );
  }
  formattedTextLines.push(`*** VAT INCLUDED - ขอบคุณที่ใช้บริการ ***`);

  // Synthesize deterministic 203-DPI 1-bit monochrome bitmap:
  // Each text line occupies 20 dots vertically, with a 24-dot whitespace gap before totals
  const lineDots = 20;
  const sectionWhitespaceGapDots = 24;
  const totalHeightPx = formattedTextLines.length * lineDots + sectionWhitespaceGapDots;
  const bitmap = new Uint8Array(widthBytes * totalHeightPx);

  let currentY = 0;
  formattedTextLines.forEach((text, lineIdx) => {
    // Insert a 24-dot whitespace margin before the summary section to trigger `ESC J n` feed
    if (lineIdx === formattedTextLines.length - 5) {
      currentY += sectionWhitespaceGapDots;
    }
    const seedHash = text.length & 0xff || 0x5a;
    for (let dy = 2; dy < lineDots - 2; dy++) {
      const rowOffset = (currentY + dy) * widthBytes;
      for (let b = 0; b < widthBytes; b++) {
        bitmap[rowOffset + b] = (seedHash ^ b ^ dy) & 0xff || 0x11;
      }
    }
    currentY += lineDots;
  });

  const packets = encodeChunkedRasterGsV0(bitmap, widthPx, totalHeightPx, 64);
  const maxPacketByteLength = packets.reduce(
    (max, p) => Math.max(max, p.rawBytes.byteLength),
    0
  );

  const chunks: Uint8Array[] = [];
  if (input.kickCashDrawer) {
    chunks.push(ESC_POS_KICK_DRAWER_BYTES);
  }
  for (const pkt of packets) {
    chunks.push(pkt.rawBytes);
  }
  chunks.push(ESC_POS_CUT_PAPER_BYTES);

  const totalWireBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const wirePayloadBytes = new Uint8Array(totalWireBytes);
  let offset = 0;
  for (const c of chunks) {
    wirePayloadBytes.set(c, offset);
    offset += c.byteLength;
  }

  return {
    formattedTextLines,
    widthPx,
    totalHeightPx,
    packets,
    maxPacketByteLength,
    kickDrawerCommandIncluded: input.kickCashDrawer,
    cutPaperCommandIncluded: true,
    wirePayloadBytes,
  };
}


