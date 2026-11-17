# Managed local runtime sync

`glirastes/sync` keeps signed Control Plane deployments in the customer
environment. Prompts, provider credentials, tool arguments, tool results, and
business data are never sent through this connection.

Most apps never call `glirastes/sync` directly. `createGlirastes` from
`glirastes/runtime` does all of the following for them (see the README,
"Standalone and Connected"). This page describes the parts underneath.

## Connect once, environments by name

One developer runs `glirastes connect` once. It issues one app connection key
as `GLIRASTES_API_KEY`. In Citadel the approver chooses the key lifetime: 90
days (the default), 1 year or no expiry. No environment is chosen, and
`.glirastes/platform-connection.json` holds no environment id.

`connect` works for every tool source (Next.js, NestJS, OpenAPI, ...). Where
the key goes:

- `--dotenv <path>` (or `--dotenv=<path>`; given once): written to that
  file. The path is relative to the project root and must stay inside it; its
  directory must exist and be writable (`E-CONNECT-PATH-NOT-WRITABLE`
  otherwise, before pairing). `connection.envFile` in
  `.glirastes/tools.json` sets the same default for `connect`, `sync` and
  `doctor`; the flag wins.
- Next.js without the flag: `.env.local`, as before (`connect` owns the
  connection variables in it and removes the obsolete ones). An app counts as
  Next.js when `tools.json` has a `next-*` source or `package.json` depends on
  `next`.
- Any other app without the flag: no file. On a terminal the key is shown
  once, with the instruction to set it as `GLIRASTES_API_KEY` in the
  environment of the server process (and `GLIRASTES_CONTROL_PLANE_URL` for a
  self-hosted Platform). It is not stored and cannot be shown again. When
  stdout is not a terminal, `connect` refuses before pairing
  (`E-CONNECT-SECRET-OUTPUT-REFUSED`) so the key never lands in a CI log. The
  guard checks stdout only: an agent or script running in a pseudo-terminal
  passes it, so agents must always use `--dotenv <path>` (or `--json` when
  they handle the key themselves). With `--json` the result carries
  `secretTarget: "output"` and `apiKey` (and `controlPlaneUrl` when
  self-hosted); with a file it carries `secretTarget: "file"` and `envFile`,
  never the key.

Why the flag is not called `--env-file`: Node.js 20 and later read
`--env-file` themselves, even when it comes after the script name
(`glirastes connect --env-file x`). With a missing file Node.js exits with
code 9 and `node: <path>: not found` before glirastes runs, which glirastes
cannot catch. With an existing file Node.js silently loads its variables into
the process; glirastes then sees the flag and stops with `E-SETUP-033`
before reading anything or pairing. Use `--dotenv <path>`.

Checks of the secret file, all before pairing, so no key is issued that
cannot be stored:

- **Git.** The file must be ignored and not tracked. The checks use the real
  on-disk name, so on macOS or Windows `backend.env` cannot slip past as an
  alias of a tracked `Backend.env`, also when the tracked file is deleted on
  disk (letter case is folded Unicode-aware, `café.env` = `CAFÉ.env`);
  nested `.gitignore` files and negation patterns count. Git runs without
  the repository-selecting variables of the environment (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CEILING_DIRECTORIES`, ...), so the
  repository is always the one found from the file's directory. When the
  environment sets `GIT_DIR` or `GIT_WORK_TREE` (a yadm or vcsh dotfile
  repository, a bare `dot.git` with the home directory as work tree), Git is
  asked once more with that unmodified environment from the current
  directory, and a file tracked there is refused too. A `GIT_DIR` that Git
  cannot open, or one without a work tree, stops connect with
  `E-CONNECT-GIT-UNAVAILABLE` (remediation `fix-or-unset-git-dir`) instead of
  passing as untracked. Outside any
  Git repository the file is accepted (nothing can be committed). If the
  project has a `.git` that Git cannot read (Git not installed, unsafe
  ownership), connect stops with `E-CONNECT-GIT-UNAVAILABLE`.
- **Content.** Duplicate connection variables, a `GLIRASTES_CONTROL_PLANE_URL`
  line naming another Platform than the one being paired
  (`E-CONNECT-ENV-PLANE-CONFLICT`), and a connection variable inside a
  multi-line quoted value (`E-CONNECT-ENV-UNSUPPORTED`) stop connect.
- **Writing.** Only the `GLIRASTES_API_KEY` line is replaced or appended (plus
  `GLIRASTES_CONTROL_PLANE_URL` for a self-hosted Platform). Every other line,
  comment, line ending and the final newline stay as they were; obsolete
  variables of older connects stay too and `glirastes doctor` points at them.
  The file is replaced atomically (a new file renamed over the old one), so
  its owner, ACLs, extended attributes and hard links are not carried over.
  An existing chosen file keeps its permission bits: a file at 0644 then holds
  the key world-readable, so set it to 0600 (`chmod 600 <file>`). A new file
  and `.env.local` are created 0600.
- **Crash safety (connect only).** The new content and the backup of the old
  file are staged in a private directory (mode 0700, staged copy 0600) and
  renamed into place. The directory is, in this order: inside the git dir of
  the repository that owns the file (never tracked or shown by `git status`;
  worktrees and submodules use their own git dir), else under the temporary
  directory when its real path is outside the project and it is in no Git
  work tree, or Git ignores the staging directory there (a `TMPDIR` inside a
  monorepo beside the project is skipped otherwise), else beside the file
  when Git ignores the names `*.glirastes-stage-*` and `*.glirastes-backup-*`
  (or there is no repository); otherwise connect stops before pairing
  (`E-CONNECT-STAGING-NOT-IGNORED`). Each private place must pass a real
  rename probe into the target directory, so a cross-filesystem rename
  (EXDEV) can never fail after the key was issued. The secret file is
  replaced before `.glirastes/platform-connection.json` is written. A kill
  during the write can leave the staged key in that private directory (in the
  git dir or the temporary directory, 0600), never in a path Git would add;
  the next connect removes such directories after an hour. A failed write
  restores the old file by renaming its backup over it, never a partial
  copy. If storing fails after the Platform issued the key, connect reports
  `E-CONNECT-SECRET-NOT-STORED` without the key: fix the cause, run connect
  again and revoke the unused key on the Platform. `sync` and `doctor` only
  read and never stage.
- **Owning repository.** The Git checks run in the directory of the file, so
  a nested repository or a submodule that tracks it answers.

`glirastes sync`, `glirastes doctor`, `glirastes setup --managed` and
`glirastes setup sync` take the same `--dotenv`; `glirastes init` runs
`doctor` with `connection.envFile` of `tools.json`. A key in the process
environment wins for `sync`; without a file and without Next.js `sync` and
`doctor` read the process environment only.

### What a deployed app needs

The embedded runtime (`createGlirastes`) reads no file at run time: not
`.glirastes/platform-connection.json`, not `.glirastes/tools.json`, nothing
resolved from the working directory. The app id comes from the setup artifact
that the generated module (`tools.generated.ts`) carries inline, so it is
compiled into the app. App, environment and runner come from the Platform
(`GET /v1/runtime/connection`) for the key. A container built without
`.glirastes/` and started in another working directory therefore needs only:

- `GLIRASTES_API_KEY` (secret),
- `GLIRASTES_ENVIRONMENT=<environment key>` (per deployment; without it the
  app runs as a read-only development connection),
- `GLIRASTES_CONTROL_PLANE_URL` only for a self-hosted Platform,
- optionally `GLIRASTES_BUILD_ID` as the reported version.

`.glirastes/platform-connection.json` is read only by the CLI (`connect`,
`sync`, `doctor`) on a developer machine or in CI. The configured runtime
container (`glirastes-runtime`) is different: it reads its JSON configuration
and the mounted artifact directory (see `docs/runtime-container.md`).

**Commit `.glirastes/platform-connection.json`.** It holds no secret: the
Platform URL, the app id and `runnerKey`, a random label `connect` writes once
(`local-…`). The label is not a credential and not tied to a machine: the
file must contain it, but no command uses its value, and the running app gets
its runner from the Platform for its key. The file mode 0600 comes from the way `connect` writes files, not from
the content. One developer connects and commits the file; every other
developer and CI then run `glirastes sync` and `glirastes doctor` with their
own `GLIRASTES_API_KEY`. Without the file both treat the project as not
connected. The secret is only the key, which stays out of the repository.

### What you see in Citadel after connect and sync

- **After `connect`:** the app exists in Citadel with one app connection key
  and no environment.
- **`sync`** uploads the content-free setup report of the tools (names,
  descriptions, usage hints, roles, risk classes, schema digests, warnings) to
  the app, not to an environment. It creates no environment and activates
  nothing. The printed status is `ready` (nothing needs attention) or `review`
  (at least one operation needs attention before it can be published).
- **Without an environment** the overview and the tools page of Citadel stay
  empty ("No app connected yet"), also after a successful `sync`: both show an
  environment. Owners and admins see the app connection keys, development
  connections and pending environment requests there.
- **An environment** comes from Citadel (add it in the environment picker and
  give it a place) or from a deployment that starts with
  `GLIRASTES_ENVIRONMENT=<environment key>` and is then approved in Citadel.
  The tools appear once a runner of that environment has reported the same
  tool set.
- **An app without `GLIRASTES_ENVIRONMENT`** is a development connection. It
  is listed with its key prefix and last contact, follows the first
  environment that holds a place read-only, and logs "No reference environment
  yet; running on local code and checking again." until one exists.

### What `doctor` checks about sign-in

Two checks read `package.json` in the project root and nothing else; neither
looks at framework code, so they behave the same for Next.js and for a NestJS
or other embed:

- **Signed-in user verification** (`E-SCOPE-003`, fails): passes when
  `package.json` declares `"glirastes": { "principal": "server-verified" }`.
  The declaration is the app's statement that the principal of every turn is
  resolved on the server from the verified session (for example a NestJS guard
  that authenticates the request before `chatTurn()` receives the principal).
  Set it only once that is implemented and tested; `doctor` does not verify
  the code, and the declaration never replaces the endpoint's own
  authorization.
- **Sign-in integration** (`E-SCOPE-101`, warning): passes when a known sign-in
  package is a dependency (`@azure/msal-node`, `@auth0/nextjs-auth0`,
  `@clerk/nextjs`, `@supabase/ssr`, `@auth/core`, `next-auth`, `better-auth`,
  `@nestjs/passport`, `passport-jwt`, `passport`), or when the principal is
  declared `server-verified`: that declaration covers an own guard without
  one of these packages. The warning therefore only appears while the
  principal is not declared either.

Both are local checks: neither result is sent to the Platform, and
`glirastes sync` does not look at them. `doctor` itself reports `fail` and
exits non-zero while a check fails.

Every deployment uses the same secret, `GLIRASTES_API_KEY`, and names itself
with `GLIRASTES_ENVIRONMENT=<environment key>`. The name is not a secret and
must match `^[a-z0-9][a-z0-9-]{0,63}$`. `GLIRASTES_CONTROL_PLANE_URL` is only
needed when the Platform is self-hosted.

- **Unknown environment name.** The first start creates a pending request in
  Citadel. An owner or admin clicks "create and connect" if a plan place is
  free. Until then the runtime serves local tools and checks again on an
  interval, so no redeploy is needed. An environment that exists but has no
  place also serves local tools.
- **Places.** The plan limits connected environments ("places"). Development
  does not count toward the limit.
- **No `GLIRASTES_ENVIRONMENT`.** The app runs as a development connection. It
  follows the dashboard settings of the reference environment read-only: the
  first environment in promotion order that holds a place. The most
  restrictive of code and Platform wins. It never registers, sends health or
  sends metrics. Without a reference environment it uses local artifacts only.
  With `NODE_ENV=production` and no environment name it logs a warning.
- **Rotation.** Rotate the key in Citadel. The old key stays valid for a 7-day
  grace period. Owners and admins are emailed 14 days and 3 days before a key
  expires.
- **Legacy keys.** Environment-bound keys from older pairings keep working
  without `GLIRASTES_ENVIRONMENT`. Running `glirastes connect` again moves the
  app to the new model, and `glirastes doctor` suggests it. Against an old
  Platform the CLI falls back to the old per-environment pairing.

## Connection

A connected app sets `GLIRASTES_API_KEY` and, per deployment,
`GLIRASTES_ENVIRONMENT`. `GLIRASTES_CONTROL_PLANE_URL` is optional (default
`https://api.glirastes.io`). The runtime asks the Platform which
app, environment and runner the key belongs to:

```ts
import { resolveRuntimeConnectionConfig } from 'glirastes/runtime';
import { lookupRuntimeConnection } from 'glirastes/sync';

const config = resolveRuntimeConnectionConfig(process.env); // undefined in Standalone
const connection = config && await lookupRuntimeConnection({
  ...config,
  environment: process.env.GLIRASTES_ENVIRONMENT,
  nodeEnv: process.env.NODE_ENV,
});
// { baseUrl, appId, environmentId: string | null, runnerKey, mode }
// mode is 'environment', or 'development' (environmentId is null) without a name
```

`GET /v1/runtime/connection` with the `x-api-key` header answers
`{ schemaVersion: 1, appId, environmentId, runnerKey, mode }`, with
`environmentId` null in development mode, 401 for an invalid
key, and 409 `{ code: 'connection_key_unbound' }` for a key that no pairing
issued. Errors carry the operation and the status only. The looked-up `appId`
must match the setup artifact of the code; a different app is an error.

## Sync

```ts
import { createManagedRuntimeSync } from 'glirastes/sync';
import { setupArtifact } from './src/generated/glirastes/tools.generated';

const runtimeSync = createManagedRuntimeSync({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  appId: connection.appId,
  environmentId: connection.environmentId,
  runnerKey: connection.runnerKey,
  version: '1.0.0',
  stateFilePath: '.glirastes/runtime-state.json',
  setupArtifact,
  validateDeployment: async (_deployment, revisions) => {
    await localBindings.assertModel(revisions.agentRevision.modelAlias);
    await localBindings.assertPrompt(revisions.agentRevision.promptBindingRef);
    await localBindings.assertTools(revisions.agentRevision.toolAllowlist);
  },
});

await runtimeSync.client.register({
  capabilities: { aiSdk: true },
  technicalMetadata: { runtimeVersion: '1.0.0' },
});
await runtimeSync.reportCapabilities();
void runtimeSync.client.start();
```

The runtime key must be scoped to exactly one target app. The client verifies
the Ed25519 signature, canonical content hash, content boundary, typed revision
schema, environment scope, and the supplied local-binding validator before it
reports a pending deployment as healthy.

Security revocations are persisted and surfaced before deployment candidates
are evaluated. Invalid or incomplete candidates never replace the last-known-
good state. Push notifications trigger an immediate sync; polling remains
active as the fallback. Stable and canary deployments are cached together and
selected by a deterministic subject cohort or an explicit approved pin.

Use `MemoryRuntimeStateStore` for the zero-setup embedded development path.
Long-lived and unattended runners should use `FileRuntimeStateStore` or provide
their own durable `RuntimeStateStore`.

## Code report and Platform decisions

With `setupArtifact` (the committed, content-free code report the generated
module exports) every registration carries the code version
(`capabilities.discoveryDigest`) and `capabilities.policyRelaxations: 1`, and
`reportCapabilities()` uploads the report once per process. Without it the
runner registers neither.

The chat runs on the local code. Compose each turn from the deployment the
sync manager accepted, so Platform decisions apply without a Platform call per
turn:

```ts
import {
  createLocalRuntimeSource,
  policyOverlayFromRevision,
} from 'glirastes/runtime';
import type { MaterializedDeploymentRevisions } from 'glirastes/sync';

let accepted: MaterializedDeploymentRevisions | undefined; // the active deployment

const source = createLocalRuntimeSource({
  setupArtifact,
  bindings,
  localLimits,
  identity: { tenantId, targetAppId: appId, environmentId },
  policyOverlay: () => accepted && policyOverlayFromRevision(accepted.policyRevision),
  platformRevisions: () => accepted,
  onPolicyOverlayApplied: (report) => console.info('glirastes policy overlay', report),
});
```

The source pins the revisions, budget and prompt revision of a turn by its
turn id; a continuation of the turn (for example an approval answer) runs on
the same pin. The principal is not pinned: every request of a turn uses the
principal resolved for that request, and tool discovery, the tool labels sent
to the chat (`data-tool-presentation`) and every tool call follow the same
decision (`authorizeToolCall` on the pinned revisions with that principal,
then the current revocations).

The model of a managed turn gets only the tools this decision allows, plus
the handler's own built-ins (clarification, plan, follow-ups, `find_tools`):
name, description and input schema of a tool the principal may not use, a
revoked tool or a registry tool outside the pinned manifest never reach it.
This holds with and without `toolDiscovery`. The tool set is decided at the
start of a request, with the principal and revocations of that moment. Before
every model step and on every `find_tools` search the handler resolves the
principal and loads the revocations again, as the guard does before every
call: a role lost or a revocation loaded in the middle of a multi-step request
takes the tool away from the next step and the next search, and a principal
that cannot be resolved any more leaves only the built-ins. The tool labels
(`data-tool-presentation`) are sent once, as of the start of the request. A
custom `streamHandler` gets the per-step check as `authorizedToolNames` in
its context and has to intersect its active tools with it. A legacy
`intentRouter` gets only these tool names as well (as of the start of the
request), since it may pass them to a model of its own; the built-in
start-set routing works on the same set. A tool with an approved call of an
earlier request stays in the tool set so that call gets its result, also when
the routing of the answering request does not select it. When the
principal may no longer use it, the model sees it as a stub: its name, the
neutral description "This tool is not available." and an input schema that
accepts any object, instead of its own description and input schema; the
guard then ends the call as a tool error. `authorizedToolsOnly: false` on
`createAiChatHandler` hands every registry tool to the model as before; the
guard still refuses the calls.

Only `tools`, the `intentRouter` names, `authorizedToolNames`,
`toolPresentation` and `find_tools` are reduced. Everything else the handler
passes to the app's own code in a managed turn is server-side app data and is
**not** filtered. An app that forwards it to a model (a prompt, a model of its
own) names tools the principal may not use:

- `systemPrompt` callback: `turnSnapshot` (the whole pinned manifest, agent
  and policy), `routing`, `pipelineResult`.
- `model` callback: `routing`, `pipelineResult`.
- `loadTools` and every tool's `execute`: `turnSnapshot` in the endpoint tool
  context, also for a direct command. The registry `loadTools` returns is the
  app's own and is filtered only afterwards.
- A custom `streamHandler`: `managedTurn.snapshot`, `routing`,
  `pipelineResult` (its `tools` are reduced).
- `onPipelineResult`: the `pipelineResult`.
- The app's own `pipeline` modules: `pipelineResult.tools` and
  `pipelineResult.module` carry the tool names the app configured there.
- The result of `intentRouter`: `routing.toolNames` is what the router
  returned, whatever names it was given.

A signed decision (`toolOverrides` of the policy revision) disables a tool,
raises its risk class, narrows its roles, requires confirmation, or replaces
its model-facing description. It never enables a tool the code lacks or keeps
disabled, and never lowers a risk class. It switches a confirmation off only
under all of these conditions (D16, see [tool policy](./tool-policy.md)):

- the decision is pinned to this tool at the risk class the code reported;
- the effective risk class is at most tier 2 (`write`) and not above the pin;
  a higher risk lets the relaxation lapse, and tier 3 always asks;
- the code report attributes the confirmation to the code default, so an
  explicit `"requiresApproval": true` in `.glirastes/tool-policy.json` (a local
  lock) always wins.

`onPolicyOverlayApplied` reports every attempted relaxation with its outcome
(`applied`, `locked-locally`, `override-lapsed-risk-raised`, …), content-free.
A runner that builds turn snapshots straight from Platform revisions passes
`relaxableToolIds: relaxableToolIds(setupArtifact)` to `createTurnSnapshot`;
without it nothing relaxes there, so register such a runner with
`setupArtifact` only once its snapshots get `relaxableToolIds`.

## Runtime metrics

A connected app reports one content-free event per chat turn
(`TechnicalRuntimeEvent` v2 from `glirastes/contracts`): tokens, cost with its
provenance, first-token and total latency, the outcome, and tool ids with call
and error counts. Prompts, messages, tool arguments, tool results, and secrets
never enter an event; both the SDK and the Platform refuse an event that
carries them.

`createGlirastes` creates the sink once the connection was looked up and
passes it with every `chatTurn()`; Standalone has none and stays silent. To
build one yourself:

```ts
import { createRuntimeMetricsSinkFromEnv } from 'glirastes/runtime';

// Undefined in Standalone (no GLIRASTES_API_KEY) and without a connection.
const metrics = createRuntimeMetricsSinkFromEnv(process.env, { connection });
```

The sink reads `GLIRASTES_API_KEY`, the optional
`GLIRASTES_CONTROL_PLANE_URL` and `GLIRASTES_BUILD_ID`; app and environment
come from the looked-up `connection`. Recording is
synchronous and cheap; batches of at most 50 events leave every five seconds,
off the turn. A slow, failing, or rejecting Platform drops the batch; metrics
never retry, never block a turn, and never keep the process alive. Create the
sink once per process at module scope, never per request: every sink draws its
own `instanceId`.

Cost is `provider-reported` when OpenRouter returns `usage.cost`, also through
`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' }).chat(model)`; use
`.chat`, because `createOpenAI(...)(model)` talks to the Responses API, whose
usage the handler does not read. An endpoint that refuses a call its tool
schema accepted (400 or 422) adds a content-free `tool_contract_rejected`
event to the same sink, in its own batch. A `modelPricing`
table on the handler estimates the rest (`price-table`, with its version).
Without either, the cost stays unknown (`null`), never 0. A known cost also
counts against the turn's `maxEstimatedCostUsd`. The legacy Lancer `telemetry`
option posts to `/v1/proctor/events`, which the Foundation control plane does
not serve; the handler refuses it together with `managedRuntime`.

### Failed tool calls

When the backend answers an endpoint tool's call with a non-2xx status, the
tool result tells the model what happened:

```ts
{ success: false, error: string, retryable: false, status: 403, body?: unknown, bodyTruncated?: true }
```

`status` is the HTTP status. `body` is the response body (parsed JSON, or its
text), omitted when there was none; a text body is cut to at most 4000
characters, a JSON body whose serialization is longer is replaced by that
serialization cut to at most 4000 characters, and both set
`bodyTruncated: true`. `error` is cut to at most 1000 characters. Both cuts
move back to the last whitespace or JSON delimiter (at most 256 characters; a
text without one there is cut at exactly the limit), so they end on a whole
token. Like any tool result, the failure goes through a configured PII shield
before the model reads it. The shield reads the cut text, which is why the cut
drops a partial token: a detector would not recognize an email address split
in the middle. This keeps single-token values whole. A value written with
spaces (an IBAN in groups, a phone number) can still be cut, and a detector
may then miss the part that remains. A call the
endpoint caller refused locally (a path outside `allowedPathPrefixes`) carries
its status but no body.

By default every failure counts as a tool error: against the turn's
`maxConsecutiveErrors` and as `toolErrorCount` and per-tool `errors` in the
metric event. Some failures are business outcomes rather than errors, e.g. a
403 for a user without the role, or a 409 with an app error code.
`classifyToolFailure` on `createGlirastes` (handed on by `chatTurn()`) or on
`createAiChatHandler` tells them apart:

```ts
const glirastes = createGlirastes({
  generated,
  classifyToolFailure: ({ toolName, status, body }) =>
    status === 403 || (body as { code?: string } | undefined)?.code === 'TASK_LOCKED'
      ? 'expected'
      : 'error',
});
```

It receives the endpoint tool's `toolName`, the status and the full parsed
body (not the truncated copy), runs synchronously, and is called only for real
backend responses: never for thrown errors (timeout, network, response size)
and never for local refusals. A throw or any value other than `'expected'`
counts as `'error'`. An expected failure still counts as a tool call and for
the other budgets (tool calls, repeated fingerprint, timeouts), but neither
increments nor resets the consecutive-error count, and it is no tool error in
the metric event. The result carries `expectedFailure: true`, so the model
knows the failure is a known outcome rather than a fault to retry.

Loop detection fingerprints an endpoint failure (a failure result with a
`status`) by its stable fields only: tool, arguments, `success`, `status`,
`retryable` and `expectedFailure`. `error`, `body` and `bodyTruncated` are
left out, because `error` is taken from the body (its text, or its `message`,
`error` or `detail`). A backend that stamps every error answer with a
timestamp or trace id therefore still trips the repeated-fingerprint limit
when the model repeats the same failing call, also for expected failures. Two
failures of the same call with the same status count as a repetition even when
their messages differ. A failure result without a `status` (a tool's own
`success: false`) keeps its `error` in the fingerprint.
Successful results are fingerprinted whole, as before.

Expected failures are counted locally only, as `expectedToolFailureCount` in
the handler's `onFinish` event. A direct command (a `/command` that runs its
tool without a model call) is classified the same way, so an expected failure
is no tool error in its metric event, but it never calls `onFinish` and is
therefore not part of that count. This version sends nothing about expected
failures to the Platform: the metric event keeps its fields. Without `managedRuntime` there is
no consecutive-error budget, so the classifier only affects the metrics there.
The runtime container cannot take a function in its JSON configuration and
keeps the default (every failure is an error).

#### Denied tool calls

With the default `authorizedToolsOnly`, a tool the principal may not use is
not offered to the model, so most denials never happen. Which answer a call
gets depends on whether the tool is in the request's tool set:

| Call | Answer |
| --- | --- |
| tool never offered in this request (default `authorizedToolsOnly`) | the AI SDK's tool error "Model tried to call unavailable tool ..." naming only the offered tools; the guard is not asked; the turn continues |
| tool offered at the start of the request and denied later in it, or any registry tool with `authorizedToolsOnly: false` | the managed guard decides, see below |

A call that was never offered does not execute and asks for no approval. It
is a tool call and a tool error in the metric event, but the guard does not
see it: it counts neither toward `maxToolCalls` nor `maxConsecutiveErrors`,
and no terminal condition ends the turn through it. A model that repeats it
stops at `maxModelSteps` (or the token, cost or time budget).

The managed guard checks every call that reaches it against the pinned
snapshot and the freshly resolved principal before it executes. The tool set
is fixed at the start of the request and only the offer narrows per step, so
with the default this is a tool that became denied after the request started;
pinned revisions do not change within a turn, which leaves a lost role
(`principal_role_denied`) and the terminal conditions. With
`authorizedToolsOnly: false` it is every call, including one to a registered
tool that tool discovery does not advertise. When the guard denies the call
because the tool is not available to this principal or agent revision, the
model receives a failed tool call and the turn continues, so it can answer
without the tool:

| Reason | Result |
| --- | --- |
| `principal_role_denied`, `policy_tool_denied`, `agent_tool_denied`, `manifest_tool_unavailable` | tool error `Tool execution denied: <reason> (<tool>)` to the model; the turn continues |
| `revoked`, `missing_principal`, `tenant_mismatch` | the turn ends with an error, as before |
| `budget_exhausted` | tool error naming the reached limit and its use to the model (see below); the turn stops at the runtime budget, as before |

The terminal conditions are checked first and independently of the tool: a
missing principal, then a tenant mismatch, then a current revocation of the
pinned agent or policy revision or of the tool. In any of these states the
turn ends with that reason, even when the call is to a tool that is not in the
manifest or would otherwise get a recoverable denial.

The guard's tool error names only the reason code and the tool, never the
policy, its roles or the principal. A denied call never executes and never asks for
approval, whatever the tool's policy says about confirmation. It always counts
as a tool call and toward `maxConsecutiveErrors`, so a model that keeps calling
denied tools stops at that budget; `classifyToolFailure` never sees a denial
and cannot mark it expected. In the metric event it counts as a tool call and
a tool error; the reason is not sent. The guard throws a
`ToolExecutionDeniedError` (`reason`, `toolName`, `recoverable`) from
`glirastes/runtime`; a terminal denial reaches the handler's `onError` with it.
Direct commands keep answering a denial with a `tool-output-error` whose
`errorText` is the reason code.

In a model turn the chat never sees the error message. A
`tool-output-error` (or the stream's `error` part) of a guard denial carries a
fixed text per reason; every other failed tool call keeps `AI request failed`,
except invalid input and an unavailable tool (see below):

| Reason | `errorText` in the chat |
| --- | --- |
| `principal_role_denied` | `You are not permitted to use this tool.` |
| `policy_tool_denied`, `agent_tool_denied`, `manifest_tool_unavailable` | `This tool is not available in this chat.` |
| `missing_principal` | `The user could not be identified; tool call refused.` |
| `tenant_mismatch` | `Tool call refused for this account.` |
| `revoked` | `This tool has been disabled.` |
| `budget_exhausted` | the reached limit, see below |

The handler's `onError` gets every failed tool call of a running turn once,
with a third argument `{ source: 'tool-call', kind }` (a failure of the request
or the whole turn keeps the two arguments): `kind: 'denied'` for a terminal or
budget denial (the `ToolExecutionDeniedError`), `'invalid-input'` for
arguments that do not match the schema (a `ToolInputValidationError` with
`toolName` and `issues`, never the arguments), `'failed'` for anything else (a
timeout, a thrown error). Not reported are a recoverable denial and a call of
a tool the model was not offered: the model gets them back as a normal part
of the turn. A throwing `onError` does not break the stream.

#### Invalid tool input

The AI SDK validates a model's tool call against the tool's input schema
before anything runs; no approval is asked, the guard does not see the call
(it counts toward no budget but `maxModelSteps`; the metric event counts a
call and an error) and the turn continues. The model gets the fields and what
the schema expects there, at most five issues (the rest counted), never the
value it wrote, and what to do:

```text
Invalid input for tool playlists_get: playlistId: expected format uuid; kind: required. Correct the arguments and call the tool again; look up missing ids with a read tool instead of asking the user.
```

The chat shows `The assistant sent invalid input for this tool; it was told
what to correct.` for the call (a call of a tool that was not offered: `This
tool is not available in this chat.`).

#### Budget denials

The effective budget of a turn is the minimum of the local limits, the
pinned agent revision and the policy revision. When it is reached, the guard
refuses every further tool call of the turn, also the rest of one step's
parallel calls; `read_result` counts as a tool call like any other. The
refused call is a tool error to the model that names each reached limit and
its use, and the chat shows the limit:

| Dimension | Model (`Tool call not executed: <limit>. Do not retry in this turn; tell the user which requests are still open.`) | Chat |
| --- | --- | --- |
| `maxToolCalls` | `the limit of 8 tool calls per turn is reached (8 used)` | `Tool call limit for this turn reached (8).` |
| `maxModelSteps` | `the limit of 6 model steps per turn is reached (6 used)` | `Step limit for this turn reached (6).` |
| `totalTimeoutMs` | `the time limit of 60 s per turn is reached (61.2 s elapsed)` | `Time limit for this turn reached (60 s).` |
| `maxInputTokens` | `the limit of 40000 input tokens per turn is reached (41002 used)` | `Input token limit for this turn reached (40000).` |
| `maxOutputTokens` | `the limit of 4000 output tokens per turn is reached (4100 used)` | `Output token limit for this turn reached (4000).` |
| `maxEstimatedCostUsd` | `the cost limit of 0.5 USD per turn is reached (0.5123 USD used)` | `Cost limit for this turn reached (0.5 USD).` |
| `maxRepeatedFingerprint` | `the limit of 3 identical tool calls with the same result per turn is reached (3 repeats)` | `Limit for repeated identical tool calls reached (3).` |
| `maxConsecutiveErrors` | `the limit of 3 consecutive tool errors per turn is reached (3 in a row)` | `Limit for consecutive tool errors reached (3).` |

Several reached limits are joined (`; ` for the model, a space in the chat).
The texts carry numbers only, no tool arguments or principal data. The
error keeps `reason: 'budget_exhausted'` and adds `budget`, one
`{ dimension, limit, used }` per reached limit; the metric event and
`onBudgetSignal` are unchanged. The turn ends with `safety-stop` /
`budget_exhausted`; how it closes its answer is described next.

`read_result` answers a read at the used-up budget with
`{ error: 'budget_exhausted', hint }`, the hint in the same words:
`Not read: the limit of 8 tool calls per turn is reached (8 used). Do not read
further in this turn; answer with what you have and tell the user that the
answer is incomplete.`

#### What the user sees when a turn stops at a limit

The handler checks the budget after every model step. When a limit is
reached (or the handler's step cap, `maxSteps`), no further tool runs and the
turn ends in one of two ways:

| Reached limit | How the turn ends |
| --- | --- |
| `maxToolCalls`, `maxRepeatedFingerprint`, `maxConsecutiveErrors` (tool limits) | one final model call without tools, with an instruction for this call only: say plainly that it had to stop at a limit, summarize what is finished, list what is still open, and say that an answer read in parts is incomplete |
| `maxInputTokens`, `maxOutputTokens`, `maxEstimatedCostUsd`, `totalTimeoutMs`, `maxModelSteps`, the step cap `maxSteps` | no further model call (it would exceed the limit itself); the handler closes the answer with the stop notice |

The handler also adds the stop notice when the final summary call fails or
says nothing, and when the turn's time limit aborts a running model call.
When several limits are reached at once and one of them is not a tool limit,
the turn gets no summary call. A turn that answers within its limits, a
clarification and a turn the user cancels get no notice. The notice is
written once, as its own text part of the assistant message (before
`finish`, the `error` part or the `abort` part), so the browser keeps it with
the message and the next turn's model sees that the earlier answer was cut
short. It names the reached limit and its value, never usage of other
dimensions, tool data or principal data:

```text
I had to stop here: the limit for this request was reached (input tokens: 40,000). The answer above may be incomplete. Ask me to continue to pick up where I left off.
```

The texts come from one table keyed by reason. `closing` is the whole notice
with `{reason}`; each reason has a text with `{limit}` (the number formatted
for `locale`, a duration as `150 ms` or `60 s`). Several reached limits are
joined with `; `. The handler ships English and German defaults (German for a
`locale` starting with `de`), exported as `DEFAULT_BUDGET_STOP_TEXTS` from
`glirastes/server/nextjs`; `budgetStopTexts` on `createAiChatHandler`
replaces single keys:

| Key | English default |
| --- | --- |
| `closing` | `I had to stop here: {reason}. The answer above may be incomplete. Ask me to continue to pick up where I left off.` |
| `maxSteps`, `maxModelSteps` | `the step limit for this request was reached ({limit} steps)` |
| `maxToolCalls` | `the limit for this request was reached (tool calls: {limit})` |
| `totalTimeoutMs` | `the time limit for this request was reached ({limit})` |
| `maxInputTokens` | `the limit for this request was reached (input tokens: {limit})` |
| `maxOutputTokens` | `the limit for this request was reached (output tokens: {limit})` |
| `maxEstimatedCostUsd` | `the cost limit for this request was reached ({limit} USD)` |
| `maxRepeatedFingerprint` | `the same tool call kept returning the same result (limit: {limit})` |
| `maxConsecutiveErrors` | `too many tool calls failed in a row (limit: {limit})` |

```ts
createAiChatHandler({
  locale: 'en-US',
  budgetStopTexts: { closing: 'Stopped early: {reason}. Ask me to continue.' },
  // ...
});
```

An unknown key or an empty text throws when the handler is created. The
status (`safety-stop`), the pipeline message (`Stopped at runtime budget:
<dimension>.`; a turn aborted by `totalTimeoutMs` now says so instead of
`Stopped by user.`), `onFinish` and the metric event are unchanged. A browser
that wants its own hint can read the `data-pipeline-state` part: `status:
'safety-stop'` and the dimension codes in `message`; there is no separate
machine-readable reason field.

Every tool result of a turn is sent again with every later model step, so
`maxInputTokens` counts it once per remaining step. Paging through a large
result with `read_result` (pages of up to `maxResultChars`, default 16,000
characters, roughly 4,000 tokens) therefore grows the turn's input tokens
quadratically. In a test with 45 entries of about 3,000 characters read in
pages of 10 (each page cut to 16,000 characters), the model calls cost about
0.1k, 0.7k, 4.7k, 8.7k, 12.6k and 16.6k input tokens (estimated at four
characters per token, without a real system prompt and tool definitions):
each page adds about 4k to every later call, and the sixth call passes the
default `maxInputTokens` of 40,000. The page fetched by the last call is
never seen by the model.

To allow more tool calls per turn, raise the local limit:
`createGlirastes({ localLimits: { maxToolCalls: 16 } })` (the runtime
container: `limits.maxToolCalls` in its JSON configuration, 1 to 100). The
agent revision and the policy revision still cap it: the lowest value wins.
