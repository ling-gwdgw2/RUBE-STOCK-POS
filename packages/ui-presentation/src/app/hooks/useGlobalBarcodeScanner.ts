import { useEffect, useRef } from 'react';
import { PhysicalScannerStreamBuffer } from '../../hooks/usePhysicalScanner.ts';

export type GlobalScannerRoutingMode = 'POS_CART' | 'SLIP_QR' | 'BLOCKED';

export interface UseGlobalBarcodeScannerOptions {
  enabled: boolean;
  scannerMode?: GlobalScannerRoutingMode;
  onBarcodeScanned: (barcode: string) => void;
  onSlipQrScanned?: (qrRaw: string) => void;
  onFirstCharRollback?: () => void;
  onSlipFirstCharRollback?: () => void;
  onBeforeFirstCharSnapshot?: () => void;
  onBeforeSlipFirstCharSnapshot?: () => void;
}

/**
 * Context-Aware Global Physical 1D/2D Scanner Listener (`< 50ms` inter-key cadence via `KeyboardEvent.code`).
 * - Immune to Windows Thai Kedmanee/Pattachote keyboard layouts (`_-ๅ/-ภถ` -> `885...` and `0-9A-Z` Mini-QR TLV).
 * - Blocks accidental background POS cart scans whenever a modal dialog (`[role="dialog"], [role="alertdialog"]`) is open.
 * - Routes 2D scans directly into the BOT Mini-QR verifier when `scannerMode === 'SLIP_QR'`.
 */
export function useGlobalBarcodeScanner({
  enabled,
  scannerMode = 'POS_CART',
  onBarcodeScanned,
  onSlipQrScanned,
  onFirstCharRollback,
  onSlipFirstCharRollback,
  onBeforeFirstCharSnapshot,
  onBeforeSlipFirstCharSnapshot,
}: UseGlobalBarcodeScannerOptions): void {
  const scannerRef = useRef<PhysicalScannerStreamBuffer | null>(null);
  if (!scannerRef.current) {
    scannerRef.current = new PhysicalScannerStreamBuffer(50, 6);
  }

  const callbacksRef = useRef({
    scannerMode,
    onBarcodeScanned,
    onSlipQrScanned,
    onFirstCharRollback,
    onSlipFirstCharRollback,
    onBeforeFirstCharSnapshot,
    onBeforeSlipFirstCharSnapshot,
  });
  callbacksRef.current = {
    scannerMode,
    onBarcodeScanned,
    onSlipQrScanned,
    onFirstCharRollback,
    onSlipFirstCharRollback,
    onBeforeFirstCharSnapshot,
    onBeforeSlipFirstCharSnapshot,
  };

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mode = callbacksRef.current.scannerMode;
      if (mode === 'BLOCKED') {
        return;
      }

      const target = e.target as HTMLElement | null;
      const hasOpenDialog =
        typeof document !== 'undefined' &&
        document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;

      if (mode === 'SLIP_QR') {
        // Inside Thai QR / Split QR checkout modal: allow unfocused scans OR scans inside `[data-scanner-slip-allow="true"]`
        const isSlipInputFocused =
          target?.tagName === 'INPUT' && target.dataset.scannerSlipAllow === 'true';
        const isOtherEditable =
          target &&
          (target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            (target.tagName === 'INPUT' && !isSlipInputFocused));

        if (isOtherEditable) {
          return;
        }

        const buf = scannerRef.current!;
        const { completedBarcode, shouldPreventDefault } = buf.pushKeystroke(
          {
            code: e.code,
            shiftKey: e.shiftKey,
            timestampMs: e.timeStamp || performance.now(),
          },
          () => {
            if (isSlipInputFocused) {
              callbacksRef.current.onSlipFirstCharRollback?.();
            }
          },
          () => {
            if (isSlipInputFocused) {
              callbacksRef.current.onBeforeSlipFirstCharSnapshot?.();
            }
          }
        );

        if (shouldPreventDefault) {
          e.preventDefault();
          e.stopPropagation();
        }

        if (completedBarcode) {
          callbacksRef.current.onSlipQrScanned?.(completedBarcode);
        }
        return;
      }

      // Default `POS_CART` mode: NEVER let physical scans leak through any open modal dialog into the cart
      if (hasOpenDialog) {
        return;
      }

      const isEditableNonSearch =
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          (target.tagName === 'INPUT' && target.dataset.scannerAllow !== 'true'));

      if (isEditableNonSearch) {
        return;
      }

      const isPosSearchInput =
        target?.tagName === 'INPUT' && target.dataset.scannerAllow === 'true';
      const buf = scannerRef.current!;
      const { completedBarcode, shouldPreventDefault } = buf.pushKeystroke(
        {
          code: e.code,
          shiftKey: e.shiftKey,
          timestampMs: e.timeStamp || performance.now(),
        },
        () => {
          if (isPosSearchInput) {
            callbacksRef.current.onFirstCharRollback?.();
          }
        },
        () => {
          if (isPosSearchInput) {
            callbacksRef.current.onBeforeFirstCharSnapshot?.();
          }
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
