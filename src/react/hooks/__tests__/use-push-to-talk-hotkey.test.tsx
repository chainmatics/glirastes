// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  parseHoldCombo,
  usePushToTalkHotkey,
} from '../use-push-to-talk-hotkey.js';

const space = { key: ' ', code: 'Space' };

function setup(hotkey: string | false = DEFAULT_PUSH_TO_TALK_HOTKEY, enabled = true) {
  const onPress = vi.fn();
  const onRelease = vi.fn();
  const hook = renderHook(
    (props: { enabled: boolean }) => usePushToTalkHotkey({ hotkey, enabled: props.enabled, onPress, onRelease }),
    { initialProps: { enabled } },
  );
  return { onPress, onRelease, ...hook };
}

describe('usePushToTalkHotkey', () => {
  afterEach(cleanup);

  it('parses hold combos including space', () => {
    expect(parseHoldCombo('mod+shift+space')).toEqual({ key: 'space', mod: true, shift: true, alt: false });
    expect(parseHoldCombo('alt+m')).toEqual({ key: 'm', mod: false, shift: false, alt: true });
    expect(parseHoldCombo('shift')).toBeNull();
  });

  it('presses once on keydown, ignores repeats and releases on keyup', () => {
    const { onPress, onRelease } = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true, repeat: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { ...space, ctrlKey: true, shiftKey: true });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('ends the hold when a modifier is released first (macOS swallows keyup under ⌘)', () => {
    const { onRelease } = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    fireEvent.keyUp(window, { key: 'Shift', ctrlKey: true });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('ends the hold on window blur and on unmount', () => {
    const blurred = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    fireEvent.blur(window);
    expect(blurred.onRelease).toHaveBeenCalledTimes(1);
    blurred.unmount();

    const unmounted = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    unmounted.unmount();
    expect(unmounted.onRelease).toHaveBeenCalledTimes(1);
  });

  it('ignores other combos and stays inactive when disabled or false', () => {
    const plain = setup();
    fireEvent.keyDown(window, { ...space });
    fireEvent.keyDown(window, { ...space, ctrlKey: true });
    expect(plain.onPress).not.toHaveBeenCalled();
    plain.unmount();

    const disabled = setup(DEFAULT_PUSH_TO_TALK_HOTKEY, false);
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    expect(disabled.onPress).not.toHaveBeenCalled();
    disabled.unmount();

    const off = setup(false);
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    expect(off.onPress).not.toHaveBeenCalled();
  });
});
