# SDK port baseline exceptions (2026-11-23)

Baseline source: `f29b3607d8576dc0fec07258af43cf48b6698c2a`, detached owned worktree `/tmp/glirastes-privacy-baseline-f29b3607`.
Prepared baseline: Bun 1.4.5, frozen dependencies, SDK build, Nest fixture and pg floor fixture; owned loopback PostgreSQL with GLIRASTES_REQUIRE_POSTGRES=1.
Full prepared baseline: **7608 passed, 17 expected failures, 58 skipped**, 513 passed / 7 skipped files, exit 0, 160.82s. Log `/tmp/privacy-sdk-f29b3607-full-baseline-prepared.log`; machine report `/tmp/privacy-sdk-f29b3607-full-baseline.json`.
The first unprepared baseline lacked built output and fixture dependencies and failed; it is not a source-regression result (`/tmp/privacy-sdk-f29b3607-full-baseline.log`).

The previously reported SDK8d01c6ac gate has the identical aggregate exceptions (58 skipped, 17 expected failures). The final fixed candidate must separately run the full required-PG gate and compare its exception identities. No privacy or PostgreSQL acceptance test is waived by this list.

## Every skipped test

### tests/second-acceptance-vue-fastapi-languages.test.ts

7 tests. Optional Python/FastAPI fixture readiness was unavailable. Source byte-identical to fixed upstream: True.

- second acceptance fixture: texts in three languages mixes endpoint titles and tool-semantics.json per language, the maintained entry first
- second acceptance fixture: texts in three languages reports the languages without an own label once per language, never failing the check
- second acceptance fixture: texts in three languages keeps every translation out of the setup artifact the Platform receives
- second acceptance fixture: texts in three languages exports the labels per language and indexes the Polish synonyms for the search only
- second acceptance fixture: the chat in the request language words the tools in Polish where declared and in English where Polish is missing
- second acceptance fixture: the chat in the request language words the tools in German, with the German title of tool-semantics.json
- second acceptance fixture: the chat in the request language keeps the part of before for a request without a language: the manifest locale and its labels

### tests/second-acceptance-vue-fastapi-ui-outcomes-reload.test.tsx

1 tests. Optional Python/FastAPI fixture readiness was unavailable. Source byte-identical to fixed upstream: True.

- second acceptance fixture: a navigation that loads a new page saves initiated before location.assign and continues the turn once on the new page

### tests/second-acceptance-vue-fastapi-ui-outcomes.test.ts

5 tests. Optional Python/FastAPI fixture readiness was unavailable. Source byte-identical to fixed upstream: True.

- second acceptance fixture: outcome protocol of the generated navigation tool generates ui_navigate with the Glirastes navigation action
- second acceptance fixture: outcome protocol of the generated navigation tool with the flag: marks the result awaitsOutcome, ends the request after the step, calls the model once
- second acceptance fixture: outcome protocol of the generated navigation tool continues after the reported outcome ok with its fixed text only
- second acceptance fixture: outcome protocol of the generated navigation tool continues after the reported outcome unavailable with its fixed text only
- second acceptance fixture: outcome protocol of the generated navigation tool without the flag (an older client, a custom client on /server/http): the 0.17.3 shape without marker, the model writes on

### tests/second-acceptance-vue-fastapi.test.ts

33 tests. Optional Python/FastAPI fixture readiness was unavailable. Source byte-identical to fixed upstream: True.

- second acceptance fixture: generated tools generates every playlist, channel and user route with its risk, and the check is clean
- second acceptance fixture: generated tools gives every endpoint tool the app-wide **.fileUrl deny, and the playlist list its allow-list and default view
- second acceptance fixture: generated tools seeds the same data on every start: 60 playlists, every 10th with 64 items, signed file URLs
- second acceptance fixture: results the model sees lists 60 playlists as an overview with a handle, ids and names kept, file URLs nowhere
- second acceptance fixture: results the model sees denies fileUrl in nested items: a get, and read_result over all items and one indexed entry
- second acceptance fixture: results the model sees answers a missing playlist with a 404 failure the model can read, and refuses a non-integer id
- second acceptance fixture: results the model sees keeps a `key` with its title in an overview and beyond maxItems in the history
- second acceptance fixture: results the model sees SA-01 (fixed in 0.17.2): the history keeps playlist_id beyond maxItems, so "entry 14 of that list" has its id
- second acceptance fixture: results the model sees SA-02 (fixed in 0.17.2): an overview under size pressure keeps playlist_id with the names
- second acceptance fixture: results the model sees SA-03 (fixed in 0.17.2): read_result names the entries it reads below the array with their playlist_id
- second acceptance fixture: approval subjects names a user by its `id` with its displayName, with and without declarations
- second acceptance fixture: approval subjects SA-04 (fixed in 0.18.0): a listed playlist is named on the card by its declared playlist_id
- second acceptance fixture: approval subjects without declarations a listed playlist stays `unknown` (the field-name fallback, as before)
- second acceptance fixture: approval subjects SA-05 (fixed in 0.17.2): id 3 of a user, a playlist and versions names the kind the call picks, or none
- second acceptance fixture: approval subjects with declarations id 3 collides only between the user and the playlist; a version is no candidate
- second acceptance fixture: approval subjects SA-06 (fixed in 0.18.0): a channel deleted by its declared `key` gets a typed, named subject
- second acceptance fixture: approval subjects without declarations a channel deleted by its `key` gets no subject (as before)
- second acceptance fixture: approval subjects SA-07 (fixed in 0.18.0): a listed version is `seen` with its declared fallback "Version number 3"
- second acceptance fixture: approval subjects without declarations a listed version stays `unknown`; under `id` it would be seen (as before)
- second acceptance fixture: approval subjects SA-08 (fixed in 0.18.0): a revision is `seen` with its declared fallback `rev`
- second acceptance fixture: approval subjects without declarations `rev` is no fallback, even for a record seen under `id` (as before)
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) SA-04 through the server: delete_playlist(7) is named by get_playlist, with a v2 approval id
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) SA-04 through the server: a playlist that does not exist gets no card, the model gets not_found
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) SA-05 through the server: id 3 is the playlist "Lobby Loop", never user 3
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) SA-06 through the server: delete_channel by key over the complete list_channels; a missing key is refused
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) SA-07 through the server: roll_back_playlist(3, 303) finds version_id 303 in its playlist's versions
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) SA-08 through the server: revision 503 of channel lobby is seen as "Rev 3"
- second acceptance fixture: server approval subjects (docs/approval-subjects.md) list-page case: a user missing from the one page list_users reads is not checkable, never "does not exist"
- second acceptance fixture: ids in the answer (hideIds) SA-09 (fixed in 0.18.0): declared integer ids are learnt, so "(ID: 3)" leaves the answer; a bare number stays
- second acceptance fixture: ids in the answer (hideIds) without declarations integer ids are never learnt, so "(ID: 3)" stays (as before)
- second acceptance fixture: runtime wiring keeps the model unconfigured without ACCEPTANCE_MODEL and builds an OpenRouter chat model with it
- second acceptance fixture: runtime wiring keeps the CI limits by default and offers the acceptance and SDK-default profiles
- second acceptance fixture: runtime wiring stops a fan-out over every playlist at the SDK-default tool-call limit with a German notice

### tests/tool-sync-vue-fastapi-ui.test.ts

6 tests. Optional Python/FastAPI fixture readiness was unavailable. Source byte-identical to fixed upstream: True.

- Vue+FastAPI navigation change corpus adds a route: the same navigation tool offers it at once, without confirmation
- Vue+FastAPI navigation change corpus changes a route path: the old destination is refused, the new one works
- Vue+FastAPI navigation change corpus removes routes: a removed destination is refused, and without routes the tools are tombstoned
- Vue+FastAPI filter change corpus adds a query filter: a new tool, active at once with defaults and no plan confirmation
- Vue+FastAPI filter change corpus changes a filter domain: same identity, the new value works after refresh
- Vue+FastAPI filter change corpus removes a filter: tombstoned, absent from the runtime, a direct call is unavailable

### tests/tool-sync-vue-fastapi.test.ts

4 tests. Optional Python/FastAPI fixture readiness was unavailable. Source byte-identical to fixed upstream: True.

- Vue+FastAPI endpoint change corpus adds a router: active at once with defaults, inside the user session, rejected without one
- Vue+FastAPI endpoint change corpus changes a Pydantic model: same identity, the new schema is enforced after refresh
- Vue+FastAPI endpoint change corpus removes a route: tombstoned, absent from the runtime, a direct call is unavailable
- Vue+FastAPI agentic entry answers through the Node chat runtime, its tool calling FastAPI with the caller's cookie

### src/codegen/tools/openapi-3-0.test.ts

1 tests. External OpenAPI fixture not present. Source byte-identical to fixed upstream: True.

- an external OpenAPI export (GLIRASTES_TEST_OPENAPI_SPEC) completes with compilable input schemas

### src/server/adapters/nextjs/__tests__/ui-result-shape-v0173/record.test.ts

1 tests. Golden recording is explicitly disabled in ordinary test runs; replay tests remain active. Source byte-identical to fixed upstream: True.

- record the glirastes 0.17.3 golden stream writes golden-0.17.3.json

## Every expected failure

These are upstream-known UI history races (12) and mention attack-path tests for deferred upstream PR2/PR3/PR4 behavior (5). The protected SDK profile refuses mention requests before egress; protected history admission remains independently tested. They are not reclassified as successful privacy acceptance.

### tests/mention-marker-attack-paths.test.ts

Source byte-identical to fixed upstream: True.

- Line 117: `it.fails('write path: a label adds no entry the app never listed (PR4, context block v2)', () => {`
- Line 126: `it.fails('A1: the bubble shows the block as visible text of the chip (PR2, React read path)', () => {`
- Line 130: `it.fails('A1: the model copy carries no hidden block (PR3, server model copy)', async () => {`
- Line 134: `it.fails('A3: a clarification marker inside a mention is no answer (PR3, clarification anchor)', () => {`
- Line 138: `it.fails('A5: `}}` in a stored label hides no block from the bubble only (PR3, server model copy)', async () => {`

### src/react/__tests__/left-chat-patterns.test.tsx

Source byte-identical to fixed upstream: True.

- Line 169: `it.fails('KNOWN DEFECT A to B to A while A streams: A\'s turn is recorded as completed when it ends in A', async () => {`
- Line 235: `it.fails('KNOWN DEFECT back in A while A and B stream: stop() records the aborted outcome on A\'s turn', async () => {`
- Line 253: `it.fails('KNOWN DEFECT A to B to A while A streams (B never sends): stop() records the aborted outcome on A\'s turn', async () => {`
- Line 314: `it.fails('KNOWN DEFECT A to B while A streams, A ends in the background, then A again: A shows and stores the whole answer', async () => {`
- Line 450: `it.fails('KNOWN DEFECT C2b with a slow load: while it loads the chat never shows the answer without its question', async () => {`
- Line 470: `it.fails('KNOWN DEFECT C2c with a slow load and a chunk arriving while it loads: the next request carries one answer', async () => {`
- Line 509: `it.fails('KNOWN DEFECT C2c: neither the stored history nor the next request carries the loaded partial answer next to the streamed one', async () => {`

### src/react/__tests__/left-chat-defect.repro.test.tsx

Source byte-identical to fixed upstream: True.

- Line 64: `it.fails('fake transport: B shows, stores and sends nothing of A; A\'s store gets the answer and the outcome', async () => {`
- Line 84: `it.fails('Vercel transport: B shows, stores and sends nothing of A; A\'s store gets the answer and the outcome', async () => {`
- Line 117: `it.fails('A loads with its answer and the notice of how its turn ended', async () => {`
- Line 142: `it.fails('pipeline state and steps of A\'s request do not reach B', async () => {`
- Line 202: `it.fails('a continuation request of chat A carries sessionId A, also when B is active by then', async () => {`
