---
name: integrating-glirastes-nextjs
description: Use when adding Glirastes chat, source-derived tools, or speech input to a Next.js App Router application.
---

# Integrating Glirastes into Next.js

## Principle

Read `setting-up-glirastes` and its required artifact reference first. The
existing agent performs the integration; a fresh Standalone app needs no
Platform account. Preserve an existing Connected/Managed configuration.
Do not add decorators or a manually maintained second tool catalogue.

## Setup

1. Inspect real route exports, schemas, session authentication, navigation,
   filter state and UI handlers. Use the exact installed SDK surface and peer
   versions. Keep the app's existing package manager and provider choice.
2. Implement the source-derived generator and local artifacts described by
   `setting-up-glirastes`, before setup scan. Preserve tool identities, tuned
   prompts and approved policy. Derive executable schemas from real handlers;
   do not invent permissive schemas. Wire regeneration/freshness checks into
   the existing build/CI workflow without discarding its scripts.
3. Implement server-only `resolvePrincipal(request)` returning verified
   `subjectId`, `tenantId`, roles and attributes from the actual session.
   Reject unauthenticated requests. Never trust client identity/role fields or
   substitute one global tenant. Runtime identity must match the verified
   tenant; do not disable tenant checks to accommodate a default local ID.
4. In Standalone, use `createLocalRuntimeSource` from `glirastes/runtime` and
   the shared signed snapshot pipeline. Restart after local setup updates.
   Managed instead requires the verified Managed revision source and matching
   local executors; setup upload/Doctor alone do not activate a revision.
5. Use `createAiChatHandler` from `glirastes/server/nextjs` with local model
   bindings, executors and `managedRuntime`'s `resolvePrincipal` and
   `resolveTurnSnapshot`. That option names the shared turn guard, not a
   requirement to buy or connect the Platform. Preserve a turn's snapshot
   across approval continuations and resolve current rights before tools.
6. Mount one `VercelAiChat endpoint="/api/chat"` (use the actual chat route)
   from `glirastes/react/vercel`, import
   `glirastes/react/styles.css`, and follow `building-glirastes-chat-ui`.
   Bind navigation/filter actions where the app state lives. Keep one STT
   controller and stream; reuse sessions and existing app UI capabilities.
7. Run local setup/Doctor and the actual chat/action test. The app needs its
   own authorized runtime model binding; coding-agent login is not an app
   API key. Only connect/sync when selected, following the canonical workflow.

## Required verification

- An unauthenticated, cross-tenant, or tampered principal cannot execute tools.
- The normal chat path makes no Control Plane request.
- A real prompt performs one successful tool action.
- Add/change/delete an endpoint, navigation and filter through the source
  generator; removed capabilities cannot execute. No manual catalogue edits.
- Measure a fresh integration to its first action against the under-five-minute
  goal; disclose prerequisites, downloads and user/provider waits.
- Build, contract, browser, privacy, and rollback tests pass.

## Stop conditions

Fail closed if no principal resolver, signed revision, matching local
fingerprint, or locally authorized tool exists. If the scanner cannot infer a
safe executable schema, leave the tool disabled, inspect its real code and ask
only unresolved product questions. Platform review is optional, not a repair
for missing local code. Keep business content, prompts and secrets local; a
passing Doctor does not prove a live action or complete integration.
