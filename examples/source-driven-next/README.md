# Source-derived execution reference (development proof)

This is a small **native-handler and UI integration proof**, not a production-ready
Next.js starter or the finished one-command installer.

The files under `native/` are an ordinary app-shaped fixture: request/response
schemas, authenticated query handling and a task endpoint. They do not import
Glirastes or define a second AI tool catalogue. A setup agent's thin adapter
can connect that existing convention to the shared SDK.

From the SDK worktree, with its dependencies already installed:

```sh
bun run build
bunx vitest run tests/source-driven-next.test.ts tests/source-driven-ui.test.tsx
```

The test copies only the native app to isolated temporary directories. It then:

1. Enumerates current route source with the SDK collector and loads the app's
   real input/output schemas locally.
2. Generates app-scoped identities, schema/source fingerprints and bindings.
3. Creates the existing self-signed standalone runtime, pins a turn and resolves
   the principal from the app's server-side session store.
4. Executes an AI-SDK-wrapped tool through the runtime guard and the actual Web
   Request handler, retaining role checks and filtering data by the caller.
5. Adds, changes and removes an endpoint without editing the adapter or a tool
   list. A changed schema and changed handler are checked after a new app build.

The UI corpus additionally copies the ordinary UI files from `native-ui/`,
links the locally built SDK into the target fixture, and installs the one-time
`ui-bridge.js`. The actual copied bridge mounts with React effects and the
existing SDK `UiActionBus`; its cleanup removes subscriptions on unmount.

The app's `ui-config.json` drives both native controls and input schemas. One
navigation tool offers exactly the current view IDs. One filtering tool offers
only the fields and values supported by each view. Changing that app config
updates the generated schemas/fingerprints without editing tools. Removing the
last filter removes its tool and records a tombstone. Missing configured UI
sources or a missing declared handler do not count as successful regeneration.
Tests inspect headings, visible rows and selected options in jsdom; native
button/select interactions use the same configuration as tool-driven actions.

`adapter.mjs` is intentionally specific to this fixture's native query
convention. It is not a universal parser, automated security assessment or a
new public SDK API. Unknown route conventions/contracts and a changed shared
authorization wrapper require local reassessment. Native modules are trusted
application code executed inside the customer environment, not in the platform.
The fixture's read classification is not a blanket rule that any GET is safe.

Important boundaries:

- The in-memory session implementation is **test-only**. A real app keeps its
  existing authentication and server-side principal resolution.
- This is in-process handler execution plus jsdom/React-effect integration,
  not HTTP socket/Next server, real-browser, language-model, streaming or
  microphone acceptance. UI tool success means an action payload was produced;
  the test separately dispatches it and verifies the rendered effect. A missing
  subscriber does not provide a delivery acknowledgement via this bus.
- No model or platform request is made. Local schemas, source and data are not
  synced. A generated artifact is not a platform publication or activation.
- Standalone code/schema changes require a fresh native module graph/process.
  The corpus uses fresh source directories to represent the next deployment;
  it does not claim code hot-reloading within one Node process.
- Generation state, including tombstones, must be persisted by the eventual
  build integration. This proof passes it in memory between builds.
- Native navigation/filter discovery and dispatch have a bounded DOM corpus.
  The actual Next app shell/SDK chat and browser flow, coding-agent installation
  timing and the other two reference integrations remain open goal gates.

Do not copy this fixture's authorization policy or fixed identities into a
customer application. Its purpose is to test the common SDK against a second
source of truth instead of relying only on Get It Done's prepared artifacts.
