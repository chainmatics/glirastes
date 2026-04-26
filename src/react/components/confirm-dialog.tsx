import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChatContext } from '../provider/chat-context.js';

export interface ConfirmDialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Short title — bold, first line. */
  title: ReactNode;
  /** Body message — descriptive, second line. Optional. */
  message?: ReactNode;
  /** Label for the primary/confirm button. Default: `'Confirm'`. */
  confirmLabel?: string;
  /** Label for the cancel button. Default: `'Cancel'`. */
  cancelLabel?: string;
  /**
   * When true, the confirm button is styled with the danger color —
   * use for destructive actions like delete.
   */
  destructive?: boolean;
  /** Disable the confirm button (e.g. while async work is in flight). */
  confirmDisabled?: boolean;
  /** Called when the user clicks Confirm or presses Enter. */
  onConfirm: () => void;
  /** Called when the user clicks Cancel, backdrop, or presses Escape. */
  onCancel: () => void;
}

/**
 * Themed confirmation dialog used by the built-in delete / clear flows.
 * Replaces `window.confirm()` so the prompt matches the widget's palette
 * and theme. Portal'd to `document.body`, keyboard-accessible (Enter to
 * confirm, Escape to cancel), and inherits CSS theme vars from the
 * nearest `<AiChatProvider>`.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ctx = useContext(ChatContext);
  const themeVars = ctx?.themeVars ?? {};
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the confirm button so Enter commits without tabbing.
    confirmBtnRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!confirmDisabled) onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, confirmDisabled, onConfirm, onCancel]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const dialog = (
    <div
      data-component="confirm-dialog-backdrop"
      style={themeVars}
      onClick={(e) => {
        // Only close when clicking the backdrop itself, not the panel
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        data-component="confirm-dialog"
        data-destructive={destructive || undefined}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div data-element="title" id="confirm-dialog-title">
          {title}
        </div>
        {message && <div data-element="message">{message}</div>}
        <div data-element="actions">
          <button
            type="button"
            data-element="cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            data-element="confirm"
            data-destructive={destructive || undefined}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
