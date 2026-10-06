---
name: integrating-glirastes-web
description: Use when integrating Glirastes into an app with a separate backend (NestJS, FastAPI or another API), a non-React frontend (Vue, plain web components) or a Node sidecar next to a non-Node backend.
---

# Integrating Glirastes into Web Apps With a Separate Backend

Read `setting-up-glirastes` first. You, the app's coding agent, do the work;
Glirastes never calls a model. The generator reads only what this SDK version
supports (table below). Where a part is not read yet, report the gap; never
replace the generator with a hand-written tool list.

## Boundaries

- The backend keeps all authorization. The chat handler calls the app's API
  with the user's own session cookie, never with a service account that has
  more rights than the user.
- Never edit `.glirastes/tool-policy.json`, generated files or the `appId` in
  `.glirastes/tools.json`.
- The model key (`OPENROUTER_API_KEY`) lives only in the environment of the
  process that runs the chat handler; the developer enters it.
- Search results, tool arguments and results never go to the Glirastes
  Platform.

## Support in this version

| Part of the app | Read by `glirastes tools refresh` | Source in `.glirastes/tools.json` |
| --- | --- | --- |
| Next.js route handlers | yes | `next-app` |
| Client actions in `.ts`, `.tsx`, `.js` files (`useAiClientAction`, `registerAiClientAction`, `bus.subscribeById`) | yes, also in Vue apps | `react-actions` |
| URL filters of SPA views declared with `defineQueryFilters` | yes | `url-filters` |
| NestJS controllers, FastAPI through OpenAPI, react-router and vue-router pages, `<script>` blocks of `.vue` files | not yet | report as an open gap |

## Workflow

1. Decide where the chat handler runs: in a Node backend next to the API, or
   in a small declared Node sidecar when the API is not Node (FastAPI). The
   handler is framework-neutral: `createAiChatHandler` (from
   `glirastes/server/nextjs`, despite the name) takes a Web `Request` and
   returns a `Response`; adapt your framework's request object to it.
2. Endpoint tools call the API through the caller that `createAiChatHandler`
   builds for every chat request. It sends the call to the origin the chat
   request arrived on and forwards only that request's `cookie` header; this
   version has no option to replace it. So the API must be reachable on the
   same origin as the handler (a reverse proxy or the dev server routes `/api`
   to the backend) and authenticate by session cookie. An API on another
   origin or a bearer token in an `Authorization` header is not supported
   yet: report it as an open gap (step 5). Do not use a service account or
   forward credentials the user did not send to get around it.
3. Frontend actions and navigation without React: in the browser entry module
   use `glirastes/browser`:

   ```ts
   import { defineQueryFilters, registerAiClientAction, registerNavigationBridge } from 'glirastes/browser';
   import { z } from 'zod';

   registerNavigationBridge({ push: (href) => router.push(href) });
   export const taskFilters = defineQueryFilters({
     path: '/tasks',
     filters: { status: ['open', 'done'] },
   });
   registerAiClientAction('tasks.highlight', (payload) => highlight(payload.taskId),
     z.object({ taskId: z.string() }).strict());
   ```

   Literal ids and literal filter definitions only: the generator reads them
   from code. Keep registrations in `.ts` files, not in `.vue` script blocks.
4. Embed the chat without React code in the app:
   `defineGlirastesChatElement()` from `glirastes/embed` registers
   `<glirastes-chat endpoint="/api/chat">`. It renders in a Shadow DOM,
   themes through `--glirastes-chat-*` CSS variables, emits
   `glirastes-chat:ready`, `:status`, `:tool-result` and `:error`, and frees
   the microphone when removed. The page needs `react`, `react-dom`,
   `@ai-sdk/react` and `ai` installed.
5. Configure `.glirastes/tools.json` with the supported sources, run
   `glirastes tools refresh` and the work lists of `setting-up-glirastes`.
   For the parts marked "not yet", write down which endpoints, pages or
   actions are missing as tools and stop there. Do the same for an API the
   chat handler cannot reach (step 2) and name the origin or credential it
   needs.
6. Build the backend and the frontend with the refresh step of their build
   (`glirastes tools refresh` locally, frozen in CI, integrity in Docker) and
   commit `.glirastes` with the code.

## Commands

```bash
glirastes tools refresh
glirastes tools status
glirastes tools check
glirastes tools check --integrity-only
```

## Verification

- The chat handler refuses a request without a valid session; the API
  refuses a tool call the user may not make.
- `glirastes tools status` lists the client actions, filters and endpoints the
  table promises for this app; the open gaps are reported, not faked.
- `<glirastes-chat>` mounts and unmounts without leaving a microphone stream
  open, and keyboard use works.
- `glirastes tools check` passes in CI without secrets.
