# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-11-14

### Added

- Pills in the chat composer: a picked `/` command is now a pill like an `@` entity (`data-mention-kind="command"` / `"entity"`), and the two are colored apart. Backspace behind a pill and Delete before it remove the whole pill; each pill has a remove control named by `locale.removeMentionLabel`. Colors come from `theme.colors.pillCommand`, `pillCommandText`, `pillEntity`, `pillEntityText` (`--cm-pill-*`). An `unstyled` chat or a composer of the app's own imports `glirastes/react/pills.css`. `RichMentionInput commandPills={false}` keeps commands as text.
- The default `ChatInput` is the pill composer when the chat has `@`/`/` search (`chatInteractions` or `completionProviders`).
- `useChatComposer()`: `open`, `chatAbout(entity, { command, args, text, append })`, `insertMention`, `insertCommand`, `setDraft`, `insertText`, `clear`, `focus`, plus `chatAboutLabel` for a "Chat about this" menu entry. Requests wait for a mounted composer; `useChatComposerTarget` connects a composer of the app's own. `AiChatProvider` takes `onOpenRequest` to show the chat, else it opens the surrounding `AssistantLayoutProvider`. A command pill's `args` fill the command's arguments, so it runs directly when sent alone.
- `entityLinks` on the provider turns entity references in assistant answers into chips: app matchers (e.g. task keys with `resolve`), and names the conversation already referenced (`@` mentions, hits of an entity's search tool). A chip opens through `entityLinks.open` or the entity's derived `ui.navigate` page on the navigation bridge, without a chat message. `@` pills in sent messages open the same way. `EntityText`, `EntityLinkChip` and `useChatEntityLinks()` (`linkify`, `markdownComponents`) cover custom renderers.
- `RichMentionInputHandle.insertMention`, `MentionChipProps.onOpen`/`openLabel`, locale keys `removeMentionLabel`, `openEntityLabel`, `chatAboutLabel` (German included).

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

[Unreleased]: https://github.com/chainmatics/glirastes/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/chainmatics/glirastes/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/chainmatics/glirastes/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/chainmatics/glirastes/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/chainmatics/glirastes/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/chainmatics/glirastes/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/chainmatics/glirastes/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/chainmatics/glirastes/compare/v0.3.2...v0.4.0
[0.2.1]: https://github.com/chainmatics/glirastes/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/chainmatics/glirastes/releases/tag/v0.2.0
