import { vi } from 'vitest';

/** One request the stubbed `fetch` received; the test decides what its response streams and when it ends. */
export interface ControlledRequest {
  body: Record<string, unknown>;
  /** Whether the request's `AbortSignal` fired (the AI SDK's `stop()`). */
  aborted: boolean;
  /** Streams one UI message chunk (`{ type: 'text-delta', ... }`). Ignored once the request ended. */
  push(chunk: Record<string, unknown>): void;
  /** Ends the stream as the server does (`[DONE]`, then close). */
  end(): void;
  /** Streams a text answer: start, one step with `text`, finish, and ends the stream unless `open`. */
  answer(text: string, options?: { open?: boolean }): void;
}

/** The chunks of the beginning of a text answer, without its end. */
export const textChunks = (text: string, id = 't') => [
  { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id }, { type: 'text-delta', id, delta: text },
];

/**
 * Stubs the global `fetch` with responses the test streams chunk by chunk, as the server's UI message stream
 * does. An aborted request ends its stream with an `AbortError`, as the browser's `fetch` does.
 */
export function stubControlledFetch() {
  const requests: ControlledRequest[] = [];
  const encoder = new TextEncoder();
  const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const request: ControlledRequest = {
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      aborted: false,
      push(chunk) {
        if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      },
      end() {
        if (!open) return;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        open = false;
        controller.close();
      },
      answer(text, options) {
        for (const chunk of textChunks(text)) request.push(chunk);
        request.push({ type: 'text-end', id: 't' });
        request.push({ type: 'finish-step' });
        request.push({ type: 'finish' });
        if (!options?.open) request.end();
      },
    };
    init?.signal?.addEventListener('abort', () => {
      request.aborted = true;
      if (!open) return;
      open = false;
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    });
    requests.push(request);
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    });
  });
  vi.stubGlobal('fetch', fetchStub);
  return { requests, fetch: fetchStub };
}

/** The texts of the messages a request carried, by role. */
export const carried = (request: ControlledRequest) =>
  (request.body.messages as Array<{ role: string; parts: Array<{ type: string; text?: string }> }>)
    .map((message) => `${message.role}:${message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')}`);
