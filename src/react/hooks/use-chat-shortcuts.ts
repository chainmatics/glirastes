import { useEffect, useMemo, useRef } from 'react';

/** What a keyboard shortcut can do to the chat window. */
export type ChatShortcutAction =
  | 'toggle'
  | 'toggleLayout'
  | 'toggleCollapse'
  | 'newChat'
  | 'focusInput'
  | 'close';

/** A combination such as `mod+i` or `alt+shift+d` per action; `false` switches the action off. */
export type ChatShortcutMap = Partial<Record<ChatShortcutAction, string | false>>;

/**
 * Defaults that stay clear of the common browser and system shortcuts on
 * macOS, Windows and Linux. `mod` is Command on Apple platforms and Control
 * elsewhere. An app that already uses one of them passes its own.
 */
export const DEFAULT_CHAT_SHORTCUTS: Record<ChatShortcutAction, string | false> = Object.freeze({
  toggle: 'mod+i',
  toggleLayout: 'alt+shift+d',
  toggleCollapse: 'alt+shift+c',
  newChat: 'alt+shift+n',
  focusInput: 'alt+shift+i',
  close: false,
});

export function resolveChatShortcuts(
  overrides?: ChatShortcutMap,
): Record<ChatShortcutAction, string | false> {
  const resolved = { ...DEFAULT_CHAT_SHORTCUTS };
  for (const [action, combo] of Object.entries(overrides ?? {})) {
    if (combo !== undefined && action in resolved) resolved[action as ChatShortcutAction] = combo;
  }
  return resolved;
}

interface Combo { key: string; mod: boolean; shift: boolean; alt: boolean }

const KEY_ALIASES: Record<string, string> = { esc: 'escape', return: 'enter', space: ' ', period: '.', comma: ',', slash: '/' };
const KEY_CODES: Record<string, string> = { ' ': 'Space', '.': 'Period', ',': 'Comma', '/': 'Slash' };

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

function parse(combo: string): Combo | null {
  const result: Combo = { key: '', mod: false, shift: false, alt: false };
  for (const part of combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)) {
    if (['mod', 'cmd', 'ctrl', 'meta', 'control'].includes(part)) result.mod = true;
    else if (part === 'shift') result.shift = true;
    else if (['alt', 'option', 'opt'].includes(part)) result.alt = true;
    else result.key = KEY_ALIASES[part] ?? part;
  }
  return result.key ? result : null;
}

/** The physical key of a combination, where it has one that is the same on every layout we care about. */
function codeOf(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return KEY_CODES[key] ?? null;
}

/**
 * Whether a key press is exactly this combination. Letters and digits match
 * by physical key too, because Option on macOS turns them into symbols.
 * A press with further modifiers (AltGr reports Control+Alt) does not match.
 */
export function matchesShortcut(event: KeyboardEvent, combo: string | false | null | undefined): boolean {
  const parsed = combo ? parse(combo) : null;
  if (!parsed) return false;
  const apple = isApplePlatform();
  const mod = apple ? event.metaKey : event.ctrlKey;
  const otherMod = apple ? event.ctrlKey : event.metaKey;
  if (mod !== parsed.mod || otherMod || event.shiftKey !== parsed.shift || event.altKey !== parsed.alt) return false;
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if (key === parsed.key) return true;
  const code = codeOf(parsed.key);
  return code !== null && event.code === code;
}

/** `⌘I` on Apple platforms, `Ctrl+I` elsewhere; empty for a switched-off action. */
export function formatShortcut(combo: string | false | null | undefined): string {
  const parsed = combo ? parse(combo) : null;
  if (!parsed) return '';
  const apple = isApplePlatform();
  const key = parsed.key === ' ' ? 'Space' : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1);
  const parts = [
    parsed.mod ? (apple ? '⌘' : 'Ctrl') : '',
    parsed.alt ? (apple ? '⌥' : 'Alt') : '',
    parsed.shift ? (apple ? '⇧' : 'Shift') : '',
    key,
  ].filter(Boolean);
  return parts.join(apple ? '' : '+');
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

export interface UseChatShortcutsOptions {
  /** The app's own combinations; anything left out keeps its default. */
  shortcuts?: ChatShortcutMap;
  /** Default: true. */
  enabled?: boolean;
  /** Return true to let a key press pass, for example while a dialog owns the keyboard. */
  shouldIgnore?: (event: KeyboardEvent) => boolean;
}

/**
 * Keyboard control of the chat window, the same on macOS, Windows and Linux.
 * Only actions with a handler listen. Returns the combinations in effect,
 * for tooltips via `formatShortcut`.
 */
export function useChatShortcuts(
  handlers: Partial<Record<ChatShortcutAction, () => void>>,
  options: UseChatShortcutsOptions = {},
): Record<ChatShortcutAction, string | false> {
  const { shortcuts, enabled = true, shouldIgnore } = options;
  const key = JSON.stringify(shortcuts ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => resolveChatShortcuts(shortcuts), [key]);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const ignoreRef = useRef(shouldIgnore);
  ignoreRef.current = shouldIgnore;

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      for (const action of Object.keys(resolved) as ChatShortcutAction[]) {
        const combo = resolved[action];
        const handler = handlersRef.current[action];
        if (!combo || !handler || !matchesShortcut(event, combo)) continue;
        // A bare key belongs to the text field it is typed into; Escape does not.
        const bare = !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== 'Escape';
        if (bare && isEditable(event.target)) return;
        if (ignoreRef.current?.(event)) return;
        event.preventDefault();
        handler();
        return;
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled, resolved]);

  return resolved;
}
