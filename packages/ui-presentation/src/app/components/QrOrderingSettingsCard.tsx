import React, { useEffect, useId, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Printer,
  QrCode,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import {
  buildWifiQrPayload,
  DEFAULT_QR_ORDERING_CONFIG,
  normalizeTableLabels,
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
  const [runtimeStatus, setRuntimeStatus] = useState<QrOrderingRuntimeStatusDto | undefined>(
    bootstrap.qrOrderingStatus
  );
  const [tableSessions, setTableSessions] = useState<TableQrSessionDto[]>(
    bootstrap.qrTableSessions ?? []
  );
  const [wifiQrPreviewUrl, setWifiQrPreviewUrl] = useState<string | null>(null);
  const [showRouterGuide, setShowRouterGuide] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    const cfg = bootstrap.qrOrderingConfig ?? DEFAULT_QR_ORDERING_CONFIG;
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
    setRuntimeStatus(bootstrap.qrOrderingStatus);
    setTableSessions(bootstrap.qrTableSessions ?? []);
  }, [bootstrap.qrOrderingConfig, bootstrap.qrOrderingStatus, bootstrap.qrTableSessions]);

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

  const parsedPort = Math.max(1024, Math.min(65535, Number(portInput.replace(/\D/g, '')) || 4174));
  const firewallCmd = `netsh advfirewall firewall add rule name="RUBE-POS Guest QR ${parsedPort}" dir=in action=allow protocol=TCP localport=${parsedPort}`;

  const handleSave = async () => {
    setBusy(true);
    try {
      const tableLabels = normalizeTableLabels(tablesText);
      const res = await posTransport.saveQrOrderingConfig({
        outletId,
        enabled,
        port: parsedPort === 4173 ? 4174 : parsedPort,
        wifiSsid: wifiSsid.trim(),
        wifiPassword: wifiSecurity === 'NOPASS' ? '' : wifiPassword.trim(),
        wifiSecurity,
        approvalMode,
        allowOpenTableSelection,
        maxQtyPerItem: Math.max(1, Math.min(99, Number(maxQtyPerItem.replace(/\D/g, '')) || 20)),
        customHostOverride: customHostOverride.trim(),
        tableLabels,
      });
      setRuntimeStatus(res.status);
      setTableSessions(res.tableSessions);
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
      const effectiveCfg: QrOrderingConfigDto = {
        enabled,
        port: parsedPort === 4173 ? 4174 : parsedPort,
        wifiSsid: wifiSsid.trim(),
        wifiPassword: wifiSecurity === 'NOPASS' ? '' : wifiPassword.trim(),
        wifiSecurity,
        approvalMode,
        tableLabels: normalizeTableLabels(tablesText),
        maxQtyPerItem: Math.max(1, Math.min(99, Number(maxQtyPerItem.replace(/\D/g, '')) || 20)),
        allowOpenTableSelection,
        customHostOverride: customHostOverride.trim(),
      };
      const baseUrl =
        runtimeStatus?.baseUrl ??
        `http://${customHostOverride.trim() || '127.0.0.1'}:${effectiveCfg.port}`;
      const opened = await openA4TableQrPrintWindow({
        storeName: bootstrap.storeSettings.storeName,
        locale: fiscal.receiptLocale,
        baseUrl,
        config: effectiveCfg,
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
              {runtimeStatus?.baseUrl ? `${runtimeStatus.baseUrl}/m` : `http://127.0.0.1:${parsedPort}/m`}
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
                  ตั้งค่า Static LAN IP ให้เครื่อง POS (เช่น <code>{runtimeStatus?.activeHost ?? '192.168.1.50'}</code>) บน Router (DHCP Reservation)
                </li>
                <li>
                  <strong>MikroTik Hotspot / OpenWrt / UniFi Guest Portal</strong>: ตั้ง Redirect URL / Captive Portal Landing Page ไปที่{' '}
                  <code>{runtimeStatus?.baseUrl ?? `http://192.168.1.50:${parsedPort}`}/m?captive=1</code> และเพิ่ม IP เครื่อง POS ใน Walled Garden
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
