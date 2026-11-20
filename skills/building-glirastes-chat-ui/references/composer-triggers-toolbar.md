# Composer triggers and toolbar

All names below come from `glirastes/react` unless noted.

## Contents

- Triggers

## Triggers

A trigger is the character that opens a completion list in the composer.
`@` and `/` always do. Any other single character works as soon as a
provider uses it:

```tsx
const providers = useMemo(() => [{
  id: 'tickets',
  trigger: '#',
  search: ({ query, signal }) => searchTickets(query, signal),
}], []);

<AiChatProvider completionProviders={providers} />
```

Typing `#bug` opens the list with that provider's items; picking one inserts
a pill shown as `#Bug 7`. A trigger char inside a word (`mail#x`, `mail@host`)
opens nothing.

`triggers` on the provider (memoized, `ChatTriggerDefinition[]`) describes a
char further:

| Field | Default | Meaning |
| --- | --- | --- |
| `char` | required | Exactly one character, not whitespace |
| `label` | none | Name of the trigger in composer menus |
| `prefix` | `char` | Visible prefix of a picked pill, non-empty, no whitespace |
| `select` | `'chip'` | Default pick behavior (`CompletionSelectKind`); today every kind inserts a pill |

```tsx
const triggers = useMemo(() => [{ char: '#', label: 'Tickets', prefix: '#' }], []);
<AiChatProvider completionProviders={providers} triggers={triggers} />
```

- A provider's char without a definition gets `{ prefix: char, select: 'chip' }`.
- An explicit definition wins, also for `@` and `/`. A `/` command pill keeps
  the `/` prefix and command styling; other pills use the entity style.
- An invalid `char`, an empty `prefix`, an unknown `select` or two
  definitions of one char throw when the provider renders.
- `resolveChatTriggers(triggers, providers)` returns the resolved list
  (`ResolvedChatTrigger[]`, defaults filled in); the composer reads it from the
  chat context (`useChatComposerInput().inputProps.triggers`).
- `createCompletionSearch(providers)(query, trigger, { source })` asks only
  the providers whose ids are in `source` (a string or an array,
  `CompletionSearchQueryOptions`).
- A standalone `RichMentionInput` takes `triggers` as chars or definitions
  (default `['@', '/']`), e.g. `['@', { char: '#', prefix: 'tag:' }]`.
- The wire format is unchanged (`{{mention:type:id:label}}`): sent messages
  and stored chats show a non-command mention with `@`, whatever char picked it.
- The legacy `mentions` search (without `completionProviders`) stays `@` and `/` only.
