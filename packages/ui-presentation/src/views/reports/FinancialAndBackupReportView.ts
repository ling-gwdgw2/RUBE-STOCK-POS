/**
 * RUBE-STOCK-POS v3.1 Phase 5: Financial & Accounting Reports (`REPORT_VIEW`) and
 * Backup / Schema Upgrade Management Controller (Squad C Phase 5)
 *
 * Implements:
 * 1. End-of-Shift Z-Report (`getShiftZReportView`)
 * 2. Simplified Tax Invoice ABB Sales Tax Report (`getAbbSalesTaxReportView`)
 * 3. Warehouse Stock Valuation Report (`getInventoryValuationReportView`)
 * 4. Menu COGS & Gross Margin Report (`getMenuCogsAndMarginReportView`)
 * 5. Shift Closure with Automatic Encrypted USB Ring-Buffer Backup (`closeShiftWithAutoUsbBackup`)
 * 6. Air-Gapped 5-Step FK-Safe Database Schema Upgrade (`applyAirGappedSchemaUpgrade`)
 */

import type { PosShiftDto } from '../../../../shared-contracts/src/ipc-commands.ts';
import type {
  AbbSalesTaxReportDto,
  InventoryValuationReportDto,
  MenuGrossMarginReportDto,
  SchemaUpgradeInput,
  SchemaUpgradeResult,
  ShiftZReportDto,
} from '../../../../core-engine/src/runtime/sqlite-engine.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';

export class FinancialAndBackupReportViewController {
  private readonly ipc: LocalIpcBridge;

  constructor(ipc: LocalIpcBridge) {
    this.ipc = ipc;
  }

  public getShiftZReportView(shiftId: string): ShiftZReportDto {
    return this.ipc.generateShiftZReport(shiftId);
  }

  public getAbbSalesTaxReportView(outletId = 'OUTLET-HQ'): AbbSalesTaxReportDto {
    return this.ipc.generateAbbSalesTaxReport(outletId);
  }

  public getInventoryValuationReportView(outletId = 'OUTLET-HQ'): InventoryValuationReportDto {
    return this.ipc.generateInventoryValuationReport(outletId);
  }

  public getMenuCogsAndMarginReportView(outletId = 'OUTLET-HQ'): MenuGrossMarginReportDto {
    return this.ipc.generateMenuGrossMarginAndCogsReport(outletId);
  }

  /**
   * Closes the active Cashier Shift via Blind Drop, generates the End-of-Shift Z-Report,
   * and automatically exports an encrypted `.db.enc` backup to the attached USB Flash Drive
   * with `.part` + `fsync` + 14-Shift Ring Buffer rotation.
   */
  public async closeShiftWithAutoUsbBackup(params: {
    shiftId: string;
    closedByUserId: string;
    countedCashSatang: number;
    usbBackupDir: string;
    notes?: string;
  }): Promise<{
    closedShift: PosShiftDto;
    zReport: ShiftZReportDto;
    usbBackup: {
      writtenBackupPath: string;
      evictedOldestBackupPath: string | null;
      retainedBackupsCount: number;
      cleanedOrphanedPartFilesCount: number;
    };
  }> {
    const closedShift = await this.ipc.closePosShiftBlindDrop({
      shiftId: params.shiftId,
      closedByUserId: params.closedByUserId,
      countedCashSatang: params.countedCashSatang,
      ...(params.notes ? { notes: params.notes } : {}),
    });

    const zReport = this.ipc.generateShiftZReport(params.shiftId);
    const usbBackup = await this.ipc.exportEncryptedUsbBackupWithRingBuffer(
      params.usbBackupDir,
      closedShift.shiftNumber
    );

    return {
      closedShift,
      zReport,
      usbBackup,
    };
  }

  /**
   * Executes an Air-Gapped 5-Step Foreign-Key Safe Database Schema Upgrade with
   * Pre-Upgrade Snapshot and Automatic Rollback on DDL or `PRAGMA foreign_key_check` failure.
   */
  public async applyAirGappedSchemaUpgrade(
    input: SchemaUpgradeInput
  ): Promise<SchemaUpgradeResult> {
    return this.ipc.executeFiveStepSchemaUpgrade(input);
  }
}

