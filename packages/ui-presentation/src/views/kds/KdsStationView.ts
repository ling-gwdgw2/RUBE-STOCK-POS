/**
 * RUBE-STOCK-POS v3.1 Kitchen Display System Station View Controller (`KDS_VIEW` — WBS-16)
 *
 * Responsibilities:
 * - Tracks monotonic `lastAckedKdsSeq` so that after a Wi-Fi drop, calling `syncMissedTicketsFromLeader()`
 *   automatically pulls every missed ticket (`WHERE sequence_id > lastAckedKdsSeq`) without gaps or duplicates
 * - Computes SLA ticket aging (`NORMAL`, `WARNING`, `OVERDUE`) and formats item quantities & modifiers
 * - Bumps ticket status (`QUEUED` -> `PREPARING` -> `READY` -> `SERVED`) and persists `last_acked_kds_seq`
 */

import { formatMilliUnitsToQtyString } from '../../../../shared-contracts/src/fixed-point.ts';
import type { KitchenOrderTicketDto } from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export interface KdsTicketViewModel extends KitchenOrderTicketDto {
  slaStatus: 'NORMAL' | 'WARNING' | 'OVERDUE';
  formattedItems: Array<{
    id: string;
    itemSummaryText: string;
    modifiersSummaryText: string | null;
    quantityFormatted: string;
    status: 'PENDING' | 'DONE';
  }>;
}

export class KdsStationViewController {
  private readonly bridge: LocalIpcBridge;
  private readonly outletId: string;
  private readonly kdsTerminalId: string;
  private readonly station: string;
  private lastAckedKdsSeq = 0;
  private readonly activeTickets = new Map<number, KdsTicketViewModel>();

  constructor(
    bridge: LocalIpcBridge,
    options?: {
      outletId?: string;
      kdsTerminalId?: string;
      station?: string;
      initialLastAckedSeq?: number;
    }
  ) {
    this.bridge = bridge;
    this.outletId = options?.outletId ?? 'OUTLET-HQ';
    this.kdsTerminalId = options?.kdsTerminalId ?? 'KDS-TERM-BAR-01';
    this.station = options?.station ?? 'BAR';
    this.lastAckedKdsSeq = options?.initialLastAckedSeq ?? 0;
  }

  public getLastAckedKdsSeq(): number {
    return this.lastAckedKdsSeq;
  }

  /**
   * Queries the Leader for all orders on this station with `sequence_id > this.lastAckedKdsSeq`,
   * merges them into `this.activeTickets` in monotonic sequence order, and returns the newly recovered tickets.
   */
  public syncMissedTicketsFromLeader(nowTimestampMs = Date.now()): KdsTicketViewModel[] {
    const missed = this.bridge.getMissedKitchenOrders(
      this.outletId,
      this.station,
      this.lastAckedKdsSeq
    );

    const newlyRecovered: KdsTicketViewModel[] = [];
    for (const ticket of missed) {
      const createdMs = Date.parse(ticket.createdAt) || nowTimestampMs;
      const elapsedSec = Math.max(0, Math.floor((nowTimestampMs - createdMs) / 1_000));
      const slaStatus: 'NORMAL' | 'WARNING' | 'OVERDUE' =
        elapsedSec >= 300 ? 'OVERDUE' : elapsedSec >= 180 ? 'WARNING' : 'NORMAL';

      const vm: KdsTicketViewModel = {
        ...ticket,
        slaStatus,
        formattedItems: ticket.items.map((it) => ({
          ...it,
          quantityFormatted: formatMilliUnitsToQtyString(it.quantityMilli, 'unit'),
        })),
      };

      this.activeTickets.set(ticket.sequenceId, vm);
      newlyRecovered.push(vm);
    }

    return newlyRecovered;
  }

  public getActiveBoardTickets(): KdsTicketViewModel[] {
    return [...this.activeTickets.values()]
      .filter((t) => t.status !== 'SERVED' && t.status !== 'CANCELLED')
      .sort((a, b) => a.sequenceId - b.sequenceId);
  }

  /**
   * Advances a KDS ticket status (`PREPARING`, `READY`, `SERVED`) and updates `lastAckedKdsSeq`
   * both in memory and in SQLite `pos_terminals.last_acked_kds_seq`.
   */
  public async bumpTicketStatus(
    sequenceId: number,
    newStatus: 'PREPARING' | 'READY' | 'SERVED'
  ): Promise<{ kitchenOrderId: string; newStatus: string; lastAckedKdsSeq: number }> {
    const ticket = this.activeTickets.get(sequenceId);
    if (!ticket) {
      throw new Error(`KDS ticket sequence_id=${sequenceId} not found on station ${this.station}`);
    }

    const res = await this.bridge.acknowledgeAndAdvanceKdsOrder({
      terminalId: this.kdsTerminalId,
      kitchenOrderId: ticket.kitchenOrderId,
      newStatus,
      ackedSequenceId: sequenceId,
    });

    this.lastAckedKdsSeq = Math.max(this.lastAckedKdsSeq, res.lastAckedKdsSeq);
    ticket.status = newStatus;

    return res;
  }
}

