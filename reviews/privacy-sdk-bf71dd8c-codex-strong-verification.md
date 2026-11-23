# Independent SDK review — hold bf71dd8c

**Decision.** Hold this candidate before packaging or GID. The new code closes the original receipt window, retains unknown outcomes across conversion, and fixes the direct manual image-publish route. Live approval, per-attempt authorization and two managed-sync timing paths remain open. All findings below are independent source analysis. A separate implementer's failed regression assertion corroborates the approval finding.

| Review identity | Value |
| --- | --- |
| Candidate | bf71dd8ca72e325854add09a2f724db8ab2c7cb3 |
| Candidate tree | 547b618e40642e38d381af2a7db7576a5f6a220f |
| Comparison parent | 0709fb692e65170e47e9d121b50b79d2f42cff3f |
| Fixed upstream | f29b3607d8576dc0fec07258af43cf48b6698c2a |
| Independent reviewer | OpenAI Codex gpt-6.2-astra, high reasoning effort. Confirmed in this worker's turn_context. |
| Date and dispatch | 23 November 2026, task_5170d9adc3ac, ctx_ec4d362a16e6 |
| Prior report and author ledger | reviews/privacy-sdk-0709fb69-codex-strong-verification.md (blob 5adc609ea5fc209931d0aad3aa8ce251ac8003cc), reviews/privacy-sdk-0709fb69-fix-evidence.md (blob a24e28497f6ee05e63fc802f91ac927af1b34d5e) |

The governing change is explicit: a fixed UUID or explicit stateStore factory opts into managed bootstrap. Generic pairing, or a shield/provider registry alone, does not. All SDK line references use the candidate Git object, including for files another worker subsequently edited.

## Findings

1. **High — A converted tool's approval decision can remain stale after wrapping.** src/server/core/privacy-conversion.ts:29–35 copies data property values and accessor descriptors onto a new object. src/server/pii-shield/tool-boundary.ts:93–100 reads the copied object's approval and supplies that same receiver to predicates. Changing the original descriptor's boolean or a field on which its getter depends can leave the protected tool operating under the earlier decision. Receiver-identity-based authorization can also change. The native closure-backed getter and execute-only fallback are improvements. For a converted tool, forward live authorization to the original receiver and use the registered fallback only when appropriate. The implementation owner's subsequent test observed false after the original required flag became true; its separate log is identified below.
2. **High — A managed turn pinned off can resend ordinary model input after revocation.** src/server/adapters/nextjs/create-ai-chat-handler.ts:1025–1055,1239 checks at prepareStep and hands the model through unchanged when there is no protected boundary. In the installed locked ai@6.0.161, node_modules/ai/src/generate-text/stream-text.ts:1531,1612,1660 prepares a step once and performs retryable provider attempts inside it. A revocation loaded during retry backoff is therefore invisible to the next attempt. There is also asynchronous work between the step check and the first dispatch. The classifier now rechecks just before calling its configured generateText (src/server/core/intent-classifier.ts:376–385), which fixes the reported tool-loading window. For signed off the classifier still passes a bare model to the standard generateText callback, whose retry loop has the same gap (node_modules/ai/src/generate-text/generate-text.ts:740). Check the managed gate at the actual model interface for each attempt. An existing example is the managed memory summary wrapper, src/server/adapters/nextjs/chat-memory.ts:642–654. A fresh unmanaged ordinary request does not need that gate.
3. **High — Legacy intentRouter remains outside live dispatch checks and signed provider selection.** src/server/adapters/nextjs/create-ai-chat-handler.ts:1845–1857,2763–2787,2804–2811 admits the turn, awaits tool/approval work, then passes user text to the consumer router without a new policy check. An off turn can still hand ordinary text to the router after its policy is revoked. In a protected turn text is pseudonymized, but the supported callback may itself call a model, as the SDK comment explicitly recognizes. The callback receives neither an enforced approved model nor a checked transport, so a signed provider allowlist cannot constrain such a call. The new beforeClassifierCall hook covers the local pipeline classifier only. Actual egress on this path depends on the consumer router. Refuse unsupported model-capable routing under protected policy, or provide and enforce a policy-aware routing interface.
4. **High — An obsolete connection can mark a replacement connection reconciled.** src/runtime/glirastes.ts:633–643,719–734,742–746,794–797 shares a mutable AcceptedStateStore between connection attempts and gives each manager an unrestricted markReconciled callback. src/sync/control-plane-client.ts:194–212,215–238,251–255,271–285 starts SSE separately from polling. Stopping aborts the loop controller, but an in-flight syncOnce HTTP request has no such signal, and the push task is not joined before reattachment. A delayed response obtained under the former connection can still apply through the old manager and save/mark the shared store after the replacement attaches. For the same fixed environment this can release a formerly valid off decision without successful current-connection bootstrap or overwrite newer state under overlap. Scope comparison alone cannot distinguish connections to the same UUID. Validate connection ownership at save and reconciliation, and cancel or drain obsolete operations. This is a source concurrency finding. The initial process-restart path itself now gates correctly on an accepted active snapshot.
5. **High — A known protected refusal waits on telemetry before it blocks an already-running off deployment.** src/sync/managed-sync.ts:129–142 determines that the verified protected revision is unenforceable but awaits an unhealthy heartbeat before throwing PrivacyRefusedError. src/sync/sync-manager.ts:265–281,313–325 records the refusal and saves the floor afterwards. The heartbeat uses src/sync/control-plane-client.ts:275–294 with no SDK deadline. On an initialized off runner, chat/speech can continue under the old decision while the heartbeat is pending. Close the in-process gate as soon as the verified in-scope refusal is known and preserve it through persistence failure; report the unhealthy status without making that gate wait on the report. This concerns a live policy transition, separately from the corrected cold-start check.
6. **Medium — Bound-only managed bootstrap can advertise signed off as healthy despite locally blocking service.** src/runtime/glirastes.ts:719–740,834–850 recognizes the UUID/factory alternatives for chat and speech, but passes only options.privacy to privacyRuntimeStatus. src/runtime/privacy-runtime.ts:77–86 checks durability of off only when privacy.managed is literally true. With a valid binding and volatile or absent store, an otherwise valid signed-off deployment can pass sync validation and produce an applied/healthy heartbeat (src/sync/managed-sync.ts:129–142,154–161), while the request gate still blocks. A factory without its UUID also reaches live attachment/sync at glirastes.ts:664–700 despite the fixed mismatch at the request gate. Use the same resolved bootstrap requirement for acceptance, readiness, heartbeat and requests. This is an acceptance/reporting discrepancy; the local request gate blocks the cited cases.

## Disposition of all nine prior findings

| Prior finding | Candidate disposition |
| --- | --- |
| H1 approval | Partial. Inherited and non-enumerable properties and execute-only registered approval survive the covered scenarios. Original-receiver liveness remains open in finding 1. |
| H2 binding | Local chat/speech gating corrected for the approved UUID/factory contract. src/runtime/glirastes.ts:570–578,665–669,834–856 blocks missing or invalid pairs, mismatch, unreadable state and unavailable bootstrap. Ordinary CLI pairing omits a new UUID, preserves an existing one, and explicit privacy pairing requires an environment and dotenv destination (src/cli/index.ts:829, src/cli/commands/connection-environment.ts:838–844,881–885,902). Readiness parity remains open in finding 6. |
| H3 classifier | Built-in local classifier's initial invocation is now gated after async preparation, with denial outside its fallback catch (intent-classifier.ts:376–379). The author's fixture revokes during tool loading and checks zero mocked provider requests. Findings 2–3 cover outstanding transport paths. |
| H4 cached off | Cold-start gap closed. Saving a cursor or an intermediate revocation no longer sets reconciled; the callback follows the final durable save and checks complete active snapshot, zero rejected active deployments and zero rejected revocations (src/sync/sync-manager.ts:323–325). Fresh snapshots still require an accepted stable policy. Finding 4 concerns reattachment; finding 5 concerns transitions in an already-reconciled process. |
| M5 signed scope | Original payload override and explicit optional-environment cases closed. src/sync/materialize-deployment.ts:22–28 rejects contradictory identity/revision fields before materialization. src/sync/sync-manager.ts:158–175,246–265,348–366 checks restored and incoming envelope scope, mandatory manifest/policy environment and any supplied agent/config environment. Revocations are environment scoped. The SDK connection lookup exposes app and environment, with no authenticated tenant (src/sync/connection-lookup.ts:6–21). No Platform signing service was tested. |
| M6 publication | Closed for the checked-in workflow graph. The only image publisher has verification-only manual dispatch; login and push require the reusable input and the parent release workflow name (.github/workflows/runtime-container.yml:9–14,71–88). Tagged release preflight, required PG and native STT precede image publication and npm (.github/workflows/publish.yml:96–127). Workflow names are repository-controlled metadata. No workflow was run. |
| M7 receipt | Closed for a newly acquired receipt. src/server/pii-shield/tool-boundary.ts:131–152 checks again after the asynchronous claim and before execution. On refusal it attempts to settle the known-unexecuted claim failed. A failed settlement conservatively leaves the claim pending. |
| M8 unknown outcome | Closed for the reported error-only nested SDK result. src/server/core/tool-failure-result.ts:140–145 preserves the SDK marker independently of endpoint provenance; tool-boundary.ts:159–169 detects it before receipt completion. Raw JSON cannot set the symbol. The existing built-format coverage uses mocks. |
| L9 diagnostics | Original cases closed. src/server/pii-shield/detection-result.ts:80–85,98–104 validates nominal and cross-copy privacy codes against own known codes, preserves the fixed PrivacyConfigMismatch name and limits other names. Recording and Nest now bound ordinary thrown names (recording-transcription-handler.ts:293–297,319–322,412 and src/server/adapters/nestjs/chat/ai-chat.service.ts:32–35). Ordinary recording queue/deadline behavior and dispatch-time speech policy recheck are unchanged from the reviewed parent. |

## Evidence and limitations

The independent work in this dispatch used exact-commit source, installed dependency source and local existing evidence. No subworker, implementation edit, container, database, provider or publication action. The previous independent byte-for-byte default transport comparison belongs to 0709fb69. The author added public pairing/runtime parity and reran the default and CJS/ESM suites before committing bf71dd8c. No later working-tree edit is certified.

| Existing artifact in /tmp | Result observed | SHA-256 |
| --- | --- | --- |
| privacy-sdk-0709fb69-strong-red.log | Author's selected parent regressions, 13 failures, 1 pass, 184 filtered | 5a5cc5ef65618e41673a25ce3296edc09e4f0bcbfa18d36c09a24399fe321716 |
| privacy-sdk-strong-residual-focused3.log | Author's required-PG selection, 263 passed | 03cd880c23e4c7143979fe31d657c8ac9b159177a5d0078c602e86040c897a8d |
| privacy-sdk-strong-transport2.log | Author's public/default/cross-format selection, 110 passed | 40d1710fe1755423156ab9dc1f4f889b21b5d7593827feb86a2678770c5bfa8a |
| privacy-sdk-strong-restart.log | Author's restart/handler selection, 40 passed in 2 files | 32268311650797ea2c08ee1ea9b482a074f843e320538213a43da6dd957788f6 |
| privacy-sdk-strong-full.log | Earlier source, 8,339 passed, 1 restart assertion failed, 17 expected failures, 58 skips | 1d7c9951a51cd85f705ed835e011dcf43efd733cadfa82e1c7916edf21cf13a0 |
| privacy-sdk-bf71dd8c-live-approval-red.log | Implementer's separate approval regression, 1 failed, 32 filtered | da14aa266c7cf45e4df937abe94e839017f28adef13039b4501c701f2b79018d |

The stale restart expectation was corrected to require 503 with zero egress. The earlier full result does not establish a green full gate on this commit.

## Reproducible inspection commands

```sh
C=bf71dd8ca72e325854add09a2f724db8ab2c7cb3
P=0709fb692e65170e47e9d121b50b79d2f42cff3f
git rev-parse "$C" "$C^{tree}" "$P"
git diff --stat "$P" "$C"
git diff --check "$P" "$C"
git diff "$P" "$C" -- src .github/workflows upgrade-notes/unreleased
git show "$C:src/server/core/privacy-conversion.ts" | nl -ba
git show "$C:src/server/pii-shield/tool-boundary.ts" | nl -ba
git show "$C:src/runtime/glirastes.ts" | nl -ba
git show "$C:src/runtime/privacy-runtime.ts" | nl -ba
git show "$C:src/sync/sync-manager.ts" | nl -ba
git show "$C:src/sync/control-plane-client.ts" | nl -ba
git show "$C:src/sync/managed-sync.ts" | nl -ba
git show "$C:src/server/adapters/nextjs/create-ai-chat-handler.ts" | nl -ba
git grep -n -e 'docker push' -e 'npm publish' -e 'publish: true' "$C" -- .github/workflows
rg -n 'await prepareStep|await retry\(|stepModel.doStream' node_modules/ai/src/generate-text/stream-text.ts
rg -n 'await retry\(' node_modules/ai/src/generate-text/generate-text.ts
```

The commit-range whitespace check passed. Test run ownership, scope and log hashes are recorded above.

The coordinator closed this exact-SHA review as source-only. Independent focused tests are reserved for the replacement SHA. The six findings and the packaging/GID hold remain in effect for bf71dd8ca72e325854add09a2f724db8ab2c7cb3.
