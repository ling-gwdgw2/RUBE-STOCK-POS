/**
 * RUBE-STOCK-POS v3.1 Hardware Abstraction Layer (HAL) Event Contracts
 */

import type { MilliUnit, Satang } from './fixed-point.ts';

export type BarcodeSourceTier = 'WM_INPUT_USB_RAW' | 'PHYSICAL_KEYCODE_FALLBACK' | 'VIRTUAL_SIMULATOR';

export interface BarcodeScanEvent {
  rawBarcode: string;
  sourceTier: BarcodeSourceTier;
  hadThaiKeyboardLayoutInterference: boolean;
  parsedScaleData?: {
    mode: 'WEIGHT_EMBEDDED' | 'PRICE_EMBEDDED';
    prefix: string;
    itemSku: string;
    weightMilliKg?: MilliUnit;
    totalPriceSatang?: Satang;
  };
  timestampIso: string;
}

export interface ThermalPrintBandCommand {
  bandIndex: number;
  yOffsetDots: number;
  heightDots: number;
  widthBytes: number;
  gsV0Payload: Uint8Array;
}

export interface ThermalReceiptJobEvent {
  jobId: string;
  paperWidthMm: 58 | 80;
  widthPx: 384 | 576;
  totalHeightPx: number;
  bands: readonly ThermalPrintBandCommand[];
  skippedWhitespaceDots: number;
  kickDrawerCommandHex: string;
  cutPaperCommandHex: string;
}

export interface BotSlipVerificationResult {
  validFormat: boolean;
  isDuplicate: boolean;
  senderBankCode: string;
  senderBankNameThai: string;
  transRef: string;
  transRefLast4: string;
  transRefSha256Hex: string;
  expectedAmountSatang: Satang;
  requiresVisualAmountConfirmation: boolean;
  errorReason?: string;
}

export interface UpsPowerEvent {
  acPresent: boolean;
  batteryPercent: number;
  triggeredWalCheckpoint: boolean;
  triggeredEmergencyUsbBackup: boolean;
  timestampIso: string;
}

export interface UsbBackupRingEvent {
  shiftNumber: string;
  tempPartFilename: string;
  finalEncryptedFilename: string;
  fsyncCompleted: boolean;
  retainedRingFilesCount: number;
  evictedOldestFilename: string | null;
}

