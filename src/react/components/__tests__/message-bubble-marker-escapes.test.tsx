// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types.js';
import { GRAPH_TIMEOUT, freshGraph } from './markdown-loading-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #27: a mention label in `mentionMarkers: 'markdown'` text is escaped for
// react-markdown. The raw text the bubble shows while react-markdown loads (after
// the time limit) or when it is not installed showed those escapes:
// "Abstimmung \- Wochenaktion".

const INVISIBLE = /[\u2060\u2063\u200B\u200C]/g;
const answer = (text: string) => [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] }] as unknown as ChatMessage[];
const MARKER_ANSWER = 'Siehe {{mention:task:t_1:Abstimmung - Wochenaktion (KW 3).}} und mehr.';
const entityLinks = { open: () => {}, mentionMarkers: 'markdown' as const, known: false };

const rawText = (container: Element) => (container.querySelector('[data-component="markdown"]')?.textContent ?? '').replace(INVISIBLE, '');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.doUnmock('react-markdown');
});

describe('mention labels in the raw Markdown fallback', () => {
  it('shows no SDK-inserted backslash once the loading time limit has passed', async () => {
    const graph = await freshGraph();
    vi.useFakeTimers();
    const { container } = render(graph.chatWith(answer(MARKER_ANSWER), 'ready', { entityLinks }));
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(container.querySelector('[data-state="loading"]')).toBeNull();
    expect(rawText(container)).toBe('Siehe Abstimmung - Wochenaktion (KW 3). und mehr.');
  }, GRAPH_TIMEOUT);

  it('shows no SDK-inserted backslash when react-markdown is not installed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = await freshGraph({ fail: true });
    const { container } = render(graph.chatWith(answer(MARKER_ANSWER), 'ready', { entityLinks }));
    await act(async () => { await graph.preloadMarkdown(); });
    expect(rawText(container)).toBe('Siehe Abstimmung - Wochenaktion (KW 3). und mehr.');
  }, GRAPH_TIMEOUT);

  it('keeps backslashes the answer itself wrote', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = await freshGraph({ fail: true });
    const { container } = render(graph.chatWith(answer('Live \\+ v2 {{mention:task:t_1:A\\B}}'), 'ready', { entityLinks }));
    await act(async () => { await graph.preloadMarkdown(); });
    expect(rawText(container)).toBe('Live \\+ v2 A\\B');
  }, GRAPH_TIMEOUT);
});
