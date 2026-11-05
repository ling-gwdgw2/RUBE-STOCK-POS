/**
 * RUBE-STOCK-POS v3.1 Multi-Level BOM DAG & Prep Kitchen View Controller (`BOM_VIEW` — WBS-12)
 *
 * Responsibilities:
 * - Edits Multi-Level BOM edges (`composite_variant_id -> component_variant_id`) with `component_role`
 *   (`STANDARD`, `SWEETENER`, `MILK_BASE`, `COFFEE_SHOT`, `TEA_BASE`, `TOPPING`, `PACKAGING`) and `wastage_basis_points`
 * - Rejects circular BOM edges (`A -> B -> C -> A`) with `HTTP 422 Circular BOM Dependency` before database write
 * - Computes live Recipe COGS & Leaf Deduction Previews respecting `use_production` Stopping Rule
 *   and Role-Based Modifiers (e.g., `MOD-SWEET-50` scales only `SWEETENER` by `-5000 bps`)
 * - Executes Prep Kitchen Batch Builds (`PRODUCTION_BUILD`) for intermediate items (`use_production = true`)
 */

import {
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
} from '../../../../shared-contracts/src/fixed-point.ts';
import type {
  BomEdgeDto,
  StockDeductionEntry,
} from '../../../../shared-contracts/src/ipc-commands.ts';
import type { ProductionBuildResult } from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export interface RecipeDeductionViewModel extends StockDeductionEntry {
  deductedQtyFormatted: string;
  unitCostFormatted: string;
  lineCogsFormatted: string;
}

export interface LiveRecipePreviewViewModel {
  compositeVariantId: string;
  itemName: string;
  priceSatang: number;
  priceFormatted: string;
  totalCogsMicroBaht: number;
  totalCogsFormatted: string;
  grossMarginSatang: number;
  grossMarginFormatted: string;
  deductions: RecipeDeductionViewModel[];
}

export class BomEditorViewController {
  private readonly bridge: LocalIpcBridge;
  private readonly defaultOutletId: string;

  constructor(bridge: LocalIpcBridge, defaultOutletId = 'OUTLET-HQ') {
    this.bridge = bridge;
    this.defaultOutletId = defaultOutletId;
  }

  /**
   * Adds or updates a BOM recipe edge with automatic DFS DAG cycle detection.
   */
  public async upsertRecipeIngredient(edge: BomEdgeDto): Promise<void> {
    return this.bridge.upsertBomComponentEdge(edge);
  }

  /**
   * Lists all active BOM edges in the recipe graph.
   */
  public getRecipeEdges(): BomEdgeDto[] {
    return this.bridge.listBomEdges();
  }

  /**
   * Computes a live multi-level BOM deduction & COGS breakdown for a menu item,
   * applying role-based modifiers (such as `['MOD-SWEET-50']` for 50% sweetness).
   */
  public previewRecipeDeductionsAndCogs(
    compositeVariantId: string,
    qtyMilli = 1_000,
    selectedModifierIds: readonly string[] = []
  ): LiveRecipePreviewViewModel {
    const preview = this.bridge.computeLiveRecipePreview(
      this.defaultOutletId,
      compositeVariantId,
      qtyMilli,
      selectedModifierIds
    );

    const deductions: RecipeDeductionViewModel[] = preview.deductions.map((d) => ({
      ...d,
      deductedQtyFormatted: formatMilliUnitsToQtyString(Math.abs(d.quantityChangeMilli), 'unit'),
      unitCostFormatted: `฿${formatMicroBahtToThbString(d.unitCostMicroBaht)}`,
      lineCogsFormatted: `฿${formatMicroBahtToThbString(d.lineCogsMicroBaht)}`,
    }));

    return {
      compositeVariantId: preview.compositeVariantId,
      itemName: preview.itemName,
      priceSatang: preview.priceSatang,
      priceFormatted: `฿${formatSatangToThbString(preview.priceSatang)}`,
      totalCogsMicroBaht: preview.totalCogsMicroBaht,
      totalCogsFormatted: `฿${formatMicroBahtToThbString(preview.totalCogsMicroBaht)}`,
      grossMarginSatang: preview.grossMarginSatang,
      grossMarginFormatted: `฿${formatSatangToThbString(preview.grossMarginSatang)}`,
      deductions,
    };
  }

  /**
   * Executes a Prep Kitchen Batch Build (`PRODUCTION_BUILD`) for a pre-built intermediate ingredient
   * (`use_production = true`), deducting its child raw materials and updating the intermediate item's MAC.
   */
  public async runPrepBatchBuild(params: {
    compositeVariantId: string;
    buildQtyMilli: number;
    performedByUserId: string;
    outletId?: string;
  }): Promise<ProductionBuildResult> {
    return this.bridge.executeProductionBuildBatch({
      outletId: params.outletId ?? this.defaultOutletId,
      compositeVariantId: params.compositeVariantId,
      buildQtyMilli: params.buildQtyMilli,
      performedByUserId: params.performedByUserId,
    });
  }
}
