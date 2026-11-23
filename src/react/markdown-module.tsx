// The one dynamic import of react-markdown, shared by the `lazy` default
// Markdown renderer and `preloadMarkdown()`. It keeps react-markdown out of the
// synchronous import graph so server-only consumers don't pay for it, and
// gracefully degrades to raw text when the optional peer dep isn't installed.
type MarkdownModule = typeof import('react-markdown');

type LoadedModule = { default: MarkdownModule['default'] };

let markdownModule: Promise<LoadedModule> | undefined;
let loaded: LoadedModule | undefined;
let preloaded: Promise<void> | undefined;
/** `Date.now()` when the import started. */
let startedAt: number | undefined;

/** The cached import (started on the first call); never rejects. */
export function loadMarkdownModule(): Promise<LoadedModule> {
  startedAt ??= Date.now();
  markdownModule ??= (async (): Promise<LoadedModule> => {
    try {
      const mod = await import('react-markdown');
      return { default: mod.default };
    } catch {
      if (typeof console !== 'undefined') {
        console.warn(
          '[MessageBubble] react-markdown is not installed — falling back to plain text. Install it with: npm install react-markdown',
        );
      }
      const Fallback: MarkdownModule['default'] = (({ children }) => (
        <>{typeof children === 'string' ? children : ''}</>
      )) as MarkdownModule['default'];
      return { default: Fallback };
    }
  })().then((module) => {
    loaded = module;
    for (const waiter of waiters.values()) stopTimer(waiter);
    return module;
  });
  return markdownModule;
}

/**
 * Time limit for the skeleton: per limit (in ms) one shared timer, counted
 * from the start of the import, running only while a bubble shows the
 * skeleton and the import is pending. Browser only (started on subscribe).
 */
interface Waiter { fired: boolean; timer?: ReturnType<typeof setTimeout>; listeners: Set<() => void> }
const waiters = new Map<number, Waiter>();

function stopTimer(waiter: Waiter): void {
  if (waiter.timer !== undefined) clearTimeout(waiter.timer);
  waiter.timer = undefined;
}

/** Whether the import is still pending `ms` after it started (decided when a bubble first renders). */
export function markdownOverdue(ms: number): boolean {
  return !loaded && startedAt !== undefined && Date.now() - startedAt >= ms;
}

/** Whether the shared timer for `ms` has fired. */
export function markdownTimedOut(ms: number): boolean {
  return waiters.get(ms)?.fired === true;
}

/** Calls `listener` once the import is still pending `ms` after it started. */
export function subscribeMarkdownTimeout(ms: number, listener: () => void): () => void {
  if (loaded) return () => {};
  let waiter = waiters.get(ms);
  if (!waiter) {
    waiter = { fired: false, listeners: new Set() };
    waiters.set(ms, waiter);
  }
  const current = waiter;
  current.listeners.add(listener);
  if (!current.fired && current.timer === undefined) {
    const delay = Math.max(0, (startedAt ?? Date.now()) + ms - Date.now());
    current.timer = setTimeout(() => {
      current.timer = undefined;
      current.fired = true;
      for (const notify of [...current.listeners]) notify();
    }, delay);
    // Never keeps a Node process alive.
    (current.timer as { unref?: () => void }).unref?.();
  }
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) stopTimer(current);
  };
}

/**
 * Factory for `lazy`: once the shared import has resolved, a thenable that
 * calls back synchronously, so React's `lazy` resolves without suspending
 * (a resolved promise only calls back in a microtask, after React suspended).
 */
export function markdownModuleForLazy(): Promise<LoadedModule> {
  if (!loaded) return loadMarkdownModule();
  const module = loaded;
  // React's lazy only calls `then`; the type asks for a full Promise.
  const resolvedNow: PromiseLike<LoadedModule> = { then: (onFulfilled) => onFulfilled?.(module) as never };
  return resolvedNow as Promise<LoadedModule>;
}

/**
 * Starts loading the default Markdown renderer (react-markdown) of the chat
 * bubbles now instead of when the first message renders. `AiChatProvider`
 * calls it when it mounts (unless the app sets `components.Markdown` or
 * `components.MessageBubble`); call it earlier, e.g. at app start, to have it
 * ready sooner. Every call returns the same promise; it never rejects (without
 * react-markdown the chat shows plain text, as before) and is safe on the server.
 */
export function preloadMarkdown(): Promise<void> {
  preloaded ??= loadMarkdownModule().then(() => undefined);
  return preloaded;
}
