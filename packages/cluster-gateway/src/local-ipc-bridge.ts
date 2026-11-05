/**
 * RUBE-STOCK-POS v3.1 Local Tauri IPC Bridge (`IPC_BRIDGE` — Squad D Phase 1)
 *
 * Connects Squad C UI Controllers (`INV_VIEW`, `PO_VIEW`, `BOM_VIEW`) directly to
 * Squad A's `SqliteReadWritePoolEngine` (`1 Writer BEGIN IMMEDIATE` + `4..8 Readers query_only = ON`).
 */

import type {
  BomEdgeDto,
  ItemVariantDto,
} from '../../shared-contracts/src/ipc-commands.ts';
import type {
  CreatePurchaseOrderInput,
  PoReceivePreviewLine,
  PoReceiveResult,
  ProductionBuildResult,
  SqliteReadWritePoolEngine,
} from '../../core-engine/src/runtime/sqlite-engine.ts';

export class LocalIpcBridge {
  private readonly engine: SqliteReadWritePoolEngine;
  public totalReadsRouted = 0;
  public totalWritesRouted = 0;

  constructor(engine: SqliteReadWritePoolEngine) {
    this.engine = engine;
  }

  public getInventoryCatalog(outletId = 'OUTLET-HQ'): ItemVariantDto[] {
    this.totalReadsRouted++;
    return this.engine.listInventoryCatalog(outletId);
  }

  public async adjustInventoryStock(input: {
    outletId?: string;
    variantId: string;
    transactionType: 'SALE_DIRECT' | 'SALE_BOM' | 'SALE_MODIFIER' | 'ADJUSTMENT';
    quantityDeltaMilli: number;
    referenceType: string;
    referenceId: string;
    performedByUserId: string;
  }) {
    this.totalWritesRouted++;
    return this.engine.recordStockDelta({
      outletId: input.outletId ?? 'OUTLET-HQ',
      variantId: input.variantId,
      transactionType: input.transactionType,
      quantityDeltaMilli: input.quantityDeltaMilli,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      performedByUserId: input.performedByUserId,
    });
  }

  public previewPurchaseOrderCosting(input: CreatePurchaseOrderInput): PoReceivePreviewLine[] {
    this.totalReadsRouted++;
    return this.engine.previewPurchaseOrderCosting(input);
  }

  public async receivePurchaseOrderWithLandedCosts(
    input: CreatePurchaseOrderInput
  ): Promise<PoReceiveResult> {
    this.totalWritesRouted++;
    return this.engine.receivePurchaseOrderWithLandedCosts(input);
  }

  public async upsertBomComponentEdge(edge: BomEdgeDto): Promise<void> {
    this.totalWritesRouted++;
    return this.engine.upsertBomComponentEdge(edge);
  }

  public listBomEdges(): BomEdgeDto[] {
    this.totalReadsRouted++;
    return this.engine.listBomEdges();
  }

  public computeLiveRecipePreview(
    outletId: string,
    compositeVariantId: string,
    qtyMilli = 1_000,
    selectedModifierIds: readonly string[] = []
  ) {
    this.totalReadsRouted++;
    return this.engine.computeLiveRecipePreview(
      outletId,
      compositeVariantId,
      qtyMilli,
      selectedModifierIds
    );
  }

  public async executeProductionBuildBatch(params: {
    outletId?: string;
    compositeVariantId: string;
    buildQtyMilli: number;
    performedByUserId: string;
  }): Promise<ProductionBuildResult> {
    this.totalWritesRouted++;
    return this.engine.executeProductionBuildBatch({
      outletId: params.outletId ?? 'OUTLET-HQ',
      compositeVariantId: params.compositeVariantId,
      buildQtyMilli: params.buildQtyMilli,
      performedByUserId: params.performedByUserId,
    });
  }

  public verifyLedgerConservationInvariant(outletId = 'OUTLET-HQ') {
    this.totalReadsRouted++;
    return this.engine.verifyLedgerConservationInvariant(outletId);
  }
}
