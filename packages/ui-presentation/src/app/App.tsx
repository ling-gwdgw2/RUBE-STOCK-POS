import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Cpu,
  Lock,
  Printer,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { parseScaleBarcodeEan13 } from '../../../hal-drivers/src/scanner/mod.ts';
import {
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
} from '../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from './api/pos-transport.ts';
import { BomStudioWorkspace } from './components/BomStudioWorkspace.tsx';
import { FirstRunWizardModal } from './components/FirstRunWizardModal.tsx';
import { HilSimulatorDrawer } from './components/HilSimulatorDrawer.tsx';
import { KdsWorkspace } from './components/KdsWorkspace.tsx';
import { PinLockModal } from './components/PinLockModal.tsx';
import { PosRegisterWorkspace } from './components/PosRegisterWorkspace.tsx';
import { ShiftAndReportsWorkspace } from './components/ShiftAndReportsWorkspace.tsx';
import { SystemSettingsWorkspace } from './components/SystemSettingsWorkspace.tsx';
import { WarehouseWorkspace } from './components/WarehouseWorkspace.tsx';
import { useGlobalBarcodeScanner } from './hooks/useGlobalBarcodeScanner.ts';
import type {
  BootstrapPayload,
  CartItem,
  PrintedReceiptPreview,
  StaffUserDto,
  WorkspaceTabId,
} from './types.ts';

interface ToastNotification {
  id: number;
  message: string;
  tone: 'success' | 'warn' | 'error';
}

/**
 * The SINGLE Four-Color Brand Gesture on the entire page (`google.design.md` lines 12, 247, 390):
 * Canonical Blue (#1a73e8), Red (#ea4335), Yellow (#fbbc04), Green (#34a853) inside a 50% circular mask.
 * Held strictly in reserve here; all remaining page chrome runs on Ink + Hairline + singular Google Blue.
 */
const ReservedFourColorBrandMark: React.FC = () => (
  <span
    aria-hidden="true"
    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[50%] border border-[#dadce0] bg-white"
  >
    <svg viewBox="0 0 24 24" className="h-5 w-5">
      <path d="M12 2 A10 10 0 0 1 22 12 L17.5 12 A5.5 5.5 0 0 0 12 6.5 Z" fill="#1a73e8" />
      <path d="M12 2 A10 10 0 0 0 2 12 L6.5 12 A5.5 5.5 0 0 1 12 6.5 Z" fill="#ea4335" />
      <path d="M2 12 A10 10 0 0 0 12 22 L12 17.5 A5.5 5.5 0 0 1 6.5 12 Z" fill="#fbbc04" />
      <path d="M22 12 A10 10 0 0 1 12 22 L12 17.5 A5.5 5.5 0 0 0 17.5 12 Z" fill="#34a853" />
    </svg>
  </span>
);

export const App: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('POS');
  const [currentUser, setCurrentUser] = useState<StaffUserDto | null>(null);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [hilDrawerOpen, setHilDrawerOpen] = useState(false);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [rollbackCount, setRollbackCount] = useState(0);
  const [lastPrintedReceipt, setLastPrintedReceipt] = useState<PrintedReceiptPreview | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  const pushToast = useCallback(
    (message: string, tone: 'success' | 'warn' | 'error' = 'success') => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4200);
    },
    []
  );

  const refreshBootstrap = useCallback(async () => {
    const maxAttempts = 5;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await posTransport.getBootstrap('OUTLET-HQ', true);
        setBootstrap(data);
        setBootError(null);
        setCurrentUser((prev) => {
          if (prev) {
            return data.staffUsers.find((u) => u.id === prev.id) ?? prev;
          }
          return (
            data.staffUsers.find((u) => u.id === 'USR-CASHIER-01') ??
            data.staffUsers[0] ?? {
              id: 'USR-CASHIER-01',
              username: 'cashier1',
              displayName: 'แคชเชียร์กะเช้า',
              role: 'CASHIER',
              active: true,
              createdAt: new Date().toISOString(),
            }
          );
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => window.setTimeout(resolve, 600));
        }
      }
    }
    setBootError(lastError instanceof Error ? lastError.message : String(lastError));
  }, []);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  const handleScanBarcodeIntoCart = useCallback(
    (barcode: string, multiplierCount = 1) => {
      if (!bootstrap) return;
      const trimmed = barcode.trim();
      if (!trimmed) return;
      const mult = Math.max(1, multiplierCount);

      // 1. Supermarket Scale Barcode (Prefix 20-29)
      if (bootstrap.featureFlags.enableScaleBarcodeParser && /^\d{13}$/.test(trimmed)) {
        const prefixCheck = parseScaleBarcodeEan13(trimmed);
        if (prefixCheck.isScaleBarcode && prefixCheck.sku) {
          const matchedScaleItem = bootstrap.catalogDetailed.find(
            (v) =>
              v.isWeightedScale &&
              (v.sku.endsWith(prefixCheck.sku!) || (v.barcode ?? '').includes(prefixCheck.sku!))
          );
          if (matchedScaleItem) {
            const fullParsed = parseScaleBarcodeEan13(trimmed, matchedScaleItem.priceSatang);
            const qtyMilli =
              fullParsed.mode === 'WEIGHT_EMBEDDED'
                ? (fullParsed.weightMilliKg ?? 1_000)
                : (fullParsed.computedWeightMilliFromPrice ?? 1_000);
            const badge =
              fullParsed.mode === 'WEIGHT_EMBEDDED'
                ? `ตราชั่ง Prefix ${fullParsed.prefix} · น้ำหนัก ${formatMilliUnitsToQtyString(qtyMilli, matchedScaleItem.unitName)}`
                : `ป้ายฝังราคา Prefix ${fullParsed.prefix} · ฿${formatSatangToThbString(fullParsed.totalPriceSatang ?? 0)}`;

            const cartKey = `${matchedScaleItem.id}::SCALE-${Date.now()}`;
            setCart((prev) => [
              ...prev,
              {
                cartKey,
                variantId: matchedScaleItem.id,
                itemName: matchedScaleItem.itemName,
                variantName: matchedScaleItem.variantName,
                sku: matchedScaleItem.sku,
                unitName: matchedScaleItem.unitName,
                quantityMilli: qtyMilli,
                unitPriceSatang: matchedScaleItem.priceSatang,
                selectedModifierIds: [],
                isWeightedScale: true,
                scaleBadgeText: badge,
              },
            ]);
            pushToast(
              `สแกนตราชั่ง: ${matchedScaleItem.itemName} (${formatMilliUnitsToQtyString(qtyMilli, matchedScaleItem.unitName)})`,
              'success'
            );
            return;
          }
        }
      }

      // 2. Standard EAN/UPC/SKU Lookup
      const matched = bootstrap.catalogDetailed.find(
        (v) => v.barcode === trimmed || v.sku.toLowerCase() === trimmed.toLowerCase()
      );
      if (!matched) {
        pushToast(`ไม่พบรหัสบาร์โค้ด "${trimmed}" ในทะเบียนสินค้า`, 'warn');
        return;
      }

      const addedQtyMilli = mult * 1_000;
      const cartKey = `${matched.id}::`;
      setCart((prev) => {
        const idx = prev.findIndex((c) => c.cartKey === cartKey);
        if (idx >= 0) {
          const copy = [...prev];
          const cur = copy[idx]!;
          copy[idx] = { ...cur, quantityMilli: cur.quantityMilli + addedQtyMilli };
          return copy;
        }
        return [
          ...prev,
          {
            cartKey,
            variantId: matched.id,
            itemName: matched.itemName,
            variantName: matched.variantName,
            sku: matched.sku,
            unitName: matched.unitName,
            quantityMilli: addedQtyMilli,
            unitPriceSatang: matched.priceSatang,
            selectedModifierIds: [],
            isWeightedScale: matched.isWeightedScale,
          },
        ];
      });
      pushToast(
        `เพิ่ม "${matched.itemName}" ×${mult} ลงบิลขายแล้ว`,
        'success'
      );
    },
    [bootstrap, pushToast]
  );

  useGlobalBarcodeScanner({
    enabled: Boolean(bootstrap?.featureFlags.enableGlobalBarcodeScanner),
    onBarcodeScanned: (code) => {
      setActiveTab('POS');
      handleScanBarcodeIntoCart(code, 1);
    },
    onFirstCharRollback: () => {
      setSearchQuery((prev) => prev.slice(0, -1));
      setRollbackCount((c) => c + 1);
    },
  });

  if (bootError) {
    return (
      <div className="min-h-screen bg-white text-[#202124] flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-[8px] border border-[#dadce0] bg-white p-8 space-y-4 text-center">
          <AlertTriangle className="h-10 w-10 text-[#1a73e8] mx-auto" />
          <h1 className="font-google-display text-[24px] font-normal">
            ไม่สามารถเชื่อมต่อฐานข้อมูลท้องถิ่นได้
          </h1>
          <p className="text-sm text-[#5f6368]">{bootError}</p>
          <button
            type="button"
            onClick={() => void refreshBootstrap()}
            className="h-[50px] rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
          >
            ลองเชื่อมต่อใหม่
          </button>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="min-h-screen bg-white text-[#5f6368] flex items-center justify-center">
        <div className="flex items-center gap-3 font-google-display text-base">
          <RefreshCw className="h-5 w-5 animate-spin text-[#1a73e8]" />
          กำลังโหลดระบบ RUBE-STOCK-POS v3.1...
        </div>
      </div>
    );
  }

  if (!bootstrap.onboarded) {
    return (
      <FirstRunWizardModal
        open={true}
        isPreviewMode={Boolean(bootstrap.isPreviewWizard)}
        initialStoreSettings={bootstrap.storeSettings}
        initialPrinterConfig={bootstrap.printerConfig}
        onCompleted={async (ownerUser) => {
          await refreshBootstrap();
          setCurrentUser(ownerUser);
          pushToast('ตั้งค่าเครื่องจุดขายเสร็จสมบูรณ์ พร้อมใช้งานจริง!', 'success');
        }}
        onCancelPreview={
          bootstrap.isPreviewWizard || bootstrap.staffUsers.length > 0
            ? async () => {
                await posTransport.setPreviewFirstRunWizard(false);
                await refreshBootstrap();
              }
            : undefined
        }
      />
    );
  }

  const activeUser: StaffUserDto = currentUser ?? {
    id: 'USR-OWNER-01',
    username: 'owner',
    displayName: 'เจ้าของร้าน',
    role: 'OWNER',
    active: true,
    createdAt: new Date().toISOString(),
  };

  const navItems: Array<{
    id: WorkspaceTabId;
    label: string;
    badge?: string | number | undefined;
    hidden?: boolean | undefined;
  }> = [
    {
      id: 'POS',
      label: 'หน้าขาย POS',
      badge: cart.length > 0 ? cart.length : undefined,
    },
    {
      id: 'KDS',
      label: 'จอครัว KDS',
      badge: bootstrap.kdsTickets.length > 0 ? bootstrap.kdsTickets.length : undefined,
      hidden: !bootstrap.featureFlags.enableKitchenDisplaySystem,
    },
    {
      id: 'WAREHOUSE',
      label: 'คลังสินค้า & PO',
    },
    {
      id: 'BOM',
      label: 'สูตร BOM',
      hidden: !bootstrap.featureFlags.enableMultiLevelBom,
    },
    {
      id: 'SHIFTS_REPORTS',
      label: 'ปิดกะ & รายงาน',
    },
    {
      id: 'SETTINGS',
      label: 'ตั้งค่าระบบ',
    },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-white text-[#202124]">
      {/* Emergency UPS Power-Loss Banner */}
      {bootstrap.upsBanner.visible && (
        <div className="bg-[#000000] text-white px-6 py-2.5 text-xs font-medium flex items-center justify-center gap-2 border-b border-[#dadce0]">
          <AlertTriangle className="h-4 w-4 text-[#1a73e8] shrink-0" />
          <span>{bootstrap.upsBanner.headlineThai}</span>
        </div>
      )}

      {/* Canonical Google `top-nav`: 64px height, pure #ffffff surface, 24px horizontal padding, 1px #dadce0 bottom hairline */}
      <header className="sticky top-0 z-30 h-16 border-b border-[#dadce0] bg-white px-4 lg:px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 h-full min-w-0">
          {/* Brand Wordmark + Single Reserved Four-Color Mark */}
          <button
            type="button"
            onClick={() => setActiveTab('POS')}
            className="flex items-center gap-2.5 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] rounded-[4px]"
          >
            <ReservedFourColorBrandMark />
            <div className="text-left">
              <div className="font-google-display text-[18px] font-medium tracking-[-0.25px] text-[#202124] leading-tight">
                RUBE POS
              </div>
              <div className="text-[11px] text-[#5f6368] leading-none">
                {bootstrap.profile} · v3.1
              </div>
            </div>
          </button>

          {/* Canonical `nav-link` Rail: 16px / 500 / 0.25px, 4px #1a73e8 active underline */}
          <nav className="hidden md:flex items-center gap-1 h-full overflow-x-auto" aria-label="เมนูหลัก">
            {navItems
              .filter((n) => !n.hidden)
              .map((item) => {
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`relative flex h-full items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                      active
                        ? 'text-[#202124]'
                        : 'text-[#5f6368] hover:text-[#202124]'
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.badge !== undefined && (
                      <span className="rounded-[48px] bg-[#1a73e8] px-2 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                        {item.badge}
                      </span>
                    )}
                    {active && (
                      <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                    )}
                  </button>
                );
              })}
          </nav>
        </div>

        {/* Right-Aligned Hairline Pill Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {bootstrap.activeShift && (
            <button
              type="button"
              onClick={() => setActiveTab('SHIFTS_REPORTS')}
              className="hidden xl:flex h-10 items-center gap-2 rounded-[48px] border border-[#dadce0] bg-white px-4 text-xs text-[#3c4043] hover:border-[#1a73e8] hover:text-[#1a73e8] transition-colors cursor-pointer"
            >
              <Wallet className="h-3.5 w-3.5 text-[#1a73e8]" />
              <span>{bootstrap.activeShift.shiftNumber}:</span>
              <strong className="font-medium text-[#202124] tabular-nums-google">
                ฿{formatSatangToThbString(bootstrap.activeShift.expectedCashSatang)}
              </strong>
            </button>
          )}

          <button
            type="button"
            onClick={() => setHilDrawerOpen(true)}
            className="flex h-10 items-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] hover:bg-[#f8f9fa] transition-colors cursor-pointer"
          >
            <Cpu className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">HIL Bench</span>
            {!bootstrap.printer.ready && (
              <span className="rounded-[48px] bg-[#202124] px-1.5 py-0.5 text-[10px] text-white">
                คิว {bootstrap.printer.pendingQueueLength}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setPinModalOpen(true)}
            className="flex h-10 items-center gap-2 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#202124] hover:border-[#1a73e8] transition-colors cursor-pointer"
          >
            <Lock className="h-3.5 w-3.5 text-[#1a73e8]" />
            <span className="max-w-[120px] truncate">{activeUser.displayName}</span>
          </button>
        </div>
      </header>

      {/* Mobile Nav Fallback (< md) */}
      <nav className="md:hidden flex items-center gap-1 overflow-x-auto border-b border-[#dadce0] bg-white px-4">
        {navItems
          .filter((n) => !n.hidden)
          .map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`relative flex h-11 items-center gap-1.5 px-3 font-google-display text-xs font-medium whitespace-nowrap cursor-pointer ${
                  active ? 'text-[#202124]' : 'text-[#5f6368]'
                }`}
              >
                <span>{item.label}</span>
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[3px] bg-[#1a73e8]" />
                )}
              </button>
            );
          })}
      </nav>

      {/* Main Content Canvas: Pure #ffffff across the entire application */}
      <main className="flex-1 w-full bg-white text-[#202124]">
        <div className="max-w-[1440px] w-full mx-auto px-4 lg:px-6 py-6">
          {activeTab === 'POS' && (
            <PosRegisterWorkspace
              bootstrap={bootstrap}
              currentUser={activeUser}
              cart={cart}
              setCart={setCart}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              rollbackCount={rollbackCount}
              onScanBarcodeString={handleScanBarcodeIntoCart}
              lastPrintedReceipt={lastPrintedReceipt}
              setLastPrintedReceipt={setLastPrintedReceipt}
              onRefreshState={refreshBootstrap}
              onToast={pushToast}
            />
          )}

          {activeTab === 'KDS' && (
            <KdsWorkspace
              initialTickets={bootstrap.kdsTickets}
              onRefreshBootstrap={refreshBootstrap}
              onToast={pushToast}
            />
          )}

          {activeTab === 'WAREHOUSE' && (
            <WarehouseWorkspace
              bootstrap={bootstrap}
              currentUser={activeUser}
              onRefreshState={refreshBootstrap}
              onToast={pushToast}
            />
          )}

          {activeTab === 'BOM' && (
            <BomStudioWorkspace
              bootstrap={bootstrap}
              onRefreshState={refreshBootstrap}
              onToast={pushToast}
            />
          )}

          {activeTab === 'SHIFTS_REPORTS' && (
            <ShiftAndReportsWorkspace
              bootstrap={bootstrap}
              currentUser={activeUser}
              onRefreshState={refreshBootstrap}
              onToast={pushToast}
            />
          )}

          {activeTab === 'SETTINGS' && (
            <SystemSettingsWorkspace
              bootstrap={bootstrap}
              currentUser={activeUser}
              onRefreshState={refreshBootstrap}
              onToast={pushToast}
            />
          )}
        </div>
      </main>

      {/* Canonical Google Soft-Gray Footer (`#f8f9fa` surface-1, `#5f6368` ink-muted) */}
      <footer className="border-t border-[#dadce0] bg-[#f8f9fa] px-6 py-4 text-xs text-[#5f6368]">
        <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-medium text-[#202124]">{bootstrap.storeSettings.storeName}</span>
            <span>เลขผู้เสียภาษี {bootstrap.storeSettings.taxId}</span>
            <span className="inline-flex items-center gap-1 text-[#3c4043]">
              <ShieldCheck className="h-3.5 w-3.5 text-[#1a73e8]" />
              Ledger Invariant: {bootstrap.ledgerInvariant.valid ? '100% ตรงตามสมการบัญชี' : 'ตรวจสอบพบความต่าง'}
            </span>
            <span className="inline-flex items-center gap-1 text-[#3c4043]">
              <Printer className="h-3.5 w-3.5 text-[#1a73e8]" />
              เครื่องพิมพ์ ({bootstrap.printerConfig.paperWidthMm}mm): {bootstrap.printer.ready ? 'พร้อมใช้งาน' : `ค้างคิว ${bootstrap.printer.pendingQueueLength} ใบ`}
            </span>
          </div>
          <div className="hidden lg:block text-[#5f6368]">
            คีย์ลัด: F2 ค้นหา · F4 ตัวคูณ · F8 พักบิล · F9 ส่วนลด · F10 แยกจ่าย/เลือกชำระ · F12 รับเงินสดด่วน
          </div>
        </div>
      </footer>

      {/* Modals & Drawers */}
      <PinLockModal
        open={pinModalOpen}
        canDismiss={true}
        staffUsers={bootstrap.staffUsers}
        currentUser={activeUser}
        onAuthenticated={(user) => {
          setCurrentUser(user);
          setPinModalOpen(false);
          pushToast(`สลับผู้ใช้งานเป็น ${user.displayName} (${user.role})`, 'success');
        }}
        onClose={() => setPinModalOpen(false)}
      />

      <HilSimulatorDrawer
        open={hilDrawerOpen}
        onClose={() => setHilDrawerOpen(false)}
        bootstrap={bootstrap}
        lastPrintedReceipt={lastPrintedReceipt}
        onInjectScannedBarcodeToPos={(barcode) => {
          setRollbackCount((c) => c + 1);
          handleScanBarcodeIntoCart(barcode, 1);
        }}
        onRefreshState={refreshBootstrap}
        onToast={pushToast}
      />

      {/* Clean Hairline Toast Notifications */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-md pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-[4px] border px-4 py-3 text-sm font-medium transition-colors ${
              t.tone === 'error'
                ? 'border-[#202124] bg-[#202124] text-white'
                : 'border-[#dadce0] bg-white text-[#202124]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#1a73e8] shrink-0" />
              <span>{t.message}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
