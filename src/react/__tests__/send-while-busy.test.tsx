// @vitest-environment jsdom
// A message sent while a request runs and the queue is off is refused (`busy`), not sent as a second request
// beside the running one. `sendWhileBusy: 'parallel'` keeps the former behaviour.

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { ChatInput } from '../components/chat-input.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { useLangGraphChatTransport } from '../transports/langgraph.js';
import type { AiChatProviderConfig, ChatMessage } from '../types.js';
import { GLIRASTES_NAVIGATE_ACTION_ID, registerNavigationBridge, UiActionBus } from '../../browser/index.js';
import { ctx, Host, Probe, StreamingChat } from './streaming-chat.js';
import { carried, stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
beforeEach(() => {
  ({ requests } = stubControlledFetch());
});
afterEach(() => {
  for (const request of requests) request.close();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const textOf = (messages: ReadonlyArray<ChatMessage>) => messages.map((message) => `${message.role}:${
  message.parts.map((part) => ((part as { type: string }).type === 'text' ? (part as { text: string }).text : '')).join('')}`);

function VercelHost(props: Partial<AiChatProviderConfig>) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={transport} {...props}>
      <Probe />
      <MessageList />
      <ChatInput />
    </AiChatProvider>
  );
}

/** The first request runs and has streamed the start of its answer. */
async function running(props: Partial<AiChatProviderConfig> = {}) {
  render(<VercelHost {...props} />);
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('first'); });
  await waitFor(() => expect(requests).toHaveLength(1));
  for (const chunk of textChunks('A ')) requests[0]!.push(chunk);
  await waitFor(() => expect(JSON.stringify(ctx.messages)).toContain('A '));
}

describe('a message sent while a request runs, without the queue', () => {
  it('is refused with reason busy: no second request, lastRejection set, the running answer intact', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await running();
    let result: unknown;
    await act(async () => { result = ctx.submitWithResult('second'); });
    expect(result).toEqual({ status: 'rejected', reason: 'busy' });
    expect(ctx.lastRejection?.reason).toBe('busy');
    await act(async () => { expect(ctx.submit('third')).toBe('rejected'); });
    await act(async () => { expect(ctx.send('fourth')).toBe(false); });
    await settle();
    expect(requests).toHaveLength(1);
    await act(async () => { requests[0]!.answer('DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    expect(textOf(ctx.messages)).toEqual(['user:first', 'assistant:A DONE']);
    expect(errors).not.toHaveBeenCalled();
    // Idle again: the next message goes out and carries the whole history.
    await act(async () => { expect(ctx.submitWithResult('next')).toEqual({ status: 'sent' }); });
    expect(ctx.lastRejection).toBeNull();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first', 'assistant:A DONE', 'user:next']);
  });

  it('two sends in one tick while idle: the first goes out, the second is refused (busy)', async () => {
    render(<VercelHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    const results: unknown[] = [];
    await act(async () => {
      results.push(ctx.submitWithResult('one'));
      results.push(ctx.submitWithResult('two'));
    });
    expect(results).toEqual([{ status: 'sent' }, { status: 'rejected', reason: 'busy' }]);
    await settle();
    expect(requests).toHaveLength(1);
    expect(carried(requests[0]!)).toEqual(['user:one']);
  });

  it('while a UI action outcome is awaited (the turn holds open): refused (busy)', async () => {
    const bus = new UiActionBus();
    let release!: () => void;
    const stopBridge = registerNavigationBridge({ bus, push: () => new Promise<void>((resolve) => { release = resolve; }) });
    const chat = new StreamingChat();
    const transport = { ...chat.transport, addToolOutput: vi.fn(async () => {}), setUiOutcomeReporting: () => {} };
    function OutcomeHost() {
      const [, force] = React.useReducer((count: number) => count + 1, 0);
      React.useEffect(() => chat.subscribe(force), []);
      return <AiChatProvider transport={{ ...chat.transport, addToolOutput: transport.addToolOutput, setUiOutcomeReporting: () => {} }} uiActionBus={bus}><Probe /></AiChatProvider>;
    }
    render(<OutcomeHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('open the tasks'); });
    await act(async () => {
      chat.finish([{
        type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available', input: {},
        output: {
          handedOff: true, message: 'Handed to the app.', awaitsOutcome: true,
          uiAction: { type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href: '/tasks' } },
        },
      }]);
    });
    // The request ended; the turn waits for the UI action's outcome.
    await waitFor(() => expect(ctx.isLoading).toBe(true));
    expect(chat.status).toBe('ready');
    await act(async () => { expect(ctx.submitWithResult('second')).toEqual({ status: 'rejected', reason: 'busy' }); });
    expect(chat.sent).toEqual(['open the tasks']);
    await act(async () => { release(); });
    stopBridge();
  });

  it('an open approval is refused as before (approval-open), not as busy', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('delete'); });
    await act(async () => {
      chat.finish([{ type: 'tool-tasks_delete', toolCallId: 'c1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' } }]);
    });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    expect(ctx.submitWithResult('yes')).toEqual({ status: 'rejected', reason: 'approval-open' });
  });

  it('a custom transport: refused while it runs, sent once it ended', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('first'); });
    await act(async () => { expect(ctx.submitWithResult('second')).toEqual({ status: 'rejected', reason: 'busy' }); });
    expect(chat.sent).toEqual(['first']);
    await act(async () => { chat.finish(); });
    await act(async () => { expect(ctx.submitWithResult('second')).toEqual({ status: 'sent' }); });
    expect(chat.sent).toEqual(['first', 'second']);
  });

  it('the LangGraph transport: refused while it runs', async () => {
    function LangGraphHost() {
      const transport = useLangGraphChatTransport({ endpoint: '/api/graph' });
      return <AiChatProvider transport={transport}><Probe /></AiChatProvider>;
    }
    render(<LangGraphHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('first'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => { expect(ctx.submitWithResult('second')).toEqual({ status: 'rejected', reason: 'busy' }); });
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('the built-in composer is disabled while a request runs, as before', async () => {
    await running();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'typed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('between the request of an approval and its continuation, a message sent is refused or waits, never runs beside one', async () => {
    render(<VercelHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('delete t1'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.push({ type: 'start' });
      requests[0]!.push({ type: 'start-step' });
      requests[0]!.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'tasks_delete', input: { id: 't1' } });
      requests[0]!.push({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' });
      requests[0]!.push({ type: 'finish-step' });
      requests[0]!.push({ type: 'finish' });
      requests[0]!.end();
    });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    let result: unknown;
    await act(async () => {
      void ctx.approve('ap-1');
      result = ctx.submitWithResult('meanwhile');
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    await settle();
    // The continuation is the only request; the message was not sent beside it.
    expect(requests).toHaveLength(2);
    expect((result as { status: string }).status).toBe('rejected');
  });
});

describe('the queue on: unchanged', () => {
  it('a message sent while a request runs is queued and goes out after it', async () => {
    await running({ queue: { enabled: true } });
    let result: unknown;
    await act(async () => { result = ctx.submitWithResult('second'); });
    expect(result).toEqual({ status: 'queued' });
    await act(async () => { requests[0]!.answer('DONE'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first', 'assistant:A DONE', 'user:second']);
  });
});

describe('sendWhileBusy: \'parallel\' keeps the former behaviour', () => {
  it('a message sent while a request runs goes out as a second request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await running({ sendWhileBusy: 'parallel' });
    let result: unknown;
    await act(async () => { result = ctx.submitWithResult('second'); });
    expect(result).toEqual({ status: 'sent' });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first', 'assistant:A ', 'user:second']);
  });
});
