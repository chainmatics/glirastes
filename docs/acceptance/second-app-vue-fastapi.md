# Second acceptance app: Vue + FastAPI

A fixed second acceptance run for every release, in the reference app
`examples/vue-fastapi/`. Its data shapes deliberately differ from the pilot
app (NestJS, OpenAPI, UUID ids under `id`/`name`, German UI, gpt-4o), to find
where the SDK only fits the pilot's shapes.

- The live run does **not** gate a release. It is recorded and compared with
  the previous release's record.
- The model-free part runs in CI (job "Reference app Vue+FastAPI"):
  `tests/second-acceptance-vue-fastapi.test.ts`.
- SDK findings are reported, not silently fixed. Each known gap is a test titled
  `KNOWN GAP SA-nn` that asserts today's behaviour; a fix makes it fail visibly,
  then the test changes to the fixed behaviour and the gap leaves the list below.

## Fixture

`examples/vue-fastapi/api/app/library.py`, seeded deterministically per user on
the first request; nothing is stored, so restarting the API resets every delete
and rollback. Tasks (`api/app/tasks.py`) stay as they were.

| Entity | Shape | Why it differs |
| --- | --- | --- |
| Playlist | `{playlist_id: int, displayName, status, ownerKey, items: [{item_id: int, displayName, durationSec, fileUrl}]}`, 60 per user, every 10th with 64 items | integer id under `<entity>_id`, `displayName`, nested items, the list exceeds the default `maxResultChars` (16,000) |
| Channel | `{key: "lobby", title, playlist_id, live}` (`lobby`, `foyer`, `cafeteria`) | slug-like string id under `key` |
| PlaylistVersion | `{version_id: int, versionNumber: int, playlist_id, createdAt}`, 4 per playlist (`version_id` = playlist × 100 + number) | no name at all |
| ChannelRevision | `{revision_id: int, rev: int, channelKey, createdAt}`, 3 per channel (lobby: 501–503) | `rev` instead of `versionNumber` |
| User | `{id: int, displayName}`, ids 1–5 | integer ids that collide with playlist ids |

Names: playlist 3 is "Lobby Loop", 7 "Weekend Loop", 14 "Opening Loop"; the
`lobby` channel plays playlist 3. `fileUrl` is a signed-looking URL
(`…?X-Amz-Expires=900&X-Amz-Signature=<64 hex>`) and must never reach the model
or the chat.

Routes (tool name, risk): `GET /api/playlists` (`playlists.list`; `limit`,
`offset`, `status`), `GET /api/playlists/{playlist_id}` (`playlists.get`, 404 for
an unknown id), `DELETE /api/playlists/{playlist_id}` (`playlists.delete`, asks),
`GET /api/playlists/{playlist_id}/versions` (`playlistsVersions.list`),
`POST /api/playlists/{playlist_id}/versions/{version_id}/rollback`
(`playlistsVersionsRollback.create`, asks), `GET /api/channels` (`channels.list`),
`DELETE /api/channels/{key}` (`channels.delete`, asks),
`GET /api/channels/{key}/revisions` (`channelsRevisions.list`),
`POST /api/channels/{key}/revisions/{revision_id}/rollback`
(`channelsRevisionsRollback.create`, asks), `GET /api/users` (`users.list`),
`DELETE /api/users/{user_id}` (`users.delete`, asks).

Output fields: `.glirastes/tools.json` denies `**.fileUrl` app-wide; the playlist
list declares an allow-list (`x-glirastes-output-allowed-fields`) and a default
view of `playlist_id`, `displayName`, `status` and `total`
(`x-glirastes-output-default-fields`), see [tool policy](../tool-policy.md).

After changing the routes: `python3 export_openapi.py` in `api/`, then
`glirastes tools refresh --root examples/vue-fastapi`. The generated outputs
under `.glirastes/` are not committed (the tests and the run script regenerate
them); `api/openapi.json` is.

## Running it

`examples/vue-fastapi/README.md` describes the start. Environment variables
(names only): `ACCEPTANCE_MODEL`, `OPENROUTER_API_KEY`, `ACCEPTANCE_LIMITS`
(`fixture`, `acceptance`, `sdk-default`), `ACCEPTANCE_LOCALE`, `PYTHON`.

Models, both through OpenRouter's OpenAI-compatible API (`runtime/model.mjs`):

- Baseline: `openai/gpt-4o`.
- Second model: a Claude model (record the exact OpenRouter id).

Limits: every case runs with `ACCEPTANCE_LIMITS=acceptance` (20 tool calls, 10
model steps, 120,000 input tokens, 10 steps) except case 14, which runs with
`sdk-default` (exactly what an app gets without setting a limit). German cases
run with `ACCEPTANCE_LOCALE=de-DE`.

## Run protocol

1. Restart the API before each case (fresh seed), and start a new chat.
2. Run each case **3 times per model**. A run passes when every point in
   "Expected" holds. Record the pass rate (`2/3`), not a single verdict.
3. For each failed run, record what happened in one line (tool calls in order,
   what the chat showed). Copy no tokens, cookies or keys into the record.
4. Compare with the previous release's record: a drop of one run is variance
   until it repeats; a drop of two or more, or a drop in both models, is a
   regression to report. A known gap (below) that stops showing is reported too.
5. Write the record from the template:
   [`docs/acceptance/records/second-app-vue-fastapi-template.md`](records/second-app-vue-fastapi-template.md)
   → `docs/acceptance/records/<version>-second-app-vue-fastapi.md`.

## Checklist

| # | Prompt | Expected tool calls | Expected visible result | Record |
| --- | --- | --- | --- | --- |
| 1 | "List all my playlists." / DE: "Zeig mir alle meine Playlists." | `playlists_list` once, no `limit` | All 60 named, or a summary that says it shows N of 60; no file URL | Showing N of 60 as answered; did the model page with `read_result`? |
| 2 | "Give me the names of all 60 playlists." | `playlists_list`, then `read_result` with `fields: ["playlists[].displayName"]` (or none: the overview already has them) | 60 names, none invented | Fields read; model calls; names missing or duplicated |
| 3 | "Which versions does Lobby Loop have?" | `playlists_list` (or reuse), `playlistsVersions_list` with `playlist_id: 3` | Versions 1–4 with dates | The `playlist_id` sent (an integer, 3) |
| 4 | "Show me the files of Night Loop." | `playlists_get` with `playlist_id: 10` (or `read_result` on `playlists[9].items`) | 64 clip names and durations; no URL, no invented URL | Search for `fileUrl`, `X-Amz` and `https://` in the answer, the activity details and the copied chat text |
| 5 | "Show playlist 9999." | `playlists_get` once | Says it does not exist; no retry loop | Number of calls; whether it offered a lookup (0.17.2 adds a lookup hint) |
| 6 | Turn 1: case 1. Turn 2: "Delete entry 14 of that list." | `playlists_delete` with `playlist_id: 14` (after a lookup if needed) | Approval card for "Opening Loop"; decline it | The id sent; whether it re-listed first (SA-01, fixed in 0.17.2: the history keeps `playlist_id`) |
| 7 | "Delete the playlist Weekend Loop." / DE: "Lösch die Playlist Weekend Loop." | lookup, then `playlists_delete` with `playlist_id: 7` | Card names "Weekend Loop" | Card status and name shown (known gaps SA-04, SA-05) |
| 8 | "Delete playlist 7." (new chat, no listing) | `playlists_delete` with `playlist_id: 7` | Card status `unknown`, shows id 7 with a warning | Card status |
| 9 | "Roll Lobby Loop back to version 3." Then: "Roll the lobby channel back to revision 3." | `playlistsVersions_list`, `playlistsVersionsRollback_create` (`playlist_id: 3`, `version_id: 303`); `channelsRevisions_list`, `channelsRevisionsRollback_create` (`key: "lobby"`, `revision_id: 503`) | Card `seen` with "Version number 3"; for the revision a comparable fallback | Card status and fallback of both (known gaps SA-07, SA-08) |
| 10 | Case 1, then "Delete user 1." | `users_list` (or not), `users_delete` with `user_id: 1` | Card names "Ada Lovelace", never "Morning Loop" | Card status and name (known gap SA-05) |
| 11 | Case 7, decline the approval | none after the decline | Model acknowledges; no retry; activity shows `declined` | Retries; wording |
| 12 | Case 7, approve; then "List my playlists again." | `playlists_delete`, then `playlists_list` | Weekend Loop gone, total 59 | Total shown |
| 13 | "Delete the lobby channel." | `channels_list` (optional), `channels_delete` with `key: "lobby"` | Card that identifies the lobby channel | What the card shows (known gap SA-06) |
| 14 | "Show me the files of every playlist." / DE: "Zeig mir die Dateien aller Playlists." — `ACCEPTANCE_LIMITS=sdk-default` | fan-out of `playlists_get` (or `read_result` on items) | Budget stop notice in the chat's language (DE run with `de-DE`) | Limit that stopped it; language of the notice; calls made |
| 15 | "Show playlist banana." | lookup by name (`playlists_list`), no question back | Says there is no playlist named so, or picks none; does not ask the user for an id | Self-correction path; whether it asked the user |
| 16 | Cases 1, 7 and 14 in German, `ACCEPTANCE_LOCALE=de-DE` | as the English case | Answers and notices in German | Language of answer, card and notice |
| 17 | "How many playlists are published?" and "List all names." | `playlists_list` (with `status: "published"` or counting the overview); `read_result` with fields, or none | 36 published; 60 names | Whether it read fields (`playlists[].displayName`) or paged whole entries; number of model calls |

## Known gaps (model-free, `tests/second-acceptance-vue-fastapi.test.ts`)

| Id | Finding | SDK code |
| --- | --- | --- |
| SA-04 | A listed playlist is `unknown` on the approval card: only `id`, `_id`, `uuid` are record ids | `src/react/utils/entity-names.ts` |
| SA-05 | Playlist 3 is named after user 3 ("Linus Torvalds") with status `named`, no ambiguity warning | `src/react/utils/entity-names.ts`, `src/react/utils/approval-subjects.ts` |
| SA-06 | A channel deleted by `key` gets no subject on the card | `src/react/utils/approval-subjects.ts` (`isIdKey`) |
| SA-07 | A listed version (`version_id`) is `unknown`, not `seen` with its `versionNumber` | `src/react/utils/entity-names.ts` (`collectSeenEntityIds`) |
| SA-08 | `rev` is no fallback field, even for a record seen under `id` | `src/react/utils/entity-names.ts` (`FALLBACK_KEYS`) |
| SA-09 | `hideIds` learns no integer ids: "(ID: 3)" stays in the answer | `src/server/adapters/nextjs/hide-ids.ts` |

Fixed (the tests keep their ids, titled `SA-nn (fixed in 0.17.2)`):

| Id | Fixed behaviour | SDK code |
| --- | --- | --- |
| SA-01 | History compaction keeps `playlist_id` with `displayName` for entries 11–60; the `_history` marker's `keys` names it | `src/contracts/record-identity.ts` (`idLikeFieldsOf`), `src/server/adapters/nextjs/history-compaction.ts` |
| SA-02 | Under size pressure the overview keeps `playlist_id`; other fields go first, then trailing entries | `src/server/core/result-overview.ts` |
| SA-03 | `read_result` adds `playlist_id` with the name to entries read below the array | `src/server/core/result-overview.ts` (`identityFieldsOf`) |
