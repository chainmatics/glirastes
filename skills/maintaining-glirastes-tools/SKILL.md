---
name: maintaining-glirastes-tools
description: Use when glirastes tools refresh reports findings, a tool needs attention or is disabled, a route, OpenAPI export, page, filter or client action changed, a configured runtime artifact needs rebuilding, or the tool policy must be reviewed.
---

# Maintaining Glirastes Tools

The app's code is the tool catalogue. The source-derived generator
(`glirastes tools refresh`) turns route handlers, pages, URL filters and client
actions into tools; where the code does not say enough, it prints a work list
for you, the app's coding agent. The CLI generator never calls a model: you resolve the
findings, the next refresh checks every entry with the same rules, whoever
wrote it, and an invalid entry is ignored (`resolution-rejected`) while the tool
keeps its fallback.

The chat runtime does call the app's model provider. For a configured runtime
container, use the artifact workflow below instead of assuming the customer
maintains a Node server or imports a generated TypeScript module.

## Boundaries

- Write only `.glirastes/tool-resolutions.json`, `.glirastes/tool-semantics.json`,
  new `contract.ts` files next to route handlers, and app code the work list
  names (a navigation bridge, a payload contract, an exported schema).
- Never edit `.glirastes/tool-policy.json`, route handler logic, the inventory,
  tool ids, exclusions or any generated output. Items owned by `developer`
  are shown to the developer with their command; you never run them yourself.
- Never resolve a finding by leaving a tool, a parameter or a mapping out:
  every key a handler reads stays in its schema, and nothing is excluded to make
  a list shorter (no `// @ai-ignore` comment, no exclusion proposal for that).
- Never weaken a check to pass: effects may only raise the risk, a write tool
  keeps asking first unless the developer (or, for a connected app, a Platform
  owner or admin) relaxes it, delete, financial and external tools always ask
  first.
- No secrets, keys (`sk-or-v1…`), e-mail addresses, phone or account numbers in
  anything you write.

## Workflow

1. After a change to routes, pages, URL filters or client actions run
   `glirastes tools refresh`, and also after upgrading `glirastes`: a new
   version can add fields to the generated outputs (0.9.0 added `title` to
   `.glirastes/tool-contracts.json`), and `glirastes tools check` reports
   drift until the refreshed outputs are committed. Read the summary: added,
   changed, risk raised, removed, needs attention, excluded, each with its
   next step. The same refresh brings the installed Glirastes skills up to
   the new version (`Skills updated to …`): unedited copies are replaced,
   new skills of the installed parts added, dropped ones removed, and
   `.glirastes/installed-skills.json` updated; commit them with the outputs.
   An edited copy is kept and named; merge the shipped version from
   `node_modules/glirastes/skills/<name>` into it yourself. `--no-skills` or
   `GLIRASTES_SKILLS_AUTO_UPDATE=0` leaves the skills alone.
   When the refresh prints an upgrade line (`Glirastes 0.16.0 → 0.17.0: …`),
   follow the skill `upgrading-glirastes` before you change code.
2. Run `glirastes tools resolve --print` and work through `items`:
   - `owner: "agent"`, `target.kind: "file"`: write the `expected` entry at
     `target.key` of `target.file`. Replace every `<…>` placeholder: `model`
     names you (e.g. `claude-code`), `interfaceDigest` stays as printed, the
     input schema gets real types, formats, enums, bounds and a description per
     parameter, read from `files` (handler, services, schemas). Strict JSON
     Schema 2020-12, an object with `additionalProperties: false`, at most
     32 KB, no `patternProperties` or `propertyNames`.
   - `owner: "agent"`, `target.kind: "app-code"`: change the app code in
     `target.files` as the finding says (export the schema, add the payload
     contract as third argument of `useAiClientAction`, mount the navigation
     bridge, rename a colliding parameter, add the client action a UI
     control proposes, move a client action into the page that owns its
     effect with `{ route }` as fourth argument).
   - `owner: "developer"`: show `target.command` and why; stop there.
     With `target.kind: "review"` a person wrote or reviewed the entry at
     `target.key` of `target.file` (human or locked): leave it exactly as it
     is and report it with its `message` for review.
   - `blocking`: fix these first (for example `export *` in a route file,
     a linked source folder, an invalid `tool-policy.json`); nothing is
     written until they are gone.
3. Run `glirastes tools refresh` and `glirastes tools resolve --print` again
   until no agent item is left. A rejected entry names its reason in
   `message`; fix it rather than retrying blindly.
4. Review the tool diff (`.glirastes/setup-artifact.json`,
   `.glirastes/tool-contracts.json`) with the code change and commit both.
5. In Standalone, restart the app to load the new tools; no Platform account
   or sync is needed. A Connected app may run `glirastes sync`; it uploads the
   technical result and never activates anything. Managed apps keep their
   verified revision source.

## OpenAPI and configured runtime updates

1. Regenerate OpenAPI 3.0 or 3.1 JSON from the backend's authoritative schema before
   refreshing tools. CI must detect stale exports separately; frozen generation
   cannot detect backend changes hidden by an old document. Preserve the appId.
2. Use the same generator, resolution, description and developer-owned policy
   workflows above. Unsupported active operations fail the runtime artifact
   build. Report the affected operation and supported alternatives; only an
   explicitly authorized exclusion may remove it, and it remains in coverage.
   With `"selection": "opt-in"` only operations marked `x-glirastes-tool: true`
   are tools and validated. Findings `opt-in-excluded`, `tool-marker-invalid`,
   `tool-group-invalid`, `tool-roles-invalid`, `output-allowed-fields-invalid`
   and `output-denied-fields-invalid` (tool stays disabled) are fixed in the
   backend that writes the export, never in generated files.
   A path or query parameter's `description` reaches the model as the input
   property's description (it wins over the schema's): write call-time
   guidance there, e.g. NestJS
   `@ApiQuery({ name: 'limit', required: false, description: 'Omit to get all playlists' })`.
3. Build a new artifact directory with the exact deployed SDK/image version:
   `glirastes-runtime build --project /workspace/app --out /artifacts/release-2`.
   Review and commit the generated inputs/outputs. Then CI builds a separate
   directory with `--frozen` and validates it with
   `glirastes-runtime validate --artifact /artifacts/ci-2`.
   These commands also run through the official image, without a customer
   package.json. Never patch runtime.json, manifest.json or coverage.json by hand.
4. Mount the reviewed artifact read-only and deploy it with the matching image
   and browser package. A refresh or Platform sync does not replace a running
   container's artifact. V1 permits one active service per app/environment:
   stop the old instance before starting the replacement; keep its approval
   database and secret. Rebuilding tools must not erase consumed approvals.
5. Connected mode additionally requires an accepted compatible Platform
   deployment. Verify `/readyz`, current runner/version when connected, an
   authorized read and an unauthorized denial. Exercise changed tools and
   frontend behavior in the target app; no successful build alone proves them.

The official public image starts at
`ghcr.io/chainmatics/glirastes-runtime:0.24.2` (Linux amd64). Pin an approved
release digest. The packaged `integrating-glirastes-web` runtime reference covers
identity/configuration when installed; otherwise use the matching SDK's
[runtime guide](https://github.com/chainmatics/glirastes/blob/v0.24.2/docs/runtime-container.md).

## Findings and what resolves them

| Code | Resolve with |
| --- | --- |
| `input-contract-unresolved`, `input-role-unclear`, `input-role-unsupported`, `schema-json-unavailable` | a `tool-resolutions.json` entry (JSON Schema, or `schemaRef` to an exported Zod schema), or validation with an exported schema in a sibling `contract.ts` |
| `auth-evidence-missing` | the name of the session helper the handler really calls, in `conventions.authHelpers`; never a helper that does not check the session |
| `contract-stale` | a stale `contract.ts`: update it for the changed interface; a stale `tool-resolutions.json` entry (always written or reviewed by a person): developer, who renews or removes it |
| `schema-not-exported`, `schema-module-unloadable`, `schema-content-rejected`, `parameter-collision`, `contract-effect-invalid` | the app code the message names; a schema moves into a side-effect-free module (a sibling `contract.ts` or a schema file) that the handler imports, never into a new export of `route.ts`, whose exports Next.js type-checks |
| `ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`, `definition-id-invalid`, `contract-presentation-invalid` | the registration or contract in `target.files`: a literal action id, a valid contract id or presentation |
| `max-result-chars-invalid` | the OpenAPI operation's `x-glirastes-max-result-chars` or the `maxResultChars` of the `contract.ts` entry: an integer from 1000 to 200000, or remove it; the handler's limit applies meanwhile |
| `output-contract-opaque` | a typed response. OpenAPI: a JSON `content` schema on the 200/201/202 response; an endpoint without a body declares `204` (NestJS `@HttpCode(204)` and `@ApiNoContentResponse()`), which closes it. Other sources: return a typed object or validate it with an exported schema |
| `semantics-entry-orphaned` | the `.glirastes/tool-semantics.json` entry `target.key` names: re-key it to the operation it describes (`"stableKey": "METHOD /path"` as in the tool report, or the current `name`), keeping its texts, or delete it when the operation is gone |
| `output-allowed-fields-invalid`, `output-denied-fields-invalid` | the OpenAPI operation's `x-glirastes-output-allowed-fields` / `x-glirastes-output-denied-fields` or `outputAllowedFields` / `outputDeniedFields` of the `contract.ts` entry: a list of at most 200 field paths such as `data[].name` (no index; `**.key` only in the deny-list), or remove it; the tool stays disabled meanwhile (fail closed) |
| `entity-declaration-invalid`, `entity-ref-invalid` | the declaration the message names (`x-glirastes-entity`, `x-glirastes-entities`, `x-glirastes-entity-ref`, `outputEntities`/`inputEntities` in `contract.ts`, or `identity` in `.glirastes/tools.json`, the last only with the developer): an id field or up to 4, optional lower-case `type`, `name`, `fallback`, `idKind`; a ref's `args` must be parameters of the tool. Ignored meanwhile (guessed from field names); see `docs/entity-identity.md` |
| `entity-id-conflict` (error, non-blocking) | make the declarations of one entity type agree on its id (or give one another type); outputs are written and the tool stays enabled meanwhile |
| `entity-field-unknown`, `entity-field-denied`, `entity-declaration-overridden`, `entity-declaration-unused` | the field or entry the message names: a property of the response at that path (a list is under `data`), an allowed field (a denial wins), or remove the lower-level duplicate / unused tools.json entry |
| `approval-subject-invalid` (error, non-blocking), `approval-subject-field-denied`, `approval-subject-unbounded-list`, `approval-subject-unused`, `approval-subject-suggested` | the lookup declaration the message names (`x-glirastes-entity-lookup`, `x-glirastes-approval-subject`, `x-glirastes-lookup-effect`, the same in `contract.ts`, or `identity.lookups` / `approvalSubjects` in `.glirastes/tools.json`, the last only with the developer): a source is GET/HEAD or declares `lookupEffect: read`, and declares the type in its entities; a composite key with a list argument is not looked up, so declare the list as a reference of its own; apply a suggestion only with the developer. Several instances: deploy everywhere before declaring; rebuild container artifacts. See `docs/approval-subjects.md` |
| `output-default-fields-invalid` | `x-glirastes-output-default-fields` / `outputDefaultFields`: a list of field paths like the others, or remove it; ignored meanwhile |
| `output-field-unknown`, `output-default-fields-outside-allowed`, `output-default-fields-denied` | the path the message names in the declaration: correct it to a field of the response (a list response is under `data`); a misspelt denied path excludes nothing, so fix it before relying on it |
| `output-denied-key-unmatched` | developer: a pattern in `output.deniedFields` of `.glirastes/tools.json` whose key no tool's declared response schema names; correct the spelling (names match exactly, case included) or remove it; never edit tools.json without the developer |
| `output-schema-unprojected` | optional: inline the `$ref` or replace `patternProperties` / the open `additionalProperties` in the response schema; results are reduced either way |
| `tool-semantics-invalid` | the entry `target.key` names in `.glirastes/tool-semantics.json`; keep its human text, fix only the shape |
| `input-schema-not-object` | an object at the root of the input schema (optional fields, or one field holding the variants), changed together with every caller of the route; for an internal route, tell the developer instead |
| `navigation-bridge-missing` | mount `useGlirastesNavigationBridge` (React) or `registerNavigationBridge` (`glirastes/browser`) where it is always mounted; an app without client-side routing calls `registerDocumentNavigation()` |
| `ui-action-payload-untyped`, `ui-action-contract-conflict` | one payload contract per client action |
| `ui-action-import-unresolved` | the code types the payload, but the import the message names cannot be resolved with the tsconfig it names (usually a path alias of another tsconfig in a monorepo). Add the alias to that tsconfig, or tell the developer to set `"tsconfig"` on the source in `.glirastes/tools.json` (by default the nearest `tsconfig.json` from `srcDir` up to the app root is used); never change the import to work around it |
| `ui-action-contract-unprobed` | optional: move the zod payload contract into a module that imports only zod (no components, styles or import-time side effects), export it and pass the export to the registration; the tool stays typed from TypeScript meanwhile |
| `ui-action-contract-mismatch` | make the TypeScript type of the contract match its zod schema (drop the cast or annotation); the tool follows the zod schema meanwhile |
| `ui-action-route-invalid` | the fourth argument of the registration: `{ route: '/templates' }` as a string literal of a static app path (one leading slash, no query, hash or `:param`), or no route when the action works on every page |
| `ui-action-route-conflict` | one route per client action: register it only in the page component that owns the effect, or with the same route everywhere |
| `ui-action-indirect` | the handler only relays a window event, so it works only where a listener is mounted. Move the registration into the component that owns the effect (the dialog or state it opens) and pass `{ route: '<page path>' }` when that component lives on one page; delete the global relay. Return `false` from a handler that could not do its work |
| `ui-control-unbound` | a setting the chat cannot set yet (a context setter or the next-themes `setTheme` with a closed set of values). Add `expected.registration` in `expected.file`, inside the component that owns the state and is always mounted (the provider, or for `setTheme` a component rendered inside the `ThemeProvider`), never on the settings page. Keep `expected.actionId`; import `useAiClientAction` from `glirastes/react` and `z` from `zod`, and use the app's own const list (e.g. `z.enum(UI_SIZES)`) where it has one. If the chat must not set it, tell the developer: `glirastes tools policy exclude-control <subject> --reason <text>` |
| `ui-control-contract-mismatch` | narrow the client action's contract to the values the setter takes |
| `ui-action-write-unproven` | developer: `glirastes tools policy raise <tool> write` when the helper writes; or, in app code, declare `{ effect: 'write' }` (or `'read'`) in the options of the registration |
| `ui-action-effect-invalid`, `ui-action-effect-conflict`, `ui-action-effect-contradicted` | the `effect` in the options of the registration: a literal `read`, `write`, `destructive`, `external` or `financial`, the same wherever the action is registered, and not `read` for a handler that sends a non-GET request |
| `risk-lower-available` | developer: `glirastes tools policy accept <tool>` after review |
| `policy-entry-orphaned` | developer: `glirastes tools policy reset <tool>` or `include` |
| `resolution-rejected` | the reason in the message; fix or remove that entry |

The work list also names navigation and filter tools: they need the bridge,
literal page paths and closed filter domains where possible.

## Policy (developer only)

The developer changes `.glirastes/tool-policy.json` through
`glirastes tools policy`. Every change is checked like a refresh before it is
written: disable, confirm, raise the risk and limit roles always work; relaxing
confirmation needs `--yes`, works for write tools only and is pinned to the
tool and its risk; a risk the code lowers is held until `accept`.

When the app is connected, a Platform owner or admin may switch off a
confirmation that comes from the code default, for tools up to `write`
(`glirastes tools status` marks it `Platform may relax`).
`glirastes tools policy confirm <tool>` writes `"requiresApproval": true`, a
local lock the Platform never relaxes (`locked in tool-policy.json`);
`glirastes tools policy reset <tool>` lifts it. Delete, financial and external
tools always ask first.

## Commands

```bash
glirastes tools refresh
glirastes tools resolve --print
glirastes tools check
glirastes tools status
# developer only: show these with the reason, never run them on your own
glirastes tools policy show <tool>
glirastes tools policy raise <tool> write --reason "<why>"
glirastes tools policy confirm <tool>
glirastes tools policy disable <tool> --reason "<why>"
glirastes tools policy relax <tool> --yes --reason "<review>"
glirastes tools policy exclude "POST /api/internal/**" --reason "<why>"
glirastes tools policy include "POST /api/internal/**"
glirastes tools policy accept <tool>
glirastes tools policy reset <tool>
glirastes doctor
```

## Environment chain and the managed job

An app deploys from an ordered chain of environment branches, any names and
any length (`pre-dev → dev → staging → master`, `qa → uat → prod`, or just
`main`). Tools are described where new code enters the chain:

- A pull request from a branch that is no environment (feature, hotfix,
  release with new commits) into any environment branch, or a push to one:
  the managed job (`glirastes tools enrich --managed`) works only tools whose
  semantics are missing, stale or rejected. Current entries, human and locked
  fields stay exactly as they are; a first run (manual start) also takes the
  schema backlog.
- A promotion changes nothing: a head branch that is an environment branch,
  or a head commit another environment branch already holds (a release
  branch cut from one, a fast-forward merged up). The job logs
  `promotion from <branch>, nothing to enrich` and ends.
- The chain is `enrich.environments` in `.glirastes/tools.json` (lowest
  first), overridden by the variable `GLIRASTES_ENVIRONMENT_BRANCHES` or
  `--environments`. Without either, the job takes the usual names
  (`dev`, `develop`, `staging`, `main`, `master`, `prod`, …) that exist on
  origin. Setting the chain is the developer's decision.
- The job commits at most once and only what passes `glirastes tools check`;
  a run its own commit starts does nothing.

## Verification

- `glirastes tools resolve --print` shows no agent item; developer items are
  reported with their commands.
- `glirastes tools check` reports `Tool outputs match the code.`; CI fails on
  stale outputs instead of keeping obsolete tools, and on unedited installed
  skills older than the SDK (edited copies only warn).
- Adding, changing and deleting an endpoint, a navigation page and a filter
  changes the tools; a removed tool cannot be called, also not after a
  restart or a rollback.
- The endpoint, not the tool, still refuses unauthorized calls:
  `resolvePrincipal` is resolved again before every tool call.
- `glirastes doctor` passes.
