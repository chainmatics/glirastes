# createAiChatHandler options

Every top-level key of `AiChatHandlerConfig` (`glirastes/server/nextjs`), one
line each. Only `systemPrompt` is required; set the rest when the product needs
it. The type's JSDoc carries the full detail.

## Contents

- Tools and routing
- Model and turn limits
- History and answers
- Built-in tools
- Approvals
- Request safety
- Callbacks and observability
- Legacy and Pro

## Tools and routing

| Key | What it does |
| --- | --- |
| `tools` | static `ToolRegistry`; wins over `loadTools` |
| `loadTools` | `LoadTools` callback that builds the registry per request |
| `managedRuntime` | `ManagedLocalRuntimeConfig`: verified principal, pinned turn snapshot, local guard per tool call |
| `toolDiscovery` | local `find_tools` recovery |
| `authorizedToolsOnly` | with `managedRuntime` (default `true`): the model gets only built-ins and the manifest tools the principal may use, checked again before every model step; `false` hands over every registry tool, the guard still refuses the calls |
| `intentRouting` | start-set routing for `toolDiscovery` (default on); `DefaultIntentRoutingOptions` tunes it |
| `toolSemantics` | search-only synonyms per model-facing tool name |
| `directCommands` | `/` commands and entity actions run without a model call (default `true`) |
| `endpointCaller` | `(request) => InternalApiCaller` for an API on another origin or with `Authorization` auth; default `createInternalApiCallerFromRequest` |
| `trustForwardedHeaders` | take the origin from `x-forwarded-*`; only behind a proxy that sets them |

## Model and turn limits

| Key | What it does |
| --- | --- |
| `model` | model instance or resolver |
| `systemPrompt` | string or function of routing, date and pinned `TurnSnapshot` |
| `locale` | answer locale |
| `temperature`, `maxOutputTokens` | passed to the model call |
| `maxSteps` | hard step cap; without it `safetyMaxSteps` (default 24) is the soft cap |
| `safetyMaxSteps` | guard against runaway loops when no `maxSteps` is set |
| `maxBodyBytes` | request body limit (1 MB, 50 MB with attachments) |
| `maxResultChars` | upper bound of a serialized successful tool result for the model, integer from `MIN_MAX_RESULT_CHARS` (1,000) to `MAX_MAX_RESULT_CHARS` (200,000), default `DEFAULT_MAX_RESULT_CHARS` (16,000); larger results are cut by `truncateToolResult(result, maxChars, TruncateToolResultOptions)` (largest array first, then long fields) with a `_truncated` marker (`TruncatedMarker`: `field`, `showing`, `total`, `compacted`, `omittedKeys`, `hint`; for GET/HEAD and approval-free method-less tools the hint offers filtering or the next page with the tool's `PAGINATION_PARAMETER_NAMES`, for other tools it says not to call again just to see more); a tool's own `maxResultChars` (endpoint tool definition, `contract.ts`, OpenAPI `x-glirastes-max-result-chars`) wins; an invalid value throws at creation (`assertMaxResultChars`, `isValidMaxResultChars`); also on `createGlirastes` and as `application.maxResultChars` in the runtime container |
| `attachments` | `ChatAttachmentsConfig`; off by default |

## History and answers

| Key | What it does |
| --- | --- |
| `history` | compacted earlier turns (default on); `HistoryOptions` or `false` |
| `maxContextMessages` | most model messages kept (default 12); the current turn is never split. Not applied when `memory` is set |
| `memory` | chat memory: a rolling summary of older turns (`chat`, threshold `autoCompact` or `GLIRASTES_AUTOCOMPACT`), notes per user (`user`: browser or a `MemoryStore`) and per tenant (`shared`: a `MemoryStore`), with `scope(request)` giving the verified keys. Adds the built-in tools `memory_remember` and `memory_forget`. See the `setting-up-glirastes-memory` skill |
| `maxConversationHistoryPairs` | user/assistant pairs the intent classifier sees (default 4) |
| `promptCaching` | cache breakpoints and stable tool order (default `true`) |
| `hideIds` | keep technical ids out of answers (default `true`) |
| `uiActionSchema` | schema that validates the `uiAction` of tool results |

## Built-in tools

Effective protected privacy disables result handles even with explicit `resultHandles: true`: oversized protected output is withheld (`outputWithheld`) and SDK result readers are refused. The off profile retains retrieval. A standalone store configured with `owner` rechecks that owner on every read.

| Key | What it does |
| --- | --- |
| `clarification` | `ClarificationConfig` enables `ask_clarification` |
| `planning` | `PlanningConfig` enables `update_plan`; the chat shows it as a checklist |
| `resultHandles` | on by default: a successful record result over its `maxResultChars` is kept in full for the running turn (after `piiShield`, sealed once) and the model gets an overview (every entry of the largest array with its small fields; nested arrays and objects, foreign keys, opaque ids, URLs and long texts are left out before dates and names, booleans, numbers and short status-like labels last; left-out fields named in `_result.omitted`, fully emptied objects removed) plus a `_result.id` (`ro_…` read tool, `rw_…` other tool); the built-in `read_result` (`READ_RESULT_TOOL_NAME`; `resultId`, `fields` such as `data[].name` or `data[2].items` for one entry, `offset`, `limit`) reads more without calling the backend, and an incomplete answer says so in `_result.hint` with the `offset` to continue at. `ResultHandleLimits` `{ maxResults, maxResultBytes, maxTotalBytes }` (defaults `DEFAULT_RESULT_HANDLE_LIMITS`: 8, 2 MiB, 16 MiB); beyond them, or with `false`, results are cut (`_truncated`). Handles live only in the request: an approval continuation or a later turn answers `result_expired`. Managed turns run the origin tool's guard per read (budget, fresh principal, revocations, loop detection); without `managedRuntime` there is no principal check. Direct commands get no handles. The browser sees the overview and every `read_result` answer as the model does; renderers see only what the overview contains. Lower level: `createResultStore(ResultStoreOptions)` (`ResultStore`, `ResultHandle`) as `resultStore` of `toolsToAiTools` plus `createReadResultTool(store, ReadResultGuard)` |
| `guardrails` | `GuardrailHook`, the app's own input check before routing; a refusal answers 400 |
| `privacy` | `ChatPrivacyConfig`: the protected-text profile, one privacy boundary around every model call of a turn; see [privacy.md](privacy.md) |
| `piiShield` | legacy: anonymize user messages before the model, re-hydrate tool arguments; replaced by `privacy` |

## Approvals

| Key | What it does |
| --- | --- |
| `approvalSecret` | HMAC secret that binds an approval to its tool call; falls back to `GLIRASTES_APPROVAL_SECRET`, required in production |
| `approvalMaxAgeMs` | approval lifetime (default 15 minutes, at most 24 hours) |
| `approvalStore` | single-use `ApprovalStore`; several instances need a shared one (e.g. Redis `SET NX PXAT`) |
| `approvalScope` | `(request) => userId` binds approvals to a user without a managed runtime |

## Request safety

| Key | What it does |
| --- | --- |
| `crossOriginProtection` | refuses cross-site browser posts (default on); `false` only without cookie auth |
| `allowedOrigins` | other origins whose pages may post to the handler |
| `wrapHandler` | wrap each request, e.g. in a tenant context |

## Callbacks and observability

| Key | What it does |
| --- | --- |
| `onError` | request failed |
| `onToolError` | a tool threw |
| `classifyToolFailure` | `ToolFailureClassifier`: gets `ToolFailureInfo` (`toolName`, HTTP `status`, full parsed `body`) of a failed backend call and returns a `ToolFailureClassification`, `'expected'` or `'error'`; expected failures skip `maxConsecutiveErrors` and metric errors, counted locally only; never applies to managed-guard denials, which always count as errors; also on `createGlirastes`; not in the runtime container |
| `onFinish` | steps, finish reason, token usage, truncation, `StepLimitSource` and the local `expectedToolFailureCount` |
| `emitStepReports` | `data-step-report` stream parts (default on) |
| `onStepReport` | one `PipelineStepReport` per step |
| `onPipelineResult` | intent, module, model and tools chosen by `pipeline` |
| `onAudit` | `AuditEmitter` for all audit events; forward to logs or a SIEM |
| `metrics` | content-free turn metrics, e.g. from `createGlirastes(...).chatTurn()` |
| `modelPricing` | price table for providers that report no cost |

## Legacy and Pro

| Key | What it does |
| --- | --- |
| `pipeline` | Pro `AiPipeline` from `glirastes/server`; replaces guardrails and intent router routing |
| `followups` | follow-up suggestions; needs `pipeline` |
| `intentRouter` | deprecated; use `pipeline` |
| `telemetry` | legacy remote sink; refused together with `managedRuntime` (use `metrics`) |
| `lancer` | legacy prompt and model overrides; not on the Foundation path |
| `modelDefaults` | model ids per tier reported with `lancer` |
| `modelInstanceFactory` | turns a model id into a model instance for `lancer` overrides |
