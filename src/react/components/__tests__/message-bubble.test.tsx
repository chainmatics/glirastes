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
    expect(document.querySelector('[data-element="pipeline-notice"]')!.textContent)
      .toContain('Sicherheitsbudget');
  });
});

describe('MessageBubble attachments', () => {
  afterEach(cleanup);

  it('renders sent files: image link, file chip and an unavailable chip', () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: 'user-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Schau mal' },
            { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==', filename: 'shot.png' },
            { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,AA==', filename: 'report.pdf' },
            { type: 'file', mediaType: 'image/png', url: '', filename: 'old.png' },
          ],
        }}
      />,
    );

    const link = screen.getByRole('link', { name: 'shot.png öffnen' });
    expect(link.getAttribute('href')).toBe('data:image/png;base64,AA==');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.querySelector('img')?.getAttribute('alt')).toBe('shot.png');
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'report.pdf öffnen' })).toBeNull();
    const omitted = container.querySelector('[data-element="message-attachment"][data-state="unavailable"]');
    expect(omitted?.textContent).toContain('old.png');
    expect(omitted?.textContent).toContain('Nicht mehr verfügbar');
  });

  it('renders an attachment-only message', () => {
    render(
      <MessageBubble
        message={{ id: 'user-2', role: 'user', parts: [{ type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,AA==', filename: 'a.pdf' }] }}
      />,
    );
    expect(screen.getByText('a.pdf')).toBeTruthy();
  });

  it('opens a data image through a blob URL, since browsers block top-level data: navigation', () => {
    const createObjectURL = vi.fn(() => 'blob:shot');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <MessageBubble
        message={{ id: 'user-3', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==', filename: 'shot.png' }] }}
      />,
    );
    const link = screen.getByRole('link', { name: 'shot.png öffnen' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(open).toHaveBeenCalledWith('blob:shot', '_blank', 'noopener,noreferrer');
    open.mockRestore();
    vi.unstubAllGlobals();
  });
});


describe('durable stop feedback', () => {
  afterEach(cleanup);
  it('shows a persisted safety stop even without tool calls and outside collapsed activity', () => {
    render(<MessageBubble message={{ id: 'old-stop', role: 'assistant', parts: [
      { type: 'data-pipeline-state', data: { status: 'safety-stop', totalSteps: 6, maxSteps: 6, stepLimitSource: 'runtime-budget' } } as never,
    ] }} />);
    const notice = document.querySelector('[data-element="pipeline-notice"]');
    expect(notice?.textContent).toContain('6');
    expect(notice?.closest('details')).toBeNull();
  });
  it('shows rejected browser action feedback independently of result visibility', () => {
    chatContext.current.toolResults = { mode: 'hidden' };
    render(<MessageBubble message={{ id: 'ui-rejected', role: 'assistant', parts: [
      { type: 'data-ui-action-status', data: { toolCallId: 'c1', status: 'rejected' } } as never,
    ] }} />);
    expect(document.querySelector('[data-element="ui-action-status"]')?.textContent).toContain('abgelehnt');
  });
});
