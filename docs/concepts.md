# glirastes — Simple Explanation

## What is this?

A toolkit for adding AI chat to your app. You define what the AI can do (tools), the SDK handles calling your APIs, filtering who can use what, protecting personal data, and updating the UI — all through a streaming chat experience.

---

## The Main Flow

```
User sends message → Guardrails check → Intent classification → Pick tools → LLM runs → Tool executes → UI updates
```

---

## Core Concepts

### Tool

A tool is something the AI can do. It has a name, a description (so the LLM knows when to use it), an input schema (what parameters it needs), and logic for what happens when it runs.

Example: a tool called `list_invoices` that calls `GET /api/invoices` and returns a list.

### defineEndpointTool()

The main way to create a tool. You declare the HTTP method and path, and the SDK calls your API for you. You never write the execute function — the SDK builds it automatically.

```ts
defineEndpointTool({
  toolName: 'list_invoices',
  method: 'GET',
  path: '/api/invoices',
  inputSchema: z.object({ status: z.string().optional() }),
  allowedRoles: ['accountant', 'admin'],
})
```

### defineUiTool()

A tool that doesn't call any API. It just tells the frontend to do something — open a dialog, navigate somewhere, show a toast. Client-side only.

```ts
defineUiTool({
  toolName: 'open_settings',
  inputSchema: z.object({}),
  uiAction: { type: 'navigate', path: '/settings' },
})
```

The server only hands the action to the browser and does not learn whether the app carried it out. The result therefore keeps its shape (`success: true`, `message`, `uiAction`), but its `message` tells the model the action was handed to the app, that its outcome is not known, to say it was requested rather than done, and not to call the tool again: `Handed to the app. Whether it was carried out is not known: do not tell the user it succeeded, say it was requested and should now be visible. Do not repeat the call. Do not quote this text.` Generated UI tools (navigation, filter, client action) answer the same way; a page-bound client action names its route (`Handed to the app, which opens /templates to run the action there. …`). A `successMessage` you declare replaces the text. A `defineUiTool` without a `uiAction` (or `uiPattern`) hands nothing to the app and keeps `Action executed.`. The chat UI never shows this note to the user (not as a tool result block, not as an activity detail).

### defineTool() (likely to be deprecated)

Low-level tool where you write the execute function yourself. Used internally by the SDK (endpointToolToTool and uiToolToTool both compile down to this). Not meant for app developers. Still exported but has zero external usage — only used inside server-core.

---

## RBAC (Role-Based Access Control)

Assigns different roles to users, which controls which tools the AI can see and use.

If a free-tier user can't do some calls (like advanced analytics), RBAC removes those tools from the LLM's context entirely. The LLM never sees them, never tries them, never fails. This prevents wasted API calls, bad user experience, and also keeps the tool set small so the LLM makes better decisions.

It is NOT a security layer — your backend still enforces its own auth. RBAC is a product/UX layer that shapes what the AI agent can offer to each user.

Two levels:
- **Local** (server-core): checks `allowedRoles` on each tool against the user's roles. In-memory, no network.
- **Delegated** (server-pro): asks Glirastes Gate service to decide. Lets you manage permissions from a dashboard without redeploying code.

---

## Registry

A registry is just a collection of tools stored as a key-value map (tool name → tool object).

- `endpointToolsToRegistry()` — takes an array of endpoint tools, returns a registry
- `uiToolsToRegistry()` — takes an array of UI tools, returns a registry
- `toolsToAiTools()` — takes a registry + user context, filters by RBAC, and outputs AI SDK-compatible tools that can be passed to `streamText()`

---

## UI Patterns

Declarative rules for what the frontend should do after a tool runs. Instead of writing custom code per tool, you declare a pattern and the SDK resolves it automatically.

- **filter-and-navigate**: Go to a page with filters applied (e.g., show invoices filtered by status)
- **open-detail**: Open a detail view for a specific entity (e.g., open task #123)
- **open-dialog**: Open a dialog (e.g., create-task form)
- **refresh**: Refresh a specific UI region (e.g., reload the task list)
- **toast**: Show a notification message

Patterns support `$variable` placeholders that get replaced with actual values from the tool input or response. Example: `path: '/tasks/$taskId'` becomes `/tasks/abc-123`.

---

## UI Action Dispatch (ui-react)

The bridge between AI tool results and your frontend components.

- **UiActionBus**: An event bus. When a tool produces a UI action, the bus dispatches it to registered handlers. `dispatch()` resolves the number of handlers that ran (`0`: nothing on the page handles it).
- **useAiClientAction(actionId, handler, contract?, { route?, effect? })**: React hook. You register a handler for a specific action ID (e.g., `'task-details.open'`) in the component that owns the effect, and it fires when that action comes through. When that component lives on one page, pass its static path as `route`: from any other page the chat opens the route through the navigation bridge, waits for the page to register the action and then runs it. A handler returns `false` when it could not do its work; the dispatch then fails in the browser (the chat logs a warning). The model is not told: the tool result only says the action was handed to the app (see `defineUiTool()` above). `registerAiClientAction` (`glirastes/browser`) takes the same `{ route, effect }` options. `effect` (`'read'`, `'write'`, `'destructive'`, `'external'`, `'financial'`) declares what the handler does instead of leaving it to the generator's guess; `'write'` and stronger make the chat ask first (see [tool policy](tool-policy.md#client-actions-declared-effect)).
  - **Payload contract → tool input.** `glirastes tools refresh` builds the generated tool's input schema from the contract. A zod contract (v4, or v3 with `zod-to-json-schema` in the app) that is exported from an app module the schema probe can import is converted on its input side: formats (`uuid`, `email`, …), `.describe()` texts, enums, bounds and defaults reach the model, and the server validates them (Ajv with formats) before the browser gets the action, so a name passed for a `z.string().uuid()` is rejected and corrected in the same turn, as with endpoint tools. The top-level `.describe()` of the contract is a code description of the tool (after JSDoc). Every other contract (inline, outside the app, not importable, a non-object or uncompilable schema) is typed from its TypeScript input type as before, with the warning `ui-action-contract-unprobed`; an inline contract made only of type-shaping calls (`z.object`, `z.enum`, `.optional()`, …) loses nothing and is not flagged. When the probed schema contradicts the contract's TypeScript type (a cast or annotation), the tool follows the zod schema, which the browser checks too, and warns `ui-action-contract-mismatch`. No finding of either kind disables a tool.
- **Tool name of a client action**: `glirastes tools refresh` turns each literal action id into the tool `ui.<id>`. The id is split at dots; each segment is camel-cased: its first letter lower case, a capital after every run of characters that are not letters or digits (`task-details.open` → `ui.taskDetails.open`, `Tasks.Open` → `ui.tasks.open`), and a segment that starts with a digit gets an `a` in front. Every **single-segment** id moves under `ui.action.` (`navigate` → `ui.action.navigate`, `open-entity` → `ui.action.openEntity`), and so does an id whose first segment is `navigate`, `filter` or `action` (`filter.reset` → `ui.action.filter.reset`), so a client action never takes the generated `ui.navigate` or `ui.filter.<view>` names. Ids starting with `glirastes.` belong to the SDK and give no tool (`ui-action-id-reserved`); an id with an empty segment, or one whose name would exceed 200 characters, gives none either (`ui-action-id-invalid`). Two ids that end with the same name (`task-details.open` and `task_details.open`) keep it for one and add a short digest suffix to the other. The action id the browser dispatches stays the one you registered; only the tool name changes.
- **Navigation bridge**: `useGlirastesNavigationBridge({ push })` (React) or `registerNavigationBridge({ push })` (`glirastes/browser`) runs `ui.navigate` and `ui.filter.<view>` with the app's router. A `push` that returns or resolves `false` reports that the navigation did not happen. vue-router resolves a failed navigation instead of throwing, so pass `push: async (href) => !(await router.push(href))`. vue-router also resolves a navigation to the current URL as a failure (`NavigationFailureType.duplicated`); return `true` for it with `isNavigationFailure(failure, NavigationFailureType.duplicated)` if that should count as done. The Next.js router's `push` returns nothing, so the navigation counts as carried out once it was handed to the router, not once the page rendered. An app without client-side routing calls `registerDocumentNavigation()`: it loads the page with `location.assign`, and the outcome is `initiated`, except for a target that only changes the fragment of the open page (`ok`). `reloads: true` on an own bridge, or `reloads: (href) => boolean` per target, does the same.
- **UI action outcomes**: the chat classifies what became of the generated UI actions (`glirastes.*`) of each tool result: `ok` (every handler resolved), `rejected-contract` (the payload failed the action's contract, or the route or navigation target is unsafe), `rejected-handler` (a handler or `push` returned `false`), `failed` (a handler threw), `unavailable` (no handler, e.g. `ui.navigate` without a bridge, or a page-bound action that never registered on its route), `initiated` (a reloading navigation started), `timeout` (a handler did not settle within `uiActionOutcomeTimeoutMs`, default 10 s, plus the 5 s route wait of a page-bound action) or `unconfirmed` (a bus of an older SDK copy that does not count its handlers). A handler should resolve once its effect is visible, not once the user is done with it. The provider prop `onUiActionOutcome({ toolName, toolCallId, code, actions, reported, durationMs, error? })` fires for every outcome (no payload; a throw inside is caught); `<glirastes-chat>` emits `glirastes-chat:ui-action` with `{ toolName, toolCallId, code, actionIds }`. With the outcome protocol (on by default with the bundled provider and transport) the chat writes the outcome into the tool result (`reported: true`) and the model answers only after it, in a second request; see [UI action outcomes](ui-action-outcomes.md). Without it the tool result only says the action was handed to the app: `{ handedOff: true, message, uiAction }` for a client that sends the flag, `{ success: true, message, uiAction }` as in 0.17.3 for every other (`uiToolResultShape`, default `'auto'`). A chat of your own calls `runToolResultUiActions(result, bus?, { timeoutMs, routeTimeoutMs, signal })` from `glirastes/browser` for the same classification (it resolves `null` when the result has no generated UI action); `dispatchToolResultUiActions` keeps throwing as before. Handlers throw `UiActionRejectedError` (`code: 'glirastes.ui-action-rejected'`, `reason: 'contract' | 'handler'`); check `isUiActionRejectedError(error)`, not `instanceof`, since several SDK copies can share one page.
- **Order and late execution**: the tool results of one answer run one after another in call order (a result that arrives first waits for the earlier calls while the request streams). A failed call does not stop the next call; inside one result with several actions the first failure stops the rest. After an `initiated` navigation nothing else runs on the page. A UI action runs only in the chat whose running request delivered it: a result restored from a stored history (`session.load`, messages set by the host or a custom transport, another tab's sync) a history set while a request runs (it no longer starts with the request's messages) and a result that already carries an `outcome` never run and do not call `onToolResult`. Hand-written `defineUiTool` actions with their own `uiAction` types are not classified; they stay with `onToolResult` (live results only).
- **ActionIdRegistry**: Auto-generated map of all action IDs. In dev mode, warns you if an action fires but no handler is registered.

---

## Modules (Intent System)

Modules group tools by topic. Example: a "task management" module contains `list_tasks`, `create_task`, `update_task`. A "reporting" module contains `generate_report`, `export_csv`.

When a user sends a message, the SDK classifies which module the message belongs to (intent classification). Then it only gives the LLM the tools from that module instead of all tools. This makes the LLM more focused and accurate.

Confidence-based scoping:
- High confidence (85%+): only that module's tools
- Medium (70-85%): that module's tools + shared tools
- Low (<70%): all tools (can't determine intent, give everything)

Each module can also specify:
- `maxSteps`: how many LLM turns to allow
- `modelTier`: fast / standard / powerful (pick cheaper or smarter model based on task complexity)
- `systemPrompt`: custom instructions for that module
- `classificationHint` + `examples`: helps the intent classifier understand what belongs to this module

---

## Lancer (Glirastes Platform Client)

A client that talks to the Glirastes cloud platform. It adds "smart" features on top of the core SDK. Created with `createLancer(config)`.

Has 7 namespaces (each talks to a different Glirastes service):

| Namespace | What it does |
|-----------|-------------|
| **Gate** | RBAC — asks the platform which tools a user can access |
| **Primus** | Intent classification — figures out which module a message belongs to |
| **Warden** | Guardrails — checks if input is safe/on-topic before the LLM sees it |
| **Aegis** | PII detection — finds personal data (names, emails, etc.) and anonymizes it |
| **Config** | Dynamic configuration — fetch prompt overrides and settings without redeploying |
| **Telemetry** | Event logging — sends usage events to the platform dashboard (fire-and-forget) |
| **Approvals** | Tool approval — checks if a tool call needs human approval before executing |

### Graceful degradation

If Glirastes is unreachable, **everything still works**. Every namespace has a permissive fallback:

- Gate: all tools allowed (falls back to local RBAC)
- Warden: all input passes (no guardrail blocking)
- Primus: confidence = 0 (all tools given to LLM)
- Aegis: text passes through unchanged (no anonymization)
- Config: no overrides applied
- Telemetry: events silently dropped
- Approvals: falls back to local config

You can override this per service: `'fallback'` (default), `'silent'` (quiet fail), or `'block'` (hard error).

---

## Pipeline (server-pro)

The Pro pipeline is the full processing chain for a user message. Created with `createAiPipeline()`.

Steps in order:
1. **Guardrails** — Warden checks if the message is safe. Blocks harmful/off-topic input.
2. **Intent Classification** — Primus classifies which module the message belongs to.
3. **Tool Scoping** — Selects the right tools based on the classified module + confidence level.
4. **Model Selection** — Picks the right model tier (fast/standard/powerful) based on complexity.
5. **Returns** everything needed for `streamText()`: model, filtered tools, sanitized input, intent metadata.

If any Lancer call fails, the pipeline continues with fallback values (see degradation above).

### Legacy Mode (without Lancer)

If you don't use Lancer/Pro, you can provide your own `IntentRouter` callback that does classification and routing locally. The handler in adapter-nextjs supports both modes.

---

## PII Shield (pii-shield)

Protects personal data from leaking to the LLM. Created with `createPiiShield(config)`.

Four operations:
- **outbound(text)**: User sends a message → detect PII → replace "John Smith" with "Person_A" → send anonymized text to LLM
- **inbound(text)**: LLM responds with "Person_A" → replace back with "John Smith" → show real text to user
- **rehydrateArgs(args)**: LLM calls a tool with "Person_A" as an argument → replace with "John Smith" before calling the real API
- **anonymizeResult(result)**: Tool returns data containing PII → anonymize before LLM sees it

Two modes:
- `anonymize`: random replacements each time
- `pseudonymize`: deterministic — same PII always maps to the same pseudonym (so the LLM can reason about "Person_A" consistently across the conversation)

Can delegate detection to Glirastes Aegis or run locally.

---

## Approvals

Some tools can require human approval before executing. Example: `delete_user` should not run just because the LLM decided to — a human must confirm first.

Set via `needsApproval: true` on a tool definition. By default, non-GET endpoint tools require approval (mutations are gated), GET tools don't.

The chat-react package provides `ApprovalCard` and `BulkApprovalCard` components. The user sees a card in the chat: "The AI wants to delete user X. Approve or Reject?"

**Which entity an id means.** The card shows the action label and the call's arguments; UUID values are hidden. On by default, it also checks every id the call carries and shows the name this conversation showed for it, e.g. `Playlist: Abend-Promos` for `delete_playlist({ playlistId })`. An argument is an id when its key is `id`/`ids`/`_id`/`ID` or ends in `Id`, `_id` or `ID` (also plural, `trackIds`; value: a string of at most 200 characters or an integer), or when its value is a UUID-shaped string under any key; arrays count element by element, nested objects and arrays of objects four levels deep, at most 100 ids per call. The label comes from the key (`playlistId` → `Playlist`, `playlist: { id }` → `Playlist`), from the type of an `@` mention the user picked, or is `approvalTargetLabel` ("Target") for a bare `id`. Names come from the tool results in the browser's message history (any object with `id`, `_id` or `uuid` next to `title`, `name`, `displayName` or `label`: entries of `data[]`, the entries an overview with `_result` kept, `read_result` answers including their identity fields and indexed reads such as `{ "data": { "2": { "id": …, "name": … } } }`, nested records) and from `@` mentions in the user's own messages; never from the model's arguments or text. A name the detail lines already show is not repeated.

- An id without a known name that a tool result of this conversation carried as a record id (`id`, `_id` or `uuid` of an object, e.g. a version without a name field) is shown **without a warning**: the label, a short field of that record when it has one (`versionNumber`, `version`, `number`, `code` or `slug`, e.g. `Version number 3`), else the id, and the note "seen in this conversation" (`approvalSeenIdNote`). An id that occurred only as a reference (`draftVersionId` of another record) or nowhere is not seen.
- An id that occurred nowhere gets a **warning** on the card, with the id shown so the user can check it: "No name is known for this id in this conversation. Check it before you approve." (`role="alert"`, a warning icon and text, the danger colours of the error banner; the approve button points to it with `aria-describedby`). The grouped card lists the names and warns the same way.
- A renamed record (same UUID, a newer name) shows the most recent name. A non-UUID id shown with different names for records of one kind shows the most recent name with the id and the warning "This id came up with different names: …".
- **An id of different kinds.** A non-UUID id value that this conversation showed as the own id of records of more than one kind (user 3 and playlist 3; number ids and short text keys alike) is named only when the argument picks exactly one of those kinds; otherwise the card names none and warns "This id came up for different kinds of records: Linus Torvalds (User), Lobby Loop (Playlist). Check which one is meant before you approve." (`approvalCollidingIdWarning`), with the id. A record counts with its `id`, `_id` or `uuid`, or, when it has no recognised id (`id`, `_id`, `uuid`, `key`, `slug`, `code`), with every id-like field (`playlist_id`, the rule the result overview uses; so the versions of playlist 3, which carry `playlist_id: 3`, count as a third kind). Its kind is what the browser knows without a declared identity: the field that holds it, singular (`users[]` → user, a nested `owner` → owner, `items[]` inside a record → item), or for a record at the root or under a generic wrapper at the top (`data`, `items`, `results`, …) the tool name without its action words (`playlists_list`, `playlists_get`, `delete_playlist` → playlist), so a list and a get of one resource are one kind; a `read_result` answer takes the tool that produced the result, a mention its type. The argument picks a kind by its key (`playlist_id`, `playlistId` → playlist), a bare `id` by its parent object (`playlist: { id }`) or by the approved tool's name (`playlists_delete({ id })`); two kinds agree when their last words do (`version_id` and `playlistsVersions_list`). When the picked kind's records had no name, the id counts as `seen`. A UUID is the same record wherever it occurs and never collides, so UUID apps see no change. A nested record of the same entity under another field (`owner: { id: 3 }` next to `users[]`) is another kind: an argument such as `assigneeId: 3` that picks neither gets the warning.
- **A replaced card must show this itself.** An app that passes its own `ApprovalCard` or `BulkApprovalCard` through `components` gets none of the above automatically: the names and warnings are rendered by the shipped cards. The data is on every pending approval as `PendingApproval.subjects` (in the grouped card on each entry of `approvals`), one entry per id argument, also when no name is known: `{ path, id, label?, status, name?, names?, fallback? }`. `status` is `named` (show `name`), `seen` (no name, but a tool result carried the id as a record id: show `fallback` or the id, no warning; new in this release, so an exhaustive `switch` over `status` needs a case for it), `unknown` (the id occurred nowhere: show the id with a warning) or `ambiguous` (different names for a non-UUID id: show `names` and the id with a warning; for an id of different kinds the call does not pick one of, `name` is absent and `candidates` (`{ label, name? }[]`, new and optional) lists every candidate record with its kind: show them all, name none). `subjects` is absent when the call carries no id or `approvalSubjects` is off. A custom card that renders only `details` drops the safeguard without any error.
- Texts: `approvalTargetLabel`, `approvalUnknownIdWarning`, `approvalUnknownIdsWarning`, `approvalAmbiguousIdWarning` (`{names}`), `approvalSeenIdNote` in `locale`, with English and German defaults. `approvalSubjects={false}` on the provider turns the check off; `PendingApproval.subjects` (`ApprovalSubject[]`) carries it for a custom card.

This is a client-side convenience, not a trust boundary: the names are data the browser holds, nothing is fetched, the model is not called, and the server still executes exactly the signed arguments. The card cannot know a record the conversation never showed, and a stale name stays until a newer result shows another. The stronger variant is a subject the server resolves and signs with the approval, which is planned. `hideIds` on the chat handler is separate: it keeps ids out of the model's answer text and does not change the card.

---

## Truncation

LLMs have limited context. A successful tool result whose JSON is longer than the limit (16,000 characters by default, roughly 4,000 tokens) is cut until it fits, so the limit is a true upper bound:

1. Fields whose key alone is longer than 120 characters are left out at any depth (counted, never named).
2. The array with the largest serialized size, at any depth (`data.items`), keeps as many leading entries as fit (binary search) when removing it could make the result fit or it is at least half of it. Sibling fields such as `meta` stay; if they alone are too large they are compacted first. If not even one entry fits, that entry is compacted (long strings clipped, nested objects and arrays replaced by short placeholders); if it still does not fit, no entry is kept.
3. A result without such an array has its long strings clipped and its largest fields replaced by placeholders. If that is still too large (thousands of fields), the leading top-level fields that fit are kept and the rest left out.
4. A `_truncated` marker is added: `field` (dot path), `showing` and `total` when an array was cut, `compacted` with up to five changed paths, `omittedKeys`, and a `hint` for the model. For a **read** tool (a GET or HEAD endpoint, or a tool without a method that needs no approval) the hint tells it to say "showing N of M" and offer filtering or the next page, naming the tool's paging parameters (`page`, `limit`, `offset`, `cursor`, `pageSize`, `per_page`, `skip`, `take`) when its input has them. For every other tool, which may already have written, the hint says not to call the tool again just to see more and to tell the user the result was shortened.

`success` and `uiAction` are never changed, so the one remaining exception to the bound is a `uiAction` that, with `success` and the marker, is itself larger than the limit; the result then keeps it and exceeds the limit. Failure results (`success: false`) are bounded separately, and values JSON cannot serialize (a cycle, a BigInt) are passed on unchanged. A root array that has to be cut comes back as `{ data: [...], _truncated }`. The input object is never modified, and the cost is linear in the result size (an 8 MB result takes well under a second).

### What the model sees when an endpoint call fails

| Case | Model-facing result |
| --- | --- |
| Backend answered non-2xx | `success: false`, `error` (cut to 1,000 characters), `retryable`, `status`, `body` (cut to 4,000 characters, reduced or withheld under an output bound) |
| `classifyToolFailure` returned `'expected'` | as above plus `expectedFailure: true` (does not count toward `maxConsecutiveErrors`) |
| `classifyToolFailure` returned `'error'` (or anything else, or threw) | as above plus `expectedFailure: false`; the chat's activity log shows the step as failed whatever the status (without a classifier there is no marker and a 4xx other than 408/429 is shown neutrally) |
| **404** of a route with path parameters (`/playlists/:id`) | as above plus a fixed `hint`: `Not found: no record matches the path parameter "id". The value may not exist, or it may be the id of a different kind of record. If a list or search tool can find the record (for example by its name), look it up first, then call this tool again with the value it returns. Only if there is no such tool or the lookup finds nothing, tell the user it was not found; do not ask the user for an id before that.` (several parameters: `the path parameters "a", "b"`) |
| 404 of a route without path parameters, any other status, a call refused locally | no `hint` |
| Thrown error (timeout, network, response size) | `error: "Error in <tool>: …"` (`<tool>` is the name the model calls the tool by, never its internal id) and `hint: "Check the parameters and try again."` |

The not-found hint names the route template's parameters (the same names the input schema shows), never a value, and is appended next to the app's own error body, never instead of it. Only path parameters count: they are the declared address of one record, whatever they are called (`id`, `key`, `orderNumber`); an id in the query or body is not treated as the address, because a 404 there can just as well mean the route. The hint is not part of the loop fingerprint (a failure with a status is fingerprinted by `success`, `status`, `retryable` and `expectedFailure` only) and does not change how the failure counts for `maxConsecutiveErrors`. A backend that answers 404 for a route that does not exist at all gets the hint as well.

### Result handles and `read_result`

With `createAiChatHandler` a large result is not simply cut (on by default, `resultHandles`). A successful record result over its limit is kept in full in a store that belongs to the running request, and the model gets an **overview** instead, breadth first: every entry of the largest array (reached through object properties, e.g. `data.items`) stays visible with its small fields, and only when the small fields alone do not fit are entries dropped from the end. Fields (nested ones down to three levels) are left out by the value they carry for the model, measured in the data across all entries: first nested arrays and objects, foreign keys (`folderId`, `tenant_id`), UUID, hex and token ids, URLs and texts longer than 64 characters on average; then other strings (dates, names); last booleans, numbers, null and short labels with few distinct values (a status, a content type). In the last two classes nested fields (below an entry's own fields) go before the entry's own, so a status of the entry outlasts a number inside a nested object; then, within each class, the largest goes first. An entry's own identity (`id`, `uuid`, `key`, `slug`, `code`, `name`, `title`, `label`, `displayName`) stays; foreign keys do not. An entry **without** a recognised id (none of `id`, `uuid`, `key`, `slug`, `code` holds a non-empty string or a safe integer) keeps every id-like field instead: an own scalar field whose key ends in `Id`/`ID` after a lower-case letter, digit or `_` (`playlistId`, `user_ID`) or in `_id` (`playlist_id`), whose value is a non-empty string or a safe integer, the field at most 200 characters, at most 16 per entry. Its own id cannot be told from a reference by name alone, so `owner_id` stays next to `playlist_id`: rather one field too many than no id for the next call. Not a word ending in those letters (`VALID`, `COVID`, `paid`), not a plural or an array (`track_ids` names other records). These fields are kept for the whole array and never left out; under size pressure every other field goes first, then trailing entries, and if not even that fits the result is cut as above. Entries that have a recognised id are unchanged (`folderId` next to `id` is still left out first). A field outside the tool's upper bound is never brought back, and a default view (`outputDefaultFields`) still decides which fields the overview starts from. A nested object whose fields were all left out is removed rather than kept as `{}` and listed once by its own path (an object that was empty in the data stays), with `keys`: up to eight of its direct child keys, largest first, each readable as `path.key` (keys a path cannot name, or longer than 64 characters, are left out; `keysMore` counts the keys not listed). Keys are help, not data: when space is short they are given up before any field. While keys are listed, the hint says `fields as in omitted (path or path.key)`. So "which playlists exist?" and "name and status of each design" are answered without reading more, and the hint tells the model not to infer a field that is missing from the overview from other fields but to read it or say it is not known. A result without such an array has its largest fields left out the same way. `success` and `uiAction` are untouched, and the overview always fits the limit (otherwise the result is cut as above):

```json
{ "success": true, "data": [{ "id": "p1", "name": "Road trip" }, "…all 20…"], "meta": { "page": 1 },
  "_result": { "id": "ro_ab12cd34", "arrays": { "data": 20 }, "showing": 20, "total": 20,
               "omitted": [{ "path": "data[].tracks", "approxChars": 160000 }], "hint": "…" } }
```

`approxChars` is the approximate serialized size of the field (or of the left-out object) across all entries. Every listed `omitted` path is a valid `read_result` field that reads exactly the left-out data; a field whose path cannot be written in that syntax (a key that is empty or contains `.`, `[` or `]`, or a path over 120 characters) is not listed but counted in `omittedMore`, and the hint then says that fields with unusual key names are read with their parent. The model reads more with the built-in tool `read_result`: `resultId`, `fields` (paths joined by `.`, `[]` for every element of an array, `[n]` for the element at index `n`: `data[].tracks`, `data[].owner.name`, `data[2].items`, `meta`; at most 50, no wildcards or filters), `offset` and `limit` (1 to 1,000; one window for the outermost arrays of every selected path, also arrays inside a selected object). An indexed element comes back as an object keyed by its index (`{ "data": { "2": { "items": [...] } } }`) and is not paged itself: the outermost arrays inside it are, so `data[2].items` with `offset`/`limit` pages the items of that one entry. When `fields` reads below the entries of an array (`data[].draftVersion.variants`, `data[].owner.name`, also an indexed `data[3].items`), every returned entry of that outermost array also carries its own identity fields, so the model knows which entry each value belongs to: `id`, `uuid`, `key`, `slug`, `code`, `name`, `title`, `label`, `displayName` (the keys the overview keeps), and for an entry without a recognised id every id-like field (`playlist_id`, `ownerId`; as in the overview), only scalar values of at most 200 characters, first in the entry. Not for nested arrays, not without `fields` (whole entries come back), not for a path that selects whole entries, not for an entry that is no object, and never twice (a field the model selected anyway). They are read from the stored, bounded result, so a field outside the tool's upper bound never appears, and they count against the limit like all data (fewer entries per page); when one entry has to be cut, they are the last of it to go. Example: `fields: ["data[].draftVersion.variants"]`, `offset: 3`, `limit: 2` answers `{ "data": [{ "id": "d3", "name": "Design 3", "draftVersion": { "variants": [...] } }, { "id": "d4", "name": "Design 4", ... }] }`. Several indices of one array combine (`data[0].name`, `data[2].name`); `[]` and `[n]` on the same array in one call (`data[].name` with `data[0].items`) are refused with `invalid_fields`, and an index beyond its array answers `index_out_of_range` with the valid range (in a managed turn a call and an error). The answer carries `_result: { id, offset, returned, total, nextOffset }` for the paged array with the most entries, so `nextOffset` is present while any paged array has more, and `arrays` with `{ returned, total }` per array when several were paged; stays within the origin tool's limit (fewer entries first, then a shorter hint, then the usual cut of a single entry, whose `_truncated` then only names what was cut and has no hint of its own; if not even that fits, only `_result` with `returned: 0`, `total`, `nextOffset` and a hint that the entry does not fit), and never calls the backend: a write tool runs exactly once. An incomplete answer (`nextOffset` present, or an entry cut to fit) carries `_result.hint`, for example `Incomplete: entries 0 to 12 of 45 (total exact). Call read_result again with the same resultId and fields and offset 13. Before the rest is read, say nothing about the content of all entries (which match, all, none, only).`; every incomplete answer's hint starts with `Incomplete:`, `nextOffset` is present while entries remain after the page, and the hint counts against the limit and is kept while entries are dropped. A complete answer carries no hint unless a requested field does not exist. Paths that select nothing are listed in `unknownFields` (at most ten): by their normalized form when every field name is an identifier (`[A-Za-z_$][A-Za-z0-9_$]{0,63}`) without a run of three or more digits and the path has at most 120 characters, otherwise by position (the hint then says a number is a position in `fields`); `parentKeys` names the nearest existing parent of up to three of them with up to twelve identifier-like keys found there (the keys of its entries for a parent ending in `[]`), when it fits next to the full page; the hint then says these fields do not exist in this result and must not be inferred. When none of the requested fields exists, the answer is the error `unknown_fields` with the same details; a read where only some are unknown is a success. Errors come back as results the model can act on: `invalid_fields` (naming the accepted forms and `offset`/`limit`), `unknown_fields`, `index_out_of_range`, `result_denied`, `budget_exhausted` and `result_expired`.

A handle lives only in its request. The id is random (`ro_` for a read tool, `rw_` otherwise), so an id from the history never reaches a handle of a later turn; an approval continuation (a new request) or a later turn answers `result_expired`. The hint is written for that: after a read tool the model calls the tool again, after any other tool it must not (the tool has run) and tells the user the details are no longer available. Per turn at most 8 handles, 2 MiB per result and 16 MiB in total are kept (`resultHandles: { maxResults, maxResultBytes, maxTotalBytes }`); beyond that, and with `resultHandles: false`, the result is cut as described above. Direct commands, `toolsToAiTools` without `resultStore`, the NestJS adapter and a turn whose registry has its own tool named `read_result` never create handles. The store is dropped when the response stream ends, fails or is cancelled; until then a request holds up to `maxTotalBytes` of serialized JSON per turn (more as JS objects in the heap).

In a later turn the chat handler re-sends the previous turn's tool results compacted (`history` option): strings cut to 300 characters, arrays to their first 10 entries complete. The further entries of the largest array keep only their identity fields (the keys above, scalar, at most 200 characters; ids are never cut; an entry without a recognised id keeps every id-like field, as in the overview, and the marker's `keys` names them, e.g. `["playlist_id", "displayName"]`), so every id the model sees stays next to its own name, and a `_history` marker (`field`, `showing`, `full`, `total`, `keys`, `hint`) says that this is a shortened copy, that an id must never be paired with a name from another entry, and which entries are not listed. Within the history budget (`maxTokens`, 4000 estimated tokens) complete entries give way first, then all identity fields but one id and one name (an entry without a recognised id keeps all its id-like fields), then names are clipped to 60 characters (marked `…[clipped]`), then trailing entries, which the hint says must be fetched again with a read tool before their id is used. An entry that has an id and a name always keeps both. An overview's `_result.hint` is replaced by one saying the handle expired (with the read or write instruction above). Older turns go as text without tool results; the newest of them that had tool results ends with a note that no ids from them are available and that entries must be looked up by name with a read tool before a tool that needs an id is called.

How far the default budget reaches, measured for the previous turn with the default settings (`maxItems: 10`, `maxTokens: 4000`; entries with a UUID id and a name of about 30 characters; tokens estimated at 4 characters each):

| List in the previous turn | Characters | Estimated tokens | Ids kept |
| --- | --- | --- | --- |
| 20 entries | 4,507 | 1,127 | 20 |
| 45 entries | 7,139 | 1,785 | 45 |
| 100 entries | 14,404 | 3,601 | 100 |
| 300 entries | 15,956 | 3,989 | 33 to 165, the rest counted in the marker |

The default covers lists of up to about 100 entries. For longer lists raise `history.maxTokens` (with 8000, 207 to all 300 of 300 entries keep their id and name; how many depends on how long the model's own answer in that turn was). The larger budget is only spent in a turn that follows such a list.

Known limits of the history copy:

- Only the largest array of a result keeps the identity of every entry. An array inside an entry (the items of a playlist, the variants of a design) is still cut to its first entries plus a count, so ids of nested entries beyond those are not available in a later turn.
- The rolling chat summary (`memory.chat`) folds lists to a count. Once a turn has moved into the summary, the ids of its tool results are gone; the model has to look entries up by name again (unless `history.seenObjects` is on and the tool declares its identity, see below).

#### Which earlier tool results the model gets

A turn starts at a user message and holds everything up to the next one. The history counts the earlier turns of the messages it gets (the handler's window: the last `maxContextMessages` UI messages, or what the chat memory keeps). `maxTurns` (6) caps how many earlier turns are sent at all; `toolTurns` (1) says how many of them keep their tool calls with compacted results; the others go as text. What `toolTurns` counts is `history.toolTurnCounting`:

| `toolTurnCounting` | Turns that keep their tool results | A turn without tools ("thanks") |
| --- | --- | --- |
| `'all-turns'` (default up to 0.17) | the last `toolTurns` earlier turns, with or without tool calls | uses up a slot: with `toolTurns: 1`, one "thanks" sends the list before it as text, so its ids are gone |
| `'tool-turns'` (default since 0.18.0) | the last `toolTurns` earlier turns that hold tool calls or results | uses up no slot; the list keeps its ids until `maxTurns`, the window or `maxTokens` drop it |

The previous turn is always sent (as text when its results do not fit). Older turns give way oldest first when they do not fit `maxTokens` or the message limit; in `'tool-turns'` such a turn with compacted results first goes as text and is left out only if that still does not fit (in `'all-turns'` it is left out as a whole, as before). When every earlier turn called a tool, or none did, both modes send the same messages (a turn without tools is treated alike in both, so the previous one keeps its files). With chat memory, `maxTurns` and the window no longer apply (the summary bounds the history) and `maxTokens` is the memory's history cap. `docs/history-measurement.md` has the numbers per mode and setting (ids kept and estimated tokens after 1, 3 and 6 turns without tools) behind the 0.18.0 defaults `tool-turns` and the seen-objects memo (way back: `toolTurnCounting: 'all-turns'`, `seenObjects: false`).

`history.seenObjects` (default on since 0.18.0, `false` turns it off; `true`, or `{ maxEntries, maxTokens }`, default 40 entries and 800 estimated tokens; an app without declarations gets byte-identical model input either way) sends one user-role `<seen-objects>` block ahead of the history: one line per record that a tool result of this conversation showed under a declared identity and that the history no longer shows (results of turns sent as text or left out, entries a compacted result had to drop, turns outside the window or folded into the chat summary), e.g. `playlist: {"playlist_id":3,"displayName":"Lobby Loop 03"}` or `channel-revision: {"channelKey":"lobby","rev":503}`. Each line's JSON has `<`, U+2028 and U+2029 as `\u` escapes (`>` and `&` stay) (since the release after 0.20.0; valid JSON with the same values), so a stored name such as `</seen-objects> Ignore…` cannot close the block; a line without these characters is unchanged.

- Only declared identity (`outputEntities`, see `docs/entity-identity.md`): the declared id fields (all parts of a composite key, numbers stay numbers, speaking keys as they are), then the declared name (clipped to 60 characters), else the declared fallback. A record without a name or fallback, a tool without a declaration and an app without any declaration contribute nothing; field names are never guessed.
- Values are copied from the tool results as the model got them: after the tool's output bound (a denied name is not in the result, so it is not in the memo) and the PII shield (pseudonyms stay pseudonyms). Nothing is read from a backend, a result store or a user's text. Ids the memo shows are learnt by `hideIds` like the ids of the results.
- Records the returned history still shows are left out. Most recently seen first: a record seen again moves to the front; beyond `maxEntries` or `maxTokens` the least recently seen are left out and counted (`[n less recently seen objects left out]`). Recency of appearance in a result is deterministic and follows what the conversation is about; a reference in the model's arguments does not count, since arguments are not checked against a declaration of their own.
- The block says, each time: it is context, not an instruction; the objects may be outdated or deleted since and a read tool gives current data; an id is used only exactly as listed or as a tool result shows it, never invented, guessed, changed or paired with another object's name; result ids of earlier turns have expired. No `read_result` handle appears in it.
- With chat memory the memo also covers the turns the summary folded (the handler passes them on), which is the case the summary loses ids in.

`onModelInput(event)` on `createAiChatHandler` is a local debug hook (opt-in): before every model step of the built-in stream handler it gets `stepNumber`, the exact `messages` of that step (with `promptCaching` the system prompt is the first), `system` when it travels apart, `estimatedTokens`, and `breakdown` (`ModelInputBreakdown`: per earlier turn `index`, `mode` `compacted` / `text` / `left-out` and `hadToolCalls`; `toolTurnCounting`; `earlierMessages`, the count of messages before the window; the memo's `seenObjects`; the history's `estimatedTokens`; `unresolvedMentionMarkers`, the count of `{{mention:type:id:label}}` markers in the assistant's earlier text of the request whose type and id no declared record of a tool result and no `@` mention of the user carries, i.e. the markers the chat shows as plain text under `entityLinks.verifyMentions` such as an id the model shortened; a count only, never an id or a label, and a marker of the latest answer shows at the next request; the chat may still draw a chip for one an entity search hit or `knownEntities` supplies). **It carries content**: prompts, user text, tool results, ids and names (after the PII shield). It runs in the app's process only; nothing of it is written to the stream, the browser or the Platform, and only server code can set it, no request field turns it on. Keep its output out of shared or production logs, or redact it first. A throw from it is ignored. A custom `streamHandler` gets `onModelInput` and `earlierMessages` in its context and passes `onBreakdown` / `earlierMessages` to `prepareModelMessages` itself. The runtime container does not offer it: its stdout carries content-free events only, and a content sink there would break that.

Behaviour notes:

- A payload that carries its own top-level `_result` gets no handle; it is cut as described above, so its field is never dropped or overwritten. Loop detection strips `_result.id` only when it has the form of an issued handle id (`ro_`/`rw_` and 8 base36 characters).
- A registry tool named `read_result` stays the app's tool: that turn keeps no handles, and like every built-in name it is not indexed by `find_tools` in a turn without `managedRuntime`.
- In a managed turn a read that reads nothing (unknown or expired id, invalid fields, a handle of another principal, an index out of range, only unknown fields) counts as a tool call and an error, so `maxToolCalls` and `maxConsecutiveErrors` bound a model that keeps asking, also with parallel calls; at the budget it answers `budget_exhausted`.

In a managed turn every read runs the origin tool's guard: it counts toward `maxToolCalls`, needs a freshly resolved principal and an unrevoked tool under the pinned revisions, and is fingerprinted with its arguments, so the same read three times trips `maxRepeatedFingerprint` while reads of other fields or offsets do not (the random `_result.id` is left out of the origin tool's own fingerprint). A handle also answers only the subject and tenant it was created for (`result_denied`). The owner is the principal captured before the origin tool runs; if the principal resolved when the result arrives is a different one (or none), the result gets no handle and is cut instead, and every read checks the owner again after the guard, right before the data is projected. Without `managedRuntime` there is no principal: the handle is bound to the request alone, and `maxSteps` bounds the reads.

With `piiShield`, the complete result (including `uiAction`) is pseudonymized once when it is stored, and only that copy is kept. The overview and every `read_result` answer are cut from it and do not pass the shield again: detection depends on the surrounding text, so shielding excerpts separately could leave a name raw in one of them, and a pseudonym that looks like PII would be mapped a second time. Results without a handle are shielded as before. The arguments of `read_result` are never rehydrated (they are paths and ids), so `read_result` cannot turn a pseudonym into its original. Its answers repeat nothing the model wrote but the normalized form of unknown paths whose field names are all identifiers without a run of three or more digits (re-formatted from the parsed path, never the raw text; an expired id is not echoed); keys listed in `parentKeys` pass the same filter. Every pseudonym the built-in generators produce contains a space, `@`, `.`, `+`, `-`, `/`, `,`, `(` or `[`, or a run of at least three digits (CVVs, tax and social security numbers), so none can occur in an echoed name, not even inside it. `inbound`, which replaces pseudonyms also inside longer strings (display, the chat-memory summary), therefore finds nothing in what `read_result` echoes to turn into an original; it can only map pseudonyms that are part of the selected data, as in any shielded result. The browser receives the overview and the `read_result` answers exactly as the model does; tool renderers and entity links only see what the overview contains.

Set the limit globally with `maxResultChars` on `createAiChatHandler` or `createGlirastes` (the runtime container: `application.maxResultChars`), or per tool with `maxResultChars` on the endpoint tool definition, `maxResultChars` in a sibling `contract.ts` entry, or the OpenAPI extension `x-glirastes-max-result-chars`. The tool value wins over the global one, the global one over the default. Values are integers from 1,000 to 200,000 (`MIN_MAX_RESULT_CHARS`, `MAX_MAX_RESULT_CHARS`); an invalid global value throws when the handler is created, an invalid extension is reported as `max-result-chars-invalid` (warning) and ignored. The per-tool value stays local in `.glirastes/tool-contracts.json` and the generated module; it is never sent to the Platform.

### Output fields: upper bound and default view

Three optional per-tool declarations shape what a successful result shows. Each is a list of field paths in the `read_result` syntax **without an index** (`data[].name`, `data[].owner`, `meta`); a path includes everything below it. Paths address the result as the model sees it: an endpoint's list or scalar response travels under `data` (`data[].name` for a JSON array).

| Declaration | OpenAPI operation extension | `Tool`, `defineTool`, `defineEndpointTool`, `contract.ts` entry | Meaning |
| --- | --- | --- | --- |
| Allow-list | `x-glirastes-output-allowed-fields` | `outputAllowedFields` | Only these fields can ever be shown. A new backend field stays hidden until it is listed |
| Deny-list | `x-glirastes-output-denied-fields` | `outputDeniedFields` | These fields are never shown; everything else is. A new backend field is visible. `**.<key>` removes every property named `<key>` at any depth |
| Default view | `x-glirastes-output-default-fields` | `outputDefaultFields` | The fields the first answer shows; the rest is read with `read_result` |
| Object identity | `x-glirastes-entities`, `x-glirastes-entity`, `x-glirastes-entity-ref` | `outputEntities`, `inputEntities` | Which field is a record's id and name; replaces the field-name guess ([entity identity](entity-identity.md)) |

**The upper bound** is the allowed fields (all, when no allow-list is declared) minus the denied ones; a denied field wins over an allowed parent and over the default view. It is a security boundary, applied once, right after the tool returned and its output schema was checked, before anything else sees the result: before the PII shield seals it, before it is stored as a result handle, before the overview, the default view and the size limit, and before the browser receives its copy of the tool result. What lies outside it is gone: it never reaches the model, the browser, the overview's `omitted`, `keys` or `arrays`, a `read_result` answer, `unknownFields`, `parentKeys` or an `index_out_of_range` hint. Reading a removed field answers exactly like reading a field that does not exist (same shape, same error, same counts). An array keeps its entries (an entry without an allowed field stays as `{}`), so counts and positions of an allowed array are unchanged. This holds for model turns with and without result handles, direct commands, the legacy and the pipeline path, `toolsToAiTools` used directly (also the NestJS adapter), `executeTool` for Server Actions (upper bound only, no default view) and the runtime container.

- `success` and `uiAction` are never removed. Under a bound `success` is kept only as a boolean (a backend body that sets it to anything else cannot carry data in it). `uiAction` is built from the full backend answer as before (`uiPattern`, `uiActionOnSuccess` with `$data`, a backend body's own `uiAction`), so client actions get the data they always got, and it reaches the model in the same turn as well as the browser. Only the any-depth keys (`**.<key>`) are removed from it, with the same depth rule; exact paths and the allow-list bound the result data only (a `uiAction` has another shape). To keep a value away from the model everywhere, use `**.<key>`.
- A failure (`success: false`) keeps its error text, status and retry information. The body of a failed backend call is reduced under a bound before it is serialized and cut: with an allow-list it is withheld (a failure body is not a record of the declared shape) and `bodyWithheld` says so; with a deny-list the denied paths are removed as far as they match (a list body counts as `data`) and every `**.<key>`; a body that is not JSON (text, HTML, a JSON string) cannot be checked and is withheld under any bound. `classifyToolFailure` runs in the app and still receives the original body. A custom tool's failure keeps only `error` and `retryable`, as before. `executeTool` reduces failures the same way. Without a declaration failures are unchanged. The answer of a schema mismatch (`outputWithheld`) stays as well, and a successful result that cannot be serialized is withheld.
- Free text is not filtered: a failure's `error` (for a backend call taken from the body's `message`/`detail`), a tool's own `error` string and the message of a thrown error (`Error in <tool>: …`) reach the model as written. Do not put values the model must not see into error messages. JSON inside a string field is not inspected either.
- A result that is not a record (a custom tool returning an array) travels under `data` once a bound is declared.
- `**.<key>` (deny-list only; exactly one field name after `**.`, no other wildcard) also removes a top-level key of that name, except `success` and `uiAction` (inside `uiAction` it applies). Its check walks the result once; containers nested deeper than 32 levels are dropped rather than passed on unchecked (fail closed). An exact path (`data[].draftVersion.variants[].fileUrl`) removes only that place: the same name elsewhere stays visible. For secrets such as signed URLs, which appear in many places, use the pattern. A path ending in `[]` (`data[].tokens[]`) empties every entry of that array: each entry stays as `{}`, whatever it was, so the array keeps its length. Matching is exact and case-sensitive (`**.fileUrl` does not remove `fileURL`); a path with whitespace anywhere is invalid; a key containing `.`, `[` or `]` cannot be named.
- The model is told about the output only within the bound: the output schema in `tool-contracts.json` (and the runtime schema and its digest for OpenAPI and JSON outputs) is reduced, `required` included, and the `Returns:` text a Zod `outputSchema` adds to the description is reduced in `endpointToolToTool` (a list or tuple output is reduced under `data`, as at runtime). Where the text cannot follow a declared path (a path below a single key of a record, an intersection, a map), that part is described as `unknown` or `Record<string, unknown>` rather than with field names. A part of the JSON schema that cannot be reduced (a `$ref`, `patternProperties`, an open `additionalProperties` on the way) is kept and reported (`output-schema-unprojected`); results are reduced all the same.

Use the allow-list when new backend fields must stay hidden until someone lists them; use the deny-list when everything but a few fields may be shown and new fields may appear without a code change.

**The default view** is applied after the upper bound, also when the whole result would fit the limit. When it leaves something out and the turn has a result store, the full (bounded) result is kept as a handle and the answer carries the `_result` marker of an overview: `omitted` lists what the view left out (with `keys` of left-out objects, bounded like any overview, at most twenty paths with the rest in `omittedMore`) and the hint tells the model to read the rest with `read_result`; a write tool keeps the wording that it must not be called again. When nothing is left out, the result is returned as before, without a marker. When the view itself is over the limit, the usual overview runs on the view, so the declared fields are the last to go (among them the usual ranking applies). Without a store (`resultHandles: false`, a direct command, `toolsToAiTools` without `resultStore`, a registry tool named `read_result`, or a store whose limits are used up) the view is applied all the same, and a `_truncated` marker lists `omitted` with a hint that these fields cannot be read in this turn and must not be inferred (cut further, with the cut's own fields, when the view is over the limit); it never points to `read_result`. Default fields outside the upper bound are never shown.

Worked example: a paginated list `{ "data": [...], "meta": {...} }` of designs whose versions carry signed URLs (`fileUrl`) under `draftVersion`, `publishedVersion` and their `variants[]`, plus an internal cost:

```json
"get": {
  "operationId": "listDesigns",
  "x-glirastes-output-allowed-fields": ["data", "meta"],
  "x-glirastes-output-denied-fields": ["**.fileUrl", "**.thumbnailUrl", "data[].internalCost"],
  "x-glirastes-output-default-fields": ["data[].id", "data[].name", "data[].status", "meta"]
}
```

NestJS (`@nestjs/swagger`, then export the document again):

```ts
@Get()
@ApiExtension('x-glirastes-output-allowed-fields', ['data', 'meta'])
@ApiExtension('x-glirastes-output-denied-fields', ['**.fileUrl', '**.thumbnailUrl', 'data[].internalCost'])
@ApiExtension('x-glirastes-output-default-fields', ['data[].id', 'data[].name', 'data[].status', 'meta'])
list(@Query() query: ListDesignsDto) { /* … */ }
```

Next.js `contract.ts` entry and a hand-written endpoint tool take the same lists:

```ts
export const contract = {
  GET: { input: listDesignsQuery, outputDeniedFields: ['**.fileUrl'], outputDefaultFields: ['data[].id', 'data[].name', 'meta'] },
};

defineEndpointTool({
  id: 'designs.list', toolName: 'designs_list', description: 'List designs.', method: 'GET', path: '/api/designs',
  inputSchema: listDesignsQuery,
  outputDeniedFields: ['**.fileUrl', '**.thumbnailUrl'],
  outputDefaultFields: ['data[].id', 'data[].name', 'data[].status', 'meta'],
});
```

To hide one field deep in the tree, one exact denied path is enough (`"data[].draftVersion.variants[].fileUrl"`); the allow-list does not have to name every sibling. First answer for three designs, below the limit (the view leaves `draftVersion` and `description` out, so the result gets a handle; `fileUrl` and `internalCost` do not exist for the model at all):

```json
{ "success": true,
  "data": [{ "id": "d0", "name": "Design 0", "status": "live" }, "…3 entries…"],
  "meta": { "page": 1, "pageSize": 3, "total": 57 },
  "_result": { "id": "ro_kw7fymb4", "arrays": { "data": 3 }, "showing": 3, "total": 3,
    "omitted": [{ "path": "data[].draftVersion", "approxChars": 180, "keys": ["variants", "title"] },
                { "path": "data[].description", "approxChars": 110 }],
    "hint": "Overview: all 3 entries of data, without the fields in omitted. … Read more with read_result in this turn …" } }
```

For 200 designs at a limit of 4,000 the view itself does not fit: the overview keeps 105 entries with `id` and `name` and lists the declared `data[].status` and `meta` last in `omitted` (`"omitted": [data[].draftVersion, data[].description, data[].status, meta]`, `"showing": 105, "total": 200`). `read_result` with `fields: ["data[].draftVersion.variants"]` returns the variants without `fileUrl`; `fields: ["data[].draftVersion.variants[].fileUrl"]` answers `unknown_fields`, exactly as for a field that never existed. `**.fileUrl` is not a `read_result` path (`invalid_fields`).

Validation (`glirastes tools refresh`, OpenAPI and `contract.ts` alike; a message never repeats an invalid value): a declaration that is not a list of at most 200 valid paths (at most 200 characters each, starting with a field name, no index, no whitespace, `**.` only in the deny-list; `null` counts as invalid, only an absent field is undeclared) is `output-allowed-fields-invalid` or `output-denied-fields-invalid` (needs attention: the tool stays disabled, and an empty allow-list is written, because an upper bound that cannot be read must not expose everything), or `output-default-fields-invalid` (warning; ignored). A path the response schema provably does not have is `output-field-unknown` (warning). For an exact path this is decided along the path itself: a declared prefix that is closed enough reports it, an open or `$ref` part on the way does not. A `**.<key>` is reported whenever no declared part of the schema names the key, also when open objects exist (the message then says to ignore it if the field only occurs in undeclared parts). When a declared key differs only by case, the message names it. For the deny-list it says that a misspelt path excludes nothing. The warning cannot see fields an open schema does not declare. Default fields outside the allow-list are `output-default-fields-outside-allowed`, denied default fields `output-default-fields-denied` (warnings; the effective view is the part within the bound). At runtime an invalid list (also `null`) throws in `defineTool` and `endpointToolToTool`, and a hand-built `Tool` with an invalid allow- or deny-list shows nothing but `success` and `uiAction` (fail closed). All three lists stay local in `.glirastes/tool-contracts.json`, the generated module and the container artifact; they are never sent to the Platform.

**App-wide deny-list.** When the same secret keys occur in many tools (signed URLs in `fileUrl`, `thumbnailUrl`, `fallbackImageUrl`, `profileImageUrl`), declare them once in `.glirastes/tools.json`:

```json
{ "schemaVersion": 1, "appId": "…", "targetAppKey": "…", "locale": "en-US", "sources": ["openapi"],
  "output": { "deniedFields": ["**.fileUrl", "**.thumbnailUrl", "**.fallbackImageUrl", "**.profileImageUrl"] } }
```

Only any-depth patterns `**.<key>` are accepted there (at most 200; an exact path belongs to one tool). Anything else makes `tools.json` invalid (`E-TOOLS-002`, naming `output.deniedFields`), so `tools refresh`, `tools check` and the container build stop instead of generating tools without the bound. `glirastes tools refresh` joins the patterns with each generated endpoint tool's own `outputDeniedFields` (OpenAPI, `next-app` and `nest` sources; de-duplicated, sorted), and from there they travel like a per-tool declaration: `tool-contracts.json`, the generated module, the container artifact, the reduced output contract and the `Returns:` text. A pattern a tool's schema lacks is no finding of that tool; a pattern whose key no declared part of any tool's response schema names is `output-denied-key-unmatched` (warning, on `.glirastes/tools.json`, with a case near-miss such as "the schemas have fileUrl"; a developer review item of `glirastes tools resolve --print`). It does not cover hand-written tools (`defineTool`, `defineEndpointTool` in app code; declare `outputDeniedFields` there) or UI tools (no backend answer). Adding it changes every generated endpoint tool's entry in `tool-contracts.json` and generated module (the list appears), so `tools check` reports drift until `tools refresh` is run and committed; the output schema and its digest change only for tools whose schema names one of the keys, and a connected app syncs the changed setup artifact with `glirastes sync`. The list is local project configuration and never sent to the Platform. The bound does not apply to an app's own MCP server: the generated `createMcpEndpointCatalog` (`emit.mcpCatalog`) only describes the endpoints, and that server calls them and returns their answers itself. The chat-memory summary reads the tool outputs of the chat history, which are the bounded results.

---

## Followup Suggestions

After the AI responds, it can suggest follow-up questions as clickable chips. This is powered by an internal tool (`suggest_followups`) that the LLM calls at the end of a turn. The UI renders them as buttons the user can click to continue the conversation.

Configurable: number of suggestions (default 3, max 5), locale, good/bad examples, which roles see them.

---

## Chat UI (chat-react)

React components and hooks for the chat experience. Styling-neutral (you provide classNames).

**Provider**: `AiChatProvider` wraps everything and manages state.

**Key hooks**:
- `useAiChat()` — messages, send, stop, clear, loading state
- `useApprovals()` — pending approvals, approve/reject
- `useMentions()` — @mention entities in messages
- `useSuggestions()` — followup suggestion chips
- `useDeepgramTranscription()` — voice input

**Key components**: MessageList, MessageBubble, ChatInput, ApprovalCard, PipelineTimeline, SuggestionBar, VoiceInputButton, AiTriggerButton.

**Message layout** (opt-in, defaults keep the markup): `activityLog` on the provider (`expandWhileRunning`, `runningProgress`, `noticePlacement: 'log' | 'message'`, `details: 'auto' | 'results' | 'all' | 'none'` (default `'auto'`: a failed or neutral step shows the error text its tool returned, a call the user approved that the server did not run says so, whatever `toolResults`; a done step's message only where its result is displayed), `grouping: 'message' | 'sections'` (`'sections'`: one log per run of steps between the texts of a message), `noticeScope: 'every' | 'latest'` (default `'every'`: every turn that was stopped, failed or safety-stopped keeps its notice, also after later turns and a reload, in the same place as while it was the latest turn; a turn that ended before an assistant message existed shows it as `<p data-component="turn-notice">` right after its question. `'latest'`: only the latest turn, never for a turn without an assistant message, the behaviour before 0.20.0)), the slots `components.TurnNotice` and `components.MessageParts`, and `useMessageParts(message)` for a custom bubble. **Turn outcomes:** how each turn ended is recorded per turn, keyed by the user message that started it, also when no assistant message exists (`TurnOutcome`: `userMessageId`, `status` (`TurnOutcomeStatus`) `completed` | `aborted` | `safety-stop` | `error`, `reason` (`TurnOutcomeReason`) `finished` | `stopped` | `send-now` | `request-failed` | `pipeline`, `at`). A run that ends at an open approval records nothing until the turn goes on. Read it with `useTurnOutcome(message)` (for a user or an assistant message) or `useTurnOutcomes()` (all, by user message id; also `turnOutcomes` on the context); `components.TurnNotice` receives it as `outcome`, a custom `MessageBubble` as `turnOutcome`, `components.MessageParts` and `useMessageParts` as `turnOutcome`. With `session.save`/`load` it is stored in the user message's `metadata.glirastesTurnOutcome` and read back on load, and a history stored before 0.20.0 loads unchanged without notices. The app's own `metadata` comes back exactly as it was (also an empty object; the SDK never changes the app's objects, it stores copies); a message without `metadata` gets one only in the stored copy (the stored outcome then carries `addedMetadata: true`) and comes back without it; a user message whose `metadata` is set but is not a plain object (an array, a string, a number, `null`) is stored unchanged, and its outcome is not stored. The key never reaches the transport from the provider: it is taken out of a history loaded through `session.load`, and out of a stored history the app hands to its transport itself (for example `useChat({ messages })`; between requests, in copies), so no request the chat sends afterwards carries it. A request the app's own code sends from a stored history before the provider has seen it, or a server reading the store, does see the key. An outcome belongs to the chat and the user message its request was started for: when the open chat changes while a request runs (a host-owned `session.activeId`), the newly opened chat records nothing of it; the outcome is kept in memory and joins its turn when that chat is opened again in the same provider (and is stored then); a page load before that loses it, and a run that ended by itself while its chat was not open records no `completed`. `clear()` (also the Clear button of the built-in UIs) while a request runs that the provider has seen running stops that request through the transport's `stop()` (best effort: a `stop()` that throws, rejects or is missing does not keep the chat from being cleared). A request started in the same tick as `clear()` (a `send()` or `approve()` right before it) is not one yet: it is not stopped and goes on into the emptied chat, as before. Until the transport reports the end of the stopped request (its status leaves `submitted`/`streaming`) the chat is in a clearing window: it stays busy (`isLoading`) and empty, nothing the transport holds or still receives is shown or stored, the request's data parts are dropped (with the bundled Vercel transport also for the app's `onData` and the browser memory notes), the transport starts no request by itself (no continuation after an approval or a UI outcome; `ChatTransport.setAutomaticSendsPaused`, implemented by the Vercel transport), and nothing is recorded (no turn outcome, no `onTurnEnd`, no failure notice). Then the provider empties the transport's history (`setMessages([])`) and resets steps, pipeline state and truncation. During the window `switchSession`, `createSession` and `removeSession` are refused as during any run, and Stop only asks the transport to stop again (no outcome, the queue is not paused). A message sent during the window goes out once the window closed, into the emptied chat, after the checks of a normal send (when taken) and of a queued message (when it goes out): with the queue it is queued as during a run; without it the first one is held (`submitWithResult` reports `queued`) and a further one is refused (`rejected`, reason `session`). A held message is dropped when the host opens another chat (`lastRejection` reason `session`), when attachments were turned off or it became a direct command meanwhile (`lastRejection` `attachments-off` / `files-with-command`), when `clear()` is called again (no refusal: the user cleared it), and when the provider unmounts. With the built-in Vercel and LangGraph transports the window closes at once. A transport whose request does not end on `stop()` keeps the chat busy and empty until the request ends; there is no timeout, and a held message waits that long. Limits: a chat the host opens during the window (`session.activeId`) shows its own history and is not emptied, but what the cleared request still writes into a transport shared by every chat can land in it (the left-chat case of `docs/plans/2026-11-23-design-left-chat.md`); an app-owned AI SDK `Chat` keeps what the request wrote after the provider unmounted during the window; a custom transport without `setAutomaticSendsPaused` decides itself whether it continues. A new request for the same user message (a retry, `regenerate`) removes the outcome and its notice; the new attempt records its own. Status and reason only; nothing goes to the Platform. **Turn end callback:** `onTurnEnd(outcome, info)` on the provider (`OnTurnEnd`; `info` is `TurnEndInfo` `{ sessionId }`, the open chat's id, `'default'` without a session store; also `config.onTurnEnd` on `<glirastes-chat>`) tells the app once that a turn ended, for refreshing data, a sound or a log line, instead of diffing `turnOutcomes`. It is called once per turn of the open chat for every status: `completed`, `aborted` (`stop()`, and the interrupted turn of a `sendNow` with `'abort'`, before the next turn's end), `safety-stop` and `error` (also before the first token and when the turn has no assistant message). `outcome` is the same object `turnOutcomes` holds by then, so the context and the next render agree with it. A turn ends when its last request is over: a stop, safety stop or error the server reports while the run still streams is reported once the run ended; a turn that asks for an approval is reported after the decided run (approved or rejected) finished, with the outcome recorded then, also when the server's safety stop fell on that step; a turn whose UI action outcome starts a continuation request (`uiActionOutcomes`) is reported after that request finished, not twice; a turn whose UI action loads a new page is not reported on the page that is left, but by the next page once the turn it continues ends there. A turn left at an undecided approval for a new message (for example `sendNowDuringApproval: 'reject-approval'` with a transport that does not send on) is reported with what it recorded, if anything, when the new request starts. A retry (`regenerate`) of the same user message is a new attempt and reports its own end. Not called for outcomes read from a stored history (`session.load`, a reload, a history the app hands its transport), for a turn whose chat is not the open one when the turn ends (its outcome joins that chat as described above, without a call then or when the chat is opened again; a chat that was left and opened again before its turn ended is the open one and reports it), or for a run cleared with `clear()`. Once per turn also under React StrictMode. The latest function passed is used (no re-subscription); a throw inside, and the rejection of a promise it returns, is caught and logged (`[glirastes] onTurnEnd threw`) and the chat goes on. Without `onTurnEnd` nothing changes, also not the number of renders. An app that draws its own notice turns the built-in one off with `activityLog.noticeScope: 'latest'` (back to the latest turn only) or `components.TurnNotice: () => null` (none at all). `components.MessageParts` and `useMessageParts` also give `parts`: every part of the message in message order with a stable `key`, its default `node` and, for a tool part that asked for approval, its `approval` (`ToolPartApproval`: label, subjects, decision, outcome, also after a reload). `approvalDisplay` on the provider (`decided: 'entry'`, `open: 'inline'`) draws a lasting entry for decided approvals and the open card at its tool part. The built-in entry (`ApprovalEntry`) renders inside the message at its tool part, one per tool call (several calls of one tool are not merged). It shows the label, the subject names, the preview and the call's field details (`detail-line` with `detail-label` and `detail-value`), with `data-decision` and `data-outcome` to style. It has no link to a created object, and its field labels come from the tool declaration (and what `approvalDescription` returns), not from labels the app defines for the entry. An app that needs those draws its own entry from `parts[].approval` or `components.ApprovalEntry`. An app that already draws its own lasting entry for decided approvals (for example from `useMessageParts` or `components.MessageParts`) must not also turn on `decided: 'entry'`: both would show, side by side. Use one or the other. Under `prefers-reduced-motion: reduce` the spinner and the typing dots stand still.

---

## Frontend Transport (Do I need Vercel AI SDK on the frontend?)

The chat UI needs to talk to the backend somehow (send messages, receive streamed responses). This is called the "transport".

**Right now**, the only built-in transport uses the Vercel AI SDK (`@ai-sdk/react`'s `useChat` hook). So if you use `chat-react` today, you need `@ai-sdk/react` and `ai` installed on the frontend too.

**But the architecture doesn't require it.** There is a `ChatTransport` interface that is completely transport-agnostic. The `AiChatProvider` accepts a `transport` prop — you can plug in any implementation:

```tsx
// Default: Vercel AI SDK transport (requires @ai-sdk/react)
<AiChatProvider transport={vercelTransport}>

// Custom: your own SSE, WebSocket, or plain fetch transport (no Vercel needed)
<AiChatProvider transport={myCustomTransport}>
```

The `ChatTransport` interface is simple — just `messages`, `status`, `sendMessage()`, `stop()`, `setMessages()`, and `addToolApprovalResponse()`. You could implement it with a plain `fetch()` + `ReadableStream` and drop the Vercel dependency entirely.

All the AI logic (tool execution, RBAC, guardrails, etc.) runs on the backend. The frontend transport is just a pipe for streaming text back and forth.

---

## Server Adapters

The core logic lives in server-core. Adapters plug it into your framework.

### adapter-nextjs

`createAiChatHandler()` — creates a Next.js App Router route handler. Handles auth, message prep, intent routing (legacy or pipeline), RBAC filtering, and streaming. Emits `PipelineStepReport` events for real-time progress in the UI.

Request protection, on by default: the body must be `application/json` (415) and valid JSON (400 `invalid_json`), a browser request must come from the handler's own origin or from `allowedOrigins` (403; `crossOriginProtection: false` turns this off for apps that authenticate without cookies; a browser without `Sec-Fetch-Site` may also send the `Host` header's origin with `https` or `http`), and the body is capped at `maxBodyBytes`, 1 MB (413). Approvals are bound to the tool call they were asked for: the handler signs the approval id (HMAC-SHA-256 over tool call id, tool name, canonical input, issue time, expiry and the scope: the managed principal's tenant and subject, else `approvalScope(request)`, else `''` for everyone) with `approvalSecret` / `GLIRASTES_APPROVAL_SECRET`. Before the model runs, every tool part in the history that carries an approval id is checked against its own call. A history that repeats a tool call id or an approval id, or holds a malformed tool part or approval, is refused with 400 (`duplicate_tool_call_id`, `duplicate_approval_id`, `tool_part_malformed`, `approval_malformed`). An approved call without a result in the last step of the last assistant message must verify, be unexpired (`approvalMaxAgeMs`, 15 minutes, at most 24 hours) and unused; it is then consumed and may run, and more than 32 of them are refused (`too_many_approvals`). Every other approved call without a result is denied (`approval_not_runnable`), whatever follows it in the history, so only fully checked calls can run. A part whose id does not verify loses its approval. The model never reads the reason the client sent with a refusal or a bare denial code: before the history becomes model messages, every refused or denied approval gets a fixed server text (the user declined it in the approval dialog, it was not executed, it is not an error, do not retry or guess a cause, ask what the user wants instead; for a server denial one sentence per code, e.g. the approval expired or was already used, with the hint to call the tool again so the user can confirm again). The codes stay in the handler's own checks. A `providerExecuted` flag that the client set on a tool of the handler's own registry is ignored. Single use: the default in-process store keeps each consumed approval until its signed expiry, so it runs at most once per process within its lifetime; it holds 20,000 live approvals, at most 200 per scope (without a managed principal or `approvalScope`, the quota scope is a keyed HMAC of the request's `Authorization`, else `Cookie`, header, which only partitions the quota and is not signed into the id; only requests without credentials share one quota), and refuses further approvals when full (`approval_store_unavailable`). Several instances need a shared `approvalStore`. Pipeline tool selection is routing, not authorization: an approved tool stays callable even if the selection for the continuation leaves it out. Endpoint tools call the origin of the request URL and never read `Host` or `x-forwarded-host` themselves; in Next.js that URL is the server's own listen address, outside Next.js it is whatever the adapter puts into the Web `Request` URL, so an adapter must build it from a fixed own origin, never from `Host` (or pass `endpointCaller` with a fixed `baseUrl`); an API in another process needs `endpointCaller` with a fixed `baseUrl`, or `trustForwardedHeaders` behind a proxy that always sets the header. Production refuses to serve approvals without the secret.

### adapter-nestjs

Uses decorators (`@AiModule()`, `@AiTool()`, `@AiParam()`) on NestJS controllers. `scanNestJsControllers()` introspects metadata at runtime and auto-builds endpoint tool definitions from decorated methods. No manual ai-tool.ts files needed.

---

## Codegen

Automates boring setup work.

- **Endpoint scanner**: Finds all `ai-tool.ts` files in your project, generates a registry file that imports and collects them
- **UI scanner**: Same for UI tools
- **Action ID registry**: Generates a map of all action IDs so the frontend can validate handlers exist
- **Module registry**: Generates module definitions combining tools into intent groups

---

## OpenAPI Generator (openapi-gen)

If you have an OpenAPI spec, this generates tool definitions from it automatically. Reads `x-ai` extensions on your endpoints to know which ones to expose as AI tools. Converts OpenAPI schemas to Zod code. Outputs a TypeScript file with all generated tools ready to use.

---

## CLI

Developer tool for working with the SDK.

| Command | What it does |
|---------|-------------|
| `init` | Interactive setup wizard — detects framework, scaffolds config |
| `generate` | Scan ai-tool.ts files, generate registries |
| `validate` | Check OpenAPI spec for issues (duplicates, missing metadata) |
| `coverage` | Report which API routes have AI tool definitions and which don't |
| `scaffold` | Auto-generate an ai-tool.ts template from an existing route |
| `test` | Scaffold a test file for AI behavior testing |
| `generate-skills` | Export tools as Claude Code / Codex skill files |
| `generate-mcp-server` | Export tools as a standalone MCP server |
| `sync` | Upload tool schemas to Glirastes platform |
| `upgrade` | Update all glirastes-* packages |

---

## Testing (testing package)

Test your AI tool setup without making real LLM calls.

- **Smoke tests**: Do all tools have valid schemas? Can they serialize/deserialize?
- **Routing tests**: Does intent classification pick the right module?
- **Guardrails tests**: Do unsafe inputs get blocked?
- **Approval tests**: Do mutating tools require approval?
- **Edge case tests**: Empty inputs, max-length inputs, unicode, special characters
- **Regression tests**: Do previously-fixed bugs stay fixed?

Uses `createMockToolExecutor()` to simulate tool execution without HTTP.

---

## Package Dependency Layers

```
Layer 0 (no internal deps):
  contracts    — types, schemas, definition helpers
  lancer       — Glirastes platform client

Layer 1 (depends on Layer 0):
  server-core  — tool conversion, RBAC, transport adapters
  codegen      — file scanning, code generation
  openapi-gen  — OpenAPI → tool definitions
  ui-react     — UiActionBus, action dispatch hooks

Layer 2 (depends on Layer 0 + 1):
  server-pro   — Pro pipeline (Lancer-powered)
  adapter-nextjs — Next.js handler
  adapter-nestjs — NestJS decorators + scanning
  chat-react   — chat UI components
  pii-shield   — PII anonymization
  cli          — developer CLI
  testing      — test utilities
```

---

## Open-Core Model

- **Free (MIT)**: contracts, server-core, ui-react, chat-react, codegen, openapi-gen, cli, adapters, testing
- **Pro (proprietary)**: server-pro (pipeline with Lancer delegation)
- **Lancer free tier**: telemetry reporting to Glirastes dashboard
- **Lancer pro tier**: guardrails, intent routing, PII protection, dynamic config, approval flows
