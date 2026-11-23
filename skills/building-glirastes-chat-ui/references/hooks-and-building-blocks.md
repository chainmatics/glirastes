# Hooks and building blocks

For a chat the stock `VercelAiChat` does not cover. Everything here comes from
`glirastes/react` unless noted, and the hooks need an `AiChatProvider` above
them.

## Contents

- Own provider and transport
- Headless hooks
- Components
- Message layout
- Tool results and approvals
- UI action outcomes
- Sessions
- Theme and keyboard
- Speech worklet

## Own provider and transport

`useVercelAiChatTransport({ endpoint, headers, bodyExtras })` from
`glirastes/react/vercel` (alias `useVercel`) builds the `transport` an own
`AiChatProvider` needs; `bodyExtras` may be a function, e.g. to send the
current session id with every request.

## Headless hooks

| Hook | Returns |
| --- | --- |
| `useAiChat()` | `messages`, `send`, `stop`, `clear`, `isLoading`, `error`, `loadMore` / `hasMore`, `pipelineSteps` |
| `useApprovals()` | `pending`, `approve`, `reject`, `grouped` by tool, `approveGroup`, `rejectGroup`, `isProcessing` |
| `useMentions()` | `query`, `results`, `select`, `activeMentions`, `isSearching` |
| `useSuggestions()` | follow-up `chips`, `select`, `refresh`, `isGenerating` |
| `useChatContext()` | the whole provider state, including session list operations |

## Components

`AiChatPanel` is unstyled; `StyledChatPanel` is the same panel with Tailwind
classes and `classNames` per slot. `MessageList` scrolls, auto-follows and
pages upwards through `loadMore`. `PlanChecklist` renders the latest
`update_plan` call (nothing below two items), `ActivityLog` the collapsible
work log of one assistant turn; both style through `data-*` attributes.
`readActivitySteps` gives each step an `ActivityStepStatus`: `running`,
`done`, `error`, `waiting`, `declined` (an approval refused) or `expected`
(a failure that is a normal answer: `success: false` with
`expectedFailure: true` from `classifyToolFailure` at any status, or
without a marker a backend 4xx other than 408/429, such as a 404 the
model then looks up or a 403; `expectedFailure: false`, the classifier's
`'error'`, is always `error`). `declined` and `expected` are shown
neutrally and counted on their own (`activityDeclinedLabel`,
`activityExpectedLabel`), never as failed. `error` covers a thrown tool
error and every other failure output (`success: false` or an `error` text:
5xx, 408/429, timeout, network, a call the endpoint caller refused locally,
a refused UI tool, a custom tool). The detail of `error` and `expected` is
the output's `error` text (shown per `activityLog.details`). Its `allowDetail(toolName, status, source)` gets the
`ActivityDetailSource` (`'output'` or `'error-text'`). A `declined`
step has `declinedBy: 'user' | 'server'` (the server did not run an approved
call). The summary counts done, failed, declined and neutral steps apart
and leaves out what is zero (`1 step done, 1 declined`, `2 declined`). Display only: server counting follows
`classifyToolFailure`. A UI tool's hand-off note is never shown as a detail.
Once its turn no longer runs (`active` false: the user stopped, the request
failed, a stored history), `ActivityLog` shows a step still `running` as
`aborted` (`data-status="aborted"`, a stop icon, counted on its own as
`activityAbortedLabel`, `{count} stopped`, never as failed) and closes the
log; a step `waiting` for approval stays `waiting`, a UI action still waiting
for its outcome shows "not confirmed".

## Message layout

Defaults keep today's markup; everything below is opt-in.

- `activityLog` on the provider (all off by default):
  `expandWhileRunning` opens the log while its turn runs and collapses it
  when the turn is over (a user toggle wins); `runningProgress` counts the
  finished steps in the running summary (`activityRunningProgressLabel`,
  "2 done, Listing devices…"); `noticePlacement: 'message'` moves the stop or
  error notice of the latest turn out of the log into its own
  `<p data-component="turn-notice" data-status="safety-stop|aborted|error">`
  right after it. A turn without steps always shows the notice that way.
  `details` (`ActivityLogDetails`, default `'auto'`): a failed or neutral step shows the error
  text its tool returned and a call the server did not run despite the
  approval shows `activityApprovalNotUsedDetail`, whatever `toolResults`;
  a done step's message (and an SDK-written `output-error` text) only where
  its result is displayed. `'results'` is the rule before 0.18.0 for every
  step, `'all'` / `'none'` show every / no detail. `grouping: 'sections'`
  renders one log per run of steps at its place between the texts of a
  message (text, steps, text); with it the logs are part of the `text` node
  and `activity` is `null` for such a message. `noticeScope` (default `'every'`)
  keeps the notice on every stopped, failed or safety-stopped turn, after
  later turns and a reload, in the same place as for the latest turn; a turn
  that ended before an assistant message existed shows it as
  `turn-notice` right after its question. `'latest'` is the behaviour
  before 0.20.0 (latest turn only). An app that draws its own notice sets
  `'latest'` or `components.TurnNotice: () => null`, else both show.
  `hiddenTools` (default `[]`) lists model-facing tool names (`'ui_action_toast'`,
  `'ui_action_refresh'`) that never show: no step, no summary count, no
  section split, and they do not hide the typing indicator; the tool still
  runs and its UI action still fires.
- Message footer: `messageFooter` (`true`, or `MessageFooterConfig` with
  `copy` / `sources` / `duration` / `stop`, each true once the footer is on;
  default off) renders `<div data-component="message-footer"
  data-state="done|running">` last in each assistant bubble. Done: `copy`
  writes the rendered answer as HTML with inline styles (pastes into
  Word/Outlook; lists, tables, links; mention chips keep their names) plus
  plain text, falling back to text only, and shows "Copied" / "Copy failed"
  (`aria-live`); a `components.Markdown` of your own copies as rich text only
  when its root has `data-component="markdown"`, else the plain Markdown; `sources` is a toggle (`aria-expanded`, `aria-controls`)
  over the https links the answer cites (its Markdown links, AI SDK
  `source-url` parts, tool output `sources` / `citations`; no credentials,
  deduplicated, at most 20, opened with `noopener noreferrer`); `duration`
  shows "Done in 3.2 s" (under 0.1 s "< 0.1 s") under the last answer of a
  completed turn from `TurnOutcome.durationMs` (the time the turn's requests
  ran, a UI action continuation included, approval waits excluded, measured
  in the browser and stored with the outcome). Running:
  the elapsed time (`aria-hidden`) and a stop button (`stopButton`). Locale
  keys `copyMessageLabel`, `copiedMessageLabel`, `copyMessageFailedLabel`,
  `messageSourceOneLabel`, `messageSourcesLabel` (`{count}`),
  `messageDurationLabel` (`{duration}`). A custom `MessageParts` that does not
  render `children` places `footer` (`MessagePartNodes.footer`) itself.
  Nothing of it leaves the browser.
- Follow-ups under the answer: `suggestions.placement: 'message'` (default
  `'composer'`, the rotating `SuggestionBar`) shows the latest answer's
  follow-ups (`suggest_followups`, needs `followups` together with
  `pipeline` on the server, which warns once otherwise; or its trailing
  suggestion list; `suggestions.count`, default 3) as buttons in a
  `role="group"` headed `followUpsLabel` ("Ask next") inside the footer, also
  without `messageFooter`. A click sends. Hidden while a turn runs, an
  approval or clarification is open, after a stop, error or safety stop,
  under older answers and with `enabled: false`; disabled while the
  composer is locked. The `SuggestionBar` and `staticChips` show nowhere
  then; use `composer.starters` for an empty chat. The bar itself honours
  `enabled: false` and shows only the latest turn's follow-ups (else
  `staticChips`). `useSuggestions().chips` still returns chips with
  `enabled: false`: a bar of your own checks the config itself.
- `components.TurnNotice` receives `{ text, status, placement, outcome? }` (`status` is a
  `TurnNoticeStatus`)
  (`placement` is `'log'` inside the log, `'message'` outside; `outcome` the
  turn's `TurnOutcome` when one is recorded). The default
  is exported as `TurnNotice` for wrapping.
- Turn outcomes: `useTurnOutcome(message)` returns the `TurnOutcome`
  (`{ userMessageId, status, reason, at, durationMs? }`; `TurnOutcomeStatus` `completed` |
  `aborted` | `safety-stop` | `error`, `TurnOutcomeReason` `finished` |
  `stopped` | `send-now` | `request-failed` | `pipeline`) of the turn a user
  or assistant message belongs to, or null; `useTurnOutcomes()` all of them
  by user message id. Recorded also when the turn has no assistant message
  (stop or network error before the first token), kept after later turns
  and, with a session store, after a reload (`metadata.glirastesTurnOutcome`
  of the stored user message; the app's own `metadata` round-trips exactly,
  a non-object `metadata` keeps the message unchanged and its outcome
  unstored). The provider takes the key out of a history from `session.load`
  and out of one the app hands to its own transport, so the chat's requests
  do not carry it; the app's own code reading the store does see it. An
  outcome stays with the chat its request started in (a host switch while it
  runs records nothing on the new chat). A retry of the turn replaces it. A custom `MessageBubble` also gets it as `turnOutcome`. Draw a
  per-turn notice from this, not from `pipelineState` (only the latest run's).
- To act once when a turn ends (refresh data, play a sound, log), pass
  `onTurnEnd(outcome, info)` (`OnTurnEnd`; `info` is `TurnEndInfo`
  `{ sessionId }`) to the provider instead of diffing `turnOutcomes`: called
  once per turn of the open chat for every status, after the outcome is in
  `turnOutcomes`, when its last request is over (not at an open approval, not
  before a UI action outcome continuation, not on a page a UI action leaves
  with a page load). Not for stored history, a turn whose chat is not the open
  one when it ends, or a run cleared with `clear()`; a retry reports its own
  end. A throw or a rejected promise is caught. Details: `docs/concepts.md`.
- `components.MessageParts` arranges the parts inside the bubble root and
  receives `message`, the nodes (`MessagePartNodes`) `plan`, `activity`, `notice`, `attachments`,
  `text`, `toolResults`, `continuation`, `footer` (each `null` when absent) and `children` (all of them
  in the default order) and `turnOutcome`. `useMessageParts(message)` returns the same nodes
  plus `visible` and `turnOutcome` for a custom `MessageBubble`. A layout that drops `children`
  places `continuation` itself, or the user loses the "Continue" button after a stop.
- `continuation`: the "Continue" button (`locale.continueButton`, German "Weitermachen") under
  the latest answer when the server's stop notice ends it with a continuable `data-budget-stop`
  part; a `<button type="button" data-action="continue-after-stop">` in
  `[data-element="budget-continue"]`, before the footer. A click calls
  `continueAfterBudgetStop()` of the chat context (present only when the transport has
  `ChatTransport.continueAfterBudgetStop`, as `useVercelAiChatTransport` does), which resends the
  history with `glirastesContinuation: 'budget'`. A custom transport implements it the same way
  or the button is not shown.
- `parts` (in `MessagePartsProps` and from `useMessageParts`): every part of
  the message in message order as a `MessagePartEntry` `{ key, index, kind,
  part, toolName?, toolCallId?, node, approval? }` (`MessagePartKind`
  `text` | `tool` | `file` | `other`; `key` is `tool:<toolCallId>` or
  `<kind>:<index>`, stable while the message grows). `node` is the default
  rendering at that position (`null` when nothing shows), so a layout can
  put its own content at a tool part and keep the rest:
  `parts.map((p) => p.key === myKey ? <Mine key={p.key} /> : p.node)`.
- `approval` of a tool part that asked for one is a `ToolPartApproval`
  `{ approvalId, toolCallId?, toolName, state: 'open' | 'decided',
  decision?: ApprovalDecision, outcome: ApprovalOutcome, label, details?,
  subjects?, pending? }`; `outcome` is `open`, `running`, `done`, `failed`,
  `expected`, `declined`, `not-run` (approved, but the server did not run
  it) or `aborted` (approved, no result, and the turn no longer runs:
  stopped, failed, a stored history; `approvalEntryAbortedLabel`, "Approved,
  stopped"). An approved call stays `running` while another approval of the
  message is open and between the answer and the chat's automatic resend
  (`isApprovalResendPending` of the context). A decided one is described again from the part's input and the
  conversation the browser holds, also after a reload; read when accessed,
  local only, nothing is sent.
- `approvalDisplay` on the provider (`ApprovalDisplayConfig`, defaults as
  before): `decided: 'entry'` draws a lasting `ApprovalEntry`
  (`<div data-component="approval-entry" data-decision data-outcome>`,
  replaceable as `components.ApprovalEntry`, props `ApprovalEntryProps`;
  texts `approvalEntryRunningLabel`, `…DoneLabel`, `…FailedLabel`,
  `…ExpectedLabel`, `…DeclinedLabel`, `…NotRunLabel`, `approvalOutcomeText`)
  at the tool part. The built-in entry sits inside the message at its tool
  part, one per tool call (calls of one tool are not merged); it shows the
  label, subject names, preview and field details (`detail-line`,
  `detail-label`, `detail-value`; hooks `data-decision`, `data-outcome`). It
  has no link to a created object, and its field labels come from the tool
  declaration (and `approvalDescription`), not app-defined ones. An app that
  needs those builds its own entry from `parts[].approval` or
  `components.ApprovalEntry`. An app that already draws its own entry for
  decided approvals (for example from `useMessageParts` /
  `components.MessageParts`) must not also set `decided: 'entry'`: both
  would show, side by side. `open: 'inline'` draws the open `ApprovalCard` at its
  tool part instead of below the messages (one card per call, no bulk
  card). With either option the default bubble renders the text and tool
  parts of a message with an approval in message order. A custom bubble that renders neither `toolResults` nor `parts`
  must place the inline card itself (`approval.pending` with
  `useChatContext().approve` / `reject`).
- CSS-only themes select the parts by their existing hooks:
  `[data-component="plan-checklist"]`, `[data-component="activity-log"]`,
  `[data-component="turn-notice"]`, `[data-element="message-attachments"]`,
  `[data-component="markdown"]` / `[data-component="message-rich-text"]`,
  `[data-component="tool-result"]`.
- Every text of the log comes from `locale` (and `locales`, so an app can
  add a language such as `pl`): besides the `activity*` labels,
  `activityRunningLabel` (`{label}…`), `activityStepCountLabel` (`×{count}`),
  `activitySummarySeparator` (`, `) and `activityApprovalNotUsedDetail`.
  `{count}` of `activityDoneLabel` and `activityRunningProgressLabel` is the
  number of done steps.
- A failed step's detail whose text the SDK wrote itself can show in the
  chat's language. Covered, each through the channel the SDK writes it:
  the server's `errorText` of a refused call (tool not available, not
  permitted, user not identified, account, disabled, refused), invalid tool
  input, a turn limit (one key per limit, `{limit}`), a record refused before
  its approval card and the generic "AI request failed"; in the tool's
  result, the endpoint caller's fixed texts (`Endpoint failed ({status})`
  with three digits matching the result's `status`, path refused, timeout
  and response too large with the step's own tool as `{tool}`) and the texts
  of the memory tools `memory_remember` / `memory_forget` (only for those
  two). Keys `activityFailure…` (all optional in `ChatLocale`, see its
  JSDoc), English word for word as the server writes it, German in
  `deChatLocale`. `{limit}` and `{max}` use the chat language's number
  format (`0,5 USD`, `1,5 s`) except in the English built-in text. Which
  steps show a detail is unchanged (`details`); the English text is
  unchanged. Not covered (shown as before): the generated UI tool's "This
  action is not available on the page the user has open. …" and the codes a
  direct command returns (`command_failed`, `command_tool_unavailable`,
  `approval_already_used`, `approval_binding_unavailable`, denial reasons).
  A text of the app's backend or tool is shown as it is, and so is a text
  this version does not know (a newer server); the one exception is an app
  backend that answers an endpoint tool with the endpoint caller's own
  wording (`Endpoint failed (503)`, `Endpoint path is not allowed`), which
  cannot be told apart from it. `readActivitySteps` sets `failures`
  (`StepFailure[]`, `{ code: StepFailureCode, values? }`) beside `detail` for
  such a step; `stepFailureText(failures, locale, language?)` renders it, a
  code it does not know as `activityFailureGeneric`. A step without any text
  shows no detail. The generic failure and invalid input are also recognized
  when the server wrote them in another wording (a German chat, the
  handler's own `locales` texts `streamError` / `invalidToolInput`): the
  server then streams a `data-step-failure` part (`{ toolCallId, code }`,
  content-free) after the call, and the log shows the client's
  `activityFailureGeneric` / `activityFailureInvalidInput` (app overrides
  included) instead of the server text. Outside the log the server text
  stays.
- Which table these failure texts follow: the built-in texts of the chat's
  language (German for `de`) when the app states `language`, or when its own
  tables (`locale`, `locales` for that language) set no other `activity…`
  key with a text of their own (a text other than the built-in one of the
  language). An app that words the activity log itself and lets the
  language come from the page `lang` or the server's tool labels keeps the
  English failure texts it showed before. To opt in: state `language`, set
  the `activityFailure…` keys in its own table (any language, also
  `locales.pl`), or spread `deChatLocale` into it.
- Order per text key: the app's `locale`, then `locales[tag]` along the
  language fallback, then the built-in table of the language (`en`, `de`),
  then English. Step titles are not locale keys: the app's `toolLabels`
  (per tool) win, then the label the server sends for the turn
  (`data-tool-presentation`: the manifest's wording when it is in the turn
  language, else the generated labels of that language, another region of
  it, `en`, the first one), else the tool name.
- The chat's language: `language` (stated by the app) wins, else the page's
  `lang` (also when the page sets or changes it after the chat mounted),
  else the language of the server's tool labels;
  `languageSource: 'server'` puts the tool labels first (before 0.18.0).
  Keys a partial `locale` or `locales[tag]` lacks follow that language's
  fallback (the language, another region of it, `en`). The chat names
  `language`, else the page's `lang`, in each request as the
  `Content-Language` header (`sendLanguage: false` sends none; not with
  `languageSource: 'server'`); the handler takes it as the turn language
  unless it sets `requestLocale` or `locale` (`clientLanguage: false`): a
  fixed handler `locale` wins over the language the page sends. For a
  language stored per user (the app's database), pass it as `language` here
  (built-in texts) and read it in the handler's `requestLocale` (tool labels,
  approval card, the handler's own texts); see the Next.js handler options,
  "The user's language from the app's database".
- Under `prefers-reduced-motion: reduce` the status spinner stands still as
  an open arc (`data-motion="reduced"`, also without the stylesheet) and the
  shipped styles stop the typing dots and dialog animations.

## Tool results and approvals

- `toolRenderers` on the provider: compact components per tool
  `definitionId` and `schemaVersion` with an `outputSchema`; the provider
  builds them with `createToolResultRendererRegistry`. Unknown tools and
  outputs that fail the schema fall back to the default block.
- `createToolResultHandler({ actionHandlers, onSuccess, toolFallbacks })`
  builds an `onToolResult` callback: handlers per `uiAction` type, a callback
  for every successful result and fallbacks per tool name.
- `createApprovalDescriptionGenerator({ toolLabels, dateLocale })` builds the
  provider's `approvalDescription`: readable confirmation text per tool.
- `ApprovalCard` and `BulkApprovalCard` name the ids of the call (on by
  default; `approvalSubjects={false}` on the provider turns it off). An id
  argument (`id`, `…Id`, `…_id`, `…ID`, plural too, or a UUID value) shows the
  name this conversation's tool results or the user's `@` mentions showed for
  it ("Playlist: Abend-Promos") instead of the id. An id without a name that
  a tool result carried as a record id (a version without a name field) is
  shown neutrally with a fallback field (`Version number 3`) or the id and
  "seen in this conversation"; an id that occurred nowhere
  gets a warning with the id shown (`role="alert"`, icon, danger colours,
  linked from the approve button); a short id shown with different names gets
  a warning too, and a short id seen for records of different kinds (user 3,
  playlist 3) is named only when the argument picks one kind (`playlist_id`,
  or a bare `id` of `playlists_delete`), else the card names none and lists
  every candidate. Texts: `approvalTargetLabel`, `approvalUnknownIdWarning`,
  `approvalUnknownIdsWarning`, `approvalAmbiguousIdWarning`,
  `approvalCollidingIdWarning`, `approvalSeenIdNote` in `locale`
  (English and German built in). A custom card reads
  `PendingApproval.subjects` (`ApprovalSubject[]`). The names are client-side
  history, a convenience and not a trust boundary: the server executes exactly
  the signed arguments. A subject the server resolves and signs is the planned
  stronger variant. Details: `docs/concepts.md`, Approvals.
  With a declared identity (`outputEntities` / `inputEntities`, sent by the
  chat handler or set with the provider's `entityDeclarations`) the card
  names records by their declared id (numbers and composite keys too) and
  only for an argument of the declared type; a declared argument's subject
  also carries `type`, `role`, `idKind` and `provenance`, an id the user typed
  verbatim is `seen` (`provenance: 'user-message'`), an unknown `speaking` id
  gets no warning, and `seen` carries `fallbackField` next to the deprecated
  `fallback`. Details: `docs/entity-identity.md`.
- A custom `ApprovalCard` or `BulkApprovalCard` (`components`) does not get
  this for free: render `approval.subjects` yourself (grouped card: on each
  entry of `approvals`). One entry per id argument, `{ path, id, label?,
  status, name?, names?, candidates?, fallback? }` with `status` `named` | `seen` |
  `unknown` | `ambiguous`; show `fallback` or the id without a warning for
  `seen`, a warning with the id for `unknown` and `ambiguous`. An `ambiguous`
  subject without `name` but with `candidates` (`{ label, name? }[]`) is an
  id of different kinds: list every candidate, name none. A card that
  renders only `details` drops the safeguard silently.

## UI action outcomes

`onUiActionOutcome(event)` (type `OnUiActionOutcome`) on the provider fires
once per tool result with generated UI actions (`glirastes.*`), after they
ran. The `UiActionOutcomeEvent` is `{ toolName, toolCallId, code, actions:
[{ type, actionId? }], reported, durationMs, error? }`, no payload. A throw
inside is caught. `reported` is `true` when the outcome was written into the
tool result for the model. `code` is a `UiActionRunCode`: a `UiOutcomeCode` of
the protocol, or `timeout` / `unconfirmed`, which the protocol reports without
a code.

Outcome protocol (default on, `uiActionOutcomes={false}` turns it off): with a
transport that has `addToolOutput` (the bundled Vercel one) every request
sends `glirastesUiOutcomes: 1`; the server marks UI results `awaitsOutcome:
true` and ends the request; the provider writes `outcome: { v: 1, code }` and
the transport sends the history again once all marked results of the step
have one (`shouldContinueChat`), so the model answers after it. The composer
stays locked meanwhile (`isLoading`). A custom `ChatTransport` opts in with
`addToolOutput`, `continueTurn` and `setUiOutcomeReporting`, and sends the
flag itself. The activity log shows the outcome per step (locale keys
`activityUiPendingLabel`, `activityUiRejectedContract`,
`activityUiRejectedHandler`, `activityUiUnavailable`, `activityUiFailed`,
`activityUiInitiated`, `activityUiUnconfirmed`). A request with the flag
gets UI results as `{ handedOff: true, message, uiAction }` without
`success`: a renderer or `onToolResult` that checks `success` checks
`handedOff` too. Without the flag the server sends the 0.17.3
`{ success: true, … }`. With the flag the server's fixed system note
(`UI_OUTCOME_SYSTEM_NOTE`) tells the model not to claim success before the
outcome and not to announce a UI action in text before calling it, so no
interim sentence stays above a refused action. The server's `onFinish` fires
once per request, so a UI turn calls it at least twice (every continuation
after reported outcomes carries `continuation: 'ui-outcome'`, at most 3 per
turn; an answered approval `'approval'`): count turns on the calls without
`continuation`. Details: `docs/ui-action-outcomes.md` of the package.

| `code` | When |
| --- | --- |
| `ok` | every handler resolved (resolve once the effect is visible) |
| `rejected-contract` | the payload failed the contract, or an unsafe route or target |
| `rejected-handler` | a handler or the bridge's `push` returned `false` |
| `failed` | a handler threw |
| `unavailable` | no handler: no navigation bridge, unknown action, a page-bound action that never registered on its route |
| `initiated` | a reloading navigation (`registerDocumentNavigation()`, `reloads: true`) started; nothing after it runs on the page |
| `timeout` | not settled within `uiActionOutcomeTimeoutMs` (default 10000; a page-bound action gets the 5000 ms route wait on top) |
| `unconfirmed` | a bus of an older SDK copy that does not count handlers |

The results of one answer run one after another in call order; a failed call
does not stop the next one, and inside one result the first failure stops the
rest. A UI action runs only from this chat's own running request: results
restored from a stored history (`session.load`, messages the host or a custom
transport set, another tab's sync) or carrying an `outcome` never run and do
not call `onToolResult`. A custom transport must report `submitted` or
`streaming` while a request runs, or none of its results run. Hand-written
`defineUiTool` actions with their own types are not classified and stay with
`onToolResult`, unless the tool opts in with `outcome: 'confirm'`: then the
chat runs them through the bus (`useAiClientActionByType`) and reports them;
skip results with `awaitsOutcome` in `onToolResult`.

After a full page load (`registerDocumentNavigation()`, `reloads`) the chat
writes `initiated` and calls `session.save` before the page goes; the chat on
the new page (`session.load`) continues the turn once within 60 s, as a model
call only. Without `session` nothing is continued.

Handlers refuse with `UiActionRejectedError` (`code` is
`UI_ACTION_REJECTED_ERROR_CODE`, `glirastes.ui-action-rejected`; a
`UiActionRejectionReason` of `contract` or `handler`); `registerAiClientAction`
and the navigation bridge throw it for you. Test with
`isUiActionRejectedError(error)`, never `instanceof`: several SDK copies may
share one page. The default timeout is `UI_ACTION_OUTCOME_TIMEOUT_MS`.
`registerDocumentNavigation(options?: DocumentNavigationOptions)` is the
bridge of an app without client-side routing.

## Sessions

`createRestSessionBridge({ baseUrl, headers })` wires `list`, `load`,
`create`, `remove` and `rename` to a conventional REST API for
`SessionSwitcher`; `mapSession` / `mapMessage` adapt field names, `request`
takes over the transport.

An own session list or switcher disables its controls while
`useSessionLock().locked` is true (a reply streams, an outcome is awaited, a
session operation runs, or a surrounding `ChatWindow` is hidden; inside
`AssistantShell` `visible` is always true, use `useAssistantLayout().open`
there); `SessionSwitcher`
takes `icons` (`newChat`, `rename`, `delete`). See
[placing-the-assistant.md](placing-the-assistant.md), Replacing shell parts.

## Theme and keyboard

`defaultTheme` holds the default tokens; spread `tailwindThemeExtension` into
the Tailwind config to get `chat-primary`, `chat-border` and the other
`--chat-*` colors as utilities. `useKeyboardShortcut('mod+i', toggle)` binds a
global shortcut (`mod` is ⌘ on macOS, Ctrl elsewhere), `useChatShortcuts`
the chat window keys, `usePushToTalkHotkey` a hold-to-talk combination, and
`useFloatingPanel` moves and resizes a floating panel by pointer or keyboard.

## Speech worklet

Required for every voice input: `VoiceInputAddon` (the chat's `voice` config),
`VoiceInputButton`, `useDeepgramTranscription`, `DeepgramSttAdapter` and
`RecordedSttAdapter` all capture microphone audio in an AudioWorklet loaded from
`DEFAULT_AUDIO_WORKLET_URL` (`/audio-worklet-processor.js`, exported from
`glirastes/react` and `glirastes/stt`). Without the served file every recording
fails. The package exports the file as `glirastes/react/audio-worklet-processor.js`.

`glirastes stt worklet` copies it into `public/` (or `--out <dir>`), leaves an
identical copy alone and works on every OS. `glirastes init` chains it in front
of `predev` and `prebuild` for Next.js, Vite and Create React App; for an
existing app add it yourself, in front of the existing commands:

```json
"scripts": {
  "predev": "glirastes stt worklet && glirastes tools refresh --keep-going",
  "prebuild": "glirastes stt worklet && glirastes tools refresh"
}
```

- Vite with its own `root` or `publicDir`: pass that folder,
  `glirastes stt worklet --out web/static`. Served at another path: set
  `voice.workletUrl` (it reaches an own `RecordedSttAdapter` or
  `DeepgramSttAdapter` passed as `voice.adapter`) or the adapter's `workletUrl`.
- yarn berry and pnpm may skip `pre*` scripts; when the app starts `next dev`
  or `vite` directly, run `glirastes stt worklet` once first.
- The copy is a build output: `glirastes init` and `glirastes stt worklet`
  add its path (`/public/audio-worklet-processor.js`, or the `--out` path) to an
  existing `.gitignore` once and never create one; `--no-gitignore` skips it.
  A `!` negation of the path is left alone, CRLF line ends are kept, and a
  path with `[`, `]`, `*`, `?` or `\` gets no entry. An unwritable
  `.gitignore` is only a warning (`--json`: `"gitignore": "failed"`).
  `glirastes init --dry-run` lists each script it adds or changes and the
  `.gitignore` entry.

`glirastes doctor` (check `voice-worklet`) passes only when the file exists in
`public/` at each literal `workletUrl` path, or at the default path when none is
set. It fails (`E-SETUP-034`) without the file or a copy script, and when a
literal `workletUrl` points to a file no copy step creates (the copy writes
`audio-worklet-processor.js` into `public/` or `--out`; e.g. `/custom/worklet.js`
next to a plain `glirastes stt worklet`), naming both paths. It warns
(`E-SETUP-108`) when the copy step that creates the configured file has not run
yet, copies outside `public/`, the URL ends in the copied path under a base
path (`/app/audio-worklet-processor.js` with Next.js `basePath` or Vite `base`),
or the URL is absolute. `workletUrl` literals in test files (`*.test.*`,
`*.spec.*`, `__tests__/`) are not checked.

The mic, stop and retry buttons draw their own icon (`svg[data-icon="mic" |
"stop" | "busy" | "retry"]`) and carry a localized `aria-label`; style them via
`[data-component="voice-input-addon"][data-state]`. An app that hid the old
words with CSS and drew an own icon (`::before`, `content:`) shows two icons:
remove its own icon or hide the shipped `svg[data-icon]`.

When the file cannot be loaded, the chat shows `voiceUnavailableText` as an
alert next to the mic button and logs the URL with `console.error`; the
recording ends in the `failed` phase with `errorCode` set to
`AUDIO_WORKLET_UNAVAILABLE` (`'audio-worklet-unavailable'`); the adapter throws an
`AudioWorkletLoadError` (`url`, `cause`; test with `isAudioWorkletLoadError`),
all from `glirastes/react` and `glirastes/stt`.

Served elsewhere: set `voice.workletUrl` on the chat. It reaches the built-in
adapter and an own `DeepgramSttAdapter` or `RecordedSttAdapter` passed as
`voice.adapter` (their `acceptsWorkletUrl`); an adapter's own
`workletUrl` constructor option wins. A custom adapter without
`acceptsWorkletUrl` ignores `voice.workletUrl` and the chat warns once in the
console; pass the URL to its constructor. Keep an adapter instance stable.
