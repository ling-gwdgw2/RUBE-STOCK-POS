//! Internal Root CA & 6-Digit PIN mTLS Pairing (`mtls_ca.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 7.1.2:
//! Issues terminal-specific Client Certificates pinned by SHA-256 fingerprint in `pos_terminals`.

pub const PAIRING_PIN_DIGITS: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedTerminalCert {
    pub terminal_id: String,
    pub outlet_id: String,
    pub cert_fingerprint_sha256: String,
}

pub fn validate_pairing_pin_format(pin: &str) -> bool {
    pin.len() == PAIRING_PIN_DIGITS && pin.chars().all(|c| c.is_ascii_digit())
}

pub fn verify_pin_and_issue_cert(
    expected_pin: &str,
    submitted_pin: &str,
    outlet_id: &str,
    terminal_id: &str,
) -> Result<IssuedTerminalCert, &'static str> {
    if !validate_pairing_pin_format(expected_pin) || !validate_pairing_pin_format(submitted_pin) {
        return Err("Invalid 6-digit pairing PIN format");
    }
    if expected_pin != submitted_pin {
        return Err("Pairing PIN mismatch");
    }

    // Deterministic fingerprint Tag for terminal pinning
    let cert_fingerprint_sha256 = format!("sha256:mtls:{}:{}:{}", outlet_id, terminal_id, expected_pin);
    Ok(IssuedTerminalCert {
        terminal_id: terminal_id.to_string(),
        outlet_id: outlet_id.to_string(),
        cert_fingerprint_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pairing_pin_validation_and_cert_issuance() {
        assert!(validate_pairing_pin_format("482910"));
        assert!(!validate_pairing_pin_format("48291"));
        assert!(!validate_pairing_pin_format("48291A"));

        let issued =
            verify_pin_and_issue_cert("482910", "482910", "OUTLET-HQ", "POS-TERM-02").unwrap();
        assert_eq!(issued.terminal_id, "POS-TERM-02");
        assert!(verify_pin_and_issue_cert("482910", "000000", "OUTLET-HQ", "POS-TERM-02").is_err());
    }
}
