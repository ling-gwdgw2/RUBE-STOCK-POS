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
  ComponentRole,
  ItemVariantDto,
  ModifierDto,
  PosShiftDto,
  UserRole,
} from '../../shared-contracts/src/ipc-commands.ts';
import type {
  CashDrawerMovementRecord,
  CatalogVariantDetailDto,
  CategoryDto,
  CheckoutOrderResult,
  ClosePosShiftBlindDropInput,
  CreatePurchaseOrderInput,
  FirstRunOnboardingInput,
  InventoryLedgerEntryDto,
  ModifierGroupWithItemsDto,
  OpenPosShiftInput,
  OutletDto,
  PoReceivePreviewLine,
  PoReceiveResult,
  ProductionBuildResult,
  PurchaseOrderHistoryDto,
  ReceiveTransferOrderInput,
  RecordCashDrawerMovementInput,
  ReportDateRangeFilter,
  SalesOrderHistoryDto,
  SecurityAuditLogEntryDto,
  SqliteReadWritePoolEngine,
  StaffUserDto,
  StoreIdentitySettingsDto,
  SupplierDto,
  TransferOrderDispatchResult,
  TransferOrderHistoryDto,
  TransferOrderReceiveResult,
  UpsertCatalogVariantInput,
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

  public generateAbbSalesTaxReport(
    outletId = 'OUTLET-HQ',
    dateRange?: ReportDateRangeFilter
  ): AbbSalesTaxReportDto {
    this.totalReadsRouted++;
    return this.engine.generateAbbSalesTaxReport(outletId, dateRange);
  }

  public generateInventoryValuationReport(outletId = 'OUTLET-HQ'): InventoryValuationReportDto {
    this.totalReadsRouted++;
    return this.engine.generateInventoryValuationReport(outletId);
  }

  public generateMenuGrossMarginAndCogsReport(
    outletId = 'OUTLET-HQ',
    dateRange?: ReportDateRangeFilter
  ): MenuGrossMarginReportDto {
    this.totalReadsRouted++;
    return this.engine.generateMenuGrossMarginAndCogsReport(outletId, dateRange);
  }

  public listStaffUsers(): StaffUserDto[] {
    this.totalReadsRouted++;
    return this.engine.listStaffUsers();
  }

  public async authenticateStaffByPin(input: {
    pin: string;
    userId?: string | undefined;
    terminalId?: string | undefined;
  }): Promise<StaffUserDto> {
    this.totalWritesRouted++;
    return this.engine.authenticateStaffByPin(input);
  }

  public async upsertStaffUser(input: {
    id?: string | undefined;
    username: string;
    displayName: string;
    role: UserRole;
    pin?: string | undefined;
    active?: boolean | undefined;
    actorUserId?: string | undefined;
  }): Promise<StaffUserDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.upsertStaffUser(input);
  }

  public getFiscalConfig() {
    this.totalReadsRouted++;
    return this.engine.getFiscalConfig();
  }

  public async updateFiscalConfig(
    input: Parameters<SqliteReadWritePoolEngine['updateFiscalConfig']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.updateFiscalConfig(input);
  }

  public async updateUiLocale(
    input: Parameters<SqliteReadWritePoolEngine['updateUiLocale']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.updateUiLocale(input);
  }

  public getStoreIdentitySettings(outletId = 'OUTLET-HQ'): StoreIdentitySettingsDto {
    this.totalReadsRouted++;
    return this.engine.getStoreIdentitySettings(outletId);
  }

  public async updateStoreIdentitySettings(
    input: Parameters<SqliteReadWritePoolEngine['updateStoreIdentitySettings']>[0]
  ): Promise<StoreIdentitySettingsDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.updateStoreIdentitySettings(input);
  }

  public listOutlets(): OutletDto[] {
    this.totalReadsRouted++;
    return this.engine.listOutlets();
  }

  public listCategories(): CategoryDto[] {
    this.totalReadsRouted++;
    return this.engine.listCategories();
  }

  public async upsertCategory(input: {
    id?: string | undefined;
    name: string;
    displayColor?: string | undefined;
    kitchenStation?: string | undefined;
    sortOrder?: number | undefined;
  }): Promise<CategoryDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.upsertCategory(input);
  }

  public async deleteCategory(categoryId: string): Promise<{ deletedCategoryId: string }> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.deleteCategory(categoryId);
  }

  public listSuppliers(): SupplierDto[] {
    this.totalReadsRouted++;
    return this.engine.listSuppliers();
  }

  public async upsertSupplier(input: {
    id?: string | undefined;
    code: string;
    name: string;
    taxId?: string | null | undefined;
    phone?: string | null | undefined;
  }): Promise<SupplierDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.upsertSupplier(input);
  }

  public listCatalogVariantsDetailed(outletId = 'OUTLET-HQ'): CatalogVariantDetailDto[] {
    this.totalReadsRouted++;
    return this.engine.listCatalogVariantsDetailed(outletId);
  }

  public async upsertCatalogVariant(
    input: UpsertCatalogVariantInput
  ): Promise<CatalogVariantDetailDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.upsertCatalogVariant(input);
  }

  public async deleteCatalogVariant(
    variantId: string,
    performedByUserId = 'USR-OWNER-01'
  ): Promise<{ variantId: string; mode: 'HARD_DELETED' | 'ARCHIVED_SAFE' }> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.deleteCatalogVariant(variantId, performedByUserId);
  }

  public async deleteBomComponentEdge(
    compositeVariantId: string,
    componentVariantId: string
  ): Promise<void> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.deleteBomComponentEdge(compositeVariantId, componentVariantId);
  }

  public listModifierGroupsWithModifiers(): ModifierGroupWithItemsDto[] {
    this.totalReadsRouted++;
    return this.engine.listModifierGroupsWithModifiers();
  }

  public listKitchenOrdersAllStations(
    outletId = 'OUTLET-HQ',
    includeServed = false
  ): KitchenOrderTicketDto[] {
    this.totalReadsRouted++;
    return this.engine.listKitchenOrdersAllStations(outletId, includeServed);
  }

  public listShiftsHistory(outletId = 'OUTLET-HQ', limit = 20): PosShiftDto[] {
    this.totalReadsRouted++;
    return this.engine.listShiftsHistory(outletId, limit);
  }

  public listCashDrawerMovements(shiftId: string) {
    this.totalReadsRouted++;
    return this.engine.listCashDrawerMovements(shiftId);
  }

  public listRecentSalesOrders(outletId = 'OUTLET-HQ', limit = 40): SalesOrderHistoryDto[] {
    this.totalReadsRouted++;
    return this.engine.listRecentSalesOrders(outletId, limit);
  }

  public listInventoryTransactions(
    outletId = 'OUTLET-HQ',
    limit = 80,
    variantId?: string | undefined
  ): InventoryLedgerEntryDto[] {
    this.totalReadsRouted++;
    return this.engine.listInventoryTransactions(outletId, limit, variantId);
  }

  public listPurchaseOrdersHistory(outletId = 'OUTLET-HQ', limit = 30): PurchaseOrderHistoryDto[] {
    this.totalReadsRouted++;
    return this.engine.listPurchaseOrdersHistory(outletId, limit);
  }

  public listTransferOrdersHistory(limit = 30): TransferOrderHistoryDto[] {
    this.totalReadsRouted++;
    return this.engine.listTransferOrdersHistory(limit);
  }

  public listSecurityAuditLogs(limit = 50): SecurityAuditLogEntryDto[] {
    this.totalReadsRouted++;
    return this.engine.listSecurityAuditLogs(limit);
  }

  public async upsertModifierGroup(input: {
    id?: string | undefined;
    name: string;
    selectionType: 'SINGLE' | 'MULTIPLE';
    minSelections?: number | undefined;
    maxSelections?: number | undefined;
  }): Promise<ModifierGroupWithItemsDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.upsertModifierGroup(input);
  }

  public async deleteModifierGroup(groupId: string): Promise<void> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.deleteModifierGroup(groupId);
  }

  public async upsertModifierItem(input: {
    id?: string | undefined;
    modifierGroupId: string;
    name: string;
    priceDeltaSatang: number;
    modifierMode: 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS';
    componentVariantId?: string | null | undefined;
    quantityDeltaMilli?: number | undefined;
    targetComponentRole?: ComponentRole | null | undefined;
    scaleBasisPoints?: number | undefined;
    sortOrder?: number | undefined;
  }): Promise<ModifierDto> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.upsertModifierItem(input);
  }

  public async deleteModifierItem(modifierId: string): Promise<void> {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.deleteModifierItem(modifierId);
  }

  public isSystemOnboarded(): boolean {
    this.totalReadsRouted++;
    return this.engine.isSystemOnboarded();
  }

  public async initializeFirstRunOnboarding(input: FirstRunOnboardingInput) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.initializeFirstRunOnboarding(input);
  }

  public getQrOrderingConfig() {
    this.totalReadsRouted++;
    return this.engine.getQrOrderingConfig();
  }

  public async updateQrOrderingConfig(
    input: Parameters<SqliteReadWritePoolEngine['updateQrOrderingConfig']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.updateQrOrderingConfig(input);
  }

  public async openTableQrSession(
    input: Parameters<SqliteReadWritePoolEngine['openTableQrSession']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.openTableQrSession(input);
  }

  public listTableQrSessions(outletId = 'OUTLET-HQ', baseUrl?: string) {
    this.totalReadsRouted++;
    return this.engine.listTableQrSessions(outletId, baseUrl);
  }

  public async revokeTableQrSession(
    input: Parameters<SqliteReadWritePoolEngine['revokeTableQrSession']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.revokeTableQrSession(input);
  }

  public verifyTableQrToken(outletId: string, tableLabel: string, rawToken: string) {
    this.totalReadsRouted++;
    return this.engine.verifyTableQrToken(outletId, tableLabel, rawToken);
  }

  public async submitGuestOrder(
    input: Parameters<SqliteReadWritePoolEngine['submitGuestOrder']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.submitGuestOrder(input);
  }

  public listGuestOrders(outletId = 'OUTLET-HQ') {
    this.totalReadsRouted++;
    return this.engine.listGuestOrders(outletId);
  }

  public getGuestOrderStatusById(outletId: string, guestOrderId: string) {
    this.totalReadsRouted++;
    return this.engine.getGuestOrderStatusById(outletId, guestOrderId);
  }

  public async acceptGuestOrderToHeldBillAndKds(
    input: Parameters<SqliteReadWritePoolEngine['acceptGuestOrderToHeldBillAndKds']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.acceptGuestOrderToHeldBillAndKds(input);
  }

  public async rejectGuestOrder(
    input: Parameters<SqliteReadWritePoolEngine['rejectGuestOrder']>[0]
  ) {
    this.assertNotQuarantined();
    this.totalWritesRouted++;
    return this.engine.rejectGuestOrder(input);
  }
}
