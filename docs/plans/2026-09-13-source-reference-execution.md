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
