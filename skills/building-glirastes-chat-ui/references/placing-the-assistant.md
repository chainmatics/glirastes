# Placing the assistant

The default for an app with its own layout: an "Ask AI" button where the app
wants it (usually the top bar), and the chat docked on the right of the page
or detached as a window the user moves and resizes. `AssistantWorkspace` is
that whole integration in one component; `VercelAiChat` with children supplies
the chat and drops its own floating widget:

```tsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import { AiChatPanel, AssistantToggle, AssistantWorkspace } from 'glirastes/react';
import 'glirastes/react/styles.css';

export function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <VercelAiChat endpoint="/api/chat">
      <AssistantWorkspace chat={<AiChatPanel />} storageKey={`assistant:${userId}`}>
        <header>… <AssistantToggle /></header>
        {children}
      </AssistantWorkspace>
    </VercelAiChat>
  );
}
```

The workspace is a row that fills its parent (page left, assistant right); the
parent needs a height (`html, body { height: 100dvh }` or a full-height frame),
or the assistant is only as tall as the page. It folds to a rail, takes the
whole row on narrow screens, and publishes its width as
`--assistant-right-inset` for fixed elements. Detaching or docking is remembered, so a closed
window reopens as a window. `defaultMode="floating"` opens detached first.

- Toggle anywhere: `AssistantToggle` works at any depth inside the workspace;
  `useAssistantLayout()` gives `openChat`, `closeChat`, `setMode` and the
  state for the app's own controls.
- Shortcuts on every OS: mod+I toggles, alt+shift+D docks or detaches,
  alt+shift+C collapses, alt+shift+N starts a new chat (when the chat keeps several, or `onNewChat`),
  alt+shift+I focuses the input. Pass `shortcuts={{ newChat: 'alt+shift+k',
  toggleCollapse: false }}` when the app already uses one; `formatShortcut`
  shows a combination as ⌘I or Ctrl+I. `assistantShortcutList({ shortcuts,
  language })` gives the active ones with labels (German ships) for the
  app's shortcut overview.
- Look: `icons`, `labels` (`DE_ASSISTANT_SHELL_LABELS` ships German),
  `classNames`, `renderButton` for the app's own button component, the
  `headerStart` / `headerTitle` / `headerActions` slots, `window` for the
  size limits of the detached window, and `showBubble={false}` to drop the
  round opener. With the provider's `unstyled` only the handle geometry stays.
- Own layout: `AssistantLayoutProvider` + `AssistantShell` are the parts the
  workspace is made of. The shell is then the last child of the row that
  holds the page, marked `data-assistant-main`. An existing provider higher
  up is reused by the workspace.
- Scope `storageKey` per user when several people share a browser.
