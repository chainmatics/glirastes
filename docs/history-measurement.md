# History measurement

Which ids and names of an earlier tool result the model still gets after N
follow-up turns without tools, and what that costs in input tokens. Measured
without a model (`prepareModelMessages` only), deterministically, by
`tests/history-measurement.test.ts` over the fixtures of
`tests/support/history-measurement.ts`; the test fails when these tables no
longer match the code (`UPDATE_HISTORY_MEASUREMENT=1 bunx vitest run
tests/history-measurement.test.ts` rewrites them). These numbers led to the
0.18.0 defaults `toolTurnCounting: 'tool-turns'` and `seenObjects` on (column
"0.18 default"); the test pins that the defaults measure exactly as
`tool-turns + memo`. The way back is `history: { toolTurnCounting:
'all-turns', seenObjects: false }` (column "0.17 default").

How it is measured:

- A conversation is one list turn (a tool call and its result, then the
  model's answer naming the first five entries), N turns without tools
  ("thanks", a question answered from knowledge), then the current question.
  "two lists, chat in between" is a playlist list, one chat turn, a channel
  list, then N chat turns.
- The handler's message window is applied as the built-in handler does: the
  last `maxContextMessages` UI messages go to `prepareModelMessages`, the
  ones before are passed as `earlierMessages` (read by the memo only).
  `maxTurns` stays at its default of 6.
- A cell is `kept/total ~tokens`: entries whose declared id and name are both
  in the model input next to each other (a complete entry, a compacted
  `_history` entry or a memo line), of all entries listed, and the estimated
  tokens of the returned messages (4 characters per token; system prompt and
  tool definitions not counted).
- Fixtures: a pilot-like list (UUID `id`, `name`, seven fields), the
  reference app's playlists (`playlists[]`, numeric `playlist_id`,
  `displayName`, three nested items each) and channels (`channels[]`,
  speaking `key`, `title`), long UUID lists (60 and 200 entries), and the
  pilot list without any declaration. All but the last declare their
  identity (`outputEntities`).
- Modes: `all-turns` (the default up to 0.17) and `tool-turns` (the default
  since 0.18.0) of
  `history.toolTurnCounting`, each without and with `history.seenObjects`
  (default bounds: 40 entries, 800 tokens; on by default since 0.18.0).

## Summary

<!-- summary:start -->
| List | Follow-ups | 0.17 default (all-turns, toolTurns 1, 4000, window 12) | tool-turns, toolTurns 1 | all-turns + memo, toolTurns 1 | 0.18 default (tool-turns + memo, toolTurns 1) | pilot (all-turns, toolTurns 4, 16000, window 60) | tool-turns, toolTurns 4, 16000, window 60 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pilot uuid list 20 | 1 | 0/20 ~186 | 20/20 ~1348 | 20/20 ~824 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 3 | 0/20 ~290 | 20/20 ~1451 | 20/20 ~928 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 6 | 0/20 ~312 | 0/20 ~312 | 20/20 ~950 | 20/20 ~950 | 0/20 ~330 | 0/20 ~330 |
| vue-fastapi playlists | 1 | 0/10 ~181 | 10/10 ~1315 | 10/10 ~516 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 3 | 0/10 ~284 | 10/10 ~1418 | 10/10 ~620 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 6 | 0/10 ~312 | 0/10 ~312 | 10/10 ~647 | 10/10 ~647 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi channels | 1 | 0/8 ~183 | 8/8 ~344 | 8/8 ~476 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 3 | 0/8 ~286 | 8/8 ~447 | 8/8 ~579 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 6 | 0/8 ~312 | 0/8 ~312 | 8/8 ~605 | 8/8 ~605 | 0/8 ~330 | 0/8 ~330 |
| long uuid list 60 | 1 | 0/60 ~186 | 60/60 ~2088 | 30/60 ~1067 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 3 | 0/60 ~289 | 60/60 ~2191 | 30/60 ~1170 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 6 | 0/60 ~312 | 0/60 ~312 | 30/60 ~1193 | 30/60 ~1193 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 200 | 1 | 0/200 ~186 | 200/200 ~4003 | 29/200 ~1052 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 3 | 0/200 ~290 | 0/200 ~290 | 29/200 ~1155 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 6 | 0/200 ~312 | 0/200 ~312 | 29/200 ~1177 | 29/200 ~1177 | 0/200 ~330 | 0/200 ~330 |
| pilot uuid list 20, undeclared | 1 | 0/20 ~189 | 20/20 ~1351 | 0/20 ~189 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 3 | 0/20 ~293 | 20/20 ~1454 | 0/20 ~293 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 6 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 | 0/20 ~330 | 0/20 ~330 |
| two lists, chat in between | 1 | 0/18 ~298 | 8/18 ~508 | 18/18 ~753 | 18/18 ~844 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 3 | 0/18 ~379 | 8/18 ~450 | 18/18 ~835 | 18/18 ~786 | 8/18 ~612 | 18/18 ~1746 |
| two lists, chat in between | 6 | 0/18 ~314 | 0/18 ~314 | 18/18 ~770 | 18/18 ~770 | 0/18 ~332 | 0/18 ~332 |
<!-- summary:end -->

Reading it:

- With the 0.17 defaults, one turn without tools after a list removes every
  id of that list from the model input (`0/n`), whatever the list's shape.
  That is the pilot finding.
- The 0.18 defaults keep id and name of every entry of the declared lists
  up to 20 entries through 1 to 6 turns without tools; of longer lists all
  entries while the list turn still fits the history (60 entries after 1 and
  3 follow-ups, 200 after 1), otherwise the memo's cap (30 of 60, 29 of 200). They cost more input tokens per request
  than the 0.17 defaults whenever the earlier result is kept: about
  +1,160 tokens for the 20-entry pilot list after 1 to 3 follow-ups
  (~186 to ~1,348), +640 for it after 6 (memo only), +160 to +1,130 for the
  reference app's lists, and up to about +3,800 for a 200-entry list
  (~4,003). An app without declarations pays only the `tool-turns` part
  (no memo); an earlier turn without kept results costs nothing extra.
- `tool-turns` with `toolTurns: 1` keeps the list through any number of
  turns without tools, until `maxTurns` (6) or the message window drops the
  list turn itself (6 follow-ups: the list turn is the 7th earlier turn, and
  with a window of 12 UI messages it is outside the window already).
- The memo keeps declared ids and names beyond `maxTurns`, the window and the
  chat memory summary, at about 25 to 30 tokens per object plus about 140
  for its fixed text, capped at 800 tokens (so 29 to 30 objects of a long
  UUID list). An app without declarations gets no memo and pays nothing.
- `maxTokens` only matters for long lists: 200 entries need more than the
  default 4000 tokens once other turns share the budget (3 follow-ups: `0/200`
  at 4000, `200/200` at 8000 and 16000 in the full table).
- The pilot's settings (`toolTurns: 4`, 16000, window 60) keep one list
  through 3 turns without tools at about the same cost as `tool-turns` with
  `toolTurns: 1`, but lose it once 4 such turns follow (6 in the table), and keep only the newer of
  two lists with 3 chat turns after it (`8/18`); `tool-turns` with
  `toolTurns: 4` keeps both (`18/18`).
- The memo alone (`all-turns + memo`) is the cheapest way to keep ids and
  names of short lists, but it carries no other fields: a follow-up that
  needs a field outside id and name still calls a read tool.

## Full table

<!-- measurement:start -->
| List | Follow-ups | maxContextMessages | Mode | toolTurns | maxTokens 4000 | maxTokens 8000 | maxTokens 16000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pilot uuid list 20 | 1 | 12 | all-turns | 1 | 0/20 ~186 | 0/20 ~186 | 0/20 ~186 |
| pilot uuid list 20 | 1 | 12 | all-turns | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | all-turns | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | tool-turns | 1 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | tool-turns | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | tool-turns | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | all-turns + memo | 1 | 20/20 ~824 | 20/20 ~824 | 20/20 ~824 |
| pilot uuid list 20 | 1 | 12 | all-turns + memo | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | all-turns + memo | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | tool-turns + memo | 1 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | tool-turns + memo | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 12 | tool-turns + memo | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | all-turns | 1 | 0/20 ~186 | 0/20 ~186 | 0/20 ~186 |
| pilot uuid list 20 | 1 | 60 | all-turns | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | all-turns | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | tool-turns | 1 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | tool-turns | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | tool-turns | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | all-turns + memo | 1 | 20/20 ~824 | 20/20 ~824 | 20/20 ~824 |
| pilot uuid list 20 | 1 | 60 | all-turns + memo | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | all-turns + memo | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | tool-turns + memo | 1 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | tool-turns + memo | 2 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 1 | 60 | tool-turns + memo | 4 | 20/20 ~1348 | 20/20 ~1348 | 20/20 ~1348 |
| pilot uuid list 20 | 3 | 12 | all-turns | 1 | 0/20 ~290 | 0/20 ~290 | 0/20 ~290 |
| pilot uuid list 20 | 3 | 12 | all-turns | 2 | 0/20 ~290 | 0/20 ~290 | 0/20 ~290 |
| pilot uuid list 20 | 3 | 12 | all-turns | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | tool-turns | 1 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | tool-turns | 2 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | tool-turns | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | all-turns + memo | 1 | 20/20 ~928 | 20/20 ~928 | 20/20 ~928 |
| pilot uuid list 20 | 3 | 12 | all-turns + memo | 2 | 20/20 ~928 | 20/20 ~928 | 20/20 ~928 |
| pilot uuid list 20 | 3 | 12 | all-turns + memo | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | tool-turns + memo | 1 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | tool-turns + memo | 2 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 12 | tool-turns + memo | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | all-turns | 1 | 0/20 ~290 | 0/20 ~290 | 0/20 ~290 |
| pilot uuid list 20 | 3 | 60 | all-turns | 2 | 0/20 ~290 | 0/20 ~290 | 0/20 ~290 |
| pilot uuid list 20 | 3 | 60 | all-turns | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | tool-turns | 1 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | tool-turns | 2 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | tool-turns | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | all-turns + memo | 1 | 20/20 ~928 | 20/20 ~928 | 20/20 ~928 |
| pilot uuid list 20 | 3 | 60 | all-turns + memo | 2 | 20/20 ~928 | 20/20 ~928 | 20/20 ~928 |
| pilot uuid list 20 | 3 | 60 | all-turns + memo | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | tool-turns + memo | 1 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | tool-turns + memo | 2 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 3 | 60 | tool-turns + memo | 4 | 20/20 ~1451 | 20/20 ~1451 | 20/20 ~1451 |
| pilot uuid list 20 | 6 | 12 | all-turns | 1 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20 | 6 | 12 | all-turns | 2 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20 | 6 | 12 | all-turns | 4 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20 | 6 | 12 | tool-turns | 1 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20 | 6 | 12 | tool-turns | 2 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20 | 6 | 12 | tool-turns | 4 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20 | 6 | 12 | all-turns + memo | 1 | 20/20 ~950 | 20/20 ~950 | 20/20 ~950 |
| pilot uuid list 20 | 6 | 12 | all-turns + memo | 2 | 20/20 ~950 | 20/20 ~950 | 20/20 ~950 |
| pilot uuid list 20 | 6 | 12 | all-turns + memo | 4 | 20/20 ~950 | 20/20 ~950 | 20/20 ~950 |
| pilot uuid list 20 | 6 | 12 | tool-turns + memo | 1 | 20/20 ~950 | 20/20 ~950 | 20/20 ~950 |
| pilot uuid list 20 | 6 | 12 | tool-turns + memo | 2 | 20/20 ~950 | 20/20 ~950 | 20/20 ~950 |
| pilot uuid list 20 | 6 | 12 | tool-turns + memo | 4 | 20/20 ~950 | 20/20 ~950 | 20/20 ~950 |
| pilot uuid list 20 | 6 | 60 | all-turns | 1 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20 | 6 | 60 | all-turns | 2 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20 | 6 | 60 | all-turns | 4 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20 | 6 | 60 | tool-turns | 1 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20 | 6 | 60 | tool-turns | 2 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20 | 6 | 60 | tool-turns | 4 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20 | 6 | 60 | all-turns + memo | 1 | 20/20 ~968 | 20/20 ~968 | 20/20 ~968 |
| pilot uuid list 20 | 6 | 60 | all-turns + memo | 2 | 20/20 ~968 | 20/20 ~968 | 20/20 ~968 |
| pilot uuid list 20 | 6 | 60 | all-turns + memo | 4 | 20/20 ~968 | 20/20 ~968 | 20/20 ~968 |
| pilot uuid list 20 | 6 | 60 | tool-turns + memo | 1 | 20/20 ~968 | 20/20 ~968 | 20/20 ~968 |
| pilot uuid list 20 | 6 | 60 | tool-turns + memo | 2 | 20/20 ~968 | 20/20 ~968 | 20/20 ~968 |
| pilot uuid list 20 | 6 | 60 | tool-turns + memo | 4 | 20/20 ~968 | 20/20 ~968 | 20/20 ~968 |
| vue-fastapi playlists | 1 | 12 | all-turns | 1 | 0/10 ~181 | 0/10 ~181 | 0/10 ~181 |
| vue-fastapi playlists | 1 | 12 | all-turns | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | all-turns | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | tool-turns | 1 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | tool-turns | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | tool-turns | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | all-turns + memo | 1 | 10/10 ~516 | 10/10 ~516 | 10/10 ~516 |
| vue-fastapi playlists | 1 | 12 | all-turns + memo | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | all-turns + memo | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | tool-turns + memo | 1 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | tool-turns + memo | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 12 | tool-turns + memo | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | all-turns | 1 | 0/10 ~181 | 0/10 ~181 | 0/10 ~181 |
| vue-fastapi playlists | 1 | 60 | all-turns | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | all-turns | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | tool-turns | 1 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | tool-turns | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | tool-turns | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | all-turns + memo | 1 | 10/10 ~516 | 10/10 ~516 | 10/10 ~516 |
| vue-fastapi playlists | 1 | 60 | all-turns + memo | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | all-turns + memo | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | tool-turns + memo | 1 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | tool-turns + memo | 2 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 1 | 60 | tool-turns + memo | 4 | 10/10 ~1315 | 10/10 ~1315 | 10/10 ~1315 |
| vue-fastapi playlists | 3 | 12 | all-turns | 1 | 0/10 ~284 | 0/10 ~284 | 0/10 ~284 |
| vue-fastapi playlists | 3 | 12 | all-turns | 2 | 0/10 ~284 | 0/10 ~284 | 0/10 ~284 |
| vue-fastapi playlists | 3 | 12 | all-turns | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | tool-turns | 1 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | tool-turns | 2 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | tool-turns | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | all-turns + memo | 1 | 10/10 ~620 | 10/10 ~620 | 10/10 ~620 |
| vue-fastapi playlists | 3 | 12 | all-turns + memo | 2 | 10/10 ~620 | 10/10 ~620 | 10/10 ~620 |
| vue-fastapi playlists | 3 | 12 | all-turns + memo | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | tool-turns + memo | 1 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | tool-turns + memo | 2 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 12 | tool-turns + memo | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | all-turns | 1 | 0/10 ~284 | 0/10 ~284 | 0/10 ~284 |
| vue-fastapi playlists | 3 | 60 | all-turns | 2 | 0/10 ~284 | 0/10 ~284 | 0/10 ~284 |
| vue-fastapi playlists | 3 | 60 | all-turns | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | tool-turns | 1 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | tool-turns | 2 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | tool-turns | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | all-turns + memo | 1 | 10/10 ~620 | 10/10 ~620 | 10/10 ~620 |
| vue-fastapi playlists | 3 | 60 | all-turns + memo | 2 | 10/10 ~620 | 10/10 ~620 | 10/10 ~620 |
| vue-fastapi playlists | 3 | 60 | all-turns + memo | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | tool-turns + memo | 1 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | tool-turns + memo | 2 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 3 | 60 | tool-turns + memo | 4 | 10/10 ~1418 | 10/10 ~1418 | 10/10 ~1418 |
| vue-fastapi playlists | 6 | 12 | all-turns | 1 | 0/10 ~312 | 0/10 ~312 | 0/10 ~312 |
| vue-fastapi playlists | 6 | 12 | all-turns | 2 | 0/10 ~312 | 0/10 ~312 | 0/10 ~312 |
| vue-fastapi playlists | 6 | 12 | all-turns | 4 | 0/10 ~312 | 0/10 ~312 | 0/10 ~312 |
| vue-fastapi playlists | 6 | 12 | tool-turns | 1 | 0/10 ~312 | 0/10 ~312 | 0/10 ~312 |
| vue-fastapi playlists | 6 | 12 | tool-turns | 2 | 0/10 ~312 | 0/10 ~312 | 0/10 ~312 |
| vue-fastapi playlists | 6 | 12 | tool-turns | 4 | 0/10 ~312 | 0/10 ~312 | 0/10 ~312 |
| vue-fastapi playlists | 6 | 12 | all-turns + memo | 1 | 10/10 ~647 | 10/10 ~647 | 10/10 ~647 |
| vue-fastapi playlists | 6 | 12 | all-turns + memo | 2 | 10/10 ~647 | 10/10 ~647 | 10/10 ~647 |
| vue-fastapi playlists | 6 | 12 | all-turns + memo | 4 | 10/10 ~647 | 10/10 ~647 | 10/10 ~647 |
| vue-fastapi playlists | 6 | 12 | tool-turns + memo | 1 | 10/10 ~647 | 10/10 ~647 | 10/10 ~647 |
| vue-fastapi playlists | 6 | 12 | tool-turns + memo | 2 | 10/10 ~647 | 10/10 ~647 | 10/10 ~647 |
| vue-fastapi playlists | 6 | 12 | tool-turns + memo | 4 | 10/10 ~647 | 10/10 ~647 | 10/10 ~647 |
| vue-fastapi playlists | 6 | 60 | all-turns | 1 | 0/10 ~330 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi playlists | 6 | 60 | all-turns | 2 | 0/10 ~330 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi playlists | 6 | 60 | all-turns | 4 | 0/10 ~330 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi playlists | 6 | 60 | tool-turns | 1 | 0/10 ~330 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi playlists | 6 | 60 | tool-turns | 2 | 0/10 ~330 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi playlists | 6 | 60 | tool-turns | 4 | 0/10 ~330 | 0/10 ~330 | 0/10 ~330 |
| vue-fastapi playlists | 6 | 60 | all-turns + memo | 1 | 10/10 ~665 | 10/10 ~665 | 10/10 ~665 |
| vue-fastapi playlists | 6 | 60 | all-turns + memo | 2 | 10/10 ~665 | 10/10 ~665 | 10/10 ~665 |
| vue-fastapi playlists | 6 | 60 | all-turns + memo | 4 | 10/10 ~665 | 10/10 ~665 | 10/10 ~665 |
| vue-fastapi playlists | 6 | 60 | tool-turns + memo | 1 | 10/10 ~665 | 10/10 ~665 | 10/10 ~665 |
| vue-fastapi playlists | 6 | 60 | tool-turns + memo | 2 | 10/10 ~665 | 10/10 ~665 | 10/10 ~665 |
| vue-fastapi playlists | 6 | 60 | tool-turns + memo | 4 | 10/10 ~665 | 10/10 ~665 | 10/10 ~665 |
| vue-fastapi channels | 1 | 12 | all-turns | 1 | 0/8 ~183 | 0/8 ~183 | 0/8 ~183 |
| vue-fastapi channels | 1 | 12 | all-turns | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | all-turns | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | tool-turns | 1 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | tool-turns | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | tool-turns | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | all-turns + memo | 1 | 8/8 ~476 | 8/8 ~476 | 8/8 ~476 |
| vue-fastapi channels | 1 | 12 | all-turns + memo | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | all-turns + memo | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | tool-turns + memo | 1 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | tool-turns + memo | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 12 | tool-turns + memo | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | all-turns | 1 | 0/8 ~183 | 0/8 ~183 | 0/8 ~183 |
| vue-fastapi channels | 1 | 60 | all-turns | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | all-turns | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | tool-turns | 1 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | tool-turns | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | tool-turns | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | all-turns + memo | 1 | 8/8 ~476 | 8/8 ~476 | 8/8 ~476 |
| vue-fastapi channels | 1 | 60 | all-turns + memo | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | all-turns + memo | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | tool-turns + memo | 1 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | tool-turns + memo | 2 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 1 | 60 | tool-turns + memo | 4 | 8/8 ~344 | 8/8 ~344 | 8/8 ~344 |
| vue-fastapi channels | 3 | 12 | all-turns | 1 | 0/8 ~286 | 0/8 ~286 | 0/8 ~286 |
| vue-fastapi channels | 3 | 12 | all-turns | 2 | 0/8 ~286 | 0/8 ~286 | 0/8 ~286 |
| vue-fastapi channels | 3 | 12 | all-turns | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | tool-turns | 1 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | tool-turns | 2 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | tool-turns | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | all-turns + memo | 1 | 8/8 ~579 | 8/8 ~579 | 8/8 ~579 |
| vue-fastapi channels | 3 | 12 | all-turns + memo | 2 | 8/8 ~579 | 8/8 ~579 | 8/8 ~579 |
| vue-fastapi channels | 3 | 12 | all-turns + memo | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | tool-turns + memo | 1 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | tool-turns + memo | 2 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 12 | tool-turns + memo | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | all-turns | 1 | 0/8 ~286 | 0/8 ~286 | 0/8 ~286 |
| vue-fastapi channels | 3 | 60 | all-turns | 2 | 0/8 ~286 | 0/8 ~286 | 0/8 ~286 |
| vue-fastapi channels | 3 | 60 | all-turns | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | tool-turns | 1 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | tool-turns | 2 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | tool-turns | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | all-turns + memo | 1 | 8/8 ~579 | 8/8 ~579 | 8/8 ~579 |
| vue-fastapi channels | 3 | 60 | all-turns + memo | 2 | 8/8 ~579 | 8/8 ~579 | 8/8 ~579 |
| vue-fastapi channels | 3 | 60 | all-turns + memo | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | tool-turns + memo | 1 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | tool-turns + memo | 2 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 3 | 60 | tool-turns + memo | 4 | 8/8 ~447 | 8/8 ~447 | 8/8 ~447 |
| vue-fastapi channels | 6 | 12 | all-turns | 1 | 0/8 ~312 | 0/8 ~312 | 0/8 ~312 |
| vue-fastapi channels | 6 | 12 | all-turns | 2 | 0/8 ~312 | 0/8 ~312 | 0/8 ~312 |
| vue-fastapi channels | 6 | 12 | all-turns | 4 | 0/8 ~312 | 0/8 ~312 | 0/8 ~312 |
| vue-fastapi channels | 6 | 12 | tool-turns | 1 | 0/8 ~312 | 0/8 ~312 | 0/8 ~312 |
| vue-fastapi channels | 6 | 12 | tool-turns | 2 | 0/8 ~312 | 0/8 ~312 | 0/8 ~312 |
| vue-fastapi channels | 6 | 12 | tool-turns | 4 | 0/8 ~312 | 0/8 ~312 | 0/8 ~312 |
| vue-fastapi channels | 6 | 12 | all-turns + memo | 1 | 8/8 ~605 | 8/8 ~605 | 8/8 ~605 |
| vue-fastapi channels | 6 | 12 | all-turns + memo | 2 | 8/8 ~605 | 8/8 ~605 | 8/8 ~605 |
| vue-fastapi channels | 6 | 12 | all-turns + memo | 4 | 8/8 ~605 | 8/8 ~605 | 8/8 ~605 |
| vue-fastapi channels | 6 | 12 | tool-turns + memo | 1 | 8/8 ~605 | 8/8 ~605 | 8/8 ~605 |
| vue-fastapi channels | 6 | 12 | tool-turns + memo | 2 | 8/8 ~605 | 8/8 ~605 | 8/8 ~605 |
| vue-fastapi channels | 6 | 12 | tool-turns + memo | 4 | 8/8 ~605 | 8/8 ~605 | 8/8 ~605 |
| vue-fastapi channels | 6 | 60 | all-turns | 1 | 0/8 ~330 | 0/8 ~330 | 0/8 ~330 |
| vue-fastapi channels | 6 | 60 | all-turns | 2 | 0/8 ~330 | 0/8 ~330 | 0/8 ~330 |
| vue-fastapi channels | 6 | 60 | all-turns | 4 | 0/8 ~330 | 0/8 ~330 | 0/8 ~330 |
| vue-fastapi channels | 6 | 60 | tool-turns | 1 | 0/8 ~330 | 0/8 ~330 | 0/8 ~330 |
| vue-fastapi channels | 6 | 60 | tool-turns | 2 | 0/8 ~330 | 0/8 ~330 | 0/8 ~330 |
| vue-fastapi channels | 6 | 60 | tool-turns | 4 | 0/8 ~330 | 0/8 ~330 | 0/8 ~330 |
| vue-fastapi channels | 6 | 60 | all-turns + memo | 1 | 8/8 ~623 | 8/8 ~623 | 8/8 ~623 |
| vue-fastapi channels | 6 | 60 | all-turns + memo | 2 | 8/8 ~623 | 8/8 ~623 | 8/8 ~623 |
| vue-fastapi channels | 6 | 60 | all-turns + memo | 4 | 8/8 ~623 | 8/8 ~623 | 8/8 ~623 |
| vue-fastapi channels | 6 | 60 | tool-turns + memo | 1 | 8/8 ~623 | 8/8 ~623 | 8/8 ~623 |
| vue-fastapi channels | 6 | 60 | tool-turns + memo | 2 | 8/8 ~623 | 8/8 ~623 | 8/8 ~623 |
| vue-fastapi channels | 6 | 60 | tool-turns + memo | 4 | 8/8 ~623 | 8/8 ~623 | 8/8 ~623 |
| long uuid list 60 | 1 | 12 | all-turns | 1 | 0/60 ~186 | 0/60 ~186 | 0/60 ~186 |
| long uuid list 60 | 1 | 12 | all-turns | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | all-turns | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | tool-turns | 1 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | tool-turns | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | tool-turns | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | all-turns + memo | 1 | 30/60 ~1067 | 30/60 ~1067 | 30/60 ~1067 |
| long uuid list 60 | 1 | 12 | all-turns + memo | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | all-turns + memo | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | tool-turns + memo | 1 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | tool-turns + memo | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 12 | tool-turns + memo | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | all-turns | 1 | 0/60 ~186 | 0/60 ~186 | 0/60 ~186 |
| long uuid list 60 | 1 | 60 | all-turns | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | all-turns | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | tool-turns | 1 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | tool-turns | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | tool-turns | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | all-turns + memo | 1 | 30/60 ~1067 | 30/60 ~1067 | 30/60 ~1067 |
| long uuid list 60 | 1 | 60 | all-turns + memo | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | all-turns + memo | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | tool-turns + memo | 1 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | tool-turns + memo | 2 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 1 | 60 | tool-turns + memo | 4 | 60/60 ~2088 | 60/60 ~2088 | 60/60 ~2088 |
| long uuid list 60 | 3 | 12 | all-turns | 1 | 0/60 ~289 | 0/60 ~289 | 0/60 ~289 |
| long uuid list 60 | 3 | 12 | all-turns | 2 | 0/60 ~289 | 0/60 ~289 | 0/60 ~289 |
| long uuid list 60 | 3 | 12 | all-turns | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | tool-turns | 1 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | tool-turns | 2 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | tool-turns | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | all-turns + memo | 1 | 30/60 ~1170 | 30/60 ~1170 | 30/60 ~1170 |
| long uuid list 60 | 3 | 12 | all-turns + memo | 2 | 30/60 ~1170 | 30/60 ~1170 | 30/60 ~1170 |
| long uuid list 60 | 3 | 12 | all-turns + memo | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | tool-turns + memo | 1 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | tool-turns + memo | 2 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 12 | tool-turns + memo | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | all-turns | 1 | 0/60 ~289 | 0/60 ~289 | 0/60 ~289 |
| long uuid list 60 | 3 | 60 | all-turns | 2 | 0/60 ~289 | 0/60 ~289 | 0/60 ~289 |
| long uuid list 60 | 3 | 60 | all-turns | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | tool-turns | 1 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | tool-turns | 2 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | tool-turns | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | all-turns + memo | 1 | 30/60 ~1170 | 30/60 ~1170 | 30/60 ~1170 |
| long uuid list 60 | 3 | 60 | all-turns + memo | 2 | 30/60 ~1170 | 30/60 ~1170 | 30/60 ~1170 |
| long uuid list 60 | 3 | 60 | all-turns + memo | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | tool-turns + memo | 1 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | tool-turns + memo | 2 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 3 | 60 | tool-turns + memo | 4 | 60/60 ~2191 | 60/60 ~2191 | 60/60 ~2191 |
| long uuid list 60 | 6 | 12 | all-turns | 1 | 0/60 ~312 | 0/60 ~312 | 0/60 ~312 |
| long uuid list 60 | 6 | 12 | all-turns | 2 | 0/60 ~312 | 0/60 ~312 | 0/60 ~312 |
| long uuid list 60 | 6 | 12 | all-turns | 4 | 0/60 ~312 | 0/60 ~312 | 0/60 ~312 |
| long uuid list 60 | 6 | 12 | tool-turns | 1 | 0/60 ~312 | 0/60 ~312 | 0/60 ~312 |
| long uuid list 60 | 6 | 12 | tool-turns | 2 | 0/60 ~312 | 0/60 ~312 | 0/60 ~312 |
| long uuid list 60 | 6 | 12 | tool-turns | 4 | 0/60 ~312 | 0/60 ~312 | 0/60 ~312 |
| long uuid list 60 | 6 | 12 | all-turns + memo | 1 | 30/60 ~1193 | 30/60 ~1193 | 30/60 ~1193 |
| long uuid list 60 | 6 | 12 | all-turns + memo | 2 | 30/60 ~1193 | 30/60 ~1193 | 30/60 ~1193 |
| long uuid list 60 | 6 | 12 | all-turns + memo | 4 | 30/60 ~1193 | 30/60 ~1193 | 30/60 ~1193 |
| long uuid list 60 | 6 | 12 | tool-turns + memo | 1 | 30/60 ~1193 | 30/60 ~1193 | 30/60 ~1193 |
| long uuid list 60 | 6 | 12 | tool-turns + memo | 2 | 30/60 ~1193 | 30/60 ~1193 | 30/60 ~1193 |
| long uuid list 60 | 6 | 12 | tool-turns + memo | 4 | 30/60 ~1193 | 30/60 ~1193 | 30/60 ~1193 |
| long uuid list 60 | 6 | 60 | all-turns | 1 | 0/60 ~330 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 60 | 6 | 60 | all-turns | 2 | 0/60 ~330 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 60 | 6 | 60 | all-turns | 4 | 0/60 ~330 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 60 | 6 | 60 | tool-turns | 1 | 0/60 ~330 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 60 | 6 | 60 | tool-turns | 2 | 0/60 ~330 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 60 | 6 | 60 | tool-turns | 4 | 0/60 ~330 | 0/60 ~330 | 0/60 ~330 |
| long uuid list 60 | 6 | 60 | all-turns + memo | 1 | 30/60 ~1211 | 30/60 ~1211 | 30/60 ~1211 |
| long uuid list 60 | 6 | 60 | all-turns + memo | 2 | 30/60 ~1211 | 30/60 ~1211 | 30/60 ~1211 |
| long uuid list 60 | 6 | 60 | all-turns + memo | 4 | 30/60 ~1211 | 30/60 ~1211 | 30/60 ~1211 |
| long uuid list 60 | 6 | 60 | tool-turns + memo | 1 | 30/60 ~1211 | 30/60 ~1211 | 30/60 ~1211 |
| long uuid list 60 | 6 | 60 | tool-turns + memo | 2 | 30/60 ~1211 | 30/60 ~1211 | 30/60 ~1211 |
| long uuid list 60 | 6 | 60 | tool-turns + memo | 4 | 30/60 ~1211 | 30/60 ~1211 | 30/60 ~1211 |
| long uuid list 200 | 1 | 12 | all-turns | 1 | 0/200 ~186 | 0/200 ~186 | 0/200 ~186 |
| long uuid list 200 | 1 | 12 | all-turns | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | all-turns | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | tool-turns | 1 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | tool-turns | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | tool-turns | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | all-turns + memo | 1 | 29/200 ~1052 | 29/200 ~1052 | 29/200 ~1052 |
| long uuid list 200 | 1 | 12 | all-turns + memo | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | all-turns + memo | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | tool-turns + memo | 1 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | tool-turns + memo | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 12 | tool-turns + memo | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | all-turns | 1 | 0/200 ~186 | 0/200 ~186 | 0/200 ~186 |
| long uuid list 200 | 1 | 60 | all-turns | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | all-turns | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | tool-turns | 1 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | tool-turns | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | tool-turns | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | all-turns + memo | 1 | 29/200 ~1052 | 29/200 ~1052 | 29/200 ~1052 |
| long uuid list 200 | 1 | 60 | all-turns + memo | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | all-turns + memo | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | tool-turns + memo | 1 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | tool-turns + memo | 2 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 1 | 60 | tool-turns + memo | 4 | 200/200 ~4003 | 200/200 ~4705 | 200/200 ~4705 |
| long uuid list 200 | 3 | 12 | all-turns | 1 | 0/200 ~290 | 0/200 ~290 | 0/200 ~290 |
| long uuid list 200 | 3 | 12 | all-turns | 2 | 0/200 ~290 | 0/200 ~290 | 0/200 ~290 |
| long uuid list 200 | 3 | 12 | all-turns | 4 | 0/200 ~172 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | tool-turns | 1 | 0/200 ~290 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | tool-turns | 2 | 0/200 ~290 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | tool-turns | 4 | 0/200 ~290 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | all-turns + memo | 1 | 29/200 ~1155 | 29/200 ~1155 | 29/200 ~1155 |
| long uuid list 200 | 3 | 12 | all-turns + memo | 2 | 29/200 ~1155 | 29/200 ~1155 | 29/200 ~1155 |
| long uuid list 200 | 3 | 12 | all-turns + memo | 4 | 29/200 ~1037 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | tool-turns + memo | 1 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | tool-turns + memo | 2 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 12 | tool-turns + memo | 4 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | all-turns | 1 | 0/200 ~290 | 0/200 ~290 | 0/200 ~290 |
| long uuid list 200 | 3 | 60 | all-turns | 2 | 0/200 ~290 | 0/200 ~290 | 0/200 ~290 |
| long uuid list 200 | 3 | 60 | all-turns | 4 | 0/200 ~172 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | tool-turns | 1 | 0/200 ~290 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | tool-turns | 2 | 0/200 ~290 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | tool-turns | 4 | 0/200 ~290 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | all-turns + memo | 1 | 29/200 ~1155 | 29/200 ~1155 | 29/200 ~1155 |
| long uuid list 200 | 3 | 60 | all-turns + memo | 2 | 29/200 ~1155 | 29/200 ~1155 | 29/200 ~1155 |
| long uuid list 200 | 3 | 60 | all-turns + memo | 4 | 29/200 ~1037 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | tool-turns + memo | 1 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | tool-turns + memo | 2 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 3 | 60 | tool-turns + memo | 4 | 29/200 ~1155 | 200/200 ~4808 | 200/200 ~4808 |
| long uuid list 200 | 6 | 12 | all-turns | 1 | 0/200 ~312 | 0/200 ~312 | 0/200 ~312 |
| long uuid list 200 | 6 | 12 | all-turns | 2 | 0/200 ~312 | 0/200 ~312 | 0/200 ~312 |
| long uuid list 200 | 6 | 12 | all-turns | 4 | 0/200 ~312 | 0/200 ~312 | 0/200 ~312 |
| long uuid list 200 | 6 | 12 | tool-turns | 1 | 0/200 ~312 | 0/200 ~312 | 0/200 ~312 |
| long uuid list 200 | 6 | 12 | tool-turns | 2 | 0/200 ~312 | 0/200 ~312 | 0/200 ~312 |
| long uuid list 200 | 6 | 12 | tool-turns | 4 | 0/200 ~312 | 0/200 ~312 | 0/200 ~312 |
| long uuid list 200 | 6 | 12 | all-turns + memo | 1 | 29/200 ~1177 | 29/200 ~1177 | 29/200 ~1177 |
| long uuid list 200 | 6 | 12 | all-turns + memo | 2 | 29/200 ~1177 | 29/200 ~1177 | 29/200 ~1177 |
| long uuid list 200 | 6 | 12 | all-turns + memo | 4 | 29/200 ~1177 | 29/200 ~1177 | 29/200 ~1177 |
| long uuid list 200 | 6 | 12 | tool-turns + memo | 1 | 29/200 ~1177 | 29/200 ~1177 | 29/200 ~1177 |
| long uuid list 200 | 6 | 12 | tool-turns + memo | 2 | 29/200 ~1177 | 29/200 ~1177 | 29/200 ~1177 |
| long uuid list 200 | 6 | 12 | tool-turns + memo | 4 | 29/200 ~1177 | 29/200 ~1177 | 29/200 ~1177 |
| long uuid list 200 | 6 | 60 | all-turns | 1 | 0/200 ~330 | 0/200 ~330 | 0/200 ~330 |
| long uuid list 200 | 6 | 60 | all-turns | 2 | 0/200 ~330 | 0/200 ~330 | 0/200 ~330 |
| long uuid list 200 | 6 | 60 | all-turns | 4 | 0/200 ~330 | 0/200 ~330 | 0/200 ~330 |
| long uuid list 200 | 6 | 60 | tool-turns | 1 | 0/200 ~330 | 0/200 ~330 | 0/200 ~330 |
| long uuid list 200 | 6 | 60 | tool-turns | 2 | 0/200 ~330 | 0/200 ~330 | 0/200 ~330 |
| long uuid list 200 | 6 | 60 | tool-turns | 4 | 0/200 ~330 | 0/200 ~330 | 0/200 ~330 |
| long uuid list 200 | 6 | 60 | all-turns + memo | 1 | 29/200 ~1195 | 29/200 ~1195 | 29/200 ~1195 |
| long uuid list 200 | 6 | 60 | all-turns + memo | 2 | 29/200 ~1195 | 29/200 ~1195 | 29/200 ~1195 |
| long uuid list 200 | 6 | 60 | all-turns + memo | 4 | 29/200 ~1195 | 29/200 ~1195 | 29/200 ~1195 |
| long uuid list 200 | 6 | 60 | tool-turns + memo | 1 | 29/200 ~1195 | 29/200 ~1195 | 29/200 ~1195 |
| long uuid list 200 | 6 | 60 | tool-turns + memo | 2 | 29/200 ~1195 | 29/200 ~1195 | 29/200 ~1195 |
| long uuid list 200 | 6 | 60 | tool-turns + memo | 4 | 29/200 ~1195 | 29/200 ~1195 | 29/200 ~1195 |
| pilot uuid list 20, undeclared | 1 | 12 | all-turns | 1 | 0/20 ~189 | 0/20 ~189 | 0/20 ~189 |
| pilot uuid list 20, undeclared | 1 | 12 | all-turns | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | all-turns | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | tool-turns | 1 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | tool-turns | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | tool-turns | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | all-turns + memo | 1 | 0/20 ~189 | 0/20 ~189 | 0/20 ~189 |
| pilot uuid list 20, undeclared | 1 | 12 | all-turns + memo | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | all-turns + memo | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | tool-turns + memo | 1 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | tool-turns + memo | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 12 | tool-turns + memo | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | all-turns | 1 | 0/20 ~189 | 0/20 ~189 | 0/20 ~189 |
| pilot uuid list 20, undeclared | 1 | 60 | all-turns | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | all-turns | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | tool-turns | 1 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | tool-turns | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | tool-turns | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | all-turns + memo | 1 | 0/20 ~189 | 0/20 ~189 | 0/20 ~189 |
| pilot uuid list 20, undeclared | 1 | 60 | all-turns + memo | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | all-turns + memo | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | tool-turns + memo | 1 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | tool-turns + memo | 2 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 1 | 60 | tool-turns + memo | 4 | 20/20 ~1351 | 20/20 ~1351 | 20/20 ~1351 |
| pilot uuid list 20, undeclared | 3 | 12 | all-turns | 1 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 12 | all-turns | 2 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 12 | all-turns | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | tool-turns | 1 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | tool-turns | 2 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | tool-turns | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | all-turns + memo | 1 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 12 | all-turns + memo | 2 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 12 | all-turns + memo | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | tool-turns + memo | 1 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | tool-turns + memo | 2 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 12 | tool-turns + memo | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | all-turns | 1 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 60 | all-turns | 2 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 60 | all-turns | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | tool-turns | 1 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | tool-turns | 2 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | tool-turns | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | all-turns + memo | 1 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 60 | all-turns + memo | 2 | 0/20 ~293 | 0/20 ~293 | 0/20 ~293 |
| pilot uuid list 20, undeclared | 3 | 60 | all-turns + memo | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | tool-turns + memo | 1 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | tool-turns + memo | 2 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 3 | 60 | tool-turns + memo | 4 | 20/20 ~1454 | 20/20 ~1454 | 20/20 ~1454 |
| pilot uuid list 20, undeclared | 6 | 12 | all-turns | 1 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | all-turns | 2 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | all-turns | 4 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | tool-turns | 1 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | tool-turns | 2 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | tool-turns | 4 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | all-turns + memo | 1 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | all-turns + memo | 2 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | all-turns + memo | 4 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | tool-turns + memo | 1 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | tool-turns + memo | 2 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 12 | tool-turns + memo | 4 | 0/20 ~312 | 0/20 ~312 | 0/20 ~312 |
| pilot uuid list 20, undeclared | 6 | 60 | all-turns | 1 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | all-turns | 2 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | all-turns | 4 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | tool-turns | 1 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | tool-turns | 2 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | tool-turns | 4 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | all-turns + memo | 1 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | all-turns + memo | 2 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | all-turns + memo | 4 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | tool-turns + memo | 1 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | tool-turns + memo | 2 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| pilot uuid list 20, undeclared | 6 | 60 | tool-turns + memo | 4 | 0/20 ~330 | 0/20 ~330 | 0/20 ~330 |
| two lists, chat in between | 1 | 12 | all-turns | 1 | 0/18 ~298 | 0/18 ~298 | 0/18 ~298 |
| two lists, chat in between | 1 | 12 | all-turns | 2 | 8/18 ~508 | 8/18 ~508 | 8/18 ~508 |
| two lists, chat in between | 1 | 12 | all-turns | 4 | 8/18 ~396 | 8/18 ~396 | 8/18 ~396 |
| two lists, chat in between | 1 | 12 | tool-turns | 1 | 8/18 ~508 | 8/18 ~508 | 8/18 ~508 |
| two lists, chat in between | 1 | 12 | tool-turns | 2 | 8/18 ~508 | 8/18 ~508 | 8/18 ~508 |
| two lists, chat in between | 1 | 12 | tool-turns | 4 | 8/18 ~508 | 8/18 ~508 | 8/18 ~508 |
| two lists, chat in between | 1 | 12 | all-turns + memo | 1 | 18/18 ~753 | 18/18 ~753 | 18/18 ~753 |
| two lists, chat in between | 1 | 12 | all-turns + memo | 2 | 18/18 ~844 | 18/18 ~844 | 18/18 ~844 |
| two lists, chat in between | 1 | 12 | all-turns + memo | 4 | 18/18 ~732 | 18/18 ~732 | 18/18 ~732 |
| two lists, chat in between | 1 | 12 | tool-turns + memo | 1 | 18/18 ~844 | 18/18 ~844 | 18/18 ~844 |
| two lists, chat in between | 1 | 12 | tool-turns + memo | 2 | 18/18 ~844 | 18/18 ~844 | 18/18 ~844 |
| two lists, chat in between | 1 | 12 | tool-turns + memo | 4 | 18/18 ~844 | 18/18 ~844 | 18/18 ~844 |
| two lists, chat in between | 1 | 60 | all-turns | 1 | 0/18 ~298 | 0/18 ~298 | 0/18 ~298 |
| two lists, chat in between | 1 | 60 | all-turns | 2 | 8/18 ~508 | 8/18 ~508 | 8/18 ~508 |
| two lists, chat in between | 1 | 60 | all-turns | 4 | 18/18 ~1643 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 1 | 60 | tool-turns | 1 | 8/18 ~508 | 8/18 ~508 | 8/18 ~508 |
| two lists, chat in between | 1 | 60 | tool-turns | 2 | 18/18 ~1643 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 1 | 60 | tool-turns | 4 | 18/18 ~1643 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 1 | 60 | all-turns + memo | 1 | 18/18 ~753 | 18/18 ~753 | 18/18 ~753 |
| two lists, chat in between | 1 | 60 | all-turns + memo | 2 | 18/18 ~844 | 18/18 ~844 | 18/18 ~844 |
| two lists, chat in between | 1 | 60 | all-turns + memo | 4 | 18/18 ~1643 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 1 | 60 | tool-turns + memo | 1 | 18/18 ~844 | 18/18 ~844 | 18/18 ~844 |
| two lists, chat in between | 1 | 60 | tool-turns + memo | 2 | 18/18 ~1643 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 1 | 60 | tool-turns + memo | 4 | 18/18 ~1643 | 18/18 ~1643 | 18/18 ~1643 |
| two lists, chat in between | 3 | 12 | all-turns | 1 | 0/18 ~379 | 0/18 ~379 | 0/18 ~379 |
| two lists, chat in between | 3 | 12 | all-turns | 2 | 0/18 ~379 | 0/18 ~379 | 0/18 ~379 |
| two lists, chat in between | 3 | 12 | all-turns | 4 | 8/18 ~450 | 8/18 ~450 | 8/18 ~450 |
| two lists, chat in between | 3 | 12 | tool-turns | 1 | 8/18 ~450 | 8/18 ~450 | 8/18 ~450 |
| two lists, chat in between | 3 | 12 | tool-turns | 2 | 8/18 ~450 | 8/18 ~450 | 8/18 ~450 |
| two lists, chat in between | 3 | 12 | tool-turns | 4 | 8/18 ~450 | 8/18 ~450 | 8/18 ~450 |
| two lists, chat in between | 3 | 12 | all-turns + memo | 1 | 18/18 ~835 | 18/18 ~835 | 18/18 ~835 |
| two lists, chat in between | 3 | 12 | all-turns + memo | 2 | 18/18 ~835 | 18/18 ~835 | 18/18 ~835 |
| two lists, chat in between | 3 | 12 | all-turns + memo | 4 | 18/18 ~786 | 18/18 ~786 | 18/18 ~786 |
| two lists, chat in between | 3 | 12 | tool-turns + memo | 1 | 18/18 ~786 | 18/18 ~786 | 18/18 ~786 |
| two lists, chat in between | 3 | 12 | tool-turns + memo | 2 | 18/18 ~786 | 18/18 ~786 | 18/18 ~786 |
| two lists, chat in between | 3 | 12 | tool-turns + memo | 4 | 18/18 ~786 | 18/18 ~786 | 18/18 ~786 |
| two lists, chat in between | 3 | 60 | all-turns | 1 | 0/18 ~401 | 0/18 ~401 | 0/18 ~401 |
| two lists, chat in between | 3 | 60 | all-turns | 2 | 0/18 ~401 | 0/18 ~401 | 0/18 ~401 |
| two lists, chat in between | 3 | 60 | all-turns | 4 | 8/18 ~612 | 8/18 ~612 | 8/18 ~612 |
| two lists, chat in between | 3 | 60 | tool-turns | 1 | 8/18 ~612 | 8/18 ~612 | 8/18 ~612 |
| two lists, chat in between | 3 | 60 | tool-turns | 2 | 18/18 ~1746 | 18/18 ~1746 | 18/18 ~1746 |
| two lists, chat in between | 3 | 60 | tool-turns | 4 | 18/18 ~1746 | 18/18 ~1746 | 18/18 ~1746 |
| two lists, chat in between | 3 | 60 | all-turns + memo | 1 | 18/18 ~857 | 18/18 ~857 | 18/18 ~857 |
| two lists, chat in between | 3 | 60 | all-turns + memo | 2 | 18/18 ~857 | 18/18 ~857 | 18/18 ~857 |
| two lists, chat in between | 3 | 60 | all-turns + memo | 4 | 18/18 ~948 | 18/18 ~948 | 18/18 ~948 |
| two lists, chat in between | 3 | 60 | tool-turns + memo | 1 | 18/18 ~948 | 18/18 ~948 | 18/18 ~948 |
| two lists, chat in between | 3 | 60 | tool-turns + memo | 2 | 18/18 ~1746 | 18/18 ~1746 | 18/18 ~1746 |
| two lists, chat in between | 3 | 60 | tool-turns + memo | 4 | 18/18 ~1746 | 18/18 ~1746 | 18/18 ~1746 |
| two lists, chat in between | 6 | 12 | all-turns | 1 | 0/18 ~314 | 0/18 ~314 | 0/18 ~314 |
| two lists, chat in between | 6 | 12 | all-turns | 2 | 0/18 ~314 | 0/18 ~314 | 0/18 ~314 |
| two lists, chat in between | 6 | 12 | all-turns | 4 | 0/18 ~314 | 0/18 ~314 | 0/18 ~314 |
| two lists, chat in between | 6 | 12 | tool-turns | 1 | 0/18 ~314 | 0/18 ~314 | 0/18 ~314 |
| two lists, chat in between | 6 | 12 | tool-turns | 2 | 0/18 ~314 | 0/18 ~314 | 0/18 ~314 |
| two lists, chat in between | 6 | 12 | tool-turns | 4 | 0/18 ~314 | 0/18 ~314 | 0/18 ~314 |
| two lists, chat in between | 6 | 12 | all-turns + memo | 1 | 18/18 ~770 | 18/18 ~770 | 18/18 ~770 |
| two lists, chat in between | 6 | 12 | all-turns + memo | 2 | 18/18 ~770 | 18/18 ~770 | 18/18 ~770 |
| two lists, chat in between | 6 | 12 | all-turns + memo | 4 | 18/18 ~770 | 18/18 ~770 | 18/18 ~770 |
| two lists, chat in between | 6 | 12 | tool-turns + memo | 1 | 18/18 ~770 | 18/18 ~770 | 18/18 ~770 |
| two lists, chat in between | 6 | 12 | tool-turns + memo | 2 | 18/18 ~770 | 18/18 ~770 | 18/18 ~770 |
| two lists, chat in between | 6 | 12 | tool-turns + memo | 4 | 18/18 ~770 | 18/18 ~770 | 18/18 ~770 |
| two lists, chat in between | 6 | 60 | all-turns | 1 | 0/18 ~332 | 0/18 ~332 | 0/18 ~332 |
| two lists, chat in between | 6 | 60 | all-turns | 2 | 0/18 ~332 | 0/18 ~332 | 0/18 ~332 |
| two lists, chat in between | 6 | 60 | all-turns | 4 | 0/18 ~332 | 0/18 ~332 | 0/18 ~332 |
| two lists, chat in between | 6 | 60 | tool-turns | 1 | 0/18 ~332 | 0/18 ~332 | 0/18 ~332 |
| two lists, chat in between | 6 | 60 | tool-turns | 2 | 0/18 ~332 | 0/18 ~332 | 0/18 ~332 |
| two lists, chat in between | 6 | 60 | tool-turns | 4 | 0/18 ~332 | 0/18 ~332 | 0/18 ~332 |
| two lists, chat in between | 6 | 60 | all-turns + memo | 1 | 18/18 ~788 | 18/18 ~788 | 18/18 ~788 |
| two lists, chat in between | 6 | 60 | all-turns + memo | 2 | 18/18 ~788 | 18/18 ~788 | 18/18 ~788 |
| two lists, chat in between | 6 | 60 | all-turns + memo | 4 | 18/18 ~788 | 18/18 ~788 | 18/18 ~788 |
| two lists, chat in between | 6 | 60 | tool-turns + memo | 1 | 18/18 ~788 | 18/18 ~788 | 18/18 ~788 |
| two lists, chat in between | 6 | 60 | tool-turns + memo | 2 | 18/18 ~788 | 18/18 ~788 | 18/18 ~788 |
| two lists, chat in between | 6 | 60 | tool-turns + memo | 4 | 18/18 ~788 | 18/18 ~788 | 18/18 ~788 |
<!-- measurement:end -->
