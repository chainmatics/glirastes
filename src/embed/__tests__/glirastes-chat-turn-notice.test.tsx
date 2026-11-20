// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGlirastesChatElement, type GlirastesChatElement } from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A UI message stream that has started but sends nothing until the request is aborted. */
function silentStream(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
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
});
