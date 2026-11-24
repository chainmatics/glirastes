# Composer triggers and toolbar

All names below come from `glirastes/react` unless noted.

## Contents

- Triggers
  - Sent mentions and `types`
  - Mention markers
- What a pick does
  - Sub-lists
  - Pointer and the active entry
- Opening a list from a button
- Toolbar
  - Layout
- Plus menu
  - Row descriptions and icons
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
- `useChatComposerInput().inputProps` carries `triggers` only when the
  provider's list differs from the default `@` and `/` (an explicit definition
  or a provider with another char), so an input's own `triggers` prop still
  applies; when it does carry them, spread `inputProps` before your own
  `triggers` prop if you set one.
- A standalone `RichMentionInput` takes `triggers` as chars or definitions
  (default `['@', '/']`), e.g. `['@', { char: '#', prefix: 'tag:' }]`, and
  throws on an invalid entry like the provider.
- The legacy `mentions` search (without `completionProviders`) stays `@` and `/` only.
- With `chatInteractions`, `@<type>:<text>` searches one entity type and
  typing after `@` suggests the types first; `useMentionContext({
  preferredTypes, presetType })` (`ChatMentionContext`) orders the list by
  the current page and presets the filter. An own composer gets this through
  `useChatComposerInput().inputProps` (`completionPreset`); an own
  `onCompletionSelect` ignores items of type `mention-filter`. Names per
  language: see `curating-glirastes-chat-interactions` and
  `docs/chat-interactions.md`, Type filter.
- List size: 8 hits per provider and 12 in total per trigger by default.
  `chatInteractions.completionLimits` (`CompletionLimits` per trigger char,
  e.g. `{ '/': { perProvider: 40, total: 40 } }`, at most 100 and 200)
  raises them for every provider of that trigger, own `completionProviders`
  included; outside the provider pass it as `createCompletionSearch(providers,
  { limits })`. `docs/chat-interactions.md`, List size.

### Sent mentions and `types`

The wire format (`{{mention:type:id:label}}`) carries no prefix. The sent
bubble, restored history and `MentionChip` look the prefix up by type from
the provider's `triggers`: a type in a trigger's `types` shows that
trigger's `prefix`, `command` shows `/`, any other type `@`. Without `types`
nothing changes. Chat titles of `createLocalSessionStore` follow without
further config (`#Bug 7 …` instead of `@Bug 7 …`): with claimed `types` the
provider calls `session.save(id, messages, { mentionPrefix })`. A custom
store may use that third argument for its titles or ignore it; a store
that wraps `createLocalSessionStore` forwards it (`save: (id, messages, options) =>
base.save!(id, messages, options)`).

### Mention markers

A sent mention carries its canonical label (`mentions.serialize.labels`,
default `'canonical'`): ordinary labels, ids and types are byte-identical
(also emoji, flags, Persian, Devanagari, Japanese names); `{` `}` `<!`
`-->` `--!>` become `｛` `｝` `‹!` `--›` `--!›`; hidden characters go
(bidi, zero-width, soft hyphen, default ignorables, tag runs, private use)
except the joiners, flag tags and selectors of ordinary names; NFC; edge
whitespace trimmed, control runs one space; at most `maxLabelLength`
(8-120, default 120) code points, cut at a grapheme boundary (`…`). A type
or id with control, format, invisible, private-use or unassigned
characters, `}`, `{{`, `<!`, `-->` or `--!>` gets no marker: the typed
token stays and the model loses the id (console warning once per type,
only in development).
`labels: 'raw'` sends the old format. Reading is unchanged so far (stored
text shows as before).

From `glirastes/contracts`, for own parsers and server code:
`canonicalMentionLabel(label, { id?, maxLength? })` (`CanonicalMentionLabelOptions`),
`parseMentionMarkers(text)` (`ParsedMentionMarker`: `type`, `id`, `label`,
`canonical`, `span`; same matches as the old regex, linear),
`serializeMentionMarker({ type, id, label }, { labels?, maxLabelLength? })`
(`MentionMarker`, `SerializeMentionMarkerOptions`; `undefined` for an
hostile type or id), `isMentionMarkerType`, `isMentionMarkerId`,
`MENTION_MARKER_MAX_LABEL_LENGTH` (120).

## What a pick does

`select` on a `CompletionItem` (or on `MentionResult`) sets what picking it
does; without it the trigger's `select` applies, default `chip`.

| `select` | Pick result |
| --- | --- |
| `chip` | A pill, as before |
| `text` | `insertText` (default: the label) replaces trigger and query as plain text; caret behind it, list closes |
| `run` | A pill, then sends exactly like the send button. While a turn streams nothing is sent and the pill stays |

```tsx
const prompts = {
  id: 'prompts',
  trigger: '/',
  search: () => [
    { id: 'summary', type: 'prompt', label: 'Zusammenfassen', select: 'text', insertText: 'Fasse den Auftrag zusammen' },
    { id: 'more', type: 'prompt', label: 'Vorlagen' },
  ],
};
```

A prompt template as `select: 'text'` replaces rewriting a chip into text in
`onBeforeSend`: the user sees and edits the text before sending.

`onCompletionSelect(item, { trigger, query, controls })` (`CompletionSelectContext`) on the provider runs
before the built-in behavior; `controls` is the composer
(`ChatComposerInputControls`: `setText`, `submit`, `focus`, …). Return `true`
when the app handled the pick: the typed trigger and query (or the text
`openCompletion` inserted) leave the editor, also when the handler added
text or a pill (`appendText`, `insertMention`); one of two spaces that meet
goes too. The caret stays where they were and the list closes. A standalone `RichMentionInput` takes `onCompletionSelect` with
`{ trigger, query }` only. An unknown `select` or an empty `insertText` is
left out of the item, which stays in the list with the trigger's default pick. `onCompletionSelect` receives the normalized item
(`MentionResult`), not the provider's raw `CompletionItem`.

### Sub-lists

There is no sub-list pick kind. Handle the entry in `onCompletionSelect`:
open the other provider's list with `controls.openCompletion` and return
`true`. The typed `/vor` goes, a fresh `/` lists only `templates`, typing on
searches only them, and Escape removes the `/` again.

```tsx
const onCompletionSelect = useCallback<NonNullable<AiChatProviderConfig['onCompletionSelect']>>(
  (item, { trigger, controls }) => {
    if (item.id !== 'more') return;
    controls.openCompletion({ trigger, source: 'templates' });
    return true;
  },
  [],
);
<AiChatProvider completionProviders={providers} onCompletionSelect={onCompletionSelect} />
```

`templates` is a second provider on the same trigger. The same works for an
entry of the "+" menu's `source` section.

### Pointer and the active entry

The active entry of the `@`/`/` list (the one Enter or Tab picks,
`aria-activedescendant`, `isSelected`, `data-selected="true"`) follows the
pointer when it really moves over a row or an entity action button. Arrow
keys go on from there. `mouseenter`/`mouseover` and a move of less than 1 CSS
pixel (the list opens, scrolls or re-renders under a resting pointer)
change nothing, nor does a finger dragging the list. Pointer activation does
not scroll the list. The listbox carries `data-active-source="pointer"`
while the active entry is the one under the pointer, else `"keyboard"`:
arrow keys, new results and any scroll of the list (wheel, trackpad) set it
back until the pointer really moves again.

A custom `DropdownItem` needs no change: the list finds the row from the
`optionProps` id (or, without it, from the row order when each result renders
one element). It can call `onActivate()` itself, only on real pointer
movement. An own hover style is best scoped to
`[data-active-source="pointer"]`, or the hovered row and the active row
both look marked after the arrow keys or a scroll. A custom item that scrolls itself on
`isSelected` also scrolls on pointer activation.

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
  provider id or ids of the trigger) limits the list until it closes. It
  narrows the composer's search (`completionProviders`) and a search made by
  `createCompletionSearch`; an own `onSearch` of a standalone input still gets
  `(query, trigger)`, lists everything and warns once in the console.
- While the user has neither typed nor picked, closing the list (Escape,
  outside click, blur, or no results) removes exactly the inserted text and
  restores the caret; so do Enter before results show (nothing is sent) and
  an inserted mention (`insertMention`, `chatAbout`). Typing or a built-in pick
  keeps it; a pick the app handles (`onCompletionSelect` returns `true`) removes it.
- A second call while untouched replaces the first one's text. An unknown
  trigger warns once in the console and does nothing.
- While the composer is locked (`controls.canCompose` false: a turn runs
  without `queue.enabled`, the session loads or changes) it does nothing,
  also on a disabled `RichMentionInput`.
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
  not close the list. It is disabled exactly when the editor is
  (`!controls.canCompose`); with `queue.enabled` it stays usable while a turn
  streams.
- An item (`ComposerToolbarItem`) takes `label` (accessible name), `icon`,
  `onSelect(controls)`, `hidden` (boolean or `(controls) => boolean`) and
  `render(controls)`, which replaces the button. An item key equal to a
  builtin id replaces the builtin. Unknown ids warn once and are skipped.
  App items are never disabled by the SDK; check `controls.canCompose`
  (not `isLoading`) in `hidden` or `onSelect` before writing into the
  composer, so they follow the queue like the editor.
- `components.ComposerToolbar` (`ComposerToolbarProps`) gets the rendered
  `start` and `end` arrays, the `editor` and the `controls`, e.g. for a second
  row below the editor. It renders inside the form. Define it once at module
  level (or memoize it): an inline component remounts the editor and loses
  the draft.
- The legacy `mentions` input ignores `composer`.

### Layout

`composer.layout` places the toolbar. `'inline'` (default) keeps one row:
`start` items, the editor, `end` items, with no wrapper element. `'stacked'`
puts the editor on its own row and the toolbar items in a row under it,
`start` on the left and `end` on the right (as in omnify):

```tsx
const composer = useMemo<ComposerConfig>(() => ({
  layout: 'stacked',
  toolbar: { start: ['plus', 'trigger:@', 'trigger:/'], end: ['mic', 'send'] },
}), []);
```

Stacked markup inside the form: the editor, then
`div[data-component="composer-toolbar"][data-layout="stacked"]` with
`[data-element="toolbar-start"]` and `[data-element="toolbar-end"]`. The
hint line (`composer.hint`) stays the last row. `components.ComposerToolbar`
still replaces both layouts.

### Placeholder on focus

The pill composer (`RichMentionInput` in mention mode, the default composer
with `chatInteractions` or `completionProviders`) keeps its placeholder
(`locale.placeholder`) visible while the empty editor has focus, until text
or a pill is in it, like a native placeholder. `composer.placeholderOnFocus:
false` hides it as soon as the editor is focused (the earlier look). It
reaches the built-in composer and `useChatComposerInput().inputProps`; an own
`RichMentionInput` takes the prop `placeholderOnFocus`. The plain text field
uses the browser placeholder and ignores it. The placeholder element is
`[data-element="placeholder"]` inside `[data-component="rich-mention-input"]`.

```tsx
const composer = useMemo<ComposerConfig>(() => ({ placeholderOnFocus: false }), []);
```

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
  `insertText`, `run` inserts and sends.
  `onCompletionSelect` runs first. No entries, no section; with no rows at
  all (e.g. while the source loads) no menu box shows, `aria-expanded` stays
  `false` until it does, and Escape closes it.
- The "+" button is disabled, and an open menu closes, while
  `controls.canCompose` is false; with `queue.enabled` both stay usable while
  a turn streams.
- Keyboard: ArrowDown/ArrowUp (wrapping), Home/End, Enter/Space choose,
  Escape closes and returns focus to the "+" button, Tab closes; a press
  outside closes. ArrowDown/ArrowUp on the button open on the first/last row.
- Texts: `locale.plusMenuButtonLabel` (`More actions`, de `Mehr Aktionen`)
  and `locale.plusMenuAttachLabel` (`Attach file`, de `Datei anhängen`).

### Row descriptions and icons

A row is `[icon][label][description]`. The description sits under the label
in muted text and is linked with `aria-describedby`; the row's name stays the
label. Rows take them from:

- `composer.items` rows: `icon` (an element) and `description`.
- `trigger:<char>` rows: the trigger's `icon` and `description`
  (`ChatTriggerDefinition`); a `trigger:<char>` toolbar button shows the
  `icon` instead of the char and keeps the label as its accessible name.
- `source` rows: the entry's `description` (shown whenever the entry has
  one) and its string `icon` through `composer.renderIcon`.

String icon names (`CompletionItem.icon`, `ChatCommandDefinition.icon`,
`ChatEntityDefinition.icon`, starter icons) render only through
`composer.renderIcon(name, { type, trigger })`; the SDK ships no icon set.
The same resolver puts an icon before the label in the default list item.

```tsx
import { FileText, LifeBuoy, User } from 'lucide-react';

const ICONS: Record<string, ComponentType<{ size?: number }>> = { 'file-text': FileText, 'life-buoy': LifeBuoy, user: User };

const composer = useMemo<ComposerConfig>(() => ({
  toolbar: { start: ['plus'], end: ['send'] },
  items: { help: { label: 'Hilfe', description: 'Kurze Anleitung', icon: <LifeBuoy size={16} />, onSelect: openHelp } },
  plusMenu: { items: ['help', 'trigger:@'], source: { trigger: '/', label: 'Vorlagen' } },
  renderIcon: (name) => {
    const Icon = ICONS[name];
    return Icon ? <Icon size={16} /> : null;
  },
}), [openHelp]);
```

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
