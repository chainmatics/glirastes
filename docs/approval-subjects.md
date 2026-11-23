# Approval subjects from the server

Before the approval card of a write call is shown, the server looks the
records the call names up through a **declared read source**, with the
user's own credentials. The card then names the record as the backend knows
it ("Delete playlist *Lobby Loop*"), not as the chat history guesses it. A
call for a record that does not exist (or that this user cannot see) gets no
card at all: the model gets a fixed error and looks the id up.

Without a declaration nothing changes: the card names records from the chat
history (the browser fallback of [entity-identity.md](entity-identity.md)),
the stream is byte for byte the same, approval ids stay `v1`.

It builds on the declared identity ([entity-identity.md](entity-identity.md)):
the write tool's `inputEntities` say which arguments hold an id and of which
type; the read tool's `outputEntities` say how its answer is read.

## Declaring it

**1. The read source, once per entity type** (`entityLookup` on the read tool):

```ts
defineEndpointTool({
  id: 'playlists.get', method: 'GET', path: '/playlists/:playlist_id', /* … */
  outputEntities: [{ type: 'playlist', id: 'playlist_id', name: 'displayName', path: '' }],
  entityLookup: { type: 'playlist', params: { playlist_id: 'playlist_id' } },
});
```

| Field | Meaning |
| --- | --- |
| `type` | The entity type, as in `inputEntities`; the read tool must declare it in `outputEntities` |
| `params` | Read parameter → what fills it: an id field of the entity (`'playlist_id'`; a composite key names each part), or `{ ref: '<type>' }` for the id of the call's reference of another type (the parent playlist of a version) |
| `const` | Fixed parameters (`{ limit: 50 }`, a page size) |
| `result` | `one` (the answer is the record) or `list` (the record is searched on one page). Default: `list` when the entity's declared path reads entries (`[]`), else `one` |
| `complete` | Only `list`: the page holds every record that could match (no paging, or the parameters narrow it to the id). Then an id that is not on it does not exist |
| `idCase` | `exact` (default) or `ignore-case`: the backend treats ids that differ only in case or surrounding whitespace as one record. Without it such a near match is never a found record |

Parameter names are plain names; `__proto__`, `constructor` and `prototype`
are refused. `lookupEffect: 'read'` stands only on a POST (or GET, HEAD, a
tool without a method); on a DELETE, PUT or PATCH it throws at definition,
is dropped by `tools refresh` (`approval-subject-invalid`) and is never a
source at runtime.

A list source reads **exactly one page** (no paging), at most 200 entries are
searched. An id that is not on a page that is not `complete` is **not
checkable** (a card with a warning), never "does not exist".

**2. The write tool** needs nothing new: its `inputEntities` of role `target`
and `parent` are looked up. Adjust per tool with `approvalSubject`:

```ts
approvalSubject: {
  refs: ['playlist_id'],          // which inputEntities (argument paths; a composite key joined with ,; a list of ids too). Default: target + parent; a `reference` only when named
  onUnavailable: 'block',         // default 'warn': a card with a warning; 'block': no card, the model gets approval_subject_unavailable
  onForbidden: 'warn',            // default 'deny': a 403 is refused like a 404; 'warn': a card "not checkable"
  recheck: 'exists',              // default 'none'; 'exists' | 'unchanged': check again before the approved call runs
  preview: { /* see below */ },
}
// approvalSubject: false turns the lookup off for this tool.
```

An argument that holds a list of ids is declared like a single id; each id
in it is looked up (see *Lists of ids* below):

```ts
// teams.create: leader and members are references, so refs names them
inputEntities: [{ type: 'user', args: 'leaderId', role: 'reference' }, { type: 'user', args: 'memberIds', role: 'reference' }],
approvalSubject: { refs: ['leaderId', 'memberIds'] },
// teams/[teamId]/members POST: the added users are the target (looked up by default)
inputEntities: [{ type: 'team', args: 'teamId', role: 'parent' }, { type: 'user', args: 'userIds' }],
```

**3. Where to declare** (highest first; a higher level replaces a lower one per field):

1. Tool code: `entityLookup`, `approvalSubject`, `lookupEffect` of `defineEndpointTool` or a `contract.ts` entry (Next.js, NestJS).
2. OpenAPI operation: `x-glirastes-entity-lookup` (one lookup or a list), `x-glirastes-approval-subject` (object or `false`), `x-glirastes-lookup-effect: read`. FastAPI: `openapi_extra`; NestJS: `@ApiExtension`.
3. `.glirastes/tools.json`: `identity.lookups.<type> = { tool, params, const?, result?, complete? }` (the key is the type, `tool` a definition id or model name) and `approvalSubjects.tools.<tool> = { … } | false`.

There is no guessed source: a wrong guess would show a foreign name.
`glirastes tools refresh` suggests one (`approval-subject-suggested`) when a
write route has a sibling `GET` on the same path that declares the type.

FastAPI (`examples/vue-fastapi/api/app/library.py`):

```python
@router.get('/{playlist_id}', response_model=Playlist, openapi_extra={
    'x-glirastes-entity-lookup': {'type': 'playlist', 'params': {'playlist_id': 'playlist_id'}},
})
@router.get('/{playlist_id}/versions', openapi_extra={
    'x-glirastes-entity-lookup': {'type': 'playlist-version', 'params': {'playlist_id': {'ref': 'playlist'}}, 'complete': True},
})
@router.get('', response_model=UserList, openapi_extra={   # one page: a user not on it is "not checkable"
    'x-glirastes-entity-lookup': {'type': 'user', 'params': {}, 'const': {'limit': 50}},
})
```

### Findings (`glirastes tools refresh`)

| Code | Severity | When |
| --- | --- | --- |
| `approval-subject-invalid` | error, non-blocking (`--keep-going` writes every output; the declaration is dropped, the tool stays enabled) | A declaration fails its shape; a source that is not provably read-only (not GET/HEAD and no `lookupEffect: 'read'`) or asks for approval; a lookup type the source does not declare in `outputEntities`; a param that is no id field or no parameter of the source; a preview source that is not a read tool; `refs` that match no reference; a composite key one of whose arguments the input schema types as a list (not looked up) |
| `approval-subject-field-denied` | warning | A preview field the source's output fields deny: the denial wins, the field is dropped |
| `approval-subject-unbounded-list` | warning | A list lookup without params, without `const` and not `complete` |
| `approval-subject-unused` | warning | A lookup no write tool references, a tools.json entry that names no tool |
| `approval-subject-suggested` | warning | See above; never applied automatically |

None of them changes the authorization, the approval or the enablement of any tool.

## Preview (at most three values)

A write tool can show what the approved call would do, read from a source the
call's arguments fill:

```ts
approvalSubject: {
  preview: {
    tool: 'preview_assignment',                         // model name or definition id
    params: { playlist_id: 'playlist_id', group: 'group', dryRun: { const: true } }, // argument paths of the write call, or { const }
    fields: [
      { path: 'devices', label: { en: 'Devices', de: 'Geräte' }, format: 'count' }, // count: length of an array
      { path: 'summary', label: 'Summary' },                                         // text | number | count | date
    ],
  },
}
```

Preview values show the state at the time of the approval request; they are
not rechecked when the approved call runs (`recheck` compares the subjects
only).

A preview never refuses a call: a failed preview is only "could not be
loaded" on the card.

### POST dry-run sources: `lookupEffect: 'read'`

What counts is the **declared** effect, not the HTTP method. A `POST
/playlists/:id/assignment/preview` that needs a body can be a preview or
lookup source when it states `lookupEffect: 'read'` (OpenAPI
`x-glirastes-lookup-effect: read`): "a call through it changes nothing". The
`params` build its body (non-path parameters of a POST endpoint tool travel
in the body).

This is a separate statement, read **only** for lookups and previews. It
never lowers the tool's own risk class or approval when the model calls it:
the dry-run keeps `requiresApproval` (and any policy) exactly as without it
(see [tool-policy.md](tool-policy.md)). For a lookup it lifts only the
approval the SDK derives locally (the POST/write default, a local
`needsApproval`): the server does not ask the user to approve the dry-run.
**An approval a signed Platform policy requires for the source (governed
mode) is never lifted**: the source is then not available, the subject or
preview is "not checkable" (`source_unavailable`), with the card's warning
or, under `onUnavailable: 'block'`, a refused call. Authorization (role,
policy, revocation) always applies. A POST without the statement is never a
source.

## What happens at runtime

The lookup runs in the built-in stream handler, after the decision that the
call needs approval (the tool's own `needsApproval` or the managed policy)
and before the approval request is sent. For each looked-up reference:

- **Source**: the declared read tool of this request's tool set (the
  RBAC-filtered registry). Never one the model names. Only the declared
  `params` (filled from the *validated* write input) and `const` are sent,
  checked against the read tool's input schema.
- **Credentials**: the request's transport (`callEndpoint`): the user's
  forwarded credentials; in the runtime container the pinned tenant and user
  headers. Never a service account.
- **Authorization**: in a managed turn `ManagedTurnGuard.beforeSubjectLookup`
  for every lookup (also a cached one): fresh principal, fresh revocations,
  pinned agent, manifest and policy, like a tool call. A source the role may
  not use, that is revoked, that the signed policy puts behind an approval,
  or that asks for approval locally without `lookupEffect: 'read'` is not
  called: "not checkable" (`source_unavailable`).
- **Result**: only the read tool's core path: its output schema, its output
  bound (`outputDeniedFields`, app-wide `output.deniedFields`: the denial
  wins) and then the PII shield, so the card gets a value in the form the
  browser gets a result of that tool. No result handle, overview or cut.
- **Match**: by field, the ids in the answer must equal the requested ones
  exactly (a number and its decimal text are one id). A composite key's
  arguments are mapped to the id fields **by name** (the argument path's last
  step equals the id field: `version_id` → `version_id`, in any order); only
  when no argument is named like an id field is the declared `inputEntities`
  order used. Names that disagree are never guessed by position: no lookup,
  "not checkable", and `tools refresh` reports `approval-subject-invalid`.
  Ids that differ only in case or surrounding whitespace match only when the
  lookup declares `idCase: 'ignore-case'`; otherwise such a record is
  `mismatch` ("not checkable"), never named and never taken for "does not
  exist". A different id is `mismatch`, never named. The browser's history
  fallback, which matches a speaking key case-insensitively, is a display hint
  only: it never sets `check: 'found'` or `source: 'server'`.
- **Lists of ids**: an argument that holds a list of ids (`memberIds:
  ['u1', 'u2']`) names one record per distinct id. Each one is its own
  subject, looked up, refused and shown exactly like a single id: a missing
  one refuses the whole call (`approval_subject_not_found`), one that cannot
  be checked is "not checkable" on its own. All of them keep the argument's
  path (`memberIds`, never `memberIds[0]`), so the card shows one line
  "User: Ann, Bob" and the history fallback of that path is replaced as a
  whole. Their order is the order of the list, duplicates dropped. An empty
  list names no record (nothing to check, never a refusal). A list with an
  entry that is no id (an object, `null`, an empty text), with more ids
  than a part holds (100 subjects per call), or a list inside a composite
  key gets no server subject: it is never a passed check (`block` refuses,
  `recheck` refuses), and with `warn` the card keeps the history fallback
  for it.
- **No metrics**: a lookup is no tool call. It records no tool-call metric,
  no `tool_contract_rejected` for a 400/422 of the read tool, and is never
  classified by `classifyToolFailure`.

### Failure matrix

| Case | Default | Option | The model gets |
| --- | --- | --- | --- |
| 404, or a `complete` list without the id | refused, no card | – | `approval_subject_not_found` |
| 403 | refused, no card (as 404) | `onForbidden: 'warn'`: a card "not checkable" (`forbidden`) | the same text as for 404 |
| 400 / 422, or an id the read tool's schema rejects | refused | – | `approval_subject_invalid_id` |
| Timeout (`timeout`) | card with warning | `onUnavailable: 'block'` | nothing, or `approval_subject_unavailable` |
| 5xx, network error, 401 (`unavailable`) | card with warning | `block` | as above |
| 429 (`rate_limited`); the source is not asked again in this request | card with warning | `block` | as above |
| Schema mismatch, withheld, answer without the declared id (`invalid_response`) | card with warning | `block` | as above |
| Different id in the answer (`mismatch`) | card with warning, never named | `block` | as above |
| Not on the one page of a list that is not `complete` (`not_in_page`) | card with warning, never "does not exist" | `block` | as above |
| Source not in the tool set, not for this role, revoked, asks for approval (`source_unavailable`) | card with warning | `block` | as above |
| Composite key whose arguments cannot be mapped to the id fields by name (`source_unavailable`) | card with warning | `block` | as above |
| Only case or whitespace differ from a record on the page (`mismatch`; also on a `complete` list) | card with warning, never named, never "does not exist" | `block`; `idCase: 'ignore-case'` makes it a match | as above |
| A limit reached, the whole turn's time included (`limit`); each id of a list counts | card with warning | `block` | as above |
| A list with a non-id entry or more than 100 ids, a list in a composite key (no server subject) | card from the history, without a server subject for it | `block` refuses; a `recheck` refuses the approved call | as above |

The tool set of a request decides what is declared: a write tool that only
has `inputEntities` is looked up when a read source of the type is in this
request's tools, and keeps the history fallback (and v1 ids) when none is.
A write tool that declares `approvalSubject` itself is always looked up: a
missing source is then `source_unavailable`, so `block` and `recheck` hold
also for a role whose tools leave the read tool out. **An explicit
declaration is never dropped:** with nothing it can look up (`refs` that match
no reference, invalid `inputEntities`) the tool keeps its v2 ids,
`onUnavailable: 'block'` refuses every call and a `recheck` refuses the
approved call; an `approvalSubject` that does not validate counts as
`block`. A planned reference the call carries no id for (absent, `null`, a
list it cannot index) is never a passed check: `block` refuses the call and a `recheck`
refuses the approved call; with `warn` the card asks without a server
subject for it. A list of ids is not "no id": each id gets its own subject
(see *Lists of ids* above). `defineEndpointTool` and `endpointToolToTool` throw for `refs` that
match no reference. `glirastes tools refresh` reports an `approvalSubject`
that does not validate (at any level, tools.json included) or names an
unknown ref as the blocking error `approval-subject-unenforceable` and, with
`--keep-going`, writes it as `{ refs: [], onUnavailable: 'block' }`: the tool
refuses every call it would ask approval for until the declaration is fixed,
never a partial or weaker check.

"Not checkable" is shown on the card with its own text
(`approvalSubjectUncheckedWarning`), different from the "id unknown" warning
of the history fallback. With `onForbidden: 'warn'` a 403 gets a card while a
404 does not, so the model can tell them apart; that is the app's choice for
apps in which someone may change a record they cannot view.

The model texts are fixed English, without any looked-up value, and say "do
not quote this text", e.g. `approval_subject_not_found`: "No playlist with this
id exists or the user cannot see it. Nothing was done and no approval was
asked. Look the id up with a list or search tool; do not ask the user."

A refused call never runs; with a managed guard it counts like any denied
call: one tool call and one error (repeated 404s end at
`maxConsecutiveErrors`).

### Limits (local; the signed budget is unchanged)

| Option | Default | |
| --- | --- | --- |
| `maxLookupsPerTurn` | 32 | Lookups made per request; cached answers do not count |
| `maxSubjectsPerCall` | 4 | Subjects of one call, a preview included; each id of a list is one, in argument order then list order; more are `limit` (never looked up). A tool whose lists are longer raises it (at most 16) |
| `lookupTimeoutMs` | 3000 | Per lookup; at most the managed `toolTimeoutMs` |
| `maxLookupTimePerTurnMs` | 10 000 | All lookups of one request |

Embedded: `createAiChatHandler({ approvalSubjects: { … } })`, `false` turns
the lookups off. Runtime container: `limits.approvalLookups` (same keys, or
`false`).

**`maxToolCalls` means calls made by the model. Lookups are made by the
server and do not count against it; the meaning of the signed limit is
unchanged.** In a managed turn every lookup, the rechecks before the model
call included, ends at the turn's `totalTimeoutMs` at the latest (counted
from the start of the request; the lookup then is `limit`), and the
request's abort signal cancels them. Without a managed turn there is no
whole-turn limit; the lookup limits above bound them.

Within one request answers are cached by source and parameters: 20
`delete_channel` calls checked against `list_channels` make one read; 20
through `get_playlist` make 20. Nothing is cached across requests.

### `recheck`

`none` (default): the backend checks existence and rights when it writes;
the approval lives at most 15 minutes. `exists`: the approved call's records
are looked up again before it runs; a missing one refuses it
(`approval_subject_gone`). `unchanged`: additionally the records must still
match the digest signed into the approval id (`approval_subject_changed`).
With `onUnavailable: 'block'` a recheck that cannot check refuses it
(`approval_subject_unavailable`); with `warn`, `exists` runs it, while
`unchanged` compares every subject, so a record that was found at the
approval and cannot be checked now counts as changed. The subjects of a
list are bound in the order of the approved input (which the approval id
binds too), so the same call always gives the same digest. Rechecks count against
the same limits; authorization, execution and the PII shield of one lookup
share one `lookupTimeoutMs`.

## Format changes (declared tools only)

| # | Change |
| --- | --- |
| F1 | A persistent UI stream data part right before `tool-approval-request`: `{ type: 'data-approval-subjects', id: <toolCallId>, data: { v: 1, toolCallId, subjects: ServerApprovalSubject[], preview?: { check, reason?, fields: [{ key, label, value, format? }] } } }`. Subject: `{ type, role, id, ids, path, status: 'named' \| 'seen' \| 'ambiguous' \| 'unknown', check: 'found' \| 'unchecked', reason?, name?, fallbackField?, fallbackValue?, candidates?, idKind }`; each id of a list argument is a subject of its own with the argument's `path`; at most 100 subjects per part. It is for the browser and custom clients (`message.parts`) only; the server never sends it to the model (filtered explicitly before `convertToModelMessages`) and never reads it back. |
| F2 | Approval id `glirastes-approval.v2.<issuedAtMs>.<expiresAtMs>.<nonce>.<subjectDigest>.<mac>`; `subjectDigest` is a 16-byte HMAC-SHA-256 of the canonical subjects (type, role, path, ids, status, name, fallback) under a key derived from the approval secret; the MAC covers it next to everything v1 covers, under the tag `v2`. Verify takes v1 and v2; for a declared tool a v1 id is refused (`approval_not_issued`). Single use and the store are unchanged. Preview values are display only and not in the digest. |
| F3 | New tool errors for the model (the chat shows a fixed text, `output-error`): `approval_subject_not_found`, `approval_subject_invalid_id`, `approval_subject_unavailable` (only with `block`); approval denials `approval_subject_gone`, `approval_subject_changed`, `approval_subject_unavailable` (recheck). |
| F4 | `ApprovalSubject` (React) gains optional `source`, `ids`, `fallbackValue`, `preview`, `check`, `reason`; `PendingApproval` gains `preview` and `previewCheck`. `PendingApproval.subjects` prefers the server's subjects; the history guess fills in only where the server sent nothing (and stays as the display of an unchecked subject). New labels `approvalSubjectUncheckedWarning`, `approvalSubjectsUncheckedWarning`, `approvalReferenceIdNote`, `approvalPreviewUncheckedNote` (English, German; `locales` overrides). |

Looked-up names are untrusted content: never in the model context, plain
text on the card (no markdown, links or entity links), at most 200
characters. Removed: control characters (C0, DEL, C1), line and paragraph
breaks, bidi overrides, isolates and marks (U+202A–U+202E, U+2066–U+2069,
U+200E, U+200F, U+061C), zero-width characters and the BOM, invisible
operators (U+2060–U+2064), the soft hyphen, U+180E, variation selectors
(U+FE00–U+FE0F), tag characters (U+E0000–U+E007F) and the Hangul fillers
(U+115F, U+3164). Combining marks stay: many languages need them. The browser
sanitizes again when it reads the part, and fills label templates with
literal values (no replacement patterns).

## Where it does not apply

- **A custom `streamHandler`** gets no lookups, no v2 ids, no `block` and no
  `recheck` for declared tools: its cards use the history fallback. Use the
  built-in stream handler for tools whose `block` or `recheck` matters.
- **Direct commands and entity actions** make no lookups. A declared tool
  without `block` or `recheck` keeps v1 and the history fallback there. A
  tool that declares `onUnavailable: 'block'` or a `recheck` is refused by a
  direct command or entity action (`approval_subject_check_required`), so a
  declared safety option is never skipped; the model path still runs it
  with its checks. With `approvalSubjects: false` the app has turned the
  lookups off, and nothing is refused.
- A composite key with a list argument gets no server subject (`tools refresh` reports it).
- Nothing goes to the Platform: manifest, policy and metric events are unchanged; declarations are field and tool names only.

## Upgrading

- Without declarations: nothing to do.
- **Several instances behind a load balancer: deploy the new version everywhere first, then declare.** An older instance refuses a `v2` id as `approval_not_issued` (its parser only accepts `v1`, so it never runs a v1 check on it); an approval issued by a new instance and answered on an old one is then simply refused, never run unchecked. The runtime container is single-instance.
- Runtime container: the declarations are part of the immutable artifact, which carries the exact SDK version: **rebuild the artifact** (`glirastes tools refresh`, then the artifact build) after declaring.
- Custom approval cards read `source`, `check`, `reason` and `preview` of `ApprovalSubject`.
- Lists of ids: a part may hold up to 100 subjects. A browser on an older version drops a part with more than 20 and shows the history fallback for that call; nothing is approved unchecked by it.
