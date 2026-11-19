// @vitest-environment jsdom

import React, { useEffect, useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext } from '../../provider/chat-context.js';
import { MessageList } from '../message-list.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';
import type { ChatMessage, ChatTransport, SessionConfig } from '../../types.js';

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Delete task t1' }] } as ChatMessage;
const deletion = (state: string, approval: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'tool-tasks_delete', toolCallId: 'c1', state, input: { id: 't1' }, approval, ...extra,
});
const assistant = (...parts: unknown[]): ChatMessage => ({ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, ...parts] } as ChatMessage);

let api: ReturnType<typeof useChatContext> | undefined;
function Probe() {
  api = useChatContext();
  return null;
}

interface HarnessProps {
  status: ChatTransport['status'];
  messages: ChatMessage[];
  session?: SessionConfig;
}

/**
 * A transport like `useChat`: answering an approval writes `approval-responded`
 * into the message at once; the automatic resend (status `submitted`) comes
 * later, when the test rerenders with it.
 */
function Harness({ status, messages, session }: HarnessProps) {
  const [current, setCurrent] = useState(messages);
  useEffect(() => setCurrent(messages), [messages]);
  const transport = useMemo<ChatTransport>(() => ({
    messages: current,
    status,
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: () => {},
    setMessages: (next) => setCurrent(next),
    addToolApprovalResponse: async ({ id, approved }) => {
      setCurrent((previous) => previous.map((message) => ({
        ...message,
        parts: message.parts.map((part) => {
          const tool = part as { state?: string; approval?: { id?: string } };
          return tool.state === 'approval-requested' && tool.approval?.id === id
            ? { ...part, state: 'approval-responded', approval: { id, approved } }
            : part;
        }),
      })) as ChatMessage[]);
    },
  }), [current, status]);
  return (
    <AiChatProvider transport={transport} approvalDisplay={{ decided: 'entry' }} {...(session ? { session } : {})}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

const entry = () => document.querySelector('[data-component="approval-entry"]');
const outcome = () => entry()?.getAttribute('data-outcome');
const outcomeText = () => entry()?.querySelector('[data-element="outcome"]')?.textContent;

describe('an approved call whose turn ended without a result', () => {
  it('stays running in the gap between approving and the automatic resend, then ends as stopped', async () => {
    const asked = [user, assistant(deletion('approval-requested', { id: 'ap1' }))];
    const view = render(<Harness status="ready" messages={asked} />);
    await waitFor(() => expect(api?.pendingApprovals.map((approval) => approval.id)).toEqual(['ap1']));

    await act(async () => { api!.approve('ap1'); });
    // The gap: answered, status still ready, the resend not started yet. No flicker to stopped.
    await waitFor(() => expect(outcome()).toBe('running'));
    expect(outcomeText()).toBe('Approved, running');
    await act(async () => { await new Promise((settle) => setTimeout(settle, 20)); });
    expect(outcome()).toBe('running');

    // The resend runs the call; it is stopped before its result arrives.
    const answered = [user, assistant(deletion('approval-responded', { id: 'ap1', approved: true }))];
    view.rerender(<Harness status="submitted" messages={answered} />);
    expect(outcome()).toBe('running');
    view.rerender(<Harness status="streaming" messages={answered} />);
    expect(outcome()).toBe('running');
    view.rerender(<Harness status="ready" messages={answered} />);
    await waitFor(() => expect(outcome()).toBe('aborted'));
    expect(outcomeText()).toBe('Approved, stopped');
    expect(entry()!.querySelector('[data-icon="spinner"]')).toBeNull();
  });

  it('ends as stopped when the call was already running (input-available) and the request failed', async () => {
    const running = [user, assistant(deletion('input-available', { id: 'ap1', approved: true }))];
    const view = render(<Harness status="streaming" messages={running} />);
    await waitFor(() => expect(outcome()).toBe('running'));
    view.rerender(<Harness status="error" messages={running} />);
    expect(outcome()).toBe('aborted');
  });

  it('never spins after a reload of a history whose approved call got no result', async () => {
    // A stored message keeps a text part (one with neither text nor a result is left out on load).
    const stored = [user, assistant({ type: 'text', text: 'Deleting it.' }, deletion('approval-responded', { id: 'ap1', approved: true }))];
    const session: SessionConfig = { load: () => stored, save: () => {} };
    render(<Harness status="ready" messages={[]} session={session} />);
    await waitFor(() => expect(outcome()).toBe('aborted'));
    expect(entry()!.querySelector('[data-icon="spinner"]')).toBeNull();
  });

  it('keeps an answered call running while another approval of the message is still open', async () => {
    const mixed = [user, assistant(
      deletion('approval-responded', { id: 'ap1', approved: true }),
      { type: 'tool-tasks_archive', toolCallId: 'c2', state: 'approval-requested', input: { id: 't2' }, approval: { id: 'ap2' } },
    )];
    render(<Harness status="ready" messages={mixed} />);
    await waitFor(() => expect(outcome()).toBe('running'));
  });

  it('keeps the outcomes with a result as they are', async () => {
    const done = [user, assistant(deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }))];
    render(<Harness status="ready" messages={done} />);
    await waitFor(() => expect(outcome()).toBe('done'));
  });

  it('has the stopped text in English and German', () => {
    expect(DEFAULT_LOCALE.approvalEntryAbortedLabel).toBe('Approved, stopped');
    expect(deChatLocale.approvalEntryAbortedLabel).toBe('Freigegeben, abgebrochen');
  });
});
