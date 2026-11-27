import React, { useEffect, useState } from 'react';
import {
  BellRing,
  CheckCircle2,
  Clock,
  ExternalLink,
  Printer,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
  XCircle,
} from 'lucide-react';
import { formatMilliUnitsToQtyString } from '../../../../shared-contracts/src/fixed-point.ts';
import { formatMoney } from '../../../../shared-contracts/src/currency.ts';
import { DEFAULT_QR_ORDERING_CONFIG } from '../../../../shared-contracts/src/qr-ordering.ts';
import { posTransport } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type {
  BootstrapPayload,
  GuestOrderRecordDto,
  GuestServiceCallDto,
  QrOrderingConfigDto,
  QrOrderingRuntimeStatusDto,
  StaffUserDto,
  TableQrSessionDto,
} from '../types.ts';
import {
  renderTableQrSlipTo203DpiCanvasRaster,
  type PackedCanvasRasterResult,
} from '../utils/thai-canvas-rasterizer.ts';
import { ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

/**
 * Plays a subtle two-tone chime via WebAudio API (100% offline, zero audio assets needed)
 * when a new customer QR order arrives at the POS register.
 */
export function playNewQrOrderChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const playTone = (freq: number, startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.14, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    playTone(880, 0, 0.16);
    playTone(1174.66, 0.14, 0.24);
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 600);
  } catch {
    // ignore autoplay restriction before first gesture
  }
}

interface QrOrderingInboxPanelProps {
  outletId: string;
  bootstrap: BootstrapPayload;
  guestOrders: GuestOrderRecordDto[];
  tableSessions: TableQrSessionDto[];
  qrStatus: QrOrderingRuntimeStatusDto | undefined;
  syncing: boolean;
  onRefreshOrders: () => Promise<void>;
  onOpenTableQrModal: () => void;
  onAcceptedOrder: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
  serviceCalls?: GuestServiceCallDto[] | undefined;
}

export const QrOrderingInboxPanel: React.FC<QrOrderingInboxPanelProps> = ({
  outletId,
  bootstrap,
  guestOrders,
  tableSessions,
  qrStatus,
  syncing,
  onRefreshOrders,
  onOpenTableQrModal,
  onAcceptedOrder,
  onToast,
  serviceCalls = [],
}) => {
  const { dateTime, fiscal, pick } = useI18n();
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [acknowledgingCallId, setAcknowledgingCallId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<GuestOrderRecordDto | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const qrConfig: QrOrderingConfigDto =
    bootstrap.qrOrderingConfig ?? DEFAULT_QR_ORDERING_CONFIG;
  const pendingCalls = serviceCalls.filter((c) => c.status === 'PENDING');
  const pendingOrders = guestOrders.filter((o) => o.status === 'PENDING_CONFIRM');
  const handledOrders = guestOrders.filter((o) => o.status !== 'PENDING_CONFIRM').slice(0, 25);

  const money = (satang: number) => formatMoney(satang, fiscal.currencyCode);

  const handleAcknowledgeCall = async (callId: string) => {
    setAcknowledgingCallId(callId);
    try {
      await posTransport.acknowledgeQrServiceCall({ outletId, callId });
      await onRefreshOrders();
      onToast(
        pick('รับทราบคำขอลูกค้าแล้ว', 'ຮັບຊາບຄຳຂໍລູກຄ້າແລ້ວ', 'Service call acknowledged'),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAcknowledgingCallId(null);
    }
  };

  const handleAccept = async (order: GuestOrderRecordDto) => {
    setBusyOrderId(order.id);
    try {
      const res = await posTransport.acceptQrGuestOrder({
        outletId,
        guestOrderId: order.id,
      });
      await onAcceptedOrder();
      onToast(
        pick(
          `รับออเดอร์ ${order.orderCode} (${order.tableLabel}) -> รวมเข้าบิลโต๊ะ & ยิงเข้าจอครัว KDS (${res.kdsSequenceIds.length} ใบ) สำเร็จ`,
          `ຮັບອໍເດີ ${order.orderCode} (${order.tableLabel}) -> ລວມບິນໂຕະ & ສົ່ງຄົວ KDS (${res.kdsSequenceIds.length} ໃບ) ສຳເລັດ`,
          `Accepted ${order.orderCode} (${order.tableLabel}) -> Merged to Held Bill & sent to KDS`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectTarget) return;
    setBusyOrderId(rejectTarget.id);
    try {
      await posTransport.rejectQrGuestOrder({
        outletId,
        guestOrderId: rejectTarget.id,
        reason:
          rejectReason.trim() ||
          pick(
            'เมนูหมดชั่วคราว กรุณาสั่งรายการอื่น',
            'ເມນູໝົດຊົ່ວຄາວ ກະລຸນາສັ່ງລາຍການອື່ນ',
            'Item temporarily unavailable'
          ),
      });
      await onRefreshOrders();
      onToast(
        pick(
          `ปฏิเสธออเดอร์ ${rejectTarget.orderCode} และแจ้งลูกค้าบนมือถือแล้ว`,
          `ປະຕິເສດອໍເດີ ${rejectTarget.orderCode} ແລະ ແຈ້ງລູກຄ້າແລ້ວ`,
          `Rejected ${rejectTarget.orderCode} and notified guest`
        ),
        'warn'
      );
      setRejectTarget(null);
      setRejectReason('');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyOrderId(null);
    }
  };

  const renderStatusPill = (status: GuestOrderRecordDto['status']) => {
    const map: Record<GuestOrderRecordDto['status'], { label: string; cls: string }> = {
      PENDING_CONFIRM: {
        label: pick('รอแคชเชียร์รับ', 'ລໍຖ້າຮັບອໍເດີ', 'Pending Confirm'),
        cls: 'border-primary bg-primary-soft text-primary-dark',
      },
      ACCEPTED: {
        label: pick('ส่งเข้าครัวแล้ว', 'ສົ່ງເຂົ້າຄົວແລ້ວ', 'Queued in KDS'),
        cls: 'border-hairline bg-surface-1 text-ink',
      },
      PREPARING: {
        label: pick('กำลังปรุงในครัว', 'ກຳລັງປຸງແຕ່ງ', 'Preparing'),
        cls: 'border-primary/60 bg-primary-soft/60 text-primary-dark',
      },
      READY: {
        label: pick('พร้อมเสิร์ฟแล้ว', 'ພ້ອມເສີບແລ້ວ', 'Ready to Serve'),
        cls: 'border-ink bg-ink text-white',
      },
      SERVED: {
        label: pick('เสิร์ฟแล้ว', 'ເສີບແລ້ວ', 'Served'),
        cls: 'border-hairline bg-surface-1 text-ink-muted',
      },
      SETTLED: {
        label: pick('ชำระเงินแล้ว', 'ຊຳລະເງິນແລ້ວ', 'Settled'),
        cls: 'border-hairline bg-surface-2 text-ink-muted',
      },
      REJECTED: {
        label: pick('ปฏิเสธแล้ว', 'ປະຕິເສດແລ້ວ', 'Rejected'),
        cls: 'border-ink bg-canvas text-ink-muted line-through',
      },
    };
    const meta = map[status];
    return (
      <span
        className={`inline-flex items-center rounded-[48px] border px-2.5 py-0.5 text-[11px] font-medium ${meta.cls}`}
      >
        {meta.label}
      </span>
    );
  };

  return (
    <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
      {/* Header Bar */}
      <div className="border-b border-hairline bg-surface-1 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2">
            <QrCode className="h-5 w-5 text-primary" />
            <span>
              {pick(
                'ออเดอร์ QR จากมือถือลูกค้า (Local LAN QR Ordering)',
                'ອໍເດີ QR ຈາກມືຖືລູກຄ້າ (Local LAN QR Ordering)',
                'Customer Mobile QR Order Inbox'
              )}
            </span>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span
              className={`inline-flex items-center gap-1 rounded-[48px] border px-2.5 py-0.5 font-medium ${
                qrStatus?.running
                  ? 'border-primary bg-primary-soft text-primary-dark'
                  : 'border-hairline bg-canvas text-ink-muted'
              }`}
            >
              <Wifi className="h-3 w-3" />
              {qrStatus?.running
                ? `${pick('เซิร์ฟเวอร์ลูกค้าเปิดอยู่', 'ເຊີບເວີລູກຄ້າເປີດຢູ່', 'Guest LAN ON')} · ${qrStatus.baseUrl}`
                : pick(
                    'เซิร์ฟเวอร์ QR ปิดอยู่ (เปิดได้ที่หน้าตั้งค่าระบบ)',
                    'ເຊີບເວີ QR ປິດຢູ່ (ເປີດໄດ້ທີ່ໜ້າຕັ້ງຄ່າລະບົບ)',
                    'Guest LAN OFF (enable in System Settings)'
                  )}
            </span>
            <span>
              {pick('โต๊ะที่เปิด QR อยู่:', 'ໂຕະທີ່ເປີດ QR ຢູ່:', 'Active Table QRs:')}{' '}
              <strong className="text-ink tabular-nums-google">{tableSessions.length}</strong>
            </span>
            <span>·</span>
            <span>
              {qrConfig.approvalMode === 'AUTO_ACCEPT_SIGNED_TABLE'
                ? pick('โหมด Auto-Accept (Signed QR)', 'ໂໝດ Auto-Accept (Signed QR)', 'Auto-Accept Signed QR')
                : pick('โหมดรอแคชเชียร์กดรับ', 'ໂໝດລໍຖ້າແຄັດເຊຍກົດຮັບ', 'Cashier Confirm Mode')}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onRefreshOrders()}
            className={`inline-flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            <span>{pick('รีเฟรชคิว QR', 'ຣີເຟຣດຄິວ QR', 'Refresh')}</span>
          </button>
          <button
            type="button"
            onClick={onOpenTableQrModal}
            className={`inline-flex h-10 items-center gap-2 rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.25px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            <Printer className="h-4 w-4" />
            <span>
              {pick(
                'เปิดโต๊ะ / พิมพ์ใบ QR โต๊ะ',
                'ເປີດໂຕະ / ພິມໃບ QR ໂຕະ',
                'Open Table & Print QR Slip'
              )}
            </span>
          </button>
        </div>
      </div>

      {/* Pending Confirmation Queue */}
      <div className="p-6 space-y-6">
        {pendingCalls.length > 0 && (
          <div className="space-y-2.5">
            <h4 className="font-google-display text-[15px] font-medium text-ink flex items-center gap-2">
              <BellRing className="h-4 w-4 text-danger" />
              <span>
                {pick(
                  `คำขอเรียกพนักงาน / เช็กบิลจากโต๊ะ (${pendingCalls.length})`,
                  `ຄຳຂໍເອີ້ນພະນັກງານ / ເຊັກບິນຈາກໂຕະ (${pendingCalls.length})`,
                  `Table Service Calls & Bill Requests (${pendingCalls.length})`
                )}
              </span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {pendingCalls.map((call) => {
                const isCallBusy = acknowledgingCallId === call.id;
                const isBill = call.callType === 'REQUEST_BILL';
                return (
                  <div
                    key={call.id}
                    className="flex items-center justify-between gap-3 rounded-[6px] border border-danger/40 bg-danger-soft/30 px-4 py-3"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="rounded-[48px] bg-ink px-2.5 py-0.5 text-xs font-medium text-white">
                          {pick('โต๊ะ', 'ໂຕະ', 'Table')} {call.tableLabel}
                        </span>
                        <span className="text-sm font-medium text-ink">
                          {isBill
                            ? pick('ขอเช็กบิล', 'ຂໍເຊັກບິນ', 'Request Bill')
                            : pick('เรียกพนักงาน', 'ເອີ້ນພະນັກງານ', 'Call Staff')}
                        </span>
                      </div>
                      <div className="text-xs text-ink-muted flex items-center gap-1.5">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span>{dateTime(call.createdAtIso)}</span>
                        {call.note && (
                          <>
                            <span>·</span>
                            <span className="truncate text-ink">{call.note}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isCallBusy}
                      onClick={() => void handleAcknowledgeCall(call.id)}
                      className="shrink-0 rounded-[48px] bg-ink px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {isCallBusy
                        ? pick('กำลังบันทึก...', 'ກຳລັງບັນທຶກ...', 'Saving...')
                        : pick('รับทราบ', 'ຮັບຊາບ', 'Acknowledge')}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-google-display text-[15px] font-medium text-ink flex items-center gap-2">
              <BellRing className="h-4 w-4 text-primary" />
              <span>
                {pick(
                  `ออเดอร์รอการยืนยัน (${pendingOrders.length})`,
                  `ອໍເດີລໍຖ້າການຢືນຢັນ (${pendingOrders.length})`,
                  `Pending Confirmation (${pendingOrders.length})`
                )}
              </span>
            </h4>
          </div>

          {pendingOrders.length === 0 ? (
            <div className="rounded-[4px] border border-dashed border-hairline bg-surface-1 py-10 px-6 text-center">
              <CheckCircle2 className="h-8 w-8 text-ink-muted mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">
                {pick(
                  'ไม่มีออเดอร์ QR ค้างรอยืนยันในขณะนี้',
                  'ບໍ່ມີອໍເດີ QR ຄ້າງລໍຖ້າຢືນຢັນໃນຂະນະນີ້',
                  'No pending QR orders waiting for confirmation'
                )}
              </p>
              <p className="text-xs text-ink-muted mt-1">
                {pick(
                  'กดปุ่ม "เปิดโต๊ะ / พิมพ์ใบ QR โต๊ะ" เพื่อพิมพ์สลิป Wi-Fi QR + QR สั่งอาหารให้ลูกค้าสแกนที่โต๊ะ',
                  'ກົດປຸ່ມ "ເປີດໂຕະ / ພິມໃບ QR ໂຕະ" ເພື່ອພິມສະລິບ Wi-Fi QR + QR ສັ່ງອາຫານໃຫ້ລູກຄ້າ',
                  'Click "Open Table & Print QR Slip" to hand guests a Wi-Fi + Signed Table QR slip'
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {pendingOrders.map((ord) => {
                const isBusy = busyOrderId === ord.id;
                return (
                  <div
                    key={ord.id}
                    className="rounded-[6px] border border-primary bg-primary-soft/20 p-5 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-google-display text-[20px] font-medium text-ink tabular-nums-google">
                            {ord.orderCode}
                          </span>
                          <span className="rounded-[48px] bg-ink px-3 py-0.5 text-xs font-medium text-white">
                            {pick('โต๊ะ', 'ໂຕະ', 'Table')} {ord.tableLabel}
                          </span>
                          {ord.isSignedTableSession ? (
                            <span className="inline-flex items-center gap-1 rounded-[48px] border border-primary bg-canvas px-2.5 py-0.5 text-[11px] font-medium text-primary-dark">
                              <ShieldCheck className="h-3 w-3" />
                              Signed QR
                            </span>
                          ) : (
                            <span className="rounded-[48px] border border-hairline bg-canvas px-2.5 py-0.5 text-[11px] text-ink-muted">
                              Walk-in Captive
                            </span>
                          )}
                          {renderStatusPill(ord.status)}
                        </div>
                        <div className="text-xs text-ink-muted flex flex-wrap items-center gap-2">
                          <Clock className="h-3.5 w-3.5" />
                          <span>{dateTime(ord.createdAtIso)}</span>
                          {ord.customerName && (
                            <>
                              <span>·</span>
                              <span>{ord.customerName}</span>
                            </>
                          )}
                          {ord.customerNote && (
                            <>
                              <span>·</span>
                              <span className="text-ink font-medium">Note: {ord.customerNote}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-ink-muted">
                          {pick('ยอดประมาณการ', 'ຍອດປະມານການ', 'Estimated')}
                        </div>
                        <div className="font-google-display text-[22px] font-normal text-ink tabular-nums-google">
                          {money(ord.estimatedTotalSatang)}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[4px] border border-hairline bg-canvas divide-y divide-hairline">
                      {ord.lines.map((ln, idx) => (
                        <div
                          key={`${ord.id}-${idx}`}
                          className="px-3.5 py-2 flex items-start justify-between gap-3 text-xs"
                        >
                          <div>
                            <div className="font-medium text-ink">
                              {formatMilliUnitsToQtyString(ln.quantityMilli, ln.unitName)} ×{' '}
                              {ln.itemName}
                            </div>
                            {ln.modifierNames.length > 0 && (
                              <div className="text-ink-muted">+ {ln.modifierNames.join(', ')}</div>
                            )}
                            {ln.note && (
                              <div className="text-primary-dark font-medium">
                                Note: {ln.note}
                              </div>
                            )}
                          </div>
                          <span className="font-medium text-ink tabular-nums-google shrink-0">
                            {money(ln.lineTotalSatang)}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          setRejectTarget(ord);
                          setRejectReason('');
                        }}
                        className={`inline-flex h-[42px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-soft hover:border-ink hover:text-ink disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
                      >
                        <XCircle className="h-4 w-4" />
                        <span>{pick('ปฏิเสธออเดอร์', 'ປະຕິເສດອໍເດີ', 'Reject')}</span>
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleAccept(ord)}
                        className={`inline-flex h-[42px] items-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.25px] text-white hover:bg-primary-hover disabled:opacity-45 ${UI_INTERACTION.focusButtonPrimary}`}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        <span>
                          {pick(
                            'รับออเดอร์ -> รวมบิลโต๊ะ & ส่งครัว KDS',
                            'ຮັບອໍເດີ -> ລວມບິນໂຕະ & ສົ່ງຄົວ KDS',
                            'Accept -> Merge Table Bill & Send to KDS'
                          )}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Handled QR Orders */}
        {handledOrders.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-hairline">
            <h4 className="font-google-display text-[14px] font-medium text-ink-soft">
              {pick(
                `ออเดอร์ QR ที่ดำเนินการแล้ว (${handledOrders.length})`,
                `ອໍເດີ QR ທີ່ດຳເນີນການແລ້ວ (${handledOrders.length})`,
                `Recent Handled QR Orders (${handledOrders.length})`
              )}
            </h4>
            <div className="divide-y divide-hairline rounded-[4px] border border-hairline">
              {handledOrders.map((ord) => (
                <div
                  key={ord.id}
                  className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-surface-1 transition-colors duration-150"
                >
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink tabular-nums-google">
                        {ord.orderCode}
                      </span>
                      <span className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 font-medium text-ink">
                        {ord.tableLabel}
                      </span>
                      {renderStatusPill(ord.status)}
                    </div>
                    <div className="text-ink-muted">
                      {ord.lines.map((l) => `${Math.round(l.quantityMilli / 1000)}x ${l.itemName}`).join(', ')}
                    </div>
                    {ord.rejectionReason && (
                      <div className="text-ink-soft">
                        {pick('เหตุผล:', 'ເຫດຜົນ:', 'Reason:')} {ord.rejectionReason}
                      </div>
                    )}
                  </div>
                  <div className="text-right tabular-nums-google">
                    <div className="font-medium text-ink">{money(ord.estimatedTotalSatang)}</div>
                    <div className="text-[11px] text-ink-muted">
                      {dateTime(ord.createdAtIso)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reject Reason Modal (Zero window.prompt) */}
      <ModalDialog
        open={Boolean(rejectTarget)}
        ariaLabel={
          rejectTarget
            ? pick(
                `ปฏิเสธออเดอร์ ${rejectTarget.orderCode} (${rejectTarget.tableLabel})`,
                `ປະຕິເສດອໍເດີ ${rejectTarget.orderCode} (${rejectTarget.tableLabel})`,
                `Reject Order ${rejectTarget.orderCode} (${rejectTarget.tableLabel})`
              )
            : 'Reject QR Order'
        }
        onClose={() => setRejectTarget(null)}
        maxWidthClass="max-w-md"
      >
        <div className="border-b border-hairline bg-surface-1 px-6 py-4 flex items-center justify-between gap-3">
          <h3 className="font-google-display text-[18px] font-normal text-ink">
            {rejectTarget
              ? pick(
                  `ปฏิเสธออเดอร์ ${rejectTarget.orderCode} (${rejectTarget.tableLabel})`,
                  `ປະຕິເສດອໍເດີ ${rejectTarget.orderCode} (${rejectTarget.tableLabel})`,
                  `Reject Order ${rejectTarget.orderCode} (${rejectTarget.tableLabel})`
                )
              : ''}
          </h3>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setRejectTarget(null)}
            className={`flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-canvas text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-xs text-ink-muted">
            {pick(
              'ระบุเหตุผลที่จะส่งกลับไปแสดงบนหน้าจอมือถือของลูกค้า:',
              'ລະບຸເຫດຜົນທີ່ຈະສົ່ງກັບໄປສະແດງເທິງມືຖືຂອງລູກຄ້າ:',
              'Enter a reason shown on the customer mobile status tracker:'
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[
              pick('เมนูหมดชั่วคราว', 'ເມນູໝົດຊົ່ວຄາວ', 'Item sold out'),
              pick('หมายเลขโต๊ะไม่ถูกต้อง', 'ເລກໂຕະບໍ່ຖືກຕ້ອງ', 'Incorrect table number'),
              pick('ครัวปิดรับออเดอร์แล้ว', 'ຄົວປິດຮັບອໍເດີແລ້ວ', 'Kitchen is closed'),
            ].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setRejectReason(preset)}
                className={`rounded-[48px] border border-hairline bg-surface-1 px-3 py-1.5 text-xs text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
              >
                {preset}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            maxLength={160}
            placeholder={pick('พิมพ์เหตุผลเพิ่มเติม...', 'ພິມເຫດຜົນເພີ່ມເຕີມ...', 'Custom reason...')}
            className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-sm text-ink ${UI_INTERACTION.focusControl}`}
          />
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setRejectTarget(null)}
              className={`h-10 rounded-[48px] border border-hairline bg-canvas px-5 text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
            >
              {pick('ยกเลิก', 'ຍົກເລີກ', 'Cancel')}
            </button>
            <button
              type="button"
              disabled={busyOrderId !== null}
              onClick={() => void handleConfirmReject()}
              className={`h-10 rounded-[48px] bg-ink px-5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
            >
              {pick('ยืนยันปฏิเสธออเดอร์', 'ຢືນຢັນປະຕິເສດອໍເດີ', 'Confirm Rejection')}
            </button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
};

interface TableQrSlipModalProps {
  open: boolean;
  outletId: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  tableSessions: TableQrSessionDto[];
  onClose: () => void;
  onSessionsChanged: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const TableQrSlipModal: React.FC<TableQrSlipModalProps> = ({
  open,
  outletId,
  bootstrap,
  currentUser,
  tableSessions,
  onClose,
  onSessionsChanged,
  onToast,
}) => {
  const { dateTime, fiscal, pick } = useI18n();
  const qrCfg = bootstrap.qrOrderingConfig ?? DEFAULT_QR_ORDERING_CONFIG;
  const paperWidthMm: 80 | 58 = bootstrap.printerConfig.paperWidthMm;

  const [selectedTable, setSelectedTable] = useState<string>(qrCfg.tableLabels[0] ?? 'T01');
  const [activeSession, setActiveSession] = useState<TableQrSessionDto | null>(null);
  const [slipRaster, setSlipRaster] = useState<PackedCanvasRasterResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const found = tableSessions.find(
      (s) => s.tableLabel.toUpperCase() === selectedTable.toUpperCase()
    );
    setActiveSession(found ?? null);
  }, [open, selectedTable, tableSessions]);

  useEffect(() => {
    if (!open || !activeSession) {
      setSlipRaster(null);
      return;
    }
    try {
      const raster = renderTableQrSlipTo203DpiCanvasRaster({
        paperWidthMm,
        receiptLocale: fiscal.receiptLocale,
        storeName: bootstrap.storeSettings.storeName,
        tableLabel: activeSession.tableLabel,
        menuUrl: activeSession.menuUrl,
        wifiSsid: qrCfg.wifiSsid,
        wifiPassword: qrCfg.wifiPassword,
        wifiSecurity: qrCfg.wifiSecurity,
        wifiQrPayload: activeSession.wifiQrPayload,
        openedByName: activeSession.openedByName,
        openedAtText: dateTime(activeSession.openedAtIso),
      });
      setSlipRaster(raster);
    } catch {
      setSlipRaster(null);
    }
  }, [
    open,
    activeSession,
    paperWidthMm,
    fiscal.receiptLocale,
    bootstrap.storeSettings.storeName,
    qrCfg.wifiSsid,
    qrCfg.wifiPassword,
    qrCfg.wifiSecurity,
  ]);

  const handleOpenOrRotateSession = async (tableLbl: string) => {
    setBusy(true);
    try {
      const res = await posTransport.openTableQrSession({
        outletId,
        tableLabel: tableLbl,
        openedByName: currentUser.displayName,
      });
      setActiveSession(res.session);
      await onSessionsChanged();
      onToast(
        pick(
          `สร้าง Signed Table QR ใหม่สำหรับโต๊ะ ${tableLbl} แล้ว (QR เก่าถูกยกเลิกอัตโนมัติ)`,
          `ສ້າງ Signed Table QR ໃໝ່ສຳລັບໂຕະ ${tableLbl} ແລ້ວ (QR ເກົ່າຖືກຍົກເລີກອັດຕະໂນມັດ)`,
          `Generated fresh HMAC Table QR for ${tableLbl}`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePrintThermalSlip = async () => {
    if (!activeSession || !slipRaster) return;
    setBusy(true);
    try {
      const res = await posTransport.printCanvasRaster({
        packedBitmapBase64: slipRaster.packedBitmapBase64,
        widthPx: slipRaster.widthPx,
        heightPx: slipRaster.heightPx,
        kickCashDrawer: false,
        receiptNumber: `QR-TABLE-${activeSession.tableLabel}`,
      });
      onToast(
        res.hardwareOutcome.dispatchedToHardware
          ? pick(
              `พิมพ์ใบเปิดโต๊ะ QR โต๊ะ ${activeSession.tableLabel} ออกเครื่องพิมพ์ ${paperWidthMm}mm สำเร็จ`,
              `ພິມໃບເປີດໂຕະ QR ໂຕະ ${activeSession.tableLabel} (${paperWidthMm}mm) ສຳເລັດ`,
              `Printed Table QR slip for ${activeSession.tableLabel} (${paperWidthMm}mm)`
            )
          : pick(
              `สร้างคิวพิมพ์ใบเปิดโต๊ะ QR (${res.packetsCount} แพ็กเก็ต · โหมด ${res.hardwareOutcome.transportMode}) สำเร็จ`,
              `ສ້າງຄິວພິມໃບເປີດໂຕະ QR (${res.packetsCount} packets) ສຳເລັດ`,
              `Spool queued Table QR slip (${res.packetsCount} packets)`
            ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeSession = async () => {
    if (!activeSession) return;
    setBusy(true);
    try {
      await posTransport.revokeTableQrSession({
        outletId,
        tableLabel: activeSession.tableLabel,
      });
      setActiveSession(null);
      await onSessionsChanged();
      onToast(
        pick(
          `ยกเลิก QR ประจำโต๊ะ ${activeSession.tableLabel} แล้ว`,
          `ຍົກເລີກ QR ປະຈຳໂຕະ ${activeSession.tableLabel} ແລ້ວ`,
          `Revoked Table QR session for ${activeSession.tableLabel}`
        ),
        'warn'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      ariaLabel={pick(
        'เปิดโต๊ะ & พิมพ์ใบ QR ประจำโต๊ะ (Wi-Fi + Signed Table QR)',
        'ເປີດໂຕະ & ພິມໃບ QR ປະຈຳໂຕະ (Wi-Fi + Signed Table QR)',
        'Open Table & Print Thermal QR Slip'
      )}
      onClose={onClose}
      maxWidthClass="max-w-3xl"
    >
      <div className="border-b border-hairline bg-surface-1 px-6 py-4 flex items-center justify-between gap-3">
        <h3 className="font-google-display text-[18px] font-normal text-ink flex items-center gap-2">
          <QrCode className="h-5 w-5 text-primary" />
          <span>
            {pick(
              'เปิดโต๊ะ & พิมพ์ใบ QR ประจำโต๊ะ (Wi-Fi + Signed Table QR)',
              'ເປີດໂຕະ & ພິມໃບ QR ປະຈຳໂຕະ (Wi-Fi + Signed Table QR)',
              'Open Table & Print Thermal QR Slip'
            )}
          </span>
        </h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={`flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-canvas text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Left: Table Selector */}
        <div className="md:col-span-6 space-y-4">
          <div className="text-xs text-ink-muted">
            {pick(
              'เลือกหมายเลขโต๊ะที่ต้องการเปิดรับออเดอร์จากมือถือ (ระบบลงนาม HMAC อัตโนมัติและยกเลิก QR เก่าเมื่อเช็กบิล):',
              'ເລືອກເລກໂຕະທີ່ຕ້ອງການເປີດຮັບອໍເດີຈາກມືຖື (ລົງນາມ HMAC ອັດຕະໂນມັດ):',
              'Select a table to open or rotate its HMAC-signed ordering QR session:'
            )}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-56 overflow-y-auto pr-1">
            {qrCfg.tableLabels.map((lbl) => {
              const isSelected = lbl.toUpperCase() === selectedTable.toUpperCase();
              const hasActive = tableSessions.some(
                (s) => s.tableLabel.toUpperCase() === lbl.toUpperCase()
              );
              return (
                <button
                  key={lbl}
                  type="button"
                  onClick={() => setSelectedTable(lbl)}
                  className={`h-11 rounded-[4px] border px-2 text-xs font-medium flex flex-col items-center justify-center ${UI_INTERACTION.focusButton} ${
                    isSelected
                      ? 'border-primary bg-primary text-white'
                      : hasActive
                        ? 'border-primary/60 bg-primary-soft text-primary-dark'
                        : 'border-hairline bg-canvas text-ink hover:border-primary'
                  }`}
                >
                  <span>{lbl}</span>
                  {hasActive && (
                    <span className={`text-[9px] ${isSelected ? 'text-white/90' : 'text-primary-dark'}`}>
                      QR Active
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="space-y-2 pt-2 border-t border-hairline">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleOpenOrRotateSession(selectedTable)}
              className={`flex h-11 w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-45 ${UI_INTERACTION.focusButtonPrimary}`}
            >
              <QrCode className="h-4 w-4" />
              <span>
                {activeSession
                  ? pick(
                      `ออก QR ใหม่ให้โต๊ะ ${selectedTable} (ยกเลิกใบเดิม)`,
                      `ອອກ QR ໃໝ່ໃຫ້ໂຕະ ${selectedTable} (ຍົກເລີກໃບເດີມ)`,
                      `Rotate Table QR for ${selectedTable}`
                    )
                  : pick(
                      `เปิดโต๊ะ ${selectedTable} & สร้าง Signed QR`,
                      `ເປີດໂຕະ ${selectedTable} & ສ້າງ Signed QR`,
                      `Open Table ${selectedTable} & Generate QR`
                    )}
              </span>
            </button>

            {activeSession && (
              <div className="flex flex-wrap gap-2">
                <a
                  href={activeSession.menuUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`flex-1 inline-flex h-10 items-center justify-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 text-xs font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>{pick('เปิดหน้าเมนูทดสอบ', 'ເປີດໜ້າເມນູທົດສອບ', 'Preview Menu')}</span>
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRevokeSession()}
                  className={`inline-flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 text-xs font-medium text-ink-muted hover:border-ink hover:text-ink disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{pick('ปิด QR โต๊ะนี้', 'ປິດ QR ໂຕະນີ້', 'Revoke')}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Live 203-DPI Thermal Slip Preview & Print Action */}
        <div className="md:col-span-6 flex flex-col items-center justify-between rounded-[6px] border border-hairline bg-surface-1 p-4 space-y-3">
          {slipRaster ? (
            <>
              <div className="text-xs font-medium text-ink-soft">
                {pick(
                  `ตัวอย่างสลิปความร้อน 203-DPI (${paperWidthMm}mm)`,
                  `ຕົວຢ່າງສະລິບຄວາມຮ້ອນ 203-DPI (${paperWidthMm}mm)`,
                  `203-DPI Thermal Slip Preview (${paperWidthMm}mm)`
                )}
              </div>
              <div className="max-h-72 overflow-y-auto rounded-[4px] border border-hairline bg-white p-2">
                <img
                  src={slipRaster.previewDataUrl}
                  alt={`Table QR Slip ${activeSession?.tableLabel ?? ''}`}
                  className="w-56 h-auto block"
                />
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handlePrintThermalSlip()}
                className={`flex h-11 w-full items-center justify-center gap-2 rounded-[48px] bg-ink px-5 font-google-display text-xs font-medium text-white hover:opacity-90 disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
              >
                <Printer className="h-4 w-4" />
                <span>
                  {pick(
                    `พิมพ์ใบ QR โต๊ะ ${activeSession?.tableLabel ?? ''} (${paperWidthMm}mm)`,
                    `ພິມໃບ QR ໂຕະ ${activeSession?.tableLabel ?? ''} (${paperWidthMm}mm)`,
                    `Print Thermal QR Slip (${paperWidthMm}mm)`
                  )}
                </span>
              </button>
            </>
          ) : (
            <div className="my-auto py-12 text-center space-y-2">
              <QrCode className="h-10 w-10 text-ink-muted mx-auto" />
              <div className="text-xs text-ink-muted max-w-xs">
                {pick(
                  `กดปุ่ม "เปิดโต๊ะ ${selectedTable} & สร้าง Signed QR" เพื่อสร้างสลิป Wi-Fi + เมนูประจำโต๊ะ`,
                  `ກົດປຸ່ມ "ເປີດໂຕະ ${selectedTable} & ສ້າງ Signed QR" ເພື່ອສ້າງສະລິບ QR`,
                  `Click "Open Table ${selectedTable}" to generate the 203-DPI printable QR slip`
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  );
};
