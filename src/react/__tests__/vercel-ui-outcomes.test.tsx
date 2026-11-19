// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatTransport } from '../types.js';
import { useVercelAiChatTransport, type UseVercelAiChatTransportOptions } from '../transports/vercel.js';

let transport: ChatTransport;
const bodies: Array<Record<string, unknown>> = [];

function streamResponse(): Response {
  const body = ['{"type":"start"}', '{"type":"start-step"}', '{"type":"text-start","id":"t"}',
    '{"type":"text-delta","id":"t","delta":"Done."}', '{"type":"text-end","id":"t"}', '{"type":"finish-step"}', '{"type":"finish"}']
    .map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return streamResponse();
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe(props: { options?: Partial<UseVercelAiChatTransportOptions> }) {
  transport = useVercelAiChatTransport({ endpoint: '/api/chat', ...props.options });
  return null;
}

const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Open the tasks' }] };
const uiPart = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool-ui_navigate', toolCallId, state: 'output-available', input: {},
  output: { handedOff: true, message: 'Handed to the app.', uiAction: { type: 'glirastes.navigate' }, awaitsOutcome: true, ...extra },
});
const assistant = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, ...parts] });

describe('Vercel transport and the outcome protocol', () => {
  it('sends the flag only once a provider reports through it', async () => {
    render(<Probe />);
    await act(async () => { await transport.sendMessage({ text: 'one' }); });
    expect(bodies[0]).not.toHaveProperty('glirastesUiOutcomes');
    act(() => { transport.setUiOutcomeReporting!(true); });
    await act(async () => { await transport.sendMessage({ text: 'two' }); });
    expect(bodies[1]).toMatchObject({ glirastesUiOutcomes: 1 });
  });

  it('has no outcome methods and sends no flag with uiActionOutcomes: false', async () => {
    render(<Probe options={{ uiActionOutcomes: false }} />);
    expect(transport.addToolOutput).toBeUndefined();
    expect(transport.continueTurn).toBeUndefined();
    await act(async () => { await transport.sendMessage({ text: 'one' }); });
    expect(bodies[0]).not.toHaveProperty('glirastesUiOutcomes');
  });

  it('continues a turn without a new message', async () => {
    render(<Probe />);
    act(() => {
      transport.setUiOutcomeReporting!(true);
      transport.setMessages([user, assistant(uiPart('c1', { outcome: { v: 1, code: 'initiated', at: 1 } }))] as unknown as ChatMessage[]);
    });
    await act(async () => { await transport.continueTurn!(); });
    expect(bodies).toHaveLength(1);
    const sent = bodies[0]!.messages as Array<{ id: string; role: string }>;
    expect(sent.map((message) => [message.id, message.role])).toEqual([['u1', 'user'], ['a1', 'assistant']]);
    expect(bodies[0]).toMatchObject({ glirastesUiOutcomes: 1 });
  });

  it('sends again once every waiting result has its outcome, and not before', async () => {
    render(<Probe />);
    act(() => {
      transport.setUiOutcomeReporting!(true);
      transport.setMessages([user, assistant(uiPart('c1'), uiPart('c2'))] as unknown as ChatMessage[]);
    });
    await act(async () => {
      await transport.addToolOutput!({ tool: 'ui_navigate', toolCallId: 'c1', output: { ...uiPart('c1').output, outcome: { v: 1, code: 'ok' } } });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(0);
    await act(async () => {
      await transport.addToolOutput!({ tool: 'ui_navigate', toolCallId: 'c2', output: { ...uiPart('c2').output, outcome: { v: 1, code: 'unavailable' } } });
    });
    await waitFor(() => expect(bodies).toHaveLength(1));
    const parts = (bodies[0]!.messages as Array<{ parts: Array<{ toolCallId?: string; output?: { outcome?: unknown } }> }>)[1]!.parts;
    expect(parts.filter((part) => part.toolCallId).map((part) => part.output?.outcome)).toEqual([
      { v: 1, code: 'ok' }, { v: 1, code: 'unavailable' },
    ]);
    // The continuation answered with text: nothing is sent again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(1);
  });

  it('does not send again for an outcome when the provider does not report', async () => {
    render(<Probe />);
    act(() => {
      transport.setMessages([user, assistant(uiPart('c1'))] as unknown as ChatMessage[]);
    });
    await act(async () => {
      await transport.addToolOutput!({ tool: 'ui_navigate', toolCallId: 'c1', output: { ...uiPart('c1').output, outcome: { v: 1, code: 'ok' } } });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(0);
  });
});
