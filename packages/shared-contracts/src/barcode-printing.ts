/**
 * RUBE-STOCK-POS v3.1 Product Barcode Label Printing Contracts & Presets
 *
 * Pure integer/deterministic definitions (zero `parseFloat` / floating-point drift)
 * shared between `hal-drivers`, `pos-desktop-server`, and `ui-presentation`.
 */

export type BarcodeSymbology = 'AUTO' | 'EAN_13' | 'EAN_8' | 'CODE_128' | 'QR_CODE';

export type BarcodeLabelTargetMode =
  | 'A4_SHEET'
  | 'THERMAL_LABEL_DIALOG'
  | 'TSPL_RAW_USB'
  | 'TSPL_LAN_9100'
  | 'ZPL_RAW_USB'
  | 'ZPL_LAN_9100'
  | 'ESCPOS_RECEIPT_PRINTER';

export type BarcodeLabelSizePresetId =
  | '50x30mm'
  | '40x30mm'
  | '32x25mm'
  | '60x40mm'
  | 'A4_30UP'
  | 'A4_24UP'
  | 'A4_44UP'
  | 'RECEIPT_80MM'
  | 'RECEIPT_58MM';

export interface BarcodeLabelSizePreset {
  readonly id: BarcodeLabelSizePresetId;
  readonly kind: 'THERMAL_LABEL' | 'A4_SHEET' | 'RECEIPT_STRIP';
  readonly labelTh: string;
  readonly labelLo: string;
  readonly labelEn: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly widthPx203Dpi: number;
  readonly heightPx203Dpi: number;
  readonly a4Columns?: number | undefined;
  readonly a4Rows?: number | undefined;
  readonly a4MarginTopMm?: number | undefined;
  readonly a4MarginLeftMm?: number | undefined;
  readonly a4GapXMm?: number | undefined;
  readonly a4GapYMm?: number | undefined;
}

export const BARCODE_LABEL_SIZE_PRESETS: readonly BarcodeLabelSizePreset[] = [
  {
    id: '50x30mm',
    kind: 'THERMAL_LABEL',
    labelTh: 'สติกเกอร์ความร้อน 50×30 มม. (มาตรฐานร้านค้าปลีก)',
    labelLo: 'ສະຕິກເກີຄວາມຮ້ອນ 50×30 ມມ. (ມາດຕະຖານ)',
    labelEn: 'Thermal Label 50×30mm (Standard Retail)',
    widthMm: 50,
    heightMm: 30,
    widthPx203Dpi: 400,
    heightPx203Dpi: 240,
  },
  {
    id: '40x30mm',
    kind: 'THERMAL_LABEL',
    labelTh: 'สติกเกอร์ความร้อน 40×30 มม. (ขนาดกะทัดรัด)',
    labelLo: 'ສະຕິກເກີຄວາມຮ້ອນ 40×30 ມມ.',
    labelEn: 'Thermal Label 40×30mm (Compact)',
    widthMm: 40,
    heightMm: 30,
    widthPx203Dpi: 320,
    heightPx203Dpi: 240,
  },
  {
    id: '32x25mm',
    kind: 'THERMAL_LABEL',
    labelTh: 'สติกเกอร์ความร้อน 32×25 มม. (ป้ายราคาเล็ก)',
    labelLo: 'ສະຕິກເກີຄວາມຮ້ອນ 32×25 ມມ. (ປ້າຍນ້ອຍ)',
    labelEn: 'Thermal Label 32×25mm (Mini Price Tag)',
    widthMm: 32,
    heightMm: 25,
    widthPx203Dpi: 256,
    heightPx203Dpi: 200,
  },
  {
    id: '60x40mm',
    kind: 'THERMAL_LABEL',
    labelTh: 'สติกเกอร์ความร้อน 60×40 มม. (คลังสินค้า / ตราชั่ง)',
    labelLo: 'ສະຕິກເກີຄວາມຮ້ອນ 60×40 ມມ. (ສາງ / ຊິງຊັ່ງ)',
    labelEn: 'Thermal Label 60×40mm (Warehouse / Scale)',
    widthMm: 60,
    heightMm: 40,
    widthPx203Dpi: 480,
    heightPx203Dpi: 320,
  },
  {
    id: 'A4_30UP',
    kind: 'A4_SHEET',
    labelTh: 'กระดาษสติกเกอร์ A4 — 30 ดวง/แผ่น (3×10 · 64×26 มม.)',
    labelLo: 'ເຈ້ຍສະຕິກເກີ A4 — 30 ດວງ/ແຜ່ນ (3×10 · 64×26 ມມ.)',
    labelEn: 'A4 Sticker Sheet — 30 Labels (3×10 · 64×26mm)',
    widthMm: 64,
    heightMm: 26,
    widthPx203Dpi: 512,
    heightPx203Dpi: 208,
    a4Columns: 3,
    a4Rows: 10,
    a4MarginTopMm: 12,
    a4MarginLeftMm: 6,
    a4GapXMm: 3,
    a4GapYMm: 1,
  },
  {
    id: 'A4_24UP',
    kind: 'A4_SHEET',
    labelTh: 'กระดาษสติกเกอร์ A4 — 24 ดวง/แผ่น (3×8 · 64×34 มม.)',
    labelLo: 'ເຈ້ຍສະຕິກເກີ A4 — 24 ດວງ/ແຜ່ນ (3×8 · 64×34 ມມ.)',
    labelEn: 'A4 Sticker Sheet — 24 Labels (3×8 · 64×34mm)',
    widthMm: 64,
    heightMm: 34,
    widthPx203Dpi: 512,
    heightPx203Dpi: 272,
    a4Columns: 3,
    a4Rows: 8,
    a4MarginTopMm: 10,
    a4MarginLeftMm: 6,
    a4GapXMm: 3,
    a4GapYMm: 1,
  },
  {
    id: 'A4_44UP',
    kind: 'A4_SHEET',
    labelTh: 'กระดาษสติกเกอร์ A4 — 44 ดวง/แผ่น (4×11 · 48×24 มม.)',
    labelLo: 'ເຈ້ຍສະຕິກເກີ A4 — 44 ດວງ/ແຜ່ນ (4×11 · 48×24 ມມ.)',
    labelEn: 'A4 Sticker Sheet — 44 Labels (4×11 · 48×24mm)',
    widthMm: 48,
    heightMm: 24,
    widthPx203Dpi: 384,
    heightPx203Dpi: 192,
    a4Columns: 4,
    a4Rows: 11,
    a4MarginTopMm: 11,
    a4MarginLeftMm: 6,
    a4GapXMm: 2,
    a4GapYMm: 1,
  },
  {
    id: 'RECEIPT_80MM',
    kind: 'RECEIPT_STRIP',
    labelTh: 'เครื่องพิมพ์ใบเสร็จความร้อน 80 มม. (576 dots)',
    labelLo: 'ເຄື່ອງພິມໃບບິນຄວາມຮ້ອນ 80 ມມ. (576 dots)',
    labelEn: '80mm Thermal Receipt Roll (576 dots)',
    widthMm: 72,
    heightMm: 35,
    widthPx203Dpi: 576,
    heightPx203Dpi: 280,
  },
  {
    id: 'RECEIPT_58MM',
    kind: 'RECEIPT_STRIP',
    labelTh: 'เครื่องพิมพ์ใบเสร็จความร้อน 58 มม. (384 dots)',
    labelLo: 'ເຄື່ອງພິມໃບບິນຄວາມຮ້ອນ 58 ມມ. (384 dots)',
    labelEn: '58mm Thermal Receipt Roll (384 dots)',
    widthMm: 48,
    heightMm: 30,
    widthPx203Dpi: 384,
    heightPx203Dpi: 240,
  },
];

export function getBarcodeLabelSizePreset(
  presetId: BarcodeLabelSizePresetId
): BarcodeLabelSizePreset {
  return (
    BARCODE_LABEL_SIZE_PRESETS.find((p) => p.id === presetId) ??
    BARCODE_LABEL_SIZE_PRESETS[0]!
  );
}

export interface BarcodeLabelTemplateOptions {
  showStoreName: boolean;
  showItemName: boolean;
  showVariantName: boolean;
  showPrice: boolean;
  showSku: boolean;
  showUnit: boolean;
  showBarcodeText: boolean;
  symbology: BarcodeSymbology;
}

export interface BarcodeLabelPrinterConfigDto {
  mode: BarcodeLabelTargetMode;
  tcpHost: string;
  tcpPort: number;
  windowsPrinterName: string;
  defaultPresetId: BarcodeLabelSizePresetId;
  gapMm: number;
  template: BarcodeLabelTemplateOptions;
}

export const DEFAULT_BARCODE_LABEL_TEMPLATE: BarcodeLabelTemplateOptions = {
  showStoreName: true,
  showItemName: true,
  showVariantName: false,
  showPrice: true,
  showSku: true,
  showUnit: true,
  showBarcodeText: true,
  symbology: 'AUTO',
};

export const DEFAULT_BARCODE_LABEL_CONFIG: BarcodeLabelPrinterConfigDto = {
  mode: 'A4_SHEET',
  tcpHost: '192.168.1.201',
  tcpPort: 9100,
  windowsPrinterName: '',
  defaultPresetId: 'A4_30UP',
  gapMm: 2,
  template: { ...DEFAULT_BARCODE_LABEL_TEMPLATE },
};

const VALID_MODES: ReadonlySet<BarcodeLabelTargetMode> = new Set([
  'A4_SHEET',
  'THERMAL_LABEL_DIALOG',
  'TSPL_RAW_USB',
  'TSPL_LAN_9100',
  'ZPL_RAW_USB',
  'ZPL_LAN_9100',
  'ESCPOS_RECEIPT_PRINTER',
]);

const VALID_SYMBOLOGIES: ReadonlySet<BarcodeSymbology> = new Set([
  'AUTO',
  'EAN_13',
  'EAN_8',
  'CODE_128',
  'QR_CODE',
]);

export function normalizeBarcodeLabelConfig(
  raw?: Partial<BarcodeLabelPrinterConfigDto> | null
): BarcodeLabelPrinterConfigDto {
  const mode: BarcodeLabelTargetMode =
    raw?.mode && VALID_MODES.has(raw.mode)
      ? raw.mode
      : DEFAULT_BARCODE_LABEL_CONFIG.mode;

  const presetValid = BARCODE_LABEL_SIZE_PRESETS.some((p) => p.id === raw?.defaultPresetId);
  const defaultPresetId: BarcodeLabelSizePresetId = presetValid
    ? raw!.defaultPresetId!
    : mode === 'A4_SHEET'
      ? 'A4_30UP'
      : mode === 'ESCPOS_RECEIPT_PRINTER'
        ? 'RECEIPT_80MM'
        : '50x30mm';

  const rawPort = Number(raw?.tcpPort ?? DEFAULT_BARCODE_LABEL_CONFIG.tcpPort);
  const tcpPort =
    Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535
      ? Math.trunc(rawPort)
      : DEFAULT_BARCODE_LABEL_CONFIG.tcpPort;

  const rawGap = Number(raw?.gapMm ?? DEFAULT_BARCODE_LABEL_CONFIG.gapMm);
  const gapMm =
    Number.isFinite(rawGap) && rawGap >= 0 && rawGap <= 15
      ? Math.trunc(rawGap)
      : DEFAULT_BARCODE_LABEL_CONFIG.gapMm;

  const rawTpl = raw?.template;
  const symbology: BarcodeSymbology =
    rawTpl?.symbology && VALID_SYMBOLOGIES.has(rawTpl.symbology)
      ? rawTpl.symbology
      : 'AUTO';

  return {
    mode,
    tcpHost:
      typeof raw?.tcpHost === 'string' && raw.tcpHost.trim()
        ? raw.tcpHost.trim()
        : DEFAULT_BARCODE_LABEL_CONFIG.tcpHost,
    tcpPort,
    windowsPrinterName:
      typeof raw?.windowsPrinterName === 'string' ? raw.windowsPrinterName.trim() : '',
    defaultPresetId,
    gapMm,
    template: {
      showStoreName: rawTpl?.showStoreName !== false,
      showItemName: rawTpl?.showItemName !== false,
      showVariantName: rawTpl?.showVariantName === true,
      showPrice: rawTpl?.showPrice !== false,
      showSku: rawTpl?.showSku !== false,
      showUnit: rawTpl?.showUnit !== false,
      showBarcodeText: rawTpl?.showBarcodeText !== false,
      symbology,
    },
  };
}

export interface BarcodeLabelPrintItemDto {
  variantId: string;
  itemName: string;
  variantName: string;
  sku: string;
  barcodeValue: string;
  unitName: string;
  priceSatang: number;
  priceFormatted: string;
  copies: number;
  customSubLabel?: string | undefined;
}
