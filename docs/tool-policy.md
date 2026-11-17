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
