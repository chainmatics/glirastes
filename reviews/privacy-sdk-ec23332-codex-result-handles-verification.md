# Independent Codex verification — result-reader fixes

Reviewer: **Codex**, not Opus. Date: 2026-11-17. Read-only review; no implementation edits, commits, subagents, installation, full-suite run, database operation or consumer-artifact replacement.

## Immutable scope and disposition

Fix: **`ec233325d97ba51606ace32a55b4b252ec9f62d9`**.
Baseline: **`396dc67bbeb67c94ba9606ef04dc7852454ac341`**.
Checkout: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.
Original report: `/tmp/privacy-sdk-396dc67-codex-result-handles-review.md`, also archived in this fix.

**Original High F1 and Medium F2 are fixed within the reviewed/tested boundary. No new actionable finding identified.** The unchanged original scratch reproductions all pass, as do the relevant committed suites and eight further independent edge cases. This settles these source findings, not full consumer or release acceptance.

The complete exact-range diff was inspected: provenance helper, core conversion, standalone reader ownership checks, exported privacy wrapper, copied-reader transport tests, new boundary/owner regressions, acceptance documentation and archived report. Direct dependencies examined include the result store's owner capture, managed reader budget/authorization hooks and existing cancellation behavior. HEAD remained the requested fix during verification. Temporary untracked source-driven example directories from concurrent main-owned tests were observed and left untouched.

## F1 disposition — protected reader bypasses

At `src/server/core/result-reader.ts`, the reader now carries an enumerable symbol and its execute function is registered in a WeakSet. Core conversion preserves provenance on the converted tool and its execute function. Ordinary object copies retain the symbol, and function-only adapters retain recognizable execution identity. This closes the previously reproduced copied/renamed-reader bypass.

`src/server/pii-shield/tool-boundary.ts` now refuses recognized readers before rehydration, receipt handling and execution. Reader approval callbacks are disabled on the protected wrapper. The live `beforeExecute` policy hook still runs before this refusal, preserving revocation precedence. This closes the previously reproduced direct and ordinary-core-converted reader bypass through the exported boundary.

Independently reran the original immutable scratch files without changing their assertions or source:

- Copied-reader Next handler serialized transport: current, foreign-owner, expired-mapping-generation and deleted-store cases all pass refusal assertions, with zero synthetic identifying prefixes on captured provider requests and no reader execution.
- Exported boundary: direct reader and ordinary converted reader no longer leak clipped identity fragments. Positive controls for explicit core protection and ordinary full-result protection still pass.

This does **not** implement protected retrieval. The tested outcome is the explicit `privacy_result_handles_unsupported` result. Provenance covers supported ordinary copies/conversion and retained functions; this review does not claim to identify arbitrary opaque user-written closures that deliberately discard all reader metadata and replace its execute function. Consumer executable code remains trusted.

## F2 disposition — standalone owner checks

`src/server/core/read-result-tool.ts` now compares the handle owner against a freshly captured current owner both before and after the asynchronous read guard. Missing/throwing owner resolution refuses with a fixed denial. The same handle must remain present immediately before synchronous projection; deletion during an await cannot revive an old reference.

The original standalone probes now reject changed subject, changed tenant and absent owner while preserving matching-owner success. Committed tests also cover owner changes, owner lookup failure and deletion inside the guard. The managed handler's existing authorization/budget logic remains additional enforcement, not the only source of owner isolation.

Additional independent probes confirmed deletion while the owner callback itself is waiting returns result_expired, and an initial owner denial invokes failedRead once and honors budget_exhausted without running beforeRead/afterRead. The core bridge continues to reject an already-aborted execution before owner lookup or projection. No claim is made that this change creates new cancellation semantics for arbitrary user-supplied asynchronous guard code.

## Independent tests and commands

```sh
git rev-parse ec23332 HEAD
git diff --stat 396dc67 ec23332
git diff 396dc67 ec23332 -- src/server/core src/server/pii-shield/tool-boundary.ts
git diff 396dc67 ec23332 -- src/server/adapters/nextjs/__tests__/privacy-result-limit.test.ts docs/privacy-stage1-acceptance.md
bunx --no-install vitest run --config /tmp/privacy-sdk-396dc67-review/vitest.config.mjs > /tmp/privacy-sdk-ec23332-original-repros.log 2>&1
bunx --no-install vitest run src/server/adapters/nextjs/__tests__/privacy-result-limit.test.ts src/server/core/privacy-result-handles.test.ts src/server/core/__tests__/privacy-reader-boundary.test.ts src/server/core/__tests__/result-reader-owner.test.ts src/server/adapters/nextjs/__tests__/result-handles-handler.test.ts src/server/core/result-handles.test.ts > /tmp/privacy-sdk-ec23332-focused.log 2>&1
bunx --no-install vitest run --config /tmp/privacy-sdk-ec23332-review/vitest.config.mjs > /tmp/privacy-sdk-ec23332-review/edges.log 2>&1
git diff --check 396dc67 ec23332
shasum -a 256 src/server/core/result-reader.ts src/server/core/read-result-tool.ts src/server/core/index.ts src/server/pii-shield/tool-boundary.ts
```

Results, all independently run:

| Run | Result | Duration |
| --- | --- | --- |
| Unchanged original reviewer reproductions | 12 passed / 3 files, exit 0 | 1.44 s |
| Committed focused suites | 210 passed / 6 files, exit 0 | 2.33 s |
| Added independent edges | 8 passed / 1 file, exit 0 | 817 ms |
| Exact-range whitespace check | passed | — |

Counts overlap in behavioral coverage and include imported fixture tests; they are not 230 distinct transport integrations. No database-dependent full suite was run. The HTTP probes use real provider adapter serialization with controlled synthetic fetch responses, not a live provider.

New scratch artifact: `/tmp/privacy-sdk-ec23332-review/edges.test.ts`, with config and log adjacent. Its eight cases cover:

1. Spread copy with a bound execute function retains symbol provenance and refuses before side effects.
2. Object.assign copy retains provenance and refuses before side effects.
3. Execute-only adapter after core conversion remains recognizable.
4. A second core conversion preserves provenance.
5. Live gate refusal still takes precedence over unsupported-reader refusal.
6. Already-aborted core execution performs no owner read.
7. Store deletion during an awaited owner lookup refuses before projection.
8. Owner-denial budget accounting calls failedRead once and honors exhausted budget.

For the first four, approval callback, beforeRead, input rehydration, receipt claim and completion spies remain uncalled; beforeExecute runs exactly once.

## Exact source hashes (SHA-256)

- `src/server/core/result-reader.ts`: `50f7c6f0d30e46c2148b66b45f4c672a7e5fdc3e8bcc27a1ae1a095d2c8d9ad9`.
- `src/server/core/read-result-tool.ts`: `9f91ee418652967127a3d71e87fabebe23b1b277c403ad994f47c4be8bdc0343`.
- `src/server/core/index.ts`: `b245088ad4ca2c9afafb2b54c6e31bca77b3a73a1bdd77209070f746c7b9c8ad`.
- `src/server/pii-shield/tool-boundary.ts`: `5b33341d47de68fb853f6fd147bf08683bb20cf6143f6712b14c333ca5f7fa7a`.

## Limits and remaining delivery gates

Main-owned builds/typechecks/full required-PostgreSQL gates are not attributed to this reviewer. The earlier 396dc67 GID artifact's successful consumer suite does not establish acceptance of ec23332. A new exact fixed archive, installed-byte/integrity verification, consumer acceptance and any necessary common integration rerun remain separate work. No unpublished package was replaced by this reviewer.

This report does not repeat the broader durable authority, PostgreSQL concurrency, provider qualification or deployment audit. Published-package reconciliation/clean installation, release authorization and live target acceptance remain separate gates. Both original findings are resolved at this source SHA; no Stage 1 completion claim is made.
