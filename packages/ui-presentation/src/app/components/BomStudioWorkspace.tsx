import React, { useEffect, useId, useMemo, useState } from 'react';
import { GitBranch, Layers, Plus, ShieldAlert, Sparkles, Trash2 } from 'lucide-react';
import {
  formatMicroBahtToThbString,
  formatMilliUnitsToQtyString,
  formatSatangToThbString,
  parseDecimalStringToScaledInt,
  roundDivBigInt,
  SCALE_BASIS_POINTS,
} from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type { BootstrapPayload, ComponentRole, StaffUserDto } from '../types.ts';
import { canEditBomRecipes } from '../utils/rbac.ts';
import { ConfirmDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface BomStudioWorkspaceProps {
  outletId?: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  simulationModeEnabled?: boolean;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

const COMPONENT_ROLES: ComponentRole[] = [
  'STANDARD',
  'TEA_BASE',
  'MILK_BASE',
  'COFFEE_SHOT',
  'SWEETENER',
  'TOPPING',
  'PACKAGING',
];

export const BomStudioWorkspace: React.FC<BomStudioWorkspaceProps> = ({
  outletId = 'OUTLET-HQ',
  bootstrap,
  currentUser,
  simulationModeEnabled = false,
  onRefreshState,
  onToast,
}) => {
  const canEdit = canEditBomRecipes(currentUser.role);
  const compositeVariants = useMemo(
    () => bootstrap.catalogDetailed.filter((v) => v.isComposite),
    [bootstrap.catalogDetailed]
  );

  const [selectedParentId, setSelectedParentId] = useState<string>(
    compositeVariants[0]?.id ?? ''
  );
  const [simModIds, setSimModIds] = useState<string[]>(['MOD-SWEET-50', 'MOD-EXTRA-BOBA']);
  const [simPreview, setSimPreview] = useState<{
    deductions: Array<{
      variantId: string;
      transactionType: string;
      quantityChangeMilli: number;
      unitCostMicroBaht: number;
      lineCogsMicroBaht: number;
    }>;
    totalCogsMicroBaht?: number | undefined;
    totalRecipeCogsMicroBaht?: number | undefined;
  } | null>(null);

  // Add Edge Form
  const [childVariantId, setChildVariantId] = useState<string>('VAR-RAW-MILK');
  const [edgeRole, setEdgeRole] = useState<ComponentRole>('MILK_BASE');
  const [edgeQtyInput, setEdgeQtyInput] = useState<string>('120.000');
  const [edgeWastagePctInput, setEdgeWastagePctInput] = useState<string>('2.00');
  const [cycleErrorAlert, setCycleErrorAlert] = useState<string | null>(null);

  const uid = useId();
  const [confirmDeleteComp, setConfirmDeleteComp] = useState<{
    compId: string;
    compName: string;
  } | null>(null);
  const [deletingEdge, setDeletingEdge] = useState(false);

  const catalogMap = useMemo(
    () => new Map(bootstrap.catalogDetailed.map((v) => [v.id, v])),
    [bootstrap.catalogDetailed]
  );

  const selectedParent = catalogMap.get(selectedParentId);
  const directEdges = useMemo(
    () => bootstrap.bomEdges.filter((e) => e.compositeVariantId === selectedParentId),
    [bootstrap.bomEdges, selectedParentId]
  );

  const nonParentCatalog = useMemo(
    () => bootstrap.catalogDetailed.filter((v) => v.id !== selectedParentId),
    [bootstrap.catalogDetailed, selectedParentId]
  );

  useEffect(() => {
    if (
      compositeVariants.length > 0 &&
      !compositeVariants.some((v) => v.id === selectedParentId)
    ) {
      setSelectedParentId(compositeVariants[0]!.id);
    } else if (compositeVariants.length === 0 && selectedParentId) {
      setSelectedParentId('');
    }
    if (nonParentCatalog.length > 0 && !nonParentCatalog.some((v) => v.id === childVariantId)) {
      setChildVariantId(nonParentCatalog[0]!.id);
    } else if (nonParentCatalog.length === 0 && childVariantId) {
      setChildVariantId('');
    }
  }, [childVariantId, compositeVariants, nonParentCatalog, selectedParentId]);

  useEffect(() => {
    if (!selectedParentId || !compositeVariants.some((v) => v.id === selectedParentId)) {
      setSimPreview(null);
      return;
    }
    void posTransport
      .previewBomRecipe({
        outletId,
        compositeVariantId: selectedParentId,
        qtyMilli: 1_000,
        selectedModifierIds: simModIds,
      })
      .then((res) => setSimPreview(res))
      .catch(() => setSimPreview(null));
  }, [compositeVariants, outletId, selectedParentId, simModIds, bootstrap.bomEdges]);

  const handleUpsertEdge = async (override?: {
    compositeVariantId: string;
    componentVariantId: string;
    componentRole: ComponentRole;
    quantityMilli: number;
    wastageBasisPoints: number;
  }) => {
    setCycleErrorAlert(null);
    try {
      const payload = override ?? {
        compositeVariantId: selectedParentId,
        componentVariantId: childVariantId,
        componentRole: edgeRole,
        quantityMilli: parseDecimalStringToScaledInt(edgeQtyInput, 3),
        wastageBasisPoints: parseDecimalStringToScaledInt(edgeWastagePctInput || '0', 2),
      };
      await posTransport.upsertBomEdge(payload);
      await onRefreshState();
      onToast('บันทึกโครงสร้างสูตรการผลิต (BOM DAG) สำเร็จ', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCycleErrorAlert(msg);
      onToast(msg, 'error');
    }
  };

  const handleDeleteEdge = async (compId: string) => {
    try {
      await posTransport.deleteBomEdge(selectedParentId, compId);
      await onRefreshState();
      onToast('ลบส่วนประกอบออกจากสูตรสำเร็จ', 'warn');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const totalCogsMicroBaht =
    simPreview?.totalCogsMicroBaht ?? simPreview?.totalRecipeCogsMicroBaht ?? 0;
  const totalCogsSatang = Number(roundDivBigInt(BigInt(totalCogsMicroBaht), 10_000n));
  const sellingSatang =
    (selectedParent?.priceSatang ?? 0) +
    bootstrap.modifiers
      .filter((m) => simModIds.includes(m.id))
      .reduce((s, m) => s + m.priceDeltaSatang, 0);
  const grossMarginBps =
    sellingSatang > 0
      ? Number(
          roundDivBigInt(
            BigInt(sellingSatang - totalCogsSatang) * SCALE_BASIS_POINTS,
            BigInt(sellingSatang)
          )
        )
      : 0;
  const grossMarginPct = (grossMarginBps / 100).toFixed(1);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* LEFT: Recipe Parent Selector & DAG Edge Editor */}
      <div className="xl:col-span-7 space-y-5">
        <div className="rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
                <GitBranch className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-google-display text-[22px] font-normal leading-[28px] text-ink">
                  สตูดิโอผูกสูตรการผลิตหลายระดับ (Multi-Level BOM DAG)
                </h2>
                <p className="text-xs text-ink-muted mt-1">
                  ตรวจจับสูตรวนลูปด้วย DFS อัตโนมัติ (HTTP 422) พร้อมกฎหยุดแตกแขนงที่โหนดต้มล่วงหน้า
                </p>
              </div>
            </div>

            <select
              aria-label="เลือกเมนูผูกสูตร BOM"
              value={selectedParentId}
              disabled={compositeVariants.length === 0}
              onChange={(e) => {
                setSelectedParentId(e.target.value);
                setCycleErrorAlert(null);
              }}
              className={`h-11 max-w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-xs font-medium text-ink ${UI_INTERACTION.focusSelect}`}
            >
              {compositeVariants.length === 0 ? (
                <option value="">ยังไม่มีเมนูผูกสูตร BOM</option>
              ) : (
                compositeVariants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.itemName} ({v.useProduction ? 'Pre-Built ต้มเตรียมไว้' : 'เมนูขายหน้าร้าน'})
                  </option>
                ))
              )}
            </select>
          </div>

          {compositeVariants.length === 0 && (
            <div className="rounded-[8px] bg-primary-soft p-4 text-xs text-ink">
              ยังไม่มีเมนูที่เปิดใช้งาน <strong className="font-medium">ผูกสูตร BOM</strong> —
              กรุณาไปที่แท็บ <strong className="font-medium">&ldquo;คลังสินค้า &amp; PO&rdquo;</strong>{' '}
              เพื่อเพิ่มเมนูเครื่องดื่ม/อาหารหรือติ๊กเลือก &ldquo;ผูกสูตร BOM&rdquo; ก่อนกำหนดส่วนผสม
            </div>
          )}

          {cycleErrorAlert && (
            <div role="alert" className="rounded-[4px] border border-ink bg-surface-1 p-4 flex items-start gap-3 text-xs text-ink">
              <ShieldAlert className="h-5 w-5 text-ink shrink-0 mt-0.5" />
              <div>
                <div className="font-google-display text-sm font-medium text-ink">
                  บล็อกสูตรวนลูปอัตโนมัติ (Circular BOM Dependency Blocked)
                </div>
                <div className="mt-0.5 text-ink-muted tabular-nums-google">{cycleErrorAlert}</div>
              </div>
            </div>
          )}

          {/* Direct Ingredients Table */}
          <div className="overflow-x-auto rounded-[4px] border border-hairline">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                <tr>
                  <th scope="col" className="py-3 px-4">วัตถุดิบ / ส่วนประกอบย่อย</th>
                  <th scope="col" className="py-3 px-4">บทบาท (Role)</th>
                  <th scope="col" className="py-3 px-4 text-right">ปริมาณต่อสูตร</th>
                  <th scope="col" className="py-3 px-4 text-right">เผื่อสูญเสีย</th>
                  <th scope="col" className="py-3 px-4 text-center">โหมดตัดสต็อก</th>
                  <th scope="col" className="py-3 px-4 text-right">ลบ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas">
                {directEdges.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-ink-muted">
                      ยังไม่มีส่วนประกอบในสูตรนี้
                    </td>
                  </tr>
                ) : (
                  directEdges.map((edge) => {
                    const child = catalogMap.get(edge.componentVariantId);
                    const childName = child?.itemName ?? edge.componentVariantId;
                    return (
                      <tr key={edge.componentVariantId} className="hover:bg-surface-1 transition-colors duration-150">
                        <td className="py-3 px-4">
                          <div className="font-google-display text-sm font-medium text-ink">
                            {childName}
                          </div>
                          <div className="text-[11px] text-ink-muted tabular-nums-google">
                            {edge.componentVariantId}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-ink">
                            {edge.componentRole}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right text-ink tabular-nums-google">
                          {formatMilliUnitsToQtyString(edge.quantityMilli, child?.unitName ?? '')}
                        </td>
                        <td className="py-3 px-4 text-right text-ink-muted tabular-nums-google">
                          {(edge.wastageBasisPoints / 100).toFixed(2)}%
                        </td>
                        <td className="py-3 px-4 text-center">
                          {child?.useProduction ? (
                            <span className="rounded-[48px] bg-primary-soft px-2.5 py-0.5 text-[11px] font-medium text-primary-dark">
                              หยุดที่ Pre-Built
                            </span>
                          ) : child?.isComposite ? (
                            <span className="rounded-[48px] border border-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-hover">
                              แตกแขนงต่อ
                            </span>
                          ) : (
                            <span className="text-[11px] text-ink-muted">ตัดวัตถุดิบตรง</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {canEdit ? (
                            <button
                              type="button"
                              aria-label={`ลบ ${childName}`}
                              onClick={() =>
                                setConfirmDeleteComp({
                                  compId: edge.componentVariantId,
                                  compName: childName,
                                })
                              }
                              className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Add / Update Edge Form (OWNER / MANAGER) */}
          {canEdit ? (
            <div className="rounded-[4px] border border-hairline bg-surface-1 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-google-display text-sm font-medium text-ink flex items-center gap-1.5">
                  <Plus className="h-4 w-4 text-primary" />
                  เพิ่มหรือปรับสัดส่วนวัตถุดิบในสูตร
                </span>
                {simulationModeEnabled && (
                  <button
                    type="button"
                    onClick={() =>
                      void handleUpsertEdge({
                        compositeVariantId: 'VAR-RAW-DRY-BOBA',
                        componentVariantId: 'VAR-RAW-BOBA',
                        componentRole: 'STANDARD',
                        quantityMilli: 1_000,
                        wastageBasisPoints: 0,
                      })
                    }
                    className={`rounded-[48px] border border-hairline bg-canvas px-3.5 py-1.5 text-xs font-medium text-primary hover:border-primary hover:bg-primary-soft/40 ${UI_INTERACTION.focusButton}`}
                  >
                    ทดสอบจำลองสูตรวนลูป (Test DFS Guard)
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 text-xs">
                <div className="sm:col-span-5">
                  <label htmlFor={`${uid}-comp`} className="block text-ink-muted mb-1">
                    เลือกวัตถุดิบ
                  </label>
                  <select
                    id={`${uid}-comp`}
                    value={childVariantId}
                    onChange={(e) => setChildVariantId(e.target.value)}
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                  >
                    {bootstrap.catalogDetailed
                      .filter((v) => v.id !== selectedParentId)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.itemName} ({v.unitName})
                        </option>
                      ))}
                  </select>
                </div>
                <div className="sm:col-span-3">
                  <label htmlFor={`${uid}-role`} className="block text-ink-muted mb-1">
                    บทบาท (Role)
                  </label>
                  <select
                    id={`${uid}-role`}
                    value={edgeRole}
                    onChange={(e) => setEdgeRole(e.target.value as ComponentRole)}
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                  >
                    {COMPONENT_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`${uid}-qty`} className="block text-ink-muted mb-1">
                    ปริมาณ
                  </label>
                  <input
                    id={`${uid}-qty`}
                    type="text"
                    value={edgeQtyInput}
                    onChange={(e) => setEdgeQtyInput(e.target.value)}
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-right text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`${uid}-waste`} className="block text-ink-muted mb-1">
                    สูญเสีย (%)
                  </label>
                  <input
                    id={`${uid}-waste`}
                    type="text"
                    value={edgeWastagePctInput}
                    onChange={(e) => setEdgeWastagePctInput(e.target.value)}
                    className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3 text-right text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={!selectedParent || nonParentCatalog.length === 0}
                onClick={() => void handleUpsertEdge()}
                className={`h-[48px] w-full rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                {selectedParent
                  ? `บันทึกส่วนประกอบเข้าสูตร ${selectedParent.itemName}`
                  : 'กรุณาเพิ่มเมนูผูกสูตร BOM ในคลังสินค้าก่อน'}
              </button>
            </div>
          ) : (
            <div className="rounded-[4px] border border-hairline bg-surface-1 px-4 py-3 text-xs text-ink-muted">
              โหมดดูสูตรการผลิตสำหรับฝ่ายคลังสินค้า (Read-Only) — สามารถแก้ไขหรือลบส่วนประกอบได้โดยผู้จัดการร้าน (MANAGER) หรือเจ้าของร้าน (OWNER)
            </div>
          )}
        </div>
      </div>

      {/* RIGHT: Live Recipe Costing, Margin & Role-Modifier Simulator */}
      <div className="xl:col-span-5 rounded-[4px] border border-hairline bg-canvas overflow-hidden">
        {/* Canonical Near-Black Hero KPI Band */}
        <div className="bg-hero p-6 text-white space-y-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.5px] text-white/75">
            <Layers className="h-4 w-4 text-primary" />
            <span>Live COGS &amp; Gross Margin Simulator</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-white/70">ราคาขายรวม</div>
              <div className="mt-1 font-google-display text-[26px] font-normal leading-[32px] tracking-[-0.25px] text-white tabular-nums-google">
                ฿{formatSatangToThbString(sellingSatang)}
              </div>
            </div>
            <div>
              <div className="text-xs text-white/70">ต้นทุนสูตร (COGS)</div>
              <div className="mt-1 font-google-display text-[26px] font-normal leading-[32px] tracking-[-0.25px] text-white tabular-nums-google">
                ฿{formatMicroBahtToThbString(totalCogsMicroBaht)}
              </div>
            </div>
            <div>
              <div className="text-xs text-white/70">กำไรขั้นต้น (GP)</div>
              <div className="mt-1 font-google-display text-[26px] font-normal leading-[32px] tracking-[-0.25px] text-primary tabular-nums-google">
                {grossMarginPct}%
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-5 bg-canvas">
          <div>
            <div className="font-google-display text-sm font-medium text-ink mb-2">
              ทดลองเลือกตัวเลือกเสริม (ความหวาน / ท็อปปิ้ง)
            </div>
            {bootstrap.modifiers.length === 0 ? (
              <div className="rounded-[4px] border border-hairline bg-surface-1 px-3.5 py-2.5 text-xs text-ink-muted">
                ยังไม่มีตัวเลือกเสริม — สามารถเพิ่มได้ที่แท็บ &ldquo;คลังสินค้า &amp; PO → ตัวเลือกเสริม&rdquo;
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {bootstrap.modifiers.map((mod) => {
                  const active = simModIds.includes(mod.id);
                  return (
                    <button
                      key={mod.id}
                      type="button"
                      onClick={() =>
                        setSimModIds((prev) =>
                          prev.includes(mod.id) ? prev.filter((x) => x !== mod.id) : [...prev, mod.id]
                        )
                      }
                      className={`min-h-[38px] rounded-[48px] border px-3.5 text-xs font-medium ${UI_INTERACTION.focusButton} ${
                        active
                          ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                          : 'border-hairline bg-canvas text-ink-soft hover:border-primary hover:text-primary'
                      }`}
                    >
                      {mod.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-hairline pt-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-muted">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>รายการวัตถุดิบที่จะถูกตัดออกจากคลังจริงเมื่อขาย 1 หน่วย</span>
            </div>

            <div className="divide-y divide-hairline rounded-[4px] border border-hairline">
              {!simPreview || simPreview.deductions.length === 0 ? (
                <div className="py-8 px-4 text-center text-xs text-ink-muted">
                  ยังไม่มีรายการวัตถุดิบที่จะถูกตัดสต็อกในสูตรนี้
                </div>
              ) : (
                simPreview.deductions.map((d, idx) => {
                  const v = catalogMap.get(d.variantId);
                  return (
                    <div
                      key={`${d.variantId}-${idx}`}
                      className="px-4 py-3 flex items-center justify-between text-xs bg-canvas hover:bg-surface-1 transition-colors duration-150"
                    >
                      <div>
                        <div className="font-google-display text-sm font-medium text-ink">
                          {v?.itemName ?? d.variantId}
                        </div>
                        <div className="text-[11px] text-ink-muted tabular-nums-google">
                          {d.transactionType} · MAC ฿{formatMicroBahtToThbString(d.unitCostMicroBaht)}
                        </div>
                      </div>
                      <div className="text-right tabular-nums-google">
                        <div className="font-google-display text-sm font-medium text-ink">
                          {formatMilliUnitsToQtyString(d.quantityChangeMilli, v?.unitName ?? '')}
                        </div>
                        <div className="text-[11px] text-primary-hover">
                          ทุน ฿{formatMicroBahtToThbString(d.lineCogsMicroBaht)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDeleteComp)}
        title={`ลบส่วนประกอบ "${confirmDeleteComp?.compName ?? ''}" ออกจากสูตร?`}
        description="การลบส่วนประกอบจะมีผลต่อการคำนวณต้นทุน COGS และการตัดสต็อกวัตถุดิบสำหรับการขายครั้งถัดไป"
        confirmLabel="ยืนยันลบส่วนประกอบ"
        tone="danger"
        busy={deletingEdge}
        onCancel={() => {
          if (!deletingEdge) setConfirmDeleteComp(null);
        }}
        onConfirm={() => {
          if (!confirmDeleteComp) return;
          setDeletingEdge(true);
          void handleDeleteEdge(confirmDeleteComp.compId).finally(() => {
            setDeletingEdge(false);
            setConfirmDeleteComp(null);
          });
        }}
      />
    </div>
  );
};
