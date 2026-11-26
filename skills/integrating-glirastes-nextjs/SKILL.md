---
name: integrating-glirastes-nextjs
description: Use when adding Glirastes chat, source-derived tools, navigation, URL filters, client actions, metrics or speech input to a Next.js App Router application.
---

# Integrating Glirastes into Next.js

Read `setting-up-glirastes` first. You, the app's coding agent, do the work;
Glirastes never calls a model. A fresh Standalone app needs no Platform
account; preserve an existing Connected or Managed configuration. Tools come
from the source-derived generator (`glirastes tools refresh`), never from a
second, hand-maintained catalogue.

## Boundaries

- Keep final authorization in the app: every endpoint keeps its own session
  and permission checks; `resolvePrincipal` only tells the runtime who asks.
- Never trust identity, tenant or role fields from the browser. Never
  substitute one global tenant or disable tenant checks for a default id.
- Never edit `.glirastes/tool-policy.json`, generated files or the `appId` in
  `.glirastes/tools.json`; propose `glirastes tools policy` commands instead.
- The app's model key (`OPENROUTER_API_KEY`) is entered by the developer into
  the app environment; never read, copy or print it.
- Business content, prompts and tool results stay in the app. The normal chat
  path makes no Control Plane request; the one exception is a Connected app's
  metrics sink, which sends content-free batches off the turn path.

## Workflow

1. Sources in `.glirastes/tools.json`: `next-app` for route handlers
   (`src/app/api` by default, `{ "kind": "next-app", "apiDir": "app/api" }`
   otherwise), `next-pages` for navigation, `url-filters` for nuqs or
   `searchParams` filters, `react-actions` for `useAiClientAction`. Keep the
   `predev` (`glirastes stt worklet && glirastes tools refresh --keep-going`)
   and `prebuild` (`glirastes stt worklet && glirastes tools refresh`) scripts;
   the worklet copy serves voice input's audio worklet. `glirastes tools refresh --watch` next
   to `next dev` keeps the tools current while you edit.
2. Server-only `resolvePrincipal(request)` returns the verified `subjectId`,
   `tenantId`, roles and attributes from the real session, or `undefined` for
   an unauthenticated request.
3. The chat route creates the runtime from the generated tools and spreads
   one turn into the handler. Peer packages: `ai@^6`, `@ai-sdk/openai@^3`,
   `@ai-sdk/react@^3`. Restart after a refresh.

   ```ts
   // src/app/api/chat/route.ts
   import { createOpenAI } from '@ai-sdk/openai';
   import { createGlirastes } from 'glirastes/runtime';
   import { createAiChatHandler } from 'glirastes/server/nextjs';
   import * as generated from '@/generated/glirastes/tools.generated';
   import { resolvePrincipal } from '@/lib/glirastes-principal';

   // One instance per app and process, also when routes are bundled apart.
   const glirastes = createGlirastes({ generated });
   // Budgets default to safe values (8 tool calls per turn, `read_result` included);
   // override with `localLimits: { maxToolCalls: 16 }`, capped by agent revision and policy.
   const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
   const systemPrompt = 'Use the tools of this app. Ask one short question when the target is unclear.';

   export const runtime = 'nodejs';
   export async function POST(request: Request) {
     const principal = await resolvePrincipal(request);
     if (!principal) return new Response('Unauthorized', { status: 401 });
     const turn = await glirastes.chatTurn((runtimeTenantId) => ({ ...principal, tenantId: runtimeTenantId }));
     return createAiChatHandler({
       ...turn,
       model: openrouter.chat('anthropic/claude-sonnet-5.5'),
       systemPrompt,
       toolDiscovery: true,
       onError: (error) => console.error('[chat]', error),
     })(request);
   }
   ```

   Several routes share the runtime when the `createGlirastes` call moves to
   a server-only module such as `src/lib/glirastes.ts`.
   `chatTurn` brings the shared turn guard (`managedRuntime`), the tools of
   the pinned snapshot, the checked synonyms and examples for the tool search and, Connected,
   the content-free metrics sink; Standalone it makes no network call. Use
   `.chat(model)`: `createOpenAI(...)(model)` talks to the Responses API,
   whose usage the handler does not read, so turn costs would stay unknown.
   A failed turn shows the user a neutral message and logs only the error
   name; pass `onError` to see the cause. When the route also serves the
   chat's `@` and `/` list with a GET (`createChatInteractionsHandler`, see
   `building-glirastes-chat-ui`), give it `turn.managedRuntime` of the same
   principal, so the list and the turn decide alike. Connected, `chatTurn`
   also enforces the signed environment control: a halt answers HTTP 503
   `assistant_halted` and stops a running turn at its next model step or tool
   call, the budget ceiling only lowers limits, and the rate limit answers 429
   `turn_rate_limited` (counted per process). Production sets
   `controlFreshness: 'required'` on `createGlirastes`, so a restarted process
   serves no turn (503 `control_unknown`) before its first sync. The recording
   route takes the same `loadControl` (`turn.managedRuntime.loadControl`) and
   answers 503 while halted. `toolDiscovery: true`
   offers `find_tools`; it grants no tool, and a fixed note after the system
   prompt tells the model to search before it says it cannot do something. It also turns on the default
   routing: each turn starts with the tools of the modules the request
   matches (derived from the generated metadata, German and English),
   `ui_navigate`, the tools the previous turn called, and `find_tools`, not
   with every tool. Tune it in the app, not in a routing list: better tool
   descriptions, usage hints and synonyms (`describing-glirastes-tools`),
   `intentRouting: { maxStartTools: 12, alwaysAvailable: ['ui_navigate'] }`,
   or `examples` per tool (`tool-semantics.json`, carried by the generated
   `toolSearchSemantics`). Among equally relevant tools, read tools come
   first. A custom `intentRouter`
   replaces it; `intentRouting: false` starts every turn with all tools.
   Further defaults, each with an opt-out: `history` sends earlier turns
   compacted (`{ maxTurns, toolTurns, maxTokens, maxItems, maxStringLength,
   keepIdentity }`, `false` for the flat slice; lists beyond `maxItems`
   keep id and name per entry, so a tool that takes an id should say to look
   it up by name when it is not visible), `promptCaching` adds cache breakpoints for
   `@ai-sdk/anthropic` and `@openrouter/ai-sdk-provider`, and `hideIds`
   keeps technical ids out of answers: the prompt forbids them and the stream
   replaces an id the model writes anyway with the label its tool result gave
   it, or drops it. Keep `hideIds` on; a test or a chat that must show raw
   ids sets `hideIds: false`. A custom `streamHandler` gets `hideIds` in its
   context and must apply it itself: append `HIDE_IDS_PROMPT`, fill an
   `IdLabels` map with `collectIdLabels(messages, labels)` and pass
   `createHideIdsTransform(labels)` to `streamText` as
   `experimental_transform` (all from `glirastes/server/nextjs`). `hideIds`
   only rewrites answer text; the approval card names the ids of a call on
   its own, in the browser (`building-glirastes-chat-ui`, Approvals). A turn
   without visible output shows a short fallback text and is reported as
   `model_error`. A tool result over `maxResultChars` reaches the model (and
   the browser) as an overview with a `_result` handle; the built-in
   `read_result` reads the rest within the same request, without calling
   the backend again (`resultHandles: false` cuts it instead). Per tool,
   `outputAllowedFields`, `outputDeniedFields` (`**.key` at any depth) and
   `outputDefaultFields` (on the endpoint tool, `defineTool` or the
   `contract.ts` entry) bound what a result shows and pick the first answer;
   see `references/handler-options.md`. With metrics, an endpoint that
   refuses a call its schema accepted (400 or 422) is reported as
   `tool_contract_rejected`, without content.
   Every other `AiChatHandlerConfig` option (approvals, origins, limits,
   callbacks), one line each: [references/handler-options.md](references/handler-options.md).
   Image and PDF attachments stay off until the developer asks for them:
   then `attachments: { enabled: true }` here (body limit 50 MB; with
   `piiShield` also `allowWithPiiShield: true`, since files bypass the
   shield) and `attachments` on the chat (`building-glirastes-chat-ui`). A
   middleware or `proxy` on `/api/chat` buffers only 10 MB: raise
   `experimental.middlewareClientMaxBodySize` (Next.js 16:
   `experimental.proxyClientMaxBodySize`) or keep the route out of its matcher.
   To keep chat files across reloads or hand them to an upload route, see
   `docs/chat-attachments.md`, "Keeping attachments" and "Handing attachments to the app".
4. Mount the navigation bridge once in the root layout, as a client component,
   so `ui.navigate` and the `ui.filter.*` tools can run:

   ```tsx
   'use client';
   import { useRouter } from 'next/navigation';
   import { useGlirastesNavigationBridge } from 'glirastes/react';

   export function GlirastesNavigationBridge() {
     const router = useRouter();
     useGlirastesNavigationBridge({ push: (href) => router.push(href) });
     return null;
   }
   ```

   Without the bridge, navigation and filter tools stay disabled
   (`navigation-bridge-missing`).
5. Filters: read URL parameters with closed nuqs parsers where the domain is
   closed (`parseAsStringLiteral([...])`, `parseAsInteger`, `parseAsArrayOf`);
   `parseAsString` stays open and is reported as `filter-domain-open`.
6. Client actions: `useAiClientAction('tasks.highlight', handler, contract)`
   where the state lives, with a Zod payload contract as third argument. The
   tool is `ui.tasks.highlight`; a single-segment id (`navigate`) or one
   starting with `navigate.`, `filter.` or `action.` becomes
   `ui.action.<id>`, so it never takes the generated `ui.navigate` or
   `ui.filter.*` names. An
   action whose component lives on one page gets that page's path as fourth
   argument, in the page component itself:

   ```tsx
   // src/app/templates/page.tsx
   useAiClientAction('template-create-dialog.open', () => setCreateOpen(true),
     z.object({}), { route: '/templates' });
   ```

   From any other page the chat then opens `/templates` through the
   navigation bridge and runs the action once the page registered it. Never
   register an action in the app shell that only fires a window event for a
   listener on one page (`ui-action-indirect`). A handler returns `false`
   when it could not do its work, so the chat does not report it as done.
   Export the zod contract from a module that imports only zod (e.g.
   `src/lib/ai-actions.ts`) and pass that export: the tool then gets its
   formats, descriptions, enums and bounds (`z.string().uuid()` is checked
   on the server); an inline or unimportable contract is typed from
   TypeScript as before (`ui-action-contract-unprobed`). Declare what a
   handler does in the options, as a literal: `{ effect: 'write' }` for one
   that changes data (the chat asks first), `'destructive'` for one that
   deletes, `'read'` for one that only shows or selects. Undeclared, a
   handler that writes through a helper, a Server Action or a mutation hook is
   flagged (`ui-action-write-unproven`); the developer raises it with
   `glirastes tools policy raise <tool> write`.
7. Mount the chat with `building-glirastes-chat-ui`: `VercelAiChat
   endpoint="/api/chat"` (from `glirastes/react/vercel`) around an
   `AssistantWorkspace` that holds the page, and an `AssistantToggle` in the
   top bar. The chat then docks on the right or detaches as a window.
8. Run `glirastes tools refresh`, the work lists of `setting-up-glirastes`,
   `glirastes tools check` and `glirastes doctor`, then the real chat test.
   Connecting is optional and only in Platform mode (`setting-up-glirastes`):
   `glirastes connect`, then `glirastes sync` uploads the technical result.

### Local speech recognition

Experimental, only when the app asks for transcription inside its own Node
server instead of a transcription service (`docs/local-stt.md`):

1. `npm install sherpa-onnx-node@2.0.1`, exactly this version: linux-x64 2.0.2
   does not load on Debian bookworm. glibc Linux (no Alpine) or macOS arm64.
2. `glirastes stt pull` downloads the five sha256-pinned model files (670 MB)
   into `GLIRASTES_MODEL_DIR` (default `~/.cache/glirastes/models`); in a
   container run it at image build. Nothing is downloaded at runtime.
3. The recording route passes `transcribe` instead of `url`:

   ```ts
   // src/app/api/ai/speech-recognize/route.ts
   import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
   import { createLocalTranscriber } from 'glirastes/server/stt-local';

   export const runtime = 'nodejs';
   const stt = createLocalTranscriber();
   export const POST = createRecordingTranscriptionHandler({
     authorize: async (request) => Boolean(await resolvePrincipal(request)),
     transcribe: stt.transcribe,
   });
   ```

4. `next.config.ts`: `serverExternalPackages: ['sherpa-onnx-node', 'glirastes']`,
   both; without `glirastes` the bundled import fails as `peer_missing`. Call `stt.warmup()` from `instrumentation.ts` so the first request does not
   wait for the model; plan 2 GB of memory per process.
5. `checkLocalStt()` is the model-free deploy readiness check. A full queue
   answers 503, a WAV that is not PCM16 mono 16 kHz answers 415.

## Commands

```bash
glirastes tools refresh
glirastes tools refresh --watch
glirastes tools status
glirastes tools check
glirastes tools check --integrity-only
glirastes doctor
glirastes stt pull
```

## Verification

- An unauthenticated, cross-tenant or tampered principal cannot execute tools;
  the endpoint refuses the call itself.
- The normal chat path makes no Control Plane request; only a Connected app's
  metrics sink sends content-free batches.
- A real prompt performs one successful tool action; a write tool asks first.
- Adding, changing and deleting a route, a page and a URL filter changes the
  tools after `glirastes tools refresh`; a removed tool cannot be called.
- The Docker build runs with `GLIRASTES_TOOLS_MODE=integrity`, so the build's
  refresh only verifies the committed digest chain.
- Build, contract, browser, privacy and rollback tests pass.

## Stop conditions

Fail closed when there is no principal resolver, no matching local binding or
no locally authorized tool. If the generator cannot type an endpoint, the tool
stays disabled with a finding: resolve it with `maintaining-glirastes-tools`
instead of inventing a permissive schema. A passing Doctor does not prove a
live action.
