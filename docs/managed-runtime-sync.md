# Managed local runtime sync

`glirastes/sync` keeps signed Control Plane deployments in the customer
environment. Prompts, provider credentials, tool arguments, tool results, and
business data are never sent through this connection.

```ts
import { createManagedRuntimeSync } from 'glirastes/sync';

const runtimeSync = createManagedRuntimeSync({
  baseUrl: process.env.GLIRASTES_URL!,
  apiKey: process.env.GLIRASTES_RUNTIME_KEY!,
  appId: process.env.GLIRASTES_APP_ID!,
  environmentId: process.env.GLIRASTES_ENVIRONMENT_ID!,
  runnerKey: 'get-it-done-production',
  version: '1.0.0',
  stateFilePath: '.glirastes/runtime-state.json',
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

## Runtime metrics

A connected app reports one content-free event per chat turn
(`TechnicalRuntimeEvent` v2 from `glirastes/contracts`): tokens, cost with its
provenance, first-token and total latency, the outcome, and tool ids with call
and error counts. Prompts, messages, tool arguments, tool results, and secrets
never enter an event; both the SDK and the Platform refuse an event that
carries them.

```ts
import { createRuntimeMetricsSinkFromEnv } from 'glirastes/runtime';
import { createAiChatHandler } from 'glirastes/server/nextjs';

// Undefined in Standalone (no GLIRASTES_CONTROL_PLANE_URL): no network at all.
const metrics = createRuntimeMetricsSinkFromEnv();

export const POST = createAiChatHandler({
  // ...model, tools, managedRuntime, systemPrompt
  metrics,
});
```

The sink reads the variables `glirastes connect` writes
(`GLIRASTES_CONTROL_PLANE_URL`, `GLIRASTES_API_KEY`, `GLIRASTES_APP_ID`,
`GLIRASTES_ENVIRONMENT_ID`) plus an optional `GLIRASTES_BUILD_ID`. Recording is
synchronous and cheap; batches of at most 50 events leave every five seconds,
off the turn. A slow, failing, or rejecting Platform drops the batch; metrics
never retry, never block a turn, and never keep the process alive. Create the
sink once per process at module scope, never per request: every sink draws its
own `instanceId`.

Cost is `provider-reported` when OpenRouter returns `usage.cost`, also through
`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' })`. A `modelPricing`
table on the handler estimates the rest (`price-table`, with its version).
Without either, the cost stays unknown (`null`), never 0. A known cost also
counts against the turn's `maxEstimatedCostUsd`. The legacy Lancer `telemetry`
option posts to `/v1/proctor/events`, which the Foundation control plane does
not serve; the handler refuses it together with `managedRuntime`.
