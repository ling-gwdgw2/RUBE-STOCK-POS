/**
 * RUBE-STOCK-POS v3.1 Local Tauri IPC Bridge (`IPC_BRIDGE` — Squad D Phase 1)
 *
 * Connects Squad C UI Controllers (`INV_VIEW`, `PO_VIEW`, `BOM_VIEW`) directly to
 * Squad A's `SqliteReadWritePoolEngine` (`1 Writer BEGIN IMMEDIATE` + `4..8 Readers query_only = ON`).
 */

import type {
  BomEdgeDto,
  BusinessProfile,
  CheckoutOrderRequest,
  ItemVariantDto,
  ModifierDto,
  PosShiftDto,
} from '../../shared-contracts/src/ipc-commands.ts';
import type {
  CashDrawerMovementRecord,
  CheckoutOrderResult,
  ClosePosShiftBlindDropInput,
  CreatePurchaseOrderInput,
  OpenPosShiftInput,
  PoReceivePreviewLine,
  PoReceiveResult,
  ProductionBuildResult,
  ReceiveTransferOrderInput,
  RecordCashDrawerMovementInput,
  SqliteReadWritePoolEngine,
  TransferOrderDispatchResult,
  TransferOrderReceiveResult,
  VoidSalesOrderInput,
  VoidSalesOrderResult,
  DispatchTransferOrderInput,
  ExecuteInventoryCountInput,
  InventoryCountResult,
  KitchenOrderTicketDto,
  SchemaUpgradeInput,
  SchemaUpgradeResult,
  ShiftZReportDto,
  AbbSalesTaxReportDto,
  InventoryValuationReportDto,
  MenuGrossMarginReportDto,
} from '../../core-engine/src/runtime/sqlite-engine.ts';
import type { LanClusterCoordinator } from './lan-cluster-coordinator.ts';

export class LocalIpcBridge {
  private readonly engine: SqliteReadWritePoolEngine;
  private clusterCoordinator: LanClusterCoordinator | null = null;
  public totalReadsRouted = 0;
  public totalWritesRouted = 0;

  constructor(engine: SqliteReadWritePoolEngine, clusterCoordinator?: LanClusterCoordinator) {
    this.engine = engine;
    this.clusterCoordinator = clusterCoordinator ?? null;
  }

  public attachClusterCoordinator(coordinator: LanClusterCoordinator): void {
    this.clusterCoordinator = coordinator;
  }

  private assertNotQuarantined(): void {
    this.clusterCoordinator?.assertWriteAllowedOnLeader();
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

  public listModifiers(): ModifierDto[] {
    this.totalReadsRouted++;
    return this.engine.listModifiers();
  }

  public async openPosShift(input: OpenPosShiftInput): Promise<PosShiftDto> {
    this.totalWritesRouted++;
    return this.engine.openPosShift(input);
  }

  public getActiveShift(outletId = 'OUTLET-HQ', terminalId = 'POS-TERM-01'): PosShiftDto | null {
    this.totalReadsRouted++;
    return this.engine.getActiveShift(outletId, terminalId);
  }

  public getShiftById(shiftId: string): PosShiftDto | null {
    this.totalReadsRouted++;
    return this.engine.getShiftById(shiftId);
  }

  public async recordCashDrawerMovement(
    input: RecordCashDrawerMovementInput
  ): Promise<CashDrawerMovementRecord> {
    this.totalWritesRouted++;
    return this.engine.recordCashDrawerMovement(input);
  }

  public async closePosShiftBlindDrop(
    input: ClosePosShiftBlindDropInput
  ): Promise<PosShiftDto> {
    this.totalWritesRouted++;
    return this.engine.closePosShiftBlindDrop(input);
  }

  public async checkoutSalesOrder(request: CheckoutOrderRequest): Promise<CheckoutOrderResult> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.checkoutSalesOrder(request);
  }

  public async voidSalesOrder(input: VoidSalesOrderInput): Promise<VoidSalesOrderResult> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.voidSalesOrder(input);
  }

  public async registerOutlet(input: {
    id: string;
    code: string;
    name: string;
    isWarehouse?: boolean;
  }): Promise<void> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.registerOutlet(input);
  }

  public async dispatchTransferOrder(
    input: DispatchTransferOrderInput
  ): Promise<TransferOrderDispatchResult> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.dispatchTransferOrder(input);
  }

  public async receiveTransferOrder(
    input: ReceiveTransferOrderInput
  ): Promise<TransferOrderReceiveResult> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.receiveTransferOrder(input);
  }

  public async executePhysicalInventoryCount(
    input: ExecuteInventoryCountInput
  ): Promise<InventoryCountResult> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.executePhysicalInventoryCount(input);
  }

  public getMissedKitchenOrders(
    outletId = 'OUTLET-HQ',
    station = 'BAR',
    lastAckedKdsSeq = 0
  ): KitchenOrderTicketDto[] {
    this.totalReadsRouted++;
    return this.engine.getMissedKitchenOrders(outletId, station, lastAckedKdsSeq);
  }

  public async acknowledgeAndAdvanceKdsOrder(input: {
    terminalId: string;
    kitchenOrderId: string;
    newStatus: 'PREPARING' | 'READY' | 'SERVED';
    ackedSequenceId: number;
  }) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.acknowledgeAndAdvanceKdsOrder(input);
  }

  public async triggerEmergencyUpsWalCheckpoint(terminalId = 'POS-TERM-01') {
    this.totalWritesRouted++;
    return this.engine.triggerEmergencyUpsWalCheckpoint(terminalId);
  }

  public async exportEncryptedUsbBackupWithRingBuffer(
    usbBackupDir: string,
    shiftNumber: string
  ) {
    this.totalWritesRouted++;
    return this.engine.exportEncryptedUsbBackupWithRingBuffer(usbBackupDir, shiftNumber);
  }

  public async setProtectedStoreConfig(input: {
    key: string;
    value: string;
    updatedByUserId: string;
    terminalId?: string;
  }) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.setProtectedStoreConfig(input);
  }

  public getVerifiedProtectedStoreConfig(key: string): string | null {
    this.totalReadsRouted++;
    return this.engine.getVerifiedProtectedStoreConfig(key);
  }

  public async setBusinessProfileMode(
    profile: BusinessProfile,
    updatedByUserId = 'USR-OWNER-01'
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.setBusinessProfileMode(profile, updatedByUserId);
  }

  public getVerifiedBusinessProfileMode(): BusinessProfile {
    this.totalReadsRouted++;
    return this.engine.getVerifiedBusinessProfileMode();
  }

  public async executeFiveStepSchemaUpgrade(
    input: SchemaUpgradeInput
  ): Promise<SchemaUpgradeResult> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.executeFiveStepSchemaUpgrade(input);
  }

  public generateShiftZReport(shiftId: string): ShiftZReportDto {
    this.totalReadsRouted++;
    return this.engine.generateShiftZReport(shiftId);
  }

  public generateAbbSalesTaxReport(outletId = 'OUTLET-HQ'): AbbSalesTaxReportDto {
    this.totalReadsRouted++;
    return this.engine.generateAbbSalesTaxReport(outletId);
  }

  public generateInventoryValuationReport(outletId = 'OUTLET-HQ'): InventoryValuationReportDto {
    this.totalReadsRouted++;
    return this.engine.generateInventoryValuationReport(outletId);
  }

  public generateMenuGrossMarginAndCogsReport(outletId = 'OUTLET-HQ'): MenuGrossMarginReportDto {
    this.totalReadsRouted++;
    return this.engine.generateMenuGrossMarginAndCogsReport(outletId);
  }
}
