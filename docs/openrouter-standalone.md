# Standalone Next.js with OpenRouter

Use your own server-verified identity, generated tools and the supplied React chat. No Glirastes platform account or second model provider is needed. Start with the [source-driven Next fixture](../examples/source-driven-next/README.md); this guide connects the pieces into one deployment path.

## Install and compatibility

Use Next.js 15 App Router, React/React DOM 19, Zod 4 and TypeScript 6 for this path. Install TypeScript explicitly (`npm install -D typescript@6 @types/react@19 @types/react-dom@19 @types/node`) and commit the lockfile. Do not install unversioned TypeScript: at this verification npm resolves 7.0.2, whose compiler API differs from what Next 15 expects. The tested consumer versions and build results are recorded in [acceptance](acceptance/fieldwork-dx/README.md). This is a tested combination, not a promise that every future minor works.

```sh
npm install glirastes @ai-sdk/openai@3 @ai-sdk/react@3 ai@6 next@15 react@19 react-dom@19 react-markdown@10 zod@4
npx glirastes init
npx glirastes tools refresh
npx glirastes tools resolve --print
npx glirastes tools describe --print
npx glirastes tools check
npx glirastes doctor
```

Resolve genuine gaps in application code, then refresh. Use exported `z.object` schemas at request boundaries. Zod 3 requires the app's `zod-to-json-schema` converter; a loaded schema with missing conversion is different from a module import failure or a non-object schema. Doctor checks declarations and artifacts; it does not replace a consumer build or a browser run.

Configure `.glirastes/tools.json` with `next-app`, `next-pages`, `url-filters`, `react-actions`, locale `de-DE`, a generated app UUID and your stable `targetAppKey`. Keep generated outputs and semantic descriptions in version control. Use the [tool policy guide](tool-policy.md) for approval/risk rules.

## Server identity and chat

Keep `OPENROUTER_API_KEY` and approval secrets server-only. Implement `resolvePrincipal(request)` using your verified session or identity provider. Never accept roles, user or tenant from browser JSON. Each application endpoint independently enforces tenant membership and authorization. The open demo login in Fieldwork is not a production identity system.

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { createGlirastes } from 'glirastes/runtime';
import { createAiChatHandler, createChatInteractionsHandler } from 'glirastes/server/nextjs';
import * as generated from '@/generated/glirastes/tools.generated';
import { resolvePrincipal } from '@/lib/auth';

const sdk = createGlirastes({ generated });
const provider = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});
export const runtime = 'nodejs';
async function context(request: Request) {
  const principal = await resolvePrincipal(request);
  if (!principal) return null;
  return sdk.chatTurn(runtimeTenantId => ({ ...principal, tenantId: runtimeTenantId }));
}
export async function POST(request: Request) {
  const turn = await context(request);
  if (!turn) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return createAiChatHandler({
    ...turn,
    model: provider.chat(process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5'),
    locale: 'de', toolDiscovery: true,
    planning: { enabled: true }, clarification: { enabled: true },
    attachments: { enabled: true },
    systemPrompt: 'Retrieve records before using their IDs. Options must come from authorized tool results. Ask for free text when no retrieved option fits. Never claim execution of an unconfirmed browser request.',
  })(request);
}
export async function GET(request: Request) {
  const turn = await context(request);
  if (!turn) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return createChatInteractionsHandler({
    interactions: generated.chatInteractions, managedRuntime: turn.managedRuntime,
  })(request);
}
```

Set `GLIRASTES_APPROVAL_SECRET` to an independently generated secret (at least 32 characters). Configure the documented approval signing secret and deployment origin from [chat route security](chat-route-security.md). Compare browser Origin against the configured public origin, not a reverse proxy's internal `request.url`. Keep approval signatures bound to unchanged arguments, principal and tool. SDK approval does not replace endpoint authorization.

## One supplied chat

Import `glirastes/react/styles.css` once in the root layout. With strict CSS side-effect checking add `declare module 'glirastes/react/styles.css';` in `src/styles.d.ts`.

Mount `VercelAiChat` from `glirastes/react/vercel` above `AssistantWorkspace` and `AiChatPanel` from `glirastes/react`. Pass `endpoint="/api/chat"`, `locale={deChatLocale}`, your `theme`, and a stable session store created with `createLocalSessionStore({ storageKey })`. Scope that key to app, environment, tenant and user, and remount the provider when identity changes. Local storage is local history, not server persistence.

Connect `useGlirastesNavigationBridge({ push: href => router.push(href) })`. Mount route-specific `useAiClientAction` handlers with a literal route option. Return `false` for unknown IDs; do not loosen validation to accommodate model guesses. A server-emitted action only requests execution. Browser execution feedback is local evidence and is not a signed server authorization or authoritative business mutation receipt. See [browser outcomes and migration](browser-action-outcomes.md) for timeout, cancellation and compatibility semantics.

Use `useChatInteractionsData('/api/chat')` and pass `{ data, locale: 'de' }` as `chatInteractions`. The authenticated GET supplies `/` commands and `@` entities. Add entity read tools and labels using [chat interactions](chat-interactions.md). Describe business field labels and enum translations in the generated semantics; the SDK cannot translate arbitrary application concepts such as `scheduled` without those descriptions.

Register `toolRenderers` for business results; use `toolResults: { mode: 'allowlist', allowlist: ['jobs.update'] }` if you want an explicit display policy. For short IDs, configure `createApprovalDescriptionGenerator({ entityNames: { technicianId: techniciansById } })` with maps built only from authorized records. Nested paths such as `job.id` have independent maps; global short-ID lookup is deliberately unsafe across entity types. Presentation callbacks must never mutate the approval arguments or signatures. Mount shell and toggle inside the chat provider to inherit theme. At 390px verify host sidebar behavior too: SDK layout cannot hide an application-owned sidebar.

## Attachments and speech

Enable attachments in both server handler and chat provider, set file count/size limits, and select an OpenRouter model supporting the requested image/PDF modality. Follow [attachments](chat-attachments.md); document content is untrusted input, not instructions.

Follow [speech input](speech-input.md) for the exported worklet copy step, base-path URL, authenticated OpenRouter transcription route and one shared STT controller. Add asset preparation to both `predev` and `prebuild`. Recorded transcription has no interim text; it runs after stop and places its final text into an editable draft without sending automatically.

## Multi-step work and grounding

Keep default budgets unless measured tasks require more. Fieldwork's three-read checklist needed seven model steps including discovery/planning/final response and exceeded six. For that workload only, `createGlirastes({ generated, localLimits: { maxModelSteps: 10, maxToolCalls: 16, maxInputTokens: 80000 } })` succeeded externally; retain timeout and cost caps. Measure model steps, tool calls, input/output tokens and final summary completion with `onFinish` before adopting these values.

A safety stop is a partial result: inspect the visible plan and completed tool results. Continue only unresolved work. Do not replay prior mutations to obtain another summary. Use endpoint idempotency keys for business operations requiring retry guarantees; the SDK cannot make arbitrary external mutations exactly-once. Discovery recovery through `find_tools` is useful when routing is ambiguous; do not force a write tool on uncertain language. Ground names and IDs in authorized read results and ask when several records match. These patterns reduce hallucination risk without claiming to eliminate it.

## Acceptance before release

Run typecheck, production build, tools check/eval and doctor from the packed npm artifact in a fresh consumer. In a browser check successful and rejected actions, navigation-before-action, reload/session switching, approval accept/reject/replay, image/PDF input, missing worklet, one microphone stream, stop/cancel/retry and resource cleanup. Preserve original external evidence and record retests separately. See [support matrix](support-matrix.md) for the distinction between tested fixtures and production acceptance.

Compatibility references: [Next installation](https://nextjs.org/docs/15/pages/getting-started/installation), [OpenRouter transcription](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/).
