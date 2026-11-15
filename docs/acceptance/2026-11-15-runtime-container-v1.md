# Runtime container V1 local acceptance — 2026-11-15

Implementation worktree: `feat/runtime-container-v1`, based on SDK main `7816b37`.
The test uses the same SDK execution/approval pipeline as embedded integrations.

## Observed results

- Source typecheck, test typecheck, ESM/CJS build: passed.
- Full Vitest suite: **333 files passed, 2 files skipped; 3,838 tests passed, 16 skipped**.
- Persistent approval store against isolated PostgreSQL 17: **9 passed** (run explicitly with `GLIRASTES_TEST_POSTGRES_URL`; these are gated without a DB URL in the general suite).
- Final Docker runtime + real PHP/PostgreSQL + actual Chrome: **2 tests passed, 0 skipped**, 8.9 seconds. One Node parent test contains HTTP assertions and one browser subtest.
- Docker image: `glirastes-runtime:v1-test`, image ID `sha256:458c6586e4189dd8a59744acdee0c5b7fb697c4261b7d31a1e1808628f3f9f33`, non-root `node`, pinned Node 22/Bun bases. Image built locally only.
- Image CLI built and validated a PHP project artifact without a customer Node package. Read-only image CLI and Compose configuration validation passed.
- Independent review found and prompted fixes for diagnostic disclosure, empty query values, required-empty-body coverage, app/environment approval signing isolation and cleanup. Regression tests cover the fixes.

## End-to-end assertions

Real PHP session cookie; anonymous denial; tenant-isolated reads; reader mutation
refused by backend even after confirmation; rejected/tampered/cross-tenant approval;
one observed approved mutation; replay after runtime restart cannot write again;
revoked session; only selected credentials forwarded; backend rejects mismatched
pinned user/tenant headers; unexpected browser Origin rejected; provider stream
aborted after disconnect; PHP OpenAPI export freshness; actual browser read,
confirmation click, frontend highlight, session restoration, and session isolation
on workspace switch for users sharing the same user ID.

## Reproduce

```sh
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:tests
bun run build
bun install --frozen-lockfile --cwd examples/react-nest-separate/api
bun run test
# PostgreSQL URL must address an isolated test database.
GLIRASTES_TEST_POSTGRES_URL=... bunx vitest run src/runtime-service/approval-store.test.ts
docker build -f containers/runtime/Dockerfile -t glirastes-runtime:v1-test .
GLIRASTES_RUNTIME_TEST_IMAGE=glirastes-runtime:v1-test \
  PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  PLAYWRIGHT_CHANNEL=chrome node --test tests/runtime-container-e2e.mjs
```

CI installs Chromium and uses the same image/browser test without requiring a
Chrome channel. The reference test cleans its isolated containers and scratch
files. The separately provisioned approval-test database was removed afterwards.

## Boundaries

The provider is a deterministic OpenAI-compatible HTTP/SSE stub, not a paid model
account. No live customer deployment, model-provider account smoke test, or live
platform pairing/policy change was performed. Platform gates are covered by
service wiring and existing SDK/platform-contract tests. This record does not
claim HA, a Rust/Java reference-stack acceptance, or image/npm publication.
The general suite's skipped reference cases are not counted as passed.
