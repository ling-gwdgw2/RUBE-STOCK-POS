/**
 * RUBE-STOCK-POS v3.1 Inventory & Stock Balance View Controller (`INV_VIEW` — WBS-12)
 *
 * Responsibilities:
 * - Renders Warehouse Stock Balances in `Milli-Units` and Moving Average Cost (MAC) in `Micro-Baht`
 * - Highlights Low-Stock / Negative-Stock items
 * - Resolves Physical Scancode / Scale Barcodes (`Prefix 20-29`) directly against the product catalog
 */

import {
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  roundDiv,
} from '../../../../shared-contracts/src/fixed-point.ts';
import type { ItemVariantDto } from '../../../../shared-contracts/src/ipc-commands.ts';
import {
  decodePhysicalKeyCodesToBarcode,
  parseScaleBarcodeEan13,
  type ParsedScaleBarcode,
} from '../../../../hal-drivers/src/scanner/mod.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export interface InventoryItemViewModel extends ItemVariantDto {
  qtyFormatted: string;
  macFormatted: string;
  totalAssetValueSatang: number;
  totalAssetFormatted: string;
  unitPriceFormatted: string;
  isNegativeStock: boolean;
  isLowStock: boolean;
}

export interface ResolvedBarcodeScanResult {
  rawBarcode: string;
  scaleInfo: ParsedScaleBarcode;
  matchedItem: InventoryItemViewModel | null;
  effectiveQtyMilli: number;
  effectiveTotalPriceSatang: number;
}

export class InventoryViewController {
  private readonly bridge: LocalIpcBridge;
  private readonly defaultOutletId: string;

  constructor(bridge: LocalIpcBridge, defaultOutletId = 'OUTLET-HQ') {
    this.bridge = bridge;
    this.defaultOutletId = defaultOutletId;
  }

  /**
   * Queries the Read Pool and formats all catalog items into display-ready ViewModels.
   */
  public getCatalogViewModels(lowStockThresholdMilli = 10_000): InventoryItemViewModel[] {
    const rows = this.bridge.getInventoryCatalog(this.defaultOutletId);

    return rows.map((row) => {
      // Total Asset Value in Satang = round(inStockMilli * averageCostMicroBaht / 10,000,000)
      const totalAssetValueSatang = roundDiv(
        BigInt(row.inStockMilli) * BigInt(row.averageCostMicroBaht),
        10_000_000n
      );

      return {
        ...row,
        qtyFormatted: formatMilliUnitsToQtyString(row.inStockMilli, row.unitName),
        macFormatted: `฿${formatMicroBahtToThbString(row.averageCostMicroBaht)}`,
        totalAssetValueSatang,
        totalAssetFormatted: `฿${formatSatangToThbString(totalAssetValueSatang)}`,
        unitPriceFormatted: `฿${formatSatangToThbString(row.priceSatang)}`,
        isNegativeStock: row.inStockMilli < 0,
        isLowStock: row.inStockMilli >= 0 && row.inStockMilli <= lowStockThresholdMilli,
      };
    });
  }

  /**
   * Adjusts inventory (`ADJUSTMENT` or `SALE_DIRECT`).
   */
  public async adjustStock(input: {
    variantId: string;
    outletId?: string;
    transactionType: 'SALE_DIRECT' | 'SALE_BOM' | 'SALE_MODIFIER' | 'ADJUSTMENT';
    quantityDeltaMilli: number;
    referenceType: string;
    referenceId: string;
    performedByUserId: string;
  }) {
    return this.bridge.adjustInventoryStock({
      outletId: input.outletId ?? this.defaultOutletId,
      variantId: input.variantId,
      transactionType: input.transactionType,
      quantityDeltaMilli: input.quantityDeltaMilli,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      performedByUserId: input.performedByUserId,
    });
  }

  /**
   * Decodes physical `KeyboardEvent.code` scancodes (Thai-layout safe) and resolves either:
   * - A Scale Barcode (`Prefix 20-29`, matching `sku` against the 5-digit embedded SKU)
   * - A Standard EAN-13 Barcode (`barcode` or `sku`)
   */
  public resolveScannedKeyCodes(physicalCodes: readonly string[]): ResolvedBarcodeScanResult {
    const rawBarcode = decodePhysicalKeyCodesToBarcode(physicalCodes);
    const catalog = this.getCatalogViewModels();

    const initialParse = parseScaleBarcodeEan13(rawBarcode);
    if (initialParse.isScaleBarcode && initialParse.sku) {
      const matchedItem =
        catalog.find((item) => item.isWeightedScale && item.sku === initialParse.sku) ??
        catalog.find((item) => item.sku === initialParse.sku) ??
        catalog.find((item) => item.isWeightedScale && item.sku.endsWith(initialParse.sku!)) ??
        catalog.find((item) => item.barcode === rawBarcode) ??
        null;

      const fullScaleInfo = parseScaleBarcodeEan13(
        rawBarcode,
        matchedItem ? matchedItem.priceSatang : undefined
      );

      const effectiveQtyMilli =
        fullScaleInfo.mode === 'WEIGHT_EMBEDDED'
          ? (fullScaleInfo.weightMilliKg ?? 0)
          : (fullScaleInfo.computedWeightMilliFromPrice ?? 1_000);

      const effectiveTotalPriceSatang =
        fullScaleInfo.mode === 'PRICE_EMBEDDED'
          ? (fullScaleInfo.totalPriceSatang ?? 0)
          : matchedItem
            ? roundDiv(BigInt(effectiveQtyMilli) * BigInt(matchedItem.priceSatang), 1_000n)
            : 0;

      return {
        rawBarcode,
        scaleInfo: fullScaleInfo,
        matchedItem,
        effectiveQtyMilli,
        effectiveTotalPriceSatang,
      };
    }

    const matchedItem =
      catalog.find((item) => item.barcode === rawBarcode || item.sku === rawBarcode) ?? null;

    return {
      rawBarcode,
      scaleInfo: initialParse,
      matchedItem,
      effectiveQtyMilli: 1_000,
      effectiveTotalPriceSatang: matchedItem ? matchedItem.priceSatang : 0,
    };
  }
}
