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

describe('a failure text the server wrote in another wording (data-step-failure)', () => {
  const failedDe = { type: 'tool-tasks_list', toolCallId: 'call-g', state: 'output-error', errorText: 'KI-Anfrage fehlgeschlagen' };
  const invalidDe = {
    type: 'tool-tasks_update',
    toolCallId: 'call-v',
    state: 'output-error',
    errorText: 'Der Assistent hat ungültige Angaben für dieses Tool gesendet; ihm wurde gesagt, was zu korrigieren ist.',
  };
  const ownServerText = { type: 'tool-tasks_list', toolCallId: 'call-o', state: 'output-error', errorText: 'Bad arguments, retrying' };
  const kind = (toolCallId: string, code: string) => ({ type: 'data-step-failure', id: toolCallId, data: { toolCallId, code } });

  it("a German turn: the client locale's activityFailure texts", () => {
    chatContext.current.locale = deChatLocale;
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message([failedDe, kind('call-g', 'failed'), invalidDe, kind('call-v', 'invalid-input')])} />);
    expect(stepLines()).toEqual([
      ['tasks_list', deChatLocale.activityFailureGeneric!],
      ['tasks_update', deChatLocale.activityFailureInvalidInput!],
    ]);
  });

  it("the app's own activityFailure texts win over the server's German text", () => {
    chatContext.current.locale = {
      ...deChatLocale,
      activityFailureGeneric: 'Hat nicht geklappt',
      activityFailureInvalidInput: 'Falsche Angaben, wird korrigiert',
    };
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message([failedDe, kind('call-g', 'failed'), invalidDe, kind('call-v', 'invalid-input')])} />);
    expect(stepLines()).toEqual([
      ['tasks_list', 'Hat nicht geklappt'],
      ['tasks_update', 'Falsche Angaben, wird korrigiert'],
    ]);
  });

  it("an app whose own locale words the log in English gets its English text, not the server's German", () => {
    chatContext.current.locale = DEFAULT_LOCALE;
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message([failedDe, kind('call-g', 'failed')])} />);
    expect(stepLines()).toEqual([['tasks_list', 'AI request failed']]);
  });

  it("a server's own locales text is recognized by its named kind", () => {
    chatContext.current.locale = deChatLocale;
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message([ownServerText, kind('call-o', 'invalid-input')])} />);
    expect(stepLines()).toEqual([['tasks_list', deChatLocale.activityFailureInvalidInput!]]);
  });

  it('also in a run of steps after a text, where the part sits elsewhere in the message', () => {
    chatContext.current.locale = deChatLocale;
    chatContext.current.activityLog = { details: 'all', grouping: 'sections' };
    render(<MessageBubble message={message([
      { type: 'text', text: 'Erst das.' },
      failedDe,
      { type: 'text', text: 'Dann das.' },
      ownServerText,
      { type: 'text', text: 'Fertig.' },
      kind('call-g', 'failed'),
      kind('call-o', 'failed'),
    ])} />);
    expect(stepLines()).toEqual([
      ['tasks_list', deChatLocale.activityFailureGeneric!],
      ['tasks_list', deChatLocale.activityFailureGeneric!],
    ]);
  });

  it('without a part, or with one for another call or an unknown code, the text stays as it is', () => {
    chatContext.current.locale = deChatLocale;
    chatContext.current.activityLog = { details: 'all' };
    render(<MessageBubble message={message([ownServerText, kind('call-x', 'failed'), failedDe, kind('call-g', 'bogus')])} />);
    expect(stepLines()).toEqual([
      ['tasks_list', 'Bad arguments, retrying'],
      ['tasks_list', 'KI-Anfrage fehlgeschlagen'],
    ]);
  });
});
