/**
 * RUBE-STOCK-POS v3.1.1 Zero-Trust Isolated Guest LAN Server (Port 4174)
 *
 * Security & Isolation Architecture:
 * - Runs on a SEPARATE `http.Server` bound to `0.0.0.0:<port>` (default 4174, OFF by default).
 * - POS Core Server (`127.0.0.1:4173`) remains strictly loopback-only and unreachable from Customer Wi-Fi.
 * - Exposes ONLY read-only sanitized active menu items, active item photos, offline Noto Sans Lao fonts,
 *   Captive Portal OS probe redirects (`/generate_204`, `/hotspot-detect.html`, `/ncsi.txt`, etc.),
 *   rate-limited `POST /api/guest/orders` (server-side fixed-point price re-computation), and single-order status.
 * - Explicitly returns HTTP 403 on any POS/admin API path (`/api/bootstrap`, `/api/settings*`, `/api/pos/*`, etc.).
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalIpcBridge } from '../../../cluster-gateway/src/local-ipc-bridge.ts';
import {
  normalizeGuestEntryChannel,
  type GuestEntryChannel,
  type GuestMenuPayloadDto,
  type GuestOrderLineInputDto,
  type GuestOrderRecordDto,
  type GuestServiceCallDto,
  type GuestServiceCallType,
  type QrOrderingConfigDto,
  type QrOrderingRuntimeStatusDto,
} from '../../../shared-contracts/src/qr-ordering.ts';
import { renderGuestMenuHtml } from './guest-menu-html.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CAPTIVE_PORTAL_PROBE_PATHS = new Set<string>([
  '/generate_204',
  '/gen_204',
  '/hotspot-detect.html',
  '/library/test/success.html',
  '/success.html',
  '/ncsi.txt',
  '/connecttest.txt',
  '/redirect',
  '/canonical.html',
  '/success.txt',
  '/mobile/status.php',
  '/check_network_status.txt',
  '/kindle-wifi/wifistub.html',
]);

const FORBIDDEN_POS_PREFIXES = [
  '/api/bootstrap',
  '/api/auth',
  '/api/pos',
  '/api/kds',
  '/api/warehouse',
  '/api/shift',
  '/api/reports',
  '/api/settings',
  '/api/printer',
  '/api/security',
  '/api/onboarding',
  '/api/cluster',
  '/api/hal',
  '/api/catalog',
  '/api/usb-backup',
  '/api/profile',
  '/api/qr-ordering',
];

export interface SlidingWindowBucketOptions {
  nowMs?: number | undefined;
  windowMs?: number | undefined;
  maxTrackedKeys?: number | undefined;
}

/**
 * Pure sliding-window per-key rate-limit checker with bounded FIFO key eviction.
 * Rejected calls do not append timestamps, so retries never extend the lockout window.
 */
export function checkSlidingWindowBucketLimit(
  bucketMap: Map<string, number[]>,
  clientIp: string,
  maxPerWindow: number,
  options?: SlidingWindowBucketOptions
): boolean {
  const now = options?.nowMs ?? Date.now();
  const windowMs = Math.max(1, Number(options?.windowMs ?? 60_000));
  const maxTrackedKeys = Math.max(1, Number(options?.maxTrackedKeys ?? 500));
  const prev = bucketMap.get(clientIp) ?? [];
  const active = prev.filter((ts) => now - ts < windowMs);
  if (active.length >= maxPerWindow) {
    bucketMap.set(clientIp, active);
    return false;
  }
  active.push(now);
  if (!bucketMap.has(clientIp) && bucketMap.size >= maxTrackedKeys) {
    const oldestKey = bucketMap.keys().next().value;
    if (oldestKey !== undefined) {
      bucketMap.delete(oldestKey);
    }
  }
  bucketMap.set(clientIp, active);
  return true;
}

export interface GuestQrOrderingServerDeps {
  ipc: LocalIpcBridge;
  outletId?: string | undefined;
  productImagesDir: string;
  getProductImagesMap: () => Record<string, string>;
  rateLimitMaxOrdersPerMinute?: number | undefined;
  rateLimitWindowMs?: number | undefined;
  nowProvider?: (() => number) | undefined;
  isWriteLockedByLowBattery?: (() => boolean) | undefined;
  onGuestOrderSubmitted?: ((order: GuestOrderRecordDto) => void) | undefined;
  onGuestServiceCallSubmitted?: ((call: GuestServiceCallDto) => void) | undefined;
}

export function detectLanIpv4Addresses(): string[] {
  const ifaces = os.networkInterfaces();
  const privateLan: string[] = [];
  const otherLan: string[] = [];

  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const addr = info.address;
      if (!addr || addr.startsWith('169.254.')) continue; // skip APIPA link-local
      if (
        addr.startsWith('192.168.') ||
        addr.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)
      ) {
        if (!privateLan.includes(addr)) privateLan.push(addr);
      } else if (!otherLan.includes(addr)) {
        otherLan.push(addr);
      }
    }
  }
  return [...privateLan, ...otherLan];
}

export class GuestQrOrderingServer {
  private readonly deps: GuestQrOrderingServerDeps;
  private readonly rateLimitMaxPerMin: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateBuckets = new Map<string, number[]>();
  private readonly readRateBuckets = new Map<string, number[]>();
  private readonly callRateBuckets = new Map<string, number[]>();
  private server: http.Server | null = null;
  private boundPort = 0;
  private lastError: string | undefined = undefined;
  private cachedFontPaths = new Map<'400' | '700', string | null>();

  constructor(deps: GuestQrOrderingServerDeps) {
    this.deps = deps;
    this.rateLimitMaxPerMin = Math.max(1, Number(deps.rateLimitMaxOrdersPerMinute ?? 10));
    this.rateLimitWindowMs = Math.max(50, Number(deps.rateLimitWindowMs ?? 60_000));
  }

  public getActiveOutletId(): string {
    return this.deps.outletId ?? 'OUTLET-HQ';
  }

  private resolveEffectiveOutletId(rawOutlet?: string | null): string {
    const clean = (rawOutlet ?? '').trim();
    if (!clean) return this.getActiveOutletId();
    try {
      const outlets = this.deps.ipc.listOutlets();
      if (outlets.some((o) => o.id === clean)) {
        return clean;
      }
    } catch {
      // fallback to default outlet
    }
    return this.getActiveOutletId();
  }

  public getRuntimeStatus(cfg?: QrOrderingConfigDto): QrOrderingRuntimeStatusDto {
    const activeCfg = cfg ?? this.deps.ipc.getQrOrderingConfig();
    const detectedLanIpv4s = detectLanIpv4Addresses();
    const activeHost =
      activeCfg.customHostOverride.trim() ||
      detectedLanIpv4s[0] ||
      '127.0.0.1';
    const urlHost =
      activeHost.includes(':') && !activeHost.startsWith('[') ? `[${activeHost}]` : activeHost;
    const effectivePort = this.boundPort || activeCfg.port;
    return {
      running: this.server !== null,
      port: effectivePort,
      detectedLanIpv4s,
      activeHost,
      baseUrl: `http://${urlHost}:${effectivePort}`,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  public async syncWithConfig(cfg: QrOrderingConfigDto): Promise<QrOrderingRuntimeStatusDto> {
    if (!cfg.enabled) {
      await this.stop();
      this.lastError = undefined;
      return this.getRuntimeStatus(cfg);
    }

    if (this.server && this.boundPort === cfg.port) {
      return this.getRuntimeStatus(cfg);
    }

    await this.stop();
    try {
      await this.start(cfg.port, '0.0.0.0');
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.getRuntimeStatus(cfg);
  }

  public async start(port = 4174, host = '0.0.0.0'): Promise<{ port: number }> {
    await this.stop();
    return new Promise<{ port: number }>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      srv.headersTimeout = 10_000;
      srv.requestTimeout = 15_000;
      srv.keepAliveTimeout = 5_000;
      srv.maxHeadersCount = 40;
      const onError = (err: Error) => {
        try {
          srv.close();
        } catch {
          // ignore
        }
        reject(err);
      };
      srv.once('error', onError);
      srv.listen(port, host, () => {
        srv.removeListener('error', onError);
        this.server = srv;
        const addr = srv.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ port: this.boundPort });
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      this.boundPort = 0;
      return;
    }
    const srv = this.server;
    this.server = null;
    this.boundPort = 0;
    await new Promise<void>((resolve) => {
      try {
        srv.close(() => resolve());
        if (typeof srv.closeAllConnections === 'function') {
          srv.closeAllConnections();
        }
      } catch {
        resolve();
      }
    });
  }

  private resolveOfflineNotoLaoFont(weight: '400' | '700'): string | null {
    if (this.cachedFontPaths.has(weight)) {
      return this.cachedFontPaths.get(weight) ?? null;
    }
    const candidates: string[] = [];

    // 1. Check built Vite assets in packages/ui-presentation/dist/assets
    const distAssetsDir = path.resolve(__dirname, '../../dist/assets');
    if (fs.existsSync(distAssetsDir)) {
      try {
        const files = fs.readdirSync(distAssetsDir);
        const matched = files.find(
          (f) => f.startsWith(`noto-sans-lao-lao-${weight}-normal`) && f.endsWith('.woff2')
        );
        if (matched) {
          candidates.push(path.join(distAssetsDir, matched));
        }
      } catch {
        // ignore
      }
    }

    // 2. Check node_modules/@fontsource/noto-sans-lao/files
    const rootFontPath = path.resolve(
      __dirname,
      `../../../../node_modules/@fontsource/noto-sans-lao/files/noto-sans-lao-lao-${weight}-normal.woff2`
    );
    candidates.push(rootFontPath);

    for (const p of candidates) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        this.cachedFontPaths.set(weight, p);
        return p;
      }
    }
    this.cachedFontPaths.set(weight, null);
    return null;
  }

  private checkBucketLimit(
    bucketMap: Map<string, number[]>,
    clientIp: string,
    maxPerMin: number
  ): boolean {
    const nowMs = this.deps.nowProvider ? this.deps.nowProvider() : Date.now();
    return checkSlidingWindowBucketLimit(bucketMap, clientIp, maxPerMin, {
      nowMs,
      windowMs: this.rateLimitWindowMs,
      maxTrackedKeys: 500,
    });
  }

  private resolveCaptiveRedirectBase(
    hostHeader: string | string[] | undefined,
    status: QrOrderingRuntimeStatusDto
  ): string {
    const rawHost = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)?.trim() ?? '';
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(rawHost);
    if (!m) {
      return status.baseUrl;
    }
    const ip = m[1]!;
    const portPart = m[2];
    const allowedIp =
      ip === status.activeHost ||
      ip === '127.0.0.1' ||
      status.detectedLanIpv4s.includes(ip);
    const allowedPort = !portPart || portPart === String(status.port);
    return allowedIp && allowedPort ? `http://${rawHost}` : status.baseUrl;
  }

  private async readBoundedJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    const MAX_GUEST_BODY_BYTES = 64 * 1024; // 64 KB
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_GUEST_BODY_BYTES) {
        throw new Error('HTTP 413 Payload Too Large');
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  }

  private resolveEntryChannel(
    rawVia: string | null,
    isCaptive: boolean,
    hasTableOrToken: boolean
  ): GuestEntryChannel {
    if (rawVia && rawVia.trim().toLowerCase() === 'nfc') return 'NFC';
    if (isCaptive) return 'CAPTIVE';
    return hasTableOrToken ? 'QR' : 'DIRECT';
  }

  private buildSanitizedMenuPayload(
    outletId: string,
    tableParam: string,
    tokenParam: string,
    entryChannel: GuestEntryChannel = 'DIRECT'
  ): GuestMenuPayloadDto {
    const qrCfg = this.deps.ipc.getQrOrderingConfig();
    const fiscal = this.deps.ipc.getFiscalConfig();
    const store = this.deps.ipc.getStoreIdentitySettings(outletId);
    const categoriesRaw = this.deps.ipc.listCategories();
    const variantsRaw = this.deps.ipc.listCatalogVariantsDetailed(outletId);
    const modGroupsRaw = this.deps.ipc.listModifierGroupsWithModifiers();
    const imgMap = this.deps.getProductImagesMap();

    const visibleCategories = categoriesRaw
      .filter(
        (c) =>
          c.id !== 'CAT-RAW' &&
          c.kitchenStation.toUpperCase() !== 'PREP'
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        displayColor: c.displayColor,
        sortOrder: c.sortOrder,
      }));
    const visibleCatIds = new Set(visibleCategories.map((c) => c.id));

    const availMap = this.deps.ipc.computeGuestMenuAvailabilityMap(outletId);

    const visibleItems = variantsRaw
      .filter((v) => {
        if (!v.active) return false;
        if (v.isWeightedScale) return false;
        if (v.categoryId === 'CAT-RAW') return false;
        if (v.kitchenStation.toUpperCase() === 'PREP') return false;
        if (v.categoryId && visibleCatIds.size > 0 && !visibleCatIds.has(v.categoryId)) {
          return false;
        }
        return true;
      })
      .map((v) => {
        const fname = imgMap[v.id];
        return {
          variantId: v.id,
          itemName: v.itemName,
          variantName: v.variantName,
          categoryId: v.categoryId,
          categoryName: v.categoryName,
          unitName: v.unitName,
          priceSatang: v.priceSatang,
          imageUrl: fname ? `/api/guest/image/${encodeURIComponent(fname)}` : null,
          isAvailable: availMap[v.id] ?? (v.isComposite || v.inStockMilli >= 1_000),
          isComposite: v.isComposite,
          kitchenStation: v.kitchenStation,
        };
      });

    const sanitizedModGroups = modGroupsRaw.map((g) => ({
      id: g.id,
      name: g.name,
      selectionType: g.selectionType,
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      modifiers: g.modifiers.map((m) => ({
        id: m.id,
        name: m.name,
        priceDeltaSatang: m.priceDeltaSatang,
      })),
    }));

    let lockedTableLabel: string | null = null;
    let signedTableValid = false;
    let signedTableExpired = false;
    if (tableParam && tokenParam) {
      const verified = this.deps.ipc.verifyTableQrToken(outletId, tableParam, tokenParam);
      if (verified.valid) {
        lockedTableLabel = tableParam;
        signedTableValid = true;
      } else {
        signedTableExpired = true;
      }
    }

    return {
      storeName: store.storeName,
      storeAddress: store.storeAddress ?? fiscal.storeAddress,
      outletId,
      countryCode: fiscal.countryCode,
      currencyCode: fiscal.currencyCode,
      currencySymbol: fiscal.currencySymbol,
      currencyDecimals: fiscal.currencyDecimals,
      defaultLocale: fiscal.uiLocale,
      taxMode: fiscal.defaultTaxMode,
      vatRateBps: fiscal.vatRateBps,
      wifiSsid: qrCfg.wifiSsid,
      maxQtyPerItem: qrCfg.maxQtyPerItem,
      allowOpenTableSelection: qrCfg.allowOpenTableSelection,
      tableLabels: qrCfg.tableLabels,
      lockedTableLabel,
      signedTableValid,
      signedTableExpired,
      nfcEnabled: Boolean(qrCfg.nfcEnabled),
      entryChannel,
      categories: visibleCategories,
      items: visibleItems,
      modifierGroups: sanitizedModGroups,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const lowerPath = pathname.toLowerCase();

      // 1. Explicit Zero-Trust Port Isolation: block all POS/Admin API prefixes on Guest Port
      if (FORBIDDEN_POS_PREFIXES.some((prefix) => lowerPath.startsWith(prefix))) {
        this.sendJson(res, 403, {
          error:
            'HTTP 403 Forbidden: POS/Admin APIs are isolated on loopback port 4173 and unreachable from Guest Wi-Fi',
        });
        return;
      }

      // 2. Captive Portal OS Connectivity Probe Intercepts (iOS / Android / Windows / Firefox)
      if (method === 'GET' && CAPTIVE_PORTAL_PROBE_PATHS.has(lowerPath)) {
        const status = this.getRuntimeStatus();
        const redirectBase = this.resolveCaptiveRedirectBase(req.headers.host, status);
        res.writeHead(302, {
          Location: `${redirectBase}/m?captive=1`,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end();
        return;
      }

      // 3. Offline Bundled Noto Sans Lao Fonts (Zero CDN)
      if (
        method === 'GET' &&
        (pathname === '/fonts/noto-sans-lao-400.woff2' ||
          pathname === '/fonts/noto-sans-lao-700.woff2')
      ) {
        const weight: '400' | '700' = pathname.includes('700') ? '700' : '400';
        const fontFile = this.resolveOfflineNotoLaoFont(weight);
        if (!fontFile) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'font/woff2',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(fs.readFileSync(fontFile));
        return;
      }

      // 4. Guest Mobile Web App HTML
      if (method === 'GET' && (pathname === '/' || pathname === '/m' || pathname === '/menu')) {
        const outletId = this.resolveEffectiveOutletId(url.searchParams.get('o'));
        const store = this.deps.ipc.getStoreIdentitySettings(outletId);
        const fiscal = this.deps.ipc.getFiscalConfig();
        const initialTableLabel = (url.searchParams.get('t') ?? '').trim().slice(0, 24);
        const initialSignedToken = (url.searchParams.get('s') ?? '').trim().slice(0, 80);
        const isCaptiveMode = url.searchParams.get('captive') === '1';
        const entryChannel = this.resolveEntryChannel(
          url.searchParams.get('via'),
          isCaptiveMode,
          Boolean(initialTableLabel || initialSignedToken)
        );
        const html = renderGuestMenuHtml({
          storeName: store.storeName,
          initialOutletId: outletId,
          initialTableLabel,
          initialSignedToken,
          isCaptiveMode,
          entryChannel,
          defaultLocale: fiscal.uiLocale,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
        return;
      }

      // 5. Guest Health Endpoint
      if (method === 'GET' && pathname === '/api/guest/health') {
        this.sendJson(res, 200, {
          ok: true,
          service: 'RUBE-POS-GUEST-QR',
          port: this.boundPort,
        });
        return;
      }

      // 6. Sanitized Read-Only Active Menu API
      if (method === 'GET' && pathname === '/api/guest/menu') {
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        if (!this.checkBucketLimit(this.readRateBuckets, clientIp, 120)) {
          this.sendJson(res, 429, { error: 'HTTP 429 Too Many Requests' });
          return;
        }
        const outletId = this.resolveEffectiveOutletId(url.searchParams.get('o'));
        const tableParam = (url.searchParams.get('t') ?? '').trim().slice(0, 24);
        const tokenParam = (url.searchParams.get('s') ?? '').trim().slice(0, 80);
        const entryChannel = this.resolveEntryChannel(
          url.searchParams.get('via'),
          url.searchParams.get('captive') === '1',
          Boolean(tableParam || tokenParam)
        );
        const menuPayload = this.buildSanitizedMenuPayload(
          outletId,
          tableParam,
          tokenParam,
          entryChannel
        );
        this.sendJson(res, 200, menuPayload);
        return;
      }

      // 7. Read-Only Active Product Photo Endpoint (strictly mapped active non-raw items only)
      if (method === 'GET' && pathname.startsWith('/api/guest/image/')) {
        const rawName = decodeURIComponent(pathname.slice('/api/guest/image/'.length));
        const safeBase = path.basename(rawName);
        if (!safeBase || safeBase !== rawName || safeBase.includes('..')) {
          this.sendJson(res, 400, { error: 'Invalid image path' });
          return;
        }
        const outletId = this.getActiveOutletId();
        const imgMap = this.deps.getProductImagesMap();
        const activeNonRawIds = new Set(
          this.deps.ipc
            .listCatalogVariantsDetailed(outletId)
            .filter(
              (v) =>
                v.active &&
                v.categoryId !== 'CAT-RAW' &&
                v.kitchenStation.toUpperCase() !== 'PREP'
            )
            .map((v) => v.id)
        );
        const isAllowedFile = Object.entries(imgMap).some(
          ([variantId, fname]) => fname === safeBase && activeNonRawIds.has(variantId)
        );
        if (!isAllowedFile) {
          this.sendJson(res, 404, { error: 'Image not found' });
          return;
        }
        const fullPath = path.join(this.deps.productImagesDir, safeBase);
        if (!fullPath.startsWith(this.deps.productImagesDir) || !fs.existsSync(fullPath)) {
          this.sendJson(res, 404, { error: 'Image not found' });
          return;
        }
        const ext = path.extname(safeBase).toLowerCase();
        const mime =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(fs.readFileSync(fullPath));
        return;
      }

      // 8. Rate-Limited Guest Order Submission (Server-side Fixed-Point Price Re-Computation)
      if (method === 'POST' && pathname === '/api/guest/orders') {
        if (this.deps.isWriteLockedByLowBattery?.()) {
          this.sendJson(res, 503, {
            error: 'HTTP 503 Service Unavailable: ระบบสำรองไฟฉุกเฉินกำลังบันทึกข้อมูล งดรับออเดอร์ชั่วคราว',
          });
          return;
        }
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        if (!this.checkBucketLimit(this.rateBuckets, clientIp, this.rateLimitMaxPerMin)) {
          this.sendJson(res, 429, {
            error:
              'HTTP 429 Too Many Requests: ส่งคำสั่งซื้อถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
          });
          return;
        }
        const body = await this.readBoundedJsonBody<{
          outletId?: string;
          tableLabel?: string;
          signedToken?: string;
          customerName?: string;
          customerNote?: string;
          clientSubmissionKey?: string;
          entryChannel?: GuestEntryChannel;
          lines?: GuestOrderLineInputDto[];
        }>(req);

        const order = await this.deps.ipc.submitGuestOrder({
          outletId: this.resolveEffectiveOutletId(body.outletId),
          tableLabel: String(body.tableLabel ?? ''),
          signedToken: typeof body.signedToken === 'string' ? body.signedToken : '',
          customerName: typeof body.customerName === 'string' ? body.customerName : '',
          customerNote: typeof body.customerNote === 'string' ? body.customerNote : '',
          ...(typeof body.clientSubmissionKey === 'string' && body.clientSubmissionKey.trim()
            ? { clientSubmissionKey: body.clientSubmissionKey.trim() }
            : {}),
          entryChannel: normalizeGuestEntryChannel(
            body.entryChannel,
            typeof body.signedToken === 'string' && body.signedToken.trim() ? 'QR' : 'DIRECT'
          ),
          lines: Array.isArray(body.lines) ? body.lines : [],
        });

        this.deps.onGuestOrderSubmitted?.(order);
        this.sendJson(res, 201, { order });
        return;
      }

      // 8.5 Rate-Limited Guest Service Call / Request Bill
      if (method === 'POST' && pathname === '/api/guest/service-call') {
        if (this.deps.isWriteLockedByLowBattery?.()) {
          this.sendJson(res, 503, {
            error: 'HTTP 503 Service Unavailable: ระบบสำรองไฟฉุกเฉิน งดรับคำขอชั่วคราว',
          });
          return;
        }
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        if (!this.checkBucketLimit(this.callRateBuckets, clientIp, Math.max(4, this.rateLimitMaxPerMin))) {
          this.sendJson(res, 429, {
            error: 'HTTP 429 Too Many Requests: กดเรียกพนักงานถี่เกินไป กรุณารอสักครู่',
          });
          return;
        }
        const body = await this.readBoundedJsonBody<{
          outletId?: string;
          tableLabel?: string;
          signedToken?: string;
          callType?: GuestServiceCallType;
          note?: string;
          entryChannel?: GuestEntryChannel;
        }>(req);

        const call = await this.deps.ipc.submitGuestServiceCall({
          outletId: this.resolveEffectiveOutletId(body.outletId),
          tableLabel: String(body.tableLabel ?? ''),
          signedToken: typeof body.signedToken === 'string' ? body.signedToken : '',
          callType: body.callType === 'REQUEST_BILL' ? 'REQUEST_BILL' : 'CALL_STAFF',
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
          entryChannel: normalizeGuestEntryChannel(
            body.entryChannel,
            typeof body.signedToken === 'string' && body.signedToken.trim() ? 'QR' : 'DIRECT'
          ),
        });

        this.deps.onGuestServiceCallSubmitted?.(call);
        this.sendJson(res, 201, { ok: true, call });
        return;
      }

      // 9. Single Guest Order Live Status Tracking (KDS-Hydrated)
      if (method === 'GET' && pathname === '/api/guest/order-status') {
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        if (!this.checkBucketLimit(this.readRateBuckets, clientIp, 120)) {
          this.sendJson(res, 429, { error: 'HTTP 429 Too Many Requests' });
          return;
        }
        const orderId = (url.searchParams.get('id') ?? '').trim();
        if (!orderId) {
          this.sendJson(res, 400, { error: 'Missing order id' });
          return;
        }
        const token = (url.searchParams.get('token') ?? '').trim() || undefined;
        const outletId = this.resolveEffectiveOutletId(url.searchParams.get('o'));
        const order = this.deps.ipc.getGuestOrderStatusById(outletId, orderId, token);
        if (!order) {
          this.sendJson(res, 404, { error: 'Order not found' });
          return;
        }
        this.sendJson(res, 200, { order });
        return;
      }

      this.sendJson(res, 404, { error: `Guest endpoint not found: ${method} ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = message.includes('403')
        ? 403
        : message.includes('404')
          ? 404
          : message.includes('409')
            ? 409
            : message.includes('413')
              ? 413
              : message.includes('429')
                ? 429
                : message.includes('503')
                  ? 503
                  : 400;
      this.sendJson(res, statusCode, { error: message });
    }
  }
}
