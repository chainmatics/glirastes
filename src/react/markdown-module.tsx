// The one dynamic import of react-markdown, shared by the `lazy` default
// Markdown renderer and `preloadMarkdown()`. It keeps react-markdown out of the
// synchronous import graph so server-only consumers don't pay for it, and
// gracefully degrades to raw text when the optional peer dep isn't installed.
type MarkdownModule = typeof import('react-markdown');

type LoadedModule = { default: MarkdownModule['default'] };

let markdownModule: Promise<LoadedModule> | undefined;
let loaded: LoadedModule | undefined;
let preloaded: Promise<void> | undefined;

/** The cached import (started on the first call); never rejects. */
export function loadMarkdownModule(): Promise<LoadedModule> {
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
  })().then((module) => (loaded = module));
  return markdownModule;
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
