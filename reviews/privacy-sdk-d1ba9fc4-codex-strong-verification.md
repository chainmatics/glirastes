# Independent SDK verification of d1ba9fc4

**Hold packaging and GID acceptance.** Two high-severity authorization or persistence defects and one medium-severity compatibility defect remain. Each has an independent local observation. None of the observations involved a live provider, production data or an external connection.

| Review input | Immutable identity |
| --- | --- |
| Candidate | d1ba9fc495a96c2f26729265a85421e5df8fc346, tree 4f08570f17596c619b3e04bc3f6895183d0d52d1 |
| Independent comparison | bf71dd8ca72e325854add09a2f724db8ab2c7cb3 |
| Intermediate author fix | c8fb14967bdea33a18b0778e0b26151a3b6b85bd |
| Original review and upstream | 8d01c6ac1cf800e46ec8eebe87975037bf8c0544 and f29b3607d8576dc0fec07258af43cf48b6698c2a |
| Reviewer | OpenAI Codex gpt-6.2-astra, high reasoning effort, verified in this worker's local Codex turn metadata |
| Review date and dispatch | 2026-11-23, task_019393677c63 / ctx_6a9d96c7bd4d |

## Findings on d1ba9fc4

**H1 · A stopped runtime can overwrite its replacement's durable state.** `src/runtime/glirastes.ts:988–992` releases the per-app singleton without draining its outstanding writes. Each new instance owns a separate queue at lines 277, 593. The epoch checks at lines 352–364 protect memory, but the second check runs after the backend write. The isolated test paused an ordinary periodic save, awaited the public stop(), started another runtime with the same app, environment and backing store, and observed that the new deployment ending in 3988 was persisted. Completion of the old save then changed the stored deployment back to 3904. Both deployments were benign and both runtimes had completed stop() before the observation of the final state. This demonstrates a stale durable overwrite. The save replaces a whole snapshot containing floors and revocations, so a newer security decision is also at risk. The probe did not exercise a security downgrade or observe subsequent egress. Serialize the handoff across instances that can write to the same backend and preserve the replacement's durable state even if another caller starts it while stop() is pending.

**H2 · A supported callable model misses the provider-attempt authorization hook.** `src/server/pii-shield/dispatch-gate.ts:10` returns function objects unchanged. The locked AI SDK accepts a callable V3 descriptor with the standard model fields (`node_modules/ai/src/model/resolve-model.ts:26–43`). The local classifier at `src/server/core/intent-classifier.ts:380–385,422` passes such a model to generateText. A model selector or factory can also return one to the off-turn streaming paths at `src/server/adapters/nextjs/create-ai-chat-handler.ts:2693,2924`. Through real AI SDK generation and the OpenAI adapter, one benign request completed with zero invocations of the supplied per-attempt hook. The equivalent plain-object control invoked it exactly once. Thus earlier handler admission checks still exist but this interface cannot enforce a subsequent authority change at dispatch for this shape. The independent probe counted authorization calls on an allowed operation. It did not send revoked input. Apply the gate to all supported resolved model shapes, including callable descriptors.

**M1 · Frozen model descriptors fail on ordinary traffic.** `src/server/pii-shield/dispatch-gate.ts:11–16` returns a different function for the target's own immutable doGenerate or doStream data property. JavaScript enforces the Proxy invariant on such a property. A valid frozen V3 object returned OK from the real AI SDK without the wrapper. With the wrapper it threw TypeError before either the hook or transport ran. The plain-object control succeeded. An ordinary runtime-provided chat turn supplies a privacyGate at `src/runtime/glirastes.ts:970`, so this is relevant even when the consumer has no protected policy. The observed failure was in generation. The streaming property uses the same trap. Preserve normal model behavior and the model method receiver when forwarding these calls.

**Low · The committed generic-pairing transport test reuses its standalone instance.** `src/runtime/__tests__/glirastes.test.ts:258–266` creates both runtimes under the same app ID before either is stopped. The singleton lookup at `src/runtime/glirastes.ts:545–548` returns the first runtime for the second case. An independent control stopped the first instance before creating the second. The generic-pair case made one synthetic control-plane lookup, the standalone case made zero, and each produced HTTP 200, one identical serialized model request and a null privacy policy. Generic pairing omitted the fixed privacy binding as intended. This is a test coverage defect with a passing independent behavior check.

## Previous findings and the pending-revocation correction

| Area | Independent disposition |
| --- | --- |
| Converted approval receiver | Live lookup on the original tool, binding function guards to the original receiver, closes the previous captured-flag issue. `src/server/core/privacy-conversion.ts:30–38`. Focused cases covered mutable data, method receiver, inherited approval and reconstructed fallback. Receipt-acquisition recheck and unknown outcomes also passed. |
| Ordinary retries and classifier | Scoped per-attempt checks protect tested plain OpenAI adapter objects and provider-string resolution. Signed-off stream and classifier retry tests each constrain the transport to the first authorized request. H2 remains for callable descriptors and M1 for frozen objects. |
| Opaque routing and guardrails | The protected handler refuses either opaque callback before invoking it. Off-turn intent routing and guardrail entry recheck after earlier awaits. `src/server/adapters/nextjs/create-ai-chat-handler.ts:1852–1857,2383,2819–2820`. Focused protected refusal and off-turn router/classifier tests passed. |
| Connection, store and sync generation | Scope checks before and after store operations and the reconciliation callback prevent the old response from authorizing a replacement connection inside the same runtime. The obsolete-push regression passed. The queue at `src/runtime/glirastes.ts:290–298` only covers that instance. H1 remains across stop and recreation. |
| Known protected refusal | `src/sync/managed-sync.ts:129–139` separates refusal from sending its heartbeat. `src/sync/sync-manager.ts:266–283,329–332` saves the stricter decision before later reporting. Pending-storage and pending-heartbeat cases returned 503 with zero provider requests. |
| Bound-only readiness | UUID/store-only management uses the durable authority checks at `src/runtime/glirastes.ts:689–698,762–779,880–902`. The half-configured startup and volatile-store heartbeat cases passed. Fresh bootstrap remains mandatory after loading cached state. |
| Verified revocation pending persistence | `src/sync/sync-manager.ts:186–213` checks scope and signature before each immediate save. `src/runtime/glirastes.ts:342–350,421–425` retains the revocation in process before waiting for disk. The focused pinned-turn case returned 503 and zero serialized provider requests while the save was pending. The author's regression on c8fb1496 observed one request in this interval. H1 concerns a different lifetime boundary. |

## Verification and limits

All 20 changed files in the two-commit SDK range were included in the source inspection. The original 8d01c6ac review, its fix ledger, the 0709fb69 and bf71dd8c reviews and associated evidence, and the c8fb1496 pending-revocation ledger are identifiable in the candidate tree. The bf71dd8c review, its implementation ledger and the c8fb1496 ledger have Git blob IDs f77bc31c4fe8a027dd8770cf5910e2b480e93a09, 9e6f0ee4fe8bb70bafa8b1a39b2a2415a7c2e060 and 49d5164235e7ac128d6aabc1c360c6f69e4c1dbc. This replacement review targets the changed SDK paths and their earlier findings.

The coordinator's build, source/test typechecks, 60-site egress inventory with zero violations, and required isolated-PG full gate succeeded. The full log records 8,354 passed, 17 expected failures and 58 skipped, across 542 passed and 7 skipped files in 180.45s. I checked the source log and JSON. All 58 skipped (path, test name) pairs matched the fixed upstream baseline. The three upstream exception files with 17 expected-failure declarations have identical source blobs to the baseline. Vitest's JSON combines these expected failures with passed tests. The intermediate c8fb1496 full result was 8,353 passed, 17 expected failures and 58 skips.

After explicit gate release, I independently ran 26 selected cases in four files, with 112 cases excluded by the name filter. All 26 passed. Five additional default-transport and built-format provenance cases passed. Individual scratch probes used synthetic provider serialization, process-local persisted-state fixtures and synthetic offline pairing. The provider and Platform fetch implementations were local test doubles. H1 used the documented state-store factory interface with a process-local shared backend that reports durable. It validates the completion-order defect without claiming a disk crash or a cross-process experiment. No implementation edits, subworkers, full-suite rerun, deployment or publication occurred in this dispatch.

The coordinator started a release metadata merge in the shared checkout during verification. All reported focused cases and scratch observations were repeated from a separate Git archive of exactly d1ba9fc4 under /tmp with a private copy of the coordinator-built 0.24.1 dist, using the installed locked dependencies. Baseline/provenance comparisons passed there. Node v22.22.2, Bun 1.4.5, Vitest 4.1.4. The full gate belongs to the coordinator. The runtime findings have been escalated.

## Reproducible verification commands

In the repository, the exact-range source checks were equivalent to the following.

```sh
C=d1ba9fc495a96c2f26729265a85421e5df8fc346
P=bf71dd8ca72e325854add09a2f724db8ab2c7cb3
git rev-parse "$C" "$C^{tree}" "$P" c8fb1496
git diff --check "$P" "$C"
git diff "$P" "$C"
git ls-tree -r "$C" -- reviews src/runtime/glirastes.ts src/sync src/server
git show "$C:src/runtime/glirastes.ts" | nl -ba
git show "$C:src/server/pii-shield/dispatch-gate.ts" | nl -ba
git diff --exit-code f29b3607 "$C" -- tests/mention-marker-attack-paths.test.ts src/react/__tests__/left-chat-patterns.test.tsx src/react/__tests__/left-chat-defect.repro.test.tsx
```

For the completed bounded runs, the archived source root is /tmp/privacy-sdk-d1ba9fc4-independent/pinned and the scratch directory is its parent. The coordinator-owned loopback PG URL and required-PG switch were provided for the filtered suite. The five default/provenance cases use fixture transport. Commands shown use bun as the Bun 1.4.5 binary.

```sh
cd /tmp/privacy-sdk-d1ba9fc4-independent/pinned
node ../model-shapes.mjs "$PWD"
bun ../runtime-lifecycle.ts
bun ../ordinary-pairing.ts
bun run test --no-cache src/runtime/__tests__/glirastes.test.ts src/server/pii-shield/__tests__/dispatch-gate.test.ts src/server/adapters/nextjs/__tests__/privacy-handler.test.ts src/server/pii-shield/__tests__/tool-boundary.test.ts -t 'temporal review|review residual|blocks .*provider retries|resolves a model string|ordinary consumer after generic pairing|signed off revocation blocks memory'
bun run test --no-cache tests/privacy-default-baseline.test.ts tests/privacy-provenance-builds.test.ts
```

## Bounded release-delta addendum

I compared d1ba9fc495a96c2f26729265a85421e5df8fc346 with e860c6ffd2e663510b83824353ee80ab0cf4a7c8, tree a5137b572eb4e44bbbb889184c764c553e1c18c2. Its parents are the prepared candidate 75a4c9a7 and upstream c62e3402. The seven production privacy/sync source blobs listed below are identical at both endpoints. All three runtime defects therefore carry forward. This addendum is source and metadata inspection only. No merged-build/full-suite result is asserted.

I checked the CLI worklet copy, doctor, scaffolding and upgrade detector changes against upstream. Those changed implementation files match upstream c62e3402 byte-for-byte. They add offline worklet-path checking, preview existing package script changes, update an existing .gitignore for a worklet copy and include stylesheets in explicitly targeted upgrade-note detection. The worklet command dispatch remains separate from the explicit model-download subcommand. The merge changes neither provider/speech execution code nor any publication workflow. Package and runtime version are both 0.25.0. The 0.24.2 upgrade note matches upstream. The only note in the 0.25.0 manifest is exactly the candidate's previously unreleased privacy note. Compared with upstream's 0.24.2 API snapshot, the merged snapshot removes zero entries and adds 331, all named by the privacy note. No merge-specific privacy activation, publication gate or release-note defect was identified.

**Low, source observation only · CLI diagnostic detail can include a worklet URL query or fragment.** Inherited unchanged from upstream 0.24.2. At e860c6ff, `src/cli/commands/voice-worklet-check.ts:111–120` strips the query/fragment for the path comparison, then returns the original mismatched literal. `src/cli/commands/doctor.ts:172–178` includes it in JSON detail, and `src/cli/commands/doctor-presentation.ts:65–66,74–82` interpolates it into human output. A relative worklet URL with query parameters can therefore carry them into local diagnostic output. The path component suffices to diagnose the mismatch. No real token or external delivery was examined. This local CLI issue is distinct from the runtime release hold.

```sh
M=e860c6ffd2e663510b83824353ee80ab0cf4a7c8
git diff --check "$C" "$M"
git diff --stat "$C" "$M"
git diff "$C" "$M" -- src/cli src/runtime package.json .github/workflows upgrade-notes
git diff --exit-code c62e3402 "$M" -- src/cli/commands/voice-worklet-check.ts src/cli/commands/stt src/cli/commands/doctor.ts src/cli/commands/doctor-presentation.ts src/cli/commands/init-scaffold.ts src/cli/commands/agent-setup.ts src/cli/commands/upgrade/detect.ts src/cli/commands/upgrade/notes.ts upgrade-notes/0.24.2.json
```

## Source and evidence hashes

Exact candidate production Git blobs used for the six-finding review follow.

    100644 blob 8a1181565de0dc217a597ba61e4844a4273343cb	src/runtime/glirastes.ts
    100644 blob 585499c920f28b203fedc4e5f8dbe1c8dd5e1ec6	src/server/adapters/nextjs/create-ai-chat-handler.ts
    100644 blob dc4bd0677208444ae5c8793b6931f7b426285f9a	src/server/core/intent-classifier.ts
    100644 blob 087155acf53afc1d7d420803aeba8bb0d0d41901	src/server/core/privacy-conversion.ts
    100644 blob 66c143b75b069feb220f55177c17b582664f99cb	src/server/pii-shield/dispatch-gate.ts
    100644 blob 98ddb0cd89d30f9a321c893ab7913cc2fceb5cfb	src/sync/managed-sync.ts
    100644 blob ffe8562aa5e786c45836a71192c5989ac02efc17	src/sync/sync-manager.ts

SHA-256 hashes of the independent scratch files, test logs, coordinator gate artifacts and key copied build products follow.

    b18cccc84226bf3d005fe744c5ee512b792e7018c93ebbcf6b7ba44ade976d43  /tmp/privacy-sdk-d1ba9fc4-independent/default-and-provenance.log
    df758aa2ee0726915e9ba710c4be2db2e393873a3e702db79345835f64cc2cfd  /tmp/privacy-sdk-d1ba9fc4-independent/focused.log
    0ff65b2c752a83f6b80bf5a35a0d53e53abc47d9da04b3fa17a7a8fe9cd45f9b  /tmp/privacy-sdk-d1ba9fc4-independent/model-shapes.log
    9a2286be9629641218c4c427c19eda696f69a24dfef3153b87626f273a39961b  /tmp/privacy-sdk-d1ba9fc4-independent/model-shapes.mjs
    6883a10ff3ea7a1316566012d4da6c3b3c89dfd9b496dfb57f408b135727bb65  /tmp/privacy-sdk-d1ba9fc4-independent/ordinary-pairing.log
    73fac704681f60aa0af1c3944d4b5c204d59aca76c39078512c946f88ac54e1f  /tmp/privacy-sdk-d1ba9fc4-independent/ordinary-pairing.ts
    596cf4dab008479a0b88c761d2a98655e6f72c0ec66213ceba12d9dade1f179c  /tmp/privacy-sdk-d1ba9fc4-independent/runtime-lifecycle.log
    9b7e6f16b7448163aa4426b2fc110ddfde6529b6cc617e6fc1c2f14a70f0c0fe  /tmp/privacy-sdk-d1ba9fc4-independent/runtime-lifecycle.ts
    1fa0d16f60fba71e834fa2e90f9141c40eafa60a938ad4fc818a9b9840d22514  /tmp/privacy-sdk-revocation-final-build.log
    ecb3ee4f31a9ea7f4e2545cdc04e246596bb7a7be449d90108a3768233f7520b  /tmp/privacy-sdk-revocation-final-egress.log
    7a3be6038fa2ce53b9e704494786874f95f5d6f1dd74c56f75aac2c61164c8d8  /tmp/privacy-sdk-revocation-final-full.json
    c719c83c56e13045af6ca4b82749c08d433b7ff6cce62269041f6090f8a18436  /tmp/privacy-sdk-revocation-final-full.log
    f2a5798912ec16b3816266875a38f8490158175fa5fa725196071b16f91acad5  /tmp/privacy-sdk-revocation-final-types.log
    6832d505311de1f581f12dfe9ab0d131ba6ce0bf6c3c951f29c6359ee1a87651  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/runtime/glirastes.js
    9899578970a4299a39d192bce11958594c17c30d57b1603f64293a5ecf71f072  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/server/pii-shield/dispatch-gate.js
    1b3242c563cbb10dad6445a0288a56a384e0a0d6d78df8f908d7f2bb564df3ad  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/server/adapters/nextjs/create-ai-chat-handler.js
    06e12e14a14ad0d2432820f79cc18146f3aadff1400b4004883307e84fdd9f08  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/server/core/intent-classifier.js
    6aaa3e7d886da1f891c2889fb0ae2148d6b786303e6b92750e0fb8efb02c032f  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/server/core/privacy-conversion.js
    e5b1d086358ea09405ab6cdc4835c198c883f3493bca6c6fd1cad568a989363f  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/sync/managed-sync.js
    6aef40237f22155478ac28e760495d1bef3fdef76212b515a5e7cb90ecd62a2a  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/sync/sync-manager.js
    edeb66c483c5e55ccf23448910922e88ead392e7873c5b2ba6a895adec26a59e  /tmp/privacy-sdk-d1ba9fc4-independent/pinned/dist/runtime/sdk-version.js
