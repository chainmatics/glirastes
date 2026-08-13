// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../message-bubble.js';

const chatContext = vi.hoisted(() => ({
  current: {
    classNames: {},
    components: {
      Markdown: ({ content }: { content: string }) => <div>{content}</div>,
    },
    toolResults: { mode: 'default' },
  },
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

describe('MessageBubble tool-result visibility', () => {
  afterEach(() => {
    cleanup();
    chatContext.current.toolResults = { mode: 'default' };
  });

  it('does not expose a tool-result message when display mode is hidden', () => {
    chatContext.current.toolResults = { mode: 'hidden' };

    render(
      <MessageBubble
        message={{
          id: 'message-1',
          role: 'assistant',
          parts: [{
            type: 'tool-result',
            toolInvocationId: 'call-1',
            toolName: 'tasks.update',
            result: { message: 'Interner Aufgabeninhalt' },
          }],
        }}
      />,
    );

    expect(screen.queryByText('Interner Aufgabeninhalt')).toBeNull();
    expect(document.querySelector('[data-component="tool-result"]')).toBeNull();
  });

  it('applies hidden mode to AI SDK dynamic tool parts too', () => {
    chatContext.current.toolResults = { mode: 'hidden' };

    render(
      <MessageBubble
        message={{
          id: 'message-2',
          role: 'assistant',
          parts: [{
            type: 'tool-tasks.update',
            toolCallId: 'call-2',
            state: 'output-available',
            output: { message: 'Vertrauliches Tool-Ergebnis' },
          } as never],
        }}
      />,
    );

    expect(screen.queryByText('Vertrauliches Tool-Ergebnis')).toBeNull();
    expect(document.querySelector('[data-component="message-bubble"]')).toBeNull();
  });

  it('renders only allowlisted tool results', () => {
    chatContext.current.toolResults = {
      mode: 'allowlist',
      allowlist: ['tasks.read'],
    };

    render(
      <MessageBubble
        message={{
          id: 'message-3',
          role: 'assistant',
          parts: [
            {
              type: 'tool-result',
              toolInvocationId: 'call-3',
              toolName: 'tasks.update',
              result: { message: 'Änderung verborgen' },
            },
            {
              type: 'tool-result',
              toolInvocationId: 'call-4',
              toolName: 'tasks.read',
              result: { message: 'Lesen erlaubt' },
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText('Änderung verborgen')).toBeNull();
    const visibleResult = document.querySelector(
      '[data-component="tool-result"][data-tool="tasks.read"]',
    );
    expect(visibleResult?.textContent).toContain('Lesen erlaubt');
    expect(document.querySelectorAll('[data-component="tool-result"]')).toHaveLength(1);
  });

  it('does not render standard follow-up registration as a raw tool result', () => {
    render(
      <MessageBubble
        message={{
          id: 'message-4',
          role: 'assistant',
          parts: [{
            type: 'tool-result',
            toolInvocationId: 'call-5',
            toolName: 'suggest_followups',
            result: {
              message: 'Suggestions registered',
              followups: ['Aufgaben prüfen'],
            },
          }],
        }}
      />,
    );

    expect(screen.queryByText('Suggestions registered')).toBeNull();
    expect(document.querySelector('[data-component="message-bubble"]')).toBeNull();
  });

  it('renders only the answer when the model appends a suggestion list', () => {
    render(
      <MessageBubble
        message={{
          id: 'message-5',
          role: 'assistant',
          parts: [{
            type: 'text',
            text: 'Kanban-Ansicht geöffnet.\n\nVorschläge:\n'
              + '- Zeige meine offenen Aufgaben.\n'
              + '- Erstelle eine neue Aufgabe.\n'
              + '- Filtere nach hoher Priorität.',
          }],
        }}
      />,
    );

    expect(screen.getByText('Kanban-Ansicht geöffnet.')).toBeTruthy();
    expect(screen.queryByText(/Zeige meine offenen Aufgaben/)).toBeNull();
    expect(screen.queryByText(/Vorschläge:/)).toBeNull();
  });

  it('preserves ordinary prose that mentions suggestions', () => {
    render(
      <MessageBubble
        message={{
          id: 'message-6',
          role: 'assistant',
          parts: [{
            type: 'text',
            text: 'Meine Vorschläge: zuerst priorisieren, dann planen.',
          }],
        }}
      />,
    );

    expect(screen.getByText(
      'Meine Vorschläge: zuerst priorisieren, dann planen.',
    )).toBeTruthy();
  });
});
