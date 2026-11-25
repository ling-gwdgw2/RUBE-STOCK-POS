import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  Factory,
  FileSpreadsheet,
  PackagePlus,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import {
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  parseDecimalStringToScaledInt,
} from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type {
  BootstrapPayload,
  CatalogVariantDetailDto,
  ComponentRole,
  StaffUserDto,
} from '../types.ts';

interface WarehouseWorkspaceProps {
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

type WmsSubTab =
  | 'CATALOG'
  | 'MODIFIERS'
  | 'PO_LANDED'
  | 'PREP_BUILD'
  | 'STOCKTAKE_TRANSFER'
  | 'LEDGER';

export const WarehouseWorkspace: React.FC<WarehouseWorkspaceProps> = ({
  bootstrap,
  currentUser,
  onRefreshState,
  onToast,
}) => {
  const [subTab, setSubTab] = useState<WmsSubTab>('CATALOG');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [busy, setBusy] = useState(false);

  // Catalog Create/Edit Modal
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | undefined>(undefined);
  const [prodName, setProdName] = useState('');
  const [prodSku, setProdSku] = useState('');
  const [prodBarcode, setProdBarcode] = useState('');
  const [prodCategoryId, setProdCategoryId] = useState('CAT-RETAIL');
  const [prodUnit, setProdUnit] = useState('ชิ้น');
  const [prodPriceBaht, setProdPriceBaht] = useState('45.00');
  const [prodCostBaht, setProdCostBaht] = useState('22.0000');
  const [prodInitStock, setProdInitStock] = useState('50.000');
  const [prodLowStock, setProdLowStock] = useState('10.000');
  const [prodIsComposite, setProdIsComposite] = useState(false);
  const [prodUseProduction, setProdUseProduction] = useState(false);
  const [prodIsScale, setProdIsScale] = useState(false);

  // Quick Stock Adjustment Modal
  const [adjTarget, setAdjTarget] = useState<CatalogVariantDetailDto | null>(null);
  const [adjDeltaInput, setAdjDeltaInput] = useState('-1.000');
  const [adjReason, setAdjReason] = useState('DAMAGED / ตัดของชำรุด');

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
  >([
    {
      costType: 'FREIGHT',
      description: 'ค่าขนส่งห้องเย็น (Cold-Chain Freight)',
      amountBahtInput: '250.00',
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
  const [newOutletName, setNewOutletName] = useState('สาขาสยามสแควร์ (Branch 02)');
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
  const [modPriceDeltaBaht, setModPriceDeltaBaht] = useState('15.00');
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
              unitCostBahtInput: formatMicroBahtToThbString(first.defaultPurchaseCostMicroBaht).replace(/,/g, ''),
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
      onToast(`สร้างกลุ่มตัวเลือก "${res.group.name}" สำเร็จ`, 'success');
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
      const priceDeltaSatang = parseDecimalStringToScaledInt(modPriceDeltaBaht || '0', 2);
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
      onToast(`เพิ่มตัวเลือกเสริม "${modItemName}" สำเร็จ`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (subTab === 'PO_LANDED') {
      void posTransport.listPoHistory().then((r) => setPoHistory(r.purchaseOrders));
    } else if (subTab === 'STOCKTAKE_TRANSFER') {
      void posTransport.listTransfers().then((r) => {
        setTransfersList(r.transfers);
        const secondary = r.outlets.find((o) => o.id !== 'OUTLET-HQ');
        if (secondary && !trDestOutletId) {
          setTrDestOutletId(secondary.id);
        }
      });
    } else if (subTab === 'LEDGER') {
      void posTransport
        .listInventoryLedger('OUTLET-HQ', ledgerVariantFilter || undefined)
        .then((r) => setLedgerRows(r.ledger));
    }
  }, [subTab, ledgerVariantFilter, trDestOutletId]);

  const openCreateProductModal = () => {
    setEditingVariantId(undefined);
    setProdName('');
    setProdSku(`SKU-${Date.now().toString().slice(-5)}`);
    setProdBarcode(`885999${Date.now().toString().slice(-7)}`);
    setProdCategoryId(bootstrap.categories[0]?.id ?? 'CAT-RETAIL');
    setProdUnit('ชิ้น');
    setProdPriceBaht('55.00');
    setProdCostBaht('25.0000');
    setProdInitStock('20.000');
    setProdLowStock('5.000');
    setProdIsComposite(false);
    setProdUseProduction(false);
    setProdIsScale(false);
    setProductModalOpen(true);
  };

  const openEditProductModal = (v: CatalogVariantDetailDto) => {
    setEditingVariantId(v.id);
    setProdName(v.itemName);
    setProdSku(v.sku);
    setProdBarcode(v.barcode ?? '');
    setProdCategoryId(v.categoryId ?? 'CAT-RETAIL');
    setProdUnit(v.unitName);
    setProdPriceBaht(formatSatangToThbString(v.priceSatang).replace(/,/g, ''));
    setProdCostBaht(formatMicroBahtToThbString(v.averageCostMicroBaht).replace(/,/g, ''));
    setProdInitStock('0');
    setProdLowStock(formatMilliUnitsToQtyString(v.lowStockThresholdMilli));
    setProdIsComposite(v.isComposite);
    setProdUseProduction(v.useProduction);
    setProdIsScale(v.isWeightedScale);
    setProductModalOpen(true);
  };

  const handleSaveProduct = async () => {
    setBusy(true);
    try {
      const priceSatang = parseDecimalStringToScaledInt(prodPriceBaht, 2);
      const defaultPurchaseCostMicroBaht = parseDecimalStringToScaledInt(prodCostBaht, 6);
      const initialStockMilli = parseDecimalStringToScaledInt(prodInitStock || '0', 3);
      const lowStockThresholdMilli = parseDecimalStringToScaledInt(prodLowStock || '0', 3);

      await posTransport.upsertCatalogVariant({
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
        isComposite: prodIsComposite,
        useProduction: prodUseProduction,
        isWeightedScale: prodIsScale,
        performedByUserId: currentUser.id,
      });
      setProductModalOpen(false);
      await onRefreshState();
      onToast(`บันทึกข้อมูลสินค้า "${prodName}" สำเร็จ`, 'success');
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
        variantId: adjTarget.id,
        quantityDeltaMilli: deltaMilli,
        reason: adjReason,
        performedByUserId: currentUser.id,
      });
      setAdjTarget(null);
      await onRefreshState();
      onToast(`ปรับปรุงสต็อก ${adjTarget.itemName} บันทึกลงสมุดบัญชีสำเร็จ`, 'success');
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
        amountSatang: parseDecimalStringToScaledInt(c.amountBahtInput || '0', 2),
      }))
      .filter((c) => c.amountSatang > 0);
    return { items, landedCosts };
  };

  const handlePreviewPo = async () => {
    setBusy(true);
    try {
      const { items, landedCosts } = buildParsedPoPayload();
      const res = await posTransport.previewPurchaseOrder({
        supplierId: poSupplierId,
        items,
        landedCosts,
      });
      setPoPreviewLines(res.lines);
      onToast('คำนวณปันส่วนค่าขนส่งแฝง (Largest Remainder i128) สำเร็จ', 'success');
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
        supplierId: poSupplierId,
        createdByUserId: currentUser.id,
        items,
        landedCosts,
      });
      setPoPreviewLines(null);
      const hist = await posTransport.listPoHistory();
      setPoHistory(hist.purchaseOrders);
      await onRefreshState();
      onToast(`รับสินค้าเข้าคลังเลขที่ ${res.poNumber} พร้อมคำนวณ MAC ใหม่สำเร็จ`, 'success');
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
        compositeVariantId: prepVariantId,
        buildQtyMilli: qtyMilli,
        performedByUserId: currentUser.id,
      });
      await onRefreshState();
      onToast(
        `ต้ม/ผลิตชุดเตรียมขายสำเร็จ (+${formatMilliUnitsToQtyString(res.builtQtyMilli)} · ต้นทุนล็อต ฿${formatMicroBahtToThbString(res.batchUnitCostMicroBaht)})`,
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
      onToast('กรุณากรอกยอดนับจริงอย่างน้อย 1 รายการในตารางตรวจนับสต็อก', 'warn');
      return;
    }
    setBusy(true);
    try {
      const items = entries.map(([variantId, val]) => ({
        variantId,
        countedStockMilli: parseDecimalStringToScaledInt(val, 3),
      }));
      const res = await posTransport.executeStocktake({
        createdByUserId: currentUser.id,
        items,
      });
      setStocktakeInputs({});
      await onRefreshState();
      onToast(
        `บันทึกใบตรวจนับสต็อก ${res.countNumber} สำเร็จ (ผลต่างรวม ฿${formatSatangToThbString(res.totalVarianceSatang)})`,
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
      onToast(`เปิดสาขาปลายทาง ${newOutletName} สำเร็จ`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchTransfer = async () => {
    if (!trDestOutletId) {
      onToast('กรุณาสร้างหรือเลือกสาขาปลายทางก่อนส่งโอนสต็อก', 'warn');
      return;
    }
    setBusy(true);
    try {
      const qtyMilli = parseDecimalStringToScaledInt(trQtyInput, 3);
      const res = await posTransport.dispatchTransfer({
        sourceOutletId: 'OUTLET-HQ',
        destinationOutletId: trDestOutletId,
        dispatchedByUserId: currentUser.id,
        items: [{ variantId: trVariantId, quantityMilli: qtyMilli }],
      });
      const trData = await posTransport.listTransfers();
      setTransfersList(trData.transfers);
      await onRefreshState();
      onToast(`ตัดจ่ายใบโอนย้ายสาขา ${res.transferNumber} (IN_TRANSIT) สำเร็จ`, 'success');
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
      onToast(`สาขาปลายทางกดรับสต็อกใบโอน ${transferNo} (COMPLETED) สำเร็จ`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const filteredCatalog = bootstrap.catalogDetailed.filter((item) => {
    if (!catalogSearch.trim()) return true;
    const q = catalogSearch.trim().toLowerCase();
    return (
      item.itemName.toLowerCase().includes(q) ||
      item.sku.toLowerCase().includes(q) ||
      (item.barcode ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Canonical Google Underline WMS Sub-Navigation + Primary Pill CTA */}
      <div className="border-b border-[#dadce0] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 overflow-x-auto" role="tablist">
            {[
              { id: 'CATALOG' as const, label: 'ทะเบียนสินค้า & คลัง', icon: Boxes },
              {
                id: 'MODIFIERS' as const,
                label: 'ตัวเลือกเสริม (Modifiers)',
                icon: SlidersHorizontal,
              },
              { id: 'PO_LANDED' as const, label: 'รับของ PO & ค่าขนส่ง', icon: Truck },
              { id: 'PREP_BUILD' as const, label: 'ผลิตเตรียมขาย (Prep)', icon: Factory },
              {
                id: 'STOCKTAKE_TRANSFER' as const,
                label: 'ตรวจนับ & โอนสาขา',
                icon: ArrowLeftRight,
              },
              {
                id: 'LEDGER' as const,
                label: 'สมุดบัญชีสต็อก',
                icon: FileSpreadsheet,
              },
            ].map((tab) => {
              const Icon = tab.icon;
              const active = subTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSubTab(tab.id)}
                  className={`relative flex h-12 items-center gap-2 px-3 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8] ${
                    active ? 'text-[#202124]' : 'text-[#5f6368] hover:text-[#202124]'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-[#1a73e8]' : ''}`} />
                  <span>{tab.label}</span>
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-[#1a73e8]" />
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={openCreateProductModal}
            className="mb-2 sm:mb-0 flex h-[44px] items-center gap-2 rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] transition-colors cursor-pointer"
          >
            <PackagePlus className="h-4 w-4" />
            <span>เพิ่มสินค้า / วัตถุดิบใหม่</span>
          </button>
        </div>
      </div>

      {/* TAB 1: MASTER CATALOG & STOCK LEVELS */}
      {subTab === 'CATALOG' && (
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          <div className="p-5 border-b border-[#dadce0] bg-[#f8f9fa] flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
                ทะเบียนสินค้า วัตถุดิบ และต้นทุนถัวเฉลี่ยเคลื่อนที่ (MAC Micro-Baht)
              </h3>
              <p className="text-xs text-[#5f6368] mt-0.5">
                คลิก &ldquo;แก้ไข&rdquo; เพื่อปรับราคาขาย/บาร์โค้ด หรือ &ldquo;ปรับสต็อก&rdquo; เพื่อบันทึกของเสีย/ชำรุด
              </p>
            </div>
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5f6368]" />
              <input
                type="text"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="ค้นหาชื่อสินค้า / SKU / บาร์โค้ด..."
                className="h-11 w-full rounded-[48px] border border-[#dadce0] bg-white pl-10 pr-4 text-xs text-[#202124] placeholder:text-[#80868b] focus:border-[#1a73e8] focus:outline-none"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0]">
                <tr>
                  <th className="py-3 px-4">SKU / บาร์โค้ด</th>
                  <th className="py-3 px-4">ชื่อรายการ</th>
                  <th className="py-3 px-4">หมวด / ประเภทสต็อก</th>
                  <th className="py-3 px-4 text-right">คงเหลือจริง</th>
                  <th className="py-3 px-4 text-right">ต้นทุนเฉลี่ย MAC</th>
                  <th className="py-3 px-4 text-right">ราคาขาย</th>
                  <th className="py-3 px-4 text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#dadce0] bg-white">
                {filteredCatalog.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-[#5f6368]">
                      {catalogSearch.trim()
                        ? 'ไม่พบสินค้าหรือวัตถุดิบที่ตรงกับคำค้นหา'
                        : 'ยังไม่มีรายการสินค้า/วัตถุดิบในคลัง — กดปุ่ม "+ เพิ่มสินค้า / วัตถุดิบใหม่" มุมขวาบนเพื่อเริ่มต้น'}
                    </td>
                  </tr>
                ) : (
                  filteredCatalog.map((v) => {
                  const isLow =
                    (!v.isComposite || v.useProduction) &&
                    v.inStockMilli <= v.lowStockThresholdMilli;
                  return (
                    <tr key={v.id} className="hover:bg-[#f8f9fa]">
                      <td className="py-3 px-4 tabular-nums-google">
                        <div className="font-medium text-[#202124]">{v.sku}</div>
                        <div className="text-[11px] text-[#5f6368]">
                          {v.barcode ?? 'ไม่มีบาร์โค้ด'}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-google-display text-sm font-medium text-[#202124]">
                          {v.itemName}
                        </div>
                        <div className="text-[11px] text-[#5f6368]">ID: {v.id}</div>
                      </td>
                      <td className="py-3 px-4 space-y-1">
                        <div className="inline-flex items-center gap-1.5 rounded-[48px] border border-[#dadce0] bg-[#f8f9fa] px-2.5 py-0.5 text-[11px] text-[#202124]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#1a73e8]" />
                          {v.categoryName}
                        </div>
                        <div className="text-[11px] text-[#5f6368]">
                          {v.useProduction
                            ? 'Pre-Built ต้มเตรียมขาย'
                            : v.isComposite
                              ? 'เมนูผูกสูตร BOM ตัดสด'
                              : v.isWeightedScale
                                ? 'สินค้าชั่งน้ำหนักสด EAN-13'
                                : 'ตัดสต็อกรายชิ้นโดยตรง'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums-google">
                        {v.isComposite && !v.useProduction ? (
                          <span className="text-[#5f6368]">ตามวัตถุดิบ</span>
                        ) : (
                          <div>
                            <span
                              className={`text-sm font-medium ${
                                isLow ? 'text-[#202124]' : 'text-[#202124]'
                              }`}
                            >
                              {formatMilliUnitsToQtyString(v.inStockMilli, v.unitName)}
                            </span>
                            {isLow && (
                              <div className="mt-0.5 inline-flex items-center justify-end gap-1 rounded-[4px] bg-[#202124] px-1.5 py-0.5 text-[10px] text-white ml-1.5">
                                <AlertCircle className="h-3 w-3" /> ต่ำกว่าเกณฑ์
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right text-[#5f6368] tabular-nums-google">
                        ฿{formatMicroBahtToThbString(v.averageCostMicroBaht)}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-[#1a73e8] tabular-nums-google">
                        {v.priceSatang > 0 ? `฿${formatSatangToThbString(v.priceSatang)}` : '—'}
                      </td>
                      <td className="py-3 px-4 text-right space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditProductModal(v)}
                          className="rounded-[48px] border border-[#dadce0] bg-white px-3.5 py-1.5 text-[11px] font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
                        >
                          แก้ไข
                        </button>
                        {(!v.isComposite || v.useProduction) && (
                          <button
                            type="button"
                            onClick={() => {
                              setAdjTarget(v);
                              setAdjDeltaInput('-1.000');
                            }}
                            className="rounded-[48px] border border-[#dadce0] bg-white px-3.5 py-1.5 text-[11px] font-medium text-[#3c4043] hover:border-[#202124] hover:text-[#202124] cursor-pointer"
                          >
                            ปรับสต็อก
                          </button>
                        )}
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

      {/* TAB 1.5: MODIFIER GROUPS & ITEMS CRUD */}
      {subTab === 'MODIFIERS' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <div className="xl:col-span-5 space-y-5">
            {/* Create Group */}
            <div className="rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-4 text-xs">
              <h3 className="font-google-display text-[18px] font-normal text-[#202124]">
                1. สร้างกลุ่มตัวเลือกเสริมใหม่ (ความหวาน / ท็อปปิ้ง)
              </h3>
              <div className="grid grid-cols-3 gap-2.5">
                <input
                  type="text"
                  placeholder="ชื่อกลุ่มตัวเลือก..."
                  value={modGroupName}
                  onChange={(e) => setModGroupName(e.target.value)}
                  className="col-span-2 h-11 rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                />
                <select
                  value={modGroupType}
                  onChange={(e) => setModGroupType(e.target.value as 'SINGLE' | 'MULTIPLE')}
                  className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                >
                  <option value="SINGLE">เลือก 1 ข้อ</option>
                  <option value="MULTIPLE">เลือกหลายข้อ</option>
                </select>
              </div>
              <button
                type="button"
                disabled={busy || !modGroupName.trim()}
                onClick={() => void handleCreateModifierGroup()}
                className="h-[46px] w-full rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
              >
                + สร้างกลุ่มตัวเลือกเสริม
              </button>
            </div>

            {/* Create Modifier Item */}
            <div className="rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-4 text-xs">
              <h3 className="font-google-display text-[18px] font-normal text-[#202124]">
                2. เพิ่มรายการย่อยในกลุ่มตัวเลือก
              </h3>
              {bootstrap.modifierGroups.length === 0 ? (
                <div className="rounded-[8px] bg-[#e8f0fe] p-4 text-xs text-[#202124]">
                  กรุณาสร้างกลุ่มตัวเลือกเสริมในฟอร์มด้านบนอย่างน้อย 1 กลุ่มก่อนเพิ่มรายการย่อย
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-[#5f6368] mb-1">เลือกกลุ่มเป้าหมาย</label>
                    <select
                      value={modTargetGroupId}
                      onChange={(e) => setModTargetGroupId(e.target.value)}
                      className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                    >
                      {bootstrap.modifierGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.selectionType})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[#5f6368] mb-1">ชื่อตัวเลือก</label>
                      <input
                        type="text"
                        placeholder="เช่น หวานน้อย 25%, เพิ่มบุก"
                        value={modItemName}
                        onChange={(e) => setModItemName(e.target.value)}
                        className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[#5f6368] mb-1">ราคาบวกเพิ่ม (บาท)</label>
                      <input
                        type="text"
                        value={modPriceDeltaBaht}
                        onChange={(e) => setModPriceDeltaBaht(e.target.value)}
                        className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-right text-[#1a73e8] font-medium tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[#5f6368] mb-1">กลไกตัดสต็อกเบื้องหลัง</label>
                    <select
                      value={modMode}
                      onChange={(e) =>
                        setModMode(e.target.value as 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS')
                      }
                      className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                    >
                      <option value="FIXED_QTY_DELTA">ตัดสต็อกวัตถุดิบตามปริมาณคงที่ (+40g)</option>
                      <option value="ROLE_SCALE_BPS">ปรับเปอร์เซ็นต์ตามบทบาทวัตถุดิบ (-75%)</option>
                    </select>
                  </div>

                  {modMode === 'FIXED_QTY_DELTA' ? (
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[#5f6368] mb-1">วัตถุดิบที่จะตัดเพิ่ม</label>
                        <select
                          value={modCompVariantId}
                          onChange={(e) => setModCompVariantId(e.target.value)}
                          className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                        >
                          <option value="">ไม่ตัดสต็อกวัตถุดิบ (ปรับราคาอย่างเดียว)</option>
                          {bootstrap.catalogDetailed.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.itemName} ({v.unitName})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[#5f6368] mb-1">ปริมาณที่ตัดเพิ่ม</label>
                        <input
                          type="text"
                          value={modQtyDeltaInput}
                          onChange={(e) => setModQtyDeltaInput(e.target.value)}
                          className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-right text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[#5f6368] mb-1">บทบาทวัตถุดิบในสูตร</label>
                        <select
                          value={modRoleTarget}
                          onChange={(e) => setModRoleTarget(e.target.value as ComponentRole)}
                          className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                        >
                          <option value="SWEETENER">SWEETENER (ความหวาน/ไซรัป)</option>
                          <option value="COFFEE_SHOT">COFFEE_SHOT (ช็อตกาแฟ)</option>
                          <option value="MILK_BASE">MILK_BASE (นม)</option>
                          <option value="TEA_BASE">TEA_BASE (เบสชา)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[#5f6368] mb-1">% ที่เปลี่ยนแปลง (เช่น -50)</label>
                        <input
                          type="text"
                          value={modScalePctInput}
                          onChange={(e) => setModScalePctInput(e.target.value)}
                          className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-right text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                        />
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={busy || !modItemName.trim() || !modTargetGroupId}
                    onClick={() => void handleCreateModifierItem()}
                    className="h-[46px] w-full rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
                  >
                    + บันทึกตัวเลือกเสริมเข้าสู่หน้าขาย POS
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Existing Modifier Groups & Items List */}
          <div className="xl:col-span-7 space-y-4">
            {bootstrap.modifierGroups.length === 0 ? (
              <div className="rounded-[4px] border border-[#dadce0] bg-white p-12 text-center text-xs text-[#5f6368]">
                ยังไม่มีกลุ่มตัวเลือกเสริมในระบบ — สร้างกลุ่มใหม่ทางด้านซ้าย (เช่น ระดับความหวาน, ท็อปปิ้ง)
              </div>
            ) : (
              bootstrap.modifierGroups.map((group) => (
              <div
                key={group.id}
                className="rounded-[4px] border border-[#dadce0] bg-white p-5 space-y-4"
              >
                <div className="flex items-center justify-between border-b border-[#dadce0] pb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="font-google-display text-[18px] font-normal text-[#202124]">
                      {group.name}
                    </span>
                    <span className="rounded-[48px] border border-[#dadce0] bg-[#f8f9fa] px-2.5 py-0.5 text-[11px] font-medium text-[#1a73e8]">
                      {group.selectionType}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await posTransport.deleteModifierGroup(group.id);
                      await onRefreshState();
                      onToast(`ลบกลุ่มตัวเลือก "${group.name}" แล้ว`, 'warn');
                    }}
                    className="rounded-[48px] border border-[#dadce0] bg-white px-3 py-1 text-xs font-medium text-[#5f6368] hover:border-[#202124] hover:text-[#202124] flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> ลบกลุ่ม
                  </button>
                </div>

                {group.modifiers.length === 0 ? (
                  <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] py-5 text-center text-xs text-[#5f6368]">
                    ยังไม่มีตัวเลือกย่อยในกลุ่มนี้
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {group.modifiers.map((mod) => (
                      <div
                        key={mod.id}
                        className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-3.5 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-medium text-[#202124]">{mod.name}</div>
                          <div className="text-[11px] tabular-nums-google text-[#1a73e8] mt-0.5">
                            {mod.priceDeltaSatang > 0
                              ? `+฿${formatSatangToThbString(mod.priceDeltaSatang)}`
                              : mod.priceDeltaSatang < 0
                                ? `-฿${formatSatangToThbString(Math.abs(mod.priceDeltaSatang))}`
                                : 'ไม่บวกราคา'}{' '}
                            ·{' '}
                            <span className="text-[#5f6368]">
                              {mod.modifierMode === 'ROLE_SCALE_BPS'
                                ? `${mod.targetComponentRole} ${mod.scaleBasisPoints / 100}%`
                                : mod.componentVariantId
                                  ? `${mod.quantityDeltaMilli >= 0 ? '+' : ''}${mod.quantityDeltaMilli / 1000} หน่วย`
                                  : 'ไม่ตัดสต็อก'}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={`ลบ ${mod.name}`}
                          onClick={async () => {
                            await posTransport.deleteModifierItem(mod.id);
                            await onRefreshState();
                            onToast(`ลบตัวเลือก "${mod.name}" แล้ว`, 'warn');
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-full text-[#5f6368] hover:bg-white hover:text-[#202124] cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
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
          <div className="lg:col-span-7 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dadce0] pb-4">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
                  ออกใบรับสินค้าเข้าคลัง (PO) &amp; ปันส่วนค่าขนส่งแฝง
                </h3>
                <p className="text-xs text-[#5f6368] mt-0.5">
                  คำนวณด้วยสมการ i128 Largest Remainder กระจายเศษไมโครบาทครบ 100%
                </p>
              </div>
              <select
                value={poSupplierId}
                onChange={(e) => setPoSupplierId(e.target.value)}
                className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-xs text-[#202124] focus:border-[#1a73e8] focus:outline-none"
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
                <span className="text-xs font-medium text-[#5f6368]">รายการสินค้าที่รับเข้า</span>
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
                          ? formatMicroBahtToThbString(purchasableVariants[0].defaultPurchaseCostMicroBaht).replace(/,/g, '')
                          : '10.0000',
                      },
                    ])
                  }
                  className="rounded-[48px] border border-[#dadce0] bg-white px-3.5 py-1 text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" /> เพิ่มแถวสินค้า
                </button>
              </div>

              {purchasableVariants.length === 0 ? (
                <div className="rounded-[8px] bg-[#e8f0fe] p-4 text-xs text-[#202124]">
                  ยังไม่มีสินค้าหรือวัตถุดิบที่รับเข้าสต็อกได้ กรุณาเพิ่มรายการในแท็บ &ldquo;ทะเบียนสินค้า &amp; คลัง&rdquo; ก่อนออกใบ PO
                </div>
              ) : (
                poLines.map((line, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 gap-2 items-center rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-2.5"
                >
                  <div className="col-span-6">
                    <select
                      value={line.variantId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLines((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, variantId: val } : r))
                        );
                      }}
                      className="h-10 w-full rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-xs text-[#202124]"
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
                  <div className="col-span-3">
                    <input
                      type="text"
                      value={line.qtyInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLines((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, qtyInput: val } : r))
                        );
                      }}
                      placeholder="จำนวน"
                      className="h-10 w-full rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-right text-xs text-[#202124] tabular-nums-google"
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      type="text"
                      value={line.unitCostBahtInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLines((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, unitCostBahtInput: val } : r))
                        );
                      }}
                      placeholder="ทุน/หน่วย"
                      className="h-10 w-full rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-right text-xs text-[#202124] tabular-nums-google"
                    />
                  </div>
                  <div className="col-span-1 text-center">
                    {poLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setPoLines((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-[#5f6368] hover:text-[#202124] cursor-pointer"
                      >
                        <X className="h-4 w-4 mx-auto" />
                      </button>
                    )}
                  </div>
                </div>
              ))
              )}
            </div>

            {/* Landed Cost Lines */}
            <div className="space-y-2.5 pt-3 border-t border-[#dadce0]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#5f6368]">
                  ค่าใช้จ่ายแฝงในการนำเข้า/ขนส่ง (Landed Costs — บาท)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPoLandedCosts((prev) => [
                      ...prev,
                      { costType: 'HANDLING', description: 'ค่ายกของ/แช่เย็น', amountBahtInput: '100.00' },
                    ])
                  }
                  className="rounded-[48px] border border-[#dadce0] bg-white px-3.5 py-1 text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" /> เพิ่มค่าขนส่งแฝง
                </button>
              </div>
              {poLandedCosts.map((lc, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 gap-2 items-center rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-2.5"
                >
                  <div className="col-span-4">
                    <select
                      value={lc.costType}
                      onChange={(e) => {
                        const val = e.target.value as typeof lc.costType;
                        setPoLandedCosts((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, costType: val } : r))
                        );
                      }}
                      className="h-10 w-full rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-xs text-[#202124]"
                    >
                      <option value="FREIGHT">FREIGHT (ค่าขนส่ง)</option>
                      <option value="CUSTOMS_DUTY">CUSTOMS (ภาษีนำเข้า)</option>
                      <option value="INSURANCE">INSURANCE (ประกันภัย)</option>
                      <option value="HANDLING">HANDLING (ค่าจัดการ)</option>
                    </select>
                  </div>
                  <div className="col-span-5">
                    <input
                      type="text"
                      value={lc.description}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLandedCosts((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, description: val } : r))
                        );
                      }}
                      className="h-10 w-full rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-xs text-[#202124]"
                    />
                  </div>
                  <div className="col-span-3">
                    <input
                      type="text"
                      value={lc.amountBahtInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPoLandedCosts((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, amountBahtInput: val } : r))
                        );
                      }}
                      className="h-10 w-full rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-right text-xs font-medium text-[#1a73e8] tabular-nums-google"
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
                className="h-[48px] rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] hover:bg-[#f8f9fa] disabled:opacity-40 cursor-pointer"
              >
                จำลองคำนวณ MAC ก่อนรับจริง (Preview)
              </button>
              <button
                type="button"
                disabled={busy || poLines.length === 0 || purchasableVariants.length === 0 || bootstrap.suppliers.length === 0}
                onClick={() => void handleReceivePo()}
                className="h-[48px] rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
              >
                ยืนยันรับของเข้าคลัง &amp; อัปเดต MAC
              </button>
            </div>
          </div>

          {/* Right: Live Preview + Recent PO History */}
          <div className="lg:col-span-5 space-y-5">
            {poPreviewLines && (
              <div className="rounded-[8px] bg-[#e8f0fe] p-5 space-y-3">
                <h4 className="font-google-display text-sm font-medium text-[#1a73e8]">
                  ผลการปันส่วนค่าขนส่งแฝง &amp; ต้นทุนเฉลี่ยใหม่ (Preview)
                </h4>
                <div className="space-y-2.5">
                  {poPreviewLines.map((p) => (
                    <div
                      key={p.variantId}
                      className="rounded-[4px] border border-[#dadce0] bg-white p-3.5 text-xs space-y-1"
                    >
                      <div className="font-medium text-[#202124]">{p.itemName}</div>
                      <div className="flex justify-between text-[#5f6368] tabular-nums-google">
                        <span>ต้นทุนสุทธิรวมค่าขนส่ง/หน่วย:</span>
                        <span className="font-medium text-[#202124]">
                          ฿{formatMicroBahtToThbString(p.effectiveUnitCostMicroBaht)}
                        </span>
                      </div>
                      <div className="flex justify-between text-[#5f6368] tabular-nums-google">
                        <span>MAC เดิม → MAC ใหม่:</span>
                        <span className="font-medium text-[#1a73e8]">
                          ฿{formatMicroBahtToThbString(p.macBeforeMicroBaht)} → ฿
                          {formatMicroBahtToThbString(p.macAfterMicroBaht)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-[4px] border border-[#dadce0] bg-white p-6">
              <h4 className="font-google-display text-[18px] font-normal text-[#202124] mb-3">
                ประวัติใบรับสินค้า (PO History)
              </h4>
              <div className="divide-y divide-[#dadce0] rounded-[4px] border border-[#dadce0] max-h-96 overflow-y-auto">
                {poHistory.length === 0 ? (
                  <p className="text-xs text-[#5f6368] py-8 text-center">ยังไม่มีประวัติใบสั่งซื้อ</p>
                ) : (
                  poHistory.map((po) => (
                    <div
                      key={po.id}
                      className="bg-white px-4 py-3 flex items-center justify-between text-xs hover:bg-[#f8f9fa]"
                    >
                      <div>
                        <div className="font-medium text-[#202124] tabular-nums-google">
                          {po.poNumber}
                        </div>
                        <div className="text-[11px] text-[#5f6368]">
                          {po.supplierName} · {po.lineCount} รายการ
                        </div>
                      </div>
                      <div className="text-right tabular-nums-google">
                        <div className="font-medium text-[#202124]">
                          ฿{formatSatangToThbString(po.grandTotalSatang)}
                        </div>
                        <div className="text-[11px] text-[#1a73e8]">
                          ค่าขนส่ง ฿{formatSatangToThbString(po.totalLandedCostSatang)}
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
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden max-w-2xl">
          <div className="bg-[#000000] p-6 text-white">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.5px] text-white/70">
              <Factory className="h-4 w-4 text-[#1a73e8]" />
              <span>Pre-Built Batch Production (use_production = 1)</span>
            </div>
            <h3 className="mt-1.5 font-google-display text-[26px] font-normal leading-[34px] tracking-[-0.25px]">
              สั่งผลิตของเตรียมขายล่วงหน้า
            </h3>
            <p className="text-xs text-white/75 mt-1">
              ตัดสต็อกวัตถุดิบตั้งต้นทันทีและคำนวณต้นทุน MAC ของวัตถุดิบกึ่งสำเร็จรูปล็อตใหม่
            </p>
          </div>

          <div className="p-6 space-y-5">
            {prepCandidates.length === 0 ? (
              <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-5 text-xs text-[#5f6368]">
                ยังไม่มีสินค้ากึ่งสำเร็จรูปในคลัง กรุณาสร้างรายการในแท็บ &ldquo;ทะเบียนสินค้า &amp; คลัง&rdquo;
                และติ๊กเลือก <strong className="text-[#202124]">ต้มเตรียมล่วงหน้า (Pre-Built)</strong> ก่อนสั่งผลิต
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block font-medium text-[#5f6368] mb-1.5">
                    เลือกรายการกึ่งสำเร็จรูป (Pre-Built Node)
                  </label>
                  <select
                    value={prepVariantId}
                    onChange={(e) => setPrepVariantId(e.target.value)}
                    className="h-12 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                  >
                    {prepCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.itemName} (คงเหลือ{' '}
                        {formatMilliUnitsToQtyString(c.inStockMilli, c.unitName)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-[#5f6368] mb-1.5">
                    ปริมาณที่ผลิตได้ในรอบนี้
                  </label>
                  <input
                    type="text"
                    value={prepQtyInput}
                    onChange={(e) => setPrepQtyInput(e.target.value)}
                    className="h-12 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-base font-medium text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                  />
                </div>
              </div>
            )}

            <button
              type="button"
              disabled={busy || prepCandidates.length === 0}
              onClick={() => void handlePrepBuild()}
              className="h-[50px] w-full rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 transition-colors cursor-pointer"
            >
              บันทึกการผลิตล็อตใหม่ &amp; ตัดวัตถุดิบตั้งต้นอัตโนมัติ
            </button>
          </div>
        </div>
      )}

      {/* TAB 4: PHYSICAL STOCKTAKE & INTER-OUTLET TRANSFERS */}
      {subTab === 'STOCKTAKE_TRANSFER' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Stocktake Worksheet */}
          <div className="xl:col-span-7 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-google-display text-[20px] font-normal text-[#202124] flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-[#1a73e8]" />
                  <span>ใบตรวจนับสต็อกจริง (Physical Stocktake · RE_COUNT)</span>
                </h3>
                <p className="text-xs text-[#5f6368] mt-0.5">
                  กรอกเฉพาะรายการที่ต้องการปรับยอดให้ตรงกับของจริงบนชั้นวาง
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleExecuteStocktake()}
                className="h-[44px] rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
              >
                ยืนยันผลตรวจนับสต็อก
              </button>
            </div>

            <div className="overflow-x-auto max-h-96 rounded-[4px] border border-[#dadce0]">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0]">
                  <tr>
                    <th className="py-2.5 px-3">รายการ</th>
                    <th className="py-2.5 px-3 text-right">ยอดในระบบ</th>
                    <th className="py-2.5 px-3 text-right">ยอดนับจริง</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#dadce0] bg-white">
                  {purchasableVariants.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-10 text-center text-[#5f6368]">
                        ยังไม่มีรายการสินค้าหรือวัตถุดิบสำหรับตรวจนับสต็อก
                      </td>
                    </tr>
                  ) : (
                    purchasableVariants.map((v) => (
                      <tr key={v.id} className="hover:bg-[#f8f9fa]">
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-[#202124]">{v.itemName}</div>
                          <div className="text-[11px] text-[#5f6368] tabular-nums-google">
                            {v.sku}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#3c4043] tabular-nums-google">
                          {formatMilliUnitsToQtyString(v.inStockMilli, v.unitName)}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <input
                            type="text"
                            placeholder={formatMilliUnitsToQtyString(v.inStockMilli)}
                            value={stocktakeInputs[v.id] ?? ''}
                            onChange={(e) =>
                              setStocktakeInputs((prev) => ({ ...prev, [v.id]: e.target.value }))
                            }
                            className="h-9 w-28 rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-right text-xs font-medium text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
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
          <div className="xl:col-span-5 rounded-[4px] border border-[#dadce0] bg-white p-6 space-y-4">
            <h3 className="font-google-display text-[20px] font-normal text-[#202124] flex items-center gap-2">
              <ArrowLeftRight className="h-5 w-5 text-[#1a73e8]" />
              <span>โอนย้ายสต็อกระหว่างสาขา</span>
            </h3>

            {bootstrap.outlets.length < 2 && (
              <div className="rounded-[8px] bg-[#e8f0fe] p-4 space-y-2.5">
                <div className="text-xs font-medium text-[#202124]">
                  เปิดสาขาที่ 2 เพื่อเริ่มใช้งานโอนสต็อกข้ามสาขา:
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newOutletCode}
                    onChange={(e) => setNewOutletCode(e.target.value)}
                    className="h-10 w-24 rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-xs tabular-nums-google"
                  />
                  <input
                    type="text"
                    value={newOutletName}
                    onChange={(e) => setNewOutletName(e.target.value)}
                    className="h-10 flex-1 rounded-[4px] border border-[#dadce0] bg-white px-2.5 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateBranchOutlet()}
                    className="h-10 rounded-[48px] bg-[#1a73e8] px-4 text-xs font-medium text-white hover:bg-[#1967d2] cursor-pointer"
                  >
                    + เปิดสาขา
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[#5f6368] mb-1">
                  โอนจากคลังหลัก (OUTLET-HQ) ไปยัง
                </label>
                <select
                  value={trDestOutletId}
                  onChange={(e) => setTrDestOutletId(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                >
                  <option value="">-- เลือกสาขาปลายทาง --</option>
                  {bootstrap.outlets
                    .filter((o) => o.id !== 'OUTLET-HQ')
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.code} — {o.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={trVariantId}
                  onChange={(e) => setTrVariantId(e.target.value)}
                  className="col-span-2 h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-[#202124]"
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
                  value={trQtyInput}
                  onChange={(e) => setTrQtyInput(e.target.value)}
                  className="h-11 rounded-[4px] border border-[#dadce0] bg-white px-3 text-right text-[#202124] tabular-nums-google"
                />
              </div>
              <button
                type="button"
                disabled={busy || !trDestOutletId}
                onClick={() => void handleDispatchTransfer()}
                className="h-[46px] w-full rounded-[48px] bg-[#1a73e8] px-5 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
              >
                ส่งออกใบโอนย้ายสต็อก (TRANSFER_OUT)
              </button>
            </div>

            <div className="divide-y divide-[#dadce0] rounded-[4px] border border-[#dadce0] max-h-60 overflow-y-auto">
              {transfersList.length === 0 ? (
                <div className="py-6 text-center text-xs text-[#5f6368]">
                  ยังไม่มีประวัติใบโอนย้ายสต็อกระหว่างสาขา
                </div>
              ) : (
                transfersList.map((tr) => (
                  <div
                    key={tr.id}
                    className="bg-white px-4 py-3 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-[#202124] tabular-nums-google">
                        {tr.transferNumber}
                      </div>
                      <div className="text-[11px] text-[#5f6368]">
                        {tr.sourceOutletName} → {tr.destinationOutletName} ({tr.status})
                      </div>
                      {tr.items.length > 0 && (
                        <div className="text-[11px] text-[#3c4043] mt-0.5 truncate tabular-nums-google">
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
                        className="shrink-0 rounded-[48px] bg-[#1a73e8] px-4 py-1.5 text-[11px] font-medium text-white hover:bg-[#1967d2] cursor-pointer"
                      >
                        กดรับของเข้าสาขา
                      </button>
                    ) : (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-[#1a73e8]">
                        <CheckCircle2 className="h-3.5 w-3.5" /> สำเร็จ
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: IMMUTABLE DOUBLE-ENTRY AUDIT LEDGER */}
      {subTab === 'LEDGER' && (
        <div className="rounded-[4px] border border-[#dadce0] bg-white overflow-hidden">
          <div className="p-5 border-b border-[#dadce0] bg-[#f8f9fa] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="h-5 w-5 text-[#1a73e8] shrink-0 mt-0.5" />
              <div>
                <h3 className="font-google-display text-[18px] font-normal text-[#202124]">
                  สมุดบัญชีความเคลื่อนไหวสต็อกห้ามแก้ไข/ลบ (Immutable inventory_transactions)
                </h3>
                <p className="text-xs text-[#5f6368]">
                  ป้องกันการแก้ไขย้อนหลังด้วย SQLite Triggers ระดับฐานข้อมูล + ตรวจสอบสมการผลรวมตรงกับคงเหลือ 100%
                </p>
              </div>
            </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className={`rounded-[48px] border px-3 py-1 text-[11px] font-medium ${
                    bootstrap.ledgerInvariant.valid
                      ? 'border-[#1a73e8] bg-[#e8f0fe] text-[#1a73e8]'
                      : 'border-[#202124] bg-[#202124] text-white'
                  }`}
                >
                  {bootstrap.ledgerInvariant.valid
                    ? 'Ledger Conservation: 100% ตรงกัน'
                    : `พบส่วนต่าง ${bootstrap.ledgerInvariant.mismatches.length} รายการ`}
                </span>
                <select
                  value={ledgerVariantFilter}
                  onChange={(e) => setLedgerVariantFilter(e.target.value)}
                  className="h-10 rounded-[4px] border border-[#dadce0] bg-white px-3 text-xs text-[#202124]"
                >
                  <option value="">-- แสดงทุกรายการสินค้า --</option>
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
              <thead className="bg-[#f8f9fa] text-[#5f6368] font-medium border-b border-[#dadce0] sticky top-0">
                <tr>
                  <th className="py-3 px-4">เวลา / อ้างอิง</th>
                  <th className="py-3 px-4">ประเภทธุรกรรม</th>
                  <th className="py-3 px-4">สินค้า / วัตถุดิบ</th>
                  <th className="py-3 px-4 text-right">เปลี่ยนแปลง</th>
                  <th className="py-3 px-4 text-right">ก่อน → หลัง</th>
                  <th className="py-3 px-4 text-right">ต้นทุน/หน่วย</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#dadce0] bg-white">
                {ledgerRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-[#5f6368]">
                      ยังไม่มีรายการความเคลื่อนไหวสต็อกในสมุดบัญชี
                    </td>
                  </tr>
                ) : (
                  ledgerRows.map((row) => (
                    <tr key={row.id} className="hover:bg-[#f8f9fa]">
                      <td className="py-2.5 px-4 tabular-nums-google">
                        <div className="text-[#202124]">
                          {new Date(row.createdAt).toLocaleString('th-TH')}
                        </div>
                        <div className="text-[11px] text-[#5f6368]">
                          {row.referenceType} · {row.referenceId} · โดย {row.performedByName}
                        </div>
                      </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`rounded-[4px] border px-2 py-0.5 text-[11px] font-medium ${
                          row.quantityChangeMilli >= 0
                            ? 'border-[#1a73e8] bg-[#e8f0fe] text-[#1a73e8]'
                            : 'border-[#dadce0] bg-[#f8f9fa] text-[#3c4043]'
                        }`}
                      >
                        {row.transactionType}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-[#202124]">{row.itemName}</div>
                      <div className="text-[11px] text-[#5f6368] tabular-nums-google">{row.sku}</div>
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-medium tabular-nums-google ${
                        row.quantityChangeMilli >= 0 ? 'text-[#1a73e8]' : 'text-[#202124]'
                      }`}
                    >
                      {row.quantityChangeMilli >= 0 ? '+' : ''}
                      {formatMilliUnitsToQtyString(row.quantityChangeMilli, row.unitName)}
                    </td>
                    <td className="py-2.5 px-4 text-right text-[#5f6368] tabular-nums-google">
                      {formatMilliUnitsToQtyString(row.stockBeforeMilli)} →{' '}
                      <strong className="font-medium text-[#202124]">
                        {formatMilliUnitsToQtyString(row.stockAfterMilli)}
                      </strong>
                    </td>
                    <td className="py-2.5 px-4 text-right text-[#5f6368] tabular-nums-google">
                      ฿{formatMicroBahtToThbString(row.unitCostMicroBaht)}
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
      {productModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-xl rounded-[8px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#dadce0] px-6 py-4 bg-white">
              <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
                {editingVariantId ? 'แก้ไขข้อมูลสินค้า / วัตถุดิบ' : 'เพิ่มสินค้า / วัตถุดิบใหม่เข้าคลัง'}
              </h3>
              <button
                type="button"
                aria-label="ปิดหน้าต่างสินค้า"
                onClick={() => setProductModalOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="sm:col-span-2">
                <label className="block text-[#5f6368] mb-1">ชื่อสินค้า / เมนู / วัตถุดิบ</label>
                <input
                  type="text"
                  value={prodName}
                  onChange={(e) => setProdName(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">รหัส SKU</label>
                <input
                  type="text"
                  value={prodSku}
                  onChange={(e) => setProdSku(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">รหัสบาร์โค้ด (เว้นว่างได้สำหรับวัตถุดิบ)</label>
                <input
                  type="text"
                  value={prodBarcode}
                  onChange={(e) => setProdBarcode(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">หมวดหมู่</label>
                <select
                  value={prodCategoryId}
                  onChange={(e) => setProdCategoryId(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                >
                  {bootstrap.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} (สถานี {c.kitchenStation})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">หน่วยนับ (เช่น ชิ้น, แก้ว, กก., มล.)</label>
                <input
                  type="text"
                  value={prodUnit}
                  onChange={(e) => setProdUnit(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#1a73e8] font-medium mb-1">ราคาขายหน้าร้าน (บาท)</label>
                <input
                  type="text"
                  value={prodPriceBaht}
                  onChange={(e) => setProdPriceBaht(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 font-medium text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">ต้นทุนซื้อตั้งต้นต่อหน่วย (บาท)</label>
                <input
                  type="text"
                  value={prodCostBaht}
                  onChange={(e) => setProdCostBaht(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              {!editingVariantId && (
                <div>
                  <label className="block text-[#5f6368] mb-1">สต็อกยกมาเริ่มต้น</label>
                  <input
                    type="text"
                    value={prodInitStock}
                    onChange={(e) => setProdInitStock(e.target.value)}
                    className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                  />
                </div>
              )}
              <div>
                <label className="block text-[#5f6368] mb-1">จุดเตือนสต็อกต่ำ (Low Stock)</label>
                <input
                  type="text"
                  value={prodLowStock}
                  onChange={(e) => setProdLowStock(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2 grid grid-cols-3 gap-2.5 pt-2">
                <label className="flex items-center gap-2 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-3 text-[#202124] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={prodIsComposite}
                    onChange={(e) => setProdIsComposite(e.target.checked)}
                    className="accent-[#1a73e8]"
                  />
                  <span>ผูกสูตร BOM</span>
                </label>
                <label className="flex items-center gap-2 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-3 text-[#202124] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={prodUseProduction}
                    onChange={(e) => {
                      setProdUseProduction(e.target.checked);
                      if (e.target.checked) setProdIsComposite(true);
                    }}
                    className="accent-[#1a73e8]"
                  />
                  <span>ต้มเตรียมล่วงหน้า</span>
                </label>
                <label className="flex items-center gap-2 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] p-3 text-[#202124] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={prodIsScale}
                    onChange={(e) => setProdIsScale(e.target.checked)}
                    className="accent-[#1a73e8]"
                  />
                  <span>สินค้าชั่ง กก.</span>
                </label>
              </div>
            </div>

            <div className="border-t border-[#dadce0] bg-[#f8f9fa] px-6 py-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setProductModalOpen(false)}
                className="h-[46px] rounded-[48px] border border-[#dadce0] bg-white px-6 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={busy || !prodName.trim() || !prodSku.trim()}
                onClick={() => void handleSaveProduct()}
                className="h-[46px] rounded-[48px] bg-[#1a73e8] px-7 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
              >
                บันทึกรายการสินค้า
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: QUICK STOCK ADJUSTMENT */}
      {adjTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-md rounded-[8px] border border-[#dadce0] bg-white overflow-hidden">
            <div className="border-b border-[#dadce0] px-6 py-4">
              <h3 className="font-google-display text-[20px] font-normal text-[#202124]">
                ปรับปรุงสต็อก ({adjTarget.itemName})
              </h3>
              <p className="text-xs text-[#5f6368] mt-1">
                คงเหลือปัจจุบัน:{' '}
                <strong className="font-medium text-[#202124] tabular-nums-google">
                  {formatMilliUnitsToQtyString(adjTarget.inStockMilli, adjTarget.unitName)}
                </strong>
              </p>
            </div>
            <div className="p-6 space-y-4 text-xs">
              <div>
                <label className="block text-[#5f6368] mb-1">
                  ปริมาณที่ต้องการเพิ่ม/ลด (เช่น -1.500 หรือ 5.000)
                </label>
                <input
                  type="text"
                  value={adjDeltaInput}
                  onChange={(e) => setAdjDeltaInput(e.target.value)}
                  className="h-12 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-base font-medium text-[#202124] tabular-nums-google focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[#5f6368] mb-1">สาเหตุการปรับปรุง</label>
                <input
                  type="text"
                  value={adjReason}
                  onChange={(e) => setAdjReason(e.target.value)}
                  className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-xs text-[#202124] focus:border-[#1a73e8] focus:outline-none"
                />
              </div>
            </div>
            <div className="border-t border-[#dadce0] bg-[#f8f9fa] px-6 py-4 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setAdjTarget(null)}
                className="h-[44px] rounded-[48px] border border-[#dadce0] bg-white px-5 font-google-display text-xs font-medium text-[#1a73e8] hover:border-[#1a73e8] cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmAdjustment()}
                className="h-[44px] rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-xs font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] cursor-pointer"
              >
                ยืนยันบันทึกสมุดสต็อก
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
