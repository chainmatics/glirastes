// @vitest-environment jsdom

import React from 'react';
import ReactMarkdown from 'react-markdown';
import { hydrateRoot } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preloadMarkdown } from '../index.js';
import { deChatLocale } from '../locale-de.js';
import { resetMarkdownLoaderForTests } from '../markdown-loader.js';
import type { ChatMessage, MessageBubbleProps } from '../types.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

// Each test gets a fresh loader and its own importer: `gate` holds the import
// open, so the chat renders before the renderer has loaded, as after a reload.
const MODULE = { default: ReactMarkdown };

function gate() {
  let open!: () => void;
  let fail!: () => void;
  const opened = new Promise<void>((resolve, reject) => { open = resolve; fail = () => reject(new Error('chunk failed')); });
  opened.catch(() => {});
  const importer = vi.fn(async () => {
    await opened;
    return MODULE;
  });
  return { importer, open, fail };
}

function loaded() {
  const importer = vi.fn(async () => MODULE);
  resetMarkdownLoaderForTests({ importer });
  return importer;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetMarkdownLoaderForTests();
});

const markdownBlocks = (root: ParentNode = document) => [...root.querySelectorAll('[data-component="markdown"]')];
const assistantBlock = () => document.querySelector('[data-component="message-bubble"][data-role="assistant"] [data-component="markdown"]')!;

const LIST_ANSWER = [
  'Hier sind die Playlists:',
  '',
  '- **{{mention:playlist:pl_7:Live + v2}}** läuft',
  '- {{mention:playlist:pl_8:Lobby (Entwurf)}} ist ein Entwurf',
  '',
  '| Name | Status |',
  '| --- | --- |',
  '| Lobby | aktiv |',
  '',
  '```',
  'const x = 1;',
  '```',
].join('\n');

const HISTORY = [
  { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Welche **Playlists** gibt es?' }] },
  { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: LIST_ANSWER }] },
  { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'Danke' }] },
  { id: 'a-2', role: 'assistant', parts: [{ type: 'text', text: 'Gern.' }] },
] as unknown as ChatMessage[];

const LINKS = { open: vi.fn(), mentionMarkers: 'markdown' as const, known: false, verifyMentions: false };

function withHistory(messages: ChatMessage[] = HISTORY) {
  const chat = new StreamingChat();
  chat.messages = messages;
  return chat;
}

describe('preloading the renderer', () => {
  it('starts when the provider mounts, before any message exists', async () => {
    const { importer } = gate();
    resetMarkdownLoaderForTests({ importer });
    render(<Host chat={new StreamingChat()} />);
    await waitFor(() => expect(importer).toHaveBeenCalledTimes(1));
  });

  it('is skipped for an app with its own MessageBubble; a default Markdown block loads it when it renders', async () => {
    const { importer } = gate();
    resetMarkdownLoaderForTests({ importer });
    const OwnBubble = ({ message }: MessageBubbleProps) => <div data-testid="own-bubble">{message.id}</div>;
    render(<Host chat={new StreamingChat()} config={{ components: { MessageBubble: OwnBubble } }} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(importer).not.toHaveBeenCalled();
    cleanup();
    render(<Host chat={withHistory()} />);
    await waitFor(() => expect(importer).toHaveBeenCalledTimes(1));
  });
});

describe('Markdown before its renderer has loaded', () => {
  it('a streaming answer shows the placeholder with a hidden loading text, never its source', async () => {
    const { importer } = gate();
    resetMarkdownLoaderForTests({ importer });
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('Liste?'); });
    act(() => chat.stream([{ type: 'text', text: '**Bold** and \\+ more', state: 'streaming' }]));
    const block = assistantBlock();
    expect(block.getAttribute('data-state')).toBe('loading');
    expect(block.getAttribute('aria-busy')).toBe('true');
    expect(block.textContent).toBe('Loading message…');
    const label = block.querySelector('[data-element="markdown-loading-text"]')!;
    expect(label.textContent).toBe('Loading message…');
    // Read where the reader is, not announced: no live region per bubble.
    expect(block.closest('[aria-live]')).toBeNull();
    expect(label.getAttribute('aria-live')).toBeNull();
  });

  it('the loading text follows the locale', async () => {
    const { importer } = gate();
    resetMarkdownLoaderForTests({ importer });
    render(<Host chat={withHistory()} config={{ locale: deChatLocale }} />);
    expect(assistantBlock().textContent).toBe('Nachricht wird geladen …');
  });

  it('a loaded history shows placeholders, no source text and no escapes, then the rendered Markdown', async () => {
    const { importer, open } = gate();
    resetMarkdownLoaderForTests({ importer });
    render(<Host chat={withHistory()} config={{ entityLinks: LINKS }} />);

    const blocks = markdownBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(block.getAttribute('data-state')).toBe('loading');
      expect(block.getAttribute('aria-busy')).toBe('true');
    }
    const text = document.body.textContent ?? '';
    for (const source of ['\\', '**', 'Live', '```', 'Playlists']) expect(text).not.toContain(source);

    // The placeholder's size follows the source: a long answer gets more lines than a short one, bounded.
    const lines = (block: Element) => block.querySelectorAll('[data-element="markdown-placeholder-line"]').length;
    expect(lines(blocks.at(-1)!)).toBe(1);
    expect(lines(assistantBlock())).toBeGreaterThan(1);
    expect(lines(assistantBlock())).toBeLessThanOrEqual(8);

    await act(async () => { open(); });
    await waitFor(() => expect(document.querySelector('[data-state="loading"]')).toBeNull());

    const answer = document.querySelector('[data-component="message-bubble"][data-role="assistant"]')!;
    expect(answer.querySelectorAll('li')).toHaveLength(2);
    expect(answer.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(answer.textContent).toContain('Live + v2');
    expect(answer.textContent).toContain('Lobby (Entwurf)');
    expect(document.body.textContent).not.toContain('\\');
    expect(markdownBlocks().every((block) => !block.hasAttribute('aria-busy'))).toBe(true);
  });

  it('the placeholder takes space without the SDK stylesheet (own layout, unstyled)', async () => {
    const { importer } = gate();
    resetMarkdownLoaderForTests({ importer });
    render(<Host chat={withHistory()} config={{ unstyled: true }} />);
    const block = assistantBlock() as HTMLElement;
    expect(block.closest('[data-component="ai-chat-panel"]')).toBeNull();
    const line = block.querySelector<HTMLElement>('[data-element="markdown-placeholder-line"]')!;
    expect(line.style.display).toBe('block');
    expect(line.style.height).toContain('--cm-markdown-placeholder-line-height');
    // (jsdom drops the color-mix() fallback of backgroundColor; browsers keep it.)
    expect(block.style.width).toContain('--cm-markdown-placeholder-chars');
  });
});

describe('a renderer that does not arrive', () => {
  it('a stalled import shows the plain text after the wait, then Markdown when it still arrives', async () => {
    const { importer, open } = gate();
    resetMarkdownLoaderForTests({ importer, timeoutMs: 40 });
    render(<Host chat={withHistory([{ id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: '- **eins**\n- zwei \\+ drei' }] }] as unknown as ChatMessage[])} />);
    expect(assistantBlock().getAttribute('data-state')).toBe('loading');
    await waitFor(() => expect(assistantBlock().getAttribute('data-state')).toBe('plain'));
    expect(assistantBlock().textContent).toBe('• eins• zwei + drei');
    await act(async () => { open(); });
    await waitFor(() => expect(assistantBlock().querySelectorAll('li')).toHaveLength(2));
    expect(assistantBlock().hasAttribute('data-state')).toBe(false);
  });

  it('a gate that never opens never leaves the skeleton up', async () => {
    const importer = vi.fn(() => new Promise<never>(() => {}));
    resetMarkdownLoaderForTests({ importer, timeoutMs: 40 });
    render(<Host chat={withHistory()} />);
    await waitFor(() => expect(document.querySelector('[data-state="loading"]')).toBeNull());
    expect(markdownBlocks().every((block) => block.getAttribute('data-state') === 'plain')).toBe(true);
  });

  it('a failed import is retried once by an explicit preloadMarkdown() call, not by the chat itself', async () => {
    let calls = 0;
    const importer = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk failed');
      return MODULE;
    });
    resetMarkdownLoaderForTests({ importer });
    render(<Host chat={withHistory([{ id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: '- eins\n- zwei' }] }] as unknown as ChatMessage[])} />);
    await waitFor(() => expect(assistantBlock().getAttribute('data-state')).toBe('plain'));
    expect(importer).toHaveBeenCalledTimes(1);
    // Another chat mounting does not retry.
    render(<Host chat={new StreamingChat()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(importer).toHaveBeenCalledTimes(1);
    await act(async () => { await preloadMarkdown(); });
    expect(importer).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(assistantBlock().querySelectorAll('li')).toHaveLength(2));
    // Only one retry.
    await preloadMarkdown();
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

describe('once loaded', () => {
  it('a streaming answer renders exactly what react-markdown renders, from its first token', async () => {
    loaded();
    await preloadMarkdown();
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('Liste?'); });
    const chunks = ['- **Ers', '- **Erster** Punkt\n- zwei', '- **Erster** Punkt\n- zweiter Punkt\n\n`code` und *mehr*'];
    for (const chunk of chunks) {
      act(() => chat.stream([{ type: 'text', text: chunk, state: 'streaming' }]));
      expect(assistantBlock().outerHTML).toBe(
        `<div data-component="markdown">${renderToStaticMarkup(<ReactMarkdown>{chunk}</ReactMarkdown>)}</div>`,
      );
    }
  });
});

describe('hydration', () => {
  const ANSWER = [{ id: 'a-9', role: 'assistant', parts: [{ type: 'text', text: '- **eins**\n- zwei' }] }] as unknown as ChatMessage[];

  async function serverHtml() {
    loaded();
    await preloadMarkdown();
    return renderToString(<Host chat={withHistory(ANSWER)} />);
  }

  async function hydrate(html: string) {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => { root = hydrateRoot(container, <Host chat={withHistory(ANSWER)} />, { onRecoverableError: recoverable }); });
    return { container, recoverable, errors, unmount: () => { act(() => root!.unmount()); container.remove(); } };
  }

  it('the server HTML has the rendered Markdown', async () => {
    const html = await serverHtml();
    expect(html).toMatch(/<ul>\s*<li><strong>eins<\/strong><\/li>/);
    expect(html).not.toContain('data-state="loading"');
  });

  it('hydrating while the client renderer is still loading keeps the server HTML, then renders Markdown', async () => {
    const html = await serverHtml();
    const { importer, open } = gate();
    resetMarkdownLoaderForTests({ importer });
    const view = await hydrate(html);
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    expect(view.container.querySelector('[data-state="loading"]')).toBeNull();
    await act(async () => { open(); });
    await waitFor(() => expect(importer).toHaveBeenCalled());
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    expect(view.container.querySelector('[data-state]')).toBeNull();
    expect(view.recoverable).not.toHaveBeenCalled();
    expect(view.errors).not.toHaveBeenCalled();
    view.unmount();
  });

  it('hydrating after the renderer loaded matches without a mismatch', async () => {
    const html = await serverHtml();
    const view = await hydrate(html);
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    expect(view.recoverable).not.toHaveBeenCalled();
    expect(view.errors).not.toHaveBeenCalled();
    view.unmount();
  });
});
