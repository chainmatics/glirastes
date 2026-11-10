# Source-derived reference execution plan

> **For Claude:** Use superpowers:executing-plans for this plan.

**Goal:** Exercise current source contracts through generated bindings and the
existing signed local runtime, including real request handling and deletion.

**Architecture:** Extend the approved small-reference approach, not the product
scope. A Next-shaped fixture has ordinary API input/output schemas and a shared
authenticated query handler. A thin local adapter reads current route files,
loads their existing schema modules, reconciles identities with SDK codegen,
then materializes the existing standalone runtime. The fixture adapter supports
only its actual native handler convention; unknown source patterns stop it.
There is no per-endpoint Glirastes catalogue, external assessment API or
automatic production activation. This is not yet the five-minute or UI gate.

**Tech Stack:** ESM JavaScript fixture, Zod, Next-shaped Web Request handlers,
the built public Glirastes codegen/runtime/AI-SDK/server exports, Vitest.

## Task 1: endpoint execution bridge

- Create `examples/source-driven-next/native/` with a query wrapper, opaque
  in-memory test sessions, task schemas and a normal GET route. No Glirastes
  imports in native application files. This test authentication is not a
  replacement for a target app's existing production authentication.
- Create `examples/source-driven-next/adapter.mjs`: collect current source
  routes with `collectNextEndpointExecutions`, use a restricted native source
  convention to locate schemas, verify fingerprints, then build local bindings
  and a complete setup artifact from the known query-wrapper authorization.
  Schema digests come from actual schemas. No fabricated digest or permissive
  fallback. Keep it local; do not sync source-bearing objects.
- Test `tests/source-driven-next.test.ts`: a fresh native-only directory,
  generate, execute through `createLocalRuntimeSource`, materialized registry,
  AI-SDK wrapper and turn guard, invoke the actual native Request handler.
  Add/change/delete a route and update its schema; regenerate without editing
  adapter/tool definitions. Deny revoked/missing principal and invalid input.
- First run tests RED with absent adapter, then implement and run GREEN.

## Task 2: verification and continuation

- Run `bunx vitest run tests/source-driven-next.test.ts`, full SDK tests,
  typecheck and build. The example uses built public exports, so rebuild before
  testing SDK code changes. Review before a local commit; audit the exact diff.
- Document the actual boundary: handler execution proof is not a running Next
  deployment, LLM routing/browser proof or fresh agent-led installation timing.
- Next complete the native navigation/filter bridge and actual UI dispatch,
  then the fresh Next app's browser workflow and additional reference stacks.
  Preserve existing GID artifacts and all compatibility paths.

## Verified checkpoint — 2026-09-13

Task 1 is implemented as a development reference, not a shipped installer.
Four tests first failed on the absent bridge. Native app sources remain free
of Glirastes imports. The adapter uses the built public SDK exports and actual
Zod schemas, produces source/schema-derived bindings and a complete local
artifact, and invokes the native handler through the signed standalone runtime,
manifest materializer, server tool conversion and AI-SDK turn guard.

Nine reference tests now prove scoped task results, no fetch invocation,
endpoint addition, changed input schema plus handler output on a fresh module
graph, deletion, principal role denial, revoked/missing sessions, unknown
contracts and altered wrapper rejection. Review identified binding-resolution
errors: a different exported GET, a shadowing parameter, and a same-spelled
import resolving to another wrapper. All three were RED before repair and are
now rejected. Independent final re-review ran nine tests and found no open
issue in this bounded reference.

Final full suite: 1,010 tests / 123 files, SDK typecheck and ESM/CJS build pass;
the JavaScript example also passes `node --check`. No SDK production source,
GID source or scoped artifacts changed in this reference increment. No server,
DB, model or external Git call was made. These are not fresh installation,
Next deployment, browser, microphone or production assessment measurements.

Next: extend this same native fixture with navigation and filter configuration
actually consumed by its UI. Derive the navigation target/filter input domains
from that single configuration, register a thin UI-action bridge with the SDK's
existing `UiActionBus`, and verify actual rendered state plus add/change/delete.
Do not invent a separate record per AI command or rebuild the SDK chat. Then
wire the real Next shell/chat and browser flow, and continue the other reference
stacks and remaining full-goal gates.

## Task 3: native UI configuration and rendered dispatch

- Add `examples/source-driven-next/native-ui/ui-config.json` and `ui.js`:
  UI-owned views/filter definitions, runtime schemas derived from those same
  definitions, native DOM rendering and validated navigation/filter methods.
  These files have no Glirastes dependency. No custom chat is built.
- Add `examples/source-driven-next/ui-bridge.js`: one React hook bridge for
  navigation and one for filtering, using existing `UiActionBus` APIs. The setup
  fixture copies it into the app source so source verification sees the same
  integration that is actually mounted. Unmount removes subscriptions.
- Extend the reference adapter: when native UI configuration exists, derive
  UI observations and schemas, reconcile together with endpoints, validate
  declared handler presence, and use the existing UI tool conversion/runtime.
  Missing previously configured UI sources must fail, not imply successful
  deletion. Removing the final actual filter removes that tool with a tombstone.
- RED/GREEN in `tests/source-driven-ui.test.tsx`: native rendering; navigation
  and filtering through runtime tool result plus mounted bus bridge; add/change/
  delete view and filter domains across source builds; reject removed values;
  removed bridge/config and unmount; no network/Platform action. Use jsdom and
  actual React effects, not mocked UI handlers. This is DOM integration proof,
  still not the real-browser or full SDK chat acceptance gate.
- Run both reference suites, full tests, build/typecheck and independent review.
  Then wire the actual Next shell/chat and browser rather than declaring the
  synthetic fixture to be a completed reference-app acceptance.

### Task 3 verified checkpoint — 2026-09-13

Native UI contracts/rendering and the setup-time React bus bridge are now
implemented. Five tests first failed on absent native rendering; after the
bridge was implemented, the copied target app revealed a missing SDK package
link. The fixture now explicitly links the local built SDK, instead of relying
on self-reference resolution from the SDK's own package scope.

Six UI tests plus nine endpoint tests pass. UI evidence includes the actual
copied bridge mounted with React effects; runtime-generated action payloads
dispatched through UiActionBus; headings, rows and selected options; normal
buttons/selects; view addition/rename/removal; filter field/value changes;
last-filter removal/tombstone; missing bridge/config rejection; unmount and
no fetch invocation. Schemas and UI both read the same native configuration.
No per-view/per-filter Glirastes catalogue is maintained.

Full SDK: 1,016 tests / 124 files, typecheck, ESM/CJS build and JavaScript syntax
checks pass. Independent review ran both reference suites (15 passing tests)
and found no blocking issue. README now includes the UI command and evidence
boundary. No production SDK/GID source changes, remote requests or deployment.

Next required acceptance work is the real Next shell/API process and existing
SDK chat in a browser, including actual streamed tool results reaching this
UI bridge. Persist generation state at the build boundary and expose all
runtime prerequisites. Do not count the current handler/DOM corpus as real
browser, agent-installation timing, STT, or the completed three-stack gate.

## Task 4: real Next process and streamed chat-to-UI proof

Use the existing isolated SDK worktree. No customer app, database, model key or
Platform connection is involved. The reference model is deterministic test
infrastructure, not evidence of language understanding or token savings.

1. Add a failing `tests/source-driven-browser.test.mjs` (Node test runner):
   prepare a fresh copy of the native app with the existing SDK chat; boot Next
   on loopback with a minimal environment; require an opaque test session;
   POST actual UI messages, inspect streamed tool results and native scoped
   endpoint output. Use Playwright Chromium for visible navigation and filtering.
2. Add `examples/source-driven-next/build.mjs`: run source generation before
   Next, emit static native schema imports and public SDK runtime bindings.
   Persist inventory/tombstones with the generated runtime in one atomically
   replaced file; a failed assessment must preserve the last good file and
   fail the build. Never scan/import TypeScript codegen per chat request.
3. Add `browser-shell/` with a Next layout/page and chat/session routes outside
   the native API discovery directory. Mount `VercelAiChat`, native UI and its
   existing action bridge. The test-only session endpoint requires an ephemeral
   capability and an explicit test-mode flag; never replace app authentication.
4. Add a development fixture preparer with explicit local SDK/dependency links.
   Test-model calls run through the SDK's normal streaming handler, signed local
   source, principal checks and tool guards. The HTTP tool path must use the
   actual Next native route, not the earlier in-process handler shortcut.
5. Run `node --test tests/source-driven-browser.test.mjs`, both prior reference
   suites, full SDK tests/typecheck/build and a real Next production build.
   Inspect browser console and visible UI. Review the bounded diff independently,
   update README/canonical evidence and make a local commit. Real model routing,
   STT, fresh agent timing and other stacks remain separate open gates.

### Task 4 verified checkpoint — 2026-09-13

The reference now runs a real Next 15.5.15 process and the existing public
VercelAiChat component in Chrome. A deterministic AI-SDK V3 test model drives
the normal SDK streaming handler, signed standalone source, principal/turn
guards, actual HTTP native endpoint and streamed UI actions. No special chat
transport or replacement runtime was introduced. Generated bindings use static
native schema imports; codegen stays at the build boundary.

RED evidence: missing real-app preparer/build emitter; a linked generation
directory incorrectly accepted; normal app startup retaining a stale navigation
schema after native config changed; missing bounded process-group cleanup.
GREEN evidence: three build tests cover persistent identities/tombstones,
signed importable runtime, last-good preservation, linked-directory/external
sentinel protection and failed assessment stopping the normal build before
Next. Real app dev/build commands regenerate; production start serves its build.

The browser corpus passes with both Next dev and production build/start. It
checks unauthorized chat/bootstrap rejection, scoped real HTTP endpoint results
in SSE, a changed navigation schema after setup, visible SDK-chat navigation
and filtering, and zero browser console/page errors. The screenshot was visually
inspected: native selected filter and resulting task are visible beside the SDK
chat. A separate subprocess test proves SIGTERM-resistant test processes are
terminated with bounded escalation, including surviving descendants after the
group leader exits. Production rerun: 3/3 Node tests pass.

Full SDK suite: 1,019 tests / 125 files pass. Typecheck and ESM/CJS build pass.
Next build and browser checks use local fictional data and an explicitly gated
ephemeral test-session bootstrap, no external model or Platform request. The
first failed browser attempts exposed missing local Chromium (used installed
Chrome), favicon 404, tracing-root warning, and premature cache removal; those
test/environment issues are resolved. Two trace-only caches from early attempts
remain untracked because host policy rejected both deletion and relocation;
they are not commit inputs. Final test runs self-clean.

This closes the bounded real Next/chat/HTTP/DOM-delivery proof, NOT fresh agent
installation timing, real-model routing quality, STT, the full cross-deployment
change matrix, GID/upstream reconciliation, or three-stack MVP acceptance. The
current fixture's UI labels still include technical tool names/pipeline text;
it is functional evidence, not the novice usability gate. No customer runtime,
DB, production SDK source, GID artifacts or remote Git/deployment state changed.

Next: carry the source-derived setup/build workflow into the current-upstream
Get It Done reconciliation and prove endpoint/navigation/filter add/change/
delete through real deployments, then the separate-backend and non-React/non-TS
references. Do not extend this small fixture into a second standalone product.
