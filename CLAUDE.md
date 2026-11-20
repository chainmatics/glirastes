# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

glirastes is a single TypeScript package (`glirastes`) for building AI-powered tool systems. It turns declarative tool definitions (with Zod schemas, RBAC roles, UI patterns) into AI SDK-compatible tools that execute HTTP calls and dispatch frontend UI actions.

## Current release and source of truth

`main` contains the published Foundation SDK and configured runtime service
(starting with 0.14.0). Read `package.json#version`, `package.json#exports`,
`docs/support-matrix.md` and `docs/runtime-container.md` before making support
claims. Old `codex/glirastes-foundation-runtime` and `gls-04-foundation` worktrees
are historical, not the release source. Do not restore removed APIs from them.

The approved Foundation design is
`docs/plans/2026-07-28-glirastes-foundation-design.md`; current implementation,
release docs and tests establish what is shipped. Generic OpenAPI integration,
tested browser hosts and full-stack acceptance are separate support levels.

Non-negotiable boundary: prompts, model calls, tool arguments, tool results,
secrets, business data, and final authorization stay in the consumer's
environment. The Platform receives content-free technical metadata and returns
signed immutable revisions. Fail closed; never add an unsigned fallback.

**After changing anything under `src/contracts`, run `bun run build`** — the
pilot consumer loads from `dist/`, so a contract change that is not built is a
change the consumer never sees.

## Commands

```bash
# Build
bun run build

# Typecheck
bun run typecheck

# Typecheck test files (glirastes/* self-imports resolve via dist: build first)
bun run typecheck:tests

# Run all tests
bun run test

# Run a single test file
bunx vitest run src/path/to/file.test.ts
```

There is no linter or formatter configured — TypeScript strict mode is the only static analysis.

## Publishing

**NEVER publish locally.** Do not run `npm publish` or `bun publish`. Publishing is handled exclusively by `.github/workflows/publish.yml`, which publishes to the **public npm registry** as `glirastes` with npm provenance.

The workflow triggers on:
1. A pushed git tag matching `v*` (e.g. `git tag v0.2.0 && git push origin v0.2.0`)
2. Manual `workflow_dispatch` from the GitHub Actions tab

Release flow:
1. On a clean tree run `bun run release:prepare <version>` (`scripts/prepare-release.ts`). It merges
   `upgrade-notes/unreleased/*.json` into `upgrade-notes/<version>.json` as `{ "version", "notes" }`,
   deletes the merged files (keeps `.gitkeep`), refreshes `upgrade-notes/api-surface.released.json` and
   sets the version in `package.json` and `src/runtime/sdk-version.ts`. It refuses, changing nothing, on
   a dirty tree or when `upgrade-notes/<version>.json` already holds notes.
2. Update `CHANGELOG.md`, run the gate, commit everything in one release commit via `/commit` and push to `main`
3. Tag: `git tag v<version> && git push origin v<version>` — CI builds and publishes to npm

The `release-preflight` job in `publish.yml` refuses a tag before the image push or npm publish while
`upgrade-notes/unreleased/*.json` exists, `upgrade-notes/<version>.json` is missing, or
`upgrade-notes/api-surface.released.json` differs from the source (`bun scripts/api-surface.ts --check`).
Every prerelease tag also needs its own `upgrade-notes/<rc-version>.json` (e.g. `0.19.0-rc.1.json`;
`bun run release:prepare 0.19.0-rc.1` writes it, `notes: []` is fine).

The SDK package lives on public npm. Release CI also tests and publishes the
public Linux amd64 image `ghcr.io/chainmatics/glirastes-runtime:<version>`.
Pin its digest and match artifact SDK versions. A green publish job, registry
availability and a running customer deployment are separate evidence. Documentation
changes on main do not rewrite already-published npm packages or image tags.

## Peer Dependency Ranges

When declaring `peerDependencies` for libraries on `0.x` versions (e.g. `class-validator`, `class-transformer`, `reflect-metadata`), **never use caret (`^0.x`)**. In semver, `^0.14` resolves to `>=0.14.0 <0.15.0`, which breaks consumers the moment they bump to `0.15`. Use an open range like `">=0.14 <1"` instead.

## Source Structure

```
src/
├── index.ts                  — Root barrel
├── types.ts                  — Types, Zod schemas, definition helpers
├── contracts/                — Framework-neutral contracts (Zod). No engine or
│                               provider imports, ever. app-setup, revisions,
│                               prompt-bundle, events, content-boundary,
│                               platform-prompt-revision
├── runtime/                  — Local managed runtime: turn snapshot, authorization,
│   │                           budget, fingerprint, engine, json-schema
│   └── ai-sdk/               — Vercel AI SDK reference engine (the only place an
│                               engine may be imported)
├── runtime-service/          — Configured HTTP host, identity, immutable artifacts,
│                               PostgreSQL approvals/lease, glirastes-runtime CLI
├── sync/                     — Control-plane client, app-setup client, JWKS provider,
│                               deployment selector, SSE push, local validation
├── stt/                      — Provider-neutral speech-to-text
├── server/
│   ├── core/                 — Tool→AI SDK conversion, RBAC, transport adapters
│   ├── lancer/               — Internal-only HTTP client (NOT public)
│   ├── pii-shield/           — PII detection, anonymization, pseudonymization
│   ├── adapters/             — Framework adapters
│   └── testing/              — Test helpers without LLM calls
├── react/                    — Chat UI components, hooks, provider, STT bridges
├── codegen/                  — Scanner, execution inventory, registry generation
└── cli/                      — init | scan | setup | connect | sync | doctor | install |
                                validate | build | tools | upgrade (report|ack)
```

## Subpath Exports

The authoritative list is `package.json#exports`; `src/public-subpaths.test.ts`
enforces it. The current Foundation package exposes:

`glirastes` · `/contracts` · `/runtime` · `/runtime/ai-sdk` · `/ai-sdk` ·
`/stt` · `/sync` · `/server` · `/server/http` · `/server/nextjs` · `/adapter/nextjs` ·
`/server/testing` · `/react` · `/react/vercel` · `/react/styles.css` · `/react/pills.css` · `/embed` ·
`/browser` · `/codegen`

**Deliberately not exported here** (the confirmed pilot cut — still versioned in
the repo, deferred from the package): NestJS server adapter, LangGraph, the
`glirastes/openapi` subpath, Skill/MCP generation, Lancer, and remote Aegis.
The CLI **does** support the OpenAPI 3.0/3.1 JSON source and runtime artifacts. Reintroducing any of them needs its own
acceptance gate; do not simply add the export back.

## Architecture

**Core flow**: Tool Definition → Registry → RBAC-filtered AI Tools → streamText() → UI Action Dispatch

1. **Definition**: Tools declared via `defineEndpointTool()` / `defineUiTool()` with Zod input/output schemas, `allowedRoles`, `uiPattern`
2. **Registry**: `endpointToolsToRegistry()` / `uiToolsToRegistry()` collect tools into a `ToolRegistry` (Record<string, Tool>)
3. **Conversion**: `toolsToAiTools(registry, context)` filters by user roles, wires approval flows, wraps execute functions
4. **Execution**: Endpoint tools call backend APIs via `callEndpoint()` transport adapter; UI tools produce `uiAction` payloads
5. **Dispatch**: Frontend `UiActionBus` receives tool results and fires registered handlers via `useAiClientAction()`

**Managed-local flow** (the Foundation path): the consumer's runner syncs signed
revisions from the control plane and caches them locally. A turn **pins** one
Agent/Manifest/Policy snapshot at its start and keeps it for the whole turn, even
if the cache updates mid-turn. Every tool call passes a `beforeToolCall` guard
that re-checks the pinned snapshot, the freshly resolved server-side principal,
budgets, and any newly loaded revocation. A security revocation blocks the *next*
tool call. Nothing in this path calls the Platform.

**Runtime hosting and connection mode are independent.** Reuse a suitable Node
server or deploy the configured container beside Rust/PHP/Java. Both use
`createGlirastes().chatTurn()` and the existing HTTP/chat pipeline; do not fork
model execution, identity guards, tool dispatch or approvals into another SDK.

Embedded `createGlirastes` selects standalone without `GLIRASTES_API_KEY`;
connected mode uses that app key, `GLIRASTES_ENVIRONMENT` and an optional
`GLIRASTES_CONTROL_PLANE_URL`. Consult `src/runtime/glirastes.ts` and
`docs/managed-runtime-sync.md` for embedded local availability and sync behavior.
The container explicitly configures `platform.enabled` and mounted key files.
Connected container readiness requires an accepted deployment, with no automatic
standalone downgrade. An accepted cached revision survives transient sync errors.

Container V1 supports one active process per app/environment, guarded by a
PostgreSQL session lock; stop-before-start updates, no HA claim. Artifacts are
immutable JSON with exact SDK version and integrity validation. The backend
verifies the forwarded user's credentials and pinned business-tenant/user
headers, preserving every existing permission. The browser owns UI actions and
identity-scoped local sessions. Use packaged skill references for setup and
`docs/runtime-container.md` for operating limits and acceptance.

**Budgets** are multidimensional (tool calls, model steps, tool timeout, whole-turn
timeout, input/output tokens, estimated cost, consecutive errors, repeated
fingerprint) and merge as local-max versus stricter-policy. Loop detection uses a
deterministic normalized JSON fingerprint over tool **and arguments and
result/progress** — comparing tool names alone is not sufficient.

**Lancer is internal-only** in the published package. `createLancer()` is not exported, and
the normal managed-local execution path must not send content to Platform
services.

## Upgrade notes and skills

Every PR that changes public API, defaults or behavior a consumer can notice:
1. updates the affected skill in `skills/` in the same PR, and
2. adds one file `upgrade-notes/unreleased/<id>.json` (schema: `src/cli/commands/upgrade/notes.ts`).
`src/upgrade-notes.test.ts` fails when the public surface changes without a note. A note's `surface`
lists the keys it covers; `X.*` covers a type and all its members, `*#X.*` does so in every subpath. Behavior changes
the snapshot cannot see are a review rule: the reviewer asks for the note.

## Conventions

- Package manager is **Bun**
- Single package, **ESM** (module: NodeNext, target: ES2022)
- Build is `tsc`, output to `dist/`
- Test files use `.test.ts` or `.spec.ts` patterns with Vitest
- All internal imports use relative paths (no path aliases)

## Open-Core / Commercialization Model

- All SDK features are free and open-source
- Pro features are unlocked by having a Glirastes API key (SaaS model)
- The embedded consumer has exactly **one** Platform app-key variable,
  `GLIRASTES_API_KEY`, with the privilege expressed as a scope on the key.
  `GLIRASTES_SETUP_API_KEY` and `GLIRASTES_RUNTIME_API_KEY` were retired without
  fallback — do not reintroduce a second key name.
- The appId comes from generated artifacts; the environment is selected with
  `GLIRASTES_ENVIRONMENT`. `GLIRASTES_CONTROL_PLANE_URL` defaults to the hosted
  Platform. The container uses JSON configuration and mounted secrets instead.
  The Platform adds governance — signed revisions, approvals, rollout and
  rollback — while the customer runtime executes model and backend calls.
