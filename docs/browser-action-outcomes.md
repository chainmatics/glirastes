# Browser action requests and execution feedback

Generated navigation, filter and client-action tools request browser work. Their
server result has `requested: true`, `executionStatus: 'unconfirmed'`. The existing
`success: true` field means the request was created, **not** that the browser ran
it. This compatibility field must not be used as an execution receipt. The same
rule applies to declarative `uiToolToTool` tools; their legacy `successMessage`
is no longer emitted as proof of execution.

The built-in chat shows local feedback after dispatch. A handler returning `false`
is rejected; a thrown exception, missing handler, registration timeout and
execution timeout have separate outcomes. Only a settled handler that did not
return `false` is locally reported as completed. This is the application's
handler contract, not an independent observation of rendered pixels. A void
handler remains supported; return `false` when the requested record is absent.

For a route-bound action, register `useAiClientAction(id, handler, schema,
{ route: '/board' })` and the navigation bridge. The chat navigates when the
handler is missing and waits up to five seconds for registration. Execution
waiting is bounded at ten seconds. `dispatchToolResultUiActions` exposes
`routeTimeoutMs`, `executionTimeoutMs` and an abort `signal` for custom clients.
The error's `status` is `rejected`, `missing-handler`, `exception`, `timeout`, or
`cancelled`. A timeout is **unknown**, never evidence that a running handler had
no effect; inspect the app before trying again. Cancellation prevents queued
route work, but cannot undo an already-running application handler.

The provider dispatches each tool-call ID once, retains local feedback as a
`data-ui-action-status` message part, restores history without replaying actions,
and cancels queued actions when leaving the session or unmounting. It does not
automatically retry failures. Use unique tool-call IDs in custom transports.
Legacy generated UI results are marked unconfirmed when loading history; their old success summaries are suppressed. Existing free-form model text is not rewritten. Original structured command markers stay in stored messages; automatic session
titles use only their readable label.

There is intentionally no server ACK endpoint. Local feedback cannot authorize
server tools, approve mutations or make a server execution claim. Browser state
and stored local messages are user-controlled. The model receives explicit
request-only guidance; models can still phrase answers incorrectly, so the
localized execution feedback is the UI's authoritative account of what its
registered handler reported. Existing custom clients that ignore the new fields
must update their presentation before relying on execution statements.
