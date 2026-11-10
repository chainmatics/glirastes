import { describe, expect, it } from 'vitest';
import {
  assistantShortcutList,
  DE_ASSISTANT_SHORTCUT_LABELS,
  DEFAULT_ASSISTANT_SHORTCUT_LABELS,
} from '../assistant-shortcut-list.js';
import { formatShortcut } from '../../hooks/use-chat-shortcuts.js';

describe('assistantShortcutList', () => {
  it('lists the active default shortcuts in a fixed order with English labels', () => {
    const list = assistantShortcutList();
    expect(list.map((entry) => entry.action)).toEqual(['toggle', 'toggleLayout', 'toggleCollapse', 'newChat', 'focusInput']);
    expect(list[0]).toEqual({
      action: 'toggle',
      combo: 'mod+i',
      keys: formatShortcut('mod+i'),
      label: DEFAULT_ASSISTANT_SHORTCUT_LABELS.toggle,
    });
  });

  it('applies the app overrides and skips switched-off actions', () => {
    const list = assistantShortcutList({ shortcuts: { newChat: false, close: 'escape' } });
    expect(list.map((entry) => entry.action)).toEqual(['toggle', 'toggleLayout', 'toggleCollapse', 'focusInput', 'close']);
    expect(list.at(-1)?.combo).toBe('escape');
  });

  it('uses German labels for a German page and lets the app override single labels', () => {
    const list = assistantShortcutList({ language: 'de-DE', labels: { focusInput: 'Zur Eingabe' } });
    expect(list[0]?.label).toBe(DE_ASSISTANT_SHORTCUT_LABELS.toggle);
    expect(list.find((entry) => entry.action === 'focusInput')?.label).toBe('Zur Eingabe');
  });
});
