import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../../i18n/index.tsx';

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

interface ModalStackEntry {
  id: symbol;
  minZIndex: number;
}

const activeModalStack: ModalStackEntry[] = [];
const modalStackListeners = new Set<() => void>();
let savedBodyOverflow: string | null = null;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function notifyModalStackListeners(): void {
  for (const listener of modalStackListeners) {
    listener();
  }
}

export function subscribeModalStack(listener: () => void): () => void {
  modalStackListeners.add(listener);
  return () => {
    modalStackListeners.delete(listener);
  };
}

export function pushModalEntry(id: symbol, minZIndex = 50): void {
  const existing = activeModalStack.find((entry) => entry.id === id);
  if (existing) {
    if (existing.minZIndex !== minZIndex) {
      existing.minZIndex = minZIndex;
      notifyModalStackListeners();
    }
    return;
  }
  if (activeModalStack.length === 0 && typeof document !== 'undefined' && document.body) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  activeModalStack.push({ id, minZIndex });
  notifyModalStackListeners();
}

export function removeModalEntry(id: symbol): void {
  const idx = activeModalStack.findIndex((entry) => entry.id === id);
  if (idx < 0) return;
  activeModalStack.splice(idx, 1);
  if (activeModalStack.length === 0 && typeof document !== 'undefined' && document.body) {
    document.body.style.overflow = savedBodyOverflow ?? '';
    savedBodyOverflow = null;
  }
  notifyModalStackListeners();
}

export function getModalZIndex(id: symbol): number {
  const idx = activeModalStack.findIndex((entry) => entry.id === id);
  if (idx < 0) return 50;
  const entry = activeModalStack[idx]!;
  return Math.max(entry.minZIndex, 50 + idx * 10);
}

export function isTopmostModal(id: symbol): boolean {
  if (activeModalStack.length === 0) return false;
  let topIdx = 0;
  let topZ = Math.max(activeModalStack[0]!.minZIndex, 50);
  for (let i = 1; i < activeModalStack.length; i += 1) {
    const z = Math.max(activeModalStack[i]!.minZIndex, 50 + i * 10);
    if (z >= topZ) {
      topZ = z;
      topIdx = i;
    }
  }
  return activeModalStack[topIdx]?.id === id;
}

function isFocusableElementVisible(el: HTMLElement, container: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = window.getComputedStyle(cur);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    if (cur === container) break;
    cur = cur.parentElement;
  }
  return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const visible: HTMLElement[] = [];
  for (const el of candidates) {
    if (isFocusableElementVisible(el, container)) {
      visible.push(el);
    }
  }
  return visible;
}

/**
 * Traps `Tab` and `Shift+Tab` focus cycling within an active modal or drawer container.
 */
export function handleModalFocusTrapKeyDown(
  e: KeyboardEvent,
  container: HTMLElement | null
): void {
  if (e.key !== 'Tab' || !container) return;
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) {
    e.preventDefault();
    container.focus({ preventScroll: true });
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  if (e.shiftKey) {
    if (!active || !container.contains(active) || active === first || active === container) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    }
    return;
  }

  if (!active || !container.contains(active) || active === last || active === container) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
}

export interface ModalDialogProps {
  open: boolean;
  onClose?: (() => void) | undefined;
  canDismiss?: boolean | undefined;
  labelledBy?: string | undefined;
  ariaLabel?: string | undefined;
  maxWidthClass?: string | undefined;
  minZIndex?: number | undefined;
  children: React.ReactNode;
}

/**
 * Accessible modal overlay with `role="dialog"`, `aria-modal="true"`,
 * LIFO modal stack z-index & capture-phase Escape handling, Tab focus trap, and focus restoration.
 */
export const ModalDialog: React.FC<ModalDialogProps> = ({
  open,
  onClose,
  canDismiss = true,
  labelledBy,
  ariaLabel,
  maxWidthClass = 'max-w-lg',
  minZIndex = 50,
  children,
}) => {
  const modalIdRef = useRef<symbol | null>(null);
  if (!modalIdRef.current) {
    modalIdRef.current = Symbol('ModalDialog');
  }
  const modalId = modalIdRef.current;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const canDismissRef = useRef(canDismiss);
  onCloseRef.current = onClose;
  canDismissRef.current = canDismiss;

  const [zIndex, setZIndex] = useState<number>(minZIndex);
  const [isTopmost, setIsTopmost] = useState<boolean>(true);

  useLayoutEffect(() => {
    if (!open) return;
    const syncStackState = () => {
      const nextZ = getModalZIndex(modalId);
      const nextTop = isTopmostModal(modalId);
      setZIndex((prev) => (prev === nextZ ? prev : nextZ));
      setIsTopmost((prev) => (prev === nextTop ? prev : nextTop));
    };

    const unsubscribe = subscribeModalStack(syncStackState);
    pushModalEntry(modalId, minZIndex);
    syncStackState();

    return () => {
      unsubscribe();
      removeModalEntry(modalId);
    };
  }, [minZIndex, modalId, open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const timer = window.setTimeout(() => {
      if (
        isTopmostModal(modalId) &&
        panelRef.current &&
        !panelRef.current.contains(document.activeElement)
      ) {
        panelRef.current.focus({ preventScroll: true });
      }
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isTopmostModal(modalId)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (canDismissRef.current && onCloseRef.current) {
          onCloseRef.current();
        }
        return;
      }
      if (e.key === 'Tab') {
        if (!isTopmostModal(modalId)) return;
        handleModalFocusTrapKeyDown(e, panelRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) {
        previousFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [modalId, open]);

  if (!open) return null;

  return (
    <div
      data-rube-modal-backdrop="true"
      style={{ zIndex }}
      className="fixed inset-0 flex items-center justify-center bg-black/55 p-4 transition-opacity duration-200"
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
        data-rube-modal-topmost={isTopmost ? 'true' : 'false'}
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
  cancelLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n();
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  const modalIdRef = useRef<symbol | null>(null);
  if (!modalIdRef.current) {
    modalIdRef.current = Symbol('ConfirmDialog');
  }
  const modalId = modalIdRef.current;

  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;

  const [zIndex, setZIndex] = useState<number>(60);
  const [isTopmost, setIsTopmost] = useState<boolean>(true);

  useLayoutEffect(() => {
    if (!open) return;
    const syncStackState = () => {
      const nextZ = getModalZIndex(modalId);
      const nextTop = isTopmostModal(modalId);
      setZIndex((prev) => (prev === nextZ ? prev : nextZ));
      setIsTopmost((prev) => (prev === nextTop ? prev : nextTop));
    };

    const unsubscribe = subscribeModalStack(syncStackState);
    pushModalEntry(modalId, 60);
    syncStackState();

    return () => {
      unsubscribe();
      removeModalEntry(modalId);
    };
  }, [modalId, open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const t = window.setTimeout(() => {
      if (!isTopmostModal(modalId)) return;
      if (cancelBtnRef.current && !cancelBtnRef.current.disabled) {
        cancelBtnRef.current.focus({ preventScroll: true });
      } else if (panelRef.current) {
        panelRef.current.focus({ preventScroll: true });
      }
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isTopmostModal(modalId)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busyRef.current) {
          onCancelRef.current();
        }
        return;
      }
      if (e.key === 'Tab') {
        if (!isTopmostModal(modalId)) return;
        handleModalFocusTrapKeyDown(e, panelRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });

    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) {
        previousFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [modalId, open]);

  if (!open) return null;

  return (
    <div
      data-rube-modal-backdrop="true"
      style={{ zIndex }}
      className="fixed inset-0 flex items-center justify-center bg-black/55 p-4 transition-opacity duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        data-rube-modal-topmost={isTopmost ? 'true' : 'false'}
        tabIndex={-1}
        className="w-full max-w-md rounded-[8px] border border-hairline bg-canvas overflow-hidden focus:outline-none"
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
            {resolvedCancelLabel}
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
