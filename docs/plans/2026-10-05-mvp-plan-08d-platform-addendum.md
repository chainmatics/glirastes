# Platform-Nachtrag nach P08b (P08d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what P08b deferred and what P04 opened before P09's Platform half measures its baseline and before P08c and P11 build on the decision path. The setup artifact (and with it the capability report and `glirastes sync`) accepts HEAD as a read method. A tool decision stores and signs only what differs from the code that reported the tool, so no dashboard save freezes a copy of a reported description or risk class, and a resent `unknown` no longer blocks a save. Two saves of one tool can no longer lose a field. P08b's new SQL is proved on an in-process database instead of mocks, and its app-scope conditions are pinned so that deleting one fails a test. A prompt-only revision keeps the signed decisions. Every deploy of a configuration rolls the app's current decisions out (or refuses older code with a reason), and a decision set can be applied again after its rollout was rolled back or superseded. `packages/db/MIGRATIONS.md` carries the rollout order with read-only queries that are proved against the real schema.

**Architecture:** Continue on `codex/mvp-platform` in `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform` from P08b's last commit `9014587`. No migration (P09 takes `0045`), no Citadel change, no SDK change, no new dependency. API store tests run on a migrated in-process PGlite: `drizzle()` from `drizzle-orm/pglite` creates the instance (the API's own `drizzle-orm` 0.39.3 resolves `@electric-sql/pglite` 0.5.8 as its peer), and the migrator applies the committed journal. The race fix moves the read-merge-write of one decision into one transaction under the app-row lock that reorder, promotion and connected apply already take. `decisionDeviations` and `boundToolOverride` share one per-field "differs from the reported value" rule. `ToolPolicyRevisionService.carry` names the configuration a deploy rolls out: the requested one when it signs the current decisions, else the revision that signs them over the newest code; older code is refused. Re-applies get deterministic attempt identities on top of `configurationApplyId`. Every task is a separately committed TDD cycle.

**Tech Stack:** TypeScript 5.9, Bun 1.3, NestJS 11, Vitest 3.2 (API), `bun:test` with `@electric-sql/pglite` 0.5.8 (DB), PGlite through `drizzle-orm/pglite` in the API's Vitest, Drizzle ORM 0.39.3 and drizzle-kit 0.30.6, zod 3.25.76 (requests) and `zod/v4` (the policy port).

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md sections 4.10 items 3 ("signierte `toolOverrides[]`-Deltas (nie Kopien lokaler Werte)"), 4, 5, 6 and 10, 4.5 (bounds, "Vorrang: Platform > lokal > Code", "Schutzfelder über alle Ebenen: das Strengste gewinnt"), 4.9 (effective policy, revocations), 7 ("geführter Rollback auf letzten gesunden Stand"); roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md rows owned by "Platform-Nachtrag" ("Platform-Schemas für Capability-Report und `glirastes sync` akzeptieren nur GET/POST/PUT/PATCH/DELETE …" and the Platform half of "`boundToolOverride` speichert unveränderte Beschreibung und No-op-Policy-Felder als Entscheidung …"); P04 ledger ruling X10/R5 (one Platform commit `fix(runtime-setup): accept head as a read method`, the legacy route scan stays at five methods); the P08b ledger `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/.superpowers/sdd/2026-10-05-mvp-plan-08b-platform-backend/progress.md` minors T1-T13 named below and its Task 14 checkpoint items 1 and 4; P09 plan `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-mvp-plan-09-metrics.md` Task 6 (measures this plan into its baseline) and its ledger ruling P17/X9 (P08d runs wholly before P09 Task 6, patches stay positional). Format, constraints and the shared contract follow `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-mvp-plan-08b-platform-backend.md`.

## Global Constraints

- No pushes, merges into `main`, npm publishes, deployments, or changes to any shared database. All commits stay local on `codex/mvp-platform`. Never connect to Neon: store tests run on in-process PGlite (API: `drizzle()` from `drizzle-orm/pglite`; DB package: `@electric-sql/pglite`), and the only `drizzle-kit` call (Task 11) runs with `DATABASE_URL=postgres://offline.invalid/unused`, so `packages/db/drizzle.config.ts` never loads a `.env` file (`check` does not connect).
- Never open, print or copy `.env*`, `.secrets/` or `.npmrc` contents.
- The SDK repository is not read or changed by any step.
- Shell `rm` is denied in this environment, and no step needs it: every new file is part of the change, tests close their PGlite instances, the mutation checks of Tasks 2-5 are reverted with `git apply -R` in the same step, and scratch files live in `mktemp -d` directories.
- Implementers never edit this plan file.
- Patches are applied from the worktree root with `git apply`, which is all-or-nothing. They were generated against `9014587` and applied cumulatively in task order; if one does not apply, stop and report instead of editing by hand. Neither `git apply -C1` nor a hand-adapted hunk is a substitute (the P08b ledger records both as process deviations in Tasks 7, 9 and 11). New files are written with exactly the content shown.
- TDD: verify RED first, then the minimal change, then GREEN. Tasks 2-4 test code that already exists; their RED is a mutation check: a patch that deletes exactly the conditions the new tests pin is applied, the tests fail, and the same patch is reverted with `git apply -R` before anything else happens (the worktree status is checked right after). Task 5 adds one more mutation check after its GREEN: deleting the app-row lock must fail the race test. Do not weaken protections; do not delete compatibility code (spec 1). Where an existing test encoded the behaviour this plan replaces, the step says which expectation changes and why.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution.
- Agent shells reset the working directory between calls. Every bash block below therefore starts with an absolute `cd`.
- Commands: API tests `cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run <path>`; the whole API suite always with `--maxWorkers=3` (the machine is loaded; `agent-jwt.service.spec.ts` and `content-boundary-logging.spec.ts` are known to time out under load, see the P08b ledger, so a single timeout there is rerun once before it counts as a difference); API typecheck `bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"` in `apps/api` (sources, specs and `scripts/`); DB `bun test` in `packages/db`. The API typecheck reads `@glirastes/db` from `packages/db/dist`; no task changes the DB schema, so the build of Task 0 is the only one. The PGlite store suites migrate a fresh database per file (5-20 s under load); their `beforeAll` allows 120 s.
- Baseline at `9014587` (P08b Task 14, re-measured on 2026-10-05 in a copy of `9014587`): API `Test Files  123 passed (123)`, `Tests  1373 passed | 10 skipped (1383)`, typecheck exit 0; Citadel `tsc` exit 0, `Test Files  39 passed (39)`, `Tests  256 passed (256)`, lint exit 0 with `✖ 30 problems (0 errors, 30 warnings)`; DB `117 pass`, `Ran 117 tests across 21 files.`; migration trio (`migrations-from-scratch`, `migration-baseline`, `bounded-tool-overrides-migration`) `8 pass` across 3 files.
- P09's Platform patches are positional and must stay applicable: no step touches `apps/api/src/product-profile.ts`, `apps/api/src/product-profile.spec.ts`, `packages/db/src/index.ts` or `packages/db/src/schema/index.ts`; `packages/db/MIGRATIONS.md` only gains a section appended at its end (Task 10 proves P09 Task 7's patch still applies); `apps/api/src/common/app-scope.ts` keeps exactly its two exports (P09 Task 6 greps for them); the newest journal tag stays `0044_bounded_tool_overrides`.
- Production follow-ups are prepared and requested, never executed: the rollout order and the read-only queries of Task 10 (Task 11 checkpoint).

### Decisions taken in this plan (veto possible)

| Topic | Decision | Why |
| --- | --- | --- |
| HEAD | The setup-artifact candidate `method` enum (`app-setup.dto.ts`) gains `HEAD`. Nothing else on the setup, capability-report or sync path has a method enum (`runtime-setup-v2.service.ts` builds the stable key from the string, derivation and the capability view read it as text). The legacy route scan (`runtime-setup.controller.ts`, candidates and local executions) stays at five methods and is pinned so. | P04 ledger X10/R5; SDK P04 Task 8 keeps the legacy scan at five methods, so the two stay in lockstep. |
| What "unchanged" means | (Ruled by the controller after the final review, 2026-10-05, ledger L43/L44, option A.) Per field, a value a save sets equal to the value the code reported is no new decision and is not stored (`riskClass`, `requiresApproval`, `enabled`, `allowedRoles` as a set, `description` exactly; the request schema and the setup DTO both trim). A restriction that is already stored (`enabled: false`, a risk class, `requiresApproval: true`, a non-empty role list) stays stored while a save leaves it alone, even where the code reports the same value. `boundToolOverride` signs every stored in-bounds restriction, also one the code matches (the runtime lays the signed entry over local code that can loosen without the Platform; spec 4.5 "das Strengste gewinnt"), and drops only copies that restrict nothing: a description equal to the code's, `enabled: true`, a relaxation the code already made, an empty role list. A save that ends with neither a deviation nor a stored restriction deletes the row. A restriction first sent while the code already reports it is dropped (P08c shows it as held by the code); legacy restriction copies are kept and signed (fail closed) and P08c offers "back to the code value" (`null`) to clear them. An out-of-bounds value the code has outgrown is a deviation and stays stored (P08b: clamped at publication). | Spec 4.10.3 "nie Kopien lokaler Werte"; roadmap row; P08b ledger T3. A stored copy of the reported description masks every later code or Stufe-2 description once P04 carries signed descriptions into the chat (Platform > lokal > Code). |
| Reported `unknown` | The request schema accepts the whole risk vocabulary, so a form that resends the reported `unknown` is not refused; that resend is no decision. Choosing `unknown` for a tool the code assessed answers 422 `{ code: 'tool_override_out_of_bounds', field: 'riskClass', reason: 'risk-class-unassessed' }` (new reason). An `unknown` tool is bounded as tier 3 (the port's `riskTier('unknown')` is 3): disable, confirmation, roles and description are allowed, a same-tier relabel is refused as before. A stored legacy `unknown` raise keeps being signed (unchanged). | Ledger X6 ("a reported `unknown` blocks every save of that tool"); P08b's decision "`unknown` is not an operator choice" stays true as a choice. |
| Race-free saves | `RuntimeAppSetupStore.decideToolOverride` reads, decides and writes (or deletes) one decision in one transaction under the app-row lock (`lockEnvironmentPipeline`, the lock reorder, promotion and connected apply share). `decide` runs inside; a refused decision throws before any write. `findToolOverride` and `upsertToolOverride` stay as the plain reads and writes the store tests pin. The PGlite race test records each transaction's statements and requires the lock before the read (PGlite serialises transactions by itself, so only that order shows what holds on Postgres); Task 5 Step 5 deletes the lock and the test fails. | P08b ledger T3. Chosen over `SELECT … FOR UPDATE` on the decision row (a first decision has no row to lock) and over compare-and-set (it needs a version column, i.e. a migration P09 would collide with). |
| PGlite in API tests | `apps/api/src/common/__tests__/pglite-database.ts` creates a migrated PGlite per test file (`createMigratedDatabase`, `seedApp`). It lives under `__tests__`, which `tsconfig.build.json` excludes from `nest build` and `tsconfig.spec.json` type-checks. | No dependency, lockfile or Vitest-config change; no network; the same journal production applies. |
| Ruling: deploys carry the current decisions | `run()` (explicit `POST …/runs/:runId/publish-and-deploy`, also every Managed promotion) and `applyConfiguration` of a published configuration roll out `ToolPolicyRevisionService.carry`: the requested configuration when it signs the current decisions (bounded by its code); else, when it has the code and prompt of the newest published configuration, the revision that signs them there (`target`: the newest configuration itself, or its policy-only revision, drafted and published through the direction-aware gate with the owner/admin self-approval every decision apply uses); else 409 `{ code: 'configuration_predates_tool_decisions' }` before anything is published or deployed. A deployment that already exists (the run composite, or the current attempt of the carried configuration) is finished as it was created. The connected run path keeps its P08b guards (`runConnected` applies the pending revision first, `assertNotReplaced` refuses a replaced run); this ruling does not change it. | Spec 4.5/4.9: decisions are app-wide restrictions, the strictest wins wherever the app runs; spec 1 "es soll alles reibungslos laufen": promoting the newest run or re-applying a configuration just works. Carrying onto older code is refused instead of drafted because a revision drafted over it would become the newest published configuration (`findLatestPublishedConfiguration` orders by revision number): every later save, the target, the connected overview's "apply" and its runtime would then build on older code, a silent code rollback. The granular four-eyes deployment routes (`POST /v1/apps/:appId/environments/:environmentId/deployments/deploy-latest-published`, `…/promotions`, `…/:deploymentId/rollback`) are not changed: a rollback restores the old pair as it was (spec 7), and the other two are checkpoint item 4. |
| Re-apply after an ended rollout | Attempt identities: attempt 0 is `configurationApplyId` (every existing deployment keeps its identity), attempt n ≥ 1 is `identity('configuration-apply', configuration, environment, 'attempt-n')`; the current attempt is the first one that is missing, pending or active (`currentConfigurationApply`). The apply resumes a pending or active attempt and starts the next one after a rolled-back or superseded attempt. The connected overview resumes a pending re-apply but still does not offer an ended rollout on its own (P08b Task 11: it must not undo a rollback); the explicit apply route is the re-apply. | P08b ledger T8/T11 minors; idempotent resume stays: two concurrent applies compute the same attempt identity. No migration. |
| Rollout documentation | A section appended to `packages/db/MIGRATIONS.md` with the deploy order, the apps-with-decisions query, the two tier-3 queries and the pre-`0044` description note; a DB test runs its three fenced queries against a migrated PGlite with seeded rows. | P09 constraint (append only); the P08b checkpoint's SELECTs had never been executed anywhere. |

### Shared contract changes (P08b contract items 1-7 otherwise unchanged)

- Item 5 (capability report and setup artifact): a candidate `method` may be `HEAD` (SDK P04 Task 8 reports HEAD routes as read tools; `OPTIONS` stays an SDK exclusion).
- Override save (`PATCH /v2/apps/:appId/runtime-setup/runs/:runId/tools/:toolId`): the body accepts `riskClass: 'unknown'`; a value equal to the reported one is no decision; 422 gains the reason `risk-class-unassessed`; the response and `policyRevision` are unchanged. P08c keeps sending only deviations (its binding list); the server no longer depends on it.
- Deploys: `POST …/runs/:runId/publish-and-deploy`, the Managed promotion and `POST …/configurations/:configurationRevisionId/apply` may now publish and deploy a different configuration than named (the revision that signs the current decisions; the result's `compositeId` and `deploymentId` name what was deployed), or answer 409 `configuration_predates_tool_decisions`. A repeated apply after a rollback deploys under a new attempt identity.

## Review Focus

1. **No save loses a field and no save stores a copy.** Two interleaved saves of one tool on a real (PGlite) database keep both fields, and each save takes the app-row lock inside its transaction before it reads (deleting the lock fails the test); a value a save sets equal to what the code reported is not stored, a stored restriction is kept and signed even where the code matches it (also for rows stored before this plan), only copies that restrict nothing are never signed, a save that leaves neither a deviation nor a stored restriction deletes the decision, and dropping copies never changes what the SDK's own resolution enforces (all valid golden vectors with a Platform layer). Pinned in Task 5 Steps 1 and 5 and Task 6 Step 1.
2. **No deploy rolls out an older decision set, or none, and none moves the code backwards.** The explicit run route, the Managed promotion and the apply of a published configuration roll the current decisions out (a decision taken back is not revived either); older code that does not sign them answers 409 before anything is published or deployed; an existing deployment is finished as created. Pinned in Task 8 Step 1.
3. **P08b's new SQL is proved, not mocked.** On a migrated PGlite: the whole-row replace and the app scope of a decision, the report selection with `lastAppliedDeploymentId`, the connected-environment guard, the `tool_overrides` column and its "absent when empty" rule (signed equals hashed), and the derivation's reading of signed deltas; a mutation patch shows that deleting each pinned condition fails a test. Pinned in Task 2 Step 4 and Task 3 Step 2.
4. **App scope narrows only for app-bound keys.** Each audit query (events, traces, one trace, sessions, one session) fails a SQL-level test when its `target_app_id` condition is deleted, and a tenant-wide key or a dashboard session (also one that carries an app) is never bound on audit, stream, gate, deployments or the inbox. Pinned in Task 4 Steps 1-2.
5. **A rollout can be repeated without losing idempotency.** After a rollback or supersession the same configuration deploys as the next attempt, a pending attempt is resumed and never duplicated, and the overview resumes a pending re-apply while still not offering an ended rollout on its own. Pinned in Task 9 Step 1.

---

## File Structure

All paths are relative to the worktree root `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`.

| File | Action | Responsibility |
| --- | --- | --- |
| `apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts`, `__tests__/runtime-setup-v2.controller.spec.ts`, `apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts` | Modify (Task 1) | HEAD in the candidate method enum; legacy scan pinned at five |
| `apps/api/src/common/__tests__/pglite-database.ts`, `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts` | Create (Task 2), modify (Tasks 5, 6) | Migrated PGlite for API store tests; setup store SQL |
| `apps/api/src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts` | Create (Task 3) | `tool_overrides` write/read, absent when empty, derivation read |
| `apps/api/src/modules/audit/__tests__/audit-app-scope-sql.spec.ts`, `apps/api/src/common/__tests__/app-scope-gaps.spec.ts` | Create / modify (Task 4) | SQL-level app scope of audit; unbound principals |
| `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts`, `drizzle-runtime-setup-v2.store.ts`, `runtime-setup-v2.service.ts`, `__tests__/runtime-setup-v2.service.spec.ts` | Modify (Tasks 5, 6) | `decideToolOverride`; deviations only, deletion |
| `apps/api/src/modules/runtime-setup-v2/tool-override.ts`, `__tests__/tool-override.spec.ts` | Modify (Task 6) | `decisionDeviations`, no-op rule in `boundToolOverride`, `unknown` in the request schema, reported description |
| `apps/api/src/modules/runtime-revisions/app-configuration.service.ts` (+ spec) | Modify (Task 7) | Prompt-only revision keeps signed decisions |
| `apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts` (+ spec), `publish-and-deploy.service.ts` (+ spec), `__tests__/decision-carry.spec.ts` | Modify / create (Task 8) | `carry`; deploys roll the current decisions out |
| `apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts` (+ spec), `publish-and-deploy.service.ts` (+ spec), `connected-overview.service.ts` (+ spec) | Modify (Task 9) | Apply attempts |
| `packages/db/MIGRATIONS.md`, `packages/db/src/__tests__/tool-decision-rollout.test.ts` | Modify (append) / create (Task 10) | Rollout order and proved read-only queries |

---

### Task 0: Verify the baseline (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Preconditions**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git branch --show-current
git rev-parse --short HEAD
git status --short | wc -l
node -e "const j=require('./packages/db/drizzle/meta/_journal.json'); console.log(j.entries.at(-1).tag)"
grep -c "export function boundAppOf\|export function appScopeFor" apps/api/src/common/app-scope.ts
```

Expected: `codex/mvp-platform`, `9014587`, `0`, `0044_bounded_tool_overrides`, `2`. Anything else: stop and report.

- [ ] **Step 2: Build the DB package and run the baseline gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && ./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"; ./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel && ./node_modules/.bin/tsc --noEmit; echo "citadel-tsc=$?"; ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "; L="$(mktemp -d)"; bun run lint > "$L/lint.log" 2>&1; echo "citadel-lint=$?"; grep "✖" "$L/lint.log"
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test 2>&1 | tail -4; bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts src/__tests__/bounded-tool-overrides-migration.test.ts 2>&1 | tail -4
```

Expected: `db-build=0`; `api-typecheck=0`, `Test Files  123 passed (123)`, `Tests  1373 passed | 10 skipped (1383)`; `citadel-tsc=0`, `Test Files  39 passed (39)`, `Tests  256 passed (256)`, `citadel-lint=0`, `✖ 30 problems (0 errors, 30 warnings)`; DB `117 pass`, `0 fail`, `Ran 117 tests across 21 files.`; the trio `8 pass`, `0 fail`, `Ran 8 tests across 3 files.` Any difference: stop and report before Task 1.

---

### Task 1: API – accept HEAD as a read method in the setup artifact

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts:121-122`
- Test: `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts` (two cases before "rejects provenance outside the shared vocabulary by path"), `apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts` (one pin before "requires a server-verified dashboard actor")

**Interfaces:**
- Consumes: `appSetupArtifactSchema` (strict, P08b Task 9), `RuntimeSetupV2Controller.putArtifact` (answers `{ code: 'app_setup_request_invalid', paths }`), the legacy `routeScanSchema` (`runtime-setup.controller.ts:26-95`).
- Produces: `appSetupToolCandidateSchema.method`: `'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`. The legacy `scanCandidateSchema.exportName`/`.method` and `localExecutionSchema` endpoint `method` stay at five methods.

Since P04 Task 8 the SDK enumerates a HEAD route export as a read tool (`GET`/`HEAD` defaults, `<resource>.head`); an app with a HEAD export would otherwise get 400 on its setup artifact and lose its capability report. Upload, capability report and `glirastes sync` share the one DTO, and no other step of that path checks the method against an enum.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
@@ -593,6 +593,43 @@ describe('RuntimeSetupV2Controller', () => {
     }
   });
 
+  /**
+   * Since P04 the SDK reports a HEAD route export as a read tool; the setup
+   * artifact (and with it the capability report and `glirastes sync`)
+   * carries it like any other endpoint.
+   */
+  it('accepts HEAD as a read method in a setup artifact', async () => {
+    const saveArtifact = vi.fn().mockResolvedValue(runView);
+    const controller = controllerWith({ saveArtifact });
+
+    await controller.putArtifact(setupKeyTenant, APP_ID, RUN_ID, {
+      ...artifact,
+      tools: [{ ...artifact.tools[0], method: 'HEAD', path: '/api/tasks' }],
+    });
+
+    expect(saveArtifact).toHaveBeenCalledTimes(1);
+    expect(saveArtifact.mock.calls[0][2].tools[0]).toMatchObject({
+      method: 'HEAD',
+      path: '/api/tasks',
+    });
+  });
+
+  it('still refuses a method outside the shared vocabulary by path', async () => {
+    const saveArtifact = vi.fn();
+    const controller = controllerWith({ saveArtifact });
+
+    await expect(controller.putArtifact(setupKeyTenant, APP_ID, RUN_ID, {
+      ...artifact,
+      tools: [{ ...artifact.tools[0], method: 'OPTIONS', path: '/api/tasks' }],
+    })).rejects.toMatchObject({
+      response: {
+        code: 'app_setup_request_invalid',
+        paths: ['tools.0.method'],
+      },
+    });
+    expect(saveArtifact).not.toHaveBeenCalled();
+  });
+
   it('rejects provenance outside the shared vocabulary by path', async () => {
     const saveArtifact = vi.fn();
     const controller = controllerWith({ saveArtifact });
diff --git a/apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts b/apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts
--- a/apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts
+++ b/apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts
@@ -390,6 +390,49 @@ describe('RuntimeSetupController', () => {
     )).rejects.toThrow(BadRequestException);
   });
 
+  /**
+   * HEAD is a tool only in the v2 setup artifact. This legacy upload keeps its
+   * five-method contract, exactly as the SDK's legacy route scan does (P04).
+   */
+  it('keeps the legacy route scan at five methods', async () => {
+    const importRouteScan = vi.fn();
+    const controller = new RuntimeSetupController({ importRouteScan } as never);
+    const tenant = {
+      id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
+      userId: 'editor-1',
+      memberRole: 'editor',
+    } as never;
+
+    await expect(controller.importRouteScan(
+      tenant,
+      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
+      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
+      {
+        ...scan,
+        candidates: [{ ...scan.candidates[0], exportName: 'HEAD', method: 'HEAD' }],
+      },
+    )).rejects.toThrow(BadRequestException);
+    await expect(controller.importRouteScan(
+      tenant,
+      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
+      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
+      {
+        ...scan,
+        executions: [{
+          definitionId: 'tasks.head',
+          stableKey: 'HEAD /api/tasks',
+          executionKind: 'endpoint',
+          method: 'HEAD',
+          path: '/api/tasks',
+          sourceFingerprint: `sha256:${'C'.repeat(43)}`,
+          inputSchemaDigest: `sha256:${'A'.repeat(43)}`,
+          outputSchemaDigest: `sha256:${'B'.repeat(43)}`,
+        }],
+      },
+    )).rejects.toThrow(BadRequestException);
+    expect(importRouteScan).not.toHaveBeenCalled();
+  });
+
   it('requires a server-verified dashboard actor', async () => {
     const controller = new RuntimeSetupController({
       importRouteScan: vi.fn(),
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts 2>&1 | grep -E "×|Test Files|Tests "
```

Expected: one `×`, "RuntimeSetupV2Controller > accepts HEAD as a read method in a setup artifact" (400 `app_setup_request_invalid` for `tools.0.method`), `Test Files  1 failed | 1 passed (2)`, `Tests  1 failed | 40 passed (41)`. The two pins ("still refuses a method outside the shared vocabulary by path", "keeps the legacy route scan at five methods") already pass.

- [ ] **Step 3: Add HEAD to the candidate method enum**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts b/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts
--- a/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts
+++ b/apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts
@@ -118,8 +118,9 @@ const appSetupToolCandidateSchema = z.object({
     approval: z.string().trim().min(1).max(500),
   }).strict().optional(),
   executionKind: z.enum(['endpoint', 'ui']),
-  // Technical facts about the operation. Never a source location.
-  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
+  // Technical facts about the operation. Never a source location. HEAD is
+  // a read like GET (SDK P04); OPTIONS stays an exclusion in the SDK.
+  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
   path: z.string().startsWith('/').max(2_048).optional(),
   authBindingRef: identifier.optional(),
   actionBindingRef: identifier.optional(),
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/runtime-setup 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  41 passed (41)`; `Test Files  18 passed (18)`, `Tests  333 passed (333)`; `Test Files  123 passed (123)`, `Tests  1376 passed | 10 skipped (1386)`; `api-typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts apps/api/src/modules/runtime-setup/__tests__/runtime-setup.controller.spec.ts
git commit -m "fix(runtime-setup): accept head as a read method"
```

---

### Task 2: API – prove the setup store's SQL on a migrated PGlite

**Files:**
- Create: `apps/api/src/common/__tests__/pglite-database.ts`, `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts`
- Test: the new spec (six tests), the mutation check of Step 4

**Interfaces:**
- Consumes: `DrizzleRuntimeSetupV2Store` (`upsertToolOverride` whole-row replace at `drizzle-runtime-setup-v2.store.ts:646-682`, `findToolOverride` `:684-698`, `findEnvironmentReports` `:700-755`, `listToolOverrides` `:757-768`, `assertConnectedEnvironment` and `assertConnectedEnvironmentIn` `:78-117`), the committed journal `packages/db/drizzle`, `drizzle-orm/pglite` (`drizzle()` without a client creates an in-memory PGlite; the migrator is `drizzle-orm/pglite/migrator`).
- Produces: `createMigratedDatabase(): Promise<MigratedDatabase>` (`{ db: Database; close(): Promise<void> }`), `MIGRATED_DATABASE_TIMEOUT_MS = 120_000`, `seedApp(db, { plan?, tenantId? }): Promise<SeededApp>` (`{ tenantId; targetAppId }`, a second app of an existing tenant when `tenantId` is given). Tasks 3, 5 and 6 reuse them.

These are the P08b ledger minors T3 (whole-decision replace and `findToolOverride` only mocked), T9 (`findEnvironmentReports` SQL), T10 (`lastAppliedDeploymentId` mapping) and T11 (`assertConnectedEnvironment` has no store test). The seeds insert the smallest rows the foreign keys accept; every test uses its own tenant and app, so the six share one migrated database.

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  agentRevisions,
  manifestRevisions,
  runtimeAppSetupArtifacts,
  runtimeAppSetupRuns,
  runtimeAppSetupToolOverrides,
  runtimeDeployments,
  runtimeEnvironments,
  runtimePolicyRevisions,
  runtimeRunners,
} from '@glirastes/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  MIGRATED_DATABASE_TIMEOUT_MS,
  seedApp,
  type MigratedDatabase,
  type SeededApp,
} from '../../../common/__tests__/pglite-database';
import { DrizzleRuntimeSetupV2Store } from '../drizzle-runtime-setup-v2.store';

const TOOL_ID = '019fb800-0000-7000-8000-000000000006';
const digest = (seed: string) => `sha256:${seed.repeat(43).slice(0, 43)}`;

let database: MigratedDatabase;
let store: DrizzleRuntimeSetupV2Store;

beforeAll(async () => {
  database = await createMigratedDatabase();
  store = new DrizzleRuntimeSetupV2Store(database.db);
}, MIGRATED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await database?.close();
});

async function seedRun(
  app: SeededApp,
  input: {
    discoveryDigest: string;
    createdAt: Date;
    status?: string;
    artifactTools?: Array<Record<string, unknown>>;
  },
): Promise<string> {
  const runId = randomUUID();
  await database.db.insert(runtimeAppSetupRuns).values({
    id: runId,
    ...app,
    assessmentMode: 'autonomous',
    discoveryDigest: input.discoveryDigest,
    status: input.status ?? 'ready',
    startedBy: 'editor-1',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  if (input.artifactTools) {
    await database.db.insert(runtimeAppSetupArtifacts).values({
      ...app,
      runId,
      artifactDigest: `sha256:artifact-${runId}`,
      artifact: { discoveryDigest: input.discoveryDigest, tools: input.artifactTools },
      generatedAt: input.createdAt,
      importedBy: 'editor-1',
    });
  }
  return runId;
}

async function seedEnvironment(
  app: SeededApp,
  input: {
    promotionOrder: number;
    status?: string;
    lastSeenAt?: Date | null;
  },
): Promise<string> {
  const environmentId = randomUUID();
  await database.db.insert(runtimeEnvironments).values({
    id: environmentId,
    ...app,
    key: `env-${input.promotionOrder}`,
    name: `Environment ${input.promotionOrder}`,
    kind: 'production',
    status: input.status ?? 'connected',
    promotionOrder: input.promotionOrder,
    lastSeenAt: input.lastSeenAt === undefined ? new Date() : input.lastSeenAt,
  });
  return environmentId;
}

/** A pending deployment with the minimal revisions its foreign keys need. */
async function seedDeployment(
  app: SeededApp,
  environmentId: string,
): Promise<string> {
  const [agent] = await database.db.insert(agentRevisions).values({
    ...app,
    agentId: randomUUID(),
    revision: 1,
    definition: {},
    contentHash: 'sha256:agent',
    createdBy: 'editor-1',
  }).returning({ id: agentRevisions.id });
  const [manifest] = await database.db.insert(manifestRevisions).values({
    ...app,
    environmentId,
    revision: 1,
    manifest: {},
    contentHash: 'sha256:manifest',
    createdBy: 'editor-1',
  }).returning({ id: manifestRevisions.id });
  const [policy] = await database.db.insert(runtimePolicyRevisions).values({
    ...app,
    environmentId,
    revision: 1,
    policy: {},
    contentHash: 'sha256:policy',
    createdBy: 'editor-1',
  }).returning({ id: runtimePolicyRevisions.id });
  const [deployment] = await database.db.insert(runtimeDeployments).values({
    ...app,
    environmentId,
    agentRevisionId: agent!.id,
    manifestRevisionId: manifest!.id,
    runtimePolicyRevisionId: policy!.id,
    createdBy: 'editor-1',
  }).returning({ id: runtimeDeployments.id });
  return deployment!.id;
}

async function seedRunner(
  app: SeededApp,
  environmentId: string,
  input: {
    capabilities: Record<string, unknown>;
    lastSeenAt: Date;
    lastAppliedDeploymentId?: string;
  },
): Promise<void> {
  await database.db.insert(runtimeRunners).values({
    ...app,
    environmentId,
    runnerKey: `runner-${environmentId}`,
    version: '0.5.0',
    status: 'online',
    capabilities: input.capabilities,
    lastSeenAt: input.lastSeenAt,
    lastAppliedDeploymentId: input.lastAppliedDeploymentId ?? null,
  });
}

describe('stored tool decisions (PGlite)', () => {
  it('replaces a decision as a whole and reads every column back', async () => {
    const app = await seedApp(database.db);
    const firstRun = await seedRun(app, {
      discoveryDigest: digest('A'),
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });
    const secondRun = await seedRun(app, {
      discoveryDigest: digest('B'),
      createdAt: new Date('2026-10-02T10:00:00Z'),
    });

    await store.upsertToolOverride({
      ...app,
      runId: firstRun,
      toolId: TOOL_ID,
      override: {
        description: 'Archives a task.',
        riskClass: 'delete',
        requiresApproval: true,
        enabled: false,
        allowedRoles: ['admin', 'member'],
        baselineRiskClass: 'write',
        baselineRequiresApproval: true,
      },
      updatedBy: 'editor-1',
    });
    await expect(store.findToolOverride(app, TOOL_ID)).resolves.toEqual({
      toolId: TOOL_ID,
      description: 'Archives a task.',
      riskClass: 'delete',
      requiresApproval: true,
      enabled: false,
      allowedRoles: ['admin', 'member'],
      baselineRiskClass: 'write',
      baselineRequiresApproval: true,
    });

    // Whole-row replace: a field the new decision leaves out is written as
    // null, never kept from the previous row.
    await store.upsertToolOverride({
      ...app,
      runId: secondRun,
      toolId: TOOL_ID,
      override: { enabled: false },
      updatedBy: 'editor-2',
    });
    await expect(store.findToolOverride(app, TOOL_ID)).resolves.toEqual({
      toolId: TOOL_ID,
      enabled: false,
    });
    const rows = await database.db.select({
      runId: runtimeAppSetupToolOverrides.runId,
      updatedBy: runtimeAppSetupToolOverrides.updatedBy,
      allowedRoles: runtimeAppSetupToolOverrides.allowedRoles,
      description: runtimeAppSetupToolOverrides.description,
    }).from(runtimeAppSetupToolOverrides).where(and(
      eq(runtimeAppSetupToolOverrides.targetAppId, app.targetAppId),
      eq(runtimeAppSetupToolOverrides.toolId, TOOL_ID),
    ));
    expect(rows).toEqual([{
      runId: secondRun,
      updatedBy: 'editor-2',
      allowedRoles: null,
      description: null,
    }]);
  });

  it('keeps one decision per app and tool and finds none for an undecided tool', async () => {
    const app = await seedApp(database.db);
    // Same tenant: only the app condition keeps the two decisions apart.
    const other = await seedApp(database.db, { tenantId: app.tenantId });
    const runId = await seedRun(app, {
      discoveryDigest: digest('A'),
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });
    const otherRunId = await seedRun(other, {
      discoveryDigest: digest('A'),
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });
    await store.upsertToolOverride({
      ...other,
      runId: otherRunId,
      toolId: TOOL_ID,
      override: { enabled: false },
      updatedBy: 'editor-1',
    });

    await expect(store.findToolOverride(app, TOOL_ID)).resolves.toBeNull();
    await expect(store.listToolOverrides(app)).resolves.toEqual([]);

    await store.upsertToolOverride({
      ...app,
      runId,
      toolId: TOOL_ID,
      override: { allowedRoles: [] },
      updatedBy: 'editor-1',
    });
    // An empty role list is stored as such; it narrows nothing.
    await expect(store.listToolOverrides(app)).resolves.toEqual([
      { toolId: TOOL_ID, allowedRoles: [] },
    ]);
    await expect(store.findToolOverride(other, TOOL_ID)).resolves.toEqual({
      toolId: TOOL_ID,
      enabled: false,
    });
  });
});

describe('capability reports per environment (PGlite)', () => {
  it('reads the newest reported artifact and the deployment each runner last applied', async () => {
    const app = await seedApp(database.db);
    const other = await seedApp(database.db);
    const reporting = await seedEnvironment(app, { promotionOrder: 0 });
    const silent = await seedEnvironment(app, { promotionOrder: 1 });
    const unknownDigest = await seedEnvironment(app, { promotionOrder: 2 });
    const otherEnvironment = await seedEnvironment(other, { promotionOrder: 0 });
    const tools = [{ toolId: TOOL_ID, riskClass: 'write' }];
    const withArtifact = await seedRun(app, {
      discoveryDigest: digest('D'),
      createdAt: new Date('2026-10-01T10:00:00Z'),
      artifactTools: tools,
    });
    // Newer, but its artifact never arrived: the older run carries the report.
    await seedRun(app, {
      discoveryDigest: digest('D'),
      createdAt: new Date('2026-10-03T10:00:00Z'),
    });
    await seedRun(other, {
      discoveryDigest: digest('D'),
      createdAt: new Date('2026-10-04T10:00:00Z'),
      artifactTools: [{ toolId: TOOL_ID, riskClass: 'delete' }],
    });
    const applied = await seedDeployment(app, reporting);
    const seenAt = new Date('2026-10-05T09:00:00Z');
    await seedRunner(app, reporting, {
      capabilities: { discoveryDigest: digest('D'), streaming: true },
      lastSeenAt: seenAt,
      lastAppliedDeploymentId: applied,
    });
    await seedRunner(app, silent, {
      capabilities: { streaming: true },
      lastSeenAt: seenAt,
    });
    await seedRunner(app, unknownDigest, {
      capabilities: { discoveryDigest: digest('U') },
      lastSeenAt: seenAt,
    });
    await seedRunner(other, otherEnvironment, {
      capabilities: { discoveryDigest: digest('D') },
      lastSeenAt: seenAt,
    });

    const reports = await store.findEnvironmentReports(app);

    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.environmentId === reporting))
      .toEqual({
        environmentId: reporting,
        discoveryDigest: digest('D'),
        reportedAt: seenAt,
        runId: withArtifact,
        artifact: expect.objectContaining({
          artifact: { discoveryDigest: digest('D'), tools },
        }),
        lastAppliedDeploymentId: applied,
      });
    expect(reports.find((report) => report.environmentId === unknownDigest))
      .toEqual({
        environmentId: unknownDigest,
        discoveryDigest: digest('U'),
        reportedAt: seenAt,
        runId: null,
        artifact: null,
        lastAppliedDeploymentId: null,
      });
  });

  it('reports nothing for an app without a reporting runner', async () => {
    const app = await seedApp(database.db);
    await seedEnvironment(app, { promotionOrder: 0 });

    await expect(store.findEnvironmentReports(app)).resolves.toEqual([]);
  });
});

describe('the connected environment guard (PGlite)', () => {
  it('accepts only the first pipeline environment with a fresh, connected runner', async () => {
    const app = await seedApp(database.db);
    const first = await seedEnvironment(app, { promotionOrder: 0 });
    const second = await seedEnvironment(app, { promotionOrder: 1 });
    const now = new Date();

    await expect(store.assertConnectedEnvironment({
      ...app,
      environmentId: first,
      now,
    })).resolves.toBeUndefined();
    await expect(store.assertConnectedEnvironment({
      ...app,
      environmentId: second,
      now,
    })).rejects.toMatchObject({
      response: { code: 'connected_apply_environment_not_first' },
    });
    await expect(store.assertConnectedEnvironment({
      ...app,
      environmentId: first,
      now: new Date(now.getTime() + 90_001),
    })).rejects.toThrow('Connected runtime is not fresh');
  });

  it('refuses a disconnected environment, a Free pipeline with two and an unknown app', async () => {
    const disconnected = await seedApp(database.db);
    const environment = await seedEnvironment(disconnected, {
      promotionOrder: 0,
      status: 'disconnected',
    });
    await expect(store.assertConnectedEnvironment({
      ...disconnected,
      environmentId: environment,
      now: new Date(),
    })).rejects.toBeInstanceOf(ConflictException);

    const free = await seedApp(database.db, { plan: 'free' });
    const freeFirst = await seedEnvironment(free, { promotionOrder: 0 });
    await seedEnvironment(free, { promotionOrder: 1 });
    await expect(store.assertConnectedEnvironment({
      ...free,
      environmentId: freeFirst,
      now: new Date(),
    })).rejects.toMatchObject({
      response: { code: 'connected_free_environment_pipeline_forbidden' },
    });

    await expect(store.assertConnectedEnvironment({
      tenantId: disconnected.tenantId,
      targetAppId: randomUUID(),
      environmentId: environment,
      now: new Date(),
    })).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts 2>&1 | grep -E "^Error|Test Files|Tests "
```

Expected: `Error: Cannot find module '../../../common/__tests__/pglite-database' imported from …/runtime-setup-v2.store.pglite.spec.ts`, `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Add the migrated-PGlite helper and see GREEN**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/common/__tests__/pglite-database.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { targetApps, tenants, type Database } from '@glirastes/db';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

/** The committed Drizzle journal: the same migrations production applies. */
const migrationsFolder = fileURLToPath(
  new URL('../../../../../packages/db/drizzle', import.meta.url),
);

/** PGlite migrates every journal entry once per file; this bounds the hook. */
export const MIGRATED_DATABASE_TIMEOUT_MS = 120_000;

export interface MigratedDatabase {
  db: Database;
  close(): Promise<void>;
}

/**
 * A fresh in-process PostgreSQL (PGlite) with every Drizzle migration applied.
 * Store tests prove their SQL against it; nothing ever reaches a network
 * database. One instance per test file (`beforeAll`), one app per test.
 */
export async function createMigratedDatabase(): Promise<MigratedDatabase> {
  const db = drizzle();
  await migrate(db, { migrationsFolder });
  return {
    // The stores are typed for the Neon client; both speak the same
    // drizzle-orm Postgres dialect and query builder.
    db: db as unknown as Database,
    close: () => db.$client.close(),
  };
}

export interface SeededApp {
  tenantId: string;
  targetAppId: string;
}

/**
 * An app with a fresh identity, in a new tenant (or in `tenantId`, which must
 * exist already, for a second app of the same tenant).
 */
export async function seedApp(
  db: Database,
  input: { plan?: string; tenantId?: string } = {},
): Promise<SeededApp> {
  const tenantId = input.tenantId ?? randomUUID();
  const targetAppId = randomUUID();
  if (!input.tenantId) {
    await db.insert(tenants).values({
      id: tenantId,
      name: 'Tenant',
      slug: `tenant-${tenantId}`,
      plan: input.plan ?? 'pro',
    });
  }
  await db.insert(targetApps).values({
    id: targetAppId,
    tenantId,
    name: 'App',
  });
  return { tenantId, targetAppId };
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.

- [ ] **Step 4: Prove the tests bite (mutation check, reverted in the same block)**

The patch deletes exactly what the tests pin: the decided fields in the conflict update (whole-row replace), the app condition of `findToolOverride`, the freshness clause of the connected guard and the `lastAppliedDeploymentId` mapping.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
M="$(mktemp -d)/mutation.patch"
cat > "$M" <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -110,8 +110,6 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
       !environment
       || environment.status !== 'connected'
       || !environment.lastSeenAt
-      || input.now.getTime() - environment.lastSeenAt.getTime()
-        > CONNECTED_APPLY_FRESHNESS_MS
     ) {
       throw new ConflictException('Connected runtime is not fresh');
     }
@@ -673,7 +671,6 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
           runtimeAppSetupToolOverrides.toolId,
         ],
         set: {
-          ...decided,
           runId: input.runId,
           updatedBy: input.updatedBy,
           updatedAt: new Date(),
@@ -690,7 +687,6 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
       .from(runtimeAppSetupToolOverrides)
       .where(and(
         eq(runtimeAppSetupToolOverrides.tenantId, scope.tenantId),
-        eq(runtimeAppSetupToolOverrides.targetAppId, scope.targetAppId),
         eq(runtimeAppSetupToolOverrides.toolId, toolId),
       ))
       .limit(1);
@@ -749,7 +745,7 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
         reportedAt: runner.lastSeenAt,
         runId: run?.id ?? null,
         artifact: run ? artifactByRun.get(run.id) ?? null : null,
-        lastAppliedDeploymentId: runner.lastAppliedDeploymentId,
+        lastAppliedDeploymentId: null,
       };
     });
   }
PATCH
git apply "$M"
(cd apps/api && ./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts 2>&1 | grep -E "×|Test Files|Tests ")
git apply -R "$M"
git status --short
```

Expected: four `×` lines ("replaces a decision as a whole and reads every column back", "keeps one decision per app and tool and finds none for an undecided tool", "reads the newest reported artifact and the deployment each runner last applied", "accepts only the first pipeline environment with a fresh, connected runner"), `Test Files  1 failed (1)`, `Tests  4 failed | 2 passed (6)`; after the revert `git status --short` lists exactly the two new files (`?? apps/api/src/common/__tests__/pglite-database.ts`, `?? apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts`).

- [ ] **Step 5: Run the whole API suite and the typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  124 passed (124)`, `Tests  1382 passed | 10 skipped (1392)`; `api-typecheck=0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/common/__tests__/pglite-database.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
git commit -m "test(runtime-setup): prove the setup store sql on pglite"
```

---

### Task 3: API – prove the signed `tool_overrides` column on PGlite

**Files:**
- Create: `apps/api/src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts`
- Test: the new spec (three tests), the mutation check of Step 2

**Interfaces:**
- Consumes: Task 2 `createMigratedDatabase`, `seedApp`; `DrizzleRuntimeRevisionStore.createDraftSet`/`createDraft`/`findRevision` (config insert `drizzle-runtime-revision.store.ts:605-644`, `payloadFor` "absent when empty" `:732-766`); `DrizzleDesiredStateDerivationStore.findPublishedConfiguration`/`findLatestPublishedConfiguration` (`drizzle-desired-state-derivation.store.ts:27-76`); `canonicalRuntimeJson`; the content-hash rule of `RuntimeRevisionService.prepareDraft` (`runtime-revision.service.ts:655-657`).
- Produces: nothing new; pins the column write, the read-back payload (signed equals hashed), the empty case and the derivation's read.

These are the P08b ledger minors T4 ("the `tool_overrides` write and the payloadFor 'absent when empty' rule (signed == hashed) have no store-level test") and T5 ("the `tool_overrides` column mapping has no store-level (PGlite) test").

- [ ] **Step 1: Write the tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { runtimeConfigRevisions } from '@glirastes/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  MIGRATED_DATABASE_TIMEOUT_MS,
  seedApp,
  type MigratedDatabase,
  type SeededApp,
} from '../../../common/__tests__/pglite-database';
import { DrizzleDesiredStateDerivationStore } from '../../runtime-deployments/drizzle-desired-state-derivation.store';
import { DrizzleRuntimeRevisionStore } from '../drizzle-runtime-revision.store';
import { type PreparedRuntimeDraft } from '../runtime-revision.service';
import { canonicalRuntimeJson } from '../runtime-signing.service';

const TOOL_A = '019fb810-0000-7000-8000-00000000000a';
const TOOL_B = '019fb810-0000-7000-8000-00000000000b';
const digest = (seed: string) => `sha256:${seed.repeat(43).slice(0, 43)}`;

let database: MigratedDatabase;
let revisions: DrizzleRuntimeRevisionStore;
let derivation: DrizzleDesiredStateDerivationStore;

beforeAll(async () => {
  database = await createMigratedDatabase();
  revisions = new DrizzleRuntimeRevisionStore(database.db);
  derivation = new DrizzleDesiredStateDerivationStore(database.db);
}, MIGRATED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await database?.close();
});

/** The content hash `RuntimeRevisionService.prepareDraft` computes. */
const contentHash = (payload: unknown) => `sha256:${createHash('sha256')
  .update(canonicalRuntimeJson(payload))
  .digest('base64url')}`;

function draft(
  app: SeededApp,
  type: PreparedRuntimeDraft['type'],
  payload: Record<string, unknown>,
  extra: Partial<PreparedRuntimeDraft> = {},
): PreparedRuntimeDraft {
  return {
    ...app,
    type,
    payload,
    contentHash: contentHash(payload),
    createdBy: 'editor-1',
    ...extra,
  };
}

/** A prompt and a planner revision, then one configuration over them. */
async function createConfiguration(
  app: SeededApp,
  toolOverrides?: Array<Record<string, unknown>>,
) {
  const [prompt, planner] = await revisions.createDraftSet([
    draft(app, 'prompt', {
      schemaVersion: 1,
      bundleDigest: digest('B'),
      artifactRef: 'local://artifacts/prompt-bundle',
      plannerDigest: digest('P'),
      groupDigests: { appBehavior: digest('H') },
    }),
    draft(app, 'agent', {
      schemaVersion: 1,
      plannerId: randomUUID(),
      toolAllowlist: [TOOL_A],
    }, { subjectId: randomUUID() }),
  ]);
  // Exactly the payload `RuntimeAppConfigurationService` drafts: decisions
  // are absent when there are none.
  const payload = {
    schemaVersion: 1,
    setupArtifactDigest: digest('D'),
    runtimeDigest: digest('R'),
    promptDigest: digest('B'),
    promptRevisionId: prompt!.id,
    plannerRevisionId: planner!.id,
    tools: [{ toolId: TOOL_A, toolRevisionId: randomUUID(), tombstone: false }],
    ...(toolOverrides ? { toolOverrides } : {}),
  };
  const configuration = await revisions.createDraft(draft(app, 'config', payload));
  return { configuration, payload };
}

async function publish(configurationId: string): Promise<void> {
  await database.db.update(runtimeConfigRevisions).set({
    status: 'published',
    signature: 'signature',
    signingKeyId: 'key-1',
    publishedAt: new Date(),
    publishedBy: 'publisher-1',
  }).where(eq(runtimeConfigRevisions.id, configurationId));
}

const deltas = [
  { toolId: TOOL_A, enabled: false, allowedRoles: ['admin'] },
  { toolId: TOOL_B, requiresApproval: true, description: 'Archives a task.' },
];

describe('signed tool decisions on app configurations (PGlite)', () => {
  it('writes the deltas to tool_overrides and reads the drafted payload back', async () => {
    const app = await seedApp(database.db);
    const { configuration, payload } = await createConfiguration(app, deltas);

    const [row] = await database.db
      .select({ toolOverrides: runtimeConfigRevisions.toolOverrides })
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.id, configuration.id));
    expect(row!.toolOverrides).toEqual(deltas);

    const read = await revisions.findRevision({
      ...app,
      type: 'config',
      revisionId: configuration.id,
    });
    expect(read!.payload).toEqual(payload);
    // What is signed is what was hashed: the read payload reproduces it.
    expect(contentHash(read!.payload)).toBe(configuration.contentHash);
  });

  /**
   * A configuration without decisions keeps the payload and content hash it
   * had before decisions existed: `'[]'` in the column, no key in the payload.
   */
  it('keeps a configuration without decisions free of the key (absent when empty)', async () => {
    const app = await seedApp(database.db);
    const { configuration, payload } = await createConfiguration(app);

    const [row] = await database.db
      .select({ toolOverrides: runtimeConfigRevisions.toolOverrides })
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.id, configuration.id));
    expect(row!.toolOverrides).toEqual([]);

    const read = await revisions.findRevision({
      ...app,
      type: 'config',
      revisionId: configuration.id,
    });
    expect(read!.payload).not.toHaveProperty('toolOverrides');
    expect(canonicalRuntimeJson(read!.payload)).toBe(canonicalRuntimeJson(payload));
    expect(contentHash(read!.payload)).toBe(configuration.contentHash);
  });

  it('hands the signed deltas of a published configuration to the derivation', async () => {
    const app = await seedApp(database.db);
    const plain = await createConfiguration(app);
    const decided = await createConfiguration(app, deltas);
    await publish(plain.configuration.id);
    await publish(decided.configuration.id);

    await expect(derivation.findPublishedConfiguration(app, decided.configuration.id))
      .resolves.toMatchObject({
        id: decided.configuration.id,
        toolOverrides: deltas,
        signed: true,
      });
    await expect(derivation.findPublishedConfiguration(app, plain.configuration.id))
      .resolves.toMatchObject({ toolOverrides: [], signed: true });
    // The newest revision number wins, whatever was published first.
    await expect(derivation.findLatestPublishedConfiguration(app))
      .resolves.toMatchObject({
        id: decided.configuration.id,
        toolOverrides: deltas,
      });
    // Another app never sees it.
    const other = await seedApp(database.db, { tenantId: app.tenantId });
    await expect(derivation.findPublishedConfiguration(other, decided.configuration.id))
      .resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Prove the tests bite (mutation check, reverted in the same block)**

The patch writes an empty column whatever the draft signs, emits `toolOverrides` also when empty, and makes the derivation read none for a configuration it is asked for by id.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
M="$(mktemp -d)/mutation.patch"
cat > "$M" <<'PATCH'
diff --git a/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts b/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts
--- a/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts
+++ b/apps/api/src/modules/runtime-deployments/drizzle-desired-state-derivation.store.ts
@@ -70,7 +70,7 @@ implements DesiredStateDerivationStore {
       promptDigest: configuration.promptDigest,
       setupArtifactDigest: configuration.setupArtifactDigest,
       tools: configuration.tools as PublishedConfigurationRecord['tools'],
-      toolOverrides: configuration.toolOverrides as PublishedConfigurationRecord['toolOverrides'],
+      toolOverrides: [],
       signed: Boolean(configuration.signature && configuration.signingKeyId),
     };
   }
diff --git a/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts b/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
--- a/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
+++ b/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
@@ -625,7 +625,7 @@ export class DrizzleRuntimeRevisionStore implements RuntimeRevisionStore {
             'plannerRevisionId',
           ),
           tools: payload.tools ?? [],
-          toolOverrides: payload.toolOverrides ?? [],
+          toolOverrides: [],
           runtimeDigest: this.requiredString(
             payload.runtimeDigest,
             'runtimeDigest',
@@ -754,7 +754,7 @@ export class DrizzleRuntimeRevisionStore implements RuntimeRevisionStore {
         tools: row.tools,
         // Mirrors the drafting rule: absent when empty, so the stored payload
         // reproduces the content hash it was drafted with.
-        ...(Array.isArray(row.toolOverrides) && row.toolOverrides.length > 0
+        ...(Array.isArray(row.toolOverrides)
           ? { toolOverrides: row.toolOverrides }
           : {}),
         ...(row.parentRevisionId
PATCH
git apply "$M"
(cd apps/api && ./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts 2>&1 | grep -E "×|Test Files|Tests ")
git apply -R "$M"
git status --short
```

Expected: three `×` lines (all three tests), `Test Files  1 failed (1)`, `Tests  3 failed (3)`; after the revert `git status --short` lists exactly `?? apps/api/src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts`.

- [ ] **Step 3: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  3 passed (3)`; `Test Files  125 passed (125)`, `Tests  1385 passed | 10 skipped (1395)`; `api-typecheck=0`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-revisions/__tests__/configuration-tool-overrides.pglite.spec.ts
git commit -m "test(runtime-revisions): prove signed decision columns on pglite"
```

---

### Task 4: API – pin the audit app scope in SQL and the principals that are never bound

**Files:**
- Create: `apps/api/src/modules/audit/__tests__/audit-app-scope-sql.spec.ts`
- Modify: `apps/api/src/common/__tests__/app-scope-gaps.spec.ts` (append one `describe`)
- Test: both, plus the existing SQL pins in `audit.service.spec.ts`, and the mutation check of Step 2

**Interfaces:**
- Consumes: `AuditService.queryTraces` (`targetAppId` condition `audit.service.ts:153-155`), `.getTrace` (`:194`), `.querySessions` (raw SQL, `:240`), and the existing SQL pins of `.queryEvents` (`:74-76`) and `.getSessionDetail` (`:317`) in `audit.service.spec.ts:47-66`; `boundAppOf`/`appScopeFor` (`common/app-scope.ts:8-28`) through `AuditController`, `StreamController`, `GateConfigController`, `RuntimeDeploymentController`, `RuntimeRevisionController`.
- Produces: nothing new; `app-scope.ts` keeps exactly its two exports.

These are the P08b ledger minors of Task 12: "`queryTraces` and `getTrace` `target_app_id` conditions have no SQL-rendering test" (the sessions query had none either), and "app-scope-gaps.spec.ts has no case for a tenant-wide API key (apiKeyId, no targetAppId) or a session carrying targetAppId, and no dashboard pass-through for gate/deployments/inbox; the apiKeyId conjunct of boundAppOf is unpinned".

- [ ] **Step 1: Write the tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/audit/__tests__/audit-app-scope-sql.spec.ts`:

```ts
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../audit.service';

const dialect = new PgDialect();
const render = (statement: unknown) => dialect.sqlToQuery(statement as SQL);

/**
 * Records the SQL the service hands to Drizzle: every `where` condition and
 * every raw statement. Each query chain resolves to no rows.
 */
function recordingService() {
  const conditions: unknown[] = [];
  const statements: unknown[] = [];
  const chain = {
    from: () => chain,
    where: (condition: unknown) => {
      conditions.push(condition);
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  const db = {
    select: () => chain,
    selectDistinctOn: () => chain,
    execute: async (statement: unknown) => {
      statements.push(statement);
      return [];
    },
  };
  return {
    conditions,
    statements,
    service: new AuditService(db as never, {} as never),
  };
}

/**
 * The controller passes an app-bound key's app (P08b Task 12); these pins
 * fail as soon as the service drops the condition from the SQL it runs.
 */
describe('app scope in the audit SQL', () => {
  it('limits the trace list to the requested app', async () => {
    const { service, conditions } = recordingService();

    await service.queryTraces('tenant-1', { targetAppId: 'app-1' });
    await service.queryTraces('tenant-1', {});

    const [scoped, tenantWide] = conditions.map(render);
    expect(scoped!.sql).toContain('"audit_events"."target_app_id" = $');
    expect(scoped!.params).toContain('app-1');
    expect(tenantWide!.sql).not.toContain('target_app_id');
  });

  it('limits one trace to the requested app', async () => {
    const { service, conditions } = recordingService();

    await service.getTrace('tenant-1', 'trace-1', 'app-1');
    await service.getTrace('tenant-1', 'trace-1');

    const [scoped, tenantWide] = conditions.map(render);
    expect(scoped!.sql).toContain('"audit_events"."target_app_id" = $');
    expect(scoped!.params).toEqual(['tenant-1', 'trace-1', 'app-1']);
    expect(tenantWide!.sql).not.toContain('target_app_id');
  });

  it('limits the session list to the requested app', async () => {
    const { service, statements } = recordingService();

    await service.querySessions('tenant-1', { targetAppId: 'app-1' });
    await service.querySessions('tenant-1', {});

    const [scoped, tenantWide] = statements.map(render);
    expect(scoped!.sql).toContain('target_app_id = $');
    expect(scoped!.params).toContain('app-1');
    // The select list names the column too; only the filter must be absent.
    expect(tenantWide!.sql).not.toContain('target_app_id = $');
    expect(tenantWide!.params).not.toContain('app-1');
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/common/__tests__/app-scope-gaps.spec.ts b/apps/api/src/common/__tests__/app-scope-gaps.spec.ts
--- a/apps/api/src/common/__tests__/app-scope-gaps.spec.ts
+++ b/apps/api/src/common/__tests__/app-scope-gaps.spec.ts
@@ -165,3 +165,82 @@ describe('app-bound keys on the revision inbox', () => {
     expect(listInbox).toHaveBeenCalledWith({ tenantId: TENANT_ID, targetAppId: OWN_APP });
   });
 });
+
+/**
+ * Only an API key that names an app is bound to it. A tenant-wide key and a
+ * dashboard session (even one that carries an app in its context) keep the
+ * scope they ask for on every surface; `boundAppOf` needs both conjuncts.
+ */
+describe('principals that are not bound to an app', () => {
+  const tenantWideKey = {
+    id: TENANT_ID,
+    slug: 'acme',
+    plan: 'free' as const,
+    status: 'active' as const,
+    scopes: ['management'],
+    apiKeyId: 'key-2',
+  };
+  const sessionWithApp = { ...dashboard, targetAppId: OWN_APP };
+
+  it.each([
+    ['a tenant-wide key', tenantWideKey],
+    ['a dashboard session', dashboard],
+    ['a dashboard session that carries an app', sessionWithApp],
+  ])('%s reads the app it asks for, or the whole tenant', async (_name, principal) => {
+    const auditService = {
+      queryEvents: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
+      querySessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
+      queryTraces: vi.fn().mockResolvedValue({ traces: [], nextCursor: null }),
+    };
+    const audit = new AuditController(auditService as never);
+    await audit.queryEvents(principal);
+    await audit.queryTraces(principal);
+    await audit.querySessions(
+      principal,
+      undefined,
+      undefined,
+      undefined,
+      undefined,
+      OTHER_APP,
+    );
+    expect(auditService.queryEvents).toHaveBeenCalledWith(
+      TENANT_ID,
+      expect.objectContaining({ targetAppId: undefined }),
+    );
+    expect(auditService.queryTraces).toHaveBeenCalledWith(
+      TENANT_ID,
+      expect.objectContaining({ targetAppId: undefined }),
+    );
+    expect(auditService.querySessions).toHaveBeenCalledWith(
+      TENANT_ID,
+      expect.objectContaining({ targetAppId: OTHER_APP }),
+    );
+
+    const subscribe = vi.fn().mockReturnValue(of({ type: 'ping', timestamp: 'now' }));
+    await firstValueFrom(new StreamController({ subscribe } as never)
+      .events(principal, OTHER_APP));
+    expect(subscribe).toHaveBeenCalledWith(TENANT_ID, OTHER_APP);
+
+    const getToolAccess = vi.fn().mockResolvedValue([]);
+    await new GateConfigController({ getToolAccess } as never)
+      .getToolAccess(principal, OTHER_APP);
+    expect(getToolAccess).toHaveBeenCalledWith(TENANT_ID, OTHER_APP);
+
+    const list = vi.fn().mockResolvedValue([]);
+    await new RuntimeDeploymentController({ list } as never, {} as never)
+      .list(principal, OTHER_APP, ENVIRONMENT_ID);
+    expect(list).toHaveBeenCalledWith({
+      tenantId: TENANT_ID,
+      targetAppId: OTHER_APP,
+      environmentId: ENVIRONMENT_ID,
+    });
+
+    const listInbox = vi.fn().mockResolvedValue({ groups: [] });
+    await new RuntimeRevisionController({ listInbox } as never)
+      .listInbox(principal, OTHER_APP);
+    expect(listInbox).toHaveBeenCalledWith({
+      tenantId: TENANT_ID,
+      targetAppId: OTHER_APP,
+    });
+  });
+});
PATCH
```

- [ ] **Step 2: Prove the tests bite (mutation check, reverted in the same block)**

The patch deletes all five `target_app_id` conditions of `audit.service.ts` and the `apiKeyId` conjunct of `boundAppOf`.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
M="$(mktemp -d)/mutation.patch"
cat > "$M" <<'PATCH'
diff --git a/apps/api/src/common/app-scope.ts b/apps/api/src/common/app-scope.ts
--- a/apps/api/src/common/app-scope.ts
+++ b/apps/api/src/common/app-scope.ts
@@ -6,7 +6,7 @@ import { type TenantContext } from './types';
  * tenant-wide keys.
  */
 export function boundAppOf(tenant: TenantContext): string | undefined {
-  return tenant.apiKeyId && tenant.targetAppId ? tenant.targetAppId : undefined;
+  return tenant.targetAppId ? tenant.targetAppId : undefined;
 }
 
 /**
diff --git a/apps/api/src/modules/audit/audit.service.ts b/apps/api/src/modules/audit/audit.service.ts
--- a/apps/api/src/modules/audit/audit.service.ts
+++ b/apps/api/src/modules/audit/audit.service.ts
@@ -71,9 +71,6 @@ export class AuditService {
 
     const conditions: SQL[] = [eq(auditEvents.tenantId, tenantId)];
 
-    if (options.targetAppId) {
-      conditions.push(eq(auditEvents.targetAppId, options.targetAppId));
-    }
     if (options.from) {
       conditions.push(gte(auditEvents.createdAt, new Date(options.from)));
     }
@@ -150,9 +147,6 @@ export class AuditService {
       eq(auditEvents.tenantId, tenantId),
       isNotNull(auditEvents.traceId),
     ];
-    if (options.targetAppId) {
-      conditions.push(eq(auditEvents.targetAppId, options.targetAppId));
-    }
     if (options.from) conditions.push(gte(auditEvents.createdAt, new Date(options.from)));
     if (options.to) conditions.push(lte(auditEvents.createdAt, new Date(options.to)));
     if (options.cursor) {
@@ -191,7 +185,6 @@ export class AuditService {
         and(
           eq(auditEvents.tenantId, tenantId),
           eq(auditEvents.traceId, traceId),
-          ...(targetAppId ? [eq(auditEvents.targetAppId, targetAppId)] : []),
         ),
       )
       .orderBy(auditEvents.createdAt);
@@ -237,7 +230,6 @@ export class AuditService {
     if (options.from) conditions.push(sql`timestamp_ms >= ${new Date(options.from)}`);
     if (options.to) conditions.push(sql`timestamp_ms <= ${new Date(options.to)}`);
     if (options.actor) conditions.push(sql`actor::text ILIKE ${'%' + options.actor + '%'}`);
-    if (options.targetAppId) conditions.push(sql`target_app_id = ${options.targetAppId}`);
 
     const whereClause = sql.join(conditions, sql` AND `);
 
@@ -314,7 +306,6 @@ export class AuditService {
       .where(and(
         eq(auditEvents.tenantId, tenantId),
         eq(auditEvents.traceId, traceId),
-        ...(targetAppId ? [eq(auditEvents.targetAppId, targetAppId)] : []),
       ))
       .orderBy(auditEvents.timestampMs)
       .limit(500);
PATCH
git apply "$M"
(cd apps/api && ./node_modules/.bin/vitest run src/modules/audit src/common/__tests__/app-scope-gaps.spec.ts 2>&1 | grep -E "×|Test Files|Tests ")
git apply -R "$M"
git status --short
```

Expected: six `×` lines: the three new SQL pins, the two existing pins of `audit.service.spec.ts` ("restricts events to one app for an app-bound key", "restricts a session timeline to one app for an app-bound key") and "a dashboard session that carries an app reads the app it asks for, or the whole tenant"; `Test Files  3 failed | 3 passed (6)`, `Tests  6 failed | 56 passed (62)`; after the revert `git status --short` lists exactly ` M apps/api/src/common/__tests__/app-scope-gaps.spec.ts` and `?? apps/api/src/modules/audit/__tests__/audit-app-scope-sql.spec.ts`.

- [ ] **Step 3: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/audit src/common/__tests__/app-scope-gaps.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  6 passed (6)`, `Tests  62 passed (62)`; `Test Files  126 passed (126)`, `Tests  1391 passed | 10 skipped (1401)`; `api-typecheck=0`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/audit/__tests__/audit-app-scope-sql.spec.ts apps/api/src/common/__tests__/app-scope-gaps.spec.ts
git commit -m "test(audit): pin the app scope in audit sql and key principals"
```

---

### Task 5: API – save one tool decision in one locked transaction

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts` (types before `RuntimeAppSetupStore`, method after `findToolOverride`), `apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts:646-698`, `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts:364-434`
- Test: `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts` (append), `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts` (mock stores)

**Interfaces:**
- Consumes: `lockEnvironmentPipeline` (`apps/api/src/modules/apps/environment-pipeline-lock.ts:21-30`, `SELECT 1 FROM target_apps … FOR UPDATE`), Task 2's PGlite helpers, `RuntimeSetupV2Service.saveToolOverride` (P08b Task 3 and its fix round), `mergeToolOverride`, `withBaseline`, `boundToolOverride`, `classifyToolPolicyChange`.
- Produces:
  - `interface ToolOverrideDecision<T> { override: ToolOverrideFields; result: T }`
  - `interface DecideToolOverrideInput<T> extends AppSetupScope { runId; toolId; updatedBy; decide(stored: StoredToolOverride | null): ToolOverrideDecision<T> }`
  - `RuntimeAppSetupStore.decideToolOverride<T>(input): Promise<T>`; `DrizzleRuntimeSetupV2Store` implements it in one transaction (app-row lock, read, `decide`, whole-row write) and keeps `upsertToolOverride`/`findToolOverride` as thin wrappers of the same private `writeToolOverride`/`readToolOverride`.
  - `saveToolOverride` merges, bounds and refuses (422) inside `decide`; the audit payload is unchanged (`direction` is `decide`'s result).

This is the P08b ledger minor T3: "`findToolOverride` then whole-row `upsertToolOverride` is an unguarded read-modify-write; two concurrent saves on one tool lose fields (e.g. a description save can revert a concurrent disable)". The PGlite test is deterministic: PGlite serialises queries first-in-first-out, so the two unguarded saves interleave their read and write exactly as two dashboard requests can, while a PGlite transaction holds the instance until it commits. Because PGlite serialises whole transactions by itself, the transaction alone would already keep both fields there; on Postgres (read committed) only the app-row lock does. The test therefore also records what each save's transaction runs and requires the lock (`SELECT 1 FROM "target_apps" … FOR UPDATE`) before the read, and Step 5 deletes the lock to show that this fails.

- [ ] **Step 1: Write the failing test and give the mocked stores the new method**

In the service spec the first `describe` gets the method as a plain mock (its upload test now also proves that an upload decides nothing), and "recording a bounded tool decision" implements it as read, decide, write over the existing `findToolOverride`/`upsertToolOverride` mocks, so every existing expectation stays as it is. In the PGlite spec the race test runs the service over `recordingStore`, the same store on a proxy of the migrated database that records each transaction's statements (raw SQL rendered by `PgDialect`, query builders by name); the stored row is still read through the plain store.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
@@ -10,6 +10,7 @@ import { boundToolOverride, reportedToolPolicy } from '../tool-override';
 import {
   type AppSetupArtifactRecord,
   type AppSetupRunRecord,
+  type DecideToolOverrideInput,
   type RuntimeAppSetupStore,
 } from '../runtime-setup-v2.store';
 
@@ -134,6 +135,7 @@ describe('RuntimeSetupV2Service', () => {
       findArtifact: vi.fn().mockResolvedValue(null),
       upsertToolOverride: vi.fn().mockResolvedValue(undefined),
       findToolOverride: vi.fn().mockResolvedValue(null),
+      decideToolOverride: vi.fn(),
       findEnvironmentReports: vi.fn().mockResolvedValue([]),
       listToolOverrides: vi.fn().mockResolvedValue([]),
       insertArtifact: vi.fn().mockImplementation(
@@ -383,6 +385,7 @@ describe('RuntimeSetupV2Service', () => {
     expect(store.insertArtifact).toHaveBeenCalledTimes(1);
     expect(store.upsertToolOverride).not.toHaveBeenCalled();
     expect(store.findToolOverride).not.toHaveBeenCalled();
+    expect(store.decideToolOverride).not.toHaveBeenCalled();
   });
 
   it('accepts a repeated identical artifact upload without duplicating it', async () => {
@@ -993,6 +996,21 @@ describe('recording a bounded tool decision', () => {
       findArtifact: vi.fn().mockResolvedValue(storedArtifact),
       findToolOverride: vi.fn().mockResolvedValue(null),
       upsertToolOverride: vi.fn().mockResolvedValue(undefined),
+      // The transaction is the store's (proved on PGlite); here it is the
+      // read, the decision and the write in order, through the mocks above.
+      decideToolOverride: vi.fn(async (input: DecideToolOverrideInput<unknown>) => {
+        const stored = await store.findToolOverride(input, input.toolId);
+        const { override, result } = input.decide(stored);
+        await store.upsertToolOverride({
+          tenantId: input.tenantId,
+          targetAppId: input.targetAppId,
+          runId: input.runId,
+          toolId: input.toolId,
+          override,
+          updatedBy: input.updatedBy,
+        });
+        return result;
+      }),
       appendAudit: vi.fn().mockResolvedValue(undefined),
     } as unknown as RuntimeAppSetupStore;
     service = new RuntimeSetupV2Service(store, { publish: vi.fn() } as never);
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
@@ -11,7 +11,8 @@ import {
   runtimePolicyRevisions,
   runtimeRunners,
 } from '@glirastes/db';
-import { and, eq } from 'drizzle-orm';
+import { and, eq, type SQL } from 'drizzle-orm';
+import { PgDialect } from 'drizzle-orm/pg-core';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import {
   createMigratedDatabase,
@@ -21,6 +22,7 @@ import {
   type SeededApp,
 } from '../../../common/__tests__/pglite-database';
 import { DrizzleRuntimeSetupV2Store } from '../drizzle-runtime-setup-v2.store';
+import { RuntimeSetupV2Service } from '../runtime-setup-v2.service';
 
 const TOOL_ID = '019fb800-0000-7000-8000-000000000006';
 const digest = (seed: string) => `sha256:${seed.repeat(43).slice(0, 43)}`;
@@ -396,3 +398,88 @@ describe('the connected environment guard (PGlite)', () => {
     })).rejects.toBeInstanceOf(NotFoundException);
   });
 });
+
+/**
+ * Two operators save different fields of one tool at the same moment. Each
+ * save reads the stored decision, merges its field and writes the whole row
+ * back; without one transaction around that, the later write drops the
+ * other field (a description save could revert a concurrent disable).
+ */
+describe('two saves of one tool at the same time (PGlite)', () => {
+  /**
+   * The store over the migrated database, recording what each of its
+   * transactions runs, in order: raw SQL as rendered, query builders by
+   * name. PGlite runs one transaction at a time by itself; on Postgres only
+   * the app-row lock a save takes before it reads keeps two saves apart.
+   */
+  function recordingStore(transactions: string[][]): DrizzleRuntimeSetupV2Store {
+    const dialect = new PgDialect();
+    const db = new Proxy(database.db, {
+      get(target, property, receiver) {
+        if (property !== 'transaction') return Reflect.get(target, property, receiver);
+        return (run: (tx: unknown) => Promise<unknown>) => target.transaction(async (tx) => {
+          const statements: string[] = [];
+          transactions.push(statements);
+          return run(new Proxy(tx, {
+            get(inner, name, innerReceiver) {
+              const value: unknown = Reflect.get(inner, name, innerReceiver);
+              if (typeof value !== 'function' || typeof name !== 'string') return value;
+              return (...args: unknown[]) => {
+                statements.push(
+                  name === 'execute' ? dialect.sqlToQuery(args[0] as SQL).sql : name,
+                );
+                return value.apply(inner, args);
+              };
+            },
+          }));
+        });
+      },
+    });
+    return new DrizzleRuntimeSetupV2Store(db);
+  }
+
+  it('keeps the field of each save', async () => {
+    const app = await seedApp(database.db);
+    const runId = await seedRun(app, {
+      discoveryDigest: digest('D'),
+      createdAt: new Date('2026-10-01T10:00:00Z'),
+      artifactTools: [{
+        toolId: TOOL_ID,
+        riskClass: 'write',
+        requiresApproval: true,
+        enabled: true,
+      }],
+    });
+    const transactions: string[][] = [];
+    const service = new RuntimeSetupV2Service(
+      recordingStore(transactions),
+      { publish: async () => undefined } as never,
+    );
+    const editor = { userId: 'editor-1', role: 'editor' };
+
+    await Promise.all([
+      service.saveToolOverride(app, runId, TOOL_ID, { enabled: false }, editor),
+      service.saveToolOverride(
+        app,
+        runId,
+        TOOL_ID,
+        { description: 'Archives a task.' },
+        editor,
+      ),
+    ]);
+
+    await expect(store.findToolOverride(app, TOOL_ID)).resolves.toEqual({
+      toolId: TOOL_ID,
+      enabled: false,
+      description: 'Archives a task.',
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    });
+    // Each save locked the app row first, inside its own transaction.
+    const lock = expect.stringMatching(/^\s*SELECT 1 FROM "target_apps"[\s\S]+FOR UPDATE\s*$/);
+    expect(transactions).toEqual([
+      [lock, 'select', 'insert'],
+      [lock, 'select', 'insert'],
+    ]);
+  });
+});
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts 2>&1 | grep -E "×|Test Files|Tests |\"enabled\""
```

Expected: one `×`, "two saves of one tool at the same time (PGlite) > keeps the field of each save", with the diff line `-   "enabled": false,` (the description save read the row before the disable was written and wrote it back without it), `Test Files  1 failed | 1 passed (2)`, `Tests  1 failed | 64 passed (65)`. Every service test passes with the mocked `decideToolOverride`.

- [ ] **Step 3: Decide inside one transaction**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -26,6 +26,7 @@ import { canonicalRuntimeJson } from '../runtime-revisions/runtime-signing.servi
 import {
   type AppSetupArtifactRecord,
   type AppSetupRunRecord,
+  type DecideToolOverrideInput,
   type EnvironmentCapabilityReport,
   type RuntimeAppSetupStore,
 } from './runtime-setup-v2.store';
@@ -645,6 +646,32 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
 
   async upsertToolOverride(
     input: Parameters<RuntimeAppSetupStore['upsertToolOverride']>[0],
+  ): Promise<void> {
+    await this.writeToolOverride(this.db, input);
+  }
+
+  async findToolOverride(
+    scope: Parameters<RuntimeAppSetupStore['findToolOverride']>[0],
+    toolId: string,
+  ) {
+    return this.readToolOverride(this.db, scope, toolId);
+  }
+
+  async decideToolOverride<T>(input: DecideToolOverrideInput<T>): Promise<T> {
+    return this.db.transaction(async (tx) => {
+      // The app row is the lock every pipeline operation of the app takes;
+      // a second save of any tool of this app waits here until this commits.
+      await lockEnvironmentPipeline(tx, input);
+      const stored = await this.readToolOverride(tx, input, input.toolId);
+      const { override, result } = input.decide(stored);
+      await this.writeToolOverride(tx, { ...input, override });
+      return result;
+    });
+  }
+
+  private async writeToolOverride(
+    executor: Pick<Database, 'insert'>,
+    input: Parameters<RuntimeAppSetupStore['upsertToolOverride']>[0],
   ): Promise<void> {
     const decided = {
       description: input.override.description ?? null,
@@ -655,7 +682,7 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
       baselineRiskClass: input.override.baselineRiskClass ?? null,
       baselineRequiresApproval: input.override.baselineRequiresApproval ?? null,
     };
-    await this.db
+    await executor
       .insert(runtimeAppSetupToolOverrides)
       .values({
         tenantId: input.tenantId,
@@ -681,11 +708,12 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
       });
   }
 
-  async findToolOverride(
+  private async readToolOverride(
+    executor: Pick<Database, 'select'>,
     scope: Parameters<RuntimeAppSetupStore['findToolOverride']>[0],
     toolId: string,
   ) {
-    const rows = await this.db
+    const rows = await executor
       .select()
       .from(runtimeAppSetupToolOverrides)
       .where(and(
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
@@ -366,7 +366,8 @@ export class RuntimeSetupV2Service {
    * untouched: it records what the code reported, and the decision is stored
    * beside it so both remain visible. A decision outside the bounds the code
    * allows (spec 4.5) is refused with 422 and the reason code; nothing is
-   * stored then.
+   * stored then. The merge with the stored decision runs inside the store's
+   * transaction, so a concurrent save of another field is never lost.
    */
   async saveToolOverride(
     scope: AppSetupScope,
@@ -389,33 +390,39 @@ export class RuntimeSetupV2Service {
     }
 
     const reported = reportedToolPolicy(tool);
-    const stored = await this.store.findToolOverride(scope, toolId);
-    const { toolId: _storedToolId, ...storedFields } = stored ?? { toolId };
-    const decision = this.withBaseline(
-      mergeToolOverride(storedFields, input),
-      reported,
-      !stored || input.requiresApproval !== undefined,
-    );
-    const bound = boundToolOverride(reported, decision);
-    // Only a field this request decides can be refused. A stored value the
-    // code has since outgrown stays stored and is clamped at publication.
-    const violation = bound.violations.find(
-      ({ field }) => input[field] !== undefined && input[field] !== null,
-    );
-    if (violation) {
-      throw new UnprocessableEntityException({
-        code: 'tool_override_out_of_bounds',
-        field: violation.field,
-        reason: violation.reason,
-      });
-    }
-
-    await this.store.upsertToolOverride({
+    const direction = await this.store.decideToolOverride({
       ...scope,
       runId,
       toolId,
-      override: decision,
       updatedBy: actor.userId,
+      decide: (stored) => {
+        const { toolId: _storedToolId, ...storedFields } = stored ?? { toolId };
+        const decision = this.withBaseline(
+          mergeToolOverride(storedFields, input),
+          reported,
+          !stored || input.requiresApproval !== undefined,
+        );
+        const bound = boundToolOverride(reported, decision);
+        // Only a field this request decides can be refused. A stored value the
+        // code has since outgrown stays stored and is clamped at publication.
+        const violation = bound.violations.find(
+          ({ field }) => input[field] !== undefined && input[field] !== null,
+        );
+        if (violation) {
+          throw new UnprocessableEntityException({
+            code: 'tool_override_out_of_bounds',
+            field: violation.field,
+            reason: violation.reason,
+          });
+        }
+        return {
+          override: decision,
+          result: classifyToolPolicyChange(
+            stored ? boundToolOverride(reported, storedFields).entry : undefined,
+            bound.entry,
+          ),
+        };
+      },
     });
     await this.store.appendAudit({
       ...scope,
@@ -426,10 +433,7 @@ export class RuntimeSetupV2Service {
         toolId,
         status: run.status,
         decidedFields: Object.keys(input).sort(),
-        direction: classifyToolPolicyChange(
-          stored ? boundToolOverride(reported, storedFields).entry : undefined,
-          bound.entry,
-        ),
+        direction,
       },
     });
   }
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
@@ -72,6 +72,24 @@ export interface AtomicAppSetupAudit {
   payload: Record<string, unknown>;
 }
 
+/** What one save decides for a tool, plus whatever the caller reports back. */
+export interface ToolOverrideDecision<T> {
+  /** The whole decision to store; a field it leaves out is written as null. */
+  override: ToolOverrideFields;
+  result: T;
+}
+
+export interface DecideToolOverrideInput<T> extends AppSetupScope {
+  runId: string;
+  toolId: string;
+  updatedBy: string;
+  /**
+   * Sees the committed decision (null when there is none) and returns the
+   * next one. Whatever it throws aborts the save; nothing is written then.
+   */
+  decide(stored: StoredToolOverride | null): ToolOverrideDecision<T>;
+}
+
 export interface RuntimeAppSetupStore {
   appExists(scope: AppSetupScope): Promise<boolean>;
   environmentExists(
@@ -168,6 +186,13 @@ export interface RuntimeAppSetupStore {
     scope: AppSetupScope,
     toolId: string,
   ): Promise<StoredToolOverride | null>;
+  /**
+   * Read, decide and write one tool decision in one transaction under the
+   * app-row lock that reorder, promotion and connected apply share. Two saves
+   * of one tool are serialised, so neither merges into a decision the other
+   * has already replaced.
+   */
+  decideToolOverride<T>(input: DecideToolOverrideInput<T>): Promise<T>;
   /** One entry per environment whose runner reported a discovery digest. */
   findEnvironmentReports(
     scope: AppSetupScope,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  65 passed (65)`; `Test Files  17 passed (17)`, `Tests  314 passed (314)`; `Test Files  126 passed (126)`, `Tests  1392 passed | 10 skipped (1402)`; `api-typecheck=0`.

- [ ] **Step 5: Prove the lock is pinned (mutation check, reverted in the same block)**

PGlite runs one transaction at a time by itself, so the two fields would also survive without the app-row lock; on Postgres they would not. The patch deletes the lock from `decideToolOverride`, and the recorded statements of each save no longer start with it.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
M="$(mktemp -d)/mutation.patch"
cat > "$M" <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -659,9 +659,6 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
 
   async decideToolOverride<T>(input: DecideToolOverrideInput<T>): Promise<T> {
     return this.db.transaction(async (tx) => {
-      // The app row is the lock every pipeline operation of the app takes;
-      // a second save of any tool of this app waits here until this commits.
-      await lockEnvironmentPipeline(tx, input);
       const stored = await this.readToolOverride(tx, input, input.toolId);
       const { override, result } = input.decide(stored);
       await this.writeToolOverride(tx, { ...input, override });
PATCH
git apply "$M"
(cd apps/api && ./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts 2>&1 | grep -E "×|Test Files|Tests ")
git apply -R "$M"
git status --short
```

Expected: one `×`, "two saves of one tool at the same time (PGlite) > keeps the field of each save" (both saves still keep their field, but each recorded transaction starts with the read), `Test Files  1 failed (1)`, `Tests  1 failed | 6 passed (7)`; after the revert `git status --short` lists exactly the five files of this task, each ` M`: `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts`, `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts`, `apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts`, `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts`, `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts`.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
git commit -m "fix(runtime-setup): save a tool decision in one locked transaction"
```

---

### Task 6: API – store and sign only what differs from the reported code

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/tool-override.ts` (request schema, `ReportedToolPolicy`, `reportedToolPolicy`, violation reasons, new `decisionDeviations`, `boundToolOverride`), `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts` (`saveToolOverride`), `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts` (`override` may be null), `apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts` (`decideToolOverride` deletes on null)
- Test: `apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts`, `__tests__/runtime-setup-v2.service.spec.ts`, `__tests__/runtime-setup-v2.store.pglite.spec.ts`

**Interfaces:**
- Consumes: Task 5 `decideToolOverride`; the port's `resolveToolPolicy`, `riskTier` (`unknown` is tier 3), `TOOL_RISK_CLASSES`; the SDK golden vectors `__vectors__/tool-policy.v1.json` (byte-identical copy, P08b Task 2).
- Produces:
  - `toolOverrideSchema.riskClass`: `z.enum(TOOL_RISK_CLASSES).nullable().optional()` (`OVERRIDE_RISK_CLASSES` is gone).
  - `ReportedToolPolicy.description?: string`, filled by `reportedToolPolicy(tool)` from a string `tool.description`.
  - `ToolOverrideViolationReason` gains `'risk-class-unassessed'`.
  - `decisionDeviations(reported: ReportedToolPolicy, decision: ToolOverrideFields): ToolOverrideFields | null`: the fields that differ from the reported values plus the decision's baseline fields, or null when none differs.
  - `boundToolOverride` signs a field only when it differs from the reported value (same per-field rule, private `deviates`); violations are unchanged.
  - `ToolOverrideDecision.override: ToolOverrideFields | null` (null removes the decision); `saveToolOverride` stores `decisionDeviations(...)` and refuses `riskClass: 'unknown'` for a tool whose reported class is not `unknown` with 422 `risk-class-unassessed` before the store is called.

Expectation changes in existing tests: "rejects a risk class outside the assessed set" becomes "rejects a risk class outside the shared vocabulary" (`unknown` now parses, see the new "accepts unknown so a resent reported value is not refused"); "removes a decision sent as null and reports the loosening" now expects the decision to be removed instead of a row that keeps only its baseline. The fixture tool of "recording a bounded tool decision" now reports the description `Lists open tasks.`, which none of the existing tests decides. The emitter-versus-validator sweep keeps its guard (`signed > 500`): copies no longer reach a delta, every other decision still does.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
@@ -979,17 +979,25 @@ describe('assembling the reviewed artifact for publication', () => {
 describe('recording a bounded tool decision', () => {
   let store: RuntimeAppSetupStore;
   let service: RuntimeSetupV2Service;
+  /** The scope and tool of every decision `decideToolOverride` removed. */
+  let removed: ReturnType<typeof vi.fn>;
   const storedArtifact = {
     artifactDigest: digest('Y'),
     artifact: {
       ...artifact,
-      tools: [{ ...artifact.tools[0], enabled: true, riskClass: 'write' }],
+      tools: [{
+        ...artifact.tools[0],
+        enabled: true,
+        riskClass: 'write',
+        description: 'Lists open tasks.',
+      }],
     } as unknown as Record<string, unknown>,
     generatedAt: updatedAt,
     createdAt: updatedAt,
   };
 
   beforeEach(() => {
+    removed = vi.fn();
     store = {
       appExists: vi.fn().mockResolvedValue(true),
       findRun: vi.fn().mockResolvedValue(runRecord({ status: 'ready' })),
@@ -1001,6 +1009,14 @@ describe('recording a bounded tool decision', () => {
       decideToolOverride: vi.fn(async (input: DecideToolOverrideInput<unknown>) => {
         const stored = await store.findToolOverride(input, input.toolId);
         const { override, result } = input.decide(stored);
+        if (override === null) {
+          removed({
+            tenantId: input.tenantId,
+            targetAppId: input.targetAppId,
+            toolId: input.toolId,
+          });
+          return result;
+        }
         await store.upsertToolOverride({
           tenantId: input.tenantId,
           targetAppId: input.targetAppId,
@@ -1066,6 +1082,7 @@ describe('recording a bounded tool decision', () => {
     }));
   });
 
+  /** Nothing differs from the code any more: the decision is removed. */
   it('removes a decision sent as null and reports the loosening', async () => {
     store.findToolOverride = vi.fn().mockResolvedValue({
       toolId: TOOL_ID,
@@ -1076,14 +1093,109 @@ describe('recording a bounded tool decision', () => {
 
     await service.saveToolOverride(scope, RUN_ID, TOOL_ID, { enabled: null }, actor);
 
+    expect(removed).toHaveBeenCalledWith({ ...scope, toolId: TOOL_ID });
+    expect(store.upsertToolOverride).not.toHaveBeenCalled();
+    expect(store.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
+      payload: expect.objectContaining({ direction: 'loosening' }),
+    }));
+  });
+
+  /**
+   * Today's form sends every displayed field. Only the field that differs
+   * from what the code reported is a decision; the copies are not stored.
+   */
+  it('stores only what differs from the reported code', async () => {
+    await service.saveToolOverride(scope, RUN_ID, TOOL_ID, {
+      riskClass: 'write',
+      requiresApproval: true,
+      enabled: false,
+      allowedRoles: [],
+      description: 'Lists open tasks.',
+    }, actor);
+
     expect(store.upsertToolOverride).toHaveBeenCalledWith(expect.objectContaining({
-      override: { baselineRiskClass: 'write', baselineRequiresApproval: true },
+      override: {
+        enabled: false,
+        baselineRiskClass: 'write',
+        baselineRequiresApproval: true,
+      },
     }));
+    expect(store.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
+      payload: expect.objectContaining({ direction: 'hardening' }),
+    }));
+  });
+
+  it('removes the decision when a save sets the last field back to the code', async () => {
+    store.findToolOverride = vi.fn().mockResolvedValue({
+      toolId: TOOL_ID,
+      riskClass: 'delete',
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    });
+
+    await service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { riskClass: 'write', description: 'Lists open tasks.' },
+      actor,
+    );
+
+    expect(removed).toHaveBeenCalledWith({ ...scope, toolId: TOOL_ID });
+    expect(store.upsertToolOverride).not.toHaveBeenCalled();
     expect(store.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
       payload: expect.objectContaining({ direction: 'loosening' }),
     }));
   });
 
+  /**
+   * A tool the code could not assess reports `unknown`. Sending it back is
+   * no decision, so the restrictions next to it are saved (tier 3 bounds).
+   */
+  it('saves restrictions for a tool the code reported as unknown', async () => {
+    store.findArtifact = vi.fn().mockResolvedValue({
+      ...storedArtifact,
+      artifact: {
+        ...artifact,
+        tools: [{ ...artifact.tools[0], enabled: true, riskClass: 'unknown' }],
+      },
+    });
+
+    await service.saveToolOverride(scope, RUN_ID, TOOL_ID, {
+      riskClass: 'unknown',
+      enabled: false,
+      requiresApproval: true,
+    }, actor);
+
+    expect(store.upsertToolOverride).toHaveBeenCalledWith(expect.objectContaining({
+      override: {
+        enabled: false,
+        baselineRiskClass: 'unknown',
+        baselineRequiresApproval: true,
+      },
+    }));
+  });
+
+  it('refuses unknown as a choice for a tool the code did assess', async () => {
+    const attempt = service.saveToolOverride(
+      scope,
+      RUN_ID,
+      TOOL_ID,
+      { riskClass: 'unknown' },
+      actor,
+    );
+
+    await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
+    await expect(attempt).rejects.toMatchObject({
+      response: {
+        code: 'tool_override_out_of_bounds',
+        field: 'riskClass',
+        reason: 'risk-class-unassessed',
+      },
+    });
+    expect(store.decideToolOverride).not.toHaveBeenCalled();
+  });
+
   /** Re-pinning silently would revive a lapsed relaxation at a higher tier. */
   it('keeps the stored baseline unless confirmation itself is decided again', async () => {
     store.findToolOverride = vi.fn().mockResolvedValue({
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
@@ -482,4 +482,40 @@ describe('two saves of one tool at the same time (PGlite)', () => {
       [lock, 'select', 'insert'],
     ]);
   });
+
+  /** A save that leaves nothing different from the code removes the row. */
+  it('removes the decision once nothing differs from the reported code', async () => {
+    const app = await seedApp(database.db);
+    const runId = await seedRun(app, {
+      discoveryDigest: digest('D'),
+      createdAt: new Date('2026-10-01T10:00:00Z'),
+      artifactTools: [{
+        toolId: TOOL_ID,
+        riskClass: 'write',
+        requiresApproval: true,
+        enabled: true,
+        description: 'Lists open tasks.',
+      }],
+    });
+    const service = new RuntimeSetupV2Service(
+      store,
+      { publish: async () => undefined } as never,
+    );
+    const editor = { userId: 'editor-1', role: 'editor' };
+
+    await service.saveToolOverride(app, runId, TOOL_ID, {
+      enabled: false,
+      description: 'Lists open tasks.',
+    }, editor);
+    await expect(store.findToolOverride(app, TOOL_ID)).resolves.toEqual({
+      toolId: TOOL_ID,
+      enabled: false,
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    });
+
+    await service.saveToolOverride(app, runId, TOOL_ID, { enabled: true }, editor);
+    await expect(store.findToolOverride(app, TOOL_ID)).resolves.toBeNull();
+    await expect(store.listToolOverrides(app)).resolves.toEqual([]);
+  });
 });
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts
@@ -1,16 +1,26 @@
+import { readFileSync } from 'node:fs';
+import { fileURLToPath } from 'node:url';
 import { describe, expect, it } from 'vitest';
 import { findPolicyBoundViolation } from '../../runtime-revisions/runtime-publication-policy';
 import {
   boundToolOverride,
   boundToolOverrideDeltas,
   classifyToolPolicyChange,
+  decisionDeviations,
   mergeToolOverride,
   parseToolOverride,
   type PolicyChangeDirection,
   type ReportedToolPolicy,
   type ToolOverrideFields,
 } from '../tool-override';
-import { TOOL_RISK_CLASSES, type ToolPolicyEntry } from '../tool-policy';
+import {
+  resolveToolPolicy,
+  TOOL_RISK_CLASSES,
+  type EffectiveToolPolicy,
+  type ResolveToolPolicyInput,
+  type ResolveToolPolicyResult,
+  type ToolPolicyEntry,
+} from '../tool-policy';
 
 const TOOL_ID = '019fb001-0000-7000-8000-000000000006';
 
@@ -51,9 +61,20 @@ describe('parsing a tool override', () => {
     }
   });
 
-  it('rejects a risk class outside the assessed set', () => {
+  it('rejects a risk class outside the shared vocabulary', () => {
     expect(() => parseToolOverride({ riskClass: 'harmless' })).toThrow();
-    expect(() => parseToolOverride({ riskClass: 'unknown' })).toThrow();
+  });
+
+  /**
+   * A form that sends every displayed field back sends the reported
+   * `unknown` too. That is no decision, so it must parse (the save refuses
+   * `unknown` only as a choice for a tool the code did assess).
+   */
+  it('accepts unknown so a resent reported value is not refused', () => {
+    expect(parseToolOverride({ riskClass: 'unknown', enabled: false })).toEqual({
+      riskClass: 'unknown',
+      enabled: false,
+    });
   });
 
   it('rejects a description long enough to carry source', () => {
@@ -228,6 +249,66 @@ describe('bounding a tool override by the reported code', () => {
     expect(bound.changedByPlatform.description).toBe(true);
   });
 
+  /**
+   * Spec 4.10.3: decisions are deltas, never copies of what the code
+   * reported. A copy would freeze the reported value: a later code change
+   * (a new description, a lowered class) would no longer reach the chat.
+   */
+  it.each([
+    ['the reported risk class', { riskClass: 'write' }, {}],
+    ['the reported confirmation', { requiresApproval: true }, {}],
+    ['the reported enabled state', { enabled: true }, {}],
+    ['a disable of a tool the code disabled', { enabled: false }, { enabled: false }],
+    [
+      'the reported roles in another order',
+      { allowedRoles: ['member', 'admin', 'admin'] },
+      { allowedRoles: ['admin', 'member'] },
+    ],
+    ['an empty role list', { allowedRoles: [] }, {}],
+    ['the reported description', { description: 'Lists open tasks.' }, {}],
+  ] as Array<[string, ToolOverrideFields, Partial<ReportedToolPolicy>]>)(
+    'never signs %s',
+    (_name, decision, code) => {
+      const bound = boundToolOverride(
+        reported({ description: 'Lists open tasks.', ...code }),
+        decision,
+      );
+
+      expect(bound.entry).toEqual({});
+      expect(bound.violations).toEqual([]);
+      expect(Object.values(bound.changedByPlatform)).not.toContain(true);
+    },
+  );
+
+  /** A reported `unknown` counts as tier 3; restricting choices stay open. */
+  it('lets an operator restrict a tool the code could not assess', () => {
+    const unassessed = reported({ riskClass: 'unknown', requiresApproval: false });
+
+    const bound = boundToolOverride(unassessed, {
+      riskClass: 'unknown',
+      enabled: false,
+      requiresApproval: true,
+      allowedRoles: ['admin'],
+      description: 'Exports a report.',
+    });
+
+    expect(bound.violations).toEqual([]);
+    // The resent `unknown` is no decision; everything else restricts.
+    expect(bound.entry).toEqual({
+      enabled: false,
+      requiresApproval: true,
+      allowedRoles: ['admin'],
+      description: 'Exports a report.',
+    });
+    expect(bound.effective).toMatchObject({
+      riskClass: 'unknown',
+      requiresApproval: true,
+      enabled: false,
+    });
+    expect(boundToolOverride(unassessed, { riskClass: 'delete' }).violations)
+      .toEqual([{ field: 'riskClass', reason: 'risk-class-relabelled' }]);
+  });
+
   /** A row stored before the bounds existed is clamped, never trusted. */
   it('drops an out-of-bounds legacy decision instead of applying it', () => {
     const bound = boundToolOverride(
@@ -313,6 +394,94 @@ describe('signed deltas stay inside the bounds the revision endpoint enforces',
   });
 });
 
+describe('keeping only what an operator changed', () => {
+  it('drops copies of reported values and keeps the baseline beside a real decision', () => {
+    expect(decisionDeviations(reported({ description: 'Lists open tasks.' }), {
+      riskClass: 'write',
+      requiresApproval: true,
+      enabled: false,
+      allowedRoles: [],
+      description: 'Lists open tasks.',
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    })).toEqual({
+      enabled: false,
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    });
+  });
+
+  it('is null when nothing differs, baseline or not', () => {
+    expect(decisionDeviations(reported(), {
+      riskClass: 'write',
+      requiresApproval: true,
+      baselineRiskClass: 'write',
+      baselineRequiresApproval: true,
+    })).toBeNull();
+    expect(decisionDeviations(reported(), {})).toBeNull();
+  });
+
+  /** Publication clamps it; dropping it here would hide that it was decided. */
+  it('keeps an out-of-bounds value the code has since outgrown', () => {
+    expect(decisionDeviations(reported({ riskClass: 'delete' }), { riskClass: 'write' }))
+      .toEqual({ riskClass: 'write' });
+  });
+});
+
+interface ToolPolicyVector {
+  name: string;
+  input: ResolveToolPolicyInput;
+  expected: ResolveToolPolicyResult;
+}
+
+/**
+ * Parity with the SDK (the golden vectors v1 the port is proved against):
+ * leaving out a value equal to what the code reported never changes what the
+ * runtime enforces. For each valid vector with a Platform layer, the reported
+ * values are the vector resolved without that layer, which is what a runner
+ * reports; the Platform layer is then resolved with and without its copies.
+ */
+describe('dropping unchanged values keeps the SDK resolution', () => {
+  const vectors = JSON.parse(readFileSync(
+    fileURLToPath(new URL('../__vectors__/tool-policy.v1.json', import.meta.url)),
+    'utf8',
+  )) as ToolPolicyVector[];
+  const cases = vectors.filter((vector) => (
+    vector.input.platform !== undefined && vector.expected.errors.length === 0
+  ));
+  const values = ({ origin: _origin, ...rest }: EffectiveToolPolicy) => rest;
+
+  it('covers every valid vector with a Platform layer', () => {
+    expect(cases.length).toBeGreaterThanOrEqual(15);
+  });
+
+  it.each(cases.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
+    const { platform, ...code } = vector.input;
+    const local = resolveToolPolicy(code).effective;
+    const kept = decisionDeviations({
+      toolId: vector.input.toolId,
+      riskClass: local.riskClass,
+      requiresApproval: local.requiresApproval,
+      enabled: local.enabled,
+      allowedRoles: local.allowedRoles,
+      ...(local.description === undefined ? {} : { description: local.description }),
+    }, platform as ToolOverrideFields) ?? {};
+    const withoutCopies: ToolPolicyEntry = {
+      ...(kept.enabled === undefined ? {} : { enabled: kept.enabled }),
+      ...(kept.riskClass === undefined ? {} : { riskClass: kept.riskClass }),
+      ...(kept.requiresApproval === undefined
+        ? {}
+        : { requiresApproval: kept.requiresApproval }),
+      ...(kept.allowedRoles === undefined ? {} : { allowedRoles: kept.allowedRoles }),
+      ...(kept.description === undefined ? {} : { description: kept.description }),
+      ...(platform!.pin ? { pin: platform!.pin } : {}),
+    };
+
+    expect(values(resolveToolPolicy({ ...vector.input, platform: withoutCopies }).effective))
+      .toEqual(values(resolveToolPolicy(vector.input).effective));
+  });
+});
+
 describe('classifying a change between two Platform decisions', () => {
   const changes: Array<[string, ToolPolicyEntry, ToolPolicyEntry, PolicyChangeDirection]> = [
     ['disabling', {}, { enabled: false }, 'hardening'],
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts 2>&1 | grep -E "×|Test Files|Tests "
```

Expected: `Test Files  3 failed (3)`, `Tests  31 failed | 102 passed (133)`. In `tool-override.spec.ts` 25: "accepts unknown so a resent reported value is not refused" (the old schema refuses `unknown`), five "never signs …" cases (the reported risk class, confirmation, a disable of a tool the code disabled, the reported roles in another order and the reported description each come back as a delta), "lets an operator restrict a tool the code could not assess" (the resent `riskClass: 'unknown'` is signed), the three "keeping only what an operator changed" tests and the 15 vector cases (`decisionDeviations is not a function`). In the service spec the five new or changed "recording a bounded tool decision" tests (copies stored, no removal, the resent and the chosen `unknown` both stored). On PGlite "removes the decision once nothing differs from the reported code" (the first save stores the description copy). "never signs the reported enabled state", "never signs an empty role list" and "covers every valid vector with a Platform layer" already pass.

- [ ] **Step 3: Keep only deviations**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts
@@ -664,7 +664,15 @@ export class DrizzleRuntimeSetupV2Store implements RuntimeAppSetupStore {
       await lockEnvironmentPipeline(tx, input);
       const stored = await this.readToolOverride(tx, input, input.toolId);
       const { override, result } = input.decide(stored);
-      await this.writeToolOverride(tx, { ...input, override });
+      if (override === null) {
+        await tx.delete(runtimeAppSetupToolOverrides).where(and(
+          eq(runtimeAppSetupToolOverrides.tenantId, input.tenantId),
+          eq(runtimeAppSetupToolOverrides.targetAppId, input.targetAppId),
+          eq(runtimeAppSetupToolOverrides.toolId, input.toolId),
+        ));
+      } else {
+        await this.writeToolOverride(tx, { ...input, override });
+      }
       return result;
     });
   }
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
@@ -14,6 +14,7 @@ import {
   boundToolOverride,
   boundToolOverrideDeltas,
   classifyToolPolicyChange,
+  decisionDeviations,
   mergeToolOverride,
   reportedToolPolicy,
   type ReportedToolPolicy,
@@ -367,7 +368,9 @@ export class RuntimeSetupV2Service {
    * beside it so both remain visible. A decision outside the bounds the code
    * allows (spec 4.5) is refused with 422 and the reason code; nothing is
    * stored then. The merge with the stored decision runs inside the store's
-   * transaction, so a concurrent save of another field is never lost.
+   * transaction, so a concurrent save of another field is never lost. Only
+   * what differs from the reported code is stored; a save that leaves no
+   * difference removes the decision.
    */
   async saveToolOverride(
     scope: AppSetupScope,
@@ -390,6 +393,15 @@ export class RuntimeSetupV2Service {
     }
 
     const reported = reportedToolPolicy(tool);
+    // `unknown` is what the code says about a tool it could not assess. Sent
+    // back for such a tool it is no decision; chosen for another one it is.
+    if (input.riskClass === 'unknown' && reported.riskClass !== 'unknown') {
+      throw new UnprocessableEntityException({
+        code: 'tool_override_out_of_bounds',
+        field: 'riskClass',
+        reason: 'risk-class-unassessed',
+      });
+    }
     const direction = await this.store.decideToolOverride({
       ...scope,
       runId,
@@ -416,7 +428,7 @@ export class RuntimeSetupV2Service {
           });
         }
         return {
-          override: decision,
+          override: decisionDeviations(reported, decision),
           result: classifyToolPolicyChange(
             stored ? boundToolOverride(reported, storedFields).entry : undefined,
             bound.entry,
diff --git a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts
@@ -74,8 +74,11 @@ export interface AtomicAppSetupAudit {
 
 /** What one save decides for a tool, plus whatever the caller reports back. */
 export interface ToolOverrideDecision<T> {
-  /** The whole decision to store; a field it leaves out is written as null. */
-  override: ToolOverrideFields;
+  /**
+   * The whole decision to store (a field it leaves out is written as null),
+   * or null to remove the tool's decision.
+   */
+  override: ToolOverrideFields | null;
   result: T;
 }
 
diff --git a/apps/api/src/modules/runtime-setup-v2/tool-override.ts b/apps/api/src/modules/runtime-setup-v2/tool-override.ts
--- a/apps/api/src/modules/runtime-setup-v2/tool-override.ts
+++ b/apps/api/src/modules/runtime-setup-v2/tool-override.ts
@@ -10,21 +10,15 @@ import {
   type ToolRiskClass,
 } from './tool-policy';
 
-/** An operator may raise to any assessed class; `unknown` is not a choice. */
-const OVERRIDE_RISK_CLASSES = [
-  'safe-read',
-  'read-sensitive',
-  'write',
-  'delete',
-  'financial',
-  'external',
-] as const;
-
 const role = z.string().trim().min(1).max(200);
 
 /**
  * What an operator may decide about a discovered tool. A field that is absent
- * keeps the stored decision; `null` removes it again.
+ * keeps the stored decision; `null` removes it again; a value equal to what
+ * the code reported is no decision either (`decisionDeviations`). The risk
+ * class takes the whole vocabulary so a form that sends back the reported
+ * `unknown` is not refused; choosing `unknown` for an assessed tool is (422
+ * `risk-class-unassessed`, raised by the save).
  *
  * Identity, source fingerprint, and schema digests are deliberately absent:
  * they come from local discovery and prove which code an entry refers to, so
@@ -33,7 +27,7 @@ const role = z.string().trim().min(1).max(200);
  */
 export const toolOverrideSchema = z.object({
   description: z.string().trim().min(1).max(1_000).nullable().optional(),
-  riskClass: z.enum(OVERRIDE_RISK_CLASSES).nullable().optional(),
+  riskClass: z.enum(TOOL_RISK_CLASSES).nullable().optional(),
   requiresApproval: z.boolean().nullable().optional(),
   enabled: z.boolean().nullable().optional(),
   allowedRoles: z.array(role).max(100).nullable().optional(),
@@ -66,6 +60,8 @@ export interface ReportedToolPolicy {
   requiresApproval: boolean;
   enabled: boolean;
   allowedRoles: string[];
+  /** The model-facing description the code reported, if any. */
+  description?: string;
 }
 
 /** The policy values one uploaded artifact tool entry reports. */
@@ -74,6 +70,7 @@ export function reportedToolPolicy(
 ): ReportedToolPolicy {
   const riskClass = tool.riskClass;
   const roles = tool.allowedRoles;
+  const description = tool.description;
   return {
     toolId: typeof tool.toolId === 'string' ? tool.toolId : '',
     riskClass: typeof riskClass === 'string'
@@ -85,12 +82,14 @@ export function reportedToolPolicy(
     allowedRoles: Array.isArray(roles)
       ? roles.filter((role): role is string => typeof role === 'string')
       : [],
+    ...(typeof description === 'string' ? { description } : {}),
   };
 }
 
 export type ToolOverrideViolationReason =
   | 'risk-class-lowered'
   | 'risk-class-relabelled'
+  | 'risk-class-unassessed'
   | 'cannot-enable-disabled-tool'
   | 'tier-3-always-requires-approval'
   | 'relaxation-requires-reviewed-pin';
@@ -156,13 +155,83 @@ export function mergeToolOverride(
   return merged;
 }
 
+type DecidedField =
+  | 'enabled'
+  | 'riskClass'
+  | 'requiresApproval'
+  | 'allowedRoles'
+  | 'description';
+
+function sameRoleSet(
+  left: ReadonlyArray<string>,
+  right: ReadonlyArray<string>,
+): boolean {
+  const a = [...new Set(left)].sort();
+  const b = [...new Set(right)].sort();
+  return a.length === b.length && a.every((value, index) => value === b[index]);
+}
+
+/**
+ * Per field: does the decision say something the code did not report? A value
+ * equal to the reported one is a copy, never a decision (spec 4.10.3), and an
+ * empty role list narrows nothing.
+ */
+function deviates(
+  reported: ReportedToolPolicy,
+  decision: ToolOverrideFields,
+): Record<DecidedField, boolean> {
+  return {
+    enabled: decision.enabled !== undefined && decision.enabled !== reported.enabled,
+    riskClass: decision.riskClass !== undefined
+      && decision.riskClass !== reported.riskClass,
+    requiresApproval: decision.requiresApproval !== undefined
+      && decision.requiresApproval !== reported.requiresApproval,
+    allowedRoles: decision.allowedRoles !== undefined
+      && decision.allowedRoles.length > 0
+      && !sameRoleSet(decision.allowedRoles, reported.allowedRoles),
+    description: decision.description !== undefined
+      && decision.description !== reported.description,
+  };
+}
+
+/**
+ * The part of a decision worth storing: the fields that differ from what the
+ * code reported, with the baseline beside them. Null when nothing differs,
+ * so a save that ends there removes the decision instead of freezing copies
+ * (a stored copy of the reported description would mask every later code or
+ * Stufe-2 description, Platform > lokal > Code). An out-of-bounds field the
+ * code has since outgrown still differs and stays (clamped at publication).
+ */
+export function decisionDeviations(
+  reported: ReportedToolPolicy,
+  decision: ToolOverrideFields,
+): ToolOverrideFields | null {
+  const differs = deviates(reported, decision);
+  const kept: ToolOverrideFields = {};
+  if (differs.enabled) kept.enabled = decision.enabled;
+  if (differs.riskClass) kept.riskClass = decision.riskClass;
+  if (differs.requiresApproval) kept.requiresApproval = decision.requiresApproval;
+  if (differs.allowedRoles) kept.allowedRoles = decision.allowedRoles;
+  if (differs.description) kept.description = decision.description;
+  if (Object.keys(kept).length === 0) return null;
+  if (decision.baselineRiskClass !== undefined) {
+    kept.baselineRiskClass = decision.baselineRiskClass;
+  }
+  if (decision.baselineRequiresApproval !== undefined) {
+    kept.baselineRequiresApproval = decision.baselineRequiresApproval;
+  }
+  return kept;
+}
+
 /**
  * Bound an operator decision by the code that reported the tool (spec 4.5):
  * the risk class only rises, every layer may disable but none enables,
  * roles only narrow, tier 3 always confirms, and a relaxation of confirmation
  * is pinned to the reported risk class so it lapses when the code raises it.
  * Out-of-bounds decisions are returned as violations and left out of `entry`;
- * the save path answers them with 422, publication simply drops them.
+ * the save path answers them with 422, publication simply drops them. A
+ * field equal to what the code reported is never signed (it is no decision),
+ * so `entry` carries deviations only, also for rows stored before that rule.
  */
 export function boundToolOverride(
   reported: ReportedToolPolicy,
@@ -170,13 +239,14 @@ export function boundToolOverride(
 ): BoundToolOverride {
   const violations: ToolOverrideViolation[] = [];
   const entry: ToolPolicyEntry = {};
+  const differs = deviates(reported, decision);
 
-  if (decision.enabled === false) entry.enabled = false;
+  if (decision.enabled === false && differs.enabled) entry.enabled = false;
   if (decision.enabled === true && !reported.enabled) {
     violations.push({ field: 'enabled', reason: 'cannot-enable-disabled-tool' });
   }
 
-  if (decision.riskClass !== undefined) {
+  if (decision.riskClass !== undefined && differs.riskClass) {
     const raised = riskTier(decision.riskClass) - riskTier(reported.riskClass);
     if (raised < 0) {
       violations.push({ field: 'riskClass', reason: 'risk-class-lowered' });
@@ -187,7 +257,9 @@ export function boundToolOverride(
     }
   }
 
-  if (decision.requiresApproval === true) entry.requiresApproval = true;
+  if (decision.requiresApproval === true && differs.requiresApproval) {
+    entry.requiresApproval = true;
+  }
   if (decision.requiresApproval === false && reported.requiresApproval) {
     const tier = riskTier(
       mostRestrictiveRiskClass(reported.riskClass, entry.riskClass),
@@ -217,9 +289,10 @@ export function boundToolOverride(
     }
   }
 
-  const roles = [...new Set(decision.allowedRoles ?? [])].sort();
-  if (roles.length > 0) entry.allowedRoles = roles;
-  if (decision.description !== undefined) entry.description = decision.description;
+  if (differs.allowedRoles) {
+    entry.allowedRoles = [...new Set(decision.allowedRoles)].sort();
+  }
+  if (differs.description) entry.description = decision.description;
 
   const resolved = resolveToolPolicy({
     toolId: reported.toolId,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  3 passed (3)`, `Tests  133 passed (133)`; `Test Files  17 passed (17)`, `Tests  347 passed (347)`; `Test Files  126 passed (126)`, `Tests  1425 passed | 10 skipped (1435)`; `api-typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/tool-override.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/drizzle-runtime-setup-v2.store.ts apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.store.pglite.spec.ts
git commit -m "fix(runtime-setup): store and sign only what differs from the code"
```

---

### Task 7: API – keep the signed decisions in a prompt-only revision

**Files:**
- Modify: `apps/api/src/modules/runtime-revisions/app-configuration.service.ts:205-260`
- Test: `apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts`

**Interfaces:**
- Consumes: `createConfiguration` ("absent when empty"), `sortedToolOverrides`, `ToolOverrideDelta`.
- Produces: `createPromptOnlyRevision`'s `baseConfiguration` gains the required `toolOverrides: ToolOverrideDelta[]`, signed (sorted by `toolId`) on the new configuration. Required so that a future caller cannot drop them by omission; `PublishedConfigurationRecord.toolOverrides` has exactly this type.

This is the P08b ledger minor T4: "createPromptOnlyRevision does not carry the base configuration's toolOverrides, so a future producer would drop signed decisions (latent: no production caller)". The two existing prompt-only tests pass `toolOverrides: []`; the first now also pins that a base without decisions keeps a payload without the key.

- [ ] **Step 1: Write the failing test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts b/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
--- a/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
@@ -373,6 +373,7 @@ describe('RuntimeAppConfigurationService', () => {
           toolRevisionId: tool.revisionId,
           tombstone: tool.tombstone,
         })),
+        toolOverrides: [],
       },
       parentPromptRevisionId: base.promptRevisionId,
       parentConfigurationRevisionId: base.configurationRevisionId,
@@ -397,6 +398,51 @@ describe('RuntimeAppConfigurationService', () => {
         parentRevisionId: base.configurationRevisionId,
       }),
     );
+    expect(payloadOf(draftsOfType('config')[0])).not.toHaveProperty('toolOverrides');
+  });
+
+  /**
+   * A prompt-only revision changes the prompt and nothing else: the decisions
+   * its base signs stay signed. Before P08d it dropped them (latent: no
+   * production caller yet), and a deploy of it would have stopped enforcing
+   * every saved disable and confirmation.
+   */
+  it('keeps the signed decisions of the base when only the prompt changes', async () => {
+    const decisions = [
+      { toolId: TOOL_A, enabled: false, description: 'Lists tasks.' },
+      { toolId: TOOL_B, requiresApproval: true },
+    ];
+    const base = await service.createFromReviewedSetup({
+      ...scope,
+      agentId: AGENT_ID,
+      artifact: { ...reviewedArtifact, toolOverrides: decisions },
+    }, actor);
+    created = [];
+
+    await service.createPromptOnlyRevision({
+      ...scope,
+      prompts: { ...reviewedArtifact.prompts, bundleDigest: digest('C') },
+      baseConfiguration: {
+        setupArtifactDigest: base.setupArtifactDigest,
+        runtimeDigest: base.runtimeDigest,
+        plannerRevisionId: base.plannerRevisionId,
+        tools: base.toolRevisions.map((tool) => ({
+          toolId: tool.toolId,
+          toolRevisionId: tool.revisionId,
+          tombstone: tool.tombstone,
+        })),
+        // Read back in any order; signed sorted by toolId like every delta.
+        toolOverrides: [...decisions].reverse(),
+      },
+      parentPromptRevisionId: base.promptRevisionId,
+      parentConfigurationRevisionId: base.configurationRevisionId,
+    }, actor);
+
+    expect(payloadOf(draftsOfType('config')[0])).toEqual(expect.objectContaining({
+      promptDigest: digest('C'),
+      toolOverrides: decisions,
+      parentRevisionId: base.configurationRevisionId,
+    }));
   });
 
   it('fails closed when a prompt-only change would alter the runtime digest', async () => {
@@ -421,6 +467,7 @@ describe('RuntimeAppConfigurationService', () => {
           toolRevisionId: tool.revisionId,
           tombstone: tool.tombstone,
         })),
+        toolOverrides: [],
       },
     }, actor)).rejects.toThrow(ConflictException);
     expect(store.createDraftSet).not.toHaveBeenCalled();
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts 2>&1 | grep -E "×|Test Files|Tests "
```

Expected: one `×`, "RuntimeAppConfigurationService > keeps the signed decisions of the base when only the prompt changes" (the new configuration has no `toolOverrides`), `Test Files  1 failed (1)`, `Tests  1 failed | 17 passed (18)`. Vitest does not type-check; until Step 3 the typecheck would also reject the new `toolOverrides` key.

- [ ] **Step 3: Sign the base's decisions again**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-revisions/app-configuration.service.ts b/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
--- a/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
+++ b/apps/api/src/modules/runtime-revisions/app-configuration.service.ts
@@ -206,7 +206,8 @@ export class RuntimeAppConfigurationService {
   /**
    * Prompt bundles are hot-swappable independently of the runtime bundle. A
    * prompt-only revision therefore keeps every runtime binding byte-identical
-   * and fails closed if the recomputed runtime digest would change.
+   * and fails closed if the recomputed runtime digest would change. It keeps
+   * the base's signed decisions as well: a prompt change never drops one.
    */
   async createPromptOnlyRevision(
     input: {
@@ -218,6 +219,8 @@ export class RuntimeAppConfigurationService {
         runtimeDigest: string;
         plannerRevisionId: string;
         tools: AppConfigurationToolBinding[];
+        /** The base's signed decisions; required so none is dropped silently. */
+        toolOverrides: ToolOverrideDelta[];
       };
       parentPromptRevisionId?: string;
       parentConfigurationRevisionId?: string;
@@ -253,6 +256,7 @@ export class RuntimeAppConfigurationService {
       promptRevisionId: prompt.id,
       plannerRevisionId: base.plannerRevisionId,
       tools: base.tools,
+      toolOverrides: sortedToolOverrides(base.toolOverrides),
       parentRevisionId: input.parentConfigurationRevisionId,
     }, actor);
 
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  18 passed (18)`; `Test Files  126 passed (126)`, `Tests  1426 passed | 10 skipped (1436)`; `api-typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-revisions/app-configuration.service.ts apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
git commit -m "fix(runtime-revisions): keep signed decisions in prompt-only revisions"
```

---

### Task 8: API – roll the current tool decisions out with every deploy

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts` (new `carry`, `signing` extracted from `resolve`), `apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts` (`execute`, `applyConfigurationTo`, new `withCurrentDecisions`)
- Create: `apps/api/src/modules/runtime-setup-v2/__tests__/decision-carry.spec.ts`
- Test: the new spec, `__tests__/publish-and-deploy.service.spec.ts`, `__tests__/tool-policy-revision.service.spec.ts`

**Interfaces:**
- Consumes: `DesiredStateDerivationStore.findPublishedConfiguration`/`findLatestPublishedConfiguration`/`findPublishedSetupArtifactTools`, `boundToolOverrideDeltas`, `policyOnlyRevisionId`, `RuntimeAppConfigurationService.createPolicyOnlyRevision`, `RuntimeRevisionService.findStatus`/`publishBatchResumable`, `configurationPublicationId`, `EnvironmentPipelineService.promote` (delegates to `run()`).
- Produces:
  - `ToolPolicyRevisionService.carry(scope, configurationRevisionId, actor): Promise<PolicyRevisionDraft>`: `{ configurationRevisionId, created: false }` when the configuration signs exactly the bounded current decisions (or is not published: the derivation refuses it); else, when the newest published configuration has the same `runtimeDigest` and `promptDigest`, the revision `target` names (the newest itself, `created: false`, or its policy-only revision, drafted, `created: true`); else `ConflictException({ code: 'configuration_predates_tool_decisions', message })`.
  - `PublishAndDeployService` (private) `withCurrentDecisions(appScope, configurationRevisionId, reason, actor): Promise<string>`: `carry`, then publishes the carried revision when it is still a draft (`compositeId: configurationPublicationId(id)`, `selfApproveCritical: true`).
  - `run()` (non-connected): a new run composite deploys `withCurrentDecisions(publication.configurationRevisionId)` under the unchanged identity `publishAndDeployId(run, environment)`; an existing composite is settled as before. `runConnected` is unchanged.
  - `applyConfiguration` and the connected configuration apply: a published configuration deploys `withCurrentDecisions(...)` under `configurationApplyId(<deployed>, environment)`; the settle audit names the deployed configuration. A draft keeps the P08b path (`assertSignsCurrentDecisions`, publish, deploy).

Ruling (see "Decisions taken in this plan"): carry for the newest code, 409 for older code. The existing test "resumes an already published configuration even when decisions moved on" encoded the drop this task removes (P08b ledger minors T8 "the published branch still deploys any published configuration of the app … to an older published (possibly looser) decision set" and T11 "explicit routes … still deploy a replaced run's own configuration and can drop saved decisions"); it is replaced by "rolls an already published configuration out with the current decisions". The fixture's `policyRevisions` mock gains `carry` returning the requested configuration, so every other existing test keeps its expectations.

- [ ] **Step 1: Write the failing tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-setup-v2/__tests__/decision-carry.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentPipelineService } from '../../apps/environment-pipeline.service';
import { policyOnlyRevisionId } from '../../runtime-revisions/app-configuration.service';
import {
  configurationApplyId,
  configurationPublicationId,
  publishAndDeployId,
} from '../publish-and-deploy-id';
import { PublishAndDeployService } from '../publish-and-deploy.service';
import { ToolPolicyRevisionService } from '../tool-policy-revision.service';

const scope = {
  tenantId: '019fb820-0000-7000-8000-000000000001',
  targetAppId: '019fb820-0000-7000-8000-000000000002',
};
const DEV = '019fb820-0000-7000-8000-0000000000d1';
const STAGING = '019fb820-0000-7000-8000-0000000000d2';
const RUN_ID = '019fb820-0000-7000-8000-000000000004';
const RUN_CONFIGURATION = '019fb820-0000-7000-8000-0000000000c1';
const OLDER_CONFIGURATION = '019fb820-0000-7000-8000-0000000000c0';
const DECISION_REVISION = '019fb820-0000-7000-8000-0000000000c2';
const NEWER_CONFIGURATION = '019fb820-0000-7000-8000-0000000000c3';
const TOOL = '019fb820-0000-7000-8000-0000000000a1';
const owner = { userId: 'owner-1', role: 'owner' };

type Delta = { toolId: string } & Record<string, unknown>;

/** A published configuration; `code` names its runtime bindings. */
const configuration = (id: string, code: string, toolOverrides: Delta[] = []) => ({
  id,
  promptRevisionId: 'prompt-1',
  plannerRevisionId: `planner-${code}`,
  runtimeDigest: `sha256:runtime-${code}`,
  promptDigest: 'sha256:prompt',
  setupArtifactDigest: `sha256:discovery-${code}`,
  tools: [{ toolId: TOOL, toolRevisionId: `tool-${code}`, tombstone: false }],
  toolOverrides,
  signed: true,
});

/**
 * The real decision path end to end: `ToolPolicyRevisionService` reads the
 * saved decisions and the published configurations (the last one listed is
 * the newest), `PublishAndDeployService` publishes and deploys, and the
 * Managed promotion goes through `EnvironmentPipelineService`. Only the
 * stores and the revision, derivation and deployment services are fakes.
 */
function harness(input: {
  decisions: unknown[];
  configurations: ReturnType<typeof configuration>[];
}) {
  const published = new Map(input.configurations.map((entry) => [entry.id, entry]));
  const policyRevisions = new ToolPolicyRevisionService(
    { listToolOverrides: vi.fn(async () => input.decisions) } as never,
    {
      findLatestPublishedConfiguration: vi.fn(async () => input.configurations.at(-1) ?? null),
      findPublishedConfiguration: vi.fn(async (_scope, id: string) => published.get(id) ?? null),
      // Every code version reports the tool as a write that asks first.
      findPublishedSetupArtifactTools: vi.fn(async () => [{
        toolId: TOOL,
        riskClass: 'write',
        requiresApproval: true,
        enabled: true,
      }]),
    } as never,
    {
      createPolicyOnlyRevision: vi.fn(async (draft: {
        baseConfiguration: { id: string };
        toolOverrides: Delta[];
      }) => ({
        configurationRevisionId: policyOnlyRevisionId(
          draft.baseConfiguration.id,
          draft.toolOverrides,
        ),
      })),
    } as never,
  );
  const setup = {
    assertEnvironment: vi.fn(),
    getRun: vi.fn(async () => ({ status: 'published' })),
    getPublicationState: vi.fn(async () => ({
      schemaVersion: 1,
      configurationRevisionId: RUN_CONFIGURATION,
      revisionScopes: [{ type: 'config', revisionId: RUN_CONFIGURATION }],
    })),
    appendCompositeAudit: vi.fn(),
  };
  const revisions = {
    // Published configurations are known; a drafted decision revision is not.
    findStatus: vi.fn(async ({ revisionId }: { revisionId: string }) => (
      published.has(revisionId) ? 'published' : 'draft'
    )),
    publishBatchResumable: vi.fn(async () => []),
  };
  const derivation = {
    deployPublishedConfiguration: vi.fn(async (
      _scope: unknown,
      _configurationRevisionId: string,
      rollout: { deploymentId: string },
    ) => ({
      deployment: { id: rollout.deploymentId, status: 'pending', healthStatus: 'unknown' },
    })),
  };
  const deployments = { list: vi.fn(async () => []), activate: vi.fn() };
  const service = new PublishAndDeployService(
    setup as never,
    {} as never,
    revisions as never,
    derivation as never,
    deployments as never,
    policyRevisions,
    { pendingConfiguration: vi.fn(async () => null) } as never,
  );
  const pipeline = new EnvironmentPipelineService(
    {
      claimPromotion: vi.fn(async () => ({
        sourceEnvironmentId: DEV,
        sourceDeploymentId: publishAndDeployId(RUN_ID, DEV),
      })),
    } as never,
    service,
  );
  return { service, pipeline, revisions, derivation };
}

const disable = {
  toolId: TOOL,
  enabled: false,
  baselineRiskClass: 'write',
  baselineRequiresApproval: true,
};

describe('saved decisions travel with every deploy', () => {
  it('promotes a run with the decisions saved after it was published', async () => {
    const f = harness({
      decisions: [disable],
      configurations: [configuration(RUN_CONFIGURATION, 'run')],
    });
    const carried = policyOnlyRevisionId(RUN_CONFIGURATION, [
      { toolId: TOOL, enabled: false },
    ]);

    const result = await f.pipeline.promote(scope, RUN_ID, STAGING, owner);

    expect(f.revisions.publishBatchResumable).toHaveBeenCalledWith(
      [{ ...scope, type: 'config', revisionId: carried }],
      owner,
      expect.objectContaining({
        compositeId: configurationPublicationId(carried),
        selfApproveCritical: true,
      }),
    );
    expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
      { ...scope, environmentId: STAGING },
      carried,
      expect.objectContaining({ deploymentId: publishAndDeployId(RUN_ID, STAGING) }),
      expect.anything(),
    );
    // The run identity stays, so the next promotion still finds its source.
    expect(result.deploymentId).toBe(publishAndDeployId(RUN_ID, STAGING));
  });

  /**
   * The decisions were applied in the first environment already: the
   * promotion rolls out that same published revision, nothing new.
   */
  it('promotes with the published decision revision over the same code', async () => {
    const f = harness({
      decisions: [disable],
      configurations: [
        configuration(RUN_CONFIGURATION, 'run'),
        configuration(DECISION_REVISION, 'run', [{ toolId: TOOL, enabled: false }]),
      ],
    });

    await f.pipeline.promote(scope, RUN_ID, STAGING, owner);

    expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
    expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
      { ...scope, environmentId: STAGING },
      DECISION_REVISION,
      expect.objectContaining({ deploymentId: publishAndDeployId(RUN_ID, STAGING) }),
      expect.anything(),
    );
  });

  it('promotes the run configuration itself when it signs the decisions', async () => {
    const f = harness({
      decisions: [disable],
      configurations: [
        configuration(RUN_CONFIGURATION, 'run', [{ toolId: TOOL, enabled: false }]),
      ],
    });

    await f.pipeline.promote(scope, RUN_ID, STAGING, owner);

    expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
    expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
      { ...scope, environmentId: STAGING },
      RUN_CONFIGURATION,
      expect.anything(),
      expect.anything(),
    );
  });

  /** Current means current: a decision taken back is not revived either. */
  it('promotes without a decision that was taken back after the run published', async () => {
    const f = harness({
      decisions: [],
      configurations: [
        configuration(RUN_CONFIGURATION, 'run', [{ toolId: TOOL, enabled: false }]),
      ],
    });

    await f.pipeline.promote(scope, RUN_ID, STAGING, owner);

    expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
      { ...scope, environmentId: STAGING },
      policyOnlyRevisionId(RUN_CONFIGURATION, []),
      expect.anything(),
      expect.anything(),
    );
  });

  /**
   * Newer code was published since the run, and the decisions changed after
   * the run's publication. Drafting them over the run's older code would make
   * that code the newest configuration that every later save builds on.
   */
  it('refuses to promote older code that does not sign the decisions', async () => {
    const f = harness({
      decisions: [disable],
      configurations: [
        configuration(RUN_CONFIGURATION, 'run'),
        configuration(NEWER_CONFIGURATION, 'newer', [{ toolId: TOOL, enabled: false }]),
      ],
    });

    await expect(f.pipeline.promote(scope, RUN_ID, STAGING, owner)).rejects.toMatchObject({
      status: 409,
      response: { code: 'configuration_predates_tool_decisions' },
    });
    expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
    expect(f.derivation.deployPublishedConfiguration).not.toHaveBeenCalled();
  });

  it('applies a configuration whose decisions moved on with the current ones', async () => {
    const f = harness({
      decisions: [disable],
      configurations: [
        configuration(RUN_CONFIGURATION, 'run'),
        configuration(DECISION_REVISION, 'run', [{ toolId: TOOL, allowedRoles: ['admin'] }]),
      ],
    });
    const carried = policyOnlyRevisionId(DECISION_REVISION, [
      { toolId: TOOL, enabled: false },
    ]);

    const result = await f.service.applyConfiguration(scope, RUN_CONFIGURATION, {
      environmentId: DEV,
      reason: 'Platform decision apply',
    }, owner);

    expect(f.revisions.publishBatchResumable).toHaveBeenCalledWith(
      [{ ...scope, type: 'config', revisionId: carried }],
      owner,
      expect.objectContaining({ compositeId: configurationPublicationId(carried) }),
    );
    expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
      { ...scope, environmentId: DEV },
      carried,
      expect.objectContaining({ deploymentId: configurationApplyId(carried, DEV) }),
      expect.anything(),
    );
    expect(result.compositeId).toBe(configurationApplyId(carried, DEV));
  });

  it('refuses to apply older code that does not sign the decisions', async () => {
    const f = harness({
      decisions: [disable],
      configurations: [
        configuration(OLDER_CONFIGURATION, 'older'),
        configuration(RUN_CONFIGURATION, 'run', [{ toolId: TOOL, enabled: false }]),
      ],
    });

    await expect(f.service.applyConfiguration(scope, OLDER_CONFIGURATION, {
      environmentId: DEV,
      reason: 'Platform decision apply',
    }, owner)).rejects.toMatchObject({
      response: { code: 'configuration_predates_tool_decisions' },
    });
    expect(f.derivation.deployPublishedConfiguration).not.toHaveBeenCalled();
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
@@ -103,6 +103,11 @@ function fixture(overrides: { status?: string; deployments?: unknown[] } = {}) {
       kind: 'policy-only',
       configurationRevisionId: configurationId,
     }),
+    // By default every configuration already signs the current decisions.
+    carry: vi.fn().mockImplementation(async (_scope, configurationRevisionId) => ({
+      configurationRevisionId,
+      created: false,
+    })),
   };
   const deployments = {
     list: vi.fn().mockResolvedValue(overrides.deployments ?? []),
@@ -495,6 +500,86 @@ describe('PublishAndDeployService', () => {
     });
   });
 
+  /**
+   * Decisions are app-wide (spec 4.5): the explicit run route and the
+   * Managed promotion roll a run's configuration out with the decisions
+   * saved since it was published, never without them.
+   */
+  describe('deploying a run with the current decisions', () => {
+    const carried = '019fb200-0000-7000-8000-0000000000c5';
+
+    it('carries decisions saved after the run published', async () => {
+      const f = fixture({ status: 'published' });
+      f.policyRevisions.carry.mockResolvedValue({
+        configurationRevisionId: carried,
+        created: true,
+      });
+
+      const result = await f.service.run(scope, runId, {
+        environmentId,
+        reason: 'Managed environment promotion',
+      }, actor);
+
+      expect(f.policyRevisions.carry).toHaveBeenCalledWith(scope, 'config-1', actor);
+      expect(f.revisions.publishBatchResumable).toHaveBeenCalledWith(
+        [{ ...scope, type: 'config', revisionId: carried }],
+        actor,
+        {
+          reason: 'Managed environment promotion',
+          compositeId: configurationPublicationId(carried),
+          selfApproveCritical: true,
+        },
+      );
+      expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        carried,
+        expect.objectContaining({ deploymentId: compositeDeploymentId() }),
+        expect.anything(),
+      );
+      expect(result.compositeId).toBe(compositeDeploymentId());
+    });
+
+    it('finishes a deployment that exists as it was created', async () => {
+      const f = fixture({
+        status: 'published',
+        deployments: [{
+          id: compositeDeploymentId(),
+          status: 'pending',
+          healthStatus: 'healthy',
+        }],
+      });
+
+      await f.service.run(scope, runId, {
+        environmentId,
+        reason: 'Resume after runner health report',
+      }, actor);
+
+      expect(f.policyRevisions.carry).not.toHaveBeenCalled();
+      expect(f.deployments.activate).toHaveBeenCalledOnce();
+    });
+
+    it('leaves the connected path to its own guards', async () => {
+      const f = fixture({ status: 'published' });
+      f.policyRevisions.target.mockResolvedValue({
+        kind: 'published',
+        configurationRevisionId: 'config-1',
+      });
+
+      await f.service.runConnected(scope, runId, {
+        environmentId,
+        reason: 'Connected update apply',
+      }, actor);
+
+      expect(f.policyRevisions.carry).not.toHaveBeenCalled();
+      expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        'config-1',
+        expect.anything(),
+        expect.anything(),
+      );
+    });
+  });
+
   /**
    * A resume deploys the configuration the run published. Its signed
    * decisions predate a revision that replaced it, so resuming would silently
@@ -765,16 +850,20 @@ describe('PublishAndDeployService', () => {
     });
 
     /**
-     * Retrying a request whose deployment is still pending must keep working
-     * after the operator saved another decision: the published revision
-     * already passed the gate and is no longer the target.
+     * Applying a published configuration whose decisions moved on (a retry
+     * after another save, or an earlier decision revision) must not roll out
+     * the older decision set: it rolls out the revision that signs the
+     * current decisions, published through the same gate when still a draft.
      */
-    it('resumes an already published configuration even when decisions moved on', async () => {
+    it('rolls an already published configuration out with the current decisions', async () => {
+      const carried = '019fb200-0000-7000-8000-0000000000c4';
       const f = fixture();
-      f.revisions.findStatus.mockResolvedValue('published');
-      f.policyRevisions.target.mockResolvedValue({
-        kind: 'policy-only',
-        configurationRevisionId: '019fb200-0000-7000-8000-0000000000c3',
+      f.revisions.findStatus.mockImplementation(async ({ revisionId }) => (
+        revisionId === carried ? 'draft' : 'published'
+      ));
+      f.policyRevisions.carry.mockResolvedValue({
+        configurationRevisionId: carried,
+        created: true,
       });
 
       const result = await f.service.applyConfiguration(scope, configurationId, {
@@ -782,9 +871,87 @@ describe('PublishAndDeployService', () => {
         reason: 'Platform decision apply',
       }, actor);
 
-      expect(result.step).toBe('awaiting_health');
       expect(f.policyRevisions.target).not.toHaveBeenCalled();
+      expect(f.policyRevisions.carry).toHaveBeenCalledWith(scope, configurationId, actor);
+      expect(f.revisions.publishBatchResumable).toHaveBeenCalledWith(
+        [{ ...scope, type: 'config', revisionId: carried }],
+        actor,
+        {
+          reason: 'Platform decision apply',
+          compositeId: configurationPublicationId(carried),
+          selfApproveCritical: true,
+        },
+      );
+      expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        carried,
+        expect.objectContaining({
+          deploymentId: configurationApplyId(carried, environmentId),
+        }),
+        expect.anything(),
+      );
+      expect(result).toMatchObject({
+        compositeId: configurationApplyId(carried, environmentId),
+        step: 'awaiting_health',
+      });
+    });
+
+    it('rolls out an already published carried revision without publishing it again', async () => {
+      const carried = '019fb200-0000-7000-8000-0000000000c4';
+      const f = fixture();
+      f.revisions.findStatus.mockResolvedValue('published');
+      f.policyRevisions.carry.mockResolvedValue({
+        configurationRevisionId: carried,
+        created: false,
+      });
+
+      await f.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor);
+
+      expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
+      expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        carried,
+        expect.anything(),
+        expect.anything(),
+      );
+    });
+
+    it('refuses older code that does not sign the decisions before it deploys', async () => {
+      const f = fixture();
+      f.revisions.findStatus.mockResolvedValue('published');
+      f.policyRevisions.carry.mockRejectedValue(new ConflictException({
+        code: 'configuration_predates_tool_decisions',
+      }));
+
+      await expect(f.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor)).rejects.toBeInstanceOf(ConflictException);
+      expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
+      expect(f.derivation.deployPublishedConfiguration).not.toHaveBeenCalled();
+    });
+
+    it('rolls a published configuration out unchanged when it signs the decisions', async () => {
+      const f = fixture();
+      f.revisions.findStatus.mockResolvedValue('published');
+
+      await f.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor);
+
       expect(f.revisions.publishBatchResumable).not.toHaveBeenCalled();
+      expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        configurationId,
+        expect.objectContaining({
+          deploymentId: configurationApplyId(configurationId, environmentId),
+        }),
+        expect.anything(),
+      );
     });
 
     it('refuses a revision that is neither a draft nor published', async () => {
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts
@@ -37,6 +37,7 @@ function fixture(overrides: unknown[], configuration: typeof base | null = base)
   const setup = { listToolOverrides: vi.fn().mockResolvedValue(overrides) };
   const published = {
     findLatestPublishedConfiguration: vi.fn().mockResolvedValue(configuration),
+    findPublishedConfiguration: vi.fn().mockResolvedValue(configuration),
     findPublishedSetupArtifactTools: vi.fn().mockResolvedValue(artifactTools),
   };
   const configurations = {
@@ -46,6 +47,7 @@ function fixture(overrides: unknown[], configuration: typeof base | null = base)
   };
   return {
     configurations,
+    published,
     service: new ToolPolicyRevisionService(
       setup as never,
       published as never,
@@ -162,3 +164,90 @@ describe('configurationReplacingRun', () => {
     expect(configurationReplacingRun(target, runConfiguration)).toBeNull();
   });
 });
+
+/**
+ * A deploy of a published configuration rolls it out with the app's current
+ * decisions: the explicit run route, the Managed promotion and the apply of a
+ * published configuration all ask `carry` which revision to deploy.
+ */
+describe('carrying the current decisions onto a deploy', () => {
+  it('keeps a configuration that already signs exactly the current decisions', async () => {
+    const f = fixture([{ toolId: TOOL_A, enabled: false }], {
+      ...base,
+      toolOverrides: [{ toolId: TOOL_A, enabled: false }],
+    });
+
+    await expect(f.service.carry(scope, 'config-1', actor)).resolves.toEqual({
+      configurationRevisionId: 'config-1',
+      created: false,
+    });
+    expect(f.published.findPublishedConfiguration).toHaveBeenCalledWith(scope, 'config-1');
+    expect(f.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
+  });
+
+  it('drafts the revision that signs them over the newest code', async () => {
+    const f = fixture([
+      { toolId: TOOL_A, enabled: false },
+      // TOOL_B reports safe-read already: a copy, nothing to sign.
+      { toolId: TOOL_B, riskClass: 'safe-read' },
+    ]);
+
+    await expect(f.service.carry(scope, 'config-1', actor)).resolves.toEqual({
+      configurationRevisionId: 'config-2',
+      created: true,
+    });
+    expect(f.configurations.createPolicyOnlyRevision).toHaveBeenCalledWith({
+      ...scope,
+      baseConfiguration: base,
+      toolOverrides: [{ toolId: TOOL_A, enabled: false }],
+    }, actor);
+  });
+
+  it('names the newest configuration when it already signs them', async () => {
+    const f = fixture([{ toolId: TOOL_A, enabled: false }], {
+      ...base,
+      id: 'config-3',
+      toolOverrides: [{ toolId: TOOL_A, enabled: false }],
+    });
+    f.published.findPublishedConfiguration.mockResolvedValue(base);
+
+    await expect(f.service.carry(scope, 'config-1', actor)).resolves.toEqual({
+      configurationRevisionId: 'config-3',
+      created: false,
+    });
+    expect(f.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
+  });
+
+  /**
+   * A revision drafted over older code would become the newest published
+   * configuration; every later save and the connected apply would build on
+   * that older code.
+   */
+  it.each([
+    ['older code', { runtimeDigest: 'sha256:older-runtime' }],
+    ['another prompt', { promptDigest: 'sha256:older-prompt' }],
+  ])('refuses %s that does not sign the decisions', async (_name, older) => {
+    const f = fixture([{ toolId: TOOL_A, enabled: false }]);
+    f.published.findPublishedConfiguration.mockResolvedValue({
+      ...base,
+      id: 'config-0',
+      ...older,
+    });
+
+    await expect(f.service.carry(scope, 'config-0', actor)).rejects.toMatchObject({
+      response: { code: 'configuration_predates_tool_decisions' },
+    });
+    expect(f.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
+  });
+
+  it('leaves a configuration that is not published to the derivation', async () => {
+    const f = fixture([{ toolId: TOOL_A, enabled: false }]);
+    f.published.findPublishedConfiguration.mockResolvedValue(null);
+
+    await expect(f.service.carry(scope, 'config-9', actor)).resolves.toEqual({
+      configurationRevisionId: 'config-9',
+      created: false,
+    });
+    expect(f.configurations.createPolicyOnlyRevision).not.toHaveBeenCalled();
+  });
+});
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/decision-carry.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts 2>&1 | grep -E "×|Test Files|Tests "
```

Expected: `Test Files  3 failed (3)`, `Tests  16 failed | 44 passed (60)`: the six `carry` tests of `tool-policy-revision.service.spec.ts` (`carry` does not exist), four in `publish-and-deploy.service.spec.ts` ("carries decisions saved after the run published", "rolls an already published configuration out with the current decisions", "rolls out an already published carried revision without publishing it again", "refuses older code that does not sign the decisions before it deploys": the old service deploys the named configuration and never asks `carry`) and six of the seven in `decision-carry.spec.ts` (the run's or the named configuration is deployed as it is, nothing refuses older code). "promotes the run configuration itself when it signs the decisions", "finishes a deployment that exists as it was created", "leaves the connected path to its own guards" and "rolls a published configuration out unchanged when it signs the decisions" already pass.

- [ ] **Step 3: Carry the decisions**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
@@ -178,10 +178,22 @@ export class PublishAndDeployService {
         'Published setup run has no pinned publication state',
       );
     }
+    // A deployment that exists is finished as it was created. A new one of
+    // the explicit routes (this run, the Managed promotion) carries the app's
+    // current decisions; the connected path never gets here with a
+    // configuration that does not sign them (`runConnected` rolls a pending
+    // decision revision out first, `assertNotReplaced` refuses the rest).
     const deployed = existing ?? (await this.derivation
       .deployPublishedConfiguration(
         scope,
-        publication!.configurationRevisionId,
+        connected
+          ? publication!.configurationRevisionId
+          : await this.withCurrentDecisions(
+            appScope,
+            publication!.configurationRevisionId,
+            input.reason,
+            actor,
+          ),
         {
           deploymentId: compositeId,
           rolloutMode: 'stable',
@@ -285,14 +297,25 @@ export class PublishAndDeployService {
       throw new ConflictException('The app configuration can no longer be applied');
     }
 
+    // A published configuration can predate the current decisions: it rolls
+    // out as the revision that signs them over the newest code (`carry`;
+    // older code that does not sign them answers 409).
+    const deployable = status === 'draft'
+      ? configurationRevisionId
+      : await this.withCurrentDecisions(
+        appScope,
+        configurationRevisionId,
+        input.reason,
+        actor,
+      );
     const compositeId = configurationApplyId(
-      configurationRevisionId,
+      deployable,
       input.environmentId,
     );
     const deployed = await this.compositeDeployment(scope, compositeId)
       ?? (await this.derivation.deployPublishedConfiguration(
         scope,
-        configurationRevisionId,
+        deployable,
         {
           deploymentId: compositeId,
           rolloutMode: 'stable',
@@ -302,10 +325,47 @@ export class PublishAndDeployService {
         this.compositeActor(actor),
       )).deployment;
     return this.settle(scope, actor, compositeId, deployed, {
-      configurationRevisionId,
+      configurationRevisionId: deployable,
     });
   }
 
+  /**
+   * The configuration to roll out for `configurationRevisionId`: itself when
+   * it signs the app's current tool decisions, else the revision over the
+   * newest code that does (`ToolPolicyRevisionService.carry`, 409 for older
+   * code). A draft is published here through the direction-aware security
+   * gate with the same self-approval as every decision apply (a loosening is
+   * recorded as approved by the owner or admin who applies it, spec 4.10.5).
+   */
+  private async withCurrentDecisions(
+    appScope: { tenantId: string; targetAppId: string },
+    configurationRevisionId: string,
+    reason: string,
+    actor: RuntimeActor,
+  ): Promise<string> {
+    const carried = await this.policyRevisions.carry(
+      appScope,
+      configurationRevisionId,
+      actor,
+    );
+    if (carried.configurationRevisionId === configurationRevisionId) {
+      return configurationRevisionId;
+    }
+    const revision = {
+      ...appScope,
+      type: 'config' as const,
+      revisionId: carried.configurationRevisionId,
+    };
+    if (await this.revisions.findStatus(revision) === 'draft') {
+      await this.revisions.publishBatchResumable([revision], actor, {
+        reason,
+        compositeId: configurationPublicationId(carried.configurationRevisionId),
+        selfApproveCritical: true,
+      });
+    }
+    return carried.configurationRevisionId;
+  }
+
   private async assertSignsCurrentDecisions(
     appScope: { tenantId: string; targetAppId: string },
     configurationRevisionId: string,
diff --git a/apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts b/apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts
@@ -1,4 +1,4 @@
-import { Inject, Injectable } from '@nestjs/common';
+import { ConflictException, Inject, Injectable } from '@nestjs/common';
 import {
   RuntimeAppConfigurationService,
   policyOnlyRevisionId,
@@ -18,6 +18,7 @@ import {
 import {
   boundToolOverrideDeltas,
   reportedToolPolicy,
+  type StoredToolOverride,
   type ToolOverrideDelta,
 } from './tool-override';
 
@@ -58,8 +59,9 @@ export function configurationReplacingRun(
   return target.configurationRevisionId;
 }
 
-type ResolvedTarget =
-  | Exclude<PolicyRevisionTarget, { kind: 'policy-only' }>
+/** Which revision signs a set of decisions over one published configuration. */
+type Signing =
+  | { kind: 'published'; configurationRevisionId: string }
   | {
     kind: 'policy-only';
     configurationRevisionId: string;
@@ -67,6 +69,8 @@ type ResolvedTarget =
     toolOverrides: ToolOverrideDelta[];
   };
 
+type ResolvedTarget = { kind: 'unpublished-decisions' } | Signing;
+
 /**
  * Turns the app's saved tool decisions into a policy-only configuration
  * revision on top of the latest published configuration (the pattern of
@@ -120,6 +124,60 @@ export class ToolPolicyRevisionService {
     };
   }
 
+  /**
+   * The configuration to roll out when `configurationRevisionId` is deployed:
+   * itself when it signs the app's current decisions (bounded by the code it
+   * binds), else the revision that signs them over the newest published
+   * configuration (`target`, drafted here) provided that has the same code
+   * and prompt. Decisions are app-wide, so no deploy may roll out an older
+   * decision set, or none.
+   *
+   * Older code with the current decisions is refused (409
+   * `configuration_predates_tool_decisions`): a revision drafted over it would
+   * become the newest published configuration, and every later save, the
+   * connected overview and its apply would build on that older code.
+   */
+  async carry(
+    scope: AppSetupScope,
+    configurationRevisionId: string,
+    actor: RuntimeActor,
+  ): Promise<PolicyRevisionDraft> {
+    const [base, latest, overrides] = await Promise.all([
+      this.published.findPublishedConfiguration(scope, configurationRevisionId),
+      this.published.findLatestPublishedConfiguration(scope),
+      this.setup.listToolOverrides(scope),
+    ]);
+    // Derivation refuses an unpublished or unsigned configuration itself.
+    if (!base?.signed) return { configurationRevisionId, created: false };
+    if ((await this.signing(scope, base, overrides)).kind === 'published') {
+      return { configurationRevisionId, created: false };
+    }
+    if (
+      !latest?.signed
+      || latest.runtimeDigest !== base.runtimeDigest
+      || latest.promptDigest !== base.promptDigest
+    ) {
+      throw new ConflictException({
+        code: 'configuration_predates_tool_decisions',
+        message: 'This configuration does not sign the current tool decisions '
+          + 'and is not the newest published code; deploy the newest one',
+      });
+    }
+    const target = await this.signing(scope, latest, overrides);
+    if (target.kind === 'published') {
+      return { configurationRevisionId: target.configurationRevisionId, created: false };
+    }
+    const result = await this.configurations.createPolicyOnlyRevision({
+      ...scope,
+      baseConfiguration: target.base,
+      toolOverrides: target.toolOverrides,
+    }, actor);
+    return {
+      configurationRevisionId: result.configurationRevisionId,
+      created: true,
+    };
+  }
+
   private async resolve(scope: AppSetupScope): Promise<ResolvedTarget | null> {
     const [base, overrides] = await Promise.all([
       this.published.findLatestPublishedConfiguration(scope),
@@ -128,6 +186,14 @@ export class ToolPolicyRevisionService {
     if (!base || !base.signed) {
       return overrides.length > 0 ? { kind: 'unpublished-decisions' } : null;
     }
+    return this.signing(scope, base, overrides);
+  }
+
+  private async signing(
+    scope: AppSetupScope,
+    base: PublishedConfigurationRecord,
+    overrides: StoredToolOverride[],
+  ): Promise<Signing> {
     const artifactTools = await this.published.findPublishedSetupArtifactTools(
       scope,
       base.setupArtifactDigest,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/decision-carry.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/apps 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  3 passed (3)`, `Tests  60 passed (60)`; `Test Files  23 passed (23)`, `Tests  430 passed (430)`; `Test Files  127 passed (127)`, `Tests  1445 passed | 10 skipped (1455)`; `api-typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/tool-policy-revision.service.ts apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts apps/api/src/modules/runtime-setup-v2/__tests__/decision-carry.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts
git commit -m "fix(runtime-setup): roll current tool decisions out with every deploy"
```

---

### Task 9: API – apply a decision set again after its rollout ended

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts` (after `configurationApplyId`), `apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts` (`applyConfigurationTo`), `apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts` (`pendingChange`, `action`)
- Test: `__tests__/publish-and-deploy-id.spec.ts`, `__tests__/publish-and-deploy.service.spec.ts`, `__tests__/connected-overview.service.spec.ts`

**Interfaces:**
- Consumes: `configurationApplyId`, `RuntimeDeploymentService.list`, Task 8's `withCurrentDecisions`, P08b Task 11's overview rules.
- Produces:
  - `configurationApplyAttemptId(configurationRevisionId, environmentId, attempt: number): string` (attempt 0 = `configurationApplyId`; canonicalised casing like every identity of the file).
  - `currentConfigurationApply<T extends { id: string; status: string }>(deployments, configurationRevisionId, environmentId): { id: string; deployment: T | undefined }`: the first attempt that is missing, `pending` or `active`.
  - `applyConfigurationTo` resumes or creates exactly that attempt; the connected overview reads its `applying` deployment from it (a pending re-apply is `resume`; an ended attempt alone still yields no pending change).

These are the P08b ledger minors T8 ("deterministic configurationApplyId + shared settle: once a configuration's deployment in an environment is terminal it can never be re-applied/retried there (409)") and T11 ("a decision apply that was rolled back … is never offered again … while the capability view keeps decisionPending=true"). The `run()` composite keeps its single identity: its "fails closed instead of resuming a terminal … deployment" tests stay as they are.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
@@ -4,7 +4,11 @@ import {
   ConnectedOverviewService,
   DrizzleConnectedOverviewStore,
 } from '../connected-overview.service';
-import { configurationApplyId, publishAndDeployId } from '../publish-and-deploy-id';
+import {
+  configurationApplyAttemptId,
+  configurationApplyId,
+  publishAndDeployId,
+} from '../publish-and-deploy-id';
 
 const scope = {
   tenantId: '019fb200-0000-7000-8000-000000000001',
@@ -332,6 +336,31 @@ describe('ConnectedOverviewService', () => {
         .resolves.toBeNull();
     });
 
+    /**
+     * An ended rollout is not offered again (it must not undo a rollback),
+     * but once an operator applies the decisions again explicitly, that new
+     * attempt is what the dashboard resumes while it waits for health.
+     */
+    it('resumes a repeated apply of an ended decision revision', async () => {
+      const f = fixture({
+        runStatus: 'published',
+        runPublication: runConfiguration,
+        target: published,
+        deployments: [
+          runComposite('active'),
+          decisionApply('rolled_back'),
+          decisionApply('pending', {
+            id: configurationApplyAttemptId(revision, environmentId, 1),
+          }),
+        ],
+      });
+
+      await expect(f.service.get(scope, environmentId)).resolves
+        .toMatchObject({ action: 'resume' });
+      await expect(f.service.pendingConfiguration({ ...scope, environmentId }))
+        .resolves.toBe(revision);
+    });
+
     it('leaves a configuration to its run when the run published it', async () => {
       const f = fixture({
         runStatus: 'published',
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts
@@ -1,5 +1,10 @@
 import { describe, expect, it } from 'vitest';
-import { publishAndDeployId } from '../publish-and-deploy-id';
+import {
+  configurationApplyAttemptId,
+  configurationApplyId,
+  currentConfigurationApply,
+  publishAndDeployId,
+} from '../publish-and-deploy-id';
 
 const runId = '019fb200-0000-7000-8000-000000000004';
 const environmentId = '019fb200-0000-7000-8000-000000000003';
@@ -34,3 +39,55 @@ describe('publishAndDeployId', () => {
       .toBe(publishAndDeployId(runId, environmentId));
   });
 });
+
+describe('configuration apply attempts', () => {
+  const configurationId = '019fb200-0000-7000-8000-0000000000c2';
+  const attempt = (n: number) => configurationApplyAttemptId(configurationId, environmentId, n);
+  const deployment = (n: number, status: string) => ({ id: attempt(n), status });
+
+  it('keeps the original identity for the first attempt', () => {
+    expect(attempt(0)).toBe(configurationApplyId(configurationId, environmentId));
+    expect(new Set([attempt(0), attempt(1), attempt(2)]).size).toBe(3);
+    expect(attempt(1)).toMatch(
+      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
+    );
+    expect(configurationApplyAttemptId(
+      configurationId.toUpperCase(),
+      environmentId.toUpperCase(),
+      1,
+    )).toBe(attempt(1));
+  });
+
+  it.each([
+    ['nothing was applied yet', [], 0, undefined],
+    ['the first attempt waits for health', [deployment(0, 'pending')], 0, 'pending'],
+    ['the first attempt runs', [deployment(0, 'active')], 0, 'active'],
+    ['the first attempt was rolled back', [deployment(0, 'rolled_back')], 1, undefined],
+    [
+      'two attempts ended',
+      [deployment(0, 'superseded'), deployment(1, 'rolled_back')],
+      2,
+      undefined,
+    ],
+    [
+      'a later attempt waits for health',
+      [deployment(0, 'rolled_back'), deployment(1, 'pending')],
+      1,
+      'pending',
+    ],
+    [
+      'only other deployments exist',
+      [{ id: '019fb200-0000-7000-8000-0000000000e1', status: 'rolled_back' }],
+      0,
+      undefined,
+    ],
+  ] as Array<[string, Array<{ id: string; status: string }>, number, string | undefined]>)(
+    'works on the right attempt when %s',
+    (_name, deployments, expectedAttempt, expectedStatus) => {
+      const current = currentConfigurationApply(deployments, configurationId, environmentId);
+
+      expect(current.id).toBe(attempt(expectedAttempt));
+      expect(current.deployment?.status).toBe(expectedStatus);
+    },
+  );
+});
diff --git a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
@@ -7,6 +7,7 @@ import { describe, expect, it, vi } from 'vitest';
 import { PublishAndDeployService } from '../publish-and-deploy.service';
 import { ToolPolicyRevisionService } from '../tool-policy-revision.service';
 import {
+  configurationApplyAttemptId,
   configurationApplyId,
   configurationPublicationId,
   publishAndDeployId,
@@ -954,6 +955,62 @@ describe('PublishAndDeployService', () => {
       );
     });
 
+    /**
+     * A rollback (or a later deployment) ends a decision rollout for good;
+     * the same decisions can still be applied again, as a new attempt.
+     */
+    it.each(['rolled_back', 'superseded'])(
+      'applies the same decisions again after their rollout was %s',
+      async (status) => {
+        const f = fixture({ deployments: [{
+          id: configurationApplyId(configurationId, environmentId),
+          status,
+          healthStatus: 'healthy',
+        }] });
+        f.revisions.findStatus.mockResolvedValue('published');
+
+        const result = await f.service.applyConfiguration(scope, configurationId, {
+          environmentId,
+          reason: 'Platform decision apply',
+        }, actor);
+
+        const again = configurationApplyAttemptId(configurationId, environmentId, 1);
+        expect(f.derivation.deployPublishedConfiguration).toHaveBeenCalledWith(
+          { ...scope, environmentId },
+          configurationId,
+          expect.objectContaining({ deploymentId: again }),
+          expect.anything(),
+        );
+        expect(result).toMatchObject({ compositeId: again, step: 'awaiting_health' });
+      },
+    );
+
+    it('resumes a repeated apply that waits for health instead of starting another', async () => {
+      const again = configurationApplyAttemptId(configurationId, environmentId, 1);
+      const f = fixture({ deployments: [
+        {
+          id: configurationApplyId(configurationId, environmentId),
+          status: 'rolled_back',
+          healthStatus: 'healthy',
+        },
+        { id: again, status: 'pending', healthStatus: 'healthy' },
+      ] });
+      f.revisions.findStatus.mockResolvedValue('published');
+
+      const result = await f.service.applyConfiguration(scope, configurationId, {
+        environmentId,
+        reason: 'Platform decision apply',
+      }, actor);
+
+      expect(f.derivation.deployPublishedConfiguration).not.toHaveBeenCalled();
+      expect(f.deployments.activate).toHaveBeenCalledWith(
+        { ...scope, environmentId },
+        again,
+        actor,
+      );
+      expect(result).toMatchObject({ compositeId: again, step: 'active' });
+    });
+
     it('refuses a revision that is neither a draft nor published', async () => {
       const f = fixture();
       f.revisions.findStatus.mockResolvedValue('withdrawn');
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts 2>&1 | grep -E "×|Test Files|Tests |TypeError"
```

Expected: `publish-and-deploy-id.spec.ts` does not load (`TypeError`: `configurationApplyAttemptId` is not a function; its tests are not counted), three `×` in `publish-and-deploy.service.spec.ts` (both "applies the same decisions again after their rollout was …" cases and "resumes a repeated apply that waits for health instead of starting another") and one in `connected-overview.service.spec.ts` ("resumes a repeated apply of an ended decision revision"); `Test Files  3 failed (3)`, `Tests  4 failed | 64 passed (68)`.

- [ ] **Step 3: Resolve the current attempt**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts b/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts
@@ -11,7 +11,7 @@ import {
   RuntimeDeploymentService,
   type RuntimeDeploymentSummary,
 } from '../runtime-deployments/runtime-deployment.service';
-import { configurationApplyId, publishAndDeployId } from './publish-and-deploy-id';
+import { currentConfigurationApply, publishAndDeployId } from './publish-and-deploy-id';
 import { type AppSetupScope } from './runtime-setup-v2.store';
 import {
   configurationReplacingRun,
@@ -256,9 +256,13 @@ export class ConnectedOverviewService {
     if (target.kind === 'policy-only') return pending;
 
     if (run?.publicationConfigurationRevisionId === configurationRevisionId) return null;
-    const applying = deployments.find((deployment) => (
-      deployment.id === configurationApplyId(configurationRevisionId, environmentId)
-    ));
+    // The current attempt: an explicit re-apply after an ended rollout is
+    // resumed like the first one, an ended one alone is not offered again.
+    const { deployment: applying } = currentConfigurationApply(
+      deployments,
+      configurationRevisionId,
+      environmentId,
+    );
     if (applying) return applying.status === 'pending' ? pending : null;
     return deployments.some((deployment) => (
       deployment.configRevisionId === configurationRevisionId
@@ -317,10 +321,11 @@ export class ConnectedOverviewService {
     if (connection !== 'connected') return 'sync';
     const { pending, deployments, replacedBy } = state;
     if (pending?.kind === 'configuration') {
-      const applying = deployments.find((deployment) => deployment.id === configurationApplyId(
+      const { deployment: applying } = currentConfigurationApply(
+        deployments,
         pending.configurationRevisionId,
         environmentId,
-      ));
+      );
       return applying?.status === 'pending' ? 'resume' : 'apply';
     }
     if (candidateStatus === 'awaiting_health' || candidateStatus === 'published') {
diff --git a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts
@@ -31,6 +31,49 @@ export function configurationApplyId(
   return identity('configuration-apply', configurationRevisionId, environmentId);
 }
 
+/**
+ * Deployment identity of one rollout attempt of a configuration in one
+ * environment. Attempt 0 is `configurationApplyId`, so every deployment
+ * created before attempts existed keeps its identity.
+ */
+export function configurationApplyAttemptId(
+  configurationRevisionId: string,
+  environmentId: string,
+  attempt: number,
+): string {
+  return attempt === 0
+    ? configurationApplyId(configurationRevisionId, environmentId)
+    : identity(
+      'configuration-apply',
+      configurationRevisionId,
+      environmentId,
+      `attempt-${attempt}`,
+    );
+}
+
+/**
+ * The rollout an apply of one configuration in one environment works on: the
+ * newest attempt while it is pending or active (a retry resumes it), else a
+ * new attempt once the newest one ended (rolled back or superseded), so the
+ * same decisions can be applied again. A new attempt is only ever created
+ * after the previous one ended, so the first attempt that is missing or still
+ * pending or active is the current one.
+ */
+export function currentConfigurationApply<T extends { id: string; status: string }>(
+  deployments: ReadonlyArray<T>,
+  configurationRevisionId: string,
+  environmentId: string,
+): { id: string; deployment: T | undefined } {
+  const byId = new Map(deployments.map((deployment) => [deployment.id, deployment]));
+  for (let attempt = 0; ; attempt += 1) {
+    const id = configurationApplyAttemptId(configurationRevisionId, environmentId, attempt);
+    const deployment = byId.get(id);
+    if (!deployment || deployment.status === 'pending' || deployment.status === 'active') {
+      return { id, deployment };
+    }
+  }
+}
+
 function identity(kind: string, ...parts: string[]): string {
   const hex = createHash('sha256')
     .update([kind, ...parts.map((part) => part.toLowerCase())].join('\0'))
diff --git a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
@@ -29,8 +29,8 @@ import {
 } from './runtime-setup-v2.service';
 import { ConnectedOverviewService } from './connected-overview.service';
 import {
-  configurationApplyId,
   configurationPublicationId,
+  currentConfigurationApply,
   publishAndDeployId,
 } from './publish-and-deploy-id';
 import {
@@ -308,11 +308,14 @@ export class PublishAndDeployService {
         input.reason,
         actor,
       );
-    const compositeId = configurationApplyId(
+    // A pending or active rollout of it is resumed; after one ended (rolled
+    // back or superseded) the apply starts the next attempt.
+    const { id: compositeId, deployment: current } = currentConfigurationApply(
+      await this.deployments.list(scope),
       deployable,
       input.environmentId,
     );
-    const deployed = await this.compositeDeployment(scope, compositeId)
+    const deployed = current
       ?? (await this.derivation.deployPublishedConfiguration(
         scope,
         deployable,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/runtime-setup-v2 src/modules/apps 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"
```

Expected: `Test Files  3 passed (3)`, `Tests  79 passed (79)`; `Test Files  23 passed (23)`, `Tests  442 passed (442)`; `Test Files  127 passed (127)`, `Tests  1457 passed | 10 skipped (1467)`; `api-typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/publish-and-deploy-id.ts apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts apps/api/src/modules/runtime-setup-v2/connected-overview.service.ts apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy-id.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts apps/api/src/modules/runtime-setup-v2/__tests__/connected-overview.service.spec.ts
git commit -m "fix(runtime-setup): apply a decision set again after its rollout ended"
```

---

### Task 10: DB – document the rollout and prove its queries

**Files:**
- Modify: `packages/db/MIGRATIONS.md` (append one section after the last line, `:123`)
- Create: `packages/db/src/__tests__/tool-decision-rollout.test.ts`
- Test: the new test, the DB suite, P09 Task 7's `MIGRATIONS.md` patch (`git apply --check`)

**Interfaces:**
- Consumes: the migrated schema (`tool_revisions.definition`, `runtime_policy_revisions.policy`, `runtime_app_setup_tool_overrides`), the P08b checkpoint item 1 queries, P09 Task 7's patch of `MIGRATIONS.md:32-38` and `:117-123`.
- Produces: the section "## Rolling out bounded tool decisions (`0044`, P08b and P08d)" with exactly three fenced `sql` queries in this order: apps with saved decisions, tier-3 tool revisions, tier-3 policy entries. The test extracts them by that heading.

This covers the P08b ledger minor T5 ("configurations published before 0044 carry tool_overrides '[]' … belongs in the 0044 production runbook"), checkpoint item 1 (the tier-3 SELECTs) and the deploy order recorded in the controller ledger ("only after pilot apps run a P04 SDK or decisions cleared").

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/tool-decision-rollout.test.ts`:

````ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const runbook = readFileSync(
  fileURLToPath(new URL('../../MIGRATIONS.md', import.meta.url)),
  'utf8',
);
const HEADING = '## Rolling out bounded tool decisions';

const TENANT = '019fb830-0000-7000-8000-000000000001';
const APP = '019fb830-0000-7000-8000-000000000002';
const ENVIRONMENT = '019fb830-0000-7000-8000-0000000000e1';
const RUN = '019fb830-0000-7000-8000-0000000000f1';
const DELETE_TOOL = '019fb830-0000-7000-8000-0000000000a1';
const WRITE_TOOL = '019fb830-0000-7000-8000-0000000000a2';
const BLOCKED_REVISION = '019fb830-0000-7000-8000-0000000000b1';
const BLOCKED_POLICY = '019fb830-0000-7000-8000-0000000000c1';

/** The fenced SQL of the rollout section, in document order. */
function rolloutQueries(): string[] {
  const start = runbook.indexOf(HEADING);
  if (start === -1) return [];
  const rest = runbook.slice(start + HEADING.length);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^[ \t]*```sql\n([\s\S]*?)^[ \t]*```/gm)]
    .map((match) => match[1]!);
}

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
  const published = `'published', 'signature', 'key-1', 'editor-1', 'publisher-1', now()`;
  await client.exec(`
    INSERT INTO tenants (id, name, slug) VALUES ('${TENANT}', 'Acme', 'acme');
    INSERT INTO target_apps (id, tenant_id, name) VALUES ('${APP}', '${TENANT}', 'App');
    INSERT INTO runtime_tools (id, tenant_id, target_app_id, stable_key) VALUES
      ('${DELETE_TOOL}', '${TENANT}', '${APP}', 'DELETE /api/tasks/:id'),
      ('${WRITE_TOOL}', '${TENANT}', '${APP}', 'POST /api/tasks');
    INSERT INTO tool_revisions (id, tenant_id, target_app_id, tool_id, revision,
      source_fingerprint, definition, content_hash,
      status, signature, signing_key_id, created_by, published_by, published_at)
    VALUES
      ('${BLOCKED_REVISION}', '${TENANT}', '${APP}', '${DELETE_TOOL}', 1, 'sha256:f',
       '{"riskClass":"delete","requiresApproval":false}', 'h1', ${published}),
      (gen_random_uuid(), '${TENANT}', '${APP}', '${DELETE_TOOL}', 2, 'sha256:f',
       '{"riskClass":"delete","requiresApproval":true}', 'h2', ${published}),
      (gen_random_uuid(), '${TENANT}', '${APP}', '${WRITE_TOOL}', 1, 'sha256:f',
       '{"riskClass":"write","requiresApproval":false}', 'h3', ${published});
    INSERT INTO tool_revisions (tenant_id, target_app_id, tool_id, revision,
      source_fingerprint, definition, content_hash, created_by)
    VALUES ('${TENANT}', '${APP}', '${DELETE_TOOL}', 3, 'sha256:f',
      '{"riskClass":"external","requiresApproval":false}', 'h4', 'editor-1');
    INSERT INTO runtime_environments (id, tenant_id, target_app_id, key, name, kind,
      promotion_order)
    VALUES ('${ENVIRONMENT}', '${TENANT}', '${APP}', 'production', 'Production',
      'production', 0);
    INSERT INTO runtime_policy_revisions (id, tenant_id, target_app_id, environment_id,
      revision, policy, content_hash,
      status, signature, signing_key_id, created_by, published_by, published_at)
    VALUES
      ('${BLOCKED_POLICY}', '${TENANT}', '${APP}', '${ENVIRONMENT}', 1,
       '{"toolPolicies":[{"toolId":"${DELETE_TOOL}","riskClass":"financial","requiresApproval":false},{"toolId":"${WRITE_TOOL}","riskClass":"write","requiresApproval":false}]}',
       'p1', ${published}),
      (gen_random_uuid(), '${TENANT}', '${APP}', '${ENVIRONMENT}', 2,
       '{"toolPolicies":{"not":"a list"}}', 'p2', ${published});
    INSERT INTO runtime_app_setup_runs (id, tenant_id, target_app_id, assessment_mode,
      discovery_digest, started_by)
    VALUES ('${RUN}', '${TENANT}', '${APP}', 'autonomous', 'sha256:d', 'editor-1');
    INSERT INTO runtime_app_setup_tool_overrides (tenant_id, target_app_id, run_id,
      tool_id, enabled, updated_by)
    VALUES
      ('${TENANT}', '${APP}', '${RUN}', '${DELETE_TOOL}', false, 'editor-1'),
      ('${TENANT}', '${APP}', '${RUN}', '${WRITE_TOOL}', false, 'editor-1');
  `);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

/**
 * The rollout section of MIGRATIONS.md is what Philipp runs against the
 * shared database (read-only). Its queries run here against the real
 * migrated schema and find exactly the rows they are meant to find.
 */
describe('rolling out bounded tool decisions (MIGRATIONS.md)', () => {
  it('documents three read-only queries', () => {
    const queries = rolloutQueries();

    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.trim()).toMatch(/^(--[^\n]*\n)*SELECT\b/);
      expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    }
  });

  it('lists the apps whose runners must understand signed decisions first', async () => {
    const { rows } = await client.query(rolloutQueries()[0]!);

    expect(rows).toEqual([{ tenant_id: TENANT, target_app_id: APP, decisions: 2 }]);
  });

  it('finds published tool revisions at tier 3 without confirmation', async () => {
    const { rows } = await client.query(rolloutQueries()[1]!);

    expect(rows).toEqual([{ id: BLOCKED_REVISION, target_app_id: APP }]);
  });

  it('finds published policy entries at tier 3 without confirmation', async () => {
    const { rows } = await client.query(rolloutQueries()[2]!);

    expect(rows).toEqual([{
      id: BLOCKED_POLICY,
      target_app_id: APP,
      environment_id: ENVIRONMENT,
      tool_id: DELETE_TOOL,
    }]);
  });
});
````

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/tool-decision-rollout.test.ts 2>&1 | grep -E "^\(fail\)| pass$| fail$|^Ran"
```

Expected: four `(fail)` lines ("documents three read-only queries" finds none, so every query test has nothing to run), `0 pass`, `4 fail`, `Ran 4 tests across 1 file.`

- [ ] **Step 3: Append the rollout section**

````bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/MIGRATIONS.md b/packages/db/MIGRATIONS.md
--- a/packages/db/MIGRATIONS.md
+++ b/packages/db/MIGRATIONS.md
@@ -121,3 +121,69 @@ never run by an agent.
    `drizzle.__drizzle_migrations` holds exactly one row per journal entry
    (`select count(*) from drizzle.__drizzle_migrations` equals the number of
    `entries` in `meta/_journal.json`).
+
+## Rolling out bounded tool decisions (`0044`, P08b and P08d)
+
+`0044_bounded_tool_overrides` only adds columns, but the API released with it
+changes what runners receive: decisions saved in the dashboard are signed as
+`toolOverrides` deltas on the environment policy revision, and a runner older
+than SDK P04 refuses a policy that carries them (strict schema). It keeps its
+last accepted deployment, and the new deployment never reports healthy. No
+agent runs anything in this section; every query only reads.
+
+1. Order. Deploy the API with `0044` only after every app that has saved
+   decisions runs an SDK that contains P04, or after its decisions were
+   removed (the dashboard sends each decided field as `null`; since P08d a
+   save that leaves nothing different from the code deletes the decision).
+   These apps have saved decisions:
+
+   ```sql
+   SELECT tenant_id, target_app_id, count(*)::int AS decisions
+   FROM runtime_app_setup_tool_overrides
+   GROUP BY tenant_id, target_app_id
+   ORDER BY tenant_id, target_app_id;
+   ```
+
+2. Before the first deployment, find published revisions that every new draft
+   now refuses with 422 `tier-3-always-requires-approval`: a tool or policy
+   revision at tier 3 (anything but `safe-read`, `read-sensitive`, `write`)
+   with `requiresApproval` false. The old `applyToolOverride` and the legacy
+   setup DTO could publish them. Zero rows from both: nothing to do. Any row:
+   that app cannot deploy a derived revision pair until it is republished from
+   a fresh reviewed run (current SDK artifacts floor tier 3 to
+   `requiresApproval: true`). Never edit the signed rows. This fails closed
+   (the runner floors tier 3 itself), so it costs availability, not safety.
+
+   ```sql
+   SELECT id, target_app_id
+   FROM tool_revisions
+   WHERE status = 'published'
+     AND definition->>'riskClass' NOT IN ('safe-read', 'read-sensitive', 'write')
+     AND definition->>'requiresApproval' = 'false';
+   ```
+
+   ```sql
+   SELECT r.id, r.target_app_id, r.environment_id, p->>'toolId' AS tool_id
+   FROM runtime_policy_revisions r,
+        jsonb_array_elements(
+          CASE WHEN jsonb_typeof(r.policy->'toolPolicies') = 'array'
+               THEN r.policy->'toolPolicies' ELSE '[]'::jsonb END
+        ) AS p
+   WHERE r.status = 'published'
+     AND p->>'riskClass' NOT IN ('safe-read', 'read-sensitive', 'write')
+     AND p->>'requiresApproval' = 'false';
+   ```
+
+3. Configurations published before `0044` sign no decisions (their
+   `tool_overrides` is `'[]'`), while the old derivation read descriptions and
+   the other decisions from the live table. After the deploy, saved decisions
+   reach an environment only with a revision that signs them: the connected
+   overview offers "apply" for it, and an explicit run deploy, a Managed
+   promotion or the apply of a configuration with the newest code rolls that
+   revision out instead (P08d); older code that does not sign them answers
+   409 `configuration_predates_tool_decisions`. A stored value equal to what
+   the code reports is a copy, not a decision, and is dropped (P08d), as is a
+   confirmation relaxation stored before `0044` (it has no reviewed baseline).
+   Apply the revision that signs the decisions in every environment before
+   anything else is rolled out, so no environment loses an operator-written
+   description in between.
PATCH
````

- [ ] **Step 4: Run and see GREEN; prove P09's positional patch still applies**

The script reads P09 Task 7's `MIGRATIONS.md` patch from the P09 plan file and runs `git apply --check` on it, which changes nothing.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/tool-decision-rollout.test.ts 2>&1 | tail -4
bun test 2>&1 | tail -4
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
python3 - <<'PY'
import re, subprocess
plan = open('/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-mvp-plan-09-metrics.md').read()
for patch in re.findall(r"git apply <<'PATCH'\n(.*?)\nPATCH\n", plan, re.S):
    path = re.search(r'^diff --git a/(\S+)', patch, re.M).group(1)
    if not path.startswith(('packages/db/MIGRATIONS.md',)):
        continue
    check = subprocess.run(['git', 'apply', '--check', '-'], input=patch + '\n',
                           text=True, capture_output=True)
    print(path, 'applies' if check.returncode == 0 else 'DOES NOT APPLY: ' + check.stderr.strip())
PY
```

Expected: `4 pass`, `0 fail`, `Ran 4 tests across 1 file.`; `121 pass`, `0 fail`, `Ran 121 tests across 22 files.`; `packages/db/MIGRATIONS.md applies`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/MIGRATIONS.md packages/db/src/__tests__/tool-decision-rollout.test.ts
git commit -m "docs(db): add the bounded tool decision rollout runbook"
```

---

### Task 11: P08d gate run and checkpoint (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Platform gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
pgrep -fl -- "nest start|next dev|vitest --watch" | grep mvp-platform || echo "no watcher"
(cd packages/db && ./node_modules/.bin/tsc -p tsconfig.json && echo "db-build=0")
(cd apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?")
(cd apps/api && ./node_modules/.bin/vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests ")
(cd apps/citadel && ./node_modules/.bin/tsc --noEmit; echo "citadel-tsc=$?")
(cd apps/citadel && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests ")
(cd apps/citadel && L="$(mktemp -d)" && bun run lint > "$L/lint.log" 2>&1; echo "citadel-lint=$?"; grep "✖" "$L/lint.log")
(cd packages/db && bun test 2>&1 | tail -4)
(cd packages/db && bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts src/__tests__/bounded-tool-overrides-migration.test.ts 2>&1 | tail -4)
(cd packages/db && DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1)
node -e "const j=require('./packages/db/drizzle/meta/_journal.json'); console.log(j.entries.at(-1).tag)"
grep -c "export function boundAppOf\|export function appScopeFor" apps/api/src/common/app-scope.ts
git status --short
git log --oneline 9014587..HEAD | wc -l
git diff --check 9014587 HEAD && echo "diff-check=clean"
```

P09's Platform patches (Tasks 7, 8 and 11), read from the P09 plan and checked without applying:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
python3 - <<'PY'
import re, subprocess
plan = open('/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-mvp-plan-09-metrics.md').read()
for patch in re.findall(r"git apply <<'PATCH'\n(.*?)\nPATCH\n", plan, re.S):
    path = re.search(r'^diff --git a/(\S+)', patch, re.M).group(1)
    if not path.startswith(('apps/', 'packages/')):
        continue
    check = subprocess.run(['git', 'apply', '--check', '-'], input=patch + '\n',
                           text=True, capture_output=True)
    print(path, 'applies' if check.returncode == 0 else 'DOES NOT APPLY: ' + check.stderr.strip())
PY
```

Expected: `no watcher`; `db-build=0`; `api-typecheck=0`; API `Test Files  127 passed (127)`, `Tests  1457 passed | 10 skipped (1467)` (baseline plus 4 files and 84 tests); `citadel-tsc=0`; Citadel `Test Files  39 passed (39)`, `Tests  256 passed (256)`; `citadel-lint=0`, `✖ 30 problems (0 errors, 30 warnings)` (Citadel is not touched); DB `121 pass`, `0 fail`, `Ran 121 tests across 22 files.` (plus 4 tests and 1 file); the migration trio `8 pass`, `0 fail`, `Ran 8 tests across 3 files.`; `Everything's fine 🐶🔥`; `0044_bounded_tool_overrides`; `2`; empty status; `10` commits; `diff-check=clean`; then five lines ending in `applies`: `packages/db/src/schema/index.ts`, `packages/db/MIGRATIONS.md`, `packages/db/src/index.ts`, `apps/api/src/product-profile.spec.ts`, `apps/api/src/product-profile.ts`. A single timeout in a load-sensitive spec is rerun once before it counts as a difference.

- [ ] **Step 2: Checkpoint report to Philipp**

Report the 10 commits with hashes (`git log --oneline 9014587..HEAD`), the gate numbers above, the decisions table and the shared contract changes from the top of this plan, and these items (none of them is executed by an agent):

1. **Rollout of `0044` with P08b and P08d (approval needed):** the order and the three read-only queries are now in `packages/db/MIGRATIONS.md`, "Rolling out bounded tool decisions", proved against the migrated schema by `tool-decision-rollout.test.ts`. Deploy the API with `0044` only after every app that the first query lists runs an SDK with P04, or after its decisions were removed; run the two tier-3 queries before the first deployment. The P08b checkpoint's approvals A1-A3 stay open as they were (P08a baseline, `db:migrate`, first Pro switch).
2. **For P09 (Platform half, Tasks 6-13):** Task 6's "last P08b commit" is now P08d's last commit (`docs(db): add the bounded tool decision rollout runbook`); the newest journal tag is still `0044_bounded_tool_overrides` (P09 takes `0045`); `app-scope.ts` still has exactly two exports. Its baseline is this gate: API `127`/`1457 passed | 10 skipped (1467)`, DB `121` across `22` files, so P09 Task 13 expects API `131`/`1537 passed | 10 skipped`, DB `138` across `24` files (P09's own +4 files, +80 tests, +17 DB tests, +2 DB files). All five Platform patches of P09 Tasks 7, 8 and 11 still apply (Step 1). Two things P09 can reuse: `createMigratedDatabase`/`seedApp` in `apps/api/src/common/__tests__/pglite-database.ts` for a store test on PGlite, and the rule that the whole API suite runs with `--maxWorkers=3`.
3. **For P08c (Citadel):** (a) send only the fields the operator changed (design 4.2.4): the server stores only deviations and stored restrictions, signs every stored restriction and removes a decision with neither; a resent unchanged value is dropped, so diff-only stays the UX rule, and "back to the code value" sends `null` (also the way to clear legacy restriction copies); (b) show the new 422 reason `risk-class-unassessed` (choosing `unknown` for an assessed tool) and drop `unknown` from the select as planned; (c) a deploy may answer 409 `configuration_predates_tool_decisions` (explicit run route, promotion, configuration apply): explain that the decisions are newer than that code and offer the newest configuration instead; (d) `POST …/runs/:runId/publish-and-deploy`, the Managed promotion and `POST …/configurations/:id/apply` may deploy a different configuration than named (the one that signs the current decisions; the response's `compositeId`/`deploymentId` name it); (e) re-apply after a rollback or supersession is the explicit `POST …/configurations/:configurationRevisionId/apply` (new attempt identity); the overview resumes a pending re-apply but does not offer an ended rollout on its own, so where `decisionPending` is true and the overview says `none`, the UI offers "apply again" explicitly; (f) the P08b item "the explicit run route and the pipeline promote still deploy the run's own configuration" is closed by Task 8.
4. **Open, not in this plan:** (a) a Managed promotion requires the run's own deployment to be active in the source environment (`claimPromotion`, `environment_promotion_source_not_active`); after a decision apply in the source environment (it supersedes that deployment) the run cannot be promoted from there until it runs again under its own identity. Fails closed; P08c or P13 decides whether the claim accepts any active deployment with the run's runtime digest. (b) Promoting a run whose code is older than the newest published configuration answers 409 once decisions changed after its publication; an existing published configuration with that code and the current decisions is not looked up (a store query by runtime digest would). (c) The P08b ledger minors not touched here (SSE `RateLimitInterceptor` headers, `RuntimeConnectionController.stream` 400 as `event: error`, a CLI-switched Pro tenant that later gains a Stripe customer, gate write routes without app scope) keep their proposed owner P13. (d) The granular four-eyes routes `…/deployments/deploy-latest-published` (derives from the newest published configuration, which may predate a decision revision that is still a draft) and `…/deployments/promotions` (copies a source deployment's pair) do not carry decisions; they are the advanced surface next to the composite apply, and P08c or P13 decides whether they get the same rule.
5. **SDK:** nothing changes for P04 or P05; the Platform accepts what P04 Task 8 sends (HEAD). A runner before P04 still refuses a policy revision that carries decisions (P08b shared contract), which item 1's order covers.

Do not push.

---

## Self-Review

**Spec and roadmap coverage**

| Requirement | Task |
| --- | --- |
| Roadmap "Platform-Schemas für Capability-Report und `glirastes sync` akzeptieren nur GET/POST/PUT/PATCH/DELETE; seit P04 meldet das SDK HEAD als lesendes Tool" (P04 ledger X10/R5) | 1 (legacy scan pinned at five) |
| Roadmap "`boundToolOverride` speichert unveränderte Beschreibung und No-op-Policy-Felder … Platform verwirft No-op-Felder"; spec 4.10.3 "nie Kopien lokaler Werte"; ledger X6 (a reported `unknown` blocks every save) | 6 (with SDK vector parity) |
| Race-free decision saves (P08b ledger T3) | 5 (PGlite, two interleaved saves) |
| Store-level SQL of P08b: `findEnvironmentReports`, `findToolOverride`, whole-row upsert, `tool_overrides` write/read and "absent when empty", `lastAppliedDeploymentId`, `assertConnectedEnvironment` (ledger T3, T4, T5, T9, T10, T11) | 2, 3 |
| SQL-level pins of the audit `targetAppId` conditions; app-scope cases for a tenant-wide key and a dashboard session (ledger T12) | 4 |
| `createPromptOnlyRevision` keeps `toolOverrides` (ledger T4) | 7 |
| Decisions never silently dropped by `run()`, the Managed promotion or the apply of an older published configuration (ledger T8, T11; spec 4.5, 4.9) | 8 (Ruling: carry onto the newest code, 409 for older code; promote and explicit apply both tested) |
| Re-apply after a rollback or supersession without breaking idempotent resume (ledger T8, T11) | 9 |
| Deploy order, tier-3 SELECTs, pre-`0044` description note (ledger T5, P08b checkpoint item 1, controller ledger) | 10 |
| P09 Task 6 measures P08d; P09's positional patches stay applicable | Global Constraints, 10, 11 |

Deliberately not here: any Citadel change (P08c), any SDK change, a migration (P09 takes `0045`), the promotion claim's source rule and a lookup of existing configurations by runtime digest (checkpoint item 4).

**Placeholder scan:** done. Every new file is given in full and every change to an existing file is an exact `git apply` patch generated from the measured implementation; the four mutation checks are exact patches that the same block reverts. Measured on 2026-10-05 in a `git archive` copy of `9014587` with the worktree's `node_modules` linked in (load average about 20): every task was applied cumulatively, its RED measured with only its test part applied, its GREEN, the typecheck and the whole API suite (`--maxWorkers=3`) measured at every task (passing API tests 1373 → 1376 → 1382 → 1385 → 1391 → 1392 → 1425 → 1426 → 1445 → 1457 with 123 → 123 → 124 → 125 → 126 → 126 → 126 → 126 → 127 → 127 files, DB 117 → 121 at Task 10, typecheck 0 at every task, every mutation check reverted to the expected status). Plan check: every file and every bash block of this document was then executed in document order, mechanically extracted from this file (worktree path replaced), in a fresh scratch clone of `codex/mvp-platform` at `9014587` with pushing disabled; every patch applied, every RED and GREEN count, the mutation checks with their reverted status, every typecheck and the Task 11 gate came out exactly as quoted above (10 commits, empty status, all five P09 patches applicable), and the resulting `git diff 9014587 HEAD` equals that of the measured implementation byte for byte. The adversarial plan check then pinned the app-row lock of Task 5 (the race test records each transaction's statements; Step 5 deletes the lock and the test fails, no test count changes; Task 6's hunk of the PGlite spec was regenerated for the new context), checked every hunk of the mutation patches of Tasks 2-4 on its own (each fails exactly the test it pins), and replayed the whole document again in a fresh clone of `9014587`: every count, mutation check, typecheck and the Task 11 gate came out as quoted. Every bash block starts with an absolute `cd`; no step deletes a file; no step reads `.env*`, `.secrets/` or `.npmrc`; no step can reach a network database (PGlite in process, `drizzle-kit` with a placeholder URL).

**Type consistency:** done. `ReportedToolPolicy` (now with `description`) has one reader, `reportedToolPolicy(tool)`, used by the save, publication, policy drafting and the capability view; `decisionDeviations` decides what is stored (`deviates` plus `holdsStoredRestriction`), and `boundToolOverride` signs every in-bounds restriction it is given, so every stored restriction is signed (pinned by "signs every restriction a save keeps, over the same code"); only description and no-op copies on pre-P08d rows are stored but unsigned until the next save prunes them. `DecideToolOverrideInput<T>`/`ToolOverrideDecision<T>` are declared once in `runtime-setup-v2.store.ts` and used by the Drizzle store, the service and both service-spec mocks; `override: ToolOverrideFields | null` is the only way a decision is removed. `PolicyRevisionDraft` is the return type of both `draft` and `carry`; `Signing` is the one rule for "which revision signs these decisions over this configuration", shared by `target` and `carry`. `currentConfigurationApply` is the one reader of attempt identities, used by the apply and both overview checks; `configurationApplyAttemptId(…, 0)` equals `configurationApplyId`. `createMigratedDatabase`/`seedApp`/`SeededApp` are defined once and used by both API PGlite suites (the DB package keeps its own `@electric-sql/pglite` setup).
