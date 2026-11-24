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
| A read endpoint with `search`, `q`, `query` or `term` whose output lists objects with `id` and `title`/`name`/`displayName`/`label`/`subject`/`email` (`GET /api/tasks?search=`) | `@` entity `task` (the type its [identity](entity-identity.md) declares at that list when no other derived search ends up with it, else the singular of the route), searched with the user's session. [Declare the sources](#which-entities-appear-in-) to decide this yourself |
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
`.glirastes/tool-semantics.json`, entity labels from the reviewed singular of
its search tool, in every language of `languages` in `.glirastes/tools.json`
(`pl`, `pt-BR`, … like the tool labels; inside an entity's menu a leading noun
is dropped in each language: "Endgültig löschen" instead of "Aufgabe endgültig
löschen"). Without them the label is verb plus object built from identifiers,
in English and German ("Open task create dialog", "Task create dialog
öffnen"); every other language needs a reviewed text or an override, the same
rule as for commands. An entity without a reviewed singular is named after its
route (`/api/files` → "File"), also when its type follows the declared
identity (`media-file`), so that type change keeps the label; a declared source
without `label` is named the same way, after its type only when its path names
none (`/search`). Synonyms, icons and what a title cannot
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
loads. A `hidden: true` patch under a command id, entity type or action id that
is not derived hides nothing; the handler names it in a second warning, since a
renamed entry (see the [migration](#migration-the-type-follows-the-declared-identity))
shows again. Both warnings come once, when the handler is created. Remove stale
patches, and load the chat route after every refresh. An
invalid file (unknown field, wrong type) throws when the handler is created,
like an invalid tool policy. `hidden` only shapes the lists; it is no
permission. What a user may run is decided by the tool policy and the app's
endpoints, for direct commands exactly as for the model.

## Which entities appear in `@`

By default every read endpoint that looks like a search becomes an `@` entity
(`policy: "derived"`). `mentions` in `.glirastes/tools.json` lets the app
decide:

```json
"mentions": {
  "policy": "declared",
  "sources": {
    "project": { "tool": "projects.list", "queryParam": "q" },
    "media-file": {
      "tool": "files.list", "queryParam": "search",
      "idField": "id", "labelField": "displayName", "itemsPath": ["items"],
      "descriptionField": "status", "limitParam": "limit",
      "label": { "de": "Datei", "en": "File", "pl": "Plik" },
      "aliases": { "de": ["datei"], "pl": ["plik"] }
    }
  },
  "ignore": ["tag"],
  "acknowledgedTypes": []
}
```

| Field | Meaning |
| --- | --- |
| `policy` | `derived` (default): declared sources plus every derived one. `declared`: only `sources` |
| `sources.<type>` | The key is the entity type, the one the tool's identity declares (`outputEntities`, `x-glirastes-entity`, `identity` in tools.json) |
| `tool` | Definition id or model name of an enabled read endpoint (GET/HEAD) without path parameters |
| `queryParam` | The query parameter that takes the typed text |
| `idField`, `labelField`, `itemsPath` | Default from the tool's identity declaration of that type (`id`, `name`, `path`); given values win. Without a declaration `idField` and `labelField` are required, and `itemsPath` unless the answer has one list. A composite id cannot be mentioned |
| `descriptionField`, `limitParam` | Optional; default as for a derived entity (`description`/`email`/`status`/…, `limit`/`pageSize`) |
| `label`, `aliases` | Optional texts per language; `aliases` are further names for the [type filter](#type-filter) |
| `ignore` | Derived types that are neither offered nor reported |
| `acknowledgedTypes` | Silences `mention-type-follows-identity` for these types |

A declared source replaces a derived entity of the same type or the same
tool. The groups of the `@` list follow the order of `sources`; derived ones
come after them, by type. Context actions ("Edit", "Open") are derived for a
declared entity as for a derived one. The file is local and never sent to the
Platform; `hidden` and the overrides in `.glirastes/chat-interactions.json`
still apply on top.

`glirastes tools refresh` and `tools check` report (all warnings, never a failed refresh):

| Code | When | Effect |
| --- | --- | --- |
| `mention-source-candidate` | `policy: "declared"` and a derivable search is neither declared nor ignored | Not offered; `expected` holds the entry to paste into `sources` |
| `mention-source-invalid` | Unknown or disabled tool, a write tool, a path parameter, a missing `queryParam`, a composite id, a field that is not in the schema, an invalid type, label or alias | The entry is ignored |
| `mention-source-undeclared-type` | The tool's identity does not declare the type of the key | Used with the given fields; declare the identity so markers, approval subjects and entity links agree on the type |
| `mention-type-follows-identity` | `policy: "derived"` and a derived entity now has its declared type instead of the route's (`file` → `media-file`) | Nothing else; see the migration note below |
| `mention-type-ambiguous` | `policy: "derived"` and a declared identity type is not unique: two derived searches declare it, another one's route type is that name (`/api/documents` beside `/api/files` declaring `document`), or `sources` already has the key | Each search involved keeps its route type, as before; declare the wanted one under `sources` |

To move to declared sources: set `"policy": "declared"`, run `glirastes tools
check`, paste the candidates you want into `sources`, list the others under
`ignore`. Pasting all of them gives the same list as before. A pasted source
whose tool declares no identity of that type adds a
`mention-source-undeclared-type` warning until the identity is declared.

### Migration: the type follows the declared identity

Before, the type of a derived entity was always the singular of the route
(`/api/files` → `file`), also when the tool declared another type for the
same records (`media-file`). It now is the declared type, with the declared
id and name field, whenever exactly one declaration with a single id sits at
the searched list and no other derived search ends up with that type (else
`mention-type-ambiguous`, and every search involved keeps its route type).
Only apps with such a declaration are affected; which endpoints become
entities is unchanged, and no entity of before disappears. The action ids
start with the type, so they change too: `file.files.delete` becomes
`media-file.files.delete`, `file.open` becomes `media-file.open`. After
upgrading:

1. Run `glirastes tools refresh`; `mention-type-follows-identity` names each changed type.
2. Rename keys under `entities` and action ids under `actions` in `.glirastes/chat-interactions.json` from `<old>` and `<old>.…` to `<new>` and `<new>.…`. A `hidden: true` patch under the old type or action id no longer applies, so a hidden action (also a destructive one) shows again until it is moved; the handler names such patches in a console warning, stale patches with other fields in another. Rename `entity: '<old>'` in own commands, `defineChatEntity`, `chatAbout`, `mentionEntity` and `entityLinks` code as well.
3. Messages stored before keep `{{mention:<old>:…}}`; they stay readable, their chips open only if the app still handles the old type in `entityLinks.open`.
4. Add the type to `mentions.acknowledgedTypes` (or declare it under `sources`) to end the finding.

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

## Order by context

The host says which entity types belong to what the user looks at; the `@`
list shows those groups first, the others follow in their declared order:

```tsx
import { useMentionContext } from 'glirastes/react';

function ProjectPage() {
  useMentionContext({ preferredTypes: ['project', 'task'], presetType: 'project' });
  …
}
```

`useMentionContext(value | null)` works in any component below the provider.
Of the mounted calls with a value, the one rendered last wins: a nested
component over its ancestors, a later sibling over an earlier one, a
component mounted later over those mounted before, independent of the order
React runs their effects in. Unmounting restores the one before. `mentionContext` on `AiChatProvider` / `VercelAiChat` (and the
property `mentionContext` of `<glirastes-chat>`) is the fallback for apps
that keep this state themselves. Types the chat does not know are ignored;
without any of them the order is the declared one. The value is read when a
search runs and never sent anywhere.

This is the one host indication for `@`. The planned view context
(`ViewContextEntry`, `useViewContext`) will feed it from the entity and
selection types of the registered view, and an explicit `useMentionContext`
keeps winning; there will be no second channel.

## Type filter

`@<type>:<text>` searches one entity type: `@project:apollo`, German
`@Projekt:apollo`. This needs no configuration: whenever the text before the
first colon is a name of a type, only that type is searched for the rest
(before, `@task:123` searched every type for `task:123`). The names of a type,
compared without case and diacritics (`ue` also finds `ü`, `l` finds `ł`, `o`
finds `ø`):

- its label in the chat's language (`chatInteractions.locale`), when it has no whitespace and no colon and is not only combining marks,
- its `aliases` for that language (`pl-PL` finds `pl`) or a language-free list, under the same rule,
- always the canonical type (`media-file`).

The marker a pick writes always carries the canonical type, whatever name was
typed. A label of several words ("Media file") needs an alias to be typed as
a filter. A name two types share in one language selects neither (alias and
canonical type still do); the console warns with the count once per page for
each set of conflicting types (also when the provider builds the registry
again), and `registry.entityFilterConflicts` (`useChatContext().interactions`)
lists them.

| Typed | Result |
| --- | --- |
| `@pro` | Types whose name starts with `pro` first ("Filter by type", at most 3, e.g. `Projekt:`), then the hits of all types. An entity called "Projektplan" stays findable |
| pick `Projekt:` (Enter, Tab, click) | The text becomes `@Projekt:`, no pill; the list stays open and shows that type |
| `@Projekt:` | That type, without search text |
| `@Projekt:12:30` | The first colon ends the filter: `project` searched for `12:30` |
| `@12:30`, `@foo:bar` | No type of that name: all types searched for the whole text |

With `presetType` a bare `@` (typed, or `openCompletion({ trigger: '@' })`
without a query) becomes `@Projekt:`. Backspace right behind the untouched
preset removes it at once and leaves `@`, which searches all types and is not
preset again; after typing, Backspace deletes characters as usual. While an
input method (IME) composes, nothing is preset; when the composition ends with
the `@` still bare, the preset follows. `/` and own triggers are never preset.

Type suggestions need at least two searchable types. Own
`completionProviders` on `@` receive the typed text unchanged (`project:apo`)
and keep their hits: the filter narrows only the entities of
`chatInteractions`. An own `onCompletionSelect` sees the suggestions as items
of type `mention-filter` with `select: 'query'` and should leave them alone
(return nothing). `select: 'query'` is also open to own providers: the pick
replaces the typed query with `insertText` and searches again. The legacy
`mentions` composer (no `chatInteractions`, no `completionProviders`) has no
type filter.

Texts: the headings and the hint are the optional locale keys
`completionCommandsGroupLabel` ("Commands"), `completionEntityTypesGroupLabel`
("Filter by type") and `completionEntityTypeFilterLabel` ("Search only this
type", `{type}` is the name); English and German ship, any other language
comes from the app's `locale` / `locales`. Type names are the entity labels
and aliases, per language:

```json
"entities": { "project": { "label": { "de": "Projekt", "en": "Project", "pl": "Projekt" }, "aliases": { "en": ["proj"], "pl": ["proj"] } } }
```

## List size

The list shows at most 8 hits per provider and 12 in total, per trigger.
`completionLimits` in `chatInteractions` sets both per trigger character:

```tsx
const chatInteractions = useMemo(() => ({
  data,
  completionLimits: { '/': { perProvider: 40, total: 40 }, '@': { perProvider: 20 } },
}), [data]);
```

| Field | Default | Bounds |
| --- | --- | --- |
| `perProvider` | 8 | 1–100; each provider's search gets it as `limit` (an `@` entity search also as its `limitParam`) |
| `total` | 12, or `perProvider` when that is larger | 1–200 |

A value is truncated to an integer and kept within its bounds (`0` → 1,
`500` → 100 or 200); a missing, non-number or non-finite one takes the
default; nothing throws. A trigger without an entry keeps 8 and 12, so `@`
stays as it was when only `/` is raised. The limits apply to every provider
of that trigger in the composer, the app's own `completionProviders`
included. On `@` the entity types share `perProvider` in turn (one hit of
each type, then the next), so one type cannot fill the list; the type
suggestions (at most 3) stay outside both caps. `@`'s `perProvider` also
sizes the entity search of an argument field (8 without it). The list
scrolls (at most `min(40vh, 16rem)` high in the shipped styles, the argument
options 12rem). `<glirastes-chat>` takes the same `config.chatInteractions.completionLimits`.
Outside the provider, pass the same map to
`createCompletionSearch(providers, { limits })`; its `limitPerProvider` and
`maxResults` (all triggers) now reach 100 and 200 as well.

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
In the Markdown handed to the renderer (`markdownWithMentionMarkers`, a custom
`Markdown` component) each label has `` \ ` * _ [ ] < & | ~ `` escaped, so it
stays plain text (no emphasis, code, link, HTML, entity, strikethrough or
table cell). A GFM autolink literal in a label (`www.…`, `https://…`, an
e-mail address) still becomes a link with remark-gfm, which finds those in the
parsed text. The raw text shown while react-markdown loads, after its time
limit or without it shows the labels without these escapes.

## Mention markers

A picked mention reaches the model as `{{mention:type:id:label}}`; a
tool-backed command (and every mention with `includeContextBlock`) is also
listed in a leading `<!--context:[…]-->` block. Inside that block a `-->`,
`--!>` or `<!--` in a label or id is sent with `\u003e` / `\u003c` (since the release
after 0.20.0), so the block the SDK writes cannot be closed early or nested
by its own entries.

Since the release after 0.23.0 the label is sent in its canonical form
(`mentions: { serialize: { labels: 'canonical' } }`, the default), so the
label carries nothing the chip hides from the user but the model reads.
This is about the label, the part the chip shows: the type and id come
from the app and are not shown in the chip, as before; a hostile one is
refused (below). The exceptions for emoji, flags and joining scripts apply
to labels only.

| In the label | Sent as |
| --- | --- |
| `{` `}` `<!` `-->` `--!>` | `｛` `｝` `‹!` `--›` `--!›` (a `}}` can no longer end the marker, a `<!--context:…-->` is visible text of the chip) |
| each run of control characters (also tab and line breaks), line and paragraph separators | one space |
| whitespace at the start and end | trimmed; NBSP, U+202F, U+3000 and runs of spaces inside stay |
| format characters and default ignorables: bidi controls (RLO …), zero-width space, word joiner, BOM, soft hyphen (a typesetting hint, invisible unless a line breaks there), U+034F, Hangul fillers, Khmer U+17B4/17B5, variation selectors, tag characters | removed, except below |
| ZWJ / ZWNJ | kept once between two emoji (family and profession emoji, 🏳️‍🌈) or between two letters of a joining script (Arabic, Persian, Syriac, Thaana, Devanagari and other Indic scripts, Sinhala, Khmer, Myanmar, Mongolian, Meetei Mayek, Chakma, Tai Tham, Sundanese, Newa, Limbu, Kayah Li …), and the ZWJ of a legacy Malayalam chillu at word end (മോഹന്‍); not between Latin, Greek, Cyrillic, Han, Kana or Hangul letters |
| tag characters | only the tags of the 🏴 England, Scotland and Wales flags; any other tag run is removed (a 🏴 with other tags stays a bare 🏴) |
| variation selectors | one VS15/VS16 right after an emoji-capable character (❤️, ☺︎, ©️; after a digit, `#` or `*` only in a keycap such as 1️⃣), one IVS right after a Han ideograph (葛󠄀), one Mongolian FVS after a Mongolian letter |
| private use (icon fonts), noncharacters, U+2800, lone surrogates | removed |
| unassigned code points | kept (what is unassigned depends on the engine's Unicode version; removing it would remove new emoji in older browsers) |
| more than `maxLabelLength` code points (8-120, default 120; 1-7 means 8, anything else the default) | at most the first 119 and `…`, cut at a grapheme boundary with `Intl.Segmenter`, never inside an emoji, flag, keycap, conjunct or Thai cluster; without `Intl.Segmenter` the cut avoids marks, joiners, viramas, flags and keycaps but can split other clusters such as Thai Sara Am; a bare `…` becomes the id, and the label is never empty |
| nothing visible left | the id |

The text is NFC. No NFKC: look-alikes such as `｛` stay, and they are
visible in the chip. Ordinary labels, also emoji, flags, Persian, Arabic,
Devanagari and Japanese names, are sent byte-identical; a single `<` or `>`
stays.

**A hostile type or id sends no marker.** A mention whose type or id has
control characters (also tab and newline), line or paragraph separators,
format characters, default ignorables, private use, unassigned or
noncharacters, U+2800, lone surrogates, `}`, `{{`, `<!`, `-->` or `--!>`
(or a type with `:` or over 200 UTF-16 units) keeps the token the user saw
(`@acme`) without a marker: the model loses the id, no label or id of it
enters the text, and the context block does not list it. The chat warns
once per type in the console (only when `NODE_ENV === 'development'`), without the type, id or
label. Spaces, single `<` `>` `{`, `/`, `@`, `+`, non-ASCII letters and
capitals are fine in types and ids, and `:` in ids, as before; a type with
`:` is refused. An id with the emoji or
joining-script characters a label keeps is refused, and whether a code
point is unassigned depends on the engine's Unicode version (an older
browser refuses an id with a code point it does not know). Such a mention can come from the
legacy `mentions` config (`search` / `resolve` results), completion items,
`addActiveMention`, `RichMentionInput` `addMention` / `insertMention` /
`setValue` with app-built mentions, and drafts or queued messages stored
with such a mention. Known limit, as before: an id with `:` is written as
it is, and every reader splits it at its first colon
(`{{mention:customer:tenant:42:Acme}}` shows a chip for id `tenant` with
the label `42:Acme`, the model gets the whole text); the read path will
handle it.

Each token occurrence is replaced once, in one pass over the typed text:
a label that contains another mention's token (`x @bob y`) no longer gets
a second marker nested inside it. A token belongs to the first mention in
the list with that token, as before. `labels: 'raw'` sends labels, types and ids as
given, without validation; the one-pass replacement applies there too (no
nested markers). Queued messages and restored drafts keep the structured
mention and are serialized the same way when they are sent.
`glirastes/contracts` exports the grammar for own parsers and server code:
`canonicalMentionLabel`, `parseMentionMarkers` (`type`, `id`, `label`,
`canonical`, `span`; `canonical` is a getter computed on first read, so
`{ ...marker }` and `structuredClone` drop it: read it before copying; the same matches as the
reader before, linear in the text), `serializeMentionMarker`,
`isMentionMarkerType`, `isMentionMarkerId`.

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
direct commands, the argument form, entity actions, `mentionEntity`, the
type filter and its preset (`inputProps.completionPreset`):

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
It needs no pointer code: the list makes the row under a moving pointer the
active one (see [Keyboard and screen readers](#keyboard-and-screen-readers)).
`onActivate()` (`MentionDropdownItemProps`) activates the row from the item
itself; call it only on real pointer movement, never on `mouseenter` or
`mouseover`. Scope an own hover style to
`[data-component="mention-dropdown"][data-active-source="pointer"]`, so a
resting pointer does not mark a second row after the arrow keys or a scroll.
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

The visible label is one line of at most 200 characters. Since the release
after 0.25.0 it carries [mention markers](#mention-markers): one for the
command (`{{mention:command:<id>:<label>}}`) and one for each picked object
(`{{mention:<type>:<id>:<label>}}`), so the chat shows them as pills, like
the composer did. A picked object of an entity argument has the type the
argument declares (`entity`); the object an entity action runs on has the type
of that entity. These stay plain text, as before: a command argument without
an entity type (`done`), a value typed without picking an object (`@bob`), an
id with `:`, or an id or type that cannot be written as a marker (see
above). The line is never cut inside a marker: a long label is shortened
inside its marker (to at least 8 code points, with `…`), and a marker that
still does not fit is written as plain text. A message sent by an older
release keeps its plain line (`/Assign @Release @Alice`) and is shown as
before.

The line follows the app's `mentions.serialize`: with `enabled: false` it
stays plain text exactly as before (no markers), and `maxLabelLength` is the
upper bound of each label in its markers (the line's limit can shorten a
label further). `labels: 'raw'` does not apply here: the line is always
written with canonical labels, since a raw label could end a marker early or
break the command message.

The picked object's name then counts like a name the user mentioned: the
approval card of the command shows it (provenance `mention`) instead of
warning that no name is known for the id. The model reads the label line of
earlier commands on later turns as it reads any user message with mentions:
it now sees the command id and the object ids in the markers. It saw these
ids before in the arguments of the command's tool call in the history; the
PII shield treats the line like any user text. Copy text, the chat title and
`stripChatCommandMarkers` work on the new line unchanged; the chat title now
also leaves out the hidden command marker for a chat that starts with a
command (it showed `<!--glirastes:command…` before).

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
- Real pointer movement over a result or an entity action makes it the
  active entry (`aria-activedescendant`, `aria-selected`; Enter or Tab picks
  it) without scrolling the list; the arrow keys go on from there. A list
  that opens, scrolls or re-renders under a resting pointer keeps the
  keyboard entry: `mouseenter`/`mouseover` and moves of less than 1 CSS
  pixel are ignored, as is touch movement; a pointer event and its
  compatibility mouse event count as one move. The listbox carries
  `data-active-source="pointer"` while the active entry is the one under the
  pointer, else `"keyboard"`: arrow keys, new results and any scroll of the
  list (wheel, trackpad) set it back until the pointer really moves again.
  The built-in stylesheet
  shows a hover look (same as the selected look) only in pointer mode and
  only on devices with hover.
- Backspace behind a pill and Delete before it remove the whole pill; each
  pill's remove control is named by `locale.removeMentionLabel`.
- A chip in an answer is a button named by `locale.openEntityLabel`.
- A type suggestion is an `option` like a hit, named "<name>: <hint>"
  (`Projekt: Nur diesen Typ durchsuchen`); Enter or Tab sets the filter and
  the live region announces the new count. Backspace behind a preset filter
  removes it in one step.
- A list that mixes commands and entity types shows a heading per group; a
  search without hits shows the optional locale text `completionEmptyLabel`, which
  Escape clears.
- The argument form starts at the first empty required field; entity fields
  are ARIA 1.2 comboboxes; Escape closes an open list first, then cancels.
