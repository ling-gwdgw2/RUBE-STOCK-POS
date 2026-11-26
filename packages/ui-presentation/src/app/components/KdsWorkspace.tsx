import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  CheckCircle2,
  ChefHat,
  Clock,
  Flame,
  Radio,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { formatMilliUnitsToQtyString } from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type { KdsTicketDto } from '../types.ts';
import { UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface KdsWorkspaceProps {
  outletId?: string;
  initialTickets: KdsTicketDto[];
  onRefreshBootstrap: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

const KDS_SOUND_STORAGE_KEY = 'rube_pos_v3_kds_sound_enabled';

/**
 * Synthesizes a clean offline dual-tone kitchen service bell chime (A5 880Hz -> E6 1318.5Hz)
 * using the browser Web Audio API without requiring external audio assets.
 */
function playKitchenServiceBellChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const playTone = (freq: number, startOffset: number, duration: number, peakGain: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + startOffset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    playTone(880, 0, 0.22, 0.18);
    playTone(1318.51, 0.14, 0.36, 0.22);

    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 700);
  } catch {
    // Ignore WebAudio autoplay restrictions until first user interaction
  }
}

export const KdsWorkspace: React.FC<KdsWorkspaceProps> = ({
  outletId = 'OUTLET-HQ',
  initialTickets,
  onRefreshBootstrap,
  onToast,
}) => {
  const [tickets, setTickets] = useState<KdsTicketDto[]>(initialTickets);
  const [stationFilter, setStationFilter] = useState<string>('ALL');
  const [includeServed, setIncludeServed] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState<boolean>(true);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(KDS_SOUND_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [newlyArrivedSeqIds, setNewlyArrivedSeqIds] = useState<number[]>([]);
  const [bumpingIds, setBumpingIds] = useState<Set<string>>(() => new Set());
  const [lastSyncedAt, setLastSyncedAt] = useState<Date>(() => new Date());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState(false);

  const pollSeqRef = useRef<number>(0);
  const prevOutletIdRef = useRef<string>(outletId);
  const includeServedRef = useRef<boolean>(includeServed);
  includeServedRef.current = includeServed;

  const maxSeenSeqRef = useRef<number>(
    initialTickets.reduce((maxSeq, t) => Math.max(maxSeq, t.sequenceId), 0)
  );

  useEffect(() => {
    if (includeServed) return;
    if (
      maxSeenSeqRef.current < 0 &&
      initialTickets.some((t) => t.outletId !== outletId)
    ) {
      return;
    }
    setTickets(initialTickets);
    if (maxSeenSeqRef.current >= 0) {
      const highestInitial = initialTickets.reduce((m, t) => Math.max(m, t.sequenceId), 0);
      if (highestInitial > maxSeenSeqRef.current) {
        maxSeenSeqRef.current = highestInitial;
      }
    }
  }, [includeServed, initialTickets, outletId]);

  const toggleSound = () => {
    setSoundEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(KDS_SOUND_STORAGE_KEY, next ? 'true' : 'false');
      } catch {
        // ignore
      }
      if (next) {
        playKitchenServiceBellChime();
      }
      return next;
    });
  };

  const reloadTickets = useCallback(
    async (showServed = includeServed, silent = false) => {
      const reqSeq = ++pollSeqRef.current;
      if (!silent) setLoading(true);
      try {
        const res = await posTransport.getKdsTickets(outletId, showServed);
        if (reqSeq !== pollSeqRef.current) return;

        const incoming = res.tickets;
        setTickets(incoming);
        setLastSyncedAt(new Date());

        const prevMax = maxSeenSeqRef.current;
        if (prevMax < 0) {
          maxSeenSeqRef.current = incoming.reduce((m, t) => Math.max(m, t.sequenceId), 0);
          return;
        }

        const brandNewQueued = incoming.filter(
          (t) => t.sequenceId > prevMax && t.status === 'QUEUED'
        );
        const nextMax = incoming.reduce((m, t) => Math.max(m, t.sequenceId), prevMax);
        maxSeenSeqRef.current = nextMax;

        if (brandNewQueued.length > 0) {
          const newSeqs = brandNewQueued.map((t) => t.sequenceId);
          setNewlyArrivedSeqIds((prev) => Array.from(new Set([...prev, ...newSeqs])));
          window.setTimeout(() => {
            setNewlyArrivedSeqIds((prev) => prev.filter((id) => !newSeqs.includes(id)));
          }, 12_000);

          const relevantToStation = brandNewQueued.filter(
            (t) => stationFilter === 'ALL' || t.station === stationFilter
          );
          if (relevantToStation.length > 0) {
            if (soundEnabled) {
              playKitchenServiceBellChime();
            }
            onToast(
              `มีออเดอร์ใหม่เข้าสถานี: ${relevantToStation.map((t) => t.queueNumber).join(', ')}`,
              'success'
            );
          }
        }
      } catch (err) {
        if (reqSeq !== pollSeqRef.current) return;
        if (!silent) {
          onToast(err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        if (!silent && reqSeq === pollSeqRef.current) setLoading(false);
      }
    },
    [includeServed, onToast, outletId, soundEnabled, stationFilter]
  );

  const reloadTicketsRef = useRef(reloadTickets);
  reloadTicketsRef.current = reloadTickets;

  // Reset baseline sequence watermark to sentinel (-1) when switching branch outlet
  useEffect(() => {
    if (prevOutletIdRef.current === outletId) return;
    prevOutletIdRef.current = outletId;
    pollSeqRef.current += 1;
    maxSeenSeqRef.current = -1;
    setTickets([]);
    setNewlyArrivedSeqIds([]);
    void reloadTicketsRef.current(includeServedRef.current, false);
  }, [outletId]);

  // Elapsed timer tick (1s)
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Real-time background KDS polling (every 2.5s)
  useEffect(() => {
    if (!autoSyncEnabled) return;
    const pollTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void reloadTickets(includeServed, true);
    }, 2500);
    return () => window.clearInterval(pollTimer);
  }, [autoSyncEnabled, includeServed, reloadTickets]);

  const handleBump = async (
    ticket: KdsTicketDto,
    newStatus: 'PREPARING' | 'READY' | 'SERVED'
  ) => {
    if (bumpingIds.has(ticket.kitchenOrderId)) return;
    setBumpingIds((prev) => {
      const next = new Set(prev);
      next.add(ticket.kitchenOrderId);
      return next;
    });
    try {
      await posTransport.bumpKdsTicket({
        kitchenOrderId: ticket.kitchenOrderId,
        ackedSequenceId: ticket.sequenceId,
        newStatus,
      });
      await reloadTickets(includeServed, true);
      await onRefreshBootstrap();
      onToast(
        `อัปเดตออเดอร์ ${ticket.queueNumber} (#SEQ ${ticket.sequenceId}) → ${newStatus}`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBumpingIds((prev) => {
        if (!prev.has(ticket.kitchenOrderId)) return prev;
        const next = new Set(prev);
        next.delete(ticket.kitchenOrderId);
        return next;
      });
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
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.5px] text-white/75">
              <ChefHat className="h-4 w-4 text-primary" />
              <span>Kitchen Display System · Live Auto-Sync ({outletId})</span>
              {autoSyncEnabled && (
                <span className="inline-flex items-center gap-1 rounded-[48px] border border-white/25 px-2.5 py-0.5 text-[11px] normal-case text-white tabular-nums-google">
                  <Radio className="h-3 w-3 text-primary" />
                  ซิงค์อัตโนมัติ · {lastSyncedAt.toLocaleTimeString('th-TH')}
                </span>
              )}
            </div>
            <h1 className="font-google-display text-[28px] sm:text-[36px] font-normal leading-[36px] sm:leading-[44px] tracking-[-0.25px] text-white">
              หน้าจอรับออเดอร์ครัวและบาร์น้ำ
            </h1>
            <p className="text-sm text-white/75">
              ดึงคิวออเดอร์ใหม่อัตโนมัติทุก 2.5 วินาที พร้อมเสียงกระดิ่งเตือนทันทีเมื่อแคชเชียร์ปิดบิล
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

        {/* Canonical Google Underline Station Tabs + Real-Time Controls */}
        <div className="border-t border-hairline bg-canvas px-4 sm:px-6 flex flex-wrap items-center justify-between gap-4">
          <div
            className="flex items-center gap-1 overflow-x-auto"
            role="tablist"
            aria-label="สถานีครัว"
          >
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

          <div className="flex flex-wrap items-center gap-2 py-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={soundEnabled}
              onClick={toggleSound}
              className={`flex h-10 items-center gap-1.5 rounded-[48px] border px-3.5 font-google-display text-xs font-medium ${UI_INTERACTION.focusButton} ${
                soundEnabled
                  ? 'border-primary bg-primary-soft text-primary-dark'
                  : 'border-hairline bg-canvas text-ink-muted hover:border-ink hover:text-ink'
              }`}
            >
              {soundEnabled ? (
                <Bell className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <BellOff className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>{soundEnabled ? 'เสียงกระดิ่ง: เปิด' : 'เสียงกระดิ่ง: ปิด'}</span>
            </button>

            <button
              type="button"
              role="switch"
              aria-checked={autoSyncEnabled}
              onClick={() => setAutoSyncEnabled((v) => !v)}
              className={`flex h-10 items-center gap-1.5 rounded-[48px] border px-3.5 font-google-display text-xs font-medium ${UI_INTERACTION.focusButton} ${
                autoSyncEnabled
                  ? 'border-hairline bg-canvas text-ink hover:border-primary'
                  : 'border-hairline bg-surface-1 text-ink-muted hover:border-ink hover:text-ink'
              }`}
            >
              <Radio className={`h-3.5 w-3.5 ${autoSyncEnabled ? 'text-primary' : ''}`} />
              <span>{autoSyncEnabled ? 'ซิงค์อัตโนมัติ 2.5 วิ' : 'พักซิงค์อัตโนมัติ'}</span>
            </button>

            <label className="flex h-10 items-center gap-2 rounded-[48px] border border-hairline bg-canvas px-4 text-xs font-medium text-ink-soft hover:border-primary transition-colors duration-200 cursor-pointer focus-within:ring-2 focus-within:ring-primary/25">
              <input
                type="checkbox"
                checked={includeServed}
                onChange={(e) => {
                  setIncludeServed(e.target.checked);
                  void reloadTickets(e.target.checked, false);
                }}
                className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
              />
              แสดงที่เสิร์ฟแล้ว
            </label>

            <button
              type="button"
              onClick={() => void reloadTickets(includeServed, false)}
              className={`flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium tracking-[0.25px] text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>รีเฟรช</span>
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
            หน้าจอกำลังรอรับออเดอร์ใหม่อัตโนมัติ — เมื่อแคชเชียร์ปิดบิลจะมีเสียงกระดิ่งแจ้งเตือนทันที
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filteredTickets.map((ticket) => {
            const elapsed = formatElapsed(ticket.createdAt);
            const isActivePreparing = ticket.status === 'PREPARING';
            const isReady = ticket.status === 'READY';
            const isBrandNew = newlyArrivedSeqIds.includes(ticket.sequenceId);

            return (
              <div
                key={ticket.kitchenOrderId}
                className={`rounded-[4px] border bg-canvas flex flex-col justify-between overflow-hidden transition-colors duration-200 ${
                  isBrandNew || isActivePreparing
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
                          : isBrandNew
                            ? 'bg-primary-soft text-ink border-primary'
                            : 'bg-surface-1 text-ink border-hairline'
                    }`}
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
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
                        {isBrandNew && (
                          <span className="rounded-[48px] bg-primary px-2 py-0.5 text-[10px] font-medium text-white">
                            เข้าใหม่
                          </span>
                        )}
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
                      disabled={bumpingIds.has(ticket.kitchenOrderId)}
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
                      disabled={bumpingIds.has(ticket.kitchenOrderId)}
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
                      disabled={bumpingIds.has(ticket.kitchenOrderId)}
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
