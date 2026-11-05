/**
 * RUBE-STOCK-POS v3.1 Shift, Cash Drawer & Blind Drop View Controller (`SHIFT_DRAWER_VIEW` — WBS-11)
 *
 * Responsibilities:
 * - Manages Morning Shift Opening (`OPENING_FLOAT`) and mid-shift Cash Drawer Movements (`PAID_IN`, `PAID_OUT`, `CASH_DROP`)
 * - Enforces Blind Drop Shift Closing (hides `expectedCashSatang` until after the cashier submits `countedCashSatang`)
 * - Executes Manager-authorized Historical Cost Mirror Bill Void (`VOID_RETURN`)
 */

import { formatSatangToThbString } from '../../../../shared-contracts/src/fixed-point.ts';
import type { PosShiftDto } from '../../../../shared-contracts/src/ipc-commands.ts';
import type {
  CashDrawerMovementRecord,
  VoidSalesOrderResult,
} from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export interface BlindShiftStatusViewModel {
  id: string;
  shiftNumber: string;
  outletId: string;
  terminalId: string;
  openedBy: string;
  status: 'OPEN' | 'CLOSED';
  openingCashSatang: number;
  openingCashFormatted: string;
  expectedCashHiddenForBlindDrop: true;
  openedAt: string;
}

export interface ClosedShiftReconciliationViewModel extends PosShiftDto {
  openingCashFormatted: string;
  expectedCashFormatted: string;
  countedCashFormatted: string;
  cashVarianceFormatted: string;
  varianceStatus: 'EXACT' | 'SHORT' | 'OVER';
}

export class ShiftDrawerViewController {
  private readonly bridge: LocalIpcBridge;
  private readonly defaultOutletId: string;
  private readonly defaultTerminalId: string;

  constructor(
    bridge: LocalIpcBridge,
    defaultOutletId = 'OUTLET-HQ',
    defaultTerminalId = 'POS-TERM-01'
  ) {
    this.bridge = bridge;
    this.defaultOutletId = defaultOutletId;
    this.defaultTerminalId = defaultTerminalId;
  }

  public async openShift(input: {
    shiftNumber: string;
    openingCashSatang: number;
    openedByUserId?: string;
    notes?: string;
  }): Promise<PosShiftDto> {
    return this.bridge.openPosShift({
      outletId: this.defaultOutletId,
      terminalId: this.defaultTerminalId,
      openedByUserId: input.openedByUserId ?? 'USR-CASHIER-01',
      shiftNumber: input.shiftNumber,
      openingCashSatang: input.openingCashSatang,
      notes: input.notes,
    });
  }

  /**
   * Returns the active shift status with `expectedCashSatang` masked (`expectedCashHiddenForBlindDrop: true`)
   * so the cashier cannot manipulate their physical count to match the system number before closing.
   */
  public getActiveShiftBlindViewModel(): BlindShiftStatusViewModel | null {
    const active = this.bridge.getActiveShift(this.defaultOutletId, this.defaultTerminalId);
    if (!active) return null;

    return {
      id: active.id,
      shiftNumber: active.shiftNumber,
      outletId: active.outletId,
      terminalId: active.terminalId,
      openedBy: active.openedBy,
      status: active.status,
      openingCashSatang: active.openingCashSatang,
      openingCashFormatted: `฿${formatSatangToThbString(active.openingCashSatang)}`,
      expectedCashHiddenForBlindDrop: true,
      openedAt: active.openedAt,
    };
  }

  public async recordDrawerMovement(input: {
    shiftId: string;
    movementType: 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP';
    amountSatang: number;
    reason: string;
    performedByUserId?: string;
  }): Promise<CashDrawerMovementRecord> {
    return this.bridge.recordCashDrawerMovement({
      shiftId: input.shiftId,
      movementType: input.movementType,
      amountSatang: input.amountSatang,
      reason: input.reason,
      performedByUserId: input.performedByUserId ?? 'USR-CASHIER-01',
    });
  }

  /**
   * Submits the cashier's Blind Drop physical cash count and reveals the full variance reconciliation report.
   */
  public async closeShiftWithBlindDrop(input: {
    shiftId: string;
    countedCashSatang: number;
    closedByUserId?: string;
    notes?: string;
  }): Promise<ClosedShiftReconciliationViewModel> {
    const closed = await this.bridge.closePosShiftBlindDrop({
      shiftId: input.shiftId,
      countedCashSatang: input.countedCashSatang,
      closedByUserId: input.closedByUserId ?? 'USR-CASHIER-01',
      notes: input.notes,
    });

    const variance = closed.cashVarianceSatang ?? 0;
    const varianceStatus: 'EXACT' | 'SHORT' | 'OVER' =
      variance === 0 ? 'EXACT' : variance < 0 ? 'SHORT' : 'OVER';

    return {
      ...closed,
      openingCashFormatted: `฿${formatSatangToThbString(closed.openingCashSatang)}`,
      expectedCashFormatted: `฿${formatSatangToThbString(closed.expectedCashSatang)}`,
      countedCashFormatted: `฿${formatSatangToThbString(closed.countedCashSatang ?? 0)}`,
      cashVarianceFormatted: `${variance > 0 ? '+' : ''}฿${formatSatangToThbString(variance)}`,
      varianceStatus,
    };
  }

  /**
   * Executes a Manager-authorized Bill Void (`VOID_RETURN`), restoring exact historical batch costs and quantities.
   */
  public async voidCompletedOrder(input: {
    salesOrderId: string;
    voidedByUserId?: string;
    voidReason: string;
  }): Promise<VoidSalesOrderResult> {
    return this.bridge.voidSalesOrder({
      salesOrderId: input.salesOrderId,
      voidedByUserId: input.voidedByUserId ?? 'USR-OWNER-01',
      voidReason: input.voidReason,
    });
  }
}
