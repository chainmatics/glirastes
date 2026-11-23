// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble, useMessageParts } from '../message-bubble.js';
import { deChatLocale } from '../../locale-de.js';
import type {
  ActivityLogConfig,
  ChatComponents,
  ChatMessage,
  MessagePartsProps,
  PipelineState,
  ToolResultDisplayConfig,
} from '../../types.js';

const chatContext = vi.hoisted(() => ({
  current: {
    classNames: {},
    components: {} as Record<string, unknown>,
    activityLog: {} as Record<string, unknown>,
    toolResults: { mode: 'default' } as ToolResultDisplayConfig,
    locale: {} as typeof deChatLocale,
    toolLabels: { labels: {} },
    messages: [] as Array<{ id: string }>,
    isLoading: false,
    pipelineState: null as PipelineState | null,
  },
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

chatContext.current.locale = deChatLocale;

const Markdown = ({ content }: { content: string }) => <div data-component="markdown">{content}</div>;

function stopped(status: PipelineState['status'] = 'aborted'): PipelineState {
  return { status, totalSteps: 1, maxSteps: 5, stepLimitSource: 'explicit', updatedAt: '2026-11-18T10:00:00.000Z' };
}

function latest(message: ChatMessage, options: {
  pipelineState?: PipelineState | null;
  activityLog?: ActivityLogConfig;
  components?: ChatComponents;
} = {}) {
  chatContext.current.messages = [{ id: message.id }];
  chatContext.current.pipelineState = options.pipelineState ?? null;
  chatContext.current.activityLog = (options.activityLog ?? {}) as Record<string, unknown>;
  chatContext.current.components = { Markdown, ...(options.components ?? {}) };
  return render(<MessageBubble message={message} />);
}

const withStep: ChatMessage = {
  id: 'm-step',
  role: 'assistant',
  parts: [
    { type: 'tool-tasks_list', toolCallId: 'c1', state: 'output-available', output: {} } as never,
    { type: 'text', text: 'Hier sind die Aufgaben.' },
  ],
};

const textOnly: ChatMessage = {
  id: 'm-text',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Ich habe angefangen' }],
};

function bubbleChildren() {
  const bubble = document.querySelector('[data-component="message-bubble"]')!;
  return Array.from(bubble.children).map((child) => child.getAttribute('data-component'));
}

afterEach(() => {
  cleanup();
  chatContext.current.messages = [];
  chatContext.current.pipelineState = null;
  chatContext.current.activityLog = {};
  chatContext.current.components = {};
  chatContext.current.isLoading = false;
});

describe('turn notice', () => {
  it('keeps the notice inside the activity log by default', () => {
    latest(withStep, { pipelineState: stopped() });
    const log = document.querySelector('[data-component="activity-log"]')!;
    expect(log.querySelector('[data-element="activity-notice"]')!.textContent).toBe('Gestoppt');
    expect(document.querySelector('[data-component="turn-notice"]')).toBeNull();
  });

  it('shows the notice of a turn without steps', () => {
    latest(textOnly, { pipelineState: stopped() });
    const notice = document.querySelector('[data-component="turn-notice"]');
    expect(notice?.textContent).toBe('Gestoppt');
    expect(notice?.getAttribute('data-status')).toBe('aborted');
    expect(document.querySelector('[data-component="activity-log"]')).toBeNull();
  });

  it('shows the notice of an assistant turn that stopped before any output', () => {
    latest({ id: 'm-empty', role: 'assistant', parts: [] }, { pipelineState: stopped('error') });
    expect(document.querySelector('[data-component="turn-notice"]')?.textContent).toBe('Fehler');
  });

  it('moves the notice out of the log with noticePlacement message', () => {
    latest(withStep, { pipelineState: stopped('safety-stop'), activityLog: { noticePlacement: 'message' } });
    const log = document.querySelector('[data-component="activity-log"]')!;
    expect(log.querySelector('[data-element="activity-notice"]')).toBeNull();
    const notice = document.querySelector('[data-component="turn-notice"]')!;
    expect(notice.textContent).toBe('Sicherheitsstopp');
    // Right after the log, before the text.
    expect(bubbleChildren()).toEqual(['activity-log', 'turn-notice', 'markdown', 'tool-result']);
  });

  it('renders the TurnNotice slot outside the log', () => {
    const seen: unknown[] = [];
    latest(textOnly, {
      pipelineState: stopped(),
      components: {
        TurnNotice: (props) => {
          seen.push(props);
          return <aside data-testid="mine">{props.text}</aside>;
        },
      },
    });
    expect(document.querySelector('[data-testid="mine"]')!.textContent).toBe('Gestoppt');
    expect(seen).toEqual([{ text: 'Gestoppt', status: 'aborted', placement: 'message' }]);
  });

  it('shows no notice on a user message, an older message or without a stop', () => {
    latest({ id: 'm-user', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] }, { pipelineState: stopped() });
    expect(document.body.textContent).not.toContain('Gestoppt');
    cleanup();

    // A stored or older turn: not the latest message.
    chatContext.current.messages = [{ id: 'm-text' }, { id: 'm-later' }];
    chatContext.current.pipelineState = stopped();
    chatContext.current.components = { Markdown };
    render(<MessageBubble message={textOnly} />);
    expect(document.body.textContent).not.toContain('Gestoppt');
    cleanup();

    latest(withStep, { pipelineState: { ...stopped(), status: 'completed' } });
    expect(document.querySelector('[data-element="activity-notice"]')).toBeNull();
    expect(document.querySelector('[data-component="turn-notice"]')).toBeNull();
  });
});

describe('message parts', () => {
  it('keeps the default order: log, attachments, text, results', () => {
    latest({
      id: 'm-order',
      role: 'assistant',
      parts: [
        { type: 'tool-tasks_list', toolCallId: 'c0', state: 'output-available', output: {} } as never,
        { type: 'text', text: 'Fertig.' },
        { type: 'file', url: 'data:text/plain,a', mediaType: 'text/plain', filename: 'a.txt' } as never,
        { type: 'tool-result', toolInvocationId: 'c1', toolName: 'tasks_get', result: { message: 'Aufgabe 1' } },
      ],
    });
    expect(bubbleChildren()).toEqual([
      'activity-log',
      null, // message-attachments is a data-element
      'markdown',
      'tool-result', // the output of tasks_list
      'tool-result',
    ]);
  });

  it('hands each part to the MessageParts slot by name', () => {
    let props: MessagePartsProps | undefined;
    latest(withStep, {
      pipelineState: stopped(),
      activityLog: { noticePlacement: 'message' },
      components: {
        MessageParts: (received) => {
          props = received;
          return (
            <>
              <div data-testid="text-bubble">{received.text}</div>
              <div data-testid="work">{received.activity}{received.notice}</div>
            </>
          );
        },
      },
    });
    expect(props?.message.id).toBe('m-step');
    expect(document.querySelector('[data-testid="text-bubble"]')!.textContent).toBe('Hier sind die Aufgaben.');
    const work = document.querySelector('[data-testid="work"]')!;
    expect(work.querySelector('[data-component="activity-log"]')).not.toBeNull();
    expect(work.querySelector('[data-component="turn-notice"]')!.textContent).toBe('Gestoppt');
    // The bubble root stays.
    expect(document.querySelector('[data-component="message-bubble"]')).not.toBeNull();
  });

  it('gives the default order as children of the MessageParts slot', () => {
    latest(withStep, {
      components: { MessageParts: ({ children }) => <section data-testid="wrap">{children}</section> },
    });
    const wrap = document.querySelector('[data-testid="wrap"]')!;
    expect(Array.from(wrap.children).map((child) => child.getAttribute('data-component')))
      .toEqual(['activity-log', 'markdown', 'tool-result']);
  });

  it('exposes the parts as a hook for a custom MessageBubble', () => {
    chatContext.current.messages = [{ id: withStep.id }];
    chatContext.current.components = { Markdown };
    const { result } = renderHook(() => useMessageParts(withStep));
    expect(result.current.visible).toBe(true);
    expect(result.current.activity).not.toBeNull();
    expect(result.current.notice).toBeNull();
    expect(result.current.plan).toBeNull();

    const empty = renderHook(() => useMessageParts({ id: 'x', role: 'assistant', parts: [] }));
    expect(empty.result.current.visible).toBe(false);
  });
});
