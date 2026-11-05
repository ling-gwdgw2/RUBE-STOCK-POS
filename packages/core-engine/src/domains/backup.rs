//! Atomic USB Flash Drive Backup with `.part` + `fsync` & 14-Shift Ring Buffer (`backup.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 8.3:
//! 1. Write encrypted snapshot to `rube_backup_YYYYMMDD_shiftN.db.enc.part`
//! 2. Call `File::sync_all()` (`FlushFileBuffers` on Windows)
//! 3. Atomic rename `.db.enc.part` -> `.db.enc`
//! 4. Rotate 14-shift ring buffer (evicting only files older than the 14 most recent completed backups)

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_RING_BUFFER_SHIFTS: usize = 14;

pub fn write_atomic_usb_backup(
    usb_backup_dir: &Path,
    final_filename: &str,
    encrypted_payload: &[u8],
) -> io::Result<(PathBuf, Option<PathBuf>)> {
    fs::create_dir_all(usb_backup_dir)?;

    let final_path = usb_backup_dir.join(final_filename);
    let part_path = usb_backup_dir.join(format!("{final_filename}.part"));

    {
        let mut file = fs::File::create(&part_path)?;
        file.write_all(encrypted_payload)?;
        file.sync_all()?; // OS FlushFileBuffers / fsync
    }

    fs::rename(&part_path, &final_path)?;

    // Enforce 14-Shift Rotating Ring Buffer
    let mut completed_backups: Vec<PathBuf> = fs::read_dir(usb_backup_dir)?
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.starts_with("rube_backup_") && s.ends_with(".db.enc"))
                .unwrap_or(false)
        })
        .collect();

    completed_backups.sort();

    let mut evicted_oldest: Option<PathBuf> = None;
    if completed_backups.len() > MAX_RING_BUFFER_SHIFTS {
        let to_remove = completed_backups.len() - MAX_RING_BUFFER_SHIFTS;
        for old_path in completed_backups.into_iter().take(to_remove) {
            let _ = fs::remove_file(&old_path);
            evicted_oldest = Some(old_path);
        }
    }

    Ok((final_path, evicted_oldest))
}

