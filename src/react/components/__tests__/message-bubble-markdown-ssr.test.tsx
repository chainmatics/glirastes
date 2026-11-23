// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GRAPH_TIMEOUT, freshGraph, serverHtmlAll, type ServerCase } from './markdown-loading-harness.js';

// Generated from main (0.23.0 line, before the loading skeleton) with the same
// harness; only the absolute paths with line numbers in renderToString's
// component stack (`data-cstck`) are masked.
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'markdown-ssr-main.golden.json'), 'utf8'),
) as Record<ServerCase, string>;

afterAll(() => {
  vi.doUnmock('react-markdown');
});

describe('server rendering without a window is the same as before', () => {
  it('renderToString and streaming, renderer not loaded and loaded', async () => {
    expect(typeof window).toBe('undefined');
    expect(await serverHtmlAll()).toEqual(golden);
  }, GRAPH_TIMEOUT);

  it('preloadMarkdown() is safe on the server and lets renderToString send Markdown', async () => {
    const { renderToString } = await import('react-dom/server');
    const graph = await freshGraph();
    graph.release();
    const first = graph.preloadMarkdown();
    expect(graph.preloadMarkdown()).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(renderToString(graph.chat())).toBe(golden['string-loaded']);
  }, GRAPH_TIMEOUT);
});
