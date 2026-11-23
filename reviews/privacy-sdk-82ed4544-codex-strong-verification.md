# Independent verification of Glirastes SDK 0.25.0 at 82ed4544

**The stopped unbound-authority regression is fixed. The earlier bound-store resource fix remains effective.** No scoped blocker remains for local candidate adoption. I verified the specific candidate tarball identified below. GID integration and any external release have separate acceptance gates.

| Identity | Exact value |
| --- | --- |
| Candidate | 82ed4544c55915b9f26f8147671203baa3b8eb2e |
| Tree | 494dce9c80f1835a702e3a55439b4cc21837bee7 |
| Comparison parent | a58d6a03cf58dbb1197939171c6d6ec60a47960c |
| Reviewer | OpenAI Codex gpt-6.2-astra, high reasoning effort, confirmed in the worker's local turn metadata |
| Dispatch | task_e18ac6074d62 / ctx_e40dfd5b307a, 24 November 2026 Europe/Berlin |
| Parent review | reviews/privacy-sdk-a58d6a03-codex-strong-verification.md, blob 897f66f37f036523769708248ae29fd564a365a4, SHA-256 d66bb11aedb67317696c5d983641fb0ac8c9e7beaacd70d3b9c8069d728c2853, unchanged from the original archive |
| Author ledger | reviews/privacy-sdk-a58d6a03-scoped-stop-fix.md, blob 4b29cd8353f64f8ab60cd95fa4f0fee69cc64275 |
| Production file | src/runtime/glirastes.ts, blob 4b1c30ebebf769b1fa64aa65eb268d8bc70ef250, SHA-256 d8b0f103b681ad698f98de54e6a130f47051582aa0a028a98e75db8d73283e95 |

## Source and lifecycle results

The only production change makes stop-time cleanup conditional on validStateBinding at src/runtime/glirastes.ts:1021–1028. That same fixed boolean selects a globally retained store at lines 533–542,619–622. Shutdown still aborts synchronously, drains outstanding writes, awaits metrics shutdown and releases ownership in a finally block. A private unbound store remains reachable through the stopped caller's handle. Its accepted signed state therefore still informs the abort check at lines 417–419,907–918 and the public policy/turn entry points at lines 979–998.

| Review item | Bounded independent result |
| --- | --- |
| Stopped unbound signed-off policy | The exact committed public handler regression at src/runtime/__tests__/glirastes.test.ts:1142–1154 passed. The stopped handle refused with privacy_policy_unavailable, the response was 503, and there were zero captured provider requests. An independent policy-reader fixture observed privacy_policy_unavailable before, during and after shutdown after accepting a signed off block. The same fixture passed against extracted tarball code. |
| Bound reference retention | After three bound, signed-off runtimes stopped, all three process-registry entries had released the consumer backend and materialized deployment. No entry remained reconciled. The original direct-reference check also passed on the extracted tarball. Small entries containing retained restrictions remain per binding. No heap-size or garbage-collection estimate was inferred. |
| Failed-write floor and revocation | In separate processes, both the uninterrupted control and the orderly handoff persisted the verified protected floor at revision 2 after backend recovery. In an ESM-to-CJS handoff the original runtime knew one signed revocation and disk had zero. Fresh fixtures for a different environment and a different app each observed zero. Returning to the original pair restored and persisted one revocation. The old turn and old speech reader stayed unavailable after reconciliation, while the replacement's signed-off speech reader returned off. The mixed-format scope/stale check also passed on extracted package code. |
| Pending writes, metrics shutdown and ordinary compatibility | An outstanding save kept stop pending and concurrent recreation returned runtime_stopping. After the drain a fresh instance persisted the new deployment ending in 3988. A deliberately delayed and rejected metrics close kept ownership until it settled, propagated the fixture error, released the backend/deployment references and allowed fresh recreation. Independent standalone and generically paired instances each produced one matching serialized fixture request and HTTP 200, with zero versus one fixture lookup and no added privacy binding. |

The author independently reported the older a58d6a03 failure with HTTP 200 and one serialized fixture request, followed by 91 passing runtime/model cases on the correction. I inspected those logs. I did not rerun the vulnerable parent. My current-tag evidence comes from a separate private Git archive, independent inspection of built artifacts and committed regression reruns after the explicit gate release.

## Candidate package binding

Archive: /tmp/privacy-sdk-025-82ed4544/glirastes-0.25.0.tgz

| Property | Verified value |
| --- | --- |
| Name and version | glirastes 0.25.0 |
| Files | 2,231 unique regular files |
| SHA-256 | 347ea260d15fbfaf246c911e890acdfe08a84518045a18fe956d4fd62c00cd39 |
| SHA-1 | e66d05bf3ff1aa76b126a8f78c482ad31203ab61 |
| npm integrity | sha512-3dwfXGDAwAbG0Pw1AgfNhXnctCV9s10p64m2lynYn/7+mAJ6wHjmA3xinOoF3kKAoZ2yz7rqhhoXLlrRlkAVNA== |

Every packed path and length matched pack.json. I compared all 2,231 payloads byte-for-byte: 79 matched files from the exact Git archive, 2,139 matched the coordinator-built candidate dist, and 13 generated subpath package.json shims matched the build workspace. There were zero mismatches. As an independent source check for the production change, TypeScript 5.9.3 emitted byte-identical ESM and CommonJS runtime/glirastes.js from the pinned TypeScript file. Their SHA-256 hashes are 857a4f5f2f3512d9e4f44a2d5344f12c8fd04955bee352910633c39b55e50454 and e27282e65eaa2446faea527ff01d0c922d7be920836c975e0b294bac0cbbb6f1 respectively. Single-file ESM emission used the package.json module type to supply the format that NodeNext infers during a project build. I did not independently rebuild the entire SDK.

## Evidence and limits

- Independent committed selection: 20 passed in two files, with 95 excluded by the name filter. Scratch checks used the same checkout's locked dependencies, the coordinated build products, local signed fixtures and mocked transport. Bun 1.4.5, Vitest 4.1.4, Node v22.22.2.
- Coordinator's exact-SHA gate: build, source/test typechecks and egress inventory passed (60 sites, zero violations). The required isolated PG suite finished in 178.60 seconds with 8,380 passed, 17 expected failures and 58 skipped, 542 passed files and seven skipped. I checked the log and JSON, verified that the 58 skipped test identities matched the fixed upstream JSON, and checked the unchanged source of the three upstream files declaring the 17 expected failures.
- The source comparison had four files, a clean range whitespace check and no change in server, sync, publication workflows or package metadata. No repository edits, external provider execution, public registry installation, GID adoption, deployment or publication were performed by this review.

Evidence directory: /tmp/privacy-sdk-82ed4544-independent. inspection.txt records pinned Git commands. package-binding.py compares and extracts the candidate; attest-runtime.mjs verifies the two shipped runtime emissions. policy-status.ts, retention.ts, failed-revocation-scope.ts, runtime-lifecycle.ts, metrics-close.ts, ordinary-pairing.ts and durability-recovery.ts record the standalone controls. The packed-* variants use the privately extracted tarball. The original focused command from the pinned directory, with the required task-owned loopback PG configuration, was:

```sh
bun run test --no-cache src/runtime/__tests__/glirastes.test.ts src/sync/__tests__/privacy-floor.test.ts -t 'keeps stopped unbound|releases consumer backend|graceful|stopped managed turn|immutable public runtime|drains durable|floor whose save failed|cached off cannot bootstrap|obsolete push|signed foreign|candidate for another environment|older off|retained binding|retained store|ordinary consumer after generic pairing|verified off revocation blocks'
```

SHA-256 checksums for the retained evidence follow.

    da1a45853a8a13177f0a435212d6e377eb170ccb7600bd59e4224a05d2b75df6  /tmp/privacy-sdk-025-82ed4544/pack.json
    1fa0d16f60fba71e834fa2e90f9141c40eafa60a938ad4fc818a9b9840d22514  /tmp/privacy-sdk-82ed-build.log
    ecb3ee4f31a9ea7f4e2545cdc04e246596bb7a7be449d90108a3768233f7520b  /tmp/privacy-sdk-82ed-egress.log
    564e57e23ffd8038e16c2f53e50e44273429173f273ab2848f5eac9fa37689fe  /tmp/privacy-sdk-82ed-full.json
    294807f81a2c72fd06b9ec329c94530184ec459bbc6716d617c0c99c8872aa75  /tmp/privacy-sdk-82ed-full.log
    659af2549e813c69555a6a90f62892c414b246edfb9db5fe1dd852cf0b1fd2ee  /tmp/privacy-sdk-82ed-types.log
    f31eccfc2a6245012ce478a488afa73352428b964f867d36b117d0fe351073c1  /tmp/privacy-sdk-82ed4544-independent/attest-runtime.log
    3c0943fe08c672626743483de55ca72a67cd2034bc153823e2555aa2ae6bd899  /tmp/privacy-sdk-82ed4544-independent/attest-runtime.mjs
    2a79d8f08066664faf8efd96328dfd3c685f437cf11d7c522ca0275d8ea5982e  /tmp/privacy-sdk-82ed4544-independent/durability-recovery.ts
    29b1a7aec9f1f663132f85a63dffd6659c2e24f95d7bb4768267e45189301318  /tmp/privacy-sdk-82ed4544-independent/failed-revocation-scope.log
    2320c54afe4c41847507c92c88543ae56dcd80d2a5286abbb6f74261dbb17ec2  /tmp/privacy-sdk-82ed4544-independent/failed-revocation-scope.ts
    9af73576962dbe28cd32fdd52368a68c68bd5162781ae53f26bf016c816eb0bb  /tmp/privacy-sdk-82ed4544-independent/floor-control.log
    fe8a0035687a114002510135cba9de31d722c79f4027c879c92057e7c4077255  /tmp/privacy-sdk-82ed4544-independent/floor-handoff.log
    22586d336c2b709f4edd5bb4a42d1c34929c33bc5ae9406400bd736b28089fb4  /tmp/privacy-sdk-82ed4544-independent/focused.log
    927bdcfaf3c8e77594355df43351a5962b8b6bc3498195c61b9937fd8852621b  /tmp/privacy-sdk-82ed4544-independent/inspection.txt
    a7fe4bb6494af72f7914c4599d1871bbbaa5e97d5212c0b0cbd8c7bc2eb853b1  /tmp/privacy-sdk-82ed4544-independent/metrics-close.log
    2737de35350fe33030343d9c122d78305a406f72de0e6bc3052ea760a12011a8  /tmp/privacy-sdk-82ed4544-independent/metrics-close.ts
    6883a10ff3ea7a1316566012d4da6c3b3c89dfd9b496dfb57f408b135727bb65  /tmp/privacy-sdk-82ed4544-independent/ordinary-pairing.log
    d9837eb0b09c9eefa4f2beaf26e8c2122b7409b89b770b8ab3d39beb07b9e4bd  /tmp/privacy-sdk-82ed4544-independent/ordinary-pairing.ts
    00e31d2c41f9b7f0dadcfaa6a98ce1dbee6a78f989d99419a894d1a717e25944  /tmp/privacy-sdk-82ed4544-independent/package-binding.log
    1e876075719d3cb8d7e531f7c861d4096cef13d8518ace7d866f43732e1c9e07  /tmp/privacy-sdk-82ed4544-independent/package-binding.py
    29b1a7aec9f1f663132f85a63dffd6659c2e24f95d7bb4768267e45189301318  /tmp/privacy-sdk-82ed4544-independent/packed-failed-revocation-scope.log
    5c1753fdc2b476b33452037e501c04009e5a0f6036fe899ea9b959dbb5e9dcb0  /tmp/privacy-sdk-82ed4544-independent/packed-failed-revocation-scope.ts
    98945a615f667fff593c9e2bcd1631a541ae7834c04246d79bb44710c7c5074d  /tmp/privacy-sdk-82ed4544-independent/packed-policy-status.log
    c49a7bb168fa94e1076c39d81a8581083afeb4671b4b8c728ca4a43c19087713  /tmp/privacy-sdk-82ed4544-independent/packed-policy-status.ts
    2b97e7d31a730a57f4e1211e749619e3f081e22285a0e1c1b5c23a639ca6bd68  /tmp/privacy-sdk-82ed4544-independent/packed-retention.log
    15d3a4561435d55518244398b1d971eb65da6993d8980a8d639f412fc8881a38  /tmp/privacy-sdk-82ed4544-independent/packed-retention.ts
    98945a615f667fff593c9e2bcd1631a541ae7834c04246d79bb44710c7c5074d  /tmp/privacy-sdk-82ed4544-independent/policy-status.log
    771a7c0188a2f3058217f698384ac190ecd1ff110ad71d5acab20194cb0ce83b  /tmp/privacy-sdk-82ed4544-independent/policy-status.ts
    2b97e7d31a730a57f4e1211e749619e3f081e22285a0e1c1b5c23a639ca6bd68  /tmp/privacy-sdk-82ed4544-independent/retention.log
    5bc3fee8156591ab99f00176ef8adcdbb8fb54dab368b1f2e041a4ddc4a4479b  /tmp/privacy-sdk-82ed4544-independent/retention.ts
    cd5fae2e9a05dd156ba38f32a5078cee776a2cb6cc1884892a17c4e195e37e62  /tmp/privacy-sdk-82ed4544-independent/runtime-lifecycle.log
    6cfa48526e8e47c52741c319812401e7680950a830fe93d6e0b5c2c89c6f46ff  /tmp/privacy-sdk-82ed4544-independent/runtime-lifecycle.ts
    fd796b285448d3a51229473c1f1004a6893b185ab325a878b13d4a37dad71423  /tmp/privacy-sdk-a58-stopped-unbound-transport-red.log
    1dcc4df7bcddfa1c8066ea7547e2ef851a472a9c8deb3a502130f16eb482a4e8  /tmp/privacy-sdk-scoped-stop-green.log
