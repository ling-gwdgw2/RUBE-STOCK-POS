import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Cpu,
  Globe,
  Lock,
  Printer,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  Wallet,
  XCircle,
} from 'lucide-react';
import {
  matchesScaleBarcodePlu,
  parseScaleBarcodeEan13,
} from '../../../hal-drivers/src/scanner/mod.ts';
import { formatMilliUnitsToQtyString } from '../../../shared-contracts/src/fixed-point.ts';
import {
  DEFAULT_TH_FISCAL_CONFIG,
  formatMoney,
  normalizeLocaleCode,
  type LocaleCode,
} from '../../../shared-contracts/src/currency.ts';
import { posTransport, setPosRequestLocale, setPosSessionToken } from './api/pos-transport.ts';
import { I18nProvider, pickLocaleText, translateKey } from './i18n/index.tsx';
import { BomStudioWorkspace } from './components/BomStudioWorkspace.tsx';
import { FirstRunWizardModal } from './components/FirstRunWizardModal.tsx';
import { HilSimulatorDrawer } from './components/HilSimulatorDrawer.tsx';
import { KdsWorkspace } from './components/KdsWorkspace.tsx';
import { PinLockModal } from './components/PinLockModal.tsx';
import { PosRegisterWorkspace } from './components/PosRegisterWorkspace.tsx';
import { ShiftAndReportsWorkspace } from './components/ShiftAndReportsWorkspace.tsx';
import { SystemSettingsWorkspace } from './components/SystemSettingsWorkspace.tsx';
import { UI_INTERACTION } from './components/ui/UiPrimitives.tsx';
import { WarehouseWorkspace } from './components/WarehouseWorkspace.tsx';
import {
  type GlobalScannerRoutingMode,
  useGlobalBarcodeScanner,
} from './hooks/useGlobalBarcodeScanner.ts';
import type {
  BootstrapPayload,
  CartItem,
  PrintedReceiptPreview,
  StaffUserDto,
  WorkspaceTabId,
} from './types.ts';
import {
  ACTIVE_SESSION_USER_STORAGE_KEY,
  canViewExpectedDrawerCash,
  getAllowedTabsForRole,
  getDefaultTabForRole,
  SIMULATION_MODE_STORAGE_KEY,
} from './utils/rbac.ts';
import { getProfileMeta } from './utils/profile-domain.ts';

interface ToastNotification {
  id: number;
  message: string;
  tone: 'success' | 'warn' | 'error';
}

const ACTIVE_OUTLET_STORAGE_KEY = 'rube_pos_v3_active_outlet_id';
const LAST_UI_LOCALE_STORAGE_KEY = 'rube_pos_v3_last_ui_locale';

const LOCKED_TERMINAL_FALLBACK_USER: StaffUserDto = {
  id: 'LOCKED-TERMINAL',
  username: 'locked',
  displayName: 'LOCKED',
  role: 'CASHIER',
  active: false,
  createdAt: '',
};

interface PreBurstInputSnapshot {
  el: HTMLInputElement | null;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function captureInputSnapshot(
  el: Element | null,
  attrName: 'scannerAllow' | 'scannerSlipAllow',
  fallbackValue: string
): PreBurstInputSnapshot {
  if (el instanceof HTMLInputElement && el.dataset[attrName] === 'true') {
    return {
      el,
      value: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    };
  }
  return {
    el: null,
    value: fallbackValue,
    selectionStart: null,
    selectionEnd: null,
  };
}

function restoreInputSnapshotDom(snap: PreBurstInputSnapshot): void {
  const { el, value, selectionStart, selectionEnd } = snap;
  if (!el || !document.contains(el)) return;
  el.value = value;
  if (selectionStart !== null && selectionEnd !== null) {
    try {
      el.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      // ignore selection errors on unsupported input types
    }
    window.setTimeout(() => {
      if (
        document.contains(el) &&
        document.activeElement === el &&
        el.value === value
      ) {
        try {
          el.setSelectionRange(selectionStart, selectionEnd);
        } catch {
          // ignore
        }
      }
    }, 0);
  }
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
  const [activeOutletId, setActiveOutletId] = useState<string>(() => {
    try {
      return window.localStorage.getItem(ACTIVE_OUTLET_STORAGE_KEY) || 'OUTLET-HQ';
    } catch {
      return 'OUTLET-HQ';
    }
  });
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('POS');
  const [currentUser, setCurrentUser] = useState<StaffUserDto | null>(null);
  const [isTerminalLocked, setIsTerminalLocked] = useState<boolean>(true);
  const [pinModalOpen, setPinModalOpen] = useState<boolean>(false);
  const [hilDrawerOpen, setHilDrawerOpen] = useState<boolean>(false);
  const [overrideLocale, setOverrideLocale] = useState<LocaleCode | undefined>(undefined);

  const [simulationModeEnabled, setSimulationModeEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIMULATION_MODE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [rollbackCount, setRollbackCount] = useState(0);
  const [lastPrintedReceipt, setLastPrintedReceipt] = useState<PrintedReceiptPreview | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  // Context-aware 2D scanner routing bridge for POS Checkout Slip Mini-QR
  const [posScannerRoutingMode, setPosScannerRoutingMode] =
    useState<GlobalScannerRoutingMode>('POS_CART');
  const slipQrScannedHandlerRef = useRef<((qrRaw: string) => void) | null>(null);
  const slipFirstCharRollbackRef = useRef<(() => void) | null>(null);
  const slipBeforeSnapshotRef = useRef<(() => void) | null>(null);

  const scaleScanSeqRef = useRef(0);
  const bootstrapSeqRef = useRef(0);
  const skipNextBootstrapEffectRef = useRef(false);
  const preLoginLocaleDirtyRef = useRef(false);
  const currentUserRef = useRef<StaffUserDto | null>(null);
  currentUserRef.current = currentUser;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchPreBurstSnapshotRef = useRef<PreBurstInputSnapshot | null>(null);

  const [cachedStartupLocale] = useState<LocaleCode>(() => {
    try {
      return normalizeLocaleCode(window.localStorage.getItem(LAST_UI_LOCALE_STORAGE_KEY), 'th');
    } catch {
      return 'th';
    }
  });
  const activeFiscalConfig = bootstrap?.fiscalConfig ?? DEFAULT_TH_FISCAL_CONFIG;
  const activeUiLocale: LocaleCode =
    overrideLocale ?? (bootstrap ? activeFiscalConfig.uiLocale : cachedStartupLocale);

  useEffect(() => {
    setPosRequestLocale(activeUiLocale);
    try {
      window.localStorage.setItem(LAST_UI_LOCALE_STORAGE_KEY, activeUiLocale);
    } catch {
      // ignore storage restrictions
    }
  }, [activeUiLocale]);

  const tNav = useCallback(
    (key: Parameters<typeof translateKey>[0]) => translateKey(key, activeUiLocale),
    [activeUiLocale]
  );

  const pickApp = useCallback(
    (thText: string, loText: string, enText: string) =>
      pickLocaleText(activeUiLocale, thText, loText, enText),
    [activeUiLocale]
  );

  const handleToggleSimulationMode = useCallback((enabled: boolean) => {
    setSimulationModeEnabled(enabled);
    if (!enabled) {
      setHilDrawerOpen(false);
    }
    try {
      window.localStorage.setItem(SIMULATION_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // ignore storage restrictions
    }
  }, []);

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

  const refreshBootstrap = useCallback(
    async (overrideOutletId?: string) => {
      const mySeq = ++bootstrapSeqRef.current;
      const requestedOutlet = overrideOutletId ?? activeOutletId;
      const maxAttempts = 5;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (mySeq !== bootstrapSeqRef.current) return;
        try {
          let data = await posTransport.getBootstrap(requestedOutlet, true);
          if (mySeq !== bootstrapSeqRef.current) return;
          if (
            data.onboarded &&
            data.outlets.length > 0 &&
            !data.outlets.some((o) => o.id === requestedOutlet)
          ) {
            const fallbackId =
              data.outlets.find((o) => o.id === 'OUTLET-HQ')?.id ?? data.outlets[0]!.id;
            if (fallbackId !== activeOutletId) {
              skipNextBootstrapEffectRef.current = true;
            }
            setActiveOutletId(fallbackId);
            try {
              window.localStorage.setItem(ACTIVE_OUTLET_STORAGE_KEY, fallbackId);
            } catch {
              // ignore
            }
            data = await posTransport.getBootstrap(fallbackId, true);
            if (mySeq !== bootstrapSeqRef.current) return;
          }
          setBootstrap(data);
          setBootError(null);
          if (data.isSessionAuthenticated === false) {
            setPosSessionToken(null);
            try {
              window.sessionStorage.removeItem(ACTIVE_SESSION_USER_STORAGE_KEY);
            } catch {
              // ignore
            }
            currentUserRef.current = null;
            setIsTerminalLocked(true);
            setCurrentUser(null);
            return;
          }
          const prevUser = currentUserRef.current;
          if (prevUser) {
            const refreshed = data.staffUsers.find((u) => u.id === prevUser.id && u.active);
            if (refreshed) {
              currentUserRef.current = refreshed;
              setCurrentUser(refreshed);
            } else {
              currentUserRef.current = null;
              setCurrentUser(null);
              setIsTerminalLocked(true);
              try {
                window.sessionStorage.removeItem(ACTIVE_SESSION_USER_STORAGE_KEY);
              } catch {
                // ignore
              }
            }
          } else {
            let matchedSessionUser: StaffUserDto | null = null;
            try {
              const storedId = window.sessionStorage.getItem(ACTIVE_SESSION_USER_STORAGE_KEY);
              if (storedId) {
                matchedSessionUser =
                  data.staffUsers.find((u) => u.id === storedId && u.active) ?? null;
              }
            } catch {
              // ignore sessionStorage restrictions
            }
            if (matchedSessionUser) {
              currentUserRef.current = matchedSessionUser;
              setCurrentUser(matchedSessionUser);
              setIsTerminalLocked(false);
            } else {
              currentUserRef.current = null;
              setCurrentUser(null);
            }
          }
          return;
        } catch (err) {
          if (mySeq !== bootstrapSeqRef.current) return;
          lastError = err;
          if (attempt < maxAttempts) {
            await new Promise((resolve) => window.setTimeout(resolve, 600));
            if (mySeq !== bootstrapSeqRef.current) return;
          }
        }
      }
      if (mySeq !== bootstrapSeqRef.current) return;
      setBootError(lastError instanceof Error ? lastError.message : String(lastError));
    },
    [activeOutletId]
  );

  useEffect(() => {
    if (skipNextBootstrapEffectRef.current) {
      skipNextBootstrapEffectRef.current = false;
      return;
    }
    void refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    const onSessionExpired = () => {
      bootstrapSeqRef.current += 1;
      currentUserRef.current = null;
      try {
        window.sessionStorage.removeItem(ACTIVE_SESSION_USER_STORAGE_KEY);
      } catch {
        // ignore
      }
      setCurrentUser(null);
      setPinModalOpen(false);
      setHilDrawerOpen(false);
      setIsTerminalLocked(true);
      pushToast(
        pickApp(
          'เซสชันหมดอายุหรือถูกยกเลิก กรุณากดรหัส PIN เข้าใช้งานใหม่',
          'ເຊສຊັນໝົດອາຍຸ ຫຼື ຖືກຍົກເລີກ ກະລຸນາປ້ອນລະຫັດ PIN ເຂົ້າໃຊ້ງານໃໝ່',
          'Session expired or revoked. Please enter your PIN to sign in again.'
        ),
        'warn'
      );
    };
    window.addEventListener('rube-pos-session-expired', onSessionExpired);
    return () => window.removeEventListener('rube-pos-session-expired', onSessionExpired);
  }, [pickApp, pushToast]);

  const handleSwitchOutlet = useCallback(
    async (nextOutletId: string) => {
      if (!nextOutletId || nextOutletId === activeOutletId) return;
      const switchEpoch = ++bootstrapSeqRef.current;
      skipNextBootstrapEffectRef.current = true;
      setActiveOutletId(nextOutletId);
      setCart([]);
      try {
        window.localStorage.setItem(ACTIVE_OUTLET_STORAGE_KEY, nextOutletId);
      } catch {
        // ignore
      }
      await refreshBootstrap(nextOutletId);
      if (bootstrapSeqRef.current !== switchEpoch + 1) return;
      const outletName =
        bootstrap?.outlets.find((o) => o.id === nextOutletId)?.name ?? nextOutletId;
      pushToast(
        pickApp(
          `สลับสาขาประจำเครื่องเป็น "${outletName}" เรียบร้อยแล้ว`,
          `ປ່ຽນສາຂາປະຈຳເຄື່ອງເປັນ "${outletName}" ສຳເລັດແລ້ວ`,
          `Switched active outlet to "${outletName}"`
        ),
        'success'
      );
    },
    [activeOutletId, bootstrap?.outlets, pickApp, pushToast, refreshBootstrap]
  );

  const handleLockTerminal = useCallback(() => {
    bootstrapSeqRef.current += 1;
    currentUserRef.current = null;
    try {
      window.sessionStorage.removeItem(ACTIVE_SESSION_USER_STORAGE_KEY);
    } catch {
      // ignore
    }
    void posTransport.logoutSession();
    setCurrentUser(null);
    setPinModalOpen(false);
    setHilDrawerOpen(false);
    setIsTerminalLocked(true);
  }, []);

  const handleUserAuthenticated = useCallback(
    (user: StaffUserDto) => {
      bootstrapSeqRef.current += 1;
      currentUserRef.current = user;
      setCurrentUser(user);
      setIsTerminalLocked(false);
      setPinModalOpen(false);
      try {
        window.sessionStorage.setItem(ACTIVE_SESSION_USER_STORAGE_KEY, user.id);
      } catch {
        // ignore
      }
      if (bootstrap) {
        const allowed = getAllowedTabsForRole(user.role, bootstrap.featureFlags);
        setActiveTab((curTab) =>
          allowed.includes(curTab)
            ? curTab
            : getDefaultTabForRole(user.role, bootstrap.featureFlags)
        );
      }
      const pendingPreLoginLocale = preLoginLocaleDirtyRef.current ? overrideLocale : undefined;
      if (pendingPreLoginLocale && bootstrap?.onboarded) {
        setPosRequestLocale(pendingPreLoginLocale);
        void posTransport
          .updateUiLocale({ uiLocale: pendingPreLoginLocale })
          .then(() => {
            preLoginLocaleDirtyRef.current = false;
            setOverrideLocale(undefined);
            return refreshBootstrap();
          })
          .catch(() => {
            void refreshBootstrap();
          });
      } else {
        void refreshBootstrap();
      }
      pushToast(
        pickApp(
          `เข้าใช้งานในชื่อ ${user.displayName} (${user.role})`,
          `ເຂົ້າໃຊ້ງານໃນຊື່ ${user.displayName} (${user.role})`,
          `Signed in as ${user.displayName} (${user.role})`
        ),
        'success'
      );
    },
    [bootstrap, overrideLocale, pickApp, pushToast, refreshBootstrap]
  );

  const handleScanBarcodeIntoCart = useCallback(
    (barcode: string, multiplierCount = 1) => {
      if (!bootstrap) return;
      const trimmed = barcode.trim();
      if (!trimmed) return;
      const mult = Math.max(1, multiplierCount);

      // 1. Supermarket Scale Barcode (Prefix 20-29)
      const activeFiscal = bootstrap.fiscalConfig ?? DEFAULT_TH_FISCAL_CONFIG;
      if (bootstrap.featureFlags.enableScaleBarcodeParser && /^\d{13}$/.test(trimmed)) {
        const prefixCheck = parseScaleBarcodeEan13(trimmed, undefined, {
          priceEmbeddedMultiplier: activeFiscal.scalePriceEmbeddedMultiplier,
        });
        if (prefixCheck.isScaleBarcode && prefixCheck.sku) {
          const matchedScaleItem =
            bootstrap.catalogDetailed.find(
              (v) =>
                v.isWeightedScale &&
                (v.sku === prefixCheck.sku! ||
                  v.sku.endsWith(prefixCheck.sku!) ||
                  (v.barcode ?? '').includes(prefixCheck.sku!))
            ) ??
            bootstrap.catalogDetailed.find(
              (v) => v.isWeightedScale && matchesScaleBarcodePlu(v, prefixCheck.sku!)
            );
          if (matchedScaleItem) {
            if (!matchedScaleItem.active) {
              pushToast(
                pickApp(
                  `รายการ "${matchedScaleItem.itemName}" ถูกพักการขายชั่วคราว — ไม่สามารถเพิ่มลงบิลได้`,
                  `ລາຍການ "${matchedScaleItem.itemName}" ຖືກພັກການຂາຍຊົ່ວຄາວ`,
                  `Item "${matchedScaleItem.itemName}" is currently paused`
                ),
                'warn'
              );
              return;
            }
            const fullParsed = parseScaleBarcodeEan13(trimmed, matchedScaleItem.priceSatang, {
              priceEmbeddedMultiplier: activeFiscal.scalePriceEmbeddedMultiplier,
            });
            const qtyMilli =
              fullParsed.mode === 'WEIGHT_EMBEDDED'
                ? (fullParsed.weightMilliKg ?? 1_000)
                : (fullParsed.computedWeightMilliFromPrice ?? 1_000);
            const badge =
              fullParsed.mode === 'WEIGHT_EMBEDDED'
                ? `Prefix ${fullParsed.prefix} · ${formatMilliUnitsToQtyString(qtyMilli, matchedScaleItem.unitName)}`
                : `Prefix ${fullParsed.prefix} · ${formatMoney(fullParsed.totalPriceSatang ?? 0, activeFiscal.currencyCode)}`;
            const overrideLineTotalSatang =
              fullParsed.mode === 'PRICE_EMBEDDED' && fullParsed.totalPriceSatang !== undefined
                ? fullParsed.totalPriceSatang
                : undefined;

            const cartKey = `${matchedScaleItem.id}::SCALE-${Date.now()}-${++scaleScanSeqRef.current}`;
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
                ...(overrideLineTotalSatang !== undefined ? { overrideLineTotalSatang } : {}),
              },
            ]);
            const qtyLabel = formatMilliUnitsToQtyString(qtyMilli, matchedScaleItem.unitName);
            pushToast(
              pickApp(
                `สแกนตราชั่ง: ${matchedScaleItem.itemName} (${qtyLabel})`,
                `ສະແກນຊິງຊັ່ງ: ${matchedScaleItem.itemName} (${qtyLabel})`,
                `Scale scanned: ${matchedScaleItem.itemName} (${qtyLabel})`
              ),
              !matchedScaleItem.isComposite && matchedScaleItem.inStockMilli <= 0
                ? 'warn'
                : 'success'
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
        pushToast(
          pickApp(
            `ไม่พบรหัสบาร์โค้ด "${trimmed}" ในทะเบียนสินค้า`,
            `ບໍ່ພົບລະຫັດບາໂຄດ "${trimmed}" ໃນທະບຽນສິນຄ້າ`,
            `Barcode "${trimmed}" was not found in the catalog`
          ),
          'warn'
        );
        return;
      }
      if (!matched.active) {
        pushToast(
          pickApp(
            `รายการ "${matched.itemName}" ถูกพักการขายชั่วคราว — ไม่สามารถเพิ่มลงบิลได้`,
            `ລາຍການ "${matched.itemName}" ຖືກພັກການຂາຍຊົ່ວຄາວ — ບໍ່ສາມາດເພີ່ມລົງບິນໄດ້`,
            `Item "${matched.itemName}" is currently paused and cannot be added`
          ),
          'warn'
        );
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

      if (!matched.isComposite && matched.inStockMilli <= 0) {
        pushToast(
          pickApp(
            `"${matched.itemName}" สต็อกในระบบเหลือ 0 — เพิ่มลงบิลแล้ว (โปรดตรวจสอบสินค้าหน้าร้าน)`,
            `"${matched.itemName}" ສະຕັອກໃນລະບົບເຫຼືອ 0 — ເພີ່ມລົງບິນແລ້ວ (ກະລຸນາກວດສອບສິນຄ້າໜ້າຮ້ານ)`,
            `"${matched.itemName}" has 0 stock recorded — added to bill (please verify physical shelf)`
          ),
          'warn'
        );
      } else {
        pushToast(
          pickApp(
            `เพิ่ม "${matched.itemName}" ×${mult} ลงบิลขายแล้ว`,
            `ເພີ່ມ "${matched.itemName}" ×${mult} ລົງບິນຂາຍແລ້ວ`,
            `Added "${matched.itemName}" ×${mult} to bill`
          ),
          'success'
        );
      }
    },
    [bootstrap, pickApp, pushToast]
  );

  const activeUser: StaffUserDto = useMemo(() => {
    if (isTerminalLocked) {
      return LOCKED_TERMINAL_FALLBACK_USER;
    }
    if (currentUser) {
      return currentUser;
    }
    return (
      bootstrap?.staffUsers.find((u) => u.id === 'USR-CASHIER-01' && u.active) ??
      bootstrap?.staffUsers.find((u) => u.role === 'CASHIER' && u.active) ??
      LOCKED_TERMINAL_FALLBACK_USER
    );
  }, [bootstrap?.staffUsers, currentUser, isTerminalLocked]);

  const allowedTabs = useMemo(
    () =>
      bootstrap
        ? getAllowedTabsForRole(activeUser.role, bootstrap.featureFlags)
        : (['POS'] as WorkspaceTabId[]),
    [activeUser.role, bootstrap]
  );

  useEffect(() => {
    if (!bootstrap) return;
    if (!allowedTabs.includes(activeTab)) {
      setActiveTab(getDefaultTabForRole(activeUser.role, bootstrap.featureFlags));
    }
  }, [activeTab, activeUser.role, allowedTabs, bootstrap]);

  const effectiveScannerMode: GlobalScannerRoutingMode = useMemo(() => {
    if (
      !bootstrap?.onboarded ||
      isTerminalLocked ||
      pinModalOpen ||
      hilDrawerOpen ||
      !allowedTabs.includes('POS') ||
      activeTab !== 'POS'
    ) {
      return 'BLOCKED';
    }
    return posScannerRoutingMode;
  }, [
    activeTab,
    allowedTabs,
    bootstrap?.onboarded,
    hilDrawerOpen,
    isTerminalLocked,
    pinModalOpen,
    posScannerRoutingMode,
  ]);

  useGlobalBarcodeScanner({
    enabled: Boolean(bootstrap?.featureFlags.enableGlobalBarcodeScanner),
    scannerMode: effectiveScannerMode,
    onBarcodeScanned: (code) => {
      if (!allowedTabs.includes('POS')) return;
      setActiveTab('POS');
      handleScanBarcodeIntoCart(code, 1);
    },
    onSlipQrScanned: (qrRaw) => {
      slipQrScannedHandlerRef.current?.(qrRaw);
    },
    onBeforeFirstCharSnapshot: () => {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      searchPreBurstSnapshotRef.current = captureInputSnapshot(
        activeEl,
        'scannerAllow',
        searchQueryRef.current
      );
    },
    onFirstCharRollback: () => {
      const snap = searchPreBurstSnapshotRef.current;
      searchPreBurstSnapshotRef.current = null;
      if (snap) {
        restoreInputSnapshotDom(snap);
        setSearchQuery(snap.value);
      } else {
        setSearchQuery((prev) => prev.slice(0, -1));
      }
      setRollbackCount((c) => c + 1);
    },
    onBeforeSlipFirstCharSnapshot: () => {
      slipBeforeSnapshotRef.current?.();
    },
    onSlipFirstCharRollback: () => {
      slipFirstCharRollbackRef.current?.();
      setRollbackCount((c) => c + 1);
    },
  });

  if (bootError) {
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-[8px] border border-hairline bg-canvas p-8 space-y-4 text-center">
          <AlertTriangle className="h-10 w-10 text-primary mx-auto" />
          <h1 className="font-google-display text-[24px] font-normal">
            {tNav('nav.bootErrorTitle')}
          </h1>
          <p className="text-sm text-ink-muted">{bootError}</p>
          <button
            type="button"
            onClick={() => void refreshBootstrap()}
            className={`h-[50px] rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            {tNav('nav.retryConnect')}
          </button>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="min-h-screen bg-canvas text-ink-muted flex items-center justify-center">
        <div className="flex items-center gap-3 font-google-display text-base">
          <RefreshCw className="h-5 w-5 animate-spin text-primary" />
          {tNav('nav.loading')}
        </div>
      </div>
    );
  }

  const handleChangeUiLocale = async (nextLocale: LocaleCode) => {
    setPosRequestLocale(nextLocale);
    setOverrideLocale(nextLocale);
    try {
      if (bootstrap.onboarded && !isTerminalLocked) {
        preLoginLocaleDirtyRef.current = false;
        await posTransport.updateUiLocale({ uiLocale: nextLocale });
        await refreshBootstrap();
        setOverrideLocale(undefined);
      } else {
        preLoginLocaleDirtyRef.current = true;
      }
    } catch {
      preLoginLocaleDirtyRef.current = true;
    }
  };

  if (!bootstrap.onboarded) {
    return (
      <I18nProvider
        fiscalConfig={activeFiscalConfig}
        overrideLocale={overrideLocale}
        onChangeLocale={handleChangeUiLocale}
      >
        <FirstRunWizardModal
          open={true}
          isPreviewMode={Boolean(bootstrap.isPreviewWizard)}
          initialStoreSettings={bootstrap.storeSettings}
          initialPrinterConfig={bootstrap.printerConfig}
          onCompleted={async (ownerUser) => {
            bootstrapSeqRef.current += 1;
            currentUserRef.current = ownerUser;
            preLoginLocaleDirtyRef.current = false;
            setOverrideLocale(undefined);
            try {
              window.sessionStorage.setItem(ACTIVE_SESSION_USER_STORAGE_KEY, ownerUser.id);
            } catch {
              // ignore
            }
            await refreshBootstrap();
            setCurrentUser(ownerUser);
            setIsTerminalLocked(false);
            pushToast(
              pickLocaleText(
                activeUiLocale,
                'ตั้งค่าเครื่องจุดขายเสร็จสมบูรณ์ พร้อมใช้งานจริง!',
                'ຕັ້ງຄ່າເຄື່ອງ POS ສຳເລັດແລ້ວ ພ້ອມໃຊ້ງານຈິງ!',
                'POS setup completed and ready for production!'
              ),
              'success'
            );
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
      </I18nProvider>
    );
  }

  const showExpectedDrawerInHeader =
    !isTerminalLocked && canViewExpectedDrawerCash(activeUser.role);
  const showHilBenchButton =
    !isTerminalLocked && simulationModeEnabled && activeUser.role === 'OWNER';
  const canSwitchOutlet =
    !isTerminalLocked &&
    (activeUser.role === 'OWNER' || activeUser.role === 'MANAGER' || activeUser.role === 'WAREHOUSE');
  const isBackgroundInert = isTerminalLocked || pinModalOpen || hilDrawerOpen;

  const navItems: Array<{
    id: WorkspaceTabId;
    label: string;
    badge?: string | number | undefined;
    hidden?: boolean | undefined;
  }> = [
    {
      id: 'POS',
      label: tNav('nav.pos'),
      badge: !isTerminalLocked && cart.length > 0 ? cart.length : undefined,
      hidden: !allowedTabs.includes('POS'),
    },
    {
      id: 'KDS',
      label: tNav('nav.kds'),
      badge:
        !isTerminalLocked && bootstrap.kdsTickets.length > 0
          ? bootstrap.kdsTickets.length
          : undefined,
      hidden: !allowedTabs.includes('KDS'),
    },
    {
      id: 'WAREHOUSE',
      label: tNav('nav.warehouse'),
      hidden: !allowedTabs.includes('WAREHOUSE'),
    },
    {
      id: 'BOM',
      label: tNav('nav.bom'),
      hidden: !allowedTabs.includes('BOM'),
    },
    {
      id: 'SHIFTS_REPORTS',
      label: tNav('nav.shifts'),
      hidden: !allowedTabs.includes('SHIFTS_REPORTS'),
    },
    {
      id: 'SETTINGS',
      label: tNav('nav.settings'),
      hidden: !allowedTabs.includes('SETTINGS'),
    },
  ];

  return (
    <I18nProvider
      fiscalConfig={activeFiscalConfig}
      overrideLocale={overrideLocale}
      onChangeLocale={handleChangeUiLocale}
    >
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      {/* Sticky Top Chrome Wrapper (keeps UPS Power-Loss Banner + Top Nav visible without hiding content) */}
      <div className="sticky top-0 z-30" inert={isBackgroundInert ? true : undefined}>
        {bootstrap.upsBanner.visible && (
          <div
            role="alert"
            className="bg-hero text-white px-4 lg:px-6 py-2.5 text-xs font-medium flex items-center justify-center gap-2 border-b border-hairline"
          >
            <AlertTriangle className="h-4 w-4 text-primary shrink-0" />
            <span>
              {bootstrap.upsBanner.severity === 'CRITICAL_LOW_BATTERY_LOCK'
                ? pickApp(
                    `วิกฤต: แบตเตอรี่ UPS เหลือ ${bootstrap.upsBanner.batteryChargePercent}% — ล็อกการบันทึกข้อมูลชั่วคราว (Read-Only) เพื่อป้องกันฐานข้อมูลเสียหาย`,
                    `ວິກິດ: ແບັດເຕີຣີ UPS ເຫຼືອ ${bootstrap.upsBanner.batteryChargePercent}% — ລັອກການບັນທຶກຂໍ້ມູນຊົ່ວຄາວ (Read-Only) ເພື່ອປ້ອງກັນຖານຂໍ້ມູນເສຍຫາຍ`,
                    `CRITICAL: UPS battery at ${bootstrap.upsBanner.batteryChargePercent}% — writes locked (Read-Only) to protect database integrity.`
                  )
                : bootstrap.upsBanner.severity === 'WARNING_ON_BATTERY'
                  ? pickApp(
                      `แจ้งเตือนไฟดับ: กำลังใช้ไฟสำรองจาก UPS (${bootstrap.upsBanner.batteryChargePercent}%) — บันทึก WAL Checkpoint ลงดิสก์เรียบร้อยแล้ว`,
                      `ແຈ້ງເຕືອນໄຟດັບ: ກຳລັງໃຊ້ໄຟສຳຮອງຈາກ UPS (${bootstrap.upsBanner.batteryChargePercent}%) — ບັນທຶກ WAL Checkpoint ລົງດິສກ໌ຮຽບຮ້ອຍແລ້ວ`,
                      `Power Alert: Running on UPS battery (${bootstrap.upsBanner.batteryChargePercent}%) — WAL checkpoint flushed to disk.`
                    )
                  : bootstrap.upsBanner.headlineThai}
            </span>
          </div>
        )}

        {/* Canonical Google `top-nav`: 64px height, pure #ffffff surface, 24px horizontal padding, 1px #dadce0 bottom hairline */}
        <header className="h-16 border-b border-hairline bg-canvas px-4 lg:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4 lg:gap-6 h-full min-w-0">
            {/* Brand Wordmark + Single Reserved Four-Color Mark */}
            <button
              type="button"
              onClick={() =>
                setActiveTab(getDefaultTabForRole(activeUser.role, bootstrap.featureFlags))
              }
              className={`flex items-center gap-2.5 shrink-0 rounded-[4px] hover:opacity-85 ${UI_INTERACTION.focusButton}`}
            >
              <ReservedFourColorBrandMark />
              <div className="text-left">
                <div className="font-google-display text-[18px] font-medium tracking-[-0.25px] text-ink leading-tight">
                  RUBE POS
                </div>
                <div className="text-[11px] text-ink-muted leading-none">
                  {getProfileMeta(bootstrap.profile, activeUiLocale).shortBadge} ·{' '}
                  {activeFiscalConfig.countryCode} {activeFiscalConfig.currencySymbol}
                </div>
              </div>
            </button>

            {/* Canonical `nav-link` Rail: 16px / 500 / 0.25px, 4px #1a73e8 active underline */}
            <nav
              className="hidden md:flex items-center gap-1 h-full overflow-x-auto"
              aria-label={tNav('nav.mainNavAria')}
            >
              {navItems
                .filter((n) => !n.hidden)
                .map((item) => {
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      className={`relative flex h-full items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                        active ? 'text-ink' : 'text-ink-muted hover:text-ink'
                      }`}
                    >
                      <span>{item.label}</span>
                      {item.badge !== undefined && (
                        <span className="rounded-[48px] bg-primary px-2 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                          {item.badge}
                        </span>
                      )}
                      {active && (
                        <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                      )}
                    </button>
                  );
                })}
            </nav>
          </div>

          {/* Right-Aligned Hairline Pill Controls */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Quick Offline Language Switcher (`ລາວ` / `ไทย` / `EN`) */}
            <div className="hidden sm:flex h-10 items-center gap-1 rounded-[48px] border border-hairline bg-canvas pl-2.5 pr-2 text-xs text-ink">
              <Globe className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
              <select
                aria-label={tNav('nav.languageLabel')}
                value={activeUiLocale}
                onChange={(e) => void handleChangeUiLocale(e.target.value as LocaleCode)}
                className="bg-transparent font-google-display text-xs font-medium text-ink focus:outline-none cursor-pointer"
              >
                <option value="lo">ລາວ</option>
                <option value="th">ไทย</option>
                <option value="en">EN</option>
              </select>
            </div>

            {/* Multi-Outlet Branch Selector Pill (rendered automatically when >= 2 outlets exist) */}
            {bootstrap.outlets.length > 1 && (
              <div className="hidden lg:flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas pl-3 pr-2 text-xs text-ink">
                <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                <select
                  aria-label={tNav('nav.selectOutletAria')}
                  disabled={!canSwitchOutlet}
                  value={activeOutletId}
                  onChange={(e) => void handleSwitchOutlet(e.target.value)}
                  className="bg-transparent font-google-display text-xs font-medium text-ink focus:outline-none cursor-pointer disabled:cursor-default max-w-[140px] truncate"
                >
                  {bootstrap.outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} · {o.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {!isTerminalLocked && !bootstrap.printer.ready && (
              <button
                type="button"
                onClick={() => {
                  if (allowedTabs.includes('SETTINGS')) {
                    setActiveTab('SETTINGS');
                  } else {
                    pushToast(
                      pickApp(
                        `เครื่องพิมพ์ค้างคิว ${bootstrap.printer.pendingQueueLength} ใบ — กรุณาตรวจสอบกระดาษความร้อนหรือฝาเครื่องพิมพ์`,
                        `ເຄື່ອງພິມຄ້າງຄິວ ${bootstrap.printer.pendingQueueLength} ໃບ — ກະລຸນາກວດສອບເຈ້ຍຄວາມຮ້ອນ ຫຼື ຝາເຄື່ອງພິມ`,
                        `Printer has ${bootstrap.printer.pendingQueueLength} queued receipt(s) — check paper roll or printer cover`
                      ),
                      'warn'
                    );
                  }
                }}
                className={`flex h-10 items-center gap-1.5 rounded-[48px] border border-ink bg-primary-soft px-3 text-xs font-medium text-ink ${UI_INTERACTION.focusButton}`}
              >
                <Printer className="h-3.5 w-3.5 text-primary-dark shrink-0" />
                <span className="tabular-nums-google">
                  {tNav('nav.printQueue')} {bootstrap.printer.pendingQueueLength}
                </span>
              </button>
            )}

            {!isTerminalLocked && bootstrap.activeShift && allowedTabs.includes('SHIFTS_REPORTS') && (
              <button
                type="button"
                onClick={() => setActiveTab('SHIFTS_REPORTS')}
                className={`hidden xl:flex h-10 items-center gap-2 rounded-[48px] border border-hairline bg-canvas px-4 text-xs text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
              >
                <Wallet className="h-3.5 w-3.5 text-primary" />
                <span>{bootstrap.activeShift.shiftNumber}</span>
                {showExpectedDrawerInHeader ? (
                  <strong className="font-medium text-ink tabular-nums-google">
                    · {formatMoney(bootstrap.activeShift.expectedCashSatang, activeFiscalConfig.currencyCode)}
                  </strong>
                ) : (
                  <span className="rounded-[48px] bg-surface-1 px-2 py-0.5 text-[11px] text-ink-muted">
                    {tNav('nav.shiftOpenBadge')}
                  </span>
                )}
              </button>
            )}

            {showHilBenchButton && (
              <button
                type="button"
                onClick={() => setHilDrawerOpen(true)}
                aria-label={tNav('nav.openHilAria')}
                className={`flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3 sm:px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <Cpu className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">HIL Bench</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setPinModalOpen(true)}
              aria-label={
                isTerminalLocked
                  ? tNav('nav.lockedAria')
                  : pickApp(
                      `สลับผู้ใช้งาน (ปัจจุบัน: ${activeUser.displayName} บทบาท ${activeUser.role})`,
                      `ປ່ຽນພະນັກງານ (ປັດຈຸບັນ: ${activeUser.displayName} ບົດບາດ ${activeUser.role})`,
                      `Switch staff user (Current: ${activeUser.displayName}, Role: ${activeUser.role})`
                    )
              }
              className={`flex h-10 items-center gap-2 rounded-[48px] border border-hairline bg-canvas px-3 sm:px-4 font-google-display text-xs font-medium text-ink hover:border-primary ${UI_INTERACTION.focusButton}`}
            >
              <UserCheck className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="max-w-[84px] sm:max-w-[120px] truncate">
                {isTerminalLocked ? tNav('nav.lockedTerminal') : activeUser.displayName}
              </span>
              <span className="hidden sm:inline rounded-[48px] bg-surface-1 px-2 py-0.5 text-[10px] font-medium text-primary-dark">
                {isTerminalLocked ? 'LOCKED' : activeUser.role}
              </span>
            </button>

            <button
              type="button"
              onClick={handleLockTerminal}
              title={tNav('nav.lockTerminalTitle')}
              aria-label={tNav('nav.lockTerminalTitle')}
              className={`flex h-10 w-10 items-center justify-center rounded-full border border-hairline bg-canvas text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
            >
              <Lock className="h-4 w-4" />
            </button>
          </div>
        </header>
      </div>

      {/* Mobile Nav Fallback (< md) */}
      <nav
        inert={isBackgroundInert ? true : undefined}
        className="md:hidden flex items-center gap-1 overflow-x-auto border-b border-hairline bg-canvas px-4"
        aria-label={tNav('nav.mobileNavAria')}
      >
        {navItems
          .filter((n) => !n.hidden)
          .map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`relative flex h-11 items-center gap-1.5 px-3 font-google-display text-xs font-medium whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="rounded-[48px] bg-primary px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums-google">
                    {item.badge}
                  </span>
                )}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary" />
                )}
              </button>
            );
          })}
      </nav>

      {/* Main Content Canvas: Pure #ffffff across the entire application */}
      <main
        inert={isBackgroundInert ? true : undefined}
        className="flex-1 w-full bg-canvas text-ink"
      >
        <div className="max-w-[1440px] w-full mx-auto px-4 lg:px-6 py-6">
          {isTerminalLocked ? (
            <div className="rounded-[8px] border border-hairline bg-surface-1 py-20 px-6 text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
                <Lock className="h-7 w-7" aria-hidden="true" />
              </div>
              <div className="space-y-1.5">
                <h1 className="font-google-display text-[22px] font-normal text-ink">
                  {tNav('nav.lockedBannerTitle')}
                </h1>
                <p className="text-sm text-ink-muted">
                  {tNav('nav.lockedBannerHint')}
                </p>
              </div>
            </div>
          ) : (
            <>
              {activeTab === 'POS' && allowedTabs.includes('POS') && (
                <PosRegisterWorkspace
                  outletId={activeOutletId}
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
                  simulationModeEnabled={simulationModeEnabled}
                  onScannerRoutingModeChange={setPosScannerRoutingMode}
                  onRegisterSlipScannerHandlers={(onSlipQr, onSlipRollback, onSlipBeforeSnapshot) => {
                    slipQrScannedHandlerRef.current = onSlipQr;
                    slipFirstCharRollbackRef.current = onSlipRollback;
                    slipBeforeSnapshotRef.current = onSlipBeforeSnapshot ?? null;
                  }}
                  onRefreshState={() => refreshBootstrap()}
                  onToast={pushToast}
                />
              )}

              {activeTab === 'KDS' && allowedTabs.includes('KDS') && (
                <KdsWorkspace
                  outletId={activeOutletId}
                  initialTickets={bootstrap.kdsTickets}
                  onRefreshBootstrap={() => refreshBootstrap()}
                  onToast={pushToast}
                />
              )}

              {activeTab === 'WAREHOUSE' && allowedTabs.includes('WAREHOUSE') && (
                <WarehouseWorkspace
                  outletId={activeOutletId}
                  bootstrap={bootstrap}
                  currentUser={activeUser}
                  onRefreshState={() => refreshBootstrap()}
                  onToast={pushToast}
                />
              )}

              {activeTab === 'BOM' && allowedTabs.includes('BOM') && (
                <BomStudioWorkspace
                  outletId={activeOutletId}
                  bootstrap={bootstrap}
                  currentUser={activeUser}
                  simulationModeEnabled={simulationModeEnabled}
                  onRefreshState={() => refreshBootstrap()}
                  onToast={pushToast}
                />
              )}

              {activeTab === 'SHIFTS_REPORTS' && allowedTabs.includes('SHIFTS_REPORTS') && (
                <ShiftAndReportsWorkspace
                  outletId={activeOutletId}
                  bootstrap={bootstrap}
                  currentUser={activeUser}
                  onRefreshState={() => refreshBootstrap()}
                  onToast={pushToast}
                />
              )}

              {activeTab === 'SETTINGS' && allowedTabs.includes('SETTINGS') && (
                <SystemSettingsWorkspace
                  outletId={activeOutletId}
                  bootstrap={bootstrap}
                  currentUser={activeUser}
                  simulationModeEnabled={simulationModeEnabled}
                  onToggleSimulationMode={handleToggleSimulationMode}
                  onClearLocaleOverride={() => {
                    preLoginLocaleDirtyRef.current = false;
                    setOverrideLocale(undefined);
                  }}
                  onRefreshState={() => refreshBootstrap()}
                  onToast={pushToast}
                />
              )}
            </>
          )}
        </div>
      </main>

      {/* Canonical Google Soft-Gray Footer (`#f8f9fa` surface-1, `#5f6368` ink-muted) */}
      <footer
        inert={isBackgroundInert ? true : undefined}
        className="border-t border-hairline bg-surface-1 px-4 lg:px-6 py-4 text-xs text-ink-muted"
      >
        <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-medium text-ink">{bootstrap.storeSettings.storeName}</span>
            <span>
              {activeFiscalConfig.countryCode === 'LA'
                ? `LA · ${activeFiscalConfig.currencyCode} (${activeFiscalConfig.currencySymbol})`
                : `${tNav('nav.branchPrefix')} ${bootstrap.storeSettings.outletCode} (${bootstrap.storeSettings.branchCode})`}
            </span>
            <span>
              {activeFiscalConfig.countryCode === 'LA'
                ? tNav('nav.taxIdPrefix.LA')
                : tNav('nav.taxIdPrefix.TH')}{' '}
              {bootstrap.storeSettings.taxId || '-'}
            </span>
            <span className="inline-flex items-center gap-1 text-ink-soft">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              {bootstrap.ledgerInvariant.valid ? tNav('nav.ledgerOk') : tNav('nav.ledgerErr')}
            </span>
            <span className="inline-flex items-center gap-1 text-ink-soft">
              <Printer className="h-3.5 w-3.5 text-primary" />
              {tNav('nav.printerLabel')} ({bootstrap.printerConfig.paperWidthMm}mm):{' '}
              {bootstrap.printer.ready
                ? tNav('nav.printerReady')
                : `${tNav('nav.printerOffline')} (${bootstrap.printer.pendingQueueLength})`}
            </span>
          </div>
          {allowedTabs.includes('POS') && (
            <div className="hidden lg:block text-ink-muted">{tNav('nav.shortcuts')}</div>
          )}
        </div>
      </footer>

      {/* Modals & Drawers */}
      <PinLockModal
        open={isTerminalLocked || pinModalOpen}
        canDismiss={!isTerminalLocked}
        staffUsers={bootstrap.staffUsers}
        currentUser={isTerminalLocked ? null : activeUser}
        simulationModeEnabled={simulationModeEnabled}
        onAuthenticated={handleUserAuthenticated}
        onClose={() => {
          if (!isTerminalLocked) {
            setPinModalOpen(false);
          }
        }}
      />

      {showHilBenchButton && (
        <HilSimulatorDrawer
          open={hilDrawerOpen}
          onClose={() => setHilDrawerOpen(false)}
          bootstrap={bootstrap}
          lastPrintedReceipt={lastPrintedReceipt}
          onInjectScannedBarcodeToPos={(barcode) => {
            setRollbackCount((c) => c + 1);
            handleScanBarcodeIntoCart(barcode, 1);
          }}
          onRefreshState={() => refreshBootstrap()}
          onToast={pushToast}
        />
      )}

      {/* Accessible Hairline Toast Notifications with distinct Icons + aria-live */}
      <div
        role="region"
        aria-label={tNav('toast.regionAria')}
        aria-live="polite"
        className="fixed bottom-5 left-4 right-4 sm:left-auto sm:right-5 z-50 flex flex-col gap-2 sm:max-w-md pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto rounded-[4px] border px-4 py-3 text-sm font-medium transition-colors duration-200 ${
              t.tone === 'error'
                ? 'border-ink bg-ink text-white'
                : t.tone === 'warn'
                  ? 'border-ink bg-primary-soft text-ink'
                  : 'border-hairline bg-canvas text-ink'
            }`}
          >
            <div className="flex items-start gap-2.5">
              {t.tone === 'error' ? (
                <XCircle className="h-4 w-4 text-white shrink-0 mt-0.5" aria-hidden="true" />
              ) : t.tone === 'warn' ? (
                <AlertTriangle
                  className="h-4 w-4 text-primary-dark shrink-0 mt-0.5"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
              )}
              <span className="leading-snug">
                {t.tone === 'warn' && (
                  <strong className="font-medium mr-1">{tNav('toast.warnPrefix')}</strong>
                )}
                {t.tone === 'error' && (
                  <strong className="font-medium mr-1">{tNav('toast.errorPrefix')}</strong>
                )}
                {t.message}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
    </I18nProvider>
  );
};
