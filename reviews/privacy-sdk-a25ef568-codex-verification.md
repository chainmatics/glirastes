# Independent Codex fix verification — effective off result handling

Date: 2026-11-17. Actual reviewer: **Codex (OpenAI GPT-6-based agent)**, Orca worker `orca_session_id:9273167d-83d6-417a-9cf9-e73e46251f59`. Not Opus. Read-only verification; no helpers, implementation edits, commits, builds or dependency replacement. Scratch tests and this report were written only under `/tmp`.

## Immutable scope and result

- Fix reviewed: **`a25ef568c65c8260d749475cb2ae955448112e31`**.
- Base: **`bc4d6ef3fe829f082fa966f898ebfbd1e11102cb`**.
- Checkout: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.
- Original finding: **F1, Medium/P2**, archived at `reviews/privacy-sdk-bc4d6ef-codex-review.md`: configured privacy infrastructure incorrectly forced protected result withholding even on an effective off turn.

**F1 is fixed. No new actionable defect was established in this bounded verification.** The earlier protected raw-identity-fragment protection remains effective in the independently rerun transport cases. This establishes the reviewed SDK source behavior, not GID adoption, a published package or Stage 1 acceptance.

## Source verification

The full three-file diff contains the archived original review, expanded regression tests and one production change at `src/server/adapters/nextjs/create-ai-chat-handler.ts:1702–1703`:

```ts
...(privacy ? { contentFreeErrors: true } : {}),
...(privacyTurn ? { protectedResults: true } : {}),
```

Previously both flags used the existence of the `privacy` configuration. The new `protectedResults` flag follows the request's actual protected turn. `privacyTurn` is initialized locally for each request at line 1389, after the managed snapshot is pinned; it is assigned only after effective policy merge, provider/scope/mapping checks and history admission succeed at lines 1467–1480. Failed protected initialization returns a refusal before constructing tools, so an undefined turn cannot silently select ordinary compaction after a failed protected open. Explicit off with `required:false` creates no protected turn; stricter local protection over off does create one.

The shared options feed direct-command, pipeline and ordinary model-tool conversions at lines 1754, 1945 and 2206. The change does not replace live policy checks, provider binding, durable state/floor handling, approval receipts or content-free error behavior. It introduces no shared mutable protection flag across requests. All remaining production source is unchanged against the base.

The committed five-case actual HTTP matrix covers unconfigured off, configured explicit off with `required:false`, local protection stricter than off, standalone protected and signed-policy protected. Its reported 19 cases correctly include 14 imported snapshot tests; only five are new transport matrix cases. The managed-policy fixtures inject a signed-policy-shaped snapshot at the handler seam; they are not an independent cryptographic-sync test.

## Independent reproduction and adversarial checks

I copied the original failing reproduction into `/tmp/privacy-sdk-a25-review/transport.test.ts` without changing its expected compaction behavior. All three comparisons now pass: the configured-off case and unconfigured off case preserve `_truncated` content; the protected case withholds the oversized result. Tool execution remains exactly once and both expected provider HTTP requests occur. This is the same expectation that failed at bc4d6ef, not an assertion rewritten to accept the bug.

Additional or retained reviewer probes passed:

- **One configured handler, off → protected → off:** three separate requests use the current pinned snapshot and alternate ordinary compaction / complete withholding / ordinary compaction. No protected-turn flag leaks into a later off request or vice versa. This tests handler request isolation, not Platform authorization of those transitions.
- **Configured off backend error:** a thrown error containing the sensitive canary remains content-free (`tool_failed`) in the provider request. Separating the two flags did not expose exception text.
- **Seven actual HTTP edge cases:** oversized root array, nested value, object key, UI-action payload and POST/write result remain withheld with a visible notice and no raw identity prefix; serialization exactly at the limit and a larger per-tool override admit the complete result for normal privacy protection without unnecessary withholding or clipping. Each tool runs once.
- **Receipt replay:** an oversized successful write is completed, not marked failed. Reconstructing the wrapper with the same approval identity returns `replayed:true` without a second execution. This passed with in-memory receipt semantics and with the actual PostgreSQL runtime store through a second store handle.

The PostgreSQL probe uses `GLIRASTES_TEST_POSTGRES_URL` only to reach the explicitly owned loopback server, creates `privacy_sdk_review_<random>` and drops it in `finally`. It does not mutate the database named in the supplied URL. Mapping in that probe is in memory; receipts are real PostgreSQL. No claim of crash recovery or concurrent-delivery validation is made from this sequential replay check.

All provider responses are synthetic; real adapter serialization is captured before any external network request. No real provider received test content.

## Commands and reviewer-owned evidence

I first read the diff and direct dependencies and prepared scratch probes while the main gate ran. I observed its final summary before launching any tests. The later coordinator notification independently confirmed completion. No full heavy suite was run or overlapped.

```sh
git rev-parse HEAD
git status --short
git diff --stat bc4d6ef3fe829f082fa966f898ebfbd1e11102cb a25ef568c65c8260d749475cb2ae955448112e31
git diff bc4d6ef3fe829f082fa966f898ebfbd1e11102cb a25ef568c65c8260d749475cb2ae955448112e31 -- src CHANGELOG.md
git diff --check bc4d6ef a25ef568
# rg/sed reads traced privacyTurn creation, refusal paths, shared toolOptions,
# content-free errors, the committed matrix and original review/reproduction.
tail -16 /tmp/privacy-sdk-effective-off-full.log

./node_modules/.bin/vitest run src/server/adapters/nextjs/__tests__/privacy-result-limit.test.ts src/server/adapters/nextjs/__tests__/privacy-policy-handler.test.ts src/server/adapters/nextjs/__tests__/tool-result-limit.test.ts --maxWorkers=1 --no-file-parallelism

GLIRASTES_TEST_POSTGRES_URL=postgres://pii@127.0.0.1:55432/pii_stage1_test GLIRASTES_REQUIRE_POSTGRES=1 ./node_modules/.bin/vitest run --config /tmp/privacy-sdk-a25-review/vitest.config.ts --maxWorkers=1 --no-file-parallelism
```

| Independent execution | Result | Log |
| --- | --- | --- |
| Committed result-limit matrix, privacy-policy handler and tool-result-limit suites | **59 passed**, 3 files, no skips, exit 0 | `/tmp/privacy-sdk-a25-review-focused.log` |
| Original repro, transition/error probes, seven HTTP edges and two receipt probes | **56 passed**, 5 files, no skips, exit 0 | `/tmp/privacy-sdk-a25-review/independent.log` |

The scratch run's 56 includes **14 reviewer target cases plus 42 imported snapshot-fixture tests** (14 imported by each of three files). These are not 56 unique new privacy scenarios. Runnable sources are `/tmp/privacy-sdk-a25-review/transport.test.ts`, `transitions.test.ts`, `errors.test.ts`, `edges.test.ts`, `receipts.test.ts`, and `vitest.config.ts`; imports point to the exact reviewed source and existing installed dependencies.

HEAD was rechecked as a25ef568 after tests. The main suite's initial untracked fixture directories were not touched by me; they were cleaned up by that suite, and final repository status was clean. No USER feedback or consumer artifact was changed.

## Attribution and limits

Coordinator-owned, **not my executions**: original red repro `/tmp/privacy-result-limit-off-red.log`; 19-case committed matrix `/tmp/privacy-result-limit-final-matrix.log`; build/typechecks; full required-PostgreSQL gate **5,005 passed / 11 existing skips, 366 files passed / 2 skipped**, 124.08 seconds, `/tmp/privacy-sdk-effective-off-full.log`. I inspected the full gate's completion summary and do not present it as independently run.

This verifies the narrow result-selection fix and nearby privacy/write behavior. The broader SDK merge review remains the prior bc4d6ef report with F1 now resolved. No new full-suite, real signing/sync, deployed browser, live provider, STT/hardware or operational DR acceptance was performed. GID remains on its older installed tarball; adoption and common cross-repository tests on a new artifact, release pinning and deployed acceptance remain separate work.
