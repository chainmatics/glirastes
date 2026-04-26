import { useEffect, useRef } from 'react';

export interface UseKeyboardShortcutOptions {
  /** Disable without removing the call site. Default: true. */
  enabled?: boolean;
  /**
   * When true, the handler fires even if the event target is an editable
   * element (input / textarea / contenteditable). Default: false — except
   * for the `escape` key which always fires.
   */
  allowInEditable?: boolean;
}

type Combo = {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
};

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

function parseCombo(combo: string): Combo | null {
  const parts = combo.toLowerCase().trim().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const result: Combo = { key: '', mod: false, shift: false, alt: false };
  for (const part of parts) {
    if (part === 'mod' || part === 'cmd' || part === 'ctrl' || part === 'meta' || part === 'control') {
      result.mod = true;
    } else if (part === 'shift') {
      result.shift = true;
    } else if (part === 'alt' || part === 'option' || part === 'opt') {
      result.alt = true;
    } else {
      result.key = part;
    }
  }
  return result.key ? result : null;
}

function matches(event: KeyboardEvent, combo: Combo): boolean {
  const wantMod = combo.mod;
  const gotMod = isMac() ? event.metaKey : event.ctrlKey;
  if (wantMod !== gotMod) return false;
  if (combo.shift !== event.shiftKey) return false;
  if (combo.alt !== event.altKey) return false;
  const key = event.key.toLowerCase();
  if (combo.key === 'escape') return key === 'escape' || key === 'esc';
  return key === combo.key;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Global keyboard shortcut. `mod` maps to ⌘ on Mac and Ctrl elsewhere.
 * Escape always fires regardless of focused element so modal-style widgets
 * can close even while an input has focus.
 *
 * @example
 * useKeyboardShortcut('mod+i', () => setOpen((v) => !v));
 * useKeyboardShortcut('escape', () => setOpen(false), { enabled: open });
 */
export function useKeyboardShortcut(
  combo: string | false | null | undefined,
  handler: () => void,
  options: UseKeyboardShortcutOptions = {},
): void {
  const { enabled = true, allowInEditable = false } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled || !combo) return;
    const parsed = parseCombo(combo);
    if (!parsed) return;

    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!matches(event, parsed)) return;
      // Shortcuts that include ⌘/Ctrl always fire (e.g. ⌘I, ⌘K) — even
      // inside a textarea — matching standard webapp conventions. Escape
      // always fires so modal-style widgets can close from any focus.
      // Bare-key shortcuts are suppressed in editable targets.
      const isEscape = parsed.key === 'escape';
      const skipEditableCheck = allowInEditable || isEscape || parsed.mod;
      if (!skipEditableCheck && isEditableTarget(event.target)) return;
      event.preventDefault();
      handlerRef.current();
    };

    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [combo, enabled, allowInEditable]);
}
