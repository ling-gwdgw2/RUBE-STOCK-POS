/**
 * RUBE-STOCK-POS v3.1 High-Speed POS Terminal View Controller (`POS_TERMINAL` — WBS-11)
 *
 * Responsibilities:
 * - Integrates `PhysicalScannerStreamBuffer` (`< 50ms` cadence) with automatic First-Char Search Input Rollback
 * - Supports Retail Scale Barcodes (`Prefix 20-29`) and Hospitality Multi-Level BOM Modifiers (`ROLE_SCALE_BPS`, `FIXED_QTY_DELTA`)
 * - Implements Two-Phase Anti-Fraud PromptPay QR & BOT Slip Mini-QR Confirmation
 * - Triggers Atomic Idempotent Checkout (`checkoutSalesOrder`) + 203-DPI Chunked Raster ABB Receipt & Cash Drawer Kick
 */

import {
  computeVatSatang,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  roundDivBigInt,
  SCALE_MILLI,
  type Satang,
  type TaxMode,
} from '../../../../shared-contracts/src/fixed-point.ts';
import type { CheckoutOrderRequest } from '../../../../shared-contracts/src/ipc-commands.ts';
import type { CheckoutOrderResult } from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';
import {
  buildTwoPhaseSlipConfirmationModal,
  commitVerifiedBotSlipHash,
  generateOfflinePromptPayDynamicQr,
  type TwoPhaseSlipConfirmationModalModel,
} from '../../../../hal-drivers/src/payment/mod.ts';
import {
  renderThaiReceiptAbbEscPosJob,
  type RenderedThaiAbbPrintJob,
} from '../../../../hal-drivers/src/printer/mod.ts';
import { PhysicalScannerStreamBuffer } from '../../hooks/usePhysicalScanner.ts';
import { InventoryViewController } from '../inventory/InventoryView.ts';

export interface PosCartLineItem {
  variantId: string;
  itemName: string;
  unitName: string;
  quantityMilli: number;
  unitPriceSatang: number;
  selectedModifierIds: string[];
}

export interface PosCartSummaryViewModel {
  lines: Array<
    PosCartLineItem & {
      quantityFormatted: string;
      lineTotalSatang: number;
      lineTotalFormatted: string;
      modifiersSummaryText: string;
    }
  >;
  subtotalSatang: Satang;
  subtotalFormatted: string;
  discountSatang: Satang;
  discountFormatted: string;
  netBeforeTaxSatang: Satang;
  netBeforeTaxFormatted: string;
  taxSatang: Satang;
  taxFormatted: string;
  totalSatang: Satang;
  totalFormatted: string;
  taxMode: TaxMode;
}

export class PosTerminalViewController {
  private readonly bridge: LocalIpcBridge;
  private readonly invHelper: InventoryViewController;
  private readonly scannerBuffer: PhysicalScannerStreamBuffer;
  private readonly usedSlipHashes = new Set<string>();
  private readonly outletId: string;
  private readonly terminalId: string;

  public searchInputText = '';
  public firstCharRollbackCount = 0;
  private cartLines: PosCartLineItem[] = [];
  private discountSatang = 0;
  private taxMode: TaxMode = 'INCLUSIVE';
  private orderType: CheckoutOrderRequest['orderType'] = 'TAKEAWAY';
  private pendingSlipRaw: string | null = null;
  private pendingSlipModal: TwoPhaseSlipConfirmationModalModel | null = null;

  constructor(
    bridge: LocalIpcBridge,
    outletId = 'OUTLET-HQ',
    terminalId = 'POS-TERM-01'
  ) {
    this.bridge = bridge;
    this.outletId = outletId;
    this.terminalId = terminalId;
    this.invHelper = new InventoryViewController(bridge, outletId);

    this.scannerBuffer = new PhysicalScannerStreamBuffer(50, 8);
  }

  /**
   * Simulates a keystroke arriving while the POS Search Input is focused:
   * - The first character of a barcode burst may leak into `searchInputText` (e.g. Thai char `'_'` or `'ๅ'`)
   * - When the second character arrives within `< 50ms`, `onRollbackFirstChar` strips the leaked char
   * - Subsequent characters in the burst are suppressed from `searchInputText` and routed to the cart on `Enter`
   */
  public handleKeyDownWithFocusedSearchInput(
    code: string,
    keyCharProducedByOsLayout: string,
    timestampMs: number
  ): void {
    const rollbacksBefore = this.firstCharRollbackCount;
    const { completedBarcode, shouldPreventDefault } = this.scannerBuffer.pushKeystroke(
      { code, timestampMs },
      () => {
        if (this.searchInputText.length > 0) {
          this.searchInputText = this.searchInputText.slice(0, -1);
          this.firstCharRollbackCount++;
        }
      }
    );
    if (completedBarcode) {
      this.addBarcodeStringToCart(completedBarcode);
      return;
    }
    if (!shouldPreventDefault && this.firstCharRollbackCount === rollbacksBefore && code !== 'Enter') {
      this.searchInputText += keyCharProducedByOsLayout;
    }
  }

  public addBarcodeStringToCart(barcode: string): void {
    const codeArray = barcode.split('').map((ch) => `Digit${ch}`);
    const resolved = this.invHelper.resolveScannedKeyCodes(codeArray);
    if (!resolved.matchedItem) {
      throw new Error(`Scanned barcode not found in catalog: ${barcode}`);
    }

    this.cartLines.push({
      variantId: resolved.matchedItem.id,
      itemName: resolved.matchedItem.itemName,
      unitName: resolved.matchedItem.unitName,
      quantityMilli: resolved.effectiveQtyMilli,
      unitPriceSatang: resolved.matchedItem.priceSatang,
      selectedModifierIds: [],
    });
  }

  public addVariantWithModifiersToCart(input: {
    variantId: string;
    quantityMilli?: number;
    selectedModifierIds?: readonly string[];
  }): void {
    const catalog = this.bridge.getInventoryCatalog(this.outletId);
    const matched = catalog.find((v) => v.id === input.variantId);
    if (!matched) {
      throw new Error(`Variant not found in catalog: ${input.variantId}`);
    }

    this.cartLines.push({
      variantId: matched.id,
      itemName: matched.itemName,
      unitName: matched.unitName,
      quantityMilli: input.quantityMilli ?? 1_000,
      unitPriceSatang: matched.priceSatang,
      selectedModifierIds: [...(input.selectedModifierIds ?? [])],
    });
  }

  public setBillDiscount(discountSatang: Satang): void {
    this.discountSatang = Math.max(0, discountSatang);
  }

  public setTaxMode(taxMode: TaxMode): void {
    this.taxMode = taxMode;
  }

  public setOrderType(orderType: CheckoutOrderRequest['orderType']): void {
    this.orderType = orderType;
  }

  public clearCart(): void {
    this.cartLines = [];
    this.discountSatang = 0;
    this.pendingSlipRaw = null;
    this.pendingSlipModal = null;
  }

  public getCartSummaryViewModel(): PosCartSummaryViewModel {
    const modifiers = new Map(this.bridge.listModifiers().map((m) => [m.id, m]));
    let subtotalSatang = 0;

    const lines = this.cartLines.map((line) => {
      const selectedMods = line.selectedModifierIds
        .map((id) => modifiers.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined);

      const modUnitDeltaSatang = selectedMods.reduce((s, m) => s + m.priceDeltaSatang, 0);
      const effectiveUnitPriceSatang = line.unitPriceSatang + modUnitDeltaSatang;
      const lineTotalSatang = Number(
        roundDivBigInt(
          BigInt(line.quantityMilli) * BigInt(effectiveUnitPriceSatang),
          SCALE_MILLI
        )
      );
      subtotalSatang += lineTotalSatang;

      return {
        ...line,
        quantityFormatted: formatMilliUnitsToQtyString(line.quantityMilli, line.unitName),
        lineTotalSatang,
        lineTotalFormatted: `฿${formatSatangToThbString(lineTotalSatang)}`,
        modifiersSummaryText: selectedMods.map((m) => m.name).join(', '),
      };
    });

    const afterDiscount = Math.max(0, subtotalSatang - this.discountSatang);
    const taxSatang = computeVatSatang(afterDiscount, 700, this.taxMode);
    const netBeforeTaxSatang =
      this.taxMode === 'INCLUSIVE' ? afterDiscount - taxSatang : afterDiscount;
    const totalSatang =
      this.taxMode === 'EXCLUSIVE' ? afterDiscount + taxSatang : afterDiscount;

    return {
      lines,
      subtotalSatang,
      subtotalFormatted: `฿${formatSatangToThbString(subtotalSatang)}`,
      discountSatang: this.discountSatang,
      discountFormatted: `฿${formatSatangToThbString(this.discountSatang)}`,
      netBeforeTaxSatang,
      netBeforeTaxFormatted: `฿${formatSatangToThbString(netBeforeTaxSatang)}`,
      taxSatang,
      taxFormatted: `฿${formatSatangToThbString(taxSatang)}`,
      totalSatang,
      totalFormatted: `฿${formatSatangToThbString(totalSatang)}`,
      taxMode: this.taxMode,
    };
  }

  /**
   * Generates an Offline Dynamic EMVCo PromptPay QR for the current cart's exact `totalSatang`.
   */
  public generatePromptPayQrForCart(merchantPromptPayId = '0105566001234'): {
    payload: string;
    crcHex: string;
    totalSatang: Satang;
  } {
    const summary = this.getCartSummaryViewModel();
    const qr = generateOfflinePromptPayDynamicQr(merchantPromptPayId, summary.totalSatang);
    return {
      ...qr,
      totalSatang: summary.totalSatang,
    };
  }

  /**
   * Step 1 of Two-Phase Anti-Fraud Slip Confirmation:
   * Parses and validates the BOT Slip Mini-QR WITHOUT locking the hash in `usedSlipHashes` yet.
   */
  public verifyScannedSlipStep1(miniQrRaw: string): TwoPhaseSlipConfirmationModalModel {
    const summary = this.getCartSummaryViewModel();
    const modal = buildTwoPhaseSlipConfirmationModal(
      miniQrRaw,
      summary.totalSatang,
      this.usedSlipHashes
    );
    if (modal.canProceedToStep2Confirm) {
      this.pendingSlipRaw = miniQrRaw;
      this.pendingSlipModal = modal;
    }
    return modal;
  }

  /**
   * Cancels the Step-1 Slip Confirmation Modal without locking the slip hash.
   */
  public cancelSlipVerificationModal(): void {
    this.pendingSlipRaw = null;
    this.pendingSlipModal = null;
  }

  /**
   * Step 2: Commits the POS Checkout (`checkoutSalesOrder`) and renders the 203-DPI Chunked Raster
   * Thai Simplified Tax Invoice (ABB) print job (`GS v 0` + `ESC J` + `ESC p` Drawer Kick).
   */
  public async confirmCheckoutAndPrint(input: {
    idempotencyKey: string;
    shiftId: string;
    cashierId?: string;
    paymentMethod: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'VOUCHER';
    cashTenderedSatang?: Satang;
    slipTransRefRaw?: string;
  }): Promise<{
    checkoutResult: CheckoutOrderResult;
    printJob: RenderedThaiAbbPrintJob;
  }> {
    const effectiveSlipRaw = input.slipTransRefRaw ?? this.pendingSlipRaw ?? undefined;
    const summary = this.getCartSummaryViewModel();

    const request: CheckoutOrderRequest = {
      idempotencyKey: input.idempotencyKey,
      outletId: this.outletId,
      terminalId: this.terminalId,
      shiftId: input.shiftId,
      cashierId: input.cashierId ?? 'USR-CASHIER-01',
      orderType: this.orderType,
      taxMode: this.taxMode,
      discountSatang: this.discountSatang,
      paymentMethod: input.paymentMethod,
      cashTenderedSatang: input.cashTenderedSatang,
      slipTransRefRaw: effectiveSlipRaw,
      lines: this.cartLines.map((l) => ({
        variantId: l.variantId,
        quantityMilli: l.quantityMilli,
        unitPriceSatang: l.unitPriceSatang,
        selectedModifierIds: l.selectedModifierIds,
      })),
    };

    const checkoutResult = await this.bridge.checkoutSalesOrder(request);

    // Commit the BOT Slip hash into the in-memory set after the SQLite transaction succeeds
    if (checkoutResult.slipTransRefHash) {
      commitVerifiedBotSlipHash(checkoutResult.slipTransRefHash, this.usedSlipHashes);
    }

    const printJob = renderThaiReceiptAbbEscPosJob({
      storeName: 'RUBE Flagship Store & Warehouse',
      taxId: '0105566001234',
      branchCode: '00000',
      posRegNo: 'RD-POS-2026-001',
      receiptNumber: checkoutResult.receiptNumber,
      abbTaxInvoiceNo: checkoutResult.abbTaxInvoiceNo,
      lines: summary.lines.map((l) => ({
        itemName: l.itemName,
        quantityFormatted: l.quantityFormatted,
        lineTotalFormatted: l.lineTotalFormatted,
        modifiersText: l.modifiersSummaryText || undefined,
      })),
      subtotalFormatted: `฿${formatSatangToThbString(checkoutResult.subtotalSatang)}`,
      discountFormatted: `฿${formatSatangToThbString(checkoutResult.discountSatang)}`,
      netBeforeTaxFormatted: `฿${formatSatangToThbString(checkoutResult.netBeforeTaxSatang)}`,
      taxFormatted: `฿${formatSatangToThbString(checkoutResult.taxSatang)}`,
      totalFormatted: `฿${formatSatangToThbString(checkoutResult.totalSatang)}`,
      paymentMethod: checkoutResult.paymentMethod,
      cashTenderedFormatted:
        checkoutResult.cashTenderedSatang !== null
          ? `฿${formatSatangToThbString(checkoutResult.cashTenderedSatang)}`
          : undefined,
      changeGivenFormatted:
        checkoutResult.changeGivenSatang !== null
          ? `฿${formatSatangToThbString(checkoutResult.changeGivenSatang)}`
          : undefined,
      slipRefLast4: checkoutResult.slipTransRefLast4 ?? undefined,
      kickCashDrawer: checkoutResult.paymentMethod === 'CASH',
      widthPx: 576,
    });

    return {
      checkoutResult,
      printJob,
    };
  }
}
