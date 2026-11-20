# Composer triggers and toolbar

All names below come from `glirastes/react` unless noted.

## Contents

- Triggers
  - Sent mentions and `types`

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
| `types` | none | The mention item types the trigger owns, e.g. `['ticket']`; sent mentions of these types show `prefix` |

```tsx
const triggers = useMemo(() => [{ char: '#', label: 'Tickets', types: ['ticket'] }], []);
<AiChatProvider completionProviders={providers} triggers={triggers} />
```

- A provider's char without a definition gets `{ prefix: char, select: 'chip' }`.
- An explicit definition wins, also for `@` and `/`. A `/` command pill keeps
  the `/` prefix and command styling; other pills use the entity style.
- An invalid `char`, an empty `prefix`, an unknown `select`, two
  definitions of one char or one type in two triggers' `types` throw when the
  provider renders. `command` cannot be claimed; commands always show `/`.
- `resolveChatTriggers(triggers, providers)` returns the resolved list
  (`ResolvedChatTrigger[]`, defaults filled in); the composer reads it from the
  chat context (`useChatComposerInput().inputProps.triggers`).
- `createCompletionSearch(providers)(query, trigger, { source })` asks only
  the providers whose ids are in `source` (a string or an array,
  `CompletionSearchQueryOptions`).
- A standalone `RichMentionInput` takes `triggers` as chars or definitions
  (default `['@', '/']`), e.g. `['@', { char: '#', prefix: 'tag:' }]`, and
  throws on an invalid entry like the provider.
- `useChatComposerInput().inputProps` always carries `triggers`: spread it
  before your own `triggers` prop if you set one.
- The legacy `mentions` search (without `completionProviders`) stays `@` and `/` only.

### Sent mentions and `types`

The wire format (`{{mention:type:id:label}}`) carries no prefix. The sent
bubble, restored history and `MentionChip` look the prefix up by type through
the chat context (`mentionPrefix`): a type in a trigger's `types` shows that
trigger's `prefix`, `command` shows `/`, any other type `@`. Without `types`
nothing changes. Chat titles in the switcher come from the store, so pass
the same array there: `createLocalSessionStore({ storageKey, triggers })`
names a chat `#Bug 7 …` instead of `@Bug 7 …`.
