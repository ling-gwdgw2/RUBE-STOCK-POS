/**
 * RUBE-STOCK-POS v3.1.1 Local QR Table Ordering & Captive Portal Shared Contracts
 *
 * 100% pure browser-safe TypeScript (zero `node:*` imports, zero floating-point math).
 * Used by:
 * - Isolated Guest LAN HTTP Server (Port 4174)
 * - POS Desktop Core Server (Port 4173)
 * - SQLite Core Engine (`store_config` HMAC-protected settings + table sessions + guest order queue)
 * - React POS Cashier Inbox, Settings & Thermal/A4 Printable QR Slips
 */

import {
  roundDivBigInt,
  SCALE_MILLI,
  type MilliUnit,
  type Satang,
  type TaxMode,
} from './fixed-point.ts';
import type { CountryCode, CurrencyCode, LocaleCode } from './currency.ts';

export type QrOrderApprovalMode = 'CASHIER_CONFIRM' | 'AUTO_ACCEPT_SIGNED_TABLE';
export type QrWifiSecurityType = 'WPA' | 'NOPASS';
export type QrGuestOrderStatus =
  | 'PENDING_CONFIRM'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'SERVED'
  | 'SETTLED'
  | 'REJECTED';

export type GuestServiceCallType = 'CALL_STAFF' | 'REQUEST_BILL';

export interface GuestServiceCallDto {
  id: string;
  outletId: string;
  tableLabel: string;
  callType: GuestServiceCallType;
  note: string;
  isSignedTableSession: boolean;
  status: 'PENDING' | 'ACKNOWLEDGED';
  createdAtIso: string;
  acknowledgedByName: string | null;
  acknowledgedAtIso: string | null;
}

export interface QrOrderingConfigDto {
  /** Master switch for the isolated LAN Guest Server (default OFF for zero-trust safety). */
  enabled: boolean;
  /** Isolated HTTP port for customer mobile devices on LAN (default 4174; never POS 4173). */
  port: number;
  /** Store Guest Wi-Fi SSID encoded into Wi-Fi QR (`WIFI:T:...;S:...;P:...;;`). */
  wifiSsid: string;
  /** Store Guest Wi-Fi password (empty when `wifiSecurity === 'NOPASS'`). */
  wifiPassword: string;
  /** Wi-Fi encryption type (`WPA` covers WPA/WPA2/WPA3 on iOS & Android). */
  wifiSecurity: QrWifiSecurityType;
  /**
   * Default: `CASHIER_CONFIRM` (every mobile order enters POS Cashier Inbox first).
   * Optional: `AUTO_ACCEPT_SIGNED_TABLE` (HMAC-signed Table QR orders merge into Held Bill + KDS immediately).
   */
  approvalMode: QrOrderApprovalMode;
  /** Configured table & service labels (e.g. `T01`..`T12`, `TAKEAWAY`). */
  tableLabels: string[];
  /** Anti-abuse cap per line item on a single guest submission (default 20, max 99). */
  maxQtyPerItem: number;
  /**
   * Allows walk-in Captive Portal guests (without a signed table slip) to pick a table from `tableLabels`.
   * Unsigned walk-in orders ALWAYS require Cashier confirmation regardless of `approvalMode`.
   */
  allowOpenTableSelection: boolean;
  /** Optional manual LAN IP/hostname override when POS PC has multiple network adapters. */
  customHostOverride: string;
}

export interface QrOrderingRuntimeStatusDto {
  running: boolean;
  port: number;
  detectedLanIpv4s: string[];
  activeHost: string;
  baseUrl: string;
  lastError?: string | undefined;
}

export interface TableQrSessionDto {
  outletId: string;
  tableLabel: string;
  sessionNonce: string;
  token: string;
  menuUrl: string;
  wifiQrPayload: string;
  openedByName: string;
  openedAtIso: string;
}

export interface GuestMenuModifierItemDto {
  id: string;
  name: string;
  priceDeltaSatang: Satang;
}

export interface GuestMenuModifierGroupDto {
  id: string;
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  modifiers: GuestMenuModifierItemDto[];
}

export interface GuestMenuCategoryDto {
  id: string;
  name: string;
  displayColor: string;
  sortOrder: number;
}

export interface GuestMenuItemDto {
  variantId: string;
  itemName: string;
  variantName: string;
  categoryId: string | null;
  categoryName: string;
  unitName: string;
  priceSatang: Satang;
  imageUrl: string | null;
  isAvailable: boolean;
  isComposite: boolean;
  kitchenStation: string;
}

export interface GuestMenuPayloadDto {
  storeName: string;
  storeAddress: string;
  outletId: string;
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  currencySymbol: string;
  currencyDecimals: 0 | 2;
  defaultLocale: LocaleCode;
  taxMode: TaxMode;
  vatRateBps: number;
  wifiSsid: string;
  maxQtyPerItem: number;
  allowOpenTableSelection: boolean;
  tableLabels: string[];
  lockedTableLabel: string | null;
  signedTableValid: boolean;
  signedTableExpired: boolean;
  categories: GuestMenuCategoryDto[];
  items: GuestMenuItemDto[];
  modifierGroups: GuestMenuModifierGroupDto[];
}

export interface GuestOrderLineInputDto {
  variantId: string;
  quantityCount: number;
  selectedModifierIds?: string[] | undefined;
  note?: string | undefined;
}

export interface GuestOrderLineSnapshotDto {
  variantId: string;
  itemName: string;
  variantName: string;
  sku: string;
  unitName: string;
  quantityMilli: MilliUnit;
  unitPriceSatang: Satang;
  modifiersTotalSatang: Satang;
  lineTotalSatang: Satang;
  selectedModifierIds: string[];
  modifierNames: string[];
  note: string;
}

export interface GuestOrderRecordDto {
  id: string;
  orderCode: string;
  outletId: string;
  tableLabel: string;
  orderType: 'DINE_IN' | 'TAKEAWAY';
  customerName: string;
  customerNote: string;
  isSignedTableSession: boolean;
  tableSessionNonce: string | null;
  status: QrGuestOrderStatus;
  lines: GuestOrderLineSnapshotDto[];
  subtotalSatang: Satang;
  estimatedTotalSatang: Satang;
  heldBillId: string | null;
  kdsSalesOrderId: string | null;
  kdsSequenceIds: number[];
  acceptedByName: string | null;
  acceptedAtIso: string | null;
  rejectionReason: string | null;
  createdAtIso: string;
  updatedAtIso: string;
  trackingToken?: string | undefined;
  clientSubmissionKey?: string | null | undefined;
  settledAtIso?: string | null | undefined;
}

export const DEFAULT_QR_TABLE_LABELS: readonly string[] = [
  'T01',
  'T02',
  'T03',
  'T04',
  'T05',
  'T06',
  'T07',
  'T08',
  'T09',
  'T10',
  'T11',
  'T12',
  'TAKEAWAY',
];

export const DEFAULT_QR_ORDERING_CONFIG: QrOrderingConfigDto = {
  enabled: false,
  port: 4174,
  wifiSsid: '',
  wifiPassword: '',
  wifiSecurity: 'WPA',
  approvalMode: 'CASHIER_CONFIRM',
  tableLabels: [...DEFAULT_QR_TABLE_LABELS],
  maxQtyPerItem: 20,
  allowOpenTableSelection: true,
  customHostOverride: '',
};

/**
 * Strips control characters, trims, and caps string length for safe storage & thermal rendering.
 */
export function sanitizeGuestText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export function normalizeTableLabels(raw: unknown): string[] {
  const candidates: string[] = Array.isArray(raw)
    ? raw.map((x) => sanitizeGuestText(String(x ?? ''), 24))
    : typeof raw === 'string'
      ? raw.split(/[,\r\n]+/).map((x) => sanitizeGuestText(x, 24))
      : [];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const label of candidates) {
    if (!label) continue;
    const key = label.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(label);
    if (unique.length >= 60) break;
  }
  return unique.length > 0 ? unique : [...DEFAULT_QR_TABLE_LABELS];
}

export function normalizeQrOrderingConfig(
  raw?: Partial<QrOrderingConfigDto> | Record<string, unknown> | null
): QrOrderingConfigDto {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawPort = Number(src.port ?? DEFAULT_QR_ORDERING_CONFIG.port);
  const port =
    Number.isSafeInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 && rawPort !== 4173
      ? rawPort
      : DEFAULT_QR_ORDERING_CONFIG.port;

  const wifiSecurity: QrWifiSecurityType =
    src.wifiSecurity === 'NOPASS' ? 'NOPASS' : 'WPA';

  const approvalMode: QrOrderApprovalMode =
    src.approvalMode === 'AUTO_ACCEPT_SIGNED_TABLE'
      ? 'AUTO_ACCEPT_SIGNED_TABLE'
      : 'CASHIER_CONFIRM';

  const rawMaxQty = Number(src.maxQtyPerItem ?? DEFAULT_QR_ORDERING_CONFIG.maxQtyPerItem);
  const maxQtyPerItem =
    Number.isSafeInteger(rawMaxQty) && rawMaxQty >= 1 && rawMaxQty <= 99
      ? rawMaxQty
      : DEFAULT_QR_ORDERING_CONFIG.maxQtyPerItem;

  const customHostOverride = sanitizeGuestText(src.customHostOverride ?? '', 64).replace(
    /^https?:\/\//i,
    ''
  ).replace(/\/.*$/, '');

  return {
    enabled: Boolean(src.enabled),
    port,
    wifiSsid: sanitizeGuestText(src.wifiSsid ?? '', 64),
    wifiPassword: wifiSecurity === 'NOPASS' ? '' : sanitizeGuestText(src.wifiPassword ?? '', 64),
    wifiSecurity,
    approvalMode,
    tableLabels: normalizeTableLabels(src.tableLabels),
    maxQtyPerItem,
    allowOpenTableSelection: src.allowOpenTableSelection !== false,
    customHostOverride,
  };
}

/**
 * Escapes special characters in Wi-Fi QR strings per ZXing / Apple / Android spec.
 */
export function escapeWifiQrField(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * Builds a standards-compliant Wi-Fi Auto-Join QR payload (`WIFI:T:WPA;S:...;P:...;;`).
 * Returns empty string if `ssid` is blank.
 */
export function buildWifiQrPayload(
  ssid: string,
  password: string,
  security: QrWifiSecurityType = 'WPA'
): string {
  const cleanSsid = sanitizeGuestText(ssid, 64);
  if (!cleanSsid) return '';
  if (security === 'NOPASS') {
    return `WIFI:T:nopass;S:${escapeWifiQrField(cleanSsid)};;`;
  }
  const cleanPass = sanitizeGuestText(password, 64);
  return `WIFI:T:WPA;S:${escapeWifiQrField(cleanSsid)};P:${escapeWifiQrField(cleanPass)};;`;
}

/**
 * Builds the Local LAN menu URL encoded into a Table QR Code.
 */
export function buildTableMenuUrl(
  baseUrl: string,
  tableLabel: string,
  signedToken?: string | null,
  outletId?: string | null
): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (tableLabel.trim()) {
    params.set('t', tableLabel.trim());
  }
  if (signedToken && signedToken.trim()) {
    params.set('s', signedToken.trim());
  }
  if (outletId && outletId.trim() && outletId.trim() !== 'OUTLET-HQ') {
    params.set('o', outletId.trim());
  }
  const qs = params.toString();
  return qs ? `${cleanBase}/m?${qs}` : `${cleanBase}/m`;
}

/**
 * Pure BigInt fixed-point calculation for a single guest order line (zero floating-point drift).
 */
export function computeGuestOrderLineSatang(params: {
  quantityMilli: MilliUnit;
  unitPriceSatang: Satang;
  modifierPriceDeltasSatang: readonly Satang[];
}): {
  baseLineSatang: Satang;
  modifiersTotalSatang: Satang;
  lineTotalSatang: Satang;
} {
  const qty = BigInt(Math.max(1, params.quantityMilli));
  const unitPrice = BigInt(Math.max(0, params.unitPriceSatang));
  const singleUnitModDelta = params.modifierPriceDeltasSatang.reduce(
    (sum, d) => sum + BigInt(d),
    0n
  );
  const baseLineSatang = Number(roundDivBigInt(qty * unitPrice, SCALE_MILLI));
  const modifiersTotalSatang = Number(roundDivBigInt(qty * singleUnitModDelta, SCALE_MILLI));
  const lineTotalSatang = Math.max(0, baseLineSatang + modifiersTotalSatang);
  return {
    baseLineSatang,
    modifiersTotalSatang,
    lineTotalSatang,
  };
}
