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
  case-insensitively, shown as the call carries it) is `seen` with
  `provenance: 'user-message'`; an unknown speaking id gets no warning. `seen`
  subjects carry `fallbackField` next to `fallback` (deprecated, still filled).
  No new `status` values.
- **Entity links:** the declared records of any tool result with a `type` and
  a name become known references, also nested.

The browser gets the declarations from the built-in chat handler
(`data-tool-entities`, only sent when a tool declares something) or from
`AiChatProvider`'s `entityDeclarations` prop (by model-facing tool name; wins
per tool), e.g. for a server that is not `createAiChatHandler`.

## Entity link options

| Option | Default | Meaning |
| --- | --- | --- |
| `knownEntities(context)` | none | Further references the app derives from the messages (`context.messages`) |
| `ambiguousNames` | `'first'` | Two references with one name: `first` links the first found (as before), `text` leaves the name as text |
| `resolveAmbiguous(label, candidates)` | none | Picks the reference for a shared name; `undefined` leaves it as text |
| `scope` | `'all'` | `assistant`: only the assistant's text is linked, never a user's message |
| `ChatEntityReference.data` | none | Free data from `resolve`, `knownEntities` or `resolveAmbiguous`, passed to `open` |
