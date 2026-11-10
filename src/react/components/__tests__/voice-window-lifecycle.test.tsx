// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter as SttAdapter } from '../../stt/controller.js';

const boundary = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../stt/deepgram.js', () => ({ DeepgramSttAdapter: class { connect = boundary.connect; } }));
import { ChatWindow } from '../chat-window.js';
import { VoiceInputAddon } from '../voice-input-addon.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); boundary.connect.mockReset(); });

describe('built-in voice in a retained window', () => {
  it('reports a failed hidden finalization without an unhandled rejection', async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    } });
    boundary.connect.mockResolvedValue({ finalize: async () => { throw new Error('fixture-finalize-failed'); }, close: async () => {}, cancel: async () => {} });
    const error = vi.fn();
    const received = vi.fn();
    const view = (open: boolean) => <ChatWindow open={open} keepMounted>
      <VoiceInputAddon disabled={false} language="en" onTranscript={received} onError={error} />
    </ChatWindow>;
    const { rerender } = render(view(true));
    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    await waitFor(() => expect(document.querySelector('[data-component="voice-input-addon"]')?.getAttribute('data-state')).toBe('recording'));
    rerender(view(false));
    await waitFor(() => expect(error).toHaveBeenCalledWith('fixture-finalize-failed'));
    expect(stopTrack).toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    // Vitest additionally fails this run if the event handler leaves its
    // rejected promise unobserved, even though the controller reported it.
  });

  it.each(['close', 'collapse'])('finalizes recording exactly once when %s hides it', async (action) => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    } });
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    const finalize = vi.fn();
    boundary.connect.mockImplementation(async ({ events }: Parameters<SttAdapter['connect']>[0]) => ({
      finalize: async () => { finalize(); await pending; events.onSegment({ id: 'final', sequence: 1, text: 'tomorrow', isFinal: true }); },
      close: async () => {}, cancel: async () => {},
    }));
    const received = vi.fn();
    const view = (open: boolean, collapsed = false) => <ChatWindow open={open} keepMounted mode="sidebar" collapsed={collapsed}>
      <VoiceInputAddon disabled={false} language="en" onTranscript={received} />
    </ChatWindow>;
    const { rerender } = render(view(true));
    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    await waitFor(() => expect(document.querySelector('[data-component="voice-input-addon"]')?.getAttribute('data-state')).toBe('recording'));
    // Stop and hiding can race; only one final draft insertion is allowed.
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    rerender(view(action !== 'close', action === 'collapse'));
    await act(async () => { release(); });
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
    expect(finalize).toHaveBeenCalledOnce();
    expect(received.mock.calls).toEqual([['tomorrow']]);
  });

  it('stops an active recording on collapse without a separate Stop click', async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    } });
    boundary.connect.mockImplementation(async ({ events }: Parameters<SttAdapter['connect']>[0]) => ({
      finalize: async () => { events.onSegment({ id: 'final', sequence: 1, text: 'retained', isFinal: true }); },
      close: async () => {}, cancel: async () => {},
    }));
    const received = vi.fn();
    const view = (collapsed: boolean) => <ChatWindow open keepMounted mode="sidebar" collapsed={collapsed}>
      <VoiceInputAddon disabled={false} language="en" onTranscript={received} />
    </ChatWindow>;
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    await waitFor(() => expect(document.querySelector('[data-component="voice-input-addon"]')?.getAttribute('data-state')).toBe('recording'));
    rerender(view(true));
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
    expect(received.mock.calls).toEqual([['retained']]);
  });
});
