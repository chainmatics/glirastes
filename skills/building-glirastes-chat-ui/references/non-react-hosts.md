# Browser-only chat mounting and identity isolation

Angular, SvelteKit, Nuxt, Vue and plain browser code can use `<glirastes-chat>`.
The element hosts the existing React UI in Shadow DOM; the application need not
be rewritten in React. Install matching `glirastes`, `react`, `react-dom`,
`@ai-sdk/react` and `ai` versions in the frontend bundle. Model/provider keys
remain server-side. A backend can use any language supported through the HTTP
runtime; frontend lifecycle and backend authorization are separate concerns.

Import `glirastes/embed`, `glirastes/browser` and `glirastes/react` browser helpers
only after entering a browser lifecycle. Do not import them statically into an
SSR entry and assume a client-only render guard is sufficient.

## Mount before the first session load

Create the element detached, set attributes and JS `config`, then append it.
In particular, `config.session` must exist before `connectedCallback` renders
the provider. An HTML attribute cannot serialize functions, session stores or
request header callbacks.

The following helper lives in an ordinary `.ts` frontend module. It deliberately
imports the SDK only inside the browser call and ignores stale asynchronous
initialization. Identity values come from the application's verified session
endpoint; they select local display/storage state, never server permissions.

```ts
export function createChatMount(
  host: HTMLElement,
  appId: string,
  environment: string,
) {
  let epoch = 0;
  let chat: HTMLElement | undefined;

  async function setIdentity(
    identity: { userId: string; tenantId: string } | null,
  ) {
    const current = ++epoch;
    chat?.remove();
    chat = undefined;
    if (!identity) return;

    const [{ defineGlirastesChatElement }, { createLocalSessionStore }] =
      await Promise.all([import('glirastes/embed'), import('glirastes/react')]);
    if (current !== epoch || !host.isConnected) return;

    defineGlirastesChatElement();
    const next = document.createElement('glirastes-chat');
    next.setAttribute('endpoint', '/glirastes/chat');
    next.config = {
      session: createLocalSessionStore({
        storageKey: JSON.stringify([
          appId, environment, identity.tenantId, identity.userId,
        ]),
      }),
      // Optional: headers: () => ({ 'x-csrf-token': currentCsrfToken() }),
    };
    chat = next;
    host.append(next);
  }

  return {
    setIdentity,
    dispose() {
      ++epoch;
      chat?.remove();
      chat = undefined;
    },
  };
}
```

Call `setIdentity` after the verified identity is known and whenever user or
business tenant changes. Call it with `null` immediately on logout. Recreating
the element is required: replacing `config` on an already mounted provider
alone is not an identity boundary. Decide whether logout also deletes retained
local conversations according to application privacy requirements. A changed
localStorage key is namespacing, not an access-control mechanism against another
person with access to the same browser profile.

Use the actual embedded endpoint if the runtime is hosted in an existing server;
`/glirastes/chat` is the configured service default. Do not enable the `interactions`
attribute, speech or attachment features unless the selected host serves their
required APIs. The configured V1 service does not add those routes automatically.

## Framework lifecycle

- **Angular:** create a host element and mount after browser rendering, with
  an SSR browser guard. Register cleanup with the component's destruction
  lifecycle. DOM mounting avoids custom-element config being interpreted as a
  string attribute. Bridge navigation to the existing Angular router; route
  inventory is not automatically scanned.
- **SvelteKit:** mount in `onMount`, and return cleanup synchronously. Do not
  make the `onMount` callback async; start the async identity/mount work inside
  it and ensure disposal invalidates pending work. Keep action registrations
  in scanned `.ts`/`.js` modules because `.svelte` files are not scanned.
- **Nuxt:** use a `.client.vue` component or client-only plugin. Mount after
  `onMounted`, dispose in the unmount lifecycle and watch the verified identity
  key. Vue-router execution works through the bridge, but Nuxt file-based pages
  are not automatically a supported route inventory.
- **Vue/plain JS:** the same detached-element/config/append ordering applies;
  dispose when the view is removed and remount on identity changes.
- **Layout without React slots:** `config.activityLog` (`expandWhileRunning`,
  `runningProgress`, `noticePlacement: 'message'`, `details`, `grouping`,
  `noticeScope: 'latest'` to show the stop notice on the latest turn only,
  `hiddenTools` for UI-only tools), `config.messageFooter` (copy, sources,
  duration, stop per answer), `config.suggestions.placement: 'message'`
  (follow-ups under the latest answer),
  `config.approvalDisplay` (`decided: 'entry'`, `open: 'inline'`; leave `decided` off if the host draws its own entry for decided approvals, both would show),
  `config.queue` (message queue, `docs/chat-queue.md`),
  `config.entityLinks.mentionMarkers` and the `data-*` hooks of
  the shadow root cover what `components.TurnNotice`/`MessageParts` do in
  React; the shadow-root styles carry the same `prefers-reduced-motion` rules.

The matching SDK repository contains `examples/frontend-frameworks`. These
examples illustrate integration; a generic browser wrapper does not establish
complete official framework support or automatic router discovery.

## Frontend actions and navigation

Use `registerAiClientAction` and `registerNavigationBridge` from
`glirastes/browser`, loaded in browser code. Register each action where its state
lives, supply its payload schema and `{ route }` when page-bound, and dispose the
returned registrations during unmount. Return `false` if the requested UI effect
could not be performed. Use literal registrations in supported JS/TS sources so
`glirastes tools refresh` can discover them. Unknown template formats need an
ordinary scanned module; never fake a tool inventory.

What the user has open goes with each new message once the page registers it: `registerViewContext(source, { entity: { type, id } })` from `glirastes/browser`, unregistered on leaving the page; `currentViewContext()` returns what would be sent (an own transport adds it as `glirastesViewContext`). Nothing is read from the URL. To turn it off, register nothing (or pass `null`), or set `viewContext: false` on the server; there is no switch per chat element.

A navigation bridge maps execution to the app router; it does not discover
pages. Return `false` from `push` when the navigation did not happen;
vue-router resolves a failure, so pass `async (href) => !(await
router.push(href))`. Without client-side routing call
`registerDocumentNavigation()` (`location.assign`, outcome `initiated`). The
element emits `glirastes-chat:ui-action` with `{ toolName, toolCallId, code,
actionIds }` for every outcome and reports it to the model (outcome protocol).
On a server-rendered page the element remounts per page: give it a `session`
(storage) so the turn continues once on the new page; without one the chat
starts empty there. A strict proxy must allow the body field
`glirastesUiOutcomes`. Only supported explicit route sources can supply that inventory. Keep
manual verification of filter paths where automatic route cross-checking is
unavailable. Neither UI visibility nor a client action can grant backend access.

Verify in a real browser: initial mounting and persisted-session restore,
streaming, a registered action, teardown, logout, rapid identity switches and
switching business tenants for the same user. The new identity must not inherit
messages, pending approvals, requests or callbacks from the previous mount.
