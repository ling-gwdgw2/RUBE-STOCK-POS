import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Camera, ImagePlus, ScanBarcode, X } from 'lucide-react';
import {
  createVideoBarcodeScannerSession,
  decodeBarcodeFromImageFile,
} from '../utils/camera-barcode-decoder.ts';
import { ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface BarcodeCameraScannerModalProps {
  open: boolean;
  mode: 'BARCODE' | 'PHOTO';
  onClose: () => void;
  onBarcodeDetected?: (code: string) => void;
  onPhotoCaptured?: (dataUrl: string) => void;
}

function playSoftScanBeep(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1480, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
    window.setTimeout(() => void ctx.close().catch(() => {}), 300);
  } catch {
    // ignore audio restrictions
  }
}

export const BarcodeCameraScannerModal: React.FC<BarcodeCameraScannerModalProps> = ({
  open,
  mode,
  onClose,
  onBarcodeDetected,
  onPhotoCaptured,
}) => {
  const uid = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState<boolean>(false);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [decodeFeedbackMsg, setDecodeFeedbackMsg] = useState<string | null>(null);
  const [decodingImage, setDecodingImage] = useState<boolean>(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setCameraReady(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stopStream();
      setDecodeFeedbackMsg(null);
      return;
    }

    let cancelled = false;
    setCameraError(null);
    setDecodeFeedbackMsg(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        mode === 'BARCODE'
          ? 'อุปกรณ์หรือหน้าต่างนี้ไม่รองรับการเปิดกล้องเว็บแคม — สามารถใช้ปืนสแกนบาร์โค้ด USB/Bluetooth หรือเลือกสแกนจากไฟล์รูปบาร์โค้ดด้านล่างได้ทันที'
          : 'อุปกรณ์หรือเบราว์เซอร์นี้ไม่รองรับการเปิดกล้องเว็บแคม — กรุณาใช้ปุ่มอัปโหลดรูปจากไฟล์แทน'
      );
      return;
    }

    const constraints: MediaStreamConstraints = {
      video: selectedDeviceId
        ? {
            deviceId: { exact: selectedDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
      audio: false,
    };

    void navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().then(() => {
            if (!cancelled) setCameraReady(true);
          });
        }
        if (navigator.mediaDevices.enumerateDevices) {
          void navigator.mediaDevices
            .enumerateDevices()
            .then((devices) => {
              if (cancelled) return;
              const cams = devices.filter((d) => d.kind === 'videoinput');
              setVideoDevices(cams);
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setCameraError(
            `ไม่สามารถเปิดกล้องได้ (${err instanceof Error ? err.message : 'ไม่พบกล้องหรือไม่ได้รับอนุญาต'}) — ${
              mode === 'BARCODE'
                ? 'คุณสามารถใช้ปืนสแกนบาร์โค้ด USB หรือเลือกไฟล์รูปบาร์โค้ดด้านล่างได้ทันที'
                : 'กรุณาใช้ปุ่มเลือกรูปสินค้าจากเครื่องแทน'
            }`
          );
        }
      });

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [mode, open, selectedDeviceId, stopStream]);

  // Real-time Offline 1D/2D Barcode Detection loop (Native BarcodeDetector + @zxing/library JS Fallback)
  useEffect(() => {
    if (!open || mode !== 'BARCODE' || !cameraReady) return;

    const session = createVideoBarcodeScannerSession();
    let stopped = false;
    let inFlight = false;

    const timer = window.setInterval(() => {
      if (stopped || inFlight || !videoRef.current || videoRef.current.readyState < 2) return;
      inFlight = true;
      void session
        .scanVideoFrame(videoRef.current)
        .then((hit) => {
          if (stopped || !hit?.rawValue) return;
          stopped = true;
          playSoftScanBeep();
          stopStream();
          onBarcodeDetected?.(hit.rawValue);
          onClose();
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }, 160);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [cameraReady, mode, onBarcodeDetected, onClose, open, stopStream]);

  const handleScanImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setDecodingImage(true);
    setDecodeFeedbackMsg(null);
    try {
      const decoded = await decodeBarcodeFromImageFile(file);
      if (decoded) {
        playSoftScanBeep();
        stopStream();
        onBarcodeDetected?.(decoded);
        onClose();
      } else {
        setDecodeFeedbackMsg(
          'ไม่พบบาร์โค้ดหรือ QR Code ที่คมชัดในรูปภาพนี้ — กรุณาลองถ่ายให้ตรงกรอบหรือใช้ปืนยิงบาร์โค้ด USB'
        );
      }
    } catch (err) {
      setDecodeFeedbackMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setDecodingImage(false);
    }
  };

  const handleCapturePhoto = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const srcW = video.videoWidth || 640;
    const srcH = video.videoHeight || 480;
    let w = srcW;
    let h = srcH;
    if (w > 640) {
      h = Math.max(1, Math.round((h * 640) / w));
      w = 640;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
    playSoftScanBeep();
    stopStream();
    onPhotoCaptured?.(dataUrl);
    onClose();
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy={`${uid}-cam-title`}
      maxWidthClass="max-w-lg"
    >
      <div className="flex items-center justify-between border-b border-hairline px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
            {mode === 'BARCODE' ? (
              <ScanBarcode className="h-4 w-4" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
          </div>
          <div>
            <h3
              id={`${uid}-cam-title`}
              className="font-google-display text-[18px] font-normal text-ink"
            >
              {mode === 'BARCODE' ? 'สแกนบาร์โค้ดสินค้าด้วยกล้อง' : 'ถ่ายรูปภาพสินค้าด้วยกล้อง'}
            </h3>
            <p className="text-xs text-ink-muted">
              {mode === 'BARCODE'
                ? 'วางบาร์โค้ด EAN-13 / Code128 / QR ให้อยู่ในกรอบตรงกลาง (ถอดรหัสออฟไลน์ 100%)'
                : 'จัดวางสินค้าให้อยู่ในกรอบแล้วกดปุ่มถ่ายภาพ'}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="ปิดหน้าต่างกล้อง"
          onClick={onClose}
          className={`flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="p-6 space-y-4">
        {videoDevices.length > 1 && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <label htmlFor={`${uid}-cam-select`} className="font-medium text-ink-muted shrink-0">
              เลือกกล้องเว็บแคม:
            </label>
            <select
              id={`${uid}-cam-select`}
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className={`h-10 flex-1 rounded-[4px] border border-hairline bg-canvas px-3 text-xs text-ink ${UI_INTERACTION.focusSelect}`}
            >
              <option value="">กล้องหลักอัตโนมัติ</option>
              {videoDevices.map((cam, idx) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `กล้องที่ ${idx + 1}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {cameraError ? (
          <div className="rounded-[8px] border border-hairline bg-surface-1 p-5 text-center space-y-2">
            <AlertTriangle className="h-8 w-8 text-primary mx-auto" />
            <p className="text-sm font-medium text-ink">ไม่สามารถเข้าถึงกล้องได้</p>
            <p className="text-xs text-ink-muted leading-relaxed">{cameraError}</p>
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-[8px] border border-hairline bg-hero aspect-video flex items-center justify-center">
            <video
              ref={videoRef}
              playsInline
              muted
              className="h-full w-full object-cover"
            />
            {mode === 'BARCODE' && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-10 top-1/2 -translate-y-1/2 h-24 rounded-[8px] border-2 border-primary bg-primary/10 flex items-center justify-center"
              >
                <div className="h-[2px] w-full bg-primary/80" />
              </div>
            )}
          </div>
        )}

        {mode === 'BARCODE' && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-muted">
            <span>ตัวถอดรหัสออฟไลน์ 1D/2D พร้อมสแกน — EAN-13, Code128, UPC, QR</span>
            {decodeFeedbackMsg && (
              <span role="status" className="text-xs font-medium text-primary-dark w-full mt-1">
                {decodeFeedbackMsg}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex flex-wrap justify-between gap-2.5 shrink-0">
        {mode === 'BARCODE' ? (
          <>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              aria-label="เลือกไฟล์รูปภาพบาร์โค้ดเพื่อสแกน"
              onChange={(e) => void handleScanImageFile(e)}
              className="hidden"
            />
            <button
              type="button"
              disabled={decodingImage}
              onClick={() => imageInputRef.current?.click()}
              className={`flex h-[44px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary ${UI_INTERACTION.focusButton}`}
            >
              <ImagePlus className="h-4 w-4" />
              <span>{decodingImage ? 'กำลังอ่านบาร์โค้ด...' : 'สแกนจากไฟล์รูปบาร์โค้ด'}</span>
            </button>
          </>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className={`h-[44px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-ink hover:border-ink ${UI_INTERACTION.focusButton}`}
          >
            ยกเลิก
          </button>
          {mode === 'PHOTO' && cameraReady && !cameraError && (
            <button
              type="button"
              onClick={handleCapturePhoto}
              className={`flex h-[44px] items-center gap-1.5 rounded-[48px] bg-primary px-6 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              <Camera className="h-4 w-4" />
              <span>ถ่ายภาพสินค้านี้</span>
            </button>
          )}
        </div>
      </div>
    </ModalDialog>
  );
};
