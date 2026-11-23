import { useSyncExternalStore } from 'react';

// react-markdown loads lazily: it stays out of the synchronous import graph, so
// server-only consumers don't pay for it, and the chat degrades to plain text
// when the optional peer dependency isn't installed.
export type MarkdownRenderer = typeof import('react-markdown')['default'];
type MarkdownImporter = () => Promise<{ default: MarkdownRenderer }>;

/**
 * `idle`: not asked for yet; `failed`: the import failed (an explicit
 * `preloadMarkdown()` retries once). `hydrating` is what a component sees
 * while React hydrates server HTML on the client.
 */
export type MarkdownRendererStatus = 'idle' | 'loading' | 'loaded' | 'failed';

/** How long a Markdown block waits for the renderer before it shows the plain text instead (client only). */
export const MARKDOWN_LOAD_WAIT_MS = 3000;

const defaultImporter: MarkdownImporter = () => import('react-markdown');

let status: MarkdownRendererStatus = 'idle';
let renderer: MarkdownRenderer | null = null;
let loading: Promise<void> | null = null;
let retried = false;
let importer: MarkdownImporter = defaultImporter;
let waitMs = MARKDOWN_LOAD_WAIT_MS;
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function startLoad(): Promise<void> {
  loading = importer()
    .then((mod) => {
      if (typeof mod?.default !== 'function') throw new Error('react-markdown has no default export');
      renderer = mod.default;
    })
    .then(
      () => {
        status = 'loaded';
        notify();
      },
      () => {
        if (typeof console !== 'undefined') {
          console.warn(
            '[MessageBubble] react-markdown could not be loaded — showing plain text. Install it with: npm install react-markdown',
          );
        }
        status = 'failed';
        notify();
      },
    )
    .catch(() => {});
  return loading;
}

/** Loads the renderer once (client and server); the same promise every time; never rejects. */
export function loadMarkdown(): Promise<void> {
  if (loading) return loading;
  if (status === 'idle') status = 'loading';
  return startLoad();
}

/**
 * Starts loading the default Markdown renderer (react-markdown) and resolves
 * once it has loaded or failed to load. `AiChatProvider` calls it when it
 * mounts, unless the app sets `components.Markdown` or
 * `components.MessageBubble`; call it earlier (for example when the chat
 * button appears) to have it ready sooner, or on the server before
 * `renderToString` to have the Markdown in that HTML. Every call returns the
 * same promise, also on the server. Never rejects: when the import fails the
 * chat shows messages as plain text, and the next call of `preloadMarkdown()`
 * tries once more.
 */
export function preloadMarkdown(): Promise<void> {
  if (status === 'failed' && !retried) {
    retried = true;
    return startLoad();
  }
  return loadMarkdown();
}

/**
 * Resolves when the renderer has loaded or failed, on the client also after
 * `MARKDOWN_LOAD_WAIT_MS` (a stalled chunk); never rejects. The server waits
 * for the import, as server rendering did before.
 */
export function waitForMarkdown(): Promise<void> {
  const load = loadMarkdown();
  if (typeof window === 'undefined' || status === 'loaded' || status === 'failed') return load;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    void load.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function markdownStatus(): MarkdownRendererStatus {
  return status;
}

export function markdownRenderer(): MarkdownRenderer | null {
  return status === 'loaded' ? renderer : null;
}

/** Changes when tests reset the loader, so the lazy block is made anew. */
export function markdownLoaderGeneration(): number {
  return generation;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getStatus = (): MarkdownRendererStatus | 'hydrating' => status;
// The server renders with the real state. On the client this is only read
// while React hydrates server HTML: the block then keeps that HTML until the
// renderer is there, instead of replacing it.
const getServerStatus = (): MarkdownRendererStatus | 'hydrating' => (typeof window === 'undefined' ? status : 'hydrating');

/** The renderer's state for a component; `hydrating` while React hydrates on the client. */
export function useMarkdownStatus(): MarkdownRendererStatus | 'hydrating' {
  return useSyncExternalStore(subscribe, getStatus, getServerStatus);
}

/** Tests only (not exported from `glirastes/react`): fresh state, an own importer and wait. */
export function resetMarkdownLoaderForTests(options: { importer?: MarkdownImporter; timeoutMs?: number } = {}): void {
  status = 'idle';
  renderer = null;
  loading = null;
  retried = false;
  importer = options.importer ?? defaultImporter;
  waitMs = options.timeoutMs ?? MARKDOWN_LOAD_WAIT_MS;
  generation += 1;
  notify();
}
