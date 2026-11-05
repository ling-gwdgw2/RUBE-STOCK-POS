//! Idempotent Checkout, Exact Void Reversal, Thai VAT ABB & Cashier Shift Ledger (`sales_shift.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 5.2.4, 5.3.2 & 9.2.4:
//! - Thai VAT 7% (`INCLUSIVE` vs `EXCLUSIVE`)
//! - Exact Void Reversal (`VOID_RETURN`) mirroring historical `inventory_transactions` rows
//! - Shift Cash Conservation Invariant (`expected_cash = opening_cash + cash_sales + paid_in - paid_out`)

use crate::domains::math_i128::{round_div_to_i64, FixedPointError, SCALE_BASIS_POINTS};
use rube_shared_contracts::{BasisPoints, MicroBaht, MilliUnit, Satang, TaxMode};

pub fn compute_vat_satang(
    net_amount_satang: Satang,
    tax_rate_bps: BasisPoints,
    tax_mode: TaxMode,
) -> Result<Satang, FixedPointError> {
    if tax_mode == TaxMode::None || tax_rate_bps <= 0 || net_amount_satang <= 0 {
        return Ok(0);
    }
    let net = net_amount_satang as i128;
    let rate = tax_rate_bps as i128;

    match tax_mode {
        TaxMode::None => Ok(0),
        TaxMode::Inclusive => round_div_to_i64(net * rate, SCALE_BASIS_POINTS + rate),
        TaxMode::Exclusive => round_div_to_i64(net * rate, SCALE_BASIS_POINTS),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalInventoryTxRow {
    pub variant_id: String,
    pub quantity_change_milli: MilliUnit,
    pub unit_cost_micro_baht: MicroBaht,
}

/// Generates exact mirror `VOID_RETURN` entries from historical ledger rows of a voided order.
pub fn build_exact_void_reversal_entries(
    original_sale_rows: &[HistoricalInventoryTxRow],
) -> Vec<HistoricalInventoryTxRow> {
    original_sale_rows
        .iter()
        .map(|row| HistoricalInventoryTxRow {
            variant_id: row.variant_id.clone(),
            quantity_change_milli: -row.quantity_change_milli,
            unit_cost_micro_baht: row.unit_cost_micro_baht,
        })
        .collect()
}

pub fn compute_expected_shift_cash_satang(
    opening_cash_satang: Satang,
    net_cash_sales_satang: Satang,
    total_paid_in_satang: Satang,
    total_paid_out_satang: Satang,
) -> Satang {
    opening_cash_satang + net_cash_sales_satang + total_paid_in_satang - total_paid_out_satang
}

