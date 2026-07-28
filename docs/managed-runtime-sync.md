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
