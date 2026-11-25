// @vitest-environment jsdom

import React, { StrictMode, useEffect, useState } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext } from '../provider/chat-context.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { useViewContext } from '../hooks/use-view-context.js';
import { useViewContext as publicUseViewContext } from '../index.js';
import { currentViewContext, registerViewContext } from '../../browser/index.js';
import { viewContextState } from '../../browser/view-context-store.js';
import type { ViewContextEntry } from '../../contracts/view-context.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport } from '../types.js';
import { createAiChatHandler } from '../../server/adapters/nextjs/create-ai-chat-handler.js';
import { VIEW_CONTEXT_HEADER } from '../../server/adapters/nextjs/view-context-block.js';
import { defineTool, type ToolRegistry } from '../../types.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const getOrder = defineTool({
  id: 'orders.get',
  description: 'Read one order.',
  method: 'GET',
  inputSchema: z.object({ orderId: z.string() }),
  outputEntities: [{ type: 'order', id: 'id', name: 'name' }],
  inputEntities: [{ type: 'order', args: 'orderId' }],
  execute: async () => ({ id: 'ord-1', name: 'Order 1' }),
});
const registry: ToolRegistry = { orders_get: getOrder };

let models: MockLanguageModelV3[] = [];
const bodies: Array<Record<string, unknown>> = [];
/** Chunks of the next fake responses (approval tests); else the real handler answers. */
let scripted: unknown[][] = [];

function sse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
}

beforeEach(() => {
  models = [];
  bodies.length = 0;
  scripted = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = scripted.shift();
    if (next) return sse(next);
    // The app's real chat route with a fake model.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Answer.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never),
      }),
    });
    models.push(model);
    const handler = createAiChatHandler({ tools: registry, systemPrompt: 'Assistant', model } as never);
    return handler(new Request('https://app.example/api/chat', { method: 'POST', headers: init?.headers, body: init?.body }));
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(currentViewContext()).toEqual([]);
});

const orderView: ViewContextEntry = { entity: { type: 'order', id: 'ord-1' }, label: 'Order 1', route: '/orders/ord-1' };

function Page({ entry }: { entry: ViewContextEntry | null }) {
  useViewContext(entry);
  return null;
}

let send: (text: string) => Promise<void>;
function Send() {
  const { send: sendText } = useChatContext();
  send = async (text) => { sendText(text); };
  return null;
}

function Chat({ children, ...props }: Partial<AiChatProviderConfig> & { children?: React.ReactNode }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={transport} {...props}>
      <Send />
      {children}
    </AiChatProvider>
  );
}

async function sendAndWait(text = 'What is the status of this?') {
  const before = bodies.length;
  await act(async () => { await send(text); });
  await waitFor(() => expect(bodies.length).toBe(before + 1));
  return bodies.at(-1)!;
}

const promptText = (model: MockLanguageModelV3 | undefined) => JSON.stringify(model?.doStreamCalls[0]?.prompt);

describe('view context from a page to the model', () => {
  it('sends what the page registered with a new message, and the real handler gives the model the block', async () => {
    render(<Chat><Page entry={orderView} /></Chat>);
    const body = await sendAndWait();
    expect(body.glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    await waitFor(() => expect(models[0]?.doStreamCalls).toHaveLength(1));
    const prompt = models[0]!.doStreamCalls[0]!.prompt as Array<{ role: string; content: Array<{ text?: string }> }>;
    expect(prompt.at(-1)).toEqual({
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '<view-context>',
          VIEW_CONTEXT_HEADER,
          '{"entity":{"type":"order","id":"ord-1"},"label":"Order 1","route":"/orders/ord-1"}',
          '</view-context>',
        ].join('\n'),
      }],
    });
  });

  it('changes nothing for an unchanged app: no field, same body keys and no block', async () => {
    render(<Chat />);
    const body = await sendAndWait();
    // The body of main: client actions, outcome flag, then the AI SDK fields (`messageId` is undefined for a new message).
    expect(Object.keys(body)).toEqual(['glirastesClientActions', 'glirastesUiOutcomes', 'id', 'messages', 'trigger']);
    await waitFor(() => expect(models[0]?.doStreamCalls).toHaveLength(1));
    expect(promptText(models[0])).not.toContain('view-context');
  });

  it('sends nothing once the page unmounted or set null', async () => {
    const view = render(<Chat><Page entry={orderView} /></Chat>);
    view.rerender(<Chat><Page entry={null} /></Chat>);
    expect((await sendAndWait())).not.toHaveProperty('glirastesViewContext');
    view.rerender(<Chat><Page entry={orderView} /></Chat>);
    expect((await sendAndWait()).glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    view.rerender(<Chat />);
    const body = await sendAndWait();
    expect(body).not.toHaveProperty('glirastesViewContext');
    expect(Object.keys(body)).toEqual(['glirastesClientActions', 'glirastesUiOutcomes', 'id', 'messages', 'trigger']);
  });

  it('sends several sources in mount order, bounded by the contract', async () => {
    const lines: ViewContextEntry = { selection: { type: 'order', ids: Array.from({ length: 70 }, (_, index) => `o-${index}`) } };
    render(<Chat><Page entry={orderView} /><Page entry={lines} /></Chat>);
    const current = (await sendAndWait()).glirastesViewContext as { current: ViewContextEntry[] };
    expect(current.current).toHaveLength(2);
    expect(current.current[0]).toEqual(orderView);
    expect(current.current[1]!.selection!.ids).toHaveLength(50);
    await waitFor(() => expect(models[0]?.doStreamCalls).toHaveLength(1));
    expect(promptText(models[0])).toContain('<view-context>');
  });

  it('registers once under StrictMode and withdraws on unmount', async () => {
    const view = render(<StrictMode><Chat><Page entry={orderView} /></Chat></StrictMode>);
    expect(currentViewContext()).toEqual([orderView]);
    expect((await sendAndWait()).glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    view.unmount();
    expect(currentViewContext()).toEqual([]);
  });

  it('keeps its registration when a re-render passes an equal new object', () => {
    const map = () => viewContextState().entries;
    const view = render(<Page entry={{ ...orderView }} />);
    const [registration] = [...map().values()];
    view.rerender(<Page entry={{ ...orderView, entity: { ...orderView.entity! } }} />);
    expect([...map().values()][0]).toBe(registration);
    view.rerender(<Page entry={{ ...orderView, label: 'Order 1 (edited)' }} />);
    expect([...map().values()][0]).not.toBe(registration);
    expect(currentViewContext()[0]!.label).toBe('Order 1 (edited)');
  });

  it('reads nothing from the page on its own, and does nothing during server rendering', () => {
    window.history.replaceState(null, '', '/orders/ord-1');
    expect(currentViewContext()).toEqual([]);
    expect(renderToString(<Page entry={orderView} />)).toBe('');
    expect(currentViewContext()).toEqual([]);
    expect(publicUseViewContext).toBe(useViewContext);
  });

  it('a custom transport is called exactly as on main: one argument, no view context', async () => {
    const sendMessage = vi.fn(async () => {});
    const transport: ChatTransport = {
      messages: [], status: 'ready', error: null, sendMessage, stop: vi.fn(), setMessages: vi.fn(),
      addToolApprovalResponse: vi.fn(async () => {}),
    };
    render(<AiChatProvider transport={transport}><Send /><Page entry={orderView} /></AiChatProvider>);
    await act(async () => { await send('Hi'); });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({ text: 'Hi' });
    expect((sendMessage.mock.calls[0] as unknown[]).length).toBe(1);
  });

  function AutoSend() {
    const { send: sendText } = useChatContext();
    useEffect(() => { sendText('Hello on mount'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  }

  it('is sent with a message a child sends in its mount effect', async () => {
    const off = registerViewContext('page', orderView);
    try {
      render(<Chat><AutoSend /></Chat>);
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]!.glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    } finally {
      off();
    }
  });
});

describe('an update and a send in the same event handler', () => {
  it('sends the entry of the last commit: the hook registers the new one only after its commit', async () => {
    const viewB: ViewContextEntry = { entity: { type: 'order', id: 'ord-2' } };
    function Picker() {
      const [selected, setSelected] = useState<ViewContextEntry>(orderView);
      useViewContext(selected);
      const { send: sendText } = useChatContext();
      return <button type="button" onClick={() => { setSelected(viewB); sendText('Delete this'); }}>go</button>;
    }
    const view = render(<Chat><Picker /></Chat>);
    fireEvent.click(view.getByText('go'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    expect(currentViewContext()).toEqual([viewB]);
  });
});

describe('several React roots on one page', () => {
  it('keep their own sources: a root unmounting removes only its own entry', async () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    document.body.append(hostA, hostB);
    // Two server-rendered roots hydrate with the same useId sequence.
    hostA.innerHTML = renderToString(<Page entry={orderView} />);
    hostB.innerHTML = renderToString(<Page entry={{ entity: { type: 'order', id: 'ord-2' } }} />);
    let a!: ReturnType<typeof hydrateRoot>;
    let b!: ReturnType<typeof hydrateRoot>;
    act(() => { a = hydrateRoot(hostA, <Page entry={orderView} />); });
    act(() => { b = hydrateRoot(hostB, <Page entry={{ entity: { type: 'order', id: 'ord-2' } }} />); });
    expect(currentViewContext()).toEqual([orderView, { entity: { type: 'order', id: 'ord-2' } }]);
    act(() => b.unmount());
    expect(currentViewContext()).toEqual([orderView]);
    act(() => a.unmount());
    expect(currentViewContext()).toEqual([]);
    hostA.remove();
    hostB.remove();
  });
});

describe('continuations without a new user message', () => {
  let transport: ChatTransport;
  function Probe() {
    transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
    useViewContext(orderView);
    return null;
  }

  it('carry no view context when they start after the stream ended: approval resume, continueTurn, budget continuation', async () => {
    scripted = [[
      { type: 'start' }, { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'orders_get', input: { orderId: 'ord-1' } },
      { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' },
      { type: 'finish-step' }, { type: 'finish' },
    ]];
    render(<Probe />);
    await act(async () => { await transport.sendMessage({ text: 'Open it' }); });
    expect(bodies[0]!.glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    await waitFor(() => expect((transport.messages.at(-1) as ChatMessage | undefined)?.role).toBe('assistant'));
    await act(async () => { await transport.addToolApprovalResponse({ id: 'ap-1', approved: true }); });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).not.toHaveProperty('glirastesViewContext');
    await act(async () => { await transport.continueTurn!(); });
    await act(async () => { await transport.continueAfterBudgetStop!(); });
    await waitFor(() => expect(bodies).toHaveLength(4));
    expect(bodies[2]).not.toHaveProperty('glirastesViewContext');
    expect(bodies[3]).toMatchObject({ glirastesContinuation: 'budget' });
    expect(bodies[3]).not.toHaveProperty('glirastesViewContext');
    // A new user message sends it again, as it is at send time.
    act(() => { registerViewContext('other', { entity: { type: 'order', id: 'ord-2' } }); });
    await act(async () => { await transport.sendMessage({ text: 'And this?' }); });
    expect(bodies[4]!.glirastesViewContext).toEqual({ version: 1, current: [orderView, { entity: { type: 'order', id: 'ord-2' } }] });
    registerViewContext('other', null);
  });

  it('an automatic continuation the AI SDK starts from the running request repeats the field of the first send, which the server ignores', async () => {
    const encoder = new TextEncoder();
    const line = (chunk: unknown) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const recorded: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      recorded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (recorded.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({ start(open) { controller = open; } }), {
          status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
        });
      }
      // A text answer ends the turn, so the AI SDK does not resume again.
      return sse([{ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' }]);
    }));
    let transportOnly!: ChatTransport;
    function Bare() { transportOnly = useVercelAiChatTransport({ endpoint: '/api/chat' }); return null; }
    const off = registerViewContext('page', orderView);
    render(<Bare />);
    let first!: Promise<void>;
    act(() => { first = transportOnly.sendMessage({ text: 'Open it' }); });
    await waitFor(() => expect(controller).toBeDefined());
    for (const chunk of [{ type: 'start' }, { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'orders_get', input: { orderId: 'ord-1' } },
      { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' }, { type: 'finish-step' }]) controller.enqueue(line(chunk));
    await waitFor(() => expect(JSON.stringify(transportOnly.messages)).toContain('approval-requested'));
    // The view is left and the approval answered while the first request still streams.
    off();
    await act(async () => { await transportOnly.addToolApprovalResponse({ id: 'ap-1', approved: true }); });
    controller.enqueue(line({ type: 'finish' }));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
    await act(async () => { await first; });
    await waitFor(() => expect(recorded).toHaveLength(2));
    expect(currentViewContext()).toEqual([]);
    // The AI SDK passes the body of the first send on to the resume: the unregistered entry goes again.
    expect(recorded[1]!.glirastesViewContext).toEqual({ version: 1, current: [orderView] });

    // The real chat route takes it as a continuation: no block, the model input as without the field.
    const approvalTool = defineTool({ ...getOrder, needsApproval: true } as never);
    const promptFor = async (body: Record<string, unknown>) => {
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'Done.' }, { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ] as never),
        }),
      });
      const handler = createAiChatHandler({ tools: { orders_get: approvalTool }, systemPrompt: 'Assistant', model } as never);
      const response = await handler(new Request('https://app.example/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      await response.text();
      return JSON.stringify(model.doStreamCalls[0]?.prompt);
    };
    const withField = await promptFor(recorded[1]!);
    const { glirastesViewContext: _dropped, ...withoutField } = recorded[1]!;
    expect(withField).toBeDefined();
    expect(withField).not.toContain('view-context');
    expect(withField).toBe(await promptFor(withoutField));
  });

  it('is sent with a message that has files too', async () => {
    render(<Probe />);
    const file = { type: 'file' as const, mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };
    await act(async () => { await transport.sendMessage({ text: 'Look', files: [file] }); });
    expect(bodies[0]!.glirastesViewContext).toEqual({ version: 1, current: [orderView] });
  });
});
