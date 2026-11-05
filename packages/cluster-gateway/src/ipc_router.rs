//! Zero-Port Native IPC Router (`ipc_router.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 3.1.2:
//! In Standalone Mode, zero TCP ports are bound on loopback or network interfaces.
//! All commands flow strictly over Tauri's native IPC channel.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkOperatingMode {
    /// 100% IPC-Only Isolation (Default for single-terminal stores; zero open TCP ports)
    StandaloneIpcOnly,
    /// Opt-In Multi-Terminal LAN Cluster (mTLS + mDNS on port 3001)
    MultiTerminalLanCluster,
}

pub const fn should_bind_tcp_listener(mode: NetworkOperatingMode) -> bool {
    matches!(mode, NetworkOperatingMode::MultiTerminalLanCluster)
}

