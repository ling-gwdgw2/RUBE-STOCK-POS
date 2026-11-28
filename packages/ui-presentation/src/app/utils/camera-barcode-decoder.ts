import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HTMLCanvasElementLuminanceSource,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
} from '@zxing/library';
import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import { pickLocaleText } from '../i18n/translations.ts';

interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Array<{ rawValue?: string }>>;
}

type NativeBarcodeDetectorCtor = new (options?: { formats?: string[] }) => NativeBarcodeDetector;

const SUPPORTED_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
];

function createZxingReader(): MultiFormatReader {
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  return reader;
}

function tryDecodeCanvasWithZxing(
  reader: MultiFormatReader,
  canvas: HTMLCanvasElement
): { text: string; format: BarcodeFormat } | null {
  if (canvas.width < 16 || canvas.height < 16) return null;
  try {
    const luminanceSource = new HTMLCanvasElementLuminanceSource(canvas);
    const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
    const result = reader.decodeWithState(binaryBitmap);
    const text = result.getText()?.trim();
    if (!text) return null;
    return { text, format: result.getBarcodeFormat() };
  } catch (err) {
    if (err instanceof NotFoundException) {
      return null;
    }
    return null;
  } finally {
    reader.reset();
  }
}

export interface VideoBarcodeScannerSession {
  hasNativeDetector: boolean;
  scanVideoFrame(
    video: HTMLVideoElement
  ): Promise<{ rawValue: string; engine: 'NATIVE' | 'ZXING_JS' } | null>;
}

/**
 * Creates a hybrid offline barcode decoder session:
 * - Uses native Chromium `BarcodeDetector` when available.
 * - Seamlessly falls back to pure-JS `@zxing/library` on Windows Edge WebView2 / browsers without `BarcodeDetector`.
 * - Requires 2 consecutive matching 1D reads under ZXing to avoid motion-blur digit misreads.
 */
export function createVideoBarcodeScannerSession(): VideoBarcodeScannerSession {
  let nativeDetector: NativeBarcodeDetector | null = null;
  if (typeof window !== 'undefined') {
    const Ctor = (window as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor })
      .BarcodeDetector;
    if (Ctor) {
      try {
        nativeDetector = new Ctor({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'],
        });
      } catch {
        nativeDetector = null;
      }
    }
  }

  const zxingReader = createZxingReader();
  const bandCanvas = document.createElement('canvas');
  const fullCanvas = document.createElement('canvas');
  let frameTick = 0;
  let lastZxingCandidate = '';
  let lastZxingCandidateCount = 0;

  return {
    hasNativeDetector: nativeDetector !== null,

    async scanVideoFrame(video: HTMLVideoElement) {
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        return null;
      }

      if (nativeDetector) {
        try {
          const results = await nativeDetector.detect(video);
          const raw = results[0]?.rawValue?.trim();
          if (raw) {
            return { rawValue: raw, engine: 'NATIVE' };
          }
        } catch {
          // Hardware frame unsupported -> fall through to ZXing JS
          nativeDetector = null;
        }
      }

      const srcW = video.videoWidth;
      const srcH = video.videoHeight;

      // 1. Center horizontal scan band (optimal for 1D retail barcodes aligned with the modal reticle)
      const bandSrcX = Math.floor(srcW * 0.08);
      const bandSrcW = Math.max(32, Math.floor(srcW * 0.84));
      const bandSrcH = Math.max(48, Math.floor(srcH * 0.45));
      const bandSrcY = Math.max(0, Math.floor((srcH - bandSrcH) / 2));

      const targetBandW = Math.min(800, bandSrcW);
      const targetBandH = Math.max(32, Math.round((bandSrcH * targetBandW) / bandSrcW));
      if (bandCanvas.width !== targetBandW || bandCanvas.height !== targetBandH) {
        bandCanvas.width = targetBandW;
        bandCanvas.height = targetBandH;
      }
      const bandCtx = bandCanvas.getContext('2d', { willReadFrequently: true });
      let decoded: { text: string; format: BarcodeFormat } | null = null;
      if (bandCtx) {
        bandCtx.drawImage(
          video,
          bandSrcX,
          bandSrcY,
          bandSrcW,
          bandSrcH,
          0,
          0,
          targetBandW,
          targetBandH
        );
        decoded = tryDecodeCanvasWithZxing(zxingReader, bandCanvas);
      }

      // 2. Every 2nd frame, also inspect full resized frame (supports tall QR codes & tilted labels)
      frameTick += 1;
      if (!decoded && frameTick % 2 === 0) {
        const targetFullW = Math.min(720, srcW);
        const targetFullH = Math.max(32, Math.round((srcH * targetFullW) / srcW));
        if (fullCanvas.width !== targetFullW || fullCanvas.height !== targetFullH) {
          fullCanvas.width = targetFullW;
          fullCanvas.height = targetFullH;
        }
        const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
        if (fullCtx) {
          fullCtx.drawImage(video, 0, 0, targetFullW, targetFullH);
          decoded = tryDecodeCanvasWithZxing(zxingReader, fullCanvas);
        }
      }

      if (!decoded) {
        return null;
      }

      if (decoded.format === BarcodeFormat.QR_CODE) {
        return { rawValue: decoded.text, engine: 'ZXING_JS' };
      }

      if (decoded.text === lastZxingCandidate) {
        lastZxingCandidateCount += 1;
      } else {
        lastZxingCandidate = decoded.text;
        lastZxingCandidateCount = 1;
      }

      if (lastZxingCandidateCount >= 2) {
        lastZxingCandidate = '';
        lastZxingCandidateCount = 0;
        return { rawValue: decoded.text, engine: 'ZXING_JS' };
      }

      return null;
    },
  };
}

/**
 * Decodes a barcode or QR code from a user-selected image file completely offline.
 */
export async function decodeBarcodeFromImageFile(
  file: File,
  locale: LocaleCode = 'th'
): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(
          new Error(
            pickLocaleText(
              locale,
              'ไม่สามารถเปิดไฟล์รูปภาพนี้ได้',
              'ບໍ່ສາມາດເປີດໄຟລ໌ຮູບພາບນີ້ໄດ້',
              'Unable to open the selected image file.'
            )
          )
        );
      el.src = objectUrl;
    });

    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (natW <= 0 || natH <= 0) return null;

    const maxEdge = 1280;
    const scale = Math.min(1, maxEdge / Math.max(natW, natH));
    const targetW = Math.max(32, Math.round(natW * scale));
    const targetH = Math.max(32, Math.round(natH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const reader = createZxingReader();
    const fullResult = tryDecodeCanvasWithZxing(reader, canvas);
    if (fullResult) return fullResult.text;

    // Fallback: center horizontal crop for sparse product photos
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = targetW;
    cropCanvas.height = Math.max(32, Math.round(targetH * 0.5));
    const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
    if (cropCtx) {
      cropCtx.drawImage(
        canvas,
        0,
        Math.round(targetH * 0.25),
        targetW,
        cropCanvas.height,
        0,
        0,
        cropCanvas.width,
        cropCanvas.height
      );
      const cropResult = tryDecodeCanvasWithZxing(reader, cropCanvas);
      if (cropResult) return cropResult.text;
    }

    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
