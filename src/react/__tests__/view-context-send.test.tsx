// @vitest-environment jsdom

import React, { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext } from '../provider/chat-context.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { useViewContext } from '../hooks/use-view-context.js';
import { useViewContext as publicUseViewContext } from '../index.js';
import { currentViewContext, registerViewContext } from '../../browser/index.js';
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

  it('is switched off with viewContext={{ enabled: false }}: no field, byte for byte as without a registration', async () => {
    const view = render(<Chat viewContext={{ enabled: false }}><Page entry={orderView} /></Chat>);
    const off = await sendAndWait('Hi');
    expect(off).not.toHaveProperty('glirastesViewContext');
    view.unmount();
    render(<Chat />);
    const none = await sendAndWait('Hi');
    const normalized = (body: Record<string, unknown>) => JSON.stringify({ ...body, id: 'x', messageId: 'x', messages: (body.messages as Array<{ parts: unknown }>).map((message) => message.parts) });
    expect(normalized(off)).toBe(normalized(none));
    await waitFor(() => expect(models).toHaveLength(2));
    await waitFor(() => expect(models[1]?.doStreamCalls).toHaveLength(1));
    expect(promptText(models[0])).not.toContain('view-context');
  });

  it('turns back on when the provider prop changes', async () => {
    const view = render(<Chat viewContext={{ enabled: false }}><Page entry={orderView} /></Chat>);
    expect(await sendAndWait('one')).not.toHaveProperty('glirastesViewContext');
    view.rerender(<Chat viewContext={{ enabled: true }}><Page entry={orderView} /></Chat>);
    expect((await sendAndWait('two')).glirastesViewContext).toEqual({ version: 1, current: [orderView] });
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
    const map = () => (globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for('glirastes.viewContext')]!;
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

  it('a custom transport without the setter keeps working and sends nothing new', async () => {
    const sendMessage = vi.fn(async () => {});
    const transport: ChatTransport = {
      messages: [], status: 'ready', error: null, sendMessage, stop: vi.fn(), setMessages: vi.fn(),
      addToolApprovalResponse: vi.fn(async () => {}),
    };
    render(<AiChatProvider transport={transport}><Send /><Page entry={orderView} /></AiChatProvider>);
    await act(async () => { await send('Hi'); });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({ text: 'Hi' });
  });
});

describe('continuations without a new user message carry no view context', () => {
  let transport: ChatTransport;
  function Probe() {
    transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
    useViewContext(orderView);
    return null;
  }

  it('not with the approval auto-resume, continueTurn or the budget continuation', async () => {
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

  it('is sent with a message that has files too, and not when the transport was told it is off', async () => {
    render(<Probe />);
    const file = { type: 'file' as const, mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };
    await act(async () => { await transport.sendMessage({ text: 'Look', files: [file] }); });
    expect(bodies[0]!.glirastesViewContext).toEqual({ version: 1, current: [orderView] });
    act(() => transport.setRequestViewContext!(false));
    await act(async () => { await transport.sendMessage({ text: 'Again' }); });
    expect(bodies[1]).not.toHaveProperty('glirastesViewContext');
  });
});
