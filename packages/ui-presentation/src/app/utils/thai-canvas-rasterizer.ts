/**
 * RUBE-STOCK-POS v3.1 True 203-DPI HTML5 `<canvas>` Thai Receipt Monochrome Rasterizer
 *
 * Uses WebView2 / Chromium's native HarfBuzz + DirectWrite font shaping engine to render
 * stacked Thai vowels and tone marks (`ที่`, `น้ำ`, `กู้`, `ปิ้ง`, `ใบกำกับภาษีอย่างย่อ`) onto a crisp
 * 203-DPI `<canvas>` (`576px` for 80mm paper, `384px` for 58mm paper) with ZERO floating vowels (`สระลอย`),
 * then packs pixels into a 1-bit monochrome bitmap (`1` = black dot, `0` = white paper) ready for
 * chunked `GS v 0` ESC/POS transmission over LAN TCP `:9100` or Windows Raw USB Spooler!
 */

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

/**
 * Renders a Thai Simplified Tax Invoice (ABB) onto an offscreen 203-DPI `<canvas>` and packs a 1-bit monochrome bitmap.
 */
export function renderThaiReceiptTo203DpiCanvasRaster(
  input: CanvasReceiptRenderInput
): PackedCanvasRasterResult {
  const widthPx: 384 | 576 = input.paperWidthMm === 58 ? 384 : 576;
  const padX = input.paperWidthMm === 58 ? 14 : 22;
  const fontFamily = '"Noto Sans Thai", "Leelawadee UI", "Tahoma", sans-serif';
  const bodySize = input.paperWidthMm === 58 ? 18 : 21;
  const smallSize = input.paperWidthMm === 58 ? 15 : 17;
  const titleSize = input.paperWidthMm === 58 ? 22 : 26;
  const totalSize = input.paperWidthMm === 58 ? 25 : 30;
  const lineStep = input.paperWidthMm === 58 ? 28 : 32;

  // Estimate required height dynamically
  const estimatedRows =
    14 +
    input.lines.reduce((acc, l) => acc + (l.modifiersText ? 2 : 1), 0) +
    input.paymentSummaryLines.length;
  const rawHeight = Math.max(420, estimatedRows * lineStep + 96);
  // Align height to multiple of 8 dots for clean band slicing
  const heightPx = Math.ceil(rawHeight / 8) * 8;

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('2D Canvas context unavailable for 203-DPI Thai receipt rasterization');
  }

  // Pure white paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  let y = 20;

  const drawCentered = (text: string, size: number, bold = false) => {
    ctx.font = `${bold ? '700' : '500'} ${size}px ${fontFamily}`;
    const m = ctx.measureText(text);
    const x = Math.max(padX, Math.floor((widthPx - m.width) / 2));
    ctx.fillText(text, x, y);
    y += Math.round(size * 1.48);
  };

  const drawLeftRight = (left: string, right: string, size: number, bold = false) => {
    ctx.font = `${bold ? '700' : '500'} ${size}px ${fontFamily}`;
    const rightWidth = ctx.measureText(right).width;
    const maxLeftWidth = widthPx - padX * 2 - rightWidth - 12;
    let clippedLeft = left;
    while (clippedLeft.length > 2 && ctx.measureText(clippedLeft).width > maxLeftWidth) {
      clippedLeft = `${clippedLeft.slice(0, -2)}…`;
    }
    ctx.fillText(clippedLeft, padX, y);
    ctx.fillText(right, widthPx - padX - rightWidth, y);
    y += Math.round(size * 1.45);
  };

  const drawDivider = () => {
    y += 6;
    ctx.fillRect(padX, y, widthPx - padX * 2, 2);
    y += 12;
  };

  // Header
  drawCentered(input.storeName, titleSize, true);
  drawCentered('ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ (ABB)', smallSize, true);
  drawCentered(`TAX ID: ${input.taxId} (สาขา ${input.branchCode})`, smallSize, false);
  drawCentered(`POS REG: ${input.posRegNo}`, smallSize, false);
  y += 4;
  drawLeftRight(`เลขที่: ${input.abbTaxInvoiceNo}`, input.createdAtText, smallSize, false);
  drawLeftRight(`บิล: ${input.receiptNumber}`, `พนักงาน: ${input.cashierName}`, smallSize, false);

  drawDivider();

  // Order Items
  for (const line of input.lines) {
    drawLeftRight(`${line.itemName} (${line.qtyText})`, line.totalText, bodySize, false);
    if (line.modifiersText) {
      ctx.font = `400 ${smallSize}px ${fontFamily}`;
      ctx.fillText(`  + ${line.modifiersText}`, padX, y);
      y += Math.round(smallSize * 1.4);
    }
  }

  drawDivider();

  // Totals & VAT 7%
  drawLeftRight('ยอดรวมสินค้า', input.subtotalText, bodySize, false);
  if (input.discountText !== '฿0.00') {
    drawLeftRight('ส่วนลดท้ายบิล', `-${input.discountText}`, bodySize, false);
  }
  drawLeftRight('มูลค่าก่อนภาษี (Net)', input.netBeforeTaxText, smallSize, false);
  drawLeftRight('ภาษีมูลค่าเพิ่ม (VAT 7%)', input.vatText, smallSize, false);
  y += 4;
  drawLeftRight('ยอดสุทธิ (TOTAL)', input.grandTotalText, totalSize, true);

  drawDivider();

  for (const payLine of input.paymentSummaryLines) {
    ctx.font = `500 ${smallSize}px ${fontFamily}`;
    ctx.fillText(payLine, padX, y);
    y += Math.round(smallSize * 1.45);
  }

  y += 14;
  drawCentered('VAT INCLUDED · ขอบคุณที่ใช้บริการ', smallSize, true);
  y += 20;

  // Crop canvas height to actual content height (aligned to 8px)
  const finalHeightPx = Math.min(heightPx, Math.max(160, Math.ceil(y / 8) * 8));
  const imgData = ctx.getImageData(0, 0, widthPx, finalHeightPx);
  const rgba = imgData.data;
  const widthBytes = widthPx / 8;
  const packed = new Uint8Array(widthBytes * finalHeightPx);

  // Convert RGBA -> 1-bit Monochrome (`1` = black dot, `0` = white paper)
  // Also rewrite `imgData` to crisp monochrome so the UI preview shows exact thermal dot output!
  for (let row = 0; row < finalHeightPx; row++) {
    for (let byteIdx = 0; byteIdx < widthBytes; byteIdx++) {
      let maskByte = 0;
      for (let bit = 0; bit < 8; bit++) {
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
      packed[row * widthBytes + byteIdx] = maskByte;
    }
  }

  // Create cropped preview data URL
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = widthPx;
  previewCanvas.height = finalHeightPx;
  const previewCtx = previewCanvas.getContext('2d');
  if (previewCtx) {
    previewCtx.putImageData(imgData, 0, 0);
  }

  return {
    widthPx,
    heightPx: finalHeightPx,
    packedBitmapBase64: uint8ArrayToBase64(packed),
    previewDataUrl: previewCanvas.toDataURL('image/png'),
  };
}
