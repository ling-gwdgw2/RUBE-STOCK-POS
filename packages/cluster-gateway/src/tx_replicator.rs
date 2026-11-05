//! Logical Transaction Stream Replicator & Epoch-Fenced Failover (`tx_replicator.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 7.3:
//! - Streams deterministic logical transactions (`global_tx_seq`) instead of raw WAL frames
//!   so `PRAGMA wal_checkpoint(TRUNCATE);` never corrupts the Warm-Standby replica.
//! - Uses `cluster_epoch` fencing tokens to quarantine stale Leaders and prevent Split-Brain.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeRoleState {
    ActiveLeader,
    WarmStandbyFollower,
    /// Automatic state when a former Leader detects a peer with a higher `cluster_epoch`
    ReadOnlyQuarantine,
}

#[derive(Debug, Clone)]
pub struct ClusterEpochGuard {
    pub terminal_id: String,
    pub current_epoch: u64,
    pub role_state: NodeRoleState,
    pub last_replicated_tx_seq: u64,
}

impl ClusterEpochGuard {
    pub fn new_leader(terminal_id: String, epoch: u64) -> Self {
        Self {
            terminal_id,
            current_epoch: epoch,
            role_state: NodeRoleState::ActiveLeader,
            last_replicated_tx_seq: 0,
        }
    }

    /// Promotes a Warm Standby node to Active Leader and increments `cluster_epoch + 1`.
    pub fn promote_standby_to_leader(&mut self) -> u64 {
        self.current_epoch += 1;
        self.role_state = NodeRoleState::ActiveLeader;
        self.current_epoch
    }

    /// Evaluates an incoming heartbeat or mDNS advertisement from another node.
    /// If a higher `cluster_epoch` is observed while this node is `ActiveLeader`,
    /// this node immediately transitions to `ReadOnlyQuarantine` to prevent Split-Brain!
    pub fn observe_peer_epoch(&mut self, peer_epoch: u64) -> NodeRoleState {
        if peer_epoch > self.current_epoch {
            self.current_epoch = peer_epoch;
            if self.role_state == NodeRoleState::ActiveLeader {
                self.role_state = NodeRoleState::ReadOnlyQuarantine;
            }
        }
        self.role_state
    }
}

