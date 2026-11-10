# Focused Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce unnecessary model-visible tool schemas in the Foundation local pipeline without removing legacy behavior or changing authorization.

**Architecture:** A focused router uses the existing module/confidence metadata. Local pipeline explicitly declares an authoritative tool selection. Next.js respects empty authoritative selections while preserving the old empty-selection meaning for custom/legacy pipelines. Existing bounded, local discovery permits subsequent tool lookup.

**Tech Stack:** TypeScript, Vitest, Vercel AI SDK, Next.js adapter; existing Foundation SDK worktree.

---

Root: `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1`.

## Task 1: Focused router behavior

Files: `src/types.ts`, `src/server/core/module-router.ts`; new `src/server/core/__tests__/module-router.test.ts`.

1. Write cases for ambiguous, unknown, low/invalid confidence returning no tools in focused mode; known intent includes its own explicitly shared dependencies; medium confidence includes shared tools only from declared related modules; legacy default still exposes its original set.
2. Run `bun run test -- src/server/core/__tests__/module-router.test.ts`; verify RED for missing focused behavior.
3. Add `routingMode?: 'focused' | 'legacy'` with legacy default on the standalone router, and `strategy: 'none'` for a focused no-match. Keep selection deterministic and deduplicated.
4. Rerun the targeted test and typecheck; update the testing result type for the new strategy.

## Task 2: Local pipeline and real adapter boundary

Files: `src/server/local-pipeline.ts`, `src/server/local-pipeline.test.ts`, `src/server/adapters/nextjs/create-ai-chat-handler.ts`, `src/server/adapters/nextjs/tool-discovery.test.ts`, `src/types.ts`.

1. Write failing tests proving a local no-match selects no domain tools, emits only technical routing metrics, and marks its selection authoritative.
2. Add focused default and explicit legacy opt-out to LocalAiPipelineConfig. PipelineResult gains optional `toolSelection: 'explicit'`; absence preserves old custom pipeline behavior.
3. Write handler regressions with and without discovery: `tools: [], toolSelection: 'explicit'` never seeds the full catalogue; legacy `tools: []` remains unchanged. Known but missing selected tool must not fall back to all.
4. Verify RED, implement narrow adapter changes, rerun focused and existing adapter/pipeline tests.

## Task 3: Verification and handoff

1. Run `bun run typecheck`, `bun run test` and `bun run build` after checking no SDK build watcher owns dist. Do not rebuild running Platform/Next apps.
2. Review exact diff and bounded secret patterns; record precise test results, limitations and remaining MVP gates.
3. Document focused/default behavior and compatibility switch. Commit only this logical SDK increment through the git-commit skill after verification, not unrelated worktree changes.
4. Continue with route discovery and controlled Get It Done reconciliation; do not represent this routing slice as the complete MVP or as a measured live latency/token reduction.

## Task 4: Shared route export recognition

Files: new `src/codegen/route-exports.ts`, `src/codegen/route-scanner.ts`, `src/codegen/execution-inventory.ts`, their existing test files, `package.json`, `bun.lock`.

1. RED tests: constant arrow/function exports, local aliased exports, comments/string literals are not exports, changed/removed constant routes, and scanner/inventory parity.
2. Use TypeScript's syntax tree only in Node-side codegen; promote the existing TypeScript dependency from dev-only so installed production CLI works. No runtime/browser import of the parser.
3. Share export recognition between scanner and inventory verification. Resolve only local function bodies/aliases without executing source. Re-exports, unresolved wrappers and wildcard exports produce bounded findings, not a silent disappearance or guessed execution binding.
4. Keep fingerprint algorithm and legacy ignores unchanged. No automatic semantic approval. Full discovery/build lifecycle remains a subsequent MVP gate.
5. Run focused tests, then full typecheck/tests/build and inspect dependency/pack impact before a separate commit.

## Verification checkpoint — 2026-09-13

- Tasks 1–4 implemented for this bounded slice, with RED/GREEN regression evidence. Shared parser also rejects recovery ASTs from invalid syntax, recognizes overload implementations once, and reports destructured/namespace exports as unresolved. Partial legacy scans are not synchronized or allowed to overwrite bindings.
- Independent review found four edge cases; each was reproduced and fixed. Final reviewer verdict has no remaining actionable finding for this slice (seven independently run suites, 59 tests).
- SDK final `bun run typecheck && bun run test && bun run build`: green; 115 test files, 918 tests; ESM/CJS and 16 compatibility shims built.
- Get It Done existing pilot against rebuilt SDK: typecheck green; 58 test files, 966 tests green. One earlier concurrent run hit the real-sync test's 5-second timeout; its isolated rerun and two subsequent complete runs passed without changing the timeout. Last complete run: 13.43 seconds; local fixture rehearsal about 2.84 seconds. This is not a live user/model test or fresh-install timing.
- The original isolated DX fixture now discovers both function-form and constant-form GET routes with the built SDK. Fresh-app setup/automatic regeneration remains unfinished.
- Pack dry run: 845 files, 527,077 packed bytes / 2,879,146 unpacked bytes. These sizes exclude dependencies. TypeScript is now a tooling dependency (~23 MB installed locally), not part of the React/runtime imports; assess total installation footprint before release.
- Diff whitespace check and bounded current-diff/untracked-file credential-pattern scan passed. No production API, business data, credential changes or package publication.
- No Get It Done source reconciliation, Platform feature changes, or landingpage changes in this increment. The upstream merge-tree probe left every worktree untouched. Remaining MVP gates are in the companion design; this is not a complete MVP acceptance.
