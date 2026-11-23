// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverHtml, type ServerCase } from './markdown-loading-harness.js';

// Generated from main (0.23.0 line, before the loading skeleton) with the same
// harness; only the absolute paths with line numbers in renderToString's
// component stack (`data-cstck`) are masked.
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'markdown-ssr-main.golden.json'), 'utf8'),
) as Record<ServerCase, string>;

afterEach(() => {
  vi.doUnmock('react-markdown');
});

describe('server rendering without a window is the same as before', () => {
  it('has no window', () => {
    expect(typeof window).toBe('undefined');
  });

  for (const kind of ['string-not-loaded', 'string-loaded', 'stream-not-loaded', 'stream-loaded'] as ServerCase[]) {
    it(kind, async () => {
      expect(await serverHtml(kind)).toBe(golden[kind]);
    });
  }

  it('preloadMarkdown() is safe on the server', async () => {
    vi.resetModules();
    const { preloadMarkdown } = await import('../../index.js');
    await expect(preloadMarkdown()).resolves.toBeUndefined();
    await expect(preloadMarkdown()).resolves.toBeUndefined();
  });
});
