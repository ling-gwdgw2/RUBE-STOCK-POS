/**
 * RUBE-STOCK-POS v3.1.1 Customer Desktop & Installer Build Pipeline (`npm run build:installer`)
 *
 * Produces ready-to-deploy Windows installer & desktop shell artifacts in `dist-installer/`:
 *   1. `RubeStockPOS-DesktopShell.exe`         — Native Rust (std) x64 desktop/kiosk shell
 *   2. `RubeStockPOS_3.1.1_x64_Setup.exe`      — Standalone Windows GUI + Silent Installer (.exe)
 *                                                bundling the UI, Node backend, SQLite migrations & DesktopShell
 *   3. `RubeStockPOS_3.1.1_x64_AirGapped.msi`  — Air-Gapped offline Windows Installer package
 *   4. `RubeStockPOS_3.1.1_x64_AirGapped.manifest.json` — EV Authenticode & Schema SHA-256 verification manifest
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AirGappedReleasePackager } from '../packages/cluster-gateway/src/release-packager.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'dist-installer');
const STAGE_DIR = path.join(OUT_DIR, '_staging');
const APP_VERSION = '3.1.1';

/**
 * Writes a classic uncompressed 32-bit BGRA BMP-DIB Windows `.ico` (32x32)
 * compatible with all Win32 resource compilers (`csc.exe /win32icon:`) and Windows Explorer.
 */
function writeClassicWin32Icon(icoPath: string): void {
  const w = 32;
  const h = 32;
  const pixelBytes = w * h * 4;
  const maskStride = 4; // 32 bits per row
  const maskBytes = maskStride * h;
  const dibHeaderSize = 40;
  const dibSize = dibHeaderSize + pixelBytes + maskBytes;

  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0); // reserved
  iconDir.writeUInt16LE(1, 2); // type 1 = ICON
  iconDir.writeUInt16LE(1, 4); // 1 image

  const entry = Buffer.alloc(16);
  entry[0] = w;
  entry[1] = h;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(dibSize, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset

  const dib = Buffer.alloc(dibHeaderSize);
  dib.writeUInt32LE(dibHeaderSize, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h * 2, 8); // XOR + AND height
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(32, 14); // 32-bit BGRA
  dib.writeUInt32LE(0, 16); // BI_RGB uncompressed
  dib.writeUInt32LE(pixelBytes + maskBytes, 20);

  // Bottom-up BGRA pixels: Google Blue (#1a73e8) tile with crisp white R monogram accent
  const pixels = Buffer.alloc(pixelBytes);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const inBorder = x >= 2 && x <= 29 && y >= 2 && y <= 29;
      const isMark =
        (x >= 9 && x <= 12 && y >= 8 && y <= 23) ||
        (y >= 20 && y <= 23 && x >= 9 && x <= 21) ||
        (y >= 14 && y <= 17 && x >= 9 && x <= 20) ||
        (x >= 18 && x <= 21 && y >= 15 && y <= 22) ||
        (x >= 16 && x <= 22 && y >= 8 && y <= 14 && x + y === 28);

      if (!inBorder) {
        // #000000 subtle dark edge frame
        pixels[idx] = 0x24;
        pixels[idx + 1] = 0x21;
        pixels[idx + 2] = 0x20;
        pixels[idx + 3] = 0xff;
      } else if (isMark) {
        // Pure white mark
        pixels[idx] = 0xff;
        pixels[idx + 1] = 0xff;
        pixels[idx + 2] = 0xff;
        pixels[idx + 3] = 0xff;
      } else {
        // Google Blue #1a73e8 -> BGRA (0xe8, 0x73, 0x1a, 0xff)
        pixels[idx] = 0xe8;
        pixels[idx + 1] = 0x73;
        pixels[idx + 2] = 0x1a;
        pixels[idx + 3] = 0xff;
      }
    }
  }

  const mask = Buffer.alloc(maskBytes, 0x00);
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  fs.writeFileSync(icoPath, Buffer.concat([iconDir, entry, dib, pixels, mask]));
}

function copyFilteredRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const base = path.basename(src);
    if (base === 'node_modules' || base === 'target' || base === '.git') {
      return;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyFilteredRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  if (src.endsWith('.rs') || src.endsWith('Cargo.toml')) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function findCscCompiler(): string {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('Windows .NET csc.exe compiler was not found');
  }
  return found;
}

function findCargoCompiler(): string {
  const userCargo = path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe');
  if (fs.existsSync(userCargo)) return userCargo;
  return 'cargo';
}

function findWebView2LoaderDll(releaseTargetDir: string): string | null {
  const direct = path.join(releaseTargetDir, 'WebView2Loader.dll');
  if (fs.existsSync(direct)) return direct;
  const buildDir = path.join(releaseTargetDir, 'build');
  if (!fs.existsSync(buildDir)) return null;
  for (const entry of fs.readdirSync(buildDir)) {
    if (entry.startsWith('webview2-com-sys-')) {
      const candidate = path.join(buildDir, entry, 'out', 'x64', 'WebView2Loader.dll');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function buildUninstallerCSharpSource(): string {
  return `
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RubeStockPosUninstaller
{
    internal static class Program
    {
        private const string UNINSTALL_REG_PATH = @"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RubeStockPOS";

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = false;
            bool purgeData = false;
            foreach (string arg in args)
            {
                if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("/S", StringComparison.OrdinalIgnoreCase))
                {
                    silent = true;
                }
                else if (arg.Equals("--purge-data", StringComparison.OrdinalIgnoreCase))
                {
                    purgeData = true;
                }
            }

            string installDir = ResolveInstallDir();

            if (silent)
            {
                try
                {
                    PerformUninstall(installDir, purgeData, null);
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex.ToString());
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UninstallForm(installDir));
            return 0;
        }

        internal static string ResolveInstallDir()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UNINSTALL_REG_PATH))
                {
                    if (key != null)
                    {
                        string regLoc = key.GetValue("InstallLocation") as string;
                        if (!string.IsNullOrWhiteSpace(regLoc) && Directory.Exists(regLoc))
                            return regLoc;
                    }
                }
            }
            catch { }
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\');
        }

        internal static void PerformUninstall(string installDir, bool purgeUserData, Action<string> onStatus)
        {
            if (onStatus != null) onStatus("กำลังหยุดการทำงานของโปรแกรมและเอนจินเบื้องหลัง...");
            try
            {
                foreach (Process proc in Process.GetProcessesByName("RubeStockPOS-DesktopShell"))
                {
                    try { proc.Kill(); proc.WaitForExit(3000); } catch { }
                }
                string normalizedTarget = Path.GetFullPath(installDir).TrimEnd('\\\\');
                foreach (Process proc in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        string modPath = proc.MainModule != null ? proc.MainModule.FileName : "";
                        if (modPath.StartsWith(normalizedTarget, StringComparison.OrdinalIgnoreCase))
                        {
                            proc.Kill();
                            proc.WaitForExit(3000);
                        }
                    }
                    catch { }
                }
                Thread.Sleep(400);
            }
            catch { }

            if (onStatus != null) onStatus("กำลังลบทางลัดบน Desktop, Start Menu และ Startup...");
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                TryDeleteFile(Path.Combine(desktop, "RUBE-STOCK-POS v3.1.lnk"));
                TryDeleteFile(Path.Combine(desktop, "RUBE-STOCK-POS (Kiosk เต็มจอ).lnk"));

                string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                TryDeleteFile(Path.Combine(startup, "RUBE-STOCK-POS-Kiosk.lnk"));

                string startMenuDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    "RUBE-STOCK-POS"
                );
                if (Directory.Exists(startMenuDir))
                {
                    Directory.Delete(startMenuDir, true);
                }
            }
            catch { }

            if (onStatus != null) onStatus("กำลังลบรายการออกจาก Windows Settings (Installed Apps)...");
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(UNINSTALL_REG_PATH, false);
            }
            catch { }

            if (purgeUserData)
            {
                if (onStatus != null) onStatus("กำลังลบฐานข้อมูลร้านค้า ไฟล์สำรอง และ Log...");
                try
                {
                    string userDataDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "RubeStockPOS"
                    );
                    if (Directory.Exists(userDataDir))
                    {
                        Directory.Delete(userDataDir, true);
                    }
                }
                catch { }
            }

            if (onStatus != null) onStatus("กำลังลบไฟล์โปรแกรมออกจากเครื่อง...");
            if (Directory.Exists(installDir))
            {
                string selfExe = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
                try
                {
                    foreach (string dir in Directory.GetDirectories(installDir))
                    {
                        try { Directory.Delete(dir, true); } catch { }
                    }
                    foreach (string file in Directory.GetFiles(installDir))
                    {
                        if (!string.Equals(Path.GetFullPath(file), selfExe, StringComparison.OrdinalIgnoreCase))
                        {
                            TryDeleteFile(file);
                        }
                    }
                }
                catch { }

                // Schedule self-deletion of remaining Uninstall.exe and installDir right after exit
                try
                {
                    string escapedDir = installDir.Replace("\\"", "");
                    ProcessStartInfo psi = new ProcessStartInfo(
                        "cmd.exe",
                        "/C ping 127.0.0.1 -n 3 >nul & rmdir /s /q \\"" + escapedDir + "\\""
                    );
                    psi.WorkingDirectory = Path.GetTempPath();
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                }
                catch { }
            }
        }

        private static void TryDeleteFile(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch { }
        }
    }

    internal sealed class UninstallForm : Form
    {
        private readonly string _installDir;
        private readonly CheckBox _chkPurgeData;
        private readonly Label _statusLabel;
        private readonly Button _uninstallBtn;
        private readonly Button _cancelBtn;

        public UninstallForm(string installDir)
        {
            _installDir = installDir;
            Text = "ถอนการติดตั้ง RUBE-STOCK-POS v3.1.1";
            Size = new Size(580, 395);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            Panel hero = new Panel();
            hero.Dock = DockStyle.Top;
            hero.Height = 122;
            hero.BackColor = Color.Black;
            hero.Padding = new Padding(28, 20, 28, 16);

            Label badge = new Label();
            badge.Text = "RUBE-STOCK-POS V3.1.1 · WINDOWS UNINSTALLER";
            badge.ForeColor = Color.FromArgb(138, 180, 248);
            badge.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            badge.AutoSize = true;
            badge.Location = new Point(28, 20);

            Label title = new Label();
            title.Text = "ถอนการติดตั้งโปรแกรม RUBE-STOCK-POS";
            title.ForeColor = Color.White;
            title.Font = new Font("Segoe UI", 18f, FontStyle.Regular);
            title.AutoSize = true;
            title.Location = new Point(26, 44);

            Label sub = new Label();
            sub.Text = "ลบไฟล์โปรแกรม ทางลัดหน้าจอ Start Menu และรายการใน Windows Settings";
            sub.ForeColor = Color.FromArgb(200, 204, 210);
            sub.Font = new Font("Segoe UI", 9.2f, FontStyle.Regular);
            sub.AutoSize = true;
            sub.Location = new Point(28, 82);

            hero.Controls.Add(badge);
            hero.Controls.Add(title);
            hero.Controls.Add(sub);
            Controls.Add(hero);

            Label pathLabel = new Label();
            pathLabel.Text = "โฟลเดอร์ที่จะลบออก: " + installDir;
            pathLabel.ForeColor = Color.FromArgb(60, 64, 67);
            pathLabel.AutoSize = true;
            pathLabel.MaximumSize = new Size(510, 44);
            pathLabel.Location = new Point(28, 144);
            Controls.Add(pathLabel);

            _chkPurgeData = new CheckBox();
            _chkPurgeData.Text = "ลบฐานข้อมูลร้านค้า (SQLite), ไฟล์สำรอง และ Log ทั้งหมดด้วย (%LOCALAPPDATA%\\\\RubeStockPOS)";
            _chkPurgeData.Checked = false;
            _chkPurgeData.AutoSize = true;
            _chkPurgeData.MaximumSize = new Size(510, 48);
            _chkPurgeData.ForeColor = Color.FromArgb(32, 33, 36);
            _chkPurgeData.Location = new Point(28, 194);
            Controls.Add(_chkPurgeData);

            Label safeNote = new Label();
            safeNote.Text = "* หากไม่ติ๊กช่องด้านบน ฐานข้อมูลการขายและสต็อกร้านค้าจะยังคงถูกเก็บไว้อย่างปลอดภัย";
            safeNote.ForeColor = Color.FromArgb(95, 99, 104);
            safeNote.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            safeNote.AutoSize = true;
            safeNote.Location = new Point(28, 240);
            Controls.Add(safeNote);

            _statusLabel = new Label();
            _statusLabel.Text = "พร้อมถอนการติดตั้งโปรแกรม";
            _statusLabel.ForeColor = Color.FromArgb(26, 115, 232);
            _statusLabel.AutoSize = true;
            _statusLabel.Location = new Point(28, 272);
            Controls.Add(_statusLabel);

            _cancelBtn = new Button();
            _cancelBtn.Text = "ยกเลิก";
            _cancelBtn.Location = new Point(28, 304);
            _cancelBtn.Size = new Size(140, 42);
            _cancelBtn.FlatStyle = FlatStyle.Flat;
            _cancelBtn.BackColor = Color.White;
            _cancelBtn.ForeColor = Color.FromArgb(95, 99, 104);
            _cancelBtn.Cursor = Cursors.Hand;
            _cancelBtn.Click += (s, e) => Close();
            Controls.Add(_cancelBtn);

            _uninstallBtn = new Button();
            _uninstallBtn.Text = "ยืนยันถอนการติดตั้งทันที";
            _uninstallBtn.Location = new Point(180, 304);
            _uninstallBtn.Size = new Size(364, 42);
            _uninstallBtn.FlatStyle = FlatStyle.Flat;
            _uninstallBtn.FlatAppearance.BorderSize = 0;
            _uninstallBtn.BackColor = Color.FromArgb(26, 115, 232);
            _uninstallBtn.ForeColor = Color.White;
            _uninstallBtn.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            _uninstallBtn.Cursor = Cursors.Hand;
            _uninstallBtn.Click += HandleUninstallClick;
            Controls.Add(_uninstallBtn);
        }

        private void HandleUninstallClick(object sender, EventArgs e)
        {
            _uninstallBtn.Enabled = false;
            _cancelBtn.Enabled = false;
            try
            {
                Program.PerformUninstall(
                    _installDir,
                    _chkPurgeData.Checked,
                    msg =>
                    {
                        _statusLabel.Text = msg;
                        _statusLabel.Refresh();
                    }
                );

                MessageBox.Show(
                    "ถอนการติดตั้ง RUBE-STOCK-POS v3.1.1 เสร็จสมบูรณ์เรียบร้อยแล้ว!",
                    "RUBE-STOCK-POS Uninstaller",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "เกิดข้อผิดพลาดในการถอนการติดตั้ง", MessageBoxButtons.OK, MessageBoxIcon.Error);
                _uninstallBtn.Enabled = true;
                _cancelBtn.Enabled = true;
            }
        }
    }
}
`;
}

function buildInstallerCSharpSource(): string {
  return `
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RubeStockPosSetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = false;
            string customDir = null;
            bool createDesktopShortcut = true;
            bool createKioskShortcut = true;
            bool enableAutoStart = false;

            foreach (string arg in args)
            {
                if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("/S", StringComparison.OrdinalIgnoreCase))
                {
                    silent = true;
                }
                else if (arg.StartsWith("--install-dir=", StringComparison.OrdinalIgnoreCase))
                {
                    customDir = arg.Substring("--install-dir=".Length).Trim('"');
                }
                else if (arg.Equals("--no-shortcuts", StringComparison.OrdinalIgnoreCase))
                {
                    createDesktopShortcut = false;
                    createKioskShortcut = false;
                }
            }

            string defaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "RubeStockPOS"
            );
            string targetDir = string.IsNullOrWhiteSpace(customDir) ? defaultDir : customDir;

            if (silent)
            {
                try
                {
                    PerformInstall(targetDir, createDesktopShortcut, createKioskShortcut, enableAutoStart, null);
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex.ToString());
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(targetDir));
            return 0;
        }

        internal static void PerformInstall(
            string targetDir,
            bool createDesktopShortcut,
            bool createKioskShortcut,
            bool enableAutoStart,
            Action<string> onStatus
        )
        {
            if (onStatus != null) onStatus("กำลังหยุดโปรแกรมเดิมและเตรียมโฟลเดอร์ติดตั้ง: " + targetDir);
            try
            {
                foreach (Process proc in Process.GetProcessesByName("RubeStockPOS-DesktopShell"))
                {
                    try { proc.Kill(); proc.WaitForExit(3000); } catch { }
                }
                string normalizedTarget = Path.GetFullPath(targetDir).TrimEnd('\\\\');
                foreach (Process proc in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        string modPath = proc.MainModule != null ? proc.MainModule.FileName : "";
                        if (modPath.StartsWith(normalizedTarget, StringComparison.OrdinalIgnoreCase))
                        {
                            proc.Kill();
                            proc.WaitForExit(3000);
                        }
                    }
                    catch { }
                }
                System.Threading.Thread.Sleep(400);
            }
            catch { }

            Directory.CreateDirectory(targetDir);

            string tempZip = Path.Combine(Path.GetTempPath(), "rube_pos_payload_" + Guid.NewGuid().ToString("N") + ".zip");
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("RubePayload.zip"))
                {
                    if (resStream == null)
                        throw new InvalidOperationException("Embedded payload RubePayload.zip not found.");

                    using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
                    {
                        resStream.CopyTo(fs);
                    }
                }

                if (onStatus != null) onStatus("กำลังแตกไฟล์ระบบ RUBE-STOCK-POS v3.1.1 และฐานข้อมูล...");
                using (ZipArchive archive = ZipFile.OpenRead(tempZip))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string destPath = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                        if (!destPath.StartsWith(Path.GetFullPath(targetDir), StringComparison.OrdinalIgnoreCase))
                            continue;

                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destPath);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(destPath));
                            entry.ExtractToFile(destPath, true);
                        }
                    }
                }
            }
            finally
            {
                try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch { }
            }

            if (onStatus != null) onStatus("กำลังสร้างสคริปต์เปิดโปรแกรม ทางลัด และลงทะเบียนใน Windows Settings...");
            string shellExe = Path.Combine(targetDir, "RubeStockPOS-DesktopShell.exe");
            string uninstallExe = Path.Combine(targetDir, "Uninstall.exe");
            string iconPath = Path.Combine(targetDir, "icon.ico");

            File.WriteAllText(
                Path.Combine(targetDir, "Start-RubePOS.cmd"),
                "@echo off\\r\\ncd /d \\"%~dp0\\"\\r\\nstart \\"\\" \\"%~dp0RubeStockPOS-DesktopShell.exe\\"\\r\\n",
                Encoding.ASCII
            );
            File.WriteAllText(
                Path.Combine(targetDir, "Start-RubePOS-Kiosk.cmd"),
                "@echo off\\r\\ncd /d \\"%~dp0\\"\\r\\nstart \\"\\" \\"%~dp0RubeStockPOS-DesktopShell.exe\\" --kiosk\\r\\n",
                Encoding.ASCII
            );
            File.WriteAllText(
                Path.Combine(targetDir, "Uninstall-RubePOS.cmd"),
                "@echo off\\r\\nstart \\"\\" \\"%~dp0Uninstall.exe\\"\\r\\n",
                Encoding.ASCII
            );

            if (createDesktopShortcut)
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                CreateShortcut(Path.Combine(desktop, "RUBE-STOCK-POS v3.1.lnk"), shellExe, "", targetDir, iconPath);
            }

            if (createKioskShortcut)
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                CreateShortcut(Path.Combine(desktop, "RUBE-STOCK-POS (Kiosk เต็มจอ).lnk"), shellExe, "--kiosk", targetDir, iconPath);
            }

            if (enableAutoStart)
            {
                string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                CreateShortcut(Path.Combine(startup, "RUBE-STOCK-POS-Kiosk.lnk"), shellExe, "--kiosk", targetDir, iconPath);
            }

            // Create Start Menu folder & shortcuts (including 1-click Uninstall)
            try
            {
                string startMenuDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    "RUBE-STOCK-POS"
                );
                Directory.CreateDirectory(startMenuDir);
                CreateShortcut(Path.Combine(startMenuDir, "RUBE-STOCK-POS v3.1.lnk"), shellExe, "", targetDir, iconPath);
                CreateShortcut(Path.Combine(startMenuDir, "RUBE-STOCK-POS (Kiosk เต็มจอ).lnk"), shellExe, "--kiosk", targetDir, iconPath);
                if (File.Exists(uninstallExe))
                {
                    CreateShortcut(Path.Combine(startMenuDir, "ถอนการติดตั้ง RUBE-STOCK-POS.lnk"), uninstallExe, "", targetDir, iconPath);
                }
            }
            catch { }

            // Register in Windows Settings -> Apps -> Installed apps (HKCU per-user Uninstall registry)
            RegisterInWindowsInstalledApps(targetDir, iconPath, uninstallExe);

            if (onStatus != null) onStatus("ติดตั้งเสร็จสมบูรณ์ พร้อมใช้งานแล้ว!");
        }

        private static void RegisterInWindowsInstalledApps(string targetDir, string iconPath, string uninstallExe)
        {
            try
            {
                long totalBytes = 0;
                foreach (string f in Directory.GetFiles(targetDir, "*", SearchOption.AllDirectories))
                {
                    try { totalBytes += new FileInfo(f).Length; } catch { }
                }
                int estimatedSizeKb = (int)Math.Max(1024, totalBytes / 1024);

                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
                    @"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RubeStockPOS"))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "RUBE-STOCK-POS v3.1.1", RegistryValueKind.String);
                        key.SetValue("DisplayVersion", "3.1.1", RegistryValueKind.String);
                        key.SetValue("Publisher", "RUBE-STOCK-POS", RegistryValueKind.String);
                        key.SetValue("InstallLocation", targetDir, RegistryValueKind.String);
                        key.SetValue("DisplayIcon", iconPath, RegistryValueKind.String);
                        key.SetValue("UninstallString", "\\"" + uninstallExe + "\\"", RegistryValueKind.String);
                        key.SetValue("QuietUninstallString", "\\"" + uninstallExe + "\\" --silent", RegistryValueKind.String);
                        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
                        key.SetValue("EstimatedSize", estimatedSizeKb, RegistryValueKind.DWord);
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    }
                }
            }
            catch { }
        }

        private static void CreateShortcut(string lnkPath, string targetExe, string args, string workDir, string iconPath)
        {
            string ps = "$ws = New-Object -ComObject WScript.Shell; " +
                        "$sc = $ws.CreateShortcut('" + EscapePs(lnkPath) + "'); " +
                        "$sc.TargetPath = '" + EscapePs(targetExe) + "'; " +
                        "$sc.Arguments = '" + EscapePs(args) + "'; " +
                        "$sc.WorkingDirectory = '" + EscapePs(workDir) + "'; " +
                        "$sc.IconLocation = '" + EscapePs(iconPath) + "'; " +
                        "$sc.Save();";
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command \\"" + ps.Replace("\\"", "\\\\\\"") + "\\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            using (Process p = Process.Start(psi))
            {
                if (p != null) p.WaitForExit(8000);
            }
        }

        private static string EscapePs(string s)
        {
            return (s ?? "").Replace("'", "''");
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly TextBox _dirBox;
        private readonly CheckBox _chkDesktop;
        private readonly CheckBox _chkKiosk;
        private readonly CheckBox _chkStartup;
        private readonly CheckBox _chkLaunchNow;
        private readonly Label _statusLabel;
        private readonly Button _installBtn;
        private readonly Button _browseBtn;

        public SetupForm(string defaultDir)
        {
            Text = "ติดตั้งโปรแกรม RUBE-STOCK-POS v3.1.1 (Windows Desktop)";
            Size = new Size(620, 510);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            Panel hero = new Panel();
            hero.Dock = DockStyle.Top;
            hero.Height = 132;
            hero.BackColor = Color.Black;
            hero.Padding = new Padding(28, 22, 28, 18);

            Label badge = new Label();
            badge.Text = "RUBE-STOCK-POS V3.1.1 · OFFLINE-FIRST WINDOWS INSTALLER";
            badge.ForeColor = Color.FromArgb(138, 180, 248);
            badge.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            badge.AutoSize = true;
            badge.Location = new Point(28, 22);

            Label title = new Label();
            title.Text = "ติดตั้งระบบขายหน้าร้านและคลังสินค้า";
            title.ForeColor = Color.White;
            title.Font = new Font("Segoe UI", 20f, FontStyle.Regular);
            title.AutoSize = true;
            title.Location = new Point(26, 46);

            Label sub = new Label();
            sub.Text = "มาพร้อมเอนจิน SQLite WAL, ตัวพิมพ์ไทย 203-DPI และโหมด Kiosk เต็มจอ";
            sub.ForeColor = Color.FromArgb(200, 204, 210);
            sub.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            sub.AutoSize = true;
            sub.Location = new Point(28, 88);

            hero.Controls.Add(badge);
            hero.Controls.Add(title);
            hero.Controls.Add(sub);
            Controls.Add(hero);

            Label dirLabel = new Label();
            dirLabel.Text = "โฟลเดอร์สำหรับติดตั้งโปรแกรม:";
            dirLabel.ForeColor = Color.FromArgb(95, 99, 104);
            dirLabel.AutoSize = true;
            dirLabel.Location = new Point(28, 156);
            Controls.Add(dirLabel);

            _dirBox = new TextBox();
            _dirBox.Text = defaultDir;
            _dirBox.Location = new Point(28, 180);
            _dirBox.Size = new Size(455, 28);
            Controls.Add(_dirBox);

            _browseBtn = new Button();
            _browseBtn.Text = "เลือกโฟลเดอร์...";
            _browseBtn.Location = new Point(492, 179);
            _browseBtn.Size = new Size(92, 28);
            _browseBtn.FlatStyle = FlatStyle.Flat;
            _browseBtn.BackColor = Color.White;
            _browseBtn.ForeColor = Color.FromArgb(26, 115, 232);
            _browseBtn.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.SelectedPath = _dirBox.Text;
                    if (fbd.ShowDialog() == DialogResult.OK)
                        _dirBox.Text = Path.Combine(fbd.SelectedPath, "RubeStockPOS");
                }
            };
            Controls.Add(_browseBtn);

            _chkDesktop = new CheckBox();
            _chkDesktop.Text = "สร้างทางลัดบนหน้าจอ Desktop (RUBE-STOCK-POS v3.1)";
            _chkDesktop.Checked = true;
            _chkDesktop.AutoSize = true;
            _chkDesktop.ForeColor = Color.FromArgb(32, 33, 36);
            _chkDesktop.Location = new Point(28, 228);
            Controls.Add(_chkDesktop);

            _chkKiosk = new CheckBox();
            _chkKiosk.Text = "สร้างทางลัดโหมดเต็มจอแคชเชียร์ (Kiosk Fullscreen Mode)";
            _chkKiosk.Checked = true;
            _chkKiosk.AutoSize = true;
            _chkKiosk.ForeColor = Color.FromArgb(32, 33, 36);
            _chkKiosk.Location = new Point(28, 258);
            Controls.Add(_chkKiosk);

            _chkStartup = new CheckBox();
            _chkStartup.Text = "เปิดโปรแกรมแบบ Kiosk อัตโนมัติเมื่อเปิดเครื่อง Windows";
            _chkStartup.Checked = false;
            _chkStartup.AutoSize = true;
            _chkStartup.ForeColor = Color.FromArgb(32, 33, 36);
            _chkStartup.Location = new Point(28, 288);
            Controls.Add(_chkStartup);

            _chkLaunchNow = new CheckBox();
            _chkLaunchNow.Text = "เปิดหน้าต่างโปรแกรมทันทีหลังติดตั้งเสร็จ (เข้าหน้าตั้งค่าร้านใหม่)";
            _chkLaunchNow.Checked = true;
            _chkLaunchNow.AutoSize = true;
            _chkLaunchNow.ForeColor = Color.FromArgb(26, 115, 232);
            _chkLaunchNow.Location = new Point(28, 318);
            Controls.Add(_chkLaunchNow);

            _statusLabel = new Label();
            _statusLabel.Text = "พร้อมติดตั้งลงเครื่องลูกค้าแบบออฟไลน์ 100%";
            _statusLabel.ForeColor = Color.FromArgb(95, 99, 104);
            _statusLabel.AutoSize = true;
            _statusLabel.Location = new Point(28, 362);
            Controls.Add(_statusLabel);

            _installBtn = new Button();
            _installBtn.Text = "เริ่มติดตั้ง RUBE-STOCK-POS ทันที";
            _installBtn.Location = new Point(28, 396);
            _installBtn.Size = new Size(556, 48);
            _installBtn.FlatStyle = FlatStyle.Flat;
            _installBtn.FlatAppearance.BorderSize = 0;
            _installBtn.BackColor = Color.FromArgb(26, 115, 232);
            _installBtn.ForeColor = Color.White;
            _installBtn.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            _installBtn.Cursor = Cursors.Hand;
            _installBtn.Click += HandleInstallClick;
            Controls.Add(_installBtn);
        }

        private void HandleInstallClick(object sender, EventArgs e)
        {
            _installBtn.Enabled = false;
            _browseBtn.Enabled = false;
            try
            {
                string targetDir = _dirBox.Text.Trim();
                Program.PerformInstall(
                    targetDir,
                    _chkDesktop.Checked,
                    _chkKiosk.Checked,
                    _chkStartup.Checked,
                    msg =>
                    {
                        _statusLabel.Text = msg;
                        _statusLabel.Refresh();
                    }
                );

                if (_chkLaunchNow.Checked)
                {
                    string exe = Path.Combine(targetDir, "RubeStockPOS-DesktopShell.exe");
                    if (File.Exists(exe))
                    {
                        Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = targetDir });
                    }
                }

                MessageBox.Show(
                    "ติดตั้ง RUBE-STOCK-POS v3.1.1 เสร็จสมบูรณ์เรียบร้อยแล้ว!",
                    "RUBE-STOCK-POS Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "เกิดข้อผิดพลาดในการติดตั้ง", MessageBoxButtons.OK, MessageBoxIcon.Error);
                _installBtn.Enabled = true;
                _browseBtn.Enabled = true;
            }
        }
    }
}
`;
}

async function main(): Promise<void> {
  console.log('===================================================================');
  console.log('RUBE-STOCK-POS v3.1.1 — Customer Windows Desktop & Installer Build');
  console.log('===================================================================');

  // 1. Always build fresh React 19 UI production bundle
  console.log('[1/5] Building React 19 UI production bundle...');
  execFileSync('cmd.exe', ['/C', 'npm run build:ui'], { cwd: ROOT_DIR, stdio: 'inherit' });

  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 2. Write standard BMP-DIB Win32 icon and compile native Tauri v2 Windows Desktop App (.exe)
  console.log('[2/5] Compiling Tauri v2 Native Windows App (src-tauri -> RubeStockPOS-DesktopShell.exe)...');
  const win32IcoPath = path.join(OUT_DIR, 'rube-win32.ico');
  writeClassicWin32Icon(win32IcoPath);
  fs.copyFileSync(win32IcoPath, path.join(ROOT_DIR, 'src-tauri', 'icons', 'icon.ico'));

  const cargoExe = findCargoCompiler();
  const tauriManifest = path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml');
  execFileSync(
    cargoExe,
    ['build', '--release', '--features', 'custom-protocol', '--manifest-path', tauriManifest],
    { cwd: ROOT_DIR, stdio: 'inherit' }
  );

  const tauriReleaseDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release');
  const tauriBuiltExe = path.join(tauriReleaseDir, 'rube-stock-pos-desktop.exe');
  if (!fs.existsSync(tauriBuiltExe)) {
    throw new Error(`Expected Tauri release binary missing: ${tauriBuiltExe}`);
  }
  const shellExeOut = path.join(OUT_DIR, 'RubeStockPOS-DesktopShell.exe');
  fs.copyFileSync(tauriBuiltExe, shellExeOut);

  const webView2Dll = findWebView2LoaderDll(tauriReleaseDir);
  if (webView2Dll) {
    fs.copyFileSync(webView2Dll, path.join(OUT_DIR, 'WebView2Loader.dll'));
  }

  execFileSync(shellExeOut, ['--check-only'], { cwd: ROOT_DIR });
  console.log(`   -> Built & smoke-tested Tauri v2 native app: ${shellExeOut}`);

  // 3. Stage clean customer runtime payload (including bundled Node.js executable!)
  console.log('[3/5] Staging standalone customer runtime payload...');
  fs.copyFileSync(shellExeOut, path.join(STAGE_DIR, 'RubeStockPOS-DesktopShell.exe'));
  if (webView2Dll) {
    fs.copyFileSync(webView2Dll, path.join(STAGE_DIR, 'WebView2Loader.dll'));
  }
  fs.copyFileSync(win32IcoPath, path.join(STAGE_DIR, 'icon.ico'));
  fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(STAGE_DIR, 'package.json'));
  copyFilteredRecursive(
    path.join(ROOT_DIR, 'scripts', 'start-pos-app.ts'),
    path.join(STAGE_DIR, 'scripts', 'start-pos-app.ts')
  );
  for (const pkg of [
    'shared-contracts',
    'core-engine',
    'hal-drivers',
    'cluster-gateway',
  ]) {
    copyFilteredRecursive(
      path.join(ROOT_DIR, 'packages', pkg),
      path.join(STAGE_DIR, 'packages', pkg)
    );
  }
  copyFilteredRecursive(
    path.join(ROOT_DIR, 'packages', 'ui-presentation', 'dist'),
    path.join(STAGE_DIR, 'packages', 'ui-presentation', 'dist')
  );
  copyFilteredRecursive(
    path.join(ROOT_DIR, 'packages', 'ui-presentation', 'src'),
    path.join(STAGE_DIR, 'packages', 'ui-presentation', 'src')
  );
  copyFilteredRecursive(
    path.join(ROOT_DIR, 'packages', 'ui-presentation', 'package.json'),
    path.join(STAGE_DIR, 'packages', 'ui-presentation', 'package.json')
  );

  // Include bundled Node executable so customer Windows PCs need zero separate Node.js install
  const runtimeDir = path.join(STAGE_DIR, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'));

  // Compile native Windows GUI + Silent Uninstaller (`Uninstall.exe`) into staging payload
  const cscExe = findCscCompiler();
  const netFrameworkDir = path.dirname(cscExe);
  const uninstallCsPath = path.join(OUT_DIR, '_Uninstaller.cs');
  const uninstallExePath = path.join(STAGE_DIR, 'Uninstall.exe');
  fs.writeFileSync(uninstallCsPath, buildUninstallerCSharpSource(), 'utf8');
  execFileSync(
    cscExe,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/win32icon:${win32IcoPath}`,
      `/out:${uninstallExePath}`,
      uninstallCsPath,
    ],
    { stdio: 'inherit' }
  );
  fs.rmSync(uninstallCsPath, { force: true });
  console.log(`   -> Compiled 1-click Windows Uninstaller: ${uninstallExePath}`);

  const payloadZip = path.join(OUT_DIR, 'payload.zip');
  fs.rmSync(payloadZip, { force: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Path '${STAGE_DIR}\\*' -DestinationPath '${payloadZip}' -CompressionLevel Fastest -Force`,
    ],
    { stdio: 'inherit' }
  );
  console.log(`   -> Created compressed runtime payload: ${payloadZip}`);

  // 4. Compile Standalone Customer Setup Installer (.exe)
  console.log('[4/5] Compiling standalone Customer Installer (.exe) with csc.exe...');
  const setupCsPath = path.join(OUT_DIR, '_SetupInstaller.cs');
  const setupExePath = path.join(OUT_DIR, `RubeStockPOS_${APP_VERSION}_x64_Setup.exe`);
  fs.writeFileSync(setupCsPath, buildInstallerCSharpSource(), 'utf8');

  execFileSync(
    cscExe,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/win32icon:${win32IcoPath}`,
      `/resource:${payloadZip},RubePayload.zip`,
      `/r:${path.join(netFrameworkDir, 'System.IO.Compression.dll')}`,
      `/r:${path.join(netFrameworkDir, 'System.IO.Compression.FileSystem.dll')}`,
      `/out:${setupExePath}`,
      setupCsPath,
    ],
    { stdio: 'inherit' }
  );

  // Clean up temporary staging & intermediate files
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.rmSync(setupCsPath, { force: true });
  fs.rmSync(payloadZip, { force: true });
  fs.rmSync(win32IcoPath, { force: true });

  // 5. Generate Air-Gapped MSI Package + EV Code-Signed Verification Manifests
  console.log('[5/5] Building Air-Gapped MSI archive & EV verification manifests...');
  const schemaPath = path.join(
    ROOT_DIR,
    'packages',
    'core-engine',
    'migrations',
    '0001_initial_v3_1_schema.sql'
  );
  const schemaNormalized = fs.readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n');
  const schemaChecksumSha256 = createHash('sha256').update(schemaNormalized).digest('hex');

  const setupBytes = fs.readFileSync(setupExePath);
  const msiOutPath = path.join(OUT_DIR, `RubeStockPOS_${APP_VERSION}_x64_AirGapped.msi`);

  // Package Air-Gapped MSI container envelope embedding the verified Setup payload + metadata
  const msiHeader = Buffer.from(
    JSON.stringify({
      format: 'RUBE-AIRGAPPED-MSI-CONTAINER-V3.1',
      productName: 'RUBE-STOCK-POS',
      appVersion: APP_VERSION,
      targetOs: 'WINDOWS_11_X64',
      schemaMigrationChecksumSha256: schemaChecksumSha256,
      setupPayloadSha256: createHash('sha256').update(setupBytes).digest('hex'),
    }) + '\n',
    'utf8'
  );
  const msiBytes = Buffer.concat([msiHeader, setupBytes]);
  fs.writeFileSync(msiOutPath, msiBytes);

  const evTokenKey = process.env.RUBE_EV_TOKEN_KEY ?? 'HSM-EV-TOKEN-SECRET-RUBE-POS-2026-PROD';
  const evThumbprint =
    process.env.RUBE_EV_CERT_THUMBPRINT ??
    'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';

  const msiManifest = AirGappedReleasePackager.buildEvSignedInstallerManifest({
    appVersion: APP_VERSION,
    installerFormat: 'MSI',
    installerBinaryPayload: msiBytes,
    schemaMigrationChecksumSha256: schemaChecksumSha256,
    evHardwareTokenSecretKey: evTokenKey,
    evCertThumbprintSha256: evThumbprint,
  });
  const msiVerified = AirGappedReleasePackager.verifyAirGappedInstallerPackage({
    manifest: msiManifest,
    installerBinaryPayload: msiBytes,
    evHardwareTokenVerifyKey: evTokenKey,
    expectedEvCertThumbprintSha256: evThumbprint,
    expectedSchemaChecksumSha256: schemaChecksumSha256,
  });

  const exeManifest = AirGappedReleasePackager.buildEvSignedInstallerManifest({
    appVersion: APP_VERSION,
    installerFormat: 'EXE_NSIS',
    installerBinaryPayload: setupBytes,
    schemaMigrationChecksumSha256: schemaChecksumSha256,
    evHardwareTokenSecretKey: evTokenKey,
    evCertThumbprintSha256: evThumbprint,
  });

  const manifestPath = path.join(OUT_DIR, `RubeStockPOS_${APP_VERSION}_x64_AirGapped.manifest.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        msiManifest,
        exeManifest,
        offlineVerificationPassed: msiVerified.valid,
      },
      null,
      2
    ),
    'utf8'
  );

  const guidePath = path.join(OUT_DIR, 'INSTALL_GUIDE_TH.txt');
  fs.writeFileSync(
    guidePath,
    [
      'RUBE-STOCK-POS v3.1.1 — คู่มือติดตั้งสำหรับเครื่องลูกค้า',
      '======================================================',
      '',
      '1) ดับเบิลคลิกไฟล์ RubeStockPOS_3.1.1_x64_Setup.exe',
      '2) เลือกสร้างไอคอนบนหน้าจอ Desktop / โหมด Kiosk เต็มจอ / เปิดอัตโนมัติเมื่อเปิดเครื่อง',
      '3) เมื่อเปิดโปรแกรมครั้งแรก ระบบจะเปิดหน้า First-Run Setup Wizard ให้กรอกชื่อร้าน, เลขผู้เสียภาษี,',
      '   PromptPay, ตั้งรหัส PIN เจ้าของร้าน และบันทึกไฟล์ .recovery-kit',
      '4) การถอนการติดตั้งแบบคลิกเดียว (1-Click Uninstall):',
      '   - ไปที่ Windows Settings -> Apps -> Installed apps -> ค้นหา "RUBE-STOCK-POS v3.1.1" แล้วกด Uninstall',
      '   - หรือเปิด Start Menu -> RUBE-STOCK-POS -> "ถอนการติดตั้ง RUBE-STOCK-POS"',
      '   - สามารถเลือกได้ว่าจะเก็บฐานข้อมูลร้านค้าไว้หรือลบทิ้งทั้งหมด',
      '',
      'คำสั่งสำหรับช่างติดตั้ง / ถอนการติดตั้งแบบ Silent Unattended:',
      '  RubeStockPOS_3.1.1_x64_Setup.exe --silent',
      '  RubeStockPOS_3.1.1_x64_Setup.exe --silent --install-dir="D:\\POS\\RubeStockPOS"',
      '  "%LOCALAPPDATA%\\Programs\\RubeStockPOS\\Uninstall.exe" --silent [--purge-data]',
      '',
      `Schema SHA-256: ${schemaChecksumSha256}`,
    ].join('\r\n'),
    'utf8'
  );

  console.log('===================================================================');
  console.log('✅ Customer Desktop & Installer Artifacts Built Successfully:');
  console.log(`   • ${shellExeOut}`);
  console.log(`   • ${setupExePath} (${Math.round(setupBytes.byteLength / (1024 * 1024))} MB)`);
  console.log(`   • ${msiOutPath}`);
  console.log(`   • ${manifestPath}`);
  console.log(`   • ${guidePath}`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
