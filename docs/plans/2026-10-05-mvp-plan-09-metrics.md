# Metriken (FR-7): Event v2, Senke, Ingest, Aggregation und Abfrage-API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat turn of a connected app that passes the handler's entry checks produces exactly one content-free `TechnicalRuntimeEvent` v2 (tokens, cost with provenance, first-token and total latency, outcome, tool ids), delivered asynchronously in batches off the turn path (requests refused before the turn starts, i.e. a malformed body, 401/403 from `managedRuntime` or a 400 from the legacy `guardrails` option, produce none; a custom `streamHandler` reports through `turnMetrics` itself); the Platform ingests it with the app-bound runtime key, rolls it up per hour, keeps it per plan (Free 30, Pro 365 days by default) and answers the Free dashboard and the Pro comparisons through a query API. OpenRouter's `usage.cost` is recorded as `provider-reported` and finally feeds the turn budget's `maxEstimatedCostUsd`.

**Architecture:** Two halves in lockstep, both unpublished. **SDK** (`/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat`, branch `codex/mvp-chat`, from `24b5075`; runs in parallel to P04 in `mvp-tools`): the strict event contract and its golden vectors live in `src/contracts/events.ts`; `src/runtime/metrics/` adds cost resolution (provider metadata, raw usage, or the raw OpenRouter stream chunk, else an explicitly versioned price table, else `null`), a per-turn recorder that maps model-facing tool names to manifest tool ids of the pinned snapshot, and a batching sink that validates, queues and posts with an unref'd timer and never retries. `createAiChatHandler` gains `metrics` and `modelPricing`, turns on `includeRawChunks` for managed or measured turns, records every step and the outcome, passes known costs into `afterModelStep`, and refuses the legacy Lancer `telemetry` (dead `/v1/proctor/events`) together with `managedRuntime`. **Platform** (`/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`, branch `codex/mvp-platform`, **only after P08b is complete there**): migration `0045_runtime_metrics` (raw events and tool usage, hourly aggregates and tool aggregates), SQL helpers in `@glirastes/db` proved on PGlite, a `zod/v4` port of the event schema proved byte-for-byte against the SDK vectors, a `RuntimeMetricsService` (ingest, overview, comparison, retention), two controllers and a BullMQ queue with two repeatable jobs in the Foundation profile, the same pattern as the hourly audit archive.

**Tech Stack:** SDK: TypeScript 5.9 (NodeNext, strict), Zod v4, AI SDK 6.0.161 (`ai`, `ai/test` `MockLanguageModelV3`), `@ai-sdk/openai` 3.0.53 (dev dependency, fake `fetch` only), Vitest 4.1, Bun. Platform: NestJS 11, `@nestjs/bullmq` + BullMQ 5, Drizzle ORM 0.39.3 and drizzle-kit 0.30.6, `@electric-sql/pglite` 0.5.8, zod 3.25.76 with its `zod/v4` subpath, Vitest 3.2 (API), `bun:test` (DB).

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (v1.4) section 7 "Metriken" (all three bullets) and the five-questions row "Was kostet die Nutzung?" (data only; the Citadel view is P08c), section 4.6 "Unbekannte Kosten bleiben `null`, nie 0", section 10 decision 9 (retention configurable, Free 30, Pro 365); roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md row P09 (no "Offene Punkte" row is assigned to P09).

## Global Constraints

- No pushes, merges into `main`/`master`, npm publishes, deployments, or changes to any shared database. All commits stay local on `codex/mvp-chat` and `codex/mvp-platform`. Never connect to Neon: migrations are proved on in-process PGlite, and `drizzle-kit` always runs with `DATABASE_URL=postgres://offline.invalid/unused` so `packages/db/drizzle.config.ts` never loads a `.env` file.
- Never open, print or copy `.env*`, `.secrets/` or `.npmrc` contents. No step needs a real key: the SDK tests use `MockLanguageModelV3` and, once, `@ai-sdk/openai` with a fake `fetch` that serves a recorded OpenRouter stream body (`apiKey: 'not-a-real-key'`, host `openrouter.invalid`). No live OpenRouter, Deepgram or other network call.
- Shell `rm` is denied in this environment and no step needs it: every new file is part of the change; tests clean their temporary directories through Node's `fs` (`fs.rmSync`) or bun's `afterAll`.
- Implementers never edit this plan file and never push.
- TDD: run each RED first, then the minimal change, then GREEN. Do not weaken protections; legacy Lancer code (`src/server/lancer/**`, `TelemetrySink`, `toolsToAiTools` forwarding) stays untouched; only the Foundation path (`managedRuntime`) stops reaching it.
- Patches are applied from the worktree root with `git apply`, which is all-or-nothing. They were generated against the states named in Task 0 and Task 6 and applied cumulatively in task order; if one does not apply, stop and report instead of editing by hand. New files are written with exactly the content shown. The three generated files of Task 7 (`drizzle/0045_runtime_metrics.sql`, `drizzle/meta/0045_snapshot.json`, the journal entry) come from `drizzle-kit generate`, never from hand edits.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution.
- Agent shells reset the working directory between calls: every bash block below starts with an absolute `cd`.
- SDK files P04 touches in parallel (`src/codegen/**`, `src/browser/**`, `src/react/ui*`, `src/contracts/revisions.ts`, `src/contracts/app-setup.ts`, `src/sync/**`) are not touched here. Two shared index files get additive blocks only (merge note in the Self-Review).
- Content boundary: an event carries numbers, enums, uuids and technical labels (`/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/`) only. No prompts, messages, tool names, tool arguments, tool results, error messages, provider payloads or secrets; both schemas are `.strict()`, both run the sensitive-string patterns (`Bearer …`, `sk-…`/`sk-or-v1-…`, PEM keys), and the SDK additionally runs `findForbiddenPlatformContentPath` over the whole event.
- Cost: provider-reported (OpenRouter `usage.cost`) wins; else a configured, versioned price table (`source: 'price-table'`, `pricingVersion` set); else `{ usd: null, source: null, pricingVersion: null }`. Unknown is never 0. A turn is known only when every step is known.
- The sink never blocks and never fails a turn: `record` is synchronous, validates, queues (at most 1,000) and returns; delivery happens on an unref'd 5 s interval or when 50 events are waiting; a failed, rejected or timed-out (5 s) request drops its batch; nothing retries; `onDrop` receives only `{ reason, count }`.
- Platform: the ingest route accepts only an app-bound key with the `runtime` scope whose app equals the path app; the environment must belong to that tenant and app; events of another app or environment are refused as a whole batch; events older than 24 h or more than 5 min ahead are counted as `rejected`; a repeated `eventId` never counts twice. No Citadel UI (P08c).
- Retention is an open product decision (spec 7): `RUNTIME_METRICS_RETENTION_FREE_DAYS` (default 30) and `RUNTIME_METRICS_RETENTION_PRO_DAYS` (default 365, also used for `enterprise` and `platform`); raw events are kept 7 days for late aggregation only.
- Commands: SDK tests `./node_modules/.bin/vitest run <path>`; SDK gates `bun run typecheck`, `bun run build`, `bun run typecheck:tests` (after the build, it reads `dist/`), `bun run test`. Platform API tests `./node_modules/.bin/vitest run <path>` in `apps/api`; API typecheck `bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"` (it reads `@glirastes/db` from `packages/db/dist`, rebuilt with `./node_modules/.bin/tsc -p tsconfig.json` in `packages/db` whenever a task changes the DB package); DB `bun test` in `packages/db`.

### Decisions taken in this plan (veto possible)

| Topic | Decision | Why |
| --- | --- | --- |
| Event shape | `schemaVersion: 2`, `eventType: 'turn.finished'`, one event per turn: `eventId`, `occurredAt` (turn end), `appId`, `environmentId`, `buildId \| null`, `instanceId`, `revisionId \| null`, `model \| null`, `status` (`completed`/`safety-stop`/`aborted`/`error`), `errorCode` (`model_error`/`pipeline_error` for `error`, `budget_exhausted`/`step_limit` for `safety-stop`, otherwise `null`), `inputTokens`, `outputTokens`, `cost {usd, source, pricingVersion}`, `latency {firstTokenMs \| null, totalMs}`, `toolCallCount`, `toolErrorCount`, `tools[] {toolId, calls, errors}` (≤ 32, the most used) | Spec 7 field list; closed enums instead of free error text keep the boundary provable; 32 tools bound the event size while the totals still count every call. `tool_contract_rejected` (spec 4.7) is a separate event type for P05, added to both enums in lockstep. |
| `revisionId` | The pinned snapshot's `agentRevision.revisionId` | The agent revision pins manifest and policy; in managed mode it is the Platform revision (P02 `platformRevisions`), in standalone a derived id. Pro compares it as "Version". |
| `model` | The requested model id of the step (`step.model.modelId`), else the served one (`response.modelId`); non-labels become `null` | Stable for comparisons and price-table lookups; a free-text id cannot leak. |
| `buildId` / `instanceId` | `GLIRASTES_BUILD_ID` (optional, else `null`) / a random uuid per sink unless given; one sink per process, created at module scope (Get It Done builds its handler per request, so P11 must not create the sink inside that factory) | No build system is assumed; an instance id must never be a hostname or user value. A sink per request would draw a new `instanceId` per turn and turn every hourly row into a single turn. |
| Where OpenRouter's cost comes from | `providerMetadata.openrouter.usage.cost` (official provider) → `usage.raw.cost` → `usage.cost` of the raw stream chunk; the handler sets `includeRawChunks` for managed or measured turns | Measured with `@ai-sdk/openai` 3.0.53 against a recorded OpenRouter stream: the provider's zod chunk schema strips `cost` from `usage.raw`, only the raw chunk keeps it (Task 5 test). `toUIMessageStream` drops raw chunks, so nothing reaches the browser. |
| Budget | Every known step cost is passed to `ManagedTurnGuard.afterModelStep({ estimatedCostUsd })` | `src/runtime/budget.ts` had `recordEstimatedCost` but the handler never called it, so `maxEstimatedCostUsd` could not trigger. |
| Legacy telemetry | `createAiChatHandler` throws when `managedRuntime` and `telemetry` are combined; without `managedRuntime` nothing changes | The Lancer buffer posts to `/v1/proctor/events`, which the Foundation profile never mounts, and its `tool.failed` payload carries error messages. Lancer itself is not shipped (`!dist/server/lancer`). |
| Handler option | Top-level `metrics?: RuntimeMetricsSink` and `modelPricing?: RuntimePriceTable`; a custom `streamHandler` gets `turnMetrics` and `modelPricing` in its context and reports itself | The default stream handler is the Foundation path (GID); a custom handler owns `streamText` and must feed the recorder. |
| Delivery | Batches of ≤ 50 (`TechnicalRuntimeEventBatch { schemaVersion: 2, events }`), every 5 s, queue ≤ 1,000, timeout 5 s, no retry | "bei Ausfall verworfen, nie blockierend" (spec 7); 50 events stay far below the API's 256 KB body limit. Spec 4.12 "kein Netz pro Turn" still holds on the turn path: `record` never touches the network, Standalone has no sink at all, and in Connected mode these batches are the only Platform traffic the chat causes. |
| Ingest | `POST /v1/runtime/apps/:appId/environments/:environmentId/metrics/events`, `CompositeAuthGuard`, `@RequireScopes('runtime')`, 202 `{ accepted, duplicates, rejected }` | Same path family and credential rule as the runner routes (`RuntimeConnectionService.assertCredentialScope`); replaces the never-mounted Proctor endpoint. |
| Storage | `runtime_metric_events` + `runtime_metric_tool_events` (raw, 7 days), `runtime_metric_hourly` + `runtime_metric_tool_hourly` (per tenant, app, environment, UTC hour, build, instance, revision, model; `UNIQUE NULLS NOT DISTINCT`), all cascading with the environment | Hourly rows answer every query; raw rows exist only so late events can be re-aggregated. |
| Aggregation | BullMQ queue `runtime-metrics`: job `aggregate` every 10 min recomputes the last 26 hours from raw events (idempotent upsert), job `prune` daily at 03:17 (BullMQ evaluates the cron pattern in the API process's time zone, UTC in the container); fixed job ids | Same repeatable-job pattern as `AuditModule` (`audit-archive-hourly`) and the always-loaded `AuthModule` (`api-key-last-used-flush`), the BullMQ uses that run in the Foundation profile. 26 h covers the 24 h ingest window; 10 min keeps the dashboard fresh. Buckets are hourly, as the spec asks. |
| Latency in ranges | Per hour: p50, p95 and max; across hours: averages and the highest hourly p95 | Percentiles cannot be summed; the highest hourly p95 is an honest upper bound for a range. |
| Query API | `GET /v2/apps/:appId/metrics` (management scope; filters `environmentId`, `buildId`, `instanceId`, `revisionId`, `model`, `from`, `to`, `granularity`; totals, series, top 20 tools; default range 7 days, hourly up to 48 h, else daily) and `GET /v2/apps/:appId/metrics/compare?by=environment\|build\|instance\|revision\|model\|tool` (`@RequirePlan('pro')`); an app-bound key reads only its own app (`appScopeFor`, P08b Task 12) | Spec 7: Free dashboard per app/environment, Pro comparisons and longer history. The range is clamped to the plan's retention. |
| Migration number | `0045_runtime_metrics` | Next free index after P08b's `0044`. Spec 4.10.11 names `0045_tool_generation_jobs` for P10; P10 takes `0046`. |

## Review Focus

1. **Nothing but numbers leaves the app.** No prompt, message, tool name, argument, result, provider error text or secret reaches an event, a batch or the Platform tables; both schemas refuse extra keys, free text and secret-looking strings with the same vectors. Pinned in Task 1 Step 1 (vectors `invalid/extra-prompt-key`, `invalid/free-text-model`, `invalid/secret-in-build-id`, `invalid/tool-arguments`, `invalid/tool-name-instead-of-id`), Task 5 Step 1 (a secret phrase in the prompt, the tool input, the tool result, the tool error and the provider error never appears in the event), Task 9 Step 1 (the Platform accepts and refuses exactly the SDK vectors, pinned by digest) and Task 10 Step 1 (ingest refuses raw content and never echoes values).
2. **Metrics never block or fail a turn.** `record` returns at once while the Platform hangs, drops after the timeout, bounds its queue, never retries and never throws; a throwing sink leaves the chat response untouched. Pinned in Task 3 Step 1 (failing sink), Task 4 Step 1 (hanging, rejecting and failing Platform, queue bound, `record(null)`) and Task 5 Step 1 (failing sink, full response).
3. **Cost provenance is right for the real provider.** OpenRouter's `usage.cost` through `createOpenAI({ baseURL })` (the Get It Done setup) is `provider-reported`; a price table only fills gaps and names its version; unknown stays `null`, never 0; a known cost stops the turn at `maxEstimatedCostUsd`. Pinned in Task 2 Step 1 and Task 5 Step 1 (`reads OpenRouter usage.cost through the OpenAI-compatible provider of Get It Done`, `feeds a known cost into the runtime budget …`, `keeps an unreported, unpriced cost unknown`).
4. **Only the app's own runtime key reports, once per event.** A key of another app, a tenant-wide key, another tenant's key and a dashboard session are refused; an environment of another app answers 404; events for another environment refuse the batch; stale and future events count as rejected; a repeated event never counts twice. Pinned in Task 8 Step 1 (`stores each event once …`), Task 10 Step 1 (ingest cases) and Task 11 Step 1 (route metadata and controller wiring).
5. **Aggregates and retention are correct and isolated.** A late event recomputes its hour without duplicate rows; hours outside the window stay; Free keeps 30 days, Pro 365, raw events 7; queries never return another tenant's data; the query range is clamped to the plan; a Free tenant cannot compare. Pinned in Task 7 Step 1 (constraints, cascade), Task 8 Step 1 (aggregation, queries, retention) and Task 10 Step 1 (range clamping), Task 11 Step 1 (Pro gate).

---

## File Structure

**SDK** (paths relative to `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat`):

| File | Action | Responsibility |
| --- | --- | --- |
| `src/contracts/events.ts` | Modify (Task 1) | v1 unchanged; `TechnicalRuntimeEventV2Schema`, batch schema, limits, label patterns |
| `src/contracts/index.ts` | Modify (Task 1) | Export the v2 contract |
| `src/contracts/__vectors__/runtime-metric-event.v2.json` | Create (Task 1) | Golden vectors shared with the Platform (10 valid, 31 invalid), sha256 `73c5cf4f…ab17d` |
| `src/contracts/__tests__/runtime-metric-event.test.ts` | Create (Task 1) | Vectors, digest pin, limits, v1 unchanged |
| `src/runtime/metrics/cost.ts` (+ `cost.test.ts`) | Create (Task 2) | Price table, raw-chunk and provider cost, step and turn cost |
| `src/runtime/metrics/turn-recorder.ts` (+ test) | Create (Task 3) | `RuntimeMetricsSink` contract, `createTurnMetricsRecorder` |
| `src/runtime/metrics/sink.ts` (+ test) | Create (Task 4) | `createRuntimeMetricsSink`, `createRuntimeMetricsSinkFromEnv` |
| `src/runtime/index.ts` | Modify (Tasks 2–4) | Three appended export blocks |
| `src/server/adapters/nextjs/create-ai-chat-handler.ts`, `types.ts` | Modify (Task 5) | `metrics`, `modelPricing`, raw chunks, budget cost, telemetry refusal |
| `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts` | Create (Task 5) | Handler end to end with `MockLanguageModelV3` and the fake OpenRouter stream |
| `docs/managed-runtime-sync.md` | Modify (Task 5) | "Runtime metrics" section |

**Platform** (paths relative to `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`):

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/db/src/schema/runtime-metrics.ts`, `src/schema/index.ts` | Create / modify (Task 7) | Four tables |
| `packages/db/drizzle/0045_runtime_metrics.sql`, `meta/0045_snapshot.json`, `meta/_journal.json` | Generate (Task 7) | Migration via `drizzle-kit generate` |
| `packages/db/src/__tests__/runtime-metrics-migration.test.ts`, `packages/db/MIGRATIONS.md` | Create / modify (Task 7) | Generated, additive, constraints, cascade; runbook names `0045` |
| `packages/db/src/lib/runtime-metrics.ts` (+ `src/__tests__/runtime-metrics.test.ts`), `packages/db/src/index.ts` | Create / modify (Task 8) | Insert, aggregate, prune, query (PGlite-proved) |
| `apps/api/src/modules/runtime-metrics/runtime-metric-event.schema.ts`, `__vectors__/runtime-metric-event.v2.json`, `__tests__/runtime-metric-event-vectors.spec.ts` | Create / copy (Task 9) | `zod/v4` port with vector parity |
| `apps/api/src/modules/runtime-metrics/runtime-metrics.retention.ts`, `runtime-metrics.store.ts`, `drizzle-runtime-metrics.store.ts`, `runtime-metrics.service.ts`, `__tests__/runtime-metrics.service.spec.ts` | Create (Task 10) | Ingest, overview, comparison, retention config |
| `apps/api/src/modules/runtime-metrics/runtime-metrics-ingest.controller.ts`, `runtime-metrics.controller.ts`, `runtime-metrics.jobs.ts`, `runtime-metrics.module.ts`, `apps/api/src/workers/runtime-metrics.worker.ts`, `__tests__/runtime-metrics.http.spec.ts`, `__tests__/runtime-metrics.module.spec.ts` | Create (Task 11) | Routes, queue, repeatable jobs, worker |
| `apps/api/src/product-profile.ts`, `product-profile.spec.ts` | Modify (Task 11) | `RuntimeMetricsModule` in the Foundation profile |

---

## Part A: SDK (`mvp-chat`, parallel to P04)

All commands of Tasks 0–5 run in `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat`.

### Task 0: Verify the SDK baseline (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Preconditions**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git branch --show-current
git rev-parse --short HEAD
git status --short | wc -l
```

Expected: `codex/mvp-chat`, `24b5075`, `0`. Anything else (for example P07b already landed here): stop and report, the patches below were generated against `24b5075`.

- [ ] **Step 2: Baseline gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run build > /dev/null 2>&1; echo "build=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run typecheck:tests > /dev/null 2>&1; echo "typecheck:tests=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run test 2>&1 | grep -E "Test Files|Tests "
```

Expected: `typecheck=0`, `build=0`, `typecheck:tests=0`, `Test Files  192 passed (192)`, `Tests  1930 passed (1930)` (measured on 2026-10-05 in a `git archive` copy of `24b5075`). Under heavy machine load (load average above about 20) a few tests outside P09 can exceed their 5 s budget in the full parallel run: `src/codegen/tools/schema-probe.test.ts` ("times out a hanging module …"), `src/codegen/tools/program.test.ts`, `src/codegen/tools/handler-analysis.test.ts` and `src/embed/__tests__/embed-module.test.ts` ("can be imported where no DOM exists …"). Then rerun that file alone (it must pass; measured 61 of 61 at load 32) or the whole suite with fewer workers, `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run --maxWorkers=4 2>&1 | grep -E "Test Files|Tests "` (measured green at load 25–33; at load 37–40 even four workers timed out in `handler-analysis` and `schema-probe`, so the deciding check is the four files run alone together: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/codegen/tools/handler-analysis.test.ts src/codegen/tools/schema-probe.test.ts src/codegen/tools/program.test.ts src/embed/__tests__/embed-module.test.ts 2>&1 | grep -E "Test Files|Tests "` gives `Test Files  4 passed (4)`, `Tests  61 passed (61)`, measured at load 37). No P09 file touches them, and a failure in any other file is a real failure.

### Task 1: The content-free runtime metric event v2 and its golden vectors

**Files:**
- Create: `src/contracts/__vectors__/runtime-metric-event.v2.json`
- Create: `src/contracts/__tests__/runtime-metric-event.test.ts`
- Modify (whole file): `src/contracts/events.ts` (37 lines today: imports and the v1 schema, kept verbatim)
- Modify: `src/contracts/index.ts:50-51` (the two `./events.js` export lines)

**Interfaces:**
- Consumes: `findForbiddenContentPath`, `findForbiddenPlatformContentPath` (`src/contracts/content-boundary.ts`).
- Produces (all exported from `glirastes/contracts`):
  - `RUNTIME_METRIC_EVENT_SCHEMA_VERSION = 2`, `RUNTIME_METRIC_MAX_BATCH = 50`, `RUNTIME_METRIC_MAX_TOOLS = 32`, `RUNTIME_METRIC_MAX_COUNT = 2_147_483_647`
  - `RUNTIME_METRIC_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/`, `RUNTIME_PRICING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`
  - `RuntimeTurnStatusSchema` (`'completed' | 'safety-stop' | 'aborted' | 'error'`), `RuntimeTurnErrorCodeSchema` (`'model_error' | 'pipeline_error' | 'budget_exhausted' | 'step_limit'`), `RuntimeCostSourceSchema` (`'provider-reported' | 'price-table'`)
  - `RuntimeTurnCostSchema` → `RuntimeTurnCost = { usd: number | null; source: RuntimeCostSource | null; pricingVersion: string | null }`
  - `RuntimeTurnToolUsageSchema` → `RuntimeTurnToolUsage = { toolId: string; calls: number; errors: number }`
  - `TechnicalRuntimeEventV2Schema` → `TechnicalRuntimeEventV2`; `TechnicalRuntimeEventBatchSchema` → `TechnicalRuntimeEventBatch = { schemaVersion: 2; events: TechnicalRuntimeEventV2[] }`
  - Types `RuntimeTurnStatus`, `RuntimeTurnErrorCode`, `RuntimeCostSource`. `TechnicalRuntimeEventSchema`/`TechnicalRuntimeEvent` (v1) unchanged.

- [ ] **Step 1: Write the vectors and the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/contracts/__vectors__/runtime-metric-event.v2.json`:

```json
{
  "schemaVersion": 2,
  "base": {
    "schemaVersion": 2,
    "eventId": "019fb900-0000-7000-8000-000000000001",
    "eventType": "turn.finished",
    "occurredAt": "2026-10-05T10:15:30.000Z",
    "appId": "019fb900-0000-7000-8000-0000000000a1",
    "environmentId": "019fb900-0000-7000-8000-0000000000e1",
    "buildId": "git:4f2c9e1",
    "instanceId": "web-1",
    "revisionId": "019fb900-0000-7000-8000-0000000000b1",
    "model": "anthropic/claude-sonnet-5.5",
    "status": "completed",
    "errorCode": null,
    "inputTokens": 1200,
    "outputTokens": 240,
    "cost": { "usd": 0.0048, "source": "provider-reported", "pricingVersion": null },
    "latency": { "firstTokenMs": 420, "totalMs": 1830 },
    "toolCallCount": 3,
    "toolErrorCount": 1,
    "tools": [
      { "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 2, "errors": 1 },
      { "toolId": "019fb900-0000-7000-8000-0000000000c2", "calls": 1, "errors": 0 }
    ]
  },
  "valid": [
    { "name": "valid/base-provider-reported-cost", "patch": {} },
    {
      "name": "valid/price-table-cost",
      "patch": { "cost": { "usd": 0.0036, "source": "price-table", "pricingVersion": "openrouter-2026-10-04" } }
    },
    {
      "name": "valid/pipeline-error-before-any-model-step",
      "patch": {
        "status": "error", "errorCode": "pipeline_error", "model": null,
        "inputTokens": 0, "outputTokens": 0,
        "cost": { "usd": null, "source": null, "pricingVersion": null },
        "latency": { "firstTokenMs": null, "totalMs": 12 },
        "toolCallCount": 0, "toolErrorCount": 0, "tools": []
      }
    },
    { "name": "valid/model-error", "patch": { "status": "error", "errorCode": "model_error" } },
    { "name": "valid/safety-stop-budget", "patch": { "status": "safety-stop", "errorCode": "budget_exhausted" } },
    { "name": "valid/safety-stop-steps", "patch": { "status": "safety-stop", "errorCode": "step_limit" } },
    { "name": "valid/aborted", "patch": { "status": "aborted", "errorCode": null } },
    { "name": "valid/standalone-without-build-or-revision", "patch": { "buildId": null, "revisionId": null } },
    { "name": "valid/offset-timestamp", "patch": { "occurredAt": "2026-10-05T12:15:30.000+02:00" } },
    {
      "name": "valid/built-in-tools-only-counted",
      "patch": { "toolCallCount": 4, "toolErrorCount": 2 }
    }
  ],
  "invalid": [
    { "name": "invalid/schema-version-1", "patch": { "schemaVersion": 1 } },
    { "name": "invalid/unknown-event-type", "patch": { "eventType": "run.completed" } },
    { "name": "invalid/extra-prompt-key", "patch": { "prompt": "Zeige meine Aufgaben" } },
    { "name": "invalid/extra-metadata-key", "patch": { "metadata": { "rollout": "stable" } } },
    { "name": "invalid/free-text-model", "patch": { "model": "show me all my tasks" } },
    { "name": "invalid/secret-in-build-id", "patch": { "buildId": "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789" } },
    { "name": "invalid/bearer-in-instance-id", "patch": { "instanceId": "Bearer abcdefghijklmnopqrstuvwxyz" } },
    { "name": "invalid/uuid-with-wrong-variant", "patch": { "eventId": "019fb900-0000-7000-0000-000000000001" } },
    { "name": "invalid/timestamp-without-offset", "patch": { "occurredAt": "2026-10-05T10:15:30" } },
    { "name": "invalid/negative-tokens", "patch": { "inputTokens": -1 } },
    { "name": "invalid/fractional-tokens", "patch": { "outputTokens": 1.5 } },
    { "name": "invalid/tokens-beyond-integer", "patch": { "inputTokens": 2147483648 } },
    { "name": "invalid/unknown-cost-as-zero", "patch": { "cost": { "usd": 0, "source": null, "pricingVersion": null } } },
    { "name": "invalid/source-without-amount", "patch": { "cost": { "usd": null, "source": "provider-reported", "pricingVersion": null } } },
    { "name": "invalid/price-table-without-version", "patch": { "cost": { "usd": 0.01, "source": "price-table", "pricingVersion": null } } },
    { "name": "invalid/provider-cost-with-version", "patch": { "cost": { "usd": 0.01, "source": "provider-reported", "pricingVersion": "v1" } } },
    { "name": "invalid/negative-cost", "patch": { "cost": { "usd": -0.01, "source": "provider-reported", "pricingVersion": null } } },
    { "name": "invalid/error-without-code", "patch": { "status": "error", "errorCode": null } },
    { "name": "invalid/error-with-safety-code", "patch": { "status": "error", "errorCode": "step_limit" } },
    { "name": "invalid/completed-with-code", "patch": { "errorCode": "model_error" } },
    { "name": "invalid/aborted-with-code", "patch": { "status": "aborted", "errorCode": "model_error" } },
    { "name": "invalid/first-token-after-end", "patch": { "latency": { "firstTokenMs": 2000, "totalMs": 1830 } } },
    { "name": "invalid/latency-beyond-a-day", "patch": { "latency": { "firstTokenMs": null, "totalMs": 86400001 } } },
    { "name": "invalid/more-errors-than-calls", "patch": { "toolCallCount": 1, "toolErrorCount": 2, "tools": [] } },
    {
      "name": "invalid/tool-errors-exceed-tool-calls",
      "patch": { "tools": [{ "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 1, "errors": 2 }] }
    },
    {
      "name": "invalid/duplicate-tool",
      "patch": { "tools": [
        { "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 1, "errors": 0 },
        { "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 1, "errors": 0 }
      ] }
    },
    {
      "name": "invalid/tools-exceed-turn-totals",
      "patch": { "toolCallCount": 1, "toolErrorCount": 0, "tools": [{ "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 2, "errors": 0 }] }
    },
    {
      "name": "invalid/tool-arguments",
      "patch": { "tools": [{ "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 1, "errors": 0, "arguments": { "title": "Bericht" } }] }
    },
    {
      "name": "invalid/tool-name-instead-of-id",
      "patch": { "tools": [{ "toolId": "tasks.list", "calls": 1, "errors": 0 }] }
    },
    {
      "name": "invalid/tool-without-calls",
      "patch": { "tools": [{ "toolId": "019fb900-0000-7000-8000-0000000000c1", "calls": 0, "errors": 0 }] }
    },
    { "name": "invalid/unknown-error-code", "patch": { "status": "error", "errorCode": "timeout" } }
  ]
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/contracts/__tests__/runtime-metric-event.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
 * The Platform keeps a byte-identical copy (`apps/api/src/modules/
 * runtime-metrics/__vectors__/`) and pins the same digest. Changing a vector
 * means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '73c5cf4f8d95e8968e11dd6cf921e8b88d387b7d75f056aa91e4bc2b614ab17d';
const raw = readFileSync(
  new URL('../__vectors__/runtime-metric-event.v2.json', import.meta.url),
);
const vectors = JSON.parse(raw.toString('utf8')) as MetricEventVectors;

const eventOf = (patch: Record<string, unknown>) => ({ ...vectors.base, ...patch });

describe('TechnicalRuntimeEvent v2 golden vectors', () => {
  it('pins the vectors the Platform copies', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
  });

  it('names every vector uniquely and covers both outcomes', () => {
    const names = [...vectors.valid, ...vectors.invalid].map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    expect(vectors.valid).toHaveLength(10);
    expect(vectors.invalid).toHaveLength(31);
  });

  it.each(vectors.valid.map((vector) => [vector.name, vector.patch] as const))(
    'accepts %s',
    (_name, patch) => {
      expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf(patch)).success).toBe(true);
    },
  );

  it.each(vectors.invalid.map((vector) => [vector.name, vector.patch] as const))(
    'rejects %s',
    (_name, patch) => {
      expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf(patch)).success).toBe(false);
    },
  );
});

describe('TechnicalRuntimeEvent v2 limits', () => {
  const tool = (index: number) => ({
    toolId: `019fb900-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
    calls: 1,
    errors: 0,
  });

  it('lists at most 32 distinct tools per turn', () => {
    const tools = Array.from({ length: RUNTIME_METRIC_MAX_TOOLS + 1 }, (_, index) => tool(index + 1));
    expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf({
      toolCallCount: tools.length,
      toolErrorCount: 0,
      tools: tools.slice(0, RUNTIME_METRIC_MAX_TOOLS),
    })).success).toBe(true);
    expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf({
      toolCallCount: tools.length,
      toolErrorCount: 0,
      tools,
    })).success).toBe(false);
  });

  it('batches between 1 and 50 events of the same schema version', () => {
    const events = Array.from({ length: RUNTIME_METRIC_MAX_BATCH }, () => vectors.base);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events }).success)
      .toBe(true);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [] }).success)
      .toBe(false);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({
      schemaVersion: 2,
      events: [...events, vectors.base],
    }).success).toBe(false);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({
      schemaVersion: 2,
      events: [vectors.base],
      tenantId: '019fb900-0000-7000-8000-0000000000f1',
    }).success).toBe(false);
  });

  it('keeps the v1 event contract unchanged', () => {
    expect(TechnicalRuntimeEventSchema.safeParse({
      eventId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3930',
      occurredAt: '2026-07-28T20:00:00.000Z',
      eventType: 'run.completed',
      tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3931',
      targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3932',
      environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3933',
      runId: 'run-1',
      status: 'completed',
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/contracts/__tests__/runtime-metric-event.test.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  1 failed (1)`, `Tests  43 failed | 3 passed (46)` (the digest pin, the vector-name check and the unchanged v1 contract pass; every v2 assertion fails with `Cannot read properties of undefined (reading 'safeParse')`).

- [ ] **Step 3: Implement the schema**

Replace the whole file `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/contracts/events.ts`:

```ts
import { z } from 'zod';
import {
  findForbiddenContentPath,
  findForbiddenPlatformContentPath,
} from './content-boundary.js';

export const TechnicalRuntimeEventSchema = z.object({
  eventId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  eventType: z.string().trim().min(1).max(100),
  tenantId: z.uuid(),
  targetAppId: z.uuid(),
  environmentId: z.uuid(),
  agentRevisionId: z.uuid().optional(),
  policyRevisionId: z.uuid().optional(),
  manifestRevisionId: z.uuid().optional(),
  runId: z.string().trim().min(1).max(200),
  status: z.string().trim().min(1).max(100),
  durationMs: z.number().int().nonnegative().optional(),
  errorClass: z.string().trim().min(1).max(200).optional(),
  budget: z.object({
    modelSteps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
  }).strict().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((event, context) => {
  const path = findForbiddenContentPath(event.metadata, ['metadata']);
  if (path) {
    context.addIssue({
      code: 'custom',
      message: 'Technical runtime events must not contain business content or credentials',
      path,
    });
  }
});

export type TechnicalRuntimeEvent = z.infer<typeof TechnicalRuntimeEventSchema>;

// ---------------------------------------------------------------------------
// TechnicalRuntimeEvent v2: one content-free metric event per chat turn
// ---------------------------------------------------------------------------

export const RUNTIME_METRIC_EVENT_SCHEMA_VERSION = 2;
/** Most events one ingest request carries (keeps a batch far below 256 KB). */
export const RUNTIME_METRIC_MAX_BATCH = 50;
/** Most distinct tools one turn event lists; further tools only count. */
export const RUNTIME_METRIC_MAX_TOOLS = 32;
/** Largest count or token number a metric carries (Postgres `integer`). */
export const RUNTIME_METRIC_MAX_COUNT = 2_147_483_647;

/**
 * A technical label (model slug, build id, instance id): no whitespace, no
 * quotes, at most 200 characters. Free text cannot pass.
 */
export const RUNTIME_METRIC_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
export const RUNTIME_PRICING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const metricLabel = z.string().regex(RUNTIME_METRIC_LABEL_PATTERN);
const metricCount = z.number().int().nonnegative().max(RUNTIME_METRIC_MAX_COUNT);
const callCount = z.number().int().nonnegative().max(10_000);
const durationMs = z.number().int().nonnegative().max(86_400_000);

export const RuntimeTurnStatusSchema = z.enum([
  'completed',
  'safety-stop',
  'aborted',
  'error',
]);
export const RuntimeTurnErrorCodeSchema = z.enum([
  'model_error',
  'pipeline_error',
  'budget_exhausted',
  'step_limit',
]);
export const RuntimeCostSourceSchema = z.enum(['provider-reported', 'price-table']);

const ERROR_CODES_BY_STATUS: Partial<Record<
  z.infer<typeof RuntimeTurnStatusSchema>,
  ReadonlyArray<z.infer<typeof RuntimeTurnErrorCodeSchema>>
>> = {
  error: ['model_error', 'pipeline_error'],
  'safety-stop': ['budget_exhausted', 'step_limit'],
};

/**
 * Cost of a turn with its provenance. Unknown stays `null`, never 0: a
 * provider-reported amount (OpenRouter `usage.cost`) or a price-table
 * estimate that names its pricing version.
 */
export const RuntimeTurnCostSchema = z.object({
  usd: z.number().finite().nonnegative().max(1_000_000).nullable(),
  source: RuntimeCostSourceSchema.nullable(),
  pricingVersion: z.string().regex(RUNTIME_PRICING_VERSION_PATTERN).nullable(),
}).strict().superRefine((cost, context) => {
  if ((cost.usd === null) !== (cost.source === null)) {
    context.addIssue({
      code: 'custom',
      message: 'A cost amount and its source are known together or not at all',
      path: ['source'],
    });
  }
  if ((cost.source === 'price-table') !== (cost.pricingVersion !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'Exactly a price-table cost names its pricing version',
      path: ['pricingVersion'],
    });
  }
});

export const RuntimeTurnToolUsageSchema = z.object({
  toolId: z.uuid(),
  calls: callCount.min(1),
  errors: callCount,
}).strict().refine((usage) => usage.errors <= usage.calls, {
  message: 'A tool cannot fail more often than it was called',
  path: ['errors'],
});

export const TechnicalRuntimeEventV2Schema = z.object({
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  eventId: z.uuid(),
  eventType: z.literal('turn.finished'),
  occurredAt: z.iso.datetime({ offset: true }),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: metricLabel.nullable(),
  instanceId: metricLabel,
  revisionId: z.uuid().nullable(),
  model: metricLabel.nullable(),
  status: RuntimeTurnStatusSchema,
  errorCode: RuntimeTurnErrorCodeSchema.nullable(),
  inputTokens: metricCount,
  outputTokens: metricCount,
  cost: RuntimeTurnCostSchema,
  latency: z.object({
    firstTokenMs: durationMs.nullable(),
    totalMs: durationMs,
  }).strict(),
  toolCallCount: callCount,
  toolErrorCount: callCount,
  tools: z.array(RuntimeTurnToolUsageSchema).max(RUNTIME_METRIC_MAX_TOOLS),
}).strict().superRefine((event, context) => {
  const allowed = ERROR_CODES_BY_STATUS[event.status];
  if (allowed ? !event.errorCode || !allowed.includes(event.errorCode) : event.errorCode !== null) {
    context.addIssue({
      code: 'custom',
      message: 'The error code does not match the turn status',
      path: ['errorCode'],
    });
  }
  if (
    event.latency.firstTokenMs !== null
    && event.latency.firstTokenMs > event.latency.totalMs
  ) {
    context.addIssue({
      code: 'custom',
      message: 'The first token cannot arrive after the turn ended',
      path: ['latency', 'firstTokenMs'],
    });
  }
  if (event.toolErrorCount > event.toolCallCount) {
    context.addIssue({
      code: 'custom',
      message: 'A turn cannot have more failed than started tool calls',
      path: ['toolErrorCount'],
    });
  }
  const toolIds = event.tools.map((tool) => tool.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'Each tool is listed once',
      path: ['tools'],
    });
  }
  const listedCalls = event.tools.reduce((sum, tool) => sum + tool.calls, 0);
  const listedErrors = event.tools.reduce((sum, tool) => sum + tool.errors, 0);
  if (listedCalls > event.toolCallCount || listedErrors > event.toolErrorCount) {
    context.addIssue({
      code: 'custom',
      message: 'Listed tools cannot exceed the turn totals',
      path: ['tools'],
    });
  }
  const forbidden = findForbiddenPlatformContentPath(event);
  if (forbidden) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime metric events must not contain content or credentials',
      path: forbidden,
    });
  }
});

export type TechnicalRuntimeEventV2 = z.infer<typeof TechnicalRuntimeEventV2Schema>;
export type RuntimeTurnStatus = z.infer<typeof RuntimeTurnStatusSchema>;
export type RuntimeTurnErrorCode = z.infer<typeof RuntimeTurnErrorCodeSchema>;
export type RuntimeCostSource = z.infer<typeof RuntimeCostSourceSchema>;
export type RuntimeTurnCost = z.infer<typeof RuntimeTurnCostSchema>;
export type RuntimeTurnToolUsage = z.infer<typeof RuntimeTurnToolUsageSchema>;

/** Body of `POST /v1/runtime/apps/:appId/environments/:environmentId/metrics/events`. */
export const TechnicalRuntimeEventBatchSchema = z.object({
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  events: z.array(TechnicalRuntimeEventV2Schema).min(1).max(RUNTIME_METRIC_MAX_BATCH),
}).strict();

export type TechnicalRuntimeEventBatch = z.infer<typeof TechnicalRuntimeEventBatchSchema>;
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/src/contracts/index.ts b/src/contracts/index.ts
index 42103b9..205aa96 100644
--- a/src/contracts/index.ts
+++ b/src/contracts/index.ts
@@ -47,8 +47,32 @@ export type {
   ToolRiskClass,
 } from './revisions.js';
 
-export { TechnicalRuntimeEventSchema } from './events.js';
-export type { TechnicalRuntimeEvent } from './events.js';
+export {
+  RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
+  RUNTIME_METRIC_LABEL_PATTERN,
+  RUNTIME_METRIC_MAX_BATCH,
+  RUNTIME_METRIC_MAX_COUNT,
+  RUNTIME_METRIC_MAX_TOOLS,
+  RUNTIME_PRICING_VERSION_PATTERN,
+  RuntimeCostSourceSchema,
+  RuntimeTurnCostSchema,
+  RuntimeTurnErrorCodeSchema,
+  RuntimeTurnStatusSchema,
+  RuntimeTurnToolUsageSchema,
+  TechnicalRuntimeEventBatchSchema,
+  TechnicalRuntimeEventSchema,
+  TechnicalRuntimeEventV2Schema,
+} from './events.js';
+export type {
+  RuntimeCostSource,
+  RuntimeTurnCost,
+  RuntimeTurnErrorCode,
+  RuntimeTurnStatus,
+  RuntimeTurnToolUsage,
+  TechnicalRuntimeEvent,
+  TechnicalRuntimeEventBatch,
+  TechnicalRuntimeEventV2,
+} from './events.js';
 
 export {
   AppSetupArtifactSchema,
PATCH
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/contracts/__tests__/runtime-metric-event.test.ts src/contracts/__tests__/revisions.test.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  59 passed (59)` (46 new plus the 13 existing contract tests), `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/contracts/events.ts src/contracts/index.ts src/contracts/__vectors__/runtime-metric-event.v2.json src/contracts/__tests__/runtime-metric-event.test.ts
git commit -m "feat(contracts): add the content-free runtime metric event v2"
```

### Task 2: Turn cost with provider-reported provenance

**Files:**
- Create: `src/runtime/metrics/cost.test.ts`, `src/runtime/metrics/cost.ts`
- Modify: `src/runtime/index.ts` (append one export block after the `./contract-bindings.js` block, line 130)

**Interfaces:**
- Consumes: `RUNTIME_METRIC_LABEL_PATTERN`, `RUNTIME_PRICING_VERSION_PATTERN`, `RuntimeTurnCost` (Task 1).
- Produces (exported from `glirastes/runtime`):
  - `RuntimePriceTableSchema` → `RuntimePriceTable = { version: string; models: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> }` (strict, no default table shipped)
  - `UNKNOWN_TURN_COST: RuntimeTurnCost` (frozen, all `null`)
  - `interface StepCostInput { model: string | null; inputTokens: number; outputTokens: number; providerMetadata?: unknown; usageRaw?: unknown; rawChunkCostUsd?: number | null }`
  - `rawChunkCostUsd(rawValue: unknown): number | null`
  - `providerReportedCostUsd(input: { providerMetadata?: unknown; usageRaw?: unknown; rawChunkCostUsd?: number | null }): number | null`
  - `resolveStepCost(input: StepCostInput, priceTable?: RuntimePriceTable): RuntimeTurnCost`
  - `combineTurnCost(steps: ReadonlyArray<RuntimeTurnCost>): RuntimeTurnCost`

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/runtime/metrics/cost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  combineTurnCost,
  providerReportedCostUsd,
  rawChunkCostUsd,
  resolveStepCost,
  RuntimePriceTableSchema,
  UNKNOWN_TURN_COST,
  type RuntimePriceTable,
} from './cost.js';

const priceTable: RuntimePriceTable = {
  version: 'openrouter-2026-10-04',
  models: {
    'anthropic/claude-sonnet-5.5': { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  },
};

describe('rawChunkCostUsd', () => {
  it('reads OpenRouter usage.cost from the final raw stream chunk', () => {
    expect(rawChunkCostUsd({
      id: 'gen-1',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0042 },
    })).toBe(0.0042);
  });

  it.each([
    ['a content chunk', { choices: [{ delta: { content: 'Hallo' } }] }],
    ['usage without cost', { usage: { prompt_tokens: 1 } }],
    ['a non-object chunk', 'data: [DONE]'],
    ['nothing', undefined],
  ])('finds no cost in %s', (_label, chunk) => {
    expect(rawChunkCostUsd(chunk)).toBeNull();
  });
});

describe('providerReportedCostUsd', () => {
  it('reads OpenRouter usage.cost from provider metadata', () => {
    expect(providerReportedCostUsd({
      providerMetadata: { openrouter: { usage: { cost: 0.0042, totalTokens: 10 } } },
    })).toBe(0.0042);
  });

  it('reads cost from the raw provider usage', () => {
    expect(providerReportedCostUsd({ usageRaw: { prompt_tokens: 10, cost: 0.001 } }))
      .toBe(0.001);
  });

  it('falls back to the cost of the step raw stream chunk', () => {
    expect(providerReportedCostUsd({ usageRaw: { prompt_tokens: 10 }, rawChunkCostUsd: 0.002 }))
      .toBe(0.002);
  });

  it('prefers provider metadata over raw usage and the raw chunk', () => {
    expect(providerReportedCostUsd({
      providerMetadata: { openrouter: { usage: { cost: 0.5 } } },
      usageRaw: { cost: 0.4 },
      rawChunkCostUsd: 0.3,
    })).toBe(0.5);
  });

  it('accepts a reported cost of exactly zero (free models)', () => {
    expect(providerReportedCostUsd({ usageRaw: { cost: 0 } })).toBe(0);
  });

  it.each([
    ['nothing reported', {}],
    ['a string', { usageRaw: { cost: '0.01' } }],
    ['a negative amount', { usageRaw: { cost: -1 } }],
    ['not finite', { usageRaw: { cost: Number.POSITIVE_INFINITY } }],
    ['a non-object metadata', { providerMetadata: 'openrouter' }],
    ['a negative raw chunk cost', { rawChunkCostUsd: -0.1 }],
    ['an unknown raw chunk cost', { rawChunkCostUsd: null }],
  ])('ignores %s', (_label, input) => {
    expect(providerReportedCostUsd(input)).toBeNull();
  });
});

describe('resolveStepCost', () => {
  const step = {
    model: 'anthropic/claude-sonnet-5.5',
    inputTokens: 1_000,
    outputTokens: 200,
  };

  it('prefers the provider-reported cost over a price table', () => {
    expect(resolveStepCost({
      ...step,
      providerMetadata: { openrouter: { usage: { cost: 0.5 } } },
    }, priceTable)).toEqual({ usd: 0.5, source: 'provider-reported', pricingVersion: null });
    expect(resolveStepCost({ ...step, rawChunkCostUsd: 0.25 }, priceTable))
      .toEqual({ usd: 0.25, source: 'provider-reported', pricingVersion: null });
  });

  it('estimates from the price table and names its version', () => {
    expect(resolveStepCost(step, priceTable)).toEqual({
      usd: 0.004,
      source: 'price-table',
      pricingVersion: 'openrouter-2026-10-04',
    });
  });

  it('keeps an unpriced model unknown, never zero', () => {
    expect(resolveStepCost({ ...step, model: 'openai/gpt-6.1-sol' }, priceTable))
      .toEqual(UNKNOWN_TURN_COST);
    expect(resolveStepCost(step)).toEqual(UNKNOWN_TURN_COST);
    expect(resolveStepCost({ ...step, model: null }, priceTable)).toEqual(UNKNOWN_TURN_COST);
  });

  it('never prices a model through an inherited object key', () => {
    expect(resolveStepCost({ ...step, model: 'constructor' }, priceTable))
      .toEqual(UNKNOWN_TURN_COST);
  });
});

describe('combineTurnCost', () => {
  const provider = { usd: 0.25, source: 'provider-reported' as const, pricingVersion: null };
  const table = { usd: 0.125, source: 'price-table' as const, pricingVersion: 'v1' };

  it('sums provider-reported steps', () => {
    expect(combineTurnCost([provider, provider]))
      .toEqual({ usd: 0.5, source: 'provider-reported', pricingVersion: null });
  });

  it('marks a turn with any estimated step as price-table', () => {
    expect(combineTurnCost([provider, table]))
      .toEqual({ usd: 0.375, source: 'price-table', pricingVersion: 'v1' });
  });

  it('keeps the turn unknown when one step is unknown or no step ran', () => {
    expect(combineTurnCost([provider, UNKNOWN_TURN_COST])).toEqual(UNKNOWN_TURN_COST);
    expect(combineTurnCost([])).toEqual(UNKNOWN_TURN_COST);
  });
});

describe('RuntimePriceTableSchema', () => {
  it('accepts a versioned table', () => {
    expect(RuntimePriceTableSchema.parse(priceTable)).toEqual(priceTable);
  });

  it.each([
    ['a version with spaces', { ...priceTable, version: 'october prices' }],
    ['a free-text model key', { ...priceTable, models: { 'my model': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } }],
    ['a negative price', { ...priceTable, models: { 'a/b': { inputUsdPerMillion: -1, outputUsdPerMillion: 1 } } }],
    ['an unknown field', { ...priceTable, currency: 'EUR' }],
  ])('rejects %s', (_label, value) => {
    expect(RuntimePriceTableSchema.safeParse(value).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/runtime/metrics/cost.test.ts 2>&1 | grep -E "Error:|Test Files|Tests "
```

Expected: `Error: Cannot find module './cost.js' imported from …/src/runtime/metrics/cost.test.ts`, `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Implement `cost.ts` and export it**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/runtime/metrics/cost.ts`:

```ts
import { z } from 'zod';
import {
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_PRICING_VERSION_PATTERN,
  type RuntimeTurnCost,
} from '../../contracts/index.js';

const usdPerMillion = z.number().finite().nonnegative().max(10_000);

/**
 * Prices for models whose provider reports no cost. A provider-reported cost
 * always wins; the table only fills gaps and every estimate names its
 * `version`. Glirastes ships no default table: prices change, and a stale
 * table would be wrong without anyone noticing.
 */
export const RuntimePriceTableSchema = z.object({
  version: z.string().regex(RUNTIME_PRICING_VERSION_PATTERN),
  models: z.record(
    z.string().regex(RUNTIME_METRIC_LABEL_PATTERN),
    z.object({
      inputUsdPerMillion: usdPerMillion,
      outputUsdPerMillion: usdPerMillion,
    }).strict(),
  ),
}).strict();

export type RuntimePriceTable = z.infer<typeof RuntimePriceTableSchema>;

export const UNKNOWN_TURN_COST: RuntimeTurnCost = Object.freeze({
  usd: null,
  source: null,
  pricingVersion: null,
});

export interface StepCostInput {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** AI SDK `providerMetadata` of the step. */
  providerMetadata?: unknown;
  /** AI SDK `usage.raw` of the step (the provider's own usage object). */
  usageRaw?: unknown;
  /**
   * Cost found in the step's raw stream chunks (`rawChunkCostUsd`). The
   * OpenAI-compatible provider strips OpenRouter's `usage.cost` from
   * `usage.raw`; only the raw chunk keeps it.
   */
  rawChunkCostUsd?: number | null;
}

function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function usableAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The cost an OpenRouter stream chunk carries (`usage.cost` of the final
 * chunk), as delivered by `streamText({ includeRawChunks: true })`.
 */
export function rawChunkCostUsd(rawValue: unknown): number | null {
  return usableAmount(child(child(rawValue, 'usage'), 'cost'));
}

/**
 * The cost the provider reported for one model step, in USD: OpenRouter's
 * official provider puts it at `providerMetadata.openrouter.usage.cost`,
 * providers that keep unknown usage fields at `usage.raw.cost`, and the
 * OpenAI-compatible provider (`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' })`)
 * only in the raw stream chunk.
 */
export function providerReportedCostUsd(input: {
  providerMetadata?: unknown;
  usageRaw?: unknown;
  rawChunkCostUsd?: number | null;
}): number | null {
  return usableAmount(child(child(child(input.providerMetadata, 'openrouter'), 'usage'), 'cost'))
    ?? usableAmount(child(input.usageRaw, 'cost'))
    ?? usableAmount(input.rawChunkCostUsd);
}

export function resolveStepCost(
  input: StepCostInput,
  priceTable?: RuntimePriceTable,
): RuntimeTurnCost {
  const reported = providerReportedCostUsd(input);
  if (reported !== null) {
    return { usd: reported, source: 'provider-reported', pricingVersion: null };
  }
  const price = input.model && priceTable
    && Object.hasOwn(priceTable.models, input.model)
    ? priceTable.models[input.model]
    : undefined;
  if (!price || !priceTable) return UNKNOWN_TURN_COST;
  return {
    usd: (input.inputTokens * price.inputUsdPerMillion
      + input.outputTokens * price.outputUsdPerMillion) / 1_000_000,
    source: 'price-table',
    pricingVersion: priceTable.version,
  };
}

/**
 * A turn's cost is known only when every model step's cost is known. Any
 * estimated step makes the whole turn a price-table cost.
 */
export function combineTurnCost(
  steps: ReadonlyArray<RuntimeTurnCost>,
): RuntimeTurnCost {
  if (steps.length === 0 || steps.some((step) => step.usd === null)) {
    return UNKNOWN_TURN_COST;
  }
  const usd = steps.reduce((sum, step) => sum + (step.usd ?? 0), 0);
  const estimated = steps.find((step) => step.source === 'price-table');
  return estimated
    ? { usd, source: 'price-table', pricingVersion: estimated.pricingVersion }
    : { usd, source: 'provider-reported', pricingVersion: null };
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/src/runtime/index.ts b/src/runtime/index.ts
index 5d52c46..84cf01d 100644
--- a/src/runtime/index.ts
+++ b/src/runtime/index.ts
@@ -128,3 +128,13 @@ export {
   type GeneratedToolBinding,
   type GeneratedToolModule,
 } from './contract-bindings.js';
+export {
+  RuntimePriceTableSchema,
+  UNKNOWN_TURN_COST,
+  combineTurnCost,
+  providerReportedCostUsd,
+  rawChunkCostUsd,
+  resolveStepCost,
+  type RuntimePriceTable,
+  type StepCostInput,
+} from './metrics/cost.js';
PATCH
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/runtime/metrics/cost.test.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  29 passed (29)`, `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/runtime/metrics/cost.ts src/runtime/metrics/cost.test.ts src/runtime/index.ts
git commit -m "feat(runtime): resolve turn cost with provider-reported provenance"
```

### Task 3: One content-free metric event per turn

**Files:**
- Create: `src/runtime/metrics/turn-recorder.test.ts`, `src/runtime/metrics/turn-recorder.ts`
- Modify: `src/runtime/index.ts` (append after the Task 2 block)

**Interfaces:**
- Consumes: `TechnicalRuntimeEventV2Schema`, `RUNTIME_METRIC_LABEL_PATTERN`, `RUNTIME_METRIC_MAX_COUNT`, `RUNTIME_METRIC_MAX_TOOLS` (Task 1), `combineTurnCost` (Task 2), `modelFacingToolName` (`src/runtime/local-tool-bindings.ts`), `TurnSnapshot` (`src/runtime/turn-snapshot.ts`).
- Produces (exported from `glirastes/runtime`):
  - `interface RuntimeMetricsIdentity { readonly appId: string; readonly environmentId: string; readonly buildId: string | null; readonly instanceId: string }`
  - `interface RuntimeMetricsSink { readonly identity: RuntimeMetricsIdentity; record(event: TechnicalRuntimeEventV2): void; flush(): Promise<void>; close(): Promise<void> }`
  - `interface TurnMetricsStep { model: string | null; inputTokens: number; outputTokens: number; cost: RuntimeTurnCost; toolNames: ReadonlyArray<string>; failedToolNames: ReadonlyArray<string> }`
  - `interface TurnMetricsOutcome { status: RuntimeTurnStatus; errorCode: RuntimeTurnErrorCode | null }`
  - `interface TurnMetricsRecorder { markFirstChunk(): void; recordStep(step: TurnMetricsStep): void; finish(outcome: TurnMetricsOutcome): TechnicalRuntimeEventV2 | undefined }`
  - `interface TurnMetricsRecorderOptions { sink: RuntimeMetricsSink; snapshot?: TurnSnapshot; startedAtMs: number; now?: () => number; createEventId?: () => string }`
  - `createTurnMetricsRecorder(options: TurnMetricsRecorderOptions): TurnMetricsRecorder`

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/runtime/metrics/turn-recorder.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  TechnicalRuntimeEventV2Schema,
  type TechnicalRuntimeEventV2,
} from '../../contracts/index.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from '../__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../turn-snapshot.js';
import { UNKNOWN_TURN_COST } from './cost.js';
import {
  createTurnMetricsRecorder,
  type RuntimeMetricsSink,
} from './turn-recorder.js';

const APP_ID = '019fb900-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '019fb900-0000-7000-8000-0000000000e1';
const LIST_TASKS_ID = agentRevision.toolAllowlist[0]!;
const provider = (usd: number) => ({
  usd,
  source: 'provider-reported' as const,
  pricingVersion: null,
});

function fakeSink(record: (event: TechnicalRuntimeEventV2) => void = () => undefined) {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
    },
    record: vi.fn((event: TechnicalRuntimeEventV2) => {
      events.push(event);
      record(event);
    }),
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

const snapshot = createTurnSnapshot({
  turnId: 'ai-message-1',
  agentRevision,
  manifestRevision,
  policyRevision,
  principal,
  localLimits,
});

describe('createTurnMetricsRecorder', () => {
  it('records one valid, content-free event per turn', () => {
    const { sink, events } = fakeSink();
    const time = clock();
    const recorder = createTurnMetricsRecorder({
      sink,
      snapshot,
      startedAtMs: time.now(),
      now: time.now,
      createEventId: () => '019fb900-0000-7000-8000-000000000001',
    });

    time.advance(400);
    recorder.markFirstChunk();
    time.advance(100);
    recorder.markFirstChunk();
    recorder.recordStep({
      model: 'anthropic/claude-sonnet-5.5',
      inputTokens: 900,
      outputTokens: 40,
      cost: provider(0.003),
      toolNames: ['list_tasks', 'find_tools', 'list_tasks'],
      failedToolNames: ['list_tasks'],
    });
    time.advance(1_300);
    recorder.recordStep({
      model: 'anthropic/claude-sonnet-5.5',
      inputTokens: 300,
      outputTokens: 200,
      cost: provider(0.0018),
      toolNames: [],
      failedToolNames: [],
    });
    const event = recorder.finish({ status: 'completed', errorCode: null });

    expect(events).toEqual([event]);
    expect(TechnicalRuntimeEventV2Schema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      schemaVersion: 2,
      eventId: '019fb900-0000-7000-8000-000000000001',
      eventType: 'turn.finished',
      occurredAt: new Date(2_800).toISOString(),
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      model: 'anthropic/claude-sonnet-5.5',
      status: 'completed',
      errorCode: null,
      inputTokens: 1_200,
      outputTokens: 240,
      latency: { firstTokenMs: 400, totalMs: 1_800 },
      toolCallCount: 3,
      toolErrorCount: 1,
      tools: [{ toolId: LIST_TASKS_ID, calls: 2, errors: 1 }],
    });
    expect(event?.cost.source).toBe('provider-reported');
    expect(event?.cost.usd).toBeCloseTo(0.0048, 10);
    expect(JSON.stringify(event)).not.toContain('list_tasks');
    expect(JSON.stringify(event)).not.toContain('find_tools');
  });

  it('records a turn only once', () => {
    const { sink, events } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, snapshot, startedAtMs: Date.now() });

    expect(recorder.finish({ status: 'aborted', errorCode: null })).toBeDefined();
    expect(recorder.finish({ status: 'error', errorCode: 'model_error' })).toBeUndefined();
    expect(events.map((event) => event.status)).toEqual(['aborted']);
  });

  it('keeps an unknown step cost unknown for the whole turn', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });
    recorder.recordStep({
      model: 'openai/gpt-6.1-sol',
      inputTokens: 10,
      outputTokens: 5,
      cost: provider(0.001),
      toolNames: [],
      failedToolNames: [],
    });
    recorder.recordStep({
      model: 'openai/gpt-6.1-sol',
      inputTokens: 10,
      outputTokens: 5,
      cost: UNKNOWN_TURN_COST,
      toolNames: [],
      failedToolNames: [],
    });

    expect(recorder.finish({ status: 'completed', errorCode: null })?.cost)
      .toEqual(UNKNOWN_TURN_COST);
  });

  it('counts tools without a pinned snapshot but lists none and names no revision', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });
    recorder.recordStep({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: UNKNOWN_TURN_COST,
      toolNames: ['list_tasks'],
      failedToolNames: [],
    });

    expect(recorder.finish({ status: 'completed', errorCode: null })).toMatchObject({
      revisionId: null,
      model: null,
      toolCallCount: 1,
      tools: [],
      latency: { firstTokenMs: null },
    });
  });

  it('drops a model id that is not a technical label instead of the event', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });
    recorder.recordStep({
      model: 'show me all my tasks',
      inputTokens: 1,
      outputTokens: 1,
      cost: UNKNOWN_TURN_COST,
      toolNames: [],
      failedToolNames: [],
    });

    expect(recorder.finish({ status: 'completed', errorCode: null })?.model).toBeNull();
  });

  it('lists the 32 most used tools and still counts every call', () => {
    const tools = Array.from({ length: 40 }, (_, index) => ({
      ...manifestRevision.tools[0]!,
      toolId: `019fb900-0000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      name: `tool_${index}`,
    }));
    const wide = createTurnSnapshot({
      turnId: 'ai-wide',
      agentRevision,
      manifestRevision: { ...manifestRevision, tools },
      policyRevision,
      principal,
      localLimits,
    });
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, snapshot: wide, startedAtMs: Date.now() });
    recorder.recordStep({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: UNKNOWN_TURN_COST,
      toolNames: [...tools.map((tool) => tool.name), 'tool_39'],
      failedToolNames: [],
    });

    const event = recorder.finish({ status: 'completed', errorCode: null });
    expect(event?.toolCallCount).toBe(41);
    expect(event?.tools).toHaveLength(32);
    expect(event?.tools).toContainEqual({ toolId: tools[39]!.toolId, calls: 2, errors: 0 });
    expect(event?.tools.map((tool) => tool.toolId))
      .toEqual([...(event?.tools.map((tool) => tool.toolId) ?? [])].sort());
  });

  it('never lets a failing sink reach the turn', () => {
    const { sink } = fakeSink(() => {
      throw new Error('sink down');
    });
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });

    expect(() => recorder.finish({ status: 'error', errorCode: 'pipeline_error' }))
      .not.toThrow();
    expect(sink.record).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/runtime/metrics/turn-recorder.test.ts 2>&1 | grep -E "Error:|Test Files|Tests "
```

Expected: `Error: Cannot find module './turn-recorder.js' imported from …/src/runtime/metrics/turn-recorder.test.ts`, `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Implement the recorder and export it**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/runtime/metrics/turn-recorder.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  RUNTIME_METRIC_LABEL_PATTERN,
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
import { combineTurnCost } from './cost.js';

const MAX_DURATION_MS = 86_400_000;
const MAX_CALLS = 10_000;

/** Who reports: fixed per sink, attached to every event. */
export interface RuntimeMetricsIdentity {
  readonly appId: string;
  readonly environmentId: string;
  readonly buildId: string | null;
  readonly instanceId: string;
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

/** One model step, already reduced to content-free numbers and tool names. */
export interface TurnMetricsStep {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: RuntimeTurnCost;
  /** Model-facing names of every tool call in the step (one entry per call). */
  toolNames: ReadonlyArray<string>;
  /** Model-facing names of the calls that failed (one entry per failure). */
  failedToolNames: ReadonlyArray<string>;
}

export interface TurnMetricsOutcome {
  status: RuntimeTurnStatus;
  errorCode: RuntimeTurnErrorCode | null;
}

export interface TurnMetricsRecorder {
  /** The first streamed chunk of the turn; later calls do nothing. */
  markFirstChunk(): void;
  recordStep(step: TurnMetricsStep): void;
  /**
   * Builds the turn's event and hands it to the sink exactly once. Returns
   * the event, or undefined when the turn was already finished. Never throws.
   */
  finish(outcome: TurnMetricsOutcome): TechnicalRuntimeEventV2 | undefined;
}

export interface TurnMetricsRecorderOptions {
  sink: RuntimeMetricsSink;
  /** Pinned snapshot: names the revision and maps tool names to tool ids. */
  snapshot?: TurnSnapshot;
  /** Turn start (request start), in the clock of `now`. */
  startedAtMs: number;
  now?: () => number;
  createEventId?: () => string;
}

function bounded(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;
}

function technicalLabel(value: string | null): string | null {
  return value !== null && RUNTIME_METRIC_LABEL_PATTERN.test(value) ? value : null;
}

export function createTurnMetricsRecorder(
  options: TurnMetricsRecorderOptions,
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
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let finished = false;

  const usageOf = (toolName: string) => {
    const toolId = toolIdByName.get(toolName);
    if (!toolId) return undefined;
    let entry = usage.get(toolId);
    if (!entry) {
      entry = { calls: 0, errors: 0 };
      usage.set(toolId, entry);
    }
    return entry;
  };

  const listedTools = () => [...usage.entries()]
    .map(([toolId, entry]) => ({
      toolId,
      calls: Math.min(MAX_CALLS, entry.calls),
      errors: Math.min(MAX_CALLS, entry.errors, entry.calls),
    }))
    .filter((tool) => tool.calls > 0)
    .sort((left, right) => right.calls - left.calls
      || left.toolId.localeCompare(right.toolId))
    .slice(0, RUNTIME_METRIC_MAX_TOOLS)
    .sort((left, right) => left.toolId.localeCompare(right.toolId));

  const build = (outcome: TurnMetricsOutcome): TechnicalRuntimeEventV2 | undefined => {
    const endedAtMs = now();
    const totalMs = bounded(endedAtMs - options.startedAtMs, MAX_DURATION_MS);
    const firstTokenMs = firstChunkAtMs === undefined
      ? null
      : Math.min(totalMs, bounded(firstChunkAtMs - options.startedAtMs, MAX_DURATION_MS));
    const calls = Math.min(MAX_CALLS, toolCallCount);
    const parsed = TechnicalRuntimeEventV2Schema.safeParse({
      schemaVersion: 2,
      eventId: createEventId(),
      eventType: 'turn.finished',
      occurredAt: new Date(endedAtMs).toISOString(),
      appId: options.sink.identity.appId,
      environmentId: options.sink.identity.environmentId,
      buildId: options.sink.identity.buildId,
      instanceId: options.sink.identity.instanceId,
      revisionId: options.snapshot?.agentRevision.revisionId ?? null,
      model,
      status: outcome.status,
      errorCode: outcome.errorCode,
      inputTokens: bounded(inputTokens, RUNTIME_METRIC_MAX_COUNT),
      outputTokens: bounded(outputTokens, RUNTIME_METRIC_MAX_COUNT),
      cost: combineTurnCost(costs),
      latency: { firstTokenMs, totalMs },
      toolCallCount: calls,
      toolErrorCount: Math.min(calls, toolErrorCount),
      tools: listedTools(),
    });
    return parsed.success ? parsed.data : undefined;
  };

  return {
    markFirstChunk() {
      firstChunkAtMs ??= now();
    },

    recordStep(step) {
      if (finished) return;
      model = technicalLabel(step.model) ?? model;
      inputTokens += Number.isFinite(step.inputTokens) ? step.inputTokens : 0;
      outputTokens += Number.isFinite(step.outputTokens) ? step.outputTokens : 0;
      costs.push(step.cost);
      toolCallCount += step.toolNames.length;
      toolErrorCount += step.failedToolNames.length;
      for (const name of step.toolNames) {
        const entry = usageOf(name);
        if (entry) entry.calls += 1;
      }
      for (const name of step.failedToolNames) {
        const entry = usageOf(name);
        if (entry) entry.errors += 1;
      }
    },

    finish(outcome) {
      if (finished) return undefined;
      finished = true;
      try {
        const event = build(outcome);
        if (!event) return undefined;
        try {
          options.sink.record(event);
        } catch {
          // A sink must never fail a turn.
        }
        return event;
      } catch {
        return undefined;
      }
    },
  };
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/src/runtime/index.ts b/src/runtime/index.ts
index 84cf01d..c0b3b92 100644
--- a/src/runtime/index.ts
+++ b/src/runtime/index.ts
@@ -138,3 +138,12 @@ export {
   type RuntimePriceTable,
   type StepCostInput,
 } from './metrics/cost.js';
+export {
+  createTurnMetricsRecorder,
+  type RuntimeMetricsIdentity,
+  type RuntimeMetricsSink,
+  type TurnMetricsOutcome,
+  type TurnMetricsRecorder,
+  type TurnMetricsRecorderOptions,
+  type TurnMetricsStep,
+} from './metrics/turn-recorder.js';
PATCH
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/runtime/metrics/turn-recorder.test.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  15 passed (15)` (7 recorder tests plus the 8 tests of `turn-snapshot.test.ts`, which Vitest registers again because the fixtures are imported from it, as in `managed-runtime.test.ts`), `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/runtime/metrics/turn-recorder.ts src/runtime/metrics/turn-recorder.test.ts src/runtime/index.ts
git commit -m "feat(runtime): record one content-free metric event per turn"
```

### Task 4: Batched delivery off the turn path

**Files:**
- Create: `src/runtime/metrics/sink.test.ts`, `src/runtime/metrics/sink.ts`
- Modify: `src/runtime/index.ts` (append after the Task 3 block)

**Interfaces:**
- Consumes: `PlatformConnectionDescriptorSchema.shape.baseUrl` (HTTPS or loopback HTTP, no credentials in the URL), `TechnicalRuntimeEventV2Schema`, `RUNTIME_METRIC_EVENT_SCHEMA_VERSION`, `RUNTIME_METRIC_LABEL_PATTERN`, `RUNTIME_METRIC_MAX_BATCH` (Task 1), `RuntimeMetricsIdentity`, `RuntimeMetricsSink` (Task 3).
- Produces (exported from `glirastes/runtime`):
  - `type RuntimeMetricsDropReason = 'invalid' | 'queue-full' | 'send-failed' | 'closed'`
  - `interface RuntimeMetricsSinkOptions { controlPlaneUrl: string; apiKey: string; appId: string; environmentId: string; buildId?: string | null; instanceId?: string; fetch?: typeof globalThis.fetch; maxBatchSize?: number; maxQueueSize?: number; flushIntervalMs?: number; requestTimeoutMs?: number; onDrop?: (drop: { reason: RuntimeMetricsDropReason; count: number }) => void }`
  - `interface BatchingRuntimeMetricsSink extends RuntimeMetricsSink { readonly pending: number }`
  - `createRuntimeMetricsSink(options: RuntimeMetricsSinkOptions): BatchingRuntimeMetricsSink` (throws `RangeError` naming only option paths)
  - `createRuntimeMetricsSinkFromEnv(env?: Record<string, string | undefined>, options?: Omit<RuntimeMetricsSinkOptions, 'controlPlaneUrl' | 'apiKey' | 'appId' | 'environmentId' | 'buildId'>): BatchingRuntimeMetricsSink | undefined`
  - Wire: `POST {controlPlaneUrl}/v1/runtime/apps/{appId}/environments/{environmentId}/metrics/events`, headers `authorization: Bearer <runtime key>`, `content-type: application/json`, body `TechnicalRuntimeEventBatch`.

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/runtime/metrics/sink.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TechnicalRuntimeEventV2 } from '../../contracts/index.js';
import {
  createRuntimeMetricsSink,
  createRuntimeMetricsSinkFromEnv,
  type RuntimeMetricsDropReason,
} from './sink.js';

const vectors = JSON.parse(readFileSync(
  new URL('../../contracts/__vectors__/runtime-metric-event.v2.json', import.meta.url),
  'utf8',
)) as { base: TechnicalRuntimeEventV2 };

const BASE_URL = 'https://control.example';
const API_KEY = `gl_${'k'.repeat(40)}`;
const APP_ID = vectors.base.appId;
const ENVIRONMENT_ID = vectors.base.environmentId;
const ENDPOINT = `${BASE_URL}/v1/runtime/apps/${APP_ID}/environments/${ENVIRONMENT_ID}/metrics/events`;

let counter = 0;
function event(patch: Partial<TechnicalRuntimeEventV2> = {}): TechnicalRuntimeEventV2 {
  counter += 1;
  return {
    ...vectors.base,
    eventId: `019fb900-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`,
    ...patch,
  };
}

function recordingFetch(status = 202) {
  const calls: Array<{ url: string; init: RequestInit; body: { schemaVersion: number; events: unknown[] } }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as { schemaVersion: number; events: unknown[] },
    });
    return new Response(null, { status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}

function sinkWith(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof createRuntimeMetricsSink>[0]> = {},
) {
  const drops: Array<{ reason: RuntimeMetricsDropReason; count: number }> = [];
  const sink = createRuntimeMetricsSink({
    controlPlaneUrl: BASE_URL,
    apiKey: API_KEY,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    buildId: 'git:4f2c9e1',
    instanceId: 'web-1',
    fetch,
    onDrop: (drop) => drops.push(drop),
    ...overrides,
  });
  return { sink, drops };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRuntimeMetricsSink', () => {
  it('posts a v2 batch to the environment metrics endpoint with the runtime key', async () => {
    const http = recordingFetch();
    const { sink } = sinkWith(http.fetch);
    const first = event();
    const second = event({ status: 'aborted' });

    sink.record(first);
    sink.record(second);
    expect(sink.pending).toBe(2);
    await sink.flush();

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(ENDPOINT);
    expect(http.calls[0]!.init.method).toBe('POST');
    expect(http.calls[0]!.init.headers).toEqual({
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    });
    expect(http.calls[0]!.body).toEqual({ schemaVersion: 2, events: [first, second] });
    expect(JSON.stringify(http.calls[0]!.body)).not.toContain(API_KEY);
    expect(sink.pending).toBe(0);
    expect(sink.identity).toEqual({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
    });
  });

  it('returns from record at once while the Platform hangs and drops after the timeout', async () => {
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    const { sink, drops } = sinkWith(hanging as unknown as typeof globalThis.fetch, {
      maxBatchSize: 2,
      requestTimeoutMs: 20,
    });

    for (let index = 0; index < 5; index += 1) sink.record(event());
    // Nothing is sent while the caller (the turn) still runs.
    expect(hanging).not.toHaveBeenCalled();
    expect(sink.pending).toBe(5);

    await sink.flush();
    expect(hanging).toHaveBeenCalledTimes(3);
    expect(drops).toEqual([
      { reason: 'send-failed', count: 2 },
      { reason: 'send-failed', count: 2 },
      { reason: 'send-failed', count: 1 },
    ]);
    expect(sink.pending).toBe(0);
  });

  it('drops a rejected batch without retrying it', async () => {
    const http = recordingFetch(503);
    const { sink, drops } = sinkWith(http.fetch);

    sink.record(event());
    await sink.flush();
    await sink.flush();

    expect(http.calls).toHaveLength(1);
    expect(drops).toEqual([{ reason: 'send-failed', count: 1 }]);
  });

  it('splits large queues into batches of at most 50 events', async () => {
    const http = recordingFetch();
    const { sink } = sinkWith(http.fetch);

    for (let index = 0; index < 120; index += 1) sink.record(event());
    await sink.flush();

    expect(http.calls.map((call) => call.body.events.length)).toEqual([50, 50, 20]);
  });

  it('drops events that break the content boundary or belong to another app', async () => {
    const http = recordingFetch();
    const { sink, drops } = sinkWith(http.fetch);

    sink.record({ ...event(), prompt: 'Zeige meine Aufgaben' } as unknown as TechnicalRuntimeEventV2);
    sink.record(event({ buildId: `sk-or-v1-${'a'.repeat(40)}` }));
    sink.record(event({ appId: '019fb900-0000-7000-8000-0000000000a2' }));
    await sink.flush();

    expect(http.calls).toHaveLength(0);
    expect(drops).toEqual([
      { reason: 'invalid', count: 1 },
      { reason: 'invalid', count: 1 },
      { reason: 'invalid', count: 1 },
    ]);
  });

  it('bounds the queue and drops what does not fit', () => {
    const { sink, drops } = sinkWith(recordingFetch().fetch, { maxQueueSize: 2, maxBatchSize: 10 });

    sink.record(event());
    sink.record(event());
    sink.record(event());

    expect(sink.pending).toBe(2);
    expect(drops).toEqual([{ reason: 'queue-full', count: 1 }]);
  });

  it('flushes on its interval and stops after close', async () => {
    vi.useFakeTimers();
    const http = recordingFetch();
    const { sink, drops } = sinkWith(http.fetch, { flushIntervalMs: 1_000 });

    sink.record(event());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(http.calls).toHaveLength(1);

    sink.record(event());
    await sink.close();
    expect(http.calls).toHaveLength(2);

    sink.record(event());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.calls).toHaveLength(2);
    expect(drops).toEqual([{ reason: 'closed', count: 1 }]);
  });

  it('never throws from record, even when the drop callback throws', () => {
    const { sink } = sinkWith(recordingFetch().fetch, {
      onDrop: () => {
        throw new Error('callback failed');
      },
    });

    expect(() => sink.record(null as unknown as TechnicalRuntimeEventV2)).not.toThrow();
  });

  it.each([
    ['a plain-http remote URL', { controlPlaneUrl: 'http://control.example' }],
    ['an app id that is no uuid', { appId: 'app-1' }],
    ['a free-text build id', { buildId: 'my build' }],
    ['a batch above 50 events', { maxBatchSize: 51 }],
  ])('refuses %s at creation', (_label, overrides) => {
    expect(() => sinkWith(recordingFetch().fetch, overrides)).toThrow(RangeError);
  });

  it('names failing option paths, never the key', () => {
    try {
      sinkWith(recordingFetch().fetch, { appId: 'app-1' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('appId');
      expect(String(error)).not.toContain(API_KEY);
    }
  });
});

describe('createRuntimeMetricsSinkFromEnv', () => {
  const connected = {
    GLIRASTES_CONTROL_PLANE_URL: BASE_URL,
    GLIRASTES_API_KEY: API_KEY,
    GLIRASTES_APP_ID: APP_ID,
    GLIRASTES_ENVIRONMENT_ID: ENVIRONMENT_ID,
  };

  it('stays absent and network-silent in standalone mode', () => {
    const http = recordingFetch();
    expect(createRuntimeMetricsSinkFromEnv({}, { fetch: http.fetch })).toBeUndefined();
    expect(createRuntimeMetricsSinkFromEnv({
      ...connected,
      GLIRASTES_CONTROL_PLANE_URL: ' ',
    }, { fetch: http.fetch })).toBeUndefined();
    expect(http.mock).not.toHaveBeenCalled();
  });

  it.each([
    ['without a key', { GLIRASTES_API_KEY: undefined }],
    ['without an environment', { GLIRASTES_ENVIRONMENT_ID: undefined }],
    ['with an invalid app id', { GLIRASTES_APP_ID: 'app-1' }],
  ])('stays absent %s', (_label, patch) => {
    expect(createRuntimeMetricsSinkFromEnv({ ...connected, ...patch })).toBeUndefined();
  });

  it('reports with the connected identity and an optional build id', () => {
    const sink = createRuntimeMetricsSinkFromEnv({
      ...connected,
      GLIRASTES_BUILD_ID: 'git:4f2c9e1',
    }, { instanceId: 'web-2' });
    expect(sink?.identity).toEqual({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-2',
    });
  });

  it('ignores an unusable build id and draws a random instance id', () => {
    const sink = createRuntimeMetricsSinkFromEnv({
      ...connected,
      GLIRASTES_BUILD_ID: 'not a label',
    });
    expect(sink?.identity.buildId).toBeNull();
    expect(sink?.identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/runtime/metrics/sink.test.ts 2>&1 | grep -E "Error:|Test Files|Tests "
```

Expected: `Error: Cannot find module './sink.js' imported from …/src/runtime/metrics/sink.test.ts`, `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Implement the sink and export it**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/runtime/metrics/sink.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PlatformConnectionDescriptorSchema,
  RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_METRIC_MAX_BATCH,
  TechnicalRuntimeEventV2Schema,
  type TechnicalRuntimeEventBatch,
  type TechnicalRuntimeEventV2,
} from '../../contracts/index.js';
import type {
  RuntimeMetricsIdentity,
  RuntimeMetricsSink,
} from './turn-recorder.js';

export type RuntimeMetricsDropReason =
  | 'invalid'
  | 'queue-full'
  | 'send-failed'
  | 'closed';

export interface RuntimeMetricsSinkOptions {
  /** Control-plane base URL (HTTPS, or loopback HTTP for local tests). */
  controlPlaneUrl: string;
  /** The app-bound runtime key; sent only in the Authorization header. */
  apiKey: string;
  appId: string;
  environmentId: string;
  /** Build identifier of the deployed code, e.g. a commit; null if unknown. */
  buildId?: string | null;
  /** This process; defaults to a random id per sink. */
  instanceId?: string;
  fetch?: typeof globalThis.fetch;
  /** Events per request, 1–50 (default 50). */
  maxBatchSize?: number;
  /** Events waiting for delivery before new ones are dropped (default 1,000). */
  maxQueueSize?: number;
  /** Delivery interval (default 5 s). */
  flushIntervalMs?: number;
  /** Per-request timeout; a slower Platform loses the batch (default 5 s). */
  requestTimeoutMs?: number;
  /** Content-free notice about dropped events, e.g. for local logging. */
  onDrop?: (drop: { reason: RuntimeMetricsDropReason; count: number }) => void;
}

export interface BatchingRuntimeMetricsSink extends RuntimeMetricsSink {
  /** Events waiting for delivery. */
  readonly pending: number;
}

const label = z.string().regex(RUNTIME_METRIC_LABEL_PATTERN);

const SinkConfigSchema = z.object({
  controlPlaneUrl: PlatformConnectionDescriptorSchema.shape.baseUrl,
  apiKey: z.string().regex(/^\S{8,512}$/),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: label.nullable(),
  instanceId: label,
  maxBatchSize: z.number().int().min(1).max(RUNTIME_METRIC_MAX_BATCH),
  maxQueueSize: z.number().int().min(1).max(100_000),
  flushIntervalMs: z.number().int().min(100).max(3_600_000),
  requestTimeoutMs: z.number().int().min(10).max(60_000),
});

/**
 * Batches turn events and delivers them to the Platform off the turn path.
 * `record` validates and queues synchronously and never throws; delivery
 * runs on an unref'd interval or when a batch is full. A failed, rejected or
 * timed-out request drops its batch: metrics never retry, never block a turn
 * and never hold the process open.
 */
export function createRuntimeMetricsSink(
  options: RuntimeMetricsSinkOptions,
): BatchingRuntimeMetricsSink {
  const parsed = SinkConfigSchema.safeParse({
    controlPlaneUrl: options.controlPlaneUrl,
    apiKey: options.apiKey,
    appId: options.appId,
    environmentId: options.environmentId,
    buildId: options.buildId ?? null,
    instanceId: options.instanceId ?? randomUUID(),
    maxBatchSize: options.maxBatchSize ?? RUNTIME_METRIC_MAX_BATCH,
    maxQueueSize: options.maxQueueSize ?? 1_000,
    flushIntervalMs: options.flushIntervalMs ?? 5_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
  });
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
    throw new RangeError(`Invalid runtime metrics sink options: ${[...new Set(paths)].join(', ')}`);
  }
  const config = parsed.data;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = `${config.controlPlaneUrl.replace(/\/+$/, '')}/v1/runtime/apps/`
    + `${config.appId}/environments/${config.environmentId}/metrics/events`;
  const identity: RuntimeMetricsIdentity = Object.freeze({
    appId: config.appId,
    environmentId: config.environmentId,
    buildId: config.buildId,
    instanceId: config.instanceId,
  });
  const queue: TechnicalRuntimeEventV2[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let flushScheduled = false;
  let closed = false;

  const drop = (reason: RuntimeMetricsDropReason, count: number) => {
    try {
      options.onDrop?.({ reason, count });
    } catch {
      // Diagnostics must not reach the turn either.
    }
  };

  const send = async (events: TechnicalRuntimeEventV2[]): Promise<boolean> => {
    try {
      const body: TechnicalRuntimeEventBatch = {
        schemaVersion: RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
        events,
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      try {
        await response.body?.cancel();
      } catch {
        // The answer carries nothing the runtime needs.
      }
      return response.ok;
    } catch {
      return false;
    }
  };

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
      }
    })();
    return inFlight;
  };

  const ensureTimer = () => {
    if (timer || closed) return;
    timer = setInterval(() => {
      void flush();
    }, config.flushIntervalMs);
    timer.unref?.();
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush();
    });
  };

  return {
    identity,
    get pending() {
      return queue.length;
    },
    record(event) {
      try {
        if (closed) {
          drop('closed', 1);
          return;
        }
        const checked = TechnicalRuntimeEventV2Schema.safeParse(event);
        if (
          !checked.success
          || checked.data.appId !== identity.appId
          || checked.data.environmentId !== identity.environmentId
        ) {
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
      } catch {
        // Recording is best effort and must never fail a turn.
      }
    },
    flush,
    async close() {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await flush();
    },
  };
}

/**
 * The sink of a connected app (`glirastes connect` writes these variables),
 * or undefined. Standalone apps (no `GLIRASTES_CONTROL_PLANE_URL`) get no
 * sink and stay network-silent; an incomplete or invalid connection also
 * yields none, because metrics must never stop a chat from starting.
 * `GLIRASTES_BUILD_ID` (optional) names the deployed build.
 */
export function createRuntimeMetricsSinkFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<
    RuntimeMetricsSinkOptions,
    'controlPlaneUrl' | 'apiKey' | 'appId' | 'environmentId' | 'buildId'
  > = {},
): BatchingRuntimeMetricsSink | undefined {
  const controlPlaneUrl = env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  const apiKey = env.GLIRASTES_API_KEY?.trim();
  const appId = env.GLIRASTES_APP_ID?.trim();
  const environmentId = env.GLIRASTES_ENVIRONMENT_ID?.trim();
  if (!controlPlaneUrl || !apiKey || !appId || !environmentId) return undefined;
  const buildId = env.GLIRASTES_BUILD_ID?.trim();
  try {
    return createRuntimeMetricsSink({
      ...options,
      controlPlaneUrl,
      apiKey,
      appId,
      environmentId,
      buildId: buildId && RUNTIME_METRIC_LABEL_PATTERN.test(buildId) ? buildId : null,
    });
  } catch {
    return undefined;
  }
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/src/runtime/index.ts b/src/runtime/index.ts
index c0b3b92..832e777 100644
--- a/src/runtime/index.ts
+++ b/src/runtime/index.ts
@@ -147,3 +147,10 @@ export {
   type TurnMetricsRecorderOptions,
   type TurnMetricsStep,
 } from './metrics/turn-recorder.js';
+export {
+  createRuntimeMetricsSink,
+  createRuntimeMetricsSinkFromEnv,
+  type BatchingRuntimeMetricsSink,
+  type RuntimeMetricsDropReason,
+  type RuntimeMetricsSinkOptions,
+} from './metrics/sink.js';
PATCH
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/runtime/metrics/sink.test.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  19 passed (19)`, `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/runtime/metrics/sink.ts src/runtime/metrics/sink.test.ts src/runtime/index.ts
git commit -m "feat(runtime): deliver turn metrics in batches off the turn path"
```

### Task 5: Record metrics and cost in the Next chat handler

**Files:**
- Create: `src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts`
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.ts` (imports at lines 37–44, `StreamHandlerContext` at 98–101, new helpers after `shouldStopManagedExecution` at 189, `defaultStreamHandler` at 304–528, option destructuring at 588–591, `handler` at 661–1227)
- Modify: `src/server/adapters/nextjs/types.ts` (runtime imports at 23–27, `telemetry` doc at 324–337)
- Modify: `docs/managed-runtime-sync.md` (append a section)

**Interfaces:**
- Consumes: `createTurnMetricsRecorder`, `TurnMetricsRecorder`, `RuntimeMetricsSink` (Task 3), `resolveStepCost`, `rawChunkCostUsd`, `RuntimePriceTableSchema`, `RuntimePriceTable` (Task 2), `ManagedTurnGuard.afterModelStep({ inputTokens, outputTokens, estimatedCostUsd? })` (existing, `src/runtime/managed-turn.ts:46`).
- Produces:
  - `AiChatHandlerConfig.metrics?: RuntimeMetricsSink`, `AiChatHandlerConfig.modelPricing?: RuntimePriceTable` (parsed with `RuntimePriceTableSchema` when the handler is created; an invalid table throws)
  - `StreamHandlerContext.turnMetrics?: TurnMetricsRecorder`, `StreamHandlerContext.modelPricing?: RuntimePriceTable`
  - `createAiChatHandler` throws `createAiChatHandler: telemetry (legacy Lancer) cannot be combined with managedRuntime; use metrics for content-free runtime metrics` when both are set.
  - Behaviour: the default stream handler passes `includeRawChunks: Boolean(managedTurn || turnMetrics)`; per step it resolves the cost, passes a known cost to `afterModelStep` as `estimatedCostUsd`, and records the step; the outcome is `completed`, `safety-stop` (`budget_exhausted` when the runtime budget stopped the turn, else `step_limit`), `aborted`, or `error` (`model_error` for provider and stream failures, `pipeline_error` for failures before streaming and a missing model).

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat/src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts`:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TechnicalRuntimeEventV2Schema,
  type ExecutionBudget,
  type TechnicalRuntimeEventV2,
} from '../../../../contracts/index.js';
import { defineTool, type PipelineResult } from '../../../../types.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const APP_ID = '019fb900-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '019fb900-0000-7000-8000-0000000000e1';
const LIST_TASKS_ID = agentRevision.toolAllowlist[0]!;
const SECRET_TEXT = 'Geheimprojekt Zebra';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolStep(providerMetadata?: Record<string, Record<string, unknown>>) {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'list_tasks',
      input: JSON.stringify({ query: SECRET_TEXT }),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      ...(providerMetadata ? { providerMetadata } : {}),
    },
  ] as never);
}

/** A text step; `rawCostUsd` adds OpenRouter's final raw usage chunk. */
function textStep(rawCostUsd?: number) {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: `Erledigt: ${SECRET_TEXT}.` },
    { type: 'text-end', id: 't1' },
    ...(rawCostUsd === undefined ? [] : [{
      type: 'raw',
      rawValue: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: rawCostUsd } },
    }]),
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  ] as never);
}

/** OpenRouter's chat completions stream, served without any network. */
function openRouterFetch(requests: string[]): typeof globalThis.fetch {
  const chunk = (patch: Record<string, unknown>) => ({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'anthropic/claude-sonnet-5.5',
    ...patch,
  });
  const body = [
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Erledigt.' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0042 } }),
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  return (async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
}

function scriptedModel(steps: Array<() => ReadableStream>) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const next = steps[Math.min(call, steps.length - 1)]!;
      call += 1;
      return { stream: next() };
    },
  });
}

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
  return {
    resolvePrincipal: async () => principal,
    resolveTurnSnapshot: async ({ turnId }: { turnId: string }) => createTurnSnapshot({
      turnId, agentRevision, manifestRevision, policyRevision, principal, localLimits: limits,
    }),
  };
}

function registry(execute: () => Promise<unknown> = async () => ({ tasks: [{ title: SECRET_TEXT }] })) {
  return {
    list_tasks: defineTool({
      id: LIST_TASKS_ID,
      description: 'List visible tasks.',
      inputSchema: z.object({ query: z.string() }),
      execute,
    }),
  };
}

function request() {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: `Zeige ${SECRET_TEXT}` }],
    }] }),
  });
}

describe('turn metrics in the Next chat handler', () => {
  it('records one content-free event with provider-reported cost, tokens, latency and tool ids', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([
        () => toolStep({ openrouter: { usage: { cost: 0.003 } } }),
        () => textStep(0.0018),
      ]),
      systemPrompt: 'You are the Zebra assistant.',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const response = await handler(request());
    const wire = await response.text();

    expect(wire).toContain('Erledigt');
    expect(events).toHaveLength(1);
    const event = TechnicalRuntimeEventV2Schema.parse(events[0]);
    expect(event).toMatchObject({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      model: 'mock-model-id',
      status: 'completed',
      errorCode: null,
      inputTokens: 20,
      outputTokens: 10,
      toolCallCount: 1,
      toolErrorCount: 0,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 0 }],
    });
    expect(event.cost.source).toBe('provider-reported');
    expect(event.cost.usd).toBeCloseTo(0.0048, 10);
    expect(event.latency.firstTokenMs).not.toBeNull();
    expect(event.latency.firstTokenMs!).toBeLessThanOrEqual(event.latency.totalMs);
    const serialized = JSON.stringify(event);
    for (const content of ['Zebra', 'Zeige', 'list_tasks', 'assistant', 'query']) {
      expect(serialized).not.toContain(content);
    }
  });

  it('reads OpenRouter usage.cost through the OpenAI-compatible provider of Get It Done', async () => {
    const { sink, events } = collectingSink();
    const requests: string[] = [];
    const openrouter = createOpenAI({
      baseURL: 'https://openrouter.invalid/api/v1',
      apiKey: 'not-a-real-key',
      fetch: openRouterFetch(requests),
    });
    const handler = createAiChatHandler({
      tools: registry(),
      model: openrouter.chat('anthropic/claude-sonnet-5.5'),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const wire = await (await handler(request())).text();

    expect(requests).toEqual(['https://openrouter.invalid/api/v1/chat/completions']);
    expect(wire).toContain('Erledigt.');
    expect(wire).not.toContain('"cost"');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      status: 'completed',
      inputTokens: 100,
      outputTokens: 20,
      cost: { usd: 0.0042, source: 'provider-reported', pricingVersion: null },
    });
  });

  it('feeds a known cost into the runtime budget so the cost limit stops the turn', async () => {
    const { sink, events } = collectingSink();
    const model = scriptedModel([
      () => toolStep({ openrouter: { usage: { cost: 0.003 } } }),
      () => textStep(),
    ]);
    const handler = createAiChatHandler({
      tools: registry(),
      model,
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime({ ...localLimits, maxEstimatedCostUsd: 0.002 }),
      metrics: sink,
    });

    const wire = await (await handler(request())).text();

    expect(model.doStreamCalls).toHaveLength(1);
    expect(wire).toContain('Stopped at runtime budget: maxEstimatedCostUsd.');
    expect(events[0]).toMatchObject({ status: 'safety-stop', errorCode: 'budget_exhausted' });
  });

  it('estimates from the configured price table when the provider reports no cost', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
      modelPricing: {
        version: 'test-2026-10',
        models: { 'mock-model-id': { inputUsdPerMillion: 1_000, outputUsdPerMillion: 2_000 } },
      },
    });

    await (await handler(request())).text();

    expect(events[0]?.cost).toEqual({ usd: 0.02, source: 'price-table', pricingVersion: 'test-2026-10' });
  });

  it('keeps an unreported, unpriced cost unknown', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    await (await handler(request())).text();

    expect(events[0]?.cost).toEqual({ usd: null, source: null, pricingVersion: null });
  });

  it('counts a failed tool call as an error of that tool', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(async () => {
        throw new Error(`database rejected ${SECRET_TEXT}`);
      }),
      model: scriptedModel([() => toolStep(), () => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    await (await handler(request())).text();

    expect(events[0]).toMatchObject({
      toolCallCount: 1,
      toolErrorCount: 1,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 1 }],
    });
    expect(JSON.stringify(events[0])).not.toContain('database rejected');
  });

  it('records a provider failure as a model error turn', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: new MockLanguageModelV3({
        doStream: async () => {
          throw new Error(`provider leaked ${SECRET_TEXT}`);
        },
      }),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
      onError: () => undefined,
    });

    await (await handler(request())).text();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'error', errorCode: 'model_error' });
    expect(JSON.stringify(events[0])).not.toContain('provider leaked');
  });

  it('records a pipeline failure before streaming as a pipeline error turn', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
      pipeline: {
        process: async (): Promise<PipelineResult> => {
          throw new Error(`classifier saw ${SECRET_TEXT}`);
        },
      },
      onError: () => undefined,
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'error',
      errorCode: 'pipeline_error',
      model: null,
      cost: { usd: null, source: null, pricingVersion: null },
      latency: { firstTokenMs: null },
    });
  });

  it('records a turn without a configured model as a pipeline error', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'error', errorCode: 'pipeline_error', model: null });
  });

  it('never lets a failing sink block or fail the turn', async () => {
    const { sink } = collectingSink(() => {
      throw new Error('sink down');
    });
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Erledigt');
  });

  it('refuses the legacy Lancer telemetry on the managed-local path', () => {
    const telemetry = { emit: vi.fn(), flush: async () => undefined };
    expect(() => createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      telemetry,
    })).toThrow(/telemetry/);
    expect(() => createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      telemetry,
    })).not.toThrow();
  });

  it('refuses an invalid price table when the handler is created', () => {
    expect(() => createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      modelPricing: { version: 'october prices', models: {} },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  1 failed (1)`, `Tests  11 failed | 9 passed (20)` (the 8 re-registered `turn-snapshot.test.ts` tests and `never lets a failing sink block or fail the turn`, which today passes because nothing records, pass; all 11 metric assertions fail because no event is recorded and neither `telemetry` nor `modelPricing` is checked).

- [ ] **Step 3: Wire metrics into the handler**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/src/server/adapters/nextjs/create-ai-chat-handler.ts b/src/server/adapters/nextjs/create-ai-chat-handler.ts
index dcebbe1..37e4032 100644
--- a/src/server/adapters/nextjs/create-ai-chat-handler.ts
+++ b/src/server/adapters/nextjs/create-ai-chat-handler.ts
@@ -37,10 +37,16 @@ import { PrincipalSchema } from '../../../contracts/index.js';
 import {
   createManagedTurnGuard,
   createRegistryToolDiscovery,
+  createTurnMetricsRecorder,
   createTurnToolDiscovery,
   isToolRevoked,
+  rawChunkCostUsd,
+  resolveStepCost,
+  RuntimePriceTableSchema,
   type BudgetEvaluation,
   type ManagedTurnGuard,
+  type RuntimePriceTable,
+  type TurnMetricsRecorder,
 } from '../../../runtime/index.js';
 import {
   createHybridToolDiscovery,
@@ -98,6 +104,14 @@ export interface StreamHandlerContext {
    * re-authorization, budget).
    */
   handlerBuiltinToolNames?: ReadonlyArray<string>;
+  /**
+   * Content-free metrics of this turn when the handler has `metrics`. The
+   * built-in stream handler reports every step and the outcome; a custom
+   * stream handler reports through it (`recordStep`, `finish`) itself.
+   */
+  turnMetrics?: TurnMetricsRecorder;
+  /** Price table configured on the handler (`modelPricing`). */
+  modelPricing?: RuntimePriceTable;
 }
 
 /**
@@ -188,6 +202,41 @@ export function shouldStopManagedExecution(options: {
     || (options.lastStepToolNames ?? []).includes(CLARIFICATION_TOOL_NAME);
 }
 
+/** Model id of a finished step; AI SDK 6 versions differ in where they put it. */
+function stepModelId(event: unknown): string | null {
+  const record = event as {
+    model?: { modelId?: unknown };
+    response?: { modelId?: unknown };
+  };
+  const modelId = record.model?.modelId ?? record.response?.modelId;
+  return typeof modelId === 'string' ? modelId : null;
+}
+
+/**
+ * Names of the tool calls of a step that failed: thrown errors and the
+ * `{ error }` results SDK tools return. Only names leave this function.
+ */
+function failedToolNames(content: ReadonlyArray<unknown>): string[] {
+  const names: string[] = [];
+  for (const part of content) {
+    const record = part as { type?: unknown; toolName?: unknown; output?: unknown };
+    if (typeof record?.toolName !== 'string') continue;
+    const output = record.output as { error?: unknown } | null | undefined;
+    if (
+      record.type === 'tool-error'
+      || (
+        record.type === 'tool-result'
+        && typeof output === 'object'
+        && output !== null
+        && typeof output.error === 'string'
+      )
+    ) {
+      names.push(record.toolName);
+    }
+  }
+  return names;
+}
+
 function compactToolNames(toolCalls: Array<{ toolName: string }>): string[] {
   const unique = new Set<string>();
   for (const call of toolCalls) {
@@ -350,6 +399,8 @@ async function defaultStreamHandler(
       let totalSteps = 0;
       let finalStateWritten = false;
       let providerErrorReported = false;
+      // Cost of the running model step, read from its raw stream chunks.
+      let stepRawCostUsd: number | null = null;
 
       const writePipelineState = (
         state: PipelineStreamState,
@@ -391,6 +442,16 @@ async function defaultStreamHandler(
           ctx.managedTurn?.snapshot.budget.totalTimeoutMs,
         ),
         stopWhen: shouldStop,
+        // OpenRouter reports `usage.cost` only in the raw final chunk when the
+        // OpenAI-compatible provider is used; the UI stream drops raw chunks.
+        includeRawChunks: Boolean(ctx.managedTurn || ctx.turnMetrics),
+        onChunk: ({ chunk }) => {
+          if (chunk.type === 'raw') {
+            stepRawCostUsd = rawChunkCostUsd(chunk.rawValue) ?? stepRawCostUsd;
+            return;
+          }
+          ctx.turnMetrics?.markFirstChunk();
+        },
         // AI SDK's default logs the complete provider error, including
         // request/response content. Only the local consumer owns diagnostics.
         onError: ({ error }) => {
@@ -398,9 +459,33 @@ async function defaultStreamHandler(
           onStreamError?.(error);
         },
         onStepFinish: async (event) => {
+          const inputTokens = event.usage.inputTokens ?? 0;
+          const outputTokens = event.usage.outputTokens ?? 0;
+          const model = stepModelId(event);
+          const rawCostUsd = stepRawCostUsd;
+          stepRawCostUsd = null;
+          const cost = resolveStepCost({
+            model,
+            inputTokens,
+            outputTokens,
+            providerMetadata: event.providerMetadata,
+            usageRaw: event.usage.raw,
+            rawChunkCostUsd: rawCostUsd,
+          }, ctx.modelPricing);
+          // A known cost counts against maxEstimatedCostUsd; an unknown one
+          // is never recorded as 0.
           await ctx.managedTurn?.afterModelStep({
-            inputTokens: event.usage.inputTokens ?? 0,
-            outputTokens: event.usage.outputTokens ?? 0,
+            inputTokens,
+            outputTokens,
+            ...(cost.usd !== null ? { estimatedCostUsd: cost.usd } : {}),
+          });
+          ctx.turnMetrics?.recordStep({
+            model,
+            inputTokens,
+            outputTokens,
+            cost,
+            toolNames: event.toolCalls.map((call) => call.toolName),
+            failedToolNames: failedToolNames(event.content),
           });
           const report = buildStepReport({
             stepNumber: event.stepNumber,
@@ -426,6 +511,7 @@ async function defaultStreamHandler(
           ctx.onStepReport?.(report);
         },
         onAbort: (event) => {
+          ctx.turnMetrics?.finish({ status: 'aborted', errorCode: null });
           if (finalStateWritten) return;
           totalSteps = Math.max(totalSteps, event.steps.length);
           writePipelineState(
@@ -462,6 +548,12 @@ async function defaultStreamHandler(
                 : event.finishReason === 'error'
                   ? 'error'
                   : 'completed';
+          ctx.turnMetrics?.finish({
+            status,
+            errorCode: status === 'safety-stop'
+              ? stoppedByBudget ? 'budget_exhausted' : 'step_limit'
+              : status === 'error' ? 'model_error' : null,
+          });
 
           if (!finalStateWritten) {
             writePipelineState(
@@ -504,6 +596,7 @@ async function defaultStreamHandler(
       try {
         await result.response;
       } catch (error) {
+        ctx.turnMetrics?.finish({ status: 'error', errorCode: 'model_error' });
         if (finalStateWritten) return;
         writePipelineState(
           createPipelineState({
@@ -588,8 +681,23 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
     streamHandler: customStreamHandler,
     toolDiscovery: enableToolDiscovery = false,
     toolSemantics,
+    metrics,
+    modelPricing: configuredModelPricing,
   } = config;
 
+  // The Proctor endpoint behind Lancer telemetry is not served by the
+  // Foundation control plane and its audit payloads are not content-free;
+  // the managed-local path reports through `metrics` instead.
+  if (managedRuntime && telemetry) {
+    throw new Error(
+      'createAiChatHandler: telemetry (legacy Lancer) cannot be combined with '
+      + 'managedRuntime; use metrics for content-free runtime metrics',
+    );
+  }
+  const modelPricing = configuredModelPricing
+    ? RuntimePriceTableSchema.parse(configuredModelPricing)
+    : undefined;
+
   // Report model defaults to Glirastes (fire-and-forget, once)
   let defaultsReported = false;
   function reportDefaultsOnce() {
@@ -660,6 +768,7 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
 
   async function handler(req: Request): Promise<Response> {
     reportDefaultsOnce();
+    let turnMetrics: TurnMetricsRecorder | undefined;
     try {
       const { messages: requestMessages } = await req.json();
 
@@ -726,6 +835,14 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
         });
       }
 
+      turnMetrics = metrics
+        ? createTurnMetricsRecorder({
+            sink: metrics,
+            snapshot: managedTurn?.snapshot,
+            startedAtMs: requestStart,
+          })
+        : undefined;
+
       const buildDiscovery = async (
         registry: ToolRegistry,
         initialToolNames: ReadonlyArray<string>,
@@ -951,6 +1068,7 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
         } else if (pipelineResult.model.instance) {
           model = pipelineResult.model.instance;
         } else {
+          turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
           return new Response(
             JSON.stringify({
               error:
@@ -1055,6 +1173,8 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
           pipelineResult,
           piiShield: piiShield ? { shield: piiShield, sessionId } : undefined,
           managedTurn,
+          turnMetrics,
+          modelPricing,
           toolDiscovery: discoveryController,
           handlerBuiltinToolNames: discoveryController
             ? [...handlerBuiltinNames, 'find_tools']
@@ -1147,6 +1267,7 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
 
       // Resolve model + system prompt (legacy mode — no pipeline fallback)
       if (!modelConfig) {
+        turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
         return new Response(
           JSON.stringify({
             error:
@@ -1213,12 +1334,15 @@ export function createAiChatHandler(config: AiChatHandlerFullConfig) {
         routing,
         piiShield: piiShield ? { shield: piiShield, sessionId: legacySessionId } : undefined,
         managedTurn,
+        turnMetrics,
+        modelPricing,
         toolDiscovery: discoveryController,
         handlerBuiltinToolNames: discoveryController
           ? [...handlerBuiltinNames, 'find_tools']
           : handlerBuiltinNames,
       });
     } catch (error) {
+      turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
       onError?.(error, req);
       return new Response(
         JSON.stringify({ error: 'AI request failed' }),
PATCH
```

````bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/src/server/adapters/nextjs/types.ts b/src/server/adapters/nextjs/types.ts
index 348d26d..0dc6c3a 100644
--- a/src/server/adapters/nextjs/types.ts
+++ b/src/server/adapters/nextjs/types.ts
@@ -22,6 +22,8 @@ import type {
 } from '../../../contracts/index.js';
 import type {
   ManagedTurnBudgetSignal,
+  RuntimeMetricsSink,
+  RuntimePriceTable,
   ToolSearchSemanticsMap,
   TurnSnapshot,
 } from '../../../runtime/index.js';
@@ -322,12 +324,13 @@ export interface AiChatHandlerConfig {
   onAudit?: AuditEmitter;
 
   /**
-   * Remote telemetry sink for forwarding audit events to Glirastes.
+   * Legacy remote telemetry sink (Lancer, `/v1/proctor/events`).
    *
-   * Pass `lancer.telemetry` to enable monitoring on the Glirastes dashboard
-   * — works with both Free and Pro API keys. When combined with `pipeline`,
-   * Pro-tier telemetry is handled by server-pro; this field additionally
-   * forwards adapter-level session events.
+   * Not available with `managedRuntime`: the Foundation control plane does
+   * not serve the Proctor endpoint and these audit payloads are not
+   * content-free, so `createAiChatHandler` refuses the combination. Use
+   * `metrics` there. Without `managedRuntime` the legacy behaviour is
+   * unchanged:
    *
    * ```typescript
    * const lancer = createLancer({ apiKey: process.env.GLIRASTES_API_KEY! });
@@ -336,6 +339,24 @@ export interface AiChatHandlerConfig {
    */
   telemetry?: TelemetrySink;
 
+  /**
+   * Content-free turn metrics (TechnicalRuntimeEvent v2) for the Glirastes
+   * Platform, e.g. `createRuntimeMetricsSinkFromEnv()` from
+   * `glirastes/runtime`. One event per turn (tokens, cost with provenance,
+   * latency, outcome, tool ids); never prompts, messages, arguments, results
+   * or secrets. Recording is synchronous and cheap, delivery happens later
+   * off the turn, and a failing sink never blocks or fails a turn.
+   */
+  metrics?: RuntimeMetricsSink;
+
+  /**
+   * Prices for models whose provider reports no cost (`source:
+   * 'price-table'`). A provider-reported cost (OpenRouter `usage.cost`)
+   * always wins; without either a turn's cost stays unknown (`null`), never
+   * 0. A known cost also counts against the turn's `maxEstimatedCostUsd`.
+   */
+  modelPricing?: RuntimePriceTable;
+
   /**
    * Lancer client for runtime prompt and model overrides (Pro feature).
    *
PATCH
````

- [ ] **Step 4: Document the sink**

````bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git apply <<'PATCH'
diff --git a/docs/managed-runtime-sync.md b/docs/managed-runtime-sync.md
index 6780f09..302b219 100644
--- a/docs/managed-runtime-sync.md
+++ b/docs/managed-runtime-sync.md
@@ -43,3 +43,42 @@ selected by a deterministic subject cohort or an explicit approved pin.
 Use `MemoryRuntimeStateStore` for the zero-setup embedded development path.
 Long-lived and unattended runners should use `FileRuntimeStateStore` or provide
 their own durable `RuntimeStateStore`.
+
+## Runtime metrics
+
+A connected app reports one content-free event per chat turn
+(`TechnicalRuntimeEvent` v2 from `glirastes/contracts`): tokens, cost with its
+provenance, first-token and total latency, the outcome, and tool ids with call
+and error counts. Prompts, messages, tool arguments, tool results, and secrets
+never enter an event; both the SDK and the Platform refuse an event that
+carries them.
+
+```ts
+import { createRuntimeMetricsSinkFromEnv } from 'glirastes/runtime';
+import { createAiChatHandler } from 'glirastes/server/nextjs';
+
+// Undefined in Standalone (no GLIRASTES_CONTROL_PLANE_URL): no network at all.
+const metrics = createRuntimeMetricsSinkFromEnv();
+
+export const POST = createAiChatHandler({
+  // ...model, tools, managedRuntime, systemPrompt
+  metrics,
+});
+```
+
+The sink reads the variables `glirastes connect` writes
+(`GLIRASTES_CONTROL_PLANE_URL`, `GLIRASTES_API_KEY`, `GLIRASTES_APP_ID`,
+`GLIRASTES_ENVIRONMENT_ID`) plus an optional `GLIRASTES_BUILD_ID`. Recording is
+synchronous and cheap; batches of at most 50 events leave every five seconds,
+off the turn. A slow, failing, or rejecting Platform drops the batch; metrics
+never retry, never block a turn, and never keep the process alive. Create the
+sink once per process at module scope, never per request: every sink draws its
+own `instanceId`.
+
+Cost is `provider-reported` when OpenRouter returns `usage.cost`, also through
+`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' })`. A `modelPricing`
+table on the handler estimates the rest (`price-table`, with its version).
+Without either, the cost stays unknown (`null`), never 0. A known cost also
+counts against the turn's `maxEstimatedCostUsd`. The legacy Lancer `telemetry`
+option posts to `/v1/proctor/events`, which the Foundation control plane does
+not serve; the handler refuses it together with `managedRuntime`.
PATCH
````

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ./node_modules/.bin/vitest run src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts src/server/adapters/nextjs/__tests__/managed-runtime.test.ts src/server/adapters/nextjs/__tests__/clarification-flow.test.ts src/server/adapters/nextjs/__tests__/stream-error-boundary.test.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  4 passed (4)`, `Tests  54 passed (54)` (20 new, the existing managed-runtime, clarification and stream-error-boundary tests unchanged), `typecheck=0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/server/adapters/nextjs/create-ai-chat-handler.ts src/server/adapters/nextjs/types.ts src/server/adapters/nextjs/__tests__/runtime-metrics.test.ts docs/managed-runtime-sync.md
git commit -m "feat(server): record turn metrics and cost in the next chat handler"
```

---

## Part B: Platform (`mvp-platform`, after P08b)

All commands of Tasks 6–11 run in `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`. **Start only after P08b Task 14 reported green and SDK Task 1 is committed on `codex/mvp-chat`.**

### Task 6: Verify the Platform baseline after P08b (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Preconditions**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git branch --show-current
git status --short | wc -l
git log --oneline -1
grep -c "export function boundAppOf\|export function appScopeFor" apps/api/src/common/app-scope.ts
node -e "const j=require('./packages/db/drizzle/meta/_journal.json'); console.log(j.entries.at(-1).tag)"
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat show codex/mvp-chat:src/contracts/__vectors__/runtime-metric-event.v2.json | shasum -a 256
```

Expected: `codex/mvp-platform`; `0`; the last P08b commit (Task 13, the audited plan switch, or a later P08b review fix that P08b's checkpoint report names); `2` (P08b Task 12's `boundAppOf` and `appScopeFor`); `0044_bounded_tool_overrides`; `73c5cf4f8d95e8968e11dd6cf921e8b88d387b7d75f056aa91e4bc2b614ab17d  -`. Anything else: stop and report. A newer last journal tag means another plan took `0045`; this plan's migration name, test constant and runbook text then need a new index, which is a plan change, not an implementer decision.

- [ ] **Step 2: Build the DB package and record the baseline**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && ./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?"; ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test 2>&1 | tail -4
```

Expected: `db-build=0`, `api-typecheck=0`, and the API and DB numbers P08b Task 14 reported (its plan predicts `Test Files  120 passed (120)`, `Tests  1288 passed | 10 skipped (1298)`, DB `115 pass` across 21 files; the implemented fix rounds may have added tests). Write the four numbers down as **A_files**, **A_tests**, **D_tests**, **D_files**; Task 13 expects exactly **A_files + 4**, **A_tests + 80**, **D_tests + 17**, **D_files + 2**. (Measured references, both with P08b Task 12's `app-scope.ts` taken from the P08b plan: on `cd6d642` (P08b Tasks 1–8) API `118`/`1282 passed | 10 skipped` became `122`/`1362 passed | 10 skipped`; on `3074b8d` (P08b Tasks 1–10) API `119`/`1296 passed | 10 skipped` became `123`/`1376 passed | 10 skipped`; on `825ddc5` (P08b Tasks 1–10 plus its review fix) API `119`/`1302 passed | 10 skipped` became `123`/`1382 passed | 10 skipped`; DB `103 pass` across 20 files became `120 pass` across 22 files in all three.)

### Task 7: DB – migration `0045_runtime_metrics`

**Files:**
- Create: `packages/db/src/__tests__/runtime-metrics-migration.test.ts`
- Create: `packages/db/src/schema/runtime-metrics.ts`
- Modify: `packages/db/src/schema/index.ts` (append after the last export)
- Generate: `packages/db/drizzle/0045_runtime_metrics.sql`, `packages/db/drizzle/meta/0045_snapshot.json`, `packages/db/drizzle/meta/_journal.json` (entry `idx` 45)
- Modify: `packages/db/MIGRATIONS.md:34-35` and `:120` (next index, runbook)

**Interfaces:**
- Consumes: `runtimeEnvironments` (`tenant_id`, `target_app_id`, `id` scope unique `runtime_environments_scope_id_unique`).
- Produces: tables `runtime_metric_events` (pk `tenant_id, event_id`; checks `runtime_metric_events_status_check`, `runtime_metric_events_cost_check`), `runtime_metric_tool_events` (pk `tenant_id, event_id, tool_id`, cascades with its event), `runtime_metric_hourly` (`UNIQUE NULLS NOT DISTINCT` over the eight dimensions), `runtime_metric_tool_hourly` (same plus `tool_id`); every table except the tool events cascades with its environment through `(tenant_id, target_app_id, environment_id)`. Drizzle exports `runtimeMetricEvents`, `runtimeMetricToolEvents`, `runtimeMetricHourly`, `runtimeMetricToolHourly`.

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/runtime-metrics-migration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TAG = '0045_runtime_metrics';
const journal = JSON.parse(
  readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };
const TENANT = '019fb910-0000-7000-8000-000000000001';
const APP = '019fb910-0000-7000-8000-000000000002';
const ENVIRONMENT = '019fb910-0000-7000-8000-000000000003';
const EVENT = '019fb910-0000-7000-8000-000000000004';
const TOOL = '019fb910-0000-7000-8000-000000000005';

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function seedEnvironment(): Promise<void> {
  await client.exec(`
    INSERT INTO tenants (id, name, slug) VALUES ('${TENANT}', 'Acme', 'acme-metrics')
      ON CONFLICT DO NOTHING;
    INSERT INTO target_apps (id, tenant_id, name) VALUES ('${APP}', '${TENANT}', 'Get It Done')
      ON CONFLICT DO NOTHING;
    INSERT INTO runtime_environments (id, tenant_id, target_app_id, key, name, kind, promotion_order)
      VALUES ('${ENVIRONMENT}', '${TENANT}', '${APP}', 'production', 'Production', 'production', 1)
      ON CONFLICT DO NOTHING;
  `);
}

const eventSql = (overrides: { eventId?: string; status?: string; cost?: string } = {}) => `
  INSERT INTO runtime_metric_events
    (tenant_id, event_id, target_app_id, environment_id, occurred_at, bucket, instance_id,
     status, input_tokens, output_tokens, cost_usd, cost_source, total_ms,
     tool_call_count, tool_error_count)
  VALUES ('${TENANT}', '${overrides.eventId ?? EVENT}', '${APP}', '${ENVIRONMENT}',
     '2026-10-05T10:15:00Z', '2026-10-05T10:00:00Z', 'web-1',
     '${overrides.status ?? 'completed'}', 10, 5, ${overrides.cost ?? `0.01, 'provider-reported'`},
     1200, 1, 0)`;

const hourlySql = (buildId: string) => `
  INSERT INTO runtime_metric_hourly
    (tenant_id, target_app_id, environment_id, bucket, build_id, instance_id, turns, error_turns,
     safety_stop_turns, aborted_turns, input_tokens, output_tokens, provider_cost_usd,
     price_table_cost_usd, unknown_cost_turns, total_ms_sum, total_ms_p50, total_ms_p95,
     total_ms_max, first_token_turns, first_token_ms_sum, tool_calls, tool_errors, aggregated_at)
  VALUES ('${TENANT}', '${APP}', '${ENVIRONMENT}', '2026-10-05T10:00:00Z', ${buildId}, 'web-1',
     1, 0, 0, 0, 10, 5, 0.01, 0, 0, 1200, 1200, 1200, 1200, 0, 0, 1, 0, now())`;

describe('runtime metrics migration', () => {
  it('is generated and only creates the four metrics tables', () => {
    expect(journal.entries.find(({ tag }) => tag === TAG)?.idx).toBe(45);
    const path = `${migrationsFolder}/${TAG}.sql`;
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${migrationsFolder}/meta/0045_snapshot.json`)).toBe(true);
    const sql = readFileSync(path, 'utf8');

    for (const table of [
      'runtime_metric_events',
      'runtime_metric_tool_events',
      'runtime_metric_hourly',
      'runtime_metric_tool_hourly',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain('UNIQUE NULLS NOT DISTINCT');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    const altered = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((match) => match[1]!);
    expect(altered.length).toBeGreaterThan(0);
    expect(altered.filter((table) => !table.startsWith('runtime_metric_'))).toEqual([]);
  });

  it('keeps one row per event and refuses contradictory costs and unknown outcomes', async () => {
    await seedEnvironment();
    await client.exec(eventSql());

    await expect(client.exec(eventSql())).rejects.toThrow(/runtime_metric_events_pk/);
    await expect(client.exec(eventSql({
      eventId: '019fb910-0000-7000-8000-0000000000aa',
      cost: `0, NULL`,
    }))).rejects.toThrow(/runtime_metric_events_cost_check/);
    await expect(client.exec(eventSql({
      eventId: '019fb910-0000-7000-8000-0000000000ab',
      status: 'running',
    }))).rejects.toThrow(/runtime_metric_events_status_check/);
  });

  it('treats a missing build like any other value in the hourly key', async () => {
    await seedEnvironment();
    await client.exec(hourlySql('NULL'));

    await expect(client.exec(hourlySql('NULL')))
      .rejects.toThrow(/runtime_metric_hourly_dimensions_unique/);
    await client.exec(hourlySql(`'git:4f2c9e1'`));
  });

  it('deletes every metric of an environment together with the environment', async () => {
    await seedEnvironment();
    await client.exec(`
      INSERT INTO runtime_metric_tool_events (tenant_id, event_id, tool_id, calls, errors)
        VALUES ('${TENANT}', '${EVENT}', '${TOOL}', 1, 0) ON CONFLICT DO NOTHING;
    `);

    await client.exec(`DELETE FROM runtime_environments WHERE id = '${ENVIRONMENT}'`);

    const { rows } = await client.query<{ events: number; tools: number; hourly: number }>(`
      SELECT (SELECT count(*)::int FROM runtime_metric_events) AS events,
             (SELECT count(*)::int FROM runtime_metric_tool_events) AS tools,
             (SELECT count(*)::int FROM runtime_metric_hourly) AS hourly`);
    expect(rows[0]).toEqual({ events: 0, tools: 0, hourly: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test src/__tests__/runtime-metrics-migration.test.ts 2>&1 | tail -4
```

Expected: `0 pass`, `4 fail`, `Ran 4 tests across 1 file.` (no journal entry, no tables).

- [ ] **Step 3: Declare the schema**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/schema/runtime-metrics.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { runtimeEnvironments } from './runtime-environments';

/**
 * One row per finished chat turn (SDK `TechnicalRuntimeEvent` v2), received
 * from an app-bound runtime key. Content-free by contract; kept only until
 * the hourly aggregation is safe (raw retention, see `runtime-metrics` lib).
 * `bucket` is `occurred_at` truncated to the UTC hour.
 */
export const runtimeMetricEvents = pgTable('runtime_metric_events', {
  tenantId: uuid('tenant_id').notNull(),
  eventId: uuid('event_id').notNull(),
  targetAppId: uuid('target_app_id').notNull(),
  environmentId: uuid('environment_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  buildId: text('build_id'),
  instanceId: text('instance_id').notNull(),
  revisionId: uuid('revision_id'),
  model: text('model'),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: doublePrecision('cost_usd'),
  costSource: text('cost_source'),
  pricingVersion: text('pricing_version'),
  firstTokenMs: integer('first_token_ms'),
  totalMs: integer('total_ms').notNull(),
  toolCallCount: integer('tool_call_count').notNull(),
  toolErrorCount: integer('tool_error_count').notNull(),
}, (t) => [
  primaryKey({ name: 'runtime_metric_events_pk', columns: [t.tenantId, t.eventId] }),
  foreignKey({
    columns: [t.tenantId, t.targetAppId, t.environmentId],
    foreignColumns: [
      runtimeEnvironments.tenantId,
      runtimeEnvironments.targetAppId,
      runtimeEnvironments.id,
    ],
    name: 'runtime_metric_events_environment_fk',
  }).onDelete('cascade'),
  index('runtime_metric_events_bucket_idx').on(t.bucket),
  check(
    'runtime_metric_events_status_check',
    sql`${t.status} in ('completed', 'safety-stop', 'aborted', 'error')`,
  ),
  check(
    'runtime_metric_events_cost_check',
    sql`(${t.costUsd} is null) = (${t.costSource} is null)`,
  ),
]);

/** Tool usage of one turn; deleted with its event. */
export const runtimeMetricToolEvents = pgTable('runtime_metric_tool_events', {
  tenantId: uuid('tenant_id').notNull(),
  eventId: uuid('event_id').notNull(),
  toolId: uuid('tool_id').notNull(),
  calls: integer('calls').notNull(),
  errors: integer('errors').notNull(),
}, (t) => [
  primaryKey({
    name: 'runtime_metric_tool_events_pk',
    columns: [t.tenantId, t.eventId, t.toolId],
  }),
  foreignKey({
    columns: [t.tenantId, t.eventId],
    foreignColumns: [runtimeMetricEvents.tenantId, runtimeMetricEvents.eventId],
    name: 'runtime_metric_tool_events_event_fk',
  }).onDelete('cascade'),
]);

/**
 * Hourly aggregates per app, environment, build, instance, revision and
 * model; the source of every metrics query. Kept per plan (Free 30, Pro 365
 * days by default). Percentiles are per hour; longer ranges report averages
 * and the highest hourly p95.
 */
export const runtimeMetricHourly = pgTable('runtime_metric_hourly', {
  tenantId: uuid('tenant_id').notNull(),
  targetAppId: uuid('target_app_id').notNull(),
  environmentId: uuid('environment_id').notNull(),
  bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  buildId: text('build_id'),
  instanceId: text('instance_id').notNull(),
  revisionId: uuid('revision_id'),
  model: text('model'),
  turns: integer('turns').notNull(),
  errorTurns: integer('error_turns').notNull(),
  safetyStopTurns: integer('safety_stop_turns').notNull(),
  abortedTurns: integer('aborted_turns').notNull(),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
  providerCostUsd: doublePrecision('provider_cost_usd').notNull(),
  priceTableCostUsd: doublePrecision('price_table_cost_usd').notNull(),
  unknownCostTurns: integer('unknown_cost_turns').notNull(),
  totalMsSum: doublePrecision('total_ms_sum').notNull(),
  totalMsP50: integer('total_ms_p50').notNull(),
  totalMsP95: integer('total_ms_p95').notNull(),
  totalMsMax: integer('total_ms_max').notNull(),
  firstTokenTurns: integer('first_token_turns').notNull(),
  firstTokenMsSum: doublePrecision('first_token_ms_sum').notNull(),
  firstTokenMsP95: integer('first_token_ms_p95'),
  toolCalls: integer('tool_calls').notNull(),
  toolErrors: integer('tool_errors').notNull(),
  aggregatedAt: timestamp('aggregated_at', { withTimezone: true }).notNull(),
}, (t) => [
  unique('runtime_metric_hourly_dimensions_unique').on(
    t.tenantId,
    t.targetAppId,
    t.environmentId,
    t.bucket,
    t.buildId,
    t.instanceId,
    t.revisionId,
    t.model,
  ).nullsNotDistinct(),
  foreignKey({
    columns: [t.tenantId, t.targetAppId, t.environmentId],
    foreignColumns: [
      runtimeEnvironments.tenantId,
      runtimeEnvironments.targetAppId,
      runtimeEnvironments.id,
    ],
    name: 'runtime_metric_hourly_environment_fk',
  }).onDelete('cascade'),
  index('runtime_metric_hourly_bucket_idx').on(t.bucket),
]);

/** Hourly tool usage with the same dimensions plus the tool. */
export const runtimeMetricToolHourly = pgTable('runtime_metric_tool_hourly', {
  tenantId: uuid('tenant_id').notNull(),
  targetAppId: uuid('target_app_id').notNull(),
  environmentId: uuid('environment_id').notNull(),
  bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  buildId: text('build_id'),
  instanceId: text('instance_id').notNull(),
  revisionId: uuid('revision_id'),
  model: text('model'),
  toolId: uuid('tool_id').notNull(),
  calls: integer('calls').notNull(),
  errors: integer('errors').notNull(),
  aggregatedAt: timestamp('aggregated_at', { withTimezone: true }).notNull(),
}, (t) => [
  unique('runtime_metric_tool_hourly_dimensions_unique').on(
    t.tenantId,
    t.targetAppId,
    t.environmentId,
    t.bucket,
    t.buildId,
    t.instanceId,
    t.revisionId,
    t.model,
    t.toolId,
  ).nullsNotDistinct(),
  foreignKey({
    columns: [t.tenantId, t.targetAppId, t.environmentId],
    foreignColumns: [
      runtimeEnvironments.tenantId,
      runtimeEnvironments.targetAppId,
      runtimeEnvironments.id,
    ],
    name: 'runtime_metric_tool_hourly_environment_fk',
  }).onDelete('cascade'),
  index('runtime_metric_tool_hourly_bucket_idx').on(t.bucket),
]);
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/src/schema/index.ts b/packages/db/src/schema/index.ts
index 5337bd9..929daf2 100644
--- a/packages/db/src/schema/index.ts
+++ b/packages/db/src/schema/index.ts
@@ -51,3 +51,9 @@ export { runtimeAppSetupToolOverrides } from './runtime-app-setup-tool-overrides
 export { runtimePromptRevisions } from './runtime-prompt-revisions';
 export { runtimeConfigRevisions } from './runtime-config-revisions';
 export { runtimeConnectionPairings } from './runtime-connection-pairings';
+export {
+  runtimeMetricEvents,
+  runtimeMetricToolEvents,
+  runtimeMetricHourly,
+  runtimeMetricToolHourly,
+} from './runtime-metrics';
PATCH
```

- [ ] **Step 4: Generate the migration and update the runbook**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit generate --name runtime_metrics 2>&1 | tail -1
DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1
```

Expected: `[✓] Your SQL migration file ➜ drizzle/0045_runtime_metrics.sql 🚀` and `Everything's fine 🐶🔥`. The generated SQL must be exactly this (compare, never edit; a difference means `src/schema` differs from Step 3):

```sql
CREATE TABLE "runtime_metric_events" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"target_app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"build_id" text,
	"instance_id" text NOT NULL,
	"revision_id" uuid,
	"model" text,
	"status" text NOT NULL,
	"error_code" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" double precision,
	"cost_source" text,
	"pricing_version" text,
	"first_token_ms" integer,
	"total_ms" integer NOT NULL,
	"tool_call_count" integer NOT NULL,
	"tool_error_count" integer NOT NULL,
	CONSTRAINT "runtime_metric_events_pk" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "runtime_metric_events_status_check" CHECK ("runtime_metric_events"."status" in ('completed', 'safety-stop', 'aborted', 'error')),
	CONSTRAINT "runtime_metric_events_cost_check" CHECK (("runtime_metric_events"."cost_usd" is null) = ("runtime_metric_events"."cost_source" is null))
);
--> statement-breakpoint
CREATE TABLE "runtime_metric_hourly" (
	"tenant_id" uuid NOT NULL,
	"target_app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"build_id" text,
	"instance_id" text NOT NULL,
	"revision_id" uuid,
	"model" text,
	"turns" integer NOT NULL,
	"error_turns" integer NOT NULL,
	"safety_stop_turns" integer NOT NULL,
	"aborted_turns" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"provider_cost_usd" double precision NOT NULL,
	"price_table_cost_usd" double precision NOT NULL,
	"unknown_cost_turns" integer NOT NULL,
	"total_ms_sum" double precision NOT NULL,
	"total_ms_p50" integer NOT NULL,
	"total_ms_p95" integer NOT NULL,
	"total_ms_max" integer NOT NULL,
	"first_token_turns" integer NOT NULL,
	"first_token_ms_sum" double precision NOT NULL,
	"first_token_ms_p95" integer,
	"tool_calls" integer NOT NULL,
	"tool_errors" integer NOT NULL,
	"aggregated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtime_metric_hourly_dimensions_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","target_app_id","environment_id","bucket","build_id","instance_id","revision_id","model")
);
--> statement-breakpoint
CREATE TABLE "runtime_metric_tool_events" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"calls" integer NOT NULL,
	"errors" integer NOT NULL,
	CONSTRAINT "runtime_metric_tool_events_pk" PRIMARY KEY("tenant_id","event_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "runtime_metric_tool_hourly" (
	"tenant_id" uuid NOT NULL,
	"target_app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"build_id" text,
	"instance_id" text NOT NULL,
	"revision_id" uuid,
	"model" text,
	"tool_id" uuid NOT NULL,
	"calls" integer NOT NULL,
	"errors" integer NOT NULL,
	"aggregated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtime_metric_tool_hourly_dimensions_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","target_app_id","environment_id","bucket","build_id","instance_id","revision_id","model","tool_id")
);
--> statement-breakpoint
ALTER TABLE "runtime_metric_events" ADD CONSTRAINT "runtime_metric_events_environment_fk" FOREIGN KEY ("tenant_id","target_app_id","environment_id") REFERENCES "public"."runtime_environments"("tenant_id","target_app_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_metric_hourly" ADD CONSTRAINT "runtime_metric_hourly_environment_fk" FOREIGN KEY ("tenant_id","target_app_id","environment_id") REFERENCES "public"."runtime_environments"("tenant_id","target_app_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_metric_tool_events" ADD CONSTRAINT "runtime_metric_tool_events_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."runtime_metric_events"("tenant_id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_metric_tool_hourly" ADD CONSTRAINT "runtime_metric_tool_hourly_environment_fk" FOREIGN KEY ("tenant_id","target_app_id","environment_id") REFERENCES "public"."runtime_environments"("tenant_id","target_app_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_metric_events_bucket_idx" ON "runtime_metric_events" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "runtime_metric_hourly_bucket_idx" ON "runtime_metric_hourly" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "runtime_metric_tool_hourly_bucket_idx" ON "runtime_metric_tool_hourly" USING btree ("bucket");
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/MIGRATIONS.md b/packages/db/MIGRATIONS.md
index fe4ecd9..3903bc8 100644
--- a/packages/db/MIGRATIONS.md
+++ b/packages/db/MIGRATIONS.md
@@ -32,7 +32,8 @@ in-process PostgreSQL (PGlite, no network):
 
    This writes `drizzle/<idx>_<what_it_does>.sql`, `drizzle/meta/<idx>_snapshot.json`
    and the journal entry together. `0044_bounded_tool_overrides` was the
-   first migration generated this way; the next index is `0045`.
+   first migration generated this way, `0045_runtime_metrics` the second; the
+   next index is `0046`.
 3. If the SQL has to be written by hand (data backfills, checks, triggers),
    keep the generated journal entry and snapshot and edit only the SQL. Put
    `--> statement-breakpoint` between statements: the migrator sends each
@@ -117,7 +118,8 @@ never run by an agent.
 
 3. Run the reviewed file against the database, then `bun run db:migrate`.
    It applies only migrations newer than `0043` (from 2026-10-05:
-   `0044_bounded_tool_overrides`) and nothing before them. Afterwards
+   `0044_bounded_tool_overrides`, then `0045_runtime_metrics`) and nothing
+   before them. Afterwards
    `drizzle.__drizzle_migrations` holds exactly one row per journal entry
    (`select count(*) from drizzle.__drizzle_migrations` equals the number of
    `entries` in `meta/_journal.json`).
PATCH
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test src/__tests__/runtime-metrics-migration.test.ts 2>&1 | tail -4
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts src/__tests__/bounded-tool-overrides-migration.test.ts src/__tests__/runtime-metrics-migration.test.ts src/__tests__/schema-snapshot.test.ts src/__tests__/migration-journal.test.ts 2>&1 | tail -4
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && ./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
```

Expected: `4 pass`, `0 fail`; then `17 pass`, `0 fail`, `Ran 17 tests across 6 files.` (from scratch, the hand-migrated baseline, both migration tests, the snapshot and the journal all accept `0045`); `db-build=0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/src/schema/runtime-metrics.ts packages/db/src/schema/index.ts packages/db/drizzle/0045_runtime_metrics.sql packages/db/drizzle/meta/0045_snapshot.json packages/db/drizzle/meta/_journal.json packages/db/src/__tests__/runtime-metrics-migration.test.ts packages/db/MIGRATIONS.md
git commit -m "feat(db): add runtime metric event and hourly tables"
```

### Task 8: DB – aggregate, prune and query runtime metrics

**Files:**
- Create: `packages/db/src/__tests__/runtime-metrics.test.ts`
- Create: `packages/db/src/lib/runtime-metrics.ts`
- Modify: `packages/db/src/index.ts` (append after the `./lib/workspace-name` export)

**Interfaces:**
- Consumes: the four tables (Task 7), `tenants.plan`.
- Produces (exported from `@glirastes/db`):
  - `RUNTIME_METRIC_RAW_RETENTION_DAYS = 7`, `RUNTIME_METRIC_MAX_EVENT_AGE_HOURS = 24`, `RUNTIME_METRIC_AGGREGATION_LOOKBACK_HOURS = 26`
  - `type RuntimeMetricsDb = PgDatabase<any, any, any>`; `interface RuntimeMetricEventInput` (one row plus `tools[]`); `interface RuntimeMetricsRetention { freeDays: number; proDays: number }`; `interface RuntimeMetricsFilter { tenantId; targetAppId; environmentId?; buildId?; instanceId?; revisionId?; model?; from: Date; to: Date }`; `type RuntimeMetricsDimension = 'environment' | 'build' | 'instance' | 'revision' | 'model'`; `interface RuntimeMetricsMeasures` (turns, error/safety-stop/aborted turns, tokens, provider and price-table cost, unknown-cost turns, total and first-token sums, `maxP95TotalMs`, tool calls and errors); `interface RuntimeToolUsage { toolId; calls; errors }`
  - `hourBucket(date: Date): Date`
  - `insertRuntimeMetricEvents(db, events, receivedAt): Promise<{ inserted: number; duplicates: number }>`
  - `aggregateRuntimeMetrics(db, { now, lookbackHours? }): Promise<{ groups: number; toolGroups: number }>`
  - `pruneRuntimeMetrics(db, { now, retention }): Promise<void>`
  - `queryRuntimeMetricTotals(db, filter)`, `queryRuntimeMetricSeries(db, filter)`, `queryRuntimeMetricBreakdown(db, filter, dimension, limit = 100)`, `queryRuntimeToolUsage(db, filter, limit = 20)`

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/runtime-metrics.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  aggregateRuntimeMetrics,
  hourBucket,
  insertRuntimeMetricEvents,
  pruneRuntimeMetrics,
  queryRuntimeMetricBreakdown,
  queryRuntimeMetricSeries,
  queryRuntimeMetricTotals,
  queryRuntimeToolUsage,
  type RuntimeMetricEventInput,
  type RuntimeMetricsDb,
  type RuntimeMetricsFilter,
} from '../lib/runtime-metrics';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const id = (n: number) => `019fb920-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const FREE_TENANT = id(1);
const PRO_TENANT = id(2);
const FREE_APP = id(11);
const PRO_APP = id(12);
const PRODUCTION = id(21);
const STAGING = id(22);
const PRO_ENVIRONMENT = id(23);
const REVISION_1 = id(31);
const REVISION_2 = id(32);
const TOOL_1 = id(41);
const TOOL_2 = id(42);
const TOOL_3 = id(43);
const NOW = new Date('2026-10-05T12:30:00.000Z');
const DAY = 86_400_000;

let client: PGlite;
let db: RuntimeMetricsDb;
let nextEvent = 100;

function turn(patch: Partial<RuntimeMetricEventInput>): RuntimeMetricEventInput {
  nextEvent += 1;
  return {
    tenantId: FREE_TENANT,
    eventId: id(nextEvent),
    targetAppId: FREE_APP,
    environmentId: PRODUCTION,
    occurredAt: new Date('2026-10-05T10:05:00.000Z'),
    buildId: 'git:b1',
    instanceId: 'web-1',
    revisionId: REVISION_1,
    model: 'vendor/model-a',
    status: 'completed',
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    costSource: null,
    pricingVersion: null,
    firstTokenMs: null,
    totalMs: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    tools: [],
    ...patch,
  };
}

const appFilter = (patch: Partial<RuntimeMetricsFilter> = {}): RuntimeMetricsFilter => ({
  tenantId: FREE_TENANT,
  targetAppId: FREE_APP,
  from: new Date('2026-10-05T10:00:00.000Z'),
  to: new Date('2026-10-05T13:00:00.000Z'),
  ...patch,
});

const first = turn({
  inputTokens: 100, outputTokens: 20, costUsd: 0.01, costSource: 'provider-reported',
  firstTokenMs: 300, totalMs: 1_000, toolCallCount: 2,
  tools: [{ toolId: TOOL_1, calls: 2, errors: 0 }],
});
const second = turn({
  occurredAt: new Date('2026-10-05T10:20:00.000Z'), status: 'error', errorCode: 'model_error',
  inputTokens: 50, totalMs: 3_000,
});
const third = turn({
  occurredAt: new Date('2026-10-05T10:40:00.000Z'),
  inputTokens: 200, outputTokens: 40, costUsd: 0.02, costSource: 'price-table', pricingVersion: 'v1',
  firstTokenMs: 500, totalMs: 2_000, toolCallCount: 3, toolErrorCount: 1,
  tools: [{ toolId: TOOL_1, calls: 1, errors: 1 }, { toolId: TOOL_2, calls: 1, errors: 0 }],
});
const fourth = turn({
  occurredAt: new Date('2026-10-05T11:10:00.000Z'), buildId: null, instanceId: 'web-2',
  revisionId: null, model: 'vendor/model-b', status: 'safety-stop', errorCode: 'budget_exhausted',
  inputTokens: 10, outputTokens: 10, costUsd: 0.005, costSource: 'provider-reported',
  firstTokenMs: 100, totalMs: 400,
});
const fifth = turn({
  occurredAt: new Date('2026-10-05T11:30:00.000Z'), environmentId: STAGING, buildId: 'git:b2',
  revisionId: REVISION_2, status: 'aborted', inputTokens: 5, totalMs: 50,
});
const proTurn = turn({
  tenantId: PRO_TENANT, targetAppId: PRO_APP, environmentId: PRO_ENVIRONMENT,
  occurredAt: new Date('2026-10-05T12:10:00.000Z'), buildId: 'git:x', instanceId: 'pro-1',
  revisionId: null, inputTokens: 1_000, outputTokens: 1_000, costUsd: 1, costSource: 'provider-reported',
  totalMs: 100, toolCallCount: 1, tools: [{ toolId: TOOL_3, calls: 1, errors: 0 }],
});

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
  db = drizzle(client) as unknown as RuntimeMetricsDb;
  await client.exec(`
    INSERT INTO tenants (id, name, slug, plan) VALUES
      ('${FREE_TENANT}', 'Acme', 'acme-runtime-metrics', 'free'),
      ('${PRO_TENANT}', 'Globex', 'globex-runtime-metrics', 'pro');
    INSERT INTO target_apps (id, tenant_id, name) VALUES
      ('${FREE_APP}', '${FREE_TENANT}', 'Get It Done'),
      ('${PRO_APP}', '${PRO_TENANT}', 'Globex Desk');
    INSERT INTO runtime_environments (id, tenant_id, target_app_id, key, name, kind, promotion_order) VALUES
      ('${PRODUCTION}', '${FREE_TENANT}', '${FREE_APP}', 'production', 'Production', 'production', 2),
      ('${STAGING}', '${FREE_TENANT}', '${FREE_APP}', 'staging', 'Staging', 'staging', 1),
      ('${PRO_ENVIRONMENT}', '${PRO_TENANT}', '${PRO_APP}', 'production', 'Production', 'production', 1);
  `);
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe('runtime metrics storage', () => {
  it('stores each event once and its tool usage with it', async () => {
    expect(await insertRuntimeMetricEvents(db, [first, first, second], NOW))
      .toEqual({ inserted: 2, duplicates: 1 });
    expect(await insertRuntimeMetricEvents(db, [first, third, fourth, fifth, proTurn], NOW))
      .toEqual({ inserted: 4, duplicates: 1 });

    const { rows } = await client.query<{ events: number; calls: number; bucket: string }>(`
      SELECT (SELECT count(*)::int FROM runtime_metric_events) AS events,
             (SELECT sum(calls)::int FROM runtime_metric_tool_events) AS calls,
             (SELECT bucket::text FROM runtime_metric_events WHERE event_id = '${third.eventId}') AS bucket`);
    expect(rows[0]).toEqual({ events: 6, calls: 5, bucket: '2026-10-05 10:00:00+00' });
  });

  it('aggregates every hour of the lookback window with cost provenance and percentiles', async () => {
    expect(await aggregateRuntimeMetrics(db, { now: NOW })).toEqual({ groups: 4, toolGroups: 3 });

    const { rows } = await client.query<Record<string, number | null>>(`
      SELECT turns, error_turns, safety_stop_turns, aborted_turns, input_tokens::int AS input_tokens,
             output_tokens::int AS output_tokens, provider_cost_usd, price_table_cost_usd,
             unknown_cost_turns, total_ms_sum, total_ms_p50, total_ms_p95, total_ms_max,
             first_token_turns, first_token_ms_sum, first_token_ms_p95, tool_calls, tool_errors
        FROM runtime_metric_hourly
       WHERE environment_id = '${PRODUCTION}' AND bucket = '2026-10-05T10:00:00Z'`);
    expect(rows).toEqual([{
      turns: 3, error_turns: 1, safety_stop_turns: 0, aborted_turns: 0,
      input_tokens: 350, output_tokens: 60, provider_cost_usd: 0.01, price_table_cost_usd: 0.02,
      unknown_cost_turns: 1, total_ms_sum: 6_000, total_ms_p50: 2_000, total_ms_p95: 2_900,
      total_ms_max: 3_000, first_token_turns: 2, first_token_ms_sum: 800, first_token_ms_p95: 490,
      tool_calls: 5, tool_errors: 1,
    }]);
  });

  it('recomputes an hour when a late event arrives, without duplicating rows', async () => {
    await aggregateRuntimeMetrics(db, { now: NOW });
    await insertRuntimeMetricEvents(db, [turn({ totalMs: 4_000 })], NOW);
    await aggregateRuntimeMetrics(db, { now: NOW });

    const { rows } = await client.query<{ rows: number; turns: number }>(`
      SELECT count(*)::int AS rows, sum(turns)::int AS turns FROM runtime_metric_hourly
       WHERE tenant_id = '${FREE_TENANT}'`);
    expect(rows[0]).toEqual({ rows: 3, turns: 6 });
  });

  it('leaves hours outside the lookback window alone', async () => {
    await insertRuntimeMetricEvents(db, [
      turn({ occurredAt: new Date(NOW.getTime() - 30 * 3_600_000) }),
    ], NOW);
    await aggregateRuntimeMetrics(db, { now: NOW });

    const { rows } = await client.query<{ rows: number }>(`
      SELECT count(*)::int AS rows FROM runtime_metric_hourly
       WHERE bucket < '2026-10-05T10:00:00Z'`);
    expect(rows[0]).toEqual({ rows: 0 });
  });
});

describe('runtime metrics queries', () => {
  it('totals an app across environments, builds and models', async () => {
    const totals = await queryRuntimeMetricTotals(db, appFilter());

    expect(totals).toMatchObject({
      turns: 6, errorTurns: 1, safetyStopTurns: 1, abortedTurns: 1,
      inputTokens: 365, outputTokens: 70, unknownCostTurns: 3,
      totalMsSum: 10_450, maxP95TotalMs: 3_850, firstTokenTurns: 3, firstTokenMsSum: 900,
      toolCalls: 5, toolErrors: 1,
    });
    expect(totals.providerCostUsd).toBeCloseTo(0.015, 10);
    expect(totals.priceTableCostUsd).toBeCloseTo(0.02, 10);
  });

  it('filters by environment, build, instance, revision and model', async () => {
    expect((await queryRuntimeMetricTotals(db, appFilter({ environmentId: STAGING }))).turns).toBe(1);
    expect((await queryRuntimeMetricTotals(db, appFilter({ buildId: 'git:b1' }))).turns).toBe(4);
    expect((await queryRuntimeMetricTotals(db, appFilter({ instanceId: 'web-2' }))).turns).toBe(1);
    expect((await queryRuntimeMetricTotals(db, appFilter({ revisionId: REVISION_2 }))).turns).toBe(1);
    expect((await queryRuntimeMetricTotals(db, appFilter({ model: 'vendor/model-b' }))).turns).toBe(1);
  });

  it('returns an hourly series in time order', async () => {
    const series = await queryRuntimeMetricSeries(db, appFilter({ environmentId: PRODUCTION }));

    expect(series.map((point) => [point.bucket.toISOString(), point.turns])).toEqual([
      ['2026-10-05T10:00:00.000Z', 4],
      ['2026-10-05T11:00:00.000Z', 1],
    ]);
  });

  it('breaks totals down by one dimension, largest first', async () => {
    const byBuild = await queryRuntimeMetricBreakdown(db, appFilter(), 'build');
    expect(byBuild.map((row) => [row.key, row.turns])).toEqual([
      ['git:b1', 4], ['git:b2', 1], [null, 1],
    ]);
    const byModel = await queryRuntimeMetricBreakdown(db, appFilter(), 'model');
    expect(byModel.map((row) => [row.key, row.turns])).toEqual([
      ['vendor/model-a', 5], ['vendor/model-b', 1],
    ]);
    const byEnvironment = await queryRuntimeMetricBreakdown(db, appFilter(), 'environment');
    expect(byEnvironment.map((row) => [row.key, row.turns])).toEqual([
      [PRODUCTION, 5], [STAGING, 1],
    ]);
  });

  it('ranks tool usage with errors', async () => {
    expect(await queryRuntimeToolUsage(db, appFilter())).toEqual([
      { toolId: TOOL_1, calls: 3, errors: 1 },
      { toolId: TOOL_2, calls: 1, errors: 0 },
    ]);
  });

  it('never returns another tenant’s metrics', async () => {
    const foreign = await queryRuntimeMetricTotals(db, appFilter({ targetAppId: PRO_APP }));
    expect(foreign).toMatchObject({ turns: 0, totalMsSum: 0, maxP95TotalMs: null });
    expect(await queryRuntimeToolUsage(db, appFilter({ targetAppId: PRO_APP }))).toEqual([]);
  });
});

describe('runtime metrics retention', () => {
  const retention = { freeDays: 30, proDays: 365 };

  it('drops raw events after seven days together with their tool usage', async () => {
    await pruneRuntimeMetrics(db, { now: new Date(NOW.getTime() + 8 * DAY), retention });

    const { rows } = await client.query<{ events: number; tools: number; hourly: number }>(`
      SELECT (SELECT count(*)::int FROM runtime_metric_events) AS events,
             (SELECT count(*)::int FROM runtime_metric_tool_events) AS tools,
             (SELECT count(*)::int FROM runtime_metric_hourly) AS hourly`);
    expect(rows[0]).toEqual({ events: 0, tools: 0, hourly: 4 });
  });

  it('keeps Free history for 30 days and Pro history for 365 days', async () => {
    await pruneRuntimeMetrics(db, { now: new Date(NOW.getTime() + 31 * DAY), retention });
    const afterFree = await client.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM runtime_metric_hourly',
    );
    expect(afterFree.rows).toEqual([{ tenant_id: PRO_TENANT }]);
    const freeTools = await client.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM runtime_metric_tool_hourly WHERE tenant_id = '${FREE_TENANT}'`,
    );
    expect(freeTools.rows[0]).toEqual({ rows: 0 });

    await pruneRuntimeMetrics(db, { now: new Date(NOW.getTime() + 366 * DAY), retention });
    const afterPro = await client.query<{ hourly: number; tools: number }>(`
      SELECT (SELECT count(*)::int FROM runtime_metric_hourly) AS hourly,
             (SELECT count(*)::int FROM runtime_metric_tool_hourly) AS tools`);
    expect(afterPro.rows[0]).toEqual({ hourly: 0, tools: 0 });
  });

  it('truncates instants to the UTC hour', () => {
    expect(hourBucket(new Date('2026-10-05T10:59:59.999+05:30')).toISOString())
      .toBe('2026-10-05T05:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test src/__tests__/runtime-metrics.test.ts 2>&1 | tail -5
```

Expected: `0 pass`, `1 fail`, `1 error`, `Ran 1 test across 1 file.` (`Cannot find module '../lib/runtime-metrics'`).

- [ ] **Step 3: Implement the SQL helpers and export them**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/lib/runtime-metrics.ts`:

```ts
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn, PgDatabase } from 'drizzle-orm/pg-core';
import {
  runtimeMetricEvents,
  runtimeMetricHourly,
  runtimeMetricToolEvents,
  runtimeMetricToolHourly,
} from '../schema/runtime-metrics';
import { tenants } from '../schema/tenants';

export type RuntimeMetricsDb = PgDatabase<any, any, any>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Raw turn events live this long; aggregates follow the plan retention. */
export const RUNTIME_METRIC_RAW_RETENTION_DAYS = 7;
/** Ingest refuses events older than this (clock skew and offline queues). */
export const RUNTIME_METRIC_MAX_EVENT_AGE_HOURS = 24;
/**
 * Every aggregation run recomputes the hours this far back, so an event that
 * arrives up to 24 h late lands in its hour as long as the job runs at least
 * every two hours.
 */
export const RUNTIME_METRIC_AGGREGATION_LOOKBACK_HOURS = 26;

export interface RuntimeMetricEventInput {
  tenantId: string;
  eventId: string;
  targetAppId: string;
  environmentId: string;
  occurredAt: Date;
  buildId: string | null;
  instanceId: string;
  revisionId: string | null;
  model: string | null;
  status: 'completed' | 'safety-stop' | 'aborted' | 'error';
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: 'provider-reported' | 'price-table' | null;
  pricingVersion: string | null;
  firstTokenMs: number | null;
  totalMs: number;
  toolCallCount: number;
  toolErrorCount: number;
  tools: ReadonlyArray<{ toolId: string; calls: number; errors: number }>;
}

export interface RuntimeMetricsRetention {
  /** Hourly history kept for tenants on the Free plan. */
  freeDays: number;
  /** Hourly history kept for every other plan. */
  proDays: number;
}

export interface RuntimeMetricsFilter {
  tenantId: string;
  targetAppId: string;
  environmentId?: string;
  buildId?: string;
  instanceId?: string;
  revisionId?: string;
  model?: string;
  /** Inclusive, hour-aligned. */
  from: Date;
  /** Exclusive, hour-aligned. */
  to: Date;
}

export type RuntimeMetricsDimension =
  | 'environment'
  | 'build'
  | 'instance'
  | 'revision'
  | 'model';

export interface RuntimeMetricsMeasures {
  turns: number;
  errorTurns: number;
  safetyStopTurns: number;
  abortedTurns: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  priceTableCostUsd: number;
  unknownCostTurns: number;
  totalMsSum: number;
  /** Highest hourly p95 in the range; null without turns. */
  maxP95TotalMs: number | null;
  firstTokenTurns: number;
  firstTokenMsSum: number;
  toolCalls: number;
  toolErrors: number;
}

export interface RuntimeToolUsage {
  toolId: string;
  calls: number;
  errors: number;
}

/** The UTC hour an instant falls into. */
export function hourBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Stores turn events once per `(tenant, eventId)`: a repeated event is a
 * duplicate and never counts twice. Tool usage is stored only for events
 * this call inserted.
 */
export async function insertRuntimeMetricEvents(
  db: RuntimeMetricsDb,
  events: ReadonlyArray<RuntimeMetricEventInput>,
  receivedAt: Date,
): Promise<{ inserted: number; duplicates: number }> {
  if (events.length === 0) return { inserted: 0, duplicates: 0 };
  const inserted = await db.insert(runtimeMetricEvents)
    .values(events.map(({ tools: _tools, ...event }) => ({
      ...event,
      bucket: hourBucket(event.occurredAt),
      receivedAt,
    })))
    .onConflictDoNothing({
      target: [runtimeMetricEvents.tenantId, runtimeMetricEvents.eventId],
    })
    .returning({ eventId: runtimeMetricEvents.eventId });
  const fresh = new Set(inserted.map((row) => row.eventId));
  const toolRows = events
    .filter((event) => fresh.has(event.eventId))
    .flatMap((event) => event.tools.map((tool) => ({
      tenantId: event.tenantId,
      eventId: event.eventId,
      toolId: tool.toolId,
      calls: tool.calls,
      errors: tool.errors,
    })));
  if (toolRows.length > 0) {
    await db.insert(runtimeMetricToolEvents).values(toolRows).onConflictDoNothing();
  }
  return { inserted: fresh.size, duplicates: events.length - fresh.size };
}

function excluded(column: PgColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

/**
 * Recomputes the hourly aggregates of every hour in the lookback window from
 * the raw events (idempotent: a rerun replaces the same rows). Hours outside
 * the window keep their aggregates.
 */
export async function aggregateRuntimeMetrics(
  db: RuntimeMetricsDb,
  options: { now: Date; lookbackHours?: number },
): Promise<{ groups: number; toolGroups: number }> {
  const lookback = options.lookbackHours ?? RUNTIME_METRIC_AGGREGATION_LOOKBACK_HOURS;
  const to = new Date(hourBucket(options.now).getTime() + HOUR_MS);
  const from = new Date(hourBucket(options.now).getTime() - lookback * HOUR_MS);
  const e = runtimeMetricEvents;
  const dimensions = {
    tenantId: e.tenantId,
    targetAppId: e.targetAppId,
    environmentId: e.environmentId,
    bucket: e.bucket,
    buildId: e.buildId,
    instanceId: e.instanceId,
    revisionId: e.revisionId,
    model: e.model,
  };
  const inWindow = and(gte(e.bucket, from), lt(e.bucket, to));

  const groups = await db.select({
    ...dimensions,
    turns: sql<number>`count(*)::int`,
    errorTurns: sql<number>`(count(*) filter (where ${e.status} = 'error'))::int`,
    safetyStopTurns: sql<number>`(count(*) filter (where ${e.status} = 'safety-stop'))::int`,
    abortedTurns: sql<number>`(count(*) filter (where ${e.status} = 'aborted'))::int`,
    inputTokens: sql<number>`sum(${e.inputTokens})::float8`,
    outputTokens: sql<number>`sum(${e.outputTokens})::float8`,
    providerCostUsd: sql<number>`coalesce(sum(${e.costUsd}) filter (where ${e.costSource} = 'provider-reported'), 0)::float8`,
    priceTableCostUsd: sql<number>`coalesce(sum(${e.costUsd}) filter (where ${e.costSource} = 'price-table'), 0)::float8`,
    unknownCostTurns: sql<number>`(count(*) filter (where ${e.costUsd} is null))::int`,
    totalMsSum: sql<number>`sum(${e.totalMs})::float8`,
    totalMsP50: sql<number>`round(percentile_cont(0.5) within group (order by ${e.totalMs}))::int`,
    totalMsP95: sql<number>`round(percentile_cont(0.95) within group (order by ${e.totalMs}))::int`,
    totalMsMax: sql<number>`max(${e.totalMs})::int`,
    firstTokenTurns: sql<number>`count(${e.firstTokenMs})::int`,
    firstTokenMsSum: sql<number>`coalesce(sum(${e.firstTokenMs}), 0)::float8`,
    firstTokenMsP95: sql<number | null>`round(percentile_cont(0.95) within group (order by ${e.firstTokenMs}))::int`,
    toolCalls: sql<number>`sum(${e.toolCallCount})::int`,
    toolErrors: sql<number>`sum(${e.toolErrorCount})::int`,
  }).from(e).where(inWindow).groupBy(...Object.values(dimensions));

  const h = runtimeMetricHourly;
  for (const chunk of chunks(groups, 500)) {
    await db.insert(h)
      .values(chunk.map((group) => ({ ...group, aggregatedAt: options.now })))
      .onConflictDoUpdate({
        target: [
          h.tenantId, h.targetAppId, h.environmentId, h.bucket,
          h.buildId, h.instanceId, h.revisionId, h.model,
        ],
        set: {
          turns: excluded(h.turns),
          errorTurns: excluded(h.errorTurns),
          safetyStopTurns: excluded(h.safetyStopTurns),
          abortedTurns: excluded(h.abortedTurns),
          inputTokens: excluded(h.inputTokens),
          outputTokens: excluded(h.outputTokens),
          providerCostUsd: excluded(h.providerCostUsd),
          priceTableCostUsd: excluded(h.priceTableCostUsd),
          unknownCostTurns: excluded(h.unknownCostTurns),
          totalMsSum: excluded(h.totalMsSum),
          totalMsP50: excluded(h.totalMsP50),
          totalMsP95: excluded(h.totalMsP95),
          totalMsMax: excluded(h.totalMsMax),
          firstTokenTurns: excluded(h.firstTokenTurns),
          firstTokenMsSum: excluded(h.firstTokenMsSum),
          firstTokenMsP95: excluded(h.firstTokenMsP95),
          toolCalls: excluded(h.toolCalls),
          toolErrors: excluded(h.toolErrors),
          aggregatedAt: excluded(h.aggregatedAt),
        },
      });
  }

  const t = runtimeMetricToolEvents;
  const toolGroups = await db.select({
    ...dimensions,
    toolId: t.toolId,
    calls: sql<number>`sum(${t.calls})::int`,
    errors: sql<number>`sum(${t.errors})::int`,
  }).from(t)
    .innerJoin(e, and(eq(t.tenantId, e.tenantId), eq(t.eventId, e.eventId)))
    .where(inWindow)
    .groupBy(...Object.values(dimensions), t.toolId);

  const th = runtimeMetricToolHourly;
  for (const chunk of chunks(toolGroups, 1_000)) {
    await db.insert(th)
      .values(chunk.map((group) => ({ ...group, aggregatedAt: options.now })))
      .onConflictDoUpdate({
        target: [
          th.tenantId, th.targetAppId, th.environmentId, th.bucket,
          th.buildId, th.instanceId, th.revisionId, th.model, th.toolId,
        ],
        set: {
          calls: excluded(th.calls),
          errors: excluded(th.errors),
          aggregatedAt: excluded(th.aggregatedAt),
        },
      });
  }

  return { groups: groups.length, toolGroups: toolGroups.length };
}

/**
 * Deletes raw events after `RUNTIME_METRIC_RAW_RETENTION_DAYS` and hourly
 * aggregates after the retention of the tenant's plan (Free: `freeDays`,
 * every other plan: `proDays`).
 */
export async function pruneRuntimeMetrics(
  db: RuntimeMetricsDb,
  options: { now: Date; retention: RuntimeMetricsRetention },
): Promise<void> {
  const now = options.now.getTime();
  await db.delete(runtimeMetricEvents).where(lt(
    runtimeMetricEvents.bucket,
    hourBucket(new Date(now - RUNTIME_METRIC_RAW_RETENTION_DAYS * DAY_MS)),
  ));
  const freeCutoff = hourBucket(new Date(now - options.retention.freeDays * DAY_MS));
  const proCutoff = hourBucket(new Date(now - options.retention.proDays * DAY_MS));
  const freeTenants = db.select({ id: tenants.id }).from(tenants)
    .where(eq(tenants.plan, 'free'));
  const h = runtimeMetricHourly;
  const th = runtimeMetricToolHourly;
  await db.delete(h).where(and(lt(h.bucket, freeCutoff), inArray(h.tenantId, freeTenants)));
  await db.delete(h).where(and(lt(h.bucket, proCutoff), notInArray(h.tenantId, freeTenants)));
  await db.delete(th).where(and(lt(th.bucket, freeCutoff), inArray(th.tenantId, freeTenants)));
  await db.delete(th).where(and(lt(th.bucket, proCutoff), notInArray(th.tenantId, freeTenants)));
}

type DimensionColumns = {
  tenantId: PgColumn;
  targetAppId: PgColumn;
  environmentId: PgColumn;
  bucket: PgColumn;
  buildId: PgColumn;
  instanceId: PgColumn;
  revisionId: PgColumn;
  model: PgColumn;
};

function filterBy(columns: DimensionColumns, filter: RuntimeMetricsFilter): SQL {
  const conditions: SQL[] = [
    eq(columns.tenantId, filter.tenantId),
    eq(columns.targetAppId, filter.targetAppId),
    gte(columns.bucket, filter.from),
    lt(columns.bucket, filter.to),
  ];
  if (filter.environmentId) conditions.push(eq(columns.environmentId, filter.environmentId));
  if (filter.buildId) conditions.push(eq(columns.buildId, filter.buildId));
  if (filter.instanceId) conditions.push(eq(columns.instanceId, filter.instanceId));
  if (filter.revisionId) conditions.push(eq(columns.revisionId, filter.revisionId));
  if (filter.model) conditions.push(eq(columns.model, filter.model));
  return and(...conditions)!;
}

const h = runtimeMetricHourly;
const measures = {
  turns: sql<number>`coalesce(sum(${h.turns}), 0)::float8`,
  errorTurns: sql<number>`coalesce(sum(${h.errorTurns}), 0)::float8`,
  safetyStopTurns: sql<number>`coalesce(sum(${h.safetyStopTurns}), 0)::float8`,
  abortedTurns: sql<number>`coalesce(sum(${h.abortedTurns}), 0)::float8`,
  inputTokens: sql<number>`coalesce(sum(${h.inputTokens}), 0)::float8`,
  outputTokens: sql<number>`coalesce(sum(${h.outputTokens}), 0)::float8`,
  providerCostUsd: sql<number>`coalesce(sum(${h.providerCostUsd}), 0)::float8`,
  priceTableCostUsd: sql<number>`coalesce(sum(${h.priceTableCostUsd}), 0)::float8`,
  unknownCostTurns: sql<number>`coalesce(sum(${h.unknownCostTurns}), 0)::float8`,
  totalMsSum: sql<number>`coalesce(sum(${h.totalMsSum}), 0)::float8`,
  maxP95TotalMs: sql<number | null>`max(${h.totalMsP95})::float8`,
  firstTokenTurns: sql<number>`coalesce(sum(${h.firstTokenTurns}), 0)::float8`,
  firstTokenMsSum: sql<number>`coalesce(sum(${h.firstTokenMsSum}), 0)::float8`,
  toolCalls: sql<number>`coalesce(sum(${h.toolCalls}), 0)::float8`,
  toolErrors: sql<number>`coalesce(sum(${h.toolErrors}), 0)::float8`,
};

const DIMENSION_COLUMNS: Record<RuntimeMetricsDimension, PgColumn> = {
  environment: h.environmentId,
  build: h.buildId,
  instance: h.instanceId,
  revision: h.revisionId,
  model: h.model,
};

export async function queryRuntimeMetricTotals(
  db: RuntimeMetricsDb,
  filter: RuntimeMetricsFilter,
): Promise<RuntimeMetricsMeasures> {
  const [row] = await db.select(measures).from(h).where(filterBy(h, filter));
  return row as RuntimeMetricsMeasures;
}

export async function queryRuntimeMetricSeries(
  db: RuntimeMetricsDb,
  filter: RuntimeMetricsFilter,
): Promise<Array<RuntimeMetricsMeasures & { bucket: Date }>> {
  return await db.select({ bucket: h.bucket, ...measures })
    .from(h)
    .where(filterBy(h, filter))
    .groupBy(h.bucket)
    .orderBy(asc(h.bucket)) as Array<RuntimeMetricsMeasures & { bucket: Date }>;
}

export async function queryRuntimeMetricBreakdown(
  db: RuntimeMetricsDb,
  filter: RuntimeMetricsFilter,
  dimension: RuntimeMetricsDimension,
  limit = 100,
): Promise<Array<RuntimeMetricsMeasures & { key: string | null }>> {
  const column = DIMENSION_COLUMNS[dimension];
  return await db.select({ key: column, ...measures })
    .from(h)
    .where(filterBy(h, filter))
    .groupBy(column)
    .orderBy(desc(sql`sum(${h.turns})`), asc(column))
    .limit(limit) as Array<RuntimeMetricsMeasures & { key: string | null }>;
}

export async function queryRuntimeToolUsage(
  db: RuntimeMetricsDb,
  filter: RuntimeMetricsFilter,
  limit = 20,
): Promise<RuntimeToolUsage[]> {
  const th = runtimeMetricToolHourly;
  return await db.select({
    toolId: th.toolId,
    calls: sql<number>`sum(${th.calls})::float8`,
    errors: sql<number>`sum(${th.errors})::float8`,
  }).from(th)
    .where(filterBy(th, filter))
    .groupBy(th.toolId)
    .orderBy(desc(sql`sum(${th.calls})`), asc(th.toolId))
    .limit(limit);
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/packages/db/src/index.ts b/packages/db/src/index.ts
index 33f6862..f902a6c 100644
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
@@ -11,3 +11,23 @@ export {
   WORKSPACE_NAME_MIN_LENGTH,
   WORKSPACE_NAME_MAX_LENGTH,
 } from './lib/workspace-name';
+export {
+  RUNTIME_METRIC_AGGREGATION_LOOKBACK_HOURS,
+  RUNTIME_METRIC_MAX_EVENT_AGE_HOURS,
+  RUNTIME_METRIC_RAW_RETENTION_DAYS,
+  aggregateRuntimeMetrics,
+  hourBucket,
+  insertRuntimeMetricEvents,
+  pruneRuntimeMetrics,
+  queryRuntimeMetricBreakdown,
+  queryRuntimeMetricSeries,
+  queryRuntimeMetricTotals,
+  queryRuntimeToolUsage,
+  type RuntimeMetricEventInput,
+  type RuntimeMetricsDb,
+  type RuntimeMetricsDimension,
+  type RuntimeMetricsFilter,
+  type RuntimeMetricsMeasures,
+  type RuntimeMetricsRetention,
+  type RuntimeToolUsage,
+} from './lib/runtime-metrics';
PATCH
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test src/__tests__/runtime-metrics.test.ts 2>&1 | tail -4
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test 2>&1 | tail -4
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && ./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
```

Expected: `13 pass`, `0 fail`; the whole DB suite **D_tests + 17** pass across **D_files + 2** files, `0 fail`; `db-build=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/src/lib/runtime-metrics.ts packages/db/src/__tests__/runtime-metrics.test.ts packages/db/src/index.ts
git commit -m "feat(db): aggregate, prune and query runtime metrics"
```

### Task 9: API – accept the SDK runtime metric event with vector parity

**Files:**
- Copy: `apps/api/src/modules/runtime-metrics/__vectors__/runtime-metric-event.v2.json` (from the SDK object store)
- Create: `apps/api/src/modules/runtime-metrics/__tests__/runtime-metric-event-vectors.spec.ts`
- Create: `apps/api/src/modules/runtime-metrics/runtime-metric-event.schema.ts`

**Interfaces:**
- Consumes: SDK Task 1 vectors (`codex/mvp-chat:src/contracts/__vectors__/runtime-metric-event.v2.json`, sha256 `73c5cf4f…ab17d`).
- Produces: `RUNTIME_METRIC_MAX_BATCH = 50`, `RUNTIME_METRIC_MAX_TOOLS = 32`, `RUNTIME_TURN_STATUSES`, `RUNTIME_TURN_ERROR_CODES`, `RuntimeMetricEventSchema` → `RuntimeMetricEvent`, `RuntimeMetricBatchSchema` → `RuntimeMetricBatch` (`zod/v4`, strict, the SDK rules with error codes as messages).

- [ ] **Step 1: Copy the vectors and write the failing test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
mkdir -p apps/api/src/modules/runtime-metrics/__vectors__ apps/api/src/modules/runtime-metrics/__tests__
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat show codex/mvp-chat:src/contracts/__vectors__/runtime-metric-event.v2.json > apps/api/src/modules/runtime-metrics/__vectors__/runtime-metric-event.v2.json
shasum -a 256 apps/api/src/modules/runtime-metrics/__vectors__/runtime-metric-event.v2.json
```

Expected: `73c5cf4f8d95e8968e11dd6cf921e8b88d387b7d75f056aa91e4bc2b614ab17d  apps/api/src/modules/runtime-metrics/__vectors__/runtime-metric-event.v2.json`.

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/__tests__/runtime-metric-event-vectors.spec.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_METRIC_MAX_BATCH,
  RuntimeMetricBatchSchema,
  RuntimeMetricEventSchema,
} from '../runtime-metric-event.schema';

/**
 * Copied byte for byte from the SDK (`glirastes`, branch `codex/mvp-chat`,
 * `src/contracts/__vectors__/runtime-metric-event.v2.json`). Both sides must
 * accept and refuse exactly the same events; a changed file needs the SDK's
 * new copy and a new pinned digest, never a local edit.
 */
const VECTORS_SHA256 = '73c5cf4f8d95e8968e11dd6cf921e8b88d387b7d75f056aa91e4bc2b614ab17d';
const raw = readFileSync(
  new URL('../__vectors__/runtime-metric-event.v2.json', import.meta.url),
);
const vectors = JSON.parse(raw.toString('utf8')) as {
  base: Record<string, unknown>;
  valid: Array<{ name: string; patch: Record<string, unknown> }>;
  invalid: Array<{ name: string; patch: Record<string, unknown> }>;
};
const eventOf = (patch: Record<string, unknown>) => ({ ...vectors.base, ...patch });

describe('runtime metric event v2 parity with the SDK', () => {
  it('uses the pinned SDK vectors', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
  });

  it.each(vectors.valid.map((vector) => [vector.name, vector.patch] as const))(
    'accepts %s',
    (_name, patch) => {
      expect(RuntimeMetricEventSchema.safeParse(eventOf(patch)).success).toBe(true);
    },
  );

  it.each(vectors.invalid.map((vector) => [vector.name, vector.patch] as const))(
    'rejects %s',
    (_name, patch) => {
      expect(RuntimeMetricEventSchema.safeParse(eventOf(patch)).success).toBe(false);
    },
  );

  it('accepts batches of 1 to 50 events and nothing else in the envelope', () => {
    const events = Array.from({ length: RUNTIME_METRIC_MAX_BATCH }, () => vectors.base);
    expect(RuntimeMetricBatchSchema.safeParse({ schemaVersion: 2, events }).success).toBe(true);
    expect(RuntimeMetricBatchSchema.safeParse({ schemaVersion: 2, events: [] }).success).toBe(false);
    expect(RuntimeMetricBatchSchema.safeParse({
      schemaVersion: 2,
      events: [...events, vectors.base],
    }).success).toBe(false);
    expect(RuntimeMetricBatchSchema.safeParse({
      schemaVersion: 2,
      events: [vectors.base],
      tenantId: '019fb900-0000-7000-8000-0000000000f1',
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run src/modules/runtime-metrics/__tests__/runtime-metric-event-vectors.spec.ts 2>&1 | grep -E "Error:|Test Files" | head -2
```

Expected: `Error: Cannot find module '../runtime-metric-event.schema' imported from …/runtime-metric-event-vectors.spec.ts`, `Test Files  1 failed (1)`.

- [ ] **Step 3: Implement the port**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metric-event.schema.ts`:

```ts
import { z } from 'zod/v4';

/**
 * Platform copy of the SDK's `TechnicalRuntimeEvent` v2 (`glirastes`,
 * `src/contracts/events.ts`). `zod/v4` keeps uuid and datetime rules equal to
 * the SDK's Zod 4; the shared golden vectors prove both sides agree.
 */
export const RUNTIME_METRIC_MAX_BATCH = 50;
export const RUNTIME_METRIC_MAX_TOOLS = 32;
const RUNTIME_METRIC_MAX_COUNT = 2_147_483_647;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PRICING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SENSITIVE_STRING_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/,
];

const label = z.string().regex(LABEL_PATTERN);
const metricCount = z.number().int().nonnegative().max(RUNTIME_METRIC_MAX_COUNT);
const callCount = z.number().int().nonnegative().max(10_000);
const durationMs = z.number().int().nonnegative().max(86_400_000);

export const RUNTIME_TURN_STATUSES = ['completed', 'safety-stop', 'aborted', 'error'] as const;
export const RUNTIME_TURN_ERROR_CODES = [
  'model_error',
  'pipeline_error',
  'budget_exhausted',
  'step_limit',
] as const;
const ERROR_CODES_BY_STATUS: Partial<Record<
  typeof RUNTIME_TURN_STATUSES[number],
  ReadonlyArray<typeof RUNTIME_TURN_ERROR_CODES[number]>
>> = {
  error: ['model_error', 'pipeline_error'],
  'safety-stop': ['budget_exhausted', 'step_limit'],
};

function sensitiveStringPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
  if (typeof value === 'string') {
    return SENSITIVE_STRING_PATTERNS.some((pattern) => pattern.test(value)) ? path : null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const match = sensitiveStringPath(child, [...path, key]);
    if (match) return match;
  }
  return null;
}

const CostSchema = z.object({
  usd: z.number().finite().nonnegative().max(1_000_000).nullable(),
  source: z.enum(['provider-reported', 'price-table']).nullable(),
  pricingVersion: z.string().regex(PRICING_VERSION_PATTERN).nullable(),
}).strict().superRefine((cost, context) => {
  if ((cost.usd === null) !== (cost.source === null)) {
    context.addIssue({ code: 'custom', message: 'cost_source_mismatch', path: ['source'] });
  }
  if ((cost.source === 'price-table') !== (cost.pricingVersion !== null)) {
    context.addIssue({ code: 'custom', message: 'pricing_version_mismatch', path: ['pricingVersion'] });
  }
});

const ToolUsageSchema = z.object({
  toolId: z.uuid(),
  calls: callCount.min(1),
  errors: callCount,
}).strict().refine((usage) => usage.errors <= usage.calls, {
  message: 'tool_errors_exceed_calls',
  path: ['errors'],
});

export const RuntimeMetricEventSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: z.uuid(),
  eventType: z.literal('turn.finished'),
  occurredAt: z.iso.datetime({ offset: true }),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: label.nullable(),
  instanceId: label,
  revisionId: z.uuid().nullable(),
  model: label.nullable(),
  status: z.enum(RUNTIME_TURN_STATUSES),
  errorCode: z.enum(RUNTIME_TURN_ERROR_CODES).nullable(),
  inputTokens: metricCount,
  outputTokens: metricCount,
  cost: CostSchema,
  latency: z.object({
    firstTokenMs: durationMs.nullable(),
    totalMs: durationMs,
  }).strict(),
  toolCallCount: callCount,
  toolErrorCount: callCount,
  tools: z.array(ToolUsageSchema).max(RUNTIME_METRIC_MAX_TOOLS),
}).strict().superRefine((event, context) => {
  const allowed = ERROR_CODES_BY_STATUS[event.status];
  if (allowed ? !event.errorCode || !allowed.includes(event.errorCode) : event.errorCode !== null) {
    context.addIssue({ code: 'custom', message: 'error_code_mismatch', path: ['errorCode'] });
  }
  if (event.latency.firstTokenMs !== null && event.latency.firstTokenMs > event.latency.totalMs) {
    context.addIssue({ code: 'custom', message: 'first_token_after_end', path: ['latency', 'firstTokenMs'] });
  }
  if (event.toolErrorCount > event.toolCallCount) {
    context.addIssue({ code: 'custom', message: 'tool_errors_exceed_calls', path: ['toolErrorCount'] });
  }
  const toolIds = event.tools.map((tool) => tool.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate_tool', path: ['tools'] });
  }
  const listedCalls = event.tools.reduce((sum, tool) => sum + tool.calls, 0);
  const listedErrors = event.tools.reduce((sum, tool) => sum + tool.errors, 0);
  if (listedCalls > event.toolCallCount || listedErrors > event.toolErrorCount) {
    context.addIssue({ code: 'custom', message: 'tools_exceed_totals', path: ['tools'] });
  }
  const sensitive = sensitiveStringPath(event);
  if (sensitive) {
    context.addIssue({ code: 'custom', message: 'sensitive_content', path: sensitive });
  }
});

export const RuntimeMetricBatchSchema = z.object({
  schemaVersion: z.literal(2),
  events: z.array(RuntimeMetricEventSchema).min(1).max(RUNTIME_METRIC_MAX_BATCH),
}).strict();

export type RuntimeMetricEvent = z.infer<typeof RuntimeMetricEventSchema>;
export type RuntimeMetricBatch = z.infer<typeof RuntimeMetricBatchSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run src/modules/runtime-metrics/__tests__/runtime-metric-event-vectors.spec.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  43 passed (43)` (digest, 10 valid, 31 invalid, batch envelope), `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-metrics/runtime-metric-event.schema.ts apps/api/src/modules/runtime-metrics/__vectors__/runtime-metric-event.v2.json apps/api/src/modules/runtime-metrics/__tests__/runtime-metric-event-vectors.spec.ts
git commit -m "feat(runtime-metrics): accept sdk metric events with vector parity"
```

### Task 10: API – ingest turn events and answer metrics queries

**Files:**
- Create: `apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.service.spec.ts`
- Create: `apps/api/src/modules/runtime-metrics/runtime-metrics.retention.ts`, `runtime-metrics.store.ts`, `drizzle-runtime-metrics.store.ts`, `runtime-metrics.service.ts`

**Interfaces:**
- Consumes: Task 8 helpers and types from `@glirastes/db`, `runtimeEnvironments`; Task 9 `RuntimeMetricBatchSchema`; `assertControlPlaneSafe` (`runtime-revisions/runtime-publication-policy.ts:149`, `ForbiddenException` on forbidden keys); `TenantContext['plan']`.
- Produces:
  - `RUNTIME_METRICS_RETENTION` (DI token), `DEFAULT_RUNTIME_METRICS_RETENTION = { freeDays: 30, proDays: 365 }`, `resolveRuntimeMetricsRetention(env): RuntimeMetricsRetention` (reads `RUNTIME_METRICS_RETENTION_FREE_DAYS`/`_PRO_DAYS`, 1–3,650 whole days, Pro ≥ Free, throws otherwise), `retentionDaysFor(plan, retention): number`
  - `RUNTIME_METRICS_STORE` (DI token), `interface RuntimeMetricsScope { tenantId; targetAppId; environmentId }`, `interface RuntimeMetricsStore { environmentExists; insertEvents; aggregate; prune; totals; series; breakdown; toolUsage }`, `DrizzleRuntimeMetricsStore`
  - `RuntimeMetricsService.ingest(scope, credential: { tenantId; targetAppId? }, body, now?): Promise<{ accepted; duplicates; rejected }>`; `.overview(tenant: { id; plan }, appId, rawQuery, now?): Promise<RuntimeMetricsOverview>`; `.compare(tenant, appId, rawQuery, now?): Promise<RuntimeMetricsComparison>`; `.aggregate(now?)`; `.prune(now?)`; `foldIntoDays(series)`
  - Error bodies: 400 `{ code: 'runtime_metrics_invalid', paths }`, `{ code: 'runtime_metrics_scope_mismatch' }`, `{ code: 'runtime_metrics_identifier_invalid', paths }`, `{ code: 'runtime_metrics_query_invalid', paths }`, `{ code: 'runtime_metrics_range_invalid' }`, `{ code: 'runtime_metrics_range_outside_retention' }`; 403 for a key that is not bound to the path app; 404 `Runtime environment not found`.
  - View: `RuntimeMetricsView { turns; errorTurns; safetyStopTurns; abortedTurns; tokens { input; output }; cost { knownUsd; providerReportedUsd; priceTableUsd; unknownCostTurns; complete }; latency { avgTotalMs; p95TotalMs; avgFirstTokenMs }; toolCalls; toolErrors }` (USD rounded to 6 decimals).

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.service.spec.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeMetricEventInput,
  RuntimeMetricsFilter,
  RuntimeMetricsMeasures,
} from '@glirastes/db';
import {
  DEFAULT_RUNTIME_METRICS_RETENTION,
  resolveRuntimeMetricsRetention,
  retentionDaysFor,
} from '../runtime-metrics.retention';
import { foldIntoDays, RuntimeMetricsService } from '../runtime-metrics.service';
import type { RuntimeMetricsStore } from '../runtime-metrics.store';

const vectors = JSON.parse(readFileSync(
  new URL('../__vectors__/runtime-metric-event.v2.json', import.meta.url),
  'utf8',
)) as { base: Record<string, unknown> };
const TENANT_ID = '019fb930-0000-7000-8000-000000000001';
const APP_ID = vectors.base.appId as string;
const ENVIRONMENT_ID = vectors.base.environmentId as string;
const NOW = new Date('2026-10-05T10:20:00.000Z');
const scope = { tenantId: TENANT_ID, targetAppId: APP_ID, environmentId: ENVIRONMENT_ID };
const runtimeKey = { tenantId: TENANT_ID, targetAppId: APP_ID };

function measures(patch: Partial<RuntimeMetricsMeasures> = {}): RuntimeMetricsMeasures {
  return {
    turns: 0, errorTurns: 0, safetyStopTurns: 0, abortedTurns: 0, inputTokens: 0,
    outputTokens: 0, providerCostUsd: 0, priceTableCostUsd: 0, unknownCostTurns: 0,
    totalMsSum: 0, maxP95TotalMs: null, firstTokenTurns: 0, firstTokenMsSum: 0,
    toolCalls: 0, toolErrors: 0, ...patch,
  };
}

function fakeStore(patch: Partial<RuntimeMetricsStore> = {}) {
  const inserted: RuntimeMetricEventInput[] = [];
  const filters: RuntimeMetricsFilter[] = [];
  const store: RuntimeMetricsStore = {
    environmentExists: vi.fn(async () => true),
    insertEvents: vi.fn(async (events) => {
      inserted.push(...events);
      return { inserted: events.length, duplicates: 0 };
    }),
    aggregate: vi.fn(async () => ({ groups: 0, toolGroups: 0 })),
    prune: vi.fn(async () => undefined),
    totals: vi.fn(async (filter) => {
      filters.push(filter);
      return measures();
    }),
    series: vi.fn(async () => []),
    breakdown: vi.fn(async () => []),
    toolUsage: vi.fn(async () => []),
    ...patch,
  };
  return { store, inserted, filters };
}

const service = (store: RuntimeMetricsStore) =>
  new RuntimeMetricsService(store, DEFAULT_RUNTIME_METRICS_RETENTION);
const event = (patch: Record<string, unknown> = {}) => ({
  ...vectors.base,
  occurredAt: '2026-10-05T10:15:30.000Z',
  ...patch,
});
const batch = (...events: unknown[]) => ({ schemaVersion: 2, events });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('RuntimeMetricsService ingest', () => {
  it('stores the turns of the key app environment without anything but their numbers', async () => {
    const { store, inserted } = fakeStore();

    await expect(service(store).ingest(scope, runtimeKey, batch(event()), NOW))
      .resolves.toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(inserted).toEqual([{
      tenantId: TENANT_ID,
      eventId: vectors.base.eventId,
      targetAppId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      occurredAt: new Date('2026-10-05T10:15:30.000Z'),
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: vectors.base.revisionId,
      model: 'anthropic/claude-sonnet-5.5',
      status: 'completed',
      errorCode: null,
      inputTokens: 1200,
      outputTokens: 240,
      costUsd: 0.0048,
      costSource: 'provider-reported',
      pricingVersion: null,
      firstTokenMs: 420,
      totalMs: 1830,
      toolCallCount: 3,
      toolErrorCount: 1,
      tools: (vectors.base as { tools: unknown }).tools,
    }]);
    expect(store.insertEvents).toHaveBeenCalledWith(expect.any(Array), NOW);
  });

  it.each([
    ['a key bound to another app', { tenantId: TENANT_ID, targetAppId: '019fb930-0000-7000-8000-000000000009' }],
    ['a tenant-wide key', { tenantId: TENANT_ID }],
    ['a key of another tenant', { tenantId: '019fb930-0000-7000-8000-000000000008', targetAppId: APP_ID }],
  ])('refuses %s', async (_label, credential) => {
    const { store } = fakeStore();

    expect(await rejection(service(store).ingest(scope, credential, batch(event()), NOW)))
      .toBeInstanceOf(ForbiddenException);
    expect(store.insertEvents).not.toHaveBeenCalled();
  });

  it('refuses raw content before reading the batch', async () => {
    const { store } = fakeStore();

    expect(await rejection(service(store).ingest(
      scope,
      runtimeKey,
      batch({ ...event(), prompt: 'Zeige meine Aufgaben' }),
      NOW,
    ))).toBeInstanceOf(ForbiddenException);
    expect(store.insertEvents).not.toHaveBeenCalled();
  });

  it('names invalid fields without echoing their values', async () => {
    const { store } = fakeStore();
    const error = await rejection(service(store).ingest(
      scope,
      runtimeKey,
      batch(event({ model: 'show me all my tasks' })),
      NOW,
    ));

    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    expect(response).toEqual({ code: 'runtime_metrics_invalid', paths: ['events.0.model'] });
    expect(JSON.stringify(response)).not.toContain('show me');
  });

  it('refuses events reported for another app or environment', async () => {
    const { store } = fakeStore();

    const error = await rejection(service(store).ingest(
      scope,
      runtimeKey,
      batch(event({ environmentId: '019fb930-0000-7000-8000-0000000000e9' })),
      NOW,
    ));
    expect((error as BadRequestException).getResponse())
      .toEqual({ code: 'runtime_metrics_scope_mismatch' });
  });

  it('answers 404 for an environment the app does not have', async () => {
    const { store } = fakeStore({ environmentExists: vi.fn(async () => false) });

    expect(await rejection(service(store).ingest(scope, runtimeKey, batch(event()), NOW)))
      .toBeInstanceOf(NotFoundException);
  });

  it('rejects malformed path identifiers', async () => {
    const { store } = fakeStore();

    const error = await rejection(service(store).ingest(
      { ...scope, environmentId: 'production' },
      runtimeKey,
      batch(event()),
      NOW,
    ));
    expect((error as BadRequestException).getResponse())
      .toEqual({ code: 'runtime_metrics_identifier_invalid', paths: ['environmentId'] });
  });

  it('counts events older than a day or from the future as rejected', async () => {
    const { store, inserted } = fakeStore({
      insertEvents: vi.fn(async (events) => {
        inserted.push(...events);
        return { inserted: events.length - 1, duplicates: 1 };
      }),
    });

    await expect(service(store).ingest(scope, runtimeKey, batch(
      event({ eventId: '019fb930-0000-7000-8000-000000000101', occurredAt: '2026-10-04T10:19:59.000Z' }),
      event({ eventId: '019fb930-0000-7000-8000-000000000102', occurredAt: '2026-10-04T10:20:00.000Z' }),
      event({ eventId: '019fb930-0000-7000-8000-000000000103', occurredAt: '2026-10-05T10:25:00.000Z' }),
      event({ eventId: '019fb930-0000-7000-8000-000000000104', occurredAt: '2026-10-05T10:25:01.000Z' }),
    ), NOW)).resolves.toEqual({ accepted: 1, duplicates: 1, rejected: 2 });
    expect(inserted.map((row) => row.eventId)).toEqual([
      '019fb930-0000-7000-8000-000000000102',
      '019fb930-0000-7000-8000-000000000103',
    ]);
  });
});

describe('RuntimeMetricsService queries', () => {
  const free = { id: TENANT_ID, plan: 'free' as const };
  const pro = { id: TENANT_ID, plan: 'pro' as const };

  it('shows the last seven days by day with cost provenance and latency', async () => {
    const { store, filters } = fakeStore({
      totals: vi.fn(async (filter: RuntimeMetricsFilter) => {
        filters.push(filter);
        return measures({
          turns: 4, errorTurns: 1, inputTokens: 900, outputTokens: 120,
          providerCostUsd: 0.0123456789, priceTableCostUsd: 0.002, unknownCostTurns: 1,
          totalMsSum: 5_000, maxP95TotalMs: 2_400.4, firstTokenTurns: 3, firstTokenMsSum: 1_000,
          toolCalls: 6, toolErrors: 1,
        });
      }),
      series: vi.fn(async () => [
        { ...measures({ turns: 1, totalMsSum: 1_000, maxP95TotalMs: 1_000 }), bucket: new Date('2026-10-04T09:00:00.000Z') },
        { ...measures({ turns: 2, totalMsSum: 3_000, maxP95TotalMs: 2_000 }), bucket: new Date('2026-10-04T15:00:00.000Z') },
        { ...measures({ turns: 1, totalMsSum: 1_000, maxP95TotalMs: 900 }), bucket: new Date('2026-10-05T08:00:00.000Z') },
      ]),
      toolUsage: vi.fn(async () => [{ toolId: '019fb900-0000-7000-8000-0000000000c1', calls: 6, errors: 1 }]),
    });

    const overview = await service(store).overview(free, APP_ID, {}, NOW);

    expect(filters).toEqual([{
      tenantId: TENANT_ID,
      targetAppId: APP_ID,
      from: new Date('2026-09-28T11:00:00.000Z'),
      to: new Date('2026-10-05T11:00:00.000Z'),
    }]);
    expect(overview.range).toEqual({
      from: '2026-09-28T11:00:00.000Z',
      to: '2026-10-05T11:00:00.000Z',
      granularity: 'day',
    });
    expect(overview.retention).toEqual({ days: 30, availableFrom: '2026-09-05T10:00:00.000Z' });
    expect(overview.totals).toEqual({
      turns: 4,
      errorTurns: 1,
      safetyStopTurns: 0,
      abortedTurns: 0,
      tokens: { input: 900, output: 120 },
      cost: {
        knownUsd: 0.014346,
        providerReportedUsd: 0.012346,
        priceTableUsd: 0.002,
        unknownCostTurns: 1,
        complete: false,
      },
      latency: { avgTotalMs: 1_250, p95TotalMs: 2_400, avgFirstTokenMs: 333 },
      toolCalls: 6,
      toolErrors: 1,
    });
    expect(overview.series.map((point) => [point.bucket, point.turns, point.latency]))
      .toEqual([
        ['2026-10-04T00:00:00.000Z', 3, { avgTotalMs: 1_333, p95TotalMs: 2_000, avgFirstTokenMs: null }],
        ['2026-10-05T00:00:00.000Z', 1, { avgTotalMs: 1_000, p95TotalMs: 900, avgFirstTokenMs: null }],
      ]);
    expect(overview.tools).toEqual([{ toolId: '019fb900-0000-7000-8000-0000000000c1', calls: 6, errors: 1 }]);
  });

  it('keeps hourly points for short ranges and passes every filter', async () => {
    const { store, filters } = fakeStore();

    const overview = await service(store).overview(free, APP_ID, {
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: vectors.base.revisionId,
      model: 'anthropic/claude-sonnet-5.5',
      from: '2026-10-04T12:30:00.000Z',
      to: '2026-10-05T09:10:00.000Z',
    }, NOW);

    expect(overview.range.granularity).toBe('hour');
    expect(filters[0]).toEqual({
      tenantId: TENANT_ID,
      targetAppId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: vectors.base.revisionId,
      model: 'anthropic/claude-sonnet-5.5',
      from: new Date('2026-10-04T12:00:00.000Z'),
      to: new Date('2026-10-05T10:00:00.000Z'),
    });
  });

  it('limits Free history to 30 days and Pro history to 365 days', async () => {
    const { store, filters } = fakeStore();
    const query = { from: '2025-01-01T00:00:00.000Z' };

    await service(store).overview(free, APP_ID, query, NOW);
    await service(store).overview(pro, APP_ID, query, NOW);

    expect(filters.map((filter) => filter.from.toISOString())).toEqual([
      '2026-09-05T10:00:00.000Z',
      '2025-10-05T10:00:00.000Z',
    ]);
  });

  it.each([
    ['an unknown query key', { tenantId: TENANT_ID }, 'runtime_metrics_query_invalid'],
    ['free text as a model', { model: 'my model' }, 'runtime_metrics_query_invalid'],
    ['a reversed range', { from: '2026-10-05T08:00:00.000Z', to: '2026-10-05T06:00:00.000Z' }, 'runtime_metrics_range_invalid'],
    ['a range before the retention', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }, 'runtime_metrics_range_outside_retention'],
  ])('refuses %s', async (_label, query, code) => {
    const { store } = fakeStore();

    const error = await rejection(service(store).overview(free, APP_ID, query, NOW));
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code });
  });

  it('compares one dimension at a time', async () => {
    const { store } = fakeStore({
      breakdown: vi.fn(async () => [
        { key: 'anthropic/claude-sonnet-5.5', ...measures({ turns: 3, totalMsSum: 3_000 }) },
        { key: null, ...measures({ turns: 1 }) },
      ]),
    });

    const comparison = await service(store).compare(pro, APP_ID, { by: 'model' }, NOW);

    expect(store.breakdown).toHaveBeenCalledWith(expect.objectContaining({ targetAppId: APP_ID }), 'model');
    expect(comparison.by).toBe('model');
    expect(comparison.rows.map((row) => [row.key, 'turns' in row ? row.turns : null]))
      .toEqual([['anthropic/claude-sonnet-5.5', 3], [null, 1]]);
  });

  it('compares tools by calls and errors', async () => {
    const { store } = fakeStore({
      toolUsage: vi.fn(async () => [{ toolId: '019fb900-0000-7000-8000-0000000000c1', calls: 4, errors: 2 }]),
    });

    const comparison = await service(store).compare(pro, APP_ID, { by: 'tool' }, NOW);

    expect(store.toolUsage).toHaveBeenCalledWith(expect.any(Object), 100);
    expect(comparison.rows).toEqual([{ key: '019fb900-0000-7000-8000-0000000000c1', calls: 4, errors: 2 }]);
  });

  it('requires a comparison dimension', async () => {
    const { store } = fakeStore();

    const error = await rejection(service(store).compare(pro, APP_ID, {}, NOW));
    expect((error as BadRequestException).getResponse())
      .toEqual({ code: 'runtime_metrics_query_invalid', paths: ['by'] });
  });
});

describe('runtime metrics jobs and retention', () => {
  it('aggregates and prunes with the configured retention', async () => {
    const { store } = fakeStore();
    const metrics = new RuntimeMetricsService(store, { freeDays: 14, proDays: 90 });

    await metrics.aggregate(NOW);
    await metrics.prune(NOW);

    expect(store.aggregate).toHaveBeenCalledWith(NOW);
    expect(store.prune).toHaveBeenCalledWith(NOW, { freeDays: 14, proDays: 90 });
  });

  it('defaults to 30 Free days and 365 Pro days', () => {
    expect(resolveRuntimeMetricsRetention({})).toEqual({ freeDays: 30, proDays: 365 });
    expect(resolveRuntimeMetricsRetention({
      RUNTIME_METRICS_RETENTION_FREE_DAYS: ' 7 ',
      RUNTIME_METRICS_RETENTION_PRO_DAYS: '730',
    })).toEqual({ freeDays: 7, proDays: 730 });
    expect(retentionDaysFor('free', { freeDays: 7, proDays: 730 })).toBe(7);
    expect(retentionDaysFor('enterprise', { freeDays: 7, proDays: 730 })).toBe(730);
  });

  it.each([
    [{ RUNTIME_METRICS_RETENTION_FREE_DAYS: '0' }],
    [{ RUNTIME_METRICS_RETENTION_FREE_DAYS: '30d' }],
    [{ RUNTIME_METRICS_RETENTION_PRO_DAYS: '4000' }],
    [{ RUNTIME_METRICS_RETENTION_FREE_DAYS: '60', RUNTIME_METRICS_RETENTION_PRO_DAYS: '30' }],
  ])('fails fast on %j', (env) => {
    expect(() => resolveRuntimeMetricsRetention(env)).toThrow(/RUNTIME_METRICS_RETENTION/);
  });

  it('folds hours into UTC days', () => {
    expect(foldIntoDays([
      { ...measures({ turns: 1, maxP95TotalMs: null }), bucket: new Date('2026-10-04T23:00:00.000Z') },
      { ...measures({ turns: 2, maxP95TotalMs: 700 }), bucket: new Date('2026-10-04T01:00:00.000Z') },
    ])).toEqual([
      { ...measures({ turns: 3, maxP95TotalMs: 700 }), bucket: new Date('2026-10-04T00:00:00.000Z') },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run src/modules/runtime-metrics/__tests__/runtime-metrics.service.spec.ts 2>&1 | grep -E "Error:|Test Files" | head -2
```

Expected: `Error: Cannot find module '../runtime-metrics.retention' imported from …/runtime-metrics.service.spec.ts`, `Test Files  1 failed (1)`.

- [ ] **Step 3: Implement retention, store and service**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics.retention.ts`:

```ts
import type { RuntimeMetricsRetention } from '@glirastes/db';
import type { TenantContext } from '../../common/types';

export const RUNTIME_METRICS_RETENTION = Symbol('RUNTIME_METRICS_RETENTION');

/**
 * Retention is an open product decision (spec 7); until it is taken it is
 * configurable per deployment with these defaults.
 */
export const DEFAULT_RUNTIME_METRICS_RETENTION: RuntimeMetricsRetention = {
  freeDays: 30,
  proDays: 365,
};

function days(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 3_650) {
    throw new Error(`${name} must be a whole number of days between 1 and 3650`);
  }
  return value;
}

/** Reads `RUNTIME_METRICS_RETENTION_FREE_DAYS` and `..._PRO_DAYS`; fails fast on nonsense. */
export function resolveRuntimeMetricsRetention(
  env: Record<string, string | undefined>,
): RuntimeMetricsRetention {
  const freeDays = days(
    env,
    'RUNTIME_METRICS_RETENTION_FREE_DAYS',
    DEFAULT_RUNTIME_METRICS_RETENTION.freeDays,
  );
  const proDays = days(
    env,
    'RUNTIME_METRICS_RETENTION_PRO_DAYS',
    DEFAULT_RUNTIME_METRICS_RETENTION.proDays,
  );
  if (proDays < freeDays) {
    throw new Error(
      'RUNTIME_METRICS_RETENTION_PRO_DAYS must not be shorter than RUNTIME_METRICS_RETENTION_FREE_DAYS',
    );
  }
  return { freeDays, proDays };
}

export function retentionDaysFor(
  plan: TenantContext['plan'],
  retention: RuntimeMetricsRetention,
): number {
  return plan === 'free' ? retention.freeDays : retention.proDays;
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics.store.ts`:

```ts
import type {
  RuntimeMetricEventInput,
  RuntimeMetricsDimension,
  RuntimeMetricsFilter,
  RuntimeMetricsMeasures,
  RuntimeMetricsRetention,
  RuntimeToolUsage,
} from '@glirastes/db';

export const RUNTIME_METRICS_STORE = Symbol('RUNTIME_METRICS_STORE');

export interface RuntimeMetricsScope {
  tenantId: string;
  targetAppId: string;
  environmentId: string;
}

export interface RuntimeMetricsStore {
  environmentExists(scope: RuntimeMetricsScope): Promise<boolean>;
  insertEvents(
    events: ReadonlyArray<RuntimeMetricEventInput>,
    receivedAt: Date,
  ): Promise<{ inserted: number; duplicates: number }>;
  aggregate(now: Date): Promise<{ groups: number; toolGroups: number }>;
  prune(now: Date, retention: RuntimeMetricsRetention): Promise<void>;
  totals(filter: RuntimeMetricsFilter): Promise<RuntimeMetricsMeasures>;
  series(filter: RuntimeMetricsFilter): Promise<Array<RuntimeMetricsMeasures & { bucket: Date }>>;
  breakdown(
    filter: RuntimeMetricsFilter,
    dimension: RuntimeMetricsDimension,
  ): Promise<Array<RuntimeMetricsMeasures & { key: string | null }>>;
  toolUsage(filter: RuntimeMetricsFilter, limit: number): Promise<RuntimeToolUsage[]>;
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/drizzle-runtime-metrics.store.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  aggregateRuntimeMetrics,
  insertRuntimeMetricEvents,
  pruneRuntimeMetrics,
  queryRuntimeMetricBreakdown,
  queryRuntimeMetricSeries,
  queryRuntimeMetricTotals,
  queryRuntimeToolUsage,
  runtimeEnvironments,
  type Database,
  type RuntimeMetricEventInput,
  type RuntimeMetricsDimension,
  type RuntimeMetricsFilter,
  type RuntimeMetricsRetention,
} from '@glirastes/db';
import type {
  RuntimeMetricsScope,
  RuntimeMetricsStore,
} from './runtime-metrics.store';

/** SQL lives in `@glirastes/db` (proved on PGlite); this store only wires it. */
@Injectable()
export class DrizzleRuntimeMetricsStore implements RuntimeMetricsStore {
  constructor(@Inject('DATABASE') private readonly db: Database) {}

  async environmentExists(scope: RuntimeMetricsScope): Promise<boolean> {
    const rows = await this.db.select({ id: runtimeEnvironments.id })
      .from(runtimeEnvironments)
      .where(and(
        eq(runtimeEnvironments.tenantId, scope.tenantId),
        eq(runtimeEnvironments.targetAppId, scope.targetAppId),
        eq(runtimeEnvironments.id, scope.environmentId),
      ))
      .limit(1);
    return rows.length === 1;
  }

  insertEvents(events: ReadonlyArray<RuntimeMetricEventInput>, receivedAt: Date) {
    return insertRuntimeMetricEvents(this.db, events, receivedAt);
  }

  aggregate(now: Date) {
    return aggregateRuntimeMetrics(this.db, { now });
  }

  prune(now: Date, retention: RuntimeMetricsRetention) {
    return pruneRuntimeMetrics(this.db, { now, retention });
  }

  totals(filter: RuntimeMetricsFilter) {
    return queryRuntimeMetricTotals(this.db, filter);
  }

  series(filter: RuntimeMetricsFilter) {
    return queryRuntimeMetricSeries(this.db, filter);
  }

  breakdown(filter: RuntimeMetricsFilter, dimension: RuntimeMetricsDimension) {
    return queryRuntimeMetricBreakdown(this.db, filter, dimension);
  }

  toolUsage(filter: RuntimeMetricsFilter, limit: number) {
    return queryRuntimeToolUsage(this.db, filter, limit);
  }
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics.service.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod/v4';
import {
  hourBucket,
  RUNTIME_METRIC_MAX_EVENT_AGE_HOURS,
  type RuntimeMetricEventInput,
  type RuntimeMetricsFilter,
  type RuntimeMetricsMeasures,
  type RuntimeMetricsRetention,
} from '@glirastes/db';
import type { TenantContext } from '../../common/types';
import { assertControlPlaneSafe } from '../runtime-revisions/runtime-publication-policy';
import {
  RuntimeMetricBatchSchema,
  type RuntimeMetricEvent,
} from './runtime-metric-event.schema';
import {
  RUNTIME_METRICS_RETENTION,
  retentionDaysFor,
} from './runtime-metrics.retention';
import {
  RUNTIME_METRICS_STORE,
  type RuntimeMetricsScope,
  type RuntimeMetricsStore,
} from './runtime-metrics.store';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Clock skew a runner may have before its events count as rejected. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_RANGE_DAYS = 7;
const HOURLY_SERIES_MAX_HOURS = 48;
const TOP_TOOLS = 20;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const IdentifierSchema = z.uuid();
const label = z.string().regex(LABEL_PATTERN);
const MetricsQuerySchema = z.object({
  environmentId: z.uuid().optional(),
  buildId: label.optional(),
  instanceId: label.optional(),
  revisionId: z.uuid().optional(),
  model: label.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  granularity: z.enum(['hour', 'day']).optional(),
}).strict();
const CompareQuerySchema = MetricsQuerySchema.omit({ granularity: true }).extend({
  by: z.enum(['environment', 'build', 'instance', 'revision', 'model', 'tool']),
}).strict();

export interface RuntimeMetricsView {
  turns: number;
  errorTurns: number;
  safetyStopTurns: number;
  abortedTurns: number;
  tokens: { input: number; output: number };
  cost: {
    /** Sum of every known cost (provider-reported plus price-table). */
    knownUsd: number;
    providerReportedUsd: number;
    priceTableUsd: number;
    /** Turns whose cost nobody reported or priced; never counted as 0. */
    unknownCostTurns: number;
    complete: boolean;
  };
  latency: {
    avgTotalMs: number | null;
    /** Highest hourly p95 in the range. */
    p95TotalMs: number | null;
    avgFirstTokenMs: number | null;
  };
  toolCalls: number;
  toolErrors: number;
}

interface MetricsScopeView {
  environmentId: string | null;
  buildId: string | null;
  instanceId: string | null;
  revisionId: string | null;
  model: string | null;
}

export interface RuntimeMetricsOverview {
  appId: string;
  scope: MetricsScopeView;
  range: { from: string; to: string; granularity: 'hour' | 'day' };
  retention: { days: number; availableFrom: string };
  totals: RuntimeMetricsView;
  series: Array<RuntimeMetricsView & { bucket: string }>;
  tools: Array<{ toolId: string; calls: number; errors: number }>;
}

export interface RuntimeMetricsComparison {
  appId: string;
  by: z.infer<typeof CompareQuerySchema>['by'];
  scope: MetricsScopeView;
  range: { from: string; to: string };
  retention: { days: number; availableFrom: string };
  rows: Array<
    | (RuntimeMetricsView & { key: string | null })
    | { key: string; calls: number; errors: number }
  >;
}

type Plan = TenantContext['plan'];

const usd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const average = (sum: number, count: number) => (count > 0 ? Math.round(sum / count) : null);

function view(measures: RuntimeMetricsMeasures): RuntimeMetricsView {
  return {
    turns: measures.turns,
    errorTurns: measures.errorTurns,
    safetyStopTurns: measures.safetyStopTurns,
    abortedTurns: measures.abortedTurns,
    tokens: { input: measures.inputTokens, output: measures.outputTokens },
    cost: {
      knownUsd: usd(measures.providerCostUsd + measures.priceTableCostUsd),
      providerReportedUsd: usd(measures.providerCostUsd),
      priceTableUsd: usd(measures.priceTableCostUsd),
      unknownCostTurns: measures.unknownCostTurns,
      complete: measures.unknownCostTurns === 0,
    },
    latency: {
      avgTotalMs: average(measures.totalMsSum, measures.turns),
      p95TotalMs: measures.maxP95TotalMs === null ? null : Math.round(measures.maxP95TotalMs),
      avgFirstTokenMs: average(measures.firstTokenMsSum, measures.firstTokenTurns),
    },
    toolCalls: measures.toolCalls,
    toolErrors: measures.toolErrors,
  };
}

/** Sums hourly points into UTC days (percentiles: the highest hourly p95). */
export function foldIntoDays(
  series: ReadonlyArray<RuntimeMetricsMeasures & { bucket: Date }>,
): Array<RuntimeMetricsMeasures & { bucket: Date }> {
  const days = new Map<number, RuntimeMetricsMeasures & { bucket: Date }>();
  for (const point of series) {
    const day = Math.floor(point.bucket.getTime() / DAY_MS) * DAY_MS;
    const current = days.get(day);
    if (!current) {
      days.set(day, { ...point, bucket: new Date(day) });
      continue;
    }
    for (const key of [
      'turns', 'errorTurns', 'safetyStopTurns', 'abortedTurns', 'inputTokens',
      'outputTokens', 'providerCostUsd', 'priceTableCostUsd', 'unknownCostTurns',
      'totalMsSum', 'firstTokenTurns', 'firstTokenMsSum', 'toolCalls', 'toolErrors',
    ] as const) {
      current[key] += point[key];
    }
    current.maxP95TotalMs = current.maxP95TotalMs === null
      ? point.maxP95TotalMs
      : point.maxP95TotalMs === null
        ? current.maxP95TotalMs
        : Math.max(current.maxP95TotalMs, point.maxP95TotalMs);
  }
  return [...days.values()].sort((left, right) => left.bucket.getTime() - right.bucket.getTime());
}

@Injectable()
export class RuntimeMetricsService {
  constructor(
    @Inject(RUNTIME_METRICS_STORE) private readonly store: RuntimeMetricsStore,
    @Inject(RUNTIME_METRICS_RETENTION) private readonly retention: RuntimeMetricsRetention,
  ) {}

  /**
   * Stores a batch of content-free turn events from the runner of one app
   * environment. Only an app-bound runtime key of that app may report; events
   * older than 24 h or more than 5 min ahead are counted as rejected.
   */
  async ingest(
    scope: RuntimeMetricsScope,
    credential: { tenantId: string; targetAppId?: string },
    body: unknown,
    now = new Date(),
  ): Promise<{ accepted: number; duplicates: number; rejected: number }> {
    this.identifier(scope.targetAppId, 'appId');
    this.identifier(scope.environmentId, 'environmentId');
    if (
      credential.tenantId !== scope.tenantId
      || !credential.targetAppId
      || credential.targetAppId !== scope.targetAppId
    ) {
      throw new ForbiddenException('Runtime metrics need a runtime key bound to this app');
    }
    assertControlPlaneSafe(body);
    const parsed = RuntimeMetricBatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'runtime_metrics_invalid',
        paths: [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.')))]
          .slice(0, 20),
      });
    }
    const events = parsed.data.events;
    if (events.some((event) => event.appId !== scope.targetAppId
      || event.environmentId !== scope.environmentId)) {
      throw new BadRequestException({ code: 'runtime_metrics_scope_mismatch' });
    }
    if (!await this.store.environmentExists(scope)) {
      throw new NotFoundException('Runtime environment not found');
    }
    const oldest = now.getTime() - RUNTIME_METRIC_MAX_EVENT_AGE_HOURS * HOUR_MS;
    const newest = now.getTime() + FUTURE_TOLERANCE_MS;
    const fresh = events.filter((event) => {
      const occurredAt = Date.parse(event.occurredAt);
      return occurredAt >= oldest && occurredAt <= newest;
    });
    const { inserted, duplicates } = fresh.length > 0
      ? await this.store.insertEvents(fresh.map((event) => this.row(scope, event)), now)
      : { inserted: 0, duplicates: 0 };
    return { accepted: inserted, duplicates, rejected: events.length - fresh.length };
  }

  /** Free dashboard: totals, a time series and the most used tools. */
  async overview(
    tenant: { id: string; plan: Plan },
    appId: string,
    rawQuery: unknown,
    now = new Date(),
  ): Promise<RuntimeMetricsOverview> {
    this.identifier(appId, 'appId');
    const query = this.parse(MetricsQuerySchema, rawQuery);
    const range = this.range(tenant.plan, query, now);
    const filter = this.filter(tenant.id, appId, query, range);
    const granularity = query.granularity
      ?? (range.to.getTime() - range.from.getTime() <= HOURLY_SERIES_MAX_HOURS * HOUR_MS
        ? 'hour'
        : 'day');
    const [totals, hourly, tools] = await Promise.all([
      this.store.totals(filter),
      this.store.series(filter),
      this.store.toolUsage(filter, TOP_TOOLS),
    ]);
    const series = granularity === 'day' ? foldIntoDays(hourly) : hourly;
    return {
      appId,
      scope: this.scopeView(query),
      range: { from: range.from.toISOString(), to: range.to.toISOString(), granularity },
      retention: range.retention,
      totals: view(totals),
      series: series.map((point) => ({ bucket: point.bucket.toISOString(), ...view(point) })),
      tools,
    };
  }

  /** Pro comparisons by environment, build, instance, revision, model or tool. */
  async compare(
    tenant: { id: string; plan: Plan },
    appId: string,
    rawQuery: unknown,
    now = new Date(),
  ): Promise<RuntimeMetricsComparison> {
    this.identifier(appId, 'appId');
    const query = this.parse(CompareQuerySchema, rawQuery);
    const range = this.range(tenant.plan, query, now);
    const filter = this.filter(tenant.id, appId, query, range);
    const rows = query.by === 'tool'
      ? (await this.store.toolUsage(filter, 100))
        .map((tool) => ({ key: tool.toolId, calls: tool.calls, errors: tool.errors }))
      : (await this.store.breakdown(filter, query.by))
        .map((row) => ({ key: row.key, ...view(row) }));
    return {
      appId,
      by: query.by,
      scope: this.scopeView(query),
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      retention: range.retention,
      rows,
    };
  }

  aggregate(now = new Date()) {
    return this.store.aggregate(now);
  }

  prune(now = new Date()) {
    return this.store.prune(now, this.retention);
  }

  private row(scope: RuntimeMetricsScope, event: RuntimeMetricEvent): RuntimeMetricEventInput {
    return {
      tenantId: scope.tenantId,
      eventId: event.eventId,
      targetAppId: scope.targetAppId,
      environmentId: scope.environmentId,
      occurredAt: new Date(event.occurredAt),
      buildId: event.buildId,
      instanceId: event.instanceId,
      revisionId: event.revisionId,
      model: event.model,
      status: event.status,
      errorCode: event.errorCode,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      costUsd: event.cost.usd,
      costSource: event.cost.source,
      pricingVersion: event.cost.pricingVersion,
      firstTokenMs: event.latency.firstTokenMs,
      totalMs: event.latency.totalMs,
      toolCallCount: event.toolCallCount,
      toolErrorCount: event.toolErrorCount,
      tools: event.tools,
    };
  }

  /**
   * Hour-aligned `[from, to)` inside the plan retention. Without `from` the
   * range covers the last 7 days; without `to` it ends after the current hour.
   */
  private range(
    plan: Plan,
    query: { from?: string; to?: string },
    now: Date,
  ) {
    const days = retentionDaysFor(plan, this.retention);
    const availableFrom = hourBucket(new Date(now.getTime() - days * DAY_MS));
    const latest = new Date(hourBucket(now).getTime() + HOUR_MS);
    const requestedTo = query.to ? new Date(query.to) : latest;
    const end = new Date(Math.min(
      latest.getTime(),
      Math.ceil(requestedTo.getTime() / HOUR_MS) * HOUR_MS,
    ));
    const start = query.from
      ? hourBucket(new Date(query.from))
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    if (start.getTime() >= end.getTime()) {
      throw new BadRequestException({ code: 'runtime_metrics_range_invalid' });
    }
    const from = new Date(Math.max(start.getTime(), availableFrom.getTime()));
    if (from.getTime() >= end.getTime()) {
      throw new BadRequestException({ code: 'runtime_metrics_range_outside_retention' });
    }
    return {
      from,
      to: end,
      retention: { days, availableFrom: availableFrom.toISOString() },
    };
  }

  private filter(
    tenantId: string,
    appId: string,
    query: z.infer<typeof CompareQuerySchema> | z.infer<typeof MetricsQuerySchema>,
    range: { from: Date; to: Date },
  ): RuntimeMetricsFilter {
    return {
      tenantId,
      targetAppId: appId,
      ...(query.environmentId ? { environmentId: query.environmentId } : {}),
      ...(query.buildId ? { buildId: query.buildId } : {}),
      ...(query.instanceId ? { instanceId: query.instanceId } : {}),
      ...(query.revisionId ? { revisionId: query.revisionId } : {}),
      ...(query.model ? { model: query.model } : {}),
      from: range.from,
      to: range.to,
    };
  }

  private scopeView(query: {
    environmentId?: string;
    buildId?: string;
    instanceId?: string;
    revisionId?: string;
    model?: string;
  }): MetricsScopeView {
    return {
      environmentId: query.environmentId ?? null,
      buildId: query.buildId ?? null,
      instanceId: query.instanceId ?? null,
      revisionId: query.revisionId ?? null,
      model: query.model ?? null,
    };
  }

  private identifier(value: string, field: string): void {
    if (!IdentifierSchema.safeParse(value).success) {
      throw new BadRequestException({ code: 'runtime_metrics_identifier_invalid', paths: [field] });
    }
  }

  private parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'runtime_metrics_query_invalid',
        paths: [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.')))],
      });
    }
    return parsed.data;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run src/modules/runtime-metrics/__tests__/runtime-metrics.service.spec.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  1 passed (1)`, `Tests  27 passed (27)`, `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-metrics/runtime-metrics.retention.ts apps/api/src/modules/runtime-metrics/runtime-metrics.store.ts apps/api/src/modules/runtime-metrics/drizzle-runtime-metrics.store.ts apps/api/src/modules/runtime-metrics/runtime-metrics.service.ts apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.service.spec.ts
git commit -m "feat(runtime-metrics): ingest turn events and answer metrics queries"
```

### Task 11: API – serve the metrics routes and schedule the aggregation

**Files:**
- Create: `apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.http.spec.ts`, `__tests__/runtime-metrics.module.spec.ts`
- Create: `apps/api/src/modules/runtime-metrics/runtime-metrics-ingest.controller.ts`, `runtime-metrics.controller.ts`, `runtime-metrics.jobs.ts`, `runtime-metrics.module.ts`
- Create: `apps/api/src/workers/runtime-metrics.worker.ts`
- Modify: `apps/api/src/product-profile.ts` (import after `RuntimeConnectModule`, `FOUNDATION_MODULES` after `RuntimeSetupV2Module`), `apps/api/src/product-profile.spec.ts` (expected Foundation list)

**Interfaces:**
- Consumes: `RuntimeMetricsService` (Task 10), `boundAppOf`, `appScopeFor` (`apps/api/src/common/app-scope.ts`, P08b Task 12), `CompositeAuthGuard`, `PlanGuard`, `@RequireScopes`, `@RequirePlan`, `@CurrentTenant`, `ConfigService`, `BullModule.registerQueue`, `@InjectQueue`, `Processor`/`WorkerHost`.
- Produces:
  - `POST /v1/runtime/apps/:appId/environments/:environmentId/metrics/events` → 202 (`RuntimeMetricsIngestController.ingest`, scope `runtime`)
  - `GET /v2/apps/:appId/metrics` (`RuntimeMetricsController.overview`, scope `management`), `GET /v2/apps/:appId/metrics/compare` (`.compare`, plus `@RequirePlan('pro')`)
  - `RUNTIME_METRICS_QUEUE = 'runtime-metrics'`, `RUNTIME_METRICS_AGGREGATE_JOB = 'aggregate'` (`'*/10 * * * *'`, job id `runtime-metrics-aggregate`), `RUNTIME_METRICS_PRUNE_JOB = 'prune'` (`'17 3 * * *'`, job id `runtime-metrics-prune`), `scheduleRuntimeMetricsJobs(queue)`
  - `runtimeMetricsRetentionProvider`, `RuntimeMetricsModule` (in `FOUNDATION_MODULES`, last), `RuntimeMetricsWorker`

- [ ] **Step 1: Write the failing tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.http.spec.ts`:

```ts
import {
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  RequestMethod,
  type ExecutionContext,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { CompositeAuthGuard } from '../../../common/guards/composite-auth.guard';
import { PlanGuard } from '../../../common/guards/plan.guard';
import { TENANT_CONTEXT, type TenantContext } from '../../../common/types';
import { RuntimeMetricsIngestController } from '../runtime-metrics-ingest.controller';
import { RuntimeMetricsController } from '../runtime-metrics.controller';

const TENANT_ID = '019fb940-0000-7000-8000-000000000001';
const OWN_APP = '019fb940-0000-7000-8000-000000000002';
const OTHER_APP = '019fb940-0000-7000-8000-000000000003';
const ENVIRONMENT_ID = '019fb940-0000-7000-8000-000000000004';

const runtimeKey: TenantContext = {
  id: TENANT_ID, slug: 'acme', plan: 'free', status: 'active',
  apiKeyId: 'key-1', targetAppId: OWN_APP, scopes: ['runtime'],
};
const appManagementKey: TenantContext = { ...runtimeKey, scopes: ['management'] };
const dashboard: TenantContext = {
  id: TENANT_ID, slug: 'acme', plan: 'free', status: 'active',
  scopes: ['management'], userId: 'owner-1', memberRole: 'owner',
};

const handler = (controller: object, name: string) =>
  (controller as Record<string, object>)[name]!;

function metricsService() {
  return {
    ingest: vi.fn(async () => ({ accepted: 1, duplicates: 0, rejected: 0 })),
    overview: vi.fn(async () => ({ appId: OWN_APP })),
    compare: vi.fn(async () => ({ appId: OWN_APP })),
  };
}

describe('runtime metrics routes', () => {
  it('accepts runner events at the environment metrics endpoint with 202 and the runtime scope', () => {
    const ingest = handler(RuntimeMetricsIngestController.prototype, 'ingest');

    expect(Reflect.getMetadata(PATH_METADATA, RuntimeMetricsIngestController))
      .toBe('v1/runtime/apps/:appId/environments/:environmentId/metrics');
    expect(Reflect.getMetadata(PATH_METADATA, ingest)).toBe('events');
    expect(Reflect.getMetadata(METHOD_METADATA, ingest)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ingest)).toBe(HttpStatus.ACCEPTED);
    expect(Reflect.getMetadata('required_scopes', RuntimeMetricsIngestController)).toEqual(['runtime']);
    expect(Reflect.getMetadata(GUARDS_METADATA, RuntimeMetricsIngestController))
      .toEqual([CompositeAuthGuard]);
  });

  it('serves the overview to management readers and comparisons to Pro only', () => {
    const overview = handler(RuntimeMetricsController.prototype, 'overview');
    const compare = handler(RuntimeMetricsController.prototype, 'compare');

    expect(Reflect.getMetadata(PATH_METADATA, RuntimeMetricsController)).toBe('v2/apps/:appId/metrics');
    expect(Reflect.getMetadata(PATH_METADATA, overview)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, overview)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, compare)).toBe('compare');
    expect(Reflect.getMetadata(METHOD_METADATA, compare)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata('required_scopes', RuntimeMetricsController)).toEqual(['management']);
    expect(Reflect.getMetadata(GUARDS_METADATA, RuntimeMetricsController))
      .toEqual([CompositeAuthGuard, PlanGuard]);
    expect(Reflect.getMetadata('required_plans', overview)).toBeUndefined();
    expect(Reflect.getMetadata('required_plans', compare)).toEqual(['pro']);
  });

  it('lets the Pro gate refuse a Free tenant and admit a Pro tenant', () => {
    const guard = new PlanGuard(new Reflector());
    const context = (tenant: TenantContext) => ({
      getHandler: () => handler(RuntimeMetricsController.prototype, 'compare'),
      getClass: () => RuntimeMetricsController,
      switchToHttp: () => ({ getRequest: () => ({ [TENANT_CONTEXT]: tenant }) }),
    }) as unknown as ExecutionContext;

    expect(() => guard.canActivate(context(dashboard))).toThrow(ForbiddenException);
    expect(guard.canActivate(context({ ...dashboard, plan: 'pro' }))).toBe(true);
  });
});

describe('runtime metrics controllers', () => {
  it('reports with the app the runtime key is bound to', async () => {
    const service = metricsService();
    const controller = new RuntimeMetricsIngestController(service as never);
    const body = { schemaVersion: 2, events: [] };

    await controller.ingest(runtimeKey, OWN_APP, ENVIRONMENT_ID, body);
    await controller.ingest(dashboard, OWN_APP, ENVIRONMENT_ID, body);

    expect(service.ingest).toHaveBeenNthCalledWith(
      1,
      { tenantId: TENANT_ID, targetAppId: OWN_APP, environmentId: ENVIRONMENT_ID },
      { tenantId: TENANT_ID, targetAppId: OWN_APP },
      body,
    );
    // A dashboard session is bound to no app, so the service refuses it.
    expect(service.ingest).toHaveBeenNthCalledWith(
      2,
      { tenantId: TENANT_ID, targetAppId: OWN_APP, environmentId: ENVIRONMENT_ID },
      { tenantId: TENANT_ID, targetAppId: undefined },
      body,
    );
  });

  it('answers 404 when an app-bound key asks for another app', () => {
    const service = metricsService();
    const controller = new RuntimeMetricsController(service as never);

    expect(() => controller.overview(appManagementKey, OTHER_APP, {})).toThrow(NotFoundException);
    expect(() => controller.compare(appManagementKey, OTHER_APP, { by: 'model' }))
      .toThrow(NotFoundException);
    expect(service.overview).not.toHaveBeenCalled();
    expect(service.compare).not.toHaveBeenCalled();
  });

  it('passes the tenant, the app and the raw query to the service', async () => {
    const service = metricsService();
    const controller = new RuntimeMetricsController(service as never);

    await controller.overview(appManagementKey, OWN_APP, { environmentId: ENVIRONMENT_ID });
    await controller.compare(dashboard, OTHER_APP, { by: 'environment' });

    expect(service.overview).toHaveBeenCalledWith(appManagementKey, OWN_APP, { environmentId: ENVIRONMENT_ID });
    expect(service.compare).toHaveBeenCalledWith(dashboard, OTHER_APP, { by: 'environment' });
  });
});
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.module.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RuntimeMetricsWorker } from '../../../workers/runtime-metrics.worker';
import {
  RUNTIME_METRICS_AGGREGATE_PATTERN,
  RUNTIME_METRICS_PRUNE_PATTERN,
  scheduleRuntimeMetricsJobs,
} from '../runtime-metrics.jobs';
import {
  RuntimeMetricsModule,
  runtimeMetricsRetentionProvider,
} from '../runtime-metrics.module';
import { RUNTIME_METRICS_RETENTION } from '../runtime-metrics.retention';
import { RUNTIME_METRICS_STORE } from '../runtime-metrics.store';

describe('runtime metrics jobs', () => {
  it('schedules aggregation every 10 minutes and pruning once a day, each under a fixed id', async () => {
    const queue = { add: vi.fn(async () => undefined) };

    await new RuntimeMetricsModule(queue as never).onModuleInit();

    expect(queue.add.mock.calls).toEqual([
      ['aggregate', {}, { repeat: { pattern: '*/10 * * * *' }, jobId: 'runtime-metrics-aggregate' }],
      ['prune', {}, { repeat: { pattern: '17 3 * * *' }, jobId: 'runtime-metrics-prune' }],
    ]);
    expect(RUNTIME_METRICS_AGGREGATE_PATTERN).toBe('*/10 * * * *');
    expect(RUNTIME_METRICS_PRUNE_PATTERN).toBe('17 3 * * *');
    await scheduleRuntimeMetricsJobs(queue as never);
    expect(queue.add).toHaveBeenCalledTimes(4);
  });

  it('runs aggregation and pruning in the worker and refuses unknown jobs', async () => {
    const service = {
      aggregate: vi.fn(async () => ({ groups: 2, toolGroups: 1 })),
      prune: vi.fn(async () => undefined),
    };
    const worker = new RuntimeMetricsWorker(service as never);

    await expect(worker.process({ name: 'aggregate' } as never)).resolves.toEqual({ groups: 2, toolGroups: 1 });
    await expect(worker.process({ name: 'prune' } as never)).resolves.toEqual({ pruned: true });
    await expect(worker.process({ name: 'export' } as never)).rejects.toThrow('Unknown runtime metrics job: export');
    expect(service.aggregate).toHaveBeenCalledWith(expect.any(Date));
    expect(service.prune).toHaveBeenCalledWith(expect.any(Date));
  });
});

describe('runtime metrics module wiring', () => {
  it('provides the store, the retention, the service and the worker', () => {
    const providers = (Reflect.getMetadata('providers', RuntimeMetricsModule) ?? []) as Array<
      { name?: string; provide?: unknown }
    >;
    const names = providers.map((provider) => provider.name ?? provider.provide);

    expect(names).toEqual(expect.arrayContaining([
      'DrizzleRuntimeMetricsStore',
      RUNTIME_METRICS_STORE,
      RUNTIME_METRICS_RETENTION,
      'RuntimeMetricsService',
      'RuntimeMetricsWorker',
      'PlanGuard',
    ]));
    const controllers = (Reflect.getMetadata('controllers', RuntimeMetricsModule) ?? []) as Array<{ name: string }>;
    expect(controllers.map((controller) => controller.name))
      .toEqual(['RuntimeMetricsIngestController', 'RuntimeMetricsController']);
  });

  it('reads the retention from the configuration', () => {
    const values: Record<string, string> = {
      RUNTIME_METRICS_RETENTION_FREE_DAYS: '14',
      RUNTIME_METRICS_RETENTION_PRO_DAYS: '180',
    };
    const config = { get: (name: string) => values[name] };

    expect(runtimeMetricsRetentionProvider.useFactory(config as never))
      .toEqual({ freeDays: 14, proDays: 180 });
    expect(runtimeMetricsRetentionProvider.useFactory({ get: () => undefined } as never))
      .toEqual({ freeDays: 30, proDays: 365 });
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/product-profile.spec.ts b/apps/api/src/product-profile.spec.ts
index 1685856..8f792e0 100644
--- a/apps/api/src/product-profile.spec.ts
+++ b/apps/api/src/product-profile.spec.ts
@@ -28,6 +28,7 @@ describe('API product profile', () => {
       'RuntimeDeploymentModule',
       'RuntimeSetupModule',
       'RuntimeSetupV2Module',
+      'RuntimeMetricsModule',
     ]);
   });
 
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run src/modules/runtime-metrics/__tests__/runtime-metrics.http.spec.ts src/modules/runtime-metrics/__tests__/runtime-metrics.module.spec.ts src/product-profile.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  3 failed (3)`, `Tests  1 failed | 18 passed (19)` (both new specs cannot load `../runtime-metrics-ingest.controller` and `../../../workers/runtime-metrics.worker`; the profile spec misses `RuntimeMetricsModule`).

- [ ] **Step 3: Implement controllers, jobs, worker and module**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics-ingest.controller.ts`:

```ts
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { boundAppOf } from '../../common/app-scope';
import { RequireScopes } from '../../common/decorators/scopes.decorator';
import { CurrentTenant } from '../../common/decorators/tenant.decorator';
import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
import { type TenantContext } from '../../common/types';
import { RuntimeMetricsService } from './runtime-metrics.service';

/**
 * Where a connected runner delivers its content-free turn events
 * (`createRuntimeMetricsSink` in the SDK). Replaces the Proctor endpoint the
 * Foundation profile never mounted.
 */
@Controller('v1/runtime/apps/:appId/environments/:environmentId/metrics')
@UseGuards(CompositeAuthGuard)
@RequireScopes('runtime')
export class RuntimeMetricsIngestController {
  constructor(private readonly metrics: RuntimeMetricsService) {}

  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  ingest(
    @CurrentTenant() tenant: TenantContext,
    @Param('appId') appId: string,
    @Param('environmentId') environmentId: string,
    @Body() body: unknown,
  ) {
    return this.metrics.ingest(
      { tenantId: tenant.id, targetAppId: appId, environmentId },
      { tenantId: tenant.id, targetAppId: boundAppOf(tenant) },
      body,
    );
  }
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics.controller.ts`:

```ts
import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { appScopeFor } from '../../common/app-scope';
import { RequirePlan } from '../../common/decorators/plan.decorator';
import { RequireScopes } from '../../common/decorators/scopes.decorator';
import { CurrentTenant } from '../../common/decorators/tenant.decorator';
import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
import { PlanGuard } from '../../common/guards/plan.guard';
import { type TenantContext } from '../../common/types';
import { RuntimeMetricsService } from './runtime-metrics.service';

/**
 * Metrics for the dashboard (Citadel P08c): the Free overview per app and
 * environment, and Pro comparisons. An app-bound key reads only its own app.
 */
@Controller('v2/apps/:appId/metrics')
@UseGuards(CompositeAuthGuard, PlanGuard)
@RequireScopes('management')
export class RuntimeMetricsController {
  constructor(private readonly metrics: RuntimeMetricsService) {}

  @Get()
  overview(
    @CurrentTenant() tenant: TenantContext,
    @Param('appId') appId: string,
    @Query() query: unknown,
  ) {
    return this.metrics.overview(tenant, this.app(tenant, appId), query);
  }

  @Get('compare')
  @RequirePlan('pro')
  compare(
    @CurrentTenant() tenant: TenantContext,
    @Param('appId') appId: string,
    @Query() query: unknown,
  ) {
    return this.metrics.compare(tenant, this.app(tenant, appId), query);
  }

  private app(tenant: TenantContext, appId: string): string {
    return appScopeFor(tenant, appId) ?? appId;
  }
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics.jobs.ts`:

```ts
import type { Queue } from 'bullmq';

export const RUNTIME_METRICS_QUEUE = 'runtime-metrics';
export const RUNTIME_METRICS_AGGREGATE_JOB = 'aggregate';
export const RUNTIME_METRICS_PRUNE_JOB = 'prune';
/** Every 10 minutes: the dashboard lags at most one run behind. */
export const RUNTIME_METRICS_AGGREGATE_PATTERN = '*/10 * * * *';
/** Daily at 03:17 (API process time zone, UTC in the container), off the hourly audit archive slot. */
export const RUNTIME_METRICS_PRUNE_PATTERN = '17 3 * * *';

/**
 * Registers both repeatable jobs (same pattern as the hourly audit archive).
 * Fixed job ids keep restarts and several API instances from scheduling a
 * job twice.
 */
export async function scheduleRuntimeMetricsJobs(queue: Pick<Queue, 'add'>): Promise<void> {
  await queue.add(RUNTIME_METRICS_AGGREGATE_JOB, {}, {
    repeat: { pattern: RUNTIME_METRICS_AGGREGATE_PATTERN },
    jobId: 'runtime-metrics-aggregate',
  });
  await queue.add(RUNTIME_METRICS_PRUNE_JOB, {}, {
    repeat: { pattern: RUNTIME_METRICS_PRUNE_PATTERN },
    jobId: 'runtime-metrics-prune',
  });
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/workers/runtime-metrics.worker.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job } from 'bullmq';
import {
  RUNTIME_METRICS_AGGREGATE_JOB,
  RUNTIME_METRICS_PRUNE_JOB,
  RUNTIME_METRICS_QUEUE,
} from '../modules/runtime-metrics/runtime-metrics.jobs';
import { RuntimeMetricsService } from '../modules/runtime-metrics/runtime-metrics.service';

@Processor(RUNTIME_METRICS_QUEUE)
@Injectable()
export class RuntimeMetricsWorker extends WorkerHost {
  private readonly logger = new Logger(RuntimeMetricsWorker.name);

  constructor(private readonly metrics: RuntimeMetricsService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case RUNTIME_METRICS_AGGREGATE_JOB: {
        const result = await this.metrics.aggregate(new Date());
        this.logger.debug(`Aggregated ${result.groups} metric groups, ${result.toolGroups} tool groups`);
        return result;
      }
      case RUNTIME_METRICS_PRUNE_JOB:
        await this.metrics.prune(new Date());
        return { pruned: true };
      default:
        throw new Error(`Unknown runtime metrics job: ${job.name}`);
    }
  }
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/runtime-metrics/runtime-metrics.module.ts`:

```ts
import { Module, type OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
import { PlanGuard } from '../../common/guards/plan.guard';
import { RuntimeMetricsWorker } from '../../workers/runtime-metrics.worker';
import { DrizzleRuntimeMetricsStore } from './drizzle-runtime-metrics.store';
import { RuntimeMetricsIngestController } from './runtime-metrics-ingest.controller';
import { RuntimeMetricsController } from './runtime-metrics.controller';
import {
  RUNTIME_METRICS_QUEUE,
  scheduleRuntimeMetricsJobs,
} from './runtime-metrics.jobs';
import {
  RUNTIME_METRICS_RETENTION,
  resolveRuntimeMetricsRetention,
} from './runtime-metrics.retention';
import { RuntimeMetricsService } from './runtime-metrics.service';
import { RUNTIME_METRICS_STORE } from './runtime-metrics.store';

export const runtimeMetricsRetentionProvider = {
  provide: RUNTIME_METRICS_RETENTION,
  inject: [ConfigService],
  useFactory: (config: Pick<ConfigService, 'get'>) => resolveRuntimeMetricsRetention({
    RUNTIME_METRICS_RETENTION_FREE_DAYS: config.get<string>('RUNTIME_METRICS_RETENTION_FREE_DAYS'),
    RUNTIME_METRICS_RETENTION_PRO_DAYS: config.get<string>('RUNTIME_METRICS_RETENTION_PRO_DAYS'),
  }),
};

@Module({
  imports: [BullModule.registerQueue({ name: RUNTIME_METRICS_QUEUE })],
  controllers: [RuntimeMetricsIngestController, RuntimeMetricsController],
  providers: [
    CompositeAuthGuard,
    PlanGuard,
    DrizzleRuntimeMetricsStore,
    { provide: RUNTIME_METRICS_STORE, useExisting: DrizzleRuntimeMetricsStore },
    runtimeMetricsRetentionProvider,
    RuntimeMetricsService,
    RuntimeMetricsWorker,
  ],
})
export class RuntimeMetricsModule implements OnModuleInit {
  constructor(
    @InjectQueue(RUNTIME_METRICS_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await scheduleRuntimeMetricsJobs(this.queue);
  }
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
diff --git a/apps/api/src/product-profile.ts b/apps/api/src/product-profile.ts
index 87b1afe..a7b3d93 100644
--- a/apps/api/src/product-profile.ts
+++ b/apps/api/src/product-profile.ts
@@ -27,6 +27,7 @@ import { RuntimeDeploymentModule } from './modules/runtime-deployments/runtime-d
 import { RuntimeSetupModule } from './modules/runtime-setup/runtime-setup.module';
 import { RuntimeSetupV2Module } from './modules/runtime-setup-v2/runtime-setup-v2.module';
 import { RuntimeConnectModule } from './modules/runtime-connect/runtime-connect.module';
+import { RuntimeMetricsModule } from './modules/runtime-metrics/runtime-metrics.module';
 
 export type ApiProductProfile = 'foundation' | 'full';
 
@@ -42,6 +43,7 @@ const FOUNDATION_MODULES: Type<unknown>[] = [
   RuntimeDeploymentModule,
   RuntimeSetupModule,
   RuntimeSetupV2Module,
+  RuntimeMetricsModule,
 ];
 
 const DEFERRED_MODULES: Type<unknown>[] = [
PATCH
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run src/modules/runtime-metrics/__tests__/runtime-metrics.http.spec.ts src/modules/runtime-metrics/__tests__/runtime-metrics.module.spec.ts src/product-profile.spec.ts src/product-profile-wiring.spec.ts 2>&1 | grep -E "Test Files|Tests " && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  4 passed (4)`, `Tests  30 passed (30)` (6 route tests, 4 module tests, the 19 profile tests and the profile wiring test), `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-metrics/runtime-metrics-ingest.controller.ts apps/api/src/modules/runtime-metrics/runtime-metrics.controller.ts apps/api/src/modules/runtime-metrics/runtime-metrics.jobs.ts apps/api/src/modules/runtime-metrics/runtime-metrics.module.ts apps/api/src/workers/runtime-metrics.worker.ts apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.http.spec.ts apps/api/src/modules/runtime-metrics/__tests__/runtime-metrics.module.spec.ts apps/api/src/product-profile.ts apps/api/src/product-profile.spec.ts
git commit -m "feat(runtime-metrics): serve metrics routes and schedule aggregation"
```

---

### Task 12: SDK gate (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Run every SDK gate**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run build > /dev/null 2>&1; echo "build=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run typecheck:tests > /dev/null 2>&1; echo "typecheck:tests=$?"
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run test 2>&1 | grep -E "Test Files|Tests "
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && git status --short | wc -l && git log --oneline 24b5075..HEAD | wc -l
```

Expected: `typecheck=0`, `build=0` (the CommonJS pass compiles `src/runtime/metrics/**`), `typecheck:tests=0`, `Test Files  197 passed (197)`, `Tests  2059 passed (2059)` (baseline 1,930 + 46 + 29 + 15 + 19 + 20), `0`, `5`. The load note from Task 0 Step 2 applies (it lists the only files allowed a rerun).

- [ ] **Step 2: Prove the content boundary on the built package**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && node --input-type=module -e "
import { TechnicalRuntimeEventV2Schema } from './dist/contracts/index.js';
import { createRuntimeMetricsSinkFromEnv } from './dist/runtime/index.js';
console.log('standalone-sink=' + String(createRuntimeMetricsSinkFromEnv({})));
console.log('schema-strict=' + TechnicalRuntimeEventV2Schema.safeParse({ schemaVersion: 2, prompt: 'x' }).success);
" && grep -rn "proctor" dist/runtime dist/server/adapters/nextjs | grep -v "\.map:" | wc -l
```

Expected: `standalone-sink=undefined`, `schema-strict=false`, and `1` (the only mention is the JSDoc of the legacy `telemetry` option in `dist/server/adapters/nextjs/types.d.ts`; no runtime code path in the Foundation surface names the Proctor endpoint).

### Task 13: Platform gate and checkpoint (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Run every Platform gate**

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
(cd packages/db && bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts src/__tests__/bounded-tool-overrides-migration.test.ts src/__tests__/runtime-metrics-migration.test.ts 2>&1 | tail -4)
(cd packages/db && DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1)
git status --short | wc -l
```

Expected: `no watcher`; `db-build=0`; `api-typecheck=0`; API `Test Files  <A_files + 4> passed`, `Tests  <A_tests + 80> passed | 10 skipped` (43 + 27 + 6 + 4 new tests; the profile spec keeps its 19); Citadel exactly as in P08b Task 14 (not touched); DB `<D_tests + 17> pass`, `0 fail`, across `<D_files + 2>` files; the migration quartet `12 pass`, `0 fail`, `Ran 12 tests across 4 files.`; `Everything's fine 🐶🔥`; `0`. The five P09 commits sit on top of P08b's last commit.

- [ ] **Step 2: Checkpoint report to Philipp**

Report the ten commits (five per repo) with hashes, the gate numbers of Tasks 12 and 13, the decisions table and these requests and findings (none of them is executed by an agent):

1. **Shared database:** `0045_runtime_metrics` only creates four tables, three `bucket` indexes, three composite foreign keys to `runtime_environments` and one from the tool events to their event; nothing existing changes. It needs the P08b `0044` runbook first and PostgreSQL 15 or newer (`UNIQUE NULLS NOT DISTINCT`; PGlite, where it was proved, is 17): Philipp checks `select version()` (read-only) before migrating. Approval needed before `bun run db:migrate`.
2. **Redis in production:** the Foundation profile now schedules two repeatable jobs (`runtime-metrics-aggregate`, `runtime-metrics-prune`) next to `audit-archive-hourly`; the deployment needs the same Redis it already needs for the audit archive. Optional configuration: `RUNTIME_METRICS_RETENTION_FREE_DAYS`, `RUNTIME_METRICS_RETENTION_PRO_DAYS` (an invalid value stops the API at boot).
3. **Get It Done (P11):** wire `metrics` with one sink per process, created at module scope of `src/app/api/ai/chat/route.ts` (`createRuntimeMetricsSinkFromEnv()`, optionally `GLIRASTES_BUILD_ID` from the deploy) and passed into `createGetItDoneChatHandler`, which builds a new handler per request; a sink created inside that factory would draw a new `instanceId` per turn. If wanted, add `modelPricing`. GID passes no `telemetry` (checked in the pilot's `src/lib/glirastes/chat-handler.ts`), so the new refusal does not affect it. Its OpenRouter setup (`createOpenAI({ baseURL })`) is exactly the provider the Task 5 test pins.
   **Not proved without a live call:** the Task 5 stream is recorded by hand, not captured from OpenRouter. Whether OpenRouter's final streaming usage chunk carries `cost` for GID's requests (which send `stream_options.include_usage` but no OpenRouter `usage: { include: true }`) must be confirmed in P11's approved live run. If it does not, turns stay `cost: null` (never 0) unless `modelPricing` is set, and the turn budget's cost dimension stays as inert as before P09.
   **Behaviour change to confirm:** once a cost is known, `maxEstimatedCostUsd` takes effect (Platform default and GID local limit: 5 USD per turn); a revision with `maxEstimatedCostUsd: 0` now stops every turn with a positive known cost after its first model step (`ExecutionBudgetTracker`: limit 0 means nothing allowed).
4. **P08c (Citadel):** "Was kostet die Nutzung?" reads `GET /v2/apps/:appId/metrics`; show `cost.knownUsd` with the provenance split (`providerReportedUsd`, `priceTableUsd`) and `unknownCostTurns`/`complete` (never render unknown as 0); comparisons only for Pro (403 otherwise); `retention.availableFrom` bounds the date picker.
5. **P10:** takes migration index `0046` (spec 4.10.11 says `0045_tool_generation_jobs`).
6. **P05 (lockstep):** `tool_contract_rejected` (spec 4.7) needs a new `eventType` with its fields in the SDK schema, the vectors (new digest on both sides), the Platform port and an aggregation rule.
7. **Roadmap merge checklist (SDK):** when `codex/mvp-chat` and `codex/mvp-tools` are merged, `src/runtime/index.ts` and `src/contracts/index.ts` are unions (P09 appends three export blocks to the first and replaces the two `./events.js` export lines of the second).
8. **P07b (lockstep):** direct `ui`/`tool` commands that run without a model call bypass `streamText`; P07b must either finish `turnMetrics` for them (`model: null`, unknown cost, the tool counts) or decide in its plan that they are not turns. Both P07b and P09 edit `src/server/adapters/nextjs/create-ai-chat-handler.ts`, so that file is a manual merge as well.
9. **P05 (skills):** `skills/integrating-glirastes-nextjs/SKILL.md` states "The normal chat path makes no Control Plane request" and does not mention `metrics`; P05 adds the Connected exception (asynchronous metric batches off the turn) and the `metrics` wiring step. P09 leaves `skills/**` to P05.
10. **Ingest volume (follow-up, not a P09 change):** besides the per-key rate limit (Free: 5 management requests per second per route, 50 events each) there is no per-tenant event quota, and every `aggregate` run recomputes 26 hours of all tenants' raw events. That is ample for MVP volumes; a per-tenant quota or an incremental aggregation belongs on the list before Free sign-ups open widely. The sink also relies on a long-lived process (unref'd timer, `flush()`/`close()` available); on serverless hosts queued events can be lost when an instance freezes. Get It Done runs as a long-lived container and is not affected.

Do not push.

---

## Self-Review

**Spec coverage (spec section → task):**

| Spec | Covered by |
| --- | --- |
| 7 SDK: `TechnicalRuntimeEvent` v2 with `appId`, `environmentId`, `buildId`, `instanceId`, `revisionId`, model, input/output tokens, cost `{usd \| null, source 'provider-reported' \| 'price-table' \| null, pricingVersion}`, latency (first answer, total), error code, tool count and ids | Task 1 (contract, vectors), Task 3 (recorder fills every field), Task 5 (handler) |
| 7 SDK: asynchronous, batched sink outside the critical turn path; dropped on failure; never blocking | Task 4 (sink), Task 3 and Task 5 (failing sink never reaches the turn) |
| 7 SDK: OpenRouter `usage.cost` counts as `provider-reported` | Task 2 (`rawChunkCostUsd`, precedence), Task 5 (`@ai-sdk/openai` against the recorded OpenRouter stream) |
| 7 SDK: no prompts, contents, arguments, results or secrets (content-boundary check) | Task 1 (strict schema + `findForbiddenPlatformContentPath`), Task 4 (the sink re-validates), Task 5 (secret phrase never in the event), Task 9 (Platform parity), Task 10 (ingest refuses and never echoes) |
| 7 SDK: the Lancer send to the unmounted Proctor endpoint is replaced on the Foundation path | Task 5 (`metrics` option, refusal of `telemetry` with `managedRuntime`, doc), Task 12 Step 2; Lancer code unchanged |
| 7 Platform: ingest endpoint with the app-/environment-bound runtime key | Tasks 10 and 11 |
| 7 Platform: table plus hourly aggregation (existing BullMQ pattern) | Task 7 (tables), Task 8 (aggregation SQL), Task 11 (queue, repeatable jobs, worker in the Foundation profile) |
| 7 Platform: Free dashboard per app/environment (tokens, cost with provenance, latency, errors, tool usage; filters by environment, build, instance, revision, model) | Task 8 (queries), Task 10 (`overview`), Task 11 (route) |
| 7 Platform: Pro comparisons by environment, version, model, tool and longer history | Task 8 (`queryRuntimeMetricBreakdown`, tool usage), Task 10 (`compare`, plan retention), Task 11 (`@RequirePlan('pro')`) |
| 7 / 10.9 Retention configurable, default Free 30, Pro 365 days | Task 8 (`pruneRuntimeMetrics`), Task 10 (`resolveRuntimeMetricsRetention`, range clamp), Task 11 (provider from `ConfigService`, daily job) |
| 4.6 Unknown cost stays `null`, never 0 | Task 1 (`invalid/unknown-cost-as-zero`), Task 2, Task 5, Task 8 (`unknown_cost_turns`), Task 10 (`complete: false`) |
| `src/runtime/budget.ts` `estimatedCostUsd` never set | Task 5 (`afterModelStep({ estimatedCostUsd })`, budget stop test) |

Deliberately not in P09: the Citadel views (P08c), wiring the sink into Get It Done (P11), `tool_contract_rejected` (P05), Platform CI (P13). Not covered because out of scope by the spec: billing, alerting.

**Measurement (2026-10-05):** SDK in a `git archive` copy of `24b5075` with the worktree's `node_modules`, every task applied cumulatively; each RED measured with only that task's test files present, each GREEN and typecheck after its implementation; final gate 197 files, 2,059 tests, typecheck, build and `typecheck:tests` exit 0. Platform in a `git archive` copy of `cd6d642` (P08b Tasks 1–8) plus P08b Task 12's `app-scope.ts` taken from the P08b plan, with `packages/db/dist` rebuilt: every RED and GREEN count quoted above, API 118 → 122 files and 1,282 → 1,362 tests, DB 103 → 120 tests and 20 → 22 files, migration quartet 12 pass, `drizzle-kit generate` produced the SQL shown byte for byte and `drizzle-kit check` stayed clean. Because the Platform half runs after P08b Tasks 11–14, Task 6 records the real baseline and every later expectation is relative to it.

**Plan check (replay):** the rendered document was then executed literally: every `Create`/`Replace` block written and every bash block run in document order, with the two worktree roots mapped to fresh `git archive` copies of `24b5075` (branch `codex/mvp-chat`) and of `3074b8d` (P08b Tasks 1–10) plus `app-scope.ts`. Every RED and GREEN line quoted in Tasks 1–11 came out exactly as written; Task 6 showed API `119`/`1296` and DB `103`/20, Task 13 API `123`/`1376 passed | 10 skipped` (+4 files, +80 tests), DB `120 pass` across 22 files, Citadel `39`/`256`, lint `✖ 30 problems (0 errors, 30 warnings)`, migration quartet `12 pass`, `drizzle-kit check` clean, both trees clean; the replayed trees equal the measured ones byte for byte except the generated snapshot `id` and journal `when`. The two full SDK runs of the replay (Task 0 at `1929 passed`, Task 12 at `2057 passed` of 2,059) and one more full rerun at load 21–32 failed only on timeouts in the files of the load note (`handler-analysis`, `schema-probe`, `embed-module`), which then passed alone (61 of 61); the full replayed suite with `--maxWorkers=4` gave `Test Files  197 passed (197)`, `Tests  2059 passed (2059)` at load 25–33, and the baseline was green with `192`/`1930` on the first measurement run; `typecheck`, `build`, `typecheck:tests`, `standalone-sink=undefined`, `schema-strict=false` and the single `proctor` mention came out as quoted. The OpenRouter cost path was additionally probed with `@ai-sdk/openai` 3.0.53 and a fake `fetch`: `usage.raw` arrives as `{prompt_tokens, completion_tokens, total_tokens}` without `cost`; only the raw chunk keeps `cost`, and the UI message stream contains no raw part.

**Independent plan check (2026-10-05):** a second reviewer replayed the final document literally (after its fixes: Goal scope of "one event per turn", module-scope sink rule in the docs patch, Aggregation and Delivery rows, Task 6 precondition, checkpoint items 1, 3 and 8–10) against fresh `git archive` copies of `24b5075` and of `825ddc5` (the newest `codex/mvp-platform` commit, P08b Tasks 1–10 plus its review fix) with P08b Task 12's `app-scope.ts`. Every RED and GREEN line of Tasks 1–11 came out as quoted; Task 6 showed API `119`/`1302 passed | 10 skipped`, DB `103`/20; Task 13 API `123`/`1382 passed | 10 skipped` (+4/+80), DB `120`/22, migration quartet `12`, Citadel and lint unchanged, `drizzle-kit check` clean; Task 12 `typecheck`, `build`, `typecheck:tests`, `standalone-sink=undefined`, `schema-strict=false` and `1`; the full SDK suite at load 34–40 failed only in `handler-analysis` and `schema-probe` (also with `--maxWorkers=4`), and the four load-note files then passed alone (61 of 61). The ingest guard path was checked against the real `CompositeAuthGuard`/`ApiKeyGuard` (Bearer key, `runtime` scope, dashboard `runtime` maps to `dashboard:manage` and is then refused by the service because no app is bound), `RateLimitInterceptor` (management limit per key and route) and `assertControlPlaneSafe` (no event key is a forbidden key; `inputTokens`/`firstTokenMs` do not end in `token`).

**Placeholder scan:** done. Every new file is given in full, every change to an existing file is an exact `git apply` patch generated from the measured copies, the migration comes from `drizzle-kit generate` with its expected SQL spelled out, and the Platform vectors come from the SDK object store with a pinned digest. No TBD, no "similar to Task N", no step that deletes a file, reads a secret or reaches a network.

**Type consistency:** done. `TechnicalRuntimeEventV2`, `RuntimeTurnCost`, `RuntimeTurnStatus` and `RuntimeTurnErrorCode` (Task 1) are the only event types used by `cost.ts`, `turn-recorder.ts`, `sink.ts` and the handler; `RuntimeMetricsSink`/`RuntimeMetricsIdentity` are defined once (Task 3) and implemented by `createRuntimeMetricsSink` (Task 4) and by the test doubles; `RuntimePriceTable` (Task 2) is the type of `modelPricing` and `StreamHandlerContext.modelPricing`. On the Platform, `RuntimeMetricEventInput`, `RuntimeMetricsFilter`, `RuntimeMetricsMeasures`, `RuntimeMetricsRetention`, `RuntimeMetricsDimension` and `RuntimeToolUsage` (Task 8) are the store contract's types (Task 10) and the service's; `RuntimeMetricEvent` (Task 9) is mapped to `RuntimeMetricEventInput` in exactly one place (`RuntimeMetricsService.row`). The two schemas share their limits (50 events, 32 tools, label and pricing-version patterns, status/error-code coupling) and are held together by the vectors with the same sha256 pin on both sides.

**Merge note for the SDK worktrees:** P09 changes only additive regions of `src/contracts/index.ts` (the `./events.js` exports) and `src/runtime/index.ts` (three blocks at the end); resolve both as unions when `codex/mvp-chat` and `codex/mvp-tools` are merged into `codex/glirastes-foundation-runtime`, then rerun Task 12.
