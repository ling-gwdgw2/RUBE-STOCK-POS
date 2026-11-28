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
  if (typeof globalThis.atob !== 'function') {
    throw new Error('Base64 decoder (globalThis.atob) is not available in this runtime');
  }
  const binary = globalThis.atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function getNdefReaderCtor(): WebNdefReaderCtor | undefined {
  const g = globalThis as unknown as {
    NDEFReader?: WebNdefReaderCtor;
    isSecureContext?: boolean;
    window?: { NDEFReader?: WebNdefReaderCtor; isSecureContext?: boolean };
  };
  if (g.isSecureContext === false) {
    return undefined;
  }
  if (typeof g.window !== 'undefined') {
    if (g.window.isSecureContext === false) {
      return undefined;
    }
    if (typeof g.window?.NDEFReader === 'function') {
      return g.window.NDEFReader;
    }
  }
  if (typeof g.NDEFReader === 'function') {
    return g.NDEFReader;
  }
  return undefined;
}

/**
 * Checks whether the current browser runtime exposes Web NFC (`NDEFReader`) in a writable context.
 */
export function isWebNfcSupported(): boolean {
  return typeof getNdefReaderCtor() === 'function';
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
 * Supports optional external `AbortSignal` for modal/component unmount cleanup and translates timeout `AbortError`.
 */
export async function writeNfcPackageViaBrowserReader(
  pkg: NfcTableTagPackageDto,
  timeoutMs = 25_000,
  externalSignal?: AbortSignal
): Promise<{ recordsCount: number; ndefByteLength: number }> {
  const ReaderCtor = getNdefReaderCtor();
  if (!ReaderCtor) {
    throw new Error(
      'เบราว์เซอร์นี้ไม่รองรับ Web NFC (NDEFReader) — แนะนำเปิด POS บน Android Chrome เพื่อเขียนแท็ก หรือใช้ปุ่มคัดลอกลิงก์ / QR ส่งเข้าแอป NFC Tools'
    );
  }
  if (!pkg.fitsSelectedChip) {
    throw new Error(
      `ข้อมูล NDEF (${pkg.ndefByteLength} Bytes) ใหญ่เกินความจุชิป ${pkg.chipType} (${pkg.chipCapacityBytes} Bytes)`
    );
  }
  if (externalSignal?.aborted) {
    throw new Error('ยกเลิกการเขียนแท็ก NFC แล้ว (NFC write cancelled)');
  }

  const reader = new ReaderCtor();
  const records = buildWebNfcRecordsFromPackage(pkg);
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const safeTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(20, Number(timeoutMs)) : 25_000;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, safeTimeoutMs);

  let onInternalAbort: (() => void) | null = null;
  try {
    const writePromise = Promise.resolve().then(() =>
      reader.write({ records }, { overwrite: true, signal: controller.signal })
    );
    writePromise.catch(() => {});

    const abortPromise = new Promise<never>((_resolve, reject) => {
      onInternalAbort = () => reject(new Error('__NFC_ABORT__'));
      if (controller.signal.aborted) {
        onInternalAbort();
      } else {
        controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      }
    });

    await Promise.race([writePromise, abortPromise]);
    return { recordsCount: records.length, ndefByteLength: pkg.ndefByteLength };
  } catch (err) {
    const errName = (err as { name?: unknown } | null)?.name;
    if (timedOut) {
      const secs = Math.max(1, Math.round(safeTimeoutMs / 1000));
      throw new Error(
        `หมดเวลาแตะแท็ก NFC (${secs} วินาที) — กรุณากดเขียนใหม่แล้วนำแท็กมาแตะด้านหลังเครื่องให้เร็วขึ้น`
      );
    }
    if (externallyAborted || externalSignal?.aborted) {
      throw new Error('ยกเลิกการเขียนแท็ก NFC แล้ว (NFC write cancelled)');
    }
    if (errName === 'AbortError' || (err instanceof Error && err.message === '__NFC_ABORT__')) {
      throw new Error('การเขียนแท็ก NFC ถูกยกเลิกกลางคัน (NFC write aborted)');
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (onInternalAbort) {
      controller.signal.removeEventListener('abort', onInternalAbort);
    }
  }
}
