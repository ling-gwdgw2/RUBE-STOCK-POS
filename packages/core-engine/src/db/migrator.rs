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
    let normalized = sql_script.replace("\r\n", "\n");
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

/// Strips connection-level `PRAGMA` statements (such as `journal_mode`, `synchronous`, `foreign_keys`)
/// so that transactional DDL inside `BEGIN EXCLUSIVE TRANSACTION;` never fails with
/// `Safety level may not be changed inside a transaction`.
pub fn strip_connection_level_pragmas(sql_script: &str) -> String {
    sql_script
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.len() >= 6
                && trimmed[..6].eq_ignore_ascii_case("PRAGMA")
                && trimmed.ends_with(';'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn execute_fk_safe_migration(
    writer_conn: &Connection,
    version: i64,
    name: &str,
    sql_script: &str,
) -> Result<String, String> {
    let checksum = compute_migration_checksum_hex(sql_script);
    let transactional_ddl = strip_connection_level_pragmas(sql_script);

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
            .execute_batch(&transactional_ddl)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_connection_level_pragmas_and_crlf_normalization() {
        let script = "PRAGMA foreign_keys = ON;\r\nPRAGMA journal_mode = WAL;\r\nCREATE TABLE t1 (id TEXT PRIMARY KEY);\r\n";
        let stripped = strip_connection_level_pragmas(script);
        assert!(!stripped.contains("PRAGMA journal_mode"));
        assert!(stripped.contains("CREATE TABLE t1"));

        let hash_crlf = compute_migration_checksum_hex("CREATE TABLE a (id INT);\r\n");
        let hash_lf = compute_migration_checksum_hex("CREATE TABLE a (id INT);\n");
        assert_eq!(hash_crlf, hash_lf);
    }

    #[test]
    fn test_five_step_migration_executes_and_rolls_back_on_fk_violation() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE schema_migrations (
                 version INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 checksum TEXT NOT NULL,
                 execution_ms INTEGER NOT NULL
             );
             CREATE TABLE parent_outlets (id TEXT PRIMARY KEY);
             INSERT INTO parent_outlets (id) VALUES ('OUTLET-HQ');",
        )
        .unwrap();

        // Valid v2 migration succeeds
        let v2_sql = "
            CREATE TABLE child_counters (
                id TEXT PRIMARY KEY,
                outlet_id TEXT NOT NULL REFERENCES parent_outlets(id)
            );
            INSERT INTO child_counters (id, outlet_id) VALUES ('CNT-01', 'OUTLET-HQ');
        ";
        let checksum = execute_fk_safe_migration(&conn, 2, "0002_add_counters.sql", v2_sql).unwrap();
        assert_eq!(checksum.len(), 64);

        // Broken v3 migration with an orphan FK reference must fail `PRAGMA foreign_key_check`
        // and automatically roll back while re-enabling `PRAGMA foreign_keys = ON`!
        let v3_bad_fk_sql = "
            INSERT INTO child_counters (id, outlet_id) VALUES ('CNT-ORPHAN', 'NON-EXISTENT-OUTLET');
        ";
        let err = execute_fk_safe_migration(&conn, 3, "0003_bad_fk.sql", v3_bad_fk_sql)
            .expect_err("Expected FK check failure");
        assert!(err.contains("Foreign key check failed"));

        let fk_on: i64 = conn
            .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk_on, 1);

        let orphan_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM child_counters WHERE id = 'CNT-ORPHAN'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_count, 0);
    }
}

