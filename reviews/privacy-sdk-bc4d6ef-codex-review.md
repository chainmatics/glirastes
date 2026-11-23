# Independent Codex review — SDK main/privacy integration

2026-11-17. Actual reviewer: **Codex (OpenAI GPT-6-based agent)**, Orca worker `orca_session_id:9273167d-83d6-417a-9cf9-e73e46251f59`. Not Opus. Read-only implementation review, no helpers, commits, builds, package installation or implementation edits. All added test artifacts are under `/tmp`.

## Immutable scope

- Reviewed merge **`bc4d6ef3fe829f082fa966f898ebfbd1e11102cb`** in `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.
- First parent / prior privacy checkpoint **`bbdc942f390aed479370983efe85c2e507aa17df`**.
- Second parent / merged main **`866abeccd64ed22a23d386cbdc534000cde91c3b`**.
- Read full combined/remerge changes, first-parent production changes, relevant tests and direct dependencies, repository CLAUDE.md and the earlier reviewed privacy authority constraints. `git show --remerge-diff` identifies conflicts in CHANGELOG.md, `src/runtime/glirastes.ts` and `src/server/core/index.ts`; additional hand changes introduce protected result withholding and its regression test.
- The source HEAD remained the exact reviewed merge. An initially present generated test scratch directory under `examples/source-driven-next/` disappeared when the main suite cleaned up; I did not modify it. Final working tree was clean.
- GID is still installed against the older `bbdc942` tarball. This review makes **no consumer acceptance or package-release claim for bc4d6ef**.

## Result

**The reported protected raw-identity-fragment leak is fixed in the tested handler path. One new actionable Medium functional regression remains: explicit off turns with privacy infrastructure configured incorrectly withhold oversized results.** No other actionable finding was established in this bounded review.

### F1 — Medium / P2: configured off turns use protected withholding instead of normal compaction

Exact location at the reviewed SHA:

- `src/server/adapters/nextjs/create-ai-chat-handler.ts:1702`
- Sink: `src/server/core/index.ts:1105–1111`
- Policy distinction already computed at `create-ai-chat-handler.ts:1409–1463` and opening a protected turn at `:1469–1480`.

The new `protectedResults:true` flag is selected with `privacy ? ...`, which tests whether the handler has privacy infrastructure configured. It does not test the effective policy of this turn. Managed consumers such as GID retain their shield/registry configuration when the Platform authorizes explicit `off`; with `privacy.policy.required:false`, the policy merger correctly leaves those turns unprotected. Nevertheless every successful tool result larger than the configured bound is now replaced entirely with `outputWithheld` and a message claiming it exceeded the protected result limit.

This contradicts the stated change behavior (“Ordinary off-profile result compaction remains available”, CHANGELOG.md) and causes ordinary large task/query results to become unavailable after an authorized off change. This is a functional overblocking regression, not a raw-data privacy bypass. Removing the consumer's configured privacy infrastructure is not an appropriate workaround for a signed per-environment policy choice.

Independent actual provider HTTP reproduction:

1. Use `createAiChatHandler` with the real OpenAI adapter and synthetic fetch responses; a valid managed snapshot fixture has `{schemaVersion:1, profile:'off'}` and a permitted `list_tasks` tool.
2. Keep `privacy:{shield:memoryShield(), scope, knownIdentities, policy:{required:false}}` configured, as a managed consumer normally does.
3. Set `maxResultChars:1000`; the tool returns `{success:true,description:'ConfidentialIdentityPrefix' + 'x'.repeat(5000)}`.
4. The tool executes exactly once, the adapter makes both expected HTTP requests, but the second request contains only:

```json
{"success":true,"outputWithheld":true,"message":"The tool ran, but its result exceeds the protected result limit. Details were withheld. Do not repeat a write; narrow a read request instead."}
```

5. The otherwise equivalent unconfigured off case retains ordinary `_truncated` content; the protected case correctly withholds it. The configured-off case fails the expected compaction assertion.

Reproduction source: `/tmp/privacy-sdk-bc4-review/transport.test.ts`; final diagnostic log: `/tmp/privacy-sdk-bc4-review/transport.log`. Result: **one expected-behavior failure, two passing comparison cases**, 14 imported snapshot tests deliberately deselected. The initial managed fixture used an unoffered name; I corrected it to the manifest's `list_tasks` before recording this finding. The final failure occurs after successful tool execution and is caused by actual output withholding, not the fixture authorization guard.

The test injects the managed snapshot at the documented handler seam; it does not independently verify a cryptographic sync transaction. That is sufficient to isolate this branch, whose effective off policy is already resolved upstream.

Suggested correction: derive `protectedResults` from this turn's effective protected state (for example the initialized `privacyTurn`/effective policy), while retaining any desired content-free error behavior for a configured handler. Regression matrix: no privacy configuration; explicit off plus `required:false`; explicit off plus a stricter local required policy; signed protected. Require ordinary compaction only for the genuinely off cases and complete withholding for protected cases. Keep the actual provider-body and visible-result assertions.

## Reported raw-fragment leak and additional probes

The original issue arises when main's new general compactor clips a raw known identity before the privacy identity matcher sees it. `toolToAiTool` now compares the complete cleaned serialization with the selected limit and, for protected results, substitutes a constant successful withholding result before any compaction. Thus the matcher never receives a partial identity created by this new size limit.

I read the coordinator's red/green artifacts (`/tmp/privacy-result-limit-red.log`, `/tmp/privacy-result-limit-green.log`) as prior evidence, and independently reran the committed regression. I also added seven actual HTTP transport cases:

- Oversized root array.
- Oversized nested identity value.
- Sensitive oversized object key.
- Oversized `uiAction` payload.
- POST/write result.
- Serialization exactly equal to the limit.
- A per-tool override large enough to admit the complete result despite a smaller global limit.

All seven passed. Oversized protected cases expose only the constant visible `outputWithheld` notice, no raw identity prefix and no retry instruction. Equal-limit and per-tool-override cases remain protected without unnecessary withholding/compaction. Each tool executes once. These tests exercise the real adapter's serialized HTTP requests with synthetic replies and in-memory mapping, not a live provider.

The configured-off finding is not hidden by the committed regression's off case: that case removes `privacy` entirely, so it never covers the managed-consumer shape above.

## Write receipts and merge preservation

The oversized-success result retains `success:true`; `wrapToolsForPrivacy` completes its receipt before the next model call. I added both an in-memory receipt probe and a **real PostgreSQL** probe: run an oversized successful POST result through `toolToAiTool` and the actual privacy tool boundary, then reconstruct the wrapper with the same approval identity and a second runtime-store handle. The first result is withheld/completed, the retry returns `{success:true,replayed:true}`, and the underlying write count remains one. The PG probe creates/drops only its own `privacy_sdk_review_<random>` database on loopback; mapping is in memory and receipts are PostgreSQL. It is not a process-crash or concurrent-delivery proof.

Conflict preservation checks:

- `CreateGlirastesOptions.privacy` and durable `stateStore` remain alongside the newly merged `maxResultChars`; `createGlirastes` gains only result-limit validation/forwarding relative to the privacy parent.
- The core retains `contentFreeErrors` and the outcome-unknown imports/handling, while adding result bounds. Cleaned output-schema failures still report a successful withholding outcome rather than claiming the write failed. The receipt path was not replaced by a raw result cache.
- The complete `src/sync`, `src/contracts`, `src/server/pii-shield`, `src/runtime/managed-turn.ts` and `src/runtime/postgres-store.ts` trees/files have **no diff against bbdc942**. Durable floor/bootstrap/high-water logic, provider/routing binding, model gates, revocation and receipt ownership implementation are preserved byte-for-byte in those paths.
- The handler first-parent diff adds only result-limit import/destructuring/assertion/forwarding and the reviewed `protectedResults` flag. Existing protected-memory live gates and restrictions, model-dispatch revocation checks and privacy configuration validation are retained.
- Runtime-service configuration adds a bounded result size; it does not add privacy capability support or weaken the previously documented container restrictions.

These facts and the focused regressions support preservation of the prior privacy behavior apart from F1. They are not a new exhaustive review of every unchanged privacy implementation.

## CLI/config implications

The CLI pairing/environment work is inherited from main without a manual CLI merge resolution. I traced secret-target selection (`--dotenv`, tools config, Next default, process-only), preflight path/Git checks, private staging and rollback, process/file credential precedence and connection-descriptor scope validation. The custom dotenv setting stays local and is not promoted into provider configuration or signed privacy authority. Pairing does not write the runtime's accepted-state/floor store or create a bypass of its verified-bootstrap gate.

Result limits propagate from sibling/OpenAPI contracts through local tool-contract artifacts and generated definitions, with integer range validation (1,000–200,000), explicit precedence and invalid-extension diagnostics. No new provider endpoint/model/routing mutation is introduced by this option. CLI/config/runtime focused tests passed; no new actionable secret-path or merge-specific CLI defect was established. This is not an exhaustive hostile-local-process race audit or real hosted pairing exercise.

## Independent executions

All commands below were reviewer-owned, run from the exact SDK checkout **after** the main full-gate completion appeared in the log and was confirmed by the coordinator. No full heavy suite was run concurrently or repeated.

```sh
git rev-parse HEAD
git status --short
git show --no-patch --format=raw bc4d6ef3fe829f082fa966f898ebfbd1e11102cb
git show --format= --cc bc4d6ef3fe829f082fa966f898ebfbd1e11102cb -- src
git show --format= --remerge-diff bc4d6ef3fe829f082fa966f898ebfbd1e11102cb
git diff bbdc942f390aed479370983efe85c2e507aa17df bc4d6ef3fe829f082fa966f898ebfbd1e11102cb -- src
git diff --check bbdc942 bc4d6ef
# Scoped diff/rg/cat/sed/nl reads of the source and direct dependencies above.

./node_modules/.bin/vitest run src/server/adapters/nextjs/__tests__/privacy-result-limit.test.ts src/server/adapters/nextjs/__tests__/tool-result-limit.test.ts src/server/core/truncate-tool-result.test.ts src/server/adapters/nextjs/__tests__/privacy-policy-handler.test.ts src/server/pii-shield/__tests__/tool-boundary.test.ts --maxWorkers=1 --no-file-parallelism

./node_modules/.bin/vitest run src/cli/commands/connect.test.ts src/cli/commands/connection-environment.test.ts src/cli/commands/sync.test.ts src/cli/commands/doctor.test.ts src/cli/dotenv-flag.test.ts src/runtime/__tests__/glirastes.test.ts --maxWorkers=1 --no-file-parallelism

./node_modules/.bin/vitest run --config /tmp/privacy-sdk-bc4-review/vitest.config.ts -t 'review ' --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/vitest run --config /tmp/privacy-sdk-bc4-review/vitest.config.ts edges.test.ts --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/vitest run --config /tmp/privacy-sdk-bc4-review/vitest.config.ts receipts.test.ts --maxWorkers=1 --no-file-parallelism
GLIRASTES_TEST_POSTGRES_URL=postgres://pii@127.0.0.1:55432/pii_stage1_test GLIRASTES_REQUIRE_POSTGRES=1 ./node_modules/.bin/vitest run --config /tmp/privacy-sdk-bc4-review/vitest.config.ts receipts.test.ts --maxWorkers=1 --no-file-parallelism
```

| Reviewer run | Result | Log |
| --- | --- | --- |
| Committed result/privacy/tool-boundary suites | 81 passed, 1 PG case skipped (URL not set for that run), 5 files, exit 0 | `/tmp/privacy-sdk-bc4-review-focused.log` |
| CLI/config/embedded-runtime suites | 212 passed, 6 files, no skips, exit 0 | `/tmp/privacy-sdk-bc4-review-cli-runtime.log` |
| Three-way actual HTTP comparison | 2 passed, 1 failed exposing F1, 14 imported tests deselected, exit 1 | `/tmp/privacy-sdk-bc4-review/transport.log` |
| Added protected HTTP edge cases | 7 passed, no skips, exit 0 | `/tmp/privacy-sdk-bc4-review/edges.log` |
| Initial in-memory write receipt probe | 1 passed, exit 0 | `/tmp/privacy-sdk-bc4-review/receipts.log` |
| Final in-memory + isolated real-PG receipt probes | 2 passed, no skips, exit 0 | `/tmp/privacy-sdk-bc4-review/receipts-pg.log` |

Scratch source/config: `/tmp/privacy-sdk-bc4-review/{transport,edges,receipts}.test.ts` and `vitest.config.ts`. Source imports resolve to the reviewed checkout, dependencies via a symlink to its installed node_modules. The `transport` filtered run occurred before the other scratch files were added; the final file-specific rerun command for that finding is `vitest run --config /tmp/privacy-sdk-bc4-review/vitest.config.ts transport.test.ts -t 'review ' --maxWorkers=1 --no-file-parallelism`.

## Attribution and limits

Coordinator-owned evidence, **not my runs**: reported red leak reproduction; 58-test green gate; build/typechecks; 56 egress sites / zero violations; full required-PG gate **4,988 passed / 11 existing skips, 366 files passed / 2 skipped**, exit 0, `/tmp/privacy-sdk-main-integration-full.log`. I inspected the final full-gate summary only and did not reattribute it as independent testing.

No implementation changed, no consumer tarball was replaced, no live provider or remote Platform was called, and no shared/application/production database was touched. The PG probe used one disposable reviewer-owned database and cleaned it up. I did not repeat the complete signed-sync, concurrency, crash/restore or deployed acceptance matrices; unchanged-source checks and targeted runtime/handler tests are the evidence for those merge-preservation conclusions. Separate GID adoption, common cross-repo acceptance on the new artifact, actual STT qualification, deployed browser/tool/provider acceptance and release delivery remain open.
