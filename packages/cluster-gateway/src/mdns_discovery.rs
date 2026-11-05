//! ZeroConf / mDNS Service Discovery (`mdns_discovery.rs`)
//!
//! Broadcasts and resolves `_rube-pos._tcp.local.` with TXT records containing `cluster_epoch`
//! and `outlet_id` so followers reconnect automatically across router DHCP IP changes.

pub const MDNS_SERVICE_TYPE: &str = "_rube-pos._tcp.local.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsLeaderAdvertisement {
    pub version: String,
    pub outlet_id: String,
    pub leader_id: String,
    pub cluster_epoch: u64,
    pub ip_address: String,
    pub port: u16,
}

pub fn format_mdns_txt_record(
    outlet_id: &str,
    terminal_id: &str,
    cluster_epoch: u64,
) -> Vec<String> {
    vec![
        "version=3.1.0".to_string(),
        format!("outlet_id={outlet_id}"),
        format!("leader_id={terminal_id}"),
        format!("epoch={cluster_epoch}"),
    ]
}

pub fn parse_mdns_txt_record(
    txt_entries: &[String],
    ip_address: &str,
    port: u16,
) -> Option<MdnsLeaderAdvertisement> {
    let mut version = None;
    let mut outlet_id = None;
    let mut leader_id = None;
    let mut cluster_epoch = None;

    for entry in txt_entries {
        if let Some((k, v)) = entry.split_once('=') {
            match k.trim() {
                "version" => version = Some(v.trim().to_string()),
                "outlet_id" => outlet_id = Some(v.trim().to_string()),
                "leader_id" => leader_id = Some(v.trim().to_string()),
                "epoch" => cluster_epoch = v.trim().parse::<u64>().ok(),
                _ => {}
            }
        }
    }

    Some(MdnsLeaderAdvertisement {
        version: version?,
        outlet_id: outlet_id?,
        leader_id: leader_id?,
        cluster_epoch: cluster_epoch?,
        ip_address: ip_address.to_string(),
        port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mdns_txt_roundtrip_across_dhcp_ip_change() {
        let txt = format_mdns_txt_record("OUTLET-HQ", "POS-TERM-01", 4);
        let parsed = parse_mdns_txt_record(&txt, "192.168.1.250", 3001).unwrap();
        assert_eq!(parsed.outlet_id, "OUTLET-HQ");
        assert_eq!(parsed.leader_id, "POS-TERM-01");
        assert_eq!(parsed.cluster_epoch, 4);
        assert_eq!(parsed.ip_address, "192.168.1.250");
    }
}
