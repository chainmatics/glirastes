---
name: integrating-glirastes-web
description: Use when integrating Glirastes into an app with a separate backend (NestJS, FastAPI or another API), a non-React frontend (Vue, plain web components) or a Node sidecar next to a non-Node backend, or a frontend/backend framework without a dedicated adapter.
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

If two NestJS controllers declare the same method and path, `glirastes tools refresh` reports one `route-declared-twice` error naming both files, gives that route no enabled tool and still generates every other tool; remove one declaration, or exclude the route with `glirastes tools policy exclude`.

Two reference apps in the SDK show the sources together:
`examples/react-nest-separate` (a NestJS API on its own origin and a Vite
React frontend) and `examples/vue-fastapi` (a FastAPI API, a small Node chat
runtime next to it and a Vite Vue frontend).

## Choose a path for each layer

Read `docs/support-matrix.md` in the matching SDK checkout (not relative to
a copied project-local skill). If unavailable, use the source table below
and leave complete-stack verification unconfirmed. Record frontend,
backend, chat runtime, endpoint discovery, navigation, filters and client
actions separately as **directly integrated**, **generically connectable** or
**gap**, with source/code evidence. A generic path is conditional on the app's
contracts; it is not proof that its whole stack is officially supported.

1. **UI:** React uses the React chat components. Otherwise use
   `<glirastes-chat>` and verify custom-element mounting in the target framework.
   The element still requires the React/AI SDK dependencies listed below.
2. **Endpoints:** use `next-app` or `nest` when their source shapes match.
   Otherwise use a committed OpenAPI 3.1 JSON export. With no supported source
   or suitable export, endpoint discovery is a gap; do not invent a tool list.
3. **Runtime:** adapt a Node backend to the handler's Web `Request`/`Response`,
   or run a declared Node sidecar beside a non-Node backend. A Java/Python/PHP
   API does not run the TypeScript SDK itself.
4. **Frontend capabilities:** use a supported page/router source where available.
   `registerNavigationBridge` executes navigation; it does not discover pages
   from Angular, Svelte or another unknown router. Put client actions and
   literal `defineQueryFilters` declarations in scanned JS/TS modules when the
   framework's component format is unsupported. Verify declared filter paths
   manually when no supported router source can cross-check them.
5. **Partial coverage:** continue with independently usable supported parts,
   but stop work on each unsupported capability and report it explicitly.
   Do not present a chat shell as working API tools or a bridge as discovered
   navigation. Never replace the generator with hand-written tool inventories.

For example, Angular + Java with a suitable OpenAPI export can use the web
component, a Node sidecar and generated API tools; Angular page discovery
remains a gap. Svelte + Django without an export has an endpoint-discovery gap
as well. Neither combination has a complete stack corpus in the support matrix.

### OpenAPI without FastAPI

Use this entry in the existing `sources` array of `.glirastes/tools.json`:

```json
{ "kind": "openapi", "document": "api/openapi.json" }
```

Omit `fastapi` for Express, Django, Java or any other non-FastAPI backend.
Regenerate the export from the backend's authoritative API/schema before
`tools refresh`, and make CI detect stale exports. The generic source reads
only the document; the Python source-route count is specific to `fastapi`
and does not prove that paths or schemas with unchanged counts are current.
OpenAPI 3.0 and YAML are not accepted by this source. Check generator findings
for unsupported operations/schemas and authentication evidence; a valid 3.1
file alone does not prove that every endpoint becomes an enabled tool.

## Workflow

1. Decide where the chat handler runs: in a Node backend next to the API, or
   in a small declared Node sidecar when the API is not Node (FastAPI). The
   handler is framework-neutral: `createAiChatHandler` (from
   `glirastes/server/nextjs`, despite the name) takes a Web `Request` and
   returns a `Response`; adapt your framework's request object to it.
2. Endpoint tools call the API with the user's own credentials. By default
   `createAiChatHandler` sends each call to the origin of the Web
   `Request` URL it was given and forwards only the chat request's session
   cookie. It does not read `Host` or `x-forwarded-host` itself, but the
   origin is only as fixed as that URL: Next.js builds it from the address
   its server listens on (behind a proxy, for example
   `http://localhost:3000`); outside Next.js it is whatever your adapter puts
   into the `Request` URL. An adapter that builds the URL from the `Host`
   header (as many Express or NestJS examples do) lets any client choose
   where the calls, with the user's cookie, go. Outside Next.js, therefore
   either pass `endpointCaller` with a fixed `baseUrl` (below) or build the
   `Request` URL from a fixed origin of your own, never from `Host`. When the API runs in another process, also when a front proxy
   puts it under the same public origin as the handler (a proxy that routes
   `/api` to the backend, as 0.4.0 apps often did), the default calls miss
   it: pass
   `endpointCaller: (request) => createHttpEndpointCaller({ baseUrl: apiOrigin, request })`
   (from `glirastes/server`) with the API's fixed origin as the handler's
   server can reach it (the public origin or an internal address). Every
   call goes to that origin and carries only the
   `cookie` and `authorization` headers of that chat request. Do the same for an API on
   its own origin and for one that authenticates by bearer token. Only when
   every request reaches the handler through a proxy that sets
   `x-forwarded-host` may you set `trustForwardedHeaders: true` instead;
   if the handler can also be reached directly, any client can then point
   the calls, with the user's cookie, at any host. An API served by the
   handler's own server (a NestJS app that also mounts the handler) is
   reached by the default only when the adapter builds the `Request` URL
   from that server's fixed own origin. Do not use a service account or add credentials the user did not
   send; an API that needs another credential is an open gap (step 5).
   Tell the user to set `GLIRASTES_APPROVAL_SECRET` (at least 16 random
   characters, the same on every instance) in production: the handler signs the
   approvals it asks for with it and refuses to serve approvals without it. A
   front end on another origin than the handler must be listed in
   `allowedOrigins`.
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
   syntax only (the app is never imported). Refresh stops on a route-count
   mismatch; equal counts do not prove current paths or schemas. Regenerate
   the export and verify freshness in CI for every backend. Declare authentication as a security
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
   actions are missing as tools and stop that capability; continue only
   independently usable supported parts. Do the same for an API the
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

### Target-app acceptance and report

For a generic integration, record the SDK version/commit and the per-layer
coverage above, then verify in the real app:

- One authenticated read reaches the intended API as the same user; anonymous
  and unauthorized calls are refused by the handler/API as applicable.
- If the app exposes writes, one reversible write waits for approval and
  executes only after approval; rejection causes no mutation. Use a development fixture, not production data.
- Chat streaming and one registered frontend action work in a real browser.
  Verify navigation and filters only where configured; label missing ones.
- Export regeneration, `tools refresh` and `tools check` detect a representative
  endpoint change. For every backend, verify the app's own stale-export check.

Report observed results and missing checks separately. A passing CLI check
alone does not establish browser behavior or complete framework support.
