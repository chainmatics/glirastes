# Chat interactions: `@` entities and `/` commands

Every Glirastes chat can offer the things (`@`) and commands (`/`) of its app.
They are declarative, derived from the code where possible, and run through
the same server-side tool execution as the model. Nothing about them goes to
the Glirastes Platform.

## Where they come from

`glirastes tools refresh` writes `chatInteractions` into the generated module
(`src/generated/glirastes/tools.generated.*`), next to `toolCatalog`:

| Derived from | Becomes |
| --- | --- |
| A page without parameters (`ui.navigate`) | `/` command `open.<path>`, the path segments joined by dots (`/overview` is `open.overview`, `/settings/profile` is `open.settings.profile`, `/` is `open.home`; "Open Overview") |
| A URL filter (`ui.filter.<view>`) | `/` command `filter.<view>`; its string keys are arguments, enums become choices |
| A client action (`ui.<actionId>`) | `/` command `<actionId>`; its string payload fields are arguments |
| A read endpoint with `search`, `q`, `query` or `term` whose output lists objects with `id` and `title`/`name`/`displayName`/`label`/`subject`/`email` (`GET /api/tasks?search=`) | `@` entity `task`, searched with the user's session |
| A search endpoint below `/search` with a `name` parameter (`GET /api/users/search?name=`) | `@` entity `user` |
| An endpoint with one path parameter below that collection (`PATCH /api/tasks/:id`, `POST /api/tasks/:id/complete`) | Context action of the entity ("Edit", "Complete") |
| A page with one parameter of that entity (`/tasks/:taskId`) | Context action "Open" |

Only string arguments are derived. An optional array, number or object key
is left out of the form, and a command or action with a required key of
another type is not offered at all.

Only enabled tools count: a disabled, `needs_attention` or excluded tool
derives nothing. Client actions of the chat itself (`ai-chat.*`, `chat.*`,
`assistant.*`, `command-palette.*`, `command-menu.*`, `cmdk.*`) are left out,
and destructive actions (marked `destructive: true`) come last in an entity's
menu, also after actions the overrides add.

Labels come from each tool's reviewed `title` in
`.glirastes/tool-semantics.json`, entity labels from its presentation noun
(inside an entity's menu a leading noun is dropped: "Endgültig löschen"
instead of "Aufgabe endgültig löschen"). Without them the label is verb plus
object built from identifiers, in English and German ("Open task create
dialog", "Task create dialog öffnen"). Synonyms, icons and what a title cannot
say come from `.glirastes/chat-interactions.json` (written by people, the
`describing-glirastes-tools` or `curating-glirastes-chat-interactions` skill,
never by the generator). The titles reach the derivation through
`.glirastes/tool-contracts.json`; run `glirastes tools refresh` after
upgrading and commit the result.

```json
{
  "schemaVersion": 1,
  "commands": {
    "open.overview": { "label": { "de": "Übersicht öffnen", "en": "Open overview" }, "keywords": ["start"] },
    "filter.tasks": { "hidden": true },
    "standup": { "label": "Stand-up", "run": { "kind": "prompt", "prompt": { "de": "Fasse meinen Tag zusammen." } } }
  },
  "entities": {
    "task": { "label": { "de": "Aufgabe", "en": "Task" }, "actions": { "task.tasks.delete": { "hidden": true } } }
  }
}
```

A patch replaces the fields it names, `hidden: true` removes an entry, and a
complete entry under a new id is added (a command needs `label` and `run`, an
action `label`, `entityArg` and `run`, an entity `label` and a `search` or an
action). A patch under an id or type that is not derived and is no complete
entry is stale, typically after a refresh stopped deriving a tool: it is
ignored and the handler logs one console warning naming it, so the route still
loads. Remove stale patches, and load the chat route after every refresh. An
invalid file (unknown field, wrong type) throws when the handler is created,
like an invalid tool policy. `hidden` only shapes the lists; it is no
permission. What a user may run is decided by the tool policy and the app's
endpoints, for direct commands exactly as for the model.

## Serving them

The chat route serves the interactions with a GET next to its POST. With
`managedRuntime` the answer is per user: commands, actions and searches whose
tool this user may not run (Platform disabled, roles, revocation, not
deployed) are left out.

```js
import { createAiChatHandler, createChatInteractionsHandler } from 'glirastes/server/nextjs';
import * as generated from '../../generated/glirastes/tools.generated.js';
import overrides from '../../../.glirastes/chat-interactions.json' with { type: 'json' };

export const POST = createAiChatHandler({ managedRuntime, loadTools, model, systemPrompt });
export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime });
```

Without `managedRuntime` the handler serves the same list to every caller and
checks no session (the list names commands and endpoint paths, never data);
wrap it with the app's own session check when even that should stay private.

## React

```tsx
import { defineChatCommand, defineChatEntity, useChatInteractionsData } from 'glirastes/react';

const person = defineChatEntity({
  type: 'person',
  label: { de: 'Person', en: 'Person' },
  search: async (query, { signal }) => (await fetch(`/api/people?q=${encodeURIComponent(query)}`, { signal })).json(),
  resolve: async (id) => (await fetch(`/api/people/${encodeURIComponent(id)}`)).json(),
  card: (item) => ({ title: item.label, subtitle: item.description }),
});
const assign = defineChatCommand({
  id: 'tasks.assign',
  label: { de: 'Zuweisen', en: 'Assign' },
  args: [
    { name: 'taskId', label: 'Task', required: true, entity: 'task' },
    { name: 'assigneeId', label: 'Person', required: true, entity: 'person' },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

function Chat() {
  const data = useChatInteractionsData('/api/chat');
  const chatInteractions = useMemo(() => ({ data, entities: [person], commands: [assign], locale: 'de' }), [data]);
  return <VercelAiChat endpoint="/api/chat" chatInteractions={chatInteractions} />;
}
```

App definitions replace derived ones with the same id or type.
`useChatContext().mentionEntity('task', id)` puts a reference to one entity
into the composer (through the entity's `resolve`). `chatInteractions` already
offers the generated UI tools as `/` commands; drop an earlier
`createUiToolCommandProvider` from `completionProviders`, or the `/` list can
show a command twice (results are only merged when type and id match), and
the entry of the older provider still goes through the model.

## Pills in the composer

With `chatInteractions` (or `completionProviders`) the default `ChatInput`
is the pill composer: a picked `/` command and a picked `@` entity both
become pills inside the text, `data-mention-kind="command"` or `"entity"`,
styled apart. Backspace right behind a pill and Delete right before it
remove the whole pill. `RichMentionInput commandPills={false}` keeps the
earlier behaviour of a command inserted as `/slug ` text.

Pill colors are CSS variables, light and dark come from the theme:

| Variable | Theme color | Unset |
| --- | --- | --- |
| `--cm-pill-command-bg`, `--cm-pill-command-text` | `pillCommand`, `pillCommandText` | the primary tint and color |
| `--cm-pill-entity-bg`, `--cm-pill-entity-text` | `pillEntity`, `pillEntityText` | a teal tint, mixed with the text color |

A chat rendered `unstyled`, or a composer of its own built on
`RichMentionInput`, gets the same pills from `import 'glirastes/react/pills.css'`
(zero specificity, every app rule wins) and sets the variables itself:

```css
:root { --cm-pill-command-bg: #ede9fe; --cm-pill-command-text: #5b21b6; --cm-pill-entity-bg: #ccfbf1; --cm-pill-entity-text: #115e59; }
.dark { --cm-pill-command-bg: #4c1d95; --cm-pill-command-text: #ede9fe; --cm-pill-entity-bg: #134e4a; --cm-pill-entity-text: #ccfbf1; }
```

## Starting a chat about something

`useChatComposer()` works anywhere below `AiChatProvider` (`VercelAiChat`),
for a right-click "Chat about this" entry or an AI button in a detail view:

```tsx
import { useChatComposer } from 'glirastes/react';

function TaskMenu({ task }) {
  const composer = useChatComposer();
  return (
    <>
      <MenuItem onSelect={() => composer.chatAbout({ type: 'task', id: task.id, label: task.title })}>
        {composer.chatAboutLabel /* "Chat about this", German "Mit KI besprechen" */}
      </MenuItem>
      <MenuItem onSelect={() => composer.chatAbout({ type: 'task', id: task.id, label: task.title }, { command: 'tasks.summarize' })}>
        Summarize
      </MenuItem>
    </>
  );
}
```

| Method | Effect |
| --- | --- |
| `open()` | Calls the provider's `onOpenRequest`, else opens the surrounding `AssistantLayoutProvider` |
| `chatAbout(entity, { command?, args?, text?, append? })` | `open()`, then replaces the draft (or adds to it with `append`) with the command pill, the entity pill and the text, and focuses the editor |
| `insertMention({ type, id, label? })` | An `@` pill at the caret; without `label` the entity's `resolve` looks it up (false when neither gives one) |
| `insertCommand(id, args?)` | A `/` pill for a known command (false otherwise); `args` fill its arguments, so sent alone it runs without the form |
| `setDraft(text, mentions?)`, `insertText(text)`, `clear()`, `focus()` | The draft itself |
| `hasCommand(id)`, `hasEntity(type)`, `chatAboutLabel` | For building menus |

Components that also render without a chat (tests, other pages) use
`useOptionalChatComposer()`, which is `null` there. Requests wait until a composer is mounted, so a closed chat that mounts its
panel on open still receives them. A composer of its own built on
`RichMentionInput` takes them with `useChatComposerTarget(inputRef, { onChange })`.
`chatAbout` with a command whose entity argument the pill fills runs the
command directly when sent alone, like a command picked from the list.

## Entity chips in answers

`entityLinks` on the provider turns references in assistant text into chips
(declared records of any tool result count as known names, and the options
`knownEntities`, `ambiguousNames`, `resolveAmbiguous`, `scope` and the
reference's `data` are described in [entity identity](entity-identity.md#entity-link-options)):

```tsx
const entityLinks = useMemo(() => ({
  // App-specific references, e.g. task keys. `resolve` may return undefined (not visible): the text stays.
  matchers: [{ type: 'task', pattern: /[A-Z][A-Z0-9]{1,5}-\d+/, resolve: (key) => lookupTask(key) }],
  // Optional: open a reference yourself; return false to fall through to the default.
  open: (ref) => (ref.type === 'task' ? openTaskDetails(ref.id) : false),
}), []);
<VercelAiChat endpoint="/api/chat" chatInteractions={chatInteractions} entityLinks={entityLinks} />
```

Besides the matchers, names the conversation already referenced become chips
(`known`, default on, names of at least `minLabelLength` = 4 characters):
`@` mentions and the hits of an entity's search tool (`GET /api/tasks?search=`).
A chip opens through `open`, else through the entity's derived "Open" action
(a page like `/tasks/:taskId`) on the navigation bridge, without a chat
message; without either it is shown but not clickable. `@` pills in sent
messages open the same way, also without `entityLinks`. A custom `Markdown`
component keeps the chips with `useChatEntityLinks().markdownComponents`
(for `react-markdown`) or `linkify(children)`; `EntityText` renders one string.
`mentionMarkers: 'markdown'` keeps the Markdown of an answer with
`{{mention:…}}` markers and draws each marker as a chip inside it, checked
against the ids the conversation showed by declaration (`verifyMentions`,
default on); see [entity identity](entity-identity.md#entity-link-options).

## Mention markers

A picked mention reaches the model as `{{mention:type:id:label}}`; a
tool-backed command (and every mention with `includeContextBlock`) is also
listed in a leading `<!--context:[…]-->` block. Inside that block a `-->`,
`--!>` or `<!--` in a label or id is sent with `\u003e` / `\u003c` (since the release
after 0.20.0), so the block the SDK writes cannot be closed early or nested
by its own entries.

Since the release after 0.23.0 the label is sent in its canonical form
(`mentions: { serialize: { labels: 'canonical' } }`, the default), so the
marker carries nothing the bubble hides from the user but the model reads:

| In the label | Sent as |
| --- | --- |
| `{` `}` `<!` `-->` `--!>` | `｛` `｝` `‹!` `--›` `--!›` (a `}}` can no longer end the marker, a `<!--context:…-->` is visible text of the chip) |
| control characters, line and paragraph separators, whitespace runs | one space; trimmed |
| format characters: bidi controls (RLO …), zero-width space, word joiner, BOM, soft hyphen (a typesetting hint, invisible unless a line breaks there) and all others | removed |
| ZWJ / ZWNJ | kept once between two emoji (family and profession emoji, 🏳️‍🌈) or between two letters or marks (Persian and Arabic ZWNJ, Indic conjuncts); a run becomes one joiner; every other joiner is removed |
| tag characters | only the tags of the 🏴 England, Scotland and Wales flags; any other tag run is removed (a 🏴 with other tags stays a bare 🏴) |
| variation selectors | one VS15/VS16 right after an emoji-capable character (❤️, ☺︎, keycaps); all others removed, also the supplement U+E0100-E01EF |
| U+034F, Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), U+2800, private use (icon fonts), unassigned and noncharacters, lone surrogates | removed |
| more than `maxLabelLength` code points (1-120, default 120) | at most the first 119 and `…`, cut before a joined emoji, flag, conjunct or combining sequence |
| nothing visible left | the id |

The text is NFC. Ordinary labels (`ACME <Süd> & Co. -> a/b`, emoji, flags,
Persian, Arabic and Devanagari names) are sent byte-identical; a single `<`
or `>` stays.

**An invalid type or id sends no marker.** A mention whose type is not
`[a-z][a-z0-9_.-]{0,63}` (the entity type pattern; capitals or non-ASCII
are invalid) or whose id has `:` `{` `}` `<` `>`, whitespace, control,
format or any invisible character of the table, or more than 200 UTF-16
units, is sent as the prefix and the canonical label (`@Acme`): the model
loses the id, and the context block does not list it. An id is never
cleaned. Completion items already require a valid type, so an invalid type
comes only from the legacy `mentions` config (`search` / `resolve`
results), `addActiveMention`, `RichMentionInput` `addMention` /
`insertMention` / `setValue` with app-built mentions, or drafts and queued
messages stored with such mentions; an invalid id can come from all of
these and from completion items. `labels: 'raw'` sends the format of
releases before. Queued messages and restored drafts keep the structured
mention and are serialized the same way when they are sent.
`glirastes/contracts` exports the grammar for own parsers and server code:
`canonicalMentionLabel`, `parseMentionMarkers` (`type`, `id`, `label`,
`canonical`, `span`; the same matches as the reader before, linear in the
text), `serializeMentionMarker`, `isMentionMarkerType`, `isMentionMarkerId`.

Known limits (planned): reading is unchanged so far. Text stored by an
older release, by `labels: 'raw'`, by an own client or added in
`onBeforeSend` can still carry a raw marker whose label ends it early
(`}}`) or holds a whole `<!--context:…-->` block: the bubble hides it, the
model reads it, and a `<!--glirastes:clarification …-->` inside it still
parses as a clarification answer. And a label can forge sibling entries
(`Bob (ID: 9), Admin (ID: 1, …)`) inside the free-text context block. The
default `react-markdown` renderer shows other HTML comments as text; a
custom `Markdown` with `rehype-raw` hides them, while the model reads them.

## Custom composers

An app that replaces the input (`components.ChatInput`) first tries the SDK
`MentionInput` with its props: `initialMentions`, `initialValue`,
`components={{ DropdownItem }}` (or `components.MentionDropdownItem` on the
chat), `renderActions` and `renderSubmit` (both get the composer controls),
`inputClassName` and `editorClassName`. A layout those props cannot express
builds the input on `useChatComposerInput`, which keeps the suggestion search,
direct commands, the argument form, entity actions and `mentionEntity`:

```tsx
import { RichMentionInput, useChatComposerInput } from 'glirastes/react';

function Composer() {
  const composer = useChatComposerInput();
  return (
    <form onSubmit={(event) => { event.preventDefault(); composer.submit(); }}>
      {composer.argumentsForm}
      <RichMentionInput ref={composer.inputRef} {...composer.inputProps} />
      <button type="submit" disabled={!composer.canSend}>Senden</button>
    </form>
  );
}
```

A custom suggestion item spreads `optionProps` onto its clickable element.
Never call `send(text)` without the editor's mentions and never pass an own
`onSearch` next to `chatInteractions`: both bypass direct commands and entity
actions. The legacy `mentions` composer ignores these props. The
`curating-glirastes-chat-interactions` skill walks a coding agent
through the review, the overrides and this wiring. A composer built on
`useChatComposerInput` also receives what `useChatComposer` sends (`chatAbout`,
pills), without `useChatComposerTarget`. For file attachments in a
custom composer see [chat attachments](chat-attachments.md#custom-composers).

## `<glirastes-chat>`

```html
<glirastes-chat endpoint="/api/chat" interactions></glirastes-chat>
<script type="module">
  import { defineGlirastesChatElement } from 'glirastes/embed';
  defineGlirastesChatElement();
  const chat = document.querySelector('glirastes-chat');
  chat.defineEntity(person);
  chat.defineCommand(assign);
  // chat.interactions = generated.chatInteractions; // instead of the attribute
  // await chat.mentionEntity('task', '42');
</script>
```

`interactions` without a value loads from `endpoint`, with a value from that
URL. Labels follow the nearest `lang` attribute (`de`, else `en`).

## What happens on send

| Run | Effect | Model call |
| --- | --- | --- |
| `ui` | a generated UI tool (navigation, filter, client action); the result's UI action goes to the app's bridge | no |
| `tool` | any catalog tool with the given arguments | no |
| `prompt` | the prepared instruction replaces the command and goes to the model | yes |

A `/` command sent alone (its `@` references fill its entity arguments)
becomes one user message `<!--glirastes:command {"commandId":…,"tool":…,"args":{…}}-->`
plus its visible label. Missing arguments open a form first; a command with
only optional arguments asks once. A command mixed with free text goes to the
model as before, with the command as a tool reference.

The chat handler runs such a message without routing, guardrails or a model:
the tool comes from the same registry, wrapped like on the model path, so the
managed guard (manifest, principal, roles, revocation, budget), confirmation
(`requiresApproval`, risk tier 3), audit and a configured PII shield apply
unchanged (the result stays in the history the model reads on later turns,
so it is pseudonymized like a model call's result). A tool that needs
confirmation answers with the normal approval card; the approval round trip
runs it. Every such request records one metric event: `model: null`, tokens 0,
cost unknown (`null`), the executed call as tool count. An endpoint that
refuses the command's schema-valid call with 400 or 422 also records a
`tool_contract_rejected` event, without content, exactly as for a model call.
A failed backend call returns its status and body in the tool result, and a
failure the handler's `classifyToolFailure` marks as expected is no tool error
in that event. Unlike on the model path it is not counted anywhere: a direct
command never calls `onFinish`, so `expectedToolFailureCount` does not include
it (see [managed-runtime-sync.md](managed-runtime-sync.md#failed-tool-calls)).
`directCommands: false` on `createAiChatHandler` turns this off; the message
then goes to the model.

## Keyboard and screen readers

- The editor is the `textbox` that controls the suggestion `listbox`
  (`aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`); a
  polite live region announces the number of suggestions.
- ArrowUp/ArrowDown move between results, ArrowRight/ArrowLeft between an
  entity and its actions, Enter or Tab picks, Escape closes.
- Backspace behind a pill and Delete before it remove the whole pill; each
  pill's remove control is named by `locale.removeMentionLabel`.
- A chip in an answer is a button named by `locale.openEntityLabel`.
- A list that mixes commands and entity types shows a heading per group; a
  search without hits shows the optional locale text `completionEmptyLabel`, which
  Escape clears.
- The argument form starts at the first empty required field; entity fields
  are ARIA 1.2 comboboxes; Escape closes an open list first, then cancels.
