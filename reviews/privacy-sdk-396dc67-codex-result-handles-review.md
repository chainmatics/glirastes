# Independent Codex review — result-handles privacy merge

Reviewer: **Codex**, not Opus. Date: 2026-11-17. Read-only: no implementation edits, commits, subagents, installs, full-suite execution, database operations or consumer-artifact replacement.

## Immutable scope

Reviewed SDK merge **`396dc67bbeb67c94ba9606ef04dc7852454ac341`**, parents `d365e2092f990bedcd0c9fd4e17e3ae327f9f44e` and upstream `7796c2295f6088c7d9667abbba3ced8f58244226` (#76 result handles). Prior reviewed checkpoint: `00afd67e29e44e2fb60a436daff654d385f06d5e`; the intervening first-parent change is acceptance documentation. Checkout: `/Users/philipprollmann/orca/workspaces/glirastes/pii-stage1`. HEAD remained the requested merge throughout verification and the final working tree was clean.

**Two actionable findings:** High F1, incomplete protected-reader enforcement through public entry points; Medium F2, standalone owner-bound readers do not enforce the current owner. The handler-generated normal protected path passed the committed matrix, but these additional compositions are not covered by that matrix.

## F1 — High: SDK result readers can execute inside a protected turn and leak clipped identities

### Affected locations

- `src/server/core/read-result-tool.ts:529–537`: reader recognition records only the factory's returned object in a WeakSet.
- `src/server/core/index.ts:1049–1053`: protected refusal relies exclusively on that object identity and on the `protectedResults` option.
- `src/server/pii-shield/tool-boundary.ts:90–102` and its subsequent execute dispatch: exported `wrapToolsForPrivacy` has no result-reader refusal or provenance propagation. This existing boundary becomes reachable with the newly added SDK reader in this merge.

### Reproduced paths

**1. Ordinary tool copying/renaming bypasses the Next protected refusal.** Create an SDK reader, then register `{ ...reader, id: 'renamed_reader' }` in a protected `createAiChatHandler`. The execute function remains the SDK reader, but the new object is absent from `RESULT_READERS`. A known full identity is stored in a result exceeding its 1,000-character read budget. `read_result` clips it before the privacy model boundary runs; the full known identity no longer matches, and the identifying prefix is transmitted.

The independent reproduction adapts the exact committed transport fixture, changes only the reader registration to the copied/renamed tool, and captures actual OpenAI adapter serialized HTTP requests through synthetic fetch. Results:

| Stored state | SDK reader executed | Raw known-identity prefix in provider request |
| --- | --- | --- |
| current | yes | yes |
| foreign owner | yes | yes |
| expired privacy mapping generation | yes | yes |
| deleted result store | yes | no; answers result_expired |

All four expected-refusal assertions fail; three cases demonstrate actual serialized egress of the synthetic prefix. The existing renamed-reader core test changes the registry name while retaining the original object, so it does not exercise object copying.

**2. The exported privacy wrapper permits direct and converted readers without any copy.** Supply `createReadResultTool(store)` directly to `wrapToolsForPrivacy`, or first convert it using the normal `toolToAiTool(reader, context, name)` call without `protectedResults`. The boundary runs the reader and returns its clipped output. Sending that output through `createPrivacyBoundary(...).wrapModel(realOpenAIAdapter)` makes one captured serialized provider request containing the raw synthetic identity prefix in both cases.

Positive controls pass: the same wrapped model masks the full ordinary tool result, and conversion with explicit `protectedResults:true` refuses the reader. The leak is therefore caused by incomplete result-reader enforcement, not a disabled model privacy boundary in the probe. These are exported lower-level API compositions; no unsupported Nest protected path is asserted.

### Preconditions and impact

A consumer must register a copied SDK reader in the Next handler, or compose the exported protected tool/model boundaries with a direct or normally converted SDK reader. The default handler-created protected turn does not create a result store or built-in reader and remained safe in the tested matrix. No attacker-controlled JavaScript registration is assumed: tool copying for customization and ordinary core conversion are consumer setup actions; the model then supplies the read arguments. With that setup, the unsupported retrieval path sends identifying fragments to the provider despite active protection and a registered complete identity. Only synthetic canaries and local fetch captures were used; no real person's information was sent.

### Proposed correction/regressions

Preserve recognizable reader provenance through supported tool copies/conversions and refuse SDK retrieval at the exported protected boundary itself, before rehydration, receipt handling or reader execution. Tracking only the original Tool object does not cover copying, while adding a check only in Next does not cover the lower-level API. Test the original reader, copied/renamed reader, converted reader with and without protectedResults, and the exported wrapper, with actual serialized HTTP assertions for current/foreign/deleted/expired-generation cases. Keep positive ordinary-result protection, effective-off retrieval and explicit unsupported responses. This is not a request to implement protected retrieval in this checkpoint.

## F2 — Medium: standalone SDK reader ignores the configured store owner during reads

**Location:** `src/server/core/read-result-tool.ts:513–523`, particularly the optional `guard.beforeRead` at line 518. Related public contract: `src/server/core/result-store.ts:51–59` promises owner comparison on every read.

Create `createResultStore({ owner: async () => currentOwner })`, store a result with the correctly captured Alice/tenant-A owner, then use the public `createReadResultTool(store)` and ordinary core conversion. Change currentOwner to Bob, to tenant B, or to undefined. In all three cases, reading the known result handle still returns Alice's selected private field. Matching-owner retrieval also succeeds as expected.

The owner callback is checked at insertion, but the standalone reader never calls it. The optional guard defaults to an empty object, so no owner condition executes. This is independently reproducible without F1, with no copied tool and in effective-off mode: authentication/tenant isolation must not depend on whether PII protection is enabled.

**Scope:** default handler-managed readers use `createTurnResults`' separate fresh-principal guard and passed existing subject/tenant tests; this finding concerns consumers of the exported owner-aware store/reader APIs. It requires a valid handle and an owner change while that store is still alive, not handle guessing or a demonstrated bypass of the default managed handler. The documentation and owner-bearing store give these consumers a misleading enforcement guarantee.

**Proposed regression/correction:** enforce store owner equality for standalone reader access whenever the store is owner-bound, including missing principals and tenant changes, immediately before projection. Retain handler budget/revocation checks as additional guards. Add positive same-owner and negative changed-subject/tenant/missing-owner cases through `toolToAiTool(createReadResultTool(store))`.

## What the merge preserves in the tested default paths

- `loadCurrentRevocations` still invokes current `privacyGate`; `beforeModelStep` remains passed to pipeline and legacy stream handlers. The off-to-revoked transport case stops before the third provider request.
- Both handler branches disable result stores and built-in readers whenever `privacyTurn` exists, even for explicit `resultHandles:true`. Core protected conversion ignores an injected store and refuses original factory reader objects, including a changed registry name.
- Protected oversized ordinary tool results retain outputWithheld without repeating the original execution. Effective off preserves handles/retrieval; configured off and locally stricter off remain distinguished.
- Store insertion snapshots values and reserves quotas before await; handle owners are captured before the origin tool. Managed handler retrieval rechecks principal, authorization/revocation and budgets. Turn stores clear on stream completion, failure and cancellation. The adjusted cleanup test now triggers a controlled stream error after its initial positive read, avoiding the former assertion race.
- Projection uses own-property checks and defined own properties, and tests cover paths, slices, paging and metadata. This was a bounded review of integration/security and its direct dependencies, not an exhaustive proof of every projection/overview algorithm case.
- Inventory independently reports 56 reviewed egress sites and zero violations. That confirms inventory consistency, not absence of data leaks within an existing call site, as F1 demonstrates.

## Independent commands and evidence

```sh
git rev-parse 396dc67 HEAD d365e20 7796c22
git diff --name-status d365e20 396dc67
git show --cc --format=short 396dc67 -- src/server/adapters/nextjs/create-ai-chat-handler.ts src/server/core/index.ts
git diff --check d365e20 396dc67
bunx --no-install vitest run src/server/adapters/nextjs/__tests__/privacy-result-limit.test.ts src/server/core/privacy-result-handles.test.ts src/server/adapters/nextjs/__tests__/result-handles-handler.test.ts src/server/core/result-handles.test.ts > /tmp/privacy-sdk-396dc67-focused.log 2>&1
bunx --no-install vitest run --config /tmp/privacy-sdk-396dc67-review/vitest.config.mjs /tmp/privacy-sdk-396dc67-review/cloned-reader.test.ts > /tmp/privacy-sdk-396dc67-review/cloned-reader.log 2>&1
bunx --no-install vitest run --config /tmp/privacy-sdk-396dc67-review/vitest.config.mjs /tmp/privacy-sdk-396dc67-review/owner.test.ts > /tmp/privacy-sdk-396dc67-review/owner.log 2>&1
bunx --no-install vitest run --config /tmp/privacy-sdk-396dc67-review/vitest.config.mjs /tmp/privacy-sdk-396dc67-review/lower-boundary.test.ts > /tmp/privacy-sdk-396dc67-review/lower-boundary.log 2>&1
bun run check:egress > /tmp/privacy-sdk-396dc67-review/egress.log 2>&1
```

The first cloned-reader execution used the same scratch config without a filename filter while it was the only test file; the listed filtered command reproduces it. All probes/configuration are archived in that `/tmp` directory, with no repository edits.

Results:

- Committed focused suites: **190 passed / 4 files**, exit 0, 5.81 seconds. Includes the imported snapshot fixture tests; these are not 190 distinct transport cases.
- Additional cloned-reader suite: **4 failed / 4**, intentional expected-refusal assertions expose F1 path 1, exit 1.
- Additional lower-boundary suite: **2 failed / 2 passed**, exit 1, exposes F1 path 2 plus two positive controls.
- Additional owner suite: **3 failed / 1 passed**, exit 1, exposes F2 plus matching-owner control.
- Diff whitespace check passed; egress **56 sites / 0 violations**, exit 0.

Reviewed source SHA-256:

- `src/server/core/read-result-tool.ts`: `8c06d4b0e476427bf7ccb97f6fce57dcf6353beae81980c552e432abd09cebac`.
- `src/server/core/index.ts`: `7283a54c307a2cfb21b255504402a514d2d5df0282bee1b9dcdf700bf65e3425`.
- `src/server/adapters/nextjs/create-ai-chat-handler.ts`: `a4519db7d0b4b3f525077e4078d212e983324a0e0743bb761cbe42b6e1f6782d`.

## Attribution and acceptance limits

Coordinator-reported full PostgreSQL gate of 5,178 passed / 11 existing skips and build/typechecks are not reviewer runs. No additional full PostgreSQL or consumer suite was started. Transport probes execute the real provider adapter serialization with controlled local fetch responses, not a live provider. In-memory mapping stores make this a result-reader boundary review, not renewed durable PostgreSQL/DR acceptance.

The incoming 1,729-file GID candidate archive, reported SHA-1 `3218b574b0787c35c86582126a1099ceaecf6d32`, was not independently accepted or installed by this reviewer. Prior 1,699-file candidate acceptance cannot be carried forward across this runtime change. F1/F2 need remediation and independent verification before treating this merge as the settled delivery basis; release, clean public-package consumer acceptance and live deployment remain separate gates.
