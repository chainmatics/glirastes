# Local runtime persistence

Interactive chat can start with the existing in-memory or browser session
adapter. Asynchronous, scheduled, unattended, or restart-resumable runs must
use a durable local runtime store:

```ts
import postgres from 'postgres';
import {
  assertRuntimePersistenceReady,
  createPostgresRuntimeStore,
} from 'glirastes/runtime';

const sql = postgres(process.env.DATABASE_URL!);
const runtimeStore = createPostgresRuntimeStore({
  unsafe: (query, parameters) => sql.unsafe(query, [...(parameters ?? [])]),
});

assertRuntimePersistenceReady({
  executionMode: 'unattended',
  resumableAcrossRestarts: true,
  store: runtimeStore,
});
```

The adapter persists three local concerns:

- conversations with verified tenant/owner scope, private or tenant
  visibility, expiry, deletion, and bounded tail projection;
- monotonic run checkpoints with optimistic sequence checks for safe resume;
- idempotent tool-execution claims and completion evidence, so a resumed run
  does not repeat an already completed side effect.

The tables contain customer content and therefore belong in the target
environment, never in the Glirastes Control Plane. The adapter does not send
network requests.

For local development, `runtimeStore.initialize()` creates the required
tables. Production applications should execute the exported
`POSTGRES_RUNTIME_STORE_SCHEMA_SQL` through their normal reviewed migration
process instead of granting DDL rights to the runtime.
