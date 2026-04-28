# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Default `safetyMaxSteps` lowered from 24 → 8. Override via
  `createAiChatHandler({ safetyMaxSteps })` if a workflow legitimately
  requires deeper tool chains.
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
  so consumers can pin / replicate the default behaviour in tests.

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
