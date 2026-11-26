import React, { useEffect, useId, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Cpu,
  HardDrive,
  KeyRound,
  Lock,
  Network,
  Printer,
  RefreshCw,
  RotateCcw,
  Shield,
  Sliders,
  UserPlus,
} from 'lucide-react';
import { posTransport } from '../api/pos-transport.ts';
import type {
  BootstrapPayload,
  BusinessProfile,
  DiscoveredStorageDriveDto,
  PrinterTransportMode,
  StaffUserDto,
  UsbBackupConfigStatusDto,
  UserRole,
} from '../types.ts';
import { sanitizePinInput } from '../utils/keyboard-digits.ts';
import { canManageCriticalStoreSettings } from '../utils/rbac.ts';
import { UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface SystemSettingsWorkspaceProps {
  outletId?: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  simulationModeEnabled: boolean;
  onToggleSimulationMode: (enabled: boolean) => void;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const SystemSettingsWorkspace: React.FC<SystemSettingsWorkspaceProps> = ({
  outletId = 'OUTLET-HQ',
  bootstrap,
  currentUser,
  simulationModeEnabled,
  onToggleSimulationMode,
  onRefreshState,
  onToast,
}) => {
  const uid = useId();
  const isOwner = canManageCriticalStoreSettings(currentUser.role);
  const [storeName, setStoreName] = useState(bootstrap.storeSettings.storeName);
  const [taxId, setTaxId] = useState(bootstrap.storeSettings.taxId);
  const [branchCode, setBranchCode] = useState(bootstrap.storeSettings.branchCode);
  const [rdPosRegNo, setRdPosRegNo] = useState(bootstrap.storeSettings.rdPosRegNo);
  const [promptPayId, setPromptPayId] = useState(bootstrap.storeSettings.promptPayId);

  // Staff User Creation / Edit Form
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('CASHIER');
  const [newPin, setNewPin] = useState('');

  // Cluster Pairing
  const [pairingPinInfo, setPairingPinInfo] = useState<{
    pairingPin: string;
    mdnsRecords: string[];
  } | null>(null);

  // Security Audit Logs
  const [auditLogs, setAuditLogs] = useState<
    Awaited<ReturnType<typeof posTransport.listSecurityAuditLogs>>['auditLogs']
  >([]);
  const [busy, setBusy] = useState(false);

  // Physical Thermal Printer & RJ11 Config
  const [prnMode, setPrnMode] = useState<PrinterTransportMode>(bootstrap.printerConfig.mode);
  const [prnHost, setPrnHost] = useState(bootstrap.printerConfig.tcpHost);
  const [prnPort, setPrnPort] = useState(String(bootstrap.printerConfig.tcpPort));
  const [prnWinName, setPrnWinName] = useState(bootstrap.printerConfig.windowsPrinterName);
  const [prnWidthMm, setPrnWidthMm] = useState<80 | 58>(bootstrap.printerConfig.paperWidthMm);
  const [prnAutoDrawer, setPrnAutoDrawer] = useState(bootstrap.printerConfig.autoKickDrawerOnCash);
  const [winPrinters, setWinPrinters] = useState<
    Array<{ name: string; portName: string; isDefault: boolean }>
  >([]);

  // Off-Disk External USB Drive Backup Config
  const [usbDrives, setUsbDrives] = useState<DiscoveredStorageDriveDto[]>([]);
  const [usbBackupCfg, setUsbBackupCfg] = useState<UsbBackupConfigStatusDto | null>(
    bootstrap.usbBackupConfig ?? null
  );
  const [usbDirInput, setUsbDirInput] = useState(
    bootstrap.usbBackupConfig?.customBackupDir ?? ''
  );
  const [mirrorLocalFallback, setMirrorLocalFallback] = useState<boolean>(
    bootstrap.usbBackupConfig?.mirrorToLocalFallback ?? true
  );
  const [scanningDrives, setScanningDrives] = useState(false);

  useEffect(() => {
    setStoreName(bootstrap.storeSettings.storeName);
    setTaxId(bootstrap.storeSettings.taxId);
    setBranchCode(bootstrap.storeSettings.branchCode);
    setRdPosRegNo(bootstrap.storeSettings.rdPosRegNo);
    setPromptPayId(bootstrap.storeSettings.promptPayId);
    setPrnMode(bootstrap.printerConfig.mode);
    setPrnHost(bootstrap.printerConfig.tcpHost);
    setPrnPort(String(bootstrap.printerConfig.tcpPort));
    setPrnWinName(bootstrap.printerConfig.windowsPrinterName);
    setPrnWidthMm(bootstrap.printerConfig.paperWidthMm);
    setPrnAutoDrawer(bootstrap.printerConfig.autoKickDrawerOnCash);
    if (bootstrap.usbBackupConfig) {
      setUsbBackupCfg(bootstrap.usbBackupConfig);
      setUsbDirInput(bootstrap.usbBackupConfig.customBackupDir);
      setMirrorLocalFallback(bootstrap.usbBackupConfig.mirrorToLocalFallback);
    }
  }, [bootstrap.printerConfig, bootstrap.storeSettings, bootstrap.usbBackupConfig]);

  const handleScanUsbDrives = async () => {
    setScanningDrives(true);
    try {
      const res = await posTransport.listUsbBackupDrives();
      setUsbDrives(res.drives);
      setUsbBackupCfg(res.usbBackupConfig);
    } catch {
      // ignore on non-Windows or restricted environments
    } finally {
      setScanningDrives(false);
    }
  };

  useEffect(() => {
    void posTransport.listSecurityAuditLogs(40).then((r) => setAuditLogs(r.auditLogs)).catch(() => {});
    void posTransport
      .listWindowsPrinters()
      .then((r) => setWinPrinters(r.printers))
      .catch(() => {});
    void posTransport
      .listUsbBackupDrives()
      .then((r) => {
        setUsbDrives(r.drives);
        setUsbBackupCfg(r.usbBackupConfig);
      })
      .catch(() => {});
  }, [bootstrap.profile]);

  const handleSavePrinterHardware = async () => {
    setBusy(true);
    try {
      await posTransport.savePrinterConfig({
        mode: prnMode,
        tcpHost: prnHost,
        tcpPort: Number(prnPort || 9100),
        windowsPrinterName: prnWinName,
        paperWidthMm: prnWidthMm,
        autoKickDrawerOnCash: prnAutoDrawer,
      });
      await onRefreshState();
      onToast('บันทึกพอร์ตเครื่องพิมพ์ใบเสร็จและขนาดกระดาษสำเร็จ', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleTestKickDrawer = async () => {
    setBusy(true);
    try {
      const res = await posTransport.kickCashDrawer();
      onToast(
        res.outcome.dispatchedToHardware
          ? `ส่งสัญญาณเตะลิ้นชัก ESC p ออกพอร์ต ${res.outcome.transportMode} สำเร็จ`
          : `จำลองสัญญาณเตะลิ้นชัก ESC p (${res.outcome.transportMode}) สำเร็จ`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchSetupWizard = async () => {
    setBusy(true);
    try {
      await posTransport.setPreviewFirstRunWizard(true);
      await onRefreshState();
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSwitchProfile = async (profile: BusinessProfile) => {
    setBusy(true);
    try {
      await posTransport.switchBusinessProfile(profile, currentUser.id);
      await onRefreshState();
      onToast(`สลับโหมดธุรกิจเป็น ${profile} พร้อมลงนาม HMAC-SHA256 สำเร็จ`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveStoreSettings = async () => {
    setBusy(true);
    try {
      await posTransport.updateStoreSettings({
        outletId,
        storeName,
        taxId,
        branchCode,
        rdPosRegNo,
        promptPayId,
        updatedByUserId: currentUser.id,
      });
      await onRefreshState();
      const logs = await posTransport.listSecurityAuditLogs(40);
      setAuditLogs(logs.auditLogs);
      onToast(
        'บันทึกข้อมูลร้านค้า ใบกำกับภาษี และเลขบัญชี PromptPay (HMAC Guarded) สำเร็จ',
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateOrUpdateStaff = async () => {
    if (!newUsername.trim() || !newDisplayName.trim() || (!editingStaffId && newPin.length < 4)) {
      onToast('กรุณากรอก Username, ชื่อพนักงาน และรหัส PIN 4–8 หลัก', 'warn');
      return;
    }
    if (editingStaffId && newPin && !/^\d{4,8}$/.test(newPin)) {
      onToast('รหัส PIN ใหม่ต้องเป็นตัวเลข 4–8 หลัก (หรือเว้นว่างเพื่อใช้รหัสเดิม)', 'warn');
      return;
    }
    setBusy(true);
    try {
      await posTransport.upsertStaffUser({
        ...(editingStaffId ? { id: editingStaffId } : {}),
        username: newUsername,
        displayName: newDisplayName,
        role: newRole,
        ...(newPin.trim() ? { pin: newPin.trim() } : {}),
        actorUserId: currentUser.id,
      });
      setEditingStaffId(null);
      setNewUsername('');
      setNewDisplayName('');
      setNewPin('');
      await onRefreshState();
      const logs = await posTransport.listSecurityAuditLogs(40);
      setAuditLogs(logs.auditLogs);
      onToast(
        editingStaffId
          ? 'อัปเดตข้อมูลพนักงานและรหัส PIN สำเร็จ'
          : 'เพิ่มบัญชีผู้ใช้งานพนักงานและเข้ารหัส PIN สำเร็จ',
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveUsbBackupConfig = async (overrideCustomDir?: string) => {
    const targetDir = overrideCustomDir !== undefined ? overrideCustomDir : usbDirInput;
    setBusy(true);
    try {
      const res = await posTransport.saveUsbBackupConfig({
        customBackupDir: targetDir,
        mirrorToLocalFallback: mirrorLocalFallback,
      });
      setUsbBackupCfg(res.usbBackupConfig);
      setUsbDirInput(res.usbBackupConfig.customBackupDir);
      await onRefreshState();
      onToast(
        res.usbBackupConfig.isExternalCustomDir
          ? `บันทึกปลายทางสำรองข้อมูลลง "${res.usbBackupConfig.activeEffectiveDir}" สำเร็จ`
          : 'เปลี่ยนกลับใช้โฟลเดอร์สำรองข้อมูลในเครื่องเป็นค่าเริ่มต้นแล้ว',
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRunUsbBackupNow = async () => {
    setBusy(true);
    try {
      const res = await posTransport.runUsbBackupNow();
      setUsbBackupCfg(res.usbBackupConfig);
      await onRefreshState();
      if (res.backupWarningThai) {
        onToast(res.backupWarningThai, 'warn');
      } else {
        onToast(
          `สำรองฐานข้อมูลเข้ารหัสสำเร็จ (${res.usbBackup.retainedBackupsCount}/14 กะล่าสุด)`,
          'success'
        );
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenPairingPin = async () => {
    setBusy(true);
    try {
      const res = await posTransport.openClusterPairingPin();
      setPairingPinInfo({
        pairingPin: res.pairingPin,
        mdnsRecords: res.mdnsAdvertisement.txtRecords,
      });
      await onRefreshState();
      onToast(`เปิดหน้าต่างจับคู่เครื่องลูกข่าย mTLS PIN: ${res.pairingPin}`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Polymorphic Business Profile Selector */}
      <section className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
            <Sliders className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-google-display text-[22px] font-normal leading-[28px] text-ink">
              โหมดรูปแบบธุรกิจอัจฉริยะ (Polymorphic Business Profile · HMAC Protected)
            </h2>
            <p className="text-xs text-ink-muted mt-1">
              ปรับเปลี่ยนหน้าจอขายและเปิด-ปิดฟีเจอร์อัตโนมัติบนฐานข้อมูลชุดเดียวกันโดยข้อมูลไม่สูญหาย
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              id: 'RETAIL' as const,
              title: 'RETAIL (ค้าปลีก / ซูเปอร์มาร์เก็ต)',
              desc: 'เน้นตารางยิงบาร์โค้ดความเร็วสูง + บาร์โค้ดตราชั่งสด Prefix 20–29 ซ่อนหน้าจอครัว KDS และสูตร BOM',
            },
            {
              id: 'HOSPITALITY' as const,
              title: 'HOSPITALITY (คาเฟ่ / ร้านอาหาร)',
              desc: 'เน้นปุ่มเมนูสัมผัส + เลือกความหวาน/ท็อปปิ้งตามบทบาท + ตัดสูตร Multi-Level BOM + ส่งออเดอร์เข้าจอครัว KDS',
            },
            {
              id: 'HYBRID' as const,
              title: 'HYBRID (ร้านค้าผสมครบวงจร)',
              desc: 'เปิดใช้งานครบทุกโมดูล สลับหน้าจอขายได้ทั้งโหมดตารางสแกนเร็วและปุ่มสัมผัสคาเฟ่ในคลิกเดียว',
            },
          ].map((prof) => {
            const active = bootstrap.profile === prof.id;
            return (
              <button
                key={prof.id}
                type="button"
                disabled={busy || !isOwner}
                onClick={() => void handleSwitchProfile(prof.id)}
                className={`rounded-[4px] border p-5 text-left disabled:opacity-60 ${UI_INTERACTION.focusButton} ${
                  active
                    ? 'border-primary bg-primary-soft/50'
                    : 'border-hairline bg-canvas hover:border-primary'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-google-display text-base font-medium text-ink">
                    {prof.title}
                  </span>
                  {active && <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />}
                </div>
                <p className="text-xs text-ink-muted mt-2 leading-relaxed">{prof.desc}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* 1.5 Physical Thermal Printer Port & First-Run Setup Wizard Launcher */}
      <section className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
              <Printer className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-google-display text-[20px] font-normal leading-[28px] text-ink">
                พอร์ตเครื่องพิมพ์ความร้อนจริง (TCP 9100 / Windows Raw USB) &amp; ลิ้นชักเก็บเงิน RJ11
              </h2>
              <p className="text-xs text-ink-muted mt-1">
                รองรับการวาดฟอนต์ไทยผ่าน HTML5 Canvas 203-DPI แปลงเป็น 1-Bit Monochrome Raster (ไม่สระลอย 100%)
              </p>
            </div>
          </div>

          {isOwner && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleLaunchSetupWizard()}
              className={`flex h-[42px] items-center gap-2 rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>เปิดหน้า First-Run Setup Wizard / ส่งออก .recovery-kit</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div>
            <label htmlFor={`${uid}-prn-mode`} className="block text-ink-muted mb-1">
              โหมดการเชื่อมต่อเครื่องพิมพ์
            </label>
            <select
              id={`${uid}-prn-mode`}
              value={prnMode}
              onChange={(e) => setPrnMode(e.target.value as PrinterTransportMode)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              <option value="SIMULATED_MEMORY">จำลองในหน่วยความจำ (Preview)</option>
              <option value="WINDOWS_RAW_USB">สาย USB (Windows Raw Spooler)</option>
              <option value="LAN_TCP_9100">สายแลน LAN (TCP Port 9100)</option>
              <option value="BROWSER_PRINT_DIALOG">Windows Print Dialog (@media print)</option>
            </select>
          </div>

          {prnMode === 'LAN_TCP_9100' && (
            <>
              <div>
                <label htmlFor={`${uid}-prn-host`} className="block text-ink-muted mb-1">
                  IP เครื่องพิมพ์ใบเสร็จ
                </label>
                <input
                  id={`${uid}-prn-host`}
                  type="text"
                  value={prnHost}
                  onChange={(e) => setPrnHost(e.target.value)}
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-prn-port`} className="block text-ink-muted mb-1">
                  พอร์ต TCP
                </label>
                <input
                  id={`${uid}-prn-port`}
                  type="text"
                  value={prnPort}
                  onChange={(e) => setPrnPort(e.target.value)}
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </>
          )}

          {prnMode === 'WINDOWS_RAW_USB' && (
            <div className="md:col-span-2">
              <label htmlFor={`${uid}-prn-win`} className="block text-ink-muted mb-1">
                เลือกเครื่องพิมพ์ USB ใน Windows
              </label>
              {winPrinters.length > 0 ? (
                <select
                  id={`${uid}-prn-win`}
                  value={prnWinName}
                  onChange={(e) => setPrnWinName(e.target.value)}
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value="">-- เลือกเครื่องพิมพ์ --</option>
                  {winPrinters.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} ({p.portName})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${uid}-prn-win`}
                  type="text"
                  placeholder="เช่น XP-80C หรือ EPSON TM-T82"
                  value={prnWinName}
                  onChange={(e) => setPrnWinName(e.target.value)}
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                />
              )}
            </div>
          )}

          <div>
            <label htmlFor={`${uid}-prn-width`} className="block text-ink-muted mb-1">
              ขนาดกระดาษความร้อน
            </label>
            <select
              id={`${uid}-prn-width`}
              value={prnWidthMm}
              onChange={(e) => setPrnWidthMm(Number(e.target.value) === 58 ? 58 : 80)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              <option value={80}>80mm (576 dots @ 203-DPI)</option>
              <option value={58}>58mm (384 dots @ 203-DPI)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-4">
          <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer rounded-[4px] p-1 focus-within:ring-2 focus-within:ring-primary/25">
            <input
              type="checkbox"
              checked={prnAutoDrawer}
              onChange={(e) => setPrnAutoDrawer(e.target.checked)}
              className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
            />
            ส่งสัญญาณพัลส์เปิดลิ้นชักเก็บเงิน RJ11 อัตโนมัติเมื่อรับเงินสด (ESC p 0 25 250)
          </label>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleTestKickDrawer()}
              className={`h-[44px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              ทดสอบเตะลิ้นชัก RJ11
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSavePrinterHardware()}
              className={`h-[44px] rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              บันทึกตั้งค่าเครื่องพิมพ์
            </button>
          </div>
        </div>
      </section>

      {/* 1.8 Off-Disk USB Flash Drive / External Backup Folder Settings */}
      <section className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
              <HardDrive className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-google-display text-[20px] font-normal leading-[28px] text-ink">
                โฟลเดอร์ / แฟลชไดรฟ์ USB สำหรับสำรองฐานข้อมูลอัตโนมัติ (14-Shift Off-Disk Backup)
              </h2>
              <p className="text-xs text-ink-muted mt-1">
                สำรองข้อมูลเข้ารหัส AES-256 อัตโนมัติทุกครั้งที่ปิดกะ — แนะนำให้เลือกแฟลชไดรฟ์ USB ภายนอกหรือไดรฟ์สำรองแยกจากดิสก์หลัก
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {usbBackupCfg?.isExternalCustomDir && usbBackupCfg.targetWritable ? (
              <span className="inline-flex items-center gap-1.5 rounded-[48px] border border-primary bg-primary-soft px-3 py-1 text-xs font-medium text-primary-dark">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>แยกออกนอกโฟลเดอร์หลักแล้ว</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-[48px] border border-hairline bg-surface-1 px-3 py-1 text-xs font-medium text-ink-soft">
                <span>
                  {usbBackupCfg?.isExternalCustomDir && !usbBackupCfg.targetWritable
                    ? 'ไดรฟ์ภายนอกไม่พร้อมใช้งาน (ใช้สำรองในเครื่องชั่วคราว)'
                    : 'ยังเก็บอยู่ในดิสก์เดียวกับฐานข้อมูล — แนะนำเลือก USB ภายนอก'}
                </span>
              </span>
            )}

            <button
              type="button"
              disabled={scanningDrives}
              onClick={() => void handleScanUsbDrives()}
              className={`inline-flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanningDrives ? 'animate-spin' : ''}`} />
              <span>ค้นหาไดรฟ์ใหม่</span>
            </button>
          </div>
        </div>

        {usbDrives.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-ink-muted">
              เลือกด่วนจากไดรฟ์ที่ตรวจพบในเครื่อง (คลิกเพื่อใส่พาธโฟลเดอร์สำรอง):
            </div>
            <div className="flex flex-wrap gap-2">
              {usbDrives.map((d) => {
                const freeGb = Math.round((d.freeBytes / (1024 * 1024 * 1024)) * 10) / 10;
                const isSelected =
                  usbDirInput.trim().toLowerCase() === d.suggestedBackupPath.toLowerCase();
                return (
                  <button
                    key={d.driveLetter}
                    type="button"
                    disabled={!isOwner}
                    onClick={() => setUsbDirInput(d.suggestedBackupPath)}
                    className={`inline-flex min-h-[40px] items-center gap-2 rounded-[48px] border px-3.5 py-1.5 text-xs disabled:opacity-60 ${UI_INTERACTION.focusButton} ${
                      isSelected
                        ? 'border-primary bg-primary-soft text-primary-dark font-medium'
                        : 'border-hairline bg-surface-1 text-ink hover:border-primary'
                    }`}
                  >
                    <span className="font-medium tabular-nums-google">{d.driveLetter}</span>
                    <span className="text-ink-muted">
                      {d.volumeName ? `${d.volumeName} · ` : ''}
                      {d.driveKind === 'REMOVABLE_USB'
                        ? 'USB ภายนอก'
                        : d.driveKind === 'NETWORK_DRIVE'
                          ? 'ไดรฟ์เครือข่าย'
                          : 'ดิสก์ในเครื่อง'}
                    </span>
                    <span className="text-[11px] text-ink-muted tabular-nums-google">
                      ว่าง {freeGb} GB
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end text-xs">
          <div className="lg:col-span-7">
            <label htmlFor={`${uid}-usb-backup-dir`} className="block text-ink-muted mb-1">
              พาธโฟลเดอร์ปลายทางสำหรับไฟล์สำรอง .db.enc (เว้นว่างเพื่อใช้โฟลเดอร์ในเครื่อง)
            </label>
            <input
              id={`${uid}-usb-backup-dir`}
              type="text"
              disabled={!isOwner}
              value={usbDirInput}
              onChange={(e) => setUsbDirInput(e.target.value)}
              placeholder={
                usbBackupCfg?.defaultLocalBackupDir || 'เช่น E:\\RubePOS_Backups หรือ D:\\Backups'
              }
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink placeholder:text-ink-muted disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
            />
          </div>

          <div className="lg:col-span-5 flex flex-wrap items-center justify-end gap-2">
            {isOwner && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveUsbBackupConfig('')}
                  className={`h-[44px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  รีเซ็ตเป็นค่าเริ่มต้น
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveUsbBackupConfig()}
                  className={`h-[44px] rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                >
                  บันทึกปลายทางสำรองข้อมูล
                </button>
              </>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRunUsbBackupNow()}
              className={`h-[44px] rounded-[48px] border border-primary bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
            >
              สำรองข้อมูลเดี๋ยวนี้
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3 text-xs">
          <label className="flex items-center gap-2 text-ink-soft cursor-pointer rounded-[4px] p-1 focus-within:ring-2 focus-within:ring-primary/25">
            <input
              type="checkbox"
              disabled={!isOwner}
              checked={mirrorLocalFallback}
              onChange={(e) => setMirrorLocalFallback(e.target.checked)}
              className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
            />
            สำรองคู่ขนานไว้ในเครื่องด้วยเสมอหากถอดแฟลชไดรฟ์ (Local Fallback Mirror)
          </label>

          {usbBackupCfg && (
            <span className="text-[11px] text-ink-muted truncate max-w-md">
              ใช้งานจริง: {usbBackupCfg.activeEffectiveDir}
            </span>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* 2. Store Identity & PromptPay Settings */}
        <section className="xl:col-span-6 rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2.5">
              <Building2 className="h-5 w-5 text-primary" />
              <span>ข้อมูลกิจการ ใบกำกับภาษี ABB &amp; บัญชี PromptPay</span>
            </h3>
            {!isOwner && (
              <span className="inline-flex items-center gap-1 rounded-[48px] border border-hairline bg-surface-1 px-2.5 py-0.5 text-[11px] font-medium text-ink-muted">
                <Lock className="h-3 w-3" /> แก้ไขได้เฉพาะ OWNER
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-store-name`} className="block text-ink-muted mb-1">
                ชื่อร้านค้าบนหัวใบเสร็จ
              </label>
              <input
                id={`${uid}-store-name`}
                type="text"
                disabled={!isOwner}
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-tax-id`} className="block text-ink-muted mb-1">
                เลขประจำตัวผู้เสียภาษี 13 หลัก
              </label>
              <input
                id={`${uid}-tax-id`}
                type="text"
                disabled={!isOwner}
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-branch-code`} className="block text-ink-muted mb-1">
                รหัสสาขา (00000 = สำนักงานใหญ่)
              </label>
              <input
                id={`${uid}-branch-code`}
                type="text"
                disabled={!isOwner}
                value={branchCode}
                onChange={(e) => setBranchCode(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-rd-reg`} className="block text-ink-muted mb-1">
                เลขทะเบียนเครื่องเก็บเงินกรมสรรพากร
              </label>
              <input
                id={`${uid}-rd-reg`}
                type="text"
                disabled={!isOwner}
                value={rdPosRegNo}
                onChange={(e) => setRdPosRegNo(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-promptpay`} className="block text-primary-dark font-medium mb-1">
                เบอร์ / เลขนิติบุคคล PromptPay (ล็อก HMAC)
              </label>
              <input
                id={`${uid}-promptpay`}
                type="text"
                disabled={!isOwner}
                value={promptPayId}
                onChange={(e) => setPromptPayId(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-primary bg-canvas px-3.5 font-medium text-ink tabular-nums-google disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>
          </div>

          <button
            type="button"
            disabled={busy || !isOwner}
            onClick={() => void handleSaveStoreSettings()}
            className={`h-[46px] w-full rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            บันทึกข้อมูลกิจการ &amp; ลงลายมือชื่อ HMAC-SHA256
          </button>
        </section>

        {/* 3. Staff & RBAC PIN Management */}
        <section className="xl:col-span-6 rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
          <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2.5">
            <UserPlus className="h-5 w-5 text-primary" />
            <span>จัดการพนักงานและสิทธิ์การใช้งาน (RBAC &amp; PIN)</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
            <input
              type="text"
              aria-label="Username พนักงาน"
              placeholder="Username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
            />
            <input
              type="text"
              aria-label="ชื่อที่แสดงของพนักงาน"
              placeholder="ชื่อที่แสดง"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
            />
            <select
              aria-label="บทบาทสิทธิ์พนักงาน"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className={`h-11 rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              <option value="CASHIER">CASHIER</option>
              <option value="MANAGER">MANAGER</option>
              <option value="WAREHOUSE">WAREHOUSE</option>
              <option value="KITCHEN">KITCHEN</option>
              {isOwner && <option value="OWNER">OWNER</option>}
            </select>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              aria-label="รหัส PIN พนักงาน 4 ถึง 8 หลัก"
              placeholder="PIN (4–8 หลัก)"
              value={newPin}
              onChange={(e) => setNewPin(sanitizePinInput(e.target.value))}
              className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleCreateOrUpdateStaff()}
              className={`flex-1 h-[46px] rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              {editingStaffId
                ? 'บันทึกการแก้ไข / ตั้งรหัส PIN ใหม่'
                : '+ เพิ่มพนักงานใหม่'}
            </button>
            {editingStaffId && (
              <button
                type="button"
                onClick={() => {
                  setEditingStaffId(null);
                  setNewUsername('');
                  setNewDisplayName('');
                  setNewRole('CASHIER');
                  setNewPin('');
                }}
                className={`h-[46px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
              >
                ยกเลิกแก้ไข
              </button>
            )}
          </div>

          <div className="divide-y divide-hairline rounded-[4px] border border-hairline max-h-48 overflow-y-auto">
            {bootstrap.staffUsers.length === 0 ? (
              <div className="py-6 text-center text-xs text-ink-muted">
                ยังไม่มีบัญชีผู้ใช้งานพนักงานในระบบ
              </div>
            ) : (
              bootstrap.staffUsers.map((u) => (
                <div
                  key={u.id}
                  className="bg-canvas px-4 py-2.5 flex items-center justify-between gap-2 text-xs hover:bg-surface-1 transition-colors duration-150"
                >
                  <div>
                    <span className="font-medium text-ink">{u.displayName}</span>
                    <span className="text-ink-muted ml-2">@{u.username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-[48px] border border-hairline bg-surface-1 px-2.5 py-0.5 text-[11px] font-medium text-primary-dark">
                      {u.role}
                    </span>
                    {(isOwner || u.role !== 'OWNER') && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingStaffId(u.id);
                          setNewUsername(u.username);
                          setNewDisplayName(u.displayName);
                          setNewRole(u.role);
                          setNewPin('');
                        }}
                        className={`rounded-[48px] border border-hairline bg-canvas px-3 py-1 text-[11px] font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                      >
                        แก้ไข / PIN
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* 4. LAN Cluster & Security Audit Logs */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section className="xl:col-span-5 rounded-[4px] border border-hairline bg-canvas p-6 space-y-4">
          <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2.5">
            <Network className="h-5 w-5 text-primary" />
            <span>คลัสเตอร์วงแลน mDNS &amp; mTLS Pairing</span>
          </h3>
          <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 text-xs space-y-2 tabular-nums-google">
            <div className="flex justify-between">
              <span className="text-ink-muted">โหมดเครือข่าย:</span>
              <span className="font-medium text-ink">{bootstrap.cluster.operatingMode}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">บทบาทโหนด / Epoch:</span>
              <span className="font-medium text-primary-hover">
                {bootstrap.cluster.roleState} (epoch={bootstrap.cluster.currentEpoch})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">สถิติ IPC (Read / Write):</span>
              <span className="font-medium text-ink">
                {bootstrap.cluster.ipcStats.readsRouted} / {bootstrap.cluster.ipcStats.writesRouted}
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleOpenPairingPin()}
            className={`flex h-[46px] w-full items-center justify-center gap-2 rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium tracking-[0.25px] text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
          >
            <KeyRound className="h-4 w-4" />
            <span>เปิดโหมด LAN Cluster &amp; สร้างรหัสจับคู่ 6-Digit mTLS PIN</span>
          </button>

          {pairingPinInfo && (
            <div className="rounded-[8px] bg-primary-soft p-5 text-center space-y-1.5">
              <div className="text-xs text-ink-soft">
                รหัสจับคู่เครื่องลูกข่าย / จอครัว KDS (ใช้ครั้งเดียว)
              </div>
              <div className="font-google-display text-[36px] font-normal tracking-widest text-ink tabular-nums-google">
                {pairingPinInfo.pairingPin}
              </div>
              <div className="text-[11px] text-ink-muted tabular-nums-google">
                mDNS _rube-pos._tcp.local. · {pairingPinInfo.mdnsRecords.join(' | ')}
              </div>
            </div>
          )}
        </section>

        <section className="xl:col-span-7 rounded-[4px] border border-hairline bg-canvas p-6 space-y-4">
          <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-primary" />
            <span>บันทึกเหตุการณ์ความปลอดภัยห้ามลบ/แก้ไข (security_audit_logs)</span>
          </h3>
          <div className="overflow-x-auto max-h-64 rounded-[4px] border border-hairline">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                <tr>
                  <th scope="col" className="py-2.5 px-3">เวลา</th>
                  <th scope="col" className="py-2.5 px-3">เหตุการณ์</th>
                  <th scope="col" className="py-2.5 px-3">ผู้กระทำ</th>
                  <th scope="col" className="py-2.5 px-3">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas tabular-nums-google text-[11px]">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-xs text-ink-muted">
                      ยังไม่มีบันทึกเหตุการณ์ด้านความปลอดภัย
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => {
                    const actorName = log.actorUserId
                      ? (bootstrap.staffUsers.find((u) => u.id === log.actorUserId)?.displayName ??
                        log.actorUserId)
                      : '—';
                    return (
                      <tr key={log.id} className="hover:bg-surface-1 transition-colors duration-150">
                        <td className="py-2.5 px-3 text-ink-muted">
                          {new Date(log.createdAt).toLocaleString('th-TH')}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-ink">{log.eventType}</td>
                        <td className="py-2.5 px-3 text-ink-soft">{actorName}</td>
                        <td className="py-2.5 px-3 text-ink-muted truncate max-w-xs">
                          {log.targetKey ?? '—'}:{' '}
                          {log.oldValueRedacted ? `${log.oldValueRedacted} → ` : ''}
                          {log.newValueRedacted ?? ''}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* 5. Simulation & Hardware-in-the-Loop Developer Toggle (OWNER ONLY) */}
      {isOwner && (
        <section className="rounded-[4px] border border-hairline bg-canvas p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-1 border border-hairline text-primary">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-google-display text-[18px] font-normal text-ink">
                โหมดจำลองฮาร์ดแวร์และปุ่มทดสอบนักพัฒนา (HIL &amp; Demo Controls)
              </h3>
              <p className="text-xs text-ink-muted mt-1 max-w-2xl">
                ปิดเป็นค่าเริ่มต้นในการขายหน้าร้านจริงเพื่อซ่อนปุ่ม HIL Bench, ปุ่มสลิปธนาคารตัวอย่าง, ปุ่มจำลองบาร์โค้ดตราชั่ง และรหัส PIN ทดสอบออกจากหน้าจอแคชเชียร์
              </p>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={simulationModeEnabled}
            onClick={() => {
              const next = !simulationModeEnabled;
              onToggleSimulationMode(next);
              onToast(
                next
                  ? 'เปิดโหมดจำลองฮาร์ดแวร์ (HIL & Demo Controls) สำหรับทดสอบแล้ว'
                  : 'ปิดโหมดจำลองฮาร์ดแวร์แล้ว — หน้าจออยู่ในโหมดขายหน้าร้านจริง',
                next ? 'warn' : 'success'
              );
            }}
            className={`min-h-[44px] rounded-[48px] border px-5 font-google-display text-xs font-medium tracking-[0.25px] ${UI_INTERACTION.focusButton} ${
              simulationModeEnabled
                ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                : 'border-hairline bg-canvas text-ink hover:border-primary hover:text-primary'
            }`}
          >
            {simulationModeEnabled
              ? 'กำลังเปิดโหมดจำลอง (คลิกเพื่อปิดเข้าโหมดขายจริง)'
              : 'ปิดโหมดจำลองอยู่ (คลิกเพื่อเปิดเครื่องมือทดสอบ HIL)'}
          </button>
        </section>
      )}
    </div>
  );
};
