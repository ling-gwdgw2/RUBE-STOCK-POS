//! Monotonic KDS `sequence_id` Sync & Gap Recovery (`kds_sync.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 7.2.2:
//! Recovers missed kitchen orders (`WHERE sequence_id > :last_acked_kds_seq`) after Wi-Fi drops.

#[derive(Debug, Clone)]
pub struct KdsOrderPacket {
    pub sequence_id: i64,
    pub kitchen_order_id: String,
    pub station: String,
    pub queue_number: String,
}

pub fn filter_missed_kds_orders<'a>(
    all_orders: &'a [KdsOrderPacket],
    station: &str,
    last_acked_kds_seq: i64,
) -> Vec<&'a KdsOrderPacket> {
    all_orders
        .iter()
        .filter(|o| o.station == station && o.sequence_id > last_acked_kds_seq)
        .collect()
}

