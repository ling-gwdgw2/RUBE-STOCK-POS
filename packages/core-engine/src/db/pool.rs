//! SQLCipher Read/Write Split Connection Pool (`pool.rs`)
//!
//! - 1 Dedicated Writer Connection serialized through an In-Memory FIFO Queue with `BEGIN IMMEDIATE TRANSACTION;`
//! - 4–8 Concurrent Reader Connections configured with `PRAGMA query_only = ON;`
//! - Raw 64-character Hex Key (`PRAGMA key = "x'...'";`) to bypass redundant PBKDF2 derivation per connection.

use rusqlite::Connection;
use std::path::Path;

/// Generates the mandatory SQLCipher & WAL initialization pragma batch (`ARCHITECTURE.md` Section 4.2.3).
pub fn build_sqlcipher_init_pragmas(raw_hex_key_64: &str, query_only: bool) -> String {
    assert_eq!(
        raw_hex_key_64.len(),
        64,
        "SQLCipher Raw Hex Key must be exactly 64 hexadecimal characters (256-bit DEK)"
    );
    let query_only_val = if query_only { "ON" } else { "OFF" };
    format!(
        "PRAGMA key = \"x'{raw_hex_key_64}'\";
         PRAGMA cipher_page_size = 4096;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA wal_autocheckpoint = 1000;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;
         PRAGMA temp_store = MEMORY;
         PRAGMA mmap_size = 268435456;
         PRAGMA query_only = {query_only_val};"
    )
}

pub fn open_configured_connection(
    db_path: &Path,
    raw_hex_key_64: &str,
    query_only: bool,
) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    let pragmas = build_sqlcipher_init_pragmas(raw_hex_key_64, query_only);
    conn.execute_batch(&pragmas)?;
    Ok(conn)
}

