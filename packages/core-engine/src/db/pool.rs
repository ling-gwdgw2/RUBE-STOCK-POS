//! SQLCipher Read/Write Split Connection Pool (`pool.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 4.2:
//! - 1 Dedicated Writer Connection serialized through an In-Memory FIFO Queue with `BEGIN IMMEDIATE TRANSACTION;`
//! - 4–8 Concurrent Reader Connections configured with `PRAGMA query_only = ON;`
//! - Raw 64-character Hex Key (`PRAGMA key = "x'...'";`) to bypass redundant PBKDF2 derivation per connection.

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Generates the mandatory SQLCipher & WAL initialization pragma batch (`ARCHITECTURE.md` Section 4.2.3).
pub fn build_sqlcipher_init_pragmas(raw_hex_key_64: &str, query_only: bool) -> String {
    assert_eq!(
        raw_hex_key_64.len(),
        64,
        "SQLCipher Raw Hex Key must be exactly 64 hexadecimal characters (256-bit DEK)"
    );
    assert!(
        raw_hex_key_64.chars().all(|c| c.is_ascii_hexdigit()),
        "SQLCipher Raw Hex Key must contain only hexadecimal characters"
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

/// Production SQLite Read/Write Split Pool with Single-Writer FIFO Serialization (`BEGIN IMMEDIATE`)
/// and Round-Robin Concurrent Reader Connections (`query_only = ON`).
pub struct SqliteReadWriteSplitPool {
    db_path: PathBuf,
    writer_conn: Arc<Mutex<Connection>>,
    reader_conns: Vec<Arc<Mutex<Connection>>>,
    next_reader_idx: Mutex<usize>,
}

impl SqliteReadWriteSplitPool {
    pub fn new(
        db_path: impl Into<PathBuf>,
        raw_hex_key_64: &str,
        reader_count: usize,
    ) -> rusqlite::Result<Self> {
        let path = db_path.into();
        let reader_pool_size = reader_count.clamp(4, 8);
        let writer = open_configured_connection(&path, raw_hex_key_64, false)?;

        let mut readers = Vec::with_capacity(reader_pool_size);
        for _ in 0..reader_pool_size {
            let reader = open_configured_connection(&path, raw_hex_key_64, true)?;
            readers.push(Arc::new(Mutex::new(reader)));
        }

        Ok(Self {
            db_path: path,
            writer_conn: Arc::new(Mutex::new(writer)),
            reader_conns: readers,
            next_reader_idx: Mutex::new(0),
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn reader_pool_size(&self) -> usize {
        self.reader_conns.len()
    }

    /// Executes a mutating transaction on the single serialized Writer Connection
    /// using `BEGIN IMMEDIATE TRANSACTION;` to eliminate `SQLITE_BUSY` deadlocks.
    pub fn execute_write_immediate<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let guard = self
            .writer_conn
            .lock()
            .map_err(|_| "Writer connection mutex poisoned".to_string())?;

        guard
            .execute_batch("BEGIN IMMEDIATE TRANSACTION;")
            .map_err(|e| format!("Failed to BEGIN IMMEDIATE TRANSACTION: {e}"))?;

        match f(&guard) {
            Ok(result) => {
                guard
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("Failed to COMMIT transaction: {e}"))?;
                Ok(result)
            }
            Err(err) => {
                let _ = guard.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    }

    /// Executes a read-only query on one of the `query_only = ON` Reader Connections.
    pub fn execute_read<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let idx = {
            let mut counter = self
                .next_reader_idx
                .lock()
                .map_err(|_| "Reader index mutex poisoned".to_string())?;
            let current = *counter % self.reader_conns.len();
            *counter = counter.wrapping_add(1);
            current
        };

        let reader_guard = self.reader_conns[idx]
            .lock()
            .map_err(|_| "Reader connection mutex poisoned".to_string())?;
        f(&reader_guard)
    }
}
