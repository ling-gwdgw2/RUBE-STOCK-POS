//! ZeroConf / mDNS Service Discovery (`mdns_discovery.rs`)
//!
//! Broadcasts and resolves `_rube-pos._tcp.local.` with TXT records containing `cluster_epoch`
//! and `outlet_id` so followers reconnect automatically across router DHCP IP changes.

pub const MDNS_SERVICE_TYPE: &str = "_rube-pos._tcp.local.";

pub fn format_mdns_txt_record(outlet_id: &str, terminal_id: &str, cluster_epoch: u64) -> Vec<String> {
    vec![
        format!("version=3.1.0"),
        format!("outlet_id={outlet_id}"),
        format!("leader_id={terminal_id}"),
        format!("epoch={cluster_epoch}"),
    ]
}

