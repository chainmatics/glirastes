# Managed local runtime sync

`glirastes/sync` keeps signed Control Plane deployments in the customer
environment. Prompts, provider credentials, tool arguments, tool results, and
business data are never sent through this connection.

Most apps never call `glirastes/sync` directly. `createGlirastes` from
`glirastes/runtime` does all of the following for them (see the README,
"Standalone and Connected"). This page describes the parts underneath.

## Connect once, environments by name

One developer runs `glirastes connect` once. It issues one app connection key
and writes it to `.env.local` as `GLIRASTES_API_KEY`. In Citadel the approver
chooses the key lifetime: 90 days (the default), 1 year or no expiry. No
environment is chosen, and `.glirastes/platform-connection.json` holds no
environment id.

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
| `budget_exhausted` | the call fails and the turn stops at the runtime budget, as before |

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
