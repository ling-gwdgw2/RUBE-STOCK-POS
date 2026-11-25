import { useEffect, useRef } from 'react';
import { PhysicalScannerStreamBuffer } from '../../hooks/usePhysicalScanner.ts';

export interface UseGlobalBarcodeScannerOptions {
  enabled: boolean;
  onBarcodeScanned: (barcode: string) => void;
  onFirstCharRollback?: () => void;
}

/**
 * Global Physical Barcode Listener (`< 50ms` inter-key cadence via `KeyboardEvent.code`).
 * Immune to Windows Thai Kedmanee/Pattachote keyboard layouts (`_-ๅ/-ภถ` -> `885...`),
 * and automatically rolls back any first leaked character inside a focused `<input>`.
 */
export function useGlobalBarcodeScanner({
  enabled,
  onBarcodeScanned,
  onFirstCharRollback,
}: UseGlobalBarcodeScannerOptions): void {
  const scannerRef = useRef<PhysicalScannerStreamBuffer | null>(null);
  if (!scannerRef.current) {
    scannerRef.current = new PhysicalScannerStreamBuffer(50, 6);
  }

  const callbacksRef = useRef({ onBarcodeScanned, onFirstCharRollback });
  callbacksRef.current = { onBarcodeScanned, onFirstCharRollback };

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditableNonSearch =
        target &&
        (target.tagName === 'TEXTAREA' ||
          (target.tagName === 'INPUT' && target.dataset.scannerAllow !== 'true'));

      // Still allow global scanning when no input is focused or when the POS search input (`data-scanner-allow="true"`) is focused
      if (isEditableNonSearch) {
        return;
      }

      const buf = scannerRef.current!;
      const { completedBarcode, shouldPreventDefault } = buf.pushKeystroke(
        {
          code: e.code,
          timestampMs: e.timeStamp || performance.now(),
        },
        () => {
          callbacksRef.current.onFirstCharRollback?.();
        }
      );

      if (shouldPreventDefault) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (completedBarcode) {
        callbacksRef.current.onBarcodeScanned(completedBarcode);
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [enabled]);
}
