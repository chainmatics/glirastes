# Composer hint, starters, clarification chips and drafts

All names below come from `glirastes/react`. Each feature is one line of
`composer` config on `AiChatProvider`; without it the composer renders as
before.

## Contents

- Hint line
- Starters
- Clarification chips
- Drafts

## Hint line

`composer: { hint: true }` shows a keyboard hint under the composer:
"↵ Send · ⇧ ↵ New line", and while a completion list is open
"↑ ↓ Navigate · ↵ Pick suggestion · Esc Close" (also for a list opened by
`openCompletion` or a "+" menu row). It is `aria-hidden` (the keys are the
textbox's own, and an open list announces itself) and hidden on touch
devices (`@media (hover: none) and (pointer: coarse)`). Default `false`.

```tsx
<AiChatProvider transport={transport} composer={{ hint: true }}>
```

- Texts: `locale.composerHintSend`, `composerHintNewline`,
  `composerHintNavigate`, `composerHintPick`, `composerHintClose` (German in
  `deChatLocale`).
- Own composer on `useChatComposerInput()`: render
  `<ComposerHint completionOpen={composer.completionOpen} />` where the hint
  should go. `completionOpen` follows `RichMentionInput`'s
  `onListOpenChange`, which `composer.inputProps` already wires.
- Markup: `[data-component="composer-hint"]` with
  `[data-hint="compose"]` or `[data-hint="completion"]` and `<kbd>` keys.

## Starters

`composer.starters` shows starter chips above the composer while the chat
has no messages (a string is `{ label }`, else a `ChatStarter`: `label`,
`prompt` (default `label`), `description` (the chip's `title`), `icon`,
`send`). They go away with the first message.

```tsx
const composer = useMemo<ComposerConfig>(() => ({
  starters: [
    { label: 'Zusammenfassen', prompt: 'Fasse den Auftrag zusammen', icon: 'file-text' },
    { label: 'Was ist neu?', send: true },
  ],
  renderIcon: (name) => <Icon name={name} />,
}), []);
```

- A click puts `prompt` into the composer (after text already there, like
  `useChatComposer().insertText`) and focuses it; nothing is sent, the user
  can still edit. `send: true` sends the prompt at once.
- The chips are disabled while the composer is locked (a turn streams
  without `queue.enabled`, an approval or a command form is open).
- Page-aware starters: build the list with `useMemo` from app state (route,
  selected record); the provider reads the current `composer`.
- While starters show, `suggestions.staticChips` are hidden; they come back
  after the first message.
- String icons render through `composer.renderIcon(name, { type: 'starter' })`.
- Own panel: render `<ChatStarters />` above the composer. Markup:
  `[data-component="chat-starters"][role="group"]` (name
  `locale.startersLabel`, `Suggestions` / `Vorschläge`) with
  `button[data-element="starter"]`.

## Clarification chips

`composer: { clarificationChips: true }` shows the options of an open
clarification (the model's `ask_clarification`) as chips above the
composer. The card in the message keeps the question and the free-text
answer, without its option buttons (`ClarificationCardProps.showOptions`
is `false`; a custom `components.ClarificationCard` should honor it).
Default `false`.

- A chip sends the same answer message as the card's option button, so the
  original request resumes.
- No chips while a turn runs, once the clarification is answered (a chip,
  the card or any typed message) or when it has no options (free text only).
- Disabled while the composer is locked.
- Own panel: render `<ClarificationChips />` above the composer. Markup:
  `[data-component="clarification-chips"][role="group"]` (name
  `locale.clarificationChipsLabel`, `Answer options` / `Antwortmöglichkeiten`)
  with `button[data-element="option"][data-option-id]`, `title` = the
  option's description.

## Drafts

The composer's unsent text belongs to its chat (no config needed):

- Switching chats shows the unsent text of the chat you switch to (empty
  when it has none); the text of the chat you left waits there. It is no
  longer carried over into the next chat.
- The text survives a remount of the input (closing and reopening the chat
  window, moving the panel) inside the same `AiChatProvider`.
- Pills stay pills (same ids). Attachments are never part of a draft.
- A sent message clears the draft. An `initialValue` applies only when the
  chat has no draft.
- Drafts live in the provider instance: when the app remounts the provider
  for another user (it should, with a new `key` per verified identity), the
  drafts of the previous user are gone.
- `ComposerDraft` (`{ text, mentions? }`) is the stored shape.
- Works for the pill composer and the plain input; the legacy `mentions`
  input has no drafts.

### Drafts across reloads

With `createLocalSessionStore` the drafts also survive a reload:

- Stored in the same browser storage and key prefix as the chats:
  `${storageKey}:draft:<chatId>`, JSON `{ text, mentions }`. Attachments
  are never stored.
- Written at most every 300 ms, on a chat switch, on `pagehide` and when the
  provider unmounts. A draft over 20,000 characters stays in memory only
  (the stored one is removed, so no older version comes back).
- Gone once sent, emptied, or when its chat is removed, cleared or evicted
  (`maxSessions`); `clearLocalSessionStore` on sign-out removes them with the
  chats. Include the user in `storageKey`, as for the chats.
- `drafts: false` keeps drafts in memory only.
- A draft read from storage after the user already typed in that chat is
  dropped; what is typed wins.
- Own `SessionConfig` stores (server-backed) can add
  `draft: ComposerDraftStorage` with `load(id)` and `save(id, draft | null)`
  (`null` removes it). Errors from either are ignored; the draft then lives
  in memory only.
