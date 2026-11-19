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
| `toolDiscovery` | local `find_tools` recovery; appends a fixed note to the system prompt to call `find_tools` before saying a request cannot be done |
| `authorizedToolsOnly` | with `managedRuntime` (default `true`): the model gets only built-ins and the manifest tools the principal may use, checked again before every model step; `false` hands over every registry tool, the guard still refuses the calls |
| `intentRouting` | start-set routing for `toolDiscovery` (default on); `DefaultIntentRoutingOptions` tunes it |
| `toolSemantics` | search-only synonyms and examples per model-facing tool name (`find_tools` and the start set); replaces the map `chatTurn()` hands on. To add your own instead, pass `mergeToolSearchSemantics(turn.toolSemantics, own)` (`glirastes/runtime`; own entries first, each once, at most 20 synonyms and 10 examples per tool) |
| `toolTexts` | `ToolTextsMap`: labels per language (`ToolTexts` with `labels`, each a `ToolLabelTexts` of `singular`, `plural`, `approval`) per model-facing tool name; `chatTurn()` hands on `toolTexts` of the generated module, written when `.glirastes/tools.json` names `languages`. The `data-tool-presentation` part then words each tool in the turn's language: the manifest presentation where it is in that language, else these labels (the language, another region of it, English, the first one). Without it the part is unchanged |
| `directCommands` | `/` commands and entity actions run without a model call (default `true`) |
| `endpointCaller` | `(request) => InternalApiCaller` for an API on another origin or with `Authorization` auth; default `createInternalApiCallerFromRequest` |
| `trustForwardedHeaders` | take the origin from `x-forwarded-*`; only behind a proxy that sets them |

## Model and turn limits

| Key | What it does |
| --- | --- |
| `model` | model instance or resolver |
| `systemPrompt` | string or function of routing, date and pinned `TurnSnapshot` |
| `locale` | locale of the texts the handler writes itself, e.g. the budget stop notice (`en-US` by default; any `de*` value gives German, other languages via `locales`). Not taken from the chat or the model's answers: a German chat without `locale: 'de-DE'` gets an English stop notice. The default of every turn; `requestLocale` sets it per request |
| `requestLocale` | `(request) => string \| undefined` (may be async): the BCP-47 language of one request, e.g. a header the chat transport sends (`headers: { 'x-app-language': lang }`), a cookie or the user's profile; `preferredLanguage(request.headers.get('accept-language'))` from `glirastes/contracts` reads `Accept-Language`; the same module resolves the app's own texts with this fallback (`resolveLocalizedText(text, language)` for a `LocalizedText`, a plain string or one per `LanguageTag`; `pickLanguage(tags, language)`; `isLanguageTag(value)`). Opt-in. It sets the turn's language of the handler's texts and, with `toolTexts`, of the tool labels; it must not read the body; no language tag or a throw falls back to `locale`. The model still gets one English description per tool |
| `locales` | `ChatServerLocales`: the handler's own texts per BCP-47 tag, to add a language (`pl`) or change single texts of one. Keys of `ChatServerTexts`: those of `budgetStopTexts` plus `silentTurn` (the answer of a turn that produced nothing). Partial tables fall back per key: the language, another region of it, built-in German or English, English. `budgetStopTexts` stays language-free and wins for every language. An unknown key, empty text or non-tag key throws. Model hints (404 hint, truncation) stay English: only the model reads them |
| `temperature`, `maxOutputTokens` | passed to the model call |
| `maxSteps` | hard step cap; without it `safetyMaxSteps` (default 24) is the soft cap |
| `safetyMaxSteps` | guard against runaway loops when no `maxSteps` is set |
| `budgetStopTexts` | `Partial<BudgetStopTexts>`: texts of the stop notice the handler appends as its own text part (kept in the assistant message) when it stops a turn at `maxSteps` or a runtime budget without a final answer of the model: no summary call after a token, cost, time or model-step limit, or a summary that failed or said nothing. Keys `closing` and `closingWithoutAnswer` (with `{reason}`) and per reason (`BudgetStopReason`: `maxSteps`, `maxModelSteps`, `maxToolCalls`, `totalTimeoutMs`, `maxInputTokens`, `maxOutputTokens`, `maxEstimatedCostUsd`, `maxRepeatedFingerprint`, `maxConsecutiveErrors`) with `{limit}`; replace single keys of the `locale` defaults (`DEFAULT_BUDGET_STOP_TEXTS`, English and German); an unknown key or empty text throws. After a tool limit the model gets one tool-free summary call instead. Note: every tool result, also each `read_result` page, counts against `maxInputTokens` again on every later step of the turn |
| `maxBodyBytes` | request body limit (1 MB, 50 MB with attachments) |
| `maxResultChars` | upper bound of a serialized successful tool result for the model, integer from `MIN_MAX_RESULT_CHARS` (1,000) to `MAX_MAX_RESULT_CHARS` (200,000), default `DEFAULT_MAX_RESULT_CHARS` (16,000); larger results are cut by `truncateToolResult(result, maxChars, TruncateToolResultOptions)` (largest array first, then long fields) with a `_truncated` marker (`TruncatedMarker`: `field`, `showing`, `total`, `compacted`, `omittedKeys`, `hint`; for GET/HEAD and approval-free method-less tools the hint offers filtering or the next page with the tool's `PAGINATION_PARAMETER_NAMES`, for other tools it says not to call again just to see more); a tool's own `maxResultChars` (endpoint tool definition, `contract.ts`, OpenAPI `x-glirastes-max-result-chars`) wins; an invalid value throws at creation (`assertMaxResultChars`, `isValidMaxResultChars`); also on `createGlirastes` and as `application.maxResultChars` in the runtime container |
| `attachments` | `ChatAttachmentsConfig`; off by default |

## History and answers

| Key | What it does |
| --- | --- |
| `history` | compacted earlier turns (default on); `HistoryOptions` (`maxTurns` 6, `toolTurns` 1, `maxTokens` 4000, `maxItems` 10, `maxStringLength` 300, `keepIdentity` true) or `false`. The previous turn keeps its tool results: arrays keep `maxItems` entries complete; the entries of the largest array beyond them keep only their identity fields (`id`, `uuid`, `key`, `slug`, `code`, `name`, `title`, `label`, `displayName`), marked by `_history` (`field`, `showing`, `full`, `total`, `keys`, `hint`). Within `maxTokens`, complete entries give way first, then all but one id and one name field, then names are clipped to 60 characters (`…[clipped]`), then trailing entries (counted in the marker, to be fetched again); an id never loses its entry's name. A `_result` handle of an earlier turn gets a hint that it expired. Older turns go as text; the newest one whose tool results were left out ends with a note that no ids from them are available. `keepIdentity: false` drops entries beyond `maxItems` with a count, as before The default `maxTokens: 4000` keeps id and name for lists of up to about 100 entries; raise it for longer lists. Known limits: arrays inside an entry and the rolling chat summary do not keep ids (see `docs/concepts.md`). |
| `maxContextMessages` | most model messages kept (default 12); the current turn is never split. Not applied when `memory` is set |
| `memory` | chat memory: a rolling summary of older turns (`chat`, threshold `autoCompact` or `GLIRASTES_AUTOCOMPACT`), notes per user (`user`: browser or a `MemoryStore`) and per tenant (`shared`: a `MemoryStore`), with `scope(request)` giving the verified keys. Adds the built-in tools `memory_remember` and `memory_forget`. See the `setting-up-glirastes-memory` skill |
| `maxConversationHistoryPairs` | user/assistant pairs the intent classifier sees (default 4) |
| `promptCaching` | cache breakpoints and stable tool order (default `true`) |
| `hideIds` | keep technical ids out of answers (default `true`); also learns the ids a tool's `outputEntities` declare (integers only with an id prefix) |
| declared identity | `outputEntities` / `inputEntities` on `Tool`, `defineTool`, `defineEndpointTool` and a `contract.ts` entry, `defineEntity` (`glirastes`): id (or composite key), name, fallback, type, `idKind`; used by overview, history, `read_result`, `hideIds`, approval card and entity links, sent to the browser as a transient `data-tool-entities` part only when declared (`entityDeclarationsOfTools`, `TOOL_ENTITIES_PART_TYPE`, `ToolEntitiesPart`); `collectDeclaredIdLabels` feeds a custom `createHideIdsTransform`. Types: `EntityDeclaration`, `OutputEntityDeclaration`, `InputEntityRef`, `InputEntityRole`, `EntityIdKind`, `ToolEntityDeclarations`, `EntityDeclarationsByTool`. See `docs/entity-identity.md` |
| approval subjects | `entityLookup` (read tool: `{ type, params, const?, result?, complete? }`), `approvalSubject` (write tool: `{ refs?, preview?, onUnavailable?, onForbidden?, recheck? }` or `false`), `lookupEffect: 'read'` (POST dry-run source; does not lower the tool's own approval). Handler option `approvalSubjects` (`ApprovalSubjectLimits`: `maxLookupsPerTurn` 32, `maxSubjectsPerCall` 4, `lookupTimeoutMs` 3000, `maxLookupTimePerTurnMs` 10000, or `false`). Lookups run in the built-in stream handler only, with the user's credentials, and never count against `maxToolCalls` (calls made by the model); a missing (by default also a forbidden) record refuses the call without a card; the browser gets a persistent `data-approval-subjects` part (`APPROVAL_SUBJECTS_PART_TYPE`, data `ApprovalSubjectsPartData` with `ServerApprovalSubject[]` and `ApprovalPreviewData` of `ApprovalPreviewValue`) and a `glirastes-approval.v2.` id; the model gets an `ApprovalSubjectRefusalCode` for a refused call. Defaults: `DEFAULT_APPROVAL_SUBJECT_LIMITS`. Types (`glirastes`): `EntityLookup`, `EntityLookupParam`, `EntityLookupConst`, `EntityLookupResult`, `LookupEffect`, `ApprovalSubjectOption`, `ApprovalSubjectDeclaration`, `ApprovalSubjectUnavailable`, `ApprovalSubjectForbidden`, `ApprovalSubjectRecheck`, `ApprovalSubjectUncheckedReason`, `ApprovalPreviewDeclaration`, `ApprovalPreviewField`, `ApprovalPreviewFormat`; React `ApprovalPreviewItem` (`PendingApproval.preview`). See `docs/approval-subjects.md` |
| `uiActionSchema` | schema that validates the `uiAction` of tool results |

## Built-in tools

| Key | What it does |
| --- | --- |
| `clarification` | `ClarificationConfig` enables `ask_clarification` |
| `planning` | `PlanningConfig` enables `update_plan`; the chat shows it as a checklist |
| `resultHandles` | on by default: a successful record result over its `maxResultChars` is kept in full for the running turn (after `piiShield`, sealed once) and the model gets an overview (every entry of the largest array with its small fields; nested arrays and objects, foreign keys, opaque ids, URLs and long texts are left out before dates and names, booleans, numbers and short status-like labels last, nested ones before an entry's own; left-out fields named in `_result.omitted`, fully emptied objects removed and listed once with up to eight child `keys` readable as `path.key`) plus a `_result.id` (`ro_…` read tool, `rw_…` other tool); the built-in `read_result` (`READ_RESULT_TOOL_NAME`; `resultId`, `fields` such as `data[].name` or `data[2].items` for one entry, `offset`, `limit`) reads more without calling the backend, and an incomplete answer says so in `_result.hint` with the `offset` to continue at. `ResultHandleLimits` `{ maxResults, maxResultBytes, maxTotalBytes }` (defaults `DEFAULT_RESULT_HANDLE_LIMITS`: 8, 2 MiB, 16 MiB); beyond them, or with `false`, results are cut (`_truncated`). Handles live only in the request: an approval continuation or a later turn answers `result_expired`. Managed turns run the origin tool's guard per read (budget, fresh principal, revocations, loop detection); without `managedRuntime` there is no principal check. Direct commands get no handles. The browser sees the overview and every `read_result` answer as the model does; renderers see only what the overview contains. Lower level: `createResultStore(ResultStoreOptions)` (`ResultStore`, `ResultHandle`) as `resultStore` of `toolsToAiTools` plus `createReadResultTool(store, ReadResultGuard)` |
| per-tool output fields | `outputAllowedFields`, `outputDeniedFields`, `outputDefaultFields` on `Tool`, `defineTool`, `defineEndpointTool` and a `contract.ts` entry (OpenAPI: `x-glirastes-output-allowed-fields`, `-denied-fields`, `-default-fields`): field paths such as `data[].name` (no index, at most `MAX_OUTPUT_FIELDS` paths of `MAX_OUTPUT_FIELD_CHARS` characters; `**.fileUrl` in the deny-list removes a key at any depth). Allowed minus denied is the upper bound (`OutputBound`, `outputBoundOf`, `applyOutputBound`), applied in `toolToAiTool` before the PII shield, the result store, the overview and `truncateToolResult`, and in `executeTool`; `uiAction` is reduced only by `**.key` (it is built from the full answer and seen by the model in the same turn), `success` stays only as a boolean, a failed call's body is withheld under an allow-list or when not JSON and otherwise reduced (`bodyWithheld`), error texts are not filtered. The default view is the first answer: with a store a handle and `_result.omitted`, without one a `_truncated` marker (`DefaultViewMarker`) saying the rest cannot be read. Validate with `normalizeOutputFields`, `isValidOutputFields`, `assertOutputFields` (`OutputFieldsName`); an invalid list throws in `defineTool` and `endpointToolToTool` |
| `guardrails` | `GuardrailHook`, the app's own input check before routing; a refusal answers 400 |
| `piiShield` | anonymize user messages before the model, re-hydrate tool arguments |

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
| `onError` | `(error, req, info?: AiChatErrorInfo)`: the request or turn failed (no `info`), or one tool call of a running turn failed (`info.source === 'tool-call'`, `info.kind`: `'denied'` budget or terminal guard denial, `'invalid-input'` a `ToolInputValidationError` with `issues: ToolInputIssue[]` (field path and expectation, never the value), `'failed'` timeout or thrown error); once per failure, a throw is ignored during streaming. The chat sees `AI request failed`, or a fixed text for a guard denial such as `Tool call limit for this turn reached (8).`; a budget denial is a `ToolExecutionDeniedError` with `budget: BudgetLimitState[]` (`{ dimension, limit, used }`) |
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
