import type {
  BarcodeLabelPrinterConfigDto,
  BarcodeLabelTargetMode,
  BomEdgeDto,
  BootstrapPayload,
  BusinessProfile,
  CashRoundingStepMajor,
  CatalogVariantDetailDto,
  CategoryDto,
  CheckoutOrderRequest,
  ComponentRole,
  CountryCode,
  DiscoveredStorageDriveDto,
  FiscalConfigDto,
  ForeignTenderCurrencyCode,
  FxCashTenderDetailDto,
  FxRatesConfigDto,
  GuestOrderRecordDto,
  GuestServiceCallDto,
  HeldBillRecordDto,
  KdsTicketDto,
  LaoQrVerificationPolicy,
  LocaleCode,
  ModifierDto,
  ModifierGroupWithItemsDto,
  NfcTableTagPackageDto,
  PosShiftDto,
  PrintedReceiptPreview,
  PrinterHardwareConfigDto,
  QrOrderingConfigDto,
  QrOrderingRuntimeStatusDto,
  SalesOrderHistoryDto,
  SplitPaymentLegInput,
  StaffUserDto,
  StoreIdentitySettingsDto,
  SupplierDto,
  TableQrSessionDto,
  TaxMode,
  UpsAlertBannerDto,
  UsbBackupConfigStatusDto,
  UsbBackupFileDto,
  UserRole,
} from '../types.ts';

const POS_SESSION_TOKEN_STORAGE_KEY = 'rube_pos_v3_session_token';

let activeRequestLocale: LocaleCode = 'th';

export function getPosRequestLocale(): LocaleCode {
  return activeRequestLocale;
}

export function setPosRequestLocale(locale: LocaleCode): void {
  activeRequestLocale = locale;
}

let activeSessionToken: string | null = (() => {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(POS_SESSION_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
})();

export function getPosSessionToken(): string | null {
  return activeSessionToken;
}

export function setPosSessionToken(token: string | null): void {
  activeSessionToken = token && token.trim() ? token.trim() : null;
  if (typeof window === 'undefined') return;
  try {
    if (activeSessionToken) {
      window.sessionStorage.setItem(POS_SESSION_TOKEN_STORAGE_KEY, activeSessionToken);
    } else {
      window.sessionStorage.removeItem(POS_SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage restrictions
  }
}

function resolveApiBase(): string {
  if (typeof window === 'undefined') return '';
  const win = window as unknown as {
    __RUBE_API_BASE__?: string;
    __TAURI_INTERNALS__?: unknown;
  };
  if (win.__RUBE_API_BASE__) return win.__RUBE_API_BASE__;
  if (
    window.location.hostname === 'tauri.localhost' ||
    window.location.hostname.endsWith('.tauri.localhost') ||
    window.location.protocol === 'tauri:' ||
    window.location.protocol === 'file:' ||
    '__TAURI_INTERNALS__' in win
  ) {
    return 'http://127.0.0.1:4173';
  }
  return '';
}

export function resolveBackendAssetUrl(assetPath: string | null | undefined): string | null {
  if (!assetPath) return null;
  if (assetPath.startsWith('http://') || assetPath.startsWith('https://') || assetPath.startsWith('data:')) {
    return assetPath;
  }
  return `${resolveApiBase()}${assetPath}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${resolveApiBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Rube-Locale': activeRequestLocale,
      ...(activeSessionToken ? { Authorization: `Bearer ${activeSessionToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/pin-login')) {
      setPosSessionToken(null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('rube-pos-session-expired'));
      }
    }
    throw new Error(data.error || `HTTP ${res.status} Request failed on ${path}`);
  }
  return data;
}

export interface SlipConfirmationModalDto {
  valid: boolean;
  errorCode?: string;
  errorMessageThai?: string;
  bankCode?: string;
  bankDisplayNameThai?: string;
  transRefLast4?: string;
  slipTransRefHash?: string;
  expectedAmountFormatted?: string;
  visualPromptThai?: string;
}

export interface ReportsBundleDto {
  zReport: {
    shiftId: string;
    shiftNumber: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
    completedOrdersCount: number;
    voidedOrdersCount: number;
    openingCashSatang: number;
    openingCashFormatted: string;
    grossSalesSatang: number;
    grossSalesFormatted: string;
    discountTotalSatang: number;
    discountsFormatted: string;
    netBeforeTaxSatang: number;
    netBeforeTaxFormatted: string;
    vatTotalSatang: number;
    vat7PercentFormatted: string;
    netSalesTotalSatang: number;
    netSalesTotalFormatted: string;
    cashSalesSatang: number;
    cashSalesFormatted: string;
    promptPayQrSalesSatang: number;
    promptPaySalesFormatted: string;
    cardSalesSatang: number;
    cardSalesFormatted: string;
    voucherSalesSatang: number;
    voucherSalesFormatted: string;
    paidInSatang: number;
    paidInFormatted: string;
    paidOutSatang: number;
    paidOutFormatted: string;
    cashDropSatang: number;
    cashDropFormatted: string;
    voidedTotalSatang: number;
    voidedTotalFormatted: string;
    expectedCashSatang: number;
    expectedDrawerCashFormatted: string;
    countedCashSatang: number | null;
    countedDrawerCashFormatted: string | null;
    cashVarianceSatang: number | null;
    cashVarianceFormatted: string | null;
    fxCashSummaryFormatted?: {
      fxTransactionsCount: number;
      thbCollectedSatang: number;
      thbEquivalentBaseSatang: number;
      usdCollectedSatang: number;
      usdEquivalentBaseSatang: number;
      totalForeignEquivalentBaseSatang: number;
      expectedNativeBaseCashInDrawerSatang: number;
      thbCollectedFormatted: string;
      thbEquivalentFormatted: string;
      usdCollectedFormatted: string;
      usdEquivalentFormatted: string;
      totalForeignEquivalentFormatted: string;
      expectedNativeBaseCashFormatted: string;
    } | undefined;
  } | null;
  abbReport: {
    outletId: string;
    activeInvoiceCount: number;
    voidedInvoiceCount: number;
    totalTaxableBaseFormatted: string;
    totalVatFormatted: string;
    totalGrossFormatted: string;
    invoices: Array<{
      salesOrderId: string;
      abbTaxInvoiceNo: string;
      receiptNumber: string;
      orderType: string;
      status: string;
      netBeforeTaxFormatted: string;
      taxFormatted: string;
      totalFormatted: string;
      createdAt: string;
    }>;
  };
  valuationReport: {
    outletId: string;
    totalWarehouseValuationFormatted: string;
    lines: Array<{
      variantId: string;
      sku: string;
      itemName: string;
      stockFormatted: string;
      macFormatted: string;
      valuationFormatted: string;
    }>;
  };
  marginReport: {
    outletId: string;
    totalRevenueFormatted: string;
    totalCogsFormatted: string;
    totalGrossProfitFormatted: string;
    totalGrossMarginPercentFormatted: string;
    lines: Array<{
      variantId: string;
      itemName: string;
      soldQtyMilli: number;
      soldQtyFormatted: string;
      revenueFormatted: string;
      cogsFormatted: string;
      grossProfitFormatted: string;
      grossMarginPercentFormatted: string;
    }>;
  };
  shiftsHistory: BootstrapPayload['shiftsHistory'];
  usbBackups: UsbBackupFileDto[];
}

export const posTransport = {
  getBootstrap(outletId = 'OUTLET-HQ', autoOpenShift = true): Promise<BootstrapPayload> {
    return requestJson<BootstrapPayload>(
      `/api/bootstrap?outletId=${encodeURIComponent(outletId)}&autoOpenShift=${autoOpenShift}`
    );
  },

  async completeFirstRunOnboarding(input: {
    businessProfile: BusinessProfile;
    countryCode?: CountryCode;
    uiLocale?: LocaleCode;
    receiptLocale?: LocaleCode;
    vatRateBps?: number;
    defaultTaxMode?: TaxMode;
    cashRoundingStepMajor?: CashRoundingStepMajor;
    scalePriceEmbeddedMultiplier?: number;
    storeName: string;
    storeAddress?: string;
    taxId: string;
    branchCode: string;
    rdPosRegNo: string;
    promptPayId: string;
    laoQrStaticTemplate?: string;
    laoQrVerificationPolicy?: LaoQrVerificationPolicy;
    fxRates?: Partial<FxRatesConfigDto>;
    ownerDisplayName: string;
    ownerUsername?: string;
    ownerPin: string;
    recoveryPassphrase: string;
    loadDemoSampleCatalog: boolean;
    openingCashSatang: number;
    printerConfig?: PrinterHardwareConfigDto;
  }): Promise<{
    ok: boolean;
    ownerUser: StaffUserDto;
    activeShift: PosShiftDto;
    storeSettings: StoreIdentitySettingsDto;
    recoveryKitFilename: string;
    recoveryKitContent: string;
    sessionToken?: string;
    expiresAt?: string;
  }> {
    const res = await requestJson<{
      ok: boolean;
      ownerUser: StaffUserDto;
      activeShift: PosShiftDto;
      storeSettings: StoreIdentitySettingsDto;
      recoveryKitFilename: string;
      recoveryKitContent: string;
      sessionToken?: string;
      expiresAt?: string;
    }>('/api/onboarding/complete', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (res.sessionToken) {
      setPosSessionToken(res.sessionToken);
    }
    return res;
  },

  setPreviewFirstRunWizard(show: boolean): Promise<{ ok: boolean }> {
    return requestJson('/api/onboarding/preview-wizard', {
      method: 'POST',
      body: JSON.stringify({ show }),
    });
  },

  getPrinterConfig(): Promise<{ printerConfig: PrinterHardwareConfigDto }> {
    return requestJson('/api/printer/config');
  },

  savePrinterConfig(
    config: PrinterHardwareConfigDto
  ): Promise<{ printerConfig: PrinterHardwareConfigDto }> {
    return requestJson('/api/printer/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  listWindowsPrinters(): Promise<{
    printers: Array<{
      name: string;
      portName: string;
      isDefault: boolean;
      printerStatus: string;
    }>;
  }> {
    return requestJson('/api/printer/windows-list');
  },

  kickCashDrawer(): Promise<{
    ok: boolean;
    outcome: {
      dispatchedToHardware: boolean;
      transportMode: string;
      bytesWritten: number;
      errorMessage?: string;
    };
  }> {
    return requestJson('/api/hal/kick-drawer', { method: 'POST' });
  },

  printCanvasRaster(input: {
    packedBitmapBase64: string;
    widthPx: 384 | 576;
    heightPx: number;
    kickCashDrawer: boolean;
    salesOrderId?: string;
    receiptNumber?: string;
  }): Promise<{
    packetsCount: number;
    maxPacketByteLength: number;
    wireByteLength: number;
    spoolResult: { status: string; pendingQueueLength: number };
    hardwareOutcome: {
      dispatchedToHardware: boolean;
      transportMode: string;
      bytesWritten: number;
      errorMessage?: string;
    };
  }> {
    return requestJson('/api/hal/print-canvas-raster', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async pinLogin(pin: string, userId?: string): Promise<{ user: StaffUserDto }> {
    const res = await requestJson<{
      user: StaffUserDto;
      sessionToken?: string;
      expiresAt?: string;
    }>('/api/auth/pin-login', {
      method: 'POST',
      body: JSON.stringify({ pin, ...(userId ? { userId } : {}) }),
    });
    if (res.sessionToken) {
      setPosSessionToken(res.sessionToken);
    }
    return { user: res.user };
  },

  async verifyManagerOverridePin(
    pin: string
  ): Promise<{ user: StaffUserDto; overrideToken: string }> {
    const res = await requestJson<{
      user: StaffUserDto;
      sessionToken?: string;
    }>('/api/auth/pin-login', {
      method: 'POST',
      body: JSON.stringify({ pin, statelessOverride: true }),
    });
    return { user: res.user, overrideToken: res.sessionToken ?? '' };
  },

  async logoutSession(): Promise<void> {
    try {
      await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore network error on lock/logout
    } finally {
      setPosSessionToken(null);
    }
  },

  upsertStaffUser(input: {
    id?: string;
    username: string;
    displayName: string;
    role: UserRole;
    pin?: string;
    active?: boolean;
    actorUserId?: string;
  }): Promise<{ user: StaffUserDto }> {
    return requestJson('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  simulateHardwareScan(barcode: string): Promise<{
    searchInputTextAfter: string;
    firstCharRollbackCount: number;
    addedCartLine?: {
      variantId: string;
      itemName: string;
      unitName: string;
      quantityMilli: number;
      unitPriceSatang: number;
    };
  }> {
    return requestJson('/api/hal/simulate-scan', {
      method: 'POST',
      body: JSON.stringify({ barcode }),
    });
  },

  validateLaoQrTemplate(input: {
    rawTemplate?: string;
    generateSample?: boolean;
    merchantName?: string;
    merchantCity?: string;
    previewAmountSatang?: number;
  }): Promise<{
    valid: boolean;
    errorReason?: string;
    normalizedTemplate?: string;
    merchantAccountTag?: string;
    merchantName?: string;
    merchantCity?: string;
    currencyNumeric?: string;
    previewPayload?: string;
    previewCrcHex?: string;
    previewWholeLakAmount?: number;
  }> {
    return requestJson('/api/pos/validate-laoqr-template', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  generatePromptPayQr(input: {
    outletId?: string;
    overrideAmountSatang?: number;
    taxMode: TaxMode;
    discountSatang: number;
    lines: Array<{
      variantId: string;
      quantityMilli: number;
      unitPriceSatang: number;
      overrideLineTotalSatang?: number | undefined;
      selectedModifierIds: string[];
    }>;
  }): Promise<{
    payload: string;
    crcHex: string;
    qrScheme?: 'PROMPTPAY' | 'LAOQR';
    currencyCode?: 'THB' | 'LAK';
    promptPayId: string;
    storeName: string;
    totalSatang: number;
  }> {
    return requestJson('/api/pos/promptpay-qr', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  verifyBotSlipStep1(input: {
    miniQrRaw: string;
    senderBankCode?: string;
    overrideAmountSatang?: number;
    taxMode: TaxMode;
    discountSatang: number;
    lines: Array<{
      variantId: string;
      quantityMilli: number;
      unitPriceSatang: number;
      overrideLineTotalSatang?: number | undefined;
      selectedModifierIds: string[];
    }>;
  }): Promise<SlipConfirmationModalDto> {
    return requestJson('/api/pos/verify-slip-step1', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  checkoutOrder(input: {
    idempotencyKey?: string | undefined;
    outletId?: string;
    cashierId: string;
    orderType: CheckoutOrderRequest['orderType'];
    tableOrQueueNo?: string | undefined;
    paymentMethod: CheckoutOrderRequest['paymentMethod'];
    cashTenderedSatang?: number;
    foreignTenderCurrency?: ForeignTenderCurrencyCode;
    foreignTenderAmountSatang?: number;
    slipTransRefRaw?: string;
    slipSenderBankCode?: string;
    splitPayments?: SplitPaymentLegInput[];
    taxMode: TaxMode;
    discountSatang: number;
    paperWidthPx?: 384 | 576;
    skipKdsEnqueue?: boolean | undefined;
    heldBillId?: string | undefined;
    expectedHeldBillVersion?: number | undefined;
    lines: Array<{
      variantId: string;
      itemName: string;
      unitName: string;
      quantityMilli: number;
      unitPriceSatang: number;
      overrideLineTotalSatang?: number | undefined;
      selectedModifierIds: string[];
      skipKds?: boolean | undefined;
      notes?: string | undefined;
    }>;
  }): Promise<{
    order: {
      salesOrderId: string;
      receiptNumber: string;
      abbTaxInvoiceNo: string;
      tableOrQueueNo: string | null;
      subtotalSatang: number;
      discountSatang: number;
      cashRoundingDiscountSatang?: number | undefined;
      netBeforeTaxSatang: number;
      taxSatang: number;
      totalSatang: number;
      paymentSummaryLabel: string;
      payments: Array<{
        paymentMethod: CheckoutOrderRequest['paymentMethod'];
        amountSatang: number;
        cashTenderedSatang: number | null;
        changeGivenSatang: number | null;
        slipTransRefLast4: string | null;
      }>;
      changeGivenSatang: number | null;
      fxTender?: FxCashTenderDetailDto | null | undefined;
      kitchenOrderSequenceId: number | null;
      createdAt: string;
    };
    printJob: Omit<
      PrintedReceiptPreview,
      'receiptNumber' | 'abbTaxInvoiceNo' | 'spoolStatus' | 'pendingQueueLength'
    >;
    spoolResult: {
      status: string;
      pendingQueueLength: number;
    };
  }> {
    return requestJson('/api/pos/checkout', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listRecentOrders(outletId = 'OUTLET-HQ'): Promise<{ orders: SalesOrderHistoryDto[] }> {
    return requestJson(`/api/pos/orders?outletId=${encodeURIComponent(outletId)}`);
  },

  listHeldBills(outletId = 'OUTLET-HQ'): Promise<{ heldBills: HeldBillRecordDto[] }> {
    return requestJson(`/api/pos/held-bills?outletId=${encodeURIComponent(outletId)}`);
  },

  saveHeldBill(input: {
    outletId?: string;
    actorUserId?: string;
    claimToken?: string | undefined;
    keepClaim?: boolean | undefined;
    voidReason?: string | undefined;
    overrideToken?: string | undefined;
    bill: HeldBillRecordDto;
  }): Promise<{ ok: boolean; heldBills: HeldBillRecordDto[] }> {
    return requestJson('/api/pos/held-bills', {
      method: 'POST',
      ...(input.overrideToken
        ? { headers: { 'X-Rube-Override-Token': input.overrideToken } }
        : {}),
      body: JSON.stringify({
        outletId: input.outletId,
        actorUserId: input.actorUserId,
        ...(input.claimToken ? { claimToken: input.claimToken } : {}),
        ...(input.keepClaim ? { keepClaim: true } : {}),
        ...(input.voidReason ? { voidReason: input.voidReason } : {}),
        bill: input.bill,
      }),
    });
  },

  claimHeldBill(input: {
    outletId?: string;
    id: string;
    claimToken?: string | undefined;
    claimedByUserId?: string | undefined;
    claimedByName?: string | undefined;
    forceTakeover?: boolean | undefined;
  }): Promise<{ ok: boolean; heldBill: HeldBillRecordDto; heldBills: HeldBillRecordDto[] }> {
    return requestJson('/api/pos/held-bills/claim', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  releaseHeldBillClaim(input: {
    outletId?: string;
    id: string;
    claimToken?: string | undefined;
    force?: boolean | undefined;
  }): Promise<{ ok: boolean; heldBills: HeldBillRecordDto[] }> {
    return requestJson('/api/pos/held-bills/release', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  voidHeldBill(input: {
    outletId?: string;
    id: string;
    actorUserId?: string;
    voidReason: string;
    overrideToken?: string | undefined;
  }): Promise<{
    ok: boolean;
    heldBills: HeldBillRecordDto[];
    voidedBillId: string;
    cancelledKdsOrderIds: string[];
  }> {
    return requestJson('/api/pos/held-bills/void', {
      method: 'POST',
      ...(input.overrideToken
        ? { headers: { 'X-Rube-Override-Token': input.overrideToken } }
        : {}),
      body: JSON.stringify({
        outletId: input.outletId,
        id: input.id,
        actorUserId: input.actorUserId,
        voidReason: input.voidReason,
      }),
    });
  },

  voidHeldBillItem(input: {
    outletId?: string;
    id: string;
    expectedVersion?: number | undefined;
    targetCartKey: string;
    nextQuantityMilli: number;
    voidReason: string;
    voidedByUserId?: string | undefined;
    overrideToken?: string | undefined;
  }): Promise<{
    ok: boolean;
    heldBill: HeldBillRecordDto | null;
    heldBills: HeldBillRecordDto[];
    billVoidedCompletely: boolean;
  }> {
    return requestJson('/api/pos/held-bills/void-item', {
      method: 'POST',
      ...(input.overrideToken
        ? { headers: { 'X-Rube-Override-Token': input.overrideToken } }
        : {}),
      body: JSON.stringify({
        outletId: input.outletId,
        id: input.id,
        ...(input.expectedVersion !== undefined
          ? { expectedVersion: input.expectedVersion }
          : {}),
        targetCartKey: input.targetCartKey,
        nextQuantityMilli: input.nextQuantityMilli,
        voidReason: input.voidReason,
        ...(input.voidedByUserId ? { voidedByUserId: input.voidedByUserId } : {}),
      }),
    });
  },

  deleteHeldBill(input: {
    outletId?: string;
    actorUserId?: string;
    id: string;
    voidReason?: string | undefined;
    overrideToken?: string | undefined;
  }): Promise<{ ok: boolean; heldBills: HeldBillRecordDto[] }> {
    return requestJson('/api/pos/held-bills', {
      method: 'DELETE',
      ...(input.overrideToken
        ? { headers: { 'X-Rube-Override-Token': input.overrideToken } }
        : {}),
      body: JSON.stringify({
        outletId: input.outletId,
        actorUserId: input.actorUserId,
        id: input.id,
        ...(input.voidReason ? { voidReason: input.voidReason } : {}),
      }),
    });
  },

  reprintOrder(
    salesOrderId: string,
    outletId = 'OUTLET-HQ'
  ): Promise<{
    printJob: {
      formattedTextLines: string[];
      packetsCount: number;
      maxPacketByteLength: number;
    };
    spoolResult: { status: string; pendingQueueLength: number };
  }> {
    return requestJson('/api/pos/reprint', {
      method: 'POST',
      body: JSON.stringify({ salesOrderId, outletId }),
    });
  },

  voidOrder(input: {
    salesOrderId: string;
    voidedByUserId: string;
    voidReason: string;
    overrideToken?: string | undefined;
  }): Promise<{
    salesOrderId: string;
    receiptNumber: string;
    refundedTotalSatang: number;
    reversedLedgerEntries: Array<{
      variantId: string;
      restoredQtyMilli: number;
      historicalUnitCostMicroBaht: number;
    }>;
  }> {
    return requestJson('/api/pos/void', {
      method: 'POST',
      ...(input.overrideToken
        ? { headers: { 'X-Rube-Override-Token': input.overrideToken } }
        : {}),
      body: JSON.stringify({
        salesOrderId: input.salesOrderId,
        voidedByUserId: input.voidedByUserId,
        voidReason: input.voidReason,
      }),
    });
  },

  getKdsTickets(
    outletId = 'OUTLET-HQ',
    includeServed = false
  ): Promise<{ tickets: KdsTicketDto[] }> {
    return requestJson(
      `/api/kds/tickets?outletId=${encodeURIComponent(outletId)}&includeServed=${includeServed}`
    );
  },

  bumpKdsTicket(input: {
    kitchenOrderId: string;
    ackedSequenceId: number;
    newStatus: 'PREPARING' | 'READY' | 'SERVED';
  }): Promise<{ kitchenOrderId: string; newStatus: string; lastAckedKdsSeq: number }> {
    return requestJson('/api/kds/bump', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  upsertCatalogVariant(input: {
    outletId?: string;
    variantId?: string;
    itemId?: string;
    itemName: string;
    variantName?: string;
    categoryId?: string | null;
    sku: string;
    barcode?: string | null;
    unitName: string;
    priceSatang: number;
    defaultPurchaseCostMicroBaht: number;
    initialStockMilli?: number;
    lowStockThresholdMilli?: number;
    optimalStockMilli?: number;
    isComposite?: boolean;
    useProduction?: boolean;
    isWeightedScale?: boolean;
    active?: boolean;
    performedByUserId?: string;
  }): Promise<{ variant: CatalogVariantDetailDto }> {
    return requestJson('/api/catalog/variant', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteCatalogVariant(input: {
    variantId: string;
    performedByUserId?: string;
  }): Promise<{ ok: boolean; variantId: string; mode: 'HARD_DELETED' | 'ARCHIVED_SAFE' }> {
    return requestJson('/api/catalog/variant', {
      method: 'DELETE',
      body: JSON.stringify(input),
    });
  },

  uploadCatalogVariantImage(input: {
    variantId: string;
    dataUrl: string | null;
    actorUserId?: string;
  }): Promise<{ ok: boolean; variantId: string; imageUrl: string | null }> {
    return requestJson('/api/catalog/variant-image', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  upsertCategory(input: {
    id?: string;
    name: string;
    displayColor: string;
    kitchenStation: string;
    sortOrder?: number;
  }): Promise<{ category: CategoryDto; categories?: CategoryDto[] }> {
    return requestJson('/api/catalog/category', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteCategory(id: string): Promise<{ ok: boolean; deletedCategoryId: string; categories: CategoryDto[] }> {
    return requestJson('/api/catalog/category', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
  },

  upsertSupplier(input: {
    id?: string;
    code: string;
    name: string;
    taxId?: string | null;
    phone?: string | null;
  }): Promise<{ supplier: SupplierDto }> {
    return requestJson('/api/catalog/supplier', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  upsertModifierGroup(input: {
    id?: string;
    name: string;
    selectionType: 'SINGLE' | 'MULTIPLE';
    minSelections?: number;
    maxSelections?: number;
  }): Promise<{
    group: ModifierGroupWithItemsDto;
    modifierGroups: ModifierGroupWithItemsDto[];
  }> {
    return requestJson('/api/catalog/modifier-group', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteModifierGroup(
    id: string
  ): Promise<{ ok: boolean; modifierGroups: ModifierGroupWithItemsDto[] }> {
    return requestJson('/api/catalog/modifier-group', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
  },

  upsertModifierItem(input: {
    id?: string;
    modifierGroupId: string;
    name: string;
    priceDeltaSatang: number;
    modifierMode: 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS';
    componentVariantId?: string | null;
    quantityDeltaMilli?: number;
    targetComponentRole?: ComponentRole | null;
    scaleBasisPoints?: number;
    sortOrder?: number;
  }): Promise<{
    modifier: ModifierDto;
    modifierGroups: ModifierGroupWithItemsDto[];
  }> {
    return requestJson('/api/catalog/modifier', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteModifierItem(
    id: string
  ): Promise<{ ok: boolean; modifierGroups: ModifierGroupWithItemsDto[] }> {
    return requestJson('/api/catalog/modifier', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
  },

  previewPurchaseOrder(input: {
    outletId?: string;
    supplierId: string;
    items: Array<{
      variantId: string;
      orderedQtyMilli: number;
      receivedQtyMilli: number;
      baseUnitCostMicroBaht: number;
    }>;
    landedCosts: Array<{
      costType: 'FREIGHT' | 'CUSTOMS_DUTY' | 'INSURANCE' | 'HANDLING' | 'OTHER';
      description: string;
      amountSatang: number;
    }>;
  }): Promise<{
    lines: Array<{
      variantId: string;
      itemName: string;
      receivedQtyMilli: number;
      baseUnitCostMicroBaht: number;
      allocatedLandedCostMicroBaht: string;
      effectiveUnitCostMicroBaht: number;
      stockBeforeMilli: number;
      stockAfterMilli: number;
      macBeforeMicroBaht: number;
      macAfterMicroBaht: number;
      triggeredNegativeStockGuard: boolean;
    }>;
  }> {
    return requestJson('/api/warehouse/po-preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  receivePurchaseOrder(input: {
    outletId?: string;
    supplierId: string;
    createdByUserId: string;
    items: Array<{
      variantId: string;
      orderedQtyMilli: number;
      receivedQtyMilli: number;
      baseUnitCostMicroBaht: number;
    }>;
    landedCosts: Array<{
      costType: 'FREIGHT' | 'CUSTOMS_DUTY' | 'INSURANCE' | 'HANDLING' | 'OTHER';
      description: string;
      amountSatang: number;
    }>;
  }): Promise<{
    purchaseOrderId: string;
    poNumber: string;
    totalLandedCostSatang: number;
    lines: Array<{
      variantId: string;
      itemName: string;
      effectiveUnitCostMicroBaht: number;
      macAfterMicroBaht: number;
      stockAfterMilli: number;
    }>;
  }> {
    return requestJson('/api/warehouse/receive-po', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listPoHistory(outletId = 'OUTLET-HQ'): Promise<{
    purchaseOrders: Array<{
      id: string;
      poNumber: string;
      supplierName: string;
      status: string;
      subtotalSatang: number;
      totalLandedCostSatang: number;
      grandTotalSatang: number;
      lineCount: number;
      receivedAt: string | null;
      createdAt: string;
    }>;
  }> {
    return requestJson(`/api/warehouse/po-history?outletId=${encodeURIComponent(outletId)}`);
  },

  executePrepBuild(input: {
    outletId?: string;
    compositeVariantId: string;
    buildQtyMilli: number;
    performedByUserId: string;
  }): Promise<{
    compositeVariantId: string;
    builtQtyMilli: number;
    batchUnitCostMicroBaht: number;
    newCompositeStockMilli: number;
    newCompositeMacMicroBaht: number;
    consumedComponents: Array<{
      componentVariantId: string;
      consumedQtyMilli: number;
      componentCostMicroBaht: number;
    }>;
  }> {
    return requestJson('/api/warehouse/build-prep', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  upsertBomEdge(edge: BomEdgeDto): Promise<{ ok: boolean; bomEdges: BomEdgeDto[] }> {
    return requestJson('/api/warehouse/bom-edge', {
      method: 'POST',
      body: JSON.stringify(edge),
    });
  },

  deleteBomEdge(
    compositeVariantId: string,
    componentVariantId: string
  ): Promise<{ ok: boolean; bomEdges: BomEdgeDto[] }> {
    return requestJson('/api/warehouse/bom-edge', {
      method: 'DELETE',
      body: JSON.stringify({ compositeVariantId, componentVariantId }),
    });
  },

  previewBomRecipe(input: {
    outletId?: string;
    compositeVariantId: string;
    qtyMilli: number;
    selectedModifierIds: string[];
  }): Promise<{
    compositeVariantId: string;
    itemName: string;
    priceSatang: number;
    totalCogsMicroBaht: number;
    totalRecipeCogsMicroBaht: number;
    grossMarginSatang: number;
    deductions: Array<{
      variantId: string;
      transactionType: string;
      quantityChangeMilli: number;
      unitCostMicroBaht: number;
      lineCogsMicroBaht: number;
    }>;
  }> {
    return requestJson('/api/warehouse/bom-preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  adjustStock(input: {
    outletId?: string;
    variantId: string;
    quantityDeltaMilli: number;
    reason: string;
    performedByUserId: string;
  }): Promise<{ stockBeforeMilli: number; stockAfterMilli: number }> {
    return requestJson('/api/warehouse/adjust-stock', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  executeStocktake(input: {
    outletId?: string;
    createdByUserId: string;
    items: Array<{ variantId: string; countedStockMilli: number }>;
  }): Promise<{
    inventoryCountId: string;
    countNumber: string;
    totalVarianceSatang: number;
    lines: Array<{
      variantId: string;
      expectedStockMilli: number;
      countedStockMilli: number;
      varianceMilli: number;
      varianceCostSatang: number;
    }>;
  }> {
    return requestJson('/api/warehouse/stocktake', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  registerOutlet(input: {
    code: string;
    name: string;
    isWarehouse?: boolean;
  }): Promise<{ outlets: BootstrapPayload['outlets'] }> {
    return requestJson('/api/warehouse/outlet', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listTransfers(): Promise<{
    transfers: Array<{
      id: string;
      transferNumber: string;
      sourceOutletId: string;
      sourceOutletName: string;
      destinationOutletId: string;
      destinationOutletName: string;
      status: 'PENDING' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED';
      dispatchedAt: string | null;
      receivedAt: string | null;
      createdAt: string;
      items: Array<{
        variantId: string;
        itemName: string;
        unitName: string;
        quantityMilli: number;
        transferUnitCostMicroBaht: number;
      }>;
    }>;
    outlets: BootstrapPayload['outlets'];
  }> {
    return requestJson('/api/warehouse/transfers');
  },

  dispatchTransfer(input: {
    sourceOutletId: string;
    destinationOutletId: string;
    dispatchedByUserId: string;
    items: Array<{ variantId: string; quantityMilli: number }>;
  }): Promise<{ transferOrderId: string; transferNumber: string; status: string }> {
    return requestJson('/api/warehouse/transfer-dispatch', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  receiveTransfer(input: {
    transferOrderId: string;
    receivedByUserId: string;
  }): Promise<{ transferOrderId: string; status: string }> {
    return requestJson('/api/warehouse/transfer-receive', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listInventoryLedger(
    outletId = 'OUTLET-HQ',
    variantId?: string
  ): Promise<{
    ledger: Array<{
      id: string;
      variantId: string;
      itemName: string;
      sku: string;
      unitName: string;
      transactionType: string;
      quantityChangeMilli: number;
      stockBeforeMilli: number;
      stockAfterMilli: number;
      unitCostMicroBaht: number;
      referenceType: string;
      referenceId: string;
      performedByName: string;
      createdAt: string;
    }>;
    invariant: BootstrapPayload['ledgerInvariant'];
  }> {
    const q = variantId
      ? `/api/warehouse/ledger?outletId=${encodeURIComponent(outletId)}&variantId=${encodeURIComponent(variantId)}`
      : `/api/warehouse/ledger?outletId=${encodeURIComponent(outletId)}`;
    return requestJson(q);
  },

  openShift(input: {
    outletId?: string;
    openedByUserId: string;
    openingCashSatang: number;
    notes?: string;
  }): Promise<{ shift: BootstrapPayload['activeShift'] }> {
    return requestJson('/api/shift/open', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  recordCashMovement(input: {
    outletId?: string;
    shiftId?: string;
    movementType: 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
    amountSatang: number;
    reason: string;
    performedByUserId: string;
  }): Promise<{
    activeShift: BootstrapPayload['activeShift'];
    drawerMovements: BootstrapPayload['drawerMovements'];
  }> {
    return requestJson('/api/shift/cash-movement', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  closeShiftAndBackup(input: {
    outletId?: string;
    countedCashSatang: number;
    closedByUserId: string;
    reopenNextShift?: boolean;
    notes?: string;
  }): Promise<{
    closedShift: NonNullable<BootstrapPayload['activeShift']>;
    zReport: NonNullable<ReportsBundleDto['zReport']>;
    usbBackup: {
      writtenBackupPath: string;
      evictedOldestBackupPath: string | null;
      retainedBackupsCount: number;
      cleanedOrphanedPartFilesCount: number;
    };
    backupWarningThai?: string | undefined;
    usbBackupConfig?: UsbBackupConfigStatusDto | undefined;
    usbBackups: UsbBackupFileDto[];
  }> {
    return requestJson('/api/shift/close-and-reopen', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listUsbBackupDrives(): Promise<{
    drives: DiscoveredStorageDriveDto[];
    usbBackupConfig: UsbBackupConfigStatusDto;
  }> {
    return requestJson('/api/usb-backup/drives');
  },

  saveUsbBackupConfig(input: {
    customBackupDir: string;
    mirrorToLocalFallback: boolean;
  }): Promise<{
    ok: boolean;
    usbBackupConfig: UsbBackupConfigStatusDto;
    usbBackups: UsbBackupFileDto[];
  }> {
    return requestJson('/api/usb-backup/config', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  runUsbBackupNow(): Promise<{
    ok: boolean;
    usbBackup: {
      writtenBackupPath: string;
      evictedOldestBackupPath: string | null;
      retainedBackupsCount: number;
      cleanedOrphanedPartFilesCount: number;
    };
    backupWarningThai?: string | undefined;
    usbBackupConfig: UsbBackupConfigStatusDto;
    usbBackups: UsbBackupFileDto[];
  }> {
    return requestJson('/api/usb-backup/run-now', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  simulateYankUsb(): Promise<{
    ok: boolean;
    corruptFilename: string;
    usbBackups: UsbBackupFileDto[];
    message: string;
  }> {
    return requestJson('/api/shift/simulate-yank-usb', { method: 'POST' });
  },

  getReports(
    outletId = 'OUTLET-HQ',
    shiftId?: string,
    dateRange?: { startDate?: string | undefined; endDate?: string | undefined }
  ): Promise<ReportsBundleDto> {
    const params = new URLSearchParams({ outletId });
    if (shiftId) params.set('shiftId', shiftId);
    if (dateRange?.startDate) params.set('startDate', dateRange.startDate);
    if (dateRange?.endDate) params.set('endDate', dateRange.endDate);
    return requestJson<ReportsBundleDto>(`/api/reports?${params.toString()}`);
  },

  switchBusinessProfile(
    profile: BusinessProfile,
    updatedByUserId: string
  ): Promise<{ activeProfile: BusinessProfile; hmacSignatureHex: string }> {
    return requestJson('/api/profile/switch', {
      method: 'POST',
      body: JSON.stringify({ profile, updatedByUserId }),
    });
  },

  updateStoreSettings(input: {
    outletId?: string;
    storeName: string;
    storeAddress?: string;
    taxId: string;
    branchCode: string;
    rdPosRegNo: string;
    promptPayId: string;
    countryCode?: CountryCode;
    uiLocale?: LocaleCode;
    receiptLocale?: LocaleCode;
    vatRateBps?: number;
    defaultTaxMode?: TaxMode;
    cashRoundingStepMajor?: CashRoundingStepMajor;
    scalePriceEmbeddedMultiplier?: number;
    laoQrStaticTemplate?: string;
    laoQrVerificationPolicy?: LaoQrVerificationPolicy;
    fxRates?: Partial<FxRatesConfigDto>;
    updatedByUserId: string;
  }): Promise<{ storeSettings: StoreIdentitySettingsDto; fiscalConfig?: FiscalConfigDto }> {
    return requestJson('/api/settings/store', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateFiscalConfig(
    input: Partial<FiscalConfigDto> & { updatedByUserId?: string }
  ): Promise<{ fiscalConfig: FiscalConfigDto }> {
    return requestJson('/api/settings/fiscal', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateUiLocale(input: {
    uiLocale: LocaleCode;
    receiptLocale?: LocaleCode;
  }): Promise<{ fiscalConfig: FiscalConfigDto }> {
    return requestJson('/api/settings/locale', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listSecurityAuditLogs(limit = 60): Promise<{
    auditLogs: Array<{
      id: number;
      eventType: string;
      actorUserId: string | null;
      terminalId: string | null;
      targetKey: string | null;
      oldValueRedacted: string | null;
      newValueRedacted: string | null;
      createdAt: string;
    }>;
  }> {
    return requestJson(`/api/security/audit-logs?limit=${limit}`);
  },

  openClusterPairingPin(): Promise<{
    pairingPin: string;
    operatingMode: string;
    mdnsAdvertisement: {
      serviceType: string;
      ipAddress: string;
      port: number;
      txtRecords: string[];
    };
  }> {
    return requestJson('/api/cluster/open-pin', { method: 'POST' });
  },

  setPrinterReadyState(ready: boolean): Promise<{ ready: boolean; autoFlushedCount: number }> {
    return requestJson('/api/hal/printer-state', {
      method: 'POST',
      body: JSON.stringify({ ready }),
    });
  },

  setUpsPowerState(input: {
    acPresent: boolean;
    batteryChargePercent: number;
  }): Promise<{ protectionState: string; upsBanner: UpsAlertBannerDto }> {
    return requestJson('/api/hal/ups-state', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  // Local QR Table Ordering & Captive Portal APIs (POS Loopback Port 4173)
  getQrOrderingConfig(outletId = 'OUTLET-HQ'): Promise<{
    config: QrOrderingConfigDto;
    status: QrOrderingRuntimeStatusDto;
    tableSessions: TableQrSessionDto[];
  }> {
    return requestJson(`/api/qr-ordering/config?outletId=${encodeURIComponent(outletId)}`);
  },

  getQrNfcTagPackages(outletId = 'OUTLET-HQ'): Promise<{
    config: QrOrderingConfigDto;
    status: QrOrderingRuntimeStatusDto;
    wifiOnlyWscBase64: string | null;
    tags: NfcTableTagPackageDto[];
  }> {
    return requestJson(`/api/qr-ordering/nfc-tags?outletId=${encodeURIComponent(outletId)}`);
  },

  saveQrOrderingConfig(
    input: Partial<QrOrderingConfigDto> & { outletId?: string }
  ): Promise<{
    ok: boolean;
    config: QrOrderingConfigDto;
    status: QrOrderingRuntimeStatusDto;
    tableSessions: TableQrSessionDto[];
  }> {
    return requestJson('/api/qr-ordering/config', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  openTableQrSession(input: {
    outletId?: string;
    tableLabel: string;
    openedByName?: string;
  }): Promise<{
    ok: boolean;
    session: TableQrSessionDto;
    tableSessions: TableQrSessionDto[];
  }> {
    return requestJson('/api/qr-ordering/table-session', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  revokeTableQrSession(input: {
    outletId?: string;
    tableLabel: string;
  }): Promise<{
    ok: boolean;
    revoked: boolean;
    tableSessions: TableQrSessionDto[];
  }> {
    return requestJson('/api/qr-ordering/table-session', {
      method: 'DELETE',
      body: JSON.stringify(input),
    });
  },

  listQrGuestOrders(outletId = 'OUTLET-HQ'): Promise<{
    orders: GuestOrderRecordDto[];
    pendingCount: number;
    tableSessions: TableQrSessionDto[];
    status: QrOrderingRuntimeStatusDto;
    serviceCalls?: GuestServiceCallDto[];
    pendingServiceCallsCount?: number;
  }> {
    return requestJson(`/api/qr-ordering/orders?outletId=${encodeURIComponent(outletId)}`);
  },

  acceptQrGuestOrder(input: {
    outletId?: string;
    guestOrderId: string;
  }): Promise<{
    ok: boolean;
    order: GuestOrderRecordDto;
    heldBillId: string;
    kdsSequenceIds: number[];
    orders: GuestOrderRecordDto[];
    heldBills: HeldBillRecordDto[];
    kdsTickets: KdsTicketDto[];
  }> {
    return requestJson('/api/qr-ordering/orders/accept', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  rejectQrGuestOrder(input: {
    outletId?: string;
    guestOrderId: string;
    reason: string;
  }): Promise<{
    ok: boolean;
    order: GuestOrderRecordDto;
    orders: GuestOrderRecordDto[];
  }> {
    return requestJson('/api/qr-ordering/orders/reject', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  acknowledgeQrServiceCall(input: {
    outletId?: string;
    callId: string;
  }): Promise<{
    ok: boolean;
    call: GuestServiceCallDto;
    serviceCalls: GuestServiceCallDto[];
  }> {
    return requestJson('/api/qr-ordering/service-calls/ack', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getBarcodeLabelConfig(): Promise<{ barcodeLabelConfig: BarcodeLabelPrinterConfigDto }> {
    return requestJson('/api/warehouse/barcode-label-config');
  },

  saveBarcodeLabelConfig(
    config: Partial<BarcodeLabelPrinterConfigDto>
  ): Promise<{ barcodeLabelConfig: BarcodeLabelPrinterConfigDto }> {
    return requestJson('/api/warehouse/barcode-label-config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  printBarcodeLabels(input: {
    targetMode?: BarcodeLabelTargetMode | undefined;
    tcpHost?: string | undefined;
    tcpPort?: number | undefined;
    windowsPrinterName?: string | undefined;
    gapMm?: number | undefined;
    dryRun?: boolean | undefined;
    frames: Array<{
      variantId?: string | undefined;
      sku?: string | undefined;
      barcodeValue?: string | undefined;
      packedBitmapBase64: string;
      widthPx: number;
      heightPx: number;
      labelWidthMm: number;
      labelHeightMm: number;
      copies: number;
    }>;
  }): Promise<{
    ok: boolean;
    protocol: 'TSPL' | 'ZPL' | 'ESC_POS';
    targetMode: BarcodeLabelTargetMode;
    transportMode: string;
    totalItemsCount: number;
    totalLabelsCount: number;
    packetsCount: number;
    maxPacketByteLength: number;
    wireByteLength: number;
    bytesWritten: number;
    dispatchedToHardware: boolean;
  }> {
    return requestJson('/api/warehouse/print-barcode-labels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};
