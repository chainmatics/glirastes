// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../message-bubble.js';
import { deChatLocale } from '../../locale-de.js';
import type { ActivityLogConfig, ChatMessage, PipelineState, ToolResultDisplayConfig } from '../../types.js';

const chatContext = vi.hoisted(() => ({
  current: {
    classNames: {},
    components: {
      Markdown: ({ content }: { content: string }) => <div data-component="markdown">{content}</div>,
    },
    toolResults: { mode: 'hidden' } as ToolResultDisplayConfig,
    activityLog: {} as ActivityLogConfig,
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

afterEach(() => {
  cleanup();
  chatContext.current.toolResults = { mode: 'hidden' };
  chatContext.current.activityLog = {};
  chatContext.current.messages = [];
  chatContext.current.isLoading = false;
  chatContext.current.pipelineState = null;
});

const failed = {
  type: 'tool-tasks_delete',
  toolCallId: 'call-f',
  state: 'output-available',
  output: { success: false, error: 'Aufgabe ist gesperrt', status: 500, retryable: true },
};
const neutral = {
  type: 'tool-tasks_get',
  toolCallId: 'call-n',
  state: 'output-available',
  output: { success: false, error: 'Nicht gefunden', status: 404, retryable: false },
};
const done = {
  type: 'tool-tasks_list',
  toolCallId: 'call-d',
  state: 'output-available',
  output: { success: true, message: '3 Aufgaben' },
};
const sdkError = {
  type: 'tool-tasks_list',
  toolCallId: 'call-x',
  state: 'output-error',
  errorText: 'Invalid input for tool "tasks_list": Type validation failed',
};
const notUsed = {
  type: 'tool-tasks_create',
  toolCallId: 'call-s',
  state: 'output-denied',
  approval: { id: 'a1', approved: true },
};
const refused = {
  type: 'tool-tasks_create',
  toolCallId: 'call-u',
  state: 'output-denied',
  approval: { id: 'a2', approved: false, reason: 'Rejected by user.' },
};

function message(parts: unknown[], id = 'm1'): ChatMessage {
  return { id, role: 'assistant', parts: parts as ChatMessage['parts'] };
}

/** `[status, detail]` per step line. */
function stepLines(): Array<[string | null, string | null]> {
  return Array.from(document.querySelectorAll('[data-element="activity-step"]')).map((row) => [
    row.getAttribute('data-status'),
    row.querySelector('[data-element="detail"]')?.textContent ?? null,
  ]);
}

const ALL = [failed, neutral, done, sdkError, notUsed, refused];

describe('activityLog.details', () => {
  it('auto (default): shows a failure reason the tool returned also with hidden results', () => {
    render(<MessageBubble message={message(ALL)} />);
    expect(stepLines()).toEqual([
      ['error', 'Aufgabe ist gesperrt'],
      ['expected', 'Nicht gefunden'],
      ['done', null],
      // Written by the AI SDK or runtime, not by the tool: only where results are displayed.
      ['error', null],
      ['declined', 'Die Freigabe konnte nicht verwendet werden'],
      // The user refused it: no reason to tell them.
      ['declined', null],
    ]);
  });

  it('auto (default) changes nothing where result blocks are displayed, except the unused approval', () => {
    chatContext.current.toolResults = { mode: 'default' };
    render(<MessageBubble message={message(ALL)} />);
    const auto = stepLines();
    cleanup();
    chatContext.current.activityLog = { details: 'results' };
    render(<MessageBubble message={message(ALL)} />);
    const before = stepLines();
    expect(before).toEqual([
      ['error', 'Aufgabe ist gesperrt'],
      ['expected', 'Nicht gefunden'],
      ['done', '3 Aufgaben'],
      ['error', 'Invalid input for tool "tasks_list": Type validation failed'],
      ['declined', null],
      ['declined', null],
    ]);
    expect(auto).toEqual(before.map((line, i) => (i === 4 ? ['declined', 'Die Freigabe konnte nicht verwendet werden'] : line)));
  });

  it('auto (default) follows the allowlist for done steps and shows the failure reasons of the others', () => {
    chatContext.current.toolResults = { mode: 'allowlist', allowlist: ['tasks_list'] };
    render(<MessageBubble message={message([failed, done])} />);
    expect(stepLines()).toEqual([['error', 'Aufgabe ist gesperrt'], ['done', '3 Aufgaben']]);
  });

  it('results: the rule before 0.18.0, a red step without reason under hidden results', () => {
    chatContext.current.activityLog = { details: 'results' };
    render(<MessageBubble message={message(ALL)} />);
    expect(stepLines().every(([, detail]) => detail === null)).toBe(true);
  });

  it('all: every detail; none: no detail', () => {
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message(ALL)} />);
    expect(stepLines().map(([, detail]) => detail)).toEqual([
      'Aufgabe ist gesperrt',
      'Nicht gefunden',
      '3 Aufgaben',
      'Invalid input for tool "tasks_list": Type validation failed',
      'Die Freigabe konnte nicht verwendet werden',
      null,
    ]);
    cleanup();
    chatContext.current.toolResults = { mode: 'default' };
    chatContext.current.activityLog = { details: 'none' };
    render(<MessageBubble message={message(ALL)} />);
    expect(stepLines().every(([, detail]) => detail === null)).toBe(true);
  });

  it('takes the unused-approval reason from the locale', () => {
    chatContext.current.locale = { ...deChatLocale, activityApprovalNotUsedDetail: 'Zgoda wygasła' };
    render(<MessageBubble message={message([notUsed])} />);
    expect(stepLines()).toEqual([['declined', 'Zgoda wygasła']]);
    chatContext.current.locale = deChatLocale;
  });
});

describe('the classifier marker in the browser', () => {
  it('shows a 4xx the classifier called an error as failed, and keeps the 0.17.3 rule without a marker', () => {
    const output = (extra: Record<string, unknown>) => ({ success: false, error: 'Verboten', status: 403, retryable: false, ...extra });
    render(<MessageBubble message={message([
      { type: 'tool-a', toolCallId: 'c1', state: 'output-available', output: output({ expectedFailure: false }) },
      { type: 'tool-b', toolCallId: 'c2', state: 'output-available', output: output({}) },
      { type: 'tool-c', toolCallId: 'c3', state: 'output-available', output: output({ expectedFailure: true, status: 500 }) },
      { type: 'tool-d', toolCallId: 'c4', state: 'output-available', output: output({ status: 429 }) },
    ])} />);
    expect(stepLines().map(([status]) => status)).toEqual(['error', 'expected', 'expected', 'error']);
  });
});

describe('activityLog.grouping', () => {
  const interleaved = [
    { type: 'step-start' },
    { type: 'text', text: 'Ich suche die Aufgabe.' },
    done,
    { type: 'step-start' },
    neutral,
    { type: 'text', text: 'Nicht gefunden, ich lege sie an.' },
    { ...failed, toolCallId: 'call-f2' },
    { type: 'text', text: 'Das ging nicht.' },
  ];

  /** Top-level order of the bubble: `log:<steps>` or `text:<content>`. */
  function order(): string[] {
    const bubble = document.querySelector('[data-component="message-bubble"]')!;
    return Array.from(bubble.children).map((child) => (
      child.getAttribute('data-component') === 'activity-log'
        ? `log:${child.querySelectorAll('[data-element="activity-step"]').length}`
        : `text:${child.textContent}`
    ));
  }

  it('renders one log for the whole message by default', () => {
    render(<MessageBubble message={message(interleaved)} />);
    expect(order()).toEqual([
      'log:3',
      'text:Ich suche die Aufgabe.',
      'text:Nicht gefunden, ich lege sie an.',
      'text:Das ging nicht.',
    ]);
  });

  it('sections: one log per run of steps at its place between the texts', () => {
    chatContext.current.activityLog = { grouping: 'sections' };
    render(<MessageBubble message={message(interleaved)} />);
    expect(order()).toEqual([
      'text:Ich suche die Aufgabe.',
      'log:2',
      'text:Nicht gefunden, ich lege sie an.',
      'log:1',
      'text:Das ging nicht.',
    ]);
    const logs = document.querySelectorAll('[data-component="activity-log"]');
    expect(logs[0]!.getAttribute('data-state')).toBe('done');
    expect(logs[1]!.getAttribute('data-state')).toBe('error');
  });

  it('sections: only the last log runs and carries the notice', () => {
    chatContext.current.activityLog = { grouping: 'sections' };
    chatContext.current.messages = [{ id: 'm1' }];
    chatContext.current.isLoading = true;
    chatContext.current.pipelineState = { status: 'error' } as PipelineState;
    render(<MessageBubble message={message(interleaved.slice(0, 7))} />);
    const logs = document.querySelectorAll('[data-component="activity-log"]');
    expect(Array.from(logs).map((log) => log.getAttribute('data-state'))).toEqual(['done', 'running']);
    expect(logs[0]!.querySelector('[data-element="activity-notice"]')).toBeNull();
    expect(logs[1]!.querySelector('[data-element="activity-notice"]')!.textContent).toBe(deChatLocale.pipelineErrorLabel);
  });

  it('sections: a message whose steps all come before its text renders as with one log', () => {
    const plain = [done, neutral, { type: 'text', text: 'Fertig.' }];
    render(<MessageBubble message={message(plain)} />);
    const before = document.body.innerHTML;
    cleanup();
    chatContext.current.activityLog = { grouping: 'sections' };
    render(<MessageBubble message={message(plain)} />);
    expect(document.body.innerHTML).toBe(before);
  });
});
