// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLangGraphChatTransport } from '../transports/langgraph.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import type { FilePart } from '../types.js';

const image = (url: string, filename = 'a.png'): FilePart => ({ type: 'file', mediaType: 'image/png', url, filename });

afterEach(() => vi.unstubAllGlobals());

function captureFetch() {
  const bodies: Array<{ messages: Array<{ role: string; parts: Array<Record<string, unknown>> }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }));
  return bodies;
}

describe('vercel transport attachments', () => {
  it('sends files as file parts of the user message', async () => {
    const bodies = captureFetch();
    const { result } = renderHook(() => useVercelAiChatTransport({ endpoint: '/api/chat' }));
    await act(async () => { await result.current.sendMessage({ text: 'Look', files: [image('data:image/png;base64,AAAA')] }); });
    const last = bodies[0]!.messages.at(-1)!;
    expect(last.parts).toEqual(expect.arrayContaining([
      { type: 'text', text: 'Look' },
      expect.objectContaining({ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'a.png' }),
    ]));
  });

  it('sends files without an empty text part when there is no text', async () => {
    const bodies = captureFetch();
    const { result } = renderHook(() => useVercelAiChatTransport({ endpoint: '/api/chat' }));
    await act(async () => { await result.current.sendMessage({ text: '', files: [image('data:image/png;base64,AAAA')] }); });
    expect(bodies[0]!.messages.at(-1)!.parts.map((part) => part.type)).toEqual(['file']);
  });

  it('keeps file data only in the two most recent user messages of a request', async () => {
    const bodies = captureFetch();
    const { result } = renderHook(() => useVercelAiChatTransport({ endpoint: '/api/chat' }));
    for (const name of ['1', '2', '3']) {
      await act(async () => { await result.current.sendMessage({ text: name, files: [image(`data:image/png;base64,${name}AAA`, `${name}.png`)] }); });
    }
    const users = bodies[2]!.messages.filter((message) => message.role === 'user');
    expect(users[0]!.parts).toContainEqual({ type: 'text', text: '[attachment: 1.png]' });
    expect(users[1]!.parts.some((part) => part.type === 'file')).toBe(true);
    expect(users[2]!.parts.some((part) => part.type === 'file')).toBe(true);
    // The chat state keeps the data; only the request is trimmed.
    expect(JSON.stringify(result.current.messages)).toContain('data:image/png;base64,1AAA');
  });
});

describe('langgraph transport attachments', () => {
  it('refuses files with a clear error', async () => {
    const { result } = renderHook(() => useLangGraphChatTransport({ endpoint: '/api/chat' }));
    await expect(result.current.sendMessage({ text: 'x', files: [image('data:image/png;base64,AAAA')] }))
      .rejects.toThrow(/LangGraph transport does not support attachments/);
  });
});
