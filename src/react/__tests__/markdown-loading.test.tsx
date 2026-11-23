// @vitest-environment jsdom

import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../types.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

// The renderer (react-markdown) loads lazily. The gate holds its import open,
// so the chat renders before it has loaded, as it does after a reload.
const gate = vi.hoisted(() => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened, started: 0 };
});

vi.mock('react-markdown', async () => {
  gate.started += 1;
  await gate.opened;
  return await vi.importActual<typeof import('react-markdown')>('react-markdown');
});

afterEach(cleanup);

const markdownBlocks = () => [...document.querySelectorAll('[data-component="markdown"]')];
const listText = () => document.querySelector('[data-component="message-list"]')?.textContent
  ?? document.body.textContent ?? '';

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

describe('Markdown before its renderer has loaded', () => {
  it('starts loading the renderer when the provider mounts, before any message exists', async () => {
    render(<Host chat={new StreamingChat()} />);
    await waitFor(() => expect(gate.started).toBe(1));
  });

  it('a streaming answer shows the placeholder, never its source', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('Liste?'); });
    act(() => chat.stream([{ type: 'text', text: '**Bold** and \\+ more', state: 'streaming' }]));
    const assistant = document.querySelector('[data-component="message-bubble"][data-role="assistant"]')!;
    const block = assistant.querySelector('[data-component="markdown"]')!;
    expect(block.getAttribute('data-state')).toBe('loading');
    expect(block.getAttribute('aria-busy')).toBe('true');
    expect(block.textContent).toBe('');
  });

  it('a loaded history shows placeholders, no source text and no escapes, then the rendered Markdown', async () => {
    const chat = new StreamingChat();
    chat.messages = HISTORY;
    render(<Host chat={chat} config={{ entityLinks: LINKS }} />);

    const blocks = markdownBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(block.getAttribute('data-state')).toBe('loading');
      expect(block.getAttribute('aria-busy')).toBe('true');
      expect(block.textContent).toBe('');
    }
    const text = listText();
    expect(text).not.toContain('\\');
    expect(text).not.toContain('**');
    expect(text).not.toContain('Live');
    expect(text).not.toContain('```');

    // The placeholder's size follows the source: a long answer gets more lines than a short one, bounded.
    const lines = (block: Element) => block.querySelectorAll('[data-element="markdown-placeholder-line"]').length;
    const long = blocks.find((block) => block.closest('[data-role="assistant"]') && lines(block) > 1)!;
    const short = blocks.at(-1)!;
    expect(lines(short)).toBe(1);
    expect(lines(long)).toBeGreaterThan(1);
    expect(lines(long)).toBeLessThanOrEqual(8);

    await act(async () => { gate.open(); await gate.opened; });
    await waitFor(() => expect(document.querySelector('[data-state="loading"]')).toBeNull());

    const answer = document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')[0]!;
    expect(answer.querySelectorAll('li')).toHaveLength(2);
    expect(answer.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(answer.textContent).toContain('Live + v2');
    expect(answer.textContent).toContain('Lobby (Entwurf)');
    expect(listText()).not.toContain('\\');
    expect(markdownBlocks().every((block) => !block.hasAttribute('aria-busy'))).toBe(true);
  });

  it('once loaded, a streaming answer renders exactly what react-markdown renders, from its first token', async () => {
    const { default: ReactMarkdown } = await vi.importActual<typeof import('react-markdown')>('react-markdown');
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('Liste?'); });
    const chunks = ['- **Ers', '- **Erster** Punkt\n- zwei', '- **Erster** Punkt\n- zweiter Punkt\n\n`code` und *mehr*'];
    for (const chunk of chunks) {
      act(() => chat.stream([{ type: 'text', text: chunk, state: 'streaming' }]));
      const assistant = document.querySelector('[data-component="message-bubble"][data-role="assistant"]')!;
      const block = assistant.querySelector('[data-component="markdown"]')!;
      expect(block.outerHTML).toBe(
        `<div data-component="markdown">${renderToStaticMarkup(<ReactMarkdown>{chunk}</ReactMarkdown>)}</div>`,
      );
    }
  });

  it('server rendering shows the placeholder and hydrates to Markdown without a mismatch', async () => {
    const chat = new StreamingChat();
    chat.messages = [{ id: 'a-9', role: 'assistant', parts: [{ type: 'text', text: '- **eins**\n- zwei' }] }] as unknown as ChatMessage[];
    const html = renderToString(<Host chat={chat} />);
    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain('**');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => { root = hydrateRoot(container, <Host chat={chat} />, { onRecoverableError: recoverable }); });
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(2));
    expect(container.querySelector('[data-state="loading"]')).toBeNull();
    expect(recoverable).not.toHaveBeenCalled();
    act(() => root!.unmount());
    container.remove();
  });
});
