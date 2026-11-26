import React, { useEffect, useId, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Download,
  KeyRound,
  Printer,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { parseDecimalStringToScaledInt } from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type {
  BusinessProfile,
  PrinterHardwareConfigDto,
  PrinterTransportMode,
  StaffUserDto,
  StoreIdentitySettingsDto,
} from '../types.ts';
import { sanitizePinInput } from '../utils/keyboard-digits.ts';
import { UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface FirstRunWizardModalProps {
  open: boolean;
  isPreviewMode?: boolean | undefined;
  initialStoreSettings?: StoreIdentitySettingsDto | undefined;
  initialPrinterConfig?: PrinterHardwareConfigDto | undefined;
  onCompleted: (ownerUser: StaffUserDto) => Promise<void>;
  onCancelPreview?: (() => Promise<void>) | undefined;
}

export const FirstRunWizardModal: React.FC<FirstRunWizardModalProps> = ({
  open,
  isPreviewMode = false,
  initialStoreSettings,
  initialPrinterConfig,
  onCompleted,
  onCancelPreview,
}) => {
  const uid = useId();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>(
    initialStoreSettings?.businessProfile ?? 'HYBRID'
  );
  const [storeName, setStoreName] = useState(
    initialStoreSettings?.storeName || 'ร้านค้าของฉัน (My Store)'
  );
  const [taxId, setTaxId] = useState(initialStoreSettings?.taxId || '0105566009999');
  const [branchCode, setBranchCode] = useState(initialStoreSettings?.branchCode || '00000');
  const [rdPosRegNo, setRdPosRegNo] = useState(initialStoreSettings?.rdPosRegNo || 'RD-POS-0001');
  const [promptPayId, setPromptPayId] = useState(
    initialStoreSettings?.promptPayId || '0812345678'
  );
  const [loadDemoSampleCatalog, setLoadDemoSampleCatalog] = useState(false);

  // Step 2: Owner Account & Recovery Passphrase
  const [ownerDisplayName, setOwnerDisplayName] = useState('เจ้าของร้าน (Owner)');
  const [ownerUsername, setOwnerUsername] = useState('owner');
  const [ownerPin, setOwnerPin] = useState('');
  const [ownerPinConfirm, setOwnerPinConfirm] = useState('');
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('RUBE-RECOVERY-2026-SAFE');

  // Step 3: Printer & Initial Opening Float
  const [printerMode, setPrinterMode] = useState<PrinterTransportMode>(
    initialPrinterConfig?.mode ?? 'WINDOWS_RAW_USB'
  );
  const [tcpHost, setTcpHost] = useState(initialPrinterConfig?.tcpHost || '192.168.1.200');
  const [tcpPort, setTcpPort] = useState(String(initialPrinterConfig?.tcpPort ?? 9100));
  const [windowsPrinterName, setWindowsPrinterName] = useState(
    initialPrinterConfig?.windowsPrinterName ?? ''
  );
  const [discoveredPrinters, setDiscoveredPrinters] = useState<
    Array<{ name: string; portName: string; isDefault: boolean }>
  >([]);
  const [paperWidthMm, setPaperWidthMm] = useState<80 | 58>(
    initialPrinterConfig?.paperWidthMm === 58 ? 58 : 80
  );
  const [openingCashBaht, setOpeningCashBaht] = useState('1000.00');

  // Step 4: Generated Recovery Kit
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [completedData, setCompletedData] = useState<{
    ownerUser: StaffUserDto;
    recoveryKitFilename: string;
    recoveryKitContent: string;
  } | null>(null);
  const [downloadedKit, setDownloadedKit] = useState(false);

  useEffect(() => {
    if (!open || !initialStoreSettings?.storeName) return;
    setBusinessProfile(initialStoreSettings.businessProfile);
    setStoreName(initialStoreSettings.storeName);
    setTaxId(initialStoreSettings.taxId);
    setBranchCode(initialStoreSettings.branchCode);
    setRdPosRegNo(initialStoreSettings.rdPosRegNo);
    setPromptPayId(initialStoreSettings.promptPayId);
  }, [open, initialStoreSettings]);

  useEffect(() => {
    if (!open || !initialPrinterConfig) return;
    setPrinterMode(initialPrinterConfig.mode);
    setTcpHost(initialPrinterConfig.tcpHost);
    setTcpPort(String(initialPrinterConfig.tcpPort));
    setPaperWidthMm(initialPrinterConfig.paperWidthMm);
    if (initialPrinterConfig.windowsPrinterName) {
      setWindowsPrinterName(initialPrinterConfig.windowsPrinterName);
    }
  }, [open, initialPrinterConfig]);

  useEffect(() => {
    if (!open) return;
    void posTransport
      .listWindowsPrinters()
      .then((res) => {
        setDiscoveredPrinters(res.printers);
        const def = res.printers.find((p) => p.isDefault) ?? res.printers[0];
        if (def && !windowsPrinterName) {
          setWindowsPrinterName(def.name);
        }
      })
      .catch(() => {});
  }, [open, windowsPrinterName]);

  if (!open) return null;

  const handleStep1Next = () => {
    const cleanPp = promptPayId.replace(/\D/g, '');
    if (!storeName.trim()) {
      setErrorMsg('กรุณากรอกชื่อร้านค้า');
      return;
    }
    if (cleanPp.length !== 10 && cleanPp.length !== 13 && cleanPp.length !== 15) {
      setErrorMsg('หมายเลข PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก');
      return;
    }
    setErrorMsg(null);
    setStep(2);
  };

  const handleStep2Next = () => {
    if (!/^\d{4,8}$/.test(ownerPin)) {
      setErrorMsg('รหัส PIN เจ้าของร้านต้องเป็นตัวเลข 4–8 หลัก');
      return;
    }
    if (ownerPin !== ownerPinConfirm) {
      setErrorMsg('รหัส PIN ทั้งสองช่องไม่ตรงกัน');
      return;
    }
    if (recoveryPassphrase.trim().length < 12) {
      setErrorMsg('รหัสวลีกู้คืนฉุกเฉิน (Recovery Passphrase) ต้องยาวอย่างน้อย 12 ตัวอักษร');
      return;
    }
    setErrorMsg(null);
    setStep(3);
  };

  const handleCompleteSetup = async () => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const openingCashSatang = Math.max(
        0,
        parseDecimalStringToScaledInt(openingCashBaht || '0', 2)
      );
      const printerConfig: PrinterHardwareConfigDto = {
        mode: printerMode,
        tcpHost: tcpHost.trim() || '192.168.1.200',
        tcpPort: Number(tcpPort || 9100),
        windowsPrinterName,
        paperWidthMm,
        autoKickDrawerOnCash: true,
      };

      const res = await posTransport.completeFirstRunOnboarding({
        businessProfile,
        storeName,
        taxId,
        branchCode,
        rdPosRegNo,
        promptPayId,
        ownerDisplayName,
        ownerUsername,
        ownerPin,
        recoveryPassphrase,
        loadDemoSampleCatalog,
        openingCashSatang,
        printerConfig,
      });

      setCompletedData({
        ownerUser: res.ownerUser,
        recoveryKitFilename: res.recoveryKitFilename,
        recoveryKitContent: res.recoveryKitContent,
      });
      setStep(4);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const triggerDownloadRecoveryKit = () => {
    if (!completedData) return;
    const blob = new Blob([completedData.recoveryKitContent], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = completedData.recoveryKitFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloadedKit(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${uid}-wizard-title`}
      className="fixed inset-0 z-50 overflow-y-auto bg-canvas text-ink"
    >
      {/* Near-Black Hero Header (`google.design.md` hero-section) */}
      <div className="bg-hero text-white px-6 py-10">
        <div className="max-w-3xl mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-[0.5px] text-white/75">
              {isPreviewMode
                ? 'RUBE-STOCK-POS v3.1 · Re-Configure Store & Export .recovery-kit'
                : 'RUBE-STOCK-POS v3.1 · Production Clean-Start Setup'}
            </div>
            {onCancelPreview && (
              <button
                type="button"
                onClick={() => void onCancelPreview()}
                className={`rounded-[48px] border border-white/25 bg-white/10 px-4 py-1.5 font-google-display text-xs font-medium text-white hover:bg-white/20 ${UI_INTERACTION.focusButton}`}
              >
                ยกเลิก / กลับสู่หน้าขาย
              </button>
            )}
          </div>
          <h1
            id={`${uid}-wizard-title`}
            className="mt-2 font-google-display text-[30px] sm:text-[44px] font-normal leading-[38px] sm:leading-[48px] tracking-[-0.5px]"
          >
            ตั้งค่าเริ่มต้นสำหรับเครื่องจุดขายจริง
          </h1>
          <p className="mt-2 text-sm text-white/75 max-w-xl">
            กำหนดข้อมูลกิจการ รหัส PIN เจ้าของร้าน เครื่องพิมพ์ใบเสร็จความร้อน และสร้างกุญแจกู้คืนฉุกเฉินแบบออฟไลน์ 100%
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2 text-xs">
            {[
              { n: 1, label: '1. ข้อมูลร้านค้า' },
              { n: 2, label: '2. รหัสเจ้าของร้าน' },
              { n: 3, label: '3. เครื่องพิมพ์ & กะแรก' },
              { n: 4, label: '4. ไฟล์กู้คืน .recovery-kit' },
            ].map((s) => (
              <span
                key={s.n}
                className={`rounded-[48px] px-3.5 py-1.5 font-google-display font-medium ${
                  step === s.n
                    ? 'bg-primary text-white'
                    : step > s.n
                      ? 'bg-white/15 text-white'
                      : 'border border-white/25 text-white/70'
                }`}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Body Content on Pure White Canvas */}
      <div className="max-w-3xl mx-auto px-6 py-10">
        {errorMsg && (
          <div role="alert" className="mb-6 rounded-[4px] border border-ink bg-surface-1 px-4 py-3 text-sm text-ink">
            {errorMsg}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <div className="flex items-center gap-2.5">
              <Store className="h-5 w-5 text-primary shrink-0" />
              <h2 className="font-google-display text-[22px] sm:text-[24px] font-normal text-ink">
                เลือกรูปแบบธุรกิจ &amp; ข้อมูลใบกำกับภาษีอย่างย่อ (ABB)
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { id: 'RETAIL' as const, title: 'ค้าปลีก / ซูเปอร์มาร์เก็ต', sub: 'เน้นยิงบาร์โค้ดเร็ว & ตราชั่งสด' },
                { id: 'HOSPITALITY' as const, title: 'คาเฟ่ / ร้านอาหาร', sub: 'ปุ่มสัมผัส, สูตร BOM & จอครัว KDS' },
                { id: 'HYBRID' as const, title: 'ไฮบริดครบวงจร', sub: 'เปิดใช้งานทุกระบบพร้อมกัน' },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setBusinessProfile(p.id)}
                  className={`rounded-[4px] border p-4 text-left ${UI_INTERACTION.focusButton} ${
                    businessProfile === p.id
                      ? 'border-primary bg-primary-soft/50'
                      : 'border-hairline bg-canvas hover:border-primary'
                  }`}
                >
                  <div className="font-google-display text-base font-medium text-ink">
                    {p.title}
                  </div>
                  <div className="text-xs text-ink-muted mt-1">{p.sub}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="sm:col-span-2">
                <label htmlFor={`${uid}-store-name`} className="block text-xs font-medium text-ink-muted mb-1">
                  ชื่อร้านค้า / ชื่อบริษัท (แสดงบนหัวใบเสร็จ)
                </label>
                <input
                  id={`${uid}-store-name`}
                  type="text"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-tax-id`} className="block text-xs font-medium text-ink-muted mb-1">
                  เลขประจำตัวผู้เสียภาษี 13 หลัก
                </label>
                <input
                  id={`${uid}-tax-id`}
                  type="text"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-branch-code`} className="block text-xs font-medium text-ink-muted mb-1">
                  รหัสสาขา (00000 = สำนักงานใหญ่)
                </label>
                <input
                  id={`${uid}-branch-code`}
                  type="text"
                  value={branchCode}
                  onChange={(e) => setBranchCode(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-rd-reg`} className="block text-xs font-medium text-ink-muted mb-1">
                  เลขทะเบียนเครื่อง POS กรมสรรพากร
                </label>
                <input
                  id={`${uid}-rd-reg`}
                  type="text"
                  value={rdPosRegNo}
                  onChange={(e) => setRdPosRegNo(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-promptpay`} className="block text-xs font-medium text-primary-hover mb-1">
                  เบอร์มือถือ / เลขนิติบุคคลรับเงิน PromptPay QR
                </label>
                <input
                  id={`${uid}-promptpay`}
                  type="text"
                  value={promptPayId}
                  onChange={(e) => setPromptPayId(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>

            {/* Clean DB vs Sample Data Selector */}
            <div className="rounded-[8px] bg-primary-soft p-4 space-y-2">
              <div className="font-google-display text-sm font-medium text-ink">
                โหมดข้อมูลตั้งต้นในฐานข้อมูล
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <label className="flex items-start gap-2.5 rounded-[4px] border border-hairline bg-canvas p-3.5 cursor-pointer transition-colors duration-200 hover:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                  <input
                    type="radio"
                    name="seedMode"
                    checked={!loadDemoSampleCatalog}
                    onChange={() => setLoadDemoSampleCatalog(false)}
                    className="mt-1 accent-primary focus-visible:ring-2 focus-visible:ring-primary"
                  />
                  <div>
                    <div className="text-sm font-medium text-ink">
                      ฐานข้อมูลเปล่าสำหรับเปิดร้านจริง (แนะนำ)
                    </div>
                    <div className="text-xs text-ink-muted">
                      ไม่มีสินค้าตัวอย่างปะปน พร้อมให้คีย์สินค้าจริงของลูกค้าทันที
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-2.5 rounded-[4px] border border-hairline bg-canvas p-3.5 cursor-pointer transition-colors duration-200 hover:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                  <input
                    type="radio"
                    name="seedMode"
                    checked={loadDemoSampleCatalog}
                    onChange={() => setLoadDemoSampleCatalog(true)}
                    className="mt-1 accent-primary focus-visible:ring-2 focus-visible:ring-primary"
                  />
                  <div>
                    <div className="text-sm font-medium text-ink">
                      โหลดชุดสินค้าตัวอย่างเพื่อฝึกใช้งาน
                    </div>
                    <div className="text-xs text-ink-muted">
                      สร้างเมนูชานมไข่มุก น้ำดื่ม และหมูสามชั้นชั่งกิโลสำหรับทดสอบ
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleStep1Next}
                className={`h-[50px] rounded-[48px] bg-primary px-8 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                ถัดไป: ตั้งรหัสผ่านเจ้าของร้าน
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div className="flex items-center gap-2.5">
              <KeyRound className="h-5 w-5 text-primary shrink-0" />
              <h2 className="font-google-display text-[22px] sm:text-[24px] font-normal text-ink">
                ตั้งรหัส PIN เจ้าของร้าน &amp; รหัสวลีกู้คืนฉุกเฉิน
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <label htmlFor={`${uid}-owner-display`} className="block text-xs font-medium text-ink-muted mb-1">
                  ชื่อที่แสดงของเจ้าของร้าน
                </label>
                <input
                  id={`${uid}-owner-display`}
                  type="text"
                  value={ownerDisplayName}
                  onChange={(e) => setOwnerDisplayName(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-owner-user`} className="block text-xs font-medium text-ink-muted mb-1">
                  ชื่อบัญชี (Username)
                </label>
                <input
                  id={`${uid}-owner-user`}
                  type="text"
                  value={ownerUsername}
                  onChange={(e) => setOwnerUsername(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-owner-pin`} className="block text-xs font-medium text-primary-hover mb-1">
                  ตั้งรหัส PIN เจ้าของร้าน (ตัวเลข 4–8 หลัก)
                </label>
                <input
                  id={`${uid}-owner-pin`}
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="เช่น 258099"
                  value={ownerPin}
                  onChange={(e) => setOwnerPin(sanitizePinInput(e.target.value))}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-owner-pin-confirm`} className="block text-xs font-medium text-primary-hover mb-1">
                  ยืนยันรหัส PIN อีกครั้ง
                </label>
                <input
                  id={`${uid}-owner-pin-confirm`}
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="พิมพ์รหัส PIN ซ้ำอีกครั้ง"
                  value={ownerPinConfirm}
                  onChange={(e) => setOwnerPinConfirm(sanitizePinInput(e.target.value))}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor={`${uid}-recovery-phrase`} className="block text-xs font-medium text-ink-muted mb-1">
                  รหัสวลีกู้คืนฐานข้อมูลข้ามเครื่อง (Owner Recovery Passphrase — อย่างน้อย 12 ตัวอักษร)
                </label>
                <input
                  id={`${uid}-recovery-phrase`}
                  type="text"
                  value={recoveryPassphrase}
                  onChange={(e) => setRecoveryPassphrase(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink ${UI_INTERACTION.focusControl}`}
                />
                <p className="text-xs text-ink-muted mt-1">
                  ใช้สำหรับถอดรหัสไฟล์สำรองและย้ายฐานข้อมูลกรณีเมนบอร์ดเครื่องเดิมเสีย
                </p>
              </div>
            </div>

            <div className="flex flex-wrap justify-between gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className={`h-[50px] rounded-[48px] border border-hairline bg-canvas px-6 font-google-display text-sm font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                ย้อนกลับ
              </button>
              <button
                type="button"
                onClick={handleStep2Next}
                className={`h-[50px] rounded-[48px] bg-primary px-8 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                ถัดไป: ตั้งค่าเครื่องพิมพ์ใบเสร็จ
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <div className="flex items-center gap-2.5">
              <Printer className="h-5 w-5 text-primary shrink-0" />
              <h2 className="font-google-display text-[22px] sm:text-[24px] font-normal text-ink">
                เชื่อมต่อเครื่องพิมพ์ใบเสร็จความร้อน &amp; เงินทอนเปิดกะแรก
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                {
                  id: 'WINDOWS_RAW_USB' as const,
                  title: 'สาย USB (Windows Raw Spooler)',
                  sub: 'ส่งชุดคำสั่ง ESC/POS + เตะลิ้นชัก RJ11 ผ่านไดรเวอร์ USB โดยตรง',
                },
                {
                  id: 'LAN_TCP_9100' as const,
                  title: 'สายแลน LAN (TCP Port 9100)',
                  sub: 'ส่งตรงไปยัง IP ของเครื่องพิมพ์ความร้อนในวงแลน',
                },
                {
                  id: 'BROWSER_PRINT_DIALOG' as const,
                  title: 'Windows Print Dialog (@media print)',
                  sub: 'พิมพ์ผ่านหน้าต่างพรินเตอร์มาตรฐานของ Windows',
                },
                {
                  id: 'SIMULATED_MEMORY' as const,
                  title: 'โหมดจำลองบนหน้าจอ (ยังไม่มีเครื่องพิมพ์)',
                  sub: 'แสดงตัวอย่างใบเสร็จบนหน้าจอโดยไม่ส่งออกพอร์ต',
                },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setPrinterMode(m.id)}
                  className={`rounded-[4px] border p-4 text-left ${UI_INTERACTION.focusButton} ${
                    printerMode === m.id
                      ? 'border-primary bg-primary-soft/50'
                      : 'border-hairline bg-canvas hover:border-primary'
                  }`}
                >
                  <div className="font-google-display text-sm font-medium text-ink">
                    {m.title}
                  </div>
                  <div className="text-xs text-ink-muted mt-1">{m.sub}</div>
                </button>
              ))}
            </div>

            {printerMode === 'WINDOWS_RAW_USB' && (
              <div>
                <label htmlFor={`${uid}-wiz-winprn`} className="block text-xs font-medium text-ink-muted mb-1">
                  เลือกชื่อเครื่องพิมพ์ใบเสร็จใน Windows
                </label>
                {discoveredPrinters.length > 0 ? (
                  <select
                    id={`${uid}-wiz-winprn`}
                    value={windowsPrinterName}
                    onChange={(e) => setWindowsPrinterName(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-4 text-sm text-ink ${UI_INTERACTION.focusSelect}`}
                  >
                    {discoveredPrinters.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.portName})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`${uid}-wiz-winprn`}
                    type="text"
                    placeholder="เช่น XP-80C หรือ EPSON TM-T82 Receipt"
                    value={windowsPrinterName}
                    onChange={(e) => setWindowsPrinterName(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-sm text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                  />
                )}
              </div>
            )}

            {printerMode === 'LAN_TCP_9100' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label htmlFor={`${uid}-wiz-tcphost`} className="block text-xs font-medium text-ink-muted mb-1">
                    IP Address เครื่องพิมพ์
                  </label>
                  <input
                    id={`${uid}-wiz-tcphost`}
                    type="text"
                    value={tcpHost}
                    onChange={(e) => setTcpHost(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-sm text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
                <div>
                  <label htmlFor={`${uid}-wiz-tcpport`} className="block text-xs font-medium text-ink-muted mb-1">
                    TCP Port
                  </label>
                  <input
                    id={`${uid}-wiz-tcpport`}
                    type="text"
                    value={tcpPort}
                    onChange={(e) => setTcpPort(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-sm text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${uid}-wiz-width`} className="block text-xs font-medium text-ink-muted mb-1">
                  ขนาดหน้ากว้างกระดาษความร้อน
                </label>
                <select
                  id={`${uid}-wiz-width`}
                  value={paperWidthMm}
                  onChange={(e) => setPaperWidthMm(Number(e.target.value) === 58 ? 58 : 80)}
                  className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-4 text-sm text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value={80}>80 มม. มาตรฐานเคาน์เตอร์ (576 dots @ 203-DPI)</option>
                  <option value={58}>58 มม. เครื่องขนาดกะทัดรัด (384 dots @ 203-DPI)</option>
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-wiz-open-cash`} className="block text-xs font-medium text-ink-muted mb-1">
                  เงินสดทอนตั้งต้นในลิ้นชักกะแรก (บาท)
                </label>
                <input
                  id={`${uid}-wiz-open-cash`}
                  type="text"
                  value={openingCashBaht}
                  onChange={(e) => setOpeningCashBaht(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-sm text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>

            <div className="flex flex-wrap justify-between gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                className={`h-[50px] rounded-[48px] border border-hairline bg-canvas px-6 font-google-display text-sm font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                ย้อนกลับ
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleCompleteSetup()}
                className={`h-[50px] rounded-[48px] bg-primary px-8 font-google-display text-[15px] sm:text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {submitting ? 'กำลังสร้างฐานข้อมูล & กุญแจนิรภัย...' : 'ยืนยันตั้งค่าร้าน & สร้าง Recovery Kit'}
              </button>
            </div>
          </div>
        )}

        {step === 4 && completedData && (
          <div className="space-y-6">
            <div className="rounded-[8px] bg-primary-soft p-6 space-y-3">
              <div className="flex items-center gap-2.5 text-primary-dark">
                <CheckCircle2 className="h-6 w-6 shrink-0" />
                <h2 className="font-google-display text-[22px] font-normal text-ink">
                  ตั้งค่าระบบและสร้างกุญแจ Dual-KEK สำเร็จแล้ว
                </h2>
              </div>
              <p className="text-sm text-ink-soft">
                กรุณากดดาวน์โหลดไฟล์ <strong>{completedData.recoveryKitFilename}</strong> เก็บไว้ในแฟลชไดรฟ์ของเจ้าของร้าน ก่อนเข้าสู่หน้าจอขายจริง
              </p>

              <button
                type="button"
                onClick={triggerDownloadRecoveryKit}
                className={`inline-flex h-[50px] items-center gap-2 rounded-[48px] bg-canvas border border-hairline px-6 font-google-display text-sm font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <Download className="h-4 w-4" />
                ดาวน์โหลดไฟล์กู้คืนฉุกเฉิน (.recovery-kit)
              </button>
            </div>

            <div className="rounded-[4px] border border-hairline p-4 text-xs text-ink-muted flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
              <span>
                ไฟล์ <code>keystore.manifest.json</code> ถูกบันทึกแบบ Atomic (<code>.part + fsync</code>) เรียบร้อยแล้ว
              </span>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void onCompleted(completedData.ownerUser)}
                className={`flex h-[50px] items-center gap-2 rounded-[48px] bg-primary px-8 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                <Building2 className="h-4 w-4" />
                {downloadedKit ? 'เข้าสู่หน้าขายจริงทันที' : 'รับทราบและเข้าสู่หน้าขายจริง'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
