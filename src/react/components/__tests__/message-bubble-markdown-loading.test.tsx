// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import type { ChatMessage } from '../../types.js';
import { GRAPH_TIMEOUT, MARKDOWN_SOURCE, freshGraph, serverHtmlAll, streamingHistory, type ServerCase } from './markdown-loading-harness.js';

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
    // Wrapping 5ch spacers in the first bar: 2 of them for 10 characters.
    const spacers = skeleton.querySelector('[data-element="markdown-skeleton-line"]')!.querySelectorAll<HTMLElement>(':scope > span');
    expect([...spacers].map((spacer) => spacer.style.inlineSize)).toEqual(['5ch', '5ch']);
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

  it('the source is not in the DOM; copying a loading message yields what it did before', async () => {
    const { markdownWithMentionMarkers } = await import('../../entity-links/entity-links-react.js');
    const { parseMentionSegments } = await import('../../utils/mention-markup.js');
    const marker = 'Found {{mention:playlist:pl_7:Lobby Loop}} *live*';
    const cases: Array<[string, ChatMessage['role'], string, Record<string, unknown>?]> = [
      ['assistant list', 'assistant', MARKDOWN_SOURCE],
      ['user code', 'user', 'Run `bun test`:\n\n```\nbun test --watch\n```'],
      ['mention marker', 'assistant', marker, { entityLinks: { open: () => {}, mentionMarkers: 'markdown', known: false } }],
    ];
    for (const [name, role, text, props] of cases) {
      const graph = await freshGraph();
      // The copy helper of the same module graph as the bubble.
      const { messageClipboardContent } = await import('../../utils/copy-message.js');
      const msg = { id: 'x', role, parts: [{ type: 'text', text }] } as unknown as ChatMessage;
      const { container } = mount(graph.chatWith([msg], 'ready', props));
      const bubble = container.querySelector('[data-component="message-bubble"]')!;
      expect(bubble.querySelector('[data-state="loading"]'), name).not.toBeNull();
      // Markdown source as the default Markdown receives it (markers transformed in marker mode).
      const source = name === 'mention marker' ? markdownWithMentionMarkers(parseMentionSegments(text)).content : text;
      for (const piece of source.split(/\n+/).filter((line) => line.length > 3)) expect(bubble.outerHTML, name).not.toContain(piece);
      // What the bubble held before the skeleton: the source as text in the Markdown block.
      const before = document.createElement('div');
      const block = document.createElement('div');
      block.setAttribute('data-component', 'markdown');
      block.textContent = source;
      before.appendChild(block);
      expect(messageClipboardContent(bubble, ''), name).toEqual(messageClipboardContent(before, ''));
      cleanup();
    }
  }, GRAPH_TIMEOUT);

  it('text Markdown would show the same stays raw as before; anything Markdown-significant gets the skeleton', async () => {
    const graph = await freshGraph();
    const raw = ['OK', '/Open Overview', 'Yes, the order is open. Thanks, Anna'];
    const skeleton = ['- a\n- b', '**bold**', '[link](https://example.com)', '```\ncode\n```', 'Live \\+ v2', 'two\n\nparagraphs', 'see www.example.com', 'Note: 1', '1. first', 'a@b.de'];
    const messages = [...raw, ...skeleton].map((text, i) => ({ id: `m${i}`, role: 'assistant', parts: [{ type: 'text', text }] }) as unknown as ChatMessage);
    const { container } = mount(graph.chatWith(messages, 'ready'));
    const boxes = [...container.querySelectorAll('[data-component="markdown"]')];
    expect(boxes.map((box) => (box.querySelector('[data-state="loading"]') ? 'skeleton' : box.textContent)))
      .toEqual([...raw, ...skeleton.map(() => 'skeleton')]);
  }, GRAPH_TIMEOUT);

  it('a bubble never changes representation before Markdown renders', async () => {
    const graph = await freshGraph();
    const question = streamingHistory[1]!;
    const answer = streamingHistory[2]!;
    const box = document.createElement('div');
    document.body.appendChild(box);
    const seen = [0, 1, 2].map(() => [] as string[]);
    const record = () => [...box.querySelectorAll('[data-component="markdown"]')].forEach((el, i) => {
      const state = stateOf(el);
      if (seen[i] && seen[i]!.at(-1) !== state) seen[i]!.push(state);
    });
    const observer = new MutationObserver(record);
    observer.observe(box, { childList: true, subtree: true, characterData: true });
    // A history answer joins a running turn (Continue, approve, regenerate): stays a skeleton.
    const view = render(graph.chatWith([question, answer], 'ready'), { container: box });
    record();
    view.rerender(graph.chatWith([question, answer], 'streaming'));
    record();
    // The just-sent question renders once before `submitted`: it keeps what it showed first.
    const next = { id: 'q2', role: 'user', parts: [{ type: 'text', text: 'And *these*?' }] } as unknown as ChatMessage;
    view.rerender(graph.chatWith([question, answer, next], 'ready'));
    record();
    view.rerender(graph.chatWith([question, answer, next], 'submitted'));
    record();
    view.rerender(graph.chatWith([question, answer, next], 'ready'));
    record();
    await act(async () => { graph.release(); await graph.preloadMarkdown(); });
    record();
    observer.disconnect();
    expect(seen).toEqual([['skeleton', 'markdown'], ['skeleton', 'markdown'], ['skeleton', 'markdown']]);
  }, GRAPH_TIMEOUT);

  it('a running-turn bubble keeps the raw text when the turn stops or pauses before the renderer loaded', async () => {
    const graph = await freshGraph();
    const { container, rerender } = (() => {
      const box = document.createElement('div');
      document.body.appendChild(box);
      const view = render(graph.chatWith(streamingHistory, 'streaming'), { container: box });
      return { container: box, rerender: view.rerender };
    })();
    const states = () => [...container.querySelectorAll('[data-component="markdown"]')].map(stateOf);
    expect(states()).toEqual(['skeleton', 'source', 'source']);
    for (const status of ['ready', 'submitted', 'error', 'ready'] as const) {
      rerender(graph.chatWith(streamingHistory, status));
      expect(states(), status).toEqual(['skeleton', 'source', 'source']);
    }
    await act(async () => { graph.release(); await graph.preloadMarkdown(); });
    expect(states()).toEqual(['markdown', 'markdown', 'markdown']);
  }, GRAPH_TIMEOUT);

  it('a tool-only answer of the running turn keeps its raw summary like other running-turn text', async () => {
    const graph = await freshGraph();
    const toolAnswer = {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'tool-search', toolCallId: 't1', state: 'output-available', input: {}, output: { message: 'Found **2** items' } }],
    } as unknown as ChatMessage;
    const { container } = mount(graph.chatWith([streamingHistory[1]!, toolAnswer], 'streaming', { toolResults: { mode: 'default' } }));
    const boxes = [...container.querySelectorAll('[data-component="markdown"]')];
    expect(boxes.map(stateOf)).toEqual(['source', 'source']);
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

describe('message part nodes keep their shape', () => {
  it('a text node is the Markdown element with the same props as before; cloneElement still applies', async () => {
    const graph = await freshGraph();
    const { useMessageParts } = await import('../message-bubble.js');
    let text: ReactNode = null;
    let entryNode: ReactNode = null;
    function Own({ message }: { message: ChatMessage }) {
      const parts = useMessageParts(message);
      text = parts.text;
      entryNode = parts.parts.find((entry) => entry.kind === 'text')?.node ?? null;
      return <div data-own>{isValidElement(entryNode) ? cloneElement(entryNode as ReactElement<{ className?: string }>, { className: 'own' }) : null}</div>;
    }
    const { AiChatProvider } = await import('../../provider/ai-chat-provider.js');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of ['ready', 'streaming'] as const) {
      const latest = streamingHistory[2]!;
      const { container } = mount(
        <AiChatProvider transport={{ messages: streamingHistory, status, error: null, sendMessage: async () => {}, stop() {}, setMessages() {}, addToolApprovalResponse: async () => {} }}>
          <Own message={latest} />
        </AiChatProvider>,
      );
      expect(isValidElement(entryNode)).toBe(true);
      const node = entryNode as unknown as ReactElement<Record<string, unknown>>;
      expect(typeof node.type).toBe('function');
      expect((node.type as { name?: string }).name).toBe('DefaultMarkdown');
      expect(node.props, status).toEqual({ content: 'Streaming **now**' });
      expect(text).not.toBeNull();
      expect(container.querySelector('[data-component="markdown"]')?.className).toBe('own');
      mount(<div {...node.props} />);
      cleanup();
    }
    expect(errors).not.toHaveBeenCalled();
    void graph;
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
