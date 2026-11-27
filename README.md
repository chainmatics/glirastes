<p align="center">
  <img src=".github/assets/logo.png" alt="Glirastes logo: an orange mycelium mark" width="120">
</p>

<h1 align="center">Glirastes</h1>

<p align="center">
  <em>The agentic framework that takes root in your product.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/glirastes"><img src="https://img.shields.io/npm/v/glirastes?style=flat-square&color=f2a618" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f2a618?style=flat-square" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020.6-f2a618?style=flat-square" alt="Node >= 20.6">
  <img src="https://img.shields.io/badge/TypeScript-ready-f2a618?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="https://glirastes.io"><b>Website</b></a> ·
  <a href="#quickstart-nextjs-app-router"><b>Quickstart</b></a> ·
  <a href="https://glirastes.io/docs"><b>Documentation</b></a> ·
  <a href="skills/"><b>Skills</b></a> ·
  <a href="CHANGELOG.md"><b>Changelog</b></a>
</p>

<p align="center">
  <a href="https://glirastes.io"><img src=".github/assets/hero-landing.gif" width="100%" alt="The glirastes.io hero: an orange mycelium network pulses behind the headline &quot;The agentic framework that takes root in your product.&quot; and the npm install glirastes command."></a>
</p>

Glirastes is a TypeScript SDK for an embedded chat that operates your app: it
calls your endpoints, navigates, sets filters and triggers UI actions. The tools
come from your code or OpenAPI export, execution stays in your environment, and the optional Glirastes
Platform manages reviewed configuration and rollouts without ever seeing prompts
or business data.

## Choose your integration

Choose the backend host and browser UI independently:

| Your application | Recommended path |
| --- | --- |
| Existing suitable Node/Next.js server | Embed the SDK and its HTTP handler; use the Next.js quickstart below or `glirastes/server/http` |
| Rust, PHP, Java or another HTTP backend without a suitable Node host | Deploy the official configured runtime container beside the app; supply OpenAPI 3.0 or 3.1 JSON, an authenticated identity endpoint and JSON configuration |
| React frontend | Use `VercelAiChat` and the React navigation/action hooks |
| Angular, SvelteKit, Nuxt, Vue or plain JavaScript frontend | Mount `<glirastes-chat>` client-side and connect the app's router/actions through `glirastes/browser` |

### Runtime container for Rust, PHP and Java

The public image needs no registry login and no customer-written Node server:

```sh
docker pull ghcr.io/chainmatics/glirastes-runtime:0.27.0
docker run --rm ghcr.io/chainmatics/glirastes-runtime:0.27.0 --help
```

Run **one active service per app/environment**, independently of backend replica
count. A separate service is not automatically a sidecar per backend instance.
V1 uses PostgreSQL for approval consumption and an overlap guard; it does not
provide HA. Keep the user's cookie/bearer token and all backend permissions.

Start with the [runtime guide](docs/runtime-container.md),
[image and artifact commands](https://github.com/chainmatics/glirastes/blob/v0.27.0/containers/runtime/README.md), and the
[PHP example with Docker Compose](https://github.com/chainmatics/glirastes/blob/v0.27.0/examples/php-runtime/README.md).
Pin the image digest and use its exact SDK version for artifacts and browser code.
Angular, SvelteKit and Nuxt have [tested browser examples](https://github.com/chainmatics/glirastes/blob/v0.27.0/examples/frontend-frameworks/README.md).
Those tests cover frontend integration; Rust/Java remain generic HTTP/OpenAPI
paths, and unknown routers have no automatic page discovery. See the
[support matrix](docs/support-matrix.md) for the evidence at each layer.

## See it in action

<p align="center">
  <img src=".github/assets/chat-demo.gif" width="100%" alt="A task board app with the Glirastes chat docked on the right. The user asks to move the Q4 report to Finance and assign it to Lena; the assistant looks up the task and the person, asks for approval of tasks.update, and after Approve the card moves to the Finance column with Lena as assignee.">
</p>

<p align="center"><sub>One request moves a card on a task board: the chat finds the task and the person, asks for approval of <code>tasks.update</code>, then acts.</sub></p>

## Quickstart (Next.js App Router)

### With a coding agent (recommended)

```bash
npm install glirastes @ai-sdk/openai @ai-sdk/react react-markdown
npx --no-install glirastes init
```

Run `init` inside Claude Code or Codex (Node >= 20.6). Your agent then derives
the tools from your routes, adds the chat route and the chat UI, and asks once
whether the app runs Standalone or with the Platform. Existing files are never
replaced; `--dry-run --json` previews without writing anything.

### By hand

**1. Install** the SDK and the chat peers (Node >= 20.6):

```bash
npm install glirastes @ai-sdk/openai @ai-sdk/react react-markdown
```

The SDK depends on `zod` 4 (`^4.0.0`): an app on zod 4 shares its copy, an
app on zod 3 gets a second zod 4 copy for the SDK. App schemas keep working
either way because the SDK reads schemas by shape; the cost is disk and bundle
size, and the zod 4 contract schemas the SDK exports cannot be nested inside
zod 3 schemas. `pg` (`>=8.11 <9`) is used only by the `glirastes-runtime`
binary, so any pg 8.11+ in the app is shared.

Upgrading from 0.19.0 or older with an existing bun lockfile: the lockfile keeps a
nested `glirastes/pg` (the old range was `^8.23.1`), because bun keeps such entries
while they satisfy the new range. `bun install --force` and `bun update glirastes`
do not remove it. With a text `bun.lock`, run
`bun remove glirastes && bun add glirastes@<version>`, or delete the
`"glirastes/pg"` line and run `bun install`. With a binary `bun.lockb`, remove and
add was not enough in our tests (bun 1.4.3); convert first with
`bun install --save-text-lockfile` (it replaces `bun.lockb` with `bun.lock`), then
remove and add, or run `bun update pg` (raises the app's own pg range).

A nested `glirastes/zod` has a different cause and comes back on every remove and
add, in both lockfile formats: bun resolves the SDK's `^4.0.0` to the newest zod
already in the lockfile, not to the app's top-level copy. So when another
dependency needs a newer zod than the app's locked one (app 4.3.6, a package with
`4.4.3` or `^4.4.3`), the SDK gets that newer copy. Fixes, verified for both formats:

- Raise the app's own zod to that version: `bun add zod@^4.4.3`. One copy for
  the app, the SDK and that package.
- `bun update zod`: the app moves to the newest zod in its range (and its range in
  `package.json` with it); the SDK shares it, a package that pins an older exact
  zod keeps its own copy.
- `"overrides": { "zod": "4.4.3" }` in the app's `package.json`: one copy, but it
  also replaces the zod of packages that declare zod 3.
- Text `bun.lock` only: delete the `"glirastes/zod"` line and run `bun install`;
  the next `bun add glirastes@…` brings it back.
- Delete the lockfile and run `bun install`: works, but re-resolves every
  dependency to the newest version in its range.

`bun add zod@latest` and converting to `bun.lock` alone do not remove it. Check with `bun pm ls --all | grep -E 'zod@|pg@'`: bun leaves the old nested
folder in `node_modules`, so delete `node_modules` and run `bun install` before
looking there. Two zod 4 copies work: the SDK reads schemas by shape, and zod 4
shares its metadata registry and `instanceof` checks across copies; the cost is
disk and client bundle size.

**2. Initialize.** Run it inside your Codex or Claude Code session, or from a
terminal with `--agent codex|claude`:

```bash
npx --no-install glirastes init
```

`init` writes `.glirastes/tools.json`, `.glirastes/prompt-bundle.json`, the
`predev` / `prebuild` scripts (`glirastes tools refresh`, plus the voice
worklet copy `glirastes stt worklet` for Next.js, Vite and Create React App) and a short hint in
`AGENTS.md` / `CLAUDE.md`, installs the [agent skills](#agent-skills) and hands
the integration to your coding agent. Existing files are never replaced.

**3. Derive the tools** from your routes, pages, URL filters and client actions:

```bash
npx glirastes tools refresh
```

This writes the committed `.glirastes/` tool files and the generated module
`src/generated/glirastes/tools.generated.ts`.

**4. Add the chat route.** Identity comes from your verified session; your
endpoints keep their own authorization.

```ts
// src/app/api/chat/route.ts
import { createOpenAI } from '@ai-sdk/openai';
import { createGlirastes } from 'glirastes/runtime';
import { createAiChatHandler } from 'glirastes/server/nextjs';
import * as generated from '@/generated/glirastes/tools.generated';
import { resolvePrincipal } from '@/lib/glirastes-principal'; // your session lookup

const glirastes = createGlirastes({ generated });
const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const principal = await resolvePrincipal(request); // { subjectId, tenantId, roles, attributes }
  if (!principal) return new Response('Unauthorized', { status: 401 });
  const turn = await glirastes.chatTurn((runtimeTenantId) => ({ ...principal, tenantId: runtimeTenantId }));
  return createAiChatHandler({
    ...turn,
    model: openrouter.chat('anthropic/claude-sonnet-5.5'),
    systemPrompt: 'Use the tools of this app. Ask one short question when the target is unclear.',
    toolDiscovery: true,
  })(request);
}
```

OpenRouter is only the example. `model` takes any Vercel AI SDK provider,
including a local OpenAI-compatible server such as Ollama or LM Studio
(`createOpenAI({ baseURL: 'http://localhost:11434/v1' })`); Glirastes adds no
model charges of its own.

Budgets default to safe values; pass `localLimits: { maxToolCalls: 4 }` to override single fields.
A failed backend call reaches the model with its HTTP `status` and response
`body`; pass `classifyToolFailure: ({ status, body }) => 'expected' | 'error'`
to keep business outcomes such as a 403 out of the error budget and metrics
(see [docs/managed-runtime-sync.md](docs/managed-runtime-sync.md#failed-tool-calls)).
`toolDiscovery: true` turns on routing: each turn starts with the few tools the
request needs plus `find_tools`, not the whole tool list (see [How it works](#how-it-works)).

Before production set `GLIRASTES_APPROVAL_SECRET` (at least 16 characters, the
same on every instance): it signs each approval so a forged or edited chat
history runs nothing. Request limits, multi-instance setups and the rest are in
[docs/chat-route-security.md](docs/chat-route-security.md).

**5. Mount the chat** and the navigation bridge (client components):

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useGlirastesNavigationBridge } from 'glirastes/react';
import { VercelAiChat } from 'glirastes/react/vercel';
import 'glirastes/react/styles.css';

export function Assistant() {
  const router = useRouter();
  useGlirastesNavigationBridge({ push: (href) => router.push(href) });
  return <VercelAiChat endpoint="/api/chat" />;
}
```

**6. Run** `npm run dev` (the `predev` script refreshes the tools), then check
the setup with `npx glirastes doctor`.

The full walkthrough, including filters, client actions, `@` mentions and `/`
commands, is the bundled skill
[`integrating-glirastes-nextjs`](skills/integrating-glirastes-nextjs/SKILL.md).

## How it works

- **Execution is local.** The model call, the tool loop and every tool call
  run in your app's Node server or the customer-hosted runtime service. A normal chat turn makes no request to the
  Platform.
- **Your app keeps the sensitive parts.** Prompts, model calls and provider
  keys, secrets, business data, tool arguments and results, and final
  authorization stay in the app. `resolvePrincipal` only says who asks; each
  endpoint still checks its own session and permissions.
- **Guard rails per turn.** Each turn runs on one pinned tool and policy
  snapshot, with local budgets (steps, tool calls, tokens, cost, timeouts),
  loop detection over a normalized fingerprint of tool, arguments and result
  (the same call with new data is progress, an identical repeat is a loop) and
  fail-closed authorization. Write and delete tools ask
  the user before they run.
- **Small start set per turn.** With `toolDiscovery`, the handler groups the
  generated tools into modules (module, kind, usage hints, synonyms), matches
  the request locally in German and English and starts the turn with those
  tools, `ui_navigate` and `find_tools`; the model widens the set with
  `find_tools` when it needs more. A follow-up keeps the tools of the previous
  turn. Tune it with `intentRouting: { maxStartTools, alwaysAvailable }` or
  `examples` in `toolSemantics`, replace it with your own `intentRouter`, or
  turn it off with `intentRouting: false`. Routing never grants a tool the
  user may not use.
- **Lean history.** Earlier turns go to the model compacted (`history`), and
  the system prompt and tools stay a stable, cacheable prefix
  (`promptCaching`).
- **No technical ids in answers.** `hideIds` (on by default) tells the model
  not to write ids and replaces one it writes anyway with the readable label
  from the tool result, or removes it.
- **The Platform gets metadata only.** A connected app sends content-free
  metrics (tokens, cost, latency, errors, tool use) in batches off the turn
  path, and receives signed configuration revisions.

## Tools from your code

`glirastes tools refresh` derives endpoint, navigation, filter and
client-action tools from Next.js, NestJS, OpenAPI (FastAPI), react-router and
vue-router sources, and from `useAiClientAction` registrations. The output is
committed with the code; `glirastes tools check` fails CI when it is stale.

```bash
glirastes tools refresh           # derive tools (--watch next to `next dev`)
glirastes tools status            # what the chat can do
glirastes tools check             # verify committed outputs, no model, no network
glirastes tools eval              # every example sentence finds its tool
glirastes upgrade report          # what changed since you last reviewed the SDK (then: upgrade ack)
glirastes upgrade offers          # optional features the app does not use yet
```

**Policy.** Reads run directly, writes ask first, deletes and anything
external or financial always ask. Change that locally with
`glirastes tools policy` (`show`, `disable`, `confirm`, `relax`, `raise`,
`roles`, `exclude`, ...); it writes `.glirastes/tool-policy.json`. See
[docs/tool-policy.md](docs/tool-policy.md).

**OpenAPI opt-in.** With `"selection": "opt-in"` on the `openapi` source only
operations marked `x-glirastes-tool: true` become tools; `x-glirastes-name`,
`x-glirastes-group` and `x-glirastes-roles` set their name, module and code
default roles (local policy and Platform only narrow them). See
[the extension table](docs/tool-policy.md#openapi-source-selection-and-x-glirastes--extensions).

**Describing tools.** The source generator never calls a model. Descriptions,
synonyms and example calls are written by a coding agent from work lists;
the chat runtime uses your configured model provider:

- **Free:** your own coding agent works through `glirastes tools resolve --print`
  and `glirastes tools describe --print` with the shipped skills
  `maintaining-glirastes-tools` and `describing-glirastes-tools`, and you
  commit the result.
- **Pro:** the managed CI tool agent (`glirastes tools enrich --managed`)
  runs the same skills in your CI, only on tools whose semantics are
  missing or stale, and commits the result as `glirastes-bot` in one commit
  that passes `glirastes tools check`. It never rewrites current entries,
  human or locked fields, and does nothing on a promotion between
  environment branches. Model requests go
  through OpenRouter with the routing the Platform grants for the job (no
  data collection, zero data retention), or your own key in
  `GLIRASTES_TOOLS_OPENROUTER_KEY`. Requires the optional peer
  `@ai-sdk/openai`.

## CI

```bash
npx glirastes init --ci github [--enrich-on staging,main] [--ci-environment staging]
```

writes `.github/workflows/glirastes-tools.yml` for your package manager with
two jobs:

| Job | What it does | Needs |
|---|---|---|
| `glirastes-tools` | `tools check` and `tools eval` on every pull request and push to `main` | nothing: no secrets, no model |
| `glirastes-tools-enrich` (Pro) | runs the managed tool agent on pull requests and commits into the PR branch | variable `GLIRASTES_MANAGED_TOOLS=true`, variable `GLIRASTES_CONTROL_PLANE_URL`, secret `GLIRASTES_CI_KEY` |

- `--enrich-on <branch,...>` (or `--enrich-on-main`) also runs the agent
  after pushes to those branches; there it opens a pull request instead of
  committing, and the workflow gets a manual start that works the whole
  backlog once.
- New code is described where it enters the environment chain; a promotion
  (a pull request whose head is an environment branch, or whose head commit
  another environment branch already holds, e.g. a release branch) is a fast
  no-op. Set the chain, lowest first, in `.glirastes/tools.json`:
  `"enrich": { "environments": ["dev", "staging", "main"] }`, or with the
  repository variable `GLIRASTES_ENVIRONMENT_BRANCHES=dev,staging,main`.
  Without it the job uses the usual names (`dev`, `staging`, `main`,
  `master`, `prod`, …) that exist on origin.
- `--ci-environment <name>` reads the three values from that GitHub
  environment instead of the repository.
- Set the variable `GLIRASTES_BOT_APP_ID` and the secret
  `GLIRASTES_BOT_APP_PRIVATE_KEY` to push as a GitHub App, so the bot's
  commits and pull requests trigger your checks. Without them the job uses
  the workflow token.
- An existing workflow with other content is refused unless you pass `--force`.

## Chat UI & speech

`glirastes/react` ships one chat implementation; `VercelAiChat` from
`glirastes/react/vercel` connects it to the AI SDK route.

- Docked sidebar or floating window (`AssistantWorkspace`, `AssistantToggle`),
  themes, slots, tool result renderers and approval cards.
- `useAiClientAction(id, handler, contract, { route })` lets the chat drive UI
  state; `refresh` turns each registration into a tool. With `route` the chat
  opens that page first when the user is elsewhere.
- Generic `@` mentions and `/` commands derived from your tools
  ([docs/chat-interactions.md](docs/chat-interactions.md)); `useChatComposerInput`
  keeps them in a custom input.
- A per-message work log of tool calls and an optional plan checklist.
- Opt-in image and PDF attachments (paperclip, paste, drop;
  [docs/chat-attachments.md](docs/chat-attachments.md)).
- Opt-in message queue: send while a turn runs or an approval waits, the
  message goes once the chat is idle ([docs/chat-queue.md](docs/chat-queue.md)).
- Opt-in chat views: the model composes a small view (table, key figures,
  status overview) from the app's own components, with every value a
  reference to a real tool result ([docs/chat-views.md](docs/chat-views.md)).
- `unstyled` to bring your own CSS; `deChatLocale` for German texts.
- Push-to-talk speech input through one STT controller (`voice` config,
  `glirastes/stt` adapters, `createRecordingTranscriptionHandler` for a
  server-side transcription route). Audio goes from the app to its own
  provider, never through Glirastes.
- Without React: the `<glirastes-chat>` element from `glirastes/embed` and the
  bridge in `glirastes/browser`.

See the skill [`building-glirastes-chat-ui`](skills/building-glirastes-chat-ui/SKILL.md).

### Voice input: adapter and route

`voice: { enabled: true }` alone uses `DeepgramSttAdapter`: it streams the
microphone over a WebSocket to `/api/ai/speech-stream` (or `voice.baseUrl`,
with `voice.getToken` as `?token=`) and expects Deepgram live results there.
This package ships no server for that socket; the app provides it.

For a Whisper-style service (OpenAI, OpenRouter, a local Parakeet or Whisper
server with `POST /v1/audio/transcriptions`) pass a `RecordedSttAdapter`. It
records until stop and posts one `audio/wav` to `/api/ai/speech-recognize`:

```tsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import { RecordedSttAdapter } from 'glirastes/stt';

// Module scope keeps the instance stable; a new one restarts the controller.
const speech = new RecordedSttAdapter();

export function Assistant() {
  return <VercelAiChat endpoint="/api/chat" voice={{ enabled: true, adapter: speech }} />;
}
```

The route forwards the recording with `createRecordingTranscriptionHandler`;
URL, key and model stay on the server:

```ts
// app/api/ai/speech-recognize/route.ts
import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
import { resolvePrincipal } from '@/lib/auth'; // your own session check

export const runtime = 'nodejs';
export const POST = createRecordingTranscriptionHandler({
  authorize: async (request) => Boolean(await resolvePrincipal(request)),
  url: 'https://api.openai.com', // OpenRouter: 'https://openrouter.ai/api'
  apiKey: process.env.OPENAI_API_KEY,
  model: 'whisper-1', // OpenRouter: 'openai/whisper-1'
});
```

- `url` is the base without `/v1`: the handler appends
  `/v1/audio/transcriptions`. `https://openrouter.ai/api/v1` would call
  `/api/v1/v1/…` and fail.
- `authorize` returning `false` answers 401 before the audio is read; an unset
  `url` answers 503. `languages` and `defaultLanguage` (default `de`) limit the
  `?language=` the browser sends.
- Transcribing inside your own server instead: `transcribe` with
  `createLocalTranscriber` from `glirastes/server/stt-local`
  ([docs/local-stt.md](docs/local-stt.md), experimental).
- Both adapters need the audio worklet below.

### Voice input needs the audio worklet

Every recording loads `/audio-worklet-processor.js` (package export
`glirastes/react/audio-worklet-processor.js`); without it voice input fails
with an error next to the mic button and a `console.error` naming the URL.
`glirastes init` sets this up for Next.js, Vite and Create React App. In an
existing app, chain the copy step in front of your scripts:

```json
"scripts": {
  "predev": "glirastes stt worklet && glirastes tools refresh --keep-going",
  "prebuild": "glirastes stt worklet && glirastes tools refresh"
}
```

- `glirastes stt worklet` copies the file into `public/`. A Vite app with its
  own `root` or `publicDir` passes that folder: `glirastes stt worklet --out
  web/static`. Served at another path, set `voice.workletUrl`.
- yarn berry and pnpm may skip `pre*` scripts; when you start `next dev` or
  `vite` directly, run `glirastes stt worklet` once first.
- The copy is a build output: `glirastes init` and `glirastes stt worklet` add
  it to an existing `.gitignore` (never creating one; `--no-gitignore` skips
  it). `glirastes init --dry-run` lists the script and `.gitignore` changes.
- `glirastes doctor` checks the file at the configured or default URL when the
  app uses voice input, and fails when `workletUrl` points to a path the copy
  step never writes.

## Standalone and Connected

| | Standalone | Connected |
|---|---|---|
| Trigger | no `GLIRASTES_API_KEY` | `GLIRASTES_API_KEY` is set |
| Platform network | none | Platform lookup, registration, sync and metrics, all off the turn path |
| Config | local code and `.glirastes/` | reviewed, signed, immutable revisions with rollouts and revocations |

`createGlirastes` from `glirastes/runtime` handles both. Connected, it falls
back to the local code whenever the Platform is unreachable and reports errors
to `onError` (operation and status only). `GLIRASTES_CONTROL_PLANE_URL` is
optional and defaults to `https://api.glirastes.io`; set it only
for a self-hosted or local Platform.

```bash
npx glirastes connect   # connect once: issues one app key, GLIRASTES_API_KEY
npx glirastes sync      # upload the current local setup
npx glirastes doctor    # local checks, no network
```

Pass `--base-url <platform-url>` to `connect` only for a self-hosted or local
Platform. The key goes to `--dotenv <path>` (a Git-ignored file inside the
project; not `--env-file`, which Node.js 20+ consumes itself), else to
`.env.local` in a Next.js app; any other app gets it shown
once on the terminal (or in `--json`) to set as `GLIRASTES_API_KEY` in the
server's environment. A deployed app needs only the environment variables, not
`.glirastes/` (see [docs/managed-runtime-sync.md](docs/managed-runtime-sync.md)). In Citadel the approver chooses the key lifetime: 90 days (the
default), 1 year or no expiry.

Every deployment uses that one secret, `GLIRASTES_API_KEY`, and sets
`GLIRASTES_ENVIRONMENT=<environment key>` (not a secret, `^[a-z0-9][a-z0-9-]{0,63}$`).
The first start of an unknown name creates a pending request; an owner or admin
clicks "create and connect" in Citadel if the plan has a free place, and the app
serves local tools until then. Without `GLIRASTES_ENVIRONMENT` the app runs as a
read-only development connection that follows the reference environment. Details:
[docs/managed-runtime-sync.md](docs/managed-runtime-sync.md).

These environment-variable defaults describe embedded `createGlirastes` use.
The configured container explicitly selects `platform.enabled` in its JSON
configuration. Connected container startup waits for an accepted deployment;
it never silently switches to standalone. An accepted revision can remain usable
during a transient outage. Standalone still calls your backend and model provider;
it means no Platform connection, not no network access.

The **Glirastes Platform** is the optional control plane: reviewed tool
configuration, signed immutable revisions, staged rollouts, approvals and
content-free health. **Free** covers the local SDK, the local skill workflow
and a connected app; **Pro** adds the managed CI tool agent. Details:
[docs/managed-runtime-sync.md](docs/managed-runtime-sync.md),
[docs/runtime-persistence.md](docs/runtime-persistence.md).

## Package surface

| Import | Purpose |
|---|---|
| `glirastes` | Shared types, tool definition helpers and diagnostics |
| `glirastes/runtime` | `createGlirastes`, local authorization, pinned turns, budgets, durable stores |
| `glirastes/server` | Server pipeline, including `createLocalAiPipeline` |
| `glirastes/server/http` | Framework-neutral Web Request/Response handlers for an existing Node host; same exports as `/server/nextjs` |
| `glirastes/server/nextjs` | Next.js handlers: `createAiChatHandler`, `createChatInteractionsHandler`, `createRecordingTranscriptionHandler` (alias `glirastes/adapter/nextjs`) |
| `glirastes/server/testing` | Test helpers for tool setups without model calls (ESM only) |
| `glirastes/react` | Chat UI, provider, hooks, client actions, navigation bridge, STT |
| `glirastes/react/audio-worklet-processor.js` | Audio worklet file voice input loads (serve it at `/audio-worklet-processor.js`) |
| `glirastes/react/vercel` | AI SDK transport and `VercelAiChat` |
| `glirastes/react/styles.css` | Shipped chat styles |
| `glirastes/stt` | Provider-neutral STT controller and adapters |
| `glirastes/ai-sdk` | Vercel AI SDK reference engine (alias `glirastes/runtime/ai-sdk`) |
| `glirastes/contracts` | Principals, budgets, manifests, revisions, deployments |
| `glirastes/sync` | Signed revision cache, rollout selection, revocations |
| `glirastes/embed` | `<glirastes-chat>` element for apps without React |
| `glirastes/browser` | Navigation bridge, query filters and client actions without React |
| `glirastes/codegen` | Route scanning and execution-inventory discovery used by the CLI |

## CLI reference

| Command | Purpose |
|---|---|
| `glirastes init [--agent codex\|claude] [--dry-run] [--json]` | Scaffold inputs, install skills, hand setup to your coding agent |
| `glirastes init --ci github [...]` | Write the GitHub tools workflow ([CI](#ci)) |
| `glirastes tools refresh [--watch] [--mode write\|frozen\|integrity] [--no-skills]` | Derive tools from the code and update installed skills |
| `glirastes tools check [--strict] [--integrity-only] [--no-skills]` | Verify committed tool outputs and installed skills |
| `glirastes tools status` | Show what the chat can do |
| `glirastes tools resolve --print` | Work list of open findings for your agent |
| `glirastes tools describe --print [<tool>...\|--all]` | Work list of descriptions, synonyms and examples |
| `glirastes tools eval` | Check that example sentences find their tool |
| `glirastes tools verify <tool>...\|--all` | Confirm agent-written contracts after review |
| `glirastes tools policy <...>` | Change the local tool policy |
| `glirastes tools enrich --managed [--first-run] [--base <branch>] [--head <branch>] [--environments <a,b,c>]` | Pro, CI only: run the managed tool agent |
| `glirastes setup [--dry-run] [--managed]` | Validate and install the local setup artifacts |
| `glirastes setup inspect` | Inspect project manifests before integration |
| `glirastes connect [--base-url <url>] [--dotenv <path>] [--json]` | Connect the app once and issue one app key (`--base-url` only for self-hosted, `--dotenv` for the Git-ignored key file) |
| `glirastes sync [--dotenv <path>]` | Upload the current local setup |
| `glirastes doctor [--managed] [--dotenv <path>] [--verbose] [--json]` | Diagnose the local setup |
| `glirastes install [--host a,b]` | Install the agent skills only |
| `glirastes-runtime build --project <dir> --out <new-dir> [--frozen]` | Generate an immutable JSON runtime artifact; frozen mode checks committed generation |
| `glirastes-runtime validate --artifact <dir>` | Check exact SDK version, hashes and bindings |
| `glirastes-runtime serve --config <absolute-json-path>` | Serve the configured customer runtime |
| `glirastes-runtime healthcheck --config <absolute-json-path>` | Probe readiness using the service configuration |

`glirastes --help` lists every command and flag; `glirastes tools` and
`glirastes tools policy` print their own usage.

## Agent skills

The package ships ten skills in [`skills/`](skills/README.md) for your
existing coding agent (Codex, Claude Code, Gemini): `setting-up-glirastes`,
`setting-up-glirastes-memory`,
`integrating-glirastes-nextjs`, `integrating-glirastes-web`,
`maintaining-glirastes-tools`, `describing-glirastes-tools`,
`building-glirastes-chat-ui`, `curating-glirastes-chat-interactions`,
`migrating-to-glirastes` and `upgrading-glirastes`. `glirastes init`
installs them; `glirastes install --host codex --with-setup-skills` installs
them without starting setup. After an SDK upgrade, `glirastes tools refresh`
replaces the unedited copies, adds new skills and keeps edited ones, and
`glirastes tools check` fails while unedited copies are behind. Opt out with
`GLIRASTES_SKILLS_AUTO_UPDATE=0` or `--no-skills`.

## Support matrix

Next.js 15 App Router, React (Vite, react-router) + NestJS 11 and Vue 3 +
FastAPI are integrated and automatically checked. Exact levels and evidence:
[docs/support-matrix.md](docs/support-matrix.md). Other frontend/backend
frameworks can use the conditional generic paths (web component, OpenAPI and
configured runtime service) described there; this does not imply complete stack support.

## Docs

The [developer documentation at glirastes.io/docs](https://glirastes.io/docs)
provides a guided start, searchable integration topics and copyable examples.
Preview guides are marked explicitly; check their release status against your
installed SDK version. The versioned source guides remain available below.

- [Support matrix](docs/support-matrix.md)
- [Runtime container architecture and operations](docs/runtime-container.md)
- [Public image and artifact build commands](https://github.com/chainmatics/glirastes/blob/v0.27.0/containers/runtime/README.md)
- [PHP backend and Docker Compose example](https://github.com/chainmatics/glirastes/blob/v0.27.0/examples/php-runtime/README.md)
- [Angular, SvelteKit and Nuxt browser examples](https://github.com/chainmatics/glirastes/blob/v0.27.0/examples/frontend-frameworks/README.md)
- [Runtime V1 acceptance and release evidence](https://github.com/chainmatics/glirastes/blob/v0.27.0/docs/acceptance/2026-11-15-runtime-container-v1.md)
- [Tool policy](docs/tool-policy.md)
- [Chat route security](docs/chat-route-security.md)
- [Chat interactions (`@` and `/`)](docs/chat-interactions.md)
- [Chat attachments](docs/chat-attachments.md)
- [Chat message queue](docs/chat-queue.md)
- [Chat views](docs/chat-views.md)
- [Managed runtime sync](docs/managed-runtime-sync.md)
- [Runtime persistence](docs/runtime-persistence.md)
- [0.5.0 acceptance](https://github.com/chainmatics/glirastes/blob/v0.27.0/docs/acceptance/0.5.0-acceptance.md)
- [Second acceptance app (Vue + FastAPI), run per release](https://github.com/chainmatics/glirastes/blob/v0.27.0/docs/acceptance/second-app-vue-fastapi.md)
- [Agent skills](skills/README.md)
- Examples: [`examples/`](https://github.com/chainmatics/glirastes/tree/v0.27.0/examples)

## Upgrading from 0.4

`0.5.0` is the first Foundation release. Its surface differs from
`glirastes@0.4.0`: exports, codegen APIs and CLI commands were removed or
replaced. Read **Breaking** in [CHANGELOG.md](CHANGELOG.md) before upgrading;
the skill [`migrating-to-glirastes`](skills/migrating-to-glirastes/SKILL.md)
covers moving off `@chainmatics/agentic-*`.

## Security & License

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Rust, PHP and Java backends

A configured customer-hosted runtime container can run this SDK next to an
existing HTTP API without customer Node server code. See
[Runtime container V1](docs/runtime-container.md) and the
[PHP reference](https://github.com/chainmatics/glirastes/blob/v0.27.0/examples/php-runtime/README.md). It uses generated OpenAPI tools,
backend-verified user credentials, persistent approvals and one active service
per app/environment. Image publication and customer deployment are separate
release steps; V1 does not provide HA or native backend SDKs.
