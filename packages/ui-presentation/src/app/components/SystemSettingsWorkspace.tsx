import React, { useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  KeyRound,
  Network,
  Printer,
  RotateCcw,
  Shield,
  Sliders,
  UserPlus,
} from 'lucide-react';
import { posTransport } from '../api/pos-transport.ts';
import type {
  BootstrapPayload,
  BusinessProfile,
  PrinterTransportMode,
  StaffUserDto,
  UserRole,
} from '../types.ts';

interface SystemSettingsWorkspaceProps {
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const SystemSettingsWorkspace: React.FC<SystemSettingsWorkspaceProps> = ({
  bootstrap,
  currentUser,
  onRefreshState,
  onToast,
}) => {
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
  }, [bootstrap.printerConfig, bootstrap.storeSettings]);

  useEffect(() => {
    void posTransport.listSecurityAuditLogs(40).then((r) => setAuditLogs(r.auditLogs));
    void posTransport
      .listWindowsPrinters()
      .then((r) => setWinPrinters(r.printers))
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
      <section className="rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1a73e8]">
            <Sliders className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-google-display text-[22px] font-normal leading-[28px] text-[#202124]">
              โหมดรูปแบบธุรกิจอัจฉริยะ (Polymorphic Business Profile · HMAC Protected)
            </h2>
            <p className="text-xs text-[#5f6368] mt-1">
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
                disabled={busy}
                onClick={() => void handleSwitchProfile(prof.id)}
                className={`rounded-[4px] border p-5 text-left transition-colors cursor-pointer ${
                  active
                    ? 'border-[#1a73e8] bg-[#e8f0fe]/50'
                    : 'border-[#dadce0] bg-white hover:border-[#1a73e8]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-google-display text-base font-medium text-[#202124]">
                    {prof.title}
                  </span>
                  {active && <CheckCircle2 className="h-5 w-5 text-[#1a73e8] shrink-0" />}
                </div>
                <p className="text-xs text-[#5f6368] mt-2 leading-relaxed">{prof.desc}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* 1.5 Physical Thermal Printer Port & First-Run Setup Wizard Launcher */}
      <section className="rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1a73e8]">
              <Printer className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-google-display text-[20px] font-normal leading-[28px] text-[#202124]">
                พอร์ตเครื่องพิมพ์ความร้อนจริง (TCP 9100 / Windows Raw USB) &amp; ลิ้นชักเก็บเงิน RJ11
              </h2>
              <p className="text-xs text-[#5f6368] mt-1">
                รองรับการวาดฟอนต์ไทยผ่าน HTML5 Canvas 203-DPI แปลงเป็น 1-Bit Monochrome Raster (ไม่สระลอย 100%)
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleLaunchSetupWizard()}
            className="flex h-[42px] items-center gap-2 rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] hover:bg-[#f8f9fa] transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>เปิดหน้า First-Run Setup Wizard / ส่งออก .recovery-kit</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block text-[#5f6368] mb-1">โหมดการเชื่อมต่อเครื่องพิมพ์</label>
            <select
              value={prnMode}
              onChange={(e) => setPrnMode(e.target.value as PrinterTransportMode)}
              className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
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
                <label className="block text-[#5f6368] mb-1">IP เครื่องพิมพ์ใบเสร็จ</label>
                <input
                  type="text"
                  value={prnHost}
                  onChange={(e) => setPrnHost(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">พอร์ต TCP</label>
                <input
                  type="text"
                  value={prnPort}
                  onChange={(e) => setPrnPort(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
            </>
          )}

          {prnMode === 'WINDOWS_RAW_USB' && (
            <div className="md:col-span-2">
              <label className="block text-[#5f6368] mb-1">เลือกเครื่องพิมพ์ USB ใน Windows</label>
              {winPrinters.length > 0 ? (
                <select
                  value={prnWinName}
                  onChange={(e) => setPrnWinName(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
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
                  type="text"
                  placeholder="เช่น XP-80C หรือ EPSON TM-T82"
                  value={prnWinName}
                  onChange={(e) => setPrnWinName(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                />
              )}
            </div>
          )}

          <div>
            <label className="block text-[#5f6368] mb-1">ขนาดกระดาษความร้อน</label>
            <select
              value={prnWidthMm}
              onChange={(e) => setPrnWidthMm(Number(e.target.value) === 58 ? 58 : 80)}
              className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
            >
              <option value={80}>80mm (576 dots @ 203-DPI)</option>
              <option value={58}>58mm (384 dots @ 203-DPI)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#dadce0] pt-4">
          <label className="flex items-center gap-2 text-xs text-[#3c4043] cursor-pointer">
            <input
              type="checkbox"
              checked={prnAutoDrawer}
              onChange={(e) => setPrnAutoDrawer(e.target.checked)}
              className="accent-[#1a73e8]"
            />
            ส่งสัญญาณพัลส์เปิดลิ้นชักเก็บเงิน RJ11 อัตโนมัติเมื่อรับเงินสด (ESC p 0 25 250)
          </label>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleTestKickDrawer()}
              className="h-[44px] rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
            >
              ทดสอบเตะลิ้นชัก RJ11
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSavePrinterHardware()}
              className="h-[44px] rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
            >
              บันทึกตั้งค่าเครื่องพิมพ์
            </button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* 2. Store Identity & PromptPay Settings */}
        <section className="xl:col-span-6 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-5">
          <h3 className="font-google-display text-[20px] font-normal text-[#202124] flex items-center gap-2.5">
            <Building2 className="h-5 w-5 text-[#1a73e8]" />
            <span>ข้อมูลกิจการ ใบกำกับภาษี ABB &amp; บัญชี PromptPay</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="sm:col-span-2">
              <label className="block text-[#5f6368] mb-1">ชื่อร้านค้าบนหัวใบเสร็จ</label>
              <input
                type="text"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[#5f6368] mb-1">เลขประจำตัวผู้เสียภาษี 13 หลัก</label>
              <input
                type="text"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[#5f6368] mb-1">รหัสสาขา (00000 = สำนักงานใหญ่)</label>
              <input
                type="text"
                value={branchCode}
                onChange={(e) => setBranchCode(e.target.value)}
                className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[#5f6368] mb-1">เลขทะเบียนเครื่องเก็บเงินกรมสรรพากร</label>
              <input
                type="text"
                value={rdPosRegNo}
                onChange={(e) => setRdPosRegNo(e.target.value)}
                className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[#1a73e8] font-medium mb-1">
                เบอร์ / เลขนิติบุคคล PromptPay (ล็อก HMAC)
              </label>
              <input
                type="text"
                value={promptPayId}
                onChange={(e) => setPromptPayId(e.target.value)}
                className="h-11 w-full rounded-[4px] border border-[#1a73e8] bg-white px-3.5 font-medium text-[#202124] tabular-nums-google focus:outline-none"
              />
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSaveStoreSettings()}
            className="h-[46px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] transition-colors cursor-pointer"
          >
            บันทึกข้อมูลกิจการ &amp; ลงลายมือชื่อ HMAC-SHA256
          </button>
        </section>

        {/* 3. Staff & RBAC PIN Management */}
        <section className="xl:col-span-6 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-5">
          <h3 className="font-google-display text-[20px] font-normal text-[#202124] flex items-center gap-2.5">
            <UserPlus className="h-5 w-5 text-[#1a73e8]" />
            <span>จัดการพนักงานและสิทธิ์การใช้งาน (RBAC &amp; PIN)</span>
          </h3>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
            <input
              type="text"
              placeholder="Username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
            />
            <input
              type="text"
              placeholder="ชื่อที่แสดง"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
            >
              <option value="CASHIER">CASHIER</option>
              <option value="MANAGER">MANAGER</option>
              <option value="WAREHOUSE">WAREHOUSE</option>
              <option value="KITCHEN">KITCHEN</option>
              <option value="OWNER">OWNER</option>
            </select>
            <input
              type="password"
              placeholder="PIN (4–8 หลัก)"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleCreateOrUpdateStaff()}
              className="flex-1 h-[46px] rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] transition-colors cursor-pointer"
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
                className="h-[46px] rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium text-[#5f6368] hover:border-[#202124] hover:text-[#202124] cursor-pointer"
              >
                ยกเลิกแก้ไข
              </button>
            )}
          </div>

          <div className="divide-y divide-[#dadce0] rounded-[4px] border border-[#dadce0] max-h-48 overflow-y-auto">
            {bootstrap.staffUsers.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#5f6368]">
                ยังไม่มีบัญชีผู้ใช้งานพนักงานในระบบ
              </div>
            ) : (
              bootstrap.staffUsers.map((u) => (
                <div
                  key={u.id}
                  className="bg-white px-4 py-2.5 flex items-center justify-between gap-2 text-xs hover:bg-[#f8f9fa]"
                >
                  <div>
                    <span className="font-medium text-[#202124]">{u.displayName}</span>
                    <span className="text-[#5f6368] ml-2">@{u.username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-[48px] border border-[#dadce0] bg-[#f8f9fa] px-2.5 py-0.5 text-[11px] font-medium text-[#1a73e8]">
                      {u.role}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStaffId(u.id);
                        setNewUsername(u.username);
                        setNewDisplayName(u.displayName);
                        setNewRole(u.role);
                        setNewPin('');
                      }}
                      className="rounded-[48px] border border-[#dadce0] bg-white px-3 py-1 text-[11px] font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
                    >
                      แก้ไข / PIN
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* 4. LAN Cluster & Security Audit Logs */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section className="xl:col-span-5 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-4">
          <h3 className="font-google-display text-[20px] font-normal text-[#202124] flex items-center gap-2.5">
            <Network className="h-5 w-5 text-[#1a73e8]" />
            <span>คลัสเตอร์วงแลน mDNS &amp; mTLS Pairing</span>
          </h3>
          <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-4 text-xs space-y-2 tabular-nums-google">
            <div className="flex justify-between">
              <span className="text-[#5f6368]">โหมดเครือข่าย:</span>
              <span className="font-medium text-[#202124]">{bootstrap.cluster.operatingMode}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#5f6368]">บทบาทโหนด / Epoch:</span>
              <span className="font-medium text-[#1a73e8]">
                {bootstrap.cluster.roleState} (epoch={bootstrap.cluster.currentEpoch})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#5f6368]">สถิติ IPC (Read / Write):</span>
              <span className="font-medium text-[#202124]">
                {bootstrap.cluster.ipcStats.readsRouted} / {bootstrap.cluster.ipcStats.writesRouted}
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleOpenPairingPin()}
            className="flex h-[46px] w-full items-center justify-center gap-2 rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium tracking-[0.25px] text-[#1a73e8] hover:border-[#1a73e8] hover:bg-[#f8f9fa] transition-colors cursor-pointer"
          >
            <KeyRound className="h-4 w-4" />
            <span>เปิดโหมด LAN Cluster &amp; สร้างรหัสจับคู่ 6-Digit mTLS PIN</span>
          </button>

          {pairingPinInfo && (
            <div className="rounded-[8px] bg-[#e8f0fe] p-5 text-center space-y-1.5">
              <div className="text-xs text-[#3c4043]">
                รหัสจับคู่เครื่องลูกข่าย / จอครัว KDS (ใช้ครั้งเดียว)
              </div>
              <div className="font-google-display text-[36px] font-normal tracking-widest text-[#202124] tabular-nums-google">
                {pairingPinInfo.pairingPin}
              </div>
              <div className="text-[11px] text-[#5f6368] tabular-nums-google">
                mDNS _rube-pos._tcp.local. · {pairingPinInfo.mdnsRecords.join(' | ')}
              </div>
            </div>
          )}
        </section>

        <section className="xl:col-span-7 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-4">
          <h3 className="font-google-display text-[20px] font-normal text-[#202124] flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-[#1a73e8]" />
            <span>บันทึกเหตุการณ์ความปลอดภัยห้ามลบ/แก้ไข (security_audit_logs)</span>
          </h3>
          <div className="overflow-x-auto max-h-64 rounded-[4px] border border-[#dadce0]">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0]">
                <tr>
                  <th className="py-2.5 px-3">เวลา</th>
                  <th className="py-2.5 px-3">เหตุการณ์</th>
                  <th className="py-2.5 px-3">ผู้กระทำ</th>
                  <th className="py-2.5 px-3">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#dadce0] bg-white tabular-nums-google text-[11px]">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-xs text-[#5f6368]">
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
                      <tr key={log.id} className="hover:bg-[#f8f9fa]">
                        <td className="py-2.5 px-3 text-[#5f6368]">
                          {new Date(log.createdAt).toLocaleString('th-TH')}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-[#202124]">{log.eventType}</td>
                        <td className="py-2.5 px-3 text-[#3c4043]">{actorName}</td>
                        <td className="py-2.5 px-3 text-[#5f6368] truncate max-w-xs">
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
    </div>
  );
};
