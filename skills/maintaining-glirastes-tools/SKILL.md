---
name: maintaining-glirastes-tools
description: Use when glirastes tools refresh reports findings, a tool needs attention or is disabled, a route, page, filter or client action changed, or the tool policy must be reviewed.
---

# Maintaining Glirastes Tools

The app's code is the tool catalogue. The source-derived generator
(`glirastes tools refresh`) turns route handlers, pages, URL filters and client
actions into tools; where the code does not say enough, it prints a work list
for you, the app's coding agent. Glirastes never calls a model: you resolve the
findings, the next refresh checks every entry with the same rules, whoever
wrote it, and an invalid entry is ignored (`resolution-rejected`) while the tool
keeps its fallback.

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
   `glirastes tools refresh`. Read the summary: added, changed, risk raised,
   removed, needs attention, excluded, each with its next step.
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
     bridge, rename a colliding parameter).
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

## Findings and what resolves them

| Code | Resolve with |
| --- | --- |
| `input-contract-unresolved`, `input-role-unclear`, `input-role-unsupported`, `schema-json-unavailable` | a `tool-resolutions.json` entry (JSON Schema, or `schemaRef` to an exported Zod schema), or validation with an exported schema in a sibling `contract.ts` |
| `auth-evidence-missing` | the name of the session helper the handler really calls, in `conventions.authHelpers`; never a helper that does not check the session |
| `contract-stale` | a stale `contract.ts`: update it for the changed interface; a stale `tool-resolutions.json` entry (always written or reviewed by a person): developer, who renews or removes it |
| `schema-not-exported`, `schema-module-unloadable`, `schema-content-rejected`, `parameter-collision`, `contract-effect-invalid` | the app code the message names; a schema moves into a side-effect-free module (a sibling `contract.ts` or a schema file) that the handler imports, never into a new export of `route.ts`, whose exports Next.js type-checks |
| `ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`, `definition-id-invalid`, `contract-presentation-invalid` | the registration or contract in `target.files`: a literal action id, a valid contract id or presentation |
| `tool-semantics-invalid` | the entry `target.key` names in `.glirastes/tool-semantics.json`; keep its human text, fix only the shape |
| `input-schema-not-object` | an object at the root of the input schema (optional fields, or one field holding the variants), changed together with every caller of the route; for an internal route, tell the developer instead |
| `navigation-bridge-missing` | mount `useGlirastesNavigationBridge` (React) or `registerNavigationBridge` (`glirastes/browser`) where it is always mounted |
| `ui-action-payload-untyped`, `ui-action-contract-conflict` | one payload contract per client action |
| `ui-action-write-unproven` | developer: `glirastes tools policy raise <tool> write` when the helper writes |
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

## Verification

- `glirastes tools resolve --print` shows no agent item; developer items are
  reported with their commands.
- `glirastes tools check` reports `Tool outputs match the code.`; CI fails on
  stale outputs instead of keeping obsolete tools.
- Adding, changing and deleting an endpoint, a navigation page and a filter
  changes the tools; a removed tool cannot be called, also not after a
  restart or a rollback.
- The endpoint, not the tool, still refuses unauthorized calls:
  `resolvePrincipal` is resolved again before every tool call.
- `glirastes doctor` passes.
