import React, { useEffect, useState } from 'react';
import { CheckCircle2, ChefHat, Clock, Flame, RefreshCw, Sparkles } from 'lucide-react';
import { formatMilliUnitsToQtyString } from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type { KdsTicketDto } from '../types.ts';

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
      <section className="overflow-hidden rounded-[4px] border border-[#dadce0] bg-white">
        <div className="bg-[#000000] px-6 py-7 text-white flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.5px] text-white/70">
              <ChefHat className="h-4 w-4 text-[#1a73e8]" />
              <span>Kitchen Display System · Monotonic sequence_id Sync</span>
            </div>
            <h1 className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-white">
              หน้าจอรับออเดอร์ครัวและบาร์น้ำ
            </h1>
            <p className="text-sm text-white/75">
              ซิงค์คิวออเดอร์อัตโนมัติป้องกันตกหล่นเมื่อสัญญาณ Wi-Fi ขาดหายชั่วคราว
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <div className="text-xs text-white/65">รอเข้าคิว (Queued)</div>
              <div className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-white tabular-nums-google">
                {queuedCount}
              </div>
            </div>
            <div className="h-10 w-[1px] bg-white/20" />
            <div>
              <div className="text-xs text-white/65">กำลังทำ (Preparing)</div>
              <div className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-[#1a73e8] tabular-nums-google">
                {preparingCount}
              </div>
            </div>
            <div className="h-10 w-[1px] bg-white/20" />
            <div>
              <div className="text-xs text-white/65">พร้อมเสิร์ฟ (Ready)</div>
              <div className="font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-white tabular-nums-google">
                {readyCount}
              </div>
            </div>
          </div>
        </div>

        {/* Canonical Google Underline Station Tabs + Controls */}
        <div className="border-t border-[#dadce0] bg-white px-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 overflow-x-auto" role="tablist">
            {['ALL', 'BAR', 'MAIN', 'PREP'].map((st) => {
              const active = stationFilter === st;
              return (
                <button
                  key={st}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStationFilter(st)}
                  className={`relative flex h-12 items-center px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                    active ? 'text-[#202124]' : 'text-[#5f6368] hover:text-[#202124]'
                  }`}
                >
                  <span>{st === 'ALL' ? 'ทุกสถานี (All)' : `สถานี ${st}`}</span>
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 py-2.5">
            <label className="flex h-10 items-center gap-2 rounded-[48px] border border-[#dadce0] bg-white px-4 text-xs font-medium text-[#3c4043] hover:border-[#1a73e8] transition-colors cursor-pointer">
              <input
                type="checkbox"
                checked={includeServed}
                onChange={(e) => {
                  setIncludeServed(e.target.checked);
                  void reloadTickets(e.target.checked);
                }}
                className="accent-[#1a73e8]"
              />
              แสดงรายการที่เสิร์ฟแล้ว
            </label>

            <button
              type="button"
              onClick={() => void reloadTickets(includeServed)}
              className="flex h-10 items-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium tracking-[0.25px] text-[#1a73e8] hover:border-[#1a73e8] hover:bg-[#f8f9fa] transition-colors cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>รีเฟรชคิว</span>
            </button>
          </div>
        </div>
      </section>

      {/* Tickets Grid */}
      {filteredTickets.length === 0 ? (
        <div className="rounded-[4px] border border-[#dadce0] bg-white py-20 px-6 flex flex-col items-center justify-center text-center">
          <div className="h-12 w-12 rounded-full bg-[#e8f0fe] text-[#1a73e8] flex items-center justify-center mb-3">
            <Sparkles className="h-6 w-6" />
          </div>
          <p className="font-google-display text-[20px] font-normal text-[#202124]">
            ไม่มีออเดอร์ค้างในครัวขณะนี้
          </p>
          <p className="text-sm text-[#5f6368] mt-1">
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
                className={`rounded-[4px] border bg-white flex flex-col justify-between overflow-hidden transition-colors duration-200 ${
                  isActivePreparing
                    ? 'border-[#1a73e8]'
                    : isReady
                      ? 'border-[#202124]'
                      : 'border-[#dadce0]'
                } ${ticket.status === 'SERVED' ? 'opacity-65' : ''}`}
              >
                <div>
                  {/* Ticket Edge-to-Edge Header Band */}
                  <div
                    className={`px-5 py-4 border-b flex items-center justify-between ${
                      isActivePreparing
                        ? 'bg-[#000000] text-white border-[#000000]'
                        : isReady
                          ? 'bg-[#e8f0fe] text-[#202124] border-[#dadce0]'
                          : 'bg-[#f8f9fa] text-[#202124] border-[#dadce0]'
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
                              ? 'bg-[#1a73e8] text-white'
                              : 'border border-[#dadce0] bg-white text-[#3c4043]'
                          }`}
                        >
                          SEQ #{ticket.sequenceId}
                        </span>
                      </div>
                      <div
                        className={`text-xs mt-1 ${
                          isActivePreparing ? 'text-white/75' : 'text-[#5f6368]'
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
                              ? 'bg-[#202124] text-white'
                              : 'border border-[#dadce0] bg-white text-[#202124]'
                        }`}
                      >
                        <Clock className="h-3 w-3" />
                        {elapsed.text}
                      </span>
                      <div
                        className={`text-[11px] font-medium uppercase tracking-[0.5px] mt-1.5 ${
                          isActivePreparing ? 'text-[#e8f0fe]' : 'text-[#1a73e8]'
                        }`}
                      >
                        {ticket.status}
                      </div>
                    </div>
                  </div>

                  {/* Ticket Line Items */}
                  <div className="p-5 divide-y divide-[#dadce0]">
                    {ticket.items.map((item) => (
                      <div key={item.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-2.5">
                          <span className="font-google-display text-[15px] font-medium text-[#202124]">
                            {item.itemSummaryText}
                          </span>
                          <span className="rounded-[48px] bg-[#e8f0fe] px-2.5 py-0.5 text-xs font-medium text-[#1a73e8] tabular-nums-google shrink-0">
                            ×{formatMilliUnitsToQtyString(item.quantityMilli).replace(/\.000$/, '')}
                          </span>
                        </div>
                        {item.modifiersSummaryText && (
                          <div className="mt-1.5 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] px-2.5 py-1 text-xs text-[#3c4043]">
                            {item.modifiersSummaryText}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Canonical 48px-Pill Touch Bump Footer */}
                <div className="p-4 bg-[#f8f9fa] border-t border-[#dadce0]">
                  {ticket.status === 'QUEUED' && (
                    <button
                      type="button"
                      onClick={() => void handleBump(ticket, 'PREPARING')}
                      className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[48px] border border-[#1a73e8] bg-white px-5 font-google-display text-sm font-medium tracking-[0.5px] text-[#1a73e8] hover:bg-[#e8f0fe] transition-colors cursor-pointer"
                    >
                      <Flame className="h-4 w-4" />
                      <span>เริ่มทำออเดอร์ (Prepare)</span>
                    </button>
                  )}
                  {ticket.status === 'PREPARING' && (
                    <button
                      type="button"
                      onClick={() => void handleBump(ticket, 'READY')}
                      className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] transition-colors cursor-pointer"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>ทำเสร็จพร้อมเสิร์ฟ (Ready)</span>
                    </button>
                  )}
                  {ticket.status === 'READY' && (
                    <button
                      type="button"
                      onClick={() => void handleBump(ticket, 'SERVED')}
                      className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[48px] bg-[#202124] px-5 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#000000] transition-colors cursor-pointer"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>ส่งมอบลูกค้าแล้ว (Served)</span>
                    </button>
                  )}
                  {ticket.status === 'SERVED' && (
                    <div className="text-center py-2 text-xs font-medium text-[#5f6368]">
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
