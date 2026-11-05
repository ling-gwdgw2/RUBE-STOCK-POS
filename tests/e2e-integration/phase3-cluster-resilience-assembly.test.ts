/**
 * RUBE-STOCK-POS v3.1 Phase 3 End-to-End LAN Cluster, KDS Sequence Sync, Multi-Outlet Transfer & 3-Tier Resilience Suite
 *
 * Tests all 4 Squads working together on real file-backed WAL SQLite databases and USB backup directories:
 * - Squad A: `TRANSFER_SVC` (`TRANSFER_OUT`/`TRANSFER_IN`), `STOCKTAKE_SVC` (`RE_COUNT`), `KDS_SYNC`, `BACKUP_SVC`
 * - Squad B: `UPS_HAL` (`UpsPowerHidMonitor` USB-HID Power Page `0x84` -> Emergency `wal_checkpoint(TRUNCATE)`)
 * - Squad C: `KdsStationViewController` & `TransferAndStocktakeViewController`
 * - Squad D: `LanClusterCoordinator` (Zero-Port Isolation, mDNS across DHCP IP change, 6-Digit PIN mTLS Pairing,
 *            Logical Transaction Replicator `global_tx_seq`, and `cluster_epoch` Split-Brain Quarantine)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEV_SQLCIPHER_RAW_HEX_KEY_64,
  SqliteReadWritePoolEngine,
} from '../../packages/core-engine/src/runtime/sqlite-engine.ts';
import {
  LanClusterCoordinator,
  LocalIpcBridge,
} from '../../packages/cluster-gateway/src/index.ts';
import {
  KdsStationViewController,
  PosTerminalViewController,
  ShiftDrawerViewController,
  TransferAndStocktakeViewController,
} from '../../packages/ui-presentation/src/index.ts';
import { UpsPowerHidMonitor } from '../../packages/hal-drivers/src/index.ts';

function createTempDirAndDb(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rube-pos-p3-${prefix}-`));
  return { dir, dbPath: path.join(dir, 'cluster_phase3.db') };
}

test('Phase 3 Assembly 1: KDS Monotonic sequence_id Sync, Wi-Fi Drop Gap Recovery & Ticket Bump', async () => {
  const { dbPath } = createTempDirAndDb('kds');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
    const cluster = new LanClusterCoordinator({
      engine,
      outletId: 'OUTLET-HQ',
      terminalId: 'POS-TERM-01',
      mode: 'MULTI_TERMINAL_LAN_CLUSTER',
    });
    const bridge = new LocalIpcBridge(engine, cluster);

    // 1. Pair KDS Tablet (`KDS-TERM-BAR-01`) using 6-digit PIN `482910`
    const pin = cluster.openPairingWindowWith6DigitPin('482910');
    const cert = await cluster.pairFollowerTerminalWithPin({
      submittedPin: pin,
      followerTerminalId: 'KDS-TERM-BAR-01',
      terminalName: 'Bar Kitchen Display Tablet #1',
      role: 'FOLLOWER_KDS',
      ipAddress: '192.168.1.55',
    });
    assert.equal(cert.role, 'FOLLOWER_KDS');

    const shiftView = new ShiftDrawerViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');
    const posView = new PosTerminalViewController(bridge, 'OUTLET-HQ', 'POS-TERM-01');
    const kdsView = new KdsStationViewController(bridge, {
      outletId: 'OUTLET-HQ',
      kdsTerminalId: 'KDS-TERM-BAR-01',
      station: 'BAR',
    });

    const shift = await shiftView.openShift({
      shiftNumber: '20261105-KDS-S1',
      openingCashSatang: 100_000,
    });

    // 2. Order #1 arrives while KDS is online -> KDS syncs and bumps Ticket #1 to SERVED
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-MILKTEA',
      quantityMilli: 1_000,
      selectedModifierIds: ['MOD-SWEET-50'],
    });
    const order1 = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-KDS-ORD-01',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 10_000,
    });
    assert.equal(order1.checkoutResult.kitchenOrderSequenceId, 1);

    const firstSync = kdsView.syncMissedTicketsFromLeader();
    assert.equal(firstSync.length, 1);
    assert.equal(firstSync[0]!.sequenceId, 1);

    const bump1 = await kdsView.bumpTicketStatus(1, 'SERVED');
    assert.equal(bump1.lastAckedKdsSeq, 1);
    assert.equal(kdsView.getLastAckedKdsSeq(), 1);

    // 3. Simulate KDS Wi-Fi Drop! While KDS is offline, POS processes Order #2 and Order #3
    posView.clearCart();
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-HONEYTEA',
      quantityMilli: 1_000,
    });
    const order2 = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-KDS-ORD-02',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 10_000,
    });
    assert.equal(order2.checkoutResult.kitchenOrderSequenceId, 2);

    posView.clearCart();
    posView.addVariantWithModifiersToCart({
      variantId: 'VAR-CAFE-MILKTEA',
      quantityMilli: 2_000,
      selectedModifierIds: ['MOD-EXTRA-BOBA'],
    });
    const order3 = await posView.confirmCheckoutAndPrint({
      idempotencyKey: 'IDEMP-KDS-ORD-03',
      shiftId: shift.id,
      paymentMethod: 'CASH',
      cashTenderedSatang: 20_000,
    });
    assert.equal(order3.checkoutResult.kitchenOrderSequenceId, 3);

    // 4. KDS Wi-Fi reconnects -> calls syncMissedTicketsFromLeader() with lastAckedKdsSeq = 1
    const recoveredAfterWifiDrop = kdsView.syncMissedTicketsFromLeader();
    assert.equal(
      recoveredAfterWifiDrop.length,
      2,
      'KDS must recover exactly missed orders #2 and #3 without duplicating #1'
    );
    assert.equal(recoveredAfterWifiDrop[0]!.sequenceId, 2);
    assert.equal(recoveredAfterWifiDrop[1]!.sequenceId, 3);

    await kdsView.bumpTicketStatus(2, 'READY');
    const bump3 = await kdsView.bumpTicketStatus(3, 'SERVED');
    assert.equal(bump3.lastAckedKdsSeq, 3);
  } finally {
    engine.close();
  }
});

test('Phase 3 Assembly 2: Zero-Port Isolation, mDNS DHCP Discovery, 6-Digit PIN mTLS Pairing, Logical Tx Stream & Split-Brain Quarantine', async () => {
  const { dbPath } = createTempDirAndDb('cluster');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');

    // 1. Default mode is Standalone IPC-Only (Zero TCP Ports bound)
    const leaderNode1 = new LanClusterCoordinator({
      engine,
      outletId: 'OUTLET-HQ',
      terminalId: 'POS-TERM-01',
    });
    assert.equal(leaderNode1.getOperatingMode(), 'STANDALONE_IPC_ONLY');
    assert.equal(leaderNode1.shouldBindTcpListener(), false);

    // Opt-In to Multi-Terminal LAN Cluster
    leaderNode1.enableMultiTerminalLanCluster();
    assert.equal(leaderNode1.shouldBindTcpListener(), true);

    // 2. mDNS Service Discovery across router DHCP IP change (192.168.1.10 -> 192.168.1.220)
    const mdnsPacket = leaderNode1.buildMdnsLeaderAdvertisement('192.168.1.220', 3001);
    const resolved = LanClusterCoordinator.parseMdnsLeaderAdvertisement(mdnsPacket);
    assert.equal(resolved.outletId, 'OUTLET-HQ');
    assert.equal(resolved.leaderId, 'POS-TERM-01');
    assert.equal(resolved.clusterEpoch, 1);
    assert.equal(resolved.endpointUrl, 'https://192.168.1.220:3001');

    // 3. Pair Warm-Standby Follower (`POS-TERM-02`) with 6-Digit PIN (`739104`)
    const pin = leaderNode1.openPairingWindowWith6DigitPin('739104');
    await assert.rejects(
      async () => {
        await leaderNode1.pairFollowerTerminalWithPin({
          submittedPin: '000000',
          followerTerminalId: 'POS-TERM-02',
          terminalName: 'Counter #2 Standby POS',
          role: 'FOLLOWER_POS',
          ipAddress: '192.168.1.221',
        });
      },
      /HTTP 401 Invalid 6-digit mTLS Pairing PIN/
    );

    const pairedCert = await leaderNode1.pairFollowerTerminalWithPin({
      submittedPin: pin,
      followerTerminalId: 'POS-TERM-02',
      terminalName: 'Counter #2 Standby POS',
      role: 'FOLLOWER_POS',
      ipAddress: '192.168.1.221',
    });
    assert.equal(pairedCert.terminalId, 'POS-TERM-02');
    assert.equal(pairedCert.clusterEpoch, 1);
    assert.equal(pairedCert.clientCertFingerprintSha256.length, 64);

    // Single-use PIN cannot be replayed
    await assert.rejects(
      async () => {
        await leaderNode1.pairFollowerTerminalWithPin({
          submittedPin: pin,
          followerTerminalId: 'POS-TERM-03',
          terminalName: 'Rogue Terminal',
          role: 'FOLLOWER_POS',
          ipAddress: '192.168.1.222',
        });
      },
      /HTTP 401 Pairing window is closed/
    );

    // 4. Stream 3 Logical Transaction Frames (`global_tx_seq = 1..3`) to Warm-Standby `POS-TERM-02`
    await leaderNode1.recordAndReplicateLogicalTx({
      txType: 'SALES_ORDER_COMMIT',
      referenceId: 'SO-001',
      standbyFollowerIds: ['POS-TERM-02'],
    });
    await leaderNode1.recordAndReplicateLogicalTx({
      txType: 'SALES_ORDER_COMMIT',
      referenceId: 'SO-002',
      standbyFollowerIds: ['POS-TERM-02'],
    });
    const frame3 = await leaderNode1.recordAndReplicateLogicalTx({
      txType: 'PO_RECEIVE_COMMIT',
      referenceId: 'PO-001',
      standbyFollowerIds: ['POS-TERM-02'],
    });
    assert.equal(frame3.globalTxSeq, 3);
    assert.equal(leaderNode1.getMissingLogicalTxFramesSince(1).length, 2);

    // 5. Simulate Failover: Standby `POS-TERM-02` promotes itself to Leader (`epoch = 2`)
    const standbyNode2 = new LanClusterCoordinator({
      engine,
      outletId: 'OUTLET-HQ',
      terminalId: 'POS-TERM-02',
      mode: 'MULTI_TERMINAL_LAN_CLUSTER',
      initialRoleState: 'WARM_STANDBY_FOLLOWER',
      initialEpoch: 1,
    });
    const promotion = await standbyNode2.promoteWarmStandbyToLeader('POS-TERM-02');
    assert.equal(promotion.newLeaderTerminalId, 'POS-TERM-02');
    assert.equal(promotion.newClusterEpoch, 2);

    // 6. Stale old Leader (`POS-TERM-01`, epoch = 1) comes back online and observes `POS-TERM-02` at `epoch = 2`
    const oldLeaderBridge = new LocalIpcBridge(engine, leaderNode1);
    const newRoleState = await leaderNode1.observePeerLeaderEpoch('POS-TERM-02', 2);
    assert.equal(
      newRoleState,
      'READ_ONLY_QUARANTINE',
      'Stale Leader must immediately demote itself to READ_ONLY_QUARANTINE upon observing higher epoch'
    );

    // Verify quarantined old Leader rejects any write mutation via LocalIpcBridge!
    await assert.rejects(
      async () => {
        await oldLeaderBridge.registerOutlet({
          id: 'OUTLET-SPLIT-BRAIN',
          code: 'SB-01',
          name: 'Forbidden Split Brain Write',
        });
      },
      /HTTP 423 Locked: Terminal POS-TERM-01 is in READ_ONLY_QUARANTINE/,
      'Quarantined old Leader must block all write mutations to prevent Split-Brain'
    );
  } finally {
    engine.close();
  }
});

test('Phase 3 Assembly 3: Inter-Outlet Stock Transfer (TRANSFER_OUT / TRANSFER_IN) & Physical Stocktake (RE_COUNT)', async () => {
  const { dbPath } = createTempDirAndDb('transfer-stocktake');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
    const bridge = new LocalIpcBridge(engine);
    const transferStocktakeView = new TransferAndStocktakeViewController(bridge);

    // 1. Register secondary branch `OUTLET-BRANCH-02`
    await bridge.registerOutlet({
      id: 'OUTLET-BRANCH-02',
      code: 'BR-02',
      name: 'RUBE Sukhumvit Branch 2',
      isWarehouse: false,
    });

    // 2. Dispatch 20 bottles (20,000 Milli) of Crystal Water (`VAR-RET-001`, MAC 4,250,000 Micro-Baht)
    // from `OUTLET-HQ` (initial stock 120,000 Milli) to `OUTLET-BRANCH-02`
    const dispatchRes = await transferStocktakeView.dispatchTransfer({
      transferNumber: 'TR-20261105-001',
      sourceOutletId: 'OUTLET-HQ',
      destinationOutletId: 'OUTLET-BRANCH-02',
      performedByUserId: 'USR-WH-01',
      items: [
        {
          variantId: 'VAR-RET-001',
          quantityMilli: 20_000,
        },
      ],
    });
    assert.equal(dispatchRes.status, 'IN_TRANSIT');
    assert.equal(dispatchRes.dispatchedItems[0]!.sourceStockAfterMilli, 100_000);
    assert.equal(dispatchRes.dispatchedItems[0]!.transferUnitCostMicroBaht, 4_250_000);

    // 3. Receive Transfer at `OUTLET-BRANCH-02`
    const receiveRes = await transferStocktakeView.receiveTransfer({
      transferOrderId: dispatchRes.transferOrderId,
      receivedByUserId: 'USR-WH-01',
    });
    assert.equal(receiveRes.status, 'COMPLETED');
    assert.equal(receiveRes.receivedItems[0]!.destinationStockAfterMilli, 20_000);
    assert.equal(receiveRes.receivedItems[0]!.destinationMacAfterMicroBaht, 4_250_000);

    // 4. Execute Physical Inventory Stocktake (`RE_COUNT`) at `OUTLET-HQ`:
    // Expected `VAR-RET-001` is 100,000 Milli (100 bottles), physical count finds 98,000 Milli (98 bottles -> -2 bottles variance)
    const countVm = await transferStocktakeView.submitPhysicalInventoryCount({
      countNumber: 'CNT-20261105-001',
      outletId: 'OUTLET-HQ',
      createdByUserId: 'USR-WH-01',
      items: [
        {
          variantId: 'VAR-RET-001',
          countedStockMilli: 98_000,
        },
      ],
    });
    assert.equal(countVm.lines[0]!.expectedStockMilli, 100_000);
    assert.equal(countVm.lines[0]!.countedStockMilli, 98_000);
    assert.equal(countVm.lines[0]!.varianceMilli, -2_000);
    assert.equal(countVm.totalVarianceSatang, -850); // -2 bottles * 4.25 THB = -8.50 THB (-850 Satang)

    // 5. Verify 100% Ledger Conservation Invariant across BOTH `OUTLET-HQ` and `OUTLET-BRANCH-02`!
    const hqConservation = bridge.verifyLedgerConservationInvariant('OUTLET-HQ');
    assert.equal(hqConservation.valid, true);
    const branchConservation = bridge.verifyLedgerConservationInvariant('OUTLET-BRANCH-02');
    assert.equal(branchConservation.valid, true);
  } finally {
    engine.close();
  }
});

test('Phase 3 Assembly 4: 3-Tier Data Resilience — UPS Power-Loss WAL Checkpoint & 14-Shift USB Ring-Buffer Backup', async () => {
  const { dir, dbPath } = createTempDirAndDb('ups-backup');
  const usbBackupDir = path.join(dir, 'usb_flash_drive');
  const engine = new SqliteReadWritePoolEngine(dbPath, DEV_SQLCIPHER_RAW_HEX_KEY_64, 4);

  try {
    await engine.seedDefaultWarehouseAndCatalog('OUTLET-HQ');
    const bridge = new LocalIpcBridge(engine);

    // 1. Wire `UpsPowerHidMonitor` (`0x84` Power Device Page) to `bridge.triggerEmergencyUpsWalCheckpoint`
    let emergencyCheckpointsCompleted = 0;
    const upsMonitor = new UpsPowerHidMonitor({
      onTriggerEmergencyWalCheckpoint: async () => {
        const res = await bridge.triggerEmergencyUpsWalCheckpoint('POS-TERM-01');
        if (res.walCheckpointed) {
          emergencyCheckpointsCompleted++;
        }
      },
    });

    assert.equal(upsMonitor.getProtectionState(), 'NORMAL_AC_ONLINE');

    // Simulate sudden AC power outage (AC_PRESENT = false, 65% battery, 600s runtime)
    const stateAfterBlackout = await upsMonitor.handleHidPowerReport({
      acPresent: false,
      batteryChargePercent: 65,
      estimatedRuntimeSeconds: 600,
    });
    assert.equal(stateAfterBlackout, 'ON_BATTERY_CHECKPOINT_TRIGGERED');
    assert.equal(emergencyCheckpointsCompleted, 1);

    // Simulate battery draining to 15% (<= 20% threshold) -> enters LOW_POWER_READ_ONLY_LOCK
    const stateLowBattery = await upsMonitor.handleHidPowerReport({
      acPresent: false,
      batteryChargePercent: 15,
      estimatedRuntimeSeconds: 90,
    });
    assert.equal(stateLowBattery, 'LOW_POWER_READ_ONLY_LOCK');
    assert.equal(upsMonitor.isWriteLockedByLowBattery(), true);
    assert.equal(emergencyCheckpointsCompleted, 2);

    // 2. Write 16 consecutive Shift Backups (`20261105-S1` .. `20261105-S16`) to the USB drive
    // and verify `.part` atomic rename + 14-Shift Ring Buffer with natural numeric sorting!
    for (let s = 1; s <= 16; s++) {
      const res = await bridge.exportEncryptedUsbBackupWithRingBuffer(
        usbBackupDir,
        `20261105-S${s}`
      );
      assert.ok(fs.existsSync(res.writtenBackupPath));
      assert.ok(res.retainedBackupsCount <= 14);
    }

    const filesOnUsb = fs
      .readdirSync(usbBackupDir)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    assert.equal(
      filesOnUsb.some((f) => f.endsWith('.part')),
      false,
      'Zero leftover .part files allowed after atomic rename'
    );
    assert.equal(filesOnUsb.length, 14, 'Ring buffer must retain exactly 14 most recent shifts');
    assert.equal(
      filesOnUsb[0],
      'rube_backup_20261105-S3.db.enc',
      'Oldest shifts S1 and S2 must be evicted first'
    );
    assert.equal(
      filesOnUsb[13],
      'rube_backup_20261105-S16.db.enc',
      'Newest shift S16 must be preserved (natural numeric sorting must not evict S10+ before S2)'
    );
  } finally {
    engine.close();
  }
});

