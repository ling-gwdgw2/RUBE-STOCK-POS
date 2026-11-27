/**
 * RUBE-STOCK-POS v3.1 True 203-DPI HTML5 `<canvas>` Thai Receipt Monochrome Rasterizer
 *
 * Uses WebView2 / Chromium's native HarfBuzz + DirectWrite font shaping engine to render
 * stacked Thai vowels and tone marks (`ที่`, `น้ำ`, `กู้`, `ปิ้ง`, `ใบกำกับภาษีอย่างย่อ`) onto a crisp
 * 203-DPI `<canvas>` (`576px` for 80mm paper, `384px` for 58mm paper) with ZERO floating vowels (`สระลอย`),
 * then packs pixels into a 1-bit monochrome bitmap (`1` = black dot, `0` = white paper) ready for
 * chunked `GS v 0` ESC/POS transmission over LAN TCP `:9100` or Windows Raw USB Spooler!
 */

import QRCode from 'qrcode';

export const THERMAL_FONT_FAMILY =
  '"Noto Sans Lao", "Leelawadee UI", "Phetsarath OT", "Saysettha OT", "Noto Sans Thai", "Tahoma", sans-serif';
const MAX_CANVAS_TILE_HEIGHT_PX = 16_000;

const graphemeSegmenters: Partial<Record<'th' | 'lo' | 'en', Intl.Segmenter>> = {};

function getGraphemeSegmenter(locale: 'th' | 'lo' | 'en' = 'th'): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return null;
  }
  if (!graphemeSegmenters[locale]) {
    try {
      graphemeSegmenters[locale] = new Intl.Segmenter(locale, { granularity: 'grapheme' });
    } catch {
      graphemeSegmenters[locale] = new Intl.Segmenter('th', { granularity: 'grapheme' });
    }
  }
  return graphemeSegmenters[locale] ?? null;
}

function segmentGraphemes(text: string, locale?: 'th' | 'lo' | 'en'): string[] {
  if (!text) return [];
  const effectiveLocale: 'th' | 'lo' | 'en' =
    locale ?? (/[\u0E80-\u0EFF]/.test(text) ? 'lo' : 'th');
  const seg = getGraphemeSegmenter(effectiveLocale);
  if (seg) {
    return Array.from(seg.segment(text), (item) => item.segment);
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
  countryCode?: 'TH' | 'LA' | undefined;
  receiptLocale?: 'th' | 'lo' | 'en' | undefined;
  vatRatePercentLabel?: string | undefined;
  storeName: string;
  storeAddress?: string | undefined;
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
  discountSatang?: number | undefined;
  discountText: string;
  cashRoundingDiscountText?: string | undefined;
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

export function uint8ArrayToBase64(bytes: Uint8Array): string {
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
  drawQrMatrix: (payload: string, targetSizePx: number) => void;
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
    drawQrMatrix(payload: string, targetSizePx: number) {
      const trimmed = payload.trim();
      if (!trimmed) return;
      const qr = QRCode.create(trimmed, { errorCorrectionLevel: 'M' });
      const count = qr.modules.size;
      const quietModules = 2;
      const totalModules = count + quietModules * 2;
      const modulePx = Math.max(2, Math.floor(targetSizePx / totalModules));
      const actualSize = totalModules * modulePx;
      const startX = Math.max(padX, Math.floor((widthPx - actualSize) / 2));

      if (shouldDraw(actualSize)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(startX, y, actualSize, actualSize);
        ctx.fillStyle = '#000000';
        for (let row = 0; row < count; row += 1) {
          for (let col = 0; col < count; col += 1) {
            if (qr.modules.get(row, col)) {
              ctx.fillRect(
                startX + (col + quietModules) * modulePx,
                y + (row + quietModules) * modulePx,
                modulePx,
                modulePx
              );
            }
          }
        }
      }
      y += actualSize + 8;
    },
  };
}

export function packTileCanvasToMonochrome(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
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
 * Renders a Thailand (ABB) or Lao PDR (VAT/Receipt) thermal receipt onto an offscreen 203-DPI `<canvas>`
 * using bundled Noto Sans Lao + Leelawadee UI shaping (zero floating vowels) and packs a 1-bit monochrome bitmap.
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
  const isLaos = input.countryCode === 'LA';
  const locale = input.receiptLocale ?? (isLaos ? 'lo' : 'th');
  const vatPct = input.vatRatePercentLabel ?? (isLaos ? '10' : '7');

  const labels =
    locale === 'lo'
      ? {
          docTitle:
            taxMode === 'NONE'
              ? 'ໃບບິນຮັບເງິນ (RECEIPT)'
              : `ໃບບິນຮັບເງິນ / ໃບອາກອນມູນຄ່າເພີ່ມ (ອມພ ${vatPct}%)`,
          taxIdLine: `TIN: ${input.taxId || '-'}${!isLaos && input.branchCode ? ` (ສາຂາ ${input.branchCode})` : ''}`,
          posRegLine: `ເລກເຄື່ອງ POS: ${input.posRegNo || '-'}`,
          invPrefix: 'ເລກທີ:',
          billPrefix: 'ບິນ:',
          cashierPrefix: 'ພະນັກງານ:',
          subtotal: 'ລວມລາຄາສິນຄ້າ',
          discount: 'ສ່ວນຫຼຸດທ້າຍບິນ',
          cashRounding: 'ປັດເສດເງິນສົດ',
          netBeforeTax: 'ມູນຄ່າກ່ອນອາກອນ (Net)',
          vatRow:
            taxMode === 'NONE'
              ? 'ອາກອນມູນຄ່າເພີ່ມ (ຍົກເວັ້ນ)'
              : taxMode === 'EXCLUSIVE'
                ? `ອາກອນມູນຄ່າເພີ່ມ (ອມພ ${vatPct}% ແຍກນອກ)`
                : `ອາກອນມູນຄ່າເພີ່ມ (ອມພ ${vatPct}%)`,
          total: 'ຍອດສຸດທິ (TOTAL)',
          footer:
            taxMode === 'NONE'
              ? 'ໃບບິນຮັບເງິນ · ຂອບໃຈທີ່ໃຊ້ບໍລິການ'
              : taxMode === 'EXCLUSIVE'
                ? `ອມພ ${vatPct}% (ແຍກນອກ) · ຂອບໃຈທີ່ໃຊ້ບໍລິການ`
                : `ລວມອາກອນ ອມພ ${vatPct}% · ຂອບໃຈທີ່ໃຊ້ບໍລິການ`,
        }
      : locale === 'en'
        ? {
            docTitle:
              taxMode === 'NONE'
                ? 'OFFICIAL RECEIPT'
                : isLaos
                  ? `RECEIPT / VAT INVOICE (VAT ${vatPct}%)`
                  : `RECEIPT / TAX INVOICE (ABB)`,
            taxIdLine: `${isLaos ? 'TIN' : 'TAX ID'}: ${input.taxId || '-'}${!isLaos && input.branchCode ? ` (Branch ${input.branchCode})` : ''}`,
            posRegLine: `POS REG: ${input.posRegNo || '-'}`,
            invPrefix: 'INV:',
            billPrefix: 'BILL:',
            cashierPrefix: 'Cashier:',
            subtotal: 'Subtotal',
            discount: 'Discount',
            cashRounding: 'Cash Rounding',
            netBeforeTax: 'Net Before Tax',
            vatRow:
              taxMode === 'NONE'
                ? 'VAT (Exempt)'
                : taxMode === 'EXCLUSIVE'
                  ? `VAT ${vatPct}% (Exclusive)`
                  : `VAT ${vatPct}% (Included)`,
            total: 'GRAND TOTAL',
            footer:
              taxMode === 'NONE'
                ? 'RECEIPT · THANK YOU'
                : `VAT ${vatPct}% · THANK YOU FOR YOUR VISIT`,
          }
        : {
            docTitle: isLaos
              ? taxMode === 'NONE'
                ? 'ใบเสร็จรับเงิน (สปป.ลาว)'
                : `ใบเสร็จรับเงิน / ใบกำกับภาษี (VAT ${vatPct}%)`
              : 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ (ABB)',
            taxIdLine: `${isLaos ? 'TIN' : 'TAX ID'}: ${input.taxId || '-'}${!isLaos && input.branchCode ? ` (สาขา ${input.branchCode})` : ''}`,
            posRegLine: `POS REG: ${input.posRegNo || '-'}`,
            invPrefix: 'เลขที่:',
            billPrefix: 'บิล:',
            cashierPrefix: 'พนักงาน:',
            subtotal: 'ยอดรวมสินค้า',
            discount: 'ส่วนลดท้ายบิล',
            cashRounding: 'ปัดเศษเงินสด',
            netBeforeTax: 'มูลค่าก่อนภาษี (Net)',
            vatRow:
              taxMode === 'NONE'
                ? 'ภาษีมูลค่าเพิ่ม (ยกเว้น VAT)'
                : taxMode === 'EXCLUSIVE'
                  ? `ภาษีมูลค่าเพิ่ม (VAT ${vatPct}% แยกนอก)`
                  : `ภาษีมูลค่าเพิ่ม (VAT ${vatPct}%)`,
            total: 'ยอดสุทธิ (TOTAL)',
            footer:
              taxMode === 'NONE'
                ? 'ใบเสร็จรับเงิน · ขอบคุณที่ใช้บริการ'
                : taxMode === 'EXCLUSIVE'
                  ? `VAT ${vatPct}% (แยกนอก) · ขอบคุณที่ใช้บริการ`
                  : `VAT ${vatPct}% INCLUDED · ขอบคุณที่ใช้บริการ`,
          };

  const hasDiscount =
    input.discountSatang !== undefined
      ? input.discountSatang > 0
      : input.discountText !== '฿0.00' &&
        input.discountText !== '0 ₭' &&
        input.discountText !== '₭0';

  return renderLayoutTo203DpiPackedRaster(
    widthPx,
    padX,
    160,
    '203-DPI receipt rasterization',
    (d) => {
      // Header
      d.drawCentered(input.storeName, titleSize, true);
      if (input.storeAddress && input.storeAddress.trim()) {
        d.drawCentered(input.storeAddress.trim(), smallSize, false);
      }
      d.drawCentered(labels.docTitle, smallSize, true);
      d.drawCentered(labels.taxIdLine, smallSize, false);
      if (input.posRegNo && input.posRegNo.trim()) {
        d.drawCentered(labels.posRegLine, smallSize, false);
      }
      d.advance(4);
      d.drawLeftRight(`${labels.invPrefix} ${input.abbTaxInvoiceNo}`, input.createdAtText, smallSize, false);
      d.drawLeftRight(
        `${labels.billPrefix} ${input.receiptNumber}`,
        `${labels.cashierPrefix} ${input.cashierName}`,
        smallSize,
        false
      );

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
      d.drawLeftRight(labels.subtotal, input.subtotalText, bodySize, false);
      if (hasDiscount) {
        d.drawLeftRight(labels.discount, `-${input.discountText}`, bodySize, false);
      }
      if (input.cashRoundingDiscountText) {
        d.drawLeftRight(labels.cashRounding, `-${input.cashRoundingDiscountText}`, smallSize, false);
      }
      d.drawLeftRight(labels.netBeforeTax, input.netBeforeTaxText, smallSize, false);
      d.drawLeftRight(labels.vatRow, input.vatText, smallSize, false);
      d.advance(4);
      d.drawLeftRight(labels.total, input.grandTotalText, totalSize, true);

      d.drawDivider();

      for (const payLine of input.paymentSummaryLines) {
        d.drawWrapped(payLine, smallSize, false);
      }

      d.advance(14);
      d.drawCentered(labels.footer, smallSize, true);
      d.advance(20);
    }
  );
}

export interface CanvasZReportRenderInput {
  paperWidthMm: 80 | 58;
  countryCode?: 'TH' | 'LA' | undefined;
  receiptLocale?: 'th' | 'lo' | 'en' | undefined;
  vatRatePercentLabel?: string | undefined;
  storeName: string;
  storeAddress?: string | undefined;
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
  fxDrawerLines?: string[] | undefined;
}

/**
 * Renders an End-of-Shift Z-Report onto an offscreen 203-DPI `<canvas>` and packs a 1-bit monochrome bitmap
 * for ESC/POS thermal receipt printers (80mm / 58mm), localized for Thailand (`th`) and Laos (`lo` / `en`).
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
  const isLaos = input.countryCode === 'LA';
  const locale = input.receiptLocale ?? (isLaos ? 'lo' : 'th');
  const vatPct = input.vatRatePercentLabel ?? (isLaos ? '10' : '7');

  const L =
    locale === 'lo'
      ? {
          title: 'ໃບສະຫຼຸບຍອດຂາຍ ແລະ ປິດກະປະຈຳວັນ (Z-REPORT)',
          taxLine: `TIN: ${input.taxId || '-'}${!isLaos && input.branchCode ? ` (ສາຂາ ${input.branchCode})` : ''}`,
          shiftPrefix: 'ເລກກະ:',
          statusPrefix: 'ສະຖານະ:',
          opened: 'ເປີດກະ:',
          closed: 'ປິດກະ:',
          printedBy: 'ຜູ້ພິມ:',
          bills: 'ບິນຂາຍສຳເລັດ / ຍົກເລີກ',
          billUnit: 'ບິນ',
          voidedTotal: 'ມູນຄ່າບິນຍົກເລີກລວມ',
          grossSales: 'ຍອດຂາຍກ່ອນສ່ວນຫຼຸດ',
          discounts: 'ສ່ວນຫຼຸດລວມ',
          netBeforeTax: 'ມູນຄ່າກ່ອນອາກອນ (Net)',
          vatLabel: `ອາກອນຂາຍ ອມພ ${vatPct}%`,
          netSales: 'ຍອດຂາຍສຸດທິລວມອາກອນ',
          payHeader: 'ແຍກຕາມຊ່ອງທາງຮັບຊຳລະເງິນ',
          cash: 'ເງິນສົດ (Cash)',
          qr: isLaos ? 'ໂອນ QR (LAOQR / OnePay)' : 'ພ້ອມເພ (PromptPay QR)',
          card: 'ບັດເຄຣດິດ / EDC',
          voucher: 'ຄູປອງເງິນສົດ (Voucher)',
          drawerHeader: 'ສະຫຼຸບກະທົບຍອດເງິນສົດໃນລິ້ນຊັກ',
          opening: 'ເງິນທອນຕັ້ງຕົ້ນເປີດກະ',
          cashInSale: '+ ຮັບເງິນສົດຈາກການຂາຍ',
          paidIn: '+ ນຳເງິນສົດເຂົ້າ (Paid-In)',
          paidOut: '- ຈ່າຍເງິນສົດຍ່ອຍ (Paid-Out)',
          cashDrop: '- ເກັບເງິນເຂົ້າຕູ້ເຊັບ (Drop)',
          expected: 'ເງິນສົດຄາດຫວັງ (Expected)',
          counted: 'ເງິນສົດນັບຈິງ (Counted)',
          variance: 'ຜົນຕ່າງເງິນສົດ (Variance)',
          signCashier: 'ລາຍເຊັນພະນັກງານ:',
          signManager: 'ຜູ້ຈັດການ:',
        }
      : locale === 'en'
        ? {
            title: 'END-OF-SHIFT RECONCILIATION (Z-REPORT)',
            taxLine: `${isLaos ? 'TIN' : 'TAX ID'}: ${input.taxId || '-'}${!isLaos && input.branchCode ? ` (Branch ${input.branchCode})` : ''}`,
            shiftPrefix: 'Shift:',
            statusPrefix: 'Status:',
            opened: 'Opened:',
            closed: 'Closed:',
            printedBy: 'Printed By:',
            bills: 'Completed / Voided Orders',
            billUnit: 'orders',
            voidedTotal: 'Voided Orders Total',
            grossSales: 'Gross Sales',
            discounts: 'Total Discounts',
            netBeforeTax: 'Net Before Tax',
            vatLabel: `Output VAT ${vatPct}%`,
            netSales: 'Net Sales (Incl. VAT)',
            payHeader: 'Sales by Payment Method',
            cash: 'Cash',
            qr: isLaos ? 'LAOQR / OnePay' : 'PromptPay QR',
            card: 'Card / EDC',
            voucher: 'Voucher',
            drawerHeader: 'Cash Drawer Reconciliation',
            opening: 'Opening Float',
            cashInSale: '+ Cash Sales',
            paidIn: '+ Paid-In',
            paidOut: '- Paid-Out',
            cashDrop: '- Safe Cash Drop',
            expected: 'Expected Cash',
            counted: 'Counted Cash',
            variance: 'Cash Variance',
            signCashier: 'Cashier:',
            signManager: 'Manager:',
          }
        : {
            title: 'ใบสรุปยอดขายและกระทบยอดประจำกะ (Z-REPORT)',
            taxLine: `${isLaos ? 'TIN' : 'TAX ID'}: ${input.taxId || '-'}${!isLaos && input.branchCode ? ` (สาขา ${input.branchCode})` : ''}`,
            shiftPrefix: 'เลขกะ:',
            statusPrefix: 'สถานะ:',
            opened: 'เปิดกะ:',
            closed: 'ปิดกะ:',
            printedBy: 'ผู้พิมพ์:',
            bills: 'บิลขายสำเร็จ / ยกเลิก',
            billUnit: 'บิล',
            voidedTotal: 'มูลค่าบิลยกเลิกรวม',
            grossSales: 'ยอดขายก่อนส่วนลด',
            discounts: 'ส่วนลดรวม',
            netBeforeTax: 'มูลค่าก่อนภาษี (Net)',
            vatLabel: `ภาษีขาย VAT ${vatPct}%`,
            netSales: 'ยอดขายสุทธิรวม VAT',
            payHeader: 'แยกตามช่องทางรับชำระเงิน',
            cash: 'เงินสด (Cash)',
            qr: isLaos ? 'LAOQR / BCEL OnePay' : 'พร้อมเพย์ (PromptPay QR)',
            card: 'บัตรเครดิต / EDC',
            voucher: 'คูปองเงินสด (Voucher)',
            drawerHeader: 'สมการกระทบยอดเงินสดในลิ้นชัก',
            opening: 'เงินทอนตั้งต้นเปิดกะ',
            cashInSale: '+ รับเงินสดจากการขาย',
            paidIn: '+ นำเงินสดเข้า (Paid-In)',
            paidOut: '- จ่ายเงินสดย่อย (Paid-Out)',
            cashDrop: '- เก็บเงินเข้าเซฟ (Drop)',
            expected: 'เงินสดคาดหวัง (Expected)',
            counted: 'เงินสดนับจริง (Counted)',
            variance: 'ผลต่างเงินสด (Variance)',
            signCashier: 'ลงชื่อแคชเชียร์:',
            signManager: 'ผู้จัดการ:',
          };

  return renderLayoutTo203DpiPackedRaster(
    widthPx,
    padX,
    240,
    '203-DPI Z-Report rasterization',
    (d) => {
      d.drawCentered(input.storeName, titleSize, true);
      if (input.storeAddress && input.storeAddress.trim()) {
        d.drawCentered(input.storeAddress.trim(), smallSize, false);
      }
      d.drawCentered(L.title, smallSize, true);
      d.drawCentered(L.taxLine, smallSize, false);
      if (input.posRegNo && input.posRegNo.trim()) {
        d.drawCentered(`POS REG: ${input.posRegNo}`, smallSize, false);
      }
      d.advance(4);
      d.drawLeftRight(`${L.shiftPrefix} ${input.shiftNumber}`, `${L.statusPrefix} ${input.status}`, smallSize, true);
      d.drawLeftRight(L.opened, input.openedAtText, smallSize, false);
      d.drawLeftRight(L.closed, input.closedAtText, smallSize, false);
      d.drawLeftRight(L.printedBy, input.printedByName, smallSize, false);

      d.drawDivider();

      d.drawLeftRight(
        L.bills,
        `${input.completedOrdersCount} / ${input.voidedOrdersCount} ${L.billUnit}`,
        bodySize,
        false
      );
      if (input.voidedOrdersCount > 0) {
        d.drawLeftRight(L.voidedTotal, input.voidedTotalText, smallSize, false);
      }
      d.drawLeftRight(L.grossSales, input.grossSalesText, bodySize, false);
      d.drawLeftRight(L.discounts, `-${input.discountsText}`, bodySize, false);
      d.drawLeftRight(L.netBeforeTax, input.netBeforeTaxText, smallSize, false);
      d.drawLeftRight(L.vatLabel, input.vat7PercentText, smallSize, false);
      d.advance(4);
      d.drawLeftRight(L.netSales, input.netSalesTotalText, totalSize, true);

      d.drawDivider();

      d.drawCentered(L.payHeader, smallSize, true);
      d.drawLeftRight(L.cash, input.cashSalesText, bodySize, false);
      d.drawLeftRight(L.qr, input.promptPaySalesText, bodySize, false);
      d.drawLeftRight(L.card, input.cardSalesText, bodySize, false);
      d.drawLeftRight(L.voucher, input.voucherSalesText, bodySize, false);

      d.drawDivider();

      d.drawCentered(L.drawerHeader, smallSize, true);
      d.drawLeftRight(L.opening, input.openingCashText, smallSize, false);
      d.drawLeftRight(L.cashInSale, input.cashSalesText, smallSize, false);
      d.drawLeftRight(L.paidIn, input.paidInText, smallSize, false);
      d.drawLeftRight(L.paidOut, input.paidOutText, smallSize, false);
      d.drawLeftRight(L.cashDrop, input.cashDropText, smallSize, false);
      d.advance(4);
      d.drawLeftRight(L.expected, input.expectedCashText, bodySize, true);
      d.drawLeftRight(L.counted, input.countedCashText, bodySize, true);
      d.drawLeftRight(L.variance, input.cashVarianceText, totalSize, true);

      if (input.fxDrawerLines && input.fxDrawerLines.length > 0) {
        d.drawDivider();
        for (const fxLine of input.fxDrawerLines) {
          d.drawWrapped(fxLine, smallSize, false);
        }
      }

      d.drawDivider();
      d.advance(28);
      if (input.paperWidthMm === 58) {
        d.drawWrapped(`${L.signCashier} ....................................`, smallSize, false);
        d.advance(16);
        d.drawWrapped(`${L.signManager} ....................................`, smallSize, false);
      } else {
        d.drawLeftRight(
          `${L.signCashier} ....................`,
          `${L.signManager} ....................`,
          smallSize,
          false
        );
      }
      d.advance(18);
    }
  );
}

export interface CanvasTableQrSlipRenderInput {
  paperWidthMm: 80 | 58;
  receiptLocale?: 'th' | 'lo' | 'en' | undefined;
  storeName: string;
  tableLabel: string;
  menuUrl: string;
  wifiSsid?: string | undefined;
  wifiPassword?: string | undefined;
  wifiSecurity?: 'WPA' | 'NOPASS' | undefined;
  wifiQrPayload?: string | undefined;
  openedByName?: string | undefined;
  openedAtText?: string | undefined;
}

/**
 * Renders a 203-DPI Thermal Table QR Ordering Slip (Step 1: Wi-Fi QR + Step 2: Signed Table Menu QR)
 * with pixel-perfect integer-module QR matrices for crisp 80mm / 58mm thermal printing.
 */
export function renderTableQrSlipTo203DpiCanvasRaster(
  input: CanvasTableQrSlipRenderInput
): PackedCanvasRasterResult {
  const widthPx: 384 | 576 = input.paperWidthMm === 58 ? 384 : 576;
  const padX = input.paperWidthMm === 58 ? 14 : 22;
  const titleSize = input.paperWidthMm === 58 ? 22 : 26;
  const tableSize = input.paperWidthMm === 58 ? 34 : 42;
  const bodySize = input.paperWidthMm === 58 ? 17 : 20;
  const smallSize = input.paperWidthMm === 58 ? 14 : 16;
  const qrSizePx = input.paperWidthMm === 58 ? 220 : 272;
  const locale = input.receiptLocale ?? 'th';

  const L =
    locale === 'lo'
      ? {
          header: 'ໃບເປີດໂຕະສັ່ງອາຫານ (QR ORDER)',
          tablePrefix: 'ໂຕະ',
          step1: '1. ສະແກນເຊື່ອມ Wi-Fi ຮ້ານ',
          step2: '2. ສະແກນເປີດເມນູສັ່ງອາຫານ',
          wifiSsid: 'Wi-Fi:',
          wifiPass: 'ລະຫັດ:',
          openWifi: 'Wi-Fi ເປີດ (ບໍ່ມີລະຫັດ)',
          footer1: 'ສະແກນໄດ້ທັງ iOS & Android',
          footer2: 'QR ໂຕະນີ້ໝົດອາຍຸທັນທີເມື່ອເຊັກບິນ',
        }
      : locale === 'en'
        ? {
            header: 'TABLE QR ORDERING SLIP',
            tablePrefix: 'TABLE',
            step1: '1. Scan to Join Store Wi-Fi',
            step2: '2. Scan to Open Menu & Order',
            wifiSsid: 'Wi-Fi:',
            wifiPass: 'Pass:',
            openWifi: 'Open Wi-Fi (No Password)',
            footer1: 'Works on iOS & Android Camera',
            footer2: 'This Table QR expires upon bill settlement',
          }
        : {
            header: 'ใบเปิดโต๊ะสั่งอาหาร (QR TABLE ORDER)',
            tablePrefix: 'โต๊ะ',
            step1: '1. สแกนเชื่อม Wi-Fi ร้าน',
            step2: '2. สแกนเปิดเมนูสั่งอาหาร',
            wifiSsid: 'Wi-Fi:',
            wifiPass: 'รหัสผ่าน:',
            openWifi: 'Wi-Fi เปิด (ไม่มีรหัสผ่าน)',
            footer1: 'สแกนได้ทันทีด้วยกล้อง iOS & Android',
            footer2: 'QR ประจำโต๊ะจะหมดอายุเมื่อชำระเงินปิดบิล',
          };

  return renderLayoutTo203DpiPackedRaster(
    widthPx,
    padX,
    240,
    '203-DPI Table QR slip rasterization',
    (d) => {
      d.drawCentered(input.storeName, titleSize, true);
      d.drawCentered(L.header, smallSize, true);
      d.drawDivider();
      d.drawCentered(`${L.tablePrefix} ${input.tableLabel}`, tableSize, true);
      if (input.openedAtText) {
        d.drawCentered(input.openedAtText, smallSize, false);
      }
      d.drawDivider();

      if (input.wifiQrPayload && input.wifiQrPayload.trim()) {
        d.drawCentered(L.step1, bodySize, true);
        d.advance(4);
        d.drawQrMatrix(input.wifiQrPayload, qrSizePx);
        if (input.wifiSsid) {
          d.drawCentered(`${L.wifiSsid} ${input.wifiSsid}`, smallSize, true);
        }
        if (input.wifiSecurity === 'NOPASS') {
          d.drawCentered(L.openWifi, smallSize, false);
        } else if (input.wifiPassword) {
          d.drawCentered(`${L.wifiPass} ${input.wifiPassword}`, smallSize, false);
        }
        d.drawDivider();
      }

      d.drawCentered(L.step2, bodySize, true);
      d.advance(4);
      d.drawQrMatrix(input.menuUrl, qrSizePx);
      d.drawCentered(input.menuUrl.replace(/[?&]s=[^&]+/, ''), smallSize, false);
      d.drawDivider();
      d.drawCentered(L.footer1, smallSize, true);
      d.drawCentered(L.footer2, smallSize, false);
      if (input.openedByName) {
        d.advance(4);
        d.drawCentered(`Staff: ${input.openedByName}`, smallSize, false);
      }
      d.advance(18);
    }
  );
}
