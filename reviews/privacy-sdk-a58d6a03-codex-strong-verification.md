# Independent source verification of SDK a58d6a03

**Hold packaging on this SHA.** Shutdown clears the graph identified in the earlier Low finding. The same cleanup also affects private stores and can cause a previously refused stopped handle to report an ordinary off policy. The coordinator accepted the collateral finding and reserved executable verification for a replacement commit.

| Identity | Value |
| --- | --- |
| Candidate | a58d6a03cf58dbb1197939171c6d6ec60a47960c, SDK 0.25.0 |
| Tree | bed04fc9373c0c3b541cc785cd67c7070ec72fcb |
| Parent | a60a2f16faac226cb74e348ede21988fef7e4740 |
| Independent reviewer | OpenAI Codex gpt-6.2-astra, high reasoning effort, confirmed in the worker's local turn metadata |
| Dispatch | task_7626085ad327 / ctx_b2070e2e3a5c, 24 November 2026 Europe/Berlin |
| Previous report | reviews/privacy-sdk-a60a2f16-codex-strong-verification.md, Git blob f7caf3b9df435048be8b6b5b6d144f20431f4957, SHA-256 9fb9d8753e62526876ea2515752e3ed2c04731787a676083f1fcfb71e83b9ad4, identical to the original archive |
| Implementation-author evidence | reviews/privacy-sdk-a60a2f16-resource-fix.md, Git blob efb46eb580f6f5e059df13a42c79269e7e29b87e |
| Production change | src/runtime/glirastes.ts, Git blob 57f2414268fa6c1448b52999ec6377fc1ef1b28d, SHA-256 a3bc0dcdb914dc3547cdbe22a4382b0521dd754331cd66f8d0270b8647cb0839 |

## Original Low finding

**Addressed in source, corroborated by the author's focused test.** At src/runtime/glirastes.ts:1021–1027, stop drains outstanding store writes and awaits metrics shutdown. The finally block then clears the store before releasing the app's active-instance entry. At lines 392–400, clear retains the protected floor and drops the persistent backend, full state and materialized deployment. The per-environment held revocations survive. Bound replacements still need fresh reconciliation. The regression at src/runtime/__tests__/glirastes.test.ts:1128–1140 checks a previously accepted deployment, absent accepted state on the stopped handle, and the three cleared registry references. The smaller per-binding wrapper remains reachable by design.

## Collateral finding

**High · Clearing an unbound runtime's private store can remove a stopped handle's policy refusal.** This is a source finding. The prerequisite is a connected application without a fixed UUID, state-store factory or explicit privacy configuration, whose authenticated sync has supplied a signed off policy. It differs from a fresh ordinary instance that has never held privacy authority.

- At src/runtime/glirastes.ts:533–542, only fixed bindings enter the global registry. The unbound runtime uses a private store. At lines 417–419,907–918, the signed state itself can supply the only indication that managed privacy checks apply. Before cleanup, that recognition keeps the runtime unavailable without the required durable binding and keeps the stopped handle blocked.
- The new unconditional clear at line 1025 discards the accepted deployment and state from the private store too. Lines 329–331 retain only a protected floor. Lines 392–400 remove the current environment, and lines 422–425 use that environment to expose held revocations. An off policy therefore ceases to supply the dynamic authority signal. The stop check at line 913 requires both an aborted lifecycle and that signal.
- The policy reader falls through to null and the public speech reader can consequently return off at lines 979–986. The earlier turn's gate still uses the same underlying logic at line 998. The recording handler consumes this decision at admission and dispatch (src/server/adapters/nextjs/recording-transcription-handler.ts:134,327,369). This establishes a fail-open decision path by inspection. No provider call, data disclosure or runtime reproduction on this SHA is claimed.

Limit stop-time cleanup to the globally retained, validly bound store, or make shutdown refusal survive cleanup independently. The coordinator chose the scoped cleanup and a regression at the public transport boundary. Verify the replacement SHA against the unbound signed-authority case, the original bound resource test, pending writes, failed-save floor/revocation handoff and genuinely fresh ordinary pairing.

## Evidence and limits

I inspected the immutable four-file diff, the relevant shutdown and privacy-gate call chains, both archive blobs and the new regression. The range whitespace check passed. The author's /tmp/privacy-sdk-release-resources-green.log reports 90 passing runtime/dispatch tests. I did not run a build or tests on this SHA, as directed after escalation. The coordinator's full gate was running at this report's cutoff. No repository edit, external call, package preparation or release action was performed by this review. No later fix is covered.

Representative source checks:

```sh
C=a58d6a03cf58dbb1197939171c6d6ec60a47960c
P=a60a2f16faac226cb74e348ede21988fef7e4740
git rev-parse "$C" "$C^{tree}" "$C^"
git diff --check "$P" "$C"
git diff "$P" "$C" -- src/runtime
git show "$C:src/runtime/glirastes.ts" | nl -ba
git show "$C:src/runtime/privacy-runtime.ts" | nl -ba
git show "$C:reviews/privacy-sdk-a60a2f16-codex-strong-verification.md" | shasum -a 256
```
