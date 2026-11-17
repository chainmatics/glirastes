# Codex privacy fix verification

Date: 2026-11-17. Reviewer: **Codex**, the independently dispatched Codex agent in Orca session `9273167d-83d6-417a-9cf9-e73e46251f59`; not Opus, no subagents.

Immutable reviewed/fix SHA: **e36dae1c1f78a6d87ce23daec23e1f587afbd4b4**.
Base/original reviewed SHA: **ff27169e8478e76fc1091186ba87a91c50c608df**.
Workspace: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.

## Result

Both supplied findings are **fixed** at the reviewed SHA. No additional actionable issue found in the full nine-file fix diff. This is scoped fix verification, not a new full security audit or release approval.

```json
{
  "results": [
    {
      "id": "revoked-off-egress-HIGH",
      "status": "fixed",
      "evidence": "privacy-runtime.ts:69-72 now checks revocation before off/no-infrastructure returns; glirastes.ts:796-802 always invokes the assertion; sync-manager.ts:68-70 rejects revoked off independently of the floor. Direct repro blocks both configurations, legitimate unrevoked off remains allowed, and the real Ed25519 signed-sync integration test passes for both configurations."
    },
    {
      "id": "revocation-during-protection-MEDIUM",
      "status": "fixed",
      "evidence": "model-boundary.ts:460-490 rechecks before both generate and stream dispatch, sanitizes errors, and reports blocking. Independent capture repros return privacy_policy_revoked after two checks with zero provider calls and one blocked notification for each mode; focused legitimate model boundary tests also pass."
    }
  ]
}
```

## Finding dispositions and boundary evidence

### Original HIGH: revoked off permission could continue unprotected egress — fixed

Trigger is a verified Platform revocation of the accepted off policy. The protected boundary is the SDK's authorization of model and speech egress under that signed permission; no attacker-controlled secret or arbitrary injected code is needed for the original failure.

The change moves revocation checking ahead of every off/no-infrastructure return in `src/runtime/privacy-runtime.ts:69-80`. `assertPrivacyTurn` translates that status into `privacy_policy_revoked` at lines 114-116. Removal of the no-privacy early return in `src/runtime/glirastes.ts` means its gate now always reaches the assertion (`787-802`). Thus the public speech-policy resolver and pinned chat gate both fail closed when the accepted revision is revoked. Sync independently refuses revoked off at `src/sync/sync-manager.ts:68-70` even after the floor was lowered.

The regression at `src/runtime/__tests__/glirastes.test.ts:852-875` is meaningful signed-sync integration, not a mocked verifier: `activeDeployment` signs each revision, the fake HTTP Platform serves the matching public JWK, and the test signs the subsequent revocation with Ed25519 over canonical JSON. Normal polling loads the revocation. Both parameter cases prove speech initially resolves to off, then speech and the previously obtained chat gate throw `privacy_policy_revoked`. Case false omits privacy infrastructure; case true provides it with `local.required:false`. The test uses a stub durable store and a minimal snapshot for the final gate call; it does not drive actual chat/recording HTTP traffic.

The separate floor test covers protected -> newer off -> revoked off. Independent direct checks reproduced the original inputs, additionally exercised no infrastructure and checked that an unrevoked off policy remains allowed in both cases. Both revoked cases produced `state: refused`, `code: privacy_policy_revoked`.

### Original MEDIUM: revocation during asynchronous protection missed at dispatch — fixed

Trigger is a revocation becoming loaded during awaited prompt/detector/mapping work. The sensitive sink is the provider's `doGenerate` or `doStream`. The new `assertDispatchAllowed` at `src/server/pii-shield/model-boundary.ts:460-470` runs directly before both sinks at lines 476-477 and 490-491, after transform/protection has finished. Errors remain content-free and blocking is counted once at this new check.

Independent replay of the original synthetic timing repro, extended to streaming, produced for each mode: `revoked: true`, `checks: 2`, `providerCalls: 0`, `code: privacy_policy_revoked`, and exactly one blocked notification. Existing legitimate generate/stream and multi-step boundary tests passed in the same focused run. This closes the original asynchronous protection window; it does not claim to recall already sent bytes or learn revocations while offline.

## Review and verification commands

Executed in the workspace, with no source/test edits:

```sh
git rev-parse HEAD e36dae1 ff27169
git status --short
git diff --stat ff27169..e36dae1
cat /tmp/privacy-sdk-ff27169-codex-review.md
git diff ff27169..e36dae1 -- . ':!reviews/privacy-sdk-ff27169-codex-review.md'
cmp /tmp/privacy-sdk-ff27169-codex-review.md reviews/privacy-sdk-ff27169-codex-review.md
bunx vitest run src/runtime/__tests__/glirastes.test.ts src/runtime/__tests__/privacy-runtime.test.ts src/server/pii-shield/__tests__/model-boundary.test.ts src/sync/__tests__/privacy-floor.test.ts --maxWorkers=1 --no-file-parallelism
git diff --quiet e36dae1 -- src/runtime/glirastes.ts src/runtime/privacy-runtime.ts src/server/pii-shield/model-boundary.ts src/sync/sync-manager.ts src/runtime/__tests__/glirastes.test.ts src/runtime/__tests__/privacy-runtime.test.ts src/server/pii-shield/__tests__/model-boundary.test.ts src/sync/__tests__/privacy-floor.test.ts
git status --short
git rev-parse HEAD
```

The archived original report is byte-identical to the original `/tmp` report (`cmp` exit 0); it was read in full. All remaining diff content was reviewed, including all added regression tests and their relevant signing/HTTP helpers. Targeted test result: **4 files passed, 121 tests passed, no skips, 4.47 seconds**. Reviewed source/tests matched the fix commit (`git diff --quiet` exit 0); HEAD remained pinned.

Independent repro commands (both exited 0):

```sh
bun -e 'import { assertPrivacyTurn, privacyRuntimeStatus } from "./src/runtime/privacy-runtime.ts"; const pinned = { revisionId: "revoked-off", privacy: { schemaVersion: 1, profile: "off" } }; const revocations = [{ policyRevisionIds: ["revoked-off"] }]; for (const privacy of [undefined, { shield: { profile: "protected-text/v1" }, local: { required: false } }]) { const status = privacyRuntimeStatus(pinned, privacy, revocations, true); let code; try { assertPrivacyTurn({ pinned, privacy, revocations, awaitingPolicy: false, acceptedStateDurable: true }); } catch (e) { code = e.code; } assertPrivacyTurn({ pinned, privacy, revocations: [], awaitingPolicy: false, acceptedStateDurable: true }); if (status.state !== "refused" || code !== "privacy_policy_revoked") throw new Error("revoked off was not blocked"); console.log(JSON.stringify({infrastructure:!!privacy,status:status.state,code,unrevokedOff:"allowed"})); }'
bun -e 'import { createPrivacyBoundary } from "./src/server/pii-shield/model-boundary.ts"; import { PrivacyError } from "./src/server/pii-shield/detection-result.ts"; import { captureModel, memoryShield, testScope } from "./src/server/pii-shield/__tests__/privacy-fixtures.ts"; for (const mode of ["generate","stream"]) { const session = await memoryShield().open(testScope()); let revoked = false; let checks = 0; const original = session.pseudonymizeText.bind(session); session.pseudonymizeText = async (...args) => { const text = await original(...args); revoked = true; return text; }; const blocked = []; const boundary = createPrivacyBoundary({ session, onBlocked: c => blocked.push(c), beforeModelCall: () => { checks++; if (revoked) throw new PrivacyError("privacy_policy_revoked"); } }); const {model,calls} = captureModel(); const wrapped = boundary.wrapModel(model); let code; try { const params = {prompt:[{role:"user",content:[{type:"text",text:"Hello"}]}]}; await (mode === "generate" ? wrapped.doGenerate(params) : wrapped.doStream(params)); } catch(e) { code = e.code; } if (calls.length || code !== "privacy_policy_revoked" || checks !== 2 || blocked.length !== 1) throw new Error("dispatch was not blocked"); console.log(JSON.stringify({mode,revoked,checks,providerCalls:calls.length,code,blocked})); }'
```

## Limitations

No full suite or PostgreSQL tests run here, to avoid overlapping the main worker's isolated PG run. That run's result is not claimed by this report. No production Platform, real provider/cloud speech, deployment, browser acceptance, build or typecheck exercised. The signed-sync test uses real cryptography and SDK sync with fake HTTP, while direct repros use synthetic input and capture transport. Platform implementation remains separately owned and pending status is not an SDK defect.

Concurrent work created/churned untracked `.tool-sync-*` directories under `examples/source-driven-next`; these were present at initial inspection and were neither edited nor removed. Reviewed tracked files remained identical to the exact fix SHA. Only this requested `/tmp` report was written by the verifier; no implementation changes, commits or helper workers.
