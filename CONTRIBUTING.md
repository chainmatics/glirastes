# Contributing to glirastes

Thanks for your interest in contributing! This document describes how to
propose changes to the project.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating you agree to uphold its terms. Report unacceptable behavior to
**conduct@chainmatics.net**.

## Development Setup

Requirements:

- [Bun](https://bun.sh) ≥ 1.0
- Node.js ≥ 20 (for compatibility checks; runtime is Bun)

```bash
git clone https://github.com/chainmatics/glirastes.git
cd glirastes
bun install
bun run typecheck
bun run test
bun run build
```

There is no linter or formatter; TypeScript strict mode is the only static
check.

## Submitting Changes

1. Fork the repository and create a branch from `main`
2. Keep PRs **small and focused** — one logical change per PR
3. Make sure `bun run typecheck` and `bun run test` pass locally
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages, e.g. `feat(server): add streaming support`
5. Open the PR with a clear description of *what* changed and *why*

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
rather than a CLA. By contributing, you certify that you have the right to
submit your work under the project license (Apache-2.0).

Sign-off is **encouraged but not enforced** in CI today. If you want to
sign-off your commits — or for substantial contributions where provenance
matters — append a `Signed-off-by` trailer:

```bash
git commit -s -m "feat(server): add streaming support"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line.

## Code Style

- TypeScript **strict mode** — no `any` without justification
- ESM only (`"type": "module"`)
- Relative imports only — no path aliases
- Avoid comments unless they explain a non-obvious *why*
- Tests use Vitest; place them next to the source as `*.test.ts`

## Reporting Bugs

[Open an issue](https://github.com/chainmatics/glirastes/issues/new/choose)
and include:

- `glirastes` version (`bun pm ls glirastes`)
- Minimal reproduction (a tiny repo or gist is best)
- Expected vs actual behavior
- Stack trace, if any

## Reporting Security Issues

**Do not** open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the private reporting channel.

## Releasing

Releases are published from CI on tagged commits. Maintainers only:

1. Bump `version` in `package.json`
2. Commit and push to `main`
3. `git tag v<version> && git push origin v<version>`

The `Publish glirastes` workflow builds and publishes to npm with provenance.
