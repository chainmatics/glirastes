# Independent Codex checkpoint review — operator privacy and memory merge

Date: 2026-11-17. Reviewer: **Codex**, this dispatched Codex worker, session `9273167d-83d6-417a-9cf9-e73e46251f59`; **not Opus**. No subagents and no implementation edits.

## Immutable scope

- Platform reviewed SHA: **386822ed0d6c47cd325e95065cf984597fec49e2**; base **57fa9c4da009dfee96fc8247a4f92d905550654e**.
- Platform workspace: `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/piwo96-privacy-policy`.
- SDK reviewed merge SHA: **17f6a29d8fdf9b419efb7284a7e1cf4952a6078b**; first parent **7d34824e0765bd12e1039e2201aab96eafb3a68e**, second parent **a6015c3a0d18abd04f769768c1efb1bc4cd76c3a**.
- SDK workspace: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.
- Both HEADs matched those SHAs and both worktrees were clean at initial and final verification. All scratch files are under `/tmp`.
- Authority: both CLAUDE.md files, Platform `docs/runbooks/privacy-authority.md`, authoritative plan sections 15–16 and coordinator review under `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/piwo96-pii-production-plan/docs/plans/`.

## Verdict

**Two actionable findings: one HIGH SDK live-revocation bypass affecting the new memory paths, and one MEDIUM Platform false-positive application status.** The protected-memory startup gate itself works; these findings do not claim that memory is supported in the protected profile. This checkpoint is not final Stage 1 acceptance.

### F1 — HIGH — New memory operations bypass the live managed privacy gate

Locations at SDK SHA above:

- `src/server/adapters/nextjs/chat-memory.ts:611–617`: the summary loop calls `generateText` directly for every chunk, without a live permission/revocation callback.
- `src/server/adapters/nextjs/create-ai-chat-handler.ts:1531–1543`: memory preparation receives messages/model/abort/legacy anonymization hooks, but no `beforeModelStep` or managed privacy gate.
- `src/server/adapters/nextjs/create-ai-chat-handler.ts:1817–1818` and `2149–2153`: memory tools are included in handler built-ins. The existing built-in branch at `590–591` wraps them without the managed `beforeToolCall` hook. The added note writes/removals in `chat-memory.ts:432–443` / `472–475` consequently do not recheck the live gate.

Scenario: an authenticated managed turn starts with a valid, unrevoked signed `off` policy, so memory is legitimately enabled and its historical messages are raw. A revocation of that pinned policy is loaded, or the live runtime becomes blocked, while an asynchronous memory hook/model response is pending. The next normal chat model step calls `beforeModelStep` and refuses; the independent summary call can nevertheless send the history to its model, and a returned `memory_remember` call can still write a note. Multiple summary chunks likewise have no revocation check between calls. Excluding memory from `protected-text/v1` does not authorize continuing a revoked `off` turn: the K2 rule also revokes permission to operate unprotected.

Independent executable evidence: `/tmp/privacy-memory-17-review/memory.test.ts:429` and `:460`.

1. Use the real handler and `createTurnSnapshot` with a pinned off policy and a mutable `managedRuntime.privacyGate`. At the asynchronous `memory.scope` boundary, mark the policy revoked; the same gate subsequently throws `PrivacyError('privacy_policy_revoked')`. The real summary generation path dispatches `alice@example.com`, while the main chat model records **zero** dispatches and the live gate is called again and refuses.
2. Permit the initial model step, then mark the policy revoked while the mock model returns `memory_remember`. The real built-in execution writes `Confidential alice@example.com` into the user store after revocation.

Both probes pass when asserting the defective behavior. They use a mock provider and a deterministic live-gate transition, not a real provider or signed HTTP revocation transport; the defect is the missing callback invocation after the real handler has installed that callback. The preexisting signed sync/revocation mechanism is not replaced or disproved by the probe.

Proposed correction/regression: give memory an authorization hook invoked immediately before **each** summary dispatch (also after asynchronous prompt preparation and on retries as needed) and before each memory tool side effect. Built-in exemption from manifest-tool authorization must not exempt a memory operation from the turn's live privacy gate. Add regressions with a signed-off managed turn, load its revocation between memory initialization and generation, between summary chunks, and between model output and note write/delete; expect no subsequent egress or storage mutation. Keep the protected-memory zero-dispatch refusal and memory:false replay tests.

### F2 — MEDIUM — A refused off report can still produce applied:true and a green environment aggregate

Locations at Platform SHA above:

- `apps/api/src/modules/runtime-connections/privacy-health.ts:15`: every non-protected policy returns ready:true regardless of the parsed report's state.
- `apps/api/src/modules/runtime-connections/drizzle-runtime-connection.store.ts:150–175`: a bound refused report combined with top-level healthy retains healthy deployment state and produces an application receipt.
- `apps/api/src/modules/runtime-setup-v2/privacy-status.service.ts:39–44,50–55`: the off branch does not require a successful report state for `applied`; refusal only changes the separate `state` string, while the aggregate trusts `appliedCount`.

Scenario: an authenticated runner reports the exact current off policy/digest and active deployment, but `technicalMetadata.privacy.state` is `refused`, e.g. `reasons:['policy_revoked']`, while top-level `health` is healthy. Platform accepts both claims. The public status result is internally contradictory:

```json
{"requestedProfile":"off","runtimeApplication":"reported","runners":[{"state":"refused","applied":true}]}
```

Independent migrated-PGlite reproduction: `/tmp/privacy-operator-386-review/authority.spec.ts:191`. It publishes a current off policy, creates an active deployment, registers a capable runner, submits that heartbeat through the real connection store, and reads the real status service. It reproduces exactly the values above. This is a functional evidence-validation/false-green bug, not a demonstrated protected-profile egress bypass or cross-tenant attack. The current SDK normally submits top-level unhealthy with a refused report; the repro intentionally tests contradictory but schema-valid authenticated runner evidence, which the new server-side validation is supposed to reconcile.

Proposed correction/regression: refusal/downgrade/unavailable states must make `applied` false independently of requested profile and aggregate consistently. A legitimate off report may be `off`, or `enforced` with an effective digest when local policy tightens it. Test both successful cases and all refusal states with matching IDs/digests and a healthy outer heartbeat; none of the latter may become applied/reported. Reconcile heartbeat readiness with this rule as well.

## Verified behavior and scope of inspection

- Inspected the full Platform source diff and new tests, draft controller/store CAS and scope checks, provider inventory selection and direct publication validation, configuration/prompt/tool carrying, activation and heartbeat processing, applied status service, and adjacent publication/derivation/apply paths.
- Draft writes serialize on the scoped app row and compare the saved digest; authoritative policy publication continues to serialize on the environment row and protect against unauthorized loosening. Provider approvals compare both entry ID and binding digest; configuration publication also constrains the report by discovery digest. No additional reproducible cross-scope, ordinary stale-target or downgrade-approval defect was established in this review.
- Checked the SDK first-parent diff and `git show --remerge-diff`. Conflict resolution retains protected ID-label handling, establishes the managed snapshot/privacy history before memory initialization, and refuses enabled effective-protected memory before note scope/store/model work. `memory:false` does not consume browser notes or unbound summary replay. New summary generation is correctly inventoried as unsupported for protected turns, but F1 concerns live revocation of initially permitted off turns.
- Inspected new memory summary, note tool/store and browser transport paths; no embeddings or retrieval egress was found in the added runtime files.
- SDK vector SHA256 independently recomputed: **b24876515741a6c14786ea7abd6de2a5236286c9504a1964b18370c61a7159e4**, matching the requested immutable vector hash.

## Commands and observed results

Read-only exploration used `git rev-parse`, `git status --short/--porcelain`, `git diff --stat/--name-only`, `git diff 57fa9c4..386822ed` (Platform), `git diff 7d34824..17f6a29` (SDK), `git show --remerge-diff 17f6a29`, and focused `rg`, `sed`, `cat`, `nl -ba` source/test/document reads. A few searches used nonexistent paths or a wrong repo revision, returned errors, and were rerun with the correct paths; those failed lookups supplied no verification evidence.

I first performed static review only. Before starting any test process I read `tail -8 /tmp/privacy-17f6a29-full.log` once and observed its completed summary: **362 files passed, 2 skipped; 4,829 tests passed, 11 skipped; duration 215.21s**. This is the main worker's full isolated PG run, not a run performed by this reviewer. I did not poll or rerun the full suite.

From Platform `apps/api`:

```sh
bunx vitest run --config /tmp/privacy-operator-386-review/vitest.config.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run src/modules/runtime-revisions/__tests__/privacy-settings.pglite.spec.ts src/modules/runtime-revisions/__tests__/privacy-authority.pglite.spec.ts src/modules/runtime-setup-v2/__tests__/privacy-providers.spec.ts src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts src/modules/runtime-setup-v2/__tests__/tool-policy-revision.service.spec.ts --maxWorkers=1 --no-file-parallelism
```

Results: **15/15** scratch tests (14 repository authority tests plus F2); **56/56** focused repository tests. Logs: `/tmp/privacy-operator-386-review/results.log`, `/tmp/privacy-operator-386-review/focused.log`.

From SDK root:

```sh
bunx vitest run --config /tmp/privacy-memory-17-review/vitest.config.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run src/server/adapters/nextjs/__tests__/privacy-handler.test.ts src/server/adapters/nextjs/__tests__/chat-memory.test.ts src/sync/__tests__/managed-sync.test.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run src/server/pii-shield/__tests__/provider-conformance.test.ts src/contracts/__tests__/privacy-policy-vectors.test.ts src/server/pii-shield/__tests__/egress-inventory.test.ts --maxWorkers=1 --no-file-parallelism
shasum -a 256 src/contracts/__vectors__/privacy-policy.v1.json
```

Results: final scratch run **36/36** (memory tests, imported turn-snapshot fixture tests, and the two F1 probes); focused repository run **49/49**; provider capture/contract/inventory run **203/203**. Scratch initially ran 35/35 with only the first F1 probe, then 36/36 after adding its tool-side counterpart. Logs: `/tmp/privacy-memory-17-review/results.log`, `focused.log`, `capture-contract.log`. Probes intentionally assert current bad behavior; their passing is evidence of findings, not fix acceptance.

Scratch test modules copy existing fixtures with absolute source imports, reference the original dependency directories via symlinks, and add only the stated independent probes. Configurations are alongside them under `/tmp`. No tracked source/test/configuration files were modified.

## Verification limits

- Platform DB execution is local migrated **PGlite**, with fake signature strings in the store fixture; no live database migration or real PostgreSQL multi-session contention test was performed. The new activation readiness read is not a proof of serializability against concurrent heartbeat/registration changes. Publication/apply versus draft-save races also lack a real multi-session proof here; no speculative race is promoted to a validated additional finding.
- SDK providers are mocks or HTTP capture fixtures, not production model providers. The independent revocation probes use a deterministic live gate, as described above. The full PG result is attributed to the main-owned log only. Reviewer did not repeat build or typecheck commands; supplied build/typecheck evidence is not relabeled as independent execution.
- One registered runner per environment is the current schema constraint. No multi-runner production acceptance is claimed.
- Metrics/event ingestion/retention, UI, GID, STT integration and deployed acceptance remain explicit pending scope, not unexpected defects reported here.
- No remote deployment, release, migration, approval, or final Stage 1 acceptance was performed.
