# UI action outcomes

A UI tool (`ui.navigate`, `ui.filter.<view>`, `ui.<actionId>`, a
`defineUiTool` with a `uiAction`) runs nothing on the server: it hands an
action to the browser. The outcome protocol (version 1) lets the model learn
what the browser made of it before it answers.

## Who gets what

The result shape follows the request flag `glirastesUiOutcomes: 1`, not the
mode: a client that sends it reads `handedOff`; a client without it (a 0.17
browser runs an action only with `success: true`) gets exactly the 0.17.3
result. `createAiChatHandler({ uiToolResultShape })` decides:

| `uiToolResultShape` | Request with the flag | Request without the flag |
| --- | --- | --- |
| `'auto'` (default) | `{ handedOff: true, message, uiAction }` | `{ success: true, message, uiAction }` (0.17.3, byte-identical) |
| `'handoff'` | `{ handedOff: true, message, uiAction }` | `{ handedOff: true, message, uiAction }` (a 0.17 browser runs nothing) |
| `'legacy'` | `{ success: true, message, uiAction }` | `{ success: true, message, uiAction }` |

`message` is the hand-off note of 0.17.3 (the page-bound variant names the
route; a `defineUiTool` keeps its `successMessage`). A UI tool without a
`uiAction` always returns `{ success: true, message }`. The marker
(`awaitsOutcome`) is added on top, only with the flag:

| Path | Shape under `'auto'` | Marker |
| --- | --- | --- |
| Built-in stream handler, flag, mode `confirm` (default) | hand-off | `awaitsOutcome: true`, the request ends after the step |
| Built-in stream handler, flag, mode `report-only` | hand-off | `awaitsOutcome: false`, the model writes on |
| Built-in stream handler, flag, `uiActionOutcomes: 'off'` (server) | hand-off | none |
| Flag, after `MAX_UI_OUTCOME_CONTINUATIONS` stops in the turn | hand-off | none (`awaitsOutcome: false` for a `defineUiTool` with `outcome: 'confirm'`) |
| No flag: glirastes 0.17 or older, provider `uiActionOutcomes={false}`, transport `uiActionOutcomes: false`, own client on `/server/http`, Slack bot, SSR | 0.17.3 (`success: true`) | none |
| Custom `streamHandler` | by the flag | never |
| Direct commands (`/command`) | by the flag | never |
| Custom `ChatTransport` (only `useVercelAiChatTransport` sends the flag) | by the flag it sends; none: 0.17.3 | only with the flag; send it only when the client does steps 3 and 4 below |
| `toolsToAiTools` / `toolToAiTool` called directly (no request) | `success: true` (option default `'legacy'`; `'handoff'` on request) | never |
| Runtime container | same handler, `'auto'` (not configurable) | `chat.uiActionOutcomes` |

Without a marker the model answers in the same request; with the hand-off
shape it is told the action was handed over, not that it happened (the
0.17.3 note says the same). `uiActionOutcomes: 'off'` plus
`uiToolResultShape: 'legacy'` restores 0.17.3 for every client.

## Wire format

1. Every request of a reporting client carries `glirastesUiOutcomes: 1`. Any
   other value counts as missing.
2. Server, mode `confirm` (default): a result that hands a `glirastes.*`
   action off gets `awaitsOutcome: true`; the request ends after that step
   (`finish`, finish reason `tool-calls`, no stop notice, `onFinish` has
   `awaitingUiOutcome: true`). Mode `report-only`: `awaitsOutcome: false`, no
   stop. A function `(toolName) => mode` decides per tool.
3. Browser: runs the actions, then writes the result back with
   `outcome: { v: 1, code }` (`addToolOutput`). Codes: `ok`,
   `rejected-contract`, `rejected-handler`, `unavailable`, `failed`,
   `initiated` (with `at`, the browser time in ms). A timeout or an older bus
   writes `{ v: 1 }` (not confirmed). An outcome is only written while its
   result is in the last message: a `report-only` outcome that arrives after
   the user sent the next message is dropped (`reported: false`) and the model
   reads "not confirmed".
4. Browser: sends the history again once every `awaitsOutcome: true` result of
   the last step has an `outcome`, no approval is open and no clarification is
   in that step. Never for `initiated` on the leaving page.
5. Server: every result with `awaitsOutcome` (or an `outcome` next to a
   `uiAction`) is replaced completely by `UI_OUTCOME_MODEL_TEXTS[code]`
   (`glirastes/contracts`); an unknown version, code or no code reads as "not
   confirmed, and it will not be carried out later". The code is only a key:
   no text from the client reaches the model this way. `onFinish` gets
   `continuation: 'ui-outcome'`, metrics a `turn.continued` event. Its
   `turnId` is an opaque HMAC of the turn (32 hex characters, keyed by the
   approval secret), the same for every continuation of the turn; the
   client's message id never reaches the Platform. The Platform can group a
   turn's continuations by it and count turns from `turn.finished`, which
   carries no `turnId`, so it cannot join the first request of a turn to its
   continuations (see `docs/managed-runtime-sync.md`, Runtime metrics).

A custom client opts in by doing 1, 3 and 4 itself.

## Limits and cost

At most three continuations per turn (`MAX_UI_OUTCOME_CONTINUATIONS`), each
with fresh per-request budgets, as approvals already have. The request after
the third answers as in the fallback. **A turn can cost up to four times the
per-request budgets.**

| | per request (local defaults) | turn with 3 continuations |
| --- | --- | --- |
| Model steps | 6 | 24 |
| Tool calls | 8 | 32 |
| Input tokens | 40k | 160k |
| Output tokens | 4k | 16k |
| Cost | $0.50 | $2.00 |
| Server time | 60 s | 240 s |

Without `managedRuntime` only the step cap of 24 per request applies. The
expected extra cost is close to zero: a continuation replaces the step the
model runs anyway after a tool call (about 40–60 more input tokens, about
$0.0002 at $3/M, with or without prompt caching). Only a deliberate retry
after a refusal costs a full step.

Waiting in the browser counts nowhere; the server holds no state. Result
handles (`read_result`) of the first request are gone in the continuation
(`result_expired`), as after an approval. Tools `find_tools` added stay offered.

## App without client-side routing

`registerDocumentNavigation()` (or a bridge with `reloads`) loads the next page
with `location.assign`. Before it does, the chat writes `initiated`, waits
until the running step has all its results (at most the outcome timeout),
marks every other result of the step that still waits as "not confirmed" in
the saved copy (it never runs later) and calls `session.save` (at most
500 ms). Should the bridge refuse the navigation, the page stays and the other
results run as usual. On the new page, `session.load` restores the
history without running anything, and the chat continues the turn once
(`continueTurn`, no new message) when the last step waited for outcomes, all
have a code, one is `initiated` at most 60 s ago and no text follows. The
model then says the page was opened. Without `session` the new page starts
empty and nothing is continued. A bridge that reloads without `reloads` is
caught on `pagehide` (outcome `initiated` for a running navigation, "not
confirmed" for any other running action; saved as far as possible).

## Stop while the chat waits

The request already ended, so Stop (or `queue.sendNow` with `'abort'`, the
default) ends the wait itself: the chat stops waiting at once, writes no
outcome and starts no continuation, also when the handler settles later. The
turn ends as `aborted` (`stopped`, or `send-now`), and `onUiActionOutcome`
fires once with `code: 'unconfirmed'` and `reported: false`. The result stays
without an outcome, so the next turn's request makes the server tell the model
"not confirmed". A page load a reloading bridge prepares for the result is
cancelled when Stop comes before its outcome is written (no `initiated`).

Known limit: the handler gets no signal yet. An app dialog it opened can stay
open; if the user confirms there afterwards, the app may still carry the
action out, while the model reads "not confirmed".

## Never late

A UI action runs only in the chat whose running request delivered it, until
that stream and its timeout end. A result that already has an `outcome`, or
comes from a stored history, never runs. A page-load continuation is a model
call only.

## Hand-written UI tools

`defineUiTool({ …, outcome: 'confirm' })` opts in: the chat runs its own
action types through the UI action bus (`useAiClientActionByType`) and
reports them. Without it, its actions stay with `onToolResult` and are not
reported; a result that mixes own action types with `glirastes.*` ones is then
not marked at all (fallback), so nothing of it runs twice. `onToolResult` is still called for an opted-in result; skip results
with `awaitsOutcome` there to not run them twice.

## Migration

- Register a navigation bridge (`useGlirastesNavigationBridge`,
  `registerNavigationBridge`, `registerDocumentNavigation`), otherwise
  navigation reports `unavailable`.
- Handlers return `false` (or throw) instead of failing silently, and resolve
  once the effect is visible. This holds for every handler on the bus
  (`subscribeById`, `subscribeByType`, `useAiClientActionById`,
  `useAiClientActionByType`), not only `registerAiClientAction`: `false` is
  reported as `rejected-handler`.
- Code that reads `success` on UI tool results reads `handedOff` too (it
  gets `handedOff` only for requests with the flag, or with
  `uiToolResultShape: 'handoff'`).
- Strict body validation in front of the chat endpoint allows
  `glirastesUiOutcomes`.
- Count turns by requests without `continuation` (or by `turnId` in the
  metric events), not by the number of `onFinish` calls: `onFinish` fires
  once per request, so a UI turn calls it at least twice (see "Counting turns"
  below).
- `uiActionOutcomes: 'off'` plus `uiToolResultShape: 'legacy'` restores 0.17.3.

## Counting turns

`onFinish` of `createAiChatHandler` fires once per request. With the outcome
protocol a turn that calls a UI tool takes at least two requests: a request
that ends with `awaitingUiOutcome: true` is followed by one with
`continuation: 'ui-outcome'`, once per reported step, at most
`MAX_UI_OUTCOME_CONTINUATIONS` (3) per turn. An answered approval adds a
request with `continuation: 'approval'`, also in the same turn as UI outcomes.
Count one logical turn per request without `continuation` and add the usage
of every request to it:

```ts
createAiChatHandler({
  // ...
  onFinish: (event) => {
    if (!event.continuation) metrics.turns += 1; // one logical turn
    metrics.requests += 1;
    metrics.totalTokens += event.usage.totalTokens; // continuations cost too
  },
});
```

`onFinish` carries no turn id. The content-free `metrics` events report a
continuation as `turn.continued` with an opaque `turnId` (see
`docs/managed-runtime-sync.md`, Runtime metrics).
