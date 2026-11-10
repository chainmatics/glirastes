// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHAT_SHORTCUTS,
  formatShortcut,
  matchesShortcut,
  resolveChatShortcuts,
  useChatShortcuts,
  type ChatShortcutMap,
} from '../use-chat-shortcuts.js';

function platform(value: string) {
  Object.defineProperty(navigator, 'platform', { configurable: true, value });
}

function Probe({ handlers, shortcuts, shouldIgnore }: {
  handlers: Parameters<typeof useChatShortcuts>[0];
  shortcuts?: ChatShortcutMap;
  shouldIgnore?: (event: KeyboardEvent) => boolean;
}) {
  useChatShortcuts(handlers, { shortcuts, shouldIgnore });
  return <textarea aria-label="draft" />;
}

afterEach(() => { cleanup(); platform(''); });

describe('chat shortcuts', () => {
  it('ships defaults for every window action and lets an app override or switch off each one', () => {
    expect(DEFAULT_CHAT_SHORTCUTS).toEqual({
      toggle: 'mod+i',
      toggleLayout: 'alt+shift+d',
      toggleCollapse: 'alt+shift+c',
      newChat: 'alt+shift+n',
      focusInput: 'alt+shift+i',
      close: false,
    });
    expect(resolveChatShortcuts({ toggle: 'mod+j', newChat: false })).toMatchObject({
      toggle: 'mod+j', newChat: false, toggleLayout: 'alt+shift+d',
    });
  });

  it('maps mod to Command on Apple platforms and to Control elsewhere', () => {
    platform('MacIntel');
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', metaKey: true }), 'mod+i')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true }), 'mod+i')).toBe(false);
    platform('Win32');
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true }), 'mod+i')).toBe(true);
    platform('Linux x86_64');
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'I', code: 'KeyI', ctrlKey: true }), 'mod+i')).toBe(true);
  });

  it('matches by physical key, so Option combinations that type a symbol on macOS still fire', () => {
    platform('MacIntel');
    const event = new KeyboardEvent('keydown', { key: 'Î', code: 'KeyD', altKey: true, shiftKey: true });
    expect(matchesShortcut(event, 'alt+shift+d')).toBe(true);
  });

  it('leaves AltGr and extra modifiers alone', () => {
    platform('Win32');
    // AltGr reports Control+Alt on Windows.
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', altKey: true, shiftKey: true, ctrlKey: true }), 'alt+shift+d')).toBe(false);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, shiftKey: true }), 'mod+i')).toBe(false);
  });

  it('runs the handler of a pressed shortcut, also while typing in a field', () => {
    platform('Win32');
    const toggle = vi.fn();
    const newChat = vi.fn();
    const view = render(<Probe handlers={{ toggle, newChat }} />);
    const field = view.getByLabelText('draft');
    field.focus();

    const event = new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    fireEvent.keyDown(field, { key: 'n', code: 'KeyN', altKey: true, shiftKey: true });

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(newChat).toHaveBeenCalledTimes(1);
  });

  it('follows the override, ignores a switched-off action and held keys', () => {
    platform('Win32');
    const toggle = vi.fn();
    const newChat = vi.fn();
    render(<Probe handlers={{ toggle, newChat }} shortcuts={{ toggle: 'mod+j', newChat: false }} />);

    fireEvent.keyDown(window, { key: 'i', code: 'KeyI', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'j', code: 'KeyJ', ctrlKey: true, repeat: true });
    expect(toggle).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'j', code: 'KeyJ', ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('lets the app veto a key press, for a dialog that owns the keyboard', () => {
    platform('Win32');
    const toggle = vi.fn();
    render(<Probe handlers={{ toggle }} shouldIgnore={() => true} />);
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI', ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('keeps a bare key out of text fields but lets Escape through', () => {
    platform('Win32');
    const toggle = vi.fn();
    const close = vi.fn();
    const view = render(<Probe handlers={{ toggle, close }} shortcuts={{ toggle: 'k', close: 'escape' }} />);
    const field = view.getByLabelText('draft');
    fireEvent.keyDown(field, { key: 'k', code: 'KeyK' });
    fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' });
    expect(toggle).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes a shortcut the way each platform shows it', () => {
    platform('MacIntel');
    expect(formatShortcut('mod+i')).toBe('⌘I');
    expect(formatShortcut('alt+shift+d')).toBe('⌥⇧D');
    platform('Win32');
    expect(formatShortcut('mod+i')).toBe('Ctrl+I');
    expect(formatShortcut('alt+shift+d')).toBe('Alt+Shift+D');
    expect(formatShortcut(false)).toBe('');
  });
});
