# Composer triggers and toolbar

All names below come from `glirastes/react` unless noted.

## Contents

- Triggers
  - Sent mentions and `types`
- What a pick does
- Opening a list from a button
- Toolbar
- Plus menu
- End-to-end example

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
  chat context. `useChatComposerInput().inputProps` carries `triggers` only when
  the list differs from the default `@` and `/` (an explicit definition or a
  provider with another char), so an input's own `triggers` prop still applies.
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
| `list` | The trigger stays, the query is cleared, and the list shows the providers in `listSource` (provider id or ids of the same trigger). Typing searches only them until the list closes (Escape). Without `listSource` the pick inserts a pill like `chip` |

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
`createCompletionSearch`. An unknown `select`, an empty `insertText` or an
invalid `listSource` id is left out of the item, which stays in the list with
the trigger's default pick. `onCompletionSelect` receives the normalized item
(`MentionResult`), not the provider's raw `CompletionItem`.

## Opening a list from a button

`openCompletion({ trigger, query?, source? })` (`OpenCompletionOptions`)
opens a list as if the user typed the trigger. Do not write the trigger into
the editor and dispatch a synthetic `InputEvent`.

```tsx
const composer = useChatComposerInput();
<RichMentionInput ref={composer.inputRef} {...composer.inputProps} />
<button type="button" onClick={() => composer.openCompletion({ trigger: '@', source: 'people' })}>
  Person
</button>
```

- It focuses the editor and inserts at the caret; when the editor had no
  focus, at the end. After a non-space it adds a space (`Hallo` → `Hallo @`).
- It searches `query` at once, without the typing debounce. `source` (a
  provider id or ids) limits the list until it closes, like a `list` pick.
- While the user has neither typed nor picked, closing the list (Escape,
  outside click, blur, or no results) removes exactly the inserted text and
  restores the caret; so do Enter before results show (nothing is sent) and
  an inserted mention (`insertMention`, `chatAbout`). Typing or a pick keeps it.
- A second call while untouched replaces the first one's text. An unknown
  trigger warns once in the console and does nothing.
- `useChatComposer().openCompletion` works from anywhere below
  `AiChatProvider` and waits until a composer is mounted, like `insertText`.
  `ChatComposerInputControls.openCompletion` is the same on the composer, and
  `RichMentionInputHandle.openCompletion` on a standalone input (optional on
  the handle type, so custom handles stay valid).

## Toolbar

`AiChatProvider` takes `composer` (`ComposerConfig`) to arrange the row of
`ChatInput` and `MentionInput`. `toolbar.start` renders before the editor,
`toolbar.end` after it. Ids are builtins (`ComposerToolbarBuiltin`) or keys of
`items`. Memoize the object.

```tsx
const composer = useMemo<ComposerConfig>(() => ({
  toolbar: { start: ['attach', 'templates'], end: ['trigger:@', 'mic', 'send'] },
  items: {
    templates: { label: 'Vorlagen', icon: <TemplateIcon />, onSelect: (c) => c.openCompletion({ trigger: '/', source: 'templates' }) },
  },
}), []);
<AiChatProvider composer={composer} triggers={[{ char: '@', label: 'Person erwähnen' }]} …>
```

- Default `{ start: ['attach'], end: ['mic', 'actions', 'extra', 'send'] }`,
  today's markup exactly; a side you leave out keeps its default.
- `attach` renders only with attachments, `mic` only with `voice.enabled`,
  `actions` is `renderActions`, `extra` is `components.InputExtra`, `send` is
  `renderSubmit` or the send/stop button.
- `trigger:<char>` is a button named after the trigger's `label` (else the
  char) that calls `openCompletion({ trigger })` and keeps the caret in the
  editor. The plain input (no completion) leaves it out. A second click does
  not close the list.
- An item (`ComposerToolbarItem`) takes `label` (accessible name), `icon`,
  `onSelect(controls)`, `hidden` (boolean or `(controls) => boolean`) and
  `render(controls)`, which replaces the button. An item key equal to a
  builtin id replaces the builtin. Unknown ids warn once and are skipped.
  Items stay enabled while a turn streams; check `controls.isLoading` in
  `hidden` or `onSelect` when that matters.
- `components.ComposerToolbar` (`ComposerToolbarProps`) gets the rendered
  `start` and `end` arrays, the `editor` and the `controls`, e.g. for a second
  row below the editor. It renders inside the form. Define it once at module
  level (or memoize it): an inline component remounts the editor and loses
  the draft.
- The legacy `mentions` input ignores `composer`.

## Plus menu

Put `'plus'` into `toolbar.start` or `toolbar.end` for a "+" button with a
menu (`aria-haspopup="menu"`). `composer.plusMenu` (`ComposerPlusMenuConfig`)
sets its rows; without `'plus'` in the toolbar nothing renders.

```tsx
const composer = useMemo<ComposerConfig>(() => ({
  toolbar: { start: ['plus'], end: ['mic', 'send'] },
  plusMenu: {
    items: ['attach', 'trigger:@'],
    source: { trigger: '/', source: 'templates', label: 'Vorlagen' },
  },
}), []);
```

- `items` ids: `attach` (only with attachments; opens the file picker, and
  the menu brings the hidden file input when `attach` is not in the toolbar),
  `trigger:<char>` (named after the trigger's `label`, else the char; closes
  the menu and opens that list with the focus in the editor) and keys of
  `composer.items` (their `label`, `icon`, `onSelect(controls)`, `hidden`).
  `render` items cannot be rows; they and unknown ids warn once and are
  skipped. Default: `attach`, then one `trigger:<char>` per trigger.
- `source` lists entries of `trigger` (only the provider ids in `source`)
  directly in the menu, searched with an empty query when it opens, at most
  `limit` (default 8), under the heading `label`. Choosing one does what
  picking it in the list does: `chip` inserts a pill at the caret, `text` its
  `insertText`, `run` inserts and sends, `list` opens the `listSource` list.
  `onCompletionSelect` runs first. No entries, no section; with no rows at
  all (e.g. while the source loads) no menu box shows, and Escape closes it.
- Keyboard: ArrowDown/ArrowUp (wrapping), Home/End, Enter/Space choose,
  Escape closes and returns focus to the "+" button, Tab closes; a press
  outside closes. ArrowDown/ArrowUp on the button open on the first/last row.
- Texts: `locale.plusMenuButtonLabel` (`More actions`, de `Mehr Aktionen`)
  and `locale.plusMenuAttachLabel` (`Attach file`, de `Datei anhängen`).
- A custom handle offers the `source` picks through the optional
  `RichMentionInputHandle.pickCompletion(item, { trigger })`.

## End-to-end example

A toolbar with "+", an `@` and a `/` button before the editor, `mic` and
`send` after it, and prompt templates listed in the "+" menu. Picking a
template puts its text into the editor (`select: 'text'`), where the user can
edit it before sending. `mic` renders only with `voice.enabled`.

```tsx
import { useMemo } from 'react';
import {
  AiChatProvider,
  MentionInput,
  type ChatCompletionProvider,
  type ChatTransport,
  type ChatTriggerDefinition,
  type ComposerConfig,
} from 'glirastes/react';

const triggers: ReadonlyArray<ChatTriggerDefinition> = [
  { char: '@', label: 'Person erwähnen' },
  { char: '/', label: 'Vorlagen' },
];

const templates: ChatCompletionProvider = {
  id: 'templates',
  trigger: '/',
  search: () => [
    { id: 'summary', type: 'template', label: 'Auftrag zusammenfassen', select: 'text', insertText: 'Fasse den Auftrag zusammen' },
  ],
};

const composer: ComposerConfig = {
  toolbar: { start: ['plus', 'trigger:@', 'trigger:/'], end: ['mic', 'send'] },
  plusMenu: {
    items: ['attach'],
    source: { trigger: '/', source: 'templates', label: 'Vorlagen' },
  },
};

export function Chat({ transport }: { transport: ChatTransport }) {
  const providers = useMemo(() => [templates, peopleProvider], []);
  return (
    <AiChatProvider
      transport={transport}
      completionProviders={providers}
      triggers={triggers}
      composer={composer}
    >
      <MentionInput />
    </AiChatProvider>
  );
}
```

`peopleProvider` is your own `ChatCompletionProvider` with `trigger: '@'`;
keep `triggers`, `composer` and the providers at module level or memoized.
