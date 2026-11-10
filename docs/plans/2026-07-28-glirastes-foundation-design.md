# Glirastes Foundation Design

**Date:** 2026-07-28
**Status:** Approved architecture, implementation baseline
**Supersedes:** `2026-05-16-free-tier-excellence-design.md` and its roadmap where they conflict with this document

## Outcome

Get It Done becomes the first production pilot of a managed-local Glirastes
runtime. The Glirastes Platform is the control plane. Customer prompts, model
calls, tool arguments, tool results, secrets, business data, and final
authorization remain in the target environment.

The integration goal is not merely package replacement. A newly scanned target
application must reach its first successful tool action in less than five
minutes without decorators or manually maintained tool annotations.

## Repository baseline

### Get It Done

- Production source is `origin/master` at `4b5d569`. The deployment workflow
  builds and deploys every push to `master`.
- A runtime container revision could not be read because the CWS VM was not
  reachable from the development host. The source baseline is reproducible;
  the runtime-image proof remains an explicit release gate.
- Production resolves the old `@chainmatics/agentic-*` family at `0.15.14`.
- The production build passes. The corrected baseline has 666 passing tests.
- Chat UI, sessions, mentions, suggestions, approvals, client actions, and
  domain tool definitions are mature and must remain functional.
- Voice has duplicate state ownership and finalization races and is a source
  for UX requirements, not an implementation to copy.

### Glirastes SDK

- Canonical upstream is `v0.4.0` at `c55b896`.
- Typecheck, 262 tests, ESM/CJS build, and subpath shims pass.
- Reusable: framework-neutral tool types, Vercel transport, React UI, UI action
  bus, Next.js/NestJS adapters, OpenAPI scanner, codegen, and test helpers.
- Missing: immutable runtime contracts, turn snapshots, multidimensional
  budgets, verified-principal contract, local policy cache, checkpoints,
  managed runner, signed revision sync, and production-grade STT.
- Existing loop detection compares tool names only and does not satisfy the
  tool + normalized arguments + result/progress fingerprint requirement.
- Existing Lancer paths send content to platform services. They cannot remain
  in the normal managed-local execution path.

### Glirastes Platform

- Platform build and corrected DB baseline pass.
- Reusable: tenants, target apps, auth, API keys, registry, approvals, audit,
  SSE stream, telemetry aggregation, model overrides, Citadel, and R2 archive.
- `target_apps` is flat and has no runtime environments.
- `tool_schemas` is mutable and keyed by textual tool ID.
- `generated_assets` overwrites manifests instead of publishing immutable
  revisions.
- Agent, rollout, lease, runner, and revision concepts are not represented by
  the current schema.
- Warden, Primus, Aegis, and routing currently process content in platform API
  paths. Their definitions remain platform-managed, but content execution must
  move into the local runtime.

## Architecture boundary

### One public SDK

Keep one public package, `glirastes`, with independently importable subpaths:

- `glirastes/contracts`
- `glirastes/runtime`
- `glirastes/runtime/ai-sdk`
- `glirastes/react`
- `glirastes/server/nextjs`
- `glirastes/server/nestjs`
- `glirastes/sync`

Heavy optional integrations remain behind subpath exports. The environment
runner is built from the same repository and distributed as an executable
package plus official container image. Do not recreate the old public
multi-package family.

### Runtime profiles

1. Embedded runtime for interactive turns inside the target app.
2. One shared environment runner for asynchronous, scheduled, and unattended
   agents in a runtime environment.

Both profiles use the same contracts, policy evaluator, budget enforcement,
checkpoint adapter, AI-SDK engine, and local bindings.

### Control plane

The platform owns:

- logical applications and runtime environments;
- semantic tool configuration and immutable manifest revisions;
- immutable agent and runtime-policy revisions;
- approvals, routing, notification configuration, rollout, and rollback;
- revision signing, push/stream delivery, polling fallback, and revocation;
- in-content-free health, deployment, budget, error-class, and audit metadata.

The platform does not own customer model credentials, tool credentials, raw
prompts, tool arguments, tool results, or business content.

### Local runtime

The target environment owns:

- provider/model and secret bindings;
- `resolvePrincipal(request)` and run-as delegation resolution;
- final tool authorization and execution;
- prompt/model execution and conversation/checkpoint stores;
- locally enforced maximum budgets and timeouts;
- signed last-known-good revision cache;
- content-bearing diagnostic data.

Effective permission is the intersection of current principal rights, the
agent allowlist, and current tenant/tool policy. It is recalculated before
every tool call and fails closed.

## Revision model

- Every tool has a permanent platform UUID and local source fingerprint.
- Description changes publish a runtime-policy revision.
- Method, path, schema, or auth-binding changes publish an immutable manifest
  revision and disable the tool until approved.
- Removed tools become immutable tombstones.
- Agent and policy revisions are signed and immutable.
- A user turn pins one revision snapshot. Normal updates activate only at
  turn/run boundaries.
- Security revocations are checked before the next tool call and apply
  immediately.
- Runtime delivery supports push, polling fallback, last-known-good, canary,
  pinning, health gates, and rollback.

## Runtime safety contract

Each turn has immutable local maxima and optionally stricter signed policy for:

- model/agent steps;
- tool calls;
- total duration and per-tool timeout;
- input/output tokens and estimated cost;
- repeated tool/argument/result fingerprints;
- consecutive errors;
- delegation breadth, depth, and shared parent/child budget.

At roughly 80 percent the runtime emits a soft budget event. At 100 percent it
blocks further tools and permits only a bounded final summary.

## Tool discovery and five-minute integration

The happy path is scan-driven:

1. A local CLI inspects framework routes, OpenAPI metadata, schemas, auth
   boundaries, and tests without uploading source or secrets.
2. It produces a local source manifest and fingerprints.
3. The platform proposes semantic names, descriptions, data classes, and risk
   notes.
4. A deterministic local safety gate validates schema, auth, side effects,
   limits, external calls, and tests.
5. Approved manifest and generated bindings sync back into the project.
6. The base chat UI is inserted and a safe tool action proves the integration.

AI may propose semantics but may not independently approve risky tools.
Automatic approval is limited to explicitly enabled, fully validated safe
reads.

## UI and STT

The current `glirastes/react` UI is canonical. Get It Done and Citadel styling
is retained through slots, class names, themes, session bridges, and typed
tool-result components rather than a forked chat implementation.

STT is a provider-neutral state machine with one media stream and the states
`idle`, `requesting_permission`, `connecting`, `recording`, `finalizing`,
`completed`, `cancelled`, and `failed`.

Required behavior:

- visible interim transcript;
- segment-aware interim/final merging without duplication or loss;
- stop waits for finalization and commits text;
- cancel discards the recording and restores the previous draft;
- transcript remains editable before send;
- deterministic cleanup of MediaStream, WebSocket, worklet, and audio context;
- retry without parallel sessions;
- Deepgram is the first adapter, not a hard-coded UI dependency.

TTS, duplex voice, automatic turn-taking, and barge-in are out of scope.

## Migration strategy

Get It Done receives a parallel v2 route and feature flag. The old path remains
available only until contract, security, behavior, visual, STT, performance,
and rollback gates are green. The final pilot state removes every old
`@chainmatics/agentic-*` dependency and dead compatibility adapter.

Citadel consumes the same public SDK and becomes the control-plane dogfood
client. It must not gain a privileged private UI fork.

## Evidence gates

- SDK: typecheck, unit/contract/security tests, ESM/CJS build, subpath export
  smoke tests, bundle budgets.
- Platform: schema tests, migrations, API integration tests, tenant isolation,
  immutable revision and signature tests, build.
- Get It Done: unit/behavior tests, production build, v1/v2 migration tests,
  authenticated browser flows, visual snapshots, tool and approval parity.
- STT: deterministic unit tests, mocked provider integration, real-browser
  permission/lifecycle tests, transcript corpus comparison, p50/p95 latency.
- Privacy: network assertions prove no content-bearing platform requests during
  normal interactive execution.
- Deployment: exact deployed source/image revision and tested rollback are
  recorded before production activation.
