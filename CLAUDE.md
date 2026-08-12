# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

glirastes is a single TypeScript package (`glirastes`) for building AI-powered tool systems. It turns declarative tool definitions (with Zod schemas, RBAC roles, UI patterns) into AI SDK-compatible tools that execute HTTP calls and dispatch frontend UI actions.

## Read this first: which branch you are on

- **`main`** (published `0.4.0`) — the historical shape: broad surface, public
  `createLancer()`, NestJS/LangGraph/OpenAPI exported.
- **`codex/glirastes-foundation-runtime`** — the **managed-local Foundation**
  package. Narrowed surface, Lancer internal, new `contracts`/`runtime`/`sync`
  subpaths. This is where active work happens, and the sections below describe
  *this* branch.
- **`gls-04-foundation`** — **abandoned.** Built in a single day on 2026-05-16
  against the 2026-05-16 free-tier roadmap (`GlirastesError`,
  `createChatHandler`, `defineTool`, `autoTools`, four CI gates). The
  architecture was then restarted from scratch, which is what the 2026-07-28
  design and this branch are. Do not harvest from it and do not port it:
  - its content boundary (G2: grep `fetch(`, list hosts in a manifest) is the
    weaker answer to a question `src/contracts/content-boundary.ts` and the
    zero-`fetch` handler proof answer at the data level;
  - its public-surface snapshot (G3) is covered by `src/public-subpaths.test.ts`;
  - its a11y baseline (G4) targets a chat panel that no longer exists here.

  The only genuinely missing pieces are a bundle-size budget and an a11y
  baseline, and both want writing fresh against the current surface rather than
  porting. The branch is kept only as the record that the roadmap was once
  executed.

The approved architecture is
`docs/plans/2026-07-28-glirastes-foundation-design.md`; it supersedes the
2026-05-16 free-tier design and roadmap where they conflict. The live state of
the pilot lives in the Platform repo's canonical working document and its newest
`*-foundation-pilot-handoff.md`.

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
1. Bump `version` in `package.json`
2. Commit via `/commit` and push to `main`
3. Tag: `git tag v<version> && git push origin v<version>` — CI builds and publishes to npm

The package lives on public npm (not GitHub Packages).

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
└── cli/                      — scan | sync | setup | validate | build | status |
                                install-skills | check-upgrade
```

## Subpath Exports

The authoritative list is `package.json#exports`; `src/public-subpaths.test.ts`
enforces it. On the Foundation branch:

`glirastes` · `/contracts` · `/runtime` · `/runtime/ai-sdk` · `/ai-sdk` ·
`/stt` · `/sync` · `/server` · `/server/nextjs` · `/adapter/nextjs` ·
`/server/testing` · `/react` · `/react/vercel` · `/react/styles.css` · `/codegen`

**Deliberately not exported here** (the confirmed pilot cut — still versioned in
the repo, deferred from the package): NestJS, LangGraph, OpenAPI, Skill/MCP
generation, Lancer, and remote Aegis. Reintroducing any of them needs its own
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

**Two runtime modes, one pipeline** (2026-08-10 design): **standalone is the
default** — without `GLIRASTES_CONTROL_PLANE_URL`, `createLocalRuntimeSource`
materializes the same `TurnSnapshot` shape from the CLI-generated
`.glirastes/` artifacts, self-signed with an ephemeral boot-time Ed25519 key
(`createEphemeralLocalSigner`), strictly network-silent, restart-only reload.
**Managed is the opt-in add-on** for hot-swap and governance. Mode comes from
`resolveRuntimeMode(env)`, which fails closed on a half-configured managed
setup — there is no silent downgrade out of managed, and no third mode.
Everything downstream of the source (registry materialization, model-safe
naming, guards, budgets) is shared between both modes; never fork it.

**Budgets** are multidimensional (tool calls, model steps, tool timeout, whole-turn
timeout, input/output tokens, estimated cost, consecutive errors, repeated
fingerprint) and merge as local-max versus stricter-policy. Loop detection uses a
deterministic normalized JSON fingerprint over tool **and arguments and
result/progress** — comparing tool names alone is not sufficient.

**Lancer is internal-only** on this branch. `createLancer()` is not exported, and
the normal managed-local execution path must not send content to Platform
services.

## Conventions

- Package manager is **Bun**
- Single package, **ESM** (module: NodeNext, target: ES2022)
- Build is `tsc`, output to `dist/`
- Test files use `.test.ts` or `.spec.ts` patterns with Vitest
- All internal imports use relative paths (no path aliases)

## Open-Core / Commercialization Model

- All SDK features are free and open-source
- Pro features are unlocked by having a Glirastes API key (SaaS model)
- On the Foundation branch the consumer has exactly **one** key variable,
  `GLIRASTES_API_KEY`, with the privilege expressed as a scope on the key.
  `GLIRASTES_SETUP_API_KEY` and `GLIRASTES_RUNTIME_API_KEY` were retired without
  fallback — do not reintroduce a second key name.
- The control plane is addressed via `GLIRASTES_CONTROL_PLANE_URL` together with
  `GLIRASTES_APP_ID` and `GLIRASTES_ENVIRONMENT_ID`. What the Platform adds is
  governance — signed revisions, approvals, rollout and rollback — not execution.
