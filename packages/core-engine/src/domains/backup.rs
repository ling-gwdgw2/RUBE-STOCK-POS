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

/// Compares two backup file names using natural numeric token ordering so that
/// unpadded shift identifiers (e.g. `shift2` vs `shift10` or `20261105-S2` vs `20261105-S10`)
/// sort chronologically instead of evicting `shift10` before `shift2`.
pub fn compare_backup_filenames_natural(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a_chars = a.chars().peekable();
    let mut b_chars = b.chars().peekable();

    while let (Some(&ac), Some(&bc)) = (a_chars.peek(), b_chars.peek()) {
        if ac.is_ascii_digit() && bc.is_ascii_digit() {
            let mut a_num = String::new();
            while let Some(&c) = a_chars.peek() {
                if c.is_ascii_digit() {
                    a_num.push(c);
                    a_chars.next();
                } else {
                    break;
                }
            }
            let mut b_num = String::new();
            while let Some(&c) = b_chars.peek() {
                if c.is_ascii_digit() {
                    b_num.push(c);
                    b_chars.next();
                } else {
                    break;
                }
            }
            let a_val = a_num.parse::<u128>().unwrap_or(0);
            let b_val = b_num.parse::<u128>().unwrap_or(0);
            match a_val.cmp(&b_val) {
                std::cmp::Ordering::Equal => continue,
                non_eq => return non_eq,
            }
        } else {
            a_chars.next();
            b_chars.next();
            match ac.cmp(&bc) {
                std::cmp::Ordering::Equal => continue,
                non_eq => return non_eq,
            }
        }
    }
    a_chars.count().cmp(&b_chars.count())
}

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

    // Enforce 14-Shift Rotating Ring Buffer with natural numeric filename sorting
    let mut completed_backups: Vec<PathBuf> = fs::read_dir(usb_backup_dir)?
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.starts_with("rube_backup_") && s.ends_with(".db.enc"))
                .unwrap_or(false)
        })
        .collect();

    completed_backups.sort_by(|a, b| {
        let a_name = a.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let b_name = b.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        compare_backup_filenames_natural(a_name, b_name)
    });

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_natural_backup_filename_sorting() {
        let mut names = vec![
            "rube_backup_20261105-S10.db.enc",
            "rube_backup_20261105-S2.db.enc",
            "rube_backup_20261105-S1.db.enc",
        ];
        names.sort_by(|a, b| compare_backup_filenames_natural(a, b));
        assert_eq!(
            names,
            vec![
                "rube_backup_20261105-S1.db.enc",
                "rube_backup_20261105-S2.db.enc",
                "rube_backup_20261105-S10.db.enc",
            ]
        );
    }
}

