import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  RotateCcw,
  Scale,
  ScanBarcode,
  Search,
  ShieldAlert,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import {
  computeVatSatang,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  parseDecimalStringToScaledInt,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
} from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport, type SlipConfirmationModalDto } from '../api/pos-transport.ts';
import { renderThaiReceiptTo203DpiCanvasRaster } from '../utils/thai-canvas-rasterizer.ts';
import type {
  BootstrapPayload,
  CartItem,
  CatalogVariantDetailDto,
  CheckoutOrderRequest,
  ModifierDto,
  PrintedReceiptPreview,
  SplitPaymentLegInput,
  StaffUserDto,
  TaxMode,
} from '../types.ts';

interface PosRegisterWorkspaceProps {
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
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

interface HeldBillRecord {
  id: string;
  referenceLabel: string;
  orderType: CheckoutOrderRequest['orderType'];
  taxMode: TaxMode;
  discountMode?: 'BAHT' | 'PERCENT' | undefined;
  discountInput?: string | undefined;
  cart: CartItem[];
  totalSatang: number;
  heldByName: string;
  heldAtIso: string;
}

const HELD_BILLS_STORAGE_KEY = 'rube_pos_v3_held_bills';
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

/**
 * Editorial edge-to-edge top artwork for `card-photo` (google.design.md lines 24 & 378):
 * Chrome stays strictly monochrome (#ffffff / #202124 / #dadce0) + singular #1a73e8;
 * the edge-to-edge top band carries the editorial visual composition with zero inset.
 */
const ProductEditorialArtwork: React.FC<{
  item: CatalogVariantDetailDto;
  inCartQtyMilli: number;
}> = React.memo(({ item, inCartQtyMilli }) => {
  const isCafe = item.categoryId === 'CAT-CAFE' || item.isComposite;
  const isScale = item.isWeightedScale;

  return (
    <div className="relative h-[132px] w-full overflow-hidden bg-[#f8f9fa] border-b border-[#dadce0]">
      {isCafe ? (
        /* Warm editorial espresso / tea botanical studio composition */
        <svg
          viewBox="0 0 360 132"
          className="h-full w-full object-cover"
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
          <circle cx="288" cy="106" r="74" fill="#f3dfc6" fillOpacity="0.18" />
          <circle cx="256" cy="40" r="34" fill="#ffffff" fillOpacity="0.1" />
          <circle cx="76" cy="100" r="8" fill="#1b110c" fillOpacity="0.55" />
          <circle cx="96" cy="106" r="7" fill="#1b110c" fillOpacity="0.55" />
          <circle cx="114" cy="98" r="8" fill="#1b110c" fillOpacity="0.55" />
        </svg>
      ) : isScale ? (
        /* Crisp butcher / fresh-market architectural composition */
        <svg
          viewBox="0 0 360 132"
          className="h-full w-full object-cover"
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
          <rect x="248" y="22" width="88" height="44" rx="2" fill="#ffffff" fillOpacity="0.14" />
        </svg>
      ) : (
        /* Clean architectural retail / glacial hydration composition */
        <svg
          viewBox="0 0 360 132"
          className="h-full w-full object-cover"
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
          <circle cx="295" cy="28" r="58" fill="#ffffff" fillOpacity="0.14" />
          <path
            d="M0 102 C90 80 180 118 360 86 L360 132 L0 132 Z"
            fill="#ffffff"
            fillOpacity="0.18"
          />
        </svg>
      )}

      {/* Subtle top-left monochrome metadata tag */}
      <div className="absolute left-3 top-3 flex items-center gap-1.5">
        <span className="rounded-[4px] bg-white/92 px-2 py-0.5 text-[11px] font-medium text-[#202124] backdrop-blur-xs">
          {item.isComposite
            ? 'สูตร BOM'
            : item.isWeightedScale
              ? 'ชั่งน้ำหนัก กก.'
              : item.sku}
        </span>
      </div>

      {/* Active In-Cart Counter Pill (Google Blue #1a73e8 48px pill) */}
      {inCartQtyMilli > 0 && (
        <div className="absolute right-3 top-3 rounded-[48px] bg-[#1a73e8] px-3 py-1 text-xs font-medium text-white tabular-nums-google">
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
  onRefreshState,
  onToast,
}) => {
  const defaultLayout =
    bootstrap.profile === 'RETAIL' ? 'SCAN_LEDGER' : 'STUDIO_CARDS';
  const [posSubView, setPosSubView] = useState<
    'STUDIO_CARDS' | 'SCAN_LEDGER' | 'HELD_BILLS' | 'ORDER_HISTORY'
  >(defaultLayout);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [scanMultiplier, setScanMultiplier] = useState<number>(1);
  const [orderType, setOrderType] = useState<CheckoutOrderRequest['orderType']>(
    bootstrap.profile === 'RETAIL' ? 'RETAIL' : 'TAKEAWAY'
  );
  const [queueOrTableLabel, setQueueOrTableLabel] = useState<string>('');
  const [taxMode, setTaxMode] = useState<TaxMode>('INCLUSIVE');

  // Discount supports either Baht (THB) or Percentage (%)
  const [discountMode, setDiscountMode] = useState<'BAHT' | 'PERCENT'>('BAHT');
  const [discountInput, setDiscountInput] = useState<string>('0');

  // Active selected cart line for inline exact quantity editing
  const [editingCartKey, setEditingCartKey] = useState<string | null>(null);
  const [editingQtyInput, setEditingQtyInput] = useState<string>('');

  // Held Bills (persisted in localStorage for real lane continuity)
  const [heldBills, setHeldBills] = useState<HeldBillRecord[]>(() => {
    try {
      const raw = window.localStorage.getItem(HELD_BILLS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as HeldBillRecord[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(HELD_BILLS_STORAGE_KEY, JSON.stringify(heldBills));
    } catch {
      // ignore storage quota errors
    }
  }, [heldBills]);

  // Modifier customization dialog state
  const [customizingVariant, setCustomizingVariant] = useState<CatalogVariantDetailDto | null>(
    null
  );
  const [draftModIds, setDraftModIds] = useState<string[]>(['MOD-SWEET-100']);
  const [draftQtyInput, setDraftQtyInput] = useState<string>('1');

  // Checkout Dialog state
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [paymentTab, setPaymentTab] = useState<'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'SPLIT'>('CASH');
  const [splitSecondMethod, setSplitSecondMethod] = useState<'PROMPTPAY_QR' | 'CARD'>(
    'PROMPTPAY_QR'
  );
  const [splitCashBahtInput, setSplitCashBahtInput] = useState<string>('100');
  const [cashTenderedBahtInput, setCashTenderedBahtInput] = useState<string>('');
  const [cashNumpadPristine, setCashNumpadPristine] = useState<boolean>(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrPayloadText, setQrPayloadText] = useState<string>('');
  const [qrCrcHex, setQrCrcHex] = useState<string>('');
  const [slipMiniQrInput, setSlipMiniQrInput] = useState<string>(
    `0041000600000101030040220KBANK${Date.now().toString().slice(-12)}5102TH9104ABCD`
  );
  const [slipVerificationModal, setSlipVerificationModal] =
    useState<SlipConfirmationModalDto | null>(null);
  const [processingCheckout, setProcessingCheckout] = useState(false);

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

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const discountInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (bootstrap.profile === 'RETAIL') {
      setPosSubView('SCAN_LEDGER');
      setOrderType('RETAIL');
    } else if (bootstrap.profile === 'HOSPITALITY') {
      setPosSubView('STUDIO_CARDS');
      setOrderType('DINE_IN');
    }
  }, [bootstrap.profile]);

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

  // Sellable items filtered by profile, category, and search query
  const sellableCatalog = useMemo(() => {
    return bootstrap.catalogDetailed.filter((item) => {
      if (!item.active) return false;
      if (bootstrap.profile === 'RETAIL' && item.categoryId === 'CAT-CAFE') return false;
      if (bootstrap.profile === 'HOSPITALITY' && item.categoryId === 'CAT-RETAIL') return false;
      if (selectedCategoryId === 'ALL' && item.categoryId === 'CAT-RAW' && !searchQuery.trim()) {
        return false;
      }
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
      const lineTotalSatang = Number(
        roundDivBigInt(BigInt(line.quantityMilli) * BigInt(effectiveUnitSatang), SCALE_MILLI)
      );
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
        discountSatang = Math.min(
          subtotalSatang,
          Math.max(0, parseDecimalStringToScaledInt(discountInput || '0', 2))
        );
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

    const afterDiscount = Math.max(0, subtotalSatang - discountSatang);
    const taxSatang = computeVatSatang(afterDiscount, 700, taxMode);
    const netBeforeTaxSatang = taxMode === 'INCLUSIVE' ? afterDiscount - taxSatang : afterDiscount;
    const totalSatang = taxMode === 'EXCLUSIVE' ? afterDiscount + taxSatang : afterDiscount;
    const totalItemUnitsCount = computedLines.reduce(
      (acc, l) => acc + (l.isWeightedScale ? 1 : Math.max(1, Math.round(l.quantityMilli / 1000))),
      0
    );

    return {
      lines: computedLines,
      totalItemUnitsCount,
      subtotalSatang,
      discountSatang,
      netBeforeTaxSatang,
      taxSatang,
      totalSatang,
    };
  }, [cart, discountInput, discountMode, modifiersById, taxMode]);

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
      setCustomizingVariant(variant);
      setDraftModIds(defaultSingleMods);
      setDraftQtyInput(String(scanMultiplier));
      setScanMultiplier(1);
      return;
    }
    addVariantToCartDirect(variant, qtyMilli, []);
    if (scanMultiplier > 1) {
      setScanMultiplier(1);
    }
  };

  const handleHoldCurrentBill = useCallback(() => {
    if (cart.length === 0) {
      if (heldBills.length > 0) {
        setPosSubView('HELD_BILLS');
      } else {
        onToast('ยังไม่มีรายการในบิลสำหรับพักบิล', 'warn');
      }
      return;
    }
    const refLabel =
      queueOrTableLabel.trim() || `คิวพัก #${String(heldBills.length + 1).padStart(2, '0')}`;
    const record: HeldBillRecord = {
      id: `HOLD-${Date.now()}`,
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
    setHeldBills((prev) => [record, ...prev]);
    setCart([]);
    setQueueOrTableLabel('');
    setDiscountInput('0');
    onToast(`พักบิล "${refLabel}" เรียบร้อยแล้ว (กด F8 เพื่อเรียกคืน)`, 'success');
  }, [
    cart,
    cartSummary.totalSatang,
    currentUser.displayName,
    discountInput,
    discountMode,
    heldBills.length,
    onToast,
    orderType,
    queueOrTableLabel,
    setCart,
    taxMode,
  ]);

  const handleRecallHeldBill = (held: HeldBillRecord) => {
    setCart(held.cart);
    setOrderType(held.orderType);
    setTaxMode(held.taxMode);
    if (held.discountMode) setDiscountMode(held.discountMode);
    if (held.discountInput !== undefined) setDiscountInput(held.discountInput);
    setQueueOrTableLabel(held.referenceLabel);
    setHeldBills((prev) => prev.filter((h) => h.id !== held.id));
    setPosSubView(bootstrap.profile === 'RETAIL' ? 'SCAN_LEDGER' : 'STUDIO_CARDS');
    onToast(`เรียกบิล "${held.referenceLabel}" กลับมาที่หน้าขายแล้ว`, 'success');
  };

  const splitCashSatang = useMemo(() => {
    try {
      const parsed = parseDecimalStringToScaledInt(splitCashBahtInput || '0', 2);
      return Math.max(0, Math.min(cartSummary.totalSatang, parsed));
    } catch {
      return 0;
    }
  }, [cartSummary.totalSatang, splitCashBahtInput]);

  const splitRemainingSatang = Math.max(0, cartSummary.totalSatang - splitCashSatang);

  const loadPromptPayQr = useCallback(
    async (overrideAmountSatang?: number) => {
      if (cart.length === 0) return;
      try {
        const qr = await posTransport.generatePromptPayQr({
          taxMode,
          discountSatang: cartSummary.discountSatang,
          ...(overrideAmountSatang !== undefined ? { overrideAmountSatang } : {}),
          lines: cart.map((l) => ({
            variantId: l.variantId,
            quantityMilli: l.quantityMilli,
            unitPriceSatang: l.unitPriceSatang,
            selectedModifierIds: l.selectedModifierIds,
          })),
        });
        setQrPayloadText(qr.payload);
        setQrCrcHex(qr.crcHex);
        const url = await QRCode.toDataURL(qr.payload, {
          width: 224,
          margin: 1,
          color: { dark: '#202124', light: '#ffffff' },
        });
        setQrDataUrl(url);
      } catch (err) {
        onToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [cart, cartSummary.discountSatang, onToast, taxMode]
  );

  const dispatch203DpiThaiCanvasPrint = useCallback(
    async (input: {
      salesOrderId?: string | undefined;
      receiptNumber: string;
      abbTaxInvoiceNo: string;
      createdAtIso: string;
      cashierName: string;
      lines: Array<{
        itemName: string;
        qtyText: string;
        totalText: string;
        modifiersText?: string | undefined;
      }>;
      subtotalSatang: number;
      discountSatang: number;
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
        storeName: bootstrap.storeSettings.storeName,
        taxId: bootstrap.storeSettings.taxId,
        branchCode: bootstrap.storeSettings.branchCode,
        posRegNo: bootstrap.storeSettings.rdPosRegNo,
        receiptNumber: input.receiptNumber,
        abbTaxInvoiceNo: input.abbTaxInvoiceNo,
        createdAtText: new Date(input.createdAtIso).toLocaleString('th-TH'),
        cashierName: input.cashierName,
        lines: input.lines,
        subtotalText: `฿${formatSatangToThbString(input.subtotalSatang)}`,
        discountText: `฿${formatSatangToThbString(input.discountSatang)}`,
        netBeforeTaxText: `฿${formatSatangToThbString(input.netBeforeTaxSatang)}`,
        vatText: `฿${formatSatangToThbString(input.taxSatang)}`,
        grandTotalText: `฿${formatSatangToThbString(input.totalSatang)}`,
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
      printPaperWidthMm,
    ]
  );

  const openCheckoutModal = useCallback(
    async (initialTab: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'SPLIT') => {
      if (cart.length === 0) {
        onToast('กรุณาเลือกรายการสินค้าก่อนรับชำระเงิน', 'warn');
        return;
      }
      setPaymentTab(initialTab);
      setCashTenderedBahtInput(
        formatSatangToThbString(cartSummary.totalSatang).replace(/,/g, '')
      );
      // Pre-populate half of total for split payment convenience
      if (initialTab === 'SPLIT' || cartSummary.totalSatang > 200) {
        const halfSatang = Math.floor(cartSummary.totalSatang / 200) * 100;
        setSplitCashBahtInput(formatSatangToThbString(Math.max(100, halfSatang)).replace(/,/g, ''));
      }
      setCashNumpadPristine(true);
      setSlipVerificationModal(null);
      setCheckoutModalOpen(true);

      if (initialTab === 'PROMPTPAY_QR') {
        await loadPromptPayQr();
      } else if (initialTab === 'SPLIT' && splitSecondMethod === 'PROMPTPAY_QR') {
        const halfSatang = Math.floor(cartSummary.totalSatang / 200) * 100;
        const rem = Math.max(0, cartSummary.totalSatang - Math.max(100, halfSatang));
        if (rem > 0) await loadPromptPayQr(rem);
      }
    },
    [cart.length, cartSummary.totalSatang, loadPromptPayQr, onToast, splitSecondMethod]
  );

  const instantExactCashCheckoutRef = useRef<(() => void) | null>(null);

  // Cashier Function-Key Ergonomics (F2, F4, F8, F9, F10, F12, Escape)
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
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
        handleHoldCurrentBill();
      } else if (e.key === 'F9') {
        e.preventDefault();
        discountInputRef.current?.focus();
        discountInputRef.current?.select();
      } else if (e.key === 'F10') {
        e.preventDefault();
        if (!checkoutModalOpen && cart.length > 0) {
          void openCheckoutModal('CASH');
        }
      } else if (e.key === 'F12') {
        e.preventDefault();
        if (!checkoutModalOpen && !customizingVariant && !receiptModalOpen && cart.length > 0) {
          instantExactCashCheckoutRef.current?.();
        }
      } else if (e.key === 'Escape') {
        if (checkoutModalOpen) setCheckoutModalOpen(false);
        else if (customizingVariant) setCustomizingVariant(null);
        else if (receiptModalOpen) setReceiptModalOpen(false);
        else if (editingCartKey) setEditingCartKey(null);
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [
    cart.length,
    checkoutModalOpen,
    customizingVariant,
    editingCartKey,
    handleHoldCurrentBill,
    openCheckoutModal,
    receiptModalOpen,
  ]);

  const handleVerifySlipStep1 = async (overrideAmountSatang?: number) => {
    if (!slipMiniQrInput.trim()) {
      onToast('กรุณาสแกนหรือวางข้อมูล BOT Mini-QR จากสลิปธนาคาร', 'warn');
      return;
    }
    setProcessingCheckout(true);
    try {
      const modal = await posTransport.verifyBotSlipStep1({
        miniQrRaw: slipMiniQrInput.trim(),
        taxMode,
        discountSatang: cartSummary.discountSatang,
        ...(overrideAmountSatang !== undefined ? { overrideAmountSatang } : {}),
        lines: cart.map((l) => ({
          variantId: l.variantId,
          quantityMilli: l.quantityMilli,
          unitPriceSatang: l.unitPriceSatang,
          selectedModifierIds: l.selectedModifierIds,
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
  };

  const executeFinalCheckout = async (
    method: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'SPLIT',
    verifiedSlipRaw?: string,
    instantExactCash = false
  ) => {
    if (processingCheckout || cart.length === 0) return;

    let tenderedSatang = cartSummary.totalSatang;
    let splitPaymentsPayload: SplitPaymentLegInput[] | undefined;

    if (method === 'CASH') {
      if (!instantExactCash) {
        try {
          tenderedSatang = parseDecimalStringToScaledInt(cashTenderedBahtInput || '0', 2);
        } catch {
          onToast('จำนวนเงินสดที่รับมาไม่ถูกต้อง', 'error');
          return;
        }
        if (tenderedSatang < cartSummary.totalSatang) {
          onToast('จำนวนเงินสดที่รับมาน้อยกว่ายอดสุทธิที่ต้องชำระ', 'warn');
          return;
        }
      }
    } else if (method === 'SPLIT') {
      if (splitCashSatang <= 0 || splitRemainingSatang <= 0) {
        onToast('สำหรับการแยกจ่าย กรุณาระบุยอดเงินสดให้มากกว่า 0 และน้อยกว่ายอดสุทธิ', 'warn');
        return;
      }
      splitPaymentsPayload = [
        {
          paymentMethod: 'CASH',
          amountSatang: splitCashSatang,
          cashTenderedSatang: splitCashSatang,
        },
        {
          paymentMethod: splitSecondMethod,
          amountSatang: splitRemainingSatang,
          ...(splitSecondMethod === 'PROMPTPAY_QR'
            ? { slipTransRefRaw: verifiedSlipRaw || slipMiniQrInput.trim() }
            : {}),
        },
      ];
    }

    const cartSnapshotLines = cartSummary.lines.map((l) => ({
      itemName: l.itemName,
      qtyText: l.isWeightedScale
        ? formatMilliUnitsToQtyString(l.quantityMilli, l.unitName)
        : `${Math.round(l.quantityMilli / 1000)} ${l.unitName}`,
      totalText: `฿${formatSatangToThbString(l.lineTotalSatang)}`,
      ...(l.mods.length > 0 ? { modifiersText: l.mods.map((m) => m.name).join(', ') } : {}),
    }));
    const snapshotSubtotal = cartSummary.subtotalSatang;
    const snapshotDiscount = cartSummary.discountSatang;
    const snapshotNet = cartSummary.netBeforeTaxSatang;
    const snapshotTax = cartSummary.taxSatang;
    const snapshotQueueOrTable = queueOrTableLabel.trim();

    setProcessingCheckout(true);
    try {
      const res = await posTransport.checkoutOrder({
        cashierId: currentUser.id,
        orderType,
        ...(snapshotQueueOrTable ? { tableOrQueueNo: snapshotQueueOrTable } : {}),
        paymentMethod: method === 'SPLIT' ? 'CASH' : method,
        ...(method === 'CASH' ? { cashTenderedSatang: tenderedSatang } : {}),
        ...(method === 'PROMPTPAY_QR' && verifiedSlipRaw
          ? { slipTransRefRaw: verifiedSlipRaw }
          : {}),
        ...(splitPaymentsPayload ? { splitPayments: splitPaymentsPayload } : {}),
        taxMode,
        discountSatang: snapshotDiscount,
        paperWidthPx: printPaperWidthMm === 58 ? 384 : 576,
        lines: cart.map((l) => ({
          variantId: l.variantId,
          itemName: l.itemName,
          unitName: l.unitName,
          quantityMilli: l.quantityMilli,
          unitPriceSatang: l.unitPriceSatang,
          selectedModifierIds: l.selectedModifierIds,
        })),
      });

      const paymentSummaryLines = res.order.payments.map(
        (p) =>
          `${p.paymentMethod}: ฿${formatSatangToThbString(p.amountSatang)}${
            p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''
          }`
      );
      if (snapshotQueueOrTable) {
        paymentSummaryLines.unshift(`ป้ายคิว/โต๊ะ: ${snapshotQueueOrTable}`);
      }
      if (res.order.changeGivenSatang && res.order.changeGivenSatang > 0) {
        paymentSummaryLines.push(`เงินทอน: ฿${formatSatangToThbString(res.order.changeGivenSatang)}`);
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
          lines: cartSnapshotLines,
          subtotalSatang: snapshotSubtotal,
          discountSatang: snapshotDiscount,
          netBeforeTaxSatang: snapshotNet,
          taxSatang: snapshotTax,
          totalSatang: res.order.totalSatang,
          paymentSummaryLines,
          kickCashDrawer: shouldKickDrawer,
        });
        rasterPreviewUrl = printed.raster.previewDataUrl;
        hardwareDispatched = printed.hwRes.hardwareOutcome.dispatchedToHardware;
        hardwareError = printed.hwRes.hardwareOutcome.errorMessage;
      } catch {
        // Canvas raster preview is best-effort; fallback to formatted text lines
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
      setCart([]);
      setQueueOrTableLabel('');
      setDiscountInput('0');
      setCheckoutModalOpen(false);
      setSlipVerificationModal(null);
      setSlipMiniQrInput(
        `0041000600000101030040220KBANK${Date.now().toString().slice(-12)}5102TH9104ABCD`
      );
      await onRefreshState();
      setReceiptModalOpen(true);

      const changeText =
        res.order.changeGivenSatang && res.order.changeGivenSatang > 0
          ? ` · เงินทอน ฿${formatSatangToThbString(res.order.changeGivenSatang)}`
          : '';
      onToast(
        `${instantExactCash ? '[F12 เงินสดด่วน] ' : ''}บันทึกการขายสำเร็จ ${res.order.abbTaxInvoiceNo}${changeText}`,
        res.spoolResult.status === 'PRINTED_IMMEDIATELY' ? 'success' : 'warn'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setProcessingCheckout(false);
    }
  };

  instantExactCashCheckoutRef.current = () => {
    void executeFinalCheckout('CASH', undefined, true);
  };

  const handleVoidOrder = async (salesOrderId: string, receiptNo: string) => {
    try {
      const res = await posTransport.voidOrder({
        salesOrderId,
        voidedByUserId: currentUser.id,
        voidReason: `Voided by ${currentUser.displayName}`,
      });
      await onRefreshState();
      onToast(
        `ยกเลิกบิล ${receiptNo} และคืนสต็อกต้นทุนเดิม (${res.reversedLedgerEntries.length} รายการ) สำเร็จ`,
        'warn'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleReprintOrder = async (
    salesOrderId: string,
    receiptNo: string,
    abbNo: string | null,
    overridePaperWidthMm?: 80 | 58
  ) => {
    try {
      const res = await posTransport.reprintOrder(salesOrderId);
      const matched = bootstrap.recentOrders.find((o) => o.salesOrderId === salesOrderId);
      const targetWidth = overridePaperWidthMm ?? printPaperWidthMm;

      let rasterPreviewUrl: string | undefined;
      if (matched) {
        try {
          const paymentLines =
            matched.payments && matched.payments.length > 0
              ? matched.payments.map(
                  (p) =>
                    `${p.paymentMethod}: ฿${formatSatangToThbString(p.amountSatang)}${
                      p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''
                    }`
                )
              : [`${matched.paymentSummaryLabel ?? matched.paymentMethod}: ฿${formatSatangToThbString(matched.totalSatang)}`];
          const printed = await dispatch203DpiThaiCanvasPrint({
            salesOrderId: matched.salesOrderId,
            receiptNumber: matched.receiptNumber,
            abbTaxInvoiceNo: matched.abbTaxInvoiceNo ?? '-',
            createdAtIso: matched.createdAt,
            cashierName: matched.cashierName,
            lines: matched.lines.map((l) => ({
              itemName: l.itemName,
              qtyText: formatMilliUnitsToQtyString(l.quantityMilli, l.unitName),
              totalText: `฿${formatSatangToThbString(l.lineTotalSatang)}`,
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

  const handleCashNumpadPress = (key: string) => {
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
      setCashTenderedBahtInput(key === '.' ? '0.' : key);
      setCashNumpadPristine(false);
      return;
    }
    setCashTenderedBahtInput((prev) => {
      if (key === '.' && prev.includes('.')) return prev;
      return prev === '0' && key !== '.' ? key : prev + key;
    });
  };

  const cashTenderedSatangPreview = useMemo(() => {
    try {
      return parseDecimalStringToScaledInt(cashTenderedBahtInput || '0', 2);
    } catch {
      return 0;
    }
  }, [cashTenderedBahtInput]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* ==================================================================== */}
      {/* LEFT WORKSPACE (8 COLS): SEARCH, VIEW TABS & PRODUCT CANVAS          */}
      {/* ==================================================================== */}
      <div className="lg:col-span-7 xl:col-span-8 space-y-5">
        {/* Top Register Control Strip: Mode Underline Tabs + Smart Search Pill */}
        <div className="border-b border-[#dadce0] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Canonical Google Nav-Link Tabs (4px #1a73e8 bottom-rule indicator, 48px height, zero fill) */}
            <div className="flex items-center gap-1 overflow-x-auto" role="tablist">
              {bootstrap.profile !== 'RETAIL' && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={posSubView === 'STUDIO_CARDS'}
                  onClick={() => setPosSubView('STUDIO_CARDS')}
                  className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                    posSubView === 'STUDIO_CARDS'
                      ? 'text-[#202124]'
                      : 'text-[#5f6368] hover:text-[#202124]'
                  }`}
                >
                  <LayoutGrid className="h-4 w-4" />
                  <span>การ์ดสินค้า</span>
                  {posSubView === 'STUDIO_CARDS' && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                  )}
                </button>
              )}

              {bootstrap.profile !== 'HOSPITALITY' && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={posSubView === 'SCAN_LEDGER'}
                  onClick={() => setPosSubView('SCAN_LEDGER')}
                  className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                    posSubView === 'SCAN_LEDGER'
                      ? 'text-[#202124]'
                      : 'text-[#5f6368] hover:text-[#202124]'
                  }`}
                >
                  <List className="h-4 w-4" />
                  <span>ตารางสแกนด่วน</span>
                  {posSubView === 'SCAN_LEDGER' && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                  )}
                </button>
              )}

              <button
                type="button"
                role="tab"
                aria-selected={posSubView === 'HELD_BILLS'}
                onClick={() => setPosSubView('HELD_BILLS')}
                className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                  posSubView === 'HELD_BILLS'
                    ? 'text-[#202124]'
                    : 'text-[#5f6368] hover:text-[#202124]'
                }`}
              >
                <PauseCircle className="h-4 w-4" />
                <span>บิลพักไว้</span>
                {heldBills.length > 0 && (
                  <span className="rounded-[48px] bg-[#1a73e8] px-2 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                    {heldBills.length}
                  </span>
                )}
                {posSubView === 'HELD_BILLS' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={posSubView === 'ORDER_HISTORY'}
                onClick={() => setPosSubView('ORDER_HISTORY')}
                className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                  posSubView === 'ORDER_HISTORY'
                    ? 'text-[#202124]'
                    : 'text-[#5f6368] hover:text-[#202124]'
                }`}
              >
                <History className="h-4 w-4" />
                <span>ใบเสร็จย้อนหลัง ({bootstrap.recentOrders.length})</span>
                {posSubView === 'ORDER_HISTORY' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                )}
              </button>
            </div>

            {/* Pre-Scan Quantity Multiplier Pills (F4) */}
            <div className="flex items-center gap-1.5 pb-2 sm:pb-0">
              <span className="text-xs text-[#5f6368] mr-1">ตัวคูณสแกน (F4):</span>
              {MULTIPLIER_PRESETS.map((mult) => {
                const active = scanMultiplier === mult;
                return (
                  <button
                    key={mult}
                    type="button"
                    onClick={() => setScanMultiplier(mult)}
                    className={`min-h-[36px] min-w-[44px] rounded-[48px] border px-3 font-google-display text-xs font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                      active
                        ? 'border-[#1a73e8] bg-[#1a73e8] text-white'
                        : 'border-[#dadce0] bg-white text-[#3c4043] hover:border-[#1a73e8] hover:text-[#1a73e8]'
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
              <Search className="pointer-events-none absolute left-4 h-5 w-5 text-[#5f6368]" />
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
                placeholder="ยิงบาร์โค้ด (ป้องกันคีย์ไทยอัตโนมัติ) หรือพิมพ์ชื่อสินค้า / SKU... (กด F2)"
                className="h-[50px] w-full rounded-[48px] border border-[#dadce0] bg-white pl-12 pr-44 text-[16px] text-[#202124] placeholder:text-[#80868b] transition-colors duration-200 focus:border-[#1a73e8] focus:outline-none focus:ring-2 focus:ring-[#1a73e8]/20"
              />
              <div className="absolute right-3 flex items-center gap-2">
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="ล้างคำค้นหา"
                    onClick={() => setSearchQuery('')}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                <span
                  title="จำนวนครั้งที่ระบบลบตัวอักษรภาษาไทยตัวแรกที่หลุดจากปืนบาร์โค้ดอัตโนมัติ"
                  className="rounded-[48px] border border-[#dadce0] bg-[#f8f9fa] px-3 py-1 text-xs text-[#5f6368] tabular-nums-google"
                >
                  กันคีย์ไทย {rollbackCount}
                </span>
              </div>
            </div>

            {/* Category Filter Pills (48px pill radius, minimum 44px touch height) */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedCategoryId('ALL')}
                className={`min-h-[44px] shrink-0 rounded-[48px] border px-5 font-google-display text-sm font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                  selectedCategoryId === 'ALL'
                    ? 'border-[#1a73e8] bg-[#1a73e8] text-white'
                    : 'border-[#dadce0] bg-white text-[#3c4043] hover:border-[#1a73e8] hover:text-[#1a73e8]'
                }`}
              >
                รายการขายทั้งหมด
              </button>
              {bootstrap.categories.map((cat) => {
                const active = selectedCategoryId === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(cat.id)}
                    className={`min-h-[44px] shrink-0 rounded-[48px] border px-5 font-google-display text-sm font-medium tracking-[0.25px] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                      active
                        ? 'border-[#1a73e8] bg-[#1a73e8] text-white'
                        : 'border-[#dadce0] bg-white text-[#3c4043] hover:border-[#1a73e8] hover:text-[#1a73e8]'
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
            <div className="rounded-[4px] border border-[#dadce0] bg-white py-16 px-6 text-center space-y-3">
              <Search className="h-9 w-9 text-[#80868b] mx-auto" />
              <p className="font-google-display text-[20px] font-normal text-[#202124]">
                {searchQuery.trim() || selectedCategoryId !== 'ALL'
                  ? 'ไม่พบสินค้าที่ตรงกับคำค้นหาหรือหมวดหมู่นี้'
                  : 'ยังไม่มีรายการสินค้าในระบบ'}
              </p>
              <p className="text-sm text-[#5f6368]">
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
                  className="h-[44px] rounded-[48px] border border-[#dadce0] bg-white px-6 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
                >
                  ล้างคำค้นหา / ตัวกรอง
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
              {sellableCatalog.map((item) => {
                const lowStock =
                  !item.isComposite && item.inStockMilli <= item.lowStockThresholdMilli;
                const inCartQty = inCartQtyByVariant.get(item.id) ?? 0;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleProductSelect(item)}
                    className={`group flex flex-col justify-between overflow-hidden rounded-[4px] border bg-white text-left transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                      inCartQty > 0
                        ? 'border-[#1a73e8]'
                        : 'border-[#dadce0] hover:border-[#1a73e8]'
                    }`}
                  >
                    <div className="w-full">
                      <ProductEditorialArtwork item={item} inCartQtyMilli={inCartQty} />

                      {/* Canonical 24px (p-6) card-photo content padding */}
                      <div className="p-6 pb-4">
                        <h3 className="font-google-display text-[20px] font-normal leading-[28px] tracking-normal text-[#202124] line-clamp-2">
                          {item.itemName}
                        </h3>
                        <p className="mt-1 text-[14px] leading-[20px] text-[#5f6368]">
                          {item.isComposite && !item.useProduction
                            ? 'ตัดวัตถุดิบสดตามสูตร Multi-Level BOM'
                            : lowStock
                              ? `สต็อกใกล้หมด · เหลือ ${formatMilliUnitsToQtyString(item.inStockMilli, item.unitName)}`
                              : `คงเหลือ ${formatMilliUnitsToQtyString(item.inStockMilli, item.unitName)}`}
                        </p>
                      </div>
                    </div>

                    <div className="px-6 pb-5 pt-2 flex items-center justify-between">
                      <span className="font-google-display text-[24px] font-normal tracking-[-0.25px] text-[#202124] tabular-nums-google">
                        ฿{formatSatangToThbString(item.priceSatang)}
                        {item.isWeightedScale && (
                          <span className="text-sm text-[#5f6368] ml-1">/ {item.unitName}</span>
                        )}
                      </span>
                      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[#dadce0] text-[#1a73e8] transition-colors duration-200 group-hover:border-[#1a73e8] group-hover:bg-[#1a73e8] group-hover:text-white">
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
          <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="border-b border-[#dadce0] bg-[#f8f9fa] px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-[#3c4043]">
                <ScanBarcode className="h-4 w-4 text-[#1a73e8]" />
                <span>คลิกแถวสินค้าเพื่อเพิ่มลงบิลทันที (×{scanMultiplier}) หรือยิงปืนบาร์โค้ดต่อเนื่อง</span>
              </div>

              {bootstrap.featureFlags.enableScaleBarcodeParser && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onScanBarcodeString('2010045012505', 1)}
                    className="min-h-[38px] rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] transition-colors duration-200 cursor-pointer"
                  >
                    + สแกนตราชั่ง 1.250 กก. (Prefix 20)
                  </button>
                  <button
                    type="button"
                    onClick={() => onScanBarcodeString('2510045225009', 1)}
                    className="min-h-[38px] rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] transition-colors duration-200 cursor-pointer"
                  >
                    + สแกนป้ายฝังราคา ฿225 (Prefix 25)
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[#dadce0] bg-[#f8f9fa] text-xs font-medium text-[#5f6368]">
                  <tr>
                    <th className="py-3.5 px-5">รหัสบาร์โค้ด / SKU</th>
                    <th className="py-3.5 px-5">ชื่อสินค้า</th>
                    <th className="py-3.5 px-5">หมวดหมู่</th>
                    <th className="py-3.5 px-5 text-right">สต็อกคงเหลือ</th>
                    <th className="py-3.5 px-5 text-right">ราคาขาย</th>
                    <th className="py-3.5 px-5 text-right">เพิ่มลงบิล</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#dadce0]">
                  {sellableCatalog.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-14 text-center text-sm text-[#5f6368]">
                        {searchQuery.trim() || selectedCategoryId !== 'ALL'
                          ? 'ไม่พบรายการสินค้าที่ตรงกับคำค้นหา'
                          : 'ยังไม่มีรายการสินค้าในระบบ — กรุณาเพิ่มสินค้าในแท็บ “คลังสินค้า & PO”'}
                      </td>
                    </tr>
                  ) : (
                    sellableCatalog.map((item) => {
                      const inCartQty = inCartQtyByVariant.get(item.id) ?? 0;
                      return (
                        <tr
                          key={item.id}
                          onClick={() => handleProductSelect(item)}
                          className="hover:bg-[#f8f9fa] transition-colors duration-150 cursor-pointer"
                        >
                          <td className="py-3.5 px-5 tabular-nums-google">
                            <div className="text-sm text-[#202124]">{item.barcode ?? '—'}</div>
                            <div className="text-xs text-[#5f6368]">{item.sku}</div>
                          </td>
                          <td className="py-3.5 px-5">
                            <div className="font-google-display text-[16px] font-medium text-[#202124] flex items-center gap-2">
                              <span>{item.itemName}</span>
                              {inCartQty > 0 && (
                                <span className="rounded-[48px] bg-[#1a73e8] px-2.5 py-0.5 text-[11px] font-medium text-white tabular-nums-google">
                                  ×{item.isWeightedScale ? formatMilliUnitsToQtyString(inCartQty) : Math.round(inCartQty / 1000)}
                                </span>
                              )}
                            </div>
                            {item.isWeightedScale && (
                              <div className="text-xs text-[#5f6368] flex items-center gap-1 mt-0.5">
                                <Scale className="h-3 w-3 text-[#1a73e8]" /> รองรับบาร์โค้ดชั่งน้ำหนักสด EAN-13
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-5 text-xs text-[#5f6368]">{item.categoryName}</td>
                          <td className="py-3.5 px-5 text-right text-sm text-[#3c4043] tabular-nums-google">
                            {item.isComposite && !item.useProduction
                              ? 'ตัดตามสูตร'
                              : formatMilliUnitsToQtyString(item.inStockMilli, item.unitName)}
                          </td>
                          <td className="py-3.5 px-5 text-right font-google-display text-[18px] font-normal text-[#202124] tabular-nums-google">
                            ฿{formatSatangToThbString(item.priceSatang)}
                          </td>
                          <td className="py-3.5 px-5 text-right">
                            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#dadce0] text-[#1a73e8]">
                              <Plus className="h-4 w-4" />
                            </span>
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
          <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="border-b border-[#dadce0] bg-[#f8f9fa] px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
                  รายการบิลที่พักไว้ชั่วคราว (Held Bills)
                </h3>
                <p className="text-sm text-[#5f6368]">
                  พักบิลลูกค้าที่รอเพื่อนหรือหยิบของเพิ่มโดยไม่ขวางคิวหน้าเคาน์เตอร์ (ปุ่มลัด F8)
                </p>
              </div>
            </div>

            {heldBills.length === 0 ? (
              <div className="py-16 text-center px-6">
                <PauseCircle className="h-10 w-10 text-[#80868b] mx-auto mb-3" />
                <p className="font-google-display text-[18px] text-[#202124]">
                  ไม่มีรายการบิลที่พักไว้ขณะนี้
                </p>
                <p className="text-sm text-[#5f6368] mt-1">
                  เมื่อมีสินค้าในตะกร้า สามารถกดปุ่ม &ldquo;พักบิล (F8)&rdquo; เพื่อเก็บรายการไว้ชั่วคราวได้ทันที
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#dadce0]">
                {heldBills.map((h) => (
                  <div
                    key={h.id}
                    className="p-6 flex flex-wrap items-center justify-between gap-4 hover:bg-[#f8f9fa] transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-google-display text-[20px] font-normal text-[#202124]">
                          {h.referenceLabel}
                        </span>
                        <span className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] px-2 py-0.5 text-xs text-[#5f6368]">
                          {h.orderType}
                        </span>
                      </div>
                      <p className="text-sm text-[#5f6368]">
                        {h.cart.map((c) => c.itemName).join(', ')}
                      </p>
                      <div className="text-xs text-[#80868b] flex items-center gap-2">
                        <Clock className="h-3.5 w-3.5" />
                        <span>พักเมื่อ {new Date(h.heldAtIso).toLocaleTimeString('th-TH')}</span>
                        <span>·</span>
                        <span>โดย {h.heldByName}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="text-right mr-2">
                        <div className="text-xs text-[#5f6368]">ยอดสุทธิ</div>
                        <div className="font-google-display text-[24px] font-normal text-[#202124] tabular-nums-google">
                          ฿{formatSatangToThbString(h.totalSatang)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setHeldBills((prev) => prev.filter((item) => item.id !== h.id))
                        }
                        className="h-[46px] rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-sm font-medium text-[#5f6368] hover:text-[#202124] cursor-pointer"
                      >
                        ลบทิ้ง
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRecallHeldBill(h)}
                        className="flex h-[46px] items-center gap-2 rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
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
        {/* SUB-VIEW 4: COMPLETED RECEIPTS, REPRINT & HISTORICAL-COST VOID      */}
        {/* ================================================================== */}
        {posSubView === 'ORDER_HISTORY' && (
          <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="border-b border-[#dadce0] bg-[#f8f9fa] px-6 py-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
                  ประวัติใบเสร็จรับเงิน &amp; ใบกำกับภาษีอย่างย่อ (ABB)
                </h3>
                <p className="text-sm text-[#5f6368]">
                  รองรับการพิมพ์ใบเสร็จซ้ำ และการยกเลิกบิล (Void) โดยคืนสต็อกตามต้นทุนจริง ณ เวลาขาย
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[#dadce0] bg-[#f8f9fa] text-xs font-medium text-[#5f6368]">
                  <tr>
                    <th className="py-3.5 px-5">เลขที่ใบเสร็จ / ABB</th>
                    <th className="py-3.5 px-5">รายการที่ขาย</th>
                    <th className="py-3.5 px-5">วิธีชำระ</th>
                    <th className="py-3.5 px-5 text-right">ยอดสุทธิ</th>
                    <th className="py-3.5 px-5 text-center">สถานะ</th>
                    <th className="py-3.5 px-5 text-right">การทำงาน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#dadce0]">
                  {bootstrap.recentOrders.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-14 text-center text-[#5f6368]">
                        ยังไม่มีรายการขายในกะนี้
                      </td>
                    </tr>
                  ) : (
                    bootstrap.recentOrders.map((ord) => (
                      <tr key={ord.salesOrderId} className="hover:bg-[#f8f9fa]">
                        <td className="py-3.5 px-5 tabular-nums-google">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-[#202124]">{ord.receiptNumber}</span>
                            {ord.tableOrQueueNo && (
                              <span className="rounded-[48px] bg-[#e8f0fe] px-2 py-0.5 text-[11px] font-medium text-[#1a73e8]">
                                {ord.tableOrQueueNo}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-[#5f6368]">
                            {ord.abbTaxInvoiceNo ?? '—'} · {ord.orderType}
                          </div>
                        </td>
                        <td className="py-3.5 px-5">
                          <div className="text-[#202124] max-w-xs truncate">
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
                          <div className="text-xs text-[#5f6368]">
                            โดย {ord.cashierName} ·{' '}
                            {new Date(ord.createdAt).toLocaleTimeString('th-TH')}
                          </div>
                          {ord.status === 'VOIDED' && ord.voidReason && (
                            <div className="text-[11px] text-[#202124] mt-0.5">
                              เหตุผลยกเลิก: {ord.voidReason}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-5 text-xs text-[#3c4043] tabular-nums-google">
                          <div>{ord.paymentSummaryLabel || ord.paymentMethod}</div>
                          {ord.payments && ord.payments.length > 1 ? (
                            <div className="text-[11px] text-[#5f6368] space-y-0.5 mt-0.5">
                              {ord.payments.map((p, idx) => (
                                <div key={`${p.paymentMethod}-${idx}`}>
                                  • {p.paymentMethod}: ฿{formatSatangToThbString(p.amountSatang)}
                                  {p.slipTransRefLast4 ? ` (Ref *${p.slipTransRefLast4})` : ''}
                                </div>
                              ))}
                            </div>
                          ) : (
                            ord.slipTransRefLast4 && (
                              <div className="text-[#5f6368]">Ref *{ord.slipTransRefLast4}</div>
                            )
                          )}
                        </td>
                        <td className="py-3.5 px-5 text-right font-google-display text-[18px] text-[#202124] tabular-nums-google">
                          ฿{formatSatangToThbString(ord.totalSatang)}
                        </td>
                        <td className="py-3.5 px-5 text-center">
                          <span
                            className={`inline-block rounded-[4px] border px-2.5 py-0.5 text-xs font-medium ${
                              ord.status === 'COMPLETED'
                                ? 'border-[#dadce0] bg-[#f8f9fa] text-[#202124]'
                                : 'border-[#dadce0] bg-[#f8f9fa] text-[#5f6368] line-through'
                            }`}
                          >
                            {ord.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-5 text-right space-x-2">
                          <button
                            type="button"
                            onClick={() =>
                              void handleReprintOrder(
                                ord.salesOrderId,
                                ord.receiptNumber,
                                ord.abbTaxInvoiceNo
                              )
                            }
                            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
                          >
                            <Printer className="h-3.5 w-3.5" /> พิมพ์ซ้ำ
                          </button>
                          {ord.status === 'COMPLETED' && (
                            <button
                              type="button"
                              onClick={() =>
                                void handleVoidOrder(ord.salesOrderId, ord.receiptNumber)
                              }
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#3c4043] hover:border-[#202124] hover:text-[#202124] cursor-pointer"
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
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          {/* 1. CANONICAL NEAR-BLACK HERO BAND (`#000000` hero-bg, weight-400 -0.5px display!) */}
          <div className="bg-[#000000] px-6 py-6 text-white">
            <div className="flex items-center justify-between text-xs text-[#80868b]">
              <span className="font-google-display uppercase tracking-[0.5px] text-white/75">
                ยอดชำระสุทธิ · {cartSummary.totalItemUnitsCount} รายการ
              </span>
              {lastPrintedReceipt && (
                <button
                  type="button"
                  onClick={() => setReceiptModalOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-[48px] border border-white/25 px-3 py-1 font-google-display text-xs text-white hover:border-white cursor-pointer"
                >
                  <Printer className="h-3.5 w-3.5" /> ใบเสร็จล่าสุด
                </button>
              )}
            </div>

            {/* Canonical Google Display-LG: 48px, weight 400, -0.5px letter-spacing */}
            <div className="mt-2 font-google-display text-[48px] font-normal leading-[56px] tracking-[-0.5px] text-white tabular-nums-google">
              ฿{formatSatangToThbString(cartSummary.totalSatang)}
            </div>

            {/* Order Context Controls on Hero Band */}
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <select
                aria-label="รูปแบบออเดอร์"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as CheckoutOrderRequest['orderType'])}
                className="h-10 rounded-[4px] border border-white/20 bg-white/10 px-3 text-xs font-medium text-white focus:border-[#1a73e8] focus:outline-none cursor-pointer"
              >
                <option value="TAKEAWAY" className="bg-white text-[#202124]">
                  สั่งกลับบ้าน (Takeaway)
                </option>
                <option value="DINE_IN" className="bg-white text-[#202124]">
                  ทานที่ร้าน (Dine-In)
                </option>
                <option value="RETAIL" className="bg-white text-[#202124]">
                  ขายปลีกหน้าร้าน (Retail)
                </option>
                <option value="DELIVERY" className="bg-white text-[#202124]">
                  เดลิเวอรี (Delivery)
                </option>
              </select>

              <input
                type="text"
                aria-label="หมายเลขโต๊ะหรือป้ายคิว"
                value={queueOrTableLabel}
                onChange={(e) => setQueueOrTableLabel(e.target.value)}
                placeholder="ป้ายคิว / โต๊ะ (เช่น A-04)"
                className="h-10 rounded-[4px] border border-white/20 bg-white/10 px-3 text-xs text-white placeholder:text-white/50 focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
          </div>

          {/* 2. CART LINE ITEMS ON PURE WHITE CANVAS */}
          <div className="divide-y divide-[#dadce0] max-h-[360px] min-h-[220px] overflow-y-auto bg-white">
            {cartSummary.lines.length === 0 ? (
              <div className="py-16 px-6 text-center">
                <ScanBarcode className="h-9 w-9 text-[#dadce0] mx-auto mb-2.5" />
                <p className="font-google-display text-[18px] font-normal text-[#202124]">
                  พร้อมรับรายการขายใหม่
                </p>
                <p className="text-sm text-[#5f6368] mt-1">
                  แตะเลือกสินค้าด้านซ้าย หรือยิงบาร์โค้ดเข้าสู่รายการขายทันที
                </p>
              </div>
            ) : (
              cartSummary.lines.map((line) => {
                const isEditingQty = editingCartKey === line.cartKey;
                return (
                  <div key={line.cartKey} className="px-5 py-3.5 hover:bg-[#f8f9fa] transition-colors">
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
                          className="font-google-display text-[16px] font-medium text-[#202124] hover:text-[#1a73e8] text-left cursor-pointer"
                        >
                          {line.itemName}
                        </button>

                        {line.mods.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {line.mods.map((m) => (
                              <span
                                key={m.id}
                                className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] px-2 py-0.5 text-xs text-[#5f6368]"
                              >
                                {m.name}
                                {m.priceDeltaSatang > 0
                                  ? ` +฿${formatSatangToThbString(m.priceDeltaSatang)}`
                                  : ''}
                              </span>
                            ))}
                          </div>
                        )}

                        {line.scaleBadgeText && (
                          <div className="mt-1 text-xs text-[#1a73e8]">{line.scaleBadgeText}</div>
                        )}
                      </div>

                      <div className="text-right shrink-0 tabular-nums-google">
                        <div className="font-google-display text-[18px] font-normal text-[#202124]">
                          ฿{formatSatangToThbString(line.lineTotalSatang)}
                        </div>
                        <div className="text-xs text-[#5f6368]">
                          @฿{formatSatangToThbString(line.effectiveUnitSatang)}/{line.unitName}
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
                                    ? { ...c, quantityMilli: c.quantityMilli - step }
                                    : c
                                )
                                .filter((c) => c.quantityMilli > 0)
                            );
                          }}
                          className="flex h-[40px] w-[40px] items-center justify-center rounded-full border border-[#dadce0] bg-white text-[#202124] hover:border-[#1a73e8] hover:text-[#1a73e8] cursor-pointer"
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
                                        ? { ...c, quantityMilli: parsedMilli }
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
                              autoFocus
                              value={editingQtyInput}
                              onChange={(e) => setEditingQtyInput(e.target.value)}
                              className="h-9 w-20 rounded-[4px] border border-[#1a73e8] bg-white px-2 text-center text-sm text-[#202124] tabular-nums-google focus:outline-none"
                            />
                            <button
                              type="submit"
                              className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1a73e8] text-white cursor-pointer"
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
                            className="min-w-[78px] rounded-[4px] border border-transparent px-2 py-1 text-center font-google-display text-sm font-medium text-[#202124] hover:border-[#dadce0] tabular-nums-google cursor-pointer"
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
                                  ? { ...c, quantityMilli: c.quantityMilli + step }
                                  : c
                              )
                            );
                          }}
                          className="flex h-[40px] w-[40px] items-center justify-center rounded-full border border-[#dadce0] bg-white text-[#202124] hover:border-[#1a73e8] hover:text-[#1a73e8] cursor-pointer"
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
                        className="flex h-[40px] w-[40px] items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer"
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
          <div className="p-4 bg-white border-t border-[#dadce0] space-y-4">
            <div className="rounded-[8px] bg-[#e8f0fe] p-4 space-y-2.5 text-sm text-[#202124]">
              <div className="flex items-center justify-between">
                <span className="text-[#3c4043]">ยอดรวมสินค้า (Subtotal)</span>
                <span className="font-medium tabular-nums-google">
                  ฿{formatSatangToThbString(cartSummary.subtotalSatang)}
                </span>
              </div>

              {/* Discount Row with Baht / Percent Toggle */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#3c4043] flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5 text-[#1a73e8]" />
                  ส่วนลด (F9)
                </span>
                <div className="flex items-center gap-1.5">
                  <div className="inline-flex rounded-[48px] border border-[#dadce0] bg-white p-0.5">
                    <button
                      type="button"
                      onClick={() => setDiscountMode('BAHT')}
                      className={`rounded-[48px] px-2.5 py-0.5 text-xs font-medium cursor-pointer ${
                        discountMode === 'BAHT'
                          ? 'bg-[#1a73e8] text-white'
                          : 'text-[#5f6368]'
                      }`}
                    >
                      ฿
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscountMode('PERCENT')}
                      className={`rounded-[48px] px-2.5 py-0.5 text-xs font-medium cursor-pointer ${
                        discountMode === 'PERCENT'
                          ? 'bg-[#1a73e8] text-white'
                          : 'text-[#5f6368]'
                      }`}
                    >
                      %
                    </button>
                  </div>
                  <input
                    ref={discountInputRef}
                    type="text"
                    aria-label="ส่วนลดท้ายบิล"
                    value={discountInput}
                    onChange={(e) => setDiscountInput(e.target.value)}
                    className="h-8 w-20 rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-right text-sm text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                  />
                </div>
              </div>

              {/* Tax Mode & VAT 7% Readout */}
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#1a73e8]/15 text-xs text-[#3c4043]">
                <select
                  aria-label="โหมดภาษีมูลค่าเพิ่ม"
                  value={taxMode}
                  onChange={(e) => setTaxMode(e.target.value as TaxMode)}
                  className="rounded-[4px] border border-[#dadce0] bg-white px-2 py-1 text-xs text-[#202124] focus:border-[#1a73e8] focus:outline-none cursor-pointer"
                >
                  <option value="INCLUSIVE">VAT 7% รวมในราคา</option>
                  <option value="EXCLUSIVE">VAT 7% แยกนอก</option>
                  <option value="NONE">ยกเว้น VAT (0%)</option>
                </select>
                <span className="tabular-nums-google">
                  ฐาน ฿{formatSatangToThbString(cartSummary.netBeforeTaxSatang)} · VAT ฿
                  {formatSatangToThbString(cartSummary.taxSatang)}
                </span>
              </div>
            </div>

            {/* 4. CANONICAL 48px PILL CTA DOCK (`button-primary` #1a73e8 + `button-secondary` #ffffff) */}
            <div className="space-y-2.5">
              <button
                type="button"
                disabled={cart.length === 0 || processingCheckout}
                onClick={() => void openCheckoutModal('CASH')}
                className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white transition-colors duration-200 hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] focus-visible:ring-offset-2"
              >
                <Banknote className="h-5 w-5" />
                <span>
                  ชำระเงิน / แยกจ่าย · ฿{formatSatangToThbString(cartSummary.totalSatang)} (F10)
                </span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={cart.length === 0 || processingCheckout}
                  onClick={() => void executeFinalCheckout('CASH', undefined, true)}
                  className="flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-[#1a73e8] bg-[#e8f0fe]/60 px-3 font-google-display text-xs font-medium tracking-[0.25px] text-[#1a73e8] transition-colors duration-200 hover:bg-[#e8f0fe] disabled:opacity-40 cursor-pointer"
                >
                  <Banknote className="h-4 w-4" />
                  <span>รับเงินสดด่วน (F12)</span>
                </button>

                <button
                  type="button"
                  disabled={cart.length === 0 || processingCheckout}
                  onClick={() => void openCheckoutModal('SPLIT')}
                  className="flex h-[44px] items-center justify-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-3 font-google-display text-xs font-medium tracking-[0.25px] text-[#202124] transition-colors duration-200 hover:border-[#1a73e8] hover:text-[#1a73e8] disabled:opacity-40 cursor-pointer"
                >
                  <Layers className="h-4 w-4 text-[#1a73e8]" />
                  <span>แยกจ่าย (เงินสด + QR/บัตร)</span>
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={cart.length === 0}
                  onClick={() => void openCheckoutModal('PROMPTPAY_QR')}
                  className="flex h-[42px] items-center justify-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-3 font-google-display text-xs font-medium tracking-[0.25px] text-[#1a73e8] transition-colors duration-200 hover:border-[#1a73e8] hover:bg-[#f8f9fa] disabled:opacity-40 cursor-pointer"
                >
                  <QrCode className="h-4 w-4" />
                  <span>Thai QR</span>
                </button>

                <button
                  type="button"
                  onClick={handleHoldCurrentBill}
                  className="flex h-[42px] items-center justify-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-3 font-google-display text-xs font-medium tracking-[0.25px] text-[#1a73e8] transition-colors duration-200 hover:border-[#1a73e8] hover:bg-[#f8f9fa] cursor-pointer"
                >
                  <PauseCircle className="h-4 w-4" />
                  <span>พักบิล {heldBills.length > 0 ? `(${heldBills.length})` : '(F8)'}</span>
                </button>

                <button
                  type="button"
                  disabled={cart.length === 0}
                  onClick={() => {
                    setCart([]);
                    setDiscountInput('0');
                  }}
                  className="flex h-[42px] items-center justify-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-3 font-google-display text-xs font-medium tracking-[0.25px] text-[#5f6368] transition-colors duration-200 hover:border-[#202124] hover:text-[#202124] disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>ล้างบิล</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ==================================================================== */}
      {/* DIALOG 1: CAFE ROLE-BASED MODIFIER CUSTOMIZER (Google Clean Spec)    */}
      {/* ==================================================================== */}
      {customizingVariant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-[8px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#dadce0] px-6 py-4">
              <div>
                <h3 className="font-google-display text-[22px] font-normal text-[#202124]">
                  {customizingVariant.itemName}
                </h3>
                <p className="text-xs text-[#5f6368] flex items-center gap-1.5 mt-0.5">
                  <Sparkles className="h-3.5 w-3.5 text-[#1a73e8]" />
                  ปรับสัดส่วนวัตถุดิบอัตโนมัติตามบทบาทในสูตร (Stock-Aware Modifiers)
                </p>
              </div>
              <button
                type="button"
                aria-label="ปิดหน้าต่างตัวเลือกเสริม"
                onClick={() => setCustomizingVariant(null)}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 max-h-[68vh] overflow-y-auto">
              {bootstrap.modifierGroups.map((group) => (
                <div key={group.id} className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-google-display text-sm font-medium text-[#202124]">
                      {group.name}
                    </span>
                    <span className="text-xs text-[#5f6368]">
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
                          className={`min-h-[68px] rounded-[4px] border p-3.5 text-left transition-colors duration-150 cursor-pointer ${
                            active
                              ? 'border-[#1a73e8] bg-[#e8f0fe]/60 text-[#202124]'
                              : 'border-[#dadce0] bg-white text-[#3c4043] hover:border-[#1a73e8]'
                          }`}
                        >
                          <div className="font-google-display text-sm font-medium text-[#202124]">
                            {mod.name}
                          </div>
                          <div className="text-xs text-[#1a73e8] mt-1 tabular-nums-google">
                            {mod.priceDeltaSatang > 0
                              ? `+฿${formatSatangToThbString(mod.priceDeltaSatang)}`
                              : mod.priceDeltaSatang < 0
                                ? `-฿${formatSatangToThbString(Math.abs(mod.priceDeltaSatang))}`
                                : 'ไม่เพิ่มราคา'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-3 border-t border-[#dadce0]">
                <span className="font-google-display text-sm font-medium text-[#202124]">
                  จำนวน ({customizingVariant.unitName})
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setDraftQtyInput((prev) => String(Math.max(1, Number(prev || '1') - 1)))
                    }
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-[#dadce0] text-[#202124] hover:border-[#1a73e8] cursor-pointer"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    type="text"
                    aria-label="จำนวนแก้ว"
                    value={draftQtyInput}
                    onChange={(e) => setDraftQtyInput(e.target.value)}
                    className="h-11 w-20 rounded-[4px] border border-[#dadce0] text-center font-google-display text-base text-[#202124] tabular-nums-google"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setDraftQtyInput((prev) => String(Math.max(1, Number(prev || '1') + 1)))
                    }
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-[#dadce0] text-[#202124] hover:border-[#1a73e8] cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="border-t border-[#dadce0] bg-[#f8f9fa] px-6 py-4 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setCustomizingVariant(null)}
                className="h-[50px] rounded-[48px] border border-[#dadce0] bg-white px-6 font-google-display text-[15px] font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
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
                    addVariantToCartDirect(customizingVariant, qtyMilli, draftModIds);
                    setCustomizingVariant(null);
                  } catch {
                    onToast('รูปแบบจำนวนสินค้าไม่ถูกต้อง', 'error');
                  }
                }}
                className="h-[50px] rounded-[48px] bg-[#1a73e8] px-8 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
              >
                เพิ่มลงรายการขาย · ฿
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
                  return formatSatangToThbString(lineTotal);
                })()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* DIALOG 2: GOOGLE-SPEC TOUCH CASH NUMPAD + EMVCO QR + SPLIT PAYMENT   */}
      {/* ==================================================================== */}
      {checkoutModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-4xl rounded-[8px] border border-[#dadce0] bg-white overflow-hidden">
            {/* Top Bar */}
            <div className="flex items-center justify-between border-b border-[#dadce0] px-6 h-16 overflow-x-auto">
              <div className="flex items-center gap-5 h-full shrink-0">
                {[
                  { id: 'CASH' as const, label: 'เงินสด (Cash + RJ11)', icon: Banknote },
                  { id: 'PROMPTPAY_QR' as const, label: 'Thai QR PromptPay', icon: QrCode },
                  { id: 'CARD' as const, label: 'บัตรเครดิต / EDC', icon: CreditCard },
                  { id: 'SPLIT' as const, label: 'แยกจ่าย (เงินสด + QR/บัตร)', icon: Layers },
                ].map((t) => {
                  const Icon = t.icon;
                  const active = paymentTab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setPaymentTab(t.id);
                        setSlipVerificationModal(null);
                        if (t.id === 'PROMPTPAY_QR') {
                          void loadPromptPayQr();
                        } else if (
                          t.id === 'SPLIT' &&
                          splitSecondMethod === 'PROMPTPAY_QR' &&
                          splitRemainingSatang > 0
                        ) {
                          void loadPromptPayQr(splitRemainingSatang);
                        }
                      }}
                      className={`relative flex h-full items-center gap-2 px-1 font-google-display text-[14px] font-medium tracking-[0.25px] cursor-pointer whitespace-nowrap ${
                        active ? 'text-[#202124]' : 'text-[#5f6368] hover:text-[#202124]'
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${active ? 'text-[#1a73e8]' : ''}`} />
                      <span>{t.label}</span>
                      {active && (
                        <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                aria-label="ปิดหน้าต่างรับชำระเงิน"
                onClick={() => setCheckoutModalOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer shrink-0"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12">
              {/* Left Summary Column: Black Hero Total + VAT Breakdown */}
              <div className="md:col-span-5 border-b md:border-b-0 md:border-r border-[#dadce0] bg-[#f8f9fa] flex flex-col justify-between">
                <div>
                  <div className="bg-[#000000] p-6 text-white">
                    <div className="text-xs uppercase tracking-[0.5px] text-white/70">
                      ยอดที่ต้องชำระสุทธิ
                    </div>
                    <div className="mt-1 font-google-display text-[44px] font-normal leading-[52px] tracking-[-0.5px] tabular-nums-google">
                      ฿{formatSatangToThbString(cartSummary.totalSatang)}
                    </div>
                  </div>

                  <div className="p-6 space-y-2.5 text-sm">
                    <div className="flex justify-between text-[#5f6368]">
                      <span>จำนวนสินค้า</span>
                      <span className="text-[#202124] tabular-nums-google">
                        {cartSummary.totalItemUnitsCount} รายการ
                      </span>
                    </div>
                    <div className="flex justify-between text-[#5f6368]">
                      <span>มูลค่าก่อนภาษี</span>
                      <span className="text-[#202124] tabular-nums-google">
                        ฿{formatSatangToThbString(cartSummary.netBeforeTaxSatang)}
                      </span>
                    </div>
                    <div className="flex justify-between text-[#5f6368]">
                      <span>ภาษีมูลค่าเพิ่ม 7%</span>
                      <span className="text-[#202124] tabular-nums-google">
                        ฿{formatSatangToThbString(cartSummary.taxSatang)}
                      </span>
                    </div>
                    {cartSummary.discountSatang > 0 && (
                      <div className="flex justify-between text-[#1a73e8]">
                        <span>ส่วนลดท้ายบิล</span>
                        <span className="tabular-nums-google">
                          -฿{formatSatangToThbString(cartSummary.discountSatang)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {paymentTab === 'CASH' && (
                  <div className="p-6 border-t border-[#dadce0] bg-white">
                    <div className="text-xs text-[#5f6368]">เงินทอนลูกค้า (Change Due)</div>
                    <div className="mt-1 font-google-display text-[36px] font-normal leading-[44px] tracking-[-0.25px] text-[#1a73e8] tabular-nums-google">
                      ฿
                      {formatSatangToThbString(
                        Math.max(0, cashTenderedSatangPreview - cartSummary.totalSatang)
                      )}
                    </div>
                  </div>
                )}

                {paymentTab === 'SPLIT' && (
                  <div className="p-6 border-t border-[#dadce0] bg-white space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-[#5f6368]">ส่วนที่ 1 (เงินสด)</span>
                      <span className="font-google-display font-medium text-[#202124] tabular-nums-google">
                        ฿{formatSatangToThbString(splitCashSatang)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#5f6368]">
                        ส่วนที่ 2 ({splitSecondMethod === 'PROMPTPAY_QR' ? 'Thai QR' : 'บัตร EDC'})
                      </span>
                      <span className="font-google-display text-lg font-medium text-[#1a73e8] tabular-nums-google">
                        ฿{formatSatangToThbString(splitRemainingSatang)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Interactive Payment Surface */}
              <div className="md:col-span-7 p-6 bg-white max-h-[75vh] overflow-y-auto">
                {paymentTab === 'CASH' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-[#5f6368] mb-1.5">
                        รับเงินสดจากลูกค้า (บาท)
                      </label>
                      <input
                        type="text"
                        value={cashTenderedBahtInput}
                        onChange={(e) => {
                          setCashTenderedBahtInput(e.target.value);
                          setCashNumpadPristine(false);
                        }}
                        className="h-14 w-full rounded-[4px] border border-[#dadce0] bg-white px-4 font-google-display text-[28px] font-normal text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                      />
                    </div>

                    {/* Quick Thai Banknotes */}
                    <div className="flex flex-wrap gap-2">
                      {[
                        {
                          label: 'รับเงินพอดี',
                          val: formatSatangToThbString(cartSummary.totalSatang).replace(/,/g, ''),
                        },
                        { label: '฿100', val: '100.00' },
                        { label: '฿500', val: '500.00' },
                        { label: '฿1,000', val: '1000.00' },
                      ].map((b) => (
                        <button
                          key={b.label}
                          type="button"
                          onClick={() => {
                            setCashTenderedBahtInput(b.val);
                            setCashNumpadPristine(false);
                          }}
                          className="min-h-[40px] rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>

                    {/* 12-Key Touchscreen Numpad */}
                    <div className="grid grid-cols-3 gap-2">
                      {['7', '8', '9', '4', '5', '6', '1', '2', '3', 'CLEAR', '0', 'BACKSPACE'].map(
                        (k) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => handleCashNumpadPress(k)}
                            className="flex h-12 items-center justify-center rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] font-google-display text-[18px] font-normal text-[#202124] hover:border-[#1a73e8] hover:bg-white cursor-pointer"
                          >
                            {k === 'BACKSPACE' ? (
                              <Delete className="h-5 w-5 text-[#5f6368]" />
                            ) : k === 'CLEAR' ? (
                              <span className="text-xs font-medium text-[#5f6368]">ล้างค่า</span>
                            ) : (
                              k
                            )}
                          </button>
                        )
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={
                        processingCheckout || cashTenderedSatangPreview < cartSummary.totalSatang
                      }
                      onClick={() => void executeFinalCheckout('CASH')}
                      className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
                    >
                      {processingCheckout
                        ? 'กำลังบันทึกบิลและสั่งพิมพ์ใบเสร็จ...'
                        : 'ยืนยันรับเงินสด · เปิดลิ้นชัก & พิมพ์ใบกำกับภาษี ABB'}
                    </button>
                  </div>
                )}

                {paymentTab === 'PROMPTPAY_QR' && (
                  <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row items-center gap-5 rounded-[4px] border border-[#dadce0] p-4">
                      {qrDataUrl ? (
                        <img
                          src={qrDataUrl}
                          alt="Thai QR PromptPay Dynamic Code"
                          className="h-44 w-44 rounded-[4px] border border-[#dadce0] shrink-0"
                        />
                      ) : (
                        <div className="h-44 w-44 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] flex items-center justify-center text-xs text-[#5f6368] shrink-0">
                          กำลังสร้าง QR...
                        </div>
                      )}
                      <div className="space-y-1.5 text-sm">
                        <div className="font-google-display text-[18px] text-[#202124]">
                          สแกนจ่ายพร้อมเพย์ (Offline EMVCo Dynamic QR)
                        </div>
                        <p className="text-xs text-[#5f6368]">
                          ล็อกยอดเงินตรงตามบิลอัตโนมัติ คำนวณรหัสตรวจสอบ CRC16 ({qrCrcHex}) โดยไม่ต้องพึ่งอินเทอร์เน็ต
                        </p>
                        {qrPayloadText && (
                          <p className="text-[11px] text-[#80868b] break-all line-clamp-2">
                            {qrPayloadText}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <label className="block text-xs font-medium text-[#202124]">
                        ขั้นตอนป้องกันสลิปปลอม: ใช้ปืน 2D สแกน Mini-QR บนสลิปโอนเงินลูกค้า
                      </label>
                      <input
                        type="text"
                        value={slipMiniQrInput}
                        onChange={(e) => {
                          setSlipMiniQrInput(e.target.value);
                          setSlipVerificationModal(null);
                        }}
                        placeholder="วางหรือยิงข้อมูล BOT Mini-QR..."
                        className="h-11 w-full rounded-[4px] border border-[#dadce0] px-3.5 text-xs text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                      />

                      <div className="flex flex-wrap gap-2">
                        {SLIP_PRESETS.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            onClick={() => {
                              setSlipMiniQrInput(p.raw);
                              setSlipVerificationModal(null);
                            }}
                            className="rounded-[48px] border border-[#dadce0] bg-white px-3.5 py-1.5 text-xs text-[#3c4043] hover:border-[#1a73e8] hover:text-[#1a73e8] cursor-pointer"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>

                      {!slipVerificationModal?.valid ? (
                        <>
                          {slipVerificationModal && !slipVerificationModal.valid && (
                            <div className="rounded-[4px] border border-[#202124] bg-[#f8f9fa] p-3.5 flex items-start gap-2.5 text-xs text-[#202124]">
                              <ShieldAlert className="h-5 w-5 text-[#202124] shrink-0" />
                              <div>
                                <div className="font-medium">{slipVerificationModal.errorCode}</div>
                                <div className="text-[#5f6368] mt-0.5">
                                  {slipVerificationModal.errorMessageThai}
                                </div>
                              </div>
                            </div>
                          )}
                          <button
                            type="button"
                            disabled={processingCheckout}
                            onClick={() => void handleVerifySlipStep1()}
                            className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[15px] font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
                          >
                            ตรวจสอบโครงสร้างสลิป BOT Mini-QR (Step 1)
                          </button>
                        </>
                      ) : (
                        <div className="rounded-[8px] bg-[#e8f0fe] p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="inline-flex items-center gap-1.5 font-google-display text-sm font-medium text-[#1a73e8]">
                              <CheckCircle2 className="h-4 w-4" />
                              สลิปถูกต้องและไม่เคยถูกใช้ซ้ำ
                            </span>
                            <span className="text-xs font-medium text-[#202124] tabular-nums-google">
                              Ref *{slipVerificationModal.transRefLast4}
                            </span>
                          </div>
                          <div className="rounded-[4px] border border-[#dadce0] bg-white p-3">
                            <div className="text-xs text-[#5f6368]">ธนาคารต้นทาง</div>
                            <div className="font-google-display text-[18px] text-[#202124]">
                              {slipVerificationModal.bankDisplayNameThai}
                            </div>
                            <div className="mt-1.5 text-xs text-[#3c4043] flex items-center gap-1.5">
                              <AlertTriangle className="h-4 w-4 text-[#1a73e8] shrink-0" />
                              โปรดตรวจยอดเงินบนสลิปลูกค้าให้ตรงกับ{' '}
                              <strong>{slipVerificationModal.expectedAmountFormatted}</strong>
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={processingCheckout}
                            onClick={() =>
                              void executeFinalCheckout('PROMPTPAY_QR', slipMiniQrInput.trim())
                            }
                            className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
                          >
                            ยืนยันยอดเงินตรงกัน · ปิดการขาย &amp; พิมพ์ใบเสร็จ (Step 2)
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {paymentTab === 'CARD' && (
                  <div className="py-10 text-center space-y-5">
                    <Layers className="h-10 w-10 text-[#1a73e8] mx-auto" />
                    <div>
                      <div className="font-google-display text-[20px] text-[#202124]">
                        รับชำระผ่านเครื่องรูดบัตร EDC
                      </div>
                      <p className="text-sm text-[#5f6368] mt-1">
                        ตรวจสอบสลิปอนุมัติจากเครื่อง EDC ยอด{' '}
                        <strong className="text-[#202124]">
                          ฿{formatSatangToThbString(cartSummary.totalSatang)}
                        </strong>{' '}
                        ก่อนกดยืนยัน
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={processingCheckout}
                      onClick={() => void executeFinalCheckout('CARD')}
                      className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
                    >
                      ยืนยันรับชำระบัตรเครดิต &amp; พิมพ์ใบเสร็จ ABB
                    </button>
                  </div>
                )}

                {paymentTab === 'SPLIT' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-[#5f6368] mb-1.5">
                        ส่วนที่ 1: ยอดรับเงินสด (บาท)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={splitCashBahtInput}
                          onChange={(e) => {
                            setSplitCashBahtInput(e.target.value);
                            setSlipVerificationModal(null);
                          }}
                          className="h-12 flex-1 rounded-[4px] border border-[#dadce0] bg-white px-4 font-google-display text-[22px] text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                        />
                        {splitSecondMethod === 'PROMPTPAY_QR' && splitRemainingSatang > 0 && (
                          <button
                            type="button"
                            onClick={() => void loadPromptPayQr(splitRemainingSatang)}
                            className="rounded-[48px] border border-[#1a73e8] bg-[#e8f0fe] px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:bg-[#d2e3fc] cursor-pointer whitespace-nowrap"
                          >
                            อัปเดต QR ยอดคงเหลือ
                          </button>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {[
                          { label: '฿50', satang: 5_000 },
                          { label: '฿100', satang: 10_000 },
                          { label: '฿200', satang: 20_000 },
                          {
                            label: 'ครึ่งบิล',
                            satang: Math.floor(cartSummary.totalSatang / 200) * 100,
                          },
                        ]
                          .filter((x) => x.satang > 0 && x.satang < cartSummary.totalSatang)
                          .map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => {
                                setSplitCashBahtInput(
                                  formatSatangToThbString(preset.satang).replace(/,/g, '')
                                );
                                setSlipVerificationModal(null);
                                const rem = Math.max(0, cartSummary.totalSatang - preset.satang);
                                if (splitSecondMethod === 'PROMPTPAY_QR' && rem > 0) {
                                  void loadPromptPayQr(rem);
                                }
                              }}
                              className="rounded-[48px] border border-[#dadce0] bg-white px-3 py-1 text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
                            >
                              {preset.label}
                            </button>
                          ))}
                      </div>
                    </div>

                    <div className="border-t border-[#dadce0] pt-3 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-[#5f6368]">
                          ส่วนที่ 2: ชำระยอดคงเหลือ ฿{formatSatangToThbString(splitRemainingSatang)}{' '}
                          ด้วย
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
                            className={`rounded-[48px] border px-3.5 py-1.5 text-xs font-medium cursor-pointer ${
                              splitSecondMethod === 'PROMPTPAY_QR'
                                ? 'border-[#1a73e8] bg-[#1a73e8] text-white'
                                : 'border-[#dadce0] bg-white text-[#3c4043]'
                            }`}
                          >
                            Thai QR PromptPay
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSplitSecondMethod('CARD');
                              setSlipVerificationModal(null);
                            }}
                            className={`rounded-[48px] border px-3.5 py-1.5 text-xs font-medium cursor-pointer ${
                              splitSecondMethod === 'CARD'
                                ? 'border-[#1a73e8] bg-[#1a73e8] text-white'
                                : 'border-[#dadce0] bg-white text-[#3c4043]'
                            }`}
                          >
                            บัตรเครดิต / EDC
                          </button>
                        </div>
                      </div>

                      {splitSecondMethod === 'PROMPTPAY_QR' ? (
                        <div className="space-y-3">
                          <div className="flex items-center gap-4 rounded-[4px] border border-[#dadce0] p-3">
                            {qrDataUrl ? (
                              <img
                                src={qrDataUrl}
                                alt="Split PromptPay QR"
                                className="h-28 w-28 rounded-[4px] border border-[#dadce0] shrink-0"
                              />
                            ) : (
                              <div className="h-28 w-28 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] flex items-center justify-center text-[11px] text-[#5f6368] shrink-0">
                                กดอัปเดต QR
                              </div>
                            )}
                            <div className="text-xs space-y-1">
                              <div className="font-google-display text-sm font-medium text-[#202124]">
                                Thai QR ยอดส่วนที่ 2: ฿{formatSatangToThbString(splitRemainingSatang)}
                              </div>
                              <p className="text-[#5f6368]">
                                สแกน Mini-QR บนสลิปลูกค้าเพื่อป้องกันสลิปซ้ำ หรือกดตรวจสลิป Step 1
                              </p>
                            </div>
                          </div>

                          <input
                            type="text"
                            value={slipMiniQrInput}
                            onChange={(e) => {
                              setSlipMiniQrInput(e.target.value);
                              setSlipVerificationModal(null);
                            }}
                            placeholder="ข้อมูล BOT Mini-QR สำหรับส่วนที่ 2..."
                            className="h-10 w-full rounded-[4px] border border-[#dadce0] px-3 text-xs text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                          />

                          {!slipVerificationModal?.valid ? (
                            <button
                              type="button"
                              disabled={
                                processingCheckout ||
                                splitCashSatang <= 0 ||
                                splitRemainingSatang <= 0
                              }
                              onClick={() => void handleVerifySlipStep1(splitRemainingSatang)}
                              className="h-[48px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
                            >
                              ตรวจสลิป BOT Mini-QR (ยอด ฿
                              {formatSatangToThbString(splitRemainingSatang)})
                            </button>
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
                              className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[15px] font-medium text-white hover:bg-[#1967d2] cursor-pointer"
                            >
                              ยืนยันแยกจ่าย (เงินสด + Thai QR) · เปิดลิ้นชัก &amp; พิมพ์ใบเสร็จ
                            </button>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            processingCheckout || splitCashSatang <= 0 || splitRemainingSatang <= 0
                          }
                          onClick={() => void executeFinalCheckout('SPLIT')}
                          className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[15px] font-medium text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
                        >
                          ยืนยันแยกจ่าย (เงินสด + บัตร EDC) · เปิดลิ้นชัก &amp; พิมพ์ใบเสร็จ
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* DIALOG 3: 203-DPI CANVAS THAI RASTER & 80mm/58mm RECEIPT MODAL       */}
      {/* ==================================================================== */}
      {receiptModalOpen && lastPrintedReceipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-[8px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#dadce0] px-5 py-4">
              <div>
                <h3 className="font-google-display text-[18px] font-normal text-[#202124]">
                  ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ ({printPaperWidthMm}mm)
                </h3>
                <p className="text-xs text-[#5f6368]">
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
                className="flex h-9 w-9 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 203-DPI Raster vs Text & 80mm/58mm Toolbar */}
            <div className="border-b border-[#dadce0] bg-white px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="inline-flex rounded-[48px] border border-[#dadce0] p-0.5">
                <button
                  type="button"
                  onClick={() => setReceiptViewMode('CANVAS_203DPI')}
                  className={`rounded-[48px] px-3 py-1 font-medium cursor-pointer ${
                    receiptViewMode === 'CANVAS_203DPI'
                      ? 'bg-[#1a73e8] text-white'
                      : 'text-[#5f6368]'
                  }`}
                >
                  ฟอนต์ไทย 203-DPI (1-Bit)
                </button>
                <button
                  type="button"
                  onClick={() => setReceiptViewMode('TEXT')}
                  className={`rounded-[48px] px-3 py-1 font-medium cursor-pointer ${
                    receiptViewMode === 'TEXT' ? 'bg-[#1a73e8] text-white' : 'text-[#5f6368]'
                  }`}
                >
                  ข้อความ (Text)
                </button>
              </div>

              <div className="inline-flex rounded-[48px] border border-[#dadce0] p-0.5">
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
                    className={`rounded-[48px] px-3 py-1 font-medium cursor-pointer ${
                      printPaperWidthMm === w ? 'bg-[#202124] text-white' : 'text-[#5f6368]'
                    }`}
                  >
                    {w}mm
                  </button>
                ))}
              </div>
            </div>

            <div className="p-5 bg-[#f8f9fa] max-h-[60vh] overflow-y-auto flex justify-center">
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

            <div className="border-t border-[#dadce0] bg-white px-5 py-3.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="flex h-[42px] items-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
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
                  className="h-[42px] rounded-[48px] border border-[#dadce0] bg-white px-4 font-google-display text-xs font-medium text-[#3c4043] hover:border-[#202124] cursor-pointer"
                >
                  เตะลิ้นชัก RJ11
                </button>
              </div>
              <button
                type="button"
                onClick={() => setReceiptModalOpen(false)}
                className="h-[42px] rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
              >
                เสร็จสิ้น (บิลถัดไป)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
