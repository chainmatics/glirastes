# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `maxResultChars` on `createAiChatHandler` (model turns and direct commands), `createGlirastes` (handed on by `chatTurn()`), `ToolToAiToolOptions` and the runtime container (`application.maxResultChars`): the upper bound of a serialized successful tool result the model sees, an integer from 1,000 to 200,000, default 16,000. An invalid value throws when the handler or the instance is created (the container: when the config is parsed). New exports from `glirastes/server`: `DEFAULT_MAX_RESULT_CHARS`, `MIN_MAX_RESULT_CHARS`, `MAX_MAX_RESULT_CHARS`, `isValidMaxResultChars`, `assertMaxResultChars`, `PAGINATION_PARAMETER_NAMES` and the types `TruncateToolResultOptions` and `TruncatedMarker`.
- Per tool: `maxResultChars` on `Tool`, `defineTool` and `AiEndpointToolDefinition` (forwarded by `endpointToolToTool`, which throws on an invalid value), the OpenAPI operation extension `x-glirastes-max-result-chars` and `maxResultChars` in a sibling `contract.ts` entry (`next-app` and `nest` sources). The tool value wins over the global one, the global one over the default. The generator writes it to `.glirastes/tool-contracts.json` (optional field, absent otherwise, so existing outputs stay byte-identical) and into the generated `endpointToolToTool({ ... })` call; the runtime container applies it from the artifact. It is never sent to the Platform. An invalid value is reported as `max-result-chars-invalid` (warning, an app-code item of `glirastes tools resolve --print`; the message does not repeat the value) and ignored.
- Turn-scoped result handles and the built-in tool `read_result` (`createAiChatHandler`, on by default, `resultHandles`). A successful record result of a model turn over its `maxResultChars` is kept in full for the running request, and the model gets an overview instead of a cut result: every entry of the largest array with its small fields, entries reduced only when the small fields alone do not fit, plus `_result.id` (`ro_…` after a read tool, `rw_…` otherwise, random per handle). Fields are left out by the value they carry, measured in the data across all entries: nested arrays and objects, foreign keys (`folderId`, `tenant_id`, `ownerID`; not `VALID`), UUID/hex/token ids, URLs and long texts first, then other strings (dates, names), last booleans, numbers, null and short enum-like labels (few distinct values, e.g. a status); in the last two classes nested fields before an entry's own fields (an entry's status outlasts a number inside a nested object), then within each class the largest first. An entry's own identity (`id`, `uuid`, `key`, `slug`, `code`, `name`, `title`, `label`, `displayName`) stays; foreign keys are no longer protected. Left-out fields are named with their approximate size in `_result.omitted` (largest first, each a valid `read_result` path that reads exactly that data; a field whose key is empty or contains `.`, `[` or `]`, or whose path exceeds 120 characters, is only counted in `omittedMore`, and the hint says to read it with its parent); a nested object whose fields were all left out is removed instead of staying as `{}` and listed once by its own path with `keys` (up to eight of its direct child keys, largest first, each readable as `path.key`; keys a path cannot name or longer than 64 characters left out; `keysMore` counts the rest; given up before any field when space is short), an object that was empty in the data stays. The overview hint says not to infer a missing field from other fields. `read_result({ resultId, fields?, offset?, limit? })` reads omitted fields or further entries (paths such as `data[].name`, `data[].owner.name`, `meta`, and `data[2].items` for one entry) within the origin tool's limit and never calls the backend again, so a write tool runs once. An index selects one element, returned as an object keyed by the index (`data: { "2": { items: [...] } }`); the outermost arrays inside it are paged by `offset`/`limit`. `[]` and `[n]` on the same array in one call are refused with `invalid_fields`; an index beyond the array answers `index_out_of_range` with the valid range. Errors are tool results: `result_expired` (with the instruction for a read or a write origin), `invalid_fields` (naming the accepted forms and `offset`/`limit`), `unknown_fields`, `index_out_of_range`, `result_denied`, `budget_exhausted`. An incomplete answer (`nextOffset`, or an entry cut to fit) carries `_result.hint`, which starts with `Incomplete:`: the entry range it holds and that the total is exact, to call again with the same resultId and fields and `offset = nextOffset`, and to say nothing about the content of all entries before the rest is read; the hint counts against the limit and outranks entries. A cut entry's `_truncated` only names what was cut (no second hint); an entry that does not fit even cut answers `_result` alone with `returned: 0`, the `nextOffset` past it and a short `Incomplete:` hint. A complete answer carries no hint unless a requested field does not exist. Unknown paths are listed in `unknownFields` (at most ten) by their normalized form, re-formatted from the parsed steps when every field name is an identifier (`[A-Za-z_$][A-Za-z0-9_$]{0,63}`) without a run of three or more digits and the path has at most 120 characters, otherwise by position; `parentKeys` names the nearest existing parent of up to three of them with up to twelve identifier-like keys found there (only when it fits next to the full page); only `unknownCount` when space is short; the hint then says those fields do not exist in this result and must not be inferred. A read in which no requested field exists answers the error `unknown_fields` with the same details. One `offset`/`limit` window pages every outermost selected array; `returned`, `total` and `nextOffset` follow the paged array with the most entries, `arrays` lists `{ returned, total }` per array. In a managed turn a read that reads nothing (unknown id, invalid fields, another principal's handle, an index out of range, only unknown fields) counts as a tool call and an error. The arguments of `read_result` are never rehydrated by the PII shield, and an answer echoes nothing the model wrote but field names of a path that parsed which are identifiers without a run of three or more digits (the same filter applies to `parentKeys`). Every pseudonym the built-in generators make contains a space or punctuation, or a run of three or more digits, so none can occur in an echoed name, not even inside it, and `inbound` finds nothing there to rehydrate. A payload with its own `_result` key gets no handle. A request holds up to `maxTotalBytes` of JSON per turn (more in the heap). In a managed turn every read runs the origin tool's guard (budget, freshly resolved principal, pinned snapshot, revocations; recorded for loop detection) and a handle answers only the subject and tenant it was created for: the principal captured before the origin tool runs, still the same when the result is stored (otherwise no handle, the result is cut). With `piiShield` the complete result is pseudonymized once when it is stored; overview and reads are cut from that copy and are not shielded again. Limits per turn: 8 handles, 2 MiB per result, 16 MiB in total (`resultHandles: { maxResults, maxResultBytes, maxTotalBytes }`); beyond them, with `resultHandles: false` (container: `application.resultHandles: false`), for direct commands and without a `resultStore`, results are cut as before. A handle does not survive the request: an approval continuation or a later turn answers `result_expired`. New exports from `glirastes/server`: `createResultStore`, `createReadResultTool`, `DEFAULT_RESULT_HANDLE_LIMITS`, `READ_RESULT_TOOL_NAME` and the types `ResultStore`, `ResultStoreOptions`, `ResultHandle`, `ResultHandleLimits`, `ReadResultGuard`; `ToolToAiToolOptions.resultStore`; `TruncateToolResultOptions.nextStep`.
- `truncateToolResult(result, maxChars?, options?)` takes an optional third argument: `readOnly` and the tool's `inputSchema` (or explicit `paginationParams`) for the hint. `toolToAiTool` sets `readOnly` for GET and HEAD endpoint tools and for tools without a method that need no approval.
- `glirastes connect --dotenv <path>`: writes `GLIRASTES_API_KEY` to a file inside the project that Git ignores and does not track (checked by the real on-disk name, so a differently cased alias of a tracked file is refused; nested `.gitignore` files and negations count; outside any repository the file is accepted; an unreadable repository stops with `E-CONNECT-GIT-UNAVAILABLE`). Only the key line is replaced or appended (plus `GLIRASTES_CONTROL_PLANE_URL` for a self-hosted Platform); other variables, comments, blank lines, line endings and the final newline stay byte-identical, and an existing file keeps its permission bits (a 0644 file then holds the key world-readable; use 0600). A new file and `.env.local` are 0600. The file is replaced atomically, so owner, ACLs and hard links are not preserved. Obsolete connection variables stay for `doctor` to report. A URL line naming another Platform (`E-CONNECT-ENV-PLANE-CONFLICT`) or a connection variable inside a multi-line quoted value (`E-CONNECT-ENV-UNSUPPORTED`) stops connect before pairing. `glirastes sync`, `glirastes doctor`, `glirastes setup --managed` and `glirastes setup sync` take `--dotenv` too.
- Finding `semantics-entry-orphaned` (warning): a `.glirastes/tool-semantics.json` entry whose `stableKey` or `name` matches no tool (after a path, method or name change) was dropped silently; it is now reported once per entry, by its `stableKey` or as `.glirastes/tool-semantics.json#<name>`, never with its text. For a stableKey entry the message names the tool that now holds the operation's earlier name, when there is one. An entry for an excluded operation is not reported; an entry used through its `name` is not reported. `glirastes tools resolve --print` lists it as a `tool-semantics.json` item. It is a warning, so neither `tools check` nor `--strict` fails on it; an app with such entries sees one `tool-outputs-drift` on `tool-report.json` after upgrading until it runs `glirastes tools refresh`. It stays local (no tool, so not in the setup artifact's warnings).
- Docs: "What the model sees when" (`docs/tool-policy.md`, `describing-glirastes-tools`): `usageHints` reach the model only in `find_tools` results, `synonyms` and `examples` never; fewer than 3 examples per language reject the whole semantics entry.
- CLI value flags accept `--flag=value` as well as `--flag value`; `--dotenv` given twice is refused (`E-SETUP-032`).
- The secret file flag is `--dotenv`, not `--env-file`: Node.js 20+ reads `--env-file` itself even after the script name. A missing file makes Node.js exit 9 (`node: <path>: not found`) before glirastes runs, which glirastes cannot catch; with an existing file Node.js loads it into the process, and `connect`, `sync`, `doctor` and `setup` stop with `E-SETUP-033` before reading or pairing anything.
- A secret file directory without write permission (or on a read-only filesystem) stops connect before pairing with `E-CONNECT-PATH-NOT-WRITABLE` instead of `E-CONNECT-STAGING-NOT-IGNORED`.
- When `GIT_DIR` or `GIT_WORK_TREE` are set (yadm/vcsh dotfile repositories), connect also asks Git with that unmodified environment and refuses a file tracked there (`E-CONNECT-SECRET-TRACKED`); a `GIT_DIR` Git cannot open, or one without a work tree, stops with `E-CONNECT-GIT-UNAVAILABLE` (remediation `fix-or-unset-git-dir`).
- `connection.envFile` in `.glirastes/tools.json`: the default env file of `connect`, `sync` and `doctor`; the flag wins. The schema checks only its shape; the path itself is validated by the connect commands (`E-CONNECT-PATH-OUTSIDE`, ...), so a wrong path never breaks the tools commands. Older SDK versions reject the unknown key (`E-TOOLS-002`).
- `glirastes connect --json` reports `secretTarget` (`"file"` with `envFile`, or `"output"` with `apiKey` and, for a self-hosted Platform, `controlPlaneUrl`).

### Changed

- Tool result truncation is a true upper bound: after it, `JSON.stringify(result).length <= maxChars` holds for every successful record result. It cuts the array with the largest serialized size at any depth reached through object properties (`data.items`, no longer only the top-level array with the most elements), keeps sibling fields such as `meta`, compacts a single entry larger than the limit (long strings clipped, nested objects and arrays replaced by placeholders) or keeps no entry, and clips or replaces the largest fields of an oversized result without such an array (as a last resort keeping only the leading top-level fields that fit). Fields whose key alone exceeds 120 characters are left out and counted in `omittedKeys`. `success` and `uiAction` are never altered; the only remaining exception to the bound is a `uiAction` that is itself larger than the limit. Linear in the result size: an 8 MB result is cut in well under a second, and the input is never modified. A root array that has to be cut is returned as `{ data: [...], _truncated }`. Failure results are untouched, as before. Results within the limit are unchanged.
- The `_truncated` marker keeps `field` (now a dot path), `showing` and `total` when an array was cut, and adds `compacted` (up to five changed paths), `omittedKeys` and `hint`. For a read tool the hint tells the model to say "showing N of M" and offer filtering or the next page, naming the tool's paging parameters (`page`, `limit`, `offset`, `cursor`, `pageSize`, `per_page`, `skip`, `take`) when its input has them. For any other tool it says the tool has already run and must not be called again just to see more, and that the user is told the result was shortened. A result cut without an array carries no `field`, `showing` or `total`.
- Loop detection leaves the random `_result.id` of a result handle out of a tool result's fingerprint (`toolResultForFingerprint`), so the same call with the same result still counts as a repetition.
- `read_result` is a handler built-in like `find_tools`: always offered next to a tool selection, never indexed by `find_tools`, hidden from the activity list. A registry tool named `read_result` stays a domain tool; such a turn keeps no handles and cuts large results as before, and, like every built-in name, it is not indexed by `find_tools` in a turn without `managedRuntime`.
- Docs: `allowedOrigins` is mandatory when the chat UI runs on another origin than the handler (e.g. a NestJS API with Bearer tokens); an unlisted origin gets `403 cross_origin_request_refused` (`docs/chat-route-security.md`, `integrating-glirastes-web`).
- `glirastes connect` pairs apps of every source (NestJS, OpenAPI, ...), not only Next.js; `E-CONNECT-FRAMEWORK-UNSUPPORTED` is gone. Next.js is detected from a `next-*` source in `tools.json` or a `next` dependency in `package.json`. Without `--dotenv` a non-Next.js app gets no secret file: on a terminal the key is shown once to set as `GLIRASTES_API_KEY` in the server's environment; without a terminal connect refuses before pairing (`E-CONNECT-SECRET-OUTPUT-REFUSED`) unless `--dotenv` or `--json` is given (the guard checks stdout only; agents in a pseudo-terminal must use `--dotenv`). `.glirastes/platform-connection.json` is written in every case. Next.js keeps `.env.local`.
- All checks of the secret file (path inside the project, directory, Git ignore and tracking, duplicate variables) run before pairing, so no key is issued that cannot be stored. Staged copies and backups of the secret live in a private 0700 directory inside the owning repository's git dir, else under the temporary directory when it is outside the project and in no Git work tree (or Git ignores the staging directory there), else beside the file only when Git ignores the staging names (otherwise `E-CONNECT-STAGING-NOT-IGNORED` before pairing); a rename probe proves the same filesystem before pairing. The secret file is written before `.glirastes/platform-connection.json`. A kill during the write leaves the key at most in that private directory (0600), never in a path Git would add, and never a connection without its key (also for `.env.local`); a rollback renames the backup into place. A failure to store after the key was issued reports `E-CONNECT-SECRET-NOT-STORED` (run connect again and revoke the unused key; the key is never printed). Reads (`sync`, `doctor`) never stage. Git checks run in the file's own repository (nested repositories, submodules) with `GIT_DIR`, `GIT_WORK_TREE` and the other repository-selecting variables removed from their environment, and fold letter case Unicode-aware against the tracked names of the file's directory. An unignored custom file reports `E-CONNECT-SECRET-TRACKED` with remediation `ignore-connection-env-file`.
- `glirastes sync` and `glirastes doctor` no longer send a non-Next.js app to `.env.local`: without `--dotenv` they read the process environment only, and a missing key names `GLIRASTES_API_KEY` and `--dotenv` (`E-SYNC-CREDENTIAL-MISSING`, doctor remediation `provide-connection-api-key`).
- `docs/managed-runtime-sync.md` documents what a deployed app needs. The embedded runtime reads no `.glirastes/` file at run time; `GLIRASTES_API_KEY`, `GLIRASTES_ENVIRONMENT` and, for a self-hosted Platform, `GLIRASTES_CONTROL_PLANE_URL` are enough.
- `openapi` source (3.0 and 3.1, also the runtime container build): the `description` of a path or query parameter becomes the `description` of that input property, so the model reads it (e.g. "Omit to get all playlists" on an optional `limit`). It wins over a `description` inside the parameter's `schema`, which stays when the parameter has none; `$ref` parameters and schemas are covered, and a shared component schema is not changed. A blank description counts as none. Header and cookie parameters remain no tool input; `example`, `examples` and `deprecated` on the parameter are still not passed on. No length limit is applied (as for request-body property descriptions).
- `openapi` source: an operation whose success responses declare `204` and no `content` (and no other 2xx response with content) gets the output contract `{ type: 'object', properties: { success: { const: true } }, required: ['success'], additionalProperties: false }` with the description "No content: success means the action was executed; there is no result data." This is what the runtime returns for an empty response. `output-contract-opaque` is no longer reported for it. A `200`/`201` without `content` alone (what @nestjs/swagger writes for a handler without a response decorator), only `default`, or no responses keep the finding; NestJS declares `@HttpCode(204)` and `@ApiNoContentResponse()`.
- Upgrade note for both changes: for operations with parameter descriptions or a body-less `204`, `glirastes tools check` fails with `tool-outputs-drift` after the upgrade (`tools.generated.ts`, `tool-contracts.json`, `foundation-execution-inventory.json`, `setup-artifact.json`, `setup-receipt.json`, `tool-report.json`, `build/runtime-manifest.json`) until `glirastes tools refresh` is run and the diff is committed. Only those tools' `inputSchemaDigest` (descriptions) or `outputSchemaDigest` (204) change, plus the setup artifact's ids, `discoveryDigest` and `warnings`; `toolId`, `sourceFingerprint` and `interfaceDigest` stay, and every other tool stays byte-identical. Connected apps run `glirastes sync` and accept the new deployment: until then the signed manifest still pins the old digest, and the local binding of those tools is rejected as `E-BINDING-011` (input/output schema digest mismatch). The Platform receives only the changed digests, as before; parameter descriptions and schemas are never sent. A container artifact is rebuilt with `glirastes-runtime build`.

## [0.16.0] - 2026-11-17

### Added

- Chat memory on `createAiChatHandler` through `memory` (Next.js adapter). Three independent parts:
  - **Chat summary** (`memory.chat`, on by default once `memory` is set): when the estimated tokens of the conversation history pass the auto-compact threshold, the turns before the last one fold into a running summary written by `memory.model` (default: the chat model) in parallel with the answer. The summary travels as a persisted `data-memory-summary` part of the assistant message, so it needs no storage of its own and survives reloads with the chat. A summary covers only messages it read in full: long messages are read in several calls, at most about 48000 characters are folded per turn and the rest stays verbatim until a later turn, and a failing call keeps what the calls before it covered. The threshold is `memory.chat.autoCompact`, else the environment variable `GLIRASTES_AUTOCOMPACT`, else 8000 tokens and at most 30 % of the model's context window; a value up to `1` is a share of the context window, a larger one a token count, `off` disables. `contextWindowOf(model)` knows common model families; `memory.chat.contextWindow` overrides.
  - **User notes** (`memory.user`): short notes every chat of one user sees, kept in the browser (`true`, with `createLocalMemoryStore` on `useVercelAiChatTransport({ memory })`) or in the app's database (`{ store }`).
  - **Shared notes** (`memory.shared: { store }`): notes every user of one workspace sees. Writing them asks for confirmation by default (`approval`) and can be limited with `canWrite(request)`.
- Built-in tools `memory_remember({ note, scope })` and `memory_forget({ id, note })`, offered only when a note scope is writable. A note that a parallel request pushed beyond the limit is taken back. `memory_forget` refuses a `note` text that is not the note's, so a confirmation card shows what is removed.
- `MemoryStore` (`list`, `add`, `remove`), `createInMemoryMemoryStore()` and `verifyMemoryStore(store, { authorId?, keys? })`, a contract check to run against the real database (`keys` for a store that only accepts the keys of a real user and workspace). `memory.scope(request)` supplies the user and workspace keys from the verified session; a store without `scope` is a configuration error.
- Skill `setting-up-glirastes-memory` (part of the setup skills, referenced from `setting-up-glirastes`): asks which parts and which storage, and carries a generic SQL schema, store templates for Drizzle, Prisma and plain SQL and the store test.

### Changed

- With `memory` set, the history is no longer cut at `maxContextMessages` and `history.maxTurns`; the auto-compact threshold bounds it. Notes and summary reach the model as a `<memory>` block in a user-role message ahead of the conversation, marked as context that is not an instruction, and pass the PII shield like messages. Handlers without `memory` behave as before.

## [0.15.0] - 2026-11-16

### Added

- `classifyToolFailure({ toolName, status, body })` on `createAiChatHandler` and `createGlirastes` (handed on by `chatTurn()`): a failed backend call classified as `'expected'` (e.g. a 403 for a user without the role) neither counts toward nor resets `maxConsecutiveErrors` and is no tool error in the turn metrics. It is counted locally only, as `expectedToolFailureCount` in `onFinish`; the Platform metric event is unchanged. Direct commands are classified too but never call `onFinish`, so their expected failures are not counted. Not configurable in the runtime container yet. New types `ToolFailureClassifier`, `ToolFailureClassification` and `ToolFailureInfo` from `glirastes/server` and `glirastes/runtime`.
- `InternalApiResponse.refusedLocally` marks the local refusals of `createHttpEndpointCaller`, which are never classified.
- The `openapi` tool source and the runtime container build read OpenAPI 3.0.x JSON exports (what `@nestjs/swagger` writes) in addition to 3.1.x. A 3.0 document is normalized to the 3.1 / JSON Schema shape on load: `nullable: true` becomes `type: [T, 'null']` (with `null` added to a closed `enum`) or, next to `$ref`/`allOf`/`oneOf`/`anyOf`/`not`, an `anyOf` with `{ type: 'null' }`; boolean `exclusiveMinimum`/`exclusiveMaximum` become numeric bounds. Payloads such as `example` and `default` are untouched, and 3.1 documents are read exactly as before. YAML, Swagger 2.0 and OpenAPI 3.2 are still rejected (the message names a Swagger or unsupported OpenAPI version); multipart bodies stay excluded as `unsupported-body`; the container still rejects nullable parameters.
- The `openapi` tool source takes `selection: "all" | "opt-in"` (default `all`, unchanged output). With `opt-in` only operations marked `x-glirastes-tool: true` become tools; every other operation is excluded as `not-opted-in` without findings, and `x-glirastes-tool: false` excludes as `opted-out` in both modes. Existing exclusions (unsupported method, path or body, default rules, policy excludes, `x-glirastes-ignore`) keep precedence and their reason; a marked operation they exclude is reported as `opt-in-excluded`, a non-boolean marker as `tool-marker-invalid`; `glirastes tools resolve --print` lists both as app-code items pointing at the OpenAPI document, also when the operation is no tool. The runtime container build applies the same selection, so it validates only the selected operations. `glirastes tools refresh` prints the `not-opted-in` operations as one counted line.
- OpenAPI operation extensions `x-glirastes-name` (tool name; wins over derived and previously kept names, a rename keeps policy, resolutions and tool ids because they are keyed on `METHOD /path`; `tool-semantics.json` entries matched by `name` do not follow it), `x-glirastes-group` (module, highest priority; invalid: `tool-group-invalid`) and `x-glirastes-roles` (code default of `allowedRoles`, any-of; `tool-policy.json` and the Platform only narrow it, a disjoint intersection disables the tool and is reported as `policy-roles-disjoint`, a warning naming the tool and both role sets, a developer item in `glirastes tools resolve --print`; an invalid value is `tool-roles-invalid` and keeps the tool disabled). See `docs/tool-policy.md`.

### Changed

- In the `openapi` source, a tool name without a dot (for example `list_tags` from `x-glirastes-name`) takes its module and its template label resource from the endpoint path instead of the name, so the module is not the name itself and labels read "Tags ändern" / "Update tags" instead of repeating the verb. Dotted names, UI tools and every other source (`next-app`, `nest`, contract modules: a contract id such as `listTags` keeps module `listTags` and its label) are unchanged. The `definition-id-invalid` and `definition-id-conflict` messages name the extension (`x-glirastes-name`) when it declared the name.
- An explicit tool name (contract id or `x-glirastes-name`) that takes the name another existing tool held in the previous inventory is reported as `definition-id-reassigned` (warning, naming both operations, in the refresh output and in `glirastes tools resolve --print`). Who gets the name is unchanged; the earlier holder was renamed silently before, and `tool-semantics.json` entries matched by that name re-point to the new holder. The finding is relative to the previous inventory and never written to committed outputs.
- The result of an endpoint tool whose backend call fails now carries the HTTP `status` and the response `body` (cut to at most 4000 characters, then with `bodyTruncated: true`) next to `success: false`, `error` and `retryable`, so the model can tell a 403 from a 500. The cut of the body, and the cut of `error` at 1000 characters, moves back up to 256 characters to the last whitespace or JSON delimiter and so ends on a whole token: a single-token value such as an email address stays whole, a value written with spaces (an IBAN in groups, a phone number) can still be cut. The body goes through a configured PII shield like any tool result. Without `classifyToolFailure` errors count exactly as before. Loop detection fingerprints such a failure by `success`, `status`, `retryable` and `expectedFailure` only, without `error`, `body` and `bodyTruncated`, so a timestamp or trace id in the backend's error text does not hide a repeated failing call from the repeated-fingerprint limit. A failure without a `status` keeps its `error` in the fingerprint.
- **Behaviour change:** a managed turn (`managedRuntime`, also through `createGlirastes().chatTurn()` and the runtime container) now hands the model only the tools the current principal may use: the handler's own built-ins plus the manifest tools that the tool-call guard's decision allows for the pinned revisions with the principal and revocations of the request. Until now every registry tool reached the model with name, description and input schema, and only the guard refused the call. With and without `toolDiscovery`, in the pipeline and the legacy path; a custom `streamHandler` gets the same reduced `tools`, and a legacy `intentRouter` gets only these tool names as its second argument. Only these are reduced. What the handler passes to the app's own code stays unfiltered server-side app data, and an app that forwards it to a model names tools the principal may not use: `routing` and `pipelineResult` (`model` and `systemPrompt` callbacks, `onPipelineResult`, a custom `streamHandler`; they carry the tool names of the app's own `pipeline` modules and router result), `turnSnapshot` with the whole pinned manifest (`systemPrompt` callback, the endpoint tool context of `loadTools` and of every tool's `execute`) and `managedTurn.snapshot` (custom `streamHandler`). A registry tool that is not in the pinned manifest is no longer handed over either (the guard always refused it). An approved call whose tool the principal may no longer use still ends as a tool error; for that request the tool stays in the set as a stub (its name, a neutral description, an input schema that accepts any object). To get the previous tool set, pass `authorizedToolsOnly: false` to `createAiChatHandler`; the guard decides every call either way. The tool set of turns without `managedRuntime` is unchanged.
- The tool set of a managed turn is decided at the start of the request and narrowed before every model step with a freshly resolved principal and freshly loaded revocations (the sources of the tool-call guard), so `resolvePrincipal` and `loadRevocations` now also run once per model step and per `find_tools` search. A custom `streamHandler` gets this check as `authorizedToolNames` in its context; `createHybridToolDiscovery` takes it as the optional `currentlyAuthorized`.

### Fixed

- `glirastes tools refresh` names an OpenAPI operation whose schema the runtime JSON Schema validator cannot compile (`schema-uncompilable`, with the validator's reason) instead of failing with a bare `E-SETUP-999: Glirastes command failed.`
- With a legacy `intentRouter`, the tool of an approval verified for the request stays in the tool set even when the router of the answering request selects other tools, so the approved call runs (or, when the principal may no longer use the tool, ends as a tool error) instead of being dropped without a result. This also applies without `managedRuntime`; the pipeline path already behaved this way.
- Tool discovery (the initial active tools and `find_tools` results) and the tool labels of the `data-tool-presentation` part follow the principal and the revocations as of the start of the request, with the same decision the tool-call guard uses. The presentation part names only tools the principal may use.
- Within a multi-step request, a role lost or a revocation loaded after the request started takes effect for the next model step and the next `find_tools` search, not only for the next tool call: `find_tools` neither returns nor activates such a tool, and it leaves the active tools. When the principal cannot be resolved any more, only the handler's built-ins stay offered.
- A turn snapshot reused for a later request of the same turn keeps its pinned revisions, budget, prompt revision and start time, and carries the principal resolved for that request, so role changes take effect for discovery and for `turnSnapshot` in `systemPrompt` and tool loading. Approval scope (tenant and subject) is unchanged.
- In a managed turn, a tool call the managed guard denies with `principal_role_denied`, `policy_tool_denied`, `agent_tool_denied` or `manifest_tool_unavailable` no longer ends the turn with a stream error. The model receives a tool error `Tool execution denied: <reason> (<tool>)` and the turn continues; the call never executes and never asks for approval. Such a denial always counts as a tool call and toward `maxConsecutiveErrors`, is never classified by `classifyToolFailure`, and counts as a tool error in the turn metrics (the metric event is unchanged). With the default `authorizedToolsOnly` the guard is reached only for a tool that was offered at the start of the request and is denied later in it (in practice a role lost mid-request, `principal_role_denied`); with `authorizedToolsOnly: false` it is reached for every call, including a registered tool that tool discovery does not advertise. A call to a tool that was never offered does not reach the guard: the AI SDK answers it as an unavailable tool (a tool error that names only the offered tools), the turn continues, nothing executes and no approval is requested. Such a call counts as a tool call and a tool error in the turn metrics, but not toward `maxToolCalls` or `maxConsecutiveErrors`; a model that repeats it stops at `maxModelSteps` (or the token, cost or time budget). `revoked`, `missing_principal`, `tenant_mismatch` and `budget_exhausted` behave as before; whenever the guard is reached, a missing principal, a tenant mismatch and a current revocation (agent revision, policy revision or tool) are checked before any recoverable reason and for every tool name, so they always end the turn. The guard throws a typed `ToolExecutionDeniedError` (`reason`, `toolName`, `recoverable`, exported from `glirastes/runtime`) with the same message as before.

## [0.14.0] - 2026-11-15

### Added

- Configured Node runtime container V1 for non-Node HTTP backends: JSON configuration, generator-built data-only artifacts, backend-verified identities, persistent PostgreSQL approvals and a single-active-instance guard. Includes a PHP reference, browser/container acceptance and versioned GHCR publication gated before npm release.
- `glirastes-runtime` build/validate/serve/healthcheck commands and the framework-neutral `glirastes/server/http` alias.
- Runnable Angular, SvelteKit and Nuxt frontend references with production-build browser acceptance, plus packaged setup/UI/integration skill guidance for the runtime and non-React hosts.

### Fixed

- Request and tool-timeout cancellation reaches model streams and backend HTTP calls. HTTP endpoint callers reject redirects by default, limit responses and support explicit API path boundaries.
- Output-schema diagnostics omit backend values and schema issue paths from logs.
- Skill installation supplies generic integration guidance for unknown/non-Node stacks without claiming framework detection.

## [0.13.1] - 2026-11-15

### Fixed

- Approval continuations retain the original assistant message ID, so completed tool calls are not duplicated and later turns still pass history validation. Browser-stored histories from older versions recover matching adjacent continuation snapshots without changing server approval validation or repairing conflicting calls.
- Local chat stores remember the selected session across reloads, including empty chats. New chats keep automatic first-message titles instead of treating the placeholder as a custom title.
- Generated client actions retain their optional app route through UI-action validation, allowing dialogs on other pages to open through the browser bridge.

## [0.13.0] - 2026-11-15

### Added

- Environment chains for the managed tool job: `enrich.environments` in `.glirastes/tools.json` (lowest first, any names and length, e.g. `["pre-dev", "dev", "staging", "master"]`), overridden by `GLIRASTES_ENVIRONMENT_BRANCHES` or `glirastes tools enrich --environments`. Without it the job detects the usual environment names that exist on origin. A promotion (a head branch that is an environment branch, or a head commit another environment branch already holds, such as a release branch cut from one) ends at once with `promotion from <branch>, nothing to enrich` and changes nothing.
- `glirastes tools enrich --head <branch>`; `--base` and `--head` also come from `GLIRASTES_BASE_BRANCH` / `GLIRASTES_HEAD_BRANCH` (then `GITHUB_BASE_REF`).
- `glirastes init --ci github` checks out the full history for the enrich job, passes base, head and `vars.GLIRASTES_ENVIRONMENT_BRANCHES` on every trigger, and skips pushes whose commit carries the bot marker. Regenerate the workflow with `glirastes init --ci github --force` to pick it up.

### Fixed

- The managed job works only tools whose semantics are missing, stale or rejected (a first run also takes the schema backlog), no longer every tool whose contract differs from the base branch. A pull request from staging into master re-described tools that were already current.
- The model's files are proposals: entries of tools outside the scope, fields written by a person, supplied by the code or locked by a review, and agent fields written for the current interface keep their stored value byte for byte; only a missing language may be added to a current agent field. The job sets `origin`, `agent.model` and `agent.interfaceDigest` itself, so an invented origin (`origin.module: "tasks"`) or unknown field never reaches the file. Curated synonyms and examples were replaced before.
- Before it commits, the job regenerates the outputs with the refresh pipeline, takes back entries the generator rejects, and verifies with the `tools check` pipeline; it refuses a commit that removes or adds tools or changes the `tool-contracts.json` entry of a tool outside the scope (`contracts_out_of_scope`, `check_failed`, `rejected_entries`), and restores the agent files. Bot commits failed `tools check` with `tool-outputs-drift` and `resolution-rejected` before.
- Sandbox writes are atomic (written beside, then renamed): a refresh running alongside a task no longer reads half a `tool-semantics.json`, ignores all semantics and renders outputs without any synonyms or titles.
- One commit per job, after all tasks: no checkpoint commits that each started the workflow again. A run started by the bot's own commit ends before any refresh; a branch that already fails `tools check` ends before a job is reserved (`check_failing`).

## [0.12.0] - 2026-11-15

### Added

- Installed skills keep themselves current: `glirastes tools refresh` (write mode, so also the app's `predev`/`prebuild`) brings every install recorded in `.glirastes/installed-skills.json` up to the running SDK without prompting. Unedited copies are replaced, new skills of the installed parts are added, skills the SDK no longer ships are removed when unedited, and the manifest gets the new `sdkVersion` and hashes. Symlinked installs are relinked, the install's target and mode are kept. Edited copies are never overwritten; the refresh prints one line naming them and the command that replaces them. Without a manifest nothing happens. Summary line: `Skills updated to 0.12.0: 2 refreshed, 1 edited copy kept (claude: …).`
- Opt-out: `glirastes tools refresh --no-skills` or `GLIRASTES_SKILLS_AUTO_UPDATE=0` (also `false`, `off`, `no`).
- `glirastes tools check` fails while unedited installed skills or the manifest are behind the SDK (refresh would rewrite them, like stale tool outputs) and only warns about edited copies and machine-local symlinks. `--no-skills`, the opt-out variable and `--integrity-only` skip the skills.
- `glirastes doctor` shows "Installed agent skills" for apps with a skills manifest and warns when they are behind.
- `tests/skill-coverage.test.ts`: every named export of the public entry points and every `AiChatHandlerConfig` option appears in a shipped skill or in `tests/skill-coverage-allowlist.json` with a reason.
- Skills: `integrating-glirastes-nextjs/references/handler-options.md` lists every `createAiChatHandler` option; `building-glirastes-chat-ui/references/hooks-and-building-blocks.md` covers the headless hooks, `useVercelAiChatTransport`, tool renderers, the REST session bridge and the theme helpers; `integrating-glirastes-web` names the embed element's `config` property and the navigation bridge's safety check.

## [0.11.1] - 2026-11-15

### Changed

- Skills catch up with 0.6.0 to 0.11.0: `integrating-glirastes-nextjs` and `integrating-glirastes-web` cover the `history`, `promptCaching` and `hideIds` defaults (and how a custom `streamHandler` applies `createHideIdsTransform`), and `glirastes connect` without `--base-url`. `building-glirastes-chat-ui` gets `references/composer-chips-attachments.md` (the `useChatComposer` API, `useOptionalChatComposer`, `onOpenRequest`, `entityLinks` options with trailing-name chips and `useChatEntityLinks` for a custom `Markdown` slot, attachment limits and error codes, `dispatchToolResultUiActions` for a chat without the SDK provider), since `docs/` is not in the package.
- `curating-glirastes-chat-interactions` lists all chat-internal action prefixes; `maintaining-glirastes-tools` says to refresh after an SDK upgrade. The README mentions `hideIds`.

## [0.11.0] - 2026-11-15

### Added

- Page-bound client actions: `useAiClientAction(actionId, handler, contract, { route: '/templates' })` and `registerAiClientAction(actionId, handler, contract, { route })` say which page registers the action. `glirastes tools refresh` reads the literal route into the tool's UI action (`{ kind: 'client-action', actionId, route }`); tools without a route keep their contract byte for byte.
- When the open page has no handler for a client action with a route, the generated tool no longer refuses: it returns the action with its `route`, and the browser (`dispatchToolResultUiActions`, used by the React chat) opens the route through the navigation bridge, waits up to 5 s (`routeTimeoutMs`) for the page to register the action and then runs it. If it never registers, the dispatch fails with a clear error instead of reporting success.
- `UiActionBus.waitForHandler(actionId, timeoutMs)`. A bus of an older SDK copy without it is polled through `registeredActionIds()`.
- A client action handler may return `false` to report that it did not carry out the action; the dispatch then fails with `UI action <id> was not executed`. Types `ClientActionHandler`, `DispatchToolResultOptions` and `AiClientActionOptions`.
- Findings `ui-action-route-invalid` and `ui-action-route-conflict` (needs attention: a route that is not a literal static app path, or registrations of one action with different routes) and the warning `ui-action-indirect` (a handler that only dispatches a window event and has no route, so it works only where a listener is mounted).

### Fixed

- Clickable entity chips show the pointer cursor on the whole chip, also when the app's CSS reset (e.g. Tailwind preflight) resets button cursors.

## [0.10.1] - 2026-11-15

### Fixed

- Entity chips: a matcher hit followed by a known name of the conversation ("MAR-5 Flyer drucken", also with `:` or a dash between) is one chip instead of two. The matcher's `resolve` still gets only the hit; the match segment carries it as `match`.

## [0.10.0] - 2026-11-14

### Added

- `createAiChatHandler({ hideIds })`, on by default: technical ids stay out of the assistant's answers. The system prompt forbids them, and the built-in stream handler replaces an id the model writes anyway with the label its tool result gave it (a `*Identifier` or `key` field, else `title`, `name`, `displayName`, `label`, or a sibling such as `teamName` for `teamId`) or removes it, together with wrappers like `(ID: …)`. Ids are UUIDs and every value under an `id`/`*Id` key in this turn's tool inputs and outputs or the history. `hideIds: false` keeps the old behaviour. `createHideIdsTransform()`, `redactIds()`, `collectIdLabels()` and `HIDE_IDS_PROMPT` are exported for a custom `streamHandler`.

## [0.9.0] - 2026-11-14

Brings the chat interaction curation and chat attachments (prereleases `0.8.0-chat.0` to `0.8.0-chat.3` on the `next` dist-tag) together with the 0.8.0 pills, composer API and entity chips.

### Added

- `useChatComposerInput()` exposes the composer logic (suggestion search, direct `/` commands, the argument form, entity actions, references from `mentionEntity`, pills, attachments) for a custom chat input: `<RichMentionInput ref={composer.inputRef} {...composer.inputProps} />`. A composer built on it also receives what `useChatComposer()` sends (`chatAbout`, `insertMention`, `insertCommand`, drafts) without `useChatComposerTarget`. Types `UseChatComposerInputOptions`, `ChatComposerInput`, `ChatComposerInputControls`. In the `0.8.0-chat.*` prereleases this hook was called `useChatComposer(options)`; that name stays the 0.8.0 programmatic composer API.
- `MentionInput` takes `initialValue`, `initialMentions`, `components.DropdownItem`, `renderActions`, `renderSubmit`, `inputClassName` and `editorClassName`; `components.MentionDropdownItem` sets the suggestion item for the whole chat.
- Suggestions are grouped under headings when a list mixes types, `/` search matches umlauts typed as `ae`/`oe`/`ue`/`ss`, and an empty result shows a hint (optional `locale.completionEmptyLabel`, with English and German defaults).
- Skill `curating-glirastes-chat-interactions`: review and curate the derived `@` entities and `/` commands, wire them, move a custom composer onto the SDK logic.
- A search endpoint (`GET /api/users/search?name=`) derives an `@` entity; item endpoints of its collection become its actions.
- Chat attachments (images and PDFs), off by default. `createAiChatHandler({ attachments: { enabled: true } })` accepts file parts (`maxFiles` 10, `maxFileBytes` 20 MB decoded, png/jpeg/webp/gif/pdf, `data:` URLs only unless `allowRemoteUrls`), checks type, size and magic bytes of every file in the history (400, 413 `attachment_too_large`, 415) and raises the default `maxBodyBytes` from 1 MB to 50 MB. With `piiShield` it also needs `allowWithPiiShield: true`: file parts pass through byte-identical and never reach the PII detector.
- `attachments` on `AiChatProvider` / `VercelAiChat` (`true` or `{ mediaTypes, maxFiles, maxFileBytes, prepare }`): paperclip button, paste and drop into the input, a tray with thumbnails and remove buttons, and sent files in the message (an image opens in a new tab). Pills and attachments go out together in one message. The SDK does not compress images; do it in `prepare`.
- `AttachmentTray`, `AttachmentButton` (also as `components` slots) and the types `FilePart`, `ChatAttachment`, `ChatAttachmentOptions`, `ChatAttachmentInputProps`, `AttachmentTrayProps`, `AttachmentButtonProps`, `ChatAttachmentsConfig`. `useChatComposerInput()` carries `attachments`, `attachmentError`, `attachmentsEnabled`, `addFiles`, `removeAttachment`, `openFilePicker` and `attachmentInputProps`; a custom `onSubmit` gets the files as third argument. `RichMentionInput` takes `onFiles`, `onBackspaceEmpty` and `allowEmptySubmit`, and keeps its text when `onSubmit` returns `false`. New locale keys with English and German texts.

### Changed

- Derived chat labels: commands and entity actions take the tool's reviewed `title` from `.glirastes/tool-semantics.json`, entities the presentation noun; without them the fallback is verb plus object in English and object plus verb in German ("Dashboard aktualisieren"). Inside an entity's menu a leading entity noun is dropped ("Endgültig löschen" instead of "Aufgabe endgültig löschen"). Action labels no longer consist of the last path segment. Overrides in `.glirastes/chat-interactions.json` still win.
- Destructive entity actions stay last, also after the override merge: derived ones carry `destructive: true`, and an action added in `.glirastes/chat-interactions.json` no longer lands behind "Löschen".
- Client actions of the chat itself (`ai-chat.*`, `chat.*`, `assistant.*`, `command-palette.*`, `command-menu.*`, `cmdk.*`) are no longer offered as `/` commands; a complete entry in `.glirastes/chat-interactions.json` adds one back.
- `.glirastes/tool-contracts.json` carries an optional `title` per tool. Run `glirastes tools refresh` after upgrading and commit the result (it also regenerates the chat interactions module with `destructive: true` on generated actions); `glirastes tools check` reports drift until then.
- A request keeps file data only in the two most recent user messages, older files become `[attachment: name]` text; `createLocalSessionStore` stores no file data. History trimming on the server counts a file part as about 1,000 tokens.
- The LangGraph transport throws when a message carries files.

### Notes

- A Next.js middleware (`proxy`) on the chat route buffers at most 10 MB of the body (`experimental.middlewareClientMaxBodySize`, Next.js 16 `experimental.proxyClientMaxBodySize`); a NestJS or Express app in front of the handler needs a larger JSON limit (`json({ limit: '50mb' })`). See `docs/chat-attachments.md`.

## [0.8.0] - 2026-11-14

### Added

- Pills in the chat composer: a picked `/` command is now a pill like an `@` entity (`data-mention-kind="command"` / `"entity"`), and the two are colored apart. Backspace behind a pill and Delete before it remove the whole pill; each pill has a remove control named by `locale.removeMentionLabel`. Colors come from `theme.colors.pillCommand`, `pillCommandText`, `pillEntity`, `pillEntityText` (`--cm-pill-*`). An `unstyled` chat or a composer of the app's own imports `glirastes/react/pills.css`. `RichMentionInput commandPills={false}` keeps commands as text.
- The default `ChatInput` is the pill composer when the chat has `@`/`/` search (`chatInteractions` or `completionProviders`).
- `useChatComposer()`: `open`, `chatAbout(entity, { command, args, text, append })`, `insertMention`, `insertCommand`, `setDraft`, `insertText`, `clear`, `focus`, plus `chatAboutLabel` for a "Chat about this" menu entry; `useOptionalChatComposer()` is `null` outside the provider. Requests wait for a mounted composer; `useChatComposerTarget` connects a composer of the app's own. `AiChatProvider` takes `onOpenRequest` to show the chat, else it opens the surrounding `AssistantLayoutProvider`. A command pill's `args` fill the command's arguments, so it runs directly when sent alone.
- `entityLinks` on the provider turns entity references in assistant answers into chips: app matchers (e.g. task keys with `resolve`), and names the conversation already referenced (`@` mentions, hits of an entity's search tool). A chip opens through `entityLinks.open` or the entity's derived `ui.navigate` page on the navigation bridge, without a chat message. `@` pills in sent messages open the same way. `EntityText`, `EntityLinkChip` and `useChatEntityLinks()` (`linkify`, `markdownComponents`) cover custom renderers.
- `RichMentionInputHandle.insertMention`, `MentionChipProps.onOpen`/`openLabel`, locale keys `removeMentionLabel`, `openEntityLabel`, `chatAboutLabel` (German included).

### Fixed

- A task mention without an explicit prefix shows `@`, not `/`; `/` now means a command only (`inferMentionPrefix`, `MentionChip`).
- A chat named after its first question shows its mentions as `@Name` and `/Command` instead of `{{mention:…}}` markup.
- `@` and `/` open their list after a pill or any other place where the browser typed a non-breaking space.

## [0.7.1] - 2026-11-13

### Fixed

- `find_tools` no longer invites needless searches. Its description says to call it only when none of the offered tools fits, and its result carries a `note` when the search added no new tool (all matches already available, or no match). In a real-model run over 60 requests, the model had called it 20 times for tools it already had.

## [0.7.0] - 2026-11-13

Connect once, released after the staging rollout (prereleases `0.7.0-connect.0` and `0.7.0-connect.1` on `next`).

### Changed

- Connect once: `glirastes connect` issues one app connection key per run (90 days by default, 1 year or no expiry, chosen in Citadel) and writes it to `.env.local` as `GLIRASTES_API_KEY`. `.glirastes/platform-connection.json` no longer holds an environment id. Against an old Platform the CLI falls back to the per-environment pairing.
- Deployments name their environment with `GLIRASTES_ENVIRONMENT=<environment key>` (`^[a-z0-9][a-z0-9-]{0,63}$`) and share the one `GLIRASTES_API_KEY`. An unknown name creates a pending request in Citadel; the app serves local tools and re-checks on an interval until an owner or admin approves it within the plan's places.
- Without `GLIRASTES_ENVIRONMENT` the app runs as a read-only development connection that follows the reference environment, never registers and sends no health or metrics. With `NODE_ENV=production` it logs a warning.
- Environment-bound keys from older pairings keep working. `glirastes doctor` suggests running `glirastes connect` again.
- README, `docs/managed-runtime-sync.md` and `setting-up-glirastes` describe the new model.
- Docs: distinguish complete framework integrations from conditional generic paths per frontend/backend layer; add OpenAPI without FastAPI, Node sidecar, partial-coverage and target-app verification guidance to the integration skills. Clarify that navigation bridges do not discover pages and FastAPI route counts do not prove export freshness.

### Fixed

- The runtime push stream reconnects after a failure or a closed connection (backoff from 1 s up to 60 s), syncs once after a reconnect to catch missed changes, and treats 90 s without data as a stalled connection. Before, one failed connect left the runner on polling until restart.

## [0.6.0] - 2026-11-12

Defaults of `createAiChatHandler` change; see Changed for each opt-out.

### Changed

- **Start set with `toolDiscovery` and no `intentRouter`: about 10 tools instead of all.** A turn starts with the tools of the modules the request matches, `ui_navigate`, the tools the previous and the current turn called, and `find_tools`, which widens the set on demand. Modules come from the generated tool metadata (module, kind, method, usage hints, synonyms; fragments like `tasksReminder` join `tasks`, `ui.*` tools join the domain they name); the request is classified locally with the existing heuristics in German and English. A weak request gets a small default set, never all tools; a follow-up without domain words is routed by the previous request. Routing only narrows what discovery already allows the principal. Tune with `intentRouting: { maxStartTools, alwaysAvailable }` or `examples` in `toolSemantics`, replace with your own `intentRouter`. **Opt-out:** `intentRouting: false`.
- **Turn-aware history on by default.** The current turn goes to the model complete; the previous turn is always kept, with compacted tool results (arrays to the first 10 items plus a count, strings to 300 characters) and oversized text cut to head and tail; older turns go as text, at most 6 earlier turns within an estimated 4000 tokens. Tune with `history: { maxTurns, toolTurns, maxTokens, maxItems, maxStringLength }`. **Opt-out:** `history: false`.
- **Prompt caching hints on by default.** The system prompt is sent as a system message and, with the newest message, carries cache breakpoints for `@ai-sdk/anthropic` and `@openrouter/ai-sdk-provider` (merged into existing provider options); tools are sent active first in a stable order so tools found mid-turn append to the cached prefix. **Opt-out:** `promptCaching: false`.
- **Silent turns show a fallback and report an error.** A turn whose model returned no visible output (no text, reasoning only, no tool call or executed approval) used to end as an empty bubble counted as `completed`. The chat now shows a short fallback text (German or English by `locale`) and the turn metric reports `error` / `model_error`. No opt-out; a dedicated error code would need a Platform change.

### Fixed

- `uiAction` was not removed from tool results before they went back to the model: AI SDK 6 nests results under `output.value`, which the strip did not read.

## [0.5.1] - 2026-11-12

### Changed

- README quickstart leads with the two-command coding-agent path; the chat route security details moved to `docs/chat-route-security.md`.
- `glirastes connect` needs no `--base-url`: flag, then `GLIRASTES_CONTROL_PLANE_URL`, then `https://api.glirastes.io`. `glirastes sync` already reads the paired connection and needs none.
- `createGlirastes({ localLimits })` is optional and each field falls back to `DEFAULT_LOCAL_LIMITS` (6 steps, 8 tool calls, 60 s, 40k/4k tokens, 0.5 USD); partial overrides merge onto it. The init skill and README drop the full limits block.
- `setting-up-glirastes` asks once whether the app runs Standalone or with the Platform, records it, and lists the values both modes need (`GLIRASTES_APPROVAL_SECRET`).

### Fixed

- The runner registers with `GLIRASTES_BUILD_ID`, else `glirastes@<sdk version>`, instead of `0.0.0` when `createGlirastes` gets no `version`.
- The default Platform URL is now `https://api.glirastes.io`; the previous `api.glirastes.chainmatics.io` host did not resolve, so connected apps without `GLIRASTES_CONTROL_PLANE_URL` never reached the Platform.
- The approval card no longer hides what you approve: array values show the first two items plus "+N weitere" with an expandable one-item-per-line list, and long text expands to wrap fully (`aria-expanded`, German and English locale strings).

## [0.5.0] - 2026-11-11

The Foundation release. Its surface differs from 0.4.0; read **Breaking** before
upgrading. Omnify stays on 0.4.0 until it is migrated on purpose.

### Breaking

- **Endpoint tools call the chat handler's own server, not the public
  origin.** The default endpoint caller and `runtime.origin`
  (`extractOrigin`, `buildRuntimeContext`, `buildToolContext`) use the origin
  of the chat request's URL and ignore `Host`, `x-forwarded-host` and
  `x-forwarded-proto`. In Next.js that URL comes from the address the server
  listens on (behind a proxy, for example `http://localhost:3000`); outside
  Next.js it is whatever the adapter puts into the Web `Request` URL, so an
  adapter must build it from a fixed own origin, never from `Host`, or pass
  `endpointCaller` with a fixed `baseUrl`. 0.4.0 used those headers, so
  any client that reached the app directly could point the server's tool
  calls, with the user's cookie, at any host (`169.254.169.254`, an internal
  service). An app whose API runs in another process, also one that a front
  proxy puts under the same public origin as the chat route, no longer
  reaches it by default and must pass `endpointCaller: (request) =>
  createHttpEndpointCaller({ baseUrl, request })` with an origin of the API
  that its server can reach. `trustForwardedHeaders: true` (default `false`)
  reads the last `x-forwarded-host` / `x-forwarded-proto` value instead; set
  it only when every request comes through a proxy that sets these headers,
  because otherwise any client can again choose the host. Route handlers of
  the same Next.js app are reached as before.
- `engines.node` rises from `>=20` to `>=20.6` (the tools generator loads app
  schema modules through `module.register`).
- Removed exports, deferred and not shipped: `glirastes/server/nestjs`,
  `glirastes/openapi` and `glirastes/react/langgraph`. Their sources stay in
  the repository for a later release.
- `glirastes/server` no longer exports the Platform client (`createLancer`,
  `ServiceBlockedError` and the `Lancer*` and namespace types) or
  `createAegisDetector`. Apps connect through `glirastes connect` and
  `glirastes sync`, and the runtime reads signed revisions through
  `glirastes/sync`.
- `glirastes/codegen` no longer exports the scanners, generators and validators
  of 0.4.0 (`scanEndpointTools`, `scanUiTools`, `scanNestControllers`,
  `generateEndpointRegistry`, `generateUiRegistry`, `generateModuleRegistry`,
  `generateAgentSkills`, `generateMcpServer`, `scaffoldAiTool`,
  `validateAiTools`, `checkAiCoverage`, `syncAssetToGlirastes` and their types).
  `glirastes tools refresh` derives the tools instead.
- The CLI commands of 0.4.0 (`generate*`, `validate-tools`, `coverage`,
  `scaffold`, `test`, `check-upgrade`, `install-skills`) are replaced by `init`,
  `setup`, `connect`, `sync`, `doctor`, `install`, `validate`, `build`, `scan` and
  `tools`. `glirastes --help` lists them.
- `glirastes/server/testing` is ESM only. Its CommonJS entry could never load,
  because Vitest cannot be required from CommonJS.
- `typescript`, `ajv` and `ajv-formats` are runtime dependencies (the tools
  generator needs them). The `wavesurfer.js` peer is gone.
- `createAiChatHandler` binds every approval it asks for to the tool call and
  refuses an approved call it did not ask for. A handler whose approvals can
  occur needs `GLIRASTES_APPROVAL_SECRET` (or `approvalSecret`) when
  `NODE_ENV` is `production`; without it every request fails with HTTP 500
  (`approval_secret_missing`). Approvals can occur when a tool declares
  `needsApproval`, when the handler runs a managed runtime turn (its policy
  can ask for approval of any tool), and when Lancer approvals are
  configured (`lancer.approvals`). Outside production a random per-process secret
  is derived and one warning is logged. Approvals issued before the upgrade,
  by another secret or by another process without the shared secret are
  refused (`approval_not_issued`). The approval id
  (`glirastes-approval.v1.<issued>.<expires>.<nonce>.<mac>`) carries its
  expiry under the MAC; an answer after it, or after the issue time plus the
  answering handler's `approvalMaxAgeMs` (15 minutes) if that is earlier, is
  refused (`approval_expired`). `approvalMaxAgeMs` must be a whole number
  above 0 and at most 24 hours, or `createAiChatHandler` throws. The format
  stays `v1` because no earlier release issued signed ids. The MAC also covers the
  scope: the managed principal's tenant and subject, else the new
  `approvalScope(request)` option, else `''`, so without either an approval
  is not bound to a user. A custom `streamHandler` that lets tools ask
  for approval must pipe its UI stream through `ctx.bindApprovalRequests`,
  and must let the AI SDK call the tools: `ctx.tools[name].execute(input)`
  called without the AI SDK's options (`toolCallId`) is refused
  (`approval_not_verified`) for every tool that can ask for approval. A
  client-set `providerExecuted` flag is ignored only on tools of the
  handler's registry: on an approval-gated tool that a custom `streamHandler`
  adds itself, it makes the approval be consumed without the call running.
  `runDirectCommand` takes `approvals` and asks for no confirmation without it;
  one direct command issues at most one approval.
- An approved call runs only when it passed every check in this request:
  it is an approved part without a result in the last step of the last
  assistant message, its id verifies, it is unexpired, and it is consumed
  once. Every other approved part without a result is rewritten to a denial
  before the model messages are built (`approval_not_runnable`, or
  `approval_not_issued` when its id was not issued for that call), whatever
  follows it in the history (a trailing empty user, system or assistant
  message no longer lets an earlier approval run). A `providerExecuted` flag
  on a part of a tool in the handler's own registry is ignored, so such a
  part is checked, consumed and run as a local call.
- Each approval runs at most once per process within its lifetime by
  default: without an `approvalStore`, the handler records each consumed
  approval in a bounded in-process store shared by every handler of the
  process, until its signed expiry (also when the consuming handler has a
  shorter `approvalMaxAgeMs`). The store holds 20,000 live approvals, at
  most 200 per scope; when either is full, further approvals are denied
  with `approval_store_unavailable` instead of run. The quota is per
  caller without configuration: a request without a managed principal and
  without `approvalScope` counts against a key derived from its
  credentials (an HMAC-SHA-256 under the approval secret of the
  `Authorization` header, else the `Cookie` header; the raw value is never
  kept), so one signed-in user who fills their quota does not block other
  users. Only requests without any credentials share one quota. A caller
  who varies their credentials gets a fresh quota per value, so against
  that only the global limit of 20,000 holds, and each entry costs a real
  approved execution. This key
  partitions the quota only; it is not signed into the approval id (a
  cookie may change between the request for an approval and its answer),
  and single use holds by approval id across all keys. Apps that identify
  users another way set `approvalScope`, which also binds each approval to
  its user. `ApprovalStore.consume(approvalId, expiresAtMs, { scope })`
  receives the signed expiry as its second argument and the quota scope as
  its third (`{ scope }`: the managed or `approvalScope` scope, else
  `caller:<hmac>`, else `''`). Several instances must pass a shared
  `approvalStore`; with
  the default, a replayed approved history can run once more on another
  instance before the approval expires.
- `createAiChatHandler` answers 400 before anything runs to a body that is
  not valid JSON (`invalid_json`, without calling `onError`), to a chat
  history that repeats a tool call id (`duplicate_tool_call_id`) or an
  approval id on two tool parts (`duplicate_approval_id`), to a tool part
  whose `toolName` or `toolCallId` is not a string (`tool_part_malformed`),
  to an approval that is not an object with a non-empty string `id` and a
  boolean, null or missing `approved` (`approval_malformed`), and to more
  than 32 approved calls that could run in one request
  (`too_many_approvals`). The chat UI keeps one part per tool call id and
  approval, so only a hand-built or tampered history is affected; a provider
  that reuses tool call ids across turns is refused too.
- A tool part in the history whose approval id does not verify for that
  part's own call loses its approval before the model sees the history (an
  approved one without a result becomes a denial). A history from 0.4.0, or
  from before a secret rotation or restart without a shared secret, is
  still served, with those approvals removed or denied.
- Pipeline tool selection is routing, not authorization: the tool of an
  approval verified in this request stays in the tool set even when the
  pipeline's selection for the continuation leaves it out (unless the
  guardrails block the request). Role and policy checks still apply.
- A tool's input schema runs once per tool call; `needsApproval`, the hooks
  and `execute` receive that one result. A tool whose input schema transforms
  its input (Zod `transform`, `default`, `coerce`) receives the schema output
  exactly once. The chat
  history, the UI tool part and `onStepFinish` now hold the input the model
  sent, not the transformed one, because the approval is bound to that input.
  Code that read transformed values from the tool part must parse them again.
- `createAiChatHandler` answers 415 unless the body is `application/json`, 403
  to a browser cross-origin request, and 413 above 1 MB. A page on another
  origin that calls the route (a separate front end, an admin app) needs
  `allowedOrigins`; an app that authenticates without cookies may set
  `crossOriginProtection: false`.

### Added

- `glirastes tools refresh` reports settings the chat cannot set yet: a React
  context setter with a closed set of values, or the next-themes `setTheme`.
  The `ui-control-unbound` finding names no tool. In `tools resolve --print`
  it proposes the `useAiClientAction` registration and where to add it, and
  the tool comes from that registration on the next refresh.
  `ui-control-contract-mismatch` flags a client action whose contract allows
  values that the setter does not take. The developer keeps a control out
  with `glirastes tools policy exclude-control <file>#<setter> --reason …`
  (`excludeControls` in `tool-policy.json`).

- `createGlirastes` in `glirastes/runtime` wires an app to Glirastes in one
  call: pass the generated module and the local limits. It runs Standalone
  without `GLIRASTES_API_KEY` and Connected with it, keeps one instance per
  app and process, and `chatTurn(principal)` returns what `createAiChatHandler`
  needs for a turn (`managedRuntime` with revocations, `loadTools`,
  `toolSemantics`, `metrics`). Connected, it asks the Platform for the app,
  environment and runner, registers, reports the code and syncs in the
  background. Until that works the chat runs on the local code; errors go to
  `onError` (operation and status only) and are retried. `wrapBindings` lets an
  app wrap its generated tools. This replaces the connection code apps wrote
  by hand.
- `lookupRuntimeConnection` (`glirastes/sync`, `glirastes/runtime`) asks the
  Platform which app, environment and runner a runtime key belongs to
  (`GET /v1/runtime/connection`).
- Tools follow the code: `glirastes tools refresh` derives endpoint, navigation,
  filter and client-action tools from Next.js, NestJS, OpenAPI (FastAPI),
  react-router and vue-router sources into committed `.glirastes/` files, and
  `glirastes tools check` fails CI when they are stale. Write and delete tools
  ask before they run.
- `glirastes init` hands setup to your coding agent, with bundled skills under
  `skills/`; `glirastes setup`, `connect`, `sync` and `doctor` install, pair,
  upload and diagnose a local setup.
- New subpaths: `glirastes/contracts`, `glirastes/runtime`, `glirastes/ai-sdk`
  (also `glirastes/runtime/ai-sdk`), `glirastes/stt`, `glirastes/sync`,
  `glirastes/adapter/nextjs`, `glirastes/embed` (the `<glirastes-chat>` element
  for apps without React) and `glirastes/browser` (navigation bridge, query
  filters and client actions without React).
- Content-free runtime metrics (tokens, cost with its source, latency, errors,
  tool use), sent in batches off the turn path and dropped on failure.
- `createAiChatHandler` options `approvalSecret` (env fallback
  `GLIRASTES_APPROVAL_SECRET`), `approvalMaxAgeMs` (default 15 minutes, at
  most 24 hours), `approvalStore` (optional single-use store:
  `consume(approvalId, expiresAtMs, { scope })` returns false for an id used
  before) and `approvalScope(request)` (who an approval is for without a
  managed runtime), plus `allowedOrigins`, `crossOriginProtection`,
  `maxBodyBytes` and `trustForwardedHeaders` (default `false`; see
  **Breaking**). Denied approvals carry the stable codes
  `approval_not_issued`, `approval_expired`, `approval_already_used`,
  `approval_store_unavailable` and `approval_not_runnable`.
- Generic `@` mentions and `/` commands in the shared chat, and push-to-talk STT.
- Pro: `glirastes tools enrich --managed` runs the bundled tool skills as a
  budgeted job on the Platform's model access (optional peer `@ai-sdk/openai`),
  and `glirastes init --ci github` writes a workflow with the model-free tool
  check and, for Pro, the managed tool job.
- `glirastes init --ci github --ci-environment <name>` puts the managed tool
  job into that GitHub environment, so its `GLIRASTES_CI_KEY`,
  `GLIRASTES_CONTROL_PLANE_URL` and `GLIRASTES_MANAGED_TOOLS` stay apart from
  repository values (for example a staging Platform with its own key).
- `glirastes init --ci github --enrich-on <branch,...>` also runs the managed
  tool job after pushes to those branches, through a pull request against the
  branch, and adds a manual start that works the whole tool backlog once
  (`glirastes tools enrich --managed --first-run`).
- The managed tool job pushes its commits and pull requests with a GitHub App
  token when the variable `GLIRASTES_BOT_APP_ID` and the secret
  `GLIRASTES_BOT_APP_PRIVATE_KEY` are set, so they start the repository's
  checks; without them it keeps the workflow token.
- `glirastes tools enrich --managed` routes model requests through OpenRouter
  with the routing rules the Platform grants for the job, or with your own key
  in `GLIRASTES_TOOLS_OPENROUTER_KEY`.
- `createLocalAiPipeline` (`glirastes/server`) runs the AI pipeline inside the
  app without the Platform, with focused tool routing by default; pass
  `routingMode: 'legacy'` for the broad routing.
- `glirastes --help` and `glirastes --version`. An unknown command fails with
  `E-SETUP-030` and points to `--help`.
- `docs/support-matrix.md` and the acceptance documents in `docs/acceptance/`.
- `AiChatProvider` takes `unstyled` to bring your own styles: widget roots
  render `data-unstyled`, the shipped stylesheet no longer applies to them, and
  no theme variables are written.
- `deChatLocale` from `glirastes/react`: German texts for the whole chat UI.

### Changed

- A connected app needs one variable: `GLIRASTES_API_KEY`. The runtime asks
  the Platform for the app, environment and runner, so `GLIRASTES_APP_ID`,
  `GLIRASTES_ENVIRONMENT_ID` and `GLIRASTES_RUNNER_KEY` are gone.
  `GLIRASTES_CONTROL_PLANE_URL` is optional and defaults to
  `https://api.glirastes.chainmatics.io`; set it only to self-host or run the
  Platform locally. The key, not the URL, now switches between Standalone and
  Connected (`resolveRuntimeMode`); a malformed key or a URL that is not
  http(s) stops the start with an error that names the variable.
  `glirastes connect` writes only the key (and the URL for a self-hosted
  Platform) and removes the three old lines. `glirastes sync` and
  `glirastes doctor` take app, environment and runner from
  `.glirastes/platform-connection.json`; `doctor` says when the old variables
  are still set and no longer needed. `createRuntimeMetricsSinkFromEnv` takes
  the looked-up connection (`{ connection: { appId, environmentId } }`).
  `GLIRASTES_CI_KEY` for the Pro CI job is unchanged.
- The chat context's `send` returns whether the message was taken. It returns
  false while an approval card waits or the session is not ready; a custom
  composer should keep the typed text then, as the shipped composers do.
- Each assistant bubble shows a collapsible work log of its tool calls
  (`ActivityLog`, `data-component="activity-log"`), like Claude Code: one
  line with a spinner and the running tool while the turn works, then a
  summary such as "3 steps done, 1 failed" that expands to the steps in the
  order they ran, each with a check or an error and the output message or
  error text when the tool result display mode allows it. A pipeline stop or
  error is its last line. SDK built-ins are left out, and the typing dots give
  way to the log once a tool runs. The icons are inline SVG and also work in
  unstyled mode.
- `AiChatPanel` no longer renders the pipeline bar on top by default; pass
  `components.PipelineTimeline` to keep one.
- `createAiChatHandler` takes `planning` for the built-in `update_plan` tool.
  The model records a short task list only for requests with several distinct
  actions and updates its statuses as it works; the turn continues after each
  call. The bubble shows the latest call above the work log as `PlanChecklist`
  (`data-component="plan-checklist"`): a check for done items, a spinner for
  the current one, dimmed pending ones. Plans below two items never show.
- The managed tool job works one small task at a time (the resolve list, then
  up to eight tools of one module), four tasks side by side, and writes
  entries by stable key so finished work is kept. Automatic runs work only
  what changed (a pull request against its base, a push against the commit
  before it); the backlog runs only with `--first-run`. The model work ends
  ten minutes before the CI timeout and long runs commit every five tasks. A
  run that leaves tools open reports `partial`, one that closes nothing fails
  with `no_progress`.
- New locale texts: `activityWorkingLabel`, `activityWaitingLabel`,
  `activityDoneLabel`, `activityDoneOneLabel`, `activityFailedLabel` and
  `planTitle`.

### Fixed

- An approval was not bound to anything the server issued: one forged chat
  request whose history held a made-up tool part in state
  `approval-responded`, or an old approved history, ran the tool with the
  client's input. The approval id now carries an HMAC over tool call id, tool
  name, canonical input, issue time, expiry and the principal's scope. The
  server checks it before anything runs and denies the call otherwise; the request continues and the model sees
  the denial. This covers model turns and direct commands. Each approved
  call runs at most once per process (see **Breaking**), and the tool itself
  checks a per-request execution gate, also under a custom `streamHandler`:
  a call runs only when this request verified its approval or the tool did
  not need one. A second part with the same tool call id can no longer take
  over a valid approval, a copy of a valid approval id on another tool part
  is refused (`duplicate_approval_id`) instead of running that part's call,
  and an approval id is accepted only in the exact
  spelling the server issued (another base64url spelling of the same MAC, a
  padded or zero-prefixed id, no longer counts as a fresh approval).
- The approval hash keeps an own `__proto__` key of the input, so an approval
  no longer verifies after such a key was added. The managed approval scope
  encodes tenant and subject as a JSON array, so ids containing `:` cannot
  make two principals share approvals.
- `allowedOrigins` admits a listed origin also when the browser marks the
  request `Sec-Fetch-Site: same-site` or `cross-site` (a sibling subdomain or
  a separate front end); before, every such request got 403. An unlisted
  origin still gets 403, and `Origin: null` is always refused. A request
  without `Sec-Fetch-Site` (older browsers) may also match the own origin by
  its `Host` header, with `https` or `http` (so a TLS-terminating proxy needs
  no `x-forwarded-host`), or by the first `x-forwarded-host` value; a request
  the browser marks `same-site` or `cross-site` passes only with an `Origin`
  listed in `allowedOrigins`. This check never changes where endpoint tools
  send their calls.
- The canonical JSON under the approval MAC refuses non-finite numbers, so an
  input such as `1e999` (Infinity) no longer verifies against an approval
  issued for `null`.
- In pipeline mode an approved call no longer fails when the pipeline's tool
  selection for the continuation leaves its tool out; the tool of every
  verified approval stays in the tool set unless the guardrails block the
  request.
- A tool runs with its input validated against its input schema, also an
  approved call taken from the history: undeclared fields are rejected by
  strict schemas and stripped by the others.
- A path parameter with a `.` or `..` segment (split at `/` or `\`, also
  percent-encoded, even repeatedly, e.g. `x/../../admin` or `..%2fadmin`) no
  longer reaches another route. Endpoint tools refuse it with a tool error and
  send nothing. Values such as `v1..2` or `.hidden` still pass.
- `--help` prints the usage of every command instead of running it.
- `glirastes init` at a monorepo root finds the apps in its workspace
  packages.
- A NestJS route that is declared twice is reported as the finding
  `route-declared-twice`; `glirastes tools refresh` keeps generating the other
  tools.
- A managed tool job that the Platform stops at the workspace's overage
  ceiling ends green and says why (`usage_overage_ceiling_reached`).
- A client action the open page has no handler for no longer reports success.
- `glirastes tools enrich` names a malformed CI key (`ci_key_invalid`) and
  checks an own OpenRouter key before the Platform reserves a job
  (`byok_key_invalid`).
- A tool without a contract, or one still unresolved, no longer counts as
  changed in the managed job's diff.
- A managed tool job that closed nothing no longer commits or opens a pull
  request.
- The generated workflow header names the GitHub environment it reads.
  The chat transport sends the action ids the page handles
  (`glirastesClientActions`), the Next.js handler puts them into
  `runtime.clientActions`, and the generated tool refuses any other action, so
  the model cannot claim a dialog opened. Without the report the old behaviour
  stays.
- A tool whose result does not match its declared output is reported as done
  with the details withheld (`outputWithheld: true`) instead of failed, so a
  write that succeeded is not retried or reported to the user as an error.
- A message typed while an approval card is open no longer rejects the
  request. The card stays, the message is held, and the panel shows
  `approvalPendingHint` until the card is decided.
- The packed tarball is installed and loaded in the test suite (ESM, CommonJS,
  the CLI and a strict NodeNext consumer), so an undeclared dependency or a
  missing file fails before a release.

## [0.4.0] - 2026-06-25

### Changed

- **Upgraded Zod from v3 to v4** (`zod@^4`). The public schema-authoring API
  is unchanged for consumers, but Zod 4 is now installed transitively — apps
  that import `zod` directly alongside glirastes will resolve to Zod 4.
  - Rewrote the internal Zod-introspection code that depended on Zod 3's
    private representation (`_def.typeName`, `def.shape()`, `_def.checks`).
    Most critically, `zodToCompactDescription()` (the `Returns: …` suffix
    generator for AI tool descriptions) silently degraded to `"unknown"`
    under Zod 4 — it now reads Zod 4's `_zod.def` correctly.
  - Centralized all Zod-internals access for the test-suite generators
    (`runEdgeCaseTest`, `runSchemaConsistencyTest`) into a single
    `zod-introspect` module with full unit coverage, so a future Zod upgrade
    fails loudly instead of generating empty test suites.
  - `z.record(z.unknown())` updated to the Zod 4 two-argument form
    `z.record(z.string(), z.unknown())`.

### Added

- Regression tests pinning `zodToCompactDescription` output and the Zod
  introspection helpers, closing the silent-failure gap the upgrade exposed.

## [0.3.2] - 2026-04-29

### Changed

- Documentation pass that makes the **CLI codegen step explicit as a
  required part of the Next.js setup** for any non-trivial app. The
  earlier framing implied codegen was only "for scaling up" — in
  practice the manual `endpointToolsToRegistry([…])` import list breaks
  down past a handful of tools, and codegen is the canonical wiring.
  - README quickstart Step 4 now points readers at the codegen workflow
    immediately after the demo manual-import example.
  - The "Scaling up" section is renamed to **"Scaling up — required
    codegen workflow for Next.js"** and explicitly states NestJS users
    skip it (runtime DI scan handles aggregation).
  - The `integrating-glirastes-nextjs` and `maintaining-glirastes-tools`
    skills mirror the same framing so coding agents pick the codegen
    path by default for non-trivial apps.
- Forward-looking note in README and skills: a `buildToolRegistry`
  helper based on `import.meta.glob` / `require.context` is planned
  for **0.4.0** and will let Next.js consumers skip the codegen step.

No code changes — patch-level docs release.

## [0.3.1] - 2026-04-28

### Added

- Dual-bundle output (CJS + ESM). The package now ships a CommonJS build at
  `dist/cjs/` alongside the ESM build at `dist/`, so legacy NestJS backends
  on `module: commonjs` can consume `glirastes/server/nestjs` without an ESM
  migration. The `exports` map uses conditional `import`/`require` branches
  with their own typings.
- Legacy subpath shim directories at the package root (`server/`, `react/`,
  `codegen/`, `openapi/`) so consumers on `moduleResolution: node` (without
  `exports`-map support) still resolve subpaths.
- Pre-built agent skills under `skills/` (shipped in the npm tarball):
  `integrating-glirastes-nextjs`, `integrating-glirastes-nestjs`,
  `integrating-glirastes-nextjs-with-nestjs-backend`,
  `maintaining-glirastes-tools`, `building-glirastes-chat-ui`. Drop into
  `.claude/skills/` (or `.codex/skills/`) to give a coding agent
  framework-specific guidance for integrating, maintaining, and customizing
  the SDK.
- New CLI command `glirastes install-skills` — installs the bundled agent
  skills into a target directory. Flags:
  - default: `./.claude/skills` (project-local)
  - `-g` / `--global`: `~/.claude/skills` (shared across all projects on the
    machine; mutually exclusive with `--target`)
  - `--target <dir>`: override the destination (accepts relative, absolute,
    or `~/`-prefixed paths)
  - `--stack nextjs|nestjs|nextjs+nestjs|all` (default `all`): filter
  - `--symlink`: track the installed SDK version automatically
  - `--force`: overwrite existing
  - `--dry-run`: preview without writing
- Adapter-selection guidance in the README: when both a frontend and a
  separate backend exist, put the chat route on the backend.
- Scaling-up section in the README explaining the `glirastes scaffold` →
  `generate-tools` → registry-import codegen workflow.

### Changed

- `@ai-sdk/react` and `react-markdown` moved from `dependencies` to optional
  `peerDependencies`. Backend-only consumers no longer pull a phantom React
  tree into `node_modules`. Frontend consumers must install them themselves
  (the README install section is split per stack).
- `dependencies.zod` bumped to `^3.25.76` to match what `ai@6` and
  `@ai-sdk/openai` require.
- `AiChatModule.attachWebSockets()` is now `async`. Consumers that enable
  the speech-to-text feature must `await` the call.

### Fixed

- Optional peer `wavesurfer.js` is now truly optional. The voice
  components load it via a runtime `Function('s', 'return import(s)')`
  helper so browser-side bundlers (Webpack, Turbopack, Vite, esbuild)
  don't try to resolve the specifier at build time when the package is
  not installed. Note: requires `script-src 'unsafe-eval'` CSP — projects
  with strict CSP should install `wavesurfer.js` unconditionally to
  bypass the runtime trick. See `skills/building-glirastes-chat-ui` for
  details.
- Optional peer `ws` is now truly optional. The NestJS speech-to-text
  gateway uses a plain dynamic `import('ws')` inside `attachWebSockets`,
  guarded by try/catch — backends that don't enable speech-to-text no
  longer crash with `ERR_MODULE_NOT_FOUND` at startup. (Bundled NestJS
  deployments must either install `ws` unconditionally or mark it as a
  bundler external.)

## [0.3.0] - 2026-04-28

### Fixed

- README NestJS examples now match the real decorator API: `@AiTool({ name })`
  not `toolName`, `@AiModule({ intent, classification })` takes an options
  object, `scanNestJsControllers({ controllers })` takes an options object
  and returns `{ tools, modules, toolsByModule }` (destructure `.tools`
  before passing to `endpointToolsToRegistry`).
- Stream handler no longer emits the fallback `"No output generated.
  Check the stream for errors."` event when an upstream error has
  already been streamed in the same response.

### Changed

- Peer-dep range for `@nestjs/common`, `@nestjs/core`, `@nestjs/config`,
  `@nestjs/swagger` widened to support v10 alongside v11.

### Added

- `examples/quickstart-nestjs/` and `examples/quickstart-nextjs/` —
  compile-tested in CI via `tests/examples-compile.test.ts`. What you
  copy from the README is what compiles.
- README "Setup notes" section: recommended `tsconfig.json` (so
  `Cannot find module 'glirastes/server/nestjs'` no longer surprises
  consumers on legacy `moduleResolution`) and a subpath decision-tree
  table.
- `FOLLOWUPS.md` capturing deferred work: dual ESM+CJS bundle,
  `glirastes`+`glirastes-react` split for production trim, optional
  `baseUrl` for endpoint tools, registry sugar, CLI docs.
- `DEFAULT_SAFETY_MAX_STEPS` and `resolveStepLimit` are now public exports
  so consumers can pin / replicate the safety-cap behaviour in tests.

## [0.2.1] - 2026-04-27

### Changed

- README hero image now uses a relative path (`.github/hero.gif`) so it
  renders directly from the repository instead of a hard-coded
  `raw.githubusercontent.com` URL.
- Refreshed `.github/hero.gif` with an updated, smaller animation.

## [0.2.0] - 2026-04-27

### Added

- Initial public release of `glirastes`.
- Type-safe tool definitions via `defineEndpointTool()` and `defineUiTool()`.
- Role-based access control (RBAC) at the tool layer.
- Approval flows for sensitive tool calls.
- Server adapters for Next.js (App Router) and NestJS (decorators).
- React chat UI components, hooks, and provider.
- UI Action bus for declarative client-side dispatch from tool results.
- PII shield with anonymization, pseudonymization, and rehydration.
- Lancer client for the Glirastes platform with graceful degradation.
- CLI: `init`, `generate`, `validate`, `coverage`, `scaffold`.
- Codegen for endpoint registries, UI registries, action IDs, and modules.
- OpenAPI generator: turn an OpenAPI spec into endpoint tool definitions.
- Testing utilities for tool setups without LLM calls.
- `engines.node` field declaring Node.js `>=20` as the supported runtime.
- CI: `npm audit` job (production deps, level=high) on every PR and push.
- CI: CodeQL static analysis with `security-and-quality` query suite.

### Changed

- `react-markdown` and `wavesurfer.js` are now optional `peerDependencies`
  rather than runtime `dependencies`. Server-only consumers no longer pull
  these libraries on install. `react-markdown` is loaded via `React.lazy`
  with a plain-text fallback when the peer dep is not installed.

[Unreleased]: https://github.com/chainmatics/glirastes/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/chainmatics/glirastes/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/chainmatics/glirastes/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/chainmatics/glirastes/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/chainmatics/glirastes/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/chainmatics/glirastes/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/chainmatics/glirastes/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/chainmatics/glirastes/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/chainmatics/glirastes/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/chainmatics/glirastes/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/chainmatics/glirastes/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/chainmatics/glirastes/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/chainmatics/glirastes/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/chainmatics/glirastes/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/chainmatics/glirastes/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/chainmatics/glirastes/compare/v0.3.2...v0.4.0
[0.2.1]: https://github.com/chainmatics/glirastes/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/chainmatics/glirastes/releases/tag/v0.2.0

[0.14.0]: https://github.com/chainmatics/glirastes/compare/v0.13.1...v0.14.0
[0.15.0]: https://github.com/chainmatics/glirastes/compare/v0.14.0...v0.15.0
[0.16.0]: https://github.com/chainmatics/glirastes/compare/v0.15.0...v0.16.0
