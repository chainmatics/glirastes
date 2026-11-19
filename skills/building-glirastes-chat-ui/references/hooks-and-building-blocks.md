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
- Sessions
- Theme and keyboard

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
without a classifier a backend 4xx other than 408/429, such as a 404 the
model then looks up or a 403). `declined` and `expected` are shown
neutrally and counted on their own (`activityDeclinedLabel`,
`activityExpectedLabel`), never as failed. `error` covers a thrown tool
error and every other failure output (`success: false` or an `error` text:
5xx, 408/429, timeout, network, a call the endpoint caller refused locally,
a refused UI tool, a custom tool). The detail of `error` and `expected` is
the output's `error` text. Display only: server counting follows
`classifyToolFailure`. A UI tool's hand-off note is never shown as a detail.

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
- `components.TurnNotice` receives `{ text, status, placement }` (`status` is a
  `TurnNoticeStatus`)
  (`placement` is `'log'` inside the log, `'message'` outside). The default
  is exported as `TurnNotice` for wrapping.
- `components.MessageParts` arranges the parts inside the bubble root and
  receives `message`, the nodes (`MessagePartNodes`) `plan`, `activity`, `notice`, `attachments`,
  `text`, `toolResults` (each `null` when absent) and `children` (all of them
  in the default order). `useMessageParts(message)` returns the same nodes
  plus `visible` for a custom `MessageBubble`.
- CSS-only themes select the parts by their existing hooks:
  `[data-component="plan-checklist"]`, `[data-component="activity-log"]`,
  `[data-component="turn-notice"]`, `[data-element="message-attachments"]`,
  `[data-component="markdown"]` / `[data-component="message-rich-text"]`,
  `[data-component="tool-result"]`.
- Every text of the log comes from `locale` (and `locales`): besides the
  `activity*` labels, `activityRunningLabel` (`{label}…`),
  `activityStepCountLabel` (`×{count}`) and `activitySummarySeparator` (`, `).
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
- A custom `ApprovalCard` or `BulkApprovalCard` (`components`) does not get
  this for free: render `approval.subjects` yourself (grouped card: on each
  entry of `approvals`). One entry per id argument, `{ path, id, label?,
  status, name?, names?, candidates?, fallback? }` with `status` `named` | `seen` |
  `unknown` | `ambiguous`; show `fallback` or the id without a warning for
  `seen`, a warning with the id for `unknown` and `ambiguous`. An `ambiguous`
  subject without `name` but with `candidates` (`{ label, name? }[]`) is an
  id of different kinds: list every candidate, name none. A card that
  renders only `details` drops the safeguard silently.

## Sessions

`createRestSessionBridge({ baseUrl, headers })` wires `list`, `load`,
`create`, `remove` and `rename` to a conventional REST API for
`SessionSwitcher`; `mapSession` / `mapMessage` adapt field names, `request`
takes over the transport.

## Theme and keyboard

`defaultTheme` holds the default tokens; spread `tailwindThemeExtension` into
the Tailwind config to get `chat-primary`, `chat-border` and the other
`--chat-*` colors as utilities. `useKeyboardShortcut('mod+i', toggle)` binds a
global shortcut (`mod` is ⌘ on macOS, Ctrl elsewhere), `useChatShortcuts`
the chat window keys, `usePushToTalkHotkey` a hold-to-talk combination, and
`useFloatingPanel` moves and resizes a floating panel by pointer or keyboard.
