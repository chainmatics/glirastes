# Hooks and building blocks

For a chat the stock `VercelAiChat` does not cover. Everything here comes from
`glirastes/react` unless noted, and the hooks need an `AiChatProvider` above
them.

## Contents

- Own provider and transport
- Headless hooks
- Components
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
`done`, `error`, `waiting` or `declined` (an approval refused: shown
neutrally, not counted as failed).

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
  it ("Playlist: Abend-Promos") instead of the id. An id without a known name
  gets a warning with the id shown (`role="alert"`, icon, danger colours,
  linked from the approve button); a short id shown with different names gets
  a warning too. Texts: `approvalTargetLabel`, `approvalUnknownIdWarning`,
  `approvalUnknownIdsWarning`, `approvalAmbiguousIdWarning` in `locale`
  (English and German built in). A custom card reads
  `PendingApproval.subjects` (`ApprovalSubject[]`). The names are client-side
  history, a convenience and not a trust boundary: the server executes exactly
  the signed arguments. A subject the server resolves and signs is the planned
  stronger variant. Details: `docs/concepts.md`, Approvals.
- A custom `ApprovalCard` or `BulkApprovalCard` (`components`) does not get
  this for free: render `approval.subjects` yourself (grouped card: on each
  entry of `approvals`). One entry per id argument, `{ path, id, label?,
  status, name?, names? }` with `status` `named` | `unknown` | `ambiguous`;
  show a warning with the id for `unknown` and `ambiguous`. A card that
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
