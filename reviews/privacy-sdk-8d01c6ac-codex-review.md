# Independent Glirastes SDK security review

| Field | Value |
| --- | --- |
| Disposition | Hold this SDK candidate |
| Reviewed merge | `8d01c6ac1cf800e46ec8eebe87975037bf8c0544` |
| Git tree | `6adcd6d4945a696b08828e81a9b8e6e6d19ca89e` |
| Privacy parent | `5bc9e567136527bbf690da6b799b023a2acb495f` |
| Fixed upstream parent | `f29b3607d8576dc0fec07258af43cf48b6698c2a` |
| Reviewer | Independent OpenAI Codex, `gpt-6.2-sol`, medium effort, verified in this worker's Codex turn metadata |
| Orca task | `task_1eab32a73545`, dispatch `ctx_6f506027f435` |
| Review date | 23 November 2026 |

## Findings

### High — A rebuilt tool discards consumer approval requirements

**Merge regression.** In `src/server/core/privacy-conversion.ts:15-25`, the rebuilt conversion replaces every common property on the supplied descriptor once execute identity matches. `toolToAiTool` regenerates `needsApproval` from its original registration at `src/server/core/index.ts:1044-1059,1080-1102,1244-1252`. Thus a consumer-required approval added to the AI SDK descriptor can disappear from the protected descriptor even though the consumer left execute alone. The same overwrite can replace schema and descriptor metadata. The independently run benign probe covers the original approval and positive execution path. This failure is source-confirmed.

Preserve authorization-bearing descriptor properties or refuse altered descriptors unless the safe conversion can retain their behavior. Rebuild the result projection without replacing the current approval decision. Add coverage for a consumer that adds an approval requirement and a consumer that strengthens an existing predicate.

### High — Explicit managed bootstrap can silently use ordinary mode

**Merge regression.** `src/runtime/glirastes.ts:627-645,792-822` uses the presence of resolved connection configuration and treats an authenticated no-reference response as an exception to waiting. As a result, `privacy.managed: true` with no configured connection or with no reference environment can run the ordinary local policy. Separately, an authenticated stable ordinary deployment stored only in memory can satisfy `store.unavailable()` after a sync. `src/runtime/privacy-runtime.ts:82-89,116-119` only checks durable state for an actual protected block. Logging a missing store does not enforce the documented durable managed bootstrap requirement.

Gate the explicit choice independently of connected-mode detection. Require an authenticated environment, verified bootstrap and a usable durable store before releasing the gate, including when the verified policy permits ordinary processing.

### High — Retained durable privacy authority is invisible during an offline restart

**Merge regression.** `src/runtime/glirastes.ts:570-598,645-677` discovers the connection before it attaches the durable state store. On an offline restart without explicit activation, `store.hasPrivacyAuthority()` is false until attachment, even if the store contains a previously accepted protected floor. The first lookup failure ends the readiness wait and `privacyGate` permits local ordinary processing at `src/runtime/glirastes.ts:376-378,801-822,837-855`. The same absence affects state that fails to load before any authority can be observed. The former privacy parent gated on configured state storage. The new behavior removes that heuristic as intended but does not replace the discovery of retained authority.

Make the persisted, scoped binding discoverable independently of the first live lookup. Preserve ordinary startup for genuinely fresh inactive installations. Test a protected durable state across a process restart while connection discovery is unavailable and explicit activation is absent.

### Medium — Signed deployment scope lacks the expected application

**Privacy risk retained from the privacy parent.** `src/sync/sync-manager.ts:202-252,315-329` compares the envelope tenant/application fields only with one another. `src/sync/managed-sync.ts:104-139` knows the configured application but supplies only the environment to the manager and evaluates privacy before local bindings. The verifier authenticates the signed bytes with keys fetched from the runtime JWKS path. It does not bind the envelope to the configured application. A mismatched but consistently scoped, validly signed deployment for the expected environment can influence the floor under a response mix-up. A distinct environment or invalid signature is rejected before floor changes. No live Platform response behavior was assumed or tested.

Check the expected application and the authenticated tenant where available, including on restored state. Apply these checks before evaluating refusal or recording any floor, revocation or effective policy. The application scope check is independent of Platform-side filtering.

### Medium — Alternate protected tool shapes leave failure details available to model projection

**Incomplete merge fix.** The new protected `success: false` path replaces the failure details before ordinary conversion can clip them. `src/server/core/clean-tool-result.ts:45-53` recognizes only that explicit flag. The receipt logic at `src/server/pii-shield/tool-boundary.ts:164-182` also recognizes a string error alone. That latter shape is treated as a successful data shape at the converted boundary. Public native AI SDK tools wrapped with `wrapToolsForPrivacy` likewise return structured failure data unchanged. Downstream transformations can treat these results as ordinary model-bound JSON, so detection is the only protection for the content that survives the result processing. The protected endpoint converter also still reduces the failure body internally before cleaning, although its normal explicit-failure result does withhold it from the model.

Use a consistent protected failure contract across conversion, receipts and native-tool projection. Keep a separate, local backend-classification input if required and preserve the outcome-unknown marker. Test the model projection for the supported failure shapes as well as the receipt status.

### Medium — Execute-only provenance stops at the ESM/CommonJS module boundary

**Conversion regression and existing reader limitation.** `src/server/core/privacy-conversion.ts:1-19` and `src/server/core/result-reader.ts:1-16` store execute provenance in module-local weak collections. Both CJS and ESM are exported at `package.json:126-135`. The shared descriptor symbol survives ordinary spreads. An adapter retaining only the execute function across package formats loses that symbol and resolves its lookup in the other build's unrelated collection. That can leave the ordinary lossy converter or an SDK result reader active. A consumer that retains the original descriptor symbol gets the intended behavior.

Use cross-build provenance carried by the exact SDK execute function or another shared mechanism that is safe for the supported package formats. Keep the modified-execute refusal and test both CJS-to-ESM and ESM-to-CJS adapter directions with isolated synthetic data.

### Medium — Privacy release checks run after the tagged runtime image can be published

**Release integration gap.** `.github/workflows/publish.yml:54-62` allows image publication after preflight. Egress inventory and required PostgreSQL checks are added at lines 140–150 inside the job that depends on runtime-container. The downstream npm release is gated. The same tag can already have a published runtime image if those checks fail. The unreleased note and API surface preflight are shared across both artifacts.

Put required privacy verification ahead of every publication action for the tag. Keep packaging and native STT checks in the dependency graph.

### Low — Protected diagnostic names and passed-through error objects can carry content

`src/server/pii-shield/detection-result.ts:78-105` describes an allowlist, but accepts arbitrary identifier-shaped names. `src/server/pii-shield/chat-privacy.ts:172-182` returns any object recognized as a privacy error unchanged, including a duck-typed error with unrelated properties. In the protected Next.js path those values can reach the diagnostic callback at `src/server/adapters/nextjs/create-ai-chat-handler.ts:1484-1496`. This predates the merge, and the added/ported Nest logging relies on similar assumptions about `Error.name`. No direct provider egress through these callbacks was established. The protected callback contract promises name, code and optional numeric status only.

Create a new diagnostic object for every error, keep only enumerated class names and known codes, and avoid passing through raw error fields.

### Low — Ordinary local transcription inherits the protected queue defaults

`src/server/adapters/nextjs/recording-transcription-handler.ts:313-319,340-365` applies the new concurrency-two, queue-eight gate, WAV prevalidation and an upload-inclusive timeout to ordinary as well as protected local transcription. Upstream's local transcriber had no SDK queue and started its transcription timer after reading audio. The added ordinary regression checks long audio, which remains allowed by default. It does not protect the upstream concurrency or timing behavior. Also check the managed speech snapshot at dispatch time if the release requires policy changes to stop requests already waiting or uploading. At present the route reads policy once before either wait.

Preserve upstream defaults for an ordinary request unless the consumer configures limits. Apply the required speech limits under an active privacy policy.

## Reviewed paths and independent checks

- Compared both parent directions and the merge resolution. The upstream-relative change has 133 files. The privacy-parent-relative change has 672 files, mostly upstream changes. This is a security-focused review of the stated scope and supporting code.
- Followed Next.js through the Node bridge, request policy selection, attachment admission, routing, local classifier model binding, the protected provider adapter boundary, approvals, UI/history projection and error hooks. Reviewed the upstream composer/mention shape and direct commands, declaration detection for approval subject and preview lookups, middleware, result handles and the package conversion paths. The Node bridge, React and view-context implementation are byte-identical to the fixed upstream parent. The executable protected runtime consumes no view-context entries at this base.
- Checked the signed-policy verifier, privacy floor and revocation joins, runtime/handler effective policy digest, mapping generation and scoped deletion, history binding, approved input rehydration, receipts, telemetry suppression and release workflow ordering. Retained features and positive tests do not close the findings above.
- The protected default handler refuses mention markers, middleware, recognized direct commands and configured approval lookups before provider fetch. The supplied serialized Node canary test shows ordinary raw behavior and protected redaction for the checked explicit-failure shape. Approval preview behavior is covered in the ordinary handler tests. Existing tests check protected memory and default result-handle refusal.
- Independent focused run on four privacy files passed 38 tests, with one intentionally skipped database receipt test because this runner did not set a PostgreSQL URL. A second focused run on approval subjects, recording, view context and mention contracts passed 618 tests in four files. A separate positive scratch probe passed dormant absent/false activation without provider discovery and ordinary copying of a converted tool whose original approval remains required. Model egress inventory reported 60 sites and zero violations.
- Main worker separately reported the required isolated PostgreSQL full suite exited zero after 169.87s, with 539 files passed, seven skipped, 8,297 tests passed, 17 expected failures and 58 skips. The shared log is `/tmp/privacy-sdk-8d01c6ac-full.log`. Its aggregate counts do not identify every skip. This review did not run or overlap that suite and did not touch PostgreSQL.
- `git diff --check` reports an extra EOF blank line in `src/server/pii-shield/tool-boundary.ts` against the fixed parent, and four upstream EOF blank lines against the privacy parent. No tracked files were modified. No dependency installation, package build, containers, release, production test, remote action, live vendor data, or exploit reproduction was performed. Findings are based on source analysis. The positive checks use synthetic local fixtures. No independent claim is made about Platform or provider deployment, retention or live acceptance.

## Commands

```sh
git show -s --format='%H%n%P%n%s' 8d01c6ac1cf800e46ec8eebe87975037bf8c0544
git rev-parse '8d01c6ac^{tree}'
git status --short --untracked-files=no
git diff --name-status 8d01c6ac^2 8d01c6ac
git diff --stat 8d01c6ac^1 8d01c6ac
git show --remerge-diff 8d01c6ac
git diff --check 8d01c6ac^1 8d01c6ac
git diff --check 8d01c6ac^2 8d01c6ac
tail -24 /tmp/privacy-sdk-8d01c6ac-full.log
npm_config_offline=true npm exec --yes --package=bun@1.4.5 -- bun /tmp/privacy-sdk-8d01c6ac-benign-probe.ts
npm_config_offline=true npm exec --yes --package=bun@1.4.5 -- bun run check:egress
npm_config_offline=true npm exec --yes --package=bun@1.4.5 -- bun run test --no-cache \
  src/server/adapters/nextjs/__tests__/privacy-node-port.test.ts \
  src/server/adapters/nextjs/__tests__/privacy-opt-in.test.ts \
  src/server/pii-shield/__tests__/tool-boundary.test.ts \
  src/server/core/__tests__/privacy-reader-boundary.test.ts
npm_config_offline=true npm exec --yes --package=bun@1.4.5 -- bun run test --no-cache \
  src/server/adapters/nextjs/__tests__/approval-subjects-handler.test.ts \
  src/server/adapters/nextjs/__tests__/recording-transcription-handler.test.ts \
  src/contracts/view-context.test.ts \
  src/contracts/mention-marker.test.ts
```
