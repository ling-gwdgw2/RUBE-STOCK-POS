/**
 * RUBE-STOCK-POS v3.1 Fixed-Point Scaled Integer Types & 128-bit Safe Math Engine
 *
 * Storage Scale Factors:
 * - MilliUnit (*_milli): × 10^3 (1,000) -> 1.500 kg = 1500
 * - Satang (*_satang): × 10^2 (100) -> 65.00 THB = 6500
 * - MicroBaht (*_micro_baht): × 10^6 (1,000,000) -> 0.0125 THB = 12500
 * - BasisPoints (*_basis_points): × 10^4 (10,000) -> 7.00% = 700
 */

export type MilliUnit = number;
export type Satang = number;
export type MicroBaht = number;
export type MicroBahtString = string;
export type BasisPoints = number;

export const SCALE_MILLI = 1_000n;
export const SCALE_SATANG = 100n;
export const SCALE_MICRO_BAHT = 1_000_000n;
export const SCALE_BASIS_POINTS = 10_000n;
export const SATANG_TO_MICRO_BAHT = 10_000n; // 1 Satang = 10,000 Micro-Baht

export const I64_MAX = 9_223_372_036_854_775_807n;
export const I64_MIN = -9_223_372_036_854_775_808n;
export const JS_MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
export const JS_MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Safely converts a BigInt fixed-point result to a JS `number`, throwing a `RangeError`
 * if the value exceeds `i64` bounds or `Number.MAX_SAFE_INTEGER` precision limits.
 */
export function toSafeFixedPointNumber(value: bigint, context = 'Fixed-point conversion'): number {
  if (value > I64_MAX || value < I64_MIN) {
    throw new RangeError(`${context} overflow: ${value.toString()} exceeds i64 bounds`);
  }
  if (value > JS_MAX_SAFE_BIGINT || value < JS_MIN_SAFE_BIGINT) {
    throw new RangeError(
      `${context} precision overflow: ${value.toString()} exceeds Number.MAX_SAFE_INTEGER`
    );
  }
  return Number(value);
}

/**
 * 128-bit Intermediate Round-Half-Away-From-Zero Division (`round_div(a, b)` in ARCHITECTURE.md Section 5).
 * Prevents 64-bit integer overflow and guarantees symmetric rounding for positive and negative values.
 */
export function roundDivBigInt(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero in roundDivBigInt');
  }
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const halfDen = absDen / 2n;
  const quotient = (absNum + halfDen) / absDen;
  return sign * quotient;
}

export function roundDiv(numerator: number | bigint, denominator: number | bigint): number {
  const res = roundDivBigInt(BigInt(numerator), BigInt(denominator));
  return toSafeFixedPointNumber(res, 'Fixed-point roundDiv');
}

/**
 * Section 5.1.1: Exact Landed Cost Allocation via Largest Remainder Method
 */
export interface PoItemForCosting {
  id: string;
  receivedQtyMilli: MilliUnit;
  baseUnitCostMicroBaht: MicroBaht;
}

export interface AllocatedPoItemCost {
  id: string;
  baseValueMicroBaht: bigint;
  allocatedLandedCostMicroBaht: bigint;
  effectiveUnitCostMicroBaht: MicroBaht;
}

export function allocateLandedCostExact(
  items: readonly PoItemForCosting[],
  totalLandedCostSatang: Satang
): AllocatedPoItemCost[] {
  if (totalLandedCostSatang < 0) {
    throw new RangeError(`totalLandedCostSatang must be >= 0, got ${totalLandedCostSatang}`);
  }
  const totalLandedMicro = BigInt(totalLandedCostSatang) * SATANG_TO_MICRO_BAHT;
  if (items.length === 0) return [];

  const valuations = items.map((item, index) => {
    const qRec = BigInt(item.receivedQtyMilli);
    const cBase = BigInt(item.baseUnitCostMicroBaht);
    if (qRec <= 0n) {
      throw new RangeError(`Item ${item.id} receivedQtyMilli must be > 0`);
    }
    if (cBase < 0n) {
      throw new RangeError(`Item ${item.id} baseUnitCostMicroBaht must be >= 0`);
    }
    const baseValueMicro = roundDivBigInt(qRec * cBase, SCALE_MILLI);
    return { index, item, qRec, cBase, baseValueMicro };
  });

  const sumBaseValue = valuations.reduce((acc, v) => acc + v.baseValueMicro, 0n);

  if (totalLandedMicro === 0n || sumBaseValue === 0n) {
    return valuations.map((v) => ({
      id: v.item.id,
      baseValueMicroBaht: v.baseValueMicro,
      allocatedLandedCostMicroBaht: 0n,
      effectiveUnitCostMicroBaht: toSafeFixedPointNumber(v.cBase, 'baseUnitCostMicroBaht'),
    }));
  }

  const provisional = valuations.map((v) => {
    const prod = totalLandedMicro * v.baseValueMicro;
    const floorShare = prod / sumBaseValue;
    const remainder = prod % sumBaseValue;
    return { ...v, floorShare, remainder };
  });

  const sumFloor = provisional.reduce((acc, p) => acc + p.floorShare, 0n);
  let remainderMicro = totalLandedMicro - sumFloor;

  // Sort by largest remainder descending (tie-break by original index)
  const sortedByRemainder = [...provisional].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.index - b.index;
  });

  for (const entry of sortedByRemainder) {
    if (remainderMicro <= 0n) break;
    entry.floorShare += 1n;
    remainderMicro -= 1n;
  }

  return provisional.map((p) => {
    const unitLandedMicro = roundDivBigInt(p.floorShare * SCALE_MILLI, p.qRec);
    const effectiveUnitCost = p.cBase + unitLandedMicro;
    return {
      id: p.item.id,
      baseValueMicroBaht: p.baseValueMicro,
      allocatedLandedCostMicroBaht: p.floorShare,
      effectiveUnitCostMicroBaht: toSafeFixedPointNumber(
        effectiveUnitCost,
        'effectiveUnitCostMicroBaht'
      ),
    };
  });
}

/**
 * Section 5.1.3: Moving Weighted Average Cost (MAC) with Negative/Zero Stock Guard
 */
export function computeNewMovingAverageCost(
  currentStockMilli: MilliUnit,
  currentAvgCostMicroBaht: MicroBaht,
  receivedQtyMilli: MilliUnit,
  receivedUnitCostMicroBaht: MicroBaht
): MicroBaht {
  const qCurr = BigInt(currentStockMilli);
  const cCurr = BigInt(currentAvgCostMicroBaht);
  const qRec = BigInt(receivedQtyMilli);
  const cRec = BigInt(receivedUnitCostMicroBaht);

  if (qRec <= 0n) {
    throw new RangeError('receivedQtyMilli must be > 0');
  }
  if (cRec < 0n) {
    throw new RangeError('receivedUnitCostMicroBaht must be >= 0');
  }

  // Negative/Zero Stock Guard: if current stock <= 0, reset MAC to incoming batch unit cost
  if (qCurr <= 0n) {
    return toSafeFixedPointNumber(cRec, 'computeNewMovingAverageCost');
  }

  const numerator = qCurr * cCurr + qRec * cRec;
  const denominator = qCurr + qRec;
  return toSafeFixedPointNumber(
    roundDivBigInt(numerator, denominator),
    'computeNewMovingAverageCost'
  );
}

/**
 * Section 5.3.2: Thai VAT 7% Calculation (Inclusive vs. Exclusive)
 */
export type TaxMode = 'NONE' | 'INCLUSIVE' | 'EXCLUSIVE';

export function computeVatSatang(
  netAmountSatang: Satang,
  taxRateBasisPoints: BasisPoints,
  taxMode: TaxMode
): Satang {
  if (taxMode === 'NONE' || taxRateBasisPoints <= 0 || netAmountSatang <= 0) {
    return 0;
  }
  const net = BigInt(netAmountSatang);
  const rate = BigInt(taxRateBasisPoints);

  if (taxMode === 'INCLUSIVE') {
    return Number(roundDivBigInt(net * rate, SCALE_BASIS_POINTS + rate));
  }
  return Number(roundDivBigInt(net * rate, SCALE_BASIS_POINTS));
}

/**
 * Formatting helpers for UI Presentation Views (`INV_VIEW`, `PO_VIEW`, `BOM_VIEW`, `POS_TERMINAL`)
 */
export function formatMilliUnitsToQtyString(milli: MilliUnit, unitName = ''): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1_000);
  const frac = String(abs % 1_000).padStart(3, '0');
  return unitName ? `${sign}${whole}.${frac} ${unitName}` : `${sign}${whole}.${frac}`;
}

export function formatSatangToThbString(satang: Satang): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole.toLocaleString('en-US')}.${frac}`;
}

export function formatMicroBahtToThbString(microBaht: MicroBaht): string {
  const sign = microBaht < 0 ? '-' : '';
  const abs = Math.abs(microBaht);
  // Display 4 decimal places in Baht (10,000 Micro-Baht = 0.0100 THB, 100 Micro-Baht = 0.0001 THB)
  const scaled4 = Math.round(abs / 100);
  const whole = Math.floor(scaled4 / 10_000);
  const frac = String(scaled4 % 10_000).padStart(4, '0');
  return `${sign}${whole.toLocaleString('en-US')}.${frac}`;
}


