import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  BatteryCharging,
  BatteryWarning,
  Cpu,
  HardDrive,
  Printer,
  ScanBarcode,
  Usb,
  X,
  ZapOff,
} from 'lucide-react';
import { posTransport } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type { BootstrapPayload, PrintedReceiptPreview } from '../types.ts';
import {
  getModalZIndex,
  handleModalFocusTrapKeyDown,
  isTopmostModal,
  pushModalEntry,
  removeModalEntry,
  subscribeModalStack,
  UI_INTERACTION,
} from './ui/UiPrimitives.tsx';

interface HilSimulatorDrawerProps {
  open: boolean;
  onClose: () => void;
  bootstrap: BootstrapPayload;
  lastPrintedReceipt: PrintedReceiptPreview | null;
  onInjectScannedBarcodeToPos: (barcode: string) => void;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const HilSimulatorDrawer: React.FC<HilSimulatorDrawerProps> = ({
  open,
  onClose,
  bootstrap,
  lastPrintedReceipt,
  onInjectScannedBarcodeToPos,
  onRefreshState,
  onToast,
}) => {
  const modalIdRef = useRef<symbol | null>(null);
  if (!modalIdRef.current) {
    modalIdRef.current = Symbol('HilSimulatorDrawer');
  }
  const modalId = modalIdRef.current;

  const uid = useId();
  const { countryCode, pick } = useI18n();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [zIndex, setZIndex] = useState<number>(50);
  const [isTopmost, setIsTopmost] = useState<boolean>(true);
  const [customBarcode, setCustomBarcode] = useState('2010045015004');
  const [lastHilLog, setLastHilLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const syncStackState = () => {
      const nextZ = getModalZIndex(modalId);
      const nextTop = isTopmostModal(modalId);
      setZIndex((prev) => (prev === nextZ ? prev : nextZ));
      setIsTopmost((prev) => (prev === nextTop ? prev : nextTop));
    };

    const unsubscribe = subscribeModalStack(syncStackState);
    pushModalEntry(modalId, 50);
    syncStackState();

    return () => {
      unsubscribe();
      removeModalEntry(modalId);
    };
  }, [modalId, open]);

  useEffect(() => {
    if (!open) return;
    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = window.setTimeout(() => {
      if (
        isTopmostModal(modalId) &&
        drawerRef.current &&
        !drawerRef.current.contains(document.activeElement)
      ) {
        drawerRef.current.focus({ preventScroll: true });
      }
    }, 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isTopmostModal(modalId)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        if (!isTopmostModal(modalId)) return;
        handleModalFocusTrapKeyDown(e, drawerRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      if (prevFocusRef.current && document.contains(prevFocusRef.current)) {
        prevFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [modalId, open]);

  if (!open) return null;

  const fireSimulatedScan = async (barcode: string) => {
    setBusy(true);
    try {
      const res = await posTransport.simulateHardwareScan(barcode);
      onInjectScannedBarcodeToPos(barcode);
      const summary = pick(
        `KeyCode Burst "${barcode}" -> Rollback ภาษาไทย 'ค' สำเร็จ (${res.firstCharRollbackCount} ครั้ง)`,
        `KeyCode Burst "${barcode}" -> Rollback ພາສາໄທ 'ຄ' ສຳເລັດ (${res.firstCharRollbackCount} ຄັ້ງ)`,
        `KeyCode Burst "${barcode}" -> Thai/Lao layout rollback succeeded (${res.firstCharRollbackCount}x)`
      );
      setLastHilLog(summary);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const togglePrinterPaper = async (ready: boolean) => {
    setBusy(true);
    try {
      const res = await posTransport.setPrinterReadyState(ready);
      await onRefreshState();
      const msg = ready
        ? pick(
            `ใส่กระดาษเครื่องพิมพ์แล้ว · พิมพ์ใบเสร็จค้างคิวอัตโนมัติ ${res.autoFlushedCount} ใบ`,
            `ໃສ່ກະດາດເຄື່ອງພິມແລ້ວ · ພິມໃບບິນຄ້າງຄິວອັດຕະໂນມັດ ${res.autoFlushedCount} ໃບ`,
            `Printer paper loaded · Auto-flushed ${res.autoFlushedCount} queued receipt(s)`
          )
        : pick(
            'จำลองฝาเครื่องพิมพ์เปิด / กระดาษหมด · บิลถัดไปจะถูกเก็บเข้าคิว Spooler',
            'ຈຳລອງຝາເຄື່ອງພິມເປີດ / ກະດາດໝົດ · ບິນຖັດໄປຈະຖືກເກັບເຂົ້າຄິວ Spooler',
            'Simulated cover open / paper out · Next receipts will queue in spooler'
          );
      setLastHilLog(msg);
      onToast(msg, ready ? 'success' : 'warn');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const triggerUps = async (acPresent: boolean, batteryChargePercent: number) => {
    setBusy(true);
    try {
      const res = await posTransport.setUpsPowerState({ acPresent, batteryChargePercent });
      await onRefreshState();
      setLastHilLog(`UPS State -> ${res.protectionState} (${batteryChargePercent}%)`);
      const upsToast =
        res.upsBanner.severity === 'NONE'
          ? pick(
              `ไฟ AC ปกติ (${res.upsBanner.batteryChargePercent}%)`,
              `ໄຟ AC ປົກກະຕິ (${res.upsBanner.batteryChargePercent}%)`,
              `AC power normal (${res.upsBanner.batteryChargePercent}%)`
            )
          : res.upsBanner.severity === 'CRITICAL_LOW_BATTERY_LOCK'
            ? pick(
                `วิกฤตไฟดับ UPS! แบต ${res.upsBanner.batteryChargePercent}% — กำลังป้องกันข้อมูลก่อนปิดระบบ`,
                `ວິກິດໄຟດັບ UPS! ແບັດ ${res.upsBanner.batteryChargePercent}% — ກຳລັງປ້ອງກັນຂໍ້ມູນກ່ອນປິດລະບົບ`,
                `CRITICAL UPS POWER LOSS! Battery ${res.upsBanner.batteryChargePercent}% — Protecting transactions`
              )
            : pick(
                `แจ้งเตือนไฟดับ: กำลังใช้ไฟสำรอง UPS (${res.upsBanner.batteryChargePercent}%)`,
                `ແຈ້ງເຕືອນໄຟດັບ: ກຳລັງໃຊ້ໄຟສຳຮອງ UPS (${res.upsBanner.batteryChargePercent}%)`,
                `Power outage: Running on UPS battery (${res.upsBanner.batteryChargePercent}%)`
              );
      onToast(upsToast, acPresent ? 'success' : 'warn');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const triggerYankUsb = async () => {
    setBusy(true);
    try {
      const res = await posTransport.simulateYankUsb();
      await onRefreshState();
      setLastHilLog(`${res.message} -> ${res.corruptFilename}`);
      onToast(
        pick(
          'สร้างไฟล์ .part จำลอง USB หลุดกลางคันแล้ว',
          'ສ້າງໄຟລ໌ .part ຈຳລອງ USB ຫຼຸດກາງຄັນແລ້ວ',
          'Simulated interrupted .part USB backup file created'
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
    <div
      data-rube-modal-backdrop="true"
      style={{ zIndex }}
      className="fixed inset-0 flex justify-end bg-black/45 transition-opacity duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-hil-title`}
        data-rube-modal-topmost={isTopmost ? 'true' : 'false'}
        tabIndex={-1}
        className="w-full max-w-xl bg-canvas border-l border-hairline h-full flex flex-col focus:outline-none"
      >
        <div className="flex items-center justify-between border-b border-hairline px-6 h-16 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
              <Cpu className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id={`${uid}-hil-title`} className="font-google-display text-[18px] font-normal text-ink truncate">
                {pick(
                  'แผงจำลองฮาร์ดแวร์ (HIL Hardware Bench)',
                  'ແຜງຈຳລອງຮາດແວ (HIL Hardware Bench)',
                  'HIL Hardware Simulator Bench'
                )}
              </h2>
              <p className="text-xs text-ink-muted truncate">
                {pick(
                  'ทดสอบปืนบาร์โค้ดคีย์ไทย, ตราชั่ง EAN-13, เครื่องพิมพ์ 203-DPI, UPS และ USB',
                  'ທົດສອບປືນບາໂຄດ, ຊິງຊັ່ງ EAN-13, ເຄື່ອງພິມ 203-DPI, UPS ແລະ USB',
                  'Test HID barcode scanner, EAN-13 scale, 203-DPI printer, UPS & USB'
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={pick('ปิดแผงจำลองฮาร์ดแวร์', 'ປິດແຜງຈຳລອງຮາດແວ', 'Close hardware simulator drawer')}
            onClick={onClose}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-canvas">
          {lastHilLog && (
            <div role="status" className="rounded-[8px] bg-primary-soft px-4 py-3 text-xs text-ink">
              {lastHilLog}
            </div>
          )}

          {/* 1. Barcode & Scale Simulator */}
          <section className="rounded-[4px] border border-hairline p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-google-display text-[16px] font-medium text-ink flex items-center gap-2">
                <ScanBarcode className="h-4 w-4 text-primary shrink-0" />
                {pick(
                  '1. ปืนยิงบาร์โค้ด USB & บาร์โค้ดตราชั่งสด',
                  '1. ປືນຍິງບາໂຄດ USB & ບາໂຄດຊິງຊັ່ງສົດ',
                  '1. USB Barcode Scanner & Fresh Scale Barcodes'
                )}
              </h3>
              <span className="text-xs text-ink-muted shrink-0">&lt; 50ms KeyCode</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(countryCode === 'LA'
                ? [
                    {
                      title: pick('น้ำดื่ม 600ml', 'ນ້ຳດື່ມ 600ml', 'Drinking Water 600ml'),
                      code: '8851952350161',
                    },
                    {
                      title: pick('หมูสามชั้น 1.50 กก.', 'ຊີ້ນໝູສາມຊັ້ນ 1.50 ກກ.', 'Pork Belly 1.50 kg'),
                      code: '2010045015004',
                    },
                    {
                      title: pick('หมูสามชั้น 150,000 ₭', 'ຊີ້ນໝູສາມຊັ້ນ 150,000 ₭', 'Pork Belly 150,000 ₭'),
                      code: '2510045015009',
                    },
                  ]
                : [
                    {
                      title: pick('น้ำดื่ม 600ml', 'ນ້ຳດື່ມ 600ml', 'Drinking Water 600ml'),
                      code: '8851952350161',
                    },
                    {
                      title: pick('หมูสามชั้น 1.50 กก.', 'ຊີ້ນໝູສາມຊັ້ນ 1.50 ກກ.', 'Pork Belly 1.50 kg'),
                      code: '2010045015004',
                    },
                    {
                      title: pick('หมูสามชั้น ฿225', 'ຊີ້ນໝູສາມຊັ້ນ ฿225', 'Pork Belly ฿225'),
                      code: '2510045225009',
                    },
                  ]
              ).map((preset) => (
                <button
                  key={preset.code}
                  type="button"
                  disabled={busy}
                  onClick={() => void fireSimulatedScan(preset.code)}
                  className={`rounded-[4px] border border-hairline bg-canvas p-3 text-left hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <div className="text-xs font-medium text-ink">{preset.title}</div>
                  <div className="text-[11px] text-primary-hover mt-0.5 tabular-nums-google">
                    {preset.code}
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <input
                type="text"
                aria-label={pick(
                  'รหัสบาร์โค้ดสำหรับจำลองยิงสแกน',
                  'ລະຫັດບາໂຄດສຳລັບຈຳລອງຍິງສະແກນ',
                  'Barcode for simulated scan'
                )}
                value={customBarcode}
                onChange={(e) => setCustomBarcode(e.target.value)}
                className={`h-11 flex-1 rounded-[4px] border border-hairline px-3.5 text-sm text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
              />
              <button
                type="button"
                disabled={busy || !customBarcode.trim()}
                onClick={() => void fireSimulatedScan(customBarcode.trim())}
                className={`h-11 rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ยิงสแกน', 'ຍິງສະແກນ', 'Scan')}
              </button>
            </div>
          </section>

          {/* 2. Thermal Printer Spooler */}
          <section className="rounded-[4px] border border-hairline p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-google-display text-[16px] font-medium text-ink flex items-center gap-2">
                <Printer className="h-4 w-4 text-primary shrink-0" />
                {pick(
                  '2. เครื่องพิมพ์ใบเสร็จ 203-DPI (Chunked GS v 0)',
                  '2. ເຄື່ອງພິມໃບບິນ 203-DPI (Chunked GS v 0)',
                  '2. 203-DPI Thermal Printer (Chunked GS v 0)'
                )}
              </h3>
              <span className="text-xs font-medium text-ink-muted">
                {bootstrap.printer.ready
                  ? pick('พร้อมพิมพ์', 'ພ້ອມພິມ', 'Ready')
                  : pick(
                      `กระดาษหมด · ค้าง ${bootstrap.printer.pendingQueueLength} ใบ`,
                      `ກະດາດໝົດ · ຄ້າງ ${bootstrap.printer.pendingQueueLength} ໃບ`,
                      `Paper out · ${bootstrap.printer.pendingQueueLength} queued`
                    )}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void togglePrinterPaper(false)}
                className={`h-11 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink hover:border-ink hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                {pick('จำลองกระดาษหมด / เปิดฝา', 'ຈຳລອງກະດາດໝົດ / ເປີດຝາ', 'Simulate Paper Out / Cover Open')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void togglePrinterPaper(true)}
                className={`h-11 rounded-[48px] bg-primary px-4 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ใส่กระดาษ & พิมพ์คิวค้าง', 'ໃສ່ກະດາດ & ພິມຄິວຄ້າງ', 'Load Paper & Flush Queue')}
              </button>
            </div>

            {lastPrintedReceipt && (
              <pre className="thermal-receipt-paper rounded-[4px] p-3.5 text-[11px] leading-relaxed overflow-x-auto max-h-52">
                {lastPrintedReceipt.formattedTextLines.join('\n')}
              </pre>
            )}
          </section>

          {/* 3. UPS Power State */}
          <section className="rounded-[4px] border border-hairline p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-google-display text-[16px] font-medium text-ink flex items-center gap-2">
                <BatteryCharging className="h-4 w-4 text-primary shrink-0" />
                {pick('3. เครื่องสำรองไฟ UPS USB-HID', '3. ເຄື່ອງສຳຮອງໄຟ UPS USB-HID', '3. UPS USB-HID Battery Backup')}
              </h3>
              <span className="text-xs text-ink-muted shrink-0">
                {pick(
                  `แบตเตอรี่ ${bootstrap.upsBanner.batteryChargePercent}%`,
                  `ແບັດເຕີຣີ ${bootstrap.upsBanner.batteryChargePercent}%`,
                  `Battery ${bootstrap.upsBanner.batteryChargePercent}%`
                )}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void triggerUps(true, 100)}
                className={`flex flex-col items-center gap-1 rounded-[4px] border border-hairline p-3 text-xs font-medium text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <BatteryCharging className="h-4 w-4 text-primary" />
                {pick('ไฟปกติ (100%)', 'ໄຟປົກກະຕິ (100%)', 'AC Normal (100%)')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void triggerUps(false, 65)}
                className={`flex flex-col items-center gap-1 rounded-[4px] border border-hairline p-3 text-xs font-medium text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <ZapOff className="h-4 w-4 text-ink-muted" />
                {pick('ไฟดับ (65%)', 'ໄຟດັບ (65%)', 'On Battery (65%)')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void triggerUps(false, 15)}
                className={`flex flex-col items-center gap-1 rounded-[4px] border border-hairline p-3 text-xs font-medium text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <BatteryWarning className="h-4 w-4 text-ink" />
                {pick('วิกฤต (15%)', 'ວິກິດ (15%)', 'Critical (15%)')}
              </button>
            </div>
          </section>

          {/* 4. USB Ring Buffer */}
          <section className="rounded-[4px] border border-hairline p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-google-display text-[16px] font-medium text-ink flex items-center gap-2">
                <Usb className="h-4 w-4 text-primary shrink-0" />
                {pick(
                  '4. จำลองดึงแฟลชไดรฟ์ USB หลุดกลางคัน',
                  '4. ຈຳລອງດຶງແຟລຊໄດຣຟ໌ USB ຫຼຸດກາງຄັນ',
                  '4. Simulate USB Flash Yank (.part Recovery)'
                )}
              </h3>
              <span className="text-xs text-ink-muted">
                {pick(
                  `สำรองแล้ว ${bootstrap.usbBackups.length}/14 กะ`,
                  `ສຳຮອງແລ້ວ ${bootstrap.usbBackups.length}/14 ກະ`,
                  `Backed up ${bootstrap.usbBackups.length}/14 shifts`
                )}
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void triggerYankUsb()}
              className={`h-11 w-full rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              {pick(
                'จำลองดึง USB ออกขณะสำรองข้อมูล (.part)',
                'ຈຳລອງດຶງ USB ອອກຂະນະສຳຮອງຂໍ້ມູນ (.part)',
                'Simulate USB Pull During Backup (.part)'
              )}
            </button>
            {bootstrap.usbBackups.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto pt-1">
                {bootstrap.usbBackups.map((f) => (
                  <div
                    key={f.filename}
                    className="flex items-center justify-between rounded-[4px] border border-hairline bg-surface-1 px-3 py-1.5 text-xs"
                  >
                    <span className="truncate flex items-center gap-1.5 text-ink">
                      <HardDrive className="h-3.5 w-3.5 text-ink-muted shrink-0" />
                      {f.filename}
                    </span>
                    <span className="text-ink-muted shrink-0 ml-2 tabular-nums-google">
                      {Math.max(1, Math.round(f.sizeBytes / 1024))} KB
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
