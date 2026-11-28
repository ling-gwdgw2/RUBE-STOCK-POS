/**
 * RUBE-STOCK-POS v3.1.1 Browser Web NFC Writer (`NDEFReader`)
 *
 * Pure browser-safe offline utility (zero `node:*`, zero `Buffer`, zero external dependencies).
 * Works natively on Android Chrome/Edge when opened on Secure Context (`http://127.0.0.1` or `https://`).
 * Gracefully reports unsupported status on Windows Desktop / iOS Safari so staff can fall back to QR Bridge / CSV export.
 */

import type { NfcTableTagPackageDto } from '../../../../shared-contracts/src/qr-ordering.ts';

export interface WebNfcRecordInit {
  recordType: string;
  mediaType?: string;
  data: string | BufferSource;
}

interface WebNdefReaderInstance {
  write: (
    message: { records: WebNfcRecordInit[] },
    options?: { overwrite?: boolean; signal?: AbortSignal }
  ) => Promise<void>;
}

type WebNdefReaderCtor = new () => WebNdefReaderInstance;

function decodeBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = window.atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Checks whether the current browser runtime exposes Web NFC (`NDEFReader`) in a writable context.
 */
export function isWebNfcSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as { NDEFReader?: WebNdefReaderCtor };
  return typeof win.NDEFReader === 'function';
}

/**
 * Converts a server-computed `NfcTableTagPackageDto` into Web NFC `NDEFReader.write` records.
 */
export function buildWebNfcRecordsFromPackage(
  pkg: Pick<NfcTableTagPackageDto, 'recordLayout' | 'menuUrl' | 'wscBase64'>
): WebNfcRecordInit[] {
  const records: WebNfcRecordInit[] = [];
  if (pkg.recordLayout === 'URI_ONLY' || !pkg.wscBase64) {
    records.push({ recordType: 'url', data: pkg.menuUrl });
    return records;
  }
  const wscBuffer = decodeBase64ToArrayBuffer(pkg.wscBase64);
  if (pkg.recordLayout === 'WIFI_WSC_ONLY') {
    records.push({
      recordType: 'mime',
      mediaType: 'application/vnd.wfa.wsc',
      data: wscBuffer,
    });
    return records;
  }
  records.push({ recordType: 'url', data: pkg.menuUrl });
  records.push({
    recordType: 'mime',
    mediaType: 'application/vnd.wfa.wsc',
    data: wscBuffer,
  });
  return records;
}

/**
 * Prompts the Android device NFC antenna to write the NDEF message when a tag is tapped.
 */
export async function writeNfcPackageViaBrowserReader(
  pkg: NfcTableTagPackageDto,
  timeoutMs = 25_000
): Promise<{ recordsCount: number; ndefByteLength: number }> {
  if (!isWebNfcSupported()) {
    throw new Error(
      'เบราว์เซอร์นี้ไม่รองรับ Web NFC (NDEFReader) — แนะนำเปิด POS บน Android Chrome เพื่อเขียนแท็ก หรือใช้ปุ่มคัดลอกลิงก์ / QR ส่งเข้าแอป NFC Tools'
    );
  }
  if (!pkg.fitsSelectedChip) {
    throw new Error(
      `ข้อมูล NDEF (${pkg.ndefByteLength} Bytes) ใหญ่เกินความจุชิป ${pkg.chipType} (${pkg.chipCapacityBytes} Bytes)`
    );
  }
  const win = window as unknown as { NDEFReader: WebNdefReaderCtor };
  const reader = new win.NDEFReader();
  const records = buildWebNfcRecordsFromPackage(pkg);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    await reader.write({ records }, { overwrite: true, signal: controller.signal });
    return { recordsCount: records.length, ndefByteLength: pkg.ndefByteLength };
  } finally {
    window.clearTimeout(timer);
  }
}
