# Declared object identity

Which field of a record is its id, which one names it, of which type it is and
whether its id is opaque or speaking: declared once, used by the result
overview, history compaction, `read_result`, `hideIds`, the approval card and
entity links. Without a declaration the SDK guesses from field names, as
before; the guess lives in one module (`src/contracts/entity-identity.ts`).

Declarations hold field names and types, never values. They stay with the
app: the generated module, `tool-contracts.json`, the runtime container
artifact and a transient `data-tool-entities` stream part to the app's own
browser. Nothing is sent to the Platform, and nothing here disables a tool.

## The declaration

```ts
import { defineEntity } from 'glirastes';

const Playlist = defineEntity({ type: 'playlist', id: 'playlist_id', name: 'displayName' });
const Version = defineEntity({ type: 'playlist-version', id: 'version_id', fallback: 'versionNumber' });
const Revision = defineEntity({ type: 'channel-revision', id: ['channelKey', 'rev'] }); // composite key
const Channel = defineEntity({ type: 'channel', id: 'key', name: 'title', idKind: 'speaking' });
```

| Field | Meaning |
| --- | --- |
| `type` | Lower-case type name (`playlist`, `channel-revision`), at most 64 characters |
| `id` | The field of the record's own id, or up to 4 fields of a composite key in their order. A value is a non-empty string (at most 200 characters) or a safe integer |
| `name` | The field that names the record for a person (optional: a version has none) |
| `fallback` | A short field that tells nameless records apart (`versionNumber`, `rev`); the card shows `Version number 3` |
| `idKind` | `opaque` (the user never types it: UUID, database integer) or `speaking` (the user types it: order number, ticket key). Default: `speaking` for `key`, `slug` and `code`, else `opaque` |

On a tool, `outputEntities` places declarations at a result `path` as the
model sees the result (a list answer travels under `data`): `playlists[]` (the
entries), `data[].owner` (one object per entry), `''` (the result itself).
Without `path`: the entries of the largest array, or the result itself.
`inputEntities` names the arguments that hold an id: `{ type, args, role?, idKind? }`
with `args` an argument path or the paths of a composite key, `role`
`target` (default), `parent` or `reference`.

```ts
defineEndpointTool({
  id: 'playlists.list', /* … */
  outputEntities: [{ ...Playlist, path: 'playlists[]' }, { type: 'playlist-item', id: 'item_id', name: 'displayName', path: 'playlists[].items[]' }],
});
defineEndpointTool({
  id: 'playlistsVersionsRollback.create', /* … */
  inputEntities: [{ type: 'playlist', args: 'playlist_id', role: 'parent' }, { type: 'playlist-version', args: 'version_id' }],
});
```

An invalid declaration throws in `defineEntity`, `defineTool` and `endpointToolToTool`.

## Where to declare (generated tools)

Highest first; a higher level replaces a lower one for the same path (or argument list):

1. **Tool code:** `outputEntities` / `inputEntities` of a `contract.ts` entry (Next.js, NestJS).
2. **OpenAPI operation:** `x-glirastes-entities` (a list of declarations with `path`); `x-glirastes-entity-ref` `{ type, role?, idKind? }` on a parameter (or its `schema`), and `x-glirastes-id-kind` (`opaque`/`speaking`).
3. **OpenAPI response schema:** `x-glirastes-entity` on a component schema (no `path`: it follows from where the schema sits in the response; `type` defaults to the component name in kebab case, `PlaylistVersion` → `playlist-version`).
4. **App-wide:** `identity` in `.glirastes/tools.json`:
   ```json
   "identity": {
     "entities": { "channel": { "id": "key", "name": "title", "idKind": "speaking" } },
     "tools": { "users.list": { "output": [{ "type": "user", "id": "id", "name": "displayName", "path": "users[]" }] } }
   }
   ```
   `entities.<type>` applies to each response schema of that derived type without its own `x-glirastes-entity`, else (no schema) to a GET tool whose last static route segment, singular, is the type. `tools` takes a definition id or model name.
5. Nothing: the runtime guesses from field names.

FastAPI: `model_config = ConfigDict(json_schema_extra={'x-glirastes-entity': {...}})` on a model,
`openapi_extra={'x-glirastes-entities': [...]}` on a route,
`Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'channel'}, 'x-glirastes-id-kind': 'speaking'})` on a parameter
(see `examples/vue-fastapi/api/app/library.py`).

### Findings (`glirastes tools refresh`)

| Code | Severity | When | Effect |
| --- | --- | --- | --- |
| `entity-declaration-invalid` | warning | A declaration is not of the shape above | Ignored; guessed meanwhile |
| `entity-id-conflict` | error (non-blocking: outputs are written, `refresh` exits 1 unless `--keep-going`) | Two different declarations at one path and level, or one type declared with different ids in two tools | The tool stays enabled; at one path the first is used, across tools each keeps its own |
| `entity-declaration-overridden` | warning | A higher level replaced a lower one at a path | The higher one is used |
| `entity-field-unknown` | warning | A declared field is not a property of the (closed) schema at that path | Kept |
| `entity-field-denied` | warning | The output fields deny a declared field | The denial wins: a denied name or fallback is dropped, a denied id drops the declaration |
| `entity-declaration-unused` | warning | A tools.json `identity` entry applies to no tool | Ignored |
| `entity-ref-invalid` | warning | An input reference whose args are no parameters of the tool | Ignored |

## What it changes (only for a tool with a declaration)

- **Result overview:** the entries of the declared array keep their id, name
  and fallback fields, whatever their size; the id-like guess (every `…Id`
  field) is not applied to them, so a foreign key goes first. A declaration
  with `path: ''` keeps the result's own id at the root.
- **History compaction:** entries beyond `maxItems` keep exactly the declared
  id fields (all parts of a composite key) and the name, else the fallback;
  `_history.keys` names them in that order.
- **`read_result`:** entries read below the declared array carry the declared
  fields.
- **`hideIds`:** declared opaque ids are learnt with their name, integers and
  short strings too, but those only leave the answer with an id prefix
  (`(ID: 3)`, `ID 3`), never as a bare number. Speaking ids stay readable.
- **Approval card:** a declared record is named by its declared id, also a
  number or a composite key (`4/1`), and only for an argument of its type
  (user 1 is never named after playlist 1). A declared argument gets one
  subject with `type`, `role`, `idKind` and `provenance` (`tool-result`,
  `mention`, `user-message`). An id the user typed verbatim (a speaking key
  case-insensitively, shown as the call carries it; not a composite key, whose
  text does not tell its parts apart) is `seen` with
  `provenance: 'user-message'`; an unknown speaking id gets no warning. `seen`
  subjects carry `fallbackField` next to `fallback` (deprecated, still filled).
  No new `status` values. This is the browser's guess from the chat history;
  with a declared read source the server looks the record up instead, and
  the guess is only the fallback: see [approval-subjects.md](approval-subjects.md).
- **Entity links:** the declared records of any tool result with a `type` and
  a name become known references, also nested. A composite key's reference
  has the readable id (`lobby/503`) and its parts in `data.idValues`.

Composite keys are compared by their parts, never by the readable `a/b` form,
so `["a/b", "c"]` and `["a", "b/c"]` stay two records.

The browser gets the declarations from the built-in chat handler
(`data-tool-entities`, only sent when a tool declares something) or from
`AiChatProvider`'s `entityDeclarations` prop (by model-facing tool name; wins
per tool), e.g. for a server that is not `createAiChatHandler`.

## Entity link options

| Option | Default | Meaning |
| --- | --- | --- |
| `knownEntities(context)` | none | Further references the app derives from the messages (`context.messages`) |
| `ambiguousNames` | `'text'` | Two references with one name: `text` leaves the name as text (default since 0.18.0), `first` links the first found (the default before). Name matches only: a `{{mention:type:id:label}}` marker or `@` mention carries its id and becomes a chip by that id although another record has the same name (`verifyMentions` still applies) |
| `resolveAmbiguous(label, candidates)` | none | Picks the reference for a shared name (name matches only, as `ambiguousNames`); `undefined` leaves it as text |
| `scope` | `'all'` | `assistant`: only the assistant's text is linked, never a user's message |
| `ChatEntityReference.data` | none | Free data from `resolve`, `knownEntities` or `resolveAmbiguous`, passed to `open` |
| `mentionMarkers` | `'plain'` | `{{mention:type:id:label}}` markers in an assistant's text: `plain` renders such a text part without Markdown, each marker a chip (as before); `markdown` keeps the Markdown and puts each marker as an inline chip inside it (a custom `Markdown` keeps them through `markdownComponents`; without them it shows the label) |
| `verifyMentions` | `true` | With `mentionMarkers: 'markdown'`: a marker becomes a chip only for an id the conversation showed as a record by declaration (`outputEntities` of a tool result, a `@` mention the user picked, a hit of an entity search tool), never by a field-name guess; otherwise its label stays text. `false` turns the check off |
| `unresolvedMentions` | `'keep'` | An assistant's marker whose id the conversation never showed, see below. `'keep'` (as before), `'text'` or `'search'` |
| `unresolvedMention(marker)` | none | Decides `'keep'`, `'text'` or `'search'` per such marker; `undefined` (or a throw) leaves it to `unresolvedMentions` |

### A marker with a wrong id

A model sometimes writes a `{{mention:type:id:label}}` marker whose name is
right but whose id is not (one character off, cut short, invented). The id
is "unresolved" when the conversation never showed that `type`/`id` pair as
a record, by the same check as `verifyMentions`: a declared record of a tool
result (`outputEntities`), a `@` mention the user picked, or a hit of an
entity search tool. The id is compared as text, exactly; nothing assumes a
shape (UUID, integer and slug ids are treated alike; an integer `42` in a
result and `42` in a marker are one id).

What happens without the option (`'keep'`, the default):

| `mentionMarkers` | Unresolved marker |
| --- | --- |
| `'plain'` (default) | A chip with the marker's id; clickable when the type can be opened, and opens that (wrong) id |
| `'markdown'` with `verifyMentions` (default) | Its name as plain text |
| `'markdown'` with `verifyMentions: false` | A chip with the marker's id |

`unresolvedMentions` changes this in both modes, for the assistant's markers
of a **declared type** only (an entity of `chatInteractions`, or a `type`
the tools' `outputEntities` declare):

- `'text'`: the name as plain text, no chip, no link.
- `'search'`: the entity's own `search` of `chatInteractions` runs for the
  name, in the browser with the user's session, against the app's endpoint
  (the same path as the `@` list; the app decides what the user may see,
  nothing goes to the Platform). A chip with the found id appears only when
  exactly one record's label equals the name; in every other case the name
  stays text. A type without an entity `search` (only `outputEntities`)
  stays text.

Name matching (`pickExactNameMatch`, exported): both sides Unicode NFC,
leading and trailing whitespace removed, inner whitespace runs as one
space; then compared case-sensitively and in full. No prefix, substring,
case-insensitive or fuzzy match. Two records (two ids) with that name: no
match, the name stays text. One record listed twice counts once. The search
sees at most 8 hits (`searchEntity`); a second record with the same name
beyond them is not seen.

While the search runs the name shows as text, then the chip replaces it; a
chip never shows first and disappears. One search per type and name
(whitespace-normalised) for the provider's lifetime, also for stored
history and re-renders; a failed search counts as no match until
`chatInteractions` changes. A marker only exists once its closing `}}` has
streamed, so a half-streamed marker is never searched.

Unchanged in every setting: markers in the user's messages (they come from
the `@` list, so their id is seen), `command` markers, markers of types
neither `chatInteractions` nor `outputEntities` declare, and markers whose
id the conversation showed. `unresolvedMention(marker)` gets
`{ type, id, label }` for each marker the option applies to and returns the
policy for it. A name the model writes cannot contain `}` (the marker would
not parse); a `:` in the name is fine, a `:` in the id is not.

