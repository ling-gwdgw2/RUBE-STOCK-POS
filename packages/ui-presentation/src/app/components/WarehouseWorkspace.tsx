import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  Boxes,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Factory,
  FileSpreadsheet,
  FolderPlus,
  ImagePlus,
  PackagePlus,
  Plus,
  Printer,
  RefreshCw,
  ScanBarcode,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  Tag,
  Trash2,
  Truck,
  Upload,
  X,
} from 'lucide-react';
import {
  formatMilliUnitsToQtyString,
  parseDecimalStringToScaledInt,
} from '../../../../shared-contracts/src/fixed-point.ts';
import { formatMicroUnitCostForInput } from '../../../../shared-contracts/src/currency.ts';
import { PhysicalScannerStreamBuffer } from '../../hooks/usePhysicalScanner.ts';
import { generateValidInternalEan13 } from '../../../../hal-drivers/src/barcode/mod.ts';
import { posTransport, resolveBackendAssetUrl } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type {
  BootstrapPayload,
  CatalogVariantDetailDto,
  CategoryDto,
  ComponentRole,
  StaffUserDto,
} from '../types.ts';
import { compressImageFileToDataUrl } from '../utils/image-helper.ts';
import {
  getCategoriesForProfile,
  getCategoryDepartment,
  getDefaultCategoryForProfile,
  getDepartmentStationPreset,
  getDepartmentThaiLabel,
  getProfileMeta,
  isVariantInProfileDomain,
  type ShopCategoryDepartment,
} from '../utils/profile-domain.ts';
import { BarcodeCameraScannerModal } from './BarcodeCameraScannerModal.tsx';
import {
  BarcodeLabelPrintWorkspace,
  QuickBarcodePrintModal,
  type BarcodeQueueEntry,
} from './BarcodeLabelPrintWorkspace.tsx';
import { ConfirmDialog, ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface WarehouseWorkspaceProps {
  outletId?: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

type WmsSubTab =
  | 'CATALOG'
  | 'CATEGORIES'
  | 'MODIFIERS'
  | 'PO_LANDED'
  | 'PREP_BUILD'
  | 'STOCKTAKE_TRANSFER'
  | 'BARCODE_PRINT'
  | 'LEDGER';

export const WarehouseWorkspace: React.FC<WarehouseWorkspaceProps> = ({
  outletId = 'OUTLET-HQ',
  bootstrap,
  currentUser,
  onRefreshState,
  onToast,
}) => {
  const uid = useId();
  const {
    countryCode,
    currencyCode,
    dateTime,
    locale,
    money,
    moneyInput,
    parseMoney,
    unitCost,
    t,
    pick,
  } = useI18n();
  const isLaos = countryCode === 'LA';
  const [subTab, setSubTab] = useState<WmsSubTab>('CATALOG');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [warehouseScanInput, setWarehouseScanInput] = useState('');
  const [catalogFilterMode, setCatalogFilterMode] = useState<'ALL' | 'LOW_STOCK' | 'PAUSED'>(
    'ALL'
  );
  const [showOtherProfileItems, setShowOtherProfileItems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteMod, setConfirmDeleteMod] = useState<{
    kind: 'group' | 'item';
    id: string;
    name: string;
  } | null>(null);
  const [deletingMod, setDeletingMod] = useState(false);
  const [confirmDeleteVariant, setConfirmDeleteVariant] = useState<CatalogVariantDetailDto | null>(
    null
  );
  const [deletingVariant, setDeletingVariant] = useState(false);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<CategoryDto | null>(null);
  const [deletingCategory, setDeletingCategory] = useState(false);

  // Camera Scanner Modal (shared for Barcode scanning & Product Photo capture)
  const [cameraModal, setCameraModal] = useState<{
    mode: 'BARCODE' | 'PHOTO';
    target: 'CATALOG_SCAN' | 'MODAL_BARCODE' | 'MODAL_PHOTO';
  } | null>(null);

  // Category CRUD Form State
  const [catEditingId, setCatEditingId] = useState<string | null>(null);
  const [catNameInput, setCatNameInput] = useState('');
  const [catDeptInput, setCatDeptInput] = useState<ShopCategoryDepartment>(
    bootstrap.profile === 'HOSPITALITY' ? 'HOSPITALITY' : 'RETAIL'
  );
  const [inlineCatOpen, setInlineCatOpen] = useState(false);
  const [inlineCatName, setInlineCatName] = useState('');

  // Catalog Create/Edit Modal
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | undefined>(undefined);
  const [prodName, setProdName] = useState('');
  const [prodSku, setProdSku] = useState('');
  const [prodBarcode, setProdBarcode] = useState('');
  const [prodCategoryId, setProdCategoryId] = useState(
    getDefaultCategoryForProfile(bootstrap.categories, bootstrap.profile)?.id ?? 'CAT-RETAIL'
  );
  const [prodUnit, setProdUnit] = useState(getProfileMeta(bootstrap.profile, locale).defaultUnit);
  const [prodPriceBaht, setProdPriceBaht] = useState(() => (isLaos ? '35000' : '45.00'));
  const [prodCostBaht, setProdCostBaht] = useState(() => (isLaos ? '18000' : '22.0000'));
  const [prodInitStock, setProdInitStock] = useState('20.000');
  const [prodLowStock, setProdLowStock] = useState('5.000');
  const [prodIsComposite, setProdIsComposite] = useState(false);
  const [prodUseProduction, setProdUseProduction] = useState(false);
  const [prodIsScale, setProdIsScale] = useState(false);
  const [prodActive, setProdActive] = useState(true);
  const [prodImagePreviewUrl, setProdImagePreviewUrl] = useState<string | null>(null);
  const [prodImagePendingDataUrl, setProdImagePendingDataUrl] = useState<
    string | null | undefined
  >(undefined);
  const prodNameInputRef = useRef<HTMLInputElement | null>(null);
  const prodImageFileInputRef = useRef<HTMLInputElement | null>(null);
  const whScannerBufferRef = useRef<PhysicalScannerStreamBuffer>(
    new PhysicalScannerStreamBuffer(50, 5)
  );
  const whFirstKeySnapshotRef = useRef<{
    el: HTMLInputElement;
    value: string;
    selStart: number | null;
    selEnd: number | null;
  } | null>(null);

  // Quick Stock Adjustment Modal
  const [adjTarget, setAdjTarget] = useState<CatalogVariantDetailDto | null>(null);
  const [adjDeltaInput, setAdjDeltaInput] = useState('-1.000');
  const [adjReason, setAdjReason] = useState(
    pick('DAMAGED / ตัดของชำรุด', 'DAMAGED / ຕັດສິນຄ້າເປ່ເພ', 'DAMAGED / Write-off')
  );

  // Product Barcode Label Printing Queue & Quick Print Modal
  const [barcodeQueue, setBarcodeQueue] = useState<BarcodeQueueEntry[]>([]);
  const [quickBarcodeTarget, setQuickBarcodeTarget] = useState<CatalogVariantDetailDto | null>(
    null
  );
  const [lastReceivedPoBatch, setLastReceivedPoBatch] = useState<{
    poNumber: string;
    items: BarcodeQueueEntry[];
  } | null>(null);

  // Purchase Order Builder
  const [poSupplierId, setPoSupplierId] = useState(bootstrap.suppliers[0]?.id ?? 'SUP-001');
  const [poLines, setPoLines] = useState<
    Array<{ variantId: string; qtyInput: string; unitCostBahtInput: string }>
  >([
    { variantId: 'VAR-RET-002', qtyInput: '15.000', unitCostBahtInput: '125.0000' },
    { variantId: 'VAR-RAW-TEA', qtyInput: '5.000', unitCostBahtInput: '0.3200' },
  ]);
  const [poLandedCosts, setPoLandedCosts] = useState<
    Array<{
      costType: 'FREIGHT' | 'CUSTOMS_DUTY' | 'INSURANCE' | 'HANDLING' | 'OTHER';
      description: string;
      amountBahtInput: string;
    }>
  >(() => [
    {
      costType: 'FREIGHT',
      description: isLaos
        ? pick('ค่าขนส่งห้องเย็น (Cold-Chain Freight)', 'ຄ່າຂົນສົ່ງ (Cold-Chain Freight)', 'Cold-Chain Freight')
        : pick('ค่าขนส่งห้องเย็น (Cold-Chain Freight)', 'ຄ່າຂົນສົ່ງ (Cold-Chain Freight)', 'Cold-Chain Freight'),
      amountBahtInput: isLaos ? '50000' : '250.00',
    },
  ]);
  const [poPreviewLines, setPoPreviewLines] = useState<
    Awaited<ReturnType<typeof posTransport.previewPurchaseOrder>>['lines'] | null
  >(null);
  const [poHistory, setPoHistory] = useState<
    Awaited<ReturnType<typeof posTransport.listPoHistory>>['purchaseOrders']
  >([]);

  // Prep Production Build & Purchasable Variants
  const prepCandidates = bootstrap.catalogDetailed.filter((v) => v.useProduction);
  const purchasableVariants = bootstrap.catalogDetailed.filter(
    (v) => !v.isComposite || v.useProduction
  );
  const [prepVariantId, setPrepVariantId] = useState(
    prepCandidates[0]?.id ?? 'VAR-RAW-BOBA'
  );
  const [prepQtyInput, setPrepQtyInput] = useState('5.000');

  // Stocktake & Inter-Outlet Transfer
  const [stocktakeInputs, setStocktakeInputs] = useState<Record<string, string>>({});
  const [newOutletCode, setNewOutletCode] = useState('BR-02');
  const [newOutletName, setNewOutletName] = useState(
    pick('สาขาสยามสแควร์ (Branch 02)', 'ສາຂາໃໝ່ (Branch 02)', 'Branch 02')
  );
  const [trDestOutletId, setTrDestOutletId] = useState('');
  const [trVariantId, setTrVariantId] = useState('VAR-RET-001');
  const [trQtyInput, setTrQtyInput] = useState('5.000');
  const [transfersList, setTransfersList] = useState<
    Awaited<ReturnType<typeof posTransport.listTransfers>>['transfers']
  >([]);

  // Immutable Ledger
  const [ledgerVariantFilter, setLedgerVariantFilter] = useState('');
  const [ledgerRows, setLedgerRows] = useState<
    Awaited<ReturnType<typeof posTransport.listInventoryLedger>>['ledger']
  >([]);

  // Modifier Groups & Items CRUD State
  const [modGroupName, setModGroupName] = useState('');
  const [modGroupType, setModGroupType] = useState<'SINGLE' | 'MULTIPLE'>('MULTIPLE');
  const [modTargetGroupId, setModTargetGroupId] = useState(
    bootstrap.modifierGroups[0]?.id ?? 'GRP-TOPPING'
  );
  const [modItemName, setModItemName] = useState('');
  const [modPriceDeltaBaht, setModPriceDeltaBaht] = useState(() => (isLaos ? '5000' : '15.00'));
  const [modMode, setModMode] = useState<'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS'>('FIXED_QTY_DELTA');
  const [modCompVariantId, setModCompVariantId] = useState('VAR-RAW-BOBA');
  const [modQtyDeltaInput, setModQtyDeltaInput] = useState('40.000');
  const [modRoleTarget, setModRoleTarget] = useState<ComponentRole>('SWEETENER');
  const [modScalePctInput, setModScalePctInput] = useState('-75.00');

  useEffect(() => {
    if (
      bootstrap.suppliers.length > 0 &&
      !bootstrap.suppliers.some((s) => s.id === poSupplierId)
    ) {
      setPoSupplierId(bootstrap.suppliers[0]!.id);
    }
    if (
      bootstrap.modifierGroups.length > 0 &&
      !bootstrap.modifierGroups.some((g) => g.id === modTargetGroupId)
    ) {
      setModTargetGroupId(bootstrap.modifierGroups[0]!.id);
    } else if (bootstrap.modifierGroups.length === 0 && modTargetGroupId) {
      setModTargetGroupId('');
    }
    if (
      bootstrap.catalogDetailed.length > 0 &&
      modCompVariantId &&
      !bootstrap.catalogDetailed.some((v) => v.id === modCompVariantId)
    ) {
      setModCompVariantId(bootstrap.catalogDetailed[0]!.id);
    } else if (bootstrap.catalogDetailed.length === 0 && modCompVariantId) {
      setModCompVariantId('');
    }
    if (prepCandidates.length > 0 && !prepCandidates.some((v) => v.id === prepVariantId)) {
      setPrepVariantId(prepCandidates[0]!.id);
    }
    if (purchasableVariants.length > 0 && !purchasableVariants.some((v) => v.id === trVariantId)) {
      setTrVariantId(purchasableVariants[0]!.id);
    }
    if (purchasableVariants.length > 0) {
      setPoLines((prev) => {
        if (prev.length === 0) {
          const first = purchasableVariants[0]!;
          return [
            {
              variantId: first.id,
              qtyInput: '10.000',
              unitCostBahtInput: formatMicroUnitCostForInput(first.defaultPurchaseCostMicroBaht, currencyCode),
            },
          ];
        }
        const validSet = new Set(purchasableVariants.map((v) => v.id));
        const needsFix = prev.some((line) => !validSet.has(line.variantId));
        if (!needsFix) return prev;
        const first = purchasableVariants[0]!;
        return prev.map((line) =>
          validSet.has(line.variantId)
            ? line
            : {
                ...line,
                variantId: first.id,
              }
        );
      });
    } else if (poLines.length > 0) {
      setPoLines([]);
    }
  }, [
    bootstrap.catalogDetailed,
    bootstrap.modifierGroups,
    bootstrap.suppliers,
    currencyCode,
    modCompVariantId,
    modTargetGroupId,
    poLines.length,
    poSupplierId,
    prepCandidates,
    prepVariantId,
    purchasableVariants,
    trVariantId,
  ]);

  const handleCreateModifierGroup = async () => {
    if (!modGroupName.trim()) return;
    setBusy(true);
    try {
      const res = await posTransport.upsertModifierGroup({
        name: modGroupName,
        selectionType: modGroupType,
      });
      setModGroupName('');
      setModTargetGroupId(res.group.id);
      await onRefreshState();
      onToast(
        pick(
          `สร้างกลุ่มตัวเลือก "${res.group.name}" สำเร็จ`,
          `ສ້າງກຸ່ມຕົວເລືອກ "${res.group.name}" ສຳເລັດ`,
          `Created modifier group "${res.group.name}"`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateModifierItem = async () => {
    if (!modItemName.trim() || !modTargetGroupId) return;
    setBusy(true);
    try {
      const priceDeltaSatang = parseMoney(modPriceDeltaBaht || '0');
      const quantityDeltaMilli = parseDecimalStringToScaledInt(modQtyDeltaInput || '0', 3);
      const scaleBasisPoints = parseDecimalStringToScaledInt(modScalePctInput || '0', 2);

      await posTransport.upsertModifierItem({
        modifierGroupId: modTargetGroupId,
        name: modItemName,
        priceDeltaSatang,
        modifierMode: modMode,
        componentVariantId: modMode === 'FIXED_QTY_DELTA' ? (modCompVariantId || null) : null,
        quantityDeltaMilli,
        targetComponentRole: modMode === 'ROLE_SCALE_BPS' ? modRoleTarget : null,
        scaleBasisPoints,
      });
      setModItemName('');
      await onRefreshState();
      onToast(
        pick(
          `เพิ่มตัวเลือกเสริม "${modItemName}" สำเร็จ`,
          `ເພີ່ມຕົວເລືອກເສີມ "${modItemName}" ສຳເລັດ`,
          `Added modifier "${modItemName}"`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (subTab === 'PO_LANDED') {
      void posTransport.listPoHistory(outletId).then((r) => setPoHistory(r.purchaseOrders));
    } else if (subTab === 'STOCKTAKE_TRANSFER') {
      void posTransport.listTransfers().then((r) => {
        setTransfersList(r.transfers);
        const secondary = r.outlets.find((o) => o.id !== outletId);
        if (secondary && (!trDestOutletId || trDestOutletId === outletId)) {
          setTrDestOutletId(secondary.id);
        }
      });
    } else if (subTab === 'LEDGER') {
      void posTransport
        .listInventoryLedger(outletId, ledgerVariantFilter || undefined)
        .then((r) => setLedgerRows(r.ledger));
    }
  }, [subTab, ledgerVariantFilter, outletId, trDestOutletId]);

  const profileMeta = useMemo(
    () => getProfileMeta(bootstrap.profile, locale),
    [bootstrap.profile, locale]
  );
  const profileWarehouseCategories = useMemo(
    () => getCategoriesForProfile(bootstrap.categories, bootstrap.profile, 'WAREHOUSE'),
    [bootstrap.categories, bootstrap.profile]
  );

  // Ensure sub-tab stays valid when switching between RETAIL and HOSPITALITY
  useEffect(() => {
    if (
      bootstrap.profile === 'RETAIL' &&
      (subTab === 'MODIFIERS' || subTab === 'PREP_BUILD')
    ) {
      setSubTab('CATALOG');
    }
    setCatDeptInput(bootstrap.profile === 'HOSPITALITY' ? 'HOSPITALITY' : 'RETAIL');
  }, [bootstrap.profile, subTab]);

  const openCreateProductModal = useCallback(
    (prefillBarcode = '') => {
      const defaultCat = getDefaultCategoryForProfile(bootstrap.categories, bootstrap.profile);
      const cleanBarcode = prefillBarcode.trim();
      setEditingVariantId(undefined);
      setProdName('');
      setProdSku(
        cleanBarcode
          ? `SKU-${cleanBarcode.slice(-6)}`
          : `SKU-${Date.now().toString().slice(-5)}`
      );
      setProdBarcode(cleanBarcode);
      setProdCategoryId(defaultCat?.id ?? bootstrap.categories[0]?.id ?? 'CAT-RETAIL');
      setProdUnit(getProfileMeta(bootstrap.profile, locale).defaultUnit);
      setProdPriceBaht(isLaos ? '35000' : '55.00');
      setProdCostBaht(isLaos ? '18000' : '25.0000');
      setProdInitStock('20.000');
      setProdLowStock('5.000');
      setProdIsComposite(false);
      setProdUseProduction(false);
      setProdIsScale(false);
      setProdActive(true);
      setProdImagePreviewUrl(null);
      setProdImagePendingDataUrl(undefined);
      setInlineCatOpen(false);
      setInlineCatName('');
      setProductModalOpen(true);
      window.setTimeout(() => prodNameInputRef.current?.focus(), 60);
    },
    [bootstrap.categories, bootstrap.profile, isLaos, locale]
  );

  const openEditProductModal = useCallback(
    (v: CatalogVariantDetailDto) => {
      setEditingVariantId(v.id);
      setProdName(v.itemName);
      setProdSku(v.sku);
      setProdBarcode(v.barcode ?? '');
      setProdCategoryId(v.categoryId ?? 'CAT-RETAIL');
      setProdUnit(v.unitName);
      setProdPriceBaht(moneyInput(v.priceSatang));
      setProdCostBaht(formatMicroUnitCostForInput(v.averageCostMicroBaht, currencyCode));
      setProdInitStock('0');
      setProdLowStock(formatMilliUnitsToQtyString(v.lowStockThresholdMilli));
      setProdIsComposite(v.isComposite);
      setProdUseProduction(v.useProduction);
      setProdIsScale(v.isWeightedScale);
      setProdActive(v.active);
      setProdImagePreviewUrl(resolveBackendAssetUrl(v.imageUrl));
      setProdImagePendingDataUrl(undefined);
      setInlineCatOpen(false);
      setInlineCatName('');
      setProductModalOpen(true);
    },
    [currencyCode, moneyInput]
  );

  const handleWarehouseBarcodeLookupOrCreate = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;
      const matched = bootstrap.catalogDetailed.find(
        (v) => v.barcode === code || v.sku.toLowerCase() === code.toLowerCase()
      );
      if (matched) {
        openEditProductModal(matched);
        onToast(
          pick(
            `พบบาร์โค้ด "${code}" (${matched.itemName}) — เปิดหน้าแก้ไขสินค้าแล้ว`,
            `ພົບບາໂຄດ "${code}" (${matched.itemName}) — ເປີດໜ້າແກ້ໄຂສິນຄ້າແລ້ວ`,
            `Matched barcode "${code}" (${matched.itemName}) — editing item`
          ),
          'success'
        );
      } else {
        openCreateProductModal(code);
        onToast(
          pick(
            `ยังไม่พบบาร์โค้ด "${code}" ในระบบ — เปิดฟอร์มเพิ่มสินค้าใหม่พร้อมใส่บาร์โค้ดให้แล้ว`,
            `ຍັງບໍ່ພົບບາໂຄດ "${code}" ໃນລະບົບ — ເປີດຟອມເພີ່ມສິນຄ້າໃໝ່ພ້ອມໃສ່ບາໂຄດໃຫ້ແລ້ວ`,
            `Barcode "${code}" not found — opened New Product form with prefilled barcode`
          ),
          'success'
        );
      }
      setWarehouseScanInput('');
    },
    [bootstrap.catalogDetailed, onToast, openCreateProductModal, openEditProductModal]
  );

  // Dedicated USB/Bluetooth Physical Barcode Gun Listener inside Warehouse Catalog & Add/Edit Product Modal
  useEffect(() => {
    whFirstKeySnapshotRef.current = null;
    if (
      cameraModal ||
      confirmDeleteVariant ||
      confirmDeleteCategory ||
      confirmDeleteMod ||
      adjTarget ||
      quickBarcodeTarget
    ) {
      return;
    }
    const listenInModal = productModalOpen;
    const listenInCatalog = !productModalOpen && subTab === 'CATALOG';
    if (!listenInModal && !listenInCatalog) return;

    const settersById: Record<string, React.Dispatch<React.SetStateAction<string>>> = {
      [`${uid}-wh-scan`]: setWarehouseScanInput,
      [`${uid}-catalog-search`]: setCatalogSearch,
      [`${uid}-prod-name`]: setProdName,
      [`${uid}-prod-sku`]: setProdSku,
      [`${uid}-prod-barcode`]: setProdBarcode,
      [`${uid}-prod-price`]: setProdPriceBaht,
      [`${uid}-prod-cost`]: setProdCostBaht,
      [`${uid}-prod-unit`]: setProdUnit,
      [`${uid}-prod-init`]: setProdInitStock,
      [`${uid}-prod-low`]: setProdLowStock,
      [`${uid}-inline-cat-name`]: setInlineCatName,
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const activeDialogs =
        typeof document !== 'undefined'
          ? document.querySelectorAll('[role="dialog"], [role="alertdialog"]')
          : null;
      if (listenInCatalog && activeDialogs && activeDialogs.length > 0) {
        return;
      }
      if (listenInModal && activeDialogs && activeDialogs.length > 1) {
        return;
      }

      const target = e.target as HTMLElement | null;
      const scanAttr = target?.dataset.whBarcodeScan;
      const isAnyCatalogScanTarget =
        scanAttr === 'true' || scanAttr === 'catalog-search';

      // Inside catalog tab (not modal): ignore typing in normal inputs unless it's the scan bar or catalog search
      if (
        listenInCatalog &&
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          (target.tagName === 'INPUT' && !isAnyCatalogScanTarget))
      ) {
        return;
      }

      const prePushSnap =
        target instanceof HTMLInputElement
          ? {
              el: target,
              value: target.value,
              selStart: target.selectionStart,
              selEnd: target.selectionEnd,
            }
          : null;

      const buf = whScannerBufferRef.current;
      const { completedBarcode, shouldPreventDefault } = buf.pushKeystroke(
        {
          code: e.code,
          shiftKey: e.shiftKey,
          timestampMs: e.timeStamp || performance.now(),
        },
        () => {
          const snap = whFirstKeySnapshotRef.current;
          whFirstKeySnapshotRef.current = null;
          if (!snap) return;
          const { el, value, selStart, selEnd } = snap;
          if (document.contains(el)) {
            el.value = value;
            if (selStart !== null && selEnd !== null) {
              try {
                el.setSelectionRange(selStart, selEnd);
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
                    el.setSelectionRange(selStart, selEnd);
                  } catch {
                    // ignore
                  }
                }
              }, 0);
            }
          }
          const setter = settersById[el.id];
          setter?.(value);
        },
        () => {
          whFirstKeySnapshotRef.current = prePushSnap;
        }
      );

      if (shouldPreventDefault) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (completedBarcode) {
        whFirstKeySnapshotRef.current = null;
        if (listenInModal) {
          setProdBarcode(completedBarcode);
          onToast(
            pick(
              `รับรหัสบาร์โค้ด "${completedBarcode}" จากปืนสแกนเรียบร้อยแล้ว`,
              `ຮັບລະຫັດບາໂຄດ "${completedBarcode}" ຈາກປືນສະແກນຮຽບຮ້ອຍແລ້ວ`,
              `Captured barcode "${completedBarcode}" from scanner`
            ),
            'success'
          );
        } else if (listenInCatalog) {
          handleWarehouseBarcodeLookupOrCreate(completedBarcode);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [
    adjTarget,
    cameraModal,
    confirmDeleteCategory,
    confirmDeleteMod,
    confirmDeleteVariant,
    handleWarehouseBarcodeLookupOrCreate,
    onToast,
    productModalOpen,
    quickBarcodeTarget,
    subTab,
    uid,
  ]);

  const handleSaveProduct = async () => {
    setBusy(true);
    try {
      const priceSatang = parseMoney(prodPriceBaht);
      const defaultPurchaseCostMicroBaht = parseDecimalStringToScaledInt(prodCostBaht, 6);
      const initialStockMilli = parseDecimalStringToScaledInt(prodInitStock || '0', 3);
      const lowStockThresholdMilli = parseDecimalStringToScaledInt(prodLowStock || '0', 3);

      const saved = await posTransport.upsertCatalogVariant({
        outletId,
        ...(editingVariantId ? { variantId: editingVariantId } : {}),
        itemName: prodName,
        sku: prodSku,
        barcode: prodBarcode || null,
        categoryId: prodCategoryId,
        unitName: prodUnit,
        priceSatang,
        defaultPurchaseCostMicroBaht,
        initialStockMilli,
        lowStockThresholdMilli,
        isComposite: bootstrap.profile === 'RETAIL' ? false : prodIsComposite,
        useProduction: bootstrap.profile === 'RETAIL' ? false : prodUseProduction,
        isWeightedScale: bootstrap.profile === 'HOSPITALITY' ? false : prodIsScale,
        active: prodActive,
        performedByUserId: currentUser.id,
      });

      if (prodImagePendingDataUrl !== undefined) {
        await posTransport.uploadCatalogVariantImage({
          variantId: saved.variant.id,
          dataUrl: prodImagePendingDataUrl,
          actorUserId: currentUser.id,
        });
      }

      setProductModalOpen(false);
      await onRefreshState();
      onToast(
        pick(
          `บันทึกข้อมูลสินค้า "${prodName}" สำเร็จ`,
          `ບັນທຶກຂໍ້ມູນສິນຄ້າ "${prodName}" ສຳເລັດ`,
          `Saved product "${prodName}"`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleProductPhotoFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressImageFileToDataUrl(file, locale);
      setProdImagePreviewUrl(compressed);
      setProdImagePendingDataUrl(compressed);
      onToast(
        pick(
          'เตรียมรูปภาพสินค้าเรียบร้อย กดบันทึกเพื่อยืนยัน',
          'ກຽມຮູບພາບສິນຄ້າຮຽບຮ້ອຍ ກົດບັນທຶກເພື່ອຢືນຢັນ',
          'Product photo ready — click Save to confirm'
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleSaveCategory = async (overrideName?: string, overrideDept?: ShopCategoryDepartment) => {
    const cleanName = (overrideName ?? catNameInput).trim();
    if (!cleanName) {
      onToast(
        pick('กรุณากรอกชื่อหมวดหมู่', 'ກະລຸນາປ້ອນຊື່ໝວດໝູ່', 'Please enter category name'),
        'warn'
      );
      return;
    }
    const targetDept = overrideDept ?? catDeptInput;
    setBusy(true);
    try {
      const res = await posTransport.upsertCategory({
        ...(catEditingId && !overrideName ? { id: catEditingId } : {}),
        name: cleanName,
        displayColor: targetDept === 'RAW_MATERIAL' ? '#5f6368' : '#1a73e8',
        kitchenStation: getDepartmentStationPreset(targetDept),
        sortOrder: targetDept === 'RAW_MATERIAL' ? 50 : 10,
      });
      await onRefreshState();
      if (overrideName) {
        setProdCategoryId(res.category.id);
        setInlineCatName('');
        setInlineCatOpen(false);
      } else {
        setCatEditingId(null);
        setCatNameInput('');
      }
      onToast(
        pick(
          `บันทึกหมวดหมู่ "${res.category.name}" เรียบร้อยแล้ว`,
          `ບັນທຶກໝວດໝູ່ "${res.category.name}" ຮຽບຮ້ອຍແລ້ວ`,
          `Saved category "${res.category.name}"`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleQuickToggleVariantActive = async (v: CatalogVariantDetailDto) => {
    setBusy(true);
    try {
      const nextActive = !v.active;
      await posTransport.upsertCatalogVariant({
        outletId,
        variantId: v.id,
        itemId: v.itemId,
        itemName: v.itemName,
        variantName: v.variantName,
        categoryId: v.categoryId,
        sku: v.sku,
        barcode: v.barcode,
        unitName: v.unitName,
        priceSatang: v.priceSatang,
        defaultPurchaseCostMicroBaht: v.defaultPurchaseCostMicroBaht,
        initialStockMilli: 0,
        lowStockThresholdMilli: v.lowStockThresholdMilli,
        optimalStockMilli: v.optimalStockMilli,
        isComposite: v.isComposite,
        useProduction: v.useProduction,
        isWeightedScale: v.isWeightedScale,
        active: nextActive,
        performedByUserId: currentUser.id,
      });
      await onRefreshState();
      onToast(
        nextActive
          ? pick(
              `เปิดขาย "${v.itemName}" บนหน้าจอ POS อีกครั้งแล้ว`,
              `ເປີດຂາຍ "${v.itemName}" ເທິງໜ້າຈໍ POS ອີກຄັ້ງແລ້ວ`,
              `Re-enabled "${v.itemName}" on POS register`
            )
          : pick(
              `พักการขาย "${v.itemName}" ชั่วคราวแล้ว (ซ่อนจากหน้าขาย POS)`,
              `ພັກການຂາຍ "${v.itemName}" ຊົ່ວຄາວແລ້ວ (ຊ່ອນຈາກໜ້າຂາຍ POS)`,
              `Paused "${v.itemName}" (hidden from POS register)`
            ),
        nextActive ? 'success' : 'warn'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmAdjustment = async () => {
    if (!adjTarget) return;
    setBusy(true);
    try {
      const deltaMilli = parseDecimalStringToScaledInt(adjDeltaInput, 3);
      await posTransport.adjustStock({
        outletId,
        variantId: adjTarget.id,
        quantityDeltaMilli: deltaMilli,
        reason: adjReason,
        performedByUserId: currentUser.id,
      });
      setAdjTarget(null);
      await onRefreshState();
      onToast(
        pick(
          `ปรับปรุงสต็อก ${adjTarget.itemName} บันทึกลงสมุดบัญชีสำเร็จ`,
          `ປັບປຸງສະຕັອກ ${adjTarget.itemName} ບັນທຶກລົງປຶ້ມບັນຊີສຳເລັດ`,
          `Adjusted stock for ${adjTarget.itemName} in ledger`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const buildParsedPoPayload = () => {
    const items = poLines.map((l) => {
      const qtyMilli = parseDecimalStringToScaledInt(l.qtyInput, 3);
      const costMicro = parseDecimalStringToScaledInt(l.unitCostBahtInput, 6);
      return {
        variantId: l.variantId,
        orderedQtyMilli: qtyMilli,
        receivedQtyMilli: qtyMilli,
        baseUnitCostMicroBaht: costMicro,
      };
    });
    const landedCosts = poLandedCosts
      .map((c) => ({
        costType: c.costType,
        description: c.description,
        amountSatang: parseMoney(c.amountBahtInput || '0'),
      }))
      .filter((c) => c.amountSatang > 0);
    return { items, landedCosts };
  };

  const handlePreviewPo = async () => {
    setBusy(true);
    try {
      const { items, landedCosts } = buildParsedPoPayload();
      const res = await posTransport.previewPurchaseOrder({
        outletId,
        supplierId: poSupplierId,
        items,
        landedCosts,
      });
      setPoPreviewLines(res.lines);
      onToast(
        pick(
          'คำนวณปันส่วนค่าขนส่งแฝง (Largest Remainder i128) สำเร็จ',
          'ຄຳນວນປັນສ່ວນຄ່າຂົນສົ່ງແຝງ (Largest Remainder i128) ສຳເລັດ',
          'Calculated landed cost allocation (Largest Remainder i128)'
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReceivePo = async () => {
    setBusy(true);
    try {
      const { items, landedCosts } = buildParsedPoPayload();
      const res = await posTransport.receivePurchaseOrder({
        outletId,
        supplierId: poSupplierId,
        createdByUserId: currentUser.id,
        items,
        landedCosts,
      });
      setPoPreviewLines(null);
      const poBarcodeItems: BarcodeQueueEntry[] = items
        .map((it) => ({
          variantId: it.variantId,
          copies: Math.max(1, Math.min(200, Math.round(it.receivedQtyMilli / 1_000) || 1)),
        }))
        .filter((it) => it.copies > 0);
      setLastReceivedPoBatch({
        poNumber: res.poNumber,
        items: poBarcodeItems,
      });
      const hist = await posTransport.listPoHistory(outletId);
      setPoHistory(hist.purchaseOrders);
      await onRefreshState();
      onToast(
        pick(
          `รับสินค้าเข้าคลังเลขที่ ${res.poNumber} พร้อมคำนวณ MAC ใหม่สำเร็จ`,
          `ຮັບສິນຄ້າເຂົ້າສາງເລກທີ ${res.poNumber} ພ້ອມຄຳນວນ MAC ໃໝ່ສຳເລັດ`,
          `Received PO ${res.poNumber} & recalculated MAC`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePrepBuild = async () => {
    setBusy(true);
    try {
      const qtyMilli = parseDecimalStringToScaledInt(prepQtyInput, 3);
      const res = await posTransport.executePrepBuild({
        outletId,
        compositeVariantId: prepVariantId,
        buildQtyMilli: qtyMilli,
        performedByUserId: currentUser.id,
      });
      await onRefreshState();
      onToast(
        `${pick('ต้ม/ผลิตชุดเตรียมขายสำเร็จ', 'ຜະລິດຊຸດກຽມຂາຍສຳເລັດ', 'Prep batch built')} (+${formatMilliUnitsToQtyString(res.builtQtyMilli)} · MAC ${unitCost(res.batchUnitCostMicroBaht)})`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleExecuteStocktake = async () => {
    const entries = Object.entries(stocktakeInputs).filter(([, v]) => v.trim() !== '');
    if (entries.length === 0) {
      onToast(
        pick(
          'กรุณากรอกยอดนับจริงอย่างน้อย 1 รายการในตารางตรวจนับสต็อก',
          'ກະລຸນາປ້ອນຍອດນັບຈິງຢ່າງໜ້ອຍ 1 ລາຍການໃນຕາຕະລາງກວດນັບສະຕັອກ',
          'Enter counted quantity for at least 1 stocktake row'
        ),
        'warn'
      );
      return;
    }
    setBusy(true);
    try {
      const items = entries.map(([variantId, val]) => ({
        variantId,
        countedStockMilli: parseDecimalStringToScaledInt(val, 3),
      }));
      const res = await posTransport.executeStocktake({
        outletId,
        createdByUserId: currentUser.id,
        items,
      });
      setStocktakeInputs({});
      await onRefreshState();
      onToast(
        `${pick('บันทึกใบตรวจนับสต็อก', 'ບັນທຶກໃບກວດນັບສະຕັອກ', 'Saved stocktake')} ${res.countNumber} (${pick('ผลต่างรวม', 'ຜົນຕ່າງລວມ', 'Variance')} ${money(res.totalVarianceSatang)})`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBranchOutlet = async () => {
    if (!newOutletCode.trim() || !newOutletName.trim()) return;
    setBusy(true);
    try {
      const res = await posTransport.registerOutlet({
        code: newOutletCode,
        name: newOutletName,
        isWarehouse: false,
      });
      await onRefreshState();
      const created = res.outlets.find((o) => o.id !== 'OUTLET-HQ');
      if (created) setTrDestOutletId(created.id);
      onToast(
        pick(
          `เปิดสาขาปลายทาง ${newOutletName} สำเร็จ`,
          `ເປີດສາຂາປາຍທາງ ${newOutletName} ສຳເລັດ`,
          `Created destination branch "${newOutletName}"`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchTransfer = async () => {
    if (!trDestOutletId) {
      onToast(
        pick(
          'กรุณาสร้างหรือเลือกสาขาปลายทางก่อนส่งโอนสต็อก',
          'ກະລຸນາສ້າງ ຫຼື ເລືອກສາຂາປາຍທາງກ່ອນສົ່ງໂອນສະຕັອກ',
          'Create or select a destination branch before transferring stock'
        ),
        'warn'
      );
      return;
    }
    setBusy(true);
    try {
      const qtyMilli = parseDecimalStringToScaledInt(trQtyInput, 3);
      const res = await posTransport.dispatchTransfer({
        sourceOutletId: outletId,
        destinationOutletId: trDestOutletId,
        dispatchedByUserId: currentUser.id,
        items: [{ variantId: trVariantId, quantityMilli: qtyMilli }],
      });
      const trData = await posTransport.listTransfers();
      setTransfersList(trData.transfers);
      await onRefreshState();
      onToast(
        pick(
          `ตัดจ่ายใบโอนย้ายสาขา ${res.transferNumber} (IN_TRANSIT) สำเร็จ`,
          `ຕັດຈ່າຍໃບໂອນຍ້າຍສາຂາ ${res.transferNumber} (IN_TRANSIT) ສຳເລັດ`,
          `Dispatched inter-branch transfer ${res.transferNumber} (IN_TRANSIT)`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReceiveTransfer = async (transferOrderId: string, transferNo: string) => {
    setBusy(true);
    try {
      await posTransport.receiveTransfer({
        transferOrderId,
        receivedByUserId: currentUser.id,
      });
      const trData = await posTransport.listTransfers();
      setTransfersList(trData.transfers);
      await onRefreshState();
      onToast(
        pick(
          `สาขาปลายทางกดรับสต็อกใบโอน ${transferNo} (COMPLETED) สำเร็จ`,
          `ສາຂາປາຍທາງກົດຮັບສະຕັອກໃບໂອນ ${transferNo} (COMPLETED) ສຳເລັດ`,
          `Destination branch received transfer ${transferNo} (COMPLETED)`
        ),
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const profileScopedCatalog = useMemo(
    () =>
      showOtherProfileItems
        ? bootstrap.catalogDetailed
        : bootstrap.catalogDetailed.filter((v) =>
            isVariantInProfileDomain(v, bootstrap.profile, 'WAREHOUSE')
          ),
    [bootstrap.catalogDetailed, bootstrap.profile, showOtherProfileItems]
  );

  const otherProfileItemsCount = useMemo(
    () =>
      bootstrap.catalogDetailed.filter(
        (v) => !isVariantInProfileDomain(v, bootstrap.profile, 'WAREHOUSE')
      ).length,
    [bootstrap.catalogDetailed, bootstrap.profile]
  );

  const lowStockCount = profileScopedCatalog.filter(
    (v) => (!v.isComposite || v.useProduction) && v.inStockMilli <= v.lowStockThresholdMilli
  ).length;
  const pausedCount = profileScopedCatalog.filter((v) => !v.active).length;

  const filteredCatalog = profileScopedCatalog.filter((item) => {
    if (catalogFilterMode === 'LOW_STOCK') {
      const isLow =
        (!item.isComposite || item.useProduction) &&
        item.inStockMilli <= item.lowStockThresholdMilli;
      if (!isLow) return false;
    } else if (catalogFilterMode === 'PAUSED') {
      if (item.active) return false;
    }

    if (!catalogSearch.trim()) return true;
    const q = catalogSearch.trim().toLowerCase();
    return (
      item.itemName.toLowerCase().includes(q) ||
      item.sku.toLowerCase().includes(q) ||
      (item.barcode ?? '').toLowerCase().includes(q)
    );
  });

  const visibleWarehouseTabs = [
    { id: 'CATALOG' as const, label: t('wms.tab.catalog'), icon: Boxes, visible: true },
    {
      id: 'CATEGORIES' as const,
      label: t('wms.tab.categories'),
      icon: Tag,
      visible: true,
    },
    {
      id: 'MODIFIERS' as const,
      label: t('wms.tab.modifiers'),
      icon: SlidersHorizontal,
      visible: bootstrap.profile !== 'RETAIL',
    },
    { id: 'PO_LANDED' as const, label: t('wms.tab.po'), icon: Truck, visible: true },
    {
      id: 'PREP_BUILD' as const,
      label: t('wms.tab.prep'),
      icon: Factory,
      visible: bootstrap.profile !== 'RETAIL',
    },
    {
      id: 'STOCKTAKE_TRANSFER' as const,
      label: t('wms.tab.stocktake'),
      icon: ArrowLeftRight,
      visible: true,
    },
    {
      id: 'BARCODE_PRINT' as const,
      label: t('wms.tab.barcodes'),
      icon: Printer,
      visible: true,
    },
    {
      id: 'LEDGER' as const,
      label: t('wms.tab.ledger'),
      icon: FileSpreadsheet,
      visible: true,
    },
  ].filter((tab) => tab.visible);

  return (
    <div className="space-y-6">
      {/* Canonical Google Underline WMS Sub-Navigation + Primary Pill CTA */}
      <div className="border-b border-hairline bg-canvas">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div
            className="flex items-center gap-1 overflow-x-auto"
            role="tablist"
            aria-label={pick('หมวดหมู่คลังสินค้าและจัดซื้อ', 'ໝວດໝູ່ສາງສິນຄ້າ ແລະ ຈັດຊື້', 'Warehouse & Purchasing Tabs')}
          >
            {visibleWarehouseTabs.map((tab) => {
              const Icon = tab.icon;
              const active = subTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSubTab(tab.id)}
                  className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                    active ? 'text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-primary' : ''}`} />
                  <span>{tab.label}</span>
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => openCreateProductModal('')}
            className={`mb-2 sm:mb-0 flex h-[44px] items-center gap-2 rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
          >
            <PackagePlus className="h-4 w-4" />
            <span>{t('wms.addProduct')}</span>
          </button>
        </div>
      </div>

      {/* TAB 1: MASTER CATALOG & STOCK LEVELS (SHOP-SEPARATED + SCAN-TO-ADD + PHOTOS + DELETE) */}
      {subTab === 'CATALOG' && (
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="p-5 border-b border-hairline bg-surface-1 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-[48px] bg-primary-soft px-3 py-0.5 text-[11px] font-medium text-primary-dark mb-1.5">
                  <Store className="h-3.5 w-3.5" />
                  <span>{profileMeta.titleThai}</span>
                </div>
                <h3 className="font-google-display text-[20px] font-normal text-ink">
                  {profileMeta.catalogTitleThai} ({outletId})
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  {pick(
                    'ยิงปืนบาร์โค้ดที่ตัวสินค้าได้เลยเพื่อเปิดแก้ไข หรือเพิ่มสินค้าใหม่พร้อมใส่รูปภาพและลบรายการได้ยืดหยุ่น',
                    'ຍິງປືນບາໂຄດທີ່ສິນຄ້າໄດ້ເລີຍເພື່ອແກ້ໄຂ ຫຼື ເພີ່ມສິນຄ້າໃໝ່ພ້ອມຮູບພາບ ແລະ ລຶບລາຍການໄດ້ຍືດຫຍຸ່ນ',
                    'Scan any item barcode to edit directly, or add new products with photos and flexible delete'
                  )}
                </p>
              </div>
              <div className="relative w-full sm:w-80">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
                <input
                  id={`${uid}-catalog-search`}
                  data-wh-barcode-scan="catalog-search"
                  type="text"
                  aria-label={pick('ค้นหาชื่อสินค้า รหัส SKU หรือบาร์โค้ด', 'ຄົ້ນຫາຊື່ສິນຄ້າ, SKU ຫຼື ບາໂຄດ', 'Search name, SKU, or barcode')}
                  value={catalogSearch}
                  onChange={(e) => setCatalogSearch(e.target.value)}
                  placeholder={pick('ค้นหาชื่อสินค้า / SKU / บาร์โค้ด...', 'ຄົ້ນຫາຊື່ສິນຄ້າ / SKU / ບາໂຄດ...', 'Search name / SKU / barcode...')}
                  className={`h-11 w-full rounded-[48px] border border-hairline bg-canvas pl-10 pr-4 text-xs text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>

            {/* Quick Barcode Scan-to-Add / Find Bar (USB Gun + Camera) */}
            <div className="rounded-[8px] border border-primary/25 bg-primary-soft/60 p-3 flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-primary-dark shrink-0">
                <ScanBarcode className="h-4 w-4" />
                <span>
                  {pick('สแกนบาร์โค้ดเพื่อเพิ่ม/ค้นหาสินค้า:', 'ສະແກນບາໂຄດເພື່ອເພີ່ມ/ຄົ້ນຫາສິນຄ້າ:', 'Scan barcode to add or find:')}
                </span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleWarehouseBarcodeLookupOrCreate(warehouseScanInput);
                }}
                className="flex flex-1 min-w-[220px] items-center gap-2"
              >
                <input
                  id={`${uid}-wh-scan`}
                  type="text"
                  data-wh-barcode-scan="true"
                  aria-label={pick(
                    'ยิงปืนบาร์โค้ดหรือกรอกบาร์โค้ดเพื่อเพิ่มหรือค้นหาสินค้า',
                    'ຍິງປືນບາໂຄດ ຫຼື ປ້ອນບາໂຄດເພື່ອເພີ່ມ ຫຼື ຄົ້ນຫາສິນຄ້າ',
                    'Scan or enter barcode to find or add item'
                  )}
                  value={warehouseScanInput}
                  onChange={(e) => setWarehouseScanInput(e.target.value)}
                  placeholder={pick(
                    'ยิงปืนบาร์โค้ดสินค้าทันที หรือพิมพ์รหัสแล้วกด Enter...',
                    'ຍິງປືນບາໂຄດສິນຄ້າທັນທີ ຫຼື ພິມລະຫັດແລ້ວກົດ Enter...',
                    'Scan item barcode or type code + Enter...'
                  )}
                  className={`h-10 flex-1 rounded-[48px] border border-hairline bg-canvas px-4 text-xs text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
                <button
                  type="submit"
                  disabled={!warehouseScanInput.trim()}
                  className={`h-10 rounded-[48px] bg-primary px-4 font-google-display text-xs font-medium text-white hover:bg-primary-hover whitespace-nowrap ${UI_INTERACTION.focusButtonPrimary}`}
                >
                  {pick('ค้นหา / เพิ่มเลย', 'ຄົ້ນຫາ / ເພີ່ມເລີຍ', 'Find / Add')}
                </button>
              </form>
              <button
                type="button"
                onClick={() => setCameraModal({ mode: 'BARCODE', target: 'CATALOG_SCAN' })}
                className={`inline-flex h-10 items-center gap-1.5 rounded-[48px] border border-primary bg-canvas px-4 font-google-display text-xs font-medium text-primary-dark hover:bg-surface-1 whitespace-nowrap ${UI_INTERACTION.focusButton}`}
              >
                <Camera className="h-3.5 w-3.5" />
                <span>{pick('สแกนด้วยกล้อง', 'ສະແກນດ້ວຍກ້ອງ', 'Camera Scan')}</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { id: 'ALL', label: `${pick('ทั้งหมด', 'ທັງໝົດ', 'All')} (${profileScopedCatalog.length})` },
                    { id: 'LOW_STOCK', label: `${pick('ต่ำกว่าเกณฑ์ / ของหมด', 'ຕ່ຳກວ່າເກນ / ໝົດສະຕັອກ', 'Low / Out of Stock')} (${lowStockCount})` },
                    { id: 'PAUSED', label: `${pick('พักการขายชั่วคราว', 'ພັກການຂາຍຊົ່ວຄາວ', 'Paused')} (${pausedCount})` },
                  ] as const
                ).map((pill) => {
                  const active = catalogFilterMode === pill.id;
                  return (
                    <button
                      key={pill.id}
                      type="button"
                      onClick={() => setCatalogFilterMode(pill.id)}
                      className={`min-h-[36px] rounded-[48px] border px-4 font-google-display text-xs font-medium ${UI_INTERACTION.focusButton} ${
                        active
                          ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                          : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                      }`}
                    >
                      {pill.label}
                    </button>
                  );
                })}
              </div>

              {otherProfileItemsCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowOtherProfileItems((v) => !v)}
                  className={`min-h-[36px] rounded-[48px] border px-3.5 text-xs font-medium ${UI_INTERACTION.focusButton} ${
                    showOtherProfileItems
                      ? 'border-ink bg-ink text-white'
                      : 'border-hairline bg-canvas text-ink-muted hover:border-primary hover:text-primary'
                  }`}
                >
                  {showOtherProfileItems
                    ? pick('ซ่อนสินค้าต่างโหมดธุรกิจ', 'ຊ່ອນສິນຄ້າຕ່າງໂໝດທຸລະກິດ', 'Hide Other Profile Items')
                    : pick(
                        `มีสินค้าต่างโหมดธุรกิจซ่อนอยู่ ${otherProfileItemsCount} รายการ (คลิกดู)`,
                        `ມີສິນຄ້າຕ່າງໂໝດທຸລະກິດຊ່ອນຢູ່ ${otherProfileItemsCount} ລາຍການ (ຄລິກເບິ່ງ)`,
                        `${otherProfileItemsCount} items in other profiles hidden (Show)`
                      )}
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                <tr>
                  <th scope="col" className="py-3 px-4">{pick('SKU / บาร์โค้ด', 'SKU / ບາໂຄດ', 'SKU / Barcode')}</th>
                  <th scope="col" className="py-3 px-4">{pick('ชื่อรายการ', 'ຊື່ລາຍການ', 'Product Name')}</th>
                  <th scope="col" className="py-3 px-4">{pick('หมวด / ประเภทสต็อก', 'ໝວດ / ປະເພດສະຕັອກ', 'Category / Stock Type')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('คงเหลือจริง', 'ຄົງເຫຼືອຈິງ', 'Stock on Hand')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('ต้นทุนเฉลี่ย MAC', 'ຕົ້ນທຶນສະເລ່ຍ MAC', 'Avg Cost (MAC)')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('ราคาขาย', 'ລາຄາຂາຍ', 'Selling Price')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('จัดการ', 'ຈັດການ', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas">
                {filteredCatalog.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-ink-muted">
                      {catalogSearch.trim()
                        ? pick(
                            'ไม่พบสินค้าหรือวัตถุดิบที่ตรงกับคำค้นหา',
                            'ບໍ່ພົບສິນຄ້າ ຫຼື ວັດຖຸດິບທີ່ກົງກັບຄຳຄົ້ນຫາ',
                            'No matching products or raw materials found'
                          )
                        : pick(
                            'ยังไม่มีรายการสินค้า/วัตถุดิบในคลัง — กดปุ่ม "+ เพิ่มสินค้า / วัตถุดิบใหม่" มุมขวาบนเพื่อเริ่มต้น',
                            'ຍັງບໍ່ມີສິນຄ້າ/ວັດຖຸດິບໃນສາງ — ກົດປຸ່ມ "+ ເພີ່ມສິນຄ້າ / ວັດຖຸດິບໃໝ່" ມຸມຂວາເທິງເພື່ອເລີ່ມຕົ້ນ',
                            'Catalog is empty — click "+ New Product / Material" at the top right to start'
                          )}
                    </td>
                  </tr>
                ) : (
                  filteredCatalog.map((v) => {
                  const isLow =
                    (!v.isComposite || v.useProduction) &&
                    v.inStockMilli <= v.lowStockThresholdMilli;
                  return (
                    <tr key={v.id} className="hover:bg-surface-1 transition-colors duration-150">
                      <td className="py-3 px-4 tabular-nums-google">
                        <div className="font-medium text-ink">{v.sku}</div>
                        <div className="text-[11px] text-ink-muted">
                          {v.barcode ?? pick('ไม่มีบาร์โค้ด', 'ບໍ່ມີບາໂຄດ', 'No barcode')}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          {resolveBackendAssetUrl(v.imageUrl) ? (
                            <img
                              src={resolveBackendAssetUrl(v.imageUrl)!}
                              alt={v.itemName}
                              loading="lazy"
                              className="h-11 w-11 rounded-[4px] border border-hairline object-cover shrink-0 bg-surface-1"
                            />
                          ) : (
                            <div
                              aria-hidden="true"
                              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] border border-hairline bg-surface-1 text-ink-muted"
                            >
                              <ImagePlus className="h-4 w-4" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-google-display text-sm font-medium text-ink flex flex-wrap items-center gap-1.5">
                              <span className={!v.active ? 'line-through text-ink-muted' : ''}>
                                {v.itemName}
                              </span>
                              {!v.active && (
                                <span className="rounded-[4px] bg-ink px-2 py-0.5 text-[10px] font-medium text-white">
                                  {pick('พักขายชั่วคราว', 'ພັກຂາຍຊົ່ວຄາວ', 'Paused')}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-ink-muted">ID: {v.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4 space-y-1">
                        <div className="inline-flex items-center gap-1.5 rounded-[48px] border border-hairline bg-surface-1 px-2.5 py-0.5 text-[11px] text-ink">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                          {v.categoryName}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {v.useProduction
                            ? pick('Pre-Built ต้มเตรียมขาย', 'Pre-Built ຕົ້ມກຽມຂາຍ', 'Pre-Built Prep Batch')
                            : v.isComposite
                              ? pick('เมนูผูกสูตร BOM ตัดสด', 'ເມນູຜູກສູດ BOM ຕັດສົດ', 'Live BOM Recipe')
                              : v.isWeightedScale
                                ? pick('สินค้าชั่งน้ำหนักสด EAN-13', 'ສິນຄ້າຊັ່ງນ້ຳໜັກສົດ EAN-13', 'Weighted Scale EAN-13')
                                : pick('ตัดสต็อกรายชิ้นโดยตรง', 'ຕັດສະຕັອກລາຍຊິ້ນໂດຍກົງ', 'Direct Unit Deduction')}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums-google">
                        {v.isComposite && !v.useProduction ? (
                          <span className="text-ink-muted">{pick('ตามวัตถุดิบ', 'ຕາມວັດຖຸດິບ', 'By Ingredients')}</span>
                        ) : (
                          <div>
                            <span className="text-sm font-medium text-ink">
                              {formatMilliUnitsToQtyString(v.inStockMilli, v.unitName)}
                            </span>
                            {isLow && (
                              <div className="mt-0.5 inline-flex items-center justify-end gap-1 rounded-[4px] bg-ink px-1.5 py-0.5 text-[10px] text-white ml-1.5">
                                <AlertCircle className="h-3 w-3" /> {pick('ต่ำกว่าเกณฑ์', 'ຕ່ຳກວ່າເກນ', 'Low Stock')}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right text-ink-muted tabular-nums-google">
                        {unitCost(v.averageCostMicroBaht)}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-primary-hover tabular-nums-google">
                        {v.priceSatang > 0 ? money(v.priceSatang) : '—'}
                      </td>
                      <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleQuickToggleVariantActive(v)}
                          className={`rounded-[48px] border px-3 py-1.5 text-[11px] font-medium ${UI_INTERACTION.focusButton} ${
                            v.active
                              ? 'border-hairline bg-surface-1 text-ink-soft hover:border-ink hover:text-ink'
                              : 'border-primary bg-primary-soft text-primary-dark hover:bg-primary-soft/80'
                          }`}
                        >
                          {v.active ? pick('พักขาย', 'ພັກຂາຍ', 'Pause') : pick('เปิดขาย', 'ເປີດຂາຍ', 'Activate')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setQuickBarcodeTarget(v)}
                          className={`inline-flex items-center gap-1 rounded-[48px] border border-hairline bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-soft hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                        >
                          <Printer className="h-3.5 w-3.5" />
                          <span>{pick('บาร์โค้ด', 'ບາໂຄດ', 'Label')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditProductModal(v)}
                          className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1.5 text-[11px] font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                        >
                          {pick('แก้ไข', 'ແກ້ໄຂ', 'Edit')}
                        </button>
                        {(!v.isComposite || v.useProduction) && (
                          <button
                            type="button"
                            onClick={() => {
                              setAdjTarget(v);
                              setAdjDeltaInput('-1.000');
                            }}
                            className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1.5 text-[11px] font-medium text-ink-soft hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                          >
                            {pick('ปรับสต็อก', 'ປັບສະຕັອກ', 'Adjust')}
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={pick(`ลบสินค้า ${v.itemName}`, `ລຶບສິນຄ້າ ${v.itemName}`, `Delete product ${v.itemName}`)}
                          onClick={() => setConfirmDeleteVariant(v)}
                          className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-canvas text-ink-muted hover:border-ink hover:bg-surface-1 hover:text-ink align-middle ${UI_INTERACTION.focusButton}`}
                        >
                          <Trash2 className="h-4 w-4" />
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

      {/* TAB 1.2: CUSTOM CATEGORY MANAGER (SEPARATED BY SHOP DEPARTMENT) */}
      {subTab === 'CATEGORIES' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <div className="xl:col-span-5 rounded-[4px] border border-hairline bg-canvas p-6 space-y-4 text-xs">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
                <FolderPlus className="h-4 w-4" />
              </div>
              <div>
                <h3 className="font-google-display text-[18px] font-normal text-ink">
                  {catEditingId
                    ? pick('แก้ไขหมวดหมู่สินค้า', 'ແກ້ໄຂໝວດໝູ່ສິນຄ້າ', 'Edit Category')
                    : pick('เพิ่มหมวดหมู่สินค้า / เมนูใหม่', 'ເພີ່ມໝວດໝູ່ສິນຄ້າ / ເມນູໃໝ່', 'Create Product / Menu Category')}
                </h3>
                <p className="text-ink-muted">
                  {pick(
                    'แยกแผนกหมวดหมู่ตามโหมดร้านค้าชัดเจน ไม่ปะปนกันระหว่างค้าปลีกและคาเฟ่',
                    'ແຍກພະແນກໝວດໝູ່ຕາມໂໝດຮ້ານຄ້າຊັດເຈນ ບໍ່ປົນເປກັນລະຫວ່າງຂາຍຍ່ອຍ ແລະ ຄາເຟ່',
                    'Separates departments cleanly by store profile without mixing retail & café items'
                  )}
                </p>
              </div>
            </div>

            <div>
              <label htmlFor={`${uid}-cat-name`} className="block text-ink-muted mb-1">
                {pick(
                  'ชื่อหมวดหมู่ (เช่น กาแฟสด, เบเกอรี่, เครื่องดื่มแช่เย็น, ของใช้ในบ้าน)',
                  'ຊື່ໝວດໝູ່ (ເຊັ່ນ ກາເຟສົດ, ເບເກີຣີ, ເຄື່ອງດື່ມແຊ່ເຢັນ)',
                  'Category Name (e.g. Fresh Coffee, Bakery, Chilled Drinks)'
                )}
              </label>
              <input
                id={`${uid}-cat-name`}
                type="text"
                value={catNameInput}
                onChange={(e) => setCatNameInput(e.target.value)}
                placeholder={pick('พิมพ์ชื่อหมวดหมู่...', 'ພິມຊື່ໝວດໝູ່...', 'Enter category name...')}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
              />
            </div>

            <div>
              <label htmlFor={`${uid}-cat-dept`} className="block text-ink-muted mb-1">
                {pick('ประเภทแผนก / รูปแบบร้านค้า', 'ປະເພດພະແນກ / ຮູບແບບຮ້ານຄ້າ', 'Department / Profile Type')}
              </label>
              <select
                id={`${uid}-cat-dept`}
                value={catDeptInput}
                onChange={(e) => setCatDeptInput(e.target.value as ShopCategoryDepartment)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
              >
                {bootstrap.profile !== 'HOSPITALITY' && (
                  <option value="RETAIL">
                    {pick('สินค้าปลีก / ซูเปอร์มาร์เก็ต (สถานี NONE)', 'ສິນຄ້າຂາຍຍ່ອຍ / ຊູເປີມາເກັດ (ສະຖານີ NONE)', 'Retail / Supermarket (Station NONE)')}
                  </option>
                )}
                {bootstrap.profile !== 'RETAIL' && (
                  <>
                    <option value="HOSPITALITY">
                      {pick('เมนูคาเฟ่ / ร้านอาหาร (ส่งจอครัว BAR/MAIN)', 'ເມນູຄາເຟ່ / ຮ້ານອາຫານ (ສົ່ງຈໍຄົວ BAR/MAIN)', 'Café / Restaurant Menu (KDS BAR/MAIN)')}
                    </option>
                    <option value="RAW_MATERIAL">
                      {pick('วัตถุดิบหลังร้าน / ต้มเตรียม (ซ่อนจากหน้าขาย POS)', 'ວັດຖຸດິບຫຼັງຮ້ານ / ຕົ້ມກຽມ (ຊ່ອນຈາກໜ້າຂາຍ POS)', 'Back-of-House Raw Material (Hidden on POS)')}
                    </option>
                  </>
                )}
              </select>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !catNameInput.trim()}
                onClick={() => void handleSaveCategory()}
                className={`flex-1 h-[46px] rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {catEditingId
                  ? pick('บันทึกการแก้ไขหมวดหมู่', 'ບັນທຶກການແກ້ໄຂໝວດໝູ່', 'Save Category Changes')
                  : pick('+ เพิ่มหมวดหมู่ใหม่', '+ ເພີ່ມໝວດໝູ່ໃໝ່', '+ Create Category')}
              </button>
              {catEditingId && (
                <button
                  type="button"
                  onClick={() => {
                    setCatEditingId(null);
                    setCatNameInput('');
                  }}
                  className={`h-[46px] rounded-[48px] border border-hairline bg-canvas px-4 text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </div>

          <div className="xl:col-span-7 rounded-[4px] border border-hairline bg-canvas overflow-hidden">
            <div className="border-b border-hairline bg-surface-1 px-5 py-4">
              <h3 className="font-google-display text-[18px] font-normal text-ink">
                {pick('รายการหมวดหมู่ทั้งหมด', 'ລາຍການໝວດໝູ່ທັງໝົດ', 'All Categories')} ({profileWarehouseCategories.length}{' '}
                {pick('หมวดหมู่ในโหมด', 'ໝວດໝູ່ໃນໂໝດ', 'categories in')} {bootstrap.profile})
              </h3>
            </div>
            <div className="divide-y divide-hairline">
              {profileWarehouseCategories.length === 0 ? (
                <div className="py-12 text-center text-xs text-ink-muted">
                  {pick(
                    'ยังไม่มีหมวดหมู่ในโหมดธุรกิจนี้ — สร้างหมวดหมู่ใหม่ได้จากฟอร์มด้านซ้าย',
                    'ຍັງບໍ່ມີໝວດໝູ່ໃນໂໝດທຸລະກິດນີ້ — ສ້າງໝວດໝູ່ໃໝ່ໄດ້ຈາກຟອມດ້ານຊ້າຍ',
                    'No categories in this business profile — create one on the left'
                  )}
                </div>
              ) : (
                profileWarehouseCategories.map((cat) => {
                  const dept = getCategoryDepartment(cat);
                  const countInCat = bootstrap.catalogDetailed.filter(
                    (v) => v.categoryId === cat.id
                  ).length;
                  return (
                    <div
                      key={cat.id}
                      className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-surface-1 transition-colors duration-150"
                    >
                      <div className="space-y-0.5">
                        <div className="font-google-display text-sm font-medium text-ink flex items-center gap-2">
                          <span>{cat.name}</span>
                          <span className="rounded-[48px] border border-hairline bg-surface-1 px-2.5 py-0.5 text-[11px] font-medium text-primary-dark">
                            {getDepartmentThaiLabel(dept, locale)}
                          </span>
                        </div>
                        <div className="text-[11px] text-ink-muted tabular-nums-google">
                          ID: {cat.id} · {pick('สถานี', 'ສະຖານີ', 'Station')} {cat.kitchenStation} ·{' '}
                          {pick(`มีสินค้า ${countInCat} รายการ`, `ມີສິນຄ້າ ${countInCat} ລາຍການ`, `${countInCat} items`)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setCatEditingId(cat.id);
                            setCatNameInput(cat.name);
                            setCatDeptInput(dept);
                          }}
                          className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1.5 text-[11px] font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                        >
                          {pick('แก้ไขชื่อ', 'ແກ້ໄຂຊື່', 'Rename')}
                        </button>
                        <button
                          type="button"
                          aria-label={pick(`ลบหมวดหมู่ ${cat.name}`, `ລຶບໝວດໝູ່ ${cat.name}`, `Delete category ${cat.name}`)}
                          onClick={() => setConfirmDeleteCategory(cat)}
                          className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-canvas text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 1.5: MODIFIER GROUPS & ITEMS CRUD */}
      {subTab === 'MODIFIERS' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <div className="xl:col-span-5 space-y-5">
            {/* Create Group */}
            <div className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-4 text-xs">
              <h3 className="font-google-display text-[18px] font-normal text-ink">
                {pick(
                  '1. สร้างกลุ่มตัวเลือกเสริมใหม่ (ความหวาน / ท็อปปิ้ง)',
                  '1. ສ້າງກຸ່ມຕົວເລືອກເສີມໃໝ່ (ຄວາມຫວານ / ທັອບປິ້ງ)',
                  '1. Create Modifier Group (Sweetness / Toppings)'
                )}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  type="text"
                  aria-label={pick('ชื่อกลุ่มตัวเลือกเสริม', 'ຊື່ກຸ່ມຕົວເລືອກເສີມ', 'Modifier group name')}
                  placeholder={pick('ชื่อกลุ่มตัวเลือก...', 'ຊື່ກຸ່ມຕົວເລືອກ...', 'Group name...')}
                  value={modGroupName}
                  onChange={(e) => setModGroupName(e.target.value)}
                  className={`sm:col-span-2 h-11 rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                />
                <select
                  aria-label={pick('ประเภทการเลือกกลุ่มตัวเลือก', 'ປະເພດການເລືອກກຸ່ມຕົວເລືອກ', 'Modifier selection type')}
                  value={modGroupType}
                  onChange={(e) => setModGroupType(e.target.value as 'SINGLE' | 'MULTIPLE')}
                  className={`h-11 rounded-[4px] border border-hairline bg-canvas px-2.5 text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value="SINGLE">{pick('เลือก 1 ข้อ', 'ເລືອກ 1 ຂໍ້', 'Single Choice')}</option>
                  <option value="MULTIPLE">{pick('เลือกหลายข้อ', 'ເລືອກຫຼາຍຂໍ້', 'Multi-Select')}</option>
                </select>
              </div>
              <button
                type="button"
                disabled={busy || !modGroupName.trim()}
                onClick={() => void handleCreateModifierGroup()}
                className={`h-[46px] w-full rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('+ สร้างกลุ่มตัวเลือกเสริม', '+ ສ້າງກຸ່ມຕົວເລືອກເສີມ', '+ Create Modifier Group')}
              </button>
            </div>

            {/* Create Modifier Item */}
            <div className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-4 text-xs">
              <h3 className="font-google-display text-[18px] font-normal text-ink">
                {pick('2. เพิ่มรายการย่อยในกลุ่มตัวเลือก', '2. ເພີ່ມລາຍການຍ່ອຍໃນກຸ່ມຕົວເລືອກ', '2. Add Option to Modifier Group')}
              </h3>
              {bootstrap.modifierGroups.length === 0 ? (
                <div className="rounded-[8px] bg-primary-soft p-4 text-xs text-ink">
                  {pick(
                    'กรุณาสร้างกลุ่มตัวเลือกเสริมในฟอร์มด้านบนอย่างน้อย 1 กลุ่มก่อนเพิ่มรายการย่อย',
                    'ກະລຸນາສ້າງກຸ່ມຕົວເລືອກເສີມໃນຟອມດ້ານເທິງຢ່າງໜ້ອຍ 1 ກຸ່ມກ່ອນເພີ່ມລາຍການຍ່ອຍ',
                    'Create at least 1 modifier group above before adding options'
                  )}
                </div>
              ) : (
                <>
                  <div>
                    <label htmlFor={`${uid}-mod-group`} className="block text-ink-muted mb-1">
                      {pick('เลือกกลุ่มเป้าหมาย', 'ເລືອກກຸ່ມເປົ້າໝາຍ', 'Target Group')}
                    </label>
                    <select
                      id={`${uid}-mod-group`}
                      value={modTargetGroupId}
                      onChange={(e) => setModTargetGroupId(e.target.value)}
                      className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                    >
                      {bootstrap.modifierGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.selectionType})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label htmlFor={`${uid}-mod-name`} className="block text-ink-muted mb-1">
                        {pick('ชื่อตัวเลือก', 'ຊື່ຕົວເລືອກ', 'Option Name')}
                      </label>
                      <input
                        id={`${uid}-mod-name`}
                        type="text"
                        placeholder={pick('เช่น หวานน้อย 25%, เพิ่มบุก', 'ເຊັ່ນ ຫວານໜ້ອຍ 25%, ເພີ່ມໄຂ່ມຸກ', 'e.g. 25% Sugar, Extra Boba')}
                        value={modItemName}
                        onChange={(e) => setModItemName(e.target.value)}
                        className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${uid}-mod-price`} className="block text-ink-muted mb-1">
                        {pick('ราคาบวกเพิ่ม', 'ລາຄາບວກເພີ່ມ', 'Price Delta')} ({currencyCode})
                      </label>
                      <input
                        id={`${uid}-mod-price`}
                        type="text"
                        value={modPriceDeltaBaht}
                        onChange={(e) => setModPriceDeltaBaht(e.target.value)}
                        className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-right text-primary-hover font-medium tabular-nums-google ${UI_INTERACTION.focusControl}`}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor={`${uid}-mod-mode`} className="block text-ink-muted mb-1">
                      {pick('กลไกตัดสต็อกเบื้องหลัง', 'ກົນໄກຕັດສະຕັອກເບື້ອງຫຼັງ', 'Backend Stock Deduction Mode')}
                    </label>
                    <select
                      id={`${uid}-mod-mode`}
                      value={modMode}
                      onChange={(e) =>
                        setModMode(e.target.value as 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS')
                      }
                      className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                    >
                      <option value="FIXED_QTY_DELTA">
                        {pick('ตัดสต็อกวัตถุดิบตามปริมาณคงที่ (+40g)', 'ຕັດສະຕັອກວັດຖຸດິບຕາມປະລິມານຄົງທີ່ (+40g)', 'Fixed Ingredient Qty Delta (+40g)')}
                      </option>
                      <option value="ROLE_SCALE_BPS">
                        {pick('ปรับเปอร์เซ็นต์ตามบทบาทวัตถุดิบ (-75%)', 'ປັບເປີເຊັນຕາມບົດບາດວັດຖຸດິບ (-75%)', 'Scale Ingredient Role % (-75%)')}
                      </option>
                    </select>
                  </div>

                  {modMode === 'FIXED_QTY_DELTA' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label htmlFor={`${uid}-mod-comp`} className="block text-ink-muted mb-1">
                          {pick('วัตถุดิบที่จะตัดเพิ่ม', 'ວັດຖຸດິບທີ່ຈະຕັດເພີ່ມ', 'Extra Deducted Ingredient')}
                        </label>
                        <select
                          id={`${uid}-mod-comp`}
                          value={modCompVariantId}
                          onChange={(e) => setModCompVariantId(e.target.value)}
                          className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                        >
                          <option value="">
                            {pick('ไม่ตัดสต็อกวัตถุดิบ (ปรับราคาอย่างเดียว)', 'ບໍ່ຕັດສະຕັອກວັດຖຸດິບ (ປັບລາຄາຢ່າງດຽວ)', 'No stock deduction (price adjustment only)')}
                          </option>
                          {bootstrap.catalogDetailed.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.itemName} ({v.unitName})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${uid}-mod-qty`} className="block text-ink-muted mb-1">
                          {pick('ปริมาณที่ตัดเพิ่ม', 'ປະລິມານທີ່ຕັດເພີ່ມ', 'Additional Deduction Qty')}
                        </label>
                        <input
                          id={`${uid}-mod-qty`}
                          type="text"
                          value={modQtyDeltaInput}
                          onChange={(e) => setModQtyDeltaInput(e.target.value)}
                          className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-right text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label htmlFor={`${uid}-mod-role`} className="block text-ink-muted mb-1">
                          {pick('บทบาทวัตถุดิบในสูตร', 'ບົດບາດວັດຖຸດິບໃນສູດ', 'Recipe Component Role')}
                        </label>
                        <select
                          id={`${uid}-mod-role`}
                          value={modRoleTarget}
                          onChange={(e) => setModRoleTarget(e.target.value as ComponentRole)}
                          className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                        >
                          <option value="SWEETENER">{pick('SWEETENER (ความหวาน/ไซรัป)', 'SWEETENER (ຄວາມຫວານ/ນ້ຳເຊື່ອມ)', 'SWEETENER (Sugar / Syrup)')}</option>
                          <option value="COFFEE_SHOT">{pick('COFFEE_SHOT (ช็อตกาแฟ)', 'COFFEE_SHOT (ຊັອດກາເຟ)', 'COFFEE_SHOT (Espresso)')}</option>
                          <option value="MILK_BASE">{pick('MILK_BASE (นม)', 'MILK_BASE (ນົມ)', 'MILK_BASE (Milk)')}</option>
                          <option value="TEA_BASE">{pick('TEA_BASE (เบสชา)', 'TEA_BASE (ເບສຊາ)', 'TEA_BASE (Tea Base)')}</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${uid}-mod-scale`} className="block text-ink-muted mb-1">
                          {pick('% ที่เปลี่ยนแปลง (เช่น -50)', '% ທີ່ປ່ຽນແປງ (ເຊັ່ນ -50)', '% Change (e.g. -50)')}
                        </label>
                        <input
                          id={`${uid}-mod-scale`}
                          type="text"
                          value={modScalePctInput}
                          onChange={(e) => setModScalePctInput(e.target.value)}
                          className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-right text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                        />
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={busy || !modItemName.trim() || !modTargetGroupId}
                    onClick={() => void handleCreateModifierItem()}
                    className={`h-[46px] w-full rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                  >
                    {pick('+ บันทึกตัวเลือกเสริมเข้าสู่หน้าขาย POS', '+ ບັນທຶກຕົວເລືອກເສີມເຂົ້າສູ່ໜ້າຂາຍ POS', '+ Save Option to POS Menu')}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Existing Modifier Groups & Items List */}
          <div className="xl:col-span-7 space-y-4">
            {bootstrap.modifierGroups.length === 0 ? (
              <div className="rounded-[4px] border border-hairline bg-canvas p-12 text-center text-xs text-ink-muted">
                {pick(
                  'ยังไม่มีกลุ่มตัวเลือกเสริมในระบบ — สร้างกลุ่มใหม่ทางด้านซ้าย (เช่น ระดับความหวาน, ท็อปปิ้ง)',
                  'ຍັງບໍ່ມີກຸ່ມຕົວເລືອກເສີມໃນລະບົບ — ສ້າງກຸ່ມໃໝ່ທາງດ້ານຊ້າຍ (ເຊັ່ນ ລະດັບຄວາມຫວານ, ທັອບປິ້ງ)',
                  'No modifier groups yet — create one on the left (e.g. Sweetness, Toppings)'
                )}
              </div>
            ) : (
              bootstrap.modifierGroups.map((group) => (
              <div
                key={group.id}
                className="rounded-[4px] border border-hairline bg-canvas p-5 space-y-4"
              >
                <div className="flex items-center justify-between border-b border-hairline pb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="font-google-display text-[18px] font-normal text-ink">
                      {group.name}
                    </span>
                    <span className="rounded-[48px] border border-hairline bg-surface-1 px-2.5 py-0.5 text-[11px] font-medium text-primary-dark">
                      {group.selectionType}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmDeleteMod({ kind: 'group', id: group.id, name: group.name })
                    }
                    className={`rounded-[48px] border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-ink-muted hover:border-ink hover:text-ink flex items-center gap-1 ${UI_INTERACTION.focusButton}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {pick('ลบกลุ่ม', 'ລຶບກຸ່ມ', 'Delete Group')}
                  </button>
                </div>

                {group.modifiers.length === 0 ? (
                  <div className="rounded-[4px] border border-hairline bg-surface-1 py-5 text-center text-xs text-ink-muted">
                    {pick('ยังไม่มีตัวเลือกย่อยในกลุ่มนี้', 'ຍັງບໍ່ມີຕົວເລືອກຍ່ອຍໃນກຸ່ມນີ້', 'No options in this group yet')}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {group.modifiers.map((mod) => (
                      <div
                        key={mod.id}
                        className="rounded-[4px] border border-hairline bg-surface-1 p-3.5 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-medium text-ink">{mod.name}</div>
                          <div className="text-[11px] tabular-nums-google text-primary-hover mt-0.5">
                            {mod.priceDeltaSatang > 0
                              ? `+${money(mod.priceDeltaSatang)}`
                              : mod.priceDeltaSatang < 0
                                ? `-${money(Math.abs(mod.priceDeltaSatang))}`
                                : pick('ไม่บวกราคา', 'ບໍ່ບວກລາຄາ', 'No charge')}{' '}
                            ·{' '}
                            <span className="text-ink-muted">
                              {mod.modifierMode === 'ROLE_SCALE_BPS'
                                ? `${mod.targetComponentRole} ${mod.scaleBasisPoints / 100}%`
                                : mod.componentVariantId
                                  ? `${mod.quantityDeltaMilli >= 0 ? '+' : ''}${mod.quantityDeltaMilli / 1000} ${pick('หน่วย', 'ໜ່ວຍ', 'units')}`
                                  : pick('ไม่ตัดสต็อก', 'ບໍ່ຕັດສະຕັອກ', 'No stock deduction')}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={pick(`ลบ ${mod.name}`, `ລຶບ ${mod.name}`, `Delete ${mod.name}`)}
                          onClick={() =>
                            setConfirmDeleteMod({ kind: 'item', id: mod.id, name: mod.name })
                          }
                          className={`flex h-11 w-11 items-center justify-center rounded-full text-ink-muted hover:bg-canvas hover:text-ink ${UI_INTERACTION.focusButton}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: PURCHASE ORDER & EXACT LANDED COST APPORTIONMENT */}
      {subTab === 'PO_LANDED' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-ink">
                  {pick(
                    'ออกใบรับสินค้าเข้าคลัง (PO) & ปันส่วนค่าขนส่งแฝง',
                    'ອອກໃບຮັບສິນຄ້າເຂົ້າສາງ (PO) & ປັນສ່ວນຄ່າຂົນສົ່ງແຝງ',
                    'Receive Purchase Order (PO) & Landed Cost Allocation'
                  )}
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  {pick(
                    'คำนวณด้วยสมการ i128 Largest Remainder กระจายเศษไมโครบาทครบ 100%',
                    'ຄຳນວນດ້ວຍສົມຜົນ i128 Largest Remainder ກະຈາຍເສດຄ່າໃຊ້ຈ່າຍຄົບ 100%',
                    'Allocated via exact i128 Largest Remainder rounding with 100% conservation'
                  )}
                </p>
              </div>
              <select
                aria-label={pick('เลือกผู้จำหน่ายสำหรับใบรับสินค้า', 'ເລືອກຜູ້ຈຳໜ່າຍສຳລັບໃບຮັບສິນຄ້າ', 'Select PO Supplier')}
                value={poSupplierId}
                onChange={(e) => setPoSupplierId(e.target.value)}
                className={`h-11 max-w-full rounded-[4px] border border-hairline bg-canvas px-3 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
              >
                {bootstrap.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* PO Item Lines */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-muted">
                  {pick('รายการสินค้าที่รับเข้า', 'ລາຍການສິນຄ້າທີ່ຮັບເຂົ້າ', 'Received Line Items')}
                </span>
                <button
                  type="button"
                  disabled={purchasableVariants.length === 0}
                  onClick={() =>
                    setPoLines((prev) => [
                      ...prev,
                      {
                        variantId: purchasableVariants[0]?.id ?? '',
                        qtyInput: '10.000',
                        unitCostBahtInput: purchasableVariants[0]
                          ? formatMicroUnitCostForInput(purchasableVariants[0].defaultPurchaseCostMicroBaht, currencyCode)
                          : isLaos
                            ? '10000'
                            : '10.0000',
                      },
                    ])
                  }
                  className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1 text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 flex items-center gap-1 ${UI_INTERACTION.focusButton}`}
                >
                  <Plus className="h-3.5 w-3.5" /> {pick('เพิ่มแถวสินค้า', 'ເພີ່ມແຖວສິນຄ້າ', 'Add Line')}
                </button>
              </div>

              {purchasableVariants.length === 0 ? (
                <div className="rounded-[8px] bg-primary-soft p-4 text-xs text-ink">
                  {pick(
                    'ยังไม่มีสินค้าหรือวัตถุดิบที่รับเข้าสต็อกได้ กรุณาเพิ่มรายการในแท็บ "ทะเบียนสินค้า & คลัง" ก่อนออกใบ PO',
                    'ຍັງບໍ່ມີສິນຄ້າ ຫຼື ວັດຖຸດິບທີ່ຮັບເຂົ້າສະຕັອກໄດ້ ກະລຸນາເພີ່ມໃນແທັບ "ທະບຽນສິນຄ້າ & ສາງ" ກ່ອນອອກໃບ PO',
                    'No stockable items yet — add items in the "Catalog & Stock" tab before creating a PO'
                  )}
                </div>
              ) : (
                poLines.map((line, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center rounded-[4px] border border-hairline bg-surface-1 p-2.5"
                >
                  <div className="sm:col-span-6">
                    <select
                      aria-label={pick(`สินค้าแถวที่ ${idx + 1}`, `ສິນຄ້າແຖວທີ ${idx + 1}`, `Item line ${idx + 1}`)}
                      value={line.variantId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLines((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, variantId: val } : r))
                        );
                      }}
                      className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
                    >
                      {bootstrap.catalogDetailed
                        .filter((v) => !v.isComposite || v.useProduction)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.itemName} ({v.unitName})
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="sm:col-span-3">
                    <input
                      type="text"
                      aria-label={pick(`จำนวนสินค้าแถวที่ ${idx + 1}`, `ຈຳນວນສິນຄ້າແຖວທີ ${idx + 1}`, `Quantity line ${idx + 1}`)}
                      value={line.qtyInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLines((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, qtyInput: val } : r))
                        );
                      }}
                      placeholder={pick('จำนวน', 'ຈຳນວນ', 'Qty')}
                      className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-right text-xs text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <input
                      type="text"
                      aria-label={pick(`ต้นทุนต่อหน่วยแถวที่ ${idx + 1}`, `ຕົ້ນທຶນຕໍ່ໜ່ວຍແຖວທີ ${idx + 1}`, `Unit cost line ${idx + 1}`)}
                      value={line.unitCostBahtInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLines((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, unitCostBahtInput: val } : r))
                        );
                      }}
                      placeholder={pick('ทุน/หน่วย', 'ທຶນ/ໜ່ວຍ', 'Unit Cost')}
                      className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-right text-xs text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                    />
                  </div>
                  <div className="sm:col-span-1 text-right sm:text-center">
                    {poLines.length > 1 && (
                      <button
                        type="button"
                        aria-label={pick(`ลบแถวสินค้าที่ ${idx + 1}`, `ລຶບແຖວສິນຄ້າທີ ${idx + 1}`, `Remove line ${idx + 1}`)}
                        onClick={() => setPoLines((prev) => prev.filter((_, i) => i !== idx))}
                        className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-muted hover:bg-canvas hover:text-ink ${UI_INTERACTION.focusButton}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))
              )}
            </div>

            {/* Landed Cost Lines */}
            <div className="space-y-2.5 pt-3 border-t border-hairline">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink-muted">
                  {pick('ค่าใช้จ่ายแฝงในการนำเข้า/ขนส่ง', 'ຄ່າໃຊ້ຈ່າຍແຝງໃນການຂົນສົ່ງ', 'Landed Costs')} ({currencyCode})
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPoLandedCosts((prev) => [
                      ...prev,
                      {
                        costType: 'HANDLING',
                        description: isLaos
                          ? pick('ค่ายกของ/แช่เย็น', 'ຄ່າຈັດການ/ແຊ່ເຢັນ', 'Handling / Cold Storage')
                          : pick('ค่ายกของ/แช่เย็น', 'ຄ່າຈັດການ/ແຊ່ເຢັນ', 'Handling / Cold Storage'),
                        amountBahtInput: isLaos ? '20000' : '100.00',
                      },
                    ])
                  }
                  className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1 text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 flex items-center gap-1 ${UI_INTERACTION.focusButton}`}
                >
                  <Plus className="h-3.5 w-3.5" /> {pick('เพิ่มค่าขนส่งแฝง', 'ເພີ່ມຄ່າຂົນສົ່ງແຝງ', 'Add Landed Cost')}
                </button>
              </div>
              {poLandedCosts.map((lc, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center rounded-[4px] border border-hairline bg-surface-1 p-2.5"
                >
                  <div className="sm:col-span-4">
                    <select
                      aria-label={pick(`ประเภทค่าใช้จ่ายแฝงที่ ${idx + 1}`, `ປະເພດຄ່າໃຊ້ຈ່າຍແຝງທີ ${idx + 1}`, `Landed cost type ${idx + 1}`)}
                      value={lc.costType}
                      onChange={(e) => {
                        const val = e.target.value as typeof lc.costType;
                        setPoLandedCosts((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, costType: val } : r))
                        );
                      }}
                      className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
                    >
                      <option value="FREIGHT">{pick('FREIGHT (ค่าขนส่ง)', 'FREIGHT (ຄ່າຂົນສົ່ງ)', 'FREIGHT (Shipping)')}</option>
                      <option value="CUSTOMS_DUTY">{pick('CUSTOMS (ภาษีนำเข้า)', 'CUSTOMS (ພາສີນຳເຂົ້າ)', 'CUSTOMS (Import Duty)')}</option>
                      <option value="INSURANCE">{pick('INSURANCE (ประกันภัย)', 'INSURANCE (ປະກັນໄພ)', 'INSURANCE (Cargo Ins.)')}</option>
                      <option value="HANDLING">{pick('HANDLING (ค่าจัดการ)', 'HANDLING (ຄ່າຈັດການ)', 'HANDLING (Handling Fee)')}</option>
                    </select>
                  </div>
                  <div className="sm:col-span-5">
                    <input
                      type="text"
                      aria-label={pick(`รายละเอียดค่าใช้จ่ายแฝงที่ ${idx + 1}`, `ລາຍລະອຽດຄ່າໃຊ້ຈ່າຍແຝງທີ ${idx + 1}`, `Landed cost description ${idx + 1}`)}
                      value={lc.description}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLandedCosts((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, description: val } : r))
                        );
                      }}
                      className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <input
                      type="text"
                      aria-label={pick(`จำนวนเงินค่าใช้จ่ายแฝงที่ ${idx + 1}`, `ຈຳນວນເງິນຄ່າໃຊ້ຈ່າຍແຝງທີ ${idx + 1}`, `Landed cost amount ${idx + 1}`)}
                      value={lc.amountBahtInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLandedCosts((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, amountBahtInput: val } : r))
                        );
                      }}
                      className={`h-10 w-full rounded-[4px] border border-hairline bg-canvas px-2.5 text-right text-xs font-medium text-primary-hover tabular-nums-google ${UI_INTERACTION.focusControl}`}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                disabled={busy || poLines.length === 0 || purchasableVariants.length === 0 || bootstrap.suppliers.length === 0}
                onClick={() => void handlePreviewPo()}
                className={`h-[48px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                {pick('จำลองคำนวณ MAC ก่อนรับจริง (Preview)', 'ຈຳລອງຄຳນວນ MAC ກ່ອນຮັບຈິງ (Preview)', 'Preview MAC Allocation')}
              </button>
              <button
                type="button"
                disabled={busy || poLines.length === 0 || purchasableVariants.length === 0 || bootstrap.suppliers.length === 0}
                onClick={() => void handleReceivePo()}
                className={`h-[48px] rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ยืนยันรับของเข้าคลัง & อัปเดต MAC', 'ຢືນຢັນຮັບເຄື່ອງເຂົ້າສາງ & ອັບເດດ MAC', 'Post Purchase Order & Update MAC')}
              </button>
            </div>
          </div>

          {/* Right: Live Preview + Recent PO History */}
          <div className="lg:col-span-5 space-y-5">
            {lastReceivedPoBatch && lastReceivedPoBatch.items.length > 0 && (
              <div className="rounded-[8px] border border-primary/30 bg-primary-soft p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-google-display text-sm font-medium text-primary-dark">
                      {pick('รับสินค้าใบ PO', 'ຮັບສິນຄ້າໃບ PO', 'Received PO')} {lastReceivedPoBatch.poNumber}{' '}
                      {pick('สำเร็จ', 'ສຳເລັດ', 'successfully')}
                    </div>
                    <div className="text-[11px] text-ink-soft">
                      {pick(
                        `พร้อมส่งสินค้าที่รับเข้าทั้ง ${lastReceivedPoBatch.items.length} รายการไปพิมพ์สติกเกอร์บาร์โค้ดติดกล่อง/ซอง`,
                        `ພ້ອມສົ່ງສິນຄ້າທີ່ຮັບເຂົ້າທັງ ${lastReceivedPoBatch.items.length} ລາຍການໄປພິມສະຕິກເກີບາໂຄດ`,
                        `Ready to send all ${lastReceivedPoBatch.items.length} received item(s) to barcode label printing`
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setBarcodeQueue(lastReceivedPoBatch.items);
                    setSubTab('BARCODE_PRINT');
                    onToast(
                      pick(
                        `โหลดสินค้าจากใบรับของ ${lastReceivedPoBatch.poNumber} เข้าคิวพิมพ์บาร์โค้ดแล้ว`,
                        `ໂຫຼດສິນຄ້າຈາກໃບຮັບເຄື່ອງ ${lastReceivedPoBatch.poNumber} ເຂົ້າຄິວພິມບາໂຄດແລ້ວ`,
                        `Queued items from PO ${lastReceivedPoBatch.poNumber} for barcode labels`
                      ),
                      'success'
                    );
                  }}
                  className={`inline-flex h-10 w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-4 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                >
                  <Printer className="h-4 w-4" />
                  <span>
                    {pick(
                      'พิมพ์สติกเกอร์บาร์โค้ดตามจำนวนที่รับเข้า PO นี้',
                      'ພິມສະຕິກເກີບາໂຄດຕາມຈຳນວນທີ່ຮັບເຂົ້າ PO ນີ້',
                      'Print Labels for Received PO Quantities'
                    )}
                  </span>
                </button>
              </div>
            )}
            {poPreviewLines && (
              <div className="rounded-[8px] bg-primary-soft p-5 space-y-3">
                <h4 className="font-google-display text-sm font-medium text-primary-dark">
                  {pick(
                    'ผลการปันส่วนค่าขนส่งแฝง & ต้นทุนเฉลี่ยใหม่ (Preview)',
                    'ຜົນການປັນສ່ວນຄ່າຂົນສົ່ງແຝງ & ຕົ້ນທຶນສະເລ່ຍໃໝ່ (Preview)',
                    'Landed Cost Allocation & New MAC Preview'
                  )}
                </h4>
                <div className="space-y-2.5">
                  {poPreviewLines.map((p) => (
                    <div
                      key={p.variantId}
                      className="rounded-[4px] border border-hairline bg-canvas p-3.5 text-xs space-y-1"
                    >
                      <div className="font-medium text-ink">{p.itemName}</div>
                      <div className="flex justify-between text-ink-muted tabular-nums-google">
                        <span>{pick('ต้นทุนสุทธิรวมค่าขนส่ง/หน่วย:', 'ຕົ້ນທຶນສຸດທິລວມຄ່າຂົນສົ່ງ/ໜ່ວຍ:', 'Effective Unit Cost:')}</span>
                        <span className="font-medium text-ink">
                          {unitCost(p.effectiveUnitCostMicroBaht)}
                        </span>
                      </div>
                      <div className="flex justify-between text-ink-muted tabular-nums-google">
                        <span>{pick('MAC เดิม → MAC ใหม่:', 'MAC ເກົ່າ → MAC ໃໝ່:', 'MAC Before → After:')}</span>
                        <span className="font-medium text-primary-hover">
                          {unitCost(p.macBeforeMicroBaht)} → {unitCost(p.macAfterMicroBaht)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-[4px] border border-hairline bg-canvas p-6">
              <h4 className="font-google-display text-[18px] font-normal text-ink mb-3">
                {pick('ประวัติใบรับสินค้า (PO History)', 'ປະຫວັດໃບຮັບສິນຄ້າ (PO History)', 'Purchase Order History')}
              </h4>
              <div className="divide-y divide-hairline rounded-[4px] border border-hairline max-h-96 overflow-y-auto">
                {poHistory.length === 0 ? (
                  <p className="text-xs text-ink-muted py-8 text-center">
                    {pick('ยังไม่มีประวัติใบสั่งซื้อ', 'ຍັງບໍ່ມີປະຫວັດໃບສັ່ງຊື້', 'No purchase order history yet')}
                  </p>
                ) : (
                  poHistory.map((po) => (
                    <div
                      key={po.id}
                      className="bg-canvas px-4 py-3 flex items-center justify-between text-xs hover:bg-surface-1 transition-colors duration-150"
                    >
                      <div>
                        <div className="font-medium text-ink tabular-nums-google">
                          {po.poNumber}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {po.supplierName} · {po.lineCount} {pick('รายการ', 'ລາຍການ', 'items')}
                        </div>
                      </div>
                      <div className="text-right tabular-nums-google">
                        <div className="font-medium text-ink">
                          {money(po.grandTotalSatang)}
                        </div>
                        <div className="text-[11px] text-primary-hover">
                          {pick('ค่าขนส่ง', 'ຄ່າຂົນສົ່ງ', 'Landed')} {money(po.totalLandedCostSatang)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: BATCH PREP PRODUCTION */}
      {subTab === 'PREP_BUILD' && (
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden max-w-2xl">
          <div className="bg-hero p-6 text-white">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.5px] text-white/75">
              <Factory className="h-4 w-4 text-primary" />
              <span>Pre-Built Batch Production (use_production = 1)</span>
            </div>
            <h3 className="mt-1.5 font-google-display text-[26px] font-normal leading-[34px] tracking-[-0.25px]">
              {pick('สั่งผลิตของเตรียมขายล่วงหน้า', 'ສັ່ງຜະລິດຂອງກຽມຂາຍລ່ວງໜ້າ', 'Build Pre-Built Batch Inventory')}
            </h3>
            <p className="text-xs text-white/75 mt-1">
              {pick(
                'ตัดสต็อกวัตถุดิบตั้งต้นทันทีและคำนวณต้นทุน MAC ของวัตถุดิบกึ่งสำเร็จรูปล็อตใหม่',
                'ຕັດສະຕັອກວັດຖຸດິບຕັ້ງຕົ້ນທັນທີ ແລະ ຄຳນວນຕົ້ນທຶນ MAC ຂອງວັດຖຸດິບເຄິ່ງສຳເລັດຮູບລັອດໃໝ່',
                'Deducts raw ingredients immediately and updates MAC for the pre-built batch'
              )}
            </p>
          </div>

          <div className="p-6 space-y-5">
            {prepCandidates.length === 0 ? (
              <div className="rounded-[4px] border border-hairline bg-surface-1 p-5 text-xs text-ink-muted">
                {pick(
                  'ยังไม่มีสินค้ากึ่งสำเร็จรูปในคลัง กรุณาสร้างรายการในแท็บ "ทะเบียนสินค้า & คลัง" และติ๊กเลือก ',
                  'ຍັງບໍ່ມີສິນຄ້າເຄິ່ງສຳເລັດຮູບໃນສາງ ກະລຸນາສ້າງລາຍການໃນແທັບ "ທະບຽນສິນຄ້າ & ສາງ" ແລະ ຕິກເລືອກ ',
                  'No pre-built items yet — create one in "Catalog & Stock" and check '
                )}
                <strong className="text-ink">
                  {pick('ต้มเตรียมล่วงหน้า (Pre-Built)', 'ຕົ້ມກຽມລ່ວງໜ້າ (Pre-Built)', 'Pre-Built Batch')}
                </strong>{' '}
                {pick('ก่อนสั่งผลิต', 'ກ່ອນສັ່ງຜະລິດ', 'before producing.')}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <label htmlFor={`${uid}-prep-var`} className="block font-medium text-ink-muted mb-1.5">
                    {pick('เลือกรายการกึ่งสำเร็จรูป (Pre-Built Node)', 'ເລືອກລາຍການເຄິ່ງສຳເລັດຮູບ (Pre-Built Node)', 'Select Pre-Built Item')}
                  </label>
                  <select
                    id={`${uid}-prep-var`}
                    value={prepVariantId}
                    onChange={(e) => setPrepVariantId(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink ${UI_INTERACTION.focusSelect}`}
                  >
                    {prepCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.itemName} ({pick('คงเหลือ', 'ຄົງເຫຼືອ', 'On Hand')}{' '}
                        {formatMilliUnitsToQtyString(c.inStockMilli, c.unitName)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={`${uid}-prep-qty`} className="block font-medium text-ink-muted mb-1.5">
                    {pick('ปริมาณที่ผลิตได้ในรอบนี้', 'ປະລິມານທີ່ຜະລິດໄດ້ໃນຮອບນີ້', 'Batch Yield Quantity')}
                  </label>
                  <input
                    id={`${uid}-prep-qty`}
                    type="text"
                    value={prepQtyInput}
                    onChange={(e) => setPrepQtyInput(e.target.value)}
                    className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-base font-medium text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
              </div>
            )}

            <button
              type="button"
              disabled={busy || prepCandidates.length === 0}
              onClick={() => void handlePrepBuild()}
              className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              {pick(
                'บันทึกการผลิตล็อตใหม่ & ตัดวัตถุดิบตั้งต้นอัตโนมัติ',
                'ບັນທຶກການຜະລິດລັອດໃໝ່ & ຕັດວັດຖຸດິບຕັ້ງຕົ້ນອັດຕະໂນມັດ',
                'Record Production Batch & Deduct Raw Ingredients'
              )}
            </button>
          </div>
        </div>
      )}

      {/* TAB 4: PHYSICAL STOCKTAKE & INTER-OUTLET TRANSFERS */}
      {subTab === 'STOCKTAKE_TRANSFER' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Stocktake Worksheet */}
          <div className="xl:col-span-7 rounded-[4px] border border-hairline bg-canvas p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-primary" />
                  <span>
                    {pick(
                      'ใบตรวจนับสต็อกจริง (Physical Stocktake · RE_COUNT)',
                      'ໃບກວດນັບສະຕັອກຈິງ (Physical Stocktake · RE_COUNT)',
                      'Physical Stocktake Sheet (RE_COUNT)'
                    )}
                  </span>
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  {pick(
                    'กรอกเฉพาะรายการที่ต้องการปรับยอดให้ตรงกับของจริงบนชั้นวาง',
                    'ປ້ອນສະເພາະລາຍການທີ່ຕ້ອງການປັບຍອດໃຫ້ຕົງກັບຂອງຈິງເທິງຊັ້ນວາງ',
                    'Enter physical counts only for items needing reconciliation'
                  )}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleExecuteStocktake()}
                className={`h-[44px] rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ยืนยันผลตรวจนับสต็อก', 'ຢືນຢັນຜົນກວດນັບສະຕັອກ', 'Post Stocktake Variance')}
              </button>
            </div>

            <div className="overflow-x-auto max-h-96 rounded-[4px] border border-hairline">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                  <tr>
                    <th scope="col" className="py-2.5 px-3">{pick('รายการ', 'ລາຍການ', 'Item')}</th>
                    <th scope="col" className="py-2.5 px-3 text-right">{pick('ยอดในระบบ', 'ຍອດໃນລະບົບ', 'System Qty')}</th>
                    <th scope="col" className="py-2.5 px-3 text-right">{pick('ยอดนับจริง', 'ຍອດນັບຈິງ', 'Counted Qty')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline bg-canvas">
                  {purchasableVariants.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-10 text-center text-ink-muted">
                        {pick(
                          'ยังไม่มีรายการสินค้าหรือวัตถุดิบสำหรับตรวจนับสต็อก',
                          'ຍັງບໍ່ມີລາຍການສິນຄ້າ ຫຼື ວັດຖຸດິບສຳລັບກວດນັບສະຕັອກ',
                          'No inventory items available to count'
                        )}
                      </td>
                    </tr>
                  ) : (
                    purchasableVariants.map((v) => (
                      <tr key={v.id} className="hover:bg-surface-1 transition-colors duration-150">
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-ink">{v.itemName}</div>
                          <div className="text-[11px] text-ink-muted tabular-nums-google">
                            {v.sku}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right text-ink-soft tabular-nums-google">
                          {formatMilliUnitsToQtyString(v.inStockMilli, v.unitName)}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <input
                            type="text"
                            aria-label={pick(`ยอดนับจริงของ ${v.itemName}`, `ຍອດນັບຈິງຂອງ ${v.itemName}`, `Physical count for ${v.itemName}`)}
                            placeholder={formatMilliUnitsToQtyString(v.inStockMilli)}
                            value={stocktakeInputs[v.id] ?? ''}
                            onChange={(e) =>
                              setStocktakeInputs((prev) => ({ ...prev, [v.id]: e.target.value }))
                            }
                            className={`h-9 w-28 rounded-[4px] border border-hairline bg-canvas px-2.5 text-right text-xs font-medium text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Multi-Outlet Stock Transfer */}
          <div className="xl:col-span-5 rounded-[4px] border border-hairline bg-canvas p-6 space-y-4">
            <h3 className="font-google-display text-[20px] font-normal text-ink flex items-center gap-2">
              <ArrowLeftRight className="h-5 w-5 text-primary" />
              <span>{pick('โอนย้ายสต็อกระหว่างสาขา', 'ໂອນຍ້າຍສະຕັອກລະຫວ່າງສາຂາ', 'Inter-Branch Stock Transfers')}</span>
            </h3>

            {bootstrap.outlets.length < 2 && (
              <div className="rounded-[8px] bg-primary-soft p-4 space-y-2.5">
                <div className="text-xs font-medium text-ink">
                  {pick(
                    'เปิดสาขาที่ 2 เพื่อเริ่มใช้งานโอนสต็อกข้ามสาขา:',
                    'ເປີດສາຂາທີ 2 ເພື່ອເລີ່ມໃຊ້ງານໂອນສະຕັອກຂ້າມສາຂາ:',
                    'Create a 2nd branch to enable stock transfers:'
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    aria-label={pick('รหัสสาขาใหม่', 'ລະຫັດສາຂາໃໝ່', 'New branch code')}
                    value={newOutletCode}
                    onChange={(e) => setNewOutletCode(e.target.value)}
                    className={`h-10 w-full sm:w-24 rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                  <input
                    type="text"
                    aria-label={pick('ชื่อสาขาใหม่', 'ຊື່ສາຂາໃໝ່', 'New branch name')}
                    value={newOutletName}
                    onChange={(e) => setNewOutletName(e.target.value)}
                    className={`h-10 flex-1 rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateBranchOutlet()}
                    className={`h-10 rounded-[48px] bg-primary px-4 text-xs font-medium text-white hover:bg-primary-hover whitespace-nowrap ${UI_INTERACTION.focusButtonPrimary}`}
                  >
                    {pick('+ เปิดสาขา', '+ ເປີດສາຂາ', '+ Add Branch')}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3 text-xs">
            <div>
              <label htmlFor={`${uid}-tr-dest`} className="block text-ink-muted mb-1">
                {pick(`โอนจากสาขาปัจจุบัน (${outletId}) ไปยัง`, `ໂອນຈາກສາຂາປັດຈຸບັນ (${outletId}) ໄປຍັງ`, `Transfer from ${outletId} to`)}
              </label>
              <select
                id={`${uid}-tr-dest`}
                value={trDestOutletId}
                onChange={(e) => setTrDestOutletId(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
              >
                <option value="">{pick('-- เลือกสาขาปลายทาง --', '-- ເລືອກສາຂາປາຍທາງ --', '-- Select Destination Branch --')}</option>
                {bootstrap.outlets
                  .filter((o) => o.id !== outletId)
                  .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.code} — {o.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  aria-label={pick('เลือกสินค้าที่จะโอนย้าย', 'ເລືອກສິນຄ້າທີ່ຈະໂອນຍ້າຍ', 'Select item to transfer')}
                  value={trVariantId}
                  onChange={(e) => setTrVariantId(e.target.value)}
                  className={`sm:col-span-2 h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  {bootstrap.catalogDetailed
                    .filter((v) => !v.isComposite || v.useProduction)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.itemName}
                      </option>
                    ))}
                </select>
                <input
                  type="text"
                  aria-label={pick('จำนวนที่โอนย้าย', 'ຈຳນວນທີ່ໂອນຍ້າຍ', 'Transfer quantity')}
                  value={trQtyInput}
                  onChange={(e) => setTrQtyInput(e.target.value)}
                  className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-right text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <button
                type="button"
                disabled={busy || !trDestOutletId}
                onClick={() => void handleDispatchTransfer()}
                className={`h-[46px] w-full rounded-[48px] bg-primary px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ส่งออกใบโอนย้ายสต็อก (TRANSFER_OUT)', 'ສົ່ງອອກໃບໂອນຍ້າຍສະຕັອກ (TRANSFER_OUT)', 'Dispatch Stock Transfer (TRANSFER_OUT)')}
              </button>
            </div>

            <div className="divide-y divide-hairline rounded-[4px] border border-hairline max-h-60 overflow-y-auto">
              {transfersList.length === 0 ? (
                <div className="py-6 text-center text-xs text-ink-muted">
                  {pick('ยังไม่มีประวัติใบโอนย้ายสต็อกระหว่างสาขา', 'ຍັງບໍ່ມີປະຫວັດໃບໂອນຍ້າຍສະຕັອກລະຫວ່າງສາຂາ', 'No inter-branch transfers yet')}
                </div>
              ) : (
                transfersList.map((tr) => (
                  <div
                    key={tr.id}
                    className="bg-canvas px-4 py-3 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-ink tabular-nums-google">
                        {tr.transferNumber}
                      </div>
                      <div className="text-[11px] text-ink-muted">
                        {tr.sourceOutletName} → {tr.destinationOutletName} ({tr.status})
                      </div>
                      {tr.items.length > 0 && (
                        <div className="text-[11px] text-ink-soft mt-0.5 truncate tabular-nums-google">
                          {tr.items
                            .map(
                              (it) =>
                                `${it.itemName} ×${formatMilliUnitsToQtyString(it.quantityMilli, it.unitName)}`
                            )
                            .join(', ')}
                        </div>
                      )}
                    </div>
                    {tr.status === 'IN_TRANSIT' ? (
                      <button
                        type="button"
                        onClick={() => void handleReceiveTransfer(tr.id, tr.transferNumber)}
                        className={`shrink-0 rounded-[48px] bg-primary px-4 py-1.5 text-[11px] font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                      >
                        {pick('กดรับของเข้าสาขา', 'ກົດຮັບເຄື່ອງເຂົ້າສາຂາ', 'Confirm Receipt')}
                      </button>
                    ) : (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-primary-hover">
                        <CheckCircle2 className="h-3.5 w-3.5" /> {pick('สำเร็จ', 'ສຳເລັດ', 'Completed')}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: BARCODE LABEL PRINTING WORKSPACE */}
      {subTab === 'BARCODE_PRINT' && (
        <BarcodeLabelPrintWorkspace
          outletId={outletId}
          bootstrap={bootstrap}
          currentUser={currentUser}
          queueEntries={barcodeQueue}
          setQueueEntries={setBarcodeQueue}
          onRefreshState={onRefreshState}
          onToast={onToast}
        />
      )}

      {/* TAB 6: IMMUTABLE DOUBLE-ENTRY AUDIT LEDGER */}
      {subTab === 'LEDGER' && (
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="p-5 border-b border-hairline bg-surface-1 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <h3 className="font-google-display text-[18px] font-normal text-ink">
                  {pick(
                    'สมุดบัญชีความเคลื่อนไหวสต็อกห้ามแก้ไข/ลบ (Immutable inventory_transactions)',
                    'ປຶ້ມບັນຊີຄວາມເຄື່ອນໄຫວສະຕັອກຫ້າມແກ້ໄຂ/ລຶບ (Immutable inventory_transactions)',
                    'Immutable Inventory Transaction Ledger (inventory_transactions)'
                  )}
                </h3>
                <p className="text-xs text-ink-muted">
                  {pick(
                    'ป้องกันการแก้ไขย้อนหลังด้วย SQLite Triggers ระดับฐานข้อมูล + ตรวจสอบสมการผลรวมตรงกับคงเหลือ 100%',
                    'ປ້ອງກັນການແກ້ໄຂຍ້ອນຫຼັງດ້ວຍ SQLite Triggers ລະດັບຖານຂໍ້ມູນ + ກວດສອບສົມຜົນຜົນລວມຕົງກັບຄົງເຫຼືອ 100%',
                    'Protected against tampering by database-level SQLite Triggers + 100% balance conservation check'
                  )}
                </p>
              </div>
            </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className={`rounded-[48px] border px-3 py-1 text-[11px] font-medium ${
                    bootstrap.ledgerInvariant.valid
                      ? 'border-primary bg-primary-soft text-primary-dark'
                      : 'border-ink bg-ink text-white'
                  }`}
                >
                  {bootstrap.ledgerInvariant.valid
                    ? pick('Ledger Conservation: 100% ตรงกัน', 'Ledger Conservation: 100% ຕົງກັນ', 'Ledger Conservation: 100% Exact')
                    : pick(
                        `พบส่วนต่าง ${bootstrap.ledgerInvariant.mismatches.length} รายการ`,
                        `ພົບສ່ວນຕ່າງ ${bootstrap.ledgerInvariant.mismatches.length} ລາຍການ`,
                        `${bootstrap.ledgerInvariant.mismatches.length} ledger mismatch(es)`
                      )}
                </span>
                <select
                  aria-label={pick('กรองสมุดบัญชีตามสินค้าหรือวัตถุดิบ', 'ກັ່ນຕອງປຶ້ມບັນຊີຕາມສິນຄ້າ', 'Filter ledger by item')}
                  value={ledgerVariantFilter}
                  onChange={(e) => setLedgerVariantFilter(e.target.value)}
                  className={`h-10 max-w-full rounded-[4px] border border-hairline bg-canvas px-3 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
                >
                  <option value="">{pick('-- แสดงทุกรายการสินค้า --', '-- ສະແດງທຸກລາຍການ --', '-- All Inventory Items --')}</option>
                  {bootstrap.catalogDetailed.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.sku} — {v.itemName}
                    </option>
                  ))}
                </select>
              </div>
          </div>

          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline sticky top-0">
                <tr>
                  <th scope="col" className="py-3 px-4">{pick('เวลา / อ้างอิง', 'ເວລາ / ອ້າງອີງ', 'Time / Reference')}</th>
                  <th scope="col" className="py-3 px-4">{pick('ประเภทธุรกรรม', 'ປະເພດທຸລະກຳ', 'Transaction Type')}</th>
                  <th scope="col" className="py-3 px-4">{pick('สินค้า / วัตถุดิบ', 'ສິນຄ້າ / ວັດຖຸດິບ', 'Product / Material')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('เปลี่ยนแปลง', 'ປ່ຽນແປງ', 'Delta')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('ก่อน → หลัง', 'ກ່ອນ → ຫຼັງ', 'Before → After')}</th>
                  <th scope="col" className="py-3 px-4 text-right">{pick('ต้นทุน/หน่วย', 'ຕົ້ນທຶນ/ໜ່ວຍ', 'Unit Cost')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas">
                {ledgerRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-ink-muted">
                      {pick('ยังไม่มีรายการความเคลื่อนไหวสต็อกในสมุดบัญชี', 'ຍັງບໍ່ມີລາຍການເຄື່ອນໄຫວສະຕັອກໃນປຶ້ມບັນຊີ', 'No stock ledger movements recorded')}
                    </td>
                  </tr>
                ) : (
                  ledgerRows.map((row) => (
                    <tr key={row.id} className="hover:bg-surface-1 transition-colors duration-150">
                      <td className="py-2.5 px-4 tabular-nums-google">
                        <div className="text-ink">
                          {dateTime(row.createdAt)}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {row.referenceType} · {row.referenceId} · {pick('โดย', 'ໂດຍ', 'by')} {row.performedByName}
                        </div>
                      </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`rounded-[4px] border px-2 py-0.5 text-[11px] font-medium ${
                          row.quantityChangeMilli >= 0
                            ? 'border-primary bg-primary-soft text-primary-dark'
                            : 'border-hairline bg-surface-1 text-ink-soft'
                        }`}
                      >
                        {row.transactionType}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-ink">{row.itemName}</div>
                      <div className="text-[11px] text-ink-muted tabular-nums-google">{row.sku}</div>
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-medium tabular-nums-google ${
                        row.quantityChangeMilli >= 0 ? 'text-primary-hover' : 'text-ink'
                      }`}
                    >
                      {row.quantityChangeMilli >= 0 ? '+' : ''}
                      {formatMilliUnitsToQtyString(row.quantityChangeMilli, row.unitName)}
                    </td>
                    <td className="py-2.5 px-4 text-right text-ink-muted tabular-nums-google">
                      {formatMilliUnitsToQtyString(row.stockBeforeMilli)} →{' '}
                      <strong className="font-medium text-ink">
                        {formatMilliUnitsToQtyString(row.stockAfterMilli)}
                      </strong>
                    </td>
                    <td className="py-2.5 px-4 text-right text-ink-muted tabular-nums-google">
                      {unitCost(row.unitCostMicroBaht)}
                    </td>
                  </tr>
                ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: CREATE / EDIT PRODUCT VARIANT */}
      <ModalDialog
        open={productModalOpen}
        canDismiss={!confirmDeleteVariant && !cameraModal && !busy && !deletingVariant}
        onClose={() => setProductModalOpen(false)}
        labelledBy={`${uid}-prod-modal-title`}
        maxWidthClass="max-w-xl"
      >
        <div className="flex items-center justify-between border-b border-hairline px-6 py-4 bg-canvas shrink-0">
          <h3 id={`${uid}-prod-modal-title`} className="font-google-display text-[20px] font-normal text-ink">
            {editingVariantId
              ? pick('แก้ไขข้อมูลสินค้า / วัตถุดิบ', 'ແກ້ໄຂຂໍ້ມູນສິນຄ້າ / ວັດຖຸດິບ', 'Edit Product / Material')
              : pick('เพิ่มสินค้า / วัตถุดิบใหม่เข้าคลัง', 'ເພີ່ມສິນຄ້າ / ວັດຖຸດິບໃໝ່ເຂົ້າສາງ', 'New Product / Material')}
          </h3>
          <button
            type="button"
            aria-label={pick('ปิดหน้าต่างสินค้า', 'ປິດໜ້າຕ່າງສິນຄ້າ', 'Close product modal')}
            onClick={() => setProductModalOpen(false)}
            className={`flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs overflow-y-auto flex-1">
          {/* Product Photo Upload & Camera Capture */}
          <div className="sm:col-span-2 rounded-[8px] border border-hairline bg-surface-1 p-4 flex flex-wrap items-center gap-4">
            <div className="h-[84px] w-[112px] shrink-0 overflow-hidden rounded-[4px] border border-hairline bg-canvas flex items-center justify-center">
              {prodImagePreviewUrl ? (
                <img
                  src={prodImagePreviewUrl}
                  alt={pick('ตัวอย่างรูปสินค้า', 'ຕົວຢ່າງຮູບສິນຄ້າ', 'Product photo preview')}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="text-center text-[11px] text-ink-muted px-2">
                  <ImagePlus className="h-5 w-5 mx-auto mb-1 text-ink-muted" />
                  <span>{pick('ยังไม่มีรูป', 'ຍັງບໍ່ມີຮູບ', 'No Photo')}</span>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-[200px] space-y-2">
              <div className="font-google-display text-sm font-medium text-ink">
                {pick(
                  'รูปภาพสินค้า / เมนู (แสดงบนหน้าจอขาย POS และคลังสินค้า)',
                  'ຮູບພາບສິນຄ້າ / ເມນູ (ສະແດງເທິງໜ້າຈໍຂາຍ POS ແລະ ສາງສິນຄ້າ)',
                  'Product / Menu Image (Shown on POS & Warehouse)'
                )}
              </div>
              <p className="text-[11px] text-ink-muted">
                {pick(
                  'รองรับ JPG / PNG / WebP บีบอัดขนาดอัตโนมัติและเก็บในเครื่องแบบออฟไลน์ 100%',
                  'ຮອງຮັບ JPG / PNG / WebP ບີບອັດຂະໜາດອັດຕະໂນມັດ ແລະ ເກັບໃນເຄື່ອງແບບອອບໄລນ໌ 100%',
                  'Supports JPG / PNG / WebP — compressed & stored 100% locally offline'
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={prodImageFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => void handleProductPhotoFileSelect(e)}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => prodImageFileInputRef.current?.click()}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-primary bg-canvas px-3.5 text-xs font-medium text-primary hover:bg-primary-soft/50 ${UI_INTERACTION.focusButton}`}
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>{pick('เลือกรูปภาพ', 'ເລືອກຮູບພາບ', 'Choose Image')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setCameraModal({ mode: 'PHOTO', target: 'MODAL_PHOTO' })}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
                >
                  <Camera className="h-3.5 w-3.5" />
                  <span>{pick('ถ่ายรูปจากกล้อง', 'ຖ່າຍຮູບຈາກກ້ອງ', 'Take Photo')}</span>
                </button>
                {prodImagePreviewUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setProdImagePreviewUrl(null);
                      setProdImagePendingDataUrl(null);
                    }}
                    className={`inline-flex h-9 items-center gap-1 rounded-[48px] border border-hairline bg-canvas px-3 text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{pick('ลบรูป', 'ລຶບຮູບ', 'Remove Photo')}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-prod-name`} className="block text-ink-muted mb-1">
              {pick('ชื่อสินค้า / เมนู / วัตถุดิบ', 'ຊື່ສິນຄ້າ / ເມນູ / ວັດຖຸດິບ', 'Product / Menu / Material Name')}
            </label>
            <input
              ref={prodNameInputRef}
              id={`${uid}-prod-name`}
              type="text"
              value={prodName}
              onChange={(e) => setProdName(e.target.value)}
              placeholder={
                bootstrap.profile === 'HOSPITALITY'
                  ? pick('เช่น ลาเต้เย็น, ข้าวผัดกะเพรา, ผงชาไทย...', 'ເຊັ່ນ ລາເຕ້ເຢັນ, ເຂົ້າຜັດກະເພົາ, ຜົງຊາລາວ...', 'e.g. Iced Latte, Basil Rice, Tea Powder...')
                  : pick('เช่น น้ำดื่ม 600 มล., ขนมปังโฮลวีต...', 'ເຊັ່ນ ນ້ຳດື່ມ 600 ມລ., ເຂົ້າຈີ່...', 'e.g. Drinking Water 600ml, Whole Wheat Bread...')
              }
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-prod-sku`} className="block text-ink-muted mb-1">
              {pick('รหัส SKU', 'ລະຫັດ SKU', 'SKU Code')}
            </label>
            <input
              id={`${uid}-prod-sku`}
              type="text"
              value={prodSku}
              onChange={(e) => setProdSku(e.target.value)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={`${uid}-prod-barcode`} className="block text-ink-muted">
                {pick('รหัสบาร์โค้ด (ยิงปืนสแกนที่ตัวสินค้าได้เลย)', 'ລະຫັດບາໂຄດ (ຍິງປືນສະແກນທີ່ສິນຄ້າໄດ້ເລີຍ)', 'Barcode (scan item directly)')}
              </label>
              <span className="text-[10px] font-medium text-primary-dark">
                {pick('พร้อมรับปืนสแกน', 'ພ້ອມຮັບປືນສະແກນ', 'Scanner Ready')}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                id={`${uid}-prod-barcode`}
                data-modal-barcode-input="true"
                type="text"
                value={prodBarcode}
                onChange={(e) => setProdBarcode(e.target.value)}
                placeholder={pick('ยิงปืนสแกน หรือเว้นว่างได้...', 'ຍິງປືນສະແກນ ຫຼື ປະວ່າງໄດ້...', 'Scan barcode or leave blank...')}
                className={`h-11 flex-1 min-w-0 rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
              />
              <button
                type="button"
                title={pick('สแกนบาร์โค้ดด้วยกล้อง', 'ສະແກນບາໂຄດດ້ວຍກ້ອງ', 'Scan barcode with camera')}
                aria-label={pick('สแกนบาร์โค้ดด้วยกล้อง', 'ສະແກນບາໂຄດດ້ວຍກ້ອງ', 'Scan barcode with camera')}
                onClick={() => setCameraModal({ mode: 'BARCODE', target: 'MODAL_BARCODE' })}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] border border-primary bg-primary-soft text-primary-dark hover:bg-primary-soft/80 ${UI_INTERACTION.focusButton}`}
              >
                <Camera className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={pick(
                  'สุ่มรหัสบาร์โค้ด EAN-13 มาตรฐานสากลพร้อม Check Digit',
                  'ສຸ່ມລະຫັດບາໂຄດ EAN-13 ມາດຕະຖານສາກົນພ້ອມ Check Digit',
                  'Generate random valid EAN-13 barcode'
                )}
                aria-label={pick('สุ่มรหัสบาร์โค้ดอัตโนมัติ', 'ສຸ່ມລະຫັດບາໂຄດອັດຕະໂນມັດ', 'Generate random barcode')}
                onClick={() => {
                  const existingSet = new Set(
                    bootstrap.catalogDetailed.map((v) => v.barcode).filter((b): b is string => Boolean(b))
                  );
                  setProdBarcode(generateValidInternalEan13(existingSet));
                }}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] border border-hairline bg-surface-1 text-ink-muted hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={`${uid}-prod-cat`} className="block text-ink-muted">
                {pick('หมวดหมู่', 'ໝວດໝູ່', 'Category')} ({profileMeta.shortBadge})
              </label>
              <button
                type="button"
                onClick={() => setInlineCatOpen((v) => !v)}
                className="text-[11px] font-medium text-primary hover:underline cursor-pointer"
              >
                {inlineCatOpen
                  ? pick('ปิดฟอร์มเพิ่มหมวด', 'ປິດຟອມເພີ່ມໝວດ', 'Close Form')
                  : pick('+ เพิ่มหมวดหมู่ใหม่', '+ ເພີ່ມໝວດໝູ່ໃໝ່', '+ New Category')}
              </button>
            </div>
            <select
              id={`${uid}-prod-cat`}
              value={prodCategoryId}
              onChange={(e) => setProdCategoryId(e.target.value)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink ${UI_INTERACTION.focusSelect}`}
            >
              {(() => {
                const list = [...profileWarehouseCategories];
                // Keep currently selected category visible if editing an item from another mode
                if (prodCategoryId && !list.some((c) => c.id === prodCategoryId)) {
                  const found = bootstrap.categories.find((c) => c.id === prodCategoryId);
                  if (found) list.unshift(found);
                }
                return list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {getDepartmentThaiLabel(getCategoryDepartment(c), locale)}
                  </option>
                ));
              })()}
            </select>
            {inlineCatOpen && (
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  id={`${uid}-inline-cat-name`}
                  type="text"
                  aria-label={pick('ชื่อหมวดหมู่ใหม่ด่วน', 'ຊື່ໝວດໝູ່ໃໝ່ດ່ວນ', 'Quick new category name')}
                  value={inlineCatName}
                  onChange={(e) => setInlineCatName(e.target.value)}
                  placeholder={pick('ชื่อหมวดหมู่ใหม่...', 'ຊື່ໝວດໝູ່ໃໝ່...', 'New category name...')}
                  className={`h-9 flex-1 rounded-[4px] border border-primary bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
                />
                <button
                  type="button"
                  disabled={busy || !inlineCatName.trim()}
                  onClick={() =>
                    void handleSaveCategory(
                      inlineCatName,
                      bootstrap.profile === 'HOSPITALITY' ? 'HOSPITALITY' : 'RETAIL'
                    )
                  }
                  className={`h-9 rounded-[48px] bg-primary px-3 text-[11px] font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                >
                  {pick('สร้าง', 'ສ້າງ', 'Create')}
                </button>
              </div>
            )}
          </div>
          <div>
            <label htmlFor={`${uid}-prod-unit`} className="block text-ink-muted mb-1">
              {pick('หน่วยนับ (เช่น ชิ้น, แก้ว, กก., มล.)', 'ໜ່ວຍນັບ (ເຊັ່ນ ຊິ້ນ, ຈອກ, ກກ., ມລ.)', 'Unit (e.g. pcs, cup, kg, ml)')}
            </label>
            <input
              id={`${uid}-prod-unit`}
              type="text"
              value={prodUnit}
              onChange={(e) => setProdUnit(e.target.value)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink ${UI_INTERACTION.focusControl}`}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-prod-price`} className="block text-primary-hover font-medium mb-1">
              {pick('ราคาขายหน้าร้าน', 'ລາຄາຂາຍໜ້າຮ້ານ', 'Selling Price')} ({currencyCode})
            </label>
            <input
              id={`${uid}-prod-price`}
              type="text"
              value={prodPriceBaht}
              onChange={(e) => setProdPriceBaht(e.target.value)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 font-medium text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-prod-cost`} className="block text-ink-muted mb-1">
              {pick('ต้นทุนซื้อตั้งต้นต่อหน่วย', 'ຕົ້ນທຶນຊື້ຕໍ່ໜ່ວຍ', 'Default Unit Cost')} ({currencyCode})
            </label>
            <input
              id={`${uid}-prod-cost`}
              type="text"
              value={prodCostBaht}
              onChange={(e) => setProdCostBaht(e.target.value)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
            />
          </div>
          {!editingVariantId && (
            <div>
              <label htmlFor={`${uid}-prod-init`} className="block text-ink-muted mb-1">
                {pick('สต็อกยกมาเริ่มต้น', 'ສະຕັອກຍົກມາເລີ່ມຕົ້ນ', 'Opening Stock Qty')}
              </label>
              <input
                id={`${uid}-prod-init`}
                type="text"
                value={prodInitStock}
                onChange={(e) => setProdInitStock(e.target.value)}
                className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
              />
            </div>
          )}
          <div>
            <label htmlFor={`${uid}-prod-low`} className="block text-ink-muted mb-1">
              {pick('จุดเตือนสต็อกต่ำ (Low Stock)', 'ຈຸດເຕືອນສະຕັອກຕ່ຳ (Low Stock)', 'Low Stock Alert Threshold')}
            </label>
            <input
              id={`${uid}-prod-low`}
              type="text"
              value={prodLowStock}
              onChange={(e) => setProdLowStock(e.target.value)}
              className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
            />
          </div>

          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
            <label className="flex items-center gap-2 rounded-[4px] border border-hairline bg-surface-1 p-3 text-ink cursor-pointer transition-colors duration-200 hover:border-primary focus-within:ring-2 focus-within:ring-primary/25">
              <input
                type="checkbox"
                checked={prodActive}
                onChange={(e) => setProdActive(e.target.checked)}
                className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
              />
              <span>{pick('เปิดจำหน่ายบนหน้าขาย POS', 'ເປີດຈຳໜ່າຍເທິງໜ້າຂາຍ POS', 'Active on POS Register')}</span>
            </label>
            {bootstrap.profile !== 'RETAIL' && (
              <>
                <label className="flex items-center gap-2 rounded-[4px] border border-hairline bg-surface-1 p-3 text-ink cursor-pointer transition-colors duration-200 hover:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                  <input
                    type="checkbox"
                    checked={prodIsComposite}
                    onChange={(e) => setProdIsComposite(e.target.checked)}
                    className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
                  />
                  <span>{pick('ผูกสูตร BOM (ตัดวัตถุดิบสด)', 'ຜູກສູດ BOM (ຕັດວັດຖຸດິບສົດ)', 'Use BOM Recipe (Live Deduction)')}</span>
                </label>
                <label className="flex items-center gap-2 rounded-[4px] border border-hairline bg-surface-1 p-3 text-ink cursor-pointer transition-colors duration-200 hover:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                  <input
                    type="checkbox"
                    checked={prodUseProduction}
                    onChange={(e) => {
                      setProdUseProduction(e.target.checked);
                      if (e.target.checked) setProdIsComposite(true);
                    }}
                    className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
                  />
                  <span>{pick('ต้มเตรียมล่วงหน้า (Pre-Built)', 'ຕົ້ມກຽມລ່ວງໜ້າ (Pre-Built)', 'Pre-Built Batch Item')}</span>
                </label>
              </>
            )}
            {bootstrap.profile !== 'HOSPITALITY' && (
              <label className="flex items-center gap-2 rounded-[4px] border border-hairline bg-surface-1 p-3 text-ink cursor-pointer transition-colors duration-200 hover:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                <input
                  type="checkbox"
                  checked={prodIsScale}
                  onChange={(e) => setProdIsScale(e.target.checked)}
                  className="accent-primary focus-visible:ring-2 focus-visible:ring-primary"
                />
                <span>{pick('สินค้าชั่งน้ำหนักสด (บาร์โค้ด กก.)', 'ສິນຄ້າຊັ່ງນ້ຳໜັກສົດ (ບາໂຄດ ກກ.)', 'Weighted Scale Item (EAN-13 kg/price)')}</span>
              </label>
            )}
          </div>
        </div>

        <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {editingVariantId && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const target = bootstrap.catalogDetailed.find((v) => v.id === editingVariantId);
                    if (target) {
                      setProductModalOpen(false);
                      setQuickBarcodeTarget(target);
                    }
                  }}
                  className={`inline-flex h-[44px] items-center gap-1.5 rounded-[48px] border border-primary bg-primary-soft px-4 font-google-display text-xs font-medium text-primary-dark hover:bg-primary hover:text-white ${UI_INTERACTION.focusButton}`}
                >
                  <Printer className="h-3.5 w-3.5" />
                  <span>{pick('พิมพ์บาร์โค้ด', 'ພິມບາໂຄດ', 'Print Label')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const target = bootstrap.catalogDetailed.find((v) => v.id === editingVariantId);
                    if (target) {
                      setConfirmDeleteVariant(target);
                    }
                  }}
                  className={`inline-flex h-[44px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-ink-soft hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{pick('ลบสินค้านี้', 'ລຶບສິນຄ້ານີ້', 'Delete Item')}</span>
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setProductModalOpen(false)}
              className={`h-[46px] rounded-[48px] border border-hairline bg-canvas px-6 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={busy || !prodName.trim() || !prodSku.trim()}
              onClick={() => void handleSaveProduct()}
              className={`h-[46px] rounded-[48px] bg-primary px-7 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              {pick('บันทึกรายการสินค้า', 'ບັນທຶກລາຍການສິນຄ້າ', 'Save Product')}
            </button>
          </div>
        </div>
      </ModalDialog>

      {/* MODAL: QUICK STOCK ADJUSTMENT */}
      <ModalDialog
        open={Boolean(adjTarget)}
        onClose={() => setAdjTarget(null)}
        labelledBy={`${uid}-adj-modal-title`}
        maxWidthClass="max-w-md"
      >
        {adjTarget && (
          <>
            <div className="border-b border-hairline px-6 py-4 flex items-start justify-between gap-2 shrink-0">
              <div>
                <h3 id={`${uid}-adj-modal-title`} className="font-google-display text-[20px] font-normal text-ink">
                  {pick('ปรับปรุงสต็อก', 'ປັບປຸງສະຕັອກ', 'Adjust Stock')} ({adjTarget.itemName})
                </h3>
                <p className="text-xs text-ink-muted mt-1">
                  {pick('คงเหลือปัจจุบัน:', 'ຄົງເຫຼືອປັດຈຸບັນ:', 'Current on hand:')}{' '}
                  <strong className="font-medium text-ink tabular-nums-google">
                    {formatMilliUnitsToQtyString(adjTarget.inStockMilli, adjTarget.unitName)}
                  </strong>
                </p>
              </div>
              <button
                type="button"
                aria-label={pick('ปิดหน้าต่างปรับปรุงสต็อก', 'ປິດໜ້າຕ່າງປັບປຸງສະຕັອກ', 'Close stock adjustment modal')}
                onClick={() => setAdjTarget(null)}
                className={`flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink shrink-0 ${UI_INTERACTION.focusButton}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
              <div>
                <label htmlFor={`${uid}-adj-delta`} className="block text-ink-muted mb-1">
                  {pick(
                    'ปริมาณที่ต้องการเพิ่ม/ลด (เช่น -1.500 หรือ 5.000)',
                    'ປະລິມານທີ່ຕ້ອງການເພີ່ມ/ຫຼຸດ (ເຊັ່ນ -1.500 ຫຼື 5.000)',
                    'Quantity Adjustment Delta (e.g. -1.500 or 5.000)'
                  )}
                </label>
                <input
                  id={`${uid}-adj-delta`}
                  type="text"
                  value={adjDeltaInput}
                  onChange={(e) => setAdjDeltaInput(e.target.value)}
                  className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-base font-medium text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-adj-reason`} className="block text-ink-muted mb-1">
                  {pick('สาเหตุการปรับปรุง', 'ສາເຫດການປັບປຸງ', 'Adjustment Reason')}
                </label>
                <input
                  id={`${uid}-adj-reason`}
                  type="text"
                  value={adjReason}
                  onChange={(e) => setAdjReason(e.target.value)}
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>
            <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex justify-end gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setAdjTarget(null)}
                className={`h-[44px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmAdjustment()}
                className={`h-[44px] rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {pick('ยืนยันบันทึกสมุดสต็อก', 'ຢືນຢັນບັນທຶກປຶ້ມສະຕັອກ', 'Commit Stock Adjustment')}
              </button>
            </div>
          </>
        )}
      </ModalDialog>

      <QuickBarcodePrintModal
        open={Boolean(quickBarcodeTarget)}
        outletId={outletId}
        variant={
          quickBarcodeTarget
            ? bootstrap.catalogDetailed.find((v) => v.id === quickBarcodeTarget.id) ??
              quickBarcodeTarget
            : null
        }
        bootstrap={bootstrap}
        currentUser={currentUser}
        onClose={() => setQuickBarcodeTarget(null)}
        onAddToBatchQueue={(entry) => {
          setBarcodeQueue((prev) => {
            const exists = prev.find((q) => q.variantId === entry.variantId);
            if (exists) {
              return prev.map((q) =>
                q.variantId === entry.variantId
                  ? { ...entry, copies: Math.min(500, q.copies + entry.copies) }
                  : q
              );
            }
            return [...prev, entry];
          });
        }}
        onRefreshState={onRefreshState}
        onToast={onToast}
      />

      <BarcodeCameraScannerModal
        open={Boolean(cameraModal)}
        mode={cameraModal?.mode ?? 'BARCODE'}
        onClose={() => setCameraModal(null)}
        onBarcodeDetected={(code) => {
          if (cameraModal?.target === 'MODAL_BARCODE') {
            setProdBarcode(code);
            onToast(
              pick(`สแกนบาร์โค้ด "${code}" จากกล้องสำเร็จ`, `ສະແກນບາໂຄດ "${code}" ຈາກກ້ອງສຳເລັດ`, `Scanned barcode "${code}"`),
              'success'
            );
          } else {
            handleWarehouseBarcodeLookupOrCreate(code);
          }
        }}
        onPhotoCaptured={(dataUrl) => {
          setProdImagePreviewUrl(dataUrl);
          setProdImagePendingDataUrl(dataUrl);
          onToast(
            pick('ถ่ายรูปภาพสินค้าสำเร็จ กดบันทึกเพื่อยืนยัน', 'ຖ່າຍຮູບສິນຄ້າສຳເລັດ ກົດບັນທຶກເພື່ອຢືນຢັນ', 'Photo captured — click Save to confirm'),
            'success'
          );
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDeleteVariant)}
        title={pick(
          `ยืนยันลบสินค้า "${confirmDeleteVariant?.itemName ?? ''}" ออกจากระบบ?`,
          `ຢືນຢັນລຶບສິນຄ້າ "${confirmDeleteVariant?.itemName ?? ''}" ອອກຈາກລະບົບ?`,
          `Delete product "${confirmDeleteVariant?.itemName ?? ''}"?`
        )}
        description={pick(
          'ระบบจะลบสินค้านี้ออกจากหน้าขาย POS และทะเบียนคลังทันที ปลดล็อกรหัสบาร์โค้ด/SKU ให้ใช้งานใหม่ได้ และปรับสมดุลสมุดบัญชีสต็อกให้ตรงตามมาตรฐาน 100%',
          'ລະບົບຈະລຶບສິນຄ້ານີ້ອອກຈາກໜ້າຂາຍ POS ແລະ ທະບຽນສາງທັນທີ, ປົດລັອກລະຫັດບາໂຄດ/SKU ແລະ ປັບສົມດຸນປຶ້ມບັນຊີສະຕັອກ 100%',
          'Removes this item from POS and Warehouse, frees its SKU/barcode for reuse, and keeps ledger conservation intact'
        )}
        confirmLabel={pick('ยืนยันลบสินค้า', 'ຢືນຢັນລຶບສິນຄ້າ', 'Delete Product')}
        tone="danger"
        busy={deletingVariant}
        onCancel={() => {
          if (!deletingVariant) setConfirmDeleteVariant(null);
        }}
        onConfirm={() => {
          if (!confirmDeleteVariant) return;
          setDeletingVariant(true);
          void posTransport
            .deleteCatalogVariant({
              variantId: confirmDeleteVariant.id,
              performedByUserId: currentUser.id,
            })
            .then(async (res) => {
              setProductModalOpen(false);
              setEditingVariantId(undefined);
              await onRefreshState();
              onToast(
                res.mode === 'HARD_DELETED'
                  ? pick(
                      `ลบสินค้า "${confirmDeleteVariant.itemName}" ออกจากฐานข้อมูลเรียบร้อยแล้ว`,
                      `ລຶບສິນຄ້າ "${confirmDeleteVariant.itemName}" ອອກຈາກຖານຂໍ້ມູນຮຽບຮ້ອຍແລ້ວ`,
                      `Deleted "${confirmDeleteVariant.itemName}" from catalog`
                    )
                  : pick(
                      `ลบสินค้า "${confirmDeleteVariant.itemName}" ออกจากคลังและปลดล็อกบาร์โค้ดแล้ว (คงประวัติบัญชีเดิมไว้ 100%)`,
                      `ລຶບສິນຄ້າ "${confirmDeleteVariant.itemName}" ອອກຈາກສາງ ແລະ ປົດລັອກບາໂຄດແລ້ວ (ຮັກສາປະຫວັດບັນຊີເດີມໄວ້ 100%)`,
                      `Archived "${confirmDeleteVariant.itemName}" and freed barcode (historical ledger preserved)`
                    ),
                'warn'
              );
            })
            .catch((err) => onToast(err instanceof Error ? err.message : String(err), 'error'))
            .finally(() => {
              setDeletingVariant(false);
              setConfirmDeleteVariant(null);
            });
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDeleteCategory)}
        title={pick(
          `ยืนยันลบหมวดหมู่ "${confirmDeleteCategory?.name ?? ''}"?`,
          `ຢືນຢັນລຶບໝວດໝູ່ "${confirmDeleteCategory?.name ?? ''}"?`,
          `Delete category "${confirmDeleteCategory?.name ?? ''}"?`
        )}
        description={pick(
          'หมวดหมู่ที่ไม่มีสินค้าใช้งานอยู่จะถูกลบออกทันที หากยังมีสินค้าอยู่ในหมวดหมู่นี้กรุณาย้ายหรือลบสินค้าก่อน',
          'ໝວດໝູ່ທີ່ບໍ່ມີສິນຄ້າໃຊ້ງານຢູ່ຈະຖືກລຶບອອກທັນທີ ຫາກຍັງມີສິນຄ້າຢູ່ກະລຸນາຍ້າຍ ຫຼື ລຶບສິນຄ້າກ່ອນ',
          'Empty categories will be permanently deleted; move or delete assigned items first if any remain'
        )}
        confirmLabel={pick('ยืนยันลบหมวดหมู่', 'ຢືນຢັນລຶບໝວດໝູ່', 'Delete Category')}
        tone="danger"
        busy={deletingCategory}
        onCancel={() => {
          if (!deletingCategory) setConfirmDeleteCategory(null);
        }}
        onConfirm={() => {
          if (!confirmDeleteCategory) return;
          setDeletingCategory(true);
          void posTransport
            .deleteCategory(confirmDeleteCategory.id)
            .then(async () => {
              await onRefreshState();
              onToast(
                pick(
                  `ลบหมวดหมู่ "${confirmDeleteCategory.name}" เรียบร้อยแล้ว`,
                  `ລຶບໝວດໝູ່ "${confirmDeleteCategory.name}" ຮຽບຮ້ອຍແລ້ວ`,
                  `Deleted category "${confirmDeleteCategory.name}"`
                ),
                'warn'
              );
            })
            .catch((err) => onToast(err instanceof Error ? err.message : String(err), 'error'))
            .finally(() => {
              setDeletingCategory(false);
              setConfirmDeleteCategory(null);
            });
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDeleteMod)}
        title={
          confirmDeleteMod?.kind === 'group'
            ? pick(
                `ยืนยันลบกลุ่มตัวเลือก "${confirmDeleteMod.name}"?`,
                `ຢືນຢັນລຶບກຸ່ມຕົວເລືອກ "${confirmDeleteMod.name}"?`,
                `Delete modifier group "${confirmDeleteMod.name}"?`
              )
            : pick(
                `ยืนยันลบตัวเลือก "${confirmDeleteMod?.name ?? ''}"?`,
                `ຢືນຢັນລຶບຕົວເລືອກ "${confirmDeleteMod?.name ?? ''}"?`,
                `Delete modifier option "${confirmDeleteMod?.name ?? ''}"?`
              )
        }
        description={
          confirmDeleteMod?.kind === 'group'
            ? pick(
                'ตัวเลือกย่อยทั้งหมดภายในกลุ่มนี้จะถูกลบออกจากหน้าจอขาย POS ด้วย',
                'ຕົວເລືອກຍ່ອຍທັງໝົດພາຍໃນກຸ່ມນີ້ຈະຖືກລຶບອອກຈາກໜ້າຈໍຂາຍ POS ນຳ',
                'All options inside this group will also be removed from the POS register'
              )
            : pick(
                'ตัวเลือกนี้จะไม่สามารถเลือกใช้จากหน้าจอขาย POS ได้อีกต่อไป',
                'ຕົວເລືອກນີ້ຈະບໍ່ສາມາດເລືອກໃຊ້ຈາກໜ້າຈໍຂາຍ POS ໄດ້ອີກຕໍ່ໄປ',
                'This option will no longer be selectable at checkout'
              )
        }
        confirmLabel={pick('ยืนยันการลบ', 'ຢືນຢັນການລຶບ', 'Confirm Delete')}
        tone="danger"
        busy={deletingMod}
        onCancel={() => {
          if (!deletingMod) setConfirmDeleteMod(null);
        }}
        onConfirm={() => {
          if (!confirmDeleteMod) return;
          setDeletingMod(true);
          const task =
            confirmDeleteMod.kind === 'group'
              ? posTransport.deleteModifierGroup(confirmDeleteMod.id)
              : posTransport.deleteModifierItem(confirmDeleteMod.id);
          void task
            .then(async () => {
              await onRefreshState();
              onToast(
                confirmDeleteMod.kind === 'group'
                  ? pick(
                      `ลบกลุ่มตัวเลือก "${confirmDeleteMod.name}" แล้ว`,
                      `ລຶບກຸ່ມຕົວເລືອກ "${confirmDeleteMod.name}" ແລ້ວ`,
                      `Deleted modifier group "${confirmDeleteMod.name}"`
                    )
                  : pick(
                      `ลบตัวเลือก "${confirmDeleteMod.name}" แล้ว`,
                      `ລຶບຕົວເລືອກ "${confirmDeleteMod.name}" ແລ້ວ`,
                      `Deleted modifier option "${confirmDeleteMod.name}"`
                    ),
                'warn'
              );
            })
            .catch((err) => onToast(err instanceof Error ? err.message : String(err), 'error'))
            .finally(() => {
              setDeletingMod(false);
              setConfirmDeleteMod(null);
            });
        }}
      />
    </div>
  );
};
