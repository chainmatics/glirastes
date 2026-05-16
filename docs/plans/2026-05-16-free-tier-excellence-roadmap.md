# Glirastes Free-Tier Excellence — Implementation Roadmap

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this roadmap workstream-by-workstream. Each workstream below is sized as a release-phase; before starting one, expand it into a bite-sized TDD plan via writing-plans and execute that.

**Goal:** Deliver the Free-Tier Excellence design ([docs/plans/2026-05-16-free-tier-excellence-design.md](docs/plans/2026-05-16-free-tier-excellence-design.md)) across versions 0.4 (foundation), 0.5 (DX), 0.6 (excellence), with consumer migration sequenced after the SDK releases that unblock it.

**Architecture:** Three SDK releases. 0.4 lands the foundational API shifts (`defineTool`, `autoTools`, zero-config `<AiChat />`, triple-state env detection, `GlirastesError`, public-API trim) gated by new CI infrastructure that must exist *before* any breaking change. 0.5 layers DX on top (headless hooks, debug overlay, multi-target skills, scaffold CLI, resilience defaults, test helpers). 0.6 hardens excellence (a11y, CSP, SSR discipline, manifest, api-extractor enforcement). Consumer migration of `get-it-done` and `apps/citadel` runs as its own phase after 0.4 (foundation reachable), repeated after 0.5 (DX reachable) only if the team chooses.

**Tech Stack:** TypeScript strict (NodeNext ESM + CJS dual build), Bun, Vitest, Zod, `ai@^6`, `@ai-sdk/react@^3`, Next.js 15, NestJS 11, `api-extractor`, `size-limit` / `bundlesize`, `axe-core`, `tsx` (codemod CLI).

**Date:** 2026-05-16
**Supersedes:** none (first roadmap derived from the 2026-05-16 design)

---

## Versioning, breaking changes, and the deprecation contract

| Version | Theme | Breaking? |
|---|---|---|
| 0.3.x → 0.4.0 | Foundation | **YES — major-cycle for 0.x means new minor is allowed to break.** Removes `createLancer`, `Lancer`, `ServiceBlockedError` from public API; renames `defineEndpointTool` → `defineTool` (alias retained for one minor, removed in 0.5); merges `createAiPipeline` into `createChatHandler`. |
| 0.4.x → 0.5.0 | DX | **YES — drops the `defineEndpointTool` alias, drops `createAiPipeline`, refactors hook signatures to dual-mode (provider-or-arg).** Hook signature change is the riskiest break; codemod ships in 0.5.0. |
| 0.5.x → 0.6.0 | Excellence | Mostly additive; api-extractor snapshot becomes enforcement (was advisory in 0.5). One break expected: strict CSP-clean CSS variable shape (any consumer that overrode inline styles via `style=` will need migration). |

**Breaking-change markers in this doc:** every workstream that ships a public-API break is tagged `BREAKING(0.x)` in its heading. The major-version impact is the version listed.

---

## Dependency graph (top-down)

```
Phase 0 — CI Gates Infrastructure (must land first; gates everything)
   │
   ├──> Phase 1 — 0.4 Foundation
   │       ├── 1A Error model (GlirastesError)              [blocks 1C, 1D, 1E, 1F, 1G, every DX/excellence skill]
   │       ├── 1B Triple-state env detect + Lancer-internal [blocks 1C, 1E]
   │       ├── 1C createPiiShield without Lancer arg         [blocks 1D pluggable pattern, 1H skills, 4A migration]
   │       ├── 1D Pluggable strategy + naive baselines       [blocks 1H skills, 5C trust audit, 4A migration]
   │       ├── 1E createChatHandler unification              [blocks 1F defineTool, 4A migration]
   │       ├── 1F defineTool (Next.js)                       [blocks 1G autoTools, 2A scaffold-tool, 4A migration]
   │       ├── 1G autoTools() build-time scan                [blocks 3D explain command, 4A migration]
   │       ├── 1H <AiChat /> zero-config + dynamic imports   [blocks 2C debug overlay, 2D headless hooks, 4A migration]
   │       ├── 1I Direct deps (@ai-sdk/react, react-markdown)[blocks 1H, gated by bundle-budget CI]
   │       └── 1J Trust Manifest scaffold + CI gate          [blocks 5C audit, every "trust" claim]
   │
   ├──> Phase 2 — Consumer migration (0.4 ready)
   │       ├── 2A get-it-done: 0.18 → 0.4                    [needs all of Phase 1]
   │       └── 2B apps/citadel: 0.18 → 0.4                   [needs all of Phase 1, can run parallel with 2A]
   │
   ├──> Phase 3 — 0.5 DX
   │       ├── 3A scaffold-tool / scaffold-ui-tool / scaffold-pii-* CLI  [blocks 3C skills]
   │       ├── 3B explain command                            [needs 1F, 1G; blocks 3C skills]
   │       ├── 3C Multi-target skills + install-skills v2    [needs 3A, 3B, 1H; blocks Phase 0 gate G5 empty-Cursor test]
   │       ├── 3D Headless hooks refactor (BREAKING 0.5)     [needs 1H; blocks 3F]
   │       ├── 3E Debug overlay + GLIRASTES_VERBOSE          [needs 1H; independent of 3D]
   │       ├── 3F Resilience defaults                        [needs 1H, 3D]
   │       ├── 3G MockLanguageModel + createTestChat()       [independent; needs 1F surface]
   │       ├── 3H Codemod (import rename)                    [needs 1F final naming; ships with 0.5]
   │       └── 3I check-upgrade extension for 0.4 → 0.5      [needs 3H]
   │
   ├──> Phase 4 — Consumer migration (0.5 ready, optional)
   │       └── 4A Re-pull get-it-done + citadel onto 0.5    [needs Phase 3; only if value > churn]
   │
   └──> Phase 5 — 0.6 Excellence
           ├── 5A A11y pass (WAI-ARIA + NVDA/VoiceOver)      [needs 1H, 3D]
           ├── 5B CSP / inline-style-free audit              [needs 1H final styling shape]
           ├── 5C SSR / RSC boundary enforcement             [needs 1H]
           ├── 5D api-extractor enforcement flip             [needs Phase 0 gate G3 baselined since 0.4]
           ├── 5E llms.txt / AGENTS.md / JSDoc @example      [needs final 0.5 surface]
           └── 5F Trust Manifest published-per-release       [needs 1J]
```

Reading this graph: 1A, 1B, 1J have no internal blockers and should start first in Phase 1. 1F (defineTool) is the longest critical path through 0.4 because 1G, 2A, 2B, 3A all depend on it.

---

## CI Gates (Phase 0 — must land first)

Each gate is its own merged PR before Phase 1 starts. Gates are advisory-only on first land (don't break the build) and flipped to enforcing once the codebase passes them, as noted.

### Gate G1 — Bundle size budget: Core < 25KB gz

**Files:**
- Create: [.github/workflows/bundle-size.yml](.github/workflows/bundle-size.yml)
- Create: [.size-limit.json](.size-limit.json)
- Create: [scripts/measure-core-bundle.mjs](scripts/measure-core-bundle.mjs) — builds, then bundles `glirastes/react` + `glirastes/server/nextjs` cores separately with esbuild, measures `gzip-size`.

**Acceptance signal:** PR comment shows core size delta; build fails if any of (`react core`, `server-nextjs core`) exceeds 25 KB gzipped. **Advisory at land, enforcing once 1H + 1I have shipped and passed.**

**Breaking change?** No.

**Who depends on it:** 1H, 1I, every PR that touches `src/react/components/**` or `src/react/index.ts`.

---

### Gate G2 — Trust Manifest validation

**Files:**
- Create: [scripts/validate-manifest.mjs](scripts/validate-manifest.mjs) — greps `src/**/*.ts` for `fetch(`, `new WebSocket(`, `new EventSource(`, `axios`, `undici.request`, resolves call-sites to the host pattern they hit, asserts each host appears in `MANIFEST.md` under the correct state header (no-key / free-key / pro-key).
- Create: [MANIFEST.md](MANIFEST.md) — initial template per design §10.
- Create: [.github/workflows/manifest.yml](.github/workflows/manifest.yml).

**Acceptance signal:** Build fails when a `fetch(...)` introduces a host that isn't listed in `MANIFEST.md`. Allowlist for legitimate cases (LLM provider URL constructed from user config) lives in [scripts/manifest-allowlist.json](scripts/manifest-allowlist.json) with a justification per entry.

**Breaking change?** No (internal).

**Who depends on it:** 1B (the Lancer-internalisation must keep manifest passing), 1J, 5F.

---

### Gate G3 — api-extractor public-surface snapshot

**Files:**
- Add: `@microsoft/api-extractor` to devDependencies.
- Create: [api-extractor.json](api-extractor.json) per subpath (one per public export root: `index`, `server`, `server/nextjs`, `server/nestjs`, `server/testing`, `react`, `react/vercel`, `react/langgraph`, `codegen`, `openapi`).
- Create: [etc/](etc/) — committed `.api.md` snapshots.
- Create: [.github/workflows/api-extractor.yml](.github/workflows/api-extractor.yml).
- Modify: [package.json](package.json) — add `"api:check": "api-extractor run --local"` script.

**Acceptance signal:** PR diff renders `.api.md` changes inline; build emits a warning on diff in 0.4–0.5; **becomes a blocking gate in 0.6 (workstream 5D).** Any change to a public symbol shows up as a diff line, forcing reviewer to ack the surface change.

**Breaking change?** No (gate land); flip to enforcing is its own workstream (5D).

**Who depends on it:** 1F, 1G, 1H, every public-API change downstream, and 5D.

---

### Gate G4 — a11y axe scan against `<AiChat />`

**Files:**
- Create: [tests/a11y/ai-chat.axe.test.ts](tests/a11y/ai-chat.axe.test.ts) — mounts `<AiChat />` in JSDOM via `@testing-library/react`, runs `axe-core` with WCAG 2.1 AA ruleset.
- Modify: [package.json](package.json) — add `axe-core`, `@axe-core/react`, `jest-axe` (or vitest equivalent) to devDependencies.
- Modify: [.github/workflows/test.yml](.github/workflows/test.yml) (or whichever workflow runs `bun run test`) — include the a11y suite.

**Acceptance signal:** Advisory on land (allow violations to be listed in PR comment without failing); flipped to enforcing during workstream 5A.

**Breaking change?** No.

**Who depends on it:** 1H baseline, 5A enforcement flip.

---

### Gate G5 — Empty-Cursor-project end-to-end skill test

**Files:**
- Create: [tests/e2e/empty-cursor-project.test.ts](tests/e2e/empty-cursor-project.test.ts) — in a tmpdir: `bunx create-next-app@latest --typescript --no-tailwind`, `bun add file:<repo>` (locally built glirastes tarball), copy our `.cursor/rules/*.mdc` skills into the project, run a scripted Cursor-style automation: `bunx glirastes install-skills`, then trigger the `setup-glirastes-app` skill simulation (a deterministic CLI orchestration), then a scripted "add-glirastes-tool" run, then assert `bun run build` succeeds and the generated chat endpoint resolves a tool call against a mocked LLM.
- Create: [scripts/build-local-tarball.mjs](scripts/build-local-tarball.mjs) — `npm pack` → returns path.
- Create: [.github/workflows/e2e-cursor.yml](.github/workflows/e2e-cursor.yml) — runs on a schedule (nightly) + on PRs that touch `skills/**` or `src/cli/commands/install-skills/**`.

**Acceptance signal:** Test green = a coding agent following our skills can go from empty Next.js → working tool call. **Must be green before 0.5 ships** (this is the bar for Moment 1 + Moment 4 success).

**Breaking change?** No.

**Who depends on it:** Skills authoring (3C), `install-skills` v2 (3C), `scaffold-*` CLI (3A), `defineTool` (1F), `autoTools` (1G), `<AiChat />` (1H). It's the integration test for everything user-facing.

---

## Phase 1 — Release 0.4 Foundation

Goal: every architectural shift in design §3 (Moments 1–5), §4 (triple-state), §5 (public-API trim) lands. Skills, DX surface, debug overlay, a11y polish wait for 0.5/0.6.

### 1A — `GlirastesError` class and error catalog seed

**Version:** 0.4.0
**Breaking?** Soft — replaces `ServiceBlockedError` (which was public). Add `BREAKING(0.4)` line to CHANGELOG.

**Files:**
- Create: [src/errors/glirastes-error.ts](src/errors/glirastes-error.ts) — class with `code`, `where`, `hint`, `docs`, `cause`.
- Create: [src/errors/codes.ts](src/errors/codes.ts) — union type of all error codes; start with `tool/handler-threw`, `tool/timeout`, `tool/not-found`, `chat/transport-failed`, `chat/llm-rate-limited`, `platform/not-in-plan`, `platform/unreachable`, `config/missing-api-route`.
- Create: [src/errors/index.ts](src/errors/index.ts) — barrel.
- Modify: [src/index.ts](src/index.ts) — re-export `GlirastesError` and `GlirastesErrorCode`.
- Modify: [src/server/index.ts](src/server/index.ts) — remove `ServiceBlockedError` export, add `GlirastesError` re-export, leave internal `ServiceBlockedError` for internal handlers but wrap at the boundary.
- Create: [docs/errors/README.md](docs/errors/README.md) — index of error codes mapped to `https://glirastes.dev/errors/<code>` URLs.

**Depends on:** Phase 0 complete.
**Blocks:** 1C, 1D, 1E, 1F, 1G, 1H — all error-emitting workstreams target this class.
**Acceptance:** `throw new GlirastesError({ code: 'tool/handler-threw', where: '...', hint: '...', docs: '...' })` renders the multi-line message from design §5; round-trips through `JSON.stringify` losslessly; existing throw-sites for `ServiceBlockedError` rewritten to wrap as `GlirastesError({ code: 'platform/not-in-plan' })` at the public boundary.

---

### 1B — Triple-state env-var auto-detect + Lancer-internal

**Version:** 0.4.0
**Breaking?** **BREAKING(0.4)** — removes `createLancer`, `Lancer`, `LancerOptions` from public exports. Internal-only.

**Files:**
- Create: [src/server/internal/resolve-platform-state.ts](src/server/internal/resolve-platform-state.ts) — reads `GLIRASTES_API_KEY`, returns `{ state: 'no-key' | 'with-key', baseUrl, fetch }`. Plan tier is *not* resolved here (the platform refuses per-feature with 402).
- Create: [src/server/internal/lancer-singleton.ts](src/server/internal/lancer-singleton.ts) — module-level memoised Lancer instance for internal callers (`createPiiShield`, classifier, warden, model-selector, telemetry). Lazy on first call.
- Modify: [src/server/lancer/index.ts](src/server/lancer/index.ts) — remove from `src/server/index.ts` barrel; keep file path so internal imports work.
- Modify: [src/server/index.ts](src/server/index.ts) — delete `createLancer`, `Lancer`, `LancerOptions` re-exports; delete `ServiceBlockedError` (handled by 1A).
- Update: [etc/server.api.md](etc/server.api.md) — snapshot regenerated, reviewer must ack diff.

**Depends on:** Phase 0 (G3 must exist).
**Blocks:** 1C, 1E.
**Acceptance:** Grep across [src/](src/) shows zero public-API references to `createLancer`/`Lancer`. `GLIRASTES_API_KEY=foo bun run test` and unset `bun run test` both green. Manifest validator (G2) reports `api.glirastes.chainmatics.io` is contacted only in the `with-key` state.

---

### 1C — `createPiiShield` without Lancer arg

**Version:** 0.4.0
**Breaking?** **BREAKING(0.4)** — old signature `createPiiShield({ lancer, … })` removed.

**Files:**
- Modify: [src/server/pii-shield/create-pii-shield.ts](src/server/pii-shield/create-pii-shield.ts) — drop `lancer` from `CreatePiiShieldOptions`; resolve Lancer internally via 1B; accept new `detector?: PiiDetector` field (default chosen by env state).
- Modify: [src/server/pii-shield/aegis-detector.ts](src/server/pii-shield/aegis-detector.ts) — wraps internal Lancer; on 402 throws an internal sentinel, caught at `createPiiShield` and downgraded to the local baseline with a one-time `console.warn` (gated by `GLIRASTES_VERBOSE`).
- Update: [src/server/pii-shield/__tests__/create-pii-shield.test.ts](src/server/pii-shield/__tests__/create-pii-shield.test.ts) — cover the three states (no-key → naive only, with-key + 402 → naive with warning, with-key + 200 → aegis).

**Depends on:** 1A, 1B, 1D (naiveDetector must exist).
**Blocks:** 1D consumers, 2A/2B consumer migration, 3C skills (`add-glirastes-pii-shield`).
**Acceptance:** Calling `createPiiShield()` with no args works in all three states. Public type signature in [etc/server.api.md](etc/server.api.md) no longer mentions `lancer`.

---

### 1D — Pluggable strategy pattern + naive baselines

**Version:** 0.4.0
**Breaking?** Additive (new exports). No removal.

**Files:**
- Create: [src/server/pii-shield/naive-detector.ts](src/server/pii-shield/naive-detector.ts) — exports `naiveDetector(opts?: { patterns? })`. Built-in regexes: `email`, `phone`, `iban`, `cc`, `ip`. Returns `PiiDetector`.
- Create: [src/server/pii-shield/extend-detector.ts](src/server/pii-shield/extend-detector.ts) — exports `extendDetector(base?: PiiDetector, opts: { patterns: Record<string, RegExp> }): PiiDetector`. When `base` is `undefined`, defers to the state-aware default at first call.
- Create: [src/server/pii-shield/compose-detectors.ts](src/server/pii-shield/compose-detectors.ts) — exports `composeDetectors(detectors: PiiDetector[]): PiiDetector`. Merges matches, dedupes overlapping spans (longest match wins, tie → first detector).
- Create: [src/server/pii-shield/detector-contract.ts](src/server/pii-shield/detector-contract.ts) — `PiiDetector` interface and `PiiMatch` type per design §6.
- Create: [src/server/core/naive-classifier.ts](src/server/core/naive-classifier.ts) — stemmer-based local intent classifier matching the `Primus` contract.
- Create: [src/server/core/naive-guardrails.ts](src/server/core/naive-guardrails.ts) — regex blocklist matching the `Warden` contract.
- Modify: [src/server/pii-shield/index.ts](src/server/pii-shield/index.ts) — barrel for new exports.
- Modify: [src/server/index.ts](src/server/index.ts) — re-export `naiveDetector`, `extendDetector`, `composeDetectors`, `naiveClassifier`, `naiveGuardrails`, `PiiDetector`, `PiiMatch`.
- Create: [src/server/pii-shield/__tests__/compose-detectors.test.ts](src/server/pii-shield/__tests__/compose-detectors.test.ts) — overlapping-span dedupe table-test.

**Depends on:** 1A (errors thrown by detectors are `GlirastesError`).
**Blocks:** 1C consumers, 3C skills, 5C trust audit, 2A/2B migration.
**Acceptance:** All three idioms from design §6 ("REPLACE / EXTEND / COMPOSE") compile and behave as documented. `extendDetector(undefined, …)` resolves to the state-aware default at first `.detect()` call (lazy).

---

### 1E — `createChatHandler` unification (one entry point)

**Version:** 0.4.0
**Breaking?** **BREAKING(0.4)** — `createAiPipeline` becomes a deprecated alias for `createChatHandler` for one minor; removed in 0.5 (workstream is part of 3 — see 3I).

**Files:**
- Modify: [src/server/adapters/nextjs/create-ai-chat-handler.ts](src/server/adapters/nextjs/create-ai-chat-handler.ts) — fold optional pipeline config into the handler options: `{ piiShield?, classifier?, guardrails?, modelSelector?, followups? }`. When any field is set, the pipeline orchestrates per design §4 routing.
- Modify: [src/server/pipeline.ts](src/server/pipeline.ts) — keep file but `export const createAiPipeline = createChatHandler` with `@deprecated` JSDoc.
- Rename internal: `createAiChatHandler` → `createChatHandler`. Add `createAiChatHandler = createChatHandler` alias with `@deprecated` JSDoc for one minor.
- Modify: [src/server/index.ts](src/server/index.ts) — re-export `createChatHandler` as the primary name; keep `createAiChatHandler`, `createAiPipeline` deprecated.
- Update: [src/server/pipeline.test.ts](src/server/pipeline.test.ts) — rename to test the unified handler; cover the no-pipeline-fields path is identical to today's `createAiChatHandler`.

**Depends on:** 1A, 1B, 1C, 1D.
**Blocks:** 1F (defineTool needs to know which handler to integrate with), 2A/2B migration.
**Acceptance:** Calling `createChatHandler({ tools })` with no pipeline fields produces identical output to today's `createAiChatHandler({ tools })` (same SSE byte stream against the test corpus). Calling with `{ tools, piiShield }` produces identical output to today's `createAiPipeline({ tools, piiShield })`.

---

### 1F — `defineTool` (combined route + tool definition, Next.js)

**Version:** 0.4.0
**Breaking?** **BREAKING(0.4)** — renames `defineEndpointTool` → `defineTool`. Old name retained as deprecated alias until 0.5 (removed in 3H codemod).

**Files:**
- Create: [src/server/adapters/nextjs/define-tool.ts](src/server/adapters/nextjs/define-tool.ts) — `defineTool({ description, input, output?, handler, name?, allowedRoles? })` returns a callable Next.js Route Handler (one of `GET`/`POST`/`PUT`/`PATCH`/`DELETE`) **and** carries a non-enumerable `$tool` property holding the tool definition. Name inference: `<httpMethod>_<resourceSegments>` from `import.meta.url` + the export name. Carries `$types: { input, output }` for end-to-end typing (design §3 Moment 2, Challenge #4).
- Create: [src/server/adapters/nextjs/__tests__/define-tool.test.ts](src/server/adapters/nextjs/__tests__/define-tool.test.ts) — covers: (1) HTTP fetch against the handler returns the same shape as `handler({ input })`, (2) tool definition `$tool` is consumable by `endpointToolsToRegistry`, (3) name inference from path, (4) handler-throws renders as `GlirastesError({ code: 'tool/handler-threw' })` with `where` pointing at the source file.
- Modify: [src/types.ts](src/types.ts) — type `EndpointToolDefinition` widened/aliased so `defineTool` output is assignable; add `DefineToolOptions<TInput, TOutput>`.
- Modify: [src/server/adapters/nextjs/index.ts](src/server/adapters/nextjs/index.ts) — export `defineTool`; export `defineEndpointTool` as `@deprecated` alias.
- Modify: [docs/](docs/) — Moment 2 doc page.

**Depends on:** 1A, 1E.
**Blocks:** 1G (autoTools needs the `$tool` marker), 2A/2B migration, 3A scaffold-tool CLI, 3D explain command.
**Acceptance:** A `defineTool`-authored `app/api/tasks/route.ts` is callable both by HTTP `GET /api/tasks` and by the AI as `get_tasks`, with identical output shapes. Renaming the file (`tasks` → `todos`) changes the tool name to `get_todos` with zero edits to either the handler or the registry. TS strict mode rejects a mismatched payload between `input` schema and `handler` parameter.

---

### 1G — `autoTools()` build-time tool discovery (Next.js)

**Version:** 0.4.0
**Breaking?** No (additive).

**Files:**
- Create: [src/server/adapters/nextjs/auto-tools.ts](src/server/adapters/nextjs/auto-tools.ts) — runtime stub that throws `GlirastesError({ code: 'config/auto-tools-untransformed', hint: 'Did the SWC/webpack plugin run? Or use { tools: [...] } manually.' })` if called without the macro running. The macro replaces the call with a static array at build time.
- Create: [src/server/adapters/nextjs/auto-tools-webpack-plugin.ts](src/server/adapters/nextjs/auto-tools-webpack-plugin.ts) — Webpack plugin: AST-walks for `autoTools()` calls, replaces with `[...require.context('app/api/', true, /\\/route\\.(ts|js)$/)...]` style enumeration, filters to exports carrying `$tool`.
- Create: [src/server/adapters/nextjs/auto-tools-turbopack-rule.ts](src/server/adapters/nextjs/auto-tools-turbopack-rule.ts) — Turbopack equivalent using `import.meta.glob('app/api/**/route.ts')` rewrite. If Turbopack's API doesn't yet permit AST rewrite for the macro, document the manual-fallback in the JSDoc on `autoTools` and emit a clear `GlirastesError` at build time so Turbopack users hit a guided path, not a silent miss.
- Create: [src/server/adapters/nextjs/__tests__/auto-tools.test.ts](src/server/adapters/nextjs/__tests__/auto-tools.test.ts) — fixture project under [tests/fixtures/next-autotools/](tests/fixtures/next-autotools/) with 5 `defineTool` routes; assert the build output's registry contains all 5; assert <100ms transform overhead over a 50-tool synthetic fixture.
- Modify: [src/server/adapters/nextjs/index.ts](src/server/adapters/nextjs/index.ts) — export `autoTools`, the webpack plugin, the turbopack rule.

**Depends on:** 1F.
**Blocks:** 3B explain command, 2A/2B migration.
**Acceptance:** A 30-tool Next.js project compiles with `tools: autoTools()`, no `predev` codegen step, AI calls all 30 tools correctly. Empty Turbopack project either works the same OR shows a clear `GlirastesError` (no silent failure). Build-time transform <100ms for a 50-tool fixture.

---

### 1H — `<AiChat />` zero-config widget + dynamic imports

**Version:** 0.4.0
**Breaking?** No (additive; `<VercelAiChat>` remains as today).

**Files:**
- Create: [src/react/components/ai-chat.tsx](src/react/components/ai-chat.tsx) — wraps `<VercelAiChat>` with defaults: `endpoint="/api/chat"`, transport=Vercel AI SDK, position=floating bottom-right (or inline if rendered inside `<main>`), locale=icons-first.
- Modify: [src/react/index.ts](src/react/index.ts) — export `AiChat`. Mark module `sideEffects: false` for tree-shaking.
- Create: [src/react/components/lazy-markdown.tsx](src/react/components/lazy-markdown.tsx) — `React.lazy(() => import('react-markdown'))`. Suspense boundary in `<AiChat>` body.
- Create: [src/react/components/lazy-voice.tsx](src/react/components/lazy-voice.tsx) — `React.lazy(() => import('./voice'))`. Triggered on mic-button click.
- Create: [src/react/components/lazy-mentions.tsx](src/react/components/lazy-mentions.tsx) — `React.lazy` boundary, triggered on `@` keystroke.
- Modify: [src/react/components/voice/](src/react/components/voice/) — confirm `wavesurfer.js` import is dynamic (`await import('wavesurfer.js')` on first user interaction).

**Depends on:** 1I (direct deps), Phase 0 G1 bundle gate, Phase 0 G4 a11y gate.
**Blocks:** 2C debug overlay, 3D headless hooks, 3E debug overlay, 2A/2B migration, 5A/5B/5C excellence.
**Acceptance:** Bundle budget (G1) green: core (no markdown, no voice, no mentions) under 25 KB gz. First markdown token triggers <50ms LCP delta in the empty-project fixture. Default `<AiChat />` mounted with zero props renders, connects to `/api/chat`, and round-trips one tool call in the integration test.

---

### 1I — Move `@ai-sdk/react` + `react-markdown` to direct dependencies

**Version:** 0.4.0
**Breaking?** **BREAKING(0.4)** — consumers who pinned conflicting versions of these in their app will need to align. Listed in the migration guide.

**Files:**
- Modify: [package.json](package.json) — move `@ai-sdk/react` and `react-markdown` from `peerDependencies` (optional) to `dependencies`. Keep `wavesurfer.js` as optional peer (voice is opt-in). Use exact-pinned major (`^3.0.0`, `^10.1.0`).
- Modify: [package.json](package.json) — remove from `peerDependenciesMeta` the two now-direct deps.
- Modify: [README.md](README.md) — install section becomes `bun add glirastes`.
- Update: [.github/workflows/test.yml](.github/workflows/test.yml) — assert `bun add glirastes` in a fresh fixture emits no peer warnings.

**Depends on:** Phase 0 G1 (so the bundle impact is visible).
**Blocks:** 1H.
**Acceptance:** Cold `bun add glirastes` in an empty Next.js project produces no peer warning. Bundle budget (G1) still green after these are direct deps (because of lazy imports in 1H).

---

### 1J — Trust Manifest scaffold + first release publication

**Version:** 0.4.0
**Breaking?** No.

**Files:**
- Create: [MANIFEST.md](MANIFEST.md) — populated per design §10 with `0.4.0` outbound table.
- Modify: [package.json](package.json) — add `MANIFEST.md` to `files`.
- Modify: [scripts/validate-manifest.mjs](scripts/validate-manifest.mjs) (from G2) — assert the version header matches `package.json#version`.

**Depends on:** Phase 0 G2, 1B (so the Lancer-internal flow doesn't leak hosts).
**Blocks:** 5C trust audit, 5F published-per-release publication.
**Acceptance:** `MANIFEST.md` ships with the 0.4.0 npm tarball; manifest-validator green on `main`; `0.4.0` is documented in the file's version header.

---

## Phase 2 — Consumer migration (0.4 ready)

Runs after 0.4.0 is published to npm. 2A and 2B can run in parallel (different repos).

### 2A — `get-it-done`: `@chainmatics/agentic-*` 0.18 → `glirastes` 0.4

**Version:** N/A (consumer repo). Glirastes pin: `^0.4.0`.
**Breaking?** For the consumer: yes — package rename + API consolidation.

**Out-of-tree work:** Lives in `get-it-done` repo, not in this one. Plan is referenced here so the sequencing is explicit.

**Steps (high level, expand on entry):**
1. `bun remove @chainmatics/agentic-server @chainmatics/agentic-react @chainmatics/agentic-react-vercel @chainmatics/agentic-react-langgraph`
2. `bun add glirastes@^0.4.0`
3. Run the 0.18→0.4 codemod (ships separately as `glirastes-codemod` or via `bunx glirastes check-upgrade --apply` — limited to import renames per design §12).
4. Rewrite `defineEndpointTool` call-sites to `defineTool` (combined route+tool) where the file is already a route handler; leave separate-file definitions alone for one release.
5. Replace `endpointToolsToRegistry([t1, t2, ...])` with `autoTools()`.
6. Replace `createAiPipeline({ lancer, ... })` with `createChatHandler({ piiShield, ... })`. Drop explicit `createLancer` call.
7. Replace `<VercelAiChat endpoint="/api/chat" />` with `<AiChat />`.
8. Run consumer's test suite; smoke-test in dev; cut a PR.

**Depends on:** Phase 1 complete and 0.4.0 published.
**Blocks:** Nothing in the SDK roadmap; informs 0.5 with real-world feedback.
**Acceptance:** `get-it-done` PR merged on glirastes 0.4, all consumer tests green, `bun run dev` opens and the chat works against the same set of tools as before. Migration friction logged in `docs/migration-notes/get-it-done-0.4.md`.

---

### 2B — `apps/citadel`: `@chainmatics/agentic-*` 0.18 → `glirastes` 0.4

Same shape as 2A. Runs in parallel with 2A. Citadel is a NestJS consumer, so the migration exercises the NestJS adapter path (no `defineTool`, no `autoTools` — `scanNestJsControllers()` already runtime-discovers).

**Steps (high level):**
1. Package swap as in 2A.
2. Rewrite `@AiModule({ pipeline: createAiPipeline(...) })` to `@AiModule({ handler: createChatHandler(...) })`.
3. Drop explicit `createLancer` from any `AppModule.providers`.
4. Verify `<AiChat />` works on the citadel frontend (if it has one).
5. Run consumer's test suite; smoke-test; cut a PR.

**Depends on:** Phase 1 complete and 0.4.0 published.
**Blocks:** Nothing in the SDK roadmap.
**Acceptance:** Citadel PR merged on glirastes 0.4; nest-app boot green; all tools registered; chat round-trip works. Migration friction logged in `docs/migration-notes/citadel-0.4.md`.

---

## Phase 3 — Release 0.5 DX

Goal: design §3 Moment 5 ("Eject + Debug + Trust"), §7 (skill-first UX), and the resilience defaults from Challenge #2 land.

### 3A — `scaffold-tool` / `scaffold-ui-tool` / `scaffold-pii-*` CLI

**Version:** 0.5.0
**Breaking?** No (additive). Old `scaffold` keeps working.

**Files:**
- Create: [src/cli/commands/scaffold-tool.ts](src/cli/commands/scaffold-tool.ts) — flags `--path`, `--method`, `--name`. Emits a `defineTool` skeleton at the path.
- Create: [src/cli/commands/scaffold-ui-tool.ts](src/cli/commands/scaffold-ui-tool.ts) — flags `--action`, `--schema`. Emits a `defineUiTool` skeleton.
- Create: [src/cli/commands/scaffold-pii-shield.ts](src/cli/commands/scaffold-pii-shield.ts) — flags `--mode` (`replace|extend|compose`).
- Create: [src/cli/commands/scaffold-pii-detector.ts](src/cli/commands/scaffold-pii-detector.ts) — custom-detector skeleton.
- Modify: [src/cli/index.ts](src/cli/index.ts) — register new commands in `validCommands`; update help text. Add `scaffold-*` to the documented preferred path; mark `generate-*` deprecated but functional.
- Create: [src/cli/__tests__/scaffold-tool.test.ts](src/cli/__tests__/scaffold-tool.test.ts) — runs in a tmpdir, asserts the emitted file compiles with `tsc --noEmit` and registers as expected.

**Depends on:** 1F.
**Blocks:** 3C skills (skills delegate to these for determinism), Phase 0 G5 e2e test.
**Acceptance:** `bunx glirastes scaffold-tool --path app/api/tasks/route.ts --method GET --name list_tasks` creates a valid `defineTool` file that compiles, registers, and is callable.

---

### 3B — `explain` CLI command

**Version:** 0.5.0
**Breaking?** No (additive).

**Files:**
- Create: [src/cli/commands/explain.ts](src/cli/commands/explain.ts) — Argument is a path to a chat-handler file. Statically analyses the file to surface: which handler factory is called, what its resolved config is (defaults expanded), what tools `autoTools()` would discover (by traversing the same glob), what transport is configured, what the manifest will list as outbound. Renders as a nested tree.
- Modify: [src/cli/index.ts](src/cli/index.ts) — register `explain`.
- Create: [src/cli/__tests__/explain.test.ts](src/cli/__tests__/explain.test.ts) — fixture project; assert the rendered tree matches a golden file.

**Depends on:** 1F, 1G.
**Blocks:** 3C skills (`debug-glirastes-tool-call` uses it).
**Acceptance:** `bunx glirastes explain app/api/chat/route.ts` against the e2e fixture prints all resolved defaults, every discovered tool, and the active transport.

---

### 3C — Multi-target skills + `install-skills` v2

**Version:** 0.5.0
**Breaking?** No (additive; existing `.claude/skills` install continues to work).

**Files:**
- Restructure: [skills/](skills/) → [skills/source/](skills/source/) (canonical Markdown) + [skills/templates/](skills/templates/) (per-target wrappers).
- Create: [skills/source/setup-glirastes-app.md](skills/source/setup-glirastes-app.md)
- Create: [skills/source/add-glirastes-tool.md](skills/source/add-glirastes-tool.md)
- Create: [skills/source/add-glirastes-pii-shield.md](skills/source/add-glirastes-pii-shield.md)
- Create: [skills/source/add-glirastes-guardrails.md](skills/source/add-glirastes-guardrails.md)
- Create: [skills/source/customize-glirastes-ui.md](skills/source/customize-glirastes-ui.md)
- Create: [skills/source/debug-glirastes-tool-call.md](skills/source/debug-glirastes-tool-call.md)
- Create: [skills/source/audit-glirastes-tools.md](skills/source/audit-glirastes-tools.md)
- Create: [skills/source/connect-glirastes-platform.md](skills/source/connect-glirastes-platform.md)
- Create: [skills/source/enable-glirastes-pro-features.md](skills/source/enable-glirastes-pro-features.md)
- Create: [skills/source/upgrade-glirastes.md](skills/source/upgrade-glirastes.md)
- Create: 5 reference skills under [skills/source/reference/](skills/source/reference/) (`architecture-overview`, `tool-author-reference`, `chat-ui-reference`, `nextjs-conventions`, `nestjs-conventions`).
- Modify: [src/cli/commands/install-skills/](src/cli/commands/install-skills/) — detect target IDE(s) in the project tree (presence of `.cursor/`, `.clinerules/`, `.windsurf/`, `.claude/`, `AGENTS.md`). Transpile each `skills/source/*.md` to the target format (`.claude/skills/<name>/SKILL.md`, `.cursor/rules/<name>.mdc`, `.clinerules/<name>.md`, `.windsurf/rules/<name>.md`, or a section in `AGENTS.md`). Keep `--target`, `--symlink`, `--force`, `--dry-run` from today.
- Create: [skills/source/transpile.ts](skills/source/transpile.ts) — pure function `(source: string, target: TargetIDE) => string`; tested in isolation.
- Create: [src/cli/__tests__/install-skills-multi-target.test.ts](src/cli/__tests__/install-skills-multi-target.test.ts) — for each target, transpile + assert frontmatter/format is valid for that IDE's loader.

**Mitigation of design risk #5** (engineering cost of multi-target): canonical source is a single Markdown file. Per-target transpile is a frontmatter rewrite + path/format adjustment, not parallel maintenance. If maintenance cost stays high after 0.5, we can drop the lower-demand targets (Cline, Windsurf) without affecting Claude / Cursor / AGENTS.md.

**Depends on:** 3A scaffold-* CLI, 3B explain, 1F, 1G, 1H.
**Blocks:** Phase 0 G5 (empty-Cursor e2e test cannot pass without the Cursor target).
**Acceptance:** `bunx glirastes install-skills` in a project with `.cursor/rules/` present installs Cursor-formatted versions; same project with `.claude/skills/` present installs both; G5 e2e test green end-to-end.

---

### 3D — Headless hooks refactor: standalone-mode for every hook

**Version:** 0.5.0
**Breaking?** **BREAKING(0.5)** — hook signatures change to dual-mode. Codemod (3H) handles the common cases.

**Files:**
- Modify: [src/react/hooks/use-chat.ts](src/react/hooks/use-chat.ts) — accept optional config arg; when missing, pull from `<AiChatProvider>`.
- Modify: [src/react/hooks/use-approvals.ts](src/react/hooks/use-approvals.ts) — same pattern.
- Modify: [src/react/hooks/use-mentions.ts](src/react/hooks/use-mentions.ts) — same pattern.
- Modify: [src/react/hooks/use-suggestions.ts](src/react/hooks/use-suggestions.ts) — same pattern.
- Modify: [src/react/provider/](src/react/provider/) — provider becomes optional consumer-side; tests cover both modes.
- Create: [src/react/hooks/__tests__/standalone-mode.test.ts](src/react/hooks/__tests__/standalone-mode.test.ts) — each hook works without `<AiChatProvider>`.
- Update: [docs/](docs/) — eject ladder doc per design §3 Moment 5.

**Depends on:** 1H.
**Blocks:** 3F resilience (resilience defaults live in the hooks), 5A a11y testing of headless paths.
**Acceptance:** Every hook listed has a test that mounts it without a provider and another that mounts it inside the provider; both green.

---

### 3E — Debug overlay (`?glirastes_debug=1`) + `GLIRASTES_VERBOSE` logs

**Version:** 0.5.0
**Breaking?** No (additive).

**Files:**
- Create: [src/react/debug/overlay.tsx](src/react/debug/overlay.tsx) — floating inspector. Last 50 SSE events, tool calls with latencies, payloads (collapsible), errors, current transport, loaded tools.
- Create: [src/react/debug/activator.ts](src/react/debug/activator.ts) — reads `?glirastes_debug=1` from `window.location.search` or `localStorage.glirastes_debug`. Activates overlay via `React.lazy` (so debug code doesn't ship to non-debug users).
- Create: [src/react/debug/event-buffer.ts](src/react/debug/event-buffer.ts) — circular buffer of 50 events; subscribable.
- Modify: [src/react/components/ai-chat.tsx](src/react/components/ai-chat.tsx) — conditionally mount the overlay activator.
- Create: [src/server/internal/verbose-logger.ts](src/server/internal/verbose-logger.ts) — `if (process.env.GLIRASTES_VERBOSE) console.debug('[glirastes:tool] …')`. Prefixes: `[glirastes:tool]`, `[glirastes:llm]`, `[glirastes:platform]`, `[glirastes:pii]`. Default: silent.
- Update each internal call-site to use the verbose-logger when emitting diagnostic info.

**Depends on:** 1H.
**Blocks:** Nothing critical; supports 3C `debug-glirastes-tool-call` skill.
**Acceptance:** Visiting `?glirastes_debug=1` activates the overlay; bundle budget (G1) unchanged (debug chunk lazy). `GLIRASTES_VERBOSE=1 bun run dev` emits structured logs; unset is silent.

---

### 3F — Resilience defaults

**Version:** 0.5.0
**Breaking?** No (additive default behaviour; opt-out via config).

**Files:**
- Modify: [src/server/adapters/nextjs/create-ai-chat-handler.ts](src/server/adapters/nextjs/create-ai-chat-handler.ts) (now `createChatHandler`) — wrap LLM calls in retry-with-backoff on HTTP 429 (max 3, jittered exponential). Default tool timeout 30s (overridable per tool); on timeout throw `GlirastesError({ code: 'tool/timeout' })`.
- Modify: [src/server/adapters/nextjs/create-ai-chat-handler.ts](src/server/adapters/nextjs/create-ai-chat-handler.ts) — context-overflow truncation: oldest-first, with an explicit marker message ("…earlier messages truncated…") so the model is aware.
- Modify: [src/react/hooks/use-chat.ts](src/react/hooks/use-chat.ts) — `sessionStorage` resume on page refresh (last 10 messages, configurable); client-side replay on connection loss <5s; distinct session IDs per tab (`crypto.randomUUID()` stored in `sessionStorage`).
- Add tests: [src/server/adapters/nextjs/__tests__/resilience.test.ts](src/server/adapters/nextjs/__tests__/resilience.test.ts), [src/react/hooks/__tests__/resilience.test.ts](src/react/hooks/__tests__/resilience.test.ts).

**Depends on:** 1H, 3D.
**Blocks:** Nothing.
**Acceptance:** 429 from LLM provider → 3 retries before surfacing; tool that hangs >30s → `tool/timeout` error; page refresh → last messages restored; two browser tabs → distinct session IDs in network requests.

---

### 3G — Test helpers: `MockLanguageModel` + `createTestChat()`

**Version:** 0.5.0
**Breaking?** No (additive — `src/server/testing` already exists).

**Files:**
- Create: [src/server/testing/mock-language-model.ts](src/server/testing/mock-language-model.ts) — implements the `ai@^6` `LanguageModelV2` interface. Scriptable via `respond({ text, toolCalls })`.
- Create: [src/server/testing/create-test-chat.ts](src/server/testing/create-test-chat.ts) — assembles a `createChatHandler` instance with the mock model + caller-provided tools; returns `{ sendMessage, getCalls, getStream }`.
- Create: [src/server/testing/__tests__/create-test-chat.test.ts](src/server/testing/__tests__/create-test-chat.test.ts) — meta-test: assembles a 2-tool chat, scripts a tool call, asserts the tool was invoked with the expected input.
- Modify: [src/server/testing/index.ts](src/server/testing/index.ts) — re-export new helpers.

**Depends on:** 1F surface (so test chats can register `defineTool` outputs).
**Blocks:** Nothing in the SDK; unblocks consumer test refactors.
**Acceptance:** A consumer can write a test that imports their `defineTool`-authored route, feeds it to `createTestChat`, scripts the LLM to call it, and asserts the response — without making any HTTP or LLM-provider calls.

---

### 3H — Codemod: import-rename only

**Version:** 0.5.0
**Breaking?** No (the codemod *executes* a break; it doesn't introduce one).

**Files:**
- Create: [packages/codemod/](packages/codemod/) (separate publish: `glirastes-codemod` on npm) **OR** embed as `bunx glirastes check-upgrade --apply`.
- Renames covered: `defineEndpointTool` → `defineTool`, `createAiPipeline` → `createChatHandler`, `createAiChatHandler` → `createChatHandler`, removal of `createLancer` / `Lancer` imports (warns; flags as manual edit needed only if the user actually constructs one).
- Create: [packages/codemod/__tests__/](packages/codemod/__tests__/) — fixture-based tests for each rename.
- Modify: [src/cli/commands/check-upgrade.ts](src/cli/commands/check-upgrade.ts) — `--apply` flag invokes the codemod.

**Depends on:** 1F (final name `defineTool`), 1E (final name `createChatHandler`), 1B (final removal of `createLancer`).
**Blocks:** 2A/2B in Phase 4 (re-pull), 3I check-upgrade extension.
**Acceptance:** Running the codemod against a fixture using 0.4 names produces a 0.5-compatible source tree that compiles. Idempotent (second run is a no-op).

---

### 3I — `check-upgrade` extension for 0.4 → 0.5

**Version:** 0.5.0
**Breaking?** No (additive).

**Files:**
- Modify: [src/cli/commands/check-upgrade.ts](src/cli/commands/check-upgrade.ts) — detects 0.4-style imports, flags the hook-signature change (which the codemod cannot semantically resolve in all cases), prints a checklist.

**Depends on:** 3H.
**Blocks:** Phase 4 consumer re-pull.
**Acceptance:** Running `bunx glirastes check-upgrade` in a 0.4 consumer prints an actionable upgrade checklist with per-item file:line references.

---

## Phase 4 — Consumer migration (0.5 ready, optional)

Only run if 0.5 delivers value (new skills, debug overlay, resilience defaults) that justifies the churn for `get-it-done` / `apps/citadel`. Decide at the end of 0.5.

### 4A — Re-pull `get-it-done` + `apps/citadel` to 0.5

**Depends on:** Phase 3 complete, 0.5.0 published, decision to migrate (recorded in `docs/migration-notes/0.5-decision.md`).
**Acceptance:** Both consumers on `glirastes@^0.5.0`, codemod run, tests green, optional adoption of headless-hook standalone mode where it simplifies their code.

---

## Phase 5 — Release 0.6 Excellence

Goal: harden the SDK so it stands up to enterprise scrutiny (a11y, CSP, SSR discipline, surface stability, published manifest).

### 5A — A11y pass (WAI-ARIA + NVDA/VoiceOver)

**Version:** 0.6.0
**Breaking?** Minor — some ARIA attribute defaults change; consumers who overrode them via `classNames` props are unaffected.

**Files:**
- Modify: [src/react/components/ai-chat-panel.tsx](src/react/components/ai-chat-panel.tsx) — apply the WAI-ARIA chat pattern (role="log", aria-live="polite", role="group" for the input area, focus-management on open/close).
- Modify: [src/react/components/](src/react/components/) — full keyboard nav (Tab/Shift-Tab cycle, Enter to send, Esc to close, Cmd-K to focus input).
- Manual test pass: NVDA on Windows + VoiceOver on macOS, scripted scenarios documented in [docs/a11y/test-script.md](docs/a11y/test-script.md).
- Flip Phase 0 G4 axe gate from advisory to enforcing.

**Depends on:** 1H, 3D, Phase 0 G4 baseline.
**Blocks:** Nothing.
**Acceptance:** Axe gate (G4) green and enforcing; NVDA + VoiceOver scripts pass; tab order documented and verified.

---

### 5B — CSP / inline-style-free audit

**Version:** 0.6.0
**Breaking?** **BREAKING(0.6)** — any consumer that overrode styles via inline `style=` on glirastes internals will need to migrate to CSS variables.

**Files:**
- Audit: grep `src/react/**/*.tsx` for `style={{` — every occurrence either removed or moved to a CSS variable on the chat root element.
- Modify: [src/react/styles.css](src/react/styles.css) — expose the full set of CSS variables (already partial — formalise the API).
- Create: [scripts/audit-inline-styles.mjs](scripts/audit-inline-styles.mjs) — CI gate; fails on any `style=` in `src/react/**/*.tsx` outside an allowlist.
- Modify: [.github/workflows/test.yml](.github/workflows/test.yml) — run the audit.

**Depends on:** 1H, 5A (a11y often introduces transient styles; settle first).
**Blocks:** Nothing.
**Acceptance:** CSP `default-src 'self'; style-src 'self'` page renders `<AiChat />` correctly with no inline-style violations.

---

### 5C — SSR / RSC boundary enforcement

**Version:** 0.6.0
**Breaking?** No.

**Files:**
- Create: [scripts/audit-rsc-boundaries.mjs](scripts/audit-rsc-boundaries.mjs) — for every file in `src/react/`, assert `'use client'` directive presence/absence matches the intended boundary; assert no server-only import (`fs`, `node:fs`) reaches a client-component path.
- Modify: [src/react/](src/react/) — explicitly mark client/server boundaries; document via JSDoc.
- Modify: [.github/workflows/test.yml](.github/workflows/test.yml) — run the audit.
- Add a Next.js App-Router smoke test in [tests/fixtures/](tests/fixtures/) that imports `glirastes/react` from a server component and asserts no client-only bundle leakage.

**Depends on:** 1H.
**Blocks:** Nothing.
**Acceptance:** Audit green; smoke test green; consumer can import `<AiChat />` from a server component file at the top level (it'll mount client-side, but the import itself shouldn't crash the RSC compiler).

---

### 5D — api-extractor enforcement flip (was advisory in 0.4)

**Version:** 0.6.0
**Breaking?** No (procedural).

**Files:**
- Modify: [.github/workflows/api-extractor.yml](.github/workflows/api-extractor.yml) — `--local` becomes `--ci`; mismatched snapshot fails the build.
- Document: [CONTRIBUTING.md](CONTRIBUTING.md) — every public-symbol change requires `bun run api:check` + committed `.api.md` diff.

**Depends on:** Phase 0 G3 baselined since 0.4 (so we have 2 releases of stable snapshots).
**Blocks:** Nothing.
**Acceptance:** A PR that introduces a public-symbol change without updating `.api.md` fails CI with a clear message pointing at `bun run api:check`.

---

### 5E — `llms.txt`, `AGENTS.md`, JSDoc `@example` on every public export

**Version:** 0.6.0
**Breaking?** No.

**Files:**
- Create: [llms.txt](llms.txt) at repo root + npm-published — manifest of public API in LLM-friendly format.
- Create: [AGENTS.md](AGENTS.md) at repo root — generic agent guidance per design §7 Codex target.
- Audit: every public export in [etc/*.api.md](etc/) has a JSDoc `@example` block. Add what's missing.
- Create: [scripts/audit-jsdoc-examples.mjs](scripts/audit-jsdoc-examples.mjs) — CI gate (advisory in 0.6, enforcing later).

**Depends on:** 5D (api-extractor lists the public surface to check against).
**Blocks:** Nothing.
**Acceptance:** Every public symbol in `.api.md` has an `@example` block; `llms.txt` is regenerated on release; agent IDEs can read `AGENTS.md` and produce working code.

---

### 5F — Trust Manifest published per release

**Version:** 0.6.0 (process change starts here; the file has shipped since 0.4 via 1J)
**Breaking?** No.

**Files:**
- Modify: [.github/workflows/publish.yml](.github/workflows/publish.yml) — fail release if `MANIFEST.md` version header doesn't match the version being tagged.
- Document: [docs/trust/manifest.md](docs/trust/manifest.md) — explanation page linked from README.

**Depends on:** 1J (manifest exists), Phase 0 G2 (validator catches drift).
**Blocks:** Nothing.
**Acceptance:** Every published version on npm carries a `MANIFEST.md` whose version header matches `package.json#version`.

---

## CI Gates summary (cross-reference)

| Gate | Lands | Advisory → Enforcing | Workstream that flips it |
|---|---|---|---|
| G1 — Bundle size <25KB gz core | Phase 0 | 0.4 (after 1H+1I land) | 1H |
| G2 — Trust Manifest validation | Phase 0 | 0.4 (enforcing from land) | 1J |
| G3 — api-extractor snapshot diff | Phase 0 | 0.6 | 5D |
| G4 — A11y axe scan | Phase 0 | 0.6 | 5A |
| G5 — Empty-Cursor e2e skill test | Phase 0 | 0.5 (must be green before 0.5 ships) | 3C |

---

## What's NOT in this roadmap (per user constraints)

Explicitly out of scope. Recorded so future contributors don't fold them in here:

- **Pro auto-generation of tool definitions** (Code-Connect, scan-driven tool authoring).
- **Mode B push** (custom backend agents using only Glirastes UI). Mode B stays supported (`glirastes/react/langgraph` subpath, transports pluggable) but receives no dedicated skills, no DX polish, no marketing.
- **VCR replay / eval-hooks** (test-story phase 2 from Challenge #6).
- **Semantic codemods** beyond the import renames covered in 3H.

---

## Execution notes for the implementer

1. **Phase 0 first, no skips.** Every gate is cheap once written and gives you immediate, durable feedback. Trying to land Phase 1 changes without G1/G2/G3 baselined means you'll discover the breakages in consumer apps instead of in CI.
2. **Within a phase, follow the dependency graph at the top of this doc.** 1A, 1B, 1J have no internal blockers — start them in parallel. 1F is the longest critical path; resource it first.
3. **Each workstream gets its own expand-to-TDD-plan step.** When you start workstream `1F`, invoke `superpowers:writing-plans` to produce a per-task bite-sized plan from this workstream's `Files:` section. This roadmap is the map; the per-workstream plans are the turn-by-turn directions.
4. **Breaking changes must be flagged in the CHANGELOG with the `BREAKING(0.x)` marker matching this doc's headings.** This is what the migration guide is generated from.
5. **Consumer migrations are scheduled after the SDK release that unblocks them ships.** Do not start 2A/2B until 0.4.0 is on npm. Do not start 4A until 0.5.0 is on npm *and* the team has agreed the value is there.
