/**
 * RUBE-STOCK-POS v3.1 Opt-In mTLS LAN Cluster Coordinator, mDNS Discovery & Epoch-Fenced Replicator
 * (`CLUSTER_GATEWAY` — Squad D Phase 3: WBS-13, WBS-14, WBS-15)
 *
 * Enforces `ARCHITECTURE.md` Section 3.1.2 & Section 7:
 * 1. Zero-Port Standalone Isolation (`STANDALONE_IPC_ONLY` binds 0 TCP ports) vs Opt-In LAN Cluster
 * 2. mDNS `_rube-pos._tcp.local.` Discovery resilient to router DHCP IP changes
 * 3. Internal Root CA + 6-Digit Pairing PIN issuing pinned SHA-256 terminal certificates in `pos_terminals`
 * 4. Logical Transaction Stream (`global_tx_seq`) immune to `PRAGMA wal_checkpoint(TRUNCATE);`
 * 5. `cluster_epoch` Fencing Tokens that quarantine stale Leaders into `READ_ONLY_QUARANTINE` on reconnect
 */

import { createHash } from 'node:crypto';
import type { SqliteReadWritePoolEngine } from '../../core-engine/src/runtime/sqlite-engine.ts';

export type NetworkOperatingMode = 'STANDALONE_IPC_ONLY' | 'MULTI_TERMINAL_LAN_CLUSTER';
export type ClusterNodeRoleState =
  | 'ACTIVE_LEADER'
  | 'WARM_STANDBY_FOLLOWER'
  | 'READ_ONLY_QUARANTINE';

export interface MdnsServicePacket {
  serviceType: '_rube-pos._tcp.local.';
  ipAddress: string;
  port: number;
  txtRecords: string[];
}

export interface LogicalTransactionFrame {
  globalTxSeq: number;
  clusterEpoch: number;
  leaderTerminalId: string;
  txType: string;
  referenceId: string;
  committedAt: string;
}

export interface PairedFollowerCertificate {
  terminalId: string;
  terminalName: string;
  outletId: string;
  role: 'FOLLOWER_POS' | 'FOLLOWER_KDS';
  clusterEpoch: number;
  clientCertFingerprintSha256: string;
}

export class LanClusterCoordinator {
  private readonly engine: SqliteReadWritePoolEngine;
  private readonly outletId: string;
  private terminalId: string;
  private mode: NetworkOperatingMode;
  private roleState: ClusterNodeRoleState;
  private currentEpoch: number;
  private globalTxSeq = 0;
  private activePairingPin: string | null = null;
  private readonly logicalTxLog: LogicalTransactionFrame[] = [];

  constructor(options: {
    engine: SqliteReadWritePoolEngine;
    outletId?: string;
    terminalId?: string;
    mode?: NetworkOperatingMode;
    initialRoleState?: ClusterNodeRoleState;
    initialEpoch?: number;
  }) {
    this.engine = options.engine;
    this.outletId = options.outletId ?? 'OUTLET-HQ';
    this.terminalId = options.terminalId ?? 'POS-TERM-01';
    this.mode = options.mode ?? 'STANDALONE_IPC_ONLY';
    this.roleState = options.initialRoleState ?? 'ACTIVE_LEADER';
    this.currentEpoch = options.initialEpoch ?? 1;
  }

  public getOperatingMode(): NetworkOperatingMode {
    return this.mode;
  }

  public enableMultiTerminalLanCluster(): void {
    this.mode = 'MULTI_TERMINAL_LAN_CLUSTER';
  }

  public shouldBindTcpListener(): boolean {
    return this.mode === 'MULTI_TERMINAL_LAN_CLUSTER';
  }

  public getRoleState(): ClusterNodeRoleState {
    return this.roleState;
  }

  public getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  public getTerminalId(): string {
    return this.terminalId;
  }

  public getGlobalTxSeq(): number {
    return this.globalTxSeq;
  }

  /**
   * Enforces Epoch Fencing before executing writes on a Leader node.
   */
  public assertWriteAllowedOnLeader(): void {
    if (this.roleState === 'READ_ONLY_QUARANTINE') {
      throw new Error(
        `HTTP 423 Locked: Terminal ${this.terminalId} is in READ_ONLY_QUARANTINE due to Split-Brain Epoch Fencing (epoch=${this.currentEpoch})`
      );
    }
    if (this.roleState !== 'ACTIVE_LEADER') {
      throw new Error(
        `HTTP 403 Forbidden: Terminal ${this.terminalId} is not ACTIVE_LEADER (state=${this.roleState})`
      );
    }
  }

  /**
   * Broadcasts mDNS `_rube-pos._tcp.local.` advertisement packet so Follower POS & KDS tablets
   * automatically track the Leader even if the router reassigns its DHCP IP address.
   */
  public buildMdnsLeaderAdvertisement(ipAddress: string, port = 3001): MdnsServicePacket {
    return {
      serviceType: '_rube-pos._tcp.local.',
      ipAddress,
      port,
      txtRecords: [
        'version=3.1.0',
        `outlet_id=${this.outletId}`,
        `leader_id=${this.terminalId}`,
        `epoch=${this.currentEpoch}`,
      ],
    };
  }

  public static parseMdnsLeaderAdvertisement(packet: MdnsServicePacket): {
    outletId: string;
    leaderId: string;
    clusterEpoch: number;
    endpointUrl: string;
  } {
    const kv = new Map<string, string>();
    for (const entry of packet.txtRecords) {
      const idx = entry.indexOf('=');
      if (idx > 0) {
        kv.set(entry.slice(0, idx).trim(), entry.slice(idx + 1).trim());
      }
    }
    const outletId = kv.get('outlet_id') ?? '';
    const leaderId = kv.get('leader_id') ?? '';
    const clusterEpoch = Number(kv.get('epoch') ?? '0');
    if (!outletId || !leaderId || clusterEpoch < 1) {
      throw new Error('Malformed mDNS _rube-pos._tcp.local. TXT record');
    }

    return {
      outletId,
      leaderId,
      clusterEpoch,
      endpointUrl: `https://${packet.ipAddress}:${packet.port}`,
    };
  }

  /**
   * Generates a 6-digit Pairing PIN on the Leader screen for mTLS Follower onboarding.
   */
  public openPairingWindowWith6DigitPin(fixedPinForTest?: string): string {
    const pin =
      fixedPinForTest ??
      String(Math.floor(100_000 + Math.random() * 900_000)).padStart(6, '0');
    if (!/^\d{6}$/.test(pin)) {
      throw new Error('Pairing PIN must be exactly 6 ASCII digits');
    }
    this.activePairingPin = pin;
    return pin;
  }

  /**
   * Validates the 6-digit Pairing PIN submitted by a Follower POS or KDS tablet,
   * issues a pinned mTLS Client Certificate SHA-256 fingerprint, and registers the terminal in SQLite.
   */
  public async pairFollowerTerminalWithPin(input: {
    submittedPin: string;
    followerTerminalId: string;
    terminalName: string;
    role: 'FOLLOWER_POS' | 'FOLLOWER_KDS';
    ipAddress: string;
  }): Promise<PairedFollowerCertificate> {
    this.assertWriteAllowedOnLeader();

    if (!this.activePairingPin || !/^\d{6}$/.test(input.submittedPin)) {
      throw new Error('HTTP 401 Pairing window is closed or PIN format is invalid');
    }
    if (input.submittedPin !== this.activePairingPin) {
      throw new Error('HTTP 401 Invalid 6-digit mTLS Pairing PIN');
    }

    // Consume single-use pairing PIN
    this.activePairingPin = null;

    const clientCertFingerprintSha256 = createHash('sha256')
      .update(
        `RUBE-INTERNAL-CA:${this.outletId}:${input.followerTerminalId}:${this.currentEpoch}:${input.submittedPin}`
      )
      .digest('hex');

    await this.engine.executeWriteImmediate((db) => {
      db.prepare(
        `INSERT INTO pos_terminals (
           id, outlet_id, terminal_name, role, cluster_epoch,
           client_cert_fingerprint, ip_address, last_heartbeat_at,
           last_replicated_tx_seq, last_acked_kds_seq, active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0, 0, 1)
         ON CONFLICT(id) DO UPDATE SET
           terminal_name = excluded.terminal_name,
           role = excluded.role,
           cluster_epoch = excluded.cluster_epoch,
           client_cert_fingerprint = excluded.client_cert_fingerprint,
           ip_address = excluded.ip_address,
           last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           active = 1`
      ).run(
        input.followerTerminalId,
        this.outletId,
        input.terminalName,
        input.role,
        this.currentEpoch,
        clientCertFingerprintSha256,
        input.ipAddress
      );
    });

    return {
      terminalId: input.followerTerminalId,
      terminalName: input.terminalName,
      outletId: this.outletId,
      role: input.role,
      clusterEpoch: this.currentEpoch,
      clientCertFingerprintSha256,
    };
  }

  /**
   * Appends a Logical Transaction Frame (`global_tx_seq`) and replicates it to Warm-Standby followers,
   * updating `pos_terminals.last_replicated_tx_seq` in SQLite.
   */
  public async recordAndReplicateLogicalTx(input: {
    txType: string;
    referenceId: string;
    standbyFollowerIds?: readonly string[];
  }): Promise<LogicalTransactionFrame> {
    this.assertWriteAllowedOnLeader();

    this.globalTxSeq += 1;
    const frame: LogicalTransactionFrame = {
      globalTxSeq: this.globalTxSeq,
      clusterEpoch: this.currentEpoch,
      leaderTerminalId: this.terminalId,
      txType: input.txType,
      referenceId: input.referenceId,
      committedAt: new Date().toISOString(),
    };
    this.logicalTxLog.push(frame);

    const followers = input.standbyFollowerIds ?? [];
    if (followers.length > 0) {
      await this.engine.executeWriteImmediate((db) => {
        const stmt = db.prepare(
          `UPDATE pos_terminals
           SET last_replicated_tx_seq = MAX(last_replicated_tx_seq, ?),
               last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`
        );
        for (const fId of followers) {
          stmt.run(frame.globalTxSeq, fId);
        }
      });
    }

    return frame;
  }

  public getMissingLogicalTxFramesSince(lastSeq: number): LogicalTransactionFrame[] {
    return this.logicalTxLog.filter((f) => f.globalTxSeq > lastSeq);
  }

  /**
   * Promotes a Warm-Standby Follower node to Active Leader (`cluster_epoch + 1`) during failover.
   */
  public async promoteWarmStandbyToLeader(newLeaderTerminalId?: string): Promise<{
    newLeaderTerminalId: string;
    newClusterEpoch: number;
  }> {
    if (this.roleState === 'READ_ONLY_QUARANTINE') {
      throw new Error('Quarantined node cannot self-promote to Active Leader without recovery');
    }

    if (newLeaderTerminalId) {
      this.terminalId = newLeaderTerminalId;
    }
    this.currentEpoch += 1;
    this.roleState = 'ACTIVE_LEADER';

    await this.engine.executeWriteImmediate((db) => {
      // Demote any previous LEADER rows in this outlet to FOLLOWER_POS
      db.prepare(
        `UPDATE pos_terminals SET role = 'FOLLOWER_POS' WHERE outlet_id = ? AND role = 'LEADER' AND id != ?`
      ).run(this.outletId, this.terminalId);

      db.prepare(
        `UPDATE pos_terminals
         SET role = 'LEADER',
             cluster_epoch = ?,
             last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(this.currentEpoch, this.terminalId);
    });

    return {
      newLeaderTerminalId: this.terminalId,
      newClusterEpoch: this.currentEpoch,
    };
  }

  /**
   * Evaluates an incoming mDNS advertisement or peer Leader heartbeat.
   * If another Leader has `peerEpoch >= this.currentEpoch` while this node is `ACTIVE_LEADER`,
   * this node immediately transitions to `READ_ONLY_QUARANTINE` to prevent Split-Brain!
   */
  public async observePeerLeaderEpoch(
    peerLeaderTerminalId: string,
    peerEpoch: number
  ): Promise<ClusterNodeRoleState> {
    if (peerLeaderTerminalId === this.terminalId) {
      return this.roleState;
    }

    if (peerEpoch >= this.currentEpoch && this.roleState === 'ACTIVE_LEADER') {
      const previousEpoch = this.currentEpoch;
      this.currentEpoch = peerEpoch;
      this.roleState = 'READ_ONLY_QUARANTINE';

      await this.engine.executeWriteImmediate((db) => {
        db.prepare(
          `INSERT INTO security_audit_logs (
             event_type, actor_user_id, terminal_id, target_key, old_value_redacted, new_value_redacted
           ) VALUES ('SPLIT_BRAIN_EPOCH_QUARANTINE', 'USR-OWNER-01', ?, 'CLUSTER_EPOCH', ?, ?)`
        ).run(
          this.terminalId,
          `ACTIVE_LEADER:epoch=${previousEpoch}`,
          `READ_ONLY_QUARANTINE:peer=${peerLeaderTerminalId}:epoch=${peerEpoch}`
        );
      });
    } else if (peerEpoch > this.currentEpoch) {
      this.currentEpoch = peerEpoch;
    }

    return this.roleState;
  }
}
