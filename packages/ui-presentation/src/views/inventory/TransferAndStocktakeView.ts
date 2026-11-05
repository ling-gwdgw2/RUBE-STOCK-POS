/**
 * RUBE-STOCK-POS v3.1 Inter-Outlet Stock Transfer & Physical Stocktake View Controller
 * (`TRANSFER_STOCKTAKE_VIEW` — Squad C Phase 3)
 *
 * Responsibilities:
 * - Dispatches (`TRANSFER_OUT`) and receives (`TRANSFER_IN`) stock across outlets carrying exact MAC
 * - Executes Physical Inventory Counts (`RE_COUNT`) and formats variance reports in `Milli-Units` and `Satang`
 */

import {
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
} from '../../../../shared-contracts/src/fixed-point.ts';
import type {
  DispatchTransferOrderInput,
  ExecuteInventoryCountInput,
  InventoryCountResult,
  TransferOrderDispatchResult,
  TransferOrderReceiveResult,
} from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export interface InventoryCountVarianceViewModel extends InventoryCountResult {
  totalVarianceFormatted: string;
  formattedLines: Array<{
    variantId: string;
    expectedStockFormatted: string;
    countedStockFormatted: string;
    varianceFormatted: string;
    snapshotUnitCostFormatted: string;
    varianceCostFormatted: string;
  }>;
}

export class TransferAndStocktakeViewController {
  private readonly bridge: LocalIpcBridge;

  constructor(bridge: LocalIpcBridge) {
    this.bridge = bridge;
  }

  public async dispatchTransfer(
    input: DispatchTransferOrderInput
  ): Promise<TransferOrderDispatchResult> {
    return this.bridge.dispatchTransferOrder(input);
  }

  public async receiveTransfer(input: {
    transferOrderId: string;
    receivedByUserId?: string;
  }): Promise<TransferOrderReceiveResult> {
    return this.bridge.receiveTransferOrder({
      transferOrderId: input.transferOrderId,
      receivedByUserId: input.receivedByUserId ?? 'USR-WH-01',
    });
  }

  public async submitPhysicalInventoryCount(
    input: ExecuteInventoryCountInput
  ): Promise<InventoryCountVarianceViewModel> {
    const result = await this.bridge.executePhysicalInventoryCount(input);

    return {
      ...result,
      totalVarianceFormatted: `฿${formatSatangToThbString(result.totalVarianceSatang)}`,
      formattedLines: result.lines.map((l) => ({
        variantId: l.variantId,
        expectedStockFormatted: formatMilliUnitsToQtyString(l.expectedStockMilli, 'unit'),
        countedStockFormatted: formatMilliUnitsToQtyString(l.countedStockMilli, 'unit'),
        varianceFormatted: formatMilliUnitsToQtyString(l.varianceMilli, 'unit'),
        snapshotUnitCostFormatted: `฿${formatMicroBahtToThbString(l.snapshotUnitCostMicroBaht)}`,
        varianceCostFormatted: `฿${formatSatangToThbString(l.varianceCostSatang)}`,
      })),
    };
  }
}

