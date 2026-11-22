# P6 Message Footer and Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** the owner asked for this package without another decision round.
> Every design choice below was made by the rule "zero-config unchanged →
> smallest public surface → omnify where omnify is sound" and is recorded in
> **Decisions** (end of file) so the owner can override it later. Anything
> breaking is not planned; it is listed under **Needs owner**. A task whose
> decision is overridden must be re-planned before it starts.

> **Base:** written on `feat/p6-footer` from `origin/main` (0.22.0). P2b
> (`feat/p2b-composer`, `docs/plans/2026-11-21-p2b-composer.md`) and P3
> (`feat/p3-layout`, `docs/plans/2026-11-22-p3-layout.md`) merge first; rebase
> this branch onto `main` after both merged and before Task 1 starts. Conflict
> hotspots are listed under Global Constraints.

**Goal:** Give every assistant answer an opt-in footer — copy (rich HTML + plain text), the sources it cites, the turn's working time, and while it runs the elapsed time with a stop button — show the model's follow-up questions under the latest answer instead of the rotating composer chip when the app asks for it, and let the app hide UI-only tools from the activity log.

**Architecture:** The footer is one more rendered part of a message: `useMessagePartsWithLogs` (`src/react/components/message-bubble.tsx`) builds a `footer` node (internal `MessageFooter` component) that the default bubble renders last and that `MessagePartNodes.footer` hands to `components.MessageParts` and `useMessageParts` callers — no new component export, no new slot. The turn's working time is measured where turns are already recorded (`recordTurnOutcome` in `ai-chat-provider.tsx`) and stored on the existing `TurnOutcome` (`durationMs`), so it survives a reload with the session store. Sources and follow-ups are read per message by two small pure readers; the copy content is built from the bubble's rendered Markdown by an internal allowlist exporter ported from omnify. Everything stays in the browser.

**Tech Stack:** TypeScript strict ESM (NodeNext), React 18/19, vitest + Testing Library (jsdom), Bun.

**Spec:** Package list of this work stream (session 68e83dcc, P6: "Nachrichten-Footer und Aktivitätslog — Kopieren, Quellen, Folgefragen, Dauer, Stopp"), the omnify analysis (§2 "Message rendering": footer with copy/sources/follow-ups and the follow-up hiding rule; §3 "Trace and activity": elapsed time, stop, silent tools), P2b D4/D8 (follow-up placement and the `staticChips` question deferred to P6). Owner rule (2026-11-22): decide non-breaking choices, record them, ask only for breaking ones. Reference implementation (read only, never modify, no migration): omnify `apps/web/app/components/ai/`.

### What omnify does (reference, read only) and what the SDK has

| Feature | omnify (file:line) | SDK on main (0.22.0) |
|---|---|---|
| Footer once the answer is done | `chat-message-bubble.tsx:66,113-209` (`done` = assistant, text, not streaming) | none |
| Copy | `chat-message-bubble.tsx:78-87,116-135` (label switches Kopieren/Kopiert/Kopieren fehlgeschlagen, 2 s reset, `aria-live`); `response-clipboard.ts:1-192` (allowlisted tags with inline styles from `[data-component="markdown"]`, plain text with bullets/tabs, `ClipboardItem` then `writeText`) | none |
| Sources | `response-presentation.ts:30-80` (Markdown links + reference definitions via mdast, `citations`/`sources` of tool outputs, https only, ≤ 20, label ≤ 160); toggle + list `chat-message-bubble.tsx:136-190` | none |
| Follow-ups under the answer | `chat-message-bubble.tsx:67-76,191-207` (heading WEITERFRAGEN, ≤ 3, click sends; hidden while loading, approvals pending, clarification open, after error/abort/safety-stop); bar hidden by CSS `ai-chat-widget.tsx:185`; app fallback prompts `response-presentation.ts:82-106` (domain-specific, stays in the app) | model follow-ups via `suggest_followups` and the trailing-list fallback (`ai-chat-provider.tsx:1781-1839`), shown one at a time in `SuggestionBar` above the composer (`ai-chat-panel.tsx:213`); `staticChips` as start/fallback (`:983-985`, `:1841-1855`) |
| Elapsed time, duration, stop | `agent-trace.tsx:32-99` (timer from `isLoading`, "Verarbeitet in X s", Stoppen button), `loading-state.tsx:28-33` (`formatElapsed` "3,2 s", "1 min 5,0 s") | stop only in the composer (`locale.stopButton`); no elapsed time, no duration |
| Silent tools in the log | `agent-trace-labels.ts:36-43` (`find_tools`, `ui_action_refresh`, `ui_action_toast`) | fixed built-in list `utils/activity.ts:69-76` |
| Activity log | own `AgentTrace` replacing `PipelineTimeline` | `ActivityLog` with details, sections, failure codes, notices, outcomes (#111, #142); nothing else from omnify's trace is missing that is generic (D11) |

## Global Constraints

- Additions only against the released 0.22.0 API; no removed or renamed export. One new export name: the type `MessageFooterConfig`. Every new public key is listed in an upgrade note `surface` (`src/upgrade-notes.test.ts` checks against `upgrade-notes/api-surface.released.json`; do not run `bun run api-surface` — release step). A new provider key also appears as `glirastes/react#AiChatProviderProps.<key>`, `glirastes/react/vercel#VercelAiChatProps.<key>` and `glirastes/embed#GlirastesChatElementConfig.<key>`; a `MessagePartNodes` member also as `MessageParts.<m>` and `MessagePartsProps.<m>`. Run the upgrade-notes test and list exactly what it reports missing.
- Without new config the rendered DOM is byte-identical to main after P2b and P3. Existing tests stay green unchanged: `src/react/components/__tests__/message-bubble.test.tsx`, `message-layout-hooks.test.tsx`, `message-part-renderers.test.tsx`, `activity-log*.test.tsx`, `ai-chat-panel.test.tsx`, `src/react/__tests__/turn-outcome*.test.tsx`, `stopped-turn-history.test.tsx`, `unstyled.test.tsx`. Sole default change: a recorded `TurnOutcome` carries `durationMs` (also in `onTurnEnd` and in the stored `metadata.glirastesTurnOutcome`).
- One upgrade note per change: `upgrade-notes/unreleased/<id>.json`, schema `src/cli/commands/upgrade/notes.ts` (`id` `^[a-z0-9][a-z0-9-]{2,79}$`, `kind`, `summary` ≤ 300 chars, `howTo` ≤ 2000, `skill: "building-glirastes-chat-ui"`, `affectedWhen.imports: ["glirastes/react"]`, `surface`). Plus one line under `## [Unreleased]` in `CHANGELOG.md`.
- Skill: `skills/building-glirastes-chat-ui/SKILL.md` is at the 400-line limit after P2b and P3. **Net SKILL.md change for this plan: 0 lines.** Detail goes into `references/hooks-and-building-blocks.md` (section "Message layout", new subsection "Message footer") and `references/non-react-hosts.md` ("Layout without React slots"). Every new public member is named in a skill file (`tests/skill-coverage.test.ts`).
- i18n: every new visible text is an optional `ChatLocale` key with an English default in `DEFAULT_LOCALE` (`src/react/provider/ai-chat-provider.tsx`) and German in `deChatLocale` (`src/react/locale-de.ts`); `src/react/__tests__/locale-de.test.ts` stays green. Keys and texts are fixed in the tasks. Stop reuses `stopButton` (D16).
- Accessibility: native `<button type="button">` with an accessible name; the sources toggle has `aria-expanded` + `aria-controls`; follow-ups are a `role="group"` labelled by their heading; the copy result is announced (`aria-live="polite"`); the ticking timer is `aria-hidden`; no motion (D13); disabled follow-ups while `canCompose` is false.
- Nothing new leaves the browser: duration, sources and copy content are computed client-side; `durationMs` goes only into the app's own session store (with the outcome) and `onTurnEnd`; the provider already strips the outcome key before the transport. No Platform call, no new server route, no new request field.
- Console output only fixed text, never URLs, message text or ids (`src/react/__tests__/sensitive-diagnostics.test.ts`).
- `src/react/styles.css` changes are followed by `node scripts/generate-embed-styles.mjs` (writes `src/embed/chat-styles.generated.ts`; `bun run build` checks it). Every new selector uses the `:where(:not([data-unstyled], [data-unstyled] *))` guard.
- Rebase hotspots with P2b/P3: `src/react/types.ts` (`ChatLocale` — add P6 keys in a new "Message footer" block after the activity keys; `AiChatProviderConfig` — `messageFooter` right after `activityLog`; `SuggestionsConfig`, `ActivityLogConfig`, `MessagePartNodes`, `TurnOutcome` — append members), `DEFAULT_LOCALE` / `deChatLocale` (same block), `src/react/components/ai-chat-panel.tsx` (P2b Task 5 rewrites the `SuggestionBar` line; P6 Task 5 adds one condition to it), `src/react/components/message-bubble.tsx` (P2b Task 6 touches the clarification card ~:541; P6 touches the `nodes` object and `MessageBubble`'s `ordered`), `src/react/provider/ai-chat-provider.tsx` (P2b Tasks 7/8 add the draft controller; P6 touches the outcome block ~:905-977/2420-2470 and the follow-up effect ~:1781-1839), `src/react/provider/composer-context.ts` (P2b adds `drafts`; P6 appends two members), `src/react/index.ts`, `src/react/styles.css` (append a new "Message footer" section after the activity-log rules), `src/embed/chat-styles.generated.ts` (regenerate, never hand-merge), `CHANGELOG.md`.
- jsdom has no `navigator.clipboard` and no `ClipboardItem`: tests stub them (`Object.defineProperty(navigator, 'clipboard', …)`, `globalThis.ClipboardItem = class { constructor(public items: Record<string, Blob>) {} }`) and restore in `afterEach`. Timers: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })` + `vi.setSystemTime`.
- Commits: conventional (`feat(react): …`, `fix(react): …`, `docs(skills): …`), explicit paths, no AI attribution, no push.
- Gate per task: `bun run typecheck`, the task's test files via `bunx vitest run <files>`, `bunx vitest run src/upgrade-notes.test.ts src/react/__tests__/sensitive-diagnostics.test.ts src/react/__tests__/locale-de.test.ts`. Task 7: `bun run build`, `bun run typecheck:tests`, `bun run test` (known load flakes that pass alone: `src/codegen/tools/schema-probe.test.ts`, `src/cli/commands/upgrade/detect.test.ts`).

## Review Focus

1. **A turn that waits for an approval.** The duration counts only the request runs of the turn (first run + the run after the decision), not the minutes the user spent deciding; it is recorded once, when the turn really ends; a retry of the same question measures afresh (Task 1 `approval wait is not counted`, `a retry measures afresh`).
2. **Follow-ups under the wrong answer.** A new question running, an open approval, an open clarification, a stopped/failed/safety-stopped turn, an older answer, a locked composer: no clickable follow-up may send a stale question (Task 5 `hidden while …` cases).
3. **Hostile or odd links in an answer.** `javascript:`, `data:`, `http:`, `https://user:pw@…`, relative links, links inside code, duplicates and more than 20 links: only the safe ones appear, at most 20, never a non-https href in the DOM (Task 2 `readMessageSources` cases).
4. **Clipboard unavailable or refused** (non-secure origin, permission denied, Firefox without `ClipboardItem`, an embed in an iframe): rich copy falls back to text, a total failure shows "Copy failed", nothing throws, no content reaches the console (Task 3 + Task 4 `copy failure`).
5. **Zero-config and custom layouts.** No `messageFooter` and default `suggestions`: DOM unchanged; a `components.MessageParts` that renders `children` gets the footer, one that arranges nodes itself gets `footer` and shows nothing until it places it; `unstyled` gets the markup without styles (Task 4 `zero config`, `MessageParts receives footer`).

---

### Task 1: Working time of a turn (`TurnOutcome.durationMs`)

**Files:**
- Modify: `src/react/types.ts` (`TurnOutcome` ~:719)
- Modify: `src/react/utils/turn-outcomes.ts` (`readOutcome` :32)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`recordTurnOutcome` ~:953, run-end effect ~:2424, run-start effect ~:2445, context value ~:2843/~:2944)
- Modify: `src/react/provider/composer-context.ts` (`ComposerContextValue`)
- Test: `src/react/__tests__/turn-duration.test.tsx` (new; uses `StreamingChat`, `Host`, `ctx`, `memoryStorage` from `./streaming-chat.js`)
- Create: `upgrade-notes/unreleased/turn-outcome-duration.json`

**Interfaces:**
- Produces (public):
```ts
export interface TurnOutcome {
  // …existing members
  /**
   * Working time of the turn in ms: the time its requests ran (a run after an
   * approval adds to the first; waiting for the user does not count),
   * measured in the browser. Absent on outcomes stored by an older version.
   */
  durationMs?: number;
}
```
- Produces (internal, `ComposerContextValue`): `turnRunStartedAt?: number | null` — while a request runs: `Date.now()` at its start minus the time the same turn already worked (so `Date.now() - turnRunStartedAt` is the turn's working time so far); `null` when nothing runs.
- Rules:
  - Bookkeeping per bound turn (`requestTurnRef`): `{ userMessageId, workedMs, runStartedAt | null }` in a ref. Run start (the existing `outcomeRunLoadingRef` effect): same `userMessageId` and no outcome recorded for it → continue (`workedMs` kept); otherwise (other turn, or a retry whose outcome the effect deletes) → `workedMs = 0`. Run end (the existing `outcomeRunEndRef` effect): `workedMs += Date.now() - runStartedAt`.
  - `recordTurnOutcome` writes `durationMs = Math.round(workedMs + (runStartedAt === null ? 0 : Date.now() - runStartedAt))` (a stop records during the run). An outcome for a request the bookkeeping does not know (none seen running) gets no `durationMs`.
  - `readOutcome` keeps `durationMs` when it is a finite number ≥ 0; anything else is dropped (the outcome itself stays valid). `withStoredTurnOutcomes` needs no change (it copies every field but `userMessageId`).

- [ ] **Step 1: Write the failing tests** (`turn-duration.test.tsx`, fake timers with `Date`):
  - `'a completed turn records its working time'` — send, `vi.advanceTimersByTime(3200)` while streaming, `finish()` → `ctx.turnOutcomes.get(userId)` is `{ status: 'completed', durationMs: 3200, … }`.
  - `'a stopped turn records the time until the stop'` — 1500 ms, `ctx.stop()` → `{ status: 'aborted', reason: 'stopped', durationMs: 1500 }`.
  - `'approval wait is not counted'` — run 1: 1000 ms, ends with a part in `approval-requested`; wait 60 000 ms; approve → run 2: 500 ms, finish → `durationMs: 1500`.
  - `'a retry measures afresh'` — turn completed with 2000; `chat.retry()` 700 ms, finish → `durationMs: 700`.
  - `'the duration survives a reload with the session store'` — `createLocalSessionStore` over `memoryStorage()`, finish a turn with 800 ms, remount → the restored outcome has `durationMs: 800`; stored JSON contains `"durationMs":800` under `glirastesTurnOutcome`; the transport's `requests` never contain `durationMs` or `glirastesTurnOutcome`.
  - `'a stored outcome with a bad durationMs keeps its status'` — stored `{ status: 'completed', reason: 'finished', at: '…', durationMs: 'x' }` → outcome restored without `durationMs`.
  - `'onTurnEnd receives the duration'`.
  - `'turnRunStartedAt follows the running turn'` — `composerContextOf(ctx).turnRunStartedAt` is `Date.now() - 0` at the start, `null` after finish; after an approval continuation it equals start-of-run-2 minus 1000.
- [ ] **Step 2: Run** `bunx vitest run src/react/__tests__/turn-duration.test.tsx` — Expected: FAIL (`durationMs` undefined).
- [ ] **Step 3: Implement** the bookkeeping ref and the three hooks above; put `turnRunStartedAt` (state, set on run start/end only — no ticking state in the provider) into the context value.
- [ ] **Step 4: Run** the new file plus `src/react/__tests__/turn-outcomes.test.tsx`, `turn-outcome-transport-history.test.tsx`, `turn-end-callback.test.tsx`, `stopped-turn-history.test.tsx` — Expected: PASS. Existing `toEqual` assertions on whole outcomes that now fail because of the extra member: change them to `toMatchObject` only if the test asserts something else than the outcome's exact shape; list each such edit in the commit body.
- [ ] **Step 5: Upgrade note** `turn-outcome-duration`, `kind: "optional"`, summary: "A recorded TurnOutcome now carries durationMs, the time the turn's requests ran (approval waits excluded), measured in the browser and stored with the outcome in the session store.", howTo: "Read outcome.durationMs in onTurnEnd or useTurnOutcome for your own timing display or local analytics; messageFooter shows it as 'Done in 3.2 s'. Tests that compare whole outcomes with toEqual need the new member.", `surface`: `glirastes/react#TurnOutcome.durationMs`. CHANGELOG `### Added`.
- [ ] **Step 6: Commit**
```bash
git add src/react/types.ts src/react/utils/turn-outcomes.ts src/react/provider/ai-chat-provider.tsx src/react/provider/composer-context.ts src/react/__tests__/turn-duration.test.tsx upgrade-notes/unreleased/turn-outcome-duration.json CHANGELOG.md
git commit -m "feat(react): record the working time of a turn on its outcome"
```

---

### Task 2: Per-message readers for sources and follow-ups

**Files:**
- Create: `src/react/utils/message-sources.ts`
- Modify: `src/react/utils/followup-suggestions.ts` (add `readMessageFollowups`)
- Modify: `src/react/provider/ai-chat-provider.tsx` (follow-up effect ~:1781-1839 uses `readMessageFollowups`; behavior unchanged)
- Test: `src/react/utils/__tests__/message-sources.test.ts` (new), `src/react/utils/__tests__/followup-suggestions.test.ts` (new or extend the existing one if present)

**Interfaces:**
- Produces (internal):
```ts
export interface MessageSource { href: string; label: string; domain: string }
/** Safe external links an assistant message cites, in first-seen order, deduplicated by href, at most 20. */
export function readMessageSources(parts: ReadonlyArray<unknown>): MessageSource[];
/** The follow-ups of one assistant message: the last `suggest_followups` output with strings, else the trailing list of its last text part that has one; at most `count`. */
export function readMessageFollowups(message: { role: string; parts: ReadonlyArray<unknown> }, count: number): string[];
```
- Source rules (D5): candidates in this order — Markdown inline links `[label](url "title")` and reference links resolved through `[id]: url` definitions in the message's text parts (fenced code blocks and inline code removed first, no Markdown dependency); AI SDK `source-url` parts (`{ type: 'source-url', url, title? }`); `sources` / `citations` arrays of tool outputs (`part.output ?? part.result`, or its `data`), entries as string or `{ url | href, title? }`. Accepted: `new URL()` parses, protocol `https:`, no username/password. `domain` = hostname without `www.`; `label` = trimmed link text / title, max 160 chars, else the domain. Stop after 20.

- [ ] **Step 1: Write the failing tests:**
  - `message-sources.test.ts`: `'inline and reference links in order'` (`See [Docs](https://example.com/a) and [b][1].\n\n[1]: https://www.example.org/b` → `[{ href: 'https://example.com/a', label: 'Docs', domain: 'example.com' }, { href: 'https://www.example.org/b', label: 'b', domain: 'example.org' }]`); `'unsafe links are dropped'` (`javascript:alert(1)`, `data:text/html,x`, `http://example.com`, `https://u:p@example.com`, `/relative`, `mailto:a@b.c` → `[]`); `'links in code are ignored'` (fenced block and `` `[x](https://e.com)` ``); `'duplicates collapse and at most 20'` (25 distinct + 1 duplicate → 20, first-seen order); `'source-url parts'`; `'tool output sources and citations'` (`{ output: { data: { citations: ['https://a.com/x', { href: 'https://b.com', title: 'B' }] } } }`); `'label is capped at 160 characters'`; `'user text is not read'` is not this function's job — the caller passes assistant parts only (no test).
  - `followup-suggestions.test.ts`: `'structured follow-ups win over a trailing list'`; `'the trailing list is the fallback'`; `'count limits'`; `'a user message has none'`; `'blank entries are dropped'`.
- [ ] **Step 2: Run** both files — Expected: FAIL (functions missing).
- [ ] **Step 3: Implement** both functions; replace the inner loop of the provider effect with `readMessageFollowups(message, count)` (first assistant message from the end with a non-empty result wins, `setSuggestionChips` only then — same as today).
- [ ] **Step 4: Run** both files plus `src/react/__tests__/ui-actions.test.tsx` and every test file matching `suggest` (`bunx vitest run -t suggest src/react`) — Expected: PASS.
- [ ] **Step 5: Commit** (internal, no note)
```bash
git add src/react/utils/message-sources.ts src/react/utils/followup-suggestions.ts src/react/provider/ai-chat-provider.tsx src/react/utils/__tests__/message-sources.test.ts src/react/utils/__tests__/followup-suggestions.test.ts
git commit -m "refactor(react): read sources and follow-ups per message"
```

---

### Task 3: Copy content of a rendered answer (internal)

**Files:**
- Create: `src/react/utils/copy-message.ts`
- Test: `src/react/utils/__tests__/copy-message.test.ts` (new, `// @vitest-environment jsdom`)

**Interfaces:**
- Produces (internal):
```ts
/** Rich HTML (allowlisted tags, inline styles) and plain text of the rendered Markdown blocks inside `root`; `fallback` when none renders text. */
export function messageClipboardContent(root: Element | null, fallback: string): { html: string; text: string };
/** Writes both flavors (`ClipboardItem`), else plain text (`writeText`). Rejects when neither works. */
export function copyMessageToClipboard(root: Element | null, fallback: string): Promise<void>;
```
- Port of omnify `response-clipboard.ts:1-192` with these values: allowlist `P DIV SPAN H1-H6 STRONG B EM I U S DEL UL OL LI BLOCKQUOTE PRE CODE BR HR TABLE THEAD TBODY TR TH TD A`; inline styles as omnify `:34-50`; root `<div style="font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;">`; `A` keeps `href` only for `https: http: mailto: tel:`; `OL start`, `TD/TH colspan/rowspan` digits only; `SVG SCRIPT STYLE` dropped; a `BUTTON` is dropped **except** inside `[data-component="mention-chip"]`, whose `[data-element="display-name"]` text is kept (SDK difference to omnify: chips are buttons here); checkbox inputs become `☑ ` / `☐ `. Blocks: every `[data-component="markdown"]` under `root`. Plain text: bullets `•`, ordered numbers from `start`, two-space indent per nested list, cells joined by tab, blocks separated by a blank line, `\n{3,}` collapsed.

- [ ] **Step 1: Write the failing tests:** `'lists, tables and links become styled html and readable text'` (render `<div data-component="markdown"><p>Hi <a href="https://e.com" onclick="x">E</a></p><ul><li>a</li><li>b</li></ul><table><tr><th>K</th><td>V</td></tr></table></div>` → html contains `<a style="color:#1f6feb;text-decoration:underline;" href="https://e.com/">E</a>`, no `onclick`; text is `Hi E\n\n• a\n• b\n\nK\tV`); `'javascript links keep only their label'`; `'a mention chip keeps its name'` (`<span data-component="mention-chip"><button><span data-element="display-name"><span data-element="prefix">@</span>Bug 7</span></button></span>` → text contains `@Bug 7`); `'other buttons and svgs are dropped'`; `'fallback without markdown blocks'` (root without blocks → `{ text: 'plain', html contains 'plain' }`); `'rich write, then text fallback, then rejection'` — stubs: `clipboard.write` resolves → called once with one `ClipboardItem` holding `text/html` and `text/plain`; `write` rejects → `writeText` called with the text; no `ClipboardItem` → `writeText`; no `navigator.clipboard` → promise rejects; nothing logged (`vi.spyOn(console, …)` untouched).
- [ ] **Step 2: Run** `bunx vitest run src/react/utils/__tests__/copy-message.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** the file — Expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add src/react/utils/copy-message.ts src/react/utils/__tests__/copy-message.test.ts
git commit -m "feat(react): rich and plain copy content of a rendered answer"
```

---

### Task 4: Message footer (`messageFooter`: copy, sources, duration, stop)

**Files:**
- Create: `src/react/components/message-footer.tsx` (internal component + `formatDuration`)
- Modify: `src/react/types.ts` (`MessageFooterConfig`, `AiChatProviderConfig.messageFooter`, `MessagePartNodes.footer`, `ChatLocale` keys)
- Modify: `src/react/components/message-bubble.tsx` (`nodes.footer`, `ordered` renders it last, `MessageParts` return)
- Modify: `src/react/provider/ai-chat-provider.tsx` (resolve `messageFooter`, context, `DEFAULT_LOCALE`), `src/react/provider/composer-context.ts` (`messageFooter`), `src/react/locale-de.ts`, `src/react/index.ts` (type export), `src/react/styles.css`, `src/embed/chat-styles.generated.ts`
- Test: `src/react/components/__tests__/message-footer.test.tsx` (new)
- Create: `upgrade-notes/unreleased/message-footer.json`

**Interfaces:**
- Consumes: `TurnOutcome.durationMs`, `turnRunStartedAt` (Task 1); `readMessageSources` (Task 2); `copyMessageToClipboard` (Task 3); `stop`, `language`, `locale` from context.
- Produces (public):
```ts
/** Per-answer footer (`AiChatProvider` `messageFooter`). Each part defaults to true once the footer is on. */
export interface MessageFooterConfig {
  /** Copy button: the answer as formatted text (lists, tables, links) and plain text. */
  copy?: boolean;
  /** A toggle with the https links the answer cites (its links, source parts, tool `sources`/`citations`). */
  sources?: boolean;
  /** "Done in 3.2 s" under the last answer of a completed turn; the elapsed time while it runs. */
  duration?: boolean;
  /** A stop button under the answer that is running. */
  stop?: boolean;
}
AiChatProviderConfig.messageFooter?: boolean | MessageFooterConfig;   // default off (D1)
MessagePartNodes.footer?: ReactNode;   // always set by the SDK (null when nothing shows)
```
- `ChatLocale` keys (optional; en / de): `copyMessageLabel` `'Copy'`/`'Kopieren'`, `copiedMessageLabel` `'Copied'`/`'Kopiert'`, `copyMessageFailedLabel` `'Copy failed'`/`'Kopieren fehlgeschlagen'`, `messageSourceOneLabel` `'1 source'`/`'1 Quelle'`, `messageSourcesLabel` `'{count} sources'`/`'{count} Quellen'`, `messageDurationLabel` `'Done in {duration}'`/`'Fertig in {duration}'`.
- Internal: `ComposerContextValue.messageFooter?: Required<MessageFooterConfig> | null` (resolved once, memo keyed on the four booleans; `true` → all true; object → missing keys true; off → null). `formatDuration(ms: number, language?: string): string` — under 60 s: tenths floored, `Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })` + `' s'` (`3240, 'en'` → `3.2 s`; `'de'` → `3,2 s`; `0` → `0.0 s`); from 60 s: `` `${min} min ${sec} s` `` with whole seconds (`65400` → `1 min 5 s`).
- When the footer shows (`MessageFooter({ message, text, isLastOfTurn, turnOutcome, active })`):
  - only for `role === 'assistant'`;
  - running (`active` = latest message and `isLoading`): `data-state="running"`, elapsed (`duration`, from `turnRunStartedAt`, own 100 ms interval in a child component so ticks re-render only it) and stop (`stop`); nothing else;
  - done: copy when the message renders text (its text or the fallback summary), sources when `readMessageSources(message.parts)` is non-empty, duration when `isLastOfTurn && turnOutcome?.status === 'completed' && typeof turnOutcome.durationMs === 'number'` (D6); no element when none of these (and no follow-ups, Task 5) applies.
  - `isLastOfTurn`: the next message in `messages` is a user message or there is none.
- Markup (exact):
```html
<div data-component="message-footer" data-state="done">
  <div data-element="footer-actions">
    <button type="button" data-action="copy" data-state="idle|copied|failed"><span aria-live="polite">Copy</span></button>
    <button type="button" data-action="sources" aria-expanded="false" aria-controls="{id}">2 sources</button>
    <span data-element="duration">Done in 3.2 s</span>
  </div>
  <ul id="{id}" data-element="sources" hidden>
    <li><a data-element="source" href="https://example.com/a" target="_blank" rel="noopener noreferrer"><span data-element="source-label">Docs</span> <span data-element="source-domain">example.com</span></a></li>
  </ul>
</div>
<!-- running -->
<div data-component="message-footer" data-state="running">
  <div data-element="footer-actions"><span data-element="elapsed" aria-hidden="true">3.2 s</span><button type="button" data-action="stop">Stop</button></div>
</div>
```
  Copy: click → `copyMessageToClipboard(button.closest('[data-component="message-bubble"]'), text)`; resolved → `copied`, rejected → `failed`; back to `idle` after 2000 ms; timer cleared on unmount. `text` = the bubble's cleaned text parts joined by `\n\n`, else the fallback summary.

- [ ] **Step 1: Write the failing tests** (`message-footer.test.tsx`, `Host` + `StreamingChat`):
  - `'zero config: no footer'` — default config, finished answer with a link → no `[data-component="message-footer"]`; bubble `innerHTML` equals the same render on main (snapshot taken in the test from a second render with `messageFooter: false`).
  - `'copy writes the answer and announces it'` — `messageFooter: true`, answer `**Hi** [Docs](https://example.com/a)` → click copy → `clipboard.write` called, label `Copied`; after 2000 ms `Copy`.
  - `'copy failure'` — no `navigator.clipboard` → label `Copy failed`, no throw, no console call.
  - `'sources toggle'` — two links → button `2 sources` with `aria-expanded="false"`, list `hidden`; click → expanded, list visible, links have `target="_blank"` and `rel="noopener noreferrer"`; `aria-controls` equals the list id. One link → `1 source`. A `javascript:` link only → no sources button.
  - `'duration on the last answer of a completed turn'` — fake timers, 3240 ms → `Done in 3.2 s`; `language: 'de'` → `Fertig in 3,2 s`; a stopped turn → no duration; an outcome without `durationMs` → no duration; an earlier assistant message of the same turn → no duration.
  - `'running answer shows elapsed and stop'` — streaming text, 1500 ms → `[data-element="elapsed"]` `1.5 s`, `aria-hidden="true"`; click stop → `chat.stop` called once; after finish the running footer is replaced by the done footer.
  - `'parts can be switched off'` — `{ copy: false, stop: false }` → no copy/stop button, sources and duration still there; `{ copy: false, sources: false, duration: false, stop: false }` → no footer element.
  - `'user messages never get a footer'`.
  - `'MessageParts receives footer'` — `components.MessageParts` that renders `children` shows the footer; one that renders only `{text}` shows none and its props contain a non-null `footer`.
  - `'German texts'` — `language: 'de'`: `Kopieren`, `2 Quellen`.
- [ ] **Step 2: Run** `bunx vitest run src/react/components/__tests__/message-footer.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** `useMessagePartsWithLogs` builds `footer` from values it already has (`isAssistant`, `isLatestMessage`, `turnActive`, `turnOutcome`, `cleanTextParts`, `fallbackSummary`); `MessageBubble` renders `{nodes.footer}` after the text/results block in both branches of `ordered`; `footer: scoped(nodes.footer)` in the return. CSS (new "Message footer" section): footer `margin-top: 0.5rem`, actions row `display:flex; gap:0.5rem; align-items:center; font-size:0.75rem; color: var(--cm-text-muted)`; buttons transparent, `border-radius: var(--cm-radius-sm)`, hover `--cm-primary-tint`, `:focus-visible` outline `2px solid var(--cm-primary)`; elapsed `font-variant-numeric: tabular-nums`; sources list unstyled, each link a row with the domain muted. No transitions (D13). Run `node scripts/generate-embed-styles.mjs`.
- [ ] **Step 4: Run** the new file plus `message-bubble.test.tsx`, `message-layout-hooks.test.tsx`, `message-part-renderers.test.tsx`, `unstyled.test.tsx`, `reduced-motion.test.tsx` — Expected: PASS.
- [ ] **Step 5: Upgrade note** `message-footer`, `kind: "optional"`, summary: "messageFooter adds a footer under each answer: copy as formatted and plain text, the https sources it cites, 'Done in 3.2 s', and the elapsed time with a stop button while it runs. Off by default; useMessageParts and MessageParts get it as footer.", howTo: "<VercelAiChat messageFooter /> or messageFooter={{ stop: false }}. A custom MessageParts that does not render children places parts.footer itself. Texts: copyMessageLabel, copiedMessageLabel, copyMessageFailedLabel, messageSourceOneLabel, messageSourcesLabel, messageDurationLabel (German in deChatLocale). Nothing is sent anywhere.", `surface`: as the upgrade-notes test reports (expected: `glirastes/react#MessageFooterConfig.*`, the four `messageFooter` keys on `AiChatProviderConfig` / `AiChatProviderProps` / `VercelAiChatProps` / `GlirastesChatElementConfig`, `footer` on `MessagePartNodes` / `MessageParts` / `MessagePartsProps`, the six `ChatLocale` keys). CHANGELOG `### Added`.
- [ ] **Step 6: Commit**
```bash
git add src/react/components/message-footer.tsx src/react/types.ts src/react/components/message-bubble.tsx src/react/provider/ai-chat-provider.tsx src/react/provider/composer-context.ts src/react/locale-de.ts src/react/index.ts src/react/styles.css src/embed/chat-styles.generated.ts src/react/components/__tests__/message-footer.test.tsx upgrade-notes/unreleased/message-footer.json CHANGELOG.md
git commit -m "feat(react): message footer with copy, sources, duration and stop"
```

---

### Task 5: Follow-ups under the latest answer (`suggestions.placement: 'message'`)

**Files:**
- Modify: `src/react/types.ts` (`SuggestionsConfig.placement`, `ChatLocale.followUpsLabel`)
- Modify: `src/react/components/message-footer.tsx` (follow-ups section), `src/react/components/message-bubble.tsx` (footer also when only follow-ups show)
- Modify: `src/react/components/ai-chat-panel.tsx` (no `SuggestionBar` with `placement: 'message'`)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`DEFAULT_LOCALE`), `src/react/locale-de.ts`, `src/react/styles.css`, `src/embed/chat-styles.generated.ts`
- Test: `src/react/components/__tests__/message-followups.test.tsx` (new), `src/react/components/__tests__/ai-chat-panel.test.tsx`
- Create: `upgrade-notes/unreleased/followups-under-answer.json`

**Interfaces:**
- Consumes: `readMessageFollowups` (Task 2), `findOpenClarification` (`src/react/utils/clarification.ts:85`), `selectSuggestion`, `pendingApprovals`, `pipelineState`, `canCompose`, `isLoading`, `suggestions` from context; `turnOutcome` (bubble).
- Produces (public):
```ts
SuggestionsConfig.placement?: 'composer' | 'message';
// 'composer' (default): the rotating SuggestionBar above the input, as before.
// 'message': the latest answer's follow-ups as buttons under it; no SuggestionBar, so staticChips show nowhere (D9).
ChatLocale.followUpsLabel?: string;   // 'Ask next' / 'Weiterfragen'
```
- Show rule (all must hold, D8): `placement === 'message'`, `suggestions.enabled !== false`, assistant message, it is the last message, `!isLoading`, `pendingApprovals.length === 0`, `!findOpenClarification(messages)`, `turnOutcome` absent or `status === 'completed'`, `pipelineState?.status` not `aborted` / `error` / `safety-stop`, `readMessageFollowups(message, suggestions.count ?? 3)` non-empty. Buttons `disabled={!canCompose}`; click → `selectSuggestion(text)` (sends, as the bar does). Works with `messageFooter` off (the footer element then holds only the follow-ups).
- Markup: inside `[data-component="message-footer"]`, after `footer-actions`:
```html
<div data-element="follow-ups" role="group" aria-labelledby="{hid}">
  <p id="{hid}" data-element="follow-ups-heading">Ask next</p>
  <button type="button" data-action="follow-up">Show only high priority tasks</button>
</div>
```
  (`footer-actions` is omitted when it would be empty.)

- [ ] **Step 1: Write the failing tests:**
  - `message-followups.test.tsx`: `'default placement keeps follow-ups out of the answer'`; `'placement message shows them under the latest answer'` (answer with a `tool-suggest_followups` part `{ state: 'output-available', output: { followups: ['A', 'B', 'C', 'D'] } }` → buttons `A B C`, group named `Ask next`); `'trailing list fallback'` (text `Done.\n\nSuggestions:\n- X\n- Y` → buttons `X Y`, text shows `Done.` only); `'a click sends'` (`chat.sendMessage` with `A`); `'hidden while a new question runs'`; `'hidden while an approval is open'`; `'hidden while a clarification is open'`; `'hidden after a stop'` and `'after an error'`; `'only under the latest answer'` (two turns → only the second answer has the group); `'disabled while the composer is locked'` (`canCompose` false via an open command form or a stub context); `'enabled false hides them'`; `'German heading'` (`Weiterfragen`); `'without messageFooter only the follow-ups render'` (no `footer-actions`).
  - `ai-chat-panel.test.tsx`: `'placement message hides the suggestion bar, also with staticChips'`; existing bar tests unchanged.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement.** The panel line becomes `{!isLoading && !showTypingIndicator && suggestions.placement !== 'message' && <SuggestionBar />}` (merge with P2b's starter condition). CSS: follow-ups as a column of left-aligned buttons, `border: 1px solid var(--cm-border)`, `border-radius: var(--cm-radius-sm)`, heading `font-size: 0.6875rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--cm-text-muted)`; disabled at 0.5 opacity. Regenerate embed styles.
- [ ] **Step 4: Run** both files plus `message-footer.test.tsx`, `src/react/__tests__/pending-approval-send.test.tsx`, `clarification-card.test.tsx` — Expected: PASS.
- [ ] **Step 5: Upgrade note** `followups-under-answer`, `kind: "optional"`, summary: "suggestions.placement: 'message' shows the model's follow-up questions as buttons under the latest answer (heading 'Ask next') instead of the rotating chip above the composer; hidden while a turn runs, an approval or clarification is open, or after a stop or error.", howTo: "suggestions={{ placement: 'message', count: 3 }}. The SuggestionBar and staticChips are not shown then; use composer.starters for an empty chat. The server needs followups enabled (suggest_followups). Heading text: followUpsLabel.", `surface`: `glirastes/react#SuggestionsConfig.placement`, `glirastes/react#ChatLocale.followUpsLabel` (plus whatever the test reports for derived types). CHANGELOG `### Added`.
- [ ] **Step 6: Commit**
```bash
git add src/react/types.ts src/react/components/message-footer.tsx src/react/components/message-bubble.tsx src/react/components/ai-chat-panel.tsx src/react/provider/ai-chat-provider.tsx src/react/locale-de.ts src/react/styles.css src/embed/chat-styles.generated.ts src/react/components/__tests__/message-followups.test.tsx src/react/components/__tests__/ai-chat-panel.test.tsx upgrade-notes/unreleased/followups-under-answer.json CHANGELOG.md
git commit -m "feat(react): follow-up questions under the latest answer"
```

---

### Task 6: Hide UI-only tools from the activity log (`activityLog.hiddenTools`)

**Files:**
- Modify: `src/react/types.ts` (`ActivityLogConfig.hiddenTools`)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`activityLogConfig` memo ~:780: `hiddenTools` resolved, keyed on the joined names)
- Modify: `src/react/components/message-bubble.tsx` (`readSteps` filters), `src/react/components/ai-chat-panel.tsx` (typing-indicator check ~:107 uses the same filter)
- Test: `src/react/components/__tests__/activity-log-hidden-tools.test.tsx` (new)
- Create: `upgrade-notes/unreleased/activity-log-hidden-tools.json`

**Interfaces:**
- Produces (public):
```ts
ActivityLogConfig.hiddenTools?: ReadonlyArray<string>;
// Model-facing tool names (e.g. 'ui_action_toast') that never show as a step, count in the summary or
// split a section. The tool still runs and its UI action still fires. Default [] (the built-ins stay hidden).
```
- `Required<ActivityLogConfig>` in the provider gets `hiddenTools: readonly string[]` (frozen empty array by default).

- [ ] **Step 1: Write the failing tests:** `'a hidden tool is not a step'` (`hiddenTools: ['ui_action_toast']`, message with `tool-tasks_list` done + `tool-ui_action_toast` done → one step, summary `1 step done`); `'a message with only hidden tools has no log'`; `'sections ignore hidden tools'` (`grouping: 'sections'`, text, hidden tool, text → no log between the texts); `'the typing indicator shows while only hidden tools ran'` (`AiChatPanel`, loading, last assistant message has only a hidden tool → `[data-component="typing-indicator"]`); `'without hiddenTools nothing changes'`.
- [ ] **Step 2: Run** the new file — Expected: FAIL.
- [ ] **Step 3: Implement** the filter after `readActivitySteps` in both places (a `Set` from the resolved array).
- [ ] **Step 4: Run** the new file plus `activity-log*.test.tsx`, `ai-chat-panel.test.tsx` — Expected: PASS.
- [ ] **Step 5: Upgrade note** `activity-log-hidden-tools`, `kind: "optional"`, summary: "activityLog.hiddenTools lists tools (model-facing names) that never appear in the activity log, e.g. UI-only refresh or toast actions; they still run.", `surface`: `glirastes/react#ActivityLogConfig.hiddenTools`. CHANGELOG `### Added`.
- [ ] **Step 6: Commit**
```bash
git add src/react/types.ts src/react/provider/ai-chat-provider.tsx src/react/components/message-bubble.tsx src/react/components/ai-chat-panel.tsx src/react/components/__tests__/activity-log-hidden-tools.test.tsx upgrade-notes/unreleased/activity-log-hidden-tools.json CHANGELOG.md
git commit -m "feat(react): hide UI-only tools from the activity log"
```

---

### Task 7: Skill, coverage and full gate

**Files:**
- Modify: `skills/building-glirastes-chat-ui/references/hooks-and-building-blocks.md` ("Message layout" ~:68)
- Modify: `skills/building-glirastes-chat-ui/references/non-react-hosts.md` ("Layout without React slots" ~:103)
- Modify: `skills/building-glirastes-chat-ui/SKILL.md` (Configuration table row `suggestions` ~:68) — net 0 lines
- Modify: `tests/skill-coverage-allowlist.json` only if `tests/skill-coverage.test.ts` demands it (it should not)

- [ ] **Step 1: Reference.** In "Message layout" add the bullet "Message footer": `messageFooter` (`true` or `MessageFooterConfig` `copy` / `sources` / `duration` / `stop`), what each part does and when it shows, copy formats (HTML for Word/Outlook + plain text; mention chips keep their names), sources rule (https only, ≤ 20, links + `source-url` parts + tool `sources`/`citations`), `TurnOutcome.durationMs` (working time, approval waits excluded, stored with the outcome), `MessagePartNodes.footer` for own `MessageParts`, the six locale keys. Add `suggestions.placement: 'message'` (show rule, `followUpsLabel`, server `followups`, `staticChips` not shown, use `composer.starters` for an empty chat) and `hiddenTools` to the `activityLog` bullet. In `non-react-hosts.md` add `config.messageFooter`, `config.suggestions.placement` and `activityLog.hiddenTools` to the list.
- [ ] **Step 2: SKILL.md (0 net lines).** Replace the row `| \`suggestions\` | contextual suggestion chips |` with `| \`suggestions\`, \`messageFooter\` | suggestion chips (\`placement: 'message'\` puts follow-ups under the answer); \`messageFooter\`: copy, sources, duration and stop per answer (references/hooks-and-building-blocks.md) |`. `wc -l` before and after must match.
- [ ] **Step 3: Run** `bunx vitest run src/cli/commands/skill-lint.test.ts tests/skill-coverage.test.ts tests/skill-scenarios.test.ts src/upgrade-notes.test.ts` — Expected: PASS.
- [ ] **Step 4: Full gate:** `bun run build && bun run typecheck && bun run typecheck:tests && bun run test` — Expected: all green apart from the two known load flakes, each passing alone.
- [ ] **Step 5: Commit**
```bash
git add skills/building-glirastes-chat-ui/references/hooks-and-building-blocks.md skills/building-glirastes-chat-ui/references/non-react-hosts.md skills/building-glirastes-chat-ui/SKILL.md
git commit -m "docs(skills): message footer, follow-ups under the answer and hidden tools"
```

---

### Task 8: Live check in a browser with the SDK example app (no commit)

Uses `examples/source-driven-next` (real Next 15, the built SDK, a deterministic model). Every change below is made **only in the disposable copy** that the preparer creates; nothing in this task is committed. Not omnify.

- [ ] **Step 1: Build and prepare.** `bun run build`, then `node examples/source-driven-next/prepare-browser.mjs` → prints `<root>` (a `.browser-proof-*` folder next to the example).
- [ ] **Step 2: Patch the copy.**
  - `<root>/src/app/(app)/layout.jsx`: on `VercelAiChat` add `messageFooter`, `suggestions={{ placement: 'message', count: 3 }}`, `activityLog={{ hiddenTools: ['ui_tasks_highlight'] }}`, and `language={process.env.NEXT_PUBLIC_CHAT_LANG}`.
  - `<root>/src/app/chat/route.js`: add `followups: { enabled: true }` to `createAiChatHandler`.
  - `<root>/src/test-model.js`: two branches before the default — `'Footer proof'`: step 1 streams the text `Here is [the guide](https://example.com/guide) and [the spec](https://example.org/spec).` in 6 deltas 300 ms apart (a `ReadableStream` with `pull` + `setTimeout`) and then a `tool-call` `suggest_followups` with `{"followups":["Show done tasks","Go to overview","Filter done tasks"]}`; the step after a tool result of `suggest_followups` finishes with `stop` and no text. `'Slow answer'`: 40 deltas 250 ms apart.
  - `<root>/src/app/session/route.js`: add `export async function GET(request)` that checks `?capability=` against `GLIRASTES_REFERENCE_CAPABILITY` (same test-mode guard as `POST`), sets the same cookie and redirects to `/`.
- [ ] **Step 3: Start.** In `<root>`: `GLIRASTES_REFERENCE_TEST_MODE=1 GLIRASTES_REFERENCE_CAPABILITY=<uuid> NEXT_TELEMETRY_DISABLED=1 bun run dev` (port 3191, run in the background); wait for `Ready in`.
- [ ] **Step 4: Check with the Playwright MCP browser** (`mcp__plugin_playwright_playwright__*`), open `http://localhost:3191/session?capability=<uuid>`; save screenshots to the session scratchpad:
  1. `Footer proof` → while streaming: `[data-component="message-footer"][data-state="running"]` with a ticking elapsed time and `Stop`; after: `Copy`, `2 sources`, `Done in …`, group "Ask next" with three buttons; no `[data-component="suggestion-bar"]`.
  2. `Copy` → label `Copied`; `browser_evaluate` `navigator.clipboard.readText()` (grant `clipboard-read` first) contains `the guide`.
  3. `2 sources` → two links with domain `example.com` / `example.org`, `target="_blank"`.
  4. Click follow-up `Show done tasks` → it is sent, the log shows `tasks_list`; the earlier answer has no follow-ups any more.
  5. `Slow answer` → `Stop` in the footer → turn notice "Stopped", no follow-ups, no duration.
  6. `Highlight Write tests` → the row is highlighted on the page, the activity log shows no step for it.
  7. Keyboard: Tab reaches copy, sources, follow-ups with a visible focus ring; `browser_emulate_media` `reducedMotion: 'reduce'` and `colorScheme: 'dark'` → screenshot.
  8. Restart with `NEXT_PUBLIC_CHAT_LANG=de` → `Kopieren`, `2 Quellen`, `Fertig in …` (comma decimal), `Weiterfragen`, `Stopp`.
  9. Browser console: no errors; the `/chat` request bodies (`browser_network_requests`) contain no `durationMs` and no `glirastesTurnOutcome`.
- [ ] **Step 5: Clean up.** Stop the dev server (its process group), close the browser, `rm -rf <root>`. Report the findings with the screenshot paths; a defect found here goes back into the owning task as a failing test first.

---

## Out of scope

- Avatars, `data-streaming` word fade, a streaming cursor (omnify §2), a `components.TypingIndicator` / loader slot and omnify's pixel loader (§3), the trace placed under the question (`afterUserMessage`), per-step token counts (`stepMeta`).
- `ClarificationCard variant="cards"`, quote cards, "ask about selection".
- A public `getMessageSources` / `copyMessage` helper (D3, D5).
- omnify's app-specific fallback follow-ups (Orders / Contacts / Research) — stay in the app.

## Decisions

- **D1:** The footer is opt-in (`messageFooter`, default off) — zero-config DOM unchanged — rejected: footer on by default for every app.
- **D2:** One provider key `messageFooter: boolean | MessageFooterConfig` with four switches that default to true once on — smallest surface, one line to adopt — rejected: omnify report's `messageActions` array, separate exported `CopyMessageButton` / `MessageSources` / `FollowUps` components.
- **D3:** The footer is a message part (`MessagePartNodes.footer`) rendered last inside the bubble; no new component export, no `components.MessageFooter` slot — custom `MessageParts` / `useMessageParts` layouts get it for free — rejected: an exported `MessageFooter` and a new slot.
- **D4:** Copy writes rich HTML (allowlisted tags with inline styles, from the rendered Markdown) plus plain text, falling back to text only — omnify's `response-clipboard.ts`, pastes well into Word/Outlook — rejected: copying the Markdown source.
- **D5:** Sources are https links only (no credentials), from the answer's Markdown links and reference definitions, AI SDK `source-url` parts and tool output `sources`/`citations`; ≤ 20, deduplicated, collapsed behind a toggle; read without a Markdown dependency — omnify's rule plus the SDK's source parts — rejected: http links, a public `getMessageSources`, pulling in `mdast-util-from-markdown`.
- **D6:** Duration = the turn's working time (sum of its request runs, approval waits excluded), measured in the browser and stored as `TurnOutcome.durationMs` with the existing outcome; shown only on the last answer of a completed turn — survives reload, true after approvals — rejected: wall-clock time from question to end, omnify's in-component timer that is lost on reload, showing a duration on stopped turns.
- **D7:** Elapsed time and stop live in the footer of the running answer — they work for turns without tool steps and the log keeps one job — rejected: omnify's timer/stop in the log summary (`activityLog.showDuration` / `stopButton`).
- **D8:** Follow-ups under the answer via `suggestions.placement: 'message'` (default `'composer'`), only under the latest answer when nothing runs, no approval or clarification is open and the turn completed; a click sends like the bar — omnify's hiding rule — rejected: `messageFooter.followUps`, a click that only fills the composer.
- **D9:** With `placement: 'message'` the `SuggestionBar` is not rendered and `staticChips` show nowhere; follow-ups are read per message with no static fallback — no stale chip under a new answer — rejected: `staticChips` as fallback under the answer.
- **D10:** `suggestions.staticChips` stays supported and is not deprecated; P2b's `composer.starters` covers the empty chat, `staticChips` remains the composer bar's start/fallback — non-breaking answer to P2b's open question — rejected: `@deprecated` now (removal listed under Needs owner).
- **D11:** The activity log gains only `hiddenTools`; it already has details, sections, failure codes, notices and outcomes — smallest surface — rejected: `stepMeta` token counts, `placement: 'afterUserMessage'`, a loader slot.
- **D12:** `hiddenTools` is a list of model-facing names, applied to steps, summary counts, sections and the typing-indicator check — rejected: a predicate function (not serializable for the embed config).
- **D13:** No footer or follow-up animations — nothing to switch off under reduced motion — rejected: omnify's stagger and slide-in.
- **D14:** `suggestions.enabled: false` hides follow-ups under the answer; the composer bar keeps ignoring `enabled` as today — new path correct, old path unchanged — rejected: fixing the bar in this package (Needs owner).
- **D15:** Durations are formatted in code (`3.2 s`, `3,2 s`, `1 min 5 s`, decimal separator from the chat language via `Intl`) inside one template key `messageDurationLabel` — rejected: locale keys per unit.
- **D16:** The footer's stop reuses `locale.stopButton` — no new key.
- **D17:** The live check runs the `source-driven-next` example in a disposable copy with a patched deterministic model; nothing of it is committed — the committed example's derived commands are pinned by `tests/source-driven-browser.test.mjs` — rejected: a committed footer-proof page or model branch.

## Needs owner (breaking or default-changing, not planned)

- **Remove `suggestions.staticChips`** (or the whole rotating `SuggestionBar`) in the next major in favour of `composer.starters` + `placement: 'message'`.
- **Footer and follow-ups under the answer on by default** — changes every app's chat without config.
- **`SuggestionBar` honours `suggestions.enabled: false` and drops stale follow-ups** — today the bar ignores `enabled` and keeps the previous turn's chips when a turn brings none; fixing either changes visible behavior of existing apps.
