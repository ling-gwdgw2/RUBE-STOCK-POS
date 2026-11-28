/**
 * Client-side HTML5 `<canvas>` Product Photo Compressor & Webcam Snapshot helper.
 * Produces crisp, lightweight JPEG data URLs (~25-55 KB at max 640px width)
 * suitable for offline local disk persistence and fast POS card rendering.
 */

import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import { pickLocaleText } from '../i18n/translations.ts';

const MAX_IMAGE_WIDTH = 640;
const MAX_IMAGE_HEIGHT = 480;
const JPEG_QUALITY = 0.84;

function computeScaledDimensions(srcW: number, srcH: number): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) {
    return { width: MAX_IMAGE_WIDTH, height: MAX_IMAGE_HEIGHT };
  }
  let width = srcW;
  let height = srcH;
  if (width > MAX_IMAGE_WIDTH) {
    height = Math.max(1, Math.round((height * MAX_IMAGE_WIDTH) / width));
    width = MAX_IMAGE_WIDTH;
  }
  if (height > MAX_IMAGE_HEIGHT) {
    width = Math.max(1, Math.round((width * MAX_IMAGE_HEIGHT) / height));
    height = MAX_IMAGE_HEIGHT;
  }
  return { width, height };
}

export async function compressImageFileToDataUrl(
  file: File,
  locale: LocaleCode = 'th'
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error(
      pickLocaleText(
        locale,
        'กรุณาเลือกไฟล์รูปภาพ (.jpg, .png, .webp) เท่านั้น',
        'ກະລຸນາເລືອກໄຟລ໌ຮູບພາບ (.jpg, .png, .webp) ເທົ່ານັ້ນ',
        'Please select a valid image file (.jpg, .png, .webp) only.'
      )
    );
  }

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
              'ไม่สามารถอ่านไฟล์รูปภาพนี้ได้',
              'ບໍ່ສາມາດອ່ານໄຟລ໌ຮູບພາບນີ້ໄດ້',
              'Unable to read the selected image file.'
            )
          )
        );
      el.src = objectUrl;
    });

    const { width, height } = computeScaledDimensions(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error(
        pickLocaleText(
          locale,
          'ไม่สามารถประมวลผลรูปภาพผ่าน Canvas ได้',
          'ບໍ່ສາມາດປະມວນຜົນຮູບພາບຜ່ານ Canvas ໄດ້',
          'Unable to process image on HTML5 Canvas.'
        )
      );
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function captureVideoFrameToDataUrl(
  video: HTMLVideoElement,
  locale: LocaleCode = 'th'
): string {
  const srcW = video.videoWidth || 640;
  const srcH = video.videoHeight || 480;
  const { width, height } = computeScaledDimensions(srcW, srcH);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(
      pickLocaleText(
        locale,
        'ไม่สามารถบันทึกภาพจากกล้องได้',
        'ບໍ່ສາມາດບັນທຶກພາບຈາກກ້ອງໄດ້',
        'Unable to capture video frame from camera.'
      )
    );
  }
  ctx.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
