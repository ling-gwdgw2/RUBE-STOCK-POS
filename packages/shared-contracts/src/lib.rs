//! RUBE-STOCK-POS v3.1 Shared Contracts & Fixed-Point Types (Rust Core)
//!
//! All monetary and stock quantities use 64-bit signed integers (`i64`) for storage
//! and 128-bit signed integers (`i128`) for intermediate multiplication/division.

use serde::{Deserialize, Serialize};

/// Stock & BOM recipe quantity in Milli-Units (× 10^3). E.g. 1.5 kg = 1_500.
pub type MilliUnit = i64;

/// Retail price & invoice amounts in Satang (× 10^2). E.g. 65.00 THB = 6_500.
pub type Satang = i64;

/// Unit cost & Moving Average Cost (MAC) in Micro-Baht (× 10^6). E.g. 0.0125 THB = 12_500.
pub type MicroBaht = i64;

/// Tax rates, discounts & wastage in Basis Points (× 10^4). E.g. 7.00% = 700.
pub type BasisPoints = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BusinessProfile {
    Retail,
    Hospitality,
    Hybrid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaxMode {
    None,
    Inclusive,
    Exclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ComponentRole {
    Standard,
    Sweetener,
    MilkBase,
    CoffeeShot,
    TeaBase,
    Topping,
    Packaging,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModifierMode {
    FixedQtyDelta,
    RoleScaleBps,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeystoreManifest {
    pub schema_version: u32,
    pub machine_terminal_id: String,
    pub dpapi_slot: DpapiKeySlot,
    pub argon2_recovery_slot: Argon2RecoverySlot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DpapiKeySlot {
    pub wrapped_dek_dpapi_hex: String,
    pub iv_hex: String,
    pub auth_tag_hex: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Argon2RecoverySlot {
    pub kdf_algorithm: String,
    pub kdf_salt_hex: String,
    pub kdf_memory_kb: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
    pub wrapped_dek_argon2_hex: String,
    pub iv_hex: String,
    pub auth_tag_hex: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shared_contracts_serde_screaming_snake_case_parity() {
        assert_eq!(
            serde_json::to_string(&BusinessProfile::Retail).unwrap(),
            "\"RETAIL\""
        );
        assert_eq!(
            serde_json::to_string(&BusinessProfile::Hospitality).unwrap(),
            "\"HOSPITALITY\""
        );
        assert_eq!(
            serde_json::to_string(&BusinessProfile::Hybrid).unwrap(),
            "\"HYBRID\""
        );
        assert_eq!(
            serde_json::to_string(&TaxMode::Inclusive).unwrap(),
            "\"INCLUSIVE\""
        );
        assert_eq!(
            serde_json::to_string(&ComponentRole::Sweetener).unwrap(),
            "\"SWEETENER\""
        );
        assert_eq!(
            serde_json::to_string(&ModifierMode::RoleScaleBps).unwrap(),
            "\"ROLE_SCALE_BPS\""
        );
    }
}


