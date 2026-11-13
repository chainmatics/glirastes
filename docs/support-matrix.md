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
| API tools | Next.js route handlers; NestJS controllers with supported schemas | Any backend exporting a committed OpenAPI 3.1 JSON document, using the `openapi` source | No generic source-code scanner; export freshness is the app's responsibility (FastAPI additionally checks route counts); unsupported operations remain gaps |
| Chat runtime | Next.js handler integration | Adapt a Node server to Web `Request`/`Response`; use a Node sidecar for a non-Node backend | The SDK runtime remains TypeScript/Node; user authentication, streaming and fixed API origin must be wired and verified |
| Client actions | Registrations in supported JS/TS files and Vue script blocks | Put `registerAiClientAction` registrations in ordinary JS/TS modules imported by the app | Arbitrary framework templates and `.svelte` files are not scanned |
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

## Not in 0.5.0

The exports `glirastes/server/nestjs`, `glirastes/openapi` and `glirastes/react/langgraph`
are deferred and not shipped. `glirastes/server/testing` is ESM only, because Vitest
cannot be required from CommonJS.
