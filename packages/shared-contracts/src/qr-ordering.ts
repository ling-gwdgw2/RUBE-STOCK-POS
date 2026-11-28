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
export type GuestEntryChannel = 'QR' | 'NFC' | 'CAPTIVE' | 'DIRECT';
export type NfcTagChipType = 'NTAG213' | 'NTAG215' | 'NTAG216';
export type NfcTagMode = 'STATIC_TABLE' | 'SIGNED_SESSION';
export type NfcRecordLayout = 'URI_ONLY' | 'WIFI_WSC_ONLY' | 'URI_AND_WIFI_WSC';

export const NFC_CHIP_USABLE_NDEF_BYTES: Readonly<Record<NfcTagChipType, number>> = {
  NTAG213: 137,
  NTAG215: 492,
  NTAG216: 872,
};

export interface NfcTableTagPackageDto {
  tableLabel: string;
  outletId: string;
  tagMode: NfcTagMode;
  recordLayout: NfcRecordLayout;
  chipType: NfcTagChipType;
  chipCapacityBytes: number;
  ndefByteLength: number;
  fitsSelectedChip: boolean;
  recommendedChipType: NfcTagChipType | null;
  menuUrl: string;
  signedSessionActive: boolean;
  wscBase64: string | null;
  ndefMessageBase64: string;
  ndefType2TlvHex: string;
}

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
  entryChannel?: GuestEntryChannel | undefined;
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
  /** Enables NFC Tag table ordering & Android Wi-Fi WSC preparation alongside QR Code (default OFF). */
  nfcEnabled?: boolean | undefined;
  /** `STATIC_TABLE` (permanent table sticker) or `SIGNED_SESSION` (HMAC token written per table open). */
  nfcTagMode?: NfcTagMode | undefined;
  /** NDEF record layout: `URI_ONLY` (iOS+Android), `WIFI_WSC_ONLY` (Android Wi-Fi), or Combo (`NTAG215+`). */
  nfcRecordLayout?: NfcRecordLayout | undefined;
  /** Target NFC Forum Type 2 chip EEPROM size check (`NTAG213` | `NTAG215` | `NTAG216`). */
  nfcChipType?: NfcTagChipType | undefined;
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
  nfcMenuUrl?: string | undefined;
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
  nfcEnabled?: boolean | undefined;
  entryChannel?: GuestEntryChannel | undefined;
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
  entryChannel?: GuestEntryChannel | undefined;
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
  nfcEnabled: false,
  nfcTagMode: 'STATIC_TABLE',
  nfcRecordLayout: 'URI_ONLY',
  nfcChipType: 'NTAG215',
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

  const nfcTagMode: NfcTagMode =
    src.nfcTagMode === 'SIGNED_SESSION' ? 'SIGNED_SESSION' : 'STATIC_TABLE';

  const nfcRecordLayout: NfcRecordLayout =
    src.nfcRecordLayout === 'WIFI_WSC_ONLY' || src.nfcRecordLayout === 'URI_AND_WIFI_WSC'
      ? src.nfcRecordLayout
      : 'URI_ONLY';

  const nfcChipType: NfcTagChipType =
    src.nfcChipType === 'NTAG213' || src.nfcChipType === 'NTAG216'
      ? src.nfcChipType
      : 'NTAG215';

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
    nfcEnabled: Boolean(src.nfcEnabled),
    nfcTagMode,
    nfcRecordLayout,
    nfcChipType,
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

export function normalizeGuestEntryChannel(
  raw: unknown,
  fallback: GuestEntryChannel = 'DIRECT'
): GuestEntryChannel {
  if (typeof raw !== 'string') return fallback;
  const upper = raw.trim().toUpperCase();
  if (upper === 'QR' || upper === 'NFC' || upper === 'CAPTIVE' || upper === 'DIRECT') {
    return upper;
  }
  return fallback;
}

/**
 * Builds the Local LAN menu URL encoded into a Table NFC Tag NDEF URI record (`&via=nfc`).
 */
export function buildTableNfcUrl(
  baseUrl: string,
  tableLabel: string,
  signedToken?: string | null,
  outletId?: string | null
): string {
  const baseMenuUrl = buildTableMenuUrl(baseUrl, tableLabel, signedToken, outletId);
  const sep = baseMenuUrl.includes('?') ? '&' : '?';
  return `${baseMenuUrl}${sep}via=nfc`;
}

const UTF8_ENCODER = new TextEncoder();
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1]! : 0;
    const b2 = has2 ? bytes[i + 2]! : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triplet >> 18) & 0x3f]!;
    out += B64_ALPHABET[(triplet >> 12) & 0x3f]!;
    out += has1 ? B64_ALPHABET[(triplet >> 6) & 0x3f]! : '=';
    out += has2 ? B64_ALPHABET[triplet & 0x3f]! : '=';
  }
  return out;
}

export function uint8ArrayToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).toUpperCase().padStart(2, '0');
  }
  return hex;
}

function buildWscTlv(typeId: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  out[0] = (typeId >> 8) & 0xff;
  out[1] = typeId & 0xff;
  out[2] = (value.length >> 8) & 0xff;
  out[3] = value.length & 0xff;
  out.set(value, 4);
  return out;
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Encodes an offline Wi-Fi Alliance Simple Configuration (`application/vnd.wfa.wsc`) binary credential TLV
 * natively supported by Android NFC for one-tap Store Wi-Fi Auto-Join.
 */
export function buildWifiWscCredentialBytes(
  ssid: string,
  password: string,
  security: QrWifiSecurityType = 'WPA'
): Uint8Array {
  const cleanSsid = sanitizeGuestText(ssid, 64);
  if (!cleanSsid) return new Uint8Array(0);
  const ssidBytes = UTF8_ENCODER.encode(cleanSsid).slice(0, 32);
  const cleanPass = security === 'NOPASS' ? '' : sanitizeGuestText(password, 64);
  const passBytes = cleanPass ? UTF8_ENCODER.encode(cleanPass).slice(0, 64) : new Uint8Array(0);

  const authBytes = security === 'NOPASS' ? new Uint8Array([0x00, 0x01]) : new Uint8Array([0x00, 0x20]);
  const encBytes = security === 'NOPASS' ? new Uint8Array([0x00, 0x01]) : new Uint8Array([0x00, 0x08]);

  const innerParts: Uint8Array[] = [
    buildWscTlv(0x1026, new Uint8Array([0x01])), // Network Index
    buildWscTlv(0x1045, ssidBytes), // SSID
    buildWscTlv(0x1003, authBytes), // Auth Type (Open=0x0001, WPA2-PSK=0x0020)
    buildWscTlv(0x100f, encBytes), // Encryption Type (None=0x0001, AES=0x0008)
  ];
  if (passBytes.length > 0) {
    innerParts.push(buildWscTlv(0x1027, passBytes)); // Network Key
  }
  innerParts.push(
    buildWscTlv(0x1020, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) // Broadcast MAC
  );

  return buildWscTlv(0x100e, concatUint8Arrays(innerParts));
}

export interface NdefRawRecordSpec {
  tnf: number;
  typeBytes: Uint8Array;
  payloadBytes: Uint8Array;
}

/**
 * Encodes a URI string into an NFC Forum RTD-U record (`TNF=0x01`, type `'U'`),
 * applying standard `http://` (`0x03`) or `https://` (`0x04`) prefix compression to fit NTAG213.
 */
export function encodeNdefUriRecordSpec(uri: string): NdefRawRecordSpec {
  let prefixCode = 0x00;
  let body = uri;
  if (uri.startsWith('http://www.')) {
    prefixCode = 0x01;
    body = uri.slice('http://www.'.length);
  } else if (uri.startsWith('https://www.')) {
    prefixCode = 0x02;
    body = uri.slice('https://www.'.length);
  } else if (uri.startsWith('http://')) {
    prefixCode = 0x03;
    body = uri.slice('http://'.length);
  } else if (uri.startsWith('https://')) {
    prefixCode = 0x04;
    body = uri.slice('https://'.length);
  }
  const bodyBytes = UTF8_ENCODER.encode(body);
  const payload = new Uint8Array(1 + bodyBytes.length);
  payload[0] = prefixCode;
  payload.set(bodyBytes, 1);
  return {
    tnf: 0x01,
    typeBytes: new Uint8Array([0x55]), // 'U'
    payloadBytes: payload,
  };
}

export function encodeNdefMimeRecordSpec(
  mimeType: string,
  payloadBytes: Uint8Array
): NdefRawRecordSpec {
  return {
    tnf: 0x02,
    typeBytes: UTF8_ENCODER.encode(mimeType),
    payloadBytes,
  };
}

export function encodeNdefMessageBytes(records: readonly NdefRawRecordSpec[]): Uint8Array {
  if (records.length === 0) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const isFirst = i === 0;
    const isLast = i === records.length - 1;
    const isShort = rec.payloadBytes.length <= 255;
    let flags = rec.tnf & 0x07;
    if (isFirst) flags |= 0x80; // MB
    if (isLast) flags |= 0x40; // ME
    if (isShort) flags |= 0x10; // SR

    const headerLen = 1 + 1 + (isShort ? 1 : 4) + rec.typeBytes.length;
    const recBytes = new Uint8Array(headerLen + rec.payloadBytes.length);
    let pos = 0;
    recBytes[pos++] = flags;
    recBytes[pos++] = rec.typeBytes.length & 0xff;
    if (isShort) {
      recBytes[pos++] = rec.payloadBytes.length & 0xff;
    } else {
      const len = rec.payloadBytes.length >>> 0;
      recBytes[pos++] = (len >>> 24) & 0xff;
      recBytes[pos++] = (len >>> 16) & 0xff;
      recBytes[pos++] = (len >>> 8) & 0xff;
      recBytes[pos++] = len & 0xff;
    }
    recBytes.set(rec.typeBytes, pos);
    pos += rec.typeBytes.length;
    recBytes.set(rec.payloadBytes, pos);
    chunks.push(recBytes);
  }
  return concatUint8Arrays(chunks);
}

export function wrapNdefInType2TlvBytes(ndefMessage: Uint8Array): Uint8Array {
  if (ndefMessage.length === 0) return new Uint8Array([0x03, 0x00, 0xfe]);
  const lenHeader =
    ndefMessage.length < 255
      ? new Uint8Array([0x03, ndefMessage.length])
      : new Uint8Array([0x03, 0xff, (ndefMessage.length >> 8) & 0xff, ndefMessage.length & 0xff]);
  return concatUint8Arrays([lenHeader, ndefMessage, new Uint8Array([0xfe])]);
}

export function recommendNfcChipType(ndefByteLength: number): NfcTagChipType | null {
  if (ndefByteLength <= NFC_CHIP_USABLE_NDEF_BYTES.NTAG213) return 'NTAG213';
  if (ndefByteLength <= NFC_CHIP_USABLE_NDEF_BYTES.NTAG215) return 'NTAG215';
  if (ndefByteLength <= NFC_CHIP_USABLE_NDEF_BYTES.NTAG216) return 'NTAG216';
  return null;
}

/**
 * Computes complete offline NFC Tag programming package (URL + NDEF binary + WFA WSC + EEPROM fit check).
 */
export function buildNfcTableTagPackage(params: {
  baseUrl: string;
  tableLabel: string;
  outletId?: string | null;
  signedToken?: string | null;
  config: QrOrderingConfigDto;
}): NfcTableTagPackageDto {
  const outletId = params.outletId?.trim() || 'OUTLET-HQ';
  const tagMode: NfcTagMode =
    params.config.nfcTagMode === 'SIGNED_SESSION' ? 'SIGNED_SESSION' : 'STATIC_TABLE';
  const chipType: NfcTagChipType =
    params.config.nfcChipType === 'NTAG213' || params.config.nfcChipType === 'NTAG216'
      ? params.config.nfcChipType
      : 'NTAG215';
  const chipCapacityBytes = NFC_CHIP_USABLE_NDEF_BYTES[chipType];
  const signedToken =
    tagMode === 'SIGNED_SESSION' && params.signedToken?.trim() ? params.signedToken.trim() : null;
  const menuUrl = buildTableNfcUrl(params.baseUrl, params.tableLabel, signedToken, outletId);

  const wscBytes = buildWifiWscCredentialBytes(
    params.config.wifiSsid,
    params.config.wifiPassword,
    params.config.wifiSecurity
  );
  const hasWifiWsc = wscBytes.length > 0;
  const requestedLayout: NfcRecordLayout =
    params.config.nfcRecordLayout === 'WIFI_WSC_ONLY' ||
    params.config.nfcRecordLayout === 'URI_AND_WIFI_WSC'
      ? params.config.nfcRecordLayout
      : 'URI_ONLY';
  const effectiveLayout: NfcRecordLayout =
    !hasWifiWsc && requestedLayout !== 'URI_ONLY' ? 'URI_ONLY' : requestedLayout;

  const records: NdefRawRecordSpec[] = [];
  if (effectiveLayout === 'URI_ONLY') {
    records.push(encodeNdefUriRecordSpec(menuUrl));
  } else if (effectiveLayout === 'WIFI_WSC_ONLY') {
    records.push(encodeNdefMimeRecordSpec('application/vnd.wfa.wsc', wscBytes));
  } else {
    records.push(encodeNdefUriRecordSpec(menuUrl));
    records.push(encodeNdefMimeRecordSpec('application/vnd.wfa.wsc', wscBytes));
  }

  const ndefMessage = encodeNdefMessageBytes(records);
  const tlvBytes = wrapNdefInType2TlvBytes(ndefMessage);
  const ndefByteLength = ndefMessage.length;

  return {
    tableLabel: params.tableLabel,
    outletId,
    tagMode,
    recordLayout: effectiveLayout,
    chipType,
    chipCapacityBytes,
    ndefByteLength,
    fitsSelectedChip: ndefByteLength <= chipCapacityBytes,
    recommendedChipType: recommendNfcChipType(ndefByteLength),
    menuUrl,
    signedSessionActive: Boolean(signedToken),
    wscBase64: hasWifiWsc ? uint8ArrayToBase64(wscBytes) : null,
    ndefMessageBase64: uint8ArrayToBase64(ndefMessage),
    ndefType2TlvHex: uint8ArrayToHex(tlvBytes),
  };
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
