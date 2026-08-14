# Glirastes

Glirastes is a managed-local TypeScript runtime for AI chat and tool execution.
The target environment keeps prompts, model calls, credentials, business data,
tool arguments/results, and final authorization. The Glirastes Platform is the
Control Plane for reviewed configuration, immutable signed revisions,
approvals, rollout, and content-free technical health.

## Foundation guarantees

- No Control Plane hop in a normal interactive turn.
- Server-verified principals and fail-closed local tool authorization.
- One pinned model/tool/policy snapshot per user turn.
- Immediate security revocations before the next tool call.
- Local multidimensional budgets, loop detection, timeouts, and circuit
  breakers.
- Vercel AI SDK 6 as the reference engine behind framework-neutral contracts.
- Scan and Platform interview instead of required decorators or hand-authored
  semantic tool metadata.
- One React chat implementation with provider-neutral push-to-talk STT.

## Package surface

| Import | Purpose |
|---|---|
| `glirastes/contracts` | Principals, budgets, manifests, revisions, deployments |
| `glirastes/runtime` | Local authorization, pinned turns, budgets, durable stores |
| `glirastes/ai-sdk` | Vercel AI SDK reference engine |
| `glirastes/runtime/ai-sdk` | Vercel AI SDK reference-engine adapter |
| `glirastes/stt` | Provider-neutral recording state machine and STT adapters |
| `glirastes/react` | Chat composition, sessions, actions, STT |
| `glirastes/react/vercel` | AI SDK React transport and `VercelAiChat` |
| `glirastes/adapter/nextjs` | Next.js application adapter |
| `glirastes/adapter/nestjs` | NestJS application adapter |
| `glirastes/server/nextjs` | Next.js chat handler |
| `glirastes/server/nestjs` | Framework adapter surface |
| `glirastes/sync` | Signed revision cache, rollout selection, revocations |

## Next.js pilot path

Install the SDK, an AI SDK provider, and the React peers:

```bash
npm install glirastes @ai-sdk/openai @ai-sdk/react react-markdown
```

Once the app has its positive execution inventory, curated setup artifact,
prompt bundle, and server-verified principal declaration, the complete local
setup is three commands with no repeated app or artifact flags:

```bash
npx glirastes setup --dry-run
npx glirastes setup
npx glirastes doctor
```

The dry run is deterministic, read-only, and network-silent. Normal setup
validates the same plan, requires the exact plan digest for any semantic
loosening, and atomically adopts the complete local artifact set. Standalone is
the default and never contacts the Control Plane. Restart the application after
setup because Standalone materializes its runtime snapshot only at boot.

To add the optional Connected Free Control Plane without repeating setup, pair
the already validated local app once:

```bash
npx glirastes connect --base-url https://platform.example.com
```

The CLI opens only the verification URL returned by that Control Plane, waits
for browser approval, and writes the app-scoped connection atomically. The
local secret target must already be ignored by Git. Pairing never uploads
prompts, schemas, source, credentials, tool arguments, results, or business
content. Restart the application after connecting.

After local setup changes, synchronize the already validated canonical
artifact without repeating setup, discovery, or assessment:

```bash
npx glirastes sync
npx glirastes doctor
```

`sync` verifies the current setup receipt, app and environment scope, tracked
connection descriptor, and ignored project-local secret before it contacts the
Control Plane. It creates or resumes only the app-scoped setup run and uploads
the identical artifact idempotently. It never creates an environment, publishes
a revision, activates a deployment, or changes the network-silent Local
default. `doctor` performs the same local Connected checks without a network
request and never prints credential values.

Managed setup is always explicit:

```bash
npx glirastes setup --managed
npx glirastes doctor --managed
```

It requires an existing app plus the app-scoped Control Plane connection. Setup
never creates an app or environment and never bypasses publication, approval,
signing, health, activation, or rollback gates.

Scan existing routes without changing them:

```bash
npx glirastes scan
```

Review ambiguous or critical candidates in the Platform interviewer. Semantic
descriptions and approval policy live there. The target project keeps only
content-free fingerprints, schema digests, local execution bindings, and
Platform UUID references.

The earlier `glirastes setup sync` and `glirastes setup --managed` forms remain
compatibility adapters. New integrations should use the explicit `setup`,
`connect`, `sync`, and `doctor` lifecycle above. The legacy route-import flow
remains separately available for migrations that still regenerate bindings:

```bash
npm run glirastes:sync
```

That migration script should call `glirastes scan --sync`, pass its generated
local execution inventory, and regenerate the target-specific local registry.
No provider secret, tool credential, prompt, description, argument, result, or
business content is uploaded.

Every integration must provide a server-only resolver:

```ts
resolvePrincipal(request) => {
  subjectId,
  tenantId,
  roles,
  attributes,
}
```

All fields come from the verified server session or trusted identity source,
never from unchecked client fields. The actual endpoint remains the final
authorization boundary.

Mount the shipped UI instead of copying it:

```tsx
'use client';

import { VercelAiChat } from 'glirastes/react/vercel';
import 'glirastes/react/styles.css';

export function ChatWidget() {
  return <VercelAiChat endpoint="/api/ai/chat" />;
}
```

Use themes, slots, session adapters, tool renderers, and
`useAiClientAction` for product-specific UX.

## Speech-to-text

The React STT controller owns exactly one state machine and microphone stream.
It supports push-to-talk, visible interim text, lossless finalization,
edit-before-send, and explicit stop/cancel/retry/cleanup semantics. Capture and
provider traffic stay in the target environment. TTS and full duplex voice are
outside the first foundation.

## Durable local execution

Simple interactive chat may remain ephemeral. Asynchronous, scheduled,
unattended, or restart-resumable execution must pass the durable-store gate.
`glirastes/runtime` includes a PostgreSQL adapter for:

- tenant/owner-scoped conversations with visibility and retention;
- monotonic resumable checkpoints;
- idempotent tool-execution claims and completion evidence.

See [local runtime persistence](./docs/runtime-persistence.md).

## Managed revision sync

`glirastes/sync` verifies Ed25519 signatures, hashes, typed payloads,
environment scope, and local bindings before activation. It supports push with
polling fallback, last-known-good, stable/canary selection, pinning, health
gates, rollback, and persisted security revocations.

See [managed local runtime sync](./docs/managed-runtime-sync.md).

## Agent skills

Install the bundled foundation skills with:

```bash
npx glirastes install-skills
```

They teach the scan/sync integration, tool revision workflow, and current
React/STT contract. See [skills](./skills/README.md).

## Foundation verification

Before promotion, prove:

- scan → Platform review → sync → base UI → first real tool action in under
  five minutes;
- negative principal, role manipulation, cross-tenant, approval replay, and
  revocation tests;
- no content egress on the normal chat path;
- unit, contract, integration, browser, migration, and rollback tests;
- UI behavior, STT quality/finalization latency, server latency, and bundle
  size against the target-app baseline.

## License

Apache-2.0
