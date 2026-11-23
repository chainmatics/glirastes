// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Suspense, act, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import type { ChatMessage } from '../../types.js';
import { GRAPH_TIMEOUT, MARKDOWN_SOURCE, freshGraph, serverHtmlAll, streamingHistory, type Graph, type ServerCase } from './markdown-loading-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each test builds its own module graph (`freshGraph`), so the tests do not
// depend on their order; a graph is shared only inside one test.
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'markdown-ssr-main.golden.json'), 'utf8'),
) as Record<ServerCase, string>;

const showsSource = (text: string) => /\\\+|\*\*|- two|\*live\*|\*these\*/.test(text);
const stateOf = (box: Element) => {
  if (box.querySelector('[data-state="loading"]')) return 'skeleton';
  if (box.querySelector('ul, strong, em')) return 'markdown';
  return showsSource(box.textContent ?? '') ? 'source' : `other:${box.innerHTML}`;
};
const boxes = (root: ParentNode) => [...root.querySelectorAll('[data-component="markdown"]')];

/** Every state each `[data-component="markdown"]` passes through, repeats collapsed. */
function timelines(container: Element) {
  const states: string[][] = [];
  const record = () => boxes(container).forEach((box, i) => {
    const list = (states[i] ??= []);
    const state = stateOf(box);
    if (list[list.length - 1] !== state) list.push(state);
  });
  record();
  const observer = new MutationObserver(record);
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return { states, record, stop: () => { record(); observer.disconnect(); } };
}

const host = () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
};
const mount = (element: ReactElement) => {
  const container = host();
  const view = render(element, { container });
  return { container, rerender: view.rerender };
};
const loaded = async (graph: Graph) => {
  await act(async () => { graph.release(); await graph.preloadMarkdown(); });
};
const msg = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ id, role, parts: [{ type: 'text', text }] }) as unknown as ChatMessage;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
afterAll(() => {
  vi.doUnmock('react-markdown');
});

describe('no turn running: Markdown text shows a skeleton while the renderer loads', () => {
  it('a loaded history shows a sized skeleton without the source in the DOM, then Markdown', async () => {
    const graph = await freshGraph();
    const container = host();
    const seen = timelines(container);
    render(graph.chat(), { container });

    const box = boxes(container)[0]!;
    const skeleton = box.querySelector<HTMLElement>('[data-state="loading"]')!;
    expect(skeleton).not.toBeNull();
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.querySelector('[aria-live]')).toBeNull();
    expect(skeleton.textContent).toBe('Loading message…');
    // One bar per non-empty source line; wrapping 5ch boxes in the first give the width (10 characters).
    const lines = skeleton.querySelectorAll('[data-element="markdown-skeleton-line"]');
    expect(lines).toHaveLength(3);
    expect([...lines[0]!.querySelectorAll<HTMLElement>(':scope > span')].map((spacer) => spacer.style.inlineSize)).toEqual(['5ch', '5ch']);
    expect(skeleton.style.maxInlineSize).toBe('var(--cm-markdown-skeleton-max-width, 100%)');
    const bubble = container.querySelector('[data-component="message-bubble"]')!;
    for (const piece of ['Live', '\\+', '**one**', 'two']) expect(bubble.outerHTML).not.toContain(piece);

    await loaded(graph);
    expect(box.querySelector('ul')).not.toBeNull();
    expect(box.querySelector('strong')?.textContent).toBe('one');
    seen.stop();
    expect(seen.states).toEqual([['skeleton', 'markdown']]);
  }, GRAPH_TIMEOUT);

  it('text Markdown would show the same stays raw as before', async () => {
    const graph = await freshGraph();
    const raw = ['OK', '/Open Overview', 'Yes, the order is open. Thanks, Anna'];
    const skeleton = [
      '- a\n- b', '**bold**', '[link](https://example.com)', '```\ncode\n```', 'Live \\+ v2', 'two\n\nparagraphs',
      'see www.example.com', 'see WWW.Example.com', 'see wWw.example.com', 'nul\u0000byte', 'Note: 1', '1. first', 'a@b.de',
    ];
    const messages = [...raw, ...skeleton].map((text, i) => msg(`m${i}`, 'assistant', text));
    const { container } = mount(graph.chatWith(messages, 'ready'));
    expect(boxes(container).map((box) => (box.querySelector('[data-state="loading"]') ? 'skeleton' : box.textContent)))
      .toEqual([...raw, ...skeleton.map(() => 'skeleton')]);
  }, GRAPH_TIMEOUT);

  it('copying a loading message yields what it did before', async () => {
    const marker = 'Found {{mention:playlist:pl_7:Lobby Loop}} *live*';
    const cases: Array<[string, ChatMessage['role'], string, Record<string, unknown>?]> = [
      ['assistant list', 'assistant', MARKDOWN_SOURCE],
      ['user code', 'user', 'Run `bun test`:\n\n```\nbun test --watch\n```'],
      ['mention marker', 'assistant', marker, { entityLinks: { open: () => {}, mentionMarkers: 'markdown', known: false } }],
    ];
    for (const [name, role, text, props] of cases) {
      const graph = await freshGraph();
      const { markdownWithMentionMarkers } = await import('../../entity-links/entity-links-react.js');
      const { parseMentionSegments } = await import('../../utils/mention-markup.js');
      const { container } = mount(graph.chatWith([{ id: 'x', role, parts: [{ type: 'text', text }] } as unknown as ChatMessage], 'ready', props));
      const bubble = container.querySelector('[data-component="message-bubble"]')!;
      expect(bubble.querySelector('[data-state="loading"]'), name).not.toBeNull();
      const source = name === 'mention marker' ? markdownWithMentionMarkers(parseMentionSegments(text)).content : text;
      // What the bubble held before the skeleton: the source as text in the Markdown block.
      const before = document.createElement('div');
      const block = document.createElement('div');
      block.setAttribute('data-component', 'markdown');
      block.textContent = source;
      before.appendChild(block);
      expect(graph.messageClipboardContent(bubble, ''), name).toEqual(graph.messageClipboardContent(before, ''));
      cleanup();
    }
  }, GRAPH_TIMEOUT);

  it('German locale text', () => {
    expect(deChatLocale.markdownLoadingLabel).toBe('Nachricht wird geladen…');
  });
});

describe('a running turn keeps the raw text, as before', () => {
  it('every bubble is raw while submitted or streaming, also history mounting during the run', async () => {
    for (const status of ['submitted', 'streaming'] as const) {
      const graph = await freshGraph();
      const { container, rerender } = mount(graph.chatWith(streamingHistory, status));
      expect(boxes(container).map(stateOf), status).toEqual(['source', 'source', 'source']);
      // An older message mounts during the run (load more, a restored session).
      rerender(graph.chatWith([msg('older', 'assistant', 'Older **one**'), ...streamingHistory], status));
      expect(boxes(container).map(stateOf), status).toEqual(['source', 'source', 'source', 'source']);
      await loaded(graph);
      expect(boxes(container).map(stateOf), status).toEqual(['markdown', 'markdown', 'markdown', 'markdown']);
      cleanup();
    }
  }, GRAPH_TIMEOUT);

  it('a bubble keeps what it showed first until Markdown renders (turn ends, a new turn starts)', async () => {
    const graph = await freshGraph();
    const container = host();
    const seen = timelines(container);
    const running = [streamingHistory[1]!, streamingHistory[2]!];
    const view = render(graph.chatWith(running, 'streaming'), { container });
    seen.record();
    for (const status of ['ready', 'error', 'ready'] as const) {
      view.rerender(graph.chatWith(running, status));
      seen.record();
    }
    // A question sent now renders first while idle, then the turn runs: it keeps the skeleton.
    const next = msg('q2', 'user', 'And *these*?');
    view.rerender(graph.chatWith([...running, next], 'ready'));
    seen.record();
    view.rerender(graph.chatWith([...running, next], 'submitted'));
    seen.record();
    await loaded(graph);
    seen.stop();
    expect(seen.states).toEqual([['source', 'markdown'], ['source', 'markdown'], ['skeleton', 'markdown']]);
  }, GRAPH_TIMEOUT);
});

describe('own layouts and nodes', () => {
  it('an own list on useMessageParts follows the same rule: idle → skeleton, running → raw', async () => {
    for (const [status, expected] of [['ready', ['skeleton', 'skeleton', 'skeleton']], ['streaming', ['source', 'source', 'source']]] as const) {
      const graph = await freshGraph();
      const { container } = mount(graph.ownList(streamingHistory, status));
      expect(boxes(container).map(stateOf), status).toEqual(expected);
      cleanup();
    }
  }, GRAPH_TIMEOUT);

  it('a text node is exactly the Markdown element as before; cloneElement still applies', async () => {
    const graph = await freshGraph();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { AiChatProvider } = await import('../../provider/ai-chat-provider.js');
    for (const status of ['ready', 'streaming'] as const) {
      let entryNode: ReactNode = null;
      function Own({ message }: { message: ChatMessage }) {
        entryNode = graph.useMessageParts(message).parts.find((entry) => entry.kind === 'text')?.node ?? null;
        return <div>{isValidElement(entryNode) ? cloneElement(entryNode as ReactElement<{ className?: string }>, { className: 'own' }) : null}</div>;
      }
      const { container } = mount(
        <AiChatProvider transport={{ messages: streamingHistory, status, error: null, sendMessage: async () => {}, stop() {}, setMessages() {}, addToolApprovalResponse: async () => {} }}>
          <Own message={streamingHistory[2]!} />
        </AiChatProvider>,
      );
      const node = entryNode as unknown as ReactElement<Record<string, unknown>>;
      expect((node.type as { name?: string }).name).toBe('DefaultMarkdown');
      expect(node.props, status).toEqual({ content: 'Streaming **now**' });
      expect(container.querySelector('[data-component="markdown"]')?.className).toBe('own');
      mount(<div {...node.props} />);
      cleanup();
    }
    expect(errors).not.toHaveBeenCalled();
  }, GRAPH_TIMEOUT);

  it('a text node rendered outside the provider (print, renderToStaticMarkup) renders as before, without throwing', async () => {
    const graph = await freshGraph();
    let text: ReactNode = null;
    function Capture() {
      text = graph.useMessageParts(streamingHistory[0]!).text;
      return null;
    }
    const { AiChatProvider } = await import('../../provider/ai-chat-provider.js');
    mount(
      <AiChatProvider transport={{ messages: [streamingHistory[0]!], status: 'ready', error: null, sendMessage: async () => {}, stop() {}, setMessages() {}, addToolApprovalResponse: async () => {} }}>
        <Capture />
      </AiChatProvider>,
    );
    // Before the renderer loaded: the raw text (React's client-render boundary of renderToStaticMarkup).
    expect(renderToStaticMarkup(<>{text}</>)).toBe('<div data-component="markdown">Earlier **answer**</div>');
    await loaded(graph);
    expect(renderToStaticMarkup(<>{text}</>)).toBe('<div data-component="markdown"><p>Earlier <strong>answer</strong></p></div>');
  }, GRAPH_TIMEOUT);
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
    const own = mount(graph.chat({ components: { Markdown: ({ content }) => <p data-own>{content}</p> } }));
    expect(own.container.querySelector('[data-own]')?.textContent).toBe(MARKDOWN_SOURCE);
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
    const container = host();
    const seen = timelines(container);
    render(graph.chat(), { container });
    expect(stateOf(boxes(container)[0]!)).toBe('markdown');
    seen.stop();
    expect(seen.states).toEqual([['markdown']]);
  }, GRAPH_TIMEOUT);

  it('preloadMarkdown() resolves when the import fails; the chat shows the plain text as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = await freshGraph({ fail: true });
    await expect(graph.preloadMarkdown()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const { container } = mount(graph.chat());
    expect(boxes(container)[0]?.textContent).toBe(MARKDOWN_SOURCE);
  }, GRAPH_TIMEOUT);
});

describe('server rendering with a window present (jsdom) is the same as before', () => {
  it('renderToString and streaming, renderer not loaded and loaded', async () => {
    expect(await serverHtmlAll()).toEqual(golden);
  }, GRAPH_TIMEOUT);
});

describe('hydration is the same as before', () => {
  // The states each server output passes through when hydrated while the client
  // renderer is pending, then loaded: recorded on main.
  it('timelines and errors equal main, with the renderer pending and preloaded', async () => {
    const { hydrateRoot } = await import('react-dom/client');
    for (const preloaded of [false, true]) {
      const graph = await freshGraph();
      if (preloaded) { graph.release(); await graph.preloadMarkdown(); }
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cases: Array<[string, string, string[], string[]]> = [
        [golden['string-loaded'], 'completed', preloaded ? ['markdown'] : ['markdown', 'source', 'markdown'], []],
        [golden['string-not-loaded'], 'client-render', ['source', 'markdown'], ['Switched to client rendering because the server rendering ab']],
        [golden['stream-not-loaded'].split('<script>')[0]!, 'pending stream shell', ['source', 'markdown'],
          ['The server could not finish this Suspense boundary, likely d']],
      ];
      const runs = cases.map(([markup, name, expected, expectedRecoverable]) => {
        const container = host();
        container.innerHTML = markup;
        return { container, name, expected, expectedRecoverable, recoverable: [] as string[], seen: timelines(container), root: null as null | ReturnType<typeof hydrateRoot> };
      });
      await act(async () => {
        for (const run of runs) {
          run.root = hydrateRoot(run.container, graph.chat(), {
            onRecoverableError: (error) => { run.recoverable.push(String((error as Error).message ?? error).slice(0, 60)); },
          });
        }
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      await loaded(graph);
      for (const run of runs) {
        run.seen.stop();
        act(() => run.root!.unmount());
        expect({ preloaded, name: run.name, states: run.seen.states[0], recoverable: run.recoverable })
          .toEqual({ preloaded, name: run.name, states: run.expected, recoverable: run.expectedRecoverable });
      }
      expect(errors.mock.calls.map((call) => String(call[0])).filter((m) => /hydrat|did not match|mismatch/i.test(m))).toEqual([]);
      errors.mockRestore();
      document.body.innerHTML = '';
    }
  }, GRAPH_TIMEOUT);
});

const BASE_SEQUENCES: Record<string, string[]> = {
  'root raw': ['source', 'markdown'],
  'root markdown': ['markdown', 'source', 'markdown'],
  'boundary raw': ['source', 'markdown'],
  'boundary markdown': ['markdown', 'source', 'markdown'],
};

describe('failed hydration (React client-renders the server HTML) is the same as before', () => {
  // A mismatch elsewhere in the root, or in an app Suspense boundary holding the
  // chat, makes React give up hydrating and render that part on the client.
  // Sequences recorded on main (the same for both mismatch positions), renderer
  // pending on the client.
  const wrap = (level: 'root' | 'boundary', side: string, inner: ReactElement, where: 'before' | 'after') => {
    const parts = where === 'before' ? <><span>{side}</span>{inner}</> : <>{inner}<span>{side}</span></>;
    return level === 'root' ? <div>{parts}</div> : <div><Suspense fallback={null}>{parts}</Suspense></div>;
  };
  const expected: Record<string, string[]> = {
    'root raw': BASE_SEQUENCES['root raw']!,
    'root markdown': BASE_SEQUENCES['root markdown']!,
    'boundary raw': BASE_SEQUENCES['boundary raw']!,
    'boundary markdown': BASE_SEQUENCES['boundary markdown']!,
  };
  for (const where of ['before', 'after'] as const) for (const level of ['root', 'boundary'] as const) {
    for (const server of ['raw', 'markdown'] as const) {
      it(`${level}, server ${server}, mismatch ${where} the chat`, async () => {
        const { renderToString } = await import('react-dom/server');
        const serverGraph = await freshGraph();
        if (server === 'markdown') {
          renderToString(serverGraph.chat()); // starts the lazy import, also where it is not shared (main)
          serverGraph.release();
          await serverGraph.preloadMarkdown();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const markup = renderToString(wrap(level, 'server', serverGraph.chat(), where));
        expect(markup.includes('<strong>'), 'server variant').toBe(server === 'markdown');
        const { hydrateRoot } = await import('react-dom/client');
        const graph = await freshGraph();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const container = host();
        container.innerHTML = markup;
        const seen = timelines(container);
        let root!: ReturnType<typeof hydrateRoot>;
        await act(async () => { root = hydrateRoot(container, wrap(level, 'client', graph.chat(), where), { onRecoverableError: () => {} }); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        await loaded(graph);
        seen.stop();
        act(() => root.unmount());
        // Declared difference: a mismatch before the chat (in tree order) stops hydration before the
        // chat renders at all, so nothing tells its later client render apart from a fresh mount.
        const declared = server === 'raw' ? ['source', 'skeleton', 'markdown'] : ['markdown', 'skeleton', 'markdown'];
        expect(seen.states[0]).toEqual(where === 'after' ? expected[`${level} ${server}`] : declared);
      }, GRAPH_TIMEOUT);
    }
  }

  it('an SSR page hydrated without problems still shows the skeleton for history that arrives later on the client', async () => {
    const { renderToString } = await import('react-dom/server');
    const serverGraph = await freshGraph();
    const markup = renderToString(serverGraph.chatWith([], 'ready'));
    const { hydrateRoot } = await import('react-dom/client');
    const graph = await freshGraph();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = host();
    container.innerHTML = markup;
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, graph.chatWith([], 'ready')); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { root.render(graph.chatWith([msg('h1', 'assistant', MARKDOWN_SOURCE)], 'ready')); });
    expect(boxes(container).map(stateOf)).toEqual(['skeleton']);
    await loaded(graph);
    expect(boxes(container).map(stateOf)).toEqual(['markdown']);
    act(() => root.unmount());
    expect(errors.mock.calls.map((call) => String(call[0]).slice(0, 120))).toEqual([]);
  }, GRAPH_TIMEOUT);
});

