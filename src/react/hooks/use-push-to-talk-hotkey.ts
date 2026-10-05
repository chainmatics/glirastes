import { useEffect, useRef } from 'react';

/** Hold to talk; `mod` is ⌘ on macOS and Ctrl elsewhere. */
export const DEFAULT_PUSH_TO_TALK_HOTKEY = 'mod+shift+space';

interface HoldCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

export function parseHoldCombo(combo: string): HoldCombo | null {
  const parts = combo.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  const result: HoldCombo = { key: '', mod: false, shift: false, alt: false };
  for (const part of parts) {
    if (['mod', 'cmd', 'ctrl', 'meta', 'control'].includes(part)) result.mod = true;
    else if (part === 'shift') result.shift = true;
    else if (['alt', 'option', 'opt'].includes(part)) result.alt = true;
    else result.key = part;
  }
  return result.key ? result : null;
}

const PLAIN_LETTER_OR_DIGIT = /^[a-z0-9]$/;
const PHYSICAL_LETTER_OR_DIGIT = /^(?:Key([A-Z])|Digit([0-9]))$/;

/** Lower-cased `event.key`; empty for key-less events, which autofill dispatches. */
function keyName(event: KeyboardEvent): string {
  if (event.key === ' ' || event.code === 'Space') return 'space';
  return typeof event.key === 'string' ? event.key.toLowerCase() : '';
}

/**
 * Whether the event is the combo's main key. A typed letter or digit wins, so
 * AZERTY and Dvorak users get the key they see. When the event carries some
 * other character, the physical key decides: macOS Option composes 'µ' for
 * Option+M, and dead keys and non-Latin layouts report no ASCII letter either.
 */
function isComboKey(event: KeyboardEvent, key: string): boolean {
  const name = keyName(event);
  if (name === key) return true;
  if (PLAIN_LETTER_OR_DIGIT.test(name) || typeof event.code !== 'string') return false;
  const physical = PHYSICAL_LETTER_OR_DIGIT.exec(event.code);
  return physical !== null && (physical[1] ?? physical[2]).toLowerCase() === key;
}

/**
 * Calls `onPress` when the combo goes down and `onRelease` when any key of
 * it is released, the window blurs or the hook unmounts. macOS does not
 * deliver keyup for other keys while ⌘ is held, so releasing ⌘ also ends
 * the hold. Fires inside text fields: the combo always has a modifier or is
 * explicitly chosen by the app. A letter or digit matches the typed character,
 * or the physical key when Option or a dead key composes another one.
 */
export function usePushToTalkHotkey(options: {
  hotkey: string | false | undefined;
  enabled: boolean;
  onPress: () => void;
  onRelease: () => void;
}): void {
  const pressRef = useRef(options.onPress);
  pressRef.current = options.onPress;
  const releaseRef = useRef(options.onRelease);
  releaseRef.current = options.onRelease;

  useEffect(() => {
    if (!options.enabled || !options.hotkey) return;
    const combo = parseHoldCombo(options.hotkey);
    if (!combo) return;
    let holding = false;

    const matches = (event: KeyboardEvent) =>
      isComboKey(event, combo.key)
      && (isMac() ? event.metaKey : event.ctrlKey) === combo.mod
      && event.shiftKey === combo.shift
      && event.altKey === combo.alt;

    const end = () => {
      if (!holding) return;
      holding = false;
      releaseRef.current();
    };
    const down = (event: KeyboardEvent) => {
      if (holding) {
        if (isComboKey(event, combo.key)) event.preventDefault();
        return;
      }
      if (event.repeat || !matches(event)) return;
      event.preventDefault();
      holding = true;
      pressRef.current();
    };
    const up = (event: KeyboardEvent) => {
      if (!holding) return;
      const name = keyName(event);
      if (
        isComboKey(event, combo.key)
        || (combo.mod && (name === 'meta' || name === 'control'))
        || (combo.shift && name === 'shift')
        || (combo.alt && name === 'alt')
      ) {
        event.preventDefault();
        end();
      }
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', end);
      end();
    };
  }, [options.enabled, options.hotkey]);
}
