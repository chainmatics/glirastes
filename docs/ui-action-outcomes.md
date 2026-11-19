# UI action outcomes

A UI tool (`ui.navigate`, `ui.filter.<view>`, `ui.<actionId>`, a
`defineUiTool` with a `uiAction`) runs nothing on the server: it hands an
action to the browser. The outcome protocol (version 1) lets the model learn
what the browser made of it before it answers.

## Who gets what

| Setup | Effect |
| --- | --- |
| `AiChatProvider` + `useVercelAiChatTransport`, `VercelAiChat`, `<glirastes-chat>` | protocol on (default) |
| Server `uiActionOutcomes: 'off'`, provider `uiActionOutcomes={false}`, transport `uiActionOutcomes: false` | fallback |
| Client without the flag (glirastes 0.17 or older, own client on `/server/http`, Slack bot, SSR) | fallback |
| Custom `ChatTransport` without `addToolOutput` | fallback |
| Custom `streamHandler`, direct commands | fallback (never marked) |
| Runtime container | same handler; `chat.uiActionOutcomes` in the configuration |

Fallback: the result is `{ handedOff: true, message, uiAction }`, the model
answers in the same request and is told the action was handed over, not that
it happened. `uiToolResultShape: 'legacy'` on `createAiChatHandler` keeps the
0.17 shape `{ success: true, message, uiAction }`.

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
   `continuation: 'ui-outcome'`, metrics a `turn.continued` event.

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
caught on `pagehide` (outcome `initiated`, saved as far as possible).

## Never late

A UI action runs only in the chat whose running request delivered it, until
that stream and its timeout end. A result that already has an `outcome`, or
comes from a stored history, never runs. A page-load continuation is a model
call only.

## Hand-written UI tools

`defineUiTool({ …, outcome: 'confirm' })` opts in: the chat runs its own
action types through the UI action bus (`useAiClientActionByType`) and
reports them. Without it, its actions stay with `onToolResult` and are not
reported. `onToolResult` is still called for an opted-in result; skip results
with `awaitsOutcome` there to not run them twice.

## Migration

- Register a navigation bridge (`useGlirastesNavigationBridge`,
  `registerNavigationBridge`, `registerDocumentNavigation`), otherwise
  navigation reports `unavailable`.
- Handlers return `false` (or throw) instead of failing silently, and resolve
  once the effect is visible.
- Code that reads `success` on UI tool results reads `handedOff` too.
- Strict body validation in front of the chat endpoint allows
  `glirastesUiOutcomes`.
- Count turns by requests without `continuation` (or by `turnId`), not by
  `onFinish`.
- `uiActionOutcomes: 'off'` plus `uiToolResultShape: 'legacy'` restores 0.17.3.
