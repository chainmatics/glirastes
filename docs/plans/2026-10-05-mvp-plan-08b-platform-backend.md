# Platform-Backend für Tool-Policy, Capabilities und Betrieb (P08b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Platform a bounded, restrict-only policy layer over the tools the deployed code reports. Operator decisions are checked against the SDK's own bounds (out of bounds answers 422 with a reason code), signed only as deltas, published as policy-only revisions through a direction-aware security gate, and applied through the existing health gate and revocation. Runners report what their code can do; the Platform shows it per environment ("Was kann mein Chat?") and never enables anything. New tools need no sync or apply. A secured admin command switches a tenant to Pro for P10, and app-bound keys stop reaching other apps through audit, stream, gate and deployment reads.

**Architecture:** Continue on `codex/mvp-platform` in `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform` from P08a's last commit `4bb9415`. The SDK's `resolveToolPolicy` is ported line by line into `apps/api/src/modules/runtime-setup-v2/tool-policy.ts` and proved byte-identical against the SDK's golden vectors, copied verbatim. `boundToolOverride` builds on it and replaces the unconditional `applyToolOverride`. Tool revisions keep exactly what the code reported; decisions live in a new signed `toolOverrides` delta on the app configuration and on the environment policy revision, so a decision change is a policy-only revision that never rebinds a tool or the planner. Capability reports reuse the setup transport (`createRun` + `PUT artifact`, already open to app-bound runtime keys since P08a) plus one digest in the runner registration. Every task is a separately committed TDD cycle; the database is proved offline with PGlite.

**Tech Stack:** TypeScript 5.9, Bun 1.3, NestJS 11, Vitest 3.2 (API), `bun:test` with `@electric-sql/pglite` 0.5.8 (DB), Drizzle ORM 0.39.3 and drizzle-kit 0.30.6, zod 3.25.76 (requests) and its `zod/v4` subpath (the policy port, for SDK parity), rxjs 7.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md section 4.10 items 1-7 and 9-10 (item 8, the Citadel UI, and the `/manage` and `/connect` redesign are P08c after the "Living Network" design approval; item 11 is P10), 4.5 (bounds and lifecycle), 4.9 (runtime enforcement), 7 "Pro-Freischaltung"; roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md rows owned by P08b ("Pro-Freischaltung per abgesichertem Admin-Befehl", "App-Scope-Prüfung für app-gebundene Keys in /v1/audit, /v1/stream, Gate-Config, Deployment-Liste", "Platform-'Lockern' im Managed-Modus nur als wirksam anzeigen, wenn ein committeter lokaler Eintrag existiert", the Platform half of "Signiertes Delta-Feld RuntimePolicyRevision.toolOverrides", and "der Platform-Port erzeugt und liest riskClass"). SDK reference (read-only): `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` (`codex/mvp-tools`), `src/contracts/tool-policy.ts` and `src/contracts/__vectors__/tool-policy.v1.json` (committed in `29fce41`), `src/runtime/policy-overlay.ts`, `src/sync/materialize-deployment.ts`, `src/sync/local-deployment-validator.ts`.

## Global Constraints

- No pushes, merges into `main`, npm publishes, deployments, or changes to any shared database. All commits stay local on `codex/mvp-platform`. Never connect to Neon: migrations are proved on in-process PGlite, and `drizzle-kit` runs with `DATABASE_URL=postgres://offline.invalid/unused` so `packages/db/drizzle.config.ts` never loads a `.env` file (`generate` and `check` do not connect).
- Never open, print or copy `.env*`, `.secrets/` or `.npmrc` contents.
- The SDK worktree is read-only. Task 2 copies one file out of its object store with `git show`; nothing in the SDK repository changes.
- Shell `rm` is denied in this environment, and no step needs it: every new file is part of the change, tests clean up their own temporary directories through Node's `fs`, and scratch files live in `mktemp -d` directories.
- Implementers never edit this plan file.
- Patches are applied from the worktree root with `git apply`, which is all-or-nothing. They were generated against `4bb9415` and applied cumulatively in task order; if one does not apply, stop and report instead of editing by hand. New files are written with exactly the content shown. The three generated files of Task 1 (`0044_bounded_tool_overrides.sql`, `meta/0044_snapshot.json`, the journal entry) come from `drizzle-kit generate`, never from hand edits.
- TDD: verify RED first, then the minimal change, then GREEN. Do not weaken protections; do not delete compatibility code (spec 1). Where an existing test encoded the behaviour this plan replaces (unconditional overrides, "no allowed roles fails", apply for a ready run), the step says which expectation changes and why.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution.
- Agent shells reset the working directory between calls. Every bash block below therefore starts with an absolute `cd`.
- Commands: API tests `cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run <path>`; API typecheck `bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"` in `apps/api` (sources and specs); DB `bun test` in `packages/db`. The API typecheck reads `@glirastes/db` from `packages/db/dist`, so Task 1 rebuilds it once (`./node_modules/.bin/tsc -p tsconfig.json` in `packages/db`); Vitest reads the schema sources directly.
- Baseline at `4bb9415` (P08a Task 23, re-measured on 2026-10-05 in a copy of `4bb9415`): API `Test Files  116 passed (116)`, `Tests  1153 passed | 10 skipped (1163)`, typecheck exit 0; Citadel `tsc` exit 0, `Test Files  39 passed (39)`, `Tests  256 passed (256)`, lint exit 0 with `✖ 30 problems (0 errors, 30 warnings)`; DB `101 pass`, `Ran 101 tests across 19 files.`; `migrations-from-scratch` plus `migration-baseline` `6 pass`.
- Production follow-ups are prepared and requested, never executed: applying `0044` to the shared database (after the P08a baseline runbook) and the first Pro switch (Task 14 checkpoint).

### Decisions taken in this plan (veto possible)

| Topic | Decision | Why |
| --- | --- | --- |
| What the port covers | `riskTier`, `confirmationFloor`, `mostRestrictiveRiskClass`, `intersectAllowedRoles`, `ToolPolicyEntrySchema`, `resolveToolPolicy`, `TOOL_POLICY_RULES_VERSION`; not `deriveToolPolicyDefaults` or `ToolPolicyFileSchema` | The Platform never derives a code default or reads `tool-policy.json`; it reads what the code reported. Less ported code, less drift. |
| Port validation library | `zod/v4` (shipped inside zod 3.25.76) | The golden vectors pin `E-POLICY-001` field paths, which come from zod 4's issue paths. |
| Override request shape | Fields optional, `null` removes a stored decision, `unknown` is not an operator choice, `allowedRoles` added | An operator must be able to undo a decision; the old schema could only add. |
| Out of bounds on save | 422 `{ code: 'tool_override_out_of_bounds', field, reason }` with `risk-class-lowered`, `risk-class-relabelled`, `cannot-enable-disabled-tool`, `tier-3-always-requires-approval`, `relaxation-requires-reviewed-pin`, only for a field the request decides; a stored field the code has since outgrown stays stored, is clamped at publication and never blocks a save of other fields | Spec 4.10.1; the reasons reuse the SDK's `E-POLICY-002` wording where one exists. Without the restriction, a code change that raises a tool's risk would lock every later edit of that tool behind a 422 about a field nobody sent. |
| Legacy rows | A decision stored before this plan is clamped at publication (out-of-bounds fields dropped), never applied | The old `applyToolOverride` let an operator lower risk and enable tools; a stored row from then must not reach a runner. |
| Relaxation pin | `requiresApproval: false` below tier 3 is signed with `pin { toolId, atRiskClass: baseline_risk_class }`; the baseline is what the code reported when confirmation was last decided | Mirrors the SDK's reviewed-pin rule; a later code raise lets the relaxation lapse (`override-lapsed-risk-raised`) instead of silently carrying it to a riskier tool. |
| Migration `0044` | Adds `baseline_risk_class`, `baseline_requires_approval`, `allowed_roles` to `runtime_app_setup_tool_overrides` **and** `tool_overrides jsonb not null default '[]'` to `runtime_config_revisions` | The config revision payload is column-mapped (`drizzle-runtime-revision.store.ts`), so the signed deltas need a column; one migration keeps the change atomic. Deviation from spec 4.10.2's column list. |
| Where decisions live | Tool revisions and the derived manifest carry what the code reported; decisions are `toolOverrides` deltas on the configuration (app) and the policy revision (environment); `toolPolicies` keeps the reported values (transitional, see the shared contract) | A decision change becomes a policy-only revision that rebinds nothing; "never copies of local values" holds for the deltas. |
| Planner allowlist | `planner.toolIds` ∩ tools the code reports enabled; a Platform disable is a delta and never touches the planner; derivation fails closed (409) if a signed planner allowlists a disabled or unbound tool | The SDK runner rejects a whole deployment whose allowlist names a disabled tool (`local-deployment-validator.ts`). |
| Pre-P04 runners | `toolOverrides` is emitted only when non-empty | A policy without decisions stays byte-identical to today (content-hash reuse, older runners accept it). A runner before SDK P04 rejects a policy with decisions (strict schema) and keeps its last accepted deployment: fail closed, documented in the shared contract. |
| Security approval | Direction-aware per revision type: a new tool at its confirmation default, a pure hardening, a new tool binding (with the planner and runtime digest that change with it) and allowlist changes need none; a loosening, a rebinding of an existing tool, a changed route, schema digest, model or budget still do | Spec 4.10.5. An allowlist entry cannot enable a tool that its revision or a signed delta disables, so the decisions themselves carry the gate. Residual: a configuration that adds or removes a binding may point at any already published planner revision of the app without approval; that planner revision was gated when it was published (see the Task 14 findings). |
| Generic revision endpoint | The bounds check runs in `RuntimeRevisionService.prepareDraft`, so every draft path (generic endpoint, composites, derivation) is held to it | One place, no bypass. |
| Policy-only revision | Drafted on every in-bounds save on top of the latest published configuration (deterministic id `policyOnlyRevisionId(base, deltas)`, so the same decision set drafts once); applied by `POST /v2/apps/:appId/runtime-setup/configurations/:configurationRevisionId/apply` and, while one is pending, by the dashboard's existing connected apply, which keeps its pipeline and freshness checks. "Pending" is the revision that signs the current decisions (`ToolPolicyRevisionService.target`), never the newest draft | Spec 4.10.4 and 4.10.10; Citadel keeps working unchanged until P08c. With deterministic ids a decision changed back leaves an older draft behind; applying that (owners self-approve) would revive the reverted decision. |
| Capability report | Runner registration carries `capabilities.discoveryDigest`; the artifact for that digest arrives through the existing setup transport; no migration | `runtime_runners` already holds one runner per environment with a `capabilities` column. |
| Capability view comparison | Status compares with the configuration active in the environment, else the latest published one; no report answers `codeVersion: { status: 'not-reported' }`; values show the saved decisions and `decisionPending` marks those the environment does not run yet | "new/changed/removed" need a reference the Platform has signed; a saved disable must never read as one the chat already obeys. |
| Connected overview | Response shape unchanged; `action` is `apply` only for a pending Platform-side change (the policy-only revision that signs the current decisions and is not active in the environment, or decisions saved before anything was published); a run whose deployment a decision apply superseded with the same runtime digest stays `active` | Citadel parses the overview with a strict schema; P08c changes the UI. |
| Pro switch | `packages/db/scripts/switch-tenant-plan.ts` (`bun --no-env-file run admin:switch-plan`), connection only from `GLIRASTES_ADMIN_DATABASE_URL`, dry run unless `--apply`, slug confirmation, `free` ↔ `pro` only, refuses `enterprise`/`platform` and Stripe-owned tenants, plan change and audit event in one transaction | Spec 7: no billing UI, no manual SQL; an inherited `DATABASE_URL` can never select the database. |
| App-bound key reads | `appScopeFor(tenant, requested)` forces the key's app and answers another app with 404; audit export routes become `@TenantWideOnly()`, and the export status compares the job's tenant | Same rule as P08a's `/v1/apps`; exports are tenant-wide by construction; export job ids are sequential, so the status route must not trust the id alone. |

## Shared SDK contract (Platform side implemented here, SDK side in P04)

Both sides are unpublished and change in lockstep (spec 12). The Platform accepts and emits exactly these shapes from this plan on; the SDK adopts them in P04 (`codex/mvp-tools`). Until then nothing a pre-P04 runner already accepts changes, except that a policy revision carrying decisions is refused by it (fail closed, last accepted deployment stays).

1. **Decision delta** (`ToolOverrideDelta`): `{ toolId: uuid } & ToolPolicyEntry`, where `ToolPolicyEntry` is the SDK's strict `ToolPolicyEntrySchema` (`enabled?`, `requiresApproval?`, `riskClass?`, `allowedRoles?`, `description?`, `reason?`, `pin?`). The Platform emits only fields an operator decided and that are in bounds; it never emits `enabled: true` or `reason`, emits `requiresApproval: false` only with `pin: { toolId: <same toolId>, atRiskClass: <tier ≤ 2> }`, emits `allowedRoles` sorted, de-duplicated and non-empty, and `description` of at most 1,000 characters (SDK limit 4,000). Example:

   ```json
   { "toolId": "019fb001-0000-7000-8000-000000000006", "enabled": false,
     "riskClass": "delete", "allowedRoles": ["admin"], "description": "Archives a task." }
   ```

2. **`RuntimePolicyRevision`** (environment-scoped, signed) payload: `{ budget, toolPolicies, toolOverrides? }`.
   - `toolPolicies` (TRANSITIONAL until P04): one `RuntimeToolPolicy` per bound tool with the values the code reported (`enabled`, `riskClass`, `requiresApproval` from the tool revision, `allowedRoles` from the artifact, `[]` allowed). It never carries a Platform decision.
   - `toolOverrides`: deltas as in 1, sorted by `toolId`, unique, present only when non-empty.
   - SDK P04: `RuntimePolicyRevisionSchema` gains `toolOverrides: z.array(<delta>).default([])`; `policyOverlayFromRevision` builds its entries from `toolOverrides` (no longer from `toolPolicies` copies); `applyPolicyOverlay` stays restrict-only, so a Platform relaxation stays a no-op without a committed local entry (the Platform shows it as `relaxationPending`). The overlay keeps the `platformRevisions` coupling from P02 (agent and policy revision of the same accepted deployment), so revocations by `policyRevisionIds` keep working. `validateLocalDeploymentBindings` keeps checking the agent allowlist against the reported `toolPolicies` (the Platform only allowlists tools the code reports enabled), never against overlay-restricted policies: a tool that only a `toolOverrides` delta disables stays allowlisted, is filtered at runtime, and must not make the runner reject the whole deployment.
3. **Manifest revision**: unchanged shape; `description` is the delta's `description` when one is signed, else the reported one.
4. **App configuration revision** (Platform-internal, signed): gains `toolOverrides?` (same shape and rule as 2) and, for a policy-only revision, `parentRevisionId` of its base.
5. **Capability report**: the existing `AppSetupArtifact`, uploaded once per `discoveryDigest` with the runner's app-bound runtime key through `POST /v2/apps/:appId/runtime-setup/runs` and `PUT .../runs/:runId/artifact` (a `runId` must always carry the same digest; repeating an upload is idempotent). Two optional, content-free extensions, accepted by the Platform's strict DTO from Task 9 on and to be added to the SDK's strict schemas in P04 before the SDK sends them:
   - per tool `provenance?: { policyOrigin?: Partial<Record<'enabled'|'requiresApproval'|'riskClass'|'allowedRoles'|'description', 'code-default'|'local-policy'>>, contractSource?: 'native'|'contract-module'|'legacy-ai-tool'|'resolution'|'openapi'|'derived'|'ui-bridge', descriptionSource?: 'human'|'code'|'agent'|'template', schemaSource?: 'zod'|'openapi'|'agent'|'field-names' }` (the "von Hand / aus Code / Agent / Vorlage" and "Zod / OpenAPI / Agent / nur Feldnamen" quality of spec 4.7);
   - artifact `exclusions?: Array<{ stableKey: string (≤ 512), origin: 'default'|'policy'|'code' }>` (≤ 5,000).
   Absent fields mean "not reported", never a default.
6. **Runner registration**: `POST /v1/runtime/apps/:appId/environments/:environmentId/runners/register` accepts `capabilities.discoveryDigest` (`sha256:` + 43 base64url characters); anything else in that field is 400. The SDK runner sends the digest of the code it runs at every registration (P04).
7. **Capability view**: `GET /v2/apps/:appId/environments/:environmentId/capabilities` (management scope; an app-bound key only for its own app) returns `{ appId, environmentId, codeVersion, comparedTo, tools[], exclusions[] }`; each tool row carries `toolId, name, description, presentation, kind, method, path, riskClass, requiresApproval, enabled, allowedRoles, origin{enabled, requiresApproval, riskClass, allowedRoles, description} ('code-default'|'local-policy'|'platform'|null), status ('new'|'changed'|'risk-raised'|'removed'|'needs-attention'|'unchanged'), relaxationPending, decisionPending, warnings[], quality{contractSource, descriptionSource, schemaSource}`; `exclusions[]` rows carry `status: 'excluded'`. The values reflect the saved decisions; `decisionPending` says that the environment does not run them yet (apply pending).

## Review Focus

1. **No out-of-bounds decision reaches a runner.** Saving lowers no risk class, relabels none, enables nothing the code disabled and never relaxes tier 3 (422 with the reason, nothing stored); a decision stored before this plan is clamped at publication; the generic revision endpoint and every other draft path refuse out-of-bounds deltas and tier-3 policies without confirmation. Pinned in Task 3 Step 1 and Task 7 Step 1.
2. **The Platform resolves policy exactly like the SDK.** The port reproduces every SDK golden vector byte for byte (serialized, so field order and absent keys count), and the test fails as soon as the copied vectors differ from the pinned SDK file. Pinned in Task 2 Step 1.
3. **Decisions are signed only as deltas.** Tool revisions, the manifest and `toolPolicies` keep what the code reported; the signed configuration and the derived policy carry the bounded deltas; derivation never reads the live decision table; a policy without decisions keeps its old bytes; empty roles are accepted; the planner allowlists only enabled tools; an apply rolls out only the revision that signs the current decisions, never a draft left behind by a decision that was changed back. Pinned in Task 4 Step 1, Task 5 Step 1, Task 8 Step 1 and Task 11 Step 1.
4. **Security approval follows the direction of a change.** A new tool at its confirmation default and every pure hardening publish without it; every loosening, rebinding of an existing tool, changed route or schema digest, model or budget still needs it. Pinned in Task 6 Step 1.
5. **Reports and app-bound keys never widen anything.** A capability report changes no decision and enables no tool (a Platform disable stays in force, enabling a code-disabled tool is refused); an app-bound key reads only its own app on audit, stream, the gate matrix, the deployment list and the capability view, and no key reads another tenant's audit export. Pinned in Task 9 Step 1, Task 10 Step 1 and Task 12 Step 1.

---

## File Structure

All paths are relative to the worktree root `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`.

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/db/src/schema/runtime-app-setup-tool-overrides.ts`, `runtime-config-revisions.ts` | Modify (Task 1) | New decision columns; signed deltas on configurations |
| `packages/db/drizzle/0044_bounded_tool_overrides.sql`, `meta/0044_snapshot.json`, `meta/_journal.json` | Generate (Task 1) | Migration `0044` via `drizzle-kit generate` |
| `packages/db/src/__tests__/bounded-tool-overrides-migration.test.ts`, `migration-baseline.test.ts`, `packages/db/MIGRATIONS.md` | Create / modify (Task 1) | Additive migration proof; runbook after `0044` |
| `apps/api/src/modules/runtime-setup-v2/tool-policy.ts`, `__vectors__/tool-policy.v1.json`, `__vectors__/README.md`, `__tests__/tool-policy-vectors.spec.ts` | Create (Task 2) | SDK policy port, copied vectors, parity test, re-sync rule |
| `apps/api/src/modules/runtime-setup-v2/tool-override.ts` (+ spec), `runtime-setup-v2.service.ts`, `runtime-setup-v2.store.ts`, `drizzle-runtime-setup-v2.store.ts`, `connected-apply-claim.ts`, `runtime-revisions/app-configuration.service.ts` | Modify (Task 3) | `boundToolOverride`, 422 on save, deltas in the reviewed artifact |
| `apps/api/src/modules/runtime-revisions/app-configuration.service.ts` (+ spec), `drizzle-runtime-revision.store.ts` | Modify (Task 4) | Deltas in the configuration, allowlist, `createPolicyOnlyRevision` |
| `apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts` (+ spec), `drizzle-desired-state-derivation.store.ts` | Modify (Task 5) | Emit `toolOverrides`, signed description, empty roles, allowlist check |
| `apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts` (+ spec) | Modify (Tasks 6-7) | Direction-aware gate; bounds for every draft |
| `apps/api/src/modules/runtime-revisions/runtime-revision.service.ts`, `__tests__/runtime-revision.controller.spec.ts` | Modify (Tasks 7-8) | Bounds in `prepareDraft`; `findStatus` |
| `apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts` (+ spec), `publish-and-deploy-id.ts`, `publish-and-deploy.service.ts` (+ spec), `runtime-setup-v2.controller.ts` (+ specs), `runtime-setup-v2.module.ts`, `runtime-deployments/runtime-deployment.module.ts` | Create / modify (Task 8) | Policy-only drafts on save; configuration apply |
| `apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts`, `runtime-connections/runtime-connection.service.ts` (+ spec), setup store and service | Modify (Task 9) | Capability report extensions, registered digest, reported-tool guard |
| `apps/api/src/modules/runtime-setup-v2/capability-view.service.ts`, `capability-view.controller.ts`, `__tests__/capability-view.spec.ts` | Create (Task 10) | `GET .../environments/:environmentId/capabilities` |
| `apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts` (+ spec), `publish-and-deploy.service.ts`, setup store and service, `apps/api/scripts/verify-connected-free-rehearsal.ts` | Modify (Task 11) | Apply only for Platform-side changes |
| `apps/api/src/common/app-scope.ts`, `common/__tests__/app-scope-gaps.spec.ts`, audit controller/service (+ spec), stream controller, gate-config controller, deployment controller | Create / modify (Task 12) | App scope for app-bound keys on four read surfaces |
| `packages/db/scripts/switch-tenant-plan.ts`, `src/__tests__/switch-tenant-plan.test.ts`, `packages/db/package.json`, `CLAUDE.md` | Create / modify (Task 13) | Audited Pro switch without manual SQL |

---

### Task 0: Verify the baseline (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Preconditions**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git branch --show-current
git rev-parse --short HEAD
git status --short | wc -l
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools cat-file -e 29fce41:src/contracts/__vectors__/tool-policy.v1.json && echo "sdk-vectors=present"
```

Expected: `codex/mvp-platform`, `4bb9415`, `0`, `sdk-vectors=present`. Anything else: stop and report.

- [ ] **Step 2: Build the DB package and run the baseline gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && ./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"; ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel && ./node_modules/.bin/tsc --noEmit; echo "citadel-tsc=$?"; ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "; L="$(mktemp -d)"; bun run lint > "$L/lint.log" 2>&1; echo "citadel-lint=$?"; grep "✖" "$L/lint.log"
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test 2>&1 | tail -4; bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts 2>&1 | tail -4
```

Expected: `db-build=0`; `api-typecheck=0`, `Test Files  116 passed (116)`, `Tests  1153 passed | 10 skipped (1163)`; `citadel-tsc=0`, `Test Files  39 passed (39)`, `Tests  256 passed (256)`, `citadel-lint=0`, `✖ 30 problems (0 errors, 30 warnings)`; DB `101 pass`, `0 fail`, `Ran 101 tests across 19 files.`; the pair `6 pass`, `0 fail`. Any difference: stop and report before Task 1.

---
### Task 1: DB – migration `0044_bounded_tool_overrides`

**Files:**
- Create: `packages/db/src/__tests__/bounded-tool-overrides-migration.test.ts`
- Modify: `packages/db/src/__tests__/migration-baseline.test.ts:78` (after), `packages/db/src/schema/runtime-app-setup-tool-overrides.ts:34` (after), `packages/db/src/schema/runtime-config-revisions.ts:31` (after), `packages/db/MIGRATIONS.md:34-35,55-58,118-119`
- Generate (`drizzle-kit generate`, never hand-edited): `packages/db/drizzle/0044_bounded_tool_overrides.sql`, `packages/db/drizzle/meta/0044_snapshot.json`, `packages/db/drizzle/meta/_journal.json` (entry `idx` 44)
- Test: the new test, `migration-baseline.test.ts`, the whole DB suite, `drizzle-kit check`

**Interfaces:**
- Consumes: P08a's snapshot guard (`schema-snapshot.test.ts`: the newest `meta/*_snapshot.json` must be the newest journal entry and equal `src/schema`), the journal rules (`migration-journal.test.ts`: `when` strictly increasing, `idx` = file prefix), `migrations-from-scratch.test.ts` (applied rows = `journal.entries.length`, schema parity, constraint names).
- Produces: `runtimeAppSetupToolOverrides.allowedRoles: text[] | null`, `.baselineRiskClass: text | null`, `.baselineRequiresApproval: boolean | null`; `runtimeConfigRevisions.toolOverrides: jsonb not null default '[]'`.

The P08a ruling on counting stays: "applied" means one row in `drizzle.__drizzle_migrations` per journal entry, so `migrations-from-scratch.test.ts` needs no new number; its schema-parity and constraint checks pick the new columns up from `src/schema`. What changes is the baseline proof (a hand-migrated database must now also receive `0044` from `drizzle-kit migrate`) and the runbook sentence that said "nothing to apply".

- [ ] **Step 1: Write the failing tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/bounded-tool-overrides-migration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TAG = '0044_bounded_tool_overrides';
const workDir = mkdtempSync(join(tmpdir(), 'glirastes-bounded-overrides-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A database migrated by drizzle-kit up to (but excluding) `untilTag`. */
async function databaseBefore(untilTag: string): Promise<PGlite> {
  const folder = join(workDir, `before-${crypto.randomUUID()}`);
  cpSync(migrationsFolder, folder, { recursive: true });
  const journal = JSON.parse(
    readFileSync(`${folder}/meta/_journal.json`, 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter(({ tag }) => tag < untilTag);
  writeFileSync(`${folder}/meta/_journal.json`, JSON.stringify(journal));
  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder: folder });
  return client;
}

describe('bounded tool overrides migration', () => {
  it('is a generated, additive migration', () => {
    const path = `${migrationsFolder}/${TAG}.sql`;
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, 'utf8');

    expect(sql).toContain('ADD COLUMN "baseline_risk_class" text');
    expect(sql).toContain('ADD COLUMN "baseline_requires_approval" boolean');
    expect(sql).toContain('ADD COLUMN "allowed_roles" text[]');
    expect(sql).toContain(`ADD COLUMN "tool_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL`);
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  });

  it('keeps every existing decision and binds no tool override to old configurations', async () => {
    const client = await databaseBefore(TAG);
    await client.exec(`
      INSERT INTO tenants (id, name, slug) VALUES
        ('019fb001-0000-7000-8000-000000000001', 'Acme', 'acme');
      INSERT INTO target_apps (id, tenant_id, name) VALUES
        ('019fb001-0000-7000-8000-000000000002', '019fb001-0000-7000-8000-000000000001', 'App');
      INSERT INTO runtime_app_setup_runs
        (id, tenant_id, target_app_id, assessment_mode, discovery_digest, started_by)
      VALUES
        ('019fb001-0000-7000-8000-000000000004', '019fb001-0000-7000-8000-000000000001',
         '019fb001-0000-7000-8000-000000000002', 'autonomous', 'sha256:d', 'editor-1');
      INSERT INTO runtime_app_setup_tool_overrides
        (tenant_id, target_app_id, run_id, tool_id, risk_class, enabled, updated_by)
      VALUES
        ('019fb001-0000-7000-8000-000000000001', '019fb001-0000-7000-8000-000000000002',
         '019fb001-0000-7000-8000-000000000004', '019fb001-0000-7000-8000-000000000006',
         'delete', false, 'editor-1');
    `);

    await migrate(drizzle(client), { migrationsFolder });

    const { rows } = await client.query<Record<string, unknown>>(
      `select risk_class, enabled, baseline_risk_class, baseline_requires_approval, allowed_roles
         from runtime_app_setup_tool_overrides`,
    );
    expect(rows).toEqual([{
      risk_class: 'delete',
      enabled: false,
      baseline_risk_class: null,
      baseline_requires_approval: null,
      allowed_roles: null,
    }]);
    const { rows: columns } = await client.query<Record<string, unknown>>(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'runtime_config_revisions' and column_name = 'tool_overrides'`,
    );
    expect(columns).toEqual([{ is_nullable: 'NO', column_default: `'[]'::jsonb` }]);
    await client.close();
  }, 60_000);
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/src/__tests__/migration-baseline.test.ts b/packages/db/src/__tests__/migration-baseline.test.ts
--- a/packages/db/src/__tests__/migration-baseline.test.ts
+++ b/packages/db/src/__tests__/migration-baseline.test.ts
@@ -76,6 +76,13 @@ describe('baseline for a database migrated by hand', () => {
       'select count(*)::int as applied from drizzle.__drizzle_migrations',
     );
     expect(rows[0].applied).toBe(journal.entries.length);
+    // Generated migrations after the baseline are applied by drizzle-kit.
+    const { rows: columns } = await client.query<{ column_name: string }>(
+      `select column_name from information_schema.columns
+        where table_name = 'runtime_app_setup_tool_overrides'
+          and column_name = 'baseline_risk_class'`,
+    );
+    expect(columns).toEqual([{ column_name: 'baseline_risk_class' }]);
     await client.close();
   }, 60_000);
 
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/bounded-tool-overrides-migration.test.ts src/__tests__/migration-baseline.test.ts 2>&1 | grep -E "^\(fail\)|^error:| pass$| fail$|^Ran"
```

Expected: `2 pass`, `3 fail`, `Ran 5 tests across 2 files.`: "is a generated, additive migration" (`Expected: true`, `Received: false`: the file does not exist), "keeps every existing decision and binds no tool override to old configurations" (`column "baseline_risk_class" does not exist`) and "resumes drizzle-kit migrate after the printed baseline without reapplying anything" (the column query returns `[]`).

- [ ] **Step 3: Change the schema**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/src/schema/runtime-app-setup-tool-overrides.ts b/packages/db/src/schema/runtime-app-setup-tool-overrides.ts
--- a/packages/db/src/schema/runtime-app-setup-tool-overrides.ts
+++ b/packages/db/src/schema/runtime-app-setup-tool-overrides.ts
@@ -32,6 +32,12 @@ export const runtimeAppSetupToolOverrides = pgTable(
     riskClass: text('risk_class'),
     requiresApproval: boolean('requires_approval'),
     enabled: boolean('enabled'),
+    // Narrows who may call the tool; null keeps the local restriction alone.
+    allowedRoles: text('allowed_roles').array(),
+    // What the deployed code reported when the decision was saved. A
+    // relaxation is pinned to this risk class and lapses when the code raises it.
+    baselineRiskClass: text('baseline_risk_class'),
+    baselineRequiresApproval: boolean('baseline_requires_approval'),
     updatedBy: text('updated_by').notNull(),
     createdAt: timestamp('created_at', { withTimezone: true })
       .defaultNow()
diff --git a/packages/db/src/schema/runtime-config-revisions.ts b/packages/db/src/schema/runtime-config-revisions.ts
--- a/packages/db/src/schema/runtime-config-revisions.ts
+++ b/packages/db/src/schema/runtime-config-revisions.ts
@@ -29,6 +29,9 @@ export const runtimeConfigRevisions = pgTable('runtime_config_revisions', {
   promptRevisionId: uuid('prompt_revision_id').notNull(),
   plannerRevisionId: uuid('planner_revision_id').notNull(),
   tools: jsonb('tools').notNull(),
+  // Signed Platform policy deltas ({ toolId, ...entry }, sorted by toolId).
+  // Never copies of what the code reported; empty for older configurations.
+  toolOverrides: jsonb('tool_overrides').notNull().default([]),
   runtimeDigest: text('runtime_digest').notNull(),
   promptDigest: text('prompt_digest').notNull(),
   setupArtifactDigest: text('setup_artifact_digest').notNull(),
PATCH
```

- [ ] **Step 4: Generate the migration with drizzle-kit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit generate --name bounded_tool_overrides 2>&1 | tail -1
cat drizzle/0044_bounded_tool_overrides.sql; echo
node -e 'const s=require("./drizzle/meta/0044_snapshot.json");const p=require("./drizzle/meta/0043_snapshot.json");console.log(s.prevId===p.id, s.version, Object.keys(s.tables).length)'
node -e 'const e=require("./drizzle/meta/_journal.json").entries.at(-1);console.log(e.idx, e.tag, e.when>1786722103000, e.breakpoints)'
git status --short
```

Expected: `[✓] Your SQL migration file ➜ drizzle/0044_bounded_tool_overrides.sql 🚀`; the SQL is exactly

```sql
ALTER TABLE "runtime_app_setup_tool_overrides" ADD COLUMN "allowed_roles" text[];--> statement-breakpoint
ALTER TABLE "runtime_app_setup_tool_overrides" ADD COLUMN "baseline_risk_class" text;--> statement-breakpoint
ALTER TABLE "runtime_app_setup_tool_overrides" ADD COLUMN "baseline_requires_approval" boolean;--> statement-breakpoint
ALTER TABLE "runtime_config_revisions" ADD COLUMN "tool_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;
```

then `true 7 56` and `44 0044_bounded_tool_overrides true true`; status lists the two schema files, `drizzle/meta/_journal.json` (modified), `drizzle/0044_bounded_tool_overrides.sql`, `drizzle/meta/0044_snapshot.json` and the new test (untracked) plus the modified baseline test. The snapshot `id` and the journal `when` are generated (random id, generation time) and differ per run; the tests do not depend on them. If the SQL differs, stop and report.

- [ ] **Step 5: Update the runbook**

````bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/MIGRATIONS.md b/packages/db/MIGRATIONS.md
--- a/packages/db/MIGRATIONS.md
+++ b/packages/db/MIGRATIONS.md
@@ -31,8 +31,8 @@ in-process PostgreSQL (PGlite, no network):
    ```
 
    This writes `drizzle/<idx>_<what_it_does>.sql`, `drizzle/meta/<idx>_snapshot.json`
-   and the journal entry together. The next index after this baseline is
-   `0044`.
+   and the journal entry together. `0044_bounded_tool_overrides` was the
+   first migration generated this way; the next index is `0045`.
 3. If the SQL has to be written by hand (data backfills, checks, triggers),
    keep the generated journal entry and snapshot and edit only the SQL. Put
    `--> statement-breakpoint` between statements: the migrator sends each
@@ -52,10 +52,11 @@ already broken at `0022` (it points to a snapshot from a merged branch). None
 of that is used any more. `0030`-`0043` were written by hand without
 snapshots, so until 2026-10-04 `generate` would have re-emitted all of them.
 
-`meta/0043_snapshot.json` is the current baseline. It was produced by
+`meta/0043_snapshot.json` is the baseline. It was produced by
 `drizzle-kit generate` in a temporary copy of this package after `0043` (its
-`prevId` is the `0029` snapshot) and describes `src/schema` exactly. The
-`schema-snapshot` test keeps it honest. The `drizzle-kit check` collision
+`prevId` is the `0029` snapshot). Every later snapshot comes from a real
+`generate` (`0044_snapshot.json` has `prevId` = the `0043` snapshot), and the
+`schema-snapshot` test keeps the newest one equal to `src/schema`. The `drizzle-kit check` collision
 report stays clean because no two snapshots share a `prevId`.
 
 Objects that exist only in hand-written SQL are invisible to drizzle-kit and
@@ -115,5 +116,8 @@ never run by an agent.
    ```
 
 3. Run the reviewed file against the database, then `bun run db:migrate`.
-   It applies only migrations newer than `0043`, so while `0043` is the
-   newest journal entry it must report nothing to apply.
+   It applies only migrations newer than `0043` (from 2026-10-05:
+   `0044_bounded_tool_overrides`) and nothing before them. Afterwards
+   `drizzle.__drizzle_migrations` holds exactly one row per journal entry
+   (`select count(*) from drizzle.__drizzle_migrations` equals the number of
+   `entries` in `meta/_journal.json`).
PATCH
````

- [ ] **Step 6: Run and see GREEN; rebuild the package the API type-checks against**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/bounded-tool-overrides-migration.test.ts src/__tests__/migration-baseline.test.ts 2>&1 | tail -4
bun test 2>&1 | tail -3
DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1
./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `5 pass`, `0 fail`, `Ran 5 tests across 2 files.`; `0 fail`, `Ran 103 tests across 20 files.`; `Everything's fine 🐶🔥`; `db-build=0`; `api-typecheck=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/drizzle/0044_bounded_tool_overrides.sql packages/db/drizzle/meta/0044_snapshot.json packages/db/drizzle/meta/_journal.json packages/db/src/schema/runtime-app-setup-tool-overrides.ts packages/db/src/schema/runtime-config-revisions.ts packages/db/src/__tests__/bounded-tool-overrides-migration.test.ts packages/db/src/__tests__/migration-baseline.test.ts packages/db/MIGRATIONS.md
git commit -m "feat(db): add bounded tool override columns"
```

---

### Task 2: API – port the SDK tool policy bounds with golden-vector parity

**Files:**
- Create: `apps/api/src/modules/runtime-setup-v2/__vectors__/tool-policy.v1.json` (copied from the SDK object store), `apps/api/src/modules/runtime-setup-v2/__vectors__/README.md`, `apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts`, `apps/api/src/modules/runtime-setup-v2/tool-policy.ts`
- Test: `apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts`

**Interfaces:**
- Consumes: SDK `src/contracts/tool-policy.ts` at `codex/mvp-tools` (`resolveToolPolicy` unchanged since `1453f16`; `6570a87` only touched the policy file schema, which is not ported) and the 44 vectors of `src/contracts/__vectors__/tool-policy.v1.json` at `29fce41` (sha256 `3e11feb3d4f49934014c3ac0e426b80a40932403cfa11329796055b9156f44ff`).
- Produces: `TOOL_POLICY_RULES_VERSION = 1`, `TOOL_RISK_CLASSES`, `ToolRiskClassSchema`, `type ToolRiskClass`, `riskTier(riskClass): 0|1|2|3`, `confirmationFloor(riskClass, requiresApproval): boolean`, `mostRestrictiveRiskClass(current, candidate?)`, `intersectAllowedRoles(current, restriction?)`, `ToolPolicyPinSchema`, `ToolPolicyEntrySchema` (zod 4, strict), `type ToolPolicyEntry`, `type PolicyOrigin`, `type ResolveToolPolicyInput`, `type ResolveToolPolicyResult`, `resolveToolPolicy(input)`. Names and semantics are the SDK's, so a re-sync is a line-by-line diff.

- [ ] **Step 1: Copy the vectors and write the failing parity test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
mkdir -p apps/api/src/modules/runtime-setup-v2/__vectors__
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools show 29fce41:src/contracts/__vectors__/tool-policy.v1.json > apps/api/src/modules/runtime-setup-v2/__vectors__/tool-policy.v1.json
shasum -a 256 apps/api/src/modules/runtime-setup-v2/__vectors__/tool-policy.v1.json
```

Expected: `3e11feb3d4f49934014c3ac0e426b80a40932403cfa11329796055b9156f44ff`. A different digest means the object store returned other content: stop and report.

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__vectors__/README.md`:

````markdown
# Tool policy golden vectors

`tool-policy.v1.json` is a byte-for-byte copy of the SDK file
`src/contracts/__vectors__/tool-policy.v1.json` (glirastes, `codex/mvp-tools`,
commit `29fce41`). The SDK owns it. `../tool-policy.ts` is the Platform port of
the SDK's `resolveToolPolicy`, and `../__tests__/tool-policy-vectors.spec.ts`
proves the port reproduces every vector exactly and that this file is still
the copy it was synced from (`SDK_VECTORS_SHA256`).

Never edit the JSON here. When the SDK changes its vectors or its policy
rules:

1. Copy the SDK file over this one:

   ```bash
   cp <sdk>/src/contracts/__vectors__/tool-policy.v1.json \
      apps/api/src/modules/runtime-setup-v2/__vectors__/tool-policy.v1.json
   ```

2. Port the rule change from `<sdk>/src/contracts/tool-policy.ts` into
   `../tool-policy.ts` (same function names, same order of checks).
3. Put the new `shasum -a 256` of the file into `SDK_VECTORS_SHA256` and the
   SDK commit into this README.
4. Run `./node_modules/.bin/vitest run src/modules/runtime-setup-v2` in
   `apps/api`. A bumped `TOOL_POLICY_RULES_VERSION` means a new
   `tool-policy.v2.json`, never an edited v1 file.
````

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ResolveToolPolicyResult,
} from '../tool-policy';

interface ToolPolicyVector {
  name: string;
  input: ResolveToolPolicyInput;
  expected: ResolveToolPolicyResult;
}

/**
 * sha256 of glirastes `src/contracts/__vectors__/tool-policy.v1.json` at
 * 29fce41. A change in the SDK fails here until the file is re-synced on
 * purpose; see __vectors__/README.md.
 */
const SDK_VECTORS_SHA256 =
  '3e11feb3d4f49934014c3ac0e426b80a40932403cfa11329796055b9156f44ff';

const raw = readFileSync(
  fileURLToPath(new URL('../__vectors__/tool-policy.v1.json', import.meta.url)),
);
const vectors = JSON.parse(raw.toString('utf8')) as ToolPolicyVector[];

describe('tool policy port parity with the SDK golden vectors v1', () => {
  it('uses the SDK vectors byte for byte', () => {
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe(SDK_VECTORS_SHA256);
    expect(vectors.length).toBeGreaterThanOrEqual(25);
    expect(new Set(vectors.map((vector) => vector.name)).size)
      .toBe(vectors.length);
    for (const vector of vectors) {
      expect(vector.input.defaults.rulesVersion).toBe(TOOL_POLICY_RULES_VERSION);
    }
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      // Serialized, so field order and absent keys must match too.
      expect(JSON.stringify(resolveToolPolicy(vector.input)))
        .toBe(JSON.stringify(vector.expected));
    },
  );
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts 2>&1 | grep -E "Test Files|Tests |Cannot find module"
```

Expected: `Error: Cannot find module '../tool-policy' imported from …/tool-policy-vectors.spec.ts`, `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Port the policy**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/tool-policy.ts`:

```ts
/**
 * Platform port of the SDK's tool policy bounds
 * (glirastes `src/contracts/tool-policy.ts`, RULES_VERSION 1).
 *
 * The SDK is the source of truth. This file mirrors `riskTier`,
 * `confirmationFloor`, `mostRestrictiveRiskClass`, `intersectAllowedRoles`,
 * `ToolPolicyEntrySchema` and `resolveToolPolicy` line by line, and the shared
 * golden vectors in `__vectors__/tool-policy.v1.json` (copied byte for byte
 * from the SDK) prove the two produce identical results. Code defaults
 * (`deriveToolPolicyDefaults`) stay SDK-only: the Platform never derives a
 * default, it reads what the deployed code reported. See
 * `__vectors__/README.md` for re-syncing after an SDK change.
 *
 * `zod/v4` is used on purpose: the SDK validates with zod 4, and the field
 * paths of `E-POLICY-001` errors are part of the vectors.
 */
import { z } from 'zod/v4';

export const TOOL_POLICY_RULES_VERSION = 1 as const;

export const TOOL_RISK_CLASSES = [
  'safe-read',
  'read-sensitive',
  'write',
  'delete',
  'financial',
  'external',
  'unknown',
] as const;

export const ToolRiskClassSchema = z.enum(TOOL_RISK_CLASSES);

export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;

export type RiskTier = 0 | 1 | 2 | 3;

const RISK_TIERS: Readonly<Record<ToolRiskClass, RiskTier>> = {
  'safe-read': 0,
  'read-sensitive': 1,
  write: 2,
  delete: 3,
  financial: 3,
  external: 3,
  // An unassessed risk class is treated like the highest tier.
  unknown: 3,
};

/**
 * A value outside the enum (untyped input, an `as` cast) is unassessed. Own
 * keys only: a prototype key such as 'constructor' must not read as a tier.
 */
function knownRiskClass(riskClass: ToolRiskClass): ToolRiskClass {
  return Object.hasOwn(RISK_TIERS, riskClass) ? riskClass : 'unknown';
}

/** Fails closed: an out-of-enum class is tier 3, like `unknown`. */
export function riskTier(riskClass: ToolRiskClass): RiskTier {
  return RISK_TIERS[knownRiskClass(riskClass)];
}

/**
 * The runtime confirmation floor: tier 3 always asks before it runs,
 * whatever any policy layer says.
 */
export function confirmationFloor(
  riskClass: ToolRiskClass,
  requiresApproval: boolean,
): boolean {
  return requiresApproval || riskTier(riskClass) >= 3;
}

/**
 * Raise-only combination. A candidate replaces the current class only from a
 * strictly higher tier; a same-tier relabel or a lower class never applies.
 * An out-of-enum candidate raises as `unknown`, so none enters the result.
 */
export function mostRestrictiveRiskClass(
  current: ToolRiskClass,
  candidate: ToolRiskClass | undefined,
): ToolRiskClass {
  if (candidate === undefined) return current;
  return riskTier(candidate) > riskTier(current)
    ? knownRiskClass(candidate)
    : current;
}

export interface AllowedRolesIntersection {
  /** Sorted, de-duplicated roles; empty means "no additional restriction". */
  roles: string[];
  /** Both sides restrict and nothing is left: nobody may call the tool. */
  disjoint: boolean;
}

export function intersectAllowedRoles(
  current: ReadonlyArray<string>,
  restriction: ReadonlyArray<string> | undefined,
): AllowedRolesIntersection {
  const left = normalizedRoles(current);
  const right = normalizedRoles(restriction ?? []);
  if (left.length === 0) return { roles: right, disjoint: false };
  if (right.length === 0) return { roles: left, disjoint: false };
  const roles = left.filter((role) => right.includes(role));
  return { roles, disjoint: roles.length === 0 };
}

function normalizedRoles(roles: ReadonlyArray<string>): string[] {
  return [...new Set(roles)].sort();
}

export interface ToolPolicyDefaults {
  operationGroup: 'read' | 'create' | 'update' | 'delete' | 'ui';
  riskClass: Exclude<ToolRiskClass, 'unknown'>;
  requiresApproval: boolean;
  rulesVersion: typeof TOOL_POLICY_RULES_VERSION;
}

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

export type PolicyOrigin = 'code-default' | 'local-policy' | 'platform';

export interface EffectiveToolPolicy {
  enabled: boolean;
  requiresApproval: boolean;
  riskClass: ToolRiskClass;
  allowedRoles: string[];
  description?: string;
  origin: {
    enabled: PolicyOrigin;
    requiresApproval: PolicyOrigin;
    riskClass: PolicyOrigin;
    allowedRoles: PolicyOrigin;
    description: PolicyOrigin;
  };
}

export type ToolPolicyWarningCode =
  | 'override-lapsed-risk-raised'
  | 'risk-lower-available'
  | 'policy-entry-orphaned';

export interface ResolveToolPolicyInput {
  toolId: string;
  defaults: ToolPolicyDefaults;
  /** False for needs_attention, excluded or missing tools; nothing re-enables them. */
  codeEnabled: boolean;
  local?: ToolPolicyEntry;
  platform?: ToolPolicyEntry;
  /**
   * Releases a held `risk-lower-available` decrease. `riskClass` is matched
   * exactly against the layered class (code defaults plus local/Platform
   * raises), not the class the code alone derives.
   */
  acceptedRisk?: { riskClass: ToolRiskClass; toolId: string };
  /** The riskClass this toolId resolved to in the previous committed refresh. */
  previousEffectiveRiskClass?: ToolRiskClass;
}

export interface ResolveToolPolicyResult {
  effective: EffectiveToolPolicy;
  warnings: Array<{
    code: ToolPolicyWarningCode;
    field?: string;
    /** `risk-lower-available` only: the class `acceptedRisk` must record. */
    riskClass?: ToolRiskClass;
  }>;
  errors: Array<{
    code: 'E-POLICY-001' | 'E-POLICY-002';
    field: string;
    reason: string;
  }>;
}

type PolicyWarning = ResolveToolPolicyResult['warnings'][number];
type PolicyError = ResolveToolPolicyResult['errors'][number];

interface PolicyLayer {
  name: 'local' | 'platform';
  origin: Exclude<PolicyOrigin, 'code-default'>;
  entry: ToolPolicyEntry;
}

interface CollectedLayers {
  layers: PolicyLayer[];
  invalidOrigin?: PolicyOrigin;
}

interface ResolvedField<T> {
  value: T;
  origin: PolicyOrigin;
}

/**
 * Pure policy resolution shared with the SDK via golden vectors. Code
 * defaults are the base; local and Platform entries restrict, except a
 * reviewed, pinned relaxation of confirmation up to tier 2. Across all layers
 * the most restrictive protection value wins.
 */
export function resolveToolPolicy(
  input: ResolveToolPolicyInput,
): ResolveToolPolicyResult {
  const warnings: PolicyWarning[] = [];
  const errors: PolicyError[] = [];
  const { layers, invalidOrigin } = collectPolicyLayers(input, warnings, errors);
  const risk = resolveRiskClass(input, layers, warnings);
  const roles = resolveAllowedRoles(layers);
  const enabled = resolveEnabled(
    input.codeEnabled,
    layers,
    roles.disjointOrigin,
    invalidOrigin,
  );
  const approval = resolveApproval(input, layers, risk, warnings, errors);
  const description = resolveDescription(layers);
  return {
    effective: {
      enabled: enabled.value,
      requiresApproval: approval.value,
      riskClass: risk.value,
      allowedRoles: roles.value,
      ...(description.value === undefined
        ? {}
        : { description: description.value }),
      origin: {
        enabled: enabled.origin,
        requiresApproval: approval.origin,
        riskClass: risk.origin,
        allowedRoles: roles.origin,
        description: description.origin,
      },
    },
    warnings,
    errors,
  };
}

function collectPolicyLayers(
  input: ResolveToolPolicyInput,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): CollectedLayers {
  const layers: PolicyLayer[] = [];
  let invalidOrigin: PolicyOrigin | undefined;
  const candidates = [
    { name: 'local', origin: 'local-policy', entry: input.local },
    { name: 'platform', origin: 'platform', entry: input.platform },
  ] as const;
  for (const candidate of candidates) {
    if (candidate.entry === undefined) continue;
    const parsed = ToolPolicyEntrySchema.safeParse(candidate.entry);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
      errors.push({
        code: 'E-POLICY-001',
        field: path ? `${candidate.name}.${path}` : candidate.name,
        reason: 'invalid-entry',
      });
      // A layer we cannot read must not silently drop its restrictions.
      invalidOrigin ??= candidate.origin;
      continue;
    }
    const layer: PolicyLayer = {
      name: candidate.name,
      origin: candidate.origin,
      entry: parsed.data,
    };
    // A pin from an earlier incarnation: relaxations lapse, hardenings stay.
    if (layer.entry.pin && layer.entry.pin.toolId !== input.toolId) {
      warnings.push({
        code: 'policy-entry-orphaned',
        field: `${layer.name}.pin.toolId`,
      });
    }
    layers.push(layer);
  }
  return { layers, ...(invalidOrigin ? { invalidOrigin } : {}) };
}

function resolveRiskClass(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  warnings: PolicyWarning[],
): ResolvedField<ToolRiskClass> {
  let value: ToolRiskClass = input.defaults.riskClass;
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const raised = mostRestrictiveRiskClass(value, layer.entry.riskClass);
    if (raised !== value) {
      value = raised;
      origin = layer.origin;
    }
  }
  // Ratchet: a code-caused decrease is held until `tools policy accept`.
  // `acceptedRisk.riskClass` is matched against the layered `value` (defaults
  // plus local/Platform raises), not the class the code alone derives, so the
  // warning names `value` as the class accept must record.
  const previous = input.previousEffectiveRiskClass;
  if (previous !== undefined && riskTier(previous) > riskTier(value)) {
    const acceptedRisk = input.acceptedRisk;
    const accepted = acceptedRisk !== undefined
      && acceptedRisk.toolId === input.toolId
      && acceptedRisk.riskClass === value;
    if (!accepted) {
      warnings.push({
        code: 'risk-lower-available',
        field: 'riskClass',
        riskClass: value,
      });
      // An out-of-enum previous class is held as tier-3 `unknown`.
      return { value: knownRiskClass(previous), origin: 'code-default' };
    }
  }
  return { value, origin };
}

function sameRoles(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return left.length === right.length
    && left.every((role, index) => role === right[index]);
}

function resolveAllowedRoles(
  layers: ReadonlyArray<PolicyLayer>,
): ResolvedField<string[]> & { disjointOrigin?: PolicyOrigin } {
  let value: string[] = [];
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const restriction = layer.entry.allowedRoles;
    if (!restriction || restriction.length === 0) continue;
    const next = intersectAllowedRoles(value, restriction);
    if (next.disjoint) {
      // [] would read as "everyone"; a disjoint restriction means nobody.
      return { value: [], origin: layer.origin, disjointOrigin: layer.origin };
    }
    if (!sameRoles(next.roles, value)) {
      value = next.roles;
      origin = layer.origin;
    }
  }
  return { value, origin };
}

function resolveEnabled(
  codeEnabled: boolean,
  layers: ReadonlyArray<PolicyLayer>,
  disjointOrigin: PolicyOrigin | undefined,
  invalidOrigin: PolicyOrigin | undefined,
): ResolvedField<boolean> {
  if (!codeEnabled) return { value: false, origin: 'code-default' };
  if (invalidOrigin) return { value: false, origin: invalidOrigin };
  const disabledBy = layers.find((layer) => layer.entry.enabled === false);
  if (disabledBy) return { value: false, origin: disabledBy.origin };
  if (disjointOrigin) return { value: false, origin: disjointOrigin };
  return { value: true, origin: 'code-default' };
}

function resolveApproval(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  risk: ResolvedField<ToolRiskClass>,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): ResolvedField<boolean> {
  const tier = riskTier(risk.value);
  const raisedIntoConfirmation = tier >= 2
    && tier > riskTier(input.defaults.riskClass);
  const baseline = input.defaults.requiresApproval || raisedIntoConfirmation;
  const baselineOrigin: PolicyOrigin =
    !input.defaults.requiresApproval && raisedIntoConfirmation
      ? risk.origin
      : 'code-default';
  let hardenedBy: PolicyLayer | undefined;
  let relaxedBy: PolicyLayer | undefined;
  for (const layer of layers) {
    if (layer.entry.requiresApproval === true) {
      hardenedBy ??= layer;
    } else if (
      layer.entry.requiresApproval === false
      && relaxationAllowed(input.toolId, layer, tier, warnings, errors)
    ) {
      relaxedBy = layer;
    }
  }
  let result: ResolvedField<boolean>;
  if (hardenedBy) {
    result = {
      value: true,
      origin: baseline && !relaxedBy ? baselineOrigin : hardenedBy.origin,
    };
  } else if (relaxedBy) {
    result = { value: false, origin: relaxedBy.origin };
  } else {
    result = { value: baseline, origin: baselineOrigin };
  }
  // Tier 3 always confirms, whatever any layer says.
  return !result.value && tier >= 3
    ? { value: true, origin: 'code-default' }
    : result;
}

function relaxationAllowed(
  toolId: string,
  layer: PolicyLayer,
  tier: RiskTier,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): boolean {
  const pin = layer.entry.pin;
  const field = `${layer.name}.requiresApproval`;
  if (pin && pin.toolId !== toolId) return false;
  if (tier <= 1) return true;
  if (!pin) {
    errors.push({
      code: 'E-POLICY-002',
      field,
      reason: tier >= 3
        ? 'tier-3-always-requires-approval'
        : 'relaxation-requires-reviewed-pin',
    });
    return false;
  }
  const pinnedTier = riskTier(pin.atRiskClass);
  if (pinnedTier >= 3) {
    errors.push({
      code: 'E-POLICY-002',
      field,
      reason: 'tier-3-always-requires-approval',
    });
    return false;
  }
  if (tier > pinnedTier) {
    warnings.push({ code: 'override-lapsed-risk-raised', field });
    return false;
  }
  return true;
}

function resolveDescription(
  layers: ReadonlyArray<PolicyLayer>,
): ResolvedField<string | undefined> {
  let result: ResolvedField<string | undefined> = {
    value: undefined,
    origin: 'code-default',
  };
  for (const layer of layers) {
    if (layer.entry.description !== undefined) {
      result = { value: layer.entry.description, origin: layer.origin };
    }
  }
  return result;
}
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts 2>&1 | grep -E "Test Files|Tests "
diff <(sed -n '/^export function resolveToolPolicy/,$p' /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools/src/contracts/tool-policy.ts) <(sed -n '/^export function resolveToolPolicy/,$p' src/modules/runtime-setup-v2/tool-policy.ts) | grep -c '^[<>]'
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  1 passed (1)`, `Tests  45 passed (45)` (one digest check and 44 vectors); `0` (from `resolveToolPolicy` to the end of the file the port is line-identical to the SDK, comments included); `typecheck=0`; `Test Files  117 passed (117)`, `Tests  1198 passed | 10 skipped (1208)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/tool-policy.ts apps/api/src/modules/runtime-setup-v2/__vectors__/tool-policy.v1.json apps/api/src/modules/runtime-setup-v2/__vectors__/README.md apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts
git commit -m "feat(runtime-setup): port the sdk tool policy bounds with vector parity"
```

---
### Task 3: API – bound tool overrides by the reported code (422 out of bounds)

**Files:**
- Replace: `apps/api/src/modules/runtime-setup-v2/tool-override.ts`, `apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts`
- Modify: `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts:4,132,845,863-879,898`; `runtime-setup-v2.service.ts:6,12,347-387,440-472,708-726,790`; `runtime-setup-v2.store.ts:1,75,129-139`; `drizzle-runtime-setup-v2.store.ts:39,639-707`; `connected-apply-claim.ts:4,64`; `apps/api/src/modules/runtime-revisions/app-configuration.service.ts:7,51`
- Test: both specs above, then the three runtime modules

**Interfaces:**
- Consumes: Task 2's `resolveToolPolicy`, `riskTier`, `mostRestrictiveRiskClass`, `TOOL_RISK_CLASSES`, `type ToolPolicyEntry`; Task 1's columns.
- Produces (`tool-override.ts`): `toolOverrideSchema` (zod 3; `description?`, `riskClass?` without `unknown`, `requiresApproval?`, `enabled?`, `allowedRoles?`, each also `null`), `type ToolOverrideInput`, `parseToolOverride`, `interface ToolOverrideFields { description?, riskClass?, requiresApproval?, enabled?, allowedRoles?, baselineRiskClass?, baselineRequiresApproval? }`, `type StoredToolOverride = { toolId } & ToolOverrideFields`, `interface ReportedToolPolicy { toolId, riskClass, requiresApproval, enabled, allowedRoles }`, `reportedToolPolicy(tool: Record<string, unknown>): ReportedToolPolicy`, `type ToolOverrideViolationReason`, `type ToolOverrideDelta = { toolId } & ToolPolicyEntry`, `mergeToolOverride(stored, input): ToolOverrideFields`, `boundToolOverride(reported, decision): { entry, violations, effective, changedByPlatform, relaxationPending, warnings }`, `isEmptyToolPolicyEntry(entry)`, `boundToolOverrideDeltas(overrides, reported: ReadonlyMap<toolId, ReportedToolPolicy>): ToolOverrideDelta[]` (the one rule that turns stored decisions into signed deltas: bounded by the reported tool, or by the saved baseline for a tool only a capability report knows; sorted, empty entries left out; used by publication here and by policy-only revisions in Task 8), `type PolicyChangeDirection = 'none'|'hardening'|'loosening'`, `classifyToolPolicyChange(previous?, current?)`. `applyToolOverride` and `type ToolOverride` are removed (their only callers are rewritten here).
- Produces (store): `upsertToolOverride({ …scope, runId, toolId, override: ToolOverrideFields, updatedBy })` replaces the whole stored decision (absent fields become null); new `findToolOverride(scope, toolId): Promise<StoredToolOverride | null>`; `listToolOverrides` and `readConnectedApplyInputs().overrides` return `StoredToolOverride[]` (the connected-apply input digest therefore also covers roles and baselines).
- Produces (service): `saveToolOverride(scope, runId, toolId, input: ToolOverrideInput, actor)` throws `UnprocessableEntityException({ code: 'tool_override_out_of_bounds', field, reason })` and stores nothing when a field the request decides (present and not `null`) is out of bounds; a stored field the code has since outgrown (for example a raise below a class the code now reports) does not block a save of other fields, stays stored and is clamped at publication; audits `decidedFields` and `direction`. `reviewedArtifact()` returns the reported tools unchanged plus `toolOverrides: ToolOverrideDelta[]` from `boundToolOverrideDeltas` (sorted, in bounds, non-empty only; a decision for a tool the run does not contain but a capability report does is signed too, bounded by its baseline, so a publication and a policy-only revision sign the same deltas for the same decisions). `getLatestSetup()` shows effective values. `ReviewedAppSetupArtifact.toolOverrides?: ToolOverrideDelta[]`.

Gap before this task: `applyToolOverride` (`tool-override.ts:42-57`) copies any decided value over the proposal, so a stored `{ riskClass: 'safe-read', enabled: true }` turns a sensitive, code-disabled tool into an enabled safe read before signing. The existing service test "applies an operator override before publication" pins exactly that; it is replaced by two tests that pin the opposite.

- [ ] **Step 1: Write the failing tests**

Replace the whole content of `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  boundToolOverride,
  classifyToolPolicyChange,
  mergeToolOverride,
  parseToolOverride,
  type PolicyChangeDirection,
  type ReportedToolPolicy,
} from '../tool-override';
import { type ToolPolicyEntry } from '../tool-policy';

const TOOL_ID = '019fb001-0000-7000-8000-000000000006';

const reported = (
  overrides: Partial<ReportedToolPolicy> = {},
): ReportedToolPolicy => ({
  toolId: TOOL_ID,
  riskClass: 'write',
  requiresApproval: true,
  enabled: true,
  allowedRoles: [],
  ...overrides,
});

describe('parsing a tool override', () => {
  it('accepts the overridable fields and null as "remove my decision"', () => {
    const parsed = parseToolOverride({
      description: 'Removes a task permanently.',
      riskClass: 'delete',
      requiresApproval: null,
      enabled: false,
      allowedRoles: ['admin'],
    });

    expect(parsed).toEqual({
      description: 'Removes a task permanently.',
      riskClass: 'delete',
      requiresApproval: null,
      enabled: false,
      allowedRoles: ['admin'],
    });
  });

  /** Identity comes from local discovery and can never be edited remotely. */
  it('rejects an attempt to change identity or schema digests', () => {
    for (const field of ['toolId', 'name', 'sourceFingerprint', 'inputSchemaDigest']) {
      expect(() => parseToolOverride({ [field]: 'x' })).toThrow();
    }
  });

  it('rejects a risk class outside the assessed set', () => {
    expect(() => parseToolOverride({ riskClass: 'harmless' })).toThrow();
    expect(() => parseToolOverride({ riskClass: 'unknown' })).toThrow();
  });

  it('rejects a description long enough to carry source', () => {
    expect(() => parseToolOverride({ description: 'x'.repeat(1_001) })).toThrow();
  });

  it('accepts an empty change without inventing values', () => {
    expect(parseToolOverride({})).toEqual({});
  });
});

describe('merging a request into the stored decision', () => {
  it('keeps absent fields and removes the ones sent as null', () => {
    expect(mergeToolOverride(
      { enabled: false, riskClass: 'delete', baselineRiskClass: 'write' },
      { riskClass: null, description: 'Archives a task.' },
    )).toEqual({
      enabled: false,
      baselineRiskClass: 'write',
      description: 'Archives a task.',
    });
  });
});

describe('bounding a tool override by the reported code', () => {
  it('raises the risk class and asks for confirmation from tier 2 on', () => {
    const bound = boundToolOverride(
      reported({ riskClass: 'safe-read', requiresApproval: false }),
      { riskClass: 'write' },
    );

    expect(bound.violations).toEqual([]);
    expect(bound.entry).toEqual({ riskClass: 'write' });
    expect(bound.effective).toMatchObject({ riskClass: 'write', requiresApproval: true });
    expect(bound.changedByPlatform.riskClass).toBe(true);
  });

  it('never lowers or relabels a risk class', () => {
    expect(boundToolOverride(reported({ riskClass: 'delete' }), { riskClass: 'write' }))
      .toMatchObject({
        entry: {},
        violations: [{ field: 'riskClass', reason: 'risk-class-lowered' }],
        effective: { riskClass: 'delete', requiresApproval: true },
      });
    expect(boundToolOverride(reported({ riskClass: 'delete' }), { riskClass: 'financial' }))
      .toMatchObject({
        entry: {},
        violations: [{ field: 'riskClass', reason: 'risk-class-relabelled' }],
      });
  });

  it('may disable an enabled tool but never enable a disabled one', () => {
    expect(boundToolOverride(reported(), { enabled: false })).toMatchObject({
      entry: { enabled: false },
      violations: [],
      effective: { enabled: false },
      changedByPlatform: { enabled: true },
    });
    expect(boundToolOverride(reported({ enabled: false }), { enabled: true }))
      .toMatchObject({
        entry: {},
        violations: [{ field: 'enabled', reason: 'cannot-enable-disabled-tool' }],
        effective: { enabled: false },
      });
    expect(boundToolOverride(reported(), { enabled: true }).entry).toEqual({});
  });

  it('always confirms tier 3, also when the same decision raises into it', () => {
    expect(boundToolOverride(
      reported({ riskClass: 'delete' }),
      { requiresApproval: false, baselineRiskClass: 'delete' },
    ).violations).toEqual([
      { field: 'requiresApproval', reason: 'tier-3-always-requires-approval' },
    ]);
    expect(boundToolOverride(
      reported(),
      { riskClass: 'external', requiresApproval: false, baselineRiskClass: 'write' },
    ).violations).toEqual([
      { field: 'requiresApproval', reason: 'tier-3-always-requires-approval' },
    ]);
  });

  it('pins a tier-2 relaxation to the reported class and shows it as pending', () => {
    const bound = boundToolOverride(
      reported(),
      { requiresApproval: false, baselineRiskClass: 'write' },
    );

    expect(bound.entry).toEqual({
      requiresApproval: false,
      pin: { toolId: TOOL_ID, atRiskClass: 'write' },
    });
    expect(bound.violations).toEqual([]);
    // A managed runtime only relaxes with a committed local entry.
    expect(bound.relaxationPending).toBe(true);
    expect(bound.effective.requiresApproval).toBe(true);
  });

  it('refuses a relaxation that was never pinned to a reported class', () => {
    expect(boundToolOverride(reported(), { requiresApproval: false }).violations)
      .toEqual([{ field: 'requiresApproval', reason: 'relaxation-requires-reviewed-pin' }]);
  });

  it('lets a stored relaxation lapse once the code raises the risk', () => {
    const bound = boundToolOverride(
      reported({ riskClass: 'write' }),
      { requiresApproval: false, baselineRiskClass: 'read-sensitive' },
    );

    expect(bound.effective.requiresApproval).toBe(true);
    expect(bound.relaxationPending).toBe(false);
    expect(bound.warnings).toEqual([
      { code: 'override-lapsed-risk-raised', field: 'platform.requiresApproval' },
    ]);
  });

  it('treats a relaxation the code already made as no decision', () => {
    expect(boundToolOverride(
      reported({ riskClass: 'safe-read', requiresApproval: false }),
      { requiresApproval: false, baselineRiskClass: 'safe-read' },
    ).entry).toEqual({});
  });

  it('only narrows roles; a disjoint restriction disables instead of opening', () => {
    const narrowed = boundToolOverride(
      reported({ allowedRoles: ['admin', 'member'] }),
      { allowedRoles: ['viewer', 'member', 'member'] },
    );
    expect(narrowed.entry.allowedRoles).toEqual(['member', 'viewer']);
    expect(narrowed.effective.allowedRoles).toEqual(['member']);

    const disjoint = boundToolOverride(
      reported({ allowedRoles: ['admin'] }),
      { allowedRoles: ['viewer'] },
    );
    expect(disjoint.effective).toMatchObject({ enabled: false, allowedRoles: [] });
  });

  /** Empty roles mean the endpoint's own authorization applies. */
  it('accepts a tool that reports no roles', () => {
    expect(boundToolOverride(reported(), {}).effective.allowedRoles).toEqual([]);
  });

  it('carries the description as a Platform decision', () => {
    const bound = boundToolOverride(reported(), { description: 'Archives a task.' });

    expect(bound.entry).toEqual({ description: 'Archives a task.' });
    expect(bound.effective.description).toBe('Archives a task.');
    expect(bound.changedByPlatform.description).toBe(true);
  });

  /** A row stored before the bounds existed is clamped, never trusted. */
  it('drops an out-of-bounds legacy decision instead of applying it', () => {
    const bound = boundToolOverride(
      reported({ riskClass: 'read-sensitive', enabled: false }),
      { riskClass: 'safe-read', enabled: true },
    );

    expect(bound.entry).toEqual({});
    expect(bound.effective).toMatchObject({
      riskClass: 'read-sensitive',
      enabled: false,
    });
  });
});

describe('classifying a change between two Platform decisions', () => {
  const changes: Array<[string, ToolPolicyEntry, ToolPolicyEntry, PolicyChangeDirection]> = [
    ['disabling', {}, { enabled: false }, 'hardening'],
    ['re-enabling', { enabled: false }, {}, 'loosening'],
    ['requiring confirmation', {}, { requiresApproval: true }, 'hardening'],
    ['dropping a required confirmation', { requiresApproval: true }, {}, 'loosening'],
    ['relaxing confirmation', {}, {
      requiresApproval: false,
      pin: { toolId: TOOL_ID, atRiskClass: 'write' },
    }, 'loosening'],
    ['raising the risk class', { riskClass: 'write' }, { riskClass: 'delete' }, 'hardening'],
    ['lowering the risk class', { riskClass: 'delete' }, {}, 'loosening'],
    ['narrowing roles', { allowedRoles: ['admin', 'member'] }, { allowedRoles: ['admin'] }, 'hardening'],
    ['widening roles', { allowedRoles: ['admin'] }, { allowedRoles: ['admin', 'member'] }, 'loosening'],
    ['rewording the description', { description: 'Old.' }, { description: 'New.' }, 'none'],
    ['a hardening next to a loosening', { enabled: false }, { requiresApproval: true }, 'loosening'],
  ];

  it.each(changes)('%s', (_name, previous, current, expected) => {
    expect(classifyToolPolicyChange(previous, current)).toBe(expected);
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
@@ -2,6 +2,7 @@ import {
   ConflictException,
   ForbiddenException,
   NotFoundException,
+  UnprocessableEntityException,
 } from '@nestjs/common';
 import { beforeEach, describe, expect, it, vi } from 'vitest';
 import { RuntimeSetupV2Service } from '../runtime-setup-v2.service';
@@ -130,6 +131,7 @@ describe('RuntimeSetupV2Service', () => {
       appendVerifiedAudit: vi.fn(),
       findArtifact: vi.fn().mockResolvedValue(null),
       upsertToolOverride: vi.fn().mockResolvedValue(undefined),
+      findToolOverride: vi.fn().mockResolvedValue(null),
       listToolOverrides: vi.fn().mockResolvedValue([]),
       insertArtifact: vi.fn().mockImplementation(
         async (input: { artifactDigest: string }): Promise<
@@ -843,6 +845,7 @@ describe('assembling the reviewed artifact for publication', () => {
       findArtifact: vi.fn().mockResolvedValue(storedArtifact),
       insertArtifact: vi.fn(),
       upsertToolOverride: vi.fn().mockResolvedValue(undefined),
+      findToolOverride: vi.fn().mockResolvedValue(null),
       listToolOverrides: vi.fn().mockResolvedValue([]),
       appendAudit: vi.fn().mockResolvedValue(undefined),
     } as unknown as RuntimeAppSetupStore;
@@ -860,8 +863,36 @@ describe('assembling the reviewed artifact for publication', () => {
     expect(reviewed.planner.toolIds).toEqual([TOOL_ID]);
   });
 
-  /** The operator's decision is what gets signed, not the raw proposal. */
-  it('applies an operator override before publication', async () => {
+  /**
+   * The signed tools stay what the code reported; the operator's decision is
+   * signed beside them as a bounded delta.
+   */
+  it('signs the reported tools and carries in-bounds decisions as deltas', async () => {
+    store.listToolOverrides = vi.fn().mockResolvedValue([
+      { toolId: TOOL_ID, riskClass: 'delete', description: 'Lists open tasks.' },
+      // Only a capability report knows this tool yet: its saved baseline
+      // bounds it, exactly as for a policy-only revision (Task 8).
+      {
+        toolId: OTHER_RUN_ID,
+        enabled: false,
+        riskClass: 'safe-read',
+        baselineRiskClass: 'write',
+        baselineRequiresApproval: true,
+      },
+    ]);
+
+    const reviewed = await service.reviewedArtifact(scope, RUN_ID);
+    const tool = reviewed.tools.find((entry) => entry.toolId === TOOL_ID);
+
+    expect(tool?.riskClass).toBe('read-sensitive');
+    expect(reviewed.toolOverrides).toEqual([
+      { toolId: TOOL_ID, riskClass: 'delete', description: 'Lists open tasks.' },
+      { toolId: OTHER_RUN_ID, enabled: false },
+    ]);
+  });
+
+  /** A decision stored before the bounds existed never loosens anything. */
+  it('drops a stored decision that would lower the risk or enable a disabled tool', async () => {
     store.listToolOverrides = vi.fn().mockResolvedValue([
       { toolId: TOOL_ID, riskClass: 'safe-read', enabled: true },
     ]);
@@ -869,8 +900,9 @@ describe('assembling the reviewed artifact for publication', () => {
     const reviewed = await service.reviewedArtifact(scope, RUN_ID);
     const tool = reviewed.tools.find((entry) => entry.toolId === TOOL_ID);
 
-    expect(tool?.riskClass).toBe('safe-read');
-    expect(tool?.enabled).toBe(true);
+    expect(tool?.riskClass).toBe('read-sensitive');
+    expect(tool?.enabled).toBe(false);
+    expect(reviewed.toolOverrides).toEqual([]);
   });
 
   /**
@@ -896,3 +928,167 @@ describe('assembling the reviewed artifact for publication', () => {
     await expect(service.reviewedArtifact(scope, RUN_ID)).rejects.toThrow();
   });
 });
+
+describe('recording a bounded tool decision', () => {
+  let store: RuntimeAppSetupStore;
+  let service: RuntimeSetupV2Service;
+  const storedArtifact = {
+    artifactDigest: digest('Y'),
+    artifact: {
+      ...artifact,
+      tools: [{ ...artifact.tools[0], enabled: true, riskClass: 'write' }],
+    } as unknown as Record<string, unknown>,
+    generatedAt: updatedAt,
+    createdAt: updatedAt,
+  };
+
+  beforeEach(() => {
+    store = {
+      appExists: vi.fn().mockResolvedValue(true),
+      findRun: vi.fn().mockResolvedValue(runRecord({ status: 'ready' })),
+      findArtifact: vi.fn().mockResolvedValue(storedArtifact),
+      findToolOverride: vi.fn().mockResolvedValue(null),
+      upsertToolOverride: vi.fn().mockResolvedValue(undefined),
+      appendAudit: vi.fn().mockResolvedValue(undefined),
+    } as unknown as RuntimeAppSetupStore;
+    service = new RuntimeSetupV2Service(store, { publish: vi.fn() } as never);
+  });
+
+  it('refuses an out-of-bounds decision with 422 and stores nothing', async () => {
+    const attempt = service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { riskClass: 'safe-read' },
+      actor,
+    );
+
+    await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
+    await expect(attempt).rejects.toMatchObject({
+      response: {
+        code: 'tool_override_out_of_bounds',
+        field: 'riskClass',
+        reason: 'risk-class-lowered',
+      },
+    });
+    expect(store.upsertToolOverride).not.toHaveBeenCalled();
+  });
+
+  it('stores the merged decision with the reported baseline and audits its direction', async () => {
+    await service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { enabled: false, allowedRoles: ['admin'] },
+      actor,
+    );
+
+    expect(store.upsertToolOverride).toHaveBeenCalledWith({
+      ...scope,
+      runId: RUN_ID,
+      toolId: TOOL_ID,
+      override: {
+        enabled: false,
+        allowedRoles: ['admin'],
+        baselineRiskClass: 'write',
+        baselineRequiresApproval: true,
+      },
+      updatedBy: actor.userId,
+    });
+    expect(store.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
+      eventType: 'runtime.app_setup.tool_override',
+      payload: expect.objectContaining({
+        decidedFields: ['allowedRoles', 'enabled'],
+        direction: 'hardening',
+      }),
+    }));
+  });
+
+  it('removes a decision sent as null and reports the loosening', async () => {
+    store.findToolOverride = vi.fn().mockResolvedValue({
+      toolId: TOOL_ID,
+      enabled: false,
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    });
+
+    await service.saveToolOverride(scope, RUN_ID, TOOL_ID, { enabled: null }, actor);
+
+    expect(store.upsertToolOverride).toHaveBeenCalledWith(expect.objectContaining({
+      override: { baselineRiskClass: 'write', baselineRequiresApproval: true },
+    }));
+    expect(store.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
+      payload: expect.objectContaining({ direction: 'loosening' }),
+    }));
+  });
+
+  /** Re-pinning silently would revive a lapsed relaxation at a higher tier. */
+  it('keeps the stored baseline unless confirmation itself is decided again', async () => {
+    store.findToolOverride = vi.fn().mockResolvedValue({
+      toolId: TOOL_ID,
+      requiresApproval: false,
+      baselineRiskClass: 'read-sensitive',
+      baselineRequiresApproval: true,
+    });
+
+    await service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { description: 'Changes a task.' },
+      actor,
+    );
+
+    expect(store.upsertToolOverride).toHaveBeenCalledWith(expect.objectContaining({
+      override: expect.objectContaining({ baselineRiskClass: 'read-sensitive' }),
+    }));
+  });
+
+  /**
+   * A stored decision the code has since outgrown (a raise below what the code
+   * now reports) is clamped at publication; it must not block a save that
+   * does not decide that field. A request that decides it is still refused.
+   */
+  it('refuses only the fields a request decides', async () => {
+    store.findToolOverride = vi.fn().mockResolvedValue({
+      toolId: TOOL_ID,
+      riskClass: 'read-sensitive',
+      baselineRiskClass: 'safe-read',
+      baselineRequiresApproval: false,
+    });
+
+    await service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { description: 'Changes a task.' },
+      actor,
+    );
+
+    expect(store.upsertToolOverride).toHaveBeenCalledWith(expect.objectContaining({
+      override: expect.objectContaining({
+        riskClass: 'read-sensitive',
+        description: 'Changes a task.',
+      }),
+    }));
+    await expect(service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { riskClass: 'read-sensitive' },
+      actor,
+    )).rejects.toMatchObject({
+      response: { field: 'riskClass', reason: 'risk-class-lowered' },
+    });
+  });
+
+  it('refuses a tool the run does not report', async () => {
+    await expect(service.saveToolOverride(
+      scope,
+      RUN_ID,
+      OTHER_RUN_ID,
+      { enabled: false },
+      actor,
+    )).rejects.toBeInstanceOf(NotFoundException);
+  });
+});
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  2 failed (2)`, `Tests  33 failed | 47 passed (80)`. In `tool-override.spec.ts` 26 of 29 fail: 24 with `TypeError: (0 , boundToolOverride) is not a function` (or `classifyToolPolicyChange`, `mergeToolOverride`) and two parse tests on the old schema (`null`, `unknown`); the identity, size and empty-change parse pins pass. In the service spec the seven new tests fail ("signs the reported tools…", "drops a stored decision…", and five of "recording a bounded tool decision", among them "refuses only the fields a request decides"); "refuses a tool the run does not report" already passes.

- [ ] **Step 3: Implement**

Replace the whole content of `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/tool-override.ts` with:

```ts
import { z } from 'zod';
import {
  TOOL_POLICY_RULES_VERSION,
  TOOL_RISK_CLASSES,
  mostRestrictiveRiskClass,
  resolveToolPolicy,
  riskTier,
  type ResolveToolPolicyResult,
  type ToolPolicyEntry,
  type ToolRiskClass,
} from './tool-policy';

/** An operator may raise to any assessed class; `unknown` is not a choice. */
const OVERRIDE_RISK_CLASSES = [
  'safe-read',
  'read-sensitive',
  'write',
  'delete',
  'financial',
  'external',
] as const;

const role = z.string().trim().min(1).max(200);

/**
 * What an operator may decide about a discovered tool. A field that is absent
 * keeps the stored decision; `null` removes it again.
 *
 * Identity, source fingerprint, and schema digests are deliberately absent:
 * they come from local discovery and prove which code an entry refers to, so
 * letting them be edited remotely would break that proof. `.strict()` makes
 * an attempt to send them fail rather than be ignored silently.
 */
export const toolOverrideSchema = z.object({
  description: z.string().trim().min(1).max(1_000).nullable().optional(),
  riskClass: z.enum(OVERRIDE_RISK_CLASSES).nullable().optional(),
  requiresApproval: z.boolean().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  allowedRoles: z.array(role).max(100).nullable().optional(),
}).strict();

export type ToolOverrideInput = z.infer<typeof toolOverrideSchema>;

export function parseToolOverride(input: unknown): ToolOverrideInput {
  return toolOverrideSchema.parse(input);
}

/** The decided fields of one stored override, without the tool identity. */
export interface ToolOverrideFields {
  description?: string;
  riskClass?: ToolRiskClass;
  requiresApproval?: boolean;
  enabled?: boolean;
  allowedRoles?: string[];
  /** What the deployed code reported when the decision was saved. */
  baselineRiskClass?: ToolRiskClass;
  baselineRequiresApproval?: boolean;
}

export type StoredToolOverride = { toolId: string } & ToolOverrideFields;

/** The policy values the deployed code reported for one tool. */
export interface ReportedToolPolicy {
  toolId: string;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  enabled: boolean;
  allowedRoles: string[];
}

/** The policy values one uploaded artifact tool entry reports. */
export function reportedToolPolicy(
  tool: Record<string, unknown>,
): ReportedToolPolicy {
  const riskClass = tool.riskClass;
  const roles = tool.allowedRoles;
  return {
    toolId: typeof tool.toolId === 'string' ? tool.toolId : '',
    riskClass: typeof riskClass === 'string'
      && (TOOL_RISK_CLASSES as readonly string[]).includes(riskClass)
      ? riskClass as ToolRiskClass
      : 'unknown',
    requiresApproval: tool.requiresApproval === true,
    enabled: tool.enabled === true,
    allowedRoles: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === 'string')
      : [],
  };
}

export type ToolOverrideViolationReason =
  | 'risk-class-lowered'
  | 'risk-class-relabelled'
  | 'cannot-enable-disabled-tool'
  | 'tier-3-always-requires-approval'
  | 'relaxation-requires-reviewed-pin';

export interface ToolOverrideViolation {
  field: 'riskClass' | 'enabled' | 'requiresApproval';
  reason: ToolOverrideViolationReason;
}

/** A Platform policy delta for one tool, as signed into revisions. */
export type ToolOverrideDelta = { toolId: string } & ToolPolicyEntry;

export interface BoundToolOverride {
  /** Only the in-bounds decisions; never a copy of a reported value. */
  entry: ToolPolicyEntry;
  violations: ToolOverrideViolation[];
  /** What the runtime enforces: reported values restricted by `entry`. */
  effective: {
    enabled: boolean;
    requiresApproval: boolean;
    riskClass: ToolRiskClass;
    allowedRoles: string[];
    description?: string;
  };
  /** Per field: did the Platform decision change the reported value? */
  changedByPlatform: {
    enabled: boolean;
    requiresApproval: boolean;
    riskClass: boolean;
    allowedRoles: boolean;
    description: boolean;
  };
  /**
   * A Platform relaxation of confirmation is signed, but a managed runtime
   * only honours it together with a committed local entry; until the code
   * reports `requiresApproval: false` itself, the tool keeps asking.
   */
  relaxationPending: boolean;
  warnings: ResolveToolPolicyResult['warnings'];
}

/** Lay an operator request over the stored decision (`null` clears a field). */
export function mergeToolOverride(
  stored: ToolOverrideFields | undefined,
  input: ToolOverrideInput,
): ToolOverrideFields {
  const merged: ToolOverrideFields = { ...(stored ?? {}) };
  for (const field of [
    'description',
    'riskClass',
    'requiresApproval',
    'enabled',
    'allowedRoles',
  ] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null) {
      delete merged[field];
    } else {
      (merged as Record<string, unknown>)[field] = value;
    }
  }
  return merged;
}

/**
 * Bound an operator decision by the code that reported the tool (spec 4.5):
 * the risk class only rises, every layer may disable but none enables,
 * roles only narrow, tier 3 always confirms, and a relaxation of confirmation
 * is pinned to the reported risk class so it lapses when the code raises it.
 * Out-of-bounds decisions are returned as violations and left out of `entry`;
 * the save path answers them with 422, publication simply drops them.
 */
export function boundToolOverride(
  reported: ReportedToolPolicy,
  decision: ToolOverrideFields,
): BoundToolOverride {
  const violations: ToolOverrideViolation[] = [];
  const entry: ToolPolicyEntry = {};

  if (decision.enabled === false) entry.enabled = false;
  if (decision.enabled === true && !reported.enabled) {
    violations.push({ field: 'enabled', reason: 'cannot-enable-disabled-tool' });
  }

  if (decision.riskClass !== undefined) {
    const raised = riskTier(decision.riskClass) - riskTier(reported.riskClass);
    if (raised < 0) {
      violations.push({ field: 'riskClass', reason: 'risk-class-lowered' });
    } else if (raised === 0 && decision.riskClass !== reported.riskClass) {
      violations.push({ field: 'riskClass', reason: 'risk-class-relabelled' });
    } else {
      entry.riskClass = decision.riskClass;
    }
  }

  if (decision.requiresApproval === true) entry.requiresApproval = true;
  if (decision.requiresApproval === false && reported.requiresApproval) {
    const tier = riskTier(
      mostRestrictiveRiskClass(reported.riskClass, entry.riskClass),
    );
    if (tier >= 3) {
      violations.push({
        field: 'requiresApproval',
        reason: 'tier-3-always-requires-approval',
      });
    } else if (decision.baselineRiskClass === undefined) {
      violations.push({
        field: 'requiresApproval',
        reason: 'relaxation-requires-reviewed-pin',
      });
    } else {
      entry.requiresApproval = false;
      entry.pin = {
        toolId: reported.toolId,
        atRiskClass: decision.baselineRiskClass,
      };
    }
  }

  const roles = [...new Set(decision.allowedRoles ?? [])].sort();
  if (roles.length > 0) entry.allowedRoles = roles;
  if (decision.description !== undefined) entry.description = decision.description;

  const resolved = resolveToolPolicy({
    toolId: reported.toolId,
    defaults: {
      operationGroup: 'read',
      riskClass: reported.riskClass as Exclude<ToolRiskClass, 'unknown'>,
      requiresApproval: reported.requiresApproval,
      rulesVersion: TOOL_POLICY_RULES_VERSION,
    },
    codeEnabled: reported.enabled,
    ...(reported.allowedRoles.length > 0
      ? { local: { allowedRoles: reported.allowedRoles } }
      : {}),
    platform: entry,
  });
  const relaxationPending = resolved.effective.requiresApproval === false
    && reported.requiresApproval;
  const effective = {
    enabled: resolved.effective.enabled,
    requiresApproval: relaxationPending
      ? true
      : resolved.effective.requiresApproval,
    riskClass: resolved.effective.riskClass,
    allowedRoles: resolved.effective.allowedRoles,
    ...(resolved.effective.description === undefined
      ? {}
      : { description: resolved.effective.description }),
  };
  const origin = resolved.effective.origin;
  return {
    entry,
    violations,
    effective,
    changedByPlatform: {
      enabled: origin.enabled === 'platform',
      requiresApproval: !relaxationPending
        && origin.requiresApproval === 'platform',
      riskClass: origin.riskClass === 'platform',
      allowedRoles: origin.allowedRoles === 'platform',
      description: origin.description === 'platform',
    },
    relaxationPending,
    warnings: resolved.warnings,
  };
}

/** True when an entry carries no decision at all. */
export function isEmptyToolPolicyEntry(entry: ToolPolicyEntry): boolean {
  return Object.keys(entry).length === 0;
}

/**
 * The signed deltas of a set of stored decisions, sorted by toolId. Each is
 * bounded by what the code reported for its tool; a tool that only a
 * capability report knows (it runs, but no reviewed run contains it yet) is
 * bounded by the baseline saved with its decision, and the runtime bounds it
 * again. Publication and policy-only revisions share this one rule, so both
 * sign exactly the same deltas for the same decisions.
 */
export function boundToolOverrideDeltas(
  overrides: ReadonlyArray<StoredToolOverride>,
  reported: ReadonlyMap<string, ReportedToolPolicy>,
): ToolOverrideDelta[] {
  return overrides
    .flatMap(({ toolId, ...decision }) => {
      const reference: ReportedToolPolicy = reported.get(toolId) ?? {
        toolId,
        riskClass: decision.baselineRiskClass ?? 'unknown',
        requiresApproval: decision.baselineRequiresApproval ?? true,
        enabled: true,
        allowedRoles: [],
      };
      const { entry } = boundToolOverride(reference, decision);
      return isEmptyToolPolicyEntry(entry) ? [] : [{ toolId, ...entry }];
    })
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
}

export type PolicyChangeDirection = 'none' | 'hardening' | 'loosening';

function pinTier(entry: ToolPolicyEntry): number {
  return entry.pin ? riskTier(entry.pin.atRiskClass) : -1;
}

/**
 * Direction of a change between two Platform deltas of the same tool,
 * independent of the code underneath: a removed disable, a removed or new
 * confirmation relaxation, a lowered or relabelled risk class and widened
 * roles loosen; the opposite hardens. Description and reason are neutral.
 */
export function classifyToolPolicyChange(
  previous: ToolPolicyEntry | undefined,
  current: ToolPolicyEntry | undefined,
): PolicyChangeDirection {
  const before = previous ?? {};
  const after = current ?? {};
  const directions: PolicyChangeDirection[] = [];

  const disabled = (value: ToolPolicyEntry) => value.enabled === false;
  if (disabled(before) !== disabled(after)) {
    directions.push(disabled(after) ? 'hardening' : 'loosening');
  }

  const approval = (value: ToolPolicyEntry) => (
    value.requiresApproval === true ? 1 : value.requiresApproval === false ? -1 : 0
  );
  if (approval(before) !== approval(after)) {
    directions.push(approval(after) > approval(before) ? 'hardening' : 'loosening');
  } else if (approval(after) === -1 && pinTier(after) > pinTier(before)) {
    // A relaxation pinned at a higher class keeps applying to riskier code.
    directions.push('loosening');
  }

  const tier = (value: ToolPolicyEntry) => (
    value.riskClass === undefined ? -1 : riskTier(value.riskClass)
  );
  if (tier(after) > tier(before)) directions.push('hardening');
  else if (tier(after) < tier(before)) directions.push('loosening');
  else if (before.riskClass !== after.riskClass) directions.push('loosening');

  const roles = (value: ToolPolicyEntry) => [...new Set(value.allowedRoles ?? [])];
  const rolesBefore = roles(before);
  const rolesAfter = roles(after);
  const sameRoles = rolesBefore.length === rolesAfter.length
    && rolesBefore.every((name) => rolesAfter.includes(name));
  if (!sameRoles) {
    const narrowed = rolesAfter.length > 0 && (
      rolesBefore.length === 0
      || rolesAfter.every((name) => rolesBefore.includes(name))
    );
    directions.push(narrowed ? 'hardening' : 'loosening');
  }

  if (directions.includes('loosening')) return 'loosening';
  return directions.includes('hardening') ? 'hardening' : 'none';
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/app-configuration.service.ts b/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
--- a/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
+++ b/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
@@ -5,6 +5,7 @@ import {
 } from '@nestjs/common';
 import { createHash } from 'node:crypto';
 import { canonicalRuntimeJson } from './runtime-signing.service';
+import { type ToolOverrideDelta } from '../runtime-setup-v2/tool-override';
 import {
   RuntimeRevisionService,
   type RuntimeActor,
@@ -49,6 +50,8 @@ export interface ReviewedAppSetupArtifact {
   discoveryDigest: string;
   status: string;
   tools: AppSetupToolCandidateInput[];
+  /** Bounded operator decisions, sorted by toolId; never tool copies. */
+  toolOverrides?: ToolOverrideDelta[];
   planner: {
     plannerId: string;
     modelBindingRef: string;
diff --git a/apps/api/src/modules/runtime-setup-v2/connected-apply-claim.ts b/apps/api/src/modules/runtime-setup-v2/connected-apply-claim.ts
--- a/apps/api/src/modules/runtime-setup-v2/connected-apply-claim.ts
+++ b/apps/api/src/modules/runtime-setup-v2/connected-apply-claim.ts
@@ -1,7 +1,7 @@
 import { createHash } from 'node:crypto';
 import { z } from 'zod';
 import { canonicalRuntimeJson } from '../runtime-revisions/runtime-signing.service';
-import { type ToolOverride } from './tool-override';
+import { type StoredToolOverride } from './tool-override';
 
 export const CONNECTED_APPLY_FRESHNESS_MS = 90_000;
 
@@ -61,7 +61,7 @@ export function connectedApplyClaimId(
 
 export function connectedApplyInputDigest(
   artifactDigest: string,
-  overrides: Array<{ toolId: string } & ToolOverride>,
+  overrides: StoredToolOverride[],
 ): string {
   const normalized = [...overrides]
     .map(({ toolId, ...override }) => ({ toolId, ...override }))
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -37,6 +37,8 @@ import {
 } from './connected-apply-claim';
 import { publishAndDeployId } from './publish-and-deploy-id';
 import { assertConnectedApplyPipeline } from './connected-apply-pipeline-policy';
+import { type StoredToolOverride } from './tool-override';
+import { type ToolRiskClass } from './tool-policy';
 
 @Injectable()
 export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
@@ -640,14 +642,13 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
     input: Parameters<RuntimeAppSetupStore['upsertToolOverride']>[0],
   ): Promise<void> {
     const decided = {
-      ...(input.override.description !== undefined
-        ? { description: input.override.description } : {}),
-      ...(input.override.riskClass !== undefined
-        ? { riskClass: input.override.riskClass } : {}),
-      ...(input.override.requiresApproval !== undefined
-        ? { requiresApproval: input.override.requiresApproval } : {}),
-      ...(input.override.enabled !== undefined
-        ? { enabled: input.override.enabled } : {}),
+      description: input.override.description ?? null,
+      riskClass: input.override.riskClass ?? null,
+      requiresApproval: input.override.requiresApproval ?? null,
+      enabled: input.override.enabled ?? null,
+      allowedRoles: input.override.allowedRoles ?? null,
+      baselineRiskClass: input.override.baselineRiskClass ?? null,
+      baselineRequiresApproval: input.override.baselineRequiresApproval ?? null,
     };
     await this.db
       .insert(runtimeAppSetupToolOverrides)
@@ -675,6 +676,22 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
       });
   }
 
+  async findToolOverride(
+    scope: Parameters<RuntimeAppSetupStore['findToolOverride']>[0],
+    toolId: string,
+  ) {
+    const rows = await this.db
+      .select()
+      .from(runtimeAppSetupToolOverrides)
+      .where(and(
+        eq(runtimeAppSetupToolOverrides.tenantId, scope.tenantId),
+        eq(runtimeAppSetupToolOverrides.targetAppId, scope.targetAppId),
+        eq(runtimeAppSetupToolOverrides.toolId, toolId),
+      ))
+      .limit(1);
+    return this.toToolOverrides(rows)[0] ?? null;
+  }
+
   async listToolOverrides(
     scope: Parameters<RuntimeAppSetupStore['listToolOverrides']>[0],
   ) {
@@ -694,15 +711,23 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
     riskClass: string | null;
     requiresApproval: boolean | null;
     enabled: boolean | null;
-  }>) {
+    allowedRoles: string[] | null;
+    baselineRiskClass: string | null;
+    baselineRequiresApproval: boolean | null;
+  }>): StoredToolOverride[] {
     return rows.map((row) => ({
       toolId: row.toolId,
       ...(row.description !== null ? { description: row.description } : {}),
       ...(row.riskClass !== null
-        ? { riskClass: row.riskClass as never } : {}),
+        ? { riskClass: row.riskClass as ToolRiskClass } : {}),
       ...(row.requiresApproval !== null
         ? { requiresApproval: row.requiresApproval } : {}),
       ...(row.enabled !== null ? { enabled: row.enabled } : {}),
+      ...(row.allowedRoles !== null ? { allowedRoles: row.allowedRoles } : {}),
+      ...(row.baselineRiskClass !== null
+        ? { baselineRiskClass: row.baselineRiskClass as ToolRiskClass } : {}),
+      ...(row.baselineRequiresApproval !== null
+        ? { baselineRequiresApproval: row.baselineRequiresApproval } : {}),
     }));
   }
 
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
@@ -4,12 +4,23 @@ import {
   Inject,
   Injectable,
   NotFoundException,
+  UnprocessableEntityException,
 } from '@nestjs/common';
 import { createHash } from 'node:crypto';
 import { z } from 'zod';
 import { canonicalRuntimeJson } from '../runtime-revisions/runtime-signing.service';
 import { StreamService } from '../stream/stream.service';
-import { applyToolOverride, type ToolOverride } from './tool-override';
+import {
+  boundToolOverride,
+  boundToolOverrideDeltas,
+  classifyToolPolicyChange,
+  mergeToolOverride,
+  reportedToolPolicy,
+  type ReportedToolPolicy,
+  type StoredToolOverride,
+  type ToolOverrideFields,
+  type ToolOverrideInput,
+} from './tool-override';
 import {
   type ReviewedAppSetupArtifact,
 } from '../runtime-revisions/app-configuration.service';
@@ -346,31 +357,55 @@ export class RuntimeSetupV2Service {
 
   /**
    * Record an operator decision for one tool. The uploaded artifact stays
-   * untouched: it records what the assessment proposed, and the decision is
-   * stored beside it so both remain visible.
+   * untouched: it records what the code reported, and the decision is stored
+   * beside it so both remain visible. A decision outside the bounds the code
+   * allows (spec 4.5) is refused with 422 and the reason code; nothing is
+   * stored then.
    */
   async saveToolOverride(
     scope: AppSetupScope,
     runId: string,
     toolId: string,
-    override: ToolOverride,
+    input: ToolOverrideInput,
     actor: AppSetupActor,
   ): Promise<void> {
     this.assertEditor(actor);
     await this.assertApp(scope);
     const run = await this.requireRun(scope, runId);
     const artifact = await this.store.findArtifact(scope, runId);
-    const known = this.artifactTools(artifact)
-      .some((tool) => this.readString(tool, 'toolId') === toolId);
-    if (!known) {
+    const tool = this.artifactTools(artifact)
+      .find((candidate) => this.readString(candidate, 'toolId') === toolId);
+    if (!tool) {
       throw new NotFoundException('The setup run does not contain that tool');
     }
 
+    const reported = reportedToolPolicy(tool);
+    const stored = await this.store.findToolOverride(scope, toolId);
+    const { toolId: _storedToolId, ...storedFields } = stored ?? { toolId };
+    const decision = this.withBaseline(
+      mergeToolOverride(storedFields, input),
+      reported,
+      input.requiresApproval !== undefined,
+    );
+    const bound = boundToolOverride(reported, decision);
+    // Only a field this request decides can be refused. A stored value the
+    // code has since outgrown stays stored and is clamped at publication.
+    const violation = bound.violations.find(
+      ({ field }) => input[field] !== undefined && input[field] !== null,
+    );
+    if (violation) {
+      throw new UnprocessableEntityException({
+        code: 'tool_override_out_of_bounds',
+        field: violation.field,
+        reason: violation.reason,
+      });
+    }
+
     await this.store.upsertToolOverride({
       ...scope,
       runId,
       toolId,
-      override,
+      override: decision,
       updatedBy: actor.userId,
     });
     await this.store.appendAudit({
@@ -381,7 +416,11 @@ export class RuntimeSetupV2Service {
         runId,
         toolId,
         status: run.status,
-        decidedFields: Object.keys(override).sort(),
+        decidedFields: Object.keys(input).sort(),
+        direction: classifyToolPolicyChange(
+          stored ? boundToolOverride(reported, storedFields).entry : undefined,
+          bound.entry,
+        ),
       },
     });
   }
@@ -437,24 +476,24 @@ export class RuntimeSetupV2Service {
     };
   }
 
+  /**
+   * The tools stay exactly what the code reported; operator decisions travel
+   * beside them as bounded deltas. Publication signs both, so a later change
+   * of a decision never has to rewrite a tool revision.
+   */
   private reviewedArtifactFromInputs(
     scope: AppSetupScope,
     status: AppSetupStatus,
     stored: AppSetupArtifactRecord,
-    overrides: Array<{ toolId: string } & ToolOverride>,
+    overrides: StoredToolOverride[],
   ): ReviewedAppSetupArtifact {
-    const decided = new Map(
-      overrides.map(({ toolId, ...override }) => [toolId, override]),
-    );
     const payload = stored.artifact as Record<string, unknown>;
-    const tools = this.artifactTools(stored).map((tool) => {
-      const toolId = this.readString(tool, 'toolId') ?? '';
-      const override = decided.get(toolId);
-      const applied = override ? applyToolOverride(tool, override) : tool;
-      const { overriddenFields: _ignored, ...rest } = applied as
-        Record<string, unknown> & { overriddenFields?: string[] };
-      return rest;
-    });
+    const tools = this.artifactTools(stored);
+    const reportedById = new Map(tools.map((tool) => [
+      this.readString(tool, 'toolId') ?? '',
+      reportedToolPolicy(tool),
+    ]));
+    const toolOverrides = boundToolOverrideDeltas(overrides, reportedById);
 
     return {
       appId: scope.targetAppId,
@@ -465,8 +504,8 @@ export class RuntimeSetupV2Service {
       tools,
       planner: payload.planner,
       prompts: payload.prompts,
-      // The stored artifact passed appSetupArtifactSchema at upload and an
-      // override only replaces fields that schema already validated, so these
+      toolOverrides,
+      // The stored artifact passed appSetupArtifactSchema at upload, so these
       // records carry the reviewed shapes; the JSON column cannot say so.
     } as unknown as ReviewedAppSetupArtifact;
   }
@@ -707,22 +746,21 @@ export class RuntimeSetupV2Service {
 
   private artifactSummary(
     record: AppSetupArtifactRecord,
-    overrides: Array<{ toolId: string } & ToolOverride> = [],
+    overrides: StoredToolOverride[] = [],
   ): AppSetupArtifactSummary {
     const artifact = record.artifact;
     const decided = new Map(
       overrides.map(({ toolId, ...override }) => [toolId, override]),
     );
-    const proposed = Array.isArray(artifact.tools) ? artifact.tools : [];
+    const proposed = this.artifactTools(record);
+    // What the runtime enforces: the reported values restricted by the
+    // bounded decision. An out-of-bounds legacy decision never shows up here.
     const tools = proposed.map((tool) => {
-      const toolId = this.readString(
-        tool as Record<string, unknown>,
-        'toolId',
-      ) ?? '';
+      const toolId = this.readString(tool, 'toolId') ?? '';
       const override = decided.get(toolId);
-      return override
-        ? applyToolOverride(tool as Record<string, unknown>, override)
-        : tool;
+      if (!override) return tool;
+      const { effective } = boundToolOverride(reportedToolPolicy(tool), override);
+      return { ...tool, ...effective };
     });
     const groupCounts = Object.fromEntries(
       OPERATION_GROUPS.map((group) => [
@@ -788,6 +826,26 @@ export class RuntimeSetupV2Service {
     };
   }
 
+  /**
+   * A relaxation is pinned to the class the code reported when it was
+   * decided, so the baseline moves only when confirmation itself is decided
+   * again (or on the first decision for the tool).
+   */
+  private withBaseline(
+    decision: ToolOverrideFields,
+    reported: ReportedToolPolicy,
+    decidesApproval: boolean,
+  ): ToolOverrideFields {
+    if (decision.baselineRiskClass !== undefined && !decidesApproval) {
+      return decision;
+    }
+    return {
+      ...decision,
+      baselineRiskClass: reported.riskClass,
+      baselineRequiresApproval: reported.requiresApproval,
+    };
+  }
+
   private readBoolean(value: unknown, key: string): boolean {
     if (value === null || typeof value !== 'object') return false;
     return (value as Record<string, unknown>)[key] === true;
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
@@ -1,4 +1,7 @@
-import { type ToolOverride } from './tool-override';
+import {
+  type StoredToolOverride,
+  type ToolOverrideFields,
+} from './tool-override';
 export const RUNTIME_APP_SETUP_STORE = Symbol('RUNTIME_APP_SETUP_STORE');
 
 export type AppSetupStatus =
@@ -72,7 +75,7 @@ export interface RuntimeAppSetupStore {
   ): Promise<{
     status: 'ready' | 'published';
     artifact: AppSetupArtifactRecord;
-    overrides: Array<{ toolId: string } & ToolOverride>;
+    overrides: StoredToolOverride[];
   }>;
   findRun(
     scope: AppSetupScope,
@@ -126,17 +129,25 @@ export interface RuntimeAppSetupStore {
     generatedAt: Date;
     importedBy: string;
   }): Promise<AppSetupArtifactRecord>;
-  /** At most one override per tool and run; unset fields keep the proposal. */
+  /**
+   * At most one decision per tool and app. The stored decision is replaced as
+   * a whole: an absent field is written as null and keeps what the code
+   * reported.
+   */
   upsertToolOverride(input: AppSetupScope & {
     runId: string;
     toolId: string;
-    override: ToolOverride;
+    override: ToolOverrideFields;
     updatedBy: string;
   }): Promise<void>;
+  findToolOverride(
+    scope: AppSetupScope,
+    toolId: string,
+  ): Promise<StoredToolOverride | null>;
   /** App-scoped: a decision outlives the run that discovered the tool. */
   listToolOverrides(
     scope: AppSetupScope,
-  ): Promise<Array<{ toolId: string } & ToolOverride>>;
+  ): Promise<StoredToolOverride[]>;
   /**
    * Adopt the tool identities the local inventory owns. A revision references
    * a tool row, so publication cannot create one before the tool exists.
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-revisions src/modules/runtime-deployments 2>&1 | grep -E "Test Files|Tests "
grep -rn "applyToolOverride" src scripts | wc -l
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  80 passed (80)`; `Test Files  25 passed (25)`, `Tests  318 passed (318)`; `0` (macOS `wc` pads it with spaces); `Test Files  117 passed (117)`, `Tests  1225 passed | 10 skipped (1235)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/tool-override.ts apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/connected-apply-claim.ts apps/api/src/modules/runtime-revisions/app-configuration.service.ts
git commit -m "feat(runtime-setup): bound tool overrides by the reported code"
```

---

### Task 4: API – sign tool decisions as configuration deltas

**Files:**
- Modify: `apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts:418`; `apps/api/src/modules/runtime-revisions/app-configuration.service.ts:189,273-340`; `apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts:627,753`
- Test: `apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts`

**Interfaces:**
- Consumes: Task 3's `ReviewedAppSetupArtifact.toolOverrides` and `type ToolOverrideDelta`; Task 1's `runtime_config_revisions.tool_overrides`.
- Produces: the configuration payload gains `toolOverrides` (present only when non-empty, so a configuration without decisions keeps the bytes and content hash it had); the Drizzle store writes it to `tool_overrides` and `payloadFor` reproduces the same rule, so the signed payload equals the hashed one. `createFromReviewedSetup` puts the reviewed deltas into the configuration and allowlists `planner.toolIds` ∩ tools with `enabled: true`. New `createPolicyOnlyRevision({ tenantId, targetAppId, baseConfiguration: { id, setupArtifactDigest, runtimeDigest, promptDigest, promptRevisionId, plannerRevisionId, tools }, toolOverrides }, actor): Promise<AppConfigurationResult>`: one config draft over byte-identical bindings, `parentRevisionId` = base, deterministic id `policyOnlyRevisionId(base.id, deltas)`, fails closed (409) when the recomputed runtime digest differs from the base. New exported `policyOnlyRevisionId(baseConfigurationId, toolOverrides): string` (the former `revisionIdentity(base.id, 'policy\0' + sha256(canonical sorted deltas))`, same value, order-independent), so Task 8 can name the revision that signs the current decisions without drafting it.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts b/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
--- a/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
@@ -3,7 +3,10 @@ import {
   ForbiddenException,
 } from '@nestjs/common';
 import { beforeEach, describe, expect, it, vi } from 'vitest';
-import { RuntimeAppConfigurationService } from '../app-configuration.service';
+import {
+  RuntimeAppConfigurationService,
+  policyOnlyRevisionId,
+} from '../app-configuration.service';
 import {
   RuntimeRevisionService,
   type PreparedRuntimeDraft,
@@ -416,6 +419,122 @@ describe('RuntimeAppConfigurationService', () => {
     });
   });
 
+  it('signs bounded decisions beside unchanged tool revisions', async () => {
+    await service.createFromReviewedSetup({
+      ...scope,
+      agentId: AGENT_ID,
+      artifact: {
+        ...reviewedArtifact,
+        toolOverrides: [{ toolId: TOOL_A, enabled: false, description: 'Lists tasks.' }],
+      },
+    }, actor);
+
+    expect(payloadOf(draftsOfType('tool')[0])).toMatchObject({ enabled: true });
+    expect(payloadOf(draftsOfType('config')[0]).toolOverrides).toEqual([
+      { toolId: TOOL_A, enabled: false, description: 'Lists tasks.' },
+    ]);
+  });
+
+  /** The runner refuses a deployment whose allowlist names a disabled tool. */
+  it('allowlists only the tools the code reports enabled', async () => {
+    await service.createFromReviewedSetup({
+      ...scope,
+      agentId: AGENT_ID,
+      artifact: {
+        ...reviewedArtifact,
+        planner: { ...reviewedArtifact.planner, toolIds: [TOOL_A, TOOL_B] },
+      },
+    }, actor);
+
+    expect(payloadOf(draftsOfType('agent')[0]).toolAllowlist).toEqual([TOOL_A]);
+  });
+
+  it('drafts a policy-only configuration over byte-identical bindings', async () => {
+    const base = await service.createFromReviewedSetup({
+      ...scope,
+      agentId: AGENT_ID,
+      artifact: reviewedArtifact,
+    }, actor);
+    const baseConfiguration = {
+      id: base.configurationRevisionId,
+      setupArtifactDigest: base.setupArtifactDigest,
+      runtimeDigest: base.runtimeDigest,
+      promptDigest: base.promptDigest,
+      promptRevisionId: base.promptRevisionId,
+      plannerRevisionId: base.plannerRevisionId,
+      tools: base.toolRevisions.map((tool) => ({
+        toolId: tool.toolId,
+        toolRevisionId: tool.revisionId,
+        tombstone: tool.tombstone,
+      })),
+    };
+    created = [];
+
+    const first = await service.createPolicyOnlyRevision({
+      ...scope,
+      baseConfiguration,
+      toolOverrides: [
+        { toolId: TOOL_B, requiresApproval: true },
+        { toolId: TOOL_A, enabled: false },
+      ],
+    }, actor);
+    const second = await service.createPolicyOnlyRevision({
+      ...scope,
+      baseConfiguration,
+      toolOverrides: [
+        { toolId: TOOL_A, enabled: false },
+        { toolId: TOOL_B, requiresApproval: true },
+      ],
+    }, actor);
+
+    expect(allDrafts().map((draft) => draft.type)).toEqual(['config', 'config']);
+    expect(second.configurationRevisionId).toBe(first.configurationRevisionId);
+    // Anyone can name the revision of a decision set without drafting it.
+    expect(first.configurationRevisionId).toBe(policyOnlyRevisionId(
+      base.configurationRevisionId,
+      [{ toolId: TOOL_A, enabled: false }, { toolId: TOOL_B, requiresApproval: true }],
+    ));
+    expect(first.runtimeDigest).toBe(base.runtimeDigest);
+    expect(payloadOf(draftsOfType('config')[0])).toEqual({
+      schemaVersion: 1,
+      setupArtifactDigest: base.setupArtifactDigest,
+      runtimeDigest: base.runtimeDigest,
+      promptDigest: base.promptDigest,
+      promptRevisionId: base.promptRevisionId,
+      plannerRevisionId: base.plannerRevisionId,
+      tools: baseConfiguration.tools,
+      toolOverrides: [
+        { toolId: TOOL_A, enabled: false },
+        { toolId: TOOL_B, requiresApproval: true },
+      ],
+      parentRevisionId: base.configurationRevisionId,
+    });
+  });
+
+  it('fails closed when a policy-only revision would rebind the runtime', async () => {
+    const base = await service.createFromReviewedSetup({
+      ...scope,
+      agentId: AGENT_ID,
+      artifact: reviewedArtifact,
+    }, actor);
+    (store.createDraft as ReturnType<typeof vi.fn>).mockClear();
+
+    await expect(service.createPolicyOnlyRevision({
+      ...scope,
+      baseConfiguration: {
+        id: base.configurationRevisionId,
+        setupArtifactDigest: base.setupArtifactDigest,
+        runtimeDigest: base.runtimeDigest,
+        promptDigest: base.promptDigest,
+        promptRevisionId: base.promptRevisionId,
+        plannerRevisionId: 'agent-revision-99',
+        tools: [],
+      },
+      toolOverrides: [{ toolId: TOOL_A, enabled: false }],
+    }, actor)).rejects.toThrow(ConflictException);
+    expect(store.createDraft).not.toHaveBeenCalled();
+  });
+
   it('creates the complete 5003-revision publication contract for 5000 tools', async () => {
     const tools = Array.from({ length: 5_000 }, (_, index) => ({
       ...reviewedArtifact.tools[0],
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: `Tests  4 failed | 12 passed (16)`: "signs bounded decisions beside unchanged tool revisions" (`toolOverrides` is `undefined`), "allowlists only the tools the code reports enabled" (the disabled `TOOL_B` is allowlisted), and both policy-only tests (`createPolicyOnlyRevision is not a function`). The existing "binds every revision identity in the app configuration payload" keeps passing: it is the pin that a configuration without decisions keeps its exact payload.

- [ ] **Step 3: Implement**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/app-configuration.service.ts b/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
--- a/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
+++ b/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
@@ -187,6 +187,7 @@ export class RuntimeAppConfigurationService {
       promptRevisionId,
       plannerRevisionId,
       tools,
+      toolOverrides: artifact.toolOverrides ?? [],
       parentRevisionId: input.parentConfigurationRevisionId,
     }, actor);
 
@@ -271,6 +272,73 @@ export class RuntimeAppConfigurationService {
     };
   }
 
+  /**
+   * Operator decisions change, the reported code does not. A policy-only
+   * revision therefore keeps every tool, planner, and prompt binding
+   * byte-identical and only replaces the signed decision deltas; it fails
+   * closed if the recomputed runtime digest would change. Its identity is a
+   * function of the base and the deltas, so saving the same decision set
+   * twice drafts it once.
+   */
+  async createPolicyOnlyRevision(
+    input: {
+      tenantId: string;
+      targetAppId: string;
+      baseConfiguration: {
+        id: string;
+        setupArtifactDigest: string;
+        runtimeDigest: string;
+        promptDigest: string;
+        promptRevisionId: string;
+        plannerRevisionId: string;
+        tools: AppConfigurationToolBinding[];
+      };
+      toolOverrides: ToolOverrideDelta[];
+    },
+    actor: RuntimeActor,
+  ): Promise<AppConfigurationResult> {
+    const base = input.baseConfiguration;
+    const runtimeDigest = this.runtimeDigest({
+      plannerRevisionId: base.plannerRevisionId,
+      tools: base.tools,
+    });
+    if (runtimeDigest !== base.runtimeDigest) {
+      throw new ConflictException(
+        'A policy-only revision cannot change the runtime bundle identity',
+      );
+    }
+    const toolOverrides = sortedToolOverrides(input.toolOverrides);
+
+    const configuration = await this.createConfiguration({
+      revisionId: policyOnlyRevisionId(base.id, toolOverrides),
+      tenantId: input.tenantId,
+      targetAppId: input.targetAppId,
+      setupArtifactDigest: base.setupArtifactDigest,
+      runtimeDigest,
+      promptDigest: base.promptDigest,
+      promptRevisionId: base.promptRevisionId,
+      plannerRevisionId: base.plannerRevisionId,
+      tools: base.tools,
+      toolOverrides,
+      parentRevisionId: base.id,
+    }, actor);
+
+    return {
+      status: 'draft',
+      configurationRevisionId: configuration.id,
+      promptRevisionId: base.promptRevisionId,
+      plannerRevisionId: base.plannerRevisionId,
+      toolRevisions: base.tools.map((tool) => ({
+        toolId: tool.toolId,
+        revisionId: tool.toolRevisionId,
+        tombstone: tool.tombstone,
+      })),
+      runtimeDigest,
+      promptDigest: base.promptDigest,
+      setupArtifactDigest: base.setupArtifactDigest,
+    };
+  }
+
   private createConfiguration(
     input: {
       tenantId: string;
@@ -281,6 +349,7 @@ export class RuntimeAppConfigurationService {
       promptRevisionId: string;
       plannerRevisionId: string;
       tools: AppConfigurationToolBinding[];
+      toolOverrides?: ToolOverrideDelta[];
       parentRevisionId?: string;
       revisionId?: string;
     },
@@ -299,6 +368,11 @@ export class RuntimeAppConfigurationService {
         promptRevisionId: input.promptRevisionId,
         plannerRevisionId: input.plannerRevisionId,
         tools: input.tools,
+        // Absent when empty, so configurations without decisions keep the
+        // exact payload (and content hash) they had before decisions existed.
+        ...(input.toolOverrides?.length
+          ? { toolOverrides: input.toolOverrides }
+          : {}),
         ...(input.parentRevisionId
           ? { parentRevisionId: input.parentRevisionId }
           : {}),
@@ -328,16 +402,25 @@ export class RuntimeAppConfigurationService {
     };
   }
 
+  /**
+   * The runner accepts a deployment only when every allowlisted tool is
+   * enabled, so the allowlist holds exactly the tools the code reports
+   * enabled. A Platform disable is a signed delta instead: it never rebinds
+   * the planner, so a pure hardening stays a policy-only revision.
+   */
   private plannerPayload(
     artifact: ReviewedAppSetupArtifact,
   ): Record<string, unknown> {
+    const enabled = new Set(
+      artifact.tools.filter((tool) => tool.enabled).map((tool) => tool.toolId),
+    );
     return {
       schemaVersion: 1,
       plannerId: artifact.planner.plannerId,
       modelBindingRef: artifact.planner.modelBindingRef,
       promptBindingRef: artifact.planner.promptBindingRef,
       budgetProfileRef: artifact.planner.budgetProfileRef,
-      toolAllowlist: artifact.planner.toolIds,
+      toolAllowlist: artifact.planner.toolIds.filter((toolId) => enabled.has(toolId)),
     };
   }
 
@@ -385,3 +468,30 @@ export class RuntimeAppConfigurationService {
       + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
   }
 }
+
+function sortedToolOverrides(
+  toolOverrides: ReadonlyArray<ToolOverrideDelta>,
+): ToolOverrideDelta[] {
+  return [...toolOverrides]
+    .sort((left, right) => left.toolId.localeCompare(right.toolId));
+}
+
+/**
+ * Identity of the policy-only revision of one decision set over one base
+ * configuration (the order of the deltas does not matter). Saving the same
+ * decisions twice drafts one revision, and a reader can name the revision
+ * that signs the current decisions without drafting it.
+ */
+export function policyOnlyRevisionId(
+  baseConfigurationId: string,
+  toolOverrides: ReadonlyArray<ToolOverrideDelta>,
+): string {
+  const deltaDigest = createHash('sha256')
+    .update(canonicalRuntimeJson(sortedToolOverrides(toolOverrides)))
+    .digest('hex');
+  const hex = createHash('sha256')
+    .update(`runtime-publication\0${baseConfigurationId.toLowerCase()}\0policy\0${deltaDigest}`)
+    .digest('hex');
+  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
+    + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
+}
diff --git a/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts b/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
--- a/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
+++ b/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
@@ -625,6 +625,7 @@ export class DrizzleRuntimeRevisionStore implements RuntimeRevisionStore {
             'plannerRevisionId',
           ),
           tools: payload.tools ?? [],
+          toolOverrides: payload.toolOverrides ?? [],
           runtimeDigest: this.requiredString(
             payload.runtimeDigest,
             'runtimeDigest',
@@ -751,6 +752,11 @@ export class DrizzleRuntimeRevisionStore implements RuntimeRevisionStore {
         promptRevisionId: row.promptRevisionId,
         plannerRevisionId: row.plannerRevisionId,
         tools: row.tools,
+        // Mirrors the drafting rule: absent when empty, so the stored payload
+        // reproduces the content hash it was drafted with.
+        ...(Array.isArray(row.toolOverrides) && row.toolOverrides.length > 0
+          ? { toolOverrides: row.toolOverrides }
+          : {}),
         ...(row.parentRevisionId
           ? { parentRevisionId: row.parentRevisionId }
           : {}),
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-revisions src/modules/runtime-deployments 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Tests  16 passed (16)`; `Test Files  25 passed (25)`, `Tests  322 passed (322)`; `Test Files  117 passed (117)`, `Tests  1229 passed | 10 skipped (1239)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-revisions/app-configuration.service.ts apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
git commit -m "feat(runtime-revisions): sign tool decisions as configuration deltas"
```

---

### Task 5: API – derive signed `toolOverrides` deltas for each environment

**Files:**
- Modify: `apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts:48,153,252,404-428`; `apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts:26,68,103-105,258-294,327,454-458,543-555`; `apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts:8,47,72,150-165`
- Test: `apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts`

**Interfaces:**
- Consumes: Task 4's configuration payload (`toolOverrides`), `type ToolOverrideDelta`.
- Produces: `PublishedConfigurationRecord.toolOverrides: ToolOverrideDelta[]` (read from `tool_overrides`); the policy payload is `{ budget, toolPolicies, toolOverrides? }` exactly as in the shared contract; manifest `description` = signed delta description, else the reported one; `toolPolicies.allowedRoles` may be `[]` (absent roles too), malformed roles still 409; `DesiredStateDerivationStore.listToolOverrides` is removed (derivation never reads unsigned decisions); a signed planner that allowlists a tool not bound and enabled fails with `ConflictException('The planner allowlists N tools that are not bound and enabled in this configuration')`; the audit gains `toolOverrideCount`.

Gaps before this task: the manifest description came from the live `runtime_app_setup_tool_overrides` table at deploy time (`runtime-desired-state-derivation.service.ts:259-262`, unsigned until the derived manifest), and `allowedRoles()` threw for empty roles (`:543-558`), although spec 4.5 makes empty roles the default ("es gilt die Autorisierung des Endpunkts").

- [ ] **Step 1: Write the failing tests**

The fixture loses `listToolOverrides` (derivation must not need it) and the published configuration gains `toolOverrides: []`. "fails closed when a tool carries no allowed roles" becomes "accepts a tool without allowed roles" plus a pin that malformed roles still fail; "applies an operator description override over the artifact proposal" becomes "takes a curated description from the signed configuration".

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts b/apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
--- a/apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
+++ b/apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
@@ -46,6 +46,7 @@ function publishedConfiguration() {
       { toolId: endpointToolId, toolRevisionId: endpointRevisionId, tombstone: false },
       { toolId: uiToolId, toolRevisionId: uiRevisionId, tombstone: false },
     ],
+    toolOverrides: [] as Array<{ toolId: string } & Record<string, unknown>>,
     signed: true,
   };
 }
@@ -150,7 +151,6 @@ describe('RuntimeDesiredStateDerivationService', () => {
         .mockResolvedValue(publishedToolRevisions()),
       findPublishedSetupArtifactTools: vi.fn()
         .mockResolvedValue(setupArtifactTools()),
-      listToolOverrides: vi.fn().mockResolvedValue([]),
       findPublishedEnvironmentRevisionByHash: vi.fn().mockResolvedValue(null),
       appendAudit: vi.fn().mockResolvedValue(undefined),
     };
@@ -250,6 +250,9 @@ describe('RuntimeDesiredStateDerivationService', () => {
       },
     ]);
 
+    // Without decisions the policy keeps its pre-delta shape (SDK before P04).
+    expect(policyDraft.payload).not.toHaveProperty('toolOverrides');
+
     expect(revisions.publish).toHaveBeenCalledTimes(2);
     expect(deployments.create).toHaveBeenCalledWith(scope, {
       agentRevisionId: plannerRevisionId,
@@ -401,9 +404,25 @@ describe('RuntimeDesiredStateDerivationService', () => {
     expect(revisions.createDraftSet).not.toHaveBeenCalled();
   });
 
-  it('fails closed when a tool carries no allowed roles', async () => {
+  /** Empty roles mean the endpoint's own authorization applies (spec 4.5). */
+  it('accepts a tool without allowed roles', async () => {
     const artifactTools = setupArtifactTools();
     artifactTools[0].allowedRoles = [];
+    delete artifactTools[1].allowedRoles;
+    store.findPublishedSetupArtifactTools = vi.fn()
+      .mockResolvedValue(artifactTools);
+
+    await service.deployLatestPublished(scope, rollout, actor);
+
+    const [, policyDraft] = revisions.createDraftSet.mock.calls[0][0];
+    expect(policyDraft.payload.toolPolicies.map(
+      (policy: { allowedRoles: string[] }) => policy.allowedRoles,
+    )).toEqual([[], []]);
+  });
+
+  it('still fails closed on malformed allowed roles', async () => {
+    const artifactTools = setupArtifactTools();
+    artifactTools[0].allowedRoles = ['admin', ''];
     store.findPublishedSetupArtifactTools = vi.fn()
       .mockResolvedValue(artifactTools);
     await expect(service.deployLatestPublished(scope, rollout, actor))
@@ -411,6 +430,42 @@ describe('RuntimeDesiredStateDerivationService', () => {
     expect(revisions.createDraftSet).not.toHaveBeenCalled();
   });
 
+  it('signs decisions as deltas and never copies them into the reported policies', async () => {
+    const configuration = publishedConfiguration();
+    configuration.toolOverrides = [
+      { toolId: uiToolId, requiresApproval: true },
+      { toolId: endpointToolId, enabled: false, riskClass: 'write' },
+    ];
+    store.findLatestPublishedConfiguration = vi.fn().mockResolvedValue(configuration);
+
+    await service.deployLatestPublished(scope, rollout, actor);
+
+    const [manifestDraft, policyDraft] = revisions.createDraftSet.mock.calls[0][0];
+    expect(policyDraft.payload.toolOverrides).toEqual([
+      { toolId: endpointToolId, enabled: false, riskClass: 'write' },
+      { toolId: uiToolId, requiresApproval: true },
+    ]);
+    expect(policyDraft.payload.toolPolicies[0]).toMatchObject({
+      enabled: true,
+      riskClass: 'safe-read',
+      requiresApproval: false,
+    });
+    expect(manifestDraft.payload.tools[0]).toMatchObject({
+      enabled: true,
+      riskClass: 'safe-read',
+    });
+  });
+
+  it('refuses a planner that allowlists a tool the code reports disabled', async () => {
+    const toolRevisions = publishedToolRevisions();
+    toolRevisions[1].definition.enabled = false;
+    store.findPublishedToolRevisions = vi.fn().mockResolvedValue(toolRevisions);
+
+    await expect(service.deployLatestPublished(scope, rollout, actor))
+      .rejects.toThrow('The planner allowlists 1 tools');
+    expect(revisions.createDraftSet).not.toHaveBeenCalled();
+  });
+
   it('fails closed on an unknown budget profile', async () => {
     store.findPublishedPlannerRevision = vi.fn().mockResolvedValue({
       id: plannerRevisionId,
@@ -422,10 +477,12 @@ describe('RuntimeDesiredStateDerivationService', () => {
     expect(revisions.createDraftSet).not.toHaveBeenCalled();
   });
 
-  it('applies an operator description override over the artifact proposal', async () => {
-    store.listToolOverrides = vi.fn().mockResolvedValue([
+  it('takes a curated description from the signed configuration', async () => {
+    const configuration = publishedConfiguration();
+    configuration.toolOverrides = [
       { toolId: endpointToolId, description: 'Curated list description.' },
-    ]);
+    ];
+    store.findLatestPublishedConfiguration = vi.fn().mockResolvedValue(configuration);
     await service.deployLatestPublished(scope, rollout, actor);
     const [manifestDraft] = revisions.createDraftSet.mock.calls[0][0];
     expect(manifestDraft.payload.tools[0].description)
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Tests  13 failed | 6 passed (19)`; ten fail with `TypeError: this.store.listToolOverrides is not a function` (the old derivation still reads the live table), the allowlist test gets that TypeError instead of `The planner allowlists 1 tools`, and two fail-closed tests see the TypeError instead of their `ConflictException`.

- [ ] **Step 3: Implement**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts b/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts
--- a/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts
+++ b/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts
@@ -5,7 +5,6 @@ import {
   manifestRevisions,
   runtimeAppSetupArtifacts,
   runtimeAppSetupRuns,
-  runtimeAppSetupToolOverrides,
   runtimeConfigRevisions,
   runtimePolicyRevisions,
   toolRevisions,
@@ -45,6 +44,7 @@ implements DesiredStateDerivationStore {
       promptDigest: configuration.promptDigest,
       setupArtifactDigest: configuration.setupArtifactDigest,
       tools: configuration.tools as PublishedConfigurationRecord['tools'],
+      toolOverrides: configuration.toolOverrides as PublishedConfigurationRecord['toolOverrides'],
       signed: Boolean(configuration.signature && configuration.signingKeyId),
     };
   }
@@ -70,6 +70,7 @@ implements DesiredStateDerivationStore {
       promptDigest: configuration.promptDigest,
       setupArtifactDigest: configuration.setupArtifactDigest,
       tools: configuration.tools as PublishedConfigurationRecord['tools'],
+      toolOverrides: configuration.toolOverrides as PublishedConfigurationRecord['toolOverrides'],
       signed: Boolean(configuration.signature && configuration.signingKeyId),
     };
   }
@@ -147,22 +148,6 @@ implements DesiredStateDerivationStore {
     return tools as Array<Record<string, unknown>>;
   }
 
-  async listToolOverrides(
-    scope: { tenantId: string; targetAppId: string },
-  ): Promise<Array<{ toolId: string; description?: string }>> {
-    const overrides = await this.db.select().from(runtimeAppSetupToolOverrides)
-      .where(and(
-        eq(runtimeAppSetupToolOverrides.tenantId, scope.tenantId),
-        eq(runtimeAppSetupToolOverrides.targetAppId, scope.targetAppId),
-      ));
-    return overrides.map((override) => ({
-      toolId: override.toolId,
-      ...(override.description === null
-        ? {}
-        : { description: override.description }),
-    }));
-  }
-
   async findPublishedEnvironmentRevisionByHash(
     scope: RuntimeDeploymentScope,
     type: 'manifest' | 'policy',
diff --git a/apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts b/apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts
--- a/apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts
+++ b/apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts
@@ -24,6 +24,7 @@ import {
   type RuntimeDeploymentRecord,
   type RuntimeDeploymentScope,
 } from './runtime-deployment.service';
+import { type ToolOverrideDelta } from '../runtime-setup-v2/tool-override';
 
 export const DESIRED_STATE_DERIVATION_STORE = Symbol(
   'DESIRED_STATE_DERIVATION_STORE',
@@ -66,6 +67,8 @@ export interface PublishedConfigurationRecord {
   promptDigest: string;
   setupArtifactDigest: string;
   tools: Array<{ toolId: string; toolRevisionId: string; tombstone: boolean }>;
+  /** Signed Platform decisions of this configuration, sorted by toolId. */
+  toolOverrides: ToolOverrideDelta[];
   signed: boolean;
 }
 
@@ -100,9 +103,6 @@ export interface DesiredStateDerivationStore {
     scope: { tenantId: string; targetAppId: string },
     discoveryDigest: string,
   ): Promise<Array<Record<string, unknown>> | null>;
-  listToolOverrides(
-    scope: { tenantId: string; targetAppId: string },
-  ): Promise<Array<{ toolId: string; description?: string }>>;
   findPublishedEnvironmentRevisionByHash(
     scope: RuntimeDeploymentScope,
     type: 'manifest' | 'policy',
@@ -256,10 +256,14 @@ export class RuntimeDesiredStateDerivationService {
     const artifactByToolId = new Map(
       artifactTools.map((tool) => [String(tool.toolId), tool]),
     );
+    // Only signed decisions reach a runner: they come from the published
+    // configuration, never from the live decision table.
+    const toolOverrides = [...(configuration.toolOverrides ?? [])]
+      .sort((left, right) => left.toolId.localeCompare(right.toolId));
     const overrides = new Map(
-      (await this.store.listToolOverrides(appScope))
-        .map((override) => [override.toolId, override]),
+      toolOverrides.map((override) => [override.toolId, override]),
     );
+    this.assertAllowlistEnabled(planner.definition, revisionsByToolId);
 
     const manifestTools = configuration.tools.map((binding) => {
       const revision = revisionsByToolId.get(binding.toolId)!;
@@ -271,6 +275,9 @@ export class RuntimeDesiredStateDerivationService {
       }
       return this.manifestTool(revision, artifactTool, overrides.get(binding.toolId));
     });
+    // TRANSITIONAL (until SDK P04): what the code reported, so a runner that
+    // still reads full copies keeps working. Platform decisions travel only
+    // as the `toolOverrides` deltas below.
     const toolPolicies = configuration.tools.map((binding) => {
       const revision = revisionsByToolId.get(binding.toolId)!;
       const artifactTool = artifactByToolId.get(binding.toolId)!;
@@ -291,7 +298,13 @@ export class RuntimeDesiredStateDerivationService {
       sourceDigest: configuration.setupArtifactDigest,
       tools: manifestTools,
     };
-    const policyPayload = { budget, toolPolicies };
+    // Absent when empty: a policy without decisions stays byte-identical to
+    // what runners before SDK P04 accept, and its content hash is reused.
+    const policyPayload = {
+      budget,
+      toolPolicies,
+      ...(toolOverrides.length > 0 ? { toolOverrides } : {}),
+    };
 
     const [manifest, policy] = await this.resolveEnvironmentRevisions(
       scope,
@@ -325,6 +338,7 @@ export class RuntimeDesiredStateDerivationService {
         reusedManifest: manifest.reused,
         reusedPolicy: policy.reused,
         toolCount: manifestTools.length,
+        toolOverrideCount: toolOverrides.length,
       },
     });
 
@@ -452,10 +466,32 @@ export class RuntimeDesiredStateDerivationService {
       + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
   }
 
+  /**
+   * A runner refuses a deployment whose planner allowlists a tool the code
+   * reports disabled; failing here names the problem instead.
+   */
+  private assertAllowlistEnabled(
+    plannerDefinition: Record<string, unknown>,
+    revisionsByToolId: Map<string, PublishedToolRevisionRecord>,
+  ): void {
+    const allowlist = Array.isArray(plannerDefinition.toolAllowlist)
+      ? plannerDefinition.toolAllowlist
+      : [];
+    const disabled = allowlist.filter((toolId) => (
+      revisionsByToolId.get(String(toolId))?.definition.enabled !== true
+    ));
+    if (disabled.length > 0) {
+      throw new ConflictException(
+        `The planner allowlists ${disabled.length} tools that are not bound `
+        + 'and enabled in this configuration',
+      );
+    }
+  }
+
   private manifestTool(
     revision: PublishedToolRevisionRecord,
     artifactTool: Record<string, unknown>,
-    override: { description?: string } | undefined,
+    override: ToolOverrideDelta | undefined,
   ): Record<string, unknown> {
     const definition = revision.definition;
     const executionKind = this.stringField(
@@ -541,18 +577,22 @@ export class RuntimeDesiredStateDerivationService {
     return budget;
   }
 
+  /**
+   * Empty or absent roles are valid (spec 4.5): the endpoint's own
+   * authorization applies. Only a malformed list fails closed.
+   */
   private allowedRoles(
     artifactTool: Record<string, unknown>,
     toolId: string,
   ): string[] {
     const roles = artifactTool.allowedRoles;
+    if (roles === undefined) return [];
     if (
       !Array.isArray(roles)
-      || roles.length === 0
       || roles.some((role) => typeof role !== 'string' || role.length === 0)
     ) {
       throw new ConflictException(
-        `Tool ${toolId} carries no allowed roles in the setup artifact`,
+        `Tool ${toolId} carries malformed allowed roles in the setup artifact`,
       );
     }
     return roles;
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-revisions src/modules/runtime-deployments 2>&1 | grep -E "Test Files|Tests "
grep -rn "listToolOverrides" src/modules/runtime-deployments | wc -l
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Tests  19 passed (19)`; `Test Files  25 passed (25)`, `Tests  325 passed (325)`; `0`; `Test Files  117 passed (117)`, `Tests  1232 passed | 10 skipped (1242)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
git commit -m "feat(runtime-deployments): derive signed tool override deltas"
```

---
### Task 6: API – require security approval only for loosening changes

**Files:**
- Modify: `apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts:1,133-144`; `apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts:225`
- Test: `apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts`

**Interfaces:**
- Consumes: Task 3's `classifyToolPolicyChange`, Task 2's `riskTier`, `TOOL_RISK_CLASSES`, `type ToolPolicyEntry`.
- Produces: `isSecurityCriticalChange(revisionType, previous, current): boolean`, same signature, now by type:
  - `tool`: no previous revision → critical only below the confirmation default (`requiresApproval !== true` at tier ≥ 2); otherwise critical when `riskClass`/`requiresApproval`/`enabled`/`allowedRoles` loosen or any other security field (method, path, schema digests, auth binding) changes.
  - `manifest`: tools compared by `toolId`; added or removed tools are not critical; for a kept tool the same direction rule plus the generic rule; top-level fields keep the generic rule.
  - `policy`: `budget` and other top-level fields generic; `toolPolicies` by `toolId` (new entry critical only below the confirmation default); `toolOverrides` by `toolId` through `classifyToolPolicyChange`.
  - `config`: a changed binding of an existing `toolId` stays critical; `plannerRevisionId`/`runtimeDigest` changes stay critical unless tools were added or removed in the same revision; `toolOverrides` by direction.
  - `agent`: `toolAllowlist` is not compared (the code-enabled allowlist follows the tools), every other planner field keeps the generic rule.
  - every other type (`prompt`): the generic rule, unchanged.
  The generic rule is the old function, applied with ignored top-level keys.

Every existing classification test keeps its expectation: a tool description change stays normal, a method change, a model alias change and a role change (`viewer` → `admin`) stay critical, a changed runtime digest, planner or tool binding alone stays critical, a prompt-only change stays normal.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts b/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
--- a/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
@@ -223,4 +223,152 @@ describe('runtime publication policy', () => {
       },
     )).toBe(false);
   });
+
+  describe('direction-aware security approval', () => {
+    const TOOL = '019fb001-0000-7000-8000-000000000006';
+    const OTHER = '019fb001-0000-7000-8000-000000000007';
+    const tool = (overrides: Record<string, unknown> = {}) => ({
+      schemaVersion: 1,
+      executionKind: 'endpoint',
+      name: 'tasks.update',
+      operationGroup: 'update',
+      riskClass: 'write',
+      enabled: true,
+      requiresApproval: true,
+      inputSchemaDigest: 'sha256:input',
+      outputSchemaDigest: 'sha256:output',
+      ...overrides,
+    });
+
+    it('lets a new tool at its confirmation default through without approval', () => {
+      expect(isSecurityCriticalChange('tool', null, tool())).toBe(false);
+      expect(isSecurityCriticalChange('tool', null, tool({
+        riskClass: 'safe-read',
+        requiresApproval: false,
+      }))).toBe(false);
+      expect(isSecurityCriticalChange('tool', null, tool({
+        requiresApproval: false,
+      }))).toBe(true);
+    });
+
+    it('treats hardening a tool as normal and loosening it as critical', () => {
+      expect(isSecurityCriticalChange('tool', tool(), tool({ riskClass: 'delete' })))
+        .toBe(false);
+      expect(isSecurityCriticalChange('tool', tool(), tool({ enabled: false })))
+        .toBe(false);
+      expect(isSecurityCriticalChange('tool', tool({ riskClass: 'delete' }), tool()))
+        .toBe(true);
+      expect(isSecurityCriticalChange('tool', tool(), tool({ requiresApproval: false })))
+        .toBe(true);
+      expect(isSecurityCriticalChange('tool', tool({ enabled: false }), tool()))
+        .toBe(true);
+      // Identity and schema stay critical whatever the direction.
+      expect(isSecurityCriticalChange('tool', tool(), tool({ inputSchemaDigest: 'sha256:other' })))
+        .toBe(true);
+    });
+
+    it('needs approval only for policy-only revisions that loosen a decision', () => {
+      const base = {
+        schemaVersion: 1,
+        runtimeDigest: 'sha256:runtime-1',
+        promptDigest: 'sha256:prompt-1',
+        promptRevisionId: 'prompt-1',
+        plannerRevisionId: 'planner-1',
+        tools: [{ toolId: TOOL, toolRevisionId: 'tool-revision-1', tombstone: false }],
+      };
+      const disabled = { ...base, toolOverrides: [{ toolId: TOOL, enabled: false }] };
+
+      expect(isSecurityCriticalChange('config', base, disabled)).toBe(false);
+      expect(isSecurityCriticalChange('config', disabled, base)).toBe(true);
+      expect(isSecurityCriticalChange('config', base, {
+        ...base,
+        toolOverrides: [{
+          toolId: TOOL,
+          requiresApproval: false,
+          pin: { toolId: TOOL, atRiskClass: 'write' },
+        }],
+      })).toBe(true);
+    });
+
+    it('lets new tool bindings change the planner and runtime digest', () => {
+      const base = {
+        schemaVersion: 1,
+        runtimeDigest: 'sha256:runtime-1',
+        promptDigest: 'sha256:prompt-1',
+        promptRevisionId: 'prompt-1',
+        plannerRevisionId: 'planner-1',
+        tools: [{ toolId: TOOL, toolRevisionId: 'tool-revision-1', tombstone: false }],
+      };
+
+      expect(isSecurityCriticalChange('config', base, {
+        ...base,
+        runtimeDigest: 'sha256:runtime-2',
+        plannerRevisionId: 'planner-2',
+        tools: [
+          ...base.tools,
+          { toolId: OTHER, toolRevisionId: 'tool-revision-9', tombstone: false },
+        ],
+      })).toBe(false);
+      expect(isSecurityCriticalChange('agent',
+        { plannerId: 'p', toolAllowlist: [TOOL] },
+        { plannerId: 'p', toolAllowlist: [TOOL, OTHER] },
+      )).toBe(false);
+    });
+
+    it('classifies derived policies per tool and keeps budget changes critical', () => {
+      const policy = (overrides: Record<string, unknown> = {}) => ({
+        budget: { maxToolCalls: 24 },
+        toolPolicies: [{
+          toolId: TOOL,
+          enabled: true,
+          riskClass: 'write',
+          requiresApproval: true,
+          allowedRoles: [],
+        }],
+        ...overrides,
+      });
+
+      expect(isSecurityCriticalChange('policy', policy(), policy({
+        toolOverrides: [{ toolId: TOOL, allowedRoles: ['admin'] }],
+      }))).toBe(false);
+      expect(isSecurityCriticalChange('policy', policy({
+        toolOverrides: [{ toolId: TOOL, allowedRoles: ['admin'] }],
+      }), policy())).toBe(true);
+      expect(isSecurityCriticalChange('policy', policy(), policy({
+        toolPolicies: [
+          ...policy().toolPolicies,
+          { toolId: OTHER, enabled: true, riskClass: 'delete', requiresApproval: true, allowedRoles: [] },
+        ],
+      }))).toBe(false);
+      expect(isSecurityCriticalChange('policy', policy(), policy({
+        budget: { maxToolCalls: 48 },
+      }))).toBe(true);
+    });
+
+    it('lets a manifest gain tools but keeps a changed route critical', () => {
+      const manifest = (tools: Array<Record<string, unknown>>) => ({
+        sourceDigest: 'sha256:source',
+        tools,
+      });
+      const entry = {
+        toolId: TOOL,
+        riskClass: 'write',
+        enabled: true,
+        method: 'PATCH',
+        path: '/api/tasks/[id]',
+        description: 'Updates a task.',
+      };
+
+      expect(isSecurityCriticalChange('manifest', manifest([entry]), manifest([
+        entry,
+        { ...entry, toolId: OTHER, method: 'GET', riskClass: 'safe-read' },
+      ]))).toBe(false);
+      expect(isSecurityCriticalChange('manifest', manifest([entry]), manifest([
+        { ...entry, description: 'Changes a task.' },
+      ]))).toBe(false);
+      expect(isSecurityCriticalChange('manifest', manifest([entry]), manifest([
+        { ...entry, path: '/api/admin/tasks/[id]' },
+      ]))).toBe(true);
+    });
+  });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: `Tests  6 failed | 12 passed (18)`, every test of "direction-aware security approval" fails (today any change of a sensitive value, a new tool included, is critical).

- [ ] **Step 3: Implement**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts b/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts
--- a/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts
+++ b/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts
@@ -1,4 +1,13 @@
 import { ForbiddenException } from '@nestjs/common';
+import {
+  classifyToolPolicyChange,
+} from '../runtime-setup-v2/tool-override';
+import {
+  riskTier,
+  TOOL_RISK_CLASSES,
+  type ToolPolicyEntry,
+  type ToolRiskClass,
+} from '../runtime-setup-v2/tool-policy';
 
 export type RevisionApproval = {
   kind: 'publisher' | 'security';
@@ -130,19 +139,237 @@ export function assertControlPlaneSafe(value: unknown): void {
   visitControlPlaneValue(value, '$', new WeakSet<object>());
 }
 
+/**
+ * Direction-aware publication gate (spec 4.10, item 5). A loosening needs a
+ * recorded security approval; a pure hardening and a new tool at its code
+ * defaults do not. Policy fields (risk class, confirmation, enabled, roles)
+ * are compared by direction per tool; every other security-relevant field
+ * (method, path, digests, bindings, model, budget, ...) stays critical on
+ * any change, exactly as before.
+ */
 export function isSecurityCriticalChange(
-  _revisionType: string,
+  revisionType: string,
   previous: unknown,
   current: unknown,
+): boolean {
+  switch (revisionType) {
+    case 'tool':
+      return toolRevisionIsCritical(previous, current);
+    case 'manifest':
+      return manifestIsCritical(previous, current);
+    case 'policy':
+      return policyIsCritical(previous, current);
+    case 'config':
+      return configurationIsCritical(previous, current);
+    case 'agent':
+      return agentIsCritical(previous, current);
+    default:
+      return anySecurityValueChanged(previous, current);
+  }
+}
+
+/** Fields whose direction decides criticality; normalized key names. */
+const POLICY_FIELDS = new Set([
+  'riskclass',
+  'requiresapproval',
+  'enabled',
+  'allowedroles',
+]);
+
+function toolRevisionIsCritical(previous: unknown, current: unknown): boolean {
+  const after = asRecord(current);
+  if (previous === null || previous === undefined) {
+    return !atConfirmationDefault(after);
+  }
+  const before = asRecord(previous);
+  return policyValuesLoosen(before, after)
+    || anySecurityValueChanged(before, after, POLICY_FIELDS);
+}
+
+function manifestIsCritical(previous: unknown, current: unknown): boolean {
+  const before = asRecord(previous);
+  const after = asRecord(current);
+  if (anySecurityValueChanged(before, after, new Set(['tools']))) return true;
+  return someKeyedEntry(before.tools, after.tools, (old, next) => {
+    // A new tool's confirmation is decided by its policy; a removed tool can
+    // no longer run.
+    if (!old || !next) return false;
+    return policyValuesLoosen(old, next)
+      || anySecurityValueChanged(old, next, POLICY_FIELDS);
+  });
+}
+
+function policyIsCritical(previous: unknown, current: unknown): boolean {
+  const before = asRecord(previous);
+  const after = asRecord(current);
+  if (anySecurityValueChanged(
+    before,
+    after,
+    new Set(['toolpolicies', 'tooloverrides']),
+  )) return true;
+  if (someKeyedEntry(before.toolPolicies, after.toolPolicies, (old, next) => {
+    if (!next) return false;
+    if (!old) return !atConfirmationDefault(next);
+    return policyValuesLoosen(old, next)
+      || anySecurityValueChanged(old, next, POLICY_FIELDS);
+  })) return true;
+  return deltasLoosen(before.toolOverrides, after.toolOverrides);
+}
+
+/**
+ * Bindings of existing tools stay critical when they change. New tool
+ * bindings (and the planner and runtime digest that change with them) are
+ * not: each new tool revision passes this gate itself, and an allowlist can
+ * never enable a tool its revision or a signed decision disables.
+ */
+function configurationIsCritical(previous: unknown, current: unknown): boolean {
+  const before = asRecord(previous);
+  const after = asRecord(current);
+  if (anySecurityValueChanged(
+    before,
+    after,
+    new Set(['tools', 'tooloverrides', 'runtimedigest', 'plannerrevisionid']),
+  )) return true;
+  let addedOrRemoved = false;
+  const rebound = someKeyedEntry(before.tools, after.tools, (old, next) => {
+    if (!old || !next) {
+      addedOrRemoved = true;
+      return false;
+    }
+    return stablePolicyValue(old) !== stablePolicyValue(next);
+  });
+  if (rebound) return true;
+  const runtimeRebound = before.plannerRevisionId !== after.plannerRevisionId
+    || before.runtimeDigest !== after.runtimeDigest;
+  if (runtimeRebound && !addedOrRemoved) return true;
+  return deltasLoosen(before.toolOverrides, after.toolOverrides);
+}
+
+/**
+ * The allowlist follows the tools the code reports enabled; adding a new tool
+ * to it is not a loosening (spec 4.5: new tools are active at defaults).
+ * Model, budget, and every other planner field keep the generic rule.
+ */
+function agentIsCritical(previous: unknown, current: unknown): boolean {
+  return anySecurityValueChanged(
+    asRecord(previous),
+    asRecord(current),
+    new Set(['toolallowlist']),
+  );
+}
+
+function deltasLoosen(previous: unknown, current: unknown): boolean {
+  return someKeyedEntry(previous, current, (old, next) => (
+    classifyToolPolicyChange(policyEntry(old), policyEntry(next)) === 'loosening'
+  ));
+}
+
+function policyValuesLoosen(
+  previous: Record<string, unknown>,
+  current: Record<string, unknown>,
+): boolean {
+  return classifyToolPolicyChange(
+    policyEntry(previous),
+    policyEntry(current),
+  ) === 'loosening';
+}
+
+/** Confirmation at or above the code default: tier 2 and up always asks. */
+function atConfirmationDefault(tool: Record<string, unknown>): boolean {
+  return tool.requiresApproval === true
+    || riskTier(knownRiskClass(tool.riskClass)) < 2;
+}
+
+function knownRiskClass(value: unknown): ToolRiskClass {
+  return typeof value === 'string'
+    && (TOOL_RISK_CLASSES as readonly string[]).includes(value)
+    ? value as ToolRiskClass
+    : 'unknown';
+}
+
+function policyEntry(
+  value: Record<string, unknown> | undefined,
+): ToolPolicyEntry | undefined {
+  if (!value) return undefined;
+  const entry: ToolPolicyEntry = {};
+  if (typeof value.enabled === 'boolean') entry.enabled = value.enabled;
+  if (typeof value.requiresApproval === 'boolean') {
+    entry.requiresApproval = value.requiresApproval;
+  }
+  if (value.riskClass !== undefined) entry.riskClass = knownRiskClass(value.riskClass);
+  if (Array.isArray(value.allowedRoles)) {
+    entry.allowedRoles = value.allowedRoles.map(String);
+  }
+  const pin = asRecord(value.pin);
+  if (typeof pin.toolId === 'string') {
+    entry.pin = { toolId: pin.toolId, atRiskClass: knownRiskClass(pin.atRiskClass) };
+  }
+  return entry;
+}
+
+/** Compares two arrays of `{ toolId }` records entry by entry. */
+function someKeyedEntry(
+  previous: unknown,
+  current: unknown,
+  changed: (
+    old: Record<string, unknown> | undefined,
+    next: Record<string, unknown> | undefined,
+  ) => boolean,
+): boolean {
+  const before = keyedByToolId(previous);
+  const after = keyedByToolId(current);
+  if (!before || !after) return stablePolicyValue(previous) !== stablePolicyValue(current);
+  let result = false;
+  for (const toolId of new Set([...before.keys(), ...after.keys()])) {
+    if (changed(before.get(toolId), after.get(toolId))) result = true;
+  }
+  return result;
+}
+
+/** null for anything but an array of records with unique string toolIds. */
+function keyedByToolId(
+  value: unknown,
+): Map<string, Record<string, unknown>> | null {
+  if (value === undefined || value === null) return new Map();
+  if (!Array.isArray(value)) return null;
+  const keyed = new Map<string, Record<string, unknown>>();
+  for (const item of value) {
+    const record = asRecord(item);
+    if (typeof record.toolId !== 'string' || keyed.has(record.toolId)) return null;
+    keyed.set(record.toolId, record);
+  }
+  return keyed;
+}
+
+function asRecord(value: unknown): Record<string, unknown> {
+  return value !== null && typeof value === 'object' && !Array.isArray(value)
+    ? value as Record<string, unknown>
+    : {};
+}
+
+/** The previous rule: any change of a security-sensitive value is critical. */
+function anySecurityValueChanged(
+  previous: unknown,
+  current: unknown,
+  ignoredTopLevelKeys: ReadonlySet<string> = new Set(),
 ): boolean {
   const before = new Map<string, string>();
   const after = new Map<string, string>();
-  collectSecurityValues(previous, '$', before);
-  collectSecurityValues(current, '$', after);
+  collectSecurityValues(withoutKeys(previous, ignoredTopLevelKeys), '$', before);
+  collectSecurityValues(withoutKeys(current, ignoredTopLevelKeys), '$', after);
   const paths = new Set([...before.keys(), ...after.keys()]);
   return [...paths].some((path) => before.get(path) !== after.get(path));
 }
 
+function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
+  if (keys.size === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) {
+    return value;
+  }
+  return Object.fromEntries(Object.entries(value).filter(([key]) => (
+    !keys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
+  )));
+}
+
 function visitControlPlaneValue(
   value: unknown,
   path: string,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts 2>&1 | grep -E "Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-revisions src/modules/runtime-deployments 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Tests  18 passed (18)`; `Test Files  25 passed (25)`, `Tests  331 passed (331)`; `Test Files  117 passed (117)`, `Tests  1238 passed | 10 skipped (1248)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
git commit -m "feat(runtime-revisions): require security approval only for loosening"
```

---

### Task 7: API – enforce the policy bounds on every revision draft

**Files:**
- Modify: `apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts:1,7,372`; `apps/api/src/modules/runtime-revisions/runtime-revision.service.ts:22,644`; `apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts:7,373`; `apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts:1-3,79`
- Test: both specs

**Interfaces:**
- Consumes: Task 2's `ToolPolicyEntrySchema`, `riskTier`.
- Produces: `interface PolicyBoundViolation { toolId?; field; reason: 'invalid-entry'|'cannot-enable-disabled-tool'|'relaxation-requires-reviewed-pin'|'tier-3-always-requires-approval' }`, `findPolicyBoundViolation(revisionType, payload): PolicyBoundViolation | null`, `assertRevisionWithinPolicyBounds(revisionType, payload)` (422 `{ code: 'tool_override_out_of_bounds', …violation }`). `RuntimeRevisionService.prepareDraft` calls it after `assertControlPlaneSafe`, so `POST /v1/apps/:appId/runtime-revisions/:type` (`runtime-revision.controller.ts:138`), every composite and the derivation share it. Rules: `tool` and every `policy.toolPolicies[i]` at tier 3 must confirm; `policy`/`config` `toolOverrides` must be an array of unique `{ toolId }` + strict entries, never `enabled: true`, and a `requiresApproval: false` must carry `pin.toolId === toolId` with `pin.atRiskClass` and `riskClass` below tier 3.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts b/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
--- a/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts
@@ -5,6 +5,7 @@ import {
   assertPublicationAllowed,
   canPublish,
   canSecurityApprove,
+  findPolicyBoundViolation,
   isSecurityCriticalChange,
 } from '../runtime-publication-policy';
 
@@ -371,4 +372,56 @@ describe('runtime publication policy', () => {
       ]))).toBe(true);
     });
   });
+
+  describe('bounds every revision payload keeps', () => {
+    const TOOL = '019fb001-0000-7000-8000-000000000006';
+
+    it('accepts restricting deltas and a pinned tier-2 relaxation', () => {
+      expect(findPolicyBoundViolation('config', {
+        toolOverrides: [
+          { toolId: TOOL, enabled: false, riskClass: 'delete', allowedRoles: ['admin'] },
+          {
+            toolId: '019fb001-0000-7000-8000-000000000007',
+            requiresApproval: false,
+            pin: { toolId: '019fb001-0000-7000-8000-000000000007', atRiskClass: 'write' },
+          },
+        ],
+      })).toBeNull();
+      expect(findPolicyBoundViolation('prompt', { toolOverrides: 'ignored' })).toBeNull();
+    });
+
+    it.each([
+      ['a delta that enables', { toolOverrides: [{ toolId: TOOL, enabled: true }] },
+        'cannot-enable-disabled-tool'],
+      ['a relaxation pinned to another tool', { toolOverrides: [{
+        toolId: TOOL,
+        requiresApproval: false,
+        pin: { toolId: '019fb001-0000-7000-8000-000000000007', atRiskClass: 'write' },
+      }] }, 'relaxation-requires-reviewed-pin'],
+      ['a relaxation pinned at tier 3', { toolOverrides: [{
+        toolId: TOOL,
+        requiresApproval: false,
+        pin: { toolId: TOOL, atRiskClass: 'delete' },
+      }] }, 'tier-3-always-requires-approval'],
+      ['a duplicate tool', { toolOverrides: [
+        { toolId: TOOL, enabled: false },
+        { toolId: TOOL, requiresApproval: true },
+      ] }, 'invalid-entry'],
+      ['an unknown field', { toolOverrides: [{ toolId: TOOL, sourceFingerprint: 'x' }] },
+        'invalid-entry'],
+    ])('refuses %s', (_name, payload, reason) => {
+      expect(findPolicyBoundViolation('policy', payload)?.reason).toBe(reason);
+    });
+
+    it('keeps the tier-3 confirmation floor on tool revisions', () => {
+      expect(findPolicyBoundViolation('tool', {
+        riskClass: 'external',
+        requiresApproval: false,
+      })?.reason).toBe('tier-3-always-requires-approval');
+      expect(findPolicyBoundViolation('tool', {
+        riskClass: 'write',
+        requiresApproval: false,
+      })).toBeNull();
+    });
+  });
 });
diff --git a/apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts b/apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts
--- a/apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts
@@ -1,6 +1,10 @@
-import { ForbiddenException } from '@nestjs/common';
+import {
+  ForbiddenException,
+  UnprocessableEntityException,
+} from '@nestjs/common';
 import { describe, expect, it, vi } from 'vitest';
 import { RuntimeRevisionController } from '../runtime-revision.controller';
+import { RuntimeRevisionService } from '../runtime-revision.service';
 
 describe('RuntimeRevisionController', () => {
   it('does not accept an API key as a human publisher identity', async () => {
@@ -77,4 +81,65 @@ describe('RuntimeRevisionController', () => {
       );
     },
   );
+
+  /** The generic endpoint keeps the bounds the override API enforces. */
+  it.each([
+    ['policy', {
+      budget: { maxToolCalls: 24 },
+      toolPolicies: [],
+      toolOverrides: [{
+        toolId: '019fb001-0000-7000-8000-000000000006',
+        requiresApproval: false,
+      }],
+    }, 'relaxation-requires-reviewed-pin'],
+    ['policy', {
+      budget: { maxToolCalls: 24 },
+      toolPolicies: [{
+        toolId: '019fb001-0000-7000-8000-000000000006',
+        enabled: true,
+        riskClass: 'delete',
+        requiresApproval: false,
+        allowedRoles: [],
+      }],
+    }, 'tier-3-always-requires-approval'],
+    ['config', {
+      schemaVersion: 1,
+      toolOverrides: [{ toolId: '019fb001-0000-7000-8000-000000000006', enabled: true }],
+    }, 'cannot-enable-disabled-tool'],
+  ])('refuses an out-of-bounds %s draft with 422 before storing it', async (
+    type,
+    payload,
+    reason,
+  ) => {
+    const store = { createDraft: vi.fn(), appendAudit: vi.fn() };
+    const controller = new RuntimeRevisionController(
+      new RuntimeRevisionService(store as never, {} as never),
+    );
+
+    const attempt = controller.createDraft(
+      {
+        id: 'tenant-1',
+        slug: 'acme',
+        plan: 'pro',
+        status: 'active',
+        scopes: ['management'],
+        userId: 'editor-1',
+        memberRole: 'editor',
+      },
+      'app-1',
+      type,
+      {
+        ...(type === 'policy'
+          ? { environmentId: '019fb001-0000-7000-8000-000000000003' }
+          : {}),
+        payload,
+      },
+    );
+
+    await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
+    await expect(attempt).rejects.toMatchObject({
+      response: { code: 'tool_override_out_of_bounds', reason },
+    });
+    expect(store.createDraft).not.toHaveBeenCalled();
+  });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  2 failed (2)`, `Tests  10 failed | 22 passed (32)`: the seven "bounds every revision payload keeps" tests (`findPolicyBoundViolation is not a function`) and the three controller cases (the draft goes on to `store.createDraft` instead of being refused with 422).

- [ ] **Step 3: Implement**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts b/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts
--- a/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts
+++ b/apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts
@@ -1,10 +1,14 @@
-import { ForbiddenException } from '@nestjs/common';
+import {
+  ForbiddenException,
+  UnprocessableEntityException,
+} from '@nestjs/common';
 import {
   classifyToolPolicyChange,
 } from '../runtime-setup-v2/tool-override';
 import {
   riskTier,
   TOOL_RISK_CLASSES,
+  ToolPolicyEntrySchema,
   type ToolPolicyEntry,
   type ToolRiskClass,
 } from '../runtime-setup-v2/tool-policy';
@@ -370,6 +374,112 @@ function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
   )));
 }
 
+export interface PolicyBoundViolation {
+  toolId?: string;
+  field: string;
+  reason:
+    | 'invalid-entry'
+    | 'cannot-enable-disabled-tool'
+    | 'relaxation-requires-reviewed-pin'
+    | 'tier-3-always-requires-approval';
+}
+
+/**
+ * The bounds every revision payload must keep, whoever drafts it (the
+ * generic revision endpoint included): tier 3 always confirms, a signed
+ * decision delta only restricts, and a relaxation of confirmation is pinned
+ * to its own tool at tier 2 or below. Answered with 422 and the reason code.
+ */
+export function assertRevisionWithinPolicyBounds(
+  revisionType: string,
+  payload: unknown,
+): void {
+  const violation = findPolicyBoundViolation(revisionType, payload);
+  if (violation) {
+    throw new UnprocessableEntityException({
+      code: 'tool_override_out_of_bounds',
+      ...violation,
+    });
+  }
+}
+
+export function findPolicyBoundViolation(
+  revisionType: string,
+  payload: unknown,
+): PolicyBoundViolation | null {
+  const record = asRecord(payload);
+  if (revisionType === 'tool') return confirmationFloorViolation(record, 'riskClass');
+  if (revisionType === 'policy' && Array.isArray(record.toolPolicies)) {
+    for (const [index, policy] of record.toolPolicies.entries()) {
+      const violation = confirmationFloorViolation(
+        asRecord(policy),
+        `toolPolicies.${index}.riskClass`,
+      );
+      if (violation) return violation;
+    }
+  }
+  if (
+    (revisionType === 'policy' || revisionType === 'config')
+    && record.toolOverrides !== undefined
+  ) {
+    return deltaViolation(record.toolOverrides);
+  }
+  return null;
+}
+
+function confirmationFloorViolation(
+  value: Record<string, unknown>,
+  field: string,
+): PolicyBoundViolation | null {
+  if (value.riskClass === undefined || value.requiresApproval !== false) return null;
+  return riskTier(knownRiskClass(value.riskClass)) >= 3
+    ? {
+      ...(typeof value.toolId === 'string' ? { toolId: value.toolId } : {}),
+      field,
+      reason: 'tier-3-always-requires-approval',
+    }
+    : null;
+}
+
+function deltaViolation(value: unknown): PolicyBoundViolation | null {
+  if (!Array.isArray(value)) {
+    return { field: 'toolOverrides', reason: 'invalid-entry' };
+  }
+  const seen = new Set<string>();
+  for (const [index, raw] of value.entries()) {
+    const { toolId, ...rest } = asRecord(raw);
+    const field = `toolOverrides.${index}`;
+    const parsed = ToolPolicyEntrySchema.safeParse(rest);
+    if (typeof toolId !== 'string' || seen.has(toolId) || !parsed.success) {
+      return { field, reason: 'invalid-entry' };
+    }
+    seen.add(toolId);
+    const entry = parsed.data;
+    if (entry.enabled === true) {
+      return { toolId, field: `${field}.enabled`, reason: 'cannot-enable-disabled-tool' };
+    }
+    if (entry.requiresApproval !== false) continue;
+    if (!entry.pin || entry.pin.toolId !== toolId) {
+      return {
+        toolId,
+        field: `${field}.requiresApproval`,
+        reason: 'relaxation-requires-reviewed-pin',
+      };
+    }
+    if (
+      riskTier(entry.pin.atRiskClass) >= 3
+      || (entry.riskClass !== undefined && riskTier(entry.riskClass) >= 3)
+    ) {
+      return {
+        toolId,
+        field: `${field}.requiresApproval`,
+        reason: 'tier-3-always-requires-approval',
+      };
+    }
+  }
+  return null;
+}
+
 function visitControlPlaneValue(
   value: unknown,
   path: string,
diff --git a/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts b/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts
--- a/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts
+++ b/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts
@@ -20,6 +20,7 @@ import {
 import {
   assertControlPlaneSafe,
   assertPublicationAllowed,
+  assertRevisionWithinPolicyBounds,
   canPublish,
   canSecurityApprove,
   isSecurityCriticalChange,
@@ -642,6 +643,7 @@ export class RuntimeRevisionService {
     }
     this.validateDraftIdentity(input);
     assertControlPlaneSafe(input.payload);
+    assertRevisionWithinPolicyBounds(input.type, input.payload);
     return {
       ...input,
       contentHash: `sha256:${createHash('sha256')
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  32 passed (32)`; `Test Files  117 passed (117)`, `Tests  1248 passed | 10 skipped (1258)` (no existing fixture drafts an out-of-bounds payload); `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-revisions/runtime-publication-policy.ts apps/api/src/modules/runtime-revisions/runtime-revision.service.ts apps/api/src/modules/runtime-revisions/__tests__/runtime-publication-policy.spec.ts apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.controller.spec.ts
git commit -m "feat(runtime-revisions): enforce policy bounds on every revision draft"
```

---

### Task 8: API – draft and apply a policy-only revision for saved decisions

**Files:**
- Create: `apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts`, `apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts`
- Modify: `apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts:15`; `publish-and-deploy.service.ts:4,29,166-207`; `runtime-setup-v2.controller.ts:35,46,61,112-136`; `runtime-setup-v2.module.ts:14,29`; `apps/api/src/modules/runtime-revisions/runtime-revision.service.ts:599`; `apps/api/src/modules/runtime-deployments/runtime-deployment.module.ts:35`; specs `publish-and-deploy.service.spec.ts:1-4,63,394`, `runtime-setup-v2.controller.spec.ts:85-89,430,451,478,488`, `runtime-setup-v2.routes.spec.ts:55`
- Test: the four specs

**Interfaces:**
- Consumes: Task 4's `createPolicyOnlyRevision` and `policyOnlyRevisionId`, Task 3's `boundToolOverrideDeltas`/`reportedToolPolicy`, Task 5's `PublishedConfigurationRecord.toolOverrides`, the existing `publishBatchResumable`, `deployPublishedConfiguration`, `RuntimeDeploymentService.activate` (health gate plus revocation of what the previous deployment pinned).
- Produces:
  - `configurationPublicationId(configurationRevisionId)`, `configurationApplyId(configurationRevisionId, environmentId)` (deterministic UUIDs like `publishAndDeployId`).
  - `RuntimeRevisionService.findStatus(scope): Promise<string | null>`.
  - `ToolPolicyRevisionService.draft(scope, actor): Promise<{ configurationRevisionId; created } | null>`: null before the first signed publication; otherwise bounds every stored decision with Task 3's `boundToolOverrideDeltas` against the tools of the latest published configuration (a tool only a capability report knows is bounded by its saved baseline), and drafts a policy-only configuration unless the base already signs exactly these deltas.
  - `ToolPolicyRevisionService.target(scope): Promise<PolicyRevisionTarget | null>` with `type PolicyRevisionTarget = { kind: 'unpublished-decisions' } | { kind: 'published'; configurationRevisionId } | { kind: 'policy-only'; configurationRevisionId }`: the same computation, read-only; the policy-only id comes from Task 4's `policyOnlyRevisionId`. Task 11 reads the pending change from it, never from "the newest draft" (a draft left behind by a decision that was changed back must never be applied).
  - `PublishAndDeployService.applyConfiguration(appScope, configurationRevisionId, { environmentId, reason }, actor): Promise<PublishAndDeployResult>`: publisher plus security-approver capability as for Publish & Deploy; publishes the draft under `configurationPublicationId` (owner/admin self-approve a loosening like the composite does; a hardening needs no approval after Task 6), derives with `deploymentId = configurationApplyId`, then the shared health gate (`settle`): `awaiting_health` until the runner reports healthy, then `activate`. The run composite's tail is moved into the same `settle` without behaviour change.
  - `PATCH /v2/apps/:appId/runtime-setup/runs/:runId/tools/:toolId` returns `{ ...setup, policyRevision }`; new `POST /v2/apps/:appId/runtime-setup/configurations/:configurationRevisionId/apply` with `{ environmentId }` (dashboard user, server-owned reason `Platform decision apply`).
  - `RuntimeDeploymentModule` exports `DESIRED_STATE_DERIVATION_STORE`.

- [ ] **Step 1: Write the failing tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { policyOnlyRevisionId } from '../../runtime-revisions/app-configuration.service';
import { ToolPolicyRevisionService } from '../tool-policy-revision.service';

const scope = {
  tenantId: '019fb300-0000-7000-8000-000000000001',
  targetAppId: '019fb300-0000-7000-8000-000000000002',
};
const actor = { userId: 'editor-1', role: 'editor' };
const TOOL_A = '019fb300-0000-7000-8000-00000000000a';
const TOOL_B = '019fb300-0000-7000-8000-00000000000b';
const NEW_TOOL = '019fb300-0000-7000-8000-00000000000c';

const base = {
  id: 'config-1',
  promptRevisionId: 'prompt-1',
  plannerRevisionId: 'planner-1',
  runtimeDigest: 'sha256:runtime',
  promptDigest: 'sha256:prompt',
  setupArtifactDigest: 'sha256:discovery',
  tools: [
    { toolId: TOOL_A, toolRevisionId: 'tool-revision-a', tombstone: false },
    { toolId: TOOL_B, toolRevisionId: 'tool-revision-b', tombstone: false },
  ],
  toolOverrides: [] as Array<{ toolId: string } & Record<string, unknown>>,
  signed: true,
};
const artifactTools = [
  { toolId: TOOL_A, riskClass: 'write', requiresApproval: true, enabled: true },
  { toolId: TOOL_B, riskClass: 'safe-read', requiresApproval: false, enabled: true },
];

function fixture(overrides: unknown[], configuration: typeof base | null = base) {
  const setup = { listToolOverrides: vi.fn().mockResolvedValue(overrides) };
  const published = {
    findLatestPublishedConfiguration: vi.fn().mockResolvedValue(configuration),
    findPublishedSetupArtifactTools: vi.fn().mockResolvedValue(artifactTools),
  };
  const configurations = {
    createPolicyOnlyRevision: vi.fn().mockResolvedValue({
      configurationRevisionId: 'config-2',
    }),
  };
  return {
    configurations,
    service: new ToolPolicyRevisionService(
      setup as never,
      published as never,
      configurations as never,
    ),
  };
}

describe('ToolPolicyRevisionService', () => {
  it('drafts nothing before the first publication', async () => {
    const f = fixture([{ toolId: TOOL_A, enabled: false }], null);

    await expect(f.service.draft(scope, actor)).resolves.toBeNull();
    expect(f.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
  });

  it('drafts a policy-only revision from the bounded decisions', async () => {
    const f = fixture([
      { toolId: TOOL_B, requiresApproval: true, riskClass: 'external' },
      // Stored before the bounds: lowering and enabling are dropped.
      { toolId: TOOL_A, riskClass: 'safe-read', enabled: false },
    ]);

    await expect(f.service.draft(scope, actor)).resolves.toEqual({
      configurationRevisionId: 'config-2',
      created: true,
    });
    expect(f.configurations.createPolicyOnlyRevision).toHaveBeenCalledWith({
      ...scope,
      baseConfiguration: base,
      toolOverrides: [
        { toolId: TOOL_A, enabled: false },
        { toolId: TOOL_B, requiresApproval: true, riskClass: 'external' },
      ],
    }, actor);
  });

  it('keeps the published configuration when it already signs the decisions', async () => {
    const f = fixture([{ toolId: TOOL_A, enabled: false }], {
      ...base,
      toolOverrides: [{ toolId: TOOL_A, enabled: false }],
    });

    await expect(f.service.draft(scope, actor)).resolves.toEqual({
      configurationRevisionId: 'config-1',
      created: false,
    });
    expect(f.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
  });

  /** A tool only a newer capability report knows still gets its decision. */
  it('bounds a decision for an unpublished tool by its saved baseline', async () => {
    const f = fixture([{
      toolId: NEW_TOOL,
      requiresApproval: false,
      baselineRiskClass: 'write',
      baselineRequiresApproval: true,
    }]);

    await f.service.draft(scope, actor);

    expect(f.configurations.createPolicyOnlyRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        toolOverrides: [{
          toolId: NEW_TOOL,
          requiresApproval: false,
          pin: { toolId: NEW_TOOL, atRiskClass: 'write' },
        }],
      }),
      actor,
    );
  });

  /**
   * The connected overview and apply ask which revision signs the decisions
   * now; a draft left behind by an earlier, since reverted decision is never
   * the answer.
   */
  it('names the revision that signs the current decisions without drafting it', async () => {
    const decided = fixture([{ toolId: TOOL_A, enabled: false }]);

    await expect(decided.service.target(scope)).resolves.toEqual({
      kind: 'policy-only',
      configurationRevisionId: policyOnlyRevisionId(base.id, [
        { toolId: TOOL_A, enabled: false },
      ]),
    });
    expect(decided.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
    await expect(fixture([]).service.target(scope)).resolves.toEqual({
      kind: 'published',
      configurationRevisionId: base.id,
    });
    await expect(fixture([{ toolId: TOOL_A, enabled: false }], null).service.target(scope))
      .resolves.toEqual({ kind: 'unpublished-decisions' });
    await expect(fixture([], null).service.target(scope)).resolves.toBeNull();
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
@@ -1,7 +1,15 @@
-import { ConflictException, ForbiddenException } from '@nestjs/common';
+import {
+  ConflictException,
+  ForbiddenException,
+  NotFoundException,
+} from '@nestjs/common';
 import { describe, expect, it, vi } from 'vitest';
 import { PublishAndDeployService } from '../publish-and-deploy.service';
-import { publishAndDeployId } from '../publish-and-deploy-id';
+import {
+  configurationApplyId,
+  configurationPublicationId,
+  publishAndDeployId,
+} from '../publish-and-deploy-id';
 
 const scope = {
   tenantId: '019fb200-0000-7000-8000-000000000001',
@@ -61,6 +69,7 @@ function fixture(overrides: { status?: string; deployments?: unknown[] } = {}) {
   const revisions = {
     publishBatch: vi.fn().mockResolvedValue([]),
     publishBatchResumable: vi.fn().mockResolvedValue([]),
+    findStatus: vi.fn().mockResolvedValue('draft'),
   };
   const derivation = {
     deployLatestPublished: vi.fn().mockImplementation(async (
@@ -392,4 +401,94 @@ describe('PublishAndDeployService', () => {
     ))).size).toBe(1);
     expect(f.derivation.deployLatestPublished).not.toHaveBeenCalled();
   });
+
+  describe('applying an app configuration', () => {
+    const configurationId = '019fb200-0000-7000-8000-0000000000c2';
+    const configuration = {
+      ...scope,
+      type: 'config',
+      revisionId: configurationId,
+    };
+
+    it('publishes a drafted decision set once and waits for the health gate', async () => {
+      const f = fixture();
+
+      const result = await f.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor);
+
+      expect(f.revisions.publishBatchResumable).toHaveBeenCalledWith(
+        [configuration],
+        actor,
+        {
+          reason: 'Platform decision apply',
+          compositeId: configurationPublicationId(configurationId),
+          selfApproveCritical: true,
+        },
+      );
+      expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        configurationId,
+        expect.objectContaining({
+          deploymentId: configurationApplyId(configurationId, environmentId),
+        }),
+        expect.objectContaining({ userId: actor.userId }),
+      );
+      expect(result).toEqual({
+        compositeId: configurationApplyId(configurationId, environmentId),
+        step: 'awaiting_health',
+        deploymentId: configurationApplyId(configurationId, environmentId),
+        healthStatus: 'unknown',
+      });
+      expect(f.deployments.activate).not.toHaveBeenCalled();
+    });
+
+    it('activates the same deployment once the runner reports healthy', async () => {
+      const deploymentId = configurationApplyId(configurationId, environmentId);
+      const f = fixture({ deployments: [{
+        id: deploymentId,
+        status: 'pending',
+        healthStatus: 'healthy',
+      }] });
+      f.revisions.findStatus.mockResolvedValue('published');
+
+      const result = await f.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor);
+
+      expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
+      expect(f.derivation.deployPublishedConfiguration).not.toHaveBeenCalled();
+      expect(f.deployments.activate).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        deploymentId,
+        actor,
+      );
+      expect(result.step).toBe('active');
+      expect(f.setup.appendCompositeAudit).toHaveBeenCalledWith(scope, actor, {
+        compositeId: deploymentId,
+        configurationRevisionId: configurationId,
+        environmentId,
+        deploymentId,
+        step: 'active',
+      });
+    });
+
+    it('refuses an unknown configuration and a caller without both roles', async () => {
+      const unknown = fixture();
+      unknown.revisions.findStatus.mockResolvedValue(null);
+      await expect(unknown.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor)).rejects.toBeInstanceOf(NotFoundException);
+
+      const editor = fixture();
+      await expect(editor.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, { userId: 'editor-1', role: 'editor' })).rejects.toBeInstanceOf(ForbiddenException);
+      expect(editor.revisions.findStatus).not.toHaveBeenCalled();
+    });
+  });
 });
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
@@ -82,11 +82,15 @@ const runView = {
 };
 
 /** Controller under test with only the setup service wired. */
-const controllerWith = (setup: unknown) => new RuntimeSetupV2Controller(
+const controllerWith = (
+  setup: unknown,
+  policyRevisions: unknown = {},
+) => new RuntimeSetupV2Controller(
   setup as never,
   {} as never,
   {} as never,
   {} as never,
+  policyRevisions as never,
 );
 
 describe('RuntimeSetupV2Controller', () => {
@@ -428,6 +432,7 @@ describe('RuntimeSetupV2Controller', () => {
       {} as never,
       {} as never,
       { get } as never,
+      {} as never,
     );
 
     await expect(controller.getConnectedOverview(
@@ -449,6 +454,7 @@ describe('RuntimeSetupV2Controller', () => {
       {} as never,
       { runConnected } as never,
       { assertApply } as never,
+      {} as never,
     );
 
     await expect(controller.applyConnectedUpdate(
@@ -476,6 +482,7 @@ describe('RuntimeSetupV2Controller', () => {
       {} as never,
       { run } as never,
       {} as never,
+      {} as never,
     );
 
     await expect(controller.applyConnectedUpdate(
@@ -486,4 +493,59 @@ describe('RuntimeSetupV2Controller', () => {
     )).rejects.toThrow(BadRequestException);
     expect(run).not.toHaveBeenCalled();
   });
+
+  it('drafts the policy-only revision after an override and returns it', async () => {
+    const saveToolOverride = vi.fn().mockResolvedValue(undefined);
+    const getLatestSetup = vi.fn().mockResolvedValue({ appId: APP_ID });
+    const draft = vi.fn().mockResolvedValue({
+      configurationRevisionId: 'config-2',
+      created: true,
+    });
+    const controller = controllerWith({ saveToolOverride, getLatestSetup }, { draft });
+
+    await expect(controller.overrideTool(
+      dashboardTenant,
+      APP_ID,
+      RUN_ID,
+      TOOL_ID,
+      { enabled: false },
+    )).resolves.toEqual({
+      appId: APP_ID,
+      policyRevision: { configurationRevisionId: 'config-2', created: true },
+    });
+    expect(draft).toHaveBeenCalledWith(
+      { tenantId: TENANT_ID, targetAppId: APP_ID },
+      { userId: 'editor-1', role: 'editor' },
+    );
+  });
+
+  it('applies a configuration with a server-owned reason', async () => {
+    const applyConfiguration = vi.fn().mockResolvedValue({ step: 'awaiting_health' });
+    const controller = new RuntimeSetupV2Controller(
+      {} as never,
+      {} as never,
+      { applyConfiguration } as never,
+      {} as never,
+      {} as never,
+    );
+
+    await expect(controller.applyConfiguration(
+      { ...(dashboardTenant as object), memberRole: 'owner' } as never,
+      APP_ID,
+      PLANNER_ID,
+      { environmentId: ENVIRONMENT_ID },
+    )).resolves.toEqual({ step: 'awaiting_health' });
+    expect(applyConfiguration).toHaveBeenCalledWith(
+      { tenantId: TENANT_ID, targetAppId: APP_ID },
+      PLANNER_ID,
+      { environmentId: ENVIRONMENT_ID, reason: 'Platform decision apply' },
+      { userId: 'editor-1', role: 'owner' },
+    );
+    await expect(controller.applyConfiguration(
+      setupKeyTenant,
+      APP_ID,
+      PLANNER_ID,
+      { environmentId: ENVIRONMENT_ID },
+    )).rejects.toThrow(ForbiddenException);
+  });
 });
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.routes.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.routes.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.routes.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.routes.spec.ts
@@ -53,6 +53,13 @@ describe('runtime setup v2 routes', () => {
       path: 'runs/:runId/apply',
       method: RequestMethod.POST,
     });
+    expect(routeOf(
+      RuntimeSetupV2Controller.prototype,
+      'applyConfiguration',
+    )).toEqual({
+      path: 'configurations/:configurationRevisionId/apply',
+      method: RequestMethod.POST,
+    });
   });
 
   it('leaves the transitional environment-scoped endpoints unchanged', () => {
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 2>&1 | grep -E "Test Files|Tests |Cannot find module"
```

Expected: `Cannot find module '../tool-policy-revision.service'`, `Test Files  4 failed | 10 passed (14)`, `Tests  6 failed | 204 passed (210)`: the three "applying an app configuration" tests, the routes test (no `applyConfiguration` route) and both new controller tests; the new spec file fails to load, so its five tests are not counted.

- [ ] **Step 3: Implement**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  RuntimeAppConfigurationService,
  policyOnlyRevisionId,
} from '../runtime-revisions/app-configuration.service';
import { canonicalRuntimeJson } from '../runtime-revisions/runtime-signing.service';
import { type RuntimeActor } from '../runtime-revisions/runtime-revision.service';
import {
  DESIRED_STATE_DERIVATION_STORE,
  type DesiredStateDerivationStore,
  type PublishedConfigurationRecord,
} from '../runtime-deployments/runtime-desired-state-derivation.service';
import {
  RUNTIME_APP_SETUP_STORE,
  type AppSetupScope,
  type RuntimeAppSetupStore,
} from './runtime-setup-v2.store';
import {
  boundToolOverrideDeltas,
  reportedToolPolicy,
  type ToolOverrideDelta,
} from './tool-override';

export interface PolicyRevisionDraft {
  configurationRevisionId: string;
  /** False when the published configuration already signs these decisions. */
  created: boolean;
}

/** Which configuration signs the app's current decisions. */
export type PolicyRevisionTarget =
  /** Decisions exist, but nothing is published yet; the first publication signs them. */
  | { kind: 'unpublished-decisions' }
  /** The latest published configuration already signs exactly these decisions. */
  | { kind: 'published'; configurationRevisionId: string }
  /** The policy-only revision over the latest published configuration. */
  | { kind: 'policy-only'; configurationRevisionId: string };

type ResolvedTarget =
  | Exclude<PolicyRevisionTarget, { kind: 'policy-only' }>
  | {
    kind: 'policy-only';
    configurationRevisionId: string;
    base: PublishedConfigurationRecord;
    toolOverrides: ToolOverrideDelta[];
  };

/**
 * Turns the app's saved tool decisions into a policy-only configuration
 * revision on top of the latest published configuration (the pattern of
 * `createPromptOnlyRevision`). It only drafts; publication, the
 * direction-aware security gate, signing, the health-gated activation and
 * the revocation of the previous deployment stay with the apply path.
 */
@Injectable()
export class ToolPolicyRevisionService {
  constructor(
    @Inject(RUNTIME_APP_SETUP_STORE)
    private readonly setup: RuntimeAppSetupStore,
    @Inject(DESIRED_STATE_DERIVATION_STORE)
    private readonly published: DesiredStateDerivationStore,
    private readonly configurations: RuntimeAppConfigurationService,
  ) {}

  /** Null while nothing is published yet: the first publication signs them. */
  async draft(
    scope: AppSetupScope,
    actor: RuntimeActor,
  ): Promise<PolicyRevisionDraft | null> {
    const target = await this.resolve(scope);
    if (!target || target.kind === 'unpublished-decisions') return null;
    if (target.kind === 'published') {
      return { configurationRevisionId: target.configurationRevisionId, created: false };
    }
    const result = await this.configurations.createPolicyOnlyRevision({
      ...scope,
      baseConfiguration: target.base,
      toolOverrides: target.toolOverrides,
    }, actor);
    return {
      configurationRevisionId: result.configurationRevisionId,
      created: true,
    };
  }

  /**
   * The configuration that signs the current decisions, named without
   * drafting it (`policyOnlyRevisionId`; every save drafts it). Readers such
   * as the connected overview use this instead of "the newest draft", so a
   * draft left behind by a decision that was changed back is never applied.
   */
  async target(scope: AppSetupScope): Promise<PolicyRevisionTarget | null> {
    const target = await this.resolve(scope);
    if (!target || target.kind !== 'policy-only') return target;
    return {
      kind: 'policy-only',
      configurationRevisionId: target.configurationRevisionId,
    };
  }

  private async resolve(scope: AppSetupScope): Promise<ResolvedTarget | null> {
    const [base, overrides] = await Promise.all([
      this.published.findLatestPublishedConfiguration(scope),
      this.setup.listToolOverrides(scope),
    ]);
    if (!base || !base.signed) {
      return overrides.length > 0 ? { kind: 'unpublished-decisions' } : null;
    }
    const artifactTools = await this.published.findPublishedSetupArtifactTools(
      scope,
      base.setupArtifactDigest,
    ) ?? [];
    const reported = new Map(artifactTools.map((tool) => {
      const policy = reportedToolPolicy(tool);
      return [policy.toolId, policy] as const;
    }));
    // The same rule as publication (Task 3): each decision is bounded by the
    // version the published configuration binds, a tool only a newer
    // capability report knows by its saved baseline.
    const toolOverrides = boundToolOverrideDeltas(overrides, reported);
    if (
      canonicalRuntimeJson(toolOverrides)
      === canonicalRuntimeJson(base.toolOverrides ?? [])
    ) {
      return { kind: 'published', configurationRevisionId: base.id };
    }
    return {
      kind: 'policy-only',
      configurationRevisionId: policyOnlyRevisionId(base.id, toolOverrides),
      base,
      toolOverrides,
    };
  }
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-deployments/runtime-deployment.module.ts b/apps/api/src/modules/runtime-deployments/runtime-deployment.module.ts
--- a/apps/api/src/modules/runtime-deployments/runtime-deployment.module.ts
+++ b/apps/api/src/modules/runtime-deployments/runtime-deployment.module.ts
@@ -32,6 +32,10 @@ import {
     },
     RuntimeDesiredStateDerivationService,
   ],
-  exports: [RuntimeDeploymentService, RuntimeDesiredStateDerivationService],
+  exports: [
+    RuntimeDeploymentService,
+    RuntimeDesiredStateDerivationService,
+    DESIRED_STATE_DERIVATION_STORE,
+  ],
 })
 export class RuntimeDeploymentModule {}
diff --git a/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts b/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts
--- a/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts
+++ b/apps/api/src/modules/runtime-revisions/runtime-revision.service.ts
@@ -597,6 +597,12 @@ export class RuntimeRevisionService {
     }
   }
 
+  /** `draft`, `published`, ... or null when the app has no such revision. */
+  async findStatus(scope: RuntimeRevisionScope): Promise<string | null> {
+    const revision = await this.store.findRevision(scope);
+    return revision?.status ?? null;
+  }
+
   private async requireDraft(scope: RuntimeRevisionScope): Promise<StoredRuntimeRevision> {
     const revision = await this.store.findRevision(scope);
     if (!revision) throw new NotFoundException('Runtime revision not found');
diff --git a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts
@@ -13,3 +13,28 @@ export function publishAndDeployId(
   return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
     + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
 }
+
+/**
+ * Stable publication identity of one app configuration. It does not name an
+ * environment: the configuration is published once and then deployed to any
+ * number of environments.
+ */
+export function configurationPublicationId(configurationRevisionId: string): string {
+  return identity('configuration-publication', configurationRevisionId);
+}
+
+/** Stable deployment identity of one configuration in one environment. */
+export function configurationApplyId(
+  configurationRevisionId: string,
+  environmentId: string,
+): string {
+  return identity('configuration-apply', configurationRevisionId, environmentId);
+}
+
+function identity(kind: string, ...parts: string[]): string {
+  const hex = createHash('sha256')
+    .update([kind, ...parts.map((part) => part.toLowerCase())].join('\0'))
+    .digest('hex');
+  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
+    + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
+}
diff --git a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
@@ -2,6 +2,7 @@ import {
   ConflictException,
   ForbiddenException,
   Injectable,
+  NotFoundException,
 } from '@nestjs/common';
 import {
   RuntimeAppConfigurationService,
@@ -26,7 +27,11 @@ import {
   RuntimeSetupV2Service,
   type AppSetupPublicationState,
 } from './runtime-setup-v2.service';
-import { publishAndDeployId } from './publish-and-deploy-id';
+import {
+  configurationApplyId,
+  configurationPublicationId,
+  publishAndDeployId,
+} from './publish-and-deploy-id';
 
 export interface PublishAndDeployResult {
   compositeId: string;
@@ -164,12 +169,87 @@ export class PublishAndDeployService {
         this.compositeActor(actor),
       )).deployment;
 
+    return this.settle(scope, actor, compositeId, deployed, { runId });
+  }
+
+  /**
+   * Applies one app configuration to one environment, typically the
+   * policy-only revision drafted from saved tool decisions: it publishes the
+   * draft (direction-aware security gate, signing), derives the environment
+   * revisions, creates the pending deployment and activates it once the
+   * runner reports it healthy, revoking what the previous deployment pinned.
+   * Repeating the request resumes the same deployment.
+   */
+  async applyConfiguration(
+    appScope: { tenantId: string; targetAppId: string },
+    configurationRevisionId: string,
+    input: { environmentId: string; reason: string },
+    actor: RuntimeActor,
+  ): Promise<PublishAndDeployResult> {
+    this.assertActorCanRun(actor);
+    const scope: RuntimeDeploymentScope = {
+      ...appScope,
+      environmentId: input.environmentId,
+    };
+    await this.setup.assertEnvironment(scope);
+    const configuration = {
+      ...appScope,
+      type: 'config' as const,
+      revisionId: configurationRevisionId,
+    };
+    const status = await this.revisions.findStatus(configuration);
+    if (status === null) {
+      throw new NotFoundException('App configuration revision not found');
+    }
+    if (status === 'draft') {
+      await this.revisions.publishBatchResumable([configuration], actor, {
+        reason: input.reason,
+        compositeId: configurationPublicationId(configurationRevisionId),
+        selfApproveCritical: true,
+      });
+    } else if (status !== 'published') {
+      throw new ConflictException('The app configuration can no longer be applied');
+    }
+
+    const compositeId = configurationApplyId(
+      configurationRevisionId,
+      input.environmentId,
+    );
+    const deployed = await this.compositeDeployment(scope, compositeId)
+      ?? (await this.derivation.deployPublishedConfiguration(
+        scope,
+        configurationRevisionId,
+        {
+          deploymentId: compositeId,
+          rolloutMode: 'stable',
+          targetPercentage: 100,
+          pinned: false,
+        },
+        this.compositeActor(actor),
+      )).deployment;
+    return this.settle(scope, actor, compositeId, deployed, {
+      configurationRevisionId,
+    });
+  }
+
+  /** The shared health gate: activate once healthy, otherwise report. */
+  private async settle(
+    scope: RuntimeDeploymentScope,
+    actor: RuntimeActor,
+    compositeId: string,
+    deployed: { id: string; status: string; healthStatus: string },
+    subject: { runId: string } | { configurationRevisionId: string },
+  ): Promise<PublishAndDeployResult> {
+    const appScope = { tenantId: scope.tenantId, targetAppId: scope.targetAppId };
+    const audit = {
+      compositeId,
+      ...subject,
+      environmentId: scope.environmentId,
+      deploymentId: deployed.id,
+    };
     if (deployed.status === 'active') {
       await this.setup.appendCompositeAudit(appScope, actor, {
-        compositeId,
-        runId,
-        environmentId: input.environmentId,
-        deploymentId: deployed.id,
+        ...audit,
         step: 'active',
       });
       return this.result(compositeId, deployed, 'active');
@@ -181,10 +261,7 @@ export class PublishAndDeployService {
     }
     if (deployed.healthStatus !== 'healthy') {
       await this.setup.appendCompositeAudit(appScope, actor, {
-        compositeId,
-        runId,
-        environmentId: input.environmentId,
-        deploymentId: deployed.id,
+        ...audit,
         step: 'awaiting_health',
         healthStatus: deployed.healthStatus,
       });
@@ -197,10 +274,7 @@ export class PublishAndDeployService {
       actor,
     );
     await this.setup.appendCompositeAudit(appScope, actor, {
-      compositeId,
-      runId,
-      environmentId: input.environmentId,
-      deploymentId: deployed.id,
+      ...audit,
       step: 'active',
     });
     return this.result(compositeId, activated, 'active');
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts
@@ -33,6 +33,7 @@ import {
 } from './runtime-setup-v2.service';
 import { PublishAndDeployService } from './publish-and-deploy.service';
 import { ConnectedOverviewService } from './connected-overview.service';
+import { ToolPolicyRevisionService } from './tool-policy-revision.service';
 import { type AppSetupScope } from './runtime-setup-v2.store';
 
 const identifierSchema = z.string().uuid();
@@ -44,6 +45,7 @@ const applyConnectedUpdateSchema = z.object({
   environmentId: z.string().uuid(),
 }).strict();
 const CONNECTED_APPLY_REASON = 'Connected update apply';
+const CONFIGURATION_APPLY_REASON = 'Platform decision apply';
 
 /**
  * App-scoped Runtime Setup v2. Runtime Setup is configured exactly once per
@@ -59,6 +61,7 @@ export class RuntimeSetupV2Controller {
     private readonly configurations: RuntimeAppConfigurationService,
     private readonly publishAndDeploy: PublishAndDeployService,
     private readonly connectedOverview: ConnectedOverviewService,
+    private readonly policyRevisions: ToolPolicyRevisionService,
   ) {}
 
   @Get()
@@ -112,7 +115,9 @@ export class RuntimeSetupV2Controller {
   /**
    * Record an operator decision for one discovered tool. A dashboard user is
    * required: this is a governance decision, not something a setup credential
-   * may make on its own.
+   * may make on its own. Out of bounds answers 422 with a reason code; in
+   * bounds, the decision is drafted as a policy-only configuration revision
+   * (`policyRevision`, null before the first publication).
    */
   @Patch('runs/:runId/tools/:toolId')
   async overrideTool(
@@ -132,7 +137,32 @@ export class RuntimeSetupV2Controller {
       override,
       actor,
     );
-    return this.setup.getLatestSetup(scope);
+    const policyRevision = await this.policyRevisions.draft(scope, actor);
+    return { ...await this.setup.getLatestSetup(scope), policyRevision };
+  }
+
+  /**
+   * Apply one app configuration, typically the policy-only revision of saved
+   * decisions, to one environment. Publication, the direction-aware security
+   * gate, signing, the health-gated activation and revocation stay on the
+   * server; the reason is server-owned like the connected apply.
+   */
+  @Post('configurations/:configurationRevisionId/apply')
+  async applyConfiguration(
+    @CurrentTenant() tenant: TenantContext,
+    @Param('appId') appId: string,
+    @Param('configurationRevisionId') configurationRevisionId: string,
+    @Body() rawBody: unknown,
+  ) {
+    const scope = this.scope(tenant, appId);
+    const actor = this.verifiedUser(tenant);
+    const body = this.parse(applyConnectedUpdateSchema, rawBody);
+    return this.publishAndDeploy.applyConfiguration(
+      scope,
+      this.identifier(configurationRevisionId, 'configurationRevisionId'),
+      { environmentId: body.environmentId, reason: CONFIGURATION_APPLY_REASON },
+      actor,
+    );
   }
 
   /**
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
@@ -12,6 +12,7 @@ import {
   ConnectedOverviewService,
   DrizzleConnectedOverviewStore,
 } from './connected-overview.service';
+import { ToolPolicyRevisionService } from './tool-policy-revision.service';
 
 @Module({
   imports: [StreamModule, RuntimeRevisionModule, RuntimeDeploymentModule],
@@ -27,6 +28,7 @@ import {
     PublishAndDeployService,
     DrizzleConnectedOverviewStore,
     ConnectedOverviewService,
+    ToolPolicyRevisionService,
   ],
   exports: [
     RuntimeSetupV2Service,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  14 passed (14)`, `Tests  215 passed (215)`; `Test Files  118 passed (118)`, `Tests  1258 passed | 10 skipped (1268)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts apps/api/src/modules/runtime-revisions/runtime-revision.service.ts apps/api/src/modules/runtime-deployments/runtime-deployment.module.ts apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.routes.spec.ts
git commit -m "feat(runtime-setup): draft and apply policy-only tool decision revisions"
```

---

### Task 9: API – ingest capability reports and accept tools any environment reports

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts:65,104,134`; `runtime-setup-v2.store.ts:46,146`; `drizzle-runtime-setup-v2.store.ts:13,27,694`; `runtime-setup-v2.service.ts:378-380,836`; `apps/api/src/modules/runtime-connections/runtime-connection.service.ts:1,10,66,113`; specs `runtime-connection.service.spec.ts:1,90`, `runtime-setup-v2.controller.spec.ts:550`, `runtime-setup-v2.service.spec.ts:134,365,1075-1083`
- Test: the three specs

**Interfaces:**
- Consumes: the setup transport (`createRun`, `putArtifact`, open to app-bound runtime keys since P08a Task 16), `runtime_runners.capabilities` (one runner row per environment).
- Produces:
  - DTO: optional per-tool `provenance` and artifact `exclusions` exactly as in shared contract item 5 (strict; still behind the content boundary; `.optional()` rather than a default, so the digest of an artifact without them is unchanged).
  - `RuntimeConnectionService.register` refuses `capabilities.discoveryDigest` that is not a sha256 digest (400).
  - `interface EnvironmentCapabilityReport { environmentId; discoveryDigest; reportedAt: Date | null; runId: string | null; artifact: AppSetupArtifactRecord | null }`, `RuntimeAppSetupStore.findEnvironmentReports(scope)` (newest run of each reported digest that carries an artifact).
  - `saveToolOverride` accepts a toolId that the run does not contain when any environment's report contains it, bounded by the most recent such report; unknown everywhere stays 404.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-connections/__tests__/runtime-connection.service.spec.ts b/apps/api/src/modules/runtime-connections/__tests__/runtime-connection.service.spec.ts
--- a/apps/api/src/modules/runtime-connections/__tests__/runtime-connection.service.spec.ts
+++ b/apps/api/src/modules/runtime-connections/__tests__/runtime-connection.service.spec.ts
@@ -1,4 +1,4 @@
-import { ForbiddenException } from '@nestjs/common';
+import { BadRequestException, ForbiddenException } from '@nestjs/common';
 import { beforeEach, describe, expect, it, vi } from 'vitest';
 import {
   RuntimeConnectionService,
@@ -88,4 +88,27 @@ describe('RuntimeConnectionService', () => {
       cursor: 'cursor-0',
     });
   });
+
+  it('records the reported code version as a digest and nothing else', async () => {
+    const credential = { tenantId: scope.tenantId, targetAppId: scope.targetAppId };
+    const registration = {
+      runnerKey: 'runner-a',
+      version: '1.0.0',
+      technicalMetadata: {},
+    };
+    const discoveryDigest = `sha256:${'D'.repeat(43)}`;
+
+    await service.register(scope, credential, {
+      ...registration,
+      capabilities: { discoveryDigest },
+    });
+    expect(store.upsertRunner).toHaveBeenCalledWith(expect.objectContaining({
+      capabilities: { discoveryDigest },
+    }));
+
+    await expect(service.register(scope, credential, {
+      ...registration,
+      capabilities: { discoveryDigest: 'tasks: list, create, delete' },
+    })).rejects.toThrow(BadRequestException);
+  });
 });
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
@@ -548,4 +548,50 @@ describe('RuntimeSetupV2Controller', () => {
       { environmentId: ENVIRONMENT_ID },
     )).rejects.toThrow(ForbiddenException);
   });
+
+  it('accepts a capability report with provenance and exclusions from a runtime key', async () => {
+    const saveArtifact = vi.fn().mockResolvedValue(runView);
+    const controller = controllerWith({ saveArtifact });
+    const report = {
+      ...artifact,
+      tools: [{
+        ...artifact.tools[0],
+        provenance: {
+          policyOrigin: { riskClass: 'code-default', requiresApproval: 'local-policy' },
+          contractSource: 'derived',
+          descriptionSource: 'template',
+          schemaSource: 'field-names',
+        },
+      }],
+      exclusions: [{ stableKey: 'POST /api/webhooks/**', origin: 'default' }],
+    };
+
+    await controller.putArtifact(setupKeyTenant, APP_ID, RUN_ID, report);
+
+    expect(saveArtifact).toHaveBeenCalledWith(
+      { tenantId: TENANT_ID, targetAppId: APP_ID },
+      RUN_ID,
+      expect.objectContaining({
+        exclusions: report.exclusions,
+        tools: [expect.objectContaining({ provenance: report.tools[0].provenance })],
+      }),
+      { userId: 'api-key:key-1', role: 'editor' },
+    );
+  });
+
+  it('rejects provenance outside the shared vocabulary by path', async () => {
+    const saveArtifact = vi.fn();
+    const controller = controllerWith({ saveArtifact });
+
+    await expect(controller.putArtifact(setupKeyTenant, APP_ID, RUN_ID, {
+      ...artifact,
+      tools: [{ ...artifact.tools[0], provenance: { descriptionSource: 'llm' } }],
+    })).rejects.toMatchObject({
+      response: {
+        code: 'app_setup_request_invalid',
+        paths: ['tools.0.provenance.descriptionSource'],
+      },
+    });
+    expect(saveArtifact).not.toHaveBeenCalled();
+  });
 });
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
@@ -132,6 +132,7 @@ describe('RuntimeSetupV2Service', () => {
       findArtifact: vi.fn().mockResolvedValue(null),
       upsertToolOverride: vi.fn().mockResolvedValue(undefined),
       findToolOverride: vi.fn().mockResolvedValue(null),
+      findEnvironmentReports: vi.fn().mockResolvedValue([]),
       listToolOverrides: vi.fn().mockResolvedValue([]),
       insertArtifact: vi.fn().mockImplementation(
         async (input: { artifactDigest: string }): Promise<
@@ -363,6 +364,25 @@ describe('RuntimeSetupV2Service', () => {
     );
   });
 
+  /** A capability report describes tools; it never decides about them. */
+  it('stores a report from a runtime key without touching any decision', async () => {
+    store.findRun = vi.fn().mockResolvedValue(runRecord());
+
+    await service.saveArtifact(scope, RUN_ID, {
+      ...artifact,
+      tools: [{
+        ...artifact.tools[0],
+        enabled: true,
+        provenance: { descriptionSource: 'template', schemaSource: 'field-names' },
+      }],
+      exclusions: [{ stableKey: 'POST /api/webhooks/**', origin: 'default' }],
+    }, setupKeyActor);
+
+    expect(store.insertArtifact).toHaveBeenCalledTimes(1);
+    expect(store.upsertToolOverride).not.toHaveBeenCalled();
+    expect(store.findToolOverride).not.toHaveBeenCalled();
+  });
+
   it('accepts a repeated identical artifact upload without duplicating it', async () => {
     store.findRun = vi.fn().mockResolvedValue(runRecord({ status: 'review' }));
     const first = await service.saveArtifact(
@@ -1072,7 +1092,9 @@ describe('recording a bounded tool decision', () => {
     });
   });
 
-  it('refuses a tool the run does not report', async () => {
+  it('refuses a tool neither the run nor any environment reports', async () => {
+    store.findEnvironmentReports = vi.fn().mockResolvedValue([]);
+
     await expect(service.saveToolOverride(
       scope,
       RUN_ID,
@@ -1080,5 +1102,46 @@ describe('recording a bounded tool decision', () => {
       { enabled: false },
       actor,
     )).rejects.toBeInstanceOf(NotFoundException);
+    expect(store.upsertToolOverride).not.toHaveBeenCalled();
+  });
+
+  /** New tools run before any run containing them is reviewed. */
+  it('accepts a decision for a tool any environment reports, bounded by the newest report', async () => {
+    const reportedTool = {
+      ...artifact.tools[0],
+      toolId: OTHER_RUN_ID,
+      riskClass: 'delete',
+      enabled: true,
+    };
+    const report = (riskClass: string, at: string) => ({
+      environmentId: '019fb001-0000-7000-8000-0000000000e1',
+      discoveryDigest: digest('N'),
+      reportedAt: new Date(at),
+      runId: OTHER_RUN_ID,
+      artifact: {
+        ...storedArtifact,
+        artifact: { ...artifact, tools: [{ ...reportedTool, riskClass }] },
+      },
+    });
+    store.findEnvironmentReports = vi.fn().mockResolvedValue([
+      report('write', '2026-10-01T10:00:00.000Z'),
+      report('delete', '2026-10-05T10:00:00.000Z'),
+    ]);
+
+    await expect(service.saveToolOverride(
+      scope,
+      RUN_ID,
+      OTHER_RUN_ID,
+      { requiresApproval: false },
+      actor,
+    )).rejects.toMatchObject({
+      response: { reason: 'tier-3-always-requires-approval' },
+    });
+    await service.saveToolOverride(scope, RUN_ID, OTHER_RUN_ID, { enabled: false }, actor);
+
+    expect(store.upsertToolOverride).toHaveBeenCalledWith(expect.objectContaining({
+      toolId: OTHER_RUN_ID,
+      override: expect.objectContaining({ enabled: false, baselineRiskClass: 'delete' }),
+    }));
   });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-connections 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: `Test Files  3 failed | 14 passed (17)`, `Tests  4 failed | 232 passed (236)`: "records the reported code version as a digest and nothing else" (the free-text digest is accepted), "accepts a decision for a tool any environment reports, bounded by the newest report" (404), and both controller report tests (`app_setup_request_invalid` for `provenance`/`exclusions`). The two pins "stores a report from a runtime key without touching any decision" and "refuses a tool neither the run nor any environment reports" already pass.

- [ ] **Step 3: Implement**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-connections/runtime-connection.service.ts b/apps/api/src/modules/runtime-connections/runtime-connection.service.ts
--- a/apps/api/src/modules/runtime-connections/runtime-connection.service.ts
+++ b/apps/api/src/modules/runtime-connections/runtime-connection.service.ts
@@ -1,4 +1,5 @@
 import {
+  BadRequestException,
   ForbiddenException,
   Inject,
   Injectable,
@@ -8,6 +9,8 @@ import { assertControlPlaneSafe } from '../runtime-revisions/runtime-publication
 
 export const RUNTIME_CONNECTION_STORE = Symbol('RUNTIME_CONNECTION_STORE');
 
+const DISCOVERY_DIGEST = /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/;
+
 export interface RuntimeConnectionScope {
   tenantId: string;
   targetAppId: string;
@@ -64,6 +67,7 @@ export class RuntimeConnectionService {
     this.assertCredentialScope(scope, credential);
     assertControlPlaneSafe(registration.capabilities);
     assertControlPlaneSafe(registration.technicalMetadata);
+    this.assertDiscoveryDigest(registration.capabilities);
     await this.requireEnvironment(scope);
     return this.store.upsertRunner({ ...scope, ...registration });
   }
@@ -111,6 +115,21 @@ export class RuntimeConnectionService {
     }
   }
 
+  /**
+   * `capabilities.discoveryDigest` names the code version this environment
+   * runs; its content-free artifact arrives once per digest through the app
+   * setup transport. Only a digest is accepted, never content.
+   */
+  private assertDiscoveryDigest(capabilities: Record<string, unknown>): void {
+    const digest = capabilities.discoveryDigest;
+    if (
+      digest !== undefined
+      && (typeof digest !== 'string' || !DISCOVERY_DIGEST.test(digest))
+    ) {
+      throw new BadRequestException('capabilities.discoveryDigest must be a sha256 digest');
+    }
+  }
+
   private async requireEnvironment(scope: RuntimeConnectionScope): Promise<void> {
     if (!await this.store.environmentExists(scope)) {
       throw new NotFoundException('Runtime environment not found');
diff --git a/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts b/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts
--- a/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts
+++ b/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts
@@ -63,6 +63,35 @@ export const updateAppSetupStatusSchema = z.object({
   progress: appSetupProgressSchema.optional(),
 }).strict();
 
+const policyOriginSchema = z.enum(['code-default', 'local-policy']);
+
+/**
+ * Optional, content-free provenance a capability report may carry (shared
+ * SDK contract, see the P08b plan): where each policy value came from locally
+ * and how the description and input schema were obtained. Absent fields read
+ * as "not reported", never as a default.
+ */
+const appSetupToolProvenanceSchema = z.object({
+  policyOrigin: z.object({
+    enabled: policyOriginSchema,
+    requiresApproval: policyOriginSchema,
+    riskClass: policyOriginSchema,
+    allowedRoles: policyOriginSchema,
+    description: policyOriginSchema,
+  }).partial().strict().optional(),
+  contractSource: z.enum([
+    'native',
+    'contract-module',
+    'legacy-ai-tool',
+    'resolution',
+    'openapi',
+    'derived',
+    'ui-bridge',
+  ]).optional(),
+  descriptionSource: z.enum(['human', 'code', 'agent', 'template']).optional(),
+  schemaSource: z.enum(['zod', 'openapi', 'agent', 'field-names']).optional(),
+}).strict();
+
 const appSetupToolCandidateSchema = z.object({
   toolId: uuid,
   sourceFingerprint: digest,
@@ -102,6 +131,7 @@ const appSetupToolCandidateSchema = z.object({
   requiresApproval: z.boolean(),
   inputSchemaDigest: digest,
   outputSchemaDigest: digest,
+  provenance: appSetupToolProvenanceSchema.optional(),
 }).strict();
 
 export const appSetupArtifactSchema = z.object({
@@ -132,6 +162,11 @@ export const appSetupArtifactSchema = z.object({
     code: identifier,
     subjectRef: identifier.optional(),
   }).strict()).max(5_000).default([]),
+  /** Routes the code deliberately does not expose as tools. */
+  exclusions: z.array(z.object({
+    stableKey: z.string().trim().min(1).max(512),
+    origin: z.enum(['default', 'policy', 'code']),
+  }).strict()).max(5_000).optional(),
   generatedAt: timestamp,
 }).strict().superRefine((artifact, context) => {
   const toolIds = new Set(artifact.tools.map((tool) => tool.toolId));
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -11,6 +11,7 @@ import {
   runtimeAppSetupToolOverrides,
   runtimeDeployments,
   runtimeEnvironments,
+  runtimeRunners,
   runtimeTools,
   targetApps,
   type Database,
@@ -25,6 +26,7 @@ import { canonicalRuntimeJson } from '../runtime-revisions/runtime-signing.servi
 import {
   type AppSetupArtifactRecord,
   type AppSetupRunRecord,
+  type EnvironmentCapabilityReport,
   type RuntimeAppSetupStore,
 } from './runtime-setup-v2.store';
 import {
@@ -692,6 +694,61 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
     return this.toToolOverrides(rows)[0] ?? null;
   }
 
+  async findEnvironmentReports(
+    scope: Parameters<RuntimeAppSetupStore['findEnvironmentReports']>[0],
+  ): Promise<EnvironmentCapabilityReport[]> {
+    const runners = await this.db.select({
+      environmentId: runtimeRunners.environmentId,
+      capabilities: runtimeRunners.capabilities,
+      lastSeenAt: runtimeRunners.lastSeenAt,
+    }).from(runtimeRunners).where(and(
+      eq(runtimeRunners.tenantId, scope.tenantId),
+      eq(runtimeRunners.targetAppId, scope.targetAppId),
+    ));
+    const reported = runners.flatMap((runner) => {
+      const digest = (runner.capabilities as Record<string, unknown> | null)
+        ?.discoveryDigest;
+      return typeof digest === 'string'
+        ? [{ ...runner, discoveryDigest: digest }]
+        : [];
+    });
+    if (reported.length === 0) return [];
+    const runs = await this.db.select({
+      id: runtimeAppSetupRuns.id,
+      discoveryDigest: runtimeAppSetupRuns.discoveryDigest,
+    }).from(runtimeAppSetupRuns).where(and(
+      eq(runtimeAppSetupRuns.tenantId, scope.tenantId),
+      eq(runtimeAppSetupRuns.targetAppId, scope.targetAppId),
+      inArray(
+        runtimeAppSetupRuns.discoveryDigest,
+        [...new Set(reported.map((runner) => runner.discoveryDigest))],
+      ),
+    )).orderBy(desc(runtimeAppSetupRuns.createdAt), desc(runtimeAppSetupRuns.id));
+    const artifacts = runs.length === 0 ? [] : await this.db.select()
+      .from(runtimeAppSetupArtifacts)
+      .where(and(
+        eq(runtimeAppSetupArtifacts.tenantId, scope.tenantId),
+        eq(runtimeAppSetupArtifacts.targetAppId, scope.targetAppId),
+        inArray(runtimeAppSetupArtifacts.runId, runs.map((run) => run.id)),
+      ));
+    const artifactByRun = new Map(
+      artifacts.map((artifact) => [artifact.runId, this.toArtifactRecord(artifact)]),
+    );
+    return reported.map((runner) => {
+      // Newest run of that digest that carries an artifact, else the newest.
+      const candidates = runs.filter((run) => run.discoveryDigest === runner.discoveryDigest);
+      const run = candidates.find((candidate) => artifactByRun.has(candidate.id))
+        ?? candidates[0];
+      return {
+        environmentId: runner.environmentId,
+        discoveryDigest: runner.discoveryDigest,
+        reportedAt: runner.lastSeenAt,
+        runId: run?.id ?? null,
+        artifact: run ? artifactByRun.get(run.id) ?? null : null,
+      };
+    });
+  }
+
   async listToolOverrides(
     scope: Parameters<RuntimeAppSetupStore['listToolOverrides']>[0],
   ) {
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
@@ -375,9 +375,12 @@ export class RuntimeSetupV2Service {
     const run = await this.requireRun(scope, runId);
     const artifact = await this.store.findArtifact(scope, runId);
     const tool = this.artifactTools(artifact)
-      .find((candidate) => this.readString(candidate, 'toolId') === toolId);
+      .find((candidate) => this.readString(candidate, 'toolId') === toolId)
+      ?? await this.reportedTool(scope, toolId);
     if (!tool) {
-      throw new NotFoundException('The setup run does not contain that tool');
+      throw new NotFoundException(
+        'Neither the setup run nor any environment reports that tool',
+      );
     }
 
     const reported = reportedToolPolicy(tool);
@@ -834,6 +837,27 @@ export class RuntimeSetupV2Service {
     };
   }
 
+  /**
+   * A tool the code of any environment reports may carry a decision before
+   * any run that contains it is reviewed (new tools are active at once). The
+   * most recent report is the reference for its bounds.
+   */
+  private async reportedTool(
+    scope: AppSetupScope,
+    toolId: string,
+  ): Promise<Record<string, unknown> | undefined> {
+    const reports = await this.store.findEnvironmentReports(scope);
+    const newestFirst = [...reports].sort((left, right) => (
+      (right.reportedAt?.getTime() ?? 0) - (left.reportedAt?.getTime() ?? 0)
+    ));
+    for (const report of newestFirst) {
+      const tool = this.artifactTools(report.artifact)
+        .find((candidate) => this.readString(candidate, 'toolId') === toolId);
+      if (tool) return tool;
+    }
+    return undefined;
+  }
+
   /**
    * A relaxation is pinned to the class the code reported when it was
    * decided, so the baseline moves only when confirmation itself is decided
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
@@ -44,6 +44,16 @@ export interface AppSetupArtifactRecord {
   createdAt: Date;
 }
 
+/** What one environment's runner reports it runs (its capability report). */
+export interface EnvironmentCapabilityReport {
+  environmentId: string;
+  discoveryDigest: string;
+  reportedAt: Date | null;
+  /** The newest run of the app for that digest; null until it is uploaded. */
+  runId: string | null;
+  artifact: AppSetupArtifactRecord | null;
+}
+
 export interface AppSetupRunPatch {
   status?: AppSetupStatus;
   progress?: AppSetupProgress | null;
@@ -144,6 +154,10 @@ export interface RuntimeAppSetupStore {
     scope: AppSetupScope,
     toolId: string,
   ): Promise<StoredToolOverride | null>;
+  /** One entry per environment whose runner reported a discovery digest. */
+  findEnvironmentReports(
+    scope: AppSetupScope,
+  ): Promise<EnvironmentCapabilityReport[]>;
   /** App-scoped: a decision outlives the run that discovered the tool. */
   listToolOverrides(
     scope: AppSetupScope,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-connections 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/common/__tests__/app-scope-wiring.spec.ts 2>&1 | grep -E "Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  17 passed (17)`, `Tests  236 passed (236)`; the P08a wiring spec `Tests  3 passed (3)` (the runtime-key exception still covers exactly the four setup routes); `Test Files  118 passed (118)`, `Tests  1263 passed | 10 skipped (1273)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts apps/api/src/modules/runtime-connections/runtime-connection.service.ts apps/api/src/modules/runtime-connections/__tests__/runtime-connection.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
git commit -m "feat(runtime-setup): ingest capability reports and accept reported tools"
```

---
### Task 10: API – show what each environment's chat can do

**Files:**
- Create: `apps/api/src/modules/runtime-setup-v2/capability-view.service.ts`, `apps/api/src/modules/runtime-setup-v2/capability-view.controller.ts`, `apps/api/src/modules/runtime-setup-v2/__tests__/capability-view.spec.ts`
- Modify: `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts:15,19,31`
- Test: `apps/api/src/modules/runtime-setup-v2/__tests__/capability-view.spec.ts`

**Interfaces:**
- Consumes: Task 9's `findEnvironmentReports`, Task 3's `boundToolOverride`/`reportedToolPolicy`, `listToolOverrides`, `environmentExists`; `RuntimeDeploymentService.list` (active deployment → `configRevisionId`); `DESIRED_STATE_DERIVATION_STORE` (`findPublishedConfiguration`, `findLatestPublishedConfiguration`, `findPublishedSetupArtifactTools`).
- Produces: `GET /v2/apps/:appId/environments/:environmentId/capabilities` → `CapabilityView` (shared contract item 7). Status precedence `needs-attention` > `risk-raised` > `changed` > `new` > `unchanged`; `removed` rows for tools of the comparison configuration the report no longer contains (`enabled: false`); `changed` = a different source fingerprint, schema digest, method, path or action binding; `codeVersion` is `not-reported`, `artifact-missing` (digest registered, artifact not uploaded yet) or `reported`. `origin.<field>` is `platform` when the bounded decision changed the value, else the report's `provenance.policyOrigin`, else `null`. The values show the saved decisions; `decisionPending` is true when they differ in effect from the deltas that the configuration of the environment's active deployment signs (before the first rollout nothing is in force), so a saved disable is never mistaken for one the chat already obeys. An app-bound management key reads only its own app (404 otherwise); a runtime-only key is refused by `@RequireScopes('management')`.

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__tests__/capability-view.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityViewController } from '../capability-view.controller';
import { CapabilityViewService } from '../capability-view.service';

const scope = {
  tenantId: '019fb400-0000-7000-8000-000000000001',
  targetAppId: '019fb400-0000-7000-8000-000000000002',
};
const ENVIRONMENT_ID = '019fb400-0000-7000-8000-000000000003';
const RUN_ID = '019fb400-0000-7000-8000-000000000004';
const LIST = '019fb400-0000-7000-8000-00000000000a';
const UPDATE = '019fb400-0000-7000-8000-00000000000b';
const ARCHIVE = '019fb400-0000-7000-8000-00000000000c';
const EXPORT = '019fb400-0000-7000-8000-00000000000d';
const GONE = '019fb400-0000-7000-8000-00000000000e';
const digest = (seed: string) => `sha256:${seed.repeat(43).slice(0, 43)}`;

const tool = (toolId: string, overrides: Record<string, unknown> = {}) => ({
  toolId,
  sourceFingerprint: digest('F'),
  name: `tool.${toolId.slice(-1)}`,
  description: 'Reported description.',
  executionKind: 'endpoint',
  method: 'GET',
  path: '/api/tasks',
  operationGroup: 'read',
  riskClass: 'safe-read',
  enabled: true,
  requiresApproval: false,
  inputSchemaDigest: digest('I'),
  outputSchemaDigest: digest('O'),
  ...overrides,
});

const published = [
  tool(LIST),
  tool(UPDATE, { method: 'PATCH', riskClass: 'write', requiresApproval: true }),
  tool(ARCHIVE, { method: 'POST', riskClass: 'write', requiresApproval: true }),
  tool(GONE, { method: 'DELETE', riskClass: 'delete', requiresApproval: true }),
];
const reported = [
  tool(LIST, {
    provenance: {
      policyOrigin: { riskClass: 'code-default', requiresApproval: 'code-default' },
      contractSource: 'derived',
      descriptionSource: 'template',
      schemaSource: 'field-names',
    },
  }),
  tool(UPDATE, {
    method: 'PATCH',
    riskClass: 'write',
    requiresApproval: true,
    inputSchemaDigest: digest('J'),
  }),
  tool(ARCHIVE, { method: 'POST', riskClass: 'delete', requiresApproval: true }),
  tool(EXPORT, { operationGroup: 'needs_attention', enabled: false }),
];

function fixture(options: {
  reports?: unknown[];
  overrides?: unknown[];
  /** Deltas the configuration the environment runs signs. */
  signed?: unknown[];
  active?: boolean;
} = {}) {
  const setup = {
    environmentExists: vi.fn().mockResolvedValue(true),
    findEnvironmentReports: vi.fn().mockResolvedValue(options.reports ?? [{
      environmentId: ENVIRONMENT_ID,
      discoveryDigest: digest('D'),
      reportedAt: new Date('2026-10-05T08:00:00.000Z'),
      runId: RUN_ID,
      artifact: {
        artifactDigest: digest('A'),
        artifact: {
          tools: reported,
          exclusions: [{ stableKey: 'POST /api/webhooks/**', origin: 'default' }],
        },
        generatedAt: new Date(),
        createdAt: new Date(),
      },
    }]),
    listToolOverrides: vi.fn().mockResolvedValue(options.overrides ?? []),
  };
  const configuration = {
    id: 'config-1',
    setupArtifactDigest: digest('P'),
    toolOverrides: options.signed ?? [],
  };
  const store = {
    findPublishedConfiguration: vi.fn().mockResolvedValue(configuration),
    findLatestPublishedConfiguration: vi.fn().mockResolvedValue(configuration),
    findPublishedSetupArtifactTools: vi.fn().mockResolvedValue(published),
  };
  const deployments = {
    list: vi.fn().mockResolvedValue(options.active === false ? [] : [
      { id: 'deployment-1', status: 'active', configRevisionId: 'config-1' },
    ]),
  };
  return {
    setup,
    store,
    service: new CapabilityViewService(
      setup as never,
      store as never,
      deployments as never,
    ),
  };
}

describe('capability view per environment', () => {
  it('says so when the environment never reported its code version', async () => {
    const f = fixture({ reports: [] });

    await expect(f.service.get(scope, ENVIRONMENT_ID)).resolves.toEqual({
      appId: scope.targetAppId,
      environmentId: ENVIRONMENT_ID,
      codeVersion: { status: 'not-reported' },
      comparedTo: null,
      tools: [],
      exclusions: [],
    });
  });

  it('marks every tool by how it changed since the configuration the environment runs', async () => {
    const view = await fixture().service.get(scope, ENVIRONMENT_ID);

    expect(view.codeVersion).toEqual({
      status: 'reported',
      discoveryDigest: digest('D'),
      runId: RUN_ID,
      reportedAt: '2026-10-05T08:00:00.000Z',
    });
    expect(view.comparedTo).toEqual({
      configurationRevisionId: 'config-1',
      discoveryDigest: digest('P'),
    });
    expect(Object.fromEntries(view.tools.map((row) => [row.toolId, row.status])))
      .toEqual({
        [LIST]: 'unchanged',
        [UPDATE]: 'changed',
        [ARCHIVE]: 'risk-raised',
        [EXPORT]: 'needs-attention',
        [GONE]: 'removed',
      });
    expect(view.tools.find((row) => row.toolId === GONE)?.enabled).toBe(false);
    expect(view.exclusions).toEqual([
      { stableKey: 'POST /api/webhooks/**', origin: 'default', status: 'excluded' },
    ]);
  });

  it('shows method, path, risk, confirmation, origin per field and description quality', async () => {
    const view = await fixture().service.get(scope, ENVIRONMENT_ID);

    expect(view.tools.find((row) => row.toolId === LIST)).toEqual({
      toolId: LIST,
      name: 'tool.a',
      description: 'Reported description.',
      presentation: null,
      kind: 'endpoint',
      method: 'GET',
      path: '/api/tasks',
      riskClass: 'safe-read',
      requiresApproval: false,
      enabled: true,
      allowedRoles: [],
      origin: {
        enabled: null,
        requiresApproval: 'code-default',
        riskClass: 'code-default',
        allowedRoles: null,
        description: null,
      },
      status: 'unchanged',
      relaxationPending: false,
      decisionPending: false,
      warnings: [],
      quality: {
        contractSource: 'derived',
        descriptionSource: 'template',
        schemaSource: 'field-names',
      },
    });
  });

  /** A report describes tools; only the bounded decisions shape them. */
  it('never lets a report enable a tool the Platform disabled', async () => {
    const view = await fixture({
      overrides: [
        { toolId: LIST, enabled: false, description: 'Curated.' },
        { toolId: EXPORT, enabled: true },
        {
          toolId: UPDATE,
          requiresApproval: false,
          baselineRiskClass: 'write',
          baselineRequiresApproval: true,
        },
      ],
    }).service.get(scope, ENVIRONMENT_ID);

    expect(view.tools.find((row) => row.toolId === LIST)).toMatchObject({
      enabled: false,
      description: 'Curated.',
      origin: { enabled: 'platform', description: 'platform' },
    });
    expect(view.tools.find((row) => row.toolId === EXPORT)?.enabled).toBe(false);
    expect(view.tools.find((row) => row.toolId === UPDATE)).toMatchObject({
      requiresApproval: true,
      relaxationPending: true,
    });
  });

  /** Saved decisions take effect with an apply; the view says which ones wait. */
  it('marks decisions the environment does not run yet', async () => {
    const view = await fixture({
      overrides: [
        { toolId: LIST, enabled: false },
        { toolId: UPDATE, riskClass: 'delete' },
      ],
      signed: [{ toolId: LIST, enabled: false }],
    }).service.get(scope, ENVIRONMENT_ID);

    expect(view.tools.find((row) => row.toolId === LIST)).toMatchObject({
      enabled: false,
      decisionPending: false,
    });
    expect(view.tools.find((row) => row.toolId === UPDATE)).toMatchObject({
      riskClass: 'delete',
      decisionPending: true,
    });
    const beforeRollout = await fixture({
      overrides: [{ toolId: LIST, enabled: false }],
      signed: [{ toolId: LIST, enabled: false }],
      active: false,
    }).service.get(scope, ENVIRONMENT_ID);
    expect(beforeRollout.tools.find((row) => row.toolId === LIST)?.decisionPending)
      .toBe(true);
  });

  it('compares with the latest published configuration before the first rollout', async () => {
    const f = fixture({ active: false });

    await f.service.get(scope, ENVIRONMENT_ID);

    expect(f.store.findLatestPublishedConfiguration).toHaveBeenCalledWith(scope);
    expect(f.store.findPublishedConfiguration).not.toHaveBeenCalled();
  });

  it('refuses an environment outside the app', async () => {
    const f = fixture();
    f.setup.environmentExists.mockResolvedValue(false);

    await expect(f.service.get(scope, ENVIRONMENT_ID))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('capability view route', () => {
  it('serves GET /v2/apps/:appId/environments/:environmentId/capabilities', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CapabilityViewController))
      .toBe('v2/apps/:appId/environments/:environmentId/capabilities');
    expect(Reflect.getMetadata(
      METHOD_METADATA,
      CapabilityViewController.prototype.get,
    )).toBe(RequestMethod.GET);
  });

  it('keeps an app-bound key inside its own app', async () => {
    const get = vi.fn().mockResolvedValue({});
    const controller = new CapabilityViewController({ get } as never);
    const key = {
      id: scope.tenantId,
      status: 'active',
      apiKeyId: 'key-1',
      targetAppId: '019fb400-0000-7000-8000-0000000000ff',
      scopes: ['management'],
    } as never;

    await expect(controller.get(key, scope.targetAppId, ENVIRONMENT_ID))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(get).not.toHaveBeenCalled();
    await controller.get(
      { id: scope.tenantId, status: 'active', userId: 'owner-1', memberRole: 'owner' } as never,
      scope.targetAppId,
      ENVIRONMENT_ID,
    );
    expect(get).toHaveBeenCalledWith(scope, ENVIRONMENT_ID);
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/capability-view.spec.ts 2>&1 | grep -E "Test Files|Tests |Cannot find module"
```

Expected: `Error: Cannot find module '../capability-view.controller'`, `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Implement**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/capability-view.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DESIRED_STATE_DERIVATION_STORE,
  type DesiredStateDerivationStore,
} from '../runtime-deployments/runtime-desired-state-derivation.service';
import { RuntimeDeploymentService } from '../runtime-deployments/runtime-deployment.service';
import { canonicalRuntimeJson } from '../runtime-revisions/runtime-signing.service';
import {
  RUNTIME_APP_SETUP_STORE,
  type AppSetupScope,
  type RuntimeAppSetupStore,
} from './runtime-setup-v2.store';
import {
  boundToolOverride,
  reportedToolPolicy,
  type ToolOverrideFields,
} from './tool-override';
import { riskTier, type ToolPolicyEntry } from './tool-policy';

export type CapabilityStatus =
  | 'new'
  | 'changed'
  | 'risk-raised'
  | 'removed'
  | 'needs-attention'
  | 'unchanged';

export type CapabilityOrigin = 'code-default' | 'local-policy' | 'platform' | null;

const POLICY_FIELDS = [
  'enabled',
  'requiresApproval',
  'riskClass',
  'allowedRoles',
  'description',
] as const;

type PolicyField = typeof POLICY_FIELDS[number];

export interface CapabilityTool {
  toolId: string;
  name: string;
  description: string | null;
  presentation: Record<string, string> | null;
  kind: 'endpoint' | 'ui';
  method: string | null;
  path: string | null;
  riskClass: string;
  requiresApproval: boolean;
  enabled: boolean;
  allowedRoles: string[];
  /** Per field; null when the report does not say where a value came from. */
  origin: Record<PolicyField, CapabilityOrigin>;
  status: CapabilityStatus;
  /** A Platform relaxation that waits for a committed local entry. */
  relaxationPending: boolean;
  /**
   * The values above include saved decisions that the environment does not
   * run yet: they take effect with the next apply.
   */
  decisionPending: boolean;
  warnings: string[];
  quality: {
    contractSource: string | null;
    descriptionSource: string | null;
    schemaSource: string | null;
  };
}

export interface CapabilityView {
  appId: string;
  environmentId: string;
  codeVersion:
    | { status: 'not-reported' }
    | { status: 'artifact-missing'; discoveryDigest: string; reportedAt: string | null }
    | {
      status: 'reported';
      discoveryDigest: string;
      runId: string;
      reportedAt: string | null;
    };
  /** The published configuration the statuses compare against. */
  comparedTo: { configurationRevisionId: string; discoveryDigest: string } | null;
  tools: CapabilityTool[];
  exclusions: Array<{ stableKey: string; origin: string; status: 'excluded' }>;
}

/**
 * "Was kann mein Chat?" for one environment: the tools its code reported,
 * restricted by the saved, bounded Platform decisions, with the origin of
 * every policy value, whether a decision still waits for an apply
 * (`decisionPending`: the environment runs the deltas its active
 * configuration signs), and how each tool changed since the configuration the
 * environment runs (or, before any rollout, the latest published one).
 * Read-only: neither a report nor this view ever enables a tool.
 */
@Injectable()
export class CapabilityViewService {
  constructor(
    @Inject(RUNTIME_APP_SETUP_STORE)
    private readonly setup: RuntimeAppSetupStore,
    @Inject(DESIRED_STATE_DERIVATION_STORE)
    private readonly published: DesiredStateDerivationStore,
    private readonly deployments: RuntimeDeploymentService,
  ) {}

  async get(scope: AppSetupScope, environmentId: string): Promise<CapabilityView> {
    if (!await this.setup.environmentExists({ ...scope, environmentId })) {
      throw new NotFoundException('Runtime environment not found');
    }
    const view = {
      appId: scope.targetAppId,
      environmentId,
      comparedTo: null,
      tools: [],
      exclusions: [],
    };
    const report = (await this.setup.findEnvironmentReports(scope))
      .find((candidate) => candidate.environmentId === environmentId);
    if (!report) return { ...view, codeVersion: { status: 'not-reported' } };
    const reportedAt = report.reportedAt?.toISOString() ?? null;
    if (!report.artifact || !report.runId) {
      return {
        ...view,
        codeVersion: {
          status: 'artifact-missing',
          discoveryDigest: report.discoveryDigest,
          reportedAt,
        },
      };
    }

    const artifact = report.artifact.artifact;
    const tools = recordList(artifact.tools);
    const comparison = await this.comparison(scope, environmentId);
    const decided = new Map(
      (await this.setup.listToolOverrides(scope))
        .map(({ toolId, ...decision }) => [toolId, decision]),
    );
    const reportedIds = new Set(tools.map((tool) => text(tool.toolId)));
    return {
      ...view,
      codeVersion: {
        status: 'reported',
        discoveryDigest: report.discoveryDigest,
        runId: report.runId,
        reportedAt,
      },
      comparedTo: comparison?.reference ?? null,
      tools: [
        ...tools.map((tool) => this.row(
          tool,
          decided.get(text(tool.toolId) ?? ''),
          comparison?.inForce.get(text(tool.toolId) ?? ''),
          comparison?.tools.get(text(tool.toolId) ?? ''),
          comparison !== null,
        )),
        ...[...comparison?.tools.values() ?? []]
          .filter((tool) => !reportedIds.has(text(tool.toolId)))
          .map((tool) => this.removedRow(tool)),
      ],
      exclusions: recordList(artifact.exclusions).map((exclusion) => ({
        stableKey: text(exclusion.stableKey) ?? '',
        origin: text(exclusion.origin) ?? 'default',
        status: 'excluded' as const,
      })),
    };
  }

  private row(
    tool: Record<string, unknown>,
    decision: ToolOverrideFields | undefined,
    inForce: ToolPolicyEntry | undefined,
    previous: Record<string, unknown> | undefined,
    compared: boolean,
  ): CapabilityTool {
    const reported = reportedToolPolicy(tool);
    const bound = boundToolOverride(reported, decision ?? {});
    const running = boundToolOverride(reported, signedDecision(inForce));
    const provenance = record(tool.provenance);
    const policyOrigin = record(provenance.policyOrigin);
    const origin = Object.fromEntries(POLICY_FIELDS.map((field) => [
      field,
      bound.changedByPlatform[field]
        ? 'platform'
        : (text(policyOrigin[field]) as CapabilityOrigin | undefined) ?? null,
    ])) as Record<PolicyField, CapabilityOrigin>;
    return {
      ...this.identity(tool),
      description: bound.effective.description ?? text(tool.description) ?? null,
      riskClass: bound.effective.riskClass,
      requiresApproval: bound.effective.requiresApproval,
      enabled: bound.effective.enabled,
      allowedRoles: bound.effective.allowedRoles,
      origin,
      status: this.status(tool, previous, compared),
      relaxationPending: bound.relaxationPending,
      decisionPending: canonicalRuntimeJson(bound.effective)
        !== canonicalRuntimeJson(running.effective),
      warnings: bound.warnings.map((warning) => warning.code),
      quality: {
        contractSource: text(provenance.contractSource) ?? null,
        descriptionSource: text(provenance.descriptionSource) ?? null,
        schemaSource: text(provenance.schemaSource) ?? null,
      },
    };
  }

  private removedRow(tool: Record<string, unknown>): CapabilityTool {
    const reported = reportedToolPolicy(tool);
    return {
      ...this.identity(tool),
      description: text(tool.description) ?? null,
      riskClass: reported.riskClass,
      requiresApproval: reported.requiresApproval,
      // Removed code has no binding: it cannot run, whatever was published.
      enabled: false,
      allowedRoles: reported.allowedRoles,
      origin: Object.fromEntries(POLICY_FIELDS.map((field) => [field, null])) as
        Record<PolicyField, CapabilityOrigin>,
      status: 'removed',
      relaxationPending: false,
      decisionPending: false,
      warnings: [],
      quality: { contractSource: null, descriptionSource: null, schemaSource: null },
    };
  }

  private identity(tool: Record<string, unknown>) {
    const presentation = record(tool.presentation);
    return {
      toolId: text(tool.toolId) ?? '',
      name: text(tool.name) ?? '',
      presentation: Object.keys(presentation).length > 0
        ? Object.fromEntries(Object.entries(presentation)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : null,
      kind: tool.executionKind === 'ui' ? 'ui' as const : 'endpoint' as const,
      method: text(tool.method) ?? null,
      path: text(tool.path) ?? null,
    };
  }

  private status(
    tool: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
    compared: boolean,
  ): CapabilityStatus {
    if (tool.operationGroup === 'needs_attention') return 'needs-attention';
    if (!compared || !previous) return 'new';
    const tier = (value: Record<string, unknown>) => riskTier(
      reportedToolPolicy(value).riskClass,
    );
    if (tier(tool) > tier(previous)) return 'risk-raised';
    const identity = [
      'sourceFingerprint',
      'inputSchemaDigest',
      'outputSchemaDigest',
      'method',
      'path',
      'actionBindingRef',
    ];
    return identity.some((field) => tool[field] !== previous[field])
      ? 'changed'
      : 'unchanged';
  }

  /**
   * The tools of the configuration this environment runs; before its first
   * rollout, those of the latest published configuration of the app.
   */
  private async comparison(
    scope: AppSetupScope,
    environmentId: string,
  ): Promise<{
    reference: { configurationRevisionId: string; discoveryDigest: string };
    tools: Map<string, Record<string, unknown>>;
    /** The signed deltas this environment runs; none before its first rollout. */
    inForce: Map<string, ToolPolicyEntry>;
  } | null> {
    const active = (await this.deployments.list({ ...scope, environmentId }))
      .find((deployment) => deployment.status === 'active');
    const configuration = active?.configRevisionId
      ? await this.published.findPublishedConfiguration(scope, active.configRevisionId)
      : await this.published.findLatestPublishedConfiguration(scope);
    if (!configuration) return null;
    const tools = await this.published.findPublishedSetupArtifactTools(
      scope,
      configuration.setupArtifactDigest,
    );
    if (!tools) return null;
    return {
      reference: {
        configurationRevisionId: configuration.id,
        discoveryDigest: configuration.setupArtifactDigest,
      },
      tools: new Map(tools.map((tool) => [text(tool.toolId) ?? '', tool])),
      inForce: new Map((active?.configRevisionId ? configuration.toolOverrides ?? [] : [])
        .map(({ toolId, ...entry }) => [toolId, entry])),
    };
  }
}

/** A signed delta read back as the decision it was bounded from. */
function signedDecision(entry: ToolPolicyEntry | undefined): ToolOverrideFields {
  if (!entry) return {};
  const { pin, reason: _reason, ...decision } = entry;
  return pin ? { ...decision, baselineRiskClass: pin.atRiskClass } : decision;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/capability-view.controller.ts`:

```ts
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant } from '../../common/decorators/tenant.decorator';
import { RequireScopes } from '../../common/decorators/scopes.decorator';
import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
import { type TenantContext } from '../../common/types';
import { CapabilityViewService } from './capability-view.service';

const identifierSchema = z.string().uuid();

/** "Was kann mein Chat?" per environment (spec 4.10, item 7). Read-only. */
@Controller('v2/apps/:appId/environments/:environmentId/capabilities')
@UseGuards(CompositeAuthGuard)
@RequireScopes('management')
export class CapabilityViewController {
  constructor(private readonly capabilities: CapabilityViewService) {}

  @Get()
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('appId') appId: string,
    @Param('environmentId') environmentId: string,
  ) {
    const targetAppId = this.identifier(appId, 'appId');
    const environment = this.identifier(environmentId, 'environmentId');
    if (tenant.status && tenant.status !== 'active') {
      throw new ForbiddenException('The tenant is not active');
    }
    if (tenant.apiKeyId) {
      // An app-bound key sees only its own app; any other answers like an
      // unknown one.
      if (tenant.targetAppId && tenant.targetAppId !== targetAppId) {
        throw new NotFoundException('Target app not found');
      }
    } else if (!tenant.userId || !tenant.memberRole) {
      throw new ForbiddenException('A server-verified principal is required');
    }
    return this.capabilities.get(
      { tenantId: tenant.id, targetAppId },
      environment,
    );
  }

  private identifier(value: string, field: string): string {
    const parsed = identifierSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'app_setup_identifier_invalid',
        paths: [field],
      });
    }
    return parsed.data;
  }
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
@@ -13,10 +13,12 @@ import {
   DrizzleConnectedOverviewStore,
 } from './connected-overview.service';
 import { ToolPolicyRevisionService } from './tool-policy-revision.service';
+import { CapabilityViewController } from './capability-view.controller';
+import { CapabilityViewService } from './capability-view.service';
 
 @Module({
   imports: [StreamModule, RuntimeRevisionModule, RuntimeDeploymentModule],
-  controllers: [RuntimeSetupV2Controller],
+  controllers: [RuntimeSetupV2Controller, CapabilityViewController],
   providers: [
     CompositeAuthGuard,
     DrizzleRuntimeSetupV2Store,
@@ -29,6 +31,7 @@ import { ToolPolicyRevisionService } from './tool-policy-revision.service';
     DrizzleConnectedOverviewStore,
     ConnectedOverviewService,
     ToolPolicyRevisionService,
+    CapabilityViewService,
   ],
   exports: [
     RuntimeSetupV2Service,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/capability-view.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  9 passed (9)`; `Test Files  119 passed (119)`, `Tests  1272 passed | 10 skipped (1282)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/capability-view.service.ts apps/api/src/modules/runtime-setup-v2/capability-view.controller.ts apps/api/src/modules/runtime-setup-v2/__tests__/capability-view.spec.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.module.ts
git commit -m "feat(runtime-setup): show what each environment's chat can do"
```

---

### Task 11: API – offer apply only for Platform-side changes

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts:14-15,37,99-114,127-187`; `publish-and-deploy.service.ts:29,50,57-64,187-194`; `runtime-setup-v2.store.ts:74`; `drizzle-runtime-setup-v2.store.ts:77`; `runtime-setup-v2.service.ts:212`; `apps/api/scripts/verify-connected-free-rehearsal.ts:24,28,218`; specs `connected-overview.service.spec.ts:4,18,37,54-66,76-85,221`, `publish-and-deploy.service.spec.ts:41,102-110,404`, `runtime-setup-v2.service.spec.ts:113`
- Test: `connected-overview.service.spec.ts`, `publish-and-deploy.service.spec.ts`

**Interfaces:**
- Consumes: Task 8's `applyConfiguration`, `configurationApplyId`, `ToolPolicyRevisionService.target`; `assertConnectedApplyPipeline`, `lockEnvironmentPipeline`, `readEnvironmentPipeline`, `CONNECTED_APPLY_FRESHNESS_MS`.
- Produces:
  - `type PendingPlatformChange = { kind: 'configuration'; configurationRevisionId } | { kind: 'unpublished-decisions' }`, derived from `ToolPolicyRevisionService.target(appScope)` (the constructor gains it; same module): a `policy-only` target that the environment's active deployment does not pin is pending; a `published` target is not (it rolls out with its run); `unpublished-decisions` stays as is. Never "the newest draft": with deterministic ids, a decision changed back leaves an older draft behind, and applying it (self-approved for owners) would revive the reverted decision.
  - `ConnectedOverviewService.get` keeps its response shape; `action`: `sync` when not connected; `resume` for a run composite awaiting health or a pending decision deployment (`configurationApplyId`) not yet healthy; `apply` for a pending configuration, or for a ready run while decisions exist and nothing was published; `resume` for a published run without its composite; `none` for a ready run otherwise (new tools run without apply) and for an active composite; `sync` for failed or missing runs. A run composite that a decision apply superseded (`superseded`, same `runtimeDigest` as the active deployment) stays `active`, because a policy-only revision never rebinds code; before this, every decision apply turned the candidate into `failed` and the action into `sync`. New `pendingConfiguration(scope & { environmentId }): Promise<string | null>`.
  - `PublishAndDeployService.runConnected` applies a pending configuration (through `applyConfigurationTo(…, connected = true)`) before it would republish the run; `assertConnectedEnvironment` keeps the connected guarantees (first pipeline environment only, runner seen within `CONNECTED_APPLY_FRESHNESS_MS`) without claiming a run. The constructor gains `ConnectedOverviewService` (same module); the rehearsal script wires it and `ToolPolicyRevisionService`.
  - Prompt- and budget-only revisions: `createPromptOnlyRevision` has no production caller and there is no budget revision type, so `target` covers every Platform-side change that exists today; a future producer must extend it.

The existing overview test "returns bounded Connected Free state for a ready candidate" expected `action: 'apply'`; it becomes `'none'` (spec 4.10.10: new tools no longer need sync or apply). Every other overview test keeps its expectation.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
@@ -1,7 +1,7 @@
 import { NotFoundException } from '@nestjs/common';
 import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
 import { ConnectedOverviewService } from '../connected-overview.service';
-import { publishAndDeployId } from '../publish-and-deploy-id';
+import { configurationApplyId, publishAndDeployId } from '../publish-and-deploy-id';
 
 const scope = {
   tenantId: '019fb200-0000-7000-8000-000000000001',
@@ -16,6 +16,8 @@ function fixture(options: {
   environment?: { status: string; lastSeenAt: Date | null } | null;
   runStatus?: string | null;
   deployments?: Array<Record<string, unknown>>;
+  /** What `ToolPolicyRevisionService.target` answers. */
+  target?: unknown;
 } = {}) {
   const store = {
     readEnvironment: vi.fn().mockResolvedValue(
@@ -54,13 +56,18 @@ function fixture(options: {
   const deployments = {
     list: vi.fn().mockResolvedValue(options.deployments ?? []),
   };
+  const policyRevisions = {
+    target: vi.fn().mockResolvedValue(options.target ?? null),
+  };
   return {
     store,
     setup,
     deployments,
+    policyRevisions,
     service: new ConnectedOverviewService(
       store as never,
       deployments as never,
+      policyRevisions as never,
     ),
   };
 }
@@ -73,7 +80,8 @@ describe('ConnectedOverviewService', () => {
 
   afterEach(() => vi.useRealTimers());
 
-  it('returns bounded Connected Free state for a ready candidate', async () => {
+  /** New tools run as soon as the code reports them (spec 4.10, item 10). */
+  it('returns bounded Connected Free state for a ready candidate without asking to apply it', async () => {
     const f = fixture();
 
     await expect(f.service.get(scope, environmentId)).resolves.toEqual({
@@ -82,7 +90,7 @@ describe('ConnectedOverviewService', () => {
       runtimeHealth: 'unknown',
       activeDeployment: null,
       candidate: { runId, artifactDigest: digest, status: 'ready' },
-      action: 'apply',
+      action: 'none',
     });
     expect(f.store.readEnvironment).toHaveBeenCalledWith({
       ...scope,
@@ -219,4 +227,89 @@ describe('ConnectedOverviewService', () => {
     expect(f.deployments.list).not.toHaveBeenCalled();
   });
 
+  it('offers apply for a decision revision that is not active yet, then resume', async () => {
+    const configurationRevisionId = '019fb200-0000-7000-8000-0000000000c2';
+    const target = { kind: 'policy-only', configurationRevisionId };
+
+    await expect(fixture({ runStatus: 'published', target }).service
+      .get(scope, environmentId)).resolves.toMatchObject({ action: 'apply' });
+    await expect(fixture({
+      runStatus: 'published',
+      target,
+      deployments: [{
+        id: configurationApplyId(configurationRevisionId, environmentId),
+        status: 'pending',
+        healthStatus: 'unknown',
+        activatedAt: null,
+      }],
+    }).service.get(scope, environmentId)).resolves.toMatchObject({ action: 'resume' });
+  });
+
+  /**
+   * A decision apply supersedes the run's deployment without changing its
+   * code, and a draft left behind by a decision that was changed back is never
+   * offered: only the revision that signs the current decisions counts.
+   */
+  it('stays quiet when the environment runs what the current decisions require', async () => {
+    const runtimeDigest = `sha256:${'R'.repeat(43)}`;
+    const applied = '019fb200-0000-7000-8000-0000000000c2';
+    const deployments = [
+      {
+        id: publishAndDeployId(runId, environmentId),
+        status: 'superseded',
+        healthStatus: 'healthy',
+        activatedAt: new Date('2026-08-14T08:00:00.000Z'),
+        configRevisionId: '019fb200-0000-7000-8000-0000000000c1',
+        runtimeDigest,
+      },
+      {
+        id: configurationApplyId(applied, environmentId),
+        status: 'active',
+        healthStatus: 'healthy',
+        activatedAt: new Date('2026-08-14T09:00:00.000Z'),
+        configRevisionId: applied,
+        runtimeDigest,
+      },
+    ];
+
+    await expect(fixture({
+      runStatus: 'published',
+      deployments,
+      target: { kind: 'policy-only', configurationRevisionId: applied },
+    }).service.get(scope, environmentId)).resolves.toMatchObject({
+      candidate: { status: 'active' },
+      action: 'none',
+    });
+    await expect(fixture({
+      runStatus: 'published',
+      deployments: [{ ...deployments[0], status: 'active' }],
+      target: {
+        kind: 'published',
+        configurationRevisionId: '019fb200-0000-7000-8000-0000000000c1',
+      },
+    }).service.get(scope, environmentId)).resolves.toMatchObject({ action: 'none' });
+  });
+
+  it('offers apply for decisions saved before anything was published', async () => {
+    const f = fixture({ target: { kind: 'unpublished-decisions' } });
+
+    await expect(f.service.get(scope, environmentId)).resolves.toMatchObject({
+      candidate: { status: 'ready' },
+      action: 'apply',
+    });
+  });
+
+  it('names the configuration an apply has to roll out', async () => {
+    const configurationRevisionId = '019fb200-0000-7000-8000-0000000000c2';
+    const f = fixture({ target: { kind: 'policy-only', configurationRevisionId } });
+
+    await expect(f.service.pendingConfiguration({ ...scope, environmentId }))
+      .resolves.toBe(configurationRevisionId);
+    expect(f.policyRevisions.target).toHaveBeenCalledWith(scope);
+    await expect(fixture({ target: { kind: 'unpublished-decisions' } }).service
+      .pendingConfiguration({ ...scope, environmentId })).resolves.toBeNull();
+    await expect(fixture({
+      target: { kind: 'published', configurationRevisionId },
+    }).service.pendingConfiguration({ ...scope, environmentId })).resolves.toBeNull();
+  });
 });
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
@@ -39,6 +39,7 @@ function fixture(overrides: { status?: string; deployments?: unknown[] } = {}) {
   } : null;
   const setup = {
     assertEnvironment: vi.fn().mockResolvedValue(undefined),
+    assertConnectedEnvironment: vi.fn().mockResolvedValue(undefined),
     claimConnectedApply: vi.fn().mockResolvedValue(undefined),
     getRun: vi.fn().mockResolvedValue({ status: overrides.status ?? 'ready' }),
     reviewedArtifact: vi.fn().mockResolvedValue({ appId: scope.targetAppId }),
@@ -100,14 +101,18 @@ function fixture(overrides: { status?: string; deployments?: unknown[] } = {}) {
       id: deploymentId, status: 'active', healthStatus: 'healthy',
     })),
   };
+  const overview = {
+    pendingConfiguration: vi.fn().mockResolvedValue(null),
+  };
   return {
-    setup, configurations, revisions, derivation, deployments,
+    setup, configurations, revisions, derivation, deployments, overview,
     service: new PublishAndDeployService(
       setup as never,
       configurations as never,
       revisions as never,
       derivation as never,
       deployments as never,
+      overview as never,
     ),
   };
 }
@@ -402,6 +407,48 @@ describe('PublishAndDeployService', () => {
     expect(f.derivation.deployLatestPublished).not.toHaveBeenCalled();
   });
 
+  it('applies a pending decision revision instead of republishing the run', async () => {
+    const f = fixture({ status: 'published' });
+    const pending = '019fb200-0000-7000-8000-0000000000c3';
+    f.overview.pendingConfiguration.mockResolvedValue(pending);
+
+    const result = await f.service.runConnected(scope, runId, {
+      environmentId,
+      reason: 'Connected update apply',
+    }, actor);
+
+    expect(f.setup.claimConnectedApply).not.toHaveBeenCalled();
+    expect(f.setup.assertConnectedEnvironment).toHaveBeenCalledWith({
+      ...scope,
+      environmentId,
+    });
+    expect(f.configurations.createFromReviewedSetup).not.toHaveBeenCalled();
+    expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+      { ...scope, environmentId },
+      pending,
+      expect.objectContaining({
+        deploymentId: configurationApplyId(pending, environmentId),
+      }),
+      expect.anything(),
+    );
+    expect(result.compositeId).toBe(configurationApplyId(pending, environmentId));
+  });
+
+  it('keeps the connected guarantees when it applies a decision revision', async () => {
+    const f = fixture({ status: 'published' });
+    f.overview.pendingConfiguration.mockResolvedValue('019fb200-0000-7000-8000-0000000000c3');
+    f.setup.assertConnectedEnvironment.mockRejectedValueOnce(
+      new ConflictException({ code: 'connected_apply_environment_not_first' }),
+    );
+
+    await expect(f.service.runConnected(scope, runId, {
+      environmentId,
+      reason: 'Connected update apply',
+    }, actor)).rejects.toBeInstanceOf(ConflictException);
+    expect(f.revisions.findStatus).not.toHaveBeenCalled();
+    expect(f.derivation.deployPublishedConfiguration).not.toHaveBeenCalled();
+  });
+
   describe('applying an app configuration', () => {
     const configurationId = '019fb200-0000-7000-8000-0000000000c2';
     const configuration = {
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
@@ -111,6 +111,7 @@ describe('RuntimeSetupV2Service', () => {
     store = {
       appExists: vi.fn().mockResolvedValue(true),
       environmentExists: vi.fn().mockResolvedValue(true),
+      assertConnectedEnvironment: vi.fn().mockResolvedValue(undefined),
       claimConnectedApply: vi.fn().mockResolvedValue(undefined),
       readConnectedApplyInputs: vi.fn(),
       findRun: vi.fn().mockResolvedValue(null),
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: `Test Files  2 failed (2)`, `Tests  6 failed | 27 passed (33)`: the ready candidate still says `apply`, "offers apply for a decision revision that is not active yet, then resume" (`resume` for the published run), "stays quiet when the environment runs what the current decisions require" (the superseded run composite reads as `failed`, action `sync`), "names the configuration an apply has to roll out" (no `pendingConfiguration`), and both new `runConnected` tests (the run is republished, no pipeline check). "offers apply for decisions saved before anything was published" already passes (a ready run says `apply` today).

- [ ] **Step 3: Implement**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/scripts/verify-connected-free-rehearsal.ts b/apps/api/scripts/verify-connected-free-rehearsal.ts
--- a/apps/api/scripts/verify-connected-free-rehearsal.ts
+++ b/apps/api/scripts/verify-connected-free-rehearsal.ts
@@ -22,9 +22,14 @@ import { RuntimeAppConfigurationService } from '../src/modules/runtime-revisions
 import { DrizzleRuntimeRevisionStore } from '../src/modules/runtime-revisions/drizzle-runtime-revision.store';
 import { RuntimeRevisionService } from '../src/modules/runtime-revisions/runtime-revision.service';
 import { RuntimeSigningService } from '../src/modules/runtime-revisions/runtime-signing.service';
+import {
+  ConnectedOverviewService,
+  DrizzleConnectedOverviewStore,
+} from '../src/modules/runtime-setup-v2/connected-overview.service';
 import { DrizzleRuntimeSetupV2Store } from '../src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store';
 import { PublishAndDeployService } from '../src/modules/runtime-setup-v2/publish-and-deploy.service';
 import { RuntimeSetupV2Service } from '../src/modules/runtime-setup-v2/runtime-setup-v2.service';
+import { ToolPolicyRevisionService } from '../src/modules/runtime-setup-v2/tool-policy-revision.service';
 
 export const PILOT_DATABASE_FILE = '/private/tmp/glirastes-foundation-db-url';
 export const PILOT_DATABASE_HOST = 'ep-fancy-bar-a99yrq8q.gwc.azure.neon.tech';
@@ -215,7 +220,9 @@ export async function runConnectedFreeRehearsal(): Promise<ConnectedFreeRehearsa
         const deployments = new RuntimeDeploymentService(new DrizzleRuntimeDeploymentStore(tx), stream, signing);
         const derivation = new RuntimeDesiredStateDerivationService(new DrizzleDesiredStateDerivationStore(tx), revisions, deployments, signing);
         const setup = new RuntimeSetupV2Service(new DrizzleRuntimeSetupV2Store(tx), stream);
-        const publish = new PublishAndDeployService(setup, configurations, revisions, derivation, deployments);
+        const policyRevisions = new ToolPolicyRevisionService(new DrizzleRuntimeSetupV2Store(tx), new DrizzleDesiredStateDerivationStore(tx), configurations);
+        const overview = new ConnectedOverviewService(new DrizzleConnectedOverviewStore(tx), deployments, policyRevisions);
+        const publish = new PublishAndDeployService(setup, configurations, revisions, derivation, deployments, overview);
         const pipeline = new EnvironmentPipelineService(new DrizzleEnvironmentPipelineStore(tx), publish);
         const entitlements = new PlatformEntitlementService(tx);
         const apps = new AppsService(tx, entitlements, pipeline);
diff --git a/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts b/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts
@@ -11,8 +11,12 @@ import {
   RuntimeDeploymentService,
   type RuntimeDeploymentSummary,
 } from '../runtime-deployments/runtime-deployment.service';
-import { publishAndDeployId } from './publish-and-deploy-id';
+import { configurationApplyId, publishAndDeployId } from './publish-and-deploy-id';
 import { type AppSetupScope } from './runtime-setup-v2.store';
+import {
+  ToolPolicyRevisionService,
+  type PolicyRevisionTarget,
+} from './tool-policy-revision.service';
 
 const CONNECTED_FRESHNESS_MS = 90_000;
 const HEALTH_STATUSES = new Set([
@@ -35,6 +39,15 @@ export interface ConnectedOverview {
   action: 'sync' | 'apply' | 'resume' | 'none';
 }
 
+/**
+ * A Platform-side change that is not active in the environment yet: the
+ * policy-only revision that signs the current decisions, or decisions saved
+ * before anything was published at all.
+ */
+export type PendingPlatformChange =
+  | { kind: 'configuration'; configurationRevisionId: string }
+  | { kind: 'unpublished-decisions' };
+
 interface ConnectedCandidateRecord {
   runId: string;
   status: string;
@@ -99,6 +112,7 @@ export class ConnectedOverviewService {
   constructor(
     private readonly store: DrizzleConnectedOverviewStore,
     private readonly deployments: RuntimeDeploymentService,
+    private readonly policyRevisions: ToolPolicyRevisionService,
   ) {}
 
   async get(
@@ -111,9 +125,10 @@ export class ConnectedOverviewService {
       throw new NotFoundException('Runtime environment not found');
     }
 
-    const [run, deployments] = await Promise.all([
+    const [run, deployments, target] = await Promise.all([
       this.store.readCandidate(appScope),
       this.deployments.list(scope),
+      this.policyRevisions.target(appScope),
     ]);
     const connection = this.connection(
       environment.status,
@@ -127,7 +142,7 @@ export class ConnectedOverviewService {
     const active = deployments.find((deployment) => (
       deployment.status === 'active' && deployment.activatedAt instanceof Date
     ));
-    const candidate = this.candidate(run, composite);
+    const candidate = this.candidate(run, composite, active);
     const runtimeHealth = this.health(composite?.healthStatus)
       ?? this.health(active?.healthStatus)
       ?? 'unknown';
@@ -142,10 +157,49 @@ export class ConnectedOverviewService {
         ? { id: active.id, activatedAt: active.activatedAt!.toISOString() }
         : null,
       candidate,
-      action: this.action(connection, candidate?.status),
+      action: this.action(
+        connection,
+        candidate?.status,
+        this.pendingChange(target, deployments),
+        deployments,
+        environmentId,
+      ),
     };
   }
 
+  /** The configuration an apply of this environment has to roll out, if any. */
+  async pendingConfiguration(
+    scope: AppSetupScope & { environmentId: string },
+  ): Promise<string | null> {
+    const [target, deployments] = await Promise.all([
+      this.policyRevisions.target({
+        tenantId: scope.tenantId,
+        targetAppId: scope.targetAppId,
+      }),
+      this.deployments.list(scope),
+    ]);
+    const pending = this.pendingChange(target, deployments);
+    return pending?.kind === 'configuration' ? pending.configurationRevisionId : null;
+  }
+
+  /**
+   * Only the revision that signs the current decisions counts, never "the
+   * newest draft": a draft left behind by a decision that was changed back
+   * must not be applied. Decisions the latest publication already signs roll
+   * out with that publication (its run's apply or resume).
+   */
+  private pendingChange(
+    target: PolicyRevisionTarget | null,
+    deployments: RuntimeDeploymentSummary[],
+  ): PendingPlatformChange | null {
+    if (!target || target.kind === 'published') return null;
+    if (target.kind === 'unpublished-decisions') return target;
+    const active = deployments.find((deployment) => deployment.status === 'active');
+    return active?.configRevisionId === target.configurationRevisionId
+      ? null
+      : { kind: 'configuration', configurationRevisionId: target.configurationRevisionId };
+  }
+
   private connection(
     status: string,
     lastSeenAt: Date | null,
@@ -159,6 +213,7 @@ export class ConnectedOverviewService {
   private candidate(
     run: ConnectedCandidateRecord | null,
     deployment?: RuntimeDeploymentSummary,
+    active?: RuntimeDeploymentSummary,
   ): ConnectedOverview['candidate'] {
     if (!run?.artifactDigest || !this.boundedDigest(run.artifactDigest)) {
       return null;
@@ -167,21 +222,45 @@ export class ConnectedOverviewService {
     if (run.status === 'failed') status = 'failed';
     else if (deployment?.status === 'active') status = 'active';
     else if (deployment?.status === 'pending') status = 'awaiting_health';
-    else if (deployment) status = 'failed';
+    else if (
+      deployment?.status === 'superseded'
+      && active !== undefined
+      && typeof deployment.runtimeDigest === 'string'
+      && active.runtimeDigest === deployment.runtimeDigest
+    ) {
+      // A decision (policy-only) apply superseded the run's deployment
+      // without rebinding its code: the run is still what runs.
+      status = 'active';
+    } else if (deployment) status = 'failed';
     return { runId: run.runId, artifactDigest: run.artifactDigest, status };
   }
 
+  /**
+   * New tools run as soon as the code reports them, so a ready candidate on
+   * its own needs no apply (spec 4.10, item 10). Apply is offered only for a
+   * Platform-side change that is not active in this environment yet.
+   */
   private action(
     connection: ConnectedOverview['connection'],
-    candidateStatus?: string,
+    candidateStatus: string | undefined,
+    pending: PendingPlatformChange | null,
+    deployments: RuntimeDeploymentSummary[],
+    environmentId: string,
   ): ConnectedOverview['action'] {
     if (connection !== 'connected') return 'sync';
-    if (candidateStatus === 'ready') return 'apply';
+    if (candidateStatus === 'awaiting_health') return 'resume';
+    if (pending?.kind === 'configuration') {
+      const applying = deployments.find((deployment) => deployment.id === configurationApplyId(
+        pending.configurationRevisionId,
+        environmentId,
+      ));
+      return applying?.status === 'pending' ? 'resume' : 'apply';
+    }
+    if (candidateStatus === 'published') return 'resume';
+    if (candidateStatus === 'ready') {
+      return pending?.kind === 'unpublished-decisions' ? 'apply' : 'none';
+    }
     if (candidateStatus === 'active') return 'none';
-    if (
-      candidateStatus === 'published'
-      || candidateStatus === 'awaiting_health'
-    ) return 'resume';
     return 'sync';
   }
 
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -75,6 +75,33 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
     return Boolean(environment);
   }
 
+  async assertConnectedEnvironment(
+    input: Parameters<RuntimeAppSetupStore['assertConnectedEnvironment']>[0],
+  ): Promise<void> {
+    await this.db.transaction(async (tx) => {
+      await lockEnvironmentPipeline(tx, input);
+      const pipeline = await readEnvironmentPipeline(tx, input);
+      assertConnectedApplyPipeline(pipeline, input.environmentId);
+      const [environment] = await tx.select({
+        status: runtimeEnvironments.status,
+        lastSeenAt: runtimeEnvironments.lastSeenAt,
+      }).from(runtimeEnvironments).where(and(
+        eq(runtimeEnvironments.tenantId, input.tenantId),
+        eq(runtimeEnvironments.targetAppId, input.targetAppId),
+        eq(runtimeEnvironments.id, input.environmentId),
+      )).limit(1);
+      if (
+        !environment
+        || environment.status !== 'connected'
+        || !environment.lastSeenAt
+        || input.now.getTime() - environment.lastSeenAt.getTime()
+          > CONNECTED_APPLY_FRESHNESS_MS
+      ) {
+        throw new ConflictException('Connected runtime is not fresh');
+      }
+    });
+  }
+
   async claimConnectedApply(
     input: Parameters<RuntimeAppSetupStore['claimConnectedApply']>[0],
   ): Promise<void> {
diff --git a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
@@ -27,6 +27,7 @@ import {
   RuntimeSetupV2Service,
   type AppSetupPublicationState,
 } from './runtime-setup-v2.service';
+import { ConnectedOverviewService } from './connected-overview.service';
 import {
   configurationApplyId,
   configurationPublicationId,
@@ -48,6 +49,7 @@ export class PublishAndDeployService {
     private readonly revisions: RuntimeRevisionService,
     private readonly derivation: RuntimeDesiredStateDerivationService,
     private readonly deployments: RuntimeDeploymentService,
+    private readonly overview: ConnectedOverviewService,
   ) {}
 
   async run(
@@ -59,12 +61,25 @@ export class PublishAndDeployService {
     return this.execute(appScope, runId, input, actor, false);
   }
 
+  /**
+   * The dashboard's single apply: a Platform-side change that is not active
+   * in the environment yet (a configuration drafted from saved decisions)
+   * wins; otherwise the candidate run is published and deployed as before.
+   */
   async runConnected(
     appScope: { tenantId: string; targetAppId: string },
     runId: string,
     input: { environmentId: string; reason: string },
     actor: RuntimeActor,
   ): Promise<PublishAndDeployResult> {
+    this.assertActorCanRun(actor);
+    const pending = await this.overview.pendingConfiguration({
+      ...appScope,
+      environmentId: input.environmentId,
+    });
+    if (pending) {
+      return this.applyConfigurationTo(appScope, pending, input, actor, true);
+    }
     return this.execute(appScope, runId, input, actor, true);
   }
 
@@ -185,13 +200,35 @@ export class PublishAndDeployService {
     configurationRevisionId: string,
     input: { environmentId: string; reason: string },
     actor: RuntimeActor,
+  ): Promise<PublishAndDeployResult> {
+    return this.applyConfigurationTo(
+      appScope,
+      configurationRevisionId,
+      input,
+      actor,
+      false,
+    );
+  }
+
+  private async applyConfigurationTo(
+    appScope: { tenantId: string; targetAppId: string },
+    configurationRevisionId: string,
+    input: { environmentId: string; reason: string },
+    actor: RuntimeActor,
+    connected: boolean,
   ): Promise<PublishAndDeployResult> {
     this.assertActorCanRun(actor);
     const scope: RuntimeDeploymentScope = {
       ...appScope,
       environmentId: input.environmentId,
     };
-    await this.setup.assertEnvironment(scope);
+    if (connected) {
+      // The dashboard apply keeps the connected guarantees: first pipeline
+      // environment only, and a runner that is actually there.
+      await this.setup.assertConnectedEnvironment(scope);
+    } else {
+      await this.setup.assertEnvironment(scope);
+    }
     const configuration = {
       ...appScope,
       type: 'config' as const,
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
@@ -210,6 +210,12 @@ export class RuntimeSetupV2Service {
     }
   }
 
+  async assertConnectedEnvironment(
+    scope: AppSetupScope & { environmentId: string },
+  ): Promise<void> {
+    await this.store.assertConnectedEnvironment({ ...scope, now: new Date() });
+  }
+
   async claimConnectedApply(
     scope: AppSetupScope & { environmentId: string },
     runId: string,
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
@@ -72,6 +72,15 @@ export interface RuntimeAppSetupStore {
   environmentExists(
     scope: AppSetupScope & { environmentId: string },
   ): Promise<boolean>;
+  /**
+   * The checks of a connected apply without claiming a setup run: the
+   * environment is the first of its pipeline (Connected Free owns exactly
+   * one) and its runner was seen recently.
+   */
+  assertConnectedEnvironment(input: AppSetupScope & {
+    environmentId: string;
+    now: Date;
+  }): Promise<void>;
   claimConnectedApply(input: AppSetupScope & {
     environmentId: string;
     runId: string;
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  33 passed (33)`; `Test Files  119 passed (119)`, `Tests  1278 passed | 10 skipped (1288)`; `typecheck=0` (the typecheck covers `scripts/verify-connected-free-rehearsal.ts`).

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts apps/api/scripts/verify-connected-free-rehearsal.ts apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
git commit -m "feat(runtime-setup): offer apply only for platform-side changes"
```

---

### Task 12: API – keep app-bound keys inside their app on audit, stream, gate and deployments

**Files:**
- Create: `apps/api/src/common/app-scope.ts`, `apps/api/src/common/__tests__/app-scope-gaps.spec.ts`
- Modify: `apps/api/src/modules/audit/audit.controller.ts:18-20,60-67,100-108,123,141-146,169,193,208-211`; `apps/api/src/modules/audit/audit.service.ts:7-14,70,133-141,172-180,198-202,287-294`; `apps/api/src/modules/audit/__tests__/audit.service.spec.ts:1,45,117-147`; `apps/api/src/modules/stream/stream.controller.ts:5,20`; `apps/api/src/modules/gate/gate-config.controller.ts:16,140`; `apps/api/src/modules/runtime-deployments/runtime-deployment.controller.ts:14,64-75`
- Test: `app-scope-gaps.spec.ts`, `audit.service.spec.ts`

**Interfaces:**
- Consumes: P08a's `TenantWideOnly()` and `TenantContext.targetAppId` (set only for API keys bound to an app).
- Produces: `boundAppOf(tenant): string | undefined`, `appScopeFor(tenant, requestedAppId?): string | undefined` (404 `App not found` for another app; dashboard sessions and tenant-wide keys keep the requested scope, `undefined` = tenant-wide). `AuditService.queryEvents`/`queryTraces` accept `targetAppId`, `getSessionDetail`/`getTrace` take a third `targetAppId?` (SQL `audit_events.target_app_id = $n`); `POST /v1/audit/export` and `GET /v1/audit/export/:jobId` are `@TenantWideOnly()`, and `AuditService.getExportStatus(tenantId, jobId)` answers a job of another tenant with 404 like an unknown one (queue job ids are sequential integers, so any management key could enumerate them before); `GET /v1/stream/events`, `GET /v1/gate/tool-access` and `GET /v1/apps/:appId/environments/:environmentId/deployments` apply `appScopeFor`.

Gap before this task (proved by Step 1): with the one-day app-bound setup credential (or an unremediated legacy pairing key, P08a Task 23), `GET /v1/audit/events|sessions|traces` return every app's events, `/v1/stream/events` without `targetAppId` streams every app, the gate matrix lists every app's tools, and the deployment list answers for any `:appId`. Independently of app binding, `GET /v1/audit/export/:jobId` returns the download URL of any tenant's export job to any management key, because the job is looked up by its sequential id alone.

- [ ] **Step 1: Write the failing tests (they prove the gap)**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/common/__tests__/app-scope-gaps.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import { TENANT_WIDE_ONLY } from '../decorators/app-scope.decorator';
import { AuditController } from '../../modules/audit/audit.controller';
import { GateConfigController } from '../../modules/gate/gate-config.controller';
import { RuntimeDeploymentController } from '../../modules/runtime-deployments/runtime-deployment.controller';
import { StreamController } from '../../modules/stream/stream.controller';

const TENANT_ID = '019fb500-0000-7000-8000-000000000001';
const OWN_APP = '019fb500-0000-7000-8000-000000000002';
const OTHER_APP = '019fb500-0000-7000-8000-000000000003';
const ENVIRONMENT_ID = '019fb500-0000-7000-8000-000000000004';

const appKey = {
  id: TENANT_ID,
  slug: 'acme',
  plan: 'free' as const,
  status: 'active' as const,
  scopes: ['management'],
  apiKeyId: 'key-1',
  targetAppId: OWN_APP,
};
const dashboard = {
  id: TENANT_ID,
  slug: 'acme',
  plan: 'free' as const,
  status: 'active' as const,
  scopes: ['management'],
  userId: 'owner-1',
  memberRole: 'owner',
};

describe('app-bound keys on /v1/audit', () => {
  function audit() {
    const service = {
      queryEvents: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
      querySessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
      getSessionDetail: vi.fn().mockResolvedValue({ traceId: 'trace-1', events: [] }),
      queryTraces: vi.fn().mockResolvedValue({ traces: [], nextCursor: null }),
      getTrace: vi.fn().mockResolvedValue({ events: [] }),
      getExportStatus: vi.fn().mockResolvedValue({ status: 'pending' }),
    };
    return { service, controller: new AuditController(service as never) };
  }

  it('limits events, sessions and traces to the key app', async () => {
    const { service, controller } = audit();

    await controller.queryEvents(appKey);
    await controller.querySessions(appKey);
    await controller.getSessionDetail(appKey, 'trace-1');
    await controller.queryTraces(appKey);
    await controller.getTrace(appKey, 'trace-1');

    expect(service.queryEvents).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ targetAppId: OWN_APP }),
    );
    expect(service.querySessions).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ targetAppId: OWN_APP }),
    );
    expect(service.getSessionDetail).toHaveBeenCalledWith(TENANT_ID, 'trace-1', OWN_APP);
    expect(service.queryTraces).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ targetAppId: OWN_APP }),
    );
    expect(service.getTrace).toHaveBeenCalledWith(TENANT_ID, 'trace-1', OWN_APP);
  });

  it('answers a session filter for another app like an unknown app', async () => {
    const { service, controller } = audit();

    await expect(controller.querySessions(
      appKey,
      undefined,
      undefined,
      undefined,
      undefined,
      OTHER_APP,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(service.querySessions).not.toHaveBeenCalled();
  });

  it('keeps the dashboard view tenant-wide', async () => {
    const { service, controller } = audit();

    await controller.queryEvents(dashboard);
    await controller.getSessionDetail(dashboard, 'trace-1');

    expect(service.queryEvents).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ targetAppId: undefined }),
    );
    expect(service.getSessionDetail).toHaveBeenCalledWith(TENANT_ID, 'trace-1', undefined);
  });

  it('keeps tenant-wide exports away from app-bound keys and inside the tenant', async () => {
    expect(Reflect.getMetadata(TENANT_WIDE_ONLY, AuditController.prototype.startExport))
      .toBe(true);
    expect(Reflect.getMetadata(TENANT_WIDE_ONLY, AuditController.prototype.getExportStatus))
      .toBe(true);

    const { service, controller } = audit();
    await controller.getExportStatus(dashboard, '7');
    expect(service.getExportStatus).toHaveBeenCalledWith(TENANT_ID, '7');
  });
});

describe('app-bound keys on /v1/stream', () => {
  it('subscribes to the key app only and refuses another app', async () => {
    const subscribe = vi.fn().mockReturnValue(of({ type: 'ping', timestamp: 'now' }));
    const controller = new StreamController({ subscribe } as never);

    await firstValueFrom(controller.events(appKey));
    expect(subscribe).toHaveBeenCalledWith(TENANT_ID, OWN_APP);
    expect(() => controller.events(appKey, OTHER_APP)).toThrow(NotFoundException);

    await firstValueFrom(controller.events(dashboard));
    expect(subscribe).toHaveBeenLastCalledWith(TENANT_ID, undefined);
  });
});

describe('app-bound keys on the gate tool-access matrix', () => {
  it('reads the key app only and refuses another app', async () => {
    const getToolAccess = vi.fn().mockResolvedValue([]);
    const controller = new GateConfigController({ getToolAccess } as never);

    await controller.getToolAccess(appKey);
    expect(getToolAccess).toHaveBeenCalledWith(TENANT_ID, OWN_APP);
    await expect(controller.getToolAccess(appKey, OTHER_APP))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(getToolAccess).toHaveBeenCalledTimes(1);
  });
});

describe('app-bound keys on the deployment list', () => {
  it('lists deployments of the key app only', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const controller = new RuntimeDeploymentController({ list } as never, {} as never);

    await expect(controller.list(appKey, OTHER_APP, ENVIRONMENT_ID))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(list).not.toHaveBeenCalled();
    await controller.list(appKey, OWN_APP, ENVIRONMENT_ID);
    expect(list).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      targetAppId: OWN_APP,
      environmentId: ENVIRONMENT_ID,
    });
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/audit/__tests__/audit.service.spec.ts b/apps/api/src/modules/audit/__tests__/audit.service.spec.ts
--- a/apps/api/src/modules/audit/__tests__/audit.service.spec.ts
+++ b/apps/api/src/modules/audit/__tests__/audit.service.spec.ts
@@ -1,4 +1,5 @@
 import { describe, it, expect, vi, beforeEach } from 'vitest';
+import { PgDialect } from 'drizzle-orm/pg-core';
 import { AuditService } from '../audit.service';
 import { NotFoundException } from '@nestjs/common';
 
@@ -43,6 +44,27 @@ describe('AuditService', () => {
       expect(result).toEqual({ events: [], nextCursor: null });
     });
 
+    it('restricts events to one app for an app-bound key', async () => {
+      await service.queryEvents('tenant-1', { targetAppId: 'app-1' });
+      await service.queryEvents('tenant-1', {});
+
+      const [scoped, tenantWide] = mockDb.whereFunc.mock.calls.map(
+        ([where]) => new PgDialect().sqlToQuery(where),
+      );
+      expect(scoped.sql).toContain('"audit_events"."target_app_id" = $');
+      expect(scoped.params).toContain('app-1');
+      expect(tenantWide.sql).not.toContain('target_app_id');
+    });
+
+    it('restricts a session timeline to one app for an app-bound key', async () => {
+      await expect(service.getSessionDetail('tenant-1', 'trace-1', 'app-1'))
+        .rejects.toThrow(NotFoundException);
+
+      const query = new PgDialect().sqlToQuery(mockDb.whereFunc.mock.calls[0][0]);
+      expect(query.sql).toContain('"audit_events"."target_app_id" = $');
+      expect(query.params).toEqual(['tenant-1', 'trace-1', 'app-1']);
+    });
+
     it('caps limit at 100', async () => {
       mockDb.limitFunc.mockResolvedValue([]);
 
@@ -117,11 +139,12 @@ describe('AuditService', () => {
   describe('getExportStatus', () => {
     it('returns ready status with download URL when job is completed', async () => {
       mockQueue.getJobFunc.mockResolvedValue({
+        data: { tenantId: 'tenant-1' },
         getState: vi.fn().mockResolvedValue('completed'),
         returnvalue: { downloadUrl: 'https://r2.example.com/file.csv' },
       });
 
-      const result = await service.getExportStatus('job-123');
+      const result = await service.getExportStatus('tenant-1', 'job-123');
 
       expect(result).toEqual({
         status: 'ready',
@@ -131,11 +154,12 @@ describe('AuditService', () => {
 
     it('returns pending status when job is active', async () => {
       mockQueue.getJobFunc.mockResolvedValue({
+        data: { tenantId: 'tenant-1' },
         getState: vi.fn().mockResolvedValue('active'),
         returnvalue: null,
       });
 
-      const result = await service.getExportStatus('job-123');
+      const result = await service.getExportStatus('tenant-1', 'job-123');
 
       expect(result).toEqual({ status: 'pending' });
     });
@@ -143,7 +167,20 @@ describe('AuditService', () => {
     it('throws NotFoundException for unknown job', async () => {
       mockQueue.getJobFunc.mockResolvedValue(null);
 
-      await expect(service.getExportStatus('missing')).rejects.toThrow(NotFoundException);
+      await expect(service.getExportStatus('tenant-1', 'missing'))
+        .rejects.toThrow(NotFoundException);
+    });
+
+    /** Job ids are sequential, so another tenant's job answers like none. */
+    it('hides an export job of another tenant', async () => {
+      mockQueue.getJobFunc.mockResolvedValue({
+        data: { tenantId: 'tenant-2' },
+        getState: vi.fn().mockResolvedValue('completed'),
+        returnvalue: { downloadUrl: 'https://r2.example.com/other-tenant.csv' },
+      });
+
+      await expect(service.getExportStatus('tenant-1', '7'))
+        .rejects.toThrow(NotFoundException);
     });
   });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/common/__tests__/app-scope-gaps.spec.ts src/modules/audit/__tests__/audit.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  2 failed (2)`, `Tests  10 failed | 9 passed (19)`: all seven gap tests, both SQL-level audit tests (the rendered query has no `target_app_id` condition) and "hides an export job of another tenant" (the other tenant's download URL comes back). The three reworded export-status tests already pass.

- [ ] **Step 3: Implement**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/common/app-scope.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { type TenantContext } from './types';

/**
 * The app an API key is bound to, or undefined for dashboard sessions and
 * tenant-wide keys.
 */
export function boundAppOf(tenant: TenantContext): string | undefined {
  return tenant.apiKeyId && tenant.targetAppId ? tenant.targetAppId : undefined;
}

/**
 * The app a request may read. An app-bound key always reads its own app;
 * asking for another one answers exactly like an unknown app, so the key
 * cannot learn which apps exist. Everyone else keeps the requested scope
 * (undefined = tenant-wide).
 */
export function appScopeFor(
  tenant: TenantContext,
  requestedAppId?: string,
): string | undefined {
  const bound = boundAppOf(tenant);
  if (!bound) return requestedAppId;
  if (requestedAppId && requestedAppId !== bound) {
    throw new NotFoundException('App not found');
  }
  return bound;
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/audit/audit.controller.ts b/apps/api/src/modules/audit/audit.controller.ts
--- a/apps/api/src/modules/audit/audit.controller.ts
+++ b/apps/api/src/modules/audit/audit.controller.ts
@@ -16,7 +16,9 @@ function extractActor(actor: unknown): string {
   return (a?.userId ?? a?.id ?? JSON.stringify(actor)) as string;
 }
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
+import { TenantWideOnly } from '../../common/decorators/app-scope.decorator';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
+import { appScopeFor } from '../../common/app-scope';
 import { type TenantContext } from '../../common/types';
 import { AuditService } from './audit.service';
 
@@ -64,6 +66,7 @@ Useful for investigating what happened during a specific period or for a specifi
       actor,
       limit: limit ? parseInt(limit, 10) : undefined,
       cursor,
+      targetAppId: appScopeFor(tenant),
     });
 
     return {
@@ -102,7 +105,7 @@ Use from/to to narrow the date range. Supports cursor pagination via nextCursor.
       to,
       actor,
       status,
-      targetAppId,
+      targetAppId: appScopeFor(tenant, targetAppId),
       limit: limit ? parseInt(limit, 10) : undefined,
       cursor,
     });
@@ -120,7 +123,11 @@ a specific user session or investigating an incident end-to-end.`,
     @CurrentTenant() tenant: TenantContext,
     @Param('traceId') traceId: string,
   ) {
-    return this.auditService.getSessionDetail(tenant.id, traceId);
+    return this.auditService.getSessionDetail(
+      tenant.id,
+      traceId,
+      appScopeFor(tenant),
+    );
   }
 
   @AiTool({
@@ -143,6 +150,7 @@ RETURNS: Paginated list of traces with traceId, startedAt, actor. Use get_trace_
       to,
       limit: limit ? parseInt(limit, 10) : undefined,
       cursor,
+      targetAppId: appScopeFor(tenant),
     });
 
     return {
@@ -166,7 +174,11 @@ Returns the full event timeline for a trace, useful for debugging a specific int
     @CurrentTenant() tenant: TenantContext,
     @Param('traceId') traceId: string,
   ) {
-    const result = await this.auditService.getTrace(tenant.id, traceId);
+    const result = await this.auditService.getTrace(
+      tenant.id,
+      traceId,
+      appScopeFor(tenant),
+    );
     return {
       events: result.events.map((e) => ({
         id: e.id,
@@ -191,6 +203,7 @@ Formats:
 IMPORTANT: This starts a background job. The output does NOT contain the download URL immediately — the job must complete first. Use the returned jobId to check status.`,
   })
   @Post('export')
+  @TenantWideOnly()
   async startExport(
     @CurrentTenant() tenant: TenantContext,
     @Body() body: { from: string; to: string; format?: 'csv' | 'jsonl' },
@@ -206,7 +219,11 @@ USE WHEN: User previously started an export with export_audit_data and wants to
 RETURNS: Job status and download URL when complete.`,
   })
   @Get('export/:jobId')
-  async getExportStatus(@Param('jobId') jobId: string) {
-    return this.auditService.getExportStatus(jobId);
+  @TenantWideOnly()
+  async getExportStatus(
+    @CurrentTenant() tenant: TenantContext,
+    @Param('jobId') jobId: string,
+  ) {
+    return this.auditService.getExportStatus(tenant.id, jobId);
   }
 }
diff --git a/apps/api/src/modules/audit/audit.service.ts b/apps/api/src/modules/audit/audit.service.ts
--- a/apps/api/src/modules/audit/audit.service.ts
+++ b/apps/api/src/modules/audit/audit.service.ts
@@ -11,6 +11,8 @@ export interface QueryEventsOptions {
   actor?: string;
   limit?: number;
   cursor?: string;
+  /** Restricts to one app (app-bound API keys). */
+  targetAppId?: string;
 }
 
 export interface ExportOptions {
@@ -69,6 +71,9 @@ export class AuditService {
 
     const conditions: SQL[] = [eq(auditEvents.tenantId, tenantId)];
 
+    if (options.targetAppId) {
+      conditions.push(eq(auditEvents.targetAppId, options.targetAppId));
+    }
     if (options.from) {
       conditions.push(gte(auditEvents.createdAt, new Date(options.from)));
     }
@@ -132,13 +137,22 @@ export class AuditService {
 
   async queryTraces(
     tenantId: string,
-    options: { limit?: number; from?: string; to?: string; cursor?: string },
+    options: {
+      limit?: number;
+      from?: string;
+      to?: string;
+      cursor?: string;
+      targetAppId?: string;
+    },
   ) {
     const limit = Math.min(options.limit ?? 20, 50);
     const conditions: SQL[] = [
       eq(auditEvents.tenantId, tenantId),
       isNotNull(auditEvents.traceId),
     ];
+    if (options.targetAppId) {
+      conditions.push(eq(auditEvents.targetAppId, options.targetAppId));
+    }
     if (options.from) conditions.push(gte(auditEvents.createdAt, new Date(options.from)));
     if (options.to) conditions.push(lte(auditEvents.createdAt, new Date(options.to)));
     if (options.cursor) {
@@ -169,7 +183,7 @@ export class AuditService {
     return { traces, nextCursor };
   }
 
-  async getTrace(tenantId: string, traceId: string) {
+  async getTrace(tenantId: string, traceId: string, targetAppId?: string) {
     const rows = await this.db
       .select()
       .from(auditEvents)
@@ -177,6 +191,7 @@ export class AuditService {
         and(
           eq(auditEvents.tenantId, tenantId),
           eq(auditEvents.traceId, traceId),
+          ...(targetAppId ? [eq(auditEvents.targetAppId, targetAppId)] : []),
         ),
       )
       .orderBy(auditEvents.createdAt);
@@ -195,9 +210,13 @@ export class AuditService {
     return { jobId: job.id! };
   }
 
-  async getExportStatus(jobId: string): Promise<{ status: string; downloadUrl?: string }> {
+  async getExportStatus(
+    tenantId: string,
+    jobId: string,
+  ): Promise<{ status: string; downloadUrl?: string }> {
     const job = await this.exportQueue.getJob(jobId);
-    if (!job) {
+    // Queue job ids are sequential: another tenant's job answers like none.
+    if (!job || job.data?.tenantId !== tenantId) {
       throw new NotFoundException(`Export job ${jobId} not found`);
     }
 
@@ -284,13 +303,18 @@ export class AuditService {
     return { sessions: filtered, nextCursor };
   }
 
-  async getSessionDetail(tenantId: string, traceId: string): Promise<SessionDetail> {
+  async getSessionDetail(
+    tenantId: string,
+    traceId: string,
+    targetAppId?: string,
+  ): Promise<SessionDetail> {
     const rows = await this.db
       .select()
       .from(auditEvents)
       .where(and(
         eq(auditEvents.tenantId, tenantId),
         eq(auditEvents.traceId, traceId),
+        ...(targetAppId ? [eq(auditEvents.targetAppId, targetAppId)] : []),
       ))
       .orderBy(auditEvents.timestampMs)
       .limit(500);
diff --git a/apps/api/src/modules/gate/gate-config.controller.ts b/apps/api/src/modules/gate/gate-config.controller.ts
--- a/apps/api/src/modules/gate/gate-config.controller.ts
+++ b/apps/api/src/modules/gate/gate-config.controller.ts
@@ -14,6 +14,7 @@ import { AiModule, AiTool } from '@chainmatics/agentic-adapter-nestjs';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
+import { appScopeFor } from '../../common/app-scope';
 import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
 import { type TenantContext } from '../../common/types';
 import { GateService } from './gate.service';
@@ -137,7 +138,12 @@ RETURNS: Array of tool entries each with toolId, optional moduleId, and a list o
     @CurrentTenant() tenant: TenantContext,
     @Query('targetAppId') targetAppId?: string,
   ) {
-    return { tools: await this.gateService.getToolAccess(tenant.id, targetAppId) };
+    return {
+      tools: await this.gateService.getToolAccess(
+        tenant.id,
+        appScopeFor(tenant, targetAppId),
+      ),
+    };
   }
 
   @AiTool({
diff --git a/apps/api/src/modules/runtime-deployments/runtime-deployment.controller.ts b/apps/api/src/modules/runtime-deployments/runtime-deployment.controller.ts
--- a/apps/api/src/modules/runtime-deployments/runtime-deployment.controller.ts
+++ b/apps/api/src/modules/runtime-deployments/runtime-deployment.controller.ts
@@ -12,6 +12,7 @@ import { z } from 'zod';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
+import { appScopeFor } from '../../common/app-scope';
 import { type TenantContext } from '../../common/types';
 import { RuntimeDeploymentService } from './runtime-deployment.service';
 import {
@@ -62,14 +63,14 @@ export class RuntimeDeploymentController {
   ) {}
 
   @Get()
-  list(
+  async list(
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') targetAppId: string,
     @Param('environmentId') environmentId: string,
   ) {
     return this.deployments.list({
       tenantId: tenant.id,
-      targetAppId,
+      targetAppId: appScopeFor(tenant, targetAppId) ?? targetAppId,
       environmentId,
     });
   }
diff --git a/apps/api/src/modules/stream/stream.controller.ts b/apps/api/src/modules/stream/stream.controller.ts
--- a/apps/api/src/modules/stream/stream.controller.ts
+++ b/apps/api/src/modules/stream/stream.controller.ts
@@ -3,6 +3,7 @@ import { Observable, map } from 'rxjs';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
+import { appScopeFor } from '../../common/app-scope';
 import { type TenantContext } from '../../common/types';
 import { StreamService } from './stream.service';
 
@@ -17,7 +18,10 @@ export class StreamController {
     @CurrentTenant() tenant: TenantContext,
     @Query('targetAppId') targetAppId?: string,
   ): Observable<MessageEvent> {
-    return this.streamService.subscribe(tenant.id, targetAppId).pipe(
+    return this.streamService.subscribe(
+      tenant.id,
+      appScopeFor(tenant, targetAppId),
+    ).pipe(
       map(
         (event) =>
           ({
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/common/__tests__/app-scope-gaps.spec.ts src/modules/audit/__tests__/audit.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  19 passed (19)`; `Test Files  120 passed (120)`, `Tests  1288 passed | 10 skipped (1298)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/common/app-scope.ts apps/api/src/common/__tests__/app-scope-gaps.spec.ts apps/api/src/modules/audit/audit.controller.ts apps/api/src/modules/audit/audit.service.ts apps/api/src/modules/audit/__tests__/audit.service.spec.ts apps/api/src/modules/stream/stream.controller.ts apps/api/src/modules/gate/gate-config.controller.ts apps/api/src/modules/runtime-deployments/runtime-deployment.controller.ts
git commit -m "fix(auth): scope app-bound keys on audit, stream, gate and deployments"
```

---

### Task 13: DB – audited admin command to switch a tenant plan (Pro activation)

**Files:**
- Create: `packages/db/scripts/switch-tenant-plan.ts`, `packages/db/src/__tests__/switch-tenant-plan.test.ts`
- Modify: `packages/db/package.json:21`, `CLAUDE.md:61`
- Test: `packages/db/src/__tests__/switch-tenant-plan.test.ts`

**Interfaces:**
- Consumes: `tenants` (`plan`: `free` | `pro` | `enterprise` | `platform`, `stripeSubscriptionId`), `auditEvents`, `createDb`, `resolveDatabaseTransport`; PGlite plus the real migrations for the test.
- Produces: `SWITCHABLE_PLANS = ['free', 'pro']`, `interface SwitchTenantPlanInput { tenantSlug; confirmSlug; plan; operator; reason; apply }`, `interface SwitchTenantPlanResult { tenantId; tenantSlug; previousPlan; plan; status: 'dry-run'|'switched'|'unchanged'; auditEventId }`, `validateSwitchTenantPlanInput(input)`, `switchTenantPlan(db: PgDatabase, input)` (one transaction: `SELECT … FOR UPDATE`, update `plan`/`updated_at`, insert `audit_events { event_type: 'tenant.plan_changed', actor: { userId: 'platform-admin:<operator>', role: 'platform-admin' }, payload: { previousPlan, plan, reason, source: 'admin-cli' } }`), `parseSwitchTenantPlanArgs(argv)`; package script `admin:switch-plan` = `bun --no-env-file scripts/switch-tenant-plan.ts`. The connection comes only from `GLIRASTES_ADMIN_DATABASE_URL` (transport `DATABASE_TRANSPORT`, default `postgres`; `neon-http` is refused because it has no transactions).

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/switch-tenant-plan.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  parseSwitchTenantPlanArgs,
  switchTenantPlan,
  type SwitchTenantPlanInput,
} from '../../scripts/switch-tenant-plan';
import * as schema from '../schema';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function tenant(slug: string, values: Record<string, unknown> = {}) {
  const [row] = await db.insert(schema.tenants)
    .values({ name: slug, slug, ...values })
    .returning({ id: schema.tenants.id });
  return row!.id;
}

const request = (
  slug: string,
  overrides: Partial<SwitchTenantPlanInput> = {},
): SwitchTenantPlanInput => ({
  tenantSlug: slug,
  confirmSlug: slug,
  plan: 'pro',
  operator: 'ops@chainmatics.net',
  reason: 'P10 managed tool generation pilot',
  apply: true,
  ...overrides,
});

async function planOf(id: string) {
  const rows = await client.query<{ plan: string }>(
    'select plan from tenants where id = $1',
    [id],
  );
  return rows.rows[0]?.plan;
}

async function auditsOf(id: string) {
  const rows = await client.query<{ event_type: string; actor: unknown; payload: unknown }>(
    'select event_type, actor, payload from audit_events where tenant_id = $1',
    [id],
  );
  return rows.rows;
}

describe('switching a tenant plan', () => {
  it('only reports the change on a dry run', async () => {
    const id = await tenant('dry-run');

    const result = await switchTenantPlan(db, request('dry-run', { apply: false }));

    expect(result).toEqual({
      tenantId: id,
      tenantSlug: 'dry-run',
      previousPlan: 'free',
      plan: 'pro',
      status: 'dry-run',
      auditEventId: null,
    });
    expect(await planOf(id)).toBe('free');
    expect(await auditsOf(id)).toEqual([]);
  });

  it('switches the plan and records who did it and why in one transaction', async () => {
    const id = await tenant('pro-pilot');

    const result = await switchTenantPlan(db, request('pro-pilot'));

    expect(result.status).toBe('switched');
    expect(await planOf(id)).toBe('pro');
    expect(await auditsOf(id)).toEqual([{
      event_type: 'tenant.plan_changed',
      actor: { userId: 'platform-admin:ops@chainmatics.net', role: 'platform-admin' },
      payload: {
        previousPlan: 'free',
        plan: 'pro',
        reason: 'P10 managed tool generation pilot',
        source: 'admin-cli',
      },
    }]);

    await switchTenantPlan(db, request('pro-pilot', { plan: 'free' }));
    expect(await planOf(id)).toBe('free');
  });

  it('changes nothing when the tenant already has the plan', async () => {
    const id = await tenant('already-pro', { plan: 'pro' });

    const result = await switchTenantPlan(db, request('already-pro'));

    expect(result.status).toBe('unchanged');
    expect(await auditsOf(id)).toEqual([]);
  });

  it('leaves the plan untouched when the audit event cannot be written', async () => {
    const id = await tenant('audit-down');
    await client.exec(`
      CREATE FUNCTION refuse_plan_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_plan_audit BEFORE INSERT ON audit_events
        FOR EACH ROW WHEN (NEW.event_type = 'tenant.plan_changed')
        EXECUTE FUNCTION refuse_plan_audit();
    `);

    await expect(switchTenantPlan(db, request('audit-down')))
      .rejects.toThrow('audit unavailable');
    expect(await planOf(id)).toBe('free');
    await client.exec(`
      DROP TRIGGER refuse_plan_audit ON audit_events;
      DROP FUNCTION refuse_plan_audit();
    `);
  });

  it.each([
    ['a mismatched confirmation', request('acme', { confirmSlug: 'acme-co' }), '--confirm'],
    ['an unsupported plan', request('acme', { plan: 'enterprise' as never }), '--plan'],
    ['an operator that is not an email', request('acme', { operator: 'philipp' }), '--operator'],
    ['an empty reason', request('acme', { reason: '   ' }), '--reason'],
    ['an unknown tenant', request('nobody'), 'Unknown tenant: nobody'],
  ])('refuses %s', async (_name, input, message) => {
    await expect(switchTenantPlan(db, input)).rejects.toThrow(message);
  });

  it('refuses tenants whose plan billing or a contract owns', async () => {
    await tenant('enterprise-co', { plan: 'enterprise' });
    const stripeId = await tenant('stripe-co', { stripeSubscriptionId: 'sub_123' });

    await expect(switchTenantPlan(db, request('enterprise-co', { plan: 'free' })))
      .rejects.toThrow('not managed by this command');
    await expect(switchTenantPlan(db, request('stripe-co')))
      .rejects.toThrow('Stripe subscription');
    expect(await planOf(stripeId)).toBe('free');
  });
});

describe('command line', () => {
  it('reads every flag and stays a dry run without --apply', () => {
    const argv = [
      '--tenant', 'acme', '--confirm', 'acme', '--plan', 'pro',
      '--operator', 'ops@chainmatics.net', '--reason', 'pilot',
    ];

    expect(parseSwitchTenantPlanArgs(argv)).toEqual({
      tenantSlug: 'acme',
      confirmSlug: 'acme',
      plan: 'pro',
      operator: 'ops@chainmatics.net',
      reason: 'pilot',
      apply: false,
    });
    expect(parseSwitchTenantPlanArgs([...argv, '--apply']).apply).toBe(true);
    expect(() => parseSwitchTenantPlanArgs(['--tenant', 'acme']))
      .toThrow('Missing --confirm <value>');
  });

  /** An inherited DATABASE_URL (shell or .env) never selects the database. */
  it('connects only through GLIRASTES_ADMIN_DATABASE_URL', () => {
    const run = Bun.spawnSync([
      process.execPath,
      '--no-env-file',
      fileURLToPath(new URL('../../scripts/switch-tenant-plan.ts', import.meta.url)),
      '--tenant', 'acme', '--confirm', 'acme', '--plan', 'pro',
      '--operator', 'ops@chainmatics.net', '--reason', 'pilot', '--apply',
    ], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://offline.invalid/unused' },
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain('Set GLIRASTES_ADMIN_DATABASE_URL explicitly');
    expect(run.stdout.toString()).toBe('');
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/switch-tenant-plan.test.ts 2>&1 | grep -E "Cannot find module| pass$| fail$"
```

Expected: `error: Cannot find module '../../scripts/switch-tenant-plan' from …/switch-tenant-plan.test.ts`, `0 pass`, `1 fail`.

- [ ] **Step 3: Implement**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/scripts/switch-tenant-plan.ts`:

```ts
/**
 * Switches one tenant between the Free and the Pro plan, with an audit event
 * written in the same transaction. This replaces hand-written SQL for the Pro
 * activation (spec 7 "Pro-Freischaltung"); there is no billing UI behind it.
 *
 *   GLIRASTES_ADMIN_DATABASE_URL=... bun --no-env-file run admin:switch-plan -- \
 *     --tenant <slug> --confirm <slug> --plan pro \
 *     --operator <email> --reason "<why>" [--apply]
 *
 * Without --apply it only prints what would change. It never reads a `.env`
 * file: Bun's automatic loading is switched off, and the connection comes
 * only from GLIRASTES_ADMIN_DATABASE_URL, a variable no app `.env` defines,
 * so an implicit DATABASE_URL can never select the database. The URL is never
 * printed. DATABASE_TRANSPORT defaults to `postgres` (transactions needed). Plans other than free and pro, and tenants whose plan a Stripe
 * subscription owns, are refused. API keys cache their tenant context for up
 * to 300 seconds, so a switch can take that long to reach every request.
 */
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { createDb, resolveDatabaseTransport } from '../src/client';
import { auditEvents, tenants } from '../src/schema';

export const SWITCHABLE_PLANS = ['free', 'pro'] as const;
export type SwitchablePlan = typeof SWITCHABLE_PLANS[number];

export interface SwitchTenantPlanInput {
  tenantSlug: string;
  /** Must repeat the slug, so a typo cannot switch another tenant. */
  confirmSlug: string;
  plan: SwitchablePlan;
  /** Email of the Chainmatics operator; recorded in the audit event. */
  operator: string;
  reason: string;
  /** False prints the change only. */
  apply: boolean;
}

export interface SwitchTenantPlanResult {
  tenantId: string;
  tenantSlug: string;
  previousPlan: string;
  plan: SwitchablePlan;
  status: 'dry-run' | 'switched' | 'unchanged';
  auditEventId: string | null;
}

type AnyPgDatabase = PgDatabase<any, any, any>;

const OPERATOR = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSwitchTenantPlanInput(input: SwitchTenantPlanInput): void {
  if (!input.tenantSlug || input.tenantSlug !== input.confirmSlug) {
    throw new Error('--confirm must repeat the tenant slug exactly');
  }
  if (!(SWITCHABLE_PLANS as readonly string[]).includes(input.plan)) {
    throw new Error(`--plan must be one of: ${SWITCHABLE_PLANS.join(', ')}`);
  }
  if (!OPERATOR.test(input.operator)) {
    throw new Error('--operator must be the email of the Chainmatics operator');
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 200) {
    throw new Error('--reason must hold 1 to 200 characters');
  }
}

export async function switchTenantPlan(
  db: AnyPgDatabase,
  input: SwitchTenantPlanInput,
): Promise<SwitchTenantPlanResult> {
  validateSwitchTenantPlanInput(input);
  return db.transaction(async (tx) => {
    const [tenant] = await tx.select({
      id: tenants.id,
      slug: tenants.slug,
      plan: tenants.plan,
      stripeSubscriptionId: tenants.stripeSubscriptionId,
    }).from(tenants).where(eq(tenants.slug, input.tenantSlug)).for('update');
    if (!tenant) throw new Error(`Unknown tenant: ${input.tenantSlug}`);
    if (!(SWITCHABLE_PLANS as readonly string[]).includes(tenant.plan)) {
      throw new Error(`The ${tenant.plan} plan is not managed by this command`);
    }
    if (tenant.stripeSubscriptionId) {
      throw new Error('A Stripe subscription owns this tenant plan; change it in billing');
    }
    const result = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      previousPlan: tenant.plan,
      plan: input.plan,
    };
    if (tenant.plan === input.plan) {
      return { ...result, status: 'unchanged' as const, auditEventId: null };
    }
    if (!input.apply) {
      return { ...result, status: 'dry-run' as const, auditEventId: null };
    }

    await tx.update(tenants)
      .set({ plan: input.plan, updatedAt: new Date() })
      .where(eq(tenants.id, tenant.id));
    const [audit] = await tx.insert(auditEvents).values({
      tenantId: tenant.id,
      eventType: 'tenant.plan_changed',
      actor: { userId: `platform-admin:${input.operator}`, role: 'platform-admin' },
      payload: {
        previousPlan: tenant.plan,
        plan: input.plan,
        reason: input.reason.trim(),
        source: 'admin-cli',
      },
    }).returning({ id: auditEvents.id });
    return { ...result, status: 'switched' as const, auditEventId: audit?.id ?? null };
  });
}

export function parseSwitchTenantPlanArgs(argv: string[]): SwitchTenantPlanInput {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    const found = index === -1 ? undefined : argv[index + 1];
    if (!found || found.startsWith('--')) throw new Error(`Missing ${flag} <value>`);
    return found;
  };
  return {
    tenantSlug: value('--tenant'),
    confirmSlug: value('--confirm'),
    plan: value('--plan') as SwitchablePlan,
    operator: value('--operator'),
    reason: value('--reason'),
    apply: argv.includes('--apply'),
  };
}

if (import.meta.main) {
  try {
    const input = parseSwitchTenantPlanArgs(process.argv.slice(2));
    validateSwitchTenantPlanInput(input);
    const databaseUrl = process.env.GLIRASTES_ADMIN_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('Set GLIRASTES_ADMIN_DATABASE_URL explicitly; no .env file is read');
    }
    const transport = resolveDatabaseTransport(process.env.DATABASE_TRANSPORT ?? 'postgres');
    if (transport === 'neon-http') {
      throw new Error('Use DATABASE_TRANSPORT=postgres or neon-websocket (transactions)');
    }
    const db = createDb(databaseUrl, transport) as unknown as AnyPgDatabase;
    const result = await switchTenantPlan(db, input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/CLAUDE.md b/CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -59,6 +59,8 @@ bun run db:generate                  # Generate migration files from schema chan
 bun run db:push                      # Push schema directly to Neon (dev)
 bun run db:migrate                   # Apply migrations (needs DATABASE_URL)
 # Migration rules, snapshots, hand-migrated baseline: packages/db/MIGRATIONS.md
+# Pro activation (Free <-> Pro, audited, dry run unless --apply; never reads .env):
+cd packages/db && GLIRASTES_ADMIN_DATABASE_URL=... bun --no-env-file run admin:switch-plan -- --tenant <slug> --confirm <slug> --plan pro --operator <email> --reason "<why>"
 
 # Docker (Redis + Presidio)
 docker compose up -d                 # Start Redis and Presidio sidecar
diff --git a/packages/db/package.json b/packages/db/package.json
--- a/packages/db/package.json
+++ b/packages/db/package.json
@@ -19,6 +19,7 @@
     "db:generate": "drizzle-kit generate",
     "db:push": "drizzle-kit push",
     "db:migrate": "drizzle-kit migrate",
+    "admin:switch-plan": "bun --no-env-file scripts/switch-tenant-plan.ts",
     "test": "bun test",
     "lint": "echo 'lint not configured yet'"
   },
PATCH
```

- [ ] **Step 4: Run and see GREEN; prove the command refuses an implicit connection**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/switch-tenant-plan.test.ts 2>&1 | tail -3
bun test 2>&1 | tail -3
env -u GLIRASTES_ADMIN_DATABASE_URL DATABASE_URL=postgres://offline.invalid/unused bun --no-env-file run admin:switch-plan -- --tenant acme --confirm acme --plan pro --operator ops@chainmatics.net --reason pilot 2>&1 | grep -E "^Set|exited"
```

Expected: `0 fail`, `Ran 12 tests across 1 file.`; `0 fail`, `Ran 115 tests across 21 files.`; `Set GLIRASTES_ADMIN_DATABASE_URL explicitly; no .env file is read` and `error: script "admin:switch-plan" exited with code 1`. No step connects to any database.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/scripts/switch-tenant-plan.ts packages/db/src/__tests__/switch-tenant-plan.test.ts packages/db/package.json CLAUDE.md
git commit -m "feat(db): add an audited admin command to switch a tenant plan"
```

---
### Task 14: P08b gate run and checkpoint (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Platform gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
pgrep -fl -- "nest start|next dev|vitest --watch" | grep mvp-platform || echo "no watcher"
(cd packages/db && ./node_modules/.bin/tsc -p tsconfig.json && echo "db-build=0")
(cd apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?")
(cd apps/api && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests ")
(cd apps/citadel && ./node_modules/.bin/tsc --noEmit; echo "citadel-tsc=$?")
(cd apps/citadel && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests ")
(cd apps/citadel && L="$(mktemp -d)" && bun run lint > "$L/lint.log" 2>&1; echo "citadel-lint=$?"; grep "✖" "$L/lint.log")
(cd packages/db && bun test 2>&1 | tail -4)
(cd packages/db && bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts src/__tests__/bounded-tool-overrides-migration.test.ts 2>&1 | tail -4)
(cd packages/db && DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1)
git status --short
git log --oneline 4bb9415..HEAD | wc -l
```

Expected: `no watcher`; `db-build=0`; `api-typecheck=0`; API `Test Files  120 passed (120)`, `Tests  1288 passed | 10 skipped (1298)`; `citadel-tsc=0`; Citadel `Test Files  39 passed (39)`, `Tests  256 passed (256)` (Citadel is not touched); `citadel-lint=0`, `✖ 30 problems (0 errors, 30 warnings)`; DB `115 pass`, `0 fail`, `Ran 115 tests across 21 files.`; the migration trio `8 pass`, `0 fail`, `Ran 8 tests across 3 files.`; `Everything's fine 🐶🔥`; empty status; `13` commits. All numbers were measured on 2026-10-05 in a copy of `4bb9415` with every task of this plan applied in order.

- [ ] **Step 2: Checkpoint report to Philipp**

Report the 13 commits with hashes, the gate numbers above, the decisions table and the shared SDK contract from the top of this plan, and these requests and findings (none of them is executed by an agent):

1. **Shared database:** `0044_bounded_tool_overrides` is additive (four `ADD COLUMN`, one with a default). The shared database first needs the P08a baseline (`packages/db/MIGRATIONS.md`, "A database that received migrations by hand"); `bun run db:migrate` then applies exactly `0044`. Approval needed.

   Include two read-only queries for Philipp to run on the shared database before the first deployment (no agent runs them; both only SELECT). They find published revisions that now fail every new draft: a tool or policy revision at tier 3 (anything outside `safe-read`, `read-sensitive`, `write`) with `requiresApproval` false. The old `applyToolOverride` and the legacy setup DTO could publish such values; derivation copies them into `toolPolicies`, and `prepareDraft` now answers 422 `tier-3-always-requires-approval`, so the deployment is not created. The one exception is the reuse path, where an identical manifest and policy pair is already published in the environment under the current signing key. This fails closed (the runner floors tier 3 anyway: SDK `src/runtime/authorization.ts:73`), so it is an availability problem, not a security one.

   ```sql
   -- 1. tool revisions
   SELECT id, target_app_id
   FROM tool_revisions
   WHERE status = 'published'
     AND definition->>'riskClass' NOT IN ('safe-read', 'read-sensitive', 'write')
     AND definition->>'requiresApproval' = 'false';

   -- 2. policy revisions (one row per offending toolPolicies entry)
   SELECT r.id, r.target_app_id, r.environment_id, p->>'toolId' AS tool_id
   FROM runtime_policy_revisions r,
        jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.policy->'toolPolicies') = 'array'
               THEN r.policy->'toolPolicies' ELSE '[]'::jsonb END
        ) AS p
   WHERE r.status = 'published'
     AND p->>'riskClass' NOT IN ('safe-read', 'read-sensitive', 'write')
     AND p->>'requiresApproval' = 'false';
   ```

   Zero rows from both: nothing to do. Any row: the affected app cannot deploy a derived revision pair until it is republished. The remedy is to republish from a fresh reviewed run, because current SDK artifacts floor tier 3 (`src/codegen/tools/artifact.ts:86`, `requiresApproval: confirmationFloor(...)`), so a new tool revision carries `requiresApproval: true` and the next derivation passes. Do not edit the published rows by hand (they are signed).
2. **First Pro tenant for P10:** after review, `cd packages/db && GLIRASTES_ADMIN_DATABASE_URL=<url> bun --no-env-file run admin:switch-plan -- --tenant <slug> --confirm <slug> --plan pro --operator <email> --reason "P10 managed tool generation"` as a dry run, then the same with `--apply`. API keys cache their tenant context for up to 300 s. Approval needed.
3. **SDK lockstep (P04, before P11):** `RuntimePolicyRevision.toolOverrides` (default `[]`) and the overlay adapter reading it; `provenance` and `exclusions` in the SDK's strict artifact schemas; the runner registering `capabilities.discoveryDigest` and uploading its artifact once per digest with its app-bound runtime key. Until then a runner refuses a policy revision that carries decisions (it keeps the last accepted deployment), and every capability view says "code version not reported".
4. **P08c (Citadel):** the override form must offer only restricting choices (the API now answers 422 with the reason); "Was kann mein Chat?" reads the capabilities endpoint; the overview no longer offers apply for new tools; `PATCH …/tools/:toolId` also returns `policyRevision`; the explicit apply is `POST …/configurations/:configurationRevisionId/apply` and answers 409 for a draft that is not the policy-only revision of the current decisions (Task 8 fix round); a pending relaxation is shown as such (`relaxationPending`), and so is a saved decision the environment does not run yet (`decisionPending`).
5. **Fixed here although found next to the scope:** `GET /v1/audit/export/:jobId` returned any tenant's export download URL to any management key (sequential job ids); Task 12 now compares the job's tenant.
6. **Findings outside this plan:** `GET /v1/apps/:appId/runtime-revisions` (`listInbox`) does not compare an app-bound key's app; webhooks, billing and optimizer routes (P08a finding) and the gate write routes (`PUT /v1/gate/roles`, `PUT`/`DELETE /v1/gate/tool-access/:toolId/override…`, tenant-wide RBAC) still ignore `targetAppId`; a configuration revision that adds or removes a tool binding may switch to any already published planner revision without security approval (Task 6 exempts planner and runtime digest changes that come with binding changes; the planner revision itself was gated when published); revisions published before this plan can still carry tool values that the old `applyToolOverride` lowered or enabled (only new publications are clamped; the runtime overlay stays restrict-only; item 1's queries find the tier-3 cases that block new drafts); a decision stored before this plan that relaxes confirmation gets its baseline from the code reported at its next save, after which publishing it still needs a security approval (Task 6). Proposed owner: P13 or a follow-up hygiene plan.

Do not push.

---

## Self-Review

**Spec coverage**

| Spec item | Task |
| --- | --- |
| 4.10.1 `boundToolOverride` replaces `applyToolOverride`; out of bounds → 422 with reason code; golden-vector parity | 2 (port, vectors, parity), 3 (bounds, 422, legacy clamp) |
| 4.10.2 migration `0044_bounded_tool_overrides` with `baseline_risk_class`, `baseline_requires_approval`, `allowed_roles`, generated by `drizzle-kit generate` with `0044_snapshot.json`; from-scratch expectations (applied = `journal.entries.length`) and the runbook sentence | 1 (plus `runtime_config_revisions.tool_overrides`, see decisions) |
| 4.10.3 signed `toolOverrides[]` deltas, never copies of local values; empty `allowedRoles`; description in the signed revision; planner allowlist = enabled tools; wire shape coordinated with SDK P04, `toolPolicies` kept transitionally | 4, 5, shared contract items 1-4 |
| 4.10.4 policy-only signed revision when a decision is saved (pattern `createPromptOnlyRevision`), activated through the health gate and revocation | 4 (`createPolicyOnlyRevision`), 8 (draft on save, apply, `settle`) |
| 4.10.5 direction-aware publication gate; the generic `POST ':type'` endpoint enforces the same bounds | 6, 7 |
| 4.10.6 capability report once per `discoveryDigest` with the app-bound runtime key through the existing ingestion and content boundary; never enables tools; the decision guard accepts tools any environment reports | 9 (and 10 for "never enables") |
| 4.10.7 `GET /v2/apps/:appId/environments/:environmentId/capabilities` with name, presentation, kind, method/path, risk, confirmation, enabled, origin per field, status, contract source and description/schema quality; "code version not reported" | 10 |
| 4.10.9 contracts in lockstep (`RuntimePolicyRevision.toolOverrides`, optional provenance on `AppSetupToolCandidate`) | Platform side 5, 9; SDK side documented for P04 (shared contract) |
| 4.10.10 new tools need no sync or apply; apply only for decision, prompt or budget revisions | 8 (`target`), 11 (the pending change is the revision that signs the current decisions; `createPromptOnlyRevision` has no production caller and there is no budget revision type yet, so no other Platform-side revision exists; a future producer extends `target`) |
| 4.5 bounds (raise-only risk, tier-3 confirmation, roles only narrow, nothing enables, relaxation pinned and lapsing) and 4.9 (Platform overlay restrict-only; relaxation without a committed local entry not effective) | 2, 3, 10 (`relaxationPending`) |
| 7 Pro-Freischaltung: secured admin command, no manual SQL, audited | 13 |
| Roadmap: app scope for app-bound keys on `/v1/audit` sessions/events, `/v1/stream`, gate-config `getToolAccess`, deployment list, tests first | 12 |
| Roadmap: Platform port produces and reads `riskClass` on `risk-lower-available` | 2 (vectors `ratchet/*`) |

Deliberately not in P08b: the Citadel UI and the `/manage` and `/connect` redesign (P08c, after the "Living Network" mockup approval), the SDK half of the shared contract (P04), Managed tool generation and its `ci` key scope (P10), metrics (P09).

**Placeholder scan:** done. Every code step carries the exact patch or file content; the vectors come from the SDK object store with a pinned digest; the three migration files come from `drizzle-kit generate` with the expected SQL spelled out. Measured on 2026-10-05 in a `git archive` copy of `4bb9415` with the worktree's `node_modules`: every patch was generated against `4bb9415` and applied cumulatively, task by task; each RED was measured by applying only that task's test files to the previous task's state; each GREEN, the typecheck and the whole API suite were measured at every task (1153 → 1198 → 1225 → 1229 → 1232 → 1238 → 1248 → 1258 → 1263 → 1272 → 1278 → 1288 passing). Plan check: every file and patch block of this document was then replayed in document order into a fresh `git archive` copy of `4bb9415` (23 patches, 15 written files, the vectors from the SDK object store, `drizzle-kit generate`); the result equals the measured implementation byte for byte apart from the generated snapshot `id` and journal `when`, and the Task 14 gates in that copy gave exactly the numbers quoted there. Plan check after the review fixes (2026-10-05): the revised document was replayed block by block, in order, into another fresh `git archive` copy of `4bb9415`; every RED and GREEN count, every typecheck and the Task 14 gate came out exactly as quoted, with 13 commits and an empty status. Every bash block starts with an absolute `cd`; no step deletes a file; no step reads `.env*`, `.secrets/` or `.npmrc`, and no step can connect to a database (`drizzle-kit` gets a placeholder URL, the admin command needs `GLIRASTES_ADMIN_DATABASE_URL`).

**Type consistency:** done. `ToolPolicyEntry`, `ToolPolicyEntrySchema`, `riskTier`, `resolveToolPolicy` and `TOOL_RISK_CLASSES` are defined once (Task 2, `tool-policy.ts`) and imported by `tool-override.ts`, `runtime-publication-policy.ts` and the capability view. `ToolOverrideDelta = { toolId } & ToolPolicyEntry` is the one delta type of `ReviewedAppSetupArtifact.toolOverrides` (Task 3), the configuration payload, `createPolicyOnlyRevision` and `policyOnlyRevisionId` (Task 4), `PublishedConfigurationRecord.toolOverrides` (Task 5, also read by the capability view for `decisionPending`) and `ToolPolicyRevisionService` (Task 8). `PolicyRevisionTarget` (Task 8) is the one source of the pending change for `ConnectedOverviewService` (Task 11). `StoredToolOverride`/`ToolOverrideFields` are the store's decision types for `upsertToolOverride`, `findToolOverride`, `listToolOverrides`, `readConnectedApplyInputs` and `connectedApplyInputDigest`. `reportedToolPolicy(tool)` is the one reader of reported values (service, policy drafting, capability view). `configurationApplyId`/`configurationPublicationId` are used by `applyConfiguration`, the overview's resume detection and their tests. `PublishAndDeployResult` is unchanged and returned by both apply paths. `EnvironmentCapabilityReport` is produced by `findEnvironmentReports` and read by the decision guard and the capability view. `appScopeFor(tenant, requested?)` is the only app-scope rule of Task 12. `switchTenantPlan(db, input)` is used identically by the test and the command line.
