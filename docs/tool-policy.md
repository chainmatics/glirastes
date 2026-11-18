# Tool policy

`glirastes tools refresh` derives every tool from the code with deterministic
defaults: reads run directly, writes ask first, deletes and anything external
or financial always ask. Two layers may change a tool, and across all layers
the strictest value wins.

| Layer | Where | Written by |
| --- | --- | --- |
| Code defaults | method, destructive path tokens, declared effects, declared roles (OpenAPI `x-glirastes-roles`) | the generator |
| Local policy | `.glirastes/tool-policy.json`, committed | the developer or the CLI, never an agent |
| Platform decisions | signed `toolOverrides` of the deployed configuration | owners and admins of a connected app |

## Risk tiers and confirmation

| Tier | Risk classes | Confirmation |
| --- | --- | --- |
| 0 | `safe-read` | off |
| 1 | `read-sensitive` | off |
| 2 | `write` | on; a reviewed, pinned entry may switch it off |
| 3 | `delete`, `financial`, `external`, `unknown` | always on, enforced by the runtime |

Every layer may disable a tool, raise its risk class, narrow its roles and
require confirmation. No layer enables a tool the code disabled or lacks,
lowers a risk class or adds roles.

Roles are any-of: a caller needs one of the tool's `allowedRoles`. An empty
list means no additional restriction; the endpoint's own authorization applies
either way. Roles the code declares (`x-glirastes-roles`, see below) are the
code default; `tool-policy.json` and the Platform intersect with it, so a role
listed there but not in the code grants nothing, and a disjoint intersection
disables the tool (nobody). When `tool-policy.json` causes that, the refresh
reports `policy-roles-disjoint` (warning) with the tool and both role sets
(not for a tool that is already disabled, e.g. by `"enabled": false`);
`glirastes tools resolve --print` shows it to the developer. The setup artifact names the roles' origin
`code-default` while the code roles apply and `local-policy` once
`tool-policy.json` narrowed them.

## OpenAPI source: selection and `x-glirastes-*` extensions

By default the `openapi` source turns every supported operation that no rule
excludes into a tool. A backend can instead mark in its export which
operations become tools, and with which name, group and roles:

```json
{"kind": "openapi", "document": "api/openapi.json", "selection": "opt-in"}
```

`selection` is per source: `all` (the default, also for the bare `"openapi"`
string) or `opt-in`. The extensions are read on the operation object only
(not on the path item):

| Extension | Type | Effect | Invalid value |
| --- | --- | --- | --- |
| `x-glirastes-tool` | boolean | `true`: with `opt-in`, the operation may become a tool. `false`: never a tool, in both modes (excluded as `opted-out`) | Finding `tool-marker-invalid` (warning, also on an operation that is no tool); read as absent |
| `x-glirastes-name` | string | The tool name, e.g. `list_tags` or `tags.list`. Wins over the derived name and over the name an earlier inventory kept; no `refresh --adopt` needed | Not a valid tool name: `definition-id-invalid` (warning), derived name. Two operations with one name: `definition-id-conflict` (error). A name another tool held before: `definition-id-reassigned` (warning), the name moves |
| `x-glirastes-group` | string | The module, above `tool-semantics.json` and any derivation | Finding `tool-group-invalid` (warning); module derived |
| `x-glirastes-roles` | string array | Code default of `allowedRoles` (any-of); `[]` means no restriction; duplicates are removed. `tool-policy.json` roles that share none with it disable the tool: `policy-roles-disjoint` (warning) | Not a list of at most 50 non-empty role names: `tool-roles-invalid` (needs attention), the tool stays disabled |
| `x-glirastes-effect` | `read`, `write`, `destructive`, `external`, `financial` | Declared effect; can only raise the risk class | `contract-effect-invalid` (needs attention); ignored |
| `x-glirastes-max-result-chars` | integer, 1000 to 200000 | Upper bound of the tool's serialized result for the model; wins over the handler's `maxResultChars` (default 16,000). Local only: written to `tool-contracts.json` and the generated module, never to the Platform | Finding `max-result-chars-invalid` (warning); ignored, the handler's limit applies |
| `x-glirastes-output-allowed-fields` | string array of field paths (`data[].name`, `meta`; no index; at most 200 of at most 200 characters) | Upper bound: a successful result shows only these fields (and `success`, `uiAction`), on every channel, before the PII shield, result handles and the size limit; new backend fields stay hidden until listed. Reduces the output contract. Local only, never sent to the Platform. See [concepts](concepts.md#output-fields-upper-bound-and-default-view) | `output-allowed-fields-invalid` (needs attention): the tool stays disabled (fail closed). A path the response schema does not have: `output-field-unknown` (warning) |
| `x-glirastes-output-denied-fields` | string array of field paths, or `**.<key>` (any depth); app-wide patterns from `output.deniedFields` of `.glirastes/tools.json` are joined in | Part of the same upper bound: these fields (and everything below them) are never shown; wins over allowed and default fields. `**.fileUrl` removes every `fileUrl` at any depth, also at the top level | `output-denied-fields-invalid` (needs attention): the tool stays disabled. Unknown path: `output-field-unknown` (warning: a misspelt path excludes nothing) |
| `x-glirastes-output-default-fields` | string array of field paths | The fields the first answer shows, also below the limit; the rest stays readable with `read_result` (without a result store: not readable, the answer says so) | `output-default-fields-invalid` (warning); ignored. Outside the allow-list: `output-default-fields-outside-allowed`; denied: `output-default-fields-denied` (warnings; not shown) |
| `x-glirastes-ignore` | `true` | Never a tool (excluded as `ai-ignore`) | – |

Precedence: an operation is first checked for an unsupported method or path,
the default rules (`auth-route`, `webhook`, `cron`, `callback`, `health`,
`catch-all`, `chat-handler`, `stt-handler`), the `exclude` entries of
`tool-policy.json`, `x-glirastes-ignore` and an unsupported (non-JSON) body.
Any of these wins over the marker and keeps its reason. Only the remainder is
excluded as `opted-out` (`x-glirastes-tool: false`) or, with `opt-in`,
`not-opted-in` (no `x-glirastes-tool: true`); both have origin `code`. An
operation marked `x-glirastes-tool: true` that an earlier rule excludes is
reported as `opt-in-excluded` (warning) with the rule's name, never silently.
`glirastes tools resolve --print` lists `opt-in-excluded` and
`tool-marker-invalid` as items to fix in the OpenAPI document, also when the
operation is no tool.
The other extensions of an operation that is no tool are not read: roles on
hundreds of protected non-tool operations report nothing.
`glirastes tools refresh` prints the `not-opted-in` operations as one counted
line; `.glirastes/tool-report.json` lists each of them.

The `description` of a path or query parameter becomes the `description` of
that input property, which the model reads when it fills the call; it wins over
a `description` inside the parameter's `schema` (which stays when the parameter
has none), also for `$ref` parameters and schemas (the shared component is not
changed). Write what the model must know there, e.g. "Omit to get all
playlists" for an optional `limit`. With NestJS:
`@ApiQuery({ name: 'limit', required: false, description: 'Omit to get all playlists' })`.
Header and cookie parameters are no tool input. A parameter's `example`,
`examples` and `deprecated` are not passed on (an `example` inside its
`schema` is).

An operation whose success responses declare `204` and no `content` (no other
2xx response with content) gets the output contract `{ success: true }`: success
means the action was executed, and there is no result data. This is exactly
what the runtime returns for an empty response, so no `output-contract-opaque`
is reported. A `200` or `201` without `content` alone, only `default` or no
responses keep the finding. @nestjs/swagger writes `"200": { "description": "" }`
(`201` for POST) for any handler without a response decorator; it writes `204`
for `@HttpCode(204)`, or when the handler has other response decorators,
only with `@ApiNoContentResponse()` next to them. Declare both:
`@HttpCode(204) @ApiNoContentResponse()`.

Renaming keeps everything that is keyed on `METHOD /path`: `tool-policy.json`
(`tools`, `exclude`, `acceptedRisk`), `tool-resolutions.json`,
`mcp-tool-names.json` and the tool id never use the name, so adding or
changing `x-glirastes-name` keeps every such entry and the tool id. Removing
the extension later keeps the name the inventory holds (it stays sticky)
rather than switching back to the derived one.

`tool-semantics.json` is the exception. An entry with a `stableKey` follows
the operation; an entry that only has a `name` is matched by the tool name and
does not follow a rename: after `tags.update` becomes `update_tag`, the entry
named `tags.update` describes no tool. And when an `x-glirastes-name` (or a
contract id) takes a name that another tool still holds, the earlier holder is
renamed and the entry matched by that name now describes the new holder. The
refresh reports this once as `definition-id-reassigned` (warning, naming both
operations; it also appears in `glirastes tools resolve --print`). Before
renaming, give the affected entries a `stableKey` (`"GET /api/tags"`), or move
them to the new name in the same change; if the takeover was not intended,
choose a name no other tool holds.

An entry that matches no tool, by `stableKey` or by `name` (a changed path or
method, a rename), is reported as `semantics-entry-orphaned` (warning, once per
entry, naming only its key; the stableKey variant also names the tool that now
holds the operation's earlier name). Its title, usage hints, synonyms, examples
and presentation are not used until it is re-keyed to `"METHOD /path"` (as in
the tool report) or the current name, or deleted. An entry for an excluded
operation (`not-opted-in`, `x-glirastes-ignore`, ...) is not reported. The
finding is listed by `glirastes tools resolve --print`; like every warning it
fails neither `tools check` nor `--strict`.

### What the model sees when

- Calling a tool: its `description` and the input schema with the property
  descriptions (OpenAPI parameter descriptions included). Whatever must hold
  at call time belongs there.
- `find_tools` results only: `usageHints` (each cut to 300 characters; the
  description there to 500). They are not part of the definition used for the
  call.
- Never: `synonyms` and `examples` feed only the search index (`find_tools`
  and the start set of a turn; examples with the low weight of usage hints)
  and are never shown. `glirastes tools eval` still ranks each example
  against an index without examples, so it keeps measuring how well name,
  description, hints and synonyms find the tool.
- An `examples` list with fewer than 3 (or more than 5) sentences in a language
  rejects the whole `tool-semantics.json` entry (`tool-semantics-invalid`).
- Synonyms weigh second only to the name in the search, above the
  description. A synonym that names a *target* of a collective tool (a
  navigation tool's destinations, a generic "open object" tool's object
  kinds, such as `Playlists` on a navigation tool) pulls that tool into every
  request with the word ("show my playlists"), next to or ahead of the tool
  that actually lists them. Give a collective tool synonyms for the act only
  ("go to", "open page", "navigate"); its targets already reach the search
  through its description and enum.
- A 404 of a route with path parameters (`/playlists/:id`): the failure
  result carries a fixed `hint` naming the parameters (never a value) that
  says the value may not exist or belong to another kind of record, to look
  it up with a list or search tool first, and to tell the user it was not
  found only when no such tool exists or the lookup finds nothing. Name path
  parameters so the model can tell which record they address.

### Where a tool's description comes from

`glirastes tools refresh` takes the first of these that is non-empty, the
same way for endpoint tools (`next-app`, `nest`, `openapi`) and UI tools
(client actions, navigation, filters):

1. `description` of the tool's entry in `.glirastes/tool-policy.json`.
2. The code comment: the JSDoc above the Next.js handler or NestJS method;
   for `openapi` the operation's `description`, else its `summary`; for a
   client action the JSDoc above the registration statement, else above the
   named handler function.
3. The contract description: `description` of the `contract.ts` entry; for
   the generated `ui.navigate` and `ui.filter.<view>` tools a fixed text
   listing destinations or filters.
4. The schema description: `.describe()` of the input schema, else of the
   output schema.
5. `description` of the tool's entry in `.glirastes/tool-semantics.json`.
6. A template from method and path or the tool name, with the warning
   `description-templated`.

So a JSDoc comment currently wins over a description maintained in
`tool-semantics.json`, also for UI tools; a client action takes neither 3
nor 4 today. This order between the code comment and `tool-semantics.json`
is planned to change in the next minor release: a maintained
`tool-semantics.json` entry will win over the JSDoc.

Without a group, a name with a dot keeps its module (the part before the first
dot); a name without a dot (`list_tags`) takes the module from the path
(`GET /api/tags` gives `tags`), and its template labels are built from method
and path the same way ("List tags", "Tags auflisten"), so the verb is not
repeated. This applies to the `openapi` source only, where such a name comes
from `x-glirastes-name`; a contract id without a dot in any other source
(`listTags`) keeps naming its module and label as before.

The runtime container build applies the same selection: with `opt-in` it
validates only the operations marked `x-glirastes-tool: true` and skips every
other one, so an unsupported operation that is no tool no longer fails the
build. A marked operation the container cannot call still fails it.

## Switching a confirmation off locally

A tier-2 relaxation needs a reviewed entry pinned to the tool id and its
current class. It lapses when the code raises the risk above the pin.

```json
{
  "schemaVersion": 1,
  "tools": {
    "PATCH /api/tasks/:id": {
      "requiresApproval": false,
      "reason": "reviewed in PR 42",
      "pin": { "toolId": "<toolId from .glirastes/setup-artifact.json>", "atRiskClass": "write" }
    }
  }
}
```

## Platform relaxations (connected apps)

An owner or admin can switch a tool's confirmation off in the dashboard. The
signed decision takes effect in the running chat only when all of this holds:

1. It is part of a verified configuration and pinned to this tool id at the
   risk class the code reported when it was saved.
2. The tool's effective risk class is at most tier 2 and not above the pin.
   When the code or a later decision raises the risk, the relaxation lapses
   and the tool asks again. Tier 3 and `unknown` never relax.
3. The code report attributes the confirmation to the code default. Anything
   `tool-policy.json` decided is a local lock the Platform never relaxes: an
   explicit `"requiresApproval": true` (also on a tool that asks anyway) and a
   risk raise that brings confirmation.
4. The runner reports relaxation support at registration
   (`capabilities.policyRelaxations`), which it does when it registers with
   its setup artifact. The dashboard shows the relaxation as effective only
   for such runners; everywhere else it stays pending and the tool asks.

To keep a confirmation whatever the dashboard says, lock it:

```json
{
  "schemaVersion": 1,
  "tools": {
    "POST /api/invoices": { "requiresApproval": true, "reason": "always confirm invoices" }
  }
}
```

After `glirastes tools refresh` the code report names the confirmation
`local-policy`. `glirastes tools status` shows each asking tool as
`asks first, Platform may relax` or `asks first, locked in tool-policy.json`
(tier 3 just `asks first`).
