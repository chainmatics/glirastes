# Composer hint, starters, clarification chips and drafts

All names below come from `glirastes/react`. Each feature is one line of
`composer` config on `AiChatProvider`; without it the composer renders as
before.

## Contents

- Hint line
- Starters

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
