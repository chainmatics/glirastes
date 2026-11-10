// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import type { ChatTransport } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { ChatInput } from '../chat-input.js';

const adapter: SttProviderAdapter = {
  connect: async ({ events }) => ({
    finalize: async () => {
      events.onSegment({ id: 's1', sequence: 1, text: 'Neue Aufgabe für morgen', isFinal: true });
    },
    cancel: async () => {},
    close: async () => {},
  }),
};

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Composer({ chat }: { chat: ChatTransport }) {
  const voice = useMemo(() => ({ enabled: true, adapter }), []);
  return (
    <AiChatProvider transport={chat} voice={voice}>
      <ChatInput />
    </AiChatProvider>
  );
}

describe('speech into the draft', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
  });
  afterEach(cleanup);

  it('never sends on finalization and sends the edited draft only on Enter', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Bitte:' } });

    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));

    await waitFor(() => expect(editor.value).toBe('Bitte: Neue Aufgabe für morgen'));
    expect(chat.sendMessage).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: 'Bitte: Neue Aufgabe für Freitag' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledExactlyOnceWith({
      text: 'Bitte: Neue Aufgabe für Freitag',
    }));
  });
});
