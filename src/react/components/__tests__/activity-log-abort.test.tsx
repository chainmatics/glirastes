// @vitest-environment jsdom

import React, { useEffect, useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext } from '../../provider/chat-context.js';
import { MessageList } from '../message-list.js';
import type { ChatMessage, ChatTransport, SessionConfig } from '../../types.js';

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

const user: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Delete the old tasks' }] } as ChatMessage;
const assistant = (...parts: unknown[]): ChatMessage => ({ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, ...parts] } as ChatMessage);
const done = { type: 'tool-tasks_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { success: true } };
const running = { type: 'tool-tasks_delete', toolCallId: 'c2', state: 'input-available', input: { id: 't1' } };
const streamingInput = { type: 'tool-tasks_update', toolCallId: 'c3', state: 'input-streaming', input: undefined };
const waitingApproval = {
  type: 'tool-tasks_delete', toolCallId: 'c4', state: 'approval-requested', input: { id: 't1' }, approval: { id: 'ap-1' },
};
const waitingOutcome = {
  type: 'tool-ui_navigate', toolCallId: 'c5', state: 'output-available', input: {},
  output: { handedOff: true, message: 'Handed to the app.', uiAction: { type: 'glirastes.navigate' }, awaitsOutcome: true },
};

let api: ReturnType<typeof useChatContext> | undefined;
function Probe() {
  api = useChatContext();
  return null;
}

interface HarnessProps {
  status: ChatTransport['status'];
  messages: ChatMessage[];
  error?: Error | null;
  stop?: () => void;
  session?: SessionConfig;
  expandWhileRunning?: boolean;
  sections?: boolean;
}

/** A transport whose status and messages the test sets, as `useChat` would. */
function Harness({ status, messages, error = null, stop = () => {}, session, expandWhileRunning, sections }: HarnessProps) {
  const [current, setCurrent] = useState(messages);
  useEffect(() => setCurrent(messages), [messages]);
  const transport = useMemo<ChatTransport>(() => ({
    messages: current,
    status,
    error,
    sendMessage: vi.fn(async () => {}),
    stop,
    setMessages: (next) => setCurrent(next),
    addToolApprovalResponse: vi.fn(async () => {}),
  }), [current, status, error, stop]);
  return (
    <AiChatProvider
      transport={transport}
      locale={{}}
      {...(session ? { session } : {})}
      activityLog={{ ...(expandWhileRunning ? { expandWhileRunning: true } : {}), ...(sections ? { grouping: 'sections' as const } : {}) }}
    >
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

const log = () => document.querySelector('[data-component="activity-log"]') as HTMLDetailsElement | null;
const statuses = () => Array.from(document.querySelectorAll('[data-element="activity-step"]')).map((row) => row.getAttribute('data-status'));
const summary = () => document.querySelector('[data-element="activity-summary"] [data-element="label"]')?.textContent;
const spinners = () => document.querySelectorAll('[data-component="activity-log"] [data-icon="spinner"]').length;

describe('an open step once its turn no longer runs', () => {
  it('ends as stopped after the stop button, and the log closes as after any finished turn', async () => {
    const stop = vi.fn();
    const messages = [user, assistant(done, running)];
    const view = render(<Harness status="streaming" messages={messages} stop={stop} expandWhileRunning />);
    await waitFor(() => expect(log()).not.toBeNull());
    expect(statuses()).toEqual(['done', 'running']);
    expect(log()!.open).toBe(true);
    expect(summary()).toBe('tasks_delete…');

    act(() => api!.stop());
    expect(stop).toHaveBeenCalledTimes(1);
    view.rerender(<Harness status="ready" messages={messages} stop={stop} expandWhileRunning />);

    expect(statuses()).toEqual(['done', 'aborted']);
    expect(log()!.getAttribute('data-state')).toBe('done');
    expect(summary()).toBe('1 step done, 1 stopped');
    expect(spinners()).toBe(0);
    expect(log()!.open).toBe(false);
    expect(document.querySelector('[data-element="activity-step"][data-status="aborted"] [data-icon="aborted"]')).not.toBeNull();
  });

  it('ends as stopped when the request fails mid-stream (a network error), not as failed', async () => {
    const messages = [user, assistant(running, streamingInput)];
    const view = render(<Harness status="streaming" messages={messages} />);
    await waitFor(() => expect(statuses()).toEqual(['running', 'running']));
    view.rerender(<Harness status="error" error={new Error('Failed to fetch')} messages={messages} />);

    expect(statuses()).toEqual(['aborted', 'aborted']);
    expect(log()!.getAttribute('data-state')).toBe('done');
    expect(summary()).toBe('2 stopped');
    expect(spinners()).toBe(0);
  });

  it('never spins for a stored history whose last tool part got no output', async () => {
    const stored = [user, assistant(done, running)];
    const session: SessionConfig = { load: () => stored, save: () => {} };
    render(<Harness status="ready" messages={[]} session={session} />);
    await waitFor(() => expect(statuses()).toEqual(['done', 'aborted']));
    expect(spinners()).toBe(0);
    expect(summary()).toBe('1 step done, 1 stopped');
  });

  it('keeps a step that waits for approval waiting: that is no abort', async () => {
    const messages = [user, assistant(done, waitingApproval)];
    const view = render(<Harness status="streaming" messages={messages} />);
    await waitFor(() => expect(log()).not.toBeNull());
    view.rerender(<Harness status="ready" messages={messages} />);
    expect(statuses()).toEqual(['done', 'waiting']);
    expect(log()!.getAttribute('data-state')).toBe('waiting');
    expect(summary()).toBe('Waiting for approval');
  });

  it('shows a UI action still waiting for its outcome as not confirmed once the turn is stopped', async () => {
    const messages = [user, assistant(waitingOutcome, running)];
    const view = render(<Harness status="streaming" messages={messages} />);
    await waitFor(() => expect(statuses()).toEqual(['waiting', 'running']));
    view.rerender(<Harness status="ready" messages={messages} />);
    // The action ran in the app; only its confirmation is missing (as for any ended turn). The tool step is stopped.
    expect(statuses()).toEqual(['done', 'aborted']);
    expect(document.querySelector('[data-element="activity-step"] [data-element="detail"]')?.textContent).toBe('Not confirmed');
    expect(spinners()).toBe(0);
  });

  it('words the stopped steps in German', async () => {
    document.documentElement.lang = 'de';
    const messages = [user, assistant(done, running)];
    const view = render(<Harness status="streaming" messages={messages} />);
    await waitFor(() => expect(log()).not.toBeNull());
    view.rerender(<Harness status="ready" messages={messages} />);
    await waitFor(() => expect(summary()).toBe('1 Schritt ausgeführt, 1 abgebrochen'));
  });

  it('keeps a call of an earlier section running while the turn runs, and stops it with the turn', async () => {
    const text = { type: 'text', text: 'Now the next one.' };
    const messages = [user, assistant(running, text, done)];
    const view = render(<Harness status="streaming" messages={messages} sections />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="activity-log"]')).toHaveLength(2));
    expect(statuses()).toEqual(['running', 'done']);
    view.rerender(<Harness status="ready" messages={messages} sections />);
    expect(statuses()).toEqual(['aborted', 'done']);
  });
});
