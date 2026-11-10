# The files in `.glirastes`

Everything below is committed with the code. Inputs are written by people,
`glirastes init`, the CLI or you; outputs belong to the generator and are
byte-checked by `glirastes tools check`. Never write an output by hand: rerun
`glirastes tools refresh`, which also resolves merge conflicts in them.

## Inputs

| File | Who writes it | Contract |
| --- | --- | --- |
| `.glirastes/tools.json` | `glirastes init`, then you or the developer | `schemaVersion: 1`, `appId` (UUID, never changed after the first committed refresh), `targetAppKey`, `locale`, `sources`, optional `emit`, `enrich`, `ci`. Never a key. |
| `.glirastes/prompt-bundle.json` | `glirastes init`, then you | `schemaVersion: 1`, the same `appId`, `artifactRef`, and `sections` with `planner`, `appBehavior`, `responseStyle`, `capabilityFragments`. This is local prompt text; only digests leave the app. Preserve tuned text. |
| `.glirastes/tool-policy.json` | the developer, through `glirastes tools policy` | Overrides and exclusions. It can only restrict what the code allows, except a reviewed, pinned confirmation relaxation of a write tool. You never write it. |
| `.glirastes/tool-resolutions.json` | you or the developer | `conventions` (`handlerWrappers`, `bodyReaders`, `authHelpers`, `filterValues`) and per-tool contracts bound to an `interfaceDigest`. Data only. |
| `.glirastes/tool-semantics.json` | you or the developer | Descriptions, titles, synonyms, examples and hints per `stableKey`, with an origin per field. Human and locked fields are never replaced by agent output. |
| `.glirastes/chat-interactions.json` | you or the developer, only for an app with a chat | `schemaVersion: 1` and per id patches of the derived `@` entities and `/` commands (`commands`, `entities`): `label`, `description`, `keywords`, `icon`, and `hidden`, `run`, `args`, `search` or complete new entries for the developer. Not read by `glirastes tools refresh`; the chat route reads it through `createChatInteractionsHandler`, ignores a patch for an id the generator no longer derives (with a console warning) and fails to load on an invalid entry. It shapes the lists only and grants nothing. |
| `.glirastes/mcp-tool-names.json` | you or the developer, only for an app with an MCP server | Per endpoint `stableKey` the grant ids and MCP names its clients keep; read when `emit.mcpCatalog` is set. Never used by the chat. |

## Outputs

| File | Contract |
| --- | --- |
| `.glirastes/foundation-execution-inventory.json` | `FoundationExecutionInventorySchema` from `glirastes/codegen`: `schemaVersion: 2`, `targetAppKey` and the executions with their stable ids. |
| `.glirastes/tool-tombstones.json` | Removed tools; a tool that comes back gets a new id. |
| `.glirastes/tool-contracts.json` | Contracts, defaults and checked search data per tool; local only. |
| `.glirastes/tool-report.json` | Content-free findings, quality and exclusions per tool. |
| `.glirastes/setup-artifact.json` | `AppSetupArtifactSchema`; also the content-free capability report a connected runner uploads. |
| `.glirastes/build/runtime-manifest.json`, `.glirastes/build/prompt-manifest.json`, `.glirastes/setup-receipt.json` | Digest chain the Docker build verifies with `GLIRASTES_TOOLS_MODE=integrity`. |
| The generated module (`src/generated/glirastes/tools.generated.ts` by default) | `setupArtifact`, `toolCatalog`, `chatInteractions` (the derived `@` entities and `/` commands), `createToolBindings()`, `toolSearchSemantics`, `GeneratedToolId`, and with `emit.mcpCatalog` set in `tools.json` also `createMcpEndpointCatalog()` for the app's MCP server. |

## Principal

Set `"glirastes": { "principal": "server-verified" }` in `package.json` only
after the real server-side `resolvePrincipal` is implemented and tested. Doctor
checks the declaration; it never replaces the endpoint's own authorization.

The schema-only check `scripts/validate-artifact.ts` of this skill validates a
setup artifact; resolve its path relative to the installed skill. It does not
replace `glirastes tools check`, Doctor or a real tool action.
