//! Idempotent Checkout, Exact Void Reversal, Thai VAT ABB & Cashier Shift Ledger (`sales_shift.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 5.2.4, 5.3.2 & 9.2.4:
//! - Thai VAT 7% (`INCLUSIVE` vs `EXCLUSIVE`) and Simplified Tax Invoice (`ABB`) numbering
//! - Exact Void Reversal (`VOID_RETURN`) mirroring historical `inventory_transactions` rows
//! - Shift Cash Conservation Invariant (`expected_cash = opening + cash_sales - cash_voids + paid_in - paid_out - cash_drop`)

use crate::domains::math_i128::{round_div_to_i64, FixedPointError, SCALE_BASIS_POINTS};
use rube_shared_contracts::{BasisPoints, MicroBaht, MilliUnit, Satang, TaxMode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutFinancialBreakdown {
    pub subtotal_satang: Satang,
    pub discount_satang: Satang,
    pub net_before_tax_satang: Satang,
    pub tax_satang: Satang,
    pub total_satang: Satang,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftBlindDropReconciliation {
    pub expected_cash_satang: Satang,
    pub counted_cash_satang: Satang,
    pub cash_variance_satang: Satang,
}

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

/// Computes full bill totals for Thai VAT (`INCLUSIVE`, `EXCLUSIVE`, `NONE`).
pub fn compute_checkout_order_totals(
    subtotal_satang: Satang,
    discount_satang: Satang,
    tax_rate_bps: BasisPoints,
    tax_mode: TaxMode,
) -> Result<CheckoutFinancialBreakdown, FixedPointError> {
    if subtotal_satang < 0 {
        return Err(FixedPointError::NegativeCostOrAmount(subtotal_satang));
    }
    if discount_satang < 0 {
        return Err(FixedPointError::NegativeCostOrAmount(discount_satang));
    }
    let after_discount = (subtotal_satang - discount_satang).max(0);
    let tax_satang = compute_vat_satang(after_discount, tax_rate_bps, tax_mode)?;

    let (net_before_tax_satang, total_satang) = match tax_mode {
        TaxMode::None => (after_discount, after_discount),
        TaxMode::Inclusive => (after_discount - tax_satang, after_discount),
        TaxMode::Exclusive => (after_discount, after_discount + tax_satang),
    };

    Ok(CheckoutFinancialBreakdown {
        subtotal_satang,
        discount_satang,
        net_before_tax_satang,
        tax_satang,
        total_satang,
    })
}

/// Formats sequential Thai Revenue Department Simplified Tax Invoice (ABB) number.
pub fn format_abb_tax_invoice_number(date_yyyymmdd: &str, sequence_no: u64) -> String {
    format!("ABB-{}-{:06}", date_yyyymmdd, sequence_no)
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

/// Reconciles a Cashier Shift Blind Drop against the Cash Conservation Equation.
pub fn reconcile_shift_blind_drop(
    opening_cash_satang: Satang,
    gross_cash_sales_satang: Satang,
    voided_cash_sales_satang: Satang,
    paid_in_satang: Satang,
    paid_out_satang: Satang,
    cash_drop_satang: Satang,
    counted_cash_satang: Satang,
) -> ShiftBlindDropReconciliation {
    let net_cash_sales = gross_cash_sales_satang - voided_cash_sales_satang;
    let total_outflows = paid_out_satang + cash_drop_satang;
    let expected_cash_satang = compute_expected_shift_cash_satang(
        opening_cash_satang,
        net_cash_sales,
        paid_in_satang,
        total_outflows,
    );
    let cash_variance_satang = counted_cash_satang - expected_cash_satang;

    ShiftBlindDropReconciliation {
        expected_cash_satang,
        counted_cash_satang,
        cash_variance_satang,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checkout_totals_inclusive_vs_exclusive_vat() {
        // 107.00 THB (10,700 Satang) Inclusive of 7% VAT -> Net = 10,000, VAT = 700, Total = 10,700
        let inc = compute_checkout_order_totals(10_700, 0, 700, TaxMode::Inclusive).unwrap();
        assert_eq!(inc.net_before_tax_satang, 10_000);
        assert_eq!(inc.tax_satang, 700);
        assert_eq!(inc.total_satang, 10_700);

        // 100.00 THB (10,000 Satang) Exclusive of 7% VAT -> Net = 10,000, VAT = 700, Total = 10,700
        let exc = compute_checkout_order_totals(10_000, 0, 700, TaxMode::Exclusive).unwrap();
        assert_eq!(exc.net_before_tax_satang, 10_000);
        assert_eq!(exc.tax_satang, 700);
        assert_eq!(exc.total_satang, 10_700);
    }

    #[test]
    fn test_shift_blind_drop_and_void_mirror() {
        let rec = reconcile_shift_blind_drop(
            200_000, // Opening: 2,000.00 THB
            150_000, // Cash sales: 1,500.00 THB
            20_000,  // Voided cash sale: 200.00 THB
            10_000,  // Paid-in: 100.00 THB
            5_000,   // Paid-out (ice): 50.00 THB
            100_000, // Cash drop to safe: 1,000.00 THB
            234_500, // Counted: 2,345.00 THB (short by 5.00 THB = -500 Satang)
        );
        assert_eq!(rec.expected_cash_satang, 235_000);
        assert_eq!(rec.cash_variance_satang, -500);

        let orig = vec![HistoricalInventoryTxRow {
            variant_id: "VAR-RAW-TEA".to_string(),
            quantity_change_milli: -18_360,
            unit_cost_micro_baht: 450_000,
        }];
        let mirror = build_exact_void_reversal_entries(&orig);
        assert_eq!(mirror[0].quantity_change_milli, 18_360);
        assert_eq!(mirror[0].unit_cost_micro_baht, 450_000);
    }
}
