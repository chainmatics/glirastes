# Glirastes Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the managed-local Glirastes runtime, its control-plane revision
model, and a complete Get It Done migration without the old Agentic packages.

**Architecture:** One public `glirastes` package provides neutral contracts,
local runtime, AI-SDK engine, React/STT, framework adapters, and sync. The
Platform publishes signed immutable revisions and receives only content-free
technical metadata. Get It Done migrates through a temporary v2 seam.

**Tech Stack:** TypeScript, Zod 4, Vercel AI SDK 6, React 19, Next.js 16,
NestJS 11, Drizzle/PostgreSQL, Bun, Vitest, Playwright.

---

## Execution order

The phases are sequential. Tasks inside a phase may only overlap when they do
not share public contracts or schema.

### Task 1: Freeze the cross-repository baseline

**Repositories:** Get It Done, Glirastes SDK, Glirastes Platform

**Evidence:**
- Get It Done: `bun run test`, `bun run build`
- SDK: `bun run typecheck && bun run test && bun run build`
- Platform: `bun run test`, `bun run build`

**Steps:**
1. Record production source SHA, package versions, test counts, build results,
   and the unresolved runtime-image proof in the design.
2. Correct only demonstrably stale baseline tests.
3. Re-run all baseline commands.
4. Commit baseline corrections separately in their repositories.

### Task 2: Add framework-neutral contracts

**Repository:** Glirastes SDK

**Files:**
- Create: `src/contracts/runtime.ts`
- Create: `src/contracts/revisions.ts`
- Create: `src/contracts/events.ts`
- Create: `src/contracts/index.ts`
- Create: `src/contracts/__tests__/runtime.test.ts`
- Create: `src/contracts/__tests__/revisions.test.ts`
- Modify: `package.json`
- Modify: `scripts/generate-subpath-shims.mjs`

**RED:**
1. Add tests that reject mutable/missing revision IDs, invalid environment
   bindings, unbounded budgets, invalid principal values, and revision payloads
   containing secret values.
2. Add tests that accept content-free technical events and reject prompts,
   arguments, results, cookies, and tokens.
3. Run:
   `bunx vitest run src/contracts/__tests__/runtime.test.ts src/contracts/__tests__/revisions.test.ts`
   and verify the missing modules fail.

**GREEN:**
4. Implement Zod schemas and inferred types for environments, principals,
   bindings, budgets, tool manifests, agent revisions, runtime policies,
   revocations, leases, and technical events.
5. Export `glirastes/contracts` in ESM and CJS.
6. Re-run focused tests, typecheck, full tests, and build.
7. Commit `feat(contracts): add managed-local runtime contracts`.

### Task 3: Pin and enforce a local turn snapshot

**Repository:** Glirastes SDK

**Files:**
- Create: `src/runtime/turn-snapshot.ts`
- Create: `src/runtime/authorization.ts`
- Create: `src/runtime/budget.ts`
- Create: `src/runtime/fingerprint.ts`
- Create: `src/runtime/index.ts`
- Create: `src/runtime/__tests__/turn-snapshot.test.ts`
- Create: `src/runtime/__tests__/authorization.test.ts`
- Create: `src/runtime/__tests__/budget.test.ts`
- Modify: `package.json`

**RED:**
1. Test that a turn retains one normal revision despite a cache update.
2. Test that a security revocation blocks the next tool call.
3. Test effective permission intersection and fail-closed missing principal.
4. Test every budget dimension, the 80 percent signal, hard stop, bounded final
   summary, error breaker, and normalized fingerprint loop detection.
5. Verify focused tests fail for missing runtime modules.

**GREEN:**
6. Implement immutable snapshot creation and a `beforeToolCall` guard.
7. Implement local-max versus stricter-policy budget merging.
8. Implement deterministic JSON normalization and SHA-256 fingerprints.
9. Export `glirastes/runtime`; run all SDK gates.
10. Commit `feat(runtime): enforce pinned turns and execution budgets`.

### Task 4: Define the engine and AI-SDK adapter

**Repository:** Glirastes SDK

**Files:**
- Create: `src/runtime/engine.ts`
- Create: `src/runtime/ai-sdk/index.ts`
- Create: `src/runtime/ai-sdk/engine.ts`
- Create: `src/runtime/ai-sdk/__tests__/engine.test.ts`
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.ts`
- Modify: `package.json`

**RED:**
1. Specify engine-neutral run, step, tool, approval, checkpoint, and completion
   events.
2. Test that the AI-SDK adapter checks the snapshot before every tool call and
   emits content-free technical events.
3. Test cancellation, tool timeout, budget stop, and final-summary behavior.

**GREEN:**
4. Implement the neutral engine interface and AI SDK 6 adapter.
5. Make the existing Next.js handler delegate through the adapter without
   changing existing public behavior.
6. Export `glirastes/runtime/ai-sdk`; run SDK gates.
7. Commit `feat(runtime): add AI SDK reference engine`.

### Task 5: Replace voice internals with provider-neutral STT

**Repository:** Glirastes SDK

**Files:**
- Create: `src/react/stt/controller.ts`
- Create: `src/react/stt/segments.ts`
- Create: `src/react/stt/provider.ts`
- Create: `src/react/stt/deepgram.ts`
- Create: `src/react/stt/use-stt.ts`
- Create: `src/react/stt/__tests__/controller.test.ts`
- Create: `src/react/stt/__tests__/segments.test.ts`
- Modify: `src/react/components/voice-input-addon.tsx`
- Modify: `src/react/components/recording-bar.tsx`
- Modify: `src/react/index.ts`

**RED:**
1. Test the complete state transition table.
2. Test interim replacement, final segment commit, duplicate suppression,
   delayed finalization, cancel draft restoration, retry, and idempotent
   cleanup.
3. Test that the waveform consumes the authoritative stream.

**GREEN:**
4. Implement the controller and Deepgram adapter.
5. Replace `useDeepgramTranscription` internals with a compatibility wrapper
   over the new controller.
6. Render live interim text and distinct stop/cancel behavior.
7. Run React tests, SDK tests/build, and commit.

### Task 6: Add immutable control-plane schema

**Repository:** Glirastes Platform

**Files:**
- Create: `packages/db/src/schema/runtime-environments.ts`
- Create: `packages/db/src/schema/tools.ts`
- Create: `packages/db/src/schema/manifest-revisions.ts`
- Create: `packages/db/src/schema/agent-revisions.ts`
- Create: `packages/db/src/schema/runtime-policy-revisions.ts`
- Create: `packages/db/src/schema/runtime-deployments.ts`
- Create: `packages/db/src/schema/runtime-runners.ts`
- Create: `packages/db/src/schema/execution-leases.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/__tests__/schema.test.ts`
- Generate: `packages/db/drizzle/<generated migration>.sql`

**RED:**
1. Add schema tests for tenant/app/environment isolation, immutable revision
   identity, tool UUID/fingerprint/tombstone fields, deployment state, runner
   health, and leases.
2. Verify the schema tests fail before tables exist.

**GREEN:**
3. Implement tables, indexes, foreign keys, and uniqueness constraints.
4. Generate a migration; inspect SQL for destructive operations.
5. Run DB tests/build and platform build.
6. Commit `feat(db): add immutable runtime revision model`.

### Task 7: Publish, sign, and deliver revisions

**Repository:** Glirastes Platform

**Files:**
- Create: `apps/api/src/modules/runtime-revisions/*`
- Create: `apps/api/src/modules/runtime-connections/*`
- Modify: `apps/api/src/app.module.ts`
- Add tests beside both modules.

**RED:**
1. Test draft versus published immutability, publisher/security approval,
   signature verification data, environment promotion, rollback, tenant
   isolation, push delivery, polling fallback, revocation, and content-free
   metadata validation.

**GREEN:**
2. Implement revision and runner APIs.
3. Reuse existing auth, audit, stream, and approval services through explicit
   interfaces.
4. Run API tests and full platform build; commit by module.

### Task 8: Add local sync and last-known-good cache

**Repository:** Glirastes SDK

**Files:**
- Create: `src/sync/client.ts`
- Create: `src/sync/cache.ts`
- Create: `src/sync/signatures.ts`
- Create: `src/sync/__tests__/*`
- Modify: `package.json`

**RED/GREEN:**
1. Test signature failure, atomic activation, turn boundary activation,
   last-known-good, polling fallback, immediate revocation, reconciliation, and
   content-free outbound metadata.
2. Implement minimal client/cache and export `glirastes/sync`.
3. Run SDK gates and commit.

### Task 9: Introduce Get It Done v2

**Repository:** Get It Done

**Files:**
- Create: `src/app/api/ai/chat-v2/route.ts`
- Create: `src/lib/glirastes/runtime.ts`
- Create: `src/lib/glirastes/principal.ts`
- Create: `src/lib/glirastes/bindings.ts`
- Create: `src/components/ai/glirastes-chat-wrapper.tsx`
- Add tests under `src/__tests__/lib/glirastes/` and `src/__tests__/components/`.

**RED:**
1. Test verified principal derivation, tenant isolation, local bindings,
   fail-closed behavior, v1/v2 tool parity, approvals, session projection, and
   no content-bearing platform fetch.
2. Add component tests for preserved mentions, suggestions, sessions, tool
   results, live STT, stop, and cancel.

**GREEN:**
3. Add `GLIRASTES_V2_ENABLED`; keep v1 as rollback path.
4. Integrate the local runtime and current React UI.
5. Run full tests/build and authenticated browser smoke tests.
6. Commit v2 route, runtime, and UI separately.

### Task 10: Scan-driven integration

**Repositories:** SDK, Platform, Get It Done fixture

**Steps:**
1. Add a deterministic local scanner fixture for Get It Done routes without
   reading `ai-tool.ts`.
2. Produce fingerprints and a local manifest.
3. Add semantic draft and interviewer APIs/UI to Platform.
4. Sync approved generated bindings back to the fixture.
5. Automate the under-five-minute path and record elapsed time.

### Task 11: Cut over and remove the old family

**Repository:** Get It Done

**Steps:**
1. Run behavior, visual, STT, security, privacy, performance, and rollback
   comparisons.
2. Make v2 the default while retaining one tested rollback revision.
3. Remove all `@chainmatics/agentic-*` dependencies, imports, generated output,
   old endpoint, and obsolete compatibility code.
4. Re-run all Get It Done and cross-repository gates.
5. Commit `refactor(ai)!: complete Glirastes runtime migration`.

### Task 12: Completion audit

1. Map every goal requirement to current evidence.
2. Verify exact deployment/image revision and rollback.
3. Confirm no old package/import/runtime path remains.
4. Confirm no content egress in normal turns.
5. Record test counts, performance, bundle, browser, STT, integration-time, and
   migration evidence.
6. Do not merge, publish, push, or deploy without explicit authorization.
