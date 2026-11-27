import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  Barcode,
  CheckCircle2,
  Eye,
  Layers,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Scale,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildScaleBarcodeEan13,
  generateValidInternalEan13,
  getInternalEan13PrefixForCountry,
} from '../../../../hal-drivers/src/barcode/mod.ts';
import {
  BARCODE_LABEL_SIZE_PRESETS,
  getBarcodeLabelSizePreset,
  normalizeBarcodeLabelConfig,
  type BarcodeLabelPrintItemDto,
  type BarcodeLabelPrinterConfigDto,
  type BarcodeLabelSizePresetId,
  type BarcodeLabelTargetMode,
  type BarcodeLabelTemplateOptions,
  type BarcodeSymbology,
} from '../../../../shared-contracts/src/barcode-printing.ts';
import {
  roundMinorToCurrencyUnit,
  type CurrencyCode,
} from '../../../../shared-contracts/src/currency.ts';
import {
  parseDecimalStringToScaledInt,
  roundDivBigInt,
  SCALE_MILLI,
} from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type {
  BootstrapPayload,
  CatalogVariantDetailDto,
  StaffUserDto,
} from '../types.ts';
import {
  getLocalizedBarcodePresetLabel,
  isDefaultVariantLabel,
  openBarcodeLabelPrintWindow,
  renderBarcodeLabelTo203DpiCanvasRaster,
  renderBarcodeSvgMarkup,
} from '../utils/barcode-label-renderer.ts';
import { isVariantInProfileDomain } from '../utils/profile-domain.ts';
import { ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

export interface BarcodeQueueEntry {
  variantId: string;
  copies: number;
  overrideBarcode?: string | undefined;
  overrideSubLabel?: string | undefined;
  overridePriceFormatted?: string | undefined;
}

interface BarcodeLabelPrintWorkspaceProps {
  outletId: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  queueEntries: BarcodeQueueEntry[];
  setQueueEntries: React.Dispatch<React.SetStateAction<BarcodeQueueEntry[]>>;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

function getDefaultPresetForTargetMode(
  mode: BarcodeLabelTargetMode,
  receiptPaperMm: 80 | 58
): BarcodeLabelSizePresetId {
  if (mode === 'A4_SHEET') return 'A4_30UP';
  if (mode === 'ESCPOS_RECEIPT_PRINTER') {
    return receiptPaperMm === 58 ? 'RECEIPT_58MM' : 'RECEIPT_80MM';
  }
  return '50x30mm';
}

function resolveEffectiveScaleConfig(
  variant: CatalogVariantDetailDto,
  scaleMode: 'STANDARD' | 'SCALE_WEIGHT' | 'SCALE_PRICE',
  weightInput: string,
  priceInput: string,
  parseMoney: (raw: string) => number,
  money: (satang: number) => string,
  scalePriceEmbeddedMultiplier: number,
  currencyCode: CurrencyCode
): {
  barcodeValue: string;
  subLabel?: string | undefined;
  priceFormatted: string;
  scaleError?: string | undefined;
} {
  const baseCode = (variant.barcode?.trim() || variant.sku).trim();
  const basePrice = variant.priceSatang > 0 ? money(variant.priceSatang) : '';
  if (!variant.isWeightedScale || scaleMode === 'STANDARD') {
    return {
      barcodeValue: baseCode,
      priceFormatted: basePrice,
    };
  }
  if (scaleMode === 'SCALE_WEIGHT') {
    let weightMilli = 500;
    try {
      weightMilli = parseDecimalStringToScaledInt(weightInput || '0.500', 3);
    } catch {
      return {
        barcodeValue: baseCode,
        priceFormatted: basePrice,
        scaleError: 'กรุณากรอกน้ำหนักเป็นตัวเลขที่ถูกต้อง (เช่น 0.500)',
      };
    }
    const rawSatang = Number(
      roundDivBigInt(BigInt(Math.max(0, variant.priceSatang)) * BigInt(Math.max(0, weightMilli)), SCALE_MILLI)
    );
    const computedPriceSatang = roundMinorToCurrencyUnit(rawSatang, currencyCode);
    const formattedWeightPrice =
      computedPriceSatang > 0 ? money(computedPriceSatang) : basePrice;
    try {
      return {
        barcodeValue: buildScaleBarcodeEan13({
          mode: 'WEIGHT_EMBEDDED',
          skuOrPlu: variant.sku,
          weightMilliKg: weightMilli,
        }),
        subLabel: `น้ำหนัก ${(weightMilli / 1000).toFixed(3)} ${variant.unitName}`,
        priceFormatted: formattedWeightPrice,
      };
    } catch (err) {
      return {
        barcodeValue: baseCode,
        priceFormatted: formattedWeightPrice,
        scaleError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  let priceSatang = 0;
  try {
    priceSatang = parseMoney(priceInput || '0');
  } catch {
    return {
      barcodeValue: baseCode,
      priceFormatted: basePrice,
      scaleError: 'กรุณากรอกราคารวมเป็นตัวเลขที่ถูกต้อง',
    };
  }
  const formattedPrice = priceSatang > 0 ? money(priceSatang) : basePrice;
  try {
    return {
      barcodeValue: buildScaleBarcodeEan13({
        mode: 'PRICE_EMBEDDED',
        skuOrPlu: variant.sku,
        totalPriceSatang: priceSatang,
        priceEmbeddedMultiplier: scalePriceEmbeddedMultiplier,
      }),
      subLabel: `ป้ายฝังราคา (${variant.sku})`,
      priceFormatted: formattedPrice,
    };
  } catch (err) {
    return {
      barcodeValue: baseCode,
      priceFormatted: formattedPrice,
      scaleError: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildAssignBarcodeUpsertInput(
  outletId: string,
  variant: CatalogVariantDetailDto,
  barcode: string,
  performedByUserId: string
) {
  return {
    outletId,
    variantId: variant.id,
    itemId: variant.itemId,
    itemName: variant.itemName,
    variantName: variant.variantName,
    categoryId: variant.categoryId,
    sku: variant.sku,
    barcode,
    unitName: variant.unitName,
    priceSatang: variant.priceSatang,
    defaultPurchaseCostMicroBaht: variant.defaultPurchaseCostMicroBaht,
    initialStockMilli: 0,
    lowStockThresholdMilli: variant.lowStockThresholdMilli,
    optimalStockMilli: variant.optimalStockMilli,
    isComposite: variant.isComposite,
    useProduction: variant.useProduction,
    isWeightedScale: variant.isWeightedScale,
    active: variant.active,
    performedByUserId,
  };
}

async function executeBarcodePrintJob(params: {
  config: BarcodeLabelPrinterConfigDto;
  presetId: BarcodeLabelSizePresetId;
  storeName: string;
  locale: 'th' | 'lo' | 'en';
  items: BarcodeLabelPrintItemDto[];
  startSlotOffset?: number | undefined;
  showCutBorders?: boolean | undefined;
}): Promise<{ kind: 'BROWSER_WINDOW' | 'HARDWARE'; message: string }> {
  const { config, presetId, storeName, locale, items, startSlotOffset, showCutBorders } = params;
  const totalCopies = items.reduce((sum, it) => sum + Math.max(0, it.copies), 0);
  if (totalCopies <= 0) {
    throw new Error('กรุณากำหนดจำนวนดวงที่ต้องการพิมพ์อย่างน้อย 1 ดวง');
  }

  if (config.mode === 'A4_SHEET' || config.mode === 'THERMAL_LABEL_DIALOG') {
    const opened = openBarcodeLabelPrintWindow({
      storeName,
      locale,
      presetId,
      template: config.template,
      items,
      startSlotOffset,
      showCutBorders,
    });
    if (!opened) {
      throw new Error('เบราว์เซอร์บล็อกหน้าต่างป๊อปอัป กรุณาอนุญาตป๊อปอัปเพื่อพิมพ์สติกเกอร์บาร์โค้ด');
    }
    return {
      kind: 'BROWSER_WINDOW',
      message: `เปิดหน้าต่างพิมพ์สติกเกอร์บาร์โค้ด ${totalCopies} ดวง (${items.length} รายการ) เรียบร้อยแล้ว`,
    };
  }

  const frames = items
    .filter((it) => it.copies > 0)
    .map((it) => {
      const raster = renderBarcodeLabelTo203DpiCanvasRaster({
        presetId,
        storeName,
        item: it,
        template: config.template,
      });
      return {
        variantId: it.variantId,
        sku: it.sku,
        barcodeValue: it.barcodeValue,
        packedBitmapBase64: raster.packedBitmapBase64,
        widthPx: raster.widthPx,
        heightPx: raster.heightPx,
        labelWidthMm: raster.labelWidthMm,
        labelHeightMm: raster.labelHeightMm,
        copies: it.copies,
      };
    });

  const res = await posTransport.printBarcodeLabels({
    targetMode: config.mode,
    tcpHost: config.tcpHost,
    tcpPort: config.tcpPort,
    windowsPrinterName: config.windowsPrinterName,
    gapMm: config.gapMm,
    frames,
  });

  return {
    kind: 'HARDWARE',
    message: res.dispatchedToHardware
      ? `ส่งคำสั่งพิมพ์บาร์โค้ด ${res.protocol} จำนวน ${res.totalLabelsCount} ดวง (${res.bytesWritten.toLocaleString()} bytes) ออกเครื่องพิมพ์สำเร็จ`
      : `สร้างชุดคำสั่งพิมพ์ ${res.protocol} จำนวน ${res.totalLabelsCount} ดวง (${res.wireByteLength.toLocaleString()} bytes · โหมด ${res.transportMode}) สำเร็จ`,
  };
}

const LiveLabelPreviewCard: React.FC<{
  storeName: string;
  item: BarcodeLabelPrintItemDto;
  presetId: BarcodeLabelSizePresetId;
  template: BarcodeLabelTemplateOptions;
  previewMode: 'SVG' | 'RASTER_203DPI';
}> = ({ storeName, item, presetId, template, previewMode }) => {
  const preset = getBarcodeLabelSizePreset(presetId);

  const svgRes = useMemo(() => {
    try {
      return renderBarcodeSvgMarkup({
        value: item.barcodeValue || item.sku,
        symbology: template.symbology,
        showText: template.showBarcodeText,
        heightUnits: preset.heightMm <= 26 ? 32 : 40,
        className: 'w-full h-full max-h-[82px]',
      });
    } catch {
      return null;
    }
  }, [item.barcodeValue, item.sku, preset.heightMm, template.showBarcodeText, template.symbology]);

  const rasterRes = useMemo(() => {
    if (previewMode !== 'RASTER_203DPI' || typeof document === 'undefined') return null;
    try {
      return renderBarcodeLabelTo203DpiCanvasRaster({
        presetId,
        storeName,
        item,
        template,
      });
    } catch {
      return null;
    }
  }, [item, presetId, previewMode, storeName, template]);

  const displayName =
    template.showVariantName && item.variantName && !isDefaultVariantLabel(item.variantName)
      ? `${item.itemName} (${item.variantName})`
      : item.itemName;

  if (previewMode === 'RASTER_203DPI' && rasterRes) {
    return (
      <div className="space-y-2 text-center">
        <div className="inline-block rounded-[4px] border border-hairline bg-white p-2">
          <img
            src={rasterRes.previewDataUrl}
            alt={`203-DPI Thermal Preview ${item.itemName}`}
            className="max-w-full h-auto mx-auto block"
            style={{ maxHeight: 190 }}
          />
        </div>
        <div className="text-[11px] text-ink-muted tabular-nums-google">
          203-DPI 1-Bit Bitmap ({rasterRes.widthPx}×{rasterRes.heightPx} px) · Format:{' '}
          <strong className="text-ink">{rasterRes.resolvedFormat}</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="mx-auto rounded-[4px] border border-dashed border-ink-muted/60 bg-white px-3 py-2.5 text-ink flex flex-col justify-between overflow-hidden"
        style={{
          width: Math.min(320, Math.max(200, Math.round(preset.widthMm * 4.5))),
          minHeight: Math.min(180, Math.max(116, Math.round(preset.heightMm * 4.1))),
        }}
      >
        {template.symbology === 'QR_CODE' ? (
          <div className="flex items-center gap-3 h-full">
            <div
              className="h-24 w-24 shrink-0"
              dangerouslySetInnerHTML={{ __html: svgRes?.svgMarkup ?? '' }}
            />
            <div className="min-w-0 flex-1 space-y-0.5 text-left">
              {template.showStoreName && storeName.trim() && (
                <div className="text-[10px] font-semibold text-ink-muted truncate">
                  {storeName}
                </div>
              )}
              {template.showItemName && (
                <div className="text-xs font-bold text-ink line-clamp-2 leading-snug">
                  {displayName}
                </div>
              )}
              {item.customSubLabel && (
                <div className="text-[10px] font-medium text-primary-dark truncate">
                  {item.customSubLabel}
                </div>
              )}
              {template.showSku && (
                <div className="text-[10px] text-ink-muted truncate tabular-nums-google">
                  SKU: {item.sku}
                </div>
              )}
              {template.showBarcodeText && (
                <div className="text-[10px] font-mono-num text-ink truncate">
                  {svgRes?.displayValue ?? item.barcodeValue}
                </div>
              )}
              {template.showPrice && item.priceFormatted && (
                <div className="text-sm font-bold text-ink pt-1 tabular-nums-google">
                  {item.priceFormatted}
                  {template.showUnit && item.unitName ? (
                    <span className="text-[10px] font-normal text-ink-muted">
                      /{item.unitName}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div>
              {template.showStoreName && storeName.trim() && (
                <div className="text-[10px] font-semibold text-ink-muted truncate leading-tight">
                  {storeName}
                </div>
              )}
              {template.showItemName && (
                <div className="text-xs font-bold text-ink truncate leading-snug">
                  {displayName}
                </div>
              )}
              {item.customSubLabel && (
                <div className="text-[10px] font-medium text-primary-dark truncate">
                  {item.customSubLabel}
                </div>
              )}
            </div>

            <div
              className="my-1 flex items-center justify-center overflow-hidden"
              dangerouslySetInnerHTML={{ __html: svgRes?.svgMarkup ?? '' }}
            />

            {(template.showPrice || template.showSku) && (
              <div className="flex items-baseline justify-between gap-2 pt-0.5 leading-none">
                <span className="text-[10px] text-ink-muted truncate tabular-nums-google">
                  {template.showSku ? `SKU: ${item.sku}` : ''}
                </span>
                {template.showPrice && item.priceFormatted && (
                  <span className="text-sm font-bold text-ink whitespace-nowrap tabular-nums-google">
                    {item.priceFormatted}
                    {template.showUnit && item.unitName ? (
                      <span className="text-[10px] font-normal text-ink-muted">
                        /{item.unitName}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="text-center text-[11px] text-ink-muted tabular-nums-google">
        {preset.widthMm}×{preset.heightMm} mm · Format:{' '}
        <strong className="text-ink">{svgRes?.resolvedFormat ?? 'AUTO'}</strong>
        {svgRes?.fallbackNotice ? (
          <span className="ml-1 text-primary-dark">(Auto fallback Code-128)</span>
        ) : null}
      </div>
    </div>
  );
};

export const BarcodeLabelPrintWorkspace: React.FC<BarcodeLabelPrintWorkspaceProps> = ({
  outletId,
  bootstrap,
  currentUser,
  queueEntries,
  setQueueEntries,
  onRefreshState,
  onToast,
}) => {
  const uid = useId();
  const { fiscal, locale, money, parseMoney, pick } = useI18n();

  const initialCfg = normalizeBarcodeLabelConfig(bootstrap.barcodeLabelConfig);
  const [config, setConfig] = useState<BarcodeLabelPrinterConfigDto>(initialCfg);
  const [presetId, setPresetId] = useState<BarcodeLabelSizePresetId>(initialCfg.defaultPresetId);
  const [previewMode, setPreviewMode] = useState<'SVG' | 'RASTER_203DPI'>('SVG');
  const [startSlotOffset, setStartSlotOffset] = useState<number>(0);
  const [showCutBorders, setShowCutBorders] = useState<boolean>(true);
  const [catalogFilter, setCatalogFilter] = useState<string>('');
  const [showAllProfiles, setShowAllProfiles] = useState<boolean>(false);
  const [winPrinters, setWinPrinters] = useState<
    Array<{ name: string; portName: string; isDefault: boolean }>
  >([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [selectedPreviewVariantId, setSelectedPreviewVariantId] = useState<string>('');

  useEffect(() => {
    const synced = normalizeBarcodeLabelConfig(bootstrap.barcodeLabelConfig);
    setConfig(synced);
    setPresetId(synced.defaultPresetId);
  }, [bootstrap.barcodeLabelConfig]);

  useEffect(() => {
    void posTransport
      .listWindowsPrinters()
      .then((r) => setWinPrinters(r.printers))
      .catch(() => {});
  }, []);

  const variantById = useMemo(() => {
    return new Map<string, CatalogVariantDetailDto>(
      bootstrap.catalogDetailed.map((v) => [v.id, v])
    );
  }, [bootstrap.catalogDetailed]);

  const existingBarcodesSet = useMemo(() => {
    const s = new Set<string>();
    for (const v of bootstrap.catalogDetailed) {
      if (v.barcode) s.add(v.barcode);
    }
    return s;
  }, [bootstrap.catalogDetailed]);

  const scopedCatalog = useMemo(() => {
    const base = showAllProfiles
      ? bootstrap.catalogDetailed
      : bootstrap.catalogDetailed.filter((v) =>
          isVariantInProfileDomain(v, bootstrap.profile, 'WAREHOUSE')
        );
    const q = catalogFilter.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (v) =>
        v.itemName.toLowerCase().includes(q) ||
        v.sku.toLowerCase().includes(q) ||
        (v.barcode ?? '').toLowerCase().includes(q)
    );
  }, [bootstrap.catalogDetailed, bootstrap.profile, catalogFilter, showAllProfiles]);

  const resolvedPrintItems = useMemo<BarcodeLabelPrintItemDto[]>(() => {
    const list: BarcodeLabelPrintItemDto[] = [];
    for (const entry of queueEntries) {
      const v = variantById.get(entry.variantId);
      if (!v) continue;
      const barcodeValue = (entry.overrideBarcode ?? v.barcode ?? v.sku).trim() || v.sku;
      const priceFormatted =
        entry.overridePriceFormatted ?? (v.priceSatang > 0 ? money(v.priceSatang) : '');
      list.push({
        variantId: v.id,
        itemName: v.itemName,
        variantName: v.variantName,
        sku: v.sku,
        barcodeValue,
        unitName: v.unitName,
        priceSatang: v.priceSatang,
        priceFormatted,
        copies: Math.max(1, Math.min(500, Math.trunc(entry.copies))),
        ...(entry.overrideSubLabel ? { customSubLabel: entry.overrideSubLabel } : {}),
      });
    }
    return list;
  }, [money, queueEntries, variantById]);

  const activePreset = getBarcodeLabelSizePreset(presetId);
  const totalLabelsCount = resolvedPrintItems.reduce((sum, it) => sum + it.copies, 0);

  const previewItem: BarcodeLabelPrintItemDto | null = useMemo(() => {
    if (selectedPreviewVariantId) {
      const fromQueue = resolvedPrintItems.find(
        (it) => it.variantId === selectedPreviewVariantId
      );
      if (fromQueue) return fromQueue;
      const v = variantById.get(selectedPreviewVariantId);
      if (v) {
        return {
          variantId: v.id,
          itemName: v.itemName,
          variantName: v.variantName,
          sku: v.sku,
          barcodeValue: (v.barcode?.trim() || v.sku).trim(),
          unitName: v.unitName,
          priceSatang: v.priceSatang,
          priceFormatted: v.priceSatang > 0 ? money(v.priceSatang) : '',
          copies: 1,
        };
      }
    }
    if (resolvedPrintItems[0]) return resolvedPrintItems[0];
    const firstCatalog = scopedCatalog[0] ?? bootstrap.catalogDetailed[0];
    if (!firstCatalog) return null;
    return {
      variantId: firstCatalog.id,
      itemName: firstCatalog.itemName,
      variantName: firstCatalog.variantName,
      sku: firstCatalog.sku,
      barcodeValue: (firstCatalog.barcode?.trim() || firstCatalog.sku).trim(),
      unitName: firstCatalog.unitName,
      priceSatang: firstCatalog.priceSatang,
      priceFormatted: firstCatalog.priceSatang > 0 ? money(firstCatalog.priceSatang) : '',
      copies: 1,
    };
  }, [
    bootstrap.catalogDetailed,
    money,
    resolvedPrintItems,
    scopedCatalog,
    selectedPreviewVariantId,
    variantById,
  ]);

  const addOrIncrementQueue = (variant: CatalogVariantDetailDto, copies = 1) => {
    setSelectedPreviewVariantId(variant.id);
    setQueueEntries((prev) => {
      const existing = prev.find((e) => e.variantId === variant.id);
      if (existing) {
        return prev.map((e) =>
          e.variantId === variant.id
            ? { ...e, copies: Math.min(500, e.copies + copies) }
            : e
        );
      }
      return [...prev, { variantId: variant.id, copies }];
    });
  };

  const handleAssignValidEan13 = async (variant: CatalogVariantDetailDto) => {
    setBusy(true);
    try {
      const prefix = getInternalEan13PrefixForCountry(fiscal.countryCode);
      const generated = generateValidInternalEan13(existingBarcodesSet, prefix);
      await posTransport.upsertCatalogVariant(
        buildAssignBarcodeUpsertInput(outletId, variant, generated, currentUser.id)
      );
      await onRefreshState();
      onToast(
        pick(
          `สร้างและบันทึกรหัส EAN-13 (${generated}) ให้ "${variant.itemName}" สำเร็จ`,
          `ສ້າງ ແລະ ບັນທຶກລະຫັດ EAN-13 (${generated}) ໃຫ້ "${variant.itemName}" ສຳເລັດ`,
          `Assigned EAN-13 (${generated}) to "${variant.itemName}"`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleBatchAssignMissingEan13 = async () => {
    const missing = scopedCatalog.filter((v) => !v.barcode && !v.isWeightedScale);
    if (missing.length === 0) {
      onToast(
        pick(
          'สินค้าทั้งหมดในรายการนี้มีบาร์โค้ดครบแล้ว',
          'ສິນຄ້າທັງໝົດໃນລາຍການນີ້ມີບາໂຄດຄົບແລ້ວ',
          'All products in this list already have barcodes'
        ),
        'success'
      );
      return;
    }
    setBusy(true);
    try {
      const prefix = getInternalEan13PrefixForCountry(fiscal.countryCode);
      const runningSet = new Set(existingBarcodesSet);
      let count = 0;
      for (const v of missing) {
        const nextCode = generateValidInternalEan13(runningSet, prefix);
        runningSet.add(nextCode);
        await posTransport.upsertCatalogVariant(
          buildAssignBarcodeUpsertInput(outletId, v, nextCode, currentUser.id)
        );
        count += 1;
      }
      await onRefreshState();
      onToast(
        pick(
          `สร้างรหัส EAN-13 อัตโนมัติให้สินค้า ${count} รายการเรียบร้อยแล้ว`,
          `ສ້າງລະຫັດ EAN-13 ອັດຕະໂນມັດໃຫ້ສິນຄ້າ ${count} ລາຍການສຳເລັດ`,
          `Generated internal EAN-13 barcodes for ${count} products`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleTargetModeChange = (nextMode: BarcodeLabelTargetMode) => {
    const suggestedPreset = getDefaultPresetForTargetMode(
      nextMode,
      bootstrap.printerConfig.paperWidthMm
    );
    const currentPreset = getBarcodeLabelSizePreset(presetId);
    const needsPresetSwitch =
      (nextMode === 'A4_SHEET' && currentPreset.kind !== 'A4_SHEET') ||
      (nextMode === 'ESCPOS_RECEIPT_PRINTER' && currentPreset.kind !== 'RECEIPT_STRIP') ||
      (nextMode !== 'A4_SHEET' &&
        nextMode !== 'ESCPOS_RECEIPT_PRINTER' &&
        currentPreset.kind !== 'THERMAL_LABEL');

    const nextPresetId = needsPresetSwitch ? suggestedPreset : presetId;
    setPresetId(nextPresetId);
    setConfig((prev) => ({
      ...prev,
      mode: nextMode,
      defaultPresetId: nextPresetId,
    }));
  };

  const handleSaveConfig = async () => {
    setBusy(true);
    try {
      const saved = await posTransport.saveBarcodeLabelConfig({
        ...config,
        defaultPresetId: presetId,
      });
      setConfig(saved.barcodeLabelConfig);
      await onRefreshState();
      onToast('บันทึกการตั้งค่าเครื่องพิมพ์บาร์โค้ดและแม่แบบสติกเกอร์เรียบร้อยแล้ว', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePrintBatch = async () => {
    if (resolvedPrintItems.length === 0) {
      onToast('กรุณาเลือกสินค้าเข้าคิวพิมพ์อย่างน้อย 1 รายการ', 'warn');
      return;
    }
    setBusy(true);
    try {
      const outcome = await executeBarcodePrintJob({
        config,
        presetId,
        storeName: bootstrap.storeSettings.storeName,
        locale,
        items: resolvedPrintItems,
        startSlotOffset: activePreset.kind === 'A4_SHEET' ? startSlotOffset : 0,
        showCutBorders,
      });
      onToast(outcome.message, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const maxSlotsPerPage =
    activePreset.kind === 'A4_SHEET'
      ? (activePreset.a4Columns ?? 3) * (activePreset.a4Rows ?? 10)
      : 1;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* LEFT: Catalog Picker & Quick Batch Actions */}
      <div className="xl:col-span-6 rounded-[4px] border border-hairline bg-canvas overflow-hidden">
        <div className="p-5 border-b border-hairline bg-surface-1 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2">
                <Barcode className="h-5 w-5 text-primary" />
                <span>
                  {pick(
                    '1. เลือกสินค้าสำหรับพิมพ์สติกเกอร์บาร์โค้ด',
                    '1. ເລືອກສິນຄ້າສຳລັບພິມສະຕິກເກີບາໂຄດ',
                    '1. Select Products for Barcode Labels'
                  )}
                </span>
              </h3>
              <p className="text-xs text-ink-muted mt-0.5">
                {pick(
                  'รองรับทั้งรหัส EAN-13, Code 128 จาก SKU และสร้างรหัสบาร์โค้ดภายในอัตโนมัติ',
                  'ຮອງຮັບທັງ EAN-13, Code 128 ຈາກ SKU ແລະ ສ້າງລະຫັດບາໂຄດອັດຕະໂນມັດ',
                  'Supports EAN-13, EAN-8, Code 128 from SKU, and auto internal EAN-13 generation'
                )}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleBatchAssignMissingEan13()}
              className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-primary bg-primary-soft px-3.5 text-xs font-medium text-primary-dark hover:bg-primary hover:text-white ${UI_INTERACTION.focusButton}`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                {pick(
                  'สร้าง EAN-13 ให้รายการที่ยังไม่มี',
                  'ສ້າງ EAN-13 ໃຫ້ລາຍການທີ່ຍັງບໍ່ມີ',
                  'Auto-Generate Missing EAN-13'
                )}
              </span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
              <input
                type="text"
                aria-label="ค้นหาสินค้าเพื่อพิมพ์บาร์โค้ด"
                value={catalogFilter}
                onChange={(e) => setCatalogFilter(e.target.value)}
                placeholder="ค้นหาชื่อสินค้า, SKU หรือบาร์โค้ด..."
                className={`h-10 w-full rounded-[48px] border border-hairline bg-canvas pl-10 pr-4 text-xs text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>

            <button
              type="button"
              onClick={() => {
                const nextEntries: BarcodeQueueEntry[] = scopedCatalog.map((v) => ({
                  variantId: v.id,
                  copies: 1,
                }));
                setQueueEntries(nextEntries);
                if (nextEntries[0]) {
                  setSelectedPreviewVariantId(nextEntries[0].variantId);
                }
                onToast(`เพิ่มสินค้า ${nextEntries.length} รายการลงคิวพิมพ์แล้ว`, 'success');
              }}
              className={`h-10 rounded-[48px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
            >
              เลือกทั้งหมด (×1)
            </button>

            <button
              type="button"
              onClick={() => {
                const withStock = scopedCatalog
                  .filter((v) => !v.isComposite && v.inStockMilli >= 1_000)
                  .map((v) => ({
                    variantId: v.id,
                    copies: Math.min(200, Math.max(1, Math.floor(v.inStockMilli / 1_000))),
                  }));
                if (withStock.length === 0) {
                  onToast('ไม่พบสินค้าที่มีสต็อกคงเหลือตั้งแต่ 1 ชิ้นขึ้นไป', 'warn');
                  return;
                }
                setQueueEntries(withStock);
                setSelectedPreviewVariantId(withStock[0]!.variantId);
                onToast(
                  `เพิ่มสินค้า ${withStock.length} รายการตามจำนวนสต็อกคงเหลือลงคิวพิมพ์แล้ว`,
                  'success'
                );
              }}
              className={`h-10 rounded-[48px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
            >
              ใส่ตามจำนวนสต็อก
            </button>

            <button
              type="button"
              onClick={() => setShowAllProfiles((v) => !v)}
              className={`h-10 rounded-[48px] border px-3 text-[11px] font-medium ${UI_INTERACTION.focusButton} ${
                showAllProfiles
                  ? 'border-ink bg-ink text-white'
                  : 'border-hairline bg-canvas text-ink-muted hover:border-primary'
              }`}
            >
              {showAllProfiles ? 'ซ่อนต่างโหมด' : 'รวมทุกโหมด'}
            </button>
          </div>
        </div>

        <div className="divide-y divide-hairline max-h-[540px] overflow-y-auto">
          {scopedCatalog.length === 0 ? (
            <div className="py-12 text-center text-xs text-ink-muted">
              ไม่พบรายการสินค้าที่ตรงกับคำค้นหา
            </div>
          ) : (
            scopedCatalog.map((v) => {
              const queued = queueEntries.find((q) => q.variantId === v.id);
              const effectiveCode = (v.barcode?.trim() || v.sku).trim();
              return (
                <div
                  key={v.id}
                  className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs hover:bg-surface-1 transition-colors duration-150"
                >
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => setSelectedPreviewVariantId(v.id)}
                  >
                    <div className="font-medium text-ink flex items-center gap-1.5 truncate">
                      <span className="truncate">{v.itemName}</span>
                      {v.isWeightedScale && (
                        <span className="inline-flex items-center gap-0.5 rounded-[4px] bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary-dark shrink-0">
                          <Scale className="h-3 w-3" /> ตราชั่ง
                        </span>
                      )}
                      {queued && (
                        <span className="rounded-[48px] bg-primary px-2 py-0.5 text-[10px] font-medium text-white tabular-nums-google shrink-0">
                          ในคิว ×{queued.copies}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-muted tabular-nums-google flex flex-wrap items-center gap-2 mt-0.5">
                      <span>SKU: {v.sku}</span>
                      <span>·</span>
                      <span className={v.barcode ? 'text-primary-dark font-medium' : ''}>
                        {v.barcode ? `EAN: ${v.barcode}` : `ใช้ SKU แทน (${effectiveCode})`}
                      </span>
                      {v.priceSatang > 0 && (
                        <>
                          <span>·</span>
                          <span className="font-medium text-ink">{money(v.priceSatang)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {!v.barcode && !v.isWeightedScale && (
                      <button
                        type="button"
                        disabled={busy}
                        title="สร้างรหัส EAN-13 ที่ถูกต้องให้อัตโนมัติ"
                        onClick={() => void handleAssignValidEan13(v)}
                        className={`h-8 rounded-[48px] border border-hairline bg-canvas px-2.5 text-[11px] font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
                      >
                        + EAN-13
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedPreviewVariantId(v.id)}
                      title="ดูตัวอย่างป้ายสติกเกอร์"
                      aria-label={`ดูตัวอย่างป้าย ${v.itemName}`}
                      className={`flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-canvas text-ink-muted hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => addOrIncrementQueue(v, 1)}
                      className={`inline-flex h-8 items-center gap-1 rounded-[48px] bg-primary px-3 text-[11px] font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>เพิ่ม</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* RIGHT: Print Queue, Live Preview, Printer Settings & Print CTA */}
      <div className="xl:col-span-6 space-y-5">
        {/* Live Preview Card */}
        <div className="rounded-[4px] border border-hairline bg-canvas p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="font-google-display text-[17px] font-normal text-ink">
                {pick(
                  'ตัวอย่างป้ายสติกเกอร์บาร์โค้ดสด',
                  'ຕົວຢ່າງປ້າຍສະຕິກເກີບາໂຄດສົດ',
                  'Live Barcode Sticker Preview'
                )}
              </h4>
              <p className="text-[11px] text-ink-muted">
                {previewItem
                  ? `${previewItem.itemName} (${previewItem.barcodeValue})`
                  : 'เลือกสินค้าทางด้านซ้ายเพื่อดูตัวอย่าง'}
              </p>
            </div>
            <div className="inline-flex rounded-[48px] border border-hairline p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setPreviewMode('SVG')}
                className={`rounded-[48px] px-3 py-1 font-medium ${UI_INTERACTION.focusButton} ${
                  previewMode === 'SVG'
                    ? 'bg-primary text-white'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                เวกเตอร์ (A4/PDF)
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('RASTER_203DPI')}
                className={`rounded-[48px] px-3 py-1 font-medium ${UI_INTERACTION.focusButton} ${
                  previewMode === 'RASTER_203DPI'
                    ? 'bg-primary text-white'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                203-DPI Thermal
              </button>
            </div>
          </div>

          <div className="rounded-[4px] border border-hairline bg-surface-1 p-4">
            {previewItem ? (
              <LiveLabelPreviewCard
                storeName={bootstrap.storeSettings.storeName}
                item={previewItem}
                presetId={presetId}
                template={config.template}
                previewMode={previewMode}
              />
            ) : (
              <div className="py-8 text-center text-xs text-ink-muted">
                ยังไม่มีสินค้าในระบบ
              </div>
            )}
          </div>
        </div>

        {/* Selected Queue List */}
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="px-5 py-3.5 border-b border-hairline bg-surface-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" />
              <span className="font-google-display text-sm font-medium text-ink">
                {pick('2. คิวรายการที่จะพิมพ์', '2. ຄິວລາຍການທີ່ຈະພິມ', '2. Label Print Queue')} ({resolvedPrintItems.length} ·{' '}
                <strong className="text-primary tabular-nums-google">{totalLabelsCount}</strong>{' '}
                {pick('ดวง', 'ດວງ', 'labels')})
              </span>
            </div>
            {queueEntries.length > 0 && (
              <button
                type="button"
                onClick={() => setQueueEntries([])}
                className={`rounded-[48px] border border-hairline bg-canvas px-3 py-1 text-[11px] font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
              >
                ล้างคิวทั้งหมด
              </button>
            )}
          </div>

          <div className="divide-y divide-hairline max-h-56 overflow-y-auto">
            {resolvedPrintItems.length === 0 ? (
              <div className="py-8 text-center text-xs text-ink-muted">
                ยังไม่มีสินค้าในคิวพิมพ์ — กดปุ่ม &ldquo;+ เพิ่ม&rdquo; จากตารางสินค้าทางซ้าย
              </div>
            ) : (
              resolvedPrintItems.map((it) => (
                <div
                  key={it.variantId}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-surface-1"
                >
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => setSelectedPreviewVariantId(it.variantId)}
                  >
                    <div className="font-medium text-ink truncate">{it.itemName}</div>
                    <div className="text-[11px] text-ink-muted tabular-nums-google truncate">
                      {it.barcodeValue}
                      {it.customSubLabel ? ` · ${it.customSubLabel}` : ''}
                      {it.priceFormatted ? ` · ${it.priceFormatted}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[11px] text-ink-muted">จำนวนดวง:</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      aria-label={`จำนวนดวงบาร์โค้ดของ ${it.itemName}`}
                      value={it.copies}
                      onChange={(e) => {
                        const val = Math.max(1, Math.min(500, Math.trunc(Number(e.target.value) || 1)));
                        setQueueEntries((prev) =>
                          prev.map((q) =>
                            q.variantId === it.variantId ? { ...q, copies: val } : q
                          )
                        );
                      }}
                      className={`h-8 w-16 rounded-[4px] border border-hairline bg-canvas px-2 text-center text-xs font-medium text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                    />
                    <button
                      type="button"
                      aria-label={`นำ ${it.itemName} ออกจากคิวพิมพ์`}
                      onClick={() =>
                        setQueueEntries((prev) => prev.filter((q) => q.variantId !== it.variantId))
                      }
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Printer Target, Label Size & Template Controls */}
        <div className="rounded-[4px] border border-hairline bg-canvas p-5 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-google-display text-sm font-medium text-ink">
              3. ตั้งค่าเครื่องพิมพ์ ขนาดสติกเกอร์ &amp; ข้อมูลบนป้าย
            </h4>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSaveConfig()}
              className={`inline-flex h-8 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3 text-[11px] font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
            >
              <Save className="h-3.5 w-3.5" />
              <span>บันทึกเป็นค่าเริ่มต้น</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-lbl-mode`} className="block text-ink-muted mb-1">
                รูปแบบเครื่องพิมพ์ปลายทาง
              </label>
              <select
                id={`${uid}-lbl-mode`}
                value={config.mode}
                onChange={(e) => handleTargetModeChange(e.target.value as BarcodeLabelTargetMode)}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
              >
                <option value="A4_SHEET">กระดาษสติกเกอร์ A4 (Print Dialog / Laser / Inkjet)</option>
                <option value="THERMAL_LABEL_DIALOG">สติกเกอร์ม้วนความร้อน (Windows Print Dialog)</option>
                <option value="TSPL_RAW_USB">เครื่องพิมพ์บาร์โค้ด TSPL USB (Xprinter / TSC / Gprinter)</option>
                <option value="TSPL_LAN_9100">เครื่องพิมพ์บาร์โค้ด TSPL LAN (TCP Port 9100)</option>
                <option value="ZPL_RAW_USB">เครื่องพิมพ์บาร์โค้ด ZPL USB (Zebra)</option>
                <option value="ZPL_LAN_9100">เครื่องพิมพ์บาร์โค้ด ZPL LAN (TCP Port 9100)</option>
                <option value="ESCPOS_RECEIPT_PRINTER">พิมพ์ผ่านเครื่องพิมพ์ใบเสร็จ 80mm / 58mm</option>
              </select>
            </div>

            <div>
              <label htmlFor={`${uid}-lbl-preset`} className="block text-ink-muted mb-1">
                ขนาดดวงสติกเกอร์ / แผ่น
              </label>
              <select
                id={`${uid}-lbl-preset`}
                value={presetId}
                onChange={(e) => setPresetId(e.target.value as BarcodeLabelSizePresetId)}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
              >
                {BARCODE_LABEL_SIZE_PRESETS.filter((p) => {
                  if (config.mode === 'A4_SHEET') return p.kind === 'A4_SHEET';
                  if (config.mode === 'ESCPOS_RECEIPT_PRINTER') return p.kind === 'RECEIPT_STRIP';
                  if (config.mode === 'THERMAL_LABEL_DIALOG') {
                    return p.kind === 'THERMAL_LABEL' || p.kind === 'RECEIPT_STRIP';
                  }
                  return p.kind === 'THERMAL_LABEL';
                }).map((p) => (
                  <option key={p.id} value={p.id}>
                    {getLocalizedBarcodePresetLabel(p, locale)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={`${uid}-lbl-sym`} className="block text-ink-muted mb-1">
                มาตรฐานรหัสบาร์โค้ด
              </label>
              <select
                id={`${uid}-lbl-sym`}
                value={config.template.symbology}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    template: {
                      ...prev.template,
                      symbology: e.target.value as BarcodeSymbology,
                    },
                  }))
                }
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
              >
                <option value="AUTO">อัตโนมัติ (EAN-13 / EAN-8 / Code 128)</option>
                <option value="CODE_128">Code 128 (รองรับตัวอักษร SKU + ตัวเลข)</option>
                <option value="EAN_13">EAN-13 (ตัวเลข 13 หลักมาตรฐานสากล)</option>
                <option value="EAN_8">EAN-8 (ตัวเลข 8 หลักขนาดเล็ก)</option>
                <option value="QR_CODE">QR Code สินค้า (สแกนเร็วแม้ป้ายเล็ก)</option>
              </select>
            </div>

            {(config.mode === 'TSPL_RAW_USB' || config.mode === 'ZPL_RAW_USB') && (
              <div>
                <label htmlFor={`${uid}-lbl-winprn`} className="block text-ink-muted mb-1">
                  เลือกเครื่องพิมพ์บาร์โค้ด USB ใน Windows
                </label>
                {winPrinters.length > 0 ? (
                  <select
                    id={`${uid}-lbl-winprn`}
                    value={config.windowsPrinterName}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, windowsPrinterName: e.target.value }))
                    }
                    className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
                  >
                    <option value="">-- เลือกเครื่องพิมพ์ USB --</option>
                    {winPrinters.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.portName})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`${uid}-lbl-winprn`}
                    type="text"
                    placeholder="เช่น Xprinter XP-365B"
                    value={config.windowsPrinterName}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, windowsPrinterName: e.target.value }))
                    }
                    className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusControl}`}
                  />
                )}
              </div>
            )}

            {(config.mode === 'TSPL_LAN_9100' || config.mode === 'ZPL_LAN_9100') && (
              <>
                <div>
                  <label htmlFor={`${uid}-lbl-host`} className="block text-ink-muted mb-1">
                    IP เครื่องพิมพ์บาร์โค้ด LAN
                  </label>
                  <input
                    id={`${uid}-lbl-host`}
                    type="text"
                    value={config.tcpHost}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, tcpHost: e.target.value }))
                    }
                    className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
                <div>
                  <label htmlFor={`${uid}-lbl-port`} className="block text-ink-muted mb-1">
                    พอร์ต TCP
                  </label>
                  <input
                    id={`${uid}-lbl-port`}
                    type="number"
                    value={config.tcpPort}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        tcpPort: Math.max(1, Math.min(65535, Number(e.target.value) || 9100)),
                      }))
                    }
                    className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
              </>
            )}

            {(config.mode === 'TSPL_RAW_USB' || config.mode === 'TSPL_LAN_9100') && (
              <div>
                <label htmlFor={`${uid}-lbl-gap`} className="block text-ink-muted mb-1">
                  ระยะช่องว่างระหว่างสติกเกอร์ (Gap มม.)
                </label>
                <input
                  id={`${uid}-lbl-gap`}
                  type="number"
                  min={0}
                  max={15}
                  value={config.gapMm}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      gapMm: Math.max(0, Math.min(15, Math.trunc(Number(e.target.value) || 0))),
                    }))
                  }
                  className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
            )}

            {activePreset.kind === 'A4_SHEET' && (
              <div>
                <label htmlFor={`${uid}-lbl-skip`} className="block text-ink-muted mb-1">
                  เว้นช่องที่ใช้แล้วบนแผ่นแรก (0–{maxSlotsPerPage - 1} ช่อง)
                </label>
                <input
                  id={`${uid}-lbl-skip`}
                  type="number"
                  min={0}
                  max={maxSlotsPerPage - 1}
                  value={startSlotOffset}
                  onChange={(e) =>
                    setStartSlotOffset(
                      Math.max(0, Math.min(maxSlotsPerPage - 1, Math.trunc(Number(e.target.value) || 0)))
                    )
                  }
                  className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
            )}
          </div>

          {/* Template field checkboxes */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-hairline">
            {(
              [
                ['showStoreName', 'ชื่อร้าน'],
                ['showItemName', 'ชื่อสินค้า'],
                ['showVariantName', 'ชื่อตัวเลือก'],
                ['showPrice', 'ราคาขาย'],
                ['showUnit', 'หน่วยนับ'],
                ['showSku', 'รหัส SKU'],
                ['showBarcodeText', 'ตัวเลขบาร์โค้ด'],
              ] as const
            ).map(([field, label]) => (
              <label
                key={field}
                className="flex items-center gap-1.5 rounded-[4px] border border-hairline bg-surface-1 px-2.5 py-1.5 cursor-pointer hover:border-primary"
              >
                <input
                  type="checkbox"
                  checked={config.template[field]}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      template: { ...prev.template, [field]: e.target.checked },
                    }))
                  }
                  className="accent-primary"
                />
                <span className="text-[11px] text-ink">{label}</span>
              </label>
            ))}

            {(config.mode === 'A4_SHEET' || config.mode === 'THERMAL_LABEL_DIALOG') && (
              <label className="flex items-center gap-1.5 rounded-[4px] border border-hairline bg-surface-1 px-2.5 py-1.5 cursor-pointer hover:border-primary">
                <input
                  type="checkbox"
                  checked={showCutBorders}
                  onChange={(e) => setShowCutBorders(e.target.checked)}
                  className="accent-primary"
                />
                <span className="text-[11px] text-ink">เส้นประตัดขอบ</span>
              </label>
            )}
          </div>

          <button
            type="button"
            disabled={busy || totalLabelsCount <= 0}
            onClick={() => void handlePrintBatch()}
            className={`flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            <Printer className="h-4 w-4" />
            <span>
              {pick(
                'พิมพ์สติกเกอร์บาร์โค้ดทันที',
                'ພິມສະຕິກເກີບາໂຄດທັນທີ',
                'Print Barcode Labels'
              )}{' '}
              ({totalLabelsCount} {pick('ดวง', 'ດວງ', 'labels')} ·{' '}
              {config.mode === 'A4_SHEET' ? 'A4' : activePreset.widthMm + '×' + activePreset.heightMm + 'mm'})
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

interface QuickBarcodePrintModalProps {
  open: boolean;
  outletId: string;
  variant: CatalogVariantDetailDto | null;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  onClose: () => void;
  onAddToBatchQueue: (entry: BarcodeQueueEntry) => void;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

/**
 * Focused 2-click single-product barcode label printing dialog opened directly from
 * any product row or the Edit Product modal. Supports standard SKUs, valid EAN-13 generation,
 * and Weight/Price-Embedded Scale EAN-13 labels.
 */
export const QuickBarcodePrintModal: React.FC<QuickBarcodePrintModalProps> = ({
  open,
  outletId,
  variant,
  bootstrap,
  currentUser,
  onClose,
  onAddToBatchQueue,
  onRefreshState,
  onToast,
}) => {
  const uid = useId();
  const { currencyCode, fiscal, locale, money, moneyInput, parseMoney, pick } = useI18n();
  const [config, setConfig] = useState<BarcodeLabelPrinterConfigDto>(() =>
    normalizeBarcodeLabelConfig(bootstrap.barcodeLabelConfig)
  );
  const [presetId, setPresetId] = useState<BarcodeLabelSizePresetId>(config.defaultPresetId);
  const [copiesInput, setCopiesInput] = useState<string>('10');
  const [previewMode, setPreviewMode] = useState<'SVG' | 'RASTER_203DPI'>('SVG');
  const [scaleMode, setScaleMode] = useState<'STANDARD' | 'SCALE_WEIGHT' | 'SCALE_PRICE'>(
    'STANDARD'
  );
  const [scaleWeightInput, setScaleWeightInput] = useState<string>('0.500');
  const [scalePriceInput, setScalePriceInput] = useState<string>(() =>
    currencyCode === 'LAK' ? '50000' : '90.00'
  );
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    const synced = normalizeBarcodeLabelConfig(bootstrap.barcodeLabelConfig);
    setConfig(synced);
    setPresetId(synced.defaultPresetId);
  }, [bootstrap.barcodeLabelConfig, open]);

  useEffect(() => {
    if (!open || !variant) return;
    setScaleMode(variant.isWeightedScale ? 'SCALE_WEIGHT' : 'STANDARD');
    setScaleWeightInput('0.500');
    setScalePriceInput(
      variant.priceSatang > 0
        ? moneyInput(
            roundMinorToCurrencyUnit(
              Number(roundDivBigInt(BigInt(variant.priceSatang), 2n)),
              currencyCode
            )
          )
        : currencyCode === 'LAK'
          ? '50000'
          : '100.00'
    );
    const defaultCopies =
      !variant.isComposite && variant.inStockMilli >= 1_000
        ? String(Math.min(30, Math.max(1, Math.floor(variant.inStockMilli / 1_000))))
        : '10';
    setCopiesInput(defaultCopies);
  }, [currencyCode, moneyInput, open, variant]);

  const existingBarcodesSet = useMemo(() => {
    const s = new Set<string>();
    for (const v of bootstrap.catalogDetailed) {
      if (v.barcode) s.add(v.barcode);
    }
    return s;
  }, [bootstrap.catalogDetailed]);

  const scaleResolved = useMemo(() => {
    if (!variant) return null;
    return resolveEffectiveScaleConfig(
      variant,
      scaleMode,
      scaleWeightInput,
      scalePriceInput,
      parseMoney,
      money,
      fiscal.scalePriceEmbeddedMultiplier,
      currencyCode
    );
  }, [
    currencyCode,
    fiscal.scalePriceEmbeddedMultiplier,
    money,
    parseMoney,
    scaleMode,
    scalePriceInput,
    scaleWeightInput,
    variant,
  ]);

  const resolvedItem = useMemo<BarcodeLabelPrintItemDto | null>(() => {
    if (!variant || !scaleResolved) return null;
    const copies = Math.max(1, Math.min(500, Math.trunc(Number(copiesInput) || 1)));
    return {
      variantId: variant.id,
      itemName: variant.itemName,
      variantName: variant.variantName,
      sku: variant.sku,
      barcodeValue: scaleResolved.barcodeValue,
      unitName: variant.unitName,
      priceSatang: variant.priceSatang,
      priceFormatted: scaleResolved.priceFormatted,
      copies,
      ...(scaleResolved.subLabel ? { customSubLabel: scaleResolved.subLabel } : {}),
    };
  }, [copiesInput, scaleResolved, variant]);

  if (!variant || !resolvedItem) {
    return null;
  }

  const handleGenerateEan13ForVariant = async () => {
    setBusy(true);
    try {
      const prefix = getInternalEan13PrefixForCountry(fiscal.countryCode);
      const nextCode = generateValidInternalEan13(existingBarcodesSet, prefix);
      await posTransport.upsertCatalogVariant(
        buildAssignBarcodeUpsertInput(outletId, variant, nextCode, currentUser.id)
      );
      await onRefreshState();
      onToast(
        pick(
          `บันทึกรหัส EAN-13 (${nextCode}) ให้สินค้านี้เรียบร้อยแล้ว`,
          `ບັນທຶກລະຫັດ EAN-13 (${nextCode}) ໃຫ້ສິນຄ້ານີ້ສຳເລັດແລ້ວ`,
          `Saved EAN-13 (${nextCode}) for this product`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePrintNow = async () => {
    setBusy(true);
    try {
      const outcome = await executeBarcodePrintJob({
        config,
        presetId,
        storeName: bootstrap.storeSettings.storeName,
        locale,
        items: [resolvedItem],
      });
      onToast(outcome.message, 'success');
      if (outcome.kind === 'HARDWARE') {
        onClose();
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      canDismiss={!busy}
      onClose={onClose}
      labelledBy={`${uid}-qbp-title`}
      maxWidthClass="max-w-xl"
    >
      <div className="flex items-center justify-between border-b border-hairline px-6 py-4 bg-canvas shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
            <Barcode className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 id={`${uid}-qbp-title`} className="font-google-display text-[18px] font-normal text-ink truncate">
              พิมพ์สติกเกอร์บาร์โค้ด: {variant.itemName}
            </h3>
            <p className="text-[11px] text-ink-muted tabular-nums-google">
              SKU: {variant.sku} · {variant.barcode ? `Barcode: ${variant.barcode}` : 'ยังไม่มีบาร์โค้ด (ใช้ SKU แทนได้)'}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="ปิดหน้าต่างพิมพ์บาร์โค้ด"
          onClick={onClose}
          className={`flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink shrink-0 ${UI_INTERACTION.focusButton}`}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
        {/* Live Preview */}
        <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-ink">ตัวอย่างป้ายสติกเกอร์</span>
            <div className="inline-flex rounded-[48px] border border-hairline bg-canvas p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setPreviewMode('SVG')}
                className={`rounded-[48px] px-2.5 py-0.5 font-medium ${
                  previewMode === 'SVG' ? 'bg-primary text-white' : 'text-ink-muted'
                }`}
              >
                Vector
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('RASTER_203DPI')}
                className={`rounded-[48px] px-2.5 py-0.5 font-medium ${
                  previewMode === 'RASTER_203DPI' ? 'bg-primary text-white' : 'text-ink-muted'
                }`}
              >
                203-DPI
              </button>
            </div>
          </div>

          <LiveLabelPreviewCard
            storeName={bootstrap.storeSettings.storeName}
            item={resolvedItem}
            presetId={presetId}
            template={config.template}
            previewMode={previewMode}
          />
        </div>

        {!variant.barcode && !variant.isWeightedScale && (
          <div className="rounded-[4px] border border-primary/30 bg-primary-soft/60 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-ink-soft">
              สินค้านี้ยังไม่มีเลขบาร์โค้ด EAN-13 (สามารถพิมพ์ Code 128 จาก SKU หรือสร้าง EAN-13 ถาวรได้)
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleGenerateEan13ForVariant()}
              className={`inline-flex h-8 items-center gap-1 rounded-[48px] bg-primary px-3 text-[11px] font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              <RefreshCw className="h-3 w-3" />
              <span>สร้าง &amp; บันทึก EAN-13</span>
            </button>
          </div>
        )}

        {variant.isWeightedScale && (
          <div className="rounded-[4px] border border-hairline bg-surface-1 p-3.5 space-y-2.5">
            <div className="font-medium text-ink flex items-center gap-1.5">
              <Scale className="h-4 w-4 text-primary" />
              <span>ป้ายบาร์โค้ดสินค้าชั่งน้ำหนัก (Scale EAN-13)</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select
                aria-label="รูปแบบบาร์โค้ดสินค้าชั่งน้ำหนัก"
                value={scaleMode}
                onChange={(e) =>
                  setScaleMode(e.target.value as 'STANDARD' | 'SCALE_WEIGHT' | 'SCALE_PRICE')
                }
                className={`h-10 rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
              >
                <option value="SCALE_WEIGHT">ฝังน้ำหนัก (Prefix 20)</option>
                <option value="SCALE_PRICE">ฝังราคารวม (Prefix 25)</option>
                <option value="STANDARD">บาร์โค้ด/SKU ปกติ</option>
              </select>
              {scaleMode === 'SCALE_WEIGHT' && (
                <input
                  type="text"
                  aria-label="น้ำหนัก (กิโลกรัม)"
                  value={scaleWeightInput}
                  onChange={(e) => setScaleWeightInput(e.target.value)}
                  placeholder="น้ำหนัก เช่น 0.500"
                  className={`sm:col-span-2 h-10 rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              )}
              {scaleMode === 'SCALE_PRICE' && (
                <input
                  type="text"
                  aria-label="ราคารวมบนป้าย"
                  value={scalePriceInput}
                  onChange={(e) => setScalePriceInput(e.target.value)}
                  placeholder="ราคารวม เช่น 90.00"
                  className={`sm:col-span-2 h-10 rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              )}
            </div>
            {scaleResolved?.scaleError && (
              <div className="rounded-[4px] border border-ink bg-surface-1 px-3 py-2 text-[11px] text-ink">
                <strong className="font-medium">คำเตือนรหัสตราชั่ง EAN-13 (จำกัด 5 หลัก):</strong>{' '}
                {scaleResolved.scaleError}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor={`${uid}-qbp-copies`} className="block text-ink-muted mb-1">
              จำนวนสติกเกอร์ (ดวง)
            </label>
            <input
              id={`${uid}-qbp-copies`}
              type="number"
              min={1}
              max={500}
              value={copiesInput}
              onChange={(e) => setCopiesInput(e.target.value)}
              className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 font-medium text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
            />
          </div>

          <div>
            <label htmlFor={`${uid}-qbp-mode`} className="block text-ink-muted mb-1">
              เครื่องพิมพ์
            </label>
            <select
              id={`${uid}-qbp-mode`}
              value={config.mode}
              onChange={(e) => {
                const nextMode = e.target.value as BarcodeLabelTargetMode;
                setConfig((prev) => ({ ...prev, mode: nextMode }));
                setPresetId(
                  getDefaultPresetForTargetMode(nextMode, bootstrap.printerConfig.paperWidthMm)
                );
              }}
              className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              <option value="A4_SHEET">กระดาษ A4 สติกเกอร์</option>
              <option value="THERMAL_LABEL_DIALOG">Thermal Dialog</option>
              <option value="TSPL_RAW_USB">TSPL USB (Xprinter/TSC)</option>
              <option value="TSPL_LAN_9100">TSPL LAN :9100</option>
              <option value="ZPL_RAW_USB">ZPL USB (Zebra)</option>
              <option value="ZPL_LAN_9100">ZPL LAN :9100</option>
              <option value="ESCPOS_RECEIPT_PRINTER">เครื่องพิมพ์ใบเสร็จ 80/58mm</option>
            </select>
          </div>

          <div>
            <label htmlFor={`${uid}-qbp-preset`} className="block text-ink-muted mb-1">
              ขนาดป้าย
            </label>
            <select
              id={`${uid}-qbp-preset`}
              value={presetId}
              onChange={(e) => setPresetId(e.target.value as BarcodeLabelSizePresetId)}
              className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              {BARCODE_LABEL_SIZE_PRESETS.filter((p) => {
                if (config.mode === 'A4_SHEET') return p.kind === 'A4_SHEET';
                if (config.mode === 'ESCPOS_RECEIPT_PRINTER') return p.kind === 'RECEIPT_STRIP';
                return p.kind !== 'A4_SHEET';
              }).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({p.widthMm}×{p.heightMm}mm)
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[1, 5, 10, 24, 30].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCopiesInput(String(n))}
              className={`rounded-[48px] border px-3 py-1 text-[11px] font-medium tabular-nums-google ${UI_INTERACTION.focusButton} ${
                Number(copiesInput) === n
                  ? 'border-primary bg-primary text-white'
                  : 'border-hairline bg-surface-1 text-ink-soft hover:border-primary'
              }`}
            >
              ×{n} ดวง
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        <button
          type="button"
          disabled={busy || Boolean(scaleResolved?.scaleError)}
          onClick={() => {
            onAddToBatchQueue({
              variantId: variant.id,
              copies: resolvedItem.copies,
              ...(variant.isWeightedScale && scaleMode !== 'STANDARD'
                ? {
                    overrideBarcode: resolvedItem.barcodeValue,
                    overrideSubLabel: resolvedItem.customSubLabel,
                    overridePriceFormatted: resolvedItem.priceFormatted,
                  }
                : {}),
            });
            onToast(
              pick(
                `เพิ่ม "${variant.itemName}" ×${resolvedItem.copies} ดวงเข้าคิวพิมพ์ชุดรวมแล้ว`,
                `ເພີ່ມ "${variant.itemName}" ×${resolvedItem.copies} ດວງເຂົ້າຄິວພິມແລ້ວ`,
                `Added "${variant.itemName}" ×${resolvedItem.copies} to batch print queue`
              ),
              'success'
            );
            onClose();
          }}
          className={`inline-flex h-[42px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>{pick('เพิ่มเข้าคิวพิมพ์ชุดรวม', 'ເພີ່ມເຂົ້າຄິວພິມລວມ', 'Add to Batch Queue')}</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`h-[42px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-soft hover:border-ink ${UI_INTERACTION.focusButton}`}
          >
            {pick('ปิด', 'ປິດ', 'Close')}
          </button>
          <button
            type="button"
            disabled={busy || Boolean(scaleResolved?.scaleError)}
            onClick={() => void handlePrintNow()}
            className={`inline-flex h-[42px] items-center gap-1.5 rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium tracking-[0.25px] text-white hover:bg-primary-hover disabled:opacity-45 ${UI_INTERACTION.focusButtonPrimary}`}
          >
            <Printer className="h-4 w-4" />
            <span>
              {pick('พิมพ์เลย', 'ພິມທັນທີ', 'Print Now')} ({resolvedItem.copies}{' '}
              {pick('ดวง', 'ດວງ', 'labels')})
            </span>
          </button>
        </div>
      </div>
    </ModalDialog>
  );
};
