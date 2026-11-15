# Runtime container V1 implementation plan

> **For Claude:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the existing SDK next to a non-Node API without customer Node code.

**Architecture:** One active runtime per app/environment; existing SDK owns chat, tools, policies, approvals and platform sync. A thin configured Node host resolves the backend session, forwards only selected credentials, and streams the existing protocol. PostgreSQL persists consumed approvals and enforces the single active runtime. Generated, version-checked artifacts come from the existing generator.

**Tech Stack:** TypeScript, Node, existing AI SDK, PostgreSQL, PHP reference backend, Docker Compose.

## Approved design

The user approved the preceding architecture proposal and explicitly requested implementation in an isolated worktree. V1 has one fixed backend origin, cookie or bearer authentication verified by that backend, distinct platform and business tenant scopes, no HA, browser-local sessions, JSON API tools, and optional platform connection with accepted-deployment gating. No native backend SDKs, server conversation service, OAuth broker, or arbitrary live OpenAPI fetch.

## Tasks and verification

1. SDK HTTP transport (`src/server/core/index.ts`) and chat cancellation (`src/server/adapters/nextjs/`). First test redirect escape, byte/time limits, fixed prefixes, request abort and in-flight tool abort. Implement shared SDK behavior and run targeted Vitest cases.
2. Artifact builder (`src/runtime-service/artifact.ts`). Test generator-derived modules, version/hash mismatch and unsupported OpenAPI inputs. Reuse refresh/check and immutable outputs, without an independent generator or handwritten tool inventory.
3. Persistent approval store (`src/runtime-service/approval-store.ts`). Test concurrent/replayed consumption, restart, expiration, quota and store outage against isolated Postgres. Enforce singleton runtime ownership.
4. Config/identity (`src/runtime-service/config.ts`, `identity.ts`). Test strict JSON config, trusted origins, selected credential forwarding, invalid identity and tenant separation before implementation.
5. HTTP host/CLI (`src/runtime-service/server.ts`, `bin.ts`). Test auth, readiness, stream/cancellation, body limits, drain, fail-closed platform gating and safe diagnostics. Use createGlirastes/chatTurn and createAiChatHandler.
6. Container + reference (`containers/runtime/`, `examples/php-runtime/`). Supply pinned dependency installation, non-root/read-only operation, secret files, build/validate/serve modes and Compose. Exercise a real PHP API and browser using the actual SDK stream.
7. Documentation and CI. Publish exact runnable commands and limitations; test build, source/test typechecks, targeted/new tests, full SDK suite, Docker build and reference E2E. Inspect diff and report implementation versus publication/deployment separately.

## Acceptance

Authenticated tenant-isolated reads; backend-enforced denial; approved write and rejected/tampered/replayed approval; restart-safe consumption; cancellation; no origin/redirect credential escape; stale/unsupported artifact rejection; frontend action and session continuation; explicit platform outage behavior. No image publication or deployment as part of local implementation.
