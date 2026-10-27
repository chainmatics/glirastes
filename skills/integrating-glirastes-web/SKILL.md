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
  with the user's own session cookie or bearer token, never with a service
  account that has more rights than the user.
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
| Client actions in `.ts`, `.tsx`, `.js` files and in `<script>` / `<script setup>` blocks of `.vue` files (`useAiClientAction`, `registerAiClientAction`, `bus.subscribeById`) | yes | `react-actions` |
| URL filters of SPA views declared with `defineQueryFilters`, or `nuqs` `useQueryState` in a routed page | yes | `url-filters` |
| NestJS controllers with Zod pipes or `createZodDto` | yes | `nest` |
| react-router route objects (`createBrowserRouter([...])`, `useRoutes([...])`) | yes | `react-router` |
| FastAPI (or any API) through its committed OpenAPI 3.1 JSON export | yes | `openapi` |
| vue-router routes of `createRouter({ routes: [...] })` | yes | `vue-router` |
| JSX `<Route>` trees, OpenAPI 3.0 or YAML exports, `<script>` blocks in another language than ts or js | not yet | report as an open gap |

Two reference apps in the SDK show the sources together:
`examples/react-nest-separate` (a NestJS API on its own origin and a Vite
React frontend) and `examples/vue-fastapi` (a FastAPI API, a small Node chat
runtime next to it and a Vite Vue frontend).

## Workflow

1. Decide where the chat handler runs: in a Node backend next to the API, or
   in a small declared Node sidecar when the API is not Node (FastAPI). The
   handler is framework-neutral: `createAiChatHandler` (from
   `glirastes/server/nextjs`, despite the name) takes a Web `Request` and
   returns a `Response`; adapt your framework's request object to it.
2. Endpoint tools call the API with the user's own credentials. By default
   `createAiChatHandler` sends each call to the origin the chat request
   arrived on and forwards only its session cookie, so an API on the
   same origin as the handler (a reverse proxy or the dev server routes
   `/api` to the backend) needs nothing more. For an API on its own origin, or one that
   authenticates by bearer token, pass
   `endpointCaller: (request) => createHttpEndpointCaller({ baseUrl: apiOrigin, request })`
   (from `glirastes/server`): every call goes to that fixed origin and
   carries only the `cookie` and `authorization` headers of that chat
   request. Do not use a service account or add credentials the user did not
   send; an API that needs another credential is an open gap (step 5).
   In NestJS, validate input with a Zod pipe (`@Body(new ZodValidationPipe(schema))`,
   `@Query(...)`) or with `createZodDto` and a global `ZodValidationPipe`,
   guard with `@UseGuards` or a global guard, and keep `@Controller` paths and
   `setGlobalPrefix` string literals. The generator stops instead of guessing
   on `RouterModule`, `enableVersioning` or a computed path.
   In FastAPI, the generator reads the OpenAPI document the app exports, so
   the server validates exactly the schemas the tools use. Export it with
   `json.dumps(app.openapi(), indent=2, sort_keys=True)` to a committed file
   (for example `api/openapi.json`) and run the export before every
   `glirastes tools refresh`. Configure
   `{ "kind": "openapi", "document": "api/openapi.json", "fastapi": "api/app" }`:
   with `fastapi`, Python 3.12 counts the routes of that directory from
   syntax only (the app is never imported) and the refresh stops when the
   export is older than the code. Declare authentication as a security
   dependency (`APIKeyCookie`, `HTTPBearer`) so it appears in the export;
   an operation without `security` needs attention. A route with
   `include_in_schema=False` stays out of the chat and is reported. Declare
   an effect stronger than the method suggests with
   `openapi_extra={'x-glirastes-effect': 'destructive'}` (it can only raise
   the risk), and keep a route out with
   `openapi_extra={'x-glirastes-ignore': True}`.
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
   from code, in `.ts` modules and in the `<script lang="ts">` or
   `<script setup lang="ts">` blocks of `.vue` files (a `src` attribute is
   not followed). With a route config (`vue-router`, `react-router`), a
   `defineQueryFilters` path that no route serves gets no tool and a warning.
   In vue-router, keep `path` string literals and static `component` or
   lazy `() => import('...')` views; an `alias` stops the refresh, a
   redirect-only route is not a page.
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
