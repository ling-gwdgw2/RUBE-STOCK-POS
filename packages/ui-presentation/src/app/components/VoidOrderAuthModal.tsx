import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Delete, KeyRound, RotateCcw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import { posTransport } from '../api/pos-transport.ts';
import { pickLocaleText, useI18n } from '../i18n/index.tsx';
import type { StaffUserDto } from '../types.ts';
import { resolveDigitFromKeyboardEvent } from '../utils/keyboard-digits.ts';
import { canApproveVoidWithoutOverride } from '../utils/rbac.ts';
import { ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

export type VoidTargetMode =
  | 'SALES_ORDER_VOID'
  | 'HELD_BILL_VOID'
  | 'HELD_BILL_ITEM_VOID';

export interface VoidTargetOrderSummary {
  mode?: VoidTargetMode | undefined;
  salesOrderId: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string | null;
  totalSatang: number;
  subtitle?: string | undefined;
}

interface VoidOrderAuthModalProps {
  open: boolean;
  order: VoidTargetOrderSummary | null;
  currentUser: StaffUserDto;
  onClose: () => void;
  onVoidAuthorized: (params: {
    salesOrderId: string;
    receiptNumber: string;
    voidedByUserId: string;
    voidReason: string;
    overrideToken?: string | undefined;
  }) => Promise<void>;
}

function getSalesVoidReasonPresets(
  locale: LocaleCode
): ReadonlyArray<{ id: string; label: string }> {
  return [
    {
      id: 'WRONG_ITEM',
      label: pickLocaleText(
        locale,
        'คีย์รายการสินค้าหรือจำนวนผิด',
        'ປ້ອນລາຍການສິນຄ້າ ຫຼື ຈຳນວນຜິດ',
        'Wrong item or quantity entered'
      ),
    },
    {
      id: 'CUSTOMER_CANCEL',
      label: pickLocaleText(
        locale,
        'ลูกค้าเปลี่ยนใจ / ขอคืนสินค้า',
        'ລູກຄ້າປ່ຽນໃຈ / ຂໍຄືນສິນຄ້າ',
        'Customer changed mind / return requested'
      ),
    },
    {
      id: 'CHANGE_PAYMENT',
      label: pickLocaleText(
        locale,
        'เปลี่ยนช่องทางรับชำระเงิน',
        'ປ່ຽນຊ່ອງທາງຮັບຊຳລະເງິນ',
        'Change payment method'
      ),
    },
    {
      id: 'CUSTOM',
      label: pickLocaleText(
        locale,
        'ระบุเหตุผลอื่นเพิ่มเติม',
        'ລະບຸເຫດຜົນອື່ນເພີ່ມເຕີມ',
        'Specify another reason'
      ),
    },
  ];
}

function getHeldBillVoidReasonPresets(
  locale: LocaleCode
): ReadonlyArray<{ id: string; label: string }> {
  return [
    {
      id: 'CUSTOMER_CANCEL_TABLE',
      label: pickLocaleText(
        locale,
        'ลูกค้าขอยกเลิกรายการก่อนรับของ',
        'ລູກຄ້າຂໍຍົກເລີກລາຍການກ່ອນຮັບອາຫານ',
        'Customer cancelled before serving'
      ),
    },
    {
      id: 'OUT_OF_STOCK_KITCHEN',
      label: pickLocaleText(
        locale,
        'ครัวแจ้งวัตถุดิบหมด / ไม่สามารถทำได้',
        'ຄົວແຈ້ງວັດຖຸດິບໝົດ / ບໍ່ສາມາດເຮັດໄດ້',
        'Kitchen out of stock / cannot prepare'
      ),
    },
    {
      id: 'WRONG_TABLE',
      label: pickLocaleText(
        locale,
        'เปิดโต๊ะผิด / รวมบิลซ้ำ',
        'ເປີດໂຕະຜິດ / ລວມບິນຊ້ຳ',
        'Wrong table opened / duplicate bill'
      ),
    },
    {
      id: 'CUSTOM',
      label: pickLocaleText(
        locale,
        'ระบุเหตุผลอื่นเพิ่มเติม',
        'ລະບຸເຫດຜົນອື່ນເພີ່ມເຕີມ',
        'Specify another reason'
      ),
    },
  ];
}

export const VoidOrderAuthModal: React.FC<VoidOrderAuthModalProps> = ({
  open,
  order,
  currentUser,
  onClose,
  onVoidAuthorized,
}) => {
  const { locale, money, pick } = useI18n();
  const uid = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const requiresManagerPin = !canApproveVoidWithoutOverride(currentUser.role);
  const mode: VoidTargetMode = order?.mode ?? 'SALES_ORDER_VOID';
  const reasonPresets = useMemo(
    () =>
      mode === 'SALES_ORDER_VOID'
        ? getSalesVoidReasonPresets(locale)
        : getHeldBillVoidReasonPresets(locale),
    [locale, mode]
  );

  const [selectedPresetId, setSelectedPresetId] = useState<string>(reasonPresets[0]!.id);
  const [customNote, setCustomNote] = useState<string>('');
  const [managerPin, setManagerPin] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      const nextPresets =
        (order?.mode ?? 'SALES_ORDER_VOID') === 'SALES_ORDER_VOID'
          ? getSalesVoidReasonPresets(locale)
          : getHeldBillVoidReasonPresets(locale);
      setSelectedPresetId(nextPresets[0]!.id);
      setCustomNote('');
      setManagerPin('');
      setErrorMsg(null);
      setSubmitting(false);
    }
  }, [locale, open, order?.salesOrderId, order?.mode, order?.subtitle]);

  const appendDigit = useCallback((digit: string) => {
    setErrorMsg(null);
    setManagerPin((prev) => (prev.length < 8 ? prev + digit : prev));
  }, []);

  const buildReasonText = useCallback((): string | null => {
    const preset = reasonPresets.find((p) => p.id === selectedPresetId);
    const trimmedNote = customNote.trim();
    if (selectedPresetId === 'CUSTOM') {
      if (trimmedNote.length < 4) {
        return null;
      }
      return trimmedNote;
    }
    const base =
      preset?.label ??
      pick('ยกเลิกรายการ', 'ຍົກເລີກລາຍການ', 'Void order item');
    return trimmedNote ? `${base} (${trimmedNote})` : base;
  }, [customNote, pick, reasonPresets, selectedPresetId]);

  const handleSubmit = useCallback(async () => {
    if (!order || submitting) return;

    const reasonText = buildReasonText();
    if (!reasonText) {
      setErrorMsg(
        pick(
          'กรุณาระบุรายละเอียดเหตุผลการยกเลิกบิลอย่างน้อย 4 ตัวอักษร',
          'ກະລຸນາລະບຸເຫດຜົນການຍົກເລີກບິນຢ່າງໜ້ອຍ 4 ຕົວອັກສອນ',
          'Please enter a void reason of at least 4 characters.'
        )
      );
      return;
    }

    if (requiresManagerPin && managerPin.length < 4) {
      setErrorMsg(
        pick(
          'กรุณาให้ผู้จัดการหรือเจ้าของร้านกดรหัส PIN อนุมัติอย่างน้อย 4 หลัก',
          'ກະລຸນາໃຫ້ຜູ້ຈັດການ ຫຼື ເຈົ້າຂອງຮ້ານປ້ອນລະຫັດ PIN ອະນຸມັດຢ່າງໜ້ອຍ 4 ຫຼັກ',
          'A manager or owner must enter an approval PIN (at least 4 digits).'
        )
      );
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      let approver = currentUser;
      let overrideToken: string | undefined;
      if (requiresManagerPin) {
        const authRes = await posTransport.verifyManagerOverridePin(managerPin);
        if (!canApproveVoidWithoutOverride(authRes.user.role)) {
          setManagerPin('');
          setErrorMsg(
            pick(
              `รหัส PIN ของ "${authRes.user.displayName}" เป็นสิทธิ์ ${authRes.user.role} — ต้องใช้รหัสของ MANAGER หรือ OWNER เท่านั้น`,
              `ລະຫັດ PIN ຂອງ "${authRes.user.displayName}" ເປັນສິດ ${authRes.user.role} — ຕ້ອງໃຊ້ລະຫັດຂອງ MANAGER ຫຼື OWNER ເທົ່ານັ້ນ`,
              `PIN belongs to "${authRes.user.displayName}" (${authRes.user.role}) — MANAGER or OWNER PIN required.`
            )
          );
          setSubmitting(false);
          return;
        }
        approver = authRes.user;
        overrideToken = authRes.overrideToken || undefined;
      }

      const auditReason = requiresManagerPin
        ? `${reasonText} [${pick(
            `แคชเชียร์: ${currentUser.displayName} · อนุมัติโดย: ${approver.displayName}`,
            `ພະນັກງານຂາຍ: ${currentUser.displayName} · ອະນຸມັດໂດຍ: ${approver.displayName}`,
            `Cashier: ${currentUser.displayName} · Approved by: ${approver.displayName}`
          )}]`
        : `${reasonText} [${pick(
            `ดำเนินการโดย: ${approver.displayName}`,
            `ດຳເນີນການໂດຍ: ${approver.displayName}`,
            `Authorized by: ${approver.displayName}`
          )}]`;

      await onVoidAuthorized({
        salesOrderId: order.salesOrderId,
        receiptNumber: order.receiptNumber,
        voidedByUserId: approver.id,
        voidReason: auditReason,
        ...(overrideToken ? { overrideToken } : {}),
      });
      onClose();
    } catch (err) {
      setManagerPin('');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    buildReasonText,
    currentUser,
    managerPin,
    onClose,
    onVoidAuthorized,
    order,
    pick,
    requiresManagerPin,
    submitting,
  ]);

  useEffect(() => {
    if (!open || !requiresManagerPin) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const dialogEl = contentRef.current?.closest('[role="dialog"]');
      if (dialogEl && dialogEl.getAttribute('data-rube-modal-topmost') === 'false') {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (submitting) return;
      const digit = resolveDigitFromKeyboardEvent(e);
      if (digit !== null) {
        e.preventDefault();
        appendDigit(digit);
      } else if (e.key === 'Backspace' || e.code === 'Backspace') {
        e.preventDefault();
        setManagerPin((p) => p.slice(0, -1));
      } else if (
        (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') &&
        managerPin.length >= 4
      ) {
        e.preventDefault();
        void handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appendDigit, handleSubmit, managerPin.length, open, requiresManagerPin, submitting]);

  return (
    <ModalDialog
      open={open && Boolean(order)}
      onClose={() => {
        if (!submitting) onClose();
      }}
      canDismiss={!submitting}
      labelledBy={`${uid}-void-title`}
      maxWidthClass="max-w-lg"
    >
      {order && (
        <>
          <div ref={contentRef} className="flex items-center justify-between border-b border-hairline px-6 py-4 shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-1 border border-hairline text-ink">
                <RotateCcw className="h-5 w-5" />
              </div>
              <div>
                <h2
                  id={`${uid}-void-title`}
                  className="font-google-display text-[20px] font-normal text-ink"
                >
                  {mode === 'HELD_BILL_VOID'
                    ? `${pick('อนุมัติยกเลิกบิลพัก', 'ອະນຸມັດຍົກເລີກບິນພັກ', 'Approve Void Held Bill')} ${order.receiptNumber}`
                    : mode === 'HELD_BILL_ITEM_VOID'
                      ? `${pick('อนุมัติลด/ลบรายการบิลพัก', 'ອະນຸມັດຫຼຸດ/ລຶບລາຍການບິນພັກ', 'Approve Held Item Void')} (${order.receiptNumber})`
                      : `${pick('อนุมัติยกเลิกบิล', 'ອະນຸມັດຍົກເລີກບິນ', 'Approve Void Order')} ${order.receiptNumber}`}
                </h2>
                <p className="text-xs text-ink-muted tabular-nums-google">
                  {order.subtitle
                    ? order.subtitle
                    : `${pick('ยอดสุทธิ', 'ຍອດສຸດທິ', 'Net Total')} ${money(order.totalSatang)} · ${
                        mode === 'SALES_ORDER_VOID'
                          ? pick('คืนสต็อกตามต้นทุนเดิม ณ เวลาขาย', 'ຄືນສະຕັອກຕາມຕົ້ນທຶນເດີມ', 'Restores stock at historical cost')
                          : pick('บันทึกลงสมุดบัญชีความปลอดภัยห้ามลบ/แก้ไข', 'ບັນທຶກລົງ Audit Log ທັນທີ', 'Recorded to immutable security audit log')
                      }`}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={submitting}
              aria-label={pick('ปิดหน้าต่างยกเลิก', 'ປິດໜ້າຕ່າງຍົກເລີກ', 'Close void dialog')}
              onClick={onClose}
              className={`flex h-10 w-10 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 space-y-5 overflow-y-auto flex-1">
            {/* Step 1: Mandatory Void Reason */}
            <div className="space-y-2.5">
              <div className="text-xs font-medium text-ink">
                {mode === 'SALES_ORDER_VOID'
                  ? pick(
                      '1. เลือกสาเหตุการยกเลิกบิล (บังคับบันทึกในสมุดบัญชี)',
                      '1. ເລືອກສາເຫດການຍົກເລີກບິນ (ບັງຄັບບັນທຶກລົງບັນຊີ)',
                      '1. Select void reason (recorded in immutable ledger)'
                    )
                  : pick(
                      '1. เลือกสาเหตุการลด/ยกเลิกรายการบิลพัก (บังคับบันทึก Audit Log)',
                      '1. ເລືອກສາເຫດການຫຼຸດ/ຍົກເລີກລາຍການບິນພັກ (ບັງຄັບບັນທຶກ Audit Log)',
                      '1. Select held bill modification reason (logged in Audit Log)'
                    )}
              </div>
              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                role="radiogroup"
                aria-label={pick('สาเหตุการยกเลิก', 'ສາເຫດການຍົກເລີກ', 'Void reason')}
              >
                {reasonPresets.map((preset) => {
                  const active = selectedPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setSelectedPresetId(preset.id);
                        setErrorMsg(null);
                      }}
                      className={`min-h-[44px] rounded-[4px] border px-3.5 py-2 text-left text-xs font-medium ${UI_INTERACTION.focusButton} ${
                        active
                          ? 'border-primary bg-primary-soft text-primary-dark'
                          : 'border-hairline bg-canvas text-ink-soft hover:border-primary'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              <div>
                <label
                  htmlFor={`${uid}-void-note`}
                  className="block text-xs font-medium text-ink-muted mb-1"
                >
                  {selectedPresetId === 'CUSTOM'
                    ? pick(
                        'ระบุเหตุผลการยกเลิกบิล (บังคับกรอก)',
                        'ລະບຸເຫດຜົນການຍົກເລີກບິນ (ບັງຄັບປ້ອນ)',
                        'Specify void reason (required)'
                      )
                    : pick(
                        'หมายเหตุเพิ่มเติม (ถ้ามี)',
                        'ໝາຍເຫດເພີ່ມເຕີມ (ຖ້າມີ)',
                        'Additional note (optional)'
                      )}
                </label>
                <input
                  id={`${uid}-void-note`}
                  type="text"
                  value={customNote}
                  onChange={(e) => {
                    setCustomNote(e.target.value);
                    setErrorMsg(null);
                  }}
                  placeholder={
                    selectedPresetId === 'CUSTOM'
                      ? pick(
                          'เช่น ลูกค้าแจ้งเปลี่ยนเป็นบิลใบกำกับภาษีเต็มรูป...',
                          'ເຊັ່ນ ລູກຄ້າຂໍປ່ຽນເປັນໃບບິນອາກອນເຕັມຮູບແບບ...',
                          'e.g., Customer requested full tax invoice...'
                        )
                      : pick(
                          'ระบุรายละเอียดเพิ่มเติมเพื่อการตรวจสอบ...',
                          'ລະບຸລາຍລະອຽດເພີ່ມເຕີມເພື່ອການກວດສອບ...',
                          'Enter audit details (optional)...'
                        )
                  }
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-xs text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>

            {/* Step 2: Stateless Manager PIN Override when currentUser is CASHIER */}
            {requiresManagerPin ? (
              <div className="rounded-[8px] bg-primary-soft p-4 space-y-3 border border-primary/25">
                <div className="flex items-start gap-2.5">
                  <KeyRound className="h-4 w-4 text-primary-dark shrink-0 mt-0.5" />
                  <div className="text-xs">
                    <div className="font-google-display font-medium text-primary-dark">
                      {pick(
                        '2. รหัส PIN อนุมัติโดยผู้จัดการ / เจ้าของร้าน (Manager Override)',
                        '2. ລະຫັດ PIN ອະນຸມັດໂດຍຜູ້ຈັດການ / ເຈົ້າຂອງຮ້ານ (Manager Override)',
                        '2. Manager / Owner Approval PIN (Manager Override)'
                      )}
                    </div>
                    <p className="text-ink-soft mt-0.5">
                      {pick(
                        `บัญชีปัจจุบัน (${currentUser.displayName}) เป็นสิทธิ์ ${currentUser.role} ต้องให้ผู้จัดการหรือเจ้าของร้านกดรหัส PIN ยืนยันโดยไม่ต้องสลับออกจากกะแคชเชียร์`,
                        `ບັນຊີປັດຈຸບັນ (${currentUser.displayName}) ເປັນສິດ ${currentUser.role} ຕ້ອງໃຫ້ຜູ້ຈັດການ ຫຼື ເຈົ້າຂອງຮ້ານປ້ອນລະຫັດ PIN ຢືນຢັນໂດຍບໍ່ຕ້ອງອອກຈາກກະພະນັກງານຂາຍ`,
                        `Current user (${currentUser.displayName}, ${currentUser.role}) requires a Manager or Owner PIN without switching cashier shift.`
                      )}
                    </p>
                  </div>
                </div>

                <div className="rounded-[4px] border border-hairline bg-canvas px-4 py-3 text-center">
                  <div
                    className="flex items-center justify-center gap-2.5 min-h-[20px]"
                    aria-label={pick(
                      `กรอกรหัสอนุมัติแล้ว ${managerPin.length} หลัก`,
                      `ປ້ອນລະຫັດອະນຸມັດແລ້ວ ${managerPin.length} ຫຼັກ`,
                      `Entered ${managerPin.length} approval PIN digit(s)`
                    )}
                  >
                    {Array.from({ length: Math.max(6, managerPin.length) }).map((_, i) => (
                      <span
                        key={i}
                        className={`h-3 w-3 rounded-full transition-colors duration-150 ${
                          i < managerPin.length ? 'bg-primary' : 'bg-hairline'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <button
                      key={digit}
                      type="button"
                      disabled={submitting}
                      onClick={() => appendDigit(digit)}
                      className={`h-11 rounded-[4px] border border-hairline bg-canvas font-google-display text-[18px] font-normal text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                    >
                      {digit}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => setManagerPin('')}
                    className={`h-11 rounded-[4px] border border-hairline bg-canvas text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                  >
                    {pick('ล้างรหัส', 'ລ້າງລະຫັດ', 'Clear')}
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => appendDigit('0')}
                    className={`h-11 rounded-[4px] border border-hairline bg-canvas font-google-display text-[18px] font-normal text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    aria-label={pick('ลบหลักสุดท้ายของรหัสอนุมัติ', 'ລຶບຫຼັກສຸດທ້າຍຂອງລະຫັດອະນຸມັດ', 'Backspace PIN digit')}
                    disabled={submitting}
                    onClick={() => setManagerPin((p) => p.slice(0, -1))}
                    className={`flex h-11 items-center justify-center rounded-[4px] border border-hairline bg-canvas text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
                  >
                    <Delete className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-[4px] border border-hairline bg-surface-1 px-4 py-3 flex items-center gap-2.5 text-xs text-ink-soft">
                <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                <span>
                  {pick('ดำเนินการในสิทธิ์อนุมัติของ', 'ດຳເນີນການໃນສິດອະນຸມັດຂອງ', 'Approving as')}{' '}
                  <strong className="text-ink">
                    {currentUser.displayName} ({currentUser.role})
                  </strong>
                </span>
              </div>
            )}

            {errorMsg && (
              <div
                role="alert"
                className="rounded-[4px] border border-ink bg-surface-1 p-3 flex items-start gap-2 text-xs text-ink"
              >
                <ShieldAlert className="h-4 w-4 text-ink shrink-0 mt-0.5" />
                <span className="font-medium">{errorMsg}</span>
              </div>
            )}
          </div>

          <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex flex-wrap items-center justify-end gap-2.5 shrink-0">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className={`h-[46px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-sm font-medium text-ink hover:border-ink ${UI_INTERACTION.focusButton}`}
            >
              {pick('ปิดหน้าต่าง', 'ປິດໜ້າຕ່າງ', 'Close')}
            </button>
            <button
              type="button"
              disabled={submitting || (requiresManagerPin && managerPin.length < 4)}
              onClick={() => void handleSubmit()}
              className={`h-[46px] rounded-[48px] bg-ink px-6 font-google-display text-sm font-medium tracking-[0.25px] text-white hover:bg-hero ${UI_INTERACTION.focusButton}`}
            >
              {submitting
                ? pick('กำลังบันทึก...', 'ກຳລັງບັນທຶກ...', 'Saving...')
                : requiresManagerPin
                  ? mode === 'HELD_BILL_ITEM_VOID'
                    ? pick(
                        'อนุมัติด้วย PIN & ลด/ลบรายการ',
                        'ອະນຸມັດດ້ວຍ PIN & ຫຼຸດ/ລຶບລາຍການ',
                        'Authorize with PIN & Void Item'
                      )
                    : mode === 'HELD_BILL_VOID'
                      ? pick(
                          'อนุมัติด้วย PIN & ยกเลิกบิลพัก',
                          'ອະນຸມັດດ້ວຍ PIN & ຍົກເລີກບິນພັກ',
                          'Authorize with PIN & Void Held Bill'
                        )
                      : pick(
                          'อนุมัติด้วย PIN & ยืนยันยกเลิกบิล',
                          'ອະນຸມັດດ້ວຍ PIN & ຢືນຢັນຍົກເລີກບິນ',
                          'Authorize with PIN & Void Order'
                        )
                  : mode === 'HELD_BILL_ITEM_VOID'
                    ? pick('ยืนยันลด/ลบรายการ', 'ຢືນຢັນຫຼຸດ/ລຶບລາຍການ', 'Confirm Void Item')
                    : mode === 'HELD_BILL_VOID'
                      ? pick('ยืนยันยกเลิกบิลพัก', 'ຢືນຢັນຍົກເລີກບິນພັກ', 'Confirm Void Held Bill')
                      : pick('ยืนยันยกเลิกบิล (Void)', 'ຢືນຢັນຍົກເລີກບິນ (Void)', 'Confirm Void Order')}
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
};
