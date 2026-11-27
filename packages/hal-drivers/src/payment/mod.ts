/**
 * RUBE-STOCK-POS v3.1 Offline EMVCo PromptPay QR Generator & BOT Slip Mini-QR Verifier (`PAYMENT_HAL`)
 *
 * Enforces `ARCHITECTURE.md` Section 6.3:
 * 1. Offline Dynamic PromptPay QR (Tag `01` = `12`, Tag `54` Exact Bill Amount, CRC16-CCITT `0x1021`)
 * 2. BOT Slip Mini-QR TLV Structural Verification + SHA-256 Deduplication + Mandatory Visual Bank/Amount Prompt
 */

import { createHash } from 'node:crypto';
import type { Satang } from '../../../shared-contracts/src/fixed-point.ts';
import {
  type LocaleCode,
  formatMoney,
} from '../../../shared-contracts/src/currency.ts';
import {
  type EmvCoTlvNode,
  type LaoBankOption,
  type ValidatedLaoQrTemplate,
  LAO_BANKS,
  buildSampleStaticLaoQrTemplate,
  computeCrc16CcittHex,
  formatEmvTlv,
  generateOfflineLaoQrDynamicQr,
  getLaoBankDisplayName,
  parseEmvCoTlv,
  serializeEmvCoTlvWithCrc,
  validateLaoQrStaticTemplate,
} from '../../../shared-contracts/src/lao-payment.ts';
import type { BotSlipVerificationResult } from '../../../shared-contracts/src/hal-events.ts';

export {
  type EmvCoTlvNode,
  type LaoBankOption,
  type ValidatedLaoQrTemplate,
  LAO_BANKS,
  buildSampleStaticLaoQrTemplate,
  computeCrc16CcittHex,
  generateOfflineLaoQrDynamicQr,
  getLaoBankDisplayName,
  parseEmvCoTlv,
  serializeEmvCoTlvWithCrc,
  validateLaoQrStaticTemplate,
};

const formatTlv = formatEmvTlv;

const THAI_BANK_NAMES: Readonly<Record<string, string>> = {
  '002': 'ธนาคารกรุงเทพ (BBL)',
  '004': 'ธนาคารกสิกรไทย (KBANK)',
  '006': 'ธนาคารกรุงไทย (KTB)',
  '011': 'ธนาคารทหารไทยธนชาต (ttb)',
  '014': 'ธนาคารไทยพาณิชย์ (SCB)',
  '025': 'ธนาคารกรุงศรีอยุธยา (BAY)',
  '030': 'ธนาคารออมสิน (GSB)',
};

/**
 * Verifies a Lao Bank Transfer Slip Reference / QR payload in 100% Offline Mode:
 * - Accepts either a direct transfer Reference/Ticket ID (4–64 alphanumeric chars) OR a scanned bank slip QR string
 * - Computes SHA-256 hash of `LA:${bankCode}:${normalizedRef}` to prevent duplicate slip reuse
 * - Always flags `requiresVisualAmountConfirmation = true` so cashier verifies actual Kip transfer amount
 */
export function verifyOfflineLaoTransferSlip(
  rawRefOrQr: string,
  senderBankCodeRaw: string,
  expectedAmountSatang: Satang,
  usedSlipHashes: Set<string>,
  options?: VerifyBotSlipOptions & { locale?: LocaleCode | undefined }
): BotSlipVerificationResult {
  const bankCode = (senderBankCodeRaw || 'BCEL').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'BCEL';
  const locale = options?.locale ?? 'lo';
  const bankDisplayName = getLaoBankDisplayName(bankCode, locale);
  const cleaned = rawRefOrQr.trim().replace(/\s+/g, '');

  if (cleaned.length < 4 || cleaned.length > 160) {
    return {
      validFormat: false,
      isDuplicate: false,
      senderBankCode: bankCode,
      senderBankNameThai: bankDisplayName,
      transRef: '',
      transRefLast4: '',
      transRefSha256Hex: '',
      expectedAmountSatang,
      requiresVisualAmountConfirmation: true,
      errorReason:
        locale === 'lo'
          ? 'ກະລຸນາປ້ອນ ຫຼື ສະແກນເລກອ້າງອີງສະລິບໂອນເງິນ (ຢ່າງໜ້ອຍ 4 ຕົວອັກສອນ)'
          : locale === 'en'
            ? 'Please enter or scan the bank transfer reference / ticket ID (at least 4 characters)'
            : 'กรุณากรอกหรือสแกนเลขที่อ้างอิงสลิปโอนเงิน (อย่างน้อย 4 ตัวอักษร)',
    };
  }

  // Canonicalize reference string (preserve alphanumeric + _ - for hash determinism)
  const canonicalRef = cleaned.toUpperCase();
  const transRefSha256Hex = createHash('sha256')
    .update(`LA:${bankCode}:${canonicalRef}`)
    .digest('hex');

  const isDuplicate = usedSlipHashes.has(transRefSha256Hex);
  const shouldCommit = options?.commitSlipHash ?? true;
  if (!isDuplicate && shouldCommit) {
    usedSlipHashes.add(transRefSha256Hex);
  }

  return {
    validFormat: true,
    isDuplicate,
    senderBankCode: bankCode,
    senderBankNameThai: bankDisplayName,
    transRef: canonicalRef,
    transRefLast4: canonicalRef.slice(-4),
    transRefSha256Hex,
    expectedAmountSatang,
    requiresVisualAmountConfirmation: true,
    ...(isDuplicate
      ? {
          errorReason:
            locale === 'lo'
              ? 'ກວດພົບການໃຊ້ສະລິບໂອນເງິນຊ້ຳ! (Duplicate Slip Fraud Alert)'
              : locale === 'en'
                ? 'Duplicate transfer slip reference detected! (Duplicate Slip Fraud Alert)'
                : 'ตรวจพบการใช้สลิปโอนเงินซ้ำ! (Duplicate Slip Fraud Alert)',
        }
      : {}),
  };
}

export function buildTwoPhaseLaoSlipConfirmationModal(
  rawRefOrQr: string,
  senderBankCode: string,
  expectedAmountSatang: Satang,
  usedSlipHashes: Set<string>,
  locale: LocaleCode = 'lo'
): TwoPhaseSlipConfirmationModalModel {
  const verification = verifyOfflineLaoTransferSlip(
    rawRefOrQr,
    senderBankCode,
    expectedAmountSatang,
    usedSlipHashes,
    { commitSlipHash: false, locale }
  );

  const expectedAmountFormatted = formatMoney(expectedAmountSatang, 'LAK');
  const warningText =
    locale === 'lo'
      ? 'ກະລຸນາກວດສອບຍອດເງິນໃນແອັບທະນາຄານ/ສຽງແຈ້ງເຕືອນ OnePay ໃຫ້ຕົງກັບຍອດສຸດທິຂ້າງເທິງກ່ອນກົດຢືນຢັນ'
      : locale === 'en'
        ? 'Please verify the exact LAK amount received in your bank app / OnePay notification before confirming'
        : 'โปรดตรวจสอบยอดเงินกีบในแอปธนาคาร/เสียงแจ้งเตือน OnePay ให้ตรงกับยอดสุทธิขนาดใหญ่ด้านบนก่อนกดยืนยัน';

  return {
    canProceedToStep2Confirm: verification.validFormat && !verification.isDuplicate,
    verification,
    expectedAmountSatang,
    expectedAmountFormatted,
    senderBankCode: verification.senderBankCode,
    senderBankNameThai: verification.senderBankNameThai,
    transRefLast4: verification.transRefLast4,
    antiFraudWarningBannerThai: warningText,
  };
}

/**
 * Generates an Offline Dynamic EMVCo PromptPay QR Payload string for a given Merchant ID (Phone 10 digits or Tax ID 13 digits)
 * and exact bill amount in Satang.
 */
export function generateOfflinePromptPayDynamicQr(
  merchantPromptPayId: string,
  amountSatang: Satang
): { payload: string; crcHex: string } {
  if (!Number.isSafeInteger(amountSatang) || amountSatang <= 0) {
    throw new RangeError(`amountSatang must be a positive safe integer, got ${amountSatang}`);
  }
  const cleanId = merchantPromptPayId.replace(/\D/g, '');
  let subTagAccount: string;
  if (cleanId.length === 10) {
    // Mobile number: 0066 + 9 digits
    subTagAccount = formatTlv('01', `0066${cleanId.slice(1)}`);
  } else if (cleanId.length === 13) {
    // National ID / Tax ID
    subTagAccount = formatTlv('02', cleanId);
  } else if (cleanId.length === 15) {
    // e-Wallet ID
    subTagAccount = formatTlv('03', cleanId);
  } else {
    throw new Error(`Invalid PromptPay Merchant ID length: ${cleanId.length}`);
  }

  const merchantAccountInfo = formatTlv('00', 'A000000677010111') + subTagAccount;
  const wholeBaht = Math.floor(amountSatang / 100);
  const satangPart = String(amountSatang % 100).padStart(2, '0');
  const amountBahtFormatted = `${wholeBaht}.${satangPart}`;

  const bodyWithoutCrc =
    formatTlv('00', '01') + // Payload Format Indicator
    formatTlv('01', '12') + // Point of Initiation Method: 12 = Dynamic QR
    formatTlv('29', merchantAccountInfo) +
    formatTlv('53', '764') + // Currency: THB (764)
    formatTlv('54', amountBahtFormatted) + // Transaction Amount
    formatTlv('58', 'TH') + // Country Code
    '6304'; // CRC Tag + Length

  const crcHex = computeCrc16CcittHex(bodyWithoutCrc);
  return {
    payload: `${bodyWithoutCrc}${crcHex}`,
    crcHex,
  };
}

export interface VerifyBotSlipOptions {
  /**
   * When `false`, checks for duplicate hash without mutating `usedSlipHashes` yet
   * (allowing two-phase cashier visual confirmation before calling `commitVerifiedBotSlipHash`).
   * Defaults to `true` for single-step callers.
   */
  commitSlipHash?: boolean;
}

export function commitVerifiedBotSlipHash(
  transRefSha256Hex: string,
  usedSlipHashes: Set<string>
): boolean {
  if (!transRefSha256Hex || usedSlipHashes.has(transRefSha256Hex)) {
    return false;
  }
  usedSlipHashes.add(transRefSha256Hex);
  return true;
}

/**
 * Verifies a scanned 2D Mini-QR from a Thai bank transfer slip in 100% Offline Mode:
 * - Validates BOT Slip Mini-QR structure (starts with `00` TLV containing `000001` API ID, Subtag `01` 3-digit Bank Code, Subtag `02` TransRef)
 * - Enforces exact TLV length matching (`outerTag00Len === 21 + declaredLen` and `transRef.length === declaredLen`)
 * - Computes SHA-256 hash of `senderBankCode:transRef` to block duplicate slip fraud
 * - Returns structured metadata for the Mandatory Visual Amount Confirmation Modal
 */
export function verifyOfflineBotSlipMiniQr(
  miniQrRaw: string,
  expectedAmountSatang: Satang,
  usedSlipHashes: Set<string>,
  options?: VerifyBotSlipOptions
): BotSlipVerificationResult {
  // BOT Mini-QR canonical header: Tag 00 + 2-digit outer length + 0006000001 + 0103<BankCode> + 02<Len><TransRef...>
  const botMatch = /^00(\d{2})00060000010103(\d{3})02(\d{2})([A-Za-z0-9_-]+)$/.exec(
    miniQrRaw.trim()
  );

  if (!botMatch) {
    return {
      validFormat: false,
      isDuplicate: false,
      senderBankCode: '',
      senderBankNameThai: 'ไม่ทราบธนาคาร',
      transRef: '',
      transRefLast4: '',
      transRefSha256Hex: '',
      expectedAmountSatang,
      requiresVisualAmountConfirmation: true,
      errorReason: 'รูปแบบ QR ไม่ใช่สลิปโอนเงินมาตรฐานธนาคารแห่งประเทศไทย (Invalid BOT Slip Mini-QR)',
    };
  }

  const outerTlvLen = Number(botMatch[1]!);
  const senderBankCode = botMatch[2]!;
  const declaredLen = Number(botMatch[3]!);
  const tailPayload = botMatch[4]!;

  // Validate exact TLV length integrity:
  // "0006000001" (10) + "0103" (4) + BankCode (3) + "02" (2) + Len (2) + TransRef (declaredLen) = 21 + declaredLen
  if (
    declaredLen < 8 ||
    declaredLen > 64 ||
    tailPayload.length < declaredLen ||
    outerTlvLen !== 21 + declaredLen
  ) {
    return {
      validFormat: false,
      isDuplicate: false,
      senderBankCode,
      senderBankNameThai: THAI_BANK_NAMES[senderBankCode] ?? `รหัสธนาคาร ${senderBankCode}`,
      transRef: tailPayload.slice(0, declaredLen),
      transRefLast4: '',
      transRefSha256Hex: '',
      expectedAmountSatang,
      requiresVisualAmountConfirmation: true,
      errorReason: 'ความยาว TLV หรือรหัสอ้างอิงธุรกรรม (TransRef) ใน Mini-QR ไม่สมบูรณ์',
    };
  }

  const transRef = tailPayload.slice(0, declaredLen);

  const transRefSha256Hex = createHash('sha256')
    .update(`${senderBankCode}:${transRef}`)
    .digest('hex');

  const isDuplicate = usedSlipHashes.has(transRefSha256Hex);
  const shouldCommit = options?.commitSlipHash ?? true;
  if (!isDuplicate && shouldCommit) {
    usedSlipHashes.add(transRefSha256Hex);
  }

  return {
    validFormat: true,
    isDuplicate,
    senderBankCode,
    senderBankNameThai: THAI_BANK_NAMES[senderBankCode] ?? `รหัสธนาคาร ${senderBankCode}`,
    transRef,
    transRefLast4: transRef.slice(-4),
    transRefSha256Hex,
    expectedAmountSatang,
    requiresVisualAmountConfirmation: true,
    ...(isDuplicate
      ? { errorReason: 'ตรวจพบการใช้สลิปโอนเงินซ้ำ! (Duplicate Slip Fraud Alert)' }
      : {}),
  };
}

export interface TwoPhaseSlipConfirmationModalModel {
  canProceedToStep2Confirm: boolean;
  verification: BotSlipVerificationResult;
  expectedAmountSatang: Satang;
  expectedAmountFormatted: string;
  senderBankCode: string;
  senderBankNameThai: string;
  transRefLast4: string;
  antiFraudWarningBannerThai: string;
}

/**
 * Phase 2 (`PAYMENT_HAL` — WBS-09): Step 1 of Two-Phase Slip Confirmation.
 * Verifies the BOT Mini-QR structure and checks for duplicate hash WITHOUT committing the hash yet,
 * returning the mandatory visual confirmation modal model so the cashier can verify the bank & exact amount
 * before pressing "Confirm Payment" (Step 2).
 */
export function buildTwoPhaseSlipConfirmationModal(
  miniQrRaw: string,
  expectedAmountSatang: Satang,
  usedSlipHashes: Set<string>
): TwoPhaseSlipConfirmationModalModel {
  const verification = verifyOfflineBotSlipMiniQr(
    miniQrRaw,
    expectedAmountSatang,
    usedSlipHashes,
    { commitSlipHash: false }
  );

  const whole = Math.floor(expectedAmountSatang / 100);
  const frac = String(expectedAmountSatang % 100).padStart(2, '0');
  const expectedAmountFormatted = `฿${whole.toLocaleString('en-US')}.${frac}`;

  return {
    canProceedToStep2Confirm: verification.validFormat && !verification.isDuplicate,
    verification,
    expectedAmountSatang,
    expectedAmountFormatted,
    senderBankCode: verification.senderBankCode,
    senderBankNameThai: verification.senderBankNameThai,
    transRefLast4: verification.transRefLast4,
    antiFraudWarningBannerThai:
      'โปรดตรวจสอบยอดเงินบนสลิป/แจ้งเตือนเงินเข้าให้ตรงกับยอดสุทธิขนาดใหญ่ด้านบน (ป้องกันสลิปโอน 1 บาทตัดต่อตัวเลข)',
  };
}

