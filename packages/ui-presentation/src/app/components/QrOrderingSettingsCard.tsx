import React, { useEffect, useId, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Nfc,
  Printer,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react';
import {
  buildNfcTableTagPackage,
  buildWifiQrPayload,
  buildWifiWscCredentialBytes,
  DEFAULT_QR_ORDERING_CONFIG,
  NFC_CHIP_USABLE_NDEF_BYTES,
  normalizeTableLabels,
  sanitizeGuestText,
  sanitizeHostOverride,
  type NfcRecordLayout,
  type NfcTableTagPackageDto,
  type NfcTagChipType,
  type NfcTagMode,
  type QrOrderApprovalMode,
  type QrOrderingConfigDto,
  type QrOrderingRuntimeStatusDto,
  type QrWifiSecurityType,
  type TableQrSessionDto,
} from '../../../../shared-contracts/src/qr-ordering.ts';
import { posTransport } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type { BootstrapPayload } from '../types.ts';
import { openA4TableQrPrintWindow } from '../utils/a4-qr-sheet-printer.ts';
import { downloadUtf8BomCsv } from '../utils/csv-exporter.ts';
import {
  isWebNfcSupported,
  writeNfcPackageViaBrowserReader,
} from '../utils/web-nfc-writer.ts';
import { UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface QrOrderingSettingsCardProps {
  outletId: string;
  bootstrap: BootstrapPayload;
  canManage: boolean;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const QrOrderingSettingsCard: React.FC<QrOrderingSettingsCardProps> = ({
  outletId,
  bootstrap,
  canManage,
  onRefreshState,
  onToast,
}) => {
  const { fiscal, pick } = useI18n();
  const uid = useId();

  const initialCfg: QrOrderingConfigDto =
    bootstrap.qrOrderingConfig ?? DEFAULT_QR_ORDERING_CONFIG;

  const [enabled, setEnabled] = useState<boolean>(initialCfg.enabled);
  const [portInput, setPortInput] = useState<string>(String(initialCfg.port));
  const [wifiSsid, setWifiSsid] = useState<string>(initialCfg.wifiSsid);
  const [wifiPassword, setWifiPassword] = useState<string>(initialCfg.wifiPassword);
  const [wifiSecurity, setWifiSecurity] = useState<QrWifiSecurityType>(initialCfg.wifiSecurity);
  const [approvalMode, setApprovalMode] = useState<QrOrderApprovalMode>(initialCfg.approvalMode);
  const [allowOpenTableSelection, setAllowOpenTableSelection] = useState<boolean>(
    initialCfg.allowOpenTableSelection
  );
  const [maxQtyPerItem, setMaxQtyPerItem] = useState<string>(String(initialCfg.maxQtyPerItem));
  const [customHostOverride, setCustomHostOverride] = useState<string>(
    initialCfg.customHostOverride
  );
  const [tablesText, setTablesText] = useState<string>(initialCfg.tableLabels.join(', '));
  const [nfcEnabled, setNfcEnabled] = useState<boolean>(Boolean(initialCfg.nfcEnabled));
  const [nfcTagMode, setNfcTagMode] = useState<NfcTagMode>(
    initialCfg.nfcTagMode ?? 'STATIC_TABLE'
  );
  const [nfcRecordLayout, setNfcRecordLayout] = useState<NfcRecordLayout>(
    initialCfg.nfcRecordLayout ?? 'URI_ONLY'
  );
  const [nfcChipType, setNfcChipType] = useState<NfcTagChipType>(
    initialCfg.nfcChipType ?? 'NTAG215'
  );
  const [runtimeStatus, setRuntimeStatus] = useState<QrOrderingRuntimeStatusDto | undefined>(
    bootstrap.qrOrderingStatus
  );
  const [tableSessions, setTableSessions] = useState<TableQrSessionDto[]>(
    bootstrap.qrTableSessions ?? []
  );
  const [wifiQrPreviewUrl, setWifiQrPreviewUrl] = useState<string | null>(null);
  const [showRouterGuide, setShowRouterGuide] = useState<boolean>(false);
  const [showNfcTagsPanel, setShowNfcTagsPanel] = useState<boolean>(false);
  const [bridgeQrTableLabel, setBridgeQrTableLabel] = useState<string | null>(null);
  const [bridgeQrDataUrl, setBridgeQrDataUrl] = useState<string | null>(null);
  const [writingNfcTable, setWritingNfcTable] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const webNfcAvailable = isWebNfcSupported();
  const nfcWriteAbortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      nfcWriteAbortRef.current?.abort();
      nfcWriteAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    nfcWriteAbortRef.current?.abort();
    nfcWriteAbortRef.current = null;
  }, [outletId]);

  const applyConfigToForm = (cfg: QrOrderingConfigDto) => {
    setEnabled(cfg.enabled);
    setPortInput(String(cfg.port));
    setWifiSsid(cfg.wifiSsid);
    setWifiPassword(cfg.wifiPassword);
    setWifiSecurity(cfg.wifiSecurity);
    setApprovalMode(cfg.approvalMode);
    setAllowOpenTableSelection(cfg.allowOpenTableSelection);
    setMaxQtyPerItem(String(cfg.maxQtyPerItem));
    setCustomHostOverride(cfg.customHostOverride);
    setTablesText(cfg.tableLabels.join(', '));
    setNfcEnabled(Boolean(cfg.nfcEnabled));
    setNfcTagMode(cfg.nfcTagMode ?? 'STATIC_TABLE');
    setNfcRecordLayout(cfg.nfcRecordLayout ?? 'URI_ONLY');
    setNfcChipType(cfg.nfcChipType ?? 'NTAG215');
  };

  const cfgSyncKey = JSON.stringify(bootstrap.qrOrderingConfig ?? DEFAULT_QR_ORDERING_CONFIG);
  useEffect(() => {
    applyConfigToForm(bootstrap.qrOrderingConfig ?? DEFAULT_QR_ORDERING_CONFIG);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgSyncKey]);

  useEffect(() => {
    setRuntimeStatus(bootstrap.qrOrderingStatus);
    setTableSessions(bootstrap.qrTableSessions ?? []);
  }, [bootstrap.qrOrderingStatus, bootstrap.qrTableSessions]);

  const parsedPort = Math.max(1024, Math.min(65535, Number(portInput.replace(/\D/g, '')) || 4174));
  const effectivePort = parsedPort === 4173 ? 4174 : parsedPort;
  const firewallCmd = `netsh advfirewall firewall add rule name="RUBE-POS Guest QR ${effectivePort}" dir=in action=allow protocol=TCP localport=${effectivePort}`;
  const effectiveTablesList = normalizeTableLabels(tablesText);
  const sanitizedHostOverride = sanitizeHostOverride(customHostOverride);
  const effectiveHost =
    sanitizedHostOverride || runtimeStatus?.detectedLanIpv4s[0] || '127.0.0.1';
  const urlFormattedHost =
    effectiveHost.includes(':') && !effectiveHost.startsWith('[')
      ? `[${effectiveHost}]`
      : effectiveHost;
  const effectiveBaseUrl = `http://${urlFormattedHost}:${effectivePort}`;
  const liveEffectiveCfg: QrOrderingConfigDto = {
    enabled,
    port: effectivePort,
    wifiSsid: sanitizeGuestText(wifiSsid, 64),
    wifiPassword: wifiSecurity === 'NOPASS' ? '' : sanitizeGuestText(wifiPassword, 64),
    wifiSecurity,
    approvalMode,
    tableLabels: effectiveTablesList,
    maxQtyPerItem: Math.max(1, Math.min(99, Number(maxQtyPerItem.replace(/\D/g, '')) || 20)),
    allowOpenTableSelection,
    customHostOverride: sanitizedHostOverride,
    nfcEnabled,
    nfcTagMode,
    nfcRecordLayout,
    nfcChipType,
  };
  const sessionByUpper = new Map(
    tableSessions.map((s) => [s.tableLabel.trim().toUpperCase(), s])
  );
  const nfcPackages: NfcTableTagPackageDto[] = effectiveTablesList.map((tableLabel) =>
    buildNfcTableTagPackage({
      baseUrl: effectiveBaseUrl,
      tableLabel,
      outletId,
      signedToken: sessionByUpper.get(tableLabel.trim().toUpperCase())?.token ?? null,
      config: liveEffectiveCfg,
    })
  );
  const rawBridgePkg = bridgeQrTableLabel
    ? (nfcPackages.find((p) => p.tableLabel.toUpperCase() === bridgeQrTableLabel.toUpperCase()) ??
      null)
    : null;
  const activeBridgePkg =
    rawBridgePkg &&
    rawBridgePkg.recordLayout !== 'WIFI_WSC_ONLY' &&
    !(rawBridgePkg.tagMode === 'SIGNED_SESSION' && !rawBridgePkg.signedSessionActive)
      ? rawBridgePkg
      : null;

  useEffect(() => {
    if (bridgeQrTableLabel !== null && !activeBridgePkg) {
      setBridgeQrTableLabel(null);
    }
  }, [bridgeQrTableLabel, activeBridgePkg]);

  useEffect(() => {
    if (!activeBridgePkg?.menuUrl) {
      setBridgeQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(activeBridgePkg.menuUrl, {
      width: 164,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!cancelled) setBridgeQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setBridgeQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeBridgePkg?.menuUrl]);
  useEffect(() => {
    const payload = buildWifiQrPayload(wifiSsid, wifiPassword, wifiSecurity);
    if (!payload) {
      setWifiQrPreviewUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(payload, { width: 140, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setWifiQrPreviewUrl(url);
      })
      .catch(() => {
        if (!cancelled) setWifiQrPreviewUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wifiSsid, wifiPassword, wifiSecurity]);

  const wifiWscPreviewBytes = buildWifiWscCredentialBytes(
    liveEffectiveCfg.wifiSsid,
    liveEffectiveCfg.wifiPassword,
    liveEffectiveCfg.wifiSecurity
  );
  const hasUsableWifiWsc = wifiWscPreviewBytes.length > 0;
  const isWscLayoutRequested =
    nfcRecordLayout === 'WIFI_WSC_ONLY' || nfcRecordLayout === 'URI_AND_WIFI_WSC';
  const missingWifiWscWarning = nfcEnabled && isWscLayoutRequested && !hasUsableWifiWsc;
  const staticWithoutOpenTableWarning =
    nfcEnabled && nfcTagMode === 'STATIC_TABLE' && !allowOpenTableSelection;
  const unopenedSignedCount =
    nfcEnabled && nfcTagMode === 'SIGNED_SESSION'
      ? nfcPackages.filter((p) => !p.signedSessionActive).length
      : 0;

  const handleSave = async () => {
    nfcWriteAbortRef.current?.abort();
    nfcWriteAbortRef.current = null;
    setBusy(true);
    try {
      const tableLabels = normalizeTableLabels(tablesText);
      const res = await posTransport.saveQrOrderingConfig({
        outletId,
        enabled,
        port: effectivePort,
        wifiSsid: wifiSsid.trim(),
        wifiPassword: wifiSecurity === 'NOPASS' ? '' : wifiPassword.trim(),
        wifiSecurity,
        approvalMode,
        allowOpenTableSelection,
        maxQtyPerItem: Math.max(1, Math.min(99, Number(maxQtyPerItem.replace(/\D/g, '')) || 20)),
        customHostOverride: sanitizedHostOverride,
        tableLabels,
        nfcEnabled,
        nfcTagMode,
        nfcRecordLayout,
        nfcChipType,
      });
      if (isMountedRef.current) {
        applyConfigToForm(res.config);
        setRuntimeStatus(res.status);
        setTableSessions(res.tableSessions);
      }
      await onRefreshState();
      onToast(
        res.status.running
          ? pick(
              `เปิดเซิร์ฟเวอร์ QR ลูกค้าบนวง LAN สำเร็จที่ ${res.status.baseUrl}`,
              `ເປີດເຊີບເວີ QR ລູກຄ້າໃນວົງ LAN ສຳເລັດທີ່ ${res.status.baseUrl}`,
              `Guest QR LAN server is live at ${res.status.baseUrl}`
            )
          : pick(
              'บันทึกการตั้งค่า Local QR Table Ordering แล้ว (ปิดพอร์ตลูกค้าเรียบร้อย)',
              'ບັນທຶກການຕັ້ງຄ່າ Local QR Table Ordering ແລ້ວ',
              'Local QR Table Ordering settings saved (Guest port stopped)'
            ),
        res.status.lastError ? 'warn' : 'success'
      );
      if (res.status.lastError) {
        onToast(res.status.lastError, 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePrintA4Sheet = async () => {
    setBusy(true);
    try {
      const opened = await openA4TableQrPrintWindow({
        outletId,
        storeName: bootstrap.storeSettings.storeName,
        locale: fiscal.receiptLocale,
        baseUrl: effectiveBaseUrl,
        config: liveEffectiveCfg,
        activeSessions: tableSessions,
      });
      if (!opened) {
        onToast(
          pick(
            'เบราว์เซอร์บล็อกหน้าต่างป๊อปอัป กรุณาอนุญาตป๊อปอัปเพื่อพิมพ์ป้าย QR A4',
            'ບຣາວເຊີບລັອກໜ້າຕ່າງປັອບອັບ ກະລຸນາອະນຸຍາດເພື່ອພິມປ້າຍ QR A4',
            'Popup blocked — please allow popups to print A4 Table QR Cards'
          ),
          'warn'
        );
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${pick('คัดลอกแล้ว:', 'ຄັດລອກແລ້ວ:', 'Copied:')} ${label}`, 'success');
    } catch {
      onToast(text, 'warn');
    }
  };

  const handleDownloadNfcExport = (format: 'csv' | 'json') => {
    if (format === 'csv') {
      downloadUtf8BomCsv(
        `rube-nfc-table-tags-${outletId.toLowerCase()}.csv`,
        [
          'tableLabel',
          'recordLayout',
          'chipType',
          'ndefByteLength',
          'fitsSelectedChip',
          'menuUrl',
          'ndefType2TlvHex',
          'wscBase64',
        ],
        nfcPackages.map((p) => [
          p.tableLabel,
          p.recordLayout,
          p.chipType,
          p.ndefByteLength,
          p.fitsSelectedChip ? 'YES' : 'NO',
          p.recordLayout === 'WIFI_WSC_ONLY' ? '' : p.menuUrl,
          p.ndefType2TlvHex,
          p.wscBase64 ?? '',
        ])
      );
    } else {
      const content = JSON.stringify(
        {
          generatedAtIso: new Date().toISOString(),
          outletId,
          baseUrl: effectiveBaseUrl,
          wifiSsid: liveEffectiveCfg.wifiSsid,
          nfcTagMode,
          nfcRecordLayout,
          nfcChipType,
          tags: nfcPackages,
        },
        null,
        2
      );
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rube-nfc-table-tags-${outletId.toLowerCase()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    onToast(
      pick(
        `ดาวน์โหลดไฟล์รายการแท็ก NFC (${format.toUpperCase()}) แล้ว`,
        `ດາວໂຫຼດໄຟລ໌ລາຍການແທັກ NFC (${format.toUpperCase()}) ແລ້ວ`,
        `Exported NFC table tags (${format.toUpperCase()})`
      ),
      'success'
    );
  };

  const handleWriteBrowserNfcTag = async (pkg: NfcTableTagPackageDto) => {
    if (writingNfcTable !== null) return;
    nfcWriteAbortRef.current?.abort();
    const controller = new AbortController();
    nfcWriteAbortRef.current = controller;
    setWritingNfcTable(pkg.tableLabel);
    try {
      const res = await writeNfcPackageViaBrowserReader(
        pkg,
        25_000,
        controller.signal
      );
      if (!isMountedRef.current || controller.signal.aborted) return;
      onToast(
        pick(
          `เขียนแท็ก NFC โต๊ะ ${pkg.tableLabel} สำเร็จ (${res.recordsCount} records · ${res.ndefByteLength} Bytes)`,
          `ຂຽນແທັກ NFC ໂຕະ ${pkg.tableLabel} ສຳເລັດ (${res.ndefByteLength} Bytes)`,
          `Wrote NFC tag for ${pkg.tableLabel} (${res.ndefByteLength} bytes)`
        ),
        'success'
      );
    } catch (err) {
      if (isMountedRef.current && !controller.signal.aborted) {
        onToast(err instanceof Error ? err.message : String(err), 'error');
      }
    } finally {
      if (nfcWriteAbortRef.current === controller) {
        nfcWriteAbortRef.current = null;
      }
      if (isMountedRef.current) {
        setWritingNfcTable(null);
      }
    }
  };

  return (
    <section className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2.5">
            <Wifi className="h-5 w-5 text-primary" />
            <span>
              {pick(
                'ระบบสแกนสั่งอาหารผ่าน Wi-Fi วง LAN (Local QR Table Ordering & Captive Portal)',
                'ລະບົບສະແກນສັ່ງອາຫານຜ່ານ Wi-Fi ວົງ LAN (Local QR Table Ordering & Captive Portal)',
                'Local LAN QR Table Ordering & Captive Portal'
              )}
            </span>
          </h3>
          <p className="text-xs text-ink-muted max-w-3xl">
            {pick(
              'แยกพอร์ตลูกค้าอิสระ (Port 4174) ออกจากระบบ POS หลัก (127.0.0.1:4173) แบบ Zero-Trust 100% ออฟไลน์ ไม่ต้องเช่า Cloud — ลูกค้าสแกน Wi-Fi QR / QR โต๊ะ สั่งเมนูผ่านมือถือแล้วยิงเข้าคิวแคชเชียร์ + บิลโต๊ะ + จอครัว KDS ทันที',
              'ແຍກພອດລູກຄ້າອິດສະຫຼະ (Port 4174) ອອກຈາກລະບົບ POS ຫຼັກ (127.0.0.1:4173) ແບບ Zero-Trust 100% ອອບລາຍ ບໍ່ຕ້ອງເຊົ່າ Cloud',
              'Zero-Trust isolated Guest LAN server (Port 4174) completely separated from loopback POS core (127.0.0.1:4173). 100% offline with Captive Portal probe redirect.'
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-[48px] border px-3 py-1 text-xs font-medium ${
              runtimeStatus?.running
                ? 'border-primary bg-primary-soft text-primary-dark'
                : 'border-hairline bg-surface-1 text-ink-muted'
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              {runtimeStatus?.running
                ? pick('กำลังทำงาน (LIVE)', 'ກຳລັງເຮັດວຽກ (LIVE)', 'RUNNING (LIVE)')
                : pick('ปิดอยู่ (OFF)', 'ປິດຢູ່ (OFF)', 'STOPPED (OFF)')}
            </span>
          </span>

          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={!canManage || busy}
            onClick={() => setEnabled((prev) => !prev)}
            className={`min-h-[40px] rounded-[48px] border px-4 font-google-display text-xs font-medium ${UI_INTERACTION.focusButton} ${
              enabled
                ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                : 'border-hairline bg-canvas text-ink hover:border-primary hover:text-primary'
            }`}
          >
            {enabled
              ? pick('เปิดเซิร์ฟเวอร์ลูกค้า', 'ເປີດເຊີບເວີລູກຄ້າ', 'Enabled')
              : pick('ปิดเซิร์ฟเวอร์ลูกค้า', 'ປິດເຊີບເວີລູກຄ້າ', 'Disabled')}
          </button>
        </div>
      </div>

      {/* Live Network URL & Security Banner */}
      <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
            <span className="font-medium text-ink">
              {pick('ลิงก์หน้าเมนู Local ของร้าน:', 'ລິ້ງໜ້າເມນູ Local ຂອງຮ້ານ:', 'Local Guest Menu URL:')}
            </span>
            <code className="rounded-[4px] border border-hairline bg-canvas px-2 py-0.5 font-mono-num text-primary-dark">
              {`${effectiveBaseUrl}/m`}
            </code>
          </div>
          {runtimeStatus && runtimeStatus.detectedLanIpv4s.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-ink-muted">
              <span>{pick('IP วง LAN ที่ตรวจพบ:', 'IP ວົງ LAN ທີ່ກວດພົບ:', 'Detected LAN IPs:')}</span>
              {runtimeStatus.detectedLanIpv4s.map((ip) => (
                <button
                  key={ip}
                  type="button"
                  disabled={!canManage}
                  onClick={() => setCustomHostOverride(ip)}
                  className="rounded-[48px] border border-hairline bg-canvas px-2.5 py-0.5 text-[11px] font-mono-num text-ink hover:border-primary hover:text-primary"
                >
                  {ip}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {runtimeStatus?.running && (
            <a
              href={`${runtimeStatus.baseUrl}/m`}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>{pick('เปิดหน้าเมนูทดสอบ', 'ເປີດໜ້າເມນູທົດສອບ', 'Open Guest Menu')}</span>
            </a>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void handlePrintA4Sheet()}
            className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-primary bg-primary-soft px-4 text-xs font-medium text-primary-dark hover:bg-primary hover:text-white ${UI_INTERACTION.focusButton}`}
          >
            <Printer className="h-3.5 w-3.5" />
            <span>
              {pick(
                'พิมพ์ป้ายตั้งโต๊ะ A4 ทุกโต๊ะ',
                'ພິມປ້າຍຕັ້ງໂຕະ A4 ທຸກໂຕະ',
                'Print A4 Table QR Cards'
              )}
            </span>
          </button>
        </div>
      </div>

      {/* Config Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 text-xs">
        {/* Wi-Fi QR & Network Settings */}
        <div className="lg:col-span-6 space-y-3 rounded-[4px] border border-hairline p-4">
          <div className="font-medium text-ink flex items-center gap-2">
            <QrCode className="h-4 w-4 text-primary" />
            <span>
              {pick('1. ข้อมูล Guest Wi-Fi & พอร์ตวง LAN', '1. ຂໍ້ມູນ Guest Wi-Fi & ພອດວົງ LAN', '1. Guest Wi-Fi & LAN Port')}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-wifi-ssid`} className="block text-ink-muted mb-1">
                {pick('ชื่อ Wi-Fi ร้าน (SSID)', 'ຊື່ Wi-Fi ຮ້ານ (SSID)', 'Store Wi-Fi SSID')}
              </label>
              <input
                id={`${uid}-wifi-ssid`}
                type="text"
                disabled={!canManage}
                value={wifiSsid}
                onChange={(e) => setWifiSsid(e.target.value)}
                placeholder="Cafe_Free_WiFi"
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-wifi-sec`} className="block text-ink-muted mb-1">
                {pick('การเข้ารหัส Wi-Fi', 'ການເຂົ້າລະຫັດ Wi-Fi', 'Wi-Fi Security')}
              </label>
              <select
                id={`${uid}-wifi-sec`}
                disabled={!canManage}
                value={wifiSecurity}
                onChange={(e) => setWifiSecurity(e.target.value as QrWifiSecurityType)}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
              >
                <option value="WPA">WPA / WPA2 / WPA3 (มีรหัสผ่าน)</option>
                <option value="NOPASS">Open Wi-Fi (ไม่มีรหัสผ่าน)</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-wifi-pass`} className="block text-ink-muted mb-1">
                {pick('รหัสผ่าน Wi-Fi', 'ລະຫັດຜ່ານ Wi-Fi', 'Wi-Fi Password')}
              </label>
              <input
                id={`${uid}-wifi-pass`}
                type="text"
                disabled={!canManage || wifiSecurity === 'NOPASS'}
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
                placeholder={wifiSecurity === 'NOPASS' ? '—' : '12345678'}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-qr-port`} className="block text-ink-muted mb-1">
                {pick('พอร์ตลูกค้า (แยกจาก 4173)', 'ພອດລູກຄ້າ (ແຍກຈາກ 4173)', 'Guest Port (not 4173)')}
              </label>
              <input
                id={`${uid}-qr-port`}
                type="text"
                inputMode="numeric"
                disabled={!canManage}
                value={portInput}
                onChange={(e) => setPortInput(e.target.value.replace(/\D/g, '').slice(0, 5))}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
              />
              {parsedPort === 4173 && (
                <div className="mt-1 text-[10px] text-danger">
                  {pick(
                    'พอร์ต 4173 สงวนไว้สำหรับ POS หลัก — ระบบจะใช้พอร์ต 4174 แทน',
                    'ພອດ 4173 ສະຫງວນໄວ້ສຳລັບ POS ຫຼັກ — ລະບົບຈະໃຊ້ພອດ 4174 ແທນ',
                    'Port 4173 is reserved for POS core — coerced to 4174'
                  )}
                </div>
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-host-override`} className="block text-ink-muted mb-1">
                {pick(
                  'กำหนด IP เครื่อง POS เอง (เว้นว่างเพื่อตรวจจับ LAN IP อัตโนมัติ)',
                  'ກຳນົດ IP ເຄື່ອງ POS ເອງ (ປະຫວ່າງເພື່ອກວດຈັບ LAN IP ອັດຕະໂນມັດ)',
                  'Manual LAN IP Override (leave blank for auto-detect)'
                )}
              </label>
              <input
                id={`${uid}-host-override`}
                type="text"
                disabled={!canManage}
                value={customHostOverride}
                onChange={(e) => setCustomHostOverride(e.target.value)}
                placeholder={runtimeStatus?.detectedLanIpv4s[0] ?? '192.168.1.50'}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink font-mono-num disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
              />
            </div>
          </div>

          {wifiQrPreviewUrl && (
            <div className="flex items-center gap-3 rounded-[4px] border border-hairline bg-surface-1 p-2.5">
              <img
                src={wifiQrPreviewUrl}
                alt="Store Guest Wi-Fi QR"
                className="h-16 w-16 rounded-[4px] border border-hairline bg-white p-1 shrink-0"
              />
              <div className="text-[11px] text-ink-soft space-y-0.5">
                <div className="font-medium text-ink">Wi-Fi Auto-Join QR ({wifiSsid})</div>
                <div className="text-ink-muted">
                  {pick(
                    'ลูกค้าสแกน QR นี้ด้วยกล้องมือถือ iOS/Android เพื่อเชื่อมต่อ Wi-Fi ร้านอัตโนมัติ',
                    'ລູກຄ້າສະແກນ QR ນີ້ດ້ວຍກ້ອງມືຖື iOS/Android ເພື່ອເຊື່ອມຕໍ່ Wi-Fi ຮ້ານອັດຕະໂນມັດ',
                    'Customers scan with iOS/Android camera to join Store Wi-Fi automatically'
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Approval Mode & Tables */}
        <div className="lg:col-span-6 space-y-3 rounded-[4px] border border-hairline p-4">
          <div className="font-medium text-ink">
            {pick('2. โหมดรับออเดอร์ & รายชื่อโต๊ะในร้าน', '2. ໂໝດຮັບອໍເດີ & ລາຍຊື່ໂຕະໃນຮ້ານ', '2. Order Approval & Table Labels')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-approval-mode`} className="block text-ink-muted mb-1">
                {pick('โหมดการรับออเดอร์ QR', 'ໂໝດການຮັບອໍເດີ QR', 'Order Approval Policy')}
              </label>
              <select
                id={`${uid}-approval-mode`}
                disabled={!canManage}
                value={approvalMode}
                onChange={(e) => setApprovalMode(e.target.value as QrOrderApprovalMode)}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
              >
                <option value="CASHIER_CONFIRM">
                  {pick(
                    'รอแคชเชียร์กดยืนยันก่อนส่งครัว (แนะนำ — ปลอดภัยสุด)',
                    'ລໍຖ້າແຄັດເຊຍກົດຢືນຢັນກ່ອນສົ່ງຄົວ (ແນະນຳ)',
                    'Cashier Confirm Before KDS (Recommended)'
                  )}
                </option>
                <option value="AUTO_ACCEPT_SIGNED_TABLE">
                  {pick(
                    'รับเข้าบิลโต๊ะ + ยิง KDS อัตโนมัติ (เฉพาะ Signed Table QR เท่านั้น)',
                    'ຮັບເຂົ້າບິນໂຕະ + ສົ່ງ KDS ອັດຕະໂນມັດ (ສະເພາະ Signed Table QR)',
                    'Auto-Accept into Table Bill + KDS (Signed Table QR Only)'
                  )}
                </option>
              </select>
            </div>

            <div>
              <label htmlFor={`${uid}-max-qty`} className="block text-ink-muted mb-1">
                {pick('จำกัดจำนวนสูงสุดต่อเมนู', 'ຈຳກັດຈຳນວນສູງສຸດຕໍ່ເມນູ', 'Max Qty / Item')}
              </label>
              <input
                id={`${uid}-max-qty`}
                type="text"
                inputMode="numeric"
                disabled={!canManage}
                value={maxQtyPerItem}
                onChange={(e) => setMaxQtyPerItem(e.target.value.replace(/\D/g, '').slice(0, 2))}
                className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink tabular-nums-google disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
              />
            </div>

            <div className="flex items-end pb-2">
              <label className="inline-flex items-center gap-2 text-xs text-ink cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={allowOpenTableSelection}
                  onChange={(e) => setAllowOpenTableSelection(e.target.checked)}
                  className="accent-primary"
                />
                <span>
                  {pick(
                    'เปิดรับ Walk-in Captive Portal (เลือกโต๊ะเอง + รอแคชเชียร์รับ)',
                    'ເປີດຮັບ Walk-in Captive Portal (ເລືອກໂຕະເອງ + ລໍຖ້າຮັບ)',
                    'Allow Walk-in Captive Portal table picker'
                  )}
                </span>
              </label>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-tables-list`} className="block text-ink-muted mb-1">
                {pick(
                  'รายชื่อโต๊ะ / จุดบริการ (คั่นด้วยจุลภาค ,)',
                  'ລາຍຊື່ໂຕະ / ຈຸດບໍລິການ (ຄັ່ນດ້ວຍ ,)',
                  'Table Labels (comma-separated)'
                )}
              </label>
              <textarea
                id={`${uid}-tables-list`}
                rows={2}
                disabled={!canManage}
                value={tablesText}
                onChange={(e) => setTablesText(e.target.value)}
                className={`w-full rounded-[4px] border border-hairline bg-canvas p-2.5 text-ink font-mono-num disabled:bg-surface-1 ${UI_INTERACTION.focusControl}`}
              />
            </div>
          </div>
        </div>
      </div>

      {/* NFC Tag Support & NDEF Programmer Section */}
      <div className="rounded-[4px] border border-hairline bg-canvas p-4 space-y-4 text-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="font-medium text-ink flex items-center gap-2 text-sm">
              <Nfc className="h-4 w-4 text-primary" />
              <span>
                {pick(
                  '3. ระบบแท็ก NFC ประจำโต๊ะ (NTAG213 / NTAG215 / NTAG216 · NDEF URI & Wi-Fi WSC)',
                  '3. ລະບົບແທັກ NFC ປະຈຳໂຕະ (NTAG213 / NTAG215 / NTAG216 · NDEF URI & Wi-Fi WSC)',
                  '3. NFC Table Tags (NTAG213 / 215 / 216 · NDEF URI & Android Wi-Fi WSC)'
                )}
              </span>
            </div>
            <p className="text-ink-muted max-w-3xl">
              {pick(
                'รองรับการแตะสมาร์ตโฟน (iOS & Android) บนโต๊ะเพื่อเปิดหน้าเมนู Local LAN (&via=nfc) ควบคู่กับ QR Code และสร้าง Wi-Fi WSC NDEF สำหรับ Android Auto-Join + ปุ่มเตรียม/เขียนแท็กจาก POS',
                'ຮອງຮັບການແຕະມືຖື (iOS & Android) ເພື່ອເປີດເມນູ Local LAN ຄູ່ກັບ QR Code ແລະ ສ້າງ Wi-Fi WSC ສຳລັບ Android',
                'Supports iOS & Android tap-to-menu NDEF URIs alongside QR codes, plus offline WFA WSC Wi-Fi credentials for Android.'
              )}
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={nfcEnabled}
            disabled={!canManage || busy}
            onClick={() => setNfcEnabled((prev) => !prev)}
            className={`min-h-[38px] rounded-[48px] border px-4 font-google-display text-xs font-medium ${UI_INTERACTION.focusButton} ${
              nfcEnabled
                ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                : 'border-hairline bg-surface-1 text-ink hover:border-primary hover:text-primary'
            }`}
          >
            {nfcEnabled
              ? pick('เปิดใช้งาน NFC', 'ເປີດໃຊ້ NFC', 'NFC Enabled')
              : pick('ปิดใช้งาน NFC', 'ປິດໃຊ້ NFC', 'NFC Disabled')}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label htmlFor={`${uid}-nfc-mode`} className="block text-ink-muted mb-1">
              {pick('โหมดความปลอดภัยแท็ก NFC', 'ໂໝດຄວາມປອດໄພ NFC', 'NFC Tag Session Mode')}
            </label>
            <select
              id={`${uid}-nfc-mode`}
              disabled={!canManage}
              value={nfcTagMode}
              onChange={(e) => setNfcTagMode(e.target.value as NfcTagMode)}
              className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
            >
              <option value="STATIC_TABLE">
                {pick(
                  'Static Table Tag (เขียนถาวร · รอแคชเชียร์ยืนยัน)',
                  'Static Table Tag (ຂຽນຖາວອນ · ລໍຖ້າຢືນຢັນ)',
                  'Static Table Sticker (Cashier Confirm)'
                )}
              </option>
              <option value="SIGNED_SESSION">
                {pick(
                  'Signed Session Tag (หมุน HMAC Token รายรอบ)',
                  'Signed Session Tag (HMAC Token ລາຍຮອບ)',
                  'Signed Session Tag (Rotating HMAC)'
                )}
              </option>
            </select>
          </div>

          <div>
            <label htmlFor={`${uid}-nfc-layout`} className="block text-ink-muted mb-1">
              {pick('โครงสร้างข้อมูล NDEF ในแท็ก', 'ໂຄງສ້າງຂໍ້ມູນ NDEF', 'NDEF Record Layout')}
            </label>
            <select
              id={`${uid}-nfc-layout`}
              disabled={!canManage}
              value={nfcRecordLayout}
              onChange={(e) => setNfcRecordLayout(e.target.value as NfcRecordLayout)}
              className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
            >
              <option value="URI_ONLY">
                {pick(
                  'URI_ONLY (เปิดเมนูตรง · ใช้ได้ทั้ง iOS & Android)',
                  'URI_ONLY (ເປີດເມນູໂດຍຕົງ · iOS & Android)',
                  'URI Only (Table Menu Link · iOS + Android)'
                )}
              </option>
              <option value="WIFI_WSC_ONLY">
                {pick(
                  'WIFI_WSC_ONLY (ต่อ Wi-Fi ร้านอัตโนมัติ · เฉพาะ Android)',
                  'WIFI_WSC_ONLY (ເຊື່ອມ Wi-Fi ອັດຕະໂນມັດ · Android)',
                  'Wi-Fi WSC Auto-Join Only (Android)'
                )}
              </option>
              <option value="URI_AND_WIFI_WSC">
                {pick(
                  'URI + Wi-Fi WSC (รวม 2 ระเบียน · แนะนำ NTAG215+)',
                  'URI + Wi-Fi WSC (ລວມ 2 ລະບຽນ · ແນະນຳ NTAG215+)',
                  'Multi-Record URI + Wi-Fi WSC (NTAG215+)'
                )}
              </option>
            </select>
          </div>

          <div>
            <label htmlFor={`${uid}-nfc-chip`} className="block text-ink-muted mb-1">
              {pick('ชนิดชิป NFC ที่ใช้งาน', 'ຊະນິດຊິບ NFC', 'Target NFC Chip EEPROM')}
            </label>
            <select
              id={`${uid}-nfc-chip`}
              disabled={!canManage}
              value={nfcChipType}
              onChange={(e) => setNfcChipType(e.target.value as NfcTagChipType)}
              className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink disabled:bg-surface-1 ${UI_INTERACTION.focusSelect}`}
            >
              <option value="NTAG213">NTAG213 ({NFC_CHIP_USABLE_NDEF_BYTES.NTAG213} Bytes usable)</option>
              <option value="NTAG215">NTAG215 ({NFC_CHIP_USABLE_NDEF_BYTES.NTAG215} Bytes usable)</option>
              <option value="NTAG216">NTAG216 ({NFC_CHIP_USABLE_NDEF_BYTES.NTAG216} Bytes usable)</option>
            </select>
          </div>
        </div>

        <div className="rounded-[4px] border border-hairline bg-surface-1 p-3 space-y-1.5 text-[11px] text-ink-soft">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink flex items-center gap-1.5">
              <Smartphone className="h-3.5 w-3.5 text-primary" />
              <span>
                {pick(
                  'คำแนะนำใช้งานจริง iOS & Android + Wi-Fi Auto-Join',
                  'ຄຳແນະນຳໃຊ້ງານຈິງ iOS & Android',
                  'iOS vs Android Tap Behavior Note'
                )}
              </span>
            </span>
            {wifiWscPreviewBytes.length > 0 && (
              <span className="rounded-[48px] border border-hairline bg-canvas px-2.5 py-0.5 font-mono-num text-[10px] text-ink">
                WFA WSC Credential: {wifiWscPreviewBytes.length} Bytes
              </span>
            )}
          </div>
          <p>
            {pick(
              '• Android: รองรับ WFA Wi-Fi Simple Configuration (application/vnd.wfa.wsc) ต่อ Wi-Fi อัตโนมัติ + เด้ง Captive Portal หรือเปิดเมนูโต๊ะได้ทันที · • iPhone (iOS): Background NFC อ่านเฉพาะ NDEF URL เพื่อเปิด Safari (ไม่อ่าน Wi-Fi WSC) จึงควรคง Wi-Fi QR Code บนป้ายโต๊ะ A4 ไว้ให้ iPhone สแกนเชื่อม Wi-Fi ก่อนแล้วแตะจุด NFC ได้ตลอดมื้อ',
              '• Android: ຮອງຮັບ WFA Wi-Fi Simple Configuration ເຊື່ອມ Wi-Fi ອັດຕະໂນມັດ · • iPhone (iOS): ຮອງຮັບສະເພາະ NDEF URL ເພື່ອເປີດ Safari ຄວນຄົງ Wi-Fi QR Code ເທິງປ້າຍໂຕະ A4 ໄວ້ຄູ່ກັນ',
              '• Android supports native WFA WSC Wi-Fi auto-join + Captive Portal redirect. • iOS Background Tag Reading opens NDEF URLs in Safari only (keep Wi-Fi QR on A4 table tents for first-time iPhone Wi-Fi join).'
            )}
          </p>
        </div>

        {(staticWithoutOpenTableWarning || missingWifiWscWarning || unopenedSignedCount > 0) && (
          <div className="space-y-2">
            {staticWithoutOpenTableWarning && (
              <div className="flex items-start gap-2 rounded-[4px] border border-danger bg-danger-soft px-3 py-2 text-[11px] text-danger">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  {pick(
                    'คำเตือน: โหมดแท็ก STATIC_TABLE ไม่มี Signed Token หากปิด "เปิดรับ Walk-in Captive Portal" ลูกค้าที่แตะ NFC จะส่งออเดอร์ไม่ได้ (HTTP 403) — กรุณาเปิดรับ Walk-in table picker หรือเปลี่ยนเป็นโหมด SIGNED_SESSION',
                    'ຄຳເຕືອນ: ໂໝດ STATIC_TABLE ບໍ່ມີ Signed Token ຫາກປິດ "Walk-in Captive Portal" ລູກຄ້າທີ່ແຕະ NFC ຈະສັ່ງອໍເດີບໍ່ໄດ້ (HTTP 403) — ກະລຸນາເປີດ Walk-in ຫຼື ປ່ຽນເປັນ SIGNED_SESSION',
                    'Warning: STATIC_TABLE NFC tags are unsigned; with "Allow Walk-in Captive Portal table picker" disabled, NFC orders will fail (HTTP 403). Enable open table selection or switch to SIGNED_SESSION.'
                  )}
                </span>
              </div>
            )}
            {missingWifiWscWarning && (
              <div className="flex items-start gap-2 rounded-[4px] border border-danger bg-danger-soft px-3 py-2 text-[11px] text-danger">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  {!liveEffectiveCfg.wifiSsid
                    ? pick(
                        'คำเตือน: ยังไม่ได้กรอกชื่อ Wi-Fi (SSID) — ไม่สามารถสร้าง Wi-Fi WSC ได้ ระบบจะลดระดับ NDEF เป็น URI_ONLY ชั่วคราว',
                        'ຄຳເຕືອນ: ຍັງບໍ່ໄດ້ໃສ່ຊື່ Wi-Fi (SSID) — ບໍ່ສາມາດສ້າງ Wi-Fi WSC ໄດ້ ລະບົບຈະຫຼຸດລະດັບ NDEF ເປັນ URI_ONLY ຊົ່ວຄາວ',
                        'Warning: Wi-Fi SSID is blank — Wi-Fi WSC cannot be encoded; NDEF payloads fall back to URI_ONLY until SSID is set.'
                      )
                    : pick(
                        'คำเตือน: รหัสผ่าน Wi-Fi (WPA) ต้องมีอย่างน้อย 8 ตัวอักษรจึงจะสร้าง WFA WSC ได้ (หรือเลือก Open Wi-Fi) — ระบบจะลดระดับ NDEF เป็น URI_ONLY ชั่วคราว',
                        'ຄຳເຕືອນ: ລະຫັດ Wi-Fi (WPA) ຕ້ອງມີຢ່າງໜ້ອຍ 8 ຕົວອັກສອນ — ລະບົບຈະໃຊ້ URI_ONLY ຊົ່ວຄາວ',
                        'Warning: WPA password must be at least 8 characters for WFA WSC (or select Open Wi-Fi) — NDEF payloads fall back to URI_ONLY.'
                      )}
                </span>
              </div>
            )}
            {unopenedSignedCount > 0 && (
              <div className="flex items-start gap-2 rounded-[4px] border border-danger/60 bg-danger-soft/60 px-3 py-2 text-[11px] text-danger">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  {pick(
                    `คำเตือน: โหมด SIGNED_SESSION มี ${unopenedSignedCount} โต๊ะที่ยังไม่ได้เปิดรอบ HMAC Token — กรุณากด "เปิดโต๊ะ / พิมพ์ใบ QR โต๊ะ" ที่หน้าขาย POS ก่อนเขียนแท็กหรือคัดลอกลิงก์`,
                    `ຄຳເຕືອນ: ໂໝດ SIGNED_SESSION ມີ ${unopenedSignedCount} ໂຕະທີ່ຍັງບໍ່ທັນເປີດ HMAC Token — ກະລຸນາເປີດໂຕະໃນໜ້າຂາຍ POS ກ່ອນ`,
                    `Warning: ${unopenedSignedCount} table(s) have no active HMAC session yet in SIGNED_SESSION mode — open each table in POS Register before writing tags.`
                  )}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowNfcTagsPanel((v) => !v)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-primary bg-primary-soft px-4 text-xs font-medium text-primary-dark hover:bg-primary hover:text-white ${UI_INTERACTION.focusButton}`}
          >
            <Nfc className="h-3.5 w-3.5" />
            <span>
              {showNfcTagsPanel
                ? pick(
                    `ซ่อนรายการเตรียมแท็ก NFC (${nfcPackages.length} โต๊ะ)`,
                    `ເຊື່ອງລາຍການແທັກ NFC (${nfcPackages.length})`,
                    `Hide NFC Tag List (${nfcPackages.length})`
                  )
                : pick(
                    `จัดการ / เขียน / Export แท็ก NFC ทุกโต๊ะ (${nfcPackages.length} โต๊ะ)`,
                    `ຈັດການ / ຂຽນ / Export ແທັກ NFC (${nfcPackages.length})`,
                    `Prepare / Write / Export NFC Tags (${nfcPackages.length} tables)`
                  )}
            </span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleDownloadNfcExport('csv')}
              className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export NFC CSV</span>
            </button>
            <button
              type="button"
              onClick={() => handleDownloadNfcExport('json')}
              className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export NDEF JSON</span>
            </button>
          </div>
        </div>

        {showNfcTagsPanel && (
          <div className="space-y-3 pt-2 border-t border-hairline">
            {nfcRecordLayout === 'WIFI_WSC_ONLY' && hasUsableWifiWsc && (
              <div className="rounded-[4px] border border-hairline bg-surface-1 px-3 py-2 text-[11px] text-ink-soft">
                {pick(
                  'หมายเหตุโครงสร้าง WIFI_WSC_ONLY: แท็กบรรจุเฉพาะข้อมูล Wi-Fi WSC (binary) ไม่มี Menu URL จึงปิดปุ่ม Bridge QR URL — ให้ใช้ปุ่ม "เขียน NFC" บน Android Chrome หรือ Export NDEF JSON/CSV',
                  'ໝາຍເຫດ WIFI_WSC_ONLY: ແທັກບັນຈຸສະເພາະ Wi-Fi WSC (binary) ບໍ່ມີ Menu URL — ໃຊ້ປຸ່ມ "ຂຽນ NFC" ເທິງ Android Chrome ຫຼື Export NDEF JSON/CSV',
                  'WIFI_WSC_ONLY note: Tags carry binary Wi-Fi WSC only (no Menu URL, so Bridge QR is disabled). Use Android Web NFC Write or Export NDEF JSON/CSV.'
                )}
              </div>
            )}
            {nfcRecordLayout === 'URI_AND_WIFI_WSC' && hasUsableWifiWsc && (
              <div className="rounded-[4px] border border-primary/40 bg-primary-soft/20 px-3 py-2 text-[11px] text-ink-soft">
                {pick(
                  'คำแนะนำ Multi-Record (URI + Wi-Fi WSC): ปุ่ม "เขียน NFC" บน Android Chrome จะเขียนครบทั้ง 2 Record อัตโนมัติ แต่หากใช้ Bridge QR เข้าแอป NFC Tools จะส่งได้เฉพาะ Record ลำดับที่ 1 (Menu URL) ต้องเพิ่ม Wi-Fi Network record ในแอป NFC Tools เพิ่มเติม',
                  'ຄຳແນະນຳ Multi-Record (URI + Wi-Fi WSC): ປຸ່ມ "ຂຽນ NFC" ເທິງ Android Chrome ຈະຂຽນຄົບທັງ 2 Record ອັດຕະໂນມັດ ແຕ່ Bridge QR ຈະສົ່ງໄດ້ສະເພາະ Menu URL ເທົ່ານັ້ນ',
                  'Multi-Record guidance: Android Web NFC writes both URI + Wi-Fi WSC automatically. Bridge QR transfers Record 1 (Menu URL) only — add a Wi-Fi Network record manually in NFC Tools if needed.'
                )}
              </div>
            )}
            {activeBridgePkg && (
              <div className="rounded-[4px] border border-primary bg-surface-1 p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {bridgeQrDataUrl && (
                    <img
                      src={bridgeQrDataUrl}
                      alt={`NFC Bridge QR ${activeBridgePkg.tableLabel}`}
                      className="h-24 w-24 rounded-[4px] border border-hairline bg-white p-1 shrink-0"
                    />
                  )}
                  <div className="space-y-1">
                    <div className="font-medium text-ink">
                      {pick(
                        `QR ส่งลิงก์เข้าแอปเขียน NFC บนมือถือ (โต๊ะ ${activeBridgePkg.tableLabel})`,
                        `QR ສົ່ງລິ້ງເຂົ້າແອັບຂຽນ NFC (ໂຕະ ${activeBridgePkg.tableLabel})`,
                        `Mobile NFC Writer Bridge QR (${activeBridgePkg.tableLabel})`
                      )}
                    </div>
                    <div className="font-mono-num text-[11px] text-primary-dark break-all">
                      {activeBridgePkg.menuUrl}
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      {activeBridgePkg.recordLayout === 'URI_AND_WIFI_WSC'
                        ? pick(
                            'ใช้มือถือพนักงานสแกน QR นี้ คัดลอก URL -> NFC Tools -> Write -> Add Record -> URL/URI (และเพิ่ม Wi-Fi Network record เป็น Record ที่ 2 หากต้องการ Auto-Join Wi-Fi)',
                            'ໃຊ້ມືຖືພະນັກງານສະແກນ QR ນີ້ ວາງ URL ໃນ NFC Tools (Record 1) ແລະ ເພີ່ມ Wi-Fi Network record ເປັນ Record 2',
                            'Scan on staff phone -> NFC Tools -> URL/URI (Record 1), plus add Wi-Fi Network (Record 2) for WSC.'
                          )
                        : pick(
                            'ใช้มือถือพนักงานสแกน QR นี้ คัดลอก URL แล้ววางในแอป NFC Tools -> Write -> Add Record -> URL/URI',
                            'ໃຊ້ມືຖືພະນັກງານສະແກນ QR ນີ້ ແລ້ວວາງລິ້ງໃນແອັບ NFC Tools',
                            'Scan on staff phone -> paste URL into NFC Tools Write -> URL/URI.'
                          )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setBridgeQrTableLabel(null)}
                  className={`h-8 rounded-[48px] border border-hairline bg-canvas px-3 text-[11px] font-medium text-ink-muted hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  {pick('ปิด QR นี้', 'ປິດ QR ນີ້', 'Close')}
                </button>
              </div>
            )}

            <div className="overflow-x-auto rounded-[4px] border border-hairline">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-hairline bg-surface-1 text-ink-muted">
                  <tr>
                    <th className="py-2 px-3">{pick('โต๊ะ', 'ໂຕະ', 'Table')}</th>
                    <th className="py-2 px-3">{pick('URL / Payload', 'URL / Payload', 'URL / Payload')}</th>
                    <th className="py-2 px-3">{pick('ขนาด / ชิป', 'ຂະໜາດ / ຊິບ', 'Bytes / Chip')}</th>
                    <th className="py-2 px-3 text-right">{pick('การทำงาน', 'ການດຳເນີນການ', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {nfcPackages.map((pkg) => {
                    const isWscOnlyRow = pkg.recordLayout === 'WIFI_WSC_ONLY';
                    const isMissingSignedSession =
                      pkg.tagMode === 'SIGNED_SESSION' && !pkg.signedSessionActive;
                    const writeBlocked =
                      writingNfcTable !== null ||
                      isMissingSignedSession ||
                      (webNfcAvailable && !pkg.fitsSelectedChip);
                    return (
                      <tr key={pkg.tableLabel} className="hover:bg-surface-1">
                        <td className="py-2 px-3 font-medium text-ink whitespace-nowrap">
                          <div>{pkg.tableLabel}</div>
                          <div
                            className={`text-[10px] ${
                              isMissingSignedSession ? 'text-danger font-medium' : 'text-ink-muted'
                            }`}
                          >
                            {pkg.signedSessionActive
                              ? 'Signed HMAC'
                              : pkg.tagMode === 'SIGNED_SESSION'
                                ? pick('รอเปิดโต๊ะ (No Token)', 'ລໍເປີດໂຕະ (No Token)', 'No Active Session')
                                : 'Static'}
                          </div>
                        </td>
                        <td className="py-2 px-3 max-w-xs">
                          {isWscOnlyRow ? (
                            <div className="space-y-0.5">
                              <div className="font-mono-num text-[11px] text-ink">
                                WFA WSC · SSID: {liveEffectiveCfg.wifiSsid}
                              </div>
                              <div className="text-[10px] text-ink-muted">
                                {pick(
                                  'ไม่มี Menu URL ในแท็ก (Android ต่อ Wi-Fi + Captive Portal)',
                                  'ບໍ່ມີ Menu URL ໃນແທັກ (Android ເຊື່ອມ Wi-Fi + Captive Portal)',
                                  'Binary Wi-Fi WSC only (no Menu URL record)'
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="font-mono-num text-[11px] text-ink break-all">
                                {pkg.menuUrl}
                              </div>
                              {isMissingSignedSession && (
                                <div className="text-[10px] text-danger">
                                  {pick(
                                    'ต้องเปิดโต๊ะก่อนจึงจะได้ลิงก์ที่มี &s= Token',
                                    'ຕ້ອງເປີດໂຕະກ່ອນຈຶ່ງຈະໄດ້ລິ້ງທີ່ມີ &s= Token',
                                    'Open table first to sign URL with &s= token'
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center rounded-[48px] border px-2 py-0.5 text-[10px] font-medium tabular-nums-google ${
                              pkg.fitsSelectedChip
                                ? 'border-primary/40 bg-primary-soft text-primary-dark'
                                : 'border-danger bg-danger-soft text-danger'
                            }`}
                          >
                            {pkg.ndefByteLength} / {pkg.chipCapacityBytes} B ({pkg.chipType})
                          </span>
                          {!pkg.fitsSelectedChip && (
                            <div className="text-[10px] text-danger mt-0.5">
                              {pkg.recommendedChipType
                                ? `Recommend ${pkg.recommendedChipType}`
                                : 'Exceeds NTAG216'}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap space-x-1.5">
                          <button
                            type="button"
                            disabled={isMissingSignedSession || (isWscOnlyRow && !pkg.wscBase64)}
                            onClick={() =>
                              void handleCopyText(
                                isWscOnlyRow ? (pkg.wscBase64 ?? '') : pkg.menuUrl,
                                isWscOnlyRow ? `Wi-Fi WSC ${pkg.tableLabel}` : `NFC ${pkg.tableLabel}`
                              )
                            }
                            className={`inline-flex h-8 items-center gap-1 rounded-[48px] border border-hairline bg-canvas px-2.5 text-[11px] font-medium text-ink hover:border-primary hover:text-primary disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
                          >
                            <Copy className="h-3 w-3" />
                            <span>{isWscOnlyRow ? 'Copy WSC' : 'Copy URL'}</span>
                          </button>
                          <button
                            type="button"
                            disabled={isWscOnlyRow || isMissingSignedSession}
                            title={
                              isWscOnlyRow
                                ? 'Bridge QR carries URI records only (not binary WSC)'
                                : isMissingSignedSession
                                  ? 'Open table first to generate Signed Token'
                                  : 'Show Bridge QR for NFC Tools'
                            }
                            onClick={() => setBridgeQrTableLabel(pkg.tableLabel)}
                            className={`inline-flex h-8 items-center gap-1 rounded-[48px] border border-hairline bg-canvas px-2.5 text-[11px] font-medium text-primary hover:border-primary disabled:opacity-45 ${UI_INTERACTION.focusButton}`}
                          >
                            <QrCode className="h-3 w-3" />
                            <span>Bridge QR</span>
                          </button>
                          <button
                            type="button"
                            disabled={writeBlocked}
                            onClick={() => void handleWriteBrowserNfcTag(pkg)}
                            title={
                              webNfcAvailable
                                ? 'Write directly using Android Web NFC'
                                : 'Requires Android Chrome Web NFC; click for instructions'
                            }
                            className={`inline-flex h-8 items-center gap-1 rounded-[48px] px-2.5 text-[11px] font-medium disabled:opacity-45 ${UI_INTERACTION.focusButton} ${
                              webNfcAvailable
                                ? 'bg-primary text-white hover:bg-primary-hover'
                                : 'border border-hairline bg-surface-1 text-ink-muted hover:border-primary hover:text-primary'
                            }`}
                          >
                            <Nfc className="h-3 w-3" />
                            <span>
                              {writingNfcTable === pkg.tableLabel
                                ? pick('รอแตะแท็ก...', 'ລໍແຕະແທັກ...', 'Tap Tag...')
                                : pick('เขียน NFC', 'ຂຽນ NFC', 'Write NFC')}
                            </span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Router Captive Portal & Windows Firewall Guide */}
      <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 space-y-2.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-ink">
            {pick(
              'คู่มือตั้งค่า Captive Portal (Router) และเปิดพอร์ต Windows Firewall',
              'ຄູ່ມືຕັ້ງຄ່າ Captive Portal (Router) ແລະ ເປີດພອດ Windows Firewall',
              'Captive Portal Router & Windows Firewall Setup Guide'
            )}
          </span>
          <button
            type="button"
            onClick={() => setShowRouterGuide((v) => !v)}
            className="text-primary font-medium hover:underline"
          >
            {showRouterGuide
              ? pick('ซ่อนคู่มือ', 'ເຊື່ອງຄູ່ມື', 'Hide Guide')
              : pick('แสดงวิธีตั้งค่า Router / Firewall', 'ສະແດງວິທີຕັ້ງຄ່າ Router / Firewall', 'Show Guide')}
          </button>
        </div>

        {showRouterGuide && (
          <div className="space-y-2.5 pt-2 border-t border-hairline text-ink-soft leading-relaxed">
            <div>
              <strong>1. Windows Firewall (รันใน PowerShell แบบ Administrator ครั้งเดียว):</strong>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 rounded-[4px] border border-hairline bg-canvas px-2.5 py-1.5 font-mono-num text-[11px] text-ink overflow-x-auto">
                  {firewallCmd}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyText(firewallCmd, 'Windows Firewall Command')}
                  className={`inline-flex h-8 items-center gap-1 rounded-[48px] border border-hairline bg-canvas px-3 text-[11px] font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
                >
                  <Copy className="h-3 w-3" />
                  <span>Copy</span>
                </button>
              </div>
            </div>
            <div>
              <strong>2. หากต้องการให้เด้งหน้าเมนูอัตโนมัติเมื่อลูกค้าต่อ Wi-Fi (Captive Portal):</strong>
              <ul className="list-disc pl-5 mt-1 space-y-1 text-[11px]">
                <li>
                  ตั้งค่า Static LAN IP ให้เครื่อง POS (เช่น <code>{effectiveHost}</code>) บน Router (DHCP Reservation)
                </li>
                <li>
                  <strong>MikroTik Hotspot / OpenWrt / UniFi Guest Portal</strong>: ตั้ง Redirect URL / Captive Portal Landing Page ไปที่{' '}
                  <code>{`${effectiveBaseUrl}/m?captive=1`}</code> และเพิ่ม IP เครื่อง POS ใน Walled Garden
                </li>
                <li>
                  <strong>กรณีใช้ Wi-Fi Router ทั่วไป (ไม่ต้องตั้ง Captive Portal)</strong>: ใช้ปุ่ม &ldquo;เปิดโต๊ะ / พิมพ์ใบ QR โต๊ะ&rdquo; ที่หน้าขาย POS หรือพิมพ์ป้ายตั้งโต๊ะ A4 — ลูกค้าสแกน Wi-Fi QR แล้วสแกน Table QR ได้ทันที!
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          disabled={!canManage || busy}
          onClick={() => void handleSave()}
          className={`h-[46px] rounded-[48px] bg-primary px-8 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover disabled:opacity-45 ${UI_INTERACTION.focusButtonPrimary}`}
        >
          {pick(
            'บันทึก & อัปเดตเซิร์ฟเวอร์ QR วง LAN ทันที',
            'ບັນທຶກ & ອັບເດດເຊີບເວີ QR ວົງ LAN ທັນທີ',
            'Save & Apply Guest LAN Server Config'
          )}
        </button>
      </div>
    </section>
  );
};
