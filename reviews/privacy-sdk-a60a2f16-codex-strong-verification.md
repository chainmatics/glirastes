# Independent SDK verification of a60a2f16

**Both findings from 5360206f are fixed for the reviewed managed-runtime contract.** I found no remaining privacy blocker for a candidate built from this exact commit. One low-severity resource-retention issue remains for processes that cycle through many distinct bindings. Package contents, GID integration and release acceptance require their own evidence.

| Identity | Value |
| --- | --- |
| Candidate | a60a2f16faac226cb74e348ede21988fef7e4740, SDK 0.25.0 |
| Candidate tree | 5cd4a3e266c8af5f4657e9288532abadafcf6331 |
| Parent | 5360206f26a3ed07d6be8ca5b5f07c9829ddebef |
| Independent reviewer | OpenAI Codex gpt-6.2-astra, high reasoning effort, confirmed in the worker's local turn metadata |
| Dispatch | task_5e62b8b4a638 / ctx_1e564276d232, 24 November 2026 in Europe/Berlin |
| Prior report | reviews/privacy-sdk-5360206f-codex-strong-verification.md, Git blob f87ba421b7b976973465ff26c75ee0d1e78602b2, SHA-256 b5fbfbf301ce3dc2931e5f2c90902b6a8aa0e48cb61ad39e54111098e7f15f5e, identical to the original archive |
| Author ledger | reviews/privacy-sdk-5360206f-fix-evidence.md, Git blob e8169aee2287d9a71b9ca6225812555dee1624cb |
| Production source | src/runtime/glirastes.ts, Git blob 77511d3864f5a63d53ddeb281f3cef9e8729ff8e, SHA-256 4a7d11b9650a20cf4574ba9b489103c44cdb8110c4ef0255ca7583f5b2c01e88 |

## Original findings and adjacent controls

| Item | Independent disposition |
| --- | --- |
| High, loss of a verified floor after a failed save and graceful replacement | **Fixed.** At src/runtime/glirastes.ts:533–543,619–628, a valid fixed app/environment pair reuses its process-local state wrapper. Lines 319–331,342–350,392–400 preserve stricter knowledge while clearing current acceptance and the old backend on reattachment. I repeated the prior failed-write differential with each arm in a separate process, so the control could not seed the handoff arm. Both persisted protected-text/v1 revision 2 after recovery without a newer signed off. The parent returned a null floor for the handoff arm. The committed fresh-bootstrap and revision-transition checks also passed, including refusal with zero captured provider requests until newer signed off. |
| Low, sealed runtime cannot stop | **Fixed.** Lines 529–532,567–571,1016–1027 track stopping instances in a process-shared WeakSet. The original sealed-handle fixture stopped successfully and returned a fresh instance. The committed sealed and frozen cases also passed. |
| Revocation persistence and scope | In a separate mixed-format fixture the ESM runtime knew one signed tool revocation while its recovered backend still held zero. The CJS replacement persisted it on the original binding. A different environment for the same app and a different app using the original environment each remained at zero, in memory and on their respective backends. All three controls completed a fresh authenticated fixture sync. A committed case additionally checked refusal to bootstrap a revoked policy snapshot after handoff. |
| Stopped managed turns | In the cross-format fixture the stopped turn's live gate and stopped runtime's speech entry both returned privacy_policy_unavailable after the replacement reconciled. The replacement returned its expected signed-off speech policy. The committed public-handler case returned HTTP 503 with zero captured provider requests for a stopped turn. The abort check is at src/runtime/glirastes.ts:907–915 and is used by the turn and speech paths at lines 979–998. |
| In-flight write and ordinary pairing | The independent barrier fixture confirmed that stop waited, recreation during stop raised runtime_stopping, and the replacement kept the newer deployment after both stops. Two separate ordinary runtimes, standalone and generically paired, each produced one identical serialized fixture request and HTTP 200, with zero and one offline lookup respectively. Generic pairing did not add the privacy binding. |

## Additional finding

**Low · A clean stop retains the whole backend and accepted deployment for every distinct binding.** The strong process-global Map at src/runtime/glirastes.ts:533–543 stores the complete AcceptedStateStore. The shutdown path at lines 1021–1024 drains it and removes the instance from the active registry. The backend and current snapshot are cleared on the next creation of that same binding. A fixture created three distinct, valid, signed-off bindings with no revocations or failed saves, then stopped every runtime. Inspection after shutdown found three registry entries, each still referencing its consumer backend and accepted deployment. Reusing a single binding reuses its entry. A process that continually retires distinct bindings accumulates these references until it exits. The observation was retained reachability, without a heap-size estimate or provider exposure. Keeping only the restriction state needed across handoff would let the backend and deployment graph be collected.

## Gate evidence, attribution and limitations

- The exact-range diff and whitespace checks covered five files. glirastes.ts is the only production-code change. The package metadata, release workflows and server paths match the parent.
- After explicit gate release I independently ran 18 named committed cases in two files. All 18 passed. The name filter excluded 95 cases. Independent scratch controls used the private source archive, the candidate's built 0.25.0 ESM/CJS dist, synthetic signed revisions, local fetch implementations and the store interface's in-process durable test fixture. The two original floor arms and the additional scope probes were separate processes. No live provider, container, full-suite rerun, package publication or production operation was performed.
- The coordinator's build, source and test typechecks, 60-site egress inventory with zero violations and required isolated PostgreSQL suite passed. The full log recorded 8,378 passed, 17 expected failures and 58 skipped, 542 passed and 7 skipped files in 184.27 seconds. I compared the exact 58 skipped identities with the fixed upstream f29b3607 JSON and checked that the three upstream source files declaring the 17 expected failures remain unchanged. The author ledger separately records 89 targeted passes and three failures on the prior source.
- The reviewed durability guarantee applies to orderly replacement in the same process with the fixed app/environment binding. Recovery after both process loss and failed persistence depends on current authenticated Platform authority, as documented. The focused probes do not establish physical disk recovery, distributed coordination or deployed behavior.

## Reproduction and hashes

The scratch archive is /tmp/privacy-sdk-a60a2f16-independent. inspection.txt records immutable Git commands. All execution used the private pinned subdirectory with installed locked dependencies and a copied candidate dist after the coordinator released testing. Commands below assume that directory and Bun 1.4.5. Required isolated PG settings for the filtered Vitest run used the coordinator's loopback database. Vitest version was 4.1.4.

```sh
bun ../durability-recovery.ts control
bun ../durability-recovery.ts handoff
bun ../sealed-runtime-candidate.ts
bun ../runtime-lifecycle.ts
bun ../ordinary-pairing.ts
bun ../scope-and-stale.ts
bun ../failed-revocation-scope.ts
bun ../retention.ts
bun run test --no-cache src/runtime/__tests__/glirastes.test.ts src/sync/__tests__/privacy-floor.test.ts -t 'graceful|stopped managed turn|immutable public runtime|drains durable|floor whose save failed|cached off cannot bootstrap|obsolete push|signed foreign|candidate for another environment|older off|retained binding|retained store|ordinary consumer after generic pairing|verified off revocation blocks'
```

SHA-256 digests of scratch fixtures, observed results and gate artifacts follow.

    1fa0d16f60fba71e834fa2e90f9141c40eafa60a938ad4fc818a9b9840d22514  /tmp/privacy-sdk-a60-build.log
    ecb3ee4f31a9ea7f4e2545cdc04e246596bb7a7be449d90108a3768233f7520b  /tmp/privacy-sdk-a60-egress.log
    186f61a1b58280b7ff7dc3de46ed701f4b48214fa1935a19ff258c9aeefe91c2  /tmp/privacy-sdk-a60-full.json
    acdafdbda395921b6cf014b6ef65ca991eb9eb6edac74697eb4b4be8015a2631  /tmp/privacy-sdk-a60-full.log
    659af2549e813c69555a6a90f62892c414b246edfb9db5fe1dd852cf0b1fd2ee  /tmp/privacy-sdk-a60-types.log
    6550c00b505a579ebbf0a5de459891c6cbda5564ad9f1a85d5d5699abc189d31  /tmp/privacy-sdk-a60a2f16-independent/durability-recovery.ts
    29b1a7aec9f1f663132f85a63dffd6659c2e24f95d7bb4768267e45189301318  /tmp/privacy-sdk-a60a2f16-independent/failed-revocation-scope.log
    8969a12262b4866ecfd52774ef64460d59ee8f0ebad34619a8881abd2f7cf623  /tmp/privacy-sdk-a60a2f16-independent/failed-revocation-scope.ts
    9af73576962dbe28cd32fdd52368a68c68bd5162781ae53f26bf016c816eb0bb  /tmp/privacy-sdk-a60a2f16-independent/floor-control.log
    fe8a0035687a114002510135cba9de31d722c79f4027c879c92057e7c4077255  /tmp/privacy-sdk-a60a2f16-independent/floor-handoff.log
    9ccba8e487b0b595877935ade6c9c28f276235b53d6b15eb3e3ec15dac1584da  /tmp/privacy-sdk-a60a2f16-independent/focused.log
    326a66ab0646d5a3d86a57acdd9e3fca790973d0e233b6043c1d90a254ca7ece  /tmp/privacy-sdk-a60a2f16-independent/inspection.txt
    6883a10ff3ea7a1316566012d4da6c3b3c89dfd9b496dfb57f408b135727bb65  /tmp/privacy-sdk-a60a2f16-independent/ordinary-pairing.log
    4748149d41af4f7ecc616df57d116177a76c48e53d7dcafe973b404bb46c95aa  /tmp/privacy-sdk-a60a2f16-independent/ordinary-pairing.ts
    c09a4a9fb2229cdccc49af9aba0a7d721bfe1c37fecac811389b537684665909  /tmp/privacy-sdk-a60a2f16-independent/pinned/dist/cjs/runtime/glirastes.js
    60c964b53268119814f9948d25012b8e1ab1712db9f50284b8001a522f70c4ec  /tmp/privacy-sdk-a60a2f16-independent/pinned/dist/runtime/glirastes.js
    ca7bebff94cef34f2a2883cec8ef7e00f973c00a9a1d91513ef4ab560dec4100  /tmp/privacy-sdk-a60a2f16-independent/retention.log
    d6373856e99254e83eb95171dc0cd77e24fa0166bec4339714ebf3a167bba1bd  /tmp/privacy-sdk-a60a2f16-independent/retention.ts
    cd5fae2e9a05dd156ba38f32a5078cee776a2cb6cc1884892a17c4e195e37e62  /tmp/privacy-sdk-a60a2f16-independent/runtime-lifecycle.log
    f0008b54859278bdc7bdba7f6e0e56a2d09691c656f42f1bc091a0885b72d463  /tmp/privacy-sdk-a60a2f16-independent/runtime-lifecycle.ts
    c286b247c7a512c566a9bf5c53d188fdbd74e64628031bcf755c5182b52c2bae  /tmp/privacy-sdk-a60a2f16-independent/scope-and-stale.log
    144680f94a710b303a5638e17380aaf22d5f734ab9db513e6dba53c1ddbe9276  /tmp/privacy-sdk-a60a2f16-independent/scope-and-stale.ts
    a1302adbe36ccc0463838971c01677e889b9dd76ef3f5d45cb2240f6617b869f  /tmp/privacy-sdk-a60a2f16-independent/sealed-runtime-candidate.log
    edb8e97c551bb00c15b5fe9e728b9f590baa13d7097bac92f6f07cfb9700758b  /tmp/privacy-sdk-a60a2f16-independent/sealed-runtime-candidate.ts
