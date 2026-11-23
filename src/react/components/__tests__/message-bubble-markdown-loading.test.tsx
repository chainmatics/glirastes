// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Suspense, act, cloneElement, isValidElement, lazy, type ReactElement, type ReactNode } from 'react';
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

describe('React builds server-rendered chat HTML on the client instead of hydrating it (declared difference)', () => {
  // After a hydration mismatch (before or after the chat), main showed the raw
  // source until Markdown rendered (server Markdown: Markdown → source →
  // Markdown); now a client render inside the provider shows the skeleton.
  const wrap = (level: 'root' | 'boundary', side: string, inner: ReactElement, where: 'before' | 'after') => {
    const parts = where === 'before' ? <><span>{side}</span>{inner}</> : <>{inner}<span>{side}</span></>;
    return level === 'root' ? <div>{parts}</div> : <div><Suspense fallback={null}>{parts}</Suspense></div>;
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
        // main: ['source', 'markdown'] / ['markdown', 'source', 'markdown'].
        expect(seen.states[0]).toEqual(server === 'raw' ? ['source', 'skeleton', 'markdown'] : ['markdown', 'skeleton', 'markdown']);
      }, GRAPH_TIMEOUT);
    }
  }

  it('a still-dehydrated app Suspense boundary (lazy part before the bubbles) that React renders on the client', async () => {
    const makePart = () => {
      let resolve!: () => void;
      const ready = new Promise<{ default: () => ReactElement }>((done) => { resolve = () => done({ default: () => <span>part</span> }); });
      return { Part: lazy(() => ready), resolve, ready };
    };
    const { renderToString } = await import('react-dom/server');
    const serverGraph = await freshGraph();
    const serverPart = makePart();
    serverPart.resolve();
    const serverWrap = (bubble: ReactElement) => <Suspense fallback={null}><serverPart.Part />{bubble}</Suspense>;
    renderToString(serverGraph.chat({ wrapBubble: serverWrap }));
    await serverPart.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const markup = renderToString(serverGraph.chat({ wrapBubble: serverWrap }));
    expect(markup).toContain('<span>part</span>');
    const { hydrateRoot } = await import('react-dom/client');
    const graph = await freshGraph();
    const clientPart = makePart();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = host();
    container.innerHTML = markup;
    const seen = timelines(container);
    let root!: ReturnType<typeof hydrateRoot>;
    const clientChat = () => graph.chat({ wrapBubble: (bubble) => <Suspense fallback={null}><clientPart.Part />{bubble}</Suspense> });
    await act(async () => { root = hydrateRoot(container, clientChat(), { onRecoverableError: () => {} }); });
    // An update from above (here a re-render of the root) reaches the boundary while it is still dehydrated.
    await act(async () => { root.render(clientChat()); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { clientPart.resolve(); await clientPart.ready; });
    await loaded(graph);
    seen.stop();
    act(() => root.unmount());
    // main: ['source', 'markdown'].
    expect(seen.states[0]).toEqual(['source', 'skeleton', 'markdown']);
  }, GRAPH_TIMEOUT);
});

describe('client mounts in a server-rendered page', () => {
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

  it('a renderToString in the same module graph does not change a later client mount', async () => {
    const { renderToString } = await import('react-dom/server');
    const graph = await freshGraph();
    renderToString(graph.chat());
    const { container } = mount(graph.chat());
    expect(boxes(container).map(stateOf)).toEqual(['skeleton']);
  }, GRAPH_TIMEOUT);

  it('a text node hydrated outside the provider keeps the server Markdown, as before', async () => {
    const { renderToString } = await import('react-dom/server');
    const capture = async (graph: Graph) => {
      // The provider of the same module graph as the hook.
      const { AiChatProvider } = await import('../../provider/ai-chat-provider.js');
      let text: ReactNode = null;
      const { useMessageParts } = graph;
      function Capture() { text = useMessageParts(streamingHistory[0]!).text; return null; }
      const transport = { messages: [streamingHistory[0]!], status: 'ready' as const, error: null, sendMessage: async () => {}, stop() {}, setMessages() {}, addToolApprovalResponse: async () => {} };
      renderToString(<AiChatProvider transport={transport}><Capture /></AiChatProvider>);
      return text;
    };
    const serverGraph = await freshGraph();
    serverGraph.release();
    await serverGraph.preloadMarkdown();
    renderToString(<>{await capture(serverGraph)}</>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const markup = renderToString(<>{await capture(serverGraph)}</>);
    expect(markup).toContain('<strong>answer</strong>');
    const graph = await freshGraph();
    const text = await capture(graph);
    const { hydrateRoot } = await import('react-dom/client');
    const container = host();
    container.innerHTML = markup;
    const seen = timelines(container);
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, <>{text}</>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await loaded(graph);
    seen.stop();
    act(() => root.unmount());
    expect(seen.states[0]).toEqual(['markdown']);
  }, GRAPH_TIMEOUT);
});

