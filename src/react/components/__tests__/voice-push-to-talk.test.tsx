// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { ChatWindowVisibilityContext } from '../chat-window-visibility.js';
import { VoiceInputAddon } from '../voice-input-addon.js';

let stopTrack = vi.fn();
let getUserMedia = vi.fn();

function fakeAdapter(options: { failFirst?: boolean } = {}): SttProviderAdapter {
  let connects = 0;
  return {
    connect: vi.fn(async ({ events }) => {
      connects += 1;
      if (options.failFirst && connects === 1) throw new Error('fixture provider unavailable');
      events.onSegment({ id: 's1', sequence: 1, text: 'hallo wel', isFinal: false });
      return {
        finalize: async () => {
          events.onSegment({ id: 's1', sequence: 1, text: 'Hallo Welt', isFinal: true });
        },
        cancel: async () => {},
        close: async () => {},
      };
    }),
  };
}

const mic = () => screen.getByRole('button', { name: /^(mic|stop)$/ });
const state = () => document.querySelector('[data-component="voice-input-addon"]')?.getAttribute('data-state');

beforeEach(() => {
  stopTrack = vi.fn();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('push-to-talk and interim transcript', () => {
  it('records while the button is held and inserts the final text on release', async () => {
    let clock = 0;
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} now={() => clock} />);

    fireEvent.pointerDown(mic(), { button: 0 });
    await waitFor(() => expect(state()).toBe('recording'));
    expect(document.querySelector('[data-part="interim-transcript"]')?.textContent).toBe('hallo wel');
    expect(received).not.toHaveBeenCalled();

    clock = 500;
    fireEvent.pointerUp(window);
    fireEvent.click(mic());
    await waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    expect(stopTrack).toHaveBeenCalled();
    expect(state()).toBe('idle');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps recording after a short tap and stops on the next click (toggle)', async () => {
    let clock = 0;
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} now={() => clock} />);

    fireEvent.pointerDown(mic(), { button: 0 });
    clock = 120;
    fireEvent.pointerUp(window);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    expect(received).not.toHaveBeenCalled();

    fireEvent.click(mic());
    await waitFor(() => expect(received).toHaveBeenCalledWith('Hallo Welt'));
  });

  it('records while the hotkey is held', async () => {
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} />);

    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(state()).toBe('recording'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, repeat: true });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('can turn push-to-talk off and keep toggle only', async () => {
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={vi.fn()} pushToTalk={false} />);
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    fireEvent.pointerDown(mic(), { button: 0 });
    await act(async () => {});
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
  });
});

describe('recording lifecycle boundaries', () => {
  it('stops on a route change and keeps the speech as draft', async () => {
    const received = vi.fn();
    const adapter = fakeAdapter();
    const view = (route: string) => <VoiceInputAddon disabled={false} language="de"
      adapter={adapter} onTranscript={received} routeKey={route} />;
    const { rerender } = render(view('/tasks'));
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    rerender(view('/reports'));
    await waitFor(() => expect(received).toHaveBeenCalledWith('Hallo Welt'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('stops on browser back/forward navigation', async () => {
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()} onTranscript={vi.fn()} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });

  it('stops when the chat session switches', async () => {
    const received = vi.fn();
    const adapter = fakeAdapter();
    const view = (activeSessionId: string) => (
      <ChatContext.Provider value={{ activeSessionId, locale: {} } as unknown as ChatContextValue}>
        <VoiceInputAddon disabled={false} language="de" adapter={adapter} onTranscript={received} />
      </ChatContext.Provider>
    );
    const { rerender } = render(view('a'));
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    rerender(view('b'));
    await waitFor(() => expect(received).toHaveBeenCalledWith('Hallo Welt'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('offers an explicit retry after a provider failure', async () => {
    const onError = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter({ failFirst: true })}
      onTranscript={vi.fn()} onError={onError} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('failed'));
    expect(onError).toHaveBeenCalledWith('fixture provider unavailable');
    expect(stopTrack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry recording' }));
    await waitFor(() => expect(state()).toBe('recording'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('cancels without inserting text and releases the microphone', async () => {
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()} onTranscript={received} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    fireEvent.click(document.querySelector('[data-element="cancel-button"]')!);
    await waitFor(() => expect(state()).toBe('idle'));
    expect(stopTrack).toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });

  it('releases the microphone on unmount', async () => {
    const { unmount } = render(<VoiceInputAddon disabled={false} language="de"
      adapter={fakeAdapter()} onTranscript={vi.fn()} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    unmount();
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });
});

describe('one hotkey owner per page', () => {
  const hold = { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true };
  const states = () => [...document.querySelectorAll('[data-component="voice-input-addon"]')]
    .map((button) => button.getAttribute('data-state'));

  it('opens one controller and one microphone stream for two composers', async () => {
    const firstAdapter = fakeAdapter();
    const secondAdapter = fakeAdapter();
    const first = vi.fn();
    const second = vi.fn();
    render(<>
      <VoiceInputAddon disabled={false} language="de" adapter={firstAdapter} onTranscript={first} />
      <VoiceInputAddon disabled={false} language="de" adapter={secondAdapter} onTranscript={second}
        pushToTalk={{ hotkey: 'shift+mod+space' }} />
    </>);

    fireEvent.keyDown(window, hold);
    await waitFor(() => expect(states()).toEqual(['recording', 'idle']));
    fireEvent.keyUp(window, hold);
    await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));

    expect(second).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(firstAdapter.connect).toHaveBeenCalledTimes(1);
    expect(secondAdapter.connect).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('hands the hotkey to the next composer when the owner unmounts', async () => {
    const second = vi.fn();
    const view = (withFirst: boolean) => <>
      {withFirst && <VoiceInputAddon key="first" disabled={false} language="de"
        adapter={fakeAdapter()} onTranscript={vi.fn()} />}
      <VoiceInputAddon key="second" disabled={false} language="de"
        adapter={fakeAdapter()} onTranscript={second} />
    </>;
    const { rerender } = render(view(true));
    rerender(view(false));

    fireEvent.keyDown(window, hold);
    await waitFor(() => expect(states()).toEqual(['recording']));
    fireEvent.keyUp(window, hold);
    await waitFor(() => expect(second).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('never gives the hotkey to a composer in a hidden window', async () => {
    const visible = vi.fn();
    const hidden = vi.fn();
    render(<>
      <ChatWindowVisibilityContext.Provider value={false}>
        <VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()} onTranscript={hidden} />
      </ChatWindowVisibilityContext.Provider>
      <VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()} onTranscript={visible} />
    </>);

    fireEvent.keyDown(window, hold);
    await waitFor(() => expect(states()).toEqual(['idle', 'recording']));
    fireEvent.keyUp(window, hold);
    await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    expect(hidden).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('a button press never swallows an unrelated click', () => {
  it('lets the next click through after a cancelled press', async () => {
    let clock = 0;
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={vi.fn()} now={() => clock} />);
    fireEvent.pointerDown(mic(), { button: 0 });
    await waitFor(() => expect(state()).toBe('recording'));

    // A touch long press ends in pointercancel, and no click follows it.
    clock = 600;
    fireEvent(window, new Event('pointercancel'));
    await waitFor(() => expect(state()).toBe('idle'));

    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('lets the next click through after releasing outside the button', async () => {
    let clock = 0;
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={vi.fn()} now={() => clock} />);
    fireEvent.pointerDown(mic(), { button: 0 });
    await waitFor(() => expect(state()).toBe('recording'));

    clock = 600;
    fireEvent.pointerUp(document.body);
    await waitFor(() => expect(state()).toBe('idle'));

    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not restart on the click that follows releasing a hold over the button', async () => {
    let clock = 0;
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} now={() => clock} />);
    fireEvent.pointerDown(mic(), { button: 0 });
    await waitFor(() => expect(state()).toBe('recording'));

    // The stop has finished before the click arrives (a fast provider).
    clock = 600;
    fireEvent.pointerUp(mic());
    await waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    await waitFor(() => expect(state()).toBe('idle'));
    fireEvent.click(mic());
    await act(async () => {});
    expect(state()).toBe('idle');
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // The swallowed click used up the press; the next one is a plain click.
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});
