import React, { useEffect, useState } from 'react';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  FileText,
  HardDriveDownload,
  LockKeyhole,
  Receipt,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import {
  formatSatangToThbString,
  parseDecimalStringToScaledInt,
} from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport, type ReportsBundleDto } from '../api/pos-transport.ts';
import type { BootstrapPayload, StaffUserDto } from '../types.ts';

interface ShiftAndReportsWorkspaceProps {
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const ShiftAndReportsWorkspace: React.FC<ShiftAndReportsWorkspaceProps> = ({
  bootstrap,
  currentUser,
  onRefreshState,
  onToast,
}) => {
  const [reportTab, setReportTab] = useState<
    'SHIFT_DRAWER' | 'Z_REPORT' | 'ABB_TAX' | 'VALUATION' | 'MARGIN'
  >('SHIFT_DRAWER');
  const [reports, setReports] = useState<ReportsBundleDto | null>(null);
  const [selectedShiftIdForZ, setSelectedShiftIdForZ] = useState<string>(
    bootstrap.activeShift?.id ?? ''
  );

  // Cash Drawer Movement Form
  const [mvType, setMvType] = useState<'PAID_IN' | 'PAID_OUT' | 'CASH_DROP'>('PAID_IN');
  const [mvAmountBaht, setMvAmountBaht] = useState('200.00');
  const [mvReason, setMvReason] = useState('แลกเหรียญทอนเข้าลิ้นชัก');

  // Blind Drop Shift Close & Open Shift Form
  const [countedCashBaht, setCountedCashBaht] = useState<string>('');
  const [openingCashInput, setOpeningCashInput] = useState<string>('1000.00');
  const [closeNotes, setCloseNotes] = useState('ปิดกะตรวจนับเงินสดประจำวัน');
  const [busy, setBusy] = useState(false);

  const handleOpenNewShift = async () => {
    setBusy(true);
    try {
      const openingCashSatang = Math.max(
        0,
        parseDecimalStringToScaledInt(openingCashInput || '0', 2)
      );
      await posTransport.openShift({
        openedByUserId: currentUser.id,
        openingCashSatang,
        notes: 'Opened from Shifts & Reports workspace',
      });
      await onRefreshState();
      await loadReports();
      onToast('เปิดกะแคชเชียร์ใหม่เรียบร้อยแล้ว', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadReports = async (shiftId?: string) => {
    try {
      const res = await posTransport.getReports('OUTLET-HQ', shiftId || undefined);
      setReports(res);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  useEffect(() => {
    void loadReports(selectedShiftIdForZ || bootstrap.activeShift?.id);
  }, [bootstrap.activeShift?.id, selectedShiftIdForZ]);

  useEffect(() => {
    if (bootstrap.activeShift) {
      setCountedCashBaht(
        formatSatangToThbString(bootstrap.activeShift.expectedCashSatang).replace(/,/g, '')
      );
    }
  }, [bootstrap.activeShift?.expectedCashSatang]);

  const handleRecordMovement = async () => {
    setBusy(true);
    try {
      const amountSatang = parseDecimalStringToScaledInt(mvAmountBaht, 2);
      await posTransport.recordCashMovement({
        movementType: mvType,
        amountSatang,
        reason: mvReason,
        performedByUserId: currentUser.id,
      });
      await onRefreshState();
      await loadReports();
      onToast(`บันทึกรายการลิ้นชักเงินสด (${mvType}) สำเร็จ`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleBlindDropClose = async () => {
    setBusy(true);
    try {
      const countedSatang = parseDecimalStringToScaledInt(countedCashBaht || '0', 2);
      const res = await posTransport.closeShiftAndBackup({
        countedCashSatang: countedSatang,
        closedByUserId: currentUser.id,
        reopenNextShift: true,
        notes: closeNotes,
      });
      await onRefreshState();
      setSelectedShiftIdForZ(res.closedShift.id);
      await loadReports(res.closedShift.id);
      setReportTab('Z_REPORT');
      onToast(
        `ปิดกะ ${res.closedShift.shiftNumber} & สำรองข้อมูลเข้ารหัสลง USB (${res.usbBackup.retainedBackupsCount}/14 กะ) สำเร็จ`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Canonical Google Underline Sub-Navigation Tabs */}
      <div className="border-b border-[#dadce0] bg-white">
        <div className="flex items-center gap-1 overflow-x-auto" role="tablist">
          {[
            {
              id: 'SHIFT_DRAWER' as const,
              label: 'ลิ้นชักเงินสด & ปิดกะ (Blind Drop)',
              icon: Wallet,
            },
            { id: 'Z_REPORT' as const, label: 'รายงานปิดกะ (Z-Report)', icon: FileText },
            { id: 'ABB_TAX' as const, label: 'รายงานภาษีขาย VAT 7% (ABB)', icon: Receipt },
            {
              id: 'VALUATION' as const,
              label: 'มูลค่าคงคลัง (Stock Valuation)',
              icon: BarChart3,
            },
            { id: 'MARGIN' as const, label: 'กำไรขั้นต้น (COGS & Margin)', icon: TrendingUp },
          ].map((t) => {
            const Icon = t.icon;
            const active = reportTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setReportTab(t.id)}
                className={`relative flex h-12 items-center gap-2 px-3.5 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                  active ? 'text-[#202124]' : 'text-[#5f6368] hover:text-[#202124]'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-[#1a73e8]' : ''}`} />
                <span>{t.label}</span>
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: SHIFT CASH DRAWER (NO ACTIVE SHIFT FALLBACK) */}
      {reportTab === 'SHIFT_DRAWER' && !bootstrap.activeShift && (
        <div className="max-w-lg rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          <div className="bg-[#000000] p-6 text-white">
            <div className="text-xs uppercase tracking-[0.5px] text-white/70">POS Shift</div>
            <h3 className="mt-1 font-google-display text-[26px] font-normal leading-[34px] tracking-[-0.25px]">
              ยังไม่มีกะแคชเชียร์ที่เปิดใช้งาน
            </h3>
            <p className="mt-1 text-xs text-white/75">
              กรุณาระบุเงินทอนตั้งต้นเพื่อเปิดกะใหม่ก่อนเริ่มบันทึกการขายหน้าร้าน
            </p>
          </div>
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#5f6368] mb-1.5">
                เงินสดทอนตั้งต้นในลิ้นชัก (บาท)
              </label>
              <input
                type="text"
                value={openingCashInput}
                onChange={(e) => setOpeningCashInput(e.target.value)}
                className="h-12 w-full rounded-[4px] border border-[#dadce0] bg-white px-4 font-google-display text-[22px] font-normal text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleOpenNewShift()}
              className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
            >
              เปิดกะแคชเชียร์ใหม่
            </button>
          </div>
        </div>
      )}

      {/* TAB 1: SHIFT CASH DRAWER & BLIND DROP CLOSE */}
      {reportTab === 'SHIFT_DRAWER' && bootstrap.activeShift && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left: Active Shift Hero + Cash In/Out */}
          <div className="xl:col-span-7 rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
            {/* Near-Black Hero Expected Cash Band */}
            <div className="bg-[#000000] p-6 text-white flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 rounded-[48px] border border-white/25 px-3 py-1 text-xs font-medium text-white">
                  <span className="h-2 w-2 rounded-full bg-[#1a73e8]" />
                  <span>กะกำลังเปิดใช้งาน (OPEN SHIFT)</span>
                </div>
                <h2 className="mt-2 font-google-display text-[28px] font-normal leading-[36px] tracking-[-0.25px] text-white tabular-nums-google">
                  {bootstrap.activeShift.shiftNumber}
                </h2>
              </div>

              <div className="text-right">
                <div className="text-xs text-white/70">เงินสดคาดหวังในลิ้นชัก (Expected Cash)</div>
                <div className="mt-1 font-google-display text-[44px] font-normal leading-[52px] tracking-[-0.5px] text-white tabular-nums-google">
                  ฿{formatSatangToThbString(bootstrap.activeShift.expectedCashSatang)}
                </div>
              </div>
            </div>

            <div className="p-6 space-y-5 bg-white">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-4">
                  <div className="text-[#5f6368]">เงินทอนตั้งต้นเปิดกะ (Opening Float)</div>
                  <div className="mt-1 font-google-display text-[22px] font-normal text-[#202124] tabular-nums-google">
                    ฿{formatSatangToThbString(bootstrap.activeShift.openingCashSatang)}
                  </div>
                </div>
                <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-4">
                  <div className="text-[#5f6368]">เวลาเปิดกะ</div>
                  <div className="mt-1.5 font-google-display text-[16px] font-normal text-[#202124] tabular-nums-google">
                    {new Date(bootstrap.activeShift.openedAt).toLocaleString('th-TH')}
                  </div>
                </div>
              </div>

              {/* Record Paid-In / Paid-Out / Safe Drop */}
              <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-4 space-y-3">
                <div className="font-google-display text-sm font-medium text-[#202124]">
                  บันทึกนำเงินเข้า / จ่ายเงินสดย่อย / ดึงเงินเก็บเซฟ (Cash Drawer Movements)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <select
                    value={mvType}
                    onChange={(e) =>
                      setMvType(e.target.value as 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP')
                    }
                    className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                  >
                    <option value="PAID_IN">PAID_IN (+ นำเงินทอนเข้า)</option>
                    <option value="PAID_OUT">PAID_OUT (- จ่ายค่าใช้จ่ายย่อย)</option>
                    <option value="CASH_DROP">CASH_DROP (- นำฝากตู้เซฟ)</option>
                  </select>
                  <input
                    type="text"
                    value={mvAmountBaht}
                    onChange={(e) => setMvAmountBaht(e.target.value)}
                    placeholder="จำนวนเงิน (บาท)"
                    className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-right text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                  />
                  <input
                    type="text"
                    value={mvReason}
                    onChange={(e) => setMvReason(e.target.value)}
                    placeholder="หมายเหตุ..."
                    className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRecordMovement()}
                  className="h-[46px] w-full rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium tracking-[0.5px] text-[#1a73e8] hover:border-[#1a73e8] hover:bg-[#e8f0fe]/40 transition-colors cursor-pointer"
                >
                  บันทึกรายการเคลื่อนไหวเงินสดในลิ้นชัก
                </button>
              </div>

              {/* Drawer Movements Log */}
              <div className="divide-y divide-[#dadce0] rounded-[4px] border border-[#dadce0] max-h-60 overflow-y-auto">
                {bootstrap.drawerMovements.length === 0 ? (
                  <div className="py-6 text-center text-xs text-[#5f6368]">
                    ยังไม่มีรายการเคลื่อนไหวเงินสดในลิ้นชักของกะนี้
                  </div>
                ) : (
                  bootstrap.drawerMovements.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between bg-white px-4 py-3 text-xs hover:bg-[#f8f9fa]"
                    >
                      <div className="flex items-center gap-2.5">
                        {m.movementType === 'OPENING_FLOAT' || m.movementType === 'PAID_IN' ? (
                          <ArrowUpCircle className="h-4 w-4 text-[#1a73e8] shrink-0" />
                        ) : (
                          <ArrowDownCircle className="h-4 w-4 text-[#5f6368] shrink-0" />
                        )}
                        <div>
                          <div className="font-medium text-[#202124]">
                            {m.movementType} — {m.reason}
                          </div>
                          <div className="text-[11px] text-[#5f6368] tabular-nums-google">
                            โดย {m.performedByName} · {new Date(m.createdAt).toLocaleTimeString('th-TH')}
                          </div>
                        </div>
                      </div>
                      <div className="text-right tabular-nums-google">
                        <div className="font-google-display text-sm font-medium text-[#202124]">
                          {m.movementType === 'OPENING_FLOAT' || m.movementType === 'PAID_IN' ? '+' : '-'}฿
                          {formatSatangToThbString(m.amountSatang)}
                        </div>
                        <div className="text-[11px] text-[#5f6368]">
                          คงเหลือคาดหวัง ฿{formatSatangToThbString(m.expectedCashAfterSatang)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: Blind Drop Shift Close + 14-Shift USB Backup */}
          <div className="xl:col-span-5 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1a73e8]">
                <LockKeyhole className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-google-display text-[20px] font-normal leading-[28px] text-[#202124]">
                  ปิดกะนับเงินสด (Blind Drop) &amp; สำรอง USB
                </h3>
                <p className="text-xs text-[#5f6368] mt-1">
                  บันทึกไฟล์เข้ารหัส <span className="font-medium text-[#202124]">.part + fsync</span> หมุนเวียน 14 กะอัตโนมัติ
                </p>
              </div>
            </div>

            <div className="rounded-[8px] bg-[#e8f0fe] p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#202124] mb-1.5">
                  ยอดเงินสดในลิ้นชักที่พนักงานนับได้จริง (บาท)
                </label>
                <input
                  type="text"
                  value={countedCashBaht}
                  onChange={(e) => setCountedCashBaht(e.target.value)}
                  className="h-14 w-full rounded-[4px] border border-[#dadce0] bg-white px-4 font-google-display text-[28px] font-normal text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#5f6368] mb-1">
                  บันทึกเพิ่มเติมท้ายกะ
                </label>
                <input
                  type="text"
                  value={closeNotes}
                  onChange={(e) => setCloseNotes(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-xs text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleBlindDropClose()}
              className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] transition-colors cursor-pointer"
            >
              <HardDriveDownload className="h-4 w-4" />
              <span>ยืนยันปิดกะ · ออกใบ Z-Report &amp; สำรองข้อมูล USB</span>
            </button>

            <div className="border-t border-[#dadce0] pt-4">
              <div className="font-google-display text-xs font-medium text-[#202124] mb-2.5">
                ไฟล์สำรองข้อมูลเข้ารหัส 14 กะล่าสุด (USB Ring Buffer)
              </div>
              <div className="divide-y divide-[#dadce0] rounded-[4px] border border-[#dadce0] max-h-48 overflow-y-auto">
                {bootstrap.usbBackups.length === 0 ? (
                  <p className="text-xs text-[#5f6368] py-4 text-center">ยังไม่มีไฟล์สำรองข้อมูล</p>
                ) : (
                  bootstrap.usbBackups.map((b) => (
                    <div
                      key={b.filename}
                      className="bg-[#f8f9fa] px-3.5 py-2 flex items-center justify-between text-xs tabular-nums-google"
                    >
                      <span className="text-[#202124] truncate">{b.filename}</span>
                      <span className="text-[#5f6368] shrink-0 ml-2">
                        {Math.max(1, Math.round(b.sizeBytes / 1024))} KB
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SHIFT Z-REPORT */}
      {reportTab === 'Z_REPORT' && reports && (
        reports.zReport === null ? (
          <div className="rounded-[4px] border border-[#dadce0] bg-white p-10 text-center text-sm text-[#5f6368] max-w-4xl">
            ยังไม่มีข้อมูลกะแคชเชียร์สำหรับออกรายงาน Z-Report
          </div>
        ) : (
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden max-w-4xl">
          <div className="bg-[#000000] p-6 text-white flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.5px] text-white/70">
                End-of-Shift Z-Report Reconciliation · {reports.zReport.shiftNumber} ({reports.zReport.status})
              </div>
              <h3 className="mt-1 font-google-display text-[28px] font-normal leading-[36px] tracking-[-0.25px] text-white">
                รายงานสรุปยอดขายและกระทบยอดเงินสดประจำกะ
              </h3>
            </div>
            <select
              value={selectedShiftIdForZ || reports.zReport.shiftId}
              onChange={(e) => setSelectedShiftIdForZ(e.target.value)}
              className="h-11 rounded-[4px] border border-white/25 bg-white/10 px-3.5 text-xs text-white tabular-nums-google focus:border-[#1a73e8] focus:outline-none cursor-pointer"
            >
              {(reports.shiftsHistory.length > 0 ? reports.shiftsHistory : bootstrap.shiftsHistory).map((s) => (
                <option key={s.id} value={s.id} className="bg-white text-[#202124]">
                  {s.shiftNumber} ({s.status})
                </option>
              ))}
            </select>
          </div>

          <div className="p-6 space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-[4px] border border-[#dadce0] bg-white p-4">
                <div className="text-xs text-[#5f6368]">ยอดขายสุทธิรวม VAT</div>
                <div className="mt-1 font-google-display text-[24px] font-normal text-[#202124] tabular-nums-google">
                  {reports.zReport.netSalesTotalFormatted}
                </div>
              </div>
              <div className="rounded-[4px] border border-[#dadce0] bg-white p-4">
                <div className="text-xs text-[#5f6368]">ภาษีขาย VAT 7%</div>
                <div className="mt-1 font-google-display text-[24px] font-normal text-[#202124] tabular-nums-google">
                  {reports.zReport.vat7PercentFormatted}
                </div>
              </div>
              <div className="rounded-[4px] border border-[#dadce0] bg-white p-4">
                <div className="text-xs text-[#5f6368]">บิลสำเร็จ / ยกเลิก</div>
                <div className="mt-1 font-google-display text-[24px] font-normal text-[#202124] tabular-nums-google">
                  {reports.zReport.completedOrdersCount} / {reports.zReport.voidedOrdersCount}
                </div>
                {reports.zReport.voidedOrdersCount > 0 && (
                  <div className="text-[11px] text-[#5f6368] tabular-nums-google mt-0.5">
                    ยอดยกเลิก {reports.zReport.voidedTotalFormatted}
                  </div>
                )}
              </div>
              <div className="rounded-[4px] border border-[#1a73e8] bg-[#e8f0fe]/40 p-4">
                <div className="text-xs text-[#1a73e8]">ส่วนต่างเงินสด (Variance)</div>
                <div className="mt-1 font-google-display text-[24px] font-normal text-[#202124] tabular-nums-google">
                  {reports.zReport.cashVarianceFormatted ?? 'ยังไม่ปิดกะ'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-5 space-y-2.5">
                <div className="font-google-display text-sm font-medium text-[#202124]">
                  แยกตามช่องทางรับชำระเงิน &amp; ฐานภาษี
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">ยอดขายก่อนส่วนลด (Gross Sales)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.grossSalesFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">ส่วนลดรวม</span>
                  <span className="font-medium text-[#1a73e8] tabular-nums-google">
                    -{reports.zReport.discountsFormatted}
                  </span>
                </div>
                <div className="flex justify-between border-b border-[#dadce0] pb-2">
                  <span className="text-[#5f6368]">มูลค่าขายก่อนภาษี (Net Before Tax)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.netBeforeTaxFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">รับชำระด้วยเงินสด (Cash)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.cashSalesFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">รับชำระด้วย PromptPay QR</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.promptPaySalesFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">รับชำระด้วยบัตรเครดิต / EDC</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.cardSalesFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">คูปองเงินสด (Voucher)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.voucherSalesFormatted}
                  </span>
                </div>
              </div>

              <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-5 space-y-2.5">
                <div className="font-google-display text-sm font-medium text-[#202124]">
                  สมการกระทบยอดเงินสดในลิ้นชัก (Cash Conservation)
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">เงินทอนตั้งต้นเปิดกะ (Opening Float)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.openingCashFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">+ ยอดรับเงินสดจากการขาย (Cash Sales)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    +{reports.zReport.cashSalesFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">+ นำเงินสดเข้าลิ้นชัก (Paid-In)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    +{reports.zReport.paidInFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">- จ่ายเงินสดย่อย (Paid-Out)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    -{reports.zReport.paidOutFormatted}
                  </span>
                </div>
                <div className="flex justify-between border-b border-[#dadce0] pb-2">
                  <span className="text-[#5f6368]">- เก็บเงินเข้าเซฟ (Cash Drop)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    -{reports.zReport.cashDropFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">เงินสดตามสมการบัญชี (Expected)</span>
                  <span className="font-medium text-[#1a73e8] tabular-nums-google">
                    {reports.zReport.expectedDrawerCashFormatted}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5f6368]">เงินสดที่นับได้จริง (Counted)</span>
                  <span className="font-medium text-[#202124] tabular-nums-google">
                    {reports.zReport.countedDrawerCashFormatted ?? '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        )
      )}

      {/* TAB 3: ABB SALES TAX REGISTER */}
      {reportTab === 'ABB_TAX' && reports && (
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          <div className="p-5 border-b border-[#dadce0] bg-[#f8f9fa] flex flex-wrap items-center justify-between gap-4">
            <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
              รายงานภาษีขายใบกำกับภาษีอย่างย่อ (Thai RD ABB VAT 7% Register)
            </h3>
            <div className="flex flex-wrap gap-5 text-xs tabular-nums-google">
              <span className="text-[#5f6368]">
                บิลปกติ / ยกเลิก:{' '}
                <strong className="font-medium text-[#202124]">
                  {reports.abbReport.activeInvoiceCount} / {reports.abbReport.voidedInvoiceCount}
                </strong>
              </span>
              <span className="text-[#5f6368]">
                ฐานภาษีรวม:{' '}
                <strong className="font-medium text-[#202124]">
                  {reports.abbReport.totalTaxableBaseFormatted}
                </strong>
              </span>
              <span className="text-[#5f6368]">
                VAT 7%:{' '}
                <strong className="font-medium text-[#202124]">
                  {reports.abbReport.totalVatFormatted}
                </strong>
              </span>
              <span className="text-[#5f6368]">
                ยอดรวมสุทธิ:{' '}
                <strong className="font-medium text-[#1a73e8]">
                  {reports.abbReport.totalGrossFormatted}
                </strong>
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0]">
                <tr>
                  <th className="py-3 px-4">เลขที่ใบกำกับภาษี ABB</th>
                  <th className="py-3 px-4">เลขที่ใบเสร็จ / เวลา</th>
                  <th className="py-3 px-4">ประเภท / สถานะ</th>
                  <th className="py-3 px-4 text-right">มูลค่าก่อนภาษี</th>
                  <th className="py-3 px-4 text-right">VAT 7%</th>
                  <th className="py-3 px-4 text-right">ยอดสุทธิ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#dadce0] bg-white">
                {reports.abbReport.invoices.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-[#5f6368]">
                      ยังไม่มีรายการใบกำกับภาษีอย่างย่อ (ABB) ในระบบ
                    </td>
                  </tr>
                ) : (
                  reports.abbReport.invoices.map((inv) => (
                    <tr key={inv.abbTaxInvoiceNo} className="hover:bg-[#f8f9fa]">
                      <td className="py-3 px-4 font-medium text-[#202124] tabular-nums-google">
                        {inv.abbTaxInvoiceNo}
                      </td>
                      <td className="py-3 px-4 text-[#5f6368] tabular-nums-google">
                        <div>{inv.receiptNumber}</div>
                        <div className="text-[11px]">
                          {new Date(inv.createdAt).toLocaleString('th-TH')}
                        </div>
                      </td>
                      <td className="py-3 px-4 space-x-1.5">
                        <span className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] px-2 py-0.5 text-[11px] text-[#5f6368]">
                          {inv.orderType}
                        </span>
                        <span
                          className={`rounded-[4px] border px-2 py-0.5 text-[11px] font-medium ${
                            inv.status === 'COMPLETED'
                              ? 'border-[#dadce0] bg-[#f8f9fa] text-[#202124]'
                              : 'border-[#202124] bg-[#202124] text-white'
                          }`}
                        >
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right text-[#202124] tabular-nums-google">
                        {inv.netBeforeTaxFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-[#5f6368] tabular-nums-google">
                        {inv.taxFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-[#202124] tabular-nums-google">
                        {inv.totalFormatted}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: STOCK VALUATION */}
      {reportTab === 'VALUATION' && reports && (
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          <div className="p-5 border-b border-[#dadce0] bg-[#f8f9fa] flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
              รายงานมูลค่าสินค้าและวัตถุดิบคงคลัง (Warehouse Stock Valuation)
            </h3>
            <div className="font-google-display text-lg font-normal text-[#1a73e8] tabular-nums-google">
              มูลค่ารวมทั้งคลัง: {reports.valuationReport.totalWarehouseValuationFormatted}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0]">
                <tr>
                  <th className="py-3 px-4">SKU</th>
                  <th className="py-3 px-4">ชื่อรายการ</th>
                  <th className="py-3 px-4 text-right">สต็อกคงเหลือ</th>
                  <th className="py-3 px-4 text-right">ต้นทุนเฉลี่ย MAC</th>
                  <th className="py-3 px-4 text-right">มูลค่าคงคลังสุทธิ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#dadce0] bg-white">
                {reports.valuationReport.lines.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-[#5f6368]">
                      ยังไม่มีสินค้าหรือวัตถุดิบคงคลังในระบบ
                    </td>
                  </tr>
                ) : (
                  reports.valuationReport.lines.map((l) => (
                    <tr key={l.variantId} className="hover:bg-[#f8f9fa]">
                      <td className="py-3 px-4 text-[#5f6368] tabular-nums-google">{l.sku}</td>
                      <td className="py-3 px-4 font-medium text-[#202124]">{l.itemName}</td>
                      <td className="py-3 px-4 text-right text-[#202124] tabular-nums-google">
                        {l.stockFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-[#5f6368] tabular-nums-google">
                        {l.macFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-[#202124] tabular-nums-google">
                        {l.valuationFormatted}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: MENU GROSS MARGIN & COGS */}
      {reportTab === 'MARGIN' && reports && (
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          <div className="p-5 border-b border-[#dadce0] bg-[#f8f9fa] flex flex-wrap items-center justify-between gap-4">
            <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
              รายงานต้นทุนขายจริง (COGS) และกำไรขั้นต้นรายเมนู (Gross Margin Analysis)
            </h3>
            <div className="flex flex-wrap gap-5 text-xs tabular-nums-google">
              <span className="text-[#5f6368]">
                รายได้รวม:{' '}
                <strong className="font-medium text-[#202124]">
                  {reports.marginReport.totalRevenueFormatted}
                </strong>
              </span>
              <span className="text-[#5f6368]">
                ต้นทุนขาย COGS:{' '}
                <strong className="font-medium text-[#202124]">
                  {reports.marginReport.totalCogsFormatted}
                </strong>
              </span>
              <span className="text-[#5f6368]">
                กำไรขั้นต้น:{' '}
                <strong className="font-medium text-[#1a73e8]">
                  {reports.marginReport.totalGrossProfitFormatted} ({reports.marginReport.totalGrossMarginPercentFormatted})
                </strong>
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0]">
                <tr>
                  <th className="py-3 px-4">รายการที่ขาย</th>
                  <th className="py-3 px-4 text-right">จำนวนขาย</th>
                  <th className="py-3 px-4 text-right">ยอดขายรวม</th>
                  <th className="py-3 px-4 text-right">ต้นทุนวัตถุดิบจริง (COGS)</th>
                  <th className="py-3 px-4 text-right">กำไรขั้นต้น</th>
                  <th className="py-3 px-4 text-right">% GP Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#dadce0] bg-white">
                {reports.marginReport.lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-[#5f6368]">
                      ยังไม่มีรายการขายสำเร็จเพื่อคำนวณกำไรขั้นต้น
                    </td>
                  </tr>
                ) : (
                  reports.marginReport.lines.map((l) => (
                    <tr key={l.variantId} className="hover:bg-[#f8f9fa]">
                      <td className="py-3 px-4 font-medium text-[#202124]">{l.itemName}</td>
                      <td className="py-3 px-4 text-right text-[#5f6368] tabular-nums-google">
                        {l.soldQtyFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-[#202124] tabular-nums-google">
                        {l.revenueFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-[#5f6368] tabular-nums-google">
                        {l.cogsFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-[#202124] tabular-nums-google">
                        {l.grossProfitFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-[#1a73e8] tabular-nums-google">
                        {l.grossMarginPercentFormatted}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
