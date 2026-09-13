# Generic Glirastes MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the complete active generic web-app MVP, preserving its functional and usability acceptance gates.

**Architecture:** One local runtime and common integration contracts, thin agent-created app bindings, three independent reference integrations. Platform remains an optional technical control plane. Simple defaults and actionable status reveal advanced detail progressively without weakening execution checks.

**Tech Stack:** Existing TypeScript/Bun/AI-SDK/React SDK; Next.js/NestJS Platform; Get It Done plus separate-backend and non-React/non-TypeScript references.

## Source and scope

The full scope is `2026-09-13-mvp-scope-and-requirements.md` version 1.2. This is a staged execution record, not a replacement or reduced completion definition. Each subsequent implementation batch must expand its exact file/test plan before modifying behavior.

Existing roots:
- SDK: `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1`
- Platform: `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1`
- GID: `/Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot`

Preserve all dirty state. No remote push, main-branch merge, publication or deployment. Additional app work requires isolated checkout preparation, never editing the existing Omnify main checkout. Do not run GID business workers or mutating probes against its business database.

## Requirement workstreams and evidence

| Workstream | Authoritative surface / next evidence | State |
| --- | --- | --- |
| FR-1 agent setup | SDK `src/cli/index.ts`, `src/cli/commands/setup-profile.ts`, `setup-wizard.ts`, shipped skills. Fresh repo without prebuilt artifacts must reach real tool action. | Incomplete: current profile requires pre-existing inventory/setup/prompt files; guided wizard pauses for another agent invocation. |
| FR-2 code changes | SDK `src/codegen/execution-inventory.ts`, `route-exports.ts`, app generators. Add/change/delete endpoint/navigation/filter corpus. | Route syntax recognition exists; automatic binding/semantic regeneration not complete. |
| FR-3 routing/clarification | `src/server/local-pipeline.ts`, `src/runtime/tool-discovery.ts`, Next.js discovery adapter and React interaction. | Focused routing exists; bounded lexical search exists; structured clarification and relevance corpus open. |
| FR-4/5 chat/STT | SDK `src/react`, `src/stt`; reference app wrappers. | Existing components and tests; generic default feature parity and non-React embedding open. |
| FR-6 Platform operations | Platform `apps/citadel/src/components/app-management`, `runtime-setup`, `runtime-deployments`; scoped API services. | Existing pairing/setup/composite publish/health/rollback. Consolidate user flow, not rebuild services. |
| FR-7 metrics | Existing deferred analytics and technical runtime events. | Need end-to-end local runtime attribution and simple Foundation dashboard; do not just enable full legacy profile. |
| FR-8 integrations | GID upstream reconciliation; separate React/backend reference; non-React/non-TS fixture. | GID conflicts known, not reconciled; remaining references not proved. |
| Usability | Five task-based Platform journeys plus installer/recovery; actual novice observation. | Not proved by unit tests or visual polish alone. |
| Release/landing | Matching package/version, bundle, performance, migration/rollback and public claims. | Remains open; no production authority. |

## First bounded implementation: actionable local Doctor

This repairs a directly observed recovery dead end while full integration work remains open. It does not claim to implement one-command onboarding.

### Task 1: Preserve the actual missing-setup diagnosis

**Files:** modify SDK `src/cli/commands/doctor.ts`; test `src/cli/commands/doctor.test.ts`.

1. Add a real temporary Next.js project with no `.glirastes` artifacts.
2. Assert that Doctor fails with `E-SETUP-005` and remediation `create-required-setup-artifact`, rather than collapsing it to generic project repair.
3. Run `bunx vitest run src/cli/commands/doctor.test.ts`; observe the expected assertion failure.
4. Preserve only the typed diagnostic remediation, not raw error/message/path, in the existing report.
5. Re-run the test and assert the project bytes remain unchanged and no network call occurs.

### Task 2: Human-first output with truthful verification scope

**Files:** modify SDK `src/cli/commands/doctor.ts`, `src/cli/index.ts`; add `src/cli/commands/doctor-presentation.ts` and `src/cli/commands/doctor-presentation.test.ts`; extend `src/cli/commands/doctor.test.ts` and `README.md`.

1. Write table-driven tests for missing setup, stale builds, missing principal, mismatched scope and invalid secret storage.
2. Assert one primary next action based on the first failed check, or first warning if no failures. Map known remediation keys to fixed, helpful text; never interpolate unknown diagnostic text.
3. Assert human labels replace raw internal check names/codes by default; `--verbose` retains bounded technical codes, and JSON remains the existing machine contract.
4. Assert Standalone success requests restart, while Connected/Managed success explicitly says the check is offline and does not prove server reachability or activation. Neither claims a live successful tool action.
5. Run the tests RED, implement the formatter and CLI option, run GREEN. Keep underlying validation/auth/connection logic unchanged.

### Task 3: Verify and record

1. Run SDK `bun run typecheck`, `bun run test`, and, only with no relevant watchers, `bun run build`.
2. Exercise the built CLI against a temporary fresh project. Expected: bounded failure with an agent-oriented next action; no generated files or provider call.
3. Check Git diff, whitespace and bounded secret patterns; review the changed code independently.
4. Commit only the logical owned change through the required git-commit skill. Preserve unrelated docs and app binding artifacts.
5. Append exact evidence to this file and the canonical Platform working document. Keep the full Goal active.

## Next batch, not optional follow-up

Specify the shared agent-to-core project assessment / binding contract against actual Next.js, separate-backend and Python fixtures. Reuse existing contracts where possible. Distinguish detected framework from validated support. Resolve the runnable bootstrap path, change trigger and deterministic validation before presenting any new installer as complete. In parallel sequencing, reconcile GID upstream files in its existing pilot without restoring old Agentic dependencies.

### Batch 2A: artifact-free agent intake (implementation specification)

The current `detectSetupProfile` is a validator for already integrated apps, not a fresh-project inspector. Keep that contract and legacy skill selection unchanged. Add a separate local-only intake used through `glirastes setup inspect --json` and later the agent orchestrator. This command does not create executable tools, claim integration or send Platform data.

**Files:** create `src/cli/commands/project-inspection.ts` and `project-inspection.test.ts`; modify `src/cli/index.ts` and `README.md`.

1. Add real temporary-project tests through the existing CLI entry point. Next.js, split React/NestJS and Vue/Python requirements must be recognized without `.glirastes` artifacts. Assert the current CLI fails before implementing.
2. Implement `inspectSetupProject(rootDir)` with a versioned `local-only` report: separate project components, declared frontend/backend/runtime/auth markers and relative manifest evidence. Never infer verified principal, endpoint exposure or official framework support from dependency presence. All results require integration verification.
3. Inspect only `package.json`, `requirements.txt` and presence of `pyproject.toml`, using bounded depth/directory/file-size limits. Ignore hidden/generated/vendor/dependency directories; do not follow symlinks. Python requirements recognition is deliberately limited to direct named requirements; pyproject presence alone never claims a framework. Report malformed/skipped/limited inspection with fixed codes, not raw source/error messages.
4. Add privacy/read-only/security cases: no scripts or `.env` values in output; no network or source execution; linked manifests/directories ignored; malformed JSON and oversized manifest do not become a successful framework detection; separate components never become a fabricated frontend/backend pairing.
5. Wire `setup inspect` before existing setup validation and dry-run handling. JSON is the agent contract; human text explains declared technologies versus integration proof and the safe next action. No change to normal setup, guided setup, sync or runtime mode behavior.
6. Run focused tests RED/GREEN, full SDK tests/typecheck/build, built CLI probes and independent review. Update this record with exact evidence and commit the bounded change.

Subsequent 2B work must consume this intake in the one-command agent bootstrap, correct shipped skills against the confirmed local-first workflow, generate/verify common bindings and complete the three-stack action/change corpus. Do not stop at an inspection-only installer. The reference integrations and GID upstream reconciliation remain mandatory.

## Initial evidence — 2026-09-13

SDK `d697bc7`: typecheck and all 918 tests / 115 files pass. Platform `4e8f807`: Citadel 250 tests / 38 files pass. GID remains `453e17f`, preserving its two scoped-artifact edits; it was not retested in this initial check. No listeners on 3030/3031/3101/8101 at inspection. No live DB, model, browser or microphone proof is inferred from these results.

## Doctor batch completed locally — 2026-09-13

- Implementation commit: `5c49c02` (`fix(cli): make doctor diagnostics actionable and mode-aware`). Tasks 1–3 above are complete for this bounded change.
- TDD: initial 13 failing assertions became green. Independent review identified that repair commands must retain explicit Managed mode; two added regression assertions failed before the fix, then passed. Re-review found no remaining actionable issue in this diff.
- Final focused suite: 24 tests / 2 files passed. Full SDK suite: 934 tests / 116 files passed. SDK typecheck and ESM/CJS build passed; build generated 16 subpath shims.
- Built CLI on a fresh temporary Next.js project returned expected exit 1 with `E-SETUP-005`, an agent-oriented repair action, and explicit offline-check limits. `--managed --verbose` retained Managed mode in the follow-up command. No setup artifacts were created; no provider or Platform call was made.
- GID consumer verification: 966 tests / 58 files passed; local `tsc --noEmit` passed. The repository has no `typecheck` script, so the initially attempted script invocation was replaced with its installed TypeScript binary. No consumer source or scoped connection artifacts changed.
- Owned diff and whitespace reviewed; bounded private-key/token pattern audit found no matches. This is not a substitute for live privacy/security acceptance.
- No push, package publication, deployment, credential change, business database write or server restart occurred. The full goal remains active; the next batch below is required.

## Batch 2A verified locally — 2026-09-13

- Implementation commit: `1e7a08b` (`feat(cli): inspect fresh app stacks for local agent setup`). Agent intake now works before artifacts exist through the real CLI; this is not a completed one-command setup.
- TDD: 10 initial cases failed because the unknown subcommand fell through to Platform configuration. Implemented the isolated local path; expanded to 16 passing cases. The queued-directory symlink replacement was independently reproduced, then fixed with canonical-path rechecks and a real-files regression. The remaining adversarial filesystem race boundary is explicit in README. Review and re-review found no other actionable issue in this bounded change.
- Final SDK verification: 16 focused tests, all 950 tests / 117 files, typecheck and ESM/CJS build passed. Diff/whitespace and bounded secret-pattern checks passed. No package export or runtime authorization changes.
- Real CLI probes: a fresh temporary Next.js project returned local-only declared markers and `needs-integration-verification`; existing GID returned Next.js, React and Entra. Traversal limits are visible without a noisy list in human output; per-path findings remain in JSON. These probes do not prove the three full integrations or a tool action.
- GID's complete 966-test suite was rerun against the rebuilt inspector SDK and passed. No source, connection, inventory or credential changes in GID. The final SDK-only change after that consumer run condensed human inspection text; final SDK tests/build and a built GID inspection were rerun.
- Goal-turn classification: concrete progress (two implemented/verified CLI changes and durable commits), not a wait or blocker. No live API/model/browser/STT acceptance is inferred.

### Next active work: complete bootstrap, not more inspection polish

The missing path is still agent launch/resume → source-derived app binding generation → local validation → actual chat/tool action → build/CI change maintenance. Consume this report as intake, reconcile the shipped skills with the local-first product decision, and prove the flow on all three integration forms. Current shipped Next.js/setup/tool-maintenance skills still contain historical Platform-interviewer/manual-resume requirements; do not use those unchanged as the new automatic workflow. Preserve explicit legacy command behavior rather than treating it as the new default. GID upstream reconciliation, common UI/STT/commands/mentions, Platform UX/metrics, live action, novice observation and release/landing gates remain open.
