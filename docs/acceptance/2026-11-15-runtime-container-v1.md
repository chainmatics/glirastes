# Runtime container V1 acceptance and release — 2026-11-15

Implementation worktree: `feat/runtime-container-v1`, based on SDK main `7816b37`.
The test uses the same SDK execution/approval pipeline as embedded integrations.
The first sections record local implementation acceptance; the release and
production section below records the later publication and live SDK verification.

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

## Local acceptance boundaries

The provider is a deterministic OpenAI-compatible HTTP/SSE stub, not a paid model
account. This local test phase did not perform a live customer deployment,
model-provider account smoke test or live platform pairing/policy change.
Platform gates are covered by service wiring and existing SDK/platform-contract
tests. The local results alone do not establish image/npm publication.
Neither this phase nor the later release claims HA or a Rust/Java reference-stack acceptance.
The general suite's skipped reference cases are not counted as passed.

## Frontend host acceptance

The Angular 21.2.26, SvelteKit 2.70.4/Svelte 5.57.3 and Nuxt 4.4.2
production builds passed their real Chrome acceptance: **4 tests passed, no
skips** (one parent and three framework cases). The test covers client-only
loading under SSR, verified identity before session-store initialization,
restoration after reload, streamed frontend actions, real router navigation,
unmount/remount cleanup and a delayed-identity/unmount race.

API/model replies in these frontend-only cases are scripted. The PHP test above
is the separate end-to-end runtime/backend boundary. Reproduce with the locked
fixture installs and command in `examples/frontend-frameworks/README.md`.

## Published release and production SDK verification

Later on 2026-11-15, [SDK PR #57](https://github.com/chainmatics/glirastes/pull/57)
merged as `a63868946c27555b6c00b120db063228607fdb1f`. The
[v0.14.0 release](https://github.com/chainmatics/glirastes/releases/tag/v0.14.0)
and [release workflow](https://github.com/chainmatics/glirastes/actions/runs/43740370091)
provide the publication evidence:

- Final SDK suite: **3,840 tests passed**, 16 conditional skips; typechecks,
  build and release gates passed.
- The release gate passed the real PHP/PostgreSQL/container/browser test
  (**2 tests, no skips**) and Angular/SvelteKit/Nuxt browser host tests
  (**4 tests, no skips**) on Linux before publishing the tested image.
- `glirastes@0.14.0` became publicly installable from npm. The downloaded package
  included the runtime CLI and packaged setup, runtime and non-React references.
- The Linux amd64 image `ghcr.io/chainmatics/glirastes-runtime:0.14.0` was
  verified with an anonymous pull and runs as `node`. Its immutable digest is
  `sha256:edf35f3d093d58c03361c0242350dd6d9fb70554e4deffa113002aaba8cac00c`.

Get It Done separately upgraded its **embedded SDK** through
[staging PR #81](https://github.com/chainmatics/get-it-done/pull/81) and
[production PR #83](https://github.com/chainmatics/get-it-done/pull/83).
The final production composition passed **2,144 tests** (29 existing optional
PostgreSQL skips) and its production build. The
[production deployment](https://github.com/chainmatics/get-it-done/actions/runs/43745808379)
completed successfully for commit `d7373bf62d02d171fc7f1db69520d818af0ee134`.
Citadel showed a connected Production runner reporting `glirastes@0.14.0`
with a recent heartbeat. Authenticated browser checks passed a read-only chat
tool call, a navigation action and conversation restoration after reload;
the health endpoint returned `ok`. No business-data writes were exercised.

This live smoke test proves the embedded integration in that application.
It is not a live deployment of the new container to a Rust/PHP/Java customer,
a production write/approval test, or a complete-stack acceptance of the three
frontend examples. Those boundaries retain their separate tests above.
