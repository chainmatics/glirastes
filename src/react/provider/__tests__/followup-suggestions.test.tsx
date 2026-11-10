// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTransport } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

function SuggestionProbe() {
  const { suggestionChips } = useChatContext();
  return <div data-testid="suggestions">{suggestionChips.join('|')}</div>;
}

function createTransport(parts: ChatTransport['messages'][number]['parts']): ChatTransport {
  return {
    messages: [{ id: 'assistant-1', role: 'assistant', parts }],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

describe('AiChatProvider follow-up suggestions', () => {
  afterEach(cleanup);

  it('promotes a trailing assistant suggestion list into SDK suggestion state', async () => {
    render(
      <AiChatProvider
        transport={createTransport([{
          type: 'text',
          text: 'Dashboard geöffnet.\n\nVorschläge:\n'
            + '- Zeige meine heutigen Aufgaben.\n'
            + '- Öffne die Gruppenübersicht.\n'
            + '- Erstelle eine neue Aufgabe.',
        }])}
        suggestions={{ staticChips: ['Statischer Vorschlag'], count: 2 }}
      >
        <SuggestionProbe />
      </AiChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('suggestions').textContent).toBe(
        'Zeige meine heutigen Aufgaben.|Öffne die Gruppenübersicht.',
      );
    });
  });

  it('keeps structured follow-up tool output authoritative', async () => {
    render(
      <AiChatProvider
        transport={createTransport([
          {
            type: 'text',
            text: 'Dashboard geöffnet.\n\nVorschläge:\n- Textvorschlag',
          },
          {
            type: 'tool-suggest_followups',
            toolCallId: 'followups-1',
            state: 'output-available',
            output: { followups: ['Strukturierter Vorschlag'] },
          } as never,
        ])}
        suggestions={{ staticChips: ['Statischer Vorschlag'], count: 3 }}
      >
        <SuggestionProbe />
      </AiChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('suggestions').textContent)
        .toBe('Strukturierter Vorschlag');
    });
  });
});
