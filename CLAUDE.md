# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

glirastes is a single TypeScript package (`glirastes`) for building AI-powered tool systems. It turns declarative tool definitions (with Zod schemas, RBAC roles, UI patterns) into AI SDK-compatible tools that execute HTTP calls and dispatch frontend UI actions.

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

**NEVER publish locally.** Do not run `scripts/publish.sh`, `npm publish`, or `bun publish`. Publishing is handled exclusively by `.github/workflows/publish.yml`, which publishes to the **public npm registry** as `glirastes`.

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
├── index.ts                  — Root barrel (re-exports types)
├── types/                    — Types, Zod schemas, definition helpers
├── server/
│   ├── index.ts              — Barrel: server-core + pro + pii-shield
│   ├── core/                 — Tool→AI SDK conversion, RBAC, transport adapters
│   ├── pro/                  — Pro pipeline: Lancer-delegated RBAC, guardrails
│   ├── lancer/               — Thin HTTP client for Glirastes platform API
│   ├── pii-shield/           — PII detection, anonymization, pseudonymization
│   ├── adapters/
│   │   ├── nextjs/           — createAiChatHandler() for Next.js App Router
│   │   └── nestjs/           — @AiModule/@AiTool decorators, NestJS scanning
│   └── testing/              — createAiTestSuite() for testing without LLM calls
├── react/                    — Chat UI components, hooks, provider
│   └── ui/                   — UiActionBus, useAiClientAction() hook
├── codegen/                  — Filesystem scanner, registry code generation
├── openapi/                  — OpenAPI spec → endpoint tool definitions
└── cli/                      — `glirastes init | generate | validate | coverage | scaffold`
```

## Subpath Exports

Consumers import via subpath exports:
- `glirastes` — types (root re-export)
- `glirastes/server` — server-core + pro + pii-shield
- `glirastes/server/nextjs` — Next.js adapter
- `glirastes/server/nestjs` — NestJS adapter
- `glirastes/server/lancer` — Lancer client
- `glirastes/server/testing` — Test suite
- `glirastes/react` — Chat UI components
- `glirastes/react/core` — Core hooks (no Vercel AI dep)
- `glirastes/react/template` — Pre-styled template
- `glirastes/codegen` — Code generation
- `glirastes/openapi` — OpenAPI generation

## Architecture

**Core flow**: Tool Definition → Registry → RBAC-filtered AI Tools → streamText() → UI Action Dispatch

1. **Definition**: Tools declared via `defineEndpointTool()` / `defineUiTool()` with Zod input/output schemas, `allowedRoles`, `uiPattern`
2. **Registry**: `endpointToolsToRegistry()` / `uiToolsToRegistry()` collect tools into a `ToolRegistry` (Record<string, Tool>)
3. **Conversion**: `toolsToAiTools(registry, context)` filters by user roles, wires approval flows, wraps execute functions
4. **Execution**: Endpoint tools call backend APIs via `callEndpoint()` transport adapter; UI tools produce `uiAction` payloads
5. **Dispatch**: Frontend `UiActionBus` receives tool results and fires registered handlers via `useAiClientAction()`

**Two server modes** in `createAiChatHandler()`:
- **Pipeline mode** (Pro): `pipeline.process()` handles guardrails → intent classification → tool scoping → model selection
- **Legacy mode**: Direct `guardrails()` + `intentRouter()` + manual model config

**Lancer client** (`createLancer()`) is a thin HTTP client with namespaces (gate, primus, warden, aegis, config, telemetry) that delegate to the Glirastes platform. All calls use `callWithFallback()` for graceful degradation.

## Conventions

- Package manager is **Bun**
- Single package, **ESM** (module: NodeNext, target: ES2022)
- Build is `tsc`, output to `dist/`
- Test files use `.test.ts` or `.spec.ts` patterns with Vitest
- All internal imports use relative paths (no path aliases)

## Open-Core / Commercialization Model

- All SDK features are free and open-source
- Pro features are unlocked by having a Glirastes API key (SaaS model)
- **Lancer**: Free-tier gets telemetry reporting to Glirastes dashboard; Pro-tier adds guardrails, intent routing, PII protection, runtime prompt overrides
- Glirastes platform API base URL defaults to `https://api.glirastes.chainmatics.io`, overridable via `createLancer({ baseUrl })`
