import React, { useState } from 'react';
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
import type { BootstrapPayload, PrintedReceiptPreview } from '../types.ts';

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
  const [customBarcode, setCustomBarcode] = useState('2010045015004');
  const [lastHilLog, setLastHilLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const fireSimulatedScan = async (barcode: string) => {
    setBusy(true);
    try {
      const res = await posTransport.simulateHardwareScan(barcode);
      onInjectScannedBarcodeToPos(barcode);
      const summary = `KeyCode Burst "${barcode}" -> Rollback ภาษาไทย 'ค' สำเร็จ (${res.firstCharRollbackCount} ครั้ง)`;
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
        ? `ใส่กระดาษเครื่องพิมพ์แล้ว · พิมพ์ใบเสร็จค้างคิวอัตโนมัติ ${res.autoFlushedCount} ใบ`
        : 'จำลองฝาเครื่องพิมพ์เปิด / กระดาษหมด · บิลถัดไปจะถูกเก็บเข้าคิว Spooler';
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
      onToast(res.upsBanner.headlineThai, acPresent ? 'success' : 'warn');
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
      onToast('สร้างไฟล์ .part จำลอง USB หลุดกลางคันแล้ว', 'warn');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45">
      <div className="w-full max-w-xl bg-white border-l border-[#dadce0] h-full flex flex-col">
        <div className="flex items-center justify-between border-b border-[#dadce0] px-6 h-16">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1a73e8]">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-google-display text-[18px] font-normal text-[#202124]">
                แผงจำลองฮาร์ดแวร์ (HIL Hardware Bench)
              </h2>
              <p className="text-xs text-[#5f6368]">
                ทดสอบปืนบาร์โค้ดคีย์ไทย, ตราชั่ง EAN-13, เครื่องพิมพ์ 203-DPI, UPS และ USB
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="ปิดแผงจำลองฮาร์ดแวร์"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-white">
          {lastHilLog && (
            <div className="rounded-[8px] bg-[#e8f0fe] px-4 py-3 text-xs text-[#202124]">
              {lastHilLog}
            </div>
          )}

          {/* 1. Barcode & Scale Simulator */}
          <section className="rounded-[4px] border border-[#dadce0] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-google-display text-[16px] font-medium text-[#202124] flex items-center gap-2">
                <ScanBarcode className="h-4 w-4 text-[#1a73e8]" />
                1. ปืนยิงบาร์โค้ด USB &amp; บาร์โค้ดตราชั่งสด
              </h3>
              <span className="text-xs text-[#5f6368]">&lt; 50ms KeyCode</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { title: 'น้ำดื่ม 600ml', code: '8851952350161' },
                { title: 'หมูสามชั้น 1.50 กก.', code: '2010045015004' },
                { title: 'หมูสามชั้น ฿225', code: '2510045225009' },
              ].map((preset) => (
                <button
                  key={preset.code}
                  type="button"
                  disabled={busy}
                  onClick={() => void fireSimulatedScan(preset.code)}
                  className="rounded-[4px] border border-[#dadce0] bg-white p-3 text-left hover:border-[#1a73e8] cursor-pointer"
                >
                  <div className="text-xs font-medium text-[#202124]">{preset.title}</div>
                  <div className="text-[11px] text-[#1a73e8] mt-0.5 tabular-nums-google">
                    {preset.code}
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <input
                type="text"
                value={customBarcode}
                onChange={(e) => setCustomBarcode(e.target.value)}
                className="h-11 flex-1 rounded-[4px] border border-[#dadce0] px-3.5 text-sm text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !customBarcode.trim()}
                onClick={() => void fireSimulatedScan(customBarcode.trim())}
                className="h-11 rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
              >
                ยิงสแกน
              </button>
            </div>
          </section>

          {/* 2. Thermal Printer Spooler */}
          <section className="rounded-[4px] border border-[#dadce0] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-google-display text-[16px] font-medium text-[#202124] flex items-center gap-2">
                <Printer className="h-4 w-4 text-[#1a73e8]" />
                2. เครื่องพิมพ์ใบเสร็จ 203-DPI (Chunked GS v 0)
              </h3>
              <span className="text-xs font-medium text-[#5f6368]">
                {bootstrap.printer.ready
                  ? 'พร้อมพิมพ์'
                  : `กระดาษหมด · ค้าง ${bootstrap.printer.pendingQueueLength} ใบ`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void togglePrinterPaper(false)}
                className="h-11 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#202124] hover:border-[#202124] cursor-pointer"
              >
                จำลองกระดาษหมด / เปิดฝา
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void togglePrinterPaper(true)}
                className="h-11 rounded-[48px] bg-[#1a73e8] px-4 font-google-display text-xs font-medium text-white hover:bg-[#1967d2] cursor-pointer"
              >
                ใส่กระดาษ &amp; พิมพ์คิวค้าง
              </button>
            </div>

            {lastPrintedReceipt && (
              <pre className="thermal-receipt-paper rounded-[4px] p-3.5 text-[11px] leading-relaxed overflow-x-auto max-h-52">
                {lastPrintedReceipt.formattedTextLines.join('\n')}
              </pre>
            )}
          </section>

          {/* 3. UPS Power State */}
          <section className="rounded-[4px] border border-[#dadce0] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-google-display text-[16px] font-medium text-[#202124] flex items-center gap-2">
                <BatteryCharging className="h-4 w-4 text-[#1a73e8]" />
                3. เครื่องสำรองไฟ UPS USB-HID
              </h3>
              <span className="text-xs text-[#5f6368]">
                แบตเตอรี่ {bootstrap.upsBanner.batteryChargePercent}%
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void triggerUps(true, 100)}
                className="flex flex-col items-center gap-1 rounded-[4px] border border-[#dadce0] p-3 text-xs font-medium text-[#202124] hover:border-[#1a73e8] cursor-pointer"
              >
                <BatteryCharging className="h-4 w-4 text-[#1a73e8]" />
                ไฟปกติ (100%)
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void triggerUps(false, 65)}
                className="flex flex-col items-center gap-1 rounded-[4px] border border-[#dadce0] p-3 text-xs font-medium text-[#202124] hover:border-[#1a73e8] cursor-pointer"
              >
                <ZapOff className="h-4 w-4 text-[#5f6368]" />
                ไฟดับ (65%)
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void triggerUps(false, 15)}
                className="flex flex-col items-center gap-1 rounded-[4px] border border-[#dadce0] p-3 text-xs font-medium text-[#202124] hover:border-[#1a73e8] cursor-pointer"
              >
                <BatteryWarning className="h-4 w-4 text-[#202124]" />
                วิกฤต (15%)
              </button>
            </div>
          </section>

          {/* 4. USB Ring Buffer */}
          <section className="rounded-[4px] border border-[#dadce0] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-google-display text-[16px] font-medium text-[#202124] flex items-center gap-2">
                <Usb className="h-4 w-4 text-[#1a73e8]" />
                4. จำลองดึงแฟลชไดรฟ์ USB หลุดกลางคัน
              </h3>
              <span className="text-xs text-[#5f6368]">
                สำรองแล้ว {bootstrap.usbBackups.length}/14 กะ
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void triggerYankUsb()}
              className="h-11 w-full rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
            >
              จำลองดึง USB ออกขณะสำรองข้อมูล (.part)
            </button>
            {bootstrap.usbBackups.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto pt-1">
                {bootstrap.usbBackups.map((f) => (
                  <div
                    key={f.filename}
                    className="flex items-center justify-between rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] px-3 py-1.5 text-xs"
                  >
                    <span className="truncate flex items-center gap-1.5 text-[#202124]">
                      <HardDrive className="h-3.5 w-3.5 text-[#5f6368] shrink-0" />
                      {f.filename}
                    </span>
                    <span className="text-[#5f6368] shrink-0 ml-2 tabular-nums-google">
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
