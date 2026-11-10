# Navigation, Filter, UI-Aktionen und SDK-Policy-Vertrag (P04) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `glirastes tools refresh` derives navigation (`ui.navigate`), URL filter (`ui.filter.<view>`) and client action (`ui.<actionId>`) tools from a Next.js app's pages, URL parsers and UI registrations; the browser runs them through a framework-neutral bridge (`glirastes/browser`, `useGlirastesNavigationBridge`); HEAD routes become read tools; and the SDK half of the policy contract with P08b lands: signed `toolOverrides` deltas restrict every runtime path and carry their description to the model, a Platform tool the code lacks no longer rejects a whole deployment, and runners report their code version with a content-free, capped capability report.

**Architecture:** Work continues in the worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` on branch `codex/mvp-tools` at `24b5075` (P01, P02, P03 and P07 merged into the foundation branch and fast-forwarded here). Tasks 1–7 implement the SDK half of the P08b shared contract: a leaf module `src/contracts/tool-policy-entry.ts` removes the `revisions.ts` ↔ `tool-policy.ts` ESM cycle, `RuntimePolicyRevision.toolOverrides` defaults to `[]`, `policyOverlayFromRevision` reads only those deltas and their descriptions, `createTurnSnapshot` folds a revision's own deltas restrict-only, `validateLocalDeploymentBindings` ignores and reports Platform tools without a matching local binding, the setup artifact gains `provenance` and capped `exclusions`, and `createManagedRuntimeSync` registers the discovery digest and uploads the artifact once per process. Tasks 8–12 give UI tools a runtime: HEAD as a read method, the React-free `UiActionBus` with `registerAiClientAction`/`registerNavigationBridge`/`defineQueryFilters` in `glirastes/browser`, the contract argument of `useAiClientAction`, `uiActionToolToTool` and UI bindings in `createContractBindings`. Tasks 13–17 extend the generator: UI contracts persist in `tool-contracts.json` (`ToolContract.uiAction`, `runtime` as JSON Schema) and bind in the generated module; page, source and import readers feed three new sources `next-pages`, `url-filters` and `react-actions`. Task 18 switches the Next reference fixture's UI and browser proof to `tools refresh` and removes the adapter, Task 19 adds the navigation and filter change corpus, Task 20 runs the gate.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict), Node ≥ 20.6, Zod v4, Ajv 8, React 19, Next.js 15.5 (browser proof only), Vitest 4, Bun, Playwright with system Chrome (browser proof only).

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (v1.4) sections 4.4 ("Aufzählung", "Navigation und Filter", UI actions), 4.5 (GET/HEAD and UI defaults, "UI-Handler mit nachweisbarem schreibendem Fetch ⇒ write"), 4.9 ("Overlay-IDs ohne lokales Binding werden ignoriert (`platform-tool-not-in-code`)"), 4.10 items 3, 6 and 9 (SDK half), 4.11 (Next fixture: next-app, next-pages, url-filters, react-actions), 4.12 (Next navigation and filter rows of the change corpus; additional corpus "entfernte Brücke ⇒ Navigation/Filter `needs_attention`"). Roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md rows owned here: the P04 row, "`ToolContract.runtime` ist Pflichtfeld; P04 und P06 müssen es liefern" (P04 part), "`examples/source-driven-next/*.d.mts` zusammen mit den `.mjs`-Modulen entfernen", "HEAD als lesendes Tool aufzählen", the SDK half of "Signiertes Delta-Feld `RuntimePolicyRevision.toolOverrides` plus Overlay-Adapter im SDK" (moved to P04 by the P08b ledger, ruling X5), and "`src/sync/local-deployment-validator.ts` lehnt eine ganze Platform-Deployment ab …" (listed for P05, pulled forward because shared contract item 2 depends on it). Shared contract: /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-mvp-plan-08b-platform-backend.md section "Shared SDK contract" items 1, 2, 3, 5 and 6, and the P08b ledger rulings X1–X4 and the P04 scope ruling in /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/.superpowers/sdd/2026-10-05-mvp-plan-08b-platform-backend/progress.md.

## Global Constraints

- No push, merge into a main branch, npm publish or deploy; Omnify is neither read nor changed; no secret is read, printed or written; no live model or STT call (the browser proof uses the fixture's `MockLanguageModelV3` test model).
- Implementers never edit plan files. Shell `rm` is denied in this environment and no step needs it: tracked files are removed with `git rm` (Task 18), tests clean their temporary directories through Node's `fs`, and a temporary smoke copy is removed with `node -e "require('fs').rmSync(…)"`.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution. Agent shells reset their working directory between calls, so every command below starts with an absolute `cd`.
- Decision deltas (P08b shared contract items 1–2): `ToolOverrideDelta = { toolId } & ToolPolicyEntry` (strict, the same entry schema as `tool-policy.json`); `RuntimePolicyRevision.toolOverrides` defaults to `[]`, holds at most 5,000 deltas and at most one per `toolId`. Every composition is restrict-only: disable, raise the risk class, narrow roles, require confirmation. `enabled: true`, a lower risk class and `requiresApproval: false` are no-ops with or without a pin. A delta `description` replaces the model-facing description (Platform > local > code, spec 4.5) only for tools the code has.
- `validateLocalDeploymentBindings` checks the agent allowlist against the reported `toolPolicies`, never against the deltas; it still fails closed on inconsistent Platform revisions (duplicate entries, an allowlisted tool that is unavailable in the manifest, a missing or disabled policy, a policy below the manifest risk) and ignores and reports a missing (`platform-tool-not-in-code`) or changed (`platform-tool-binding-mismatch`) local binding.
- Capability report (shared contract items 5–6): the committed setup artifact is the report. Per tool optional `provenance` `{ policyOrigin?: Partial<Record<'enabled'|'requiresApproval'|'riskClass'|'allowedRoles'|'description', 'code-default'|'local-policy'>>, contractSource?, descriptionSource?: 'human'|'code'|'agent'|'template', schemaSource?: 'zod'|'openapi'|'json-schema'|'agent'|'field-names'|'none' }`; artifact optional `exclusions` (≤ 5,000 entries, `stableKey` ≤ 512, `origin` `default`|`policy`|`code`), clipped by the generator. Registration sends `capabilities.discoveryDigest` (`sha256:` plus 43 base64url characters); the artifact goes up once per process through `POST …/runtime-setup/runs` and `PUT …/runs/:runId/artifact` with the runtime key.
- UI tool shapes: stable keys `UI navigate`, `UI filter <path>`, `UI action <actionId>`; definition ids `ui.navigate`, `ui.filter.<view>`, `ui.<camelCased actionId>`; action binding `glirastes.navigate` for navigation and filters, the action id for client actions. Tool results carry `{ type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href, destination, params?, query? } }` or `{ type: 'glirastes.action', actionId, payload }`; an `href` is always an app-internal path without dot segments, and the bridge refuses anything else. Only generated UI tools emit `glirastes.*` actions: an endpoint result drops them, and `createUiActionSchema` accepts both generated shapes so an app `uiActionSchema` keeps them.
- UI defaults come only from P02 `deriveToolPolicyDefaults` (`ui`, `safe-read`, no confirmation); a client action whose handler provably writes (`fetch` with POST/PUT/PATCH/DELETE, `axios.post|put|patch|delete`) is `write` with confirmation.
- Findings: `needs_attention` `navigation-bridge-missing`, `ui-action-payload-untyped`, `ui-action-contract-conflict`; warnings `filter-domain-open`, `filter-domain-conflict`, `filter-parser-unsupported`, `filter-definition-unreadable`, `filter-key-reserved`, `page-path-duplicated`, `ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`. A linked folder, an oversized file or too many files under the scanned app source is `E-INVENTORY-011`: nothing is written.
- Page tree: `app/**/page.*` (`src/app` first); route groups and `@slot` folders leave the path; `_private` folders and the top-level `api` folder are not pages; `stripSegments` such as `[locale]` leave the path. Default exclusions `auth-page`, `callback-page`, `mcp-page`, `catch-all-page`, `intercepting-page`; policy exclusions by `PAGE /path` or `* /path` patterns.
- The generated module binds every enabled tool; UI tools bind through `uiActionToolToTool` with a JSON Schema input, so the server never imports a client module.
- HEAD is a read tool (`GET`/`HEAD` defaults, query-only transport, definition id `<resource>.head`, item routes `<resource>.check`); OPTIONS stays an `unsupported-method` exclusion; the legacy route-scan upload keeps its five methods.

## Review Focus

1. **Platform decisions restrict on every runtime path and loosen on none.** A `toolOverrides` delta disables, raises risk, narrows roles, requires confirmation and replaces the model-facing description in the managed local runtime, and a turn snapshot built straight from a Platform deployment (the Get It Done pilot's managed path) obeys the same deltas; a relaxation or an id the code lacks changes nothing; a revision without decisions keeps its bytes. Pinned in Task 1 Step 1, Task 2 Step 1 and Task 3 Step 1.
2. **A code change never makes the runner reject a Platform deployment,** so restrictions and revocations keep arriving while the Platform catches up with the code; inconsistent Platform revisions still fail closed. Pinned in Task 4 Step 1.
3. **Generated UI tools cannot leave the app or bypass its own checks.** The bridge refuses external, protocol-relative, backslash, control-character and dot-segment targets; an endpoint result never carries a `glirastes.*` UI action, so data an endpoint returns cannot navigate or run a client action past its confirmation, while an app `uiActionSchema` from `createUiActionSchema` keeps the generated ones; the app's Zod contract validates a payload at dispatch even when the generated JSON Schema accepts it; without a mounted bridge navigation and filter tools stay disabled; an untyped or conflicting payload disables its tool. Pinned in Task 9 Step 1, Task 11 Step 1, Task 15 Step 1, Task 16 Step 1, Task 17 Step 1 and Task 18 Step 1.
4. **The capability report is content-free and always fits the Platform's strict DTO:** only the shared vocabulary (including `json-schema` and `none`), exclusions clipped to 5,000 entries and 512 characters, a digest-only registration that refuses free text, one upload per process. Pinned in Task 5 Step 1, Task 6 Step 1 and Task 7 Step 1.
5. **UI enumeration is complete or aborts, nothing is dropped silently, and outputs stay byte-stable.** A linked folder is `E-INVENTORY-011`; excluded pages, unreadable filters and dynamic or reserved action ids are reported, and a policy exclusion also hides a `defineQueryFilters` view without a page file; `check` right after `refresh` is drift-free and `integrity` re-renders UI bindings from `tool-contracts.json`; adding, changing and removing pages and filters keeps or tombstones identities exactly. Pinned in Task 13 Step 1, Task 14 Step 1, Task 15 Step 1, Task 16 Step 1 and Task 19 Step 1.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/contracts/tool-policy-entry.ts` | Create (Task 1) | Leaf module: `ToolRiskClassSchema`, `ToolPolicyPinSchema`, `ToolPolicyEntrySchema`, `ToolOverrideDeltaSchema` |
| `src/contracts/revisions.ts` | Modify (Tasks 1, 8) | `RuntimePolicyRevision.toolOverrides`; risk classes from the leaf; HEAD in manifest endpoint tools |
| `src/contracts/tool-policy.ts` | Modify (Task 1) | Imports and re-exports the moved schemas |
| `src/contracts/app-setup.ts` | Modify (Tasks 5, 8) | `provenance`, `exclusions`, `APP_SETUP_EXCLUSION_LIMITS`; HEAD in candidates |
| `src/contracts/tool-exclude-pattern.ts` | Modify (Task 14) | `PAGE /path` exclusion patterns |
| `src/contracts/index.ts` | Modify (Tasks 1, 5) | New exports |
| `src/runtime/policy-overlay.ts` | Modify (Task 2) | Overlay from `toolOverrides`; `overlayDescriptions` |
| `src/runtime/local-runtime-source.ts` | Modify (Task 2) | Managed manifest carries Platform descriptions |
| `src/runtime/turn-snapshot.ts` | Modify (Task 3) | Folds a revision's own deltas restrict-only |
| `src/sync/local-deployment-validator.ts` | Modify (Task 4) | Ignores and reports Platform tools without a matching binding |
| `src/sync/capability-report.ts` | Create (Task 7) | `capabilityReportFrom`, `uploadCapabilityReport`, `DISCOVERY_DIGEST_PATTERN` |
| `src/sync/control-plane-client.ts`, `src/sync/managed-sync.ts`, `src/sync/index.ts` | Modify (Tasks 4, 7) | Registration digest, `reportCapabilities()`, exports |
| `src/codegen/tools/artifact.ts` | Modify (Tasks 6, 13) | `clipExclusions`, provenance per tool; UI schema quality |
| `src/codegen/tools/pipeline.ts` | Modify (Tasks 6, 13, 15–17) | Provenance and exclusions; `uiMutation`; `createConfiguredSources` |
| `src/types.ts`, `src/codegen/route-exports.ts`, `src/codegen/route-scanner.ts`, `src/codegen/execution-inventory.ts`, `src/codegen/tools/identity.ts`, `src/codegen/tools/contract-tiers.ts`, `src/codegen/tools/sources/next-endpoints.ts`, `src/server/core/index.ts` | Modify (Task 8) | HEAD as a read method |
| `src/browser/{ui-action-bus,navigation,client-actions,query-filters,index}.ts` | Create (Task 9) | Framework-neutral bus, navigation bridge, client actions, URL filter definitions |
| `package.json`, `scripts/generate-subpath-shims.mjs`, `.gitignore`, `CLAUDE.md` | Modify (Task 9) | `glirastes/browser` subpath |
| `src/react/ui.ts`, `src/react/types.ts`, `src/react/provider/ai-chat-provider.tsx` | Modify (Tasks 9, 10) | Re-export of the bus; contract argument; `useGlirastesNavigationBridge`; provider dispatch |
| `src/server/core/generated-ui-tool.ts` | Create (Task 11) | `uiActionToolToTool` |
| `src/server/core/index.ts`, `src/types.ts` | Modify (Task 11) | Endpoint results drop `glirastes.*` UI actions; `createUiActionSchema` accepts the generated ones |
| `src/runtime/contract-bindings.ts`, `src/runtime/index.ts` | Modify (Task 12) | UI bindings |
| `src/codegen/tools/{types,files,emit-module,prose,findings}.ts` | Modify (Tasks 13, 14) | `ToolContract.uiAction`, UI bindings in the generated module, UI prose, finding actions |
| `src/codegen/tools/sources/{app-files,page-tree,ui-tools}.ts` | Create (Task 14) | Bounded source scan, page tree, names, import reading, UI observations |
| `src/codegen/tools/config.ts` | Modify (Tasks 15–17) | Source kinds `next-pages`, `url-filters`, `react-actions` |
| `src/codegen/tools/sources/next-pages.ts` | Create (Task 15) | `ui.navigate` |
| `src/codegen/tools/sources/url-filters.ts` | Create (Task 16) | `ui.filter.<view>` |
| `src/codegen/tools/sources/react-actions.ts` | Create (Task 17) | `ui.<actionId>` |
| `examples/source-driven-next/native/**` | Create / modify (Task 18) | Pages, URL filter definition, client action, bridge, `tools.json` sources |
| `examples/source-driven-next/browser-shell/**`, `prepare-browser.mjs`, `prepare-browser.d.mts`, `README.md` | Modify / create (Task 18) | Browser proof runs on `tools refresh` |
| `examples/source-driven-next/{adapter.mjs,adapter.d.mts,ui-adapter.mjs,build.mjs,build.d.mts,ui-bridge.js,native-ui/ui-config.json,native-ui/ui.js}` | Delete with `git rm` (Task 18) | Replaced by the generator |
| `tests/support/tool-runtime.ts` | Modify (Task 18) | jsdom-safe paths, `refreshWithCli` |
| `tests/source-driven-ui.test.tsx`, `tests/source-driven-build.test.ts` | Modify (rewrite, Task 18) | UI through generated tools and the app bridge; build stops on a failing refresh |
| `tests/source-driven-browser.test.mjs`, `tests/tool-sync-next.test.ts` | Modify (Task 18) | Browser proof on generated tools; endpoint corpus picks its tool by name |
| `tests/tool-sync-next-ui.test.ts` | Create (Task 19) | Navigation and filter change corpus |
| Unit tests (Create): `src/contracts/__tests__/{tool-overrides,app-setup-provenance}.test.ts`, `src/sync/__tests__/capability-report.test.ts`, `src/server/core/__tests__/{head-endpoint-tool,generated-ui-tool}.test.ts`, `src/browser/__tests__/browser.test.ts`, `src/react/__tests__/ui-actions.test.tsx`, `src/codegen/tools/sources/{page-tree,ui-tools,next-pages,url-filters,react-actions}.test.ts` | Create | One test file per new module |
| Existing tests (Modify, append or adjust): `src/runtime/__tests__/{policy-overlay,source-parity,turn-snapshot,local-runtime-source}.test.ts`, `src/sync/__tests__/local-deployment-validator.test.ts`, `src/codegen/tools/{artifact,pipeline,emit-module,prose,config}.test.ts`, `src/codegen/{route-exports,route-scanner}.test.ts`, `src/codegen/tools/identity.test.ts`, `src/codegen/tools/sources/next-endpoints.test.ts`, `src/runtime/contract-bindings.test.ts`, `src/public-subpaths.test.ts`, `src/contracts/__tests__/tool-exclude-pattern.test.ts` | Modify | New cases beside the existing ones |

All commands run from `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools`. Code blocks are exact: a "replace" block matches the file byte for byte (each occurs exactly once), and "Create" or "Replace the whole content" blocks are the complete file. `src/runtime/local-runtime-source.ts` contains a literal NUL character inside `parts.join(…)` (line 119, unchanged by this plan): edit that file only with the replace blocks of Task 2, never by retyping it.

Baseline at `24b5075`: `bun run test` reports `Test Files  192 passed (192)` and `Tests  1930 passed (1930)`; `bun run typecheck`, `bun run build` and `bun run typecheck:tests` exit 0.


### Task 1: Signed decision deltas on policy revisions

**Files:**
- Create: `src/contracts/tool-policy-entry.ts` (leaf module of the policy contract)
- Modify: `src/contracts/revisions.ts` (risk classes from the leaf, `toolOverrides` on `RuntimePolicyRevisionSchema`), `src/contracts/tool-policy.ts` (imports and re-exports the moved schemas), `src/contracts/index.ts`
- Test: `src/contracts/__tests__/tool-overrides.test.ts` (Create); `src/runtime/__tests__/policy-overlay.test.ts`, `src/runtime/__tests__/source-parity.test.ts`, `src/runtime/__tests__/turn-snapshot.test.ts`, `src/sync/__tests__/local-deployment-validator.test.ts` (typed `RuntimePolicyRevision` literals gain `toolOverrides: []`, because the parsed type now always has the field)

**Interfaces:**
- Consumes: P02 `ToolPolicyEntrySchema` (moved unchanged), P08b shared contract items 1–2, ledger ruling X1 (`tool-policy.ts` imports `ToolRiskClassSchema` from `revisions.ts` at top level, so `revisions.ts` must not import `tool-policy.ts`).
- Produces:
  - `src/contracts/tool-policy-entry.ts`: `export const ToolRiskClassSchema`, `export type ToolRiskClass`, `export const ToolPolicyPinSchema`, `export const ToolPolicyEntrySchema`, `export interface ToolPolicyEntry`, `export const ToolOverrideDeltaSchema` (`ToolPolicyEntrySchema.extend({ toolId: z.uuid() }).strict()`), `export type ToolOverrideDelta = { toolId: string } & ToolPolicyEntry`. It imports only `zod`.
  - `revisions.ts` and `tool-policy.ts` re-export the moved names, so every existing import keeps working; `src/contracts/index.ts` additionally exports `ToolOverrideDeltaSchema` and `ToolOverrideDelta`.
  - `RuntimePolicyRevision.toolOverrides: ToolOverrideDelta[]` (`.max(5_000).default([])`, at most one delta per `toolId`).

- [ ] **Step 1: Write the failing tests**

Create `src/contracts/__tests__/tool-overrides.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RuntimePolicyRevisionSchema, ToolRiskClassSchema } from '../revisions.js';
import {
  ToolOverrideDeltaSchema,
  ToolPolicyEntrySchema as LeafEntrySchema,
  ToolPolicyPinSchema as LeafPinSchema,
  ToolRiskClassSchema as LeafRiskClassSchema,
} from '../tool-policy-entry.js';
import { ToolPolicyEntrySchema, ToolPolicyPinSchema } from '../tool-policy.js';

const TOOL_A = '019fb001-0000-7000-8000-000000000006';
const TOOL_B = '019fb001-0000-7000-8000-000000000007';

const policyRevision = {
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3920',
  revision: 3,
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3921',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3922',
  budget: {
    maxModelSteps: 12,
    maxToolCalls: 8,
    totalTimeoutMs: 120_000,
    toolTimeoutMs: 15_000,
    maxInputTokens: 40_000,
    maxOutputTokens: 8_000,
    maxEstimatedCostUsd: 2,
    maxRepeatedFingerprint: 3,
    maxConsecutiveErrors: 3,
    delegation: { maxDepth: 2, maxBreadth: 3, sharedBudget: true },
  },
  toolPolicies: [{ toolId: TOOL_A, enabled: true, riskClass: 'write', requiresApproval: true, allowedRoles: [] }],
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature: { algorithm: 'Ed25519' as const, keyId: 'runtime-signing-2026-10', value: 'c2lnbmF0dXJl' },
};

describe('RuntimePolicyRevision.toolOverrides (P08b shared contract items 1-2)', () => {
  it('reads a policy without decisions as an empty delta list', () => {
    expect(RuntimePolicyRevisionSchema.parse(policyRevision).toolOverrides).toEqual([]);
  });

  it('accepts the signed decision deltas of the shared contract', () => {
    const toolOverrides = [
      { toolId: TOOL_A, enabled: false, riskClass: 'delete', allowedRoles: ['admin'], description: 'Archives a task.' },
      { toolId: TOOL_B, requiresApproval: false, pin: { toolId: TOOL_B, atRiskClass: 'write' } },
    ];
    expect(RuntimePolicyRevisionSchema.parse({ ...policyRevision, toolOverrides }).toolOverrides)
      .toEqual(toolOverrides);
  });

  it.each([
    ['an unknown field', [{ toolId: TOOL_A, enabledEverywhere: true }]],
    ['an unknown risk class', [{ toolId: TOOL_A, riskClass: 'catastrophic' }]],
    ['a malformed tool id', [{ toolId: 'tasks.list', enabled: false }]],
    ['two deltas for one tool', [{ toolId: TOOL_A, enabled: false }, { toolId: TOOL_A, riskClass: 'delete' }]],
  ])('rejects %s', (_label, toolOverrides) => {
    expect(RuntimePolicyRevisionSchema.safeParse({ ...policyRevision, toolOverrides }).success).toBe(false);
  });

  it('shares one entry schema between local files and Platform deltas', () => {
    expect(ToolPolicyEntrySchema).toBe(LeafEntrySchema);
    expect(ToolPolicyPinSchema).toBe(LeafPinSchema);
    expect(ToolRiskClassSchema).toBe(LeafRiskClassSchema);
    expect(ToolOverrideDeltaSchema.safeParse({ toolId: TOOL_A, description: 'x'.repeat(4_001) }).success).toBe(false);
  });

  it('keeps the policy entry module a leaf, so revisions.ts never imports tool-policy.ts', async () => {
    const importsOf = async (file: string) => [...(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'))
      .matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
    expect(await importsOf('tool-policy-entry.ts')).toEqual([]);
    expect(await importsOf('revisions.ts')).not.toContain('./tool-policy.js');
  });
});
```

In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [WRITE],
      publishedAt: '2026-10-04T00:00:00.000Z',
      signature: {
        algorithm: 'Ed25519',
```

with:

```ts
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [WRITE],
      toolOverrides: [],
      publishedAt: '2026-10-04T00:00:00.000Z',
      signature: {
        algorithm: 'Ed25519',
```

In `src/runtime/__tests__/source-parity.test.ts`, replace:

```ts
      requiresApproval: fact.requiresApproval,
      allowedRoles: fact.allowedRoles,
    })),
    publishedAt: '2026-08-12T00:00:00.000Z',
  });
  return createTurnSnapshot({
```

with:

```ts
      requiresApproval: fact.requiresApproval,
      allowedRoles: fact.allowedRoles,
    })),
    toolOverrides: [],
    publishedAt: '2026-08-12T00:00:00.000Z',
  });
  return createTurnSnapshot({
```

In `src/runtime/__tests__/turn-snapshot.test.ts`, replace:

```ts
    requiresApproval: false,
    allowedRoles: ['admin'],
  }],
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};
```

with:

```ts
    requiresApproval: false,
    allowedRoles: ['admin'],
  }],
  toolOverrides: [],
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};
```

In `src/sync/__tests__/local-deployment-validator.test.ts`, replace:

```ts
        requiresApproval: false,
        allowedRoles: ['member'],
      }],
      publishedAt: '2026-07-29T00:00:00.000Z',
      signature,
    },
```

with:

```ts
        requiresApproval: false,
        allowedRoles: ['member'],
      }],
      toolOverrides: [],
      publishedAt: '2026-07-29T00:00:00.000Z',
      signature,
    },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-overrides.test.ts src/runtime/__tests__/policy-overlay.test.ts src/runtime/__tests__/source-parity.test.ts src/runtime/__tests__/turn-snapshot.test.ts src/sync/__tests__/local-deployment-validator.test.ts`
Expected: FAIL — `Cannot find module '../tool-policy-entry.js'` in `tool-overrides.test.ts`; the four adjusted fixture files still pass. `Test Files  1 failed | 4 passed (5)`, `Tests  34 passed (34)`

- [ ] **Step 3: Create the leaf module**

Create `src/contracts/tool-policy-entry.ts`:

```ts
import { z } from 'zod';

/**
 * Leaf module of the policy contract. `revisions.ts` (signed Platform
 * revisions) and `tool-policy.ts` (local policy resolution) both import it
 * and it imports neither, so the two never form an ESM import cycle.
 */
export const ToolRiskClassSchema = z.enum([
  'safe-read',
  'read-sensitive',
  'write',
  'delete',
  'financial',
  'external',
  'unknown',
]);

export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const ToolPolicyPinSchema = z.object({
  toolId: z.uuid(),
  atRiskClass: ToolRiskClassSchema,
}).strict();

/** One policy layer entry: the same shape for local files and Platform deltas. */
export const ToolPolicyEntrySchema = z.object({
  enabled: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  riskClass: ToolRiskClassSchema.optional(),
  allowedRoles: z.array(boundedText(200)).max(100).optional(),
  description: boundedText(4_000).optional(),
  reason: boundedText(500).optional(),
  pin: ToolPolicyPinSchema.optional(),
}).strict();

export interface ToolPolicyEntry {
  enabled?: boolean;
  requiresApproval?: boolean;
  riskClass?: ToolRiskClass;
  allowedRoles?: string[];
  description?: string;
  reason?: string;
  pin?: { toolId: string; atRiskClass: ToolRiskClass };
}

/**
 * A signed Platform decision for one tool the deployed code reported
 * (P08b shared contract item 1): only fields an operator decided, never a
 * copy of the local value. The runtime applies it restrict-only.
 */
export const ToolOverrideDeltaSchema = ToolPolicyEntrySchema.extend({
  toolId: z.uuid(),
}).strict();

export type ToolOverrideDelta = { toolId: string } & ToolPolicyEntry;
```

- [ ] **Step 4: Point `tool-policy.ts` and `revisions.ts` at the leaf**

1. In `src/contracts/tool-policy.ts`, replace:

```ts
import { z } from 'zod';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { findSensitiveStringPath } from './content-boundary.js';
import { ToolRiskClassSchema, type ToolRiskClass } from './revisions.js';
import { parseExcludePattern } from './tool-exclude-pattern.js';

/**
 * Version of the default table and the policy bounds below. The golden
```

with:

```ts
import { z } from 'zod';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { findSensitiveStringPath } from './content-boundary.js';
import { parseExcludePattern } from './tool-exclude-pattern.js';
import {
  ToolPolicyEntrySchema,
  ToolRiskClassSchema,
  type ToolPolicyEntry,
  type ToolRiskClass,
} from './tool-policy-entry.js';

export {
  ToolOverrideDeltaSchema,
  ToolPolicyEntrySchema,
  ToolPolicyPinSchema,
} from './tool-policy-entry.js';
export type { ToolOverrideDelta, ToolPolicyEntry } from './tool-policy-entry.js';

/**
 * Version of the default table and the policy bounds below. The golden
```

2. In `src/contracts/tool-policy.ts`, replace:

```ts
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const stableKey = z.string().min(1).max(512);

export const ToolPolicyPinSchema = z.object({
  toolId: z.uuid(),
  atRiskClass: ToolRiskClassSchema,
}).strict();

/** One policy layer entry: the same shape for local files and Platform deltas. */
export const ToolPolicyEntrySchema = z.object({
  enabled: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  riskClass: ToolRiskClassSchema.optional(),
  allowedRoles: z.array(boundedText(200)).max(100).optional(),
  description: boundedText(4_000).optional(),
  reason: boundedText(500).optional(),
  pin: ToolPolicyPinSchema.optional(),
}).strict();

export interface ToolPolicyEntry {
  enabled?: boolean;
  requiresApproval?: boolean;
  riskClass?: ToolRiskClass;
  allowedRoles?: string[];
  description?: string;
  reason?: string;
  pin?: { toolId: string; atRiskClass: ToolRiskClass };
}

/**
 * `.glirastes/tool-policy.json`. Written by the developer or the CLI only,
 * never by an agent; `tools refresh` never rewrites it.
```

with:

```ts
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const stableKey = z.string().min(1).max(512);

/**
 * `.glirastes/tool-policy.json`. Written by the developer or the CLI only,
 * never by an agent; `tools refresh` never rewrites it.
```

1. In `src/contracts/revisions.ts`, replace:

```ts
import { z } from 'zod';
import { ExecutionBudgetSchema } from './runtime.js';
import { findForbiddenContentPath } from './content-boundary.js';

const uuid = z.uuid();
const identifier = z.string().trim().min(1).max(200);
```

with:

```ts
import { z } from 'zod';
import { ExecutionBudgetSchema } from './runtime.js';
import { findForbiddenContentPath } from './content-boundary.js';
import { ToolOverrideDeltaSchema, ToolRiskClassSchema } from './tool-policy-entry.js';

export { ToolRiskClassSchema } from './tool-policy-entry.js';

const uuid = z.uuid();
const identifier = z.string().trim().min(1).max(200);
```

2. In `src/contracts/revisions.ts`, replace:

```ts
  providerAlias: identifier.optional(),
}).strict();

export const ToolRiskClassSchema = z.enum([
  'safe-read',
  'read-sensitive',
  'write',
  'delete',
  'financial',
  'external',
  'unknown',
]);

/**
 * Curated, locale-specific labels for operator-facing surfaces. These values
 * describe the operation; they never replace policy or execution checks.
```

with:

```ts
  providerAlias: identifier.optional(),
}).strict();

/**
 * Curated, locale-specific labels for operator-facing surfaces. These values
 * describe the operation; they never replace policy or execution checks.
```

3. In `src/contracts/revisions.ts`, replace:

```ts
  environmentId: uuid,
  budget: ExecutionBudgetSchema,
  toolPolicies: z.array(RuntimeToolPolicySchema),
  publishedAt,
  signature: RevisionSignatureSchema,
}).strict();
```

with:

```ts
  environmentId: uuid,
  budget: ExecutionBudgetSchema,
  toolPolicies: z.array(RuntimeToolPolicySchema),
  /**
   * Signed Platform decisions as deltas (P08b shared contract item 2): only
   * fields an operator decided, one entry per tool. Absent on revisions
   * without decisions, which therefore keep their bytes.
   */
  toolOverrides: z.array(ToolOverrideDeltaSchema).max(5_000).default([])
    .superRefine((deltas, context) => {
      const seen = new Set<string>();
      deltas.forEach((delta, index) => {
        if (seen.has(delta.toolId)) {
          context.addIssue({
            code: 'custom',
            message: 'A tool has more than one Platform decision',
            path: [index, 'toolId'],
          });
        }
        seen.add(delta.toolId);
      });
    }),
  publishedAt,
  signature: RevisionSignatureSchema,
}).strict();
```

1. In `src/contracts/index.ts`, replace:

```ts

export {
  TOOL_POLICY_RULES_VERSION,
  ToolPolicyEntrySchema,
  ToolPolicyFileSchema,
  ToolPolicyPinSchema,
```

with:

```ts

export {
  TOOL_POLICY_RULES_VERSION,
  ToolOverrideDeltaSchema,
  ToolPolicyEntrySchema,
  ToolPolicyFileSchema,
  ToolPolicyPinSchema,
```

2. In `src/contracts/index.ts`, replace:

```ts
  RiskTier,
  ToolPolicyDefaults,
  ToolPolicyDefaultsInput,
  ToolPolicyEntry,
  ToolPolicyFile,
  ToolPolicyWarningCode,
```

with:

```ts
  RiskTier,
  ToolPolicyDefaults,
  ToolPolicyDefaultsInput,
  ToolOverrideDelta,
  ToolPolicyEntry,
  ToolPolicyFile,
  ToolPolicyWarningCode,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-overrides.test.ts src/runtime/__tests__/policy-overlay.test.ts src/runtime/__tests__/source-parity.test.ts src/runtime/__tests__/turn-snapshot.test.ts src/sync/__tests__/local-deployment-validator.test.ts && bun run typecheck`
Expected: PASS — `Test Files  5 passed (5)`, `Tests  42 passed (42)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/__tests__/tool-overrides.test.ts src/contracts/index.ts src/contracts/revisions.ts \
  src/contracts/tool-policy-entry.ts src/contracts/tool-policy.ts src/runtime/__tests__/policy-overlay.test.ts \
  src/runtime/__tests__/source-parity.test.ts src/runtime/__tests__/turn-snapshot.test.ts \
  src/sync/__tests__/local-deployment-validator.test.ts
git commit -m "feat(contracts): carry signed tool override deltas on policy revisions"
```

### Task 2: The overlay reads the deltas and their descriptions

**Files:**
- Modify: `src/runtime/policy-overlay.ts` (`policyOverlayFromRevision` from `toolOverrides`; `overlayDescriptions`), `src/runtime/local-runtime-source.ts` (the managed manifest carries the Platform descriptions; its cache key includes the overlay revision)
- Test: `src/runtime/__tests__/policy-overlay.test.ts`, `src/runtime/__tests__/local-runtime-source.test.ts`

**Interfaces:**
- Consumes: `RuntimePolicyRevision.toolOverrides` (Task 1), `applyPolicyOverlay` (P02, unchanged and restrict-only), `createLocalRuntimeSource` options `policyOverlay` and `platformRevisions` (P02 coupling kept, so revocations by `agentRevisionIds` and `policyRevisionIds` keep matching).
- Produces:
  - `policyOverlayFromRevision(revision).entries` = copies of `revision.toolOverrides` (no longer the reported `toolPolicies`, which would freeze an old local value; ledger X2 contract item 2).
  - `export function overlayDescriptions(localToolIds: ReadonlySet<string>, overlay: ReadonlyArray<PolicyOverlayEntry>): Map<string, string>` — the last delta per tool wins, ids the code does not have are ignored.
  - In managed mode the signed local manifest stands in for the Platform manifest with the Platform description of each tool that has one, so `materializeManifestToolRegistry` hands the model that text (ledger X2: "the overlay adapter carries the delta description, and the local runtime source uses it for the model-facing description").

- [ ] **Step 1: Write the failing tests**

1. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
} from '../../contracts/tool-policy.js';
import {
  applyPolicyOverlay,
  policyOverlayFromRevision,
} from '../policy-overlay.js';

```

with:

```ts
} from '../../contracts/tool-policy.js';
import {
  applyPolicyOverlay,
  overlayDescriptions,
  policyOverlayFromRevision,
} from '../policy-overlay.js';

```

2. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
});

describe('policyOverlayFromRevision', () => {
  it('maps a verified policy revision to entries and keeps its identity', () => {
    const revision: RuntimePolicyRevision = {
      revisionId: '55555555-5555-4555-8555-555555555555',
      revision: 7,
      tenantId: '66666666-6666-4666-8666-666666666666',
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [WRITE],
      toolOverrides: [],
      publishedAt: '2026-10-04T00:00:00.000Z',
      signature: {
        algorithm: 'Ed25519',
        keyId: 'platform-key',
        value: 'c2lnbmF0dXJl',
      },
    };

    expect(policyOverlayFromRevision(revision)).toEqual({
      revisionId: revision.revisionId,
      revision: 7,
      budget: BUDGET,
      entries: [{
        toolId: WRITE_ID,
        enabled: true,
        requiresApproval: true,
        riskClass: 'write',
        allowedRoles: ['member'],
      }],
    });
  });
});
```

with:

```ts
});

describe('policyOverlayFromRevision', () => {
  const revision: RuntimePolicyRevision = {
    revisionId: '55555555-5555-4555-8555-555555555555',
    revision: 7,
    tenantId: '66666666-6666-4666-8666-666666666666',
    environmentId: '77777777-7777-4777-8777-777777777777',
    budget: BUDGET,
    toolPolicies: [WRITE, READ],
    toolOverrides: [],
    publishedAt: '2026-10-04T00:00:00.000Z',
    signature: {
      algorithm: 'Ed25519',
      keyId: 'platform-key',
      value: 'c2lnbmF0dXJl',
    },
  };

  it('reads the signed decision deltas, never the reported toolPolicies copies', () => {
    const toolOverrides = [
      { toolId: WRITE_ID, enabled: false, description: 'Archives a task.' },
      { toolId: REMOVED_ID, riskClass: 'delete' as const },
    ];
    expect(policyOverlayFromRevision({ ...revision, toolOverrides })).toEqual({
      revisionId: revision.revisionId,
      revision: 7,
      budget: BUDGET,
      entries: toolOverrides,
    });
  });

  it('leaves the local policy untouched when the Platform decided nothing', () => {
    const overlay = policyOverlayFromRevision(revision);
    expect(overlay.entries).toEqual([]);
    // A later local relaxation is no longer frozen by a copied Platform value.
    const relaxedLocally = { ...WRITE, allowedRoles: [] };
    expect(applyPolicyOverlay([relaxedLocally], overlay.entries).policies).toEqual([relaxedLocally]);
  });
});

describe('overlayDescriptions', () => {
  it('takes a Platform description only for tools the code has', () => {
    expect(overlayDescriptions(new Set([READ_ID, WRITE_ID]), [
      { toolId: WRITE_ID, description: 'Archives a task.' },
      { toolId: READ_ID, enabled: false },
      { toolId: REMOVED_ID, description: 'Never shown.' },
    ])).toEqual(new Map([[WRITE_ID, 'Archives a task.']]));
  });

  it('lets the last delta for a tool win, like the policy layers', () => {
    expect(overlayDescriptions(new Set([WRITE_ID]), [
      { toolId: WRITE_ID, description: 'First.' },
      { toolId: WRITE_ID, description: 'Second.' },
    ]).get(WRITE_ID)).toBe('Second.');
  });
});
```

In `src/runtime/__tests__/local-runtime-source.test.ts`, replace:

```ts
    })).rejects.toThrow(/manifest_tool_unavailable/);
  });

  it('pins each turn to the overlay it started with and never calls the network', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
```

with:

```ts
    })).rejects.toThrow(/manifest_tool_unavailable/);
  });

  it('gives the model the Platform description of a tool the code has', () => {
    const source = managedSource(() => overlay([
      { toolId: ENDPOINT_TOOL_ID, description: 'Lists only the tasks assigned to you.' },
      { toolId: REMOVED_TOOL_ID, description: 'Never shown.' },
    ]));

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-description', principal });
    const registry = materializeManifestToolRegistry({ snapshot, bindings: fixtureBindings() });

    expect(registry.tasks_listTasks!.description).toBe('Lists only the tasks assigned to you.');
    expect(registry.ui_navigate!.description).toBe('Navigate the app to a named view.');
    expect(snapshot.manifestRevision.revisionId).toBe(PLATFORM_MANIFEST_REVISION_ID);
    expect(snapshot.manifestRevision.tools.map((tool) => tool.toolId)).not.toContain(REMOVED_TOOL_ID);
    const standalone = createLocalRuntimeSource(fixtureOptions());
    const local = standalone.resolveTurnSnapshot({
      turnId: 't-description',
      principal: fixturePrincipal(standalone.identity.tenantId),
    });
    expect(local.manifestRevision.tools.find((tool) => tool.toolId === ENDPOINT_TOOL_ID)?.description)
      .toBe('List the tasks the caller may see.');
  });

  it('switches to a new Platform description only for turns that start after it', () => {
    let current = overlay([{ toolId: ENDPOINT_TOOL_ID, description: 'First Platform text.' }]);
    const source = managedSource(() => current);
    const first = source.resolveTurnSnapshot({ turnId: 't-first', principal });
    current = overlay([{ toolId: ENDPOINT_TOOL_ID, description: 'Second Platform text.' }], { revision: 4 });
    const second = source.resolveTurnSnapshot({ turnId: 't-second', principal });

    const describeTool = (snapshot: typeof first) => snapshot.manifestRevision.tools
      .find((tool) => tool.toolId === ENDPOINT_TOOL_ID)?.description;
    expect(describeTool(first)).toBe('First Platform text.');
    expect(describeTool(second)).toBe('Second Platform text.');
    expect(describeTool(source.resolveTurnSnapshot({ turnId: 't-first', principal }))).toBe('First Platform text.');
  });

  it('pins each turn to the overlay it started with and never calls the network', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/local-runtime-source.test.ts src/runtime/__tests__/policy-overlay.test.ts`
Expected: FAIL — `overlayDescriptions` is not exported yet, the overlay still copies `toolPolicies`, and the managed manifest keeps the local description. `Test Files  2 failed (2)`, `Tests  6 failed | 36 passed (42)`

- [ ] **Step 3: Read the deltas in the overlay adapter**

1. In `src/runtime/policy-overlay.ts`, replace:

```ts
  };
}

/**
 * Reads a Platform policy revision the sync manager already verified as an
 * overlay. Values that copy the local base are harmless: composition is
 * restrict-only, so a copy resolves to the local value.
 *
 * TRANSITIONAL: the revision carries full `toolPolicies` copies, not a delta,
 * so every tool the Platform lists becomes an entry and a tool the Platform
 * copied at a stricter value than a later local change stays over-restricted
 * until the Platform republishes. The signed `RuntimePolicyRevision.toolOverrides`
 * delta field and its overlay adapter are owned by P08 (SDK lockstep) and land
 * before P11 wires `policyOverlay` into Get It Done; this mapping is then
 * replaced. A Platform relaxation ("Lockern") stays ineffective here: it needs
 * a committed local entry, so P08 must not present it as effective in managed
 * mode without one.
 */
export function policyOverlayFromRevision(
  revision: RuntimePolicyRevision,
```

with:

```ts
  };
}

/**
 * Platform descriptions for tools the deployed code has (spec 4.5: Platform >
 * local > code for prose). The last delta for a tool wins, like the policy
 * layers; deltas for tools the code does not have are ignored.
 */
export function overlayDescriptions(
  localToolIds: ReadonlySet<string>,
  overlay: ReadonlyArray<PolicyOverlayEntry>,
): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const entry of overlay) {
    if (entry.description !== undefined && localToolIds.has(entry.toolId)) {
      descriptions.set(entry.toolId, entry.description);
    }
  }
  return descriptions;
}

/**
 * Reads a Platform policy revision the sync manager already verified as an
 * overlay. The entries are the signed `toolOverrides` deltas (P08b shared
 * contract item 2), never the reported `toolPolicies`: those repeat what the
 * code reported and would freeze an old local value. Composition stays
 * restrict-only, so a Platform relaxation remains a no-op without a committed
 * local entry, and the revision id keeps Platform revocations matching.
 */
export function policyOverlayFromRevision(
  revision: RuntimePolicyRevision,
```

2. In `src/runtime/policy-overlay.ts`, replace:

```ts
  return {
    revisionId: revision.revisionId,
    revision: revision.revision,
    entries: revision.toolPolicies.map((policy) => ({
      toolId: policy.toolId,
      enabled: policy.enabled,
      requiresApproval: policy.requiresApproval,
      riskClass: policy.riskClass,
      allowedRoles: [...policy.allowedRoles],
    })),
    budget: revision.budget,
  };
}
```

with:

```ts
  return {
    revisionId: revision.revisionId,
    revision: revision.revision,
    entries: revision.toolOverrides.map((delta) => ({ ...delta })),
    budget: revision.budget,
  };
}
```

- [ ] **Step 4: Give the model the Platform description in managed mode**

1. In `src/runtime/local-runtime-source.ts`, replace:

```ts
import type { LocalToolBinding } from './local-tool-bindings.js';
import {
  applyPolicyOverlay,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

with:

```ts
import type { LocalToolBinding } from './local-tool-bindings.js';
import {
  applyPolicyOverlay,
  overlayDescriptions,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

2. In `src/runtime/local-runtime-source.ts`, replace:

```ts
  const enabledTools = artifact.tools.filter((tool) => tool.enabled);
  const manifestTools = enabledTools.map(materializeManifestTool);

  const signManifestRevision = (ref: RevisionRef): ManifestRevision =>
    ManifestRevisionSchema.parse(signer.sign({
      revisionId: ref.revisionId,
      revision: ref.revision,
```

with:

```ts
  const enabledTools = artifact.tools.filter((tool) => tool.enabled);
  const manifestTools = enabledTools.map(materializeManifestTool);

  const signManifestRevision = (
    ref: RevisionRef,
    descriptions: ReadonlyMap<string, string> = new Map(),
  ): ManifestRevision =>
    ManifestRevisionSchema.parse(signer.sign({
      revisionId: ref.revisionId,
      revision: ref.revision,
```

3. In `src/runtime/local-runtime-source.ts`, replace:

```ts
      targetAppId: identity.targetAppId,
      environmentId: identity.environmentId,
      sourceDigest: artifact.discoveryDigest,
      tools: manifestTools,
      publishedAt: artifact.generatedAt,
    }));

```

with:

```ts
      targetAppId: identity.targetAppId,
      environmentId: identity.environmentId,
      sourceDigest: artifact.discoveryDigest,
      // The model-facing description: Platform > local > code (spec 4.5).
      tools: manifestTools.map((tool) => {
        const description = descriptions.get(tool.toolId);
        return description === undefined ? tool : { ...tool, description };
      }),
      publishedAt: artifact.generatedAt,
    }));

```

4. In `src/runtime/local-runtime-source.ts`, replace:

```ts
    return revision;
  };

  /**
   * The local agent and manifest stand in for the Platform revisions of the
   * accepted deployment and carry their ids, so agent revocations match.
   */
  const platformRevisionsFor = (refs: PlatformRevisionRefs) => {
    const key = [
      refs.agentRevision.revisionId,
      refs.agentRevision.revision,
      refs.manifestRevision.revisionId,
      refs.manifestRevision.revision,
    ].join('/');
    if (platform?.key !== key) {
      platform = {
        key,
        agentRevision: signAgentRevision(refs.agentRevision),
        manifestRevision: signManifestRevision(refs.manifestRevision),
      };
    }
    return platform;
```

with:

```ts
    return revision;
  };

  const localToolIds = new Set(localToolPolicies.map((policy) => policy.toolId));

  /**
   * The local agent and manifest stand in for the Platform revisions of the
   * accepted deployment and carry their ids, so agent revocations match. The
   * manifest carries the overlay's descriptions, so the model sees them.
   */
  const platformRevisionsFor = (
    refs: PlatformRevisionRefs,
    overlay: VerifiedPolicyOverlay,
  ) => {
    const key = [
      refs.agentRevision.revisionId,
      refs.agentRevision.revision,
      refs.manifestRevision.revisionId,
      refs.manifestRevision.revision,
      overlay.revisionId,
      overlay.revision,
    ].join('/');
    if (platform?.key !== key) {
      platform = {
        key,
        agentRevision: signAgentRevision(refs.agentRevision),
        manifestRevision: signManifestRevision(
          refs.manifestRevision,
          overlayDescriptions(localToolIds, overlay.entries),
        ),
      };
    }
    return platform;
```

5. In `src/runtime/local-runtime-source.ts`, replace:

```ts
    if (!overlay || !refs) {
      return { agentRevision, manifestRevision, policyRevision: basePolicyRevision };
    }
    const managed = platformRevisionsFor(refs);
    return {
      agentRevision: managed.agentRevision,
      manifestRevision: managed.manifestRevision,
```

with:

```ts
    if (!overlay || !refs) {
      return { agentRevision, manifestRevision, policyRevision: basePolicyRevision };
    }
    const managed = platformRevisionsFor(refs, overlay);
    return {
      agentRevision: managed.agentRevision,
      manifestRevision: managed.manifestRevision,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/local-runtime-source.test.ts src/runtime/__tests__/policy-overlay.test.ts && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  42 passed (42)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/__tests__/local-runtime-source.test.ts src/runtime/__tests__/policy-overlay.test.ts \
  src/runtime/local-runtime-source.ts src/runtime/policy-overlay.ts
git commit -m "feat(runtime): apply platform decision deltas and their descriptions"
```

### Task 3: Platform decisions on every turn snapshot

**Files:**
- Modify: `src/runtime/turn-snapshot.ts` (`withPlatformDecisions`)
- Test: `src/runtime/__tests__/turn-snapshot.test.ts`

**Interfaces:**
- Consumes: `applyPolicyOverlay` (P02), `RuntimePolicyRevision.toolOverrides` (Task 1).
- Produces: `createTurnSnapshot(options).policyRevision.toolPolicies` are the effective policies — the signed `toolPolicies` restricted by the same revision's `toolOverrides`. Revision id, revision number, signature and `toolOverrides` stay as signed; a revision without deltas is pinned unchanged. A revision composed by `createLocalRuntimeSource` carries no deltas (its overlay is already applied), and applying the same deltas twice changes nothing.

Why: P08b moves every Platform decision out of `toolPolicies` into `toolOverrides`. The Get It Done pilot's managed path builds turn snapshots straight from the materialized Platform revisions (`createTurnSnapshot({ policyRevision: revisions.policyRevision, … })` in the pilot's `src/lib/glirastes/bindings.ts`). Before this plan, a runner refused a policy with decisions (strict schema, fail closed); after Task 1 it would accept it and silently ignore the decisions. This task keeps "a Platform disable is obeyed" true on that path until P11 wires `policyOverlay`.

- [ ] **Step 1: Write the failing test**

In `src/runtime/__tests__/turn-snapshot.test.ts`, replace:

```ts
  });
});

describe('assertPromptPinForResume', () => {
  const promptPin = {
    revisionId: '019fb003-0000-7000-8000-000000000004',
```

with:

```ts
  });
});

describe('createTurnSnapshot with signed Platform decisions', () => {
  const toolId = agentRevision.toolAllowlist[0]!;
  const snapshotWith = (toolOverrides: RuntimePolicyRevision['toolOverrides']) => createTurnSnapshot({
    turnId: 'turn-decisions',
    agentRevision,
    manifestRevision,
    policyRevision: { ...policyRevision, toolOverrides },
    principal,
    localLimits,
  });

  it('restricts the reported tool policies by the signed deltas, whatever path built the snapshot', () => {
    const disabled = snapshotWith([{ toolId, enabled: false }]);
    expect(disabled.policyRevision.toolPolicies).toEqual([{
      toolId, enabled: false, riskClass: 'safe-read', requiresApproval: false, allowedRoles: ['admin'],
    }]);
    expect(disabled.policyRevision.toolOverrides).toEqual([{ toolId, enabled: false }]);
    expect(disabled.policyRevision.revisionId).toBe(policyRevision.revisionId);

    const raised = snapshotWith([{ toolId, riskClass: 'delete', allowedRoles: ['admin', 'owner'] }]);
    expect(raised.policyRevision.toolPolicies[0]).toMatchObject({
      enabled: true, riskClass: 'delete', requiresApproval: true, allowedRoles: ['admin'],
    });
  });

  it('never loosens and ignores decisions for tools the revision does not carry', () => {
    const snapshot = snapshotWith([
      { toolId, enabled: true, riskClass: 'safe-read', requiresApproval: false },
      { toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3aff', enabled: false },
    ]);
    expect(snapshot.policyRevision.toolPolicies).toEqual(policyRevision.toolPolicies);
  });

  it('keeps a revision without decisions exactly as signed', () => {
    expect(snapshotWith([]).policyRevision).toEqual(policyRevision);
  });
});

describe('assertPromptPinForResume', () => {
  const promptPin = {
    revisionId: '019fb003-0000-7000-8000-000000000004',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/turn-snapshot.test.ts`
Expected: FAIL — the snapshot pins the reported policies unchanged. `Test Files  1 failed (1)`, `Tests  1 failed | 10 passed (11)`

- [ ] **Step 3: Fold the deltas when the snapshot is created**

1. In `src/runtime/turn-snapshot.ts`, replace:

```ts
  RuntimePolicyRevision,
  SecurityRevocation,
} from '../contracts/index.js';

export interface TurnSnapshot {
  readonly turnId: string;
```

with:

```ts
  RuntimePolicyRevision,
  SecurityRevocation,
} from '../contracts/index.js';
import { applyPolicyOverlay } from './policy-overlay.js';

export interface TurnSnapshot {
  readonly turnId: string;
```

2. In `src/runtime/turn-snapshot.ts`, replace:

```ts
  readonly principal: Principal;
  readonly agentRevision: AgentRevision;
  readonly manifestRevision: ManifestRevision;
  readonly policyRevision: RuntimePolicyRevision;
  readonly budget: ExecutionBudget;
  /**
```

with:

```ts
  readonly principal: Principal;
  readonly agentRevision: AgentRevision;
  readonly manifestRevision: ManifestRevision;
  /**
   * The pinned policy revision. Its `toolPolicies` are the effective ones:
   * the signed values restricted by the revision's own signed `toolOverrides`
   * deltas (restrict-only), so every consumer of the snapshot obeys Platform
   * decisions, whichever path built it.
   */
  readonly policyRevision: RuntimePolicyRevision;
  readonly budget: ExecutionBudget;
  /**
```

3. In `src/runtime/turn-snapshot.ts`, replace:

```ts
  };
}

export function createTurnSnapshot(options: {
  turnId: string;
  agentRevision: AgentRevision;
```

with:

```ts
  };
}

/**
 * Applies the signed `toolOverrides` deltas of a Platform policy revision to
 * its reported `toolPolicies`, restrict-only. A revision composed by the local
 * runtime source carries no deltas and stays as it is; one a consumer takes
 * straight from a Platform deployment no longer runs a tool the Platform
 * disabled. Applying the same deltas twice changes nothing.
 */
function withPlatformDecisions(policyRevision: RuntimePolicyRevision): RuntimePolicyRevision {
  const deltas = policyRevision.toolOverrides ?? [];
  if (deltas.length === 0) return policyRevision;
  return {
    ...policyRevision,
    toolPolicies: applyPolicyOverlay(policyRevision.toolPolicies, deltas).policies,
  };
}

export function createTurnSnapshot(options: {
  turnId: string;
  agentRevision: AgentRevision;
```

4. In `src/runtime/turn-snapshot.ts`, replace:

```ts
    principal: clone(principal),
    agentRevision: clone(agentRevision),
    manifestRevision: clone(manifestRevision),
    policyRevision: clone(policyRevision),
    budget: minBudget(options.localLimits, agentRevision.budget, policyRevision.budget),
    ...(options.promptPin ? { promptPin: clone(options.promptPin) } : {}),
  };
```

with:

```ts
    principal: clone(principal),
    agentRevision: clone(agentRevision),
    manifestRevision: clone(manifestRevision),
    policyRevision: clone(withPlatformDecisions(policyRevision)),
    budget: minBudget(options.localLimits, agentRevision.budget, policyRevision.budget),
    ...(options.promptPin ? { promptPin: clone(options.promptPin) } : {}),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/turn-snapshot.test.ts && bunx vitest run src/runtime src/sync && bun run typecheck`
Expected: PASS — the snapshot file reports `Test Files  1 passed (1)`, `Tests  11 passed (11)`; the runtime and sync suites report `Test Files  35 passed (35)`, `Tests  298 passed (298)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/__tests__/turn-snapshot.test.ts src/runtime/turn-snapshot.ts
git commit -m "fix(runtime): apply signed platform decisions on every turn snapshot"
```

### Task 4: Ignore Platform tools the deployed code lacks

**Files:**
- Modify: `src/sync/local-deployment-validator.ts`, `src/sync/index.ts`
- Test: `src/sync/__tests__/local-deployment-validator.test.ts`

**Interfaces:**
- Consumes: `localToolBindingMismatches` (`src/runtime/local-tool-bindings.ts`, unchanged), the reported `toolPolicies` (P08b shared contract item 2).
- Produces:
  - `validateLocalDeploymentBindings(options): LocalDeploymentValidation` (was `void`); `export interface LocalDeploymentValidation { ignored: IgnoredPlatformTool[] }` sorted by `toolId`; `export interface IgnoredPlatformTool { toolId: string; reason: 'platform-tool-not-in-code' | 'platform-tool-binding-mismatch'; mismatches?: string[] }`; both types exported from `glirastes/sync`.
  - Callers that ignore the return value (the pilot's `validateDeployment`) keep working; a caller may log the content-free `ignored` list.

Spec 4.9 says overlay ids without a local binding are ignored (`platform-tool-not-in-code`) and a missing or different binding disables only that tool. A runner that rejects the whole deployment instead keeps its last accepted one, so after any change of an existing tool every later Platform decision would be dropped until the Platform republishes. The runtime still disables such a tool per turn: the managed local runtime runs on the local manifest, and `materializeManifestToolRegistry` refuses a mismatching binding on the pilot's path (`E-BINDING-011`).

- [ ] **Step 1: Write the failing tests**

In `src/sync/__tests__/local-deployment-validator.test.ts`, replace:

```ts

describe('validateLocalDeploymentBindings', () => {
  it('accepts a deployment whose effective tools exactly match local bindings', () => {
    expect(() => validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: bindings(),
    })).not.toThrow();
  });

  it('rejects a changed source fingerprint before activation', () => {
    const localBindings = bindings();
    localBindings[0] = {
      ...localBindings[0]!,
      sourceFingerprint: 'sha256:b3RoZXI',
    };

    expect(() => validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: localBindings,
    })).toThrow(/source fingerprint/i);
  });

  it('rejects an allowlisted tool without an enabled policy', () => {
```

with:

```ts

describe('validateLocalDeploymentBindings', () => {
  it('accepts a deployment whose effective tools exactly match local bindings', () => {
    expect(validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: bindings(),
    })).toEqual({ ignored: [] });
  });

  it('ignores a Platform tool the deployed code does not have instead of rejecting the deployment', () => {
    expect(validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: [],
    })).toEqual({
      ignored: [{ toolId, reason: 'platform-tool-not-in-code' }],
    });
  });

  it('ignores a Platform tool whose local binding changed since the Platform saw it', () => {
    const localBindings = bindings();
    localBindings[0] = {
      ...localBindings[0]!,
      sourceFingerprint: 'sha256:b3RoZXI',
    };

    expect(validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: localBindings,
    })).toEqual({
      ignored: [{
        toolId,
        reason: 'platform-tool-binding-mismatch',
        mismatches: ['source fingerprint'],
      }],
    });
  });

  it('keeps a tool allowlisted that only a Platform decision disables', () => {
    const deployment = revisions();
    deployment.policyRevision.toolOverrides = [{ toolId, enabled: false }];

    expect(validateLocalDeploymentBindings({
      revisions: deployment,
      bindings: bindings(),
    })).toEqual({ ignored: [] });
  });

  it('rejects an allowlisted tool without an enabled policy', () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/sync/__tests__/local-deployment-validator.test.ts`
Expected: FAIL — the validator returns `undefined` and throws `Missing local tool binding` / `Local tool binding mismatch`. `Test Files  1 failed (1)`, `Tests  4 failed | 5 passed (9)`

- [ ] **Step 3: Report instead of rejecting**

1. In `src/sync/local-deployment-validator.ts`, replace:

```ts
import { riskTier } from '../contracts/tool-policy.js';
import {
  assertLocalToolBindingMatches,
  type LocalToolBinding,
} from '../runtime/local-tool-bindings.js';
import type {
  MaterializedDeploymentRevisions,
} from './materialize-deployment.js';

export function validateLocalDeploymentBindings(options: {
  revisions: MaterializedDeploymentRevisions;
  bindings: ReadonlyArray<LocalToolBinding>;
}): void {
  const bindings = uniqueIndex(
    options.bindings,
    (binding) => binding.toolId,
```

with:

```ts
import { riskTier } from '../contracts/tool-policy.js';
import {
  localToolBindingMismatches,
  type LocalToolBinding,
} from '../runtime/local-tool-bindings.js';
import type {
  MaterializedDeploymentRevisions,
} from './materialize-deployment.js';

export interface IgnoredPlatformTool {
  toolId: string;
  /**
   * `platform-tool-not-in-code`: the deployed code has no binding (spec 4.9).
   * `platform-tool-binding-mismatch`: the code changed the tool after the
   * Platform last saw it; the local manifest keeps running it.
   */
  reason: 'platform-tool-not-in-code' | 'platform-tool-binding-mismatch';
  /** Names of mismatched technical facts; never values or content. */
  mismatches?: string[];
}

export interface LocalDeploymentValidation {
  ignored: IgnoredPlatformTool[];
}

/**
 * Accepts a Platform deployment for the deployed code. A Platform tool the
 * code does not have, or has in a changed form, is ignored and reported
 * instead of rejecting the whole deployment, so restrict-only Platform
 * decisions keep reaching the runtime while the Platform catches up with the
 * code. Inconsistent Platform revisions still fail closed. The allowlist is
 * checked against the reported `toolPolicies`, never against `toolOverrides`
 * restrictions, so a tool only a Platform decision disables stays allowlisted.
 */
export function validateLocalDeploymentBindings(options: {
  revisions: MaterializedDeploymentRevisions;
  bindings: ReadonlyArray<LocalToolBinding>;
}): LocalDeploymentValidation {
  const bindings = uniqueIndex(
    options.bindings,
    (binding) => binding.toolId,
```

2. In `src/sync/local-deployment-validator.ts`, replace:

```ts
    'runtime tool policy',
  );
  const allowlist = new Set<string>();

  for (const toolId of options.revisions.agentRevision.toolAllowlist) {
    if (allowlist.has(toolId)) {
```

with:

```ts
    'runtime tool policy',
  );
  const allowlist = new Set<string>();
  const ignored: IgnoredPlatformTool[] = [];

  for (const toolId of options.revisions.agentRevision.toolAllowlist) {
    if (allowlist.has(toolId)) {
```

3. In `src/sync/local-deployment-validator.ts`, replace:

```ts
    }
    const binding = bindings.get(toolId);
    if (!binding) {
      throw new Error(`Missing local tool binding: ${toolId}`);
    }
    assertLocalToolBindingMatches(binding, manifestTool);
  }
}

function uniqueIndex<T>(
```

with:

```ts
    }
    const binding = bindings.get(toolId);
    if (!binding) {
      ignored.push({ toolId, reason: 'platform-tool-not-in-code' });
      continue;
    }
    const mismatches = localToolBindingMismatches(binding, manifestTool);
    if (mismatches.length > 0) {
      ignored.push({ toolId, reason: 'platform-tool-binding-mismatch', mismatches });
    }
  }
  return {
    ignored: ignored.sort((left, right) => (
      left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0
    )),
  };
}

function uniqueIndex<T>(
```

In `src/sync/index.ts`, replace:

```ts
export {
  validateLocalDeploymentBindings,
} from './local-deployment-validator.js';
export { createManagedRuntimeSync } from './managed-sync.js';
```

with:

```ts
export {
  validateLocalDeploymentBindings,
} from './local-deployment-validator.js';
export type {
  IgnoredPlatformTool,
  LocalDeploymentValidation,
} from './local-deployment-validator.js';
export { createManagedRuntimeSync } from './managed-sync.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/sync/__tests__/local-deployment-validator.test.ts && bunx vitest run src/sync && bun run typecheck`
Expected: PASS — the validator file reports `Test Files  1 passed (1)`, `Tests  9 passed (9)`; the sync suites report `Test Files  13 passed (13)`, `Tests  61 passed (61)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/sync/__tests__/local-deployment-validator.test.ts src/sync/index.ts src/sync/local-deployment-validator.ts
git commit -m "fix(sync): ignore platform tools the deployed code lacks"
```

### Task 5: Provenance and exclusions in the setup artifact contract

**Files:**
- Modify: `src/contracts/app-setup.ts`, `src/contracts/index.ts`
- Test: `src/contracts/__tests__/app-setup-provenance.test.ts` (Create)

**Interfaces:**
- Consumes: P08b shared contract item 5 and its Task 9 DTO, widened by ledger ruling X3 (`schemaSource` also `json-schema` and `none`, the values P03's `SchemaQuality` reports).
- Produces:
  - `export const AppSetupToolProvenanceSchema` (strict; `policyOrigin` partial and limited to `code-default`/`local-policy`, because a local report never knows a Platform origin), `export type AppSetupToolProvenance`.
  - `export const APP_SETUP_EXCLUSION_LIMITS = { maxEntries: 5_000, maxStableKeyLength: 512 }` (ledger X4), `export const AppSetupExclusionSchema`, `export type AppSetupExclusion`.
  - `AppSetupToolCandidate.provenance?` and `AppSetupArtifact.exclusions?` — `.optional()`, never defaulted, so absent stays "not reported" and old artifacts keep their digests.

- [ ] **Step 1: Write the failing tests**

Create `src/contracts/__tests__/app-setup-provenance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  APP_SETUP_EXCLUSION_LIMITS,
  AppSetupArtifactSchema,
  AppSetupToolProvenanceSchema,
} from '../app-setup.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

const tool = {
  toolId: id('404'),
  sourceFingerprint: digest('B'),
  name: 'tasks.list',
  executionKind: 'endpoint',
  method: 'GET',
  path: '/api/tasks',
  operationGroup: 'read',
  riskClass: 'safe-read',
  enabled: true,
  requiresApproval: false,
  inputSchemaDigest: digest('C'),
  outputSchemaDigest: digest('D'),
};

const artifact = {
  schemaVersion: 1,
  artifactId: id('401'),
  runId: id('402'),
  appId: id('403'),
  discoveryDigest: digest('A'),
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [tool],
  planner: {
    plannerId: id('405'),
    modelBindingRef: 'default',
    promptBindingRef: 'prompt:fixture',
    budgetProfileRef: 'default',
    toolIds: [id('404')],
  },
  prompts: {
    bundleDigest: digest('E'),
    artifactRef: 'local://fixture/prompts',
    plannerDigest: digest('F'),
    appBehaviorDigest: digest('G'),
    responseStyleDigest: digest('H'),
    capabilityFragmentDigests: {},
  },
  warnings: [],
  generatedAt: '2026-10-05T08:00:00.000Z',
};

const provenance = {
  policyOrigin: {
    enabled: 'code-default',
    requiresApproval: 'local-policy',
    riskClass: 'code-default',
    allowedRoles: 'code-default',
    description: 'local-policy',
  },
  contractSource: 'derived',
  descriptionSource: 'template',
  schemaSource: 'field-names',
};

describe('capability report extensions of the setup artifact (P08b shared contract item 5)', () => {
  it('accepts content-free provenance per tool and reasoned exclusions', () => {
    const parsed = AppSetupArtifactSchema.parse({
      ...artifact,
      tools: [{ ...tool, provenance }],
      exclusions: [
        { stableKey: 'POST /api/auth/token', origin: 'default' },
        { stableKey: 'OPTIONS /api/tasks', origin: 'code' },
        { stableKey: 'PAGE /admin', origin: 'policy' },
      ],
    });
    expect(parsed.tools[0]?.provenance).toEqual(provenance);
    expect(parsed.exclusions).toHaveLength(3);
  });

  it('keeps absent extensions absent instead of defaulting them', () => {
    const parsed = AppSetupArtifactSchema.parse(artifact);
    expect(parsed).not.toHaveProperty('exclusions');
    expect(parsed.tools[0]).not.toHaveProperty('provenance');
  });

  it.each(['zod', 'openapi', 'json-schema', 'agent', 'field-names', 'none'])(
    'accepts the schema quality %s the generator reports',
    (schemaSource) => {
      expect(AppSetupToolProvenanceSchema.safeParse({ schemaSource }).success).toBe(true);
    },
  );

  it.each([
    ['an unknown description source', { descriptionSource: 'llm' }],
    ['a Platform origin, which a local report never has', { policyOrigin: { enabled: 'platform' } }],
    ['an unknown field', { model: 'any' }],
    ['an unknown contract source', { contractSource: 'guess' }],
  ])('rejects provenance with %s', (_label, value) => {
    expect(AppSetupToolProvenanceSchema.safeParse(value).success).toBe(false);
  });

  it('enforces the Platform caps on exclusions', () => {
    const { maxEntries, maxStableKeyLength } = APP_SETUP_EXCLUSION_LIMITS;
    expect([maxEntries, maxStableKeyLength]).toEqual([5_000, 512]);
    const parse = (exclusions: unknown) => AppSetupArtifactSchema.safeParse({ ...artifact, exclusions }).success;
    expect(parse([{ stableKey: `GET /${'a'.repeat(maxStableKeyLength - 5)}`, origin: 'default' }])).toBe(true);
    expect(parse([{ stableKey: `GET /${'a'.repeat(maxStableKeyLength - 4)}`, origin: 'default' }])).toBe(false);
    expect(parse(Array.from({ length: maxEntries + 1 }, (_, index) => ({
      stableKey: `GET /api/hidden/${index}`, origin: 'policy',
    })))).toBe(false);
    expect(parse([{ stableKey: 'GET /api/x', origin: 'manual' }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/app-setup-provenance.test.ts`
Expected: FAIL — `APP_SETUP_EXCLUSION_LIMITS` and `AppSetupToolProvenanceSchema` are undefined and the strict artifact schema refuses both new keys. `Test Files  1 failed (1)`, `Tests  12 failed | 1 passed (13)`

- [ ] **Step 3: Extend the contract**

1. In `src/contracts/app-setup.ts`, replace:

```ts
  'needs_attention',
]);

export const AppSetupToolCandidateSchema = z.object({
  toolId: uuid,
  sourceFingerprint: digest,
```

with:

```ts
  'needs_attention',
]);

const LocalPolicyOriginSchema = z.enum(['code-default', 'local-policy']);

/**
 * Optional, content-free provenance a capability report carries per tool
 * (P08b shared contract item 5): where each local policy value came from and
 * how description and input schema were obtained ("von Hand / aus Code /
 * Agent / Vorlage", "Zod / OpenAPI / Agent / nur Feldnamen"). A local report
 * never claims a Platform origin. Absent fields mean "not reported".
 */
export const AppSetupToolProvenanceSchema = z.object({
  policyOrigin: z.object({
    enabled: LocalPolicyOriginSchema,
    requiresApproval: LocalPolicyOriginSchema,
    riskClass: LocalPolicyOriginSchema,
    allowedRoles: LocalPolicyOriginSchema,
    description: LocalPolicyOriginSchema,
  }).partial().strict().optional(),
  contractSource: z.enum([
    'native',
    'contract-module',
    'legacy-ai-tool',
    'resolution',
    'openapi',
    'derived',
    'ui-bridge',
  ]).optional(),
  descriptionSource: z.enum(['human', 'code', 'agent', 'template']).optional(),
  schemaSource: z.enum(['zod', 'openapi', 'json-schema', 'agent', 'field-names', 'none'])
    .optional(),
}).strict();

/** The Platform's strict caps on reported exclusions (P08b Task 9). */
export const APP_SETUP_EXCLUSION_LIMITS = Object.freeze({
  maxEntries: 5_000,
  maxStableKeyLength: 512,
});

/** A route or page the code deliberately does not expose as a tool. */
export const AppSetupExclusionSchema = z.object({
  stableKey: z.string().trim().min(1).max(APP_SETUP_EXCLUSION_LIMITS.maxStableKeyLength),
  origin: z.enum(['default', 'policy', 'code']),
}).strict();

export const AppSetupToolCandidateSchema = z.object({
  toolId: uuid,
  sourceFingerprint: digest,
```

2. In `src/contracts/app-setup.ts`, replace:

```ts
  requiresApproval: z.boolean(),
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
}).strict();

const AppSetupPlannerMetadataSchema = z.object({
```

with:

```ts
  requiresApproval: z.boolean(),
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
  provenance: AppSetupToolProvenanceSchema.optional(),
}).strict();

const AppSetupPlannerMetadataSchema = z.object({
```

3. In `src/contracts/app-setup.ts`, replace:

```ts
  planner: AppSetupPlannerMetadataSchema,
  prompts: AppSetupPromptMetadataSchema,
  warnings: z.array(AppSetupWarningSchema).default([]),
  generatedAt: timestamp,
}).strict().superRefine((artifact, context) => {
  const toolIds = new Set(artifact.tools.map((tool) => tool.toolId));
```

with:

```ts
  planner: AppSetupPlannerMetadataSchema,
  prompts: AppSetupPromptMetadataSchema,
  warnings: z.array(AppSetupWarningSchema).default([]),
  exclusions: z.array(AppSetupExclusionSchema)
    .max(APP_SETUP_EXCLUSION_LIMITS.maxEntries)
    .optional(),
  generatedAt: timestamp,
}).strict().superRefine((artifact, context) => {
  const toolIds = new Set(artifact.tools.map((tool) => tool.toolId));
```

4. In `src/contracts/app-setup.ts`, replace:

```ts
  typeof AppSetupToolCandidateSchema
>;
export type AppSetupArtifact = z.infer<typeof AppSetupArtifactSchema>;

/**
 * Strong gate used by CLI validate/setup and standalone consumers. The base
```

with:

```ts
  typeof AppSetupToolCandidateSchema
>;
export type AppSetupArtifact = z.infer<typeof AppSetupArtifactSchema>;
export type AppSetupToolProvenance = z.infer<typeof AppSetupToolProvenanceSchema>;
export type AppSetupExclusion = z.infer<typeof AppSetupExclusionSchema>;

/**
 * Strong gate used by CLI validate/setup and standalone consumers. The base
```

1. In `src/contracts/index.ts`, replace:

```ts
export type { TechnicalRuntimeEvent } from './events.js';

export {
  AppSetupArtifactSchema,
  AppSetupAssessmentModeSchema,
  AppSetupOperationGroupSchema,
  AppSetupStatusSchema,
  AppSetupToolCandidateSchema,
  assertAppSetupSemanticParity,
} from './app-setup.js';

```

with:

```ts
export type { TechnicalRuntimeEvent } from './events.js';

export {
  APP_SETUP_EXCLUSION_LIMITS,
  AppSetupArtifactSchema,
  AppSetupAssessmentModeSchema,
  AppSetupExclusionSchema,
  AppSetupOperationGroupSchema,
  AppSetupStatusSchema,
  AppSetupToolCandidateSchema,
  AppSetupToolProvenanceSchema,
  assertAppSetupSemanticParity,
} from './app-setup.js';

```

2. In `src/contracts/index.ts`, replace:

```ts
export type {
  AppSetupArtifact,
  AppSetupAssessmentMode,
  AppSetupOperationGroup,
  AppSetupStatus,
  AppSetupToolCandidate,
} from './app-setup.js';

export {
```

with:

```ts
export type {
  AppSetupArtifact,
  AppSetupAssessmentMode,
  AppSetupExclusion,
  AppSetupOperationGroup,
  AppSetupStatus,
  AppSetupToolCandidate,
  AppSetupToolProvenance,
} from './app-setup.js';

export {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/app-setup-provenance.test.ts && bunx vitest run src/contracts && bun run typecheck`
Expected: PASS — the new file reports `Test Files  1 passed (1)`, `Tests  13 passed (13)`; the contract suites report `Test Files  19 passed (19)`, `Tests  368 passed (368)` (the P02 golden vectors included); typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/__tests__/app-setup-provenance.test.ts src/contracts/app-setup.ts src/contracts/index.ts
git commit -m "feat(contracts): describe tool provenance and exclusions in artifacts"
```

### Task 6: The generator reports provenance and clipped exclusions

**Files:**
- Modify: `src/codegen/tools/artifact.ts` (`clipExclusions`, provenance per candidate), `src/codegen/tools/pipeline.ts` (fills both on every refresh)
- Test: `src/codegen/tools/artifact.test.ts`, `src/codegen/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 5 schemas, P03 `schemaQualityOf`, `DescriptionOrigin`, `EffectiveToolPolicy.origin`, `ExcludedTool`.
- Produces:
  - `export function clipExclusions(excluded: ReadonlyArray<ExcludedTool>): AppSetupExclusion[]` — drops keys longer than 512 characters, de-duplicates, sorts in code-unit order, keeps the first 5,000. `tool-report.json` keeps the complete list.
  - `ArtifactToolInput.provenance?: AppSetupToolProvenance`; `BuildSetupArtifactInput.exclusions?: ReadonlyArray<ExcludedTool>`.
  - Every refresh writes `provenance` (`policyOrigin` of the local layers, `contractSource`, `descriptionSource`, `schemaSource`) and `exclusions` into `setup-artifact.json`, and so into the generated module's `setupArtifact` that the runner uploads (Task 7).

- [ ] **Step 1: Write the failing tests**

1. In `src/codegen/tools/artifact.test.ts`, replace:

```ts
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  buildSetupArtifact,
  EPOCH,
  promptMetadata,
  renderToolContracts,
```

with:

```ts
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  buildSetupArtifact,
  clipExclusions,
  EPOCH,
  promptMetadata,
  renderToolContracts,
```

2. In `src/codegen/tools/artifact.test.ts`, replace:

```ts
    expect(schemaQualityOf({ ...contract, source: 'resolution' }, 'human')).toBe('json-schema');
  });
});
```

with:

```ts
    expect(schemaQualityOf({ ...contract, source: 'resolution' }, 'human')).toBe('json-schema');
  });
});

describe('capability report fields', () => {
  it('clips exclusions to the Platform caps in a stable order', () => {
    const excluded = [
      { stableKey: `GET /${'x'.repeat(600)}`, reason: 'policy', origin: 'policy' as const },
      ...Array.from({ length: 5_001 }, (_, index) => ({
        stableKey: `GET /api/hidden/${String(index).padStart(4, '0')}`, reason: 'internal', origin: 'policy' as const,
      })),
      { stableKey: 'GET /api/hidden/0000', reason: 'duplicate', origin: 'default' as const },
    ];
    const clipped = clipExclusions(excluded);
    expect(clipped).toHaveLength(5_000);
    expect(clipped[0]).toEqual({ stableKey: 'GET /api/hidden/0000', origin: 'policy' });
    expect(clipped.at(-1)).toEqual({ stableKey: 'GET /api/hidden/4999', origin: 'policy' });
    expect(clipped.some((entry) => entry.stableKey.length > 512)).toBe(false);
  });

  it('carries provenance per tool and the reasoned exclusions', () => {
    const provenance = { descriptionSource: 'code' as const, schemaSource: 'zod' as const, contractSource: 'native' as const };
    const plain = buildSetupArtifact({ ...base, tools: [tool(TOOL_A, 'tasks.list')], now: null });
    const reported = buildSetupArtifact({
      ...base,
      tools: [{ ...tool(TOOL_A, 'tasks.list'), provenance }],
      exclusions: [{ stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' }],
      now: null,
    });
    expect(reported.artifact.tools[0]?.provenance).toEqual(provenance);
    expect(reported.artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
    expect(reported.artifact.artifactId).not.toBe(plain.artifact.artifactId);
    expect(plain.artifact).not.toHaveProperty('exclusions');
  });
});
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    await expect(fixture.read(TOOLS_PATHS.inventory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});
```

with:

```ts
    await expect(fixture.read(TOOLS_PATHS.inventory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});

describe('capability report in the committed setup artifact', () => {
  it('reports provenance per tool and every exclusion', async () => {
    const fixture = await app();
    await fixture.write('src/app/api/auth/login/route.ts', 'export async function POST() {\n  return Response.json({});\n}\n');
    await fixture.write('.glirastes/tool-policy.json', JSON.stringify({
      schemaVersion: 1,
      tools: { 'GET /api/tasks': { description: 'Lists your tasks by status.' } },
      exclude: [{ match: 'DELETE /api/**', reason: 'no deletes from chat' }],
      acceptedRisk: {},
    }));
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const artifact = await artifactOf(fixture);
    const byMethod = new Map(artifact.tools.map((tool) => [tool.method, tool] as const));
    expect(byMethod.get('GET')?.provenance).toEqual({
      policyOrigin: {
        enabled: 'code-default', requiresApproval: 'code-default', riskClass: 'code-default',
        allowedRoles: 'code-default', description: 'local-policy',
      },
      contractSource: 'derived',
      descriptionSource: 'human',
      schemaSource: 'field-names',
    });
    expect(byMethod.get('POST')?.provenance).toMatchObject({
      contractSource: 'native', descriptionSource: 'template', schemaSource: 'zod',
    });
    expect(artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/artifact.test.ts src/codegen/tools/pipeline.test.ts`
Expected: FAIL — `clipExclusions is not a function`, and the artifact has neither `provenance` nor `exclusions`. `Test Files  2 failed (2)`, `Tests  3 failed | 22 passed (25)`

- [ ] **Step 3: Build provenance and exclusions into the artifact**

1. In `src/codegen/tools/artifact.ts`, replace:

```ts
import { z } from 'zod';
import {
  AppSetupArtifactSchema,
  ToolRiskClassSchema,
  type AppSetupArtifact,
  type AppSetupOperationGroup,
  type AppSetupToolCandidate,
  type ToolRiskClass,
} from '../../contracts/index.js';
import { confirmationFloor, type EffectiveToolPolicy } from '../../contracts/tool-policy.js';
```

with:

```ts
import { z } from 'zod';
import {
  APP_SETUP_EXCLUSION_LIMITS,
  AppSetupArtifactSchema,
  ToolRiskClassSchema,
  type AppSetupArtifact,
  type AppSetupExclusion,
  type AppSetupOperationGroup,
  type AppSetupToolCandidate,
  type AppSetupToolProvenance,
  type ToolRiskClass,
} from '../../contracts/index.js';
import { confirmationFloor, type EffectiveToolPolicy } from '../../contracts/tool-policy.js';
```

2. In `src/codegen/tools/artifact.ts`, replace:

```ts
  prose: ToolProse;
  effective: EffectiveToolPolicy;
  operationGroup: AppSetupOperationGroup;
}

export interface PreviousArtifact {
```

with:

```ts
  prose: ToolProse;
  effective: EffectiveToolPolicy;
  operationGroup: AppSetupOperationGroup;
  /** Content-free capability-report provenance (P08b shared contract item 5). */
  provenance?: AppSetupToolProvenance;
}

export interface PreviousArtifact {
```

3. In `src/codegen/tools/artifact.ts`, replace:

```ts
  warnings: ReadonlyArray<{ code: string; subjectRef: string }>;
  previous?: PreviousArtifact;
  now: (() => Date) | null;
}

export function promptMetadata(
```

with:

```ts
  warnings: ReadonlyArray<{ code: string; subjectRef: string }>;
  previous?: PreviousArtifact;
  now: (() => Date) | null;
  /** Reported as the artifact's `exclusions`, clipped to the Platform caps. */
  exclusions?: ReadonlyArray<ExcludedTool>;
}

/**
 * The Platform accepts at most 5,000 exclusions with stable keys of at most
 * 512 characters (P08b Task 9). One oversized entry would reject the whole
 * capability report, so longer keys are left out and the list is cut in
 * code-unit order. `tool-report.json` keeps the complete list.
 */
export function clipExclusions(excluded: ReadonlyArray<ExcludedTool>): AppSetupExclusion[] {
  const byKey = new Map<string, AppSetupExclusion>();
  for (const entry of excluded) {
    if (entry.stableKey.length > APP_SETUP_EXCLUSION_LIMITS.maxStableKeyLength) continue;
    if (!byKey.has(entry.stableKey)) byKey.set(entry.stableKey, { stableKey: entry.stableKey, origin: entry.origin });
  }
  return [...byKey.values()]
    .sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey))
    .slice(0, APP_SETUP_EXCLUSION_LIMITS.maxEntries);
}

export function promptMetadata(
```

4. In `src/codegen/tools/artifact.ts`, replace:

```ts
    requiresApproval: confirmationFloor(effective.riskClass, effective.requiresApproval),
    inputSchemaDigest: execution.inputSchemaDigest,
    outputSchemaDigest: execution.outputSchemaDigest,
  };
  if (execution.executionKind === 'endpoint') {
    return {
```

with:

```ts
    requiresApproval: confirmationFloor(effective.riskClass, effective.requiresApproval),
    inputSchemaDigest: execution.inputSchemaDigest,
    outputSchemaDigest: execution.outputSchemaDigest,
    ...(tool.provenance ? { provenance: tool.provenance } : {}),
  };
  if (execution.executionKind === 'endpoint') {
    return {
```

5. In `src/codegen/tools/artifact.ts`, replace:

```ts
    },
    prompts: promptMetadata(input.promptBundle),
    warnings,
    generatedAt: EPOCH,
  });
  const contentDigest = contentDigestOf(withoutIdentity(draft));
```

with:

```ts
    },
    prompts: promptMetadata(input.promptBundle),
    warnings,
    ...(input.exclusions ? { exclusions: clipExclusions(input.exclusions) } : {}),
    generatedAt: EPOCH,
  });
  const contentDigest = contentDigestOf(withoutIdentity(draft));
```

- [ ] **Step 4: Fill them in the pipeline**

1. In `src/codegen/tools/pipeline.ts`, replace:

```ts
  deriveToolPolicyDefaults,
  resolveToolPolicy,
  riskTier,
} from '../../contracts/tool-policy.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  discoverFoundationExecutions,
```

with:

```ts
  deriveToolPolicyDefaults,
  resolveToolPolicy,
  riskTier,
  type EffectiveToolPolicy,
} from '../../contracts/tool-policy.js';
import type { AppSetupToolProvenance } from '../../contracts/index.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  discoverFoundationExecutions,
```

2. In `src/codegen/tools/pipeline.ts`, replace:

```ts
  return [...excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
}

function policyWarningMessage(code: string, field: string | undefined): string {
  switch (code) {
    case 'override-lapsed-risk-raised':
```

with:

```ts
  return [...excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
}

type PolicyField = keyof EffectiveToolPolicy['origin'];
const POLICY_FIELDS: ReadonlyArray<PolicyField> = ['enabled', 'requiresApproval', 'riskClass', 'allowedRoles', 'description'];

/** A local report knows code defaults and local policy only, never a Platform origin. */
function localPolicyOrigin(origin: EffectiveToolPolicy['origin']): NonNullable<AppSetupToolProvenance['policyOrigin']> {
  const local: NonNullable<AppSetupToolProvenance['policyOrigin']> = {};
  for (const field of POLICY_FIELDS) {
    const value = origin[field];
    if (value === 'code-default' || value === 'local-policy') local[field] = value;
  }
  return local;
}

function policyWarningMessage(code: string, field: string | undefined): string {
  switch (code) {
    case 'override-lapsed-risk-raised':
```

3. In `src/codegen/tools/pipeline.ts`, replace:

```ts
        : {}),
    });
    findings.push(...prose.findings);
    artifactTools.push({
      execution,
      prose,
      effective: resolved.effective,
      operationGroup: needsAttention ? 'needs_attention' : defaults.operationGroup,
    });
    contractEntries.push({
      toolId: execution.toolId,
```

with:

```ts
        : {}),
    });
    findings.push(...prose.findings);
    const schemaQuality = schemaQualityOf(tool.contract, resolutionOrigin(inputs.resolutions, execution.stableKey));
    artifactTools.push({
      execution,
      prose,
      effective: resolved.effective,
      operationGroup: needsAttention ? 'needs_attention' : defaults.operationGroup,
      provenance: {
        policyOrigin: localPolicyOrigin(resolved.effective.origin),
        ...(tool.contract ? { contractSource: tool.contract.source } : {}),
        descriptionSource: prose.descriptionOrigin,
        schemaSource: schemaQuality,
      },
    });
    contractEntries.push({
      toolId: execution.toolId,
```

4. In `src/codegen/tools/pipeline.ts`, replace:

```ts
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
        schema: schemaQualityOf(tool.contract, resolutionOrigin(inputs.resolutions, execution.stableKey)),
      },
    });
  }
```

with:

```ts
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
        schema: schemaQuality,
      },
    });
  }
```

5. In `src/codegen/tools/pipeline.ts`, replace:

```ts
      .map((finding) => ({ code: finding.code, subjectRef: toolIdByKey.get(finding.subjectRef)! })),
    ...(previous.artifact ? { previous: previous.artifact } : {}),
    now: options.mode === 'write' ? dependencies.now ?? (() => new Date()) : null,
  });
  assertAppSetupSemanticParity(built.artifact, inventory.executions.map((execution) => execution.definitionId));
  const inventoryRaw = renderInventory(generation.state);
```

with:

```ts
      .map((finding) => ({ code: finding.code, subjectRef: toolIdByKey.get(finding.subjectRef)! })),
    ...(previous.artifact ? { previous: previous.artifact } : {}),
    now: options.mode === 'write' ? dependencies.now ?? (() => new Date()) : null,
    exclusions: excluded,
  });
  assertAppSetupSemanticParity(built.artifact, inventory.executions.map((execution) => execution.definitionId));
  const inventoryRaw = renderInventory(generation.state);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/artifact.test.ts src/codegen/tools/pipeline.test.ts && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  25 passed (25)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/artifact.test.ts src/codegen/tools/artifact.ts src/codegen/tools/pipeline.test.ts \
  src/codegen/tools/pipeline.ts
git commit -m "feat(codegen): report tool provenance and clipped exclusions"
```

### Task 7: Register the code version and upload the capability report

**Files:**
- Create: `src/sync/capability-report.ts`
- Modify: `src/sync/control-plane-client.ts` (option `discoveryDigest`), `src/sync/managed-sync.ts` (option `setupArtifact`, `reportCapabilities()`), `src/sync/index.ts`
- Test: `src/sync/__tests__/capability-report.test.ts` (Create)

**Interfaces:**
- Consumes: `AppSetupClient.createRun`/`uploadArtifact` (unchanged; the Platform opened them to app-bound runtime keys in P08a Task 16), P08b shared contract items 5–6.
- Produces:
  - `export const DISCOVERY_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/`
  - `export interface CapabilityReport { artifact: AppSetupArtifact; discoveryDigest: string }`, `export interface CapabilityReportResult { discoveryDigest: string; runId: string; uploaded: boolean }`
  - `export function capabilityReportFrom(setupArtifact: unknown): CapabilityReport` (strict parse; refuses a non-digest)
  - `export async function uploadCapabilityReport(options: { baseUrl: string; apiKey: string; appId: string; report: CapabilityReport; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<CapabilityReportResult>` — creates the content-addressed run and uploads only when the Platform does not already hold its artifact.
  - `RuntimeControlPlaneClient` option `discoveryDigest?: string` (validated at construction); every `register()` sends it as `capabilities.discoveryDigest`, a different caller value is refused.
  - `createManagedRuntimeSync({ …, setupArtifact?: unknown })` returns `reportCapabilities(): Promise<CapabilityReportResult | undefined>` — once per process, retried after a failure, `undefined` without an artifact; an artifact of another app is refused at construction.

P11 wires it: after `runtime.client.register(…)` call `runtime.reportCapabilities()` with the generated module's `setupArtifact` and send errors to `onError`; the report must never block a chat turn.

- [ ] **Step 1: Write the failing tests**

Create `src/sync/__tests__/capability-report.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  capabilityReportFrom,
  uploadCapabilityReport,
} from '../capability-report.js';
import { RuntimeControlPlaneClient } from '../control-plane-client.js';
import { createManagedRuntimeSync } from '../managed-sync.js';
import { RuntimeSyncManager } from '../sync-manager.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1f${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const APP_ID = id('3');
const ENVIRONMENT_ID = id('9');
const DISCOVERY_DIGEST = digest('A');

const artifact = {
  schemaVersion: 1,
  artifactId: id('1'),
  runId: id('2'),
  appId: APP_ID,
  discoveryDigest: DISCOVERY_DIGEST,
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [{
    toolId: id('5'),
    sourceFingerprint: digest('F'),
    name: 'tasks.list',
    executionKind: 'endpoint',
    method: 'GET',
    path: '/api/tasks',
    operationGroup: 'read',
    riskClass: 'safe-read',
    enabled: true,
    requiresApproval: false,
    inputSchemaDigest: digest('I'),
    outputSchemaDigest: digest('O'),
    provenance: { descriptionSource: 'template', schemaSource: 'field-names', contractSource: 'derived' },
  }],
  planner: {
    plannerId: id('4'),
    modelBindingRef: 'default',
    promptBindingRef: 'prompt:fixture',
    budgetProfileRef: 'default',
    toolIds: [id('5')],
  },
  prompts: {
    bundleDigest: digest('B'),
    artifactRef: 'local://fixture/prompts',
    plannerDigest: digest('C'),
    appBehaviorDigest: digest('D'),
    responseStyleDigest: digest('E'),
    capabilityFragmentDigests: {},
  },
  warnings: [],
  exclusions: [{ stableKey: 'POST /api/auth/login', origin: 'default' }],
  generatedAt: '2026-10-05T08:00:00.000Z',
};

const run = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  runId: artifact.runId,
  appId: APP_ID,
  status: 'discovering',
  updatedAt: '2026-10-05T08:00:00.000Z',
  ...extra,
}));

function requests(fetchImpl: ReturnType<typeof vi.fn>): Array<{ method: string; url: string; body: unknown }> {
  return fetchImpl.mock.calls.map(([url, init]) => ({
    method: String((init as RequestInit).method),
    url: String(url),
    body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)),
  }));
}

describe('runner registration with the code version', () => {
  it('sends the discovery digest of the running code next to the other capabilities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runnerId: id('7') })));
    const client = new RuntimeControlPlaneClient({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      discoveryDigest: DISCOVERY_DIGEST,
      manager: {} as RuntimeSyncManager,
      fetchImpl,
    });

    await client.register({ capabilities: { engine: 'vercel-ai-sdk', localBindingCount: 1 } });

    expect(requests(fetchImpl)[0]).toMatchObject({
      method: 'POST',
      url: `https://control.example/v1/runtime/apps/${APP_ID}/environments/${ENVIRONMENT_ID}/runners/register`,
      body: {
        runnerKey: 'runner-a',
        capabilities: { engine: 'vercel-ai-sdk', localBindingCount: 1, discoveryDigest: DISCOVERY_DIGEST },
      },
    });
    await expect(client.register({ capabilities: { discoveryDigest: digest('Z') } }))
      .rejects.toThrow(/discoveryDigest/);
  });

  it('refuses a code version that is not a sha256 digest', () => {
    expect(() => new RuntimeControlPlaneClient({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      discoveryDigest: 'tasks: list, create',
      manager: {} as RuntimeSyncManager,
    })).toThrow(/discoveryDigest/);
  });
});

describe('capability report upload', () => {
  it('reads the committed setup artifact as the report, including provenance and exclusions', () => {
    const report = capabilityReportFrom(artifact);
    expect(report.discoveryDigest).toBe(DISCOVERY_DIGEST);
    expect(report.artifact.tools[0]?.provenance?.schemaSource).toBe('field-names');
    expect(report.artifact.exclusions).toEqual(artifact.exclusions);
    expect(() => capabilityReportFrom({ ...artifact, tools: [{ ...artifact.tools[0], prompt: 'x' }] })).toThrow();
  });

  it('uploads the artifact once per code version through the setup transport', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run({ status: 'ready', artifactDigest: digest('R') }));
    const result = await uploadCapabilityReport({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      report: capabilityReportFrom(artifact),
      fetchImpl,
    });

    expect(result).toEqual({ discoveryDigest: DISCOVERY_DIGEST, runId: artifact.runId, uploaded: true });
    expect(requests(fetchImpl)).toEqual([
      {
        method: 'POST',
        url: `https://control.example/v2/apps/${APP_ID}/runtime-setup/runs`,
        body: { runId: artifact.runId, assessmentMode: 'autonomous', discoveryDigest: DISCOVERY_DIGEST },
      },
      {
        method: 'PUT',
        url: `https://control.example/v2/apps/${APP_ID}/runtime-setup/runs/${artifact.runId}/artifact`,
        body: artifact,
      },
    ]);
  });

  it('skips the upload when the Platform already holds the artifact of this run', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(run({ status: 'ready', artifactDigest: digest('R') }));
    await expect(uploadCapabilityReport({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      report: capabilityReportFrom(artifact),
      fetchImpl,
    })).resolves.toEqual({ discoveryDigest: DISCOVERY_DIGEST, runId: artifact.runId, uploaded: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('wires the report into the managed sync: digest at registration, upload once per process', async () => {
    const fetchImpl = vi.fn(async (url: string) => (
      url.endsWith('/register') ? new Response(JSON.stringify({ runnerId: id('7') })) : run()
    ));
    const runtime = createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      setupArtifact: artifact,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      push: false,
    });

    await runtime.client.register();
    await runtime.reportCapabilities();
    await runtime.reportCapabilities();

    expect(requests(fetchImpl).map((request) => `${request.method} ${request.url.split('/').slice(-1)[0]}`))
      .toEqual(['POST register', 'POST runs', 'PUT artifact']);
    expect(requests(fetchImpl)[0]?.body).toMatchObject({ capabilities: { discoveryDigest: DISCOVERY_DIGEST } });
  });

  it('refuses a setup artifact of another app before anything is sent', () => {
    expect(() => createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: id('8'),
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      setupArtifact: artifact,
      push: false,
    })).toThrow(/different app/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/sync/__tests__/capability-report.test.ts`
Expected: FAIL — `Cannot find module '../capability-report.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Create the capability report module**

Create `src/sync/capability-report.ts`:

```ts
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../contracts/app-setup.js';
import { AppSetupClient } from './app-setup-client.js';

/** `sha256:` plus 43 base64url characters, the form the Platform registers (P08b Task 9). */
export const DISCOVERY_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

/**
 * What a runner tells the Platform about the code it runs (spec 4.10.6): the
 * committed, content-free setup artifact of that code. It describes tools and
 * never enables any.
 */
export interface CapabilityReport {
  artifact: AppSetupArtifact;
  discoveryDigest: string;
}

export interface CapabilityReportResult {
  discoveryDigest: string;
  runId: string;
  /** false: the Platform already held the artifact of this run. */
  uploaded: boolean;
}

export function capabilityReportFrom(setupArtifact: unknown): CapabilityReport {
  const artifact = AppSetupArtifactSchema.parse(setupArtifact);
  if (!DISCOVERY_DIGEST_PATTERN.test(artifact.discoveryDigest)) {
    throw new Error('The setup artifact discoveryDigest is not a sha256 digest');
  }
  return { artifact, discoveryDigest: artifact.discoveryDigest };
}

/**
 * Uploads the report through the app setup transport with the runner's
 * app-bound runtime key. Run identities are content-derived, so a repeated
 * upload of the same artifact names the same run; once the Platform holds its
 * artifact, nothing more is sent.
 */
export async function uploadCapabilityReport(options: {
  baseUrl: string;
  apiKey: string;
  appId: string;
  report: CapabilityReport;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CapabilityReportResult> {
  const { artifact } = options.report;
  if (artifact.appId !== options.appId) {
    throw new Error('Capability report targets a different app');
  }
  const client = new AppSetupClient({
    baseUrl: options.baseUrl,
    setupApiKey: options.apiKey,
    appId: options.appId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const run = await client.createRun({
    runId: artifact.runId,
    assessmentMode: artifact.assessmentMode,
    discoveryDigest: artifact.discoveryDigest,
  }, options.signal);
  const result = { discoveryDigest: artifact.discoveryDigest, runId: artifact.runId };
  if (run.artifactDigest) return { ...result, uploaded: false };
  await client.uploadArtifact(artifact, options.signal);
  return { ...result, uploaded: true };
}
```

- [ ] **Step 4: Send the digest with every registration**

1. In `src/sync/control-plane-client.ts`, replace:

```ts
import { findForbiddenContentPath } from '../contracts/content-boundary.js';
import type { RuntimeSyncManager } from './sync-manager.js';

export interface RuntimePushConnector {
```

with:

```ts
import { findForbiddenContentPath } from '../contracts/content-boundary.js';
import { DISCOVERY_DIGEST_PATTERN } from './capability-report.js';
import type { RuntimeSyncManager } from './sync-manager.js';

export interface RuntimePushConnector {
```

2. In `src/sync/control-plane-client.ts`, replace:

```ts
    environmentId: string;
    runnerKey: string;
    version: string;
    manager: RuntimeSyncManager;
    fetchImpl?: typeof fetch;
    push?: RuntimePushConnector;
    pollIntervalMs?: number;
    onError?: (error: unknown) => void;
  }) {}

  async register(input: {
    capabilities?: Record<string, unknown>;
    technicalMetadata?: Record<string, unknown>;
  } = {}) {
    this.assertTechnicalMetadata(input.capabilities ?? {});
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    return this.request('register', {
      method: 'POST',
      body: JSON.stringify({
        runnerKey: this.options.runnerKey,
        version: this.options.version,
        capabilities: input.capabilities ?? {},
        technicalMetadata: input.technicalMetadata ?? {},
      }),
    });
```

with:

```ts
    environmentId: string;
    runnerKey: string;
    version: string;
    /**
     * Discovery digest of the running code. Sent with every registration so
     * the Platform knows which capability report describes this runner.
     */
    discoveryDigest?: string;
    manager: RuntimeSyncManager;
    fetchImpl?: typeof fetch;
    push?: RuntimePushConnector;
    pollIntervalMs?: number;
    onError?: (error: unknown) => void;
  }) {
    if (
      options.discoveryDigest !== undefined
      && !DISCOVERY_DIGEST_PATTERN.test(options.discoveryDigest)
    ) {
      throw new Error('discoveryDigest must be a sha256 digest of the running code');
    }
  }

  async register(input: {
    capabilities?: Record<string, unknown>;
    technicalMetadata?: Record<string, unknown>;
  } = {}) {
    const capabilities = { ...input.capabilities ?? {} };
    const digest = this.options.discoveryDigest;
    if (digest !== undefined) {
      if (
        capabilities.discoveryDigest !== undefined
        && capabilities.discoveryDigest !== digest
      ) {
        throw new Error('capabilities.discoveryDigest must name the running code');
      }
      capabilities.discoveryDigest = digest;
    }
    this.assertTechnicalMetadata(capabilities);
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    return this.request('register', {
      method: 'POST',
      body: JSON.stringify({
        runnerKey: this.options.runnerKey,
        version: this.options.version,
        capabilities,
        technicalMetadata: input.technicalMetadata ?? {},
      }),
    });
```

- [ ] **Step 5: Wire the report into the managed sync**

1. In `src/sync/managed-sync.ts`, replace:

```ts
import { FetchSsePushConnector } from './fetch-sse-push.js';
import { HttpRuntimePublicKeyProvider } from './jwks-provider.js';
import { RuntimeRevisionVerifier } from './signature-verifier.js';
```

with:

```ts
import {
  capabilityReportFrom,
  uploadCapabilityReport,
  type CapabilityReportResult,
} from './capability-report.js';
import { FetchSsePushConnector } from './fetch-sse-push.js';
import { HttpRuntimePublicKeyProvider } from './jwks-provider.js';
import { RuntimeRevisionVerifier } from './signature-verifier.js';
```

2. In `src/sync/managed-sync.ts`, replace:

```ts
    revisions: MaterializedDeploymentRevisions,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
}) {
  const store = options.stateStore
    ?? (options.stateFilePath
      ? new FileRuntimeStateStore(options.stateFilePath)
```

with:

```ts
    revisions: MaterializedDeploymentRevisions,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /**
   * The committed setup artifact of the running code, e.g. the generated
   * module's `setupArtifact`. Its discovery digest goes into every runner
   * registration, and `reportCapabilities()` uploads it as the capability
   * report (spec 4.10.6). Content-free; it never enables a tool.
   */
  setupArtifact?: unknown;
}) {
  const report = options.setupArtifact === undefined
    ? undefined
    : capabilityReportFrom(options.setupArtifact);
  if (report && report.artifact.appId !== options.appId) {
    throw new Error('The setup artifact belongs to a different app');
  }
  const store = options.stateStore
    ?? (options.stateFilePath
      ? new FileRuntimeStateStore(options.stateFilePath)
```

3. In `src/sync/managed-sync.ts`, replace:

```ts
    environmentId: options.environmentId,
    runnerKey: options.runnerKey,
    version: options.version,
    manager,
    fetchImpl: options.fetchImpl,
    push: options.push === false
```

with:

```ts
    environmentId: options.environmentId,
    runnerKey: options.runnerKey,
    version: options.version,
    ...(report ? { discoveryDigest: report.discoveryDigest } : {}),
    manager,
    fetchImpl: options.fetchImpl,
    push: options.push === false
```

4. In `src/sync/managed-sync.ts`, replace:

```ts
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });
  return { client, manager, store, verifier, keys };
}
```

with:

```ts
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });
  let reported: Promise<CapabilityReportResult> | undefined;
  /** Uploads the capability report once per process; undefined without one. */
  const reportCapabilities = async (): Promise<CapabilityReportResult | undefined> => {
    if (!report) return undefined;
    reported ??= uploadCapabilityReport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      appId: options.appId,
      report,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }).catch((error: unknown) => {
      reported = undefined;
      throw error;
    });
    return reported;
  };
  return { client, manager, store, verifier, keys, reportCapabilities };
}
```

In `src/sync/index.ts`, replace:

```ts
  LocalDeploymentValidation,
} from './local-deployment-validator.js';
export { createManagedRuntimeSync } from './managed-sync.js';
```

with:

```ts
  LocalDeploymentValidation,
} from './local-deployment-validator.js';
export { createManagedRuntimeSync } from './managed-sync.js';
export {
  capabilityReportFrom,
  DISCOVERY_DIGEST_PATTERN,
  uploadCapabilityReport,
} from './capability-report.js';
export type {
  CapabilityReport,
  CapabilityReportResult,
} from './capability-report.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/sync/__tests__/capability-report.test.ts && bunx vitest run src/sync && bun run typecheck`
Expected: PASS — the new file reports `Test Files  1 passed (1)`, `Tests  7 passed (7)`; the sync suites report `Test Files  14 passed (14)`, `Tests  68 passed (68)`; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/sync/__tests__/capability-report.test.ts src/sync/capability-report.ts src/sync/control-plane-client.ts \
  src/sync/index.ts src/sync/managed-sync.ts
git commit -m "feat(sync): register the code version and upload its capability report"
```


### Task 8: HEAD route exports become read tools

**Files:**
- Modify: `src/types.ts` (`EndpointMethod`), `src/codegen/route-exports.ts`, `src/codegen/route-scanner.ts`, `src/codegen/execution-inventory.ts`, `src/contracts/app-setup.ts`, `src/contracts/revisions.ts`, `src/codegen/tools/identity.ts`, `src/codegen/tools/contract-tiers.ts`, `src/codegen/tools/sources/next-endpoints.ts`, `src/server/core/index.ts`
- Test: `src/codegen/route-exports.test.ts`, `src/codegen/route-scanner.test.ts`, `src/codegen/tools/identity.test.ts`, `src/codegen/tools/sources/next-endpoints.test.ts`, `src/server/core/__tests__/head-endpoint-tool.test.ts` (Create)

**Interfaces:**
- Consumes: P02 `deriveToolPolicyDefaults` (already maps HEAD to `read`/`safe-read`/no confirmation), P03 `UNSUPPORTED_METHODS` exclusion.
- Produces:
  - `EndpointMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'`; the inventory, setup-artifact and manifest endpoint method enums accept `HEAD`.
  - `readRouteExports` reads HEAD exports; `scanNextAppRoutes` returns HEAD candidates only in `source-discovery` mode (the legacy scan upload to the Platform keeps its five-method contract).
  - `deriveDefinitionId({ method: 'HEAD', path })` → `<resource>.head`, item routes `<resource>.check`.
  - Contract tiers treat HEAD input as query (like GET); `endpointToolToTool` sends HEAD input as a query string, never a body, and asks no confirmation by default; `createFetchInternalApiCaller` never attaches a body to HEAD.
  - The `next-app` source reports only `OPTIONS` as `unsupported-method`.

- [ ] **Step 1: Write the failing tests**

In `src/codegen/route-exports.test.ts`, replace:

```ts
    });
  });

  it('reports namespace HTTP exports as unresolved', () => {
    expect(readRouteExports('export * as GET from "./handlers";')).toEqual({
      exports: [], findings: [{ exportName: 'GET', code: 'route-export-unresolved' }],
```

with:

```ts
    });
  });

  it('reads a HEAD export like every other route method', () => {
    expect(readRouteExports('export async function HEAD() { return new Response(null); }\nexport const OPTIONS = () => null;'))
      .toEqual({ exports: [{ method: 'HEAD', body: '{ return new Response(null); }' }], findings: [] });
  });

  it('reports namespace HTTP exports as unresolved', () => {
    expect(readRouteExports('export * as GET from "./handlers";')).toEqual({
      exports: [], findings: [{ exportName: 'GET', code: 'route-export-unresolved' }],
```

In `src/codegen/route-scanner.test.ts`, replace:

```ts
    });
  });

  it('does not discover commented, quoted or default exports', async () => {
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': `
      // export async function GET() {}
```

with:

```ts
    });
  });

  it('keeps HEAD out of the legacy route scan upload and reports it in source discovery', async () => {
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': `
      export async function GET() { await getSession(); return Response.json([]); }
      export async function HEAD() { await getSession(); return new Response(null); }
      export const { HEAD: other } = handlers;
    ` });
    expect((await scanNextAppRoutes({ rootDir })).candidates.map((candidate) => candidate.method)).toEqual(['GET']);
    const discovered = await scanNextAppRoutes({ rootDir, mode: 'source-discovery' });
    expect(discovered.candidates.map((candidate) => [candidate.method, candidate.riskClass])).toEqual([
      ['GET', 'unknown'], ['HEAD', 'unknown'],
    ]);
  });

  it('does not discover commented, quoted or default exports', async () => {
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': `
      // export async function GET() {}
```

In `src/codegen/tools/identity.test.ts`, replace:

```ts
    ['GET', '/api/tasks-by-date', 'tasksByDate.list'],
    ['POST', '/api/2fa/setup', 'api2faSetup.create'],
    ['GET', '/api', 'root.list'],
  ] as const)('derives %s %s as %s', (method, path, expected) => {
    expect(deriveDefinitionId({ method, path })).toBe(expected);
  });
```

with:

```ts
    ['GET', '/api/tasks-by-date', 'tasksByDate.list'],
    ['POST', '/api/2fa/setup', 'api2faSetup.create'],
    ['GET', '/api', 'root.list'],
    ['HEAD', '/api/tasks', 'tasks.head'],
    ['HEAD', '/api/tasks/:id', 'tasks.check'],
  ] as const)('derives %s %s as %s', (method, path, expected) => {
    expect(deriveDefinitionId({ method, path })).toBe(expected);
  });
```

1. In `src/codegen/tools/sources/next-endpoints.test.ts`, replace:

```ts
    expect(notes.prose?.contractDescription).toBe('Create a note for the caller');
  }, 60_000);

  it('reports HEAD and OPTIONS exports as unsupported-method exclusions instead of dropping them', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'declare function getSession(): Promise<unknown>;\n'
        + 'export async function GET() { await getSession(); return Response.json([]); }\n'
        + 'export async function HEAD() { return new Response(null); }\n'
        + 'async function preflight() { return new Response(null); }\n'
        + 'export { preflight as OPTIONS };\n',
      'src/app/api/tasks/[id]/route.ts': 'export const { HEAD } = { HEAD: async () => new Response(null) };\n',
```

with:

```ts
    expect(notes.prose?.contractDescription).toBe('Create a note for the caller');
  }, 60_000);

  it('enumerates HEAD as a read tool and reports only OPTIONS as unsupported', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'declare function getSession(): Promise<unknown>;\n'
        + 'export async function GET() { await getSession(); return Response.json([]); }\n'
        + 'export async function HEAD() { await getSession(); return new Response(null); }\n'
        + 'async function preflight() { return new Response(null); }\n'
        + 'export { preflight as OPTIONS };\n',
      'src/app/api/tasks/[id]/route.ts': 'export const { HEAD } = { HEAD: async () => new Response(null) };\n',
```

2. In `src/codegen/tools/sources/next-endpoints.test.ts`, replace:

```ts
    });
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    expect(observed.observations.map((tool) => tool.execution.stableKey)).toEqual(['GET /api/tasks']);
    expect(observed.excluded).toEqual([
      { stableKey: 'HEAD /api/tasks', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'HEAD /api/tasks/:id', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/auth/login', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/ping', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/tasks', reason: 'unsupported-method', origin: 'code' },
```

with:

```ts
    });
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    const tools = byKey(observed.observations);
    expect([...tools.keys()]).toEqual(['GET /api/tasks', 'HEAD /api/tasks', 'HEAD /api/tasks/:id']);
    expect(tools.get('HEAD /api/tasks')).toMatchObject({
      execution: { definitionId: 'tasks.head', method: 'HEAD', path: '/api/tasks' },
      contract: { source: 'derived' },
      findings: expect.arrayContaining([expect.objectContaining({ code: 'contract-derived' })]),
    });
    expect(tools.get('HEAD /api/tasks/:id')).toMatchObject({
      execution: { definitionId: 'tasks.check' },
      findings: [expect.objectContaining({ code: 'handler-unresolved' })],
    });
    expect(observed.excluded).toEqual([
      { stableKey: 'OPTIONS /api/auth/login', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/ping', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/tasks', reason: 'unsupported-method', origin: 'code' },
```

Create `src/server/core/__tests__/head-endpoint-tool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFetchInternalApiCaller, endpointToolToTool } from '../index.js';

describe('HEAD endpoint tools', () => {
  it('send their input as a query string, never a body, and run without confirmation by default', async () => {
    const callEndpoint = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const tool = endpointToolToTool({
      id: 'tasks.head',
      toolName: 'tasks_head',
      description: 'Check whether tasks exist.',
      method: 'HEAD',
      path: '/api/tasks/:id',
      inputSchema: z.object({ id: z.string(), status: z.string().optional() }),
    });
    expect(tool.needsApproval).toBe(false);
    await tool.execute({ id: '7', status: 'open' }, { callEndpoint } as never);
    expect(callEndpoint).toHaveBeenCalledWith({ method: 'HEAD', path: '/api/tasks/7?status=open', body: undefined });
  });

  it('never attaches a body to a HEAD request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const call = createFetchInternalApiCaller({ baseUrl: 'https://app.example', fetchImpl });
    await expect(call({ method: 'HEAD', path: '/api/tasks', body: { status: 'open' } }))
      .resolves.toEqual({ ok: true, status: 200, data: undefined });
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({ method: 'HEAD', headers: {} });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/route-exports.test.ts src/codegen/route-scanner.test.ts src/codegen/tools/identity.test.ts src/codegen/tools/sources/next-endpoints.test.ts src/server/core/__tests__/head-endpoint-tool.test.ts`
Expected: FAIL — HEAD is not read, derived names end in `undefined`, the endpoint source still excludes HEAD, and the fetch caller attaches a body. `Test Files  5 failed (5)`, `Tests  7 failed | 37 passed (44)`

- [ ] **Step 3: Add HEAD to the method type and the contract enums**

In `src/types.ts`, replace:

```ts
// HTTP & Transport
// ============================================================================

export type EndpointMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// ============================================================================
// Runtime & Context
```

with:

```ts
// HTTP & Transport
// ============================================================================

export type EndpointMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// ============================================================================
// Runtime & Context
```

In `src/codegen/execution-inventory.ts`, replace:

```ts
   */
  sourceKind: z.enum(['next-app']).optional(),
  sourceFile: z.string().trim().min(1).max(2_048),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
}).strict();

```

with:

```ts
   */
  sourceKind: z.enum(['next-app']).optional(),
  sourceFile: z.string().trim().min(1).max(2_048),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
}).strict();

```

In `src/contracts/app-setup.ts`, replace:

```ts
   * facts. Optional because a UI entry has no route and an endpoint has no
   * action binding.
   */
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  path: z.string().startsWith('/').max(2_048).optional(),
  authBindingRef: identifier.optional(),
  actionBindingRef: identifier.optional(),
```

with:

```ts
   * facts. Optional because a UI entry has no route and an endpoint has no
   * action binding.
   */
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  path: z.string().startsWith('/').max(2_048).optional(),
  authBindingRef: identifier.optional(),
  actionBindingRef: identifier.optional(),
```

In `src/contracts/revisions.ts`, replace:

```ts

const ManifestEndpointToolSchema = ManifestToolBaseSchema.extend({
  executionKind: z.literal('endpoint'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
  authBindingRef: identifier,
}).strict();
```

with:

```ts

const ManifestEndpointToolSchema = ManifestToolBaseSchema.extend({
  executionKind: z.literal('endpoint'),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
  authBindingRef: identifier,
}).strict();
```

- [ ] **Step 4: Read HEAD exports, keep the legacy scan at five methods**

In `src/codegen/route-exports.ts`, replace:

```ts
import ts from 'typescript';
import type { EndpointMethod } from '../types.js';

const methods = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface RouteExportFinding {
  code: 'route-export-unresolved' | 'route-wildcard-export-unresolved' | 'route-source-invalid';
```

with:

```ts
import ts from 'typescript';
import type { EndpointMethod } from '../types.js';

const methods = new Set<string>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface RouteExportFinding {
  code: 'route-export-unresolved' | 'route-wildcard-export-unresolved' | 'route-source-invalid';
```

1. In `src/codegen/route-scanner.ts`, replace:

```ts
  if (options.externalCallEvidence.length > 0) {
    reasons.push('external-call-detected');
  }
  if (options.method === 'GET') {
    reasons.push('data-classification-unverified');
  } else if (options.method === 'DELETE') {
    reasons.push('delete-operation');
```

with:

```ts
  if (options.externalCallEvidence.length > 0) {
    reasons.push('external-call-detected');
  }
  if (options.method === 'GET' || options.method === 'HEAD') {
    reasons.push('data-classification-unverified');
  } else if (options.method === 'DELETE') {
    reasons.push('delete-operation');
```

2. In `src/codegen/route-scanner.ts`, replace:

```ts
    const imports = importBindings(source);
    const route = toRoutePath(apiDir, routeFile);
    const parsed = readRouteExports(source, sourceFile);
    findings.push(...parsed.findings.map((finding) => ({ sourceFile, ...finding })));
    for (const { method, body } of parsed.exports) {
      const authEvidence = evidence(body, AUTH_PATTERNS);
      const externalCallEvidence = evidence(body, EXTERNAL_PATTERNS);
      candidates.push({
```

with:

```ts
    const imports = importBindings(source);
    const route = toRoutePath(apiDir, routeFile);
    const parsed = readRouteExports(source, sourceFile);
    // HEAD is a tool only for the tools generator (source discovery); the
    // legacy scan upload keeps its five-method contract with the Platform.
    const included = (method: EndpointMethod | undefined) => Boolean(strictSources) || method !== 'HEAD';
    findings.push(...parsed.findings
      .filter((finding) => included(finding.exportName))
      .map((finding) => ({ sourceFile, ...finding })));
    for (const { method, body } of parsed.exports.filter((entry) => included(entry.method))) {
      const authEvidence = evidence(body, AUTH_PATTERNS);
      const externalCallEvidence = evidence(body, EXTERNAL_PATTERNS);
      candidates.push({
```

3. In `src/codegen/route-scanner.ts`, replace:

```ts
        riskClass:
          method === 'DELETE'
            ? 'delete'
            : method === 'GET'
              ? 'unknown'
              : 'write',
        autoApprovalEligible: false,
```

with:

```ts
        riskClass:
          method === 'DELETE'
            ? 'delete'
            : method === 'GET' || method === 'HEAD'
              ? 'unknown'
              : 'write',
        autoApprovalEligible: false,
```

- [ ] **Step 5: Name, type and enumerate HEAD tools**

1. In `src/codegen/tools/identity.ts`, replace:

```ts

const OPERATIONS: Readonly<Record<EndpointMethod, string>> = {
  GET: 'list',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
```

with:

```ts

const OPERATIONS: Readonly<Record<EndpointMethod, string>> = {
  GET: 'list',
  HEAD: 'head',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
```

2. In `src/codegen/tools/identity.ts`, replace:

```ts
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** `<resource>.list|get|create|update|delete` from method and path. */
export function deriveDefinitionId(input: { method: EndpointMethod; path: string }): string {
  const segments = input.path.split('/').filter(Boolean);
  const rest = segments[0] === 'api' ? segments.slice(1) : segments;
```

with:

```ts
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** `<resource>.list|get|head|check|create|update|delete` from method and path. */
export function deriveDefinitionId(input: { method: EndpointMethod; path: string }): string {
  const segments = input.path.split('/').filter(Boolean);
  const rest = segments[0] === 'api' ? segments.slice(1) : segments;
```

3. In `src/codegen/tools/identity.ts`, replace:

```ts
    resource = `api${resource.charAt(0).toUpperCase()}${resource.slice(1)}`;
  }
  const last = rest[rest.length - 1];
  const operation = input.method === 'GET' && last?.startsWith(':') ? 'get' : OPERATIONS[input.method];
  return `${resource}.${operation}`;
}

```

with:

```ts
    resource = `api${resource.charAt(0).toUpperCase()}${resource.slice(1)}`;
  }
  const last = rest[rest.length - 1];
  const item = last?.startsWith(':') === true;
  const operation = item && input.method === 'GET' ? 'get'
    : item && input.method === 'HEAD' ? 'check'
      : OPERATIONS[input.method];
  return `${resource}.${operation}`;
}

```

In `src/codegen/tools/contract-tiers.ts`, replace:

```ts

export const OPAQUE_SCHEMA_DIGEST = jsonSchemaDigest(OPAQUE_JSON_SCHEMA);

const READ_METHODS: ReadonlySet<EndpointMethod> = new Set(['GET', 'DELETE']);
const EFFECT_STRENGTH: Readonly<Record<DeclaredEffect, number>> = {
  read: 0, write: 1, destructive: 2, external: 2, financial: 2,
};
```

with:

```ts

export const OPAQUE_SCHEMA_DIGEST = jsonSchemaDigest(OPAQUE_JSON_SCHEMA);

const READ_METHODS: ReadonlySet<EndpointMethod> = new Set(['GET', 'HEAD', 'DELETE']);
const EFFECT_STRENGTH: Readonly<Record<DeclaredEffect, number>> = {
  read: 0, write: 1, destructive: 2, external: 2, financial: 2,
};
```

1. In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
export const NEXT_DEFAULT_API_DIR = 'src/app/api';
const CONTRACT_FILE_NAMES = ['contract.ts', 'contract.tsx', 'contract.js', 'contract.mjs'];
/** Route exports Next.js serves that the generator does not turn into tools. */
const UNSUPPORTED_METHODS: ReadonlySet<string> = new Set(['HEAD', 'OPTIONS']);
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx)$/;

interface RouteEntry {
```

with:

```ts
export const NEXT_DEFAULT_API_DIR = 'src/app/api';
const CONTRACT_FILE_NAMES = ['contract.ts', 'contract.tsx', 'contract.js', 'contract.mjs'];
/** Route exports Next.js serves that the generator does not turn into tools. */
const UNSUPPORTED_METHODS: ReadonlySet<string> = new Set(['OPTIONS']);
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx)$/;

interface RouteEntry {
```

2. In `src/codegen/tools/sources/next-endpoints.ts`, replace:

```ts
    });
  }

  // The route reader drops HEAD and OPTIONS without a trace, and a route file
  // that exports only those yields no candidate at all: look at every route file.
  const unsupported = new Map<string, ExcludedTool>();
  const apiRoot = resolve(root, apiDir);
  for (const absoluteFile of (await listRouteFiles(apiRoot)).sort(compareCodeUnits)) {
```

with:

```ts
    });
  }

  // The route reader drops OPTIONS without a trace, and a route file that
  // exports only OPTIONS yields no candidate at all: look at every route file.
  const unsupported = new Map<string, ExcludedTool>();
  const apiRoot = resolve(root, apiDir);
  for (const absoluteFile of (await listRouteFiles(apiRoot)).sort(compareCodeUnits)) {
```

- [ ] **Step 6: Run HEAD as a query-only call**

1. In `src/server/core/index.ts`, replace:

```ts
    method: endpointTool.method,
    needsApproval:
      endpointTool.needsApproval ??
      (endpointTool.method === 'GET' ? false : true),
    execute: async (
      rawInput: InferSchema<TInput>,
      context: ToolContext,
```

with:

```ts
    method: endpointTool.method,
    needsApproval:
      endpointTool.needsApproval ??
      (endpointTool.method === 'GET' || endpointTool.method === 'HEAD' ? false : true),
    execute: async (
      rawInput: InferSchema<TInput>,
      context: ToolContext,
```

2. In `src/server/core/index.ts`, replace:

```ts
        inputPayload,
      );

      const requestPath =
        endpointTool.method === 'GET' || endpointTool.method === 'DELETE'
          ? `${endpointPath}${buildQueryString(requestPayload)}`
          : endpointPath;

      const requestBody =
        endpointTool.method === 'GET' || endpointTool.method === 'DELETE'
          ? undefined
          : Object.keys(requestPayload).length > 0
            ? requestPayload
```

with:

```ts
        inputPayload,
      );

      const queryOnly = endpointTool.method === 'GET'
        || endpointTool.method === 'HEAD'
        || endpointTool.method === 'DELETE';
      const requestPath = queryOnly
        ? `${endpointPath}${buildQueryString(requestPayload)}`
        : endpointPath;

      const requestBody =
        queryOnly
          ? undefined
          : Object.keys(requestPayload).length > 0
            ? requestPayload
```

3. In `src/server/core/index.ts`, replace:

```ts

  return async (request) => {
    const url = new URL(request.path, options.baseUrl).toString();
    const methodAllowsBody =
      request.method !== 'GET' && request.method !== 'DELETE';

    const headers: Record<string, string> = {
      ...(options.defaultHeaders ?? {}),
```

with:

```ts

  return async (request) => {
    const url = new URL(request.path, options.baseUrl).toString();
    const methodAllowsBody = request.method !== 'GET'
      && request.method !== 'HEAD'
      && request.method !== 'DELETE';

    const headers: Record<string, string> = {
      ...(options.defaultHeaders ?? {}),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/route-exports.test.ts src/codegen/route-scanner.test.ts src/codegen/tools/identity.test.ts src/codegen/tools/sources/next-endpoints.test.ts src/server/core/__tests__/head-endpoint-tool.test.ts && bun run typecheck`
Expected: PASS — `Test Files  5 passed (5)`, `Tests  44 passed (44)`; typecheck clean (the `Record<EndpointMethod, string>` in `identity.ts` forces the new key).

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/execution-inventory.ts src/codegen/route-exports.test.ts src/codegen/route-exports.ts \
  src/codegen/route-scanner.test.ts src/codegen/route-scanner.ts src/codegen/tools/contract-tiers.ts \
  src/codegen/tools/identity.test.ts src/codegen/tools/identity.ts \
  src/codegen/tools/sources/next-endpoints.test.ts src/codegen/tools/sources/next-endpoints.ts \
  src/contracts/app-setup.ts src/contracts/revisions.ts src/server/core/__tests__/head-endpoint-tool.test.ts \
  src/server/core/index.ts src/types.ts
git commit -m "feat(codegen): enumerate head route exports as read tools"
```

### Task 9: `glirastes/browser` — a framework-neutral UI action and navigation bridge

**Files:**
- Create: `src/browser/ui-action-bus.ts`, `src/browser/navigation.ts`, `src/browser/client-actions.ts`, `src/browser/query-filters.ts`, `src/browser/index.ts`
- Modify: `package.json` (`./browser` export and `files` entry), `scripts/generate-subpath-shims.mjs`, `.gitignore` (the generated `/browser/` shim), `CLAUDE.md` (subpath list), `src/react/ui.ts` (re-exports the bus instead of defining it)
- Test: `src/browser/__tests__/browser.test.ts` (Create), `src/public-subpaths.test.ts`

**Interfaces:**
- Consumes: the `UiActionBus` class of `src/react/ui.ts` (moved verbatim).
- Produces (`glirastes/browser`, React-free, no relative import outside `src/browser`):
  - `export class UiActionBus` (unchanged API), `export interface UiAction`, `export type UiActionHandler`, `export function getDefaultUiActionBus(): UiActionBus` — one page-wide bus on `globalThis[Symbol.for('glirastes.uiActionBus')]`, shape-checked so two bundled SDK copies share it.
  - `export const GLIRASTES_NAVIGATE_ACTION_ID = 'glirastes.navigate'`, `export type QueryValue`, `export function isSafeAppHref(href: unknown): href is string`, `export function buildNavigationHref(input: { destination: string; params?: Readonly<Record<string, string>>; query?: Readonly<Record<string, QueryValue>>; arrayFormats?: Readonly<Record<string, 'comma' | 'repeat'>> }): string`, `export interface NavigationBridgeOptions { push(href: string): unknown; bus?: UiActionBus }`, `export function registerNavigationBridge(options): () => void`.
  - `export interface PayloadContract<T> { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: unknown } }`, `export interface ClientActionOptions { bus?: UiActionBus }`, `export function registerAiClientAction<T>(actionId, handler, contract?, options?): () => void`, `export async function dispatchToolResultUiActions(result: unknown, bus?: UiActionBus): Promise<number>` (dispatches only `glirastes.*` actions of successful results).
  - `export function defineQueryFilters<const F>(definition: { path: string; filters: F }): QueryFiltersDefinition<F>` with `read(search)` and `href(values, params?)`; specs `'string' | 'integer' | 'number' | 'boolean' | [values…] | { arrayOf, format?: 'comma' | 'repeat' }`; types `QueryFilterScalar`, `QueryFilterSpec`, `QueryFiltersDefinition`, `QueryFilterValues`.
  - `glirastes/react` keeps exporting `UiActionBus`, `UiAction`, `UiActionHandler` (now re-exported) and adds `getDefaultUiActionBus`.

- [ ] **Step 1: Write the failing tests**

Create `src/browser/__tests__/browser.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildNavigationHref,
  defineQueryFilters,
  dispatchToolResultUiActions,
  getDefaultUiActionBus,
  GLIRASTES_NAVIGATE_ACTION_ID,
  isSafeAppHref,
  registerAiClientAction,
  registerNavigationBridge,
  UiActionBus,
} from '../index.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('UiActionBus', () => {
  it('dispatches by type and by id and stops after unsubscribe', async () => {
    const bus = new UiActionBus();
    const byType = vi.fn();
    const byId = vi.fn();
    bus.subscribeByType('glirastes.action', byType);
    const off = bus.subscribeById('tasks.highlight', byId);
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } });
    off();
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight' });
    expect(byType).toHaveBeenCalledTimes(2);
    expect(byId).toHaveBeenCalledTimes(1);
  });

  it('shares one default bus per page, even across duplicated module copies', () => {
    expect(getDefaultUiActionBus()).toBe(getDefaultUiActionBus());
    const key = Symbol.for('glirastes.uiActionBus');
    expect((globalThis as Record<symbol, unknown>)[key]).toBe(getDefaultUiActionBus());
  });

  it('keeps the bus another SDK copy registered instead of replacing it', () => {
    const key = Symbol.for('glirastes.uiActionBus');
    const scope = globalThis as Record<symbol, unknown>;
    const previous = scope[key];
    const foreign = { dispatch: async () => {}, subscribeById: () => () => {}, subscribeByType: () => () => {} };
    scope[key] = foreign;
    try {
      expect(getDefaultUiActionBus()).toBe(foreign);
    } finally {
      scope[key] = previous;
    }
  });
});

describe('registerAiClientAction', () => {
  it('validates the payload with the contract before the handler runs', async () => {
    const bus = new UiActionBus();
    const handler = vi.fn();
    cleanups.push(registerAiClientAction('tasks.highlight', handler, z.object({ taskId: z.string() }).strict(), { bus }));
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } });
    await expect(bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: 2 } }))
      .rejects.toThrow('Invalid payload for UI action tasks.highlight');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ taskId: '2' });
  });

  it('registers on the default bus when none is given', async () => {
    const handler = vi.fn();
    cleanups.push(registerAiClientAction('dialogs.open', handler));
    await getDefaultUiActionBus().dispatch({ type: 'glirastes.action', actionId: 'dialogs.open', payload: { id: 'x' } });
    expect(handler).toHaveBeenCalledWith({ id: 'x' });
  });
});

describe('navigation bridge', () => {
  it('pushes the href that the navigation tool computed', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ push, bus }));
    await bus.dispatch({
      type: 'glirastes.navigate',
      actionId: GLIRASTES_NAVIGATE_ACTION_ID,
      payload: { href: '/tasks?status=done', destination: '/tasks' },
    });
    expect(push).toHaveBeenCalledWith('/tasks?status=done');
  });

  it.each([
    'https://evil.example/', '//evil.example/x', '/\\evil', 'javascript:alert(1)', '', '/tasks\n',
    '/tasks/..//evil.example', '/a/%2E%2E//evil.example',
  ])(
    'never navigates to %j',
    async (href) => {
      const bus = new UiActionBus();
      const push = vi.fn();
      cleanups.push(registerNavigationBridge({ push, bus }));
      await expect(bus.dispatch({ type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href } }))
        .rejects.toThrow('Unsafe navigation target');
      expect(push).not.toHaveBeenCalled();
      expect(isSafeAppHref(href)).toBe(false);
    },
  );
});

describe('buildNavigationHref', () => {
  it('fills route parameters and encodes query values in key order', () => {
    expect(buildNavigationHref({
      destination: '/projects/:projectId/tasks',
      params: { projectId: 'a b' },
      query: { status: 'done', page: 2, archived: false, tags: ['x', 'y'], ids: ['1', '2'], empty: undefined },
      arrayFormats: { tags: 'comma', ids: 'repeat' },
    })).toBe('/projects/a%20b/tasks?status=done&page=2&archived=false&tags=x%2Cy&ids=1&ids=2');
  });

  it('refuses a destination with a missing parameter or a parameter that moves the path', () => {
    expect(() => buildNavigationHref({ destination: '/tasks/:id' })).toThrow('Missing route parameter id');
    expect(() => buildNavigationHref({ destination: '/tasks/:id', params: { id: '..' } }))
      .toThrow('Invalid route parameter id');
    expect(buildNavigationHref({ destination: '/tasks/:id', params: { id: '../admin' } })).toBe('/tasks/..%2Fadmin');
  });
});

describe('dispatchToolResultUiActions', () => {
  it('dispatches only Glirastes UI actions of successful tool results', async () => {
    const bus = new UiActionBus();
    const seen = vi.fn();
    bus.subscribeByType('glirastes.navigate', seen);
    bus.subscribeByType('set-filters', seen);
    expect(await dispatchToolResultUiActions({
      success: true,
      uiAction: [
        { type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href: '/tasks' } },
        { type: 'set-filters', filters: {} },
      ],
    }, bus)).toBe(1);
    expect(await dispatchToolResultUiActions({ success: false, uiAction: { type: 'glirastes.navigate' } }, bus)).toBe(0);
    expect(await dispatchToolResultUiActions('not a result', bus)).toBe(0);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('defineQueryFilters', () => {
  const tasks = defineQueryFilters({
    path: '/tasks',
    filters: {
      status: ['open', 'done'],
      q: 'string',
      page: 'integer',
      archived: 'boolean',
      tags: { arrayOf: 'string', format: 'comma' },
    },
  });

  it('reads typed values from a query string and drops values outside the domain', () => {
    expect(tasks.read('?status=done&q=release&page=2&archived=true&tags=a,b')).toEqual({
      status: 'done', q: 'release', page: 2, archived: true, tags: ['a', 'b'],
    });
    expect(tasks.read(new URLSearchParams('status=blocked&page=two'))).toEqual({});
  });

  it('builds the href the filter tool pushes', () => {
    expect(tasks.href({ status: 'open', tags: ['a', 'b'] })).toBe('/tasks?status=open&tags=a%2Cb');
  });

  it.each([
    ['a relative path', { path: 'tasks', filters: {} }],
    ['an empty enum', { path: '/tasks', filters: { status: [] } }],
    ['an unknown kind', { path: '/tasks', filters: { status: 'date' } }],
    ['a key that is not a name', { path: '/tasks', filters: { 'a b': 'string' } }],
  ])('rejects %s', (_label, definition) => {
    expect(() => defineQueryFilters(definition as never)).toThrow();
  });
});
```

1. In `src/public-subpaths.test.ts`, replace:

```ts
      './dist/server/adapters/nextjs/index.js',
    ],
    ['framework-neutral chat embed', './embed', './dist/embed/index.js'],
  ])('exports the independently importable %s surface', async (
    _label,
    subpath,
```

with:

```ts
      './dist/server/adapters/nextjs/index.js',
    ],
    ['framework-neutral chat embed', './embed', './dist/embed/index.js'],
    ['framework-neutral UI bridge', './browser', './dist/browser/index.js'],
  ])('exports the independently importable %s surface', async (
    _label,
    subpath,
```

2. In `src/public-subpaths.test.ts`, replace:

```ts
    expect(embedSource).not.toMatch(/from ['"]\.\.\/react\/index\.js['"]/);
  });

  it('keeps the standalone STT surface framework-neutral', async () => {
    const source = await readFile(
      new URL('./stt/index.ts', import.meta.url),
```

with:

```ts
    expect(embedSource).not.toMatch(/from ['"]\.\.\/react\/index\.js['"]/);
  });

  it('ships glirastes/browser framework-neutral, with its legacy shim', async () => {
    const [packageJson, shims, ...sources] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/generate-subpath-shims.mjs', import.meta.url), 'utf8'),
      ...['index', 'ui-action-bus', 'navigation', 'client-actions', 'query-filters'].map((name) => (
        readFile(new URL(`./browser/${name}.ts`, import.meta.url), 'utf8')
      )),
    ]);
    expect((JSON.parse(packageJson) as { files?: string[] }).files).toContain('browser');
    expect(shims).toContain("['browser', 'browser']");
    for (const source of sources) {
      expect(source).not.toMatch(/from ['"](?:react|react-dom|next|vue)(?:\/|['"])/);
      expect(source).not.toMatch(/from ['"]\.\.\//);
    }
  });

  it('keeps the standalone STT surface framework-neutral', async () => {
    const source = await readFile(
      new URL('./stt/index.ts', import.meta.url),
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/browser/__tests__/browser.test.ts src/public-subpaths.test.ts`
Expected: FAIL — `Cannot find module '../index.js'` in the browser tests, and `package.json` has no `./browser` export. `Test Files  2 failed (2)`, `Tests  2 failed | 9 passed (11)`

- [ ] **Step 3: Create the bus and the navigation bridge**

Create `src/browser/ui-action-bus.ts`:

```ts
/**
 * Framework-neutral UI action dispatch. React (`glirastes/react`), the chat
 * embed and plain browser code (`glirastes/browser`) share this bus, so a
 * generated navigation, filter or client action reaches the handler the app
 * registered, whatever framework it uses.
 */
export interface UiAction {
  type: string;
  actionId?: string;
  [key: string]: unknown;
}

export type UiActionHandler = (action: UiAction) => void | Promise<void>;

function addHandler(
  map: Map<string, Set<UiActionHandler>>,
  key: string,
  handler: UiActionHandler,
): () => void {
  const handlers = map.get(key) ?? new Set<UiActionHandler>();
  handlers.add(handler);
  map.set(key, handlers);

  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) map.delete(key);
  };
}

export class UiActionBus {
  private handlersByType = new Map<string, Set<UiActionHandler>>();
  private handlersById = new Map<string, Set<UiActionHandler>>();

  subscribeByType(type: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersByType, type, handler);
  }

  subscribeById(actionId: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersById, actionId, handler);
  }

  async dispatch(action: UiAction): Promise<void> {
    const typeHandlers = this.handlersByType.get(action.type);
    const idHandlers = action.actionId
      ? this.handlersById.get(action.actionId)
      : undefined;

    const allHandlers = new Set<UiActionHandler>([
      ...(typeHandlers ? Array.from(typeHandlers) : []),
      ...(idHandlers ? Array.from(idHandlers) : []),
    ]);

    for (const handler of allHandlers) {
      await handler(action);
    }
  }
}

const DEFAULT_BUS = Symbol.for('glirastes.uiActionBus');

/**
 * The page-wide bus that the chat dispatches generated UI actions to. Kept on
 * `globalThis` so two bundled copies of the SDK still share one bus.
 */
function isUiActionBus(value: unknown): value is UiActionBus {
  const candidate = value as Partial<UiActionBus> | null | undefined;
  return typeof candidate?.dispatch === 'function'
    && typeof candidate.subscribeById === 'function'
    && typeof candidate.subscribeByType === 'function';
}

export function getDefaultUiActionBus(): UiActionBus {
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[DEFAULT_BUS];
  // A bus of another bundled SDK copy is a different class: check the shape, not instanceof.
  if (isUiActionBus(existing)) return existing;
  const bus = new UiActionBus();
  scope[DEFAULT_BUS] = bus;
  return bus;
}
```

Create `src/browser/navigation.ts`:

```ts
import { getDefaultUiActionBus, type UiAction, type UiActionBus } from './ui-action-bus.js';

/** Action id of every generated navigation and filter tool (`ui.navigate`, `ui.filter.<view>`). */
export const GLIRASTES_NAVIGATE_ACTION_ID = 'glirastes.navigate';

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>;

/** `.` and `..` path segments, also percent-encoded; URL parsing resolves them. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * An app-internal path: one leading slash, no scheme, no protocol-relative
 * `//host`, no backslash, no control characters and no dot segment in the
 * path (`/a/..//host` resolves to the protocol-relative `//host`).
 */
export function isSafeAppHref(href: unknown): href is string {
  return typeof href === 'string'
    && href.length > 0
    && href.length <= 2_048
    && href.startsWith('/')
    && !href.startsWith('//')
    && !href.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(href)
    && !href.split(/[?#]/, 1)[0]!.split('/').some((segment) => DOT_SEGMENT.test(segment));
}

/**
 * Builds the href a navigation or filter tool pushes. `destination` uses the
 * route spelling of the tool (`/tasks/:id`); query values keep key order,
 * arrays are joined with commas (nuqs `parseAsArrayOf`) or repeated
 * (`searchParams.getAll`).
 */
export function buildNavigationHref(input: {
  destination: string;
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, QueryValue>>;
  arrayFormats?: Readonly<Record<string, 'comma' | 'repeat'>>;
}): string {
  const path = input.destination.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const name = segment.slice(1);
    const value = input.params?.[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing route parameter ${name}`);
    }
    // `.` and `..` would move the path instead of naming one segment.
    if (value === '.' || value === '..') throw new Error(`Invalid route parameter ${name}`);
    return encodeURIComponent(value);
  }).join('/');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (input.arrayFormats?.[key] === 'repeat') {
        for (const item of value) search.append(key, String(item));
      } else {
        search.append(key, value.map(String).join(','));
      }
      continue;
    }
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export interface NavigationBridgeOptions {
  /** The router's push, e.g. Next.js `router.push` or vue-router `router.push`. */
  push: (href: string) => unknown;
  bus?: UiActionBus;
}

function hrefOf(action: UiAction): unknown {
  const payload = action.payload;
  return payload && typeof payload === 'object' ? (payload as { href?: unknown }).href : undefined;
}

/**
 * Executes `ui.navigate` and `ui.filter.<view>` results with the app's own
 * router. Returns the unsubscribe function.
 */
export function registerNavigationBridge(options: NavigationBridgeOptions): () => void {
  const bus = options.bus ?? getDefaultUiActionBus();
  return bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, async (action) => {
    const href = hrefOf(action);
    if (!isSafeAppHref(href)) throw new Error('Unsafe navigation target');
    await options.push(href);
  });
}
```

- [ ] **Step 4: Create client actions and URL filter definitions**

Create `src/browser/client-actions.ts`:

```ts
import { getDefaultUiActionBus, type UiAction, type UiActionBus } from './ui-action-bus.js';

/** Any schema with `safeParse`, e.g. a Zod object; it types and validates the payload. */
export interface PayloadContract<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error?: unknown };
}

export interface ClientActionOptions {
  bus?: UiActionBus;
}

/**
 * Registers a client action the chat may run (`ui.<actionId>`). The literal
 * id and the contract are read by `glirastes tools refresh`; at runtime the
 * contract validates the payload before the handler runs.
 */
export function registerAiClientAction<T = Record<string, unknown>>(
  actionId: string,
  handler: (payload: T) => void | Promise<void>,
  contract?: PayloadContract<T>,
  options: ClientActionOptions = {},
): () => void {
  const bus = options.bus ?? getDefaultUiActionBus();
  return bus.subscribeById(actionId, async (action) => {
    const payload = action.payload ?? {};
    if (!contract) {
      await handler(payload as T);
      return;
    }
    const parsed = contract.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid payload for UI action ${actionId}`);
    await handler(parsed.data);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hands the UI actions of a successful tool result to the bus. Only actions
 * of generated Glirastes tools (`glirastes.*`) are dispatched; app-specific
 * uiActions stay with the app's own result handler. Returns the count.
 */
export async function dispatchToolResultUiActions(
  result: unknown,
  bus: UiActionBus = getDefaultUiActionBus(),
): Promise<number> {
  if (!isRecord(result) || result.success !== true) return 0;
  const actions = Array.isArray(result.uiAction) ? result.uiAction : [result.uiAction];
  let dispatched = 0;
  for (const action of actions) {
    if (!isRecord(action) || typeof action.type !== 'string' || !action.type.startsWith('glirastes.')) continue;
    await bus.dispatch(action as UiAction);
    dispatched += 1;
  }
  return dispatched;
}
```

Create `src/browser/query-filters.ts`:

```ts
import { buildNavigationHref, type QueryValue } from './navigation.js';

export type QueryFilterScalar = 'string' | 'integer' | 'number' | 'boolean' | readonly [string, ...string[]];
export type QueryFilterSpec =
  | QueryFilterScalar
  | { readonly arrayOf: QueryFilterScalar; readonly format?: 'comma' | 'repeat' };

type ScalarValue<S> = S extends 'integer' | 'number' ? number
  : S extends 'boolean' ? boolean
    : S extends readonly (infer L)[] ? L
      : string;
type FilterValue<S> = S extends { readonly arrayOf: infer V } ? Array<ScalarValue<V>> : ScalarValue<S>;

export type QueryFilterValues<F extends Record<string, QueryFilterSpec>> = {
  [K in keyof F]?: FilterValue<F[K]>;
};

export interface QueryFiltersDefinition<F extends Record<string, QueryFilterSpec>> {
  readonly path: string;
  readonly filters: F;
  /** Typed filter values from a query string; values outside the domain are dropped. */
  read(search: string | URLSearchParams): QueryFilterValues<F>;
  /** The href `ui.filter.<view>` pushes for these values. */
  href(values: QueryFilterValues<F>, params?: Readonly<Record<string, string>>): string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const KINDS = new Set(['string', 'integer', 'number', 'boolean']);

function scalarOf(spec: QueryFilterSpec): QueryFilterScalar {
  return typeof spec === 'object' && !Array.isArray(spec) && 'arrayOf' in spec ? spec.arrayOf : spec as QueryFilterScalar;
}

function assertScalar(key: string, scalar: unknown): void {
  if (Array.isArray(scalar)) {
    if (scalar.length === 0 || scalar.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new Error(`Filter ${key} needs at least one non-empty value`);
    }
    return;
  }
  if (typeof scalar !== 'string' || !KINDS.has(scalar)) {
    throw new Error(`Filter ${key} must be string, integer, number, boolean or a list of values`);
  }
}

function parseScalar(scalar: QueryFilterScalar, raw: string): unknown {
  if (Array.isArray(scalar)) return scalar.includes(raw) ? raw : undefined;
  switch (scalar) {
    case 'integer':
      return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
    case 'number': {
      const value = Number(raw);
      return raw.trim() !== '' && Number.isFinite(value) ? value : undefined;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    default:
      return raw;
  }
}

/**
 * Declares the URL filters of a view for apps without a framework source
 * (SPAs, Vue). `glirastes tools refresh` reads the literal definition and
 * generates `ui.filter.<view>`; the app uses `read` to apply the URL.
 */
export function defineQueryFilters<const F extends Record<string, QueryFilterSpec>>(definition: {
  path: string;
  filters: F;
}): QueryFiltersDefinition<F> {
  if (typeof definition.path !== 'string' || !definition.path.startsWith('/') || definition.path.startsWith('//')) {
    throw new Error('defineQueryFilters needs an app path starting with /');
  }
  for (const [key, spec] of Object.entries(definition.filters)) {
    if (!NAME.test(key)) throw new Error(`Filter key ${JSON.stringify(key)} is not a plain name`);
    assertScalar(key, scalarOf(spec));
  }
  const arrayFormats: Record<string, 'comma' | 'repeat'> = {};
  for (const [key, spec] of Object.entries(definition.filters)) {
    if (typeof spec === 'object' && !Array.isArray(spec) && 'arrayOf' in spec) arrayFormats[key] = spec.format ?? 'comma';
  }
  return {
    path: definition.path,
    filters: definition.filters,
    read(search) {
      const params = typeof search === 'string' ? new URLSearchParams(search) : search;
      const values: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(definition.filters)) {
        const scalar = scalarOf(spec);
        if (arrayFormats[key]) {
          const raw = arrayFormats[key] === 'repeat' ? params.getAll(key) : (params.get(key)?.split(',') ?? []);
          const parsed = raw.map((value) => parseScalar(scalar, value)).filter((value) => value !== undefined);
          if (parsed.length > 0) values[key] = parsed;
          continue;
        }
        const raw = params.get(key);
        const parsed = raw === null ? undefined : parseScalar(scalar, raw);
        if (parsed !== undefined) values[key] = parsed;
      }
      return values as QueryFilterValues<F>;
    },
    href(values, params) {
      return buildNavigationHref({
        destination: definition.path,
        ...(params ? { params } : {}),
        query: values as Record<string, QueryValue>,
        arrayFormats,
      });
    },
  };
}
```

Create `src/browser/index.ts`:

```ts
export {
  getDefaultUiActionBus,
  UiActionBus,
  type UiAction,
  type UiActionHandler,
} from './ui-action-bus.js';
export {
  buildNavigationHref,
  GLIRASTES_NAVIGATE_ACTION_ID,
  isSafeAppHref,
  registerNavigationBridge,
  type NavigationBridgeOptions,
  type QueryValue,
} from './navigation.js';
export {
  dispatchToolResultUiActions,
  registerAiClientAction,
  type ClientActionOptions,
  type PayloadContract,
} from './client-actions.js';
export {
  defineQueryFilters,
  type QueryFilterScalar,
  type QueryFilterSpec,
  type QueryFiltersDefinition,
  type QueryFilterValues,
} from './query-filters.js';
```

- [ ] **Step 5: Re-export the bus from React**

In `src/react/ui.ts`, replace:

```ts
import { useEffect, useCallback, useRef } from 'react';
import type { ActionIdRegistry } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export interface UiAction {
  type: string;
  actionId?: string;
  [key: string]: unknown;
}

export type UiActionHandler = (action: UiAction) => void | Promise<void>;

export interface AiClientActionEventDetail {
  actionId: string;
  payload?: Record<string, unknown>;
}

// ============================================================================
// UiActionBus (class-based, framework-agnostic)
// ============================================================================

function addHandler(
  map: Map<string, Set<UiActionHandler>>,
  key: string,
  handler: UiActionHandler,
): () => void {
  const handlers = map.get(key) ?? new Set<UiActionHandler>();
  handlers.add(handler);
  map.set(key, handlers);

  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) map.delete(key);
  };
}

export class UiActionBus {
  private handlersByType = new Map<string, Set<UiActionHandler>>();
  private handlersById = new Map<string, Set<UiActionHandler>>();

  subscribeByType(type: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersByType, type, handler);
  }

  subscribeById(actionId: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersById, actionId, handler);
  }

  async dispatch(action: UiAction): Promise<void> {
    const typeHandlers = this.handlersByType.get(action.type);
    const idHandlers = action.actionId
      ? this.handlersById.get(action.actionId)
      : undefined;

    const allHandlers = new Set<UiActionHandler>([
      ...(typeHandlers ? Array.from(typeHandlers) : []),
      ...(idHandlers ? Array.from(idHandlers) : []),
    ]);

    for (const handler of allHandlers) {
      await handler(action);
    }
  }
}

// ============================================================================
// UiActionBus Hooks
// ============================================================================
```

with:

```ts
import { useEffect, useCallback, useRef } from 'react';
import { UiActionBus, type UiActionHandler } from '../browser/ui-action-bus.js';
import type { ActionIdRegistry } from '../types.js';

// ============================================================================
// Types and the framework-neutral bus (glirastes/browser)
// ============================================================================

export {
  getDefaultUiActionBus,
  UiActionBus,
  type UiAction,
  type UiActionHandler,
} from '../browser/ui-action-bus.js';

export interface AiClientActionEventDetail {
  actionId: string;
  payload?: Record<string, unknown>;
}

// ============================================================================
// UiActionBus Hooks
// ============================================================================
```

- [ ] **Step 6: Publish the subpath**

1. In `package.json`, replace:

```json
      "types": "./dist/embed/index.d.ts",
      "default": "./dist/embed/index.js"
    },
    "./codegen": {
      "types": "./dist/codegen/index.d.ts",
      "default": "./dist/codegen/index.js"
```

with:

```json
      "types": "./dist/embed/index.d.ts",
      "default": "./dist/embed/index.js"
    },
    "./browser": {
      "import": {
        "types": "./dist/browser/index.d.ts",
        "default": "./dist/browser/index.js"
      },
      "require": {
        "types": "./dist/cjs/browser/index.d.ts",
        "default": "./dist/cjs/browser/index.js"
      }
    },
    "./codegen": {
      "types": "./dist/codegen/index.d.ts",
      "default": "./dist/codegen/index.js"
```

2. In `package.json`, replace:

```json
    "react",
    "!react/langgraph",
    "embed",
    "codegen",
    "skills",
    "CHANGELOG.md",
```

with:

```json
    "react",
    "!react/langgraph",
    "embed",
    "browser",
    "codegen",
    "skills",
    "CHANGELOG.md",
```

In `scripts/generate-subpath-shims.mjs`, replace:

```js
  ['react/vercel', 'react/transports/vercel'],
  ['react/langgraph', 'react/transports/langgraph'],
  ['embed', 'embed'],
  ['codegen', 'codegen'],
  ['openapi', 'openapi'],
];
```

with:

```js
  ['react/vercel', 'react/transports/vercel'],
  ['react/langgraph', 'react/transports/langgraph'],
  ['embed', 'embed'],
  ['browser', 'browser'],
  ['codegen', 'codegen'],
  ['openapi', 'openapi'],
];
```

In `.gitignore`, replace:

```text
/codegen/
/openapi/
/embed/
*.tsbuildinfo
.DS_Store
.vscode
```

with:

```text
/codegen/
/openapi/
/embed/
/browser/
*.tsbuildinfo
.DS_Store
.vscode
```

In `CLAUDE.md`, replace:

```markdown

`glirastes` · `/contracts` · `/runtime` · `/runtime/ai-sdk` · `/ai-sdk` ·
`/stt` · `/sync` · `/server` · `/server/nextjs` · `/adapter/nextjs` ·
`/server/testing` · `/react` · `/react/vercel` · `/react/styles.css` · `/codegen`

**Deliberately not exported here** (the confirmed pilot cut — still versioned in
the repo, deferred from the package): NestJS, LangGraph, OpenAPI, Skill/MCP
```

with:

```markdown

`glirastes` · `/contracts` · `/runtime` · `/runtime/ai-sdk` · `/ai-sdk` ·
`/stt` · `/sync` · `/server` · `/server/nextjs` · `/adapter/nextjs` ·
`/server/testing` · `/react` · `/react/vercel` · `/react/styles.css` · `/embed` ·
`/browser` · `/codegen`

**Deliberately not exported here** (the confirmed pilot cut — still versioned in
the repo, deferred from the package): NestJS, LangGraph, OpenAPI, Skill/MCP
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run src/browser/__tests__/browser.test.ts src/public-subpaths.test.ts && bunx vitest run src/react && bun run typecheck`
Expected: PASS — the build prints `Generated 18 subpath shims.` and writes `dist/browser/index.js` and `dist/cjs/browser/index.js`; the two files report `Test Files  2 passed (2)`, `Tests  34 passed (34)`; the React suites report `Test Files  34 passed (34)`, `Tests  280 passed (280)`; typecheck clean. On a heavily loaded machine the timing-sensitive `floating-chat-ui`, `voice-draft` and `voice-push-to-talk` files can hit Vitest's 5-second timeout; rerun `bunx vitest run src/react --maxWorkers=4` (they do not touch the bus) before treating that as a failure.

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add .gitignore CLAUDE.md package.json scripts/generate-subpath-shims.mjs src/browser/__tests__/browser.test.ts \
  src/browser/client-actions.ts src/browser/index.ts src/browser/navigation.ts src/browser/query-filters.ts \
  src/browser/ui-action-bus.ts src/public-subpaths.test.ts src/react/ui.ts
git commit -m "feat(browser): add a framework-neutral ui action and navigation bridge"
```

### Task 10: Contract argument of `useAiClientAction` and the React navigation bridge

**Files:**
- Modify: `src/react/ui.ts` (`useAiClientAction` third argument, `useGlirastesNavigationBridge`), `src/react/types.ts` (`AiChatProviderConfig.uiActionBus`), `src/react/provider/ai-chat-provider.tsx` (dispatch after `onToolResult`)
- Test: `src/react/__tests__/ui-actions.test.tsx` (Create)

**Interfaces:**
- Consumes: `registerAiClientAction`, `registerNavigationBridge`, `dispatchToolResultUiActions`, `getDefaultUiActionBus` (Task 9).
- Produces:
  - `useAiClientAction<T = Record<string, unknown>>(actionId: string, handler: (payload: T) => void | Promise<void>, contract?: PayloadContract<T>): void` — subscribes on the default bus (generated tools) and keeps the `ai-client-action` window event (existing callers); the contract validates on both channels. The literal id and the contract are what Task 17 reads.
  - `useGlirastesNavigationBridge(options: NavigationBridgeOptions): void` — always uses the latest `push`, unsubscribes on unmount.
  - `AiChatProviderConfig.uiActionBus?: UiActionBus`; the provider hands each new tool result to `dispatchToolResultUiActions` after `onToolResult` (default: the page-wide bus). App-specific `uiAction`s stay with `onToolResult`.

Note for P11: an app whose `onToolResult` already forwards every `uiAction` to the same bus would run a generated action twice; P11 checks Get It Done's result handler and leaves `glirastes.*` actions to the provider.

- [ ] **Step 1: Write the failing tests**

Create `src/react/__tests__/ui-actions.test.tsx`:

```tsx
// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import type { ChatTransport } from '../types.js';
import {
  dispatchAiClientAction,
  getDefaultUiActionBus,
  UiActionBus,
  useAiClientAction,
  useGlirastesNavigationBridge,
} from '../index.js';

afterEach(cleanup);

const highlight = z.object({ taskId: z.string() }).strict();

function Highlighter({ onHighlight }: { onHighlight: (taskId: string) => void }) {
  useAiClientAction('tasks.highlight', (payload) => onHighlight(payload.taskId), highlight);
  return null;
}

function Bridge({ push, bus }: { push: (href: string) => void; bus?: UiActionBus }) {
  useGlirastesNavigationBridge({ push, ...(bus ? { bus } : {}) });
  return null;
}

describe('useAiClientAction with a contract', () => {
  it('runs generated client actions from the default bus with a validated payload', async () => {
    const onHighlight = vi.fn();
    const view = render(<Highlighter onHighlight={onHighlight} />);
    const bus = getDefaultUiActionBus();

    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } });
    await expect(bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: 2 } }))
      .rejects.toThrow('Invalid payload');
    expect(onHighlight).toHaveBeenCalledTimes(1);
    expect(onHighlight).toHaveBeenCalledWith('2');

    view.unmount();
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '3' } });
    expect(onHighlight).toHaveBeenCalledTimes(1);
  });

  it('keeps the window-event channel for existing callers and validates it too', () => {
    const onHighlight = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Highlighter onHighlight={onHighlight} />);
    dispatchAiClientAction({ actionId: 'tasks.highlight', payload: { taskId: '5' } });
    dispatchAiClientAction({ actionId: 'tasks.highlight', payload: { taskId: 5 } });
    expect(onHighlight).toHaveBeenCalledTimes(1);
    expect(onHighlight).toHaveBeenCalledWith('5');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('useGlirastesNavigationBridge', () => {
  it('pushes navigation results with the latest router and stops on unmount', async () => {
    const bus = new UiActionBus();
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Bridge push={first} bus={bus} />);
    view.rerender(<Bridge push={second} bus={bus} />);
    await bus.dispatch({ type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/overview' } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('/overview');

    view.unmount();
    await bus.dispatch({ type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/tasks' } });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('AiChatProvider and generated UI actions', () => {
  function transport(output: unknown): ChatTransport {
    return {
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'tool-ui_navigate', toolCallId: 'call-1', state: 'output-available', output } as never],
      }],
      status: 'ready',
      error: null,
      sendMessage: vi.fn(async () => {}),
      stop: vi.fn(),
      setMessages: vi.fn(),
      addToolApprovalResponse: vi.fn(async () => {}),
    };
  }

  it('hands a generated navigation result to the bus after onToolResult', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    const onToolResult = vi.fn();
    render(
      <AiChatProvider
        transport={transport({
          success: true,
          message: 'Action executed.',
          uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/tasks?status=done' } },
        })}
        uiActionBus={bus}
        onToolResult={onToolResult}
      >
        <Bridge push={push} bus={bus} />
      </AiChatProvider>,
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tasks?status=done'));
    expect(onToolResult).toHaveBeenCalledWith('ui_navigate', expect.objectContaining({ success: true }));
  });

  it('leaves app-specific uiActions to the app', async () => {
    const bus = new UiActionBus();
    const seen = vi.fn();
    bus.subscribeByType('set-filters', seen);
    render(
      <AiChatProvider transport={transport({ success: true, uiAction: { type: 'set-filters', filters: {} } })} uiActionBus={bus}>
        <div />
      </AiChatProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/react/__tests__/ui-actions.test.tsx`
Expected: FAIL — `useGlirastesNavigationBridge` is not exported, `useAiClientAction` ignores the bus and the contract, and the provider dispatches nothing. `Test Files  1 failed (1)`, `Tests  4 failed | 1 passed (5)`

- [ ] **Step 3: Add the contract argument and the bridge hook**

1. In `src/react/ui.ts`, replace:

```ts
import { useEffect, useCallback, useRef } from 'react';
import { UiActionBus, type UiActionHandler } from '../browser/ui-action-bus.js';
import type { ActionIdRegistry } from '../types.js';

// ============================================================================
```

with:

```ts
import { useEffect, useCallback, useRef } from 'react';
import { registerAiClientAction, type PayloadContract } from '../browser/client-actions.js';
import {
  registerNavigationBridge,
  type NavigationBridgeOptions,
} from '../browser/navigation.js';
import {
  getDefaultUiActionBus,
  UiActionBus,
  type UiActionHandler,
} from '../browser/ui-action-bus.js';
import type { ActionIdRegistry } from '../types.js';

// ============================================================================
```

2. In `src/react/ui.ts`, replace:

````ts

/**
 * Hook to register a handler for a specific AI client action ID.
 * The handler is tracked in a global registry for dev-mode validation.
 *
 * @example
 * ```tsx
 * useAiClientAction('task-details.open', (payload) => {
 *   openTaskDetails(payload?.taskId as string);
 * });
 * ```
 */
export function useAiClientAction(
  actionId: string,
  handler: (payload?: Record<string, unknown>) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const stableHandler = useCallback(
    (payload?: Record<string, unknown>) => handlerRef.current(payload),
    [],
  );

````

with:

````ts

/**
 * Hook to register a handler for a specific AI client action ID.
 * The literal id and the optional contract (third argument, e.g. a Zod
 * object) are what `glirastes tools refresh` turns into the tool
 * `ui.<actionId>`; the contract types and validates the payload. Generated
 * actions arrive on the default UiActionBus; `dispatchAiClientAction`
 * window events keep working for existing callers.
 *
 * @example
 * ```tsx
 * useAiClientAction('task-details.open', (payload) => {
 *   openTaskDetails(payload.taskId);
 * }, z.object({ taskId: z.string() }));
 * ```
 */
export function useAiClientAction<T = Record<string, unknown>>(
  actionId: string,
  handler: (payload: T) => void | Promise<void>,
  contract?: PayloadContract<T>,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const contractRef = useRef(contract);
  contractRef.current = contract;

  const stableHandler = useCallback(
    (payload: T) => handlerRef.current(payload),
    [],
  );

````

3. In `src/react/ui.ts`, replace:

```ts
      const detail = (event as CustomEvent<AiClientActionEventDetail>)
        .detail;
      if (!detail || detail.actionId !== actionId) return;
      stableHandler(detail.payload);
    };

    window.addEventListener(AI_CLIENT_ACTION_EVENT, handleEvent);
    return () => {
      window.removeEventListener(AI_CLIENT_ACTION_EVENT, handleEvent);
      registeredHandlers.delete(actionId);
    };
  }, [actionId, stableHandler]);
}

// ============================================================================
// Handler Registry Inspection (for dev-mode validation)
// ============================================================================
```

with:

```ts
      const detail = (event as CustomEvent<AiClientActionEventDetail>)
        .detail;
      if (!detail || detail.actionId !== actionId) return;
      const validator = contractRef.current;
      if (!validator) {
        void stableHandler(detail.payload as T);
        return;
      }
      const parsed = validator.safeParse(detail.payload ?? {});
      if (!parsed.success) {
        console.warn('[glirastes] A UI action payload did not match its contract');
        return;
      }
      void stableHandler(parsed.data);
    };

    window.addEventListener(AI_CLIENT_ACTION_EVENT, handleEvent);
    const unsubscribe = registerAiClientAction<T>(
      actionId,
      (payload) => stableHandler(payload),
      {
        safeParse: (value) => contractRef.current?.safeParse(value)
          ?? { success: true, data: value as T },
      },
      { bus: getDefaultUiActionBus() },
    );
    return () => {
      window.removeEventListener(AI_CLIENT_ACTION_EVENT, handleEvent);
      unsubscribe();
      registeredHandlers.delete(actionId);
    };
  }, [actionId, stableHandler]);
}

/**
 * Executes the generated `ui.navigate` and `ui.filter.<view>` tools with the
 * app's router, e.g. `useGlirastesNavigationBridge({ push: router.push })`
 * with Next.js `useRouter()`. Always the latest `push` is used.
 */
export function useGlirastesNavigationBridge(options: NavigationBridgeOptions): void {
  const pushRef = useRef(options.push);
  pushRef.current = options.push;
  const bus = options.bus;
  useEffect(
    () => registerNavigationBridge({
      push: (href) => pushRef.current(href),
      ...(bus ? { bus } : {}),
    }),
    [bus],
  );
}

// ============================================================================
// Handler Registry Inspection (for dev-mode validation)
// ============================================================================
```

- [ ] **Step 4: Dispatch generated UI actions from the provider**

1. In `src/react/types.ts`, replace:

```ts
import type { ReactNode, ReactElement, ComponentType, MouseEvent as ReactMouseEvent } from 'react';
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';

```

with:

```ts
import type { ReactNode, ReactElement, ComponentType, MouseEvent as ReactMouseEvent } from 'react';
import type { UiActionBus } from '../browser/ui-action-bus.js';
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';

```

2. In `src/react/types.ts`, replace:

```ts
   */
  themeScope?: 'inline' | 'inherit';
  onToolResult?: OnToolResult;
  onBeforeSend?: OnBeforeSend;
  approvalDescription?: ApprovalDescriptionFn;
  continueMessage?: string;
```

with:

```ts
   */
  themeScope?: 'inline' | 'inherit';
  onToolResult?: OnToolResult;
  /**
   * Bus that receives the UI actions of generated tools (`ui.navigate`,
   * `ui.filter.<view>`, `ui.<actionId>`) after `onToolResult`. Defaults to
   * the page-wide bus of `glirastes/browser`.
   */
  uiActionBus?: UiActionBus;
  onBeforeSend?: OnBeforeSend;
  approvalDescription?: ApprovalDescriptionFn;
  continueMessage?: string;
```

1. In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
import { clarificationAnswerMessage, findOpenClarification } from '../utils/clarification.js';
import { createCompletionSearch } from '../completions/completion-search.js';
import { createToolResultRendererRegistry } from '../tool-renderers/registry.js';
import {
  CLARIFICATION_MAX_ANSWER_LENGTH,
  parseClarificationAnswer,
```

with:

```tsx
import { clarificationAnswerMessage, findOpenClarification } from '../utils/clarification.js';
import { createCompletionSearch } from '../completions/completion-search.js';
import { createToolResultRendererRegistry } from '../tool-renderers/registry.js';
import { dispatchToolResultUiActions } from '../../browser/client-actions.js';
import { getDefaultUiActionBus } from '../../browser/ui-action-bus.js';
import {
  CLARIFICATION_MAX_ANSWER_LENGTH,
  parseClarificationAnswer,
```

2. In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  theme: userTheme,
  themeScope = 'inline',
  onToolResult,
  onBeforeSend,
  approvalDescription: userApprovalDescription,
  continueMessage = 'Please continue.',
```

with:

```tsx
  theme: userTheme,
  themeScope = 'inline',
  onToolResult,
  uiActionBus,
  onBeforeSend,
  approvalDescription: userApprovalDescription,
  continueMessage = 'Please continue.',
```

3. In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  // Stable refs for callbacks to avoid re-creating transport
  const onToolResultRef = useRef(onToolResult);
  onToolResultRef.current = onToolResult;
  const approvalDescriptionRef = useRef(approvalDescriptionFn);
  approvalDescriptionRef.current = approvalDescriptionFn;

```

with:

```tsx
  // Stable refs for callbacks to avoid re-creating transport
  const onToolResultRef = useRef(onToolResult);
  onToolResultRef.current = onToolResult;
  const uiActionBusRef = useRef(uiActionBus);
  uiActionBusRef.current = uiActionBus;
  const approvalDescriptionRef = useRef(approvalDescriptionFn);
  approvalDescriptionRef.current = approvalDescriptionFn;

```

4. In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
          if (!processedToolCallsRef.current.has(toolCallId)) {
            processedToolCallsRef.current.add(toolCallId);
            onToolResultRef.current?.(toolName, toolPart.output);
          }
        }
      }
```

with:

```tsx
          if (!processedToolCallsRef.current.has(toolCallId)) {
            processedToolCallsRef.current.add(toolCallId);
            onToolResultRef.current?.(toolName, toolPart.output);
            // Generated UI tools run in the browser through the app's bridge.
            void dispatchToolResultUiActions(
              toolPart.output,
              uiActionBusRef.current ?? getDefaultUiActionBus(),
            ).catch(() => {
              console.warn('[glirastes] A generated UI action failed');
            });
          }
        }
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/react/__tests__/ui-actions.test.tsx && bunx vitest run src/react && bun run typecheck`
Expected: PASS — the new file reports `Test Files  1 passed (1)`, `Tests  5 passed (5)`; the React suites report `Test Files  35 passed (35)`, `Tests  285 passed (285)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/react/__tests__/ui-actions.test.tsx src/react/provider/ai-chat-provider.tsx src/react/types.ts \
  src/react/ui.ts
git commit -m "feat(react): type client actions by contract and bridge navigation"
```

### Task 11: Runtime of generated navigation, filter and client action tools

**Files:**
- Create: `src/server/core/generated-ui-tool.ts`
- Modify: `src/server/core/index.ts` (exports; endpoint results drop `glirastes.*` UI actions), `src/types.ts` (`createUiActionSchema` accepts the generated UI actions)
- Test: `src/server/core/__tests__/generated-ui-tool.test.ts` (Create)

**Interfaces:**
- Consumes: `buildNavigationHref`, `GLIRASTES_NAVIGATE_ACTION_ID` (Task 9), `defineTool`, `normalizeResultUiAction` and `createUiActionSchema` (unchanged signatures).
- Produces:
  - `export type GeneratedUiAction = { kind: 'navigate' } | { kind: 'filter'; destination: string; keys: ReadonlyArray<{ key: string; array?: 'comma' | 'repeat' }> } | { kind: 'client-action'; actionId: string }`
  - `export interface GeneratedUiToolDefinition { id; toolName; description; inputSchema; outputSchema?; needsApproval: boolean; action: GeneratedUiAction }`
  - `export function uiActionToolToTool(definition): Tool` — never calls a server. Navigation: `{ destination, params? }` → `glirastes.navigate` with `href`; filter: declared keys only, in declaration order, plus `params`; client action: the input as payload of `glirastes.action`. A missing route parameter is a `{ success: false, error }` result, never a throw. All three are exported from `glirastes/server`.
  - The `glirastes.*` UI action namespace belongs to these tools. Since Task 10 the chat dispatches every successful `glirastes.*` result to the app's bridge without asking again, so `endpointToolToTool` drops `glirastes.*` actions from what an endpoint returns (its own `uiAction` field, a pattern or a template): data an endpoint returns can neither navigate nor run a client action past that action's confirmation.
  - `createUiActionSchema()` also accepts the two generated shapes (`glirastes.navigate` with an app path `payload.href`, `glirastes.action` with a record payload). Apps that pass a `uiActionSchema` to `createAiChatHandler` (Get It Done does, through `createUiActionSchema([…])`) would otherwise have every generated UI action dropped by `normalizeResultUiAction` ("Invalid UI action dropped.").

- [ ] **Step 1: Write the failing tests**

Create `src/server/core/__tests__/generated-ui-tool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createJsonSchemaLike } from '../../../runtime/json-schema.js';
import { createUiActionSchema } from '../../../types.js';
import { endpointToolToTool, normalizeResultUiAction, uiActionToolToTool } from '../index.js';

const context = { currentDate: new Date(), locale: 'en-US' } as never;
const anyObject = createJsonSchemaLike({ type: 'object' });

describe('uiActionToolToTool', () => {
  it('turns a navigation call into the href the app bridge pushes', async () => {
    const tool = uiActionToolToTool({
      id: 'ui.navigate',
      toolName: 'ui_navigate',
      description: 'Open a page of this app.',
      inputSchema: anyObject,
      needsApproval: false,
      action: { kind: 'navigate' },
    });
    expect(tool.needsApproval).toBe(false);
    await expect(tool.execute({ destination: '/tasks/:id', params: { id: '7' } }, context)).resolves.toEqual({
      success: true,
      message: 'Action executed.',
      uiAction: {
        type: 'glirastes.navigate',
        actionId: 'glirastes.navigate',
        payload: { href: '/tasks/7', destination: '/tasks/:id', params: { id: '7' } },
      },
    });
    await expect(tool.execute({ destination: '/tasks/:id' }, context)).resolves.toEqual({
      success: false,
      error: 'Missing route parameter id',
    });
  });

  it('puts only the declared filter keys into the query, in declaration order', async () => {
    const tool = uiActionToolToTool({
      id: 'ui.filter.tasks',
      toolName: 'ui_filter_tasks',
      description: 'Filter the tasks page.',
      inputSchema: anyObject,
      needsApproval: false,
      action: {
        kind: 'filter',
        destination: '/projects/:projectId/tasks',
        keys: [{ key: 'status' }, { key: 'tags', array: 'repeat' }],
      },
    });
    await expect(tool.execute({
      status: 'done', tags: ['a', 'b'], params: { projectId: 'p1' }, other: 'ignored',
    }, context)).resolves.toMatchObject({
      success: true,
      uiAction: {
        type: 'glirastes.navigate',
        payload: {
          href: '/projects/p1/tasks?status=done&tags=a&tags=b',
          destination: '/projects/:projectId/tasks',
          query: { status: 'done', tags: ['a', 'b'] },
        },
      },
    });
  });

  it('passes a client action payload through to the registered handler', async () => {
    const tool = uiActionToolToTool({
      id: 'ui.tasks.highlight',
      toolName: 'ui_tasks_highlight',
      description: 'Highlight a task.',
      inputSchema: anyObject,
      needsApproval: true,
      action: { kind: 'client-action', actionId: 'tasks.highlight' },
    });
    expect(tool.needsApproval).toBe(true);
    await expect(tool.execute({ taskId: '2' }, context)).resolves.toEqual({
      success: true,
      message: 'Action executed.',
      uiAction: { type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } },
    });
  });

  it('keeps its UI action through an app uiActionSchema built with createUiActionSchema', async () => {
    const navigate = uiActionToolToTool({
      id: 'ui.navigate', toolName: 'ui_navigate', description: 'Open a page of this app.',
      inputSchema: anyObject, needsApproval: false, action: { kind: 'navigate' },
    });
    const highlight = uiActionToolToTool({
      id: 'ui.tasks.highlight', toolName: 'ui_tasks_highlight', description: 'Highlight a task.',
      inputSchema: anyObject, needsApproval: false, action: { kind: 'client-action', actionId: 'tasks.highlight' },
    });
    const schema = createUiActionSchema();
    for (const result of [
      await navigate.execute({ destination: '/tasks' }, context),
      await highlight.execute({ taskId: '2' }, context),
    ]) {
      expect(normalizeResultUiAction(result, schema)).toEqual(result);
    }
  });
});

describe('endpoint results and the glirastes.* UI actions', () => {
  it('never carry a UI action reserved for generated tools, whatever the endpoint returns', async () => {
    const callEndpoint = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          title: 'Write tests',
          uiAction: [
            { type: 'glirastes.action', actionId: 'tasks.delete', payload: { taskId: '2' } },
            { type: 'navigate', path: '/tasks' },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/admin' } } },
      });
    const tool = endpointToolToTool({
      id: 'tasks.get',
      toolName: 'tasks_get',
      description: 'Read a task.',
      method: 'GET',
      path: '/api/tasks/:id',
      inputSchema: z.object({ id: z.string() }),
    });
    await expect(tool.execute({ id: '2' }, { callEndpoint } as never)).resolves.toEqual({
      success: true,
      title: 'Write tests',
      uiAction: [{ type: 'navigate', path: '/tasks' }],
    });
    await expect(tool.execute({ id: '2' }, { callEndpoint } as never)).resolves.toEqual({ success: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/server/core/__tests__/generated-ui-tool.test.ts`
Expected: FAIL — `uiActionToolToTool is not a function`, and the endpoint result still carries the `glirastes.*` actions it returned. `Test Files  1 failed (1)`, `Tests  5 failed (5)`

- [ ] **Step 3: Implement the generated UI tool**

Create `src/server/core/generated-ui-tool.ts`:

```ts
import {
  buildNavigationHref,
  GLIRASTES_NAVIGATE_ACTION_ID,
  type QueryValue,
} from '../../browser/navigation.js';
import { defineTool, type SchemaLike, type Tool } from '../../types.js';

/** What a generated UI tool asks the browser to do. */
export type GeneratedUiAction =
  | { kind: 'navigate' }
  | {
    kind: 'filter';
    /** Route spelling of the filtered page, e.g. `/tasks` or `/projects/:id/tasks`. */
    destination: string;
    keys: ReadonlyArray<{ key: string; array?: 'comma' | 'repeat' }>;
  }
  | { kind: 'client-action'; actionId: string };

export interface GeneratedUiToolDefinition {
  id: string;
  toolName: string;
  description: string;
  inputSchema: SchemaLike;
  outputSchema?: SchemaLike;
  needsApproval: boolean;
  action: GeneratedUiAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringParams(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/**
 * Runtime of the tools that `glirastes tools refresh` generates from pages,
 * URL filters and client actions. They never call a server: the result
 * carries a `glirastes.*` uiAction that the chat hands to the app's bridge.
 */
export function uiActionToolToTool(definition: GeneratedUiToolDefinition): Tool {
  return defineTool({
    id: definition.id,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    needsApproval: definition.needsApproval,
    execute: async (rawInput: unknown) => {
      const input = isRecord(rawInput) ? rawInput : {};
      const action = definition.action;
      if (action.kind === 'client-action') {
        return {
          success: true,
          message: 'Action executed.',
          uiAction: { type: 'glirastes.action', actionId: action.actionId, payload: { ...input } },
        };
      }
      const params = stringParams(input.params);
      try {
        if (action.kind === 'navigate') {
          const destination = typeof input.destination === 'string' ? input.destination : '';
          const href = buildNavigationHref({ destination, ...(params ? { params } : {}) });
          return {
            success: true,
            message: 'Action executed.',
            uiAction: {
              type: 'glirastes.navigate',
              actionId: GLIRASTES_NAVIGATE_ACTION_ID,
              payload: { href, destination, ...(params ? { params } : {}) },
            },
          };
        }
        const query: Record<string, QueryValue> = {};
        const arrayFormats: Record<string, 'comma' | 'repeat'> = {};
        for (const { key, array } of action.keys) {
          if (input[key] !== undefined) query[key] = input[key] as QueryValue;
          if (array) arrayFormats[key] = array;
        }
        const href = buildNavigationHref({
          destination: action.destination,
          ...(params ? { params } : {}),
          query,
          arrayFormats,
        });
        return {
          success: true,
          message: 'Action executed.',
          uiAction: {
            type: 'glirastes.navigate',
            actionId: GLIRASTES_NAVIGATE_ACTION_ID,
            payload: { href, destination: action.destination, ...(params ? { params } : {}), query },
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Navigation failed' };
      }
    },
  });
}
```

In `src/server/core/index.ts`, replace:

```ts
// ============================================================================

export { zodToCompactDescription } from './zod-compact.js';

// ============================================================================
// Followup Tool
```

with:

```ts
// ============================================================================

export { zodToCompactDescription } from './zod-compact.js';
export {
  uiActionToolToTool,
  type GeneratedUiAction,
  type GeneratedUiToolDefinition,
} from './generated-ui-tool.js';

// ============================================================================
// Followup Tool
```

- [ ] **Step 4: Reserve the `glirastes.*` UI actions for generated tools**

1. In `src/server/core/index.ts`, replace:

```ts
// ============================================================================
// Endpoint Tool Definition → Tool Conversion
// ============================================================================

/**
 * Convert an endpoint tool definition into a Tool.
 * Uses callEndpoint from the ToolContext to execute HTTP requests.
 */
```

with:

```ts
// ============================================================================
// Endpoint Tool Definition → Tool Conversion
// ============================================================================

/**
 * `glirastes.*` UI actions belong to the generated UI tools (`ui.navigate`,
 * `ui.filter.<view>`, `ui.<actionId>`), whose results the chat hands to the
 * app's bridge without asking again. An endpoint result never carries one, so
 * data an endpoint returns can neither navigate nor run a client action past
 * that action's confirmation.
 */
function withoutReservedUiActions(
  uiAction: Record<string, unknown> | Record<string, unknown>[] | undefined,
): Record<string, unknown> | Record<string, unknown>[] | undefined {
  const reserved = (action: Record<string, unknown>): boolean => (
    typeof action.type === 'string' && action.type.startsWith('glirastes.')
  );
  if (Array.isArray(uiAction)) {
    const kept = uiAction.filter((action) => !reserved(action));
    return kept.length > 0 ? kept : undefined;
  }
  return uiAction && !reserved(uiAction) ? uiAction : undefined;
}

/**
 * Convert an endpoint tool definition into a Tool.
 * Uses callEndpoint from the ToolContext to execute HTTP requests.
 */
```

2. In `src/server/core/index.ts`, replace:

```ts
      return {
        success: true,
        ...responseData,
        ...(uiAction ? { uiAction } : {}),
      };
```

with:

```ts
      // The response's own uiAction field never reaches the chat unfiltered.
      const { uiAction: _responseUiAction, ...responseFields } = responseData;
      const resultUiAction = withoutReservedUiActions(uiAction);
      return {
        success: true,
        ...responseFields,
        ...(resultUiAction ? { uiAction: resultUiAction } : {}),
      };
```

In `src/types.ts`, replace:

```ts
  const builtInSchema = z.union([
    runClientActionSchema,
    navigateSchema,
    entityActionSchema, // Fallback — must be last
  ]);
```

with:

```ts
  // Results of the generated UI tools (`ui.navigate`, `ui.filter.<view>`,
  // `ui.<actionId>`). The browser bridge checks the href again, and the app's
  // contract checks a client action payload when it is dispatched.
  const generatedNavigateSchema = z
    .object({
      type: z.literal('glirastes.navigate'),
      actionId: z.literal('glirastes.navigate'),
      payload: z.object({ href: z.string().startsWith('/').max(2_048) }).passthrough(),
    })
    .strict();

  const generatedClientActionSchema = z
    .object({
      type: z.literal('glirastes.action'),
      actionId: z.string().min(1).max(200),
      payload: z.record(z.string(), z.unknown()),
    })
    .strict();

  const builtInSchema = z.union([
    runClientActionSchema,
    navigateSchema,
    generatedNavigateSchema,
    generatedClientActionSchema,
    entityActionSchema, // Fallback — must be last
  ]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/server/core/__tests__/generated-ui-tool.test.ts && bunx vitest run src/server && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  5 passed (5)`; the server suites report `Test Files  40 passed (40)`, `Tests  367 passed (367)` (the existing `output-schema-validation` and `schema-compatibility` endpoint tests included); typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/server/core/__tests__/generated-ui-tool.test.ts src/server/core/generated-ui-tool.ts \
  src/server/core/index.ts src/types.ts
git commit -m "feat(server): run generated navigation, filter and client action tools"
```

### Task 12: Bind generated UI tools at boot

**Files:**
- Modify: `src/runtime/contract-bindings.ts`, `src/runtime/index.ts`
- Test: `src/runtime/contract-bindings.test.ts`

**Interfaces:**
- Consumes: `LocalUiToolBinding` (`src/runtime/local-tool-bindings.ts`, unchanged), `uiActionToolToTool` (Task 11, test only).
- Produces:
  - `GeneratedToolBinding = GeneratedEndpointToolBinding | GeneratedUiToolBinding`; `GeneratedUiToolBinding` has `executionKind: 'ui'` and `actionBindingRef`; both exported from `glirastes/runtime`.
  - `createContractBindings` and `createGeneratedRuntimeSource` return `LocalToolBinding[]`; a UI binding must match the artifact's kind, action binding, fingerprint and schema digests (digests recomputed at boot), else only that tool is disabled (`binding-mismatch`, digest mismatch).

- [ ] **Step 1: Write the failing tests**

1. In `src/runtime/contract-bindings.test.ts`, replace:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppSetupArtifactSchema } from '../contracts/index.js';
import { endpointToolToTool } from '../server/core/index.js';
import {
  createContractBindings,
  createGeneratedRuntimeSource,
  type GeneratedToolBinding,
  type GeneratedToolModule,
} from './contract-bindings.js';
import { createJsonSchemaLike } from './json-schema.js';
import { createLocalSchemaDigest } from './local-tool-bindings.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
```

with:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppSetupArtifactSchema } from '../contracts/index.js';
import { endpointToolToTool, uiActionToolToTool } from '../server/core/index.js';
import {
  createContractBindings,
  createGeneratedRuntimeSource,
  type GeneratedEndpointToolBinding,
  type GeneratedToolBinding,
  type GeneratedToolModule,
  type GeneratedUiToolBinding,
} from './contract-bindings.js';
import { createJsonSchemaLike } from './json-schema.js';
import { createLocalSchemaDigest, materializeManifestToolRegistry } from './local-tool-bindings.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
```

2. In `src/runtime/contract-bindings.test.ts`, replace:

```ts
  warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
});

function binding(index: number, overrides: Partial<GeneratedToolBinding> = {}): GeneratedToolBinding {
  const entry = tools[index]!;
  const input = index === 0 ? inputSchema : jsonInput;
  return {
```

with:

```ts
  warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
});

function binding(index: number, overrides: Partial<GeneratedEndpointToolBinding> = {}): GeneratedToolBinding {
  const entry = tools[index]!;
  const input = index === 0 ? inputSchema : jsonInput;
  return {
```

3. In `src/runtime/contract-bindings.test.ts`, replace:

```ts
    expect(runtime.disabled).toEqual([{ toolId: id('a2'), reason: 'binding-missing' }]);
  });
});
```

with:

```ts
    expect(runtime.disabled).toEqual([{ toolId: id('a2'), reason: 'binding-missing' }]);
  });
});

describe('generated UI tool bindings', () => {
  const navigationInput = createJsonSchemaLike({
    type: 'object',
    properties: { destination: { type: 'string', enum: ['/overview', '/tasks'] } },
    required: ['destination'],
    additionalProperties: false,
  });
  const uiOutput = createJsonSchemaLike({ type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] });
  const UI_ID = id('c1');
  const uiCandidate = {
    toolId: UI_ID, sourceFingerprint: digest('N'), name: 'ui.navigate', description: 'Open a page of this app.',
    modelName: 'ui_navigate', module: 'ui', sharedWith: [], usageHints: ['Open a page of this app.'],
    presentation: { locale: 'en-US', singular: 'Navigation', plural: 'Navigation', approval: 'Open a page' },
    executionKind: 'ui', actionBindingRef: 'glirastes.navigate', allowedRoles: [], operationGroup: 'ui',
    riskClass: 'safe-read', enabled: true, requiresApproval: false,
    inputSchemaDigest: createLocalSchemaDigest(navigationInput), outputSchemaDigest: createLocalSchemaDigest(uiOutput),
  };
  const uiArtifact = AppSetupArtifactSchema.parse({
    ...setupArtifact,
    tools: [uiCandidate],
    planner: { ...setupArtifact.planner, toolIds: [UI_ID] },
  });
  const uiBinding = (overrides: Partial<GeneratedUiToolBinding> = {}): GeneratedToolBinding => ({
    toolId: UI_ID, definitionId: 'ui.navigate', executionKind: 'ui', actionBindingRef: 'glirastes.navigate',
    sourceFingerprint: uiCandidate.sourceFingerprint, inputSchemaDigest: uiCandidate.inputSchemaDigest,
    outputSchemaDigest: uiCandidate.outputSchemaDigest, inputSchema: navigationInput, outputSchema: uiOutput,
    tool: uiActionToolToTool({
      id: 'ui.navigate', toolName: 'ui_navigate', description: 'Open a page of this app.',
      inputSchema: navigationInput, needsApproval: false, action: { kind: 'navigate' },
    }),
    ...overrides,
  });
  const uiModule = (bindings: GeneratedToolBinding[]): GeneratedToolModule => ({ setupArtifact: uiArtifact, createToolBindings: () => bindings });

  it('binds a UI tool and runs it through the standalone registry', async () => {
    const runtime = createGeneratedRuntimeSource(uiModule([uiBinding()]), { localLimits: limits, identity: { tenantId: TENANT } });
    expect(runtime.disabled).toEqual([]);
    expect(runtime.bindings).toEqual([expect.objectContaining({ executionKind: 'ui', actionBindingRef: 'glirastes.navigate' })]);
    const snapshot = runtime.source.resolveTurnSnapshot({
      turnId: 'turn-ui',
      principal: { subjectId: 'alice', tenantId: TENANT, roles: ['member'], attributes: {} },
    });
    const registry = materializeManifestToolRegistry({ snapshot, bindings: runtime.bindings });
    expect(await registry.ui_navigate!.execute({ destination: '/overview' }, {} as never)).toMatchObject({
      success: true,
      uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } },
    });
  });

  it('disables a UI tool whose action binding or kind differs', () => {
    expect(createContractBindings(uiModule([uiBinding({ actionBindingRef: 'native.navigate' })])).disabled)
      .toEqual([{ toolId: UI_ID, reason: 'binding-mismatch' }]);
    const asEndpoint = { ...binding(0), toolId: UI_ID, sourceFingerprint: uiCandidate.sourceFingerprint };
    expect(createContractBindings(uiModule([asEndpoint])).disabled)
      .toEqual([{ toolId: UI_ID, reason: 'binding-mismatch' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/contract-bindings.test.ts`
Expected: FAIL — the enabled UI tool is disabled as `binding-mismatch` because the binder only knows endpoints. `Test Files  1 failed (1)`, `Tests  1 failed | 4 passed (5)`

- [ ] **Step 3: Bind both kinds**

1. In `src/runtime/contract-bindings.ts`, replace:

```ts
  type LocalRuntimeSource,
  type LocalRuntimeSourceOptions,
} from './local-runtime-source.js';
import { createLocalSchemaDigest, type LocalEndpointToolBinding } from './local-tool-bindings.js';

/** One entry of `createToolBindings()` in the generated module. */
export interface GeneratedToolBinding {
  readonly toolId: string;
  readonly definitionId: string;
  readonly executionKind: 'endpoint';
  readonly method: EndpointMethod;
  readonly path: string;
  readonly sourceFingerprint: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
```

with:

```ts
  type LocalRuntimeSource,
  type LocalRuntimeSourceOptions,
} from './local-runtime-source.js';
import { createLocalSchemaDigest, type LocalToolBinding } from './local-tool-bindings.js';

interface GeneratedToolBindingBase {
  readonly toolId: string;
  readonly definitionId: string;
  readonly sourceFingerprint: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
```

2. In `src/runtime/contract-bindings.ts`, replace:

```ts
  readonly tool: Tool;
}

/** The shape of `src/generated/glirastes/tools.generated.ts`. */
export interface GeneratedToolModule {
  readonly setupArtifact: unknown;
```

with:

```ts
  readonly tool: Tool;
}

export interface GeneratedEndpointToolBinding extends GeneratedToolBindingBase {
  readonly executionKind: 'endpoint';
  readonly method: EndpointMethod;
  readonly path: string;
}

/** Navigation, filter and client action tools; they run in the browser. */
export interface GeneratedUiToolBinding extends GeneratedToolBindingBase {
  readonly executionKind: 'ui';
  readonly actionBindingRef: string;
}

/** One entry of `createToolBindings()` in the generated module. */
export type GeneratedToolBinding = GeneratedEndpointToolBinding | GeneratedUiToolBinding;

/** The shape of `src/generated/glirastes/tools.generated.ts`. */
export interface GeneratedToolModule {
  readonly setupArtifact: unknown;
```

3. In `src/runtime/contract-bindings.ts`, replace:

```ts

export interface ContractBindingsResult {
  setupArtifact: AppSetupArtifact;
  bindings: LocalEndpointToolBinding[];
  disabled: Array<{ toolId: string; reason: ContractBindingDisabledReason }>;
}

```

with:

```ts

export interface ContractBindingsResult {
  setupArtifact: AppSetupArtifact;
  bindings: LocalToolBinding[];
  disabled: Array<{ toolId: string; reason: ContractBindingDisabledReason }>;
}

```

4. In `src/runtime/contract-bindings.ts`, replace:

```ts
  return left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0;
}

/**
 * Recomputes every schema digest from the live schema objects at boot and
 * disables only tools whose binding is missing or differs from the artifact.
```

with:

```ts
  return left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0;
}

type ArtifactTool = AppSetupArtifact['tools'][number];

/** Same kind, same route or action binding, same fingerprint and digests. */
function sameBinding(candidate: ArtifactTool, binding: GeneratedToolBinding): boolean {
  if (
    candidate.sourceFingerprint !== binding.sourceFingerprint
    || candidate.inputSchemaDigest !== binding.inputSchemaDigest
    || candidate.outputSchemaDigest !== binding.outputSchemaDigest
  ) {
    return false;
  }
  if (binding.executionKind === 'endpoint') {
    return candidate.executionKind === 'endpoint'
      && candidate.method === binding.method
      && candidate.path === binding.path;
  }
  return candidate.executionKind === 'ui'
    && candidate.actionBindingRef === binding.actionBindingRef;
}

function toLocalBinding(binding: GeneratedToolBinding): LocalToolBinding {
  const common = {
    toolId: binding.toolId,
    sourceFingerprint: binding.sourceFingerprint,
    inputSchemaDigest: binding.inputSchemaDigest,
    outputSchemaDigest: binding.outputSchemaDigest,
    tool: binding.tool,
  };
  return binding.executionKind === 'endpoint'
    ? { ...common, executionKind: 'endpoint', method: binding.method, path: binding.path }
    : { ...common, executionKind: 'ui', actionBindingRef: binding.actionBindingRef };
}

/**
 * Recomputes every schema digest from the live schema objects at boot and
 * disables only tools whose binding is missing or differs from the artifact.
```

5. In `src/runtime/contract-bindings.ts`, replace:

```ts
    grouped.set(binding.toolId, [...grouped.get(binding.toolId) ?? [], binding]);
  }
  const disabled = new Map<string, ContractBindingDisabledReason>();
  const bindings: LocalEndpointToolBinding[] = [];
  for (const [toolId, entries] of grouped) {
    const candidate = candidates.get(toolId);
    if (!candidate?.enabled) continue;
```

with:

```ts
    grouped.set(binding.toolId, [...grouped.get(binding.toolId) ?? [], binding]);
  }
  const disabled = new Map<string, ContractBindingDisabledReason>();
  const bindings: LocalToolBinding[] = [];
  for (const [toolId, entries] of grouped) {
    const candidate = candidates.get(toolId);
    if (!candidate?.enabled) continue;
```

6. In `src/runtime/contract-bindings.ts`, replace:

```ts
      continue;
    }
    const binding = entries[0]!;
    if (
      candidate.executionKind !== 'endpoint'
      || binding.executionKind !== 'endpoint'
      || candidate.method !== binding.method
      || candidate.path !== binding.path
      || candidate.sourceFingerprint !== binding.sourceFingerprint
      || candidate.inputSchemaDigest !== binding.inputSchemaDigest
      || candidate.outputSchemaDigest !== binding.outputSchemaDigest
    ) {
      disabled.set(toolId, 'binding-mismatch');
      continue;
    }
```

with:

```ts
      continue;
    }
    const binding = entries[0]!;
    if (!sameBinding(candidate, binding)) {
      disabled.set(toolId, 'binding-mismatch');
      continue;
    }
```

7. In `src/runtime/contract-bindings.ts`, replace:

```ts
      disabled.set(toolId, 'output-schema-digest-mismatch');
      continue;
    }
    bindings.push({
      toolId,
      executionKind: 'endpoint',
      method: binding.method,
      path: binding.path,
      sourceFingerprint: binding.sourceFingerprint,
      inputSchemaDigest: binding.inputSchemaDigest,
      outputSchemaDigest: binding.outputSchemaDigest,
      tool: binding.tool,
    });
  }
  for (const tool of artifact.tools) {
    if (tool.enabled && !grouped.has(tool.toolId)) disabled.set(tool.toolId, 'binding-missing');
```

with:

```ts
      disabled.set(toolId, 'output-schema-digest-mismatch');
      continue;
    }
    bindings.push(toLocalBinding(binding));
  }
  for (const tool of artifact.tools) {
    if (tool.enabled && !grouped.has(tool.toolId)) disabled.set(tool.toolId, 'binding-missing');
```

8. In `src/runtime/contract-bindings.ts`, replace:

```ts

export interface GeneratedRuntimeSource {
  source: LocalRuntimeSource;
  bindings: LocalEndpointToolBinding[];
  disabled: ContractBindingsResult['disabled'];
}

```

with:

```ts

export interface GeneratedRuntimeSource {
  source: LocalRuntimeSource;
  bindings: LocalToolBinding[];
  disabled: ContractBindingsResult['disabled'];
}

```

In `src/runtime/index.ts`, replace:

```ts
  createGeneratedRuntimeSource,
  type ContractBindingDisabledReason,
  type ContractBindingsResult,
  type GeneratedRuntimeSource,
  type GeneratedToolBinding,
  type GeneratedToolModule,
} from './contract-bindings.js';
```

with:

```ts
  createGeneratedRuntimeSource,
  type ContractBindingDisabledReason,
  type ContractBindingsResult,
  type GeneratedEndpointToolBinding,
  type GeneratedRuntimeSource,
  type GeneratedToolBinding,
  type GeneratedToolModule,
  type GeneratedUiToolBinding,
} from './contract-bindings.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/contract-bindings.test.ts && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  5 passed (5)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/contract-bindings.test.ts src/runtime/contract-bindings.ts src/runtime/index.ts
git commit -m "feat(runtime): bind generated ui tools at boot"
```


### Task 13: UI contracts in `tool-contracts.json` and the generated module

**Files:**
- Modify: `src/codegen/tools/types.ts` (`ToolContract.uiAction`, `ObservedTool.evidence.uiMutation`), `src/codegen/tools/files.ts` (schema of `uiAction`), `src/codegen/tools/emit-module.ts` (UI bindings), `src/codegen/tools/artifact.ts` (UI schema quality), `src/codegen/tools/prose.ts` (UI template words), `src/codegen/tools/findings.ts` (next actions of the UI findings), `src/codegen/tools/pipeline.ts` (passes `uiMutation` to the defaults)
- Test: `src/codegen/tools/emit-module.test.ts`, `src/codegen/tools/artifact.test.ts`, `src/codegen/tools/prose.test.ts`

**Interfaces:**
- Consumes: `GeneratedUiAction`, `uiActionToolToTool` (Task 11), `GeneratedUiToolBinding` (Task 12), P02 `deriveToolPolicyDefaults` (`evidence.uiMutation`).
- Produces:
  - `ToolContract.uiAction?: GeneratedUiAction` (UI tools only; persisted in `tool-contracts.json`, so integrity mode re-renders the module from committed files); `ObservedTool.evidence.uiMutation?: boolean`.
  - `renderGeneratedModule` binds every enabled tool: endpoint bindings exactly as before, UI tools as `{ ...toolCatalog[i], inputSchema, outputSchema, tool: uiActionToolToTool({ id, toolName, description, inputSchema, needsApproval, action }) }`; catalog entries of UI tools carry `actionBindingRef` instead of `method`/`path`; an enabled UI tool without `uiAction` throws.
  - `schemaQualityOf` grades `ui-bridge` contracts with a JSON runtime input as `json-schema`.
  - The template of a UI tool names it after everything behind `ui.` (`Run task details open.`), never "Run ui".
  - `nextActionFor` knows the codes `navigation-bridge-missing`, `page-path-duplicated`, `filter-domain-open`, `filter-domain-conflict`, `filter-parser-unsupported`, `filter-definition-unreadable`, `filter-key-reserved`, `ui-action-payload-untyped`, `ui-action-contract-conflict`, `ui-action-id-dynamic`, `ui-action-id-invalid`, `ui-action-id-reserved`.

- [ ] **Step 1: Write the failing tests**

In `src/codegen/tools/emit-module.test.ts`, replace:

```ts
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});
```

with:

```ts
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});

describe('renderGeneratedModule with UI tools', () => {
  const NAVIGATE = {
    type: 'object',
    properties: { destination: { type: 'string', enum: ['/overview', '/tasks'] } },
    required: ['destination'],
    additionalProperties: false,
  };
  const FILTER = {
    type: 'object',
    properties: { status: { type: 'string', enum: ['done', 'open'] } },
    additionalProperties: false,
  };
  const RESULT = { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] };
  const uiCandidate = (toolId: string, name: string) => ({
    toolId, sourceFingerprint: digest(name === 'ui.navigate' ? 'N' : 'L'), name, description: `Run ${name}.`,
    modelName: name.replace(/\./g, '_'), module: 'ui', sharedWith: [], usageHints: [`Run ${name}.`],
    presentation: { locale: 'en-US', singular: name, plural: name, approval: name },
    executionKind: 'ui', actionBindingRef: 'glirastes.navigate', allowedRoles: [], operationGroup: 'ui',
    riskClass: 'safe-read', enabled: true, requiresApproval: false, inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  });
  const uiArtifact = AppSetupArtifactSchema.parse({
    ...artifact,
    tools: [artifact.tools[0], uiCandidate(id('c1'), 'ui.navigate'), uiCandidate(id('c2'), 'ui.filter.tasks')],
    planner: { ...artifact.planner, toolIds: [id('a1'), id('c1'), id('c2')] },
  });
  const uiDefaults = { operationGroup: 'ui' as const, riskClass: 'safe-read' as const, requiresApproval: false, rulesVersion: 1 as const };
  const uiContract = (input: Record<string, unknown>, uiAction: NonNullable<ToolContract['uiAction']>): ToolContract => ({
    source: 'ui-bridge', loadBearing: true, input, output: RESULT, params: { path: [], query: [], body: [] },
    interfaceDigest: digest('U'), runtime: { input: { kind: 'json', schema: input }, output: { kind: 'json', schema: RESULT } },
    uiAction,
  });
  const uiContracts = (schemaModule: string): ToolContractsEntry[] => [
    contracts(schemaModule)[0]!,
    {
      toolId: id('c1'), stableKey: 'UI navigate', definitionId: 'ui.navigate', defaults: uiDefaults,
      contract: uiContract(NAVIGATE, { kind: 'navigate' }),
    },
    {
      toolId: id('c2'), stableKey: 'UI filter /tasks', definitionId: 'ui.filter.tasks', defaults: uiDefaults,
      contract: uiContract(FILTER, { kind: 'filter', destination: '/tasks', keys: [{ key: 'status' }] }),
    },
  ];

  it('binds navigation and filter tools through uiActionToolToTool with their action', () => {
    const text = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.js', artifact: uiArtifact, contracts: uiContracts('src/app/api/notes/schemas.js'),
    });
    expect(text).toContain("import { endpointToolToTool, uiActionToolToTool } from 'glirastes/server';");
    expect(text).toContain('"actionBindingRef": "glirastes.navigate"');
    expect(text).toContain('"kind": "filter"');
    expect(text.match(/uiActionToolToTool\(\{/g)).toHaveLength(2);
    const output = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(output.diagnostics ?? []).toEqual([]);
  });

  it('refuses an enabled UI tool without its action instead of emitting a dead binding', () => {
    const broken = uiContracts('src/a.ts').map((entry) => (
      entry.toolId === id('c1') ? { ...entry, contract: { ...entry.contract!, uiAction: undefined } } : entry
    ));
    expect(() => renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: uiArtifact, contracts: broken }))
      .toThrow('Enabled UI tool ui.navigate has no UI action to bind.');
  });

  it('type-checks UI bindings under strict TypeScript against the SDK runtime surface', async () => {
    const generated = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: uiArtifact, contracts: uiContracts('src/app/api/notes/schemas.ts'),
    });
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
          paths: {
            'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
            'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
          },
        },
      }),
      'src/app/api/notes/schemas.ts': "import { z } from 'zod';\n"
        + 'export const createNote = z.object({ title: z.string() }).strict();\n',
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import { createContractBindings } from 'glirastes/runtime';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const bound = createContractBindings(generated);\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
    const files = [app.path('src/consumer.ts'), app.path('src/generated/glirastes/tools.generated.ts')];
    const program = ts.createProgram(files, parsed.options);
    const diagnostics = files.flatMap((file) => program.getSemanticDiagnostics(program.getSourceFile(file)));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});
```

In `src/codegen/tools/artifact.test.ts`, replace:

```ts
    expect(plain.artifact).not.toHaveProperty('exclusions');
  });
});
```

with:

```ts
    expect(plain.artifact).not.toHaveProperty('exclusions');
  });
});

describe('UI tool contracts', () => {
  const uiContract: ToolContract = {
    source: 'ui-bridge', loadBearing: true,
    input: { type: 'object', properties: { destination: { type: 'string', enum: ['/tasks'] } }, additionalProperties: false },
    params: { path: [], query: [], body: [] }, interfaceDigest: digest('U'),
    runtime: {
      input: { kind: 'json', schema: { type: 'object' } },
      output: { kind: 'json', schema: { type: 'object' } },
    },
    uiAction: { kind: 'filter', destination: '/projects/:projectId/tasks', keys: [{ key: 'status' }, { key: 'tags', array: 'repeat' }] },
  };
  const file = (contract: unknown) => ({
    schemaVersion: 1, appId: APP_ID,
    tools: [{
      toolId: '019fb007-0000-7000-8000-0000000000c1', stableKey: 'UI filter /projects/:projectId/tasks', definitionId: 'ui.filter.projectsTasks',
      contract, defaults: { operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    }],
  });

  it('keeps the UI action in tool-contracts.json so integrity mode can re-render the module', () => {
    expect(ToolContractsFileSchema.parse(JSON.parse(renderToolContracts(APP_ID, file(uiContract).tools as never))).tools[0]?.contract)
      .toEqual(uiContract);
  });

  it.each([
    ['an unknown kind', { kind: 'open-dialog' }],
    ['a filter without keys', { kind: 'filter', destination: '/tasks' }],
    ['an unknown array format', { kind: 'filter', destination: '/tasks', keys: [{ key: 'tags', array: 'pipe' }] }],
    ['a client action without id', { kind: 'client-action' }],
  ])('rejects %s', (_label, uiAction) => {
    expect(ToolContractsFileSchema.safeParse(file({ ...uiContract, uiAction })).success).toBe(false);
  });

  it('grades UI schemas read from code as JSON Schema', () => {
    expect(schemaQualityOf(uiContract)).toBe('json-schema');
  });
});
```

In `src/codegen/tools/prose.test.ts`, replace:

```ts
    expect(partial.semantics.byName.get('tasks.create')?.description).toBe('Kept.');
  });
});
```

with:

```ts
    expect(partial.semantics.byName.get('tasks.create')?.description).toBe('Kept.');
  });
});

describe('tool prose for UI tools', () => {
  it('names a client action template after its id, not after the ui namespace', () => {
    const prose = resolveToolProse({
      stableKey: 'UI action task-details.open',
      definitionId: 'ui.taskDetails.open',
      operationGroup: 'ui',
      locale: 'en-US',
      semantics: EMPTY_SEMANTICS,
    });
    expect(prose).toMatchObject({
      description: 'Run task details open.',
      descriptionOrigin: 'template',
      module: 'ui',
      presentation: { singular: 'Run task details open' },
      findings: [expect.objectContaining({ code: 'description-templated' })],
    });
    expect(resolveToolProse({
      stableKey: 'UI action tasks.highlight', definitionId: 'ui.tasks.highlight', operationGroup: 'ui',
      locale: 'de-DE', semantics: EMPTY_SEMANTICS,
    }).description).toBe('Tasks highlight ausführen.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/artifact.test.ts src/codegen/tools/emit-module.test.ts src/codegen/tools/prose.test.ts`
Expected: FAIL — the module ignores UI tools, the contracts file refuses `uiAction`, `ui-bridge` grades as `zod`, and the template reads "Run ui.". `Test Files  3 failed (3)`, `Tests  5 failed | 35 passed (40)`

- [ ] **Step 3: Carry the UI action in the contract types and file**

1. In `src/codegen/tools/types.ts`, replace:

```ts
import type { ToolPresentation } from '../../contracts/index.js';
import type { DeclaredEffect, ToolPolicyDefaults, ToolPolicyFile } from '../../contracts/tool-policy.js';
import type { LocalJsonSchema } from '../../runtime/json-schema.js';
import type { ExecutionGenerationState, ObservedExecution } from '../inventory-generation.js';
import type { ToolsConfig } from './config.js';
import type { ToolResolutions } from './resolutions.js';
```

with:

```ts
import type { ToolPresentation } from '../../contracts/index.js';
import type { DeclaredEffect, ToolPolicyDefaults, ToolPolicyFile } from '../../contracts/tool-policy.js';
import type { LocalJsonSchema } from '../../runtime/json-schema.js';
import type { GeneratedUiAction } from '../../server/core/generated-ui-tool.js';
import type { ExecutionGenerationState, ObservedExecution } from '../inventory-generation.js';
import type { ToolsConfig } from './config.js';
import type { ToolResolutions } from './resolutions.js';
```

2. In `src/codegen/tools/types.ts`, replace:

```ts
  interfaceDigest: string;
  runtime: { input: RuntimeSchemaSource; output: RuntimeSchemaSource };
  binding?: ContractBinding;
}

export interface ToolProseHints {
```

with:

```ts
  interfaceDigest: string;
  runtime: { input: RuntimeSchemaSource; output: RuntimeSchemaSource };
  binding?: ContractBinding;
  /** UI tools only: what the generated tool asks the app's browser bridge to do. */
  uiAction?: GeneratedUiAction;
}

export interface ToolProseHints {
```

3. In `src/codegen/tools/types.ts`, replace:

```ts
    externalCall: boolean;
    declaredEffect?: DeclaredEffect;
    jsDoc?: string;
  };
  findings: ToolFinding[];
  prose?: ToolProseHints;
```

with:

```ts
    externalCall: boolean;
    declaredEffect?: DeclaredEffect;
    jsDoc?: string;
    /** UI tools only: the handler provably writes, e.g. a non-GET fetch. */
    uiMutation?: boolean;
  };
  findings: ToolFinding[];
  prose?: ToolProseHints;
```

1. In `src/codegen/tools/files.ts`, replace:

```ts
  z.object({ kind: z.literal('json'), schema: JsonObjectSchema }).strict(),
]);

export const ToolContractSchema = z.object({
  source: z.enum([
    'native', 'contract-module', 'legacy-ai-tool', 'resolution', 'openapi', 'derived', 'ui-bridge',
```

with:

```ts
  z.object({ kind: z.literal('json'), schema: JsonObjectSchema }).strict(),
]);

const GeneratedUiActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate') }).strict(),
  z.object({
    kind: z.literal('filter'),
    destination: z.string().min(1).max(2_048),
    keys: z.array(z.object({
      key: z.string().min(1).max(64),
      array: z.enum(['comma', 'repeat']).optional(),
    }).strict()).max(50),
  }).strict(),
  z.object({ kind: z.literal('client-action'), actionId: z.string().min(1).max(200) }).strict(),
]);

export const ToolContractSchema = z.object({
  source: z.enum([
    'native', 'contract-module', 'legacy-ai-tool', 'resolution', 'openapi', 'derived', 'ui-bridge',
```

2. In `src/codegen/tools/files.ts`, replace:

```ts
    interfaceDigest: digest,
    contractModuleDigest: digest,
  }).strict().optional(),
}).strict();

const ToolPolicyDefaultsSchema = z.object({
```

with:

```ts
    interfaceDigest: digest,
    contractModuleDigest: digest,
  }).strict().optional(),
  uiAction: GeneratedUiActionSchema.optional(),
}).strict();

const ToolPolicyDefaultsSchema = z.object({
```

In `src/codegen/tools/artifact.ts`, replace:

```ts
    case 'native':
    case 'contract-module':
    case 'legacy-ai-tool':
    case 'ui-bridge':
      return 'zod';
    case 'openapi':
      return 'openapi';
    case 'derived':
```

with:

```ts
    case 'native':
    case 'contract-module':
    case 'legacy-ai-tool':
      return 'zod';
    case 'ui-bridge':
      // Pages, URL parsers and payload types are read from code as JSON Schema.
      return contract.runtime.input.kind === 'module-export' ? 'zod' : 'json-schema';
    case 'openapi':
      return 'openapi';
    case 'derived':
```

- [ ] **Step 4: Emit UI bindings**

Replace the whole content of `src/codegen/tools/emit-module.ts` with:

```ts
import { posix } from 'node:path';
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits, sortKeysDeep } from './canonical.js';
import type { RuntimeSchemaSource, ToolContract, ToolContractsEntry } from './types.js';

export interface RenderGeneratedModuleInput {
  modulePath: string;
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function accessor(name: string): string {
  return IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function importSpecifier(fromModule: string, target: string, typescript: boolean): string {
  let specifier = posix.relative(posix.dirname(fromModule), target);
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return typescript ? specifier.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '') : specifier;
}

function literal(value: unknown, indent = 0): string {
  const text = JSON.stringify(sortKeysDeep(value), null, 2);
  return indent > 0 ? text.replace(/\n/g, `\n${' '.repeat(indent)}`) : text;
}

type ArtifactTool = AppSetupArtifact['tools'][number];

function catalogEntry(tool: ArtifactTool): Record<string, unknown> {
  const common = {
    toolId: tool.toolId,
    definitionId: tool.name,
    modelName: tool.modelName ?? tool.name.replace(/\./g, '_'),
    executionKind: tool.executionKind,
    sourceFingerprint: tool.sourceFingerprint,
    inputSchemaDigest: tool.inputSchemaDigest,
    outputSchemaDigest: tool.outputSchemaDigest,
    description: tool.description,
    riskClass: tool.riskClass,
    requiresApproval: tool.requiresApproval,
  };
  return tool.executionKind === 'endpoint'
    ? { ...common, method: tool.method, path: tool.path }
    : { ...common, actionBindingRef: tool.actionBindingRef };
}

/** Pure function of artifact, contracts and module path; integrity mode re-renders it byte for byte. */
export function renderGeneratedModule(input: RenderGeneratedModuleInput): string {
  const typescript = input.modulePath.endsWith('.ts');
  const contractsById = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools = input.artifact.tools
    .filter((tool) => tool.enabled)
    .sort((left, right) => compareCodeUnits(left.toolId, right.toolId));
  const bound = tools.map((tool) => {
    const contract: ToolContract | null | undefined = contractsById.get(tool.toolId)?.contract;
    if (!contract) throw new Error(`Enabled tool ${tool.name} has no contract to bind.`);
    if (tool.executionKind === 'ui' && !contract.uiAction) {
      throw new Error(`Enabled UI tool ${tool.name} has no UI action to bind.`);
    }
    return { tool, contract };
  });
  const modules = [...new Set(bound
    .flatMap(({ contract }) => [contract.runtime.input, contract.runtime.output])
    .flatMap((source) => (source.kind === 'module-export' ? [source.module] : [])))]
    .sort(compareCodeUnits);
  const aliases = new Map(modules.map((module, index) => [module, `m${index}`] as const));
  const usesJson = bound.some(({ contract }) => contract.runtime.input.kind === 'json' || contract.runtime.output.kind === 'json');
  const usesEndpoints = bound.some(({ tool }) => tool.executionKind === 'endpoint');
  const usesUi = bound.some(({ tool }) => tool.executionKind === 'ui');
  const expression = (source: RuntimeSchemaSource): string => (source.kind === 'json'
    ? `createJsonSchemaLike(${literal(source.schema, 2)})`
    : `${aliases.get(source.module)!}${[source.export, ...source.property].map(accessor).join('')}`);
  const serverImports = [
    ...(usesEndpoints ? ['endpointToolToTool'] : []),
    ...(usesUi ? ['uiActionToolToTool'] : []),
  ];

  const lines: string[] = [
    '// @generated by `glirastes tools refresh`. Do not edit; rerun the command after code changes.',
    '/* eslint-disable */',
  ];
  if (usesJson) lines.push("import { createJsonSchemaLike } from 'glirastes/runtime';");
  if (serverImports.length > 0) lines.push(`import { ${serverImports.join(', ')} } from 'glirastes/server';`);
  for (const module of modules) {
    lines.push(`import * as ${aliases.get(module)!} from ${JSON.stringify(importSpecifier(input.modulePath, module, typescript))};`);
  }
  lines.push(
    '',
    `export const setupArtifact = ${literal(input.artifact)};`,
    '',
    `export const toolCatalog = ${literal(tools.map(catalogEntry))}${typescript ? ' as const' : ''};`,
    '',
  );
  if (typescript) {
    lines.push(`export type GeneratedToolId = ${tools.length > 0
      ? tools.map((tool) => JSON.stringify(tool.toolId)).join(' | ')
      : 'never'};`, '');
  }
  lines.push('export function createToolBindings() {');
  if (bound.length === 0) {
    lines.push('  return [];');
  } else {
    bound.forEach(({ contract }, index) => {
      lines.push(`  const input${index} = ${expression(contract.runtime.input)};`);
      lines.push(`  const output${index} = ${expression(contract.runtime.output)};`);
    });
    lines.push('  return [');
    bound.forEach(({ tool, contract }, index) => {
      const entry = `toolCatalog[${index}]`;
      const shared = [
        `        id: ${entry}.definitionId,`,
        `        toolName: ${entry}.modelName,`,
        `        description: ${entry}.description,`,
      ];
      const toolExpression = tool.executionKind === 'endpoint'
        ? [
          '      tool: endpointToolToTool({',
          ...shared,
          `        method: ${entry}.method,`,
          `        path: ${entry}.path,`,
          `        inputSchema: input${index},`,
          ...(contract.runtime.output.kind === 'module-export' ? [`        outputSchema: output${index},`] : []),
          `        needsApproval: ${entry}.requiresApproval,`,
          '      }),',
        ]
        : [
          '      tool: uiActionToolToTool({',
          ...shared,
          `        inputSchema: input${index},`,
          `        needsApproval: ${entry}.requiresApproval,`,
          `        action: ${literal(contract.uiAction, 8)},`,
          '      }),',
        ];
      lines.push(
        '    {',
        `      ...${entry},`,
        `      inputSchema: input${index},`,
        `      outputSchema: output${index},`,
        ...toolExpression,
        '    },',
      );
    });
    lines.push('  ];');
  }
  lines.push('}', '');
  return lines.join('\n');
}
```

- [ ] **Step 5: UI prose, finding actions and the write escalation**

1. In `src/codegen/tools/prose.ts`, replace:

```ts
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function resourceWords(definitionId: string): string {
  const resource = definitionId.split('.')[0] ?? definitionId;
  return resource
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
```

with:

```ts
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The resource of an endpoint tool; everything after `ui.` for a UI tool. */
function resourceWords(definitionId: string, operation: Operation): string {
  const resource = operation === 'ui'
    ? definitionId.split('.').slice(1).join(' ')
    : definitionId.split('.')[0] ?? definitionId;
  return resource
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
```

2. In `src/codegen/tools/prose.ts`, replace:

```ts
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
  const language = input.locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  const label = labelOf(language, operationOf(input.operationGroup, input.path), resourceWords(input.definitionId));
  const candidates: ReadonlyArray<readonly [string | undefined, DescriptionOrigin]> = [
    [input.policyDescription, 'human'],
    [input.jsDoc, 'code'],
```

with:

```ts
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
  const language = input.locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  const operation = operationOf(input.operationGroup, input.path);
  const label = labelOf(language, operation, resourceWords(input.definitionId, operation));
  const candidates: ReadonlyArray<readonly [string | undefined, DescriptionOrigin]> = [
    [input.policyDescription, 'human'],
    [input.jsDoc, 'code'],
```

In `src/codegen/tools/findings.ts`, replace:

```ts
  'integrity-chain-broken': 'Regenerate the outputs with glirastes tools refresh and commit them; never edit generated files.',
  'output-path-linked': 'Replace the linked .glirastes or output folder with a real folder inside the app.',
  'setup-plan-invalid': 'Delete .glirastes/previous-setup-artifact.json left by glirastes setup; git keeps the history.',
};

/**
```

with:

```ts
  'integrity-chain-broken': 'Regenerate the outputs with glirastes tools refresh and commit them; never edit generated files.',
  'output-path-linked': 'Replace the linked .glirastes or output folder with a real folder inside the app.',
  'setup-plan-invalid': 'Delete .glirastes/previous-setup-artifact.json left by glirastes setup; git keeps the history.',
  'navigation-bridge-missing': 'Call useGlirastesNavigationBridge({ push: router.push }) (glirastes/react) or registerNavigationBridge({ push }) (glirastes/browser) in code that is always mounted, then run glirastes tools refresh.',
  'page-path-duplicated': 'Keep one page per path; navigation uses the first page file in code-unit order.',
  'filter-domain-open': 'Optional: give the URL parameter a closed domain, e.g. parseAsStringLiteral([...]) or a defineQueryFilters value list.',
  'filter-domain-conflict': 'Read the URL parameter with one parser on the page and its components.',
  'filter-parser-unsupported': 'Use parseAsString, parseAsInteger, parseAsFloat, parseAsBoolean, parseAsStringLiteral or parseAsArrayOf for parameters the chat may set.',
  'filter-definition-unreadable': 'Write the filter key, path and values as literals so glirastes tools refresh can read them.',
  'filter-key-reserved': 'Rename the URL parameter; params is reserved for route parameters of the filtered page.',
  'ui-action-payload-untyped': 'Pass a payload contract (e.g. a Zod object) as the third argument of useAiClientAction or registerAiClientAction, or type the handler parameter.',
  'ui-action-contract-conflict': 'Register the action with one payload contract wherever it is handled.',
  'ui-action-id-dynamic': 'Register client actions with a literal id so the chat can call them.',
  'ui-action-id-invalid': 'Use an action id of letters, digits, dots and dashes, e.g. tasks.highlight.',
  'ui-action-id-reserved': 'Ids starting with glirastes. belong to the SDK; choose another action id.',
};

/**
```

In `src/codegen/tools/pipeline.ts`, replace:

```ts
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      definitionId: execution.definitionId,
      ...(tool.evidence.declaredEffect ? { declaredEffect: tool.evidence.declaredEffect } : {}),
      evidence: { externalCall: tool.evidence.externalCall },
    });
    const local = (inputs.policy.tools ?? {})[execution.stableKey];
    const acceptedRisk = (inputs.policy.acceptedRisk ?? {})[execution.stableKey];
```

with:

```ts
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      definitionId: execution.definitionId,
      ...(tool.evidence.declaredEffect ? { declaredEffect: tool.evidence.declaredEffect } : {}),
      evidence: {
        externalCall: tool.evidence.externalCall,
        ...(tool.evidence.uiMutation ? { uiMutation: true } : {}),
      },
    });
    const local = (inputs.policy.tools ?? {})[execution.stableKey];
    const acceptedRisk = (inputs.policy.acceptedRisk ?? {})[execution.stableKey];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/artifact.test.ts src/codegen/tools/emit-module.test.ts src/codegen/tools/prose.test.ts && bunx vitest run src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline-integrity.test.ts && bun run typecheck`
Expected: PASS — the three files report `Test Files  3 passed (3)`, `Tests  40 passed (40)`; the pipeline suites report `Test Files  2 passed (2)`, `Tests  24 passed (24)`; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/artifact.test.ts src/codegen/tools/artifact.ts src/codegen/tools/emit-module.test.ts \
  src/codegen/tools/emit-module.ts src/codegen/tools/files.ts src/codegen/tools/findings.ts \
  src/codegen/tools/pipeline.ts src/codegen/tools/prose.test.ts src/codegen/tools/prose.ts \
  src/codegen/tools/types.ts
git commit -m "feat(codegen): emit generated ui tools from their contracts"
```

### Task 14: Read app pages and UI registrations from source

**Files:**
- Create: `src/codegen/tools/sources/app-files.ts` (bounded scan of app sources), `src/codegen/tools/sources/page-tree.ts` (Next.js page tree), `src/codegen/tools/sources/ui-tools.ts` (names, import reading, bridge detection, UI observations)
- Modify: `src/contracts/tool-exclude-pattern.ts` (`PAGE` patterns), `src/codegen/tools/findings.ts` (`E-INVENTORY-011` action also names pages and UI actions)
- Test: `src/codegen/tools/sources/page-tree.test.ts`, `src/codegen/tools/sources/ui-tools.test.ts` (Create), `src/contracts/__tests__/tool-exclude-pattern.test.ts`

**Interfaces:**
- Consumes: `matchesExcludePattern`, `PolicyExcludeRule` (`exclusions.ts`), `TOOL_NAME_PATTERN`, `jsonSchemaDigest`, `OPAQUE_SCHEMA_DIGEST`, `toolFinding`, `__tests__/app-fixture.ts`.
- Produces:
  - `app-files.ts`: `MAX_APP_SOURCE_FILES = 20_000`, `MAX_APP_SOURCE_BYTES = 2_000_000`, `interface AppSourceFile { path; absolute; source }`, `type AppSourceScan = { complete: true; files } | { complete: false; reason }`, `defaultSourceDir(root)`, `scanAppSources(root, { srcDir?, matches(source) })` — skips dot folders, `node_modules`, `dist`, `build`, `out`, `coverage`, `generated` and `.d.ts`; a link, an oversized file or too many files make the scan incomplete.
  - `page-tree.ts`: `interface PageEntry { path; params; file }`, `type PageTree`, `interface PageTreeOptions { appDir?; stripSegments? }`, `pageStableKey(path)` (`PAGE /tasks`), `defaultAppDir(root)`, `pathExclusion(path, policyExcludes)` (default rule or policy exclusion of an app path, shared with `defineQueryFilters` views in Task 16), `enumeratePages(root, options, policyExcludes): Promise<PageTree>`.
  - `ui-tools.ts`: `NAVIGATE_ACTION_BINDING`, `NAVIGATE_STABLE_KEY`, `NAVIGATE_DEFINITION_ID`, `filterStableKey(path)`, `actionStableKey(actionId)`, `UI_TOOL_OUTPUT_SCHEMA`, `viewName(path)`, `uiDefinitionIdForAction(actionId)`, `uniqueDefinitionIds(entries)`, `parseAppSource(file)`, `interface ImportSpec`, `interface ImportBindings`, `importBindings(source, specs)`, `importedName(node, bindings)`, `interface ImportedCall`, `importedCalls(source, specs)`, `hasNavigationBridge(files)`, `mentionsNavigationBridge(source)`, `interface UiObservationInput`, `uiObservation(input): ObservedTool`, `incompleteUiSource(kind, reason): ToolSourceObservation`.
  - `parseExcludePattern` accepts `PAGE /path` (pages are matched as method `PAGE`, so `* /admin/**` excludes them as well).

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/sources/page-tree.test.ts`:

```ts
import { mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from '../__tests__/app-fixture.js';
import { enumeratePages } from './page-tree.js';

afterEach(removeAppFixtures);

const PAGE = 'export default function Page() { return null; }\n';

describe('enumeratePages', () => {
  it('maps the app tree to destinations and gives every left-out page a reason', async () => {
    const app = await createAppFixture({
      'src/app/page.tsx': PAGE,
      'src/app/(dashboard)/tasks/page.tsx': PAGE,
      'src/app/(dashboard)/tasks/[taskId]/page.tsx': PAGE,
      'src/app/[locale]/overview/page.jsx': PAGE,
      'src/app/@modal/settings/page.tsx': PAGE,
      'src/app/@modal/(.)tasks/[taskId]/page.tsx': PAGE,
      'src/app/_components/page.tsx': PAGE,
      'src/app/api/tasks/page.tsx': PAGE,
      'src/app/docs/[...slug]/page.mdx': PAGE,
      'src/app/login/page.tsx': PAGE,
      'src/app/auth/callback/page.tsx': PAGE,
      'src/app/mcp/page.tsx': PAGE,
      'src/app/admin/users/page.tsx': PAGE,
      'src/app/tasks/layout.tsx': 'export default function Layout() { return null; }\n',
    });
    const tree = await enumeratePages(app.root, { stripSegments: ['[locale]'] }, [
      { match: '* /admin/**', reason: 'internal' },
    ]);
    expect(tree).toEqual({
      complete: true,
      pages: [
        { path: '/', params: [], file: 'src/app/page.tsx' },
        { path: '/overview', params: [], file: 'src/app/[locale]/overview/page.jsx' },
        { path: '/settings', params: [], file: 'src/app/@modal/settings/page.tsx' },
        { path: '/tasks', params: [], file: 'src/app/(dashboard)/tasks/page.tsx' },
        { path: '/tasks/:taskId', params: ['taskId'], file: 'src/app/(dashboard)/tasks/[taskId]/page.tsx' },
      ],
      excluded: [
        { stableKey: 'PAGE /admin/users', reason: 'internal', origin: 'policy' },
        { stableKey: 'PAGE /auth/callback', reason: 'auth-page', origin: 'default' },
        { stableKey: 'PAGE /docs/*slug', reason: 'catch-all-page', origin: 'default' },
        { stableKey: 'PAGE /login', reason: 'auth-page', origin: 'default' },
        { stableKey: 'PAGE /mcp', reason: 'mcp-page', origin: 'default' },
        { stableKey: 'PAGE /tasks/:taskId', reason: 'intercepting-page', origin: 'default' },
      ],
      findings: [],
    });
  });

  it('excludes pages by PAGE or any-method patterns, never by endpoint methods', async () => {
    const app = await createAppFixture({
      'src/app/admin/page.tsx': PAGE,
      'src/app/reports/page.tsx': PAGE,
      'src/app/tasks/page.tsx': PAGE,
    });
    const tree = await enumeratePages(app.root, {}, [
      { match: 'PAGE /admin', reason: 'internal' },
      { match: 'GET /reports', reason: 'endpoint only' },
    ]);
    expect(tree).toMatchObject({
      pages: [{ path: '/reports' }, { path: '/tasks' }],
      excluded: [{ stableKey: 'PAGE /admin', reason: 'internal', origin: 'policy' }],
    });
  });

  it('prefers app/ when there is no src/app and reports nothing without an app dir', async () => {
    const app = await createAppFixture({ 'app/reports/page.js': PAGE });
    expect(await enumeratePages(app.root, {}, [])).toMatchObject({
      complete: true,
      pages: [{ path: '/reports', params: [], file: 'app/reports/page.js' }],
    });
    const empty = await createAppFixture({});
    expect(await enumeratePages(empty.root, {}, [])).toEqual({ complete: true, pages: [], excluded: [], findings: [] });
  });

  it('keeps the first of two pages for one path and says so', async () => {
    const app = await createAppFixture({
      'src/app/(a)/tasks/page.tsx': PAGE,
      'src/app/(b)/tasks/page.tsx': PAGE,
    });
    const tree = await enumeratePages(app.root, {}, []);
    expect(tree).toMatchObject({
      pages: [{ path: '/tasks', file: 'src/app/(a)/tasks/page.tsx' }],
      findings: [expect.objectContaining({ code: 'page-path-duplicated', subjectRef: 'PAGE /tasks', severity: 'warning' })],
    });
  });

  it('refuses a linked folder instead of skipping its pages', async () => {
    const app = await createAppFixture({ 'src/app/tasks/page.tsx': PAGE });
    const outside = await mkdtemp(join(SDK_ROOT, '.tool-fixtures', 'outside-'));
    await symlink(outside, app.path('src/app/linked'), 'dir');
    expect(await enumeratePages(app.root, {}, [])).toEqual({
      complete: false,
      reason: 'src/app/linked is a link; pages behind it cannot be enumerated.',
    });
  });
});
```

Create `src/codegen/tools/sources/ui-tools.test.ts`:

```ts
import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { scanAppSources } from './app-files.js';
import { jsonSchemaDigest } from '../canonical.js';
import { OPAQUE_SCHEMA_DIGEST } from '../contract-tiers.js';
import {
  hasNavigationBridge,
  UI_TOOL_OUTPUT_SCHEMA,
  uiDefinitionIdForAction,
  uiObservation,
  uniqueDefinitionIds,
  viewName,
} from './ui-tools.js';

afterEach(removeAppFixtures);

const file = (path: string, source: string) => ({ path, absolute: `/app/${path}`, source });

describe('navigation bridge detection', () => {
  it.each([
    ["import { useGlirastesNavigationBridge as useBridge } from 'glirastes/react';\nexport function A() { useBridge({ push: () => {} }); }"],
    ["import * as browser from 'glirastes/browser';\nbrowser.registerNavigationBridge({ push: (href) => location.assign(href) });"],
  ])('finds the bridge in %#', (source) => {
    expect(hasNavigationBridge([file('src/a.tsx', source)])).toBe(true);
  });

  it.each([
    ['a same-named local function', 'function useGlirastesNavigationBridge() {}\nuseGlirastesNavigationBridge();'],
    ['a comment', "// useGlirastesNavigationBridge({ push }) from 'glirastes/react'"],
    ['an import without a call', "import { registerNavigationBridge } from 'glirastes/browser';\nexport { registerNavigationBridge };"],
  ])('does not count %s', (_label, source) => {
    expect(hasNavigationBridge([file('src/a.tsx', source)])).toBe(false);
  });
});

describe('UI tool names', () => {
  it.each([
    ['/', 'home'],
    ['/tasks', 'tasks'],
    ['/admin/users', 'adminUsers'],
    ['/projects/:projectId/tasks', 'projectsTasks'],
    ['/tasks/:taskId', 'tasksItem'],
    ['/2fa-setup', 'v2faSetup'],
  ])('names the filter view of %s %s', (path, expected) => {
    expect(viewName(path)).toBe(expected);
  });

  it.each([
    ['tasks.highlight', 'ui.tasks.highlight'],
    ['task-details.open', 'ui.taskDetails.open'],
    ['navigate', 'ui.action.navigate'],
    ['filter.tasks', 'ui.action.filter.tasks'],
    ['2fa.start', 'ui.a2fa.start'],
    ['', undefined],
    ['...', undefined],
  ])('names the client action %j %s', (actionId, expected) => {
    expect(uiDefinitionIdForAction(actionId)).toBe(expected);
  });
});

describe('scanAppSources', () => {
  it('reads matching app files only, outside dependencies, build output and generated code', async () => {
    const app = await createAppFixture({
      'src/a.tsx': 'useAiClientAction();',
      'src/b.ts': 'nothing here',
      'src/generated/glirastes/tools.generated.ts': 'useAiClientAction();',
      'src/.cache/x.ts': 'useAiClientAction();',
      'node_modules/lib/index.js': 'useAiClientAction();',
      '.next/server/page.js': 'useAiClientAction();',
      'src/types.d.ts': 'useAiClientAction();',
    });
    const scan = await scanAppSources(app.root, { matches: (source) => source.includes('useAiClientAction') });
    expect(scan).toEqual({ complete: true, files: [expect.objectContaining({ path: 'src/a.tsx' })] });
  });

  it('reports a linked source folder as incomplete', async () => {
    const app = await createAppFixture({ 'src/a.tsx': 'x', 'lib/b.ts': 'x' });
    await symlink(app.path('lib'), app.path('src/lib'), 'dir');
    expect(await scanAppSources(app.root, { matches: () => true })).toEqual({
      complete: false,
      reason: 'src/lib is a link; its sources cannot be enumerated.',
    });
  });
});

describe('UI tool observations', () => {
  const input = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };

  it('keeps a typed UI tool bound to its JSON Schema and action', () => {
    const observed = uiObservation({
      stableKey: 'UI action tasks.highlight',
      definitionId: 'ui.tasks.highlight',
      actionBindingRef: 'tasks.highlight',
      input,
      uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
      params: { path: [], query: [], body: ['taskId'] },
      facts: { files: ['src/a.tsx'] },
      findings: [],
      jsDoc: 'Highlight a task.',
    });
    expect(observed.execution).toMatchObject({
      executionKind: 'ui', actionBindingRef: 'tasks.highlight',
      inputSchemaDigest: jsonSchemaDigest(input), outputSchemaDigest: jsonSchemaDigest(UI_TOOL_OUTPUT_SCHEMA),
    });
    expect(observed.contract).toMatchObject({
      source: 'ui-bridge', loadBearing: true, input,
      runtime: { input: { kind: 'json', schema: input }, output: { kind: 'json', schema: UI_TOOL_OUTPUT_SCHEMA } },
      uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
    });
    expect(observed.evidence).toEqual({ authEvidence: false, externalCall: false, jsDoc: 'Highlight a task.' });
  });

  it('keeps the identity of an untyped tool without a contract', () => {
    const observed = uiObservation({
      stableKey: 'UI action tasks.highlight', definitionId: 'ui.tasks.highlight', actionBindingRef: 'tasks.highlight',
      uiAction: { kind: 'client-action', actionId: 'tasks.highlight' }, facts: {}, findings: [], uiMutation: true,
    });
    expect(observed.contract).toBeUndefined();
    expect(observed.execution.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(observed.evidence.uiMutation).toBe(true);
  });

  it('changes the fingerprint with the facts, never with unrelated keys', () => {
    const fingerprint = (facts: unknown, stableKey = 'UI navigate') => uiObservation({
      stableKey, definitionId: 'ui.navigate', actionBindingRef: 'glirastes.navigate', input,
      uiAction: { kind: 'navigate' }, facts, findings: [],
    }).execution.sourceFingerprint;
    expect(fingerprint({ destinations: ['/a'] })).toBe(fingerprint({ destinations: ['/a'] }));
    expect(fingerprint({ destinations: ['/a'] })).not.toBe(fingerprint({ destinations: ['/b'] }));
    expect(fingerprint({ destinations: ['/a'] })).not.toBe(fingerprint({ destinations: ['/a'] }, 'UI filter /a'));
  });

  it('gives colliding base names a stable digest suffix in stable-key order', () => {
    const ids = uniqueDefinitionIds([
      { stableKey: 'UI filter /admin/users', base: 'ui.filter.adminUsers' },
      { stableKey: 'UI filter /admin-users', base: 'ui.filter.adminUsers' },
      { stableKey: 'UI filter /tasks', base: 'ui.filter.tasks' },
    ]);
    expect(ids.get('UI filter /admin-users')).toBe('ui.filter.adminUsers');
    expect(ids.get('UI filter /admin/users')).toMatch(/^ui\.filter\.adminUsers[A-Za-z0-9]{8}$/);
    expect(ids.get('UI filter /tasks')).toBe('ui.filter.tasks');
  });
});
```

In `src/contracts/__tests__/tool-exclude-pattern.test.ts`, replace:

```ts
    ['/api/admin/*', undefined, ['api', 'admin', '*']],
    ['* /api/**', undefined, ['api', '**']],
    ['  HEAD   /api/health  ', 'HEAD', ['api', 'health']],
    ['GET /api/tasks/:id', 'GET', ['api', 'tasks', ':id']],
    // A catch-all stable-key segment (`*slug`) matches literally.
    ['DELETE /api/files/*slug', 'DELETE', ['api', 'files', '*slug']],
```

with:

```ts
    ['/api/admin/*', undefined, ['api', 'admin', '*']],
    ['* /api/**', undefined, ['api', '**']],
    ['  HEAD   /api/health  ', 'HEAD', ['api', 'health']],
    ['PAGE /admin/**', 'PAGE', ['admin', '**']],
    ['GET /api/tasks/:id', 'GET', ['api', 'tasks', ':id']],
    // A catch-all stable-key segment (`*slug`) matches literally.
    ['DELETE /api/files/*slug', 'DELETE', ['api', 'files', '*slug']],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/page-tree.test.ts src/codegen/tools/sources/ui-tools.test.ts src/contracts/__tests__/tool-exclude-pattern.test.ts`
Expected: FAIL — `Cannot find module './page-tree.js'` and `'./app-files.js'` (the first import of `ui-tools.test.ts`), and `PAGE /admin/**` is not a pattern. `Test Files  3 failed (3)`, `Tests  1 failed | 22 passed (23)`

- [ ] **Step 3: Scan app sources within bounds**

Create `src/codegen/tools/sources/app-files.ts`:

```ts
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { compareCodeUnits } from '../canonical.js';

export const MAX_APP_SOURCE_FILES = 20_000;
export const MAX_APP_SOURCE_BYTES = 2_000_000;

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
/** Dependencies, build output and generated code never register app handlers. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'generated',
]);

export interface AppSourceFile {
  /** App-relative POSIX path. */
  path: string;
  absolute: string;
  source: string;
}

export type AppSourceScan =
  | { complete: true; files: AppSourceFile[] }
  | { complete: false; reason: string };

/** `src` when the app has one, else the app root. */
export function defaultSourceDir(root: string): string {
  return existsSync(join(root, 'src')) ? 'src' : '.';
}

function appRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * Bounded walk over the app's own source files. A link, an oversized file
 * or too many files make the scan incomplete instead of silently skipping
 * code that could register a UI action.
 */
export async function scanAppSources(root: string, options: {
  srcDir?: string;
  matches(source: string): boolean;
}): Promise<AppSourceScan> {
  const files: AppSourceFile[] = [];
  let visited = 0;
  const start = join(root, options.srcDir ?? defaultSourceDir(root));
  if (!existsSync(start)) return { complete: true, files: [] };
  const walk = async (directory: string): Promise<string | undefined> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) return `${appRelative(root, absolute)} is a link; its sources cannot be enumerated.`;
      if (entry.isDirectory()) {
        const failure = await walk(absolute);
        if (failure) return failure;
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      visited += 1;
      if (visited > MAX_APP_SOURCE_FILES) return 'The app has too many source files to enumerate UI actions.';
      if ((await lstat(absolute)).size > MAX_APP_SOURCE_BYTES) {
        return `${appRelative(root, absolute)} is too large to read.`;
      }
      const source = await readFile(absolute, 'utf8');
      if (options.matches(source)) files.push({ path: appRelative(root, absolute), absolute, source });
    }
    return undefined;
  };
  const failure = await walk(start);
  return failure ? { complete: false, reason: failure } : { complete: true, files };
}
```

- [ ] **Step 4: Enumerate the page tree**

In `src/contracts/tool-exclude-pattern.ts`, replace:

```ts
  segments: string[];
}

const EXCLUDE_PATTERN = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|\*)\s+)?(\/\S*)$/;

function isValidSegment(segment: string): boolean {
  if (segment === '*' || segment === '**') return true;
```

with:

```ts
  segments: string[];
}

// PAGE matches app pages (navigation destinations and filtered views).
const EXCLUDE_PATTERN = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|PAGE|\*)\s+)?(\/\S*)$/;

function isValidSegment(segment: string): boolean {
  if (segment === '*' || segment === '**') return true;
```

Create `src/codegen/tools/sources/page-tree.ts`:

```ts
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { compareCodeUnits } from '../canonical.js';
import { matchesExcludePattern, type PolicyExcludeRule } from '../exclusions.js';
import { toolFinding } from '../findings.js';
import type { ExcludedTool, ToolFinding } from '../types.js';

const PAGE_FILE = /^page\.(?:tsx|ts|jsx|js|mdx|md)$/;
const MAX_ENTRIES = 20_000;
const MAX_PAGES = 5_000;

export interface PageEntry {
  /** Route spelling: `/tasks/:taskId`. */
  path: string;
  params: string[];
  /** App-relative POSIX path of the page file. */
  file: string;
}

export type PageTree =
  | { complete: true; pages: PageEntry[]; excluded: ExcludedTool[]; findings: ToolFinding[] }
  | { complete: false; reason: string };

export interface PageTreeOptions {
  appDir?: string;
  /** Folder names left out of the path, e.g. `[locale]`. */
  stripSegments?: ReadonlyArray<string>;
}

/** Stable key of a page in exclusions and policy patterns: `PAGE /tasks`. */
export function pageStableKey(path: string): string {
  return `PAGE ${path}`;
}

/** `src/app` when it exists, else `app`. */
export function defaultAppDir(root: string): string | undefined {
  if (existsSync(join(root, 'src/app'))) return 'src/app';
  return existsSync(join(root, 'app')) ? 'app' : undefined;
}

const DEFAULT_PAGE_RULES: ReadonlyArray<{ reason: string; words: ReadonlySet<string> }> = [
  {
    reason: 'auth-page',
    words: new Set(['auth', 'login', 'logout', 'signin', 'sign-in', 'signout', 'sign-out', 'signup', 'sign-up']),
  },
  { reason: 'callback-page', words: new Set(['callback', 'callbacks', 'oauth', 'sso']) },
  { reason: 'mcp-page', words: new Set(['mcp']) },
];

interface RawPage {
  file: string;
  segments: string[];
}

function toPath(raw: RawPage, strip: ReadonlySet<string>): {
  path: string;
  params: string[];
  reason?: string;
} {
  const params: string[] = [];
  const parts: string[] = [];
  let reason: string | undefined;
  for (const segment of raw.segments) {
    if (/^\(\.{1,3}\)/.test(segment) || /^\(\.\.\)/.test(segment)) {
      reason ??= 'intercepting-page';
      const rest = segment.replace(/^\((?:\.{1,3}|\.\.)\)/, '');
      if (rest) parts.push(rest);
      continue;
    }
    if (/^\(.+\)$/.test(segment) || segment.startsWith('@') || strip.has(segment)) continue;
    const catchAll = /^\[\[?\.\.\.(.+?)\]?\]$/.exec(segment);
    if (catchAll) {
      reason ??= 'catch-all-page';
      parts.push(`*${catchAll[1]}`);
      continue;
    }
    const dynamic = /^\[(.+)\]$/.exec(segment);
    if (dynamic) {
      params.push(dynamic[1]!);
      parts.push(`:${dynamic[1]}`);
      continue;
    }
    parts.push(segment);
  }
  return { path: `/${parts.join('/')}`, params, ...(reason ? { reason } : {}) };
}

function defaultReason(path: string): string | undefined {
  const words = path.split('/').filter((segment) => segment && !segment.startsWith(':') && !segment.startsWith('*'))
    .map((segment) => segment.toLowerCase());
  return DEFAULT_PAGE_RULES.find((rule) => words.some((word) => rule.words.has(word)))?.reason;
}

/**
 * Why an app path is not offered to the chat: a default rule (sign-in,
 * callback, MCP) or a policy exclusion (`PAGE /path`, `* /path`). Pages and
 * `defineQueryFilters` views outside the page tree follow the same rules.
 */
export function pathExclusion(
  path: string,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): { reason: string; origin: 'default' | 'policy' } | undefined {
  const rule = defaultReason(path);
  if (rule) return { reason: rule, origin: 'default' };
  const policy = policyExcludes.find((entry) => matchesExcludePattern(entry.match, { method: 'PAGE', path }));
  return policy ? { reason: policy.reason, origin: 'policy' } : undefined;
}

/**
 * Pages of a Next.js app router tree as navigation destinations. Route
 * groups, parallel-route slots and strip segments leave the path; `_private`
 * folders and the top-level `api` folder are not pages. Every page ends as a
 * destination or as a reasoned exclusion.
 */
export async function enumeratePages(
  root: string,
  options: PageTreeOptions,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): Promise<PageTree> {
  const appDir = options.appDir ?? defaultAppDir(root);
  if (!appDir || !existsSync(join(root, appDir))) return { complete: true, pages: [], excluded: [], findings: [] };
  const appRoot = join(root, appDir);
  const raws: RawPage[] = [];
  let visited = 0;
  const walk = async (directory: string, segments: string[]): Promise<string | undefined> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ENTRIES) return 'The app tree is too large to enumerate pages.';
      const absolute = join(directory, entry.name);
      const local = relative(root, absolute).split(sep).join('/');
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) return `${local} is a link; pages behind it cannot be enumerated.`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) continue;
        if (segments.length === 0 && entry.name === 'api') continue;
        const failure = await walk(absolute, [...segments, entry.name]);
        if (failure) return failure;
      } else if (entry.isFile() && PAGE_FILE.test(entry.name)) {
        raws.push({ file: local, segments });
        if (raws.length > MAX_PAGES) return 'The app has too many pages to enumerate.';
      }
    }
    return undefined;
  };
  const failure = await walk(appRoot, []);
  if (failure) return { complete: false, reason: failure };

  const strip = new Set(options.stripSegments ?? []);
  const pages = new Map<string, PageEntry>();
  const excluded = new Map<string, ExcludedTool>();
  const findings: ToolFinding[] = [];
  for (const raw of raws.sort((left, right) => compareCodeUnits(left.file, right.file))) {
    const { path, params, reason } = toPath(raw, strip);
    const stableKey = pageStableKey(path);
    const exclusion = reason ? { reason, origin: 'default' as const } : pathExclusion(path, policyExcludes);
    if (exclusion) {
      excluded.set(stableKey, { stableKey, ...exclusion });
      continue;
    }
    const existing = pages.get(path);
    if (existing) {
      findings.push(toolFinding('page-path-duplicated', 'warning', stableKey,
        `${raw.file} and ${existing.file} both render ${path}; navigation uses ${existing.file}.`));
      continue;
    }
    pages.set(path, { path, params, file: raw.file });
  }
  return {
    complete: true,
    pages: [...pages.values()].sort((left, right) => compareCodeUnits(left.path, right.path)),
    excluded: [...excluded.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
  };
}
```

- [ ] **Step 5: Shared UI tool helpers**

Create `src/codegen/tools/sources/ui-tools.ts`:

```ts
import ts from 'typescript';
import { TOOL_NAME_PATTERN } from '../../../runtime/local-tool-bindings.js';
import type { GeneratedUiAction } from '../../../server/core/generated-ui-tool.js';
import { canonicalJson, compareCodeUnits, jsonSchemaDigest, sha256Digest } from '../canonical.js';
import { OPAQUE_SCHEMA_DIGEST } from '../contract-tiers.js';
import { toolFinding } from '../findings.js';
import type {
  JsonSchemaLike,
  ObservedTool,
  ToolContract,
  ToolFinding,
  ToolProseHints,
  ToolSourceObservation,
} from '../types.js';
import type { AppSourceFile } from './app-files.js';

/** Action id the navigation bridge listens to; `ui.navigate` and every `ui.filter.<view>` use it. */
export const NAVIGATE_ACTION_BINDING = 'glirastes.navigate';
export const NAVIGATE_STABLE_KEY = 'UI navigate';
export const NAVIGATE_DEFINITION_ID = 'ui.navigate';

export function filterStableKey(path: string): string {
  return `UI filter ${path}`;
}

export function actionStableKey(actionId: string): string {
  return `UI action ${actionId}`;
}

/** What every generated UI tool returns (`uiActionToolToTool`). */
export const UI_TOOL_OUTPUT_SCHEMA: JsonSchemaLike = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    error: { type: 'string' },
    uiAction: { type: 'object' },
  },
  required: ['success'],
};

function words(segment: string): string[] {
  return segment.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function camel(parts: ReadonlyArray<string>): string {
  return parts.map((part, index) => (
    index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1)
  )).join('');
}

/** `/tasks` → `tasks`, `/` → `home`, `/tasks/:id` → `tasksItem`: the `<view>` of `ui.filter.<view>`. */
export function viewName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const statics = segments.filter((segment) => !segment.startsWith(':') && !segment.startsWith('*'));
  let name = camel(statics.flatMap(words)) || 'home';
  if (segments.at(-1)?.startsWith(':')) name = `${name}Item`;
  return /^[0-9]/.test(name) ? `v${name}` : name;
}

const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(['navigate', 'filter', 'action']);

/**
 * `tasks.highlight` → `ui.tasks.highlight`. A single segment or one that
 * would shadow `ui.navigate`/`ui.filter.*` moves under `ui.action.`;
 * undefined when the id cannot form a tool name.
 */
export function uiDefinitionIdForAction(actionId: string): string | undefined {
  const segments = actionId.split('.').map((segment) => camel(words(segment)));
  if (segments.some((segment) => segment.length === 0)) return undefined;
  const named = segments.map((segment) => (/^[0-9]/.test(segment) ? `a${segment}` : segment));
  const parts = named.length === 1 || RESERVED_FIRST_SEGMENTS.has(named[0]!) ? ['action', ...named] : named;
  const id = `ui.${parts.join('.')}`;
  return id.length <= 200 && TOOL_NAME_PATTERN.test(id) ? id : undefined;
}

/** Same base name for two stable keys: the later key gets a digest suffix, independent of order. */
export function uniqueDefinitionIds(entries: ReadonlyArray<{ stableKey: string; base: string }>): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const entry of [...entries].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey))) {
    let id = entry.base;
    if (taken.has(id)) id = `${entry.base}${sha256Digest(entry.stableKey).slice(7, 15).replace(/[^A-Za-z0-9]/g, 'x')}`;
    taken.add(id);
    ids.set(entry.stableKey, id);
  }
  return ids;
}

export function parseAppSource(file: Pick<AppSourceFile, 'path' | 'source'>): ts.SourceFile {
  const kind = /\.tsx$/.test(file.path) ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(file.path) ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  return ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind);
}

export interface ImportSpec {
  module: string;
  names: ReadonlyArray<string>;
}

export interface ImportedCall {
  /** The exported name the call resolves to, whatever the local alias. */
  name: string;
  call: ts.CallExpression;
}

export interface ImportBindings {
  /** Local name → exported name. */
  named: ReadonlyMap<string, string>;
  /** Namespace alias → the exported names it may reach. */
  namespaces: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Value imports of the given names from the given modules; type-only imports never count. */
export function importBindings(source: ts.SourceFile, specs: ReadonlyArray<ImportSpec>): ImportBindings {
  const named = new Map<string, string>();
  const namespaces = new Map<string, ReadonlySet<string>>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const spec = specs.find((candidate) => candidate.module === (statement.moduleSpecifier as ts.StringLiteral).text);
    if (!spec) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, new Set(spec.names));
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && spec.names.includes(imported)) named.set(element.name.text, imported);
      }
    }
  }
  return { named, namespaces };
}

/** The exported name `node` refers to through `bindings`: `alias` or `namespace.name`. */
export function importedName(node: ts.Node, bindings: ImportBindings): string | undefined {
  if (ts.isIdentifier(node)) return bindings.named.get(node.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return bindings.namespaces.get(node.expression.text)?.has(node.name.text) ? node.name.text : undefined;
  }
  return undefined;
}

/**
 * Calls of named or namespace imports from the given modules, read from
 * syntax only: a same-named local function, a comment or an import that is
 * never called does not count.
 */
export function importedCalls(source: ts.SourceFile, specs: ReadonlyArray<ImportSpec>): ImportedCall[] {
  const bindings = importBindings(source, specs);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return [];
  const calls: ImportedCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = importedName(node.expression, bindings);
      if (name !== undefined) calls.push({ name, call: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

const BRIDGE_IMPORTS: ReadonlyArray<ImportSpec> = [
  { module: 'glirastes/react', names: ['useGlirastesNavigationBridge'] },
  { module: 'glirastes/browser', names: ['registerNavigationBridge'] },
];

/** True when app code calls the navigation bridge that executes `ui.navigate` and `ui.filter.*`. */
export function hasNavigationBridge(files: ReadonlyArray<Pick<AppSourceFile, 'path' | 'source'>>): boolean {
  return files.some((file) => (
    file.source.includes('NavigationBridge') && importedCalls(parseAppSource(file), BRIDGE_IMPORTS).length > 0
  ));
}

export function mentionsNavigationBridge(source: string): boolean {
  return source.includes('NavigationBridge');
}

export interface UiObservationInput {
  stableKey: string;
  definitionId: string;
  actionBindingRef: string;
  /** Undefined when the payload is untyped: the tool keeps its identity but has no contract. */
  input?: JsonSchemaLike;
  uiAction: GeneratedUiAction;
  params?: ToolContract['params'];
  /** Facts the tool depends on; a change of these is a changed tool. */
  facts: unknown;
  findings: ToolFinding[];
  prose?: ToolProseHints;
  jsDoc?: string;
  uiMutation?: boolean;
}

/** An `ObservedTool` for a generated UI tool; its contract is JSON Schema read from code. */
export function uiObservation(input: UiObservationInput): ObservedTool {
  const output = UI_TOOL_OUTPUT_SCHEMA;
  const contract: ToolContract | undefined = input.input
    ? {
      source: 'ui-bridge',
      loadBearing: true,
      input: input.input,
      output,
      params: input.params ?? { path: [], query: [], body: [] },
      interfaceDigest: sha256Digest(canonicalJson({ stableKey: input.stableKey, input: input.input, uiAction: input.uiAction })),
      runtime: { input: { kind: 'json', schema: input.input }, output: { kind: 'json', schema: output } },
      uiAction: input.uiAction,
    }
    : undefined;
  return {
    execution: {
      definitionId: input.definitionId,
      stableKey: input.stableKey,
      executionKind: 'ui',
      actionBindingRef: input.actionBindingRef,
      sourceFingerprint: sha256Digest(canonicalJson({ stableKey: input.stableKey, facts: input.facts })),
      inputSchemaDigest: input.input ? jsonSchemaDigest(input.input) : OPAQUE_SCHEMA_DIGEST,
      outputSchemaDigest: jsonSchemaDigest(output),
    },
    ...(contract ? { contract } : {}),
    evidence: {
      authEvidence: false,
      externalCall: false,
      ...(input.jsDoc ? { jsDoc: input.jsDoc } : {}),
      ...(input.uiMutation ? { uiMutation: true } : {}),
    },
    findings: input.findings,
    ...(input.prose ? { prose: input.prose } : {}),
  };
}

/** One incomplete UI enumeration stops the refresh, like an unreadable route file. */
export function incompleteUiSource(kind: string, reason: string): ToolSourceObservation {
  return {
    observations: [],
    findings: [toolFinding('E-INVENTORY-011', 'error', kind, reason)],
    complete: false,
    excluded: [],
  };
}
```

In `src/codegen/tools/findings.ts`, replace:

```ts
  'prompt-bundle-invalid': 'Fix .glirastes/prompt-bundle.json: it must match its schema and this appId.',
  'generation-state-invalid': 'Restore the generated .glirastes file from git, or resolve its merge by keeping both sides, then rerun refresh.',
  'E-INVENTORY-010': 'Resolve the duplicate tool identity reported above, then rerun glirastes tools refresh.',
  'E-INVENTORY-011': 'Replace export * in route files and fix unreadable sources so every route can be enumerated.',
  'E-POLICY-001': 'Fix .glirastes/tool-policy.json so it matches its schema; policy can only restrict what the code allows.',
  'risk-raised': 'Nothing to do: confirmation is enforced automatically. Review the change in your diff.',
  'override-lapsed-risk-raised': 'Your relaxation no longer applies at the higher risk; review whether you still need it.',
```

with:

```ts
  'prompt-bundle-invalid': 'Fix .glirastes/prompt-bundle.json: it must match its schema and this appId.',
  'generation-state-invalid': 'Restore the generated .glirastes file from git, or resolve its merge by keeping both sides, then rerun refresh.',
  'E-INVENTORY-010': 'Resolve the duplicate tool identity reported above, then rerun glirastes tools refresh.',
  'E-INVENTORY-011': 'Replace export * in route files and fix unreadable or linked sources so every route, page and UI action can be enumerated.',
  'E-POLICY-001': 'Fix .glirastes/tool-policy.json so it matches its schema; policy can only restrict what the code allows.',
  'risk-raised': 'Nothing to do: confirmation is enforced automatically. Review the change in your diff.',
  'override-lapsed-risk-raised': 'Your relaxation no longer applies at the higher risk; review whether you still need it.',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/page-tree.test.ts src/codegen/tools/sources/ui-tools.test.ts src/contracts/__tests__/tool-exclude-pattern.test.ts && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  52 passed (52)`; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/findings.ts src/codegen/tools/sources/app-files.ts \
  src/codegen/tools/sources/page-tree.test.ts src/codegen/tools/sources/page-tree.ts \
  src/codegen/tools/sources/ui-tools.test.ts src/codegen/tools/sources/ui-tools.ts \
  src/contracts/__tests__/tool-exclude-pattern.test.ts src/contracts/tool-exclude-pattern.ts
git commit -m "feat(codegen): read app pages and ui registrations from source"
```

### Task 15: `ui.navigate` from the Next.js page tree

**Files:**
- Create: `src/codegen/tools/sources/next-pages.ts`
- Modify: `src/codegen/tools/config.ts` (source kind `next-pages`, singleton sources), `src/codegen/tools/pipeline.ts` (`createConfiguredSources`)
- Test: `src/codegen/tools/sources/next-pages.test.ts` (Create), `src/codegen/tools/config.test.ts`, `src/codegen/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 14 (`enumeratePages`, `scanAppSources`, `hasNavigationBridge`, `uiObservation`).
- Produces:
  - `export interface NextPagesSourceOptions extends PageTreeOptions { srcDir?: string }`, `export function navigationInputSchema(pages): JsonSchemaLike`, `export function navigationBridgeMissing(stableKey): ToolFinding`, `export function scanForNavigationBridge(root, srcDir): Promise<AppSourceScan>`, `export function createNextPagesSource(options?): ToolSource`.
  - `ui.navigate` input `{ destination: <page paths>, params?: { <every dynamic segment>: string } }`, `uiAction: { kind: 'navigate' }`, fingerprint over the destinations only (moving a page into a route group changes nothing), prose "Open a page of this app in the user's browser. Destinations: …" (German for `de` locales), `navigation-bridge-missing` when no bridge call is found.
  - `tools.json` source `"next-pages"` or `{ kind: 'next-pages', appDir?, srcDir?, stripSegments? }` (folder names, never paths); `next-pages`, `url-filters` and `react-actions` may each appear once.
  - `export function createConfiguredSources(config: ToolsConfig): ToolSource[]` (pipeline default).

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/sources/next-pages.test.ts`:

```ts
import { mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from '../__tests__/app-fixture.js';
import { jsonSchemaDigest } from '../canonical.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createNextPagesSource } from './next-pages.js';

afterEach(removeAppFixtures);

const PAGE = 'export default function Page() { return null; }\n';
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\n"
  + "import { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href) => router.push(href) });\n  return null;\n}\n';

function context(root: string, exclude: Array<{ match: string; reason: string }> = []): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude, acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

describe('next-pages source', () => {
  it('offers every page as a destination of one navigation tool', async () => {
    const app = await createAppFixture({
      'src/app/page.tsx': PAGE,
      'src/app/tasks/page.tsx': PAGE,
      'src/app/tasks/[taskId]/page.tsx': PAGE,
      'src/app/login/page.tsx': PAGE,
      'src/components/glirastes-bridge.tsx': BRIDGE,
    });
    const observed = await createNextPagesSource().observe(context(app.root));
    const input = {
      type: 'object',
      properties: {
        destination: { type: 'string', enum: ['/', '/tasks', '/tasks/:taskId'] },
        params: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, additionalProperties: false },
      },
      required: ['destination'],
      additionalProperties: false,
    };
    expect(observed).toMatchObject({
      complete: true,
      findings: [],
      excluded: [{ stableKey: 'PAGE /login', reason: 'auth-page', origin: 'default' }],
    });
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]).toMatchObject({
      execution: {
        definitionId: 'ui.navigate', stableKey: 'UI navigate', executionKind: 'ui',
        actionBindingRef: 'glirastes.navigate', inputSchemaDigest: jsonSchemaDigest(input),
      },
      contract: { source: 'ui-bridge', input, uiAction: { kind: 'navigate' }, params: { path: ['taskId'], query: [], body: [] } },
      findings: [],
      prose: {
        contractDescription: "Open a page of this app in the user's browser. Destinations: /, /tasks, /tasks/:taskId (needs params.taskId).",
        presentation: { locale: 'en-US', singular: 'Open page', plural: 'Open pages', approval: 'Open a page' },
      },
    });
  }, 60_000);

  it('keeps the tool but needs attention when no navigation bridge is mounted', async () => {
    const app = await createAppFixture({
      'src/app/tasks/page.tsx': PAGE,
      'src/components/fake.tsx': '// useGlirastesNavigationBridge({ push }) is not called here\n',
    });
    const [tool] = (await createNextPagesSource().observe(context(app.root))).observations;
    expect(tool?.contract).toBeDefined();
    expect(tool?.findings).toEqual([expect.objectContaining({
      code: 'navigation-bridge-missing', severity: 'needs_attention', subjectRef: 'UI navigate',
    })]);
  }, 60_000);

  it('describes the destinations in German for a German app', async () => {
    const app = await createAppFixture({ 'app/aufgaben/page.jsx': PAGE }, {
      toolsConfig: { locale: 'de-DE', sources: ['next-pages'] },
    });
    const [tool] = (await createNextPagesSource().observe(context(app.root))).observations;
    expect(tool?.prose).toMatchObject({
      contractDescription: 'Öffnet eine Seite dieser App im Browser des Nutzers. Ziele: /aufgaben.',
      presentation: { locale: 'de-DE', singular: 'Seite öffnen' },
    });
  }, 60_000);

  it('produces nothing for an app without pages and stops on an unreadable page tree', async () => {
    const empty = await createAppFixture({ 'src/app/api/tasks/route.ts': 'export async function GET() {}\n' });
    expect(await createNextPagesSource().observe(context(empty.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
    const linked = await createAppFixture({ 'src/app/tasks/page.tsx': PAGE });
    const outside = await mkdtemp(join(SDK_ROOT, '.tool-fixtures', 'outside-'));
    await symlink(outside, linked.path('src/app/reports'), 'dir');
    expect(await createNextPagesSource().observe(context(linked.root))).toMatchObject({
      complete: false,
      observations: [],
      findings: [{ code: 'E-INVENTORY-011', severity: 'error', subjectRef: 'next-pages' }],
    });
  }, 60_000);
});
```

1. In `src/codegen/tools/config.test.ts`, replace:

```ts
    expect(config.ci.strict).toBe(true);
  });

  it.each([
    ['an unknown key', { ...minimal, openrouterApiKey: 'value' }],
    ['a secret-looking value', { ...minimal, enrich: { model: `sk-or-v1-${'a'.repeat(32)}` } }],
```

with:

```ts
    expect(config.ci.strict).toBe(true);
  });

  it('accepts the next-pages source with its folder options', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: ['next-app', { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] }],
    }));
    expect(normalizeSources(config)).toEqual([
      { kind: 'next-app' },
      { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
    ]);
  });

  it.each([
    ['an unknown key', { ...minimal, openrouterApiKey: 'value' }],
    ['a secret-looking value', { ...minimal, enrich: { model: `sk-or-v1-${'a'.repeat(32)}` } }],
```

2. In `src/codegen/tools/config.test.ts`, replace:

```ts
    ['an unsupported module extension', { ...minimal, emit: { module: 'src/tools.generated.tsx' } }],
    ['an unknown source kind', { ...minimal, sources: ['rails'] }],
    ['an empty source list', { ...minimal, sources: [] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });
```

with:

```ts
    ['an unsupported module extension', { ...minimal, emit: { module: 'src/tools.generated.tsx' } }],
    ['an unknown source kind', { ...minimal, sources: ['rails'] }],
    ['an empty source list', { ...minimal, sources: [] }],
    ['a strip segment that is a path', { ...minimal, sources: [{ kind: 'next-pages', stripSegments: ['a/b'] }] }],
    ['a page option on the endpoint source', { ...minimal, sources: [{ kind: 'next-app', stripSegments: [] }] }],
    ['the next-pages source twice', { ...minimal, sources: ['next-pages', { kind: 'next-pages', appDir: 'app' }] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    expect(artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
  }, 120_000);
});
```

with:

```ts
    expect(artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
  }, 120_000);
});

const PAGE = 'export default function Page() { return null; }\n';
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\n"
  + "import { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href) => router.push(href) });\n  return null;\n}\n';

describe('runToolsPipeline (navigation)', () => {
  async function pagesApp(): Promise<AppFixture> {
    return createAppFixture({
      'src/app/page.tsx': PAGE,
      'src/app/tasks/page.tsx': PAGE,
      'src/components/glirastes-bridge.tsx': BRIDGE,
    }, { toolsConfig: { sources: ['next-pages'] } });
  }

  it('generates ui.navigate as an active UI tool without confirmation, bound in the module and verified in every mode', async () => {
    const fixture = await pagesApp();
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.added).toHaveLength(1);
    const [tool] = (await artifactOf(fixture)).tools;
    expect(tool).toMatchObject({
      name: 'ui.navigate', modelName: 'ui_navigate', executionKind: 'ui', actionBindingRef: 'glirastes.navigate',
      operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, enabled: true,
      description: "Open a page of this app in the user's browser. Destinations: /, /tasks.",
      provenance: { contractSource: 'ui-bridge', descriptionSource: 'code', schemaSource: 'json-schema' },
    });
    const contracts = JSON.parse(await fixture.read(TOOLS_PATHS.contracts)) as {
      tools: Array<{ contract: { uiAction?: unknown } }>;
    };
    expect(contracts.tools[0]?.contract.uiAction).toEqual({ kind: 'navigate' });
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).toContain("import { uiActionToolToTool } from 'glirastes/server';");
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'integrity' })).driftPaths).toEqual([]);
  }, 120_000);

  it('keeps the identity but disables navigation once the bridge is gone', async () => {
    const fixture = await pagesApp();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const toolId = (await artifactOf(fixture)).tools[0]!.toolId;
    await fixture.remove('src/components/glirastes-bridge.tsx');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.unchanged).toEqual([toolId]);
    expect((await artifactOf(fixture)).tools[0]).toMatchObject({ toolId, enabled: false, operationGroup: 'needs_attention' });
    expect(await fixture.read(TOOLS_PATHS.report)).toContain('navigation-bridge-missing');
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).not.toContain('uiActionToolToTool');
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/sources/next-pages.test.ts`
Expected: FAIL — `Cannot find module './next-pages.js'`, and `tools.json` refuses `next-pages`. `Test Files  3 failed (3)`, `Tests  3 failed | 29 passed (32)`

- [ ] **Step 3: Implement the source**

Create `src/codegen/tools/sources/next-pages.ts`:

```ts
import { compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import type {
  JsonSchemaLike,
  ToolFinding,
  ToolProseHints,
  ToolSource,
  ToolSourceObservation,
} from '../types.js';
import { scanAppSources, type AppSourceScan } from './app-files.js';
import { enumeratePages, type PageEntry, type PageTreeOptions } from './page-tree.js';
import {
  hasNavigationBridge,
  incompleteUiSource,
  mentionsNavigationBridge,
  NAVIGATE_ACTION_BINDING,
  NAVIGATE_DEFINITION_ID,
  NAVIGATE_STABLE_KEY,
  uiObservation,
} from './ui-tools.js';

export interface NextPagesSourceOptions extends PageTreeOptions {
  /** Where the navigation bridge is searched; `src` when the app has one, else the app root. */
  srcDir?: string;
}

const MAX_LISTED_DESTINATIONS = 40;

/** `destination` is one of the page paths; `params` fills their dynamic segments. */
export function navigationInputSchema(pages: ReadonlyArray<PageEntry>): JsonSchemaLike {
  const params = [...new Set(pages.flatMap((page) => page.params))].sort(compareCodeUnits);
  return {
    type: 'object',
    properties: {
      destination: { type: 'string', enum: pages.map((page) => page.path) },
      ...(params.length > 0
        ? {
          params: {
            type: 'object',
            properties: Object.fromEntries(params.map((name) => [name, { type: 'string', minLength: 1 }])),
            additionalProperties: false,
          },
        }
        : {}),
    },
    required: ['destination'],
    additionalProperties: false,
  };
}

function navigationProse(locale: string, pages: ReadonlyArray<PageEntry>): ToolProseHints {
  const german = locale.toLowerCase().startsWith('de');
  const listed = pages.slice(0, MAX_LISTED_DESTINATIONS).map((page) => (page.params.length > 0
    ? `${page.path} (${german ? 'braucht' : 'needs'} ${page.params.map((name) => `params.${name}`).join(', ')})`
    : page.path));
  const rest = pages.length - listed.length;
  const more = rest > 0 ? (german ? ` und ${rest} weitere` : ` and ${rest} more`) : '';
  return german
    ? {
      contractDescription: `Öffnet eine Seite dieser App im Browser des Nutzers. Ziele: ${listed.join(', ')}${more}.`,
      presentation: { locale, singular: 'Seite öffnen', plural: 'Seiten öffnen', approval: 'Seite öffnen' },
    }
    : {
      contractDescription: `Open a page of this app in the user's browser. Destinations: ${listed.join(', ')}${more}.`,
      presentation: { locale, singular: 'Open page', plural: 'Open pages', approval: 'Open a page' },
    };
}

export function navigationBridgeMissing(stableKey: string): ToolFinding {
  return toolFinding('navigation-bridge-missing', 'needs_attention', stableKey,
    'No useGlirastesNavigationBridge or registerNavigationBridge call was found, so the browser cannot run this tool.');
}

export function scanForNavigationBridge(root: string, srcDir: string | undefined): Promise<AppSourceScan> {
  return scanAppSources(root, { ...(srcDir ? { srcDir } : {}), matches: mentionsNavigationBridge });
}

async function observePages(
  root: string,
  locale: string,
  options: NextPagesSourceOptions,
  policyExcludes: ReadonlyArray<{ match: string; reason: string }>,
): Promise<ToolSourceObservation> {
  const tree = await enumeratePages(root, options, policyExcludes);
  if (!tree.complete) return incompleteUiSource('next-pages', tree.reason);
  if (tree.pages.length === 0) {
    return { observations: [], findings: tree.findings, complete: true, excluded: tree.excluded };
  }
  const sources = await scanForNavigationBridge(root, options.srcDir);
  if (!sources.complete) return incompleteUiSource('next-pages', sources.reason);
  const tool = uiObservation({
    stableKey: NAVIGATE_STABLE_KEY,
    definitionId: NAVIGATE_DEFINITION_ID,
    actionBindingRef: NAVIGATE_ACTION_BINDING,
    input: navigationInputSchema(tree.pages),
    uiAction: { kind: 'navigate' },
    params: {
      path: [...new Set(tree.pages.flatMap((page) => page.params))].sort(compareCodeUnits),
      query: [],
      body: [],
    },
    facts: { destinations: tree.pages.map(({ path, params }) => ({ path, params })) },
    findings: hasNavigationBridge(sources.files) ? [] : [navigationBridgeMissing(NAVIGATE_STABLE_KEY)],
    prose: navigationProse(locale, tree.pages),
  });
  return { observations: [tool], findings: tree.findings, complete: true, excluded: tree.excluded };
}

/**
 * The `next-pages` source: one `ui.navigate` tool whose destinations are the
 * pages of the Next.js app router tree (spec 4.4 "Navigation und Filter").
 */
export function createNextPagesSource(options: NextPagesSourceOptions = {}): ToolSource {
  return {
    kind: 'next-pages',
    observe: (ctx) => observePages(ctx.root, ctx.config.locale, options, ctx.policy.exclude ?? []),
  };
}
```

- [ ] **Step 4: Accept the source in `tools.json` and create it in the pipeline**

1. In `src/codegen/tools/config.ts`, replace:

```ts
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app']);

const SourceSchema = z.union([
  ToolSourceKindSchema,
  z.object({ kind: ToolSourceKindSchema, apiDir: appPath.optional() }).strict(),
]);

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
```

with:

```ts
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app', 'next-pages']);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
  .refine((value) => !/[\\/]/.test(value), 'A folder name, not a path');

const SourceSchema = z.union([
  ToolSourceKindSchema,
  z.object({ kind: z.literal('next-app'), apiDir: appPath.optional() }).strict(),
  z.object({
    kind: z.literal('next-pages'),
    appDir: appPath.optional(),
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
```

2. In `src/codegen/tools/config.ts`, replace:

```ts
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
  const sensitive = findSensitiveStringPath(config);
  if (sensitive) {
    context.addIssue({
```

with:

```ts
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
  const kinds = config.sources.map((source) => (typeof source === 'string' ? source : source.kind));
  for (const kind of SINGLETON_SOURCES) {
    if (kinds.filter((candidate) => candidate === kind).length > 1) {
      context.addIssue({ code: 'custom', path: ['sources'], message: `The ${kind} source may appear only once` });
    }
  }
  const sensitive = findSensitiveStringPath(config);
  if (sensitive) {
    context.addIssue({
```

3. In `src/codegen/tools/config.ts`, replace:

```ts
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export interface ToolSourceConfig {
  kind: z.infer<typeof ToolSourceKindSchema>;
  apiDir?: string;
}

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
```

with:

```ts
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ToolSourceConfig =
  | { kind: 'next-app'; apiDir?: string }
  | { kind: 'next-pages'; appDir?: string; srcDir?: string; stripSegments?: string[] };

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
```

1. In `src/codegen/tools/pipeline.ts`, replace:

```ts
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import {
  readPreviousToolState,
  renderInventory,
```

with:

```ts
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import {
  readPreviousToolState,
  renderInventory,
```

2. In `src/codegen/tools/pipeline.ts`, replace:

```ts
  }
}

const SETUP_PATHS = {
  inventory: TOOLS_PATHS.inventory,
  setupArtifact: TOOLS_PATHS.setupArtifact,
```

with:

```ts
  }
}

/** One source per configured entry of `tools.json` `sources`. */
export function createConfiguredSources(config: ToolsConfig): ToolSource[] {
  return normalizeSources(config).map((source) => {
    switch (source.kind) {
      case 'next-app':
        return createNextEndpointSource(source.apiDir ? { apiDir: source.apiDir } : {});
      case 'next-pages':
        return createNextPagesSource(source);
    }
  });
}

const SETUP_PATHS = {
  inventory: TOOLS_PATHS.inventory,
  setupArtifact: TOOLS_PATHS.setupArtifact,
```

3. In `src/codegen/tools/pipeline.ts`, replace:

```ts
    previousContracts: previous.contracts,
    probe: dependencies.probe ?? createSchemaProbe(),
  };
  const sources = dependencies.sources ?? normalizeSources(config).map((source) => (
    createNextEndpointSource(source.apiDir ? { apiDir: source.apiDir } : {})
  ));
  const observed: ObservedTool[] = [];
  let complete = true;
  for (const source of sources) {
```

with:

```ts
    previousContracts: previous.contracts,
    probe: dependencies.probe ?? createSchemaProbe(),
  };
  const sources = dependencies.sources ?? createConfiguredSources(config);
  const observed: ObservedTool[] = [];
  let complete = true;
  for (const source of sources) {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/sources/next-pages.test.ts && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  36 passed (36)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/config.test.ts src/codegen/tools/config.ts src/codegen/tools/pipeline.test.ts \
  src/codegen/tools/pipeline.ts src/codegen/tools/sources/next-pages.test.ts \
  src/codegen/tools/sources/next-pages.ts
git commit -m "feat(codegen): generate ui.navigate from the next.js page tree"
```

### Task 16: `ui.filter.<view>` from URL filters

**Files:**
- Create: `src/codegen/tools/sources/url-filters.ts`
- Modify: `src/codegen/tools/config.ts` (source kind `url-filters`), `src/codegen/tools/pipeline.ts` (inherits the `next-pages` folder options)
- Test: `src/codegen/tools/sources/url-filters.test.ts` (Create), `src/codegen/tools/config.test.ts`, `src/codegen/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 14 helpers, `createAppProgram` (P03), `navigationBridgeMissing`, `scanForNavigationBridge` (Task 15).
- Produces:
  - `export type FilterDomain`, `export interface FilterKey { key; domain; array?: 'comma' | 'repeat' }`, `export function mergeDomains(left, right): FilterDomain | undefined`, `export function filterKeySchema(key): JsonSchemaLike`, `export interface UrlFilterSourceOptions extends PageTreeOptions { srcDir?: string }`, `export function createUrlFilterSource(options?): ToolSource`.
  - Readings, per page view (the page file plus the app modules it imports, breadth first, depth ≤ 4, ≤ 500 files): nuqs `useQueryState(key, parser)`, `useQueryStates(map, { urlKeys })`, `createSearchParamsCache`, `createLoader`, `createSerializer` from `nuqs` or `nuqs/server` with `parseAsStringLiteral`/`parseAsStringEnum` (enum, values from literals, `as const` constants across modules or the checker type), `parseAsNumberLiteral`, `parseAsInteger`/`parseAsIndex`, `parseAsFloat`, `parseAsBoolean`, `parseAsString` (open), `parseAsArrayOf(inner, ',')` (comma) and `parseAsNativeArrayOf` (repeat), through `.withDefault`/`.withOptions`, names and spreads; a typed `searchParams` prop of the page's default export (also `Promise<…>`); `useSearchParams()` from `next/navigation` with literal `.get` (open) and `.getAll` (repeat); and `defineQueryFilters({ path, filters })` from `glirastes/browser` anywhere under the source folder (a view in its own right, `[id]` accepted as `:id`).
  - The closed reading of a key wins over an open one; enums merge; incompatible readings become open text (`filter-domain-conflict`). Other nuqs parsers (`parseAsIsoDate`, `parseAsJson`, custom) are reported (`filter-parser-unsupported`) and left out; `params` is reserved (`filter-key-reserved`).
  - One tool per view with at least one key: stable key `UI filter <path>`, id `ui.filter.<viewName>`, input `{ <keys>…, params? }` (required when the path has dynamic segments), `uiAction: { kind: 'filter', destination: path, keys }`, prose "Show the <path> page with URL filters: …", `filter-domain-open` for keys that accept any text, `navigation-bridge-missing` without a bridge. A view of an excluded page is excluded as `UI filter <path>` with the page's reason; a `defineQueryFilters` view outside the page tree (an SPA path) follows the same default and policy exclusions (`pathExclusion`, Task 14), so `PAGE /admin/**` also hides `/admin/users` filters that have no page file.

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/sources/url-filters.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createUrlFilterSource, mergeDomains } from './url-filters.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } });
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\n"
  + "import { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href: string) => router.push(href) });\n  return null;\n}\n';
const PAGE = 'export default function Page() { return null; }\n';

const FILES: Record<string, string> = {
  'tsconfig.json': TSCONFIG,
  'src/components/glirastes-bridge.tsx': BRIDGE,
  'src/lib/validations.ts': "export const TASK_STATUSES = ['open', 'done'] as const;\n",
  'src/lib/search-params.ts': "import { parseAsArrayOf, parseAsInteger, parseAsString, parseAsStringLiteral } from 'nuqs';\n"
    + "import { TASK_STATUSES } from '@/lib/validations';\n"
    + 'export const taskSearchParams = {\n  status: parseAsStringLiteral(TASK_STATUSES),\n'
    + '  page: parseAsInteger.withDefault(1),\n  tags: parseAsArrayOf(parseAsString),\n};\n',
  'src/components/task-filters.tsx': "'use client';\nimport { parseAsIsoDate, parseAsString, useQueryState, useQueryStates } from 'nuqs';\n"
    + "import { taskSearchParams } from '@/lib/search-params';\n"
    + 'export function TaskFilters() {\n  const [filters] = useQueryStates(taskSearchParams);\n'
    + "  const [q] = useQueryState('q', parseAsString.withDefault(''));\n"
    + "  const [due] = useQueryState('due', parseAsIsoDate);\n  return <p>{filters.status}{q}{String(due)}</p>;\n}\n",
  'src/app/tasks/page.tsx': "import { TaskFilters } from '@/components/task-filters';\n"
    + 'export default function TasksPage() { return <TaskFilters />; }\n',
  'src/app/reports/page.tsx': 'export default async function ReportsPage({ searchParams }: {\n'
    + "  searchParams: Promise<{ range?: 'week' | 'month'; owner?: string | string[] }>;\n}) {\n"
    + '  const { range } = await searchParams;\n  return <p>{range}</p>;\n}\n',
  'src/app/projects/[projectId]/tasks/page.tsx': "'use client';\nimport { useSearchParams } from 'next/navigation';\n"
    + 'export default function ProjectTasks() {\n  const params = useSearchParams();\n'
    + "  return <p>{params.get('sort')}{params.getAll('label').join()}</p>;\n}\n",
  'src/app/login/page.tsx': "'use client';\nimport { useSearchParams } from 'next/navigation';\n"
    + "export default function Login() { return <p>{useSearchParams().get('next')}</p>; }\n",
  'src/app/page.tsx': PAGE,
  'src/views/inbox-filters.ts': "import { defineQueryFilters } from 'glirastes/browser';\n"
    + "export const inboxFilters = defineQueryFilters({\n  path: '/inbox',\n"
    + "  filters: { state: ['new', 'read'], page: 'integer', tags: { arrayOf: 'string', format: 'repeat' } },\n});\n",
};

function context(root: string, exclude: Array<{ match: string; reason: string }> = []): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude, acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

const byKey = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.stableKey, observation] as const),
);

describe('url-filters source', () => {
  it('turns nuqs parsers, typed searchParams, useSearchParams and defineQueryFilters into one filter tool per view', async () => {
    const app = await createAppFixture(FILES);
    const observed = await createUrlFilterSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    const tools = byKey(observed.observations);
    expect([...tools.keys()]).toEqual([
      'UI filter /inbox', 'UI filter /projects/:projectId/tasks', 'UI filter /reports', 'UI filter /tasks',
    ]);
    expect(tools.get('UI filter /tasks')).toMatchObject({
      execution: { definitionId: 'ui.filter.tasks', executionKind: 'ui', actionBindingRef: 'glirastes.navigate' },
      contract: {
        source: 'ui-bridge',
        input: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            q: { type: 'string' },
            status: { type: 'string', enum: ['done', 'open'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        uiAction: {
          kind: 'filter', destination: '/tasks',
          keys: [{ key: 'page' }, { key: 'q' }, { key: 'status' }, { key: 'tags', array: 'comma' }],
        },
        params: { path: [], query: ['page', 'q', 'status', 'tags'], body: [] },
      },
      prose: {
        contractDescription: 'Show the /tasks page with URL filters: page (integer), q (text), status (done|open), tags (list of text).',
      },
    });
    expect(tools.get('UI filter /tasks')?.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['filter-parser-unsupported', 'warning'],
      ['filter-domain-open', 'warning'],
    ]);
    expect(tools.get('UI filter /reports')?.contract?.input).toEqual({
      type: 'object',
      properties: { owner: { type: 'string' }, range: { type: 'string', enum: ['month', 'week'] } },
      additionalProperties: false,
    });
    expect(tools.get('UI filter /projects/:projectId/tasks')).toMatchObject({
      execution: { definitionId: 'ui.filter.projectsTasks' },
      contract: {
        input: {
          properties: {
            label: { type: 'array', items: { type: 'string' } },
            sort: { type: 'string' },
            params: {
              type: 'object', properties: { projectId: { type: 'string', minLength: 1 } },
              required: ['projectId'], additionalProperties: false,
            },
          },
          required: ['params'],
        },
        uiAction: { destination: '/projects/:projectId/tasks', keys: [{ key: 'label', array: 'repeat' }, { key: 'sort' }] },
      },
    });
    expect(tools.get('UI filter /inbox')?.contract).toMatchObject({
      input: {
        properties: {
          page: { type: 'integer' },
          state: { type: 'string', enum: ['new', 'read'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      uiAction: { keys: [{ key: 'page' }, { key: 'state' }, { key: 'tags', array: 'repeat' }] },
    });
    expect(tools.get('UI filter /inbox')?.findings.some((finding) => finding.code === 'filter-domain-open')).toBe(true);
    expect(observed.observations.every((tool) => !tool.findings.some((finding) => finding.severity === 'needs_attention'))).toBe(true);
  }, 120_000);

  it('needs attention on every filter tool when no navigation bridge is mounted', async () => {
    const { 'src/components/glirastes-bridge.tsx': _bridge, ...files } = FILES;
    const app = await createAppFixture(files);
    const observed = await createUrlFilterSource().observe(context(app.root));
    for (const tool of observed.observations) {
      expect(tool.findings).toContainEqual(expect.objectContaining({
        code: 'navigation-bridge-missing', severity: 'needs_attention', subjectRef: tool.execution.stableKey,
      }));
    }
  }, 120_000);

  it('leaves out views of excluded pages and paths and reports unreadable definitions', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/components/glirastes-bridge.tsx': BRIDGE,
      'src/admin.ts': "import { defineQueryFilters } from 'glirastes/browser';\n"
        + "export const admin = defineQueryFilters({ path: '/login', filters: { tab: ['a', 'b'] } });\n"
        + "export const users = defineQueryFilters({ path: '/admin/users', filters: { role: ['owner'] } });\n"
        + "declare const path: string;\nexport const dynamic = defineQueryFilters({ path, filters: {} });\n",
      'src/app/login/page.tsx': PAGE,
    });
    // `/admin/users` has no page file (an SPA view); the policy exclusion still applies to it.
    const observed = await createUrlFilterSource().observe(context(app.root, [{ match: 'PAGE /admin/**', reason: 'internal' }]));
    expect(observed.observations).toEqual([]);
    expect(observed.excluded).toEqual([
      { stableKey: 'UI filter /admin/users', reason: 'internal', origin: 'policy' },
      { stableKey: 'UI filter /login', reason: 'auth-page', origin: 'default' },
    ]);
    expect(observed.findings).toEqual([expect.objectContaining({
      code: 'filter-definition-unreadable', severity: 'warning', subjectRef: 'src/admin.ts',
    })]);
  }, 120_000);
});

describe('mergeDomains', () => {
  it.each([
    [{ kind: 'string' }, { kind: 'enum', values: ['a'] }, { kind: 'enum', values: ['a'] }],
    [{ kind: 'enum', values: ['b'] }, { kind: 'enum', values: ['a', 'b'] }, { kind: 'enum', values: ['a', 'b'] }],
    [{ kind: 'integer' }, { kind: 'integer' }, { kind: 'integer' }],
    [{ kind: 'integer' }, { kind: 'boolean' }, undefined],
  ] as const)('merges %j and %j', (left, right, expected) => {
    expect(mergeDomains(left as never, right as never)).toEqual(expected);
  });
});
```

1. In `src/codegen/tools/config.test.ts`, replace:

```ts
    expect(config.ci.strict).toBe(true);
  });

  it('accepts the next-pages source with its folder options', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: ['next-app', { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] }],
    }));
    expect(normalizeSources(config)).toEqual([
      { kind: 'next-app' },
      { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
    ]);
  });

```

with:

```ts
    expect(config.ci.strict).toBe(true);
  });

  it('accepts the next-pages and url-filters sources with their folder options', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: ['next-app', { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] }, 'url-filters'],
    }));
    expect(normalizeSources(config)).toEqual([
      { kind: 'next-app' },
      { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
      { kind: 'url-filters' },
    ]);
  });

```

2. In `src/codegen/tools/config.test.ts`, replace:

```ts
    ['a strip segment that is a path', { ...minimal, sources: [{ kind: 'next-pages', stripSegments: ['a/b'] }] }],
    ['a page option on the endpoint source', { ...minimal, sources: [{ kind: 'next-app', stripSegments: [] }] }],
    ['the next-pages source twice', { ...minimal, sources: ['next-pages', { kind: 'next-pages', appDir: 'app' }] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });
```

with:

```ts
    ['a strip segment that is a path', { ...minimal, sources: [{ kind: 'next-pages', stripSegments: ['a/b'] }] }],
    ['a page option on the endpoint source', { ...minimal, sources: [{ kind: 'next-app', stripSegments: [] }] }],
    ['the next-pages source twice', { ...minimal, sources: ['next-pages', { kind: 'next-pages', appDir: 'app' }] }],
    ['the url-filters source twice', { ...minimal, sources: ['url-filters', 'url-filters'] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });
```

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).not.toContain('uiActionToolToTool');
  }, 120_000);
});
```

with:

```ts
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).not.toContain('uiActionToolToTool');
  }, 120_000);
});

describe('runToolsPipeline (filters)', () => {
  it('generates one filter tool per view, inheriting the page options of next-pages', async () => {
    const fixture = await createAppFixture({
      'src/app/[locale]/tasks/page.tsx': "'use client';\nimport { useSearchParams } from 'next/navigation';\n"
        + "export default function Tasks() { return useSearchParams().get('status'); }\n",
      'src/components/glirastes-bridge.tsx': BRIDGE,
    }, { toolsConfig: { sources: [{ kind: 'next-pages', stripSegments: ['[locale]'] }, 'url-filters'] } });
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.added).toHaveLength(2);
    const tools = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.name, tool] as const));
    expect(tools.get('ui.navigate')?.description).toBe("Open a page of this app in the user's browser. Destinations: /tasks.");
    expect(tools.get('ui.filter.tasks')).toMatchObject({
      executionKind: 'ui', actionBindingRef: 'glirastes.navigate', riskClass: 'safe-read', requiresApproval: false, enabled: true,
      description: 'Show the /tasks page with URL filters: status (text).',
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'filter-domain-open', subjectRef: 'UI filter /tasks' }));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/sources/url-filters.test.ts`
Expected: FAIL — `Cannot find module './url-filters.js'`, and `tools.json` refuses `url-filters`. `Test Files  3 failed (3)`, `Tests  2 failed | 32 passed (34)`

- [ ] **Step 3: Implement the source**

Create `src/codegen/tools/sources/url-filters.ts`:

```ts
import { join } from 'node:path';
import ts from 'typescript';
import { compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import { createAppProgram, type AppProgram } from '../program.js';
import type {
  ExcludedTool,
  JsonSchemaLike,
  ToolFinding,
  ToolProseHints,
  ToolSource,
  ToolSourceObservation,
} from '../types.js';
import { scanAppSources } from './app-files.js';
import { navigationBridgeMissing, scanForNavigationBridge } from './next-pages.js';
import { enumeratePages, pathExclusion, type PageEntry, type PageTreeOptions } from './page-tree.js';
import {
  filterStableKey,
  hasNavigationBridge,
  importBindings,
  importedCalls,
  importedName,
  incompleteUiSource,
  NAVIGATE_ACTION_BINDING,
  uiObservation,
  uniqueDefinitionIds,
  viewName,
  type ImportBindings,
} from './ui-tools.js';

export interface UrlFilterSourceOptions extends PageTreeOptions {
  /** Where `defineQueryFilters` and the navigation bridge are searched; `src` when the app has one. */
  srcDir?: string;
}

export type FilterDomain =
  | { kind: 'enum'; values: string[] }
  | { kind: 'number-enum'; values: number[] }
  | { kind: 'string' }
  | { kind: 'integer' }
  | { kind: 'number' }
  | { kind: 'boolean' };

export interface FilterKey {
  key: string;
  domain: FilterDomain;
  /** `comma`: one value joined with commas (nuqs `parseAsArrayOf`); `repeat`: the key repeats. */
  array?: 'comma' | 'repeat';
}

interface Evidence {
  keys: FilterKey[];
  /** Warnings about a key the generator could not read; bound to the view later. */
  notes: Array<{ code: string; message: string }>;
}

const NUQS_STATE = ['useQueryState', 'useQueryStates', 'createSearchParamsCache', 'createLoader', 'createSerializer'];
const SIMPLE_PARSERS: Readonly<Record<string, FilterDomain>> = {
  parseAsString: { kind: 'string' },
  parseAsInteger: { kind: 'integer' },
  parseAsIndex: { kind: 'integer' },
  parseAsFloat: { kind: 'number' },
  parseAsBoolean: { kind: 'boolean' },
};
const LITERAL_PARSERS: ReadonlySet<string> = new Set(['parseAsStringLiteral', 'parseAsStringEnum', 'parseAsNumberLiteral']);
const ARRAY_PARSERS: Readonly<Record<string, 'comma' | 'repeat'>> = { parseAsArrayOf: 'comma', parseAsNativeArrayOf: 'repeat' };
/** Every nuqs export the source reads; anything else imported from nuqs is reported, not guessed. */
const NUQS_NAMES = [
  ...NUQS_STATE, ...Object.keys(SIMPLE_PARSERS), ...LITERAL_PARSERS, ...Object.keys(ARRAY_PARSERS),
  'parseAsIsoDate', 'parseAsIsoDateTime', 'parseAsTimestamp', 'parseAsJson', 'parseAsHex', 'createParser',
];
const NUQS_SPECS = ['nuqs', 'nuqs/server'].map((module) => ({ module, names: NUQS_NAMES }));
const SEARCH_PARAMS_SPECS = [{ module: 'next/navigation', names: ['useSearchParams'] }];
const DEFINE_SPECS = [{ module: 'glirastes/browser', names: ['defineQueryFilters'] }];
const MAX_DEPTH = 6;
const MAX_IMPORT_DEPTH = 4;
const MAX_FILES_PER_VIEW = 500;
const SCALAR_KINDS: ReadonlySet<string> = new Set(['string', 'integer', 'number', 'boolean']);

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteral(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function sortedUnique<T extends string | number>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)].sort((left, right) => (
    typeof left === 'number' && typeof right === 'number' ? left - right : compareCodeUnits(String(left), String(right))
  ));
}

/** Two readings of one key: the closed one wins; incompatible ones become open text. */
export function mergeDomains(left: FilterDomain, right: FilterDomain): FilterDomain | undefined {
  if (left.kind === 'string') return right;
  if (right.kind === 'string') return left;
  if (left.kind === 'enum' && right.kind === 'enum') return { kind: 'enum', values: sortedUnique([...left.values, ...right.values]) };
  if (left.kind === 'number-enum' && right.kind === 'number-enum') {
    return { kind: 'number-enum', values: sortedUnique([...left.values, ...right.values]) };
  }
  return left.kind === right.kind ? left : undefined;
}

function scalarSchema(domain: FilterDomain): JsonSchemaLike {
  switch (domain.kind) {
    case 'enum':
      return { type: 'string', enum: domain.values };
    case 'number-enum':
      return { type: 'number', enum: domain.values };
    default:
      return { type: domain.kind };
  }
}

export function filterKeySchema(key: FilterKey): JsonSchemaLike {
  const scalar = scalarSchema(key.domain);
  return key.array ? { type: 'array', items: scalar } : scalar;
}

/** Reads nuqs parsers, typed `searchParams` and `useSearchParams()` through one bounded program. */
class FilterReader {
  private readonly bindings = new Map<ts.SourceFile, ImportBindings>();

  constructor(private readonly app: AppProgram) {}

  private nuqs(file: ts.SourceFile): ImportBindings {
    let bindings = this.bindings.get(file);
    if (!bindings) {
      bindings = importBindings(file, NUQS_SPECS);
      this.bindings.set(file, bindings);
    }
    return bindings;
  }

  private nuqsName(node: ts.Node): string | undefined {
    return importedName(node, this.nuqs(node.getSourceFile()));
  }

  /** The expression a name stands for: a variable initializer, also across app modules. */
  private initializerOf(node: ts.Expression): ts.Expression | undefined {
    const checker = this.app.checker;
    let symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) return declaration.initializer;
    if (ts.isShorthandPropertyAssignment(declaration)) return declaration.name;
    return undefined;
  }

  private literalValues(raw: ts.Expression | undefined, kind: 'string' | 'number', depth = 0): Array<string | number> | undefined {
    if (!raw || depth > MAX_DEPTH) return undefined;
    const expression = unwrap(raw);
    if (ts.isArrayLiteralExpression(expression)) {
      const values: Array<string | number> = [];
      for (const element of expression.elements) {
        const value = unwrap(element as ts.Expression);
        if (kind === 'string' && ts.isStringLiteralLike(value)) values.push(value.text);
        else if (kind === 'number' && ts.isNumericLiteral(value)) values.push(Number(value.text));
        else return undefined;
      }
      return values.length > 0 ? values : undefined;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const initializer = this.initializerOf(expression);
      const fromSyntax = initializer ? this.literalValues(initializer, kind, depth + 1) : undefined;
      if (fromSyntax) return fromSyntax;
    }
    return this.literalValuesOfType(this.app.checker.getTypeAtLocation(expression), kind);
  }

  private literalValuesOfType(type: ts.Type, kind: 'string' | 'number'): Array<string | number> | undefined {
    const checker = this.app.checker;
    const elements = checker.isTupleType(type)
      ? checker.getTypeArguments(type as ts.TypeReference)
      : checker.isArrayType(type) ? checker.getTypeArguments(type as ts.TypeReference) : [];
    const members = elements.flatMap((element) => (element.isUnion() ? element.types : [element]));
    if (members.length === 0) return undefined;
    const values: Array<string | number> = [];
    for (const member of members) {
      if (kind === 'string' && member.isStringLiteral()) values.push(member.value);
      else if (kind === 'number' && member.isNumberLiteral()) values.push(member.value);
      else return undefined;
    }
    return values;
  }

  /** A nuqs parser expression → domain; `undefined` for a parser this source does not read. */
  parser(raw: ts.Expression, notes: Evidence['notes'], key: string, depth = 0): Omit<FilterKey, 'key'> | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const expression = unwrap(raw);
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      if (ts.isPropertyAccessExpression(callee) && ['withDefault', 'withOptions'].includes(callee.name.text)) {
        return this.parser(callee.expression, notes, key, depth + 1);
      }
      const name = this.nuqsName(callee);
      if (name !== undefined && LITERAL_PARSERS.has(name)) {
        const numeric = name === 'parseAsNumberLiteral';
        const values = this.literalValues(expression.arguments[0], numeric ? 'number' : 'string');
        if (!values) return { domain: { kind: numeric ? 'number' : 'string' } };
        return numeric
          ? { domain: { kind: 'number-enum', values: sortedUnique(values as number[]) } }
          : { domain: { kind: 'enum', values: sortedUnique(values as string[]) } };
      }
      if (name !== undefined && Object.hasOwn(ARRAY_PARSERS, name)) {
        const separator = expression.arguments[1];
        if (separator && stringLiteral(separator) !== ',') {
          notes.push({ code: 'filter-parser-unsupported', message: `${key} uses parseAsArrayOf with a custom separator.` });
          return undefined;
        }
        const inner = expression.arguments[0] ? this.parser(expression.arguments[0], notes, key, depth + 1) : undefined;
        if (!inner || inner.array) return undefined;
        return { domain: inner.domain, array: ARRAY_PARSERS[name]! };
      }
      if (name !== undefined) {
        notes.push({ code: 'filter-parser-unsupported', message: `${key} uses ${name}, which the chat cannot set.` });
        return undefined;
      }
      notes.push({ code: 'filter-parser-unsupported', message: `${key} uses a custom parser.` });
      return undefined;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const name = this.nuqsName(expression);
      if (name !== undefined) {
        if (Object.hasOwn(SIMPLE_PARSERS, name)) return { domain: SIMPLE_PARSERS[name]! };
        notes.push({ code: 'filter-parser-unsupported', message: `${key} uses ${name}, which the chat cannot set.` });
        return undefined;
      }
      const initializer = this.initializerOf(expression);
      if (initializer) return this.parser(initializer, notes, key, depth + 1);
    }
    notes.push({ code: 'filter-definition-unreadable', message: `The parser of ${key} cannot be read from code.` });
    return undefined;
  }

  /** `{ status: parseAs…, page: parseAs… }`, also behind a name or spread. */
  private parserMap(raw: ts.Expression | undefined, notes: Evidence['notes'], depth = 0): Array<{ key: string; parser: ts.Expression }> {
    if (!raw || depth > MAX_DEPTH) return [];
    const expression = unwrap(raw);
    if (ts.isObjectLiteralExpression(expression)) {
      const entries: Array<{ key: string; parser: ts.Expression }> = [];
      for (const property of expression.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = propertyName(property.name);
          if (key !== undefined) {
            entries.push({ key, parser: property.initializer });
            continue;
          }
        } else if (ts.isShorthandPropertyAssignment(property)) {
          entries.push({ key: property.name.text, parser: property.name });
          continue;
        } else if (ts.isSpreadAssignment(property)) {
          entries.push(...this.parserMap(property.expression, notes, depth + 1));
          continue;
        }
        notes.push({ code: 'filter-definition-unreadable', message: 'A URL parameter map has an entry that is not a plain key.' });
      }
      return entries;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      return this.parserMap(this.initializerOf(expression), notes, depth + 1);
    }
    notes.push({ code: 'filter-definition-unreadable', message: 'A URL parameter map cannot be read from code.' });
    return [];
  }

  private urlKeys(options: ts.Expression | undefined): Map<string, string> {
    const keys = new Map<string, string>();
    const value = options ? unwrap(options) : undefined;
    if (!value || !ts.isObjectLiteralExpression(value)) return keys;
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'urlKeys') continue;
      const map = unwrap(property.initializer);
      if (!ts.isObjectLiteralExpression(map)) continue;
      for (const entry of map.properties) {
        if (!ts.isPropertyAssignment(entry)) continue;
        const from = propertyName(entry.name);
        const to = stringLiteral(entry.initializer);
        if (from !== undefined && to !== undefined) keys.set(from, to);
      }
    }
    return keys;
  }

  private nuqsKeys(file: ts.SourceFile, evidence: Evidence): void {
    for (const { name, call } of importedCalls(file, NUQS_SPECS)) {
      if (name === 'useQueryState') {
        const key = stringLiteral(call.arguments[0]);
        if (key === undefined) {
          evidence.notes.push({ code: 'filter-definition-unreadable', message: 'useQueryState is called with a key that is not a literal.' });
          continue;
        }
        const parsed = call.arguments[1] ? this.parser(call.arguments[1], evidence.notes, key) : { domain: { kind: 'string' } as const };
        if (parsed) evidence.keys.push({ key, ...parsed });
      } else if (NUQS_STATE.includes(name)) {
        const renamed = this.urlKeys(call.arguments[1]);
        for (const entry of this.parserMap(call.arguments[0], evidence.notes)) {
          const key = renamed.get(entry.key) ?? entry.key;
          const parsed = this.parser(entry.parser, evidence.notes, key);
          if (parsed) evidence.keys.push({ key, ...parsed });
        }
      }
    }
  }

  private searchParamsKeys(file: ts.SourceFile, evidence: Evidence): void {
    const calls = importedCalls(file, SEARCH_PARAMS_SPECS).map(({ call }) => call);
    if (calls.length === 0) return;
    const checker = this.app.checker;
    const holders = new Set<ts.Symbol>();
    for (const call of calls) {
      const parent = call.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === call && ts.isIdentifier(parent.name)) {
        const symbol = checker.getSymbolAtLocation(parent.name);
        if (symbol) holders.add(symbol);
      }
    }
    const callSet = new Set<ts.Node>(calls);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['get', 'getAll'].includes(node.expression.name.text)) {
        const target = unwrap(node.expression.expression);
        const symbol = ts.isIdentifier(target) ? checker.getSymbolAtLocation(target) : undefined;
        if (callSet.has(target) || (symbol && holders.has(symbol))) {
          const key = stringLiteral(node.arguments[0]);
          if (key !== undefined) {
            evidence.keys.push(node.expression.name.text === 'getAll'
              ? { key, domain: { kind: 'string' }, array: 'repeat' }
              : { key, domain: { kind: 'string' } });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  private typeDomain(type: ts.Type): Omit<FilterKey, 'key'> | undefined {
    const checker = this.app.checker;
    const members = (type.isUnion() ? type.types : [type])
      .filter((member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    if (members.length === 0) return undefined;
    const scalars = members.filter((member) => !checker.isArrayType(member));
    const arrays = members.filter((member) => checker.isArrayType(member));
    const elementTypes = arrays.flatMap((member) => checker.getTypeArguments(member as ts.TypeReference))
      .flatMap((element) => (element.isUnion() ? element.types : [element]));
    const all = [...scalars, ...elementTypes];
    if (all.some((member) => member.flags & ts.TypeFlags.String)) {
      return scalars.length === 0 ? { domain: { kind: 'string' }, array: 'repeat' } : { domain: { kind: 'string' } };
    }
    if (all.length > 0 && all.every((member) => member.isStringLiteral())) {
      const domain: FilterDomain = { kind: 'enum', values: sortedUnique(all.map((member) => (member as ts.StringLiteralType).value)) };
      return scalars.length === 0 ? { domain, array: 'repeat' } : { domain };
    }
    return undefined;
  }

  /** Keys of a typed `searchParams` prop of the page's default export. */
  private typedSearchParams(file: ts.SourceFile, evidence: Evidence): void {
    const component = defaultExportFunction(file);
    const parameter = component?.parameters[0];
    if (!parameter) return;
    const checker = this.app.checker;
    const props = checker.getTypeAtLocation(parameter);
    const property = checker.getPropertyOfType(props, 'searchParams');
    if (!property) return;
    const declared = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, parameter));
    const params = checker.getAwaitedType(declared) ?? declared;
    for (const entry of checker.getPropertiesOfType(params)) {
      const parsed = this.typeDomain(checker.getTypeOfSymbolAtLocation(entry, parameter));
      if (parsed) evidence.keys.push({ key: entry.name, ...parsed });
      else evidence.notes.push({ code: 'filter-parser-unsupported', message: `searchParams.${entry.name} has a type the chat cannot set.` });
    }
  }

  evidenceOf(file: ts.SourceFile, page: boolean): Evidence {
    const evidence: Evidence = { keys: [], notes: [] };
    this.nuqsKeys(file, evidence);
    this.searchParamsKeys(file, evidence);
    if (page) this.typedSearchParams(file, evidence);
    return evidence;
  }

  /** The page file and the app modules it imports, breadth first and bounded. */
  viewFiles(page: ts.SourceFile): ts.SourceFile[] {
    const checker = this.app.checker;
    const seen = new Set<ts.SourceFile>([page]);
    let frontier = [page];
    for (let depth = 0; depth < MAX_IMPORT_DEPTH && frontier.length > 0; depth += 1) {
      const next: ts.SourceFile[] = [];
      for (const file of frontier) {
        for (const statement of file.statements) {
          const specifier = (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly)
            || (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
            ? statement.moduleSpecifier
            : undefined;
          if (!specifier) continue;
          const module = checker.getSymbolAtLocation(specifier);
          const declaration = module?.valueDeclaration ?? module?.declarations?.[0];
          if (!declaration || !ts.isSourceFile(declaration) || seen.has(declaration)) continue;
          if (this.app.appRelative(declaration.fileName) === undefined) continue;
          if (seen.size >= MAX_FILES_PER_VIEW) return [...seen];
          seen.add(declaration);
          next.push(declaration);
        }
      }
      frontier = next;
    }
    return [...seen];
  }

  /** `defineQueryFilters({ path, filters })` literals of `glirastes/browser`. */
  definitions(file: ts.SourceFile, notes: Array<{ file: string; code: string; message: string }>): Array<{ path: string; keys: FilterKey[] }> {
    const definitions: Array<{ path: string; keys: FilterKey[] }> = [];
    const local = this.app.appRelative(file.fileName) ?? file.fileName;
    for (const { call } of importedCalls(file, DEFINE_SPECS)) {
      let argument = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
      if (argument && (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument))) {
        const initializer = this.initializerOf(argument);
        argument = initializer ? unwrap(initializer) : undefined;
      }
      const property = (name: string) => (argument && ts.isObjectLiteralExpression(argument)
        ? argument.properties.find((entry): entry is ts.PropertyAssignment => (
          ts.isPropertyAssignment(entry) && propertyName(entry.name) === name))
        : undefined);
      const path = stringLiteral(property('path')?.initializer);
      const filters = property('filters')?.initializer;
      const map = filters ? unwrap(filters) : undefined;
      if (path === undefined || !path.startsWith('/') || !map || !ts.isObjectLiteralExpression(map)) {
        notes.push({ file: local, code: 'filter-definition-unreadable', message: 'A defineQueryFilters call has no literal path and filters.' });
        continue;
      }
      const keys: FilterKey[] = [];
      for (const entry of map.properties) {
        const key = ts.isPropertyAssignment(entry) ? propertyName(entry.name) : undefined;
        const spec = key !== undefined && ts.isPropertyAssignment(entry) ? specKey(key, entry.initializer) : undefined;
        if (spec) keys.push(spec);
        else notes.push({ file: local, code: 'filter-definition-unreadable', message: `A filter of ${path} is not a literal spec.` });
      }
      definitions.push({ path: normalizedDefinitionPath(path), keys });
    }
    return definitions;
  }
}

function scalarSpec(raw: ts.Expression): FilterDomain | undefined {
  const expression = unwrap(raw);
  const kind = stringLiteral(expression);
  if (kind !== undefined) return SCALAR_KINDS.has(kind) ? { kind: kind as 'string' | 'integer' | 'number' | 'boolean' } : undefined;
  if (ts.isArrayLiteralExpression(expression)) {
    const values = expression.elements.map((element) => stringLiteral(element as ts.Expression));
    if (values.length === 0 || values.some((value) => value === undefined || value.length === 0)) return undefined;
    return { kind: 'enum', values: sortedUnique(values as string[]) };
  }
  return undefined;
}

function specKey(key: string, raw: ts.Expression): FilterKey | undefined {
  const expression = unwrap(raw);
  if (ts.isObjectLiteralExpression(expression)) {
    const get = (name: string) => expression.properties.find((entry): entry is ts.PropertyAssignment => (
      ts.isPropertyAssignment(entry) && propertyName(entry.name) === name))?.initializer;
    const inner = get('arrayOf');
    const domain = inner ? scalarSpec(inner) : undefined;
    const format = get('format') ? stringLiteral(get('format')) : 'comma';
    if (!domain || (format !== 'comma' && format !== 'repeat')) return undefined;
    return { key, domain, array: format };
  }
  const domain = scalarSpec(expression);
  return domain ? { key, domain } : undefined;
}

/** `/projects/[projectId]` is accepted like `/projects/:projectId`. */
function normalizedDefinitionPath(path: string): string {
  return path.split('/').map((segment) => segment.replace(/^\[([^\].]+)\]$/, ':$1')).join('/');
}

function defaultExportFunction(file: ts.SourceFile): ts.SignatureDeclaration | undefined {
  const locals = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) locals.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) locals.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const asFunction = (node: ts.Node | undefined): ts.SignatureDeclaration | undefined => {
    if (!node) return undefined;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
    if (ts.isParenthesizedExpression(node)) return asFunction(node.expression);
    if (ts.isIdentifier(node)) return asFunction(locals.get(node.text));
    return undefined;
  };
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return asFunction(statement.expression);
  }
  return undefined;
}

interface View {
  path: string;
  params: string[];
  keys: Map<string, FilterKey>;
  notes: Array<{ code: string; message: string }>;
}

function describeKey(key: FilterKey, german: boolean): string {
  const domain = key.domain;
  const scalar = domain.kind === 'enum' || domain.kind === 'number-enum'
    ? domain.values.join('|')
    : german
      ? { string: 'Text', integer: 'Ganzzahl', number: 'Zahl', boolean: 'ja/nein' }[domain.kind]
      : { string: 'text', integer: 'integer', number: 'number', boolean: 'true/false' }[domain.kind];
  return `${key.key} (${key.array ? `${german ? 'Liste von' : 'list of'} ${scalar}` : scalar})`;
}

function filterProse(locale: string, view: View, keys: ReadonlyArray<FilterKey>): ToolProseHints {
  const german = locale.toLowerCase().startsWith('de');
  const listed = keys.map((key) => describeKey(key, german)).join(', ');
  const params = view.params.map((name) => `params.${name}`).join(', ');
  const label = (text: string) => (text.length <= 200 ? text : `${text.slice(0, 199)}…`);
  return german
    ? {
      contractDescription: `Zeigt die Seite ${view.path} mit URL-Filtern: ${listed}.${params ? ` Braucht ${params}.` : ''}`,
      presentation: { locale, singular: label(`${view.path} filtern`), plural: label(`${view.path} filtern`), approval: label(`${view.path} filtern`) },
    }
    : {
      contractDescription: `Show the ${view.path} page with URL filters: ${listed}.${params ? ` Needs ${params}.` : ''}`,
      presentation: { locale, singular: label(`Filter ${view.path}`), plural: label(`Filter ${view.path}`), approval: label(`Filter ${view.path}`) },
    };
}

function addKey(view: View, key: FilterKey): void {
  if (key.key === 'params') {
    view.notes.push({ code: 'filter-key-reserved', message: 'The URL parameter params is reserved for route parameters.' });
    return;
  }
  const existing = view.keys.get(key.key);
  if (!existing) {
    view.keys.set(key.key, key);
    return;
  }
  const domain = mergeDomains(existing.domain, key.domain);
  if (!domain || (existing.array ?? null) !== (key.array ?? null)) {
    view.keys.set(key.key, { key: key.key, domain: { kind: 'string' }, ...(existing.array ? { array: existing.array } : {}) });
    view.notes.push({ code: 'filter-domain-conflict', message: `${key.key} is read with different parsers; it accepts any text.` });
    return;
  }
  view.keys.set(key.key, { ...existing, domain });
}

function pathParams(path: string): string[] {
  return path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
}

async function observeFilters(
  root: string,
  locale: string,
  options: UrlFilterSourceOptions,
  policyExcludes: ReadonlyArray<{ match: string; reason: string }>,
): Promise<ToolSourceObservation> {
  const tree = await enumeratePages(root, options, policyExcludes);
  if (!tree.complete) return incompleteUiSource('url-filters', tree.reason);
  const defined = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: (source) => source.includes('defineQueryFilters'),
  });
  if (!defined.complete) return incompleteUiSource('url-filters', defined.reason);
  if (tree.pages.length === 0 && defined.files.length === 0) {
    return { observations: [], findings: [], complete: true, excluded: [] };
  }
  const app = createAppProgram({
    root,
    rootNames: [
      ...tree.pages.map((page) => join(root, page.file)),
      ...defined.files.map((file) => file.absolute),
    ],
  });
  const reader = new FilterReader(app);
  const views = new Map<string, View>();
  const viewOf = (path: string, params: string[]): View => {
    let view = views.get(path);
    if (!view) {
      view = { path, params, keys: new Map(), notes: [] };
      views.set(path, view);
    }
    return view;
  };
  const evidenceCache = new Map<ts.SourceFile, Evidence>();
  const evidence = (file: ts.SourceFile, page: boolean): Evidence => {
    if (page) return reader.evidenceOf(file, true);
    let cached = evidenceCache.get(file);
    if (!cached) {
      cached = reader.evidenceOf(file, false);
      evidenceCache.set(file, cached);
    }
    return cached;
  };
  for (const page of tree.pages as ReadonlyArray<PageEntry>) {
    const source = app.sourceFile(join(root, page.file));
    if (!source) continue;
    const found: Evidence = { keys: [], notes: [] };
    for (const file of reader.viewFiles(source)) {
      const part = evidence(file, file === source);
      found.keys.push(...part.keys);
      found.notes.push(...part.notes);
    }
    if (found.keys.length === 0 && found.notes.length === 0) continue;
    const view = viewOf(page.path, page.params);
    for (const key of found.keys) addKey(view, key);
    view.notes.push(...found.notes);
  }
  const findings: ToolFinding[] = [];
  const definitionNotes: Array<{ file: string; code: string; message: string }> = [];
  const excludedPaths = new Map(tree.excluded.map((entry) => [entry.stableKey.slice('PAGE '.length), entry] as const));
  const excluded: ExcludedTool[] = [];
  for (const file of defined.files) {
    const source = app.sourceFile(file.absolute);
    if (!source) continue;
    for (const definition of reader.definitions(source, definitionNotes)) {
      // A view outside the page tree (an SPA path) follows the same default and policy exclusions.
      const pageExclusion = excludedPaths.get(definition.path) ?? pathExclusion(definition.path, policyExcludes);
      if (pageExclusion) {
        excluded.push({ stableKey: filterStableKey(definition.path), reason: pageExclusion.reason, origin: pageExclusion.origin });
        continue;
      }
      const view = viewOf(definition.path, pathParams(definition.path));
      for (const key of definition.keys) addKey(view, key);
    }
  }
  excluded.sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  for (const note of definitionNotes) findings.push(toolFinding(note.code, 'warning', note.file, note.message));

  const withKeys = [...views.values()].filter((view) => view.keys.size > 0)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  for (const view of views.values()) {
    if (view.keys.size === 0) {
      for (const note of view.notes) findings.push(toolFinding(note.code, 'warning', filterStableKey(view.path), note.message));
    }
  }
  if (withKeys.length === 0) return { observations: [], findings, complete: true, excluded };
  const bridge = await scanForNavigationBridge(root, options.srcDir);
  if (!bridge.complete) return incompleteUiSource('url-filters', bridge.reason);
  const bridged = hasNavigationBridge(bridge.files);
  const ids = uniqueDefinitionIds(withKeys.map((view) => ({
    stableKey: filterStableKey(view.path), base: `ui.filter.${viewName(view.path)}`,
  })));
  const observations = withKeys.map((view) => {
    const stableKey = filterStableKey(view.path);
    const keys = [...view.keys.values()].sort((left, right) => compareCodeUnits(left.key, right.key));
    const open = keys.filter((key) => key.domain.kind === 'string').map((key) => key.key);
    const toolFindings: ToolFinding[] = [
      ...view.notes.map((note) => toolFinding(note.code, 'warning', stableKey, note.message)),
      ...(open.length > 0
        ? [toolFinding('filter-domain-open', 'warning', stableKey, `${open.join(', ')} accept any text.`)]
        : []),
      ...(bridged ? [] : [navigationBridgeMissing(stableKey)]),
    ];
    const input: JsonSchemaLike = {
      type: 'object',
      properties: {
        ...Object.fromEntries(keys.map((key) => [key.key, filterKeySchema(key)])),
        ...(view.params.length > 0
          ? {
            params: {
              type: 'object',
              properties: Object.fromEntries(view.params.map((name) => [name, { type: 'string', minLength: 1 }])),
              required: [...view.params],
              additionalProperties: false,
            },
          }
          : {}),
      },
      ...(view.params.length > 0 ? { required: ['params'] } : {}),
      additionalProperties: false,
    };
    return uiObservation({
      stableKey,
      definitionId: ids.get(stableKey)!,
      actionBindingRef: NAVIGATE_ACTION_BINDING,
      input,
      uiAction: {
        kind: 'filter',
        destination: view.path,
        keys: keys.map((key) => ({ key: key.key, ...(key.array ? { array: key.array } : {}) })),
      },
      params: { path: [...view.params], query: keys.map((key) => key.key), body: [] },
      facts: { path: view.path, params: view.params, keys },
      findings: toolFindings,
      prose: filterProse(locale, view, keys),
    });
  });
  return { observations, findings, complete: true, excluded };
}

/**
 * The `url-filters` source: one `ui.filter.<view>` tool per page or
 * `defineQueryFilters` view whose URL filters the code reads (nuqs parsers,
 * typed `searchParams`, `useSearchParams().get`), executed by the navigation
 * bridge as a URL push.
 */
export function createUrlFilterSource(options: UrlFilterSourceOptions = {}): ToolSource {
  return {
    kind: 'url-filters',
    observe: (ctx) => observeFilters(ctx.root, ctx.config.locale, options, ctx.policy.exclude ?? []),
  };
}
```

- [ ] **Step 4: Accept the source and pass it the page options**

1. In `src/codegen/tools/config.ts`, replace:

```ts
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app', 'next-pages']);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
```

with:

```ts
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app', 'next-pages', 'url-filters']);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
```

2. In `src/codegen/tools/config.ts`, replace:

```ts
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
```

with:

```ts
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
  z.object({
    kind: z.literal('url-filters'),
    appDir: appPath.optional(),
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages', 'url-filters'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
```

3. In `src/codegen/tools/config.ts`, replace:

```ts
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ToolSourceConfig =
  | { kind: 'next-app'; apiDir?: string }
  | { kind: 'next-pages'; appDir?: string; srcDir?: string; stripSegments?: string[] };

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
```

with:

```ts
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ToolSourceConfig =
  | { kind: 'next-app'; apiDir?: string }
  | { kind: 'next-pages' | 'url-filters'; appDir?: string; srcDir?: string; stripSegments?: string[] };

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
```

1. In `src/codegen/tools/pipeline.ts`, replace:

```ts
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import {
  readPreviousToolState,
  renderInventory,
```

with:

```ts
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import { createUrlFilterSource } from './sources/url-filters.js';
import {
  readPreviousToolState,
  renderInventory,
```

2. In `src/codegen/tools/pipeline.ts`, replace:

```ts
  }
}

/** One source per configured entry of `tools.json` `sources`. */
export function createConfiguredSources(config: ToolsConfig): ToolSource[] {
  return normalizeSources(config).map((source) => {
    switch (source.kind) {
      case 'next-app':
        return createNextEndpointSource(source.apiDir ? { apiDir: source.apiDir } : {});
      case 'next-pages':
        return createNextPagesSource(source);
    }
  });
}
```

with:

```ts
  }
}

/**
 * One source per configured entry of `tools.json` `sources`. URL filters read
 * the same page tree as navigation, so they inherit its folder options.
 */
export function createConfiguredSources(config: ToolsConfig): ToolSource[] {
  const sources = normalizeSources(config);
  const pages = sources.find((source) => source.kind === 'next-pages');
  return sources.map((source) => {
    switch (source.kind) {
      case 'next-app':
        return createNextEndpointSource(source.apiDir ? { apiDir: source.apiDir } : {});
      case 'next-pages':
        return createNextPagesSource(source);
      case 'url-filters':
        return createUrlFilterSource({
          ...(pages && pages.kind !== 'next-app' ? pages : {}),
          ...source,
        });
    }
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/sources/url-filters.test.ts && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  41 passed (41)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/config.test.ts src/codegen/tools/config.ts src/codegen/tools/pipeline.test.ts \
  src/codegen/tools/pipeline.ts src/codegen/tools/sources/url-filters.test.ts \
  src/codegen/tools/sources/url-filters.ts
git commit -m "feat(codegen): generate ui.filter tools from url filters"
```

### Task 17: `ui.<actionId>` from client action registrations

**Files:**
- Create: `src/codegen/tools/sources/react-actions.ts`
- Modify: `src/codegen/tools/config.ts` (source kind `react-actions`), `src/codegen/tools/pipeline.ts`
- Test: `src/codegen/tools/sources/react-actions.test.ts` (Create), `src/codegen/tools/config.test.ts`, `src/codegen/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 14 helpers, `typeToJsonSchema` (P03 `output-inference.ts`), `createAppProgram`.
- Produces:
  - `export interface ReactActionSourceOptions { srcDir?: string }`, `export function createReactActionSource(options?): ToolSource`.
  - Registrations with a literal id: `useAiClientAction(id, handler, contract?)` and `useAiClientActionById(bus, id, handler)` from `glirastes/react`, `registerAiClientAction(id, handler, contract?)` from `glirastes/browser`, and `<bus>.subscribeById(id, handler)` in files that import either module. A non-literal id is `ui-action-id-dynamic`, a `glirastes.*` id `ui-action-id-reserved`, an id that cannot form a tool name `ui-action-id-invalid` (all warnings with `file:line` or file, no tool).
  - Payload: the contract's checker output type (`_output`, so an inline or imported Zod object works without importing a client module), else the handler's first parameter type (`.payload` of it for action-style handlers), else untyped (`ui-action-payload-untyped`, no contract, tool disabled). A handler without parameters has the empty payload. Different payloads for one id are `ui-action-contract-conflict`.
  - One tool per id: stable key `UI action <id>`, id from `uiDefinitionIdForAction`, action binding `<id>`, `uiAction: { kind: 'client-action', actionId }`, JSDoc of the registration statement (or of a named handler) as description, `uiMutation` from a writing `fetch`/`axios` call in the handler.

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/sources/react-actions.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createReactActionSource } from './react-actions.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve' } });
const TASK_LIST = "'use client';\nimport { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"
  + 'export const highlightTask = z.object({ taskId: z.string() }).strict();\n'
  + 'export function TaskList() {\n'
  + '  /** Highlights a task in the visible list. */\n'
  + "  useAiClientAction('tasks.highlight', (payload) => { console.log(payload); }, highlightTask);\n"
  + "  useAiClientAction('dialogs.close', () => {});\n"
  + "  useAiClientAction('tasks.archive', async (payload: { taskId: string; reason?: string }) => {\n"
  + "    await fetch(`/api/tasks/${payload.taskId}/archive`, { method: 'POST' });\n  });\n"
  + "  useAiClientAction('tasks.select', (payload) => console.log(payload));\n"
  + "  const id = 'dynamic';\n  useAiClientAction(id, () => {});\n  return null;\n}\n";
const BROWSER = "import { registerAiClientAction, UiActionBus } from 'glirastes/browser';\n"
  + 'const bus = new UiActionBus();\n'
  + 'export function openDetails(payload: { taskId: string }) { console.log(payload.taskId); }\n'
  + "registerAiClientAction('task-details.open', openDetails);\n"
  + "bus.subscribeById('reports.export', (action: { payload: { format: 'csv' | 'pdf' } }) => console.log(action));\n"
  + "bus.subscribeById('glirastes.navigate', () => {});\n";

function context(root: string): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

const byName = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.definitionId, observation] as const),
);
const object = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false,
});

describe('react-actions source', () => {
  it('turns every literal client action into a tool typed by its contract or handler', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/components/task-list.tsx': TASK_LIST,
      'src/lib/browser-actions.ts': BROWSER,
    });
    const observed = await createReactActionSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    const tools = byName(observed.observations);
    expect([...tools.keys()]).toEqual([
      'ui.dialogs.close', 'ui.reports.export', 'ui.taskDetails.open', 'ui.tasks.archive', 'ui.tasks.highlight', 'ui.tasks.select',
    ]);
    expect(tools.get('ui.tasks.highlight')).toMatchObject({
      execution: { stableKey: 'UI action tasks.highlight', executionKind: 'ui', actionBindingRef: 'tasks.highlight' },
      contract: {
        source: 'ui-bridge',
        input: object({ taskId: { type: 'string' } }, ['taskId']),
        uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
        params: { path: [], query: [], body: ['taskId'] },
      },
      evidence: { jsDoc: 'Highlights a task in the visible list.' },
      findings: [],
    });
    expect(tools.get('ui.dialogs.close')?.contract?.input).toEqual(object({}));
    expect(tools.get('ui.tasks.archive')).toMatchObject({
      contract: { input: object({ reason: { type: 'string' }, taskId: { type: 'string' } }, ['taskId']) },
      evidence: { uiMutation: true },
    });
    expect(tools.get('ui.taskDetails.open')?.contract?.input).toEqual(object({ taskId: { type: 'string' } }, ['taskId']));
    expect(tools.get('ui.reports.export')?.contract?.input)
      .toEqual(object({ format: { type: 'string', enum: ['csv', 'pdf'] } }, ['format']));
    expect(tools.get('ui.tasks.select')).toMatchObject({
      findings: [expect.objectContaining({ code: 'ui-action-payload-untyped', severity: 'needs_attention' })],
    });
    expect(tools.get('ui.tasks.select')?.contract).toBeUndefined();
    expect(observed.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['ui-action-id-dynamic', 'src/components/task-list.tsx:14'],
      ['ui-action-id-reserved', 'src/lib/browser-actions.ts:6'],
    ]);
  }, 120_000);

  it('needs attention when one action is registered with two payload contracts', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + "export function A() { useAiClientAction('tasks.pick', (payload: { taskId: string }) => {}); return null; }\n",
      'src/b.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + "export function B() { useAiClientAction('tasks.pick', (payload: { id: number }) => {}); return null; }\n",
    });
    const [tool] = (await createReactActionSource().observe(context(app.root))).observations;
    expect(tool?.findings).toEqual([expect.objectContaining({ code: 'ui-action-contract-conflict', severity: 'needs_attention' })]);
  }, 120_000);

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
```

1. In `src/codegen/tools/config.test.ts`, replace:

```ts
    expect(config.ci.strict).toBe(true);
  });

  it('accepts the next-pages and url-filters sources with their folder options', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: ['next-app', { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] }, 'url-filters'],
    }));
    expect(normalizeSources(config)).toEqual([
      { kind: 'next-app' },
      { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
      { kind: 'url-filters' },
    ]);
  });

```

with:

```ts
    expect(config.ci.strict).toBe(true);
  });

  it('accepts the UI sources with their folder options', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: [
        'next-app',
        { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
        'url-filters',
        { kind: 'react-actions', srcDir: 'src' },
      ],
    }));
    expect(normalizeSources(config)).toEqual([
      { kind: 'next-app' },
      { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
      { kind: 'url-filters' },
      { kind: 'react-actions', srcDir: 'src' },
    ]);
  });

```

2. In `src/codegen/tools/config.test.ts`, replace:

```ts
    ['a page option on the endpoint source', { ...minimal, sources: [{ kind: 'next-app', stripSegments: [] }] }],
    ['the next-pages source twice', { ...minimal, sources: ['next-pages', { kind: 'next-pages', appDir: 'app' }] }],
    ['the url-filters source twice', { ...minimal, sources: ['url-filters', 'url-filters'] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });
```

with:

```ts
    ['a page option on the endpoint source', { ...minimal, sources: [{ kind: 'next-app', stripSegments: [] }] }],
    ['the next-pages source twice', { ...minimal, sources: ['next-pages', { kind: 'next-pages', appDir: 'app' }] }],
    ['the url-filters source twice', { ...minimal, sources: ['url-filters', 'url-filters'] }],
    ['a page option on the actions source', { ...minimal, sources: [{ kind: 'react-actions', appDir: 'src/app' }] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });
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

describe('runToolsPipeline (client actions)', () => {
  it('runs read-only client actions directly, confirms writing ones and disables untyped ones', async () => {
    const fixture = await createAppFixture({
      'src/components/task-list.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + 'export function TaskList() {\n'
        + "  useAiClientAction('tasks.highlight', (payload: { taskId: string }) => console.log(payload.taskId));\n"
        + "  useAiClientAction('tasks.archive', async (payload: { taskId: string }) => {\n"
        + "    await fetch(`/api/tasks/${payload.taskId}`, { method: 'DELETE' });\n  });\n"
        + "  useAiClientAction('tasks.select', (payload) => console.log(payload));\n  return null;\n}\n",
    }, { toolsConfig: { sources: ['react-actions'] } });
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const tools = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.name, tool] as const));
    expect(tools.get('ui.tasks.highlight')).toMatchObject({
      operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, enabled: true, actionBindingRef: 'tasks.highlight',
    });
    expect(tools.get('ui.tasks.archive')).toMatchObject({
      operationGroup: 'ui', riskClass: 'write', requiresApproval: true, enabled: true,
    });
    expect(tools.get('ui.tasks.select')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/sources/react-actions.test.ts`
Expected: FAIL — `Cannot find module './react-actions.js'`, and `tools.json` refuses `react-actions`. `Test Files  3 failed (3)`, `Tests  2 failed | 34 passed (36)`

- [ ] **Step 3: Implement the source**

Create `src/codegen/tools/sources/react-actions.ts`:

```ts
import ts from 'typescript';
import { canonicalJson, compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import { typeToJsonSchema } from '../output-inference.js';
import { createAppProgram, type AppProgram } from '../program.js';
import type { JsonSchemaLike, ToolFinding, ToolSource, ToolSourceObservation } from '../types.js';
import { scanAppSources } from './app-files.js';
import {
  actionStableKey,
  importedCalls,
  incompleteUiSource,
  uiDefinitionIdForAction,
  uiObservation,
  uniqueDefinitionIds,
} from './ui-tools.js';

export interface ReactActionSourceOptions {
  /** Where registrations are searched; `src` when the app has one, else the app root. */
  srcDir?: string;
}

const REGISTRATION_SPECS = [
  { module: 'glirastes/react', names: ['useAiClientAction', 'useAiClientActionById'] },
  { module: 'glirastes/browser', names: ['registerAiClientAction'] },
];
const BUS_MODULES: ReadonlySet<string> = new Set(['glirastes/react', 'glirastes/browser']);
const REGISTRATION_TEXT = /useAiClientAction|registerAiClientAction|subscribeById/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EMPTY_PAYLOAD: JsonSchemaLike = { type: 'object', properties: {}, additionalProperties: false };

interface Registration {
  actionId: string;
  file: string;
  /** `payload`: the handler receives the payload; `action`: the whole UI action. */
  style: 'payload' | 'action';
  handler: ts.Expression | undefined;
  contract: ts.Expression | undefined;
  call: ts.CallExpression;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function literalId(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function importsBus(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && BUS_MODULES.has(statement.moduleSpecifier.text)
    && !statement.importClause?.isTypeOnly
  ));
}

/** The function a handler argument stands for: inline, `useCallback(fn)` or a named function. */
function functionOf(app: AppProgram, raw: ts.Expression | undefined, depth = 0): ts.SignatureDeclaration | undefined {
  if (!raw || depth > 4) return undefined;
  const expression = unwrap(raw);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'useCallback') {
    return functionOf(app, expression.arguments[0], depth + 1);
  }
  if (ts.isIdentifier(expression)) {
    let symbol = app.checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
    if (declaration && ts.isVariableDeclaration(declaration)) return functionOf(app, declaration.initializer, depth + 1);
  }
  return undefined;
}

function objectSchema(app: AppProgram, type: ts.Type, location: ts.Node): JsonSchemaLike | undefined {
  const schema = typeToJsonSchema(app.checker, type, location);
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) return undefined;
  return { ...schema, additionalProperties: false };
}

/** Contract (`z.infer` via `_output`) first, then the handler's parameter type; undefined when untyped. */
function payloadSchema(app: AppProgram, registration: Registration): JsonSchemaLike | undefined {
  const checker = app.checker;
  if (registration.contract) {
    const contractType = checker.getTypeAtLocation(registration.contract);
    const output = checker.getPropertyOfType(contractType, '_output');
    if (output) {
      const schema = objectSchema(app, checker.getTypeOfSymbolAtLocation(output, registration.contract), registration.contract);
      if (schema) return schema;
    }
  }
  const handler = functionOf(app, registration.handler);
  if (!handler) return undefined;
  const parameter = handler.parameters[0];
  if (!parameter) return EMPTY_PAYLOAD;
  let type = checker.getTypeAtLocation(parameter);
  if (registration.style === 'action') {
    const payload = checker.getPropertyOfType(type, 'payload');
    if (!payload) return undefined;
    type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(payload, parameter));
  }
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
        const options = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
        const method = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property): property is ts.PropertyAssignment => (
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
  if (!node) return undefined;
  const text = source.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const block = [...ranges].reverse().find((range) => text.startsWith('/**', range.pos));
  if (!block) return undefined;
  const lines = text.slice(block.pos + 3, block.end - 2).split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('@'));
  return lines.length > 0 ? lines.join(' ') : undefined;
}

function statementOf(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isExpressionStatement(current) && !ts.isVariableStatement(current)) current = current.parent;
  return current;
}

function registrationsOf(
  source: ts.SourceFile,
  file: string,
  findings: ToolFinding[],
): Registration[] {
  const found: Array<Omit<Registration, 'actionId'> & { id: ts.Expression | undefined }> = [];
  for (const { name, call } of importedCalls(source, REGISTRATION_SPECS)) {
    found.push(name === 'useAiClientActionById'
      ? { file, style: 'action', id: call.arguments[1], handler: call.arguments[2], contract: undefined, call }
      : { file, style: 'payload', id: call.arguments[0], handler: call.arguments[1], contract: call.arguments[2], call });
  }
  if (importsBus(source)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'subscribeById') {
        found.push({ file, style: 'action', id: node.arguments[0], handler: node.arguments[1], contract: undefined, call: node });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const registrations: Registration[] = [];
  for (const { id, ...entry } of found.sort((left, right) => left.call.getStart() - right.call.getStart())) {
    const actionId = literalId(id);
    const line = source.getLineAndCharacterOfPosition(entry.call.getStart()).line + 1;
    if (actionId === undefined) {
      findings.push(toolFinding('ui-action-id-dynamic', 'warning', `${file}:${line}`,
        'A client action is registered with an id that is not a literal, so the chat cannot call it.'));
      continue;
    }
    if (actionId.startsWith('glirastes.')) {
      findings.push(toolFinding('ui-action-id-reserved', 'warning', `${file}:${line}`,
        `${actionId} belongs to the SDK and is not a client action of this app.`));
      continue;
    }
    registrations.push({ ...entry, actionId });
  }
  return registrations;
}

async function observeActions(root: string, options: ReactActionSourceOptions): Promise<ToolSourceObservation> {
  const scan = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: (source) => REGISTRATION_TEXT.test(source),
  });
  if (!scan.complete) return incompleteUiSource('react-actions', scan.reason);
  if (scan.files.length === 0) return { observations: [], findings: [], complete: true, excluded: [] };
  const app = createAppProgram({ root, rootNames: scan.files.map((file) => file.absolute) });
  const findings: ToolFinding[] = [];
  const byId = new Map<string, Registration[]>();
  for (const file of scan.files) {
    const source = app.sourceFile(file.absolute);
    if (!source) continue;
    for (const registration of registrationsOf(source, file.path, findings)) {
      byId.set(registration.actionId, [...byId.get(registration.actionId) ?? [], registration]);
    }
  }
  const named: Array<{ actionId: string; base: string }> = [];
  for (const [actionId, registrations] of byId) {
    const base = uiDefinitionIdForAction(actionId);
    if (base === undefined) {
      findings.push(toolFinding('ui-action-id-invalid', 'warning', registrations[0]!.file,
        `${JSON.stringify(actionId)} cannot become a tool name.`));
      continue;
    }
    named.push({ actionId, base });
  }
  const ids = uniqueDefinitionIds(named.map(({ actionId, base }) => ({ stableKey: actionStableKey(actionId), base })));
  const observations = named
    .sort((left, right) => compareCodeUnits(left.actionId, right.actionId))
    .map(({ actionId }) => {
      const stableKey = actionStableKey(actionId);
      const registrations = byId.get(actionId)!;
      const schemas = registrations.map((registration) => payloadSchema(app, registration));
      const typed = [...new Map(schemas
        .filter((schema): schema is JsonSchemaLike => schema !== undefined)
        .map((schema) => [canonicalJson(schema), schema] as const)).values()];
      const handlers = registrations.map((registration) => functionOf(app, registration.handler));
      const toolFindings: ToolFinding[] = [];
      if (typed.length === 0) {
        toolFindings.push(toolFinding('ui-action-payload-untyped', 'needs_attention', stableKey,
          `${actionId} has neither a payload contract nor a typed handler parameter.`));
      } else if (typed.length > 1) {
        toolFindings.push(toolFinding('ui-action-contract-conflict', 'needs_attention', stableKey,
          `${actionId} is registered with ${typed.length} different payload contracts.`));
      }
      const input = typed[0];
      const jsDoc = registrations
        .map((registration, index) => {
          const handler = handlers[index];
          return docOf(registration.call.getSourceFile(), statementOf(registration.call))
            ?? (handler && ts.isFunctionDeclaration(handler) ? docOf(handler.getSourceFile(), handler) : undefined);
        })
        .find((doc) => doc !== undefined);
      const uiMutation = handlers.some((handler) => writes(handler));
      return uiObservation({
        stableKey,
        definitionId: ids.get(stableKey)!,
        actionBindingRef: actionId,
        ...(input ? { input } : {}),
        uiAction: { kind: 'client-action', actionId },
        params: {
          path: [],
          query: [],
          body: Object.keys((input?.properties ?? {}) as Record<string, unknown>).sort(compareCodeUnits),
        },
        facts: {
          actionId,
          files: [...new Set(registrations.map((registration) => registration.file))].sort(compareCodeUnits),
          payloads: typed,
          uiMutation,
        },
        findings: toolFindings,
        ...(jsDoc ? { jsDoc } : {}),
        ...(uiMutation ? { uiMutation } : {}),
      });
    });
  return { observations, findings, complete: true, excluded: [] };
}

/**
 * The `react-actions` source: one `ui.<actionId>` tool per literal client
 * action id registered with `useAiClientAction`, `registerAiClientAction`,
 * `useAiClientActionById` or `bus.subscribeById` (spec 4.4).
 */
export function createReactActionSource(options: ReactActionSourceOptions = {}): ToolSource {
  return { kind: 'react-actions', observe: (ctx) => observeActions(ctx.root, options) };
}
```

- [ ] **Step 4: Accept the source and create it**

1. In `src/codegen/tools/config.ts`, replace:

```ts
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app', 'next-pages', 'url-filters']);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
```

with:

```ts
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app', 'next-pages', 'url-filters', 'react-actions']);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
```

2. In `src/codegen/tools/config.ts`, replace:

```ts
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages', 'url-filters'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
```

with:

```ts
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
  z.object({ kind: z.literal('react-actions'), srcDir: appPath.optional() }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages', 'url-filters', 'react-actions'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
```

3. In `src/codegen/tools/config.ts`, replace:

```ts
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ToolSourceConfig =
  | { kind: 'next-app'; apiDir?: string }
  | { kind: 'next-pages' | 'url-filters'; appDir?: string; srcDir?: string; stripSegments?: string[] };

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
```

with:

```ts
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ToolSourceConfig =
  | { kind: 'next-app'; apiDir?: string }
  | { kind: 'next-pages' | 'url-filters'; appDir?: string; srcDir?: string; stripSegments?: string[] }
  | { kind: 'react-actions'; srcDir?: string };

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
```

1. In `src/codegen/tools/pipeline.ts`, replace:

```ts
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import { createUrlFilterSource } from './sources/url-filters.js';
import {
  readPreviousToolState,
```

with:

```ts
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import { createReactActionSource } from './sources/react-actions.js';
import { createUrlFilterSource } from './sources/url-filters.js';
import {
  readPreviousToolState,
```

2. In `src/codegen/tools/pipeline.ts`, replace:

```ts
          ...(pages && pages.kind !== 'next-app' ? pages : {}),
          ...source,
        });
    }
  });
}
```

with:

```ts
          ...(pages && pages.kind !== 'next-app' ? pages : {}),
          ...source,
        });
      case 'react-actions':
        return createReactActionSource(source);
    }
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/sources/react-actions.test.ts && bunx vitest run src/codegen/tools && bun run typecheck`
Expected: PASS — the three files report `Test Files  3 passed (3)`, `Tests  39 passed (39)`; all generator suites report `Test Files  28 passed (28)`, `Tests  359 passed (359)`; typecheck clean. Under heavy machine load the timing-sensitive P03 files (`evidence`, `handler-analysis`, `input-roles`, `program`, `schema-probe`) can hit Vitest's 5-second timeout or the probe's 10-second budget; rerun `bunx vitest run src/codegen/tools --maxWorkers=4` before treating that as a failure.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/config.test.ts src/codegen/tools/config.ts src/codegen/tools/pipeline.test.ts \
  src/codegen/tools/pipeline.ts src/codegen/tools/sources/react-actions.test.ts \
  src/codegen/tools/sources/react-actions.ts
git commit -m "feat(codegen): generate client action tools from ui registrations"
```


### Task 18: The Next reference fixture's UI comes from `tools refresh`

**Files:**
- Create: `examples/source-driven-next/native/src/app/(app)/tasks/page.jsx`, `examples/source-driven-next/native/src/app/(app)/overview/page.jsx`, `examples/source-driven-next/native/src/task-filters.js`, `examples/source-driven-next/native/src/ui-contracts.js`, `examples/source-driven-next/native/src/glirastes-bridge.jsx`, `examples/source-driven-next/browser-shell/src/app/(app)/layout.jsx`
- Modify: `examples/source-driven-next/native/.glirastes/tools.json` (four sources), `examples/source-driven-next/browser-shell/package.json` (`dev`/`build` run `tools refresh`), `examples/source-driven-next/browser-shell/src/app/page.jsx` (redirect to `/tasks`), `examples/source-driven-next/browser-shell/src/app/chat/route.js` (boots the generated module), `examples/source-driven-next/browser-shell/src/test-model.js` (generated tool names), `examples/source-driven-next/prepare-browser.mjs`, `examples/source-driven-next/prepare-browser.d.mts`, `examples/source-driven-next/README.md`
- Delete (`git rm`): `examples/source-driven-next/adapter.mjs`, `adapter.d.mts`, `ui-adapter.mjs`, `build.mjs`, `build.d.mts`, `ui-bridge.js`, `native-ui/ui-config.json`, `native-ui/ui.js`
- Test: `tests/support/tool-runtime.ts`, `tests/source-driven-ui.test.tsx` (rewrite), `tests/source-driven-build.test.ts` (rewrite), `tests/source-driven-browser.test.mjs`, `tests/tool-sync-next.test.ts`

**Interfaces:**
- Consumes: everything above; `runToolsPipeline`, `createGeneratedRuntimeSource`, `bootApp`/`copyApp` (P03 `tests/support/tool-runtime.ts`), the built CLI `dist/cli/bin.js`.
- Produces:
  - The fixture app owns its UI: pages `/tasks` and `/overview` (route group `(app)`), the URL filter definition `taskFilters` (`/tasks`, `status: open|done`) that the tasks page reads and writes, the client action `tasks.highlight` with the Zod contract `highlightTask`, and `GlirastesBridge` handing `router.push` to `useGlirastesNavigationBridge`. `tools refresh` turns them into `ui.navigate`, `ui.filter.tasks` and `ui.tasks.highlight` next to `tasks.list`.
  - `tests/support/tool-runtime.ts`: `SDK_ROOT` and `EXAMPLES` from path arithmetic (under jsdom `new URL(relative, import.meta.url)` yields `http://localhost:3000/…`), and `export async function refreshWithCli(root: string): Promise<string>` (runs the built `glirastes tools refresh`; the in-process pipeline cannot run under jsdom for the same reason, its schema probe resolves `probe-child.mjs` through `import.meta.url`).
  - `prepareBrowserReference()` copies `native` and `browser-shell`, links the built SDK and dependencies, and runs the first `tools refresh`; the browser app's `dev` and `build` scripts run `tools refresh` (`--keep-going` in dev) before Next.
  - The roadmap row "`examples/source-driven-next/*.d.mts` zusammen mit den `.mjs`-Modulen entfernen" is done; `prepare-browser.d.mts` stays because `prepare-browser.mjs` stays.

`git rm` is permitted in this environment (shell `rm` is not); it was verified with `git rm` followed by `git reset`/`git checkout` on a scratch copy.

- [ ] **Step 1: Rewrite the fixture tests against the generated UI tools**

1. In `tests/support/tool-runtime.ts`, replace:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FoundationExecutionInventorySchema } from '../../src/codegen/execution-inventory.js';
import type { Principal } from '../../src/contracts/index.js';
import { createAiSdkTools, type AiSdkWrappedTool } from '../../src/runtime/ai-sdk/index.js';
```

with:

```ts
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { FoundationExecutionInventorySchema } from '../../src/codegen/execution-inventory.js';
import type { Principal } from '../../src/contracts/index.js';
import { createAiSdkTools, type AiSdkWrappedTool } from '../../src/runtime/ai-sdk/index.js';
```

2. In `tests/support/tool-runtime.ts`, replace:

```ts
} from '../../src/server/index.js';
import type { ToolRegistry } from '../../src/types.js';

export const SDK_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXAMPLES = fileURLToPath(new URL('../../examples/source-driven-next/', import.meta.url));
export const NATIVE_APP = join(EXAMPLES, 'native');
export const FIXTURE_TENANT_ID = '019fb007-0000-7000-8000-000000000002';
export const GENERATED_MODULE = 'src/generated/glirastes/tools.generated.js';
```

with:

```ts
} from '../../src/server/index.js';
import type { ToolRegistry } from '../../src/types.js';

// Path arithmetic instead of `new URL(relative, import.meta.url)`: under jsdom that URL is http://localhost.
const HERE = dirname(fileURLToPath(import.meta.url));
export const SDK_ROOT = resolve(HERE, '../..');
export const EXAMPLES = resolve(SDK_ROOT, 'examples/source-driven-next');
export const NATIVE_APP = join(EXAMPLES, 'native');
export const FIXTURE_TENANT_ID = '019fb007-0000-7000-8000-000000000002';
export const GENERATED_MODULE = 'src/generated/glirastes/tools.generated.js';
```

3. In `tests/support/tool-runtime.ts`, replace:

```ts
  return root;
}

export async function removeCopiedApps(): Promise<void> {
  for (const root of copies.splice(0)) await rm(root, { recursive: true, force: true });
}
```

with:

```ts
  return root;
}

/**
 * Runs the built `glirastes tools refresh` on an app, like its `dev` script.
 * Use it from jsdom tests: the in-process pipeline spawns its schema probe
 * from `import.meta.url`, which jsdom rewrites to an http URL.
 */
export async function refreshWithCli(root: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath,
    [join(SDK_ROOT, 'dist/cli/bin.js'), 'tools', 'refresh', '--root', root],
    { env: { PATH: process.env.PATH ?? '' } });
  return stdout;
}

export async function removeCopiedApps(): Promise<void> {
  for (const root of copies.splice(0)) await rm(root, { recursive: true, force: true });
}
```

Replace the whole content of `tests/source-driven-ui.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchToolResultUiActions } from 'glirastes/browser';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  refreshWithCli,
  removeCopiedApps,
} from './support/tool-runtime.js';

const navigation = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  search: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const TASKS = [
  { id: '1', title: 'Review release', status: 'open' },
  { id: '2', title: 'Write tests', status: 'done' },
];

beforeAll(assertBuiltSdk);
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  navigation.push.mockReset();
  navigation.search = '';
  await removeCopiedApps();
});

/** A refreshed copy of the native app, its booted chat runtime and its own UI modules. */
async function nativeApp() {
  const root = await copyApp(NATIVE_APP, '.ui-proof-');
  await refreshWithCli(root);
  const app = await bootApp(root);
  const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
  const bridge = await import(pathToFileURL(join(root, 'src/glirastes-bridge.jsx')).href) as {
    GlirastesBridge: ComponentType;
  };
  const tasksPage = await import(pathToFileURL(join(root, 'src/app/(app)/tasks/page.jsx')).href) as {
    default: ComponentType;
  };
  /** What the chat does with a tool result: hand its generated UI action to the page-wide bus. */
  const run = async (name: string, input: unknown) => {
    const result = await turn.execute(name, input);
    expect(result).toMatchObject({ success: true });
    await act(async () => { await dispatchToolResultUiActions(result); });
  };
  return { app, turn, run, Bridge: bridge.GlirastesBridge, TasksPage: tasksPage.default };
}

describe('native UI through generated tools and the app bridge', () => {
  it('navigates and filters with the router the app hands to its bridge', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const native = await nativeApp();
    expect(native.app.disabled).toEqual([]);
    render(createElement(native.Bridge));
    await native.run('ui_navigate', { destination: '/overview' });
    await native.run('ui_filter_tasks', { status: 'done' });
    expect(navigation.push.mock.calls).toEqual([['/overview'], ['/tasks?status=done']]);
    await expect(native.turn.execute('ui_navigate', { destination: '/reports' })).rejects.toThrow('Input does not match');
    await expect(native.turn.execute('ui_filter_tasks', { status: 'blocked' })).rejects.toThrow('Input does not match');
    expect(network).not.toHaveBeenCalled();
  }, 120_000);

  it('runs the page’s own client action with a validated payload and shows the URL filter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tasks: TASKS }));
    navigation.search = 'status=done';
    const native = await nativeApp();
    render(createElement(native.TasksPage));
    await screen.findByText('Write tests');
    expect(screen.queryByText('Review release')).toBeNull();
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('done');
    await native.run('ui_tasks_highlight', { title: 'Write tests' });
    await waitFor(() => expect(screen.getByText('Write tests').getAttribute('aria-current')).toBe('true'));
    await expect(native.turn.execute('ui_tasks_highlight', { id: '2' })).rejects.toThrow('Input does not match');
    // The page's own Zod contract stays the last word on what its handler accepts.
    const empty = await native.turn.execute('ui_tasks_highlight', { title: '' });
    await expect(dispatchToolResultUiActions(empty)).rejects.toThrow('Invalid payload for UI action tasks.highlight');
    expect(screen.getByText('Write tests').getAttribute('aria-current')).toBe('true');
  }, 120_000);

  it('uses the same filter definition for the ordinary page controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tasks: TASKS }));
    const native = await nativeApp();
    render(createElement(native.TasksPage));
    await screen.findByText('Review release');
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    select.value = 'open';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(navigation.push).toHaveBeenCalledWith('/tasks?status=open');
  }, 120_000);

  it('stops navigating once the bridge unmounts', async () => {
    const native = await nativeApp();
    const view = render(createElement(native.Bridge));
    view.unmount();
    await native.run('ui_navigate', { destination: '/overview' });
    expect(navigation.push).not.toHaveBeenCalled();
  }, 120_000);
});
```

Replace the whole content of `tests/source-driven-build.test.ts` with:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { runToolsPipeline, ToolsPipelineFailure } from '../src/codegen/tools/pipeline.js';
import { assertBuiltSdk, copyApp, EXAMPLES, NATIVE_APP, removeCopiedApps } from './support/tool-runtime.js';

const roots: string[] = [];
beforeAll(assertBuiltSdk);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await removeCopiedApps();
});

it('stops the normal app build before Next when tools refresh fails', async () => {
  const { prepareBrowserReference } = await import('../examples/source-driven-next/prepare-browser.mjs');
  const root = await prepareBrowserReference();
  roots.push(root);
  const inventory = await readFile(resolve(root, '.glirastes/foundation-execution-inventory.json'), 'utf8');
  const generated = await readFile(resolve(root, 'src/generated/glirastes/tools.generated.js'), 'utf8');
  await writeFile(resolve(root, 'src/app/api/tasks/route.js'), "export * from './contract.js';\n");
  const result = await promisify(execFile)('bun', ['run', 'build'], { cwd: root,
    env: { PATH: process.env.PATH, NEXT_TELEMETRY_DISABLED: '1' } })
    .then(() => ({ code: 0, stdout: '' }), (error: { code: number; stdout: string }) => error);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain('E-INVENTORY-011');
  await expect(readFile(resolve(root, '.next/BUILD_ID'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(root, '.glirastes/foundation-execution-inventory.json'), 'utf8')).toBe(inventory);
  expect(await readFile(resolve(root, 'src/generated/glirastes/tools.generated.js'), 'utf8')).toBe(generated);
}, 60_000);

it('refuses a linked output folder without writing outside the app', async () => {
  const root = await copyApp(NATIVE_APP, '.build-proof-');
  const outside = await mkdtemp(resolve(EXAMPLES, '.build-proof-outside-'));
  roots.push(outside);
  await symlink(outside, resolve(root, 'src/generated'), 'dir');
  const outcome = await runToolsPipeline({ root, mode: 'write' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  expect((outcome as ToolsPipelineFailure).result.findings).toContainEqual(expect.objectContaining({ code: 'output-path-linked' }));
  expect(await readdir(outside)).toEqual([]);
  await expect(readFile(resolve(root, '.glirastes/setup-artifact.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);
```

1. In `tests/tool-sync-next.test.ts`, replace:

```ts

const byToolId = (left: { toolId: string }, right: { toolId: string }) => (left.toolId < right.toolId ? -1 : 1);

describe('Next endpoint change corpus', () => {
  it('adds an endpoint: active at once with defaults, inside the user session, rejected without one', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    const tasksId = before.tools[0]!.toolId;
    await mkdir(join(root, 'src/app/api/notes'), { recursive: true });
    await writeFile(join(root, 'src/app/api/notes/schemas.js'), NOTES_SCHEMAS);
    await writeFile(join(root, 'src/app/api/notes/route.js'), NOTES_ROUTE);
```

with:

```ts

const byToolId = (left: { toolId: string }, right: { toolId: string }) => (left.toolId < right.toolId ? -1 : 1);

/** The fixture also generates UI tools; endpoint assertions pick their tool by name. */
function toolNamed(artifact: AppSetupArtifact, name: string): AppSetupArtifact['tools'][number] {
  const tool = artifact.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
}

describe('Next endpoint change corpus', () => {
  it('adds an endpoint: active at once with defaults, inside the user session, rejected without one', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    const tasksId = toolNamed(before, 'tasks.list').toolId;
    await mkdir(join(root, 'src/app/api/notes'), { recursive: true });
    await writeFile(join(root, 'src/app/api/notes/schemas.js'), NOTES_SCHEMAS);
    await writeFile(join(root, 'src/app/api/notes/route.js'), NOTES_ROUTE);
```

2. In `tests/tool-sync-next.test.ts`, replace:

```ts

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(2);
    expect(refreshed.changes.unchanged).toEqual([tasksId]);
    const after = await artifactOf(root);
    const byName = new Map(after.tools.map((tool) => [tool.name, tool] as const));
    expect(byName.get('tasks.list')?.toolId).toBe(tasksId);
```

with:

```ts

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(2);
    expect([...refreshed.changes.unchanged].sort()).toEqual(before.tools.map((tool) => tool.toolId).sort());
    expect(refreshed.changes.unchanged).toContain(tasksId);
    const after = await artifactOf(root);
    const byName = new Map(after.tools.map((tool) => [tool.name, tool] as const));
    expect(byName.get('tasks.list')?.toolId).toBe(tasksId);
```

3. In `tests/tool-sync-next.test.ts`, replace:

```ts
  it('changes an endpoint: same identity, the new schema is enforced after refresh', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = (await artifactOf(root)).tools[0]!;
    await replaceIn(root, 'src/app/api/tasks/contract.js',
      "status: z.enum(['open', 'done']).optional()", "status: z.enum(['done']).optional()");
    await replaceIn(root, 'src/app/api/tasks/route.js', 'Write tests', 'Write verified tests');
```

with:

```ts
  it('changes an endpoint: same identity, the new schema is enforced after refresh', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'tasks.list');
    await replaceIn(root, 'src/app/api/tasks/contract.js',
      "status: z.enum(['open', 'done']).optional()", "status: z.enum(['done']).optional()");
    await replaceIn(root, 'src/app/api/tasks/route.js', 'Write tests', 'Write verified tests');
```

4. In `tests/tool-sync-next.test.ts`, replace:

```ts

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = (await artifactOf(root)).tools[0]!;
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after).toMatchObject({ riskClass: 'safe-read', requiresApproval: false, enabled: true });
```

with:

```ts

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = toolNamed(await artifactOf(root), 'tasks.list');
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after).toMatchObject({ riskClass: 'safe-read', requiresApproval: false, enabled: true });
```

5. In `tests/tool-sync-next.test.ts`, replace:

```ts
  it('removes an endpoint: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const tasksId = (await artifactOf(root)).tools[0]!.toolId;
    await rm(join(root, 'src/app/api/tasks/route.js'));

    expect((await failingCheck(root)).changes.removed).toEqual([tasksId]);
```

with:

```ts
  it('removes an endpoint: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const tasksId = toolNamed(await artifactOf(root), 'tasks.list').toolId;
    await rm(join(root, 'src/app/api/tasks/route.js'));

    expect((await failingCheck(root)).changes.removed).toEqual([tasksId]);
```

6. In `tests/tool-sync-next.test.ts`, replace:

```ts
    expect(refreshed.changes.removed).toEqual([tasksId]);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual([expect.objectContaining({ toolId: tasksId, stableKey: 'GET /api/tasks' })]);
    expect((await artifactOf(root)).tools).toEqual([]);
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(Object.keys(turn.registry)).toEqual([]);
    await expect(turn.guard.beforeToolCall({ toolName: 'tasks_list', input: {} }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
```

with:

```ts
    expect(refreshed.changes.removed).toEqual([tasksId]);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual([expect.objectContaining({ toolId: tasksId, stableKey: 'GET /api/tasks' })]);
    expect((await artifactOf(root)).tools.filter((tool) => tool.executionKind === 'endpoint')).toEqual([]);
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(Object.keys(turn.registry)).not.toContain('tasks_list');
    await expect(turn.guard.beforeToolCall({ toolName: 'tasks_list', input: {} }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
```

1. In `tests/source-driven-browser.test.mjs`, replace:

```js
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
```

with:

```js
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
```

2. In `tests/source-driven-browser.test.mjs`, replace:

```js
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const root = await module.prepareBrowserReference();
  const navigationDigest = (text) => JSON.parse(text.match(/^export const generationState = (.+);$/m)[1])
    .inventory.executions.find((entry) => entry.definitionId === 'ui.navigate').inputSchemaDigest;
  const initialDigest = navigationDigest(await readFile(resolve(root, '.glirastes/runtime.mjs'), 'utf8'));
  let server;
  let browser;
  const processes = [];
```

with:

```js
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const root = await module.prepareBrowserReference();
  const navigationDigest = async () => JSON.parse(await readFile(resolve(root, '.glirastes/foundation-execution-inventory.json'), 'utf8'))
    .executions.find((entry) => entry.definitionId === 'ui.navigate').inputSchemaDigest;
  const initialDigest = await navigationDigest();
  let server;
  let browser;
  const processes = [];
```

3. In `tests/source-driven-browser.test.mjs`, replace:

```js
      if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason), 'Reference cleanup failed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  // Prove the normal app dev/build command picks up changes AFTER setup.
  const configFile = resolve(root, 'src/ui-config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.views.push({ id: 'archive', label: 'Archive', filters: [] });
  await writeFile(configFile, JSON.stringify(config));
  const capability = randomUUID();
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME,
    NEXT_TELEMETRY_DISABLED: '1', GLIRASTES_REFERENCE_TEST_MODE: '1',
```

with:

```js
      if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason), 'Reference cleanup failed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  // Prove the normal app dev/build command picks up a new page AFTER setup.
  await mkdir(resolve(root, 'src/app/(app)/archive'), { recursive: true });
  await writeFile(resolve(root, 'src/app/(app)/archive/page.jsx'),
    'export default function Archive() { return <section data-testid="native-ui"><h1>Archive</h1></section>; }\n');
  const capability = randomUUID();
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME,
    NEXT_TELEMETRY_DISABLED: '1', GLIRASTES_REFERENCE_TEST_MODE: '1',
```

4. In `tests/source-driven-browser.test.mjs`, replace:

```js
    await delay(100);
  }
  assert.match(logs, /Ready in/);
  const generatedText = await readFile(resolve(root, '.glirastes/runtime.mjs'), 'utf8');
  assert.notEqual(navigationDigest(generatedText), initialDigest, 'normal app command did not regenerate after native UI change');
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const denied = await post('/chat', message('Show done tasks'));
```

with:

```js
    await delay(100);
  }
  assert.match(logs, /Ready in/);
  assert.notEqual(await navigationDigest(), initialDigest, 'normal app command did not regenerate after a page change');
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const denied = await post('/chat', message('Show done tasks'));
```

5. In `tests/source-driven-browser.test.mjs`, replace:

```js
  }
  await chat('Go to overview');
  await native.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await chat('Filter done tasks');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await native.getByText('Write tests', { exact: true }).waitFor();
  assert.equal(await native.getByText('Review release', { exact: true }).count(), 0);
  assert.equal(await native.getByLabel('Status').inputValue(), 'done');
  if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
  await page.goto(`${origin}/layout-proof`);
  const layoutDraft = page.getByRole('textbox');
```

with:

```js
  }
  await chat('Go to overview');
  await native.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/overview');
  await chat('Filter done tasks');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await native.getByText('Write tests', { exact: true }).waitFor();
  assert.equal(await native.getByText('Review release', { exact: true }).count(), 0);
  assert.equal(await native.getByLabel('Status').inputValue(), 'done');
  assert.equal(new URL(page.url()).search, '?status=done');
  await chat('Highlight Write tests');
  await native.locator('li[aria-current="true"]', { hasText: 'Write tests' }).waitFor();
  if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
  await page.goto(`${origin}/layout-proof`);
  const layoutDraft = page.getByRole('textbox');
```

6. In `tests/source-driven-browser.test.mjs`, replace:

```js
  assert.equal(await layoutDraft.evaluate(element => element === document.activeElement), true, 'retained reopen must focus the actual drop-in composer');
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /Module not found|Error:|Warning:/);
  t.diagnostic('Verified real Next HTTP + SSE, scoped endpoint results, SDK chat, navigation/filtering, and common desktop/mobile layout geometry and draft retention. Test model only; no LLM/STT/timing claim.');
});
```

with:

```js
  assert.equal(await layoutDraft.evaluate(element => element === document.activeElement), true, 'retained reopen must focus the actual drop-in composer');
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /Module not found|Error:|Warning:/);
  t.diagnostic('Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, and common desktop/mobile layout geometry and draft retention. Test model only; no LLM/STT/timing claim.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run tests/source-driven-build.test.ts tests/source-driven-ui.test.tsx tests/tool-sync-next.test.ts`
Expected: FAIL — the four UI tests stop at `Cannot find module '…/.ui-proof-…/src/glirastes-bridge.jsx'` (the native app has no UI yet), and the build test at `ENOENT … .browser-proof-…/.glirastes/foundation-execution-inventory.json` (the old preparer writes `.glirastes/runtime.mjs` instead of running `tools refresh`); the endpoint corpus already passes because it now picks `tasks.list` by name. `Test Files  2 failed | 1 passed (3)`, `Tests  5 failed | 4 passed (9)`

- [ ] **Step 3: Give the native app its UI**

In `examples/source-driven-next/native/.glirastes/tools.json`, replace:

```json
  "appId": "019fb007-0000-7000-8000-000000000001",
  "targetAppKey": "native-query-fixture",
  "locale": "en-US",
  "sources": [{ "kind": "next-app", "apiDir": "src/app/api" }],
  "emit": { "module": "src/generated/glirastes/tools.generated.js" }
}
```

with:

```json
  "appId": "019fb007-0000-7000-8000-000000000001",
  "targetAppKey": "native-query-fixture",
  "locale": "en-US",
  "sources": [
    { "kind": "next-app", "apiDir": "src/app/api" },
    "next-pages",
    "url-filters",
    "react-actions"
  ],
  "emit": { "module": "src/generated/glirastes/tools.generated.js" }
}
```

Create `examples/source-driven-next/native/src/task-filters.js`:

```js
import { defineQueryFilters } from 'glirastes/browser';

/** The URL filters of the tasks page; the page and the chat use the same definition. */
export const taskFilters = defineQueryFilters({
  path: '/tasks',
  filters: { status: ['open', 'done'] },
});
```

Create `examples/source-driven-next/native/src/ui-contracts.js`:

```js
import { z } from 'zod';

/** Payload of the tasks.highlight client action. */
export const highlightTask = z.object({ title: z.string().min(1) }).strict();
```

Create `examples/source-driven-next/native/src/glirastes-bridge.jsx`:

```jsx
'use client';
import { useRouter } from 'next/navigation';
import { useGlirastesNavigationBridge } from 'glirastes/react';

/** Lets the chat open pages and set URL filters with the app's own router. */
export function GlirastesBridge() {
  const router = useRouter();
  useGlirastesNavigationBridge({ push: (href) => router.push(href) });
  return null;
}
```

Create `examples/source-driven-next/native/src/app/(app)/overview/page.jsx`:

```jsx
export default function OverviewPage() {
  return (
    <section data-testid="native-ui" aria-label="Native application">
      <h1>Overview</h1>
      <p>Your work at a glance.</p>
    </section>
  );
}
```

Create `examples/source-driven-next/native/src/app/(app)/tasks/page.jsx`:

```jsx
'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAiClientAction } from 'glirastes/react';
import { taskFilters } from '../../../task-filters.js';
import { highlightTask } from '../../../ui-contracts.js';

function Tasks() {
  const router = useRouter();
  const filters = taskFilters.read(useSearchParams());
  const [tasks, setTasks] = useState([]);
  const [highlighted, setHighlighted] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/tasks', { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Start an authenticated reference session first.');
      const body = await response.json();
      if (!abort.signal.aborted) setTasks(body.tasks);
    }).catch((failure) => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, []);
  /** Highlights one task of the visible list by its title. */
  useAiClientAction('tasks.highlight', (payload) => setHighlighted(payload.title), highlightTask);
  const visible = tasks.filter((task) => !filters.status || task.status === filters.status);
  return (
    <section data-testid="native-ui" aria-label="Native application">
      <h1>Tasks</h1>
      <label>
        Status
        <select
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(event) => router.push(taskFilters.href(event.target.value ? { status: event.target.value } : {}))}
        >
          <option value="">All</option>
          <option value="open">open</option>
          <option value="done">done</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <ul>
        {visible.map((task) => (
          <li key={task.id} aria-current={task.title === highlighted ? 'true' : undefined}>{task.title}</li>
        ))}
      </ul>
    </section>
  );
}

export default function TasksPage() {
  return <Suspense><Tasks /></Suspense>;
}
```

- [ ] **Step 4: Run the browser shell on the generated module**

In `examples/source-driven-next/browser-shell/package.json`, replace:

```json
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node glirastes-setup/build.mjs . && next dev --hostname 127.0.0.1 --port 3191",
    "build": "node glirastes-setup/build.mjs . && next build",
    "start": "next start --hostname 127.0.0.1 --port 3191"
  },
  "dependencies": { "next": "15.5.15", "react": "^19", "react-dom": "^19", "@ai-sdk/react": "^3", "react-markdown": "^10", "ai": "^6", "zod": "^4", "glirastes": "file:../../.." }
```

with:

```json
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node node_modules/glirastes/dist/cli/bin.js tools refresh --keep-going && next dev --hostname 127.0.0.1 --port 3191",
    "build": "node node_modules/glirastes/dist/cli/bin.js tools refresh && next build",
    "start": "next start --hostname 127.0.0.1 --port 3191"
  },
  "dependencies": { "next": "15.5.15", "react": "^19", "react-dom": "^19", "@ai-sdk/react": "^3", "react-markdown": "^10", "ai": "^6", "zod": "^4", "glirastes": "file:../../.." }
```

Replace the whole content of `examples/source-driven-next/browser-shell/src/app/page.jsx` with:

```jsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/tasks');
}
```

Create `examples/source-driven-next/browser-shell/src/app/(app)/layout.jsx`:

```jsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import { GlirastesBridge } from '../../glirastes-bridge.jsx';

// The chat and the navigation bridge live in the layout, so they survive the
// page changes that ui.navigate and ui.filter.tasks ask the router for.
export default function AppLayout({ children }) {
  return <main>
    <p>Native app + Glirastes SDK — deterministic test model</p>
    {children}
    <GlirastesBridge />
    <VercelAiChat endpoint="/chat" title="App assistant" defaultOpen showMic={false} />
  </main>;
}
```

Replace the whole content of `examples/source-driven-next/browser-shell/src/app/chat/route.js` with:

```js
import { createAiChatHandler } from 'glirastes/server/nextjs';
import { createGeneratedRuntimeSource, materializeManifestToolRegistry } from 'glirastes/runtime';
import * as generated from '../../generated/glirastes/tools.generated.js';
import { resolveSession } from '../../auth.js';
import { testModel } from '../../test-model.js';

// Boots the standalone runtime from the committed outputs of `glirastes tools refresh`.
const glirastes = createGeneratedRuntimeSource(generated, {
  localLimits: {
    maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
    maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
    delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
  },
  identity: { tenantId: '019fb007-0000-7000-8000-000000000002' },
});

export const runtime = 'nodejs';
export const POST = createAiChatHandler({
  managedRuntime: { resolvePrincipal: resolveSession, resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context) },
  loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings }),
  model: () => testModel(),
  systemPrompt: 'Use only the available native queries; ask when the target is unclear.',
  maxSteps: 3, maxOutputTokens: 200, emitStepReports: true,
});
```

In `examples/source-driven-next/browser-shell/src/test-model.js`, replace:

```js
    const text = last?.role === 'user' ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
    let toolName;
    let input;
    if (text === 'Go to overview') { toolName = 'ui_navigate'; input = { view: 'overview' }; }
    else if (text === 'Filter done tasks') { toolName = 'ui_filter'; input = { view: 'tasks', filters: { status: 'done' } }; }
    else if (text === 'Show done tasks') { toolName = tools.find((tool) => tool.name.startsWith('query_'))?.name; input = { status: 'done' }; }
    const chunks = [{ type: 'stream-start', warnings: [] }];
    if (toolName) chunks.push({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
    else chunks.push({ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Reference response complete.' }, { type: 'text-end', id: 'answer' });
```

with:

```js
    const text = last?.role === 'user' ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
    let toolName;
    let input;
    if (text === 'Go to overview') { toolName = 'ui_navigate'; input = { destination: '/overview' }; }
    else if (text === 'Filter done tasks') { toolName = 'ui_filter_tasks'; input = { status: 'done' }; }
    else if (text === 'Highlight Write tests') { toolName = 'ui_tasks_highlight'; input = { title: 'Write tests' }; }
    else if (text === 'Show done tasks') { toolName = tools.find((tool) => tool.name === 'tasks_list')?.name; input = { status: 'done' }; }
    const chunks = [{ type: 'stream-start', warnings: [] }];
    if (toolName) chunks.push({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
    else chunks.push({ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Reference response complete.' }, { type: 'text-end', id: 'answer' });
```

Replace the whole content of `examples/source-driven-next/prepare-browser.mjs` with:

```js
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const base = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(base, '../..');

/** A disposable Next app: the native app, the browser shell and its first `glirastes tools refresh`. */
export async function prepareBrowserReference() {
  const root = await mkdtemp(resolve(base, '.browser-proof-'));
  await cp(resolve(base, 'native'), root, { recursive: true });
  await cp(resolve(base, 'browser-shell'), root, { recursive: true });
  await mkdir(resolve(root, 'node_modules'));
  // This is the UNPUBLISHED local Foundation SDK, not registry glirastes@0.4.0.
  await symlink(sdk, resolve(root, 'node_modules/glirastes'), 'dir');
  for (const dependency of ['next', 'react', 'react-dom', '@ai-sdk/react', 'react-markdown', 'ai', 'zod']) {
    const target = resolve(root, 'node_modules', dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(resolve(sdk, 'node_modules', dependency)), target, 'dir');
  }
  // Without CI in the environment the refresh writes, exactly like the app's dev script.
  await promisify(execFile)(process.execPath, [resolve(sdk, 'dist/cli/bin.js'), 'tools', 'refresh', '--root', root],
    { env: { PATH: process.env.PATH ?? '' } });
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await prepareBrowserReference());
}
```

Replace the whole content of `examples/source-driven-next/prepare-browser.d.mts` with:

```text
/** Copies the browser reference into a fresh temporary app root, runs its first tools refresh and returns its path. */
export function prepareBrowserReference(): Promise<string>;
```

- [ ] **Step 5: Remove the adapter**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git rm -q examples/source-driven-next/adapter.mjs examples/source-driven-next/adapter.d.mts \
  examples/source-driven-next/ui-adapter.mjs examples/source-driven-next/build.mjs \
  examples/source-driven-next/build.d.mts examples/source-driven-next/ui-bridge.js \
  examples/source-driven-next/native-ui/ui-config.json examples/source-driven-next/native-ui/ui.js
git grep -n -e "adapter\.mjs" -e "ui-adapter" -e "build\.mjs" -e "ui-bridge\.js" -e "native-ui/" -e "generateReference" -e "buildReference" -e "runtime\.mjs" -- . ':!docs/plans' ':!examples/source-driven-next/README.md'
```

Expected: `git grep` prints nothing (exit 1). If `git rm` were refused, leave the eight files in place, do not reference them anywhere, and report it at the checkpoint.

- [ ] **Step 6: Document the fixture**

Replace the whole content of `examples/source-driven-next/README.md` with:

````markdown
# Source-derived execution reference (development proof)

This is a small **native-handler, Next HTTP and browser integration proof**, not a production-ready
Next.js starter or the finished one-command installer.

## Every tool comes from `glirastes tools refresh`

The tools of `native/` are generated by the SDK from the app's own code. There
is no fixture adapter and no second tool catalogue. `.glirastes/tools.json`
enables four sources:

- `next-app`: the API routes. `.glirastes/tool-resolutions.json` declares the
  app's `query(request, inputSchema, outputSchema, execute)` wrapper (`queryArg`
  1, `outputArg` 2) and `resolveSession` as its auth helper.
- `next-pages`: `ui.navigate`, whose destinations are the pages under
  `src/app` (the route group `(app)` leaves the path).
- `url-filters`: `ui.filter.tasks`, read from the `defineQueryFilters`
  definition in `src/task-filters.js` that the tasks page uses as well.
- `react-actions`: `ui.tasks.highlight`, the `useAiClientAction` registration
  of the tasks page with its Zod contract from `src/ui-contracts.js`.

`src/glirastes-bridge.jsx` hands the app router to
`useGlirastesNavigationBridge`; without a bridge, navigation and filter tools
stay visible but disabled (`navigation-bridge-missing`). `glirastes tools
refresh` writes the committed outputs and `src/generated/glirastes/tools.generated.js`;
`createGeneratedRuntimeSource` boots the standalone runtime from them.

The files under `native/` are an ordinary app-shaped fixture: request/response
schemas, authenticated query handling, a task endpoint, two pages, a URL filter
definition and a client action. Only the bridge, the URL filter definition
and the client-action hook import Glirastes.

From the SDK worktree, with its dependencies already installed:

```sh
bun run build
bunx vitest run tests/source-driven-next.test.ts tests/source-driven-ui.test.tsx tests/source-driven-build.test.ts tests/tool-sync-next.test.ts
```

The endpoint test copies only the native app to isolated temporary directories
next to the fixture, runs `glirastes tools refresh` on the copy and then:

1. Boots the generated module and committed outputs through
   `createGeneratedRuntimeSource`, pins a turn and resolves the principal from
   the app's server-side session store.
2. Executes an AI-SDK-wrapped tool through the runtime guard and the actual Web
   Request handler, retaining role checks in the endpoint and filtering data by
   the caller; a `tool-policy.json` role restriction adds a runtime denial.
3. Changes the shared wrapper, an exported handler or the route tree and checks
   that the affected tool becomes a disabled `needs_attention` tool, and that an
   unknown route stays visible but disabled instead of being dropped.

The UI test (`tests/source-driven-ui.test.tsx`) refreshes a copy with the built
CLI, boots the runtime, runs `ui_navigate`, `ui_filter_tasks` and
`ui_tasks_highlight` and hands each result to the page-wide UI action bus, as
the chat does. The app's own bridge receives the router pushes; the real tasks
page shows the URL filter and runs its own handler, whose Zod contract still
rejects a payload that the generated JSON Schema lets through. The change
corpus (`tests/tool-sync-next.test.ts`) adds, changes and removes an endpoint.

## Real Next and browser test

Prerequisites: Node 22.12+, Bun, the installed SDK dev dependencies, an
installed Playwright module and a compatible browser. This does not download a
browser or install the registry's different historical `glirastes@0.4.0`. The
preparer explicitly links this worktree's built SDK and installed dependencies
into a disposable app and runs its first `glirastes tools refresh`.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_CHANNEL=chrome \
node --test tests/source-driven-browser.test.mjs

REFERENCE_NEXT_MODE=production \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_CHANNEL=chrome \
node --test tests/source-driven-browser.test.mjs
```

Omit `PLAYWRIGHT_CHANNEL` when Playwright's bundled Chromium is installed.
Port 3191 must be free. The runner starts a loopback-only Next process with a
minimal environment, an ephemeral bootstrap capability and fictional test
data. It stops its processes/browser and removes its generated app afterward.
Optional `REFERENCE_SCREENSHOT=/absolute/path.png` retains a browser screenshot.

The test verifies an unauthenticated chat request is denied, an unauthenticated
session bootstrap is denied, the authenticated endpoint tool returns only
Alice's matching tasks through real HTTP/SSE, and streamed UI tool results reach
the bridge and the tasks page through the app router: heading, URL, selected
filter, visible tasks and the highlighted row change in Chrome; console/page
errors fail the test. It also adds a page after setup and verifies that the
normal app command regenerates the navigation schema before starting Next.

The browser shell's `dev` script runs `glirastes tools refresh --keep-going`
before `next dev`; `build` runs `glirastes tools refresh` before `next build`
and stops when the refresh fails (`tests/source-driven-build.test.ts`). `start`
serves the already built deployment. Standalone source or schema changes need
a new build or process; codegen never runs inside chat requests.

## Important boundaries

- The in-memory session implementation is **test-only**. A real app keeps its
  existing authentication and server-side principal resolution.
- The Vitest corpus is in-process/jsdom. The separate Node browser test covers
  actual Next HTTP, SDK streaming and browser dispatch. Its deterministic model
  is test infrastructure, not an intent router or proof of language
  understanding, latency/token efficiency or real-provider quality. A missing
  bus subscriber still does not provide a delivery acknowledgement.
- No external model or platform request is made. Local schemas, source and data are not
  synced. A generated artifact is not a platform publication or activation.
- Standalone code/schema changes require a fresh native module graph/process.
  The corpus uses fresh source directories to represent the next deployment;
  it does not claim code hot-reloading within one Node process.
- This is not a coding-agent installation timing or microphone test. Repeat the
  change corpus across real deployments and the other two reference stacks.
  GID migration, real-model routing, STT and full MVP acceptance remain open.

Do not copy this fixture's authorization policy or fixed identities into a
customer application. Its purpose is to test the common SDK against a second
source of truth instead of relying only on Get It Done's prepared artifacts.
````

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run tests/source-driven-build.test.ts tests/source-driven-ui.test.tsx tests/tool-sync-next.test.ts && bunx vitest run tests/source-driven-next.test.ts && bun run typecheck && bun run typecheck:tests`
Expected: PASS — the three rewritten or adjusted files report `Test Files  3 passed (3)`, `Tests  9 passed (9)`; `tests/source-driven-next.test.ts` reports `Test Files  1 passed (1)`, `Tests  8 passed (8)` (`app.disabled` is `[]` with the UI tools bound); both typechecks clean.

- [ ] **Step 8: Run the real Next browser proof in dev and production mode**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools \
  && export PLAYWRIGHT_MODULE="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1)" \
  && PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs \
  && REFERENCE_NEXT_MODE=production PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
```

Expected: both runs end with `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`; the last test's diagnostic reads "Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, …". Port 3191 must be free; the runner removes its `.browser-proof-*` app afterwards.

- [ ] **Step 9: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add examples/source-driven-next/README.md examples/source-driven-next/browser-shell/package.json \
  'examples/source-driven-next/browser-shell/src/app/(app)/layout.jsx' \
  examples/source-driven-next/browser-shell/src/app/chat/route.js \
  examples/source-driven-next/browser-shell/src/app/page.jsx \
  examples/source-driven-next/browser-shell/src/test-model.js \
  examples/source-driven-next/native/.glirastes/tools.json \
  'examples/source-driven-next/native/src/app/(app)/overview/page.jsx' \
  'examples/source-driven-next/native/src/app/(app)/tasks/page.jsx' \
  examples/source-driven-next/native/src/glirastes-bridge.jsx \
  examples/source-driven-next/native/src/task-filters.js examples/source-driven-next/native/src/ui-contracts.js \
  examples/source-driven-next/prepare-browser.d.mts examples/source-driven-next/prepare-browser.mjs \
  tests/source-driven-browser.test.mjs tests/source-driven-build.test.ts tests/source-driven-ui.test.tsx \
  tests/support/tool-runtime.ts tests/tool-sync-next.test.ts
git commit -m "test(examples): generate the next fixture's ui tools with tools refresh"
```

(The `git rm` of Step 5 is already staged.)

### Task 19: Next navigation and filter change corpus (add, change, delete)

**Files:**
- Create: `tests/tool-sync-next-ui.test.ts`
- Modify: `examples/source-driven-next/README.md` (names the new corpus)

**Interfaces:**
- Consumes: `runToolsPipeline`, `ToolsPipelineFailure`, `compareArtifacts`, `AppSetupArtifactSchema`, `tests/support/tool-runtime.ts`.
- Produces: the six Next navigation and filter rows of the spec 4.12 change corpus. Each copies the fixture, refreshes, patches, expects `check` (frozen) to fail with `tool-outputs-drift` and the named change set, refreshes, asserts identity and defaults (UI tools `safe-read` without confirmation, no plan confirmation for a new tool), expects `check` green, boots the runtime from a deployment copy of the committed outputs and asserts the effect: the new destination or value produces the expected `href`, a removed one is refused by the schema, a removed tool is tombstoned and a direct call is `manifest_tool_unavailable`. Removing the tasks page also removes `ui.tasks.highlight`, whose only registration lived there.

- [ ] **Step 1: Write the corpus test**

Create `tests/tool-sync-next-ui.test.ts`:

```ts
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineResult,
} from '../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(removeCopiedApps);

const REPORTS_PAGE = 'export default function ReportsPage() {\n'
  + '  return <section data-testid="native-ui"><h1>Reports</h1></section>;\n}\n';
const OVERVIEW_FILTERS = "import { defineQueryFilters } from 'glirastes/browser';\n\n"
  + "export const overviewFilters = defineQueryFilters({\n  path: '/overview',\n  filters: { range: ['week', 'month'] },\n});\n";

async function artifactOf(root: string): Promise<AppSetupArtifact> {
  return AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
}

function toolNamed(artifact: AppSetupArtifact, name: string): AppSetupArtifact['tools'][number] {
  const tool = artifact.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
}

async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

/** `glirastes tools check`: frozen refresh that must fail with a named drift finding. */
async function failingCheck(root: string): Promise<ToolsPipelineResult> {
  const outcome = await runToolsPipeline({ root, mode: 'frozen' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  const { result } = outcome as ToolsPipelineFailure;
  expect(result.wrote).toBe(false);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'tool-outputs-drift', subjectRef: '.glirastes/foundation-execution-inventory.json' }),
  ]));
  return result;
}

async function passingCheck(root: string): Promise<void> {
  expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
}

/** Boots a deployment copy of the committed outputs and returns a turn in Alice's session. */
async function deployedTurn(root: string) {
  const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
  expect(app.disabled).toEqual([]);
  return app.turn({ cookie: `session=${app.createSession(principal())}` });
}

function hrefOf(result: unknown): unknown {
  return (result as { uiAction?: { payload?: { href?: unknown } } }).uiAction?.payload?.href;
}

describe('Next navigation change corpus', () => {
  it('adds a page: the same navigation tool offers it at once, without confirmation', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.navigate');
    await mkdir(join(root, 'src/app/(app)/reports'), { recursive: true });
    await writeFile(join(root, 'src/app/(app)/reports/page.jsx'), REPORTS_PAGE);

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes).toMatchObject({ added: [], changed: [before.toolId], removed: [] });
    const after = toolNamed(await artifactOf(root), 'ui.navigate');
    expect(after).toMatchObject({
      toolId: before.toolId, operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after.description).toContain('/reports');
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(await turn.guard.resolveApproval({ toolName: 'ui_navigate', input: { destination: '/reports' } })).toBe(false);
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/reports' }))).toBe('/reports');
  }, 240_000);

  it('changes a page path: the old destination is refused, the new one works', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.navigate');
    await cp(join(root, 'src/app/(app)/overview'), join(root, 'src/app/(app)/insights'), { recursive: true });
    await rm(join(root, 'src/app/(app)/overview'), { recursive: true });

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    expect(toolNamed(await artifactOf(root), 'ui.navigate').toolId).toBe(before.toolId);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    await expect(turn.execute('ui_navigate', { destination: '/overview' })).rejects.toThrow('Input does not match');
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/insights' }))).toBe('/insights');
  }, 240_000);

  it('removes pages: a removed destination is refused, and without pages the tool is tombstoned', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const navigateId = toolNamed(await artifactOf(root), 'ui.navigate').toolId;
    const highlightId = toolNamed(await artifactOf(root), 'ui.tasks.highlight').toolId;
    await rm(join(root, 'src/app/(app)/overview/page.jsx'));

    expect((await failingCheck(root)).changes.changed).toEqual([navigateId]);
    await runToolsPipeline({ root, mode: 'write' });
    await passingCheck(root);
    const turn = await deployedTurn(root);
    await expect(turn.execute('ui_navigate', { destination: '/overview' })).rejects.toThrow('Input does not match');
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/tasks' }))).toBe('/tasks');

    // The tasks page also registered the only tasks.highlight handler, so that tool goes too.
    await rm(join(root, 'src/app/(app)/tasks/page.jsx'));
    const removed = [navigateId, highlightId].sort();
    expect([...(await failingCheck(root)).changes.removed].sort()).toEqual(removed);
    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect([...refreshed.changes.removed].sort()).toEqual(removed);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ toolId: navigateId, stableKey: 'UI navigate' }),
        expect.objectContaining({ toolId: highlightId, stableKey: 'UI action tasks.highlight' }),
      ]));
    await passingCheck(root);
    const after = await deployedTurn(root);
    expect(Object.keys(after.registry)).not.toContain('ui_navigate');
    await expect(after.guard.beforeToolCall({ toolName: 'ui_navigate', input: { destination: '/tasks' } }))
      .rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});

describe('Next filter change corpus', () => {
  it('adds a filter: a new tool, active at once with defaults and no plan confirmation', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    await writeFile(join(root, 'src/overview-filters.js'), OVERVIEW_FILTERS);

    expect((await failingCheck(root)).changes.added).toHaveLength(1);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(1);
    const after = await artifactOf(root);
    const filter = toolNamed(after, 'ui.filter.overview');
    expect(refreshed.changes.added).toEqual([filter.toolId]);
    expect(filter).toMatchObject({
      executionKind: 'ui', actionBindingRef: 'glirastes.navigate', operationGroup: 'ui',
      riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(compareArtifacts(before, after).filter((change) => change.toolId === filter.toolId)).toEqual([
      { toolId: filter.toolId, classification: 'added', fields: ['toolId'], requiresConfirmation: false },
    ]);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(hrefOf(await turn.execute('ui_filter_overview', { range: 'week' }))).toBe('/overview?range=week');
    await expect(turn.execute('ui_filter_overview', { range: 'year' })).rejects.toThrow('Input does not match');
  }, 240_000);

  it('changes a filter domain: same identity, the new value works after refresh', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.filter.tasks');
    await replaceIn(root, 'src/task-filters.js', "status: ['open', 'done']", "status: ['open', 'done', 'blocked']");

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = toolNamed(await artifactOf(root), 'ui.filter.tasks');
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(hrefOf(await turn.execute('ui_filter_tasks', { status: 'blocked' }))).toBe('/tasks?status=blocked');
  }, 240_000);

  it('removes a filter: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const filterId = toolNamed(await artifactOf(root), 'ui.filter.tasks').toolId;
    await replaceIn(root, 'src/task-filters.js', "filters: { status: ['open', 'done'] }", 'filters: {}');

    expect((await failingCheck(root)).changes.removed).toEqual([filterId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([filterId]);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual([expect.objectContaining({ toolId: filterId, stableKey: 'UI filter /tasks' })]);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(Object.keys(turn.registry)).not.toContain('ui_filter_tasks');
    await expect(turn.guard.beforeToolCall({ toolName: 'ui_filter_tasks', input: { status: 'open' } }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('ui_filter_tasks', { status: 'open' })).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});
```

- [ ] **Step 2: Run the corpus**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run tests/tool-sync-next-ui.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  6 passed (6)`. These are acceptance tests over Tasks 13–18, so they are expected to pass on the first run; a failure names the step (`failingCheck`, identity, defaults, boot) and is a generator defect — fix the generator, not the test.

- [ ] **Step 3: Name the corpus in the fixture README**

1. In `examples/source-driven-next/README.md`, replace:

````markdown

```sh
bun run build
bunx vitest run tests/source-driven-next.test.ts tests/source-driven-ui.test.tsx tests/source-driven-build.test.ts tests/tool-sync-next.test.ts
```

The endpoint test copies only the native app to isolated temporary directories
````

with:

````markdown

```sh
bun run build
bunx vitest run tests/source-driven-next.test.ts tests/source-driven-ui.test.tsx tests/source-driven-build.test.ts tests/tool-sync-next.test.ts tests/tool-sync-next-ui.test.ts
```

The endpoint test copies only the native app to isolated temporary directories
````

2. In `examples/source-driven-next/README.md`, replace:

```markdown
the chat does. The app's own bridge receives the router pushes; the real tasks
page shows the URL filter and runs its own handler, whose Zod contract still
rejects a payload that the generated JSON Schema lets through. The change
corpus (`tests/tool-sync-next.test.ts`) adds, changes and removes an endpoint.

## Real Next and browser test

```

with:

```markdown
the chat does. The app's own bridge receives the router pushes; the real tasks
page shows the URL filter and runs its own handler, whose Zod contract still
rejects a payload that the generated JSON Schema lets through. The change
corpus (`tests/tool-sync-next.test.ts`, `tests/tool-sync-next-ui.test.ts`)
adds, changes and removes an endpoint, a page and a filter.

## Real Next and browser test

```

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add examples/source-driven-next/README.md tests/tool-sync-next-ui.test.ts
git commit -m "test(codegen): cover next navigation and filter add, change and delete"
```

### Task 20: Full gates and CLI smoke run

**Files:** none (verification only, no commit).

- [ ] **Step 1: Run every gate**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run typecheck && bun run build && bun run typecheck:tests && bun run test
```

Expected: every command exits 0 — the build prints `Generated 18 subpath shims.`; Vitest reports `Test Files  205 passed (205)` and `Tests  2102 passed (2102)` (baseline 192 files and 1930 tests plus 13 files and 172 tests from this plan). On a heavily loaded machine (here a load average around 40) Vitest's 5-second default timeout can expire in timing-sensitive files this plan does not touch (`src/codegen/tools/handler-analysis.test.ts`, `program.test.ts`, `schema-probe.test.ts`, `src/react/components/__tests__/voice-push-to-talk.test.tsx`); then rerun `bunx vitest run --maxWorkers=4`, which reported the same 205 files and 2102 tests green in about 190 s, and note the load in the checkpoint instead of changing those tests.

- [ ] **Step 2: Run the browser proof**

Run the two commands of Task 18 Step 8 again. Expected: `ℹ pass 6` and `ℹ fail 0` in dev and production mode.

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
  && node dist/cli/bin.js tools status --root "$SMOKE"; \
  STATUS=$?; node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "$SMOKE"; exit $STATUS
```

Expected: refresh prints `Glirastes tools (write): 4 added, 0 changed, 0 removed` with `+ ui.filter.tasks  UI glirastes.navigate  [safe-read]`, `+ ui.navigate  UI glirastes.navigate  [safe-read]`, `+ ui.tasks.highlight  UI tasks.highlight  [safe-read]` and `+ tasks.list  GET /api/tasks  [safe-read]`; both checks print `Tool outputs match the code.` and `Tool outputs verified (integrity).`; status prints `What can my chat do? 4 active tools, 0 need attention.` with `contract: ui-bridge, description: code, schema: json-schema` for the three UI tools; exit 0; the copy is gone afterwards.

- [ ] **Step 4: Record the checkpoint (no commit)**

Note in the P04 checkpoint report: gate results and test counts, the browser proof in both modes, and the open items of the Self-Review (Platform lockstep requests, P11 wiring of `reportCapabilities` and `policyOverlay`, P06/P05 follow-ups).

---

## Self-Review

**Spec coverage (spec section → task):**

| Spec | Covered by |
| --- | --- |
| 4.4 Navigation: `ui.navigate` with a `destination` enum from the page tree (no route groups, `_private`, `api`, `stripSegments` such as `[locale]`, default exclusions login/callback/MCP, policy exclusions) | Tasks 14, 15 |
| 4.4 Filters: `ui.filter.<view>` from nuqs parsers (`parseAsStringLiteral` ⇒ enum, `parseAsInteger`, `parseAsArrayOf`, `parseAsString` ⇒ open + `filter-domain-open`), typed `searchParams`, `useSearchParams().get`, `defineQueryFilters` (SPA) | Tasks 9, 16 |
| 4.4 Execution through `useGlirastesNavigationBridge({push})` / `registerNavigationBridge({push})` | Tasks 9, 10, 11, 18 |
| 4.4 UI actions: payload from the contract argument or the parameter type, untyped ⇒ `ui-action-payload-untyped`; 4.3 "drittes Argument von `useAiClientAction`"; literal ids at `useAiClientAction`, `registerAiClientAction`, `bus.subscribeById` | Tasks 10, 17 |
| 4.4 Enumeration complete or abort (`E-INVENTORY-011`), every element a tool, a disabled `needs_attention` tool or a reasoned exclusion | Tasks 14, 15, 16, 17 |
| 4.5 GET/HEAD read defaults; UI defaults; "UI-Handler mit nachweisbarem schreibendem Fetch ⇒ write" | Tasks 8, 13, 17 |
| 4.9 Overlay ids without a local binding ignored (`platform-tool-not-in-code`); a missing or different binding disables only that tool | Tasks 2, 3, 4 |
| 4.10.3 the signed description reaches the model; 4.10.6 capability report once per `discoveryDigest`; 4.10.9 `RuntimePolicyRevision.toolOverrides` and provenance in lockstep | Tasks 1, 2, 5, 6, 7 |
| 4.11 `examples/source-driven-next`: `adapter.mjs`/`ui-adapter.mjs`/`build.mjs` give way to `tools refresh` with next-app, next-pages, url-filters, react-actions | Task 18 |
| 4.12 Next navigation and filter × add/change/delete (6 tests); additional corpus "entfernte Brücke ⇒ Navigation/Filter `needs_attention`" | Task 19; Tasks 15 and 16 (bridge) |
| Roadmap: P04 row, `ToolContract.runtime` (UI tools), `*.d.mts` with the `.mjs` modules, HEAD as read tool, SDK half of the signed delta field, `local-deployment-validator.ts` (pulled forward from P05) | Tasks 1–4, 8, 13, 18 |
| P08b shared contract items 1, 2, 3, 5, 6 and ledger X1 (ESM cycle), X2 (delta description in managed mode), X3 (`schemaSource` values), X4 (exclusion caps) | Tasks 1, 2, 5, 6, 7 |

Not in P04 by the roadmap: react-router/vue-router page sources, `.vue` `<script>` registrations and the `browser-actions` source name of the Vue fixture (P06); `tools resolve|describe|eval|policy|verify`, the "N tools need a better description" hint, `policy-entry-orphaned` for excluded routes and `tools refresh --watch` (P05); `chatCommands`/`chatEntities` derived from UI tools (P07b); wiring `policyOverlay`, `platformRevisions`, `reportCapabilities()` and the navigation bridge into Get It Done (P11); the Node 20/22 byte-identity matrix (P13).

**Deliberate decisions and deviations (veto possible; for the P05/P06/P11 planners):**
- Ledger X1 allowed the shared schemas either in `revisions.ts` or in a leaf module; this plan uses the leaf `tool-policy-entry.ts`, which imports only `zod`, and keeps every old import path through re-exports.
- Task 3 goes beyond the contract text: `createTurnSnapshot` folds a revision's own `toolOverrides`. Without it, the Get It Done pilot (snapshots straight from Platform revisions) would accept decisions after Task 1 and ignore them, where it used to refuse them.
- The validator also tolerates a changed binding (`platform-tool-binding-mismatch`), not only a missing one. A policy-only revision keeps the Platform manifest of the last capability report, so after any code change of an existing tool a strict check would refuse every later decision; the runtime still disables such a tool per turn (local manifest in managed mode, `E-BINDING-011` on the pilot path).
- UI tool inputs are JSON Schema read from code (page paths, parser types, the checker type of a Zod contract via `_output`), never module exports: the generated module runs on the server and must not import client components. Zod refinements such as `.min(1)` therefore do not reach the model schema; the app's own contract stays the last word at dispatch (Task 18 pins it), and `tools status` grades these schemas `json-schema`.
- A filter is a navigation with a query string through the same bridge (`ui.filter.<view>` pushes `<path>?<keys>`); it sets exactly the declared keys and drops other query parameters of that view.
- One `ui.navigate` tool with a `destination` enum (spec wording) instead of one tool per page; dynamic segments go into `params`.
- The capability report is the committed setup artifact itself, provenance and exclusions included, so the runner uploads what the generated module already carries. Upload "once per process": content-addressed run ids make a repeat after a restart an idempotent call.
- Pages use the stable key `PAGE /path`, and `PAGE` joins the exclude-pattern grammar (the Platform does not port `ToolPolicyFileSchema`).
- `useAiClientAction`'s handler now receives `payload: T` (default `Record<string, unknown>`) instead of `payload?: Record<string, unknown>`; existing callers that write `payload?.x` still compile.
- `UiActionBus` moves to `glirastes/browser` and is re-exported by `glirastes/react`; `getDefaultUiActionBus` checks the shape instead of `instanceof`, so the dist and source copies a test or a bundle may load share one bus.
- The jsdom UI test refreshes through the built CLI (`refreshWithCli`): under jsdom `new URL(relative, import.meta.url)` turns into `http://localhost:3000/…`, which breaks the in-process schema probe spawn; `tests/support/tool-runtime.ts` uses path arithmetic for the same reason.
- `glirastes.*` UI actions are reserved for generated UI tools (Task 11): the provider dispatches them to the app's bridge without asking again (Task 10), so `endpointToolToTool` drops them from whatever an endpoint returns (its `uiAction` field, a pattern or a template). Otherwise a record an endpoint returns at top level could navigate or run a write client action without that action's confirmation. Side effect: an endpoint's own `uiAction` field no longer passes through raw when it is not a record (it was useless to the client before).
- `createUiActionSchema` accepts the two generated shapes (Task 11). Get It Done passes `uiActionSchema` (built with `createUiActionSchema([…])`) to `createAiChatHandler`, whose `normalizeResultUiAction` would otherwise drop every generated UI action with "Invalid UI action dropped."; an app with a hand-written `uiActionSchema` must add them itself (P11 note).
- The bridge also refuses dot segments in the path (`/a/..//host` resolves to `//host`), and `buildNavigationHref` refuses `.` and `..` route parameters, so a model-chosen parameter cannot move the path (Task 9).
- A `defineQueryFilters` view without a page file (SPA paths) follows the same default and policy exclusions as pages (`pathExclusion`, Tasks 14 and 16), so a `PAGE /admin/**` exclusion is never bypassed by a filter definition.

**Platform lockstep requests (not done here):**
- HEAD: the Platform's strict `app-setup.dto.ts` (and the manifest and tool revision derivation behind it) accepts only GET/POST/PUT/PATCH/DELETE. An app with a HEAD route would get its capability report and `glirastes sync` refused until the Platform adds `HEAD`. Owner: a P08b follow-up commit before P11.
- P08b Task 9 (provenance and exclusions in the DTO, `81f0682`) has landed on `codex/mvp-platform`; its X3 widening (`schemaSource` `json-schema`, `none`), scheduled as an extra commit in P08b Task 12, must land before a P04 runner reports, else every app with a JSON-schema resolution, a UI tool or a contract-less tool gets its report refused (`app_setup_request_invalid`).

**Known limits (open items for P05/P06/P11):**
- A client action is `write` only when its handler body calls `fetch` with POST/PUT/PATCH/DELETE or `axios.post|put|patch|delete` directly (spec 4.5 "nachweisbar"). A handler that writes through a helper, a Server Action or a mutation hook stays `safe-read` without confirmation; the developer raises it with `tools policy raise` / `tool-policy.json`. P05's worklist and the `maintaining-glirastes-tools` skill should point at UI handlers that call imported functions.
- An intercepting route (`(.)tasks/[taskId]`) is reported as the exclusion `PAGE /tasks/:taskId` even when the real page of that path is a destination; the capability view then lists the path under exclusions as well. Cosmetic; P08c can show page exclusions next to `ui.navigate` destinations.
- `defineQueryFilters` views of SPA paths get no navigation counterpart: `ui.navigate` reads only the Next app router tree (react-router/vue-router page sources are P06).

**Alignment with P02, P03 and P07 (re-checked against the code at `24b5075`):** `applyPolicyOverlay`, `resolveToolPolicy` and the golden vectors in `src/contracts/__vectors__/tool-policy.v1.json` are unchanged (the moved schemas are byte-identical); the P02 `platformRevisions` coupling stays mandatory with `policyOverlay`. P03's pipeline renders endpoint bindings exactly as before (Task 13); its endpoint corpus only learns to pick `tasks.list` by name (Task 18). Task 6 adds `provenance` and `exclusions` to every setup artifact, so an app that committed P03 outputs sees `tools check` drift once after the SDK upgrade until it runs `tools refresh` — expected for an unpublished contract change in lockstep with the Platform. P07's `glirastes/embed` and chat UI are untouched; `glirastes/react` keeps its `UiActionBus` exports.

**Placeholder scan:** done — every step carries complete code (new files in full, existing files as exact replace blocks that each occur once) or exact commands; no TBD/TODO, no "similar to Task N". RED and GREEN counts were measured by replaying every task on a `git archive` copy of `24b5075` with the worktree's `node_modules` linked: each task's test files on its parent (RED), then the task (GREEN). The rendered plan was then applied mechanically (every Create, whole-content and replace block, and the `git rm` of Task 18) to a fresh `git archive` of `24b5075`; the result is byte-identical to the tested tree.

**Type consistency check:** done — names used verbatim across tasks: `ToolOverrideDelta`/`ToolOverrideDeltaSchema`, `overlayDescriptions`, `LocalDeploymentValidation`/`IgnoredPlatformTool`, `AppSetupToolProvenance`/`AppSetupExclusion`/`APP_SETUP_EXCLUSION_LIMITS`, `clipExclusions`, `CapabilityReport`/`capabilityReportFrom`/`uploadCapabilityReport`/`reportCapabilities`, `GLIRASTES_NAVIGATE_ACTION_ID`, `buildNavigationHref`, `registerNavigationBridge`, `registerAiClientAction`, `dispatchToolResultUiActions`, `defineQueryFilters`, `getDefaultUiActionBus`, `useGlirastesNavigationBridge`, `GeneratedUiAction`/`uiActionToolToTool`, `GeneratedUiToolBinding`, `ToolContract.uiAction`, `uiObservation`, `createNextPagesSource`/`createUrlFilterSource`/`createReactActionSource`, `createConfiguredSources`. Compile-time proofs: `toToolContract` (Task 13 file schema ↔ `ToolContract`), the strict type-check of a generated module with UI bindings against `createContractBindings` (Task 13), `bun run typecheck:tests` over every new test (Task 18 Step 7, Task 20).
