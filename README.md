# Glirastes

Glirastes is a TypeScript SDK for operating application features through an embedded chat.
Execution is local; the optional Platform manages connected instances and revisions.
The target environment keeps prompts, model calls, credentials, business data,
tool arguments/results, and final authorization. The Glirastes Platform is the
Control Plane for reviewed configuration, immutable signed revisions,
approvals, rollout, and content-free technical health.

> This is the in-development Foundation branch. Its `0.4.0` version label does
> not identify the same package contents as the currently published npm
> `glirastes@0.4.0`. The Foundation examples require this branch's build until
> a distinct release is published. One-command fresh-app bootstrap and fully
> automatic capability maintenance are MVP work in progress, not completed
> features implied by the prepared-pilot commands below.

## Foundation guarantees

- No Control Plane hop in a normal interactive turn.
- Server-verified principals and fail-closed local tool authorization.
- One pinned model/tool/policy snapshot per user turn.
- Immediate security revocations before the next tool call.
- Local multidimensional budgets, loop detection, timeouts, and circuit
  breakers.
- Vercel AI SDK 6 as the reference engine behind framework-neutral contracts.
- Local route discovery and assessment artifacts without mandatory decorators.
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
| `glirastes/server/nextjs` | Next.js chat handler |
| `glirastes/sync` | Signed revision cache, rollout selection, revocations |

NestJS, LangGraph and the older generator surfaces remain in source for later
acceptance; they are not exported by this Foundation package.

## Focused local intent routing

`createLocalAiPipeline` now defaults to focused routing. Confident intents get
their module tools plus its explicitly shared dependencies. Medium-confidence
intents expand only to shared tools of declared `relatedModules`. Uncertain or
unknown intents do not receive the full domain-tool catalogue.

The local pipeline marks its selection as explicit, so the Next.js handler
preserves even an empty selection. With managed-turn `toolDiscovery` enabled,
the existing local `find_tools` mechanism can load eligible tools on demand;
otherwise the model can ask a clarifying question without domain tools.
Selection does not replace endpoint authorization or turn guards.

For migration, `createLocalAiPipeline({ ...config, routingMode: 'legacy' })`
retains broad routing and the historical empty-selection convention. Direct
`createAiRouter` consumers keep legacy defaults unless they select
`routingMode: 'focused'`. Existing custom pipelines remain compatible; they
can return `toolSelection: 'explicit'` to opt into exact selection semantics.

Routing audit callbacks report strategy, module and tool count without raw
input. Smaller tool selections are not a claimed measured token/latency gain:
benchmark successful representative tasks in the target app.

## Route discovery boundaries

The scanner and execution-inventory verifier share syntax-tree recognition of
named function exports, constant arrow/function handlers and local aliases
such as `export { handler as GET }`. Comments and strings are not exports.
Syntax errors and unresolved wrappers/re-exports appear as bounded findings
in the local scan artifact. Legacy `scan --sync` refuses a partial scan rather
than treating undiscovered operations as removed; existing bindings remain
unchanged.

The TypeScript parser is a Node-side tooling dependency, not imported by the
React, server-handler or runtime entry points. Discovery never executes scanned
application source and does not automatically approve candidates. Dependency
graph resolution, automatic assessments and watch/build orchestration remain
separate MVP work; recognizing an export alone does not create a ready tool.

## Agent-led setup (local Foundation checkout)

With this SDK installed in the app, start its existing coding agent:

```bash
npx --no-install glirastes init
```

Inside a Codex or Claude session, the command installs project-local skills and
returns the integration task to that same agent. The agent must continue through
source-derived bindings, UI integration and a real authorized tool action; the
command does not report those as completed just because skills were installed.
From an interactive terminal, choose an installed CLI (`--agent codex` or
`--agent claude` if needed). It runs with its existing model and permission
settings. No additional assessment key, provider switch or permission bypass is
added. Its login is not a transferable credential for the app's chat model.

Preview without changes or an agent process:

```bash
npx --no-install glirastes init --agent codex --dry-run --json
```

`--root` selects the app directory. Modified installed skills are preserved;
the agent also receives the bundled canonical workflow to reconcile safely.
`--json` is available for preview and same-session continuation, not an external
interactive agent's terminal stream. JSON never prompts for a host choice.
An existing agent session cannot launch a different nested agent through init.
Both init and `setup inspect` skip implicit environment-file loading.

After an external agent exits, init runs the real offline Doctor. A nonzero
agent exit, failed checks or zero tools are not success. The interactive CLI may
stay open until you exit it; Doctor runs afterward. A passing Doctor still is
not live tool-action evidence. Fresh-app timing and three-stack end-to-end
acceptance remain open; the initializer does not imply universal framework
support. Use the exact Foundation package checkout: the historical public
`0.4.0` package has a different surface despite the same version number.

## Next.js local validation and optional connection

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

`doctor` explains local checks in plain language and gives one next action when
something needs attention. Use `doctor --verbose` for technical codes or
`doctor --json` for the structured agent-readable report. A passing Doctor is
not proof that the Platform is reachable, an update is active, or a chat/tool
action has succeeded; those require separate live checks. Fresh projects still
need their local integration generated before setup can validate it.

For local coding-agent intake before any Glirastes artifacts exist, run
`glirastes setup inspect --json` from the app folder. It reports separate
manifest components and declared Next.js, React, Vue, NestJS or FastAPI markers;
it does not pair unrelated components or certify framework support, installed
runtimes, authentication, or executable tools. Node package manifests and direct
Python requirements are inspected; `pyproject.toml` presence is only a Python
hint, not parsed dependency evidence. Linked, hidden, generated and dependency
directories are skipped, with bounded traversal and findings for incomplete or
invalid input. No source code or scripts are executed, environment files are
not read, and nothing is sent to the Platform. This local-only report is not a
sync artifact or a finished one-command integration.

Inspection rechecks canonical paths as it traverses and reads them, including
directories replaced by links after discovery. It is not an OS filesystem
sandbox: run it against a trusted, stable checkout, not one being adversarially
rewritten concurrently.

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

This route-only scan is not the fresh agent workflow or automatic UI discovery.
The agent assesses actual local code and generates validated local metadata;
Platform review is optional. Local prompts and executable schemas never go to
the Platform. Preserve existing reviewed policy and identity when connected.

The earlier `glirastes setup sync` form remains a compatibility adapter.
New integrations should use the explicit `setup`,
`connect`, `sync`, and `doctor` lifecycle above. The legacy route-import flow
remains separately available for migrations that still regenerate bindings:

```bash
npm run glirastes:sync
```

That migration script should call `glirastes scan --sync`, pass its generated
local execution inventory, and regenerate the target-specific local registry.
No provider secret, tool credential, raw prompt, argument, result, or business
content is uploaded. Bounded technical capability descriptions may be synced.

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
npx --no-install glirastes install --host codex --with-setup-skills
```

They teach local agent integration, source-derived tool maintenance and the
React/STT contract. Installation alone does not integrate an app. `init` above
connects installation to the selected agent workflow. See [skills](./skills/README.md).

## Foundation verification

Before promotion, prove:

- fresh app → agent setup → base UI → first real tool action in under five
  minutes, with no mandatory Platform account;
- negative principal, role manipulation, cross-tenant, approval replay, and
  revocation tests;
- no content egress on the normal chat path;
- unit, contract, integration, browser, migration, and rollback tests;
- UI behavior, STT quality/finalization latency, server latency, and bundle
  size against the target-app baseline.

## License

Apache-2.0
