# Independent Codex review — final fixed candidate binding

Reviewer: **Codex**, not Opus. Date: 2026-11-17. Bounded read-only review; no implementation edits, commits, helpers, installation, heavy tests, database/container operations or credentialed/network requests.

## Exact scope and result

- GID: **`54546ffa8ec49ba3937d399e0801a9a134e99e24`**, compared with **`5c1c55d8829c55c8a80a3b55aab131fabc786e4b`**.
- SDK runtime/package source: **`ec233325d97ba51606ace32a55b4b252ec9f62d9`**.
- SDK documentation/review HEAD: **`37f1e19342b03923b0273ec2250092077ce6d301`**. Its diff from ec23332 changes only acceptance documentation and adds the archived fix review; it is not substituted for the runtime SHA.
- STT service remains byte-identical to reviewed GID fix `3ce5b6a762bd1e9134e5e69a43a6febfefdcb730`.

**No artifact-binding or runtime-source defect found. One Low documentation finding remains in the refreshed integration skill.** All independent binding assertions passed. Public-package reconciliation/clean installation and live acceptance remain open; this is not Stage 1 completion.

## F1 — Low: generated integration skill omits the protected-mode exception to result handles

At GID SHA54546ff:

- `.claude/skills/integrating-glirastes-nextjs/SKILL.md:107–110` states without qualification that an oversized result reaches the model/browser as an overview and read_result can retrieve the rest.
- `.claude/skills/integrating-glirastes-nextjs/references/handler-options.md:65` describes resultHandles as on by default, its retrieval behavior and fallback truncation, without explaining effective protected mode.

These files exactly match the shipped SDK skill, so this is not consumer copy drift. A developer following that skill while enabling the privacy profile recommended immediately afterward is told to expect retrievable results. The reviewed runtime instead disables handles under effective protection even for explicit true, withholds oversized results and refuses SDK readers. The linked privacy reference does not supply the missing result-handle exception.

Impact is incorrect integration guidance/expectations, not a newly demonstrated privacy bypass. The runtime fails closed correctly. Qualify the canonical SDK skill and option reference with the effective-protected exception and explicit unsupported retrieval behavior, then refresh the generated consumer copy and its tracked content hash. If repackaged, retain a new truthful candidate hash rather than reusing this reviewed archive identity. Suggested documentation check: the resultHandles guidance must state that explicit true cannot override effective protection and that oversized protected output is withheld.

## Independently confirmed binding

Archive: `/tmp/privacy-sdk-consumer-ec23332/glirastes-0.17.0.tgz`.

- SHA-1: **`b270714777f69fa4624607d17d6daf0b6d910e9d`**.
- Computed integrity: **`sha512-zIcCgrFtLUDesRUwdQwqkGkkV8jVi0MrqKR8bootGsU60Wh0o3NkKbMPrRorSM3HXgDvf36ZB9TAcaMnBVpHAQ==`**.
- All **1,734 regular package archive files** match installed GID `node_modules/glirastes` byte-for-byte: zero missing/changed package files and no extra package-owned regular files. Nested `node_modules` dependencies were excluded from the extra-package-file check; they are not tarball members and this is not a fresh transitive dependency audit.
- Archive files that exist in the current SDK checkout match those bytes as well. Together with the unchanged runtime tree since ec23332, this supports the recorded source/artifact binding; no reproducible build or signed build attestation was independently generated.
- GID package manifest and lock refer to registry version 0.17.0, with no local tarball dependency. Lock integrity exactly matches the archive and candidate ledger. The version remains a prepared unpublished dependency; prepopulated node_modules is not evidence of clean registry installation.
- All eight installed skills have exactly the manifest-listed file sets, correct computed content hashes and bytes matching the archive. Hash computation was independently reproduced using normalized relative paths/content and NUL separators, matching the SDK hashing algorithm.
- The prior 00afd67 candidate ledger is preserved byte-for-byte as `docs/privacy/sdk-017-00afd67-candidate.json`. Earlier archive results are not silently reassigned to the fixed artifact.
- GID's exact diff contains only lock/skill refresh and evidence/review files; no consumer runtime source changes.

## Evidence assessment

The new live OpenRouter JSON binds both the correct SDK source SHA and archive SHA-1. It records HTTP 200 at `2026-11-17T19:59:18.522Z`, model `openai/gpt-6.1-terra`, reported upstream Azure, the expected binding digest, and transmitted routing values allow_fallbacks=false, data_collection=deny and zdr=true. Request context is redacted; response content is represented by a hash, and no credential/header/token is exposed in the reviewed JSON. The existing probe source was inspected read-only to understand how the fields are produced; it was not executed.

The document correctly limits this to a local approved-policy fixture, synthetic canary, consumer registry/SDK boundary and isolated PostgreSQL. It does not claim deployed Platform bootstrap or independently verified provider retention. The hashes correlate recorded requests/responses, but without the redacted raw bodies this reviewer cannot independently recompute them or re-prove the recorded rawCanary=false assertion. The live result is main-worker evidence, not this reviewer's network execution.

The ledger's timestamped registry 404 and the reported remote frozen-install failure remain attributed evidence; this review did not refresh the public endpoint. Publication, registry archive/content reconciliation and clean public install/build/consumer acceptance are still explicitly required. No unavailable dependency is presented as deployable.

STT service SHA-256 remains `09baf10e66e8b5a86f39be4b32fb656b85e4db48d6542600446f50982187b036`. Previous source-fix verification is unchanged. Documentation preserves the distinction between locally observed cold/restart/short-audio success and the failed 53-second recording at the 35-second deadline. No target-CWS, realistic 60-second audio or automatic-recovery acceptance is inferred.

## Commands, artifact and hashes

Independent verification script and output:

- `/tmp/privacy-gid-54546ff-review/check_binding.py`
- `/tmp/privacy-gid-54546ff-review/binding.log`

The script uses only Python standard-library tarfile/hashlib/base64/json and read-only git show calls. Final execution passed every assertion. An initial overly broad extra-file assertion included nested installed dependencies; it was corrected to compare package-owned files, without changing the package or ignoring any archive mismatch. All archive members matched from the first comparison.

Other commands included:

```sh
# GID checkout
 git rev-parse 54546ff 5c1c55d HEAD
 git status --short
 git diff --stat 5c1c55d 54546ff
 git diff 5c1c55d 54546ff -- package.json bun.lock .glirastes/installed-skills.json docs/privacy/sdk-017-candidate.json docs/privacy/stage1-consumer.md .claude/skills
 git diff --check 5c1c55d 54546ff
 python3 /tmp/privacy-gid-54546ff-review/check_binding.py
# SDK checkout
 git rev-parse ec23332 37f1e19 HEAD
 git diff --name-status ec23332 37f1e19
 git status --short
```

Exact GID file SHA-256 values, checked against commit objects:

| File | SHA-256 |
| --- | --- |
| package.json | `0c95ba44d6997f7d2b4c38b9eec6958e99331380896474022639ced88f754fa5` |
| bun.lock | `06ff9e98494966133ad57e4c00ba367b0825a7a73c66d55d73b93c7da3cca355` |
| .glirastes/installed-skills.json | `bfcaa58da747290df4813f8f7ebf53bbfb5b2eb58f715a0d1cb1126b8c1fff1f` |
| docs/privacy/sdk-017-candidate.json | `4d59b3476278ef026ce4a4cc83b901d7fc87ee6613547b12ddb436156b8d2b9c` |
| docs/privacy/live-provider-openrouter-ec23332.json | `e421d822bd53f5e913a93747f1162bb22252ac64dce14da8ca35806a20e3fdfe` |
| docs/privacy/stage1-consumer.md | `37d472954c87ffe7775642980b98286bc9b5db91ee44b071706890fb8ade4404` |

## Attribution and limits

The reported SDK 5,198-pass/11-existing-skip full gate, GID 2,272-pass/53-existing-fixture-skip full gate, production build/type/tool checks, common nine-process 6.70-second bootstrap/DR run and live provider request are main-worker evidence. None was rerun or counted as reviewer execution in this bounded task. No runtime test was needed to repeat the already reviewed ec23332 fixes; this review checks final binding and evidence coherence.

Final source-fix acceptance remains ec23332, not the docs-only 37f1e19 HEAD. This binding review does not complete publication, clean public-package install, direct second-provider testing, live Platform/consumer authority and DR, target STT performance or staging browser/tool/screenshot acceptance. The Low skill documentation inconsistency is separate from the verified artifact bytes and existing runtime safeguards.
