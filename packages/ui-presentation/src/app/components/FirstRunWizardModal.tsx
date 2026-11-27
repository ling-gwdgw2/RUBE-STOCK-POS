import React, { useEffect, useId, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Download,
  Globe,
  KeyRound,
  Printer,
  QrCode,
  ShieldCheck,
  Store,
} from 'lucide-react';
import QRCode from 'qrcode';
import {
  DEFAULT_LA_FISCAL_CONFIG,
  DEFAULT_TH_FISCAL_CONFIG,
  parseMoneyInputToMinor,
  type CashRoundingStepMajor,
  type CountryCode,
  type LaoQrVerificationPolicy,
  type LocaleCode,
} from '../../../../shared-contracts/src/currency.ts';
import { posTransport } from '../api/pos-transport.ts';
import { pickLocaleText } from '../i18n/index.tsx';
import type {
  BusinessProfile,
  PrinterHardwareConfigDto,
  PrinterTransportMode,
  StaffUserDto,
  StoreIdentitySettingsDto,
  TaxMode,
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
  const initialFiscal = initialStoreSettings?.fiscalConfig;
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [countryCode, setCountryCode] = useState<CountryCode>(
    initialFiscal?.countryCode ?? 'TH'
  );
  const [uiLocale, setUiLocale] = useState<LocaleCode>(
    initialFiscal?.uiLocale ?? 'th'
  );
  const [receiptLocale, setReceiptLocale] = useState<LocaleCode>(
    initialFiscal?.receiptLocale ?? 'th'
  );
  const [vatRateBps, setVatRateBps] = useState<number>(
    initialFiscal?.vatRateBps ?? 700
  );
  const [defaultTaxMode, setDefaultTaxMode] = useState<TaxMode>(
    initialFiscal?.defaultTaxMode ?? 'INCLUSIVE'
  );
  const [cashRoundingStepMajor, setCashRoundingStepMajor] = useState<CashRoundingStepMajor>(
    initialFiscal?.cashRoundingStepMajor ?? 0
  );
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>(
    initialStoreSettings?.businessProfile ?? 'HYBRID'
  );
  const [storeName, setStoreName] = useState(
    initialStoreSettings?.storeName || 'ร้านค้าของฉัน (My Store)'
  );
  const [storeAddress, setStoreAddress] = useState(
    initialStoreSettings?.storeAddress || initialFiscal?.storeAddress || ''
  );
  const [taxId, setTaxId] = useState(initialStoreSettings?.taxId || '0105566009999');
  const [branchCode, setBranchCode] = useState(initialStoreSettings?.branchCode || '00000');
  const [rdPosRegNo, setRdPosRegNo] = useState(initialStoreSettings?.rdPosRegNo || 'RD-POS-0001');
  const [promptPayId, setPromptPayId] = useState(
    initialStoreSettings?.promptPayId || '0812345678'
  );
  const [laoQrStaticTemplate, setLaoQrStaticTemplate] = useState(
    initialFiscal?.laoQrStaticTemplate || ''
  );
  const [laoQrVerificationPolicy, setLaoQrVerificationPolicy] = useState<LaoQrVerificationPolicy>(
    initialFiscal?.laoQrVerificationPolicy ?? 'STRICT_REF'
  );
  const [fxEnabled, setFxEnabled] = useState<boolean>(initialFiscal?.fxRates?.enabled ?? false);
  const [fxThbRateInput, setFxThbRateInput] = useState<string>(
    String(initialFiscal?.fxRates?.thbToLakRate ?? 640)
  );
  const [fxUsdRateInput, setFxUsdRateInput] = useState<string>(
    String(initialFiscal?.fxRates?.usdToLakRate ?? 21500)
  );
  const [laoQrPreviewUrl, setLaoQrPreviewUrl] = useState<string | null>(null);
  const [laoQrPreviewMeta, setLaoQrPreviewMeta] = useState<string | null>(null);
  const [validatingLaoQr, setValidatingLaoQr] = useState(false);
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
  const [openingCashBaht, setOpeningCashBaht] = useState(
    initialFiscal?.countryCode === 'LA' ? '500000' : '1000.00'
  );

  // Step 4: Generated Recovery Kit
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [completedData, setCompletedData] = useState<{
    ownerUser: StaffUserDto;
    recoveryKitFilename: string;
    recoveryKitContent: string;
  } | null>(null);
  const [downloadedKit, setDownloadedKit] = useState(false);

  const pick = (thText: string, loText: string, enText?: string) =>
    pickLocaleText(uiLocale, thText, loText, enText);

  const handleSelectCountry = (nextCountry: CountryCode) => {
    setCountryCode(nextCountry);
    setErrorMsg(null);
    if (nextCountry === 'LA') {
      setUiLocale(DEFAULT_LA_FISCAL_CONFIG.uiLocale);
      setReceiptLocale(DEFAULT_LA_FISCAL_CONFIG.receiptLocale);
      setVatRateBps(DEFAULT_LA_FISCAL_CONFIG.vatRateBps);
      setDefaultTaxMode('INCLUSIVE');
      setCashRoundingStepMajor(500);
      if (!storeName || storeName === 'ร้านค้าของฉัน (My Store)') {
        setStoreName('ຮ້ານຄ້າຂອງຂ້ອຍ (My Lao Store)');
      }
      if (!taxId || taxId === '0105566009999') {
        setTaxId('123456789012');
      }
      if (!rdPosRegNo || rdPosRegNo === 'RD-POS-0001') {
        setRdPosRegNo('LA-POS-0001');
      }
      if (!ownerDisplayName || ownerDisplayName === 'เจ้าของร้าน (Owner)') {
        setOwnerDisplayName('ເຈົ້າຂອງຮ້ານ (Owner)');
      }
      if (openingCashBaht === '1000.00') {
        setOpeningCashBaht('500000');
      }
    } else {
      setUiLocale(DEFAULT_TH_FISCAL_CONFIG.uiLocale);
      setReceiptLocale(DEFAULT_TH_FISCAL_CONFIG.receiptLocale);
      setVatRateBps(DEFAULT_TH_FISCAL_CONFIG.vatRateBps);
      setDefaultTaxMode('INCLUSIVE');
      setCashRoundingStepMajor(0);
      if (!storeName || storeName === 'ຮ້ານຄ້າຂອງຂ້ອຍ (My Lao Store)') {
        setStoreName('ร้านค้าของฉัน (My Store)');
      }
      if (!taxId || taxId === '123456789012') {
        setTaxId('0105566009999');
      }
      if (!rdPosRegNo || rdPosRegNo === 'LA-POS-0001') {
        setRdPosRegNo('RD-POS-0001');
      }
      if (!ownerDisplayName || ownerDisplayName === 'ເຈົ້າຂອງຮ້ານ (Owner)') {
        setOwnerDisplayName('เจ้าของร้าน (Owner)');
      }
      if (openingCashBaht === '500000') {
        setOpeningCashBaht('1000.00');
      }
    }
  };

  const handleValidateOrSampleLaoQr = async (generateSample: boolean) => {
    setValidatingLaoQr(true);
    setErrorMsg(null);
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
        setLaoQrPreviewMeta(null);
        setErrorMsg(res.errorReason || 'LAOQR template is invalid');
        return;
      }
      setLaoQrStaticTemplate(res.normalizedTemplate);
      const url = await QRCode.toDataURL(res.previewPayload, {
        width: 176,
        margin: 1,
        color: { dark: '#202124', light: '#ffffff' },
      });
      setLaoQrPreviewUrl(url);
      setLaoQrPreviewMeta(
        `Tag ${res.merchantAccountTag} · ${res.merchantName || 'LAOQR'} · Dynamic 35,000 ₭ (CRC ${res.previewCrcHex})`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setValidatingLaoQr(false);
    }
  };

  useEffect(() => {
    if (!open || !initialStoreSettings?.storeName) return;
    setBusinessProfile(initialStoreSettings.businessProfile);
    setStoreName(initialStoreSettings.storeName);
    setStoreAddress(initialStoreSettings.storeAddress ?? initialStoreSettings.fiscalConfig?.storeAddress ?? '');
    setTaxId(initialStoreSettings.taxId);
    setBranchCode(initialStoreSettings.branchCode);
    setRdPosRegNo(initialStoreSettings.rdPosRegNo);
    setPromptPayId(initialStoreSettings.promptPayId);
    if (initialStoreSettings.fiscalConfig) {
      setCountryCode(initialStoreSettings.fiscalConfig.countryCode);
      setUiLocale(initialStoreSettings.fiscalConfig.uiLocale);
      setReceiptLocale(initialStoreSettings.fiscalConfig.receiptLocale);
      setVatRateBps(initialStoreSettings.fiscalConfig.vatRateBps);
      setDefaultTaxMode(initialStoreSettings.fiscalConfig.defaultTaxMode);
      setCashRoundingStepMajor(initialStoreSettings.fiscalConfig.cashRoundingStepMajor);
      setLaoQrStaticTemplate(initialStoreSettings.fiscalConfig.laoQrStaticTemplate);
      setLaoQrVerificationPolicy(initialStoreSettings.fiscalConfig.laoQrVerificationPolicy);
      if (initialStoreSettings.fiscalConfig.fxRates) {
        setFxEnabled(initialStoreSettings.fiscalConfig.fxRates.enabled);
        setFxThbRateInput(String(initialStoreSettings.fiscalConfig.fxRates.thbToLakRate));
        setFxUsdRateInput(String(initialStoreSettings.fiscalConfig.fxRates.usdToLakRate));
      }
    }
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

  const handleStep1Next = async () => {
    if (!storeName.trim()) {
      setErrorMsg(pick('กรุณากรอกชื่อร้านค้า', 'ກະລຸນາປ້ອນຊື່ຮ້ານຄ້າ', 'Please enter your store name'));
      return;
    }
    if (countryCode === 'TH') {
      const cleanPp = promptPayId.replace(/\D/g, '');
      if (cleanPp.length !== 10 && cleanPp.length !== 13 && cleanPp.length !== 15) {
        setErrorMsg(
          pick(
            'หมายเลข PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก',
            'ໝາຍເລກ PromptPay ຕ້ອງມີ 10 ຫຼື 13 ຫຼັກ',
            'PromptPay ID must be 10, 13, or 15 digits'
          )
        );
        return;
      }
    } else if (laoQrStaticTemplate.trim()) {
      const check = await posTransport.validateLaoQrTemplate({
        rawTemplate: laoQrStaticTemplate.trim(),
      });
      if (!check.valid) {
        setErrorMsg(
          check.errorReason ||
            pick(
              'แม่แบบ LAOQR ไม่ถูกต้อง (ตรวจ CRC16 ไม่ผ่าน)',
              'ແມ່ແບບ LAOQR ບໍ່ຖືກຕ້ອງ (ກວດ CRC16 ບໍ່ຜ່ານ)',
              'Invalid LAOQR static template'
            )
        );
        return;
      }
    }
    setErrorMsg(null);
    setStep(2);
  };

  const handleStep2Next = () => {
    if (!/^\d{4,8}$/.test(ownerPin)) {
      setErrorMsg(
        pick(
          'รหัส PIN เจ้าของร้านต้องเป็นตัวเลข 4–8 หลัก',
          'ລະຫັດ PIN ເຈົ້າຂອງຮ້ານຕ້ອງເປັນຕົວເລກ 4–8 ຫຼັກ',
          'Owner PIN must be 4–8 digits'
        )
      );
      return;
    }
    if (ownerPin !== ownerPinConfirm) {
      setErrorMsg(
        pick(
          'รหัส PIN ทั้งสองช่องไม่ตรงกัน',
          'ລະຫັດ PIN ທັງສອງຊ່ອງບໍ່ຕົງກັນ',
          'PIN confirmation does not match'
        )
      );
      return;
    }
    if (recoveryPassphrase.trim().length < 12) {
      setErrorMsg(
        pick(
          'รหัสวลีกู้คืนฉุกเฉิน (Recovery Passphrase) ต้องยาวอย่างน้อย 12 ตัวอักษร',
          'ລະຫັດກູ້ຄືນສຸກເສີນ (Recovery Passphrase) ຕ້ອງຍາວຢ່າງໜ້ອຍ 12 ຕົວອັກສອນ',
          'Recovery Passphrase must be at least 12 characters'
        )
      );
      return;
    }
    setErrorMsg(null);
    setStep(3);
  };

  const handleCompleteSetup = async () => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const currencyCode = countryCode === 'LA' ? 'LAK' : 'THB';
      const openingCashSatang = Math.max(
        0,
        parseMoneyInputToMinor(openingCashBaht || '0', currencyCode)
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
        countryCode,
        uiLocale,
        receiptLocale,
        vatRateBps: defaultTaxMode === 'NONE' ? 0 : vatRateBps,
        defaultTaxMode,
        cashRoundingStepMajor: countryCode === 'LA' ? cashRoundingStepMajor : 0,
        scalePriceEmbeddedMultiplier: countryCode === 'LA' ? 10_000 : 1,
        storeName,
        storeAddress,
        taxId,
        branchCode,
        rdPosRegNo,
        promptPayId: countryCode === 'TH' ? promptPayId : '',
        laoQrStaticTemplate: countryCode === 'LA' ? laoQrStaticTemplate.trim() : '',
        laoQrVerificationPolicy,
        fxRates: {
          enabled: countryCode === 'LA' && fxEnabled,
          thbToLakRate: Math.max(1, Math.round(Number(fxThbRateInput.replace(/\D/g, '') || 640))),
          usdToLakRate: Math.max(1, Math.round(Number(fxUsdRateInput.replace(/\D/g, '') || 21500))),
        },
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
            {pick(
              'ตั้งค่าเริ่มต้นสำหรับเครื่องจุดขายจริง',
              'ຕັ້ງຄ່າເລີ່ມຕົ້ນສຳລັບເຄື່ອງ POS ໃຊ້ງານຈິງ',
              'First-Run Production POS Setup'
            )}
          </h1>
          <p className="mt-2 text-sm text-white/75 max-w-xl">
            {pick(
              'กำหนดประเทศ สกุลเงิน ข้อมูลกิจการ รหัส PIN เจ้าของร้าน เครื่องพิมพ์ใบเสร็จ และกุญแจกู้คืนออฟไลน์ 100%',
              'ກຳນົດປະເທດ, ສະກຸນເງິນ, ຂໍ້ມູນຮ້ານ, ລະຫັດ PIN ເຈົ້າຂອງຮ້ານ, ເຄື່ອງພິມໃບບິນ ແລະ ກະແຈກູ້ຄືນອອບໄລນ໌ 100%',
              'Configure country, currency, store profile, owner PIN, thermal printer and offline recovery key.'
            )}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2 text-xs">
            {[
              { n: 1, label: pick('1. ประเทศ & ร้านค้า', '1. ປະເທດ & ຮ້ານຄ້າ', '1. Country & Store') },
              { n: 2, label: pick('2. รหัสเจ้าของร้าน', '2. ລະຫັດເຈົ້າຂອງຮ້ານ', '2. Owner PIN') },
              { n: 3, label: pick('3. เครื่องพิมพ์ & กะแรก', '3. ເຄື່ອງພິມ & ກະທຳອິດ', '3. Printer & Float') },
              { n: 4, label: pick('4. ไฟล์กู้คืน .recovery-kit', '4. ໄຟລ໌ກູ້ຄືນ .recovery-kit', '4. Recovery Kit') },
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
            {/* Country, Currency & Language Selector */}
            <div className="rounded-[8px] border border-hairline bg-surface-1 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Globe className="h-5 w-5 text-primary shrink-0" />
                  <h2 className="font-google-display text-[18px] font-medium text-ink">
                    {pick(
                      'เลือกประเทศ สกุลเงิน และภาษาเริ่มต้น',
                      'ເລືອກປະເທດ, ສະກຸນເງິນ ແລະ ພາສາເລີ່ມຕົ້ນ',
                      'Select Country, Currency & Default Language'
                    )}
                  </h2>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  {(['lo', 'th', 'en'] as const).map((loc) => (
                    <button
                      key={loc}
                      type="button"
                      onClick={() => {
                        setUiLocale(loc);
                        setReceiptLocale(loc);
                      }}
                      className={`h-8 rounded-[48px] border px-3 font-google-display font-medium ${UI_INTERACTION.focusButton} ${
                        uiLocale === loc
                          ? 'border-primary bg-primary text-white'
                          : 'border-hairline bg-canvas text-ink-soft hover:border-primary'
                      }`}
                    >
                      {loc === 'lo' ? 'ລາວ' : loc === 'th' ? 'ไทย' : 'EN'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => handleSelectCountry('TH')}
                  className={`rounded-[4px] border p-4 text-left ${UI_INTERACTION.focusButton} ${
                    countryCode === 'TH'
                      ? 'border-primary bg-primary-soft/60'
                      : 'border-hairline bg-canvas hover:border-primary'
                  }`}
                >
                  <div className="font-google-display text-base font-medium text-ink">
                    ประเทศไทย · THB (฿)
                  </div>
                  <div className="text-xs text-ink-muted mt-1">
                    VAT 7% · ใบกำกับภาษี ABB · PromptPay QR &amp; BOT Slip
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectCountry('LA')}
                  className={`rounded-[4px] border p-4 text-left ${UI_INTERACTION.focusButton} ${
                    countryCode === 'LA'
                      ? 'border-primary bg-primary-soft/60'
                      : 'border-hairline bg-canvas hover:border-primary'
                  }`}
                >
                  <div className="font-google-display text-base font-medium text-ink">
                    ສປປ.ລາວ (สปป.ลาว) · LAK (₭)
                  </div>
                  <div className="text-xs text-ink-muted mt-1">
                    ອມພ / VAT 10% (ຫຼື 0%) · LAOQR / BCEL OnePay · ພາສາລາວ + ປັດເສດເງິນສົດ
                  </div>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <Store className="h-5 w-5 text-primary shrink-0" />
              <h2 className="font-google-display text-[22px] sm:text-[24px] font-normal text-ink">
                {pick(
                  countryCode === 'LA'
                    ? 'เลือกรูปแบบธุรกิจ & ข้อมูลร้านค้า (สปป.ลาว)'
                    : 'เลือกรูปแบบธุรกิจ & ข้อมูลใบกำกับภาษีอย่างย่อ (ABB)',
                  'ເລືອກຮູບແບບທຸລະກິດ & ຂໍ້ມູນໃບບິນຮ້ານຄ້າ (ສປປ.ລາວ)',
                  'Business Profile & Fiscal Receipt Info'
                )}
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  id: 'RETAIL' as const,
                  title: pick('ค้าปลีก / ซูเปอร์มาร์เก็ต', 'ຂາຍຍ່ອຍ / ຊູເປີມາເກັດ', 'Retail / Supermarket'),
                  sub: pick('เน้นยิงบาร์โค้ดเร็ว & ตราชั่งสด', 'ເນັ້ນຍິງບາໂຄດໄວ & ຊິງຊັ່ງສົດ', 'Fast barcode & fresh scale'),
                },
                {
                  id: 'HOSPITALITY' as const,
                  title: pick('คาเฟ่ / ร้านอาหาร', 'ຄາເຟ່ / ຮ້ານອາຫານ', 'Café / Restaurant'),
                  sub: pick('ปุ่มสัมผัส, สูตร BOM & จอครัว KDS', 'ປຸ່ມສຳຜັດ, ສູດ BOM & ຈໍຄົວ KDS', 'Touch tiles, BOM & KDS'),
                },
                {
                  id: 'HYBRID' as const,
                  title: pick('ไฮบริดครบวงจร', 'ໄຮບຣິດຄົບວົງຈອນ', 'All-in-One Hybrid'),
                  sub: pick('เปิดใช้งานทุกระบบพร้อมกัน', 'ເປີດໃຊ້ງານທຸກລະບົບພ້ອມກັນ', 'All retail + café modules'),
                },
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
                  {pick('ชื่อร้านค้า / ชื่อบริษัท (แสดงบนหัวใบเสร็จ)', 'ຊື່ຮ້ານຄ້າ / ຊື່ບໍລິສັດ (ສະແດງເທິງຫົວໃບບິນ)', 'Store / Company Name')}
                </label>
                <input
                  id={`${uid}-store-name`}
                  type="text"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink ${UI_INTERACTION.focusControl}`}
                />
              </div>
              {countryCode === 'LA' && (
                <div className="sm:col-span-2">
                  <label htmlFor={`${uid}-store-addr`} className="block text-xs font-medium text-ink-muted mb-1">
                    {pick('ที่อยู่ร้าน (แสดงบนใบเสร็จ สปป.ลาว)', 'ທີ່ຢູ່ຮ້ານ (ສະແດງເທິງໃບບິນ — ບ້ານ / ເມືອງ / ແຂວງ)', 'Store Address (printed on receipt)')}
                  </label>
                  <input
                    id={`${uid}-store-addr`}
                    type="text"
                    placeholder={pick('เช่น บ้านสีหอม เมืองจันทะบูลี นครหลวงเวียงจันทน์', 'ເຊັ່ນ ບ້ານສີຫອມ, ເມືອງຈັນທະບູລີ, ນະຄອນຫຼວງວຽງຈັນ', 'e.g. Chanthabouly, Vientiane')}
                    value={storeAddress}
                    onChange={(e) => setStoreAddress(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                  />
                </div>
              )}
              <div>
                <label htmlFor={`${uid}-tax-id`} className="block text-xs font-medium text-ink-muted mb-1">
                  {countryCode === 'LA'
                    ? pick('เลขประจำตัวผู้เสียภาษี (TIN 12 หลัก / ไม่บังคับหากยกเว้น)', 'ເລກປະຈຳຕົວຜູ້ເສຍອາກອນ (TIN 12 ຫຼັກ)', 'Lao Tax ID (TIN)')
                    : 'เลขประจำตัวผู้เสียภาษี 13 หลัก'}
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
                <label htmlFor={`${uid}-rd-reg`} className="block text-xs font-medium text-ink-muted mb-1">
                  {countryCode === 'LA'
                    ? pick('เลขทะเบียนเครื่อง POS / TaxRIS', 'ເລກທະບຽນເຄື່ອງ POS / TaxRIS', 'POS / TaxRIS Terminal No.')
                    : 'เลขทะเบียนเครื่อง POS กรมสรรพากร'}
                </label>
                <input
                  id={`${uid}-rd-reg`}
                  type="text"
                  value={rdPosRegNo}
                  onChange={(e) => setRdPosRegNo(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline px-4 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>

              {countryCode === 'TH' ? (
                <>
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
                </>
              ) : (
                <>
                  <div>
                    <label htmlFor={`${uid}-lao-vat`} className="block text-xs font-medium text-ink-muted mb-1">
                      {pick('อัตราภาษีมูลค่าเพิ่ม (อพ. / VAT สปป.ลาว)', 'ອັດຕາອາກອນມູນຄ່າເພີ່ມ (ອມພ / VAT)', 'Laos VAT Rate')}
                    </label>
                    <select
                      id={`${uid}-lao-vat`}
                      value={defaultTaxMode === 'NONE' ? 'NONE' : `${vatRateBps}:${defaultTaxMode}`}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'NONE') {
                          setDefaultTaxMode('NONE');
                          setVatRateBps(0);
                        } else {
                          const [bpsStr, modeStr] = val.split(':');
                          setVatRateBps(Number(bpsStr) || 1000);
                          setDefaultTaxMode((modeStr as TaxMode) || 'INCLUSIVE');
                        }
                      }}
                      className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-4 text-ink ${UI_INTERACTION.focusSelect}`}
                    >
                      <option value="1000:INCLUSIVE">
                        {pick('VAT 10% รวมในราคา (มาตรฐาน สปป.ลาว)', 'ອມພ 10% ລວມໃນລາຄາ (ມາດຕະຖານ ສປປ.ລາວ)', 'VAT 10% Inclusive (Standard Laos)')}
                      </option>
                      <option value="1000:EXCLUSIVE">
                        {pick('VAT 10% แยกนอก (+10% ท้ายบิล)', 'ອມພ 10% ແຍກນອກ (+10% ທ້າຍບິນ)', 'VAT 10% Exclusive')}
                      </option>
                      <option value="NONE">
                        {pick('0% ยกเว้น / นอกระบบ VAT (ร้านเล็ก)', '0% ຍົກເວັ້ນ / ນອກລະບົບ ອມພ (ຮ້ານຂະໜາດນ້ອຍ)', '0% VAT Exempt (Small Shop)')}
                      </option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`${uid}-lao-rounding`} className="block text-xs font-medium text-ink-muted mb-1">
                      {pick('นโยบายปัดเศษเงินสด (LAK ไม่มีเหรียญ)', 'ນະໂຍບາຍປັດເສດເງິນສົດ (ເງິນກີບ LAK)', 'LAK Cash Rounding Policy')}
                    </label>
                    <select
                      id={`${uid}-lao-rounding`}
                      value={cashRoundingStepMajor}
                      onChange={(e) =>
                        setCashRoundingStepMajor(Number(e.target.value) as CashRoundingStepMajor)
                      }
                      className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-4 text-ink ${UI_INTERACTION.focusSelect}`}
                    >
                      <option value={0}>{pick('ไม่ปัดเศษ (คิดตามจริง)', 'ບໍ່ປັດເສດ (ຄິດຕາມຈິງ)', 'No rounding')}</option>
                      <option value={500}>{pick('ปัดเศษลงทุก 500 ₭ (แนะนำ)', 'ປັດເສດລົງທຸກ 500 ₭ (ແນະນຳ)', 'Round down to 500 ₭ (Recommended)')}</option>
                      <option value={1000}>{pick('ปัดเศษลงทุก 1,000 ₭', 'ປັດເສດລົງທຸກ 1,000 ₭', 'Round down to 1,000 ₭')}</option>
                    </select>
                  </div>

                  {/* Static LAOQR / BCEL OnePay Import */}
                  <div className="sm:col-span-2 rounded-[8px] border border-primary/40 bg-canvas p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-primary-dark font-medium text-xs">
                        <QrCode className="h-4 w-4 shrink-0" />
                        <span>
                          {pick(
                            'นำเข้าแม่แบบ Static LAOQR / BCEL OnePay (สแกนหรือวางข้อความจาก QR ร้าน — ตั้งทีหลังได้)',
                            'ນຳເຂົ້າແມ່ແບບ Static LAOQR / BCEL OnePay (ສະແກນ ຫຼື ວາງຂໍ້ຄວາມ QR ຂອງຮ້ານ — ຕັ້ງພາຍຫຼັງໄດ້)',
                            'Import Static LAOQR / BCEL OnePay Template (Optional now)'
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={validatingLaoQr}
                        onClick={() => void handleValidateOrSampleLaoQr(true)}
                        className={`h-8 rounded-[48px] border border-hairline bg-surface-1 px-3 text-xs font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
                      >
                        {pick('สร้าง LAOQR ทดสอบ', 'ສ້າງ LAOQR ທົດສອບ', 'Generate Sample LAOQR')}
                      </button>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        id={`${uid}-laoqr-tpl`}
                        type="text"
                        placeholder="00020101021138...53034185802LA...6304XXXX"
                        value={laoQrStaticTemplate}
                        onChange={(e) => setLaoQrStaticTemplate(e.target.value)}
                        className={`h-11 flex-1 rounded-[4px] border border-hairline px-3 text-xs text-ink font-mono-num placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                      />
                      <button
                        type="button"
                        disabled={validatingLaoQr || !laoQrStaticTemplate.trim()}
                        onClick={() => void handleValidateOrSampleLaoQr(false)}
                        className={`h-11 rounded-[48px] border border-primary bg-primary-soft px-4 text-xs font-medium text-primary-dark hover:bg-primary hover:text-white disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
                      >
                        {pick('ตรวจ & ทดสอบ Dynamic QR', 'ກວດ & ທົດສອບ Dynamic QR', 'Validate & Preview')}
                      </button>
                    </div>
                    {laoQrPreviewUrl && (
                      <div className="flex items-center gap-4 rounded-[4px] border border-hairline bg-surface-1 p-3">
                        <img
                          src={laoQrPreviewUrl}
                          alt="Dynamic LAOQR Preview"
                          className="h-20 w-20 rounded-[4px] border border-hairline bg-white p-1 shrink-0"
                        />
                        <div className="text-xs space-y-1">
                          <div className="font-medium text-ink">
                            {pick(
                              'ผ่านการตรวจสอบ EMVCo LAOQR (พร้อมสร้างยอดอัตโนมัติแบบออฟไลน์ 100%)',
                              'ຜ່ານການກວດສອບ EMVCo LAOQR (ພ້ອມສ້າງຍອດເງິນອັດຕະໂນມັດແບບອອບໄລນ໌ 100%)',
                              'Valid EMVCo LAOQR Template (100% Offline Dynamic QR Ready)'
                            )}
                          </div>
                          <div className="text-ink-muted tabular-nums-google">{laoQrPreviewMeta}</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Optional Phase 5: Multi-Currency FX Cash Tender */}
                  <div className="sm:col-span-2 rounded-[8px] border border-hairline bg-surface-1 p-4 space-y-3">
                    <label className="flex items-center gap-2.5 text-xs font-medium text-ink cursor-pointer">
                      <input
                        type="checkbox"
                        checked={fxEnabled}
                        onChange={(e) => setFxEnabled(e.target.checked)}
                        className="accent-primary"
                      />
                      <span>
                        {pick(
                          'เปิดรับชำระเงินสดหลายสกุลเงิน (บาทไทย THB / ดอลลาร์ USD ทอนเป็นกีบ LAK)',
                          'ເປີດຮັບຊຳລະເງິນສົດຫຼາຍສະກຸນເງິນ (ບາດໄທ THB / ໂດລາ USD ທອນເປັນກີບ LAK)',
                          'Enable Multi-Currency Cash Tender (THB / USD -> Change in LAK)'
                        )}
                      </span>
                    </label>
                    {fxEnabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        <div>
                          <label htmlFor={`${uid}-wiz-fx-thb`} className="block text-ink-muted mb-1">
                            {pick('1 บาทไทย (THB) = กี่กีบ (LAK)', '1 ບາດໄທ (THB) = ຈັກກີບ (LAK)', '1 THB = LAK')}
                          </label>
                          <input
                            id={`${uid}-wiz-fx-thb`}
                            type="text"
                            inputMode="numeric"
                            value={fxThbRateInput}
                            onChange={(e) => setFxThbRateInput(e.target.value.replace(/\D/g, '').slice(0, 7))}
                            className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                          />
                        </div>
                        <div>
                          <label htmlFor={`${uid}-wiz-fx-usd`} className="block text-ink-muted mb-1">
                            {pick('1 ดอลลาร์ (USD) = กี่กีบ (LAK)', '1 ໂດລາ (USD) = ຈັກກີບ (LAK)', '1 USD = LAK')}
                          </label>
                          <input
                            id={`${uid}-wiz-fx-usd`}
                            type="text"
                            inputMode="numeric"
                            value={fxUsdRateInput}
                            onChange={(e) => setFxUsdRateInput(e.target.value.replace(/\D/g, '').slice(0, 8))}
                            className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Clean DB vs Sample Data Selector */}
            <div className="rounded-[8px] bg-primary-soft p-4 space-y-2">
              <div className="font-google-display text-sm font-medium text-ink">
                {pick('โหมดข้อมูลตั้งต้นในฐานข้อมูล', 'ໂໝດຂໍ້ມູນເລີ່ມຕົ້ນໃນຖານຂໍ້ມູນ', 'Initial Database Mode')}
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
                      {pick('ฐานข้อมูลเปล่าสำหรับเปิดร้านจริง (แนะนำ)', 'ຖານຂໍ້ມູນເປົ່າສຳລັບເປີດຮ້ານຈິງ (ແນະນຳ)', 'Clean Production Start (Recommended)')}
                    </div>
                    <div className="text-xs text-ink-muted">
                      {pick('ไม่มีสินค้าตัวอย่างปะปน พร้อมให้คีย์สินค้าจริงทันที', 'ບໍ່ມີສິນຄ້າຕົວຢ່າງປົນ ພ້ອມເພີ່ມສິນຄ້າຈິງທັນທີ', 'No sample clutter; ready for real items')}
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
                      {pick('โหลดชุดสินค้าตัวอย่างเพื่อฝึกใช้งาน', 'ໂຫຼດຊຸດສິນຄ້າຕົວຢ່າງເພື່ອທົດລອງ', 'Load Demo Sample Catalog')}
                    </div>
                    <div className="text-xs text-ink-muted">
                      {countryCode === 'LA'
                        ? pick('สร้างตัวอย่างกาแฟลาว 35,000 ₭, เบียร์ลาว, หมูสามชั้นชั่งกิโล', 'ສ້າງຕົວຢ່າງ ກາເຟເຢັນລາວ 35,000 ₭, ເບຍລາວ, ຊີ້ນໝູຊັ່ງກິໂລ', 'Creates Lao coffee 35,000 ₭, Beerlao & weighted pork')
                        : 'สร้างเมนูชานมไข่มุก น้ำดื่ม และหมูสามชั้นชั่งกิโลสำหรับทดสอบ'}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleStep1Next()}
                className={`h-[50px] rounded-[48px] bg-primary px-8 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ถัดไป: ตั้งรหัสผ่านเจ้าของร้าน', 'ຕໍ່ໄປ: ຕັ້ງລະຫັດ PIN ເຈົ້າຂອງຮ້ານ', 'Next: Owner PIN & Recovery')}
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
                  {countryCode === 'LA'
                    ? pick('เงินสดทอนตั้งต้นในลิ้นชักกะแรก (กีบ ₭)', 'ເງິນສົດທອນຕັ້ງຕົ້ນໃນລິ້ນຊັກກະທຳອິດ (ກີບ ₭)', 'Initial Opening Cash Float (LAK ₭)')
                    : 'เงินสดทอนตั้งต้นในลิ้นชักกะแรก (บาท)'}
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
