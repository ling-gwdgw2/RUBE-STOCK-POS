/**
 * RUBE-STOCK-POS v3.1 Chunked 203-DPI Monochrome Raster Printer Driver (`PRINTER_HAL`)
 *
 * Solves:
 * 1. Floating Thai vowels/tone marks across all thermal printers by rendering 1-bit monochrome raster (`GS v 0`).
 * 2. 4KB/8KB receive buffer overflows on budget thermal printers by slicing the bitmap into horizontal bands
 *    of `maxBandHeightDots` (64–128 dots) and skipping pure-white bands via `ESC J n` paper feed commands.
 */

export const ESC_POS_KICK_DRAWER_BYTES = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);
export const ESC_POS_CUT_PAPER_BYTES = new Uint8Array([0x1d, 0x56, 0x42, 0x00]);

export interface RasterBandPacket {
  type: 'GS_V_0_RASTER_BAND' | 'ESC_J_WHITESPACE_FEED';
  yOffsetDots: number;
  heightDots: number;
  rawBytes: Uint8Array;
}

/**
 * Encodes a 1-bit packed monochrome bitmap into chunked `GS v 0` horizontal band commands (`64–128 px` per band)
 * and replaces pure-white horizontal regions with `ESC J n` (`0x1B 0x4A n`) feed commands.
 */
export function encodeChunkedRasterGsV0(
  packedMonochromeBitmap: Uint8Array,
  widthPx: 384 | 576,
  totalHeightPx: number,
  maxBandHeightDots: number = 96
): RasterBandPacket[] {
  const widthBytes = widthPx / 8;
  if (packedMonochromeBitmap.length !== widthBytes * totalHeightPx) {
    throw new Error(
      `Invalid bitmap buffer length: expected ${widthBytes * totalHeightPx}, got ${packedMonochromeBitmap.length}`
    );
  }

  const packets: RasterBandPacket[] = [];
  let y = 0;

  while (y < totalHeightPx) {
    // Check if the current row is completely white (all 0x00)
    const rowStart = y * widthBytes;
    let isWhiteRow = true;
    for (let b = 0; b < widthBytes; b++) {
      if (packedMonochromeBitmap[rowStart + b] !== 0) {
        isWhiteRow = false;
        break;
      }
    }

    if (isWhiteRow) {
      let whiteHeight = 1;
      while (y + whiteHeight < totalHeightPx && whiteHeight < 255) {
        const nextRowStart = (y + whiteHeight) * widthBytes;
        let nextWhite = true;
        for (let b = 0; b < widthBytes; b++) {
          if (packedMonochromeBitmap[nextRowStart + b] !== 0) {
            nextWhite = false;
            break;
          }
        }
        if (!nextWhite) break;
        whiteHeight++;
      }

      // If >= 16 consecutive white rows, emit compact `ESC J n` feed instead of sending hundreds of 0x00 bytes
      if (whiteHeight >= 16) {
        packets.push({
          type: 'ESC_J_WHITESPACE_FEED',
          yOffsetDots: y,
          heightDots: whiteHeight,
          rawBytes: new Uint8Array([0x1b, 0x4a, whiteHeight]),
        });
        y += whiteHeight;
        continue;
      }
    }

    const bandHeight = Math.min(maxBandHeightDots, totalHeightPx - y);
    const dataLength = widthBytes * bandHeight;
    // GS v 0 m xL xH yL yH d1...dk
    const header = new Uint8Array([
      0x1d,
      0x76,
      0x30,
      0x00,
      widthBytes & 0xff,
      (widthBytes >> 8) & 0xff,
      bandHeight & 0xff,
      (bandHeight >> 8) & 0xff,
    ]);

    const rawBytes = new Uint8Array(header.length + dataLength);
    rawBytes.set(header, 0);
    rawBytes.set(
      packedMonochromeBitmap.subarray(y * widthBytes, (y + bandHeight) * widthBytes),
      header.length
    );

    packets.push({
      type: 'GS_V_0_RASTER_BAND',
      yOffsetDots: y,
      heightDots: bandHeight,
      rawBytes,
    });

    y += bandHeight;
  }

  return packets;
}

