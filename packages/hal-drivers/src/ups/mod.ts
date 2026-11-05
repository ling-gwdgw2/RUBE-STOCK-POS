/**
 * RUBE-STOCK-POS v3.1 UPS USB-HID Power-Loss Monitor (`UPS_HAL` — WBS-10)
 *
 * Enforces `ARCHITECTURE.md` Section 8.3 (3-Tier Data Resilience):
 * - Listens to USB-HID Power Device Page (`0x84`) reports (`AC_PRESENT`, `BATTERY_CHARGE_PCT`, `ESTIMATED_RUNTIME_SEC`)
 * - Immediately triggers `PRAGMA wal_checkpoint(TRUNCATE);` + `FlushFileBuffers` when `AC_PRESENT === false`
 * - Enters `LOW_POWER_READ_ONLY_LOCK` when battery drops `<= 20%` or runtime `<= 120s` to prevent mid-write power loss
 */

import type { UpsPowerStateEvent } from '../../../shared-contracts/src/hal-events.ts';

export type UpsProtectionState =
  | 'NORMAL_AC_ONLINE'
  | 'ON_BATTERY_CHECKPOINT_TRIGGERED'
  | 'LOW_POWER_READ_ONLY_LOCK';

export interface UpsPowerMonitorCallbacks {
  onTriggerEmergencyWalCheckpoint: (event: UpsPowerStateEvent) => Promise<void> | void;
  onStateChanged?: (newState: UpsProtectionState, event: UpsPowerStateEvent) => void;
}

export class UpsPowerHidMonitor {
  private currentState: UpsProtectionState = 'NORMAL_AC_ONLINE';
  private checkpointCount = 0;
  private readonly callbacks: UpsPowerMonitorCallbacks;
  private readonly lowBatteryThresholdPct: number;

  constructor(callbacks: UpsPowerMonitorCallbacks, lowBatteryThresholdPct = 20) {
    this.callbacks = callbacks;
    this.lowBatteryThresholdPct = lowBatteryThresholdPct;
  }

  public getProtectionState(): UpsProtectionState {
    return this.currentState;
  }

  public getEmergencyCheckpointCount(): number {
    return this.checkpointCount;
  }

  public isWriteLockedByLowBattery(): boolean {
    return this.currentState === 'LOW_POWER_READ_ONLY_LOCK';
  }

  /**
   * Processes a USB-HID Power Device (`0x84`) report from the UPS.
   */
  public async handleHidPowerReport(report: {
    acPresent: boolean;
    batteryChargePercent: number;
    estimatedRuntimeSeconds: number;
  }): Promise<UpsProtectionState> {
    const previousState = this.currentState;
    const triggeredWalCheckpoint = !report.acPresent;

    const event: UpsPowerStateEvent = {
      acPresent: report.acPresent,
      batteryChargePercent: report.batteryChargePercent,
      estimatedRuntimeSeconds: report.estimatedRuntimeSeconds,
      triggeredWalCheckpoint,
    };

    if (report.acPresent) {
      this.currentState = 'NORMAL_AC_ONLINE';
    } else if (
      report.batteryChargePercent <= this.lowBatteryThresholdPct ||
      report.estimatedRuntimeSeconds <= 120
    ) {
      this.currentState = 'LOW_POWER_READ_ONLY_LOCK';
    } else {
      this.currentState = 'ON_BATTERY_CHECKPOINT_TRIGGERED';
    }

    if (!report.acPresent) {
      this.checkpointCount++;
      await this.callbacks.onTriggerEmergencyWalCheckpoint(event);
    }

    if (this.currentState !== previousState) {
      this.callbacks.onStateChanged?.(this.currentState, event);
    }

    return this.currentState;
  }
}
