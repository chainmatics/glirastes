# Get It Done upstream reconciliation: shared sessions

This is one implementation checkpoint within the complete MVP requirements,
not a replacement for the three-stack, fresh-setup or current-upstream gates.

## Source baseline and sequence

- GID pilot starts at `453e17f`, upstream `origin/master` at `a07b784`.
  Their merge base is `4b5d569`; upstream changes 723 files. A read-only
  merge-tree inspection identified both app evolution and Foundation conflicts.
- Preserve native task/team/UI/MCP features from upstream. Do not restore the
  removed Agentic catalogues or merge the main branch wholesale. No database
  migration, worker, deployment, publication or remote write is authorized.
- First reconcile multi-session functionality using the existing SDK provider
  and SessionSwitcher, retaining the pilot's single STT controller and movable,
  resizable, snapping chat window. Then carry forward the upstream sidebar/
  floating shell, native task/team changes, MCP integration and code-derived
  bindings with dedicated parity checks. Those subsequent steps remain open.

## This checkpoint

1. Reproduce SDK session restore ownership failures, then prevent old messages
   from being saved under a newly selected id. Cancel stale loads. Preserve
   explicit and discovered `default` sessions; let empty lists create a chat.
2. Keep send readiness separate from session-change availability. Block session
   transitions during streaming, including late asynchronous CRUD callbacks.
   Block sends during CRUD. Failed restores must allow safe retry/switching.
3. Connect GID to the shared SDK SessionSwitcher with a user/tenant-scoped local
   adapter compatible with upstream `gid:chats:v1:<tenant>:<user>` data. Support
   rename/create/remove/clear and active-id persistence. Guard late saves after
   deletion. Browser storage failure keeps a local memory overlay; a quota error
   must not hide other readable stored histories.
4. Do not automatically attribute unscoped `ai-chat-history` to a user. Preserve
   that storage and its compatibility adapter; no destructive migration occurs.
5. Keep composer drafts scoped to a chat while the wrapper is mounted, including
   structured mention ids. Extend the existing mention-input setter with an
   optional ordered mention list, preserving old plain-text calls. No raw HTML
   restoration. Lock session controls, including pending delete dialogs, during
   the shared recording lifecycle.
6. Test the actual GID wrapper, SDK provider, switcher, mention editor and delete
   confirmation together. Stub only transport/network and translation boundaries;
   preserve the existing ten STT/approval/drag/resize/mention behavior tests.
   Deduplicate React in the linked-package test graph rather than mock the SDK.

## Verification boundary

The new targeted tests have been observed RED before repairs. Final full suites,
typechecks, builds, diff audit and independent review are recorded below when
completed. A source-only build copy excludes environment files, injects only a
non-serving loopback database address, and bypasses prebuild artifact generation.
It does not exercise a customer database or prove authenticated live chat.

Open after this checkpoint: persistent shell behavior across close/routes,
full latest-upstream app reconciliation, real authenticated browser/microphone
parity, current-source generation in GID and the other two stacks, fresh-agent
installation timing, performance/token/bundle comparisons, simplified Platform,
novice usability, telemetry and the landingpage. Preserve the complete Goal.

## Verified checkpoint — 2026-09-13

Implemented the SDK ownership/readiness repairs, generic ordered mention-draft
restoration and GID scoped multi-session integration. The old single-history
adapter remains present. Actual GID component tests exercise the SDK switcher,
delete confirmation, draft return and structured task mention serialization;
only the transport/provider-call boundary is fake. No new app-specific chat or
second STT controller was introduced.

- SDK: **1,031 tests / 127 files**, typecheck and ESM/CJS build pass.
- GID: **977 tests / 60 files**, typecheck pass; isolated Next 16.1.6 Webpack
  production build passes with 47 static pages. Source-copy build uses only
  the existing `tool-semantics.json` and `local-tool-bindings.json` artifacts;
  no `.env`, scoped Platform connection or real database access is required.
- Independent final review found no remaining blocking issue in this increment
  and independently ran the 12 new SDK tests and 21 targeted GID tests.
- Diff whitespace and changed/new-source secret-pattern audits pass. Existing
  GID `.glirastes/platform-tool-bindings.json`, untracked connection metadata,
  mixed Platform docs and SDK trace caches remain outside the change set.

An initial simultaneous full-suite run exceeded existing five-second limits in
three subprocess-heavy tests (GID two, SDK one). Separate full reruns pass with
the original limits; no timeout or assertion was weakened. The first isolated
build failed because the two imported local artifacts had not been copied;
including those exact existing build inputs resolved it. Next reports its
pre-existing middleware-to-proxy deprecation warning.

No production runtime, auth flow, live microphone/provider, customer database,
push, merge, release or deployment was exercised. Browser/microphone and full
latest-upstream parity remain separate gates. The wrapper still unmounts when
closed, so unsent draft preservation across close/routes is not yet proven.
