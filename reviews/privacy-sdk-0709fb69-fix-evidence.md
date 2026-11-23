# Follow-up to strong review 0709fb69

Implementation-author evidence; independent verification of this follow-up is pending.
Exact original source/report: 0709fb692e65170e47e9d121b50b79d2f42cff3f, reviewer Codex gpt-6.2-astra high, archived alongside this file.

| Finding | Correction |
| --- | --- |
| H1 approval metadata | Preserve prototypes/property descriptors and late-bound guards; execute-only SDK conversion recovers its original approval guard. |
| H2 retained binding | Explicit stateEnvironmentId/environment variable OR stateStore factory opts into managed bootstrap. Missing UUID with retained factory is privacy_state_binding_mismatch. UUID without store and empty/lost state cannot release traffic. Ordinary pairing never adds the UUID; --privacy opts in and all pairing preserves an existing binding. Approved coordinator decisions msg_a84c8807dfd7 and msg_aa1884d96f67 settle this contract. |
| H3 classifier revocation | Recheck the live gate immediately before the separate classifier transport, including a turn pinned off. Signed off revocation during tool loading gives zero captured serialized provider requests. |
| H4 cached off bootstrap | Reconciliation is an explicit in-process callback after a complete, verified, durably saved snapshot, independent of persisted cursors or intermediate revocation saves. Rejected/incomplete first active snapshots cannot release cached off. |
| M5 signed scope | Reject contradictory identity/revision fields in signed payloads; compare optional explicit agent/config environment IDs. Validation precedes effective floor evaluation. |
| M6 image entry | Manual runtime-container dispatch is verification-only. Publication is gated by the parent release workflow and cannot be enabled manually. No workflow was executed. |
| M7 receipt window | Recheck live authority after the receipt claim, immediately before execution. A refusal settles the unexecuted claim failed with a fixed fingerprint and performs zero tool calls. |
| M8 unknown outcome | Preserve SDK outcome-unknown marker independently of endpoint provenance; converted inner unknown result leaves the receipt pending. |
| L9 diagnostics | Own allowlisted codes even for nominal PrivacyError; fixed recording summaries including caller callbacks; bounded Nest error name. |

The three required-suite failures on 0709fb69 are also corrected: shared z.uuid validator; restored-versus-incoming signature fixture; allowlisted PrivacyConfigMismatch diagnostic.

## Evidence

- Immutable red source /tmp/glirastes-privacy-review-red-0709fb69 contains the original commit plus copied tests only. /tmp/privacy-sdk-0709fb69-strong-red.log: 13 failures, one pass, 184 filtered cases. This reproduces the source findings; filtered cases are not full-gate skips.
- /tmp/privacy-sdk-strong-residual-focused3.log: 263 passes, zero skips, required isolated PostgreSQL enabled, seven files. Includes original review corrections, CLI ordinary/explicit binding, live classifier refusal and receipt tests.
- /tmp/privacy-sdk-strong-transport2.log: 110 passes, zero skips. Includes a real generic pairing file consumed by createGlirastes and serialized provider request parity with unpaired operation; untouched f29b3607 built baseline parity; ESM/CJS converted tools/readers; mutable diagnostic codes.
- First full follow-up: 8339 passes, one stale process-restart expectation, 17 expected failures and 58 skips. The process correctly returned 503 with no egress on rejected bootstrap; the test formerly allowed the retained protected policy to run. Its expectation now requires no egress and privacy_policy_unavailable.
- Source/tests typechecks and build passed. The final full gate and egress inventory are recorded after this source is settled.
- Full gate on 0709fb69 was failed (8315 passes/3 unexpected failures/17 expected failures/58 skips); it is not claimed green. Baseline 58 skip identities and 17 unchanged expected-failure source declarations were independently compared by the reviewer to f29b3607. No privacy/PG full-gate skip is accepted.

No public package, image publication, deployment or live acceptance is implied. GID adoption remains held until the fixed source is independently verified and packaged.

Follow-up process/handler selection: 40 passes in two files (/tmp/privacy-sdk-strong-restart.log), zero skips. Egress inventory: 60 sites, zero violations (/tmp/privacy-sdk-strong-egress.log). The final full required-PG gate still needs its post-correction run.
