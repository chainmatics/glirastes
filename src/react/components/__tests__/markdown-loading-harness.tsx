import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { ChatComponents, ChatMessage, ChatTransport } from '../../types.js';

/** A history text with a list, emphasis and an escape: what a loaded chat shows. */
export const MARKDOWN_SOURCE = 'Live \\+ v2\n\n- **one**\n- two';

const transport = (): ChatTransport => ({
  messages: [], status: 'ready', error: null,
  sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
});

export const message = {
  id: 'm1',
  role: 'assistant',
  parts: [{ type: 'text', text: MARKDOWN_SOURCE }],
} as unknown as ChatMessage;

export interface FreshChat {
  element: ReactElement;
  /** Lets the (mocked) `import('react-markdown')` resolve. */
  release: () => void;
  importCalls: () => number;
}

/**
 * Fresh module state (no renderer loaded yet) with a `react-markdown` import
 * that waits until `release()`. Independent of test order.
 */
export async function freshChat(options: { components?: ChatComponents; withBubble?: boolean } = {}): Promise<FreshChat> {
  vi.resetModules();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  vi.doMock('react-markdown', async () => {
    calls += 1;
    await gate;
    return vi.importActual<typeof import('react-markdown')>('react-markdown');
  });
  const { AiChatProvider } = await import('../../provider/ai-chat-provider.js');
  const { MessageBubble } = await import('../message-bubble.js');
  const element = (
    <AiChatProvider transport={transport()} components={options.components}>
      {options.withBubble === false ? null : <MessageBubble message={message} />}
    </AiChatProvider>
  );
  return { element, release, importCalls: () => calls };
}

export const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

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

/** Server HTML of the chat in one of the four cases, from a fresh module state. */
export async function serverHtml(kind: ServerCase): Promise<string> {
  const { renderToString, renderToReadableStream } = await import('react-dom/server');
  const chat = await freshChat();
  if (kind.endsWith('-loaded') && !kind.endsWith('not-loaded')) {
    renderToString(chat.element); // starts the lazy import
    chat.release();
    await settle();
  }
  if (kind.startsWith('string')) return maskStackPaths(renderToString(chat.element));
  const stream = await renderToReadableStream(chat.element);
  chat.release();
  return readAll(stream);
}
