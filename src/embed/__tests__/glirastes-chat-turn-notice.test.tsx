// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGlirastesChatElement, type GlirastesChatElement } from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A UI message stream that sends `chunks` and then nothing until the request is aborted. */
function silentStream(signal: AbortSignal | null | undefined, chunks: unknown[] = []): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

function answer(text: string): Response {
  const chunks = [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

afterEach(async () => {
  await act(async () => { document.body.replaceChildren(); });
  vi.unstubAllGlobals();
});

describe('<glirastes-chat> turn notice', () => {
  it('keeps the notice of a question stopped before the first token after the next answer', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => (
      fetchMock.mock.calls.length === 1 ? silentStream(init?.signal) : answer('Second answer')
    ));
    vi.stubGlobal('fetch', fetchMock);
    defineGlirastesChatElement('glirastes-chat-turn-notice');
    const element = document.createElement('glirastes-chat-turn-notice') as GlirastesChatElement;
    element.setAttribute('endpoint', '/api/chat');
    await act(async () => { document.body.append(element); });
    const shadow = element.shadowRoot!;

    await act(async () => { element.send('First question'); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const stopButton = await waitFor(() => {
      const button = shadow.querySelector<HTMLButtonElement>('[data-action="stop"]');
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => { fireEvent.click(stopButton); });
    await waitFor(() => expect(shadow.querySelector('[data-component="turn-notice"]')).not.toBeNull());

    await act(async () => { element.send('Second question'); });
    await waitFor(() => expect(shadow.textContent).toContain('Second answer'));
    const notices = shadow.querySelectorAll('[data-component="turn-notice"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.getAttribute('data-status')).toBe('aborted');
    expect(notices[0]!.previousElementSibling!.textContent).toContain('First question');

    // The recorded outcome never goes into a request.
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as { messages: Array<Record<string, unknown>> };
    expect(JSON.stringify(body.messages)).not.toContain('glirastesTurnOutcome');
  });

  it('keeps a turn stopped during a tool call on screen, and leaves it out of the next request as before', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => (
      fetchMock.mock.calls.length === 1
        ? silentStream(init?.signal, [
          { type: 'start' },
          { type: 'start-step' },
          { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'tasks_list', input: {} },
        ])
        : answer('Second answer')
    ));
    vi.stubGlobal('fetch', fetchMock);
    defineGlirastesChatElement('glirastes-chat-tool-stop');
    const element = document.createElement('glirastes-chat-tool-stop') as GlirastesChatElement;
    element.setAttribute('endpoint', '/api/chat');
    await act(async () => { document.body.append(element); });
    const shadow = element.shadowRoot!;

    await act(async () => { element.send('First question'); });
    await waitFor(() => expect(shadow.querySelector('[data-element="activity-step"]')).not.toBeNull());
    await act(async () => { fireEvent.click(shadow.querySelector<HTMLButtonElement>('[data-action="stop"]')!); });
    await waitFor(() => expect(shadow.querySelector('[data-element="activity-step"]')!.getAttribute('data-status')).toBe('aborted'));

    await act(async () => { element.send('Second question'); });
    await waitFor(() => expect(shadow.textContent).toContain('Second answer'));
    expect(shadow.querySelector('[data-element="activity-step"]')!.getAttribute('data-status')).toBe('aborted');
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as { messages: Array<{ role: string }> };
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'user']);
  });
});
