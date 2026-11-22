// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import { AudioWorkletLoadError } from '../../stt/worklet-error.js';
import { RecordedSttAdapter } from '../../stt/recorded.js';
import type { ChatTransport, VoiceInputConfig } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { ChatInput } from '../chat-input.js';
import { VoiceInputButton } from '../voice-input-button.js';

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Composer({ voice }: { voice: VoiceInputConfig }) {
  const chat = useMemo(() => transport(), []);
  return (
    <AiChatProvider transport={chat} voice={voice}>
      <ChatInput />
    </AiChatProvider>
  );
}

const button = () => document.querySelector('[data-component="voice-input-addon"]') as HTMLButtonElement;

function failingAdapter(error: Error): SttProviderAdapter {
  return { connect: async () => { throw error; } };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.lang = '';
});

describe('voice input failures are never silent', () => {
  it('shows the localized worklet error as an alert (English default)', async () => {
    const adapter = failingAdapter(new AudioWorkletLoadError('/audio-worklet-processor.js'));
    render(<Composer voice={{ enabled: true, adapter }} />);
    fireEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Voice input is unavailable: the audio module could not be loaded.');
    expect(button().getAttribute('data-state')).toBe('failed');
  });

  it('shows the German worklet error with deChatLocale', async () => {
    document.documentElement.lang = 'de';
    const adapter = failingAdapter(new AudioWorkletLoadError('/audio-worklet-processor.js'));
    render(<Composer voice={{ enabled: true, adapter }} />);
    fireEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Spracheingabe nicht verfügbar: Das Audiomodul konnte nicht geladen werden.');
    expect(screen.getByRole('button', { name: 'Aufnahme wiederholen' })).toBeTruthy();
  });

  it('shows a general error text for other failures', async () => {
    render(<Composer voice={{ enabled: true, adapter: failingAdapter(new Error('denied')) }} />);
    fireEvent.click(button());
    expect((await screen.findByRole('alert')).textContent).toBe('Voice input failed. Try again.');
  });
});

describe('voice button states', () => {
  it('uses icons and localized labels instead of literal text', async () => {
    let finalize!: () => void;
    const adapter: SttProviderAdapter = {
      connect: async () => ({
        finalize: () => new Promise<void>((done) => { finalize = done; }),
        cancel: async () => {},
        close: async () => {},
      }),
    };
    render(<Composer voice={{ enabled: true, adapter, recordingBar: { enabled: false } }} />);
    expect(button().getAttribute('aria-label')).toBe('Start voice input');
    expect(button().textContent).toBe('');
    expect(button().querySelector('svg[aria-hidden="true"]')).toBeTruthy();

    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('data-state')).toBe('recording'));
    expect(button().getAttribute('aria-label')).toBe('Stop recording');
    expect(button().textContent).toBe('');

    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-label')).toBe('Transcribing…'));
    finalize();
    await waitFor(() => expect(button().getAttribute('aria-label')).toBe('Start voice input'));
  });

  it('labels the retry button with an icon only', async () => {
    render(<Composer voice={{ enabled: true, adapter: failingAdapter(new Error('denied')) }} />);
    fireEvent.click(button());
    const retry = await screen.findByRole('button', { name: 'Retry recording' });
    expect(retry.textContent).toBe('');
    expect(retry.querySelector('svg')).toBeTruthy();
  });

  it('VoiceInputButton shows icons, localized labels and the failure alert', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<VoiceInputButton onTranscript={vi.fn()} adapter={failingAdapter(new AudioWorkletLoadError('/x.js'))} />);
    const own = screen.getByRole('button', { name: 'Start voice input' });
    expect(own.textContent).toBe('');
    fireEvent.click(own);
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Voice input is unavailable: the audio module could not be loaded.');
    expect(own.getAttribute('data-state')).toBe('failed');
    error.mockRestore();
  });
});

describe('voice.workletUrl with an own adapter', () => {
  it('reaches a RecordedSttAdapter that sets none itself', async () => {
    const connect = vi.spyOn(RecordedSttAdapter.prototype, 'connect').mockImplementation(async () => ({
      finalize: async () => {}, cancel: async () => {}, close: async () => {},
    }));
    const adapter = new RecordedSttAdapter();
    render(<Composer voice={{ enabled: true, adapter, workletUrl: '/static/pcm.js' }} />);
    fireEvent.click(button());
    await waitFor(() => expect(connect).toHaveBeenCalled());
    expect(connect.mock.calls[0]![0].workletUrl).toBe('/static/pcm.js');
  });

  it('warns once when the adapter does not accept it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter: SttProviderAdapter = {
      connect: async () => ({ finalize: async () => {}, cancel: async () => {}, close: async () => {} }),
    };
    const { unmount } = render(<Composer voice={{ enabled: true, adapter, workletUrl: '/static/pcm.js' }} />);
    unmount();
    render(<Composer voice={{ enabled: true, adapter, workletUrl: '/static/pcm.js' }} />);
    const calls = warn.mock.calls.filter(([message]) => String(message).includes('workletUrl'));
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toContain('constructor');
  });
});
