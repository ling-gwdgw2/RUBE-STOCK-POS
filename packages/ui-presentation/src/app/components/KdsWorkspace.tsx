import React, { useEffect, useState } from 'react';
import { CheckCircle2, ChefHat, Clock, Flame, RefreshCw, Sparkles } from 'lucide-react';
import { formatMilliUnitsToQtyString } from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type { KdsTicketDto } from '../types.ts';
import { UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface KdsWorkspaceProps {
  initialTickets: KdsTicketDto[];
  onRefreshBootstrap: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const KdsWorkspace: React.FC<KdsWorkspaceProps> = ({
  initialTickets,
  onRefreshBootstrap,
  onToast,
}) => {
  const [tickets, setTickets] = useState<KdsTicketDto[]>(initialTickets);
  const [stationFilter, setStationFilter] = useState<string>('ALL');
  const [includeServed, setIncludeServed] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setTickets(initialTickets);
  }, [initialTickets]);

  const reloadTickets = async (showServed = includeServed) => {
    setLoading(true);
    try {
      const res = await posTransport.getKdsTickets('OUTLET-HQ', showServed);
      setTickets(res.tickets);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleBump = async (
    ticket: KdsTicketDto,
    newStatus: 'PREPARING' | 'READY' | 'SERVED'
  ) => {
    try {
      await posTransport.bumpKdsTicket({
        kitchenOrderId: ticket.kitchenOrderId,
        ackedSequenceId: ticket.sequenceId,
        newStatus,
      });
      await reloadTickets(includeServed);
      await onRefreshBootstrap();
      onToast(
        `อัปเดตออเดอร์ ${ticket.queueNumber} (#SEQ ${ticket.sequenceId}) → ${newStatus}`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const filteredTickets = tickets.filter((t) =>
    stationFilter === 'ALL' ? true : t.station === stationFilter
  );

  const queuedCount = tickets.filter((t) => t.status === 'QUEUED').length;
  const preparingCount = tickets.filter((t) => t.status === 'PREPARING').length;
  const readyCount = tickets.filter((t) => t.status === 'READY').length;

  const formatElapsed = (iso: string) => {
    const elapsedSec = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
    const mins = Math.floor(elapsedSec / 60);
    const secs = String(elapsedSec % 60).padStart(2, '0');
    return { text: `${mins}:${secs}`, mins };
  };

  return (
    <div className="space-y-6">
      {/* Near-Black Hero Strip + Canonical Status Summary (`google.design.md`) */}
      <section className="overflow-hidden rounded-[4px] border border-hairline bg-canvas">
        <div className="bg-hero px-6 py-7 text-white flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.5px] text-white/75">
              <ChefHat className="h-4 w-4 text-primary" />
              <span>Kitchen Display System · Monotonic sequence_id Sync</span>
            </div>
            <h1 className="font-google-display text-[28px] sm:text-[36px] font-normal leading-[36px] sm:leading-[44px] tracking-[-0.25px] text-white">
              หน้าจอรับออเดอร์ครัวและบาร์น้ำ
            </h1>
            <p className="text-sm text-white/75">
              ซิงค์คิวออเดอร์อัตโนมัติป้องกันตกหล่นเมื่อสัญญาณ Wi-Fi ขาดหายชั่วคราว
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <div className="text-xs text-white/70">รอเข้าคิว (Queued)</div>
              <div className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-white tabular-nums-google">
                {queuedCount}
              </div>
            </div>
            <div className="h-10 w-[1px] bg-white/20" />
            <div>
              <div className="text-xs text-white/70">กำลังทำ (Preparing)</div>
              <div className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-primary tabular-nums-google">
                {preparingCount}
              </div>
            </div>
            <div className="h-10 w-[1px] bg-white/20" />
            <div>
              <div className="text-xs text-white/70">พร้อมเสิร์ฟ (Ready)</div>
              <div className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-white tabular-nums-google">
                {readyCount}
              </div>
            </div>
          </div>
        </div>

        {/* Canonical Google Underline Station Tabs + Controls */}
        <div className="border-t border-hairline bg-canvas px-4 sm:px-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="สถานีครัว">
            {['ALL', 'BAR', 'MAIN', 'PREP'].map((st) => {
              const active = stationFilter === st;
              return (
                <button
                  key={st}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStationFilter(st)}
                  className={`relative flex h-12 items-center px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                    active ? 'text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  <span>{st === 'ALL' ? 'ทุกสถานี (All)' : `สถานี ${st}`}</span>
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 py-2.5">
            <label className="flex h-10 items-center gap-2 rounded-[48px] border border-hairline bg-canvas px-4 text-xs font-medium text-ink-soft hover:border-primary transition-colors duration-200 cursor-pointer focus-within:ring-2 focus-within:ring-primary/25">
              <input
                type="checkbox"
                checked={includeServed}
                onChange={(e) => {
                  setIncludeServed(e.target.checked);
                  void reloadTickets(e.target.checked);
                }}
                className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
              />
              แสดงรายการที่เสิร์ฟแล้ว
            </label>

            <button
              type="button"
              onClick={() => void reloadTickets(includeServed)}
              className={`flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium tracking-[0.25px] text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>รีเฟรชคิว</span>
            </button>
          </div>
        </div>
      </section>

      {/* Tickets Grid */}
      {filteredTickets.length === 0 ? (
        <div className="rounded-[4px] border border-hairline bg-canvas py-20 px-6 flex flex-col items-center justify-center text-center">
          <div className="h-12 w-12 rounded-full bg-primary-soft text-primary-dark flex items-center justify-center mb-3">
            <Sparkles className="h-6 w-6" />
          </div>
          <p className="font-google-display text-[20px] font-normal text-ink">
            ไม่มีออเดอร์ค้างในครัวขณะนี้
          </p>
          <p className="text-sm text-ink-muted mt-1">
            เมื่อแคชเชียร์กดคิดเงินเมนูคาเฟ่หรืออาหาร รายการจะแสดงบนจอนี้พร้อมเลขคิวทันที
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filteredTickets.map((ticket) => {
            const elapsed = formatElapsed(ticket.createdAt);
            const isActivePreparing = ticket.status === 'PREPARING';
            const isReady = ticket.status === 'READY';

            return (
              <div
                key={ticket.kitchenOrderId}
                className={`rounded-[4px] border bg-canvas flex flex-col justify-between overflow-hidden transition-colors duration-200 ${
                  isActivePreparing
                    ? 'border-primary'
                    : isReady
                      ? 'border-ink'
                      : 'border-hairline'
                } ${ticket.status === 'SERVED' ? 'opacity-65' : ''}`}
              >
                <div>
                  {/* Ticket Edge-to-Edge Header Band */}
                  <div
                    className={`px-5 py-4 border-b flex items-center justify-between ${
                      isActivePreparing
                        ? 'bg-hero text-white border-hero'
                        : isReady
                          ? 'bg-primary-soft text-ink border-hairline'
                          : 'bg-surface-1 text-ink border-hairline'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-google-display text-[26px] font-normal leading-[32px] tracking-[-0.25px] tabular-nums-google">
                          {ticket.queueNumber}
                        </span>
                        <span
                          className={`rounded-[48px] px-2.5 py-0.5 text-[11px] font-medium tabular-nums-google ${
                            isActivePreparing
                              ? 'bg-primary text-white'
                              : 'border border-hairline bg-canvas text-ink-soft'
                          }`}
                        >
                          SEQ #{ticket.sequenceId}
                        </span>
                      </div>
                      <div
                        className={`text-xs mt-1 ${
                          isActivePreparing ? 'text-white/75' : 'text-ink-muted'
                        }`}
                      >
                        สถานี: <span className="font-medium">{ticket.station}</span>
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`inline-flex items-center gap-1 rounded-[48px] px-3 py-1 text-xs font-medium tabular-nums-google ${
                          isActivePreparing
                            ? 'bg-white/15 text-white'
                            : elapsed.mins >= 5 && ticket.status !== 'SERVED'
                              ? 'bg-ink text-white'
                              : 'border border-hairline bg-canvas text-ink'
                        }`}
                      >
                        <Clock className="h-3 w-3" />
                        {elapsed.text}
                      </span>
                      <div
                        className={`text-[11px] font-medium uppercase tracking-[0.5px] mt-1.5 ${
                          isActivePreparing
                            ? 'text-primary-soft'
                            : isReady
                              ? 'text-primary-dark'
                              : 'text-primary-hover'
                        }`}
                      >
                        {ticket.status}
                      </div>
                    </div>
                  </div>

                  {/* Ticket Line Items */}
                  <div className="p-5 divide-y divide-hairline">
                    {ticket.items.map((item) => (
                      <div key={item.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-2.5">
                          <span className="font-google-display text-[15px] font-medium text-ink">
                            {item.itemSummaryText}
                          </span>
                          <span className="rounded-[48px] bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary-dark tabular-nums-google shrink-0">
                            ×{formatMilliUnitsToQtyString(item.quantityMilli).replace(/\.000$/, '')}
                          </span>
                        </div>
                        {item.modifiersSummaryText && (
                          <div className="mt-1.5 rounded-[4px] border border-hairline bg-surface-1 px-2.5 py-1 text-xs text-ink-soft">
                            {item.modifiersSummaryText}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Canonical 48px-Pill Touch Bump Footer */}
                <div className="p-4 bg-surface-1 border-t border-hairline">
                  {ticket.status === 'QUEUED' && (
                    <button
                      type="button"
                      onClick={() => void handleBump(ticket, 'PREPARING')}
                      className={`flex h-[48px] w-full items-center justify-center gap-2 rounded-[48px] border border-primary bg-canvas px-5 font-google-display text-sm font-medium tracking-[0.5px] text-primary hover:bg-primary-soft hover:text-primary-dark ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      <Flame className="h-4 w-4" />
                      <span>เริ่มทำออเดอร์ (Prepare)</span>
                    </button>
                  )}
                  {ticket.status === 'PREPARING' && (
                    <button
                      type="button"
                      onClick={() => void handleBump(ticket, 'READY')}
                      className={`flex h-[48px] w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-5 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>ทำเสร็จพร้อมเสิร์ฟ (Ready)</span>
                    </button>
                  )}
                  {ticket.status === 'READY' && (
                    <button
                      type="button"
                      onClick={() => void handleBump(ticket, 'SERVED')}
                      className={`flex h-[48px] w-full items-center justify-center gap-2 rounded-[48px] bg-ink px-5 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-hero ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>ส่งมอบลูกค้าแล้ว (Served)</span>
                    </button>
                  )}
                  {ticket.status === 'SERVED' && (
                    <div className="text-center py-2 text-xs font-medium text-ink-muted">
                      ส่งมอบลูกค้าเรียบร้อยแล้ว
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
