//! External Keystore Manifest Service (`keyring.rs`)
//!
//! Solves the SQLCipher Bootstrap Paradox (`ARCHITECTURE.md` Section 4.4.1 & 8.1):
//! Stores wrapped DEK slots in `%PROGRAMDATA%\RubePOS\keystore.manifest.json` outside the encrypted `.db` file
//! so the system can unwrap the 256-bit DEK via Windows DPAPI (unattended morning boot) or Argon2id (owner recovery)
//! BEFORE opening the SQLCipher database.

use rube_shared_contracts::KeystoreManifest;
use std::fs;
use std::io;
use std::path::Path;

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

