//! External Keystore Manifest & Protected Config HMAC Service (`keyring.rs`)
//!
//! Solves the SQLCipher Bootstrap Paradox (`ARCHITECTURE.md` Section 4.4.1 & 8.1):
//! 1. Stores wrapped DEK slots in `%PROGRAMDATA%\RubePOS\keystore.manifest.json` outside the encrypted `.db` file
//!    so the system can unwrap the 256-bit DEK via Windows DPAPI (unattended morning boot) or Argon2id (owner recovery)
//!    BEFORE opening the SQLCipher database.
//! 2. Protects critical `store_config` rows (`BUSINESS_PROFILE_MODE`, `TAX_ID`, `CLUSTER_MODE`) with HMAC-SHA256
//!    keyed by the database encryption key so external SQL tampering is immediately detected.

use hmac::{Hmac, Mac};
use rube_shared_contracts::KeystoreManifest;
use sha2::Sha256;
use std::fs;
use std::io;
use std::path::Path;

type HmacSha256 = Hmac<Sha256>;

pub fn load_external_keystore_manifest(manifest_path: &Path) -> io::Result<KeystoreManifest> {
    let content = fs::read_to_string(manifest_path)?;
    let manifest: KeystoreManifest = serde_json::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(manifest)
}

pub fn save_external_keystore_manifest_atomic(
    manifest_path: &Path,
    manifest: &KeystoreManifest,
) -> io::Result<()> {
    let part_path = manifest_path.with_extension("json.part");
    let serialized = serde_json::to_string_pretty(manifest)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    {
        use std::io::Write;
        let mut file = fs::File::create(&part_path)?;
        file.write_all(serialized.as_bytes())?;
        file.sync_all()?;
    }

    fs::rename(&part_path, manifest_path)?;
    Ok(())
}

/// Computes an HMAC-SHA256 signature over `"{config_key}:{config_value}"` using the store's secret key.
pub fn compute_protected_config_hmac_hex(
    secret_key: &[u8],
    config_key: &str,
    config_value: &str,
) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret_key).expect("HMAC-SHA256 accepts keys of any size");
    mac.update(format!("{config_key}:{config_value}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Verifies an HMAC-SHA256 signature from `store_config.hmac_signature_hex`.
pub fn verify_protected_config_hmac(
    secret_key: &[u8],
    config_key: &str,
    config_value: &str,
    expected_hmac_hex: &str,
) -> bool {
    let actual = compute_protected_config_hmac_hex(secret_key, config_key, config_value);
    actual.eq_ignore_ascii_case(expected_hmac_hex.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rube_shared_contracts::{Argon2RecoverySlot, DpapiKeySlot};

    #[test]
    fn test_protected_config_hmac_detects_tampering() {
        let key = b"98483C6EB40B6C31A448C22A66DED3B5E5E8D5119CAC8327B655C8B5C4836489";
        let sig = compute_protected_config_hmac_hex(key, "BUSINESS_PROFILE_MODE", "HYBRID");
        assert!(verify_protected_config_hmac(
            key,
            "BUSINESS_PROFILE_MODE",
            "HYBRID",
            &sig
        ));
        assert!(!verify_protected_config_hmac(
            key,
            "BUSINESS_PROFILE_MODE",
            "RETAIL",
            &sig
        ));
    }

    #[test]
    fn test_keystore_manifest_atomic_roundtrip() {
        let temp_dir = std::env::temp_dir().join("rube_pos_keyring_test");
        let _ = fs::create_dir_all(&temp_dir);
        let manifest_path = temp_dir.join("keystore.manifest.json");

        let manifest = KeystoreManifest {
            schema_version: 1,
            machine_terminal_id: "POS-TERM-01".to_string(),
            dpapi_slot: DpapiKeySlot {
                wrapped_dek_dpapi_hex: "d3JhcHBlZF9kZWs=".to_string(),
                iv_hex: "00112233445566778899aabb".to_string(),
                auth_tag_hex: "00112233445566778899aabbccddeeff".to_string(),
                created_at: "2026-11-05T12:00:00Z".to_string(),
            },
            argon2_recovery_slot: Argon2RecoverySlot {
                kdf_algorithm: "ARGON2ID".to_string(),
                kdf_salt_hex: "deadbeefcafebabe0011223344556677".to_string(),
                kdf_memory_kb: 65536,
                kdf_iterations: 3,
                kdf_parallelism: 4,
                wrapped_dek_argon2_hex: "aabbccdd".to_string(),
                iv_hex: "00112233445566778899aabb".to_string(),
                auth_tag_hex: "00112233445566778899aabbccddeeff".to_string(),
                created_at: "2026-11-05T12:00:00Z".to_string(),
            },
        };

        save_external_keystore_manifest_atomic(&manifest_path, &manifest).unwrap();
        let loaded = load_external_keystore_manifest(&manifest_path).unwrap();
        assert_eq!(loaded.schema_version, 1);
        assert_eq!(loaded.machine_terminal_id, "POS-TERM-01");
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
