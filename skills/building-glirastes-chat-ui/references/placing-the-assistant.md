# Placing the assistant

## Contents

- Workspace
- Layouts and full screen
- History column
- Width
- Shortcuts and look
- Own layout

## Workspace

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
whole row on narrow screens (`narrowWidth`, default 840), and publishes its
width as `--assistant-right-inset` for fixed elements. Detaching or docking is
remembered, so a closed window reopens as a window. `defaultMode="floating"`
opens detached first.

- Toggle anywhere: `AssistantToggle` works at any depth inside the workspace;
  `useAssistantLayout()` gives `openChat`, `closeChat`, `setMode`,
  `restoreMode` and the state for the app's own controls.
- Scope `storageKey` per user when several people share a browser.

## Layouts and full screen

`modes` lists the layouts the user can choose. The default
`['sidebar', 'floating']` keeps the detach/dock button. Add full screen:

```tsx
<AssistantWorkspace chat={<AiChatPanel />} modes={['sidebar', 'floating', 'fullscreen']}>
```

- The header then shows a layout menu (Sidebar, Window, Full screen; entries
  in the order of `modes`, arrow keys, Escape closes only the menu) instead of
  detach/dock. One entry (`modes={['sidebar']}`) removes the layout control
  and the layout shortcut. A stored layout outside `modes` falls back.
- Full screen is a modal: the shell (chat column and conversation) is
  `role="dialog" aria-modal="true"` named after `labels.title`, the page is inert and does not scroll, Tab
  stays inside. Escape (when no completion list, menu, rename or dialog owns
  it), `restoreMode()` and alt+shift+D return to `defaultMode`; mod+I closes,
  and the next opening uses `defaultMode` again. `setMode('fullscreen')` never
  becomes the opening layout; an open full screen survives a reload.
- Stacking: full screen sits at `--cm-chat-fullscreen-z` (default 1000).
  A UI action that shows page UI (navigation, an app dialog or drawer) calls
  `restoreMode()` first, or that UI sits above the variable. Page elements
  that exist before full screen opens (toaster or portal roots) become inert;
  mark the ones that must stay usable with `data-cm-keep-interactive`. Inside
  a transformed or `z-index`ed ancestor the shell cannot rise above the page
  around it; place it at the top of the layout.
- The conversation keeps a reading width: `--cm-chat-max-width` (default
  960px) in the app's CSS.
- `renderButton` also draws the layout trigger and the chat column toggle:
  `action: 'mode' | 'history'` with `expanded` and `controls` (map them to
  `aria-expanded` / `aria-controls`; `aria-haspopup="menu"` for `mode`).
- Labels `layout`, `sidebar`, `floating`, `fullscreen` and icon `fullscreen`
  (German ships in `DE_ASSISTANT_SHELL_LABELS`).

## History column

In full screen a chat that keeps several conversations gets a 260 px column
left of the conversation with `SessionSwitcher variant="list"`; the header
then names the open chat. A header button hides and shows the column. Below
900 px viewport width it is a drawer (`role="dialog"`, named after
`labels.history`): focus moves into it, the conversation is
inert, and Escape, the backdrop or a pick close it (a pick focuses the
composer). `historyPane={false}` removes the column, any node replaces it:

```tsx
<AssistantWorkspace chat={<AiChatPanel />} modes={['sidebar', 'floating', 'fullscreen']}
  historyPane={<MyProjectsPane />}>
```

Labels `history`, `showHistory`, `hideHistory`, icon `history`. For an own
column elsewhere render `<SessionSwitcher variant="list" onSelect={close} />`
(new chat, recent chats newest first, rename, delete, arrow keys); `onSelect`
runs after a pick or a new chat. Texts come from the chat locale:
`chatHistoryLabel` (navigation name) and `recentChatsLabel` (heading).

## Width

The docked assistant keeps its chosen width between `minWidth` and
`maxWidth`. `minPageWidth` (e.g. `480`) keeps that much of the row for the
page: the widest sidebar is then `min(maxWidth, row − minPageWidth)`, never
below `minWidth`, and the user's width comes back on wider windows. Below
`narrowWidth` the assistant still takes the whole row. The width handle
announces and stops at the widest width that can render.

## Shortcuts and look

- Shortcuts on every OS: mod+I toggles, alt+shift+D docks or detaches (and
  leaves full screen), alt+shift+C collapses, alt+shift+N starts a new chat
  (when the chat keeps several, or `onNewChat`), alt+shift+I focuses the
  input. Pass `shortcuts={{ newChat: 'alt+shift+k', toggleCollapse: false }}`
  when the app already uses one; `formatShortcut` shows a combination as ⌘I
  or Ctrl+I. `assistantShortcutList({ shortcuts, language })` gives the
  active ones with labels (German ships) for the app's shortcut overview.
- Look: `icons`, `labels` (`DE_ASSISTANT_SHELL_LABELS` ships German),
  `classNames`, `renderButton` for the app's own button component, the
  `headerStart` / `headerTitle` / `headerActions` slots, `window` for the
  size limits of the detached window, and `showBubble={false}` to drop the
  round opener. With the provider's `unstyled` only the handle geometry and
  the full-screen box stay.

## Own layout

`AssistantLayoutProvider` + `AssistantShell` are the parts the workspace is
made of. The shell is then the last child of the row that holds the page,
marked `data-assistant-main`, and takes the same `modes`, `historyPane` and
`minPageWidth`. An existing provider higher up is reused by the workspace.
