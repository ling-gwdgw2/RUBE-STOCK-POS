import React, { useEffect, useId, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Shared accessible interaction primitives conforming to `ui-ux-pro-max`
 * Pre-Delivery Checklist and `google.design.md` tokens.
 */
export const UI_INTERACTION = {
  focusButton:
    'transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
  focusButtonPrimary:
    'transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
  focusControl:
    'transition-colors duration-200 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20',
  focusSelect:
    'transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20',
} as const;

export interface ModalDialogProps {
  open: boolean;
  onClose?: (() => void) | undefined;
  canDismiss?: boolean | undefined;
  labelledBy?: string | undefined;
  ariaLabel?: string | undefined;
  maxWidthClass?: string | undefined;
  children: React.ReactNode;
}

/**
 * Accessible modal overlay with `role="dialog"`, `aria-modal="true"`,
 * Escape key handling, backdrop click dismissal, and focus restoration.
 */
export const ModalDialog: React.FC<ModalDialogProps> = ({
  open,
  onClose,
  canDismiss = true,
  labelledBy,
  ariaLabel,
  maxWidthClass = 'max-w-lg',
  children,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const timer = window.setTimeout(() => {
      if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
        panelRef.current.focus({ preventScroll: true });
      }
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canDismiss && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) {
        previousFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [canDismiss, onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 transition-opacity duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && canDismiss && onClose) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={!labelledBy ? ariaLabel : undefined}
        tabIndex={-1}
        className={`w-full ${maxWidthClass} max-h-[92vh] flex flex-col rounded-[8px] border border-hairline bg-canvas overflow-hidden focus:outline-none`}
      >
        {children}
      </div>
    </div>
  );
};

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string | undefined;
  tone?: 'danger' | 'primary' | undefined;
  busy?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Accessible confirmation modal (`role="alertdialog"`) for destructive actions.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'ยกเลิก',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const titleId = useId();
  const descId = useId();
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => cancelBtnRef.current?.focus(), 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 transition-opacity duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-md rounded-[8px] border border-hairline bg-canvas overflow-hidden"
      >
        <div className="p-6 flex items-start gap-3.5">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              tone === 'danger' ? 'bg-ink text-white' : 'bg-primary-soft text-primary-dark'
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="space-y-1.5">
            <h3 id={titleId} className="font-google-display text-[18px] font-medium text-ink">
              {title}
            </h3>
            <p id={descId} className="text-sm text-ink-muted leading-relaxed">
              {description}
            </p>
          </div>
        </div>

        <div className="border-t border-hairline bg-surface-1 px-6 py-4 flex flex-wrap justify-end gap-2.5">
          <button
            ref={cancelBtnRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={`h-[44px] rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium text-ink-soft hover:border-ink hover:text-ink ${UI_INTERACTION.focusButton}`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`h-[44px] rounded-[48px] px-6 font-google-display text-xs font-medium tracking-[0.25px] text-white ${
              tone === 'danger'
                ? 'bg-ink hover:bg-hero'
                : 'bg-primary hover:bg-primary-hover'
            } ${UI_INTERACTION.focusButtonPrimary}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
