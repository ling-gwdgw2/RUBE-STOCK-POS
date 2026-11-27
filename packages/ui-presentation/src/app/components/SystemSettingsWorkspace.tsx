import React, { useEffect, useId, useState } from 'react';
import {
  Barcode,
  Building2,
  CheckCircle2,
  Cpu,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  Network,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Shield,
  Sliders,
  UserPlus,
} from 'lucide-react';
import QRCode from 'qrcode';
import {
  DEFAULT_LA_FISCAL_CONFIG,
  DEFAULT_TH_FISCAL_CONFIG,
  type CashRoundingStepMajor,
  type CountryCode,
  type LaoQrVerificationPolicy,
  type LocaleCode,
} from '../../../../shared-contracts/src/currency.ts';
import {
  BARCODE_LABEL_SIZE_PRESETS,
  normalizeBarcodeLabelConfig,
  type BarcodeLabelPrinterConfigDto,
  type BarcodeLabelSizePresetId,
  type BarcodeLabelTargetMode,
} from '../../../../shared-contracts/src/barcode-printing.ts';
import { posTransport } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type {
  BootstrapPayload,
  BusinessProfile,
  DiscoveredStorageDriveDto,
  PrinterTransportMode,
  StaffUserDto,
  TaxMode,
  UsbBackupConfigStatusDto,
  UserRole,
} from '../types.ts';
import { sanitizePinInput } from '../utils/keyboard-digits.ts';
import { canManageCriticalStoreSettings } from '../utils/rbac.ts';
import { QrOrderingSettingsCard } from './QrOrderingSettingsCard.tsx';
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
  const { fiscal, t, pick } = useI18n();
  const uid = useId();
  const isOwner = canManageCriticalStoreSettings(currentUser.role);
  const [storeName, setStoreName] = useState(bootstrap.storeSettings.storeName);
  const [storeAddress, setStoreAddress] = useState(
    bootstrap.storeSettings.storeAddress ?? fiscal.storeAddress
  );
  const [taxId, setTaxId] = useState(bootstrap.storeSettings.taxId);
  const [branchCode, setBranchCode] = useState(bootstrap.storeSettings.branchCode);
  const [rdPosRegNo, setRdPosRegNo] = useState(bootstrap.storeSettings.rdPosRegNo);
  const [promptPayId, setPromptPayId] = useState(bootstrap.storeSettings.promptPayId);
  const [countryCode, setCountryCode] = useState<CountryCode>(fiscal.countryCode);
  const [uiLocale, setUiLocale] = useState<LocaleCode>(fiscal.uiLocale);
  const [receiptLocale, setReceiptLocale] = useState<LocaleCode>(fiscal.receiptLocale);
  const [vatRateBps, setVatRateBps] = useState<number>(fiscal.vatRateBps);
  const [defaultTaxMode, setDefaultTaxMode] = useState<TaxMode>(fiscal.defaultTaxMode);
  const [cashRoundingStepMajor, setCashRoundingStepMajor] = useState<CashRoundingStepMajor>(
    fiscal.cashRoundingStepMajor
  );
  const [scalePriceEmbeddedMultiplier, setScalePriceEmbeddedMultiplier] = useState<number>(
    fiscal.scalePriceEmbeddedMultiplier
  );
  const [laoQrStaticTemplate, setLaoQrStaticTemplate] = useState<string>(
    fiscal.laoQrStaticTemplate
  );
  const [laoQrVerificationPolicy, setLaoQrVerificationPolicy] = useState<LaoQrVerificationPolicy>(
    fiscal.laoQrVerificationPolicy
  );
  const [fxEnabled, setFxEnabled] = useState<boolean>(fiscal.fxRates.enabled);
  const [fxThbRateInput, setFxThbRateInput] = useState<string>(String(fiscal.fxRates.thbToLakRate));
  const [fxUsdRateInput, setFxUsdRateInput] = useState<string>(String(fiscal.fxRates.usdToLakRate));
  const [laoQrPreviewUrl, setLaoQrPreviewUrl] = useState<string | null>(null);
  const [laoQrPreviewInfo, setLaoQrPreviewInfo] = useState<string | null>(null);

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

  // Product Barcode Label Printer Config
  const [lblCfg, setLblCfg] = useState<BarcodeLabelPrinterConfigDto>(() =>
    normalizeBarcodeLabelConfig(bootstrap.barcodeLabelConfig)
  );

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
    setStoreAddress(bootstrap.storeSettings.storeAddress ?? fiscal.storeAddress);
    setTaxId(bootstrap.storeSettings.taxId);
    setBranchCode(bootstrap.storeSettings.branchCode);
    setRdPosRegNo(bootstrap.storeSettings.rdPosRegNo);
    setPromptPayId(bootstrap.storeSettings.promptPayId);
    setCountryCode(fiscal.countryCode);
    setUiLocale(fiscal.uiLocale);
    setReceiptLocale(fiscal.receiptLocale);
    setVatRateBps(fiscal.vatRateBps);
    setDefaultTaxMode(fiscal.defaultTaxMode);
    setCashRoundingStepMajor(fiscal.cashRoundingStepMajor);
    setScalePriceEmbeddedMultiplier(fiscal.scalePriceEmbeddedMultiplier);
    setLaoQrStaticTemplate(fiscal.laoQrStaticTemplate);
    setLaoQrVerificationPolicy(fiscal.laoQrVerificationPolicy);
    setFxEnabled(fiscal.fxRates.enabled);
    setFxThbRateInput(String(fiscal.fxRates.thbToLakRate));
    setFxUsdRateInput(String(fiscal.fxRates.usdToLakRate));
    setPrnMode(bootstrap.printerConfig.mode);
    setPrnHost(bootstrap.printerConfig.tcpHost);
    setPrnPort(String(bootstrap.printerConfig.tcpPort));
    setPrnWinName(bootstrap.printerConfig.windowsPrinterName);
    setPrnWidthMm(bootstrap.printerConfig.paperWidthMm);
    setPrnAutoDrawer(bootstrap.printerConfig.autoKickDrawerOnCash);
    setLblCfg(normalizeBarcodeLabelConfig(bootstrap.barcodeLabelConfig));
    if (bootstrap.usbBackupConfig) {
      setUsbBackupCfg(bootstrap.usbBackupConfig);
      setUsbDirInput(bootstrap.usbBackupConfig.customBackupDir);
      setMirrorLocalFallback(bootstrap.usbBackupConfig.mirrorToLocalFallback);
    }
  }, [bootstrap.barcodeLabelConfig, bootstrap.printerConfig, bootstrap.storeSettings, bootstrap.usbBackupConfig, fiscal]);

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

  const handleSaveBarcodeLabelConfig = async () => {
    setBusy(true);
    try {
      await posTransport.saveBarcodeLabelConfig(lblCfg);
      await onRefreshState();
      onToast('บันทึกตั้งค่าเครื่องพิมพ์สติกเกอร์บาร์โค้ดสำเร็จ', 'success');
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

  const handleCountryToggleInSettings = (nextCountry: CountryCode) => {
    setCountryCode(nextCountry);
    if (nextCountry === 'LA') {
      setUiLocale(DEFAULT_LA_FISCAL_CONFIG.uiLocale);
      setReceiptLocale(DEFAULT_LA_FISCAL_CONFIG.receiptLocale);
      setVatRateBps(DEFAULT_LA_FISCAL_CONFIG.vatRateBps);
      setDefaultTaxMode('INCLUSIVE');
      setCashRoundingStepMajor(500);
      setScalePriceEmbeddedMultiplier(10_000);
    } else {
      setUiLocale(DEFAULT_TH_FISCAL_CONFIG.uiLocale);
      setReceiptLocale(DEFAULT_TH_FISCAL_CONFIG.receiptLocale);
      setVatRateBps(DEFAULT_TH_FISCAL_CONFIG.vatRateBps);
      setDefaultTaxMode('INCLUSIVE');
      setCashRoundingStepMajor(0);
      setScalePriceEmbeddedMultiplier(1);
      setFxEnabled(false);
    }
  };

  const handleValidateOrSampleLaoQr = async (generateSample: boolean) => {
    setBusy(true);
    try {
      const res = await posTransport.validateLaoQrTemplate(
        generateSample
          ? {
              generateSample: true,
              merchantName: storeName || 'RUBE LAO SHOP',
              merchantCity: 'VIENTIANE',
              previewAmountSatang: 3_500_000,
            }
          : {
              rawTemplate: laoQrStaticTemplate,
              previewAmountSatang: 3_500_000,
            }
      );
      if (!res.valid || !res.normalizedTemplate || !res.previewPayload) {
        setLaoQrPreviewUrl(null);
        setLaoQrPreviewInfo(null);
        onToast(res.errorReason || 'LAOQR template is invalid', 'error');
        return;
      }
      setLaoQrStaticTemplate(res.normalizedTemplate);
      const url = await QRCode.toDataURL(res.previewPayload, {
        width: 168,
        margin: 1,
        color: { dark: '#202124', light: '#ffffff' },
      });
      setLaoQrPreviewUrl(url);
      setLaoQrPreviewInfo(
        `Tag ${res.merchantAccountTag} · ${res.merchantName || 'LAOQR'} · Dynamic 35,000 ₭ (CRC ${res.previewCrcHex})`
      );
      onToast(
        pick(
          'ตรวจสอบแม่แบบ LAOQR สำเร็จ — กด "บันทึก" เพื่อลงลายเซ็น HMAC-SHA256',
          'ກວດສອບແມ່ແບບ LAOQR ສຳເລັດ — ກົດ "ບັນທຶກ" ເພື່ອລົງລາຍເຊັນ HMAC-SHA256',
          'LAOQR template validated — click Save to HMAC-sign it'
        ),
        'success'
      );
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
        storeAddress,
        taxId,
        branchCode,
        rdPosRegNo,
        promptPayId,
        countryCode,
        uiLocale,
        receiptLocale,
        vatRateBps: defaultTaxMode === 'NONE' ? 0 : vatRateBps,
        defaultTaxMode,
        cashRoundingStepMajor: countryCode === 'LA' ? cashRoundingStepMajor : 0,
        scalePriceEmbeddedMultiplier,
        laoQrStaticTemplate: countryCode === 'LA' ? laoQrStaticTemplate.trim() : '',
        laoQrVerificationPolicy,
        fxRates: {
          enabled: countryCode === 'LA' && fxEnabled,
          thbToLakRate: Math.max(1, Math.round(Number(fxThbRateInput.replace(/\D/g, '') || 640))),
          usdToLakRate: Math.max(1, Math.round(Number(fxUsdRateInput.replace(/\D/g, '') || 21500))),
        },
        updatedByUserId: currentUser.id,
      });
      await onRefreshState();
      const logs = await posTransport.listSecurityAuditLogs(40);
      setAuditLogs(logs.auditLogs);
      onToast(
        pick(
          'บันทึกข้อมูลร้านค้า ประเทศ สกุลเงิน ภาษี VAT และ QR (HMAC Guarded) สำเร็จ',
          'ບັນທຶກຂໍ້ມູນຮ້ານ, ປະເທດ, ສະກຸນເງິນ, ອາກອນ ອມພ ແລະ QR (HMAC Guarded) ສຳເລັດ',
          'Store identity, country, VAT and QR settings saved & HMAC-signed'
        ),
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

      {/* 1.6 Product Barcode Label Printer Settings */}
      <section className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
              <Barcode className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-google-display text-[20px] font-normal leading-[28px] text-ink">
                เครื่องพิมพ์บาร์โค้ดสติกเกอร์สินค้า (A4 Sticker / TSPL / ZPL / ESC-POS)
              </h2>
              <p className="text-xs text-ink-muted mt-1">
                กำหนดค่าเริ่มต้นสำหรับแท็บ &ldquo;พิมพ์บาร์โค้ดสินค้า&rdquo; ในคลังสินค้า รองรับทั้งสติกเกอร์ A4, Xprinter/TSC (TSPL2), Zebra (ZPL II) และเครื่องพิมพ์ใบเสร็จ 80/58mm
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div className="md:col-span-2">
            <label htmlFor={`${uid}-set-lbl-mode`} className="block text-ink-muted mb-1">
              โหมดเครื่องพิมพ์บาร์โค้ดเริ่มต้น
            </label>
            <select
              id={`${uid}-set-lbl-mode`}
              value={lblCfg.mode}
              onChange={(e) => {
                const nextMode = e.target.value as BarcodeLabelTargetMode;
                const nextPreset: BarcodeLabelSizePresetId =
                  nextMode === 'A4_SHEET'
                    ? 'A4_30UP'
                    : nextMode === 'ESCPOS_RECEIPT_PRINTER'
                      ? prnWidthMm === 58
                        ? 'RECEIPT_58MM'
                        : 'RECEIPT_80MM'
                      : '50x30mm';
                setLblCfg((prev) => ({
                  ...prev,
                  mode: nextMode,
                  defaultPresetId: nextPreset,
                }));
              }}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              <option value="A4_SHEET">กระดาษสติกเกอร์ A4 (Laser / Inkjet)</option>
              <option value="THERMAL_LABEL_DIALOG">สติกเกอร์ความร้อน (Windows Print Dialog)</option>
              <option value="TSPL_RAW_USB">TSPL USB Raw Spooler (Xprinter / TSC / Gprinter)</option>
              <option value="TSPL_LAN_9100">TSPL LAN (TCP Port 9100)</option>
              <option value="ZPL_RAW_USB">ZPL USB Raw Spooler (Zebra)</option>
              <option value="ZPL_LAN_9100">ZPL LAN (TCP Port 9100)</option>
              <option value="ESCPOS_RECEIPT_PRINTER">พิมพ์ผ่านเครื่องพิมพ์ใบเสร็จ 80mm / 58mm</option>
            </select>
          </div>

          <div>
            <label htmlFor={`${uid}-set-lbl-preset`} className="block text-ink-muted mb-1">
              ขนาดป้ายเริ่มต้น
            </label>
            <select
              id={`${uid}-set-lbl-preset`}
              value={lblCfg.defaultPresetId}
              onChange={(e) =>
                setLblCfg((prev) => ({
                  ...prev,
                  defaultPresetId: e.target.value as BarcodeLabelSizePresetId,
                }))
              }
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              {BARCODE_LABEL_SIZE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({p.widthMm}×{p.heightMm}mm)
                </option>
              ))}
            </select>
          </div>

          {(lblCfg.mode === 'TSPL_RAW_USB' || lblCfg.mode === 'ZPL_RAW_USB') && (
            <div>
              <label htmlFor={`${uid}-set-lbl-win`} className="block text-ink-muted mb-1">
                เครื่องพิมพ์สติกเกอร์ USB
              </label>
              {winPrinters.length > 0 ? (
                <select
                  id={`${uid}-set-lbl-win`}
                  value={lblCfg.windowsPrinterName}
                  onChange={(e) =>
                    setLblCfg((prev) => ({ ...prev, windowsPrinterName: e.target.value }))
                  }
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
                  id={`${uid}-set-lbl-win`}
                  type="text"
                  placeholder="เช่น Xprinter XP-365B"
                  value={lblCfg.windowsPrinterName}
                  onChange={(e) =>
                    setLblCfg((prev) => ({ ...prev, windowsPrinterName: e.target.value }))
                  }
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusControl}`}
                />
              )}
            </div>
          )}

          {(lblCfg.mode === 'TSPL_LAN_9100' || lblCfg.mode === 'ZPL_LAN_9100') && (
            <div>
              <label htmlFor={`${uid}-set-lbl-host`} className="block text-ink-muted mb-1">
                IP:Port เครื่องพิมพ์บาร์โค้ด LAN
              </label>
              <div className="flex gap-1.5">
                <input
                  id={`${uid}-set-lbl-host`}
                  type="text"
                  value={lblCfg.tcpHost}
                  onChange={(e) => setLblCfg((prev) => ({ ...prev, tcpHost: e.target.value }))}
                  className={`h-11 flex-1 min-w-0 rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
                <input
                  type="number"
                  aria-label="พอร์ต TCP เครื่องพิมพ์บาร์โค้ด"
                  value={lblCfg.tcpPort}
                  onChange={(e) =>
                    setLblCfg((prev) => ({
                      ...prev,
                      tcpPort: Math.max(1, Math.min(65535, Number(e.target.value) || 9100)),
                    }))
                  }
                  className={`h-11 w-20 rounded-[4px] border border-hairline bg-canvas px-2 text-center text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-2 border-t border-hairline">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSaveBarcodeLabelConfig()}
            className={`h-[44px] rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            บันทึกตั้งค่าเครื่องพิมพ์บาร์โค้ด
          </button>
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
        {/* 2. Store Identity, Country/Currency, VAT, Cash Rounding & QR Settings */}
        <section className="xl:col-span-6 rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2.5">
              <Building2 className="h-5 w-5 text-primary shrink-0" />
              <span>{t('set.countrySectionTitle')}</span>
            </h3>
            {!isOwner && (
              <span className="inline-flex items-center gap-1 rounded-[48px] border border-hairline bg-surface-1 px-2.5 py-0.5 text-[11px] font-medium text-ink-muted">
                <Lock className="h-3 w-3" /> OWNER
              </span>
            )}
          </div>

          {/* Country & Language Selector Row */}
          <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 space-y-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-ink">
              <Globe className="h-4 w-4 text-primary shrink-0" />
              <span>{pick('ประเทศและระบบสกุลเงินหลักของร้าน', 'ປະເທດ ແລະ ສະກຸນເງິນຫຼັກຂອງຮ້ານ', 'Store Country & Primary Currency')}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['TH', 'LA'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  disabled={!isOwner}
                  onClick={() => handleCountryToggleInSettings(code)}
                  className={`h-11 rounded-[4px] border px-3 text-left font-google-display text-xs font-medium disabled:opacity-60 ${UI_INTERACTION.focusButton} ${
                    countryCode === code
                      ? 'border-primary bg-primary-soft text-primary-dark'
                      : 'border-hairline bg-canvas text-ink-soft hover:border-primary'
                  }`}
                >
                  {code === 'TH' ? 'TH · ประเทศไทย (THB ฿)' : 'LA · ສປປ.ລາວ (LAK ₭)'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-ui-locale`} className="block text-ink-muted mb-1">
                  {pick('ภาษาหน้าจอ POS (UI Language)', 'ພາສາໜ້າຈໍ POS (UI Language)', 'POS UI Language')}
                </label>
                <select
                  id={`${uid}-ui-locale`}
                  disabled={!isOwner}
                  value={uiLocale}
                  onChange={(e) => setUiLocale(e.target.value as LocaleCode)}
                  className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value="lo">ພາສາລາວ (Lao)</option>
                  <option value="th">ภาษาไทย (Thai)</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-receipt-locale`} className="block text-ink-muted mb-1">
                  {pick('ภาษาบนใบเสร็จความร้อน 203-DPI', 'ພາສາເທິງໃບບິນຄວາມຮ້ອນ 203-DPI', 'Thermal Receipt Language')}
                </label>
                <select
                  id={`${uid}-receipt-locale`}
                  disabled={!isOwner}
                  value={receiptLocale}
                  onChange={(e) => setReceiptLocale(e.target.value as LocaleCode)}
                  className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value="lo">ພາສາລາວ (Lao · ອມພ)</option>
                  <option value="th">ภาษาไทย (Thai)</option>
                  <option value="en">English</option>
                </select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-store-name`} className="block text-ink-muted mb-1">
                {pick('ชื่อร้านค้าบนหัวใบเสร็จ', 'ຊື່ຮ້ານຄ້າເທິງຫົວໃບບິນ', 'Store Name (Receipt Header)')}
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
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-store-address`} className="block text-ink-muted mb-1">
                {pick('ที่อยู่ร้านค้า (พิมพ์บนใบเสร็จ สปป.ลาว / ใบกำกับภาษี)', 'ທີ່ຢູ່ຮ້ານຄ້າ (ພິມເທິງໃບບິນ)', 'Store Address (Printed on Receipt)')}
              </label>
              <input
                id={`${uid}-store-address`}
                type="text"
                disabled={!isOwner}
                placeholder={countryCode === 'LA' ? 'ບ້ານ / ເມືອງ / ແຂວງ' : 'ที่อยู่ร้าน (ไม่บังคับ)'}
                value={storeAddress}
                onChange={(e) => setStoreAddress(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink placeholder:text-ink-muted disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-tax-id`} className="block text-ink-muted mb-1">
                {countryCode === 'LA'
                  ? pick('เลขผู้เสียภาษี สปป.ลาว (TIN 12 หลัก)', 'ເລກປະຈຳຕົວຜູ້ເສຍອາກອນ (TIN)', 'Lao TIN')
                  : 'เลขประจำตัวผู้เสียภาษี 13 หลัก'}
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
              <label htmlFor={`${uid}-rd-reg`} className="block text-ink-muted mb-1">
                {countryCode === 'LA'
                  ? pick('เลขทะเบียนเครื่อง POS / TaxRIS', 'ເລກທະບຽນເຄື່ອງ POS / TaxRIS', 'POS / TaxRIS Reg No.')
                  : 'เลขทะเบียนเครื่องเก็บเงินกรมสรรพากร'}
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
              <label htmlFor={`${uid}-vat-preset`} className="block text-ink-muted mb-1">
                {pick('อัตราภาษี VAT & รูปแบบเริ่มต้น', 'ອັດຕາອາກອນ ອມພ (VAT) & ຮູບແບບເລີ່ມຕົ້ນ', 'VAT Rate & Default Mode')}
              </label>
              <select
                id={`${uid}-vat-preset`}
                disabled={!isOwner}
                value={defaultTaxMode === 'NONE' ? 'NONE' : `${vatRateBps}:${defaultTaxMode}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'NONE') {
                    setDefaultTaxMode('NONE');
                    setVatRateBps(0);
                  } else {
                    const [bpsStr, modeStr] = v.split(':');
                    setVatRateBps(Number(bpsStr) || (countryCode === 'LA' ? 1000 : 700));
                    setDefaultTaxMode((modeStr as TaxMode) || 'INCLUSIVE');
                  }
                }}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
              >
                <option value="1000:INCLUSIVE">VAT 10% Inclusive ({pick('มาตรฐาน สปป.ลาว', 'ມາດຕະຖານ ສປປ.ລາວ', 'Laos Standard')})</option>
                <option value="1000:EXCLUSIVE">VAT 10% Exclusive (+10%)</option>
                <option value="700:INCLUSIVE">VAT 7% Inclusive ({pick('มาตรฐานไทย', 'ມາດຕະຖານໄທ', 'Thailand Standard')})</option>
                <option value="700:EXCLUSIVE">VAT 7% Exclusive (+7%)</option>
                <option value="NONE">0% {pick('ยกเว้น VAT (ร้านเล็ก)', 'ຍົກເວັ້ນ ອມພ (ຮ້ານຂະໜາດນ້ອຍ)', 'VAT Exempt')}</option>
              </select>
            </div>
            {countryCode === 'TH' ? (
              <>
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
                <div className="sm:col-span-2">
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
              </>
            ) : (
              <>
                <div>
                  <label htmlFor={`${uid}-cash-rounding`} className="block text-ink-muted mb-1">
                    {t('set.cashRoundingLabel')}
                  </label>
                  <select
                    id={`${uid}-cash-rounding`}
                    disabled={!isOwner}
                    value={cashRoundingStepMajor}
                    onChange={(e) =>
                      setCashRoundingStepMajor(Number(e.target.value) as CashRoundingStepMajor)
                    }
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
                  >
                    <option value={0}>{t('set.cashRounding.0')}</option>
                    <option value={500}>{t('set.cashRounding.500')}</option>
                    <option value={1000}>{t('set.cashRounding.1000')}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`${uid}-scale-mult`} className="block text-ink-muted mb-1">
                    {t('set.scaleMultLabel')}
                  </label>
                  <select
                    id={`${uid}-scale-mult`}
                    disabled={!isOwner}
                    value={scalePriceEmbeddedMultiplier}
                    onChange={(e) => setScalePriceEmbeddedMultiplier(Number(e.target.value))}
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
                  >
                    <option value={10_000}>×100 ₭ (01500 = 150,000 ₭ — แนะนำ)</option>
                    <option value={100_000}>×1,000 ₭ (00150 = 150,000 ₭)</option>
                    <option value={100}>×1 ₭ (สูงสุด 99,999 ₭)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`${uid}-laoqr-policy`} className="block text-ink-muted mb-1">
                    {t('set.laoQrVerifyPolicy')}
                  </label>
                  <select
                    id={`${uid}-laoqr-policy`}
                    disabled={!isOwner}
                    value={laoQrVerificationPolicy}
                    onChange={(e) =>
                      setLaoQrVerificationPolicy(e.target.value as LaoQrVerificationPolicy)
                    }
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
                  >
                    <option value="STRICT_REF">{t('set.laoQrPolicy.STRICT_REF')}</option>
                    <option value="VISUAL_CONFIRM_ALLOWED">{t('set.laoQrPolicy.VISUAL_CONFIRM_ALLOWED')}</option>
                  </select>
                </div>
                <div className="sm:col-span-2 rounded-[4px] border border-primary/50 bg-surface-1 p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor={`${uid}-laoqr-static`} className="flex items-center gap-1.5 font-medium text-primary-dark">
                      <QrCode className="h-4 w-4 shrink-0" />
                      <span>{t('set.laoQrTitle')}</span>
                    </label>
                    <button
                      type="button"
                      disabled={busy || !isOwner}
                      onClick={() => void handleValidateOrSampleLaoQr(true)}
                      className={`h-8 rounded-[48px] border border-hairline bg-canvas px-3 text-[11px] font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
                    >
                      {pick('สร้าง LAOQR ตัวอย่าง', 'ສ້າງ LAOQR ຕົວຢ່າງ', 'Sample LAOQR')}
                    </button>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      id={`${uid}-laoqr-static`}
                      type="text"
                      disabled={!isOwner}
                      placeholder="00020101021138...53034185802LA...6304XXXX"
                      value={laoQrStaticTemplate}
                      onChange={(e) => setLaoQrStaticTemplate(e.target.value)}
                      className={`h-10 flex-1 rounded-[4px] border border-hairline bg-canvas px-3 text-xs text-ink font-mono-num disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
                    />
                    <button
                      type="button"
                      disabled={busy || !isOwner || !laoQrStaticTemplate.trim()}
                      onClick={() => void handleValidateOrSampleLaoQr(false)}
                      className={`h-10 rounded-[48px] border border-primary bg-primary-soft px-4 text-xs font-medium text-primary-dark hover:bg-primary hover:text-white disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
                    >
                      {pick('ทดสอบ Dynamic QR', 'ທົດສອບ Dynamic QR', 'Test QR')}
                    </button>
                  </div>
                  {laoQrPreviewUrl && (
                    <div className="flex items-center gap-3 rounded-[4px] border border-hairline bg-canvas p-2.5">
                      <img
                        src={laoQrPreviewUrl}
                        alt="LAOQR Preview"
                        className="h-16 w-16 rounded-[4px] border border-hairline bg-white p-1 shrink-0"
                      />
                      <div className="text-[11px] text-ink-soft leading-relaxed">
                        <div className="font-medium text-ink">{laoQrPreviewInfo}</div>
                        <div className="text-ink-muted">
                          {pick('สแกนทดสอบได้จากแอปธนาคารในเครือ LAPNet / BCEL One', 'ສະແກນທົດສອບໄດ້ຈາກແອັບທະນາຄານ LAPNet / BCEL One', 'Scannable with LAPNet / BCEL One apps')}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Phase 5: Multi-Currency Cash Tender FX Rates (THB / USD -> LAK) */}
                <div className="sm:col-span-2 rounded-[4px] border border-hairline bg-surface-1 p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">{t('fx.sectionTitle')}</span>
                    <label className="inline-flex items-center gap-2 text-xs text-ink cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={!isOwner}
                        checked={fxEnabled}
                        onChange={(e) => setFxEnabled(e.target.checked)}
                        className="accent-primary"
                      />
                      <span>{t('fx.enableToggle')}</span>
                    </label>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`${uid}-fx-thb`} className="block text-ink-muted mb-1">
                        {t('fx.thbRateLabel')}
                      </label>
                      <input
                        id={`${uid}-fx-thb`}
                        type="text"
                        inputMode="numeric"
                        disabled={!isOwner || !fxEnabled}
                        value={fxThbRateInput}
                        onChange={(e) => setFxThbRateInput(e.target.value.replace(/\D/g, '').slice(0, 7))}
                        placeholder="640"
                        className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${uid}-fx-usd`} className="block text-ink-muted mb-1">
                        {t('fx.usdRateLabel')}
                      </label>
                      <input
                        id={`${uid}-fx-usd`}
                        type="text"
                        inputMode="numeric"
                        disabled={!isOwner || !fxEnabled}
                        value={fxUsdRateInput}
                        onChange={(e) => setFxUsdRateInput(e.target.value.replace(/\D/g, '').slice(0, 8))}
                        placeholder="21500"
                        className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google disabled:bg-surface-1 disabled:text-ink-muted ${UI_INTERACTION.focusControl}`}
                      />
                    </div>
                  </div>
                  {fxEnabled && (
                    <div className="text-[11px] text-ink-muted tabular-nums-google">
                      {pick('ตัวอย่าง:', 'ຕົວຢ່າງ:', 'Preview:')} ฿100 ={' '}
                      {(Math.max(1, Number(fxThbRateInput || 640)) * 100).toLocaleString('en-US')} ₭ · $20 ={' '}
                      {(Math.max(1, Number(fxUsdRateInput || 21500)) * 20).toLocaleString('en-US')} ₭ (HMAC-SHA256)
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            disabled={busy || !isOwner}
            onClick={() => void handleSaveStoreSettings()}
            className={`h-[46px] w-full rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            {t('set.saveFiscal')}
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

      {/* 3B. Local LAN QR Table Ordering & Captive Portal */}
      <QrOrderingSettingsCard
        outletId={outletId}
        bootstrap={bootstrap}
        canManage={isOwner || currentUser.role === 'MANAGER'}
        onRefreshState={onRefreshState}
        onToast={onToast}
      />

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
