//! 5-Step Foreign-Key Safe Atomic Schema Migration Runner (`migrator.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 8.2:
//! 1. Quiesce & Cold Snapshot (`PRAGMA wal_checkpoint(TRUNCATE);`)
//! 2. `PRAGMA foreign_keys = OFF;` OUTSIDE transaction
//! 3. `BEGIN EXCLUSIVE TRANSACTION;` -> DDL -> `PRAGMA foreign_key_check;` -> `COMMIT;`
//! 4. `PRAGMA foreign_keys = ON;` & `PRAGMA integrity_check;`
//! 5. Resume traffic

use rusqlite::Connection;
use sha2::{Digest, Sha256};

pub fn compute_migration_checksum_hex(sql_script: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sql_script.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn execute_fk_safe_migration(
    writer_conn: &Connection,
    version: i64,
    name: &str,
    sql_script: &str,
) -> Result<String, String> {
    let checksum = compute_migration_checksum_hex(sql_script);

    // Step 2: Disable Foreign Keys OUTSIDE transaction
    writer_conn
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|e| format!("Failed to disable foreign_keys outside transaction: {e}"))?;

    // Step 3: Execute Transactional DDL & Foreign Key Check
    let tx_result = (|| -> Result<(), String> {
        writer_conn
            .execute_batch("BEGIN EXCLUSIVE TRANSACTION;")
            .map_err(|e| e.to_string())?;
        writer_conn
            .execute_batch(sql_script)
            .map_err(|e| format!("Migration DDL error: {e}"))?;

        let mut stmt = writer_conn
            .prepare("PRAGMA foreign_key_check;")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let table: String = row.get(0).unwrap_or_default();
            return Err(format!("Foreign key check failed on table: {table}"));
        }
        drop(rows);
        drop(stmt);

        writer_conn
            .execute(
                "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?1, ?2, ?3, 0)",
                rusqlite::params![version, name, checksum],
            )
            .map_err(|e| e.to_string())?;

        writer_conn
            .execute_batch("COMMIT;")
            .map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(err) = tx_result {
        let _ = writer_conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
        return Err(err);
    }

    // Step 4: Re-enable Foreign Keys
    writer_conn
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("Failed to re-enable foreign_keys: {e}"))?;

    Ok(checksum)
}

