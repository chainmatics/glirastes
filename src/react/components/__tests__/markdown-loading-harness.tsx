import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { AiChatProviderProps } from '../../provider/ai-chat-provider.js';
import type { ChatComponents, ChatMarkdownOptions, ChatMessage, ChatTransport } from '../../types.js';

/** A history text with a list, emphasis and an escape: what a loaded chat shows. */
export const MARKDOWN_SOURCE = 'Live \\+ v2\n\n- **one**\n- two';

/** Importing a fresh provider graph can take seconds on a loaded machine. */
export const GRAPH_TIMEOUT = 60_000;

const text = (id: string, role: 'user' | 'assistant', value: string) =>
  ({ id, role, parts: [{ type: 'text', text: value }] }) as unknown as ChatMessage;

export const message = text('m1', 'assistant', MARKDOWN_SOURCE);

export const streamingHistory = [
  text('old', 'assistant', 'Earlier **answer**'),
  text('q', 'user', 'Show *live* items'),
  text('a', 'assistant', 'Streaming **now**'),
];

const transport = (messages: ChatMessage[] = [], status: ChatTransport['status'] = 'ready'): ChatTransport => ({
  messages, status, error: null,
  sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
});

export interface Graph {
  /** The chat with one loaded assistant message (or none). */
  chat: (options?: { components?: ChatComponents; markdown?: ChatMarkdownOptions; withBubble?: boolean }) => ReactElement;
  /** A running turn: an older answer, the just-sent question and the answer streaming in. */
  streamingChat: () => ReactElement;
  /** Any history and status; every message in a default bubble. */
  chatWith: (messages: ChatMessage[], status: ChatTransport['status'], props?: Partial<AiChatProviderProps>) => ReactElement;
  /** Lets the (mocked) `import('react-markdown')` resolve. */
  release: () => void;
  importCalls: () => number;
  /** The shared import of this module graph; resolves once the renderer is there. */
  preloadMarkdown: () => Promise<void>;
}

/**
 * A fresh module graph (no renderer loaded yet) whose `react-markdown` import
 * waits until `release()`; `fail` makes the import throw instead.
 */
export async function freshGraph(options: { fail?: boolean } = {}): Promise<Graph> {
  vi.resetModules();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  vi.doMock('react-markdown', async () => {
    calls += 1;
    if (options.fail) throw new Error('not installed');
    await gate;
    return vi.importActual<typeof import('react-markdown')>('react-markdown');
  });
  const { AiChatProvider } = await import('../../provider/ai-chat-provider.js');
  const chatWith: Graph['chatWith'] = (messages, status, props) => (
    <AiChatProvider transport={transport(messages, status)} {...props}>
      {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
    </AiChatProvider>
  );
  const { MessageBubble } = await import('../message-bubble.js');
  const { preloadMarkdown } = await import('../../markdown-module.js');
  return {
    chat: ({ components, markdown, withBubble = true } = {}) => (
      <AiChatProvider transport={transport()} components={components} markdown={markdown}>
        {withBubble ? <MessageBubble message={message} /> : null}
      </AiChatProvider>
    ),
    streamingChat: () => chatWith(streamingHistory, 'streaming'),
    chatWith,
    release,
    importCalls: () => calls,
    preloadMarkdown,
  };
}

/** The component stack in renderToString's client-render template carries absolute paths with line numbers. */
export const maskStackPaths = (html: string) => html.replace(/ \((?:\/|[A-Za-z]:\\)[^)]*\)/g, ' (<path>)');

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

export type ServerCase = 'string-not-loaded' | 'string-loaded' | 'stream-not-loaded' | 'stream-loaded';

/**
 * Server HTML of the chat in all four cases, in order on one fresh graph:
 * renderToString and a stream before the renderer loaded (the stream
 * finishes once it is released), then both once the import has resolved.
 */
export async function serverHtmlAll(): Promise<Record<ServerCase, string>> {
  const { renderToString, renderToReadableStream } = await import('react-dom/server');
  const graph = await freshGraph();
  const out = {} as Record<ServerCase, string>;
  out['string-not-loaded'] = maskStackPaths(renderToString(graph.chat()));
  const stream = await renderToReadableStream(graph.chat());
  graph.release();
  out['stream-not-loaded'] = await readAll(stream);
  await graph.preloadMarkdown();
  out['string-loaded'] = maskStackPaths(renderToString(graph.chat()));
  out['stream-loaded'] = await readAll(await renderToReadableStream(graph.chat()));
  return out;
}
