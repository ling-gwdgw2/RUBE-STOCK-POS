//! Moving Weighted Average Cost (MAC) & Exact Landed Cost Apportionment (`costing_mac.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 5.1 using `i128` intermediate math.

use crate::domains::math_i128::{
    round_div_i128, round_div_to_i64, FixedPointError, SATANG_TO_MICRO_BAHT, SCALE_MILLI,
};
use rube_shared_contracts::{MicroBaht, MilliUnit, Satang};

#[derive(Debug, Clone)]
pub struct PoLineInput {
    pub item_id: String,
    pub received_qty_milli: MilliUnit,
    pub base_unit_cost_micro_baht: MicroBaht,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoLineCostAllocation {
    pub item_id: String,
    pub allocated_landed_cost_micro_baht: i64,
    pub effective_unit_cost_micro_baht: MicroBaht,
}

/// Allocates landed cost in Satang across PO lines in Micro-Baht using the Largest Remainder Method.
/// Guarantees `sum(allocated_landed_cost_micro_baht) == total_landed_cost_satang * 10_000`.
pub fn allocate_landed_cost_exact(
    lines: &[PoLineInput],
    total_landed_cost_satang: Satang,
) -> Result<Vec<PoLineCostAllocation>, FixedPointError> {
    if lines.is_empty() {
        return Ok(Vec::new());
    }
    let total_landed_micro = (total_landed_cost_satang as i128) * SATANG_TO_MICRO_BAHT;

    let mut base_values: Vec<(usize, i128, i128, i128)> = Vec::with_capacity(lines.len());
    let mut sum_base_value: i128 = 0;

    for (idx, line) in lines.iter().enumerate() {
        if line.received_qty_milli <= 0 {
            return Err(FixedPointError::NonPositiveQuantity(line.received_qty_milli));
        }
        let q_rec = line.received_qty_milli as i128;
        let c_base = line.base_unit_cost_micro_baht as i128;
        let v_i = round_div_i128(q_rec * c_base, SCALE_MILLI)?;
        sum_base_value += v_i;
        base_values.push((idx, q_rec, c_base, v_i));
    }

    if total_landed_micro == 0 || sum_base_value == 0 {
        return Ok(lines
            .iter()
            .map(|l| PoLineCostAllocation {
                item_id: l.item_id.clone(),
                allocated_landed_cost_micro_baht: 0,
                effective_unit_cost_micro_baht: l.base_unit_cost_micro_baht,
            })
            .collect());
    }

    struct ProvisionalShare {
        idx: usize,
        q_rec: i128,
        c_base: i128,
        floor_share: i128,
        remainder: i128,
    }

    let mut shares: Vec<ProvisionalShare> = base_values
        .into_iter()
        .map(|(idx, q_rec, c_base, v_i)| {
            let prod = total_landed_micro * v_i;
            ProvisionalShare {
                idx,
                q_rec,
                c_base,
                floor_share: prod / sum_base_value,
                remainder: prod % sum_base_value,
            }
        })
        .collect();

    let sum_floor: i128 = shares.iter().map(|s| s.floor_share).sum();
    let mut remainder_micro = total_landed_micro - sum_floor;

    let mut order: Vec<usize> = (0..shares.len()).collect();
    order.sort_by(|&a, &b| {
        shares[b]
            .remainder
            .cmp(&shares[a].remainder)
            .then_with(|| shares[a].idx.cmp(&shares[b].idx))
    });

    for idx in order {
        if remainder_micro <= 0 {
            break;
        }
        shares[idx].floor_share += 1;
        remainder_micro -= 1;
    }

    shares
        .into_iter()
        .map(|s| {
            let unit_landed = round_div_i128(s.floor_share * SCALE_MILLI, s.q_rec)?;
            let effective = i64::try_from(s.c_base + unit_landed)
                .map_err(|_| FixedPointError::OverflowI64(s.c_base + unit_landed))?;
            let allocated = i64::try_from(s.floor_share)
                .map_err(|_| FixedPointError::OverflowI64(s.floor_share))?;
            Ok(PoLineCostAllocation {
                item_id: lines[s.idx].item_id.clone(),
                allocated_landed_cost_micro_baht: allocated,
                effective_unit_cost_micro_baht: effective,
            })
        })
        .collect()
}

/// Computes new Moving Weighted Average Cost (MAC) with Negative/Zero Stock Guard (`Q_curr <= 0`).
pub fn compute_new_mac(
    current_stock_milli: MilliUnit,
    current_avg_cost_micro_baht: MicroBaht,
    received_qty_milli: MilliUnit,
    received_unit_cost_micro_baht: MicroBaht,
) -> Result<MicroBaht, FixedPointError> {
    if received_qty_milli <= 0 {
        return Err(FixedPointError::NonPositiveQuantity(received_qty_milli));
    }
    if current_stock_milli <= 0 {
        return Ok(received_unit_cost_micro_baht);
    }
    let q_curr = current_stock_milli as i128;
    let c_curr = current_avg_cost_micro_baht as i128;
    let q_rec = received_qty_milli as i128;
    let c_rec = received_unit_cost_micro_baht as i128;

    round_div_to_i64((q_curr * c_curr) + (q_rec * c_rec), q_curr + q_rec)
}

