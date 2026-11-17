# Independent Codex review — 0.17.0 candidate and STT evidence

Reviewer: **Codex**, not Opus. Date: 2026-11-17. Read-only, bounded review; no edits to implementation, subagents, installs, heavy suites, builds, registry publication or container operations.

## Immutable scope and conclusion

- SDK: `00afd67e29e44e2fb60a436daff654d385f06d5e` versus reviewed privacy source `a25ef568c65c8260d749475cb2ae955448112e31`.
- GID candidate/evidence: `5c1c55d8829c55c8a80a3b55aab131fabc786e4b` versus its parent `c2b22901904f68e01b44589e8998239210763110`. Candidate files were initially uncommitted, captured under `/tmp/privacy-release-00afd67-review`, and their hashes remained unchanged after the coordinator committed them.
- STT implementation remains the previously verified `3ce5b6a762bd1e9134e5e69a43a6febfefdcb730` service bytes, SHA-256 `09baf10e66e8b5a86f39be4b32fb656b85e4db48d6542600446f50982187b036`.

**No new actionable defect found within this scope.** Seven focused release/version tests passed independently. Candidate metadata, lock integrity and all installed archive files agree. This concludes local candidate/evidence review, not public-registry install acceptance, release authorization or Stage 1 completion.

## Release metadata and publication gates

The exact SDK diff changes package version and `SDK_VERSION` together to 0.17.0, creates the unreleased changelog entry and compare link, adds npm publication-job PostgreSQL/egress gates, updates the command-order test and adds acceptance documentation plus the prior review. No runtime privacy behavior changed beyond reported version metadata.

The publication job checks the tag against package version, builds before the test suite, runs the model egress inventory, and sets both `GLIRASTES_TEST_POSTGRES_URL` and `GLIRASTES_REQUIRE_POSTGRES=1` against disposable PostgreSQL 16. Failed steps prevent npm publication; no continue-on-error bypass was added. The service and environment match CI's existing pattern. The release test verifies command ordering, while this reviewer inspected PostgreSQL service/environment wiring directly; the test itself does not comprehensively validate workflow execution semantics.

As in the earlier review, the new gates protect **npm publication**. The pre-existing reusable runtime-container job publishes its image under its own tests before the dependent npm job. No new claim that the npm gates precede every runtime-image publication is made. No remote workflow execution or npm/GHCR publication was performed or verified here.

## Candidate-to-consumer binding

Archive: `/tmp/privacy-sdk-consumer-017/glirastes-0.17.0.tgz`.

Independently computed:

- SHA-1: `e899820a755045fb049258186dedf62a5a95c73c`.
- Integrity: `sha512-sLJ4kSY8V+QWa03ySm/MWStYHpMhZfM6pV8afGxp1dLFaX5VwRB8icyiC021xlPN3CG9Egq80IxfHclGg6QFmw==`.
- 1,699 regular archive files compared byte-for-byte to GID `node_modules/glirastes`: **zero differences**.
- Archive and installed manifests both report 0.17.0. GID package dependency, lock workspace entry, lock package identity and installed-skills version agree. Lock integrity exactly matches the computed candidate integrity. Dependency references contain no local tarball path.

A direct archive comparison against the prior reviewed a25/0.16 tarball found no added or removed files and only six changed files: package.json, CHANGELOG.md, and ESM/CJS runtime sdk-version JS/declarations. This supports the claimed unchanged packaged privacy implementation; it is not a fresh full runtime audit.

The candidate JSON accurately marks `published:false`, names exact source/implementation SHAs and requires post-publication archive reconciliation. The registry 404 in that JSON and coordinator message is attributed evidence, not an independently refreshed network observation. An unavailable public dependency deliberately remains a release/deployment blocker. The locally populated node_modules and candidate integrity do not demonstrate clean registry installation. After publication, compare the actual archive/integrity, review any content differences, regenerate the registry lock if necessary, and repeat clean install/build/consumer gates.

## STT recovery evidence assessment

The JSON report matches parsed `/tmp/privacy-stt-fixed-recovery.log` exactly. The qualification prose matches its measurements: process-cold start-to-readiness 1.801 seconds with warm host filesystem cache; short samples 2.285/2.021/2.050 seconds and HTTP 200; 53.073-second input returns HTTP 503 after 35.061 seconds; model PID disappears while server/resource tracker remain; readiness stays false until explicit restart; recovery readiness 1.641 seconds and next short request 200 in 1.576 seconds. Temporary files remain zero in recorded snapshots.

The docs correctly distinguish the fixed image `sha256:b101a76f7b03664282a71697ec269f05c9aea3b7a515969239641eecb586e343` from pre-fix measurements, disclose 227 log bytes and describe the numeric semaphore-cleanup warning, rather than claiming universal zero logs. The JSON records the byte count, not raw warning text; warning content is coordinator/document attribution in this review. No container logs or process state were independently re-read during this task.

The failed long sample remains explicit non-fulfillment of the allowed 60-second recording requirement. No timeout increase, limit reduction, automatic-recovery claim, target-CWS qualification or browser/live-authority acceptance is implied. The 35-second inference, five-second upload and 45-second SDK deadline values remain unchanged. This evidence is appropriately limited to development hardware, one synthetic voice and controlled restart; it cannot establish realistic quality, sustained load, target performance or deployed acceptance.

## Commands and independent results

SDK checkout: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`.
GID checkout: `/Users/philipprollmann/Dev/chainmatics/get-it-done/.claude/worktrees/piwo96-pii-stage1`.

```sh
# SDK
 git rev-parse HEAD
 git diff --stat a25ef568c65c8260d749475cb2ae955448112e31 00afd67e29e44e2fb60a436daff654d385f06d5e
 git diff a25ef568c65c8260d749475cb2ae955448112e31 00afd67e29e44e2fb60a436daff654d385f06d5e -- package.json src .github tests CHANGELOG.md
 bunx --no-install vitest run tests/release-workflows.test.ts src/runtime/__tests__/sdk-version.test.ts > /tmp/privacy-release-00afd67-review/focused-tests.log 2>&1
 git diff --check a25ef568c65c8260d749475cb2ae955448112e31 00afd67e29e44e2fb60a436daff654d385f06d5e
# GID
 git show --stat 5c1c55d8829c55c8a80a3b55aab131fabc786e4b
 git show 5c1c55d8829c55c8a80a3b55aab131fabc786e4b -- docs/privacy/stage1-consumer.md .glirastes/installed-skills.json
 git diff --check c2b22901904f68e01b44589e8998239210763110 5c1c55d8829c55c8a80a3b55aab131fabc786e4b
 shasum -a 256 package.json bun.lock .glirastes/installed-skills.json docs/privacy/stt-fixed-recovery-report.json docs/privacy/stt-local-qualification.md docs/privacy/sdk-017-candidate.json docs/privacy/stage1-consumer.md
```

Focused tests: **7 passed / 2 files**, exit 0, 115 ms. Exact executed SDK source/test/workflow paths had no diff against 00afd67. Both diff whitespace checks passed. Python standard-library `tarfile`, `hashlib`, `base64` and `json` were used to compute integrity, compare all regular archive members, compare old/new archives, copy/hash candidate snapshots and compare the recovery log/report. No tar extraction into node_modules and no install were performed.

## Exact GID evidence hashes (SHA-256)

| File | Hash |
| --- | --- |
| package.json | `0c95ba44d6997f7d2b4c38b9eec6958e99331380896474022639ced88f754fa5` |
| bun.lock | `2af1d1d903b83f6d53d32e629ceeba0948951e7c371061e67b5f48b028349b0f` |
| .glirastes/installed-skills.json | `a2977f5707d5b65ffe1aa5c90e500e48b7b69eef3ab398d0369a1df4afde1454` |
| docs/privacy/sdk-017-candidate.json | `2dcf1f56586625ef70cd598f2f5cb7c9b6e5a98d2fd2fb892a893ab0fd0d5a05` |
| docs/privacy/stt-fixed-recovery-report.json | `1a6a669bb1b0f3d9de5607db6f9a11973623f0ede1d4dd94c81b7231cf7bef89` |
| docs/privacy/stt-local-qualification.md | `9bd2a8de715a29052fdb36e617fb8de4ef6b721570a98c7fb997d40b4e07f33a` |
| docs/privacy/stage1-consumer.md | `46afa106b5c0148c46ce3550362a68eaa34d90794951bb0d005c70f7844576a0` |

## Attribution and remaining limits

Coordinator-reported SDK 5,005-pass/11-existing-skip full gate, GID 2,272-pass/53-existing-skip gate, build/type/tool checks and common nine-process bootstrap/DR rerun are **not this reviewer's runs**. No independent hardware measurement or real-provider call was performed. The earlier independently verified STT cancellation fix remains source-bound; the new measurement JSON is reviewed evidence, not a reviewer reenactment.

Public-package reconciliation and clean installation, authorized release/merge, runtime-image publication, real CWS resources and long/realistic audio, deployed authority/provider binding, live browser/tool behavior and operational DR remain external acceptance gates. GitHub mergeability investigation is outside this bounded code/artifact review. No Stage 1 completion claim is made.
