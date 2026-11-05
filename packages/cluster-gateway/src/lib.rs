//! RUBE-STOCK-POS v3.1 Cluster Gateway (`rube-cluster-gateway`)
//!
//! Provides Zero-Port Standalone IPC routing and Opt-In mTLS LAN Clustering
//! with mDNS discovery, KDS `sequence_id` gap recovery, and `cluster_epoch` Split-Brain fencing.

pub mod ipc_router;
pub mod kds_sync;
pub mod mdns_discovery;
pub mod mtls_ca;
pub mod tx_replicator;

