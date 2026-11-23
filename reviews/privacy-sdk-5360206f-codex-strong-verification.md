# Independent verification of Glirastes SDK 0.25.0 at 5360206f

**Hold package adoption.** All five items in the preceding review have fixes that passed their specific checks. A related high-severity defect remains in the orderly handoff of a known protected privacy floor after a storage error. I also observed a shutdown compatibility regression for a sealed runtime handle.

| Identity | Value |
| --- | --- |
| Candidate | 5360206f26a3ed07d6be8ca5b5f07c9829ddebef |
| Tree | 7b92b45bddd20468a869ba73270a50987da8c57e |
| Parent | e860c6ffd2e663510b83824353ee80ab0cf4a7c8 |
| Earlier runtime candidate | d1ba9fc495a96c2f26729265a85421e5df8fc346 |
| Independent reviewer | OpenAI Codex gpt-6.2-astra, high reasoning effort, confirmed from the worker's local turn metadata |
| Dispatch | task_95a186e82f45 / ctx_a5ea500d8c27, 23 November 2026 |
| Prior report | reviews/privacy-sdk-d1ba9fc4-codex-strong-verification.md, blob 3e4b7557d24501a805c3bf12709b4554fe857772, SHA-256 c038496926fd4b3e522482ef5df1f4cb33db8800541ae4def6d937fe263bcfff, matches the original archive |
| Implementation-author ledger | reviews/privacy-sdk-d1ba9fc4-fix-evidence.md, blob 371b9221af5761fdc2f1d5a8fe39aa75f5626877 |

## Remaining findings

**High · Graceful replacement can forget a verified protected floor whose write failed.** At `src/runtime/glirastes.ts:270,329–350,358–375`, the runtime retains an observed protected floor in instance memory. The drain promise settles successfully even when the underlying write failed. At `src/runtime/glirastes.ts:598,999–1002`, orderly shutdown releases the old instance and its replacement creates a new store wrapper. The stricter in-memory floor does not transfer to it. The documented binding remains intact throughout.

The independent state-continuity test compared two runs with identical signed fixture revisions, runtime configuration, environment UUID, store factory and backend. Both observed protected revision 2, both experienced the same transient storage error, and in both the backend recovered and the protected deployment was withdrawn without a newer signed off. The uninterrupted control durably retained protected revision 2. The run with a graceful same-process stop and recreation subsequently saved a null floor. This establishes loss of a known decision across handoff. By inspection, absence of that floor removes the downgrade check at `src/sync/sync-manager.ts:61–73`. The executable observation concerned durable state. No provider was configured or invoked by this probe, and no disclosure was observed. The scenario used an ordinary successful stop and the same backend, without process crash, deletion or rebinding. The expected protection against withdrawal after a failed save is documented at `skills/integrating-glirastes-nextjs/references/privacy.md:382–392` and exercised without a handoff at `src/runtime/__tests__/glirastes.test.ts:1404–1431`.

Before releasing ownership, preserve unresolved verified restrictions for the same app and binding, or retain ownership and return a recoverable stop error until the restrictions are securely saved. Apply the handoff rule to retained revocations as well. The independent state test measured a floor.

**Low · Sealing the public handle prevents shutdown.** At `src/runtime/glirastes.ts:995–1005`, stop() adds a symbol property to the public instance before aborting sync or initiating cleanup. Sealing that handle makes the addition throw. The independent benign standalone comparison observed successful stop and fresh replacement on the preceding runtime implementation. On the candidate, stop threw a TypeError and a subsequent create returned the old instance. The control used the archived d1ba9fc4 build. Its runtime source is byte-identical to the e860c6ff parent. The same symbol-based stopping state can be installed before the handle leaves the constructor or kept off the public handle. No provider or production behavior was involved.

## Prior findings verified on this commit

| Prior item | Verdict and independent evidence |
| --- | --- |
| H1, outstanding successful write can overwrite a replacement | Fixed for the reported ordering. The same barrier and shared-backend fixture kept both stop callers pending until the original write finished. Concurrent create produced runtime_stopping. After awaiting stop, a fresh instance persisted deployment 3988, which remained the final stored deployment. Scoped write entry also checks abort and generation at src/runtime/glirastes.ts:752–759. The new high finding concerns a failed write. |
| H2, callable descriptors miss per-attempt checks | Fixed on the supported AI SDK model interface. The independent allowed callable-model generation made one hook call and one serialized fixture request. A transient 503 followed by success made two hook calls for two requests. Callable, frozen and inherited model getters and both provider methods observed the original receiver. Source at src/server/pii-shield/dispatch-gate.ts:10–27. |
| M1, frozen model descriptors fail | Fixed. Frozen and plain controls returned OK, with one hook per attempt and working generation and streaming. Existing refused-generation and refused-stream assertions kept the captured request count unchanged. The freshly allocated forwarding target avoids the original immutable-property invariant. |
| Low, ordinary pairing test reused a singleton | Fixed at src/runtime/__tests__/glirastes.test.ts:258–268. The independent two-instance control observed zero versus one mock lookup, a null privacy policy and HTTP 200 in both cases, one byte-equivalent serialized fixture request per case, and no privacy environment binding added by generic pairing. |
| Low, query and fragment exposed in worklet mismatch diagnostics | Fixed at src/cli/commands/voice-worklet-check.ts:111–120. Both human and JSON outputs use the same path-only field. The exact-SHA canary case passed with both unwanted values absent. |

## Release gate and test evidence

The full candidate diff from e860c6ff covers nine files. The release workflow, package metadata, version and upgrade manifests match the independently reviewed release-merge parent. At .github/workflows/publish.yml:18–19,82–107,109–127 the tagged preflight checks the API snapshot, types, build, egress inventory and required PG suite. Native STT depends on preflight, the tested runtime image depends on both, and npm publication requires success of all three jobs. The direct image workflow has an empty manual dispatch input and guards tag verification, registry login and push with the caller identity and publish input at .github/workflows/runtime-container.yml:9–14,71–88. The bounded workflow and release-note assertions passed. No live workflow, package, container, provider or deployment action was performed.

- **Coordinator full gate.** Build and test types passed, egress inventory reviewed 60 sites with zero violations, and required isolated PG finished 8,373 passed, 17 expected failures and 58 skipped across 542 passed and 7 skipped files in 176.03 seconds. I checked the result JSON and log. All 58 skipped test identities matched the f29b3607 upstream baseline. The three upstream files containing the 17 expected-failure declarations (5, 5, 7) have unchanged source. This full run belongs to the coordinator.
- **Independent committed cases.** After explicit gate release I ran 32 selected cases in five files (149 excluded by name filter) and all 15 cases in three default-transport, module-provenance and release-workflow files. All 47 passed. This included the protected refusal and pending-revocation paths, signed-off retries, converted approval and receipt behavior, tool-loading/classifier checks, original storage recovery without a handoff and the replacement-specific regressions.
- **Independent controls.** Logs record allowed and retried provider calls, original method/getter receivers, parity with and without generic pairing, pending stop and concurrent recreation, differential floor recovery, and paired old/current sealed-handle checks. Inputs were synthetic. The lifecycle backend was the mutable process-local durable fixture, with a controlled save boundary. It establishes the completion and data-retention semantics of the store interface. No physical disk-loss, multiprocess coordination or provider-disclosure claim is made.
- **Author evidence.** The e860c6ff red log records three failing regressions and one passing control. The author ledger records 84 runtime/model and 101 CLI/release focused cases. The independent results above use the exact replacement SHA.

## Reproducibility and provenance

I read the exact commit objects, verified a clean whitespace diff and ran the focused checks from a private git archive of 5360206f, next to a private copy of the candidate's built 0.25.0 dist and linked locked dependencies. No repository files were edited. The bounded Vitest runs used Bun 1.4.5 and Vitest 4.1.4. The shape probes used Node v22.22.2. The required-PG configuration named the task-owned loopback database. No full suite was rerun independently. The preceding e860c6ff release merge and upstream/packaging evidence remain separately attributed.

Archive root: /tmp/privacy-sdk-5360206f-independent. commands.txt records the pinned Git checks. From its pinned subdirectory the independent committed-test commands were:

```sh
bun run test --no-cache src/runtime/__tests__/glirastes.test.ts src/server/pii-shield/__tests__/dispatch-gate.test.ts src/server/adapters/nextjs/__tests__/privacy-handler.test.ts src/server/pii-shield/__tests__/tool-boundary.test.ts src/cli/commands/doctor.test.ts -t 'temporal review|review residual|blocks .*provider retries|resolves a model string|ordinary consumer after generic pairing|signed off revocation blocks memory|drains durable writes|guards allowed and refused|omits worklet query|keeps a floor whose save failed'
bun run test --no-cache tests/privacy-default-baseline.test.ts tests/privacy-provenance-builds.test.ts tests/release-workflows.test.ts
```

The archive contains the input and result files for the independent observations. The following Git object IDs bind the relevant production and workflow lines to the candidate.

    100644 blob 8cfda54d61ed9ec342b9a91056357af219e405f8	.github/workflows/publish.yml
    100644 blob ba0028a96ebdf68e4b38dcf20177ea60fb750779	.github/workflows/runtime-container.yml
    100644 blob ada57161e7fe65722177692c1299e538302c70e5	.github/workflows/stt-local-addon.yml
    100644 blob 805b4427ad08ddbddf98a208332f4621e7284108	src/cli/commands/voice-worklet-check.ts
    100644 blob fae82613dae3b8f8b54a261aa67dada8b48e177a	src/runtime/glirastes.ts
    100644 blob ab48645d949332d71df89434f1eeaed84734ae71	src/server/pii-shield/dispatch-gate.ts
    100644 blob ffe8562aa5e786c45836a71192c5989ac02efc17	src/sync/sync-manager.ts

SHA-256 checksums of the scratch fixtures, independent results, compiled evidence and coordinator gate logs follow.

    1fa0d16f60fba71e834fa2e90f9141c40eafa60a938ad4fc818a9b9840d22514  /tmp/privacy-sdk-025-fixed-build.log
    ecb3ee4f31a9ea7f4e2545cdc04e246596bb7a7be449d90108a3768233f7520b  /tmp/privacy-sdk-025-fixed-egress.log
    0954d8126048088d20c108b931cca09e00b9729c188206110326e00ec9042772  /tmp/privacy-sdk-025-fixed-full.json
    59c63e1c5cedaeac4a2b2e1337900bdc587c7f2ba9b61f024f30ade3819ffad9  /tmp/privacy-sdk-025-fixed-full.log
    f2a5798912ec16b3816266875a38f8490158175fa5fa725196071b16f91acad5  /tmp/privacy-sdk-025-fixed-types.log
    6c99ad9beccec48a12fbba7338ba99c3525d33917c2a5256dbbf862bb2f249ab  /tmp/privacy-sdk-5360206f-independent/commands.txt
    6fb1af074f04d8738fcdc13c083f1bdff06c27d9de38aecbff2274c1c136d7d2  /tmp/privacy-sdk-5360206f-independent/durability-recovery.log
    e14eb96ced0aaf1a8be94031c719a151596344b42c090196f4955ff43627bb71  /tmp/privacy-sdk-5360206f-independent/durability-recovery.ts
    0d91e910de58b739ece49a477e505ce489cd1257bf6b9c0f1cc1d115cdd71482  /tmp/privacy-sdk-5360206f-independent/focused.log
    60730eb51f471d78f676d3b5f3f75acb09c5e0c7483e05a3d1aa7c238b65c727  /tmp/privacy-sdk-5360206f-independent/model-shapes.log
    9a2286be9629641218c4c427c19eda696f69a24dfef3153b87626f273a39961b  /tmp/privacy-sdk-5360206f-independent/model-shapes.mjs
    6883a10ff3ea7a1316566012d4da6c3b3c89dfd9b496dfb57f408b135727bb65  /tmp/privacy-sdk-5360206f-independent/ordinary-pairing.log
    0c0ef55b1239ccf7919eff0376122fcede663a856ad246ca29c3df25a15eebf8  /tmp/privacy-sdk-5360206f-independent/ordinary-pairing.ts
    67e0b671561ad21a7b3e26f18873b81ba24c212f1a2ea15387d910486199af6a  /tmp/privacy-sdk-5360206f-independent/pinned/dist/cli/commands/voice-worklet-check.js
    d0ed840c4968d8d6a594f83388bbfa1075b4996a9f6027021d39f745ddb0a8c0  /tmp/privacy-sdk-5360206f-independent/pinned/dist/runtime/glirastes.js
    053a8632aada1c181c1af93dcd1c0b75a2715a817aed55631a10f122386e71c6  /tmp/privacy-sdk-5360206f-independent/pinned/dist/runtime/sdk-version.js
    787902057d874f2cf609698c31aca0c022cd41fe8cb35c33f1c78cf71cf1ed33  /tmp/privacy-sdk-5360206f-independent/pinned/dist/server/pii-shield/dispatch-gate.js
    818c90221523e997c1d47ccf96f83a936dc60c211787378fd77165ebfd680b02  /tmp/privacy-sdk-5360206f-independent/public-release.log
    d08e807690d1c42c3b8c9baa3b3f4cb7dd36754085d547925de8a8c88305174e  /tmp/privacy-sdk-5360206f-independent/receiver.log
    e3d0ec22a4b34a06fa2144b7ba0cb82f12a87b680ce8141063e6ce8eeea0b98b  /tmp/privacy-sdk-5360206f-independent/receiver.mjs
    0b3a2dbec8c1e8378f60385dec5b4856d6efdb448fa7682b9bc4c9f1ecd6ec25  /tmp/privacy-sdk-5360206f-independent/retry-shapes.log
    c33eb9d4969e244ba4d8ebefbc111b8f71b431786dfd205619538a7653dbf876  /tmp/privacy-sdk-5360206f-independent/retry-shapes.mjs
    cd5fae2e9a05dd156ba38f32a5078cee776a2cb6cc1884892a17c4e195e37e62  /tmp/privacy-sdk-5360206f-independent/runtime-lifecycle.log
    bb0962b0c81b76090840b66ee51274f5d9fe9e76aa8ca33afb7b879ea665547d  /tmp/privacy-sdk-5360206f-independent/runtime-lifecycle.ts
    d53ed7e47b4021ca71a8229904040275f27e6a11b4fc8e4c9691d0c77f53f7fd  /tmp/privacy-sdk-5360206f-independent/sealed-runtime-candidate.log
    1347e26e4654ad6172fb815b7acadb2bc33b1c4913110cc118c8faa734ebcd04  /tmp/privacy-sdk-5360206f-independent/sealed-runtime-candidate.ts
    a1302adbe36ccc0463838971c01677e889b9dd76ef3f5d45cb2240f6617b869f  /tmp/privacy-sdk-5360206f-independent/sealed-runtime-prior.log
    a0525a201f0aa09190a3d4252dd7b69d4dca91e5c23a174b4b6bcef32c3bef4b  /tmp/privacy-sdk-5360206f-independent/sealed-runtime-prior.ts
