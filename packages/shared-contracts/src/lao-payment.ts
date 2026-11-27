/**
 * RUBE-STOCK-POS v3.1 Browser-Safe Lao PDR Bank Directory & Offline EMVCo LAOQR / BCEL OnePay Utilities
 *
 * Pure TypeScript with zero `node:*` imports so both the Vite frontend bundle and Node.js backend
 * share one canonical source of truth for LAOQR TLV parsing, CRC16-CCITT (`0x1021`), Static-to-Dynamic
 * upgrade, and Lao PDR bank metadata.
 */

import { type Satang, roundDivBigInt } from './fixed-point.ts';
import type { LocaleCode } from './currency.ts';

export interface LaoBankOption {
  code: string;
  shortName: string;
  displayNameLao: string;
  displayNameThai: string;
  displayNameEn: string;
}

export const LAO_BANKS: ReadonlyArray<LaoBankOption> = [
  {
    code: 'BCEL',
    shortName: 'BCEL One',
    displayNameLao: 'ທະນາຄານການຄ້າຕ່າງປະເທດລາວ (BCEL One)',
    displayNameThai: 'ธนาคารการค้าต่างประเทศลาว (BCEL One)',
    displayNameEn: 'BCEL (BCEL OnePay)',
  },
  {
    code: 'LDB',
    shortName: 'LDB Trust',
    displayNameLao: 'ທະນາຄານພັດທະນາລາວ (LDB Trust)',
    displayNameThai: 'ธนาคารพัฒนาลาว (LDB Trust)',
    displayNameEn: 'Lao Development Bank (LDB)',
  },
  {
    code: 'JDB',
    shortName: 'JDB Yes',
    displayNameLao: 'ທະນາຄານຮ່ວມພັດທະນາ (JDB Yes)',
    displayNameThai: 'ธนาคารร่วมพัฒนา (JDB Yes)',
    displayNameEn: 'Joint Development Bank (JDB)',
  },
  {
    code: 'APB',
    shortName: 'APB',
    displayNameLao: 'ທະນາຄານສົ່ງເສີມກະສິກຳ (APB)',
    displayNameThai: 'ธนาคารส่งเสริมกสิกรรม (APB)',
    displayNameEn: 'Agricultural Promotion Bank (APB)',
  },
  {
    code: 'PSV',
    shortName: 'Phongsavanh',
    displayNameLao: 'ທະນາຄານພົງສະຫວັນ (Phongsavanh)',
    displayNameThai: 'ธนาคารพงสะหวัน (Phongsavanh)',
    displayNameEn: 'Phongsavanh Bank (PSV)',
  },
  {
    code: 'MJB',
    shortName: 'Maruhan',
    displayNameLao: 'ທະນາຄານມາຣູຮານ ເຈແປນ ລາວ (MJB)',
    displayNameThai: 'ธนาคารมารูฮาน เจแปน ลาว (MJB)',
    displayNameEn: 'Maruhan Japan Bank Lao (MJB)',
  },
  {
    code: 'STB',
    shortName: 'ST Bank',
    displayNameLao: 'ທະນາຄານ ເອັສທີ (ST Bank)',
    displayNameThai: 'ธนาคารเอสที (ST Bank)',
    displayNameEn: 'ST Bank (STB)',
  },
  {
    code: 'VTB',
    shortName: 'VietinBank',
    displayNameLao: 'ທະນາຄານ ຫວຽດຕິນແບັງ ລາວ (VietinBank)',
    displayNameThai: 'ธนาคารเวียตตินแบงก์ ลาว (VietinBank)',
    displayNameEn: 'VietinBank Lao (VTB)',
  },
  {
    code: 'OTHER',
    shortName: 'LAOQR / Other',
    displayNameLao: 'ທະນາຄານອື່ນ / ຂ້າມປະເທດ (LAPNet / Cross-Border)',
    displayNameThai: 'ธนาคารอื่น / โอนข้ามประเทศ (LAPNet / Thai QR)',
    displayNameEn: 'Other Bank / Cross-Border LAOQR',
  },
];

export function getLaoBankDisplayName(bankCode: string, locale: LocaleCode = 'lo'): string {
  const normalized = bankCode.trim().toUpperCase();
  const found = LAO_BANKS.find((b) => b.code === normalized);
  if (!found) {
    return normalized || 'LAOQR';
  }
  if (locale === 'th') return found.displayNameThai;
  if (locale === 'en') return found.displayNameEn;
  return found.displayNameLao;
}

export interface EmvCoTlvNode {
  tag: string;
  value: string;
}

export function computeCrc16CcittHex(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function formatEmvTlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, '0');
  return `${tag}${len}${value}`;
}

export function parseEmvCoTlv(rawPayload: string): EmvCoTlvNode[] | null {
  const trimmed = rawPayload.trim();
  if (trimmed.length < 12) return null;
  const nodes: EmvCoTlvNode[] = [];
  let idx = 0;
  while (idx < trimmed.length) {
    if (idx + 4 > trimmed.length) return null;
    const tag = trimmed.slice(idx, idx + 2);
    const lenStr = trimmed.slice(idx + 2, idx + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) {
      return null;
    }
    const len = Number(lenStr);
    const valStart = idx + 4;
    const valEnd = valStart + len;
    if (valEnd > trimmed.length) {
      return null;
    }
    nodes.push({ tag, value: trimmed.slice(valStart, valEnd) });
    idx = valEnd;
  }
  return nodes;
}

export function serializeEmvCoTlvWithCrc(nodes: readonly EmvCoTlvNode[]): {
  payload: string;
  crcHex: string;
} {
  let body = '';
  for (const node of nodes) {
    if (node.tag === '63') continue;
    body += formatEmvTlv(node.tag, node.value);
  }
  const bodyWithCrcHeader = `${body}6304`;
  const crcHex = computeCrc16CcittHex(bodyWithCrcHeader);
  return {
    payload: `${bodyWithCrcHeader}${crcHex}`,
    crcHex,
  };
}

export interface ValidatedLaoQrTemplate {
  valid: boolean;
  normalizedTemplate: string;
  merchantAccountTag: string;
  merchantName: string;
  merchantCity: string;
  countryCode: string;
  currencyNumeric: string;
  crcValid: boolean;
  errorReason?: string;
}

export function validateLaoQrStaticTemplate(rawQr: string): ValidatedLaoQrTemplate {
  const trimmed = rawQr.trim();
  const nodes = parseEmvCoTlv(trimmed);
  if (!nodes || nodes.length === 0) {
    return {
      valid: false,
      normalizedTemplate: '',
      merchantAccountTag: '',
      merchantName: '',
      merchantCity: '',
      countryCode: '',
      currencyNumeric: '',
      crcValid: false,
      errorReason: 'รูปแบบข้อมูลไม่ใช่มาตรฐาน EMVCo QR (Invalid EMVCo TLV)',
    };
  }

  const tag00 = nodes.find((n) => n.tag === '00');
  const tag63 = nodes[nodes.length - 1];
  if (!tag00 || tag00.value !== '01') {
    return {
      valid: false,
      normalizedTemplate: '',
      merchantAccountTag: '',
      merchantName: '',
      merchantCity: '',
      countryCode: '',
      currencyNumeric: '',
      crcValid: false,
      errorReason: 'ไม่พบ Payload Format Indicator (Tag 00 = 01)',
    };
  }

  if (!tag63 || tag63.tag !== '63' || tag63.value.length !== 4) {
    return {
      valid: false,
      normalizedTemplate: '',
      merchantAccountTag: '',
      merchantName: '',
      merchantCity: '',
      countryCode: '',
      currencyNumeric: '',
      crcValid: false,
      errorReason: 'ไม่พบรหัสตรวจสอบ CRC16 (Tag 63)',
    };
  }

  const expectedCrc = computeCrc16CcittHex(trimmed.slice(0, trimmed.length - 4));
  const crcValid = expectedCrc.toUpperCase() === tag63.value.toUpperCase();
  if (!crcValid) {
    return {
      valid: false,
      normalizedTemplate: '',
      merchantAccountTag: '',
      merchantName: '',
      merchantCity: '',
      countryCode: '',
      currencyNumeric: '',
      crcValid: false,
      errorReason: `รหัส CRC16 ไม่ตรงกัน (คาดหวัง ${expectedCrc}, พบ ${tag63.value})`,
    };
  }

  const countryNode = nodes.find((n) => n.tag === '58');
  const countryCode = (countryNode?.value ?? '').toUpperCase();
  if (countryCode !== 'LA') {
    return {
      valid: false,
      normalizedTemplate: '',
      merchantAccountTag: '',
      merchantName: '',
      merchantCity: '',
      countryCode,
      currencyNumeric: nodes.find((n) => n.tag === '53')?.value ?? '',
      crcValid: true,
      errorReason: `QR นี้ไม่ใช่ประเทศ สปป.ลาว (Tag 58 = '${countryCode || 'NONE'}' ต้องเป็น 'LA')`,
    };
  }

  const merchantNode =
    nodes.find((n) => n.tag === '38') ??
    nodes.find((n) => {
      const nNum = Number(n.tag);
      return nNum >= 26 && nNum <= 51;
    });
  if (!merchantNode) {
    return {
      valid: false,
      normalizedTemplate: '',
      merchantAccountTag: '',
      merchantName: '',
      merchantCity: '',
      countryCode,
      currencyNumeric: nodes.find((n) => n.tag === '53')?.value ?? '',
      crcValid: true,
      errorReason: 'ไม่พบข้อมูลบัญชีร้านค้า LAOQR / BCEL OnePay (Tag 26–51 / Tag 38)',
    };
  }

  const currencyNode = nodes.find((n) => n.tag === '53');
  const currencyNumeric = currencyNode?.value ?? '418';
  const merchantName = nodes.find((n) => n.tag === '59')?.value ?? '';
  const merchantCity = nodes.find((n) => n.tag === '60')?.value ?? '';

  return {
    valid: true,
    normalizedTemplate: trimmed,
    merchantAccountTag: merchantNode.tag,
    merchantName,
    merchantCity,
    countryCode,
    currencyNumeric,
    crcValid: true,
  };
}

export function generateOfflineLaoQrDynamicQr(
  staticTemplateRaw: string,
  amountSatang: Satang,
  billReference?: string
): { payload: string; crcHex: string; wholeLakAmount: number; merchantName: string } {
  if (!Number.isSafeInteger(amountSatang) || amountSatang <= 0) {
    throw new RangeError(`amountSatang must be a positive safe integer, got ${amountSatang}`);
  }
  const validated = validateLaoQrStaticTemplate(staticTemplateRaw);
  if (!validated.valid) {
    throw new Error(
      validated.errorReason ||
        'ยังไม่ได้ตั้งค่าแม่แบบ LAOQR / BCEL OnePay หรือรูปแบบ QR ไม่ถูกต้อง'
    );
  }
  const wholeLakAmount = Number(roundDivBigInt(BigInt(amountSatang), 100n));
  if (wholeLakAmount <= 0) {
    throw new RangeError(`LAK dynamic QR amount must be >= 1 LAK, got ${wholeLakAmount}`);
  }

  const baseNodes = parseEmvCoTlv(validated.normalizedTemplate)!;
  const filtered: EmvCoTlvNode[] = [];
  let hasTag01 = false;
  let hasTag53 = false;
  let hasTag54 = false;

  for (const node of baseNodes) {
    if (node.tag === '63') continue;
    if (node.tag === '01') {
      filtered.push({ tag: '01', value: '12' });
      hasTag01 = true;
      continue;
    }
    if (node.tag === '53') {
      filtered.push({ tag: '53', value: '418' });
      hasTag53 = true;
      continue;
    }
    if (node.tag === '54') {
      filtered.push({ tag: '54', value: String(wholeLakAmount) });
      hasTag54 = true;
      continue;
    }
    filtered.push({ ...node });
  }

  if (!hasTag01) {
    filtered.splice(1, 0, { tag: '01', value: '12' });
  }
  if (!hasTag53) {
    const idx58 = filtered.findIndex((n) => n.tag === '58');
    const insertIdx = idx58 >= 0 ? idx58 : filtered.length;
    filtered.splice(insertIdx, 0, { tag: '53', value: '418' });
  }
  if (!hasTag54) {
    const idx53 = filtered.findIndex((n) => n.tag === '53');
    const insertIdx = idx53 >= 0 ? idx53 + 1 : filtered.length;
    filtered.splice(insertIdx, 0, { tag: '54', value: String(wholeLakAmount) });
  }

  const cleanRef = (billReference ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
  if (cleanRef.length > 0 && !filtered.some((n) => n.tag === '62')) {
    filtered.push({ tag: '62', value: formatEmvTlv('01', cleanRef) });
  }

  const { payload, crcHex } = serializeEmvCoTlvWithCrc(filtered);
  return {
    payload,
    crcHex,
    wholeLakAmount,
    merchantName: validated.merchantName,
  };
}

export function buildSampleStaticLaoQrTemplate(
  merchantName = 'RUBE LAO SHOP',
  merchantCity = 'VIENTIANE',
  merchantId = 'MCH-LAO-00001'
): string {
  const cleanName = merchantName.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 25) || 'RUBE LAO SHOP';
  const cleanCity = merchantCity.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 15) || 'VIENTIANE';
  const cleanMid = merchantId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'MCH-LAO-00001';
  const tag38Value =
    formatEmvTlv('00', 'A0000005241010') +
    formatEmvTlv('01', 'BCEL') +
    formatEmvTlv('02', cleanMid);
  const { payload } = serializeEmvCoTlvWithCrc([
    { tag: '00', value: '01' },
    { tag: '01', value: '11' },
    { tag: '38', value: tag38Value },
    { tag: '52', value: '5999' },
    { tag: '53', value: '418' },
    { tag: '58', value: 'LA' },
    { tag: '59', value: cleanName },
    { tag: '60', value: cleanCity },
  ]);
  return payload;
}
