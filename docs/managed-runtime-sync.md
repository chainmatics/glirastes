# Managed local runtime sync

`glirastes/sync` keeps signed Control Plane deployments in the customer
environment. Prompts, provider credentials, tool arguments, tool results, and
business data are never sent through this connection.

Most apps never call `glirastes/sync` directly. `createGlirastes` from
`glirastes/runtime` does all of the following for them (see the README,
"Standalone and Connected"). This page describes the parts underneath.

## Connection

A connected app sets one variable, `GLIRASTES_API_KEY`.
`GLIRASTES_CONTROL_PLANE_URL` is optional (default
`https://api.glirastes.chainmatics.io`). The runtime asks the Platform which
app, environment and runner the key belongs to:

```ts
import { resolveRuntimeConnectionConfig } from 'glirastes/runtime';
import { lookupRuntimeConnection } from 'glirastes/sync';

const config = resolveRuntimeConnectionConfig(process.env); // undefined in Standalone
const connection = config && await lookupRuntimeConnection(config);
// { baseUrl, appId, environmentId, runnerKey }
```

`GET /v1/runtime/connection` with the `x-api-key` header answers
`{ schemaVersion: 1, appId, environmentId, runnerKey }`, 401 for an invalid
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
