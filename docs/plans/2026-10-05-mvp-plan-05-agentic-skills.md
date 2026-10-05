# Agentische Arbeit per Skills (P05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agentic task of the tools generator is solved by a shipped skill and the developer's own coding agent, while the CLI stays deterministic and never calls a model: `glirastes tools resolve --print` and `glirastes tools describe --print` print complete JSON work lists, the generator checks every agent-written entry of `tool-resolutions.json` and `tool-semantics.json` with one unified gate (strict parse, schema references through the probe, strict JSON Schema of at most 32 KB, code evidence, risk-raising effects only, content limits, human and locked precedence, nothing lost) and keeps the fallback of an invalid entry, `glirastes tools eval` checks the example sentences against `find_tools`, every refresh names the open agent work, `glirastes tools refresh --watch` keeps the tools current, `glirastes tools policy` and `glirastes tools verify` change the developer-owned files safely, `glirastes init` writes `tools.json` (with the app id pairing adopts), `prompt-bundle.json`, the scripts and the agent hint, `glirastes connect` takes framework and app id from `tools.json`, the runtime reports `tool_contract_rejected`, the seven skills are complete, linted against the CLI and run against fixtures, and the two generator rules and the MCP catalog from the Get It Done measurement exist (`// @ai-ignore` route files are code exclusions, a tool without an object at its input root needs attention, `emit.mcpCatalog` emits `createMcpEndpointCatalog()` with the names of `.glirastes/mcp-tool-names.json`).

**Architecture:** Work continues in the worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` on branch `codex/mvp-tools` after P04b: `064f8a94ee78e7f542c69fff2858bc5615eec00c` (P01–P04, P07 and the SDK half of P09 merged into `codex/glirastes-foundation-runtime` and fast-forwarded here) plus the eight P04b commits (/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-mvp-plan-04b-platform-relaxations.md, D16). Tasks 1–7 extend the generator: a shared agentic gate (`src/codegen/tools/agentic.ts`) and the strict `tool-resolutions.json` entry (Task 1), the fallback rules in the contract tiers (Task 2), the stage-2 model of `tool-semantics.json` (`src/codegen/tools/semantics.ts`, Task 3), its integration into the pipeline with checked synonyms and examples in `tool-contracts.json`, `toolSearchSemantics` in the generated module and an in-memory tool view on the pipeline result (Task 4), orphaned policy entries of excluded routes (Task 5), the narrowed scan skip list (Task 6) and client actions that may write through helpers (Task 7). Tasks 8–14 add the CLI: `tools resolve --print` (Task 8), `tools eval` over the committed outputs (Task 9), `tools describe --print` (Task 10), the refresh end note and `ci.requireEnrichment` (Task 11), `tools refresh --watch` (Task 12), `tools policy` with all twelve subcommands (Task 13) and `tools verify` (Task 14). Tasks 15–16 add the content-free `tool_contract_rejected` event in lockstep with P09 (union, vectors, digest, recorder, sink, endpoint tool, chat handler). Tasks 17–18 change `init` and `connect`. Tasks 19–27 ship the skills: a lint against the CLI tables (Task 19), the seven SKILL.md files (Tasks 20–26) and a scenario per skill that runs its commands against a fixture (Task 27). Tasks 28–29 take up the roadmap row of the Get It Done measurement (2026-10-05, added after the first draft of this plan): `// @ai-ignore` and object input roots (Task 28), the MCP endpoint catalog (Task 29); they come last so that Tasks 1–27 and their counts stay as measured. Task 30 runs the gate. Thirty tasks stay in one file (no P05a/P05b split).

**Tech Stack:** TypeScript 5.9 (NodeNext, strict), Node ≥ 20.6, Zod v4, Ajv 8 (`ajv/dist/2020.js`), Vitest 4, Bun, Next.js 15.5 and Playwright with system Chrome (browser proof only).

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (v1.5) sections 4.2 (CLI rows `tools refresh --watch`, `tools resolve --print`, `tools describe --print`, `tools eval`, `tools policy`, `tools verify`), 4.3 (input files `tools.json`, `tool-policy.json`, `tool-resolutions.json`, `tool-semantics.json`), 4.6 ("Agentische Arbeit: ausschließlich über Skills", "Einheitliche Prüfung im Generator", "Local und Free"), 4.7 (stage 2: trigger, result per tool, storage and origin, validation, `tools eval`, runtime `tool_contract_rejected`, `--write-contracts`, quality without enrichment, `ci.requireEnrichment`), 4.8 (`init` scripts, `--watch`), 4.11 (skills on fixtures) and 4.12 ("Prüfung agentischer Einträge", "Skills", "Stufe 2"). Roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md rows owned here (each mapped in the Self-Review): the P05 row, `tools refresh --watch`, the refresh hint, `policy-entry-orphaned` for excluded routes, the `tools policy` CLI with the `accept` contract, `init` writes `prompt-bundle.json`, `connect` takes the framework from `tools.json`, the artifact-wide `discoveryDigest`, `tools.json.appId` before the first committed refresh, the `scanAppSources` skip list, `tool_contract_rejected` in lockstep, the Connected exception and metrics wiring of `integrating-glirastes-nextjs`, client actions writing through helpers, and the Get It Done measurement rows (`// @ai-ignore`, object input roots, `emit.mcpCatalog`; the SDK share of the display-file row). Get It Done assessment: /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-gid-readiness-assessment.md (risks 2, 4, 5, 7, 10). Checkpoints: P04 (`.superpowers/sdd/2026-10-05-mvp-plan-04-navigation-filters-ui/progress.md`, items 10–12, rulings D1, D4, X12, X13, X16) and P09 (`.superpowers/sdd/2026-10-05-mvp-plan-09-metrics/progress.md`, ruling X7, items 6 and 9). Citadel design: /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-citadel-living-network-design.md D4 (localized `title`, data model here) and the drawer remediation commands (`tools describe --print <tool>`, `tools verify <tool>`).

## Global Constraints

- No push, merge into a main branch, npm publish or deploy; Omnify is neither read nor changed; no secret is read, printed or written; no live model or STT call (the chat tests use `MockLanguageModelV3`, the browser proof the fixture's test model).
- The CLI never calls a model (spec 4.6): no file under `src/cli/commands/tools/` or `src/codegen/tools/` imports a provider SDK or names OpenRouter; Task 14 extends the existing guard in `src/public-subpaths.test.ts` to every new file.
- Implementers never edit plan files. Shell `rm` is denied and no step needs it: tests clean their fixtures through Node's `fs`; the smoke copy of Task 30 is removed with `node -e "require('fs').rmSync(…)"`.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution. Agent shells reset their working directory between calls, so every command below starts with an absolute `cd`. Full Vitest runs use `--maxWorkers=4`; a timeout in a known timing file (`handler-analysis`, `program`, `schema-probe`, `voice-push-to-talk`, embed timing tests) is rerun alone and counts as load noise only when it passes alone.
- P05 runs after P04b on the same branch, and every replace block and count below was measured on the P04b result: the P04b plan applied mechanically (65 blocks, in document order) to a `git archive` of `064f8a9`, which reproduces P04b's gate (212 files, 2330 tests). This plan builds on P04b in four places: the `tool-policy.js` import of `src/codegen/tools/pipeline.ts` (Task 4 adds `ToolPolicyDefaults` beside P04b's `ToolPolicyEntry`), the D16 confirmation labels of `tools status` (`confirmationLabel`, exported in Task 13 and reused by `tools policy show`), the D16 case in `tools-command.test.ts` (Tasks 8 and 11 add their cases after it) and P04b's sections of `docs/managed-runtime-sync.md` (Task 21 edits only the metrics section). Should the merged P04b differ from its plan text, re-check those blocks before Task 4. The roadmap (b13ec62) also moved the pack fix with an import-completeness test into P04b after its plan was measured; when the executed P04b gate reports more than 212 files and 2330 tests, every full-suite count of Task 30 and the `src/cli` totals of Tasks 24 and 26 grow by exactly P04b's extra files and tests (the per-task counts of single test files stay as written).
- Agentic entries (spec 4.3, 4.6, 4.7). `tool-resolutions.json` `tools["<stableKey>"]`: `{ origin: 'human'|'agent' (default human), interfaceDigest, input?: { schemaRef | jsonSchema }, output?: { schemaRef | jsonSchema }, effect?, model? (required for agent entries), locked? (digest pinned by `tools verify`) }`, strict. `tool-semantics.json` `tools[]`: the Get It Done fields (`name`, `stableKey`, `modelName`, `description`, `module`, `sharedWith`, `usageHints`, `presentation`) plus `title`, `synonyms`, `examples` (3–5 per language), `exampleCalls`, `approvalHint` (per language `de`/`en`), `origin` per field, `locked` per field (digests) and `agent: { model, interfaceDigest }`, strict. A field without an origin was written by a human.
- The unified gate (one rule set, whoever wrote the entry): strict parse; JSON Schema 2020-12 compiled by Ajv strict (`strictTuples: false` for Zod tuples), at most 32 KB, an input schema is an object with `additionalProperties: false` and no `patternProperties`/`propertyNames`; every input key has code evidence and no evidenced query or body key is dropped; `schemaRef` must load through the probe; an effect below the code's risk class is refused; no secret, no `sk-or-v1` and no control character anywhere, in every resolution and every semantics entry (an `origin` is the writer's own claim, so these never depend on it), and no e-mail address or long number in agent prose; a locked field must still match its digest and is never marked as agent output; example calls must satisfy the input schema. A rejected entry is ignored with the warning `resolution-rejected` and the tool keeps its fallback. A stale human resolution stays `contract-stale` (needs attention, spec 4.4); a stale agent resolution falls back to the code contract with the warning `enrichment-stale`; a stale agent description stays in use with the warning `semantics-stale`.
- Work lists are JSON with `schemaVersion: 1`, built from a frozen pipeline run (never writes, no model, no network): resolve items `{ tool, stableKey, toolId, code, severity, message, owner: 'agent'|'developer', files, evidence, target: file|app-code|developer, expected?, nextAction }` plus `blocking`; describe items `{ tool, stableKey, toolId, module, gaps, files, evidence, protectedFields, missingExamples, routing, targets: { semantics, schema?, contract? } }` grouped by `modules`.
- `tools policy` writes only through `resolveToolPolicy`'s rules: disable, confirm, raise, roles and exclude restrict; `relax` needs `--yes`, works for write tools only and pins `{ toolId, atRiskClass }`; `accept` records exactly the `riskClass` of the `risk-lower-available` warning (roadmap contract); `PAGE /path` patterns are accepted. `show` labels each confirmation like `tools status` (`Platform may relax`, `locked in tool-policy.json`, through P04b's `platformMayRelaxConfirmation`), and `confirm` on a tool up to tier 2 says that it writes a D16 local lock that `reset` lifts.
- `tool_contract_rejected` (spec 4.7, P09 ruling X7): `{ schemaVersion: 2, eventId, eventType: 'tool_contract_rejected', occurredAt, appId, environmentId, buildId, instanceId, revisionId, toolId, inputSchemaDigest, httpStatus: 400|422 }`, strict and content-free; a batch carries one event type, so a Platform that does not know the type yet refuses only those batches. The vector file gets a new section and a new digest; the Platform copy, ingest union, storage and aggregation are a separate follow-up row (Self-Review).

## Review Focus

1. **Agent output never decides executability or loosens safety.** Unbacked or dropped keys, lowering effects, secrets, `sk-or-v1`, business data, oversized or non-strict schemas, unloadable or non-object references and changed locked fields are rejected with `resolution-rejected` while the tool keeps its fallback; an entry that leaves out its `origin` still never carries a key into search or the generated module; a stale agent contract falls back to the code contract instead of disabling the tool, a stale human one stays `contract-stale`. Pinned in Task 1 Step 1, Task 2 Step 1, Task 3 Step 1, Task 4 Step 1 and Task 28 Step 1.
2. **Nothing is dropped silently and the work lists are complete and stable.** Entries for excluded routes are reported, feature folders named like build output are scanned (and watched), handlers that may write through helpers are flagged, every open stage-1 finding, every registration stage 1 had to leave out (computed client action ids, invalid contract ids) and every stage-2 gap appears exactly once with its evidence and the entry or file to fix, `// @ai-ignore` routes are named exclusions, and whole-refresh errors are named as blocking. Pinned in Task 5 Step 1, Task 6 Step 1, Task 7 Step 1, Task 8 Step 1, Task 10 Step 1, Task 12 Step 1 and Task 28 Step 1.
3. **The developer-owned files only move the safe way, and no CLI path calls a model.** `tools policy` refuses relaxations of tier 3, unreviewed relaxations, lowering raises and an `accept` without a held risk, and names the D16 lock `confirm` writes; `tools verify` locks only accepted, current entries; the model-free guard covers every new CLI and codegen file. Pinned in Task 13 Step 1 and Task 14 Step 1.
4. **The app id never changes silently.** `init` reuses the app id the local files agree on and refuses two different ones, `connect` refuses a `tools.json`, receipt or connection naming another app, refresh refuses to re-key every tool after an app id change, and the framework comes from `tools.json`. Pinned in Task 17 Step 1 and Task 18 Step 1.
5. **`tool_contract_rejected` is content-free and never costs the turn metrics.** The event refuses arguments, messages, response bodies and free text; only 400 and 422 count; a failing reporter never changes a tool result; rejections travel in their own batches, so a Platform that refuses them keeps receiving turns. Pinned in Task 15 Step 1 and Task 16 Step 1.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/codegen/tools/agentic.ts` | Create (Task 1) | Shared gate: `agenticContentProblem`, `strictSchemaProblem` (Ajv 2020 strict, 32 KB, object input), `withoutMetaSchema`, `schemaPropertyNames`, `lockDigest`, `AGENT_MODEL_PATTERN` |
| `src/codegen/tools/resolutions.ts` | Modify (Task 1) | Strict `ResolutionEntrySchema` (`model`, `locked`), `inputEvidenceProblem`, `resolutionLockDigest`, `validateResolutionEntry` with `codeRiskClass` |
| `src/codegen/tools/contract-tiers.ts` | Modify (Tasks 2, 28) | `assessResolution`: stale human ⇒ `contract-stale`, stale agent ⇒ `enrichment-stale` and fallback, unloadable, non-object or key-dropping references ⇒ `resolution-rejected` and fallback |
| `src/codegen/tools/sources/next-endpoints.ts` | Modify (Tasks 2, 4, 28) | Passes the code risk class; reports `interface` and `files` per route; passes the `@ai-ignore` marker |
| `src/codegen/tools/exclusions.ts` | Modify (Task 28) | `hasAiIgnoreMarker`, the `ai-ignore` exclusion in code |
| `src/codegen/tools/semantics.ts` | Create (Task 3) | Stage-2 `SemanticsEntrySchema`, `validateSemanticsEntry`, `semanticsFacts`, `semanticsSearch`, `requiredLanguages`, `isAgenticSemantics` |
| `src/codegen/tools/prose.ts` | Modify (Task 3) | Loads the strict entries, `lookupSemantics`, checked `entry` override, `approvalHint` in the usage hints |
| `src/codegen/tools/types.ts`, `src/codegen/tools/files.ts` | Modify (Tasks 4, 29) | `ObservedTool.interface`/`files`, `ToolContractsEntry.search`; `McpToolName`, `McpToolNamesFileSchema`, `ToolContractsEntry.mcp` |
| `src/codegen/tools/inputs.ts` | Modify (Task 29) | `readMcpToolNames`, `ToolInputs.mcpNames` |
| `src/codegen/tools/pipeline.ts` | Modify (Tasks 4, 5, 28, 29) | Semantics check per tool, `search` in `tool-contracts.json`, `ToolsPipelineResult.tools`, orphaned entries of excluded routes, `input-schema-not-object`, MCP names per endpoint tool and the `emit.mcpCatalog` flag |
| `src/codegen/tools/emit-module.ts` | Modify (Tasks 4, 29) | `toolSearchSemantics` export; `createMcpEndpointCatalog()` with `emit.mcpCatalog` |
| `src/codegen/tools/sources/ui-tools.ts`, `src/codegen/tools/sources/react-actions.ts` | Modify (Tasks 4, 7) | UI `interface`/`files`; `ui-action-write-unproven` |
| `src/codegen/tools/sources/app-files.ts` | Modify (Task 6) | Build-output names skipped only directly in the scanned folder |
| `src/codegen/tools/findings.ts` | Modify (Tasks 2, 4, 5, 7, 28, 29) | Next actions for `enrichment-stale`, `semantics-stale`, `policy-entry-orphaned`, `ui-action-write-unproven`, `input-schema-not-object`, `mcp-tool-names-invalid` |
| `src/codegen/tools/worklist.ts` | Create (Task 8), modify (Tasks 10, 28, 29) | `buildResolveWorklist`, `buildDescribeWorklist`, `describeGaps`, `semanticsKey`, templates |
| `src/codegen/tools/routing-eval.ts` | Create (Task 9) | `evaluateRouting` over the artifact and `tool-contracts.json` |
| `src/codegen/tools/config.ts` | Modify (Tasks 11, 29) | `ci.requireEnrichment` documented as enforced; `TOOLS_PATHS.mcpToolNames`, `emit.mcpCatalog` documented as emitted |
| `src/cli/commands/tools/{resolve,eval,describe,watch,policy,verify}.ts` | Create (Tasks 8, 9, 10, 12, 13, 14), modify `watch.ts` (Task 29) | The new subcommands; the names file is a watched input |
| `src/cli/commands/tools/{index,args,check,status,refresh,format}.ts` | Modify (Tasks 8–14, 19) | Dispatch and usage, positional arguments, `readToolOutput`, end note, `--watch`, `ci.requireEnrichment`, the shared `confirmationLabel` (P04b) and its hint, exported argument tables |
| `src/cli/index.ts` | Modify (Task 14) | Top-level usage lists the new subcommands |
| `src/contracts/events.ts`, `src/contracts/index.ts` | Modify (Task 15) | `ToolContractRejectedEventSchema`, `RuntimeMetricEventSchema`, one-type batches |
| `src/contracts/__vectors__/runtime-metric-event.v2.json` | Modify (Task 15) | `toolContractRejected` vectors, new digest |
| `src/runtime/metrics/{turn-recorder,sink}.ts` | Modify (Task 16) | `recordToolContractRejected`; one queue per event type |
| `src/server/core/index.ts`, `src/server/adapters/nextjs/create-ai-chat-handler.ts` | Modify (Task 16) | `EndpointToolContext.onContractRejected`; wiring to the turn recorder |
| `src/cli/commands/init-scaffold.ts` | Create (Task 17) | `scaffoldToolsInputs`, `localAppIdentity`, `AGENT_HINT_START` |
| `src/cli/commands/agent-setup.ts` | Modify (Task 17) | `glirastes init` runs the scaffold and reports it |
| `src/cli/commands/connect.ts` | Modify (Task 18) | `connectFrameworkOf`, app id guard |
| `src/cli/commands/__tests__/skill-lint.ts` | Create (Task 19) | `lintSkill`, `skillCommands`, `commandWords`, `readSkill` |
| `src/cli/commands/installer-parts.ts` | Modify (Tasks 22, 24, 26) | Stack `web`; `describing-glirastes-tools` in `tools`; `migrating-to-glirastes` in `setup` |
| `skills/setting-up-glirastes/{SKILL.md,agents/openai.yaml,references/artifact-contract.md}` | Modify (Tasks 20, 29) | Setup through `tools refresh` and the work lists; the names file in the inputs table |
| `skills/integrating-glirastes-nextjs/SKILL.md`, `docs/managed-runtime-sync.md` | Modify (Task 21) | Chat route, metrics sink, `.chat(model)`, bridge |
| `skills/integrating-glirastes-web/SKILL.md` | Create (Task 22) | Separate backends, `glirastes/browser`, `<glirastes-chat>` |
| `skills/maintaining-glirastes-tools/SKILL.md` | Modify (Tasks 23, 28) | Stage-1 work list, developer policy and the D16 lock; `input-schema-not-object`, no marker to shorten a list |
| `skills/describing-glirastes-tools/SKILL.md` | Create (Task 24) | Stage-2 work list, eval loop, verify |
| `skills/building-glirastes-chat-ui/SKILL.md` | Modify (Task 25) | Required sections, bridge and contract argument |
| `skills/migrating-to-glirastes/SKILL.md`, `skills/README.md` | Create / modify (Task 26), modify the skill (Tasks 28, 29) | Migration off `@chainmatics/agentic-*`; the seven skills; markers stay, the MCP names file |
| New tests: `src/codegen/tools/{agentic,semantics,worklist,routing-eval}.test.ts`, `src/cli/commands/tools/{watch,policy,verify}.test.ts`, `src/server/core/__tests__/contract-rejection.test.ts`, `src/cli/commands/{init-scaffold,skill-lint}.test.ts`, `tests/skill-scenarios.test.ts` | Create | One file per new module or behaviour |
| Existing tests: `src/codegen/tools/{resolutions,contract-tiers,prose,emit-module,pipeline,exclusions}.test.ts`, `src/codegen/tools/sources/{next-endpoints,ui-tools,react-actions}.test.ts`, `src/cli/commands/tools/tools-command.test.ts`, `src/public-subpaths.test.ts`, `src/contracts/__tests__/runtime-metric-event.test.ts`, `src/runtime/metrics/{turn-recorder,sink}.test.ts`, `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts`, `src/cli/commands/{agent-setup,connect,install-skills,setup-skill-workflow,installer-parts}.test.ts`, `src/cli/installer-e2e.test.ts` | Modify | New cases beside the existing ones; guard phrases follow the new flow |

All commands run from `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools`. Code blocks are exact: a "replace" block matches the file byte for byte (each occurs exactly once at the moment it is applied, in the order given), and "Create" or "Replace the whole content" blocks are the complete file. Fences with four or more backticks wrap files that contain fenced blocks themselves (the SKILL.md files); copy what is between them.

Baseline after P04b (its gate): `bun run test --maxWorkers=4` reports `Test Files  212 passed (212)` and `Tests  2330 passed (2330)`; `bun run typecheck`, `bun run build` (`Generated 18 subpath shims.`) and `bun run typecheck:tests` exit 0. Before Task 1, confirm `git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools status --short` prints nothing and `git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools log --oneline 064f8a94ee78e7f542c69fff2858bc5615eec00c..HEAD` lists the eight P04b commits.

### Task 1: Strict agentic entries in `tool-resolutions.json`

**Files:**
- Create: `src/codegen/tools/agentic.ts` (the shared gate for everything an agent writes)
- Modify: `src/codegen/tools/resolutions.ts` (strict entry schema with `model` and `locked`, evidence in both directions, lowering effects, lock digest)
- Test: `src/codegen/tools/agentic.test.ts` (Create); `src/codegen/tools/resolutions.test.ts` (agent entries name their model; the shared evidence no longer lists a query key the PATCH schema would have to keep; new rejection cases)

**Interfaces:**
- Consumes: P03 `validateResolutionEntry`/`ResolutionEntrySchema`/`resolutionOrigin` (`src/codegen/tools/resolutions.ts`), `findSensitiveStringPath` (`src/contracts/content-boundary.ts`), `riskTier` and `DeclaredEffect` (`src/contracts/tool-policy.ts`), `canonicalJson`/`sha256Digest` (`src/codegen/tools/canonical.ts`); P03 ledger minors for Task 12 (patternProperties/propertyNames, draft-07 Ajv refusing Zod v4 tuples).
- Produces:
  - `src/codegen/tools/agentic.ts`: `MAX_AGENTIC_SCHEMA_BYTES` (32 KiB), `AGENT_MODEL_PATTERN`, `agenticContentProblem(value, { prose? }): string | undefined`, `withoutMetaSchema(schema)`, `strictSchemaProblem(schema, 'input' | 'output'): string | undefined` (Ajv 2020 strict with `strictTuples: false`), `schemaPropertyNames(schema): string[]`, `lockDigest(value): string`.
  - `src/codegen/tools/resolutions.ts`: `ResolutionEntrySchema` is strict and gains `model` (required when `origin` is `agent`) and `locked` (never on an agent entry); `inputEvidenceProblem(schema, evidence)`; `resolutionLockDigest(entry)`; `validateResolutionEntry({ stableKey, raw, evidence, codeRiskClass? })` additionally refuses dropped query/body keys, an effect below `codeRiskClass` and a changed locked entry, and names the field of a parse failure. `MAX_RESOLUTION_SCHEMA_BYTES` stays exported (= `MAX_AGENTIC_SCHEMA_BYTES`).

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/agentic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agenticContentProblem,
  lockDigest,
  MAX_AGENTIC_SCHEMA_BYTES,
  strictSchemaProblem,
  withoutMetaSchema,
} from './agentic.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false });

describe('agentic content gate', () => {
  it.each([
    ['a bearer token', { hint: `Bearer ${'a'.repeat(24)}` }, 'secret-looking content'],
    ['a short provider key prefix', { example: 'use sk-or-v1-abc' }, 'a provider key prefix (sk-or-v1)'],
    ['a provider key prefix in a key', { 'sk-or-v1': 'x' }, 'a provider key prefix (sk-or-v1)'],
    ['a control character', { title: 'Tasks\u0007' }, 'control characters'],
  ])('refuses %s anywhere', (_label, value, reason) => {
    expect(agenticContentProblem(value)).toBe(reason);
  });

  it('refuses e-mail addresses and long numbers in prose only', () => {
    const business = 'what looks like business data (an e-mail address or a long number)';
    expect(agenticContentProblem({ examples: ['Schreib anna.meier@kunde.de an'] }, { prose: true })).toBe(business);
    expect(agenticContentProblem({ examples: ['Ruf 0151 2345 6789 an'] }, { prose: true })).toBe(business);
    expect(agenticContentProblem({ input: { id: '019fb900-0000-7000-8000-000000000001' } })).toBeUndefined();
    expect(agenticContentProblem({ examples: ['Zeig die Aufgaben vom 2026-10-05'] }, { prose: true })).toBeUndefined();
  });
});

describe('strict agentic JSON Schema', () => {
  it('accepts what Zod v4 emits, tuples and formats included', () => {
    const emitted = z.toJSONSchema(z.object({
      pair: z.tuple([z.string(), z.number()]),
      due: z.iso.datetime().optional(),
      status: z.enum(['open', 'done']),
    }).strict()) as Record<string, unknown>;
    expect(strictSchemaProblem(withoutMetaSchema(emitted), 'input')).toBeUndefined();
  });

  it.each([
    ['an unknown keyword', object({ title: { type: 'string', looksLike: 'x' } }), 'not valid strict JSON Schema'],
    ['a non-object input', { type: 'string' }, 'must be an object with additionalProperties false'],
    ['open additional properties', { type: 'object', properties: {} }, 'must be an object with additionalProperties false'],
    ['pattern-matched keys', { ...object({}), patternProperties: { '^x-': { type: 'string' } } }, 'may not use patternProperties'],
    ['constrained key names', { ...object({}), propertyNames: { pattern: '^a' } }, 'may not use propertyNames'],
    ['an oversized schema', object({ title: { description: 'x'.repeat(MAX_AGENTIC_SCHEMA_BYTES) } }), 'exceeds 32 KB'],
  ])('refuses %s as input', (_label, schema, reason) => {
    expect(strictSchemaProblem(schema, 'input')).toContain(reason);
  });

  it('allows any strict output shape', () => {
    expect(strictSchemaProblem({ type: 'array', items: object({ id: { type: 'string' } }) }, 'output')).toBeUndefined();
    expect(strictSchemaProblem({ type: 'array', itemz: {} }, 'output')).toContain('not valid strict JSON Schema');
  });

  it('pins reviewed values independent of key order', () => {
    expect(lockDigest({ a: 1, b: [2] })).toBe(lockDigest({ b: [2], a: 1 }));
    expect(lockDigest({ a: 1 })).not.toBe(lockDigest({ a: 2 }));
    expect(lockDigest('x')).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });
});
```

In `src/codegen/tools/resolutions.test.ts`, replace:

```ts
import {
  EMPTY_CONVENTIONS,
  loadToolResolutions,
  resolutionOrigin,
  validateResolutionEntry,
} from './resolutions.js';

const roots: string[] = [];
const DIGEST = `sha256:${'R'.repeat(43)}`;
const evidence = { pathParams: ['id'], queryKeys: ['q'], bodyKeys: ['title'] as ReadonlyArray<string> | 'opaque' };

async function appWith(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-resolutions-'));
```

with:

```ts
import {
  EMPTY_CONVENTIONS,
  loadToolResolutions,
  resolutionLockDigest,
  resolutionOrigin,
  ResolutionEntrySchema,
  validateResolutionEntry,
} from './resolutions.js';

const roots: string[] = [];
const DIGEST = `sha256:${'R'.repeat(43)}`;
const evidence = { pathParams: ['id'], queryKeys: [] as ReadonlyArray<string>, bodyKeys: ['title'] as ReadonlyArray<string> | 'opaque' };

async function appWith(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-resolutions-'));
```

In `src/codegen/tools/resolutions.test.ts`, replace:

```ts
      raw: {
        interfaceDigest: DIGEST,
        origin: 'agent',
        input: { jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...objectSchema({ id: { type: 'string' }, title: { type: 'string' } }) } },
      },
      evidence,
```

with:

```ts
      raw: {
        interfaceDigest: DIGEST,
        origin: 'agent',
        model: 'codex',
        input: { jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...objectSchema({ id: { type: 'string' }, title: { type: 'string' } }) } },
      },
      evidence,
```

In `src/codegen/tools/resolutions.test.ts`, replace:

```ts
    });
    expect(ref.entry?.input?.schemaRef).toEqual({ module: 'src/lib/schemas.ts', export: 'createTask', property: [] });
    const { resolutions } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': { interfaceDigest: DIGEST, origin: 'agent' } },
    })));
    expect(resolutionOrigin(resolutions, 'POST /api/tasks')).toBe('agent');
    expect(resolutionOrigin(resolutions, 'GET /api/none')).toBeUndefined();
  });
});
```

with:

```ts
    });
    expect(ref.entry?.input?.schemaRef).toEqual({ module: 'src/lib/schemas.ts', export: 'createTask', property: [] });
    const { resolutions } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': { interfaceDigest: DIGEST, origin: 'agent', model: 'claude-code' } },
    })));
    expect(resolutionOrigin(resolutions, 'POST /api/tasks')).toBe('agent');
    expect(resolutionOrigin(resolutions, 'GET /api/none')).toBeUndefined();
  });

  it.each([
    ['an unknown field', { interfaceDigest: DIGEST, notes: 'x' }, 'does not match the entry schema'],
    ['an agent entry without its model', { interfaceDigest: DIGEST, origin: 'agent' }, 'does not match the entry schema at model'],
    ['a dropped query parameter', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({}) } }, 'drops parameters the handler reads: q'],
    ['a dropped body field', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ q: {} }) } }, 'drops parameters the handler reads: title'],
    ['a provider key prefix', { interfaceDigest: DIGEST, origin: 'agent', model: 'sk-or-v1' }, 'provider key prefix'],
  ])('rejects %s with a reason', (_label, raw, reason) => {
    const result = validateResolutionEntry({
      stableKey: 'POST /api/tasks', raw, evidence: { pathParams: [], queryKeys: ['q'], bodyKeys: ['title'] },
    });
    expect(result.entry).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: 'resolution-rejected', severity: 'warning' });
    expect(result.findings[0]?.message).toContain(reason);
  });

  it('lets effects raise the risk but never lower it below the code', () => {
    const raw = (effect: string) => ({ interfaceDigest: DIGEST, effect });
    const check = (effect: string) => validateResolutionEntry({
      stableKey: 'POST /api/tasks/:id/archive', raw: raw(effect), evidence, codeRiskClass: 'write',
    });
    expect(check('destructive').entry?.effect).toBe('destructive');
    expect(check('write').entry?.effect).toBe('write');
    expect(check('read').entry).toBeUndefined();
    expect(check('read').findings[0]?.message).toContain('would lower the risk below write');
  });

  it('keeps a reviewed entry only while its lock matches', () => {
    const reviewed = ResolutionEntrySchema.parse({
      interfaceDigest: DIGEST, model: 'codex', input: { jsonSchema: objectSchema({ id: {}, title: {} }) },
    });
    const locked = { ...reviewed, locked: resolutionLockDigest(reviewed) };
    expect(validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw: locked, evidence }).entry?.locked)
      .toBe(locked.locked);
    const edited = { ...locked, input: { jsonSchema: objectSchema({ id: {}, title: { type: 'string' } }) } };
    const result = validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw: edited, evidence });
    expect(result.entry).toBeUndefined();
    expect(result.findings[0]?.message).toContain('was changed after review');
    expect(validateResolutionEntry({
      stableKey: 'PATCH /api/tasks/:id', raw: { ...locked, origin: 'agent' }, evidence,
    }).findings[0]?.message).toContain('at locked');
  });
});

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/agentic.test.ts src/codegen/tools/resolutions.test.ts --maxWorkers=4`
Expected: FAIL — `Cannot find module './agentic.js'`; the old `validateResolutionEntry` accepts unknown fields, agent entries without a model, dropped parameters, lowering effects and changed locked entries. `Test Files  2 failed (2)`, `Tests  7 failed | 16 passed (23)`

- [ ] **Step 3: Implement**

Create `src/codegen/tools/agentic.ts`:

```ts
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { canonicalJson, sha256Digest } from './canonical.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/**
 * Shared gate for everything a coding agent or the managed job writes into
 * `tool-resolutions.json` and `tool-semantics.json` (spec 4.6 "Einheitliche
 * Prüfung"). The generator applies it the same way, whoever wrote the entry.
 */

/** Largest JSON Schema one agentic entry may carry. */
export const MAX_AGENTIC_SCHEMA_BYTES = 32 * 1024;

/** A model slug or coding-agent label: `anthropic/claude-sonnet-5.5`, `codex`, `claude-code`. */
export const AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const PROVIDER_KEY_PREFIX = /sk-or-v1/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** Nine or more digits in a row (optionally grouped): phone, IBAN or account numbers. */
const LONG_NUMBER = /\d(?:[ .\-/]?\d){8,}/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Keywords that admit object keys the evidence check never sees. */
const OPEN_KEY_KEYWORDS = ['patternProperties', 'propertyNames'] as const;

function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      strings(child, found);
    }
  }
  return found;
}

/**
 * The first content problem of an agentic value, or undefined. Every value is
 * checked for secrets, provider keys (any `sk-or-v1`, also short ones) and
 * control characters; prose (descriptions, hints, synonyms, example sentences)
 * additionally refuses e-mail addresses and long numbers, which only real
 * business data would put there. The reason never repeats the content.
 */
export function agenticContentProblem(value: unknown, options: { prose?: boolean } = {}): string | undefined {
  if (findSensitiveStringPath(value)) return 'secret-looking content';
  const texts = strings(value);
  if (texts.some((text) => PROVIDER_KEY_PREFIX.test(text))) return 'a provider key prefix (sk-or-v1)';
  if (texts.some((text) => CONTROL.test(text))) return 'control characters';
  if (options.prose && texts.some((text) => EMAIL.test(text) || LONG_NUMBER.test(text))) {
    return 'what looks like business data (an e-mail address or a long number)';
  }
  return undefined;
}

/** `$schema` names the dialect only; the generator always compiles JSON Schema 2020-12. */
export function withoutMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, ...rest } = schema;
  return rest;
}

function compileProblem(schema: Record<string, unknown>): string | undefined {
  // Zod v4 emits 2020-12 schemas, tuples as `prefixItems` without minItems.
  const ajv = new Ajv2020({ strict: true, strictTuples: false, allErrors: false, logger: false });
  addFormats(ajv);
  try {
    ajv.compile(schema);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid schema';
    return message.length <= 200 ? message : `${message.slice(0, 199)}…`;
  }
}

/**
 * Why a JSON Schema an agent wrote is unusable, or undefined: at most 32 KB,
 * strict JSON Schema 2020-12; an input schema is additionally an object with
 * `additionalProperties: false` and fixed keys only.
 */
export function strictSchemaProblem(
  schema: Record<string, unknown>,
  role: 'input' | 'output',
): string | undefined {
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_AGENTIC_SCHEMA_BYTES) {
    return `the ${role} schema exceeds 32 KB`;
  }
  const compiled = compileProblem(schema);
  if (compiled) return `the ${role} schema is not valid strict JSON Schema (${compiled})`;
  if (role === 'output') return undefined;
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    return 'the input schema must be an object with additionalProperties false';
  }
  const open = OPEN_KEY_KEYWORDS.find((keyword) => schema[keyword] !== undefined);
  if (open) return `input schemas may not use ${open}`;
  return undefined;
}

/** Property names of an object schema, sorted; empty for anything else. */
export function schemaPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties).sort()
    : [];
}

/** Digest of a reviewed value; `glirastes tools verify` writes it, the generator compares it. */
export function lockDigest(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}
```

In `src/codegen/tools/resolutions.ts`, replace:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { HandlerConventions } from './handler-analysis.js';
import type { ToolFinding } from './types.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export const MAX_RESOLUTION_SCHEMA_BYTES = 32 * 1024;

const appModule = z.string().trim().min(1).max(512)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), 'Path must stay inside the app');
```

with:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { riskTier, type DeclaredEffect } from '../../contracts/tool-policy.js';
import type { ToolRiskClass } from '../../contracts/index.js';
import {
  AGENT_MODEL_PATTERN,
  agenticContentProblem,
  lockDigest,
  MAX_AGENTIC_SCHEMA_BYTES,
  schemaPropertyNames,
  strictSchemaProblem,
  withoutMetaSchema,
} from './agentic.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { HandlerConventions } from './handler-analysis.js';
import type { ToolFinding } from './types.js';

export const MAX_RESOLUTION_SCHEMA_BYTES = MAX_AGENTIC_SCHEMA_BYTES;

const appModule = z.string().trim().min(1).max(512)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), 'Path must stay inside the app');
```

In `src/codegen/tools/resolutions.ts`, replace:

```ts
  'Provide exactly one of schemaRef or jsonSchema',
);

/** P05 extends entries (model, digests, prose); unknown fields pass through untouched. */
export const ResolutionEntrySchema = z.object({
  origin: z.enum(['human', 'agent']).default('human'),
  interfaceDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  input: SchemaSpecSchema.optional(),
  output: SchemaSpecSchema.optional(),
  effect: z.enum(['read', 'write', 'destructive', 'external', 'financial']).optional(),
}).passthrough();

const ResolutionsFileSchema = z.object({
  schemaVersion: z.literal(1),
```

with:

```ts
  'Provide exactly one of schemaRef or jsonSchema',
);

const digest = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);

/**
 * One `tool-resolutions.json` entry (spec 4.3, 4.6): a contract for one
 * stableKey, bound to the handler interface it was written for. Strict: an
 * unknown field rejects the entry. An agent entry names who wrote it
 * (`model`); `glirastes tools verify` turns a reviewed entry into a human one
 * and pins it with `locked`, the digest of the entry without that field.
 */
export const ResolutionEntrySchema = z.object({
  origin: z.enum(['human', 'agent']).default('human'),
  interfaceDigest: digest,
  input: SchemaSpecSchema.optional(),
  output: SchemaSpecSchema.optional(),
  effect: z.enum(['read', 'write', 'destructive', 'external', 'financial']).optional(),
  model: z.string().regex(AGENT_MODEL_PATTERN).optional(),
  locked: digest.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.origin === 'agent' && entry.model === undefined) {
    context.addIssue({ code: 'custom', path: ['model'], message: 'An agent entry names the model or coding agent that wrote it' });
  }
  if (entry.origin === 'agent' && entry.locked !== undefined) {
    context.addIssue({ code: 'custom', path: ['locked'], message: 'A locked entry was reviewed and is no agent entry' });
  }
});

const ResolutionsFileSchema = z.object({
  schemaVersion: z.literal(1),
```

In `src/codegen/tools/resolutions.ts`, replace:

```ts
  bodyKeys: ReadonlyArray<string> | 'opaque';
}

function withoutMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, ...rest } = schema;
  return rest;
}

function compilesStrictly(schema: Record<string, unknown>): boolean {
  const ajv = new Ajv({ strict: true, allErrors: false, logger: false });
  addFormats(ajv);
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

function normalizeSpec<T extends { jsonSchema?: Record<string, unknown> }>(spec: T | undefined): T | undefined {
  return spec?.jsonSchema ? { ...spec, jsonSchema: withoutMetaSchema(spec.jsonSchema) } : spec;
}

/** Basic gate for one entry; invalid entries are ignored and the tool keeps its fallback. */
export function validateResolutionEntry(input: {
  stableKey: string;
  raw: unknown;
  evidence: ResolutionEvidence;
}): { entry?: ResolutionEntry; findings: ToolFinding[] } {
  const reject = (reason: string) => ({
    findings: [rejected(input.stableKey, `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const parsed = ResolutionEntrySchema.safeParse(input.raw);
  if (!parsed.success) return reject('it does not match the entry schema');
  if (findSensitiveStringPath(parsed.data)) return reject('it contains secret-looking content');
  const entry = parsed.data;
  const specs = [['input', entry.input], ['output', entry.output]] as const;
  for (const [label, spec] of specs) {
    if (!spec?.jsonSchema) continue;
    const schema = withoutMetaSchema(spec.jsonSchema);
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_RESOLUTION_SCHEMA_BYTES) {
      return reject(`the ${label} schema exceeds 32 KB`);
    }
    if (!compilesStrictly(schema)) return reject(`the ${label} schema is not valid strict JSON Schema`);
    if (label !== 'input') continue;
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      return reject('the input schema must be an object with additionalProperties false');
    }
    // Pattern-matched keys admit names the evidence check below never sees.
    if (schema.patternProperties !== undefined) return reject('input schemas may not use patternProperties');
    if (input.evidence.bodyKeys !== 'opaque') {
      const allowed = new Set([...input.evidence.pathParams, ...input.evidence.queryKeys, ...input.evidence.bodyKeys]);
      const keys = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
      const unbacked = keys.filter((key) => !allowed.has(key)).sort(compareCodeUnits);
      if (unbacked.length > 0) return reject(`input keys without code evidence: ${unbacked.join(', ')}`);
    }
  }
  return {
    entry: {
```

with:

```ts
  bodyKeys: ReadonlyArray<string> | 'opaque';
}

const EFFECT_RISK: Readonly<Record<DeclaredEffect, ToolRiskClass>> = {
  read: 'safe-read',
  write: 'write',
  destructive: 'delete',
  external: 'external',
  financial: 'financial',
};

/**
 * Keys an input schema may name and must keep: every name needs code
 * evidence (path, query or a closed body), and no evidenced query or body
 * key may be dropped. An opaque body admits any body key, because the code
 * cannot show which ones the handler passes on.
 */
export function inputEvidenceProblem(
  schema: Record<string, unknown>,
  evidence: ResolutionEvidence,
): string | undefined {
  const keys = schemaPropertyNames(schema);
  if (evidence.bodyKeys !== 'opaque') {
    const allowed = new Set([...evidence.pathParams, ...evidence.queryKeys, ...evidence.bodyKeys]);
    const unbacked = keys.filter((key) => !allowed.has(key));
    if (unbacked.length > 0) return `input keys without code evidence: ${unbacked.join(', ')}`;
  }
  const present = new Set(keys);
  const lost = [...evidence.queryKeys, ...(evidence.bodyKeys === 'opaque' ? [] : evidence.bodyKeys)]
    .filter((key) => !present.has(key))
    .sort(compareCodeUnits);
  if (lost.length > 0) return `the input schema drops parameters the handler reads: ${[...new Set(lost)].join(', ')}`;
  return undefined;
}

/** The digest `glirastes tools verify` pins: the entry as parsed, without `locked`. */
export function resolutionLockDigest(entry: ResolutionEntry): string {
  const { locked: _locked, ...content } = entry;
  return lockDigest(content);
}

function normalizeSpec<T extends { jsonSchema?: Record<string, unknown> }>(spec: T | undefined): T | undefined {
  return spec?.jsonSchema ? { ...spec, jsonSchema: withoutMetaSchema(spec.jsonSchema) } : spec;
}

function firstIssuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path.map(String).join('.') ?? '';
  return path ? ` at ${path}` : '';
}

/**
 * The unified check of one entry (spec 4.6): strict parse, content limits, an
 * intact lock, effects that only raise the risk, strict JSON Schema of at
 * most 32 KB, and input keys that match the code evidence. An invalid entry
 * is ignored with `resolution-rejected`; the tool keeps its fallback.
 */
export function validateResolutionEntry(input: {
  stableKey: string;
  raw: unknown;
  evidence: ResolutionEvidence;
  /** The risk class the code alone derives; an effect below it is refused. */
  codeRiskClass?: ToolRiskClass;
}): { entry?: ResolutionEntry; findings: ToolFinding[] } {
  const reject = (reason: string) => ({
    findings: [rejected(input.stableKey, `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const parsed = ResolutionEntrySchema.safeParse(input.raw);
  if (!parsed.success) return reject(`it does not match the entry schema${firstIssuePath(parsed.error)}`);
  const entry = parsed.data;
  const content = agenticContentProblem(entry);
  if (content) return reject(`it contains ${content}`);
  if (entry.locked !== undefined && resolutionLockDigest(entry) !== entry.locked) {
    return reject('it was changed after review; restore it from git, or review it and run glirastes tools verify');
  }
  if (entry.effect && input.codeRiskClass
    && riskTier(EFFECT_RISK[entry.effect]) < riskTier(input.codeRiskClass)) {
    return reject(`its effect ${entry.effect} would lower the risk below ${input.codeRiskClass}; effects may only raise it`);
  }
  const specs = [['input', entry.input], ['output', entry.output]] as const;
  for (const [role, spec] of specs) {
    if (!spec?.jsonSchema) continue;
    const schema = withoutMetaSchema(spec.jsonSchema);
    const problem = strictSchemaProblem(schema, role);
    if (problem) return reject(problem);
    if (role !== 'input') continue;
    const evidence = inputEvidenceProblem(schema, input.evidence);
    if (evidence) return reject(evidence);
  }
  return {
    entry: {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/agentic.test.ts src/codegen/tools/resolutions.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  37 passed (37)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/agentic.test.ts src/codegen/tools/agentic.ts src/codegen/tools/resolutions.test.ts src/codegen/tools/resolutions.ts
git commit -m "feat(codegen): check agentic resolution entries strictly"
```

### Task 2: Keep the code contract when an agent resolution is unusable

**Files:**
- Modify: `src/codegen/tools/contract-tiers.ts` (`assessResolution`; tier 4 and the output choice use only a usable entry), `src/codegen/tools/sources/next-endpoints.ts` (passes the code risk class), `src/codegen/tools/findings.ts` (next actions of `resolution-rejected` and `enrichment-stale`)
- Test: `src/codegen/tools/contract-tiers.test.ts` (a stale human entry stays `contract-stale`; a stale agent entry and rejected references keep the fallback), `src/codegen/tools/sources/next-endpoints.test.ts` (an effect below the route's risk is refused)

**Interfaces:**
- Consumes: Task 1 `inputEvidenceProblem`, `ResolutionEntry.origin`/`model`; P03 `resolveEndpointContract`, `probeItemFor`, `probeKey`; P02 `deriveToolPolicyDefaults`.
- Produces: `resolveEndpointContract` semantics (spec 4.4, 4.6): a human entry for an older interface ⇒ `contract-stale` (needs attention, unchanged); an agent entry for an older interface ⇒ warning `enrichment-stale` and the tier-5/6 fallback; an entry whose `schemaRef` does not load, carries secret-looking content or drops evidenced keys ⇒ warning `resolution-rejected` and the fallback; the declared `effect` of an entry counts only when the entry is usable. `validateResolutionEntry` receives `codeRiskClass` from `deriveToolPolicyDefaults({ executionKind: 'endpoint', method, path, definitionId: '' })`. New finding code `enrichment-stale` (warning).

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/contract-tiers.test.ts`, replace:

```ts
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([[code, 'needs_attention']]);
  });

  it('lets a current resolution rescue an unclear native role, but not a stale one', () => {
    const unclear = evidence({ schemaUses: [{ role: 'unclear', via: 'parse', binding: SCHEMAS }], readsBody: true, bodyKeys: 'opaque' });
    const first = resolve({ evidence: unclear });
    expect(first.findings.map((finding) => finding.code)).toEqual(['input-role-unclear']);
    const rescued = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', interfaceDigest: first.interfaceDigest, input: { jsonSchema: NOTE } },
    });
    expect(rescued.contract).toMatchObject({ source: 'resolution', loadBearing: false, input: NOTE });
    expect(rescued.inputSchemaDigest).toBe(jsonSchemaDigest(NOTE));
    const stale = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', interfaceDigest: digest('S'), input: { jsonSchema: NOTE } },
    });
    expect(stale.contract).toBeUndefined();
    expect(stale.findings.map((finding) => finding.code)).toEqual(['contract-stale']);
  });

  it('uses a load-bearing contract module with its metadata (tier 2)', () => {
```

with:

```ts
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([[code, 'needs_attention']]);
  });

  it('lets a current resolution rescue an unclear native role; a stale human entry needs attention', () => {
    const unclear = evidence({ schemaUses: [{ role: 'unclear', via: 'parse', binding: SCHEMAS }], readsBody: true, bodyKeys: 'opaque' });
    const first = resolve({ evidence: unclear });
    expect(first.findings.map((finding) => finding.code)).toEqual(['input-role-unclear']);
    const rescued = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', model: 'codex', interfaceDigest: first.interfaceDigest, input: { jsonSchema: NOTE } },
    });
    expect(rescued.contract).toMatchObject({ source: 'resolution', loadBearing: false, input: NOTE });
    expect(rescued.inputSchemaDigest).toBe(jsonSchemaDigest(NOTE));
    const stale = resolve({
      evidence: unclear,
      resolution: { origin: 'human', interfaceDigest: digest('S'), input: { jsonSchema: NOTE } },
    });
    expect(stale.contract).toBeUndefined();
    expect(stale.findings.map((finding) => finding.code)).toEqual(['contract-stale']);
  });

  it('falls back to the code contract when an agent entry is stale, and says so', () => {
    const derived = evidence({ readsBody: true, bodyKeys: ['title'] });
    const typed = { ...NOTE, properties: { title: { type: 'string', minLength: 1 } } };
    const current = resolve({ evidence: derived });
    const enriched = resolve({
      evidence: derived,
      resolution: { origin: 'agent', model: 'codex', interfaceDigest: current.interfaceDigest, input: { jsonSchema: typed } },
    });
    expect(enriched.contract).toMatchObject({ source: 'resolution', input: typed });
    const stale = resolve({
      evidence: derived,
      resolution: { origin: 'agent', model: 'codex', interfaceDigest: digest('S'), input: { jsonSchema: typed } },
    });
    expect(stale.contract?.source).toBe('derived');
    expect(stale.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['output-contract-opaque', 'warning'], ['contract-derived', 'warning'], ['enrichment-stale', 'warning'],
    ]);
    expect(stale.findings[2]?.nextAction).toContain('glirastes tools describe --print');
  });

  it('rejects an agent schema reference that drops a parameter the handler reads', () => {
    const derived = evidence({ readsBody: true, bodyKeys: ['title', 'due'] });
    const current = resolve({ evidence: derived });
    const result = resolve({
      evidence: derived,
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
      resolution: { origin: 'agent', model: 'codex', interfaceDigest: current.interfaceDigest, input: { schemaRef: SCHEMAS } },
    });
    expect(result.contract?.source).toBe('derived');
    const rejected = result.findings.find((finding) => finding.code === 'resolution-rejected');
    expect(rejected).toMatchObject({ severity: 'warning', subjectRef: 'POST /api/notes' });
    expect(rejected?.message).toContain('drops parameters the handler reads: due');
  });

  it('uses a load-bearing contract module with its metadata (tier 2)', () => {
```

In `src/codegen/tools/contract-tiers.test.ts`, replace:

```ts
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('fails closed when a tool-resolutions.json output schema reference is rejected', () => {
      const unresolved = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
      const outputRef: SchemaBindingRef = { module: 'src/app/api/notes/schemas.ts', export: 'noteResponse', property: [] };
      const result = resolve({
```

with:

```ts
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('ignores a tool-resolutions.json entry whose output schema reference is rejected', () => {
      const unresolved = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
      const outputRef: SchemaBindingRef = { module: 'src/app/api/notes/schemas.ts', export: 'noteResponse', property: [] };
      const result = resolve({
```

In `src/codegen/tools/contract-tiers.test.ts`, replace:

```ts
        probes: probes([probeItemFor(outputRef, 'output'), rejected]),
        resolution: {
          origin: 'agent',
          interfaceDigest: unresolved.interfaceDigest,
          input: { jsonSchema: NOTE },
          output: { schemaRef: outputRef },
        },
      });
      expect(result.contract?.source).toBe('resolution');
      expect(result.contract?.output).toEqual({});
      expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('reports a rejected contract module that is the only candidate', () => {
```

with:

```ts
        probes: probes([probeItemFor(outputRef, 'output'), rejected]),
        resolution: {
          origin: 'agent',
          model: 'codex',
          interfaceDigest: unresolved.interfaceDigest,
          input: { jsonSchema: NOTE },
          output: { schemaRef: outputRef },
        },
      });
      expect(result.contract).toBeUndefined();
      expect(codes(result)).toEqual([['input-contract-unresolved', 'needs_attention'], ['resolution-rejected', 'warning']]);
      expect(result.findings[1]?.message).toContain('the output schema src/app/api/notes/schemas.ts#noteResponse carries secret-looking content');
    });

    it('reports a rejected contract module that is the only candidate', () => {
```

In `src/codegen/tools/contract-tiers.test.ts`, replace:

```ts
      ]);
    });

    it('reports a rejected tool-resolutions.json input schema reference', () => {
      const unresolved = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }),
        probes: probes([probeItemFor(SCHEMAS, 'input'), rejected]),
        resolution: { origin: 'agent', interfaceDigest: unresolved.interfaceDigest, input: { schemaRef: SCHEMAS } },
      });
      expect(result.contract).toBeUndefined();
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('does not flag a missing contract module', () => {
```

with:

```ts
      ]);
    });

    it('reports a rejected tool-resolutions.json input schema reference and keeps the fallback', () => {
      const unresolved = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }),
        probes: probes([probeItemFor(SCHEMAS, 'input'), rejected]),
        resolution: { origin: 'agent', model: 'codex', interfaceDigest: unresolved.interfaceDigest, input: { schemaRef: SCHEMAS } },
      });
      expect(result.contract).toBeUndefined();
      expect(codes(result)).toEqual([['input-contract-unresolved', 'needs_attention'], ['resolution-rejected', 'warning']]);
      const missing = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }),
        probes: probes([probeItemFor(SCHEMAS, 'input'), { ok: false, reason: 'missing' }]),
        resolution: { origin: 'agent', model: 'codex', interfaceDigest: unresolved.interfaceDigest, input: { schemaRef: SCHEMAS } },
      });
      expect(missing.findings[1]?.message).toContain('could not be loaded (missing)');
    });

    it('does not flag a missing contract module', () => {
```

In `src/codegen/tools/sources/next-endpoints.test.ts`, replace:

```ts
    expect(tasks?.prose?.schemaDescription).toBe('List your tasks, optionally filtered by status.');
  }, 60_000);

  it('keeps a previous definition id and handles apps without an API directory', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'export async function GET() { await getSession(); return Response.json([]); }\n'
```

with:

```ts
    expect(tasks?.prose?.schemaDescription).toBe('List your tasks, optionally filtered by status.');
  }, 60_000);

  it('refuses a tool-resolutions.json effect that would lower the risk the route has by code', async () => {
    const app = await createAppFixture(APP_FILES);
    const first = byKey((await createNextEndpointSource().observe(context(app.root))).observations);
    const interfaceDigest = first.get('DELETE /api/tasks/:id')!.contract!.interfaceDigest;
    const observe = (effect: string) => createNextEndpointSource().observe(context(app.root, {
      resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map([['DELETE /api/tasks/:id', { interfaceDigest, effect }]]) },
    }));
    const lowered = await observe('write');
    expect(lowered.findings.map((finding) => [finding.code, finding.subjectRef]))
      .toContainEqual(['resolution-rejected', 'DELETE /api/tasks/:id']);
    expect(byKey(lowered.observations).get('DELETE /api/tasks/:id')?.evidence.declaredEffect).toBeUndefined();
    const raised = await observe('financial');
    expect(raised.findings.map((finding) => finding.code)).not.toContain('resolution-rejected');
    expect(byKey(raised.observations).get('DELETE /api/tasks/:id')?.evidence.declaredEffect).toBe('financial');
  }, 60_000);

  it('keeps a previous definition id and handles apps without an API directory', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'export async function GET() { await getSession(); return Response.json([]); }\n'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/contract-tiers.test.ts src/codegen/tools/sources/next-endpoints.test.ts --maxWorkers=4`
Expected: FAIL — a stale agent entry still disables the tool as `contract-stale`, a key-dropping or rejected output reference still keeps the entry, a rejected input reference ends as a `schema-content-rejected` needs-attention finding without `resolution-rejected`, and a lowering effect passes. `Test Files  2 failed (2)`, `Tests  5 failed | 31 passed (36)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
import type { SchemaUse } from './handler-analysis.js';
import type { InputRole } from './input-roles.js';
import { computeInterfaceDigest } from './interface-digest.js';
import type { ResolutionEntry } from './resolutions.js';
import type {
  ProbedContractEntry,
  ProbedSchema,
```

with:

```ts
import type { SchemaUse } from './handler-analysis.js';
import type { InputRole } from './input-roles.js';
import { computeInterfaceDigest } from './interface-digest.js';
import { inputEvidenceProblem, type ResolutionEntry } from './resolutions.js';
import type {
  ProbedContractEntry,
  ProbedSchema,
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
function chooseOutput(
  input: ResolveEndpointContractInput,
  entry: ProbedContractEntry | undefined,
  resolutionCurrent: boolean,
): OutputChoice {
  const outputBindings = input.evidence.schemaUses
    .filter((use) => use.role === 'output' && use.binding)
```

with:

```ts
function chooseOutput(
  input: ResolveEndpointContractInput,
  entry: ProbedContractEntry | undefined,
  resolution: ResolutionEntry | undefined,
): OutputChoice {
  const outputBindings = input.evidence.schemaUses
    .filter((use) => use.role === 'output' && use.binding)
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
      findings: [],
    };
  }
  const resolutionOutput = resolutionCurrent ? input.resolution?.output : undefined;
  if (resolutionOutput?.schemaRef) {
    const outcome = input.probes.get(probeKey(probeItemFor(resolutionOutput.schemaRef, 'output')));
    const schema = asSchema(outcome);
    if (schema) {
      return { source: moduleExport(resolutionOutput.schemaRef), json: schema.jsonSchema ?? OPAQUE_JSON_SCHEMA, digest: schema.digest, findings: [] };
    }
    if (isContentRejected(outcome)) {
      return rejectedOutput(input.stableKey, `${resolutionOutput.schemaRef.module}#${resolutionOutput.schemaRef.export}`, outcome);
    }
  }
  if (resolutionOutput?.jsonSchema) {
    const json = resolutionOutput.jsonSchema;
```

with:

```ts
      findings: [],
    };
  }
  const resolutionOutput = resolution?.output;
  if (resolutionOutput?.schemaRef) {
    // assessResolution only passes an entry whose references all load.
    const schema = asSchema(input.probes.get(probeKey(probeItemFor(resolutionOutput.schemaRef, 'output'))))!;
    return { source: moduleExport(resolutionOutput.schemaRef), json: schema.jsonSchema ?? OPAQUE_JSON_SCHEMA, digest: schema.digest, findings: [] };
  }
  if (resolutionOutput?.jsonSchema) {
    const json = resolutionOutput.jsonSchema;
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
    findings: [toolFinding('output-contract-opaque', 'warning', input.stableKey,
      'The response shape could not be determined; the model sees an untyped result.')],
  };
}

/** Tiers: 1 native, 2 contract module, 4 tool-resolutions.json, 5 derived, 6 unresolved. */
```

with:

```ts
    findings: [toolFinding('output-contract-opaque', 'warning', input.stableKey,
      'The response shape could not be determined; the model sees an untyped result.')],
  };
}

interface ResolutionAssessment {
  /** The entry, when it is current and every schema it references loads. */
  usable?: ResolutionEntry;
  /** A human entry written for an earlier interface: the tool needs attention. */
  staleHuman: boolean;
  findings: ToolFinding[];
}

/**
 * Whether the tool-resolutions.json entry can be used (spec 4.6): a human
 * entry for an older interface makes the tool `contract-stale`; an agent
 * entry for an older interface or one whose schema reference does not load,
 * carries secret-looking content or drops evidenced parameters is ignored,
 * and the tool keeps its fallback contract.
 */
function assessResolution(
  input: ResolveEndpointContractInput,
  interfaceDigest: string,
): ResolutionAssessment {
  const resolution = input.resolution;
  if (!resolution) return { staleHuman: false, findings: [] };
  const subject = input.stableKey;
  if (resolution.interfaceDigest !== interfaceDigest) {
    if (resolution.origin === 'human') return { staleHuman: true, findings: [] };
    return {
      staleHuman: false,
      findings: [toolFinding('enrichment-stale', 'warning', subject,
        'The handler interface changed after an agent described this tool; it uses the contract derived from code until the description is renewed.')],
    };
  }
  const reject = (reason: string): ResolutionAssessment => ({
    staleHuman: false,
    findings: [toolFinding('resolution-rejected', 'warning', subject,
      `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const references = [['input', resolution.input?.schemaRef], ['output', resolution.output?.schemaRef]] as const;
  for (const [role, ref] of references) {
    if (!ref) continue;
    const outcome = input.probes.get(probeKey(probeItemFor(ref, role)));
    const label = `${ref.module}#${[ref.export, ...ref.property].join('.')}`;
    if (isContentRejected(outcome)) return reject(`the ${role} schema ${label} carries secret-looking content`);
    const schema = asSchema(outcome);
    if (!schema) return reject(`the ${role} schema ${label} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'})`);
    if (role === 'input' && schema.jsonSchema) {
      const problem = inputEvidenceProblem(schema.jsonSchema, {
        pathParams: input.pathParams,
        queryKeys: input.evidence.queryKeys,
        bodyKeys: input.evidence.bodyKeys,
      });
      if (problem) return reject(problem);
    }
  }
  return { usable: resolution, staleHuman: false, findings: [] };
}

/** Tiers: 1 native, 2 contract module, 4 tool-resolutions.json, 5 derived, 6 unresolved. */
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
  });
  const candidate = input.contractModule?.result;
  const entry = candidate?.ok && candidate.kind === 'contract-entry' ? candidate : undefined;
  const resolutionCurrent = input.resolution?.interfaceDigest === interfaceDigest;
  const effect = strongerEffect(entry?.effect, resolutionCurrent ? input.resolution?.effect : undefined);
  const prose: ToolProseHints = {
    ...(entry?.description ? { contractDescription: entry.description } : {}),
    ...(entry?.module ? { module: entry.module } : {}),
```

with:

```ts
  });
  const candidate = input.contractModule?.result;
  const entry = candidate?.ok && candidate.kind === 'contract-entry' ? candidate : undefined;
  const assessment = assessResolution(input, interfaceDigest);
  const resolution = assessment.usable;
  const effect = strongerEffect(entry?.effect, resolution?.effect);
  const prose: ToolProseHints = {
    ...(entry?.description ? { contractDescription: entry.description } : {}),
    ...(entry?.module ? { module: entry.module } : {}),
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
    if (isContentRejected(candidate)) return [probeFailureFinding(subject, input.contractModule.module, candidate)];
    return entry ? invalidMetadataFindings(subject, input.contractModule.module, entry) : [];
  })();
  const withModuleFindings = (findings: ToolFinding[]): ToolFinding[] => [
    ...findings,
    ...moduleFindings.filter((extra) => !findings.some((finding) => (
      finding.code === extra.code && finding.message === extra.message
    ))),
  ];
```

with:

```ts
    if (isContentRejected(candidate)) return [probeFailureFinding(subject, input.contractModule.module, candidate)];
    return entry ? invalidMetadataFindings(subject, input.contractModule.module, entry) : [];
  })();
  const sideFindings = [...moduleFindings, ...assessment.findings];
  const withModuleFindings = (findings: ToolFinding[]): ToolFinding[] => [
    ...findings,
    ...sideFindings.filter((extra) => !findings.some((finding) => (
      finding.code === extra.code && finding.message === extra.message
    ))),
  ];
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
    outputSchemaDigest: OPAQUE_SCHEMA_DIGEST,
    findings: withModuleFindings(findings),
  });
  const output = chooseOutput(input, entry, resolutionCurrent);
  const finish = (
    source: ToolContract['source'],
    loadBearing: boolean,
```

with:

```ts
    outputSchemaDigest: OPAQUE_SCHEMA_DIGEST,
    findings: withModuleFindings(findings),
  });
  const output = chooseOutput(input, entry, resolution);
  const finish = (
    source: ToolContract['source'],
    loadBearing: boolean,
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
  }

  // Tier 4: tool-resolutions.json entry bound to the interface digest.
  const resolutionInput = input.resolution?.input;
  if (resolutionInput) {
    if (!resolutionCurrent) {
      return unresolved([toolFinding('contract-stale', 'needs_attention', subject,
        'The handler interface changed after its tool-resolutions.json entry was written.')]);
    }
    let part: RolePart;
    if (resolutionInput.schemaRef) {
      const outcome = input.probes.get(probeKey(probeItemFor(resolutionInput.schemaRef, 'input')));
      const schema = asSchema(outcome);
      if (!schema) {
        return unresolved([probeFailureFinding(subject, `${resolutionInput.schemaRef.module}#${resolutionInput.schemaRef.export}`, outcome)]);
      }
      part = {
        role: roleFor(), json: schema.jsonSchema, source: moduleExport(resolutionInput.schemaRef), digest: schema.digest,
        label: bindingLabel(roleFor(), resolutionInput.schemaRef), wholeInput: true,
```

with:

```ts
  }

  // Tier 4: tool-resolutions.json entry bound to the interface digest.
  if (assessment.staleHuman && input.resolution?.input) {
    return unresolved([toolFinding('contract-stale', 'needs_attention', subject,
      'The handler interface changed after its tool-resolutions.json entry was written.')]);
  }
  const resolutionInput = resolution?.input;
  if (resolutionInput) {
    let part: RolePart;
    if (resolutionInput.schemaRef) {
      const schema = asSchema(input.probes.get(probeKey(probeItemFor(resolutionInput.schemaRef, 'input'))))!;
      part = {
        role: roleFor(), json: schema.jsonSchema, source: moduleExport(resolutionInput.schemaRef), digest: schema.digest,
        label: bindingLabel(roleFor(), resolutionInput.schemaRef), wholeInput: true,
```

In `src/codegen/tools/findings.ts`, replace:

```ts
  'contract-derived': 'Optional: validate the input with an exported Zod schema to give the model typed parameters.',
  'description-templated': 'Optional: add a JSDoc comment to the handler or a description in tool-semantics.json.',
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix the tool-resolutions.json entry; the tool keeps its fallback contract meanwhile.',
  'definition-id-invalid': 'Use a contract id like resource.action (letters and digits, dot-separated).',
  'definition-id-conflict': 'Give one of the tools a distinct contract id.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
```

with:

```ts
  'contract-derived': 'Optional: validate the input with an exported Zod schema to give the model typed parameters.',
  'description-templated': 'Optional: add a JSDoc comment to the handler or a description in tool-semantics.json.',
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix or remove the tool-resolutions.json or tool-semantics.json entry the message names; the tool keeps its fallback meanwhile.',
  'enrichment-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); it uses the contract derived from code meanwhile.',
  'definition-id-invalid': 'Use a contract id like resource.action (letters and digits, dot-separated).',
  'definition-id-conflict': 'Give one of the tools a distinct contract id.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { EndpointMethod } from '../../../types.js';
import {
  createRouteSourceFingerprint,
```

with:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { deriveToolPolicyDefaults } from '../../../contracts/tool-policy.js';
import type { EndpointMethod } from '../../../types.js';
import {
  createRouteSourceFingerprint,
```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
        queryKeys: analysis?.queryKeys ?? [],
        bodyKeys: analysis?.bodyKeys ?? 'opaque',
      },
    });
    findings.push(...validated.findings);
    if (validated.entry) resolutions.set(entry.stableKey, validated.entry);
```

with:

```ts
        queryKeys: analysis?.queryKeys ?? [],
        bodyKeys: analysis?.bodyKeys ?? 'opaque',
      },
      codeRiskClass: deriveToolPolicyDefaults({
        executionKind: 'endpoint', method: entry.method, path: entry.path, definitionId: '',
      }).riskClass,
    });
    findings.push(...validated.findings);
    if (validated.entry) resolutions.set(entry.stableKey, validated.entry);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/contract-tiers.test.ts src/codegen/tools/sources/next-endpoints.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  36 passed (36)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/contract-tiers.test.ts src/codegen/tools/contract-tiers.ts src/codegen/tools/findings.ts src/codegen/tools/sources/next-endpoints.test.ts src/codegen/tools/sources/next-endpoints.ts
git commit -m "feat(codegen): keep the code contract when an agent entry is unusable"
```

### Task 3: The stage-2 data model of `tool-semantics.json`

**Files:**
- Create: `src/codegen/tools/semantics.ts` (entry schema, unified check, facts and search data)
- Modify: `src/codegen/tools/prose.ts` (loads strict entries, reports an unparsable agent entry as `resolution-rejected`, `lookupSemantics`, checked `entry` override, `approvalHint`)
- Test: `src/codegen/tools/semantics.test.ts` (Create); `src/codegen/tools/prose.test.ts` (two new cases)

**Interfaces:**
- Consumes: Task 1 `agenticContentProblem`, `lockDigest`, `AGENT_MODEL_PATTERN`; P03 `resolveToolProse`, `loadToolSemantics`; `ToolPresentationSchema`; `createJsonSchemaLike` (`src/runtime/json-schema.ts`, the same validator the runtime uses for JSON Schema tools).
- Produces:
  - `src/codegen/tools/semantics.ts`: `SEMANTICS_LANGUAGES` (`de`, `en`), `SEMANTICS_FIELDS`, `SEMANTICS_LIMITS`, `SemanticsEntrySchema` (strict), `type ToolSemanticsEntry`, `isAgenticSemantics(value)`, `requiredLanguages(locale)` (the app language when it is `de`, plus `en`), `validateSemanticsEntry(entry, { stableKey, interfaceDigest?, input? }): { entry?, findings, stale }`, `semanticsFacts(entry, languages): { protectedFields, hasSynonyms, missingExamples }`, `semanticsSearch(entry): { synonyms, examples }`.
  - `src/codegen/tools/prose.ts`: re-exports `ToolSemanticsEntry`; `lookupSemantics(semantics, stableKey, definitionId)`; `ResolveToolProseInput.entry?: ToolSemanticsEntry | null` (the checked entry; `null` = rejected); usage hints include `approvalHint`.

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/prose.test.ts`, replace:

```ts
    });
  });

  it('reports malformed semantics files and entries without failing', async () => {
    expect((await semanticsFile('{')).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    const partial = await semanticsFile(JSON.stringify({ schemaVersion: 1, tools: [{ description: 'no key' }, { name: 'tasks.create', description: 'Kept.' }] }));
```

with:

```ts
    });
  });

  it('reports an agent entry that does not parse as rejected agent output', async () => {
    const loaded = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'POST /api/tasks', description: 'x', origin: { description: 'agent' }, agent: { model: 'codex' } },
        { stableKey: 'GET /api/tasks', description: 'y', mood: 'happy' },
      ],
    }));
    expect(loaded.findings.map((finding) => [finding.code, finding.subjectRef, finding.message])).toEqual([
      ['resolution-rejected', '.glirastes/tool-semantics.json#0', 'Entry 0 of tool-semantics.json is invalid at agent.interfaceDigest and is ignored.'],
      ['tool-semantics-invalid', '.glirastes/tool-semantics.json#1', 'Entry 1 of tool-semantics.json is invalid and is ignored.'],
    ]);
  });

  it('uses the entry the pipeline checked and adds its approval hint to the usage hints', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'POST /api/tasks', description: 'From semantics.', approvalHint: 'Confirm when the task is shared with a team.' }],
    }));
    const prose = resolveToolProse({ ...base, semantics });
    expect(prose.usageHints).toEqual(['Confirm when the task is shared with a team.']);
    const rejected = resolveToolProse({ ...base, semantics, entry: null });
    expect(rejected).toMatchObject({ descriptionOrigin: 'template', description: 'Create tasks (POST /api/tasks).' });
  });

  it('reports malformed semantics files and entries without failing', async () => {
    expect((await semanticsFile('{')).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    const partial = await semanticsFile(JSON.stringify({ schemaVersion: 1, tools: [{ description: 'no key' }, { name: 'tasks.create', description: 'Kept.' }] }));
```

Create `src/codegen/tools/semantics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lockDigest } from './agentic.js';
import {
  requiredLanguages,
  SemanticsEntrySchema,
  semanticsFacts,
  semanticsSearch,
  validateSemanticsEntry,
  type ToolSemanticsEntry,
} from './semantics.js';

const INTERFACE = `sha256:${'I'.repeat(43)}`;
const INPUT = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1 }, due: { type: 'string', format: 'date' } },
  required: ['title'],
  additionalProperties: false,
};
const context = { stableKey: 'POST /api/tasks', interfaceDigest: INTERFACE, input: INPUT };

function agentEntry(overrides: Partial<ToolSemanticsEntry> = {}): ToolSemanticsEntry {
  return SemanticsEntrySchema.parse({
    stableKey: 'POST /api/tasks',
    description: 'Creates a task for the caller. Use it to add work; to change an existing task use tasks.update.',
    synonyms: { de: ['Aufgabe anlegen', 'neue Aufgabe'], en: ['add task'] },
    examples: {
      de: ['Leg eine Aufgabe Angebot schreiben an', 'Neue Aufgabe: Bericht prüfen', 'Erstelle eine Aufgabe für morgen'],
      en: ['Add a task to call the supplier', 'Create a task for tomorrow', 'New task: review the report'],
    },
    exampleCalls: [{ sentence: 'Create a task for tomorrow', input: { title: 'Call the supplier', due: '2026-10-06' } }],
    origin: { description: 'agent', synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' },
    agent: { model: 'claude-code', interfaceDigest: INTERFACE },
    ...overrides,
  });
}

describe('tool-semantics.json entries', () => {
  it('reads the Get It Done format and refuses unknown fields', () => {
    expect(SemanticsEntrySchema.safeParse({
      name: 'tasks.list', modelName: 'tasks_list', module: 'task_query', sharedWith: [], usageHints: ['x'], description: 'x',
      presentation: { locale: 'de-DE', singular: 'a', plural: 'b', approval: 'c' },
    }).success).toBe(true);
    expect(SemanticsEntrySchema.safeParse({ name: 'tasks.list', notes: 'x' }).success).toBe(false);
    expect(SemanticsEntrySchema.safeParse({ name: 'tasks.list', examples: { de: ['only one'] } }).success).toBe(false);
    expect(SemanticsEntrySchema.safeParse({ name: 'tasks.list', origin: { color: 'agent' } }).success).toBe(false);
  });

  it('accepts a complete agent entry and reports it stale for another interface', () => {
    expect(validateSemanticsEntry(agentEntry(), context)).toEqual({ entry: agentEntry(), findings: [], stale: false });
    const stale = validateSemanticsEntry(agentEntry(), { ...context, interfaceDigest: `sha256:${'J'.repeat(43)}` });
    expect(stale).toMatchObject({ findings: [], stale: true });
  });

  it.each([
    ['an agent entry without its agent block', { agent: undefined }, 'names its model and the interfaceDigest'],
    ['an e-mail address in an example', { examples: { en: ['Mail anna@kunde.de', 'b two', 'c three'] } }, 'business data'],
    ['a provider key prefix', { description: 'Use sk-or-v1 here.' }, 'provider key prefix'],
    ['an overlong description', { description: 'x'.repeat(1_001) }, 'longer than 1000 characters'],
    ['an invalid presentation', { presentation: { locale: 'de-DE' } }, 'presentation does not match'],
    ['a module that is no name', { module: 'Task Mutation!' }, 'module and sharedWith must be module names'],
    ['an example call the schema refuses', { exampleCalls: [{ input: { title: '' } }] }, 'example call 1 does not match the input schema'],
    ['an example call with an unknown key', { exampleCalls: [{ input: { title: 'x', priority: 1 } }] }, 'example call 1 does not match'],
  ])('rejects %s', (_label, overrides, reason) => {
    const result = validateSemanticsEntry(agentEntry(overrides as Partial<ToolSemanticsEntry>), context);
    expect(result.entry).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: 'resolution-rejected', severity: 'warning', subjectRef: 'POST /api/tasks' });
    expect(result.findings[0]?.message).toContain(reason);
  });

  it('protects locked fields from later changes and from agent origin', () => {
    const description = 'Reviewed description.';
    const reviewed = SemanticsEntrySchema.parse({
      stableKey: 'POST /api/tasks', description, origin: { description: 'human' }, locked: { description: lockDigest(description) },
    });
    expect(validateSemanticsEntry(reviewed, context).entry).toEqual(reviewed);
    const overwritten = validateSemanticsEntry({ ...reviewed, description: 'Agent text.' }, context);
    expect(overwritten.findings[0]).toMatchObject({ code: 'resolution-rejected' });
    expect(overwritten.findings[0]?.message).toContain('the locked field description was changed after review');
    const relabelled = validateSemanticsEntry({ ...reviewed, origin: { description: 'agent' }, agent: { model: 'codex', interfaceDigest: INTERFACE } }, context);
    expect(relabelled.findings[0]?.message).toContain('the locked field description is marked as agent output');
  });

  it('reports a broken human entry as invalid semantics, and refuses keys whoever claims to have written them', () => {
    const human = SemanticsEntrySchema.parse({ stableKey: 'POST /api/tasks', exampleCalls: [{ input: { nope: true } }] });
    expect(validateSemanticsEntry(human, context).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    expect(validateSemanticsEntry(human, { stableKey: 'POST /api/tasks' }).findings[0]?.message)
      .toContain('example calls need a tool with an input contract');
    // An entry without an origin counts as human; it still never carries a key into search or the module.
    const unlabelled = SemanticsEntrySchema.parse({ stableKey: 'POST /api/tasks', synonyms: { en: ['sk-or-v1 key'] } });
    expect(validateSemanticsEntry(unlabelled, context).findings.map((finding) => [finding.code, finding.message])).toEqual([[
      'tool-semantics-invalid', 'The tool-semantics.json entry was rejected: it contains a provider key prefix (sk-or-v1).',
    ]]);
  });

  it('names protected fields, synonyms and missing example languages', () => {
    const entry = agentEntry({ module: 'task_mutation', origin: { synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' } });
    expect(semanticsFacts(entry, ['de', 'en'])).toEqual({
      protectedFields: ['description', 'module'],
      hasSynonyms: true,
      missingExamples: [],
    });
    expect(semanticsFacts(undefined, requiredLanguages('de-DE'))).toEqual({
      protectedFields: [], hasSynonyms: false, missingExamples: ['de', 'en'],
    });
    expect(requiredLanguages('en-US')).toEqual(['en']);
    expect(semanticsSearch(entry)).toEqual({
      synonyms: ['Aufgabe anlegen', 'add task', 'neue Aufgabe'],
      examples: [
        'Add a task to call the supplier', 'Create a task for tomorrow', 'Erstelle eine Aufgabe für morgen',
        'Leg eine Aufgabe Angebot schreiben an', 'Neue Aufgabe: Bericht prüfen', 'New task: review the report',
      ],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/prose.test.ts src/codegen/tools/semantics.test.ts --maxWorkers=4`
Expected: FAIL — `Cannot find module './semantics.js'`; `prose.ts` still reports an unparsable agent entry as `tool-semantics-invalid`, ignores the `entry` override and drops `approvalHint`. `Test Files  2 failed (2)`, `Tests  2 failed | 17 passed (19)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/prose.ts`, replace:

```ts
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { ToolFinding, ToolProseHints } from './types.js';

export type DescriptionOrigin = 'human' | 'code' | 'agent' | 'template';

```

with:

```ts
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import { isAgenticSemantics, SemanticsEntrySchema, type ToolSemanticsEntry } from './semantics.js';
import type { ToolFinding, ToolProseHints } from './types.js';

export type { ToolSemanticsEntry } from './semantics.js';

export type DescriptionOrigin = 'human' | 'code' | 'agent' | 'template';

```

In `src/codegen/tools/prose.ts`, replace:

```ts
const MAX_HINT = 500;
const MAX_LABEL = 200;

const SemanticsEntrySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  stableKey: z.string().trim().min(1).max(2_100).optional(),
  description: z.string().optional(),
  module: z.string().optional(),
  sharedWith: z.array(z.string()).optional(),
  usageHints: z.array(z.string()).optional(),
  presentation: z.unknown().optional(),
  origin: z.record(z.string(), z.string()).optional(),
}).passthrough();

const SemanticsFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.array(z.unknown()).max(5_000),
}).passthrough();

export type ToolSemanticsEntry = z.infer<typeof SemanticsEntrySchema>;

export interface ToolSemantics {
  byStableKey: ReadonlyMap<string, ToolSemanticsEntry>;
```

with:

```ts
const MAX_HINT = 500;
const MAX_LABEL = 200;

const SemanticsFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.array(z.unknown()).max(5_000),
}).passthrough();

export interface ToolSemantics {
  byStableKey: ReadonlyMap<string, ToolSemanticsEntry>;
```

In `src/codegen/tools/prose.ts`, replace:

```ts
  file.data.tools.forEach((value, index) => {
    const entry = SemanticsEntrySchema.safeParse(value);
    if (!entry.success || (!entry.data.stableKey && !entry.data.name)) {
      findings.push(toolFinding('tool-semantics-invalid', 'warning', `${TOOLS_PATHS.semantics}#${index}`,
        `Entry ${index} of tool-semantics.json is invalid and is ignored.`));
      return;
    }
    if (entry.data.stableKey) byStableKey.set(entry.data.stableKey, entry.data);
```

with:

```ts
  file.data.tools.forEach((value, index) => {
    const entry = SemanticsEntrySchema.safeParse(value);
    if (!entry.success || (!entry.data.stableKey && !entry.data.name)) {
      // An agent entry that does not even parse is a rejected agentic entry (spec 4.6).
      const agentic = isAgenticSemantics(value);
      const path = entry.success ? '' : entry.error.issues[0]?.path.map(String).join('.') ?? '';
      findings.push(toolFinding(agentic ? 'resolution-rejected' : 'tool-semantics-invalid', 'warning', `${TOOLS_PATHS.semantics}#${index}`,
        `Entry ${index} of tool-semantics.json is invalid${path ? ` at ${path}` : ''} and is ignored.`));
      return;
    }
    if (entry.data.stableKey) byStableKey.set(entry.data.stableKey, entry.data);
```

In `src/codegen/tools/prose.ts`, replace:

```ts
  jsDoc?: string;
  hints?: ToolProseHints;
  semantics: ToolSemantics;
  policyDescription?: string;
}

/** Prose without a model; templates are the visible floor, never a blocker. */
export function resolveToolProse(input: ResolveToolProseInput): ToolProse {
  const entry = input.semantics.byStableKey.get(input.stableKey) ?? input.semantics.byName.get(input.definitionId);
  const entryOrigin: DescriptionOrigin = entry?.origin?.description === 'agent'
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
```

with:

```ts
  jsDoc?: string;
  hints?: ToolProseHints;
  semantics: ToolSemantics;
  /** The entry the pipeline already checked; `null` when it was rejected. Looked up when absent. */
  entry?: ToolSemanticsEntry | null;
  policyDescription?: string;
}

/** The semantics entry of a tool: by stable key first, then by definition id. */
export function lookupSemantics(
  semantics: ToolSemantics,
  stableKey: string,
  definitionId: string,
): ToolSemanticsEntry | undefined {
  return semantics.byStableKey.get(stableKey) ?? semantics.byName.get(definitionId);
}

/** Prose without a model; templates are the visible floor, never a blocker. */
export function resolveToolProse(input: ResolveToolProseInput): ToolProse {
  const entry = input.entry === undefined
    ? lookupSemantics(input.semantics, input.stableKey, input.definitionId)
    : input.entry ?? undefined;
  const entryOrigin: DescriptionOrigin = entry?.origin?.description === 'agent'
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
```

In `src/codegen/tools/prose.ts`, replace:

```ts
    .slice(0, 50);
  const hintSource = input.hints?.usageHints?.length
    ? input.hints.usageHints
    : entry?.usageHints?.length ? entry.usageHints : [description];
  const usageHints = hintSource
    .map((hint) => bounded(hint, MAX_HINT))
    .filter((hint): hint is string => hint !== undefined)
```

with:

```ts
    .slice(0, 50);
  const hintSource = input.hints?.usageHints?.length
    ? input.hints.usageHints
    : entry?.usageHints?.length || entry?.approvalHint
      ? [...entry.usageHints ?? [], ...entry.approvalHint ? [entry.approvalHint] : []]
      : [description];
  const usageHints = hintSource
    .map((hint) => bounded(hint, MAX_HINT))
    .filter((hint): hint is string => hint !== undefined)
```

Create `src/codegen/tools/semantics.ts`:

```ts
import { z } from 'zod';
import { ToolPresentationSchema } from '../../contracts/index.js';
import { createJsonSchemaLike } from '../../runtime/json-schema.js';
import { AGENT_MODEL_PATTERN, agenticContentProblem, lockDigest } from './agentic.js';
import { compareCodeUnits } from './canonical.js';
import { toolFinding } from './findings.js';
import type { JsonSchemaLike, ToolFinding } from './types.js';

/** Languages of synonyms, titles and example sentences (spec 4.7 "DE/EN"). */
export const SEMANTICS_LANGUAGES = ['de', 'en'] as const;
export type SemanticsLanguage = typeof SEMANTICS_LANGUAGES[number];

/** Fields of a `tool-semantics.json` entry that carry an origin and can be locked. */
export const SEMANTICS_FIELDS = [
  'description',
  'title',
  'module',
  'sharedWith',
  'usageHints',
  'presentation',
  'synonyms',
  'examples',
  'exampleCalls',
  'approvalHint',
] as const;
export type SemanticsField = typeof SEMANTICS_FIELDS[number];

export const SEMANTICS_LIMITS = {
  description: 1_000,
  title: 200,
  hint: 500,
  hints: 20,
  synonym: 100,
  synonyms: 20,
  example: 200,
  examplesMin: 3,
  examplesMax: 5,
  exampleCalls: 10,
  approvalHint: 500,
  sharedWith: 50,
} as const;

const digest = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/;
const text = (max: number) => z.string().trim().min(1).max(max);
const perLanguage = <T extends z.ZodType>(item: T) => z.object({ de: item.optional(), en: item.optional() }).strict();

/**
 * One entry of `.glirastes/tool-semantics.json` (spec 4.3, 4.7): the Get It
 * Done format (`name`, `modelName`, `description`, `module`, `sharedWith`,
 * `usageHints`, `presentation`) plus the stage-2 fields. A field without an
 * origin was written by a human; `locked` pins reviewed fields by digest;
 * `agent` names who wrote the agent fields and for which interface.
 */
export const SemanticsEntrySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  stableKey: z.string().trim().min(1).max(2_100).optional(),
  /** Written by older exports; read for compatibility, never used. */
  modelName: z.string().optional(),
  description: z.string().optional(),
  module: z.string().optional(),
  sharedWith: z.array(z.string()).optional(),
  usageHints: z.array(z.string()).optional(),
  presentation: z.unknown().optional(),
  title: perLanguage(text(SEMANTICS_LIMITS.title)).optional(),
  synonyms: perLanguage(z.array(text(SEMANTICS_LIMITS.synonym)).max(SEMANTICS_LIMITS.synonyms)).optional(),
  examples: perLanguage(z.array(text(SEMANTICS_LIMITS.example))
    .min(SEMANTICS_LIMITS.examplesMin).max(SEMANTICS_LIMITS.examplesMax)).optional(),
  exampleCalls: z.array(z.object({
    sentence: text(SEMANTICS_LIMITS.example).optional(),
    input: z.record(z.string(), z.unknown()),
  }).strict()).max(SEMANTICS_LIMITS.exampleCalls).optional(),
  approvalHint: text(SEMANTICS_LIMITS.approvalHint).optional(),
  origin: z.partialRecord(z.enum(SEMANTICS_FIELDS), z.enum(['human', 'code', 'agent'])).optional(),
  locked: z.partialRecord(z.enum(SEMANTICS_FIELDS), digest).optional(),
  agent: z.object({
    model: z.string().regex(AGENT_MODEL_PATTERN),
    interfaceDigest: digest,
  }).strict().optional(),
}).strict();

export type ToolSemanticsEntry = z.infer<typeof SemanticsEntrySchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an agent wrote the entry or one of its fields; such entries get the unified check. */
export function isAgenticSemantics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.agent !== undefined) return true;
  return isRecord(value.origin) && Object.values(value.origin).includes('agent');
}

/** The app's language plus English, each once. */
export function requiredLanguages(locale: string): SemanticsLanguage[] {
  const own = locale.toLowerCase().split('-')[0];
  return own === 'de' ? ['de', 'en'] : ['en'];
}

export interface SemanticsCheckContext {
  stableKey: string;
  /** Interface the tool has now; an agent entry for another one is stale. */
  interfaceDigest?: string;
  /** The tool's input JSON Schema; example calls must satisfy it. */
  input?: JsonSchemaLike;
}

export interface SemanticsCheck {
  entry?: ToolSemanticsEntry;
  findings: ToolFinding[];
  /** An agent entry written for an earlier interface: still used, listed for renewal. */
  stale: boolean;
}

function fieldValue(entry: ToolSemanticsEntry, field: SemanticsField): unknown {
  return entry[field];
}

function proseOf(entry: ToolSemanticsEntry): unknown {
  return {
    description: entry.description,
    title: entry.title,
    usageHints: entry.usageHints,
    synonyms: entry.synonyms,
    examples: entry.examples,
    approvalHint: entry.approvalHint,
    presentation: entry.presentation,
    sentences: entry.exampleCalls?.map((call) => call.sentence),
  };
}

function agentLimitsProblem(entry: ToolSemanticsEntry): string | undefined {
  if (entry.description !== undefined && entry.description.length > SEMANTICS_LIMITS.description) {
    return `the description is longer than ${SEMANTICS_LIMITS.description} characters`;
  }
  const hints = entry.usageHints ?? [];
  if (hints.length > SEMANTICS_LIMITS.hints || hints.some((hint) => hint.length > SEMANTICS_LIMITS.hint)) {
    return `usageHints hold at most ${SEMANTICS_LIMITS.hints} hints of ${SEMANTICS_LIMITS.hint} characters`;
  }
  const identifiers = [...(entry.module === undefined ? [] : [entry.module]), ...(entry.sharedWith ?? [])];
  if ((entry.sharedWith?.length ?? 0) > SEMANTICS_LIMITS.sharedWith || identifiers.some((name) => !IDENTIFIER.test(name))) {
    return 'module and sharedWith must be module names (letters, digits, _, . or -)';
  }
  if (entry.presentation !== undefined && !ToolPresentationSchema.safeParse(entry.presentation).success) {
    return 'the presentation does not match its schema (locale, singular, plural, approval)';
  }
  return undefined;
}

/**
 * The unified check of one semantics entry against the tool it describes
 * (spec 4.6, 4.7). Locked fields must still match their digest and never be
 * marked as agent output. No entry may carry secrets, provider keys or
 * control characters: `origin` is the writer's own claim, and synonyms reach
 * the generated module. An agent entry must also name its model and
 * interface, stay within the prose and length limits and give example calls
 * that the tool's input schema accepts. A rejected entry is ignored and
 * reported; an agent entry for an earlier interface stays in use and is
 * listed for renewal.
 */
export function validateSemanticsEntry(entry: ToolSemanticsEntry, context: SemanticsCheckContext): SemanticsCheck {
  const agentic = isAgenticSemantics(entry);
  const reject = (reason: string): SemanticsCheck => ({
    findings: [toolFinding(agentic || entry.locked ? 'resolution-rejected' : 'tool-semantics-invalid', 'warning',
      context.stableKey, `The tool-semantics.json entry was rejected: ${reason}.`)],
    stale: false,
  });
  for (const field of SEMANTICS_FIELDS) {
    const pinned = entry.locked?.[field];
    if (pinned === undefined) continue;
    if (entry.origin?.[field] === 'agent') return reject(`the locked field ${field} is marked as agent output`);
    if (lockDigest(fieldValue(entry, field) ?? null) !== pinned) {
      return reject(`the locked field ${field} was changed after review; restore it from git, or review it and run glirastes tools verify`);
    }
  }
  const content = agenticContentProblem({
    prose: proseOf(entry), module: entry.module, sharedWith: entry.sharedWith, calls: entry.exampleCalls?.map((call) => call.input),
  });
  if (content) return reject(`it contains ${content}`);
  if (agentic) {
    if (!entry.agent) return reject('an agent entry names its model and the interfaceDigest it was written for (agent.model, agent.interfaceDigest)');
    const business = agenticContentProblem(proseOf(entry), { prose: true });
    if (business) return reject(`it contains ${business}`);
    const limits = agentLimitsProblem(entry);
    if (limits) return reject(limits);
  }
  if (entry.exampleCalls?.length) {
    if (!context.input) return reject('example calls need a tool with an input contract');
    const schema = createJsonSchemaLike(context.input);
    const index = entry.exampleCalls.findIndex((call) => !schema.safeParse(call.input).success);
    if (index >= 0) return reject(`example call ${index + 1} does not match the input schema`);
  }
  const stale = entry.agent !== undefined && context.interfaceDigest !== undefined
    && entry.agent.interfaceDigest !== context.interfaceDigest;
  return { entry, findings: [], stale };
}

export interface SemanticsFacts {
  /** Fields a human wrote, the code supplied or a review locked; an agent never replaces them. */
  protectedFields: SemanticsField[];
  hasSynonyms: boolean;
  /** Required languages without 3–5 example sentences. */
  missingExamples: SemanticsLanguage[];
}

export function semanticsFacts(
  entry: ToolSemanticsEntry | undefined,
  languages: ReadonlyArray<SemanticsLanguage>,
): SemanticsFacts {
  const protectedFields = entry
    ? SEMANTICS_FIELDS.filter((field) => fieldValue(entry, field) !== undefined
      && (entry.locked?.[field] !== undefined || entry.origin?.[field] !== 'agent'))
    : [];
  return {
    protectedFields,
    hasSynonyms: SEMANTICS_LANGUAGES.some((language) => (entry?.synonyms?.[language]?.length ?? 0) > 0),
    missingExamples: languages.filter((language) => (entry?.examples?.[language]?.length ?? 0) === 0),
  };
}

/** Synonyms and example sentences of both languages, each once, in code-unit order. */
export function semanticsSearch(entry: ToolSemanticsEntry | undefined): { synonyms: string[]; examples: string[] } {
  const collect = (values: ReadonlyArray<string>) => [...new Set(values.map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort(compareCodeUnits);
  return {
    synonyms: collect(SEMANTICS_LANGUAGES.flatMap((language) => entry?.synonyms?.[language] ?? []))
      .slice(0, SEMANTICS_LIMITS.synonyms),
    examples: collect(SEMANTICS_LANGUAGES.flatMap((language) => entry?.examples?.[language] ?? [])),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/prose.test.ts src/codegen/tools/semantics.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  32 passed (32)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/prose.test.ts src/codegen/tools/prose.ts src/codegen/tools/semantics.test.ts src/codegen/tools/semantics.ts
git commit -m "feat(codegen): define and check the stage-2 tool semantics"
```

### Task 4: Checked semantics in the pipeline, the contracts file and the generated module

**Files:**
- Modify: `src/codegen/tools/types.ts` (`ObservedInterface`, `ObservedTool.interface`/`files`, `ToolSearchFacts`, `ToolContractsEntry.search`), `src/codegen/tools/files.ts` (`search` in `tool-contracts.json`), `src/codegen/tools/sources/next-endpoints.ts` (interface and files per route), `src/codegen/tools/sources/ui-tools.ts` (interface and files of UI tools), `src/codegen/tools/sources/react-actions.ts` (registration files), `src/codegen/tools/pipeline.ts` (semantics check per tool, `semantics-stale`, `search`, `ToolsPipelineTool`, `ToolsPipelineResult.tools`), `src/codegen/tools/emit-module.ts` (`toolSearchSemantics`), `src/codegen/tools/findings.ts` (`semantics-stale`)
- Test: `src/codegen/tools/pipeline.test.ts` (new describe block "stage-2 semantics"), `src/codegen/tools/emit-module.test.ts` (synonyms export, empty export, strict type check against `ToolSearchSemanticsMap`)

**Interfaces:**
- Consumes: Task 3 `validateSemanticsEntry`, `semanticsFacts`, `semanticsSearch`, `requiredLanguages`, `lookupSemantics`; P07 `ToolSearchSemanticsMap` (`glirastes/runtime`) and `createAiChatHandler({ toolSemantics })`.
- Produces:
  - `ToolsPipelineTool` (exported from `src/codegen/tools/pipeline.ts`): `{ toolId, stableKey, definitionId, modelName, executionKind, route, files, contract, interfaceDigest, params, defaults, enabled, riskClass, requiresApproval, localPolicy, module, description, descriptionOrigin, schemaQuality, semantics: SemanticsFacts & { stale, rejected }, findings }`; `ToolsPipelineResult.tools?: ToolsPipelineTool[]` (in memory only, never written; empty when the refresh stopped early, absent in integrity mode).
  - `tool-contracts.json` entries gain `search?: { synonyms?: string[] (1–20, ≤ 100 chars), examples?: string[] (1–10, ≤ 200 chars) }`; the generated module exports `toolSearchSemantics` (`{ [modelName]: { synonyms } }` of enabled tools, `as const` in TypeScript) for `createAiChatHandler({ toolSemantics })`.
  - New warning `semantics-stale`. Every existing app sees its generated module drift once after the SDK upgrade (the new `toolSearchSemantics` lines); `tool-contracts.json` changes only for tools with synonyms or examples. `tools refresh` writes them, as P04 did for its artifact fields.

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/emit-module.test.ts`, replace:

```ts
    expect(text).not.toContain('export type');
  });

  it('emits an empty module when no tool is enabled', () => {
    const empty = AppSetupArtifactSchema.parse({ ...artifact, tools: [artifact.tools[2]], planner: { ...artifact.planner, toolIds: [] } });
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: empty, contracts: contracts('src/a.ts') });
    expect(text).toContain('export type GeneratedToolId = never;');
    expect(text).toContain('  return [];');
    expect(text).not.toContain('glirastes/server');
  });
```

with:

```ts
    expect(text).not.toContain('export type');
  });

  it('exports the synonyms of enabled tools for find_tools, keyed by model-facing name', () => {
    const searched = contracts('src/app/api/notes/schemas.ts').map((entry) => (
      entry.toolId === id('a2') ? { ...entry, search: { synonyms: ['Notizen', 'memos'], examples: ['Show my notes'] } }
        : entry.toolId === id('a3') ? { ...entry, search: { synonyms: ['archive'] } } : entry
    ));
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.js', artifact, contracts: searched });
    expect(text).toContain('export const toolSearchSemantics = {\n  "notes_list": {\n    "synonyms": [\n      "Notizen",\n      "memos"\n    ]\n  }\n};');
    expect(text).not.toContain('"notes_archive": {');
    expect(text).not.toContain('Show my notes');
  });

  it('emits an empty module when no tool is enabled', () => {
    const empty = AppSetupArtifactSchema.parse({ ...artifact, tools: [artifact.tools[2]], planner: { ...artifact.planner, toolIds: [] } });
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: empty, contracts: contracts('src/a.ts') });
    expect(text).toContain('export type GeneratedToolId = never;');
    expect(text).toContain('export const toolSearchSemantics = {} as const;');
    expect(text).toContain('  return [];');
    expect(text).not.toContain('glirastes/server');
  });
```

In `src/codegen/tools/emit-module.test.ts`, replace:

```ts
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import { createContractBindings } from 'glirastes/runtime';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const bound = createContractBindings(generated);\n'
        + 'export const ids: generated.GeneratedToolId[] = generated.toolCatalog.map((entry) => entry.toolId);\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
```

with:

```ts
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import { createContractBindings } from 'glirastes/runtime';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + "import type { ToolSearchSemanticsMap } from 'glirastes/runtime';\n"
        + 'export const bound = createContractBindings(generated);\n'
        + 'export const ids: generated.GeneratedToolId[] = generated.toolCatalog.map((entry) => entry.toolId);\n'
        + 'export const semantics: ToolSearchSemanticsMap = generated.toolSearchSemantics;\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});
```

with:

```ts
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});

describe('runToolsPipeline (stage-2 semantics)', () => {
  const EXAMPLES = ['Show my tasks', 'Which tasks are still open?', 'List the finished tasks'];

  async function interfaceOf(fixture: AppFixture, stableKey: string): Promise<string> {
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    return contracts.tools.find((entry) => entry.stableKey === stableKey)!.contract!.interfaceDigest;
  }

  it('carries checked synonyms and examples into the contracts file, the module and the tool view', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const interfaceDigest = await interfaceOf(fixture, 'GET /api/tasks');
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [{
        stableKey: 'GET /api/tasks',
        description: 'Lists the caller\'s tasks, optionally by status. Use tasks.create to add one.',
        synonyms: { en: ['to-dos', 'my work'] },
        examples: { en: EXAMPLES },
        exampleCalls: [{ sentence: 'List the finished tasks', input: { status: ['done'] } }],
        origin: { description: 'agent', synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' },
        agent: { model: 'claude-code', interfaceDigest },
      }],
    })}\n`);
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const entry = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)))
      .tools.find((tool) => tool.stableKey === 'GET /api/tasks');
    expect(entry?.search).toEqual({ synonyms: ['my work', 'to-dos'], examples: [...EXAMPLES].sort() });
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    expect(module).toContain('export const toolSearchSemantics = {\n  "tasks_list": {\n    "synonyms": [\n      "my work",');
    const view = result.tools?.find((tool) => tool.stableKey === 'GET /api/tasks');
    expect(view).toMatchObject({
      definitionId: 'tasks.list',
      modelName: 'tasks_list',
      route: 'GET /api/tasks',
      files: ['src/app/api/tasks/route.ts', 'src/lib/schemas.ts', 'src/lib/session.ts'],
      interfaceDigest,
      params: { path: [], query: ['status'], body: [] },
      descriptionOrigin: 'agent',
      schemaQuality: 'field-names',
      semantics: { protectedFields: [], hasSynonyms: true, missingExamples: [], stale: false, rejected: false },
    });
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);

  it('ignores a rejected agent entry and keeps a stale one in use until it is renewed', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const interfaceDigest = await interfaceOf(fixture, 'GET /api/tasks');
    const agent = { model: 'codex', interfaceDigest };
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'GET /api/tasks', description: 'Lists tasks by status.', origin: { description: 'agent' }, agent },
        {
          stableKey: 'POST /api/tasks', description: 'Creates a task.', examples: { en: ['Mail bob@corp.example.org', 'b', 'c'] },
          origin: { description: 'agent', examples: 'agent' }, agent,
        },
      ],
    })}\n`);
    const first = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const post = first.tools?.find((tool) => tool.stableKey === 'POST /api/tasks');
    expect(post).toMatchObject({ descriptionOrigin: 'template', semantics: { rejected: true } });
    expect(post?.findings.map((finding) => finding.code)).toContain('resolution-rejected');
    await fixture.write('src/app/api/tasks/route.ts', `${IMPORTS}${GET_HANDLER.replace(
      "searchParams.getAll('status')", "searchParams.getAll('status'), q: searchParams.get('q')",
    )}${POST_HANDLER}`);
    const changed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const get = changed.tools?.find((tool) => tool.stableKey === 'GET /api/tasks');
    expect(get).toMatchObject({ description: 'Lists tasks by status.', descriptionOrigin: 'agent', semantics: { stale: true } });
    expect(get?.findings.map((finding) => [finding.code, finding.severity])).toContainEqual(['semantics-stale', 'warning']);
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.report)).findings).toContainEqual(expect.objectContaining({
      code: 'semantics-stale', subjectRef: 'GET /api/tasks',
    }));
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/emit-module.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4`
Expected: FAIL — the module has no `toolSearchSemantics`, `tool-contracts.json` has no `search`, `ToolsPipelineResult.tools` is undefined, and a rejected or stale agent entry is neither ignored nor reported. `Test Files  2 failed (2)`, `Tests  5 failed | 27 passed (32)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/emit-module.ts`, replace:

```ts
    }
    return { tool, contract };
  });
  const modules = [...new Set(bound
    .flatMap(({ contract }) => [contract.runtime.input, contract.runtime.output])
    .flatMap((source) => (source.kind === 'module-export' ? [source.module] : [])))]
```

with:

```ts
    }
    return { tool, contract };
  });
  // Search-only synonyms of the enabled tools, keyed like `toolSemantics` of createAiChatHandler.
  const searchSemantics = Object.fromEntries(tools
    .map((tool) => [catalogEntry(tool).modelName as string, contractsById.get(tool.toolId)?.search?.synonyms] as const)
    .filter((entry): entry is readonly [string, string[]] => (entry[1]?.length ?? 0) > 0)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([modelName, synonyms]) => [modelName, { synonyms }]));
  const modules = [...new Set(bound
    .flatMap(({ contract }) => [contract.runtime.input, contract.runtime.output])
    .flatMap((source) => (source.kind === 'module-export' ? [source.module] : [])))]
```

In `src/codegen/tools/emit-module.ts`, replace:

```ts
      ? tools.map((tool) => JSON.stringify(tool.toolId)).join(' | ')
      : 'never'};`, '');
  }
  lines.push('export function createToolBindings() {');
  if (bound.length === 0) {
    lines.push('  return [];');
```

with:

```ts
      ? tools.map((tool) => JSON.stringify(tool.toolId)).join(' | ')
      : 'never'};`, '');
  }
  lines.push(
    '/** Pass as `toolSemantics` to createAiChatHandler: synonyms help find_tools, they never grant a tool. */',
    `export const toolSearchSemantics = ${literal(searchSemantics)}${typescript ? ' as const' : ''};`,
    '',
  );
  lines.push('export function createToolBindings() {');
  if (bound.length === 0) {
    lines.push('  return [];');
```

In `src/codegen/tools/files.ts`, replace:

```ts
  rulesVersion: z.literal(TOOL_POLICY_RULES_VERSION),
}).strict();

export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
```

with:

```ts
  rulesVersion: z.literal(TOOL_POLICY_RULES_VERSION),
}).strict();

/** Synonyms bounded like the runtime index; examples are 3–5 sentences in each of two languages. */
const ToolSearchFactsSchema = z.object({
  synonyms: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  examples: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
}).strict();

export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
```

In `src/codegen/tools/files.ts`, replace:

```ts
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
  }).strict()).max(5_000),
}).strict();

```

with:

```ts
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
    search: ToolSearchFactsSchema.optional(),
  }).strict()).max(5_000),
}).strict();

```

In `src/codegen/tools/findings.ts`, replace:

```ts
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix or remove the tool-resolutions.json or tool-semantics.json entry the message names; the tool keeps its fallback meanwhile.',
  'enrichment-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); it uses the contract derived from code meanwhile.',
  'definition-id-invalid': 'Use a contract id like resource.action (letters and digits, dot-separated).',
  'definition-id-conflict': 'Give one of the tools a distinct contract id.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
```

with:

```ts
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix or remove the tool-resolutions.json or tool-semantics.json entry the message names; the tool keeps its fallback meanwhile.',
  'enrichment-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); it uses the contract derived from code meanwhile.',
  'semantics-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); the earlier agent description stays in use meanwhile.',
  'definition-id-invalid': 'Use a contract id like resource.action (letters and digits, dot-separated).',
  'definition-id-conflict': 'Give one of the tools a distinct contract id.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
  AppSetupArtifactSchema,
  assertAppSetupSemanticParity,
  type AppSetupArtifact,
} from '../../contracts/index.js';
import {
  confirmationFloor,
```

with:

```ts
  AppSetupArtifactSchema,
  assertAppSetupSemanticParity,
  type AppSetupArtifact,
  type ToolRiskClass,
} from '../../contracts/index.js';
import {
  confirmationFloor,
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
  resolveToolPolicy,
  riskTier,
  type EffectiveToolPolicy,
  type ToolPolicyEntry,
} from '../../contracts/tool-policy.js';
import type { AppSetupToolProvenance } from '../../contracts/index.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
```

with:

```ts
  resolveToolPolicy,
  riskTier,
  type EffectiveToolPolicy,
  type ToolPolicyDefaults,
  type ToolPolicyEntry,
} from '../../contracts/tool-policy.js';
import type { AppSetupToolProvenance } from '../../contracts/index.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
  schemaQualityOf,
  ToolReportFileSchema,
  type ArtifactToolInput,
  type ToolReportTool,
} from './artifact.js';
import { compareCodeUnits } from './canonical.js';
```

with:

```ts
  schemaQualityOf,
  ToolReportFileSchema,
  type ArtifactToolInput,
  type SchemaQuality,
  type ToolReportTool,
} from './artifact.js';
import { compareCodeUnits } from './canonical.js';
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
import { sortFindings, toolFinding, TRANSIENT_FINDING_CODES } from './findings.js';
import { readPromptBundle, readToolInputs, type PromptBundleInput } from './inputs.js';
import type { ToolsMode } from './mode.js';
import { resolveToolProse } from './prose.js';
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import { createReactActionSource } from './sources/react-actions.js';
```

with:

```ts
import { sortFindings, toolFinding, TRANSIENT_FINDING_CODES } from './findings.js';
import { readPromptBundle, readToolInputs, type PromptBundleInput } from './inputs.js';
import type { ToolsMode } from './mode.js';
import { lookupSemantics, resolveToolProse, type DescriptionOrigin } from './prose.js';
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import {
  requiredLanguages,
  semanticsFacts,
  semanticsSearch,
  validateSemanticsEntry,
  type SemanticsCheck,
  type SemanticsFacts,
} from './semantics.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import { createReactActionSource } from './sources/react-actions.js';
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
import type {
  ExcludedTool,
  ObservedTool,
  ToolContractsEntry,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
} from './types.js';

export interface ToolsPipelineResult {
  mode: ToolsMode;
```

with:

```ts
import type {
  ExcludedTool,
  ObservedTool,
  ToolContract,
  ToolContractsEntry,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
} from './types.js';

/**
 * What the generator knows about one tool, in memory only: the work lists of
 * `tools resolve --print` and `tools describe --print` are built from it.
 */
export interface ToolsPipelineTool {
  toolId: string;
  stableKey: string;
  definitionId: string;
  modelName: string;
  executionKind: 'endpoint' | 'ui';
  /** `POST /api/tasks` or `UI tasks.highlight`. */
  route: string;
  files: string[];
  contract: ToolContract | null;
  interfaceDigest: string | null;
  params: ToolContract['params'] | null;
  defaults: ToolPolicyDefaults;
  enabled: boolean;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  /** `.glirastes/tool-policy.json` has an entry for this tool. */
  localPolicy: boolean;
  module: string;
  description: string;
  descriptionOrigin: DescriptionOrigin;
  schemaQuality: SchemaQuality;
  semantics: SemanticsFacts & { stale: boolean; rejected: boolean };
  findings: ToolFinding[];
}

export interface ToolsPipelineResult {
  mode: ToolsMode;
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
  outputs: Record<string, string>;
  driftPaths: string[];
  wrote: boolean;
}

export interface ToolsPipelineOptions {
```

with:

```ts
  outputs: Record<string, string>;
  driftPaths: string[];
  wrote: boolean;
  /** Every tool of the refreshed inventory; empty when the refresh stopped early or verified integrity. */
  tools?: ToolsPipelineTool[];
}

export interface ToolsPipelineOptions {
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
): Promise<ToolsPipelineResult> {
  const findings: ToolFinding[] = [];
  const excluded: ExcludedTool[] = [];
  const result = (extra: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult => ({
    mode: options.mode,
    changes: emptyChanges(),
```

with:

```ts
): Promise<ToolsPipelineResult> {
  const findings: ToolFinding[] = [];
  const excluded: ExcludedTool[] = [];
  const toolViews: ToolsPipelineTool[] = [];
  const result = (extra: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult => ({
    mode: options.mode,
    changes: emptyChanges(),
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
    outputs: {},
    driftPaths: [],
    wrote: false,
    ...extra,
  });

```

with:

```ts
    outputs: {},
    driftPaths: [],
    wrote: false,
    tools: toolViews,
    ...extra,
  });

```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
  const artifactTools: ArtifactToolInput[] = [];
  const contractEntries: ToolContractsEntry[] = [];
  const reportTools: ToolReportTool[] = [];

  for (const execution of inventory.executions) {
    const tool = observedByKey.get(execution.stableKey);
```

with:

```ts
  const artifactTools: ArtifactToolInput[] = [];
  const contractEntries: ToolContractsEntry[] = [];
  const reportTools: ToolReportTool[] = [];
  const languages = requiredLanguages(config.locale);

  for (const execution of inventory.executions) {
    const tool = observedByKey.get(execution.stableKey);
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
        `Risk raised from ${previousRisk} to ${resolved.effective.riskClass}; confirmation follows automatically.`));
    }
    findings.push(...tool.findings);
    const prose = resolveToolProse({
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
```

with:

```ts
        `Risk raised from ${previousRisk} to ${resolved.effective.riskClass}; confirmation follows automatically.`));
    }
    findings.push(...tool.findings);
    const semanticsEntry = lookupSemantics(inputs.semantics, execution.stableKey, execution.definitionId);
    const semantics: SemanticsCheck = semanticsEntry
      ? validateSemanticsEntry(semanticsEntry, {
        stableKey: execution.stableKey,
        ...(tool.interface ? { interfaceDigest: tool.interface.digest } : {}),
        ...(tool.contract ? { input: tool.contract.input } : {}),
      })
      : { findings: [], stale: false };
    findings.push(...semantics.findings);
    if (semantics.stale) {
      findings.push(toolFinding('semantics-stale', 'warning', execution.stableKey,
        'The handler interface changed after an agent described this tool; the description stays in use until it is renewed.'));
    }
    const prose = resolveToolProse({
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
      ...(tool.evidence.jsDoc ? { jsDoc: tool.evidence.jsDoc } : {}),
      ...(tool.prose ? { hints: tool.prose } : {}),
      semantics: inputs.semantics,
      ...(resolved.effective.description && resolved.effective.origin.description !== 'code-default'
        ? { policyDescription: resolved.effective.description }
        : {}),
```

with:

```ts
      ...(tool.evidence.jsDoc ? { jsDoc: tool.evidence.jsDoc } : {}),
      ...(tool.prose ? { hints: tool.prose } : {}),
      semantics: inputs.semantics,
      entry: semantics.entry ?? null,
      ...(resolved.effective.description && resolved.effective.origin.description !== 'code-default'
        ? { policyDescription: resolved.effective.description }
        : {}),
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
        schemaSource: schemaQuality,
      },
    });
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
    });
    reportTools.push({
      toolId: execution.toolId,
```

with:

```ts
        schemaSource: schemaQuality,
      },
    });
    const search = semanticsSearch(semantics.entry);
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
      ...(search.synonyms.length > 0 || search.examples.length > 0
        ? {
          search: {
            ...(search.synonyms.length > 0 ? { synonyms: search.synonyms } : {}),
            ...(search.examples.length > 0 ? { examples: search.examples } : {}),
          },
        }
        : {}),
    });
    const requiresApproval = confirmationFloor(resolved.effective.riskClass, resolved.effective.requiresApproval);
    toolViews.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      modelName: modelFacingToolName(execution.definitionId),
      executionKind: execution.executionKind,
      route: execution.executionKind === 'endpoint'
        ? `${execution.method} ${execution.path}`
        : `UI ${execution.actionBindingRef}`,
      files: tool.files ?? (execution.executionKind === 'endpoint' ? [execution.sourceFile] : []),
      contract: tool.contract ?? null,
      interfaceDigest: tool.interface?.digest ?? null,
      params: tool.interface?.params ?? null,
      defaults,
      enabled: resolved.effective.enabled,
      riskClass: resolved.effective.riskClass,
      requiresApproval,
      localPolicy: local !== undefined,
      module: prose.module,
      description: prose.description,
      descriptionOrigin: prose.descriptionOrigin,
      schemaQuality,
      semantics: {
        ...semanticsFacts(semantics.entry, languages),
        stale: semantics.stale,
        rejected: semanticsEntry !== undefined && semantics.entry === undefined,
      },
      findings: [],
    });
    reportTools.push({
      toolId: execution.toolId,
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
      definitionId: execution.definitionId,
      enabled: resolved.effective.enabled,
      riskClass: resolved.effective.riskClass,
      requiresApproval: confirmationFloor(resolved.effective.riskClass, resolved.effective.requiresApproval),
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
```

with:

```ts
      definitionId: execution.definitionId,
      enabled: resolved.effective.enabled,
      riskClass: resolved.effective.riskClass,
      requiresApproval,
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
      findings.push(toolFinding('policy-entry-orphaned', 'warning', key,
        'This tool-policy.json entry matches no tool in the current code.'));
    }
  }
  if (findings.some(isError)) return result({ changes: generation.changes });

```

with:

```ts
      findings.push(toolFinding('policy-entry-orphaned', 'warning', key,
        'This tool-policy.json entry matches no tool in the current code.'));
    }
  }
  for (const view of toolViews) {
    view.findings = sortFindings(findings.filter((finding) => finding.subjectRef === view.stableKey));
  }
  if (findings.some(isError)) return result({ changes: generation.changes });

```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
  resolved?: ResolvedEndpointContract;
  findings: ToolFinding[];
  evidence: ObservedTool['evidence'];
}

interface EnumeratedRoutes {
```

with:

```ts
  resolved?: ResolvedEndpointContract;
  findings: ToolFinding[];
  evidence: ObservedTool['evidence'];
  interface?: ObservedTool['interface'];
  files: string[];
}

interface EnumeratedRoutes {
```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
  resolution: ResolutionEntry | undefined,
): RoutePiece {
  const { entry, analysis, contractModule } = route;
  if (!analysis?.located?.fn) {
    return {
      entry,
      findings: [toolFinding('handler-unresolved', 'needs_attention', entry.stableKey,
        `The ${entry.method} export of ${entry.sourceFile} is not a function the generator can read.`)],
      evidence: { authEvidence: false, externalCall: false },
    };
  }
  const located = analysis.located;
```

with:

```ts
  resolution: ResolutionEntry | undefined,
): RoutePiece {
  const { entry, analysis, contractModule } = route;
  const files = [...new Set([
    entry.sourceFile,
    ...(contractModule ? [contractModule] : []),
    ...(analysis?.importedModules ?? []),
  ])].sort(compareCodeUnits);
  if (!analysis?.located?.fn) {
    return {
      entry,
      findings: [toolFinding('handler-unresolved', 'needs_attention', entry.stableKey,
        `The ${entry.method} export of ${entry.sourceFile} is not a function the generator can read.`)],
      evidence: { authEvidence: false, externalCall: false },
      files,
    };
  }
  const located = analysis.located;
```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
      ...(resolved.declaredEffect ? { declaredEffect: resolved.declaredEffect } : {}),
      ...(located.jsDoc ? { jsDoc: located.jsDoc } : {}),
    },
  };
}

```

with:

```ts
      ...(resolved.declaredEffect ? { declaredEffect: resolved.declaredEffect } : {}),
      ...(located.jsDoc ? { jsDoc: located.jsDoc } : {}),
    },
    interface: {
      digest: resolved.interfaceDigest,
      params: resolved.contract?.params ?? {
        path: [...entry.pathParams],
        query: [...analysis.queryKeys],
        body: analysis.bodyKeys === 'opaque' ? 'opaque' : [...analysis.bodyKeys],
      },
    },
    files,
  };
}

```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
      outputSchemaDigest: resolved?.outputSchemaDigest ?? OPAQUE_SCHEMA_DIGEST,
    },
    ...(resolved?.contract ? { contract: resolved.contract } : {}),
    evidence: piece.evidence,
    findings: piece.findings,
    ...(resolved && Object.keys(resolved.prose).length > 0 ? { prose: resolved.prose } : {}),
```

with:

```ts
      outputSchemaDigest: resolved?.outputSchemaDigest ?? OPAQUE_SCHEMA_DIGEST,
    },
    ...(resolved?.contract ? { contract: resolved.contract } : {}),
    ...(piece.interface ? { interface: piece.interface } : {}),
    files: piece.files,
    evidence: piece.evidence,
    findings: piece.findings,
    ...(resolved && Object.keys(resolved.prose).length > 0 ? { prose: resolved.prose } : {}),
```

In `src/codegen/tools/sources/react-actions.ts`, replace:

```ts
          uiMutation,
        },
        findings: toolFindings,
        ...(jsDoc ? { jsDoc } : {}),
        ...(uiMutation ? { uiMutation } : {}),
      });
```

with:

```ts
          uiMutation,
        },
        findings: toolFindings,
        files: [...new Set(registrations.map((registration) => registration.file))].sort(compareCodeUnits),
        ...(jsDoc ? { jsDoc } : {}),
        ...(uiMutation ? { uiMutation } : {}),
      });
```

In `src/codegen/tools/sources/ui-tools.ts`, replace:

```ts
  prose?: ToolProseHints;
  jsDoc?: string;
  uiMutation?: boolean;
}

/** An `ObservedTool` for a generated UI tool; its contract is JSON Schema read from code. */
```

with:

```ts
  prose?: ToolProseHints;
  jsDoc?: string;
  uiMutation?: boolean;
  /** App-relative files that register or read this tool, for the work lists. */
  files?: string[];
}

/** An `ObservedTool` for a generated UI tool; its contract is JSON Schema read from code. */
```

In `src/codegen/tools/sources/ui-tools.ts`, replace:

```ts
      inputSchemaDigest: input.input ? jsonSchemaDigest(input.input) : OPAQUE_SCHEMA_DIGEST,
      outputSchemaDigest: jsonSchemaDigest(output),
    },
    ...(contract ? { contract } : {}),
    evidence: {
      authEvidence: false,
      externalCall: false,
```

with:

```ts
      inputSchemaDigest: input.input ? jsonSchemaDigest(input.input) : OPAQUE_SCHEMA_DIGEST,
      outputSchemaDigest: jsonSchemaDigest(output),
    },
    ...(contract ? { contract, interface: { digest: contract.interfaceDigest, params: contract.params } } : {}),
    ...(input.files ? { files: [...input.files] } : {}),
    evidence: {
      authEvidence: false,
      externalCall: false,
```

In `src/codegen/tools/types.ts`, replace:

```ts
  presentation?: ToolPresentation;
}

export interface ObservedTool {
  execution: ObservedExecution;
  contract?: ToolContract;
  evidence: {
    authEvidence: boolean;
    externalCall: boolean;
```

with:

```ts
  presentation?: ToolPresentation;
}

/** The interface a tool has now, also when no contract could be resolved. */
export interface ObservedInterface {
  digest: string;
  params: ToolContract['params'];
}

export interface ObservedTool {
  execution: ObservedExecution;
  contract?: ToolContract;
  /** Endpoints always; UI tools when their payload is typed. Read by the work lists. */
  interface?: ObservedInterface;
  /** App-relative files a coding agent reads to resolve or describe this tool. */
  files?: string[];
  evidence: {
    authEvidence: boolean;
    externalCall: boolean;
```

In `src/codegen/tools/types.ts`, replace:

```ts
  origin: 'default' | 'policy' | 'code';
}

export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
}

export interface ToolSourceContext {
```

with:

```ts
  origin: 'default' | 'policy' | 'code';
}

/** Checked stage-2 search data: synonyms reach `find_tools`, examples feed `tools eval`. */
export interface ToolSearchFacts {
  synonyms?: string[];
  examples?: string[];
}

export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
  search?: ToolSearchFacts;
}

export interface ToolSourceContext {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/emit-module.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4 && bunx vitest run src/codegen --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  32 passed (32)`; `src/codegen` reports `Test Files  35 passed (35)`, `Tests  483 passed (483)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/emit-module.test.ts src/codegen/tools/emit-module.ts src/codegen/tools/files.ts src/codegen/tools/findings.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline.ts src/codegen/tools/sources/next-endpoints.ts src/codegen/tools/sources/react-actions.ts src/codegen/tools/sources/ui-tools.ts src/codegen/tools/types.ts
git commit -m "feat(codegen): carry checked tool semantics into search and work lists"
```

### Task 5: Orphaned policy entries of excluded routes

**Files:**
- Modify: `src/codegen/tools/pipeline.ts` (an entry for an excluded route says so; `acceptedRisk` entries without a tool are orphaned too), `src/codegen/tools/findings.ts` (next action names `tools policy reset` and `include`)
- Test: `src/codegen/tools/pipeline.test.ts` (new describe block "orphaned policy entries")

**Interfaces:**
- Consumes: P03 orphan check (`tools` entries matching no observed tool), the source exclusions (`ExcludedTool`).
- Produces: `policy-entry-orphaned` (warning) for every `tools` or `acceptedRisk` key of `tool-policy.json` without an observed tool; for an excluded route the message names the exclusion (`… has no effect: the route is excluded (<reason>, <origin>).`). Roadmap row "Tool-Policy-Einträge für ausgeschlossene Routen werden zusätzlich als `policy-entry-orphaned` gemeldet".

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    }));
  }, 120_000);
});
```

with:

```ts
    }));
  }, 120_000);
});

describe('runToolsPipeline (orphaned policy entries)', () => {
  it('reports entries for excluded routes and accepted risks without a tool as orphaned', async () => {
    const fixture = await app();
    await fixture.write('src/app/api/internal/sync/route.ts', `${IMPORTS}${POST_HANDLER}`);
    await fixture.write(TOOLS_PATHS.policy, JSON.stringify({
      schemaVersion: 1,
      tools: {
        'POST /api/internal/sync': { enabled: false },
        'POST /api/auth/login': { requiresApproval: true },
        'GET /api/tasks': { description: 'Lists your tasks by status.' },
      },
      exclude: [{ match: 'POST /api/internal/**', reason: 'internal' }],
      acceptedRisk: { 'DELETE /api/gone/:id': { riskClass: 'write', toolId: '019fb007-0000-7000-8000-0000000000e1' } },
    }));
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const orphaned = result.findings.filter((finding) => finding.code === 'policy-entry-orphaned');
    expect(orphaned.map((finding) => [finding.subjectRef, finding.message])).toEqual([
      ['DELETE /api/gone/:id', 'This tool-policy.json acceptedRisk entry matches no tool in the current code.'],
      ['POST /api/auth/login', 'This tool-policy.json tools entry matches no tool in the current code.'],
      ['POST /api/internal/sync', 'This tool-policy.json tools entry has no effect: the route is excluded (internal, policy).'],
    ]);
    expect(orphaned[0]?.nextAction).toContain('glirastes tools policy reset');
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.report)).findings
      .filter((finding: { code: string }) => finding.code === 'policy-entry-orphaned')).toHaveLength(3);
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline.test.ts --maxWorkers=4`
Expected: FAIL — the excluded route is reported with the generic "matches no tool" message and the orphaned `acceptedRisk` entry is not reported at all. `Test Files  1 failed (1)`, `Tests  1 failed | 24 passed (25)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/findings.ts`, replace:

```ts
  'risk-raised': 'Nothing to do: confirmation is enforced automatically. Review the change in your diff.',
  'override-lapsed-risk-raised': 'Your relaxation no longer applies at the higher risk; review whether you still need it.',
  'risk-lower-available': 'After review, record an acceptedRisk entry in .glirastes/tool-policy.json to adopt the lower risk.',
  'policy-entry-orphaned': 'Remove the entry from .glirastes/tool-policy.json or restore the tool.',
  'tool-outputs-drift': 'Run glirastes tools refresh locally and commit .glirastes together with the generated module.',
  'tool-output-invalid': 'Regenerate the outputs with glirastes tools refresh; never edit generated files.',
  'generated-output-invalid': 'Nothing was written: the code produced a value past a limit of the generated file (a name, path or list the message names). Shorten or split it in the code, then rerun glirastes tools refresh; if the code is within reason, report it as a Glirastes bug.',
```

with:

```ts
  'risk-raised': 'Nothing to do: confirmation is enforced automatically. Review the change in your diff.',
  'override-lapsed-risk-raised': 'Your relaxation no longer applies at the higher risk; review whether you still need it.',
  'risk-lower-available': 'After review, record an acceptedRisk entry in .glirastes/tool-policy.json to adopt the lower risk.',
  'policy-entry-orphaned': 'Remove the entry (glirastes tools policy reset <tool>), restore the tool, or include an excluded route again (glirastes tools policy include <pattern>).',
  'tool-outputs-drift': 'Run glirastes tools refresh locally and commit .glirastes together with the generated module.',
  'tool-output-invalid': 'Regenerate the outputs with glirastes tools refresh; never edit generated files.',
  'generated-output-invalid': 'Nothing was written: the code produced a value past a limit of the generated file (a name, path or list the message names). Shorten or split it in the code, then rerun glirastes tools refresh; if the code is within reason, report it as a Glirastes bug.',
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
      },
    });
  }
  for (const key of Object.keys(inputs.policy.tools ?? {})) {
    if (!observedByKey.has(key)) {
      findings.push(toolFinding('policy-entry-orphaned', 'warning', key,
        'This tool-policy.json entry matches no tool in the current code.'));
    }
  }
  for (const view of toolViews) {
    view.findings = sortFindings(findings.filter((finding) => finding.subjectRef === view.stableKey));
  }
```

with:

```ts
      },
    });
  }
  // An entry for an excluded route never applies either: say why (roadmap, P05).
  const excludedByKey = new Map(excluded.map((entry) => [entry.stableKey, entry] as const));
  const orphaned = (key: string, section: string) => {
    if (observedByKey.has(key)) return;
    const exclusion = excludedByKey.get(key);
    findings.push(toolFinding('policy-entry-orphaned', 'warning', key, exclusion
      ? `This tool-policy.json ${section} entry has no effect: the route is excluded (${exclusion.reason}, ${exclusion.origin}).`
      : `This tool-policy.json ${section} entry matches no tool in the current code.`));
  };
  for (const key of Object.keys(inputs.policy.tools ?? {})) orphaned(key, 'tools');
  for (const key of Object.keys(inputs.policy.acceptedRisk ?? {})) orphaned(key, 'acceptedRisk');
  for (const view of toolViews) {
    view.findings = sortFindings(findings.filter((finding) => finding.subjectRef === view.stableKey));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  25 passed (25)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/findings.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline.ts
git commit -m "feat(codegen): report policy entries for excluded routes as orphaned"
```

### Task 6: Scan feature folders named like build output

**Files:**
- Modify: `src/codegen/tools/sources/app-files.ts` (`SKIPPED_ANYWHERE`, `SKIPPED_AT_SCAN_ROOT`)
- Test: `src/codegen/tools/sources/ui-tools.test.ts` (new describe block "scanAppSources skip list")

**Interfaces:**
- Consumes: P04 `scanAppSources` (ledger ruling D1 and the Task 14 deferred minors: any-depth skips of `build`, `generated`, `e2e` …; an oversized vendored `public/*.js` under a `src`-less root aborting the scan).
- Produces: `node_modules` and `__tests__` stay skipped at any depth; `dist`, `build`, `out`, `coverage`, `generated`, `e2e`, `storybook-static` and `public` are skipped only directly in the scanned folder (`src`, or the app root). Roadmap row "`scanAppSources` überspringt … in jeder Tiefe".

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/sources/ui-tools.test.ts`, replace:

```ts
  });
});

describe('UI tool observations', () => {
  const input = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };

```

with:

```ts
  });
});

describe('scanAppSources skip list', () => {
  it('skips build output only directly in the source folder and scans feature folders of the same name', async () => {
    const app = await createAppFixture({
      'src/build/chunk.tsx': 'useAiClientAction();',
      'src/generated/glirastes/tools.generated.ts': 'useAiClientAction();',
      'src/app/(app)/build/actions.tsx': 'useAiClientAction();',
      'src/features/e2e/flow.tsx': 'useAiClientAction();',
      'src/features/generated/view.tsx': 'useAiClientAction();',
      'src/features/__tests__/harness.tsx': 'useAiClientAction();',
    });
    const scan = await scanAppSources(app.root, { matches: (source) => source.includes('useAiClientAction') });
    expect(scan.complete && scan.files.map((entry) => entry.path)).toEqual([
      'src/app/(app)/build/actions.tsx', 'src/features/e2e/flow.tsx', 'src/features/generated/view.tsx',
    ]);
  });

  it('leaves static assets of an app without src out of the scan', async () => {
    const app = await createAppFixture({
      'app/page.tsx': 'useAiClientAction();',
      'public/vendor.js': `useAiClientAction();${'x'.repeat(2_000_001)}`,
    });
    const scan = await scanAppSources(app.root, { matches: (source) => source.includes('useAiClientAction') });
    expect(scan).toEqual({ complete: true, files: [expect.objectContaining({ path: 'app/page.tsx' })] });
  });
});

describe('UI tool observations', () => {
  const input = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/ui-tools.test.ts --maxWorkers=4`
Expected: FAIL — `src/app/(app)/build`, `src/features/e2e` and `src/features/generated` are skipped, and the oversized `public/vendor.js` makes the scan incomplete. `Test Files  1 failed (1)`, `Tests  2 failed | 30 passed (32)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/sources/app-files.ts`, replace:

```ts
/** `a.test.tsx`, `a.spec.ts`, `Button.stories.tsx`: test and story files, not app code. */
const TEST_FILE = /\.(?:test|spec|stories)\.[^.]+$/;
/**
 * Dependencies, build output, generated code, tests and story output never
 * register app handlers. A client action or navigation bridge that exists only
 * in a test harness or a story must not enable a tool.
 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'generated',
  '__tests__', 'e2e', 'storybook-static',
]);

export interface AppSourceFile {
```

with:

```ts
/** `a.test.tsx`, `a.spec.ts`, `Button.stories.tsx`: test and story files, not app code. */
const TEST_FILE = /\.(?:test|spec|stories)\.[^.]+$/;
/**
 * Dependencies and test folders never register app handlers, at any depth: a
 * client action or navigation bridge that exists only in a test harness must
 * not enable a tool.
 */
const SKIPPED_ANYWHERE = new Set(['node_modules', '__tests__']);
/**
 * Build output, generated code, coverage, end-to-end suites, story builds and
 * static assets sit directly in the scanned folder, where tools put them. A
 * feature folder with such a name deeper down, e.g. `src/app/(app)/build/` or
 * `src/features/e2e/`, is app code and is scanned.
 */
const SKIPPED_AT_SCAN_ROOT = new Set([
  'dist', 'build', 'out', 'coverage', 'generated', 'e2e', 'storybook-static', 'public',
]);

export interface AppSourceFile {
```

In `src/codegen/tools/sources/app-files.ts`, replace:

```ts
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (await linkHidesFiles(absolute, isScannedSource(entry.name))) {
```

with:

```ts
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_ANYWHERE.has(entry.name)) continue;
      if (directory === start && SKIPPED_AT_SCAN_ROOT.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (await linkHidesFiles(absolute, isScannedSource(entry.name))) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/ui-tools.test.ts --maxWorkers=4 && bunx vitest run src/codegen/tools/sources --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  32 passed (32)`; `src/codegen/tools/sources` reports `Test Files  6 passed (6)`, `Tests  68 passed (68)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/sources/app-files.ts src/codegen/tools/sources/ui-tools.test.ts
git commit -m "fix(codegen): scan feature folders named like build output"
```

### Task 7: Client actions that may write through helpers

**Files:**
- Modify: `src/codegen/tools/sources/react-actions.ts` (`writeEvidence` replaces `writes`), `src/codegen/tools/findings.ts` (`ui-action-write-unproven`)
- Test: `src/codegen/tools/sources/react-actions.test.ts` (one new case)

**Interfaces:**
- Consumes: P04 literal write detection (ledger D4); `AppProgram.checker`/`appRelative`.
- Produces: warning `ui-action-write-unproven` (subject: the tool's stable key) when a client action handler does not provably write but calls a function declared in another app file, a mutation hook method (`mutate`, `mutateAsync`, `trigger`) or `fetch` with a method the generator cannot read. The tool stays `safe-read` (spec 4.5 "nachweisbar"); the work list of Task 8 hands it to the developer as `glirastes tools policy raise <tool> write`. Roadmap row "Client-Aktion zählt nur als schreibend … markiert die Skill-Arbeitsliste".

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/sources/react-actions.test.ts`, replace:

```ts
    expect(tool?.findings).toEqual([expect.objectContaining({ code: 'ui-action-contract-conflict', severity: 'needs_attention' })]);
  }, 120_000);

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
```

with:

```ts
    expect(tool?.findings).toEqual([expect.objectContaining({ code: 'ui-action-contract-conflict', severity: 'needs_attention' })]);
  }, 120_000);

  it('flags handlers that may write through a helper, a mutation hook or a computed fetch method', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/api.ts': 'export async function archiveTask(id: string) {\n'
        + "  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });\n}\n",
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\nimport { archiveTask } from './lib/api';\n"
        + 'declare const mutation: { mutate(input: unknown): void };\n'
        + 'export function A() {\n'
        + "  useAiClientAction('tasks.archive', (payload: { taskId: string }) => archiveTask(payload.taskId));\n"
        + "  useAiClientAction('tasks.star', (payload: { taskId: string }) => mutation.mutate(payload));\n"
        + "  useAiClientAction('tasks.sync', (payload: { method: string }) => fetch('/api/sync', { method: payload.method }));\n"
        + "  useAiClientAction('tasks.peek', (payload: { taskId: string }) => console.log(payload.taskId));\n"
        + '  return null;\n}\n',
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    const unproven = (name: string) => tools.get(name)?.findings
      .find((finding) => finding.code === 'ui-action-write-unproven');
    expect(unproven('ui.tasks.archive')).toMatchObject({
      severity: 'warning',
      subjectRef: 'UI action tasks.archive',
      message: 'tasks.archive calls archiveTask from src/lib/api.ts; if that changes data, raise the tool to write so the chat asks first.',
    });
    expect(unproven('ui.tasks.archive')?.nextAction).toContain('glirastes tools policy raise <tool> write');
    expect(unproven('ui.tasks.star')?.message).toContain('calls mutation.mutate()');
    expect(unproven('ui.tasks.sync')?.message).toContain('calls fetch with a method the generator cannot read');
    expect(unproven('ui.tasks.peek')).toBeUndefined();
    expect(tools.get('ui.tasks.archive')?.evidence.uiMutation).toBeUndefined();
    expect(tools.get('ui.tasks.archive')?.files).toEqual(['src/a.tsx']);
  }, 120_000);

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/react-actions.test.ts --maxWorkers=4`
Expected: FAIL — no `ui-action-write-unproven` finding exists. `Test Files  1 failed (1)`, `Tests  1 failed | 3 passed (4)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/findings.ts`, replace:

```ts
  'ui-action-id-dynamic': 'Register client actions with a literal id so the chat can call them.',
  'ui-action-id-invalid': 'Use an action id of letters, digits, dots and dashes, e.g. tasks.highlight.',
  'ui-action-id-reserved': 'Ids starting with glirastes. belong to the SDK; choose another action id.',
};

/**
```

with:

```ts
  'ui-action-id-dynamic': 'Register client actions with a literal id so the chat can call them.',
  'ui-action-id-invalid': 'Use an action id of letters, digits, dots and dashes, e.g. tasks.highlight.',
  'ui-action-id-reserved': 'Ids starting with glirastes. belong to the SDK; choose another action id.',
  'ui-action-write-unproven': 'If the handler changes data through a helper, a Server Action or a mutation hook, raise the tool: glirastes tools policy raise <tool> write. Otherwise nothing to do.',
};

/**
```

In `src/codegen/tools/sources/react-actions.ts`, replace:

```ts
const BUS_MODULES: ReadonlySet<string> = new Set(['glirastes/react', 'glirastes/browser']);
const REGISTRATION_TEXT = /useAiClientAction|registerAiClientAction|subscribeById/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EMPTY_PAYLOAD: JsonSchemaLike = { type: 'object', properties: {}, additionalProperties: false };

interface Registration {
```

with:

```ts
const BUS_MODULES: ReadonlySet<string> = new Set(['glirastes/react', 'glirastes/browser']);
const REGISTRATION_TEXT = /useAiClientAction|registerAiClientAction|subscribeById/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Calls of mutation hooks (React Query, SWR) whose effect the generator cannot see. */
const MUTATION_CALLS: ReadonlySet<string> = new Set(['mutate', 'mutateAsync', 'trigger']);
const EMPTY_PAYLOAD: JsonSchemaLike = { type: 'object', properties: {}, additionalProperties: false };

interface Registration {
```

In `src/codegen/tools/sources/react-actions.ts`, replace:

```ts
  return objectSchema(app, type, parameter);
}

/** A non-GET `fetch(…, { method })` or an `axios` write in the handler body. */
function writes(handler: ts.SignatureDeclaration | undefined): boolean {
  const body = handler && 'body' in handler ? (handler as ts.FunctionLikeDeclaration).body : undefined;
  if (!body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') {
```

with:

```ts
  return objectSchema(app, type, parameter);
}

interface WriteEvidence {
  /** A non-GET `fetch(…, { method })` or an `axios` write: the tool writes. */
  writes: boolean;
  /** A call that may write but does not show it (D4): a helper of another app file, a mutation hook, a computed fetch method. */
  unproven?: string;
}

/** The app file that declares what a call refers to, when it is not the handler's own file. */
function otherAppFile(app: AppProgram, callee: ts.Expression, ownFile: string): string | undefined {
  const target = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  let symbol = app.checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  const file = declaration ? app.appRelative(declaration.getSourceFile().fileName) : undefined;
  return file && file !== ownFile ? file : undefined;
}

function calleeLabel(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return `${calleeLabel(callee.expression)}.${callee.name.text}`;
  return 'a computed function';
}

/** What the handler body shows about writing (spec 4.5 "nachweisbar"). */
function writeEvidence(app: AppProgram, handler: ts.SignatureDeclaration | undefined): WriteEvidence {
  const body = handler && 'body' in handler ? (handler as ts.FunctionLikeDeclaration).body : undefined;
  if (!body) return { writes: false };
  const ownFile = app.appRelative(body.getSourceFile().fileName) ?? '';
  let writes = false;
  let unproven: string | undefined;
  const visit = (node: ts.Node): void => {
    if (writes) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') {
```

In `src/codegen/tools/sources/react-actions.ts`, replace:

```ts
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'method'))
          : undefined;
        const value = method ? unwrap(method.initializer) : undefined;
        if (value && ts.isStringLiteralLike(value) && WRITE_METHODS.has(value.text.toUpperCase())) found = true;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'axios' && ['post', 'put', 'patch', 'delete'].includes(callee.name.text)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function docOf(source: ts.SourceFile, node: ts.Node | undefined): string | undefined {
```

with:

```ts
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'method'))
          : undefined;
        const value = method ? unwrap(method.initializer) : undefined;
        if (value && ts.isStringLiteralLike(value)) {
          if (WRITE_METHODS.has(value.text.toUpperCase())) writes = true;
        } else if (options && (!ts.isObjectLiteralExpression(options) || method || options.properties.some(ts.isSpreadAssignment))) {
          unproven ??= 'fetch with a method the generator cannot read';
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'axios' && ['post', 'put', 'patch', 'delete'].includes(callee.name.text)) {
        writes = true;
      } else {
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name && MUTATION_CALLS.has(name)) {
          unproven ??= `${calleeLabel(callee)}()`;
        } else {
          const file = otherAppFile(app, callee, ownFile);
          if (file) unproven ??= `${calleeLabel(callee)} from ${file}`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return writes ? { writes } : { writes, ...(unproven ? { unproven } : {}) };
}

function docOf(source: ts.SourceFile, node: ts.Node | undefined): string | undefined {
```

In `src/codegen/tools/sources/react-actions.ts`, replace:

```ts
            ?? (handler && ts.isFunctionDeclaration(handler) ? docOf(handler.getSourceFile(), handler) : undefined);
        })
        .find((doc) => doc !== undefined);
      const uiMutation = handlers.some((handler) => writes(handler));
      return uiObservation({
        stableKey,
        definitionId: ids.get(stableKey)!,
```

with:

```ts
            ?? (handler && ts.isFunctionDeclaration(handler) ? docOf(handler.getSourceFile(), handler) : undefined);
        })
        .find((doc) => doc !== undefined);
      const evidence = handlers.map((handler) => writeEvidence(app, handler));
      const uiMutation = evidence.some((entry) => entry.writes);
      const unproven = evidence.find((entry) => entry.unproven)?.unproven;
      if (!uiMutation && unproven) {
        toolFindings.push(toolFinding('ui-action-write-unproven', 'warning', stableKey,
          `${actionId} calls ${unproven}; if that changes data, raise the tool to write so the chat asks first.`));
      }
      return uiObservation({
        stableKey,
        definitionId: ids.get(stableKey)!,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/react-actions.test.ts --maxWorkers=4 && bunx vitest run src/codegen/tools/sources/react-actions.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  4 passed (4)`; `src/codegen/tools/sources/react-actions.test.ts src/codegen/tools/pipeline.test.ts` reports `Test Files  2 passed (2)`, `Tests  29 passed (29)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/findings.ts src/codegen/tools/sources/react-actions.test.ts src/codegen/tools/sources/react-actions.ts
git commit -m "feat(codegen): flag client actions that may write through helpers"
```

### Task 8: `glirastes tools resolve --print`: the stage-1 work list

**Files:**
- Create: `src/codegen/tools/worklist.ts` (work list types, `buildResolveWorklist`, templates), `src/cli/commands/tools/resolve.ts`
- Modify: `src/cli/commands/tools/index.ts` (dispatch and usage)
- Test: `src/codegen/tools/worklist.test.ts` (Create; real pipeline on a fixture: items, evidence, targets, stability, emptying once answered, blocking errors); `src/cli/commands/tools/tools-command.test.ts` (one new case)

**Interfaces:**
- Consumes: Task 4 `ToolsPipelineResult.tools`; Task 7 `ui-action-write-unproven`; P03/P04 finding codes; `TOOLS_PATHS`.
- Produces:
  - `src/codegen/tools/worklist.ts`: `WORKLIST_SCHEMA_VERSION` (1), `MODEL_PLACEHOLDER`, `type WorklistTarget` (`file` | `app-code` | `developer`), `WorklistEvidence`, `ResolveWorkItem`, `BlockingFinding`, `ResolveWorklist`, `toolKey(stableKey)` (`tools["<stableKey>"]`), `semanticsKey(stableKey)` (`tools[stableKey="<stableKey>"]`, the list notation of `tool-semantics.json`), `inputSchemaSkeleton(tool)`, `resolutionEntryTemplate(tool)`, `buildResolveWorklist(result)`.
  - Mapping: `input-contract-unresolved`, `input-role-unclear`, `input-role-unsupported`, `schema-json-unavailable`, and `contract-stale` of a resolution ⇒ agent, `tool-resolutions.json` entry with the template; `auth-evidence-missing` ⇒ agent, `conventions.authHelpers`; `resolution-rejected` and `tool-semantics-invalid` ⇒ agent, the named entry in its file and notation; `parameter-collision`, `schema-not-exported`, `schema-module-unloadable`, `schema-content-rejected`, `contract-effect-invalid`, `handler-unresolved`, `navigation-bridge-missing`, `ui-action-payload-untyped`, `ui-action-contract-conflict`, `filter-keys-capped` and `contract-stale` of a contract module ⇒ agent, app code; the warnings about code stage 1 left out (`ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`, `definition-id-invalid`, `contract-presentation-invalid`) ⇒ agent, app code, with the registration's file when no tool exists; `ui-action-write-unproven` (unless the tool already has a local policy entry), `risk-lower-available`, `policy-entry-orphaned`, `override-lapsed-risk-raised`, `E-POLICY-002` ⇒ developer with the `glirastes tools policy` command; every other error ⇒ `blocking`.
  - `glirastes tools resolve --print [--root <dir>] [--json]` runs the pipeline frozen with `keepGoing` and prints the list as indented JSON; without `--print` it exits 2 (Glirastes never runs a model). `RESOLVE_ARGS` is exported for Task 19.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
      .not.toContain('Platform may relax');
  });

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
```

with:

```ts
      .not.toContain('Platform may relax');
  });

  it('prints the resolve work list from a frozen read and refuses to run without --print', async () => {
    const h = harness(emptyResult({ mode: 'frozen' }));
    expect(await runToolsCommand(['resolve'], h.deps())).toBe(2);
    expect(h.err.join('\n')).toContain('Glirastes never runs a model. Use --print.');
    expect(await runToolsCommand(['resolve', '--print', '--root', 'web'], h.deps())).toBe(0);
    expect(h.calls).toEqual([{ root: '/app/web', mode: 'frozen', keepGoing: true }]);
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      schemaVersion: 1, kind: 'resolve', outputsCurrent: true, blocking: [], items: [], next: expect.stringContaining('glirastes tools resolve --print'),
    });
  });

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
```

Create `src/codegen/tools/worklist.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { TOOLS_PATHS } from './config.js';
import { runToolsPipeline } from './pipeline.js';
import { buildResolveWorklist, MODEL_PLACEHOLDER, type ResolveWorkItem } from './worklist.js';

afterEach(removeAppFixtures);

const SESSION = "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n"
  + "export async function checkMembership(request: Request) {\n  return request.headers.get('x-team') !== null;\n}\n";
const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'src/lib/session.ts': SESSION,
  'src/lib/api.ts': "export async function archiveTask(id: string) {\n  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });\n}\n",
  'src/app/api/notes/route.ts': "import { getSession } from '@/lib/session';\n"
    + 'declare function save(value: unknown): Promise<{ id: string }>;\n'
    + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
    + '  return Response.json(await save(body));\n}\n',
  'src/app/api/reports/route.ts': "import { checkMembership } from '@/lib/session';\n"
    + 'export async function GET(request: Request) {\n  await checkMembership(request);\n  return Response.json({ reports: [] as string[] });\n}\n',
  'src/components/tasks.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\nimport { archiveTask } from '@/lib/api';\n"
    + 'export function Tasks() {\n'
    + "  useAiClientAction('tasks.archive', (payload: { taskId: string }) => archiveTask(payload.taskId));\n"
    + '  return null;\n}\n',
};

async function app(): Promise<AppFixture> {
  return createAppFixture(FILES, { toolsConfig: { sources: ['next-app', 'react-actions'] } });
}

const byCode = (items: ReadonlyArray<ResolveWorkItem>) => new Map(items.map((item) => [`${item.code} ${item.tool}`, item] as const));

describe('tools resolve work list', () => {
  it('lists what stage 1 could not decide, with evidence, target file and entry format', async () => {
    const fixture = await app();
    const list = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    expect(list).toMatchObject({ schemaVersion: 1, kind: 'resolve', outputsCurrent: false, blocking: [] });
    const items = byCode(list.items);
    expect([...items.keys()]).toEqual([
      'input-contract-unresolved notes.create',
      'auth-evidence-missing reports.list',
      'ui-action-write-unproven ui.tasks.archive',
    ]);
    const notes = items.get('input-contract-unresolved notes.create')!;
    expect(notes).toMatchObject({
      stableKey: 'POST /api/notes',
      severity: 'needs_attention',
      owner: 'agent',
      files: ['src/app/api/notes/route.ts', 'src/lib/session.ts'],
      evidence: { route: 'POST /api/notes', params: { path: [], query: [], body: 'opaque' }, riskClass: 'write', enabled: false },
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: 'tools["POST /api/notes"]' },
      expected: {
        origin: 'agent',
        model: MODEL_PLACEHOLDER,
        interfaceDigest: notes.evidence?.interfaceDigest,
        input: { jsonSchema: { type: 'object', properties: {}, additionalProperties: false } },
      },
    });
    expect(notes.evidence?.interfaceDigest).toMatch(/^sha256:/);
    expect(items.get('auth-evidence-missing reports.list')).toMatchObject({
      owner: 'agent',
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: 'conventions.authHelpers' },
    });
    expect(items.get('ui-action-write-unproven ui.tasks.archive')).toMatchObject({
      owner: 'developer',
      target: { kind: 'developer', command: 'glirastes tools policy raise ui.tasks.archive write' },
    });
  }, 120_000);

  it('is stable and empties once the agent and the developer answered every item', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const first = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    const again = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(first.outputsCurrent).toBe(true);
    const notes = first.items.find((item) => item.tool === 'notes.create')!;
    await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
      schemaVersion: 1,
      conventions: { authHelpers: ['checkMembership'] },
      tools: {
        'POST /api/notes': {
          origin: 'agent',
          model: 'claude-code',
          interfaceDigest: notes.evidence!.interfaceDigest,
          input: { jsonSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false } },
        },
      },
    }, null, 2)}\n`);
    await fixture.write(TOOLS_PATHS.policy, `${JSON.stringify({
      schemaVersion: 1, tools: { 'UI action tasks.archive': { riskClass: 'write', reason: 'archives through the API' } },
    })}\n`);
    const refreshed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(buildResolveWorklist(refreshed).items).toEqual([]);
    expect(refreshed.tools?.find((tool) => tool.definitionId === 'notes.create')).toMatchObject({
      enabled: true, schemaQuality: 'agent', contract: { source: 'resolution' },
    });
    expect(refreshed.tools?.find((tool) => tool.definitionId === 'ui.tasks.archive')).toMatchObject({
      riskClass: 'write', requiresApproval: true,
    });
  }, 180_000);

  it('names whole-refresh errors as blocking instead of listing tools', async () => {
    const fixture = await app();
    await fixture.write('src/app/api/broken/route.ts', "export * from './handlers';\n");
    const list = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    expect(list.blocking.map((finding) => finding.code)).toEqual(['E-INVENTORY-011']);
    expect(list.items).toEqual([]);
    expect(list.outputsCurrent).toBe(false);
  }, 120_000);

  it('lists code and entries stage 1 had to leave out, with the file and the entry to fix', async () => {
    const fixture = await createAppFixture({
      ...FILES,
      'src/components/dynamic.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + 'export function Dynamic({ actionId }: { actionId: string }) {\n'
        + '  useAiClientAction(actionId, () => undefined);\n  return null;\n}\n',
    }, { toolsConfig: { sources: ['next-app', 'react-actions'] } });
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'GET /api/reports', description: 'Lists reports.', synonyms: { en: ['sk-or-v1 reports'] } },
        { stableKey: 'POST /api/notes', description: 'Saves a note.', mood: 'happy' },
      ],
    })}\n`);
    const items = byCode(buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true })).items);
    expect(items.get('ui-action-id-dynamic src/components/dynamic.tsx:4')).toMatchObject({
      owner: 'agent', toolId: null, target: { kind: 'app-code', files: ['src/components/dynamic.tsx'] },
    });
    expect(items.get('tool-semantics-invalid reports.list')).toMatchObject({
      owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.semantics, key: 'tools[stableKey="GET /api/reports"]' },
    });
    expect(items.get('tool-semantics-invalid .glirastes/tool-semantics.json#1')).toMatchObject({
      owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.semantics, key: '.glirastes/tool-semantics.json#1' },
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/codegen/tools/worklist.test.ts --maxWorkers=4`
Expected: FAIL — `Cannot find module './worklist.js'`, and `tools resolve` is an unknown subcommand. `Test Files  2 failed (2)`, `Tests  1 failed | 7 passed (8)`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/index.ts`, replace:

```ts
import { runToolsCheck } from './check.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsStatus } from './status.js';

export interface ToolsCommandDependencies {
```

with:

```ts
import { runToolsCheck } from './check.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';

export interface ToolsCommandDependencies {
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  '         verify the committed tool outputs without writing, models or network',
  '       glirastes tools status [--root <dir>] [--json]',
  '         show what your chat can do',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

with:

```ts
  '         verify the committed tool outputs without writing, models or network',
  '       glirastes tools status [--root <dir>] [--json]',
  '         show what your chat can do',
  '       glirastes tools resolve --print [--root <dir>] [--json]',
  '         print the open stage-1 findings as a work list for your coding agent',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
        return await runToolsCheck(rest, io);
      case 'status':
        return await runToolsStatus(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
```

with:

```ts
        return await runToolsCheck(rest, io);
      case 'status':
        return await runToolsStatus(rest, io);
      case 'resolve':
        return await runToolsResolve(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
```

Create `src/cli/commands/tools/resolve.ts`:

```ts
import { resolve } from 'node:path';
import { buildResolveWorklist } from '../../../codegen/tools/worklist.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';

export const RESOLVE_ARGS = { flags: ['--print', '--json'], values: ['--root'] } as const;

/**
 * Prints the stage-1 work list for the developer's coding agent. Reads the
 * code like `tools check` (frozen: never writes, no model, no network).
 */
export async function runToolsResolve(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, RESOLVE_ARGS);
  if (!args.flags.has('--print')) {
    throw new ToolsUsageError('tools resolve prints a work list for your coding agent; Glirastes never runs a model. Use --print.');
  }
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  io.log(JSON.stringify(buildResolveWorklist(result), null, 2));
  return 0;
}
```

Create `src/codegen/tools/worklist.ts`:

```ts
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import type { ToolsPipelineResult, ToolsPipelineTool } from './pipeline.js';
import type { ToolFinding } from './types.js';

/**
 * Work lists for the developer's own coding agent (spec 4.6 "Local und
 * Free"). The CLI never calls a model: it names what is open, where the
 * evidence is, which file the answer goes to and in which format. The skills
 * `maintaining-glirastes-tools` and `describing-glirastes-tools` explain how
 * to work through them; the next `glirastes tools refresh` checks every
 * answer with the same rules, whoever wrote it.
 */
export const WORKLIST_SCHEMA_VERSION = 1;

/** Placeholder the agent replaces with its model slug or name, e.g. `claude-code`. */
export const MODEL_PLACEHOLDER = '<your model or coding agent, e.g. claude-code>';

export type WorklistTarget =
  /** The agent writes data into a `.glirastes` input file. */
  | { kind: 'file'; file: string; key: string }
  /** The agent changes app code (never a route handler's logic, never generated files). */
  | { kind: 'app-code'; files: string[] }
  /** Only the developer may do this; the agent shows the command and stops. */
  | { kind: 'developer'; command: string };

export interface WorklistEvidence {
  route: string;
  executionKind: 'endpoint' | 'ui';
  params: ToolsPipelineTool['params'];
  interfaceDigest: string | null;
  riskClass: string;
  requiresApproval: boolean;
  enabled: boolean;
  contractSource: string | null;
  schemaQuality: string;
  descriptionOrigin: string;
}

export interface ResolveWorkItem {
  /** The name `glirastes tools status` prints; the stable key when no tool carries the finding. */
  tool: string;
  stableKey: string;
  toolId: string | null;
  code: string;
  severity: ToolFinding['severity'];
  message: string;
  owner: 'agent' | 'developer';
  files: string[];
  evidence: WorklistEvidence | null;
  target: WorklistTarget;
  expected?: unknown;
  nextAction: string;
}

export interface BlockingFinding {
  code: string;
  subjectRef: string;
  message: string;
  nextAction: string;
}

export interface ResolveWorklist {
  schemaVersion: typeof WORKLIST_SCHEMA_VERSION;
  kind: 'resolve';
  /** False when the committed outputs lag behind the code; run glirastes tools refresh. */
  outputsCurrent: boolean;
  /** Findings that stop the whole refresh; fix them first. */
  blocking: BlockingFinding[];
  items: ResolveWorkItem[];
  next: string;
}

/** Stage-1 codes a coding agent resolves with an entry in tool-resolutions.json. */
const RESOLUTION_CODES: ReadonlySet<string> = new Set([
  'input-contract-unresolved',
  'input-role-unclear',
  'input-role-unsupported',
  'schema-json-unavailable',
]);

/** Stage-1 codes resolved in app code next to the handler or registration. */
const APP_CODE_CODES: ReadonlySet<string> = new Set([
  'parameter-collision',
  'schema-not-exported',
  'schema-module-unloadable',
  'schema-content-rejected',
  'contract-effect-invalid',
  'handler-unresolved',
  'navigation-bridge-missing',
  'ui-action-payload-untyped',
  'ui-action-contract-conflict',
  'filter-keys-capped',
]);

/**
 * Warnings about code stage 1 had to leave out or ignore (a client action
 * with a computed or reserved id, a contract id or presentation it cannot
 * use). They name a file, not always a tool, and are fixed in app code.
 */
const DROPPED_CODES: ReadonlySet<string> = new Set([
  'ui-action-id-dynamic',
  'ui-action-id-invalid',
  'ui-action-id-reserved',
  'definition-id-invalid',
  'contract-presentation-invalid',
]);

/** Codes only the developer resolves, through `glirastes tools policy`. */
const DEVELOPER_CODES: ReadonlySet<string> = new Set([
  'ui-action-write-unproven',
  'risk-lower-available',
  'policy-entry-orphaned',
  'override-lapsed-risk-raised',
  'E-POLICY-002',
]);

/** Whole-refresh errors that make every per-tool list incomplete. */
const IGNORED_FOR_LISTS: ReadonlySet<string> = new Set(['tool-outputs-drift']);

function evidenceOf(tool: ToolsPipelineTool): WorklistEvidence {
  return {
    route: tool.route,
    executionKind: tool.executionKind,
    params: tool.params,
    interfaceDigest: tool.interfaceDigest,
    riskClass: tool.riskClass,
    requiresApproval: tool.requiresApproval,
    enabled: tool.enabled,
    contractSource: tool.contract?.source ?? null,
    schemaQuality: tool.schemaQuality,
    descriptionOrigin: tool.descriptionOrigin,
  };
}

/** `tools["<stableKey>"]`: the key path inside `tool-resolutions.json` and `tool-policy.json`. */
export function toolKey(stableKey: string): string {
  return `tools[${JSON.stringify(stableKey)}]`;
}

/** `tools[stableKey="<stableKey>"]`: `tool-semantics.json` holds a list, so an entry is named by its stable key. */
export function semanticsKey(stableKey: string): string {
  return `tools[stableKey=${JSON.stringify(stableKey)}]`;
}

/** An input schema skeleton from the code evidence: every parameter the handler reads, types left to the agent. */
export function inputSchemaSkeleton(tool: ToolsPipelineTool): Record<string, unknown> {
  const params = tool.params ?? tool.contract?.params;
  const names = params
    ? [...params.path, ...params.query, ...(params.body === 'opaque' ? [] : params.body)]
    : [];
  const properties = Object.fromEntries([...new Set(names)].sort(compareCodeUnits)
    .map((name) => [name, { description: `<what ${name} means; add type, format, enum or bounds the code shows>` }]));
  return {
    type: 'object',
    properties,
    ...(params && params.path.length > 0 ? { required: [...params.path].sort(compareCodeUnits) } : {}),
    additionalProperties: false,
  };
}

/** The entry an agent writes into tool-resolutions.json for one tool. */
export function resolutionEntryTemplate(tool: ToolsPipelineTool): Record<string, unknown> {
  return {
    origin: 'agent',
    model: MODEL_PLACEHOLDER,
    interfaceDigest: tool.interfaceDigest ?? '<run glirastes tools refresh first>',
    input: { jsonSchema: inputSchemaSkeleton(tool) },
  };
}

function layoutFiles(tool: ToolsPipelineTool): string[] {
  return tool.files.length > 0 ? tool.files : ['src/app/layout.tsx'];
}

/** The entry a rejected or invalid finding names, in the file and notation it lives in. */
function entryTarget(finding: ToolFinding): WorklistTarget {
  const semantics = finding.code === 'tool-semantics-invalid' || finding.message.includes('tool-semantics.json')
    || finding.subjectRef.startsWith(TOOLS_PATHS.semantics);
  const file = semantics ? TOOLS_PATHS.semantics : TOOLS_PATHS.resolutions;
  if (finding.subjectRef.startsWith('.glirastes/')) return { kind: 'file', file, key: finding.subjectRef };
  return { kind: 'file', file, key: semantics ? semanticsKey(finding.subjectRef) : toolKey(finding.subjectRef) };
}

function developerCommand(code: string, tool: ToolsPipelineTool | undefined, subject: string): string {
  const name = tool?.definitionId ?? subject;
  switch (code) {
    case 'ui-action-write-unproven':
      return `glirastes tools policy raise ${name} write`;
    case 'risk-lower-available':
      return `glirastes tools policy accept ${name}`;
    case 'policy-entry-orphaned':
      return `glirastes tools policy reset ${JSON.stringify(subject)}`;
    default:
      return `glirastes tools policy show ${name}`;
  }
}

function resolveItem(finding: ToolFinding, tool: ToolsPipelineTool | undefined): ResolveWorkItem | undefined {
  const { code } = finding;
  const base = {
    tool: tool?.definitionId ?? finding.subjectRef,
    stableKey: tool?.stableKey ?? finding.subjectRef,
    toolId: tool?.toolId ?? null,
    code,
    severity: finding.severity,
    message: finding.message,
    files: tool?.files ?? [],
    evidence: tool ? evidenceOf(tool) : null,
    nextAction: finding.nextAction,
  };
  if (DEVELOPER_CODES.has(code)) {
    // A reviewed local entry already answers the D4 question for this tool.
    if (code === 'ui-action-write-unproven' && tool?.localPolicy) return undefined;
    return { ...base, owner: 'developer', target: { kind: 'developer', command: developerCommand(code, tool, finding.subjectRef) } };
  }
  if (code === 'resolution-rejected' || code === 'tool-semantics-invalid') {
    return { ...base, owner: 'agent', target: entryTarget(finding) };
  }
  if (code === 'auth-evidence-missing') {
    return {
      ...base,
      owner: 'agent',
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: 'conventions.authHelpers' },
      expected: { conventions: { authHelpers: ['<name of the session or auth helper this handler calls>'] } },
    };
  }
  if (DROPPED_CODES.has(code)) {
    // `src/a.tsx:12` or `src/a.tsx` when no tool exists for the registration.
    const files = tool ? tool.files : [finding.subjectRef.replace(/:\d+$/, '')];
    return { ...base, owner: 'agent', target: { kind: 'app-code', files } };
  }
  if (!tool) return undefined;
  if (code === 'contract-stale') {
    return tool.contract?.source === 'contract-module'
      ? { ...base, owner: 'agent', target: { kind: 'app-code', files: tool.files } }
      : { ...base, owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: toolKey(tool.stableKey) }, expected: resolutionEntryTemplate(tool) };
  }
  if (RESOLUTION_CODES.has(code)) {
    return {
      ...base,
      owner: 'agent',
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: toolKey(tool.stableKey) },
      expected: resolutionEntryTemplate(tool),
    };
  }
  if (APP_CODE_CODES.has(code)) {
    const files = code === 'navigation-bridge-missing' ? layoutFiles(tool) : tool.files;
    return { ...base, owner: 'agent', target: { kind: 'app-code', files } };
  }
  return undefined;
}

function compareItems(left: ResolveWorkItem, right: ResolveWorkItem): number {
  return compareCodeUnits(left.tool, right.tool) || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message);
}

/** Everything stage 1 could not decide, for `glirastes tools resolve --print`. */
export function buildResolveWorklist(result: ToolsPipelineResult): ResolveWorklist {
  const tools = new Map((result.tools ?? []).map((tool) => [tool.stableKey, tool] as const));
  const blocking = result.findings
    .filter((finding) => finding.severity === 'error' && !IGNORED_FOR_LISTS.has(finding.code)
      && !DEVELOPER_CODES.has(finding.code))
    .map(({ code, subjectRef, message, nextAction }) => ({ code, subjectRef, message, nextAction }));
  const seen = new Set<string>();
  const items: ResolveWorkItem[] = [];
  for (const finding of result.findings) {
    const key = `${finding.code}|${finding.subjectRef}|${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = resolveItem(finding, tools.get(finding.subjectRef));
    if (item) items.push(item);
  }
  return {
    schemaVersion: WORKLIST_SCHEMA_VERSION,
    kind: 'resolve',
    outputsCurrent: result.driftPaths.length === 0 && blocking.length === 0,
    blocking,
    items: items.sort(compareItems),
    next: 'Work through items owned by "agent", show items owned by "developer" to the developer, then run glirastes tools refresh and glirastes tools resolve --print again until no item is left.',
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/codegen/tools/worklist.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  12 passed (12)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/index.ts src/cli/commands/tools/resolve.ts src/cli/commands/tools/tools-command.test.ts src/codegen/tools/worklist.test.ts src/codegen/tools/worklist.ts
git commit -m "feat(cli): print the stage-1 work list with tools resolve --print"
```

### Task 9: `glirastes tools eval`: routing check with the example sentences

**Files:**
- Create: `src/codegen/tools/routing-eval.ts`, `src/cli/commands/tools/eval.ts`
- Modify: `src/cli/commands/tools/status.ts` (exported `readToolOutput` with an operation name), `src/cli/commands/tools/index.ts`
- Test: `src/codegen/tools/routing-eval.test.ts` (Create), `src/cli/commands/tools/tools-command.test.ts` (one new case on a real fixture)

**Interfaces:**
- Consumes: P07 `createToolSearchIndex` (the index `find_tools` uses) and `modelFacingToolName`; Task 4 `search.synonyms`/`search.examples` in `tool-contracts.json`.
- Produces:
  - `src/codegen/tools/routing-eval.ts`: `DEFAULT_ROUTING_TOP` (3), `RoutingSentenceFailure { sentence, rank, competitors, moduleMismatch }`, `RoutingToolResult`, `RoutingEvaluation { schemaVersion: 1, top, summary { tools, evaluated, sentences, passed, failed, withoutExamples }, tools }`, `evaluateRouting({ artifact, contracts, top? })`. A sentence passes when its tool ranks within `top` among the enabled tools and the first hit lies in the tool's module.
  - `glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]` reads only the committed `setup-artifact.json` and `tool-contracts.json` (no pipeline, no model, no network, no write), prints `routing-ambiguous` lines with the competitors and exits 1 only with `--strict` or `ci.strict`.
  - `readToolOutput(root, path, schema, operation?)` (renamed from the private `readOutput`).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
    });
  });

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
```

with:

```ts
    });
  });

  it('checks the routing of committed example sentences without a model and fails only when strict', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    await fixture.write('.glirastes/tool-semantics.json', `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'GET /api/tasks', examples: { en: ['list my tasks', 'which tasks do I have', 'tasks overview'] } },
        { stableKey: 'POST /api/tasks', examples: { en: ['create a task', 'add a task called report', 'new task'] }, synonyms: { en: ['add'] } },
      ],
    })}\n`);
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    out.length = 0;
    expect(await runToolsCommand(['eval'], deps)).toBe(0);
    expect(out.join('\n')).toContain('Routing check (top 3): 6 of 6 example sentences find their tool.');
    out.length = 0;
    expect(await runToolsCommand(['eval', '--json', '--top', '1'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      top: 1,
      summary: { sentences: 6, passed: 4, failed: 2 },
      tools: [
        { tool: 'tasks.create', failures: [] },
        { tool: 'tasks.list', failures: [{ sentence: 'tasks overview', rank: 2, competitors: ['tasks.create'] }, expect.anything()] },
      ],
    });
    out.length = 0;
    expect(await runToolsCommand(['eval', '--strict', '--top', '1'], deps)).toBe(1);
    expect(out.join('\n')).toContain('! tasks.list  "tasks overview": rank 2; ahead: tasks.create  (routing-ambiguous)');
    expect(await runToolsCommand(['eval', '--top', '0'], deps)).toBe(2);
  }, 120_000);

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
```

Create `src/codegen/tools/routing-eval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { evaluateRouting } from './routing-eval.js';
import type { ToolSearchFacts } from './types.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

function tool(suffix: string, name: string, module: string, description: string, enabled = true) {
  return {
    toolId: id(suffix), sourceFingerprint: digest('F'), name, description, modelName: name.replace(/\./g, '_'),
    module, sharedWith: [], usageHints: [description],
    presentation: { locale: 'de-DE', singular: name, plural: name, approval: name },
    executionKind: 'endpoint', method: 'GET', path: `/api/${suffix}`, authBindingRef: 'endpoint-authorization', allowedRoles: [],
    operationGroup: 'read', riskClass: 'safe-read', enabled, requiresApproval: false,
    inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  };
}

const artifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready',
  tools: [
    tool('a1', 'tasks.list', 'task_query', 'Lists the tasks of the caller, filtered by status.'),
    tool('a2', 'tasks.create', 'task_mutation', 'Creates a task with a title and an optional due date.'),
    tool('a3', 'notes.list', 'notes', 'Lists the notes of the caller.'),
    tool('a4', 'reports.export', 'reports', 'Exports a weekly report.', false),
  ],
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('a1'), id('a2'), id('a3')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
});

function contracts(search: Record<string, ToolSearchFacts>) {
  return artifact.tools.map((entry) => ({
    toolId: entry.toolId,
    stableKey: `GET ${entry.executionKind === 'endpoint' ? entry.path : ''}`,
    ...(search[entry.name] ? { search: search[entry.name] } : {}),
  }));
}

describe('evaluateRouting', () => {
  it('passes when every example finds its tool among the first hits of its module', () => {
    const evaluation = evaluateRouting({
      artifact,
      contracts: contracts({
        'tasks.list': { synonyms: ['Aufgaben anzeigen', 'offene Aufgaben'], examples: ['Zeig meine offenen Aufgaben', 'Welche Aufgaben sind noch offen?', 'list my open tasks'] },
        'tasks.create': { synonyms: ['Aufgabe anlegen', 'neue Aufgabe'], examples: ['Leg eine neue Aufgabe an', 'Erstelle eine Aufgabe mit Titel Bericht', 'create a task'] },
      }),
    });
    expect(evaluation).toEqual({
      schemaVersion: 1,
      top: 3,
      summary: { tools: 3, evaluated: 2, sentences: 6, passed: 6, failed: 0, withoutExamples: ['notes.list'] },
      tools: [
        { tool: 'tasks.create', stableKey: 'GET /api/a2', module: 'task_mutation', sentences: 3, failures: [] },
        { tool: 'tasks.list', stableKey: 'GET /api/a1', module: 'task_query', sentences: 3, failures: [] },
      ],
    });
  });

  it('names the competing tools of an ambiguous example and stays byte-stable', () => {
    const input = {
      artifact,
      contracts: contracts({
        'tasks.list': { examples: ['show my tasks', 'list my open tasks', 'tasks filtered by status'] },
        'notes.list': { examples: ['Zeig meine Notizen', 'list my notes', 'notes of the caller'] },
      }),
    };
    const evaluation = evaluateRouting(input);
    expect(JSON.stringify(evaluateRouting(input))).toBe(JSON.stringify(evaluation));
    expect(evaluation.summary).toMatchObject({ sentences: 6, passed: 4, failed: 2 });
    expect(evaluation.tools.find((entry) => entry.tool === 'tasks.list')?.failures).toEqual([
      { sentence: 'show my tasks', rank: 2, competitors: ['tasks.create'], moduleMismatch: true },
    ]);
    expect(evaluation.tools.find((entry) => entry.tool === 'notes.list')?.failures).toEqual([
      { sentence: 'Zeig meine Notizen', rank: null, competitors: [], moduleMismatch: false },
    ]);
  });

  it('never evaluates or ranks a disabled tool', () => {
    const evaluation = evaluateRouting({ artifact, contracts: contracts({ 'reports.export': { examples: ['export the weekly report'] } }) });
    expect(evaluation.summary).toMatchObject({ tools: 3, evaluated: 0, sentences: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/codegen/tools/routing-eval.test.ts --maxWorkers=4`
Expected: FAIL — `Cannot find module './routing-eval.js'`, and `tools eval` is an unknown subcommand. `Test Files  2 failed (2)`, `Tests  1 failed | 8 passed (9)`

- [ ] **Step 3: Implement**

Create `src/cli/commands/tools/eval.ts`:

```ts
import { resolve } from 'node:path';
import { loadToolsConfig, TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { DEFAULT_ROUTING_TOP, evaluateRouting, type RoutingEvaluation } from '../../../codegen/tools/routing-eval.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';
import { readToolOutput } from './status.js';

export const EVAL_ARGS = { flags: ['--json', '--strict'], values: ['--root', '--top'] } as const;

export function formatRoutingEvaluation(evaluation: RoutingEvaluation): string {
  const { summary } = evaluation;
  const lines = [
    `Routing check (top ${evaluation.top}): ${summary.passed} of ${summary.sentences} example sentence${summary.sentences === 1 ? '' : 's'} find their tool.`,
  ];
  for (const tool of evaluation.tools) {
    for (const failure of tool.failures) {
      const rank = failure.rank === null ? 'not found' : `rank ${failure.rank}`;
      const above = failure.competitors.length > 0 ? `; ahead: ${failure.competitors.join(', ')}` : '';
      const module = failure.moduleMismatch ? '; the first hit is in another module' : '';
      lines.push(`  ! ${tool.tool}  ${JSON.stringify(failure.sentence)}: ${rank}${above}${module}  (routing-ambiguous)`);
    }
  }
  if (summary.failed > 0) {
    lines.push('  Next: let your coding agent sharpen these descriptions with glirastes tools describe --print.');
  }
  if (summary.withoutExamples.length > 0) {
    lines.push(`Without example sentences (${summary.withoutExamples.length}): ${summary.withoutExamples.join(', ')}`,
      '  Next: glirastes tools describe --print adds them to the work list.');
  }
  return lines.join('\n');
}

/**
 * Deterministic routing check over the committed outputs (spec 4.2, 4.7):
 * no model, no network, no writes. Ambiguous tools are reported; `--strict`
 * (or `ci.strict` in tools.json) turns them into a failing exit code.
 */
export async function runToolsEval(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, EVAL_ARGS);
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const topValue = args.values.get('--top');
  const top = topValue === undefined ? DEFAULT_ROUTING_TOP : Number(topValue);
  if (!Number.isInteger(top) || top < 1 || top > 20) throw new ToolsUsageError('--top must be a whole number from 1 to 20.');
  const strict = args.flags.has('--strict') || loadToolsConfig(root).ci.strict === true;
  const artifact = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema, 'tools.eval');
  const contracts = await readToolOutput(root, TOOLS_PATHS.contracts, ToolContractsFileSchema, 'tools.eval');
  const evaluation = evaluateRouting({ artifact, contracts: contracts.tools, top });
  io.log(args.flags.has('--json') ? JSON.stringify(evaluation) : formatRoutingEvaluation(evaluation));
  return strict && evaluation.summary.failed > 0 ? 1 : 0;
}
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
```

with:

```ts
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  '         show what your chat can do',
  '       glirastes tools resolve --print [--root <dir>] [--json]',
  '         print the open stage-1 findings as a work list for your coding agent',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

with:

```ts
  '         show what your chat can do',
  '       glirastes tools resolve --print [--root <dir>] [--json]',
  '         print the open stage-1 findings as a work list for your coding agent',
  '       glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]',
  '         check that every example sentence finds its tool (no model, CI-ready)',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
        return await runToolsStatus(rest, io);
      case 'resolve':
        return await runToolsResolve(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
```

with:

```ts
        return await runToolsStatus(rest, io);
      case 'resolve':
        return await runToolsResolve(rest, io);
      case 'eval':
        return await runToolsEval(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
```

In `src/cli/commands/tools/status.ts`, replace:

```ts
import { parseToolArgs } from './args.js';
import { formatToolStatus, type ToolStatusEntry, type ToolsIo } from './format.js';

async function readOutput<T>(root: string, path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, path), 'utf8');
  } catch {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-020',
      operation: 'tools.status',
      message: 'No tool outputs found. Run glirastes tools refresh first.',
      remediation: 'run-tools-refresh',
      path,
```

with:

```ts
import { parseToolArgs } from './args.js';
import { formatToolStatus, type ToolStatusEntry, type ToolsIo } from './format.js';

/** A committed generator output, parsed; E-TOOLS-020/021 ask for a refresh. */
export async function readToolOutput<T>(
  root: string,
  path: string,
  schema: z.ZodType<T>,
  operation = 'tools.status',
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, path), 'utf8');
  } catch {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-020',
      operation,
      message: 'No tool outputs found. Run glirastes tools refresh first.',
      remediation: 'run-tools-refresh',
      path,
```

In `src/cli/commands/tools/status.ts`, replace:

```ts
  if (!parsed?.success) {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-021',
      operation: 'tools.status',
      message: 'The tool outputs are invalid. Run glirastes tools refresh.',
      remediation: 'run-tools-refresh',
      path,
```

with:

```ts
  if (!parsed?.success) {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-021',
      operation,
      message: 'The tool outputs are invalid. Run glirastes tools refresh.',
      remediation: 'run-tools-refresh',
      path,
```

In `src/cli/commands/tools/status.ts`, replace:

```ts

/** Local "What can my chat do?" from the committed outputs; no recomputation. */
export async function readToolStatus(root: string): Promise<ToolStatusEntry[]> {
  const artifact = await readOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema);
  const report = await readOutput(root, TOOLS_PATHS.report, ToolReportFileSchema);
  const reported = new Map(report.tools.map((tool) => [tool.toolId, tool] as const));
  return artifact.tools.map((tool): ToolStatusEntry => {
    const entry = reported.get(tool.toolId);
```

with:

```ts

/** Local "What can my chat do?" from the committed outputs; no recomputation. */
export async function readToolStatus(root: string): Promise<ToolStatusEntry[]> {
  const artifact = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema);
  const report = await readToolOutput(root, TOOLS_PATHS.report, ToolReportFileSchema);
  const reported = new Map(report.tools.map((tool) => [tool.toolId, tool] as const));
  return artifact.tools.map((tool): ToolStatusEntry => {
    const entry = reported.get(tool.toolId);
```

Create `src/codegen/tools/routing-eval.ts`:

```ts
import type { AppSetupArtifact } from '../../contracts/index.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';
import { createToolSearchIndex } from '../../runtime/tool-search.js';
import { compareCodeUnits } from './canonical.js';
import type { ToolContractsEntry } from './types.js';

/** A sentence passes when its tool is among this many `find_tools` hits. */
export const DEFAULT_ROUTING_TOP = 3;

export interface RoutingSentenceFailure {
  sentence: string;
  /** 1-based rank of the expected tool, or null when the search does not return it. */
  rank: number | null;
  /** The tools that `find_tools` ranks above it (by name), at most `top`. */
  competitors: string[];
  /** The first hit belongs to another module, so module routing would go astray. */
  moduleMismatch: boolean;
}

export interface RoutingToolResult {
  tool: string;
  stableKey: string;
  module: string;
  sentences: number;
  failures: RoutingSentenceFailure[];
}

export interface RoutingEvaluation {
  schemaVersion: 1;
  top: number;
  summary: {
    /** Enabled tools the chat can find. */
    tools: number;
    /** Tools with example sentences. */
    evaluated: number;
    sentences: number;
    passed: number;
    failed: number;
    /** Enabled tools without example sentences, by name. */
    withoutExamples: string[];
  };
  /** Evaluated tools, by name; `failures` lists each sentence that does not find its tool. */
  tools: RoutingToolResult[];
}

/**
 * Deterministic routing check (spec 4.7 "Qualitätsschleife"): every example
 * sentence of a tool must find that tool among the first `find_tools` hits,
 * built exactly like the runtime index (name, description, module, shared
 * modules, usage hints, synonyms), and the first hit must lie in the tool's
 * module. No model, no network, no clock: the same outputs give the same
 * bytes, so CI can run it as the FR-3 regression corpus.
 */
export function evaluateRouting(input: {
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<Pick<ToolContractsEntry, 'toolId' | 'stableKey' | 'search'>>;
  top?: number;
}): RoutingEvaluation {
  const top = Math.max(1, Math.trunc(input.top ?? DEFAULT_ROUTING_TOP));
  const search = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools = input.artifact.tools
    .filter((tool) => tool.enabled)
    .map((tool) => ({ tool, modelName: tool.modelName ?? modelFacingToolName(tool.name), entry: search.get(tool.toolId) }))
    .sort((left, right) => compareCodeUnits(left.tool.name, right.tool.name));
  const byModelName = new Map(tools.map((item) => [item.modelName, item] as const));
  const index = createToolSearchIndex(tools.map(({ tool, modelName, entry }) => ({
    name: modelName,
    description: tool.description ?? '',
    ...(tool.module ? { module: tool.module } : {}),
    sharedWith: tool.sharedWith ?? [],
    usageHints: tool.usageHints ?? [],
    synonyms: entry?.search?.synonyms ?? [],
  })));
  const results: RoutingToolResult[] = [];
  const withoutExamples: string[] = [];
  let sentences = 0;
  let failed = 0;
  for (const { tool, modelName, entry } of tools) {
    const examples = entry?.search?.examples ?? [];
    if (examples.length === 0) {
      withoutExamples.push(tool.name);
      continue;
    }
    const failures: RoutingSentenceFailure[] = [];
    for (const sentence of examples) {
      sentences += 1;
      const ranked = index.search(sentence, tools.length);
      const position = ranked.indexOf(modelName);
      const rank = position < 0 ? null : position + 1;
      const first = ranked[0] === undefined ? undefined : byModelName.get(ranked[0]);
      const moduleMismatch = first !== undefined && first.modelName !== modelName && first.tool.module !== tool.module;
      if (rank !== null && rank <= top && !moduleMismatch) continue;
      failed += 1;
      failures.push({
        sentence,
        rank,
        competitors: ranked.slice(0, rank === null ? top : Math.min(rank - 1, top))
          .map((name) => byModelName.get(name)?.tool.name ?? name),
        moduleMismatch,
      });
    }
    results.push({
      tool: tool.name,
      stableKey: entry?.stableKey ?? tool.name,
      module: tool.module ?? '',
      sentences: examples.length,
      failures,
    });
  }
  return {
    schemaVersion: 1,
    top,
    summary: {
      tools: tools.length,
      evaluated: results.length,
      sentences,
      passed: sentences - failed,
      failed,
      withoutExamples,
    },
    tools: results,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/codegen/tools/routing-eval.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  12 passed (12)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/eval.ts src/cli/commands/tools/index.ts src/cli/commands/tools/status.ts src/cli/commands/tools/tools-command.test.ts src/codegen/tools/routing-eval.test.ts src/codegen/tools/routing-eval.ts
git commit -m "feat(cli): check example sentences against find_tools with tools eval"
```

### Task 10: `glirastes tools describe --print`: the stage-2 work list

**Files:**
- Create: `src/cli/commands/tools/describe.ts`
- Modify: `src/codegen/tools/worklist.ts` (`DescribeGap`, `DescribeWorkItem`, `DescribeWorklist`, `describeGaps`, `semanticsEntryTemplate`, `buildDescribeWorklist`), `src/cli/commands/tools/args.ts` (positional arguments), `src/cli/commands/tools/index.ts`
- Test: `src/codegen/tools/worklist.test.ts` (new describe block "tools describe work list"), `src/cli/commands/tools/tools-command.test.ts` (one new case)

**Interfaces:**
- Consumes: Task 4 tool view (`semantics`, `descriptionOrigin`, `schemaQuality`, findings), Task 8 helpers, Task 9 `evaluateRouting` (run on the outputs the frozen pipeline rendered), Task 3 `SEMANTICS_FIELDS`/`requiredLanguages`.
- Produces:
  - Gaps (spec 4.7 "Auslöser"): `description-templated`, `contract-derived`, `output-contract-opaque`, `filter-domain-open`, `synonyms-missing`, `examples-missing`, `semantics-stale`, `enrichment-stale`, `routing-ambiguous`; a named tool without gaps is listed as `requested`. Tools without a contract are left to `tools resolve`.
  - Targets: `semantics` (`.glirastes/tool-semantics.json`, entry by `stableKey`, template without the protected fields, `origin` agent per written field, `agent` with the current `interfaceDigest`), `schema` (endpoint tools with `contract-derived`, `enrichment-stale` or `output-contract-opaque`: the resolution template, with an output skeleton when the output is opaque), `contract` (with `--write-contracts` or `enrich.writeContracts`, endpoint tools with field names only and no `contract.ts` next to the route: a Zod contract module template).
  - `glirastes tools describe --print [<tool>...|--all] [--write-contracts] [--root <dir>]`; unknown tool names and `--all` with names exit 2. `parseToolArgs` gains `positionals` (`ToolArgsSpec`). `DESCRIBE_ARGS` is exported for Task 19.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
    });
  });

  it('checks the routing of committed example sentences without a model and fails only when strict', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    await fixture.write('.glirastes/tool-semantics.json', `${JSON.stringify({
```

with:

```ts
    });
  });

  it('prints the describe work list for named tools, all tools or every gap, never without --print', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE }, { toolsConfig: { enrich: { writeContracts: true } } });
    const out: string[] = [];
    const err: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(await runToolsCommand(['describe'], deps)).toBe(2);
    expect(await runToolsCommand(['describe', '--print', '--all', 'tasks.list'], deps)).toBe(2);
    expect(await runToolsCommand(['describe', '--print', 'tasks.missing'], deps)).toBe(2);
    expect(err.join('\n')).toContain('Unknown tool tasks.missing; glirastes tools status lists the names.');
    out.length = 0;
    expect(await runToolsCommand(['describe', '--print', 'tasks.create'], deps)).toBe(0);
    const list = JSON.parse(out.join('\n')) as { kind: string; languages: string[]; writeContracts: boolean; items: Array<{ tool: string; targets: { contract?: { file: string } } }> };
    expect(list).toMatchObject({ kind: 'describe', languages: ['en'], writeContracts: true });
    expect(list.items.map((item) => [item.tool, item.targets.contract?.file])).toEqual([['tasks.create', 'src/app/api/tasks/contract.ts']]);
  }, 120_000);

  it('checks the routing of committed example sentences without a model and fails only when strict', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    await fixture.write('.glirastes/tool-semantics.json', `${JSON.stringify({
```

In `src/codegen/tools/worklist.test.ts`, replace:

```ts
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { TOOLS_PATHS } from './config.js';
import { runToolsPipeline } from './pipeline.js';
import { buildResolveWorklist, MODEL_PLACEHOLDER, type ResolveWorkItem } from './worklist.js';

afterEach(removeAppFixtures);

```

with:

```ts
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { TOOLS_PATHS } from './config.js';
import { runToolsPipeline } from './pipeline.js';
import { buildDescribeWorklist, buildResolveWorklist, MODEL_PLACEHOLDER, type ResolveWorkItem } from './worklist.js';

afterEach(removeAppFixtures);

```

In `src/codegen/tools/worklist.test.ts`, replace:

```ts
      owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.semantics, key: '.glirastes/tool-semantics.json#1' },
    });
  }, 120_000);
});
```

with:

```ts
      owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.semantics, key: '.glirastes/tool-semantics.json#1' },
    });
  }, 120_000);
});

const TASKS_ROUTE = "import { getSession } from '@/lib/session';\nimport { createTask } from '@/lib/schemas';\n"
  + 'export async function GET(request: Request) {\n  await getSession(request);\n'
  + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n"
  + 'export async function POST(request: Request) {\n  await getSession(request);\n'
  + '  const input = createTask.parse(await request.json());\n'
  + "  return Response.json({ id: '1', title: input.title }, { status: 201 });\n}\n";

async function tasksApp(): Promise<AppFixture> {
  return createAppFixture({
    'tsconfig.json': FILES['tsconfig.json']!,
    'src/lib/session.ts': SESSION,
    'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string().min(1) }).strict();\n",
    'src/app/api/tasks/route.ts': TASKS_ROUTE,
    'src/app/api/notes/route.ts': FILES['src/app/api/notes/route.ts']!,
  }, { toolsConfig: { locale: 'de-DE' } });
}

const describeOptions = (root: string, extra: Partial<Parameters<typeof buildDescribeWorklist>[1]> = {}) => ({
  root, locale: 'de-DE', languages: ['de', 'en'] as Array<'de' | 'en'>, ...extra,
});

describe('tools describe work list', () => {
  it('lists the stage-2 gaps per module with the entries to write and leaves unresolved tools to resolve', async () => {
    const fixture = await tasksApp();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const list = buildDescribeWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }), describeOptions(fixture.root));
    expect(list).toMatchObject({ kind: 'describe', outputsCurrent: true, languages: ['de', 'en'], writeContracts: false });
    expect(list.modules).toEqual([{ module: 'tasks', tools: ['tasks.create', 'tasks.list'] }]);
    const [create, listTool] = list.items;
    expect(create).toMatchObject({
      tool: 'tasks.create',
      gaps: ['description-templated', 'synonyms-missing', 'examples-missing'],
      protectedFields: [],
      missingExamples: ['de', 'en'],
      targets: { semantics: { file: TOOLS_PATHS.semantics, key: 'tools[stableKey="POST /api/tasks"]' } },
    });
    expect(create?.targets.schema).toBeUndefined();
    expect(create?.targets.semantics.expected).toMatchObject({
      stableKey: 'POST /api/tasks',
      examples: { de: ['<3 to 5 sentences a user would type>'], en: ['<3 to 5 sentences a user would type>'] },
      approvalHint: '<when asking first matters most for this tool>',
      origin: { description: 'agent', examples: 'agent', synonyms: 'agent' },
      agent: { model: MODEL_PLACEHOLDER, interfaceDigest: create?.evidence.interfaceDigest },
    });
    expect(listTool).toMatchObject({
      tool: 'tasks.list',
      gaps: ['description-templated', 'contract-derived', 'synonyms-missing', 'examples-missing'],
      targets: {
        schema: {
          file: TOOLS_PATHS.resolutions,
          key: 'tools["GET /api/tasks"]',
          expected: { origin: 'agent', input: { jsonSchema: { properties: { status: {} }, additionalProperties: false } } },
        },
      },
    });
    expect(listTool?.targets.semantics.expected).not.toHaveProperty('approvalHint');
  }, 180_000);

  it('keeps human fields, writes contract modules on request and drops a tool once it is described', async () => {
    const fixture = await tasksApp();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const frozen = () => runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true });
    const first = buildDescribeWorklist(await frozen(), describeOptions(fixture.root, { tools: ['tasks.list'], writeContracts: true }));
    expect(first.items.map((item) => item.tool)).toEqual(['tasks.list']);
    expect(first.items[0]?.targets.contract?.file).toBe('src/app/api/tasks/contract.ts');
    expect(first.items[0]?.targets.contract?.expected).toContain('  GET: {');
    expect(first.items[0]?.targets.contract?.expected).toContain('"status": z.unknown()');
    const interfaceDigest = first.items[0]!.evidence.interfaceDigest!;
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [{
        stableKey: 'GET /api/tasks',
        description: 'Listet die Aufgaben des Nutzers, auf Wunsch nach Status gefiltert.',
        synonyms: { de: ['Aufgabenliste', 'offene Aufgaben'], en: ['to-dos'] },
        examples: {
          de: ['Zeig meine offenen Aufgaben', 'Welche Aufgaben sind erledigt?', 'Liste alle Aufgaben'],
          en: ['list my open tasks', 'which tasks are done', 'show the task list'],
        },
        origin: { synonyms: 'agent', examples: 'agent' },
        agent: { model: 'claude-code', interfaceDigest },
      }],
    }, null, 2)}\n`);
    await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': {
          origin: 'agent',
          model: 'claude-code',
          interfaceDigest,
          input: { jsonSchema: { type: 'object', properties: { status: { type: 'array', items: { type: 'string', enum: ['open', 'done'] } } }, additionalProperties: false } },
        },
      },
    }, null, 2)}\n`);
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const after = buildDescribeWorklist(await frozen(), describeOptions(fixture.root));
    expect(after.items.map((item) => item.tool)).toEqual(['tasks.create']);
    const named = buildDescribeWorklist(await frozen(), describeOptions(fixture.root, { tools: ['GET /api/tasks'] }));
    expect(named.items[0]).toMatchObject({ gaps: ['requested'], protectedFields: ['description'] });
    expect(named.items[0]?.targets.semantics.expected).not.toHaveProperty('description');
    const all = buildDescribeWorklist(await frozen(), describeOptions(fixture.root, { all: true }));
    expect(all.items.map((item) => item.tool)).toEqual(['tasks.create', 'tasks.list']);
  }, 240_000);

  it('lists a tool whose example sentences do not find it as routing-ambiguous', async () => {
    const fixture = await tasksApp();
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [{
        stableKey: 'GET /api/tasks',
        description: 'Listet Aufgaben.',
        synonyms: { de: ['Aufgabenliste'] },
        examples: { de: ['Was steht an?', 'Liste alle Aufgaben', 'Aufgabenliste bitte'], en: ['what is up', 'list all tasks', 'task list please'] },
      }],
    })}\n`);
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const list = buildDescribeWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }), describeOptions(fixture.root));
    const item = list.items.find((entry) => entry.tool === 'tasks.list');
    expect(item?.gaps).toContain('routing-ambiguous');
    expect(item?.routing.map((failure) => failure.sentence)).toEqual(['Was steht an?', 'what is up']);
  }, 180_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/codegen/tools/worklist.test.ts --maxWorkers=4`
Expected: FAIL — `buildDescribeWorklist` is not exported (the new describe block fails), and `tools describe` is an unknown subcommand. `Test Files  2 failed (2)`, `Tests  4 failed | 13 passed (17)`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/args.ts`, replace:

```ts
  }
}

export function parseToolArgs(
  argv: ReadonlyArray<string>,
  spec: { flags: ReadonlyArray<string>; values: ReadonlyArray<string> },
): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (spec.flags.includes(argument)) {
      flags.add(argument);
      continue;
```

with:

```ts
  }
}

export interface ToolArgsSpec {
  flags: ReadonlyArray<string>;
  values: ReadonlyArray<string>;
  /** Most positional arguments (tool names, patterns, values); none by default. */
  positionals?: number;
}

export function parseToolArgs(
  argv: ReadonlyArray<string>,
  spec: ToolArgsSpec,
): { flags: Set<string>; values: Map<string, string>; positionals: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--') && positionals.length < (spec.positionals ?? 0)) {
      positionals.push(argument);
      continue;
    }
    if (spec.flags.includes(argument)) {
      flags.add(argument);
      continue;
```

In `src/cli/commands/tools/args.ts`, replace:

```ts
    }
    throw new ToolsUsageError(`Unknown argument ${argument}.`);
  }
  return { flags, values };
}
```

with:

```ts
    }
    throw new ToolsUsageError(`Unknown argument ${argument}.`);
  }
  return { flags, values, positionals };
}
```

Create `src/cli/commands/tools/describe.ts`:

```ts
import { resolve } from 'node:path';
import { loadToolsConfig } from '../../../codegen/tools/config.js';
import { requiredLanguages } from '../../../codegen/tools/semantics.js';
import { buildDescribeWorklist } from '../../../codegen/tools/worklist.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';

export const DESCRIBE_ARGS = {
  flags: ['--print', '--all', '--write-contracts', '--json'],
  values: ['--root'],
  positionals: 500,
} as const;

/**
 * Prints the stage-2 work list (descriptions, typed schemas, synonyms,
 * example sentences) for the developer's coding agent. Reads the code like
 * `tools check`: never writes, no model, no network.
 */
export async function runToolsDescribe(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, DESCRIBE_ARGS);
  if (!args.flags.has('--print')) {
    throw new ToolsUsageError('tools describe prints a work list for your coding agent; Glirastes never runs a model. Use --print.');
  }
  if (args.flags.has('--all') && args.positionals.length > 0) {
    throw new ToolsUsageError('Name tools or use --all, not both.');
  }
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  const known = new Set((result.tools ?? []).flatMap((tool) => [tool.definitionId, tool.stableKey]));
  const unknown = args.positionals.filter((name) => !known.has(name));
  if (unknown.length > 0 && (result.tools ?? []).length > 0) {
    throw new ToolsUsageError(`Unknown tool ${unknown.join(', ')}; glirastes tools status lists the names.`);
  }
  const list = buildDescribeWorklist(result, {
    root,
    locale: config.locale,
    languages: requiredLanguages(config.locale),
    tools: args.positionals,
    all: args.flags.has('--all'),
    writeContracts: args.flags.has('--write-contracts') || config.enrich.writeContracts === true,
  });
  io.log(JSON.stringify(list, null, 2));
  return 0;
}
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
```

with:

```ts
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { runToolsDescribe } from './describe.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  '         show what your chat can do',
  '       glirastes tools resolve --print [--root <dir>] [--json]',
  '         print the open stage-1 findings as a work list for your coding agent',
  '       glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]',
  '         check that every example sentence finds its tool (no model, CI-ready)',
].join('\n');
```

with:

```ts
  '         show what your chat can do',
  '       glirastes tools resolve --print [--root <dir>] [--json]',
  '         print the open stage-1 findings as a work list for your coding agent',
  '       glirastes tools describe --print [<tool>...|--all] [--write-contracts] [--root <dir>]',
  '         print descriptions, schemas, synonyms and examples to write as a work list for your coding agent',
  '       glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]',
  '         check that every example sentence finds its tool (no model, CI-ready)',
].join('\n');
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
        return await runToolsStatus(rest, io);
      case 'resolve':
        return await runToolsResolve(rest, io);
      case 'eval':
        return await runToolsEval(rest, io);
      default:
```

with:

```ts
        return await runToolsStatus(rest, io);
      case 'resolve':
        return await runToolsResolve(rest, io);
      case 'describe':
        return await runToolsDescribe(rest, io);
      case 'eval':
        return await runToolsEval(rest, io);
      default:
```

In `src/codegen/tools/worklist.ts`, replace:

```ts
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import type { ToolsPipelineResult, ToolsPipelineTool } from './pipeline.js';
import type { ToolFinding } from './types.js';

/**
```

with:

```ts
import { existsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { ToolContractsFileSchema } from './files.js';
import type { ToolsPipelineResult, ToolsPipelineTool } from './pipeline.js';
import { evaluateRouting, type RoutingSentenceFailure } from './routing-eval.js';
import { SEMANTICS_FIELDS, type SemanticsLanguage } from './semantics.js';
import type { ToolFinding } from './types.js';

/**
```

In `src/codegen/tools/worklist.ts`, replace:

```ts
    next: 'Work through items owned by "agent", show items owned by "developer" to the developer, then run glirastes tools refresh and glirastes tools resolve --print again until no item is left.',
  };
}
```

with:

```ts
    next: 'Work through items owned by "agent", show items owned by "developer" to the developer, then run glirastes tools refresh and glirastes tools resolve --print again until no item is left.',
  };
}

export type DescribeGap =
  | 'description-templated'
  | 'contract-derived'
  | 'output-contract-opaque'
  | 'filter-domain-open'
  | 'synonyms-missing'
  | 'examples-missing'
  | 'semantics-stale'
  | 'enrichment-stale'
  | 'routing-ambiguous'
  | 'requested';

export interface DescribeWorkItem {
  tool: string;
  stableKey: string;
  toolId: string;
  module: string;
  gaps: DescribeGap[];
  files: string[];
  evidence: WorklistEvidence;
  /** Fields a human wrote, the code supplies or a review locked; leave them as they are. */
  protectedFields: string[];
  /** Required languages that still lack 3–5 example sentences. */
  missingExamples: SemanticsLanguage[];
  /** Example sentences that do not find this tool (`tools eval`). */
  routing: RoutingSentenceFailure[];
  targets: {
    semantics: { file: string; key: string; expected: Record<string, unknown> };
    schema?: { file: string; key: string; expected: Record<string, unknown> };
    contract?: { file: string; expected: string };
  };
}

export interface DescribeWorklist {
  schemaVersion: typeof WORKLIST_SCHEMA_VERSION;
  kind: 'describe';
  outputsCurrent: boolean;
  blocking: BlockingFinding[];
  /** Languages every tool needs synonyms and examples in: the app language and English. */
  languages: SemanticsLanguage[];
  writeContracts: boolean;
  /** Tools of one module are described together, so similar tools set themselves apart. */
  modules: Array<{ module: string; tools: string[] }>;
  items: DescribeWorkItem[];
  next: string;
}

export interface DescribeWorklistOptions {
  root: string;
  locale: string;
  languages: SemanticsLanguage[];
  /** Named tools (definition id or stable key); empty means every tool with a gap. */
  tools?: ReadonlyArray<string>;
  all?: boolean;
  writeContracts?: boolean;
}

const FINDING_GAPS: ReadonlyArray<DescribeGap> = ['output-contract-opaque', 'filter-domain-open', 'enrichment-stale'];

function parsed<T>(raw: string | undefined, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T | undefined {
  if (raw === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Example sentences that miss their tool, from the outputs the frozen run rendered. */
function routingFailures(result: ToolsPipelineResult): Map<string, RoutingSentenceFailure[]> {
  const artifact = parsed(result.outputs[TOOLS_PATHS.setupArtifact], AppSetupArtifactSchema);
  const contracts = parsed(result.outputs[TOOLS_PATHS.contracts], ToolContractsFileSchema);
  if (!artifact || !contracts) return new Map();
  return new Map(evaluateRouting({ artifact, contracts: contracts.tools }).tools
    .filter((tool) => tool.failures.length > 0)
    .map((tool) => [tool.stableKey, tool.failures] as const));
}

/** The gaps stage 2 can close for one tool (spec 4.7 "Auslöser"). */
export function describeGaps(
  tool: ToolsPipelineTool,
  routing: ReadonlyArray<RoutingSentenceFailure> = [],
): DescribeGap[] {
  const gaps: DescribeGap[] = [];
  if (tool.descriptionOrigin === 'template') gaps.push('description-templated');
  if (tool.schemaQuality === 'field-names') gaps.push('contract-derived');
  for (const gap of FINDING_GAPS) {
    if (tool.findings.some((finding) => finding.code === gap)) gaps.push(gap);
  }
  if (!tool.semantics.hasSynonyms) gaps.push('synonyms-missing');
  if (tool.semantics.missingExamples.length > 0) gaps.push('examples-missing');
  if (tool.semantics.stale) gaps.push('semantics-stale');
  if (routing.length > 0) gaps.push('routing-ambiguous');
  return gaps;
}

function perLanguage<T>(languages: ReadonlyArray<SemanticsLanguage>, value: (language: SemanticsLanguage) => T): Record<string, T> {
  return Object.fromEntries(languages.map((language) => [language, value(language)]));
}

/** The tool-semantics.json entry an agent writes, without the fields it must leave alone. */
export function semanticsEntryTemplate(tool: ToolsPipelineTool, options: Pick<DescribeWorklistOptions, 'locale' | 'languages'>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    description: '<what the tool does, when it fits, and which tool fits better for similar requests>',
    title: perLanguage(options.languages, () => '<short title, e.g. "Aufgaben auflisten" / "List tasks">'),
    module: tool.module,
    usageHints: ['<when to use it, in one sentence>'],
    presentation: {
      locale: options.locale,
      singular: '<one item, e.g. "Aufgabe">',
      plural: '<several items, e.g. "Aufgaben">',
      approval: '<the confirmation question, e.g. "Aufgabe anlegen?">',
    },
    synonyms: perLanguage(options.languages, () => ['<words users say for this, up to 20>']),
    examples: perLanguage(options.languages, () => ['<3 to 5 sentences a user would type>']),
    exampleCalls: [{ sentence: '<one of the examples>', input: '<arguments that match the input schema>' }],
    ...(tool.requiresApproval ? { approvalHint: '<when asking first matters most for this tool>' } : {}),
  };
  const open = SEMANTICS_FIELDS.filter((field) => field in fields && !tool.semantics.protectedFields.includes(field));
  return {
    stableKey: tool.stableKey,
    ...Object.fromEntries(open.map((field) => [field, fields[field]])),
    origin: Object.fromEntries(open.map((field) => [field, 'agent'])),
    agent: { model: MODEL_PLACEHOLDER, interfaceDigest: tool.interfaceDigest ?? '<run glirastes tools refresh first>' },
  };
}

function contractTemplate(tool: ToolsPipelineTool): string {
  const method = tool.route.split(' ')[0] ?? 'POST';
  const keys = inputSchemaSkeleton(tool).properties as Record<string, unknown>;
  const fields = Object.keys(keys).map((key) => `    ${JSON.stringify(key)}: z.unknown() /* the real type */,`);
  return [
    "import { z } from 'zod';",
    '',
    '/** Describes the handler next to it; the generator binds it to the current interface. */',
    'export const contract = {',
    `  ${method}: {`,
    '    input: z.object({',
    ...fields.map((line) => `  ${line}`),
    '    }).strict(),',
    '    output: z.object({ /* what the handler returns */ }),',
    "    description: '<what the endpoint does>',",
    '  },',
    '};',
    '',
  ].join('\n');
}

function describeItem(
  tool: ToolsPipelineTool,
  gaps: DescribeGap[],
  routing: RoutingSentenceFailure[],
  options: DescribeWorklistOptions,
): DescribeWorkItem {
  const schemaGap = gaps.includes('contract-derived') || gaps.includes('enrichment-stale') || gaps.includes('output-contract-opaque');
  const sourceFile = tool.executionKind === 'endpoint' ? tool.files.find((file) => /(^|\/)route\.[cm]?[jt]sx?$/.test(file)) : undefined;
  const contractFile = sourceFile ? posix.join(posix.dirname(sourceFile), 'contract.ts') : undefined;
  const writeContract = options.writeContracts === true && gaps.includes('contract-derived')
    && contractFile !== undefined && !existsSync(resolve(options.root, contractFile));
  return {
    tool: tool.definitionId,
    stableKey: tool.stableKey,
    toolId: tool.toolId,
    module: tool.module,
    gaps,
    files: tool.files,
    evidence: evidenceOf(tool),
    protectedFields: [...tool.semantics.protectedFields],
    missingExamples: [...tool.semantics.missingExamples],
    routing,
    targets: {
      semantics: { file: TOOLS_PATHS.semantics, key: semanticsKey(tool.stableKey), expected: semanticsEntryTemplate(tool, options) },
      ...(schemaGap && tool.executionKind === 'endpoint'
        ? {
          schema: {
            file: TOOLS_PATHS.resolutions,
            key: toolKey(tool.stableKey),
            expected: {
              ...resolutionEntryTemplate(tool),
              ...(gaps.includes('output-contract-opaque') ? { output: { jsonSchema: { type: 'object', properties: {}, description: '<the response shape the handler returns>' } } } : {}),
            },
          },
        }
        : {}),
      ...(writeContract ? { contract: { file: contractFile!, expected: contractTemplate(tool) } } : {}),
    },
  };
}

/** Stage-2 work for `glirastes tools describe --print`: descriptions, typed schemas, synonyms, examples. */
export function buildDescribeWorklist(result: ToolsPipelineResult, options: DescribeWorklistOptions): DescribeWorklist {
  const resolveList = buildResolveWorklist(result);
  const routing = routingFailures(result);
  const requested = new Set(options.tools ?? []);
  const items = (result.tools ?? [])
    .filter((tool) => tool.contract !== null)
    .map((tool) => {
      const failures = routing.get(tool.stableKey) ?? [];
      const named = requested.has(tool.definitionId) || requested.has(tool.stableKey);
      const gaps = describeGaps(tool, failures);
      if (requested.size > 0 && !named) return undefined;
      if (gaps.length === 0 && !named && !options.all) return undefined;
      return describeItem(tool, gaps.length > 0 ? gaps : ['requested'], failures, options);
    })
    .filter((item): item is DescribeWorkItem => item !== undefined)
    .sort((left, right) => compareCodeUnits(left.module, right.module) || compareCodeUnits(left.tool, right.tool));
  const modules = new Map<string, string[]>();
  for (const item of items) modules.set(item.module, [...modules.get(item.module) ?? [], item.tool]);
  return {
    schemaVersion: WORKLIST_SCHEMA_VERSION,
    kind: 'describe',
    outputsCurrent: resolveList.outputsCurrent,
    blocking: resolveList.blocking,
    languages: [...options.languages],
    writeContracts: options.writeContracts === true,
    modules: [...modules].map(([module, tools]) => ({ module, tools })),
    items,
    next: 'Describe one module at a time, fill only the open fields, then run glirastes tools refresh, glirastes tools eval and glirastes tools describe --print again.',
  };
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/codegen/tools/worklist.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  17 passed (17)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/args.ts src/cli/commands/tools/describe.ts src/cli/commands/tools/index.ts src/cli/commands/tools/tools-command.test.ts src/codegen/tools/worklist.test.ts src/codegen/tools/worklist.ts
git commit -m "feat(cli): print the stage-2 work list with tools describe --print"
```

### Task 11: The refresh end note and `ci.requireEnrichment`

**Files:**
- Modify: `src/cli/commands/tools/format.ts` (`agentWorkNotes`), `src/cli/commands/tools/refresh.ts` (prints the notes after a human refresh), `src/cli/commands/tools/check.ts` (`ci.requireEnrichment`), `src/codegen/tools/config.ts` (comment)
- Test: `src/cli/commands/tools/tools-command.test.ts` (the existing real-app case gains the describe note; one new case)

**Interfaces:**
- Consumes: Task 8 `buildResolveWorklist`, Task 10 `describeGaps`.
- Produces: `agentWorkNotes(result): string[]` — "`N tool(s) need(s) attention – your coding agent can resolve this with \`glirastes tools resolve --print\`.`" for tools with agent items, and "`N tool(s) need(s) a better description – your coding agent can do this with \`glirastes tools describe --print\`.`" (spec 4.6 sentence, in the CLI's English) for tools with a contract and a stage-2 gap. Printed after the human summary of `tools refresh`, never with `--json`. `tools check` exits 1 with `Enrichment required: …` when `ci.requireEnrichment` is set and an enabled tool has only a template description or field names (spec 4.7, default off).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
        },
      ],
    });
    await fixture.write('src/app/api/tasks/route.ts', ROUTE.split('export async function POST')[0]!);
    out.length = 0;
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
```

with:

```ts
        },
      ],
    });
    expect(refresh).toContain('2 tools need a better description – your coding agent can do this with `glirastes tools describe --print`.');
    expect(refresh).not.toContain('need attention');
    await fixture.write('src/app/api/tasks/route.ts', ROUTE.split('export async function POST')[0]!);
    out.length = 0;
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
```

In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
    expect(formatToolStatus([entry('archive', { confirmationOrigin: 'local-policy', platformMayRelax: false })]))
      .not.toContain('Platform may relax');
  });

  it('prints the resolve work list from a frozen read and refuses to run without --print', async () => {
    const h = harness(emptyResult({ mode: 'frozen' }));
```

with:

```ts
    expect(formatToolStatus([entry('archive', { confirmationOrigin: 'local-policy', platformMayRelax: false })]))
      .not.toContain('Platform may relax');
  });

  it('names open stage-1 work after a refresh and enforces ci.requireEnrichment in check', async () => {
    const fixture = await createAppFixture({
      'src/app/api/tasks/route.ts': ROUTE,
      'src/app/api/raw/route.ts': 'declare function getSession(): Promise<unknown>;\ndeclare function save(value: unknown): Promise<unknown>;\n'
        + 'export async function POST(request: Request) { await getSession(); return Response.json(await save(await request.json())); }\n',
    }, { toolsConfig: { ci: { requireEnrichment: true } } });
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('1 tool needs attention – your coding agent can resolve this with `glirastes tools resolve --print`.');
    out.length = 0;
    expect(await runToolsCommand(['check'], deps)).toBe(1);
    expect(out.join('\n')).toContain('Enrichment required: 2 tool(s) have only a template description or field names (tasks.create, tasks.list).');
    out.length = 0;
    expect(await runToolsCommand(['refresh', '--json'], deps)).toBe(0);
    expect(out.join('\n')).not.toContain('coding agent');
  }, 120_000);

  it('prints the resolve work list from a frozen read and refuses to run without --print', async () => {
    const h = harness(emptyResult({ mode: 'frozen' }));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts --maxWorkers=4`
Expected: FAIL — refresh prints no closing sentence and `check` ignores `ci.requireEnrichment`. `Test Files  1 failed (1)`, `Tests  2 failed | 9 passed (11)`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/check.ts`, replace:

```ts
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--strict', '--integrity-only', '--json'], values: ['--root'] });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const strict = args.flags.has('--strict') || loadToolsConfig(root).ci.strict === true;
  const result = await io.runPipeline({ root, mode: args.flags.has('--integrity-only') ? 'integrity' : 'frozen' });
  const json = args.flags.has('--json');
  io.log(json ? formatToolsJson(result) : formatToolsHuman(result));
```

with:

```ts
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--strict', '--integrity-only', '--json'], values: ['--root'] });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const strict = args.flags.has('--strict') || config.ci.strict === true;
  const result = await io.runPipeline({ root, mode: args.flags.has('--integrity-only') ? 'integrity' : 'frozen' });
  const json = args.flags.has('--json');
  io.log(json ? formatToolsJson(result) : formatToolsHuman(result));
```

In `src/cli/commands/tools/check.ts`, replace:

```ts
    if (!json) io.log(`Strict check: ${attention.length} tool finding(s) need attention.`);
    return 1;
  }
  return 0;
}
```

with:

```ts
    if (!json) io.log(`Strict check: ${attention.length} tool finding(s) need attention.`);
    return 1;
  }
  // ci.requireEnrichment (spec 4.7, default off): template prose or field names fail the check.
  const weak = config.ci.requireEnrichment === true
    ? (result.tools ?? []).filter((tool) => tool.enabled
      && (tool.descriptionOrigin === 'template' || tool.schemaQuality === 'field-names'))
    : [];
  if (weak.length > 0) {
    if (!json) {
      io.log(`Enrichment required: ${weak.length} tool(s) have only a template description or field names `
        + `(${weak.map((tool) => tool.definitionId).join(', ')}). Run glirastes tools describe --print.`);
    }
    return 1;
  }
  return 0;
}
```

In `src/cli/commands/tools/format.ts`, replace:

```ts
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import type { DescriptionOrigin } from '../../../codegen/tools/prose.js';
import type { ContractSource, ToolFinding } from '../../../codegen/tools/types.js';
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { riskTier } from '../../../contracts/tool-policy.js';

```

with:

```ts
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import type { DescriptionOrigin } from '../../../codegen/tools/prose.js';
import type { ContractSource, ToolFinding } from '../../../codegen/tools/types.js';
import { buildResolveWorklist, describeGaps } from '../../../codegen/tools/worklist.js';
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { riskTier } from '../../../contracts/tool-policy.js';

```

In `src/cli/commands/tools/format.ts`, replace:

```ts
  return 'asks first';
}

export function formatToolStatus(entries: ReadonlyArray<ToolStatusEntry>): string {
  const active = entries.filter((entry) => entry.enabled).length;
  const attention = entries.filter((entry) => entry.needsAttention).length;
```

with:

```ts
  return 'asks first';
}

function tools(count: number, verb: [string, string]): string {
  return `${count} tool${count === 1 ? '' : 's'} ${count === 1 ? verb[0] : verb[1]}`;
}

/**
 * The closing sentences of a refresh (spec 4.6): what the developer's own
 * coding agent can still do, with the command that prints its work list.
 */
export function agentWorkNotes(result: ToolsPipelineResult): string[] {
  const views = result.tools ?? [];
  const attention = new Set(buildResolveWorklist(result).items
    .filter((item) => item.owner === 'agent' && item.toolId !== null)
    .map((item) => item.stableKey)).size;
  const describe = views.filter((tool) => tool.contract !== null && describeGaps(tool).length > 0).length;
  const notes: string[] = [];
  if (attention > 0) {
    notes.push(`${tools(attention, ['needs', 'need'])} attention – your coding agent can resolve this with \`glirastes tools resolve --print\`.`);
  }
  if (describe > 0) {
    notes.push(`${tools(describe, ['needs', 'need'])} a better description – your coding agent can do this with \`glirastes tools describe --print\`.`);
  }
  return notes;
}

export function formatToolStatus(entries: ReadonlyArray<ToolStatusEntry>): string {
  const active = entries.filter((entry) => entry.enabled).length;
  const attention = entries.filter((entry) => entry.needsAttention).length;
```

In `src/cli/commands/tools/refresh.ts`, replace:

```ts
import { resolve } from 'node:path';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--keep-going', '--json'], values: ['--root', '--mode', '--adopt'] });
```

with:

```ts
import { resolve } from 'node:path';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { agentWorkNotes, formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--keep-going', '--json'], values: ['--root', '--mode', '--adopt'] });
```

In `src/cli/commands/tools/refresh.ts`, replace:

```ts
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  io.log(args.flags.has('--json') ? formatToolsJson(result) : formatToolsHuman(result));
  return 0;
}
```

with:

```ts
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  if (args.flags.has('--json')) {
    io.log(formatToolsJson(result));
    return 0;
  }
  const notes = agentWorkNotes(result);
  io.log(notes.length > 0 ? `${formatToolsHuman(result)}\n\n${notes.join('\n')}` : formatToolsHuman(result));
  return 0;
}
```

In `src/codegen/tools/config.ts`, replace:

```ts
  }).strict().default({}),
  ci: z.object({
    strict: z.boolean().optional(),
    /** Accepted now; enforced by P05. */
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
```

with:

```ts
  }).strict().default({}),
  ci: z.object({
    strict: z.boolean().optional(),
    /** `tools check` fails while an enabled tool has only a template description or field names. */
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  11 passed (11)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/check.ts src/cli/commands/tools/format.ts src/cli/commands/tools/refresh.ts src/cli/commands/tools/tools-command.test.ts src/codegen/tools/config.ts
git commit -m "feat(cli): name the open agent work after every refresh"
```

### Task 12: `glirastes tools refresh --watch`

**Files:**
- Create: `src/cli/commands/tools/watch.ts` (`isWatchedPath`, `defaultToolsWatch`, `watchToolsRefresh`)
- Modify: `src/cli/commands/tools/refresh.ts` (replaced as a whole: `REFRESH_ARGS`, `--watch`), `src/cli/commands/tools/format.ts` (`ToolsIo.watch`/`signal`), `src/cli/commands/tools/index.ts` (dependencies and usage)
- Test: `src/cli/commands/tools/watch.test.ts` (Create)

**Interfaces:**
- Consumes: Task 11 `agentWorkNotes`; P03 `generatedModulePath`, `ToolsPipelineFailure`.
- Produces: `glirastes tools refresh --watch` (spec 4.2, 4.8): one write refresh with `keepGoing`, then one more after each burst of relevant changes (300 ms debounce, never overlapping, a change during a run schedules exactly one more), until SIGINT/SIGTERM; a failing refresh is printed and the watch goes on. Watched: app files outside `node_modules`, `.git`, `.next`, `.turbo`, `.vercel`, `.tool-fixtures`, dotfiles and editor backups, and outside `dist`, `build`, `out` and `coverage` directly in the app or its `src` folder (a feature folder of such a name deeper down is watched, as Task 6 scans it); under `.glirastes` only the five inputs. The generated module and every output never retrigger. `--watch` refuses frozen/integrity mode, `--json` and `--adopt`. `ToolsWatchFactory`, `ToolsWatcher`, `ToolsIo.watch?`, `ToolsIo.signal?` and `ToolsCommandDependencies.watch?/signal?` for tests.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/commands/tools/watch.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { toolFinding } from '../../../codegen/tools/findings.js';
import { ToolsPipelineFailure, type ToolsPipelineOptions, type ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import { runToolsCommand } from './index.js';
import { isWatchedPath, watchToolsRefresh, type ToolsWatchFactory } from './watch.js';

afterEach(removeAppFixtures);

const MODULE = 'src/generated/glirastes/tools.generated.ts';
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((done) => setTimeout(done, 5));
  expect(condition()).toBe(true);
};

function fakeWatch() {
  const state: { onChange?: (path: string) => void; closed: boolean } = { closed: false };
  const factory: ToolsWatchFactory = (_root, onChange) => {
    state.onChange = onChange;
    return { close: () => { state.closed = true; } };
  };
  return { state, factory };
}

describe('tools refresh --watch', () => {
  it.each([
    ['src/app/api/tasks/route.ts', true],
    ['app/(app)/tasks/page.tsx', true],
    ['.glirastes/tool-semantics.json', true],
    ['.glirastes/tool-policy.json', true],
    ['.glirastes/setup-artifact.json', false],
    ['.glirastes/build/runtime-manifest.json', false],
    [MODULE, false],
    ['node_modules/zod/index.js', false],
    ['.next/server/app.js', false],
    ['build/server/chunk.js', false],
    ['src/app/(app)/build/actions.tsx', true],
    ['src/app/.DS_Store', false],
    ['src/app/page.tsx~', false],
  ])('watches %s: %s', (path, watched) => {
    expect(isWatchedPath(path, MODULE)).toBe(watched);
  });

  it('refreshes once, then once per burst of relevant changes, never overlapping', async () => {
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    let runs = 0;
    let active = 0;
    let overlap = false;
    const done = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: controller.signal, watch: factory, debounceMs: 10,
      run: async () => {
        active += 1;
        overlap ||= active > 1;
        runs += 1;
        await new Promise((resolveRun) => setTimeout(resolveRun, 20));
        active -= 1;
      },
    });
    await until(() => state.onChange !== undefined);
    expect(runs).toBe(1);
    state.onChange!('src/a.ts');
    state.onChange!('src/b.ts');
    state.onChange!(MODULE);
    await until(() => runs === 2);
    state.onChange!('.glirastes/tool-report.json');
    await new Promise((settle) => setTimeout(settle, 60));
    expect(runs).toBe(2);
    controller.abort();
    await done;
    expect(state.closed).toBe(true);
    expect(overlap).toBe(false);
  });

  it('keeps watching after a failing refresh and stops with the signal', async () => {
    const fixture = await createAppFixture();
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    const calls: ToolsPipelineOptions[] = [];
    const out: string[] = [];
    const result = (findings: ToolsPipelineResult['findings']): ToolsPipelineResult => ({
      mode: 'write', changes: { added: [], changed: [], removed: [], unchanged: [] },
      findings, excluded: [], outputs: {}, driftPaths: [], wrote: false,
    });
    const runPipeline = async (options: ToolsPipelineOptions): Promise<ToolsPipelineResult> => {
      calls.push(options);
      if (calls.length === 1) {
        throw new ToolsPipelineFailure(result([toolFinding('E-INVENTORY-011', 'error', 'next-app', 'export * found')]));
      }
      return result([]);
    };
    const watching = runToolsCommand(['refresh', '--watch'], {
      cwd: fixture.root, env: {}, log: (line) => { out.push(line); }, error: () => undefined,
      runPipeline, watch: factory, signal: controller.signal,
    });
    await until(() => state.onChange !== undefined);
    expect(out.join('\n')).toContain('Nothing was written.');
    state.onChange!('src/app/api/tasks/route.ts');
    await until(() => calls.length === 2);
    expect(calls).toEqual([
      { root: fixture.root, mode: 'write', keepGoing: true },
      { root: fixture.root, mode: 'write', keepGoing: true },
    ]);
    controller.abort();
    expect(await watching).toBe(0);
    expect(out[0]).toBe('Watching the app for tool changes. Stop with Ctrl+C.');
    expect(out.at(-1)).toContain('Tool outputs are up to date.');
  });

  it('refuses to watch in CI or with machine-readable output', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = (env: NodeJS.ProcessEnv) => ({ cwd: '/app', env, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } });
    expect(await runToolsCommand(['refresh', '--watch'], deps({ CI: 'true' }))).toBe(2);
    expect(await runToolsCommand(['refresh', '--watch', '--json'], deps({}))).toBe(2);
    expect(err.join('\n')).toContain('--watch refreshes in write mode only');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/watch.test.ts --maxWorkers=4`
Expected: FAIL — `Cannot find module './watch.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/format.ts`, replace:

```ts
import type { DescriptionOrigin } from '../../../codegen/tools/prose.js';
import type { ContractSource, ToolFinding } from '../../../codegen/tools/types.js';
import { buildResolveWorklist, describeGaps } from '../../../codegen/tools/worklist.js';
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { riskTier } from '../../../contracts/tool-policy.js';

```

with:

```ts
import type { DescriptionOrigin } from '../../../codegen/tools/prose.js';
import type { ContractSource, ToolFinding } from '../../../codegen/tools/types.js';
import { buildResolveWorklist, describeGaps } from '../../../codegen/tools/worklist.js';
import type { ToolsWatchFactory } from './watch.js';
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { riskTier } from '../../../contracts/tool-policy.js';

```

In `src/cli/commands/tools/format.ts`, replace:

```ts
  log(line: string): void;
  error(line: string): void;
  runPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult>;
}

export interface ToolStatusEntry {
```

with:

```ts
  log(line: string): void;
  error(line: string): void;
  runPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult>;
  /** `tools refresh --watch`: file watching and the stop signal (tests inject both). */
  watch?: ToolsWatchFactory;
  signal?: AbortSignal;
}

export interface ToolStatusEntry {
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  log?: (line: string) => void;
  error?: (line: string) => void;
  runPipeline?: (options: ToolsPipelineOptions) => Promise<ToolsPipelineResult>;
}

export const TOOLS_USAGE = [
  'Usage: glirastes tools refresh [--root <dir>] [--mode write|frozen|integrity] [--keep-going] [--adopt <inventory>] [--json]',
  '         derive tools from the code (writes locally, checks in CI, verifies in Docker)',
  '       glirastes tools check [--root <dir>] [--strict] [--integrity-only] [--json]',
  '         verify the committed tool outputs without writing, models or network',
  '       glirastes tools status [--root <dir>] [--json]',
```

with:

```ts
  log?: (line: string) => void;
  error?: (line: string) => void;
  runPipeline?: (options: ToolsPipelineOptions) => Promise<ToolsPipelineResult>;
  watch?: ToolsIo['watch'];
  signal?: AbortSignal;
}

export const TOOLS_USAGE = [
  'Usage: glirastes tools refresh [--root <dir>] [--mode write|frozen|integrity] [--keep-going] [--adopt <inventory>] [--watch] [--json]',
  '         derive tools from the code (writes locally, checks in CI, verifies in Docker; --watch keeps refreshing)',
  '       glirastes tools check [--root <dir>] [--strict] [--integrity-only] [--json]',
  '         verify the committed tool outputs without writing, models or network',
  '       glirastes tools status [--root <dir>] [--json]',
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
    log: deps.log ?? ((line) => { console.log(line); }),
    error: deps.error ?? ((line) => { console.error(line); }),
    runPipeline: deps.runPipeline ?? runToolsPipeline,
  };
  const [subcommand, ...rest] = argv;
  const json = rest.includes('--json');
```

with:

```ts
    log: deps.log ?? ((line) => { console.log(line); }),
    error: deps.error ?? ((line) => { console.error(line); }),
    runPipeline: deps.runPipeline ?? runToolsPipeline,
    ...(deps.watch ? { watch: deps.watch } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  const [subcommand, ...rest] = argv;
  const json = rest.includes('--json');
```

Replace the whole content of `src/cli/commands/tools/refresh.ts` with:

```ts
import { resolve } from 'node:path';
import { generatedModulePath, loadToolsConfig } from '../../../codegen/tools/config.js';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { agentWorkNotes, formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { watchToolsRefresh } from './watch.js';

export const REFRESH_ARGS = {
  flags: ['--keep-going', '--json', '--watch'],
  values: ['--root', '--mode', '--adopt'],
} as const;

/** Until Ctrl+C: one refresh per burst of changes; a failing refresh is printed and the watch goes on. */
async function watchRefresh(root: string, io: ToolsIo): Promise<number> {
  const config = loadToolsConfig(root);
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  const signal = io.signal ?? controller.signal;
  if (!io.signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  io.log('Watching the app for tool changes. Stop with Ctrl+C.');
  try {
    await watchToolsRefresh({
      root,
      generatedModule: generatedModulePath(config),
      signal,
      ...(io.watch ? { watch: io.watch } : {}),
      run: async () => {
        try {
          const result = await io.runPipeline({ root, mode: 'write', keepGoing: true });
          const notes = agentWorkNotes(result);
          io.log(notes.length > 0 ? `${formatToolsHuman(result)}\n\n${notes.join('\n')}` : formatToolsHuman(result));
        } catch (error) {
          if (error instanceof ToolsPipelineFailure) io.log(formatToolsHuman(error.result));
          else if (isFoundationDiagnosticError(error)) io.error(`${error.code}: ${error.message}`);
          else throw error;
        }
      },
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return 0;
}

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, REFRESH_ARGS);
  const modeFlag = args.values.get('--mode');
  if (modeFlag !== undefined && !isToolsMode(modeFlag)) {
    throw new ToolsUsageError('--mode must be write, frozen or integrity.');
  }
  const mode = resolveToolsMode({ ...(modeFlag !== undefined ? { flag: modeFlag } : {}), env: io.env });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  if (args.flags.has('--watch')) {
    if (mode !== 'write') throw new ToolsUsageError('--watch refreshes in write mode only; CI and Docker builds check once.');
    if (args.flags.has('--json') || args.values.has('--adopt')) throw new ToolsUsageError('--watch cannot be combined with --json or --adopt.');
    return watchRefresh(root, io);
  }
  const keepGoing = args.flags.has('--keep-going') && mode === 'write';
  const adoptInventoryPath = args.values.get('--adopt');
  const result = await io.runPipeline({
    root,
    mode,
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  if (args.flags.has('--json')) {
    io.log(formatToolsJson(result));
    return 0;
  }
  const notes = agentWorkNotes(result);
  io.log(notes.length > 0 ? `${formatToolsHuman(result)}\n\n${notes.join('\n')}` : formatToolsHuman(result));
  return 0;
}
```

Create `src/cli/commands/tools/watch.ts`:

```ts
import { watch as watchFiles } from 'node:fs';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';

export interface ToolsWatcher {
  close(): void;
}

/** Reports every changed path below the app root, app-relative. */
export type ToolsWatchFactory = (root: string, onChange: (path: string) => void) => ToolsWatcher;

/** Folders whose changes never change a tool, at any depth. */
const IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.next', '.turbo', '.vercel', '.tool-fixtures',
]);

/**
 * Build output, directly in the app or its `src` folder only: a feature
 * folder of that name deeper down is app code the generator scans (Task 6).
 */
const OUTPUT_FOLDERS: ReadonlySet<string> = new Set(['dist', 'build', 'out', 'coverage']);

/** Inputs under .glirastes that change tools; every other file there belongs to the generator or the CLI. */
const WATCHED_INPUTS: ReadonlySet<string> = new Set([
  TOOLS_PATHS.config, TOOLS_PATHS.policy, TOOLS_PATHS.resolutions, TOOLS_PATHS.semantics, TOOLS_PATHS.promptBundle,
]);

/** Whether a change at this app-relative path can change the tools; generated files never retrigger. */
export function isWatchedPath(path: string, generatedModule: string): boolean {
  const normalized = path.split('\\').join('/').replace(/^\.\//, '');
  if (normalized === '' || normalized === generatedModule) return false;
  const segments = normalized.split('/');
  if (segments[0] === '.glirastes') return WATCHED_INPUTS.has(normalized);
  if (segments.some((segment) => IGNORED_FOLDERS.has(segment))) return false;
  const top = segments[0] === 'src' ? 1 : 0;
  if (segments.length > top + 1 && OUTPUT_FOLDERS.has(segments[top]!)) return false;
  const name = segments.at(-1)!;
  return !name.startsWith('.') && !name.endsWith('~');
}

export const defaultToolsWatch: ToolsWatchFactory = (root, onChange) => {
  const watcher = watchFiles(root, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename.toString());
  });
  return { close: () => { watcher.close(); } };
};

/**
 * `tools refresh --watch` (spec 4.2, 4.8): refresh once, then again after
 * each burst of relevant changes. Runs never overlap; a change during a run
 * schedules exactly one more. Resolves when the signal aborts.
 */
export async function watchToolsRefresh(options: {
  root: string;
  generatedModule: string;
  run: () => Promise<void>;
  signal: AbortSignal;
  watch?: ToolsWatchFactory;
  debounceMs?: number;
}): Promise<void> {
  const debounceMs = options.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let pending = false;
  const runNow = (): void => {
    if (options.signal.aborted) return;
    if (running) {
      pending = true;
      return;
    }
    running = options.run().finally(() => {
      running = undefined;
      if (pending) {
        pending = false;
        schedule();
      }
    });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      runNow();
    }, debounceMs);
  };
  runNow();
  await running;
  if (options.signal.aborted) return;
  const watcher = (options.watch ?? defaultToolsWatch)(options.root, (path) => {
    if (isWatchedPath(path, options.generatedModule)) schedule();
  });
  await new Promise<void>((resolveStop) => {
    options.signal.addEventListener('abort', () => resolveStop(), { once: true });
  });
  watcher.close();
  if (timer) clearTimeout(timer);
  await running;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/watch.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/tools --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  16 passed (16)`; `src/cli/commands/tools` reports `Test Files  2 passed (2)`, `Tests  27 passed (27)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/format.ts src/cli/commands/tools/index.ts src/cli/commands/tools/refresh.ts src/cli/commands/tools/watch.test.ts src/cli/commands/tools/watch.ts
git commit -m "feat(cli): keep tools current with tools refresh --watch"
```

### Task 13: `glirastes tools policy`: the local overrides

**Files:**
- Create: `src/cli/commands/tools/policy.ts` (`POLICY_SUBCOMMANDS`, `POLICY_USAGE`, `runToolsPolicy`)
- Modify: `src/cli/commands/tools/index.ts` (dispatch, usage, policy usage on errors), `src/cli/commands/tools/format.ts` (exports P04b's `confirmationLabel`; the D16 hint names `tools policy confirm`)
- Test: `src/cli/commands/tools/policy.test.ts` (Create)

**Interfaces:**
- Consumes: P02 `ToolPolicyFileSchema`, `resolveToolPolicy`, `riskTier`, `parseExcludePattern` (P04: `PAGE /path` patterns); P04b `platformMayRelaxConfirmation`, `confirmationLabel` and the `local-policy` report of an explicit `requiresApproval: true`; P03 committed outputs (`setup-artifact.json`, `tool-contracts.json` defaults); `writeArtifactSetAtomically`; Task 9 `readToolOutput`.
- Produces: `glirastes tools policy <subcommand>` (spec 4.2; roadmap row with the `accept` contract):
  - `show [<tool>] [--json]`, `disable <tool>`, `enable <tool>` (removes a local disable only), `confirm <tool>` (drops a pin; up to tier 2 the message says a connected Platform can no longer switch the confirmation off and `reset` lifts the lock), `relax <tool> --yes` (write tools that ask first; sets `requiresApproval: false` and `pin { toolId, atRiskClass: <effective risk> }`; tier 3 refused), `raise <tool> <riskClass>` (strictly higher only), `roles <tool> <a,b|->`, `describe <tool> <text|->`, `exclude "<pattern>" --reason <text>`, `include "<pattern>"`, `accept <tool>` (writes `acceptedRisk[stableKey] = { riskClass: <riskClass of the risk-lower-available warning>, toolId }` and nothing else), `reset <tool|stableKey>` (also orphaned keys); `--reason` on the entry commands.
  - `show` prints the confirmation with the labels of `tools status` (`asks first, Platform may relax`, `asks first, locked in tool-policy.json`, `asks first`, `runs directly`); `show --json` adds `confirmationOrigin` and `platformMayRelax` to `effective`.
  - A tool is named as `tools status` prints it or by its stable key; entries are keyed by the inventory stable key. Every entry is checked with `resolveToolPolicy` (code defaults from `tool-contracts.json`, the previous effective risk from the artifact) and the whole file with `ToolPolicyFileSchema` before the atomic write; the file is written in canonical key order. The CLI never refreshes on its own: it prints "Run glirastes tools refresh to apply it."

- [ ] **Step 1: Write the failing tests**

Create `src/cli/commands/tools/policy.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from '../../../codegen/tools/__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { runToolsCommand } from './index.js';

afterEach(removeAppFixtures);

const SESSION = 'declare function getSession(): Promise<unknown>;\n';
const TASKS = `${SESSION}export async function GET(request: Request) { await getSession();\n`
  + "  const { searchParams } = new URL(request.url); return Response.json({ status: searchParams.get('status') }); }\n"
  + 'export async function POST(request: Request) { await getSession(); const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }); }\n';
const TASK = `${SESSION}export async function DELETE() { await getSession(); return Response.json({ deleted: true }); }\n`;

interface Harness {
  fixture: AppFixture;
  out: string[];
  err: string[];
  run(...argv: string[]): Promise<number>;
  policy(): Promise<Record<string, unknown>>;
  tool(name: string): Promise<Record<string, unknown>>;
}

async function harness(): Promise<Harness> {
  const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': TASKS, 'src/app/api/tasks/[id]/route.ts': TASK });
  const out: string[] = [];
  const err: string[] = [];
  const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
  const h: Harness = {
    fixture,
    out,
    err,
    run: (...argv) => runToolsCommand(argv, deps),
    policy: async () => JSON.parse(await fixture.read(TOOLS_PATHS.policy)) as Record<string, unknown>,
    tool: async (name) => {
      const artifact = AppSetupArtifactSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.setupArtifact)));
      return artifact.tools.find((tool) => tool.name === name)! as unknown as Record<string, unknown>;
    },
  };
  expect(await runToolsCommand(['refresh'], deps)).toBe(0);
  return h;
}

describe('glirastes tools policy', () => {
  it('edits the local policy by tool name and refresh applies it', async () => {
    const h = await harness();
    expect(await h.run('policy', 'disable', 'tasks.list', '--reason', 'read-only demo')).toBe(0);
    expect(h.out.at(-1)).toBe('Updated .glirastes/tool-policy.json: tasks.list is disabled. Run glirastes tools refresh to apply it.');
    expect(await h.run('policy', 'describe', 'tasks.list', 'Lists your tasks by status.')).toBe(0);
    expect(await h.run('policy', 'raise', 'tasks.create', 'delete', '--reason', 'creates billable items')).toBe(0);
    expect(await h.run('policy', 'roles', 'tasks.create', 'editor,admin,editor')).toBe(0);
    expect(await h.policy()).toEqual({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': { enabled: false, reason: 'read-only demo', description: 'Lists your tasks by status.' },
        'POST /api/tasks': { riskClass: 'delete', reason: 'creates billable items', allowedRoles: ['admin', 'editor'] },
      },
      exclude: [],
      acceptedRisk: {},
    });
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.list')).toMatchObject({ enabled: false, description: 'Lists your tasks by status.' });
    expect(await h.tool('tasks.create')).toMatchObject({ riskClass: 'delete', requiresApproval: true, allowedRoles: ['admin', 'editor'] });
    expect(await h.run('policy', 'enable', 'tasks.list')).toBe(0);
    expect(await h.run('policy', 'enable', 'tasks.list')).toBe(2);
    expect(await h.run('policy', 'reset', 'POST /api/tasks')).toBe(0);
    expect((await h.policy()).tools).toEqual({ 'GET /api/tasks': { reason: 'read-only demo', description: 'Lists your tasks by status.' } });
    h.out.length = 0;
    expect(await h.run('policy', 'show', 'tasks.list', '--json')).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({
      tools: [{ name: 'tasks.list', stableKey: 'GET /api/tasks', local: { description: 'Lists your tasks by status.' } }],
    });
  }, 180_000);

  it('relaxes confirmation only for reviewed write tools and only raises the risk', async () => {
    const h = await harness();
    h.out.length = 0;
    expect(await h.run('policy', 'show')).toBe(0);
    expect(h.out.join('\n')).toContain('tasks.create  POST /api/tasks  write, asks first, Platform may relax, active');
    expect(h.out.join('\n')).toContain('tasks.delete  DELETE /api/tasks/:id  delete, asks first, active');
    h.out.length = 0;
    expect(await h.run('policy', 'show', 'tasks.create', '--json')).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({
      tools: [{ name: 'tasks.create', effective: { requiresApproval: true, confirmationOrigin: 'code-default', platformMayRelax: true } }],
    });
    expect(await h.run('policy', 'relax', 'tasks.create')).toBe(2);
    expect(h.err.join('\n')).toContain('confirm the review with --yes');
    expect(await h.run('policy', 'relax', 'tasks.delete', '--yes')).toBe(2);
    expect(h.err.join('\n')).toContain('delete, financial and external tools always ask first');
    expect(await h.run('policy', 'raise', 'tasks.list', 'safe-read')).toBe(2);
    expect(h.err.join('\n')).toContain('the policy can only raise the risk');
    expect(await h.run('policy', 'relax', 'tasks.create', '--yes', '--reason', 'reviewed in PR 12')).toBe(0);
    const created = await h.tool('tasks.create');
    expect((await h.policy()).tools).toEqual({
      'POST /api/tasks': { requiresApproval: false, pin: { toolId: created.toolId, atRiskClass: 'write' }, reason: 'reviewed in PR 12' },
    });
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.create')).toMatchObject({ riskClass: 'write', requiresApproval: false });
    expect(await h.run('policy', 'confirm', 'tasks.create')).toBe(0);
    expect(h.out.at(-1)).toContain('tasks.create asks before it runs, and a connected Platform can no longer switch that off'
      + ' (glirastes tools policy reset tasks.create lifts the lock)');
    expect((await h.policy()).tools).toEqual({ 'POST /api/tasks': { requiresApproval: true, reason: 'reviewed in PR 12' } });
    expect(await h.run('refresh')).toBe(0);
    h.out.length = 0;
    expect(await h.run('policy', 'show', 'tasks.create')).toBe(0);
    expect(h.out.join('\n')).toContain('tasks.create  POST /api/tasks  write, asks first, locked in tool-policy.json, active');
    expect(await h.run('policy', 'disable', 'tasks.unknown')).toBe(2);
    expect(h.err.join('\n')).toContain('Unknown tool tasks.unknown; glirastes tools status lists the names.');
  }, 180_000);

  it('excludes and includes routes and pages and removes orphaned entries', async () => {
    const h = await harness();
    expect(await h.run('policy', 'exclude', 'POST /api/tasks')).toBe(2);
    expect(await h.run('policy', 'exclude', 'tasks create', '--reason', 'x')).toBe(2);
    expect(await h.run('policy', 'exclude', 'POST /api/tasks', '--reason', 'internal')).toBe(0);
    expect(await h.run('policy', 'exclude', 'PAGE /admin/**', '--reason', 'admin pages stay manual')).toBe(0);
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.create')).toBeUndefined();
    expect(await h.run('policy', 'include', 'POST /api/tasks')).toBe(0);
    expect((await h.policy()).exclude).toEqual([{ match: 'PAGE /admin/**', reason: 'admin pages stay manual' }]);
    expect(await h.run('policy', 'include', 'POST /api/other')).toBe(2);
    await h.fixture.write(TOOLS_PATHS.policy, JSON.stringify({ schemaVersion: 1, tools: { 'GET /api/gone': { enabled: false } } }));
    expect(await h.run('policy', 'reset', 'GET /api/gone')).toBe(0);
    expect((await h.policy()).tools).toEqual({});
  }, 180_000);

  it('accepts exactly the lower risk the ratchet holds back', async () => {
    const h = await harness();
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await h.fixture.read(TOOLS_PATHS.contracts)));
    const interfaceDigest = contracts.tools.find((entry) => entry.stableKey === 'GET /api/tasks')!.contract!.interfaceDigest;
    expect(await h.run('policy', 'accept', 'tasks.list')).toBe(2);
    await h.fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({
      schemaVersion: 1, tools: { 'GET /api/tasks': { interfaceDigest, effect: 'destructive' } },
    }));
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.list')).toMatchObject({ riskClass: 'delete', requiresApproval: true });
    await h.fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({ schemaVersion: 1, tools: {} }));
    h.out.length = 0;
    expect(await h.run('refresh')).toBe(0);
    expect(h.out.join('\n')).toContain('risk-lower-available');
    expect(await h.tool('tasks.list')).toMatchObject({ riskClass: 'delete' });
    expect(await h.run('policy', 'accept', 'tasks.list')).toBe(0);
    const toolId = (await h.tool('tasks.list')).toolId;
    expect((await h.policy()).acceptedRisk).toEqual({ 'GET /api/tasks': { riskClass: 'safe-read', toolId } });
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.list')).toMatchObject({ riskClass: 'safe-read', requiresApproval: false });
  }, 180_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/policy.test.ts --maxWorkers=4`
Expected: FAIL — `tools policy` is an unknown subcommand, so every case exits 2. `Test Files  1 failed (1)`, `Tests  4 failed (4)`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/format.ts`, replace:

```ts
  return lines.join('\n');
}

function confirmationLabel(entry: ToolStatusEntry): string {
  if (!entry.confirmation) return 'runs directly';
  if (entry.platformMayRelax) return 'asks first, Platform may relax';
  if (entry.confirmationOrigin === 'local-policy' && riskTier(entry.riskClass) <= 2) {
```

with:

```ts
  return lines.join('\n');
}

/** The confirmation label `tools status` and `tools policy show` share (D16). */
export function confirmationLabel(
  entry: Pick<ToolStatusEntry, 'confirmation' | 'confirmationOrigin' | 'platformMayRelax' | 'riskClass'>,
): string {
  if (!entry.confirmation) return 'runs directly';
  if (entry.platformMayRelax) return 'asks first, Platform may relax';
  if (entry.confirmationOrigin === 'local-policy' && riskTier(entry.riskClass) <= 2) {
```

In `src/cli/commands/tools/format.ts`, replace:

```ts
    lines.push(
      '',
      'A Platform owner or admin can switch off a confirmation marked "Platform may relax" for a connected app.',
      'To keep one, set "requiresApproval": true for the tool in .glirastes/tool-policy.json.',
    );
  }
  return lines.join('\n');
```

with:

```ts
    lines.push(
      '',
      'A Platform owner or admin can switch off a confirmation marked "Platform may relax" for a connected app.',
      'To keep one, run glirastes tools policy confirm <tool>; it writes "requiresApproval": true to .glirastes/tool-policy.json.',
    );
  }
  return lines.join('\n');
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
import { runToolsDescribe } from './describe.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';
```

with:

```ts
import { runToolsDescribe } from './describe.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { POLICY_USAGE, runToolsPolicy } from './policy.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  '         print descriptions, schemas, synonyms and examples to write as a work list for your coding agent',
  '       glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]',
  '         check that every example sentence finds its tool (no model, CI-ready)',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

with:

```ts
  '         print descriptions, schemas, synonyms and examples to write as a work list for your coding agent',
  '       glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]',
  '         check that every example sentence finds its tool (no model, CI-ready)',
  '       glirastes tools policy <show|disable|enable|confirm|relax|raise|roles|describe|exclude|include|accept|reset> ...',
  '         change the local tool policy (glirastes tools policy for details)',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
        return await runToolsDescribe(rest, io);
      case 'eval':
        return await runToolsEval(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ToolsUsageError) {
      io.error(`${error.message}\n${TOOLS_USAGE}`);
      return 2;
    }
    if (error instanceof ToolsPipelineFailure) {
```

with:

```ts
        return await runToolsDescribe(rest, io);
      case 'eval':
        return await runToolsEval(rest, io);
      case 'policy':
        return await runToolsPolicy(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ToolsUsageError) {
      io.error(`${error.message}\n${subcommand === 'policy' ? POLICY_USAGE : TOOLS_USAGE}`);
      return 2;
    }
    if (error instanceof ToolsPipelineFailure) {
```

Create `src/cli/commands/tools/policy.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, compareCodeUnits } from '../../../codegen/tools/canonical.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { AppSetupArtifactSchema, ToolRiskClassSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { parseExcludePattern } from '../../../contracts/tool-exclude-pattern.js';
import {
  platformMayRelaxConfirmation,
  resolveToolPolicy,
  riskTier,
  ToolPolicyFileSchema,
  type ToolPolicyDefaults,
  type ToolPolicyEntry,
  type ToolPolicyFile,
} from '../../../contracts/tool-policy.js';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';
import { writeArtifactSetAtomically } from '../atomic-artifact-write.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from './args.js';
import { confirmationLabel, type ToolsIo } from './format.js';
import { readToolOutput } from './status.js';

/**
 * `glirastes tools policy` (spec 4.2, 4.5): the developer's local overrides
 * in `.glirastes/tool-policy.json`. Every edit is checked by the same
 * `resolveToolPolicy` the generator uses before it is written, so the CLI
 * never writes a policy that refresh would refuse. Agents never run it.
 */
export const POLICY_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  show: { flags: ['--json'], values: ['--root'], positionals: 1 },
  disable: { flags: [], values: ['--root', '--reason'], positionals: 1 },
  enable: { flags: [], values: ['--root'], positionals: 1 },
  confirm: { flags: [], values: ['--root', '--reason'], positionals: 1 },
  relax: { flags: ['--yes'], values: ['--root', '--reason'], positionals: 1 },
  raise: { flags: [], values: ['--root', '--reason'], positionals: 2 },
  roles: { flags: [], values: ['--root', '--reason'], positionals: 2 },
  describe: { flags: [], values: ['--root'], positionals: 2 },
  exclude: { flags: [], values: ['--root', '--reason'], positionals: 1 },
  include: { flags: [], values: ['--root'], positionals: 1 },
  accept: { flags: [], values: ['--root'], positionals: 1 },
  reset: { flags: [], values: ['--root'], positionals: 1 },
};

export const POLICY_USAGE = [
  'Usage: glirastes tools policy show [<tool>] [--json]',
  '       glirastes tools policy disable|enable|confirm <tool> [--reason <text>]',
  '       glirastes tools policy relax <tool> --yes [--reason <text>]   (write tools only; delete, financial and external always confirm)',
  '       glirastes tools policy raise <tool> <safe-read|read-sensitive|write|delete|financial|external> [--reason <text>]',
  '       glirastes tools policy roles <tool> <role,role|-> [--reason <text>]',
  '       glirastes tools policy describe <tool> <text|->',
  '       glirastes tools policy exclude "<METHOD|PAGE|*> /path/**" --reason <text>',
  '       glirastes tools policy include "<pattern>"',
  '       glirastes tools policy accept <tool>    (adopt a lower risk the code now implies)',
  '       glirastes tools policy reset <tool>     (remove every local entry of the tool)',
].join('\n');

interface ToolRef {
  toolId: string;
  stableKey: string;
  name: string;
  route: string;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  confirmationOrigin: 'code-default' | 'local-policy' | null;
  platformMayRelax: boolean;
  enabled: boolean;
  needsAttention: boolean;
  defaults: ToolPolicyDefaults;
}

async function readPolicy(root: string): Promise<ToolPolicyFile> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, TOOLS_PATHS.policy), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ToolPolicyFileSchema.parse({ schemaVersion: 1 });
    }
    throw error;
  }
  let parsed: ReturnType<typeof ToolPolicyFileSchema.safeParse> | undefined;
  try {
    parsed = ToolPolicyFileSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    throw new FoundationDiagnosticError({
      code: 'E-POLICY-001',
      operation: 'tools.policy',
      message: 'tool-policy.json is not valid; fix it by hand before changing it with the CLI.',
      remediation: 'repair-tool-policy-file',
      path: TOOLS_PATHS.policy,
    });
  }
  return parsed.data;
}

/** Stable keys and entries sorted, exclusions in the order they were added. */
function renderPolicy(file: ToolPolicyFile): string {
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  return canonicalJson({
    schemaVersion: 1,
    tools: sorted(file.tools),
    exclude: file.exclude,
    acceptedRisk: sorted(file.acceptedRisk),
  });
}

async function writePolicy(root: string, file: ToolPolicyFile): Promise<void> {
  const checked = ToolPolicyFileSchema.safeParse(file);
  if (!checked.success) {
    const field = checked.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new ToolsUsageError(`The change would make tool-policy.json invalid${field ? ` at ${field}` : ''}; nothing was written.`);
  }
  await writeArtifactSetAtomically([{ path: resolve(root, TOOLS_PATHS.policy), content: renderPolicy(checked.data) }]);
}

async function readTools(root: string): Promise<ToolRef[]> {
  const artifact = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema, 'tools.policy');
  const contracts = await readToolOutput(root, TOOLS_PATHS.contracts, ToolContractsFileSchema, 'tools.policy');
  const byId = new Map(contracts.tools.map((entry) => [entry.toolId, entry] as const));
  return artifact.tools.flatMap((tool) => {
    const entry = byId.get(tool.toolId);
    if (!entry) return [];
    const confirmationOrigin = tool.provenance?.policyOrigin?.requiresApproval ?? null;
    return [{
      toolId: tool.toolId,
      stableKey: entry.stableKey,
      name: tool.name,
      route: tool.executionKind === 'endpoint' ? `${tool.method} ${tool.path}` : `UI ${tool.actionBindingRef}`,
      riskClass: tool.riskClass,
      requiresApproval: tool.requiresApproval,
      confirmationOrigin,
      platformMayRelax: tool.requiresApproval
        && platformMayRelaxConfirmation(tool.riskClass, confirmationOrigin ?? undefined),
      enabled: tool.enabled,
      needsAttention: tool.operationGroup === 'needs_attention',
      defaults: entry.defaults,
    }];
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
}

function findTool(tools: ReadonlyArray<ToolRef>, name: string | undefined): ToolRef {
  if (!name) throw new ToolsUsageError('Name the tool as glirastes tools status prints it.');
  const tool = tools.find((candidate) => candidate.name === name || candidate.stableKey === name);
  if (!tool) throw new ToolsUsageError(`Unknown tool ${name}; glirastes tools status lists the names.`);
  return tool;
}

/** Refuses an entry the generator would refuse, before anything is written. */
function assertResolvable(tool: ToolRef, entry: ToolPolicyEntry, file: ToolPolicyFile): void {
  const accepted = file.acceptedRisk[tool.stableKey];
  const resolved = resolveToolPolicy({
    toolId: tool.toolId,
    defaults: tool.defaults,
    codeEnabled: !tool.needsAttention,
    local: entry,
    ...(accepted ? { acceptedRisk: accepted } : {}),
    previousEffectiveRiskClass: tool.riskClass,
  });
  const error = resolved.errors[0];
  if (error) {
    throw new ToolsUsageError(error.reason === 'tier-3-always-requires-approval'
      ? `${tool.name} is ${tool.riskClass}: delete, financial and external tools always ask first.`
      : `tool-policy.json would be refused (${error.code} ${error.field}: ${error.reason}); nothing was written.`);
  }
}

function withReason(entry: ToolPolicyEntry, reason: string | undefined): ToolPolicyEntry {
  return reason === undefined ? entry : { ...entry, reason };
}

function compact(entry: ToolPolicyEntry): ToolPolicyEntry | undefined {
  const kept = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as ToolPolicyEntry;
  const meaningful = Object.keys(kept).filter((key) => key !== 'reason');
  return meaningful.length > 0 ? kept : undefined;
}

function formatShow(tools: ReadonlyArray<ToolRef>, file: ToolPolicyFile): string {
  const lines = ['Tool policy (effective after the last refresh; local entries from .glirastes/tool-policy.json):'];
  for (const tool of tools) {
    const local = file.tools[tool.stableKey];
    const state = tool.needsAttention ? 'needs attention' : tool.enabled ? 'active' : 'disabled';
    const confirmation = confirmationLabel({ ...tool, confirmation: tool.requiresApproval });
    lines.push(`  ${tool.name}  ${tool.route}  ${tool.riskClass}, ${confirmation}, ${state}`
      + `  (code: ${tool.defaults.riskClass}${tool.defaults.requiresApproval ? ', asks first' : ''})`);
    if (local) lines.push(`      local: ${JSON.stringify(local)}`);
    const accepted = file.acceptedRisk[tool.stableKey];
    if (accepted) lines.push(`      accepted risk: ${accepted.riskClass}`);
  }
  for (const exclusion of file.exclude) lines.push(`  excluded: ${exclusion.match}  (${exclusion.reason})`);
  return lines.join('\n');
}

export async function runToolsPolicy(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const [subcommand, ...rest] = argv;
  const spec = subcommand !== undefined && Object.hasOwn(POLICY_SUBCOMMANDS, subcommand) ? POLICY_SUBCOMMANDS[subcommand] : undefined;
  if (!spec || !subcommand) throw new ToolsUsageError('Choose a tools policy subcommand.');
  const args = parseToolArgs(rest, spec);
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const reason = args.values.get('--reason');
  const [first, second] = args.positionals;
  const file = await readPolicy(root);
  const done = async (next: ToolPolicyFile, message: string): Promise<number> => {
    await writePolicy(root, next);
    io.log(`Updated ${TOOLS_PATHS.policy}: ${message}. Run glirastes tools refresh to apply it.`);
    return 0;
  };

  if (subcommand === 'exclude' || subcommand === 'include') {
    if (!first || !parseExcludePattern(first)) {
      throw new ToolsUsageError('Write the pattern as "<METHOD|PAGE|*> /path/**", e.g. "POST /api/internal/**".');
    }
    if (subcommand === 'exclude') {
      if (!reason) throw new ToolsUsageError('Say why with --reason; the reason is part of the reviewed policy.');
      if (file.exclude.some((entry) => entry.match === first)) throw new ToolsUsageError(`${first} is already excluded.`);
      return done({ ...file, exclude: [...file.exclude, { match: first, reason }] }, `${first} is excluded`);
    }
    if (!file.exclude.some((entry) => entry.match === first)) {
      throw new ToolsUsageError(`No exclude entry matches ${first} exactly; glirastes tools policy show lists them.`);
    }
    return done({ ...file, exclude: file.exclude.filter((entry) => entry.match !== first) }, `${first} is included again`);
  }

  if (subcommand === 'reset' && first && (Object.hasOwn(file.tools, first) || Object.hasOwn(file.acceptedRisk, first))) {
    // Orphaned keys have no tool any more; reset still removes them.
    const { [first]: _tool, ...tools } = file.tools;
    const { [first]: _risk, ...acceptedRisk } = file.acceptedRisk;
    return done({ ...file, tools, acceptedRisk }, `every local entry of ${first} is removed`);
  }

  const tools = await readTools(root);
  if (subcommand === 'show') {
    const selected = first ? [findTool(tools, first)] : tools;
    if (args.flags.has('--json')) {
      io.log(JSON.stringify({
        schemaVersion: 1,
        tools: selected.map((tool) => ({
          name: tool.name,
          stableKey: tool.stableKey,
          route: tool.route,
          effective: {
            riskClass: tool.riskClass,
            requiresApproval: tool.requiresApproval,
            confirmationOrigin: tool.confirmationOrigin,
            platformMayRelax: tool.platformMayRelax,
            enabled: tool.enabled,
          },
          code: { riskClass: tool.defaults.riskClass, requiresApproval: tool.defaults.requiresApproval },
          local: file.tools[tool.stableKey] ?? null,
          acceptedRisk: file.acceptedRisk[tool.stableKey] ?? null,
        })),
        exclude: file.exclude,
      }));
    } else {
      io.log(formatShow(selected, file));
    }
    return 0;
  }

  const tool = findTool(tools, first);
  const current: ToolPolicyEntry = file.tools[tool.stableKey] ?? {};
  const write = async (next: ToolPolicyEntry | undefined, message: string): Promise<number> => {
    const entry = next ? compact(next) : undefined;
    if (entry) assertResolvable(tool, entry, file);
    const { [tool.stableKey]: _previous, ...others } = file.tools;
    return done({ ...file, tools: entry ? { ...others, [tool.stableKey]: entry } : others }, message);
  };

  switch (subcommand) {
    case 'disable':
      return write(withReason({ ...current, enabled: false }, reason), `${tool.name} is disabled`);
    case 'enable': {
      if (current.enabled !== false) {
        throw new ToolsUsageError(`${tool.name} has no local disable; enable only removes one, the code decides whether a tool can run.`);
      }
      return write({ ...current, enabled: undefined }, `${tool.name} is no longer disabled locally`);
    }
    case 'confirm':
      // An explicit `true` is a local lock (D16): the report names it
      // local-policy, so a connected Platform never relaxes it.
      return write(withReason({ ...current, requiresApproval: true, pin: undefined }, reason), riskTier(tool.riskClass) <= 2
        ? `${tool.name} asks before it runs, and a connected Platform can no longer switch that off`
          + ` (glirastes tools policy reset ${tool.name} lifts the lock)`
        : `${tool.name} asks before it runs`);
    case 'relax': {
      if (!args.flags.has('--yes')) {
        throw new ToolsUsageError(`Relaxing lets ${tool.name} run without asking; confirm the review with --yes.`);
      }
      if (riskTier(tool.riskClass) >= 3) {
        throw new ToolsUsageError(`${tool.name} is ${tool.riskClass}: delete, financial and external tools always ask first.`);
      }
      if (!tool.requiresApproval) throw new ToolsUsageError(`${tool.name} already runs without asking.`);
      return write(withReason({
        ...current,
        requiresApproval: false,
        pin: { toolId: tool.toolId, atRiskClass: tool.riskClass },
      }, reason), `${tool.name} runs without asking while it stays ${tool.riskClass} (pinned)`);
    }
    case 'raise': {
      const parsed = ToolRiskClassSchema.exclude(['unknown']).safeParse(second);
      if (!parsed.success) throw new ToolsUsageError('Name a risk class: safe-read, read-sensitive, write, delete, financial or external.');
      if (riskTier(parsed.data) <= riskTier(tool.riskClass)) {
        throw new ToolsUsageError(`${tool.name} is already ${tool.riskClass}; the policy can only raise the risk. A lower code risk is adopted with glirastes tools policy accept.`);
      }
      return write(withReason({ ...current, riskClass: parsed.data }, reason), `${tool.name} is ${parsed.data}`);
    }
    case 'roles': {
      if (!second) throw new ToolsUsageError('Name the roles, comma-separated, or - to remove the restriction.');
      const roles = second === '-' ? [] : [...new Set(second.split(',').map((role) => role.trim()).filter(Boolean))].sort(compareCodeUnits);
      if (second !== '-' && roles.length === 0) throw new ToolsUsageError('Name at least one role, or - to remove the restriction.');
      return write(withReason({ ...current, allowedRoles: roles.length > 0 ? roles : undefined }, reason),
        roles.length > 0 ? `${tool.name} is limited to ${roles.join(', ')}` : `${tool.name} has no local role limit`);
    }
    case 'describe': {
      if (!second) throw new ToolsUsageError('Give the description, or - to remove the local one.');
      return write({ ...current, description: second === '-' ? undefined : second },
        second === '-' ? `${tool.name} uses the description from the code` : `${tool.name} has a local description`);
    }
    case 'accept': {
      const accepted = file.acceptedRisk[tool.stableKey];
      const resolved = resolveToolPolicy({
        toolId: tool.toolId,
        defaults: tool.defaults,
        codeEnabled: !tool.needsAttention,
        ...(file.tools[tool.stableKey] ? { local: file.tools[tool.stableKey] } : {}),
        ...(accepted ? { acceptedRisk: accepted } : {}),
        previousEffectiveRiskClass: tool.riskClass,
      });
      const lower = resolved.warnings.find((warning) => warning.code === 'risk-lower-available');
      if (!lower?.riskClass) {
        throw new ToolsUsageError(`${tool.name} has no lower risk to accept. Run glirastes tools refresh after the code change first.`);
      }
      return done({
        ...file,
        acceptedRisk: { ...file.acceptedRisk, [tool.stableKey]: { riskClass: lower.riskClass, toolId: tool.toolId } },
      }, `${tool.name} may drop from ${tool.riskClass} to ${lower.riskClass}`);
    }
    case 'reset': {
      if (!Object.hasOwn(file.tools, tool.stableKey) && !Object.hasOwn(file.acceptedRisk, tool.stableKey)) {
        throw new ToolsUsageError(`${tool.name} has no local entry to reset.`);
      }
      const { [tool.stableKey]: _tool, ...others } = file.tools;
      const { [tool.stableKey]: _risk, ...acceptedRisk } = file.acceptedRisk;
      return done({ ...file, tools: others, acceptedRisk }, `every local entry of ${tool.name} is removed`);
    }
    default:
      throw new ToolsUsageError('Choose a tools policy subcommand.');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/policy.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/tools --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  4 passed (4)`; `src/cli/commands/tools` reports `Test Files  3 passed (3)`, `Tests  31 passed (31)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/format.ts src/cli/commands/tools/index.ts src/cli/commands/tools/policy.test.ts src/cli/commands/tools/policy.ts
git commit -m "feat(cli): edit the local tool policy with tools policy"
```

### Task 14: `glirastes tools verify` and the model-free guard

**Files:**
- Create: `src/cli/commands/tools/verify.ts`
- Modify: `src/cli/commands/tools/index.ts`, `src/cli/index.ts` (top-level usage)
- Test: `src/cli/commands/tools/verify.test.ts` (Create), `src/public-subpaths.test.ts` (the model-free guard covers every new CLI and codegen file)

**Interfaces:**
- Consumes: Task 1 `ResolutionEntrySchema`, `resolutionLockDigest`; Task 3 `SemanticsEntrySchema`, `SEMANTICS_FIELDS`, `isAgenticSemantics`; Task 1 `lockDigest`; the Task 4 tool view (to refuse rejected or stale entries).
- Produces: `glirastes tools verify <tool>...|--all [--root <dir>]` (spec 4.2; Citadel drawer remediation "Beschreibung kommt vom Agenten … `glirastes tools verify <tool>`"): an accepted, current agent resolution becomes `origin: 'human'` with `locked` = its digest (the `model` stays); every agent field of the tool's semantics entry becomes `human` with a `locked` digest of the parsed value, and the `agent` block goes. Rejected or stale entries and tools without agent entries exit 2. `VERIFY_ARGS` is exported for Task 19.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/commands/tools/verify.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolReportFileSchema } from '../../../codegen/tools/artifact.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { runToolsCommand } from './index.js';

afterEach(removeAppFixtures);

const ROUTE = 'declare function getSession(): Promise<unknown>;\n'
  + 'export async function GET(request: Request) { await getSession();\n'
  + "  const { searchParams } = new URL(request.url); return Response.json({ status: searchParams.get('status') }); }\n";

describe('glirastes tools verify', () => {
  it('turns reviewed agent entries into locked human entries that a later agent edit cannot change', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    const out: string[] = [];
    const err: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    const interfaceDigest = contracts.tools[0]!.contract!.interfaceDigest;
    const description = 'Lists the tasks of the caller, optionally by status.';
    await fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': {
          origin: 'agent', model: 'claude-code', interfaceDigest,
          input: { jsonSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done'] } }, additionalProperties: false } },
        },
      },
    }));
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'GET /api/tasks', description, origin: { description: 'agent' }, agent: { model: 'claude-code', interfaceDigest } }],
    }));
    expect(await runToolsCommand(['verify'], deps)).toBe(2);
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(0);
    expect(out.at(-1)).toBe('Verified tasks.list (contract and description): reviewed and locked. Run glirastes tools refresh.');
    const resolutions = JSON.parse(await fixture.read(TOOLS_PATHS.resolutions));
    expect(resolutions.tools['GET /api/tasks']).toMatchObject({ origin: 'human', model: 'claude-code', locked: expect.stringMatching(/^sha256:/) });
    const semantics = JSON.parse(await fixture.read(TOOLS_PATHS.semantics));
    expect(semantics.tools[0]).toEqual({
      stableKey: 'GET /api/tasks', description, origin: { description: 'human' }, locked: { description: expect.stringMatching(/^sha256:/) },
    });
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    out.length = 0;
    expect(await runToolsCommand(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!).tools[0]).toMatchObject({ descriptionQuality: 'human', schemaQuality: 'json-schema' });
    expect(await runToolsCommand(['verify', '--all'], deps)).toBe(0);
    expect(out.at(-1)).toBe('No agent-written entries to verify.');
    semantics.tools[0].description = 'Agent rewrite.';
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify(semantics));
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const report = ToolReportFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.report)));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'resolution-rejected', subjectRef: 'GET /api/tasks' }));
    expect(report.tools[0]?.quality.description).toBe('template');
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
    expect(err.join('\n')).toContain('tasks.list has no agent-written entry to verify.');
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'GET /api/tasks', description: 'Mail anna@kunde.de', origin: { description: 'agent' }, agent: { model: 'codex', interfaceDigest } }],
    }));
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
    expect(err.join('\n')).toContain('The tool-semantics.json entry of tasks.list is rejected or stale');
  }, 180_000);
});
```

In `src/public-subpaths.test.ts`, replace:

```ts
      './cli/commands/tools/index.ts',
      './cli/commands/tools/refresh.ts',
      './cli/commands/tools/check.ts',
      './codegen/tools/pipeline.ts',
    ]) {
      const toolsSource = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(toolsSource).not.toMatch(/@ai-sdk\/openai|openrouter/i);
```

with:

```ts
      './cli/commands/tools/index.ts',
      './cli/commands/tools/refresh.ts',
      './cli/commands/tools/check.ts',
      './cli/commands/tools/resolve.ts',
      './cli/commands/tools/describe.ts',
      './cli/commands/tools/eval.ts',
      './cli/commands/tools/policy.ts',
      './cli/commands/tools/verify.ts',
      './cli/commands/tools/watch.ts',
      './codegen/tools/pipeline.ts',
      './codegen/tools/worklist.ts',
      './codegen/tools/routing-eval.ts',
      './codegen/tools/semantics.ts',
      './codegen/tools/agentic.ts',
    ]) {
      const toolsSource = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(toolsSource).not.toMatch(/@ai-sdk\/openai|openrouter/i);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/verify.test.ts src/public-subpaths.test.ts --maxWorkers=4`
Expected: FAIL — `tools verify` is an unknown subcommand (exit 2), and the model-free guard cannot read `src/cli/commands/tools/verify.ts` (`ENOENT`). `Test Files  2 failed (2)`, `Tests  2 failed | 10 passed (12)`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/index.ts`, replace:

```ts
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';

export interface ToolsCommandDependencies {
  cwd?: string;
```

with:

```ts
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';
import { runToolsVerify } from './verify.js';

export interface ToolsCommandDependencies {
  cwd?: string;
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  '         check that every example sentence finds its tool (no model, CI-ready)',
  '       glirastes tools policy <show|disable|enable|confirm|relax|raise|roles|describe|exclude|include|accept|reset> ...',
  '         change the local tool policy (glirastes tools policy for details)',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

with:

```ts
  '         check that every example sentence finds its tool (no model, CI-ready)',
  '       glirastes tools policy <show|disable|enable|confirm|relax|raise|roles|describe|exclude|include|accept|reset> ...',
  '         change the local tool policy (glirastes tools policy for details)',
  '       glirastes tools verify <tool>...|--all [--root <dir>]',
  '         confirm agent-written contracts and descriptions after review',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
        return await runToolsEval(rest, io);
      case 'policy':
        return await runToolsPolicy(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
```

with:

```ts
        return await runToolsEval(rest, io);
      case 'policy':
        return await runToolsPolicy(rest, io);
      case 'verify':
        return await runToolsVerify(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
```

Create `src/cli/commands/tools/verify.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lockDigest } from '../../../codegen/tools/agentic.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import type { ToolsPipelineTool } from '../../../codegen/tools/pipeline.js';
import { ResolutionEntrySchema, resolutionLockDigest } from '../../../codegen/tools/resolutions.js';
import { isAgenticSemantics, SEMANTICS_FIELDS, SemanticsEntrySchema } from '../../../codegen/tools/semantics.js';
import { writeArtifactSetAtomically } from '../atomic-artifact-write.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';

export const VERIFY_ARGS = { flags: ['--all'], values: ['--root'], positionals: 500 } as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(root: string, path: string): Promise<JsonRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(resolve(root, path), 'utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rejectedIn(tool: ToolsPipelineTool, file: string): boolean {
  return tool.findings.some((finding) => finding.code === 'resolution-rejected' && finding.message.includes(file));
}

/** Pins a reviewed agent resolution: origin human, `locked` = digest of the entry. */
function verifyResolution(raw: unknown): JsonRecord | undefined {
  const parsed = ResolutionEntrySchema.safeParse(raw);
  if (!parsed.success || parsed.data.origin !== 'agent') return undefined;
  const reviewed = { ...parsed.data, origin: 'human' as const };
  return { ...(raw as JsonRecord), origin: 'human', locked: resolutionLockDigest(reviewed) };
}

/** Turns every agent field of a semantics entry into a reviewed, locked human field. */
function verifySemantics(entry: JsonRecord): JsonRecord | undefined {
  const parsed = SemanticsEntrySchema.safeParse(entry);
  if (!parsed.success || !isAgenticSemantics(entry)) return undefined;
  const origin = { ...(isRecord(entry.origin) ? entry.origin : {}) };
  const locked = { ...(isRecord(entry.locked) ? entry.locked : {}) };
  for (const field of SEMANTICS_FIELDS) {
    if (origin[field] !== 'agent') continue;
    origin[field] = 'human';
    // The generator compares the parsed value, so the digest is taken from it.
    locked[field] = lockDigest(parsed.data[field] ?? null);
  }
  const { agent: _agent, ...rest } = entry;
  return { ...rest, origin, locked };
}

/**
 * `glirastes tools verify <tool|--all>` (spec 4.2): the developer confirms
 * agent-written contracts and descriptions after review. They become human
 * entries pinned by digest; a later agent edit is rejected until the next
 * review. Only entries the generator accepts can be verified.
 */
export async function runToolsVerify(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, VERIFY_ARGS);
  if (args.flags.has('--all') === (args.positionals.length > 0)) {
    throw new ToolsUsageError('Name the tools to verify, or use --all for every tool an agent described.');
  }
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  const tools = result.tools ?? [];
  const resolutions = await readJson(root, TOOLS_PATHS.resolutions);
  const semantics = await readJson(root, TOOLS_PATHS.semantics);
  const resolutionTools = isRecord(resolutions?.tools) ? { ...resolutions.tools } : {};
  const semanticsTools = Array.isArray(semantics?.tools) ? [...semantics.tools] : [];
  const semanticsIndex = (tool: ToolsPipelineTool) => {
    const byKey = semanticsTools.findIndex((entry) => isRecord(entry) && entry.stableKey === tool.stableKey);
    return byKey >= 0 ? byKey : semanticsTools.findIndex((entry) => isRecord(entry) && entry.name === tool.definitionId);
  };
  const selected = args.flags.has('--all')
    ? tools.filter((tool) => verifyResolution(resolutionTools[tool.stableKey]) !== undefined
      || (semanticsIndex(tool) >= 0 && isAgenticSemantics(semanticsTools[semanticsIndex(tool)])))
    : args.positionals.map((name) => {
      const tool = tools.find((candidate) => candidate.definitionId === name || candidate.stableKey === name);
      if (!tool) throw new ToolsUsageError(`Unknown tool ${name}; glirastes tools status lists the names.`);
      return tool;
    });
  const verified: string[] = [];
  for (const tool of selected) {
    const parts: string[] = [];
    const resolution = verifyResolution(resolutionTools[tool.stableKey]);
    if (resolution) {
      if (rejectedIn(tool, 'tool-resolutions.json') || tool.findings.some((finding) => finding.code === 'enrichment-stale')) {
        throw new ToolsUsageError(`The tool-resolutions.json entry of ${tool.definitionId} is rejected or stale; fix it and refresh before verifying.`);
      }
      resolutionTools[tool.stableKey] = resolution;
      parts.push('contract');
    }
    const index = semanticsIndex(tool);
    const entry = index >= 0 && isRecord(semanticsTools[index]) ? verifySemantics(semanticsTools[index] as JsonRecord) : undefined;
    if (entry) {
      if (tool.semantics.rejected || tool.semantics.stale) {
        throw new ToolsUsageError(`The tool-semantics.json entry of ${tool.definitionId} is rejected or stale; fix it and refresh before verifying.`);
      }
      semanticsTools[index] = entry;
      parts.push('description');
    }
    if (parts.length === 0) throw new ToolsUsageError(`${tool.definitionId} has no agent-written entry to verify.`);
    verified.push(`${tool.definitionId} (${parts.join(' and ')})`);
  }
  const writes = [
    ...(resolutions ? [{ path: resolve(root, TOOLS_PATHS.resolutions), content: render({ ...resolutions, tools: resolutionTools }) }] : []),
    ...(semantics ? [{ path: resolve(root, TOOLS_PATHS.semantics), content: render({ ...semantics, tools: semanticsTools }) }] : []),
  ];
  if (verified.length > 0) await writeArtifactSetAtomically(writes);
  io.log(verified.length > 0
    ? `Verified ${verified.join(', ')}: reviewed and locked. Run glirastes tools refresh.`
    : 'No agent-written entries to verify.');
  return 0;
}
```

In `src/cli/index.ts`, replace:

```ts
      + '       glirastes validate [--root] [--app-id]\n'
      + '       glirastes doctor [--root] [--managed] [--json] [--verbose]\n'
      + '       glirastes build [--root] [--app-id] [--output]\n'
      + '       glirastes tools <refresh|check|status> [options]\n'
      + '         derive chat tools from the code, verify them or show them\n',
    );
  }
  return { command, rest };
```

with:

```ts
      + '       glirastes validate [--root] [--app-id]\n'
      + '       glirastes doctor [--root] [--managed] [--json] [--verbose]\n'
      + '       glirastes build [--root] [--app-id] [--output]\n'
      + '       glirastes tools <refresh|check|status|resolve|describe|eval|policy|verify> [options]\n'
      + '         derive chat tools from the code, check them, show them and print agent work lists\n',
    );
  }
  return { command, rest };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/verify.test.ts src/public-subpaths.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  12 passed (12)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/index.ts src/cli/commands/tools/verify.test.ts src/cli/commands/tools/verify.ts src/cli/index.ts src/public-subpaths.test.ts
git commit -m "feat(cli): confirm reviewed agent entries with tools verify"
```

### Task 15: The `tool_contract_rejected` event in the metric contract

**Files:**
- Modify: `src/contracts/events.ts` (`TOOL_CONTRACT_REJECTED_STATUSES`, `ToolContractRejectedEventSchema`, `RuntimeMetricEventSchema`, one-type batches), `src/contracts/index.ts` (exports)
- Test: `src/contracts/__vectors__/runtime-metric-event.v2.json` (new `toolContractRejected` section: 4 valid, 12 invalid), `src/contracts/__tests__/runtime-metric-event.test.ts` (new digest, vector tests, union and batch cases)

**Interfaces:**
- Consumes: P09 `TechnicalRuntimeEventV2Schema`, `RUNTIME_METRIC_LABEL_PATTERN`, `findForbiddenPlatformContentPath`; P09 ruling X7 (P05 owns the event in lockstep: union, vectors, digest, sink type).
- Produces: `ToolContractRejectedEventSchema` (strict, content-free; `inputSchemaDigest` in the manifest digest alphabet, `httpStatus` 400 or 422), `type ToolContractRejectedEvent`, `RuntimeMetricEventSchema = z.discriminatedUnion('eventType', [TechnicalRuntimeEventV2Schema, ToolContractRejectedEventSchema])`, `type RuntimeMetricEvent`, `TOOL_CONTRACT_REJECTED_STATUSES`; `TechnicalRuntimeEventBatchSchema.events` is the union with the refinement "one event type per batch". The vector file's sha256 changes from `73c5cf4f…ab17d` to `114521143ea6d65564a2b4dc70318a7d30ef8cbc2cfdb4f87e7101b786558d17`; the Platform's copy and pinned digest move with its follow-up row (Self-Review), not here.

- [ ] **Step 1: Write the failing tests**

In `src/contracts/__tests__/runtime-metric-event.test.ts`, replace:

```ts
import {
  RUNTIME_METRIC_MAX_BATCH,
  RUNTIME_METRIC_MAX_TOOLS,
  TechnicalRuntimeEventBatchSchema,
  TechnicalRuntimeEventSchema,
  TechnicalRuntimeEventV2Schema,
} from '../index.js';

interface MetricEventVectors {
  schemaVersion: 2;
  base: Record<string, unknown>;
  valid: Array<{ name: string; patch: Record<string, unknown> }>;
  invalid: Array<{ name: string; patch: Record<string, unknown> }>;
}

/**
```

with:

```ts
import {
  RUNTIME_METRIC_MAX_BATCH,
  RUNTIME_METRIC_MAX_TOOLS,
  RuntimeMetricEventSchema,
  TechnicalRuntimeEventBatchSchema,
  TechnicalRuntimeEventSchema,
  TechnicalRuntimeEventV2Schema,
  ToolContractRejectedEventSchema,
} from '../index.js';

interface VectorSet {
  base: Record<string, unknown>;
  valid: Array<{ name: string; patch: Record<string, unknown> }>;
  invalid: Array<{ name: string; patch: Record<string, unknown> }>;
}

interface MetricEventVectors extends VectorSet {
  schemaVersion: 2;
  toolContractRejected: VectorSet;
}

/**
```

In `src/contracts/__tests__/runtime-metric-event.test.ts`, replace:

```ts
 * runtime-metrics/__vectors__/`) and pins the same digest. Changing a vector
 * means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '73c5cf4f8d95e8968e11dd6cf921e8b88d387b7d75f056aa91e4bc2b614ab17d';
const raw = readFileSync(
  new URL('../__vectors__/runtime-metric-event.v2.json', import.meta.url),
);
```

with:

```ts
 * runtime-metrics/__vectors__/`) and pins the same digest. Changing a vector
 * means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '114521143ea6d65564a2b4dc70318a7d30ef8cbc2cfdb4f87e7101b786558d17';
const raw = readFileSync(
  new URL('../__vectors__/runtime-metric-event.v2.json', import.meta.url),
);
```

In `src/contracts/__tests__/runtime-metric-event.test.ts`, replace:

```ts
      expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf(patch)).success).toBe(false);
    },
  );
});

describe('TechnicalRuntimeEvent v2 limits', () => {
```

with:

```ts
      expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf(patch)).success).toBe(false);
    },
  );
});

describe('tool_contract_rejected golden vectors (spec 4.7)', () => {
  const set = vectors.toolContractRejected;
  const rejectionOf = (patch: Record<string, unknown>) => ({ ...set.base, ...patch });

  it('names every vector uniquely and covers both outcomes', () => {
    const names = [...set.valid, ...set.invalid].map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    expect(set.valid).toHaveLength(4);
    expect(set.invalid).toHaveLength(12);
  });

  it.each(set.valid.map((vector) => [vector.name, vector.patch] as const))('accepts %s', (_name, patch) => {
    expect(ToolContractRejectedEventSchema.safeParse(rejectionOf(patch)).success).toBe(true);
    expect(RuntimeMetricEventSchema.safeParse(rejectionOf(patch)).success).toBe(true);
  });

  it.each(set.invalid.map((vector) => [vector.name, vector.patch] as const))('rejects %s', (_name, patch) => {
    expect(RuntimeMetricEventSchema.safeParse(rejectionOf(patch)).success).toBe(false);
  });

  it('keeps every turn vector valid in the union and batches one event type at a time', () => {
    for (const vector of vectors.valid) {
      expect(RuntimeMetricEventSchema.safeParse(eventOf(vector.patch)).success).toBe(true);
    }
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [set.base, set.base] }).success).toBe(true);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [vectors.base, set.base] }).success).toBe(false);
  });
});

describe('TechnicalRuntimeEvent v2 limits', () => {
```

In `src/contracts/__vectors__/runtime-metric-event.v2.json`, replace:

```json
      "patch": { "tools": [{ "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 0, "errors": 0 }] }
    },
    { "name": "invalid/unknown-error-code", "patch": { "status": "error", "errorCode": "timeout" } }
  ]
}
```

with:

```json
      "patch": { "tools": [{ "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 0, "errors": 0 }] }
    },
    { "name": "invalid/unknown-error-code", "patch": { "status": "error", "errorCode": "timeout" } }
  ],
  "toolContractRejected": {
    "base": {
      "schemaVersion": 2,
      "eventId": "019fb900-0000-7000-8000-000000000101",
      "eventType": "tool_contract_rejected",
      "occurredAt": "2026-10-05T10:16:02.000Z",
      "appId": "019fb900-0000-7000-8000-0000000000a1",
      "environmentId": "019fb900-0000-7000-8000-0000000000e1",
      "buildId": "git:4f2c9e1",
      "instanceId": "web-1",
      "revisionId": "019fb900-0000-7000-8000-0000000000b1",
      "toolId": "019fb900-0000-7000-8000-0000000000c1",
      "inputSchemaDigest": "sha256:Hk3m0QZrJ8v2bW6cX9fN1pL4sT7uY0aE5dG8iK2oMqA",
      "httpStatus": 400
    },
    "valid": [
      { "name": "valid/bad-request", "patch": {} },
      { "name": "valid/unprocessable-entity", "patch": { "httpStatus": 422 } },
      { "name": "valid/standalone-without-build-or-revision", "patch": { "buildId": null, "revisionId": null } },
      { "name": "valid/base64-schema-digest", "patch": { "inputSchemaDigest": "sha256:Hk3m0QZrJ8v2bW6cX9fN1pL4sT7uY0aE5dG8iK2oMqA=" } }
    ],
    "invalid": [
      { "name": "invalid/server-error", "patch": { "httpStatus": 500 } },
      { "name": "invalid/unauthorized", "patch": { "httpStatus": 401 } },
      { "name": "invalid/status-as-text", "patch": { "httpStatus": "400" } },
      { "name": "invalid/tool-name-instead-of-id", "patch": { "toolId": "tasks.create" } },
      { "name": "invalid/schema-digest-without-prefix", "patch": { "inputSchemaDigest": "Hk3m0QZrJ8v2bW6cX9fN1pL4sT7uY0aE5dG8iK2oMqA" } },
      { "name": "invalid/arguments", "patch": { "arguments": { "title": "Bericht" } } },
      { "name": "invalid/response-body", "patch": { "responseBody": "title is required" } },
      { "name": "invalid/error-message", "patch": { "message": "Expected string, received number" } },
      { "name": "invalid/secret-in-instance-id", "patch": { "instanceId": "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789" } },
      { "name": "invalid/turn-fields", "patch": { "status": "completed" } },
      { "name": "invalid/schema-version-1", "patch": { "schemaVersion": 1 } },
      { "name": "invalid/without-tool", "patch": { "toolId": null } }
    ]
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/runtime-metric-event.test.ts --maxWorkers=4`
Expected: FAIL — `RuntimeMetricEventSchema` and `ToolContractRejectedEventSchema` are not exported (`Cannot read properties of undefined (reading 'safeParse')`) for the 16 new vectors and the union case; the digest pin and the turn vectors already pass, because Step 1 replaced the vector file. `Test Files  1 failed (1)`, `Tests  17 failed | 47 passed (64)`

- [ ] **Step 3: Implement**

In `src/contracts/events.ts`, replace:

```ts
export type RuntimeTurnCost = z.infer<typeof RuntimeTurnCostSchema>;
export type RuntimeTurnToolUsage = z.infer<typeof RuntimeTurnToolUsageSchema>;

/** Body of `POST /v1/runtime/apps/:appId/environments/:environmentId/metrics/events`. */
export const TechnicalRuntimeEventBatchSchema = z.object({
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  events: z.array(TechnicalRuntimeEventV2Schema).min(1).max(RUNTIME_METRIC_MAX_BATCH),
}).strict();

export type TechnicalRuntimeEventBatch = z.infer<typeof TechnicalRuntimeEventBatchSchema>;
```

with:

```ts
export type RuntimeTurnCost = z.infer<typeof RuntimeTurnCostSchema>;
export type RuntimeTurnToolUsage = z.infer<typeof RuntimeTurnToolUsageSchema>;

/** Statuses of an endpoint that refused a call its tool schema accepted. */
export const TOOL_CONTRACT_REJECTED_STATUSES = [400, 422] as const;

/**
 * An endpoint refused a call that passed the tool's input schema (spec 4.7):
 * the contract the model saw is wrong, so the tool belongs on the next work
 * list or managed job. Content-free: tool, schema version and status, never
 * arguments, response or message.
 */
export const ToolContractRejectedEventSchema = z.object({
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  eventId: z.uuid(),
  eventType: z.literal('tool_contract_rejected'),
  occurredAt: z.iso.datetime({ offset: true }),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: metricLabel.nullable(),
  instanceId: metricLabel,
  revisionId: z.uuid().nullable(),
  toolId: z.uuid(),
  /** The manifest's digest of the input schema the call passed (same alphabet as the manifest). */
  inputSchemaDigest: z.string().regex(/^sha256:[A-Za-z0-9+/=_-]{1,88}$/),
  httpStatus: z.union([z.literal(400), z.literal(422)]),
}).strict().superRefine((event, context) => {
  const forbidden = findForbiddenPlatformContentPath(event);
  if (forbidden) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime metric events must not contain content or credentials',
      path: forbidden,
    });
  }
});

export type ToolContractRejectedEvent = z.infer<typeof ToolContractRejectedEventSchema>;

/** Every content-free metric event of the runtime: finished turns and contract rejections. */
export const RuntimeMetricEventSchema = z.discriminatedUnion('eventType', [
  TechnicalRuntimeEventV2Schema,
  ToolContractRejectedEventSchema,
]);

export type RuntimeMetricEvent = z.infer<typeof RuntimeMetricEventSchema>;

/**
 * Body of `POST /v1/runtime/apps/:appId/environments/:environmentId/metrics/events`.
 * One batch carries one event type, so a Platform that does not know a newer
 * type refuses only that batch and keeps receiving turns.
 */
export const TechnicalRuntimeEventBatchSchema = z.object({
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  events: z.array(RuntimeMetricEventSchema).min(1).max(RUNTIME_METRIC_MAX_BATCH),
}).strict().refine((batch) => new Set(batch.events.map((event) => event.eventType)).size === 1, {
  message: 'A batch carries one event type',
  path: ['events'],
});

export type TechnicalRuntimeEventBatch = z.infer<typeof TechnicalRuntimeEventBatchSchema>;
```

In `src/contracts/index.ts`, replace:

```ts
  RuntimeTurnErrorCodeSchema,
  RuntimeTurnStatusSchema,
  RuntimeTurnToolUsageSchema,
  TechnicalRuntimeEventBatchSchema,
  TechnicalRuntimeEventSchema,
  TechnicalRuntimeEventV2Schema,
} from './events.js';
export type {
  RuntimeCostSource,
  RuntimeTurnCost,
  RuntimeTurnErrorCode,
  RuntimeTurnStatus,
```

with:

```ts
  RuntimeTurnErrorCodeSchema,
  RuntimeTurnStatusSchema,
  RuntimeTurnToolUsageSchema,
  RuntimeMetricEventSchema,
  TechnicalRuntimeEventBatchSchema,
  TechnicalRuntimeEventSchema,
  TechnicalRuntimeEventV2Schema,
  TOOL_CONTRACT_REJECTED_STATUSES,
  ToolContractRejectedEventSchema,
} from './events.js';
export type {
  RuntimeCostSource,
  RuntimeMetricEvent,
  ToolContractRejectedEvent,
  RuntimeTurnCost,
  RuntimeTurnErrorCode,
  RuntimeTurnStatus,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/runtime-metric-event.test.ts --maxWorkers=4 && bunx vitest run src/contracts/__tests__/runtime-metric-event.test.ts src/runtime/metrics --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  64 passed (64)`; `src/contracts/__tests__/runtime-metric-event.test.ts src/runtime/metrics` reports `Test Files  4 passed (4)`, `Tests  130 passed (130)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/__tests__/runtime-metric-event.test.ts src/contracts/__vectors__/runtime-metric-event.v2.json src/contracts/events.ts src/contracts/index.ts
git commit -m "feat(contracts): add the content-free tool_contract_rejected event"
```

### Task 16: Report endpoints that refuse schema-valid tool calls

**Files:**
- Modify: `src/runtime/metrics/turn-recorder.ts` (`RuntimeMetricsSink.record(RuntimeMetricEvent)`, `recordToolContractRejected`), `src/runtime/metrics/sink.ts` (one queue per event type), `src/server/core/index.ts` (`EndpointToolContext.onContractRejected`, called on 400/422), `src/server/adapters/nextjs/create-ai-chat-handler.ts` (`contractRejectionReporter` in both endpoint tool contexts)
- Test: `src/server/core/__tests__/contract-rejection.test.ts` (Create), `src/runtime/metrics/turn-recorder.test.ts`, `src/runtime/metrics/sink.test.ts`, `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts` (the collecting sink separates rejections; one handler case)

**Interfaces:**
- Consumes: Task 15 schemas; P09 `createTurnMetricsRecorder`, `createRuntimeMetricsSink`, `metrics` option of `createAiChatHandler`; the pinned turn snapshot's manifest (`toolId`, `inputSchemaDigest` by model-facing name).
- Produces: `TurnMetricsRecorder.recordToolContractRejected(toolName, httpStatus): ToolContractRejectedEvent | undefined` (immediate, never throws, `undefined` for tools outside the snapshot); `RuntimeMetricsSink.record(event: RuntimeMetricEvent)`; the batching sink validates with `RuntimeMetricEventSchema` and sends each event type in its own batches (turns first), so a Platform that refuses the new type drops only those batches (`send-failed`); `EndpointToolContext.onContractRejected?: (rejection: { toolName: string; status: 400 | 422 }) => void`, called by `endpointToolToTool` after a refused call, errors swallowed. Spec 4.7 "Laufzeit". Visibility in `doctor` needs the Platform storage (Self-Review).

- [ ] **Step 1: Write the failing tests**

In `src/runtime/metrics/sink.test.ts`, replace:

```ts
    expect(sink?.identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

with:

```ts
    expect(sink?.identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('tool_contract_rejected in the sink', () => {
  const rejection = (suffix: number) => ({
    schemaVersion: 2 as const,
    eventId: `019fb900-0000-7000-8000-0000000003${suffix.toString().padStart(2, '0')}`,
    eventType: 'tool_contract_rejected' as const,
    occurredAt: '2026-10-05T10:16:02.000Z',
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    buildId: 'git:4f2c9e1',
    instanceId: 'web-1',
    revisionId: null,
    toolId: '019fb900-0000-7000-8000-0000000000c1',
    inputSchemaDigest: 'sha256:Hk3m0QZrJ8v2bW6cX9fN1pL4sT7uY0aE5dG8iK2oMqA',
    httpStatus: 422 as const,
  });

  it('sends rejections in their own batch, so a Platform without them keeps the turns', async () => {
    const calls: Array<{ events: Array<{ eventType: string }> }> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ eventType: string }> };
      calls.push(body);
      return new Response(null, { status: body.events[0]!.eventType === 'turn.finished' ? 202 : 400 });
    }) as typeof globalThis.fetch;
    const { sink, drops } = sinkWith(fetch);
    sink.record(event());
    sink.record(rejection(1));
    sink.record(event());
    sink.record(rejection(2));
    expect(sink.pending).toBe(4);
    await sink.flush();
    expect(calls.map((call) => call.events.map((entry) => entry.eventType))).toEqual([
      ['turn.finished', 'turn.finished'],
      ['tool_contract_rejected', 'tool_contract_rejected'],
    ]);
    expect(drops).toEqual([{ reason: 'send-failed', count: 2 }]);
    expect(sink.pending).toBe(0);
  });

  it('drops a rejection that carries content or names another app', () => {
    const { sink, drops } = sinkWith(recordingFetch().fetch);
    sink.record({ ...rejection(3), arguments: { title: 'x' } } as never);
    sink.record({ ...rejection(4), appId: '019fb900-0000-7000-8000-0000000000a9' });
    expect(drops).toEqual([{ reason: 'invalid', count: 1 }, { reason: 'invalid', count: 1 }]);
    expect(sink.pending).toBe(0);
  });
});
```

In `src/runtime/metrics/turn-recorder.test.ts`, replace:

```ts
    expect(sink.record).toHaveBeenCalledTimes(1);
  });
});
```

with:

```ts
    expect(sink.record).toHaveBeenCalledTimes(1);
  });
});

describe('tool_contract_rejected in the turn recorder', () => {
  it('hands a content-free rejection of a snapshot tool to the sink right away', () => {
    const records: unknown[] = [];
    const { sink } = fakeSink();
    sink.record = (event) => { records.push(event); };
    const recorder = createTurnMetricsRecorder({
      sink, snapshot, startedAtMs: 1_000, now: () => 2_000, createEventId: () => '019fb900-0000-7000-8000-000000000201',
    });
    const event = recorder.recordToolContractRejected('list_tasks', 400);
    expect(event).toEqual({
      schemaVersion: 2,
      eventId: '019fb900-0000-7000-8000-000000000201',
      eventType: 'tool_contract_rejected',
      occurredAt: '1970-01-01T00:00:02.000Z',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      toolId: LIST_TASKS_ID,
      inputSchemaDigest: manifestRevision.tools[0]!.inputSchemaDigest,
      httpStatus: 400,
    });
    expect(records).toEqual([event]);
  });

  it('ignores tools outside the pinned snapshot and survives a failing sink', () => {
    const { sink } = fakeSink();
    sink.record = () => { throw new Error('sink down'); };
    const recorder = createTurnMetricsRecorder({ sink, snapshot, startedAtMs: 1_000 });
    expect(recorder.recordToolContractRejected('unknown_tool', 422)).toBeUndefined();
    expect(recorder.recordToolContractRejected('list_tasks', 422)).toMatchObject({ httpStatus: 422 });
    expect(createTurnMetricsRecorder({ sink, startedAtMs: 1_000 }).recordToolContractRejected('list_tasks', 400)).toBeUndefined();
  });
});
```

In `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts`, replace:

```ts
  TechnicalRuntimeEventV2Schema,
  type ExecutionBudget,
  type TechnicalRuntimeEventV2,
} from '../../../../contracts/index.js';
import { defineTool, type PipelineResult } from '../../../../types.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
```

with:

```ts
  TechnicalRuntimeEventV2Schema,
  type ExecutionBudget,
  type TechnicalRuntimeEventV2,
  type ToolContractRejectedEvent,
} from '../../../../contracts/index.js';
import { defineEndpointTool, defineTool, type PipelineResult } from '../../../../types.js';
import { endpointToolToTool } from '../../../core/index.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
```

In `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts`, replace:

```ts

function collectingSink(record?: (event: TechnicalRuntimeEventV2) => void) {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: { appId: APP_ID, environmentId: ENVIRONMENT_ID, buildId: 'git:4f2c9e1', instanceId: 'web-1' },
    record: (event) => {
      events.push(event);
      record?.(event);
    },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

function managedRuntime(limits: ExecutionBudget = localLimits) {
```

with:

```ts

function collectingSink(record?: (event: TechnicalRuntimeEventV2) => void) {
  const events: TechnicalRuntimeEventV2[] = [];
  const rejections: ToolContractRejectedEvent[] = [];
  const sink: RuntimeMetricsSink = {
    identity: { appId: APP_ID, environmentId: ENVIRONMENT_ID, buildId: 'git:4f2c9e1', instanceId: 'web-1' },
    record: (event) => {
      if (event.eventType === 'tool_contract_rejected') {
        rejections.push(event);
        return;
      }
      events.push(event);
      record?.(event);
    },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events, rejections };
}

function managedRuntime(limits: ExecutionBudget = localLimits) {
```

In `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts`, replace:

```ts
    expect(await response.text()).toContain('Erledigt');
  });

  it('refuses the legacy Lancer telemetry on the managed-local path', () => {
    const telemetry = { emit: vi.fn(), flush: async () => undefined };
    expect(() => createAiChatHandler({
```

with:

```ts
    expect(await response.text()).toContain('Erledigt');
  });

  it('reports an endpoint that refuses a schema-valid call as tool_contract_rejected', async () => {
    const { sink, events, rejections } = collectingSink();
    const endpointCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      endpointCalls.push(String(url));
      return new Response(JSON.stringify({ error: 'query must not be empty' }), {
        status: 422, headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const handler = createAiChatHandler({
        tools: {
          list_tasks: endpointToolToTool(defineEndpointTool({
            id: LIST_TASKS_ID,
            toolName: 'list_tasks',
            description: 'List visible tasks.',
            method: 'GET',
            path: '/api/tasks',
            inputSchema: z.object({ query: z.string() }),
          })),
        },
        model: scriptedModel([() => toolStep(), () => textStep()]),
        systemPrompt: 'Assistant',
        managedRuntime: managedRuntime(),
        metrics: sink,
      });
      await (await handler(request())).text();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(endpointCalls).toHaveLength(1);
    expect(rejections).toEqual([{
      schemaVersion: 2,
      eventId: expect.any(String),
      eventType: 'tool_contract_rejected',
      occurredAt: expect.any(String),
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      toolId: LIST_TASKS_ID,
      inputSchemaDigest: manifestRevision.tools[0]!.inputSchemaDigest,
      httpStatus: 422,
    }]);
    expect(JSON.stringify(rejections)).not.toContain(SECRET_TEXT);
    expect(events).toHaveLength(1);
  });

  it('refuses the legacy Lancer telemetry on the managed-local path', () => {
    const telemetry = { emit: vi.fn(), flush: async () => undefined };
    expect(() => createAiChatHandler({
```

Create `src/server/core/__tests__/contract-rejection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool } from '../../../types.js';
import { endpointToolToTool, toolToAiTool, type EndpointToolContext } from '../index.js';

const definition = defineEndpointTool({
  id: 'tasks.create',
  toolName: 'tasks_create',
  description: 'Create a task.',
  method: 'POST',
  path: '/api/tasks',
  inputSchema: z.object({ title: z.string() }).strict(),
});

function context(status: number, onContractRejected?: EndpointToolContext['onContractRejected']): EndpointToolContext {
  return {
    currentDate: new Date('2026-10-05T10:00:00.000Z'),
    locale: 'de-DE',
    callEndpoint: async () => ({ ok: status < 400, status, data: { error: 'title is too short' }, error: 'title is too short' }),
    ...(onContractRejected ? { onContractRejected } : {}),
  };
}

describe('tool_contract_rejected at the endpoint tool', () => {
  it.each([400, 422] as const)('reports a schema-valid call the endpoint refuses with %i', async (status) => {
    const rejections: unknown[] = [];
    const tool = toolToAiTool(endpointToolToTool(definition), context(status, (rejection) => { rejections.push(rejection); }));
    const result = await tool.execute({ title: 'x' });
    expect(result).toMatchObject({ success: false, error: 'title is too short' });
    expect(rejections).toEqual([{ toolName: 'tasks_create', status }]);
  });

  it.each([401, 403, 404, 500])('leaves %i alone: it is no contract problem', async (status) => {
    const rejections: unknown[] = [];
    const tool = toolToAiTool(endpointToolToTool(definition), context(status, (rejection) => { rejections.push(rejection); }));
    await tool.execute({ title: 'x' });
    expect(rejections).toEqual([]);
  });

  it('never lets a failing reporter change the tool result', async () => {
    const tool = toolToAiTool(endpointToolToTool(definition), context(400, () => { throw new Error('sink down'); }));
    expect(await tool.execute({ title: 'x' })).toMatchObject({ success: false, error: 'title is too short' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/metrics/sink.test.ts src/runtime/metrics/turn-recorder.test.ts src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts src/server/core/__tests__/contract-rejection.test.ts --maxWorkers=4`
Expected: FAIL — the endpoint tool never calls `onContractRejected`, the recorder has no `recordToolContractRejected`, the sink drops rejections as `invalid`, and the handler wires nothing. `Test Files  4 failed (4)`, `Tests  6 failed | 67 passed (73)`

- [ ] **Step 3: Implement**

In `src/runtime/metrics/sink.ts`, replace:

```ts
  RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_METRIC_MAX_BATCH,
  TechnicalRuntimeEventV2Schema,
  type TechnicalRuntimeEventBatch,
  type TechnicalRuntimeEventV2,
} from '../../contracts/index.js';
import type {
  RuntimeMetricsIdentity,
```

with:

```ts
  RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_METRIC_MAX_BATCH,
  RuntimeMetricEventSchema,
  type RuntimeMetricEvent,
  type TechnicalRuntimeEventBatch,
} from '../../contracts/index.js';
import type {
  RuntimeMetricsIdentity,
```

In `src/runtime/metrics/sink.ts`, replace:

```ts
    buildId: config.buildId,
    instanceId: config.instanceId,
  });
  const queue: TechnicalRuntimeEventV2[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let flushScheduled = false;
```

with:

```ts
    buildId: config.buildId,
    instanceId: config.instanceId,
  });
  // One queue per event type: a batch never mixes types, so a Platform that
  // does not know `tool_contract_rejected` yet refuses only those batches.
  const queues = new Map<RuntimeMetricEvent['eventType'], RuntimeMetricEvent[]>();
  const queued = () => [...queues.values()].reduce((sum, events) => sum + events.length, 0);
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let flushScheduled = false;
```

In `src/runtime/metrics/sink.ts`, replace:

```ts
    }
  };

  const send = async (events: TechnicalRuntimeEventV2[]): Promise<boolean> => {
    try {
      const body: TechnicalRuntimeEventBatch = {
        schemaVersion: RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
```

with:

```ts
    }
  };

  const send = async (events: RuntimeMetricEvent[]): Promise<boolean> => {
    try {
      const body: TechnicalRuntimeEventBatch = {
        schemaVersion: RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
```

In `src/runtime/metrics/sink.ts`, replace:

```ts

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (queue.length === 0) return Promise.resolve();
    inFlight = (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, config.maxBatchSize);
          if (!await send(batch)) drop('send-failed', batch.length);
        }
      } finally {
        inFlight = undefined;
```

with:

```ts

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (queued() === 0) return Promise.resolve();
    inFlight = (async () => {
      try {
        for (const queue of queues.values()) {
          while (queue.length > 0) {
            const batch = queue.splice(0, config.maxBatchSize);
            if (!await send(batch)) drop('send-failed', batch.length);
          }
        }
      } finally {
        inFlight = undefined;
```

In `src/runtime/metrics/sink.ts`, replace:

```ts
  return {
    identity,
    get pending() {
      return queue.length;
    },
    record(event) {
      try {
```

with:

```ts
  return {
    identity,
    get pending() {
      return queued();
    },
    record(event) {
      try {
```

In `src/runtime/metrics/sink.ts`, replace:

```ts
          drop('closed', 1);
          return;
        }
        const checked = TechnicalRuntimeEventV2Schema.safeParse(event);
        if (
          !checked.success
          || checked.data.appId !== identity.appId
```

with:

```ts
          drop('closed', 1);
          return;
        }
        const checked = RuntimeMetricEventSchema.safeParse(event);
        if (
          !checked.success
          || checked.data.appId !== identity.appId
```

In `src/runtime/metrics/sink.ts`, replace:

```ts
          drop('invalid', 1);
          return;
        }
        if (queue.length >= config.maxQueueSize) {
          drop('queue-full', 1);
          return;
        }
        queue.push(checked.data);
        ensureTimer();
        if (queue.length >= config.maxBatchSize) scheduleFlush();
```

with:

```ts
          drop('invalid', 1);
          return;
        }
        if (queued() >= config.maxQueueSize) {
          drop('queue-full', 1);
          return;
        }
        const queue = queues.get(checked.data.eventType) ?? [];
        queues.set(checked.data.eventType, queue);
        queue.push(checked.data);
        ensureTimer();
        if (queue.length >= config.maxBatchSize) scheduleFlush();
```

In `src/runtime/metrics/turn-recorder.ts`, replace:

```ts
  RUNTIME_METRIC_MAX_COUNT,
  RUNTIME_METRIC_MAX_TOOLS,
  TechnicalRuntimeEventV2Schema,
  type RuntimeTurnCost,
  type RuntimeTurnErrorCode,
  type RuntimeTurnStatus,
  type TechnicalRuntimeEventV2,
} from '../../contracts/index.js';
import { modelFacingToolName } from '../local-tool-bindings.js';
import type { TurnSnapshot } from '../turn-snapshot.js';
```

with:

```ts
  RUNTIME_METRIC_MAX_COUNT,
  RUNTIME_METRIC_MAX_TOOLS,
  TechnicalRuntimeEventV2Schema,
  ToolContractRejectedEventSchema,
  type RuntimeMetricEvent,
  type RuntimeTurnCost,
  type RuntimeTurnErrorCode,
  type RuntimeTurnStatus,
  type TechnicalRuntimeEventV2,
  type ToolContractRejectedEvent,
} from '../../contracts/index.js';
import { modelFacingToolName } from '../local-tool-bindings.js';
import type { TurnSnapshot } from '../turn-snapshot.js';
```

In `src/runtime/metrics/turn-recorder.ts`, replace:

```ts
}

/**
 * Receives finished turn events. `record` must return immediately and never
 * throw: delivery happens later, off the turn, and is dropped on failure.
 */
export interface RuntimeMetricsSink {
  readonly identity: RuntimeMetricsIdentity;
  record(event: TechnicalRuntimeEventV2): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

with:

```ts
}

/**
 * Receives finished turns and contract rejections. `record` must return
 * immediately and never throw: delivery happens later, off the turn, and is
 * dropped on failure.
 */
export interface RuntimeMetricsSink {
  readonly identity: RuntimeMetricsIdentity;
  record(event: RuntimeMetricEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

In `src/runtime/metrics/turn-recorder.ts`, replace:

```ts
   * the event, or undefined when the turn was already finished. Never throws.
   */
  finish(outcome: TurnMetricsOutcome): TechnicalRuntimeEventV2 | undefined;
}

export interface TurnMetricsRecorderOptions {
```

with:

```ts
   * the event, or undefined when the turn was already finished. Never throws.
   */
  finish(outcome: TurnMetricsOutcome): TechnicalRuntimeEventV2 | undefined;
  /**
   * An endpoint refused a call its tool schema accepted (spec 4.7). Hands a
   * content-free `tool_contract_rejected` event to the sink right away and
   * returns it; undefined for a tool outside the pinned snapshot. Never throws.
   */
  recordToolContractRejected(toolName: string, httpStatus: 400 | 422): ToolContractRejectedEvent | undefined;
}

export interface TurnMetricsRecorderOptions {
```

In `src/runtime/metrics/turn-recorder.ts`, replace:

```ts
): TurnMetricsRecorder {
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? randomUUID;
  const toolIdByName = new Map(
    (options.snapshot?.manifestRevision.tools ?? []).map((tool) => [
      modelFacingToolName(tool.name),
      tool.toolId,
    ] as const),
  );
  const costs: RuntimeTurnCost[] = [];
  const usage = new Map<string, { calls: number; errors: number }>();
  let firstChunkAtMs: number | undefined;
```

with:

```ts
): TurnMetricsRecorder {
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? randomUUID;
  const manifestTools = options.snapshot?.manifestRevision.tools ?? [];
  const toolIdByName = new Map(manifestTools.map((tool) => [
    modelFacingToolName(tool.name),
    tool.toolId,
  ] as const));
  const schemaDigestByName = new Map(manifestTools.map((tool) => [
    modelFacingToolName(tool.name),
    tool.inputSchemaDigest,
  ] as const));
  const costs: RuntimeTurnCost[] = [];
  const usage = new Map<string, { calls: number; errors: number }>();
  let firstChunkAtMs: number | undefined;
```

In `src/runtime/metrics/turn-recorder.ts`, replace:

```ts
      }
    },

    finish(outcome) {
      if (finished) return undefined;
      finished = true;
```

with:

```ts
      }
    },

    recordToolContractRejected(toolName, httpStatus) {
      try {
        const toolId = toolIdByName.get(toolName);
        const inputSchemaDigest = schemaDigestByName.get(toolName);
        if (!toolId || !inputSchemaDigest) return undefined;
        const parsed = ToolContractRejectedEventSchema.safeParse({
          schemaVersion: 2,
          eventId: createEventId(),
          eventType: 'tool_contract_rejected',
          occurredAt: new Date(now()).toISOString(),
          appId: options.sink.identity.appId,
          environmentId: options.sink.identity.environmentId,
          buildId: options.sink.identity.buildId,
          instanceId: options.sink.identity.instanceId,
          revisionId: options.snapshot?.agentRevision.revisionId ?? null,
          toolId,
          inputSchemaDigest,
          httpStatus,
        });
        if (!parsed.success) return undefined;
        try {
          options.sink.record(parsed.data);
        } catch {
          // A sink must never fail a tool call.
        }
        return parsed.data;
      } catch {
        return undefined;
      }
    },

    finish(outcome) {
      if (finished) return undefined;
      finished = true;
```

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
    }
  }
  return names;
}

function compactToolNames(toolCalls: Array<{ toolName: string }>): string[] {
```

with:

```ts
    }
  }
  return names;
}

/** Hands endpoint contract rejections to the turn's metrics, when the app reports metrics. */
function contractRejectionReporter(
  turnMetrics: TurnMetricsRecorder | undefined,
): { onContractRejected?: (rejection: { toolName: string; status: 400 | 422 }) => void } {
  return turnMetrics
    ? { onContractRejected: ({ toolName, status }) => { turnMetrics.recordToolContractRejected(toolName, status); } }
    : {};
}

function compactToolNames(toolCalls: Array<{ toolName: string }>): string[] {
```

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
          ...(managedTurn
            ? { turnSnapshot: managedTurn.snapshot }
            : {}),
        };

        // Get tools (static or dynamic)
```

with:

```ts
          ...(managedTurn
            ? { turnSnapshot: managedTurn.snapshot }
            : {}),
          ...contractRejectionReporter(turnMetrics),
        };

        // Get tools (static or dynamic)
```

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
        ...(managedTurn
          ? { turnSnapshot: managedTurn.snapshot }
          : {}),
      };

      // Load tools
```

with:

```ts
        ...(managedTurn
          ? { turnSnapshot: managedTurn.snapshot }
          : {}),
        ...contractRejectionReporter(turnMetrics),
      };

      // Load tools
```

In `src/server/core/index.ts`, replace:

```ts

export interface EndpointToolContext extends ToolContext {
  callEndpoint: InternalApiCaller;
}

// ============================================================================
```

with:

```ts

export interface EndpointToolContext extends ToolContext {
  callEndpoint: InternalApiCaller;
  /**
   * The endpoint refused a call that passed the tool's input schema (400 or
   * 422): the contract is wrong (spec 4.7, `tool_contract_rejected`). Called
   * with the model-facing tool name; it must not throw.
   */
  onContractRejected?: (rejection: { toolName: string; status: 400 | 422 }) => void;
}

// ============================================================================
```

In `src/server/core/index.ts`, replace:

```ts
      });

      if (!response.ok) {
        return {
          success: false,
          error: response.error ?? `Endpoint failed (${response.status})`,
```

with:

```ts
      });

      if (!response.ok) {
        if (response.status === 400 || response.status === 422) {
          try {
            endpointContext.onContractRejected?.({ toolName: endpointTool.toolName, status: response.status });
          } catch {
            // Metrics never change a tool result.
          }
        }
        return {
          success: false,
          error: response.error ?? `Endpoint failed (${response.status})`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/metrics/sink.test.ts src/runtime/metrics/turn-recorder.test.ts src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts src/server/core/__tests__/contract-rejection.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  4 passed (4)`, `Tests  73 passed (73)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/metrics/sink.test.ts src/runtime/metrics/sink.ts src/runtime/metrics/turn-recorder.test.ts src/runtime/metrics/turn-recorder.ts src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts src/server/adapters/nextjs/create-ai-chat-handler.ts src/server/core/__tests__/contract-rejection.test.ts src/server/core/index.ts
git commit -m "feat(runtime): report endpoints that refuse schema-valid tool calls"
```

### Task 17: `glirastes init` writes the tools inputs and the agent hint

**Files:**
- Create: `src/cli/commands/init-scaffold.ts`
- Modify: `src/cli/commands/agent-setup.ts` (runs the scaffold after installing skills; dry run previews it; the agent instructions name the work lists and the fixed app id)
- Test: `src/cli/commands/init-scaffold.test.ts` (Create), `src/cli/commands/agent-setup.test.ts` (the in-session case reports and writes the scaffold)

**Interfaces:**
- Consumes: `TOOLS_PATHS`, `writeArtifactSetAtomically`, `FoundationDiagnosticError`; P04 ruling R7/X13 (the app id in `tools.json` is the Platform app id: pairing adopts the local id and refuses a different one); P03 ruling C7 (refresh needs `prompt-bundle.json`).
- Produces: `scaffoldToolsInputs({ root, host, dryRun?, createAppId? }): Promise<{ appId, written, notes }>` and `localAppIdentity(root)`, `AGENT_HINT_START`:
  - the app id is the one `tools.json`, `prompt-bundle.json`, `setup-receipt.json` and `platform-connection.json` agree on, or a new UUID; two different ids ⇒ `E-SETUP-021`, nothing written;
  - `tools.json` (Next.js apps only, when missing): `schemaVersion 1`, the app id, `targetAppKey` from the package name, `locale: 'en'`, sources `next-app` (`app/api` when there is no `src/app/api`), `next-pages`, `url-filters` (with `nuqs`), `react-actions`;
  - `prompt-bundle.json` (always, when missing) with neutral planner, app-behaviour and response-style text;
  - the hint block (`<!-- glirastes:tools -->`) in the host's `AGENTS.md`/`CLAUDE.md`, plus the other file when it exists, through links once;
  - `predev`/`prebuild` scripts when missing, keeping the file's indentation; an existing script without the refresh becomes a note.
  - `glirastes init` prints or returns `scaffold` (JSON) and never touches existing files or the app id.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/agent-setup.test.ts`, replace:

```ts
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.agents/skills/setting-up-glirastes/SKILL.md'), 'utf8')).toContain('Setting Up Glirastes');
    expect(await readdir(root)).not.toContain('.env');
  });

  it('requires an unambiguous host before writing anything in a noninteractive shell', async () => {
```

with:

```ts
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.agents/skills/setting-up-glirastes/SKILL.md'), 'utf8')).toContain('Setting Up Glirastes');
    expect(await readdir(root)).not.toContain('.env');
    expect(result.scaffold).toMatchObject({
      written: ['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json'],
    });
    const config = JSON.parse(await readFile(join(root, '.glirastes/tools.json'), 'utf8')) as { appId: string };
    expect(config.appId).toBe(result.scaffold.appId);
    expect(result.instructions).toContain('Never change the appId in tools.json.');
  });

  it('requires an unambiguous host before writing anything in a noninteractive shell', async () => {
```

Create `src/cli/commands/init-scaffold.test.ts`:

```ts
import { lstat, readFile, readlink, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../codegen/tools/__tests__/app-fixture.js';
import { ToolsConfigSchema } from '../../codegen/tools/config.js';
import { LocalPromptBundleSchema } from './validate-build.js';
import { AGENT_HINT_START, scaffoldToolsInputs } from './init-scaffold.js';
import { runToolsCommand } from './tools/index.js';

afterEach(removeAppFixtures);

const APP_ID = '019fb007-0000-7000-8000-0000000000f1';
const OTHER_ID = '019fb007-0000-7000-8000-0000000000f2';
const NEXT_PACKAGE = `${JSON.stringify({ name: '@acme/Task Board', private: true, type: 'module', dependencies: { next: '16', nuqs: '2' } }, null, 2)}\n`;
const ROUTE = 'declare function getSession(): Promise<unknown>;\n'
  + 'export async function GET() { await getSession(); return Response.json({ tasks: [] as string[] }); }\n';

async function freshApp(files: Record<string, string> = {}) {
  return createAppFixture({ 'package.json': NEXT_PACKAGE, 'src/app/api/tasks/route.ts': ROUTE, ...files },
    { withoutToolsConfig: true, withoutPromptBundle: true });
}

describe('glirastes init scaffold', () => {
  it('writes the tools inputs, scripts and agent hint a fresh Next app needs for its first refresh', async () => {
    const app = await freshApp();
    const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
    expect(scaffold).toEqual({
      appId: APP_ID,
      written: ['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json'],
      notes: ['Set "locale" in .glirastes/tools.json to the language of the app (e.g. "de-DE").'],
    });
    expect(ToolsConfigSchema.parse(JSON.parse(await app.read('.glirastes/tools.json')))).toMatchObject({
      appId: APP_ID, targetAppKey: 'task-board', locale: 'en', sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'],
    });
    expect(LocalPromptBundleSchema.parse(JSON.parse(await app.read('.glirastes/prompt-bundle.json'))).appId).toBe(APP_ID);
    expect(JSON.parse(await app.read('package.json')).scripts).toEqual({
      predev: 'glirastes tools refresh --keep-going', prebuild: 'glirastes tools refresh',
    });
    expect(await app.read('AGENTS.md')).toContain('run `glirastes tools refresh`');
    const out: string[] = [];
    const deps = { cwd: app.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('+ tasks.list  GET /api/tasks  [safe-read]');
    expect(await scaffoldToolsInputs({ root: app.root, host: 'codex' })).toEqual({ appId: APP_ID, written: [], notes: [] });
  }, 120_000);

  it('keeps the app id the local files already name and refuses two different ones', async () => {
    const app = await freshApp({ '.glirastes/prompt-bundle.json': JSON.stringify({ schemaVersion: 1, appId: APP_ID }) });
    const kept = await scaffoldToolsInputs({ root: app.root, host: 'claude', createAppId: () => OTHER_ID });
    expect(kept.appId).toBe(APP_ID);
    expect(kept.written).toEqual(['.glirastes/tools.json', 'CLAUDE.md', 'package.json']);
    const conflicted = await freshApp({
      '.glirastes/prompt-bundle.json': JSON.stringify({ schemaVersion: 1, appId: APP_ID }),
      '.glirastes/setup-receipt.json': JSON.stringify({ schemaVersion: 1, appId: OTHER_ID }),
    });
    await expect(scaffoldToolsInputs({ root: conflicted.root, host: 'codex' })).rejects.toMatchObject({ code: 'E-SETUP-021' });
    await expect(conflicted.read('.glirastes/tools.json')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('never replaces existing scripts or instructions and follows an instruction link once', async () => {
    const app = await freshApp({
      'package.json': `${JSON.stringify({ name: 'board', dependencies: { next: '16' }, scripts: { prebuild: 'tsc -p .' } }, null, 4)}\n`,
      'AGENTS.md': '# Agents\n\nUse bun.\n',
    });
    await symlink('AGENTS.md', app.path('CLAUDE.md'), 'file');
    const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'claude', createAppId: () => APP_ID });
    expect(scaffold.written).toEqual(['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json']);
    expect(scaffold.notes).toContain('package.json already has a prebuild script; add "glirastes tools refresh" to it.');
    const packageRaw = await app.read('package.json');
    expect(packageRaw).toContain('\n    "scripts": {');
    expect(JSON.parse(packageRaw).scripts).toEqual({ prebuild: 'tsc -p .', predev: 'glirastes tools refresh --keep-going' });
    const agents = await readFile(app.path('AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Agents\n\nUse bun.\n\n<!-- glirastes:tools -->')).toBe(true);
    expect(agents.split(AGENT_HINT_START)).toHaveLength(2);
    expect((await lstat(app.path('CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(app.path('CLAUDE.md'))).toBe('AGENTS.md');
  }, 60_000);

  it('writes only the prompt bundle and the hint for another stack, and nothing in a dry run', async () => {
    const vite = await createAppFixture({ 'package.json': JSON.stringify({ name: 'vue-board', dependencies: { vue: '3' } }) },
      { withoutToolsConfig: true, withoutPromptBundle: true });
    const preview = await scaffoldToolsInputs({ root: vite.root, host: 'codex', dryRun: true, createAppId: () => APP_ID });
    expect(preview.written).toEqual(['.glirastes/prompt-bundle.json', 'AGENTS.md', 'package.json']);
    expect(preview.notes).toEqual(['No Next.js app: integrating-glirastes-web describes .glirastes/tools.json for this stack.']);
    await expect(vite.read('.glirastes/prompt-bundle.json')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(vite.read('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/agent-setup.test.ts src/cli/commands/init-scaffold.test.ts --maxWorkers=4`
Expected: FAIL — `Cannot find module './init-scaffold.js'`; init writes no `tools.json` and reports no scaffold. `Test Files  2 failed (2)`, `Tests  1 failed | 13 passed (14)`

- [ ] **Step 3: Implement**

In `src/cli/commands/agent-setup.ts`, replace:

```ts
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { findPackageSkillsDir, installSkills } from './install-skills.js';
import { hostRecord, readInstalledSkillsManifest } from './installed-skills-manifest.js';
import { inspectSetupProject } from './project-inspection.js';
```

with:

```ts
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { scaffoldToolsInputs, type InitScaffold } from './init-scaffold.js';
import { findPackageSkillsDir, installSkills } from './install-skills.js';
import { hostRecord, readInstalledSkillsManifest } from './installed-skills-manifest.js';
import { inspectSetupProject } from './project-inspection.js';
```

In `src/cli/commands/agent-setup.ts`, replace:

```ts
    'Use the current agent and its existing model configuration; do not request an extra setup provider key or silently change provider.',
    'The app chat needs its own authorized runtime model binding. Do not extract coding-agent credentials for app use.',
    'Continue autonomously from existing evidence. Ask only genuinely unresolved decisions. Create source-derived local bindings, chat integration and repeatable build/CI regeneration; do not ask the developer to maintain a second tool catalogue.',
    options.managed
      ? 'Managed mode is explicit: existing Managed apps retain --managed for setup and doctor. For a fresh app, prepare local pairing artifacts, connect with approval, then apply Managed setup before any chat/tool execution. Preserve app/environment scope; never downgrade an existing Managed app.'
      : 'A fresh app defaults to Standalone without a Platform account. Preserve any existing Connected/Managed configuration; never silently downgrade it.',
```

with:

```ts
    'Use the current agent and its existing model configuration; do not request an extra setup provider key or silently change provider.',
    'The app chat needs its own authorized runtime model binding. Do not extract coding-agent credentials for app use.',
    'Continue autonomously from existing evidence. Ask only genuinely unresolved decisions. Create source-derived local bindings, chat integration and repeatable build/CI regeneration; do not ask the developer to maintain a second tool catalogue.',
    'Init wrote .glirastes/tools.json, .glirastes/prompt-bundle.json, the predev/prebuild scripts and the agent hint where they were missing. Run glirastes tools refresh, work through glirastes tools resolve --print and glirastes tools describe --print, then glirastes tools refresh and glirastes tools eval again. Never change the appId in tools.json.',
    options.managed
      ? 'Managed mode is explicit: existing Managed apps retain --managed for setup and doctor. For a fresh app, prepare local pairing artifacts, connect with approval, then apply Managed setup before any chat/tool execution. Preserve app/environment scope; never downgrade an existing Managed app.'
      : 'A fresh app defaults to Standalone without a Platform account. Preserve any existing Connected/Managed configuration; never silently downgrade it.',
```

In `src/cli/commands/agent-setup.ts`, replace:

```ts
    'Run local setup/doctor and the actual chat/tool test. Report separately what passed and what is blocked; agent exit or Doctor success is not tool-action proof. Do not run glirastes init again inside this setup.',
  ].join('\n');
  const base = { schemaVersion: 1, agent, instructions, inspection };
  if (options.dryRun) {
    const preview = { ...base, status: 'preview', skillDirectory: TARGETS[agent] };
    console.log(options.json ? JSON.stringify(preview) : `Glirastes setup preview (${agent})\nNo files changed or agent started.\n${instructions}`);
    return;
  }
  await installSkills({ rootDir: root, host: agent, parts: ['setup', 'tools', 'chat-ui', 'framework'], quiet: options.json });
  if (active === agent) {
    console.log(options.json ? JSON.stringify({ ...base, status: 'continue-in-session' })
      : `Continue setup in this ${agent} session:\n${instructions}`);
    return;
  }
  console.log(`Starting ${agent} in the app folder with its existing model and permission settings.`);
  const exitCode = await (deps.launch ?? launchSetupAgent)({
    executable: selected!.executable, args: [instructions], cwd: root,
```

with:

```ts
    'Run local setup/doctor and the actual chat/tool test. Report separately what passed and what is blocked; agent exit or Doctor success is not tool-action proof. Do not run glirastes init again inside this setup.',
  ].join('\n');
  const base = { schemaVersion: 1, agent, instructions, inspection };
  const scaffoldText = (scaffold: InitScaffold, verb: string) => [
    scaffold.written.length > 0 ? `${verb}: ${scaffold.written.join(', ')}` : 'No Glirastes input files were missing.',
    ...scaffold.notes,
  ].join('\n');
  if (options.dryRun) {
    const scaffold = await scaffoldToolsInputs({ root, host: agent, dryRun: true });
    const preview = { ...base, status: 'preview', skillDirectory: TARGETS[agent], scaffold };
    console.log(options.json ? JSON.stringify(preview)
      : `Glirastes setup preview (${agent})\nNo files changed or agent started.\n${scaffoldText(scaffold, 'Would write')}\n${instructions}`);
    return;
  }
  await installSkills({ rootDir: root, host: agent, parts: ['setup', 'tools', 'chat-ui', 'framework'], quiet: options.json });
  const scaffold = await scaffoldToolsInputs({ root, host: agent });
  if (active === agent) {
    console.log(options.json ? JSON.stringify({ ...base, status: 'continue-in-session', scaffold })
      : `${scaffoldText(scaffold, 'Wrote')}\nContinue setup in this ${agent} session:\n${instructions}`);
    return;
  }
  console.log(scaffoldText(scaffold, 'Wrote'));
  console.log(`Starting ${agent} in the app folder with its existing model and permission settings.`);
  const exitCode = await (deps.launch ?? launchSetupAgent)({
    executable: selected!.executable, args: [instructions], cwd: root,
```

Create `src/cli/commands/init-scaffold.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TOOLS_PATHS } from '../../codegen/tools/config.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { writeArtifactSetAtomically } from './atomic-artifact-write.js';

/**
 * What `glirastes init` writes deterministically before the coding agent
 * starts (spec 4.3, 4.6, 4.8): the tools configuration with the app id that
 * Platform pairing later adopts, the prompt bundle every refresh needs, the
 * predev/prebuild scripts and a short hint in the agent instructions.
 * Existing files and scripts are never replaced.
 */
export interface InitScaffold {
  /** The one app id of this app; tool ids derive from it. */
  appId: string;
  /** App-relative files init writes (or would write in a dry run). */
  written: string[];
  /** What the developer or the agent still has to do by hand. */
  notes: string[];
}

export const AGENT_HINT_START = '<!-- glirastes:tools -->';
const AGENT_HINT = [
  AGENT_HINT_START,
  '## Glirastes tools',
  '',
  'After changing API routes, pages, URL filters or client actions, run `glirastes tools refresh`.',
  'Work through `glirastes tools resolve --print` (skill `maintaining-glirastes-tools`) and',
  '`glirastes tools describe --print` (skill `describing-glirastes-tools`), then run',
  '`glirastes tools refresh` and `glirastes tools eval` again and commit `.glirastes` with the code.',
  'Never edit `.glirastes/tool-policy.json` or generated files yourself; Glirastes never calls a model.',
  '<!-- /glirastes:tools -->',
  '',
].join('\n');

const IDENTITY_FILES = [
  TOOLS_PATHS.config,
  TOOLS_PATHS.promptBundle,
  TOOLS_PATHS.receipt,
  '.glirastes/platform-connection.json',
] as const;

const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['predev', 'glirastes tools refresh --keep-going'],
  ['prebuild', 'glirastes tools refresh'],
];

interface PackageJson {
  name?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function identityConflict(found: ReadonlyArray<readonly [string, string]>): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-SETUP-021',
    operation: 'setup.init',
    message: `The local Glirastes files name different apps (${found.map(([path]) => path).join(', ')}). `
      + 'Tool ids derive from the app id, so init never changes it silently; keep one app id in all of them.',
    remediation: 'keep-one-app-id',
  });
}

/** The app id the local files agree on, or undefined for a fresh app. */
export async function localAppIdentity(root: string): Promise<string | undefined> {
  const found: Array<readonly [string, string]> = [];
  for (const path of IDENTITY_FILES) {
    const raw = await readText(join(root, path));
    if (raw === undefined) continue;
    try {
      const appId = (JSON.parse(raw) as { appId?: unknown }).appId;
      if (typeof appId === 'string') found.push([path, appId]);
    } catch {
      // An unreadable file names no identity; refresh reports it.
    }
  }
  const ids = new Set(found.map(([, appId]) => appId));
  if (ids.size > 1) throw identityConflict(found);
  return found[0]?.[1];
}

function targetAppKey(name: unknown): string {
  const key = typeof name === 'string'
    ? name.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200)
    : '';
  return key || 'app';
}

function nextSources(root: string, dependencies: Record<string, string>): unknown[] {
  const sources: unknown[] = [];
  if (existsSync(join(root, 'src/app/api'))) sources.push('next-app');
  else if (existsSync(join(root, 'app/api'))) sources.push({ kind: 'next-app', apiDir: 'app/api' });
  else sources.push('next-app');
  sources.push('next-pages');
  if ('nuqs' in dependencies) sources.push('url-filters');
  sources.push('react-actions');
  return sources;
}

function promptBundle(appId: string, key: string): unknown {
  return {
    schemaVersion: 1,
    appId,
    artifactRef: `local://${key}/prompts`,
    sections: {
      planner: 'Use the available tools for what the user asks. Ask one short question when the target is unclear, and never invent data a tool did not return.',
      appBehavior: `You are the assistant of ${key}. Act only through the tools of this app and with the rights of the signed-in user.`,
      responseStyle: "Answer briefly in the user's language. Summarize tool results instead of repeating them.",
      capabilityFragments: {},
    },
  };
}

function indentationOf(raw: string): string | number {
  return /^( +|\t)"/m.exec(raw)?.[1] ?? 2;
}

/** Writes nothing that exists already; returns what it wrote (or would write with dryRun). */
export async function scaffoldToolsInputs(options: {
  root: string;
  host: 'codex' | 'claude';
  dryRun?: boolean;
  createAppId?: () => string;
}): Promise<InitScaffold> {
  const root = resolve(options.root);
  if (existsSync(join(root, '.glirastes')) && (await lstat(join(root, '.glirastes'))).isSymbolicLink()) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-020',
      operation: 'setup.agent',
      message: 'Review linked setup or skill folders before installing.',
      remediation: 'review-setup-write-paths',
    });
  }
  const packageRaw = await readText(join(root, 'package.json'));
  const packageJson = (packageRaw ? JSON.parse(packageRaw) : {}) as PackageJson;
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const appId = await localAppIdentity(root) ?? (options.createAppId ?? randomUUID)();
  const key = targetAppKey(packageJson.name);
  const writes: Array<{ path: string; content: string }> = [];
  const notes: string[] = [];
  const add = (path: string, content: string) => writes.push({ path, content });

  if (!existsSync(join(root, TOOLS_PATHS.config))) {
    if ('next' in dependencies) {
      add(TOOLS_PATHS.config, `${JSON.stringify({
        schemaVersion: 1,
        appId,
        targetAppKey: key,
        locale: 'en',
        sources: nextSources(root, dependencies),
      }, null, 2)}\n`);
      notes.push('Set "locale" in .glirastes/tools.json to the language of the app (e.g. "de-DE").');
    } else {
      notes.push('No Next.js app: integrating-glirastes-web describes .glirastes/tools.json for this stack.');
    }
  }
  if (!existsSync(join(root, TOOLS_PATHS.promptBundle))) {
    add(TOOLS_PATHS.promptBundle, `${JSON.stringify(promptBundle(appId, key), null, 2)}\n`);
  }

  // The host's instruction file, plus the other one when it exists; a link
  // (CLAUDE.md -> AGENTS.md) is followed so its target gets the hint once.
  const hostFile = options.host === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const hintTargets = new Set<string>();
  for (const file of [hostFile, 'AGENTS.md', 'CLAUDE.md']) {
    const absolute = join(root, file);
    if (!existsSync(absolute) && file !== hostFile) continue;
    const target = existsSync(absolute) ? relative(root, await realpath(absolute)) : file;
    if (target.startsWith('..') || isAbsolute(target)) {
      notes.push(`${file} points outside the app; add the Glirastes tools hint there yourself.`);
      continue;
    }
    hintTargets.add(target);
  }
  for (const target of hintTargets) {
    const current = await readText(join(root, target)) ?? '';
    if (current.includes(AGENT_HINT_START)) continue;
    const separator = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    add(target, `${current}${separator}${AGENT_HINT}`);
  }

  if (packageRaw !== undefined) {
    const scripts = { ...packageJson.scripts };
    let changed = false;
    for (const [name, command] of SCRIPTS) {
      const existing = scripts[name];
      if (existing === undefined) {
        scripts[name] = command;
        changed = true;
      } else if (!existing.includes('glirastes tools refresh')) {
        notes.push(`package.json already has a ${name} script; add "${command}" to it.`);
      }
    }
    if (changed) {
      add('package.json', `${JSON.stringify({ ...packageJson, scripts }, null, indentationOf(packageRaw))}\n`);
    }
  }

  if (!options.dryRun && writes.length > 0) {
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeArtifactSetAtomically(writes.map((write) => ({ path: join(root, write.path), content: write.content })));
  }
  return { appId, written: writes.map((write) => write.path).sort(), notes };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/agent-setup.test.ts src/cli/commands/init-scaffold.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  18 passed (18)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/agent-setup.test.ts src/cli/commands/agent-setup.ts src/cli/commands/init-scaffold.test.ts src/cli/commands/init-scaffold.ts
git commit -m "feat(cli): write the tools inputs and agent hint in glirastes init"
```

### Task 18: `glirastes connect` takes framework and app id from `tools.json`

**Files:**
- Modify: `src/cli/commands/connect.ts` (`connectFrameworkOf`, app id guard, framework passed to preflight and materialization)
- Test: `src/cli/commands/connect.test.ts` (new describe block "tools.json"), `src/codegen/tools/pipeline.test.ts` (refresh refuses to re-key tools after an app id change)

**Interfaces:**
- Consumes: P03 `loadToolsConfig`, `normalizeSources`; the existing pairing contract (`localAppId` = receipt app id; `E-CONNECT-APP-MISMATCH` when the Platform returns another).
- Produces: `connectFrameworkOf(config): 'nextjs' | undefined` (Next.js when a `next-*` source is configured); without `tools.json` the legacy `package.json` check stays. New error `E-CONNECT-APP-ID-CHANGED` when `tools.json`, the setup receipt or an existing `platform-connection.json` name different apps; `E-CONNECT-FRAMEWORK-UNSUPPORTED` names the configured sources. Roadmap rows "`glirastes connect` übernimmt das Framework aus `tools.json`" and "`tools.json.appId` … verweigern stille Änderungen" (the refresh half was already in P03's state reader; its test is new).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/connect.test.ts`, replace:

```ts
    await expect(readFile(environmentPath, 'utf8')).resolves.toBe('ORIGINAL_ENV=kept\n');
    await expect(readFile(descriptorPath, 'utf8')).resolves.toBe('original descriptor');
  });
});
```

with:

```ts
    await expect(readFile(environmentPath, 'utf8')).resolves.toBe('ORIGINAL_ENV=kept\n');
    await expect(readFile(descriptorPath, 'utf8')).resolves.toBe('original descriptor');
  });

  describe('tools.json', () => {
    const tools = (patch: Record<string, unknown> = {}) => JSON.stringify({
      schemaVersion: 1, appId, targetAppKey: 'fixture-app', locale: 'en', sources: ['next-app', 'react-actions'], ...patch,
    });
    const deps = (rootDir: string, client: ReturnType<typeof connectedClient>, preflight = vi.fn().mockResolvedValue({
      projectRoot: rootDir,
      environmentPath: join(rootDir, '.env.local'),
      descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
    })): ConnectCommandDependencies => ({
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight,
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      materialize: vi.fn().mockResolvedValue({}),
      createRunnerKey: () => 'local-runner',
      log: vi.fn(),
    });

    it('takes the framework from the configured sources instead of package.json', async () => {
      const rootDir = await fixture();
      await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: '@example/fixture-app', dependencies: {} }));
      await writeFile(join(rootDir, '.glirastes/tools.json'), tools());
      const client = connectedClient();
      const preflight = vi.fn().mockResolvedValue({
        projectRoot: rootDir,
        environmentPath: join(rootDir, '.env.local'),
        descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
      });
      await runConnect({ rootDir, baseUrl: 'https://control.example' }, deps(rootDir, client, preflight));
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ framework: 'nextjs' }));
      expect(client.startPairing).toHaveBeenCalledOnce();
    });

    it('names the configured sources when the stack has no automatic connection', async () => {
      const rootDir = await fixture();
      await writeFile(join(rootDir, '.glirastes/tools.json'), tools({ sources: ['react-actions', 'url-filters'] }));
      const client = connectedClient();
      await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, deps(rootDir, client))).rejects.toMatchObject({
        code: 'E-CONNECT-FRAMEWORK-UNSUPPORTED',
        message: 'Automatic connection materialization currently requires Next.js; .glirastes/tools.json declares react-actions, url-filters.',
      });
      expect(client.startPairing).not.toHaveBeenCalled();
    });

    it.each([
      ['tools.json names another app', '.glirastes/tools.json', () => tools({ appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400009' })],
      ['the checkout is already connected as another app', '.glirastes/platform-connection.json', () => JSON.stringify({
        schemaVersion: 1, baseUrl: 'https://control.example', appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400009', environmentId, runnerKey: 'local-runner',
      })],
    ])('refuses to change the app id silently when %s', async (_label, path, content) => {
      const rootDir = await fixture();
      await writeFile(join(rootDir, path), content());
      const client = connectedClient();
      await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, deps(rootDir, client)))
        .rejects.toMatchObject({ code: 'E-CONNECT-APP-ID-CHANGED' });
      expect(client.startPairing).not.toHaveBeenCalled();
    });
  });
});
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
      .filter((finding: { code: string }) => finding.code === 'policy-entry-orphaned')).toHaveLength(3);
  }, 120_000);
});
```

with:

```ts
      .filter((finding: { code: string }) => finding.code === 'policy-entry-orphaned')).toHaveLength(3);
  }, 120_000);
});

describe('runToolsPipeline (app identity)', () => {
  it('refuses to re-key every tool when tools.json changes its app id after a committed refresh', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const config = JSON.parse(await fixture.read(TOOLS_PATHS.config)) as Record<string, unknown>;
    await fixture.write(TOOLS_PATHS.config, JSON.stringify({ ...config, appId: '019fb007-0000-7000-8000-0000000000f9' }));
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(error.result.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['generation-state-invalid', TOOLS_PATHS.tombstones],
      ['prompt-bundle-invalid', TOOLS_PATHS.promptBundle],
    ]);
    expect(error.result.wrote).toBe(false);
  }, 120_000);
});

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/connect.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4`
Expected: FAIL — connect still requires `next` in `package.json`, names no sources and pairs although the app ids differ. `Test Files  1 failed | 1 passed (2)`, `Tests  4 failed | 37 passed (41)`

- [ ] **Step 3: Implement**

In `src/cli/commands/connect.ts`, replace:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  PairingStartRequest,
  PairingStartResponse,
```

with:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { loadToolsConfig, normalizeSources, TOOLS_PATHS, type ToolsConfig } from '../../codegen/tools/config.js';
import type {
  PairingStartRequest,
  PairingStartResponse,
```

In `src/cli/commands/connect.ts`, replace:

```ts
  return value;
}

function artifactOperationFrom(plan: SetupPlan): SetupPlan['operations'][number] {
  const operation = plan.operations.find(({ kind }) => kind === 'adopt');
  if (!operation) {
```

with:

```ts
  return value;
}

/**
 * The framework of the app as `tools.json` declares it (spec 7): Next.js when a
 * `next-*` source is configured. Automatic secret materialization exists for
 * Next.js only; other stacks set the connection variables themselves.
 */
export function connectFrameworkOf(config: ToolsConfig): 'nextjs' | undefined {
  return normalizeSources(config).some((source) => source.kind.startsWith('next-')) ? 'nextjs' : undefined;
}

async function connectedAppId(rootDir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(resolve(rootDir, '.glirastes/platform-connection.json'), 'utf8')) as { appId?: unknown };
    return typeof value.appId === 'string' ? value.appId : undefined;
  } catch {
    return undefined;
  }
}

function artifactOperationFrom(plan: SetupPlan): SetupPlan['operations'][number] {
  const operation = plan.operations.find(({ kind }) => kind === 'adopt');
  if (!operation) {
```

In `src/cli/commands/connect.ts`, replace:

```ts
      'rerun-local-setup',
    );
  }
  if (
    packageJson.data.dependencies?.next === undefined
    && packageJson.data.devDependencies?.next === undefined
  ) {
    throw connectError(
      'E-CONNECT-FRAMEWORK-UNSUPPORTED',
      'Automatic connection materialization currently requires Next.js.',
      'configure-supported-secret-target',
    );
  }
```

with:

```ts
      'rerun-local-setup',
    );
  }
  // Tool ids derive from the app id: the Platform adopts the local one, and
  // connect refuses when the committed files disagree instead of re-keying.
  const tools = existsSync(resolve(rootDir, TOOLS_PATHS.config)) ? loadToolsConfig(rootDir) : undefined;
  const previouslyConnected = await connectedAppId(rootDir);
  if ((tools && tools.appId !== receipt.data.appId)
    || (previouslyConnected !== undefined && previouslyConnected !== receipt.data.appId)) {
    throw connectError(
      'E-CONNECT-APP-ID-CHANGED',
      'The app id in .glirastes/tools.json, the setup receipt and the existing connection must be the same; tool ids derive from it, so it never changes silently.',
      'restore-tools-app-id',
    );
  }
  const framework = tools
    ? connectFrameworkOf(tools)
    : packageJson.data.dependencies?.next !== undefined || packageJson.data.devDependencies?.next !== undefined
      ? 'nextjs'
      : undefined;
  if (framework !== 'nextjs') {
    throw connectError(
      'E-CONNECT-FRAMEWORK-UNSUPPORTED',
      tools
        ? `Automatic connection materialization currently requires Next.js; .glirastes/tools.json declares ${normalizeSources(tools).map((source) => source.kind).join(', ')}.`
        : 'Automatic connection materialization currently requires Next.js.',
      'configure-supported-secret-target',
    );
  }
```

In `src/cli/commands/connect.ts`, replace:

```ts
  const preflight = dependencies.preflight ?? preflightConnectionEnvironment;
  await preflight({
    projectRoot: rootDir,
    framework: 'nextjs',
    isGitIgnored: dependencies.isGitIgnored,
  });

```

with:

```ts
  const preflight = dependencies.preflight ?? preflightConnectionEnvironment;
  await preflight({
    projectRoot: rootDir,
    framework,
    isGitIgnored: dependencies.isGitIgnored,
  });

```

In `src/cli/commands/connect.ts`, replace:

```ts
    ?? materializeConnectionEnvironment;
  await materialize({
    projectRoot: rootDir,
    framework: 'nextjs',
    connection: {
      ...token.connection,
      runnerKey: (dependencies.createRunnerKey ?? localRunnerKey)(),
```

with:

```ts
    ?? materializeConnectionEnvironment;
  await materialize({
    projectRoot: rootDir,
    framework,
    connection: {
      ...token.connection,
      runnerKey: (dependencies.createRunnerKey ?? localRunnerKey)(),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/connect.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  41 passed (41)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/connect.test.ts src/cli/commands/connect.ts src/codegen/tools/pipeline.test.ts
git commit -m "feat(cli): take the framework and app id of connect from tools.json"
```

### Task 19: Lint the shipped skills against the CLI

**Files:**
- Modify: `src/cli/commands/tools/check.ts` (`CHECK_ARGS`), `src/cli/commands/tools/status.ts` (`STATUS_ARGS`), `src/cli/commands/tools/index.ts` (`TOOLS_SUBCOMMANDS`, re-exported `POLICY_SUBCOMMANDS`)
- Test: `src/cli/commands/__tests__/skill-lint.ts` (Create: `lintSkill`, `skillCommands`, `commandWords`, `readSkill`), `src/cli/commands/skill-lint.test.ts` (Create: the linter's own cases and the empty `LINTED_SKILLS` list that Tasks 20–26 fill)

**Interfaces:**
- Consumes: the argument tables of Tasks 8–14 (`RESOLVE_ARGS`, `EVAL_ARGS`, `DESCRIBE_ARGS`, `REFRESH_ARGS`, `VERIFY_ARGS`, `POLICY_SUBCOMMANDS`); `findPackageSkillsDir`; `TOOLS_PATHS`.
- Produces: `TOOLS_SUBCOMMANDS: Record<string, ToolArgsSpec>` (`refresh`, `check`, `status`, `resolve`, `describe`, `eval`, `verify`; `policy` through `POLICY_SUBCOMMANDS`). The lint (spec 4.12 "Arbeitslisten-Format und Skill-Anweisungen werden per Test konsistent gehalten") requires: frontmatter with exactly `name` (= folder) and `description` starting "Use when"; the sections `## Boundaries`, `## Workflow`, `## Commands`, `## Verification` in this order; a `bash` block in Commands whose lines are runnable `glirastes` commands with known subcommands, options and argument counts; every inline `glirastes tools …` mention and every `.glirastes/…` path known; the sentence "never calls a model"; no `--force`, keys, key values, decorators or removed commands; at most 400 lines.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/commands/__tests__/skill-lint.ts`:

````ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { findPackageSkillsDir } from '../install-skills.js';
import { POLICY_SUBCOMMANDS, TOOLS_SUBCOMMANDS } from '../tools/index.js';
import type { ToolArgsSpec } from '../tools/args.js';

/** Top-level commands a skill may tell an agent to run (src/cli/index.ts). */
const COMMANDS = new Set(['init', 'setup', 'connect', 'sync', 'doctor', 'install', 'tools']);
const SECTIONS = ['## Boundaries', '## Workflow', '## Commands', '## Verification'] as const;
const KNOWN_PATHS = new Set<string>([
  ...Object.values(TOOLS_PATHS),
  '.glirastes/platform-connection.json',
  '.glirastes/installed-skills.json',
  '.glirastes/mcp-tool-names.json',
]);
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/--force\b/, 'never teaches --force'],
  [/sk-or-v1-\w/, 'never shows a key'],
  [/OPENROUTER_API_KEY=\S/, 'never writes a key value'],
  [/@AiTool|@AiModule|@AiParam/, 'never teaches decorators'],
  [/glirastes (?:generate|scan --sync)\b/, 'never teaches removed commands'],
];

export interface SkillCommand {
  line: string;
  argv: string[];
}

/** Splits a command line like a shell would for quoted words; no expansion. */
export function commandWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/** The runnable lines of the `## Commands` bash block. */
export function skillCommands(source: string): SkillCommand[] {
  const section = source.split(/^## /m).find((part) => part.startsWith('Commands\n'));
  const block = section ? /```bash\n([\s\S]*?)```/.exec(section)?.[1] : undefined;
  return (block ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => ({ line, argv: commandWords(line) }));
}

function argsProblem(argv: ReadonlyArray<string>, spec: ToolArgsSpec): string | undefined {
  let positionals = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (spec.flags.includes(word)) continue;
    if (spec.values.includes(word)) {
      index += 1;
      if (argv[index] === undefined) return `${word} needs a value`;
      continue;
    }
    if (word.startsWith('--')) return `unknown option ${word}`;
    positionals += 1;
  }
  return positionals > (spec.positionals ?? 0) ? 'too many arguments' : undefined;
}

function commandProblem(argv: ReadonlyArray<string>): string | undefined {
  if (argv[0] !== 'glirastes') return 'starts with something other than glirastes';
  const command = argv[1];
  if (!command || !COMMANDS.has(command)) return `unknown command ${command ?? ''}`;
  if (command !== 'tools') return undefined;
  const sub = argv[2];
  if (sub === 'policy') {
    const policy = argv[3];
    const spec = policy && Object.hasOwn(POLICY_SUBCOMMANDS, policy) ? POLICY_SUBCOMMANDS[policy] : undefined;
    return spec ? argsProblem(argv.slice(4), spec) : `unknown tools policy subcommand ${policy ?? ''}`;
  }
  const spec = sub && Object.hasOwn(TOOLS_SUBCOMMANDS, sub) ? TOOLS_SUBCOMMANDS[sub] : undefined;
  return spec ? argsProblem(argv.slice(3), spec) : `unknown tools subcommand ${sub ?? ''}`;
}

/** Everything a shipped SKILL.md must satisfy; empty when the skill is consistent with the CLI. */
export function lintSkill(name: string, source: string): string[] {
  const problems: string[] = [];
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
  if (!frontmatter) return ['has no frontmatter'];
  const fields = frontmatter.split('\n').map((line) => line.split(':')[0]);
  if (fields.join(',') !== 'name,description') problems.push('frontmatter has exactly name and description');
  if (!frontmatter.includes(`name: ${name}\n`)) problems.push(`frontmatter names ${name}`);
  if (!/^description: Use when \S/m.test(frontmatter)) problems.push('description starts with "Use when"');
  let previous = -1;
  for (const section of SECTIONS) {
    const index = source.indexOf(`\n${section}\n`);
    if (index < 0) problems.push(`has a "${section}" section`);
    else if (index < previous) problems.push(`"${section}" follows the sections before it`);
    previous = Math.max(previous, index);
  }
  const commands = skillCommands(source);
  if (commands.length === 0) problems.push('the Commands section has a bash block with at least one command');
  for (const command of commands) {
    const problem = commandProblem(command.argv);
    if (problem) problems.push(`command "${command.line}": ${problem}`);
  }
  for (const match of source.matchAll(/glirastes tools ([a-z-]+)(?: ([a-z-]+))?/g)) {
    const [, sub, policy] = match;
    if (sub === 'policy') {
      if (policy && !Object.hasOwn(POLICY_SUBCOMMANDS, policy)) problems.push(`mentions unknown glirastes tools policy ${policy}`);
    } else if (!Object.hasOwn(TOOLS_SUBCOMMANDS, sub!)) {
      problems.push(`mentions unknown glirastes tools ${sub}`);
    }
  }
  for (const match of source.matchAll(/\.glirastes\/[A-Za-z0-9._/-]*[A-Za-z0-9]/g)) {
    const path = match[0];
    if (!KNOWN_PATHS.has(path) && path !== '.glirastes/build' && !path.startsWith('.glirastes/build/')) {
      problems.push(`mentions unknown file ${path}`);
    }
  }
  if (!source.includes('never calls a model')) problems.push('states that Glirastes never calls a model');
  for (const [pattern, rule] of FORBIDDEN) {
    if (pattern.test(source)) problems.push(rule);
  }
  if (source.split('\n').length > 400) problems.push('stays under 400 lines');
  return problems;
}

export async function readSkill(name: string): Promise<string> {
  return readFile(join(findPackageSkillsDir(), name, 'SKILL.md'), 'utf8');
}
````

Create `src/cli/commands/skill-lint.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = [];

const VALID = [
  '---',
  'name: example-skill',
  'description: Use when an example needs a skill.',
  '---',
  '',
  '# Example',
  '',
  'Glirastes never calls a model; the coding agent does the work.',
  '',
  '## Boundaries',
  '',
  'Never edit `.glirastes/tool-policy.json`.',
  '',
  '## Workflow',
  '',
  '1. Run `glirastes tools refresh`.',
  '',
  '## Commands',
  '',
  '```bash',
  '# refresh first',
  'glirastes tools refresh',
  'glirastes tools describe --print <tool>',
  'glirastes tools policy raise <tool> write --reason "writes through a helper"',
  '```',
  '',
  '## Verification',
  '',
  '- `glirastes tools check` passes.',
  '',
].join('\n');

describe('skill lint', () => {
  it('accepts a skill that matches the CLI and reads its commands', () => {
    expect(lintSkill('example-skill', VALID)).toEqual([]);
    expect(skillCommands(VALID).map((command) => command.argv)).toEqual([
      ['glirastes', 'tools', 'refresh'],
      ['glirastes', 'tools', 'describe', '--print', '<tool>'],
      ['glirastes', 'tools', 'policy', 'raise', '<tool>', 'write', '--reason', 'writes through a helper'],
    ]);
  });

  it.each([
    ['an unknown subcommand', VALID.replace('glirastes tools refresh\n', 'glirastes tools generate\n'), 'command "glirastes tools generate": unknown tools subcommand generate'],
    ['an unknown flag', VALID.replace('--print <tool>', '--prints <tool>'), 'unknown option --prints'],
    ['an unknown policy subcommand', VALID.replace('policy raise', 'policy lower'), 'unknown tools policy subcommand lower'],
    ['a stale inline command', VALID.replace('Run `glirastes tools refresh`', 'Run `glirastes tools sync`'), 'mentions unknown glirastes tools sync'],
    ['an unknown file', VALID.replace('tool-policy.json`', 'tool-rules.json`'), 'mentions unknown file .glirastes/tool-rules.json'],
    ['a missing section', VALID.replace('## Verification', '## Checks'), 'has a "## Verification" section'],
    ['the missing model statement', VALID.replace('Glirastes never calls a model', 'Glirastes helps'), 'states that Glirastes never calls a model'],
    ['a forced reinstall', `${VALID}\nRun glirastes install --force.\n`, 'never teaches --force'],
    ['a wrong name', VALID.replace('name: example-skill', 'name: other-skill'), 'frontmatter names example-skill'],
  ])('reports %s', (_label, source, problem) => {
    expect(lintSkill('example-skill', source).join('\n')).toContain(problem);
  });

  it.each(LINTED_SKILLS)('%s matches the CLI, the files and the boundaries', async (name) => {
    expect(lintSkill(name, await readSkill(name))).toEqual([]);
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/skill-lint.test.ts --maxWorkers=4`
Expected: FAIL — `TOOLS_SUBCOMMANDS` and `POLICY_SUBCOMMANDS` are not exported from `./tools/index.js`, so every command check throws. `Test Files  1 failed (1)`, `Tests  10 failed (10)`

- [ ] **Step 3: Implement**

In `src/cli/commands/tools/check.ts`, replace:

```ts
import { parseToolArgs } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

/** Frozen refresh: never writes, never calls a model, never uses the network. */
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--strict', '--integrity-only', '--json'], values: ['--root'] });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const strict = args.flags.has('--strict') || config.ci.strict === true;
```

with:

```ts
import { parseToolArgs } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

export const CHECK_ARGS = { flags: ['--strict', '--integrity-only', '--json'], values: ['--root'] } as const;

/** Frozen refresh: never writes, never calls a model, never uses the network. */
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, CHECK_ARGS);
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const strict = args.flags.has('--strict') || config.ci.strict === true;
```

In `src/cli/commands/tools/index.ts`, replace:

```ts
  type ToolsPipelineResult,
} from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { runToolsDescribe } from './describe.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { POLICY_USAGE, runToolsPolicy } from './policy.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';
import { runToolsVerify } from './verify.js';

export interface ToolsCommandDependencies {
  cwd?: string;
```

with:

```ts
  type ToolsPipelineResult,
} from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError, type ToolArgsSpec } from './args.js';
import { CHECK_ARGS, runToolsCheck } from './check.js';
import { DESCRIBE_ARGS, runToolsDescribe } from './describe.js';
import { EVAL_ARGS, runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { POLICY_SUBCOMMANDS, POLICY_USAGE, runToolsPolicy } from './policy.js';
import { REFRESH_ARGS, runToolsRefresh } from './refresh.js';
import { RESOLVE_ARGS, runToolsResolve } from './resolve.js';
import { runToolsStatus, STATUS_ARGS } from './status.js';
import { runToolsVerify, VERIFY_ARGS } from './verify.js';

/**
 * Every `glirastes tools` subcommand with its flags, values and positional
 * arguments; `tools policy` has its own table. The shipped skills are linted
 * against these tables, so a skill can never teach a command that does not exist.
 */
export const TOOLS_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  refresh: REFRESH_ARGS,
  check: CHECK_ARGS,
  status: STATUS_ARGS,
  resolve: RESOLVE_ARGS,
  describe: DESCRIBE_ARGS,
  eval: EVAL_ARGS,
  verify: VERIFY_ARGS,
};
export { POLICY_SUBCOMMANDS };

export interface ToolsCommandDependencies {
  cwd?: string;
```

In `src/cli/commands/tools/status.ts`, replace:

```ts
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
}

export async function runToolsStatus(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--json'], values: ['--root'] });
  const entries = await readToolStatus(resolve(io.cwd, args.values.get('--root') ?? '.'));
  io.log(args.flags.has('--json') ? JSON.stringify({ schemaVersion: 1, tools: entries }) : formatToolStatus(entries));
  return 0;
```

with:

```ts
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
}

export const STATUS_ARGS = { flags: ['--json'], values: ['--root'] } as const;

export async function runToolsStatus(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, STATUS_ARGS);
  const entries = await readToolStatus(resolve(io.cwd, args.values.get('--root') ?? '.'));
  io.log(args.flags.has('--json') ? JSON.stringify({ schemaVersion: 1, tools: entries }) : formatToolStatus(entries));
  return 0;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/skill-lint.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  10 passed (10)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/__tests__/skill-lint.ts src/cli/commands/skill-lint.test.ts src/cli/commands/tools/check.ts src/cli/commands/tools/index.ts src/cli/commands/tools/status.ts
git commit -m "test(skills): lint shipped skills against the tools commands"
```

### Task 20: Skill `setting-up-glirastes`

**Files:**
- Modify: `skills/setting-up-glirastes/SKILL.md` (replaced as a whole), `skills/setting-up-glirastes/references/artifact-contract.md` (replaced: the files in `.glirastes`, who writes them), `skills/setting-up-glirastes/agents/openai.yaml` (default prompt)
- Test: `src/cli/commands/skill-lint.test.ts` (`setting-up-glirastes` joins `LINTED_SKILLS`), `src/cli/commands/setup-skill-workflow.test.ts` (refresh before the work lists instead of the hand-built inventory before `setup scan`), `src/cli/commands/install-skills.test.ts` (`glirastes tools refresh` instead of `glirastes setup scan`)

**Interfaces:**
- Consumes: Tasks 8–14 and 17 (commands and init scaffold), the guard phrases of `install-skills.test.ts` and `setup-skill-workflow.test.ts` that stay (Standalone, OpenRouter, explicit consent, Never send, Never add decorators, Autonomous/Interview mode, `glirastes sync`, `glirastes setup inspect --json`, existing coding agent) and `templates/interview.md` (unchanged).
- Produces: the canonical setup workflow (spec 4.6 table): inspect, check what init wrote, `tools refresh`, the two work lists with their skills, chat wiring through the framework skill, the `server-verified` declaration, check/status/doctor and one real authorized action, the CI job, the report; the app's model access through `OPENROUTER_API_KEY` entered by the developer; connecting only with consent.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/install-skills.test.ts`, replace:

```ts

    expect(source).toContain('Autonomous mode');
    expect(source).toContain('Interview mode');
    expect(source).toContain('glirastes setup scan');
    expect(source).toContain('glirastes sync');
    expect(source).toContain('Standalone');
    expect(source).toContain('OpenRouter');
```

with:

```ts

    expect(source).toContain('Autonomous mode');
    expect(source).toContain('Interview mode');
    expect(source).toContain('glirastes tools refresh');
    expect(source).not.toContain('glirastes setup scan');
    expect(source).toContain('glirastes sync');
    expect(source).toContain('Standalone');
    expect(source).toContain('OpenRouter');
```

In `src/cli/commands/setup-skill-workflow.test.ts`, replace:

```ts
import { findPackageSkillsDir } from './install-skills.js';

describe('bundled local-first setup workflow', () => {
  it('bridges fresh code to the positive inventory before attempting setup scan', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/SKILL.md'), 'utf8');
    expect(source).toContain('glirastes setup inspect --json');
    expect(source.indexOf('Generate the local execution inventory')).toBeGreaterThan(0);
    expect(source.indexOf('Generate the local execution inventory')).toBeLessThan(source.indexOf('glirastes setup scan'));
    expect(source).toContain('glirastes setup --dry-run --json');
    expect(source).toContain('Standalone');
    expect(source).toContain('existing coding agent');
    expect(source).not.toContain('glirastes setup sync --artifact');
    expect(source).not.toContain('Ask the user to choose exactly one mode');
  });
```

with:

```ts
import { findPackageSkillsDir } from './install-skills.js';

describe('bundled local-first setup workflow', () => {
  it('derives tools with refresh and works through the agent work lists before wiring the chat', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/SKILL.md'), 'utf8');
    expect(source).toContain('glirastes setup inspect --json');
    expect(source.indexOf('glirastes tools refresh')).toBeGreaterThan(0);
    expect(source.indexOf('glirastes tools refresh')).toBeLessThan(source.indexOf('glirastes tools resolve --print'));
    expect(source.indexOf('glirastes tools resolve --print')).toBeLessThan(source.indexOf('glirastes tools describe --print'));
    expect(source).toContain('Standalone');
    expect(source).toContain('existing coding agent');
    expect(source).not.toContain('glirastes setup scan');
    expect(source).not.toContain('glirastes setup sync --artifact');
    expect(source).not.toContain('Ask the user to choose exactly one mode');
  });
```

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = [];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes'];

const VALID = [
  '---',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/install-skills.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts --maxWorkers=4`
Expected: FAIL — the old skill has no Boundaries/Commands/Verification sections, no "never calls a model" and still teaches `glirastes setup scan`. `Test Files  3 failed (3)`, `Tests  3 failed | 32 passed (35)`

- [ ] **Step 3: Write the skill**

Replace the whole content of `skills/setting-up-glirastes/SKILL.md` with:

````markdown
---
name: setting-up-glirastes
description: Use when starting or resuming a Glirastes integration in an app, after glirastes init, or when an app's tools, chat or model access are not set up yet.
---

# Setting Up Glirastes

You are the existing coding agent of this app. You carry out the whole
integration in the app checkout; Glirastes never calls a model. The CLI reads
the code, writes the tool files and prints work lists; you supply judgement
where the code is not enough. A fresh app runs Standalone: it needs no
Platform account, no Glirastes key and no extra provider for you. Do not stop
after installing skills or hand routine work back to the developer. Ask only
material questions that the code and earlier decisions cannot answer.

## Boundaries

- Never send source, prompts, transcripts, credentials, business data, tool
  arguments or tool results to the Platform. Connecting is optional and needs
  the developer's explicit consent.
- Never infer authorization from routes or names. The app's own endpoint
  checks decide; Glirastes adds confirmation on top.
- Never add decorators or a hand-maintained tool list. Tools come from the
  source-derived generator: `glirastes tools refresh`.
- Never edit `.glirastes/tool-policy.json`, generated files (the inventory,
  `tool-contracts.json`, `tool-report.json`, `setup-artifact.json`, the
  receipt, `.glirastes/build/` and the generated module) or the `appId` in
  `.glirastes/tools.json`. Tool ids derive from that id; Platform pairing
  adopts it. Policy changes are the developer's `glirastes tools policy` calls.
- Use your own model configuration for this work. The app's chat needs its own
  model access: by default OpenRouter through `OPENROUTER_API_KEY` in the app's
  environment (for example `.env.local`). The developer enters the key; never
  read, copy or print it, and never reuse your coding-agent login for the app.
- Preserve app changes, tuned prompts, identities and modified installed
  skills. Never force-replace an installed skill; reconcile its instructions.
- No unsigned fallback, silent Managed downgrade or approval bypass. No push,
  merge, package publication or deployment without explicit authority.

## Workflow

1. Inspect the project: `glirastes setup inspect --json`, then the code itself
   (frontend, backend, auth, schemas, pages, URL filters, client actions).
   Manifest hints are not proof. If the app uses `@chainmatics/agentic-*` or
   `ai-tool.ts` files, follow `migrating-to-glirastes` first.
2. Check what `glirastes init` wrote: `.glirastes/tools.json` (app id, target
   app key, sources), `.glirastes/prompt-bundle.json` (local prompt text, app
   behaviour and response style), the `predev`/`prebuild` scripts and the hint
   in `AGENTS.md`/`CLAUDE.md`. Set `locale` to the app's language. For a
   separate backend or a non-React frontend, configure the sources as
   `integrating-glirastes-web` describes.
3. Run `glirastes tools refresh`. It lists added, changed, removed and excluded
   tools and ends with the open agent work. New tools are active immediately:
   GET runs directly, POST/PUT/PATCH ask first, delete, financial and external
   always ask first.
4. Work through `glirastes tools resolve --print` with
   `maintaining-glirastes-tools`, then `glirastes tools describe --print` with
   `describing-glirastes-tools`. Rerun `glirastes tools refresh` and
   `glirastes tools eval` until both lists are empty or every remaining item is
   a reported decision for the developer.
5. Wire the chat with the framework skill (`integrating-glirastes-nextjs` or
   `integrating-glirastes-web`) and the UI with `building-glirastes-chat-ui`:
   a server-side `resolvePrincipal` from the real session, the generated
   module, the navigation bridge, the app's model access.
6. Set `"glirastes": { "principal": "server-verified" }` in `package.json` only
   after the resolver is implemented and tested; it is a declaration Doctor
   checks, not authorization.
7. Run `glirastes tools check`, `glirastes tools status` and `glirastes doctor`.
   Start the app with its safe development path and prove one real,
   authorized chat tool action, and that an unauthenticated call is refused.
   Avoid production data and side effects.
8. Add the CI job: install, `glirastes tools check --json` and
   `glirastes tools eval`, no secrets. Commit code, `.glirastes` and the
   generated module together.
9. Report setup time (agent, downloads and waiting for input separately),
   changed files, tests and the action evidence. Validation, Doctor success and
   a successful action are distinct facts; report blockers precisely.

## Autonomous mode

Decide from code and earlier decisions. A write tool that should run without
asking, a narrower role set or an exclusion is a proposal for the developer,
never a change you make: list the exact `glirastes tools policy` command.

## Interview mode

Use [templates/interview.md](templates/interview.md) to resolve only material
ambiguity (availability, side effects, data class, confirmation, roles,
planner behaviour), grouped by tool family. Record the answers as data in the
files you may write, and the policy answers as commands for the developer.

## Connecting the Platform

Only with the developer's explicit consent: `glirastes connect --base-url
<confirmed-control-plane-url>`. Pairing adopts the app id of
`.glirastes/tools.json` and refuses a different one. Afterwards
`glirastes sync` uploads the current technical result; it never reassesses
source and never activates anything. Existing Managed apps keep `--managed`
for setup and Doctor.

## Commands

```bash
glirastes setup inspect --json
glirastes tools refresh
glirastes tools resolve --print
glirastes tools describe --print
glirastes tools eval
glirastes tools status
glirastes tools check --json
glirastes doctor
```

Read [references/artifact-contract.md](references/artifact-contract.md) for
what each file in `.glirastes` is and who writes it.

## Verification

- `glirastes tools check` reports `Tool outputs match the code.`; the CI job
  runs it with `glirastes tools eval` and no secrets.
- `glirastes tools status` lists the expected tools; disabled ones carry a
  finding you reported.
- A real prompt performs one authorized tool action; an unauthenticated or
  cross-tenant request is refused by the endpoint.
- Adding, changing and removing a route, a page and a filter changes the tools
  after `glirastes tools refresh`, without editing any tool list by hand.
- `glirastes doctor` passes; the developer entered the model key themselves.
````

Replace the whole content of `skills/setting-up-glirastes/agents/openai.yaml` with:

```yaml
interface:
  display_name: "Set Up Glirastes"
  short_description: "Integrate Glirastes tools and chat locally"
  default_prompt: "Use $setting-up-glirastes to integrate Glirastes in this app: run glirastes tools refresh, work through the work lists and prove one authorized tool action."
```

Replace the whole content of `skills/setting-up-glirastes/references/artifact-contract.md` with:

```markdown
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

## Outputs

| File | Contract |
| --- | --- |
| `.glirastes/foundation-execution-inventory.json` | `FoundationExecutionInventorySchema` from `glirastes/codegen`: `schemaVersion: 2`, `targetAppKey` and the executions with their stable ids. |
| `.glirastes/tool-tombstones.json` | Removed tools; a tool that comes back gets a new id. |
| `.glirastes/tool-contracts.json` | Contracts, defaults and checked search data per tool; local only. |
| `.glirastes/tool-report.json` | Content-free findings, quality and exclusions per tool. |
| `.glirastes/setup-artifact.json` | `AppSetupArtifactSchema`; also the content-free capability report a connected runner uploads. |
| `.glirastes/build/runtime-manifest.json`, `.glirastes/build/prompt-manifest.json`, `.glirastes/setup-receipt.json` | Digest chain the Docker build verifies with `GLIRASTES_TOOLS_MODE=integrity`. |
| The generated module (`src/generated/glirastes/tools.generated.ts` by default) | `setupArtifact`, `toolCatalog`, `createToolBindings()`, `toolSearchSemantics`, `GeneratedToolId`. |

## Principal

Set `"glirastes": { "principal": "server-verified" }` in `package.json` only
after the real server-side `resolvePrincipal` is implemented and tested. Doctor
checks the declaration; it never replaces the endpoint's own authorization.

The schema-only check `scripts/validate-artifact.ts` of this skill validates a
setup artifact; resolve its path relative to the installed skill. It does not
replace `glirastes tools check`, Doctor or a real tool action.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/install-skills.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts src/cli/commands/agent-setup.test.ts --maxWorkers=4`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  35 passed (35)`; `src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts src/cli/commands/agent-setup.test.ts` reports `Test Files  4 passed (4)`, `Tests  49 passed (49)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/setting-up-glirastes/SKILL.md skills/setting-up-glirastes/agents/openai.yaml skills/setting-up-glirastes/references/artifact-contract.md src/cli/commands/install-skills.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts
git commit -m "docs(skills): set up glirastes through tools refresh and work lists"
```

### Task 21: Skill `integrating-glirastes-nextjs`

**Files:**
- Modify: `skills/integrating-glirastes-nextjs/SKILL.md` (replaced as a whole), `docs/managed-runtime-sync.md` (`.chat(model)`, `tool_contract_rejected`)
- Test: `src/cli/commands/skill-lint.test.ts` (`integrating-glirastes-nextjs` joins `LINTED_SKILLS`); Task 27 type-checks the chat route of this skill against the SDK

**Interfaces:**
- Consumes: Task 4 `toolSearchSemantics`, Task 16 `tool_contract_rejected`, P09 `createRuntimeMetricsSinkFromEnv` and the P09 checkpoint items 1 and 6 (one sink per process at module scope; `.chat(id)` for OpenRouter; the Connected exception), P04 bridge and sources, `createGeneratedRuntimeSource` (wraps `createLocalRuntimeSource` and `createContractBindings`).
- Produces: the Next.js integration (spec 4.6 table): sources and scripts (incl. `--watch`), a server-only `resolvePrincipal`, a complete chat route (`createGeneratedRuntimeSource`, `materializeManifestToolRegistry` behind a pinned snapshot, `toolSemantics`, `openrouter.chat(...)`, the optional metrics sink), the navigation bridge, closed URL filters, client actions with contracts, the chat mount; the guard phrases (`source-derived generator`, `glirastes sync`, `resolvePrincipal`, `createLocalRuntimeSource`, Standalone, navigation, filter) stay. Roadmap row "Skill `integrating-glirastes-nextjs`: … Connected-Ausnahme für Metriken und den Verdrahtungsschritt".

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes'];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs'];

const VALID = [
  '---',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/skill-lint.test.ts --maxWorkers=4`
Expected: FAIL — the old Next.js skill fails the lint (sections, commands, model statement). `Test Files  1 failed (1)`, `Tests  1 failed | 11 passed (12)`

- [ ] **Step 3: Write the skill**

In `docs/managed-runtime-sync.md`, replace:

```markdown
own `instanceId`.

Cost is `provider-reported` when OpenRouter returns `usage.cost`, also through
`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' })`. A `modelPricing`
table on the handler estimates the rest (`price-table`, with its version).
Without either, the cost stays unknown (`null`), never 0. A known cost also
counts against the turn's `maxEstimatedCostUsd`. The legacy Lancer `telemetry`
```

with:

```markdown
own `instanceId`.

Cost is `provider-reported` when OpenRouter returns `usage.cost`, also through
`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' }).chat(model)`; use
`.chat`, because `createOpenAI(...)(model)` talks to the Responses API, whose
usage the handler does not read. An endpoint that refuses a call its tool
schema accepted (400 or 422) adds a content-free `tool_contract_rejected`
event to the same sink, in its own batch. A `modelPricing`
table on the handler estimates the rest (`price-table`, with its version).
Without either, the cost stays unknown (`null`), never 0. A known cost also
counts against the turn's `maxEstimatedCostUsd`. The legacy Lancer `telemetry`
```

Replace the whole content of `skills/integrating-glirastes-nextjs/SKILL.md` with:

````markdown
---
name: integrating-glirastes-nextjs
description: Use when adding Glirastes chat, source-derived tools, navigation, URL filters, client actions, metrics or speech input to a Next.js App Router application.
---

# Integrating Glirastes into Next.js

Read `setting-up-glirastes` first. You, the app's coding agent, do the work;
Glirastes never calls a model. A fresh Standalone app needs no Platform
account; preserve an existing Connected or Managed configuration. Tools come
from the source-derived generator (`glirastes tools refresh`), never from a
second, hand-maintained catalogue.

## Boundaries

- Keep final authorization in the app: every endpoint keeps its own session
  and permission checks; `resolvePrincipal` only tells the runtime who asks.
- Never trust identity, tenant or role fields from the browser. Never
  substitute one global tenant or disable tenant checks for a default id.
- Never edit `.glirastes/tool-policy.json`, generated files or the `appId` in
  `.glirastes/tools.json`; propose `glirastes tools policy` commands instead.
- The app's model key (`OPENROUTER_API_KEY`) is entered by the developer into
  the app environment; never read, copy or print it.
- Business content, prompts and tool results stay in the app. The normal chat
  path makes no Control Plane request; the one exception is a Connected app's
  metrics sink, which sends content-free batches off the turn path.

## Workflow

1. Sources in `.glirastes/tools.json`: `next-app` for route handlers
   (`src/app/api` by default, `{ "kind": "next-app", "apiDir": "app/api" }`
   otherwise), `next-pages` for navigation, `url-filters` for nuqs or
   `searchParams` filters, `react-actions` for `useAiClientAction`. Keep the
   `predev` (`glirastes tools refresh --keep-going`) and `prebuild`
   (`glirastes tools refresh`) scripts; `glirastes tools refresh --watch` next
   to `next dev` keeps the tools current while you edit.
2. Server-only `resolvePrincipal(request)` returns the verified `subjectId`,
   `tenantId`, roles and attributes from the real session, or `undefined` for
   an unauthenticated request.
3. The chat route boots the local runtime from the generated module
   (`createGeneratedRuntimeSource` wraps `createLocalRuntimeSource` and
   `createContractBindings`). Restart after a refresh; Managed apps use the
   verified Managed revision source with the same local bindings instead.

   ```ts
   // src/app/api/chat/route.ts
   import { createOpenAI } from '@ai-sdk/openai';
   import {
     createGeneratedRuntimeSource, createRuntimeMetricsSinkFromEnv, materializeManifestToolRegistry,
   } from 'glirastes/runtime';
   import { createAiChatHandler } from 'glirastes/server/nextjs';
   import * as generated from '@/generated/glirastes/tools.generated';
   import { resolvePrincipal } from '@/lib/glirastes-principal';

   const localLimits = {
     maxModelSteps: 6, maxToolCalls: 8, totalTimeoutMs: 60_000, toolTimeoutMs: 15_000,
     maxInputTokens: 40_000, maxOutputTokens: 4_000, maxEstimatedCostUsd: 0.5,
     maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
     delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
   };
   const systemPrompt = 'Use the tools of this app. Ask one short question when the target is unclear.';
   const glirastes = createGeneratedRuntimeSource(generated, { localLimits });
   // One sink per process, at module scope. Standalone apps get undefined and stay network-silent.
   const metrics = createRuntimeMetricsSinkFromEnv();
   const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });

   export const runtime = 'nodejs';
   export const POST = createAiChatHandler({
     managedRuntime: { resolvePrincipal, resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context) },
     // With managedRuntime the handler always pins a snapshot; without one no tool is offered.
     loadTools: ({ turnSnapshot }) => (turnSnapshot
       ? materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings })
       : {}),
     toolSemantics: generated.toolSearchSemantics,
     model: openrouter.chat('anthropic/claude-sonnet-5.5'),
     systemPrompt,
     ...(metrics ? { metrics } : {}),
   });
   ```

   Use `.chat(model)`: `createOpenAI(...)(model)` talks to the Responses API,
   whose usage the handler does not read, so turn costs would stay unknown.
   `managedRuntime` names the shared turn guard, not a Platform purchase.
   `toolSemantics` gives `find_tools` the checked synonyms; it never grants a
   tool. With `metrics`, an endpoint that refuses a call its schema accepted
   (400 or 422) is reported as `tool_contract_rejected`, without content.
4. Mount the navigation bridge once in the root layout, as a client component,
   so `ui.navigate` and the `ui.filter.*` tools can run:

   ```tsx
   'use client';
   import { useRouter } from 'next/navigation';
   import { useGlirastesNavigationBridge } from 'glirastes/react';

   export function GlirastesNavigationBridge() {
     const router = useRouter();
     useGlirastesNavigationBridge({ push: (href) => router.push(href) });
     return null;
   }
   ```

   Without the bridge, navigation and filter tools stay disabled
   (`navigation-bridge-missing`).
5. Filters: read URL parameters with closed nuqs parsers where the domain is
   closed (`parseAsStringLiteral([...])`, `parseAsInteger`, `parseAsArrayOf`);
   `parseAsString` stays open and is reported as `filter-domain-open`.
6. Client actions: `useAiClientAction('tasks.highlight', handler, contract)`
   where the state lives, with a Zod payload contract as third argument. A
   handler that writes through a helper, a Server Action or a mutation hook is
   flagged (`ui-action-write-unproven`); the developer raises it with
   `glirastes tools policy raise <tool> write`.
7. Mount the chat with `building-glirastes-chat-ui`
   (`VercelAiChat endpoint="/api/chat"` from `glirastes/react/vercel`).
8. Run `glirastes tools refresh`, the work lists of `setting-up-glirastes`,
   `glirastes tools check` and `glirastes doctor`, then the real chat test.
   Connecting is optional: `glirastes connect --base-url <url>`, then
   `glirastes sync` uploads the technical result.

## Commands

```bash
glirastes tools refresh
glirastes tools refresh --watch
glirastes tools status
glirastes tools check
glirastes tools check --integrity-only
glirastes doctor
```

## Verification

- An unauthenticated, cross-tenant or tampered principal cannot execute tools;
  the endpoint refuses the call itself.
- The normal chat path makes no Control Plane request; only a Connected app's
  metrics sink sends content-free batches.
- A real prompt performs one successful tool action; a write tool asks first.
- Adding, changing and deleting a route, a page and a URL filter changes the
  tools after `glirastes tools refresh`; a removed tool cannot be called.
- The Docker build runs with `GLIRASTES_TOOLS_MODE=integrity`, so the build's
  refresh only verifies the committed digest chain.
- Build, contract, browser, privacy and rollback tests pass.

## Stop conditions

Fail closed when there is no principal resolver, no matching local binding or
no locally authorized tool. If the generator cannot type an endpoint, the tool
stays disabled with a finding: resolve it with `maintaining-glirastes-tools`
instead of inventing a permissive schema. A passing Doctor does not prove a
live action.
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/skill-lint.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts --maxWorkers=4`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  12 passed (12)`; `src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts` reports `Test Files  3 passed (3)`, `Tests  36 passed (36)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add docs/managed-runtime-sync.md skills/integrating-glirastes-nextjs/SKILL.md src/cli/commands/skill-lint.test.ts
git commit -m "docs(skills): wire next.js chat, metrics and search semantics"
```

### Task 22: Skill `integrating-glirastes-web`

**Files:**
- Create: `skills/integrating-glirastes-web/SKILL.md`
- Modify: `src/cli/commands/installer-parts.ts` (stack `web` from `@nestjs/core`, `vue` or `vite`; Next.js wins; framework part ⇒ `integrating-glirastes-web`)
- Test: `src/cli/commands/skill-lint.test.ts` (joins `LINTED_SKILLS`), `src/cli/commands/installer-parts.test.ts` (web detection)

**Interfaces:**
- Consumes: `glirastes/browser` (`registerNavigationBridge`, `registerAiClientAction`, `defineQueryFilters`), `glirastes/embed` (`defineGlirastesChatElement`), `createAiChatHandler`, `createFetchInternalApiCaller`.
- Produces: `DetectedStack = 'nextjs' | 'web'`; the separate-backend skill with an honest support table for this SDK version (Next.js route handlers, client actions in script files, `defineQueryFilters` views are read; NestJS, FastAPI/OpenAPI, react-router/vue-router pages and `.vue` script blocks are P06 and reported as open gaps, never faked).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/installer-parts.test.ts`, replace:

```ts
      'utf8',
    );
    expect(await detectStack(rootDir)).toBe('nextjs');
  });

  it('detects nothing in a project without a known framework', async () => {
```

with:

```ts
      'utf8',
    );
    expect(await detectStack(rootDir)).toBe('nextjs');
  });

  it.each([
    [{ vue: '^3.5.0', vite: '^7.0.0' }],
    [{ '@nestjs/core': '^11.0.0' }],
  ])('detects a web app with a separate backend from %j', async (dependencies) => {
    expect(await detectStack(await projectWith(dependencies))).toBe('web');
    expect(await detectStack(await projectWith({ ...dependencies, next: '^16.0.0' }))).toBe('nextjs');
    expect(resolvePartSkills(['framework'], { stack: 'web' })).toEqual(['integrating-glirastes-web']);
  });

  it('detects nothing in a project without a known framework', async () => {
```

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs'];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web'];

const VALID = [
  '---',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/installer-parts.test.ts src/cli/commands/skill-lint.test.ts --maxWorkers=4`
Expected: FAIL — the skill file does not exist (`ENOENT` in the lint) and `detectStack` returns `null` for Vue and NestJS apps. `Test Files  2 failed (2)`, `Tests  3 failed | 24 passed (27)`

- [ ] **Step 3: Write the skill**

Create `skills/integrating-glirastes-web/SKILL.md`:

````markdown
---
name: integrating-glirastes-web
description: Use when integrating Glirastes into an app with a separate backend (NestJS, FastAPI or another API), a non-React frontend (Vue, plain web components) or a Node sidecar next to a non-Node backend.
---

# Integrating Glirastes into Web Apps With a Separate Backend

Read `setting-up-glirastes` first. You, the app's coding agent, do the work;
Glirastes never calls a model. The generator reads only what this SDK version
supports (table below). Where a part is not read yet, report the gap; never
replace the generator with a hand-written tool list.

## Boundaries

- The backend keeps all authorization. The chat handler calls the app's API
  with the user's own cookie or `Authorization` header, never with a service
  account that has more rights than the user.
- Never edit `.glirastes/tool-policy.json`, generated files or the `appId` in
  `.glirastes/tools.json`.
- The model key (`OPENROUTER_API_KEY`) lives only in the environment of the
  process that runs the chat handler; the developer enters it.
- Search results, tool arguments and results never go to the Glirastes
  Platform.

## Support in this version

| Part of the app | Read by `glirastes tools refresh` | Source in `.glirastes/tools.json` |
| --- | --- | --- |
| Next.js route handlers | yes | `next-app` |
| Client actions in `.ts`, `.tsx`, `.js` files (`useAiClientAction`, `registerAiClientAction`, `bus.subscribeById`) | yes, also in Vue apps | `react-actions` |
| URL filters of SPA views declared with `defineQueryFilters` | yes | `url-filters` |
| NestJS controllers, FastAPI through OpenAPI, react-router and vue-router pages, `<script>` blocks of `.vue` files | not yet | report as an open gap |

## Workflow

1. Decide where the chat handler runs: in a Node backend next to the API, or
   in a small declared Node sidecar when the API is not Node (FastAPI). The
   handler is framework-neutral: `createAiChatHandler` (from
   `glirastes/server/nextjs`, despite the name) takes a Web `Request` and
   returns a `Response`; adapt your framework's request object to it.
2. Endpoint tools call the API through an internal caller that forwards the
   user's session: `createFetchInternalApiCaller({ baseUrl, defaultHeaders })`
   from `glirastes/server`, built per request with that request's cookie or
   authorization header. Never forward anything but the user's own credentials.
3. Frontend actions and navigation without React: in the browser entry module
   use `glirastes/browser`:

   ```ts
   import { defineQueryFilters, registerAiClientAction, registerNavigationBridge } from 'glirastes/browser';
   import { z } from 'zod';

   registerNavigationBridge({ push: (href) => router.push(href) });
   export const taskFilters = defineQueryFilters({
     path: '/tasks',
     filters: { status: ['open', 'done'] },
   });
   registerAiClientAction('tasks.highlight', (payload) => highlight(payload.taskId),
     z.object({ taskId: z.string() }).strict());
   ```

   Literal ids and literal filter definitions only: the generator reads them
   from code. Keep registrations in `.ts` files, not in `.vue` script blocks.
4. Embed the chat without React code in the app:
   `defineGlirastesChatElement()` from `glirastes/embed` registers
   `<glirastes-chat endpoint="/api/chat">`. It renders in a Shadow DOM,
   themes through `--glirastes-chat-*` CSS variables, emits
   `glirastes-chat:ready`, `:status`, `:tool-result` and `:error`, and frees
   the microphone when removed. The page needs `react`, `react-dom`,
   `@ai-sdk/react` and `ai` installed.
5. Configure `.glirastes/tools.json` with the supported sources, run
   `glirastes tools refresh` and the work lists of `setting-up-glirastes`.
   For the parts marked "not yet", write down which endpoints, pages or
   actions are missing as tools and stop there.
6. Build the backend and the frontend with the refresh step of their build
   (`glirastes tools refresh` locally, frozen in CI, integrity in Docker) and
   commit `.glirastes` with the code.

## Commands

```bash
glirastes tools refresh
glirastes tools status
glirastes tools check
glirastes tools check --integrity-only
```

## Verification

- The chat handler refuses a request without a valid session; the API
  refuses a tool call the user may not make.
- `glirastes tools status` lists the client actions, filters and endpoints the
  table promises for this app; the open gaps are reported, not faked.
- `<glirastes-chat>` mounts and unmounts without leaving a microphone stream
  open, and keyboard use works.
- `glirastes tools check` passes in CI without secrets.
````

In `src/cli/commands/installer-parts.ts`, replace:

```ts

export type InstallerPart = (typeof INSTALLER_PARTS)[number];

/** Stacks the installer can recognise on its own. */
export type DetectedStack = 'nextjs';

export interface PartResolutionContext {
  /** What `detectStack` found, or `null` when nothing was recognised. */
```

with:

```ts

export type InstallerPart = (typeof INSTALLER_PARTS)[number];

/** Stacks the installer can recognise on its own: Next.js, or a web app with a separate backend. */
export type DetectedStack = 'nextjs' | 'web';

export interface PartResolutionContext {
  /** What `detectStack` found, or `null` when nothing was recognised. */
```

In `src/cli/commands/installer-parts.ts`, replace:

```ts
 */
const FRAMEWORK_SKILLS: Record<DetectedStack, ReadonlyArray<string>> = {
  nextjs: ['integrating-glirastes-nextjs'],
};

const PART_SKILLS: Record<
```

with:

```ts
 */
const FRAMEWORK_SKILLS: Record<DetectedStack, ReadonlyArray<string>> = {
  nextjs: ['integrating-glirastes-nextjs'],
  web: ['integrating-glirastes-web'],
};

const PART_SKILLS: Record<
```

In `src/cli/commands/installer-parts.ts`, replace:

```ts
  setup: ['setting-up-glirastes'],
};

/** Dependency whose presence proves a stack, rather than a heuristic. */
const STACK_MARKERS: ReadonlyArray<[DetectedStack, string]> = [
  ['nextjs', 'next'],
];

/**
```

with:

```ts
  setup: ['setting-up-glirastes'],
};

/** Dependency whose presence proves a stack, rather than a heuristic; Next.js wins. */
const STACK_MARKERS: ReadonlyArray<[DetectedStack, string]> = [
  ['nextjs', 'next'],
  ['web', '@nestjs/core'],
  ['web', 'vue'],
  ['web', 'vite'],
];

/**
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/installer-parts.test.ts src/cli/commands/skill-lint.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/installer-parts.test.ts src/cli/installer-e2e.test.ts src/cli/commands/install-skills.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  27 passed (27)`; `src/cli/commands/skill-lint.test.ts src/cli/commands/installer-parts.test.ts src/cli/installer-e2e.test.ts src/cli/commands/install-skills.test.ts` reports `Test Files  4 passed (4)`, `Tests  56 passed (56)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/integrating-glirastes-web/SKILL.md src/cli/commands/installer-parts.test.ts src/cli/commands/installer-parts.ts src/cli/commands/skill-lint.test.ts
git commit -m "docs(skills): integrate separate backends and non-react frontends"
```

### Task 23: Skill `maintaining-glirastes-tools`

**Files:**
- Modify: `skills/maintaining-glirastes-tools/SKILL.md` (replaced as a whole)
- Test: `src/cli/commands/skill-lint.test.ts` (joins `LINTED_SKILLS`), `src/cli/commands/setup-skill-workflow.test.ts` (`glirastes tools resolve --print` and `glirastes tools check` instead of `glirastes setup --dry-run`)

**Interfaces:**
- Consumes: Task 8 work list format, Task 13 policy commands, the finding codes of Tasks 1–7, P04b's D16 labels.
- Produces: the stage-1 skill (spec 4.6 table): what the agent may write, the work list fields and how to answer each target kind, the finding table, the developer-only policy commands with the D16 lock (a connected Platform may relax code-default confirmations up to `write`; `confirm` locks, `reset` lifts), the change workflow (restart in Standalone, `glirastes sync` when Connected).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/setup-skill-workflow.test.ts`, replace:

```ts

  it('maintains local code changes without making platform sync mandatory', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'maintaining-glirastes-tools/SKILL.md'), 'utf8');
    for (const required of ['Standalone', 'navigation', 'filter', 'glirastes setup --dry-run', 'glirastes doctor', 'restart']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('Platform interviewer');
```

with:

```ts

  it('maintains local code changes without making platform sync mandatory', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'maintaining-glirastes-tools/SKILL.md'), 'utf8');
    for (const required of ['Standalone', 'navigation', 'filter', 'glirastes tools resolve --print', 'glirastes tools check', 'glirastes doctor', 'restart']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('Platform interviewer');
```

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web'];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools'];

const VALID = [
  '---',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts --maxWorkers=4`
Expected: FAIL — the old skill fails the lint and does not mention `glirastes tools resolve --print` or `glirastes tools check`. `Test Files  2 failed (2)`, `Tests  2 failed | 17 passed (19)`

- [ ] **Step 3: Write the skill**

Replace the whole content of `skills/maintaining-glirastes-tools/SKILL.md` with:

````markdown
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
  a list shorter.
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
| `contract-stale` | update the entry or `contract.ts` for the changed interface |
| `schema-not-exported`, `schema-module-unloadable`, `schema-content-rejected`, `parameter-collision`, `contract-effect-invalid` | the app code the message names; a schema moves into a side-effect-free module (a sibling `contract.ts` or a schema file) that the handler imports, never into a new export of `route.ts`, whose exports Next.js type-checks |
| `ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`, `definition-id-invalid`, `contract-presentation-invalid` | the registration or contract in `target.files`: a literal action id, a valid contract id or presentation |
| `tool-semantics-invalid` | the entry `target.key` names in `.glirastes/tool-semantics.json`; keep its human text, fix only the shape |
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
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts --maxWorkers=4`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  19 passed (19)`; `src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts` reports `Test Files  3 passed (3)`, `Tests  38 passed (38)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/maintaining-glirastes-tools/SKILL.md src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts
git commit -m "docs(skills): resolve stage-1 findings from the work list"
```

### Task 24: Skill `describing-glirastes-tools`

**Files:**
- Create: `skills/describing-glirastes-tools/SKILL.md`
- Modify: `src/cli/commands/installer-parts.ts` (the `tools` part installs it next to `maintaining-glirastes-tools`)
- Test: `src/cli/commands/skill-lint.test.ts` (joins `LINTED_SKILLS`), `src/cli/commands/installer-parts.test.ts`, `src/cli/installer-e2e.test.ts`, `src/cli/commands/install-skills.test.ts` (the tools part lists both skills)

**Interfaces:**
- Consumes: Task 10 work list format, Task 9 eval, Task 14 verify, the Task 3 data model.
- Produces: the stage-2 skill (spec 4.6 table, 4.7): boundaries (only open or own fields, evidence, risk raising, neutral examples), the work list targets, the workflow per module, the eval loop with one revision, `--write-contracts`, the developer's `verify`, an example entry.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/install-skills.test.ts`, replace:

```ts
const foundationSkills = [
  'integrating-glirastes-nextjs',
  'maintaining-glirastes-tools',
  'building-glirastes-chat-ui',
] as const;
const setupSkill = 'setting-up-glirastes';
```

with:

```ts
const foundationSkills = [
  'integrating-glirastes-nextjs',
  'maintaining-glirastes-tools',
  'describing-glirastes-tools',
  'building-glirastes-chat-ui',
] as const;
const setupSkill = 'setting-up-glirastes';
```

In `src/cli/commands/installer-parts.test.ts`, replace:

```ts
    expect(resolvePartSkills(['chat-ui'], { stack: 'nextjs' }))
      .toEqual(['building-glirastes-chat-ui']);
    expect(resolvePartSkills(['tools'], { stack: 'nextjs' }))
      .toEqual(['maintaining-glirastes-tools']);
    expect(resolvePartSkills(['setup'], { stack: 'nextjs' }))
      .toEqual(['setting-up-glirastes']);
  });
```

with:

```ts
    expect(resolvePartSkills(['chat-ui'], { stack: 'nextjs' }))
      .toEqual(['building-glirastes-chat-ui']);
    expect(resolvePartSkills(['tools'], { stack: 'nextjs' }))
      .toEqual(['maintaining-glirastes-tools', 'describing-glirastes-tools']);
    expect(resolvePartSkills(['setup'], { stack: 'nextjs' }))
      .toEqual(['setting-up-glirastes']);
  });
```

In `src/cli/commands/installer-parts.test.ts`, replace:

```ts

  it('resolves the framework part to nothing when no stack was detected', () => {
    expect(resolvePartSkills(['framework', 'tools'], { stack: null }))
      .toEqual(['maintaining-glirastes-tools']);
  });

  it('never repeats a skill selected through two parts', () => {
```

with:

```ts

  it('resolves the framework part to nothing when no stack was detected', () => {
    expect(resolvePartSkills(['framework', 'tools'], { stack: null }))
      .toEqual(['maintaining-glirastes-tools', 'describing-glirastes-tools']);
  });

  it('never repeats a skill selected through two parts', () => {
```

In `src/cli/commands/installer-parts.test.ts`, replace:

```ts
    expect(resolved).toEqual([
      'integrating-glirastes-nextjs',
      'maintaining-glirastes-tools',
    ]);
  });

```

with:

```ts
    expect(resolved).toEqual([
      'integrating-glirastes-nextjs',
      'maintaining-glirastes-tools',
      'describing-glirastes-tools',
    ]);
  });

```

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools'];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools', 'describing-glirastes-tools'];

const VALID = [
  '---',
```

In `src/cli/installer-e2e.test.ts`, replace:

```ts
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}).sort())
      .toEqual([
        'building-glirastes-chat-ui',
        'integrating-glirastes-nextjs',
        'maintaining-glirastes-tools',
        'setting-up-glirastes',
```

with:

```ts
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}).sort())
      .toEqual([
        'building-glirastes-chat-ui',
        'describing-glirastes-tools',
        'integrating-glirastes-nextjs',
        'maintaining-glirastes-tools',
        'setting-up-glirastes',
```

In `src/cli/installer-e2e.test.ts`, replace:

```ts

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(Object.keys(hostRecord(manifest, 'codex')?.skills ?? {}))
      .toEqual(['maintaining-glirastes-tools']);
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}))
      .toEqual(['building-glirastes-chat-ui']);
  });
```

with:

```ts

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(Object.keys(hostRecord(manifest, 'codex')?.skills ?? {}))
      .toEqual(['describing-glirastes-tools', 'maintaining-glirastes-tools']);
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}))
      .toEqual(['building-glirastes-chat-ui']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/install-skills.test.ts src/cli/commands/installer-parts.test.ts src/cli/commands/skill-lint.test.ts src/cli/installer-e2e.test.ts --maxWorkers=4`
Expected: FAIL — the skill does not exist and the tools part resolves to `maintaining-glirastes-tools` only. `Test Files  4 failed (4)`, `Tests  9 failed | 50 passed (59)`

- [ ] **Step 3: Write the skill**

Create `skills/describing-glirastes-tools/SKILL.md`:

````markdown
---
name: describing-glirastes-tools
description: Use when glirastes tools refresh says tools need a better description, tools have template descriptions or field-name schemas, glirastes tools eval reports ambiguous routing, or an endpoint rejected calls its schema accepted.
---

# Describing Glirastes Tools

Stage 2 makes the model understand every tool as if a developer had documented
it: description, typed input and output schemas, synonyms, titles, display
texts, confirmation hints and example sentences. You, the app's coding agent,
write them; Glirastes never calls a model. `glirastes tools describe --print`
says what is missing and where it goes; the next refresh checks every entry
and ignores an invalid one (`resolution-rejected`) while the tool keeps its
fallback. Tools stay active without stage 2, only less well described.

## Boundaries

- Write only `.glirastes/tool-semantics.json`, `.glirastes/tool-resolutions.json`
  and, with `--write-contracts`, new `contract.ts` files next to route
  handlers. Never change a handler, `.glirastes/tool-policy.json` or a
  generated file.
- Fill only open fields and replace only your own earlier output. Fields in
  `protectedFields` (written by a human, supplied by the code or locked by a
  review) stay exactly as they are.
- Every input key needs evidence in the code, and every key the handler reads
  stays in the schema. Effects may only raise the risk, never lower it.
- Examples are neutral sentences a user could type; no customer names,
  e-mail addresses, phone or account numbers, no secrets or keys.

## Work list

Each item of `glirastes tools describe --print` names the tool, its module,
its `gaps`, the `files` to read, the code `evidence` (route, parameters,
`interfaceDigest`, risk, current quality), `protectedFields`,
`missingExamples` (languages), `routing` (sentences that miss the tool) and
the targets:

- `targets.semantics`: the entry for `.glirastes/tool-semantics.json`. Add it
  to `tools`, or merge it into the entry with the same `stableKey`.
- `targets.schema`: the typed contract for `.glirastes/tool-resolutions.json`
  (`tools["<stableKey>"]`), when the code only shows field names or the
  output is opaque.
- `targets.contract`: with `--write-contracts`, a new `contract.ts` (Zod) next
  to the route handler; afterwards the generator reads it as code.

Tools of one module come together (`modules`): describe them together and say
in each description which neighbour fits better for which request.

## Workflow

1. Run `glirastes tools describe --print`. Name tools to describe only those
   (for example a tool an endpoint rejected calls for), or `--all` to review
   every tool.
2. For each module, read the handler, the services and schemas it imports and
   the pages that use it. Then write, replacing every `<…>` placeholder:
   - `description`: what the tool does, when it fits, which tool fits better.
   - The input schema: types, required fields, enums, formats, bounds and a
     description per parameter; strict JSON Schema 2020-12, an object with
     `additionalProperties: false`, at most 32 KB. An output schema where the
     returned shape is visible in code.
   - `synonyms` (up to 20 per language) and `examples` (3 to 5 per language
     listed in `languages`), plus `exampleCalls` whose `input` matches the
     input schema.
   - `title` per language, `presentation` (singular, plural, the confirmation
     question) in the app's locale, `approvalHint` for tools that ask first.
3. Mark every field you wrote with `"origin": { "<field>": "agent" }` and keep
   `"agent": { "model": "<you>", "interfaceDigest": "<as printed>" }`.
4. Run `glirastes tools refresh`, then `glirastes tools eval`. Each
   `routing-ambiguous` line names the sentence and the tools ahead of it:
   sharpen the descriptions and synonyms of both tools once. What still fails
   stays reported as a warning; do not loop.
5. Run `glirastes tools describe --print` again until only tools you cannot
   improve from the code are left. After a code change, a tool reappears with
   `semantics-stale` or `enrichment-stale`; describe it again.
6. The developer reviews the diff and locks the reviewed entries with
   `glirastes tools verify <tool>`; you never lock your own output.

```json
{
  "stableKey": "GET /api/tasks",
  "description": "Lists the caller's tasks, optionally by status. Use tasks.search for full-text search.",
  "synonyms": { "de": ["Aufgabenliste", "offene Aufgaben"], "en": ["to-dos"] },
  "examples": {
    "de": ["Zeig meine offenen Aufgaben", "Welche Aufgaben sind erledigt?", "Liste alle Aufgaben"],
    "en": ["list my open tasks", "which tasks are done", "show the task list"]
  },
  "exampleCalls": [{ "sentence": "list my open tasks", "input": { "status": ["open"] } }],
  "origin": { "description": "agent", "synonyms": "agent", "examples": "agent", "exampleCalls": "agent" },
  "agent": { "model": "claude-code", "interfaceDigest": "sha256:…" }
}
```

## Commands

```bash
glirastes tools describe --print
glirastes tools describe --print <tool>
glirastes tools describe --print --all
glirastes tools describe --print --write-contracts
glirastes tools refresh
glirastes tools eval
glirastes tools eval --json
glirastes tools status
# developer only, after reviewing the diff
glirastes tools verify <tool>
```

## Verification

- `glirastes tools describe --print` lists no tool you could still improve.
- `glirastes tools refresh` reports no `resolution-rejected` for your entries.
- `glirastes tools eval` finds every example sentence's tool, or reports the
  remaining ambiguity with its competitors.
- `glirastes tools status` shows `description: agent` (or `human` after
  verify) and `schema: agent` or better for the tools you described.
- `glirastes tools check` still passes in CI.
````

In `src/cli/commands/installer-parts.ts`, replace:

```ts
  ReadonlyArray<string>
> = {
  'chat-ui': ['building-glirastes-chat-ui'],
  tools: ['maintaining-glirastes-tools'],
  setup: ['setting-up-glirastes'],
};

```

with:

```ts
  ReadonlyArray<string>
> = {
  'chat-ui': ['building-glirastes-chat-ui'],
  tools: ['maintaining-glirastes-tools', 'describing-glirastes-tools'],
  setup: ['setting-up-glirastes'],
};

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/install-skills.test.ts src/cli/commands/installer-parts.test.ts src/cli/commands/skill-lint.test.ts src/cli/installer-e2e.test.ts --maxWorkers=4 && bunx vitest run src/cli --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  4 passed (4)`, `Tests  59 passed (59)`; `src/cli` reports `Test Files  35 passed (35)`, `Tests  329 passed (329)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/describing-glirastes-tools/SKILL.md src/cli/commands/install-skills.test.ts src/cli/commands/installer-parts.test.ts src/cli/commands/installer-parts.ts src/cli/commands/skill-lint.test.ts src/cli/installer-e2e.test.ts
git commit -m "docs(skills): describe tools with stage-2 semantics"
```

### Task 25: Skill `building-glirastes-chat-ui`

**Files:**
- Modify: `skills/building-glirastes-chat-ui/SKILL.md` (Boundaries, Workflow, Commands; bridge and payload contract; every existing guard phrase stays)
- Test: `src/cli/commands/skill-lint.test.ts` (joins `LINTED_SKILLS`)

**Interfaces:**
- Consumes: the guard phrases of `install-skills.test.ts` and `setup-skill-workflow.test.ts` for this skill (unchanged), P04 `useGlirastesNavigationBridge` and the contract argument, Task 4 UI tools in `tools status`.
- Produces: the chat UI skill in the shared section layout; no new API claims (the generic `@`/`/` system of spec 6a is P07b).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools', 'describing-glirastes-tools'];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools', 'describing-glirastes-tools', 'building-glirastes-chat-ui'];

const VALID = [
  '---',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/skill-lint.test.ts --maxWorkers=4`
Expected: FAIL — the skill has no Boundaries, Workflow or Commands section and no model statement. `Test Files  1 failed (1)`, `Tests  1 failed | 15 passed (16)`

- [ ] **Step 3: Write the skill**

In `skills/building-glirastes-chat-ui/SKILL.md`, replace:

```markdown

# Building the Glirastes Chat UI

## Start from the shipped UI

Use `VercelAiChat` from `glirastes/react/vercel` plus
`glirastes/react/styles.css`. Preserve existing product UX through supported
themes, slots, session adapters, tool renderers, and `useAiClientAction`
handlers rather than copying the chat implementation.

The application may use an ephemeral session for basic interactive chat.
Server-backed conversation visibility and retention must be explicit when
```

with:

```markdown

# Building the Glirastes Chat UI

Use `VercelAiChat` from `glirastes/react/vercel` plus
`glirastes/react/styles.css`. Preserve existing product UX through supported
themes, slots, session adapters, tool renderers, and `useAiClientAction`
handlers rather than copying the chat implementation. You, the app's coding
agent, wire it; Glirastes never calls a model from the UI or the CLI: the
chat route uses the app's own model access.

## Boundaries

- The browser never decides rights: role filtering in the UI only hides
  entries, the server and the app still authorize every tool call.
- Never derive approver authority from the browser payload; organizational
  approval stays fail-closed while unavailable.
- Speech traffic goes directly between the app's provider adapter and its
  provider, never through the Glirastes Control Plane.
- Never edit `.glirastes/tool-policy.json` or generated files to change what
  the UI shows; UI tools come from `glirastes tools refresh`.

## Workflow

1. Mount one `VercelAiChat endpoint="/api/chat"` (the app's real chat route)
   and import `glirastes/react/styles.css`; theme it before forking anything.
2. Register client actions with `useAiClientAction` where their state lives,
   with a payload contract, and mount the navigation bridge
   (`useGlirastesNavigationBridge`) once. Run `glirastes tools refresh` and
   check with `glirastes tools status` that the UI tools are active.
3. Add `completionProviders` for `/` commands and `@` mentions, the
   clarification card, result renderers and sessions as the product needs.
4. Wire speech-to-text through the SDK controller (gate below).
5. Prove it in a real browser: keyboard, mobile layout, approvals, STT
   cleanup.

The application may use an ephemeral session for basic interactive chat.
Server-backed conversation visibility and retention must be explicit when
```

In `skills/building-glirastes-chat-ui/SKILL.md`, replace:

```markdown

## UI actions

`glirastes/react` exports the action bus from `./ui.js`: `UiActionBus`,
`useAiClientAction`, `useAiClientActionById`, `useAiClientActionByType`,
`dispatchAiClientAction`, `dispatchAiClientActions`, plus
`getRegisteredHandlers`, `getMissingHandlers`, `getActionIdInfo`,
```

with:

```markdown

## UI actions

`glirastes/react` re-exports the framework-neutral action bus of
`glirastes/browser`: `UiActionBus`,
`useAiClientAction`, `useAiClientActionById`, `useAiClientActionByType`,
`dispatchAiClientAction`, `dispatchAiClientActions`, plus
`getRegisteredHandlers`, `getMissingHandlers`, `getActionIdInfo`,
```

In `skills/building-glirastes-chat-ui/SKILL.md`, replace:

```markdown
`useAiMissingHandlerWarning` and `getMissingHandlers` surface actions the model
can emit but nothing handles. Wire the warning during development: a silently
dropped action looks exactly like a model that ignored the request.

## Commands, mentions and clarification

```

with:

```markdown
`useAiMissingHandlerWarning` and `getMissingHandlers` surface actions the model
can emit but nothing handles. Wire the warning during development: a silently
dropped action looks exactly like a model that ignored the request.

Generated navigation (`ui.navigate`) and filter (`ui.filter.<view>`) tools run
through `useGlirastesNavigationBridge({ push })`; without the bridge they stay
disabled. A client action becomes the tool `ui.<actionId>`; pass its payload
contract as the third argument of `useAiClientAction` so the payload is typed
and checked before the handler runs.

## Commands, mentions and clarification

```

In `skills/building-glirastes-chat-ui/SKILL.md`, replace:

```markdown
configured provider. Do not proxy transcripts through the Glirastes Control
Plane.

## Verification

Test tool cards and UI actions, self-approval, sessions, keyboard/mobile
```

with:

````markdown
configured provider. Do not proxy transcripts through the Glirastes Control
Plane.

## Commands

```bash
glirastes tools refresh
glirastes tools status
glirastes doctor
```

## Verification

Test tool cards and UI actions, self-approval, sessions, keyboard/mobile
````

In `skills/building-glirastes-chat-ui/SKILL.md`, replace:

```markdown

Assert that hidden and non-allowlisted tool output cannot escape through either
result blocks or an assistant fallback summary, and that a raw transport error
never reaches rendered state.
```

with:

```markdown

Assert that hidden and non-allowlisted tool output cannot escape through either
result blocks or an assistant fallback summary, and that a raw transport error
never reaches rendered state. `glirastes tools status` lists the UI tools the
chat can run, and a navigation or filter request changes the page.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/skill-lint.test.ts --maxWorkers=4 && bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts --maxWorkers=4`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  16 passed (16)`; `src/cli/commands/skill-lint.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/install-skills.test.ts` reports `Test Files  3 passed (3)`, `Tests  41 passed (41)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/building-glirastes-chat-ui/SKILL.md src/cli/commands/skill-lint.test.ts
git commit -m "docs(skills): fit the chat ui skill to the tools workflow"
```

### Task 26: Skill `migrating-to-glirastes` and the skills index

**Files:**
- Create: `skills/migrating-to-glirastes/SKILL.md`
- Modify: `skills/README.md` (replaced: the seven skills and what init writes), `src/cli/commands/installer-parts.ts` (the `setup` part installs it)
- Test: `src/cli/commands/skill-lint.test.ts` (joins `LINTED_SKILLS`, now all seven), `src/cli/commands/installer-parts.test.ts`, `src/cli/installer-e2e.test.ts`

**Interfaces:**
- Consumes: Task 13 policy commands, `tools refresh --adopt`, spec 5 (the Get It Done migration this skill serves in P11).
- Produces: the migration skill (spec 4.6 table): parity reference first, `contract.ts` per `ai-tool.ts`, navigation and filters from code, identity through `--adopt`, roles and confirmations as developer commands (never a relaxation on their own; `confirm` where the new tool would not ask, because on a write tool it also writes P04b's local lock), the parity test before anything old is removed, the MCP name map.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/installer-parts.test.ts`, replace:

```ts
    expect(resolvePartSkills(['tools'], { stack: 'nextjs' }))
      .toEqual(['maintaining-glirastes-tools', 'describing-glirastes-tools']);
    expect(resolvePartSkills(['setup'], { stack: 'nextjs' }))
      .toEqual(['setting-up-glirastes']);
  });

  it('yields no skills for a part that was declined', () => {
```

with:

```ts
    expect(resolvePartSkills(['tools'], { stack: 'nextjs' }))
      .toEqual(['maintaining-glirastes-tools', 'describing-glirastes-tools']);
    expect(resolvePartSkills(['setup'], { stack: 'nextjs' }))
      .toEqual(['setting-up-glirastes', 'migrating-to-glirastes']);
  });

  it('yields no skills for a part that was declined', () => {
```

In `src/cli/commands/skill-lint.test.ts`, replace:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools', 'describing-glirastes-tools', 'building-glirastes-chat-ui'];

const VALID = [
  '---',
```

with:

```ts
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs', 'integrating-glirastes-web', 'maintaining-glirastes-tools', 'describing-glirastes-tools', 'building-glirastes-chat-ui', 'migrating-to-glirastes'];

const VALID = [
  '---',
```

In `src/cli/installer-e2e.test.ts`, replace:

```ts
        'describing-glirastes-tools',
        'integrating-glirastes-nextjs',
        'maintaining-glirastes-tools',
        'setting-up-glirastes',
      ]);
    await access(join(
```

with:

```ts
        'describing-glirastes-tools',
        'integrating-glirastes-nextjs',
        'maintaining-glirastes-tools',
        'migrating-to-glirastes',
        'setting-up-glirastes',
      ]);
    await access(join(
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/installer-parts.test.ts src/cli/commands/skill-lint.test.ts src/cli/installer-e2e.test.ts --maxWorkers=4`
Expected: FAIL — the skill does not exist and the setup part resolves to `setting-up-glirastes` only. `Test Files  3 failed (3)`, `Tests  3 failed | 38 passed (41)`

- [ ] **Step 3: Write the skill**

Replace the whole content of `skills/README.md` with:

````markdown
# Glirastes Agent Skills

The package ships seven skills for the app's existing coding agent. Glirastes
never calls a model: the CLI derives tools from the code and prints work
lists, the skills tell the agent how to work through them.

| Skill | Use when |
|---|---|
| [`setting-up-glirastes`](./setting-up-glirastes/SKILL.md) | Starting or resuming an integration after `glirastes init` |
| [`integrating-glirastes-nextjs`](./integrating-glirastes-nextjs/SKILL.md) | Wiring chat, tools, navigation, filters and metrics in a Next.js App Router app |
| [`integrating-glirastes-web`](./integrating-glirastes-web/SKILL.md) | A separate backend, a non-React frontend or a Node sidecar |
| [`maintaining-glirastes-tools`](./maintaining-glirastes-tools/SKILL.md) | Resolving `glirastes tools resolve --print` findings and policy proposals |
| [`describing-glirastes-tools`](./describing-glirastes-tools/SKILL.md) | Writing descriptions, schemas, synonyms and examples from `glirastes tools describe --print` |
| [`building-glirastes-chat-ui`](./building-glirastes-chat-ui/SKILL.md) | Chat UI, `/` and `@` providers, result components, approvals and STT |
| [`migrating-to-glirastes`](./migrating-to-glirastes/SKILL.md) | Moving off `@chainmatics/agentic-*` and `ai-tool.ts` |

Install project-local copies with:

```bash
npx --no-install glirastes init
```

Run it in the app's existing Codex/Claude session or select an installed CLI
from an interactive terminal with `--agent codex` or `--agent claude`. It
writes `.glirastes/tools.json`, `.glirastes/prompt-bundle.json`, the
`predev`/`prebuild` scripts and a short hint in `AGENTS.md`/`CLAUDE.md` where
they are missing, installs the skills and continues in the agent.
`--dry-run --json` previews without writing or launching anything.

For skill installation only, use the installed Foundation CLI:

```bash
npx --no-install glirastes install --host codex --with-setup-skills
```

Hosts install into `.agents/skills` (Codex), `.claude/skills` (Claude), or
`.gemini/skills` (Gemini). Owned, unchanged copies refresh; customized copies
are preserved and never force-replaced. The supported stacks and their test
status are listed in `integrating-glirastes-web`; manifest detection and skill
installation alone do not prove an integration. Use this Foundation package,
not an unrelated registry package sharing its version number.
````

Create `skills/migrating-to-glirastes/SKILL.md`:

````markdown
---
name: migrating-to-glirastes
description: Use when an app still uses @chainmatics/agentic-* packages, ai-tool.ts or ai-ui-tool.ts files, a generated tool registry or an MCP server built on them, and should move to Glirastes Foundation.
---

# Migrating to Glirastes

The old SDK kept a hand-written tool catalogue next to the code (`ai-tool.ts`,
`ai-ui-tool.ts`, generated registries). Glirastes derives the tools from the
code instead, and Glirastes never calls a model. You, the app's coding agent,
move the app over without losing a tool, a parameter, a role restriction or a
confirmation. Work on a new branch; the old state stays untouched as the
reference until parity is proven.

## Boundaries

- Never loosen what the old definitions enforced: a role list or a
  confirmation carries over as a `glirastes tools policy` command for the
  developer, never as an edit of `.glirastes/tool-policy.json` by you. Delete,
  financial and external tools always ask first.
- Never remove `@chainmatics/agentic-*`, the old registry or its scripts before
  the parity check passes.
- Never edit generated files or tool ids. Identity carries over only through
  `glirastes tools refresh --adopt <inventory>`.
- Keep MCP clients working: an MCP server that exposes old tool names keeps a
  name map for MCP only; the chat uses the new names.

## Workflow

1. Inventory the old world: every `ai-tool.ts` and `ai-ui-tool.ts`, their Zod
   schemas, `allowedRoles`, `needsApproval`, descriptions, module groupings,
   the generated registry, the MCP server and every script that regenerates
   them. Write the list down; it is the parity reference.
2. Set up Glirastes with `setting-up-glirastes` (`glirastes init` writes
   `.glirastes/tools.json` and `.glirastes/prompt-bundle.json`). Keep the app id
   it wrote; never reuse an id from another app.
3. Endpoint contracts: turn each `ai-tool.ts` into a sibling `contract.ts`
   next to its route handler with the same Zod schemas
   (`export const contract = { POST: { input, output, description } }`). When
   the handler validates with that schema itself, the contract becomes
   load-bearing; until then it is descriptive and bound to the interface.
   A deterministic helper script in the app may do the conversion; delete it
   afterwards. Rewrite descriptions that still name old tools.
4. Navigation and filters: drop the old UI tool definitions. Pages become
   `ui.navigate` destinations through the navigation bridge; URL parameters
   become `ui.filter.<view>` through closed nuqs parsers or
   `defineQueryFilters`. Dialogs and other client actions use
   `useAiClientAction` with a payload contract.
5. Identity: run `glirastes tools refresh --adopt <inventory>` with the old
   Foundation inventory (if the app had one), so unchanged stable keys keep
   their tool ids. Renamed routes get new ids and the old ones tombstones;
   that is intended.
6. Policy: for every old `allowedRoles` and `needsApproval`, give the
   developer the matching command (`roles`; `confirm` where the old tool
   asked and the new one runs directly; `raise` for a destructive bulk route).
   A write tool asks first by default, and `confirm` on it also locks the
   confirmation against a dashboard relaxation, so offer that only when the
   developer wants the lock. A `needsApproval: false` on a write tool is not
   carried over automatically: it needs the developer's reviewed
   `relax --yes`.
7. Work through `glirastes tools resolve --print` and
   `glirastes tools describe --print`.
8. Parity: a temporary test compares the old catalogue with
   `glirastes tools status --json` (each old tool has a new one, method and
   path match, risk and confirmation at least as strict, roles kept). Only
   when it passes, remove the old packages, registries, generated bindings and
   their scripts, and replace the old build hooks with the `predev` and
   `prebuild` refresh scripts.
9. MCP: let the MCP server take its endpoint list from the generated module
   and keep the old names in the MCP-only name map; UI tools stay out of MCP.

## Commands

```bash
glirastes tools refresh --adopt <inventory>
glirastes tools refresh
glirastes tools resolve --print
glirastes tools describe --print
glirastes tools status --json
glirastes tools check
# developer only: carry over what the old definitions enforced
glirastes tools policy roles <tool> <roles>
glirastes tools policy confirm <tool>
glirastes tools policy raise <tool> delete --reason "<why>"
```

## Verification

- The parity test passes before anything old is removed, and is deleted with
  the old code afterwards.
- Every old tool exists, with the same method and path, at least as strict a
  risk class and confirmation, and its role restriction.
- A route added after the migration becomes a tool without any
  `ai-tool.ts`; a deleted route's tool is gone after the next refresh.
- MCP clients keep working with their old tool names; the chat uses the new
  ones.
- `glirastes tools check`, the app's tests, typecheck, lint and production
  build pass.
````

In `src/cli/commands/installer-parts.ts`, replace:

```ts
> = {
  'chat-ui': ['building-glirastes-chat-ui'],
  tools: ['maintaining-glirastes-tools', 'describing-glirastes-tools'],
  setup: ['setting-up-glirastes'],
};

/** Dependency whose presence proves a stack, rather than a heuristic; Next.js wins. */
```

with:

```ts
> = {
  'chat-ui': ['building-glirastes-chat-ui'],
  tools: ['maintaining-glirastes-tools', 'describing-glirastes-tools'],
  setup: ['setting-up-glirastes', 'migrating-to-glirastes'],
};

/** Dependency whose presence proves a stack, rather than a heuristic; Next.js wins. */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/installer-parts.test.ts src/cli/commands/skill-lint.test.ts src/cli/installer-e2e.test.ts --maxWorkers=4 && bunx vitest run src/cli --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  41 passed (41)`; `src/cli` reports `Test Files  35 passed (35)`, `Tests  331 passed (331)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/README.md skills/migrating-to-glirastes/SKILL.md src/cli/commands/installer-parts.test.ts src/cli/commands/installer-parts.ts src/cli/commands/skill-lint.test.ts src/cli/installer-e2e.test.ts
git commit -m "docs(skills): migrate apps from the agentic packages"
```

### Task 27: Every skill's commands run against a fixture

**Files:**
- Test: `tests/skill-scenarios.test.ts` (Create)

**Interfaces:**
- Consumes: every skill's `## Commands` block (Task 19 `skillCommands`), `runToolsCommand`, `scaffoldToolsInputs`, the fixture helpers of P03.
- Produces: one scenario per skill (spec 4.12 "jede Skill hat ein Szenario auf einer Fixture"; the managed skill runner of P10 will reuse the same fixtures): each `glirastes tools …` line of a skill must be run by its scenario (the test fails on an untested line); prepared agent and developer answers stand in for the model; the Next.js chat route of `integrating-glirastes-nextjs` and the browser snippet of `integrating-glirastes-web` are extracted from the skills and used as app code (type-checked against the SDK source, respectively read by the generator).

- [ ] **Step 1: Write the scenarios**

Create `tests/skill-scenarios.test.ts`:

```ts
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, SDK_ROOT, type AppFixture } from '../src/codegen/tools/__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../src/codegen/tools/config.js';
import { ToolContractsFileSchema } from '../src/codegen/tools/files.js';
import type { DescribeWorklist, ResolveWorklist } from '../src/codegen/tools/worklist.js';
import { readSkill, skillCommands } from '../src/cli/commands/__tests__/skill-lint.js';
import { scaffoldToolsInputs } from '../src/cli/commands/init-scaffold.js';
import { runToolsCommand } from '../src/cli/commands/tools/index.js';
import type { ToolsWatchFactory } from '../src/cli/commands/tools/watch.js';

/**
 * Every shipped skill runs the `glirastes tools` lines of its Commands block
 * against a fixture, with prepared agent and developer answers in between
 * (spec 4.12 "Skills": no model). A skill that teaches a command its scenario
 * does not run fails here, so the skills and the CLI cannot drift apart.
 */
afterEach(removeAppFixtures);

interface Run {
  code: number;
  out: string;
  err: string;
}

interface Scenario {
  /** Runs one line of the skill's Commands block; `<…>` placeholders are filled from `values`. */
  run(line: string, values?: Record<string, string>): Promise<Run>;
  json<T>(line: string, values?: Record<string, string>): Promise<T>;
}

async function scenario(skill: string, fixture: AppFixture, steps: (s: Scenario) => Promise<void>, extra: {
  watch?: ToolsWatchFactory;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const commands = skillCommands(await readSkill(skill)).map((command) => command.line);
  const executed = new Set<string>();
  const run = async (line: string, values: Record<string, string> = {}): Promise<Run> => {
    expect(commands, `${skill} teaches ${line}`).toContain(line);
    executed.add(line);
    const filled = line.replace(/<([a-z-]+)>/g, (placeholder, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`No value for ${placeholder} in ${line}`);
      return value;
    });
    const argv = (filled.match(/"([^"]*)"|(\S+)/g) ?? []).map((word) => word.replace(/^"|"$/g, ''));
    expect(argv.slice(0, 2)).toEqual(['glirastes', 'tools']);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runToolsCommand(argv.slice(2), {
      cwd: fixture.root,
      env: {},
      log: (text) => { out.push(text); },
      error: (text) => { err.push(text); },
      ...extra,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  await steps({
    run,
    async json<T>(line: string, values?: Record<string, string>) {
      const result = await run(line, values);
      expect(result.code).toBe(0);
      return JSON.parse(result.out) as T;
    },
  });
  const toolsLines = commands.filter((line) => line.startsWith('glirastes tools '));
  expect(toolsLines.filter((line) => !executed.has(line)), `${skill} commands without a scenario step`).toEqual([]);
}

const SESSION = "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n";
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } });
const TASKS_ROUTE = "import { getSession } from '@/lib/session';\n"
  + 'export async function GET(request: Request) {\n  await getSession(request);\n'
  + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n"
  + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }, { status: 201 });\n}\n';
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\nimport { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesNavigationBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href) => router.push(href) });\n  return null;\n}\n';
const TASKS_PAGE = "'use client';\nimport { parseAsStringLiteral, useQueryState } from 'nuqs';\nimport { z } from 'zod';\n"
  + "import { useAiClientAction } from 'glirastes/react';\n"
  + 'export default function TasksPage() {\n'
  + "  const [status] = useQueryState('status', parseAsStringLiteral(['open', 'done']));\n"
  + "  useAiClientAction('tasks.highlight', (payload) => console.log(payload.taskId), z.object({ taskId: z.string() }).strict());\n"
  + '  return status;\n}\n';

function nextApp(files: Record<string, string> = {}, toolsConfig: Record<string, unknown> = {}): Promise<AppFixture> {
  return createAppFixture({
    'tsconfig.json': TSCONFIG,
    'src/lib/session.ts': SESSION,
    'src/app/api/tasks/route.ts': TASKS_ROUTE,
    ...files,
  }, { toolsConfig });
}

async function interfaceOf(fixture: AppFixture, stableKey: string): Promise<string> {
  const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
  return contracts.tools.find((entry) => entry.stableKey === stableKey)!.contract!.interfaceDigest;
}

/** The first fenced block of a language in a skill, without its list indentation. */
async function codeBlock(skill: string, language: string): Promise<string> {
  const source = await readSkill(skill);
  const match = new RegExp(`^( *)\`\`\`${language}\\n([\\s\\S]*?)^\\1\`\`\``, 'm').exec(source);
  if (!match) throw new Error(`${skill} has no ${language} block`);
  const indent = match[1]!.length;
  return match[2]!.split('\n').map((line) => line.slice(indent)).join('\n');
}

describe('skill scenarios', () => {
  it('setting-up-glirastes takes a fresh Next app from init to a checked first tool', async () => {
    const fixture = await createAppFixture({
      'package.json': `${JSON.stringify({ name: 'board', private: true, type: 'module', dependencies: { next: '16' } })}\n`,
      'src/lib/session.ts': SESSION,
      'tsconfig.json': TSCONFIG,
      'src/app/api/tasks/route.ts': TASKS_ROUTE,
    }, { withoutToolsConfig: true, withoutPromptBundle: true });
    await scaffoldToolsInputs({ root: fixture.root, host: 'claude' });
    await scenario('setting-up-glirastes', fixture, async (s) => {
      const refresh = await s.run('glirastes tools refresh');
      expect(refresh.code).toBe(0);
      expect(refresh.out).toContain('+ tasks.list  GET /api/tasks  [safe-read]');
      expect(refresh.out).toContain('need a better description – your coding agent can do this with `glirastes tools describe --print`.');
      expect((await s.json<ResolveWorklist>('glirastes tools resolve --print')).items).toEqual([]);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print')).items.map((item) => item.tool))
        .toEqual(['tasks.create', 'tasks.list']);
      expect((await s.run('glirastes tools eval')).out).toContain('Without example sentences (2)');
      expect((await s.run('glirastes tools status')).out).toContain('What can my chat do? 2 active tools, 0 need attention.');
      const check = await s.json<{ mode: string; driftPaths: string[] }>('glirastes tools check --json');
      expect(check).toMatchObject({ mode: 'frozen', driftPaths: [] });
    });
  }, 240_000);

  it('integrating-glirastes-nextjs derives navigation, filters and actions and its chat route type-checks', async () => {
    const fixture = await nextApp({
      'src/app/layout.tsx': "import { GlirastesNavigationBridge } from '@/components/bridge';\n"
        + 'export default function Layout({ children }: { children: unknown }) { return [GlirastesNavigationBridge(), children]; }\n',
      'src/components/bridge.tsx': BRIDGE,
      'src/app/tasks/page.tsx': TASKS_PAGE,
      'src/lib/glirastes-principal.ts': 'export async function resolvePrincipal(request: Request) {\n'
        + "  return request.headers.get('cookie') ? { subjectId: 'u1', tenantId: '019fb007-0000-7000-8000-000000000002', roles: [], attributes: {} } : undefined;\n}\n",
    }, { sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'] });
    const controller = new AbortController();
    let watched = false;
    const watch: ToolsWatchFactory = () => {
      watched = true;
      queueMicrotask(() => controller.abort());
      return { close: () => undefined };
    };
    await scenario('integrating-glirastes-nextjs', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const watch = await s.run('glirastes tools refresh --watch');
      expect(watch).toMatchObject({ code: 0 });
      expect(watch.out).toContain('Watching the app for tool changes.');
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('+ ui.navigate  UI glirastes.navigate  safe-read, runs directly');
      expect(status.out).toContain('+ ui.filter.tasks  UI glirastes.navigate');
      expect(status.out).toContain('+ ui.tasks.highlight  UI tasks.highlight');
      expect((await s.run('glirastes tools check')).out).toContain('Tool outputs match the code.');
      expect((await s.run('glirastes tools check --integrity-only')).out).toContain('Tool outputs verified (integrity).');
    }, { watch, signal: controller.signal });
    expect(watched).toBe(true);
    await fixture.write('src/app/api/chat/route.ts', await codeBlock('integrating-glirastes-nextjs', 'ts'));
    const program = ts.createProgram([fixture.path('src/app/api/chat/route.ts')], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, baseUrl: fixture.root,
      paths: {
        '@/*': ['src/*'],
        'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
        'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
        'glirastes/server/nextjs': [join(SDK_ROOT, 'src/server/adapters/nextjs/index.ts')],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(fixture.path('src/app/api/chat/route.ts')));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    // The chat route itself is never a tool: refresh reports it as a default exclusion.
    const refreshed: string[] = [];
    expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: (line) => { refreshed.push(line); }, error: () => undefined })).toBe(0);
    expect(refreshed.join('\n')).toMatch(/\. POST \/api\/chat {2}\S+ \(default\)/);
    expect(refreshed.join('\n')).not.toContain('+ chat.');
  }, 240_000);

  it('integrating-glirastes-web reads the browser registrations of a Vite app', async () => {
    const snippet = await codeBlock('integrating-glirastes-web', 'ts');
    const fixture = await createAppFixture({
      'package.json': `${JSON.stringify({ name: 'vue-board', private: true, type: 'module', dependencies: { vue: '3' } })}\n`,
      'tsconfig.json': TSCONFIG,
      'src/main.ts': 'declare const router: { push(href: string): void };\n'
        + 'declare function highlight(taskId: string): void;\n'
        + snippet,
    }, { toolsConfig: { sources: ['react-actions', 'url-filters'] } });
    await scenario('integrating-glirastes-web', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('What can my chat do? 2 active tools, 0 need attention.');
      expect(status.out).toContain('+ ui.filter.tasks');
      expect(status.out).toContain('+ ui.tasks.highlight');
      expect((await s.run('glirastes tools check')).code).toBe(0);
      expect((await s.run('glirastes tools check --integrity-only')).code).toBe(0);
    });
  }, 240_000);

  it('maintaining-glirastes-tools resolves the stage-1 work list and the developer policy commands apply', async () => {
    const fixture = await nextApp({
      'src/lib/session.ts': `${SESSION}export async function checkMembership(request: Request) {\n  return request.headers.get('x-team') !== null;\n}\n`,
      'src/lib/api.ts': "export async function archiveTask(id: string) {\n  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });\n}\n",
      'src/app/api/notes/route.ts': "import { getSession } from '@/lib/session';\n"
        + 'declare function save(value: unknown): Promise<{ id: string }>;\n'
        + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
        + '  return Response.json(await save(body));\n}\n',
      'src/app/api/reports/route.ts': "import { checkMembership } from '@/lib/session';\n"
        + 'export async function GET(request: Request) {\n  await checkMembership(request);\n  return Response.json({ reports: [] as string[] });\n}\n',
      'src/components/tasks.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\nimport { archiveTask } from '@/lib/api';\n"
        + "export function Tasks() {\n  useAiClientAction('tasks.archive', (payload: { taskId: string }) => archiveTask(payload.taskId));\n  return null;\n}\n",
    }, { sources: ['next-app', 'react-actions'] });
    await scenario('maintaining-glirastes-tools', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).out).toContain('2 tools need attention');
      const list = await s.json<ResolveWorklist>('glirastes tools resolve --print');
      expect(list.items.map((item) => [item.code, item.owner])).toEqual([
        ['input-contract-unresolved', 'agent'], ['auth-evidence-missing', 'agent'], ['ui-action-write-unproven', 'developer'],
      ]);
      const notes = list.items[0]!;
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
        schemaVersion: 1,
        conventions: { authHelpers: ['checkMembership'] },
        tools: {
          [notes.stableKey]: {
            ...(notes.expected as Record<string, unknown>),
            model: 'claude-code',
            input: { jsonSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, description: 'The note text.' } }, required: ['text'], additionalProperties: false } },
          },
        },
      }, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const after = await s.json<ResolveWorklist>('glirastes tools resolve --print');
      expect(after.items.map((item) => item.owner)).toEqual(['developer']);
      // The developer's part, with the commands the skill shows.
      expect((await s.run('glirastes tools policy show <tool>', { tool: 'ui.tasks.archive' })).out).toContain('ui.tasks.archive');
      expect((await s.run('glirastes tools policy raise <tool> write --reason "<why>"', { tool: 'ui.tasks.archive', why: 'archives through the API' })).code).toBe(0);
      expect((await s.run('glirastes tools policy confirm <tool>', { tool: 'reports.list' })).code).toBe(0);
      expect((await s.run('glirastes tools policy disable <tool> --reason "<why>"', { tool: 'tasks.list', why: 'not for the chat yet' })).code).toBe(0);
      expect((await s.run('glirastes tools policy relax <tool> --yes --reason "<review>"', { tool: 'notes.create', review: 'reviewed in PR 7' })).code).toBe(0);
      expect((await s.run('glirastes tools policy exclude "POST /api/internal/**" --reason "<why>"', { why: 'internal' })).code).toBe(0);
      expect((await s.run('glirastes tools policy include "POST /api/internal/**"')).code).toBe(0);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      expect((await s.json<ResolveWorklist>('glirastes tools resolve --print')).items).toEqual([]);
      // A lower risk the code implies is held until the developer accepts it.
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
        ...JSON.parse(await fixture.read(TOOLS_PATHS.resolutions)),
        tools: {
          ...JSON.parse(await fixture.read(TOOLS_PATHS.resolutions)).tools,
          'GET /api/reports': { interfaceDigest: await interfaceOf(fixture, 'GET /api/reports'), effect: 'destructive' },
        },
      }, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const resolutions = JSON.parse(await fixture.read(TOOLS_PATHS.resolutions)) as { tools: Record<string, unknown> };
      delete resolutions.tools['GET /api/reports'];
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify(resolutions, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).out).toContain('risk-lower-available');
      expect((await s.run('glirastes tools policy accept <tool>', { tool: 'reports.list' })).code).toBe(0);
      expect((await s.run('glirastes tools policy reset <tool>', { tool: 'tasks.list' })).code).toBe(0);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('+ notes.create  POST /api/notes  write, runs directly');
      expect(status.out).toContain('+ reports.list  GET /api/reports  safe-read, asks first, locked in tool-policy.json');
      expect(status.out).toContain('+ ui.tasks.archive  UI tasks.archive  write, asks first, locked in tool-policy.json');
      expect((await s.run('glirastes tools check')).out).toContain('Tool outputs match the code.');
    });
  }, 300_000);

  it('describing-glirastes-tools fills the stage-2 gaps, routes the examples and locks the review', async () => {
    const fixture = await nextApp({}, { locale: 'de-DE', enrich: { writeContracts: true } });
    await scenario('describing-glirastes-tools', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const list = await s.json<DescribeWorklist>('glirastes tools describe --print');
      expect(list.languages).toEqual(['de', 'en']);
      const byTool = new Map(list.items.map((item) => [item.tool, item] as const));
      const listInterface = byTool.get('tasks.list')!.evidence.interfaceDigest!;
      const createInterface = byTool.get('tasks.create')!.evidence.interfaceDigest!;
      const agent = (interfaceDigest: string) => ({ model: 'claude-code', interfaceDigest });
      await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
        schemaVersion: 1,
        tools: [
          {
            stableKey: 'GET /api/tasks',
            description: 'Listet die Aufgaben des Nutzers, auf Wunsch nach Status gefiltert. Zum Anlegen tasks.create nutzen.',
            synonyms: { de: ['Aufgabenliste', 'offene Aufgaben'], en: ['to-dos', 'task list'] },
            examples: {
              de: ['Zeig meine offenen Aufgaben', 'Welche Aufgaben sind erledigt?', 'Liste alle Aufgaben'],
              en: ['list my open tasks', 'which tasks are done', 'show the task list'],
            },
            exampleCalls: [{ sentence: 'list my open tasks', input: { status: ['open'] } }],
            origin: { description: 'agent', synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' },
            agent: agent(listInterface),
          },
          {
            stableKey: 'POST /api/tasks',
            description: 'Legt eine neue Aufgabe mit Titel an. Zum Auflisten tasks.list nutzen.',
            synonyms: { de: ['Aufgabe anlegen', 'neue Aufgabe'], en: ['add task', 'create task'] },
            examples: {
              de: ['Leg eine neue Aufgabe an', 'Erstelle eine Aufgabe Bericht schreiben', 'Neue Aufgabe anlegen'],
              en: ['add a new task', 'create a task called report', 'create task for the review'],
            },
            approvalHint: 'Fragt vor dem Anlegen nach, weil die Aufgabe für das Team sichtbar wird.',
            origin: { description: 'agent', synonyms: 'agent', examples: 'agent', approvalHint: 'agent' },
            agent: agent(createInterface),
          },
        ],
      }, null, 2)}\n`);
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
        schemaVersion: 1,
        tools: {
          'GET /api/tasks': {
            origin: 'agent', model: 'claude-code', interfaceDigest: listInterface,
            input: { jsonSchema: { type: 'object', properties: { status: { type: 'array', items: { type: 'string', enum: ['open', 'done'] } } }, additionalProperties: false } },
          },
          'POST /api/tasks': {
            origin: 'agent', model: 'claude-code', interfaceDigest: createInterface,
            input: { jsonSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false } },
          },
        },
      }, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).out).not.toContain('resolution-rejected');
      expect((await s.run('glirastes tools eval')).out).toContain('Routing check (top 3): 12 of 12 example sentences find their tool.');
      expect((await s.json<{ summary: { failed: number } }>('glirastes tools eval --json')).summary.failed).toBe(0);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print')).items).toEqual([]);
      const named = await s.json<DescribeWorklist>('glirastes tools describe --print <tool>', { tool: 'tasks.list' });
      expect(named.items.map((item) => [item.tool, item.gaps])).toEqual([['tasks.list', ['requested']]]);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print --all')).items).toHaveLength(2);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print --write-contracts')).writeContracts).toBe(true);
      expect((await s.run('glirastes tools status')).out).toContain('contract: resolution, description: agent, schema: agent');
      expect((await s.run('glirastes tools verify <tool>', { tool: 'tasks.list' })).code).toBe(0);
    });
    expect((await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined }))).toBe(0);
    const status: string[] = [];
    await runToolsCommand(['status'], { cwd: fixture.root, env: {}, log: (line) => { status.push(line); }, error: () => undefined });
    expect(status.join('\n')).toContain('contract: resolution, description: human, schema: json-schema');
  }, 300_000);

  it('building-glirastes-chat-ui lists the UI tools the chat can run', async () => {
    const fixture = await nextApp({
      'src/components/bridge.tsx': BRIDGE,
      'src/app/tasks/page.tsx': TASKS_PAGE,
    }, { sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'] });
    await scenario('building-glirastes-chat-ui', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('+ ui.navigate');
      expect(status.out).toContain('+ ui.tasks.highlight');
    });
  }, 240_000);

  it('migrating-to-glirastes keeps tool ids through --adopt and carries roles and confirmation over', async () => {
    const pilot = await nextApp();
    expect(await runToolsCommand(['refresh'], { cwd: pilot.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
    const pilotTools = ToolContractsFileSchema.parse(JSON.parse(await pilot.read(TOOLS_PATHS.contracts))).tools
      .map((tool) => [tool.stableKey, tool.toolId]);
    const fixture = await nextApp();
    await cp(pilot.path(TOOLS_PATHS.inventory), fixture.path('pilot/foundation-execution-inventory.json'));
    await scenario('migrating-to-glirastes', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh --adopt <inventory>', { inventory: 'pilot/foundation-execution-inventory.json' })).code).toBe(0);
      const adopted = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts))).tools
        .map((tool) => [tool.stableKey, tool.toolId]);
      expect(adopted).toEqual(pilotTools);
      expect((await s.run('glirastes tools policy roles <tool> <roles>', { tool: 'tasks.create', roles: 'admin,teamleiter' })).code).toBe(0);
      expect((await s.run('glirastes tools policy confirm <tool>', { tool: 'tasks.list' })).code).toBe(0);
      expect((await s.run('glirastes tools policy raise <tool> delete --reason "<why>"', { tool: 'tasks.create', why: 'bulk delete route' })).code).toBe(0);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      expect((await s.json<ResolveWorklist>('glirastes tools resolve --print')).items).toEqual([]);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print')).items).toHaveLength(2);
      const status = await s.json<{ tools: Array<{ name: string; riskClass: string; confirmation: boolean }> }>('glirastes tools status --json');
      expect(status.tools.map((tool) => [tool.name, tool.riskClass, tool.confirmation])).toEqual([
        ['tasks.create', 'delete', true], ['tasks.list', 'safe-read', true],
      ]);
      expect((await s.run('glirastes tools check')).code).toBe(0);
    });
  }, 240_000);
});
```

- [ ] **Step 2: Run the scenarios**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run tests/skill-scenarios.test.ts --maxWorkers=4`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  7 passed (7)`. These are acceptance tests over Tasks 8–26 and pass on the first run; a failure names the skill and the command line, and is a defect of that skill or command, not of the scenario (fix the skill or the CLI, never weaken the scenario).

- [ ] **Step 3: Type-check the tests**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bun run typecheck:tests`
Expected: both exit 0 (`Generated 18 subpath shims.`).

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add tests/skill-scenarios.test.ts
git commit -m "test(skills): run every skill's commands against a fixture"
```

### Task 28: `// @ai-ignore` route files and object input roots

**Files:**
- Modify: `src/codegen/tools/exclusions.ts` (`hasAiIgnoreMarker`, `ExclusionSubject.aiIgnore`, the `ai-ignore` exclusion in code), `src/codegen/tools/sources/next-endpoints.ts` (passes the marker), `src/codegen/tools/contract-tiers.ts` (a resolution's input schema reference must be an object), `src/codegen/tools/pipeline.ts` (`input-schema-not-object`), `src/codegen/tools/findings.ts` (its next action), `src/codegen/tools/worklist.ts` (an app-code item), `skills/maintaining-glirastes-tools/SKILL.md` (finding row, no marker to shorten a list), `skills/migrating-to-glirastes/SKILL.md` (markers stay)
- Test: `src/codegen/tools/exclusions.test.ts` (marker cases), `src/codegen/tools/sources/next-endpoints.test.ts` (a marked route is a code exclusion), `src/codegen/tools/contract-tiers.test.ts` (a reference to a union is rejected, the fallback stays), `src/codegen/tools/pipeline.test.ts` (a union at the root needs attention and reaches the work list)

**Interfaces:**
- Consumes: the roadmap row "GID-Messung: `// @ai-ignore` als Ausschluss werten; Input-Schema-Wurzel muss `type: object` sein (sonst `needs_attention`)" and risks 5 and 7 of the Get It Done assessment (/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-gid-readiness-assessment.md: 20 route files carry the old SDK's `// @ai-ignore`, among them admin and debug routes, and a union input root fails every OpenAI-compatible turn); P03 `findExclusion`, Task 2 `assessResolution`, Task 8 `APP_CODE_CODES`.
- Produces: `hasAiIgnoreMarker(source)`: `@ai-ignore` in the leading comments of a route file (before its first statement; `@ai-ignored` or a marker inside a handler does not count). Such a route is excluded as `{ reason: 'ai-ignore', origin: 'code' }` after the default and policy rules, so `tool-report.json` keeps their reasons and an exclusion can never enable anything. `input-schema-not-object` (needs attention, the tool is disabled) for every tool whose input JSON Schema has no `type: 'object'` at its root, endpoint and UI tools alike; a `tool-resolutions.json` entry whose input `schemaRef` loads a non-object is `resolution-rejected` and the tool keeps its fallback. The resolve list hands the finding to the agent as app code; the maintaining skill says a list is never shortened with a marker.

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/exclusions.test.ts`, replace:

```ts
import { findExclusion, importsChatHandler, matchesExcludePattern } from './exclusions.js';
```

with:

```ts
import { findExclusion, hasAiIgnoreMarker, importsChatHandler, matchesExcludePattern } from './exclusions.js';
```

In `src/codegen/tools/exclusions.test.ts`, replace:

```ts
  it('admits code-detected exclusions such as unsupported methods in the origin type', () => {
    expectTypeOf<ExcludedTool['origin']>().toEqualTypeOf<'default' | 'policy' | 'code'>();
  });
});
```

with:

```ts
  it('admits code-detected exclusions such as unsupported methods in the origin type', () => {
    expectTypeOf<ExcludedTool['origin']>().toEqualTypeOf<'default' | 'policy' | 'code'>();
  });

  it('reads // @ai-ignore in the leading comments of a route file as an exclusion in code', () => {
    expect(hasAiIgnoreMarker('// @ai-ignore - Logo file upload, admin UI only\nexport async function POST() {}\n')).toBe(true);
    expect(hasAiIgnoreMarker('﻿/**\n * Internal.\n * @ai-ignore\n */\nexport async function GET() {}\n')).toBe(true);
    expect(hasAiIgnoreMarker('export async function GET() {\n  // @ai-ignore\n}\n')).toBe(false);
    expect(hasAiIgnoreMarker('// @ai-ignored once\nexport async function GET() {}\n')).toBe(false);
    expect(hasAiIgnoreMarker("import { db } from '@/lib/db';\n// @ai-ignore\n")).toBe(false);
    expect(findExclusion({ ...subject('POST', '/api/tenant/logo'), aiIgnore: true }, []))
      .toEqual({ stableKey: 'POST /api/tenant/logo', reason: 'ai-ignore', origin: 'code' });
    expect(findExclusion({ ...subject('POST', '/api/auth/login'), aiIgnore: true }, [])?.reason).toBe('auth-route');
    expect(findExclusion({ ...subject('POST', '/api/internal/sync'), aiIgnore: true }, [{ match: 'POST /api/internal/**', reason: 'internal' }]))
      .toEqual({ stableKey: 'POST /api/internal/sync', reason: 'internal', origin: 'policy' });
  });
});
```

In `src/codegen/tools/sources/next-endpoints.test.ts`, replace:

```ts
    expect(byKey(raised.observations).get('DELETE /api/tasks/:id')?.evidence.declaredEffect).toBe('financial');
  }, 60_000);
```

with:

```ts
    expect(byKey(raised.observations).get('DELETE /api/tasks/:id')?.evidence.declaredEffect).toBe('financial');
  }, 60_000);

  it('leaves a route file marked // @ai-ignore out as an exclusion in code', async () => {
    const app = await createAppFixture({
      ...APP_FILES,
      'src/app/api/tenant/logo/route.ts': "// @ai-ignore - Logo file upload, admin UI only\nimport { getSession } from '@/lib/session';\n"
        + 'export async function POST(request: Request) {\n  await getSession(request);\n  return Response.json({ ok: true });\n}\n',
    });
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.excluded).toContainEqual({ stableKey: 'POST /api/tenant/logo', reason: 'ai-ignore', origin: 'code' });
    expect(byKey(observed.observations).has('POST /api/tenant/logo')).toBe(false);
    expect(byKey(observed.observations).has('POST /api/tasks')).toBe(true);
  }, 60_000);
```

In `src/codegen/tools/contract-tiers.test.ts`, replace:

```ts
    expect(rejected?.message).toContain('drops parameters the handler reads: due');
  });
```

with:

```ts
    expect(rejected?.message).toContain('drops parameters the handler reads: due');
  });

  it('rejects an agent schema reference whose root is no object and keeps the code contract', () => {
    const derived = evidence({ readsBody: true, bodyKeys: ['title'] });
    const current = resolve({ evidence: derived });
    const union = { anyOf: [NOTE, { ...NOTE, properties: { title: { type: 'number' } } }] };
    const result = resolve({
      evidence: derived,
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(union, digest('U'))]),
      resolution: { origin: 'agent', model: 'codex', interfaceDigest: current.interfaceDigest, input: { schemaRef: SCHEMAS } },
    });
    expect(result.contract?.source).toBe('derived');
    expect(result.findings.find((finding) => finding.code === 'resolution-rejected')?.message)
      .toContain('the input schema src/app/api/notes/schemas.ts#createNote is not an object at its root');
  });
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
import type { ToolSource } from './types.js';

const outsideDirs: string[] = [];
```

with:

```ts
import type { ToolSource } from './types.js';
import { buildResolveWorklist } from './worklist.js';

const outsideDirs: string[] = [];
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    expect(error.result.wrote).toBe(false);
  }, 120_000);
});
```

with:

```ts
    expect(error.result.wrote).toBe(false);
  }, 120_000);
});

describe('runToolsPipeline (input schema root)', () => {
  it('disables a tool whose input schema is no object at its root and lists it for the coding agent', async () => {
    const fixture = await app();
    await fixture.write('src/lib/notes.ts', "import { z } from 'zod';\n"
      + 'export const saveNote = z.union([z.object({ text: z.string() }).strict(), z.object({ url: z.string() }).strict()]);\n');
    await fixture.write('src/app/api/notes/route.ts', "import { getSession } from '@/lib/session';\nimport { saveNote } from '@/lib/notes';\n"
      + 'export async function POST(request: Request) {\n  await getSession(request);\n'
      + '  const input = saveNote.parse(await request.json());\n  return Response.json(input, { status: 201 });\n}\n');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const note = result.tools?.find((tool) => tool.stableKey === 'POST /api/notes');
    expect(note).toMatchObject({ enabled: false, contract: { source: 'native' } });
    expect(note?.findings.filter((finding) => finding.severity === 'needs_attention').map((finding) => finding.code))
      .toEqual(['input-schema-not-object']);
    expect((await artifactOf(fixture)).tools.find((tool) => tool.name === 'notes.create'))
      .toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).not.toContain('saveNote');
    expect(buildResolveWorklist(result).items).toContainEqual(expect.objectContaining({
      code: 'input-schema-not-object', tool: 'notes.create', owner: 'agent', target: { kind: 'app-code', files: note!.files },
    }));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/exclusions.test.ts src/codegen/tools/sources/next-endpoints.test.ts src/codegen/tools/contract-tiers.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4`
Expected: FAIL — `hasAiIgnoreMarker` is not exported, a marked route is still a tool, a union reference is accepted, and a union at the root stays an active tool. `Test Files  4 failed (4)`, `Tests  4 failed | 83 passed (87)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/exclusions.ts`, replace:

```ts
export interface ExclusionSubject {
  stableKey: string;
  method: string;
  path: string;
  chatHandler: boolean;
}
```

with:

```ts
export interface ExclusionSubject {
  stableKey: string;
  method: string;
  path: string;
  chatHandler: boolean;
  /** The route file opens with an `@ai-ignore` comment (see `hasAiIgnoreMarker`). */
  aiIgnore?: boolean;
}
```

In `src/codegen/tools/exclusions.ts`, replace:

```ts
export function importsChatHandler(source: string): boolean {
  return CHAT_HANDLER_IMPORT.test(source);
}
```

with:

```ts
export function importsChatHandler(source: string): boolean {
  return CHAT_HANDLER_IMPORT.test(source);
}

/** Whitespace and comments before the first statement of a module. */
const LEADING_COMMENTS = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;

/**
 * `// @ai-ignore` (or `@ai-ignore` in a leading block comment) marks a route
 * file the old SDK kept away from the model, e.g. uploads, debug and admin
 * routes. Only the comments before the first statement count, so a marker
 * inside a handler or `@ai-ignored` changes nothing.
 */
export function hasAiIgnoreMarker(source: string): boolean {
  const head = LEADING_COMMENTS.exec(source.replace(/^﻿/, ''))?.[0] ?? '';
  return /@ai-ignore(?![\w-])/.test(head);
}
```

In `src/codegen/tools/exclusions.ts`, replace:

```ts
  const policy = policyExcludes.find((entry) => matchesExcludePattern(entry.match, subject));
  return policy ? { stableKey: subject.stableKey, reason: policy.reason, origin: 'policy' } : undefined;
}
```

with:

```ts
  const policy = policyExcludes.find((entry) => matchesExcludePattern(entry.match, subject));
  if (policy) return { stableKey: subject.stableKey, reason: policy.reason, origin: 'policy' };
  // Last, so a default or policy reason stays the one tool-report.json names.
  return subject.aiIgnore ? { stableKey: subject.stableKey, reason: 'ai-ignore', origin: 'code' } : undefined;
}
```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
import { findExclusion, importsChatHandler } from '../exclusions.js';
```

with:

```ts
import { findExclusion, hasAiIgnoreMarker, importsChatHandler } from '../exclusions.js';
```

In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
      chatHandler: importsChatHandler(entry.source),
    }, policyExcludes);
```

with:

```ts
      chatHandler: importsChatHandler(entry.source),
      aiIgnore: hasAiIgnoreMarker(entry.source),
    }, policyExcludes);
```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts
    if (!schema) return reject(`the ${role} schema ${label} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'})`);
    if (role === 'input' && schema.jsonSchema) {
```

with:

```ts
    if (!schema) return reject(`the ${role} schema ${label} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'})`);
    if (role === 'input' && schema.jsonSchema && schema.jsonSchema.type !== 'object') {
      return reject(`the input schema ${label} is not an object at its root`);
    }
    if (role === 'input' && schema.jsonSchema) {
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
    const needsAttention = reportedAttention || !tool.contract;
```

with:

```ts
    // Function calling needs an object at the root of the input schema; a union there fails every turn.
    const rootNotObject = tool.contract !== undefined && tool.contract.input.type !== 'object';
    if (rootNotObject) {
      findings.push(toolFinding('input-schema-not-object', 'needs_attention', execution.stableKey,
        'The input schema is not an object at its root (for example a union), so models cannot call this tool.'));
    }
    const needsAttention = reportedAttention || !tool.contract || rootNotObject;
```

In `src/codegen/tools/findings.ts`, replace:

```ts
  'schema-content-rejected': 'Remove secret-looking values (defaults, consts, descriptions, hints) from the schema or contract metadata; secrets must never reach committed outputs.',
```

with:

```ts
  'schema-content-rejected': 'Remove secret-looking values (defaults, consts, descriptions, hints) from the schema or contract metadata; secrets must never reach committed outputs.',
  'input-schema-not-object': 'Give the tool an object input schema (one object with optional fields, or one field that holds the variants); an internal route can be excluded by the developer instead (glirastes tools policy exclude).',
```

In `src/codegen/tools/worklist.ts`, replace:

```ts
  'ui-action-contract-conflict',
  'filter-keys-capped',
]);

/**
 * Warnings about code stage 1 had to leave out or ignore
```

with:

```ts
  'ui-action-contract-conflict',
  'filter-keys-capped',
  'input-schema-not-object',
]);

/**
 * Warnings about code stage 1 had to leave out or ignore
```

In `skills/maintaining-glirastes-tools/SKILL.md`, replace:

```markdown
- Never resolve a finding by leaving a tool, a parameter or a mapping out:
  every key a handler reads stays in its schema, and nothing is excluded to make
  a list shorter.
```

with:

```markdown
- Never resolve a finding by leaving a tool, a parameter or a mapping out:
  every key a handler reads stays in its schema, and nothing is excluded to make
  a list shorter (no `// @ai-ignore` comment, no exclusion proposal for that).
```

In `skills/maintaining-glirastes-tools/SKILL.md`, replace:

```markdown
| `tool-semantics-invalid` | the entry `target.key` names in `.glirastes/tool-semantics.json`; keep its human text, fix only the shape |
```

with:

```markdown
| `tool-semantics-invalid` | the entry `target.key` names in `.glirastes/tool-semantics.json`; keep its human text, fix only the shape |
| `input-schema-not-object` | an object at the root of the input schema (optional fields, or one field holding the variants), changed together with every caller of the route; for an internal route, tell the developer instead |
```

In `skills/migrating-to-glirastes/SKILL.md`, replace:

```markdown
   the generated registry, the MCP server and every script that regenerates
   them. Write the list down; it is the parity reference.
```

with:

```markdown
   the generated registry, the MCP server and every script that regenerates
   them. Write the list down; it is the parity reference. Keep the
   `// @ai-ignore` comments at the top of route files: those routes stay out
   of the chat (`ai-ignore`, an exclusion in code).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/exclusions.test.ts src/codegen/tools/sources/next-endpoints.test.ts src/codegen/tools/contract-tiers.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4 && bunx vitest run src/codegen src/cli/commands/skill-lint.test.ts tests/skill-scenarios.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  4 passed (4)`, `Tests  87 passed (87)`; `src/codegen src/cli/commands/skill-lint.test.ts tests/skill-scenarios.test.ts` reports `Test Files  39 passed (39)`, `Tests  526 passed (526)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/maintaining-glirastes-tools/SKILL.md skills/migrating-to-glirastes/SKILL.md src/codegen/tools/contract-tiers.test.ts src/codegen/tools/contract-tiers.ts src/codegen/tools/exclusions.test.ts src/codegen/tools/exclusions.ts src/codegen/tools/findings.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline.ts src/codegen/tools/sources/next-endpoints.test.ts src/codegen/tools/sources/next-endpoints.ts src/codegen/tools/worklist.ts
git commit -m "feat(codegen): honour @ai-ignore and require object input roots"
```

### Task 29: The MCP endpoint catalog (`emit.mcpCatalog`)

**Files:**
- Modify: `src/codegen/tools/config.ts` (`TOOLS_PATHS.mcpToolNames`, the `emit.mcpCatalog` comment), `src/codegen/tools/files.ts` (`McpToolNameSchema`, `McpToolNamesFileSchema`, `mcp` in `tool-contracts.json`), `src/codegen/tools/types.ts` (`McpToolName`, `ToolContractsEntry.mcp`), `src/codegen/tools/inputs.ts` (`readMcpToolNames`, `ToolInputs.mcpNames`), `src/codegen/tools/pipeline.ts` (names per endpoint tool, orphaned names, the flag for the module), `src/codegen/tools/emit-module.ts` (`createMcpEndpointCatalog`), `src/codegen/tools/findings.ts`, `src/codegen/tools/worklist.ts` (an agent item for the names file), `src/cli/commands/tools/watch.ts` (the names file is an input), `skills/migrating-to-glirastes/SKILL.md` (step 9), `skills/setting-up-glirastes/references/artifact-contract.md` (inputs table)
- Test: `src/codegen/tools/emit-module.test.ts` (one new case; the strict type check covers the catalog), `src/codegen/tools/pipeline.test.ts` (new describe block "MCP endpoint catalog"), `src/cli/commands/tools/watch.test.ts` (one row)

**Interfaces:**
- Consumes: the roadmap row "GID-Messung: … `emit.mcpCatalog` im SDK bauen (Grants nach `definitionId`, zwei alte Namen auf einer Route)" and risk 4 of the Get It Done assessment; spec 4.3 ("optional `mcpEndpointCatalog`"), 5.2 ("Legacy-Toolnamen nach `.glirastes/mcp-tool-names.json` (nur MCP)") and 5.6 ("Zod-Originale für Vertrags-/native Tools, sonst JSON-Schema; Rollen aus der wirksamen Policy … UI-Tools bleiben draußen; Grants nach `definitionId` bleiben gültig"); P03 `renderGeneratedModule`, `renderDerivedOutputs` and the integrity re-render; Task 4's pattern of carrying checked input data in `tool-contracts.json`.
- Produces:
  - `.glirastes/mcp-tool-names.json` (input, MCP only, written by the developer or the migration agent): `{ schemaVersion: 1, tools: { "<stableKey>": [{ id, name }] } }`, strict, 1–10 names per tool, `id` a definition id (the id MCP grants and the app's classification use), `name` an MCP tool name (`[A-Za-z0-9_-]{1,64}`), both unique in the file; two names may share one route. An invalid file is ignored with the warning `mcp-tool-names-invalid` (subject: the file); an entry for a key that is no endpoint tool is ignored with the same warning (subject: the key). Both land in the resolve work list for the agent.
  - `tool-contracts.json` entries gain `mcp?: [{ id, name }]`, so the integrity mode re-renders the module from committed outputs only; nothing changes for an app without the names file.
  - With `"emit": { "mcpCatalog": true }` the generated module also exports `createMcpEndpointCatalog()`: one entry per MCP name of every enabled endpoint tool (default `{ id: definitionId, name: modelName }`), sorted by name, with `toolId`, `definitionId`, `method`, `path`, `description`, `riskClass`, `requiresApproval`, the effective `allowedRoles`, `inputJsonSchema` and `inputSchema` (the app's Zod original where the contract comes from an exported schema, else the JSON-Schema validator the bindings use). UI tools and disabled tools never appear. Without the flag the module is byte-identical to Task 4's. The Get It Done MCP server switches to it in P11.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/tools/watch.test.ts`, replace:

```ts
    ['.glirastes/tool-policy.json', true],
```

with:

```ts
    ['.glirastes/tool-policy.json', true],
    ['.glirastes/mcp-tool-names.json', true],
```

In `src/codegen/tools/emit-module.test.ts`, replace:

```ts
    expect(text).not.toContain('"notes_archive": {');
    expect(text).not.toContain('Show my notes');
  });
```

with:

```ts
    expect(text).not.toContain('"notes_archive": {');
    expect(text).not.toContain('Show my notes');
  });

  it('emits the MCP catalog of enabled endpoint tools on request, under the names MCP keeps', () => {
    const named = contracts('src/app/api/notes/schemas.ts').map((entry) => (
      entry.toolId === id('a1') ? { ...entry, mcp: [{ id: 'notes.create', name: 'create_note' }, { id: 'notes.quickAdd', name: 'quick_note' }] }
        : entry.toolId === id('a3') ? { ...entry, mcp: [{ id: 'notes.archive', name: 'archive_note' }] } : entry
    ));
    const input = { modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: named };
    expect(renderGeneratedModule(input)).not.toContain('createMcpEndpointCatalog');
    const text = renderGeneratedModule({ ...input, mcpCatalog: true });
    expect(text.startsWith(renderGeneratedModule(input))).toBe(true);
    const catalog = text.slice(text.indexOf('export function createMcpEndpointCatalog() {'));
    expect(catalog.match(/"name": "\w+"/g)).toEqual(['"name": "create_note"', '"name": "notes_list"', '"name": "quick_note"']);
    expect(catalog).toContain('"id": "notes.quickAdd"');
    expect(catalog).toContain('"allowedRoles": []');
    expect(catalog).toContain('"inputSchema": m0.createNote');
    expect(catalog).toContain('"inputSchema": createJsonSchemaLike(');
    expect(catalog).not.toContain('archive_note');
    const output = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(output.diagnostics ?? []).toEqual([]);
  });
```

In `src/codegen/tools/emit-module.test.ts`, replace:

```ts
  it('type-checks under strict TypeScript against the SDK runtime surface', async () => {
    const generated = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: contracts('src/app/api/notes/schemas.ts'),
    });
```

with:

```ts
  it('type-checks under strict TypeScript against the SDK runtime surface', async () => {
    const generated = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: contracts('src/app/api/notes/schemas.ts'), mcpCatalog: true,
    });
```

In `src/codegen/tools/emit-module.test.ts`, replace:

```ts
        + 'export const semantics: ToolSearchSemanticsMap = generated.toolSearchSemantics;\n',
```

with:

```ts
        + 'export const semantics: ToolSearchSemanticsMap = generated.toolSearchSemantics;\n'
        + 'export const mcp: ReadonlyArray<{ id: string; name: string; method: string; path: string;'
        + ' allowedRoles: readonly string[]; inputSchema: unknown }> = generated.createMcpEndpointCatalog();\n',
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
      code: 'input-schema-not-object', tool: 'notes.create', owner: 'agent', target: { kind: 'app-code', files: note!.files },
    }));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});
```

with:

```ts
      code: 'input-schema-not-object', tool: 'notes.create', owner: 'agent', target: { kind: 'app-code', files: note!.files },
    }));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});

describe('runToolsPipeline (MCP endpoint catalog)', () => {
  it('emits the catalog under the names mcp-tool-names.json keeps and re-renders it in integrity mode', async () => {
    const fixture = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/session.ts': SESSION,
      'src/lib/schemas.ts': SCHEMAS,
      'src/app/api/tasks/route.ts': `${IMPORTS}${GET_HANDLER}${POST_HANDLER}`,
    }, { toolsConfig: { emit: { mcpCatalog: true } } });
    await fixture.write(TOOLS_PATHS.mcpToolNames, `${JSON.stringify({
      schemaVersion: 1,
      tools: {
        'POST /api/tasks': [{ id: 'tasks.create', name: 'create_task' }, { id: 'tasks.quickAdd', name: 'quick_add_task' }],
        'GET /api/gone': [{ id: 'gone.list', name: 'list_gone' }],
      },
    })}\n`);
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.findings.filter((finding) => finding.code === 'mcp-tool-names-invalid').map((finding) => finding.subjectRef))
      .toEqual(['GET /api/gone']);
    expect(buildResolveWorklist(result).items).toContainEqual(expect.objectContaining({
      code: 'mcp-tool-names-invalid', owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.mcpToolNames, key: 'tools["GET /api/gone"]' },
    }));
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    expect(contracts.tools.find((tool) => tool.stableKey === 'POST /api/tasks')?.mcp)
      .toEqual([{ id: 'tasks.create', name: 'create_task' }, { id: 'tasks.quickAdd', name: 'quick_add_task' }]);
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    const catalog = module.slice(module.indexOf('export function createMcpEndpointCatalog() {'));
    expect(catalog.match(/"name": "\w+"/g)).toEqual(['"name": "create_task"', '"name": "quick_add_task"', '"name": "tasks_list"']);
    expect(catalog).toContain('"inputSchema": m0.createTask');
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'integrity' })).driftPaths).toEqual([]);
    await fixture.write(TOOLS_PATHS.mcpToolNames, JSON.stringify({ schemaVersion: 1, tools: { 'POST /api/tasks': [{ id: 'x', name: 'two words' }] } }));
    const invalid = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(invalid.findings.map((finding) => [finding.code, finding.subjectRef])).toContainEqual(['mcp-tool-names-invalid', TOOLS_PATHS.mcpToolNames]);
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).toContain('"name": "tasks_create"');
  }, 180_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/watch.test.ts src/codegen/tools/emit-module.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4`
Expected: FAIL — the module has no `createMcpEndpointCatalog`, `TOOLS_PATHS.mcpToolNames` is undefined and the watch ignores the names file. `Test Files  3 failed (3)`, `Tests  4 failed | 50 passed (54)`

- [ ] **Step 3: Implement**

In `src/codegen/tools/config.ts`, replace:

```ts
  promptBundle: '.glirastes/prompt-bundle.json',
  inventory: '.glirastes/foundation-execution-inventory.json',
```

with:

```ts
  promptBundle: '.glirastes/prompt-bundle.json',
  /** MCP only: the names and grant ids an app's MCP server keeps (spec 5.2). */
  mcpToolNames: '.glirastes/mcp-tool-names.json',
  inventory: '.glirastes/foundation-execution-inventory.json',
```

In `src/codegen/tools/config.ts`, replace:

```ts
    /** Accepted now; emitted by the MCP catalogue work in P11. */
    mcpCatalog: z.boolean().optional(),
```

with:

```ts
    /** Also emit `createMcpEndpointCatalog()` for the app's MCP server (names from mcp-tool-names.json). */
    mcpCatalog: z.boolean().optional(),
```

In `src/codegen/tools/files.ts`, replace:

```ts
export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string().min(1).max(2_100),
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
    search: ToolSearchFactsSchema.optional(),
  }).strict()).max(5_000),
}).strict();
```

with:

```ts
/** One name an app's MCP server keeps for an endpoint tool: the grant id and the MCP tool name. */
export const McpToolNameSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict();

/**
 * `.glirastes/mcp-tool-names.json` (spec 5.2, MCP only): per endpoint tool the
 * names and grant ids the app's MCP clients know. Two names may share a
 * route; every id and every name is used once.
 */
export const McpToolNamesFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.record(z.string().min(1).max(2_100), z.array(McpToolNameSchema).min(1).max(10)),
}).strict().superRefine((file, context) => {
  const seen = { id: new Set<string>(), name: new Set<string>() };
  for (const [stableKey, names] of Object.entries(file.tools)) {
    for (const entry of names) {
      for (const field of ['id', 'name'] as const) {
        if (seen[field].has(entry[field])) {
          context.addIssue({ code: 'custom', path: ['tools', stableKey], message: `The MCP ${field} ${entry[field]} is used twice` });
        }
        seen[field].add(entry[field]);
      }
    }
  }
});

export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string().min(1).max(2_100),
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
    search: ToolSearchFactsSchema.optional(),
    mcp: z.array(McpToolNameSchema).min(1).max(10).optional(),
  }).strict()).max(5_000),
}).strict();
```

In `src/codegen/tools/types.ts`, replace:

```ts
export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
  search?: ToolSearchFacts;
}
```

with:

```ts
/** A name an app's MCP server keeps for an endpoint tool (`.glirastes/mcp-tool-names.json`). */
export interface McpToolName {
  /** The id MCP grants and the app's classification refer to. */
  id: string;
  /** The MCP tool name its clients call. */
  name: string;
}

export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
  search?: ToolSearchFacts;
  mcp?: McpToolName[];
}
```

In `src/codegen/tools/inputs.ts`, replace:

```ts
import { TOOLS_PATHS, type ToolsConfig } from './config.js';
import { toolFinding } from './findings.js';
```

with:

```ts
import { TOOLS_PATHS, type ToolsConfig } from './config.js';
import { McpToolNamesFileSchema } from './files.js';
import { toolFinding } from './findings.js';
```

In `src/codegen/tools/inputs.ts`, replace:

```ts
import type { ToolFinding } from './types.js';

export interface PromptBundleInput {
```

with:

```ts
import type { McpToolName, ToolFinding } from './types.js';

export interface PromptBundleInput {
```

In `src/codegen/tools/inputs.ts`, replace:

```ts
  semantics: ToolSemantics;
  promptBundle?: PromptBundleInput;
}
```

with:

```ts
  semantics: ToolSemantics;
  promptBundle?: PromptBundleInput;
  /** MCP names per stable key from `.glirastes/mcp-tool-names.json`; empty without the file. */
  mcpNames?: ReadonlyMap<string, McpToolName[]>;
}

/** Reads `.glirastes/mcp-tool-names.json`; an invalid file is ignored with a warning. */
export async function readMcpToolNames(
  root: string,
): Promise<{ names: ReadonlyMap<string, McpToolName[]>; findings: ToolFinding[] }> {
  const raw = await readOptional(root, TOOLS_PATHS.mcpToolNames);
  if (raw === undefined) return { names: new Map(), findings: [] };
  let parsed: ReturnType<typeof McpToolNamesFileSchema.safeParse> | undefined;
  try {
    parsed = McpToolNamesFileSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    return {
      names: new Map(),
      findings: [toolFinding('mcp-tool-names-invalid', 'warning', TOOLS_PATHS.mcpToolNames,
        'mcp-tool-names.json is invalid and is ignored; MCP clients see the generated names.')],
    };
  }
  return { names: new Map(Object.entries(parsed.data.tools)), findings: [] };
}
```

In `src/codegen/tools/inputs.ts`, replace:

```ts
  const prompt = await readPromptBundle(root, config);
  findings.push(...prompt.findings);
  return {
    inputs: {
      policy,
      resolutions: resolutions.resolutions,
      semantics: semantics.semantics,
      ...(prompt.promptBundle ? { promptBundle: prompt.promptBundle } : {}),
    },
    findings,
  };
}
```

with:

```ts
  const prompt = await readPromptBundle(root, config);
  findings.push(...prompt.findings);
  const mcp = await readMcpToolNames(root);
  findings.push(...mcp.findings);
  return {
    inputs: {
      policy,
      resolutions: resolutions.resolutions,
      semantics: semantics.semantics,
      ...(prompt.promptBundle ? { promptBundle: prompt.promptBundle } : {}),
      mcpNames: mcp.names,
    },
    findings,
  };
}
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
    [modulePath]: renderGeneratedModule({ modulePath, artifact: input.artifact, contracts: input.contracts }),
```

with:

```ts
    [modulePath]: renderGeneratedModule({
      modulePath, artifact: input.artifact, contracts: input.contracts, mcpCatalog: input.config.emit.mcpCatalog === true,
    }),
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
    const search = semanticsSearch(semantics.entry);
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
```

with:

```ts
    const search = semanticsSearch(semantics.entry);
    const mcp = execution.executionKind === 'endpoint' ? inputs.mcpNames?.get(execution.stableKey) : undefined;
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
      ...(mcp ? { mcp: [...mcp] } : {}),
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
  for (const key of Object.keys(inputs.policy.acceptedRisk ?? {})) orphaned(key, 'acceptedRisk');
```

with:

```ts
  for (const key of Object.keys(inputs.policy.acceptedRisk ?? {})) orphaned(key, 'acceptedRisk');
  for (const key of inputs.mcpNames?.keys() ?? []) {
    if (observedByKey.get(key)?.execution.executionKind === 'endpoint') continue;
    findings.push(toolFinding('mcp-tool-names-invalid', 'warning', key,
      'This mcp-tool-names.json entry names no endpoint tool in the current code and is ignored.'));
  }
```

In `src/codegen/tools/emit-module.ts`, replace:

```ts
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
}
```

with:

```ts
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
  /** `emit.mcpCatalog`: also export `createMcpEndpointCatalog()` for the app's MCP server. */
  mcpCatalog?: boolean;
}
```

In `src/codegen/tools/emit-module.ts`, replace:

```ts
  lines.push('}', '');
  return lines.join('\n');
}
```

with:

```ts
  lines.push('}', '');
  if (input.mcpCatalog === true) {
    // MCP only (spec 5.6): enabled endpoint tools under the names MCP clients keep; UI tools stay out.
    const mcpEntries = bound
      .flatMap(({ tool, contract }) => {
        if (tool.executionKind !== 'endpoint') return [];
        const entry = catalogEntry(tool);
        const names = contractsById.get(tool.toolId)?.mcp ?? [{ id: tool.name, name: entry.modelName as string }];
        return names.map((name) => ({ name, tool, contract, entry }));
      })
      .sort((left, right) => compareCodeUnits(left.name.name, right.name.name));
    lines.push(
      '/** For the app\'s MCP server only (`emit.mcpCatalog`): endpoint tools under their MCP grant ids and names. */',
      'export function createMcpEndpointCatalog() {',
    );
    if (mcpEntries.length === 0) {
      lines.push('  return [];');
    } else {
      lines.push('  return [');
      for (const { name, tool, contract, entry } of mcpEntries) {
        const data = literal({
          id: name.id,
          name: name.name,
          toolId: tool.toolId,
          definitionId: tool.name,
          method: entry.method,
          path: entry.path,
          description: entry.description,
          riskClass: tool.riskClass,
          requiresApproval: tool.requiresApproval,
          allowedRoles: tool.allowedRoles,
          inputJsonSchema: contract.input,
        }, 4);
        const schema = expression(contract.runtime.input).replace(/\n/g, '\n    ');
        lines.push(`    ${data.replace(/\n {4}\}$/, `,\n      "inputSchema": ${schema}\n    }`)},`);
      }
      lines.push('  ];');
    }
    lines.push('}', '');
  }
  return lines.join('\n');
}
```

In `src/codegen/tools/findings.ts`, replace:

```ts
  'input-schema-not-object': 'Give the tool an object input schema (one object with optional fields, or one field that holds the variants); an internal route can be excluded by the developer instead (glirastes tools policy exclude).',
```

with:

```ts
  'input-schema-not-object': 'Give the tool an object input schema (one object with optional fields, or one field that holds the variants); an internal route can be excluded by the developer instead (glirastes tools policy exclude).',
  'mcp-tool-names-invalid': 'Fix .glirastes/mcp-tool-names.json: per endpoint stable key a list of { id, name }, every id and MCP name (letters, digits, _ and -, at most 64) used once; MCP clients see the generated names meanwhile.',
```

In `src/codegen/tools/worklist.ts`, replace:

```ts
  if (code === 'resolution-rejected' || code === 'tool-semantics-invalid') {
    return { ...base, owner: 'agent', target: entryTarget(finding) };
  }
```

with:

```ts
  if (code === 'resolution-rejected' || code === 'tool-semantics-invalid') {
    return { ...base, owner: 'agent', target: entryTarget(finding) };
  }
  if (code === 'mcp-tool-names-invalid') {
    const key = finding.subjectRef.startsWith('.glirastes/') ? finding.subjectRef : toolKey(finding.subjectRef);
    return { ...base, owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.mcpToolNames, key } };
  }
```

In `src/cli/commands/tools/watch.ts`, replace:

```ts
  TOOLS_PATHS.config, TOOLS_PATHS.policy, TOOLS_PATHS.resolutions, TOOLS_PATHS.semantics, TOOLS_PATHS.promptBundle,
]);
```

with:

```ts
  TOOLS_PATHS.config, TOOLS_PATHS.policy, TOOLS_PATHS.resolutions, TOOLS_PATHS.semantics, TOOLS_PATHS.promptBundle,
  TOOLS_PATHS.mcpToolNames,
]);
```

In `skills/migrating-to-glirastes/SKILL.md`, replace:

```markdown
9. MCP: let the MCP server take its endpoint list from the generated module
   and keep the old names in the MCP-only name map; UI tools stay out of MCP.
```

with:

```markdown
9. MCP: set `"emit": { "mcpCatalog": true }` in `.glirastes/tools.json` and
   keep the old grant ids and MCP names in `.glirastes/mcp-tool-names.json`
   (`{ "schemaVersion": 1, "tools": { "<stableKey>": [{ "id": "<old id>",
   "name": "<old MCP name>" }] } }`; two old names may share one route). The
   MCP server takes `createMcpEndpointCatalog()` from the generated module,
   with roles and confirmation from the effective policy; UI tools stay out
   of MCP.
```

In `skills/setting-up-glirastes/references/artifact-contract.md`, replace:

```markdown
| `.glirastes/tool-semantics.json` | you or the developer | Descriptions, titles, synonyms, examples and hints per `stableKey`, with an origin per field. Human and locked fields are never replaced by agent output. |
```

with:

```markdown
| `.glirastes/tool-semantics.json` | you or the developer | Descriptions, titles, synonyms, examples and hints per `stableKey`, with an origin per field. Human and locked fields are never replaced by agent output. |
| `.glirastes/mcp-tool-names.json` | you or the developer, only for an app with an MCP server | Per endpoint `stableKey` the grant ids and MCP names its clients keep; read when `emit.mcpCatalog` is set. Never used by the chat. |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/watch.test.ts src/codegen/tools/emit-module.test.ts src/codegen/tools/pipeline.test.ts --maxWorkers=4 && bunx vitest run src/codegen src/cli/commands/tools src/cli/commands/skill-lint.test.ts tests/skill-scenarios.test.ts --maxWorkers=4 && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  54 passed (54)`; `src/codegen src/cli/commands/tools src/cli/commands/skill-lint.test.ts tests/skill-scenarios.test.ts` reports `Test Files  43 passed (43)`, `Tests  561 passed (561)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add skills/migrating-to-glirastes/SKILL.md skills/setting-up-glirastes/references/artifact-contract.md src/cli/commands/tools/watch.test.ts src/cli/commands/tools/watch.ts src/codegen/tools/config.ts src/codegen/tools/emit-module.test.ts src/codegen/tools/emit-module.ts src/codegen/tools/files.ts src/codegen/tools/findings.ts src/codegen/tools/inputs.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline.ts src/codegen/tools/types.ts src/codegen/tools/worklist.ts
git commit -m "feat(codegen): emit the mcp endpoint catalog with kept mcp names"
```

### Task 30: Full gates, browser proof and CLI smoke run

**Files:** none (verification only, no commit).

- [ ] **Step 1: Run every gate**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run typecheck && bun run build && bun run typecheck:tests && bunx vitest run --maxWorkers=4
```

Expected: every command exits 0 — the build prints `Generated 18 subpath shims.`; Vitest reports `Test Files  223 passed (223)` and `Tests  2484 passed (2484)` (P04b baseline 212 files and 2330 tests plus 11 files and 154 tests from this plan; measured in 126 s at a load average of 14–19; with a larger executed P04b gate, add its extra files and tests, see Global Constraints). A 5-second timeout in a known timing file (`src/codegen/tools/handler-analysis.test.ts`, `program.test.ts`, `schema-probe.test.ts`, `src/react/components/__tests__/voice-push-to-talk.test.tsx`, the embed timing tests) is rerun alone (`bunx vitest run <file> --maxWorkers=4`) and counts as load noise only when it passes alone; note the load in the checkpoint instead of changing those tests.

- [ ] **Step 2: Run the browser proof in dev and production mode**

Run (port 3191 must be free; no browser is downloaded, the system Chrome channel is used):

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && REFERENCE_NEXT_MODE=production PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
```

Expected: both runs end with `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`; the main test's diagnostic reads "Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, …" (the generated module now also exports `toolSearchSemantics`; the browser shell does not pass it, so nothing changes there). The runner removes its `.browser-proof-*` app afterwards.

- [ ] **Step 3: Smoke the built CLI on a copy of the fixture**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools \
  && SMOKE=$(mktemp -d examples/source-driven-next/.smoke-XXXXXX) \
  && cp -R examples/source-driven-next/native/. "$SMOKE" \
  && mkdir -p "$SMOKE/node_modules" && ln -s "$PWD" "$SMOKE/node_modules/glirastes" \
  && node dist/cli/bin.js tools refresh --root "$SMOKE" \
  && node dist/cli/bin.js tools check --root "$SMOKE" \
  && node dist/cli/bin.js tools check --integrity-only --root "$SMOKE" \
  && node dist/cli/bin.js tools status --root "$SMOKE" \
  && node dist/cli/bin.js tools resolve --print --root "$SMOKE" \
  && node dist/cli/bin.js tools describe --print --root "$SMOKE" > "$SMOKE.describe.json" \
  && node -e "const l=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(l.items.map((i)=>[i.tool,i.gaps])))" "$SMOKE.describe.json" \
  && node dist/cli/bin.js tools eval --root "$SMOKE" \
  && node dist/cli/bin.js tools policy show --root "$SMOKE"; \
  STATUS=$?; node -e "for (const p of process.argv.slice(1)) require('fs').rmSync(p, { recursive: true, force: true })" "$SMOKE" "$SMOKE.describe.json"; exit $STATUS
```

Expected (exit 0, the copy and the JSON file are gone afterwards):
- refresh prints `Glirastes tools (write): 4 added, 0 changed, 0 removed` with `+ ui.filter.tasks  UI glirastes.navigate  [safe-read]`, `+ ui.navigate  UI glirastes.navigate  [safe-read]`, `+ ui.tasks.highlight  UI tasks.highlight  [safe-read]`, `+ tasks.list  GET /api/tasks  [safe-read]`, `Updated 9 file(s). Commit them together with your code.` and the closing line `4 tools need a better description – your coding agent can do this with \`glirastes tools describe --print\`.`;
- both checks print `Tool outputs match the code.` and `Tool outputs verified (integrity).`;
- status prints `What can my chat do? 4 active tools, 0 need attention.` (`tasks.list`: `contract: native, description: code, schema: zod`; the UI tools: `contract: ui-bridge, description: code, schema: json-schema`);
- resolve prints `"kind": "resolve"`, `"outputsCurrent": true`, `"blocking": []`, `"items": []`;
- the describe summary is `[["tasks.list",["synonyms-missing","examples-missing"]],["ui.filter.tasks",["synonyms-missing","examples-missing"]],["ui.navigate",["synonyms-missing","examples-missing"]],["ui.tasks.highlight",["synonyms-missing","examples-missing"]]]`;
- eval prints `Routing check (top 3): 0 of 0 example sentences find their tool.` and `Without example sentences (4): tasks.list, ui.filter.tasks, ui.navigate, ui.tasks.highlight`;
- policy show lists the four tools as `safe-read, runs directly, active  (code: safe-read)`.

- [ ] **Step 4: Record the checkpoint (no commit)**

Note in the P05 checkpoint report: gate results and test counts, the browser proof in both modes, the smoke output, and the open items of the Self-Review (the Platform lockstep requests, the rulings for the controller, the P10/P11 hand-offs).

---

## Self-Review

**Spec coverage (spec section → task):**

| Spec | Covered by |
| --- | --- |
| 4.2 `tools refresh --watch` | Task 12 |
| 4.2 `tools resolve --print [--json]`; 4.6 "JSON-Arbeitsliste: pro Tool `stableKey`, Befund oder Lücke, relevante Dateien, Stufe-1-Evidenz, Zieldatei und das erwartete Eintragsformat" | Tasks 4 (tool view, files, interface), 8 |
| 4.2 `tools describe --print [<tool>…\|--all] [--write-contracts]`; 4.7 "Auslöser", "Kontext für den Agenten", "Tools eines Moduls werden gebündelt", "Ergebnis pro Tool", `--write-contracts` | Tasks 10, 24 |
| 4.2 `tools eval [--json]`; 4.7 "Qualitätsschleife", "byte-stabil", `routing-ambiguous` with competitors, "Regressionskorpus … laufen in CI" | Tasks 9, 10 (gap), 20 (CI job), 27 |
| 4.2 `tools policy <show\|disable\|enable\|confirm\|relax\|raise\|roles\|describe\|exclude\|include\|accept\|reset>`; 4.5 lifecycle "bis `tools policy accept` sie übernimmt"; roadmap `accept` contract | Task 13 |
| 4.2 `tools verify <tool\|--all>` | Task 14 |
| 4.3 `tool-resolutions.json` "nur Daten"; `tool-semantics.json` "Herkunft je Feld `human`/`code`/`agent`, `locked`, Synonyme, verwandte Module, Rückfragehinweise und Beispielsätze"; "Von Hand gepflegte oder gesperrte Felder überschreibt der Agent nie" | Tasks 1, 3, 14 |
| 4.6 "Einheitliche Prüfung im Generator": strict parse, `schemaRef` through probe, Ajv strict (object, `additionalProperties:false`, ≤ 32 KB), evidence, risk-raising effects, content limits incl. `sk-or-v1`, human/`locked` precedence, nothing lost, `resolution-rejected` with fallback | Tasks 1, 2, 3, 4 |
| 4.6 "`glirastes init` ergänzt `AGENTS.md`/`CLAUDE.md` um einen kurzen Hinweis"; "Jeder Refresh endet bei offenen Lücken mit einem Satz …" | Tasks 17, 11 |
| 4.6 skills table (seven skills, "vorhanden, überarbeiten" / "neu") | Tasks 20–26 |
| 4.7 "Speicherort und Herkunft … jeweils mit Modell, Digest und Bindung an `interfaceDigest`"; "Neubeschreibung nur bei geändertem `interfaceDigest`" | Tasks 1, 3, 4 (`semantics-stale`), 2 (`enrichment-stale`), 10 |
| 4.7 "Validierung … Eingabeschlüssel nur mit belegter Fundstelle …; Beispielaufrufe validieren gegen das neue Schema" | Tasks 1, 3 |
| 4.7 "Laufzeit … `tool_contract_rejected` (sichtbar in `doctor` und den Metriken); die betroffenen Tools erscheinen in der nächsten Arbeitsliste" | Tasks 15, 16 (event and sink; `describe --print <tool>` for the named tool, Task 10); Platform storage and doctor visibility: lockstep request below |
| 4.7 "Ohne Anreicherung … Qualität je Tool"; "`ci.requireEnrichment` (Standard aus)" | Tasks 4 (quality unchanged), 11 |
| 4.8 "`glirastes init` schreibt die Skripte …; Optional `tools refresh --watch` neben `next dev`" | Tasks 17, 12, 21 |
| 4.11 / 4.12 "Skills: Arbeitslisten-Format und Skill-Anweisungen werden per Test konsistent gehalten; Guard-Phrasen-Tests bleiben grün; jede Skill hat ein Szenario auf einer Fixture" | Tasks 19, 20–26 (guard tests updated where they pinned the old flow), 27 |
| 4.12 "Prüfung agentischer Einträge (ohne Modell)" (fehlender Export, Lockerung, ungültiges/zu großes Schema, unbelegte Schlüssel, Weglassen, Inhaltsverstöße, Überschreiben von `locked`; Arbeitslisten vollständig und stabil) | Tasks 1, 2, 3, 8, 10 |
| 4.12 "Stufe 2 … füllt nur Lücken, überschreibt keine `human`/`locked`-Felder; lehnt … Risiko-Absenkung ab; Neubeschreibung nur bei geändertem `interfaceDigest`; `tools eval` … byte-stabil; `--write-contracts` …; ohne Anreicherung bleiben Tools aktiv; `ci.requireEnrichment` greift" | Tasks 1–4, 9–11, 27 |
| 4.4 "Jedes Element endet als Tool, als deaktiviertes `needs_attention`-Tool … oder als begründeter Ausschluss. Nichts wird still verworfen" (the old SDK's `// @ai-ignore` routes, input roots a model cannot call, registrations stage 1 drops) | Tasks 8, 28 |
| 4.3 generated module "optional `mcpEndpointCatalog`"; 5.2 "Legacy-Toolnamen nach `.glirastes/mcp-tool-names.json` (nur MCP)"; 5.6 "Zod-Originale … sonst JSON-Schema; Rollen aus der wirksamen Policy … UI-Tools bleiben draußen; Grants nach `definitionId`" (SDK half) | Task 29 (the GID MCP server switch is P11) |

**Roadmap rows owned by P05 (each mapped):**

| Row | Mapping |
| --- | --- |
| P05: "Agentische Arbeit per Skills: Arbeitslisten, einheitliche Prüfung, `tools eval`, Stufe-2-Datenmodell, sieben Skills, `init`-Anpassungen" | Tasks 1–29 |
| `tools refresh --watch` | Task 12 |
| "N Tools brauchen eine bessere Beschreibung" | Task 11 |
| Tool-Policy-Einträge für ausgeschlossene Routen als `policy-entry-orphaned` | Task 5 |
| CLI `tools policy …` with the `accept` contract | Task 13 |
| `glirastes init` schreibt immer `.glirastes/prompt-bundle.json` | Task 17 |
| `glirastes connect` übernimmt das Framework aus `tools.json` | Task 18 |
| Registrierter `discoveryDigest` deckt nur das Endpunkt-Inventar ab (P05/P13 mit P08b/P10, P08c) | Ruling: kept as a row, not feasible in P05 alone. The artifact's `discoveryDigest` is the inventory digest that `validateWorkspace`, the setup plan, `glirastes sync`/`connect`, the integrity check and the Platform's run lookup all compare; a whole-artifact digest cannot live in the artifact it digests, and registering a second digest needs a new field in the Platform's strict registration and run DTOs. P04b adds one more reason for the row (a local lock in `tool-policy.json` does not change the registered digest; both directions fail safe). Owner stays P13 together with P08b/P10; P08c keeps labelling `codeVersion` as the endpoint inventory version. |
| `tools.json.appId` muss die Platform-App-ID sein … `init`/`connect` schreiben sie und verweigern stille Änderungen (P05, P11) | Tasks 17 (init writes the id pairing adopts, refuses conflicting ids), 18 (connect refuses a changed id; refresh refuses re-keying, pinned); P11 still calls `reportCapabilities()` once after the first registration |
| `scanAppSources` überspringt … in jeder Tiefe | Task 6 |
| Neuer Event-Typ `tool_contract_rejected` im Gleichschritt | Tasks 15, 16 (SDK half); Platform half: new row below |
| Skill `integrating-glirastes-nextjs`: Connected-Ausnahme für Metriken und Verdrahtungsschritt | Task 21 |
| Client-Aktion … Schreiben über Helfer … markiert die Skill-Arbeitsliste | Tasks 7, 8, 23 |
| GID-Messung: `// @ai-ignore` als Ausschluss werten; Input-Schema-Wurzel muss `type: object` sein (sonst `needs_attention`); `emit.mcpCatalog` im SDK bauen (Grants nach `definitionId`, zwei alte Namen auf einer Route) | Tasks 28 (marker as a code exclusion; `input-schema-not-object` for every tool, a non-object resolution reference rejected) and 29 (`.glirastes/mcp-tool-names.json`, `createMcpEndpointCatalog()` with grant ids, several names per route, effective roles, UI tools out). This row was added to the roadmap (b13ec62) after the first draft of this plan; the plan check added both tasks. |
| GID-Messung: Anzeige-Dateien an rund 92 alten Toolnamen …; Tools, die die Rolle nicht aufrufen darf, vor dem Modell ausblenden; Rückmeldung nach Schreibaktionen (`uiActionOnSuccess`) … (P11, SDK-Anteile ggf. P05) | Ruling: no further SDK share in P05. The new names are data the SDK already exposes (`definitionId` and `modelName` in `toolCatalog`, every work-list item and the MCP catalog of Task 29), so the display-file switch or an old-to-new map is GID code (P11). Hiding tools a role may not call before the model is P07's `find_tools` (role-filtered) or a GID tool filter, decided in P11. `uiActionOnSuccess` has no counterpart in spec 4 or 5; a generator extension needs a spec change first, so P11 decides between a GID `onToolResult` handler and a spec request. |
| GID-Messung: Codemod `ai-tool.ts` → `contract.ts` (assessment risk 2: "P05 (Skill und Skript), P11 (Lauf)") | Task 26 (`migrating-to-glirastes` step 3: one sibling `contract.ts` per `ai-tool.ts`, same Zod schemas, side-effect-free schema modules). Ruling: the deterministic helper script stays in the app as spec 5.2 says (`scripts/migrations/ai-tool-to-contract.ts`, deleted after use), so P11 writes and runs it; the SDK ships no codemod. |

Roadmap review focus "Ein Refresh auf einem Repo mit einem unbekannten Handler-Muster darf weder Tools still verlieren noch einen veralteten Erfolg melden (P03, P05)": this plan's Review Focus 2 (Tasks 5–8 and 10; a work list built while outputs are stale or a whole-refresh error blocks says `outputsCurrent: false`, pinned for the resolve list in Task 8, and the describe list of Task 10 sets it the same way).

Also from the checkpoints and P04b's Self-Review: P04b's follow-ups for P05 (`tools policy show` prints the `tools status` labels through `platformMayRelaxConfirmation`; `confirm` says it writes a lock that `reset` lifts; `maintaining-glirastes-tools` explains the lock and that the dashboard may relax code-default confirmations up to tier 2): Tasks 13, 23 and 26 (`migrating-to-glirastes` offers `confirm` only where the new tool would not ask, so a migration does not lock every write tool by accident), pinned in the Task 13 test and the Task 27 maintaining scenario; P04 item 12 (`PAGE /path` in `exclude`/`include`: Task 13 test; work lists for `navigation-bridge-missing`, `ui-action-payload-untyped`, `ui-action-contract-conflict`, `filter-keys-capped`, `generated-output-invalid` (blocking): Task 8; `tools verify`: Task 14), P09 item 9 and X7 (Tasks 15, 16, 21), P03 ledger minors on `patternProperties`/`propertyNames` and Zod v4 tuples under draft-07 Ajv (Task 1).

**Not in P05 by the roadmap:** `tools enrich --managed`, the skill runner and `glirastes init --ci github` (P10, which consumes the `schemaVersion: 1` work lists of Tasks 8 and 10 and reuses the Task 27 fixtures); NestJS, FastAPI/OpenAPI, react-router/vue-router and `.vue` sources and their skill rows (P06; `integrating-glirastes-web` reports them as open gaps); `chatEntities`/`chatCommands` and labels for `@`/`/` (P07b); the Get It Done migration itself, its MCP server's switch to `createMcpEndpointCatalog()` (the catalog itself is Task 29), `reportCapabilities()` wiring and the GID metrics sink (P11); the pack fix with its import-completeness test (P04b by the roadmap); opt-in live evals with real coding agents (spec 4.12, needs Philipp's approval).

**Deliberate decisions and deviations (veto possible):**
- A stale agent resolution falls back to the code contract with the warning `enrichment-stale` instead of disabling the tool as `contract-stale` (spec 4.4 wording for descriptive contracts). Reason: spec 4.7 "Ohne Stufe 2 bleiben Tools aktiv" and "Tools ziehen bei Codeänderungen automatisch nach"; the fallback is the deterministic contract the code shows, and the endpoint keeps validating. A stale human entry keeps the P03 behaviour.
- A stale agent description stays in use (`semantics-stale`) until it is renewed: prose that predates an interface change is still better than a template.
- An entry is accepted or rejected as a whole: a rejected output `schemaRef` now rejects the entry (P03 kept the input and made the output opaque with a needs-attention finding).
- The unified gate applies to every resolution entry (P03 already routed human entries through `validateResolutionEntry`). Semantics entries get the lock, structure, example-call, secret, `sk-or-v1` and control-character checks always (plan check: `origin` is the writer's own claim, so an agent that leaves it out must not carry a key into `toolSearchSemantics`), and the business-data and length limits only when an agent wrote them, because a human may legitimately write a long description or a support address.
- `locked` is a digest pin written by `tools verify` (the spec names `locked` without a format). It detects a changed reviewed value; it is no signature, so an agent that recomputes the digest after an edit is caught only by the diff review (Local/Free) or by P10's runner (hand-off below). A human field without a lock is protected by the work list (it never lists it) and the skills; the generator cannot see git history in `tools check`, so it cannot tell who changed an unlocked human field.
- The business-data rule is a heuristic: e-mail addresses and runs of nine or more digits in prose are refused, which can also hit a harmless sentence; the agent rewrites it.
- Synonyms and examples live in the local `tool-contracts.json` (`search`) and the synonyms in the generated module (`toolSearchSemantics`), never in the setup artifact: the Platform's capability DTO is strict. The localized `title` of Citadel D4 lives in `tool-semantics.json` only; passing it through needs the P08c lockstep (request below).
- `tools eval` passes a sentence when its tool ranks within the first three `find_tools` hits and the first hit lies in the tool's module; "Modul-Routing" is approximated lexically, because the real router classifies intents with a model. It reads only committed outputs and exits 0 unless `--strict`/`ci.strict`, matching "was dann noch scheitert, wird als Warnung `routing-ambiguous` gemeldet".
- Work lists run the generator frozen with `keepGoing`, so they reflect the code even before the next refresh; `outputsCurrent` says whether one is due. `--print` prints JSON; `--json` on `resolve` is accepted and changes nothing.
- Required languages are the app's language when it is German, plus English (spec "DE/EN-Synonyme", "3–5 Beispielsätze je Sprache"); an English app needs English only.
- `approvalHint` joins the model-facing usage hints; there is no separate artifact field for it.
- `tools policy` writes the file in canonical key order (top-level keys sorted); exclusions keep their order. `relax` pins the current effective risk and refuses tools that do not ask; `enable` removes only a local disable.
- D16 (P04b) in the policy CLI: `show` reads the confirmation origin from the committed report, so a `confirm` shows as `locked in tool-policy.json` only after the next refresh, like every other policy change. P04b's hint under `tools status` now names `glirastes tools policy confirm <tool>` instead of a hand edit (its pinned first line is unchanged). The Platform half of D16 is P04b's lockstep request, not repeated here.
- `tools verify` covers resolution and semantics entries. A stale descriptive `contract.ts` is renewed by editing it (any byte change rebinds the contract, P03).
- `init` writes `tools.json` only for Next.js apps (the only stack with sources in this SDK version), with `locale: 'en'` and a note; the prompt bundle always. Scripts are added only when missing; the hint goes into the host's instruction file plus the other one when it exists.
- `DetectedStack` gains `web` (`@nestjs/core`, `vue`, `vite`), so Doctor's framework check now passes for such apps (a warning before) and the framework part installs `integrating-glirastes-web`.
- The event type is `tool_contract_rejected` verbatim from spec 4.7 and the roadmap, although P09's turn event is `turn.finished`. It counts 400 and 422 (FastAPI and NestJS answer validation failures with 422), carries the manifest's `inputSchemaDigest` and is recorded at once, not at turn end, so it also survives an aborted turn.
- Batches carry one event type (schema refinement plus one queue per type in the sink). A Platform without the new type refuses those batches with 400 and the sink drops them as `send-failed`; turn batches are unaffected.
- The skill lint forbids `--force` anywhere in a skill, also in a prohibition; the skills say "never force-replace". Guard-phrase tests that pinned the old hand-built-inventory flow (`glirastes setup scan`, `glirastes setup --dry-run`) were changed to the new flow; every safety phrase stays pinned.
- The resolve list also names what stage 1 had to leave out or ignore (plan check): `ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`, `definition-id-invalid` and `contract-presentation-invalid` as app code (with the registration's file when no tool exists), `tool-semantics-invalid` and a rejected semantics entry under `tools[stableKey="…"]` (`semanticsKey`, the list notation of `tool-semantics.json`; the describe list uses the same helper).
- `--watch` ignores `dist`, `build`, `out` and `coverage` only directly in the app or its `src` folder (plan check), so a change in a feature folder of such a name, which Task 6 scans, refreshes too.
- `// @ai-ignore` counts only in the leading comments of a Next.js route file and excludes all its methods with `{ reason: 'ai-ignore', origin: 'code' }`, checked after the default and policy rules; it can only take a tool away. Pages and client actions keep their own exclusions (`PAGE` patterns, no registration).
- `input-schema-not-object` applies to endpoint and UI tools at one place in the pipeline (the tool needs attention, its contract stays in `tool-contracts.json` for the work list); a resolution `schemaRef` to a non-object is rejected instead, so the tool keeps its fallback. The resolve list gives it to the agent as app code; the maintaining skill sends internal routes to the developer.
- The MCP catalog (Task 29) is opt-in (`emit.mcpCatalog`); its names come from a developer- or migration-written input and are copied into `tool-contracts.json`, so the integrity mode re-renders the module from committed outputs only. Each entry carries both the runtime schema (the app's Zod original where possible) and `inputJsonSchema`, because MCP servers list JSON Schema and validate with the schema object. An invalid names file is a warning, not an error: MCP clients then see the generated names, the chat is unaffected.

**Platform lockstep requests and hand-offs (new roadmap rows for the controller):**
- `tool_contract_rejected`, Platform half (P09 ruling X7): copy `src/contracts/__vectors__/runtime-metric-event.v2.json` (sha256 `114521143ea6d65564a2b4dc70318a7d30ef8cbc2cfdb4f87e7101b786558d17`) and pin the new digest; port `ToolContractRejectedEventSchema`, the union and the one-type batch rule to the ingest DTO; store and aggregate the events (migration: the next free index at execution time; P10 keeps `0046`); surface them in Citadel ("wird oft falsch aufgerufen") and through the metrics query for `doctor`. Until then a runner drops these batches; nothing else changes. Note: P09's Platform tasks read the vector file from `codex/mvp-chat`, which this plan does not change.
- Citadel D4 `title`: pass the localized title from `tool-semantics.json` through the capability report together with P08c (shared DTO change).
- P10: consume the work lists (`schemaVersion: 1`) as the managed job's input and `tool_contract_rejected` counts as a trigger; reuse `tests/skill-scenarios.test.ts` fixtures for the skill runner's MockLanguageModelV3 scenarios.
- P10: the skill runner's allowed-path check must also refuse a diff that changes a locked entry or field, a field whose origin is not `agent`, or an `origin`/`agent` label of an existing entry, because the generator cannot tell a re-labelled or re-locked entry from a reviewed one (Known limits).
- P11: Get It Done passes `toolSemantics: toolSearchSemantics`, keeps `.chat(model)` for OpenRouter and gets `tool_contract_rejected` through its existing metrics sink; `tools.json` keeps the pilot's app id; run `migrating-to-glirastes`; set `emit.mcpCatalog`, write `.glirastes/mcp-tool-names.json` from the old `toolName`/`id` pairs (both `update_task` and `update_task_status` on `PATCH /api/tasks/:id`) and switch `src/lib/mcp/tool-inventory.ts` to `createMcpEndpointCatalog()`; keep the 20 `// @ai-ignore` markers.
- P07b (parallel in `mvp-chat`): its Self-Review asks P05 for a chat-interactions section in `building-glirastes-chat-ui` and the `.glirastes/chat-interactions.json` workflow in `describing-glirastes-tools`. Ruling: not in P05, because `docs/chat-interactions.md` and the file's reader do not exist on `codex/mvp-tools` until P07b is merged, and the skill lint and scenarios would have to teach files the branch does not have. The controller adds both sections in the merge of `codex/mvp-chat` into `codex/mvp-tools` (after P05 and P07b), with `.glirastes/chat-interactions.json` added to the lint's known paths, and reruns `src/cli/commands/skill-lint.test.ts` and `tests/skill-scenarios.test.ts`.

**Known limits (open items):**
- `doctor` does not list open, stale or lapsed entries yet (spec 4.8 last bullet); `tools status`, `tools resolve --print` and `tool-report.json` do. Suggested owner: P13.
- P03 deferred minor still open: a native path-only schema beside an opaque body read wins as `native` without a finding (`contract-tiers.ts`, tier 1). P04 deferred minor still open: `generated-ui-tool.ts` reads filter keys without `Object.hasOwn`. Neither is a P05 roadmap row; suggested owner: a P06 hygiene commit.
- `--watch` relies on recursive `fs.watch` (Node ≥ 20 on macOS, Windows and Linux); network file systems may not report changes.
- The skill scenarios use prepared answers in place of a model; how well a real coding agent fills the lists is the opt-in live eval of spec 4.12.
- Write detection for client actions (Task 7) flags helpers from other app files, mutation hooks and computed `fetch` methods, but not package clients called directly in the handler (for example `supabase.from('tasks').insert(…)` or an `axios.create()` instance of the same file); such a tool stays `safe-read` until the developer raises it.
- A `locked` digest is a review pin, not a signature (see the decisions); Local/Free relies on the diff review, Pro on P10's diff guard.

**Alignment with P02, P03, P04, P04b, P07 and P09 (re-checked against the P04b result):** `resolveToolPolicy`, the policy golden vectors (P04b's 58) and the overlay with P04b's D16 step are unchanged (the CLI only calls them); P03's tiers, probe and outputs keep their shapes except the additive `search` field and `toolSearchSemantics` (one drift after the upgrade, like P04's provenance), the optional `mcp` field and the opt-in `createMcpEndpointCatalog()` (no drift without `.glirastes/mcp-tool-names.json` and `emit.mcpCatalog`), and two new needs-attention or exclusion outcomes (`input-schema-not-object`, `ai-ignore`) that change only apps with such routes; P04's UI sources only gain `interface`/`files` and the `ui-action-write-unproven` warning; P07's search index is reused as is; P09's turn event, vectors and sink keep their behaviour for turns (the vector file only gains a section, the turn vector counts 10/31 are unchanged). None of `src/contracts/tool-policy.ts`, `src/runtime/{policy-overlay,turn-snapshot,local-runtime-source}.ts` or `src/sync/**` is touched; where P05 shares files with P04b (`pipeline.ts` import, `format.ts`/`status.ts` labels, `tools-command.test.ts`, `docs/managed-runtime-sync.md`) its blocks are cut against P04b's text and P04b's tests stay green unchanged.

**Placeholder scan:** done — every step carries complete code (new files in full, existing files as exact replace blocks that each occur once when applied in order, or as whole-content replacements) or exact commands; no TBD/TODO, no "similar to Task N". The base is the P04b result: the P04b plan (2026-10-05, after its independent check) applied mechanically to a `git archive` of `064f8a9`, 65 blocks in document order, which reproduces P04b's gate (212 files, 2330 tests, typecheck, build, `typecheck:tests`). This plan was first measured on `064f8a9` alone and then rebased onto that result (conflicts only in the `tool-policy.js` import of `pipeline.ts`, the D16 case of `tools-command.test.ts` and `confirmationLabel` in `format.ts`; resolved by keeping both sides), and Tasks 13, 23, 26 and 27 took up P04b's follow-ups for P05. RED and GREEN counts were then measured again by replaying every task on a `git archive` copy of its parent with the worktree's `node_modules` linked: each task's test files on its parent (RED), then the task (GREEN) and `tsc --noEmit`, plus the extra suites quoted in Step 4; the counts of Tasks 4, 5, 7–12 include P04b's one new case in `pipeline.test.ts` or `tools-command.test.ts`. The edit blocks were generated from that replay; the rendered plan was then applied mechanically (220 operations at the time) to the P04b result, byte-identical to the tested tree.

**Plan check (independent, 2026-10-06):** the P04b plan was applied to a fresh `git archive` of `064f8a9` with a separate applier (65 blocks, the same tree as above), and this plan was then replayed task by task on it: for every task its Step 1 blocks on the parent tree and the Step 2 command (RED), then the remaining blocks and the Step 4 command (GREEN). The original text reproduced every one of its 66 quoted counts. The check then changed Tasks 3, 8, 10, 12 and 23 (semantics content gate for every entry, the list notation and the dropped registrations in the resolve list, the watch skip list, the `route.ts` export hint) and added Tasks 28 and 29 for the Get It Done row; all counts quoted above, the changed ones included (Tasks 8, 10, 12, 13, 24, 26, 28, 29), are the results of that second replay, and every replace block matched exactly once (261 operations). The final tree passed `bun run typecheck`, `bun run build` (`Generated 18 subpath shims.`), `bun run typecheck:tests`, the full Vitest run (223 files, 2484 tests, 126 s), the browser proof in dev and production (6/6 each) and the Task 30 smoke run, whose output is unchanged from the one quoted there.

**Type consistency check:** done — names used verbatim across tasks: `agenticContentProblem`, `strictSchemaProblem`, `lockDigest`, `withoutMetaSchema`, `schemaPropertyNames`, `AGENT_MODEL_PATTERN`, `MAX_AGENTIC_SCHEMA_BYTES`, `ResolutionEntrySchema`, `inputEvidenceProblem`, `resolutionLockDigest`, `validateResolutionEntry({ codeRiskClass })`, `SemanticsEntrySchema`, `validateSemanticsEntry`, `semanticsFacts`, `semanticsSearch`, `requiredLanguages`, `isAgenticSemantics`, `lookupSemantics`, `ObservedInterface`, `ToolSearchFacts`, `ToolsPipelineTool`, `toolSearchSemantics`, `buildResolveWorklist`, `buildDescribeWorklist`, `describeGaps`, `evaluateRouting`, `readToolOutput`, `agentWorkNotes`, `watchToolsRefresh`, `isWatchedPath`, `POLICY_SUBCOMMANDS`, `TOOLS_SUBCOMMANDS`, `ToolContractRejectedEventSchema`, `RuntimeMetricEventSchema`, `recordToolContractRejected`, `onContractRejected`, `scaffoldToolsInputs`, `localAppIdentity`, `connectFrameworkOf`, `lintSkill`, `skillCommands`, `semanticsKey`, `hasAiIgnoreMarker`, `McpToolName`, `McpToolNameSchema`, `McpToolNamesFileSchema`, `readMcpToolNames`, `createMcpEndpointCatalog`, `TOOLS_PATHS.mcpToolNames`, `mcpCatalog` (render input and `emit` flag). Compile-time proofs: the strict type check of a generated module against `ToolSearchSemanticsMap` and of `createMcpEndpointCatalog()` against an MCP entry type (Tasks 4, 29), the chat route of `integrating-glirastes-nextjs` type-checked against the SDK source (Task 27), `bun run typecheck:tests` over every new test (Tasks 27, 30).
