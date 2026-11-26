import type {
  BomEdgeDto,
  BusinessProfile,
  CheckoutOrderRequest,
  ComponentRole,
  ItemVariantDto,
  ModifierDto,
  PosShiftDto,
  SplitPaymentLegInput,
  UserRole,
} from '@rube-pos/shared-contracts';
import type { TaxMode } from '../../../shared-contracts/src/fixed-point.ts';

export type PrinterTransportMode =
  | 'SIMULATED_MEMORY'
  | 'LAN_TCP_9100'
  | 'WINDOWS_RAW_USB'
  | 'BROWSER_PRINT_DIALOG';

export interface PrinterHardwareConfigDto {
  mode: PrinterTransportMode;
  tcpHost: string;
  tcpPort: number;
  windowsPrinterName: string;
  paperWidthMm: 80 | 58;
  autoKickDrawerOnCash: boolean;
}

export type WorkspaceTabId =
  | 'POS'
  | 'KDS'
  | 'WAREHOUSE'
  | 'BOM'
  | 'SHIFTS_REPORTS'
  | 'SETTINGS';

export interface ProfileFeatureFlagsDto {
  profile: BusinessProfile;
  defaultPosView: 'RETAIL_FAST_GRID' | 'CAFE_TOUCH_TILES' | 'DUAL_SWITCHABLE';
  enableGlobalBarcodeScanner: boolean;
  enableScaleBarcodeParser: boolean;
  enableMultiLevelBom: boolean;
  enableRoleBasedModifiers: boolean;
  enableKitchenDisplaySystem: boolean;
}

export interface CatalogVariantDetailDto extends ItemVariantDto {
  defaultPurchaseCostMicroBaht: number;
  optimalStockMilli: number;
  lowStockThresholdMilli: number;
  categoryId: string | null;
  categoryName: string;
  categoryColor: string;
  kitchenStation: string;
  active: boolean;
  imageUrl?: string | null | undefined;
}

export interface CategoryDto {
  id: string;
  name: string;
  displayColor: string;
  kitchenStation: string;
  sortOrder: number;
}

export interface SupplierDto {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  phone: string | null;
  active: boolean;
}

export interface OutletDto {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  branchCode: string;
  rdPosRegNo: string | null;
  isWarehouse: boolean;
  active: boolean;
}

export interface ModifierGroupWithItemsDto {
  id: string;
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  modifiers: ModifierDto[];
}

export interface KdsTicketItemDto {
  id: string;
  itemSummaryText: string;
  modifiersSummaryText: string | null;
  quantityMilli: number;
  status: 'PENDING' | 'DONE';
}

export interface KdsTicketDto {
  sequenceId: number;
  kitchenOrderId: string;
  salesOrderId: string;
  outletId: string;
  station: string;
  queueNumber: string;
  status: 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED';
  createdAt: string;
  items: KdsTicketItemDto[];
}

export interface SalesOrderHistoryDto {
  salesOrderId: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string | null;
  shiftId: string;
  cashierId: string;
  cashierName: string;
  orderType: CheckoutOrderRequest['orderType'];
  tableOrQueueNo: string | null;
  status: 'OPEN' | 'COMPLETED' | 'VOIDED';
  taxMode: TaxMode;
  subtotalSatang: number;
  discountSatang: number;
  netBeforeTaxSatang: number;
  taxSatang: number;
  totalSatang: number;
  totalCogsMicroBaht: number;
  paymentMethod: CheckoutOrderRequest['paymentMethod'];
  paymentSummaryLabel?: string | undefined;
  payments?: Array<{
    paymentMethod: CheckoutOrderRequest['paymentMethod'];
    amountSatang: number;
    cashTenderedSatang: number | null;
    changeGivenSatang: number | null;
    senderBankCode: string | null;
    slipTransRefLast4: string | null;
  }> | undefined;
  cashTenderedSatang: number | null;
  changeGivenSatang: number | null;
  senderBankCode: string | null;
  slipTransRefLast4: string | null;
  voidReason: string | null;
  createdAt: string;
  lines: Array<{
    salesOrderItemId: string;
    variantId: string;
    itemName: string;
    unitName: string;
    quantityMilli: number;
    unitPriceSatang: number;
    modifiersTotalSatang: number;
    lineTotalSatang: number;
    modifiers: Array<{
      name: string;
      priceDeltaSatang: number;
    }>;
  }>;
}

export interface DrawerMovementDto {
  id: string;
  shiftId: string;
  movementType: 'OPENING_FLOAT' | 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
  amountSatang: number;
  reason: string;
  performedByUserId: string;
  performedByName: string;
  expectedCashAfterSatang: number;
  createdAt: string;
}

export interface StaffUserDto {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface StoreIdentitySettingsDto {
  outletId: string;
  outletCode: string;
  storeName: string;
  taxId: string;
  branchCode: string;
  rdPosRegNo: string;
  promptPayId: string;
  businessProfile: BusinessProfile;
}

export interface UsbBackupFileDto {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface UsbBackupConfigStatusDto {
  customBackupDir: string;
  defaultLocalBackupDir: string;
  activeEffectiveDir: string;
  isExternalCustomDir: boolean;
  targetWritable: boolean;
  mirrorToLocalFallback: boolean;
}

export interface DiscoveredStorageDriveDto {
  driveLetter: string;
  volumeName: string;
  driveKind: 'REMOVABLE_USB' | 'FIXED_DISK' | 'NETWORK_DRIVE' | 'OTHER';
  freeBytes: number;
  totalBytes: number;
  suggestedBackupPath: string;
}

export interface UpsAlertBannerDto {
  visible: boolean;
  severity: 'NONE' | 'WARNING_ON_BATTERY' | 'CRITICAL_LOW_BATTERY_LOCK';
  headlineThai: string;
  batteryChargePercent: number;
  estimatedRuntimeSeconds: number;
  walCheckpointFlushed: boolean;
}

export interface BootstrapPayload {
  onboarded: boolean;
  isSessionAuthenticated?: boolean | undefined;
  isPreviewWizard?: boolean | undefined;
  profile: BusinessProfile;
  featureFlags: ProfileFeatureFlagsDto;
  activeShift: PosShiftDto | null;
  catalog: ItemVariantDto[];
  catalogDetailed: CatalogVariantDetailDto[];
  categories: CategoryDto[];
  suppliers: SupplierDto[];
  outlets: OutletDto[];
  bomEdges: BomEdgeDto[];
  modifiers: ModifierDto[];
  modifierGroups: ModifierGroupWithItemsDto[];
  kdsTickets: KdsTicketDto[];
  recentOrders: SalesOrderHistoryDto[];
  heldBills?: HeldBillRecordDto[] | undefined;
  shiftsHistory: PosShiftDto[];
  drawerMovements: DrawerMovementDto[];
  staffUsers: StaffUserDto[];
  storeSettings: StoreIdentitySettingsDto;
  printerConfig: PrinterHardwareConfigDto;
  usbBackupConfig?: UsbBackupConfigStatusDto | undefined;
  usbBackups: UsbBackupFileDto[];
  ledgerInvariant: {
    valid: boolean;
    mismatches: Array<{
      variantId: string;
      levelStockMilli: number;
      ledgerSumMilli: number;
    }>;
  };
  upsBanner: UpsAlertBannerDto;
  printer: {
    ready: boolean;
    pendingQueueLength: number;
  };
  cluster: {
    operatingMode: 'STANDALONE_IPC_ONLY' | 'MULTI_TERMINAL_LAN_CLUSTER';
    roleState: 'ACTIVE_LEADER' | 'WARM_STANDBY_FOLLOWER' | 'READ_ONLY_QUARANTINE';
    currentEpoch: number;
    terminalId: string;
    globalTxSeq: number;
    ipcStats: {
      readsRouted: number;
      writesRouted: number;
    };
  };
}

export interface CartItem {
  cartKey: string;
  variantId: string;
  itemName: string;
  variantName: string;
  sku: string;
  unitName: string;
  quantityMilli: number;
  unitPriceSatang: number;
  overrideLineTotalSatang?: number | undefined;
  selectedModifierIds: string[];
  isWeightedScale: boolean;
  scaleBadgeText?: string | undefined;
}

export interface HeldBillRecordDto {
  id: string;
  outletId: string;
  referenceLabel: string;
  orderType: CheckoutOrderRequest['orderType'];
  taxMode: TaxMode;
  discountMode?: 'BAHT' | 'PERCENT' | undefined;
  discountInput?: string | undefined;
  cart: CartItem[];
  totalSatang: number;
  heldByName: string;
  heldAtIso: string;
}

export interface PrintedReceiptPreview {
  salesOrderId?: string | undefined;
  receiptNumber: string;
  abbTaxInvoiceNo: string;
  formattedTextLines: string[];
  canvasRasterPreviewUrl?: string | undefined;
  paperWidthMm?: 80 | 58 | undefined;
  packetsCount: number;
  maxPacketByteLength: number;
  spoolStatus: string;
  pendingQueueLength: number;
  hardwareDispatched?: boolean | undefined;
  hardwareError?: string | undefined;
}

export type {
  BomEdgeDto,
  BusinessProfile,
  CheckoutOrderRequest,
  ComponentRole,
  ItemVariantDto,
  ModifierDto,
  PosShiftDto,
  SplitPaymentLegInput,
  TaxMode,
  UserRole,
};
