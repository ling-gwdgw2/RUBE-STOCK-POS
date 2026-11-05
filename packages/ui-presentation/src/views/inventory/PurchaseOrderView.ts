/**
 * RUBE-STOCK-POS v3.1 Purchase Order & Landed Cost Apportionment View Controller (`PO_VIEW` — WBS-12)
 *
 * Responsibilities:
 * - Provides real-time Landed Cost (Freight + Customs/Ice) apportionment preview before committing a PO
 * - Displays Old MAC -> Effective Landed Unit Cost -> New MAC in `Micro-Baht` (`฿0.0000`)
 * - Clearly flags Negative/Zero Stock Guard (`triggeredNegativeStockGuard`) when receiving stock into a negative-balance SKU
 */

import {
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
} from '../../../../shared-contracts/src/fixed-point.ts';
import type {
  CreatePurchaseOrderInput,
  PoReceivePreviewLine,
  PoReceiveResult,
} from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export interface PoLinePreviewViewModel extends PoReceivePreviewLine {
  qtyReceivedFormatted: string;
  baseUnitCostFormatted: string;
  effectiveUnitCostFormatted: string;
  macBeforeFormatted: string;
  macAfterFormatted: string;
}

export class PurchaseOrderViewController {
  private readonly bridge: LocalIpcBridge;

  constructor(bridge: LocalIpcBridge) {
    this.bridge = bridge;
  }

  /**
   * Computes a real-time read-only preview of Landed Cost apportionment and Moving Average Cost (MAC)
   * changes across all lines in the Purchase Order.
   */
  public previewLandedCostReceipt(input: CreatePurchaseOrderInput): PoLinePreviewViewModel[] {
    const lines = this.bridge.previewPurchaseOrderCosting(input);

    return lines.map((line) => ({
      ...line,
      qtyReceivedFormatted: formatMilliUnitsToQtyString(line.receivedQtyMilli, 'unit'),
      baseUnitCostFormatted: `฿${formatMicroBahtToThbString(line.baseUnitCostMicroBaht)}`,
      effectiveUnitCostFormatted: `฿${formatMicroBahtToThbString(line.effectiveUnitCostMicroBaht)}`,
      macBeforeFormatted: `฿${formatMicroBahtToThbString(line.macBeforeMicroBaht)}`,
      macAfterFormatted: `฿${formatMicroBahtToThbString(line.macAfterMicroBaht)}`,
    }));
  }

  /**
   * Commits the Purchase Order Receipt (`PO_RECEIVE`), updating warehouse balances, MAC, and immutable ledger rows.
   */
  public async confirmPurchaseOrderReceipt(
    input: CreatePurchaseOrderInput
  ): Promise<PoReceiveResult> {
    return this.bridge.receivePurchaseOrderWithLandedCosts(input);
  }
}
