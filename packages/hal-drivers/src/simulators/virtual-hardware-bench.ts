/**
 * RUBE-STOCK-POS v3.1 Virtual Hardware Simulator Bench (`packages/hal-drivers/src/simulators`)
 *
 * Allows all 4 Squads to test Barcode Scanning (with Thai layout immunity),
 * Chunked 203-DPI Thermal Receipt Printing, UPS Power-Loss (`AC_PRESENT = 0`),
 * and 14-Shift USB Flash Drive Ring-Buffer Backups on any developer workstation without physical hardware.
 */

import type {
  UpsPowerEvent,
  UsbBackupRingEvent,
} from '../../../shared-contracts/src/hal-events.ts';
import { decodePhysicalKeyCodesToBarcode } from '../scanner/mod.ts';
import { encodeChunkedRasterGsV0 } from '../printer/mod.ts';

export class VirtualHardwareBench {
  private readonly usbRingFiles: string[] = [];
  private readonly maxRingSize = 14;

  /**
   * Simulates firing the USB 2D Barcode Gun while Windows Keyboard is stuck in Thai mode (`_-ๅ/-ภถ`).
   */
  public simulateBarcodeGunScan(physicalKeyCodes: readonly string[]): {
    decodedAsciiBarcode: string;
    immuneToThaiKeyboard: boolean;
  } {
    const decodedAsciiBarcode = decodePhysicalKeyCodesToBarcode(physicalKeyCodes);
    return {
      decodedAsciiBarcode,
      immuneToThaiKeyboard: true,
    };
  }

  /**
   * Simulates rendering a receipt to the Virtual 80mm (576px) Thermal Paper Previewer
   * using Chunked Horizontal Banding (`GS v 0`).
   */
  public simulateThermalReceiptPrint(heightPx: number = 600): {
    widthPx: 576;
    heightPx: number;
    packetCount: number;
    maxPacketBytes: number;
  } {
    const widthPx = 576;
    const widthBytes = widthPx / 8; // 72 bytes per row
    const buffer = new Uint8Array(widthBytes * heightPx);

    // Draw synthetic receipt text rows (rows 0..199 and 300..599, leaving 200..299 pure white)
    for (let y = 0; y < heightPx; y++) {
      if (y >= 200 && y < 300) continue; // 100 dots of pure white space -> will trigger ESC J feed
      buffer[y * widthBytes] = 0b10101010;
    }

    const packets = encodeChunkedRasterGsV0(buffer, widthPx, heightPx, 96);
    const maxPacketBytes = packets.reduce((max, p) => Math.max(max, p.rawBytes.length), 0);

    return {
      widthPx,
      heightPx,
      packetCount: packets.length,
      maxPacketBytes,
    };
  }

  /**
   * Simulates a UPS Power-Loss Event (`AC_PRESENT = 0`).
   */
  public simulateUpsPowerLoss(batteryPercent: number): UpsPowerEvent {
    return {
      acPresent: false,
      batteryPercent,
      triggeredWalCheckpoint: true,
      triggeredEmergencyUsbBackup: batteryPercent <= 25,
      timestampIso: new Date().toISOString(),
    };
  }

  /**
   * Simulates writing an atomic `.part` + `fsync` backup to a USB drive and rotating the 14-shift ring buffer.
   */
  public simulateAtomicUsbShiftBackup(shiftNumber: string): UsbBackupRingEvent {
    const tempPartFilename = `rube_backup_${shiftNumber}.db.enc.part`;
    const finalEncryptedFilename = `rube_backup_${shiftNumber}.db.enc`;

    this.usbRingFiles.push(finalEncryptedFilename);
    let evictedOldestFilename: string | null = null;
    if (this.usbRingFiles.length > this.maxRingSize) {
      evictedOldestFilename = this.usbRingFiles.shift() ?? null;
    }

    return {
      shiftNumber,
      tempPartFilename,
      finalEncryptedFilename,
      fsyncCompleted: true,
      retainedRingFilesCount: this.usbRingFiles.length,
      evictedOldestFilename,
    };
  }
}
