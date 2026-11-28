import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Delete, KeyRound, Lock, ShieldCheck, UserCheck, X } from 'lucide-react';
import { posTransport } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type { StaffUserDto } from '../types.ts';
import { resolveDigitFromKeyboardEvent } from '../utils/keyboard-digits.ts';
import { ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface PinLockModalProps {
  open: boolean;
  canDismiss: boolean;
  staffUsers: StaffUserDto[];
  currentUser: StaffUserDto | null;
  simulationModeEnabled?: boolean;
  onAuthenticated: (user: StaffUserDto) => void;
  onClose: () => void;
}

const DEMO_PIN_HINTS: ReadonlyArray<{
  labelTh: string;
  labelLo: string;
  labelEn: string;
  userId: string;
  pin: string;
  badge: string;
}> = [
  {
    labelTh: 'แคชเชียร์กะเช้า',
    labelLo: 'ແຄັດເຊຍກະເຊົ້າ',
    labelEn: 'Morning Cashier',
    userId: 'USR-CASHIER-01',
    pin: '111111',
    badge: 'PIN 111111',
  },
  {
    labelTh: 'หัวหน้าคลังสินค้า',
    labelLo: 'ຫົວໜ້າສາງສິນຄ້າ',
    labelEn: 'Warehouse Lead',
    userId: 'USR-WH-01',
    pin: '222222',
    badge: 'PIN 222222',
  },
  {
    labelTh: 'เจ้าของร้าน (Owner)',
    labelLo: 'ເຈົ້າຂອງຮ້ານ (Owner)',
    labelEn: 'Store Owner',
    userId: 'USR-OWNER-01',
    pin: '999999',
    badge: 'PIN 999999',
  },
];

export const PinLockModal: React.FC<PinLockModalProps> = ({
  open,
  canDismiss,
  staffUsers,
  currentUser,
  simulationModeEnabled = false,
  onAuthenticated,
  onClose,
}) => {
  const { t, pick } = useI18n();
  const uid = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>(
    canDismiss ? (currentUser?.id ?? '') : ''
  );
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedUserId(canDismiss ? (currentUser?.id ?? '') : '');
      setPin('');
      setErrorMsg(null);
      setSubmitting(false);
    }
  }, [canDismiss, currentUser?.id, open]);

  const appendDigit = useCallback((d: string) => {
    setErrorMsg(null);
    setPin((prev) => (prev.length < 8 ? prev + d : prev));
  }, []);

  const handleSubmit = useCallback(
    async (overridePin?: string, overrideUserId?: string) => {
      const code = overridePin ?? pin;
      const targetUserId = overrideUserId !== undefined ? overrideUserId : selectedUserId;
      if (code.length < 4) {
        setErrorMsg(t('pin.minDigitsErr'));
        return;
      }
      setSubmitting(true);
      setErrorMsg(null);
      try {
        const { user } = await posTransport.pinLogin(code, targetUserId || undefined);
        setPin('');
        onAuthenticated(user);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPin('');
      } finally {
        setSubmitting(false);
      }
    },
    [onAuthenticated, pin, selectedUserId, t]
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const dialogEl = contentRef.current?.closest('[role="dialog"]');
      if (dialogEl && dialogEl.getAttribute('data-rube-modal-topmost') === 'false') {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'SELECT') {
        return;
      }
      if (submitting) return;
      const digit = resolveDigitFromKeyboardEvent(e);
      if (digit !== null) {
        e.preventDefault();
        appendDigit(digit);
      } else if (e.key === 'Backspace' || e.code === 'Backspace') {
        e.preventDefault();
        setPin((p) => p.slice(0, -1));
      } else if (
        (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') &&
        pin.length >= 4
      ) {
        e.preventDefault();
        void handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appendDigit, handleSubmit, open, pin.length, submitting]);

  const availableDemoHints = simulationModeEnabled
    ? DEMO_PIN_HINTS.filter((hint) => staffUsers.some((u) => u.id === hint.userId && u.active))
    : [];

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      canDismiss={canDismiss}
      minZIndex={!canDismiss ? 90 : undefined}
      labelledBy={`${uid}-pin-title`}
      maxWidthClass="max-w-md"
    >
      <div ref={contentRef} className="flex items-center justify-between border-b border-hairline px-6 py-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h2
              id={`${uid}-pin-title`}
              className="font-google-display text-[20px] font-normal text-ink"
            >
              {canDismiss
                ? pick('สลับผู้ใช้งานประจำเครื่อง', 'ປ່ຽນພະນັກງານປະຈຳເຄື່ອງ', 'Switch Terminal Staff')
                : t('pin.title')}
            </h2>
            <p className="text-xs text-ink-muted">
              {canDismiss
                ? pick('กรอกรหัส PIN เพื่อเปลี่ยนบทบาทหรือผู้ปฏิบัติงาน', 'ປ້ອນລະຫັດ PIN ເພື່ອປ່ຽນພະນັກງານ', 'Enter PIN to switch staff or role')
                : pick('กรอกรหัส PIN ประจำตัวพนักงานเพื่อปลดล็อกเข้าใช้งาน', 'ປ້ອນລະຫັດ PIN ພະນັກງານເພື່ອປົດລັອກ', 'Enter staff PIN to unlock terminal')}
            </p>
          </div>
        </div>
        {canDismiss && (
          <button
            type="button"
            aria-label={pick('ปิดหน้าต่างยืนยันตัวตน', 'ປິດໜ້າຕ່າງຢືນຢັນຕົວຕົນ', 'Close authentication dialog')}
            onClick={onClose}
            className={`flex h-10 w-10 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="p-6 space-y-4 overflow-y-auto flex-1">
        <div>
          <label
            htmlFor={`${uid}-staff-select`}
            className="block text-xs font-medium text-ink-muted mb-1.5"
          >
            {pick(
              'เลือกบัญชีผู้ใช้งาน (หรือกดรหัส PIN โดยตรง)',
              'ເລືອກບັນຊີຜູ້ໃຊ້ງານ (ຫຼື ກົດລະຫັດ PIN ໂດຍກົງ)',
              'Select staff account (or enter PIN directly)'
            )}
          </label>
          <select
            id={`${uid}-staff-select`}
            value={selectedUserId}
            onChange={(e) => {
              setSelectedUserId(e.target.value);
              setErrorMsg(null);
            }}
            className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-sm text-ink ${UI_INTERACTION.focusSelect}`}
          >
            <option value="">
              {pick('ค้นหาอัตโนมัติจากรหัส PIN', 'ຄົ້ນຫາອັດຕະໂນມັດຈາກລະຫັດ PIN', 'Auto-detect from PIN')}
            </option>
            {staffUsers
              .filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.role})
                </option>
              ))}
          </select>
        </div>

        {/* PIN Dots */}
        <div className="rounded-[4px] border border-hairline bg-surface-1 px-4 py-3.5 text-center">
          <div
            className="flex items-center justify-center gap-2.5 min-h-[24px]"
            aria-label={pick(
              `กรอกแล้ว ${pin.length} หลัก`,
              `ປ້ອນແລ້ວ ${pin.length} ຫຼັກ`,
              `${pin.length} digits entered`
            )}
          >
            {Array.from({ length: Math.max(6, pin.length) }).map((_, i) => (
              <span
                key={i}
                className={`h-3 w-3 rounded-full transition-colors duration-150 ${
                  i < pin.length ? 'bg-primary' : 'bg-hairline'
                }`}
              />
            ))}
          </div>
          {errorMsg && (
            <p role="alert" className="mt-2 text-xs font-medium text-ink">
              {errorMsg}
            </p>
          )}
        </div>

        {/* 12-Key Pad */}
        <div className="grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              disabled={submitting}
              onClick={() => appendDigit(digit)}
              className={`h-12 rounded-[4px] border border-hairline bg-canvas font-google-display text-[20px] font-normal text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            disabled={submitting}
            onClick={() => setPin('')}
            className={`h-12 rounded-[4px] border border-hairline bg-surface-1 text-xs font-medium text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            {pick('ล้างค่า', 'ລ້າງຄ່າ', 'Clear')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => appendDigit('0')}
            className={`h-12 rounded-[4px] border border-hairline bg-canvas font-google-display text-[20px] font-normal text-ink hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
          >
            0
          </button>
          <button
            type="button"
            aria-label={pick('ลบหลักสุดท้าย', 'ລຶບຫຼັກສຸດທ້າຍ', 'Backspace')}
            disabled={submitting}
            onClick={() => setPin((p) => p.slice(0, -1))}
            className={`flex h-12 items-center justify-center rounded-[4px] border border-hairline bg-surface-1 text-ink-muted hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            <Delete className="h-5 w-5" />
          </button>
        </div>

        <button
          type="button"
          disabled={submitting || pin.length < 4}
          onClick={() => void handleSubmit()}
          className={`flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
        >
          <UserCheck className="h-4 w-4" />
          {submitting
            ? pick('กำลังตรวจสอบสิทธิ์...', 'ກຳລັງກວດສອບສິດ...', 'Verifying PIN...')
            : t('pin.unlockBtn')}
        </button>

        {availableDemoHints.length > 0 && (
          <div className="border-t border-hairline pt-3.5">
            <div className="flex items-center gap-1.5 text-xs text-ink-muted mb-2">
              <KeyRound className="h-3.5 w-3.5 text-primary" />
              {pick(
                'สลับบทบาทด่วน (โหมดจำลองการทดสอบ)',
                'ສະຫຼັບບົດບາດດ່ວນ (ໂໝດທົດລອງ)',
                'Quick Role Switch (Simulation Mode)'
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {availableDemoHints.map((hint) => (
                <button
                  key={hint.userId}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setSelectedUserId(hint.userId);
                    setPin(hint.pin);
                    void handleSubmit(hint.pin, hint.userId);
                  }}
                  className={`rounded-[4px] border border-hairline bg-canvas p-2 text-left hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
                >
                  <div className="text-xs font-medium text-ink truncate">
                    {pick(hint.labelTh, hint.labelLo, hint.labelEn)}
                  </div>
                  <div className="text-[11px] text-primary-hover mt-0.5 tabular-nums-google">
                    {hint.badge}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-hairline bg-surface-1 px-6 py-2.5 flex items-center justify-between text-xs text-ink-muted shrink-0">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          Timing-Safe SHA-256 PIN Guard
        </span>
        <span>POS-TERM-01</span>
      </div>
    </ModalDialog>
  );
};
