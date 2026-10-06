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
   `predev` (`glirastes tools refresh --keep-going`) and `prebuild`
   (`glirastes tools refresh`) scripts; `glirastes tools refresh --watch` next
   to `next dev` keeps the tools current while you edit.
2. Server-only `resolvePrincipal(request)` returns the verified `subjectId`,
   `tenantId`, roles and attributes from the real session, or `undefined` for
   an unauthenticated request.
3. The chat route boots the local runtime from the generated module
   (`createGeneratedRuntimeSource` wraps `createLocalRuntimeSource` and
   `createContractBindings`). Restart after a refresh; Managed apps use the
   verified Managed revision source with the same local bindings instead.

   ```ts
   // src/app/api/chat/route.ts
   import { createOpenAI } from '@ai-sdk/openai';
   import {
     createGeneratedRuntimeSource, createRuntimeMetricsSinkFromEnv, materializeManifestToolRegistry,
   } from 'glirastes/runtime';
   import { createAiChatHandler, type ManagedLocalRuntimeConfig } from 'glirastes/server/nextjs';
   import * as generated from '@/generated/glirastes/tools.generated';
   import { resolvePrincipal } from '@/lib/glirastes-principal';

   const localLimits = {
     maxModelSteps: 6, maxToolCalls: 8, totalTimeoutMs: 60_000, toolTimeoutMs: 15_000,
     maxInputTokens: 40_000, maxOutputTokens: 4_000, maxEstimatedCostUsd: 0.5,
     maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
     delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
   };
   const systemPrompt = 'Use the tools of this app. Ask one short question when the target is unclear.';
   const glirastes = createGeneratedRuntimeSource(generated, { localLimits });
   // One sink per process, at module scope. Standalone apps get undefined and stay network-silent.
   const metrics = createRuntimeMetricsSinkFromEnv();
   const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });

   // One object for every handler of this route (see below).
   const managedRuntime: ManagedLocalRuntimeConfig = {
     resolvePrincipal,
     resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context),
   };

   export const runtime = 'nodejs';
   export const POST = createAiChatHandler({
     managedRuntime,
     // With managedRuntime the handler always pins a snapshot; without one no tool is offered.
     loadTools: ({ turnSnapshot }) => (turnSnapshot
       ? materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings })
       : {}),
     toolDiscovery: true,
     toolSemantics: generated.toolSearchSemantics,
     model: openrouter.chat('anthropic/claude-sonnet-5.5'),
     systemPrompt,
     ...(metrics ? { metrics } : {}),
   });
   ```

   Use `.chat(model)`: `createOpenAI(...)(model)` talks to the Responses API,
   whose usage the handler does not read, so turn costs would stay unknown.
   `managedRuntime` names the shared turn guard, not a Platform purchase.
   Keep it a shared `const` at module scope: when the route also serves the
   chat's `@` and `/` list with a GET (`createChatInteractionsHandler`, see
   `building-glirastes-chat-ui`), pass that same object to the POST and the
   GET, so the list and the turn decide with one principal and one snapshot.
   `toolDiscovery: true` offers `find_tools`, and `toolSemantics` gives it the
   checked synonyms; neither grants a tool. With `metrics`, an endpoint that
   refuses a call its schema accepted (400 or 422) is reported as
   `tool_contract_rejected`, without content.
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
   where the state lives, with a Zod payload contract as third argument. A
   handler that writes through a helper, a Server Action or a mutation hook is
   flagged (`ui-action-write-unproven`); the developer raises it with
   `glirastes tools policy raise <tool> write`.
7. Mount the chat with `building-glirastes-chat-ui`
   (`VercelAiChat endpoint="/api/chat"` from `glirastes/react/vercel`).
8. Run `glirastes tools refresh`, the work lists of `setting-up-glirastes`,
   `glirastes tools check` and `glirastes doctor`, then the real chat test.
   Connecting is optional: `glirastes connect --base-url <url>`, then
   `glirastes sync` uploads the technical result.

## Commands

```bash
glirastes tools refresh
glirastes tools refresh --watch
glirastes tools status
glirastes tools check
glirastes tools check --integrity-only
glirastes doctor
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
