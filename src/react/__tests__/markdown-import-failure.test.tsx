// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadMarkdown } from '../index.js';
import type { ChatMessage } from '../types.js';
import { Host, StreamingChat } from './streaming-chat.js';

// react-markdown cannot be loaded (not installed, a failed chunk).
vi.mock('react-markdown', () => {
  throw new Error('Cannot find package react-markdown');
});

afterEach(cleanup);

const ANSWER = [
  '## Ergebnis',
  '',
  '- **{{mention:playlist:pl_7:Live + v2}}** läuft',
  '- [Details](https://example.com/x) und `code`',
  '',
  '| Name | Status |',
  '| --- | --- |',
  '| Lobby | aktiv |',
].join('\n');

describe('the Markdown renderer cannot be loaded', () => {
  it('preloadMarkdown resolves (never rejects) and is idempotent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = preloadMarkdown();
    expect(preloadMarkdown()).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('shows the text without Markdown syntax or escapes instead of a placeholder that never ends', async () => {
    const chat = new StreamingChat();
    chat.messages = [
      { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Welche **Playlists**?' }] },
      { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: ANSWER }] },
    ] as unknown as ChatMessage[];
    render(<Host chat={chat} config={{ entityLinks: { open: vi.fn(), mentionMarkers: 'markdown', known: false, verifyMentions: false } }} />);
    await waitFor(() => expect(document.querySelector('[data-component="markdown"][data-state="plain"]')).not.toBeNull());
    expect(document.querySelector('[data-state="loading"]')).toBeNull();

    const answer = document.querySelector('[data-component="message-bubble"][data-role="assistant"] [data-component="markdown"]')!;
    const text = answer.textContent ?? '';
    expect(text).toContain('Ergebnis');
    expect(text).toContain('Live + v2 läuft');
    expect(text).toContain('Details und code');
    expect(text).toContain('Lobby');
    for (const syntax of ['\\', '**', '##', '](', '`', '---', '\u2060', '\u2063', '\u200B', '\u200C']) expect(text).not.toContain(syntax);
    // Lines stay apart.
    expect(answer.querySelectorAll('br').length + answer.querySelectorAll('p').length).toBeGreaterThan(2);

    const user = document.querySelector('[data-component="message-bubble"][data-role="user"]')!;
    expect(user.textContent).toBe('Welche Playlists?');
  });
});
