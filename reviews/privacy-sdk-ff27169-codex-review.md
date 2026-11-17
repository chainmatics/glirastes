# Independent SDK privacy review

- Reviewer: Codex (this dispatched Codex agent; not Opus). No helper agents.
- Date: 2026-11-17.
- Immutable reviewed SHA: `ff27169e8478e76fc1091186ba87a91c50c608df`.
- Base: `7c2dd8779d873c0691f1216c328f7ab06fd02cfd`; follow-up emphasis: `b36b5f7..ff27169` (7a23777, 3553dc5, 2f00826, ff27169).
- Workspace: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`; HEAD matched reviewed SHA before and after checks; clean working tree. No implementation edits.
- Read repository CLAUDE.md and authoritative platform plan sections 15–16 plus `2026-11-17-privacy-policy-platform-cut-review.md` under `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/piwo96-pii-production-plan/docs/plans/`.
- Authority boundary: Platform owns signed policy authority; consumer owns enforcement and secrets. Pending Platform implementation is not itself an SDK finding.
- Vector SHA256 verified: `b24876515741a6c14786ea7abd6de2a5236286c9504a1964b18370c61a7159e4`.

## Findings

### HIGH — Revoking an accepted off policy does not stop unprotected egress

Primary location: `src/runtime/privacy-runtime.ts:69–75`; related `src/runtime/glirastes.ts:794–805,854–863`, `src/sync/sync-manager.ts:66–72`.

`privacyRuntimeStatus` returns `off` before inspecting revocations when local `required:false` permits the signed off policy (also when no privacy infrastructure is configured). `assertPrivacyTurn` consequently succeeds for a revoked off revision. The createGlirastes live gate uses this function; its no-privacy branch also returns without checking revocations. `speechPolicy()` therefore still resolves to explicit `off`, permitting the recording handler's configured cloud service. The unprotected chat step gate also fails to stop on this policy revocation (the separate tool guard can still block tool execution).

Scenario: accept protected revision 5, then authorized off revision 6; load a signed security revocation for revision 6 while it remains accepted. The floor is already off, so `lowersPrivacyFloor` bypasses its revoked-off test on subsequent syncs. Requests/steps continue under the revoked permission to disable protection. This violates K2's revocation and non-revoked-off requirements, without requiring an untrusted signature or consumer secret compromise.

Focused reproduction called the actual status and assertion functions with an off revision, matching loaded revocation, durable state flag and `local.required:false`: status was `off`, reasons `[]`, and assertion returned successfully. Check revoked policy IDs independently of effective protection/profile before all early returns; ensure revoked off is rejected independently of the current floor. Add regression coverage for revocation after off activation, both chat and speech.

### MEDIUM — Revocation loaded during prompt protection is missed before provider send

Location: `src/server/pii-shield/model-boundary.ts:379–381,463–477`.

The hook runs only at the beginning of `transformParams`. Numerous awaited identity, detector, mapping, prompt and schema operations follow. Neither `wrapGenerate` nor `wrapStream` checks it again before `doGenerate` / `doStream`.

Scenario: a call passes the initial gate, then detector/store work yields; SSE/sync loads a revocation or a privacy lock while protection is still running. After processing resumes, the provider receives the call despite the already loaded revocation and despite no bytes having been sent yet. This is a scheduling window rather than a total revocation bypass; the following call will normally be blocked. K2 explicitly places the revocation boundary at transform/wrapGenerate/wrapStream. Recheck immediately before dispatch in both wrappers, preserving sanitized errors and blocked counters.

Focused reproduction used the real boundary and memory shield, setting a revocation flag during awaited pseudonymization; the real wrapped model completed with `{"revoked":true,"checks":1,"providerCalls":1}`. Transport was a capture model, not an external provider.

## Checks and evidence

Commands run from the reviewed workspace:

```sh
git rev-parse HEAD
git status --short
git diff --stat 7c2dd8779d873c0691f1216c328f7ab06fd02cfd ff27169e8478e76fc1091186ba87a91c50c608df
git log --oneline b36b5f7..ff27169
git diff b36b5f7 ff27169 -- src/runtime/glirastes.ts src/sync/sync-manager.ts src/sync/state-store.ts src/sync/managed-sync.ts
shasum -a 256 src/contracts/__vectors__/privacy-policy.v1.json
bunx vitest run src/sync/__tests__/privacy-floor.test.ts src/runtime/__tests__/privacy-restart.process.test.ts src/server/pii-shield/__tests__/provider-conformance.test.ts src/server/pii-shield/__tests__/postgres-mapping.test.ts src/server/adapters/nextjs/__tests__/recording-transcription-handler.test.ts src/contracts/__tests__/privacy-policy-vectors.test.ts --maxWorkers=1 --no-file-parallelism
bunx vitest run src/runtime/__tests__/glirastes.test.ts src/runtime/__tests__/privacy-runtime.test.ts src/server/adapters/nextjs/__tests__/privacy-policy-handler.test.ts src/server/adapters/nextjs/__tests__/privacy-handler.test.ts src/server/adapters/nextjs/__tests__/approval-execution-gate.test.ts src/server/pii-shield/__tests__/model-boundary.test.ts --maxWorkers=1 --no-file-parallelism
```

First run: 6 files passed; 234 tests passed, 29 skipped, 11.89 seconds. Second: 6 files passed; 151 tests passed, 5.00 seconds. Total 385 passed, 29 skipped; sequential files and one worker, no full concurrent suite.

Reproduction 1 (executed):

```sh
bun -e 'import { assertPrivacyTurn, privacyRuntimeStatus } from "./src/runtime/privacy-runtime.ts"; const pinned = { revisionId: "revoked-off", privacy: { schemaVersion: 1, profile: "off" } }; const revocations = [{ policyRevisionIds: ["revoked-off"] }]; const privacy = { shield: { profile: "protected-text/v1" }, local: { required: false } }; console.log(privacyRuntimeStatus(pinned, privacy, revocations, true)); assertPrivacyTurn({ pinned, privacy, revocations, awaitingPolicy: false, acceptedStateDurable: true }); console.log("BUG: revoked off passed the live privacy gate");'
```

Reproduction 2 (executed):

```sh
bun -e 'import { createPrivacyBoundary } from "./src/server/pii-shield/model-boundary.ts"; import { PrivacyError } from "./src/server/pii-shield/detection-result.ts"; import { captureModel, memoryShield, testScope } from "./src/server/pii-shield/__tests__/privacy-fixtures.ts"; const session = await memoryShield().open(testScope()); let revoked = false; let checks = 0; const original = session.pseudonymizeText.bind(session); session.pseudonymizeText = async (...args) => { const text = await original(...args); revoked = true; return text; }; const boundary = createPrivacyBoundary({ session, beforeModelCall: () => { checks++; if (revoked) throw new PrivacyError("privacy_policy_revoked"); } }); const {model,calls} = captureModel(); const wrapped = boundary.wrapModel(model); await wrapped.doGenerate({prompt:[{role:"user",content:[{type:"text",text:"Hello"}]}]}); console.log(JSON.stringify({revoked,checks,providerCalls:calls.length}));'
```

## Follow-up assessment and limitations

Inspected durable accepted-state load/save/failure gates, protected floor high-water preservation across rollback, serialized manager application, rejected protected requirements, registry identity/binding enforcement, classifier replacement with approved model, exact OpenRouter routing replacement, Postgres generation cleanup, and speech missing versus explicit off behavior. No additional actionable finding established in these paths within this review. Existing focused tests support those follow-up fixes, subject to the revocation findings above.

Postgres source was reviewed, including the cleanup statement now reading current generation in its own snapshot. The 29 live PostgreSQL tests were skipped because GLIRASTES_TEST_POSTGRES_URL was not configured; this review does not establish real database concurrency acceptance. No production endpoints, actual provider requests, deployment, Platform implementation, typecheck/build or complete suite were exercised. Reproductions isolate real SDK functions with synthetic inputs/capture transport; they are not end-to-end signed-sync/browser reproductions. Review is risk-focused, not an exhaustive audit of every line in the approximately 19,500-line base diff. The local memory keyword lookup supplied no facts used in the findings.

Verdict: needs fixes for the two revocation gaps; review task complete, implementation intentionally unchanged.
