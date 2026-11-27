import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  Check,
  CheckCircle2,
  Clock,
  CreditCard,
  Delete,
  History,
  Layers,
  LayoutGrid,
  List,
  Minus,
  PauseCircle,
  PlayCircle,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Scale,
  ScanBarcode,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import {
  formatMilliUnitsToQtyString,
  parseDecimalStringToScaledInt,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
} from '../../../../shared-contracts/src/fixed-point.ts';
import {
  type CashTenderCurrencyCode,
  baseLakMinorToRequiredForeignMinor,
  computeOrderFinancialTotals,
  foreignMinorToBaseLakMinor,
  formatForeignAmountForInput,
  formatForeignMoney,
  formatFxTenderReceiptLine,
  getForeignQuickCashButtons,
  getFxRateForCurrency,
  getQuickCashTenderButtonsForCountry,
  getSplitCashQuickPresetsForCountry,
} from '../../../../shared-contracts/src/currency.ts';
import { LAO_BANKS } from '../../../../shared-contracts/src/lao-payment.ts';
import {
  posTransport,
  resolveBackendAssetUrl,
  type SlipConfirmationModalDto,
} from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type { GlobalScannerRoutingMode } from '../hooks/useGlobalBarcodeScanner.ts';
import {
  getAllowedOrderTypesForProfile,
  getCategoriesForProfile,
  getOrderReferenceFieldMeta,
  isVariantInProfileDomain,
} from '../utils/profile-domain.ts';
import { renderThaiReceiptTo203DpiCanvasRaster } from '../utils/thai-canvas-rasterizer.ts';
import type {
  BootstrapPayload,
  CartItem,
  CatalogVariantDetailDto,
  CheckoutOrderRequest,
  GuestOrderRecordDto,
  HeldBillRecordDto,
  ModifierDto,
  PrintedReceiptPreview,
  QrOrderingRuntimeStatusDto,
  SplitPaymentLegInput,
  StaffUserDto,
  TableQrSessionDto,
  TaxMode,
} from '../types.ts';
import {
  playNewQrOrderChime,
  QrOrderingInboxPanel,
  TableQrSlipModal,
} from './QrOrderingInboxPanel.tsx';
import { ConfirmDialog, ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';
import { VoidOrderAuthModal, type VoidTargetOrderSummary } from './VoidOrderAuthModal.tsx';

interface PosRegisterWorkspaceProps {
  outletId?: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  rollbackCount: number;
  onScanBarcodeString: (barcode: string, multiplierCount?: number) => void;
  lastPrintedReceipt: PrintedReceiptPreview | null;
  setLastPrintedReceipt: (r: PrintedReceiptPreview | null) => void;
  simulationModeEnabled?: boolean;
  onScannerRoutingModeChange?: (mode: GlobalScannerRoutingMode) => void;
  onRegisterSlipScannerHandlers?: (
    onSlipQr: ((qrRaw: string) => void) | null,
    onSlipRollback: (() => void) | null,
    onSlipBeforeSnapshot?: (() => void) | null
  ) => void;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

const HELD_BILLS_LEGACY_STORAGE_KEY = 'rube_pos_v3_held_bills';
const MULTIPLIER_PRESETS = [1, 2, 6, 12] as const;

const SLIP_PRESETS: ReadonlyArray<{ label: string; sub: string; raw: string }> = [
  {
    label: 'สลิปธนาคารกสิกรไทย (KBANK)',
    sub: 'โครงสร้าง TLV ถูกต้อง',
    raw: '0041000600000101030040220KBANK2026112590015102TH9104ABCD',
  },
  {
    label: 'สลิปธนาคารไทยพาณิชย์ (SCB)',
    sub: 'โครงสร้าง TLV ถูกต้อง',
    raw: '0041000600000101030140220SCB202611259988775102TH9104EF01',
  },
  {
    label: 'บาร์โค้ดสินค้าปลอมเป็นสลิป',
    sub: 'ทดสอบระบบบล็อก TLV',
    raw: '8851952350161',
  },
];

interface PreBurstSlipSnapshot {
  el: HTMLInputElement | null;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function captureSlipInputSnapshot(
  el: Element | null,
  fallbackValue: string
): PreBurstSlipSnapshot {
  if (el instanceof HTMLInputElement && el.dataset.scannerSlipAllow === 'true') {
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

function restoreSlipInputSnapshotDom(snap: PreBurstSlipSnapshot): void {
  const { el, value, selectionStart, selectionEnd } = snap;
  if (!el || !document.contains(el)) return;
  el.value = value;
  if (selectionStart !== null && selectionEnd !== null) {
    try {
      el.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      // ignore selection errors
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

function withManualCartLineQty(line: CartItem, nextQuantityMilli: number): CartItem {
  const { overrideLineTotalSatang: _omitOv, scaleBadgeText: _omitSb, ...rest } = line;
  return {
    ...rest,
    quantityMilli: nextQuantityMilli,
  };
}

/**
 * Editorial edge-to-edge top artwork for `card-photo` (google.design.md lines 24 & 378):
 * Chrome stays strictly monochrome (#ffffff / #202124 / #dadce0) + singular #1a73e8;
 * the edge-to-edge top band carries the editorial visual composition with zero inset.
 */
const ProductEditorialArtwork: React.FC<{
  item: CatalogVariantDetailDto;
  inCartQtyMilli: number;
}> = React.memo(({ item, inCartQtyMilli }) => {
  const isCafe = item.categoryId === 'CAT-CAFE' || item.isComposite || item.kitchenStation === 'BAR' || item.kitchenStation === 'MAIN';
  const isScale = item.isWeightedScale;
  const outOfStock = !item.isComposite && item.inStockMilli <= 0;
  const lowStock =
    !item.isComposite && item.inStockMilli > 0 && item.inStockMilli <= item.lowStockThresholdMilli;
  const photoUrl = resolveBackendAssetUrl(item.imageUrl);

  // Deterministic visual offset per SKU so items within a category remain distinct at a glance
  let hash = 0;
  for (let i = 0; i < item.id.length; i++) {
    hash = (hash * 31 + item.id.charCodeAt(i)) | 0;
  }
  const shiftX = Math.abs(hash % 56);
  const shiftR = 46 + Math.abs((hash >> 3) % 32);

  return (
    <div className="relative h-[132px] w-full overflow-hidden bg-[#f8f9fa] border-b border-[#dadce0]">
      {photoUrl ? (
        <img
          src={photoUrl}
          alt={item.itemName}
          loading="lazy"
          className={`h-full w-full object-cover ${outOfStock ? 'opacity-55 grayscale' : ''}`}
        />
      ) : isCafe ? (
        /* Warm editorial espresso / tea botanical studio composition */
        <svg
          viewBox="0 0 360 132"
          className={`h-full w-full object-cover ${outOfStock ? 'opacity-55 grayscale' : ''}`}
          aria-hidden="true"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient id={`cafe-${item.id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2b1d16" />
              <stop offset="55%" stopColor="#6f4730" />
              <stop offset="100%" stopColor="#d7b490" />
            </linearGradient>
          </defs>
          <rect width="360" height="132" fill={`url(#cafe-${item.id})`} />
          <circle cx={260 + shiftX} cy="104" r={shiftR} fill="#f3dfc6" fillOpacity="0.2" />
          <circle cx={230 + shiftX} cy="38" r="32" fill="#ffffff" fillOpacity="0.12" />
          <circle cx={72 + (shiftX >> 1)} cy="100" r="8" fill="#1b110c" fillOpacity="0.55" />
          <circle cx={92 + (shiftX >> 1)} cy="106" r="7" fill="#1b110c" fillOpacity="0.55" />
          <circle cx={110 + (shiftX >> 1)} cy="98" r="8" fill="#1b110c" fillOpacity="0.55" />
        </svg>
      ) : isScale ? (
        /* Crisp butcher / fresh-market architectural composition */
        <svg
          viewBox="0 0 360 132"
          className={`h-full w-full object-cover ${outOfStock ? 'opacity-55 grayscale' : ''}`}
          aria-hidden="true"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient id={`scale-${item.id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#3c1f23" />
              <stop offset="60%" stopColor="#8f4049" />
              <stop offset="100%" stopColor="#e8b8be" />
            </linearGradient>
          </defs>
          <rect width="360" height="132" fill={`url(#scale-${item.id})`} />
          <path
            d="M0 94 Q110 68 210 96 T360 82 L360 132 L0 132 Z"
            fill="#ffffff"
            fillOpacity="0.16"
          />
          <rect
            x={224 + (shiftX >> 1)}
            y="22"
            width="88"
            height="44"
            rx="2"
            fill="#ffffff"
            fillOpacity="0.14"
          />
        </svg>
      ) : (
        /* Clean architectural retail / glacial hydration composition */
        <svg
          viewBox="0 0 360 132"
          className={`h-full w-full object-cover ${outOfStock ? 'opacity-55 grayscale' : ''}`}
          aria-hidden="true"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient id={`ret-${item.id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#13293d" />
              <stop offset="55%" stopColor="#2b5876" />
              <stop offset="100%" stopColor="#9bc1dc" />
            </linearGradient>
          </defs>
          <rect width="360" height="132" fill={`url(#ret-${item.id})`} />
          <circle cx={265 + shiftX} cy="30" r={shiftR} fill="#ffffff" fillOpacity="0.14" />
          <path
            d="M0 102 C90 80 180 118 360 86 L360 132 L0 132 Z"
            fill="#ffffff"
            fillOpacity="0.18"
          />
        </svg>
      )}

      {/* Subtle top-left monochrome metadata + stock alert tags */}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
        <span className="rounded-[4px] bg-white/95 px-2 py-0.5 text-[11px] font-medium text-ink">
          {item.isComposite
            ? 'สูตร BOM'
            : item.isWeightedScale
              ? 'ชั่งน้ำหนัก กก.'
              : item.sku}
        </span>
        {outOfStock ? (
          <span className="rounded-[4px] bg-ink px-2 py-0.5 text-[11px] font-medium text-white">
            สินค้าหมด
          </span>
        ) : lowStock ? (
          <span className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-ink">
            ใกล้หมด
          </span>
        ) : null}
      </div>

      {/* Active In-Cart Counter Pill (Google Blue #1a73e8 48px pill) */}
      {inCartQtyMilli > 0 && (
        <div className="absolute right-3 top-3 rounded-[48px] bg-primary px-3 py-1 text-xs font-medium text-white tabular-nums-google">
          ในบิล{' '}
          {item.isWeightedScale
            ? formatMilliUnitsToQtyString(inCartQtyMilli, item.unitName)
            : `${Math.round(inCartQtyMilli / 1000)} ${item.unitName}`}
        </div>
      )}
    </div>
  );
});
ProductEditorialArtwork.displayName = 'ProductEditorialArtwork';

export const PosRegisterWorkspace: React.FC<PosRegisterWorkspaceProps> = ({
  outletId = 'OUTLET-HQ',
  bootstrap,
  currentUser,
  cart,
  setCart,
  searchQuery,
  setSearchQuery,
  rollbackCount,
  onScanBarcodeString,
  lastPrintedReceipt,
  setLastPrintedReceipt,
  simulationModeEnabled = false,
  onScannerRoutingModeChange,
  onRegisterSlipScannerHandlers,
  onRefreshState,
  onToast,
}) => {
  const {
    fiscal,
    countryCode,
    currencyCode,
    locale,
    receiptLocale,
    vatRatePercentLabel,
    t,
    pick,
    money,
    moneyInput,
    parseMoney,
    dateTime,
  } = useI18n();
  const isLaos = countryCode === 'LA';
  const qrMethodLabel = isLaos ? t('pos.qrLabel.LA') : t('pos.qrLabel.TH');
  const vatDisplayName =
    locale === 'lo'
      ? `ອມພ ${vatRatePercentLabel}%`
      : `VAT ${vatRatePercentLabel}%`;

  const defaultLayout =
    bootstrap.profile === 'RETAIL' ? 'SCAN_LEDGER' : 'STUDIO_CARDS';
  const [posSubView, setPosSubView] = useState<
    'STUDIO_CARDS' | 'SCAN_LEDGER' | 'HELD_BILLS' | 'QR_ORDERS' | 'ORDER_HISTORY'
  >(defaultLayout);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [scanMultiplier, setScanMultiplier] = useState<number>(1);
  const [orderType, setOrderType] = useState<CheckoutOrderRequest['orderType']>(
    bootstrap.profile === 'RETAIL' ? 'RETAIL' : 'TAKEAWAY'
  );
  const [queueOrTableLabel, setQueueOrTableLabel] = useState<string>('');
  const [taxMode, setTaxMode] = useState<TaxMode>(fiscal.defaultTaxMode);
  const [laoSenderBankCode, setLaoSenderBankCode] = useState<string>('BCEL');

  useEffect(() => {
    setTaxMode(fiscal.defaultTaxMode);
  }, [fiscal.countryCode, fiscal.defaultTaxMode]);

  // Discount supports either Baht (THB) or Percentage (%)
  const [discountMode, setDiscountMode] = useState<'BAHT' | 'PERCENT'>('BAHT');
  const [discountInput, setDiscountInput] = useState<string>('0');

  // Active selected cart line for inline exact quantity editing
  const [editingCartKey, setEditingCartKey] = useState<string | null>(null);
  const [editingQtyInput, setEditingQtyInput] = useState<string>('');

  // Server-Synced Held Bills (shared across POS terminals on the same SQLite Leader DB)
  const [heldBills, setHeldBills] = useState<HeldBillRecordDto[]>(
    () => bootstrap.heldBills ?? []
  );
  const [syncingHeldBills, setSyncingHeldBills] = useState<boolean>(false);

  // Local LAN QR Table Ordering Inbox & Table QR Slip Modal
  const [qrGuestOrders, setQrGuestOrders] = useState<GuestOrderRecordDto[]>(
    () => bootstrap.qrGuestOrders ?? []
  );
  const [qrTableSessions, setQrTableSessions] = useState<TableQrSessionDto[]>(
    () => bootstrap.qrTableSessions ?? []
  );
  const [qrStatus, setQrStatus] = useState<QrOrderingRuntimeStatusDto | undefined>(
    () => bootstrap.qrOrderingStatus
  );
  const [syncingQrOrders, setSyncingQrOrders] = useState<boolean>(false);
  const [tableQrModalOpen, setTableQrModalOpen] = useState<boolean>(false);
  const prevPendingQrCountRef = useRef<number>(
    (bootstrap.qrGuestOrders ?? []).filter((o) => o.status === 'PENDING_CONFIRM').length
  );

  useEffect(() => {
    if (bootstrap.qrGuestOrders) {
      setQrGuestOrders(bootstrap.qrGuestOrders);
    }
    if (bootstrap.qrTableSessions) {
      setQrTableSessions(bootstrap.qrTableSessions);
    }
    if (bootstrap.qrOrderingStatus) {
      setQrStatus(bootstrap.qrOrderingStatus);
    }
  }, [bootstrap.qrGuestOrders, bootstrap.qrTableSessions, bootstrap.qrOrderingStatus]);

  const refreshQrGuestOrders = useCallback(
    async (silent = false) => {
      if (!silent) setSyncingQrOrders(true);
      try {
        const res = await posTransport.listQrGuestOrders(outletId);
        setQrGuestOrders(res.orders);
        setQrTableSessions(res.tableSessions);
        setQrStatus(res.status);
        if (res.pendingCount > prevPendingQrCountRef.current) {
          playNewQrOrderChime();
          const newest = res.orders.find((o) => o.status === 'PENDING_CONFIRM');
          if (newest) {
            onToast(
              pick(
                `ออเดอร์ QR ใหม่เข้า! ${newest.orderCode} (โต๊ะ ${newest.tableLabel}) — ${newest.lines.length} รายการ`,
                `ອໍເດີ QR ໃໝ່ເຂົ້າ! ${newest.orderCode} (ໂຕະ ${newest.tableLabel})`,
                `New QR Order ${newest.orderCode} (Table ${newest.tableLabel})`
              ),
              'warn'
            );
          }
        }
        prevPendingQrCountRef.current = res.pendingCount;
      } catch {
        // ignore transient polling error
      } finally {
        if (!silent) setSyncingQrOrders(false);
      }
    },
    [onToast, outletId, pick]
  );

  useEffect(() => {
    if (posSubView === 'QR_ORDERS') {
      void refreshQrGuestOrders(false);
    }
  }, [posSubView, refreshQrGuestOrders]);

  useEffect(() => {
    if (!bootstrap.qrOrderingConfig?.enabled) return;
    const timer = window.setInterval(() => {
      void refreshQrGuestOrders(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [bootstrap.qrOrderingConfig?.enabled, refreshQrGuestOrders]);

  const pendingQrOrdersCount = useMemo(
    () => qrGuestOrders.filter((o) => o.status === 'PENDING_CONFIRM').length,
    [qrGuestOrders]
  );

  // Order History Search & Status Filter (P3.1)
  const [orderHistoryQuery, setOrderHistoryQuery] = useState<string>('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<'ALL' | 'COMPLETED' | 'VOIDED'>(
    'ALL'
  );

  useEffect(() => {
    if (bootstrap.heldBills) {
      setHeldBills(bootstrap.heldBills);
    }
  }, [bootstrap.heldBills]);

  // One-time seamless migration of any legacy localStorage held bills into server SQLite `store_config`
  useEffect(() => {
    try {
      const legacyRaw = window.localStorage.getItem(HELD_BILLS_LEGACY_STORAGE_KEY);
      if (!legacyRaw) return;
      const legacyList = JSON.parse(legacyRaw) as Array<Omit<HeldBillRecordDto, 'outletId'>>;
      window.localStorage.removeItem(HELD_BILLS_LEGACY_STORAGE_KEY);
      if (Array.isArray(legacyList) && legacyList.length > 0) {
        void (async () => {
          for (const item of legacyList.reverse()) {
            const res = await posTransport.saveHeldBill({
              outletId,
              actorUserId: currentUser.id,
              bill: { ...item, outletId },
            });
            setHeldBills(res.heldBills);
          }
        })().catch(() => {});
      }
    } catch {
      // ignore storage errors
    }
  }, [currentUser.id, outletId]);

  const refreshServerHeldBills = useCallback(async () => {
    setSyncingHeldBills(true);
    try {
      const res = await posTransport.listHeldBills(outletId);
      setHeldBills(res.heldBills);
    } catch {
      // ignore transient network errors
    } finally {
      setSyncingHeldBills(false);
    }
  }, [outletId]);

  useEffect(() => {
    if (posSubView === 'HELD_BILLS') {
      void refreshServerHeldBills();
    }
  }, [posSubView, refreshServerHeldBills]);

  // Modifier customization dialog state (supports both new item and editing an existing cart line)
  const [customizingVariant, setCustomizingVariant] = useState<CatalogVariantDetailDto | null>(
    null
  );
  const [editingModifierCartKey, setEditingModifierCartKey] = useState<string | null>(null);
  const [draftModIds, setDraftModIds] = useState<string[]>(['MOD-SWEET-100']);
  const [draftQtyInput, setDraftQtyInput] = useState<string>('1');

  // Checkout Dialog state
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [paymentTab, setPaymentTab] = useState<'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'SPLIT'>('CASH');
  const [splitSecondMethod, setSplitSecondMethod] = useState<'PROMPTPAY_QR' | 'CARD'>(
    'PROMPTPAY_QR'
  );
  const [splitCashBahtInput, setSplitCashBahtInput] = useState<string>('100');
  const [cashTenderCurrency, setCashTenderCurrency] = useState<CashTenderCurrencyCode>('LAK');
  const [cashTenderedBahtInput, setCashTenderedBahtInput] = useState<string>('');
  const [cashNumpadPristine, setCashNumpadPristine] = useState<boolean>(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrPayloadText, setQrPayloadText] = useState<string>('');
  const [qrCrcHex, setQrCrcHex] = useState<string>('');
  const [slipMiniQrInput, setSlipMiniQrInput] = useState<string>('');
  const [slipVerificationModal, setSlipVerificationModal] =
    useState<SlipConfirmationModalDto | null>(null);
  const [processingCheckout, setProcessingCheckout] = useState(false);

  // Non-blocking Post-Checkout Change & Last Sale Banner (auto-dismisses when next customer item enters cart)
  const [lastCompletedSaleSummary, setLastCompletedSaleSummary] = useState<{
    receiptNumber: string;
    abbTaxInvoiceNo: string;
    totalSatang: number;
    tenderedSatang?: number | undefined;
    changeGivenSatang: number;
    paymentLabel: string;
    spoolStatus: string;
  } | null>(null);

  // Void Authorization Modal state (Mandatory Reason + Stateless Manager PIN Override)
  const [voidTargetOrder, setVoidTargetOrder] = useState<VoidTargetOrderSummary | null>(null);

  // Receipt Preview Dialog & 203-DPI Canvas Rasterizer
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [receiptViewMode, setReceiptViewMode] = useState<'CANVAS_203DPI' | 'TEXT'>('CANVAS_203DPI');
  const [printPaperWidthMm, setPrintPaperWidthMm] = useState<80 | 58>(
    bootstrap.printerConfig?.paperWidthMm === 58 ? 58 : 80
  );
  const [canvasRasterStats, setCanvasRasterStats] = useState<{
    widthPx: number;
    heightPx: number;
    transportMode?: string | undefined;
    bytesSent?: number | undefined;
  } | null>(null);

  const uid = useId();
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    tone: 'danger' | 'primary';
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const discountInputRef = useRef<HTMLInputElement | null>(null);

  const allowedOrderTypes = useMemo(
    () => getAllowedOrderTypesForProfile(bootstrap.profile),
    [bootstrap.profile]
  );
  const orderRefMeta = useMemo(
    () => getOrderReferenceFieldMeta(bootstrap.profile),
    [bootstrap.profile]
  );

  useEffect(() => {
    if (bootstrap.profile === 'RETAIL') {
      setPosSubView('SCAN_LEDGER');
      setOrderType('RETAIL');
    } else if (bootstrap.profile === 'HOSPITALITY') {
      setPosSubView('STUDIO_CARDS');
      setOrderType('DINE_IN');
    } else if (!allowedOrderTypes.some((o) => o.value === orderType)) {
      setOrderType(allowedOrderTypes[0]?.value ?? 'TAKEAWAY');
    }
  }, [allowedOrderTypes, bootstrap.profile]);

  const modifiersById = useMemo(() => {
    return new Map<string, ModifierDto>(bootstrap.modifiers.map((m) => [m.id, m]));
  }, [bootstrap.modifiers]);

  const inCartQtyByVariant = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cart) {
      map.set(c.variantId, (map.get(c.variantId) ?? 0) + c.quantityMilli);
    }
    return map;
  }, [cart]);

  // Auto-clear previous customer's change banner as soon as the next customer's first item enters the cart
  useEffect(() => {
    if (cart.length > 0 && lastCompletedSaleSummary) {
      setLastCompletedSaleSummary(null);
    }
  }, [cart.length, lastCompletedSaleSummary]);

  const visibleCategories = useMemo(
    () => getCategoriesForProfile(bootstrap.categories, bootstrap.profile, 'POS'),
    [bootstrap.categories, bootstrap.profile]
  );

  useEffect(() => {
    if (
      selectedCategoryId !== 'ALL' &&
      !visibleCategories.some((c) => c.id === selectedCategoryId)
    ) {
      setSelectedCategoryId('ALL');
    }
  }, [selectedCategoryId, visibleCategories]);

  // Sellable items strictly separated by active shop profile, category, and search query
  const sellableCatalog = useMemo(() => {
    return bootstrap.catalogDetailed.filter((item) => {
      if (!item.active) return false;
      if (!isVariantInProfileDomain(item, bootstrap.profile, 'POS')) return false;
      if (selectedCategoryId !== 'ALL' && item.categoryId !== selectedCategoryId) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        return (
          item.itemName.toLowerCase().includes(q) ||
          item.sku.toLowerCase().includes(q) ||
          (item.barcode ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [bootstrap.catalogDetailed, bootstrap.profile, selectedCategoryId, searchQuery]);

  // Derived Fixed-Point Cart Summary (Zero IEEE-754 float drift)
  const cartSummary = useMemo(() => {
    let subtotalSatang = 0;
    const computedLines = cart.map((line) => {
      const mods = line.selectedModifierIds
        .map((id) => modifiersById.get(id))
        .filter((m): m is ModifierDto => m !== undefined);
      const modDeltaSatang = mods.reduce((s, m) => s + m.priceDeltaSatang, 0);
      const effectiveUnitSatang = line.unitPriceSatang + modDeltaSatang;
      const baseLineSatang =
        line.overrideLineTotalSatang ??
        Number(
          roundDivBigInt(BigInt(line.quantityMilli) * BigInt(line.unitPriceSatang), SCALE_MILLI)
        );
      const modsSatang = Number(
        roundDivBigInt(BigInt(line.quantityMilli) * BigInt(modDeltaSatang), SCALE_MILLI)
      );
      const lineTotalSatang = Math.max(0, baseLineSatang + modsSatang);
      subtotalSatang += lineTotalSatang;
      return {
        ...line,
        mods,
        effectiveUnitSatang,
        lineTotalSatang,
      };
    });

    let discountSatang = 0;
    try {
      if (discountMode === 'BAHT') {
        discountSatang = Math.min(subtotalSatang, Math.max(0, parseMoney(discountInput || '0')));
      } else {
        const pctBps = Math.min(
          10_000,
          Math.max(0, parseDecimalStringToScaledInt(discountInput || '0', 2))
        );
        discountSatang = Number(
          roundDivBigInt(BigInt(subtotalSatang) * BigInt(pctBps), SCALE_BASIS_POINTS)
        );
      }
    } catch {
      discountSatang = 0;
    }

    const baseFinancials = computeOrderFinancialTotals({
      subtotalSatang,
      discountSatang,
      vatRateBps: fiscal.vatRateBps,
      taxMode,
      currencyCode,
      applyCashRounding: false,
    });
    const cashFinancials = computeOrderFinancialTotals({
      subtotalSatang,
      discountSatang,
      vatRateBps: fiscal.vatRateBps,
      taxMode,
      currencyCode,
      applyCashRounding: true,
      cashRoundingStepMajor: fiscal.cashRoundingStepMajor,
    });
    const totalItemUnitsCount = computedLines.reduce(
      (acc, l) => acc + (l.isWeightedScale ? 1 : Math.max(1, Math.round(l.quantityMilli / 1000))),
      0
    );

    return {
      lines: computedLines,
      totalItemUnitsCount,
      subtotalSatang: baseFinancials.subtotalSatang,
      discountSatang: baseFinancials.discountSatang,
      netBeforeTaxSatang: baseFinancials.netBeforeTaxSatang,
      taxSatang: baseFinancials.taxSatang,
      totalSatang: baseFinancials.totalSatang,
      cashPayableTotalSatang: cashFinancials.totalSatang,
      cashRoundingDiscountSatang: cashFinancials.cashRoundingDiscountSatang,
      cashNetBeforeTaxSatang: cashFinancials.netBeforeTaxSatang,
      cashTaxSatang: cashFinancials.taxSatang,
    };
  }, [
    cart,
    currencyCode,
    discountInput,
    discountMode,
    fiscal.cashRoundingStepMajor,
    fiscal.vatRateBps,
    modifiersById,
    parseMoney,
    taxMode,
  ]);

  const addVariantToCartDirect = useCallback(
    (variant: CatalogVariantDetailDto, qtyMilli: number, modifierIds: string[] = []) => {
      const sortedMods = [...modifierIds].sort();
      const cartKey = `${variant.id}::${sortedMods.join(',')}`;
      setCart((prev) => {
        const idx = prev.findIndex((c) => c.cartKey === cartKey);
        if (idx >= 0) {
          const updated = [...prev];
          const existing = updated[idx]!;
          updated[idx] = {
            ...existing,
            quantityMilli: existing.quantityMilli + qtyMilli,
          };
          return updated;
        }
        return [
          ...prev,
          {
            cartKey,
            variantId: variant.id,
            itemName: variant.itemName,
            variantName: variant.variantName,
            sku: variant.sku,
            unitName: variant.unitName,
            quantityMilli: qtyMilli,
            unitPriceSatang: variant.priceSatang,
            selectedModifierIds: sortedMods,
            isWeightedScale: variant.isWeightedScale,
          },
        ];
      });
    },
    [setCart]
  );

  const handleProductSelect = (variant: CatalogVariantDetailDto) => {
    const qtyMilli = scanMultiplier * 1_000;
    if (
      variant.isComposite &&
      bootstrap.featureFlags.enableRoleBasedModifiers &&
      bootstrap.modifierGroups.length > 0
    ) {
      const defaultSingleMods: string[] = [];
      for (const group of bootstrap.modifierGroups) {
        if (group.selectionType === 'SINGLE' && group.modifiers.length > 0) {
          const preferred =
            group.modifiers.find((m) => m.id === 'MOD-SWEET-100') ?? group.modifiers[0];
          if (preferred) defaultSingleMods.push(preferred.id);
        }
      }
      setEditingModifierCartKey(null);
      setCustomizingVariant(variant);
      setDraftModIds(defaultSingleMods);
      setDraftQtyInput(String(scanMultiplier));
      setScanMultiplier(1);
      return;
    }
    addVariantToCartDirect(variant, qtyMilli, []);
    if (!variant.isComposite && variant.inStockMilli <= 0) {
      onToast(
        `"${variant.itemName}" สต็อกในระบบเหลือ 0 — เพิ่มลงบิลแล้ว (โปรดตรวจสอบสินค้าหน้าร้าน)`,
        'warn'
      );
    }
    if (scanMultiplier > 1) {
      setScanMultiplier(1);
    }
  };

  const handleOpenCartLineModifierEditor = (line: CartItem) => {
    const matchedVariant = bootstrap.catalogDetailed.find((v) => v.id === line.variantId);
    if (!matchedVariant) return;
    setEditingModifierCartKey(line.cartKey);
    setCustomizingVariant(matchedVariant);
    setDraftModIds([...line.selectedModifierIds]);
    setDraftQtyInput(
      line.isWeightedScale
        ? formatMilliUnitsToQtyString(line.quantityMilli)
        : String(Math.max(1, Math.round(line.quantityMilli / 1000)))
    );
  };

  const holdRecallInFlightRef = useRef(false);
  const checkoutInFlightRef = useRef(false);
  const cartCheckoutIdemKeyRef = useRef<string | null>(null);
  const cartCheckoutIdemSigRef = useRef<string>('');
  const qrReqSeqRef = useRef(0);
  const lastQrSigRef = useRef<string>('');
  const prevModalAmountsRef = useRef<{ open: boolean; total: number; splitRem: number }>({
    open: false,
    total: 0,
    splitRem: 0,
  });
  const slipPreBurstSnapshotRef = useRef<PreBurstSlipSnapshot | null>(null);
  const slipMiniQrInputRef = useRef(slipMiniQrInput);
  slipMiniQrInputRef.current = slipMiniQrInput;

  const cartSignature = useMemo(() => {
    const linesSig = cartSummary.lines
      .map(
        (l) =>
          `${l.cartKey}:${l.quantityMilli}:${l.unitPriceSatang}:${l.overrideLineTotalSatang ?? ''}:${l.selectedModifierIds.join('+')}`
      )
      .join('|');
    return `${outletId}|${taxMode}|${cartSummary.discountSatang}|${paymentTab}|${linesSig}`;
  }, [cartSummary.discountSatang, cartSummary.lines, outletId, paymentTab, taxMode]);

  useEffect(() => {
    if (cartSignature !== cartCheckoutIdemSigRef.current) {
      cartCheckoutIdemKeyRef.current = null;
      cartCheckoutIdemSigRef.current = cartSignature;
    }
  }, [cartSignature]);

  const handleHoldCurrentBill = useCallback(async () => {
    if (holdRecallInFlightRef.current) return;
    if (cart.length === 0) {
      if (heldBills.length > 0) {
        setPosSubView('HELD_BILLS');
      } else {
        onToast('ยังไม่มีรายการในบิลสำหรับพักบิล', 'warn');
      }
      return;
    }
    holdRecallInFlightRef.current = true;
    const refLabel =
      queueOrTableLabel.trim() || `คิวพัก #${String(heldBills.length + 1).padStart(2, '0')}`;
    const record: HeldBillRecordDto = {
      id: `HOLD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      outletId,
      referenceLabel: refLabel,
      orderType,
      taxMode,
      discountMode,
      discountInput,
      cart,
      totalSatang: cartSummary.totalSatang,
      heldByName: currentUser.displayName,
      heldAtIso: new Date().toISOString(),
    };
    try {
      const saved = await posTransport.saveHeldBill({
        outletId,
        actorUserId: currentUser.id,
        bill: record,
      });
      setHeldBills(saved.heldBills);
      setCart([]);
      setQueueOrTableLabel('');
      setDiscountInput('0');
      void onRefreshState();
      onToast(`พักบิล "${refLabel}" ลงเซิร์ฟเวอร์เรียบร้อยแล้ว (เรียกข้ามเครื่องได้ · F8)`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      holdRecallInFlightRef.current = false;
    }
  }, [
    cart,
    cartSummary.totalSatang,
    currentUser.displayName,
    currentUser.id,
    discountInput,
    discountMode,
    heldBills.length,
    onRefreshState,
    onToast,
    orderType,
    outletId,
    queueOrTableLabel,
    setCart,
    taxMode,
  ]);

  const executeRecallHeldBill = async (
    held: HeldBillRecordDto,
    reconciledCart: CartItem[],
    warnings: string[]
  ) => {
    if (holdRecallInFlightRef.current) return;
    holdRecallInFlightRef.current = true;
    try {
      const removed = await posTransport.deleteHeldBill({
        outletId,
        actorUserId: currentUser.id,
        id: held.id,
        recall: true,
      });
      setHeldBills(removed.heldBills);
      setCart(reconciledCart);
      setOrderType(held.orderType);
      setTaxMode(held.taxMode);
      if (held.discountMode) setDiscountMode(held.discountMode);
      if (held.discountInput !== undefined) setDiscountInput(held.discountInput);
      setQueueOrTableLabel(held.referenceLabel);
      setPosSubView(bootstrap.profile === 'RETAIL' ? 'SCAN_LEDGER' : 'STUDIO_CARDS');
      void onRefreshState();
      if (warnings.length > 0) {
        onToast(`เรียกบิล "${held.referenceLabel}" แล้ว (${warnings.join(' · ')})`, 'warn');
      } else {
        onToast(`เรียกบิล "${held.referenceLabel}" กลับมาที่หน้าขายแล้ว`, 'success');
      }
    } catch (err) {
      void refreshServerHeldBills();
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      holdRecallInFlightRef.current = false;
    }
  };

  const handleRecallHeldBill = async (held: HeldBillRecordDto) => {
    if (holdRecallInFlightRef.current) return;

    const droppedNames: string[] = [];
    const repricedNames: string[] = [];
    let droppedModifiersCount = 0;
    const reconciledCart: CartItem[] = [];

    for (const line of held.cart) {
      const variant = bootstrap.catalogDetailed.find((v) => v.id === line.variantId);
      if (!variant || !variant.active) {
        droppedNames.push(line.itemName);
        continue;
      }
      const validModIds = line.selectedModifierIds.filter((id) => modifiersById.has(id));
      if (validModIds.length < line.selectedModifierIds.length) {
        droppedModifiersCount += line.selectedModifierIds.length - validModIds.length;
      }
      const sortedMods = [...validModIds].sort();
      const hasScaleOverride = line.overrideLineTotalSatang !== undefined;
      const nextUnitPriceSatang = hasScaleOverride ? line.unitPriceSatang : variant.priceSatang;
      if (!hasScaleOverride && line.unitPriceSatang !== variant.priceSatang) {
        repricedNames.push(variant.itemName);
      }
      const nextCartKey =
        hasScaleOverride || line.scaleBadgeText
          ? line.cartKey
          : `${variant.id}::${sortedMods.join(',')}`;

      const reconciledLine: CartItem = {
        cartKey: nextCartKey,
        variantId: variant.id,
        itemName: variant.itemName,
        variantName: variant.variantName,
        sku: variant.sku,
        unitName: variant.unitName,
        quantityMilli: line.quantityMilli,
        unitPriceSatang: nextUnitPriceSatang,
        selectedModifierIds: sortedMods,
        isWeightedScale: variant.isWeightedScale,
        ...(line.scaleBadgeText !== undefined ? { scaleBadgeText: line.scaleBadgeText } : {}),
        ...(line.overrideLineTotalSatang !== undefined
          ? { overrideLineTotalSatang: line.overrideLineTotalSatang }
          : {}),
      };

      if (!hasScaleOverride && !line.scaleBadgeText) {
        const existingIdx = reconciledCart.findIndex((c) => c.cartKey === nextCartKey);
        if (existingIdx >= 0) {
          const existing = reconciledCart[existingIdx]!;
          reconciledCart[existingIdx] = {
            ...existing,
            quantityMilli: existing.quantityMilli + reconciledLine.quantityMilli,
          };
          continue;
        }
      }
      reconciledCart.push(reconciledLine);
    }

    if (reconciledCart.length === 0) {
      onToast(
        `ไม่สามารถเรียกบิล "${held.referenceLabel}" ได้ เนื่องจากสินค้าทั้งหมดถูกลบหรือพักการขายไปแล้ว`,
        'warn'
      );
      return;
    }

    const warnings: string[] = [];
    if (droppedNames.length > 0) {
      warnings.push(`ตัดสินค้าที่ลบ/พักขาย ${droppedNames.length} รายการ (${droppedNames.join(', ')})`);
    }
    if (repricedNames.length > 0) {
      warnings.push(`ปรับราคาตามปัจจุบัน ${repricedNames.length} รายการ`);
    }
    if (droppedModifiersCount > 0) {
      warnings.push(`ตัดตัวเลือกเสริมที่ถูกลบ ${droppedModifiersCount} รายการ`);
    }

    if (cart.length > 0) {
      setConfirmAction({
        title: `${pick('แทนที่บิลปัจจุบันด้วย', 'ແທນທີ່ບິນປັດຈຸບັນດ້ວຍ', 'Replace current bill with')} "${held.referenceLabel}"?`,
        description: `${cartSummary.totalItemUnitsCount} ${t('pos.itemsUnit')} (${money(cartSummary.totalSatang)})`,
        confirmLabel: t('common.confirm'),
        tone: 'primary',
        onConfirm: async () => {
          await executeRecallHeldBill(held, reconciledCart, warnings);
        },
      });
      return;
    }

    await executeRecallHeldBill(held, reconciledCart, warnings);
  };

  const splitCashSatang = useMemo(() => {
    try {
      const parsed = parseMoney(splitCashBahtInput || '0');
      return Math.max(0, Math.min(cartSummary.totalSatang, parsed));
    } catch {
      return 0;
    }
  }, [cartSummary.totalSatang, parseMoney, splitCashBahtInput]);

  const splitRemainingSatang = Math.max(0, cartSummary.totalSatang - splitCashSatang);

  const clearPromptPayQrState = useCallback(() => {
    qrReqSeqRef.current += 1;
    lastQrSigRef.current = '';
    setQrDataUrl(null);
    setQrPayloadText('');
    setQrCrcHex('');
  }, []);

  const loadPromptPayQr = useCallback(
    async (overrideAmountSatang?: number) => {
      const effectiveTargetSatang = overrideAmountSatang ?? cartSummary.totalSatang;
      if (cart.length === 0 || effectiveTargetSatang <= 0) {
        clearPromptPayQrState();
        return;
      }
      const reqSeq = ++qrReqSeqRef.current;
      const qrSig = `${outletId}|${taxMode}|${cartSummary.discountSatang}|${cartSummary.totalSatang}|${effectiveTargetSatang}`;
      lastQrSigRef.current = qrSig;
      setQrDataUrl(null);
      setQrPayloadText('');
      setQrCrcHex('');
      try {
        const qr = await posTransport.generatePromptPayQr({
          outletId,
          taxMode,
          discountSatang: cartSummary.discountSatang,
          ...(overrideAmountSatang !== undefined ? { overrideAmountSatang } : {}),
          lines: cart.map((l) => ({
            variantId: l.variantId,
            quantityMilli: l.quantityMilli,
            unitPriceSatang: l.unitPriceSatang,
            selectedModifierIds: l.selectedModifierIds,
            ...(l.overrideLineTotalSatang !== undefined
              ? { overrideLineTotalSatang: l.overrideLineTotalSatang }
              : {}),
          })),
        });
        if (reqSeq !== qrReqSeqRef.current) return;
        const url = await QRCode.toDataURL(qr.payload, {
          width: 224,
          margin: 1,
          color: { dark: '#202124', light: '#ffffff' },
        });
        if (reqSeq !== qrReqSeqRef.current) return;
        setQrPayloadText(qr.payload);
        setQrCrcHex(qr.crcHex);
        setQrDataUrl(url);
      } catch (err) {
        if (reqSeq !== qrReqSeqRef.current) return;
        lastQrSigRef.current = '';
        setQrDataUrl(null);
        setQrPayloadText('');
        setQrCrcHex('');
        onToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [
      cart,
      cartSummary.discountSatang,
      cartSummary.totalSatang,
      clearPromptPayQrState,
      onToast,
      outletId,
      taxMode,
    ]
  );

  // Reset stale slip verification & QR whenever bill total or split remainder changes while Checkout modal is open
  useEffect(() => {
    const prev = prevModalAmountsRef.current;
    if (
      checkoutModalOpen &&
      prev.open &&
      (prev.total !== cartSummary.totalSatang || prev.splitRem !== splitRemainingSatang)
    ) {
      setSlipVerificationModal(null);
      clearPromptPayQrState();
    }
    prevModalAmountsRef.current = {
      open: checkoutModalOpen,
      total: cartSummary.totalSatang,
      splitRem: splitRemainingSatang,
    };
  }, [cartSummary.totalSatang, checkoutModalOpen, clearPromptPayQrState, splitRemainingSatang]);

  // Debounced (250ms) auto-regeneration of Split PromptPay QR when cash split amount changes
  useEffect(() => {
    if (
      !checkoutModalOpen ||
      paymentTab !== 'SPLIT' ||
      splitSecondMethod !== 'PROMPTPAY_QR' ||
      splitRemainingSatang <= 0 ||
      cartSummary.totalSatang <= 0
    ) {
      return;
    }
    const targetSig = `${outletId}|${taxMode}|${cartSummary.discountSatang}|${cartSummary.totalSatang}|${splitRemainingSatang}`;
    if (lastQrSigRef.current === targetSig) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadPromptPayQr(splitRemainingSatang);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    cartSummary.discountSatang,
    cartSummary.totalSatang,
    checkoutModalOpen,
    loadPromptPayQr,
    outletId,
    paymentTab,
    splitRemainingSatang,
    splitSecondMethod,
    taxMode,
  ]);

  const dispatch203DpiThaiCanvasPrint = useCallback(
    async (input: {
      salesOrderId?: string | undefined;
      receiptNumber: string;
      abbTaxInvoiceNo: string;
      createdAtIso: string;
      cashierName: string;
      taxMode?: TaxMode | undefined;
      lines: Array<{
        itemName: string;
        qtyText: string;
        totalText: string;
        modifiersText?: string | undefined;
      }>;
      subtotalSatang: number;
      discountSatang: number;
      cashRoundingDiscountSatang?: number | undefined;
      netBeforeTaxSatang: number;
      taxSatang: number;
      totalSatang: number;
      paymentSummaryLines: string[];
      paperWidthMm?: 80 | 58;
      kickCashDrawer: boolean;
    }) => {
      const widthMm = input.paperWidthMm ?? printPaperWidthMm;
      const raster = renderThaiReceiptTo203DpiCanvasRaster({
        paperWidthMm: widthMm,
        countryCode,
        receiptLocale,
        vatRatePercentLabel,
        storeName: bootstrap.storeSettings.storeName,
        storeAddress: fiscal.storeAddress,
        taxId: bootstrap.storeSettings.taxId,
        branchCode: bootstrap.storeSettings.branchCode,
        posRegNo: bootstrap.storeSettings.rdPosRegNo,
        receiptNumber: input.receiptNumber,
        abbTaxInvoiceNo: input.abbTaxInvoiceNo,
        createdAtText: dateTime(input.createdAtIso),
        cashierName: input.cashierName,
        taxMode: input.taxMode ?? taxMode,
        lines: input.lines,
        subtotalText: money(input.subtotalSatang),
        discountSatang: input.discountSatang,
        discountText: money(input.discountSatang),
        ...(input.cashRoundingDiscountSatang && input.cashRoundingDiscountSatang > 0
          ? { cashRoundingDiscountText: money(input.cashRoundingDiscountSatang) }
          : {}),
        netBeforeTaxText: money(input.netBeforeTaxSatang),
        vatText: money(input.taxSatang),
        grandTotalText: money(input.totalSatang),
        paymentSummaryLines: input.paymentSummaryLines,
      });

      const hwRes = await posTransport.printCanvasRaster({
        packedBitmapBase64: raster.packedBitmapBase64,
        widthPx: raster.widthPx,
        heightPx: raster.heightPx,
        kickCashDrawer: input.kickCashDrawer,
        ...(input.salesOrderId ? { salesOrderId: input.salesOrderId } : {}),
        receiptNumber: input.receiptNumber,
      });

      setCanvasRasterStats({
        widthPx: raster.widthPx,
        heightPx: raster.heightPx,
        transportMode: hwRes.hardwareOutcome.transportMode,
        bytesSent: hwRes.hardwareOutcome.bytesWritten,
      });

      return { raster, hwRes };
    },
    [
      bootstrap.storeSettings.branchCode,
      bootstrap.storeSettings.rdPosRegNo,
      bootstrap.storeSettings.storeName,
      bootstrap.storeSettings.taxId,
      countryCode,
      dateTime,
      fiscal.storeAddress,
      money,
      printPaperWidthMm,
      receiptLocale,
      taxMode,
      vatRatePercentLabel,
    ]
  );

  const openCheckoutModal = useCallback(
    async (initialTab: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'SPLIT') => {
      if (cart.length === 0) {
        onToast('กรุณาเลือกรายการสินค้าก่อนรับชำระเงิน', 'warn');
        return;
      }
      clearPromptPayQrState();
      const resolvedTab =
        cartSummary.totalSatang <= 0 && (initialTab === 'PROMPTPAY_QR' || initialTab === 'SPLIT')
          ? 'CASH'
          : initialTab;
      if (resolvedTab !== initialTab) {
        onToast(
          pick(
            `ยอดชำระสุทธิเป็น ${money(0)} กรุณารับชำระผ่านช่องทางเงินสด`,
            `ຍອດຊຳລະສຸດທິເປັນ ${money(0)} ກະລຸນາຮັບຊຳລະຜ່ານເງິນສົດ`,
            `Net total is ${money(0)}; please complete via Cash`
          ),
          'warn'
        );
      }
      setPaymentTab(resolvedTab);
      setCashTenderCurrency('LAK');
      setCashTenderedBahtInput(moneyInput(cartSummary.cashPayableTotalSatang));
      const computedHalf =
        cartSummary.totalSatang > 200
          ? Math.floor(cartSummary.totalSatang / 200) * 100
          : Math.floor(cartSummary.totalSatang / 2);
      const initialSplitCash =
        cartSummary.totalSatang > 100 ? Math.max(100, computedHalf) : computedHalf;
      if (resolvedTab === 'SPLIT' || cartSummary.totalSatang > 200) {
        setSplitCashBahtInput(moneyInput(initialSplitCash));
      }
      setCashNumpadPristine(true);
      setSlipMiniQrInput('');
      setSlipVerificationModal(null);
      setCheckoutModalOpen(true);

      if (resolvedTab === 'PROMPTPAY_QR' && cartSummary.totalSatang > 0) {
        await loadPromptPayQr();
      } else if (
        resolvedTab === 'SPLIT' &&
        splitSecondMethod === 'PROMPTPAY_QR' &&
        cartSummary.totalSatang > 0
      ) {
        const rem = Math.max(0, cartSummary.totalSatang - initialSplitCash);
        if (rem > 0) await loadPromptPayQr(rem);
      }
    },
    [
      cart.length,
      cartSummary.cashPayableTotalSatang,
      cartSummary.totalSatang,
      clearPromptPayQrState,
      loadPromptPayQr,
      money,
      moneyInput,
      onToast,
      pick,
      splitSecondMethod,
    ]
  );

  const instantExactCashCheckoutRef = useRef<(() => void) | null>(null);

  // Cashier Function-Key Ergonomics (F2, F4, F8, F9, F10, F12, Escape)
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (
        document.querySelector('[role="dialog"], [role="alertdialog"]') !== null ||
        checkoutModalOpen ||
        Boolean(customizingVariant) ||
        receiptModalOpen ||
        Boolean(confirmAction) ||
        Boolean(voidTargetOrder)
      ) {
        return;
      }
      if (e.repeat) {
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setScanMultiplier((cur) => {
          const idx = MULTIPLIER_PRESETS.indexOf(cur as (typeof MULTIPLIER_PRESETS)[number]);
          return MULTIPLIER_PRESETS[(idx + 1) % MULTIPLIER_PRESETS.length]!;
        });
      } else if (e.key === 'F8') {
        e.preventDefault();
        void handleHoldCurrentBill();
      } else if (e.key === 'F9') {
        e.preventDefault();
        discountInputRef.current?.focus();
        discountInputRef.current?.select();
      } else if (e.key === 'F10') {
        e.preventDefault();
        if (cart.length > 0) {
          void openCheckoutModal('CASH');
        }
      } else if (e.key === 'F12') {
        e.preventDefault();
        if (cart.length > 0) {
          instantExactCashCheckoutRef.current?.();
        }
      } else if (e.key === 'Escape') {
        if (editingCartKey) {
          setEditingCartKey(null);
        }
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [
    cart.length,
    checkoutModalOpen,
    confirmAction,
    customizingVariant,
    editingCartKey,
    handleHoldCurrentBill,
    openCheckoutModal,
    receiptModalOpen,
    voidTargetOrder,
  ]);

  const handleVerifySlipStep1 = useCallback(
    async (overrideAmountSatang?: number, explicitQrRaw?: string) => {
      const rawQr = (explicitQrRaw ?? slipMiniQrInput).trim();
      if (!rawQr) {
        onToast(
          isLaos
            ? pick(
                'กรุณาสแกนหรือกรอกเลข Ref / Ticket สลิปโอนเงินลูกค้า',
                'ກະລຸນາສະແກນ ຫຼື ປ້ອນເລກອ້າງອີງ Ref / Ticket ສະລິບໂອນເງິນ',
                'Please scan or enter the transfer slip reference ID'
              )
            : 'กรุณาสแกนหรือวางข้อมูล BOT Mini-QR จากสลิปธนาคารลูกค้า',
          'warn'
        );
        return;
      }
      setProcessingCheckout(true);
      try {
        const modal = await posTransport.verifyBotSlipStep1({
          miniQrRaw: rawQr,
          ...(isLaos ? { senderBankCode: laoSenderBankCode } : {}),
          taxMode,
          discountSatang: cartSummary.discountSatang,
          ...(overrideAmountSatang !== undefined ? { overrideAmountSatang } : {}),
          lines: cart.map((l) => ({
            variantId: l.variantId,
            quantityMilli: l.quantityMilli,
            unitPriceSatang: l.unitPriceSatang,
            selectedModifierIds: l.selectedModifierIds,
            ...(l.overrideLineTotalSatang !== undefined
              ? { overrideLineTotalSatang: l.overrideLineTotalSatang }
              : {}),
          })),
        });
        setSlipVerificationModal(modal);
        if (!modal.valid) {
          onToast(modal.errorMessageThai || 'สลิปไม่ผ่านการตรวจสอบ', 'error');
        }
      } catch (err) {
        onToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setProcessingCheckout(false);
      }
    },
    [cart, cartSummary.discountSatang, isLaos, laoSenderBankCode, onToast, pick, slipMiniQrInput, taxMode]
  );

  // Sync context-aware 2D scanner mode with App-level global scanner listener
  useEffect(() => {
    const isAwaitingSlipQr =
      checkoutModalOpen &&
      !processingCheckout &&
      !slipVerificationModal?.valid &&
      cartSummary.totalSatang > 0 &&
      (paymentTab === 'PROMPTPAY_QR' ||
        (paymentTab === 'SPLIT' &&
          splitSecondMethod === 'PROMPTPAY_QR' &&
          splitCashSatang > 0 &&
          splitRemainingSatang > 0));

    if (isAwaitingSlipQr) {
      onScannerRoutingModeChange?.('SLIP_QR');
    } else if (
      checkoutModalOpen ||
      Boolean(customizingVariant) ||
      receiptModalOpen ||
      Boolean(confirmAction) ||
      Boolean(voidTargetOrder)
    ) {
      onScannerRoutingModeChange?.('BLOCKED');
    } else {
      onScannerRoutingModeChange?.('POS_CART');
    }

    return () => {
      onScannerRoutingModeChange?.('POS_CART');
    };
  }, [
    cartSummary.totalSatang,
    checkoutModalOpen,
    confirmAction,
    customizingVariant,
    onScannerRoutingModeChange,
    paymentTab,
    processingCheckout,
    receiptModalOpen,
    slipVerificationModal?.valid,
    splitCashSatang,
    splitRemainingSatang,
    splitSecondMethod,
    voidTargetOrder,
  ]);

  useEffect(() => {
    if (!onRegisterSlipScannerHandlers) return;
    onRegisterSlipScannerHandlers(
      (qrRaw: string) => {
        slipPreBurstSnapshotRef.current = null;
        setSlipMiniQrInput(qrRaw);
        setSlipVerificationModal(null);
        const overrideAmt = paymentTab === 'SPLIT' ? splitRemainingSatang : undefined;
        void handleVerifySlipStep1(overrideAmt, qrRaw);
      },
      () => {
        const snap = slipPreBurstSnapshotRef.current;
        slipPreBurstSnapshotRef.current = null;
        if (snap) {
          restoreSlipInputSnapshotDom(snap);
          setSlipMiniQrInput(snap.value);
        } else {
          setSlipMiniQrInput((prev) => prev.slice(0, -1));
        }
      },
      () => {
        const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
        slipPreBurstSnapshotRef.current = captureSlipInputSnapshot(
          activeEl,
          slipMiniQrInputRef.current
        );
      }
    );
    return () => {
      onRegisterSlipScannerHandlers(null, null, null);
    };
  }, [
    handleVerifySlipStep1,
    onRegisterSlipScannerHandlers,
    paymentTab,
    splitRemainingSatang,
  ]);

  const executeFinalCheckout = async (
    method: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'SPLIT',
    verifiedSlipRaw?: string,
    instantExactCash = false
  ) => {
    if (checkoutInFlightRef.current || processingCheckout || cart.length === 0) return;
    checkoutInFlightRef.current = true;

    try {
      if ((method === 'PROMPTPAY_QR' || method === 'SPLIT') && cartSummary.totalSatang <= 0) {
        onToast(
          pick(
            `ยอดสุทธิเป็น ${money(0)} กรุณารับชำระผ่านช่องทางเงินสด`,
            `ຍອດສຸດທິເປັນ ${money(0)} ກະລຸນາຮັບຊຳລະຜ່ານເງິນສົດ`,
            `Total is ${money(0)}; please complete via Cash`
          ),
          'warn'
        );
        return;
      }

      const requiredCashTotalSatang = cartSummary.cashPayableTotalSatang;
      const useForeignCash =
        method === 'CASH' &&
        !instantExactCash &&
        isLaos &&
        fiscal.fxRates.enabled &&
        (cashTenderCurrency === 'THB' || cashTenderCurrency === 'USD');
      let tenderedSatang = method === 'CASH' ? requiredCashTotalSatang : cartSummary.totalSatang;
      let foreignTenderAmountSatang: number | undefined;
      let splitPaymentsPayload: SplitPaymentLegInput[] | undefined;

      if (method === 'CASH') {
        if (!instantExactCash) {
          if (useForeignCash) {
            try {
              foreignTenderAmountSatang = parseDecimalStringToScaledInt(
                cashTenderedBahtInput || '0',
                2
              );
            } catch {
              onToast(
                pick('จำนวนเงินสดต่างประเทศไม่ถูกต้อง', 'ຈຳນວນເງິນສົດຕ່າງປະເທດບໍ່ຖືກຕ້ອງ', 'Invalid foreign cash amount'),
                'error'
              );
              return;
            }
            const rateWholeLak = getFxRateForCurrency(
              fiscal.fxRates,
              cashTenderCurrency as 'THB' | 'USD'
            );
            tenderedSatang = foreignMinorToBaseLakMinor(foreignTenderAmountSatang, rateWholeLak);
          } else {
            try {
              tenderedSatang = parseMoney(cashTenderedBahtInput || '0');
            } catch {
              onToast(pick('จำนวนเงินสดที่รับมาไม่ถูกต้อง', 'ຈຳນວນເງິນສົດທີ່ຮັບມາບໍ່ຖືກຕ້ອງ', 'Invalid cash amount'), 'error');
              return;
            }
          }
          if (tenderedSatang < requiredCashTotalSatang) {
            onToast(
              pick('จำนวนเงินสดที่รับมาน้อยกว่ายอดสุทธิที่ต้องชำระ', 'ຈຳນວນເງິນສົດທີ່ຮັບມາໜ້ອຍກວ່າຍອດຊຳລະ', 'Cash tendered is less than total due'),
              'warn'
            );
            return;
          }
        }
      } else if (method === 'SPLIT') {
        if (splitCashSatang <= 0 || splitRemainingSatang <= 0) {
          onToast(
            pick(
              'สำหรับการแยกจ่าย กรุณาระบุยอดเงินสดให้มากกว่า 0 และน้อยกว่ายอดสุทธิ',
              'ສຳລັບການແຍກຈ່າຍ ກະລຸນາລະບຸຍອດເງິນສົດໃຫ້ຫຼາຍກວ່າ 0 ແລະ ໜ້ອຍກວ່າຍອດສຸດທິ',
              'For split payment, cash portion must be > 0 and < total'
            ),
            'warn'
          );
          return;
        }
        const splitSlipRaw =
          verifiedSlipRaw !== undefined ? verifiedSlipRaw.trim() : '';
        splitPaymentsPayload = [
          {
            paymentMethod: 'CASH',
            amountSatang: splitCashSatang,
            cashTenderedSatang: splitCashSatang,
          },
          {
            paymentMethod: splitSecondMethod,
            amountSatang: splitRemainingSatang,
            ...(splitSecondMethod === 'PROMPTPAY_QR' && splitSlipRaw
              ? { slipTransRefRaw: splitSlipRaw }
              : {}),
            ...(splitSecondMethod === 'PROMPTPAY_QR' && isLaos
              ? { slipSenderBankCode: laoSenderBankCode }
              : {}),
          },
        ];
      }

      const effectiveIdemSig = `${cartSignature}|${method}`;
      if (cartCheckoutIdemSigRef.current !== effectiveIdemSig || !cartCheckoutIdemKeyRef.current) {
        cartCheckoutIdemSigRef.current = effectiveIdemSig;
        const randomPart =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        cartCheckoutIdemKeyRef.current = `POS-IDEM-${randomPart}`;
      }
      const idempotencyKey = cartCheckoutIdemKeyRef.current;

      const cartSnapshotLines = cartSummary.lines.map((l) => ({
        itemName: l.itemName,
        qtyText: l.isWeightedScale
          ? formatMilliUnitsToQtyString(l.quantityMilli, l.unitName)
          : `${Math.round(l.quantityMilli / 1000)} ${l.unitName}`,
        totalText: money(l.lineTotalSatang),
        ...(l.mods.length > 0 ? { modifiersText: l.mods.map((m) => m.name).join(', ') } : {}),
      }));
      const snapshotSubtotal = cartSummary.subtotalSatang;
      const snapshotDiscount = cartSummary.discountSatang;
      const snapshotQueueOrTable = queueOrTableLabel.trim();

      setProcessingCheckout(true);
      const res = await posTransport.checkoutOrder({
        outletId,
        cashierId: currentUser.id,
        idempotencyKey,
        orderType,
        ...(snapshotQueueOrTable ? { tableOrQueueNo: snapshotQueueOrTable } : {}),
        paymentMethod: method === 'SPLIT' ? 'CASH' : method,
        ...(method === 'CASH' && !useForeignCash ? { cashTenderedSatang: tenderedSatang } : {}),
        ...(useForeignCash && foreignTenderAmountSatang !== undefined
          ? {
              foreignTenderCurrency: cashTenderCurrency as 'THB' | 'USD',
              foreignTenderAmountSatang,
            }
          : {}),
        ...(method === 'PROMPTPAY_QR' && verifiedSlipRaw
          ? { slipTransRefRaw: verifiedSlipRaw }
          : {}),
        ...(method === 'PROMPTPAY_QR' && isLaos ? { slipSenderBankCode: laoSenderBankCode } : {}),
        ...(splitPaymentsPayload ? { splitPayments: splitPaymentsPayload } : {}),
        taxMode,
        discountSatang: snapshotDiscount,
        paperWidthPx: printPaperWidthMm === 58 ? 384 : 576,
        ...(cart.length > 0 && cart.every((l) => l.kdsDispatched === true)
          ? { skipKdsEnqueue: true }
          : {}),
        lines: cart.map((l) => ({
          variantId: l.variantId,
          itemName: l.itemName,
          unitName: l.unitName,
          quantityMilli: l.quantityMilli,
          unitPriceSatang: l.unitPriceSatang,
          selectedModifierIds: l.selectedModifierIds,
          ...(l.overrideLineTotalSatang !== undefined
            ? { overrideLineTotalSatang: l.overrideLineTotalSatang }
            : {}),
        })),
      });

      const formatPaymentMethodName = (m: string) =>
        m === 'PROMPTPAY_QR' ? qrMethodLabel : m;

      const paymentSummaryLines = res.order.payments.map(
        (p) =>
          `${formatPaymentMethodName(p.paymentMethod)}: ${money(p.amountSatang)}${
            p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''
          }`
      );
      if (snapshotQueueOrTable) {
        paymentSummaryLines.unshift(`${pick('ป้ายคิว/โต๊ะ', 'ເລກຄິວ/ໂຕະ', 'Queue/Table')}: ${snapshotQueueOrTable}`);
      }
      if (res.order.fxTender) {
        paymentSummaryLines.push(formatFxTenderReceiptLine(res.order.fxTender, receiptLocale));
      }
      if (res.order.changeGivenSatang && res.order.changeGivenSatang > 0) {
        paymentSummaryLines.push(`${t('pos.changeLabel')}: ${money(res.order.changeGivenSatang)}`);
      }

      const shouldKickDrawer =
        (bootstrap.printerConfig?.autoKickDrawerOnCash ?? true) &&
        (method === 'CASH' || method === 'SPLIT');

      let rasterPreviewUrl: string | undefined;
      let hardwareDispatched: boolean | undefined;
      let hardwareError: string | undefined;

      try {
        const printed = await dispatch203DpiThaiCanvasPrint({
          salesOrderId: res.order.salesOrderId,
          receiptNumber: res.order.receiptNumber,
          abbTaxInvoiceNo: res.order.abbTaxInvoiceNo,
          createdAtIso: res.order.createdAt,
          cashierName: currentUser.displayName,
          taxMode,
          lines: cartSnapshotLines,
          subtotalSatang: res.order.subtotalSatang ?? snapshotSubtotal,
          discountSatang:
            Math.max(0, (res.order.discountSatang ?? snapshotDiscount) - (res.order.cashRoundingDiscountSatang ?? 0)),
          cashRoundingDiscountSatang: res.order.cashRoundingDiscountSatang,
          netBeforeTaxSatang: res.order.netBeforeTaxSatang,
          taxSatang: res.order.taxSatang,
          totalSatang: res.order.totalSatang,
          paymentSummaryLines,
          kickCashDrawer: shouldKickDrawer,
        });
        rasterPreviewUrl = printed.raster.previewDataUrl;
        hardwareDispatched = printed.hwRes.hardwareOutcome.dispatchedToHardware;
        hardwareError = printed.hwRes.hardwareOutcome.errorMessage;
      } catch (printErr) {
        onToast(
          'ไม่สามารถส่งคำสั่งพิมพ์แบบ Canvas 203-DPI ได้ — ใช้ข้อมูลใบเสร็จสำรองแทน',
          'warn'
        );
        hardwareDispatched = false;
        hardwareError = printErr instanceof Error ? printErr.message : String(printErr);
        if (shouldKickDrawer) {
          await posTransport.kickCashDrawer().catch(() => {});
        }
      }

      const receiptPreview: PrintedReceiptPreview = {
        salesOrderId: res.order.salesOrderId,
        receiptNumber: res.order.receiptNumber,
        abbTaxInvoiceNo: res.order.abbTaxInvoiceNo,
        formattedTextLines: res.printJob.formattedTextLines,
        ...(rasterPreviewUrl ? { canvasRasterPreviewUrl: rasterPreviewUrl } : {}),
        paperWidthMm: printPaperWidthMm,
        packetsCount: res.printJob.packetsCount,
        maxPacketByteLength: res.printJob.maxPacketByteLength,
        spoolStatus: res.spoolResult.status,
        pendingQueueLength: res.spoolResult.pendingQueueLength,
        ...(hardwareDispatched !== undefined ? { hardwareDispatched } : {}),
        ...(hardwareError ? { hardwareError } : {}),
      };
      setLastPrintedReceipt(receiptPreview);
      setLastCompletedSaleSummary({
        receiptNumber: res.order.receiptNumber,
        abbTaxInvoiceNo: res.order.abbTaxInvoiceNo,
        totalSatang: res.order.totalSatang,
        ...(method === 'CASH' ? { tenderedSatang } : {}),
        changeGivenSatang: res.order.changeGivenSatang ?? 0,
        paymentLabel:
          method === 'SPLIT'
            ? `${t('pos.splitTab')} (${t('pos.cashTab')} + ${splitSecondMethod === 'PROMPTPAY_QR' ? qrMethodLabel : t('pos.cardTab')})`
            : method === 'PROMPTPAY_QR'
              ? qrMethodLabel
              : method === 'CARD'
                ? t('pos.cardTab')
                : t('pos.cashTab'),
        spoolStatus: res.spoolResult.status,
      });

      cartCheckoutIdemKeyRef.current = null;
      cartCheckoutIdemSigRef.current = '';
      setCart([]);
      setQueueOrTableLabel('');
      setDiscountInput('0');
      setCheckoutModalOpen(false);
      setSlipVerificationModal(null);
      setSlipMiniQrInput('');
      await onRefreshState();

      // Only open blocking modal automatically when OS print dialog mode explicitly requires user action
      if (bootstrap.printerConfig?.mode === 'BROWSER_PRINT_DIALOG') {
        setReceiptModalOpen(true);
      }

      const changeText =
        res.order.changeGivenSatang && res.order.changeGivenSatang > 0
          ? ` · ${t('pos.changeLabel')} ${money(res.order.changeGivenSatang)}`
          : '';
      onToast(
        `${instantExactCash ? '[F12] ' : ''}${pick('บันทึกการขายสำเร็จ', 'ບັນທຶກການຂາຍສຳເລັດ', 'Sale completed')} ${res.order.abbTaxInvoiceNo}${changeText}`,
        res.spoolResult.status === 'PRINTED_IMMEDIATELY' ? 'success' : 'warn'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      checkoutInFlightRef.current = false;
      setProcessingCheckout(false);
    }
  };

  instantExactCashCheckoutRef.current = () => {
    void executeFinalCheckout('CASH', undefined, true);
  };

  const handleAuthorizedVoidOrder = async (params: {
    salesOrderId: string;
    receiptNumber: string;
    voidedByUserId: string;
    voidReason: string;
    overrideToken?: string | undefined;
  }) => {
    const res = await posTransport.voidOrder({
      salesOrderId: params.salesOrderId,
      voidedByUserId: params.voidedByUserId,
      voidReason: params.voidReason,
      ...(params.overrideToken ? { overrideToken: params.overrideToken } : {}),
    });
    await onRefreshState();
    onToast(
      `ยกเลิกบิล ${params.receiptNumber} และคืนสต็อกต้นทุนเดิม (${res.reversedLedgerEntries.length} รายการ) สำเร็จ`,
      'warn'
    );
  };

  const handleReprintOrder = async (
    salesOrderId: string,
    receiptNo: string,
    abbNo: string | null,
    overridePaperWidthMm?: 80 | 58
  ) => {
    try {
      const res = await posTransport.reprintOrder(salesOrderId, outletId);
      const matched = bootstrap.recentOrders.find((o) => o.salesOrderId === salesOrderId);
      const targetWidth = overridePaperWidthMm ?? printPaperWidthMm;

      let rasterPreviewUrl: string | undefined;
      if (matched) {
        try {
          const paymentLines =
            matched.payments && matched.payments.length > 0
              ? matched.payments.map(
                  (p) =>
                    `${p.paymentMethod === 'PROMPTPAY_QR' ? qrMethodLabel : p.paymentMethod}: ${money(p.amountSatang)}${
                      p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''
                    }`
                )
              : [`${matched.paymentSummaryLabel ?? matched.paymentMethod}: ${money(matched.totalSatang)}`];
          if (matched.fxTender) {
            paymentLines.push(formatFxTenderReceiptLine(matched.fxTender, receiptLocale));
          }
          if (matched.changeGivenSatang && matched.changeGivenSatang > 0) {
            paymentLines.push(`${t('pos.changeLabel')}: ${money(matched.changeGivenSatang)}`);
          }
          const printed = await dispatch203DpiThaiCanvasPrint({
            salesOrderId: matched.salesOrderId,
            receiptNumber: matched.receiptNumber,
            abbTaxInvoiceNo: matched.abbTaxInvoiceNo ?? '-',
            createdAtIso: matched.createdAt,
            cashierName: matched.cashierName,
            taxMode: matched.taxMode,
            lines: matched.lines.map((l) => ({
              itemName: l.itemName,
              qtyText: formatMilliUnitsToQtyString(l.quantityMilli, l.unitName),
              totalText: money(l.lineTotalSatang),
              ...(l.modifiers.length > 0
                ? { modifiersText: l.modifiers.map((m) => m.name).join(', ') }
                : {}),
            })),
            subtotalSatang: matched.subtotalSatang,
            discountSatang: matched.discountSatang,
            netBeforeTaxSatang: matched.netBeforeTaxSatang,
            taxSatang: matched.taxSatang,
            totalSatang: matched.totalSatang,
            paymentSummaryLines: paymentLines,
            paperWidthMm: targetWidth,
            kickCashDrawer: false,
          });
          rasterPreviewUrl = printed.raster.previewDataUrl;
        } catch {
          // fallback to text lines
        }
      }

      setLastPrintedReceipt({
        salesOrderId,
        receiptNumber: receiptNo,
        abbTaxInvoiceNo: abbNo ?? '-',
        formattedTextLines: res.printJob.formattedTextLines,
        ...(rasterPreviewUrl ? { canvasRasterPreviewUrl: rasterPreviewUrl } : {}),
        paperWidthMm: targetWidth,
        packetsCount: res.printJob.packetsCount,
        maxPacketByteLength: res.printJob.maxPacketByteLength,
        spoolStatus: res.spoolResult.status,
        pendingQueueLength: res.spoolResult.pendingQueueLength,
      });
      setReceiptModalOpen(true);
      await onRefreshState();
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const fxTenderEnabled = isLaos && fiscal.fxRates.enabled;
  const activeForeignCurrency: 'THB' | 'USD' | null =
    fxTenderEnabled && (cashTenderCurrency === 'THB' || cashTenderCurrency === 'USD')
      ? cashTenderCurrency
      : null;
  const activeFxRateWholeLak = activeForeignCurrency
    ? getFxRateForCurrency(fiscal.fxRates, activeForeignCurrency)
    : 1;

  const handleSelectCashTenderCurrency = (nextCurr: CashTenderCurrencyCode) => {
    setCashTenderCurrency(nextCurr);
    if (nextCurr === 'THB' || nextCurr === 'USD') {
      const rate = getFxRateForCurrency(fiscal.fxRates, nextCurr);
      const reqForeign = baseLakMinorToRequiredForeignMinor(
        cartSummary.cashPayableTotalSatang,
        rate
      );
      setCashTenderedBahtInput(formatForeignAmountForInput(reqForeign, nextCurr));
    } else {
      setCashTenderedBahtInput(moneyInput(cartSummary.cashPayableTotalSatang));
    }
    setCashNumpadPristine(true);
  };

  const handleCashNumpadPress = (key: string) => {
    if (key === 'EXACT') {
      if (activeForeignCurrency) {
        const reqForeign = baseLakMinorToRequiredForeignMinor(
          cartSummary.cashPayableTotalSatang,
          activeFxRateWholeLak
        );
        setCashTenderedBahtInput(formatForeignAmountForInput(reqForeign, activeForeignCurrency));
      } else {
        setCashTenderedBahtInput(moneyInput(cartSummary.cashPayableTotalSatang));
      }
      setCashNumpadPristine(false);
      return;
    }
    if (key === 'CLEAR') {
      setCashTenderedBahtInput('0');
      setCashNumpadPristine(false);
      return;
    }
    if (key === 'BACKSPACE') {
      setCashTenderedBahtInput((prev) => (prev.length <= 1 ? '0' : prev.slice(0, -1)));
      setCashNumpadPristine(false);
      return;
    }
    if (cashNumpadPristine) {
      setCashTenderedBahtInput(
        key === '.' ? '0.' : key === '00' || key === '000' ? '0' : key
      );
      setCashNumpadPristine(false);
      return;
    }
    const allowDecimal = activeForeignCurrency !== null || currencyCode !== 'LAK';
    setCashTenderedBahtInput((prev) => {
      if (key === '.' && (!allowDecimal || prev.includes('.'))) return prev;
      if (prev.includes('.')) {
        const [, decimals = ''] = prev.split('.');
        if (decimals.length >= 2) return prev;
        if (key === '00' || key === '000') {
          return decimals.length === 1 ? `${prev}0` : prev;
        }
      }
      if (prev === '0' && key !== '.') {
        return key === '00' || key === '000' ? '0' : key;
      }
      return prev + key;
    });
  };

  const filteredOrderHistory = useMemo(() => {
    const q = orderHistoryQuery.trim().toLowerCase();
    return bootstrap.recentOrders.filter((ord) => {
      if (orderStatusFilter !== 'ALL' && ord.status !== orderStatusFilter) {
        return false;
      }
      if (!q) return true;
      if (ord.receiptNumber.toLowerCase().includes(q)) return true;
      if ((ord.abbTaxInvoiceNo ?? '').toLowerCase().includes(q)) return true;
      if ((ord.tableOrQueueNo ?? '').toLowerCase().includes(q)) return true;
      if (ord.cashierName.toLowerCase().includes(q)) return true;
      if ((ord.slipTransRefLast4 ?? '').toLowerCase().includes(q)) return true;
      return ord.lines.some((l) => l.itemName.toLowerCase().includes(q));
    });
  }, [bootstrap.recentOrders, orderHistoryQuery, orderStatusFilter]);

  const cashTenderedForeignSatangPreview = useMemo(() => {
    if (!activeForeignCurrency) return 0;
    try {
      return Math.max(0, parseDecimalStringToScaledInt(cashTenderedBahtInput || '0', 2));
    } catch {
      return 0;
    }
  }, [activeForeignCurrency, cashTenderedBahtInput]);

  const cashTenderedSatangPreview = useMemo(() => {
    try {
      if (activeForeignCurrency) {
        return foreignMinorToBaseLakMinor(cashTenderedForeignSatangPreview, activeFxRateWholeLak);
      }
      return parseMoney(cashTenderedBahtInput || '0');
    } catch {
      return 0;
    }
  }, [
    activeForeignCurrency,
    activeFxRateWholeLak,
    cashTenderedBahtInput,
    cashTenderedForeignSatangPreview,
    parseMoney,
  ]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* ==================================================================== */}
      {/* LEFT WORKSPACE (8 COLS): SEARCH, VIEW TABS & PRODUCT CANVAS          */}
      {/* ==================================================================== */}
      <div className="lg:col-span-7 xl:col-span-8 space-y-5">
        {/* Top Register Control Strip: Mode Underline Tabs + Smart Search Pill */}
        <div className="border-b border-hairline bg-canvas">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Canonical Google Nav-Link Tabs (4px #1a73e8 bottom-rule indicator, 48px height, zero fill) */}
            <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="มุมมองหน้าขาย POS">
              <button
                type="button"
                role="tab"
                aria-selected={posSubView === 'STUDIO_CARDS'}
                onClick={() => setPosSubView('STUDIO_CARDS')}
                className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                  posSubView === 'STUDIO_CARDS' ? 'text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
                <span>{t('pos.tab.catalog')}</span>
                {posSubView === 'STUDIO_CARDS' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                )}
              </button>

              {bootstrap.profile !== 'HOSPITALITY' && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={posSubView === 'SCAN_LEDGER'}
                  onClick={() => setPosSubView('SCAN_LEDGER')}
                  className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                    posSubView === 'SCAN_LEDGER' ? 'text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  <List className="h-4 w-4" />
                  <span>{t('pos.tab.retailTable')}</span>
                  {posSubView === 'SCAN_LEDGER' && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                  )}
                </button>
              )}

              <button
                type="button"
                role="tab"
                aria-selected={posSubView === 'HELD_BILLS'}
                onClick={() => setPosSubView('HELD_BILLS')}
                className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                  posSubView === 'HELD_BILLS' ? 'text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <PauseCircle className="h-4 w-4" />
                <span>{t('pos.tab.heldBills')}</span>
                {heldBills.length > 0 && (
                  <span className="rounded-[48px] bg-primary px-2 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                    {heldBills.length}
                  </span>
                )}
                {posSubView === 'HELD_BILLS' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={posSubView === 'QR_ORDERS'}
                onClick={() => setPosSubView('QR_ORDERS')}
                className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                  posSubView === 'QR_ORDERS' ? 'text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <QrCode className="h-4 w-4" />
                <span>{pick('ออเดอร์ QR', 'ອໍເດີ QR', 'QR Orders')}</span>
                {pendingQrOrdersCount > 0 && (
                  <span className="rounded-[48px] bg-primary px-2 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                    {pendingQrOrdersCount}
                  </span>
                )}
                {posSubView === 'QR_ORDERS' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={posSubView === 'ORDER_HISTORY'}
                onClick={() => setPosSubView('ORDER_HISTORY')}
                className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                  posSubView === 'ORDER_HISTORY' ? 'text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <History className="h-4 w-4" />
                <span>{t('pos.tab.history')} ({bootstrap.recentOrders.length})</span>
                {posSubView === 'ORDER_HISTORY' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                )}
              </button>
            </div>

            {/* Pre-Scan Quantity Multiplier Pills (F4) */}
            <div className="flex flex-wrap items-center gap-1.5 pb-2 sm:pb-0">
              <span className="text-xs text-ink-muted mr-1">{t('pos.qtyMultiplier')}</span>
              {MULTIPLIER_PRESETS.map((mult) => {
                const active = scanMultiplier === mult;
                return (
                  <button
                    key={mult}
                    type="button"
                    onClick={() => setScanMultiplier(mult)}
                    className={`min-h-[36px] min-w-[44px] rounded-[48px] border px-3 font-google-display text-xs font-medium tracking-[0.25px] ${UI_INTERACTION.focusButton} ${
                      active
                        ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                        : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                    }`}
                  >
                    ×{mult}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Smart 48px-Pill Barcode & Product Search Input + Category Filter Pills */}
        {posSubView !== 'ORDER_HISTORY' && posSubView !== 'HELD_BILLS' && (
          <div className="space-y-3">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-4 h-5 w-5 text-ink-muted" />
              <input
                ref={searchInputRef}
                data-scanner-allow="true"
                type="text"
                aria-label="ค้นหาสินค้าหรือยิงบาร์โค้ด"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchQuery.trim()) {
                    const q = searchQuery.trim();
                    if (/^\d{8,14}$/.test(q) || sellableCatalog.length === 1) {
                      const targetCode =
                        /^\d{8,14}$/.test(q)
                          ? q
                          : (sellableCatalog[0]?.barcode ?? sellableCatalog[0]?.sku ?? q);
                      onScanBarcodeString(targetCode, scanMultiplier);
                      setScanMultiplier(1);
                      setSearchQuery('');
                    }
                  }
                }}
                placeholder={t('pos.searchPlaceholder')}
                className={`h-[50px] w-full rounded-[48px] border border-hairline bg-canvas pl-12 pr-32 sm:pr-48 text-[15px] sm:text-[16px] text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
              <div className="absolute right-2 flex items-center gap-1.5 sm:gap-2">
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearchQuery('')}
                    className={`flex h-11 w-11 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                <span
                  title={pick(
                    'จำนวนครั้งที่ระบบกันคีย์ไทย/ลาวหลุดจากปืนบาร์โค้ดอัตโนมัติ',
                    'ຈຳນວນຄັ້ງທີ່ລະບົບປ້ອງກັນຄີລາວ/ໄທຫຼຸດຈາກເຄື່ອງສະແກນ',
                    'Keyboard layout interference rollback count'
                  )}
                  className="rounded-[48px] border border-hairline bg-surface-1 px-2.5 sm:px-3 py-1 text-xs text-ink-muted tabular-nums-google"
                >
                  <span className="hidden sm:inline">
                    {pick('กันคีย์ไทย/ลาว ', 'ກັນຄີລາວ/ໄທ ', 'Layout Guard ')}
                  </span>
                  <span className="sm:hidden">{countryCode} </span>
                  {rollbackCount}
                </span>
              </div>
            </div>

            {/* Category Filter Pills (48px pill radius, minimum 44px touch height) */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedCategoryId('ALL')}
                className={`min-h-[44px] shrink-0 rounded-[48px] border px-5 font-google-display text-sm font-medium tracking-[0.25px] ${UI_INTERACTION.focusButton} ${
                  selectedCategoryId === 'ALL'
                    ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                    : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                }`}
              >
                รายการขายทั้งหมด
              </button>
              {visibleCategories.map((cat) => {
                const active = selectedCategoryId === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(cat.id)}
                    className={`min-h-[44px] shrink-0 rounded-[48px] border px-5 font-google-display text-sm font-medium tracking-[0.25px] ${UI_INTERACTION.focusButton} ${
                      active
                        ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                        : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                    }`}
                  >
                    {cat.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* SUB-VIEW 1: CANONICAL GOOGLE `card-photo` STUDIO GRID              */}
        {/* 4px Material rounding, 1px #dadce0 hairline, ZERO drop shadow      */}
        {/* ================================================================== */}
        {posSubView === 'STUDIO_CARDS' &&
          (sellableCatalog.length === 0 ? (
            <div className="rounded-[4px] border border-hairline bg-canvas py-16 px-6 text-center space-y-3">
              <Search className="h-9 w-9 text-ink-muted mx-auto" />
              <p className="font-google-display text-[20px] font-normal text-ink">
                {searchQuery.trim() || selectedCategoryId !== 'ALL'
                  ? 'ไม่พบสินค้าที่ตรงกับคำค้นหาหรือหมวดหมู่นี้'
                  : 'ยังไม่มีรายการสินค้าในระบบ'}
              </p>
              <p className="text-sm text-ink-muted">
                {searchQuery.trim() || selectedCategoryId !== 'ALL'
                  ? 'ลองล้างคำค้นหาหรือเลือกดูรายการขายทั้งหมด'
                  : 'ไปที่แท็บ “คลังสินค้า & PO” ด้านบนเพื่อเพิ่มสินค้าใหม่เข้าหน้าร้าน'}
              </p>
              {(searchQuery.trim() || selectedCategoryId !== 'ALL') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategoryId('ALL');
                  }}
                  className={`h-[44px] rounded-[48px] border border-hairline bg-canvas px-6 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  ล้างคำค้นหา / ตัวกรอง
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
              {sellableCatalog.map((item) => {
                const outOfStock = !item.isComposite && item.inStockMilli <= 0;
                const lowStock =
                  !item.isComposite &&
                  item.inStockMilli > 0 &&
                  item.inStockMilli <= item.lowStockThresholdMilli;
                const inCartQty = inCartQtyByVariant.get(item.id) ?? 0;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleProductSelect(item)}
                    className={`group flex flex-col justify-between overflow-hidden rounded-[4px] border bg-canvas text-left ${UI_INTERACTION.focusButton} ${
                      inCartQty > 0 ? 'border-primary' : 'border-hairline hover:border-primary'
                    }`}
                  >
                    <div className="w-full">
                      <ProductEditorialArtwork item={item} inCartQtyMilli={inCartQty} />

                      {/* Canonical 24px (p-6) card-photo content padding */}
                      <div className="p-6 pb-4">
                        <h3 className="font-google-display text-[20px] font-normal leading-[28px] tracking-normal text-ink line-clamp-2">
                          {item.itemName}
                        </h3>
                        <p
                          className={`mt-1 text-[14px] leading-[20px] ${
                            outOfStock ? 'font-medium text-ink' : 'text-ink-muted'
                          }`}
                        >
                          {item.isComposite && !item.useProduction
                            ? 'ตัดวัตถุดิบสดตามสูตร Multi-Level BOM'
                            : outOfStock
                              ? `สินค้าหมดสต็อก (0 ${item.unitName})`
                              : lowStock
                                ? `สต็อกใกล้หมด · เหลือ ${formatMilliUnitsToQtyString(item.inStockMilli, item.unitName)}`
                                : `คงเหลือ ${formatMilliUnitsToQtyString(item.inStockMilli, item.unitName)}`}
                        </p>
                      </div>
                    </div>

                    <div className="px-6 pb-5 pt-2 flex items-center justify-between w-full">
                      <span className="font-google-display text-[22px] sm:text-[24px] font-normal tracking-[-0.25px] text-ink tabular-nums-google">
                        {money(item.priceSatang)}
                        {item.isWeightedScale && (
                          <span className="text-sm text-ink-muted ml-1">/ {item.unitName}</span>
                        )}
                      </span>
                      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-primary transition-colors duration-200 group-hover:border-primary group-hover:bg-primary group-hover:text-white">
                        {item.isComposite ? (
                          <ArrowUpRight className="h-5 w-5" />
                        ) : (
                          <Plus className="h-5 w-5" />
                        )}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}

        {/* ================================================================== */}
        {/* SUB-VIEW 2: SUPERMARKET HIGH-SPEED SCAN LEDGER                     */}
        {/* ================================================================== */}
        {posSubView === 'SCAN_LEDGER' && (
          <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
            <div className="border-b border-hairline bg-surface-1 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-ink-soft">
                <ScanBarcode className="h-4 w-4 text-primary shrink-0" />
                <span>คลิกแถวสินค้าเพื่อเพิ่มลงบิลทันที (×{scanMultiplier}) หรือยิงปืนบาร์โค้ดต่อเนื่อง</span>
              </div>

              {simulationModeEnabled && bootstrap.featureFlags.enableScaleBarcodeParser && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onScanBarcodeString('2010045012505', 1)}
                    className={`min-h-[38px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                  >
                    + จำลองตราชั่ง 1.250 กก. (Prefix 20)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onScanBarcodeString(isLaos ? '2500123015004' : '2510045225009', 1)
                    }
                    className={`min-h-[38px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                  >
                    {isLaos
                      ? '+ ທົດລອງປ້າຍຝັງລາຄາ 150,000 ₭ (Prefix 25)'
                      : '+ จำลองป้ายฝังราคา ฿225 (Prefix 25)'}
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-hairline bg-surface-1 text-xs font-medium text-ink-muted">
                  <tr>
                    <th scope="col" className="py-3.5 px-5">รหัสบาร์โค้ด / SKU</th>
                    <th scope="col" className="py-3.5 px-5">ชื่อสินค้า</th>
                    <th scope="col" className="py-3.5 px-5">หมวดหมู่</th>
                    <th scope="col" className="py-3.5 px-5 text-right">สต็อกคงเหลือ</th>
                    <th scope="col" className="py-3.5 px-5 text-right">ราคาขาย</th>
                    <th scope="col" className="py-3.5 px-5 text-right">เพิ่มลงบิล</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {sellableCatalog.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-14 text-center text-sm text-ink-muted">
                        {searchQuery.trim() || selectedCategoryId !== 'ALL'
                          ? 'ไม่พบรายการสินค้าที่ตรงกับคำค้นหา'
                          : 'ยังไม่มีรายการสินค้าในระบบ — กรุณาเพิ่มสินค้าในแท็บ “คลังสินค้า & PO”'}
                      </td>
                    </tr>
                  ) : (
                    sellableCatalog.map((item) => {
                      const inCartQty = inCartQtyByVariant.get(item.id) ?? 0;
                      const outOfStock = !item.isComposite && item.inStockMilli <= 0;
                      const lowStock =
                        !item.isComposite &&
                        item.inStockMilli > 0 &&
                        item.inStockMilli <= item.lowStockThresholdMilli;
                      return (
                        <tr
                          key={item.id}
                          onClick={() => handleProductSelect(item)}
                          className="hover:bg-surface-1 transition-colors duration-150 cursor-pointer"
                        >
                          <td className="py-3.5 px-5 tabular-nums-google">
                            <div className="text-sm text-ink">{item.barcode ?? '—'}</div>
                            <div className="text-xs text-ink-muted">{item.sku}</div>
                          </td>
                          <td className="py-3.5 px-5">
                            <div className="flex items-center gap-3">
                              {resolveBackendAssetUrl(item.imageUrl) && (
                                <img
                                  src={resolveBackendAssetUrl(item.imageUrl)!}
                                  alt={item.itemName}
                                  loading="lazy"
                                  className={`h-10 w-10 rounded-[4px] border border-hairline object-cover shrink-0 ${outOfStock ? 'opacity-55 grayscale' : ''}`}
                                />
                              )}
                              <div className="min-w-0">
                                <div className="font-google-display text-[16px] font-medium text-ink flex flex-wrap items-center gap-2">
                                  <span>{item.itemName}</span>
                                  {outOfStock && (
                                    <span className="rounded-[4px] bg-ink px-2 py-0.5 text-[11px] font-medium text-white">
                                      สินค้าหมด
                                    </span>
                                  )}
                                  {!outOfStock && lowStock && (
                                    <span className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-ink">
                                      ใกล้หมด
                                    </span>
                                  )}
                                  {inCartQty > 0 && (
                                    <span className="rounded-[48px] bg-primary px-2.5 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                                      ×{item.isWeightedScale ? formatMilliUnitsToQtyString(inCartQty) : Math.round(inCartQty / 1000)}
                                    </span>
                                  )}
                                </div>
                                {item.isWeightedScale && (
                                  <div className="text-xs text-ink-muted flex items-center gap-1 mt-0.5">
                                    <Scale className="h-3 w-3 text-primary" /> รองรับบาร์โค้ดชั่งน้ำหนักสด EAN-13
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-3.5 px-5 text-xs text-ink-muted">{item.categoryName}</td>
                          <td className="py-3.5 px-5 text-right text-sm text-ink-soft tabular-nums-google">
                            {item.isComposite && !item.useProduction
                              ? 'ตัดตามสูตร'
                              : formatMilliUnitsToQtyString(item.inStockMilli, item.unitName)}
                          </td>
                          <td className="py-3.5 px-5 text-right font-google-display text-[18px] font-normal text-ink tabular-nums-google">
                            {money(item.priceSatang)}
                          </td>
                          <td className="py-3.5 px-5 text-right">
                            <button
                              type="button"
                              aria-label={`เพิ่ม ${item.itemName} ลงบิล`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleProductSelect(item);
                              }}
                              className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-canvas text-primary hover:border-primary hover:bg-primary hover:text-white ${UI_INTERACTION.focusButton}`}
                            >
                              <Plus className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* SUB-VIEW 3: HELD BILLS (พักบิล / เรียกบิลคืน)                        */}
        {/* ================================================================== */}
        {posSubView === 'HELD_BILLS' && (
          <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
            <div className="border-b border-hairline bg-surface-1 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-ink">
                  รายการบิลที่พักไว้บนเซิร์ฟเวอร์ (Synced Held Bills · {outletId})
                </h3>
                <p className="text-sm text-ink-muted">
                  ซิงค์ลงฐานข้อมูลหลักอัตโนมัติ — พักบิลที่เครื่องจุดขาย 1 แล้วเรียกคิดเงินที่เครื่องจุดขาย 2 ได้ทันที (ปุ่มลัด F8)
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refreshServerHeldBills()}
                className={`inline-flex h-10 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncingHeldBills ? 'animate-spin' : ''}`} />
                <span>รีเฟรชบิลพักข้ามเครื่อง</span>
              </button>
            </div>

            {heldBills.length === 0 ? (
              <div className="py-16 text-center px-6">
                <PauseCircle className="h-10 w-10 text-ink-muted mx-auto mb-3" />
                <p className="font-google-display text-[18px] text-ink">
                  ไม่มีรายการบิลที่พักไว้ขณะนี้
                </p>
                <p className="text-sm text-ink-muted mt-1">
                  เมื่อมีสินค้าในตะกร้า สามารถกดปุ่ม &ldquo;พักบิล (F8)&rdquo; เพื่อเก็บรายการไว้ชั่วคราวได้ทันที
                </p>
              </div>
            ) : (
              <div className="divide-y divide-hairline">
                {heldBills.map((h) => (
                  <div
                    key={h.id}
                    className="p-6 flex flex-wrap items-center justify-between gap-4 hover:bg-surface-1 transition-colors duration-200"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-google-display text-[20px] font-normal text-ink">
                          {h.referenceLabel}
                        </span>
                        <span className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 text-xs text-ink-muted">
                          {h.orderType}
                        </span>
                      </div>
                      <p className="text-sm text-ink-muted">
                        {h.cart.map((c) => c.itemName).join(', ')}
                      </p>
                      <div className="text-xs text-ink-muted flex items-center gap-2">
                        <Clock className="h-3.5 w-3.5" />
                        <span>พักเมื่อ {new Date(h.heldAtIso).toLocaleTimeString('th-TH')}</span>
                        <span>·</span>
                        <span>โดย {h.heldByName}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="text-right mr-2">
                        <div className="text-xs text-ink-muted">{t('pos.netPayable')}</div>
                        <div className="font-google-display text-[24px] font-normal text-ink tabular-nums-google">
                          {money(h.totalSatang)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmAction({
                            title: `${pick('ลบบิลที่พักไว้', 'ລຶບບິນພັກໄວ້', 'Delete held bill')} "${h.referenceLabel}"?`,
                            description: `${h.cart.length} ${t('pos.itemsUnit')} (${money(h.totalSatang)})`,
                            confirmLabel: 'ยืนยันลบบิลที่พัก',
                            tone: 'danger',
                            onConfirm: async () => {
                              const removed = await posTransport.deleteHeldBill({
                                outletId,
                                actorUserId: currentUser.id,
                                id: h.id,
                              });
                              setHeldBills(removed.heldBills);
                              void onRefreshState();
                              onToast(`ลบบิลที่พัก "${h.referenceLabel}" แล้ว`, 'warn');
                            },
                          })
                        }
                        className={`h-[46px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-sm font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                      >
                        ลบทิ้ง
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRecallHeldBill(h)}
                        className={`flex h-[46px] items-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                      >
                        <PlayCircle className="h-4 w-4" />
                        เรียกบิลคิดเงิน
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================================================================== */}
        {/* SUB-VIEW 3B: LOCAL LAN QR TABLE ORDERING INBOX                      */}
        {/* ================================================================== */}
        {posSubView === 'QR_ORDERS' && (
          <QrOrderingInboxPanel
            outletId={outletId}
            bootstrap={bootstrap}
            guestOrders={qrGuestOrders}
            tableSessions={qrTableSessions}
            qrStatus={qrStatus}
            syncing={syncingQrOrders}
            onRefreshOrders={() => refreshQrGuestOrders(false)}
            onOpenTableQrModal={() => setTableQrModalOpen(true)}
            onAcceptedOrder={async () => {
              await Promise.all([
                refreshQrGuestOrders(false),
                refreshServerHeldBills(),
                onRefreshState(),
              ]);
            }}
            onToast={onToast}
          />
        )}

        {/* ================================================================== */}
        {/* SUB-VIEW 4: COMPLETED RECEIPTS, REPRINT & HISTORICAL-COST VOID      */}
        {/* ================================================================== */}
        {posSubView === 'ORDER_HISTORY' && (
          <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
            <div className="border-b border-hairline bg-surface-1 px-6 py-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-google-display text-[20px] font-normal text-ink">
                    ประวัติใบเสร็จรับเงิน &amp; ใบกำกับภาษีอย่างย่อ (ABB)
                  </h3>
                  <p className="text-sm text-ink-muted">
                    ค้นหาเลขใบเสร็จ / เลขใบกำกับภาษี ABB / ป้ายโต๊ะ / ชื่อเมนู พร้อมพิมพ์ซ้ำหรือยกเลิกบิลคืนสต็อกต้นทุนเดิม
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
                  <input
                    type="text"
                    aria-label="ค้นหาใบเสร็จย้อนหลัง"
                    value={orderHistoryQuery}
                    onChange={(e) => setOrderHistoryQuery(e.target.value)}
                    placeholder="ค้นหาเลขใบเสร็จ, เลข ABB, ป้ายโต๊ะ/คิว, ชื่อเมนู หรือ Ref สลิป..."
                    className={`h-10 w-full rounded-[48px] border border-hairline bg-canvas pl-10 pr-9 text-xs text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                  />
                  {orderHistoryQuery && (
                    <button
                      type="button"
                      aria-label="ล้างคำค้นหาใบเสร็จ"
                      onClick={() => setOrderHistoryQuery('')}
                      className={`absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: 'ALL', label: `ทั้งหมด (${bootstrap.recentOrders.length})` },
                      {
                        id: 'COMPLETED',
                        label: `สำเร็จ (${bootstrap.recentOrders.filter((o) => o.status === 'COMPLETED').length})`,
                      },
                      {
                        id: 'VOIDED',
                        label: `ยกเลิก (${bootstrap.recentOrders.filter((o) => o.status === 'VOIDED').length})`,
                      },
                    ] as const
                  ).map((f) => {
                    const active = orderStatusFilter === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setOrderStatusFilter(f.id)}
                        className={`min-h-[36px] rounded-[48px] border px-3.5 font-google-display text-xs font-medium ${UI_INTERACTION.focusButton} ${
                          active
                            ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                            : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                        }`}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-hairline bg-surface-1 text-xs font-medium text-ink-muted">
                  <tr>
                    <th scope="col" className="py-3.5 px-5">เลขที่ใบเสร็จ / ABB</th>
                    <th scope="col" className="py-3.5 px-5">รายการที่ขาย</th>
                    <th scope="col" className="py-3.5 px-5">วิธีชำระ</th>
                    <th scope="col" className="py-3.5 px-5 text-right">ยอดสุทธิ</th>
                    <th scope="col" className="py-3.5 px-5 text-center">สถานะ</th>
                    <th scope="col" className="py-3.5 px-5 text-right">การทำงาน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {filteredOrderHistory.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-14 text-center text-ink-muted">
                        {orderHistoryQuery.trim() || orderStatusFilter !== 'ALL'
                          ? 'ไม่พบใบเสร็จที่ตรงกับเงื่อนไขการค้นหา'
                          : 'ยังไม่มีรายการขายในกะนี้'}
                      </td>
                    </tr>
                  ) : (
                    filteredOrderHistory.map((ord) => (
                      <tr key={ord.salesOrderId} className="hover:bg-surface-1 transition-colors duration-150">
                        <td className="py-3.5 px-5 tabular-nums-google">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-ink">{ord.receiptNumber}</span>
                            {ord.tableOrQueueNo && (
                              <span className="rounded-[48px] border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-ink">
                                {ord.tableOrQueueNo}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-ink-muted">
                            {ord.abbTaxInvoiceNo ?? '—'} · {ord.orderType}
                          </div>
                        </td>
                        <td className="py-3.5 px-5">
                          <div className="text-ink max-w-xs truncate">
                            {ord.lines
                              .map((l) => {
                                const qtyTxt = formatMilliUnitsToQtyString(l.quantityMilli, l.unitName).replace(/\.000 /, ' ');
                                const modsTxt =
                                  l.modifiers.length > 0
                                    ? ` (${l.modifiers.map((m) => m.name).join(', ')})`
                                    : '';
                                return `${l.itemName} ×${qtyTxt}${modsTxt}`;
                              })
                              .join(', ')}
                          </div>
                          <div className="text-xs text-ink-muted">
                            {ord.cashierName} · {dateTime(ord.createdAt)}
                          </div>
                          {ord.status === 'VOIDED' && ord.voidReason && (
                            <div className="text-[11px] text-ink mt-0.5">
                              {pick('เหตุผลยกเลิก', 'ເຫດຜົນຍົກເລີກ', 'Void reason')}: {ord.voidReason}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-5 text-xs text-ink-soft tabular-nums-google">
                          <div>
                            {(ord.paymentSummaryLabel || ord.paymentMethod).replace(
                              /PROMPTPAY_QR/g,
                              qrMethodLabel
                            )}
                          </div>
                          {ord.payments && ord.payments.length > 1 ? (
                            <div className="text-[11px] text-ink-muted space-y-0.5 mt-0.5">
                              {ord.payments.map((p, idx) => (
                                <div key={`${p.paymentMethod}-${idx}`}>
                                  • {p.paymentMethod === 'PROMPTPAY_QR' ? qrMethodLabel : p.paymentMethod}:{' '}
                                  {money(p.amountSatang)}
                                  {p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''}
                                </div>
                              ))}
                            </div>
                          ) : (
                            ord.slipTransRefLast4 && (
                              <div className="text-ink-muted">Ref *{ord.slipTransRefLast4}</div>
                            )
                          )}
                        </td>
                        <td className="py-3.5 px-5 text-right font-google-display text-[18px] text-ink tabular-nums-google">
                          {money(ord.totalSatang)}
                        </td>
                        <td className="py-3.5 px-5 text-center">
                          <span
                            className={`inline-block rounded-[4px] border px-2.5 py-0.5 text-xs font-medium ${
                              ord.status === 'COMPLETED'
                                ? 'border-hairline bg-surface-1 text-ink'
                                : 'border-hairline bg-surface-1 text-ink-muted line-through'
                            }`}
                          >
                            {ord.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-5 text-right space-x-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() =>
                              void handleReprintOrder(
                                ord.salesOrderId,
                                ord.receiptNumber,
                                ord.abbTaxInvoiceNo
                              )
                            }
                            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                          >
                            <Printer className="h-3.5 w-3.5" /> พิมพ์ซ้ำ
                          </button>
                          {ord.status === 'COMPLETED' && (
                            <button
                              type="button"
                              onClick={() =>
                                setVoidTargetOrder({
                                  salesOrderId: ord.salesOrderId,
                                  receiptNumber: ord.receiptNumber,
                                  abbTaxInvoiceNo: ord.abbTaxInvoiceNo,
                                  totalSatang: ord.totalSatang,
                                })
                              }
                              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-soft hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> ยกเลิกบิล
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* RIGHT COLUMN (4 COLS): STICKY CUSTOMER DISPLAY HERO + REGISTER BILL  */}
      {/* ==================================================================== */}
      <aside className="lg:col-span-5 xl:col-span-4 lg:sticky lg:top-[76px]">
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          {/* 1. CANONICAL NEAR-BLACK HERO BAND (`#000000` hero-bg, weight-400 -0.5px display!) */}
          <div className="bg-hero px-6 py-6 text-white">
            <div className="flex items-center justify-between text-xs text-white/75">
              <span className="font-google-display uppercase tracking-[0.5px] text-white/80">
                {t('pos.netPayable')} · {cartSummary.totalItemUnitsCount} {t('pos.itemsUnit')}
              </span>
              {lastPrintedReceipt && (
                <button
                  type="button"
                  onClick={() => setReceiptModalOpen(true)}
                  className={`inline-flex items-center gap-1.5 rounded-[48px] border border-white/30 px-3 py-1 font-google-display text-xs text-white hover:border-white hover:bg-white/10 ${UI_INTERACTION.focusButton}`}
                >
                  <Printer className="h-3.5 w-3.5" /> {pick('ใบเสร็จล่าสุด', 'ໃບບິນຫຼ້າສຸດ', 'Last Receipt')}
                </button>
              )}
            </div>

            {/* Canonical Google Display-LG: 48px, weight 400, -0.5px letter-spacing */}
            <div className="mt-2 font-google-display text-[36px] sm:text-[44px] font-normal leading-[44px] sm:leading-[52px] tracking-[-0.5px] text-white tabular-nums-google">
              {money(cartSummary.totalSatang)}
            </div>

            {/* Order Context Controls on Hero Band (Strictly Scoped to Active Shop Profile) */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <select
                aria-label="รูปแบบออเดอร์"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as CheckoutOrderRequest['orderType'])}
                className="h-10 rounded-[4px] border border-white/25 bg-white/10 px-3 text-xs font-medium text-white transition-colors duration-200 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary cursor-pointer"
              >
                {allowedOrderTypes.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-canvas text-ink">
                    {opt.label}
                  </option>
                ))}
              </select>

              <input
                type="text"
                aria-label={orderRefMeta.ariaLabel}
                value={queueOrTableLabel}
                onChange={(e) => setQueueOrTableLabel(e.target.value)}
                placeholder={orderRefMeta.placeholder}
                className="h-10 rounded-[4px] border border-white/25 bg-white/10 px-3 text-xs text-white placeholder:text-white/65 transition-colors duration-200 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>

          {/* 1.5 NON-BLOCKING POST-CHECKOUT CHANGE BANNER (auto-clears on next scan) */}
          {cartSummary.lines.length === 0 && lastCompletedSaleSummary && (
            <div
              role="status"
              aria-live="polite"
              className="border-b border-primary bg-surface-1 px-5 py-4 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-dark">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>ปิดบิลสำเร็จ · {lastCompletedSaleSummary.abbTaxInvoiceNo}</span>
                </span>
                <button
                  type="button"
                  aria-label="ปิดแถบสรุปเงินทอน"
                  onClick={() => setLastCompletedSaleSummary(null)}
                  className={`flex h-10 w-10 items-center justify-center rounded-full text-ink-muted hover:bg-canvas hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {lastCompletedSaleSummary.changeGivenSatang > 0 ? (
                <div className="rounded-[4px] border border-primary/30 bg-canvas px-4 py-3 flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-ink-soft">{t('pos.changeLabel')}</span>
                  <span className="font-google-display text-[28px] sm:text-[32px] font-normal leading-none tracking-[-0.5px] text-primary-dark tabular-nums-google">
                    {money(lastCompletedSaleSummary.changeGivenSatang)}
                  </span>
                </div>
              ) : (
                <div className="text-xs text-ink-soft tabular-nums-google">
                  {pick('รับชำระครบถ้วน', 'ຮັບຊຳລະຄົບຖ້ວນ', 'Paid in full')}{' '}
                  {money(lastCompletedSaleSummary.totalSatang)} ({lastCompletedSaleSummary.paymentLabel})
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] text-ink-muted">
                <span>ยิงบาร์โค้ดหรือแตะสินค้าชิ้นถัดไปเพื่อเริ่มบิลใหม่ทันที</span>
                <button
                  type="button"
                  onClick={() => setReceiptModalOpen(true)}
                  className={`inline-flex items-center gap-1 rounded-[48px] border border-primary bg-canvas px-3 py-1 text-xs font-medium text-primary-dark hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <Printer className="h-3 w-3" /> ดูใบเสร็จ / พิมพ์ซ้ำ
                </button>
              </div>
            </div>
          )}

          {/* 2. CART LINE ITEMS ON PURE WHITE CANVAS */}
          <div className="divide-y divide-hairline max-h-[360px] min-h-[220px] overflow-y-auto bg-canvas">
            {cartSummary.lines.length === 0 ? (
              <div className="py-16 px-6 text-center">
                <ScanBarcode className="h-9 w-9 text-ink-muted mx-auto mb-2.5" />
                <p className="font-google-display text-[18px] font-normal text-ink">
                  {t('pos.readyForOrder')}
                </p>
                <p className="text-sm text-ink-muted mt-1">
                  {t('pos.readyForOrderHint')}
                </p>
              </div>
            ) : (
              cartSummary.lines.map((line) => {
                const isEditingQty = editingCartKey === line.cartKey;
                return (
                  <div key={line.cartKey} className="px-5 py-3.5 hover:bg-surface-1 transition-colors duration-150">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => {
                            if (isEditingQty) {
                              setEditingCartKey(null);
                            } else {
                              setEditingCartKey(line.cartKey);
                              setEditingQtyInput(
                                line.isWeightedScale
                                  ? formatMilliUnitsToQtyString(line.quantityMilli)
                                  : String(Math.round(line.quantityMilli / 1000))
                              );
                            }
                          }}
                          className={`font-google-display text-[16px] font-medium text-ink hover:text-primary text-left rounded-[4px] ${UI_INTERACTION.focusButton}`}
                        >
                          {line.itemName}
                        </button>

                        {(line.mods.length > 0 ||
                          (bootstrap.featureFlags.enableRoleBasedModifiers &&
                            bootstrap.modifierGroups.length > 0 &&
                            bootstrap.catalogDetailed.find((v) => v.id === line.variantId)
                              ?.isComposite)) && (
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {line.mods.map((m) => (
                              <span
                                key={m.id}
                                className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 text-xs text-ink-muted"
                              >
                                {m.name}
                                {m.priceDeltaSatang > 0
                                  ? ` +${money(m.priceDeltaSatang)}`
                                  : ''}
                              </span>
                            ))}
                            {bootstrap.featureFlags.enableRoleBasedModifiers &&
                              bootstrap.modifierGroups.length > 0 &&
                              bootstrap.catalogDetailed.find((v) => v.id === line.variantId)
                                ?.isComposite && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenCartLineModifierEditor(line)}
                                  className={`inline-flex items-center gap-1 rounded-[48px] border border-hairline bg-canvas px-2.5 py-0.5 text-[11px] font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                                >
                                  <SlidersHorizontal className="h-3 w-3" />
                                  <span>แก้ตัวเลือก</span>
                                </button>
                              )}
                          </div>
                        )}

                        {line.scaleBadgeText && (
                          <div className="mt-1 text-xs text-primary-hover">{line.scaleBadgeText}</div>
                        )}
                      </div>

                      <div className="text-right shrink-0 tabular-nums-google">
                        <div className="font-google-display text-[18px] font-normal text-ink">
                          {money(line.lineTotalSatang)}
                        </div>
                        <div className="text-xs text-ink-muted">
                          @{money(line.effectiveUnitSatang)}/{line.unitName}
                        </div>
                      </div>
                    </div>

                    {/* 44x44px Accessible Touch Target Steppers */}
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label={`ลดจำนวน ${line.itemName}`}
                          onClick={() => {
                            const step = line.isWeightedScale ? 250 : 1_000;
                            setCart((prev) =>
                              prev
                                .map((c) =>
                                  c.cartKey === line.cartKey
                                    ? withManualCartLineQty(c, c.quantityMilli - step)
                                    : c
                                )
                                .filter((c) => c.quantityMilli > 0)
                            );
                          }}
                          className={`flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-canvas text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                        >
                          <Minus className="h-4 w-4" />
                        </button>

                        {isEditingQty ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              try {
                                const parsedMilli = parseDecimalStringToScaledInt(
                                  editingQtyInput,
                                  3
                                );
                                if (parsedMilli <= 0) {
                                  setCart((prev) =>
                                    prev.filter((c) => c.cartKey !== line.cartKey)
                                  );
                                } else {
                                  setCart((prev) =>
                                    prev.map((c) =>
                                      c.cartKey === line.cartKey
                                        ? withManualCartLineQty(c, parsedMilli)
                                        : c
                                    )
                                  );
                                }
                                setEditingCartKey(null);
                              } catch {
                                onToast('รูปแบบจำนวนไม่ถูกต้อง', 'error');
                              }
                            }}
                            className="flex items-center gap-1"
                          >
                            <input
                              type="text"
                              aria-label={`แก้ไขจำนวน ${line.itemName}`}
                              autoFocus
                              value={editingQtyInput}
                              onChange={(e) => setEditingQtyInput(e.target.value)}
                              className={`h-11 w-20 rounded-[4px] border border-primary bg-canvas px-2 text-center text-sm text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                            />
                            <button
                              type="submit"
                              aria-label={`ยืนยันจำนวน ${line.itemName}`}
                              className={`flex h-11 w-11 items-center justify-center rounded-full bg-primary text-white hover:bg-primary-hover ${UI_INTERACTION.focusButton}`}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            title="คลิกเพื่อพิมพ์จำนวนเอง"
                            onClick={() => {
                              setEditingCartKey(line.cartKey);
                              setEditingQtyInput(
                                line.isWeightedScale
                                  ? formatMilliUnitsToQtyString(line.quantityMilli)
                                  : String(Math.round(line.quantityMilli / 1000))
                              );
                            }}
                            className={`min-h-[44px] min-w-[78px] rounded-[4px] border border-transparent px-2 py-1 text-center font-google-display text-sm font-medium text-ink hover:border-hairline tabular-nums-google ${UI_INTERACTION.focusButton}`}
                          >
                            {line.isWeightedScale
                              ? formatMilliUnitsToQtyString(line.quantityMilli, line.unitName)
                              : `${Math.round(line.quantityMilli / 1000)} ${line.unitName}`}
                          </button>
                        )}

                        <button
                          type="button"
                          aria-label={`เพิ่มจำนวน ${line.itemName}`}
                          onClick={() => {
                            const step = line.isWeightedScale ? 250 : 1_000;
                            setCart((prev) =>
                              prev.map((c) =>
                                c.cartKey === line.cartKey
                                  ? withManualCartLineQty(c, c.quantityMilli + step)
                                  : c
                              )
                            );
                          }}
                          className={`flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-canvas text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>

                      <button
                        type="button"
                        aria-label={`ลบ ${line.itemName}`}
                        onClick={() =>
                          setCart((prev) => prev.filter((c) => c.cartKey !== line.cartKey))
                        }
                        className={`flex h-11 w-11 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 3. SINGLE SOFT-BLUE `#e8f0fe` FINANCIAL & SHORTCUT RAIL (rounded-[8px]) */}
          <div className="p-4 bg-canvas border-t border-hairline space-y-4">
            <div className="rounded-[8px] bg-primary-soft p-4 space-y-2.5 text-sm text-ink">
              <div className="flex items-center justify-between">
                <span className="text-ink-soft">{t('pos.subtotal')}</span>
                <span className="font-medium tabular-nums-google">
                  {money(cartSummary.subtotalSatang)}
                </span>
              </div>

              {/* Discount Row with Currency / Percent Toggle */}
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`${uid}-discount`}
                  className="text-ink-soft flex items-center gap-1.5"
                >
                  <Tag className="h-3.5 w-3.5 text-primary-dark" />
                  {t('pos.discount')}
                </label>
                <div className="flex items-center gap-1.5">
                  <div className="inline-flex rounded-[48px] border border-hairline bg-canvas p-0.5">
                    <button
                      type="button"
                      aria-label={fiscal.currencySymbol}
                      onClick={() => setDiscountMode('BAHT')}
                      className={`min-h-[38px] min-w-[44px] rounded-[48px] px-3 text-xs font-medium ${UI_INTERACTION.focusButton} ${
                        discountMode === 'BAHT'
                          ? 'bg-primary text-white hover:bg-primary-hover'
                          : 'text-ink-muted hover:text-ink'
                      }`}
                    >
                      {fiscal.currencySymbol}
                    </button>
                    <button
                      type="button"
                      aria-label="%"
                      onClick={() => setDiscountMode('PERCENT')}
                      className={`min-h-[38px] min-w-[44px] rounded-[48px] px-3 text-xs font-medium ${UI_INTERACTION.focusButton} ${
                        discountMode === 'PERCENT'
                          ? 'bg-primary text-white hover:bg-primary-hover'
                          : 'text-ink-muted hover:text-ink'
                      }`}
                    >
                      %
                    </button>
                  </div>
                  <input
                    id={`${uid}-discount`}
                    ref={discountInputRef}
                    type="text"
                    aria-label={t('pos.discount')}
                    value={discountInput}
                    onChange={(e) => setDiscountInput(e.target.value)}
                    className={`h-[44px] w-28 rounded-[4px] border border-hairline bg-canvas px-2.5 text-right text-sm text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
              </div>

              {/* Dynamic Country Tax Mode & VAT Readout */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-primary/15 text-xs text-ink-soft">
                <select
                  aria-label="Tax Mode"
                  value={taxMode}
                  onChange={(e) => setTaxMode(e.target.value as TaxMode)}
                  className={`rounded-[4px] border border-hairline bg-canvas px-2 py-1 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value="INCLUSIVE">
                    {vatDisplayName} {t('pos.taxMode.INCLUSIVE')}
                  </option>
                  <option value="EXCLUSIVE">
                    {vatDisplayName} {t('pos.taxMode.EXCLUSIVE')}
                  </option>
                  <option value="NONE">{t('pos.taxMode.NONE')}</option>
                </select>
                <span className="tabular-nums-google">
                  Net {money(cartSummary.netBeforeTaxSatang)} · {vatDisplayName}{' '}
                  {money(cartSummary.taxSatang)}
                </span>
              </div>
              {isLaos && cartSummary.cashRoundingDiscountSatang > 0 && (
                <div className="flex items-center justify-between text-xs text-primary-dark pt-0.5">
                  <span>
                    {t('pos.cashRounding')} ({fiscal.cashRoundingStepMajor.toLocaleString('en-US')} ₭)
                  </span>
                  <span className="tabular-nums-google font-medium">
                    -{money(cartSummary.cashRoundingDiscountSatang)} →{' '}
                    {money(cartSummary.cashPayableTotalSatang)}
                  </span>
                </div>
              )}
            </div>

            {/* 4. CANONICAL 48px PILL CTA DOCK (`button-primary` #1a73e8 + `button-secondary` #ffffff) */}
            <div className="space-y-2.5">
              <button
                type="button"
                disabled={cart.length === 0 || processingCheckout}
                onClick={() => void openCheckoutModal('CASH')}
                className={`flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-[15px] sm:text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                <Banknote className="h-5 w-5 shrink-0" />
                <span>
                  {t('pos.payButton')} · {money(cartSummary.totalSatang)} (F10)
                </span>
              </button>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={cart.length === 0 || processingCheckout}
                  onClick={() => void executeFinalCheckout('CASH', undefined, true)}
                  className={`flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-primary bg-canvas px-3 font-google-display text-xs font-medium tracking-[0.25px] text-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <Banknote className="h-4 w-4 shrink-0" />
                  <span>{t('pos.quickCash')}</span>
                </button>

                <button
                  type="button"
                  disabled={cart.length === 0 || processingCheckout || cartSummary.totalSatang <= 0}
                  onClick={() => void openCheckoutModal('SPLIT')}
                  className={`flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3 font-google-display text-xs font-medium tracking-[0.25px] text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                >
                  <Layers className="h-4 w-4 text-primary shrink-0" />
                  <span>{t('pos.splitPay')}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={cart.length === 0 || processingCheckout || cartSummary.totalSatang <= 0}
                  onClick={() => void openCheckoutModal('PROMPTPAY_QR')}
                  className={`flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3 font-google-display text-xs font-medium tracking-[0.25px] text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <QrCode className="h-4 w-4 shrink-0" />
                  <span>{isLaos ? 'LAOQR' : 'Thai QR'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleHoldCurrentBill()}
                  className={`flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3 font-google-display text-xs font-medium tracking-[0.25px] text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <PauseCircle className="h-4 w-4 shrink-0" />
                  <span>
                    {t('pos.holdBill').replace(' (F8)', '')}{' '}
                    {heldBills.length > 0 ? `(${heldBills.length})` : '(F8)'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={cart.length === 0}
                  onClick={() =>
                    setConfirmAction({
                      title: pick('ล้างรายการสินค้าทั้งหมดในบิล?', 'ລ້າງລາຍການສິນຄ້າທັງໝົດໃນບິນ?', 'Clear entire bill?'),
                      description: `${cartSummary.totalItemUnitsCount} ${t('pos.itemsUnit')} (${money(cartSummary.totalSatang)})`,
                      confirmLabel: t('common.confirm'),
                      tone: 'danger',
                      onConfirm: () => {
                        setCart([]);
                        setDiscountInput('0');
                        onToast(pick('ล้างรายการในตะกร้าเรียบร้อยแล้ว', 'ລ້າງລາຍການໃນກະຕ່າແລ້ວ', 'Cart cleared'), 'warn');
                      },
                    })
                  }
                  className={`flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3 font-google-display text-xs font-medium tracking-[0.25px] text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  <Trash2 className="h-4 w-4 shrink-0" />
                  <span>{t('pos.clearCart')}</span>
                </button>
              </div>
              {cart.length > 0 && cartSummary.totalSatang <= 0 && (
                <p className="rounded-[4px] border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-soft">
                  {pick(
                    `ยอดชำระสุทธิเป็น ${money(0)} — ปิดการขายด้วยปุ่มเงินสดเท่านั้น`,
                    `ຍອດຊຳລະສຸດທິເປັນ ${money(0)} — ປິດການຂາຍດ້ວຍປຸ່ມເງິນສົດເທົ່ານັ້ນ`,
                    `Net total is ${money(0)} — complete via Cash only`
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* ==================================================================== */}
      {/* DIALOG 1: CAFE ROLE-BASED MODIFIER CUSTOMIZER (Google Clean Spec)    */}
      {/* ==================================================================== */}
      <ModalDialog
        open={Boolean(customizingVariant)}
        onClose={() => {
          setCustomizingVariant(null);
          setEditingModifierCartKey(null);
        }}
        labelledBy={`${uid}-modifier-title`}
        maxWidthClass="max-w-lg"
      >
        {customizingVariant && (
          <>
            <div className="flex items-center justify-between border-b border-hairline px-6 py-4 shrink-0">
              <div>
                <h3 id={`${uid}-modifier-title`} className="font-google-display text-[22px] font-normal text-ink">
                  {editingModifierCartKey
                    ? `แก้ไขตัวเลือก: ${customizingVariant.itemName}`
                    : customizingVariant.itemName}
                </h3>
                <p className="text-xs text-ink-muted flex items-center gap-1.5 mt-0.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  ปรับสัดส่วนวัตถุดิบอัตโนมัติตามบทบาทในสูตร (Stock-Aware Modifiers)
                </p>
              </div>
              <button
                type="button"
                aria-label="ปิดหน้าต่างตัวเลือกเสริม"
                onClick={() => {
                  setCustomizingVariant(null);
                  setEditingModifierCartKey(null);
                }}
                className={`flex h-10 w-10 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto flex-1">
              {bootstrap.modifierGroups.map((group) => (
                <div key={group.id} className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-google-display text-sm font-medium text-ink">
                      {group.name}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {group.selectionType === 'SINGLE' ? 'เลือก 1 รายการ' : 'เลือกได้หลายรายการ'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {group.modifiers.map((mod) => {
                      const active = draftModIds.includes(mod.id);
                      return (
                        <button
                          key={mod.id}
                          type="button"
                          onClick={() => {
                            if (group.selectionType === 'SINGLE') {
                              const otherIds = new Set(group.modifiers.map((m) => m.id));
                              setDraftModIds((prev) => [
                                ...prev.filter((id) => !otherIds.has(id)),
                                mod.id,
                              ]);
                            } else {
                              setDraftModIds((prev) =>
                                prev.includes(mod.id)
                                  ? prev.filter((id) => id !== mod.id)
                                  : [...prev, mod.id]
                              );
                            }
                          }}
                          className={`min-h-[68px] rounded-[4px] border p-3.5 text-left ${UI_INTERACTION.focusButton} ${
                            active
                              ? 'border-primary bg-surface-1 text-ink'
                              : 'border-hairline bg-canvas text-ink-soft hover:border-primary'
                          }`}
                        >
                          <div className="font-google-display text-sm font-medium text-ink">
                            {mod.name}
                          </div>
                          <div className={`text-xs mt-1 tabular-nums-google ${active ? 'text-primary-dark font-medium' : 'text-primary'}`}>
                            {mod.priceDeltaSatang > 0
                              ? `+${money(mod.priceDeltaSatang)}`
                              : mod.priceDeltaSatang < 0
                                ? `-${money(Math.abs(mod.priceDeltaSatang))}`
                                : pick('ไม่เพิ่มราคา', 'ບໍ່ເພີ່ມລາຄາ', 'Free')}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-3 border-t border-hairline">
                <label htmlFor={`${uid}-mod-qty`} className="font-google-display text-sm font-medium text-ink">
                  จำนวน ({customizingVariant.unitName})
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="ลดจำนวน"
                    onClick={() =>
                      setDraftQtyInput((prev) => {
                        const parsed = Number.parseInt(prev, 10);
                        const base = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
                        return String(Math.max(1, base - 1));
                      })
                    }
                    className={`flex h-11 w-11 items-center justify-center rounded-full border border-hairline text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    id={`${uid}-mod-qty`}
                    type="text"
                    aria-label="จำนวนแก้ว"
                    value={draftQtyInput}
                    onChange={(e) => setDraftQtyInput(e.target.value)}
                    className={`h-11 w-20 rounded-[4px] border border-hairline text-center font-google-display text-base text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                  <button
                    type="button"
                    aria-label="เพิ่มจำนวน"
                    onClick={() =>
                      setDraftQtyInput((prev) => {
                        const parsed = Number.parseInt(prev, 10);
                        const base = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
                        return String(Math.max(1, base + 1));
                      })
                    }
                    className={`flex h-11 w-11 items-center justify-center rounded-full border border-hairline text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex flex-wrap items-center justify-end gap-3 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setCustomizingVariant(null);
                  setEditingModifierCartKey(null);
                }}
                className={`h-[50px] rounded-[48px] border border-hairline bg-canvas px-6 font-google-display text-[15px] font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    const qtyMilli = Math.max(
                      1_000,
                      parseDecimalStringToScaledInt(draftQtyInput || '1', 3)
                    );
                    if (editingModifierCartKey) {
                      const sortedMods = [...draftModIds].sort();
                      const newCartKey = `${customizingVariant.id}::${sortedMods.join(',')}`;
                      setCart((prev) => {
                        const targetIdx = prev.findIndex(
                          (c) => c.cartKey === editingModifierCartKey
                        );
                        if (targetIdx < 0) return prev;
                        const duplicateIdx = prev.findIndex(
                          (c, idx) => idx !== targetIdx && c.cartKey === newCartKey
                        );
                        if (duplicateIdx >= 0) {
                          return prev
                            .map((c, idx) =>
                              idx === duplicateIdx
                                ? { ...c, quantityMilli: c.quantityMilli + qtyMilli }
                                : c
                            )
                            .filter((_, idx) => idx !== targetIdx);
                        }
                        const updated = [...prev];
                        const cur = updated[targetIdx]!;
                        updated[targetIdx] = {
                          ...cur,
                          cartKey: newCartKey,
                          quantityMilli: qtyMilli,
                          selectedModifierIds: sortedMods,
                        };
                        return updated;
                      });
                    } else {
                      addVariantToCartDirect(customizingVariant, qtyMilli, draftModIds);
                    }
                    setCustomizingVariant(null);
                    setEditingModifierCartKey(null);
                  } catch {
                    onToast('รูปแบบจำนวนสินค้าไม่ถูกต้อง', 'error');
                  }
                }}
                className={`h-[50px] rounded-[48px] bg-primary px-8 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {editingModifierCartKey
                  ? pick('บันทึกการแก้ไขตัวเลือก · ', 'ບັນທຶກຕົວເລືອກ · ', 'Save Modifiers · ')
                  : pick('เพิ่มลงรายการขาย · ', 'ເພີ່ມລົງບິນ · ', 'Add to Order · ')}
                {(() => {
                  const modDelta = draftModIds.reduce(
                    (s, id) => s + (modifiersById.get(id)?.priceDeltaSatang ?? 0),
                    0
                  );
                  let qtyMilli = 1_000;
                  try {
                    qtyMilli = Math.max(1_000, parseDecimalStringToScaledInt(draftQtyInput || '1', 3));
                  } catch {
                    qtyMilli = 1_000;
                  }
                  const lineTotal = Number(
                    roundDivBigInt(
                      BigInt(qtyMilli) * BigInt(customizingVariant.priceSatang + modDelta),
                      SCALE_MILLI
                    )
                  );
                  return money(lineTotal);
                })()}
              </button>
            </div>
          </>
        )}
      </ModalDialog>

      {/* ==================================================================== */}
      {/* DIALOG 2: GOOGLE-SPEC TOUCH CASH NUMPAD + EMVCO QR + SPLIT PAYMENT   */}
      {/* ==================================================================== */}
      <ModalDialog
        open={checkoutModalOpen}
        onClose={() => setCheckoutModalOpen(false)}
        ariaLabel={pick('หน้าต่างรับชำระเงิน', 'ໜ້າຕ່າງຮັບຊຳລະເງິນ', 'Checkout Dialog')}
        maxWidthClass="max-w-4xl"
      >
        {/* Top Bar */}
        <div className="flex items-center justify-between border-b border-hairline px-4 sm:px-6 h-16 shrink-0 gap-3">
          <div className="flex items-center gap-4 sm:gap-5 h-full overflow-x-auto" role="tablist" aria-label={pick('ช่องทางการรับชำระเงิน', 'ຊ່ອງທາງການຊຳລະເງິນ', 'Payment Methods')}>
            {[
              { id: 'CASH' as const, label: t('pos.cashTab'), icon: Banknote },
              { id: 'PROMPTPAY_QR' as const, label: qrMethodLabel, icon: QrCode },
              { id: 'CARD' as const, label: t('pos.cardTab'), icon: CreditCard },
              { id: 'SPLIT' as const, label: t('pos.splitTab'), icon: Layers },
            ].map((tabItem) => {
              const Icon = tabItem.icon;
              const active = paymentTab === tabItem.id;
              const tabDisabled =
                cartSummary.totalSatang <= 0 &&
                (tabItem.id === 'PROMPTPAY_QR' || tabItem.id === 'SPLIT');
              return (
                <button
                  key={tabItem.id}
                  type="button"
                  role="tab"
                  disabled={tabDisabled}
                  aria-selected={active}
                  onClick={() => {
                    if (tabDisabled) return;
                    setPaymentTab(tabItem.id);
                    setSlipVerificationModal(null);
                    clearPromptPayQrState();
                    if (tabItem.id === 'PROMPTPAY_QR' && cartSummary.totalSatang > 0) {
                      void loadPromptPayQr();
                    } else if (
                      tabItem.id === 'SPLIT' &&
                      splitSecondMethod === 'PROMPTPAY_QR' &&
                      splitRemainingSatang > 0 &&
                      cartSummary.totalSatang > 0
                    ) {
                      void loadPromptPayQr(splitRemainingSatang);
                    }
                  }}
                  className={`relative flex h-full items-center gap-2 px-1 font-google-display text-[14px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                    active ? 'text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-primary' : ''}`} />
                  <span>{tabItem.label}</span>
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => setCheckoutModalOpen(false)}
            className={`flex h-10 w-10 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink shrink-0 ${UI_INTERACTION.focusButton}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 overflow-y-auto flex-1">
          {/* Left Summary Column: Black Hero Total + VAT Breakdown */}
          <div className="md:col-span-5 border-b md:border-b-0 md:border-r border-hairline bg-surface-1 flex flex-col justify-between">
            <div>
              <div className="bg-hero p-6 text-white">
                <div className="text-xs uppercase tracking-[0.5px] text-white/75">
                  {t('pos.netPayable')}
                </div>
                <div className="mt-1 font-google-display text-[36px] sm:text-[44px] font-normal leading-[44px] sm:leading-[52px] tracking-[-0.5px] tabular-nums-google">
                  {money(
                    paymentTab === 'CASH'
                      ? cartSummary.cashPayableTotalSatang
                      : cartSummary.totalSatang
                  )}
                </div>
                {paymentTab === 'CASH' && cartSummary.cashRoundingDiscountSatang > 0 && (
                  <div className="mt-2 inline-flex items-center rounded-[48px] border border-white/25 px-2.5 py-0.5 text-[11px] text-white/90 tabular-nums-google">
                    {t('pos.cashRounding')}: -{money(cartSummary.cashRoundingDiscountSatang)}
                  </div>
                )}
              </div>

              <div className="p-6 space-y-2.5 text-sm">
                <div className="flex justify-between text-ink-muted">
                  <span>{pick('จำนวนสินค้า', 'ຈຳນວນສິນຄ້າ', 'Items')}</span>
                  <span className="text-ink tabular-nums-google">
                    {cartSummary.totalItemUnitsCount} {t('pos.itemsUnit')}
                  </span>
                </div>
                <div className="flex justify-between text-ink-muted">
                  <span>{pick('มูลค่าก่อนภาษี', 'ມູນຄ່າກ່ອນອາກອນ', 'Net Before Tax')}</span>
                  <span className="text-ink tabular-nums-google">
                    {money(
                      paymentTab === 'CASH'
                        ? cartSummary.cashNetBeforeTaxSatang
                        : cartSummary.netBeforeTaxSatang
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-ink-muted">
                  <span>
                    {taxMode === 'NONE'
                      ? pick('ภาษี (ยกเว้น 0%)', 'ອາກອນ (ຍົກເວັ້ນ 0%)', 'Tax (Exempt 0%)')
                      : vatDisplayName}
                  </span>
                  <span className="text-ink tabular-nums-google">
                    {money(
                      paymentTab === 'CASH'
                        ? cartSummary.cashTaxSatang
                        : cartSummary.taxSatang
                    )}
                  </span>
                </div>
                {cartSummary.discountSatang > 0 && (
                  <div className="flex justify-between text-primary-hover font-medium">
                    <span>{pick('ส่วนลดท้ายบิล', 'ສ່ວນຫຼຸດທ້າຍບິນ', 'Order Discount')}</span>
                    <span className="tabular-nums-google">
                      -{money(cartSummary.discountSatang)}
                    </span>
                  </div>
                )}
                {paymentTab === 'CASH' && cartSummary.cashRoundingDiscountSatang > 0 && (
                  <div className="flex justify-between text-primary-hover font-medium">
                    <span>{t('pos.cashRounding')}</span>
                    <span className="tabular-nums-google">
                      -{money(cartSummary.cashRoundingDiscountSatang)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {paymentTab === 'CASH' && (
              <div className="p-6 border-t border-hairline bg-canvas">
                <div className="text-xs text-ink-muted">
                  {t('pos.changeLabel')} (Change Due)
                </div>
                <div className="mt-1 font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-primary tabular-nums-google">
                  {money(
                    Math.max(0, cashTenderedSatangPreview - cartSummary.cashPayableTotalSatang)
                  )}
                </div>
              </div>
            )}

            {paymentTab === 'SPLIT' && (
              <div className="p-6 border-t border-hairline bg-canvas space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-muted">
                    {pick('ส่วนที่ 1 (เงินสด)', 'ສ່ວນທີ 1 (ເງິນສົດ)', 'Part 1 (Cash)')}
                  </span>
                  <span className="font-google-display font-medium text-ink tabular-nums-google">
                    {money(splitCashSatang)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-muted">
                    {pick('ส่วนที่ 2', 'ສ່ວນທີ 2', 'Part 2')} (
                    {splitSecondMethod === 'PROMPTPAY_QR' ? qrMethodLabel : t('pos.cardTab')})
                  </span>
                  <span className="font-google-display text-lg font-medium text-primary tabular-nums-google">
                    {money(splitRemainingSatang)}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Right Interactive Payment Surface */}
          <div className="md:col-span-7 p-6 bg-canvas">
            {paymentTab === 'CASH' && (
              <div className="space-y-4">
                {fxTenderEnabled && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-ink-muted">
                      {t('fx.tenderCurrencyLabel')}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { id: 'LAK' as const, label: 'LAK ₭', sub: pick('กีบลาว (หลัก)', 'ກີບລາວ (ຫຼັກ)', 'Base LAK') },
                          {
                            id: 'THB' as const,
                            label: 'THB ฿',
                            sub: `1 = ${fiscal.fxRates.thbToLakRate.toLocaleString('en-US')} ₭`,
                          },
                          {
                            id: 'USD' as const,
                            label: 'USD $',
                            sub: `1 = ${fiscal.fxRates.usdToLakRate.toLocaleString('en-US')} ₭`,
                          },
                        ] as const
                      ).map((curOpt) => {
                        const active = cashTenderCurrency === curOpt.id;
                        return (
                          <button
                            key={curOpt.id}
                            type="button"
                            onClick={() => handleSelectCashTenderCurrency(curOpt.id)}
                            className={`rounded-[4px] border px-3 py-2 text-left ${UI_INTERACTION.focusButton} ${
                              active
                                ? 'border-primary bg-primary-soft text-primary-dark'
                                : 'border-hairline bg-surface-1 text-ink hover:border-primary'
                            }`}
                          >
                            <div className="font-google-display text-xs font-medium">{curOpt.label}</div>
                            <div className="text-[10px] text-ink-muted tabular-nums-google">{curOpt.sub}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor={`${uid}-cash-tendered`} className="block text-xs font-medium text-ink-muted mb-1.5">
                    {t('pos.receivedCash')} ({activeForeignCurrency ?? currencyCode})
                  </label>
                  <input
                    id={`${uid}-cash-tendered`}
                    type="text"
                    value={cashTenderedBahtInput}
                    onChange={(e) => {
                      setCashTenderedBahtInput(e.target.value);
                      setCashNumpadPristine(false);
                    }}
                    className={`h-14 w-full rounded-[4px] border border-hairline bg-canvas px-4 font-google-display text-[28px] font-normal text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                  {activeForeignCurrency && (
                    <div className="mt-1.5 flex items-center justify-between rounded-[4px] border border-hairline bg-surface-1 px-3 py-1.5 text-xs tabular-nums-google">
                      <span className="text-ink-muted">
                        {t('fx.convertedLakLabel')} (@ {activeFxRateWholeLak.toLocaleString('en-US')} ₭):
                      </span>
                      <span className="font-google-display font-medium text-ink">
                        {formatForeignMoney(cashTenderedForeignSatangPreview, activeForeignCurrency)} ={' '}
                        {money(cashTenderedSatangPreview)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Quick Banknotes (Country & Foreign-Currency Aware) */}
                <div className="flex flex-wrap gap-2">
                  {(activeForeignCurrency
                    ? [
                        {
                          label: `${t('pos.exactAmount')} (${activeForeignCurrency})`,
                          val: formatForeignAmountForInput(
                            baseLakMinorToRequiredForeignMinor(
                              cartSummary.cashPayableTotalSatang,
                              activeFxRateWholeLak
                            ),
                            activeForeignCurrency
                          ),
                        },
                        ...getForeignQuickCashButtons(activeForeignCurrency).map((btn) => ({
                          label: btn.label,
                          val: formatForeignAmountForInput(btn.satang, activeForeignCurrency),
                        })),
                      ]
                    : [
                        {
                          label: t('pos.exactAmount'),
                          val: moneyInput(cartSummary.cashPayableTotalSatang),
                        },
                        ...getQuickCashTenderButtonsForCountry(countryCode).map((btn) => ({
                          label: money(btn.satang),
                          val: moneyInput(btn.satang),
                        })),
                      ]
                  ).map((b) => (
                    <button
                      key={b.label}
                      type="button"
                      onClick={() => {
                        setCashTenderedBahtInput(b.val);
                        setCashNumpadPristine(false);
                      }}
                      className={`min-h-[40px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>

                {/* 4x4 Full Touchscreen Cash Numpad (`000` for native LAK, `.` for THB / USD) */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    '7',
                    '8',
                    '9',
                    'BACKSPACE',
                    '4',
                    '5',
                    '6',
                    'CLEAR',
                    '1',
                    '2',
                    '3',
                    'EXACT',
                    '0',
                    !activeForeignCurrency && currencyCode === 'LAK' ? '000' : '.',
                    '00',
                  ].map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-label={
                        k === 'BACKSPACE'
                          ? pick('ลบตัวเลขสุดท้าย', 'ລຶບຕົວເລກສຸດທ້າຍ', 'Backspace')
                          : k === 'CLEAR'
                            ? pick('ล้างจำนวนเงินสด', 'ລ້າງຈຳນວນເງິນ', 'Clear amount')
                            : k === 'EXACT'
                              ? t('pos.exactAmount')
                              : k === '.'
                                ? pick('จุดทศนิยม', 'ຈຸດທົດສະນິຍົມ', 'Decimal point')
                                : `${pick('ป้อนเลข', 'ປ້ອນເລກ', 'Enter')} ${k}`
                      }
                      onClick={() => handleCashNumpadPress(k)}
                      className={`flex h-12 items-center justify-center rounded-[4px] border border-hairline font-google-display text-[18px] font-normal hover:border-primary ${UI_INTERACTION.focusButton} ${
                        k === '0'
                          ? 'col-span-2 bg-surface-1 text-ink hover:bg-canvas'
                          : k === 'EXACT'
                            ? 'border-primary bg-surface-1 text-primary-dark hover:bg-canvas'
                            : 'bg-surface-1 text-ink hover:bg-canvas'
                      }`}
                    >
                      {k === 'BACKSPACE' ? (
                        <Delete className="h-5 w-5 text-ink-muted" />
                      ) : k === 'CLEAR' ? (
                        <span className="text-xs font-medium text-ink-muted">
                          {pick('ล้างค่า', 'ລ້າງຄ່າ', 'Clear')}
                        </span>
                      ) : k === 'EXACT' ? (
                        <span className="text-xs font-medium">{t('pos.exactAmount')}</span>
                      ) : (
                        k
                      )}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  disabled={
                    processingCheckout ||
                    cashTenderedSatangPreview < cartSummary.cashPayableTotalSatang
                  }
                  onClick={() => void executeFinalCheckout('CASH')}
                  className={`flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-[15px] sm:text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                >
                  {processingCheckout
                    ? pick('กำลังบันทึกบิลและสั่งพิมพ์ใบเสร็จ...', 'ກຳລັງບັນທຶກບິນ ແລະ ພິມໃບບິນ...', 'Saving & printing receipt...')
                    : t('pos.confirmPayCash')}
                </button>
              </div>
            )}

            {paymentTab === 'PROMPTPAY_QR' && (
              <div className="space-y-4">
                {cartSummary.totalSatang <= 0 ? (
                  <div className="rounded-[4px] border border-hairline bg-surface-1 p-5 text-center space-y-3">
                    <p className="text-sm font-medium text-ink">
                      {pick(
                        `ยอดชำระสุทธิเป็น ${money(0)} ไม่สามารถสร้าง ${qrMethodLabel} ได้`,
                        `ຍອດຊຳລະສຸດທິເປັນ ${money(0)} ບໍ່ສາມາດສ້າງ ${qrMethodLabel} ໄດ້`,
                        `Total is ${money(0)}; cannot generate ${qrMethodLabel}`
                      )}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {pick(
                        `กรุณาสลับไปที่แท็บเงินสดเพื่อปิดบิลยอด ${money(0)}`,
                        `ກະລຸນາສະຫຼັບໄປແຖບເງິນສົດເພື່ອປິດບິນຍອດ ${money(0)}`,
                        `Please switch to Cash tab to complete ${money(0)} order`
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => setPaymentTab('CASH')}
                      className={`h-[44px] rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      {t('pos.cashTab')} ({money(0)})
                    </button>
                  </div>
                ) : (
                  <>
                <div className="flex flex-col sm:flex-row items-center gap-5 rounded-[4px] border border-hairline p-4">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`${qrMethodLabel} Dynamic Code`}
                      className="h-44 w-44 rounded-[4px] border border-hairline shrink-0"
                    />
                  ) : (
                    <div className="h-44 w-44 rounded-[4px] border border-hairline bg-surface-1 flex items-center justify-center text-xs text-ink-muted shrink-0">
                      {pick('กำลังสร้าง QR...', 'ກຳລັງສ້າງ QR...', 'Generating QR...')}
                    </div>
                  )}
                  <div className="space-y-1.5 text-sm">
                    <div className="font-google-display text-[18px] text-ink">
                      {isLaos
                        ? pick(
                            'สแกนจ่าย LAOQR / BCEL OnePay (Dynamic QR)',
                            'ສະແກນຈ່າຍ LAOQR / BCEL OnePay (Dynamic QR)',
                            'Scan LAOQR / BCEL OnePay (Dynamic QR)'
                          )
                        : pick(
                            'สแกนจ่ายพร้อมเพย์ (Offline EMVCo Dynamic QR)',
                            'ສະແກນຈ່າຍ PromptPay (EMVCo Dynamic QR)',
                            'Scan Thai QR PromptPay (Dynamic QR)'
                          )}
                    </div>
                    <p className="text-xs text-ink-muted">
                      {isLaos
                        ? pick(
                            `ล็อกยอด ${money(cartSummary.totalSatang)} อัตโนมัติ (Tag 53=418 LAK · Tag 58=LA · CRC16 ${qrCrcHex}) ทำงานออฟไลน์ 100%`,
                            `ລັອກຍອດ ${money(cartSummary.totalSatang)} ອັດຕະໂນມັດ (Tag 53=418 LAK · CRC16 ${qrCrcHex}) ໃຊ້ງານອອບໄລນ໌ 100%`,
                            `Amount locked at ${money(cartSummary.totalSatang)} (EMVCo 418 LAK · CRC16 ${qrCrcHex}) — 100% offline.`
                          )
                        : `ล็อกยอดเงินตรงตามบิลอัตโนมัติ คำนวณรหัสตรวจสอบ CRC16 (${qrCrcHex}) โดยไม่ต้องพึ่งอินเทอร์เน็ต`}
                    </p>
                    {qrPayloadText && (
                      <p className="text-[11px] text-ink-muted break-all line-clamp-2">
                        {qrPayloadText}
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-2.5">
                  {isLaos && (
                    <div>
                      <label htmlFor={`${uid}-lao-bank`} className="block text-xs font-medium text-ink-muted mb-1">
                        {t('pos.laoSlipBankLabel')}
                      </label>
                      <select
                        id={`${uid}-lao-bank`}
                        value={laoSenderBankCode}
                        onChange={(e) => {
                          setLaoSenderBankCode(e.target.value);
                          setSlipVerificationModal(null);
                        }}
                        className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
                      >
                        {LAO_BANKS.map((bank) => (
                          <option key={bank.code} value={bank.code}>
                            {bank.code} — {locale === 'lo' ? bank.displayNameLao : locale === 'en' ? bank.displayNameEn : bank.displayNameThai}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <label htmlFor={`${uid}-slip-miniqr`} className="block text-xs font-medium text-ink">
                    {isLaos
                      ? pick(
                          'ตรวจสลิปโอนเงินป้องกันใช้ซ้ำ: สแกนหรือกรอกเลข Ref / Ticket สลิปลูกค้า (SHA-256 Deduplication)',
                          'ກວດສອບສະລິບປ້ອງກັນການໂອນຊ້ຳ: ສະແກນ ຫຼື ປ້ອນເລກ Ref / Ticket ຈາກສະລິບລູກຄ້າ',
                          'Anti-duplicate slip check: scan or type customer transfer Ticket / Ref ID'
                        )
                      : 'ขั้นตอนป้องกันสลิปปลอม: ยิงปืนสแกน 2D ที่ Mini-QR บนสลิปลูกค้าได้ทันที (ระบบตรวจให้อัตโนมัติ)'}
                  </label>
                  <input
                    id={`${uid}-slip-miniqr`}
                    data-scanner-slip-allow="true"
                    type="text"
                    value={slipMiniQrInput}
                    onChange={(e) => {
                      setSlipMiniQrInput(e.target.value);
                      setSlipVerificationModal(null);
                    }}
                    placeholder={
                      isLaos
                        ? t('pos.laoSlipRefPlaceholder')
                        : 'ยิงปืนสแกน 2D บนสลิปโอนเงินลูกค้าทันทีโดยไม่ต้องคลิกช่องนี้...'
                    }
                    className={`h-11 w-full rounded-[4px] border border-hairline px-3.5 text-xs text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                  />

                  {simulationModeEnabled && !isLaos && (
                    <div className="flex flex-wrap gap-2">
                      {SLIP_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => {
                            setSlipMiniQrInput(p.raw);
                            setSlipVerificationModal(null);
                          }}
                          className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1.5 text-xs text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {!slipVerificationModal?.valid ? (
                    <>
                      {slipVerificationModal && !slipVerificationModal.valid && (
                        <div className="rounded-[4px] border border-ink bg-surface-1 p-3.5 flex items-start gap-2.5 text-xs text-ink">
                          <ShieldAlert className="h-5 w-5 text-ink shrink-0" />
                          <div>
                            <div className="font-medium">{slipVerificationModal.errorCode}</div>
                            <div className="text-ink-muted mt-0.5">
                              {slipVerificationModal.errorMessageThai}
                            </div>
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={processingCheckout}
                        onClick={() => void handleVerifySlipStep1()}
                        className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-[15px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                      >
                        {isLaos
                          ? `${t('pos.verifySlipBtn')} LAOQR (Step 1)`
                          : 'ตรวจสอบโครงสร้างสลิป BOT Mini-QR (Step 1)'}
                      </button>

                      {isLaos && fiscal.laoQrVerificationPolicy === 'VISUAL_CONFIRM_ALLOWED' && (
                        <button
                          type="button"
                          disabled={processingCheckout || cartSummary.totalSatang <= 0}
                          onClick={() => void executeFinalCheckout('PROMPTPAY_QR', undefined)}
                          className={`h-[44px] w-full rounded-[48px] border border-primary bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                        >
                          {t('pos.visualConfirmOnePay')}
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="rounded-[8px] bg-primary-soft p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-google-display text-sm font-medium text-primary-dark">
                          <CheckCircle2 className="h-4 w-4" />
                          {pick(
                            'สลิปถูกต้องและไม่เคยถูกใช้ซ้ำ',
                            'ສະລິບຖືກຕ້ອງ ແລະ ບໍ່ເຄີຍຖືກໃຊ້ຊ້ຳ',
                            'Slip valid and not previously used'
                          )}
                        </span>
                        <span className="text-xs font-medium text-ink tabular-nums-google">
                          Ref *{slipVerificationModal.transRefLast4}
                        </span>
                      </div>
                      <div className="rounded-[4px] border border-hairline bg-canvas p-3">
                        <div className="text-xs text-ink-muted">
                          {pick('ธนาคารต้นทาง', 'ທະນາຄານຕົ້ນທາງ', 'Sender Bank')}
                        </div>
                        <div className="font-google-display text-[18px] text-ink">
                          {slipVerificationModal.bankDisplayNameThai}
                        </div>
                        <div className="mt-1.5 text-xs text-ink-soft flex items-center gap-1.5">
                          <AlertTriangle className="h-4 w-4 text-primary shrink-0" />
                          {pick(
                            'โปรดตรวจยอดเงินบนสลิปลูกค้าให้ตรงกับ',
                            'ກະລຸນາກວດຍອດເງິນເທິງສະລິບໃຫ້ກົງກັບ',
                            'Verify slip amount matches'
                          )}{' '}
                          <strong>{slipVerificationModal.expectedAmountFormatted}</strong>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={processingCheckout || cartSummary.totalSatang <= 0}
                        onClick={() =>
                          void executeFinalCheckout('PROMPTPAY_QR', slipMiniQrInput.trim())
                        }
                        className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-[15px] sm:text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                      >
                        {t('pos.confirmPayQr')}
                      </button>
                    </div>
                  )}
                </div>
                  </>
                )}
              </div>
            )}

            {paymentTab === 'CARD' && (
              <div className="py-10 text-center space-y-5">
                <Layers className="h-10 w-10 text-primary mx-auto" />
                <div>
                  <div className="font-google-display text-[20px] text-ink">
                    {pick('รับชำระผ่านเครื่องรูดบัตร EDC', 'ຮັບຊຳລະຜ່ານເຄື່ອງຮູດບັດ EDC', 'Card / EDC Terminal Payment')}
                  </div>
                  <p className="text-sm text-ink-muted mt-1">
                    {pick('ตรวจสอบสลิปอนุมัติจากเครื่อง EDC ยอด', 'ກວດສອບສະລິບອະນຸມັດຈາກເຄື່ອງ EDC ຍອດ', 'Verify EDC approval slip for')}{' '}
                    <strong className="text-ink">{money(cartSummary.totalSatang)}</strong>{' '}
                    {pick('ก่อนกดยืนยัน', 'ກ່ອນກົດຢືນຢັນ', 'before confirming')}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={processingCheckout}
                  onClick={() => void executeFinalCheckout('CARD')}
                  className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                >
                  {t('pos.confirmPayCard')}
                </button>
              </div>
            )}

            {paymentTab === 'SPLIT' && (
              <div className="space-y-4">
                {cartSummary.totalSatang <= 0 ? (
                  <div className="rounded-[4px] border border-hairline bg-surface-1 p-5 text-center space-y-3">
                    <p className="text-sm font-medium text-ink">
                      {pick(
                        `ยอดชำระสุทธิเป็น ${money(0)} ไม่สามารถใช้โหมดแยกจ่ายได้`,
                        `ຍອດຊຳລະສຸດທິເປັນ ${money(0)} ບໍ່ສາມາດໃຊ້ໂໝດແຍກຈ່າຍໄດ້`,
                        `Total is ${money(0)}; cannot use split payment`
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => setPaymentTab('CASH')}
                      className={`h-[44px] rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      {t('pos.cashTab')} ({money(0)})
                    </button>
                  </div>
                ) : (
                  <>
                <div>
                  <label htmlFor={`${uid}-split-cash`} className="block text-xs font-medium text-ink-muted mb-1.5">
                    {pick('ส่วนที่ 1: ยอดรับเงินสด', 'ສ່ວນທີ 1: ຍອດຮັບເງິນສົດ', 'Part 1: Cash Amount')} ({currencyCode})
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      id={`${uid}-split-cash`}
                      type="text"
                      value={splitCashBahtInput}
                      onChange={(e) => {
                        setSplitCashBahtInput(e.target.value);
                        setSlipVerificationModal(null);
                        clearPromptPayQrState();
                      }}
                      className={`h-12 flex-1 rounded-[4px] border border-hairline bg-canvas px-4 font-google-display text-[22px] text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                    />
                    {splitSecondMethod === 'PROMPTPAY_QR' && splitRemainingSatang > 0 && (
                      <button
                        type="button"
                        onClick={() => void loadPromptPayQr(splitRemainingSatang)}
                        className={`min-h-[44px] rounded-[48px] border border-primary bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:bg-surface-1 whitespace-nowrap ${UI_INTERACTION.focusButton}`}
                      >
                        {pick('อัปเดต QR ยอดคงเหลือ', 'ອັບເດດ QR ຍອດທີ່ເຫຼືອ', 'Refresh Remainder QR')}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[
                      ...getSplitCashQuickPresetsForCountry(countryCode).map((p) => ({
                        label: money(p.satang),
                        satang: p.satang,
                      })),
                      {
                        label: t('pos.halfBill'),
                        satang: Math.floor(cartSummary.totalSatang / 200) * 100,
                      },
                    ]
                      .filter((x) => x.satang > 0 && x.satang < cartSummary.totalSatang)
                      .map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setSplitCashBahtInput(moneyInput(preset.satang));
                            setSlipVerificationModal(null);
                            const rem = Math.max(0, cartSummary.totalSatang - preset.satang);
                            if (splitSecondMethod === 'PROMPTPAY_QR' && rem > 0) {
                              void loadPromptPayQr(rem);
                            }
                          }}
                          className={`rounded-[48px] border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                        >
                          {preset.label}
                        </button>
                      ))}
                  </div>
                </div>

                <div className="border-t border-hairline pt-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-ink-muted">
                      {pick('ส่วนที่ 2: ชำระยอดคงเหลือ', 'ສ່ວນທີ 2: ຊຳລະຍອດທີ່ເຫຼືອ', 'Part 2: Pay remainder')}{' '}
                      {money(splitRemainingSatang)}{' '}
                      {pick('ด้วย', 'ດ້ວຍ', 'via')}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSplitSecondMethod('PROMPTPAY_QR');
                          setSlipVerificationModal(null);
                          if (splitRemainingSatang > 0) {
                            void loadPromptPayQr(splitRemainingSatang);
                          }
                        }}
                        className={`rounded-[48px] border px-3.5 py-1.5 text-xs font-medium ${UI_INTERACTION.focusButton} ${
                          splitSecondMethod === 'PROMPTPAY_QR'
                            ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                            : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                        }`}
                      >
                        {qrMethodLabel}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSplitSecondMethod('CARD');
                          setSlipVerificationModal(null);
                          clearPromptPayQrState();
                        }}
                        className={`rounded-[48px] border px-3.5 py-1.5 text-xs font-medium ${UI_INTERACTION.focusButton} ${
                          splitSecondMethod === 'CARD'
                            ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                            : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                        }`}
                      >
                        {t('pos.cardTab')}
                      </button>
                    </div>
                  </div>

                  {splitSecondMethod === 'PROMPTPAY_QR' ? (
                    <div className="space-y-3">
                      <div className="flex flex-col sm:flex-row items-center gap-4 rounded-[4px] border border-hairline p-3">
                        {qrDataUrl ? (
                          <img
                            src={qrDataUrl}
                            alt={`Split ${qrMethodLabel}`}
                            className="h-28 w-28 rounded-[4px] border border-hairline shrink-0"
                          />
                        ) : (
                          <div className="h-28 w-28 rounded-[4px] border border-hairline bg-surface-1 flex items-center justify-center text-[11px] text-ink-muted shrink-0">
                            {pick('กดอัปเดต QR', 'ກົດອັບເດດ QR', 'Refresh QR')}
                          </div>
                        )}
                        <div className="text-xs space-y-1">
                          <div className="font-google-display text-sm font-medium text-ink">
                            {qrMethodLabel}: {money(splitRemainingSatang)}
                          </div>
                          <p className="text-ink-muted">
                            {isLaos
                              ? pick(
                                  'สแกนหรือกรอกเลข Ref สลิปสำหรับยอดโอนส่วนที่ 2',
                                  'ສະແກນ ຫຼື ປ້ອນເລກ Ref ສະລິບສຳລັບຍອດໂອນສ່ວນທີ 2',
                                  'Scan or enter transfer Ref for Part 2'
                                )
                              : 'สแกน Mini-QR บนสลิปลูกค้าเพื่อป้องกันสลิปซ้ำ หรือกดตรวจสลิป Step 1'}
                          </p>
                        </div>
                      </div>

                      {isLaos && (
                        <select
                          aria-label={t('pos.laoSlipBankLabel')}
                          value={laoSenderBankCode}
                          onChange={(e) => {
                            setLaoSenderBankCode(e.target.value);
                            setSlipVerificationModal(null);
                          }}
                          className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
                        >
                          {LAO_BANKS.map((bank) => (
                            <option key={bank.code} value={bank.code}>
                              {bank.code} — {locale === 'lo' ? bank.displayNameLao : locale === 'en' ? bank.displayNameEn : bank.displayNameThai}
                            </option>
                          ))}
                        </select>
                      )}

                      <input
                        type="text"
                        data-scanner-slip-allow="true"
                        aria-label={pick('ข้อมูลสลิปสำหรับส่วนที่ 2', 'ຂໍ້ມູນສະລິບສ່ວນທີ 2', 'Part 2 Slip Ref')}
                        value={slipMiniQrInput}
                        onChange={(e) => {
                          setSlipMiniQrInput(e.target.value);
                          setSlipVerificationModal(null);
                        }}
                        placeholder={
                          isLaos
                            ? t('pos.laoSlipRefPlaceholder')
                            : 'ยิงปืน 2D สแกนสลิปส่วนที่ 2 ได้ทันที...'
                        }
                        className={`h-10 w-full rounded-[4px] border border-hairline px-3 text-xs text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                      />

                      {!slipVerificationModal?.valid ? (
                        <div className="space-y-2">
                          <button
                            type="button"
                            disabled={
                              processingCheckout ||
                              splitCashSatang <= 0 ||
                              splitRemainingSatang <= 0
                            }
                            onClick={() => void handleVerifySlipStep1(splitRemainingSatang)}
                            className={`h-[48px] w-full rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                          >
                            {t('pos.verifySlipBtn')} ({money(splitRemainingSatang)})
                          </button>
                          {isLaos && fiscal.laoQrVerificationPolicy === 'VISUAL_CONFIRM_ALLOWED' && (
                            <button
                              type="button"
                              disabled={
                                processingCheckout ||
                                splitCashSatang <= 0 ||
                                splitRemainingSatang <= 0
                              }
                              onClick={() => void executeFinalCheckout('SPLIT', undefined)}
                              className={`h-[42px] w-full rounded-[48px] border border-primary bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                            >
                              {t('pos.visualConfirmOnePay')}
                            </button>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            processingCheckout ||
                            splitCashSatang <= 0 ||
                            splitRemainingSatang <= 0
                          }
                          onClick={() =>
                            void executeFinalCheckout('SPLIT', slipMiniQrInput.trim())
                          }
                          className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-[15px] font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                        >
                          {pick(
                            `ยืนยันแยกจ่าย (เงินสด + ${qrMethodLabel}) · เปิดลิ้นชัก & พิมพ์ใบเสร็จ`,
                            `ຢືນຢັນແຍກຈ່າຍ (ເງິນສົດ + ${qrMethodLabel}) · ພິມໃບບິນ`,
                            `Confirm Split (Cash + ${qrMethodLabel}) & Print`
                          )}
                        </button>
                      )}
                    </div>
                  ) : (
                      <button
                        type="button"
                        disabled={
                          processingCheckout ||
                          cartSummary.totalSatang <= 0 ||
                          splitCashSatang <= 0 ||
                          splitRemainingSatang <= 0
                        }
                        onClick={() => void executeFinalCheckout('SPLIT')}
                        className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-[15px] font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                      >
                        {pick(
                          'ยืนยันแยกจ่าย (เงินสด + บัตร EDC) · เปิดลิ้นชัก & พิมพ์ใบเสร็จ',
                          'ຢືນຢັນແຍກຈ່າຍ (ເງິນສົດ + ບັດ EDC) · ພິມໃບບິນ',
                          'Confirm Split (Cash + Card) & Print'
                        )}
                      </button>
                    )}
                  </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </ModalDialog>

      {/* ==================================================================== */}
      {/* DIALOG 3: 203-DPI CANVAS THAI RASTER & 80mm/58mm RECEIPT MODAL       */}
      {/* ==================================================================== */}
      <ModalDialog
        open={receiptModalOpen && Boolean(lastPrintedReceipt)}
        onClose={() => setReceiptModalOpen(false)}
        labelledBy={`${uid}-receipt-title`}
        maxWidthClass="max-w-lg"
      >
        {lastPrintedReceipt && (
          <>
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4 shrink-0">
              <div>
                <h3 id={`${uid}-receipt-title`} className="font-google-display text-[18px] font-normal text-ink">
                  {pick(
                    `ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ (${printPaperWidthMm}mm)`,
                    `ໃບຮັບເງິນ / ໃບເກັບເງິນ (${printPaperWidthMm}mm)`,
                    `Receipt / Tax Invoice (${printPaperWidthMm}mm)`
                  )}
                </h3>
                <p className="text-xs text-ink-muted">
                  {lastPrintedReceipt.spoolStatus === 'PRINTED_IMMEDIATELY'
                    ? `ส่งออกชุดคำสั่ง 203-DPI สำเร็จ (${lastPrintedReceipt.packetsCount} แถบ GS v 0)`
                    : `เก็บเข้าคิวรอพิมพ์อัตโนมัติ (${lastPrintedReceipt.pendingQueueLength} ใบค้างคิว)`}
                  {canvasRasterStats?.transportMode
                    ? ` · พอร์ต ${canvasRasterStats.transportMode}`
                    : ''}
                </p>
              </div>
              <button
                type="button"
                aria-label="ปิดหน้าต่างตัวอย่างใบเสร็จ"
                onClick={() => setReceiptModalOpen(false)}
                className={`flex h-11 w-11 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 203-DPI Raster vs Text & 80mm/58mm Toolbar */}
            <div className="border-b border-hairline bg-canvas px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
              <div className="inline-flex rounded-[48px] border border-hairline p-0.5">
                <button
                  type="button"
                  onClick={() => setReceiptViewMode('CANVAS_203DPI')}
                  className={`rounded-[48px] px-3 py-1 font-medium ${UI_INTERACTION.focusButton} ${
                    receiptViewMode === 'CANVAS_203DPI'
                      ? 'bg-primary text-white hover:bg-primary-hover'
                      : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {pick('ฟอนต์ 203-DPI (1-Bit)', 'ຟອນ 203-DPI (1-Bit)', '203-DPI Raster (1-Bit)')}
                </button>
                <button
                  type="button"
                  onClick={() => setReceiptViewMode('TEXT')}
                  className={`rounded-[48px] px-3 py-1 font-medium ${UI_INTERACTION.focusButton} ${
                    receiptViewMode === 'TEXT'
                      ? 'bg-primary text-white hover:bg-primary-hover'
                      : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  ข้อความ (Text)
                </button>
              </div>

              <div className="inline-flex rounded-[48px] border border-hairline p-0.5">
                {([80, 58] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => {
                      setPrintPaperWidthMm(w);
                      if (lastPrintedReceipt.salesOrderId) {
                        void handleReprintOrder(
                          lastPrintedReceipt.salesOrderId,
                          lastPrintedReceipt.receiptNumber,
                          lastPrintedReceipt.abbTaxInvoiceNo,
                          w
                        );
                      }
                    }}
                    className={`rounded-[48px] px-3 py-1 font-medium ${UI_INTERACTION.focusButton} ${
                      printPaperWidthMm === w
                        ? 'bg-ink text-white hover:bg-hero'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {w}mm
                  </button>
                ))}
              </div>
            </div>

            <div className="p-5 bg-surface-1 overflow-y-auto flex-1 flex justify-center">
              <div
                id="rube-printable-receipt"
                className={`thermal-receipt-paper rounded-[4px] p-3 overflow-x-auto ${
                  printPaperWidthMm === 58 ? 'paper-58mm max-w-[260px]' : 'max-w-[380px]'
                } w-full`}
              >
                {receiptViewMode === 'CANVAS_203DPI' &&
                lastPrintedReceipt.canvasRasterPreviewUrl ? (
                  <img
                    src={lastPrintedReceipt.canvasRasterPreviewUrl}
                    alt="203-DPI Thai Monochrome Thermal Receipt Raster"
                    className="w-full h-auto block"
                  />
                ) : (
                  <pre className="text-xs leading-relaxed whitespace-pre-wrap">
                    {lastPrintedReceipt.formattedTextLines.join('\n')}
                  </pre>
                )}
              </div>
            </div>

            <div className="border-t border-hairline bg-canvas px-5 py-3.5 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className={`flex h-[42px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <Printer className="h-4 w-4" />
                  Windows Print ({printPaperWidthMm}mm)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void posTransport
                      .kickCashDrawer()
                      .then((r) =>
                        onToast(
                          r.outcome.dispatchedToHardware
                            ? 'ส่งพัลส์เปิดลิ้นชักเก็บเงิน RJ11 สำเร็จ'
                            : 'จำลองคำสั่งเปิดลิ้นชัก RJ11 (ไม่ได้ต่อพอร์ตจริง)',
                          'success'
                        )
                      )
                      .catch((e) => onToast(e instanceof Error ? e.message : String(e), 'error'));
                  }}
                  className={`h-[42px] rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-soft hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  เตะลิ้นชัก RJ11
                </button>
              </div>
              <button
                type="button"
                onClick={() => setReceiptModalOpen(false)}
                className={`h-[42px] rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                เสร็จสิ้น (บิลถัดไป)
              </button>
            </div>
          </>
        )}
      </ModalDialog>

      <VoidOrderAuthModal
        open={Boolean(voidTargetOrder)}
        order={voidTargetOrder}
        currentUser={currentUser}
        onClose={() => setVoidTargetOrder(null)}
        onVoidAuthorized={handleAuthorizedVoidOrder}
      />

      <TableQrSlipModal
        open={tableQrModalOpen}
        outletId={outletId}
        bootstrap={bootstrap}
        currentUser={currentUser}
        tableSessions={qrTableSessions}
        onClose={() => setTableQrModalOpen(false)}
        onSessionsChanged={() => refreshQrGuestOrders(false)}
        onToast={onToast}
      />

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title ?? ''}
        description={confirmAction?.description ?? ''}
        confirmLabel={confirmAction?.confirmLabel ?? 'ยืนยัน'}
        tone={confirmAction?.tone ?? 'danger'}
        busy={confirmBusy}
        onCancel={() => {
          if (!confirmBusy) setConfirmAction(null);
        }}
        onConfirm={() => {
          if (!confirmAction) return;
          setConfirmBusy(true);
          Promise.resolve(confirmAction.onConfirm())
            .catch((err) => onToast(err instanceof Error ? err.message : String(err), 'error'))
            .finally(() => {
              setConfirmBusy(false);
              setConfirmAction(null);
            });
        }}
      />
    </div>
  );
};
