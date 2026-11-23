// @vitest-environment node

import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { PassThrough } from 'node:stream';
import { renderToPipeableStream, renderToReadableStream, renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadMarkdown } from '../index.js';
import { resetMarkdownLoaderForTests } from '../markdown-loader.js';
import type { ChatMessage } from '../types.js';
import { Host, StreamingChat } from './streaming-chat.js';

const HISTORY = [
  { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Welche **Playlists**?' }] },
  { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: '- **eins**\n- zwei \\+ drei' }] },
] as unknown as ChatMessage[];

function app() {
  const chat = new StreamingChat();
  chat.messages = HISTORY;
  return createElement(Host, { chat });
}

const MARKDOWN = /<ul>\s*<li><strong>eins<\/strong><\/li>\s*<li>zwei \+ drei<\/li>\s*<\/ul>/;

function fresh() {
  const importer = vi.fn(async () => ({ default: ReactMarkdown }));
  resetMarkdownLoaderForTests({ importer });
  return importer;
}

afterEach(() => resetMarkdownLoaderForTests());

describe('server rendering', () => {
  it('renderToReadableStream waits for the renderer and sends the rendered Markdown', async () => {
    fresh();
    const stream = await renderToReadableStream(app());
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toMatch(MARKDOWN);
    expect(html).toContain('<strong>Playlists</strong>');
    expect(html).not.toContain('markdown-placeholder-line');
  });

  it('renderToPipeableStream sends the rendered Markdown', async () => {
    fresh();
    const html = await new Promise<string>((resolve, reject) => {
      let out = '';
      const sink = new PassThrough();
      sink.on('data', (chunk) => { out += String(chunk); });
      sink.on('end', () => resolve(out));
      const { pipe } = renderToPipeableStream(app(), { onAllReady: () => pipe(sink), onShellError: reject });
    });
    expect(html).toMatch(MARKDOWN);
    expect(html).not.toContain('markdown-placeholder-line');
  });

  it('renderToString before the renderer loaded sends readable text (main sent the raw source), after it the Markdown', async () => {
    fresh();
    const first = renderToString(app());
    // Same as main: the boundary is left to the client; its fallback is the text without Markdown syntax.
    expect(first).toContain('<!--$!-->');
    expect(first).toContain('zwei + drei');
    expect(first).not.toContain('**');
    expect(first).not.toContain('markdown-placeholder-line');
    await preloadMarkdown();
    const second = renderToString(app());
    expect(second).toMatch(MARKDOWN);
  });

  it('preloadMarkdown returns the same promise on every call and resolves', async () => {
    fresh();
    expect(typeof window).toBe('undefined');
    const first = preloadMarkdown();
    expect(preloadMarkdown()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});
