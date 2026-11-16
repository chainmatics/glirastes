# Fieldwork DX regression (2026-11-15)

Baseline: SDK origin/main `9f0772d` (0.14.0). Original external evidence remains unchanged in `fieldwork-glirastes-lab/evidence`. Retests use an isolated consumer with new fictional SQLite data; no production deployment or npm publication.

| Finding | Initial classification | Evidence / disposition |
| --- | --- | --- |
| UI handler false reported executed | SDK defect reproduced in current source | generated-ui-tool and legacy core return execution claim before browser dispatch |
| Missing worklet / literal mic | SDK integration and presentation defect | fixed root asset URL and text icon in current source |
| Budget stop not understandable | SDK presentation gap | pipeline-state exists but hidden in activity or absent after reload |
| Short IDs in approval | SDK presentation gap | short IDs not resolved despite available authorized tool outputs |
| Command markers in title | SDK presentation defect | structured text used directly by title derivation |
| Origin mismatch | App defect, corrected externally | no SDK origin weakening |
| Strict approval selector / overlapping edit | Test/App defect | not an SDK persistence regression |
| Invented customer options / job_003 | Model behavior | retrieve identifiers; SDK must not turn rejection into execution success |
| Zod 3 missing converter plus wrong shape diagnosis | SDK diagnostic defect reproduced | generator-before.log: two failing regression tests |
| Next 15 + TypeScript 7 | Framework compatibility | npm currently resolves TS 7.0.2; validate the locked consumer build, no unversioned TS recommendation |
| 82/84 routing | Authored corpus, not independent benchmark | retain baseline, add held-out paraphrases separately |
| Existing approval/session continuation fix | Already fixed before this task | origin/main includes #56; preserve guards |

## Verified results

- Fresh npm-installed tarball consumer: Next 15.5.29, React 19.3.1, TypeScript 6.0.3, Zod 4.6.7; production build and typecheck pass. This checks current compatibility rather than repeating an old pin.
- SDK consolidated suite with Python 3.12 enabled: 339 files passed, 3,892 tests passed, six conditional tests skipped. Final run is recorded in `sdk-tests.log`; skipped tests need their external environment. Subsequent review fixes also have focused regression/typecheck evidence.
- Consumer `tools check`: 14 tools match source. `doctor`: local checks pass, one expected demo-auth review warning. Routing remains 82/84 on the unchanged external corpus (two documented ambiguities); no synonym tailoring to make this number green.
- Independent held-out DE/EN corpus: 7/8 initially selected; 1/1 recovered by deterministic discovery. Average 10.125 active tools out of 101, maximum 11; four ambiguity checks. This measures selection availability, not model answer quality.
- Real OpenRouter three-read plan: complete final summary after 7 model steps, 33,117 input + 1,383 output = 34,500 tokens, 24.1 s in a dev consumer including endpoint compilation. Baseline external success: 7 steps, 33,453 tokens. Tool calls: five plan updates, three domain reads, one find_tools. No demonstrated token or step reduction; do not increase defaults on this sample. Plan batching guidance is an optimization opportunity, not a measured saving.
- Deterministic browser SSE uses the packed SDK and real Fieldwork handlers: wrong ID rejected with no highlight, correct ID succeeds, reload retains receipts without replay; 6/6 budget stop and partial checklist remain visible after reload at 390px.
- Speech browser: real missing nonroot worklet asset produces localized diagnostic and releases its stream/context. Retry through real OpenRouter produces a draft with zero chat requests. Cancel, route change, session change and resource release tested; synthetic microphone, not hardware qualification.
- SDK security audit: zero high/critical after targeted Zod and fast-uri updates; three pre-existing low AI-SDK dependency findings remain. The fresh Next 15 consumer audit still reports one high PostCSS finding and two propagated moderate findings (next/glirastes), with no offered fix in that dependency tree; consumer production security acceptance remains open. Approval signatures, endpoint authorization and tenant checks are unchanged.

## Release boundaries

No npm publication or deployment. `success:true` on UI tools remains a compatibility request-creation flag, paired with `executionStatus:'unconfirmed'`. Browser outcomes are local observations, never authorization. Arbitrary model prose can still be wrong; stored historical free-form assistant statements are not rewritten. A timeout cannot roll back an already-running app handler. Exactly-once mutations across new requests need application idempotency and reconciliation.

The original Fieldwork app/evidence are unchanged. Consumer-only changes: tarball installation, port/origin 3218, public asset export at `/assets/speech.js`, removal of obsolete CSS icon workarounds and redundant explicit newTitle. Tests use new fictional SQLite data. Reproduce browser scripts from a running prepared Fieldwork consumer; they contain no credentials. Original live attachment/approval tests remain external baseline evidence; unchanged SDK approval/attachment regression suites run in the full gate.

Final independent review: 90/100, no findings; review is not a substitute for tests. Two rounds exposed missing short-ID entity scope and hidden-field handling; fixed with red/green tests. 39 focused package/approval/skill checks passed after those fixes. Short IDs require explicit field-scoped maps (`entityNames`); no unsafe global cross-entity inference.

Consumer retest uses a clean `.next` build: repeated installation of a local tarball with the same unreleased version can leave Next's node_modules compilation cache stale. The final browser test also asserts that completed/rejected UI actions do not display a pending-approval label.
