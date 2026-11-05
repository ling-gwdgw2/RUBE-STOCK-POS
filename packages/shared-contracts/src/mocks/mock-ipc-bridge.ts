/**
 * RUBE-STOCK-POS v3.1 Mock IPC Bridge & Seed Catalog for Zero-Bottleneck Parallel Development
 */

import type {
  BomEdgeDto,
  BusinessProfile,
  ItemVariantDto,
  ModifierDto,
  PosShiftDto,
} from '../ipc-commands.ts';

export const SEED_VARIANTS: readonly ItemVariantDto[] = [
  {
    id: 'VAR-RET-001',
    itemId: 'ITM-RET-001',
    itemName: 'น้ำดื่มคริสตัล 600 มล.',
    variantName: 'ขวดเดี่ยว',
    sku: '8851952350161',
    barcode: '8851952350161',
    unitName: 'ขวด',
    priceSatang: 700,
    averageCostMicroBaht: 4_250_000,
    inStockMilli: 120_000,
    isComposite: false,
    useProduction: false,
    isWeightedScale: false,
  },
  {
    id: 'VAR-RET-002',
    itemId: 'ITM-RET-002',
    itemName: 'สันคอหมูสไลซ์สด (ชั่งน้ำหนัก)',
    variantName: 'กิโลกรัม',
    sku: '10045',
    barcode: null,
    unitName: 'กก.',
    priceSatang: 18_000,
    averageCostMicroBaht: 135_000_000,
    inStockMilli: 25_000,
    isComposite: false,
    useProduction: false,
    isWeightedScale: true,
  },
  {
    id: 'VAR-RAW-TEA',
    itemId: 'ITM-RAW-TEA',
    itemName: 'ใบชาอัสสัมคัดพิเศษ',
    variantName: 'กรัม',
    sku: 'RAW-TEA-01',
    barcode: null,
    unitName: 'กรัม',
    priceSatang: 0,
    averageCostMicroBaht: 450_000,
    inStockMilli: 5_000_000,
    isComposite: false,
    useProduction: false,
    isWeightedScale: false,
  },
  {
    id: 'VAR-RAW-SYRUP',
    itemId: 'ITM-RAW-SYRUP',
    itemName: 'น้ำเชื่อมมิตรผล (Rich Syrup)',
    variantName: 'มล.',
    sku: 'RAW-SYR-01',
    barcode: null,
    unitName: 'มล.',
    priceSatang: 0,
    averageCostMicroBaht: 85_000,
    inStockMilli: 10_000_000,
    isComposite: false,
    useProduction: false,
    isWeightedScale: false,
  },
  {
    id: 'VAR-RAW-HONEY',
    itemId: 'ITM-RAW-HONEY',
    itemName: 'น้ำผึ้งดอกลำไยแท้ 100%',
    variantName: 'มล.',
    sku: 'RAW-HON-01',
    barcode: null,
    unitName: 'มล.',
    priceSatang: 0,
    averageCostMicroBaht: 250_000,
    inStockMilli: 3_000_000,
    isComposite: false,
    useProduction: false,
    isWeightedScale: false,
  },
  {
    id: 'VAR-RAW-BOBA',
    itemId: 'ITM-RAW-BOBA',
    itemName: 'ไข่มุกไต้หวันต้มสุก (Pre-built Batch)',
    variantName: 'กรัม',
    sku: 'PRE-BOBA-01',
    barcode: null,
    unitName: 'กรัม',
    priceSatang: 0,
    averageCostMicroBaht: 120_000,
    inStockMilli: 2_000_000,
    isComposite: true,
    useProduction: true,
    isWeightedScale: false,
  },
  {
    id: 'VAR-RAW-DRY-BOBA',
    itemId: 'ITM-RAW-DRY-BOBA',
    itemName: 'เม็ดไข่มุกดิบ (ก่อนต้ม)',
    variantName: 'กรัม',
    sku: 'RAW-DBOB-01',
    barcode: null,
    unitName: 'กรัม',
    priceSatang: 0,
    averageCostMicroBaht: 60_000,
    inStockMilli: 10_000_000,
    isComposite: false,
    useProduction: false,
    isWeightedScale: false,
  },
  {
    id: 'VAR-CAFE-MILKTEA',
    itemId: 'ITM-CAFE-001',
    itemName: 'ชานมไต้หวันพ่นไฟ',
    variantName: 'แก้ว 16oz',
    sku: 'CAFE-MT-16',
    barcode: null,
    unitName: 'แก้ว',
    priceSatang: 6_500,
    averageCostMicroBaht: 0,
    inStockMilli: 0,
    isComposite: true,
    useProduction: false,
    isWeightedScale: false,
  },
  {
    id: 'VAR-CAFE-HONEYTEA',
    itemId: 'ITM-CAFE-002',
    itemName: 'ชาเขียวมะลิผสมน้ำผึ้งแท้',
    variantName: 'แก้ว 16oz',
    sku: 'CAFE-HT-16',
    barcode: null,
    unitName: 'แก้ว',
    priceSatang: 7_500,
    averageCostMicroBaht: 0,
    inStockMilli: 0,
    isComposite: true,
    useProduction: false,
    isWeightedScale: false,
  },
];

export const SEED_BOM_EDGES: readonly BomEdgeDto[] = [
  {
    compositeVariantId: 'VAR-RAW-BOBA',
    componentVariantId: 'VAR-RAW-DRY-BOBA',
    componentRole: 'STANDARD',
    quantityMilli: 600,
    wastageBasisPoints: 500,
  },
  {
    compositeVariantId: 'VAR-CAFE-MILKTEA',
    componentVariantId: 'VAR-RAW-TEA',
    componentRole: 'TEA_BASE',
    quantityMilli: 18_000,
    wastageBasisPoints: 200,
  },
  {
    compositeVariantId: 'VAR-CAFE-MILKTEA',
    componentVariantId: 'VAR-RAW-SYRUP',
    componentRole: 'SWEETENER',
    quantityMilli: 30_000,
    wastageBasisPoints: 0,
  },
  {
    compositeVariantId: 'VAR-CAFE-MILKTEA',
    componentVariantId: 'VAR-RAW-BOBA',
    componentRole: 'TOPPING',
    quantityMilli: 40_000,
    wastageBasisPoints: 0,
  },
  {
    compositeVariantId: 'VAR-CAFE-HONEYTEA',
    componentVariantId: 'VAR-RAW-TEA',
    componentRole: 'TEA_BASE',
    quantityMilli: 15_000,
    wastageBasisPoints: 0,
  },
  {
    compositeVariantId: 'VAR-CAFE-HONEYTEA',
    componentVariantId: 'VAR-RAW-HONEY',
    componentRole: 'SWEETENER',
    quantityMilli: 25_000,
    wastageBasisPoints: 0,
  },
];

export const SEED_MODIFIERS: readonly ModifierDto[] = [
  {
    id: 'MOD-SWEET-50',
    modifierGroupId: 'GRP-SWEETNESS',
    name: 'หวานน้อย (50%)',
    priceDeltaSatang: 0,
    modifierMode: 'ROLE_SCALE_BPS',
    componentVariantId: null,
    quantityDeltaMilli: 0,
    targetComponentRole: 'SWEETENER',
    scaleBasisPoints: -5_000,
  },
  {
    id: 'MOD-SWEET-0',
    modifierGroupId: 'GRP-SWEETNESS',
    name: 'ไม่หวาน (0%)',
    priceDeltaSatang: 0,
    modifierMode: 'ROLE_SCALE_BPS',
    componentVariantId: null,
    quantityDeltaMilli: 0,
    targetComponentRole: 'SWEETENER',
    scaleBasisPoints: -10_000,
  },
  {
    id: 'MOD-EXTRA-BOBA',
    modifierGroupId: 'GRP-TOPPING',
    name: 'เพิ่มไข่มุกไต้หวัน (+15฿)',
    priceDeltaSatang: 1_500,
    modifierMode: 'FIXED_QTY_DELTA',
    componentVariantId: 'VAR-RAW-BOBA',
    quantityDeltaMilli: 50_000,
    targetComponentRole: null,
    scaleBasisPoints: 0,
  },
];

export class MockIpcBridge {
  private activeProfile: BusinessProfile = 'HYBRID';
  private activeShift: PosShiftDto = {
    id: 'SHIFT-20261105-01',
    shiftNumber: '20261105-S1',
    outletId: 'OUTLET-HQ',
    terminalId: 'POS-TERM-01',
    openedBy: 'USR-CASHIER-01',
    status: 'OPEN',
    openingCashSatang: 200_000,
    expectedCashSatang: 200_000,
    countedCashSatang: null,
    cashVarianceSatang: null,
    openedAt: new Date().toISOString(),
  };

  public getProfile(): BusinessProfile {
    return this.activeProfile;
  }

  public setProfile(profile: BusinessProfile): void {
    this.activeProfile = profile;
  }

  public getActiveShift(): PosShiftDto {
    return { ...this.activeShift };
  }

  public getCatalog(): ReadonlyMap<string, ItemVariantDto> {
    return new Map(SEED_VARIANTS.map((v) => [v.id, v]));
  }
}

