// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcut } from '../use-keyboard-shortcut.js';

/** A keydown that carries modifier flags but no `key`, as non-KeyboardEvent dispatchers produce. */
function keylessKeyDown(modifiers: { ctrlKey: boolean }): Event {
  return Object.assign(new Event('keydown', { bubbles: true }), {
    ...modifiers,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  });
}

function captureWindowErrors(run: () => void): unknown[] {
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener('error', onError);
  try {
    run();
  } finally {
    window.removeEventListener('error', onError);
  }
  return errors;
}

describe('useKeyboardShortcut', () => {
  afterEach(cleanup);

  it('fires for its combo', () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut('ctrl+i', handler));
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ctrl+i', true],
    ['escape', false],
  ])('ignores a key-less keydown for %s without throwing', (combo, ctrlKey) => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut(combo, handler));
    const errors = captureWindowErrors(() => fireEvent(window, keylessKeyDown({ ctrlKey })));
    expect(errors).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});
