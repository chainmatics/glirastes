# Support matrix

This page distinguishes complete reference stacks from generic integration
paths in this SDK checkout. A level is claimed only where the evidence named next to it exists; `tests/support-matrix.test.ts`
keeps this page and the evidence in step.

## Levels

| Level | Meaning |
| --- | --- |
| Detected | `glirastes setup inspect` names the framework from the project manifests. |
| Integrated | `glirastes tools refresh` derives tools from the stack's source kinds and the runtime executes them. |
| Automatically checked | The reference fixture's change corpus passes in CI: endpoint, navigation and filter, each added, changed and removed (9 tests), with `tools check` red before the refresh and the runtime booted from the committed outputs after it. |
| Officially supported | Automatically checked, proven in a real browser, and running in a pilot app whose user test is recorded in `docs/acceptance/`. |

## Stacks

| Stack | Detected | Integrated | Automatically checked | Officially supported | Evidence |
| --- | --- | --- | --- | --- | --- |
| Next.js 15 App Router | yes | yes | yes | after the recorded user test | `tests/tool-sync-next.test.ts`, `tests/tool-sync-next-ui.test.ts`, `examples/source-driven-next` |
| React (Vite, react-router) + NestJS 11 | yes | yes | yes | no | `tests/tool-sync-react-nest.test.ts`, `tests/tool-sync-react-nest-ui.test.ts`, `examples/react-nest-separate` |
| Vue 3 (vue-router) + FastAPI, Python 3.12 | yes | yes | yes | no | `tests/tool-sync-vue-fastapi.test.ts`, `tests/tool-sync-vue-fastapi-ui.test.ts`, `examples/vue-fastapi` |
| Next.js 16 App Router | yes | yes | no | no | Get It Done runs it; the `next` peer range stays `^15` until a corpus runs on 16 |
| Other stacks (Express, Remix, Nuxt, Django, …) | no | no complete stack integration | no | no | generic paths below; no stack corpus |

The Vue + FastAPI corpus needs Python 3.12. CI runs it in its own job; a local run
without Python skips it visibly, and a skipped corpus is not a passed one.

## Generic integration paths

Assess frontend and backend independently. The stack table describes complete
reference integrations; a missing stack adapter does not rule out using the
interfaces below. **Generically connectable** means a documented path exists
subject to the app meeting its contracts, not that the stack has passed a
browser test, CI corpus or pilot acceptance.

| Layer | Direct integration | Generic path | Remaining boundary |
| --- | --- | --- | --- |
| Chat UI | React components | `glirastes/embed` registers `<glirastes-chat>` in a browser frontend | Verify the framework's custom-element integration; React and AI SDK dependencies are still required internally |
| API tools | Next.js route handlers; NestJS controllers with supported schemas | Any backend exporting a committed OpenAPI 3.0.x or 3.1.x JSON document, using the `openapi` source (3.0 `nullable` and boolean `exclusiveMinimum`/`exclusiveMaximum` are normalized to their 3.1 form on load); `selection: "opt-in"` with `x-glirastes-tool`/`-name`/`-group`/`-roles` selects and names operations in the export ([table](tool-policy.md#openapi-source-selection-and-x-glirastes--extensions)) | No generic source-code scanner; YAML and Swagger 2.0 are not read; export freshness is the app's responsibility (FastAPI additionally checks route counts); multipart and other non-JSON bodies and other unsupported operations remain gaps. Accepting a 3.0 export is not a tested NestJS + `@nestjs/swagger` stack |
| Chat runtime | Next.js handler integration | Adapt a Node server with `glirastes/server/http` (Web `Request`/`Response`) or `glirastes/server/node` (`createNodeHandler` for `node:http`-style servers), or run the configured runtime service beside a non-Node application | `glirastes/server/node` is integration-tested on `node:http` and Express 5; Fastify (`reply.hijack()`) and NestJS on Express are documented recipes without a test here ([node servers](node-servers.md)). One service per app/environment in V1 for the container; several embedded instances need a shared `approvalStore` ([chat-route-security](chat-route-security.md#running-more-than-one-instance)); a per-instance sidecar is a separate deployment choice, not required |
| Client actions | Registrations in supported JS/TS files and Vue script blocks; a literal `{ route }` makes an action page-bound (the chat opens the route first) | Put `registerAiClientAction` registrations in ordinary JS/TS modules imported by the app | Arbitrary framework templates and `.svelte` files are not scanned; `route` must be a static path |
| Navigation | `next-pages`, supported `react-router` route objects, `vue-router` records | `registerNavigationBridge` connects execution to the app's router | The bridge does not discover pages; an unknown router has no automatic navigation inventory |
| Filters | Supported page/router sources and URL-filter declarations | Literal `defineQueryFilters` declarations in scanned modules plus a navigation bridge | Verify paths against the app; without a supported router source there is no route-inventory cross-check |

Use [integrating-glirastes-web](../skills/integrating-glirastes-web/SKILL.md)
for the decision sequence and target-app verification. No complete Angular,
Svelte, Express, Django or Java stack support is claimed by these paths.

## Source kinds

| Source kind | Derives | Automatically checked by |
| --- | --- | --- |
| `next-app` | endpoint tools from route handlers | Next |
| `nest` | endpoint tools from controllers and Zod pipes | React+NestJS |
| `openapi` | endpoint tools from an OpenAPI document (FastAPI count) | Vue+FastAPI |
| `next-pages` | the navigation tool from the page tree | Next |
| `react-router` | the navigation tool from route objects | React+NestJS |
| `vue-router` | the navigation tool from route records | Vue+FastAPI |
| `url-filters` | filter tools from `defineQueryFilters` declarations | Next, React+NestJS, Vue+FastAPI |
| `react-actions` | client action tools from `useAiClientAction` and `registerAiClientAction` | none (browser tests only) |

## Deferred package exports

The exports `glirastes/server/nestjs`, `glirastes/openapi` and `glirastes/react/langgraph`
are deferred and not shipped. `glirastes/server/testing` is ESM only, because Vitest
cannot be required from CommonJS.

## Configured runtime service V1

The [runtime container](runtime-container.md) packages the same SDK for
non-Node APIs. `tests/runtime-container-e2e.mjs` is the PHP acceptance harness
(real PHP/PostgreSQL, scripted model, optional built image and browser). It does
not establish full Rust/Java framework support or replace the complete-stack
criteria above. One active runtime per application/environment; no HA claim.

Version 0.27.0 is published on npm and as the public Linux amd64 image
`ghcr.io/chainmatics/glirastes-runtime:0.27.0`. The
[acceptance record](https://github.com/chainmatics/glirastes/blob/v0.27.0/docs/acceptance/2026-11-15-runtime-container-v1.md) of 0.14.0 links the release
gates and the separate embedded Get It Done production smoke test. Publication
and a successful embedded pilot do not certify a customer's container deployment.

## Chat views

Optional generative UI in the chat ([chat views](chat-views.md)), off unless
`chatViews` is set on the chat handler. Tested in CI; no real-browser or pilot
acceptance is recorded.

| Binding | Status | Evidence | Limits |
| --- | --- | --- | --- |
| React (`glirastes/react`: `ChatView`, `starterChatBindings`, `bindChatComponent`) | shipped | `src/react/chat-views/__tests__/chat-view.test.tsx`, `src/server/adapters/nextjs/__tests__/render-view.test.ts` | one view per answer, snapshot only, buttons only `prompt` and `uiAction` |
| Text renderer (`chatViewToText`, `chatElementToText` in `glirastes`) | shipped | `src/chat-views/__tests__/text.test.ts` | also the fallback for every element without a binding |
| Codegen manifest (`glirastes tools refresh` → `.glirastes/chat-components.json`) | shipped | `src/codegen/tools/sources/chat-components.test.ts` | exported `defineChatComponent` definitions importable in Node |
| `<glirastes-chat>` (Web Components), native clients | not claimed | none | no own binding; app components need React |
| Configured runtime container | not available | none | no `chat.chatViews` option yet; chat views are off |

## Experimental

Shipped, tested in CI, without a stability promise: options, defaults and the
pinned peer version may change in a minor release, with an upgrade note.

| Feature | Platforms | Evidence | Limits |
| --- | --- | --- | --- |
| Local STT (`glirastes/server/stt-local`) | linux-x64 (glibc 2.32+), linux-arm64, darwin-arm64; musl/Alpine refused | `.github/workflows/stt-local-addon.yml` (release gate: packed tarball, addon, worker restart), `.github/workflows/stt-local-smoke.yml` (real model, German fixture, > 20 s clip; weekly, not a gate) | `sherpa-onnx-node` pinned to 2.0.1; one worker per process, queue 4; ~2 GB memory; Next.js needs `serverExternalPackages`; see [local STT](local-stt.md) |

## Browser frontend references

`examples/frontend-frameworks` contains actual Angular 21, SvelteKit 2/Svelte 5
and Nuxt 4 applications. `tests/frontend-frameworks-browser.test.mjs` builds each
application and checks mounting, identity-scoped session restoration, streamed
frontend actions, real router navigation and teardown/remount in a browser.
The runtime-container workflow runs this gate before publishing an image.

These are tested **frontend host contracts**, with scripted identity/chat
responses. They do not promote those frameworks to complete-stack support,
add source scanners or discover routes automatically. The PHP runtime test
separately exercises the actual backend, identity and approval pipeline.
