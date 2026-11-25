import React, { useCallback, useEffect, useState } from 'react';
import { Delete, KeyRound, Lock, ShieldCheck, UserCheck, X } from 'lucide-react';
import { posTransport } from '../api/pos-transport.ts';
import type { StaffUserDto } from '../types.ts';

interface PinLockModalProps {
  open: boolean;
  canDismiss: boolean;
  staffUsers: StaffUserDto[];
  currentUser: StaffUserDto | null;
  onAuthenticated: (user: StaffUserDto) => void;
  onClose: () => void;
}

const DEMO_PIN_HINTS: ReadonlyArray<{ label: string; userId: string; pin: string; badge: string }> =
  [
    { label: 'แคชเชียร์กะเช้า', userId: 'USR-CASHIER-01', pin: '111111', badge: 'PIN 111111' },
    { label: 'หัวหน้าคลังสินค้า', userId: 'USR-WH-01', pin: '222222', badge: 'PIN 222222' },
    { label: 'เจ้าของร้าน (Owner)', userId: 'USR-OWNER-01', pin: '999999', badge: 'PIN 999999' },
  ];

export const PinLockModal: React.FC<PinLockModalProps> = ({
  open,
  canDismiss,
  staffUsers,
  currentUser,
  onAuthenticated,
  onClose,
}) => {
  const [selectedUserId, setSelectedUserId] = useState<string>(currentUser?.id ?? '');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const appendDigit = useCallback((d: string) => {
    setErrorMsg(null);
    setPin((prev) => (prev.length < 8 ? prev + d : prev));
  }, []);

  const handleSubmit = useCallback(
    async (overridePin?: string, overrideUserId?: string) => {
      const code = overridePin ?? pin;
      const uid = overrideUserId !== undefined ? overrideUserId : selectedUserId;
      if (code.length < 4) {
        setErrorMsg('กรุณากรอกรหัส PIN อย่างน้อย 4 หลัก');
        return;
      }
      setSubmitting(true);
      setErrorMsg(null);
      try {
        const { user } = await posTransport.pinLogin(code, uid || undefined);
        setPin('');
        onAuthenticated(user);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPin('');
      } finally {
        setSubmitting(false);
      }
    },
    [onAuthenticated, pin, selectedUserId]
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        appendDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setPin((p) => p.slice(0, -1));
      } else if (e.key === 'Enter' && pin.length >= 4) {
        e.preventDefault();
        void handleSubmit();
      } else if (e.key === 'Escape' && canDismiss) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const availableDemoHints = DEMO_PIN_HINTS.filter((hint) =>
    staffUsers.some((u) => u.id === hint.userId && u.active)
  );

  return () => window.removeEventListener('keydown', onKeyDown);
  }, [appendDigit, canDismiss, handleSubmit, onClose, open, pin.length, submitting]);

  if (!open) return null;

  const availableDemoHints = DEMO_PIN_HINTS.filter((hint) =>
    staffUsers.some((u) => u.id === hint.userId && u.active)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div className="w-full max-w-md rounded-[8px] border border-[#dadce0] bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#dadce0] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1a73e8]">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-google-display text-[20px] font-normal text-[#202124]">
                ยืนยันตัวตนพนักงาน
              </h2>
              <p className="text-xs text-[#5f6368]">กรอกรหัส PIN เพื่อสลับผู้ใช้งานประจำเครื่อง</p>
            </div>
          </div>
          {canDismiss && (
            <button
              type="button"
              aria-label="ปิดหน้าต่างยืนยันตัวตน"
              onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f8f9fa] hover:text-[#202124] cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#5f6368] mb-1.5">
              เลือกบัญชีผู้ใช้งาน (หรือกดรหัส PIN โดยตรง)
            </label>
            <select
              value={selectedUserId}
              onChange={(e) => {
                setSelectedUserId(e.target.value);
                setErrorMsg(null);
              }}
              className="h-11 w-full rounded-[4px] border border-[#dadce0] bg-white px-3.5 text-sm text-[#202124] focus:border-[#1a73e8] focus:outline-none"
            >
              <option value="">ค้นหาอัตโนมัติจากรหัส PIN</option>
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
          <div className="rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] px-4 py-3.5 text-center">
            <div className="flex items-center justify-center gap-2.5 min-h-[24px]">
              {Array.from({ length: Math.max(6, pin.length) }).map((_, i) => (
                <span
                  key={i}
                  className={`h-3 w-3 rounded-full transition-colors ${
                    i < pin.length ? 'bg-[#1a73e8]' : 'bg-[#dadce0]'
                  }`}
                />
              ))}
            </div>
            {errorMsg && <p className="mt-2 text-xs font-medium text-[#202124]">{errorMsg}</p>}
          </div>

          {/* 12-Key Pad */}
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                type="button"
                disabled={submitting}
                onClick={() => appendDigit(digit)}
                className="h-12 rounded-[4px] border border-[#dadce0] bg-white font-google-display text-[20px] font-normal text-[#202124] hover:border-[#1a73e8] hover:bg-[#f8f9fa] cursor-pointer"
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              disabled={submitting}
              onClick={() => setPin('')}
              className="h-12 rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] text-xs font-medium text-[#5f6368] hover:text-[#202124] cursor-pointer"
            >
              ล้างค่า
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => appendDigit('0')}
              className="h-12 rounded-[4px] border border-[#dadce0] bg-white font-google-display text-[20px] font-normal text-[#202124] hover:border-[#1a73e8] hover:bg-[#f8f9fa] cursor-pointer"
            >
              0
            </button>
            <button
              type="button"
              aria-label="ลบหลักสุดท้าย"
              disabled={submitting}
              onClick={() => setPin((p) => p.slice(0, -1))}
              className="flex h-12 items-center justify-center rounded-[4px] border border-[#dadce0] bg-[#f8f9fa] text-[#5f6368] hover:text-[#202124] cursor-pointer"
            >
              <Delete className="h-5 w-5" />
            </button>
          </div>

          <button
            type="button"
            disabled={submitting || pin.length < 4}
            onClick={() => void handleSubmit()}
            className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-[#1a73e8] px-6 font-google-display text-[16px] font-medium tracking-[0.5px] text-white hover:bg-[#1967d2] disabled:opacity-40 cursor-pointer"
          >
            <UserCheck className="h-4 w-4" />
            {submitting ? 'กำลังตรวจสอบสิทธิ์...' : 'ปลดล็อกเข้าใช้งาน'}
          </button>

          {availableDemoHints.length > 0 && (
            <div className="border-t border-[#dadce0] pt-3.5">
              <div className="flex items-center gap-1.5 text-xs text-[#5f6368] mb-2">
                <KeyRound className="h-3.5 w-3.5 text-[#1a73e8]" />
                สลับบทบาทด่วนสำหรับชุดข้อมูลทดลอง
              </div>
              <div className="grid grid-cols-3 gap-2">
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
                    className="rounded-[4px] border border-[#dadce0] bg-white p-2 text-left hover:border-[#1a73e8] cursor-pointer"
                  >
                    <div className="text-xs font-medium text-[#202124] truncate">{hint.label}</div>
                    <div className="text-[11px] text-[#1a73e8] mt-0.5 tabular-nums-google">
                      {hint.badge}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-[#dadce0] bg-[#f8f9fa] px-6 py-2.5 flex items-center justify-between text-xs text-[#5f6368]">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[#1a73e8]" />
            Timing-Safe SHA-256 PIN Guard
          </span>
          <span>POS-TERM-01</span>
        </div>
      </div>
    </div>
  );
};
