// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import type { ChatCompletionProvider, ChatTransport, VoiceInputConfig } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { ChatInput } from '../chat-input.js';
import { MentionInput } from '../mention-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

// recordingBar variant 'composer': the live words stand in the editor, a
// compact waveform sits next to the mic, the mic stops and Escape cancels.

const adapter: SttProviderAdapter = {
  connect: async ({ events }) => {
    queueMicrotask(() => events.onSegment({ id: 's1', sequence: 1, text: 'Angebot an Müller', isFinal: false }));
    return {
      finalize: async () => {
        events.onSegment({ id: 's1', sequence: 1, text: 'Angebot an Müller schicken', isFinal: true });
      },
      cancel: async () => {},
      close: async () => {},
    };
  },
};

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const VOICE: VoiceInputConfig = { enabled: true, adapter, pushToTalk: false, recordingBar: { variant: 'composer' } };
const tickets: ChatCompletionProvider = { id: 'tickets', trigger: '#', search: () => [] };

function TextareaComposer() {
  const chat = useMemo(() => transport(), []);
  return (
    <AiChatProvider transport={chat} voice={VOICE}>
      <ChatInput />
    </AiChatProvider>
  );
}

function PillComposer() {
  const chat = useMemo(() => transport(), []);
  const providers = useMemo(() => [tickets], []);
  return (
    <AiChatProvider transport={chat} voice={VOICE} completionProviders={providers}>
      <MentionInput />
    </AiChatProvider>
  );
}

const mic = () => document.querySelector('[data-component="voice-input-addon"]') as HTMLButtonElement;
const bar = () => document.querySelector('[data-component="recording-bar"]');

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("recordingBar variant 'composer'", () => {
  it('shows the live words as the textarea placeholder, a waveform only, and the mic stops into the draft', async () => {
    render(<TextareaComposer />);
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(mic());
    await waitFor(() => expect(editor.placeholder).toBe('Angebot an Müller'));
    expect(editor.getAttribute('data-live')).toBe('true');
    expect(bar()?.getAttribute('data-variant')).toBe('composer');
    expect(bar()?.querySelector('[data-element="waveform"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    expect(mic().getAttribute('data-state')).toBe('recording');

    fireEvent.click(mic());
    await waitFor(() => expect(editor.value).toBe('Angebot an Müller schicken'));
    expect(editor.getAttribute('data-live')).toBeNull();
    expect(bar()).toBeNull();
  });

  it('shows the live words below a typed draft', async () => {
    render(<TextareaComposer />);
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Bitte:' } });
    fireEvent.click(mic());
    await waitFor(() => expect(document.querySelector('[data-element="live-transcript"]')?.textContent).toBe('Angebot an Müller'));
    expect(editor.getAttribute('data-live')).toBeNull();
  });

  it('Escape discards the recording and leaves the draft empty', async () => {
    render(<TextareaComposer />);
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(mic());
    await waitFor(() => expect(editor.placeholder).toBe('Angebot an Müller'));
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await waitFor(() => expect(bar()).toBeNull());
    expect(editor.value).toBe('');
    expect(editor.getAttribute('data-live')).toBeNull();
  });

  it('shows the live words in the pill editor in place of the placeholder', async () => {
    const { container } = render(<PillComposer />);
    fireEvent.click(mic());
    await waitFor(() => {
      const placeholder = container.querySelector('[data-element="placeholder"]');
      expect(placeholder?.textContent).toBe('Angebot an Müller');
      expect(placeholder?.getAttribute('data-live')).toBe('true');
    });
    fireEvent.click(mic());
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe('Angebot an Müller schicken'));
    expect(container.querySelector('[data-element="placeholder"][data-live]')).toBeNull();
  });
});

describe('RichMentionInput liveText', () => {
  afterEach(cleanup);

  it('keeps only the newest words of a long transcript', () => {
    const long = `${'alt '.repeat(100)}neueste Worte`;
    const { container } = render(<RichMentionInput placeholder="Ask" liveText={long} onSearch={() => []} />);
    const text = container.querySelector('[data-element="placeholder"]')?.textContent ?? '';
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('neueste Worte')).toBe(true);
    expect(text.length).toBe(240);
  });

  it('shows the placeholder while no words arrived yet', () => {
    const { container } = render(<RichMentionInput placeholder="Ask" liveText="" onSearch={() => []} />);
    const placeholder = container.querySelector('[data-element="placeholder"]');
    expect(placeholder?.textContent).toBe('Ask');
    expect(placeholder?.getAttribute('data-live')).toBeNull();
  });
});
