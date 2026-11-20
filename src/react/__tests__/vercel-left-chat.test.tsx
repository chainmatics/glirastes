// @vitest-environment jsdom
// The same host switch with the real AI SDK (`useChat`, one `Chat` for every chat of the provider): the request
// of the chat that was left is aborted at the switch; nothing of it reaches the new chat or its next request.

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../provider/chat-context.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import type { ChatMessage, SessionConfig } from '../types.js';

const bodies: Array<{ messages: Array<{ id: string; role: string; parts: unknown[] }> }> = [];
const streams: Array<{ push: (chunk: string) => void; end: () => void; aborted: () => boolean }> = [];
/** A server that goes on streaming after the browser aborted (its abort does not reach the body). */
let ignoreAbort = false;

beforeEach(() => {
  bodies.length = 0;
  streams.length = 0;
  ignoreAbort = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const encoder = new TextEncoder();
    // As a real fetch does: an aborted request's body errors.
    init?.signal?.addEventListener('abort', () => {
      if (ignoreAbort) return;
      aborted = true;
      try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* closed */ }
    });
    streams.push({
      push: (chunk) => { if (!aborted) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`)); },
      end: () => { if (!aborted) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } },
      aborted: () => aborted,
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let ctx: ChatContextValue;
function Probe() {
  ctx = useChatContext();
  return null;
}
function App({ session }: { session: SessionConfig }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return <AiChatProvider transport={transport} session={session}><Probe /></AiChatProvider>;
}

const B: ChatMessage[] = [
  { id: 'b-u1', role: 'user', parts: [{ type: 'text', text: 'b question' }] },
  { id: 'b-a1', role: 'assistant', parts: [{ type: 'text', text: 'b answer' }] },
];

describe('Vercel transport: the host opens another chat while a request runs', () => {
  it('aborts the left request, stores its turn with A, and B, its store and its next request get nothing of it', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id) => histories[id] ?? [],
      save: (id, messages) => { histories[id] = messages; },
    });
    const view = render(<App session={session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { void ctx.send('a question'); });
    await waitFor(() => expect(streams).toHaveLength(1));
    await act(async () => {
      for (const chunk of ['{"type":"start"}', '{"type":"start-step"}', '{"type":"text-start","id":"t"}',
        '{"type":"text-delta","id":"t","delta":"partial of A"}']) streams[0]!.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(JSON.stringify(ctx.messages)).toContain('partial of A'));
    const aUser = ctx.messages[0]!.id;

    view.rerender(<App session={session('B')} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1', 'b-a1']));
    // The stream would go on: it was aborted at the switch, so nothing more arrives.
    await act(async () => {
      streams[0]!.push('{"type":"text-delta","id":"t","delta":" ANSWER OF A"}');
      streams[0]!.push('{"type":"text-end","id":"t"}');
      streams[0]!.push('{"type":"finish"}');
      streams[0]!.end();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(streams[0]!.aborted()).toBe(true);
    expect(JSON.stringify(ctx.messages)).not.toContain('of A');
    expect(JSON.stringify(histories.B)).not.toContain('of A');
    expect(JSON.stringify(histories.A)).toContain('partial of A');
    const stored = histories.A.find((message) => message.id === aUser) as { metadata?: { glirastesTurnOutcome?: unknown } };
    expect(stored.metadata?.glirastesTurnOutcome).toMatchObject({ status: 'aborted', reason: 'chat-left' });

    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { void ctx.send('b follow-up'); });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.messages.map((message) => message.id).slice(0, 2)).toEqual(['b-u1', 'b-a1']);
    expect(bodies[1]!.messages).toHaveLength(3);
    expect(JSON.stringify(bodies[1])).not.toContain('of A');
  });

  it('A to B to A without a send: A keeps its partial answer on screen and in its store', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id) => histories[id] ?? [],
      save: (id, messages) => { histories[id] = messages; },
    });
    const view = render(<App session={session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { void ctx.send('a question'); });
    await waitFor(() => expect(streams).toHaveLength(1));
    await act(async () => {
      for (const chunk of ['{"type":"start"}', '{"type":"start-step"}', '{"type":"text-start","id":"t"}',
        '{"type":"text-delta","id":"t","delta":"partial of A"}']) streams[0]!.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(JSON.stringify(ctx.messages)).toContain('partial of A'));
    const shown = ctx.messages.map((message) => message.id);
    view.rerender(<App session={session('B')} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1', 'b-a1']));
    view.rerender(<App session={session('A')} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(shown));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(ctx.messages.map((message) => message.id)).toEqual(shown);
    expect(histories.A.map((message) => message.id)).toEqual(shown);
    expect(JSON.stringify(histories.A)).toContain('partial of A');
  });

  it('a left request whose server message id equals B\'s last message id does not overwrite that message', async () => {
    ignoreAbort = true;
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id) => histories[id] ?? [],
      save: (id, messages) => { histories[id] = messages; },
    });
    const view = render(<App session={session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { void ctx.send('a question'); });
    await waitFor(() => expect(streams).toHaveLength(1));
    await act(async () => {
      // Deterministic server ids: A's answer has the id B's stored answer has.
      for (const chunk of ['{"type":"start","messageId":"b-a1"}', '{"type":"start-step"}', '{"type":"text-start","id":"t"}',
        '{"type":"text-delta","id":"t","delta":"partial of A"}']) streams[0]!.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    view.rerender(<App session={session('B')} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1', 'b-a1']));
    await act(async () => {
      streams[0]!.push('{"type":"text-delta","id":"t","delta":" ANSWER OF A"}');
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(JSON.stringify(ctx.messages)).toContain('b answer');
    expect(JSON.stringify(ctx.messages)).not.toContain('of A');
    expect(JSON.stringify(histories.B)).not.toContain('of A');
    await act(async () => {
      streams[0]!.push('{"type":"text-end","id":"t"}');
      streams[0]!.push('{"type":"finish"}');
      streams[0]!.end();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(JSON.stringify(ctx.messages)).toContain('b answer');
    expect(JSON.stringify(histories.B)).not.toContain('of A');
  });
});
