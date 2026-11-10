// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../message-bubble.js';
import { deChatLocale } from '../../locale-de.js';
import type { PipelineState, ToolResultDisplayConfig } from '../../types.js';

const chatContext = vi.hoisted(() => ({
  current: {
    classNames: {},
    components: {
      Markdown: ({ content }: { content: string }) => <div>{content}</div>,
    },
    toolResults: { mode: 'default' } as ToolResultDisplayConfig,
    locale: {} as typeof deChatLocale,
    toolLabels: { labels: { 'tasks.update': { singular: 'Aufgabe ändern', plural: 'Aufgaben ändern' } } },
    messages: [] as Array<{ id: string }>,
    isLoading: false,
    pipelineState: null as PipelineState | null,
  },
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

// vi.hoisted runs before imports, so the locale is set here.
chatContext.current.locale = deChatLocale;

describe('MessageBubble tool-result visibility', () => {
  afterEach(() => {
    cleanup();
    chatContext.current.toolResults = { mode: 'default' };
    chatContext.current.messages = [];
    chatContext.current.isLoading = false;
    chatContext.current.pipelineState = null;
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
    expect(document.querySelector('[data-component="tool-result"]')).toBeNull();
    // The activity log still says that a step ran, without its output.
    expect(document.querySelector('[data-component="activity-log"]')?.textContent)
      .toContain('1 Schritt ausgeführt');
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

  it('shows a running tool call of the active turn before any text arrives', () => {
    chatContext.current.messages = [{ id: 'message-7' }];
    chatContext.current.isLoading = true;
    render(
      <MessageBubble
        message={{
          id: 'message-7',
          role: 'assistant',
          parts: [{ type: 'tool-tasks.update', toolCallId: 'c1', state: 'input-available' } as never],
        }}
      />,
    );
    const log = document.querySelector('[data-component="activity-log"]')!;
    expect(log.getAttribute('data-state')).toBe('running');
    expect(log.textContent).toContain('Aufgabe ändern…');
  });

  it('keeps an older turn finished even while a new one loads', () => {
    chatContext.current.messages = [{ id: 'message-8' }, { id: 'message-9' }];
    chatContext.current.isLoading = true;
    render(
      <MessageBubble
        message={{
          id: 'message-8',
          role: 'assistant',
          parts: [{ type: 'tool-tasks.update', toolCallId: 'c1', state: 'output-available', output: {} } as never],
        }}
      />,
    );
    expect(document.querySelector('[data-component="activity-log"]')!.getAttribute('data-state'))
      .toBe('done');
  });

  it('renders a recorded plan above the activity log', () => {
    render(
      <MessageBubble
        message={{
          id: 'message-10',
          role: 'assistant',
          parts: [
            { type: 'tool-update_plan', toolCallId: 'p1', state: 'output-available', input: {
              items: [
                { title: 'Aufgaben suchen', status: 'completed' },
                { title: 'Team anlegen', status: 'completed' },
              ],
            }, output: { success: true, items: 2 } } as never,
            { type: 'tool-tasks.update', toolCallId: 'c1', state: 'output-available', output: {} } as never,
            { type: 'text', text: 'Fertig.' },
          ],
        }}
      />,
    );
    const plan = document.querySelector('[data-component="plan-checklist"]')!;
    const log = document.querySelector('[data-component="activity-log"]')!;
    expect(plan.textContent).toContain('Team anlegen');
    expect(plan.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-component="tool-result"][data-tool="update_plan"]')).toBeNull();
  });

  it('ends the activity log of the latest turn with a pipeline stop', () => {
    chatContext.current.messages = [{ id: 'message-11' }];
    chatContext.current.pipelineState = {
      status: 'safety-stop', totalSteps: 1, maxSteps: 1, stepLimitSource: 'safety',
      updatedAt: '2026-10-28T10:00:00.000Z',
    };
    render(
      <MessageBubble
        message={{
          id: 'message-11',
          role: 'assistant',
          parts: [{ type: 'tool-tasks.update', toolCallId: 'c1', state: 'output-available', output: {} } as never],
        }}
      />,
    );
    expect(document.querySelector('[data-element="activity-notice"]')!.textContent)
      .toBe('Sicherheitsstopp');
  });
});
