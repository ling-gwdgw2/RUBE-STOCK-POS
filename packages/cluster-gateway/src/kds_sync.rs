//! Monotonic KDS `sequence_id` Sync & Gap Recovery (`kds_sync.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 7.2.2:
//! Recovers missed kitchen orders (`WHERE sequence_id > :last_acked_kds_seq`) after Wi-Fi drops.

#[derive(Debug, Clone, PartialEq, Eq)]
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
    let mut missed: Vec<&'a KdsOrderPacket> = all_orders
        .iter()
        .filter(|o| o.station == station && o.sequence_id > last_acked_kds_seq)
        .collect();
    missed.sort_by_key(|o| o.sequence_id);
    missed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kds_sequence_gap_recovery() {
        let orders = vec![
            KdsOrderPacket {
                sequence_id: 1,
                kitchen_order_id: "KO-1".to_string(),
                station: "BAR".to_string(),
                queue_number: "Q-001".to_string(),
            },
            KdsOrderPacket {
                sequence_id: 3,
                kitchen_order_id: "KO-3".to_string(),
                station: "BAR".to_string(),
                queue_number: "Q-003".to_string(),
            },
            KdsOrderPacket {
                sequence_id: 2,
                kitchen_order_id: "KO-2".to_string(),
                station: "BAR".to_string(),
                queue_number: "Q-002".to_string(),
            },
        ];

        let missed = filter_missed_kds_orders(&orders, "BAR", 1);
        assert_eq!(missed.len(), 2);
        assert_eq!(missed[0].sequence_id, 2);
        assert_eq!(missed[1].sequence_id, 3);
    }
}
