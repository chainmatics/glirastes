# Shared chat layout implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Carry the approved FR-4 sidebar/floating/mobile behavior into the common SDK and then reconcile Get It Done without replacing its shared session or recording owners.

**Architecture:** Extend the existing ChatWindow, keeping one React subtree and a stable portal choice across mode changes. Floating geometry and sidebar width are independent. An inline host reserves app layout space; the existing body portal remains supported as an overlay. Only presentation is changed: session, authorization, transport and STT ownership stay untouched.

**Tech Stack:** React, TypeScript, existing SDK CSS, Vitest/Testing Library and real-browser reference fixtures.

## Decisions within the approved MVP

- Reuse ChatWindow rather than copy the upstream Agentic assistant shell or mount two separate chat instances.
- Opt-in layout controls preserve existing floating-window consumers. Labels are customizable for app localization.
- Retain body/header children when collapsing; hide and make them inert. Closing continues to obey keepMounted. Consumers must close any separately portaled menus and stop media through their existing ownership boundary.
- Sidebar uses its own bounded width. Pointer, keyboard and double-click resize support must release selection locks on pointer cancellation, blur, collapse, mode change and unmount.
- Keep portal placement stable: use portal=false in an app flex row for an in-flow sidebar and a fixed floating panel. With the default portal=true the sidebar is an overlay, not an automatic app-layout mutation.
- Do not claim full GID/mobile parity from SDK component tests alone.

## Task 1 — SDK mode and collapse state

Files: src/react/types.ts, src/react/components/chat-window.tsx, src/react/components/__tests__/chat-window.test.tsx, src/react/styles.css.

1. Write real-component tests for mode switches retaining the exact draft node, in-flow sidebar geometry, independent floating dimensions, collapsed hidden/inert contents and controlled callbacks.
2. Run `bun run test src/react/components/__tests__/chat-window.test.tsx`; confirm assertions fail on missing controls/geometry.
3. Add controlled/uncontrolled mode and collapse state, optional common controls, stable body/header nodes and separate sidebar geometry.
4. Rerun the tests and existing drag/resize hook tests.

## Task 2 — Sidebar resize accessibility/lifecycle

Files: src/react/hooks/use-sidebar-resize.ts and the ChatWindow component/tests above.

1. Add failing tests for bounded keyboard resizing, pointer resizing, cancellation and mode-change cleanup without altering floating geometry.
2. Implement the single sidebar gesture owner; native separator semantics, arrow keys/Home/End, double-click reset, pointer ID filtering and document/window cleanup.
3. Test unavailable storage and optional namespaced persistence without touching chat content. Run the complete SDK suite, typecheck and ESM/CJS build.
4. Independent review, diff/secret audit and narrowly scoped local commit via git-commit skill.

## Task 3 — Get It Done and browser parity (required follow-through)

Files in the GID pilot: src/components/layout/app-shell.tsx, src/components/ai/chat-wrapper.tsx, src/__tests__/components/chat-sessions.test.tsx. SDK source-driven browser fixture/test files as needed.

1. Confirm upstream assistant shell defaults/persistence and app layout from code. Retain user/tenant isolation and the new shared session/STT behavior.
2. Add failing tests using the actual SDK for docking, collapse/reopen, close, scope change, draft retention and keyboard commands.
3. Place the one retained wrapper in the app layout; expose shared controls with localized labels. Preserve the floating trigger and avoid duplicate shortcut owners.
4. Verify desktop/sidebar/mobile geometry and keyboard focus in a real browser against a secret-free local fixture; exercise resizing/cancellation and unchanged draft/session identity.
5. Run GID full tests, typecheck and sanitized source-only production build. Do not start GID with its production-shared database configuration.

## Acceptance and remaining scope

This plan is one FR-4 checkpoint, not the full MVP. Pointer/touch/mobile QA, GID integration, live microphone lifecycle, all three stack matrices, fresh-agent setup, platform UX, performance and landing-page gates remain necessary where not independently proven. Update this file and the canonical pilot working document with actual evidence; do not convert planned checks into completion claims.

## Common component API

Inside the existing AiChatProvider, place the one ChatWindow alongside the app
content in a bounded-height flex row:

```tsx
<div style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
  <main style={{ flex: 1, minWidth: 0 }}>{app}</main>
  <ChatWindow portal={false} layoutControls defaultMode="sidebar" keepMounted>
    <AiChatPanel />
  </ChatWindow>
</div>
```

mode/onModeChange and collapsed/onCollapsedChange support external ownership;
otherwise the component owns those two presentation states. sidebarWidth
accepts a starting width and subsequent prop updates; onSidebarWidthChange can
persist changes in parent state. minSidebarWidth/maxSidebarWidth bound keyboard
and pointer changes. persistDimensions adds a separate `-sidebar-width` entry
under its existing storage namespace. layoutLabels customizes the five layout
action labels. A custom renderHeader receives layoutControls to insert beside
its existing actions; custom menus/media still require their normal lifecycle
owner. Mode changes must not change portal or the component key.

The VercelAiChat/FloatingChatUI convenience components do not yet forward these
new layout options. Exposing the common layout through that simple entry and
the actual GID shell is required follow-through, not a second chat runtime.

## Verified checkpoint — 2026-09-13

Tasks 1–2 implemented in the SDK. ChatWindow has controlled/uncontrolled layout
and collapse state, optional localized controls, retained/inert collapsed
content, separate bounded sidebar geometry, keyboard/pointer resizing and
namespaced browser persistence. Mode switches keep the DOM subtree and floating
geometry. The sidebar cannot reset floating position through header double-click.
Parent-persisted width updates do not prematurely release an active pointer.

- 18 added real-component tests (15 observed RED-to-GREEN reproductions and
  three already-correct boundary guards), 21 ChatWindow tests total. Existing
  10 floating drag/resize hook tests remain green. Independent final review
  reran all 31 and found no remaining important finding in Tasks 1–2.
- Full SDK suite: **1,066 tests / 128 files**, typecheck, ESM/CJS build and 16
  subpath shims. Whitespace and changed/new-file secret-pattern audits passed.
- Real Chrome browser: development and production reference checks pass.
  Production final run also exercises repeated real pointer movement with
  parent-state width updates. Desktop sidebar reserves app space; switching to
  floating restores its width; collapse produces a 44px rail; at 390×844 the
  expanded chat fills the viewport. Collapse/expand keyboard focus and draft
  retention through close/reopen pass. The same script retains the actual
  scoped HTTP/SSE tool action, native navigation and filtering checks.
- Screenshots inspected: `/tmp/glirastes-shared-layout-desktop.png` and
  `/tmp/glirastes-shared-layout-mobile.png`. These show a deliberately minimal
  layout test fixture, not the final GID UI or an end-user usability test.
- GID compatibility with the rebuilt SDK: **989 tests / 60 files**, typecheck
  and isolated Next 16.1.6 Webpack production build, 47 static pages. Used the
  existing source-only `/tmp/gid-session-build.8oFNJ5` without environment files
  and with an unreachable dummy database address. Existing middleware/proxy
  deprecation warning remains.

No GID server, live microphone, external model or production database was used.
The secret-free browser reference server and child processes were stopped by
the bounded test cleanup. No push, publication, merge, deployment or activation.
Pre-existing worktree data and the two older trace caches were preserved.

Next: Task 3, plus expose options through the simple Vercel/FloatingChatUI entry.
Actual GID sidebar defaults/width persistence, collapsed session-menu/media
lifecycle, small available app width, keyboard/focus/mobile parity and route
recording cleanup still require integration evidence. The full current-upstream
reconciliation and remaining MVP gates are unchanged and incomplete.
