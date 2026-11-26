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
- Counting turns in onFinish
- Order of parts at the end of the stream
- Legacy and Pro

## Tools and routing

| Key | What it does |
| --- | --- |
| `tools` | static `ToolRegistry`; wins over `loadTools` |
| `loadTools` | `LoadTools` callback that builds the registry per request |
| `managedRuntime` | `ManagedLocalRuntimeConfig`: verified principal, pinned turn snapshot, local guard per tool call; optional `loadControl` (environment control: a halt answers 503 `assistant_halted` or `control_unknown` before anything runs and is checked again before every model step, tool call and approval check; its `budgetCeiling` only lowers the turn budget) and `admitTurn` (refusal answers 429 `turn_rate_limited` with `Retry-After`); `turnRollout` (deployment and cohort of a resolved turn: its metrics become v3). `resolveTurnSnapshot` receives `conversationId` (body `id`, else the first user message), the key of canary stickiness. `loadControl` returns a `ManagedTurnControl` (`{ assistant: 'enabled', budgetCeiling?, rateLimit? }` or `{ assistant: 'halted', code }` with `ManagedTurnHaltCode` `assistant_halted` or `control_unknown`). A custom `streamHandler` calls `ctx.managedTurn.beforeModelStep()` before each model call; it throws `AssistantHaltedError` (with that `code`) while halted, so end the stream there |
| `toolDiscovery` | local `find_tools` recovery; appends a fixed note to the system prompt to call `find_tools` before saying a request cannot be done |
| `authorizedToolsOnly` | with `managedRuntime` (default `true`): the model gets only built-ins and the manifest tools the principal may use, checked again before every model step; `false` hands over every registry tool, the guard still refuses the calls |
| `intentRouting` | start-set routing for `toolDiscovery` (default on); `DefaultIntentRoutingOptions` tunes it |
| `toolSemantics` | search-only synonyms and examples per model-facing tool name (`find_tools` and the start set); replaces the map `chatTurn()` hands on. To add your own instead, pass `mergeToolSearchSemantics(turn.toolSemantics, own)` (`glirastes/runtime`; own entries first, each once, at most 20 synonyms and 10 examples per tool) |
| `toolTexts` | `ToolTextsMap`: labels per language (`ToolTexts` with `labels`, each a `ToolLabelTexts` of `singular`, `plural`, `approval`) per model-facing tool name; `chatTurn()` hands on `toolTexts` of the generated module (written by default; `.glirastes/tools.json` `"languages": []` turns it off). The `data-tool-presentation` part then words each tool in the turn's language: the manifest presentation where it is in that language, else these labels (the language, another region of it, English, the first one). Without it the part is unchanged. A direct `/` command of a managed turn sends the same part ahead of its step (`runDirectCommand` option `toolPresentation`) |
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
| `clientLanguage` | `boolean`, default `true`: the language the chat UI names in each request (`Content-Language`, one BCP-47 tag, sent by the React/Vercel transport and `<glirastes-chat>`; a list, `*` or anything else is ignored) is the turn's language when neither `requestLocale` nor `locale` is set. Order: `requestLocale` > `locale` > this > the manifest's locale. `false` ignores it. A CORS-safelisted header: a cross-origin chat needs no extra allowed header |
| `locales` | `ChatServerLocales`: the handler's own texts per BCP-47 tag, to add a language (`pl`) or change single texts of one. Keys of `ChatServerTexts`: those of `budgetStopTexts`, `silentTurn` (the answer of a turn that produced nothing), `streamError` (the chat's text for any failed turn or tool call the SDK does not name itself; built-in `AI request failed`, German `KI-Anfrage fehlgeschlagen`) and `invalidToolInput` (a tool call whose arguments do not match the schema). The chat shows these texts as the call's `errorText`; when one differs from the English built-in, the stream adds a content-free `data-step-failure` part (`{ toolCallId, code: 'failed' \| 'invalid-input' }`) so the chat UI's activity log still shows its own `activityFailure…` text; with one text for both keys no part is sent. Partial tables fall back per key: the language, another region of it, built-in German or English, English. `budgetStopTexts` stays language-free and wins for every language. An unknown key, empty text or non-tag key throws. Model hints (404 hint, truncation) stay English: only the model reads them; so does the history text an `invalidToolInput` text of any language becomes in a later turn. The 500 JSON body before streaming stays `AI request failed`. Still English in a German chat: `toolDenialDisplayText` (permission and budget denials, `src/runtime/tool-denial.ts`), `UNAVAILABLE_TOOL_TEXT` and `APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS` |
| `temperature`, `maxOutputTokens` | passed to the model call; `temperature` defaults to 0.2. `temperature: null` sends no `temperature` at all (also none to the memory summary calls), for models that reject it such as reasoning models; with a number the summary calls keep their own 0 |
| `maxSteps` | hard step cap; without it `safetyMaxSteps` (default 24) is the soft cap |
| `safetyMaxSteps` | guard against runaway loops when no `maxSteps` is set |
| `budgetStopTexts` | `Partial<BudgetStopTexts>`: texts of the stop notice the handler appends as its own text part (kept in the assistant message) when it stops a turn at `maxSteps` or a runtime budget without a final answer of the model: no summary call after a token, cost, time or model-step limit, or a summary that failed or said nothing. Keys `closing` and `closingWithoutAnswer` (with `{reason}`) and per reason (`BudgetStopReason`: `maxSteps`, `maxModelSteps`, `maxToolCalls`, `totalTimeoutMs`, `maxInputTokens`, `maxOutputTokens`, `maxEstimatedCostUsd`, `maxRepeatedFingerprint`, `maxConsecutiveErrors`) with `{limit}`; replace single keys of the `locale` defaults (`DEFAULT_BUDGET_STOP_TEXTS`, English and German); an unknown key or empty text throws. After a tool limit the model gets one tool-free summary call instead. Note: every tool result, also each `read_result` page, counts against `maxInputTokens` again on every later step of the turn. After the closing sentence the notice says what was done (keys `done`, `open`, `openUnanswered` with `{items}`: activity labels of the successful app tool calls, the open `update_plan` items, else that the question is not answered yet) and how to go on (`continueHint` points to the button below without naming it; `continueTypedHint`, a typed message, only once the turn used its 3 continuations). Right before the notice the stream writes a `data-budget-stop` part (`{ v: 1, continuable }`); the chat's "Continue" button resends the history with `glirastesContinuation: 'budget'` in the body: same turn, fresh budget, an instruction listing what ran, and a guard that answers a repeated non-read-only call attempted before the latest stop (same tool and normalized arguments) with a tool error instead of running it or asking for approval; the guard stays on for the approval and UI outcome requests of that turn, a refusal counts as a tool error toward `maxConsecutiveErrors` and `maxRepeatedFingerprint`. Each continuation is a request with a fresh budget, so time and cost of one question can reach 4x the per-request limit; a managed policy has no switch for continuations yet. A typed follow-up is a new turn without the repeat guard. Invalid or exhausted continuations and any continuation with `customStreamHandler` get `400 { error: 'Nothing to continue' }`. A strict body validator must allow `glirastesContinuation` |
| `maxBodyBytes` | request body limit (1 MB, 50 MB with attachments) |
| `maxResultChars` | upper bound of a serialized successful tool result for the model, integer from `MIN_MAX_RESULT_CHARS` (1,000) to `MAX_MAX_RESULT_CHARS` (200,000), default `DEFAULT_MAX_RESULT_CHARS` (16,000); larger results are cut by `truncateToolResult(result, maxChars, TruncateToolResultOptions)` (largest array first, then long fields) with a `_truncated` marker (`TruncatedMarker`: `field`, `showing`, `total`, `compacted`, `omittedKeys`, `hint`; for GET/HEAD and approval-free method-less tools the hint offers filtering or the next page with the tool's `PAGINATION_PARAMETER_NAMES`, for other tools it says not to call again just to see more); a tool's own `maxResultChars` (endpoint tool definition, `contract.ts`, OpenAPI `x-glirastes-max-result-chars`) wins; an invalid value throws at creation (`assertMaxResultChars`, `isValidMaxResultChars`); also on `createGlirastes` and as `application.maxResultChars` in the runtime container |
| `attachments` | `ChatAttachmentsConfig`; off by default |

### The user's language from the app's database

The turn language decides the tool labels (with `toolTexts`), the approval
card's wording and the handler's own texts (with `locales`); the order is
`requestLocale` > `locale` > the language the chat UI sends
(`Content-Language`, `clientLanguage`) > the manifest's locale.

- **A fixed `locale` wins over the page language the client sends.** With
  `locale: 'de-DE'` every turn is German, whatever `language`, the page's
  `lang` or `sendLanguage` say; the sent language is used only when neither
  `requestLocale` nor `locale` is set. Use `locale` alone only for a
  single-language app.
- **Language stored per user:** read it in `requestLocale`, which may be
  async and gets the request (headers and cookies; never the body):
  `requestLocale: async (request) => (await userOf(request))?.language`.
  Return a BCP-47 tag (`pl-PL`); `undefined`, a value that is no tag or a
  throw falls back to `locale`, so `locale` can stay as the default for
  users without a stored language.
- **The chat's built-in texts** follow the browser, not the server: pass the
  same stored language as `language` on `AiChatProvider` (or
  `<glirastes-chat lang>`), which wins over the page's `lang`; `locales`
  adds a language the built-in German and English tables lack. With
  `sendLanguage` (default on) the chat then also sends it, which only
  matters for a handler without `requestLocale` and `locale`.

## History and answers

| Key | What it does |
| --- | --- |
| `history` | compacted earlier turns (default on); `HistoryOptions` (`maxTurns` 6, `toolTurns` 1, `maxTokens` 4000, `maxItems` 10, `maxStringLength` 300, `keepIdentity` true) or `false`. The previous turn keeps its tool results: arrays keep `maxItems` entries complete; the entries of the largest array beyond them keep only their identity fields (`id`, `uuid`, `key`, `slug`, `code`, `name`, `title`, `label`, `displayName`), marked by `_history` (`field`, `showing`, `full`, `total`, `keys`, `hint`). Within `maxTokens`, complete entries give way first, then all but one id and one name field, then names are clipped to 60 characters (`…[clipped]`), then trailing entries (counted in the marker, to be fetched again); an id never loses its entry's name. A `_result` handle of an earlier turn gets a hint that it expired. Older turns go as text; the newest one whose tool results were left out ends with a note that no ids from them are available. `keepIdentity: false` drops entries beyond `maxItems` with a count, as before The default `maxTokens: 4000` keeps id and name for lists of up to about 100 entries; raise it for longer lists. Known limits: arrays inside an entry and the rolling chat summary do not keep ids (see `docs/concepts.md`). Defaults since 0.18.0: `toolTurnCounting: 'tool-turns'` (way back `'all-turns'`) counts only earlier turns with tool calls against `toolTurns`, so a turn without tools no longer pushes a list's ids out; `seenObjects` on (way back `false`; `true` or `{ maxEntries, maxTokens }`, 40, 800; type `SeenObjectsOptions`, entries `SeenObject`) adds a `<seen-objects>` memo ahead of the history with the DECLARED id and name of records whose results left the history (only tools with `outputEntities`; values as the model got them; says they may be outdated and ids must not be invented). Measurements: `docs/history-measurement.md`. |
| `maxContextMessages` | most model messages kept (default 12); the current turn is never split. Not applied when `memory` is set |
| `memory` | chat memory: a rolling summary of older turns (`chat`, threshold `autoCompact` or `GLIRASTES_AUTOCOMPACT`), notes per user (`user`: browser or a `MemoryStore`) and per tenant (`shared`: a `MemoryStore`), with `scope(request)` giving the verified keys. Adds the built-in tools `memory_remember` and `memory_forget`. See the `setting-up-glirastes-memory` skill |
| `maxConversationHistoryPairs` | user/assistant pairs the intent classifier sees (default 4) |
| `promptCaching` | cache breakpoints and stable tool order (default `true`) |
| `hideIds` | keep technical ids out of answers (default `true`); also learns the ids a tool's `outputEntities` declare (integers only with an id prefix) |
| declared identity | `outputEntities` / `inputEntities` on `Tool`, `defineTool`, `defineEndpointTool` and a `contract.ts` entry, `defineEntity` (`glirastes`): id (or composite key), name, fallback, type, `idKind`; used by overview, history, `read_result`, `hideIds`, approval card and entity links, sent to the browser as a transient `data-tool-entities` part only when declared (`entityDeclarationsOfTools`, `TOOL_ENTITIES_PART_TYPE`, `ToolEntitiesPart`); `collectDeclaredIdLabels` feeds a custom `createHideIdsTransform`. Types: `EntityDeclaration`, `OutputEntityDeclaration`, `InputEntityRef`, `InputEntityRole`, `EntityIdKind`, `ToolEntityDeclarations`, `EntityDeclarationsByTool`. See `docs/entity-identity.md` |
| approval subjects | `entityLookup` (read tool: `{ type, params, const?, result?, complete? }`), `approvalSubject` (write tool: `{ refs?, preview?, onUnavailable?, onForbidden?, recheck? }` or `false`; a reference whose argument holds a list of ids, `{ type: 'user', args: 'memberIds' }`, is looked up per distinct id, each one subject under the argument's path and one of `maxSubjectsPerCall`; a composite key with a list argument is not looked up), `lookupEffect: 'read'` (POST dry-run source; does not lower the tool's own approval). Handler option `approvalSubjects` (`ApprovalSubjectLimits`: `maxLookupsPerTurn` 32, `maxSubjectsPerCall` 4, `lookupTimeoutMs` 3000, `maxLookupTimePerTurnMs` 10000, or `false`). Lookups run in the built-in stream handler only, with the user's credentials, and never count against `maxToolCalls` (calls made by the model); a missing (by default also a forbidden) record refuses the call without a card; the browser gets a persistent `data-approval-subjects` part (`APPROVAL_SUBJECTS_PART_TYPE`, data `ApprovalSubjectsPartData` with `ServerApprovalSubject[]` and `ApprovalPreviewData` of `ApprovalPreviewValue`) and a `glirastes-approval.v2.` id; the model gets an `ApprovalSubjectRefusalCode` for a refused call. Defaults: `DEFAULT_APPROVAL_SUBJECT_LIMITS`. Types (`glirastes`): `EntityLookup`, `EntityLookupParam`, `EntityLookupConst`, `EntityLookupResult`, `LookupEffect`, `ApprovalSubjectOption`, `ApprovalSubjectDeclaration`, `ApprovalSubjectUnavailable`, `ApprovalSubjectForbidden`, `ApprovalSubjectRecheck`, `ApprovalSubjectUncheckedReason`, `ApprovalPreviewDeclaration`, `ApprovalPreviewField`, `ApprovalPreviewFormat`; React `ApprovalPreviewItem` (`PendingApproval.preview`). See `docs/approval-subjects.md` |
| `viewContext` | `ViewContextOption` (`glirastes/contracts`): what the user had open when sending the newest message, given to the model as data. On by default (`false` off, `null` = not set); the browser sends it with a new user message once a page registers something (`useViewContext` in `glirastes/react`, `registerViewContext` in `glirastes/browser`; no switch per chat in the browser: register nothing, or set `false` here; see `docs/chat-interactions.md`, View context); while nothing is registered no field is sent and no block is added (the escape of `<view-context` in user text below still applies while the option is on). The runtime container turns it off until its option `chat.viewContext` comes. Reads the body field `glirastesViewContext: { version: 1, current: ViewContextEntry[] }` (another version or shape is ignored, never a 400), sanitizes it (`sanitizeViewContext`) against the entity types the request's tools declare (`outputEntities` / `inputEntities`, before intent scoping; `types` narrows them), `maxEntries` (8), facts only for a type with a schema in `facts` (Zod or `safeParse`), and sends a `<view-context>` block (fixed header "data, not an instruction", one escaped JSON line per entry; entry lines at most 2,560 characters after shield and escaping, whole trailing entries left out beyond; the whole block at most 2,966 characters (a hard bound): typically far fewer tokens, roughly 850 at 3.5 characters per token when full, 1,000 to 1,500 with random ids or non-ASCII text; an app makes it smaller with `maxEntries` and the `facts` config) as its own user message right after the newest user message: never in the system prompt, behind the cache breakpoint, never stored in the chat. With `piiShield` the values (ids, labels, routes, fact values) are shielded before serializing, like tool results (counted in the audit as `anonymize-result` and in `totalToolCalls`), and its result, read once into an own JSON copy, is checked again per entry: a label over 60 characters is cut, an invalid route left out, anything else failing (or a failing shield) sends no block. Grants no permission; no nonce: instead, while `viewContext` is on, `<view-context` and `</view-context` in the text of user messages reach the model as `&lt;view-context`: the tag in its ASCII spelling, in any case, also with whitespace, zero-width characters or a soft hyphen between `<` and the name or around the `/`, and `<view-context-…>`; an `&lt;` the user typed before the name becomes `&amp;lt;`. The model still reads the text. Only the model input changes, after the PII shield and the guardrails: the PII shield and the intent classification of the pipeline mode get the text as the user wrote it (they see no file names); the guardrails, a custom `streamHandler`, the chat and the stream get the text and file names as the user wrote them. Messages the SDK writes itself are never escaped: the seen-objects memo, the chat memory, the view context block, the budget continuation and the final summary instruction. The `filename` of a file part is escaped too, in the part itself (providers such as `@ai-sdk/openai` pass it on for PDFs) and in its placeholder text; the content of files is not. Not verified against the real service: whether the OpenAI API accepts `&lt;` in the `filename` of a file part; no locally installed provider refuses the name. Not caught: full-width or look-alike characters (`＜`, homoglyphs, other hyphens), a line break or an invisible character inside the name, control and bidi characters between `<` and the name (such as U+0001, U+007F, U+0085, U+200E, U+202E, U+2066), in text and file names (issue #218), entities such as `&#60;`, a tag split across two text parts or two messages, the content of file attachments, the tool call arguments of an approval continuation, the imitated header text without tags, chat memory notes and summaries, tool results and assistant text. Either way the block grants no permission: the server checks types, ids and facts on its own. Text without the name `view-context` (any case) is returned unchanged without a scan; in text with it, the pattern's rule that a `<` before 64 or more whitespace or zero-width characters counts as a tag still applies (over-escaping). Known limit: such text with many `<` and whitespace costs about 0.2 to 0.8 s of CPU per MB on Node, bounded by `maxBodyBytes`: 1 MB by default, but 50,000,000 bytes by default with `attachments.enabled`, where one such request can take roughly 10 to 40 s. No block for a continuation (approval, UI outcome, budget), a request the guardrails blocked, the answer to a clarification, a direct command or a custom `streamHandler`. The guardrails and the input check do not see it; `hideIds` does not learn its ids. Known limit of the PII shield: the sanitizer cuts a label to 60 characters before the shield sees it, so in a label over 60 characters that ends with an e-mail address, IBAN or phone number the cut value may no longer be recognised and can reach the model as an unprotected fragment in plain text; ids and facts are never cut. The bundled browser side cuts labels the same way, which does not change this: keep personal data out of labels over 60 characters, or set `viewContext: false`. `history` must be `'none'` for now; an invalid option throws at creation |
| `uiActionSchema` | schema that validates the `uiAction` of tool results |
| `uiActionOutcomes` | `UiActionOutcomesOption`: a `UiActionOutcomeMode` (`'confirm'` default, `'report-only'`, `'off'`) or `(toolName) => mode`. For a client that sends `glirastesUiOutcomes: 1` (`UI_OUTCOMES_REQUEST_FIELD`) a UI result handing a `glirastes.*` action off carries `awaitsOutcome` and the request ends after that step; the browser writes `outcome` and resends, and the model reads the fixed text per code (`UI_OUTCOME_MODEL_TEXTS`, `readUiOutcomeCode`, `uiOutcomeModelResult`; one fixed `UI_OUTCOME_SYSTEM_NOTE`). At most `MAX_UI_OUTCOME_CONTINUATIONS` (3) per turn, so up to four times the per-request budgets. Custom `streamHandler`s get no marker; `withModelFacingUiOutcomes` replaces the reported results for one that converts messages itself (`prepareModelMessages` does it). See `docs/ui-action-outcomes.md` |
| `uiToolResultShape` | `UiToolResultShapeOption` (`'auto'` or a `UiToolResultShape`, the option of `toolsToAiTools` has the default `'legacy'`): `'auto'` (default) by the request flag `glirastesUiOutcomes: 1`: with it `{ handedOff: true, message, uiAction }` without `success`, without it the 0.17.3 `{ success: true, … }` (a 0.17 browser runs an action only with `success: true`); `'handoff'` / `'legacy'` force one shape for every request (also direct commands, custom `streamHandler`) |

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
| `toolMiddleware` | `ToolMiddleware[]` (`(call, next)`, `ToolMiddlewareCall`, `ToolMiddlewareNext`) around the execution of the app's own tools, after every guard, approval and budget check; logging, metrics, tenant context, error mapping; a throw is a tool error, `next` runs at most once, `call.input` is a copy, approval subject lookups run through it as read calls (`readOnly: true`, the approval's `toolCallId`), built-ins bypass it; see `docs/chat-route-security.md` ("Tool middleware") |
| `classifyToolFailure` | `ToolFailureClassifier`: gets `ToolFailureInfo` (`toolName`, HTTP `status`, full parsed `body`) of a failed backend call and returns a `ToolFailureClassification`, `'expected'` or `'error'`; expected failures skip `maxConsecutiveErrors` and metric errors, counted locally only; never applies to managed-guard denials, which always count as errors; also on `createGlirastes`; not in the runtime container |
| `onFinish` | steps, finish reason, token usage, truncation, `StepLimitSource` and the local `expectedToolFailureCount`; once per request, with `continuation: 'approval' \| 'ui-outcome' \| 'budget'` for a request that continued a turn (`'budget'`: the chat's "Continue" after a stop notice) and `awaitingUiOutcome: true` for one that ended to wait for a UI outcome |
| `emitStepReports` | `data-step-report` stream parts (default on) |
| `onStepReport` | one `PipelineStepReport` per step |
| `onModelInput` | opt-in local debug hook: before every model step a `ModelInputEvent` (`stepNumber`, the step's `messages`, `system`, `estimatedTokens`, `breakdown`: a `ModelInputBreakdown` with each earlier turn's `HistoryTurnMode` `compacted` / `text` / `left-out`, the memo and `unresolvedMentionMarkers`, the count of assistant mention markers no declared record or user `@` mention carries, which the chat shows as plain text). CARRIES CONTENT (prompts, tool results, ids, names): keep it out of production logs; never sent to the stream, the browser or the Platform; server config only. Built-in stream handler only (custom ones pass `onBreakdown` / `earlierMessages` to `prepareModelMessages`); not in the runtime container |
| `onPipelineResult` | intent, module, model and tools chosen by `pipeline` |
| `onAudit` | `AuditEmitter` for all audit events; forward to logs or a SIEM |
| `metrics` | content-free turn metrics, e.g. from `createGlirastes(...).chatTurn()`; a continuation is a `turn.continued` event (`TurnContinuedEvent`, `TurnContinuedEventSchema`, `TurnContinuation`, `TurnContinuationSchema`) instead of `turn.finished` (a `'budget'` continuation is a normal `turn.finished`), in batches of its own, with an opaque `turnId` (HMAC keyed by the approval secret, never the client's message id) shared by every continuation of the turn |
| `modelPricing` | price table for providers that report no cost |

### Counting turns in onFinish

`onFinish` fires once per request, not once per turn. A turn with a UI tool
takes at least two requests when the browser reports UI outcomes (the
default): a request that ends with `awaitingUiOutcome: true` is followed by
one with `continuation: 'ui-outcome'`, once per reported step, at most
`MAX_UI_OUTCOME_CONTINUATIONS` (3) per turn. Each answered approval adds a
request with `continuation: 'approval'`, also mixed with UI outcomes. Count a turn on the request without
`continuation`, and add tokens and steps of every request to it:

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

`onFinish` carries no turn id; the content-free `metrics` events do
(`turnId` on `turn.continued`).

### Order of parts at the end of the stream

Since 0.18.1 the order is fixed (0.17.x and the 0.18.0 image: timing-dependent):

- A `data-step-report` comes right before the `finish-step` of its step, after
  every chunk of that step, a `tool-approval-request` included.
- The final `data-pipeline-state` comes right before `finish` (or `abort`), so
  the terminal part is last among these.
- Exception: a chat memory summary (`data-memory-summary`, `memory.chat`) whose
  model call ends after the answer arrives after `finish`; `finish` does not
  wait for it. A custom client reads until the stream closes and does not stop
  at `finish`. The packaged React chat uses the AI SDK `useChat`, which reads
  the response to its end and does not act on `finish`.

## Legacy and Pro

| Key | What it does |
| --- | --- |
| `pipeline` | Pro `AiPipeline` from `glirastes/server`; replaces guardrails and intent router routing |
| `followups` | follow-up suggestions; needs `pipeline` (without it no `suggest_followups` tool, a warning at creation) |
| `intentRouter` | deprecated; use `pipeline` |
| `telemetry` | legacy remote sink; refused together with `managedRuntime` (use `metrics`) |
| `lancer` | legacy prompt and model overrides; not on the Foundation path |
| `modelDefaults` | model ids per tier reported with `lancer` |
| `modelInstanceFactory` | turns a model id into a model instance for `lancer` overrides |
