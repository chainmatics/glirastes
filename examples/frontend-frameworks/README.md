# Angular, SvelteKit and Nuxt browser references

These are actual framework applications embedding the existing `<glirastes-chat>`
component. They do not implement another SDK, model loop or native backend adapter.
The shared `mount-chat.ts` is small application glue: fetch an authenticated identity,
configure a scoped browser session before connecting the element, register the
app's router and action, and unregister/remove everything on teardown.

## Versions and prerequisites

Run from the SDK checkout with its dependencies installed and `bun run build`
completed. Each application has a committed Bun lockfile and pinned framework:

| Application | Versions used | Lifecycle boundary |
| --- | --- | --- |
| Angular | Angular 21.2.26, CLI/build 21.2.30 | `afterNextRender`, `DestroyRef` |
| SvelteKit | Kit 2.70.4, Svelte 5.57.3, adapter-node 5.5.8, Vite 7.3.8 | synchronous `onMount` cleanup, client-only dynamic import |
| Nuxt | Nuxt 4.4.2 | `.client.vue`, `<ClientOnly>`, `onBeforeUnmount` |

The test was run with Node 22.22.2 and real Chrome. The applications intentionally
use versions compatible with that LTS runtime; they do not claim to test the latest
major of every framework. Official lifecycle references:
[Angular](https://angular.dev/guide/components/lifecycle),
[Svelte](https://svelte.dev/docs/svelte/lifecycle-hooks),
[Nuxt](https://nuxt.com/docs/4.x/api/components/client-only).

In this repository the shared module resolves `glirastes/*` to the built root
package. A customer copying the integration into their own application installs
`glirastes` plus its React/AI SDK peers (listed in each fixture package), then
copies only the relevant lifecycle wrapper and mount helper. React remains
internal to the web component; the customer application need not become React.

```sh
bun install --frozen-lockfile
bun run build
for framework in angular sveltekit nuxt; do
  (cd "examples/frontend-frameworks/$framework" && bun install --frozen-lockfile)
done
```

## Interactive frontend-only demo

Start the explicitly fake fixture API in one terminal:

```sh
node examples/frontend-frameworks/shared/fixture-api.mjs
```

Then choose one application:

```sh
cd examples/frontend-frameworks/angular # or sveltekit / nuxt
bun run dev
```

Open the local URL printed by the framework. Ask `Highlight fixture target` or
`Navigate to overview`. The development proxy forwards `/api` to the fixture
server on `127.0.0.1:8899`. Its identity and stream are canned test data: it has no
real login, permissions or model. It binds to loopback and must never be deployed
as a customer backend. Production builds do not include this fake API server.

For a real integration, route `/api/me` to the customer's authenticated backend
and `/api/chat` to its Glirastes runtime (or change the helper's endpoint). The
session must be valid on both paths, with normal backend permissions. Fetch the
actual identity; never hardcode a production user or tenant. Recreate the mounted
component/session store on sign-in or tenant changes. The fixture's demo button
shows the lifecycle teardown, not a login system.

## Browser acceptance

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  PLAYWRIGHT_CHANNEL=chrome \
  node --test tests/frontend-frameworks-browser.test.mjs
```

This command builds all three production applications, starts their actual
production servers (static Angular, SSR SvelteKit and SSR Nuxt), and checks in
Chrome:

- safe mounting without evaluating the embed on the SSR server;
- identity-scoped session configuration before mounting and restoration on reload;
- a streamed UI-tool result invokes the registered frontend action;
- a streamed navigation result calls the real framework router;
- removal releases the shadow-root UI; remount does not duplicate action handlers;
- completing an asynchronous identity request after unmount does not resurrect UI.

The browser test supplies canned `/api/me` and AI SDK stream responses. Backend
permission and real model execution tests belong to `runtime-container-e2e.mjs`.
Passing these frontend contracts does **not** establish a complete-stack corpus
or automatic Angular/SvelteKit/Nuxt route discovery. Routes in these apps are
explicit fixture routes; `registerNavigationBridge` only executes navigation.
