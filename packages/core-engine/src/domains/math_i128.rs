//! 128-bit Intermediate Integer Arithmetic Engine (`math_i128.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 4.1 & 5:
//! All intermediate multiplications and divisions use `i128` before downcasting to `i64`
//! to prevent integer overflow on large purchase orders and micro-baht costing.

use thiserror::Error;

pub const SCALE_MILLI: i128 = 1_000;
pub const SCALE_SATANG: i128 = 100;
pub const SCALE_MICRO_BAHT: i128 = 1_000_000;
pub const SCALE_BASIS_POINTS: i128 = 10_000;
pub const SATANG_TO_MICRO_BAHT: i128 = 10_000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FixedPointError {
    #[error("Division by zero in fixed-point arithmetic")]
    DivisionByZero,
    #[error("Fixed-point result {0} overflows 64-bit signed integer (i64)")]
    OverflowI64(i128),
    #[error("Invalid non-positive quantity: {0}")]
    NonPositiveQuantity(i64),
}

/// Computes `round_div(numerator, denominator)` using Round-Half-Away-From-Zero on absolute magnitude in `i128`.
///
/// Formula: `sgn(a * b) * floor((|a| + floor(|b| / 2)) / |b|)`
#[inline]
pub fn round_div_i128(numerator: i128, denominator: i128) -> Result<i128, FixedPointError> {
    if denominator == 0 {
        return Err(FixedPointError::DivisionByZero);
    }
    let is_negative = (numerator < 0) ^ (denominator < 0);
    let abs_num = numerator.unsigned_abs();
    let abs_den = denominator.unsigned_abs();
    let half_den = abs_den / 2;
    let quotient = (abs_num + half_den) / abs_den;
    let signed = quotient as i128;
    Ok(if is_negative { -signed } else { signed })
}

/// Computes `round_div` in `i128` and safely downcasts the result back to `i64`.
#[inline]
pub fn round_div_to_i64(numerator: i128, denominator: i128) -> Result<i64, FixedPointError> {
    let val = round_div_i128(numerator, denominator)?;
    i64::try_from(val).map_err(|_| FixedPointError::OverflowI64(val))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_symmetric_rounding_positive_and_negative() {
        assert_eq!(round_div_to_i64(5, 2).unwrap(), 3);
        assert_eq!(round_div_to_i64(-5, 2).unwrap(), -3);
        assert_eq!(round_div_to_i64(4, 2).unwrap(), 2);
        assert_eq!(round_div_to_i64(-4, 2).unwrap(), -2);
    }

    #[test]
    fn test_prevents_i64_intermediate_overflow() {
        // 10,000 units (10_000_000 milli) * 50,000 THB (50_000_000_000 micro-baht)
        // Product = 5 * 10^17, multiplied by 10,000 bps = 5 * 10^21 (overflows i64::MAX = 9.22 * 10^18)
        let qty_milli: i128 = 10_000_000;
        let unit_cost_micro: i128 = 50_000_000_000;
        let bps: i128 = 10_700;
        let res = round_div_to_i64(
            qty_milli * unit_cost_micro * bps,
            SCALE_MILLI * SCALE_BASIS_POINTS,
        )
        .unwrap();
        assert_eq!(res, 535_000_000_000_000);
    }
}

