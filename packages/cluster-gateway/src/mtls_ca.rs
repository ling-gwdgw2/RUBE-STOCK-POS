//! Internal Root CA & 6-Digit PIN mTLS Pairing (`mtls_ca.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 7.1.2:
//! Issues terminal-specific Client Certificates pinned by SHA-256 fingerprint in `pos_terminals`.

pub const PAIRING_PIN_DIGITS: usize = 6;

pub fn validate_pairing_pin_format(pin: &str) -> bool {
    pin.len() == PAIRING_PIN_DIGITS && pin.chars().all(|c| c.is_ascii_digit())
}

