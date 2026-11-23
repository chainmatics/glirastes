import { useEffect, useSyncExternalStore } from 'react';

// react-markdown loads lazily: it stays out of the synchronous import graph, so
// server-only consumers don't pay for it, and the chat degrades to plain text
// when the optional peer dependency isn't installed.
type MarkdownRenderer = typeof import('react-markdown')['default'];

/** `idle`: not asked for yet (always on the server); `failed`: the import failed, for good. */
export type MarkdownRendererStatus = 'idle' | 'loading' | 'loaded' | 'failed';

let status: MarkdownRendererStatus = 'idle';
let renderer: MarkdownRenderer | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function settle(next: MarkdownRendererStatus): void {
  status = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Starts loading the default Markdown renderer (react-markdown) and resolves
 * once it has loaded or failed to load. `AiChatProvider` calls it when it
 * mounts, unless `components.Markdown` is set; call it earlier (for example
 * when the chat button appears) to have it ready sooner. Idempotent: every
 * call returns the same promise. Never rejects: when the import fails the
 * chat shows messages as plain text. On the server it resolves at once and
 * loads nothing.
 */
export function preloadMarkdown(): Promise<void> {
  if (loading) return loading;
  if (typeof window === 'undefined') return Promise.resolve();
  status = 'loading';
  loading = import('react-markdown')
    .then((mod) => {
      if (typeof mod.default !== 'function') throw new Error('react-markdown has no default export');
      renderer = mod.default;
    })
    .then(
      () => settle('loaded'),
      () => {
        if (typeof console !== 'undefined') {
          console.warn(
            '[MessageBubble] react-markdown is not installed — falling back to plain text. Install it with: npm install react-markdown',
          );
        }
        settle('failed');
      },
    )
    .catch(() => {});
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getStatus = (): MarkdownRendererStatus => status;
// The server renders the placeholder; hydration renders it too, then the loaded state.
const getServerStatus = (): MarkdownRendererStatus => 'idle';

/** The renderer's state for the default `Markdown` slot; starts the import when nothing has yet. */
export function useMarkdownRenderer(): { status: MarkdownRendererStatus; Renderer: MarkdownRenderer | null } {
  const current = useSyncExternalStore(subscribe, getStatus, getServerStatus);
  useEffect(() => {
    if (current === 'idle') void preloadMarkdown();
  }, [current]);
  return { status: current, Renderer: current === 'loaded' ? renderer : null };
}
