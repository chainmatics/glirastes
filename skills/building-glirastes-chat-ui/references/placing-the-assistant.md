# Placing the assistant

## Contents

- Workspace
- Layouts and full screen
- History column
- Replacing shell parts
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
composer). `historyPane={false}` removes the column, `null` keeps the default
list, any other node replaces it:

```tsx
<AssistantWorkspace chat={<AiChatPanel />} modes={['sidebar', 'floating', 'fullscreen']}
  historyPane={<MyProjectsPane />}>
```

Labels `history`, `showHistory`, `hideHistory`, icon `history`. For an own
column elsewhere render `<SessionSwitcher variant="list" onSelect={close} />`
(new chat, recent chats newest first, rename, delete, arrow keys); `onSelect`
runs after a pick or a new chat. Texts come from the chat locale:
`chatHistoryLabel` (navigation name) and `recentChatsLabel` (heading).

## Replacing shell parts

Every part below is opt-in; an app that sets none of them gets the same DOM,
behaviour and styles as before.

- Layout menu (only with `'fullscreen'` among several `modes`):
  `showModeMenu={false}` drops the menu and its key handling (Enter, Space,
  arrow keys on `[data-element="mode-picker"]`); full screen stays a layout:
  the app enters it with `setMode('fullscreen')`, alt+shift+D, Escape and
  `restoreMode()` leave it; detach/dock do not come back.
  `renderModeMenu` draws the app's own control in its place, also without the
  built-in key handling. It gets `{ modes, current, setMode, label, title,
  entries }` (`AssistantModeMenuRenderProps`; `entries[mode]` is an
  `AssistantModeMenuEntry` with `label` and `icon`, `title` carries the
  layout shortcut). `modes` and `setMode` keep their identity between renders;
  `entries` does as long as the `labels` strings and the `icons` elements the
  app passes do (inline JSX icons are new elements every render). The app's
  control owns its keyboard and a11y (e.g. `aria-haspopup`). Its Escape
  handler calls `event.preventDefault()` and `event.stopPropagation()`, or the
  full-screen modal sees the same Escape and leaves full screen. A menu it
  portals out of the shell needs `data-cm-keep-interactive` to stay usable in
  full screen.
- Own chat column that closes the drawer: pass `historyPane` as a function.
  It gets `{ open, drawer, close }` (`AssistantHistoryPaneProps`): `open` is
  whether the column is shown, `drawer` whether it is the drawer below 900 px,
  `close()` closes the drawer like a pick in the built-in list and moves focus
  to the composer (next point), `close('toggle')` gives focus back to the chats
  toggle (as Escape does). In the wide column `close()` only moves focus.
  `close` keeps its identity between renders; called after the column is gone
  (full screen was left) it does nothing. A function always gives a column,
  also when the chat keeps only one conversation.

  ```tsx
  <AssistantWorkspace chat={<AiChatPanel />} modes={['sidebar', 'floating', 'fullscreen']}
    historyPane={({ close }) => <MyProjectsPane onPick={close} />}>
  ```
- The drawer's dialog name and the toggle's names stay `labels.history`,
  `labels.showHistory` and `labels.hideHistory` ("Chats", "Show chats", "Hide
  chats"); an app whose column shows something else (projects, folders) sets
  those labels too.
- Focus after `close()` of a function `historyPane` / `historyTitle`: the
  first editor (`contenteditable`) or `textarea` of the shell in DOM order,
  header included but never one in the column, gets `focus()`, also a disabled
  one (then focus stays where it was). Only when there is none: an element in
  the conversation marked
  `data-glirastes-composer` (when it is a text input or focusable itself), else
  the first enabled, editable text input inside it, else the chats toggle;
  when nothing takes focus it stays where it is. That input fallback never
  takes other inputs of the conversation (a clarification answer, a command
  form); the kept first step still focuses the first editor or `textarea` in
  DOM order, which can be a queued message's edit field above the composer.
  The shell does not look into a shadow root of
  its own inside the marked element: mark the focusable host (`tabIndex`,
  `delegatesFocus`). This lookup belongs to `close()` only: a pick in the
  built-in chat list, opening the assistant and the focus-input shortcut
  (alt+shift+I) look only for an editor or a `textarea` in the shell and
  otherwise focus the first button of the shell; the mark does not change
  them.
- Render functions (`historyPane`, `historyTitle`, `renderModeMenu`) are
  rendered as components of their own, so hooks inside them belong to that
  part, and they run while their part is rendered: the column functions
  whenever the shell is in full screen, also while the column is hidden or the
  drawer closed (`open: false`); `renderModeMenu` while the layout menu is
  shown. Pass a stable function
  (or the same one every render); it is not remounted when its identity
  changes, so switching between different functions that use hooks reuses or
  breaks their state. To switch between panes, switch inside one function and
  render components from it:
  `historyPane={() => route === 'projects' ? <ProjectsPane /> : <FoldersPane />}`.
  State lives while the part stays rendered: the column keeps it when its
  toggle hides it and starts fresh after leaving full screen; the layout menu
  starts fresh when `showModeMenu` or `modes` take it away and give it back.
- Heading of the column: `historyTitle` replaces
  `[data-element="history-title"]` with a node, or a function with the same
  argument (e.g. a close button in the drawer); `false` drops it, `null` keeps
  the default. `classNames.history` sets a class on the column,
  `classNames.historyBackdrop` on the drawer's backdrop. The shipped
  backdrop color comes from a rule of specificity (0,2,0)
  (`[data-component="assistant-shell"] … [data-element="history-backdrop"]`),
  so a single class (0,1,0) does not override it: use a selector of at least
  (0,2,0) loaded after `styles.css` (e.g. `.my-backdrop.my-backdrop` or
  `[data-element="history-backdrop"].my-backdrop`), or the provider's
  `unstyled`. There is no CSS variable for it.
- Column and drawer states, stable for app CSS and tests (on
  `[data-element="history"]`; the toggle values apply to the built-in
  toggle `[data-action="history"]`; an app `renderButton` sets the attributes
  of its own button from `expanded` and `controls`):
  - wide column shown: no `data-drawer`, no `hidden`; toggle
    `aria-expanded="true"`;
  - wide column hidden by its toggle: `hidden` and `inert`; toggle
    `aria-expanded="false"`;
  - drawer closed (below 900 px): `data-drawer="true"`, `hidden`, `inert`, no
    `role`; no backdrop;
  - drawer open: `data-drawer="true"`, `role="dialog"`, `aria-modal="true"`,
    named after `labels.history`; `[data-element="history-backdrop"]` exists
    only now; the conversation (`[data-element="frame"]`) is `inert`.
  Select the drawer with `[data-element="history"][data-drawer]` and the open
  one with `:not([hidden])`.
- After `close('toggle')`, Escape or the backdrop closes the drawer, focus is
  on the chats toggle. An app `renderButton` that opens a tooltip on focus
  shows it then, and that tooltip catches the next Escape (which would
  otherwise leave full screen); open tooltips on `:focus-visible` or hover
  only, or let Escape pass when the tooltip has nothing to close.
- Session icons: `icons.newChat`, `icons.rename` and `icons.delete` replace
  the "+" of new chat and the rename and delete icons in the shell's own
  session switchers (header and chat column). The default "+" stays the text
  character. Outside the shell pass `icons` (`SessionSwitcherIcons`) to
  `SessionSwitcher` directly; `DEFAULT_SESSION_SWITCHER_ICONS` has the shipped
  ones. The icons are decorative: the buttons keep their names from the chat
  locale (`newChatLabel`, `renameSessionAriaLabel`, `deleteSessionAriaLabel`).
  `newChat: false` drops the "+" element, other empty `newChat` values
  (`null`, `''`, `true`, `[]`) keep the "+"; empty `rename` and `delete` values
  (`false`, `null`, `''`, `true`, `[]`) keep the default icon, so an action
  button is never empty.
- Own session controls: `useSessionLock()` gives `{ visible, sessionChangeBlocked,
  locked }` (`SessionLockState`), the rule the built-in `SessionSwitcher`
  follows. `sessionChangeBlocked` is true while a reply streams, a UI action
  outcome is awaited or a session operation runs (`isSessionChangeBlocked` of
  the chat context; `isLoading` only for a context without it). `visible` is
  false while a surrounding `ChatWindow` is closed or collapsed; inside
  `AssistantShell` it is always true, use `useAssistantLayout().open` there.
  Disable switch, new, rename and delete while `locked`.

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
