# Second acceptance app (Vue + FastAPI) — <version>, <date>

Copy to `docs/acceptance/records/<version>-second-app-vue-fastapi.md`.
Protocol and cases: [second-app-vue-fastapi.md](../second-app-vue-fastapi.md).
Never paste tokens, cookies or keys.

- SDK: `<version>` at `<commit>`; hosting: embedded Node (`runtime/main.mjs`)
- Baseline model: `openai/gpt-4o` via OpenRouter
- Second model: `<OpenRouter Claude model id>` via OpenRouter
- Runs per case and model: 3
- Previous record: `<path or "none">`
- Model-free gaps still open (`KNOWN GAP SA-nn` tests passing): `<SA-01, …>`

## Results

Pass rate as `passed/runs`. Δ: change against the previous record.

| # | Case | gpt-4o | Δ | Claude | Δ | Notes (failed runs, tool calls, card status, model calls) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | List all playlists | /3 | | /3 | | |
| 1-DE | Alle Playlists | /3 | | /3 | | |
| 2 | Names of all 60 | /3 | | /3 | | |
| 3 | Versions of Lobby Loop | /3 | | /3 | | |
| 4 | Files of Night Loop, no URL | /3 | | /3 | | |
| 5 | Playlist 9999 | /3 | | /3 | | |
| 6 | Follow-up "entry 14" | /3 | | /3 | | |
| 7 | Delete Weekend Loop | /3 | | /3 | | |
| 7-DE | Lösch Weekend Loop | /3 | | /3 | | |
| 8 | Delete playlist 7 unlisted | /3 | | /3 | | |
| 9 | Rollback version 3 / revision 3 | /3 | | /3 | | |
| 10 | Delete user 1 after playlists | /3 | | /3 | | |
| 11 | Decline approval | /3 | | /3 | | |
| 12 | Approve, list again | /3 | | /3 | | |
| 13 | Delete channel `lobby` | /3 | | /3 | | |
| 14 | Fan-out, SDK default limits | /3 | | /3 | | |
| 14-DE | Fan-out, de-DE | /3 | | /3 | | |
| 15 | Playlist "banana" | /3 | | /3 | | |
| 16 | German variants overall | /3 | | /3 | | |
| 17 | Count published / list names | /3 | | /3 | | |

## Regressions and new findings

- <none / finding, case, both models or one, since which release>
