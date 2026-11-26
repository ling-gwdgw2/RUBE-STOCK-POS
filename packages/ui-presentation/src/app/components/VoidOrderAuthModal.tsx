import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Delete, KeyRound, RotateCcw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { formatSatangToThbString } from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport } from '../api/pos-transport.ts';
import type { StaffUserDto } from '../types.ts';
import { resolveDigitFromKeyboardEvent } from '../utils/keyboard-digits.ts';
import { canApproveVoidWithoutOverride } from '../utils/rbac.ts';
import { ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

export interface VoidTargetOrderSummary {
  salesOrderId: string;
  receiptNumber: string;
  abbTaxInvoiceNo: string | null;
  totalSatang: number;
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

const VOID_REASON_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'WRONG_ITEM', label: 'คีย์รายการสินค้าหรือจำนวนผิด' },
  { id: 'CUSTOMER_CANCEL', label: 'ลูกค้าเปลี่ยนใจ / ขอคืนสินค้า' },
  { id: 'CHANGE_PAYMENT', label: 'เปลี่ยนช่องทางรับชำระเงิน' },
  { id: 'CUSTOM', label: 'ระบุเหตุผลอื่นเพิ่มเติม' },
];

export const VoidOrderAuthModal: React.FC<VoidOrderAuthModalProps> = ({
  open,
  order,
  currentUser,
  onClose,
  onVoidAuthorized,
}) => {
  const uid = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const requiresManagerPin = !canApproveVoidWithoutOverride(currentUser.role);

  const [selectedPresetId, setSelectedPresetId] = useState<string>('WRONG_ITEM');
  const [customNote, setCustomNote] = useState<string>('');
  const [managerPin, setManagerPin] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setSelectedPresetId('WRONG_ITEM');
      setCustomNote('');
      setManagerPin('');
      setErrorMsg(null);
      setSubmitting(false);
    }
  }, [open, order?.salesOrderId]);

  const appendDigit = useCallback((digit: string) => {
    setErrorMsg(null);
    setManagerPin((prev) => (prev.length < 8 ? prev + digit : prev));
  }, []);

  const buildReasonText = useCallback((): string | null => {
    const preset = VOID_REASON_PRESETS.find((p) => p.id === selectedPresetId);
    const trimmedNote = customNote.trim();
    if (selectedPresetId === 'CUSTOM') {
      if (trimmedNote.length < 4) {
        return null;
      }
      return trimmedNote;
    }
    const base = preset?.label ?? 'ยกเลิกรายการขาย';
    return trimmedNote ? `${base} (${trimmedNote})` : base;
  }, [customNote, selectedPresetId]);

  const handleSubmit = useCallback(async () => {
    if (!order || submitting) return;

    const reasonText = buildReasonText();
    if (!reasonText) {
      setErrorMsg('กรุณาระบุรายละเอียดเหตุผลการยกเลิกบิลอย่างน้อย 4 ตัวอักษร');
      return;
    }

    if (requiresManagerPin && managerPin.length < 4) {
      setErrorMsg('กรุณาให้ผู้จัดการหรือเจ้าของร้านกดรหัส PIN อนุมัติอย่างน้อย 4 หลัก');
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
            `รหัส PIN ของ "${authRes.user.displayName}" เป็นสิทธิ์ ${authRes.user.role} — ต้องใช้รหัสของ MANAGER หรือ OWNER เท่านั้น`
          );
          setSubmitting(false);
          return;
        }
        approver = authRes.user;
        overrideToken = authRes.overrideToken || undefined;
      }

      const auditReason = requiresManagerPin
        ? `${reasonText} [แคชเชียร์: ${currentUser.displayName} · อนุมัติโดย: ${approver.displayName}]`
        : `${reasonText} [ดำเนินการโดย: ${approver.displayName}]`;

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
                  อนุมัติยกเลิกบิล {order.receiptNumber}
                </h2>
                <p className="text-xs text-ink-muted tabular-nums-google">
                  ยอดสุทธิ ฿{formatSatangToThbString(order.totalSatang)} · คืนสต็อกตามต้นทุนเดิม ณ เวลาขาย
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={submitting}
              aria-label="ปิดหน้าต่างยกเลิกบิล"
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
                1. เลือกสาเหตุการยกเลิกบิล (บังคับบันทึกในสมุดบัญชี)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="สาเหตุการยกเลิกบิล">
                {VOID_REASON_PRESETS.map((preset) => {
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
                    ? 'ระบุเหตุผลการยกเลิกบิล (บังคับกรอก)'
                    : 'หมายเหตุเพิ่มเติม (ถ้ามี)'}
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
                      ? 'เช่น ลูกค้าแจ้งเปลี่ยนเป็นบิลใบกำกับภาษีเต็มรูป...'
                      : 'ระบุรายละเอียดเพิ่มเติมเพื่อการตรวจสอบ...'
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
                      2. รหัส PIN อนุมัติโดยผู้จัดการ / เจ้าของร้าน (Manager Override)
                    </div>
                    <p className="text-ink-soft mt-0.5">
                      บัญชีปัจจุบัน ({currentUser.displayName}) เป็นสิทธิ์ {currentUser.role} ต้องให้ผู้จัดการหรือเจ้าของร้านกดรหัส PIN ยืนยันโดยไม่ต้องสลับออกจากกะแคชเชียร์
                    </p>
                  </div>
                </div>

                <div className="rounded-[4px] border border-hairline bg-canvas px-4 py-3 text-center">
                  <div
                    className="flex items-center justify-center gap-2.5 min-h-[20px]"
                    aria-label={`กรอกรหัสอนุมัติแล้ว ${managerPin.length} หลัก`}
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
                    ล้างรหัส
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
                    aria-label="ลบหลักสุดท้ายของรหัสอนุมัติ"
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
                  ดำเนินการในสิทธิ์อนุมัติของ <strong className="text-ink">{currentUser.displayName} ({currentUser.role})</strong>
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
              ปิดหน้าต่าง
            </button>
            <button
              type="button"
              disabled={submitting || (requiresManagerPin && managerPin.length < 4)}
              onClick={() => void handleSubmit()}
              className={`h-[46px] rounded-[48px] bg-ink px-6 font-google-display text-sm font-medium tracking-[0.25px] text-white hover:bg-hero ${UI_INTERACTION.focusButton}`}
            >
              {submitting
                ? 'กำลังบันทึกยกเลิกบิล...'
                : requiresManagerPin
                  ? 'อนุมัติด้วย PIN & ยืนยันยกเลิกบิล'
                  : 'ยืนยันยกเลิกบิล (Void)'}
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
};
