# Independent Codex fix verification and privacy metrics review

Date: 2026-11-17. Actual reviewer: **Codex**, dispatched session `9273167d-83d6-417a-9cf9-e73e46251f59`; not Opus. No subagents, implementation edits, shared migrations or deployment actions.

## Immutable reviewed scope

- SDK: **49107d730aad050676360c7467bdc0801e1ad2fc**, compared with **17f6a29d8fdf9b419efb7284a7e1cf4952a6078b**; `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.
- Platform: **808c7ab03194a92356db2ce6fef1fbc63a06186b**, compared with **386822ed0d6c47cd325e95065cf984597fec49e2**; `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/piwo96-privacy-policy`.
- Original report: `/tmp/privacy-operator-386822e-memory-17f6a29-codex-review.md`.
- Both HEADs matched these exact SHAs and both worktrees were clean before and after review. Scratch artifacts are outside repositories under `/tmp/privacy-491-fix-sdk` and `/tmp/privacy-808-fix-platform`.
- Reviewed the full source/test diffs, original findings/repros, current authority runbook, and K1–K6/coordinator authority requirements in the plan worktree. Applied the verify-fix assessment method, with the requested report artifact and test-only scratch files authorized by this task.

## Verdict

**Both original findings are fixed at the reviewed SHAs. No new actionable defect established in the added metrics ingestion/status/retention checkpoint.** This is a bounded source and local test review, not Citadel, GID, deployment or final Stage 1 acceptance.

```json
{
  "results": [
    {
      "id": "F1-memory-live-revocation-bypass-HIGH",
      "status": "fixed",
      "evidence": "Real handler now supplies its pinned-turn live gate to memory; original summary and note-write repros are blocked, independent scope/read/valid-alias-delete checks pass, signed-off integration prevents later summary chunks and automatic retries after a loaded signed revocation, and unrevoked signed memory still summarizes successfully."
    },
    {
      "id": "F2-refused-off-applied-status-MEDIUM",
      "status": "fixed",
      "evidence": "Shared successful-report predicate gates heartbeat readiness and applied status; original false-green repro now returns refused/applied:false, negative state matrix also rejects empty-reason reports, and both valid off and locally stricter enforced reports remain applied with separate effective digests."
    }
  ]
}
```

## F1 verification — fixed

SDK `src/server/adapters/nextjs/create-ai-chat-handler.ts:1516` passes `{beforeOperation: beforeModelStep}` to `chatMemory.begin`. This is the same live gate closed over the pinned managed snapshot, not a copied initial boolean. The outer handler now handles a `PrivacyError` even when local `privacy` infrastructure is absent (`:2345`), so a signed off turn stopped during initialization produces a clean privacy refusal.

`src/server/adapters/nextjs/chat-memory.ts:552–556` checks before and after the asynchronous scope callback. `:541–543` checks before reading each note store and again before using its result. Note add/delete execution checks at `:428` and `:474`; add's follow-up list/remove/update operations also check at `:445`, `:448`, and `:453`. There is no asynchronous application work between the initial note-operation check and the initial store mutation. The built-in manifest exemption therefore no longer bypasses the live privacy gate for these tools.

Summary model middleware at `:631–638` requires a wrappable V3 model when authorization is present and checks immediately before every provider attempt. It runs after async anonymization and on AI SDK retries. Checks after generation (`:648`) and before emitting the summary (`:658`) prevent revoked results from being published. Unsupported managed summary model representations fail closed. The earlier protected-memory startup refusal remains in place.

Independent evidence:

- Reused the two original executable repros with only their expected outcomes changed: summary provider zero dispatches and HTTP 503 after scope-time revocation; no note write after model-response-time revocation. Both pass.
- Added a preclosed-gate probe: the scope callback is never invoked.
- Added revocation during shared-store list: subsequent user-store list is not invoked, refused store contents do not become the preamble, no summary provider dispatch or summary update follows.
- Added a valid-alias delete probe. It extracts the real alias from memory's preamble; deletion is blocked while revoked, then succeeds when the gate permits. This avoids relying on an invalid tool argument to make a negative test pass.
- Added three **signed** integration cases using real `createGlirastes`, Ed25519 deployment/revocation verification, the sync loop and the real handler/memory preparation. Unrevoked off performs multiple summary chunks and emits its summary; loading the pinned off revocation after the first summary response stops subsequent chunks; a retryable provider 503 after loading that signed revocation results in only one provider attempt and no summary update. The latter cases use a custom stream handler solely to await the real prepared-memory completion, isolating summary dispatch from the primary chat model.
- Executed repository tests that cover signed off revocation during memory scope with both OpenRouter and Anthropic HTTP capture adapters: zero provider requests. Also executed memory positive paths and protected-handler refusal tests.

The independent signed retry tests use a mock language model and fake control-plane HTTP, with real signature verification. They do not contact production providers. A store operation or network request already dispatched before revocation cannot be recalled; this is the stated boundary, not a remaining bypass.

## F2 verification — fixed

Platform `apps/api/src/modules/runtime-connections/privacy-health.ts:5–7` only considers a report successful when reasons are empty and state is off, or state is enforced with an effective digest. Lines `18–21` apply this rule to off readiness as well as protected readiness. Thus a matching digest cannot override a refusal.

`apps/api/src/modules/runtime-setup-v2/privacy-status.service.ts:42–44` independently requires that successful report and rejects stored refusal before setting applied. The aggregate at `:53–58` therefore cannot count a refused runner as reported.

Independent migrated-store reproduction of the original healthy-envelope/refused-off contradiction now returns `runtimeApplication: refused` and `applied:false`. An added five-state matrix uses **empty reasons** for off/enforced/refused/awaiting-policy/downgrade-rejected, proving rejection is based on failure state rather than merely the reason array. Valid off and enforced reports pass; the enforced report carries a deliberately different effective digest, preserved in status. Repository regressions for both positive states and all three negative states also pass.

## Added Platform metrics review

No new actionable defect was established. The inspected controls and evidence are:

- **Authentication/scope:** controller `runtime-metrics-ingest.controller.ts:46–52` invokes the existing runtime environment authorization before dispatch. The privacy service additionally requires an API-key credential and matching tenant/app, validates each event's app/environment, derives runner identity from the scoped registered runner row, rejects mismatching runner claims, and requires explicit capability v1 (`privacy-metrics.service.ts:22–43`). Trust is the authorized runtime credential, not remote attestation. Controller/credential authorization was traced statically; service/controller tests exercise accepted/rejected scope paths with mocked authentication collaborators.
- **Strict content-free contract:** `privacy-decision-event.schema.ts` rejects unknown fields/codes, duplicate decision codes, inconsistent null policy/digest, bad/oversized windows, excessive counts, and credential-shaped labels. Batches are limited to 50. Service bounds event/window age and future skew before reserving quota (`:24–33`). Fourteen pinned SDK event vectors pass. SDK and Platform policy vector files both hash to `b24876515741a6c14786ea7abd6de2a5236286c9504a1964b18370c61a7159e4`.
- **Policy binding:** non-null policy IDs must resolve to a published revision within the authenticated tenant/app/environment and its privacy block must hash to the submitted digest (`privacy-metrics.service.ts:61–69`). Historical pinned policy telemetry is allowed and is marked noncurrent by status; null local-only identity cannot establish Platform application.
- **Idempotency/order/atomicity:** ingestion locks the scoped runner row, sorts each instance's windows by sequence, compares stored event projections for exact duplicate retries, rejects altered retries and reused/older sequence numbers, and commits an entire batch atomically (`:37–75`). Build ID and occurredAt are validated but deliberately not persisted/deduplicated, as documented. Independent tests cover reverse-ordered valid input, exact retry after a higher sequence, and an inserted-then-conflicting same-sequence batch that rolls back completely.
- **Quota:** schema/scope/time rejection precedes quota reservation; transaction rejection releases the full reservation, exact duplicates release unused quota (`:76–80`). Both repository and independent rollback probes check the release count. Redis service availability/recovery itself was not fault-injected.
- **Wire compatibility:** SDK sink keeps a separate queue per event type (`src/runtime/metrics/sink.ts:120` onward), so the endpoint's homogeneous privacy batch requirement matches the SDK. Independently generated SDK wire batches containing one turn event and one privacy window were separated into two requests; replaying those bodies through the real Platform controller/privacy service accepted the privacy window. Only scope IDs were rebound to the isolated fixture, the outer authentication collaborator and normal turn service were mocked. This is wire/service compatibility evidence, not a live HTTP deployment test.
- **Retention:** the existing scheduled daily prune job calls privacy prune; the service deletes on server receive time after 90 days (`privacy-metrics.service.ts:84–85`). `RuntimeMetricsModule` provides the service and worker together; worker/job/module regressions execute. No live Bull/Redis scheduled job was claimed.
- **Status:** five-minute received turn traffic, two-minute privacy-window freshness, missing telemetry, authority match, and runtime application are separate fields. Independent tests show current matching telemetry does not make an unapplied runner reported; after authority advances it becomes `currentPolicy:false` even with the same privacy digest. No observed traffic remains `none-reported`, not an assertion of no traffic. Stale/missing telemetry regressions pass. Five-minute future clock tolerance is intentionally accepted at ingest.

## Independent real PostgreSQL evidence

I inspected `apps/api/src/common/__tests__/isolated-postgres.ts` before running it. It requires explicit loopback test URL, creates a fresh `privacy_platform_test_<uuid>` database, applies the committed migration chain, and drops only that owned database on cleanup. It does not fall back to application DATABASE_URL. The task-authorized URL was used exactly.

From Platform `apps/api`:

```sh
GLIRASTES_TEST_POSTGRES_URL=postgres://pii@127.0.0.1:55432/pii_stage1_test GLIRASTES_REQUIRE_POSTGRES=1 bunx vitest run src/modules/runtime-revisions/__tests__/privacy-concurrency.postgres.spec.ts --maxWorkers=1 --no-file-parallelism
```

**Reviewer-run result: 3 passed, 0 skipped, exit 0.** Log `/tmp/privacy-808-review-postgres.log` (17:53:49; duration 1.17s). The helper holds a row lock and requires PostgreSQL `pg_stat_activity` to report both competing sessions waiting before release. Tests cover draft CAS, monotone authority publication against older off, and concurrent identical-event deduplication/changed retry. This is real PostgreSQL multi-session overlap evidence, not PGlite scheduling. The API test dependency is pinned to postgres 3.4.9, matching the existing resolved lock entry.

## Other commands/results performed by this reviewer

Source examination: `git rev-parse HEAD`, `git status --short/--porcelain`, `git diff --stat/--name-only`, full `git diff 17f6a29..49107d7` / `git diff 386822ed..808c7ab`, targeted `rg`, `cat`, `sed`, `nl -ba`, and `git diff --check` for each reviewed range. Both diff checks passed. Some exploratory nonexistent-path/wrong-repo lookups failed and were corrected; they are not verification evidence.

SDK root:

```sh
bunx vitest run src/server/adapters/nextjs/__tests__/chat-memory.test.ts src/server/adapters/nextjs/__tests__/privacy-handler.test.ts src/runtime/__tests__/glirastes.test.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run --config /tmp/privacy-491-fix-sdk/vitest.config.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run --config /tmp/privacy-491-fix-sdk/vitest.config.ts wire.test.ts --maxWorkers=1 --no-file-parallelism
shasum -a 256 src/contracts/__vectors__/privacy-policy.v1.json
```

Results: **119/119** repository tests; **99/99** scratch tests at that run (copied original/repository fixtures plus independent scope/read/delete and signed summary cases); **1/1** subsequently added SDK wire-generation test. Logs `/tmp/privacy-491-review-focused.log`, `/tmp/privacy-491-fix-sdk/results.log`, `/tmp/privacy-491-fix-sdk/wire.log`. Scratch files: `memory.test.ts`, `signed.test.ts`, `wire.test.ts`, `wire.json`.

Platform `apps/api`:

```sh
bunx vitest run --config /tmp/privacy-808-fix-platform/vitest.config.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run src/modules/runtime-revisions/__tests__/privacy-authority.pglite.spec.ts src/modules/runtime-metrics/__tests__/privacy-metrics.pglite.spec.ts src/modules/runtime-metrics/__tests__/privacy-decision-vectors.spec.ts src/modules/runtime-metrics/__tests__/runtime-metrics.module.spec.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run --config /tmp/privacy-808-fix-platform/vitest.config.ts metrics.spec.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run --config /tmp/privacy-808-fix-platform/vitest.config.ts authority.spec.ts --maxWorkers=1 --no-file-parallelism
```

Results: initial original-repro copy **15/15**; repository focused tests **45/45**; final metrics scratch **11/11**; final authority scratch **20/20**. These are migrated **PGlite** tests, separately identified from real PG above. Logs under `/tmp/privacy-808-fix-platform/`: `repro-results.log`, `focused.log`, `metrics-results.log`, `authority-results.log`. Scratch modules use absolute imports of reviewed source and dependency symlinks, with no repository edits.

Harness corrections, not hidden product failures: initial independent memory assertions matched the PrivacyError message against its code, causing two assertion failures; corrected to match the actual `code` property and all passed. An attempted single-process Platform/SDK wire harness failed at collection because Platform's test Zod alias redirected SDK root-Zod imports to Zod3. Replaced it with independently generated SDK JSON and a Platform-side replay using each repository's own dependency setup; the final wire and metrics tests pass. The failed combined-harness log remains `/tmp/privacy-808-fix-platform/results.log`.

## Supplied gates and limits

I read the completed summaries in `/tmp/privacy-49107d7-full.log` (**4,850 passed, 11 skipped**) and `/tmp/platform-privacy-metrics-pg-final.log` (**146 passed, no skips shown**). Those were **main-worker runs**, not mine. Main's source/spec typechecks and skip classification are supplied evidence; I did not rerun builds, full suites or typechecks.

The real PG tests prove the three stated overlaps; they do not prove every activation/heartbeat/registration interleaving, production load, backup recovery or live authentication behavior. Store publication fixtures use fake signature strings; SDK signed tests use real Ed25519 verification. Provider transport evidence is capture/mock-based. No production models, shared database migrations, live Redis retention execution, Citadel UI, GID integration or deployed acceptance was tested. The current one-runner-per-environment schema remains the review boundary. These pending acceptance areas are not new findings.
