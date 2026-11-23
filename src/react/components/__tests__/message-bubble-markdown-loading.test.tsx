// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshChat, serverHtml, settle, type ServerCase } from './markdown-loading-harness.js';

const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'markdown-ssr-main.golden.json'), 'utf8'),
) as Record<ServerCase, string>;

const markdownBox = (root: ParentNode) => root.querySelector('[data-component="markdown"]')!;
const showsSource = (text: string) => text.includes('\\+') || text.includes('**') || text.includes('- two');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.doUnmock('react-markdown');
  document.body.innerHTML = '';
});

describe('Markdown while the renderer loads (client render of a loaded history)', () => {
  it('shows a skeleton, never the source, then the rendered Markdown', async () => {
    const chat = await freshChat();
    const seen: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const observer = new MutationObserver(() => {
      const box = container.querySelector('[data-component="markdown"]');
      if (box) seen.push(box.textContent ?? '');
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    render(chat.element, { container });

    const skeleton = markdownBox(container).querySelector('[data-state="loading"]')!;
    expect(skeleton).not.toBeNull();
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    // One line per non-empty source line here (all shorter than 80 characters).
    expect(skeleton.querySelectorAll('[data-element="markdown-skeleton-line"]').length).toBe(3);
    expect(skeleton.querySelector('[aria-live]')).toBeNull();
    expect(skeleton.textContent).toBe('Loading message…');
    expect(showsSource(markdownBox(container).textContent ?? '')).toBe(false);

    await act(async () => { chat.release(); await settle(); });
    expect(await screen.findByRole('list')).toBeTruthy();
    expect(markdownBox(container).querySelector('strong')?.textContent).toBe('one');
    expect(markdownBox(container).querySelector('[data-state="loading"]')).toBeNull();
    observer.disconnect();
    expect(seen.some(showsSource)).toBe(false);
  });

  it('reads the German loading text with the German locale', async () => {
    vi.resetModules();
    const { deChatLocale } = await import('../../locale-de.js');
    expect(deChatLocale.markdownLoadingLabel).toBe('Nachricht wird geladen…');
  });
});

describe('preload', () => {
  it('starts loading react-markdown when the provider mounts', async () => {
    const chat = await freshChat({ withBubble: false });
    render(chat.element);
    await settle();
    expect(chat.importCalls()).toBe(1);
  });

  it('does not load it when the app supplies components.Markdown or components.MessageBubble', async () => {
    for (const components of [
      { Markdown: ({ content }: { content: string }) => <p data-own>{content}</p> },
      { MessageBubble: () => <div data-own /> },
    ]) {
      const chat = await freshChat({ withBubble: false, components });
      render(chat.element);
      await settle();
      expect(chat.importCalls()).toBe(0);
      cleanup();
    }
  });

  it('leaves an app Markdown component untouched', async () => {
    const chat = await freshChat({ components: { Markdown: ({ content }) => <p data-own>{content}</p> } });
    const { container } = render(chat.element);
    expect(container.querySelector('[data-own]')?.textContent).toBe('Live \\+ v2\n\n- **one**\n- two');
    expect(container.querySelector('[data-state="loading"]')).toBeNull();
  });

  it('preloadMarkdown() is idempotent and resolves even when the import fails', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('react-markdown', () => { throw new Error('not installed'); });
    const { preloadMarkdown } = await import('../../index.js');
    const first = preloadMarkdown();
    expect(preloadMarkdown()).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a finished preload lets the first render show Markdown once React retries (one suspend)', async () => {
    const chat = await freshChat();
    chat.release();
    const { preloadMarkdown } = await import('../../index.js');
    await preloadMarkdown();
    const { container } = render(chat.element);
    // React's `lazy` reads a promise's result only through `then`, so the first
    // render after a finished preload still suspends once; act() lets the retry run.
    await act(async () => { await settle(1); });
    expect(markdownBox(container).querySelector('ul')).not.toBeNull();
  });
});

describe('server rendering with a window present (jsdom) is the same as before', () => {
  for (const kind of ['string-not-loaded', 'string-loaded', 'stream-not-loaded', 'stream-loaded'] as ServerCase[]) {
    it(kind, async () => {
      expect(await serverHtml(kind)).toBe(golden[kind]);
    });
  }
});

describe('hydration of server HTML while the client renderer is pending', () => {
  // What the user sees: server HTML, then while the client renderer is pending,
  // then once it loaded. On main the middle state was the raw source in all
  // three cases (React client-renders the boundary while the renderer is
  // pending, so even server-rendered Markdown fell back to the source); the
  // recoverable errors are the same as on main.
  const cases: Array<[string, () => Promise<string>, string[], string[]]> = [
    ['completed boundary (loaded on the server)', async () => serverHtml('string-loaded'),
      ['markdown', 'skeleton', 'markdown'], []],
    ['client-render boundary (renderToString before the renderer loaded)', async () => serverHtml('string-not-loaded'),
      ['source', 'skeleton', 'markdown'], ['Switched to client rendering because the server rendering ab']],
    ['pending boundary (stream shell before its content arrived)', async () => (await serverHtml('stream-not-loaded')).split('<script>')[0]!,
      ['source', 'skeleton', 'markdown'], ['The server could not finish this Suspense boundary, likely d']],
  ];

  for (const [name, html, expectedSteps, expectedRecoverable] of cases) {
    it(name, async () => {
      const { hydrateRoot } = await import('react-dom/client');
      const markup = await html();
      const chat = await freshChat();
      const container = document.createElement('div');
      container.innerHTML = markup;
      document.body.appendChild(container);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const recoverable: unknown[] = [];
      const steps: string[] = [];
      const describeBox = () => {
        const box = markdownBox(container);
        if (box.querySelector('[data-state="loading"]')) return 'skeleton';
        if (box.querySelector('ul')) return 'markdown';
        return showsSource(box.textContent ?? '') ? 'source' : `other:${box.innerHTML}`;
      };
      // Every state the DOM passes through, repeats collapsed.
      const record = () => { const state = describeBox(); if (steps[steps.length - 1] !== state) steps.push(state); };
      record();
      const observer = new MutationObserver(record);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(container, chat.element, { onRecoverableError: (error) => { recoverable.push(error); } });
      });
      await act(async () => { await settle(); });
      record();
      await act(async () => { chat.release(); await settle(); });
      record();
      observer.disconnect();
      act(() => root.unmount());

      const hydrationErrors = errors.mock.calls.map((call) => String(call[0])).filter((m) => /hydrat|did not match|mismatch/i.test(m));
      expect(hydrationErrors).toEqual([]);
      expect(steps).toEqual(expectedSteps);
      expect(recoverable.map((e) => String((e as Error).message ?? e).slice(0, 60))).toEqual(expectedRecoverable);
    });
  }
});
