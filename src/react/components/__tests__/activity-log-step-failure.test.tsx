// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../message-bubble.js';
import { deChatLocale } from '../../locale-de.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import type { ActivityLogConfig, ChatLocale, ChatMessage, ToolLabelConfig, ToolResultDisplayConfig } from '../../types.js';

const chatContext = vi.hoisted(() => ({
  current: {
    classNames: {},
    components: {
      Markdown: ({ content }: { content: string }) => <div data-component="markdown">{content}</div>,
    },
    toolResults: { mode: 'hidden' } as ToolResultDisplayConfig,
    activityLog: {} as ActivityLogConfig,
    locale: {} as ChatLocale,
    toolLabels: { labels: {} } as ToolLabelConfig,
    messages: [] as Array<{ id: string }>,
    isLoading: false,
    pipelineState: null,
  },
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

afterEach(() => {
  cleanup();
  chatContext.current.toolResults = { mode: 'hidden' };
  chatContext.current.activityLog = {};
  chatContext.current.toolLabels = { labels: {} };
});

const endpointFailed = {
  type: 'tool-tasks_delete',
  toolCallId: 'call-e',
  state: 'output-available',
  output: { success: false, error: 'Endpoint failed (503)', status: 503, retryable: true },
};
const backendText = {
  type: 'tool-tasks_update',
  toolCallId: 'call-b',
  state: 'output-available',
  output: { success: false, error: 'Task is locked', status: 500, retryable: true },
};
const withoutText = {
  type: 'tool-tasks_archive',
  toolCallId: 'call-w',
  state: 'output-available',
  output: { success: false },
};
const invalidInput = {
  type: 'tool-tasks_list',
  toolCallId: 'call-i',
  state: 'output-error',
  errorText: 'The assistant sent invalid input for this tool; it was told what to correct.',
};
const fromNewerServer = {
  type: 'tool-tasks_list',
  toolCallId: 'call-n',
  state: 'output-error',
  errorText: 'A brand-new failure text from a newer server.',
};

function message(parts: unknown[]): ChatMessage {
  return { id: 'm1', role: 'assistant', parts: parts as ChatMessage['parts'] };
}

/** `[label, detail]` per step line. */
function stepLines(): Array<[string | null, string | null]> {
  return Array.from(document.querySelectorAll('[data-element="activity-step"]')).map((row) => [
    row.querySelector('[data-element="label"]')?.textContent ?? null,
    row.querySelector('[data-element="detail"]')?.textContent ?? null,
  ]);
}

describe('localized failure details of the activity log', () => {
  it('English (default): every line exactly as before', () => {
    chatContext.current.locale = DEFAULT_LOCALE;
    render(<MessageBubble message={message([endpointFailed, backendText, withoutText, invalidInput])} />);
    expect(stepLines()).toEqual([
      ['tasks_delete', 'Endpoint failed (503)'],
      ['tasks_update', 'Task is locked'],
      ['tasks_archive', null],
      // An SDK-written errorText stays hidden where results are hidden, as before.
      ['tasks_list', null],
    ]);
  });

  it("German: the SDK's own failure text in the chat language; backend text and a step without text as before", () => {
    chatContext.current.locale = deChatLocale;
    render(<MessageBubble message={message([endpointFailed, backendText, withoutText, invalidInput])} />);
    expect(stepLines()).toEqual([
      ['tasks_delete', 'Endpunkt fehlgeschlagen (503)'],
      ['tasks_update', 'Task is locked'],
      ['tasks_archive', null],
      ['tasks_list', null],
    ]);
  });

  it('German with every detail: an SDK-written errorText translated, an unknown one from a newer server unchanged', () => {
    chatContext.current.locale = deChatLocale;
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message([invalidInput, fromNewerServer])} />);
    expect(stepLines()).toEqual([
      ['tasks_list', 'Der Assistent hat ungültige Angaben für dieses Tool gesendet; ihm wurde gesagt, was zu korrigieren ist.'],
      ['tasks_list', 'A brand-new failure text from a newer server.'],
    ]);
  });

  it("keeps the app's step title in its one language and takes the app's own failure text", () => {
    chatContext.current.locale = { ...DEFAULT_LOCALE, activityFailureEndpointFailed: 'Service unavailable ({status})' };
    chatContext.current.toolLabels = { labels: { tasks_delete: { singular: 'Aufgabe löschen', plural: 'Aufgaben löschen' } } };
    render(<MessageBubble message={message([endpointFailed])} />);
    expect(stepLines()).toEqual([['Aufgabe löschen', 'Service unavailable (503)']]);
  });
});
