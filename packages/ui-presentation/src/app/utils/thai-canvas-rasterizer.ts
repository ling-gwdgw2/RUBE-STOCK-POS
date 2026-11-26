/**
 * RUBE-STOCK-POS v3.1 True 203-DPI HTML5 `<canvas>` Thai Receipt Monochrome Rasterizer
 *
 * Uses WebView2 / Chromium's native HarfBuzz + DirectWrite font shaping engine to render
 * stacked Thai vowels and tone marks (`ที่`, `น้ำ`, `กู้`, `ปิ้ง`, `ใบกำกับภาษีอย่างย่อ`) onto a crisp
 * 203-DPI `<canvas>` (`576px` for 80mm paper, `384px` for 58mm paper) with ZERO floating vowels (`สระลอย`),
 * then packs pixels into a 1-bit monochrome bitmap (`1` = black dot, `0` = white paper) ready for
 * chunked `GS v 0` ESC/POS transmission over LAN TCP `:9100` or Windows Raw USB Spooler!
 */

const THERMAL_FONT_FAMILY = '"Leelawadee UI", "Noto Sans Thai", "Tahoma", sans-serif';
const MAX_CANVAS_TILE_HEIGHT_PX = 16_000;

const thaiGraphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('th', { granularity: 'grapheme' })
    : null;

function segmentGraphemes(text: string): string[] {
  if (!text) return [];
  if (thaiGraphemeSegmenter) {
    return Array.from(thaiGraphemeSegmenter.segment(text), (seg) => seg.segment);
  }
  return Array.from(text);
}

/**
 * Wraps text into lines within `maxWidth` using grapheme-cluster segmentation so Thai combining
 * vowels and tone marks are never detached from their base consonant.
 */
export function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const safeMaxWidth = Math.max(24, maxWidth);
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    if (ctx.measureText(paragraph).width <= safeMaxWidth) {
      lines.push(paragraph);
      continue;
    }

    const tokens = paragraph.split(/(\s+)/).filter((t) => t.length > 0);
    let currentLine = '';

    for (const token of tokens) {
      const candidate = currentLine + token;
      if (ctx.measureText(candidate).width <= safeMaxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine.trim().length > 0) {
        lines.push(currentLine.trimEnd());
        currentLine = '';
      }

      const trimmedToken = token.trimStart();
      if (!trimmedToken) {
        continue;
      }

      if (ctx.measureText(trimmedToken).width <= safeMaxWidth) {
        currentLine = trimmedToken;
        continue;
      }

      const graphemes = segmentGraphemes(trimmedToken);
      for (const grapheme of graphemes) {
        const nextLine = currentLine + grapheme;
        if (currentLine.length > 0 && ctx.measureText(nextLine).width > safeMaxWidth) {
          lines.push(currentLine);
          currentLine = grapheme;
        } else {
          currentLine = nextLine;
        }
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine.trimEnd());
    }
  }

  return lines.length > 0 ? lines : [''];
}

export interface CanvasReceiptRenderInput {
  paperWidthMm: 80 | 58;
  storeName: string;
  taxId: string;
  branchCode: string;
  posRegNo: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string;
  createdAtText: string;
  cashierName: string;
  taxMode?: 'NONE' | 'INCLUSIVE' | 'EXCLUSIVE' | undefined;
  lines: Array<{
    itemName: string;
    qtyText: string;
    totalText: string;
    modifiersText?: string | undefined;
  }>;
  subtotalText: string;
  discountText: string;
  netBeforeTaxText: string;
  vatText: string;
  grandTotalText: string;
  paymentSummaryLines: string[];
}

export interface PackedCanvasRasterResult {
  widthPx: 384 | 576;
  heightPx: number;
  packedBitmapBase64: string;
  previewDataUrl: string;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return window.btoa(binary);
}

interface ThermalCanvasDrawer {
  advance: (deltaY: number) => void;
  getY: () => number;
  drawCentered: (text: string, size: number, bold?: boolean) => void;
  drawWrapped: (text: string, size: number, bold?: boolean, indentPx?: number) => void;
  drawPrefixedWrapped: (prefix: string, text: string, size: number, bold?: boolean) => void;
  drawLeftRight: (left: string, right: string, size: number, bold?: boolean) => void;
  drawItemLine: (itemName: string, qtyText: string, totalText: string, size: number) => void;
  drawDivider: () => void;
}

function createThermalCanvasDrawer(
  ctx: CanvasRenderingContext2D,
  widthPx: 384 | 576,
  padX: number,
  measureOnly: boolean,
  tileTop: number,
  tileBottom: number
): ThermalCanvasDrawer {
  let y = 20;
  const contentWidth = widthPx - padX * 2;
  const marginBandPx = 64;

  const shouldDraw = (lineHeight: number): boolean =>
    !measureOnly && y + lineHeight >= tileTop - marginBandPx && y <= tileBottom + marginBandPx;

  const setFont = (size: number, bold: boolean, weightOverride?: string) => {
    const weight = weightOverride ?? (bold ? '700' : '500');
    ctx.font = `${weight} ${size}px ${THERMAL_FONT_FAMILY}`;
  };

  return {
    advance(deltaY: number) {
      y += deltaY;
    },
    getY() {
      return y;
    },
    drawCentered(text: string, size: number, bold = false) {
      setFont(size, bold);
      const step = Math.round(size * 1.48);
      const lines = wrapTextLines(ctx, text, contentWidth);
      for (const lineText of lines) {
        if (shouldDraw(step)) {
          const m = ctx.measureText(lineText);
          const x = Math.max(padX, Math.floor((widthPx - m.width) / 2));
          ctx.fillText(lineText, x, y);
        }
        y += step;
      }
    },
    drawWrapped(text: string, size: number, bold = false, indentPx = 0) {
      setFont(size, bold);
      const step = Math.round(size * 1.45);
      const lines = wrapTextLines(ctx, text, contentWidth - indentPx);
      for (const lineText of lines) {
        if (shouldDraw(step)) {
          ctx.fillText(lineText, padX + indentPx, y);
        }
        y += step;
      }
    },
    drawPrefixedWrapped(prefix: string, text: string, size: number, bold = false) {
      setFont(size, bold, bold ? '700' : '400');
      const step = Math.round(size * 1.4);
      const prefixWidth = ctx.measureText(prefix).width;
      const lines = wrapTextLines(ctx, text, contentWidth - prefixWidth);
      for (let i = 0; i < lines.length; i += 1) {
        if (shouldDraw(step)) {
          if (i === 0) {
            ctx.fillText(`${prefix}${lines[i]!}`, padX, y);
          } else {
            ctx.fillText(lines[i]!, padX + prefixWidth, y);
          }
        }
        y += step;
      }
    },
    drawLeftRight(left: string, right: string, size: number, bold = false) {
      setFont(size, bold);
      const step = Math.round(size * 1.45);
      const rightWidth = ctx.measureText(right).width;
      const maxLeftWidth = contentWidth - rightWidth - 12;

      if (maxLeftWidth >= 48) {
        const leftLines = wrapTextLines(ctx, left, maxLeftWidth);
        for (let i = 0; i < leftLines.length; i += 1) {
          const isLast = i === leftLines.length - 1;
          if (shouldDraw(step)) {
            ctx.fillText(leftLines[i]!, padX, y);
            if (isLast) {
              ctx.fillText(right, widthPx - padX - rightWidth, y);
            }
          }
          y += step;
        }
        return;
      }

      const leftLines = wrapTextLines(ctx, left, contentWidth);
      for (const lineText of leftLines) {
        if (shouldDraw(step)) {
          ctx.fillText(lineText, padX, y);
        }
        y += step;
      }
      const rightLines = wrapTextLines(ctx, right, contentWidth);
      for (const rightLine of rightLines) {
        if (shouldDraw(step)) {
          const rw = ctx.measureText(rightLine).width;
          ctx.fillText(rightLine, Math.max(padX, widthPx - padX - rw), y);
        }
        y += step;
      }
    },
    drawItemLine(itemName: string, qtyText: string, totalText: string, size: number) {
      setFont(size, false);
      const step = Math.round(size * 1.45);
      const totalWidth = ctx.measureText(totalText).width;
      const qtyBadge = `(${qtyText})`;
      const qtyWithSpace = ` ${qtyBadge}`;
      const maxLeftWidth = contentWidth - totalWidth - 12;

      if (maxLeftWidth >= 48) {
        const singleLine = `${itemName}${qtyWithSpace}`;
        if (ctx.measureText(singleLine).width <= maxLeftWidth) {
          if (shouldDraw(step)) {
            ctx.fillText(singleLine, padX, y);
            ctx.fillText(totalText, widthPx - padX - totalWidth, y);
          }
          y += step;
          return;
        }

        const wrappedNames = wrapTextLines(ctx, itemName, maxLeftWidth);
        const lastIdx = wrappedNames.length - 1;
        const lastLine = wrappedNames[lastIdx] ?? '';
        const combinedLast = `${lastLine}${qtyWithSpace}`;
        if (ctx.measureText(combinedLast).width <= maxLeftWidth) {
          wrappedNames[lastIdx] = combinedLast;
          for (let i = 0; i < wrappedNames.length; i += 1) {
            const isLast = i === wrappedNames.length - 1;
            if (shouldDraw(step)) {
              ctx.fillText(wrappedNames[i]!, padX, y);
              if (isLast) {
                ctx.fillText(totalText, widthPx - padX - totalWidth, y);
              }
            }
            y += step;
          }
          return;
        }

        if (ctx.measureText(qtyBadge).width <= maxLeftWidth) {
          wrappedNames.push(qtyBadge);
          for (let i = 0; i < wrappedNames.length; i += 1) {
            const isLast = i === wrappedNames.length - 1;
            if (shouldDraw(step)) {
              ctx.fillText(wrappedNames[i]!, padX, y);
              if (isLast) {
                ctx.fillText(totalText, widthPx - padX - totalWidth, y);
              }
            }
            y += step;
          }
          return;
        }
      }

      // Extreme fallback: very wide totalText or qtyBadge — never slice `(${qtyText})`
      const nameLines = wrapTextLines(ctx, itemName, contentWidth);
      for (const lineText of nameLines) {
        if (shouldDraw(step)) {
          ctx.fillText(lineText, padX, y);
        }
        y += step;
      }
      const qtyLines = wrapTextLines(ctx, qtyBadge, contentWidth);
      for (const qLine of qtyLines) {
        if (shouldDraw(step)) {
          ctx.fillText(qLine, padX, y);
        }
        y += step;
      }
      if (shouldDraw(step)) {
        ctx.fillText(totalText, Math.max(padX, widthPx - padX - totalWidth), y);
      }
      y += step;
    },
    drawDivider() {
      y += 6;
      if (shouldDraw(2)) {
        ctx.fillRect(padX, y, contentWidth, 2);
      }
      y += 12;
    },
  };
}

function packTileCanvasToMonochrome(
  ctx: CanvasRenderingContext2D,
  widthPx: 384 | 576,
  tileHeightPx: number,
  targetPacked: Uint8Array,
  targetRowOffset: number
): void {
  const imgData = ctx.getImageData(0, 0, widthPx, tileHeightPx);
  const rgba = imgData.data;
  const widthBytes = widthPx / 8;

  // Convert RGBA -> 1-bit Monochrome (`1` = black dot, `0` = white paper)
  // Also rewrite `imgData` to crisp monochrome so the UI preview shows exact thermal dot output.
  for (let row = 0; row < tileHeightPx; row += 1) {
    const destRowBase = (targetRowOffset + row) * widthBytes;
    for (let byteIdx = 0; byteIdx < widthBytes; byteIdx += 1) {
      let maskByte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const px = byteIdx * 8 + bit;
        const idx = (row * widthPx + px) * 4;
        const r = rgba[idx] ?? 255;
        const g = rgba[idx + 1] ?? 255;
        const b = rgba[idx + 2] ?? 255;
        const a = rgba[idx + 3] ?? 255;
        // Integer luminance: (r*299 + g*587 + b*114)/1000
        const lum = a < 128 ? 255 : Math.floor((r * 299 + g * 587 + b * 114) / 1000);
        const isBlack = lum < 168;
        if (isBlack) {
          maskByte |= 0x80 >> bit;
        }
        const bwVal = isBlack ? 24 : 255;
        rgba[idx] = bwVal;
        rgba[idx + 1] = bwVal;
        rgba[idx + 2] = bwVal;
        rgba[idx + 3] = 255;
      }
      targetPacked[destRowBase + byteIdx] = maskByte;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

function renderLayoutTo203DpiPackedRaster(
  widthPx: 384 | 576,
  padX: number,
  minHeightPx: number,
  contextErrorLabel: string,
  renderBody: (drawer: ThermalCanvasDrawer) => void
): PackedCanvasRasterResult {
  // Pass 1: Dry-run layout measurement (`measureOnly = true`) BEFORE creating output canvases
  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = 1;
  measureCanvas.height = 1;
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) {
    throw new Error(`2D Canvas context unavailable for ${contextErrorLabel}`);
  }
  const measureDrawer = createThermalCanvasDrawer(
    measureCtx,
    widthPx,
    padX,
    true,
    0,
    Number.MAX_SAFE_INTEGER
  );
  renderBody(measureDrawer);

  // Align height to multiple of 8 dots for clean GS v 0 band slicing
  const finalHeightPx = Math.max(minHeightPx, Math.ceil(measureDrawer.getY() / 8) * 8);
  const widthBytes = widthPx / 8;
  const packed = new Uint8Array(widthBytes * finalHeightPx);

  // Pass 2: Render into < 16,384px tile canvases and pack monochrome bytes
  const isTiled = finalHeightPx > MAX_CANVAS_TILE_HEIGHT_PX;
  const previewScale = isTiled ? Math.min(1, MAX_CANVAS_TILE_HEIGHT_PX / finalHeightPx) : 1;
  let previewCanvas: HTMLCanvasElement | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;

  if (isTiled) {
    previewCanvas = document.createElement('canvas');
    previewCanvas.width = Math.max(1, Math.round(widthPx * previewScale));
    previewCanvas.height = Math.max(1, Math.round(finalHeightPx * previewScale));
    previewCtx = previewCanvas.getContext('2d');
    if (previewCtx) {
      previewCtx.fillStyle = '#ffffff';
      previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }

  let singleTilePreviewUrl = '';

  for (let tileTop = 0; tileTop < finalHeightPx; tileTop += MAX_CANVAS_TILE_HEIGHT_PX) {
    const tileHeight = Math.min(MAX_CANVAS_TILE_HEIGHT_PX, finalHeightPx - tileTop);
    const tileBottom = tileTop + tileHeight;

    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = widthPx;
    tileCanvas.height = tileHeight;
    const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true });
    if (!tileCtx) {
      throw new Error(`2D Canvas context unavailable for ${contextErrorLabel}`);
    }

    tileCtx.fillStyle = '#ffffff';
    tileCtx.fillRect(0, 0, widthPx, tileHeight);
    tileCtx.fillStyle = '#000000';
    tileCtx.textBaseline = 'top';

    tileCtx.save();
    tileCtx.translate(0, -tileTop);
    const drawer = createThermalCanvasDrawer(
      tileCtx,
      widthPx,
      padX,
      false,
      tileTop,
      tileBottom
    );
    renderBody(drawer);
    tileCtx.restore();

    packTileCanvasToMonochrome(tileCtx, widthPx, tileHeight, packed, tileTop);

    if (!isTiled) {
      singleTilePreviewUrl = tileCanvas.toDataURL('image/png');
    } else if (previewCtx && previewCanvas) {
      previewCtx.drawImage(
        tileCanvas,
        0,
        0,
        widthPx,
        tileHeight,
        0,
        tileTop * previewScale,
        previewCanvas.width,
        tileHeight * previewScale
      );
    }
  }

  const previewDataUrl = isTiled && previewCanvas
    ? previewCanvas.toDataURL('image/png')
    : singleTilePreviewUrl;

  return {
    widthPx,
    heightPx: finalHeightPx,
    packedBitmapBase64: uint8ArrayToBase64(packed),
    previewDataUrl,
  };
}

/**
 * Renders a Thai Simplified Tax Invoice (ABB) onto an offscreen 203-DPI `<canvas>` and packs a 1-bit monochrome bitmap.
 */
export function renderThaiReceiptTo203DpiCanvasRaster(
  input: CanvasReceiptRenderInput
): PackedCanvasRasterResult {
  const widthPx: 384 | 576 = input.paperWidthMm === 58 ? 384 : 576;
  const padX = input.paperWidthMm === 58 ? 14 : 22;
  const bodySize = input.paperWidthMm === 58 ? 18 : 21;
  const smallSize = input.paperWidthMm === 58 ? 15 : 17;
  const titleSize = input.paperWidthMm === 58 ? 22 : 26;
  const totalSize = input.paperWidthMm === 58 ? 25 : 30;
  const taxMode = input.taxMode ?? 'INCLUSIVE';

  const vatRowLabel =
    taxMode === 'NONE'
      ? 'ภาษีมูลค่าเพิ่ม (ยกเว้น VAT)'
      : taxMode === 'EXCLUSIVE'
        ? 'ภาษีมูลค่าเพิ่ม (VAT 7% แยกนอก)'
        : 'ภาษีมูลค่าเพิ่ม (VAT 7%)';

  const footerText =
    taxMode === 'NONE'
      ? 'ใบเสร็จรับเงิน · ขอบคุณที่ใช้บริการ'
      : taxMode === 'EXCLUSIVE'
        ? 'VAT 7% (แยกนอก) · ขอบคุณที่ใช้บริการ'
        : 'VAT INCLUDED · ขอบคุณที่ใช้บริการ';

  return renderLayoutTo203DpiPackedRaster(
    widthPx,
    padX,
    160,
    '203-DPI Thai receipt rasterization',
    (d) => {
      // Header
      d.drawCentered(input.storeName, titleSize, true);
      d.drawCentered('ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ (ABB)', smallSize, true);
      d.drawCentered(`TAX ID: ${input.taxId} (สาขา ${input.branchCode})`, smallSize, false);
      d.drawCentered(`POS REG: ${input.posRegNo}`, smallSize, false);
      d.advance(4);
      d.drawLeftRight(`เลขที่: ${input.abbTaxInvoiceNo}`, input.createdAtText, smallSize, false);
      d.drawLeftRight(`บิล: ${input.receiptNumber}`, `พนักงาน: ${input.cashierName}`, smallSize, false);

      d.drawDivider();

      // Order Items
      for (const line of input.lines) {
        d.drawItemLine(line.itemName, line.qtyText, line.totalText, bodySize);
        if (line.modifiersText) {
          d.drawPrefixedWrapped('  + ', line.modifiersText, smallSize, false);
        }
      }

      d.drawDivider();

      // Totals & VAT
      d.drawLeftRight('ยอดรวมสินค้า', input.subtotalText, bodySize, false);
      if (input.discountText !== '฿0.00') {
        d.drawLeftRight('ส่วนลดท้ายบิล', `-${input.discountText}`, bodySize, false);
      }
      d.drawLeftRight('มูลค่าก่อนภาษี (Net)', input.netBeforeTaxText, smallSize, false);
      d.drawLeftRight(vatRowLabel, input.vatText, smallSize, false);
      d.advance(4);
      d.drawLeftRight('ยอดสุทธิ (TOTAL)', input.grandTotalText, totalSize, true);

      d.drawDivider();

      for (const payLine of input.paymentSummaryLines) {
        d.drawWrapped(payLine, smallSize, false);
      }

      d.advance(14);
      d.drawCentered(footerText, smallSize, true);
      d.advance(20);
    }
  );
}

export interface CanvasZReportRenderInput {
  paperWidthMm: 80 | 58;
  storeName: string;
  taxId: string;
  branchCode: string;
  posRegNo: string;
  shiftNumber: string;
  status: string;
  openedAtText: string;
  closedAtText: string;
  printedByName: string;
  completedOrdersCount: number;
  voidedOrdersCount: number;
  voidedTotalText: string;
  grossSalesText: string;
  discountsText: string;
  netBeforeTaxText: string;
  vat7PercentText: string;
  netSalesTotalText: string;
  cashSalesText: string;
  promptPaySalesText: string;
  cardSalesText: string;
  voucherSalesText: string;
  openingCashText: string;
  paidInText: string;
  paidOutText: string;
  cashDropText: string;
  expectedCashText: string;
  countedCashText: string;
  cashVarianceText: string;
}

/**
 * Renders an End-of-Shift Z-Report onto an offscreen 203-DPI `<canvas>` and packs a 1-bit monochrome bitmap
 * for ESC/POS thermal receipt printers (80mm / 58mm).
 */
export function renderThaiZReportTo203DpiCanvasRaster(
  input: CanvasZReportRenderInput
): PackedCanvasRasterResult {
  const widthPx: 384 | 576 = input.paperWidthMm === 58 ? 384 : 576;
  const padX = input.paperWidthMm === 58 ? 14 : 22;
  const bodySize = input.paperWidthMm === 58 ? 18 : 20;
  const smallSize = input.paperWidthMm === 58 ? 15 : 17;
  const titleSize = input.paperWidthMm === 58 ? 22 : 26;
  const totalSize = input.paperWidthMm === 58 ? 23 : 28;

  return renderLayoutTo203DpiPackedRaster(
    widthPx,
    padX,
    240,
    '203-DPI Z-Report rasterization',
    (d) => {
      d.drawCentered(input.storeName, titleSize, true);
      d.drawCentered('ใบสรุปยอดขายและกระทบยอดประจำกะ (Z-REPORT)', smallSize, true);
      d.drawCentered(`TAX ID: ${input.taxId} (สาขา ${input.branchCode})`, smallSize, false);
      d.drawCentered(`POS REG: ${input.posRegNo}`, smallSize, false);
      d.advance(4);
      d.drawLeftRight(`เลขกะ: ${input.shiftNumber}`, `สถานะ: ${input.status}`, smallSize, true);
      d.drawLeftRight('เปิดกะ:', input.openedAtText, smallSize, false);
      d.drawLeftRight('ปิดกะ:', input.closedAtText, smallSize, false);
      d.drawLeftRight('ผู้พิมพ์:', input.printedByName, smallSize, false);

      d.drawDivider();

      d.drawLeftRight(
        'บิลขายสำเร็จ / ยกเลิก',
        `${input.completedOrdersCount} / ${input.voidedOrdersCount} บิล`,
        bodySize,
        false
      );
      if (input.voidedOrdersCount > 0) {
        d.drawLeftRight('มูลค่าบิลยกเลิกรวม', input.voidedTotalText, smallSize, false);
      }
      d.drawLeftRight('ยอดขายก่อนส่วนลด', input.grossSalesText, bodySize, false);
      d.drawLeftRight('ส่วนลดรวม', `-${input.discountsText}`, bodySize, false);
      d.drawLeftRight('มูลค่าก่อนภาษี (Net)', input.netBeforeTaxText, smallSize, false);
      d.drawLeftRight('ภาษีขาย VAT 7%', input.vat7PercentText, smallSize, false);
      d.advance(4);
      d.drawLeftRight('ยอดขายสุทธิรวม VAT', input.netSalesTotalText, totalSize, true);

      d.drawDivider();

      d.drawCentered('แยกตามช่องทางรับชำระเงิน', smallSize, true);
      d.drawLeftRight('เงินสด (Cash)', input.cashSalesText, bodySize, false);
      d.drawLeftRight('พร้อมเพย์ (PromptPay QR)', input.promptPaySalesText, bodySize, false);
      d.drawLeftRight('บัตรเครดิต / EDC', input.cardSalesText, bodySize, false);
      d.drawLeftRight('คูปองเงินสด (Voucher)', input.voucherSalesText, bodySize, false);

      d.drawDivider();

      d.drawCentered('สมการกระทบยอดเงินสดในลิ้นชัก', smallSize, true);
      d.drawLeftRight('เงินทอนตั้งต้นเปิดกะ', input.openingCashText, smallSize, false);
      d.drawLeftRight('+ รับเงินสดจากการขาย', input.cashSalesText, smallSize, false);
      d.drawLeftRight('+ นำเงินสดเข้า (Paid-In)', input.paidInText, smallSize, false);
      d.drawLeftRight('- จ่ายเงินสดย่อย (Paid-Out)', input.paidOutText, smallSize, false);
      d.drawLeftRight('- เก็บเงินเข้าเซฟ (Drop)', input.cashDropText, smallSize, false);
      d.advance(4);
      d.drawLeftRight('เงินสดคาดหวัง (Expected)', input.expectedCashText, bodySize, true);
      d.drawLeftRight('เงินสดนับจริง (Counted)', input.countedCashText, bodySize, true);
      d.drawLeftRight('ผลต่างเงินสด (Variance)', input.cashVarianceText, totalSize, true);

      d.drawDivider();
      d.advance(28);
      if (input.paperWidthMm === 58) {
        d.drawWrapped('ลงชื่อแคชเชียร์: ........................................', smallSize, false);
        d.advance(16);
        d.drawWrapped('ลงชื่อผู้จัดการ: ........................................', smallSize, false);
      } else {
        d.drawLeftRight(
          'ลงชื่อแคชเชียร์: ....................',
          'ผู้จัดการ: ....................',
          smallSize,
          false
        );
      }
      d.advance(18);
    }
  );
}
