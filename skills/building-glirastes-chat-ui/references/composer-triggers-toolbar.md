# Composer triggers and toolbar

All names below come from `glirastes/react` unless noted.

## Contents

- Triggers
  - Sent mentions and `types`
- What a pick does

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
| `select` | `'chip'` | Default pick behavior of its items (`CompletionSelectKind`, see below) |
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

## What a pick does

`select` on a `CompletionItem` (or on `MentionResult`) sets what picking it
does; without it the trigger's `select` applies, default `chip`.

| `select` | Pick result |
| --- | --- |
| `chip` | A pill, as before |
| `text` | `insertText` (default: the label) replaces trigger and query as plain text; caret behind it, list closes |
| `run` | A pill, then sends exactly like the send button. While a turn streams nothing is sent and the pill stays |
| `list` | The trigger stays, the query is cleared, and the list shows the providers in `listSource` (provider id or ids of the same trigger). Typing searches only them until the list closes (Escape) |

```tsx
const prompts = {
  id: 'prompts',
  trigger: '/',
  search: () => [
    { id: 'summary', type: 'prompt', label: 'Zusammenfassen', select: 'text', insertText: 'Fasse den Auftrag zusammen' },
    { id: 'more', type: 'prompt', label: 'Vorlagen', select: 'list', listSource: 'templates' },
  ],
};
```

A prompt template as `select: 'text'` replaces rewriting a chip into text in
`onBeforeSend`: the user sees and edits the text before sending. Items of a
`list` sub-list need their own `select` when the trigger default is `list`.

`onCompletionSelect(item, { trigger, query, controls })` (`CompletionSelectContext`) on the provider runs
before the built-in behavior; `controls` is the composer
(`ChatComposerInputControls`: `setText`, `submit`, `focus`, …). Return `true`
when the app handled the pick: the list closes and trigger and query stay in
the editor. A standalone `RichMentionInput` takes `onCompletionSelect` with
`{ trigger, query }` only, and its `onSearch` receives a third argument
`{ source }` after a `list` pick; forward it to the search of
`createCompletionSearch`. An item with an unknown `select`, an empty
`insertText` or an invalid `listSource` id is dropped from the list.
