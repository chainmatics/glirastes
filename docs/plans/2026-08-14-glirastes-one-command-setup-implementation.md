# Glirastes One-Command Setup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the existing Foundation setup pieces into a safe, deterministic `setup --dry-run`, `setup`, and `doctor` flow that needs no repeated flags for an already integrated application.

**Architecture:** A shared local project-profile detector resolves framework, declared principal wiring, app identity, artifacts, and explicit runtime mode. Planning, applying, and Doctor consume that same profile. Apply renders every output in memory and commits the complete `.glirastes` artifact set through the existing atomic writer; Managed sync remains an explicit final step.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Vitest, existing Glirastes Foundation contracts and CLI.

---

### Task 1: Detect one bounded project profile

**Files:**
- Create: `src/cli/commands/setup-profile.ts`
- Create: `src/cli/commands/setup-profile.test.ts`
- Modify: `src/cli/commands/installer-parts.ts`

**Step 1: Write the failing tests**

Cover Next.js and supported auth package markers, declared server principal
wiring, setup-artifact auto-resolution, app identity from validated local
artifacts, Standalone default, explicit Managed mode, conflicting identities,
ambiguous artifact candidates, bounded relative paths, and absence of secret
values in the returned profile.

**Step 2: Verify RED**

Run:

```bash
bunx vitest run src/cli/commands/setup-profile.test.ts
```

Expected: failure because `detectSetupProfile` does not exist.

**Step 3: Implement the minimal detector**

Reuse `detectStack`; read `package.json`, inventory, setup artifact, and prompt
bundle through strict schemas. Treat `package.json.glirastes.principal` as a
declaration only, never proof derived from a client field. Resolve Managed only
from the command's explicit `managed` option.

**Step 4: Verify GREEN**

Run the focused test and `bunx tsc --noEmit`.

**Step 5: Commit**

```bash
git add src/cli/commands/setup-profile.ts src/cli/commands/setup-profile.test.ts src/cli/commands/installer-parts.ts
git commit -m "feat(setup): detect bounded local project profiles"
```

### Task 2: Plan the exact local transaction

**Files:**
- Modify: `src/cli/commands/setup-plan.ts`
- Modify: `src/cli/commands/setup-plan.test.ts`
- Modify: `src/cli/setup.test.ts`

**Step 1: Write the failing tests**

Prove that no-flag artifact/app detection works, Standalone plans contain only
local validate/adopt/build/receipt operations, explicit Managed adds sync,
dry-run performs no writes or network calls, repeated plans are byte-identical,
and exact-digest confirmation remains mandatory for loosening.

**Step 2: Verify RED**

```bash
bunx vitest run src/cli/commands/setup-plan.test.ts src/cli/setup.test.ts
```

**Step 3: Extend the planner minimally**

Accept a detected profile and emit versioned bounded operation records. Keep
semantic comparison and confirmation unchanged. Do not include prompt, schema,
source, credential, argument, result, or transcript content.

**Step 4: Verify GREEN and commit**

Run focused tests and typecheck, then commit:

```bash
git add src/cli/commands/setup-plan.ts src/cli/commands/setup-plan.test.ts src/cli/setup.test.ts
git commit -m "feat(setup): plan one-command artifact adoption"
```

### Task 3: Apply the plan atomically

**Files:**
- Create: `src/cli/commands/apply-setup-plan.ts`
- Create: `src/cli/commands/apply-setup-plan.test.ts`
- Modify: `src/cli/commands/validate-build.ts`
- Modify: `src/cli/commands/validate-build.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/setup.test.ts`

**Step 1: Write failing pure-render and transaction tests**

Require manifest rendering without writes, canonical setup adoption, previous
artifact preservation, bounded receipt output, identical plan digest use,
successful no-network Standalone apply, and complete rollback after an injected
mid-replacement failure.

**Step 2: Verify RED**

```bash
bunx vitest run src/cli/commands/apply-setup-plan.test.ts src/cli/commands/validate-build.test.ts src/cli/setup.test.ts
```

**Step 3: Implement minimal apply**

Extract a pure manifest renderer from `buildManifests`. Render canonical setup,
previous baseline when applicable, both manifests, and the receipt in memory;
then call `writeArtifactSetAtomically` once. Normal `setup` computes one plan,
checks confirmation, applies locally, and only then invokes existing app-scoped
sync when `--managed` is explicit.

**Step 4: Verify GREEN and commit**

Run focused tests and typecheck, then commit:

```bash
git add src/cli/commands/apply-setup-plan.ts src/cli/commands/apply-setup-plan.test.ts src/cli/commands/validate-build.ts src/cli/commands/validate-build.test.ts src/cli/index.ts src/cli/setup.test.ts
git commit -m "feat(setup): apply local artifacts atomically"
```

### Task 4: Add a stable read-only Doctor

**Files:**
- Create: `src/cli/commands/doctor.ts`
- Create: `src/cli/commands/doctor.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/bin.ts`
- Modify: `src/diagnostics/foundation-diagnostic.ts`
- Modify: `src/diagnostics/foundation-diagnostic.test.ts`

**Step 1: Write failing Doctor tests**

Cover deterministic text/JSON, pass/warn/fail checks, non-zero failure,
framework detection, identity/parity/fingerprint/prompt/build/receipt checks,
missing declared principal wiring, inconsistent Managed configuration, zero
writes, zero network calls, and raw exception/secret suppression.

**Step 2: Verify RED**

```bash
bunx vitest run src/cli/commands/doctor.test.ts src/diagnostics/foundation-diagnostic.test.ts
```

**Step 3: Implement the report and CLI command**

Add `doctor` to parsing and usage. Produce a schema-versioned bounded report;
print it before throwing one stable aggregate diagnostic when any required
check fails. Doctor remains local even with `--managed`.

**Step 4: Verify GREEN and commit**

Run focused tests and typecheck, then commit:

```bash
git add src/cli src/diagnostics
git commit -m "feat(cli): add fail-closed setup doctor"
```

### Task 5: Prove the zero-flag flow in Get It Done

**Files:**
- Modify: Get It Done `package.json`
- Modify: Get It Done `src/__tests__/scripts/glirastes-setup-dry-run.test.ts`
- Create: Get It Done `src/__tests__/scripts/glirastes-doctor.test.ts`
- Modify: Get It Done `scripts/glirastes-cli.ts`

**Step 1: Write failing consumer tests**

Run the real SDK CLI with no artifact or app flags. Prove dry-run resolves all
93 tools without mutation, Doctor is green and read-only, Standalone performs
no network call, output is bounded, and the pre-existing dirty Platform binding
artifact remains byte-for-byte unchanged.

**Step 2: Verify RED**

```bash
bunx vitest run src/__tests__/scripts/glirastes-setup-dry-run.test.ts src/__tests__/scripts/glirastes-doctor.test.ts
```

**Step 3: Add the explicit local declarations**

Declare the canonical Glirastes artifact paths and server-verified principal
wiring in `package.json.glirastes`; do not copy semantic data. Add concise setup
and Doctor scripts using the real CLI.

**Step 4: Verify GREEN and commit**

```bash
git add package.json scripts/glirastes-cli.ts src/__tests__/scripts/glirastes-setup-dry-run.test.ts src/__tests__/scripts/glirastes-doctor.test.ts
git commit -m "feat(glirastes): adopt one-command local setup"
```

### Task 6: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: Platform `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md`

**Step 1: Update usage and canonical evidence**

Document Standalone default, explicit `--managed`, exact loosening
confirmation, restart-only activation, Doctor semantics, and the fact that
setup never creates an app or environment.

**Step 2: Run fresh verification**

SDK:

```bash
bun run test
bunx tsc --noEmit
bun run build
git diff --check
```

Get It Done:

```bash
bun run test
bunx tsc --noEmit
bun run build
git diff --check
```

Run bounded secret-literal audits over both change ranges. Confirm SDK and
Platform are clean and Get It Done has only its intentionally preserved
`.glirastes/platform-tool-bindings.json` modification.

**Step 3: Commit documentation separately**

```bash
git add README.md
git commit -m "docs(setup): document one-command bootstrap"
```

Commit the canonical Platform evidence as:

```bash
git add docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
git commit -m "docs(foundation): record one-command setup evidence"
```
