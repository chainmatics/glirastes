# Composer hint, starters, clarification chips and drafts

All names below come from `glirastes/react`. Each feature is one line of
`composer` config on `AiChatProvider`; without it the composer renders as
before.

## Contents

- Hint line

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
