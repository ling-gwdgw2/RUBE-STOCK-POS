/**
 * RUBE-STOCK-POS v3.1 Physical Printer & RJ11 Cash Drawer Transport (`printer/transport.ts`)
 *
 * Provides real hardware I/O bindings for customer store terminals:
 * 1. LAN Network Thermal Printer over Raw TCP Socket (`Port 9100`)
 * 2. Windows USB Thermal Printer via Native `winspool.drv` (`RAW` datatype spooler)
 * 3. Installed Windows Printer Discovery (`Win32_Printer`)
 * 4. Standalone RJ11 Cash Drawer Kick (`ESC p 0 25 250`)
 * 5. Real 1-Bit Monochrome Raster Bitmap -> Chunked `GS v 0` Wire Packet Builder
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  encodeChunkedRasterGsV0,
  ESC_POS_CUT_PAPER_BYTES,
  ESC_POS_KICK_DRAWER_BYTES,
  type RenderedThaiAbbPrintJob,
} from './mod.ts';

const execFileAsync = promisify(execFile);

export type PrinterTransportMode =
  | 'SIMULATED_MEMORY'
  | 'LAN_TCP_9100'
  | 'WINDOWS_RAW_USB'
  | 'BROWSER_PRINT_DIALOG';

export interface PrinterHardwareConfig {
  mode: PrinterTransportMode;
  tcpHost: string;
  tcpPort: number;
  windowsPrinterName: string;
  paperWidthMm: 80 | 58;
  autoKickDrawerOnCash: boolean;
}

export interface DiscoveredWindowsPrinter {
  name: string;
  portName: string;
  isDefault: boolean;
  printerStatus: string;
}

export interface HardwareDispatchOutcome {
  dispatchedToHardware: boolean;
  transportMode: PrinterTransportMode;
  bytesWritten: number;
  errorMessage?: string | undefined;
}

/**
 * Converts a real 1-bit monochrome packed bitmap (rendered from an HTML5 `<canvas>` with shaped Thai fonts)
 * into chunked `GS v 0` bands (`<= 8 KB`), `ESC J` whitespace feeds, `ESC p` drawer kick, and `GS V` cut.
 */
export function buildEscPosWireJobFrom1BitBitmap(params: {
  packedMonochromeBitmap: Uint8Array;
  widthPx: 384 | 576;
  heightPx: number;
  kickCashDrawer: boolean;
  cutPaper?: boolean | undefined;
  formattedTextLines?: string[] | undefined;
}): RenderedThaiAbbPrintJob {
  const packets = encodeChunkedRasterGsV0(
    params.packedMonochromeBitmap,
    params.widthPx,
    params.heightPx,
    96
  );
  const maxPacketByteLength = packets.reduce(
    (max, p) => Math.max(max, p.rawBytes.byteLength),
    0
  );

  // Initialize printer (`ESC @` = 0x1B 0x40)
  const initBytes = new Uint8Array([0x1b, 0x40]);
  const chunks: Uint8Array[] = [initBytes];

  if (params.kickCashDrawer) {
    chunks.push(ESC_POS_KICK_DRAWER_BYTES);
  }
  for (const pkt of packets) {
    chunks.push(pkt.rawBytes);
  }
  // Feed 4 lines before partial paper cut so bottom line clears the blade
  const shouldCut = params.cutPaper !== false;
  if (shouldCut) {
    chunks.push(new Uint8Array([0x1b, 0x64, 0x04]));
    chunks.push(ESC_POS_CUT_PAPER_BYTES);
  }

  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const wirePayloadBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    wirePayloadBytes.set(c, offset);
    offset += c.byteLength;
  }

  return {
    formattedTextLines: params.formattedTextLines ?? [],
    widthPx: params.widthPx,
    totalHeightPx: params.heightPx,
    packets,
    maxPacketByteLength,
    kickDrawerCommandIncluded: params.kickCashDrawer,
    cutPaperCommandIncluded: shouldCut,
    wirePayloadBytes,
  };
}

/**
 * Streams raw ESC/POS bytes to a network thermal printer over TCP Port 9100.
 */
export function sendEscPosOverTcp9100(
  host: string,
  port: number,
  payload: Uint8Array,
  timeoutMs = 4_000
): Promise<{ bytesWritten: number; durationMs: number }> {
  const cleanHost = host.trim();
  if (!cleanHost) {
    return Promise.reject(new Error('TCP Printer IP/Host is empty'));
  }

  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      fail(new Error(`TCP Printer connection timed out (${cleanHost}:${port})`));
    });
    socket.once('error', (err) => {
      fail(new Error(`TCP Printer error (${cleanHost}:${port}): ${err.message}`));
    });

    socket.connect(port, cleanHost, () => {
      const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      socket.write(buf, (writeErr) => {
        if (writeErr) {
          fail(writeErr);
          return;
        }
        socket.end(() => {
          if (!settled) {
            settled = true;
            resolve({
              bytesWritten: buf.byteLength,
              durationMs: Date.now() - startedAt,
            });
          }
        });
      });
    });
  });
}

/**
 * Lists installed Windows printers (`Win32_Printer`) so technicians can pick the USB receipt printer from a dropdown.
 */
export async function listWindowsInstalledPrinters(): Promise<DiscoveredWindowsPrinter[]> {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const psScript =
      'Get-CimInstance Win32_Printer | Select-Object Name,PortName,Default,PrinterStatus | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 6_000, windowsHide: true }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as
      | Record<string, unknown>
      | Array<Record<string, unknown>>;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((p) => ({
      name: String(p.Name ?? ''),
      portName: String(p.PortName ?? ''),
      isDefault: Boolean(p.Default),
      printerStatus: String(p.PrinterStatus ?? 'Unknown'),
    }));
  } catch {
    return [];
  }
}

const WINSPOOL_RAW_CSHARP = `
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class RawWinSpoolSender {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFO di);

  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static int SendFile(string printerName, string filePath, string docName) {
    byte[] bytes = File.ReadAllBytes(filePath);
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
      throw new Exception("OpenPrinter failed for '" + printerName + "' (Win32=" + Marshal.GetLastWin32Error() + ")");
    }
    try {
      DOCINFO di = new DOCINFO { pDocName = docName, pDataType = "RAW" };
      if (StartDocPrinter(hPrinter, 1, di) == 0) {
        throw new Exception("StartDocPrinter RAW failed (Win32=" + Marshal.GetLastWin32Error() + ")");
      }
      try {
        StartPagePrinter(hPrinter);
        IntPtr unmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, unmanagedBytes, bytes.Length);
          int written = 0;
          if (!WritePrinter(hPrinter, unmanagedBytes, bytes.Length, out written)) {
            throw new Exception("WritePrinter failed (Win32=" + Marshal.GetLastWin32Error() + ")");
          }
          return written;
        } finally {
          Marshal.FreeCoTaskMem(unmanagedBytes);
          EndPagePrinter(hPrinter);
        }
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
`;

/**
 * Sends raw ESC/POS bytes (`GS v 0` raster bands + `ESC p` RJ11 drawer kick) directly to a Windows USB thermal printer
 * via `winspool.drv` (`pDataType = "RAW"`).
 */
export async function sendEscPosOverWindowsRawSpooler(
  printerName: string,
  payload: Uint8Array,
  docName = 'RUBE-STOCK-POS ESC/POS Job'
): Promise<{ bytesWritten: number }> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Raw USB Spooler is supported on Windows hosts only');
  }
  const cleanName = printerName.trim();
  if (!cleanName) {
    throw new Error('Windows Printer Name is required for WINDOWS_RAW_USB mode');
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `rube_escpos_${Date.now()}_${Math.floor(Math.random() * 100000)}.bin`
  );
  fs.writeFileSync(tmpFile, payload);

  try {
    const escapedPrinter = cleanName.replace(/'/g, "''");
    const escapedFile = tmpFile.replace(/'/g, "''");
    const escapedDoc = docName.replace(/'/g, "''");
    const psCommand = `
      Add-Type -TypeDefinition @'
${WINSPOOL_RAW_CSHARP}
'@
      $written = [RawWinSpoolSender]::SendFile('${escapedPrinter}', '${escapedFile}', '${escapedDoc}')
      Write-Output $written
    `;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { timeout: 10_000, windowsHide: true }
    );
    const bytesWritten = Number(stdout.trim()) || payload.byteLength;
    return { bytesWritten };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Dispatches an ESC/POS byte payload according to the configured transport mode.
 */
export async function dispatchEscPosPayloadToHardware(
  config: PrinterHardwareConfig,
  payload: Uint8Array,
  docName = 'RUBE-STOCK-POS Receipt'
): Promise<HardwareDispatchOutcome> {
  if (config.mode === 'SIMULATED_MEMORY' || config.mode === 'BROWSER_PRINT_DIALOG') {
    return {
      dispatchedToHardware: false,
      transportMode: config.mode,
      bytesWritten: payload.byteLength,
    };
  }

  if (config.mode === 'LAN_TCP_9100') {
    const res = await sendEscPosOverTcp9100(config.tcpHost, config.tcpPort, payload);
    return {
      dispatchedToHardware: true,
      transportMode: 'LAN_TCP_9100',
      bytesWritten: res.bytesWritten,
    };
  }

  const res = await sendEscPosOverWindowsRawSpooler(config.windowsPrinterName, payload, docName);
  return {
    dispatchedToHardware: true,
    transportMode: 'WINDOWS_RAW_USB',
    bytesWritten: res.bytesWritten,
  };
}
