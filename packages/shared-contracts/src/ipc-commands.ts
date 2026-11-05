/**
 * RUBE-STOCK-POS v3.1 Type-Safe IPC Commands & Domain DTOs
 */

import {
  type BasisPoints,
  type MicroBaht,
  type MilliUnit,
  type Satang,
  type TaxMode,
  SCALE_BASIS_POINTS,
  SCALE_MILLI,
  roundDivBigInt,
} from './fixed-point.ts';

export type BusinessProfile = 'RETAIL' | 'HOSPITALITY' | 'HYBRID';
export type UserRole = 'OWNER' | 'MANAGER' | 'CASHIER' | 'WAREHOUSE' | 'KITCHEN';
export type TerminalRole = 'LEADER' | 'FOLLOWER_POS' | 'FOLLOWER_KDS';

export type ComponentRole =
  | 'STANDARD'
  | 'SWEETENER'
  | 'MILK_BASE'
  | 'COFFEE_SHOT'
  | 'TEA_BASE'
  | 'TOPPING'
  | 'PACKAGING';

export type ModifierMode = 'FIXED_QTY_DELTA' | 'ROLE_SCALE_BPS';

export interface ItemVariantDto {
  id: string;
  itemId: string;
  itemName: string;
  variantName: string;
  sku: string;
  barcode: string | null;
  unitName: string;
  priceSatang: Satang;
  averageCostMicroBaht: MicroBaht;
  inStockMilli: MilliUnit;
  isComposite: boolean;
  useProduction: boolean;
  isWeightedScale: boolean;
}

export interface BomEdgeDto {
  compositeVariantId: string;
  componentVariantId: string;
  componentRole: ComponentRole;
  quantityMilli: MilliUnit;
  wastageBasisPoints: BasisPoints;
}

export interface ModifierDto {
  id: string;
  modifierGroupId: string;
  name: string;
  priceDeltaSatang: Satang;
  modifierMode: ModifierMode;
  componentVariantId: string | null;
  quantityDeltaMilli: MilliUnit;
  targetComponentRole: ComponentRole | null;
  scaleBasisPoints: BasisPoints;
}

export interface PosShiftDto {
  id: string;
  shiftNumber: string;
  outletId: string;
  terminalId: string;
  openedBy: string;
  status: 'OPEN' | 'CLOSED';
  openingCashSatang: Satang;
  expectedCashSatang: Satang;
  countedCashSatang: Satang | null;
  cashVarianceSatang: Satang | null;
  openedAt: string;
}

export interface CheckoutOrderRequest {
  idempotencyKey: string;
  outletId: string;
  terminalId: string;
  shiftId: string;
  cashierId: string;
  orderType: 'RETAIL' | 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  taxMode: TaxMode;
  discountSatang: Satang;
  paymentMethod: 'CASH' | 'PROMPTPAY_QR' | 'CARD' | 'VOUCHER';
  cashTenderedSatang?: Satang;
  slipTransRefRaw?: string;
  lines: ReadonlyArray<{
    variantId: string;
    quantityMilli: MilliUnit;
    unitPriceSatang: Satang;
    selectedModifierIds: readonly string[];
  }>;
}

/**
 * Section 5.2.1: Directed Acyclic Graph (DAG) Cycle Detection using DFS
 */
export function validateBomDagAcyclic(edges: readonly BomEdgeDto[]): {
  valid: boolean;
  cyclePath?: string[];
} {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.compositeVariantId === edge.componentVariantId) {
      return { valid: false, cyclePath: [edge.compositeVariantId, edge.componentVariantId] };
    }
    const list = adj.get(edge.compositeVariantId) ?? [];
    list.push(edge.componentVariantId);
    adj.set(edge.compositeVariantId, list);
  }

  const state = new Map<string, number>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    state.set(node, 1);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      const neighborState = state.get(neighbor) ?? 0;
      if (neighborState === 1) {
        const cycleStartIdx = path.indexOf(neighbor);
        return [...path.slice(cycleStartIdx), neighbor];
      }
      if (neighborState === 0) {
        const found = dfs(neighbor);
        if (found) return found;
      }
    }

    path.pop();
    state.set(node, 2);
    return null;
  }

  for (const node of adj.keys()) {
    if ((state.get(node) ?? 0) === 0) {
      const cycle = dfs(node);
      if (cycle) {
        return { valid: false, cyclePath: cycle };
      }
    }
  }

  return { valid: true };
}

/**
 * Section 5.2.2 & 5.2.3: Multi-Level BOM Deduction with Pre-Built Stopping Rule (`useProduction = true`)
 * and Role-Based Modifiers (`ROLE_SCALE_BPS` & `FIXED_QTY_DELTA`).
 */
export interface StockDeductionEntry {
  variantId: string;
  transactionType: 'SALE_DIRECT' | 'SALE_BOM' | 'SALE_MODIFIER';
  quantityChangeMilli: MilliUnit;
  unitCostMicroBaht: MicroBaht;
  lineCogsMicroBaht: MicroBaht;
}

export function calculateOrderLineDeductions(
  soldVariant: ItemVariantDto,
  soldQtyMilli: MilliUnit,
  selectedModifiers: readonly ModifierDto[],
  variantCatalog: ReadonlyMap<string, ItemVariantDto>,
  bomEdges: readonly BomEdgeDto[]
): StockDeductionEntry[] {
  const deductions: StockDeductionEntry[] = [];
  const qSold = BigInt(soldQtyMilli);

  const roleScaleMap = new Map<ComponentRole, bigint>();
  for (const mod of selectedModifiers) {
    if (mod.modifierMode === 'ROLE_SCALE_BPS' && mod.targetComponentRole) {
      const prev = roleScaleMap.get(mod.targetComponentRole) ?? 0n;
      roleScaleMap.set(mod.targetComponentRole, prev + BigInt(mod.scaleBasisPoints));
    }
  }

  if (!soldVariant.isComposite) {
    const cogs = roundDivBigInt(qSold * BigInt(soldVariant.averageCostMicroBaht), SCALE_MILLI);
    deductions.push({
      variantId: soldVariant.id,
      transactionType: 'SALE_DIRECT',
      quantityChangeMilli: -soldQtyMilli,
      unitCostMicroBaht: soldVariant.averageCostMicroBaht,
      lineCogsMicroBaht: Number(cogs),
    });
  } else {
    function expandBom(parentVariantId: string, parentMultiplierMilli: bigint): void {
      const children = bomEdges.filter((e) => e.compositeVariantId === parentVariantId);
      for (const edge of children) {
        const childVariant = variantCatalog.get(edge.componentVariantId);
        if (!childVariant) {
          throw new Error(`Missing component variant ${edge.componentVariantId}`);
        }

        const roleScaleBps = roleScaleMap.get(edge.componentRole) ?? 0n;
        const effectiveFactorBps = SCALE_BASIS_POINTS + roleScaleBps;
        const clampedFactorBps = effectiveFactorBps < 0n ? 0n : effectiveFactorBps;

        const scaledRecipeQtyMilli = roundDivBigInt(
          BigInt(edge.quantityMilli) * clampedFactorBps,
          SCALE_BASIS_POINTS
        );

        const cumulativeQtyMilli = roundDivBigInt(
          parentMultiplierMilli * scaledRecipeQtyMilli * (SCALE_BASIS_POINTS + BigInt(edge.wastageBasisPoints)),
          SCALE_MILLI * SCALE_BASIS_POINTS
        );

        if (childVariant.isComposite && !childVariant.useProduction) {
          expandBom(childVariant.id, cumulativeQtyMilli);
        } else if (cumulativeQtyMilli > 0n) {
          const cogs = roundDivBigInt(
            cumulativeQtyMilli * BigInt(childVariant.averageCostMicroBaht),
            SCALE_MILLI
          );
          deductions.push({
            variantId: childVariant.id,
            transactionType: 'SALE_BOM',
            quantityChangeMilli: -Number(cumulativeQtyMilli),
            unitCostMicroBaht: childVariant.averageCostMicroBaht,
            lineCogsMicroBaht: Number(cogs),
          });
        }
      }
    }

    expandBom(soldVariant.id, qSold);
  }

  for (const mod of selectedModifiers) {
    if (
      mod.modifierMode === 'FIXED_QTY_DELTA' &&
      mod.componentVariantId &&
      mod.quantityDeltaMilli !== 0
    ) {
      const modVariant = variantCatalog.get(mod.componentVariantId);
      if (!modVariant) continue;
      const deltaMilli = roundDivBigInt(qSold * BigInt(mod.quantityDeltaMilli), SCALE_MILLI);
      if (deltaMilli === 0n) continue;
      const absDelta = deltaMilli < 0n ? -deltaMilli : deltaMilli;
      const cogs = roundDivBigInt(absDelta * BigInt(modVariant.averageCostMicroBaht), SCALE_MILLI);
      deductions.push({
        variantId: modVariant.id,
        transactionType: 'SALE_MODIFIER',
        quantityChangeMilli: -Number(deltaMilli),
        unitCostMicroBaht: modVariant.averageCostMicroBaht,
        lineCogsMicroBaht: Number(cogs),
      });
    }
  }

  return deductions;
}

