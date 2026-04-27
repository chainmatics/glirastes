# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/chainmatics/glirastes/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/chainmatics/glirastes/releases/tag/v0.2.0
