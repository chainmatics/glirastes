// The one dynamic import of react-markdown, shared by the `lazy` default
// Markdown renderer and `preloadMarkdown()`. It keeps react-markdown out of the
// synchronous import graph so server-only consumers don't pay for it, and
// gracefully degrades to raw text when the optional peer dep isn't installed.
type MarkdownModule = typeof import('react-markdown');

let markdownModule: Promise<{ default: MarkdownModule['default'] }> | undefined;
let preloaded: Promise<void> | undefined;

/** The cached import (started on the first call); never rejects. */
export function loadMarkdownModule(): Promise<{ default: MarkdownModule['default'] }> {
  markdownModule ??= (async () => {
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
  })();
  return markdownModule;
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
