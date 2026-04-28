# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-04-28

### Added

- Dual-bundle output (CJS + ESM). The package now ships a CommonJS build at
  `dist/cjs/` alongside the ESM build at `dist/`, so legacy NestJS backends
  on `module: commonjs` can consume `glirastes/server/nestjs` without an ESM
  migration. The `exports` map uses conditional `import`/`require` branches
  with their own typings.
- Legacy subpath shim directories at the package root (`server/`, `react/`,
  `codegen/`, `openapi/`) so consumers on `moduleResolution: node` (without
  `exports`-map support) still resolve subpaths.
- Pre-built agent skills under `skills/` (shipped in the npm tarball):
  `integrating-glirastes-nextjs`, `integrating-glirastes-nestjs`,
  `integrating-glirastes-nextjs-with-nestjs-backend`,
  `maintaining-glirastes-tools`, `building-glirastes-chat-ui`. Drop into
  `.claude/skills/` (or `.codex/skills/`) to give a coding agent
  framework-specific guidance for integrating, maintaining, and customizing
  the SDK.
- New CLI command `glirastes install-skills` — installs the bundled agent
  skills into a target directory. Flags:
  - default: `./.claude/skills` (project-local)
  - `-g` / `--global`: `~/.claude/skills` (shared across all projects on the
    machine; mutually exclusive with `--target`)
  - `--target <dir>`: override the destination (accepts relative, absolute,
    or `~/`-prefixed paths)
  - `--stack nextjs|nestjs|nextjs+nestjs|all` (default `all`): filter
  - `--symlink`: track the installed SDK version automatically
  - `--force`: overwrite existing
  - `--dry-run`: preview without writing
- Adapter-selection guidance in the README: when both a frontend and a
  separate backend exist, put the chat route on the backend.
- Scaling-up section in the README explaining the `glirastes scaffold` →
  `generate-tools` → registry-import codegen workflow.

### Changed

- `@ai-sdk/react` and `react-markdown` moved from `dependencies` to optional
  `peerDependencies`. Backend-only consumers no longer pull a phantom React
  tree into `node_modules`. Frontend consumers must install them themselves
  (the README install section is split per stack).
- `dependencies.zod` bumped to `^3.25.76` to match what `ai@6` and
  `@ai-sdk/openai` require.
- `AiChatModule.attachWebSockets()` is now `async`. Consumers that enable
  the speech-to-text feature must `await` the call.

### Fixed

- Optional peer `wavesurfer.js` is now truly optional. The voice
  components load it via a runtime `Function('s', 'return import(s)')`
  helper so browser-side bundlers (Webpack, Turbopack, Vite, esbuild)
  don't try to resolve the specifier at build time when the package is
  not installed. Note: requires `script-src 'unsafe-eval'` CSP — projects
  with strict CSP should install `wavesurfer.js` unconditionally to
  bypass the runtime trick. See `skills/building-glirastes-chat-ui` for
  details.
- Optional peer `ws` is now truly optional. The NestJS speech-to-text
  gateway uses a plain dynamic `import('ws')` inside `attachWebSockets`,
  guarded by try/catch — backends that don't enable speech-to-text no
  longer crash with `ERR_MODULE_NOT_FOUND` at startup. (Bundled NestJS
  deployments must either install `ws` unconditionally or mark it as a
  bundler external.)

## [0.3.0] - 2026-04-28

### Fixed

- README NestJS examples now match the real decorator API: `@AiTool({ name })`
  not `toolName`, `@AiModule({ intent, classification })` takes an options
  object, `scanNestJsControllers({ controllers })` takes an options object
  and returns `{ tools, modules, toolsByModule }` (destructure `.tools`
  before passing to `endpointToolsToRegistry`).
- Stream handler no longer emits the fallback `"No output generated.
  Check the stream for errors."` event when an upstream error has
  already been streamed in the same response.

### Changed

- Peer-dep range for `@nestjs/common`, `@nestjs/core`, `@nestjs/config`,
  `@nestjs/swagger` widened to support v10 alongside v11.

### Added

- `examples/quickstart-nestjs/` and `examples/quickstart-nextjs/` —
  compile-tested in CI via `tests/examples-compile.test.ts`. What you
  copy from the README is what compiles.
- README "Setup notes" section: recommended `tsconfig.json` (so
  `Cannot find module 'glirastes/server/nestjs'` no longer surprises
  consumers on legacy `moduleResolution`) and a subpath decision-tree
  table.
- `FOLLOWUPS.md` capturing deferred work: dual ESM+CJS bundle,
  `glirastes`+`glirastes-react` split for production trim, optional
  `baseUrl` for endpoint tools, registry sugar, CLI docs.
- `DEFAULT_SAFETY_MAX_STEPS` and `resolveStepLimit` are now public exports
  so consumers can pin / replicate the safety-cap behaviour in tests.

## [0.2.1] - 2026-04-27

### Changed

- README hero image now uses a relative path (`.github/hero.gif`) so it
  renders directly from the repository instead of a hard-coded
  `raw.githubusercontent.com` URL.
- Refreshed `.github/hero.gif` with an updated, smaller animation.

## [0.2.0] - 2026-04-27

### Added

- Initial public release of `glirastes`.
- Type-safe tool definitions via `defineEndpointTool()` and `defineUiTool()`.
- Role-based access control (RBAC) at the tool layer.
- Approval flows for sensitive tool calls.
- Server adapters for Next.js (App Router) and NestJS (decorators).
- React chat UI components, hooks, and provider.
- UI Action bus for declarative client-side dispatch from tool results.
- PII shield with anonymization, pseudonymization, and rehydration.
- Lancer client for the Glirastes platform with graceful degradation.
- CLI: `init`, `generate`, `validate`, `coverage`, `scaffold`.
- Codegen for endpoint registries, UI registries, action IDs, and modules.
- OpenAPI generator: turn an OpenAPI spec into endpoint tool definitions.
- Testing utilities for tool setups without LLM calls.
- `engines.node` field declaring Node.js `>=20` as the supported runtime.
- CI: `npm audit` job (production deps, level=high) on every PR and push.
- CI: CodeQL static analysis with `security-and-quality` query suite.

### Changed

- `react-markdown` and `wavesurfer.js` are now optional `peerDependencies`
  rather than runtime `dependencies`. Server-only consumers no longer pull
  these libraries on install. `react-markdown` is loaded via `React.lazy`
  with a plain-text fallback when the peer dep is not installed.

[Unreleased]: https://github.com/chainmatics/glirastes/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/chainmatics/glirastes/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/chainmatics/glirastes/releases/tag/v0.2.0
