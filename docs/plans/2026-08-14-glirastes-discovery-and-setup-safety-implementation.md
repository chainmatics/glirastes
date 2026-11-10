# Glirastes Discovery and Setup Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add hybrid local tool discovery, read-only atomic setup planning, monotone semantic changes, stable diagnostics, and one signed semantic registry for runtime routing and UI presentation.

**Architecture:** The SDK owns the shared contracts and deterministic behavior. A turn-pinned discovery index is built from the already materialized registry and signed manifest semantics; the existing module router supplies the initial active tools and `find_tools` can expand that set on the next AI SDK step without granting authority. Setup computes one immutable plan for dry-run and apply, and writes local artifacts through an atomic staged replacement only after all validation succeeds. Get It Done consumes the artifact directly; Platform transports the additive presentation fields through its existing content-free revision pipeline.

**Tech Stack:** TypeScript, Bun, Vitest, Vercel AI SDK 6, Zod, Next.js, NestJS, React.

---

### Task 1: Add stable Foundation diagnostics

**Files:**
- Create: `src/diagnostics/foundation-diagnostic.ts`
- Create: `src/diagnostics/foundation-diagnostic.test.ts`
- Create: `src/diagnostics/index.ts`
- Modify: `src/index.ts`
- Modify: `src/cli/bin.ts`
- Modify: `src/cli/index.ts`
- Test: `src/cli/validate-build.test.ts`
- Test: `src/cli/setup.test.ts`

**Step 1: Write the failing contract tests**

Cover a strict diagnostic shape:

```ts
type FoundationDiagnosticCode =
  | `E-SETUP-${string}`
  | `E-INVENTORY-${string}`
  | `E-SEMANTICS-${string}`
  | `E-BINDING-${string}`
  | `E-SIGNATURE-${string}`
  | `E-SCOPE-${string}`;

type FoundationDiagnosticJson = {
  schemaVersion: 1;
  code: FoundationDiagnosticCode;
  operation: string;
  message: string;
  remediation: string;
  path?: string;
  identifier?: string;
};
```

Assert that cause, stack, response body, prompt, source, argument, result,
credential, and arbitrary metadata cannot enter `toJSON()`.

**Step 2: Verify RED**

Run:

```bash
bunx vitest run src/diagnostics/foundation-diagnostic.test.ts src/cli/validate-build.test.ts src/cli/setup.test.ts
```

Expected: FAIL because the diagnostic module and JSON CLI behavior do not
exist.

**Step 3: Implement the minimal typed error and CLI renderer**

Add `FoundationDiagnosticError`, `isFoundationDiagnosticError()`, and
`foundationDiagnosticJson()`. Preserve human-readable CLI output while making
`--json` print exactly one JSON object to stdout and bounded human diagnostics
to stderr only when JSON mode is absent.

Map the existing setup/validate errors needed by later tasks to stable codes;
do not attempt a repository-wide error rewrite.

**Step 4: Verify GREEN**

Run the focused command from Step 2, then:

```bash
bunx tsc --noEmit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/diagnostics src/index.ts src/cli
git commit -m "feat(cli): add stable foundation diagnostics"
```

### Task 2: Extend curated semantics with presentation metadata

**Files:**
- Modify: `src/contracts/app-setup.ts`
- Modify: `src/contracts/revisions.ts`
- Modify: `src/contracts/__tests__/app-setup.test.ts`
- Modify: `src/contracts/__tests__/revisions.test.ts`
- Modify: `src/runtime/local-runtime-source.ts`
- Modify: `src/runtime/__tests__/local-runtime-source.test.ts`

**Step 1: Write failing schema and materialization tests**

Add an optional additive field that historical artifacts may omit:

```ts
presentation: {
  locale: string;
  singular: string;
  plural: string;
  approval: string;
}
```

Require it in `assertAppSetupSemanticParity()` for newly generated enabled
tools, bound each string, and reject unknown properties. Prove Standalone
materialization copies it into the manifest exactly.

**Step 2: Verify RED**

```bash
bunx vitest run src/contracts/__tests__/app-setup.test.ts src/contracts/__tests__/revisions.test.ts src/runtime/__tests__/local-runtime-source.test.ts
```

Expected: FAIL on the missing presentation contract.

**Step 3: Implement the minimal additive contract**

Keep base schemas backward-readable. Enforce presentation completeness only
through the strong parity gate used by new setup/build/Standalone paths.

**Step 4: Verify GREEN**

Run the focused tests and `bunx tsc --noEmit`.

**Step 5: Commit**

```bash
git add src/contracts src/runtime/local-runtime-source.ts src/runtime/__tests__/local-runtime-source.test.ts
git commit -m "feat(runtime): carry tool presentation semantics"
```

### Task 3: Add monotone semantic comparison

**Files:**
- Create: `src/contracts/semantic-change.ts`
- Create: `src/contracts/__tests__/semantic-change.test.ts`
- Modify: `src/contracts/index.ts`
- Modify: `src/diagnostics/foundation-diagnostic.ts`

**Step 1: Write failing comparison tests**

Cover independently:

- enabled to disabled is `hardening`;
- approval false to true is `hardening`;
- risk increases are `hardening`;
- allowed-role narrowing is `hardening`;
- description, module, sharing, usage hints, model name, and presentation-only
  changes are `neutral`;
- disabled to enabled, approval removal, risk lowering, and role widening are
  `loosening`;
- incomparable or unknown risk transitions throw
  `E-SEMANTICS-003` rather than becoming neutral.

The result shape is deterministic:

```ts
type SemanticChange = {
  toolId: string;
  classification: 'unchanged' | 'hardening' | 'neutral' | 'loosening';
  fields: string[];
  requiresConfirmation: boolean;
};
```

**Step 2: Verify RED**

```bash
bunx vitest run src/contracts/__tests__/semantic-change.test.ts
```

**Step 3: Implement minimal field-by-field comparison**

Use an explicit risk-order table. Do not infer authorization impact from field
names dynamically.

**Step 4: Verify GREEN**

Run the focused test and all contract tests:

```bash
bunx vitest run src/contracts/__tests__
```

**Step 5: Commit**

```bash
git add src/contracts src/diagnostics
git commit -m "feat(semantics): classify monotone tool changes"
```

### Task 4: Implement immutable setup plans and dry-run

**Files:**
- Create: `src/cli/commands/setup-plan.ts`
- Create: `src/cli/commands/setup-plan.test.ts`
- Create: `src/cli/commands/atomic-artifact-write.ts`
- Create: `src/cli/commands/atomic-artifact-write.test.ts`
- Modify: `src/cli/commands/setup-wizard.ts`
- Modify: `src/cli/commands/setup-wizard.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/setup.test.ts`

**Step 1: Write the failing plan tests**

Prove:

- `setup --dry-run` and `setup --dry-run --json` never call write, install,
  sync, or network dependencies;
- a plan contains bounded paths, digests, counts, operation kinds,
  diagnostics, semantic classifications, and confirmation requirements;
- source, schemas, prompts, arguments, results, credentials, and arbitrary
  assessment content are absent;
- two runs over identical inputs are byte-identical;
- the normal setup path consumes the exact plan digest produced by dry-run;
- a loosening without explicit confirmation fails with `E-SEMANTICS-004`;
- `--confirm-loosening` is rejected in non-interactive use unless the plan
  digest is also supplied, preventing blind approval of a changed plan.

**Step 2: Verify RED**

```bash
bunx vitest run src/cli/commands/setup-plan.test.ts src/cli/commands/setup-wizard.test.ts src/cli/setup.test.ts
```

**Step 3: Implement one planner used by both modes**

`createSetupPlan()` performs discovery, artifact parsing, semantic parity,
semantic diff, and diagnostic collection in memory. The normal wizard may
render or confirm the result, but cannot recompute a different operation list
after confirmation.

**Step 4: Write failing atomic-write tests**

Use a temporary workspace with three tracked artifacts. Inject a failure
between staging and replacement and prove every original byte remains. Prove
success replaces the complete set and leaves no staging files.

**Step 5: Verify the second RED**

```bash
bunx vitest run src/cli/commands/atomic-artifact-write.test.ts
```

**Step 6: Implement atomic staged replacement**

Write same-directory temporary files with restrictive permissions, fsync and
rename only after all staging succeeds, preserve recoverable originals until
commit completes, and clean staging paths on failure. Never use an unresolved
glob or broad directory deletion.

**Step 7: Verify GREEN**

Run all Task 4 tests plus:

```bash
bunx tsc --noEmit
```

**Step 8: Commit**

```bash
git add src/cli
git commit -m "feat(setup): add atomic dry-run planning"
```

### Task 5: Build a turn-pinned discovery index

**Files:**
- Create: `src/runtime/tool-discovery.ts`
- Create: `src/runtime/__tests__/tool-discovery.test.ts`
- Modify: `src/runtime/index.ts`
- Modify: `src/runtime/local-tool-bindings.ts`
- Modify: `src/runtime/__tests__/source-parity.test.ts`
- Modify: `src/runtime/__tests__/standalone-network-silence.test.ts`

**Step 1: Write failing deterministic-search tests**

Prove name-token matches rank before substrings, name before description,
then module/shared membership and usage hints, with model-facing name as the
stable tie-break. Cap query length, result count, and result string sizes.

Prove the index contains only tools that survived manifest enabled/tombstone,
agent allowlist, policy enabled/risk parity, role eligibility, and local
binding parity. Include no input/output schema or executor reference in a
search result.

**Step 2: Verify RED**

```bash
bunx vitest run src/runtime/__tests__/tool-discovery.test.ts
```

**Step 3: Implement `createTurnToolDiscovery()`**

Accept the immutable `TurnSnapshot`, materialized registry, and bounded search
options. Build once per turn snapshot. Return frozen results containing only
`name`, `description`, `module`, `usageHints`, and presentation.

**Step 4: Add parity and network-silence tests**

Equivalent Standalone and Managed snapshots must produce identical search
results. Boot, index creation, search, activation bookkeeping, guard, and local
execution must perform zero `fetch` calls in Standalone.

**Step 5: Verify GREEN**

```bash
bunx vitest run src/runtime/__tests__/tool-discovery.test.ts src/runtime/__tests__/source-parity.test.ts src/runtime/__tests__/standalone-network-silence.test.ts
```

**Step 6: Commit**

```bash
git add src/runtime
git commit -m "feat(runtime): add pinned local tool discovery"
```

### Task 6: Integrate hybrid discovery with the AI SDK adapter

**Files:**
- Create: `src/server/adapters/nextjs/tool-discovery.ts`
- Create: `src/server/adapters/nextjs/tool-discovery.test.ts`
- Modify: `src/server/adapters/nextjs/types.ts`
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.ts`
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.test.ts`
- Modify: `src/server/adapters/nextjs/index.ts`

**Step 1: Write failing hybrid-flow tests**

Use the real default stream path with a controlled AI SDK model. Prove:

- the pipeline-selected tools plus `find_tools` are active on step one;
- `find_tools` returns only bounded eligible matches;
- matched tools become active on the next step via `prepareStep`;
- a requested unknown, disabled, revoked, role-ineligible, or out-of-revision
  name is never activated;
- calling discovery does not invoke a local domain binding;
- executing a discovered tool still passes the existing managed-turn guard;
- loaded tools do not leak into a second turn or resumed turn with a different
  pinned digest;
- custom stream handlers receive the immutable discovery controller or can
  explicitly disable discovery rather than silently receiving different
  security behavior.

**Step 2: Verify RED**

```bash
bunx vitest run src/server/adapters/nextjs/tool-discovery.test.ts src/server/adapters/nextjs/create-ai-chat-handler.test.ts
```

**Step 3: Implement the minimal adapter integration**

Keep the full tool object server-side. Pass only the active name set through
AI SDK `activeTools`. The local `find_tools` executor records exact names from
its own bounded search result; `prepareStep` reads that turn-local set for the
next step. Do not accept model-supplied tool descriptors or schemas.

**Step 4: Verify GREEN**

Run the focused tests, all Next.js adapter tests, typecheck, and build:

```bash
bunx vitest run src/server/adapters/nextjs
bunx tsc --noEmit
bun run build
```

**Step 5: Commit**

```bash
git add src/server/adapters/nextjs
git commit -m "feat(ai-sdk): add hybrid tool discovery"
```

### Task 7: Carry presentation through Platform revisions

**Worktree:** `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1`

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/app-setup.dto.ts`
- Modify: `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts`
- Modify: `apps/api/src/modules/runtime-setup-v2/__tests__/tool-override.spec.ts`
- Modify: `apps/api/src/modules/runtime-revisions/app-configuration.service.ts`
- Modify: `apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts`
- Modify: `apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts`
- Modify: `apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts`
- Modify: `apps/citadel/src/components/runtime-setup/tool-group.tsx`
- Modify: `apps/citadel/src/components/runtime-setup/runtime-setup-dashboard.test.tsx`

**Step 1: Write failing transport and revision tests**

Prove presentation is validated, stored only as bounded semantic metadata,
copied into tool revision payloads and derived manifests, signed as part of
the existing canonical payload, and rendered by Citadel without accepting
source, prompt, schema, credential, argument, or result content.

**Step 2: Verify RED**

```bash
cd apps/api
bunx vitest run src/modules/runtime-setup-v2 src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
```

**Step 3: Implement the additive propagation**

No new table or migration is expected because revision and setup payloads are
already JSON-backed. Preserve historical artifact readability and require the
new field only for newly synchronized strong-parity artifacts.

**Step 4: Verify GREEN**

Run focused API tests, Citadel focused tests, API build, Citadel typecheck.

**Step 5: Commit**

```bash
git add apps/api/src/modules/runtime-setup-v2 apps/api/src/modules/runtime-revisions apps/api/src/modules/runtime-deployments apps/citadel/src/components/runtime-setup
git commit -m "feat(runtime): publish tool presentation semantics"
```

### Task 8: Make Get It Done consume one semantic registry

**Worktree:** `/Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot`

**Files:**
- Modify: `.glirastes/tool-semantics.json`
- Modify: `scripts/glirastes-assess-setup.ts`
- Modify: `src/lib/ai/module-definitions.ts`
- Modify: `src/generated/ai-tools/modules.generated.ts`
- Modify: `src/lib/ai/approval-description.ts`
- Modify: `src/components/ai/chat-wrapper.tsx`
- Modify: `src/lib/glirastes/chat-handler.ts`
- Modify: `src/__tests__/lib/ai/module-tools.test.ts`
- Create: `src/__tests__/lib/ai/tool-presentation.test.ts`
- Modify: `src/__tests__/components/chat-wrapper-stt.test.tsx`
- Modify: `src/__tests__/lib/glirastes/chat-handler.test.ts`

**Step 1: Write failing artifact-parity tests**

Prove all 93 executions have complete presentation, every runtime module
membership and related-module relationship is derived from the semantic
artifact, every UI label/approval description comes from the same artifact,
and `modules.generated.ts` contains module type/configuration data but no
independently maintained tool-membership arrays.

Preserve the intentionally dirty
`.glirastes/platform-tool-bindings.json` byte-for-byte.

**Step 2: Verify RED**

```bash
bunx vitest run src/__tests__/lib/ai/module-tools.test.ts src/__tests__/lib/ai/tool-presentation.test.ts src/__tests__/components/chat-wrapper-stt.test.tsx
```

**Step 3: Migrate the existing curated German labels without data loss**

Move every existing singular/plural label and approval text into the matching
semantic entry. Use the definition identity/model name mapping and fail on
missing, duplicate, or orphaned entries; do not fall back silently.

**Step 4: Wire hybrid discovery**

Enable SDK discovery on `createGetItDoneChatHandler()`. The existing local
pipeline remains initial routing. Add an integration test in both Standalone
and Managed fixture modes proving a misclassified or cross-module request can
discover and execute an allowed real binding while unauthorized tools remain
unavailable.

**Step 5: Verify GREEN**

Run the focused tests, then:

```bash
bunx tsc --noEmit
bun run build
bun run glirastes:verify-foundation
```

**Step 6: Commit**

```bash
git add .glirastes/tool-semantics.json scripts/glirastes-assess-setup.ts src/lib/ai src/lib/glirastes src/components/ai src/generated/ai-tools/modules.generated.ts src/__tests__
git commit -m "feat(glirastes): adopt hybrid semantic discovery"
```

### Task 9: Verify setup dry-run against Get It Done

**Files:**
- Modify: `scripts/glirastes-cli.ts`
- Modify: `scripts/glirastes-validate.ts`
- Create: `src/__tests__/scripts/glirastes-setup-dry-run.test.ts`
- Modify: `package.json`

**Step 1: Write the failing consumer test**

Snapshot hashes and bytes for every tracked `.glirastes` artifact, run
`glirastes setup --dry-run --json`, and prove all bytes and Git status are
unchanged. Assert the plan has 93 executions, no prohibited content, a stable
digest, and no remote sync call.

**Step 2: Verify RED**

```bash
bunx vitest run src/__tests__/scripts/glirastes-setup-dry-run.test.ts
```

**Step 3: Add the consumer command and minimal wrappers**

Expose `bun run glirastes:setup:check` without adding a second planning
implementation.

**Step 4: Verify GREEN**

Run the focused test twice and compare output digests.

**Step 5: Commit**

```bash
git add package.json scripts src/__tests__/scripts/glirastes-setup-dry-run.test.ts
git commit -m "test(glirastes): prove setup dry-run is read-only"
```

### Task 10: Full verification, documentation, and evidence

**Files:**
- Modify: SDK `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md` only if a local copy exists; otherwise update the canonical Platform path below
- Modify: Platform `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md`
- Modify: SDK `README.md`
- Modify: relevant CLI/runtime documentation discovered during implementation

**Step 1: Run complete SDK verification**

```bash
bun run test
bunx tsc --noEmit
bun run build
git diff --check
```

Run the existing package and secret audits used by the Foundation worktree.

**Step 2: Run complete Get It Done verification**

```bash
bun run test
bunx tsc --noEmit
bun run build
bun run glirastes:verify-foundation
git diff --check
```

Run the existing secret-pattern audit and confirm the preserved dirty Platform
binding artifact remains the only unrelated change.

**Step 3: Run complete Platform verification**

Run DB tests/build, API full suite/build, Citadel full suite/typecheck/build,
and the existing whitespace and secret audits. Record exact fresh counts.

**Step 4: Measure the behavior**

Record initial active tool count, discovery result count, next-step active
count, prompt/tool-definition character or token estimate, and verify zero
additional Platform request during Standalone and normal Managed turns.

**Step 5: Update the canonical working document**

Append current Git heads, RED/GREEN evidence, full-suite counts, dry-run byte
identity, discovery measurements, security invariants, and remaining browser
gates. Add the approved positioning: Glirastes operates and governs agents in
enterprise applications and SaaS products.

**Step 6: Commit documentation separately**

SDK documentation commit:

```bash
git add README.md docs
git commit -m "docs(runtime): document governed SaaS discovery"
```

Platform working-document commit:

```bash
git add docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
git commit -m "docs(foundation): record discovery and setup evidence"
```

Do not push, merge, release, publish a package, create another worktree, create
an environment, or deploy to production.
