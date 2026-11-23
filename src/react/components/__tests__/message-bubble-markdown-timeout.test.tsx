// @vitest-environment jsdom
import { StrictMode, act, type ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_TIMEOUT, MARKDOWN_SOURCE, freshGraph, type Graph } from './markdown-loading-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each test builds its own module graph (`freshGraph`, the import of
// react-markdown waits until `release()`), then switches to fake timers.

const stateOf = (container: Element) => {
  const box = container.querySelector('[data-component="markdown"]');
  if (!box) return 'none';
  if (box.querySelector('[data-state="loading"]')) return 'skeleton';
  if (box.querySelector('ul, strong')) return 'markdown';
  return box.textContent === MARKDOWN_SOURCE ? 'raw' : `other:${box.innerHTML}`;
};

/** Every state the Markdown block passes through, repeats collapsed. */
function timeline(container: Element) {
  const states: string[] = [];
  const record = () => {
    const state = stateOf(container);
    if (states[states.length - 1] !== state) states.push(state);
  };
  const observer = new MutationObserver(record);
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return { states, record, stop: () => { record(); observer.disconnect(); } };
}

function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const seen = timeline(container);
  const view = render(element, { container });
  seen.record();
  return { container, seen, unmount: view.unmount };
}

const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const loaded = async (graph: Graph) => {
  await act(async () => { graph.release(); await graph.preloadMarkdown(); });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
afterAll(() => {
  vi.doUnmock('react-markdown');
});

describe('react-markdown that does not arrive in time', () => {
  it('shows the raw text after 4 s by default, then Markdown when the import still arrives', async () => {
    const graph = await freshGraph();
    vi.useFakeTimers();
    const { container, seen } = mount(graph.chat());
    expect(stateOf(container)).toBe('skeleton');
    await advance(3_999);
    expect(stateOf(container)).toBe('skeleton');
    await advance(1);
    expect(stateOf(container)).toBe('raw');
    // The copy button copies the raw text, as before the skeleton.
    const bubble = container.querySelector('[data-component="message-bubble"]')!;
    expect(graph.messageClipboardContent(bubble, '').text).toBe(MARKDOWN_SOURCE.trim());
    await loaded(graph);
    seen.stop();
    expect(seen.states).toEqual(['skeleton', 'raw', 'markdown']);
    expect(vi.getTimerCount()).toBe(0);
  }, GRAPH_TIMEOUT);

  it('a failed import shows the plain text right away, as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = await freshGraph({ fail: true });
    vi.useFakeTimers();
    const { container } = mount(graph.chat());
    await act(async () => { await graph.preloadMarkdown(); });
    expect(stateOf(container)).toBe('raw');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }, GRAPH_TIMEOUT);

  it('markdown.loadingTimeoutMs sets the limit; false keeps the skeleton; 0 shows no skeleton', async () => {
    let graph = await freshGraph();
    vi.useFakeTimers();
    let view = mount(graph.chat({ markdown: { loadingTimeoutMs: 1_000 } }));
    await advance(999);
    expect(stateOf(view.container)).toBe('skeleton');
    await advance(1);
    expect(stateOf(view.container)).toBe('raw');
    cleanup();
    vi.useRealTimers();

    graph = await freshGraph();
    vi.useFakeTimers();
    view = mount(graph.chat({ markdown: { loadingTimeoutMs: false } }));
    await advance(60_000);
    expect(stateOf(view.container)).toBe('skeleton');
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
    vi.useRealTimers();

    graph = await freshGraph();
    vi.useFakeTimers();
    view = mount(graph.chat({ markdown: { loadingTimeoutMs: 0 } }));
    expect(view.seen.states).toEqual(['raw']);
    expect(vi.getTimerCount()).toBe(0);
  }, GRAPH_TIMEOUT);

  it('a bubble mounting after the limit has passed shows the raw text directly', async () => {
    const graph = await freshGraph();
    vi.useFakeTimers();
    mount(graph.chat({ withBubble: false })); // the provider starts the import
    await advance(5_000);
    const later = mount(graph.chat());
    expect(later.seen.states).toEqual(['raw']);
    await loaded(graph);
    later.seen.stop();
    expect(later.seen.states).toEqual(['raw', 'markdown']);
  }, GRAPH_TIMEOUT);

  it('a provider mounting later while the import is pending counts from the import start', async () => {
    const graph = await freshGraph();
    vi.useFakeTimers();
    mount(graph.chat({ withBubble: false }));
    await advance(2_500);
    const later = mount(graph.chat());
    expect(stateOf(later.container)).toBe('skeleton');
    await advance(1_500);
    expect(stateOf(later.container)).toBe('raw');
  }, GRAPH_TIMEOUT);

  it('leaves no timer behind after unmount', async () => {
    const graph = await freshGraph();
    vi.useFakeTimers();
    const view = mount(graph.chat());
    expect(stateOf(view.container)).toBe('skeleton');
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  }, GRAPH_TIMEOUT);

  it('works the same under StrictMode, with one shared timer', async () => {
    const graph = await freshGraph();
    vi.useFakeTimers();
    const view = mount(<StrictMode>{graph.chat()}{graph.chat()}</StrictMode>);
    expect(vi.getTimerCount()).toBe(1);
    await advance(4_000);
    expect([...view.container.querySelectorAll('[data-component="markdown"]')].map((box) => box.textContent)).toEqual([MARKDOWN_SOURCE, MARKDOWN_SOURCE]);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  }, GRAPH_TIMEOUT);
});
