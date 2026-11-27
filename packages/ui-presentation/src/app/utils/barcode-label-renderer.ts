/**
 * RUBE-STOCK-POS v3.1 Product Barcode Label Renderer
 *
 * Provides three 100%-offline rendering targets:
 * 1. Crisp inline SVG vector barcode markup (`renderBarcodeSvgMarkup`) for live UI cards & A4/Thermal print dialogs.
 * 2. 203-DPI `<canvas>` 1-bit monochrome bitmap rasterizer (`renderBarcodeLabelTo203DpiCanvasRaster`)
 *    with HarfBuzz/DirectWrite Thai/Lao font shaping (zero floating vowels) & integer-pixel-aligned bars
 *    ready for TSPL2, ZPL II, and ESC/POS thermal hardware dispatch.
 * 3. Printable HTML sheet/roll generator (`openBarcodeLabelPrintWindow`) supporting A4 sticker grids
 *    (30-up, 24-up, 44-up with skip-used-slots offset) and exact-size thermal label rolls.
 */

import QRCode from 'qrcode';
import {
  encodeCode128Modules,
  resolveBarcodeEncoding,
  type BarcodeModuleEncoding,
  type Resolved1DBarcodeFormat,
} from '../../../../hal-drivers/src/barcode/mod.ts';
import {
  getBarcodeLabelSizePreset,
  type BarcodeLabelPrintItemDto,
  type BarcodeLabelSizePreset,
  type BarcodeLabelSizePresetId,
  type BarcodeLabelTemplateOptions,
  type BarcodeSymbology,
} from '../../../../shared-contracts/src/barcode-printing.ts';
import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import {
  packTileCanvasToMonochrome,
  THERMAL_FONT_FAMILY,
  uint8ArrayToBase64,
  wrapTextLines,
} from './thai-canvas-rasterizer.ts';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isDefaultVariantLabel(name: string): boolean {
  const clean = name.trim();
  const low = clean.toLowerCase();
  return clean === 'ปกติ' || clean === 'ປົກກະຕິ' || low === 'standard' || low === 'default';
}

export function getLocalizedBarcodePresetLabel(
  preset: BarcodeLabelSizePreset,
  locale: LocaleCode
): string {
  if (locale === 'lo') return preset.labelLo;
  if (locale === 'en') return preset.labelEn;
  return preset.labelTh;
}

export interface EncodedSvgBarcodeResult {
  svgMarkup: string;
  resolvedFormat: Resolved1DBarcodeFormat | 'QR_CODE';
  displayValue: string;
  fallbackNotice?: string | undefined;
}

function resolveWithFallback(
  rawValue: string,
  symbology: BarcodeSymbology
): { encoding: BarcodeModuleEncoding; fallbackNotice?: string | undefined } {
  try {
    return { encoding: resolveBarcodeEncoding(rawValue, symbology) };
  } catch (err) {
    const fallback = encodeCode128Modules(rawValue);
    return {
      encoding: fallback,
      fallbackNotice: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generates crisp pure-SVG barcode markup (1D EAN-13 / EAN-8 / Code 128 or 2D QR Code)
 * with exact integer module geometry (`shape-rendering="crispEdges"`).
 */
export function renderBarcodeSvgMarkup(params: {
  value: string;
  symbology: BarcodeSymbology;
  showText?: boolean | undefined;
  heightUnits?: number | undefined;
  className?: string | undefined;
}): EncodedSvgBarcodeResult {
  const cleanVal = params.value.trim() || 'NO-CODE';
  const showText = params.showText !== false;

  if (params.symbology === 'QR_CODE') {
    const qr = QRCode.create(cleanVal, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const qz = 2;
    const total = count + qz * 2;
    const rects: string[] = [];
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.modules.get(r, c)) {
          rects.push(`<rect x="${c + qz}" y="${r + qz}" width="1" height="1" />`);
        }
      }
    }
    const clsAttr = params.className ? ` class="${escHtml(params.className)}"` : '';
    const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"${clsAttr}><rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#000000">${rects.join('')}</g></svg>`;
    return {
      svgMarkup,
      resolvedFormat: 'QR_CODE',
      displayValue: cleanVal,
    };
  }

  const { encoding, fallbackNotice } = resolveWithFallback(cleanVal, params.symbology);
  const qz = encoding.quietZoneModules;
  const totalWidth = encoding.modules.length + qz * 2;
  const barHeight = Math.max(24, Math.trunc(params.heightUnits ?? 40));
  const guardExtra =
    encoding.format === 'EAN_13' || encoding.format === 'EAN_8' ? 5 : 0;
  const textZone = showText ? 12 : 0;
  const totalHeight = barHeight + guardExtra + textZone + 2;

  // Coalesce contiguous 1-modules into single <rect> elements for sharp rendering and small SVG size
  const normalRuns: string[] = [];
  const guardRuns: string[] = [];

  let i = 0;
  while (i < encoding.modules.length) {
    if (encoding.modules[i] === 1) {
      const isGuard = encoding.guardMask[i] === true;
      let runLen = 1;
      while (
        i + runLen < encoding.modules.length &&
        encoding.modules[i + runLen] === 1 &&
        (encoding.guardMask[i + runLen] === true) === isGuard
      ) {
        runLen += 1;
      }
      const x = qz + i;
      const h = isGuard ? barHeight + guardExtra : barHeight;
      const rect = `<rect x="${x}" y="1" width="${runLen}" height="${h}" />`;
      if (isGuard) {
        guardRuns.push(rect);
      } else {
        normalRuns.push(rect);
      }
      i += runLen;
    } else {
      i += 1;
    }
  }

  let digitsSvg = '';
  if (showText) {
    const textY = barHeight + guardExtra + 10;
    if (encoding.format === 'EAN_13') {
      const d = encoding.displayDigits;
      const fontSz = 9;
      digitsSvg = [
        `<text x="${qz - 2}" y="${textY}" text-anchor="end" font-family="Consolas, monospace" font-size="${fontSz}" font-weight="600" fill="#000000">${escHtml(d[0] ?? '')}</text>`,
        `<text x="${qz + 24}" y="${textY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${fontSz}" font-weight="600" letter-spacing="0.8" fill="#000000">${escHtml(d.slice(1, 7))}</text>`,
        `<text x="${qz + 71}" y="${textY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${fontSz}" font-weight="600" letter-spacing="0.8" fill="#000000">${escHtml(d.slice(7, 13))}</text>`,
      ].join('');
    } else if (encoding.format === 'EAN_8') {
      const d = encoding.displayDigits;
      const fontSz = 9;
      digitsSvg = [
        `<text x="${qz + 17}" y="${textY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${fontSz}" font-weight="600" letter-spacing="0.6" fill="#000000">${escHtml(d.slice(0, 4))}</text>`,
        `<text x="${qz + 50}" y="${textY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${fontSz}" font-weight="600" letter-spacing="0.6" fill="#000000">${escHtml(d.slice(4, 8))}</text>`,
      ].join('');
    } else {
      const textLen = encoding.displayDigits.length;
      const fontSz = textLen > 20 ? 7.5 : 8.5;
      digitsSvg = `<text x="${totalWidth / 2}" y="${textY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${fontSz}" font-weight="600" fill="#000000">${escHtml(encoding.displayDigits)}</text>`;
    }
  }

  const clsAttr = params.className ? ` class="${escHtml(params.className)}"` : '';
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"${clsAttr}><rect width="${totalWidth}" height="${totalHeight}" fill="#ffffff"/><g fill="#000000">${normalRuns.join('')}${guardRuns.join('')}</g>${digitsSvg}</svg>`;

  return {
    svgMarkup,
    resolvedFormat: encoding.format,
    displayValue: encoding.displayDigits,
    ...(fallbackNotice ? { fallbackNotice } : {}),
  };
}

export interface Rendered203DpiBarcodeLabel {
  widthPx: number;
  heightPx: number;
  labelWidthMm: number;
  labelHeightMm: number;
  packedBitmapBase64: string;
  previewDataUrl: string;
  resolvedFormat: Resolved1DBarcodeFormat | 'QR_CODE';
  displayValue: string;
}

function truncateTextToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const wrapped = wrapTextLines(ctx, text, Math.max(24, maxWidth - 10));
  const first = wrapped[0] ?? text;
  if (wrapped.length <= 1 && ctx.measureText(first).width <= maxWidth) return first;
  return `${first.trimEnd()}…`;
}

/**
 * Renders a single product barcode sticker onto an exact 203-DPI `<canvas>`
 * and packs it into a 1-bit monochrome MSB-first bitmap (`1` = black dot, `0` = white paper)
 * ready for TSPL2, ZPL II, or ESC/POS receipt printer hardware dispatch.
 */
export function renderBarcodeLabelTo203DpiCanvasRaster(params: {
  presetId: BarcodeLabelSizePresetId;
  storeName: string;
  item: BarcodeLabelPrintItemDto;
  template: BarcodeLabelTemplateOptions;
}): Rendered203DpiBarcodeLabel {
  const preset = getBarcodeLabelSizePreset(params.presetId);
  const widthPx = preset.widthPx203Dpi;
  const heightPx = preset.heightPx203Dpi;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('2D Canvas context unavailable for 203-DPI barcode label rasterization');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  const compact = heightPx <= 210 || widthPx <= 280;
  const padX = compact ? 10 : 14;
  const padY = compact ? 8 : 10;
  const contentWidth = widthPx - padX * 2;
  const smallFontPx = compact ? 13 : heightPx >= 280 ? 17 : 15;
  const titleFontPx = compact ? 16 : heightPx >= 280 ? 22 : 19;
  const priceFontPx = compact ? 18 : heightPx >= 280 ? 28 : 23;
  const digitFontPx = compact ? 14 : 16;

  const displayName =
    params.template.showVariantName &&
    params.item.variantName &&
    !isDefaultVariantLabel(params.item.variantName)
      ? `${params.item.itemName} (${params.item.variantName})`
      : params.item.itemName;

  if (params.template.symbology === 'QR_CODE') {
    const qr = QRCode.create(params.item.barcodeValue.trim() || params.item.sku, {
      errorCorrectionLevel: 'M',
    });
    const modCount = qr.modules.size;
    const maxQrBox = Math.min(heightPx - padY * 2 - 4, Math.floor(widthPx * 0.44));
    const qz = 1;
    const modPx = Math.max(2, Math.floor(maxQrBox / (modCount + qz * 2)));
    const actualQrSize = (modCount + qz * 2) * modPx;
    const qrX = padX;
    const qrY = Math.max(padY, Math.floor((heightPx - actualQrSize) / 2));

    ctx.fillStyle = '#000000';
    for (let r = 0; r < modCount; r += 1) {
      for (let c = 0; c < modCount; c += 1) {
        if (qr.modules.get(r, c)) {
          ctx.fillRect(
            qrX + (c + qz) * modPx,
            qrY + (r + qz) * modPx,
            modPx,
            modPx
          );
        }
      }
    }

    const rightX = qrX + actualQrSize + 10;
    const rightWidth = Math.max(40, widthPx - rightX - padX);
    let ry = padY;

    if (params.template.showStoreName && params.storeName.trim()) {
      ctx.font = `600 ${smallFontPx}px ${THERMAL_FONT_FAMILY}`;
      ctx.fillText(truncateTextToWidth(ctx, params.storeName.trim(), rightWidth), rightX, ry);
      ry += Math.round(smallFontPx * 1.25);
    }
    if (params.template.showItemName) {
      ctx.font = `700 ${titleFontPx}px ${THERMAL_FONT_FAMILY}`;
      const lines = wrapTextLines(ctx, displayName, rightWidth).slice(0, 2);
      for (const ln of lines) {
        ctx.fillText(ln, rightX, ry);
        ry += Math.round(titleFontPx * 1.25);
      }
    }
    if (params.item.customSubLabel) {
      ctx.font = `600 ${smallFontPx}px ${THERMAL_FONT_FAMILY}`;
      ctx.fillText(truncateTextToWidth(ctx, params.item.customSubLabel, rightWidth), rightX, ry);
      ry += Math.round(smallFontPx * 1.25);
    }
    if (params.template.showBarcodeText || params.template.showSku) {
      const codeStr = params.template.showBarcodeText
        ? params.item.barcodeValue
        : params.item.sku;
      ctx.font = `500 ${Math.max(12, smallFontPx - 1)}px ${THERMAL_FONT_FAMILY}`;
      ctx.fillText(truncateTextToWidth(ctx, codeStr, rightWidth), rightX, ry);
    }
    if (params.template.showPrice) {
      ctx.font = `700 ${priceFontPx}px ${THERMAL_FONT_FAMILY}`;
      const priceStr = params.template.showUnit && params.item.unitName
        ? `${params.item.priceFormatted}/${params.item.unitName}`
        : params.item.priceFormatted;
      const m = ctx.measureText(priceStr);
      ctx.fillText(
        truncateTextToWidth(ctx, priceStr, rightWidth),
        Math.max(rightX, widthPx - padX - Math.min(m.width, rightWidth)),
        heightPx - padY - priceFontPx - 2
      );
    }

    const packed = new Uint8Array((widthPx / 8) * heightPx);
    packTileCanvasToMonochrome(ctx, widthPx, heightPx, packed, 0);
    return {
      widthPx,
      heightPx,
      labelWidthMm: preset.widthMm,
      labelHeightMm: preset.heightMm,
      packedBitmapBase64: uint8ArrayToBase64(packed),
      previewDataUrl: canvas.toDataURL('image/png'),
      resolvedFormat: 'QR_CODE',
      displayValue: params.item.barcodeValue,
    };
  }

  // 1D Barcode Layout
  let cursorY = padY;

  if (params.template.showStoreName && params.storeName.trim()) {
    ctx.font = `600 ${smallFontPx}px ${THERMAL_FONT_FAMILY}`;
    ctx.fillText(truncateTextToWidth(ctx, params.storeName.trim(), contentWidth), padX, cursorY);
    cursorY += Math.round(smallFontPx * 1.28);
  }

  if (params.template.showItemName) {
    ctx.font = `700 ${titleFontPx}px ${THERMAL_FONT_FAMILY}`;
    const maxTitleLines = heightPx >= 260 ? 2 : 1;
    const titleLines = wrapTextLines(ctx, displayName, contentWidth).slice(0, maxTitleLines);
    for (const ln of titleLines) {
      ctx.fillText(ln, padX, cursorY);
      cursorY += Math.round(titleFontPx * 1.24);
    }
  }

  if (params.item.customSubLabel) {
    ctx.font = `600 ${smallFontPx}px ${THERMAL_FONT_FAMILY}`;
    ctx.fillText(truncateTextToWidth(ctx, params.item.customSubLabel, contentWidth), padX, cursorY);
    cursorY += Math.round(smallFontPx * 1.22);
  }

  const hasFooter = params.template.showPrice || params.template.showSku;
  const footerHeight = hasFooter ? Math.max(priceFontPx + 6, smallFontPx + 8) : 0;
  const barcodeZoneTop = cursorY + 3;
  const barcodeZoneBottom = heightPx - padY - footerHeight;
  const barcodeTextHeight = params.template.showBarcodeText ? digitFontPx + 4 : 0;
  const guardExtPx = 5;
  const rawBarHeight = Math.max(
    36,
    barcodeZoneBottom - barcodeZoneTop - barcodeTextHeight - guardExtPx
  );

  const { encoding } = resolveWithFallback(
    params.item.barcodeValue.trim() || params.item.sku,
    params.template.symbology
  );

  const totalModules = encoding.modules.length + encoding.quietZoneModules * 2;
  const modulePx = Math.max(1, Math.floor(contentWidth / totalModules));
  const drawnModulesWidth = encoding.modules.length * modulePx;
  const startX = Math.max(padX, Math.floor((widthPx - drawnModulesWidth) / 2));

  ctx.fillStyle = '#000000';
  for (let i = 0; i < encoding.modules.length; i += 1) {
    if (encoding.modules[i] === 1) {
      const extra =
        (encoding.format === 'EAN_13' || encoding.format === 'EAN_8') &&
        encoding.guardMask[i] &&
        params.template.showBarcodeText
          ? guardExtPx
          : 0;
      ctx.fillRect(
        startX + i * modulePx,
        barcodeZoneTop,
        modulePx,
        rawBarHeight + extra
      );
    }
  }

  if (params.template.showBarcodeText) {
    ctx.font = `700 ${digitFontPx}px Consolas, "Courier New", monospace`;
    const digitText = encoding.displayDigits;
    const digitW = ctx.measureText(digitText).width;
    const digitX = Math.max(padX, Math.floor((widthPx - digitW) / 2));
    const digitY = barcodeZoneTop + rawBarHeight + 4;
    ctx.fillText(truncateTextToWidth(ctx, digitText, contentWidth), digitX, digitY);
  }

  if (hasFooter) {
    const footerBottomY = heightPx - padY;
    if (params.template.showPrice) {
      ctx.font = `700 ${priceFontPx}px ${THERMAL_FONT_FAMILY}`;
      const priceStr =
        params.template.showUnit && params.item.unitName
          ? `${params.item.priceFormatted} / ${params.item.unitName}`
          : params.item.priceFormatted;
      const priceW = ctx.measureText(priceStr).width;
      const priceX = Math.max(padX, widthPx - padX - priceW);
      const priceY = footerBottomY - priceFontPx - 1;
      ctx.fillText(priceStr, priceX, priceY);

      if (params.template.showSku && params.item.sku) {
        const maxSkuW = Math.max(0, priceX - padX - 8);
        if (maxSkuW >= 48) {
          ctx.font = `500 ${Math.max(12, smallFontPx - 1)}px ${THERMAL_FONT_FAMILY}`;
          ctx.fillText(
            truncateTextToWidth(ctx, `SKU: ${params.item.sku}`, maxSkuW),
            padX,
            footerBottomY - smallFontPx - 2
          );
        }
      }
    } else if (params.template.showSku && params.item.sku) {
      ctx.font = `500 ${smallFontPx}px ${THERMAL_FONT_FAMILY}`;
      ctx.fillText(
        truncateTextToWidth(ctx, `SKU: ${params.item.sku}`, contentWidth),
        padX,
        footerBottomY - smallFontPx - 2
      );
    }
  }

  const packed = new Uint8Array((widthPx / 8) * heightPx);
  packTileCanvasToMonochrome(ctx, widthPx, heightPx, packed, 0);

  return {
    widthPx,
    heightPx,
    labelWidthMm: preset.widthMm,
    labelHeightMm: preset.heightMm,
    packedBitmapBase64: uint8ArrayToBase64(packed),
    previewDataUrl: canvas.toDataURL('image/png'),
    resolvedFormat: encoding.format,
    displayValue: encoding.displayDigits,
  };
}

export interface BarcodePrintWindowInput {
  storeName: string;
  locale: LocaleCode;
  presetId: BarcodeLabelSizePresetId;
  template: BarcodeLabelTemplateOptions;
  items: ReadonlyArray<BarcodeLabelPrintItemDto>;
  startSlotOffset?: number | undefined;
  showCutBorders?: boolean | undefined;
}

function buildSingleLabelCardHtml(
  item: BarcodeLabelPrintItemDto,
  storeName: string,
  template: BarcodeLabelTemplateOptions,
  preset: BarcodeLabelSizePreset
): string {
  const isMini = preset.heightMm <= 26 || preset.widthMm <= 48;
  const displayName =
    template.showVariantName && item.variantName && !isDefaultVariantLabel(item.variantName)
      ? `${item.itemName} (${item.variantName})`
      : item.itemName;

  const svgRes = renderBarcodeSvgMarkup({
    value: item.barcodeValue || item.sku,
    symbology: template.symbology,
    showText: template.showBarcodeText,
    heightUnits: isMini ? 32 : 40,
    className: template.symbology === 'QR_CODE' ? 'qr-svg' : 'barcode-svg',
  });

  if (template.symbology === 'QR_CODE') {
    return `
      <div class="label-card qr-layout ${isMini ? 'is-mini' : ''}">
        <div class="qr-left">${svgRes.svgMarkup}</div>
        <div class="qr-right">
          ${template.showStoreName && storeName.trim() ? `<div class="store-line">${escHtml(storeName.trim())}</div>` : ''}
          ${template.showItemName ? `<div class="name-line">${escHtml(displayName)}</div>` : ''}
          ${item.customSubLabel ? `<div class="sub-line">${escHtml(item.customSubLabel)}</div>` : ''}
          ${template.showSku ? `<div class="sku-line">SKU: ${escHtml(item.sku)}</div>` : ''}
          ${template.showBarcodeText ? `<div class="code-line">${escHtml(svgRes.displayValue)}</div>` : ''}
          ${
            template.showPrice
              ? `<div class="price-line">${escHtml(item.priceFormatted)}${template.showUnit && item.unitName ? `<span class="unit-tag">/${escHtml(item.unitName)}</span>` : ''}</div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  return `
    <div class="label-card ${isMini ? 'is-mini' : ''}">
      <div class="label-top">
        ${template.showStoreName && storeName.trim() ? `<div class="store-line">${escHtml(storeName.trim())}</div>` : ''}
        ${template.showItemName ? `<div class="name-line">${escHtml(displayName)}</div>` : ''}
        ${item.customSubLabel ? `<div class="sub-line">${escHtml(item.customSubLabel)}</div>` : ''}
      </div>
      <div class="barcode-wrap">${svgRes.svgMarkup}</div>
      ${
        template.showPrice || template.showSku
          ? `<div class="label-foot">
               <span class="sku-line">${template.showSku ? `SKU: ${escHtml(item.sku)}` : ''}</span>
               ${
                 template.showPrice
                   ? `<span class="price-line">${escHtml(item.priceFormatted)}${template.showUnit && item.unitName ? `<span class="unit-tag">/${escHtml(item.unitName)}</span>` : ''}</span>`
                   : ''
               }
             </div>`
          : ''
      }
    </div>
  `;
}

/**
 * Opens an offline print-ready HTML window for either:
 * - A4 sticker sheets (`A4_30UP`, `A4_24UP`, `A4_44UP`) with optional `startSlotOffset` to reuse partial sheets
 * - Direct thermal sticker roll page sizing (`50x30mm`, `40x30mm`, `32x25mm`, `60x40mm`, `RECEIPT_80MM`, `RECEIPT_58MM`)
 */
export function openBarcodeLabelPrintWindow(input: BarcodePrintWindowInput): boolean {
  const preset = getBarcodeLabelSizePreset(input.presetId);
  const expanded: BarcodeLabelPrintItemDto[] = [];
  for (const item of input.items) {
    const count = Math.max(0, Math.min(500, Math.trunc(item.copies)));
    for (let c = 0; c < count; c += 1) {
      expanded.push(item);
    }
  }
  if (expanded.length === 0) {
    return false;
  }

  const labels =
    input.locale === 'lo'
      ? {
          title: 'ພິມປ້າຍບາໂຄດສິນຄ້າ',
          totalLbl: 'ຈຳນວນດວງທັງໝົດ',
          printBtn: 'ສັ່ງພິມບາໂຄດທັນທີ',
          closeBtn: 'ປິດໜ້າຕ່າງ',
          sheetHint: 'ຕັ້ງຄ່າ Margins = None ແລະ Scale = 100% ໃນໜ້າຕ່າງ Print ເພື່ອໃຫ້ຕົງຂະໜາດສູງສຸດ',
        }
      : input.locale === 'en'
        ? {
            title: 'Print Product Barcode Labels',
            totalLbl: 'Total Labels',
            printBtn: 'Print Labels Now',
            closeBtn: 'Close',
            sheetHint: 'Set Margins = None and Scale = 100% in the print dialog for exact sticker alignment.',
          }
        : {
            title: 'พิมพ์สติกเกอร์บาร์โค้ดสินค้า',
            totalLbl: 'จำนวนดวงทั้งหมด',
            printBtn: 'สั่งพิมพ์บาร์โค้ดทันที',
            closeBtn: 'ปิดหน้าต่าง',
            sheetHint: 'แนะนำตั้งค่า Margins = None (ไม่มีขอบ) และ Scale = 100% เพื่อให้ตรงช่องสติกเกอร์ 100%',
          };

  const isA4 = preset.kind === 'A4_SHEET';
  const showCutBorders = input.showCutBorders !== false;
  let bodyMarkup = '';
  let pageCss = '';

  if (isA4) {
    const cols = preset.a4Columns ?? 3;
    const rows = preset.a4Rows ?? 10;
    const perPage = cols * rows;
    const offset = Math.max(0, Math.min(perPage - 1, Math.trunc(input.startSlotOffset ?? 0)));
    const slots: Array<BarcodeLabelPrintItemDto | null> = [
      ...Array.from({ length: offset }, () => null),
      ...expanded,
    ];
    const totalPages = Math.max(1, Math.ceil(slots.length / perPage));
    const pageHtmls: string[] = [];

    for (let p = 0; p < totalPages; p += 1) {
      const slice = slots.slice(p * perPage, (p + 1) * perPage);
      const cells = slice
        .map((it) =>
          it
            ? `<div class="a4-cell">${buildSingleLabelCardHtml(it, input.storeName, input.template, preset)}</div>`
            : `<div class="a4-cell empty-slot"></div>`
        )
        .join('\n');
      pageHtmls.push(`<section class="a4-page">${cells}</section>`);
    }

    bodyMarkup = pageHtmls.join('\n');
    pageCss = `
      @page { size: A4 portrait; margin: 0; }
      .a4-page {
        width: 210mm;
        height: 297mm;
        margin: 0 auto 14px;
        padding: ${preset.a4MarginTopMm ?? 12}mm ${preset.a4MarginLeftMm ?? 6}mm;
        background: #ffffff;
        display: grid;
        grid-template-columns: repeat(${cols}, ${preset.widthMm}mm);
        grid-auto-rows: ${preset.heightMm}mm;
        column-gap: ${preset.a4GapXMm ?? 3}mm;
        row-gap: ${preset.a4GapYMm ?? 1}mm;
        align-content: start;
        border: 1px solid #dadce0;
        page-break-after: always;
        break-after: page;
      }
      .a4-page:last-child { page-break-after: auto; break-after: auto; }
      .a4-cell {
        width: ${preset.widthMm}mm;
        height: ${preset.heightMm}mm;
        overflow: hidden;
        ${showCutBorders ? 'border: 0.25mm dashed #bdc1c6;' : ''}
      }
      .a4-cell.empty-slot { border-color: transparent; }
      @media print {
        body { background: #ffffff; padding: 0; }
        .a4-page { margin: 0; border: none; }
      }
    `;
  } else {
    bodyMarkup = expanded
      .map(
        (it) =>
          `<section class="roll-label-page">${buildSingleLabelCardHtml(it, input.storeName, input.template, preset)}</section>`
      )
      .join('\n');
    pageCss = `
      @page { size: ${preset.widthMm}mm ${preset.heightMm}mm; margin: 0; }
      .roll-label-page {
        width: ${preset.widthMm}mm;
        height: ${preset.heightMm}mm;
        margin: 0 auto 10px;
        background: #ffffff;
        overflow: hidden;
        ${showCutBorders ? 'border: 1px dashed #9aa0a6;' : ''}
        page-break-after: always;
        break-after: page;
      }
      .roll-label-page:last-child { page-break-after: auto; break-after: auto; }
      @media print {
        body { background: #ffffff; padding: 0; }
        .roll-label-page { margin: 0; border: none; }
      }
    `;
  }

  const html = `<!DOCTYPE html>
<html lang="${escHtml(input.locale)}">
<head>
  <meta charset="utf-8" />
  <title>${escHtml(labels.title)} — ${escHtml(input.storeName)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: #f1f3f4;
      color: #202124;
      font-family: "Noto Sans Lao", "Leelawadee UI", "Segoe UI", Tahoma, sans-serif;
    }
    .toolbar {
      max-width: 210mm;
      margin: 0 auto 14px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 16px;
      border: 1px solid #dadce0;
      border-radius: 8px;
      background: #ffffff;
    }
    .toolbar-title { font-size: 15px; font-weight: 700; }
    .toolbar-sub { font-size: 11px; color: #5f6368; margin-top: 2px; }
    .toolbar-actions { display: flex; gap: 8px; }
    .btn {
      height: 38px;
      padding: 0 16px;
      border-radius: 48px;
      border: 1px solid #dadce0;
      background: #ffffff;
      color: #202124;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-primary {
      border-color: #1a73e8;
      background: #1a73e8;
      color: #ffffff;
    }
    .label-card {
      width: 100%;
      height: 100%;
      padding: 1.5mm 2mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background: #ffffff;
      color: #000000;
      overflow: hidden;
    }
    .label-card.is-mini { padding: 1mm 1.5mm; }
    .label-top { flex: 0 0 auto; }
    .store-line {
      font-size: 6.5pt;
      font-weight: 600;
      color: #3c4043;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.15;
    }
    .name-line {
      font-size: 8.5pt;
      font-weight: 700;
      color: #000000;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.2;
    }
    .is-mini .name-line { font-size: 7.5pt; }
    .sub-line {
      font-size: 6.5pt;
      font-weight: 600;
      color: #202124;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .barcode-wrap {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.5mm 0;
    }
    .barcode-svg {
      width: 100%;
      height: 100%;
      max-height: 14mm;
      display: block;
    }
    .is-mini .barcode-svg { max-height: 11mm; }
    .label-foot {
      flex: 0 0 auto;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 4px;
      line-height: 1.1;
    }
    .sku-line {
      font-size: 6.5pt;
      color: #3c4043;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
    }
    .price-line {
      font-size: 10.5pt;
      font-weight: 700;
      color: #000000;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .is-mini .price-line { font-size: 9pt; }
    .unit-tag { font-size: 6.5pt; font-weight: 500; }
    .qr-layout {
      flex-direction: row;
      align-items: center;
      gap: 2mm;
    }
    .qr-left {
      flex: 0 0 auto;
      height: 100%;
      display: flex;
      align-items: center;
    }
    .qr-svg {
      height: 100%;
      max-height: ${Math.max(16, preset.heightMm - 4)}mm;
      width: auto;
      display: block;
    }
    .qr-right {
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .code-line {
      font-size: 6.5pt;
      font-family: Consolas, monospace;
      color: #000000;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    ${pageCss}
    @media print {
      .toolbar { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <div class="toolbar-title">${escHtml(labels.title)} · ${escHtml(getLocalizedBarcodePresetLabel(preset, input.locale))} (${escHtml(labels.totalLbl)}: ${expanded.length})</div>
      <div class="toolbar-sub">${escHtml(labels.sheetHint)}</div>
    </div>
    <div class="toolbar-actions">
      <button type="button" class="btn btn-primary" onclick="window.print()">${escHtml(labels.printBtn)}</button>
      <button type="button" class="btn" onclick="window.close()">${escHtml(labels.closeBtn)}</button>
    </div>
  </div>
  ${bodyMarkup}
</body>
</html>`;

  const printWin = window.open('', '_blank', 'width=980,height=800');
  if (!printWin) {
    return false;
  }
  printWin.document.open();
  printWin.document.write(html);
  printWin.document.close();
  return true;
}
