# SDK Follow-up Suggestions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move model-emitted trailing follow-up lists into the SDK-owned rotating suggestion pill without rendering them inside assistant messages.

**Architecture:** Add one pure SDK parser shared by the provider and message renderer. Structured `suggest_followups` output remains authoritative; the text parser is a strict, local fallback and Get It Done remains configuration-only.

**Tech Stack:** TypeScript, React, Vitest, Testing Library, Vercel AI SDK message parts.

---

### Task 1: Pure fallback parser

**Files:**
- Create: `src/react/utils/followup-suggestions.ts`
- Test: `src/react/utils/__tests__/followup-suggestions.test.ts`

**Step 1: Write failing tests**

Cover German and English trailing headings, Markdown bullets and numbered
items, bounds and deduplication, plus prose, empty, and embedded-section false
positives.

**Step 2: Verify RED**

Run: `bunx vitest run src/react/utils/__tests__/followup-suggestions.test.ts`

Expected: failure because the parser module does not exist.

**Step 3: Implement the minimum parser**

Return `{ text, suggestions }`. Recognize only a trailing `Vorschläge:` or
`Suggestions:` heading followed exclusively by one to five non-empty Markdown
list items. Preserve the original text byte-for-byte when the contract does
not match.

**Step 4: Verify GREEN**

Run the focused parser test and `bunx tsc --noEmit`.

### Task 2: SDK rendering and provider state

**Files:**
- Modify: `src/react/components/message-bubble.tsx`
- Modify: `src/react/provider/ai-chat-provider.tsx`
- Test: `src/react/components/__tests__/message-bubble.test.tsx`
- Test: `src/react/provider/__tests__/ai-chat-provider.test.tsx`

**Step 1: Write failing integration tests**

Prove that a recognized trailing list is absent from the bubble and becomes
dynamic suggestion state. Prove completed structured tool output takes
precedence and ordinary prose is untouched.

**Step 2: Verify RED**

Run the two focused test files and confirm the new expectations fail on the
current implementation.

**Step 3: Implement shared normalization**

Use the pure parser in `MessageBubble`. Extend the provider's newest-assistant
suggestion extraction to use text fallback only when that message has no
completed structured follow-up output. Bound results by the configured count.

**Step 4: Verify GREEN**

Run the focused tests, the existing `SuggestionBar` component tests, and
`bunx tsc --noEmit`.

### Task 3: Consumer regression and complete verification

**Files:**
- Test: `src/__tests__/components/chat-wrapper-stt.test.tsx` in Get It Done
- Modify: canonical Platform working document after evidence is current

**Step 1: Protect the thin consumer boundary**

Assert Get It Done continues to pass SDK suggestion configuration without a
consumer parser or a second suggestion renderer.

**Step 2: Run complete gates**

Run SDK tests, typecheck, and build. Rebuild the linked SDK, then run Get It
Done tests, typecheck, and production build. Audit diffs, whitespace, and
secret-shaped additions.

**Step 3: Perform authenticated visual verification**

Start the existing local processes, exercise a navigation turn, and verify the
answer remains compact while contextual suggestions rotate in the single pill
above the input. Record latency evidence without changing governance or tool
scope.

**Step 4: Commit logical units**

Commit documentation, Waveform restoration, SDK suggestion fallback, thin
consumer wiring/tests, and canonical evidence separately. Do not push, merge,
release, or deploy.
