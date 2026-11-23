// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import { GRAPH_TIMEOUT, freshGraph, serverHtmlAll, type ServerCase } from './markdown-loading-harness.js';

// Each test builds its own module graph (`freshGraph`), so the tests do not
// depend on their order; a graph is shared only inside one test.
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'markdown-ssr-main.golden.json'), 'utf8'),
) as Record<ServerCase, string>;

const showsSource = (text: string) => /\\\+|\*\*|- two|\*live\*/.test(text);
const stateOf = (box: Element) => {
  if (box.querySelector('[data-state="loading"]')) return 'skeleton';
  if (box.querySelector('ul, strong, em')) return 'markdown';
  return showsSource(box.textContent ?? '') ? 'source' : `other:${box.innerHTML}`;
};

/** Every state the first `[data-component="markdown"]` in `container` passes through, repeats collapsed. */
function timeline(container: Element, nth = 0) {
  const states: string[] = [];
  const record = () => {
    const box = container.querySelectorAll('[data-component="markdown"]')[nth];
    const state = box ? stateOf(box) : 'none';
    if (states[states.length - 1] !== state) states.push(state);
  };
  record();
  const observer = new MutationObserver(record);
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return { states, stop: () => { record(); observer.disconnect(); } };
}

const mount = (element: ReactElement) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(element, { container });
  return { container };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
afterAll(() => {
  vi.doUnmock('react-markdown');
});

describe('Markdown while the renderer loads', () => {
  it('a loaded history shows a sized skeleton, never the source, then the rendered Markdown', async () => {
    const graph = await freshGraph();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const seen = timeline(container);
    render(graph.chat(), { container });

    const box = container.querySelector('[data-component="markdown"]')!;
    const skeleton = box.querySelector<HTMLElement>('[data-state="loading"]')!;
    expect(skeleton).not.toBeNull();
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.querySelector('[aria-live]')).toBeNull();
    expect(skeleton.textContent).toBe('Loading message…');
    // An own width from the source (the longest line, 10 characters), so a bubble
    // sized by its content does not collapse; one bar per non-empty source line.
    expect(skeleton.style.inlineSize).toBe('10ch');
    expect(skeleton.style.maxInlineSize).toBe('var(--cm-markdown-skeleton-max-width, 100%)');
    expect(skeleton.querySelectorAll('[data-element="markdown-skeleton-line"]')).toHaveLength(3);

    await act(async () => { graph.release(); await graph.preloadMarkdown(); });
    expect(box.querySelector('ul')).not.toBeNull();
    expect(box.querySelector('strong')?.textContent).toBe('one');
    seen.stop();
    expect(seen.states).toEqual(['none', 'skeleton', 'markdown']);
  }, GRAPH_TIMEOUT);

  it('a running turn keeps the raw text as before: the streaming answer and the just-sent question', async () => {
    const graph = await freshGraph();
    const { container } = mount(graph.streamingChat());
    const boxes = [...container.querySelectorAll('[data-component="markdown"]')].map(stateOf);
    // The earlier answer is history: skeleton. Question and answer of the running turn: raw, as on main.
    expect(boxes).toEqual(['skeleton', 'source', 'source']);
    await act(async () => { graph.release(); await graph.preloadMarkdown(); });
    expect([...container.querySelectorAll('[data-component="markdown"]')].map(stateOf)).toEqual(['markdown', 'markdown', 'markdown']);
  }, GRAPH_TIMEOUT);

  it('German locale text', () => {
    expect(deChatLocale.markdownLoadingLabel).toBe('Nachricht wird geladen…');
  });
});

describe('preload', () => {
  it('starts on provider mount, except with an own Markdown or MessageBubble slot or markdown.preload: false', async () => {
    const graph = await freshGraph();
    for (const options of [
      { components: { Markdown: ({ content }: { content: string }) => <p data-own>{content}</p> } },
      { components: { MessageBubble: () => <div data-own /> } },
      { markdown: { preload: false } },
    ]) {
      mount(graph.chat({ ...options, withBubble: false }));
      await act(async () => {});
      cleanup();
    }
    expect(graph.importCalls()).toBe(0);

    // An own Markdown component is untouched.
    const own = mount(graph.chat({ components: { Markdown: ({ content }) => <p data-own>{content}</p> } }));
    expect(own.container.querySelector('[data-own]')?.textContent).toBe('Live \\+ v2\n\n- **one**\n- two');
    cleanup();
    expect(graph.importCalls()).toBe(0);

    mount(graph.chat({ withBubble: false }));
    await act(async () => {});
    expect(graph.importCalls()).toBe(1);
  }, GRAPH_TIMEOUT);

  it('after a finished preload the first mount shows Markdown without a skeleton', async () => {
    const graph = await freshGraph();
    graph.release();
    await graph.preloadMarkdown();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const seen = timeline(container);
    render(graph.chat(), { container });
    expect(stateOf(container.querySelector('[data-component="markdown"]')!)).toBe('markdown');
    seen.stop();
    expect(seen.states).toEqual(['none', 'markdown']);
  }, GRAPH_TIMEOUT);

  it('preloadMarkdown() resolves when the import fails; the chat shows the plain text as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = await freshGraph({ fail: true });
    await expect(graph.preloadMarkdown()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const { container } = mount(graph.chat());
    expect(container.querySelector('[data-component="markdown"]')?.textContent).toBe('Live \\+ v2\n\n- **one**\n- two');
  }, GRAPH_TIMEOUT);
});

describe('server rendering with a window present (jsdom) is the same as before', () => {
  it('renderToString and streaming, renderer not loaded and loaded', async () => {
    expect(await serverHtmlAll()).toEqual(golden);
  }, GRAPH_TIMEOUT);
});

describe('hydration of server HTML while the client renderer is pending', () => {
  // What the user sees: server HTML, then while the client renderer is pending,
  // then once it loaded. On main the middle state was the raw source in all
  // three cases (React replaced the boundary by its fallback, even
  // server-rendered Markdown); the recoverable errors are the same as on main.
  it('no hydration errors; skeleton where main showed the source', async () => {
    const { hydrateRoot } = await import('react-dom/client');
    const graph = await freshGraph();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: Array<[string, string, string[], string[]]> = [
      [golden['string-loaded'], 'completed', ['markdown', 'skeleton', 'markdown'], []],
      [golden['string-not-loaded'], 'client-render', ['source', 'skeleton', 'markdown'],
        ['Switched to client rendering because the server rendering ab']],
      [golden['stream-not-loaded'].split('<script>')[0]!, 'pending stream shell', ['source', 'skeleton', 'markdown'],
        ['The server could not finish this Suspense boundary, likely d']],
    ];
    const runs = cases.map(([markup, name, expected, expectedRecoverable]) => {
      const container = document.createElement('div');
      container.innerHTML = markup;
      document.body.appendChild(container);
      return { container, name, expected, expectedRecoverable, recoverable: [] as string[], seen: timeline(container), root: null as null | ReturnType<typeof hydrateRoot> };
    });
    await act(async () => {
      for (const run of runs) {
        run.root = hydrateRoot(run.container, graph.chat(), {
          onRecoverableError: (error) => { run.recoverable.push(String((error as Error).message ?? error).slice(0, 60)); },
        });
      }
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { graph.release(); await graph.preloadMarkdown(); });
    for (const run of runs) {
      run.seen.stop();
      act(() => run.root!.unmount());
      expect({ name: run.name, states: run.seen.states, recoverable: run.recoverable })
        .toEqual({ name: run.name, states: run.expected, recoverable: run.expectedRecoverable });
    }
    expect(errors.mock.calls.map((call) => String(call[0])).filter((m) => /hydrat|did not match|mismatch/i.test(m))).toEqual([]);
  }, GRAPH_TIMEOUT);

  it('with the renderer preloaded on the client: no hydration errors, no skeleton', async () => {
    const { hydrateRoot } = await import('react-dom/client');
    const graph = await freshGraph();
    graph.release();
    await graph.preloadMarkdown();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: Array<[string, string[], number]> = [
      [golden['string-loaded'], ['markdown'], 0],
      [golden['string-not-loaded'], ['source', 'markdown'], 1],
      [golden['stream-not-loaded'].split('<script>')[0]!, ['source', 'markdown'], 1],
    ];
    for (const [markup, expected, recoverableCount] of cases) {
      const container = document.createElement('div');
      container.innerHTML = markup;
      document.body.appendChild(container);
      const seen = timeline(container);
      const recoverable: unknown[] = [];
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => { root = hydrateRoot(container, graph.chat(), { onRecoverableError: (e) => { recoverable.push(e); } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      seen.stop();
      act(() => root.unmount());
      expect(seen.states).toEqual(expected);
      expect(recoverable).toHaveLength(recoverableCount);
    }
    expect(errors.mock.calls.map((call) => String(call[0])).filter((m) => /hydrat|did not match|mismatch/i.test(m))).toEqual([]);
  }, GRAPH_TIMEOUT);
});
