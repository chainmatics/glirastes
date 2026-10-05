# Generisches @- und /-System (P07b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every target app's chat offers the app's own things (`@`) and commands (`/`) declaratively: `glirastes tools refresh` derives entities, entity actions and commands from the enabled tools into the generated module (`chatInteractions`), `.glirastes/chat-interactions.json` or app code (`defineChatEntity`, `defineChatCommand`) override them, the chat route serves them per user, React and `<glirastes-chat>` (`el.defineEntity`, `el.defineCommand`, `interactions` attribute) turn them into keyboard- and screen-reader-ready completion lists, and a `ui`/`tool` command sent alone runs without a model call through exactly the tool path of a model turn (registry, managed guard, confirmation, revocation, budget, audit) and records one content-free metric event.

**Architecture:** Work happens in the worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat` on branch `codex/mvp-chat` at `064f8a9` (P01–P04, P07 and the P09 SDK half merged into the foundation branch and fast-forwarded here; `create-ai-chat-handler.ts` already carries P09's turn recorder). The roadmap row names `mvp-tools`; the controller moved P07b to `mvp-chat` so it runs in parallel to P04b/P05 there. Tasks 1–2 add two dependency-free contracts: the direct-command wire protocol (`src/contracts/chat-command.ts`, a `<!--glirastes:command {…}-->` marker like P07's clarification answer) and the bounded interaction data model with validation and overrides (`src/contracts/chat-interactions.ts`). Tasks 3–4 derive interactions from the setup artifact and `tool-contracts.json` (a new `src/codegen/tools/chat-interactions.ts`) and emit them in the generated module with a four-line hook in `emit-module.ts`, so `check` and `integrity` re-render them byte for byte without pipeline changes. Tasks 5–7 run direct commands in the chat handler (`direct-command.ts`, one block in `create-ai-chat-handler.ts`) and serve interactions per user (`createChatInteractionsHandler`, a GET next to the chat POST). Tasks 8–13 build the client side on P07's provider search: definitions and the interaction registry, the provider's send plan (direct command, prompt, or argument form), listbox ARIA and entity actions in the composer, the argument form, styles, and the custom element API (with the shadow-root caret fix the element needs). Task 14 proves keyboard, ARIA and React/embed parity in real Chrome, Task 15 runs derived commands in the real Next reference app (dev and production), Task 16 documents the surface, Task 17 runs the gate.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `.js` import suffixes), Zod 4 (server and tests only; the client contracts stay dependency-free), `ai@6` (`createUIMessageStream`, `MockLanguageModelV3`), React 19, Vitest 4 with jsdom and Testing Library, Bun (`bun build` for browser fixtures), Next.js 15.5 (browser proof only), Playwright from `PLAYWRIGHT_MODULE` with the system Chrome channel (no browser download), Node test runner.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (v1.5) section 6a (approved 2026-10-04: entities, commands with `ui`/`tool`/`prompt`, `@` arguments and argument prompts, derivation from read/search endpoints, item endpoints, UI actions, navigation and filters, output `chatEntities`/`chatCommands` in the generated module, overrides in `.glirastes/chat-interactions.json` or app code, React and `<glirastes-chat>` alike, security, tests), section 6 (P07's generic `/` and `@` provider API this plan extends), 4.4/4.9 (only enabled, authorized tools; the runtime guard), 7 (content-free metrics). Roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md rows owned here: the P07b row and "Direkte @-/-Befehle ohne Modellaufruf umgehen den Metrik-Recorder: aufzeichnen oder ausdrücklich nicht als Turn zählen; `create-ai-chat-handler.ts` wird von P09 und P07b geändert". Checkpoints: P09-sdk item 8 and ledger ruling X6 (/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/.superpowers/sdd/2026-10-05-mvp-plan-09-metrics/progress.md: direct commands record `model: null`, unknown cost and real tool counts, or are ruled non-turns, pinned by a test), P04 item 13 (/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/.superpowers/sdd/2026-10-05-mvp-plan-04-navigation-filters-ui/progress.md: derive commands from UI tools, keep the bus of `glirastes/browser`, run direct `ui` commands through the generated tool's policy, merge the handler with P09 by hand). Citadel design /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-citadel-living-network-design.md 4.1.2/4.3 (cost tiles count turns without a known cost; see the Platform lockstep request in the Self-Review).

## Global Constraints

- No push, merge into a main branch, npm publish or deploy; Omnify is neither read nor changed; no secret is read, printed or written; no live model or STT call (tests use `MockLanguageModelV3`, the reference app's deterministic test model and recording transports).
- Implementers never edit plan files. Shell `rm` is denied and no step needs it: tests clean their temporary directories through Node's `fs`, the browser tests remove their build directories with `rmSync`, the CLI smoke copy of Task 17 is removed in the same command with `node -e "require('fs').rmSync(…)"`, and no step leaves a file behind that a later step must delete.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution. Agent shells reset their working directory between calls, so every command starts with an absolute `cd`; full Vitest runs use `--maxWorkers=4`.
- Direct commands: a user message that is exactly one command marker (`formatChatCommandMessage`) runs its tool without routing, guardrails or model. The tool comes from the turn's registry (static `tools` or `loadTools`, i.e. the materialized, policy-filtered manifest in managed mode), wrapped exactly like on the model path (`toolsToAiTools`, the PII shield when configured — the result stays in the history later model turns read —, Lancer approvals when configured, `createAiSdkTools` with the managed guard hooks). Tool call ids stay provider-safe (`glirastes-command-` plus 20 hex characters, at most 40 in all) because later model turns replay them. SDK built-ins (`ask_clarification`, `suggest_followups`, `find_tools`) never run directly. Arguments are validated against the bound input schema; confirmation uses the wrapped tool's `needsApproval` (the guard's `resolveApproval` in managed mode: policy `requiresApproval` or risk tier 3); the AI SDK approval round trip resumes the command, executing the arguments from the marker, never from the client's tool part. `directCommands: false` turns the whole path off.
- Metrics (P09 item 8, X6): every direct-command request records exactly one `turn.finished` event through the turn recorder: `model: null`, tokens 0, `cost` unknown (`UNKNOWN_TURN_COST`, never 0), `firstTokenMs: null`, status `completed`, `toolCallCount` 1 when the tool ran or was refused at execution (with `toolErrorCount` 1 on failure), 0 for a confirmation request, a denial or a settled request; an unexpected failure is `error`/`pipeline_error`.
- Data model: `ChatInteractionsData` is strict and bounded (50 entities, 300 commands, 20 actions per entity, 12 arguments, 50 options; ids `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`, entity types `[a-z][a-z0-9_-]{0,39}`, tools `[A-Za-z0-9_.-]{1,200}`, argument paths of at most four segments without `__proto__`/`constructor`/`prototype`, fixed arguments at most 2,000 characters, search paths app-internal without parameters). Texts are a string or `{ de?, en? }`, English fallback. The client contracts import nothing (no Zod in the browser bundle).
- Derivation reads only enabled tools: `needs_attention`, excluded and disabled tools (also `navigation-bridge-missing`) derive nothing. Search parameters `search`, `q`, `query`, `term`; limit `limit`, `pageSize`; id `id`, `uuid`, `<type>Id`; label `title`, `name`, `displayName`, `label`, `subject`, `email`; description `description`, `email`, `status`, `subtitle`, `summary`. Only string-typed arguments are offered; a required argument the chat cannot type drops the command or action.
- Nothing about interactions reaches the Glirastes Platform: entity searches run in the browser against the app's endpoints with the user's session; the GET handler answers from the generated module and the pinned turn snapshot.
- Shared files with the parallel P04b/P05 work in `mvp-tools` (merge rules in the table below); `skills/**`, `src/cli/**`, the pipeline and the policy contracts stay untouched.

## Review Focus

1. **A direct command never bypasses what a model turn enforces, and it never reaches the model.** A Platform-disabled or role-restricted tool is refused by the guard (`policy_tool_denied`, `principal_role_denied`), a write tool first returns an approval request and runs only after an approving answer, a denial streams `tool-output-denied`, invalid arguments and unknown or built-in tools are refused without executing anything, routing (`pipeline.process`) and the model (`doStreamCalls`) are never called, a configured PII shield pseudonymizes the command's result like a model call's (later turns send it to the model), and the model sees earlier commands only by their label plus the call and result under a provider-safe id. Pinned in Task 5 Step 1, Task 6 Step 1 and Task 15 Step 1.
2. **Direct commands are counted turns, content-free and with honest numbers** (P09 item 8): one event per request, `model: null`, cost `null` (never 0), the executed call as tool count with its tool id, no argument, label or tool name in the event. Pinned in Task 5 Step 1 and Task 6 Step 1.
3. **Interactions are derived only from what the code enables and the user may run.** Disabled and contract-less tools derive nothing, ids, types, names and choices the protocol cannot carry are skipped one entry at a time and never fail the refresh, derivation is order-independent and byte-stable (`check` and `integrity` stay green), and the per-user GET hides commands, actions and searches of disabled, role-restricted, revoked or undeployed tools while an invalid override file fails at boot. Pinned in Task 3 Step 1, Task 4 Step 1 and Task 7 Step 1.
4. **The composer and the argument form are operable by keyboard and screen reader, in React and inside the shadow root alike.** The editor controls the listbox (`aria-controls`, `aria-activedescendant`, `aria-autocomplete`), a live region announces the count, ArrowRight/ArrowLeft reach entity actions, keys typed right after a pick land behind the token, the form starts at the first empty required field, entity fields are ARIA 1.2 comboboxes, Escape closes before it cancels, and `<glirastes-chat>` reads the caret through its shadow root. Pinned in Task 10 Step 1, Task 11 Step 1, Task 13 Step 1 and Task 14 Step 1.
5. **Structured references and messages stay structured and safe.** A picked entity reaches the model as `{{mention:type:id:label}}` with the trigger the user typed, a command mixed with free text still goes to the model with its tool reference, the marker escapes `<`/`>` so arguments cannot close it, malformed or oversized markers are plain text, bubbles show only the label, and entity hits with ids or actions the markup cannot carry are dropped. Pinned in Task 1 Step 1, Task 8 Step 1, Task 9 Step 1 and Task 10 Step 1.

---

## Shared files and merge rules (parallel to P04b/P05 in `mvp-tools`)

| File | P07b change | Likely parallel change | Merge rule |
| --- | --- | --- | --- |
| `src/codegen/tools/emit-module.ts` | one import line, three lines after `export const toolCatalog` (Task 4) | P05 may emit more data (its draft adds `toolSearchSemantics` after `GeneratedToolId`) | Union: keep both blocks in the order catalog, then each added export; rerun `emit-module.test.ts`, `emit-module-chat.test.ts` and `tests/chat-interactions-next.test.ts` |
| `src/server/adapters/nextjs/create-ai-chat-handler.ts` | import block, `directCommands = true` in the config destructuring, the message preparation block, the direct-command block before `// Pipeline mode` (Task 6) | P05 (`tool_contract_rejected` event: a `contractRejectionReporter(turnMetrics)` spread into the two existing `endpointToolContext` objects) | Union by hunk; the direct-command block must stay after `toolOptions` and the `session.started` audit and before the pipeline branch; every field P05 adds to the two existing `endpointToolContext` objects (or to `toolOptions` wrapping) is added to the direct-command block's own `endpointToolContext` too, so a direct command reports contract rejections like a model call; rerun `src/server` |
| `src/runtime/metrics/turn-recorder.ts`, `src/contracts/events.ts`, `src/contracts/index.ts` | **not changed**; Tasks 5–6 call `recordStep`/`finish` and build a test sink (`command-fixtures.ts`) | P05 widens `RuntimeMetricsSink.record` to `RuntimeMetricEvent` and adds `recordToolContractRejected` (P09 checkpoint items 3 and 6) | Take P05's side; `collectingSink` keeps only `turn.finished` events, so it type-checks against the old and the widened sink; rerun `bun run typecheck:tests` |
| `src/codegen/tools/types.ts`, `src/codegen/tools/sources/{ui-tools,react-actions}.ts` | **not changed**; the Task 3/4 tests build `ToolContract`/`ToolContractsEntry` literals, Task 4 and Task 15 pin the derived command ids of the Next fixture | P05 adds optional fields (e.g. `ToolContractsEntry.search`) and may change UI tool sources | Take P05's side; a field P05 makes required is added to those test literals; if P05 changes a UI tool's name or input, update the expected ids in `tests/chat-interactions-next.test.ts` and `tests/source-driven-browser.test.mjs` from a fresh refresh of the merged fixture |
| `src/server/adapters/nextjs/types.ts`, `src/server/adapters/nextjs/index.ts` | `directCommands` option after `modelPricing` (Task 6); one export block after the clarification exports (Task 7) | additional options or exports | Union |
| `examples/source-driven-next/README.md`, `tests/source-driven-browser.test.mjs`, `examples/source-driven-next/browser-shell/src/app/{chat/route.js,(app)/layout.jsx}` | one README paragraph, the direct-command steps of the browser proof, the GET export and `chatInteractions` of the shell (Tasks 15–16) | P05/P06 fixture or proof changes | Union; the browser proof must keep `[data-mode="providers"]` before its first `fill` and the command id list must match the merged fixture's pages |
| `skills/building-glirastes-chat-ui/SKILL.md` | **not changed** | P05 revises every skill | P05 adds the chat-interactions section (pointing at `docs/chat-interactions.md`) and the `.glirastes/chat-interactions.json` workflow of `describing-glirastes-tools` |

The P04b plan (`2026-10-05-mvp-plan-04b-platform-relaxations.md`, also on `064f8a9`) changes none of these files (it works in `src/contracts/tool-policy*`, `src/runtime/{policy-overlay,turn-snapshot,local-runtime-source}.ts`, `src/sync/**`, `src/codegen/tools/pipeline.ts` and `src/cli/commands/tools/**`); its D16 relaxations reach direct commands without further work, because their confirmation comes from the guard's `resolveApproval` on the pinned snapshot. Every other file is new or only changed by this plan (`src/contracts/chat-*.ts`, `src/react/**`, `src/embed/**`, the new tests and `docs/chat-interactions.md`). `src/contracts/index.ts` and `src/runtime/index.ts` stay untouched, so the P04b/P05 unions there are not affected. Merge `codex/mvp-chat` into the foundation branch with a plain `git merge` after this plan's gate; on a conflict take both sides per the table and rerun the full gate of Task 17.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/contracts/chat-command.ts` | Create (Task 1) | Wire protocol: `formatChatCommandMessage`, `parseChatCommandMessage`, `stripChatCommandMarkers`, `serializeChatCommandArgs`, `isChatCommandToolCallId`, id patterns |
| `src/contracts/chat-interactions.ts` | Create (Task 2) | `ChatInteractionsData` and friends, `parseChatInteractions`, `parseChatInteractionOverrides`, `mergeChatInteractions`, `chatText`, `isChatArgumentPath`, limits |
| `src/codegen/tools/chat-interactions.ts` | Create (Task 3) | `deriveChatInteractions`, `humanizeIdentifier` |
| `src/codegen/tools/emit-module.ts` | Modify (Task 4) | `export const chatInteractions` in the generated module |
| `src/server/adapters/nextjs/direct-command.ts` | Create (Task 5) | `resolveDirectCommand`, `runDirectCommand`, `stripChatCommandMessages`, `resolveCommandToolName` |
| `src/server/adapters/nextjs/create-ai-chat-handler.ts`, `src/server/adapters/nextjs/types.ts` | Modify (Task 6) | Direct-command branch, `directCommands` option, model copy without markers |
| `src/server/adapters/nextjs/chat-interactions-handler.ts`, `src/server/adapters/nextjs/index.ts` | Create / Modify (Task 7) | `createChatInteractionsHandler` and the server exports |
| `src/react/interactions/{definitions,registry,use-chat-interactions-data}.ts` | Create (Tasks 8, 9) | `defineChatEntity`, `defineChatCommand`, `entitiesFromData`, `createChatInteractionRegistry`, `useChatInteractionsData` |
| `src/react/completions/completion-search.ts` | Modify (Task 8) | Entity actions on completion items |
| `src/react/types.ts`, `src/react/provider/{ai-chat-provider.tsx,chat-context.ts}`, `src/react/index.ts`, `src/react/components/message-bubble.tsx` | Modify (Tasks 8–11) | `chatInteractions` config, send plans, pending command, `mentionEntity`, locale strings, exports, label-only bubbles |
| `src/react/components/rich-mention-input.tsx`, `src/react/components/mention-input.tsx` | Modify (Tasks 10, 11, 13) | Listbox ARIA, live region, entity actions, typed trigger as prefix, synchronous caret, argument form, shadow-root selection |
| `src/react/components/command-arguments-form.tsx` | Create (Task 11) | Form for missing arguments with entity comboboxes |
| `src/react/styles.css`, `src/embed/chat-styles.generated.ts` | Modify (Task 12) | Styles for actions and the form; regenerated shadow-root CSS |
| `src/embed/glirastes-chat-element.tsx`, `src/embed/index.ts` | Modify (Task 13) | `defineEntity`, `defineCommand`, `interactions`, `mentionEntity`, `lang`-based labels |
| `tests/browser/chat-interactions-fixture.tsx`, `tests/chat-interactions-browser.test.mjs` | Create (Task 14) | Keyboard, ARIA and parity in Chrome |
| `examples/source-driven-next/browser-shell/src/app/{chat/route.js,(app)/layout.jsx}`, `tests/source-driven-browser.test.mjs` | Modify (Task 15) | Real Next: per-user GET, derived commands without the model |
| `docs/chat-interactions.md`, `examples/source-driven-next/README.md` | Create / Modify (Task 16) | Developer documentation |
| Tests (Create): `src/contracts/__tests__/{chat-command,chat-interactions}.test.ts`, `src/codegen/tools/{chat-interactions,emit-module-chat}.test.ts`, `tests/chat-interactions-next.test.ts`, `src/server/adapters/nextjs/__tests__/{command-fixtures.ts,direct-command.test.ts,direct-commands-handler.test.ts,chat-interactions-handler.test.ts}`, `src/react/interactions/__tests__/registry.test.ts`, `src/react/provider/__tests__/chat-interactions.test.tsx`, `src/react/components/__tests__/{chat-interactions-composer,command-arguments-form}.test.tsx`, `src/react/__tests__/chat-interactions-styles.test.ts`, `src/embed/__tests__/glirastes-chat-interactions.test.tsx` | Create | One test file per new surface; `command-fixtures.ts` is a helper module, not collected |

All commands run from `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat`. Code blocks are exact: a "replace" block matches the file byte for byte and occurs exactly once when it is applied (apply the blocks of a step from top to bottom), and "Create" blocks are the complete file. `src/embed/chat-styles.generated.ts` is only ever written by `node scripts/generate-embed-styles.mjs` (Task 12).

Baseline at `064f8a9`: `bun run test --maxWorkers=4` reports `Test Files  210 passed (210)` and `Tests  2256 passed (2256)`; `bun run typecheck`, `bun run build` (`Generated 18 subpath shims.`) and `bun run typecheck:tests` exit 0. Run `bun run build` once before Task 4: the Next fixture tests import `dist/`.


### Task 1: Direct-command wire protocol

**Files:**
- Create: `src/contracts/chat-command.ts` (dependency-free, like `clarification.ts`)
- Test: `src/contracts/__tests__/chat-command.test.ts` (Create)

**Interfaces:**
- Consumes: the P07 precedent `src/contracts/clarification.ts` (invisible marker, strict parse, escaped payload).
- Produces:
  - `CHAT_COMMAND_ID_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/`, no `:` or `}`, so command ids stay valid completion and mention ids), `CHAT_COMMAND_TOOL_PATTERN`, `CHAT_COMMAND_MAX_ARGS_LENGTH` (2,000), `CHAT_COMMAND_MAX_LABEL_LENGTH` (200), `CHAT_COMMAND_TOOL_CALL_PREFIX` (`glirastes-command-`).
  - `interface ChatCommandInvocation { commandId; tool; args }`, `interface ParsedChatCommandMessage { invocation; label }`.
  - `formatChatCommandMessage({ commandId, tool, args?, label }): string` (throws on what the server would refuse), `parseChatCommandMessage(text): ParsedChatCommandMessage | undefined` (only a message that is exactly one marker plus an optional label line), `stripChatCommandMarkers(text)`, `serializeChatCommandArgs(args): string | undefined` (`<`/`>` escaped), `isChatCommandToolCallId(id)` (the prefix and only `[A-Za-z0-9_-]`, at most 64 characters, so a replayed id stays valid for every model provider).

- [ ] **Step 1: Write the failing tests**

Create `src/contracts/__tests__/chat-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CHAT_COMMAND_MAX_ARGS_LENGTH,
  formatChatCommandMessage,
  isChatCommandToolCallId,
  parseChatCommandMessage,
  serializeChatCommandArgs,
  stripChatCommandMarkers,
} from '../chat-command.js';

describe('direct chat command wire protocol', () => {
  it('round-trips a command with arguments and a visible label', () => {
    const text = formatChatCommandMessage({
      commandId: 'task.tasks.assign',
      tool: 'tasks.assign',
      args: { taskId: '42', assignee: 'alice' },
      label: '  /Assign   Release prüfen ',
    });
    expect(text).toBe('<!--glirastes:command {"commandId":"task.tasks.assign","tool":"tasks.assign",'
      + '"args":{"taskId":"42","assignee":"alice"}}-->\n/Assign Release prüfen');
    expect(parseChatCommandMessage(text)).toEqual({
      invocation: { commandId: 'task.tasks.assign', tool: 'tasks.assign', args: { taskId: '42', assignee: 'alice' } },
      label: '/Assign Release prüfen',
    });
  });

  it('escapes angle brackets so an argument can never close the marker', () => {
    const text = formatChatCommandMessage({
      commandId: 'notes.create', tool: 'notes.create', args: { title: 'a --> b <!-- c' }, label: 'Note',
    });
    expect(text.split('-->')).toHaveLength(2);
    expect(parseChatCommandMessage(text)?.invocation.args).toEqual({ title: 'a --> b <!-- c' });
  });

  it.each([
    ['an id with a colon', { commandId: 'open:overview', tool: 'ui.navigate' }],
    ['an id with a closing brace', { commandId: 'open}', tool: 'ui.navigate' }],
    ['a tool with a space', { commandId: 'open', tool: 'ui navigate' }],
    ['array arguments', { commandId: 'open', tool: 'ui.navigate', args: [] as unknown as Record<string, unknown> }],
    ['oversized arguments', { commandId: 'open', tool: 'ui.navigate', args: { text: 'x'.repeat(CHAT_COMMAND_MAX_ARGS_LENGTH) } }],
  ])('refuses to format %s', (_label, input) => {
    expect(() => formatChatCommandMessage({ ...input, label: 'x' })).toThrow(/chat command/i);
  });

  it.each([
    ['plain text', 'Open overview'],
    ['text before the marker', 'Bitte <!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->\nA'],
    ['a second text line', '<!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->\nA\nB'],
    ['an unknown key', '<!--glirastes:command {"commandId":"a","tool":"b","args":{},"run":true}-->'],
    ['non-object arguments', '<!--glirastes:command {"commandId":"a","tool":"b","args":"x"}-->'],
    ['a raw angle bracket', '<!--glirastes:command {"commandId":"a","tool":"b","args":{"x":"<"}}-->'],
    ['broken JSON', '<!--glirastes:command {"commandId":"a","tool":"b",}-->'],
    ['a missing tool', '<!--glirastes:command {"commandId":"a","args":{}}-->'],
  ])('does not read %s as a command', (_label, text) => {
    expect(parseChatCommandMessage(text)).toBeUndefined();
  });

  it('accepts a marker without a label line', () => {
    expect(parseChatCommandMessage('<!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->'))
      .toEqual({ invocation: { commandId: 'a', tool: 'b', args: {} }, label: '' });
  });

  it('strips markers for display and for the model copy of old messages', () => {
    const text = formatChatCommandMessage({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' }, label: '/Open Overview' });
    expect(stripChatCommandMarkers(text)).toBe('/Open Overview');
    expect(stripChatCommandMarkers('no marker')).toBe('no marker');
  });

  it('serializes only plain objects within the limit', () => {
    expect(serializeChatCommandArgs({ a: '<b>' })).toBe('{"a":"\\u003cb\\u003e"}');
    expect(serializeChatCommandArgs(null)).toBeUndefined();
    expect(serializeChatCommandArgs({ big: 'x'.repeat(CHAT_COMMAND_MAX_ARGS_LENGTH) })).toBeUndefined();
  });

  it('recognises the tool call ids of direct commands', () => {
    expect(isChatCommandToolCallId('glirastes-command-0f3a')).toBe(true);
    expect(isChatCommandToolCallId('call_1')).toBe(false);
    expect(isChatCommandToolCallId('glirastes-command-<x>')).toBe(false);
    expect(isChatCommandToolCallId('glirastes-command-a.b:c')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/contracts/__tests__/chat-command.test.ts --maxWorkers=4
```

Expected: FAIL — `Cannot find module '../chat-command.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

Create `src/contracts/chat-command.ts`:

```ts
/**
 * Wire protocol of direct chat commands: a `/` command or an entity action
 * the user runs without a model call. The chat UI sends it as the complete
 * text of a user message; the chat handler runs the named tool through the
 * normal tool path (authorization, confirmation, revocation, budget, audit).
 * Dependency-free like `clarification.ts`, so the React bundle,
 * `<glirastes-chat>` and the server adapters share it.
 */

/** Command and action ids: a letter or digit, then `[A-Za-z0-9._-]`, at most 200 characters. */
export const CHAT_COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Catalog definition ids, e.g. `ui.navigate` or `tasks.update`. */
export const CHAT_COMMAND_TOOL_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
/** Serialized JSON of the arguments, after escaping. */
export const CHAT_COMMAND_MAX_ARGS_LENGTH = 2_000;
export const CHAT_COMMAND_MAX_LABEL_LENGTH = 200;
/** Tool call ids of direct commands start with this prefix. */
export const CHAT_COMMAND_TOOL_CALL_PREFIX = 'glirastes-command-';

export interface ChatCommandInvocation {
  readonly commandId: string;
  /** Catalog definition id of the tool to run. */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ParsedChatCommandMessage {
  readonly invocation: ChatCommandInvocation;
  /** The visible line after the marker, trimmed (may be empty). */
  readonly label: string;
}

const MARKER = /^\s*<!--glirastes:command (\{[^\n]{2,2600}\})-->(?:\n([^\n]*))?\s*$/;
const MARKERS = /<!--glirastes:command \{[^\n]{0,2600}?\}-->[ \t]*\n?/g;
const KEYS = new Set(['commandId', 'tool', 'args']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON of `args` with `<` and `>` escaped, so it can never close the marker
 * comment, or `undefined` when it is not a plain object or too long.
 */
export function serializeChatCommandArgs(args: unknown): string | undefined {
  if (!isPlainObject(args)) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  const safe = json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return safe.length <= CHAT_COMMAND_MAX_ARGS_LENGTH ? safe : undefined;
}

function cleanLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, CHAT_COMMAND_MAX_LABEL_LENGTH);
}

/**
 * The user message that runs a command without a model call:
 * `<!--glirastes:command {"commandId":…,"tool":…,"args":{…}}-->` and the
 * visible label on the next line. Throws on an id, tool or argument set the
 * server would refuse.
 */
export function formatChatCommandMessage(input: {
  commandId: string;
  tool: string;
  args?: Readonly<Record<string, unknown>>;
  label: string;
}): string {
  if (!CHAT_COMMAND_ID_PATTERN.test(input.commandId)) throw new Error('Invalid chat command id');
  if (!CHAT_COMMAND_TOOL_PATTERN.test(input.tool)) throw new Error('Invalid chat command tool');
  const args = serializeChatCommandArgs(input.args ?? {});
  if (args === undefined) {
    throw new Error(`Chat command arguments must be a JSON object of at most ${CHAT_COMMAND_MAX_ARGS_LENGTH} characters`);
  }
  const payload = `{"commandId":${JSON.stringify(input.commandId)},"tool":${JSON.stringify(input.tool)},"args":${args}}`;
  return `<!--glirastes:command ${payload}-->\n${cleanLabel(input.label)}`;
}

/**
 * Reads a message that consists of exactly one command marker (and its
 * label line). Anything else, including a malformed or oversized payload, is
 * not a command.
 */
export function parseChatCommandMessage(text: string): ParsedChatCommandMessage | undefined {
  const match = MARKER.exec(text);
  if (!match) return undefined;
  const payload = match[1]!;
  if (/[<>]/.test(payload)) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isPlainObject(record) || Object.keys(record).some((key) => !KEYS.has(key))) return undefined;
  const { commandId, tool, args } = record;
  if (typeof commandId !== 'string' || !CHAT_COMMAND_ID_PATTERN.test(commandId)) return undefined;
  if (typeof tool !== 'string' || !CHAT_COMMAND_TOOL_PATTERN.test(tool)) return undefined;
  if (serializeChatCommandArgs(args) === undefined) return undefined;
  return {
    invocation: { commandId, tool, args: args as Record<string, unknown> },
    label: cleanLabel(match[2] ?? ''),
  };
}

/** Removes every command marker, e.g. for display or for the model's copy of old messages. */
export function stripChatCommandMarkers(text: string): string {
  return text.replace(MARKERS, '');
}

/**
 * A tool call id of a direct command: the prefix, then only characters every
 * model provider accepts in a tool call id (later model turns replay it).
 */
export function isChatCommandToolCallId(toolCallId: unknown): toolCallId is string {
  return typeof toolCallId === 'string'
    && toolCallId.startsWith(CHAT_COMMAND_TOOL_CALL_PREFIX)
    && /^[A-Za-z0-9_-]{1,64}$/.test(toolCallId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/contracts/__tests__/chat-command.test.ts --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  19 passed (19)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/contracts/__tests__/chat-command.test.ts src/contracts/chat-command.ts
git commit -m "feat(contracts): add the direct chat command wire protocol"
```

### Task 2: Declarative interaction data, validation and overrides

**Files:**
- Create: `src/contracts/chat-interactions.ts` (dependency-free; the browser bundle imports it)
- Test: `src/contracts/__tests__/chat-interactions.test.ts` (Create)

**Interfaces:**
- Consumes: Task 1 `CHAT_COMMAND_ID_PATTERN`, `CHAT_COMMAND_TOOL_PATTERN`, `serializeChatCommandArgs`.
- Produces:
  - Types `ChatLocaleCode` (`'de' | 'en'`), `ChatText`, `ChatInteractionArg { name, label, required?, entity?, options? }`, `ChatToolRun { kind: 'tool' | 'ui', tool, args? }`, `ChatPromptRun { kind: 'prompt', prompt }`, `ChatCommandRun`, `ChatCommandData`, `ChatEntitySearchData { tool, path, queryParam, itemsPath, idField, labelField, descriptionField?, limitParam? }`, `ChatEntityActionData { id, label, entityArg, args?, run: ChatToolRun }`, `ChatEntityData { type, label, icon?, search?, actions? }`, `ChatInteractionsData { schemaVersion: 1, entities, commands }` (all readonly, so a generated `as const` literal is assignable), `ChatCommandOverride`, `ChatEntityActionOverride`, `ChatEntityOverride`, `ChatInteractionOverrides`.
  - `CHAT_INTERACTION_LIMITS`, `CHAT_ENTITY_TYPE_PATTERN`, `class ChatInteractionsError { issues }`.
  - `parseChatInteractions(value): ChatInteractionsData` and `parseChatInteractionOverrides(value): ChatInteractionOverrides` (strict, every issue named with its path, unknown fields refused), `mergeChatInteractions(base, overrides?)` (patch, `hidden: true`, complete new entries; result validated again), `chatText(text, locale = 'en')`, `isChatArgumentPath(name)`.

- [ ] **Step 1: Write the failing tests**

Create `src/contracts/__tests__/chat-interactions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ChatInteractionsError,
  chatText,
  isChatArgumentPath,
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatInteractionsData,
} from '../chat-interactions.js';

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: { de: 'Aufgabe', en: 'Task' },
    search: {
      tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'],
      idField: 'id', labelField: 'title', descriptionField: 'status',
    },
    actions: [
      { id: 'task.tasks.complete', label: { en: 'Complete' }, entityArg: 'id', run: { kind: 'tool', tool: 'tasks.complete' } },
      {
        id: 'task.tasks.assign', label: { en: 'Assign' }, entityArg: 'id',
        args: [{ name: 'assignee', label: 'Person', required: true, entity: 'person' }],
        run: { kind: 'tool', tool: 'tasks.assign' },
      },
    ],
  }],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: { en: 'Filter Tasks' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

function issuesOf(run: () => unknown): ReadonlyArray<string> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChatInteractionsError);
    return (error as ChatInteractionsError).issues;
  }
  throw new Error('expected a ChatInteractionsError');
}

describe('chat interaction data', () => {
  it('accepts derived entities, actions and commands unchanged', () => {
    expect(parseChatInteractions(data)).toEqual(data);
  });

  it('reads texts per language with an English fallback', () => {
    expect(chatText({ de: 'Übersicht öffnen', en: 'Open Overview' }, 'de')).toBe('Übersicht öffnen');
    expect(chatText({ en: 'Open Overview' }, 'de')).toBe('Open Overview');
    expect(chatText('Öffnen', 'en')).toBe('Öffnen');
    expect(chatText(undefined)).toBe('');
  });

  it.each([
    ['a prototype path', '__proto__.polluted', false],
    ['a constructor segment', 'params.constructor', false],
    ['five segments', 'a.b.c.d.e', false],
    ['a nested path', 'params.taskId', true],
  ])('checks argument paths: %s', (_label, path, valid) => {
    expect(isChatArgumentPath(path)).toBe(valid);
  });

  it('names every violation instead of keeping a partial result', () => {
    const issues = issuesOf(() => parseChatInteractions({
      schemaVersion: 1,
      entities: [{ type: 'Task', label: '', search: { tool: 'tasks.list', path: '//evil.example', queryParam: 'q', itemsPath: [], idField: 'id', labelField: 'title' } }],
      commands: [
        { id: 'open:x', label: 'X', run: { kind: 'tool', tool: 'x' } },
        { id: 'run', label: 'Run', run: { kind: 'shell', tool: 'x' } },
        { id: 'big', label: 'Big', run: { kind: 'tool', tool: 'x', args: { blob: 'x'.repeat(2_100) } } },
        { id: 'dup', label: 'A', run: { kind: 'tool', tool: 'x' } },
        { id: 'dup', label: 'B', run: { kind: 'tool', tool: 'x' } },
        { id: 'extra', label: 'E', run: { kind: 'tool', tool: 'x' }, onRun: 'alert(1)' },
      ],
    }));
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('$.entities[0].type'),
      expect.stringContaining('$.entities[0].label'),
      expect.stringContaining('$.entities[0].search.path'),
      expect.stringContaining('$.commands[0].id'),
      expect.stringContaining('$.commands[1].run.kind'),
      expect.stringContaining('$.commands[2].run.args'),
      expect.stringContaining('duplicate dup'),
      expect.stringContaining('$.commands[5].onRun: unknown field'),
    ]));
  });

  it('refuses more commands than the limit', () => {
    const commands = Array.from({ length: 301 }, (_, index) => ({ id: `c${index}`, label: 'C', run: { kind: 'tool', tool: 'x' } }));
    expect(issuesOf(() => parseChatInteractions({ schemaVersion: 1, entities: [], commands })))
      .toEqual(['$.commands: an array of at most 300 entries']);
  });
});

describe('chat interaction overrides', () => {
  it('relabels, hides and adds entries, and keeps everything else derived', () => {
    const overrides = parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: {
        'open.overview': { label: { de: 'Startseite', en: 'Home' }, keywords: ['start'] },
        'filter.tasks': { hidden: true },
        'standup': { label: 'Stand-up', run: { kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.' } } },
      },
      entities: {
        task: { label: { de: 'Aufgabe', en: 'To-do' }, actions: { 'task.tasks.complete': { hidden: true } } },
        person: {
          label: 'Person',
          search: { tool: 'people.list', path: '/api/people', queryParam: 'q', itemsPath: [], idField: 'id', labelField: 'name' },
        },
      },
    });
    const merged = mergeChatInteractions(data, overrides);
    expect(merged.commands.map((entry) => entry.id)).toEqual(['open.overview', 'standup']);
    expect(merged.commands[0]).toMatchObject({ label: { de: 'Startseite', en: 'Home' }, keywords: ['start'], run: data.commands[0]!.run });
    expect(merged.commands[1]!.run).toEqual({ kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.' } });
    expect(merged.entities.map((entry) => entry.type)).toEqual(['task', 'person']);
    expect(merged.entities[0]!.label).toEqual({ de: 'Aufgabe', en: 'To-do' });
    expect(merged.entities[0]!.actions!.map((entry) => entry.id)).toEqual(['task.tasks.assign']);
  });

  it('removes the last action of an entity when every action is hidden', () => {
    const merged = mergeChatInteractions(data, parseChatInteractionOverrides({
      schemaVersion: 1,
      entities: { task: { actions: { 'task.tasks.complete': { hidden: true }, 'task.tasks.assign': { hidden: true } } } },
    }));
    expect(merged.entities[0]).not.toHaveProperty('actions');
  });

  it('refuses an incomplete new entry and unknown override fields', () => {
    const overrides = parseChatInteractionOverrides({ schemaVersion: 1, commands: { orphan: { keywords: ['x'] } } });
    expect(issuesOf(() => mergeChatInteractions(data, overrides))).toEqual(expect.arrayContaining([
      '$.commands[2].label: required',
      '$.commands[2].run: required',
    ]));
    expect(issuesOf(() => parseChatInteractionOverrides({ schemaVersion: 1, commands: { 'open.overview': { color: 'red' } } })))
      .toEqual(['$.commands.open.overview.color: unknown field']);
    expect(issuesOf(() => parseChatInteractionOverrides({ schemaVersion: 2 }))).toEqual(['$.schemaVersion: must be 1']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/contracts/__tests__/chat-interactions.test.ts --maxWorkers=4
```

Expected: FAIL — `Cannot find module '../chat-interactions.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

Create `src/contracts/chat-interactions.ts`:

```ts
/**
 * Declarative chat interactions: `@` entities and `/` commands a target app
 * offers in its chat. `glirastes tools refresh` derives them from the code
 * (`chatInteractions` in the generated module), `.glirastes/chat-interactions.json`
 * or app code override them, and React and `<glirastes-chat>` turn them into
 * completion providers. Plain JSON, dependency-free and bounded: the same
 * data travels from the generator through the chat handler to the browser.
 */
import {
  CHAT_COMMAND_ID_PATTERN,
  CHAT_COMMAND_TOOL_PATTERN,
  serializeChatCommandArgs,
} from './chat-command.js';

export type ChatLocaleCode = 'de' | 'en';
/** One text, or one per language; `en` is the fallback. */
export type ChatText = string | { readonly de?: string; readonly en?: string };

export interface ChatInteractionArg {
  /** Argument name, a dotted path for nested values (`params.taskId`). */
  readonly name: string;
  readonly label: ChatText;
  readonly required?: boolean;
  /** The value is the id of an entity of this type, picked with `@`. */
  readonly entity?: string;
  /** Closed set of values. */
  readonly options?: ReadonlyArray<string>;
}

/** Runs a catalog tool directly, without a model call. `ui` marks a generated UI tool. */
export interface ChatToolRun {
  readonly kind: 'tool' | 'ui';
  /** Catalog definition id, e.g. `ui.navigate`. */
  readonly tool: string;
  /** Fixed arguments, merged below the user's arguments. */
  readonly args?: Readonly<Record<string, unknown>>;
}

/** Inserts a prepared instruction that the model carries out. */
export interface ChatPromptRun {
  readonly kind: 'prompt';
  readonly prompt: ChatText;
}

export type ChatCommandRun = ChatToolRun | ChatPromptRun;

export interface ChatCommandData {
  readonly id: string;
  readonly label: ChatText;
  readonly description?: ChatText;
  readonly keywords?: ReadonlyArray<string>;
  /** Icon name (`[a-z0-9-]`), resolved by the app's theme. */
  readonly icon?: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatCommandRun;
}

/** Entity search through a read endpoint of the app, with the user's session. */
export interface ChatEntitySearchData {
  /** The read tool behind the search; the chat handler hides the search when it is not allowed. */
  readonly tool: string;
  /** App-internal collection path, e.g. `/api/tasks`. */
  readonly path: string;
  readonly queryParam: string;
  /** Where the item list sits in the response; empty when the response is the list. */
  readonly itemsPath: ReadonlyArray<string>;
  readonly idField: string;
  readonly labelField: string;
  readonly descriptionField?: string;
  readonly limitParam?: string;
}

export interface ChatEntityActionData {
  readonly id: string;
  readonly label: ChatText;
  /** Argument that receives the entity id (dotted path). */
  readonly entityArg: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatToolRun;
}

export interface ChatEntityData {
  /** Mention type, e.g. `task`. */
  readonly type: string;
  readonly label: ChatText;
  readonly icon?: string;
  readonly search?: ChatEntitySearchData;
  readonly actions?: ReadonlyArray<ChatEntityActionData>;
}

export interface ChatInteractionsData {
  readonly schemaVersion: 1;
  readonly entities: ReadonlyArray<ChatEntityData>;
  readonly commands: ReadonlyArray<ChatCommandData>;
}

export interface ChatCommandOverride extends Partial<Omit<ChatCommandData, 'id'>> {
  readonly hidden?: boolean;
}

export interface ChatEntityActionOverride extends Partial<Omit<ChatEntityActionData, 'id'>> {
  readonly hidden?: boolean;
}

export interface ChatEntityOverride extends Partial<Omit<ChatEntityData, 'type' | 'actions'>> {
  readonly hidden?: boolean;
  readonly actions?: Readonly<Record<string, ChatEntityActionOverride>>;
}

/** `.glirastes/chat-interactions.json`: written by people or skills, never by the generator. */
export interface ChatInteractionOverrides {
  readonly schemaVersion: 1;
  readonly entities?: Readonly<Record<string, ChatEntityOverride>>;
  readonly commands?: Readonly<Record<string, ChatCommandOverride>>;
}

export const CHAT_INTERACTION_LIMITS = Object.freeze({
  entities: 50,
  commands: 300,
  actionsPerEntity: 20,
  args: 12,
  options: 50,
  keywords: 20,
  labelLength: 200,
  descriptionLength: 500,
  promptLength: 2_000,
});

export const CHAT_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const ARG_SEGMENT = /^[A-Za-z_$][\w$-]{0,63}$/;
const ICON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export class ChatInteractionsError extends Error {
  constructor(readonly issues: ReadonlyArray<string>) {
    super(`Invalid chat interactions: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'ChatInteractionsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a dotted argument path that can never reach an object prototype. */
export function isChatArgumentPath(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > 200) return false;
  const segments = name.split('.');
  return segments.length <= 4
    && segments.every((segment) => ARG_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment));
}

/** The text in `locale`, falling back to English, then German. */
export function chatText(text: ChatText | undefined, locale: ChatLocaleCode = 'en'): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.en ?? text.de ?? '';
}

type Issues = string[];

function fail(issues: Issues, path: string, message: string): undefined {
  issues.push(`${path}: ${message}`);
  return undefined;
}

function checkKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>, path: string, issues: Issues): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key}: unknown field`);
  }
}

function boundedString(value: unknown, max: number, path: string, issues: Issues): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000B-\u001F]/.test(value)) {
    return fail(issues, path, `a non-blank string of at most ${max} characters`);
  }
  return value;
}

function text(value: unknown, max: number, path: string, issues: Issues): ChatText | undefined {
  if (typeof value === 'string') return boundedString(value, max, path, issues);
  if (!isRecord(value)) return fail(issues, path, 'a string or { de, en }');
  checkKeys(value, ['de', 'en'], path, issues);
  const result: { de?: string; en?: string } = {};
  for (const language of ['de', 'en'] as const) {
    if (value[language] === undefined) continue;
    const entry = boundedString(value[language], max, `${path}.${language}`, issues);
    if (entry !== undefined) result[language] = entry;
  }
  if (result.de === undefined && result.en === undefined) return fail(issues, path, 'needs de or en');
  return result;
}

function pattern(value: unknown, regex: RegExp, path: string, issues: Issues): string | undefined {
  return typeof value === 'string' && regex.test(value) ? value : fail(issues, path, `must match ${regex}`);
}

function list<T>(
  value: unknown,
  max: number,
  path: string,
  issues: Issues,
  item: (entry: unknown, path: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return fail(issues, path, `an array of at most ${max} entries`);
  const result: T[] = [];
  value.forEach((entry, index) => {
    const parsed = item(entry, `${path}[${index}]`);
    if (parsed !== undefined) result.push(parsed);
  });
  return result;
}

function fixedArgs(value: unknown, path: string, issues: Issues): Record<string, unknown> | undefined {
  if (serializeChatCommandArgs(value) === undefined) return fail(issues, path, 'a JSON object of at most 2000 characters');
  return value as Record<string, unknown>;
}

function arg(value: unknown, path: string, issues: Issues): ChatInteractionArg | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['name', 'label', 'required', 'entity', 'options'], path, issues);
  if (!isChatArgumentPath(value.name)) return fail(issues, `${path}.name`, 'a dotted argument path');
  const label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  if (value.required !== undefined && typeof value.required !== 'boolean') fail(issues, `${path}.required`, 'a boolean');
  const entity = value.entity === undefined ? undefined : pattern(value.entity, CHAT_ENTITY_TYPE_PATTERN, `${path}.entity`, issues);
  const options = value.options === undefined
    ? undefined
    : list(value.options, CHAT_INTERACTION_LIMITS.options, `${path}.options`, issues,
      (entry, entryPath) => boundedString(entry, 100, entryPath, issues));
  if (label === undefined) return undefined;
  return {
    name: value.name,
    label,
    ...(value.required === true ? { required: true } : {}),
    ...(entity ? { entity } : {}),
    ...(options ? { options } : {}),
  };
}

function args(value: unknown, path: string, issues: Issues): ChatInteractionArg[] | undefined {
  const parsed = list(value, CHAT_INTERACTION_LIMITS.args, path, issues, (entry, entryPath) => arg(entry, entryPath, issues));
  if (parsed && new Set(parsed.map((entry) => entry.name)).size !== parsed.length) {
    return fail(issues, path, 'argument names must be unique');
  }
  return parsed;
}

function toolRun(value: unknown, path: string, issues: Issues): ChatToolRun | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['kind', 'tool', 'args'], path, issues);
  if (value.kind !== 'tool' && value.kind !== 'ui') return fail(issues, `${path}.kind`, "'tool' or 'ui'");
  const tool = pattern(value.tool, CHAT_COMMAND_TOOL_PATTERN, `${path}.tool`, issues);
  const fixed = value.args === undefined ? undefined : fixedArgs(value.args, `${path}.args`, issues);
  if (tool === undefined) return undefined;
  return { kind: value.kind, tool, ...(fixed ? { args: fixed } : {}) };
}

function commandRun(value: unknown, path: string, issues: Issues): ChatCommandRun | undefined {
  if (isRecord(value) && value.kind === 'prompt') {
    checkKeys(value, ['kind', 'prompt'], path, issues);
    const prompt = text(value.prompt, CHAT_INTERACTION_LIMITS.promptLength, `${path}.prompt`, issues);
    return prompt === undefined ? undefined : { kind: 'prompt', prompt };
  }
  return toolRun(value, path, issues);
}

const COMMAND_FIELDS = ['label', 'description', 'keywords', 'icon', 'args', 'run'] as const;

function commandFields(value: Record<string, unknown>, path: string, issues: Issues): Partial<ChatCommandData> {
  const result: Record<string, unknown> = {};
  if (value.label !== undefined) result.label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  if (value.description !== undefined) {
    result.description = text(value.description, CHAT_INTERACTION_LIMITS.descriptionLength, `${path}.description`, issues);
  }
  if (value.keywords !== undefined) {
    result.keywords = list(value.keywords, CHAT_INTERACTION_LIMITS.keywords, `${path}.keywords`, issues,
      (entry, entryPath) => boundedString(entry, 60, entryPath, issues));
  }
  if (value.icon !== undefined) result.icon = pattern(value.icon, ICON, `${path}.icon`, issues);
  if (value.args !== undefined) result.args = args(value.args, `${path}.args`, issues);
  if (value.run !== undefined) result.run = commandRun(value.run, `${path}.run`, issues);
  return result as Partial<ChatCommandData>;
}

function command(value: unknown, path: string, issues: Issues): ChatCommandData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['id', ...COMMAND_FIELDS], path, issues);
  const id = pattern(value.id, CHAT_COMMAND_ID_PATTERN, `${path}.id`, issues);
  const fields = commandFields(value, path, issues);
  if (value.label === undefined) fail(issues, `${path}.label`, 'required');
  if (value.run === undefined) fail(issues, `${path}.run`, 'required');
  if (id === undefined || fields.label === undefined || fields.run === undefined) return undefined;
  return { id, ...fields } as ChatCommandData;
}

function search(value: unknown, path: string, issues: Issues): ChatEntitySearchData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['tool', 'path', 'queryParam', 'itemsPath', 'idField', 'labelField', 'descriptionField', 'limitParam'], path, issues);
  const tool = pattern(value.tool, CHAT_COMMAND_TOOL_PATTERN, `${path}.tool`, issues);
  const route = typeof value.path === 'string' && value.path.startsWith('/') && !value.path.startsWith('//')
    && value.path.length <= 512 && !/[?#\\:\s]/.test(value.path)
    && !value.path.split('/').some((segment) => segment === '.' || segment === '..')
    ? value.path
    : fail(issues, `${path}.path`, 'an app-internal path without parameters');
  const field = (key: string) => pattern(value[key], FIELD, `${path}.${key}`, issues);
  const queryParam = field('queryParam');
  const idField = field('idField');
  const labelField = field('labelField');
  const descriptionField = value.descriptionField === undefined ? undefined : field('descriptionField');
  const limitParam = value.limitParam === undefined ? undefined : field('limitParam');
  const itemsPath = list(value.itemsPath, 4, `${path}.itemsPath`, issues,
    (entry, entryPath) => pattern(entry, FIELD, entryPath, issues));
  if (!tool || !route || !queryParam || !idField || !labelField || !itemsPath) return undefined;
  return {
    tool, path: route, queryParam, itemsPath, idField, labelField,
    ...(descriptionField ? { descriptionField } : {}),
    ...(limitParam ? { limitParam } : {}),
  };
}

const ACTION_FIELDS = ['label', 'entityArg', 'args', 'run'] as const;

function actionFields(value: Record<string, unknown>, path: string, issues: Issues): Partial<ChatEntityActionData> {
  const result: Record<string, unknown> = {};
  if (value.label !== undefined) result.label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  if (value.entityArg !== undefined) {
    result.entityArg = isChatArgumentPath(value.entityArg)
      ? value.entityArg
      : fail(issues, `${path}.entityArg`, 'a dotted argument path');
  }
  if (value.args !== undefined) result.args = args(value.args, `${path}.args`, issues);
  if (value.run !== undefined) result.run = toolRun(value.run, `${path}.run`, issues);
  return result as Partial<ChatEntityActionData>;
}

function action(value: unknown, path: string, issues: Issues): ChatEntityActionData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['id', ...ACTION_FIELDS], path, issues);
  const id = pattern(value.id, CHAT_COMMAND_ID_PATTERN, `${path}.id`, issues);
  const fields = actionFields(value, path, issues);
  for (const key of ['label', 'entityArg', 'run'] as const) {
    if (value[key] === undefined) fail(issues, `${path}.${key}`, 'required');
  }
  if (!id || fields.label === undefined || fields.entityArg === undefined || fields.run === undefined) return undefined;
  return { id, ...fields } as ChatEntityActionData;
}

function uniqueBy<T>(entries: ReadonlyArray<T>, key: (entry: T) => string, path: string, issues: Issues): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = key(entry);
    if (seen.has(value)) issues.push(`${path}: duplicate ${value}`);
    seen.add(value);
  }
}

function entity(value: unknown, path: string, issues: Issues): ChatEntityData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['type', 'label', 'icon', 'search', 'actions'], path, issues);
  const type = pattern(value.type, CHAT_ENTITY_TYPE_PATTERN, `${path}.type`, issues);
  const label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  const icon = value.icon === undefined ? undefined : pattern(value.icon, ICON, `${path}.icon`, issues);
  const parsedSearch = value.search === undefined ? undefined : search(value.search, `${path}.search`, issues);
  const actions = value.actions === undefined
    ? undefined
    : list(value.actions, CHAT_INTERACTION_LIMITS.actionsPerEntity, `${path}.actions`, issues,
      (entry, entryPath) => action(entry, entryPath, issues));
  if (actions) uniqueBy(actions, (entry) => entry.id, `${path}.actions`, issues);
  if (!type || label === undefined) return undefined;
  return {
    type, label,
    ...(icon ? { icon } : {}),
    ...(parsedSearch ? { search: parsedSearch } : {}),
    ...(actions ? { actions } : {}),
  };
}

/** Validates interaction data strictly; throws `ChatInteractionsError` listing every issue. */
export function parseChatInteractions(value: unknown): ChatInteractionsData {
  const issues: Issues = [];
  if (!isRecord(value)) throw new ChatInteractionsError(['$: an object']);
  checkKeys(value, ['schemaVersion', 'entities', 'commands'], '$', issues);
  if (value.schemaVersion !== 1) issues.push('$.schemaVersion: must be 1');
  const entities = list(value.entities, CHAT_INTERACTION_LIMITS.entities, '$.entities', issues,
    (entry, path) => entity(entry, path, issues)) ?? [];
  const commands = list(value.commands, CHAT_INTERACTION_LIMITS.commands, '$.commands', issues,
    (entry, path) => command(entry, path, issues)) ?? [];
  uniqueBy(entities, (entry) => entry.type, '$.entities', issues);
  uniqueBy(commands, (entry) => entry.id, '$.commands', issues);
  if (issues.length > 0) throw new ChatInteractionsError(issues);
  return { schemaVersion: 1, entities, commands };
}

function overrideMap<T>(
  value: unknown,
  path: string,
  keyPattern: RegExp,
  issues: Issues,
  entry: (value: Record<string, unknown>, path: string) => T,
): Record<string, T> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail(issues, path, 'an object');
  const result: Record<string, T> = {};
  for (const [key, patch] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      issues.push(`${path}.${key}: invalid key`);
      continue;
    }
    if (!isRecord(patch)) {
      issues.push(`${path}.${key}: an object`);
      continue;
    }
    if (patch.hidden !== undefined && typeof patch.hidden !== 'boolean') issues.push(`${path}.${key}.hidden: a boolean`);
    result[key] = entry(patch, `${path}.${key}`);
  }
  return result;
}

/** Validates `.glirastes/chat-interactions.json`; throws `ChatInteractionsError`. */
export function parseChatInteractionOverrides(value: unknown): ChatInteractionOverrides {
  const issues: Issues = [];
  if (!isRecord(value)) throw new ChatInteractionsError(['$: an object']);
  checkKeys(value, ['schemaVersion', 'entities', 'commands'], '$', issues);
  if (value.schemaVersion !== 1) issues.push('$.schemaVersion: must be 1');
  const commands = overrideMap(value.commands, '$.commands', CHAT_COMMAND_ID_PATTERN, issues, (patch, path) => {
    checkKeys(patch, ['hidden', ...COMMAND_FIELDS], path, issues);
    return { ...(patch.hidden === true ? { hidden: true } : {}), ...commandFields(patch, path, issues) };
  });
  const entities = overrideMap(value.entities, '$.entities', CHAT_ENTITY_TYPE_PATTERN, issues, (patch, path) => {
    checkKeys(patch, ['hidden', 'label', 'icon', 'search', 'actions'], path, issues);
    const result: Record<string, unknown> = patch.hidden === true ? { hidden: true } : {};
    if (patch.label !== undefined) result.label = text(patch.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
    if (patch.icon !== undefined) result.icon = pattern(patch.icon, ICON, `${path}.icon`, issues);
    if (patch.search !== undefined) result.search = search(patch.search, `${path}.search`, issues);
    const actions = overrideMap(patch.actions, `${path}.actions`, CHAT_COMMAND_ID_PATTERN, issues, (actionPatch, actionPath) => {
      checkKeys(actionPatch, ['hidden', ...ACTION_FIELDS], actionPath, issues);
      return { ...(actionPatch.hidden === true ? { hidden: true } : {}), ...actionFields(actionPatch, actionPath, issues) };
    });
    if (actions) result.actions = actions;
    return result as ChatEntityOverride;
  });
  if (issues.length > 0) throw new ChatInteractionsError(issues);
  return {
    schemaVersion: 1,
    ...(entities ? { entities } : {}),
    ...(commands ? { commands } : {}),
  };
}

function withoutHidden<T extends { hidden?: boolean }>(patch: T): Omit<T, 'hidden'> {
  const { hidden: _hidden, ...rest } = patch;
  return rest;
}

/**
 * Applies overrides to derived data: a patch replaces the fields it names,
 * `hidden: true` removes the entry, and a complete entry under a new id or
 * type is added. The result is validated again.
 */
export function mergeChatInteractions(
  base: ChatInteractionsData,
  overrides: ChatInteractionOverrides | undefined,
): ChatInteractionsData {
  if (!overrides) return parseChatInteractions(base);
  const commandPatches = overrides.commands ?? {};
  const commands: unknown[] = base.commands
    .filter((entry) => commandPatches[entry.id]?.hidden !== true)
    .map((entry) => ({ ...entry, ...withoutHidden(commandPatches[entry.id] ?? {}) }));
  const known = new Set(base.commands.map((entry) => entry.id));
  for (const [id, patch] of Object.entries(commandPatches)) {
    if (!known.has(id) && patch.hidden !== true) commands.push({ id, ...withoutHidden(patch) });
  }
  const entityPatches = overrides.entities ?? {};
  const mergeActions = (
    actions: ReadonlyArray<ChatEntityActionData>,
    patches: Readonly<Record<string, ChatEntityActionOverride>>,
  ) => {
    const merged: unknown[] = actions
      .filter((entry) => patches[entry.id]?.hidden !== true)
      .map((entry) => ({ ...entry, ...withoutHidden(patches[entry.id] ?? {}) }));
    const ids = new Set(actions.map((entry) => entry.id));
    for (const [id, patch] of Object.entries(patches)) {
      if (!ids.has(id) && patch.hidden !== true) merged.push({ id, ...withoutHidden(patch) });
    }
    return merged;
  };
  const entities: unknown[] = base.entities
    .filter((entry) => entityPatches[entry.type]?.hidden !== true)
    .map((entry) => {
      const patch = entityPatches[entry.type];
      if (!patch) return entry;
      const { actions: actionPatches, ...fields } = withoutHidden(patch);
      const { actions: current, ...rest } = entry;
      const actions = mergeActions(current ?? [], actionPatches ?? {});
      return { ...rest, ...fields, ...(actions.length > 0 ? { actions } : {}) };
    });
  const types = new Set(base.entities.map((entry) => entry.type));
  for (const [type, patch] of Object.entries(entityPatches)) {
    if (types.has(type) || patch.hidden === true) continue;
    const { actions: actionPatches, ...fields } = withoutHidden(patch);
    const actions = mergeActions([], actionPatches ?? {});
    entities.push({ type, ...fields, ...(actions.length > 0 ? { actions } : {}) });
  }
  return parseChatInteractions({ schemaVersion: 1, entities, commands });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/contracts/__tests__/chat-interactions.test.ts --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  11 passed (11)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/contracts/__tests__/chat-interactions.test.ts src/contracts/chat-interactions.ts
git commit -m "feat(contracts): add declarative chat entities, commands and overrides"
```

### Task 3: Derive entities, actions and commands from the tool catalog

**Files:**
- Create: `src/codegen/tools/chat-interactions.ts` (new file; no pipeline, CLI or config change)
- Test: `src/codegen/tools/chat-interactions.test.ts` (Create)

**Interfaces:**
- Consumes: Task 2 data model and `parseChatInteractions` (also per entry, so Task 1's id patterns apply); `AppSetupArtifact` (enabled tools, method, path) and P03/P04 `ToolContractsEntry` (`contract.input`, `contract.output`, `contract.params`, `contract.uiAction`); `compareCodeUnits` from `canonical.ts`.
- Produces: `deriveChatInteractions({ artifact, contracts }): ChatInteractionsData` (pure, sorted, bounded, validated) and `humanizeIdentifier(value)`. Command ids: `open.<segments>` (`open.home` for `/`), `filter.<view>`, `<actionId>` (the definition id without `ui.`); entity action ids `<type>.<definitionId>` and `<type>.open`. Labels: English and German defaults (`Open X`/`X öffnen`, `Filter X`/`X filtern`, verbs `get`, `check`, `update`, `delete`, `complete`, `archive`, `assign`, `close`, `reopen` translated, otherwise humanized, the raw identifier when humanizing leaves nothing). Robustness: every derived entity, action and command is checked on its own (`carries`); one the protocol cannot carry (an unusual parameter name, a nested key with a space, an oversized fixed argument) is dropped alone, a blank enum choice (`z.enum(['', 'open'])`) only loses that choice, and a choice with control characters drops the closed set. App code can therefore never make `renderGeneratedModule` (and with it `tools refresh`) throw through the interactions.

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/chat-interactions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { deriveChatInteractions, humanizeIdentifier } from './chat-interactions.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry } from './types.js';

const digest = (character: string) => `sha256:${character.repeat(43)}`;
const id = (index: number) => `019fb700-0000-7000-8000-${String(index).padStart(12, '0')}`;
const STRING = { type: 'string' };

interface Spec {
  name: string;
  method?: 'GET' | 'POST' | 'PATCH';
  path?: string;
  enabled?: boolean;
  input: JsonSchemaLike;
  output?: JsonSchemaLike;
  params?: ToolContract['params'];
  uiAction?: ToolContract['uiAction'];
}

const object = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: props, required, additionalProperties: false,
});

const SPECS: Spec[] = [
  {
    name: 'tasks.list', method: 'GET', path: '/api/tasks',
    input: object({ search: STRING, status: { type: 'string', enum: ['done', 'open'] }, limit: STRING }),
    output: object({ tasks: { type: 'array', items: object({ id: STRING, title: STRING, status: STRING }) } }),
    params: { path: [], query: ['limit', 'search', 'status'], body: [] },
  },
  {
    name: 'people.list', method: 'GET', path: '/api/people',
    input: object({ q: STRING }),
    output: { type: 'array', items: object({ id: STRING, name: STRING, email: STRING }) },
    params: { path: [], query: ['q'], body: [] },
  },
  {
    name: 'reports.list', method: 'GET', path: '/api/reports',
    input: object({ year: STRING }),
    output: object({ reports: { type: 'array', items: object({ id: STRING, title: STRING }) } }),
    params: { path: [], query: ['year'], body: [] },
  },
  {
    name: 'tasks.complete', method: 'POST', path: '/api/tasks/:taskId/complete',
    input: object({ taskId: STRING }, ['taskId']), params: { path: ['taskId'], query: [], body: [] },
  },
  {
    name: 'tasks.assign', method: 'POST', path: '/api/tasks/:id/assign',
    input: object({ id: STRING, personId: STRING }, ['id', 'personId']), params: { path: ['id'], query: [], body: ['personId'] },
  },
  {
    name: 'tasks.update', method: 'PATCH', path: '/api/tasks/:id',
    input: object({ id: STRING, title: STRING, priority: { type: 'number' }, labels: { type: 'object' } }, ['id']),
    params: { path: ['id'], query: [], body: ['labels', 'priority', 'title'] },
  },
  {
    name: 'tasks.move', method: 'POST', path: '/api/tasks/:id/move',
    input: object({ id: STRING, target: { type: 'object' } }, ['id', 'target']), params: { path: ['id'], query: [], body: ['target'] },
  },
  {
    name: 'tasks.archive', method: 'POST', path: '/api/tasks/:id/archive', enabled: false,
    input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
  },
  {
    name: 'ui.navigate',
    input: object({
      destination: { type: 'string', enum: ['/', '/overview', '/tasks', '/tasks/:taskId', '/projects/:projectId/board'] },
      params: object({ projectId: STRING, taskId: STRING }),
    }, ['destination']),
    uiAction: { kind: 'navigate' },
  },
  {
    name: 'ui.filter.tasks',
    input: object({
      status: { type: 'string', enum: ['done', 'open'] },
      labels: { type: 'array', items: { type: 'string', enum: ['bug', 'idea'] } },
      page: { type: 'number' },
    }),
    uiAction: { kind: 'filter', destination: '/tasks', keys: [{ key: 'labels', array: 'comma' }, { key: 'page' }, { key: 'status' }] },
  },
  {
    name: 'ui.tasks.highlight',
    input: object({ title: STRING }, ['title']),
    uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
  },
];

function catalog(specs: ReadonlyArray<Spec>) {
  const artifact = AppSetupArtifactSchema.parse({
    schemaVersion: 1, artifactId: id(9001), runId: id(9002), appId: id(9003), discoveryDigest: digest('D'),
    assessmentMode: 'autonomous', status: 'ready',
    tools: specs.map((spec, index) => ({
      toolId: id(index + 1), sourceFingerprint: digest('F'), name: spec.name, description: `Run ${spec.name}.`,
      modelName: spec.name.replace(/\./g, '_'),
      executionKind: spec.uiAction ? 'ui' : 'endpoint',
      ...(spec.uiAction ? { actionBindingRef: 'glirastes.navigate' } : { method: spec.method, path: spec.path }),
      allowedRoles: [], operationGroup: spec.uiAction ? 'ui' : spec.method === 'GET' ? 'read' : 'update',
      riskClass: spec.uiAction || spec.method === 'GET' ? 'safe-read' : 'write', enabled: spec.enabled ?? true,
      requiresApproval: !spec.uiAction && spec.method !== 'GET', inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
    })),
    planner: { plannerId: id(9004), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [] },
    prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
    warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
  });
  const contracts: ToolContractsEntry[] = specs.map((spec, index) => ({
    toolId: id(index + 1), stableKey: spec.uiAction ? `UI ${spec.name}` : `${spec.method} ${spec.path}`, definitionId: spec.name,
    defaults: { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    contract: {
      source: spec.uiAction ? 'ui-bridge' : 'native', loadBearing: true, input: spec.input,
      ...(spec.output ? { output: spec.output } : {}),
      params: spec.params ?? { path: [], query: [], body: [] }, interfaceDigest: digest('N'),
      runtime: { input: { kind: 'json', schema: spec.input }, output: { kind: 'json', schema: spec.output ?? {} } },
      ...(spec.uiAction ? { uiAction: spec.uiAction } : {}),
    },
  }));
  return { artifact, contracts };
}

describe('deriveChatInteractions', () => {
  it('derives searchable entities, their actions and the UI commands from the catalog', () => {
    expect(deriveChatInteractions(catalog(SPECS))).toEqual({
      schemaVersion: 1,
      entities: [
        {
          type: 'person',
          label: { en: 'Person', de: 'Person' },
          search: {
            tool: 'people.list', path: '/api/people', queryParam: 'q', itemsPath: [],
            idField: 'id', labelField: 'name', descriptionField: 'email',
          },
        },
        {
          type: 'task',
          label: { en: 'Task', de: 'Task' },
          search: {
            tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'],
            idField: 'id', labelField: 'title', descriptionField: 'status', limitParam: 'limit',
          },
          actions: [
            { id: 'task.open', label: { en: 'Open', de: 'Öffnen' }, entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
            {
              id: 'task.tasks.assign', label: { en: 'Assign', de: 'Zuweisen' }, entityArg: 'id',
              args: [{ name: 'personId', label: 'Person id', required: true, entity: 'person' }],
              run: { kind: 'tool', tool: 'tasks.assign' },
            },
            { id: 'task.tasks.complete', label: { en: 'Complete', de: 'Erledigen' }, entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
            {
              id: 'task.tasks.update', label: { en: 'Edit', de: 'Bearbeiten' }, entityArg: 'id',
              args: [{ name: 'title', label: 'Title' }],
              run: { kind: 'tool', tool: 'tasks.update' },
            },
          ],
        },
      ],
      commands: [
        {
          id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
          args: [{ name: 'labels', label: 'Labels', options: ['bug', 'idea'] }, { name: 'status', label: 'Status', options: ['done', 'open'] }],
          run: { kind: 'ui', tool: 'ui.filter.tasks' },
        },
        { id: 'open.home', label: { en: 'Open Home', de: 'Startseite öffnen' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/' } } },
        { id: 'open.overview', label: { en: 'Open Overview', de: 'Overview öffnen' }, keywords: ['overview'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
        { id: 'open.tasks', label: { en: 'Open Tasks', de: 'Tasks öffnen' }, keywords: ['tasks'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } },
        {
          id: 'tasks.highlight', label: { en: 'Tasks highlight', de: 'Tasks highlight' },
          args: [{ name: 'title', label: 'Title', required: true }],
          run: { kind: 'ui', tool: 'ui.tasks.highlight' },
        },
      ],
    });
  });

  it('is a pure function of the catalog, whatever the input order', () => {
    const forward = deriveChatInteractions(catalog(SPECS));
    expect(deriveChatInteractions(catalog([...SPECS].reverse()))).toEqual(forward);
  });

  it('derives nothing from disabled tools or tools without a contract', () => {
    const { artifact, contracts } = catalog(SPECS);
    const withoutContracts = contracts.map((entry) => ({ ...entry, contract: null }));
    expect(deriveChatInteractions({ artifact, contracts: withoutContracts })).toEqual({ schemaVersion: 1, entities: [], commands: [] });
    const disabled = AppSetupArtifactSchema.parse({ ...artifact, tools: artifact.tools.map((tool) => ({ ...tool, enabled: false })) });
    expect(deriveChatInteractions({ artifact: disabled, contracts })).toEqual({ schemaVersion: 1, entities: [], commands: [] });
  });

  it('keeps one entity per type and skips ids it cannot express', () => {
    const duplicate: Spec = {
      ...SPECS[0]!, name: 'admin.tasks.list', path: '/api/admin/tasks',
    };
    const longName = `tasks.${'x'.repeat(190)}`;
    const derived = deriveChatInteractions(catalog([
      SPECS[0]!, duplicate,
      { ...SPECS[3]!, path: '/api/admin/tasks/:taskId/complete' },
      { ...SPECS[3]!, name: longName, path: '/api/admin/tasks/:taskId/x' },
    ]));
    expect(derived.entities.map((entity) => entity.search!.tool)).toEqual(['admin.tasks.list']);
    expect(derived.entities[0]!.actions!.map((action) => action.id)).toEqual(['task.tasks.complete']);
  });

  it('drops only what the chat cannot carry and never fails the refresh', () => {
    const derived = deriveChatInteractions(catalog([
      {
        name: 'ui.filter.tasks',
        input: object({ status: { type: 'string', enum: ['', 'open'] }, _: STRING }),
        uiAction: { kind: 'filter', destination: '/tasks', keys: [{ key: '_' }, { key: 'status' }] },
      },
      {
        name: 'ui.notes.pin',
        input: object({ params: object({ 'note id': STRING }) }),
        uiAction: { kind: 'client-action', actionId: 'notes.pin' },
      },
    ]));
    expect(derived.commands).toEqual([{
      id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
      args: [{ name: '_', label: '_' }, { name: 'status', label: 'Status', options: ['open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    }]);
  });

  it('humanizes identifiers for default labels', () => {
    expect(humanizeIdentifier('myTasks')).toBe('My tasks');
    expect(humanizeIdentifier('team-members')).toBe('Team members');
    expect(humanizeIdentifier('tasks.highlight')).toBe('Tasks highlight');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/codegen/tools/chat-interactions.test.ts --maxWorkers=4
```

Expected: FAIL — `Cannot find module './chat-interactions.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

Create `src/codegen/tools/chat-interactions.ts`:

```ts
import {
  CHAT_ENTITY_TYPE_PATTERN,
  CHAT_INTERACTION_LIMITS,
  parseChatInteractions,
  type ChatCommandData,
  type ChatEntityActionData,
  type ChatEntityData,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatText,
} from '../../contracts/chat-interactions.js';
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits } from './canonical.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry } from './types.js';

export interface DeriveChatInteractionsInput {
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
}

interface BoundTool {
  definitionId: string;
  method?: string;
  path?: string;
  contract: ToolContract;
}

/** Query parameters that make a read endpoint an entity search, best first. */
const SEARCH_PARAMS = ['search', 'q', 'query', 'term'];
const LIMIT_PARAMS = ['limit', 'pageSize'];
const LABEL_FIELDS = ['title', 'name', 'displayName', 'label', 'subject', 'email'];
const DESCRIPTION_FIELDS = ['description', 'email', 'status', 'subtitle', 'summary'];
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const CONTROL = /[\u0000-\u001F]/;
const VERBS: Record<string, { en: string; de: string }> = {
  get: { en: 'Show', de: 'Anzeigen' },
  check: { en: 'Check', de: 'Prüfen' },
  update: { en: 'Edit', de: 'Bearbeiten' },
  delete: { en: 'Delete', de: 'Löschen' },
  complete: { en: 'Complete', de: 'Erledigen' },
  archive: { en: 'Archive', de: 'Archivieren' },
  assign: { en: 'Assign', de: 'Zuweisen' },
  close: { en: 'Close', de: 'Schließen' },
  reopen: { en: 'Reopen', de: 'Wieder öffnen' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number = CHAT_INTERACTION_LIMITS.labelLength): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `my-tasks`, `myTasks`, `my_tasks` → `My tasks`. */
export function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const text = words.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : '';
}

const IRREGULAR: Record<string, string> = { people: 'person', children: 'child', men: 'man', women: 'woman' };

/** `tasks` → `task`, `categories` → `category`, `people` → `person`. */
function singular(segment: string): string {
  const irregular = IRREGULAR[segment.toLowerCase()];
  if (irregular) return irregular;
  if (/ies$/i.test(segment)) return `${segment.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/i.test(segment)) return segment;
  if (/(?:sses|xes|ches|shes)$/i.test(segment)) return segment.slice(0, -2);
  if (/s$/i.test(segment)) return segment.slice(0, -1);
  return segment;
}

function entityType(segment: string): string | undefined {
  const type = singular(segment).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return CHAT_ENTITY_TYPE_PATTERN.test(type) ? type : undefined;
}

function idSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function staticSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment && !segment.startsWith(':'));
}

function properties(schema: JsonSchemaLike | undefined): Record<string, JsonSchemaLike> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties as Record<string, JsonSchemaLike> : {};
}

function requiredKeys(schema: JsonSchemaLike | undefined): Set<string> {
  return new Set(isRecord(schema) && Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : []);
}

function stringOptions(schema: JsonSchemaLike | undefined): string[] | undefined {
  const candidate = isRecord(schema) && schema.type === 'array' && isRecord(schema.items) ? schema.items : schema;
  if (!isRecord(candidate) || !Array.isArray(candidate.enum)) return undefined;
  if (!candidate.enum.every((value) => typeof value === 'string')) return undefined;
  // A blank choice is the empty field; a choice the list cannot show drops the closed set.
  const values = (candidate.enum as string[]).filter((value) => value.trim().length > 0);
  return values.length > 0 && values.every((value) => value.length <= 100 && !CONTROL.test(value))
    ? values.slice(0, CHAT_INTERACTION_LIMITS.options)
    : undefined;
}

/** A value the argument form can type: a string, a string enum, or an array of string enums. */
function isStringInput(schema: JsonSchemaLike | undefined): boolean {
  if (!isRecord(schema)) return false;
  if (stringOptions(schema)) return true;
  return schema.type === 'string';
}

function argFor(
  name: string,
  schema: JsonSchemaLike | undefined,
  required: boolean,
  entityOf: (name: string) => string | undefined,
): ChatInteractionArg {
  const options = stringOptions(schema);
  const entity = options ? undefined : entityOf(name);
  const last = name.split('.').at(-1)!;
  return {
    name,
    label: clamp(humanizeIdentifier(last) || last),
    ...(required ? { required: true } : {}),
    ...(entity ? { entity } : {}),
    ...(options ? { options } : {}),
  };
}

/**
 * Arguments the user fills in for a tool, or `undefined` when a required
 * value cannot be typed in the chat (objects, numbers, booleans).
 */
function argsFor(
  input: JsonSchemaLike,
  skip: ReadonlySet<string>,
  entityOf: (name: string) => string | undefined,
): ChatInteractionArg[] | undefined {
  const required = requiredKeys(input);
  const result: ChatInteractionArg[] = [];
  for (const [name, schema] of Object.entries(properties(input)).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (skip.has(name)) continue;
    if (name === 'params' && isRecord(schema)) {
      const nestedRequired = requiredKeys(schema);
      for (const [param, paramSchema] of Object.entries(properties(schema))) {
        if (!isStringInput(paramSchema)) return undefined;
        result.push(argFor(`params.${param}`, paramSchema, required.has('params') || nestedRequired.has(param), entityOf));
      }
      continue;
    }
    if (!FIELD.test(name)) {
      if (required.has(name)) return undefined;
      continue;
    }
    if (!isStringInput(schema)) {
      if (required.has(name)) return undefined;
      continue;
    }
    result.push(argFor(name, schema, required.has(name), entityOf));
  }
  return result.length > CHAT_INTERACTION_LIMITS.args ? undefined : result;
}

function navigationTitle(path: string): { en: string; de: string } {
  const segments = staticSegments(path);
  if (segments.length === 0) return { en: 'Home', de: 'Startseite' };
  const title = humanizeIdentifier(segments.join(' '));
  return { en: title, de: title };
}

/** The trailing path segment (`/:id/pin` → `pin`), else the verb of the definition id (`tasks.update` → `update`). */
function verbLabel(definitionId: string, trailingSegment: string | undefined): ChatText {
  const verb = trailingSegment ?? definitionId.split('.').at(-1)!;
  const known = VERBS[verb];
  if (known) return known;
  const text = clamp(humanizeIdentifier(verb) || verb);
  return { en: text, de: text };
}

/**
 * True when the entries pass the strict check on their own: an identifier
 * the protocol cannot carry drops its entry, never the whole refresh.
 */
function carries(entities: ReadonlyArray<ChatEntityData>, commands: ReadonlyArray<ChatCommandData>): boolean {
  try {
    parseChatInteractions({ schemaVersion: 1, entities, commands });
    return true;
  } catch {
    return false;
  }
}

interface SearchCandidate {
  type: string;
  entity: ChatEntityData;
}

/** A read endpoint with a search parameter whose output is a list of objects with an id and a label. */
function searchEntity(tool: BoundTool): SearchCandidate | undefined {
  if ((tool.method !== 'GET' && tool.method !== 'HEAD') || !tool.path || tool.path.includes(':')) return undefined;
  const query = new Set(tool.contract.params.query);
  const queryParam = SEARCH_PARAMS.find((name) => query.has(name));
  if (!queryParam) return undefined;
  const segments = staticSegments(tool.path);
  const type = entityType(segments.at(-1) ?? '');
  if (!type) return undefined;
  const output = tool.contract.output;
  let itemsPath: string[] | undefined;
  let items: JsonSchemaLike | undefined;
  if (isRecord(output) && output.type === 'array') {
    itemsPath = [];
    items = output.items as JsonSchemaLike | undefined;
  } else {
    const lists = Object.entries(properties(output))
      .filter(([name, schema]) => FIELD.test(name) && isRecord(schema) && schema.type === 'array' && isRecord(schema.items));
    const preferred = lists.find(([name]) => name === segments.at(-1)) ?? (lists.length === 1 ? lists[0] : undefined);
    if (preferred) {
      itemsPath = [preferred[0]];
      items = (preferred[1] as Record<string, unknown>).items as JsonSchemaLike;
    }
  }
  const fields = properties(items);
  const isText = (name: string) => isRecord(fields[name]) && (fields[name] as Record<string, unknown>).type === 'string';
  const idField = ['id', 'uuid', `${type}Id`].find((name) => isRecord(fields[name]));
  const labelField = LABEL_FIELDS.find((name) => name !== idField && isText(name));
  if (!itemsPath || !idField || !labelField) return undefined;
  const descriptionField = DESCRIPTION_FIELDS.find((name) => name !== labelField && isText(name));
  const limitParam = LIMIT_PARAMS.find((name) => query.has(name));
  const label = clamp(humanizeIdentifier(type));
  const entity: ChatEntityData = {
    type,
    label: { en: label, de: label },
    search: {
      tool: tool.definitionId,
      path: tool.path,
      queryParam,
      itemsPath,
      idField,
      labelField,
      ...(descriptionField ? { descriptionField } : {}),
      ...(limitParam ? { limitParam } : {}),
    },
  };
  return carries([entity], []) ? { type, entity } : undefined;
}

/**
 * Derives the chat's `@` entities and `/` commands from the enabled tools,
 * a pure function of the setup artifact and the tool contracts:
 *
 * - entities from read endpoints with a search parameter (`search`, `q`,
 *   `query`, `term`) whose output lists objects with an id and a label;
 * - entity actions from endpoints with exactly one path parameter below the
 *   entity's collection (`PATCH /api/tasks/:id`), and "Open" from pages with
 *   one parameter of the entity (`/tasks/:taskId`);
 * - commands from navigation (one per page without parameters), URL
 *   filters and client actions.
 *
 * Labels are English and German defaults from identifiers; overrides and
 * skills replace them. Bounded and sorted, so the module stays byte-stable;
 * an entry the protocol cannot carry is dropped alone, so app code never
 * makes the generated module (and `tools refresh`) fail here.
 */
export function deriveChatInteractions(input: DeriveChatInteractionsInput): ChatInteractionsData {
  const contracts = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools: BoundTool[] = input.artifact.tools
    .filter((tool) => tool.enabled)
    .flatMap((tool) => {
      const contract = contracts.get(tool.toolId)?.contract;
      return contract ? [{ definitionId: tool.name, method: tool.method, path: tool.path, contract }] : [];
    })
    .sort((left, right) => compareCodeUnits(left.definitionId, right.definitionId));

  const searches = new Map<string, SearchCandidate>();
  for (const candidate of tools
    .map(searchEntity)
    .filter((entry): entry is SearchCandidate => entry !== undefined)
    .sort((left, right) => compareCodeUnits(left.entity.search!.path, right.entity.search!.path))) {
    if (!searches.has(candidate.type)) searches.set(candidate.type, candidate);
  }
  const entityOf = (name: string): string | undefined => {
    const match = /^(?:params\.)?([A-Za-z][A-Za-z0-9]*?)(?:Id|_id)$/.exec(name);
    const type = match ? entityType(match[1]!) : undefined;
    return type && searches.has(type) ? type : undefined;
  };

  const actions = new Map<string, ChatEntityActionData[]>();
  const addAction = (type: string, action: ChatEntityActionData) => {
    if (!carries([{ type, label: type, actions: [action] }], [])) return;
    const list = actions.get(type) ?? [];
    if (!list.some((entry) => entry.id === action.id)) list.push(action);
    actions.set(type, list);
  };
  for (const { type, entity } of searches.values()) {
    const collection = entity.search!.path;
    for (const tool of tools) {
      if (!tool.path || tool.contract.uiAction) continue;
      const match = new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/:([A-Za-z_][A-Za-z0-9_]*)(?:/([A-Za-z0-9_-]+))?$`)
        .exec(tool.path);
      if (!match || tool.contract.params.path.length !== 1) continue;
      const entityArg = match[1]!;
      const args = argsFor(tool.contract.input, new Set([entityArg]), entityOf);
      if (!args) continue;
      addAction(type, {
        id: `${type}.${tool.definitionId}`,
        label: verbLabel(tool.definitionId, match[2]),
        entityArg,
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'tool', tool: tool.definitionId },
      });
    }
  }

  const commands: ChatCommandData[] = [];
  const commandIds = new Set<string>();
  const addCommand = (command: ChatCommandData) => {
    if (commandIds.has(command.id) || !carries([], [command])) return;
    commandIds.add(command.id);
    commands.push(command);
  };
  for (const tool of tools) {
    const action = tool.contract.uiAction;
    if (!action) continue;
    if (action.kind === 'navigate') {
      const destination = properties(tool.contract.input).destination;
      const paths = isRecord(destination) && Array.isArray(destination.enum)
        ? destination.enum.filter((value): value is string => typeof value === 'string')
        : [];
      for (const path of paths) {
        const params = path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
        if (params.length === 0) {
          const title = navigationTitle(path);
          const segments = staticSegments(path);
          addCommand({
            id: `open.${segments.length > 0 ? segments.map(idSegment).join('.') : 'home'}`,
            label: { en: clamp(`Open ${title.en}`), de: clamp(`${title.de} öffnen`) },
            ...(segments.length > 0 ? { keywords: segments.slice(0, CHAT_INTERACTION_LIMITS.keywords).map((segment) => clamp(segment, 60)) } : {}),
            run: { kind: 'ui', tool: tool.definitionId, args: { destination: path } },
          });
          continue;
        }
        if (params.length !== 1) continue;
        const segments = path.split('/');
        const index = segments.indexOf(`:${params[0]}`);
        const type = entityOf(params[0]!) ?? (params[0] === 'id' && index > 0 ? entityType(segments[index - 1]!) : undefined);
        if (!type || !searches.has(type)) continue;
        addAction(type, {
          id: `${type}.open`,
          label: { en: 'Open', de: 'Öffnen' },
          entityArg: `params.${params[0]}`,
          run: { kind: 'ui', tool: tool.definitionId, args: { destination: path } },
        });
      }
      continue;
    }
    const args = argsFor(tool.contract.input, new Set(), entityOf);
    if (!args) continue;
    if (action.kind === 'filter') {
      const view = tool.definitionId.replace(/^ui\.filter\./, '');
      const title = humanizeIdentifier(view);
      addCommand({
        id: `filter.${idSegment(view)}`,
        label: { en: clamp(`Filter ${title}`), de: clamp(`${title} filtern`) },
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'ui', tool: tool.definitionId },
      });
      continue;
    }
    const id = tool.definitionId.replace(/^ui\./, '');
    const label = clamp(humanizeIdentifier(id));
    addCommand({
      id,
      label: { en: label, de: label },
      ...(args.length > 0 ? { args } : {}),
      run: { kind: 'ui', tool: tool.definitionId },
    });
  }

  const entities = [...searches.values()]
    .map(({ type, entity }) => {
      const list = (actions.get(type) ?? [])
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .slice(0, CHAT_INTERACTION_LIMITS.actionsPerEntity);
      return list.length > 0 ? { ...entity, actions: list } : entity;
    })
    .sort((left, right) => compareCodeUnits(left.type, right.type))
    .slice(0, CHAT_INTERACTION_LIMITS.entities);
  return parseChatInteractions({
    schemaVersion: 1,
    entities,
    commands: commands
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .slice(0, CHAT_INTERACTION_LIMITS.commands),
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/codegen/tools/chat-interactions.test.ts --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  6 passed (6)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/codegen/tools/chat-interactions.test.ts src/codegen/tools/chat-interactions.ts
git commit -m "feat(codegen): derive chat entities and commands from the tool catalog"
```

### Task 4: `chatInteractions` in the generated module

**Files:**
- Modify: `src/codegen/tools/emit-module.ts` (one import, one export after `toolCatalog`; shared with P05, see the merge table)
- Test: `src/codegen/tools/emit-module-chat.test.ts` (Create, kept apart from `emit-module.test.ts` to avoid merge conflicts), `tests/chat-interactions-next.test.ts` (Create; refreshes copies of the Next reference app)

**Interfaces:**
- Consumes: Task 3 `deriveChatInteractions`; `renderGeneratedModule({ modulePath, artifact, contracts })` stays a pure function of its input, so `tools check` (frozen) and `--integrity-only` re-render the new export byte for byte.
- Produces: `export const chatInteractions = {…}` (with `as const` in TypeScript modules) after `export const toolCatalog`, assignable to `ChatInteractionsData`. `tests/chat-interactions-next.test.ts` exports `NOTES_SCHEMAS`, `NOTES_ROUTE`, `PIN_ROUTE` and `addNotes(root)` (a searchable `GET /api/notes?search=` plus `POST /api/notes/[id]/pin`).
- Behaviour change: every app's generated module gains the export, so `tools check` reports drift once after the SDK upgrade until `tools refresh` runs (unpublished contract change, like P04 Task 6).

- [ ] **Step 1: Write the failing tests**

Create `src/codegen/tools/emit-module-chat.test.ts`:

```ts
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from './__tests__/app-fixture.js';
import { renderGeneratedModule } from './emit-module.js';
import type { ToolContract, ToolContractsEntry } from './types.js';

afterEach(removeAppFixtures);

const id = (suffix: string) => `019fb701-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const NAVIGATE = {
  type: 'object',
  properties: { destination: { type: 'string', enum: ['/overview', '/tasks'] } },
  required: ['destination'],
  additionalProperties: false,
};
const RESULT = { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] };

const artifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready',
  tools: [{
    toolId: id('c1'), sourceFingerprint: digest('N'), name: 'ui.navigate', description: 'Open a page.',
    modelName: 'ui_navigate', executionKind: 'ui', actionBindingRef: 'glirastes.navigate', allowedRoles: [],
    operationGroup: 'ui', riskClass: 'safe-read', enabled: true, requiresApproval: false,
    inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  }],
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('c1')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
});

const navigateContract: ToolContract = {
  source: 'ui-bridge', loadBearing: true, input: NAVIGATE, output: RESULT, params: { path: [], query: [], body: [] },
  interfaceDigest: digest('U'), runtime: { input: { kind: 'json', schema: NAVIGATE }, output: { kind: 'json', schema: RESULT } },
  uiAction: { kind: 'navigate' },
};

const contracts: ToolContractsEntry[] = [{
  toolId: id('c1'), stableKey: 'UI navigate', definitionId: 'ui.navigate',
  defaults: { operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
  contract: navigateContract,
}];

describe('chat interactions in the generated module', () => {
  it('emits the derived commands next to the tool catalog, byte-stable', () => {
    const input = { modulePath: 'src/generated/glirastes/tools.generated.js', artifact, contracts };
    const text = renderGeneratedModule(input);
    expect(renderGeneratedModule(input)).toBe(text);
    expect(text).toContain('export const chatInteractions = {');
    expect(text).toContain('"id": "open.overview"');
    expect(text).toContain('"destination": "/tasks"');
    expect(text.indexOf('export const chatInteractions')).toBeGreaterThan(text.indexOf('export const toolCatalog'));
  });

  it('emits empty interactions when no tool is enabled', () => {
    const disabled = AppSetupArtifactSchema.parse({ ...artifact, tools: [{ ...artifact.tools[0]!, enabled: false }] });
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: disabled, contracts });
    expect(text).toContain('export const chatInteractions = {\n  "commands": [],\n  "entities": [],\n  "schemaVersion": 1\n} as const;');
  });

  it('type-checks the readonly interactions against the shared data type', async () => {
    const generated = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts });
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
          paths: {
            'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
            'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
            'glirastes/chat-interactions': [join(SDK_ROOT, 'src/contracts/chat-interactions.ts')],
          },
        },
      }),
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import type { ChatInteractionsData } from 'glirastes/chat-interactions';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const data: ChatInteractionsData = generated.chatInteractions;\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
    const files = [app.path('src/consumer.ts'), app.path('src/generated/glirastes/tools.generated.ts')];
    const program = ts.createProgram(files, parsed.options);
    const diagnostics = files.flatMap((file) => program.getSemanticDiagnostics(program.getSourceFile(file)));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});
```

Create `tests/chat-interactions-next.test.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import type { ChatInteractionsData } from '../src/contracts/chat-interactions.js';
import { assertBuiltSdk, copyApp, GENERATED_MODULE, NATIVE_APP, removeCopiedApps } from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(removeCopiedApps);

export const NOTES_SCHEMAS = "import { z } from 'zod';\n\n"
  + 'export const listNotesInput = z.object({ search: z.string().optional() }).strict();\n'
  + 'export const listNotesOutput = z.object({\n'
  + '  notes: z.array(z.object({ id: z.string(), title: z.string() })),\n'
  + "}).describe('Search your notes by title.');\n"
  + 'export const pinNoteInput = z.object({ id: z.string().min(1) }).strict();\n'
  + "export const pinNoteOutput = z.object({ id: z.string(), pinned: z.boolean() }).describe('Pin one of your notes.');\n";

export const NOTES_ROUTE = "import { listNotesInput, listNotesOutput } from './schemas.js';\n"
  + "import { query } from '../../../query.js';\n\n"
  + "const notes = [{ id: 'n1', title: 'Release notes', owner: 'alice' }, { id: 'n2', title: 'Private', owner: 'bob' }];\n\n"
  + 'export async function GET(request) {\n'
  + '  return query(request, listNotesInput, listNotesOutput, (input, principal) => ({\n'
  + '    notes: notes\n'
  + '      .filter((note) => note.owner === principal.subjectId && (!input.search || note.title.toLowerCase().includes(input.search.toLowerCase())))\n'
  + '      .map(({ id, title }) => ({ id, title })),\n'
  + '  }));\n}\n';

export const PIN_ROUTE = "import { pinNoteInput, pinNoteOutput } from '../../schemas.js';\n"
  + "import { resolveSession } from '../../../../../auth.js';\n\n"
  + 'export async function POST(request, { params }) {\n'
  + '  const principal = resolveSession(request);\n'
  + "  if (!principal) return Response.json({ error: 'Unauthenticated' }, { status: 401 });\n"
  + '  const input = pinNoteInput.safeParse(await params);\n'
  + "  if (!input.success) return Response.json({ error: 'Invalid note' }, { status: 400 });\n"
  + '  return Response.json(pinNoteOutput.parse({ id: input.data.id, pinned: true }));\n}\n';

/** The native fixture plus a searchable notes collection with a pin action. */
export async function addNotes(root: string): Promise<void> {
  await mkdir(join(root, 'src/app/api/notes/[id]/pin'), { recursive: true });
  await writeFile(join(root, 'src/app/api/notes/schemas.js'), NOTES_SCHEMAS);
  await writeFile(join(root, 'src/app/api/notes/route.js'), NOTES_ROUTE);
  await writeFile(join(root, 'src/app/api/notes/[id]/pin/route.js'), PIN_ROUTE);
}

async function interactionsOf(root: string): Promise<ChatInteractionsData> {
  const generated = await import(pathToFileURL(join(root, GENERATED_MODULE)).href) as { chatInteractions: ChatInteractionsData };
  return generated.chatInteractions;
}

describe('chat interactions derived from the Next reference app', () => {
  it('turns pages, URL filters and client actions into commands and keeps check and integrity green', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    expect(await interactionsOf(root)).toEqual({
      schemaVersion: 1,
      entities: [],
      commands: [
        {
          id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
          args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
          run: { kind: 'ui', tool: 'ui.filter.tasks' },
        },
        { id: 'open.overview', label: { en: 'Open Overview', de: 'Overview öffnen' }, keywords: ['overview'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
        { id: 'open.tasks', label: { en: 'Open Tasks', de: 'Tasks öffnen' }, keywords: ['tasks'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } },
        {
          id: 'tasks.highlight', label: { en: 'Tasks highlight', de: 'Tasks highlight' },
          args: [{ name: 'title', label: 'Title', required: true }],
          run: { kind: 'ui', tool: 'ui.tasks.highlight' },
        },
      ],
    });
    expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root, mode: 'integrity' })).driftPaths).toEqual([]);
  }, 120_000);

  it('derives a searchable entity and its item action from a new collection route', async () => {
    const root = await copyApp(NATIVE_APP);
    await addNotes(root);
    await runToolsPipeline({ root, mode: 'write' });
    const interactions = await interactionsOf(root);
    expect(interactions.entities).toEqual([{
      type: 'note',
      label: { en: 'Note', de: 'Note' },
      search: { tool: 'notes.list', path: '/api/notes', queryParam: 'search', itemsPath: ['notes'], idField: 'id', labelField: 'title' },
      actions: [{ id: 'note.notesPin.create', label: { en: 'Pin', de: 'Pin' }, entityArg: 'id', run: { kind: 'tool', tool: 'notesPin.create' } }],
    }]);
    expect(interactions.commands.map((command) => command.id)).toEqual(['filter.tasks', 'open.overview', 'open.tasks', 'tasks.highlight']);
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run build && bunx vitest run src/codegen/tools/emit-module-chat.test.ts tests/chat-interactions-next.test.ts --maxWorkers=4
```

Expected: FAIL — `renderGeneratedModule` emits no `chatInteractions`: the module text lacks the export, the strict type-check reports that the property does not exist, and the refreshed fixture module yields `undefined`. `Test Files  2 failed (2)`, `Tests  5 failed (5)`. The build comes first because `tests/chat-interactions-next.test.ts` boots the generated module against `dist/` (`assertBuiltSdk`), which must contain P04's `uiActionToolToTool`.

- [ ] **Step 3: Implement**

In `src/codegen/tools/emit-module.ts`, replace:

```ts
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits, sortKeysDeep } from './canonical.js';
import type { RuntimeSchemaSource, ToolContract, ToolContractsEntry } from './types.js';

```

with:

```ts
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits, sortKeysDeep } from './canonical.js';
import { deriveChatInteractions } from './chat-interactions.js';
import type { RuntimeSchemaSource, ToolContract, ToolContractsEntry } from './types.js';

```

In `src/codegen/tools/emit-module.ts`, replace:

```ts
    `export const toolCatalog = ${literal(tools.map(catalogEntry))}${typescript ? ' as const' : ''};`,
    '',
  );
  if (typescript) {
```

with:

```ts
    `export const toolCatalog = ${literal(tools.map(catalogEntry))}${typescript ? ' as const' : ''};`,
    '',
    '/** `@` entities and `/` commands derived from the tools; see `createChatInteractionsHandler`. */',
    `export const chatInteractions = ${literal(deriveChatInteractions(input))}${typescript ? ' as const' : ''};`,
    '',
  );
  if (typescript) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/codegen/tools/emit-module-chat.test.ts tests/chat-interactions-next.test.ts --maxWorkers=4 && bunx vitest run src/codegen/tools --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  2 passed (2)`, `Tests  5 passed (5)`; the generator suites (`bunx vitest run src/codegen/tools --maxWorkers=4`) report `Test Files  30 passed (30)`, `Tests  386 passed (386)`; typecheck clean. On a loaded machine the timing-sensitive P03 files (`handler-analysis`, `program`, `schema-probe`) can hit Vitest's 5-second timeout; rerun such a file alone before treating it as a failure.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/codegen/tools/emit-module-chat.test.ts src/codegen/tools/emit-module.ts tests/chat-interactions-next.test.ts
git commit -m "feat(codegen): emit chat interactions in the generated module"
```

### Task 5: Run a direct command without a model call

**Files:**
- Create: `src/server/adapters/nextjs/direct-command.ts`
- Test: `src/server/adapters/nextjs/__tests__/direct-command.test.ts` (Create), `src/server/adapters/nextjs/__tests__/command-fixtures.ts` (Create; shared snapshot, principal, sink and stream helpers for Tasks 5–7, not collected by Vitest — it avoids importing `turn-snapshot.test.ts`, which would re-register its tests)

**Interfaces:**
- Consumes: Task 1 protocol; `createAiSdkTools` (`runtime/ai-sdk/engine.ts`), `modelFacingToolName`, `ManagedTurnGuard`, `UNKNOWN_TURN_COST`, `TurnMetricsRecorder` (P09), `NON_DOMAIN_TOOL_NAMES`, `createUIMessageStream`/`createUIMessageStreamResponse` (`ai`).
- Produces:
  - `interface DirectCommandRequest { invocation; label; approval?: { toolCallId; approved }; settled? }` and `resolveDirectCommand(messages)`: the latest user message as a command; the assistant message after it decides between a fresh run, an approval answer (a `glirastes-command-…` tool part in `approval-responded`) and settled.
  - `stripChatCommandMessages(messages)`: the model copy of user messages without markers.
  - `resolveCommandToolName(registry, tool)`: by tool id, then by key or model-facing name; built-ins never.
  - `runDirectCommand({ command, registry, tools, managedTurn?, turnMetrics?, onError?, generateId? }): Promise<Response>`: an AI SDK UI message stream (`start`, `start-step`, `tool-input-available`, then `tool-output-available` | `tool-output-error` (`command_tool_unavailable`, `command_input_invalid`, the guard's denial code, `command_timeout`, `command_failed`) | `tool-approval-request` | `tool-output-denied`, `finish-step`, `finish`), one metric event per request. Tool call ids are `glirastes-command-` plus 20 hex characters (38 characters): the assistant message keeps the call, so later model turns replay its id, and OpenAI refuses ids over 40 characters.

- [ ] **Step 1: Write the failing tests**

Create `src/server/adapters/nextjs/__tests__/command-fixtures.ts`:

```ts
import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  TechnicalRuntimeEventV2,
} from '../../../../contracts/index.js';
import type { RuntimeMetricsSink } from '../../../../runtime/metrics/turn-recorder.js';
import { createTurnSnapshot, type TurnSnapshot } from '../../../../runtime/turn-snapshot.js';

const signature = { algorithm: 'Ed25519' as const, keyId: 'key-1', value: 'c2lnbmF0dXJl' };
const TENANT = '019fb710-0000-7000-8000-000000000001';
export const LIST_TASKS_ID = '019fb710-0000-7000-8000-000000000011';
export const ARCHIVE_TASK_ID = '019fb710-0000-7000-8000-000000000012';

export const localLimits: ExecutionBudget = {
  maxModelSteps: 20, maxToolCalls: 10, totalTimeoutMs: 120_000, toolTimeoutMs: 20_000,
  maxInputTokens: 50_000, maxOutputTokens: 10_000, maxEstimatedCostUsd: 5,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 3, maxBreadth: 4, sharedBudget: false },
};

export const agentRevision: AgentRevision = {
  revisionId: '019fb710-0000-7000-8000-000000000002', revision: 1, agentId: '019fb710-0000-7000-8000-000000000003',
  tenantId: TENANT, name: 'Assistant', objective: 'Help with tasks.', modelAlias: 'standard', promptBindingRef: 'prompt-v1',
  toolAllowlist: [LIST_TASKS_ID, ARCHIVE_TASK_ID], budget: localLimits,
  publishedAt: '2026-10-05T08:00:00.000Z', signature,
};

const tool = (toolId: string, name: string, method: 'GET' | 'POST', riskClass: 'safe-read' | 'write') => ({
  toolId, sourceFingerprint: 'sha256:tool', executionKind: 'endpoint' as const, name, description: `Run ${name}.`,
  riskClass, enabled: true, tombstone: false, method, path: '/api/tasks',
  inputSchemaDigest: 'sha256:input', outputSchemaDigest: 'sha256:output', authBindingRef: 'task-session',
});

export const manifestRevision: ManifestRevision = {
  revisionId: '019fb710-0000-7000-8000-000000000004', revision: 1, tenantId: TENANT,
  targetAppId: '019fb710-0000-7000-8000-000000000005', environmentId: '019fb710-0000-7000-8000-000000000006',
  sourceDigest: 'sha256:manifest',
  tools: [tool(LIST_TASKS_ID, 'tasks.list', 'GET', 'safe-read'), tool(ARCHIVE_TASK_ID, 'tasks.archive', 'POST', 'write')],
  publishedAt: '2026-10-05T08:00:00.000Z', signature,
};

export function policyRevision(overrides: { listRoles?: string[]; archiveEnabled?: boolean } = {}): RuntimePolicyRevision {
  return {
    revisionId: '019fb710-0000-7000-8000-000000000007', revision: 1, tenantId: TENANT,
    environmentId: manifestRevision.environmentId, budget: localLimits,
    toolPolicies: [
      { toolId: LIST_TASKS_ID, enabled: true, riskClass: 'safe-read', requiresApproval: false, allowedRoles: overrides.listRoles ?? [] },
      { toolId: ARCHIVE_TASK_ID, enabled: overrides.archiveEnabled ?? true, riskClass: 'write', requiresApproval: true, allowedRoles: [] },
    ],
    toolOverrides: [],
    publishedAt: '2026-10-05T08:00:00.000Z', signature,
  };
}

export function principal(roles: string[] = ['member']): Principal {
  return { subjectId: 'alice', tenantId: TENANT, roles, attributes: {} };
}

export function snapshot(turnId: string, options: Parameters<typeof policyRevision>[0] = {}, roles?: string[]): TurnSnapshot {
  return createTurnSnapshot({
    turnId, agentRevision, manifestRevision, policyRevision: policyRevision(options), principal: principal(roles), localLimits,
  });
}

export function collectingSink() {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: '019fb710-0000-7000-8000-0000000000a1', environmentId: '019fb710-0000-7000-8000-0000000000e1',
      buildId: null, instanceId: 'web-1',
    },
    // Keeps finished turns only, so the fixture also compiles once the sink takes more event types (P05).
    record: (event) => { if (event.eventType === 'turn.finished') events.push(event); },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

/** The data chunks of an AI SDK UI message stream response; `start` without its generated message id. */
export async function streamChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .map((chunk) => (chunk.type === 'start' ? { type: 'start' } : chunk));
}
```

Create `src/server/adapters/nextjs/__tests__/direct-command.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { createManagedTurnGuard } from '../../../../runtime/managed-turn.js';
import { createTurnMetricsRecorder } from '../../../../runtime/metrics/turn-recorder.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { toolsToAiTools } from '../../../core/index.js';
import {
  resolveCommandToolName,
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
} from '../direct-command.js';
import { collectingSink, LIST_TASKS_ID, principal, snapshot, streamChunks as chunks } from './command-fixtures.js';

const user = (text: string, id = 'u1') => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const listCommand = formatChatCommandMessage({ commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks' });

function registry(options: { needsApproval?: boolean; execute?: (input: unknown) => Promise<unknown> } = {}) {
  const execute = vi.fn(options.execute ?? (async (_input: unknown) => ({ tasks: [{ title: 'Release prüfen' }] })));
  const tools: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list',
      description: 'List visible tasks.',
      inputSchema: z.object({ query: z.string().min(1) }).strict(),
      needsApproval: options.needsApproval ?? false,
      execute,
    }),
  };
  return { tools, execute, aiTools: toolsToAiTools(tools, { currentDate: new Date(), locale: 'en-US' }) };
}

describe('direct command ids', () => {
  it('generates provider-safe tool call ids of at most 40 characters', async () => {
    const { tools, aiTools } = registry({ needsApproval: true });
    const output = await chunks(await runDirectCommand({ command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools }));
    const request = output.find((chunk) => chunk.type === 'tool-approval-request')!;
    expect(request.toolCallId).toMatch(/^glirastes-command-[0-9a-f]{20}$/);
    expect(request.approvalId).toMatch(/^glirastes-approval-[0-9a-f]{20}$/);
  });
});

describe('resolveDirectCommand', () => {
  it('reads a fresh command, its approval answer and a settled command', () => {
    expect(resolveDirectCommand([user(listCommand)])).toEqual({
      invocation: { commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' } }, label: '/Search tasks',
    });
    const answered = (approved: boolean) => resolveDirectCommand([user(listCommand), {
      id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
        type: 'tool-tasks_list', toolCallId: 'glirastes-command-1', state: 'approval-responded',
        input: { query: 'Release' }, approval: { id: 'glirastes-approval-1', approved },
      }],
    }]);
    expect(answered(true)?.approval).toEqual({ toolCallId: 'glirastes-command-1', approved: true });
    expect(answered(false)?.approval).toEqual({ toolCallId: 'glirastes-command-1', approved: false });
    expect(resolveDirectCommand([user(listCommand), {
      id: 'a1', role: 'assistant', parts: [{ type: 'tool-tasks_list', toolCallId: 'glirastes-command-1', state: 'output-available', output: {} }],
    }])).toMatchObject({ settled: true });
  });

  it('ignores plain text and commands of earlier turns', () => {
    expect(resolveDirectCommand([user('Show my tasks')])).toBeUndefined();
    expect(resolveDirectCommand([user(listCommand, 'u1'), { id: 'a1', role: 'assistant', parts: [] }, user('Thanks', 'u2')])).toBeUndefined();
  });
});

describe('stripChatCommandMessages', () => {
  it('keeps only the visible label of command messages for the model', () => {
    const messages = [user(listCommand), { role: 'user', content: listCommand }, { role: 'assistant', content: listCommand }];
    expect(stripChatCommandMessages(messages)).toEqual([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '/Search tasks' }] },
      { role: 'user', content: '/Search tasks' },
      { role: 'assistant', content: listCommand },
    ]);
  });
});

describe('resolveCommandToolName', () => {
  it('finds the tool by definition id or model-facing name and never a built-in', () => {
    const { tools } = registry();
    expect(resolveCommandToolName(tools, 'tasks.list')).toBe('tasks_list');
    expect(resolveCommandToolName({ notes_pin: { ...tools.tasks_list!, id: 'pin' } }, 'notes.pin')).toBe('notes_pin');
    expect(resolveCommandToolName({ ask_clarification: { ...tools.tasks_list!, id: 'ask_clarification' } }, 'ask_clarification')).toBeUndefined();
  });
});

describe('runDirectCommand', () => {
  it('runs a tool that needs no confirmation and streams its result without a model', async () => {
    const { tools, aiTools, execute } = registry();
    const response = await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools, generateId: () => 'fixed',
    });
    expect(await chunks(response)).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'glirastes-command-fixed', toolName: 'tasks_list', input: { query: 'Release' } },
      { type: 'tool-output-available', toolCallId: 'glirastes-command-fixed', output: { tasks: [{ title: 'Release prüfen' }] } },
      { type: 'finish-step' },
      { type: 'finish' },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ query: 'Release' });
  });

  it('asks for confirmation first and runs only after an approving answer', async () => {
    const { tools, aiTools, execute } = registry({ needsApproval: true });
    const first = await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools, generateId: () => 'one',
    }));
    expect(first.map((chunk) => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'tool-approval-request', 'finish-step', 'finish']);
    expect(first[3]).toEqual({ type: 'tool-approval-request', approvalId: 'glirastes-approval-one', toolCallId: 'glirastes-command-one' });
    expect(execute).not.toHaveBeenCalled();

    const answer = (approved: boolean) => resolveDirectCommand([user(listCommand), {
      id: 'a1', role: 'assistant', parts: [{
        type: 'tool-tasks_list', toolCallId: 'glirastes-command-one', state: 'approval-responded',
        input: { query: 'Release' }, approval: { id: 'glirastes-approval-one', approved },
      }],
    }])!;
    expect(await chunks(await runDirectCommand({ command: answer(false), registry: tools, tools: aiTools })))
      .toEqual([{ type: 'start' }, { type: 'tool-output-denied', toolCallId: 'glirastes-command-one' }, { type: 'finish' }]);
    expect(execute).not.toHaveBeenCalled();
    const approved = await chunks(await runDirectCommand({ command: answer(true), registry: tools, tools: aiTools }));
    expect(approved.map((chunk) => chunk.type)).toEqual(['start', 'tool-output-available', 'finish']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown tool', formatChatCommandMessage({ commandId: 'x', tool: 'tasks.purge', label: 'x' }), 'command_tool_unavailable'],
    ['invalid arguments', formatChatCommandMessage({ commandId: 'x', tool: 'tasks.list', args: { query: '' }, label: 'x' }), 'command_input_invalid'],
  ])('refuses %s without executing anything', async (_label, text, errorText) => {
    const { tools, aiTools, execute } = registry();
    const output = await chunks(await runDirectCommand({ command: resolveDirectCommand([user(text)])!, registry: tools, tools: aiTools }));
    expect(output.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText });
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces the managed guard and records one content-free event per request', async () => {
    const { tools, aiTools, execute } = registry();
    const { sink, events } = collectingSink();
    const run = async (roles: string[]) => {
      const guard = createManagedTurnGuard({
        snapshot: snapshot('turn-1', { listRoles: ['admin'] }, roles),
        resolvePrincipal: async () => principal(roles),
      });
      const response = await runDirectCommand({
        command: resolveDirectCommand([user(listCommand)])!,
        registry: tools,
        tools: aiTools,
        managedTurn: guard,
        turnMetrics: createTurnMetricsRecorder({ sink, snapshot: guard.snapshot, startedAtMs: Date.now() }),
      });
      return chunks(response);
    };

    const denied = await run(['member']);
    expect(denied.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'principal_role_denied' });
    expect(execute).not.toHaveBeenCalled();
    const allowed = await run(['admin']);
    expect(allowed.find((chunk) => chunk.type === 'tool-output-available')).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        model: null, status: 'completed', errorCode: null, inputTokens: 0, outputTokens: 0,
        cost: { usd: null, source: null, pricingVersion: null }, toolCallCount: 1,
        latency: { firstTokenMs: null },
      });
    }
    expect(events[0]).toMatchObject({ toolErrorCount: 1, tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 1 }] });
    expect(events[1]).toMatchObject({ toolErrorCount: 0, tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 0 }] });
    expect(JSON.stringify(events)).not.toMatch(/Release|query|tasks_list/);
  });

  it('records a confirmation request as a turn without a tool call', async () => {
    const { tools, aiTools } = registry({ needsApproval: true });
    const { sink, events } = collectingSink();
    await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools,
      turnMetrics: createTurnMetricsRecorder({ sink, startedAtMs: Date.now() }),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ model: null, status: 'completed', toolCallCount: 0, toolErrorCount: 0, tools: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/server/adapters/nextjs/__tests__/direct-command.test.ts --maxWorkers=4
```

Expected: FAIL — `Cannot find module '../direct-command.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

Create `src/server/adapters/nextjs/direct-command.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import {
  CHAT_COMMAND_TOOL_CALL_PREFIX,
  isChatCommandToolCallId,
  parseChatCommandMessage,
  stripChatCommandMarkers,
  type ChatCommandInvocation,
} from '../../../contracts/chat-command.js';
import { createAiSdkTools } from '../../../runtime/ai-sdk/engine.js';
import { modelFacingToolName } from '../../../runtime/local-tool-bindings.js';
import type { ManagedTurnGuard } from '../../../runtime/managed-turn.js';
import { UNKNOWN_TURN_COST } from '../../../runtime/metrics/cost.js';
import type { TurnMetricsRecorder } from '../../../runtime/metrics/turn-recorder.js';
import type { ToolRegistry } from '../../../types.js';
import { NON_DOMAIN_TOOL_NAMES } from './tool-discovery.js';

/** A direct command in the latest user message, and where its turn stands. */
export interface DirectCommandRequest {
  readonly invocation: ChatCommandInvocation;
  readonly label: string;
  /** The user's answer to this command's confirmation request. */
  readonly approval?: {
    readonly toolCallId: string;
    readonly approved: boolean;
  };
  /** The command already ran or was refused; nothing is left to do. */
  readonly settled?: boolean;
}

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(message: MessageRecord): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .filter((part): part is MessageRecord => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/**
 * Reads the latest user message as a direct command. The assistant message
 * that follows it (an approval continuation) decides whether the command
 * still waits for its confirmation answer or is settled.
 */
export function resolveDirectCommand(messages: ReadonlyArray<unknown>): DirectCommandRequest | undefined {
  let index = messages.length - 1;
  while (index >= 0 && !(isRecord(messages[index]) && (messages[index] as MessageRecord).role === 'user')) index -= 1;
  if (index < 0) return undefined;
  const parsed = parseChatCommandMessage(textOf(messages[index] as MessageRecord));
  if (!parsed) return undefined;
  const next = messages[index + 1];
  if (next === undefined) return parsed;
  const parts = isRecord(next) && next.role === 'assistant' && Array.isArray(next.parts) ? next.parts : [];
  const call = parts.find((part): part is MessageRecord => isRecord(part) && isChatCommandToolCallId(part.toolCallId));
  if (call?.state === 'approval-responded' && isRecord(call.approval)) {
    return { ...parsed, approval: { toolCallId: call.toolCallId as string, approved: call.approval.approved === true } };
  }
  return { ...parsed, settled: true };
}

/** The model's copy of the history: earlier command markers removed, the visible label kept. */
export function stripChatCommandMessages(messages: ReadonlyArray<unknown>): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== 'user') return message;
    if (typeof message.content === 'string') {
      const content = stripChatCommandMarkers(message.content);
      return content === message.content ? message : { ...message, content };
    }
    if (!Array.isArray(message.parts)) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') return part;
      const text = stripChatCommandMarkers(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, parts } : message;
  });
}

/**
 * The registry key of the command's tool: the tool whose id is the
 * definition id, else the key spelled like it. SDK built-ins never run as
 * direct commands.
 */
export function resolveCommandToolName(registry: ToolRegistry, tool: string): string | undefined {
  const builtins = new Set<string>(NON_DOMAIN_TOOL_NAMES);
  const names = Object.keys(registry).filter((name) => !builtins.has(name));
  return names.find((name) => registry[name]!.id === tool)
    ?? names.find((name) => name === tool || name === modelFacingToolName(tool));
}

/** Content-free reason for the client: a denial code from the guard, never a backend message. */
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const denied = /^Tool execution denied: ([a-z_]{1,80})\b/.exec(message);
  if (denied) return denied[1]!;
  if (/ timed out after \d+ms$/.test(message)) return 'command_timeout';
  return 'command_failed';
}

function failedResult(result: unknown): boolean {
  return isRecord(result) && (typeof result.error === 'string' || result.success === false);
}

/**
 * 20 hex characters: the tool call id stays within 40 characters, the
 * shortest provider limit (OpenAI), because later model turns replay it.
 */
function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 20);
}

export interface RunDirectCommandOptions {
  command: DirectCommandRequest;
  /** The turn's registry, built exactly like for a model turn. */
  registry: ToolRegistry;
  /** `toolsToAiTools(registry, …)`, after the same wrappers as the model path. */
  tools: Record<string, unknown>;
  managedTurn?: ManagedTurnGuard;
  turnMetrics?: TurnMetricsRecorder;
  onError?: (error: unknown) => void;
  /** Suffix of the tool call and approval ids; default 20 random hex characters. */
  generateId?: () => string;
}

/**
 * Runs a direct command without a model call. The tool goes through the
 * same AI SDK wrapper as on the model path: input schema, the managed guard
 * (manifest, principal, roles, revocation, budget), confirmation
 * (`needsApproval` / the policy) and audit. A tool that needs confirmation
 * answers with an AI SDK approval request; the approval continuation runs
 * it. One content-free metric event per request: no model, unknown cost,
 * the executed call (or none) as tool count.
 */
export async function runDirectCommand(options: RunDirectCommandOptions): Promise<Response> {
  const { command, registry, managedTurn, turnMetrics } = options;
  const nextId = options.generateId ?? shortId;
  const name = resolveCommandToolName(registry, command.invocation.tool);
  const toolName = name ?? modelFacingToolName(command.invocation.tool);

  const record = (calls: number, failures: number) => {
    turnMetrics?.recordStep({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: UNKNOWN_TURN_COST,
      toolNames: calls > 0 ? [toolName] : [],
      failedToolNames: failures > 0 ? [toolName] : [],
    });
    turnMetrics?.finish({ status: 'completed', errorCode: null });
  };

  const stream = createUIMessageStream({
    onError: () => 'Command failed',
    execute: async ({ writer }) => {
      try {
        writer.write({ type: 'start' });
        if (command.settled) {
          writer.write({ type: 'finish' });
          record(0, 0);
          return;
        }
        const toolCallId = command.approval?.toolCallId ?? `${CHAT_COMMAND_TOOL_CALL_PREFIX}${nextId()}`;
        const fresh = command.approval === undefined;
        if (fresh) {
          writer.write({ type: 'start-step' });
          writer.write({ type: 'tool-input-available', toolCallId, toolName, input: command.invocation.args });
        }
        const end = (calls: number, failures: number) => {
          if (fresh) writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish' });
          record(calls, failures);
        };
        const fail = (errorText: string) => {
          writer.write({ type: 'tool-output-error', toolCallId, errorText });
          end(1, 1);
        };

        if (!name || !options.tools[name]) {
          fail('command_tool_unavailable');
          return;
        }
        const parsed = registry[name]!.inputSchema.safeParse(command.invocation.args);
        if (!parsed.success) {
          fail('command_input_invalid');
          return;
        }
        if (command.approval && !command.approval.approved) {
          writer.write({ type: 'tool-output-denied', toolCallId });
          end(0, 0);
          return;
        }
        const tool = createAiSdkTools({
          tools: { [name]: options.tools[name] },
          ...(managedTurn
            ? {
              beforeToolCall: managedTurn.beforeToolCall,
              afterToolCall: managedTurn.afterToolCall,
              onToolError: managedTurn.onToolError,
              resolveApproval: managedTurn.resolveApproval,
              toolTimeoutMs: managedTurn.toolTimeoutMs,
            }
            : {}),
        })[name]!;
        const executionOptions = { toolCallId, messages: [] };
        if (fresh) {
          let needsApproval: boolean;
          try {
            needsApproval = typeof tool.needsApproval === 'function'
              ? Boolean(await (tool.needsApproval as (input: unknown, options: unknown) => unknown)(parsed.data, executionOptions))
              : tool.needsApproval === true;
          } catch (error) {
            fail(failureCode(error));
            return;
          }
          if (needsApproval) {
            writer.write({ type: 'tool-approval-request', approvalId: `glirastes-approval-${nextId()}`, toolCallId });
            end(0, 0);
            return;
          }
        }
        let output: unknown;
        try {
          output = await tool.execute!(parsed.data, executionOptions);
        } catch (error) {
          fail(failureCode(error));
          return;
        }
        writer.write({ type: 'tool-output-available', toolCallId, output });
        end(1, failedResult(output) ? 1 : 0);
      } catch (error) {
        turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
        options.onError?.(error);
        throw error;
      }
    },
  });
  return createUIMessageStreamResponse({ stream });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/server/adapters/nextjs/__tests__/direct-command.test.ts --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  11 passed (11)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/server/adapters/nextjs/__tests__/command-fixtures.ts src/server/adapters/nextjs/__tests__/direct-command.test.ts src/server/adapters/nextjs/direct-command.ts
git commit -m "feat(server): run direct chat commands without a model call"
```

### Task 6: Direct commands in `createAiChatHandler`

**Files:**
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.ts` (shared with P09, already merged at `064f8a9`; shared with P05, see the merge table), `src/server/adapters/nextjs/types.ts` (`directCommands`)
- Test: `src/server/adapters/nextjs/__tests__/direct-commands-handler.test.ts` (Create)

**Interfaces:**
- Consumes: Task 5; the handler's own `toolContext`, `createInternalApiCallerFromRequest`, `staticTools`/`loadTools`, `toolOptions` (audit, `uiActionSchema`), `wrapToolsWithShield`, `wrapToolsWithLancerApprovals`, `managedTurn` and P09's `turnMetrics` (created before the branch, so a direct command is recorded by the same recorder).
- Produces: `AiChatHandlerConfig.directCommands?: boolean` (default `true`). With a command marker as the latest user message the handler skips clarification resume, routing, guardrails and the model and returns `runDirectCommand(…)`; a configured `piiShield` wraps the command's tool exactly like on the model path (`wrapToolsWithShield`), because the result stays in the chat history that later model turns send to the model (without it, a direct command's raw result would reach the model provider on the next turn, since `anonymizeMessages` only covers user messages); otherwise the model copy of the history drops earlier markers (`stripChatCommandMessages`). `StreamHandlerContext` is unchanged; a custom `streamHandler` never sees direct commands.

- [ ] **Step 1: Write the failing tests**

Create `src/server/adapters/nextjs/__tests__/direct-commands-handler.test.ts`:

```ts
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { defineTool, type PiiShield, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { collectingSink, principal, snapshot, streamChunks } from './command-fixtures.js';

const archiveCommand = formatChatCommandMessage({
  commandId: 'task.tasks.archive', tool: 'tasks.archive', args: { id: 't1' }, label: '/Archive Release prüfen',
});
const listCommand = formatChatCommandMessage({
  commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks',
});

function model() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Model answer.' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish', finishReason: { unified: 'stop', raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        },
      ] as never),
    }),
  });
}

function tools() {
  const list = vi.fn(async () => ({ tasks: [{ id: 't1', title: 'Release prüfen' }] }));
  const archive = vi.fn(async () => ({ success: true, archived: 't1' }));
  const registry: ToolRegistry = {
    tasks_list: defineTool({ id: 'tasks.list', description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(), execute: list }),
    tasks_archive: defineTool({
      id: 'tasks.archive', description: 'Archive a task.', inputSchema: z.object({ id: z.string() }).strict(),
      needsApproval: true, execute: archive,
    }),
  };
  return { registry, list, archive };
}

function post(messages: unknown[]): Request {
  return new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
  });
}

const user = (text: string, id = 'u1') => ({ id, role: 'user', parts: [{ type: 'text', text }] });

function approvalAnswer(approved: boolean, toolCallId: string) {
  return {
    id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
      type: 'tool-tasks_archive', toolCallId, state: 'approval-responded',
      input: { id: 't1' }, approval: { id: 'glirastes-approval-1', approved },
    }],
  };
}

describe('direct commands in createAiChatHandler', () => {
  it('runs a command without routing or a model call', async () => {
    const languageModel = model();
    const process = vi.fn();
    const { registry, list } = tools();
    const handler = createAiChatHandler({
      tools: registry, model: languageModel, systemPrompt: 'Assistant',
      pipeline: { process } as never,
    });
    const output = await streamChunks(await handler(post([user(listCommand)])));
    expect(output.find((chunk) => chunk.type === 'tool-output-available'))
      .toMatchObject({ output: { tasks: [{ id: 't1', title: 'Release prüfen' }] } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);
    expect(process).not.toHaveBeenCalled();
  });

  it('keeps the confirmation of a write tool, under the managed guard, across the approval round trip', async () => {
    const languageModel = model();
    const { registry, archive } = tools();
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry, model: languageModel, systemPrompt: 'Assistant', metrics: sink,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId),
      },
    });
    const first = await streamChunks(await handler(post([user(archiveCommand)])));
    const request = first.find((chunk) => chunk.type === 'tool-approval-request');
    expect(request).toMatchObject({ toolCallId: expect.stringMatching(/^glirastes-command-[0-9a-f]{20}$/) });
    expect(archive).not.toHaveBeenCalled();

    const toolCallId = request!.toolCallId as string;
    const denied = await streamChunks(await handler(post([user(archiveCommand), approvalAnswer(false, toolCallId)])));
    expect(denied.map((chunk) => chunk.type)).toContain('tool-output-denied');
    expect(archive).not.toHaveBeenCalled();
    const approved = await streamChunks(await handler(post([user(archiveCommand), approvalAnswer(true, toolCallId)])));
    expect(approved.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({ toolCallId, output: { archived: 't1' } });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);

    expect(events.map((event) => [event.model, event.toolCallCount, event.cost.usd])).toEqual([
      [null, 0, null], [null, 0, null], [null, 1, null],
    ]);
  });

  it('refuses a tool the Platform disabled or the principal may not use', async () => {
    const { registry, archive, list } = tools();
    const handler = (options: Parameters<typeof snapshot>[1]) => createAiChatHandler({
      tools: registry, model: model(), systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId, options),
      },
    });
    const disabled = await streamChunks(await handler({ archiveEnabled: false })(post([user(archiveCommand)])));
    expect(disabled.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'policy_tool_denied' });
    const forbidden = await streamChunks(await handler({ listRoles: ['admin'] })(post([user(listCommand)])));
    expect(forbidden.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'principal_role_denied' });
    expect(archive).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('pseudonymizes the result through the PII shield, because later model turns read it', async () => {
    const languageModel = model();
    const { registry, list } = tools();
    const anonymizeResult = vi.fn(async () => ({ tasks: [{ id: 't1', title: '<PERSON_1>' }] }));
    const piiShield = {
      outbound: vi.fn(async (text: string) => text),
      inbound: (text: string) => text,
      rehydrateArgs: (args: Record<string, unknown>) => args,
      anonymizeResult,
      getComplianceSummary: vi.fn(),
      clearSession: vi.fn(),
    } as unknown as PiiShield;
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant', piiShield });
    const output = await streamChunks(await handler(post([user(listCommand)])));
    expect(output.find((chunk) => chunk.type === 'tool-output-available'))
      .toMatchObject({ output: { tasks: [{ id: 't1', title: '<PERSON_1>' }] } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(anonymizeResult).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);
  });

  it('shows the model earlier commands only by their label', async () => {
    const languageModel = model();
    const { registry } = tools();
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant' });
    const history = [
      user(listCommand, 'u1'),
      {
        id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
          type: 'tool-tasks_list', toolCallId: 'glirastes-command-0123456789abcdef0123', state: 'output-available',
          input: { query: 'Release' }, output: { tasks: [{ id: 't1', title: 'Release prüfen' }] },
        }],
      },
      user('Which one is due first?', 'u2'),
    ];
    await (await handler(post(history))).text();
    expect(languageModel.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(languageModel.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('/Search tasks');
    // The command's call and result reach the model like a model call, with the replayable id.
    expect(prompt).toContain('glirastes-command-0123456789abcdef0123');
    expect(prompt).toContain('Release prüfen');
    expect(prompt).not.toContain('glirastes:command');
  });

  it('hands a command message to the model as text when direct commands are off', async () => {
    const languageModel = model();
    const { registry, list } = tools();
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant', directCommands: false });
    await (await handler(post([user(listCommand)]))).text();
    expect(list).not.toHaveBeenCalled();
    expect(languageModel.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(languageModel.doStreamCalls[0]!.prompt)).not.toContain('glirastes:command');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/server/adapters/nextjs/__tests__/direct-commands-handler.test.ts --maxWorkers=4
```

Expected: FAIL — without the direct branch the marker goes down the model path: routing and the model are called, no tool runs, the PII shield never sees a result, and the model's prompt still contains `glirastes:command`. `Test Files  1 failed (1)`, `Tests  6 failed (6)`

- [ ] **Step 3: Implement**

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
} from './clarification-resume.js';
import { scopePipelineTools } from './scope-pipeline-tools.js';
import type { ToolToAiToolOptions } from '../../core/index.js';
import type { Tool, ToolRegistry, ConversationMessage, PiiShield, PromptOverride } from '../../../types.js';
```

with:

```ts
} from './clarification-resume.js';
import { scopePipelineTools } from './scope-pipeline-tools.js';
import {
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
} from './direct-command.js';
import type { ToolToAiToolOptions } from '../../core/index.js';
import type { Tool, ToolRegistry, ConversationMessage, PiiShield, PromptOverride } from '../../../types.js';
```

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
    metrics,
    modelPricing: configuredModelPricing,
  } = config;

```

with:

```ts
    metrics,
    modelPricing: configuredModelPricing,
    directCommands = true,
  } = config;

```

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
      }

      // A clarification answer resumes its original request: routing sees
      // request + answer, the model sees an explicit continuation. The client
      // session keeps the untouched messages.
      const clarificationResume = resolveClarificationResume(requestMessages);
      const messages: unknown[] = clarificationResume
        ? applyClarificationResume(requestMessages, clarificationResume)
        : requestMessages;

      // Build tool context
```

with:

```ts
      }

      // A direct command (`/` command or entity action) runs its tool without
      // the model; the model sees earlier commands only by their label.
      const directCommand = directCommands ? resolveDirectCommand(requestMessages) : undefined;

      // A clarification answer resumes its original request: routing sees
      // request + answer, the model sees an explicit continuation. The client
      // session keeps the untouched messages.
      const clarificationResume = directCommand ? undefined : resolveClarificationResume(requestMessages);
      const messages: unknown[] = directCommand
        ? requestMessages
        : stripChatCommandMessages(clarificationResume
          ? applyClarificationResume(requestMessages, clarificationResume)
          : requestMessages);

      // Build tool context
```

In `src/server/adapters/nextjs/create-ai-chat-handler.ts`, replace:

```ts
          // Telemetry is fire-and-forget
        }
      }

```

with:

```ts
          // Telemetry is fire-and-forget
        }
      }

      // ================================================================
      // Direct command: no routing, no guardrails, no model call. The tool
      // runs on the registry and wrappers of a model turn, so authorization,
      // confirmation, revocation, budget, audit, the PII shield and metrics
      // stay the same.
      // ================================================================
      if (directCommand) {
        const callEndpoint = createInternalApiCallerFromRequest(req);
        const endpointToolContext = {
          ...toolContext,
          callEndpoint,
          ...(managedTurn
            ? { turnSnapshot: managedTurn.snapshot }
            : {}),
        };
        const registry = staticTools ?? await loadTools!(endpointToolContext);
        let commandTools: Record<string, unknown> = toolsToAiTools(registry, endpointToolContext, toolOptions);
        // The result stays in the chat history that later model turns send to the model.
        if (piiShield) {
          commandTools = wrapToolsWithShield(commandTools, piiShield, sessionId);
        }
        if (lancer?.approvals) {
          commandTools = wrapToolsWithLancerApprovals(commandTools, lancer.approvals, sessionId);
        }
        return await runDirectCommand({
          command: directCommand,
          registry,
          tools: commandTools,
          managedTurn,
          turnMetrics,
          onError: (error) => onError?.(error, req),
        });
      }

```

In `src/server/adapters/nextjs/types.ts`, replace:

```ts

  /**
   * Lancer client for runtime prompt and model overrides (Pro feature).
   *
```

with:

```ts

  /**
   * Direct chat commands (`/` commands and entity actions of the chat UI,
   * default `true`): a user message that is exactly one command marker runs
   * its tool without a model call, through the same registry, guard,
   * confirmation, audit, PII shield and metrics as a model turn. Routing,
   * guardrails and the model are skipped. `false` sends such a message to
   * the model like any other text.
   */
  directCommands?: boolean;

  /**
   * Lancer client for runtime prompt and model overrides (Pro feature).
   *
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/server/adapters/nextjs/__tests__/direct-commands-handler.test.ts --maxWorkers=4 && bunx vitest run src/server --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  6 passed (6)`; the server suites (`bunx vitest run src/server --maxWorkers=4`) report `Test Files  43 passed (43)`, `Tests  408 passed (408)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/server/adapters/nextjs/__tests__/direct-commands-handler.test.ts src/server/adapters/nextjs/create-ai-chat-handler.ts src/server/adapters/nextjs/types.ts
git commit -m "feat(server): route direct commands through the chat handler"
```

### Task 7: Serve interactions per user next to the chat route

**Files:**
- Create: `src/server/adapters/nextjs/chat-interactions-handler.ts`
- Modify: `src/server/adapters/nextjs/index.ts` (exports of Tasks 1, 2, 5 and 7 under `glirastes/server/nextjs`)
- Test: `src/server/adapters/nextjs/__tests__/chat-interactions-handler.test.ts` (Create; imports from `../index.js`, so it also pins the exports)

**Interfaces:**
- Consumes: Task 2 `parseChatInteractions`, `parseChatInteractionOverrides`, `mergeChatInteractions`; `ManagedLocalRuntimeConfig` (the chat handler's own object); `authorizeToolCall`, `isToolRevoked`, `PrincipalSchema`.
- Produces: `interface ChatInteractionsHandlerConfig { interactions; overrides?; managedRuntime? }` and `createChatInteractionsHandler(config): (request) => Promise<Response>` — overrides merged once at creation (invalid ⇒ throws), JSON with `cache-control: private, no-store`; with `managedRuntime`: 401 without a principal, 503 when no snapshot can be pinned, commands and actions kept only when their tool is in the manifest, not revoked and authorized for this principal; a search kept only when its tool is; prompt commands always kept.

- [ ] **Step 1: Write the failing tests**

Create `src/server/adapters/nextjs/__tests__/chat-interactions-handler.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ChatInteractionsData } from '../../../../contracts/chat-interactions.js';
import { createChatInteractionsHandler } from '../index.js';
import { principal, snapshot } from './command-fixtures.js';

const interactions: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: { en: 'Task', de: 'Aufgabe' },
    search: { tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'], idField: 'id', labelField: 'title' },
    actions: [{ id: 'task.tasks.archive', label: 'Archive', entityArg: 'id', run: { kind: 'tool', tool: 'tasks.archive' } }],
  }],
  commands: [
    { id: 'tasks.search', label: 'Search tasks', run: { kind: 'tool', tool: 'tasks.list' } },
    { id: 'standup', label: 'Stand-up', run: { kind: 'prompt', prompt: 'Summarize my day.' } },
    { id: 'reports.open', label: 'Reports', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/reports' } } },
  ],
};

const request = () => new Request('https://app.example/api/chat', { headers: { cookie: 'session=1' } });

describe('createChatInteractionsHandler', () => {
  it('serves the interactions with overrides applied, never cached across users', async () => {
    const handler = createChatInteractionsHandler({
      interactions,
      overrides: { schemaVersion: 1, commands: { standup: { label: { de: 'Tagesrückblick', en: 'Stand-up' } } } },
    });
    const response = await handler(request());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as ChatInteractionsData;
    expect(body.commands.find((command) => command.id === 'standup')!.label).toEqual({ de: 'Tagesrückblick', en: 'Stand-up' });
    expect(body.entities).toEqual(interactions.entities);
  });

  it('refuses an invalid override file at creation, like an invalid policy', () => {
    expect(() => createChatInteractionsHandler({ interactions, overrides: { schemaVersion: 1, commands: { standup: { onRun: 'x' } } } }))
      .toThrow(/commands\.standup\.onRun: unknown field/);
  });

  it('leaves out what this user may not run and needs a session', async () => {
    const managed = (options: Parameters<typeof snapshot>[1], roles?: string[]) => createChatInteractionsHandler({
      interactions,
      managedRuntime: {
        resolvePrincipal: async (incoming) => (incoming.headers.get('cookie') ? principal(roles) : undefined),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId, options, roles),
      },
    });
    expect((await managed({})(new Request('https://app.example/api/chat'))).status).toBe(401);

    const all = await (await managed({})(request())).json() as ChatInteractionsData;
    expect(all.commands.map((command) => command.id)).toEqual(['tasks.search', 'standup']);
    expect(all.entities[0]!.actions!.map((action) => action.id)).toEqual(['task.tasks.archive']);

    const archiveDisabled = await (await managed({ archiveEnabled: false })(request())).json() as ChatInteractionsData;
    const { actions: _actions, ...searchOnly } = interactions.entities[0]!;
    expect(archiveDisabled.entities).toEqual([searchOnly]);

    const listForbidden = await (await managed({ listRoles: ['admin'], archiveEnabled: false })(request())).json() as ChatInteractionsData;
    expect(listForbidden).toEqual({ schemaVersion: 1, entities: [], commands: [interactions.commands[1]] });
  });

  it('hides a revoked tool', async () => {
    const handler = createChatInteractionsHandler({
      interactions,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId),
        loadRevocations: async ({ snapshot: pinned }) => [{
          revocationId: '019fb710-0000-7000-8000-0000000000f1',
          environmentId: pinned.manifestRevision.environmentId,
          effectiveAt: '2026-10-05T09:00:00.000Z',
          reasonCode: 'incident',
          toolIds: [pinned.manifestRevision.tools[1]!.toolId],
          agentRevisionIds: [],
          policyRevisionIds: [],
          signature: { algorithm: 'Ed25519', keyId: 'key-1', value: 'c2lnbmF0dXJl' },
        }],
      },
    });
    const body = await (await handler(request())).json() as ChatInteractionsData;
    expect(body.entities[0]).not.toHaveProperty('actions');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/server/adapters/nextjs/__tests__/chat-interactions-handler.test.ts --maxWorkers=4
```

Expected: FAIL — `createChatInteractionsHandler is not a function` (the module `../index.js` exists, the export does not). `Test Files  1 failed (1)`, `Tests  4 failed (4)`

- [ ] **Step 3: Implement**

Create `src/server/adapters/nextjs/chat-interactions-handler.ts`:

````ts
import { randomUUID } from 'node:crypto';
import {
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatEntityData,
  type ChatInteractionsData,
} from '../../../contracts/chat-interactions.js';
import { PrincipalSchema } from '../../../contracts/index.js';
import { authorizeToolCall } from '../../../runtime/authorization.js';
import { modelFacingToolName } from '../../../runtime/local-tool-bindings.js';
import { isToolRevoked, type TurnSnapshot } from '../../../runtime/turn-snapshot.js';
import type { ManagedLocalRuntimeConfig } from './types.js';

export interface ChatInteractionsHandlerConfig {
  /** `chatInteractions` of the generated module. */
  interactions: ChatInteractionsData;
  /** Parsed `.glirastes/chat-interactions.json`; validated at creation. */
  overrides?: unknown;
  /**
   * The chat handler's managed runtime. With it, the response is per user:
   * commands, actions and searches whose tool this user may not run (Platform
   * disabled, roles, revocation, not deployed) are left out.
   */
  managedRuntime?: ManagedLocalRuntimeConfig;
}

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/**
 * GET handler that serves the chat's `@` entities and `/` commands to the
 * browser (`useChatInteractionsData`, `<glirastes-chat interactions>`).
 * Overrides are applied once at creation; an invalid override file throws
 * there, like an invalid policy. Nothing is sent to the Glirastes Platform.
 *
 * ```ts
 * import overrides from '../../../.glirastes/chat-interactions.json' with { type: 'json' };
 * export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime });
 * ```
 */
export function createChatInteractionsHandler(config: ChatInteractionsHandlerConfig) {
  const merged = mergeChatInteractions(
    parseChatInteractions(config.interactions),
    config.overrides === undefined ? undefined : parseChatInteractionOverrides(config.overrides),
  );

  return async function chatInteractionsHandler(request: Request): Promise<Response> {
    const runtime = config.managedRuntime;
    if (!runtime) return json(merged);
    const principal = PrincipalSchema.safeParse(await runtime.resolvePrincipal(request));
    if (!principal.success) return json({ error: 'Unauthorized' }, 401);
    let snapshot: TurnSnapshot;
    try {
      snapshot = await runtime.resolveTurnSnapshot({
        request, turnId: `interactions-${randomUUID()}`, principal: principal.data,
      });
    } catch {
      return json({ error: 'Chat interactions unavailable' }, 503);
    }
    const revocations = await runtime.loadRevocations?.({ request, snapshot }) ?? [];
    const allowed = (tool: string): boolean => {
      const manifestTool = snapshot.manifestRevision.tools.find((candidate) => (
        candidate.name === tool || modelFacingToolName(candidate.name) === modelFacingToolName(tool)
      ));
      if (!manifestTool || isToolRevoked(snapshot, manifestTool.toolId, revocations)) return false;
      return authorizeToolCall({
        principal: principal.data,
        agentRevision: snapshot.agentRevision,
        manifestRevision: snapshot.manifestRevision,
        policyRevision: snapshot.policyRevision,
        toolId: manifestTool.toolId,
      }).allowed;
    };
    const entities = merged.entities.flatMap((entity): ChatEntityData[] => {
      const actions = (entity.actions ?? []).filter((action) => allowed(action.run.tool));
      const search = entity.search && allowed(entity.search.tool) ? entity.search : undefined;
      if (!search && actions.length === 0) return [];
      const { search: _search, actions: _actions, ...rest } = entity;
      return [{ ...rest, ...(search ? { search } : {}), ...(actions.length > 0 ? { actions } : {}) }];
    });
    const commands = merged.commands.filter((command) => command.run.kind === 'prompt' || allowed(command.run.tool));
    return json({ schemaVersion: 1, entities, commands } satisfies ChatInteractionsData);
  };
}
````

In `src/server/adapters/nextjs/index.ts`, replace:

```ts
  type ClarificationResume,
} from './clarification-resume.js';

// Re-export from server-node for convenience
```

with:

```ts
  type ClarificationResume,
} from './clarification-resume.js';
export {
  createChatInteractionsHandler,
  type ChatInteractionsHandlerConfig,
} from './chat-interactions-handler.js';
export {
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
  type DirectCommandRequest,
  type RunDirectCommandOptions,
} from './direct-command.js';
export {
  formatChatCommandMessage,
  parseChatCommandMessage,
  type ChatCommandInvocation,
} from '../../../contracts/chat-command.js';
export {
  chatText,
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatCommandData,
  type ChatEntityData,
  type ChatInteractionOverrides,
  type ChatInteractionsData,
} from '../../../contracts/chat-interactions.js';

// Re-export from server-node for convenience
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/server/adapters/nextjs/__tests__/chat-interactions-handler.test.ts --maxWorkers=4 && bunx vitest run src/server --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  4 passed (4)`; the server suites report `Test Files  44 passed (44)`, `Tests  412 passed (412)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/server/adapters/nextjs/__tests__/chat-interactions-handler.test.ts src/server/adapters/nextjs/chat-interactions-handler.ts src/server/adapters/nextjs/index.ts
git commit -m "feat(server): serve chat interactions per user next to the chat route"
```

### Task 8: Entity and command definitions, the interaction registry and its providers

**Files:**
- Create: `src/react/interactions/definitions.ts`, `src/react/interactions/registry.ts`
- Modify: `src/react/types.ts` (`CompletionItem.actions`, `MentionResult.actions`, `CompletionItemAction`), `src/react/completions/completion-search.ts` (validate and keep `actions`)
- Test: `src/react/interactions/__tests__/registry.test.ts` (Create)

**Interfaces:**
- Consumes: Tasks 1–2 (formatting, validation, `chatText`, `isChatArgumentPath`); P07 `ChatCompletionProvider`, `CompletionItem`, `MentionData`, `createCompletionSearch`, `normalizeMentionSlug`.
- Produces:
  - `definitions.ts`: `ChatEntityItem { id, label, description? }`, `ChatEntityCard { title, subtitle? }`, `ChatEntitySearchContext { signal, limit, locale, context }`, `ChatEntityAction`, `ChatEntityDefinition { type, label, icon?, search, resolve?, card?, actions? }`, `ChatCommandDefinition`, `defineChatEntity`, `defineChatCommand` (validate through `parseChatInteractions`, freeze), `toChatEntityItem`, `DerivedEntityOptions { fetch?, baseUrl? }`, `entitiesFromData(data, options)` (search with the user's cookies: `credentials: 'same-origin'`, `'include'` with a `baseUrl`).
  - `registry.ts`: `ChatInteractionsConfig { data?, entities?, commands?, locale?, context?, fetch?, baseUrl? }`, `PendingChatCommand`, `ChatSendPlan` (`send` | `prompt` | `needs-args`), `ChatInteractionRegistry { locale, providers, command, entity, searchEntity, planMessage, planAction, completeCommand }`, `createChatInteractionRegistry(config)`. Providers `chat-commands` (`/`, folded ranking like P07's UI tool provider; tool runs carry `definitionId`/`args` for the model path) and `chat-entities` (`@`, all entity searches in parallel, a failing one contributes nothing, actions attached).
  - `CompletionItem.actions?: ReadonlyArray<CompletionItemAction>` (at most 20, ids `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`, non-blank labels ≤ 200; an item with malformed actions is dropped).

- [ ] **Step 1: Write the failing tests**

Create `src/react/interactions/__tests__/registry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { createCompletionSearch } from '../../completions/completion-search.js';
import type { MentionData } from '../../types.js';
import { defineChatCommand, defineChatEntity } from '../definitions.js';
import { createChatInteractionRegistry } from '../registry.js';

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: { de: 'Aufgabe', en: 'Task' },
    search: {
      tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'],
      idField: 'id', labelField: 'title', descriptionField: 'status', limitParam: 'limit',
    },
    actions: [
      { id: 'task.tasks.complete', label: { de: 'Erledigen', en: 'Complete' }, entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
      { id: 'task.open', label: { de: 'Öffnen', en: 'Open' }, entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
    ],
  }],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, keywords: ['dashboard'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: { de: 'Aufgaben filtern', en: 'Filter Tasks' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

const person = defineChatEntity({
  type: 'person',
  label: { de: 'Person', en: 'Person' },
  search: (query) => [{ id: 'alice', label: 'Alice Example' }, { id: 'bob', label: 'Bob' }]
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
  card: (item) => ({ title: item.label, subtitle: `${item.id}@example.com` }),
});

const assign = defineChatCommand({
  id: 'tasks.assign',
  label: { de: 'Zuweisen', en: 'Assign' },
  args: [
    { name: 'taskId', label: 'Task', required: true, entity: 'task' },
    { name: 'assignee', label: 'Person', required: true, entity: 'person' },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

const standup = defineChatCommand({
  id: 'standup',
  label: { de: 'Tagesrückblick', en: 'Stand-up' },
  run: { kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.', en: 'Summarize my day.' } },
});

function tasksFetch() {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
    tasks: [{ id: 7, title: 'Release prüfen', status: 'open' }, { id: '', title: 'broken' }, { id: 'x:y', title: 'unsafe' }],
  }));
}

const mention = (type: string, id: string, label: string, prefix = '@'): MentionData => ({
  id, type, label, prefix, slug: label.toLowerCase().replace(/\s+/g, '-'),
});

describe('createChatInteractionRegistry', () => {
  it('refuses definitions the chat could not run safely', () => {
    expect(() => defineChatCommand({ id: 'open:x', label: 'X', run: { kind: 'tool', tool: 'x' } })).toThrow(/commands\[0\]\.id/);
    expect(() => defineChatEntity({ type: 'task', label: 'Task' } as never)).toThrow(/needs a search function/);
  });

  it('offers derived and app commands, the app replacing a derived id', async () => {
    const registry = createChatInteractionRegistry({
      data, locale: 'de',
      commands: [assign, standup, defineChatCommand({ id: 'open.overview', label: 'Start', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/' } } })],
    });
    const search = createCompletionSearch(registry.providers);
    expect((await search('', '/')).map((item) => item.label)).toEqual(['Aufgaben filtern', 'Start', 'Tagesrückblick', 'Zuweisen']);
    expect(await search('zuw', '/')).toEqual([{
      id: 'tasks.assign', key: 'chat-commands:command:tasks.assign', type: 'command', label: 'Zuweisen', definitionId: 'tasks.assign',
    }]);
    expect((await search('tages', '/'))[0]).not.toHaveProperty('definitionId');
    expect((await search('filtern', '/'))[0]).toMatchObject({ id: 'filter.tasks', definitionId: 'ui.filter.tasks' });
  });

  it('searches derived entities through the app endpoint with the session and offers their actions', async () => {
    const fetch = tasksFetch();
    const registry = createChatInteractionRegistry({ data, entities: [person], fetch, locale: 'en' });
    const search = createCompletionSearch(registry.providers);
    const results = await search('rel', '@');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/api/tasks?search=rel&limit=8');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' });
    expect(results).toEqual([{
      id: '7', key: 'chat-entities:task:7', type: 'task', label: 'Release prüfen', description: 'open',
      actions: [{ id: 'task.tasks.complete', label: 'Complete' }, { id: 'task.open', label: 'Open' }],
    }]);
    expect((await search('ali', '@')).filter((item) => item.type === 'person')).toEqual([{
      id: 'alice', key: 'chat-entities:person:alice', type: 'person', label: 'Alice Example', description: 'alice@example.com',
    }]);
  });

  it('drops results whose actions the composer could not offer safely', async () => {
    const search = createCompletionSearch([{
      id: 'custom', trigger: '@',
      search: () => [
        { id: 'a', type: 'task', label: 'Valid', actions: [{ id: 'task.open', label: 'Open' }] },
        { id: 'b', type: 'task', label: 'Bad id', actions: [{ id: 'open:now', label: 'Open' }] },
        { id: 'c', type: 'task', label: 'Blank label', actions: [{ id: 'task.open', label: ' ' }] },
      ],
    }]);
    expect((await search('', '@')).map((item) => item.id)).toEqual(['a']);
  });

  it('searches one entity type for argument fields, with the permission context', async () => {
    const search = vi.fn((_query: string, _context: unknown) => [{ id: 'alice', label: 'Alice' }, { id: '', label: 'broken' }]);
    const registry = createChatInteractionRegistry({
      entities: [defineChatEntity({ type: 'person', label: 'Person', search })],
      context: { roles: ['member'] },
    });
    expect(await registry.searchEntity('person', 'al', new AbortController().signal)).toEqual([{ id: 'alice', label: 'Alice' }]);
    expect(search.mock.calls[0]![1]).toMatchObject({ limit: 8, locale: 'en', context: { roles: ['member'] } });
    expect(await registry.searchEntity('unknown', 'al', new AbortController().signal)).toEqual([]);
  });

  it('keeps the other entities when one search fails', async () => {
    const registry = createChatInteractionRegistry({
      data, entities: [person], fetch: vi.fn(async () => { throw new Error('offline'); }),
    });
    expect((await createCompletionSearch(registry.providers)('bob', '@')).map((item) => item.id)).toEqual(['bob']);
  });

  it('sends a picked command alone as a direct command, and mixed text to the model', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'en' });
    const open = mention('command', 'open.overview', 'Open Overview', '/');
    const plan = registry.planMessage('/open-overview', [open]);
    expect(plan?.status).toBe('send');
    expect(parseChatCommandMessage((plan as { text: string }).text)).toEqual({
      invocation: { commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } },
      label: '/Open Overview',
    });
    expect(registry.planMessage('/open-overview and summarize it', [open])).toBeUndefined();
    expect(registry.planMessage('Hello', [])).toBeUndefined();
  });

  it('fills entity arguments from picked references and asks for what is missing', () => {
    const registry = createChatInteractionRegistry({ data, entities: [person], commands: [assign], locale: 'en' });
    const command = mention('command', 'tasks.assign', 'Assign', '/');
    const task = mention('task', '7', 'Release prüfen');
    const alice = mention('person', 'alice', 'Alice Example');
    const full = registry.planMessage('/assign @release-prüfen @alice-example', [command, task, alice]);
    expect(parseChatCommandMessage((full as { text: string }).text)).toEqual({
      invocation: { commandId: 'tasks.assign', tool: 'tasks.assign', args: { taskId: '7', assignee: 'alice' } },
      label: '/Assign @Release prüfen @Alice Example',
    });
    const partial = registry.planMessage('/assign @release-prüfen', [command, task]);
    expect(partial).toEqual({
      status: 'needs-args',
      request: {
        commandId: 'tasks.assign', tool: 'tasks.assign', label: 'Assign', fixedArgs: {}, args: assign.args,
        values: { taskId: '7' }, valueLabels: { taskId: 'Release prüfen' },
      },
    });
    if (partial?.status !== 'needs-args') throw new Error('expected a form request');
    const completed = registry.completeCommand(partial.request, { assignee: ' bob ' });
    expect(parseChatCommandMessage((completed as { text: string }).text)?.invocation.args).toEqual({ taskId: '7', assignee: 'bob' });
    expect(registry.planMessage('/assign @release-prüfen @release-prüfen', [command, task, { ...task, id: '8' }])).toBeUndefined();
  });

  it('asks once for optional arguments and sends without the empty ones', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'en' });
    const plan = registry.planMessage('/filter-tasks', [mention('command', 'filter.tasks', 'Filter Tasks', '/')]);
    expect(plan?.status).toBe('needs-args');
    const request = (plan as { request: Parameters<typeof registry.completeCommand>[0] }).request;
    expect(parseChatCommandMessage((registry.completeCommand(request, { status: '' }) as { text: string }).text)?.invocation.args).toEqual({});
    expect(parseChatCommandMessage((registry.completeCommand(request, { status: 'done' }) as { text: string }).text)).toEqual({
      invocation: { commandId: 'filter.tasks', tool: 'ui.filter.tasks', args: { status: 'done' } }, label: '/Filter Tasks done',
    });
    expect(registry.completeCommand(request, { status: 'x'.repeat(2_100) })).toMatchObject({ status: 'needs-args', request: { error: 'invalid' } });
  });

  it('turns a prompt command into model text', () => {
    const registry = createChatInteractionRegistry({ commands: [standup], locale: 'de' });
    expect(registry.planMessage('/tagesrückblick bitte kurz', [mention('command', 'standup', 'Tagesrückblick', '/')]))
      .toEqual({ status: 'prompt', text: 'Fasse meinen Tag zusammen. bitte kurz' });
  });

  it('runs entity actions with the entity id, nested where the action needs it', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'de' });
    const target = { type: 'task', id: '7', label: 'Release prüfen' };
    expect(parseChatCommandMessage((registry.planAction(target, 'task.tasks.complete') as { text: string }).text)).toEqual({
      invocation: { commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } },
      label: '/Erledigen @Release prüfen',
    });
    expect(parseChatCommandMessage((registry.planAction(target, 'task.open') as { text: string }).text)?.invocation.args)
      .toEqual({ destination: '/tasks/:taskId', params: { taskId: '7' } });
    expect(registry.planAction(target, 'task.unknown')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/interactions/__tests__/registry.test.ts --maxWorkers=4
```

Expected: FAIL — `Cannot find module '../definitions.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

In `src/react/completions/completion-search.ts`, replace:

```ts
}

function isItem(value: unknown): value is CompletionItem {
  if (typeof value !== 'object' || value === null) return false;
```

with:

```ts
}

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function isActions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 20 && value.every((action) => (
    typeof action === 'object' && action !== null
    && typeof (action as Record<string, unknown>).id === 'string' && ACTION_ID.test((action as { id: string }).id)
    && typeof (action as Record<string, unknown>).label === 'string'
    && (action as { label: string }).label.trim().length > 0 && (action as { label: string }).label.length <= 200
  )));
}

function isItem(value: unknown): value is CompletionItem {
  if (typeof value !== 'object' || value === null) return false;
```

In `src/react/completions/completion-search.ts`, replace:

```ts
    && typeof item.label === 'string' && item.label.trim().length > 0
    && (item.definitionId === undefined && item.args === undefined
      || describeToolReference(item.definitionId, item.args) !== undefined);
}

```

with:

```ts
    && typeof item.label === 'string' && item.label.trim().length > 0
    && (item.definitionId === undefined && item.args === undefined
      || describeToolReference(item.definitionId, item.args) !== undefined)
    && isActions(item.actions);
}

```

In `src/react/completions/completion-search.ts`, replace:

```ts
          ...(item.definitionId ? { definitionId: item.definitionId } : {}),
          ...(item.args ? { args: item.args } : {}),
        });
        if (results.length >= maxResults) return results;
```

with:

```ts
          ...(item.definitionId ? { definitionId: item.definitionId } : {}),
          ...(item.args ? { args: item.args } : {}),
          ...(item.actions?.length ? { actions: item.actions.map(({ id, label }) => ({ id, label: label.trim() })) } : {}),
        });
        if (results.length >= maxResults) return results;
```

Create `src/react/interactions/definitions.ts`:

```ts
import {
  parseChatInteractions,
  type ChatCommandRun,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatLocaleCode,
  type ChatText,
  type ChatToolRun,
} from '../../contracts/chat-interactions.js';
import type { CompletionPermissionContext } from '../types.js';

/** One search hit of an entity: the app's id and what the user sees. */
export interface ChatEntityItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** Framework-neutral preview of an entity in the `@` list. */
export interface ChatEntityCard {
  readonly title: string;
  readonly subtitle?: string;
}

export interface ChatEntitySearchContext {
  /** Aborted when a newer search starts; pass it to `fetch`. */
  readonly signal: AbortSignal;
  readonly limit: number;
  readonly locale: ChatLocaleCode;
  /** What the UI knows about the user; it only hides, the app authorizes. */
  readonly context: CompletionPermissionContext;
}

export interface ChatEntityAction {
  readonly id: string;
  readonly label: ChatText;
  /** Argument that receives the entity id (dotted path, e.g. `params.taskId`). */
  readonly entityArg: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatToolRun;
}

/**
 * An `@` entity: `search` runs in the browser with the user's session
 * against the app's own endpoints; nothing goes to the Glirastes Platform.
 */
export interface ChatEntityDefinition {
  readonly type: string;
  readonly label: ChatText;
  readonly icon?: string;
  search(query: string, context: ChatEntitySearchContext):
    | Promise<ReadonlyArray<ChatEntityItem>>
    | ReadonlyArray<ChatEntityItem>;
  /** Looks one entity up by id, e.g. to pre-fill the composer (`mentionEntity`). */
  resolve?(id: string): Promise<ChatEntityItem | undefined> | ChatEntityItem | undefined;
  card?(item: ChatEntityItem): ChatEntityCard;
  readonly actions?: ReadonlyArray<ChatEntityAction>;
}

/** A `/` command; `run` decides whether the model is involved (`prompt`) or not (`tool`, `ui`). */
export interface ChatCommandDefinition {
  readonly id: string;
  readonly label: ChatText;
  readonly description?: ChatText;
  readonly keywords?: ReadonlyArray<string>;
  readonly icon?: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatCommandRun;
}

const MAX_ITEM_TEXT = 200;

/** Validates and freezes an entity definition; throws on anything the chat could not use safely. */
export function defineChatEntity<T extends ChatEntityDefinition>(definition: T): T {
  if (typeof definition.search !== 'function') throw new Error(`Chat entity ${String(definition.type)} needs a search function`);
  const { search: _search, resolve: _resolve, card: _card, ...data } = definition;
  parseChatInteractions({ schemaVersion: 1, entities: [data], commands: [] });
  return Object.freeze(definition);
}

/** Validates and freezes a command definition. */
export function defineChatCommand<T extends ChatCommandDefinition>(definition: T): T {
  parseChatInteractions({ schemaVersion: 1, entities: [], commands: [definition] });
  return Object.freeze(definition);
}

/** Keeps only well-formed hits: a non-empty id and label, bounded text. */
export function toChatEntityItem(value: unknown): ChatEntityItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'number' && Number.isFinite(item.id) ? String(item.id) : item.id;
  if (typeof id !== 'string' || !id || id.length > MAX_ITEM_TEXT || /[:}]/.test(id)) return undefined;
  if (typeof item.label !== 'string' || !item.label.trim()) return undefined;
  const description = typeof item.description === 'string' && item.description.trim()
    ? item.description.trim().slice(0, MAX_ITEM_TEXT)
    : undefined;
  return { id, label: item.label.trim().slice(0, MAX_ITEM_TEXT), ...(description ? { description } : {}) };
}

export interface DerivedEntityOptions {
  /** Defaults to the global `fetch`; the request carries the user's cookies (same origin). */
  fetch?: typeof globalThis.fetch;
  /** Prefix for the app's endpoints, e.g. a separate API origin. Default: same origin. */
  baseUrl?: string;
}

function at(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Entity definitions for derived data: searches call the app endpoint with the user's session. */
export function entitiesFromData(
  data: ChatInteractionsData,
  options: DerivedEntityOptions = {},
): ChatEntityDefinition[] {
  return data.entities.map((entity) => {
    const search = entity.search;
    return {
      type: entity.type,
      label: entity.label,
      ...(entity.icon ? { icon: entity.icon } : {}),
      ...(entity.actions ? { actions: entity.actions } : {}),
      async search(query, context) {
        if (!search) return [];
        const params = new URLSearchParams({ [search.queryParam]: query });
        if (search.limitParam) params.set(search.limitParam, String(context.limit));
        const fetcher = options.fetch ?? globalThis.fetch;
        const response = await fetcher(`${options.baseUrl ?? ''}${search.path}?${params}`, {
          signal: context.signal,
          credentials: options.baseUrl ? 'include' : 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return [];
        const list = at(await response.json() as unknown, search.itemsPath);
        if (!Array.isArray(list)) return [];
        return list
          .map((item) => toChatEntityItem({
            id: at(item, [search.idField]),
            label: at(item, [search.labelField]),
            ...(search.descriptionField ? { description: at(item, [search.descriptionField]) } : {}),
          }))
          .filter((item): item is ChatEntityItem => item !== undefined)
          .slice(0, context.limit);
      },
    } satisfies ChatEntityDefinition;
  });
}
```

Create `src/react/interactions/registry.ts`:

```ts
import {
  formatChatCommandMessage,
  serializeChatCommandArgs,
} from '../../contracts/chat-command.js';
import {
  chatText,
  isChatArgumentPath,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatLocaleCode,
} from '../../contracts/chat-interactions.js';
import type {
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  MentionData,
} from '../types.js';
import { normalizeMentionSlug } from '../utils/mention-markup.js';
import {
  entitiesFromData,
  toChatEntityItem,
  type ChatCommandDefinition,
  type ChatEntityDefinition,
  type ChatEntityItem,
  type DerivedEntityOptions,
} from './definitions.js';

export interface ChatInteractionsConfig extends DerivedEntityOptions {
  /** Derived interactions: `useChatInteractionsData(endpoint)` or the generated module's `chatInteractions`. */
  readonly data?: ChatInteractionsData;
  /** App-defined entities; one with the type of a derived entity replaces it. */
  readonly entities?: ReadonlyArray<ChatEntityDefinition>;
  /** App-defined commands; one with the id of a derived command replaces it. */
  readonly commands?: ReadonlyArray<ChatCommandDefinition>;
  /** Language of labels and default texts. Default `en`. */
  readonly locale?: ChatLocaleCode;
  /** Passed to entity searches; set by the provider from `completionContext`. */
  readonly context?: CompletionPermissionContext;
}

/** A command or entity action that still needs arguments from the user. */
export interface PendingChatCommand {
  readonly commandId: string;
  readonly tool: string;
  /** The visible name, e.g. `Assign` or `Filter Tasks`. */
  readonly label: string;
  readonly fixedArgs: Readonly<Record<string, unknown>>;
  /** Arguments the form asks for. */
  readonly args: ReadonlyArray<ChatInteractionArg>;
  /** Values already known (entity ids, picked mentions), by argument name. */
  readonly values: Readonly<Record<string, string>>;
  /** Display labels for entity values, by argument name. */
  readonly valueLabels: Readonly<Record<string, string>>;
  /** Set when the last attempt was refused, e.g. values too long. */
  readonly error?: 'invalid';
}

export type ChatSendPlan =
  /** A direct command message, ready for the transport. */
  | { readonly status: 'send'; readonly text: string }
  /** A prompt command: the text the model receives instead of the command token. */
  | { readonly status: 'prompt'; readonly text: string }
  /** The command needs arguments first; show `PendingChatCommand` as a form. */
  | { readonly status: 'needs-args'; readonly request: PendingChatCommand };

export interface ChatInteractionRegistry {
  readonly locale: ChatLocaleCode;
  /** `/` commands and `@` entities for `createCompletionSearch`. */
  readonly providers: ReadonlyArray<ChatCompletionProvider>;
  command(id: string): ChatCommandDefinition | undefined;
  entity(type: string): ChatEntityDefinition | undefined;
  /** Searches one entity type, e.g. for an argument field; failures yield no hits. */
  searchEntity(type: string, query: string, signal: AbortSignal): Promise<ChatEntityItem[]>;
  /**
   * How to send a composed message: `undefined` for a normal model message
   * (no command, several commands, or a command mixed with free text).
   */
  planMessage(text: string, mentions: ReadonlyArray<MentionData>): ChatSendPlan | undefined;
  /** An entity action picked from the `@` list. */
  planAction(entity: { type: string; id: string; label: string }, actionId: string): ChatSendPlan | undefined;
  /** Sends a pending command with the values (and entity labels) from its form, or asks again. */
  completeCommand(
    pending: PendingChatCommand,
    values: Readonly<Record<string, string>>,
    valueLabels?: Readonly<Record<string, string>>,
  ): ChatSendPlan;
}

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();
}

function rank(label: string, command: ChatCommandDefinition, needle: string): number | undefined {
  if (!needle) return 0;
  const folded = fold(label);
  if (folded.startsWith(needle)) return 0;
  if (folded.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 1;
  if (folded.includes(needle) || fold(normalizeMentionSlug(label)).includes(needle)) return 2;
  if (fold(command.id).includes(needle)) return 3;
  if ((command.keywords ?? []).some((keyword) => fold(keyword).includes(needle))) return 4;
  return undefined;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function tokenOf(mention: MentionData): string | undefined {
  return typeof mention.prefix === 'string' && typeof mention.slug === 'string'
    ? `${mention.prefix}${mention.slug}`
    : undefined;
}

function withoutToken(text: string, token: string): { text: string; found: boolean } {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`);
  return pattern.test(text) ? { text: text.replace(pattern, '$1'), found: true } : { text, found: false };
}

/**
 * Turns declarative entities and commands into completion providers and
 * send plans. App definitions replace derived ones of the same id or type.
 */
export function createChatInteractionRegistry(config: ChatInteractionsConfig): ChatInteractionRegistry {
  const locale = config.locale ?? 'en';
  const entities = new Map<string, ChatEntityDefinition>();
  for (const entity of config.data ? entitiesFromData(config.data, config) : []) entities.set(entity.type, entity);
  for (const entity of config.entities ?? []) entities.set(entity.type, entity);
  const commands = new Map<string, ChatCommandDefinition>();
  for (const command of config.data?.commands ?? []) commands.set(command.id, command);
  for (const command of config.commands ?? []) commands.set(command.id, command);

  const commandProvider: ChatCompletionProvider = {
    id: 'chat-commands',
    trigger: '/',
    search({ query, limit }) {
      const needle = fold(query);
      return [...commands.values()]
        .map((command) => {
          const label = chatText(command.label, locale);
          return { command, label, rank: rank(label, command, needle) };
        })
        .filter((entry): entry is { command: ChatCommandDefinition; label: string; rank: number } => entry.rank !== undefined)
        .sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label))
        .slice(0, limit)
        .map(({ command, label }): CompletionItem => {
          const description = chatText(command.description, locale);
          const run = command.run;
          return {
            id: command.id,
            type: 'command',
            label,
            ...(description ? { description } : {}),
            // A command mixed with free text goes to the model with its tool reference.
            ...(run.kind !== 'prompt' ? { definitionId: run.tool, ...(run.args ? { args: run.args } : {}) } : {}),
          };
        });
    },
  };

  const entityProvider: ChatCompletionProvider = {
    id: 'chat-entities',
    trigger: '@',
    async search({ query, signal, limit, context }) {
      const settled = await Promise.allSettled([...entities.values()].map(async (entity) => {
        const items = await entity.search(query, { signal, limit, locale, context });
        return (Array.isArray(items) ? items : []).slice(0, limit).map((item): CompletionItem => {
          const card = entity.card?.(item);
          const description = card?.subtitle ?? item.description;
          return {
            id: item.id,
            type: entity.type,
            label: card?.title ?? item.label,
            ...(description ? { description } : {}),
            ...(entity.actions?.length
              ? { actions: entity.actions.map((action) => ({ id: action.id, label: chatText(action.label, locale) })) }
              : {}),
          };
        });
      }));
      return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    },
  };

  const complete = (
    pending: PendingChatCommand,
    values: Readonly<Record<string, string>>,
    labels: Readonly<Record<string, string>> = {},
  ): ChatSendPlan => {
    const valueLabels = { ...pending.valueLabels, ...labels };
    const merged: Record<string, string> = { ...pending.values };
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string' && value.trim()) merged[name] = value.trim();
      else delete merged[name];
    }
    const missing = pending.args.some((arg) => arg.required && !merged[arg.name]);
    if (missing) return { status: 'needs-args', request: { ...pending, values: merged, valueLabels } };
    const args: Record<string, unknown> = structuredClone({ ...pending.fixedArgs });
    for (const [name, value] of Object.entries(merged)) {
      if (isChatArgumentPath(name)) setPath(args, name, value);
    }
    if (serializeChatCommandArgs(args) === undefined) {
      return { status: 'needs-args', request: { ...pending, values: merged, valueLabels, error: 'invalid' } };
    }
    const shown = pending.args
      .filter((arg) => merged[arg.name])
      .map((arg) => (arg.entity ? `@${valueLabels[arg.name] || merged[arg.name]}` : merged[arg.name]!));
    const entityLabels = Object.entries(valueLabels)
      .filter(([name]) => !pending.args.some((arg) => arg.name === name))
      .map(([, label]) => `@${label}`);
    return {
      status: 'send',
      text: formatChatCommandMessage({
        commandId: pending.commandId,
        tool: pending.tool,
        args,
        label: [`/${pending.label}`, ...entityLabels, ...shown].join(' '),
      }),
    };
  };

  /** Ask once when a command has arguments and none were given; otherwise send when nothing required is missing. */
  const plan = (pending: PendingChatCommand, given: number): ChatSendPlan => (
    pending.args.length > 0 && given === 0
      ? { status: 'needs-args', request: pending }
      : complete(pending, {})
  );

  return {
    locale,
    providers: [commandProvider, entityProvider],
    command: (id) => commands.get(id),
    entity: (type) => entities.get(type),
    completeCommand: complete,

    async searchEntity(type, query, signal) {
      const entity = entities.get(type);
      if (!entity) return [];
      try {
        const items = await entity.search(query, { signal, limit: 8, locale, context: config.context ?? {} });
        return (Array.isArray(items) ? items : [])
          .map(toChatEntityItem)
          .filter((item): item is ChatEntityItem => item !== undefined)
          .slice(0, 8);
      } catch {
        return [];
      }
    },

    planMessage(text, mentions) {
      const picked = mentions.filter((mention) => mention.type === 'command' && commands.has(String(mention.id)));
      if (picked.length !== 1) return undefined;
      const mention = picked[0]!;
      const command = commands.get(String(mention.id))!;
      const token = tokenOf(mention);
      if (!token) return undefined;
      const rest = withoutToken(text, token);
      if (!rest.found) return undefined;
      if (command.run.kind === 'prompt') {
        return { status: 'prompt', text: rest.text.replace(/^\s*/, `${chatText(command.run.prompt, locale)} `).trim() };
      }
      const values: Record<string, string> = {};
      const valueLabels: Record<string, string> = {};
      let remaining = rest.text;
      const entityMentions = mentions.filter((entry) => entry !== mention && entry.type !== 'command');
      const used = new Set<MentionData>();
      for (const arg of command.args ?? []) {
        if (!arg.entity) continue;
        const match = entityMentions.find((entry) => entry.type === arg.entity && !used.has(entry));
        if (!match) continue;
        used.add(match);
        values[arg.name] = String(match.id);
        valueLabels[arg.name] = typeof match.label === 'string' ? match.label : String(match.id);
      }
      for (const entry of used) {
        const entryToken = tokenOf(entry);
        if (entryToken) remaining = withoutToken(remaining, entryToken).text;
      }
      // Free text or unused references: the model decides, with the command as a tool reference.
      if (remaining.trim() || used.size !== entityMentions.length) return undefined;
      return plan({
        commandId: command.id,
        tool: command.run.tool,
        label: chatText(command.label, locale),
        fixedArgs: command.run.args ?? {},
        args: command.args ?? [],
        values,
        valueLabels,
      }, used.size);
    },

    planAction(target, actionId) {
      const action = entities.get(target.type)?.actions?.find((entry) => entry.id === actionId);
      if (!action) return undefined;
      return plan({
        commandId: action.id,
        tool: action.run.tool,
        label: chatText(action.label, locale),
        fixedArgs: action.run.args ?? {},
        args: action.args ?? [],
        values: { [action.entityArg]: target.id },
        valueLabels: { [action.entityArg]: target.label },
      }, 0);
    },
  };
}
```

In `src/react/types.ts`, replace:

```ts
  /** Tool-backed commands: fixed arguments for the definition. */
  args?: Readonly<Record<string, unknown>>;
}

```

with:

```ts
  /** Tool-backed commands: fixed arguments for the definition. */
  args?: Readonly<Record<string, unknown>>;
  /** Entity actions offered next to this result (see `CompletionItem.actions`). */
  actions?: ReadonlyArray<CompletionItemAction>;
}

```

In `src/react/types.ts`, replace:

```ts
  /** Fixed arguments for `definitionId` (needs `definitionId`), e.g. `{ destination: 'overview' }`. */
  args?: Readonly<Record<string, unknown>>;
}

```

with:

```ts
  /** Fixed arguments for `definitionId` (needs `definitionId`), e.g. `{ destination: 'overview' }`. */
  args?: Readonly<Record<string, unknown>>;
  /**
   * Context actions of an `@` entity (e.g. "Open", "Complete"), offered next
   * to it in the list and reachable by keyboard (ArrowRight/ArrowLeft).
   */
  actions?: ReadonlyArray<CompletionItemAction>;
}

export interface CompletionItemAction {
  /** Action id (`[A-Za-z0-9._-]`, max 200). */
  id: string;
  label: string;
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/interactions/__tests__/registry.test.ts --maxWorkers=4 && bunx vitest run src/react/completions src/react/interactions --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  11 passed (11)`; the completion and interaction suites (`bunx vitest run src/react/completions src/react/interactions --maxWorkers=4`) report `Test Files  3 passed (3)`, `Tests  36 passed (36)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/react/completions/completion-search.ts src/react/interactions/__tests__/registry.test.ts src/react/interactions/definitions.ts src/react/interactions/registry.ts src/react/types.ts
git commit -m "feat(react): add chat entity and command definitions and providers"
```

### Task 9: Send direct commands from the chat provider

**Files:**
- Create: `src/react/interactions/use-chat-interactions-data.ts`
- Modify: `src/react/provider/ai-chat-provider.tsx` (registry, send plan, pending command, `mentionEntity`), `src/react/provider/chat-context.ts`, `src/react/types.ts` (`AiChatProviderConfig.chatInteractions`), `src/react/components/message-bubble.tsx` (label only), `src/react/index.ts` (exports)
- Test: `src/react/provider/__tests__/chat-interactions.test.tsx` (Create)

**Interfaces:**
- Consumes: Task 8 registry; P07 provider (`completionProviders`, `completionContext`, `serializeMentionsForSend`, clarification answer wrapping, approval auto-reject).
- Produces:
  - `AiChatProviderConfig.chatInteractions?: ChatInteractionsConfig` (memoize); its providers join `completionProviders` (ids `chat-commands` and `chat-entities` are reserved), the registry gets `completionContext`.
  - `ChatContextValue` gains `interactions?`, `pendingCommand`, `submitPendingCommand(values, valueLabels?)`, `cancelPendingCommand()`, `runEntityAction(entity, actionId)`, `mentionEntity(type, id): Promise<boolean>`, `composerMentions`, `consumeComposerMentions()`.
  - `send` asks the registry first: `send` ⇒ the marker message goes straight to the transport (no mention markup, no `onBeforeSend`, no clarification wrapping); `needs-args` ⇒ `pendingCommand`, nothing sent; `prompt` ⇒ the prompt text continues the normal path. The transport tail (truncation reset, sanitizing, approval auto-reject, `sendMessage`) is shared as `deliver`.
  - `useChatInteractionsData(endpoint, { headers?, fetch?, onError? })`: one GET per endpoint, validated with `parseChatInteractions`, `undefined` on failure.
  - Exports from `glirastes/react`: Tasks 1–2 helpers and types, Task 8 definitions and registry, the hook.

- [ ] **Step 1: Write the failing tests**

Create `src/react/provider/__tests__/chat-interactions.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatChatCommandMessage, parseChatCommandMessage } from '../../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { MessageBubble } from '../../components/message-bubble.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { useChatInteractionsData } from '../../interactions/use-chat-interactions-data.js';
import type { ChatMessage, ChatTransport, MentionData } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../chat-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: 'Task',
    actions: [{ id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } }],
  }],
  commands: [
    { id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: 'Filter Tasks',
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: () => [{ id: 'alice', label: 'Alice' }],
  resolve: (id) => (id === 'alice' ? { id: 'alice', label: 'Alice Example' } : undefined),
});

const standup = defineChatCommand({ id: 'standup', label: 'Stand-up', run: { kind: 'prompt', prompt: 'Summarize my day.' } });

function transport(messages: ChatMessage[] = []): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages,
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function mount(chat: ChatTransport) {
  let context: ChatContextValue | undefined;
  function Probe() {
    context = useChatContext();
    return null;
  }
  function Harness({ children }: { children?: ReactNode }) {
    const interactions = useMemo(() => ({ data, entities: [person], commands: [standup] }), []);
    return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe />{children}</AiChatProvider>;
  }
  render(<Harness />);
  return () => context!;
}

const command = (id: string, slug: string): MentionData => ({ id, type: 'command', label: slug, prefix: '/', slug });

describe('chat interactions in AiChatProvider', () => {
  it('sends a command picked alone as a direct command, skipping mention markup', async () => {
    const chat = transport();
    const context = mount(chat);
    await act(async () => { context().send('/open-overview', { mentions: [command('open.overview', 'open-overview')] }); });
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    const sent = chat.sendMessage.mock.calls[0]![0].text as string;
    expect(parseChatCommandMessage(sent)?.invocation).toEqual({
      commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' },
    });
    expect(sent).not.toContain('<!--context');
  });

  it('opens the pending command for missing arguments and sends the completed command', async () => {
    const chat = transport();
    const context = mount(chat);
    await act(async () => { context().send('/filter-tasks', { mentions: [command('filter.tasks', 'filter-tasks')] }); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(context().pendingCommand).toMatchObject({ commandId: 'filter.tasks', label: 'Filter Tasks' });
    await act(async () => { context().submitPendingCommand({ status: 'done' }); });
    expect(context().pendingCommand).toBeNull();
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation.args).toEqual({ status: 'done' });

    await act(async () => { context().send('/filter-tasks', { mentions: [command('filter.tasks', 'filter-tasks')] }); });
    await act(async () => { context().cancelPendingCommand(); });
    expect(context().pendingCommand).toBeNull();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('runs an entity action with the entity id and lets a prompt command reach the model', async () => {
    const chat = transport();
    const context = mount(chat);
    await act(async () => { context().runEntityAction({ type: 'task', id: '7', label: 'Release prüfen' }, 'task.tasks.complete'); });
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } },
      label: '/Complete @Release prüfen',
    });
    await act(async () => { context().send('/stand-up', { mentions: [command('standup', 'stand-up')] }); });
    expect(chat.sendMessage.mock.calls[1]![0]).toEqual({ text: 'Summarize my day.' });
  });

  it('queues a resolved entity reference for the composer and refuses unknown ids', async () => {
    const context = mount(transport());
    let added = false;
    await act(async () => { added = await context().mentionEntity('person', 'alice'); });
    expect(added).toBe(true);
    expect(context().composerMentions).toEqual([{
      id: 'alice', type: 'person', label: 'Alice Example', displayName: 'Alice Example', prefix: '@', slug: 'alice-example',
    }]);
    await act(async () => { context().consumeComposerMentions(); });
    expect(context().composerMentions).toEqual([]);
    await act(async () => { added = await context().mentionEntity('person', 'mallory'); });
    expect(added).toBe(false);
    await act(async () => { added = await context().mentionEntity('task', '7'); });
    expect(added).toBe(false);
  });

  it('shows a sent command by its label only', () => {
    const text = formatChatCommandMessage({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' }, label: '/Open Overview' });
    const message: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
    const view = render(<AiChatProvider transport={transport([message])}><MessageBubble message={message} /></AiChatProvider>);
    expect(view.container.textContent).toContain('/Open Overview');
    expect(view.container.innerHTML).not.toContain('glirastes:command');
  });
});

describe('useChatInteractionsData', () => {
  it('loads and validates the interactions once per endpoint', async () => {
    const fetch = vi.fn(async () => Response.json(data));
    const { result } = renderHook(() => useChatInteractionsData('/chat', { fetch }));
    await waitFor(() => expect(result.current).toEqual(data));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/chat', expect.objectContaining({ method: 'GET', credentials: 'same-origin' })]);
  });

  it('reports refused or invalid responses and keeps the chat without interactions', async () => {
    const onError = vi.fn();
    const invalid = vi.fn(async () => Response.json({ schemaVersion: 1, entities: [], commands: [{ id: 'x' }] }));
    const { result } = renderHook(() => useChatInteractionsData('/chat', { fetch: invalid, onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    renderHook(() => useChatInteractionsData('/chat', { fetch: refused, onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/provider/__tests__/chat-interactions.test.tsx --maxWorkers=4
```

Expected: FAIL — `Cannot find module '../../interactions/use-chat-interactions-data.js'`. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

In `src/react/components/message-bubble.tsx`, replace:

```tsx
  stripClarificationMarkers,
} from '../../contracts/clarification.js';
import type { MessageBubbleProps, TextPart } from '../types.js';

```

with:

```tsx
  stripClarificationMarkers,
} from '../../contracts/clarification.js';
import { stripChatCommandMarkers } from '../../contracts/chat-command.js';
import type { MessageBubbleProps, TextPart } from '../types.js';

```

In `src/react/components/message-bubble.tsx`, replace:

```tsx
    .filter(isTextPart)
    .filter((p) => p.text.trim())
    .map((p) => stripClarificationMarkers(stripContextBlocks(p.text)))
    .map((text) => (
      message.role === 'assistant'
```

with:

```tsx
    .filter(isTextPart)
    .filter((p) => p.text.trim())
    .map((p) => stripChatCommandMarkers(stripClarificationMarkers(stripContextBlocks(p.text))))
    .map((text) => (
      message.role === 'assistant'
```

In `src/react/index.ts`, replace:

```ts
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  CompletionSearchRequest,
```

with:

```ts
  ChatCompletionProvider,
  CompletionItem,
  CompletionItemAction,
  CompletionPermissionContext,
  CompletionSearchRequest,
```

In `src/react/index.ts`, replace:

```ts
export { createUiToolCommandProvider } from './completions/ui-tool-command-provider.js';

// Bridges
export {
```

with:

```ts
export { createUiToolCommandProvider } from './completions/ui-tool-command-provider.js';

// Declarative chat interactions: `@` entities and `/` commands
export {
  defineChatCommand,
  defineChatEntity,
  entitiesFromData,
  type ChatCommandDefinition,
  type ChatEntityAction,
  type ChatEntityCard,
  type ChatEntityDefinition,
  type ChatEntityItem,
  type ChatEntitySearchContext,
  type DerivedEntityOptions,
} from './interactions/definitions.js';
export {
  createChatInteractionRegistry,
  type ChatInteractionRegistry,
  type ChatInteractionsConfig,
  type ChatSendPlan,
  type PendingChatCommand,
} from './interactions/registry.js';
export {
  useChatInteractionsData,
  type UseChatInteractionsDataOptions,
} from './interactions/use-chat-interactions-data.js';
export {
  formatChatCommandMessage,
  parseChatCommandMessage,
  stripChatCommandMarkers,
  type ChatCommandInvocation,
} from '../contracts/chat-command.js';
export {
  chatText,
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatCommandData,
  type ChatCommandRun,
  type ChatEntityActionData,
  type ChatEntityData,
  type ChatInteractionArg,
  type ChatInteractionOverrides,
  type ChatInteractionsData,
  type ChatLocaleCode,
  type ChatText,
  type ChatToolRun,
} from '../contracts/chat-interactions.js';

// Bridges
export {
```

Create `src/react/interactions/use-chat-interactions-data.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import {
  parseChatInteractions,
  type ChatInteractionsData,
} from '../../contracts/chat-interactions.js';

export interface UseChatInteractionsDataOptions {
  headers?: Record<string, string>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** A failed request or invalid data; the chat then runs without interactions. */
  onError?: (error: unknown) => void;
}

/**
 * Loads the chat's `@` entities and `/` commands from the GET handler of
 * `createChatInteractionsHandler` (usually the chat endpoint itself), once
 * per endpoint and with the user's session. `undefined` until loaded or when
 * the request fails.
 */
export function useChatInteractionsData(
  endpoint: string | undefined,
  options: UseChatInteractionsDataOptions = {},
): ChatInteractionsData | undefined {
  const [data, setData] = useState<ChatInteractionsData | undefined>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!endpoint) return undefined;
    const controller = new AbortController();
    const { fetch: fetcher = globalThis.fetch, headers } = optionsRef.current;
    void (async () => {
      try {
        const response = await fetcher(endpoint, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json', ...headers },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Chat interactions request failed (${response.status})`);
        const parsed = parseChatInteractions(await response.json());
        if (!controller.signal.aborted) setData(parsed);
      } catch (error) {
        if (!controller.signal.aborted) optionsRef.current.onError?.(error);
      }
    })();
    return () => controller.abort();
  }, [endpoint]);

  return data;
}
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  SessionSummary,
} from '../types.js';
import { serializeMentionsForSend } from '../utils/mention-markup.js';
import { mergePipelineSteps } from '../utils/merge-pipeline-steps.js';
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import { clarificationAnswerMessage, findOpenClarification } from '../utils/clarification.js';
import { createCompletionSearch } from '../completions/completion-search.js';
import { createToolResultRendererRegistry } from '../tool-renderers/registry.js';
import { dispatchToolResultUiActions } from '../../browser/client-actions.js';
```

with:

```tsx
  SessionSummary,
} from '../types.js';
import { normalizeMentionSlug, serializeMentionsForSend } from '../utils/mention-markup.js';
import { mergePipelineSteps } from '../utils/merge-pipeline-steps.js';
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import { clarificationAnswerMessage, findOpenClarification } from '../utils/clarification.js';
import { createCompletionSearch } from '../completions/completion-search.js';
import { toChatEntityItem } from '../interactions/definitions.js';
import {
  createChatInteractionRegistry,
  type PendingChatCommand,
} from '../interactions/registry.js';
import { createToolResultRendererRegistry } from '../tool-renderers/registry.js';
import { dispatchToolResultUiActions } from '../../browser/client-actions.js';
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  completionContext,
  onCompletionProviderError,
  toolRenderers,
  toolResults: userToolResults,
```

with:

```tsx
  completionContext,
  onCompletionProviderError,
  chatInteractions,
  toolRenderers,
  toolResults: userToolResults,
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  const onCompletionProviderErrorRef = useRef(onCompletionProviderError);
  onCompletionProviderErrorRef.current = onCompletionProviderError;
  const completionSearch = useMemo(
    () => (completionProviders && completionProviders.length > 0
      ? createCompletionSearch(completionProviders, {
        context: completionContext,
        onProviderError: (providerId, error) =>
          onCompletionProviderErrorRef.current?.(providerId, error),
      })
      : undefined),
    [completionProviders, completionContext],
  );

  // Refs for deduplication
```

with:

```tsx
  const onCompletionProviderErrorRef = useRef(onCompletionProviderError);
  onCompletionProviderErrorRef.current = onCompletionProviderError;
  // Declarative `@` entities and `/` commands join the app's own providers.
  const interactionRegistry = useMemo(
    () => (chatInteractions
      ? createChatInteractionRegistry({ ...chatInteractions, context: completionContext })
      : undefined),
    [chatInteractions, completionContext],
  );
  const allCompletionProviders = useMemo(
    () => [...(completionProviders ?? []), ...(interactionRegistry?.providers ?? [])],
    [completionProviders, interactionRegistry],
  );
  const completionSearch = useMemo(
    () => (allCompletionProviders.length > 0
      ? createCompletionSearch(allCompletionProviders, {
        context: completionContext,
        onProviderError: (providerId, error) =>
          onCompletionProviderErrorRef.current?.(providerId, error),
      })
      : undefined),
    [allCompletionProviders, completionContext],
  );
  const [pendingCommand, setPendingCommand] = useState<PendingChatCommand | null>(null);
  const [composerMentions, setComposerMentions] = useState<MentionData[]>([]);

  // Refs for deduplication
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx

  // Actions
  const send = useCallback(async (
    message: string,
    sendOptions?: { mentions?: MentionData[] },
  ) => {
    const mentionsForSend = sendOptions?.mentions ?? activeMentions;
    if (sessionNotReady || sessionMutationRef.current) return;
    // Clear truncation and suggestion chips on new message
    setTruncation(null);
    setSuggestionChips([]);
    setPipelineSteps([]);
    setPipelineState(null);

    // Preprocess message
    let processedMessage = message;
    const mentionSerializeConfig = mentions?.serialize;
    if (mentionSerializeConfig?.enabled !== false) {
```

with:

```tsx

  // Actions
  // The shared tail of every send: transport hygiene, then the transport.
  const deliver = useCallback(async (processedMessage: string) => {
    // Clear truncation and suggestion chips on new message
    setTruncation(null);
    setSuggestionChips([]);
    setPipelineSteps([]);
    setPipelineState(null);

    // Sanitize messages before sending to prevent AI_MissingToolResultsError
    const currentMessages = rawMessages;
    const sanitized = sanitizeMessages(currentMessages as unknown as Array<{ role: string; parts: unknown[] }>);
    if (sanitized.length !== currentMessages.length || JSON.stringify(sanitized) !== JSON.stringify(currentMessages)) {
      setMessages(sanitized as unknown as typeof rawMessages);
      setPendingApprovalsMap(new Map());
    }

    // Auto-reject pending approvals when user sends new message
    if (pendingApprovalsMap.size > 0) {
      const approvalIds = Array.from(pendingApprovalsMap.keys());
      setPendingApprovalsMap(new Map());
      for (const approvalId of approvalIds) {
        await addToolApprovalResponse({
          id: approvalId,
          approved: false,
          reason: 'Auto-rejected: user sent a new message.',
        });
      }
    }

    await sendMessage({ text: processedMessage });
    setActiveMentions([]);
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setIsMentionSearching(false);
  }, [
    rawMessages,
    setMessages,
    sendMessage,
    addToolApprovalResponse,
    pendingApprovalsMap,
  ]);

  const send = useCallback(async (
    message: string,
    sendOptions?: { mentions?: MentionData[] },
  ) => {
    const mentionsForSend = sendOptions?.mentions ?? activeMentions;
    if (sessionNotReady || sessionMutationRef.current) return;

    // A `/` command alone runs without the model; missing arguments open its form.
    const plan = interactionRegistry?.planMessage(message, mentionsForSend);
    if (plan?.status === 'needs-args') {
      setPendingCommand(plan.request);
      return;
    }
    if (plan?.status === 'send') {
      setPendingCommand(null);
      await deliver(plan.text);
      return;
    }

    // Preprocess message
    let processedMessage = plan?.status === 'prompt' ? plan.text : message;
    const mentionSerializeConfig = mentions?.serialize;
    if (mentionSerializeConfig?.enabled !== false) {
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
    }

    // Sanitize messages before sending to prevent AI_MissingToolResultsError
    const currentMessages = rawMessages;
    const sanitized = sanitizeMessages(currentMessages as unknown as Array<{ role: string; parts: unknown[] }>);
    if (sanitized.length !== currentMessages.length || JSON.stringify(sanitized) !== JSON.stringify(currentMessages)) {
      setMessages(sanitized as unknown as typeof rawMessages);
      setPendingApprovalsMap(new Map());
    }

    // Auto-reject pending approvals when user sends new message
    if (pendingApprovalsMap.size > 0) {
      const approvalIds = Array.from(pendingApprovalsMap.keys());
      setPendingApprovalsMap(new Map());
      for (const approvalId of approvalIds) {
        await addToolApprovalResponse({
          id: approvalId,
          approved: false,
          reason: 'Auto-rejected: user sent a new message.',
        });
      }
    }

    await sendMessage({ text: processedMessage });
    setActiveMentions([]);
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setIsMentionSearching(false);
  }, [
    sessionNotReady,
    rawMessages,
    setMessages,
    sendMessage,
    addToolApprovalResponse,
    pendingApprovalsMap,
    mentions,
    onBeforeSend,
    activeMentions,
  ]);

  const stop = useCallback(() => {
```

with:

```tsx
    }

    await deliver(processedMessage);
  }, [
    sessionNotReady,
    rawMessages,
    deliver,
    interactionRegistry,
    mentions,
    onBeforeSend,
    activeMentions,
  ]);

  const submitPendingCommand = useCallback((
    values: Readonly<Record<string, string>>,
    valueLabels?: Readonly<Record<string, string>>,
  ) => {
    if (!pendingCommand || !interactionRegistry || sessionNotReady || sessionMutationRef.current) return;
    const plan = interactionRegistry.completeCommand(pendingCommand, values, valueLabels);
    if (plan.status !== 'send') {
      setPendingCommand(plan.status === 'needs-args' ? plan.request : null);
      return;
    }
    setPendingCommand(null);
    void deliver(plan.text);
  }, [pendingCommand, interactionRegistry, sessionNotReady, deliver]);

  const cancelPendingCommand = useCallback(() => setPendingCommand(null), []);

  const runEntityAction = useCallback((
    entity: { type: string; id: string; label: string },
    actionId: string,
  ) => {
    if (sessionNotReady || sessionMutationRef.current) return;
    const plan = interactionRegistry?.planAction(entity, actionId);
    if (!plan) return;
    if (plan.status === 'needs-args') {
      setPendingCommand(plan.request);
      return;
    }
    setPendingCommand(null);
    void deliver(plan.text);
  }, [interactionRegistry, sessionNotReady, deliver]);

  const mentionEntity = useCallback(async (type: string, id: string): Promise<boolean> => {
    const entity = interactionRegistry?.entity(type);
    if (!entity?.resolve) return false;
    let item;
    try {
      item = toChatEntityItem(await entity.resolve(id));
    } catch {
      return false;
    }
    if (!item) return false;
    const resolved = item;
    setComposerMentions((previous) => [...previous, {
      id: resolved.id,
      type,
      label: resolved.label,
      displayName: resolved.label,
      prefix: '@',
      slug: normalizeMentionSlug(resolved.label),
    }]);
    return true;
  }, [interactionRegistry]);

  const consumeComposerMentions = useCallback(() => setComposerMentions([]), []);

  const stop = useCallback(() => {
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
    setActiveMentions([]);
    setIsMentionSearching(false);
    setSuggestionChips(suggestionsConfig.staticChips ?? []);
  }, [setMessages, activeSessionId, suggestionsConfig.staticChips]);
```

with:

```tsx
    setActiveMentions([]);
    setIsMentionSearching(false);
    setPendingCommand(null);
    setSuggestionChips(suggestionsConfig.staticChips ?? []);
  }, [setMessages, activeSessionId, suggestionsConfig.staticChips]);
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
      completionSearch,
      hasCompletions: completionSearch !== undefined,
      suggestionChips,
      selectSuggestion,
```

with:

```tsx
      completionSearch,
      hasCompletions: completionSearch !== undefined,
      interactions: interactionRegistry,
      pendingCommand,
      submitPendingCommand,
      cancelPendingCommand,
      runEntityAction,
      mentionEntity,
      composerMentions,
      consumeComposerMentions,
      suggestionChips,
      selectSuggestion,
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
      isMentionSearching,
      completionSearch,
      suggestionChips,
      selectSuggestion,
```

with:

```tsx
      isMentionSearching,
      completionSearch,
      interactionRegistry,
      pendingCommand,
      submitPendingCommand,
      cancelPendingCommand,
      runEntityAction,
      mentionEntity,
      composerMentions,
      consumeComposerMentions,
      suggestionChips,
      selectSuggestion,
```

In `src/react/provider/chat-context.ts`, replace:

```ts
} from '../types.js';
import type { CompletionSearch } from '../completions/completion-search.js';
import type { ToolResultRendererRegistry } from '../tool-renderers/registry.js';

```

with:

```ts
} from '../types.js';
import type { CompletionSearch } from '../completions/completion-search.js';
import type { ChatInteractionRegistry, PendingChatCommand } from '../interactions/registry.js';
import type { ToolResultRendererRegistry } from '../tool-renderers/registry.js';

```

In `src/react/provider/chat-context.ts`, replace:

```ts
  hasCompletions: boolean;

  // Suggestions
  suggestionChips: string[];
```

with:

```ts
  hasCompletions: boolean;

  // Declarative chat interactions (`chatInteractions`)
  /** `@` entities and `/` commands; absent without `chatInteractions`. */
  interactions?: ChatInteractionRegistry;
  /** A command or entity action waiting for arguments; the composer shows its form. */
  pendingCommand: PendingChatCommand | null;
  /** Runs the pending command with the form values (and picked entity labels), or keeps asking. */
  submitPendingCommand: (
    values: Readonly<Record<string, string>>,
    valueLabels?: Readonly<Record<string, string>>,
  ) => void;
  cancelPendingCommand: () => void;
  /** Runs an entity action picked from the `@` list, without the model. */
  runEntityAction: (entity: { type: string; id: string; label: string }, actionId: string) => void;
  /**
   * Adds a reference to one entity to the composer, looked up by id through
   * its definition's `resolve`. False when the entity is unknown or refused.
   */
  mentionEntity: (type: string, id: string) => Promise<boolean>;
  /** References queued by `mentionEntity`, for the composer to insert. */
  composerMentions: MentionData[];
  consumeComposerMentions: () => void;

  // Suggestions
  suggestionChips: string[];
```

In `src/react/types.ts`, replace:

```ts
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';

export type {
```

with:

```ts
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';
import type { ChatInteractionsConfig } from './interactions/registry.js';

export type {
```

In `src/react/types.ts`, replace:

```ts
  completionContext?: CompletionPermissionContext;
  onCompletionProviderError?: (providerId: string, error: unknown) => void;
  toolResults?: ToolResultDisplayConfig;
  voice?: VoiceInputConfig;
```

with:

```ts
  completionContext?: CompletionPermissionContext;
  onCompletionProviderError?: (providerId: string, error: unknown) => void;
  /**
   * Declarative `@` entities and `/` commands: derived `data` (from
   * `useChatInteractionsData` or the generated module) plus app definitions
   * (`defineChatEntity`, `defineChatCommand`). Memoize the object. A `/`
   * command sent alone runs its tool without the model, through the server's
   * normal authorization and confirmation.
   */
  chatInteractions?: ChatInteractionsConfig;
  toolResults?: ToolResultDisplayConfig;
  voice?: VoiceInputConfig;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/provider/__tests__/chat-interactions.test.tsx --maxWorkers=4 && bunx vitest run src/react --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  7 passed (7)`; the React suites (`bunx vitest run src/react --maxWorkers=4`) report `Test Files  37 passed (37)`, `Tests  303 passed (303)`; typecheck clean. On a loaded machine the timing-sensitive `floating-chat-ui`, `voice-draft` and `voice-push-to-talk` files can hit the 5-second timeout; rerun such a file alone before treating it as a failure.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/react/components/message-bubble.tsx src/react/index.ts src/react/interactions/use-chat-interactions-data.ts src/react/provider/__tests__/chat-interactions.test.tsx src/react/provider/ai-chat-provider.tsx src/react/provider/chat-context.ts src/react/types.ts
git commit -m "feat(react): send direct commands from the chat provider"
```

### Task 10: Listbox semantics, entity actions and a reliable caret in the composer

**Files:**
- Modify: `src/react/components/rich-mention-input.tsx` (ARIA, live region, entity actions, typed trigger as prefix, caret moved synchronously after a pick), `src/react/components/mention-input.tsx` (entity actions, queued mentions), `src/react/types.ts` (`MentionDropdownOptionProps`, `RichMentionInputProps.onEntityAction|listLabel|resultsLabel`, locale keys), `src/react/provider/ai-chat-provider.tsx` (locale defaults)
- Test: `src/react/components/__tests__/chat-interactions-composer.test.tsx` (Create)

**Interfaces:**
- Consumes: Task 9 context (`runEntityAction`, `composerMentions`, `consumeComposerMentions`); Task 8 `MentionResult.actions`.
- Produces:
  - Editor: `aria-autocomplete="list"`, `aria-controls` (listbox id while open), `aria-activedescendant` (active option); a `role="status"` live region (`{count} suggestions`, visually hidden inline). List: `role="listbox"` with `aria-label`; options `role="option"` with ids and `aria-selected`; a result with actions is a `role="group"` row whose actions are further options (`aria-label` `Action: Entity`).
  - Keys: ArrowUp/ArrowDown rows, ArrowRight/ArrowLeft between a result and its actions (only intercepted where an action exists, otherwise they move the caret), Enter/Tab activate, Escape closes. Picking an action removes the typed `@query` and calls `onEntityAction(result, actionId)`.
  - `MentionDropdownItemProps.optionProps` (custom `DropdownItem`s spread it onto their clickable element). Mention prefix = the trigger the user typed (`@` for any entity found with `@`; `/` for commands); before, a `task` result typed with `@` became `/task`. The caret now moves synchronously after a pick (keys typed in the same frame landed in front of the token before).
  - Locale keys `completionListLabel` (`Suggestions`), `completionResultsLabel` (`{count} suggestions`).

- [ ] **Step 1: Write the failing tests**

Create `src/react/components/__tests__/chat-interactions-composer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import type { ChatTransport } from '../../types.js';
import { MentionInput } from '../mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen', description: 'open' }, { id: '8', label: 'Report schreiben' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
  actions: [
    { id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
    { id: 'task.open', label: 'Open', entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
  ],
});

const commands = [
  defineChatCommand({ id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } }),
  defineChatCommand({ id: 'open.tasks', label: 'Open Tasks', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } }),
];

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let context: ChatContextValue | undefined;
function Probe() {
  context = useChatContext();
  return null;
}

function Composer({ chat }: { chat: ChatTransport }) {
  const interactions = useMemo(() => ({ entities: [task], commands }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe /><MentionInput /></AiChatProvider>;
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
// Picking a result moves the caret in an animation frame; let it land before the next test.
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
});

async function open(query: string) {
  const chat = transport();
  render(<Composer chat={chat} />);
  const editor = screen.getByRole('textbox');
  typeInto(editor, query);
  const listbox = await screen.findByRole('listbox', { name: 'Suggestions' });
  return { chat, editor, listbox };
}

describe('composer keyboard and ARIA for chat interactions', () => {
  it('exposes the suggestions as a listbox the editor controls and announces the count', async () => {
    const { editor, listbox } = await open('/open');
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Open Overview', 'Open Tasks']);
    expect(editor.getAttribute('aria-autocomplete')).toBe('list');
    expect(editor.getAttribute('aria-controls')).toBe(listbox.id);
    expect(editor.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('2 suggestions');
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editor.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('runs a picked command without the model when it is sent alone', async () => {
    const { chat, editor } = await open('/open');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.textContent).toBe('/open-overview '));
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation)
      .toEqual({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } });
  });

  it('reaches entity actions with ArrowRight and runs them with Enter', async () => {
    const { chat, editor } = await open('@rel');
    const row = screen.getByRole('group', { name: 'Release prüfen' });
    expect(row.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(fireEvent.keyDown(editor, { key: 'ArrowRight' })).toBe(false);
    const complete = screen.getByRole('option', { name: 'Complete: Release prüfen' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(complete.id);
    expect(complete.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(complete.id);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } },
      label: '/Complete @Release prüfen',
    });
    expect(editor.textContent).toBe('');
  });

  it('runs an entity action by mouse and leaves the caret keys alone where there is no action', async () => {
    const { chat, editor } = await open('@rep');
    expect(screen.queryByRole('group')).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(fireEvent.keyDown(editor, { key: 'ArrowLeft' })).toBe(true);
    fireEvent.click(screen.getByRole('option', { name: 'Open: Report schreiben' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation.args)
      .toEqual({ destination: '/tasks/:taskId', params: { taskId: '8' } });
  });

  it('inserts a picked entity as a structured reference the model receives', async () => {
    const { chat, editor } = await open('@rel');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-type="task"]')).toBeTruthy());
    expect(editor.querySelector('[data-mention-type="task"]')!.getAttribute('data-mention-prefix')).toBe('@');
    editor.append(document.createTextNode('ist fertig?'));
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(chat.sendMessage.mock.calls[0]![0].text).toBe('{{mention:task:7:Release prüfen}} ist fertig?');
  });

  it('adds an entity reference requested by the app through its definition', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    await act(async () => { await context!.mentionEntity('task', '7'); });
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(editor.querySelector('[data-mention-id="7"]')?.textContent).toContain('Release prüfen'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/components/__tests__/chat-interactions-composer.test.tsx --maxWorkers=4
```

Expected: FAIL — the list has no `listbox` role (`Unable to find role="listbox"`), entity rows have no actions and queued mentions never reach the editor. `Test Files  1 failed (1)`, `Tests  6 failed (6)`

- [ ] **Step 3: Implement**

In `src/react/components/mention-input.tsx`, replace:

```tsx
import { useState, useRef, useCallback, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
```

with:

```tsx
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
```

In `src/react/components/mention-input.tsx`, replace:

```tsx
    completionSearch,
    voice,
  } = useChatContext();
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;

  const submit = useCallback((text: string, mentions: MentionData[]) => {
```

with:

```tsx
    completionSearch,
    voice,
    runEntityAction,
    composerMentions,
    consumeComposerMentions,
  } = useChatContext();
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;

  // References added from outside the composer (`mentionEntity`).
  useEffect(() => {
    const handle = inputRef.current;
    if (!handle || composerMentions.length === 0) return;
    for (const mention of composerMentions) handle.addMention(mention);
    consumeComposerMentions();
    setValue(handle.getValue());
  }, [composerMentions, consumeComposerMentions]);

  const submit = useCallback((text: string, mentions: MentionData[]) => {
```

In `src/react/components/mention-input.tsx`, replace:

```tsx
          placeholder={locale.placeholder}
          disabled={isLoading}
        />
        {voice.enabled && (
```

with:

```tsx
          placeholder={locale.placeholder}
          disabled={isLoading}
          onEntityAction={(result, actionId) => runEntityAction(
            { type: result.type, id: result.id, label: result.label },
            actionId,
          )}
          listLabel={locale.completionListLabel}
          resultsLabel={locale.completionResultsLabel}
        />
        {voice.enabled && (
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
```

with:

```tsx
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
  MentionData,
  MentionDropdownItemProps,
  MentionResult,
  RichMentionInputHandle,
```

with:

```tsx
  MentionData,
  MentionDropdownItemProps,
  MentionDropdownOptionProps,
  MentionResult,
  RichMentionInputHandle,
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
const EDITOR_STYLE: CSSProperties = { whiteSpace: 'pre-wrap' };

function normalizeInputValue(text: string): string {
  return text.replace(/\u00A0/g, ' ');
```

with:

```tsx
const EDITOR_STYLE: CSSProperties = { whiteSpace: 'pre-wrap' };

/** Announcements for screen readers only; behaviour, so it holds without styles.css. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

function normalizeInputValue(text: string): string {
  return text.replace(/\u00A0/g, ' ');
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
// ---------------------------------------------------------------------------

function DefaultDropdownItem({ result, isSelected, onClick }: MentionDropdownItemProps) {
  const itemRef = useRef<HTMLButtonElement>(null);

```

with:

```tsx
// ---------------------------------------------------------------------------

function DefaultDropdownItem({ result, isSelected, onClick, optionProps }: MentionDropdownItemProps) {
  const itemRef = useRef<HTMLButtonElement>(null);

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
      ref={itemRef}
      type="button"
      onClick={onClick}
      data-component="mention-dropdown-item"
```

with:

```tsx
      ref={itemRef}
      type="button"
      {...optionProps}
      onClick={onClick}
      data-component="mention-dropdown-item"
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
      triggers = DEFAULT_TRIGGERS,
      components,
    },
    ref,
```

with:

```tsx
      triggers = DEFAULT_TRIGGERS,
      components,
      onEntityAction,
      listLabel = 'Suggestions',
      resultsLabel = '{count} suggestions',
    },
    ref,
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
    const [searchResults, setSearchResults] = useState<MentionResult[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isSearching, setIsSearching] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

```

with:

```tsx
    const [searchResults, setSearchResults] = useState<MentionResult[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    // -1: the result itself; 0..n: one of its entity actions.
    const [selectedAction, setSelectedAction] = useState(-1);
    const [isSearching, setIsSearching] = useState(false);
    const listboxId = useId();
    const [isFocused, setIsFocused] = useState(false);

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
      setSearchResults([]);
      setSelectedIndex(0);
    }, []);

```

with:

```tsx
      setSearchResults([]);
      setSelectedIndex(0);
      setSelectedAction(-1);
    }, []);

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
          setSearchResults(results);
          setSelectedIndex(0);
          setDropdownOpen(results.length > 0);
        } catch {
```

with:

```tsx
          setSearchResults(results);
          setSelectedIndex(0);
          setSelectedAction(-1);
          setDropdownOpen(results.length > 0);
        } catch {
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        if (triggerPos === -1) return;

        const prefix = inferMentionPrefix(result.type);
        const slug = typeof result.slug === 'string' && result.slug.trim().length > 0
          ? normalizeMentionSlug(result.slug)
```

with:

```tsx
        if (triggerPos === -1) return;

        // The trigger the user typed: an entity found with `@` stays `@` whatever its type.
        const prefix = result.type === 'command' ? '/' : text[triggerPos]!;
        const slug = typeof result.slug === 'string' && result.slug.trim().length > 0
          ? normalizeMentionSlug(result.slug)
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
          textNode.textContent = beforeText + token + afterText;

          requestAnimationFrame(() => {
            const newRange = document.createRange();
            newRange.setStart(textNode, (beforeText + token).length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
          });

          setMentions((prev) => [...prev, mentionData]);
```

with:

```tsx
          textNode.textContent = beforeText + token + afterText;

          // The caret moves at once: keys typed right after the pick must land behind the token.
          const newRange = document.createRange();
          newRange.setStart(textNode, (beforeText + token).length);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);

          setMentions((prev) => [...prev, mentionData]);
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        parent.removeChild(textNode);

        requestAnimationFrame(() => {
          const newRange = document.createRange();
          newRange.setStart(afterNode, 1);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);
          editableRef.current?.focus();
        });

        setMentions((prev) => [...prev, mentionData]);
```

with:

```tsx
        parent.removeChild(textNode);

        const newRange = document.createRange();
        newRange.setStart(afterNode, 1);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        editableRef.current?.focus();

        setMentions((prev) => [...prev, mentionData]);
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
      },
      [triggers, createChipElement, closeDropdown, onChange, getFullValue],
    );

```

with:

```tsx
      },
      [triggers, createChipElement, closeDropdown, onChange, getFullValue],
    );

    /** Removes the `@query` being typed and runs one of the result's entity actions instead. */
    const runAction = useCallback(
      (result: MentionResult, actionId: string) => {
        const selection = window.getSelection();
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
          const textNode = range.startContainer as Text;
          const text = textNode.textContent || '';
          const cursorPos = range.startOffset;
          for (let i = cursorPos - 1; i >= 0; i--) {
            const char = text[i];
            if (char === ' ' || char === '\n') break;
            if (triggers.includes(char) && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n')) {
              textNode.textContent = text.slice(0, i) + text.slice(cursorPos);
              break;
            }
          }
        }
        closeDropdown();
        onChange?.(getFullValue());
        onEntityAction?.(result, actionId);
      },
      [triggers, closeDropdown, onChange, getFullValue, onEntityAction],
    );

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        // Dropdown navigation (mention mode only)
        if (hasMentionSupport && dropdownOpen && searchResults.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % searchResults.length);
            return;
          }
```

with:

```tsx
        // Dropdown navigation (mention mode only)
        if (hasMentionSupport && dropdownOpen && searchResults.length > 0) {
          const actions = (onEntityAction && searchResults[selectedIndex]?.actions) || [];
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % searchResults.length);
            setSelectedAction(-1);
            return;
          }
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
              (prev) => (prev - 1 + searchResults.length) % searchResults.length,
            );
            return;
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            const selected = searchResults[selectedIndex];
            if (selected) {
              insertMention(selected);
            }
```

with:

```tsx
              (prev) => (prev - 1 + searchResults.length) % searchResults.length,
            );
            setSelectedAction(-1);
            return;
          }
          // Left/right move between a result and its actions; elsewhere they move the caret.
          if (event.key === 'ArrowRight' && selectedAction < actions.length - 1) {
            event.preventDefault();
            setSelectedAction((prev) => prev + 1);
            return;
          }
          if (event.key === 'ArrowLeft' && selectedAction >= 0) {
            event.preventDefault();
            setSelectedAction((prev) => prev - 1);
            return;
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            const selected = searchResults[selectedIndex];
            const action = selectedAction >= 0 ? actions[selectedAction] : undefined;
            if (selected && action) {
              runAction(selected, action.id);
            } else if (selected) {
              insertMention(selected);
            }
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        searchResults,
        selectedIndex,
        insertMention,
        closeDropdown,
```

with:

```tsx
        searchResults,
        selectedIndex,
        selectedAction,
        onEntityAction,
        runAction,
        insertMention,
        closeDropdown,
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
    // Mention mode — wrapper with editor + dropdown
    const isEmpty = !isFocused && getTextContent() === '' && mentions.length === 0;

    return (
```

with:

```tsx
    // Mention mode — wrapper with editor + dropdown
    const isEmpty = !isFocused && getTextContent() === '' && mentions.length === 0;
    const optionId = (index: number, action = -1) => (
      action >= 0 ? `${listboxId}-option-${index}-action-${action}` : `${listboxId}-option-${index}`
    );
    const listOpen = dropdownOpen && searchResults.length > 0;
    const optionProps = (index: number, action = -1): MentionDropdownOptionProps => ({
      id: optionId(index, action),
      role: 'option',
      'aria-selected': index === selectedIndex && action === selectedAction,
      tabIndex: -1,
    });

    return (
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
          data-element="editor"
          aria-disabled={disabled}
          aria-label={placeholder ?? 'Message input'}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
```

with:

```tsx
          data-element="editor"
          aria-disabled={disabled}
          aria-label={placeholder ?? 'Message input'}
          aria-autocomplete="list"
          aria-controls={listOpen ? listboxId : undefined}
          aria-activedescendant={listOpen ? optionId(selectedIndex, selectedAction) : undefined}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        )}

        {dropdownOpen && searchResults.length > 0 && (
          <div
            ref={dropdownRef}
            data-component="mention-dropdown"
            data-state={isSearching ? 'searching' : 'idle'}
          >
            {searchResults.map((result, index) => (
              <DropdownItem
                key={result.key ?? `${result.type}:${result.id}`}
                result={result}
                isSelected={index === selectedIndex}
                onClick={() => insertMention(result)}
              />
            ))}
          </div>
        )}
```

with:

```tsx
        )}

        <div data-element="completion-status" role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
          {listOpen ? resultsLabel.replace('{count}', String(searchResults.length)) : ''}
        </div>

        {listOpen && (
          <div
            ref={dropdownRef}
            id={listboxId}
            role="listbox"
            aria-label={listLabel}
            data-component="mention-dropdown"
            data-state={isSearching ? 'searching' : 'idle'}
            // Keep the caret in the editor while the list is clicked.
            onMouseDown={(event) => event.preventDefault()}
          >
            {searchResults.map((result, index) => {
              const key = result.key ?? `${result.type}:${result.id}`;
              const item = (
                <DropdownItem
                  key={key}
                  result={result}
                  isSelected={index === selectedIndex && selectedAction === -1}
                  onClick={() => insertMention(result)}
                  optionProps={optionProps(index)}
                />
              );
              if (!onEntityAction || !result.actions?.length) return item;
              return (
                <div key={key} role="group" aria-label={result.label} data-element="result-row">
                  {item}
                  <span data-element="entity-actions">
                    {result.actions.map((action, actionIndex) => (
                      <button
                        key={action.id}
                        type="button"
                        {...optionProps(index, actionIndex)}
                        aria-label={`${action.label}: ${result.label}`}
                        data-component="mention-action"
                        data-selected={index === selectedIndex && actionIndex === selectedAction ? 'true' : 'false'}
                        onClick={() => runAction(result, action.id)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  clarificationSubmitButton: 'Answer',
  retryRecordingAriaLabel: 'Retry recording',
};

```

with:

```tsx
  clarificationSubmitButton: 'Answer',
  retryRecordingAriaLabel: 'Retry recording',
  completionListLabel: 'Suggestions',
  completionResultsLabel: '{count} suggestions',
};

```

In `src/react/types.ts`, replace:

```ts
  // Speech-to-text
  retryRecordingAriaLabel: string;
}

```

with:

```ts
  // Speech-to-text
  retryRecordingAriaLabel: string;

  // `@` and `/` suggestions
  completionListLabel: string;
  completionResultsLabel: string;     // supports `{count}`
}

```

In `src/react/types.ts`, replace:

```ts
}

export interface MentionDropdownItemProps {
  result: MentionResult;
  isSelected: boolean;
  onClick: () => void;
}

```

with:

```ts
}

/** ARIA wiring of one option in the `@`/`/` list; spread it onto the clickable element. */
export interface MentionDropdownOptionProps {
  id: string;
  role: 'option';
  'aria-selected': boolean;
  tabIndex: -1;
}

export interface MentionDropdownItemProps {
  result: MentionResult;
  isSelected: boolean;
  onClick: () => void;
  /** Custom items must spread these onto their clickable element for keyboard and screen-reader use. */
  optionProps?: MentionDropdownOptionProps;
}

```

In `src/react/types.ts`, replace:

```ts
  /** Component overrides for the autocomplete dropdown. */
  components?: RichMentionInputComponents;
}

```

with:

```ts
  /** Component overrides for the autocomplete dropdown. */
  components?: RichMentionInputComponents;
  /** An entity action picked next to a result (mouse, or ArrowRight then Enter). */
  onEntityAction?: (result: MentionResult, actionId: string) => void;
  /** Accessible name of the suggestion list. Default `Suggestions`. */
  listLabel?: string;
  /** Announced result count; `{count}` is replaced. Default `{count} suggestions`. */
  resultsLabel?: string;
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/components/__tests__/chat-interactions-composer.test.tsx --maxWorkers=4 && bunx vitest run src/react --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  6 passed (6)`; the React suites report `Test Files  38 passed (38)`, `Tests  309 passed (309)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/react/components/__tests__/chat-interactions-composer.test.tsx src/react/components/mention-input.tsx src/react/components/rich-mention-input.tsx src/react/provider/ai-chat-provider.tsx src/react/types.ts
git commit -m "feat(react): give the composer list semantics and entity actions"
```

### Task 11: Ask for missing arguments in a form

**Files:**
- Create: `src/react/components/command-arguments-form.tsx`
- Modify: `src/react/components/mention-input.tsx` (render the form above the composer), `src/react/types.ts` (`ChatComponents.CommandArgumentsForm`, `CommandArgumentsFormProps`, locale keys), `src/react/provider/ai-chat-provider.tsx` (locale defaults), `src/react/index.ts` (exports)
- Test: `src/react/components/__tests__/command-arguments-form.test.tsx` (Create)

**Interfaces:**
- Consumes: Task 9 `pendingCommand`, `submitPendingCommand`, `cancelPendingCommand`, `interactions.searchEntity`; Task 8 `PendingChatCommand`.
- Produces: `CommandArgumentsForm({ pending, onSubmit(values, valueLabels), onCancel })` (`role="form"`, name `Details for {command}`): entity arguments as ARIA 1.2 comboboxes over the entity's search (debounced 120 ms), closed sets as `<select>` (`Any` for optional ones), others as text inputs (max 500 characters); focus starts at the first empty required field; Escape in an open combobox closes the list, Escape elsewhere cancels; an `invalid` attempt shows an alert. `ChatComponents.CommandArgumentsForm` replaces it (BYOS). Locale keys `commandArgumentsLabel`, `commandArgumentsSubmit`, `commandArgumentsInvalid`, `commandArgumentsAnyOption`, `commandArgumentsNoMatches`. After submit or cancel the focus returns to the editor.

- [ ] **Step 1: Write the failing tests**

Create `src/react/components/__tests__/command-arguments-form.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import type { ChatTransport, MentionData } from '../../types.js';
import { MentionInput } from '../mention-input.js';

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: (query) => [{ id: 'alice', label: 'Alice Example' }, { id: 'bob', label: 'Bob Builder' }]
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
});

const assign = defineChatCommand({
  id: 'tasks.assign',
  label: 'Assign',
  args: [
    { name: 'assignee', label: 'Person', required: true, entity: 'person' },
    { name: 'priority', label: 'Priority', options: ['high', 'low'] },
    { name: 'note', label: 'Note', required: true },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let context: ChatContextValue | undefined;
function Probe() {
  context = useChatContext();
  return null;
}

function Composer({ chat }: { chat: ChatTransport }) {
  const interactions = useMemo(() => ({ entities: [person], commands: [assign] }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe /><MentionInput /></AiChatProvider>;
}

const picked: MentionData = { id: 'tasks.assign', type: 'command', label: 'Assign', prefix: '/', slug: 'assign' };

async function openForm() {
  const chat = transport();
  render(<Composer chat={chat} />);
  await act(async () => { context!.send('/assign', { mentions: [picked] }); });
  const form = await screen.findByRole('form', { name: 'Details for Assign' });
  return { chat, form };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('CommandArgumentsForm', () => {
  it('asks for the missing arguments with focus on the first field and runs the command', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' });
    expect(document.activeElement).toBe(personField);
    fireEvent.change(personField, { target: { value: 'ali' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const listbox = screen.getByRole('listbox', { name: 'Person' });
    expect(personField.getAttribute('aria-expanded')).toBe('true');
    expect(personField.getAttribute('aria-controls')).toBe(listbox.id);
    const option = screen.getByRole('option', { name: 'Alice Example' });
    expect(personField.getAttribute('aria-activedescendant')).toBe(option.id);
    fireEvent.keyDown(personField, { key: 'Enter' });
    expect((personField as HTMLInputElement).value).toBe('Alice Example');
    expect(personField.getAttribute('aria-expanded')).toBe('false');

    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), { target: { value: 'high' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note *' }), { target: { value: 'bis Freitag' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'tasks.assign', tool: 'tasks.assign', args: { assignee: 'alice', priority: 'high', note: 'bis Freitag' } },
      label: '/Assign @Alice Example high bis Freitag',
    });
    expect(screen.queryByRole('form')).toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('textbox');
  });

  it('starts at the first required field the references left empty', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const alice: MentionData = { id: 'alice', type: 'person', label: 'Alice Example', prefix: '@', slug: 'alice-example' };
    await act(async () => { context!.send('/assign @alice-example', { mentions: [picked, alice] }); });
    await screen.findByRole('form', { name: 'Details for Assign' });
    expect((screen.getByRole('combobox', { name: 'Person *' }) as HTMLInputElement).value).toBe('Alice Example');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Note *' }));
  });

  it('keeps asking while a required value is missing', async () => {
    const { chat, form } = await openForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note *' }), { target: { value: 'x' } });
    fireEvent.submit(form);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(await screen.findByRole('form', { name: 'Details for Assign' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Note *' }) as HTMLInputElement).value).toBe('x');
  });

  it('closes an open list with Escape first and cancels the command with the next Escape', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' });
    fireEvent.change(personField, { target: { value: 'b' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(personField.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(personField, { key: 'Escape' });
    expect(personField.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('form')).toBeTruthy();
    fireEvent.keyDown(personField, { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(context!.pendingCommand).toBeNull();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('says when values are too long instead of sending them', async () => {
    const { chat, form } = await openForm();
    await act(async () => { context!.submitPendingCommand({ assignee: 'alice', note: 'x'.repeat(2_100) }); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toBe('These values are too long.');
    expect(form).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/components/__tests__/command-arguments-form.test.tsx --maxWorkers=4
```

Expected: FAIL — no form is rendered for the pending command (`Unable to find role="form"`). `Test Files  1 failed (1)`, `Tests  5 failed (5)`

- [ ] **Step 3: Implement**

Create `src/react/components/command-arguments-form.tsx`:

```tsx
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { chatText, type ChatInteractionArg } from '../../contracts/chat-interactions.js';
import type { ChatEntityItem } from '../interactions/definitions.js';
import { useChatContext } from '../provider/chat-context.js';
import type { CommandArgumentsFormProps } from '../types.js';

const SEARCH_DEBOUNCE_MS = 120;

interface EntityFieldProps {
  id: string;
  label: string;
  arg: ChatInteractionArg;
  value: string;
  valueLabel: string;
  onChange: (value: string, label: string) => void;
}

/** ARIA 1.2 combobox over one entity type's search. */
function EntityField({ id, label, arg, value, valueLabel, onChange }: EntityFieldProps) {
  const { interactions, locale } = useChatContext();
  const [query, setQuery] = useState(valueLabel || value);
  const [items, setItems] = useState<ChatEntityItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `${id}-list`;

  useEffect(() => {
    if (!open || !interactions || !arg.entity) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void interactions.searchEntity(arg.entity!, query.trim(), controller.signal).then((found) => {
        if (controller.signal.aborted) return;
        setItems(found);
        setActive(0);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, interactions, arg.entity]);

  const pick = (item: ChatEntityItem) => {
    onChange(item.id, item.label);
    setQuery(item.label);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (items.length > 0) setActive((previous) => (previous + 1) % items.length);
      return;
    }
    if (event.key === 'ArrowUp' && open && items.length > 0) {
      event.preventDefault();
      setActive((previous) => (previous - 1 + items.length) % items.length);
      return;
    }
    if (event.key === 'Enter' && open && items[active]) {
      event.preventDefault();
      pick(items[active]!);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const expanded = open && items.length > 0;
  return (
    <div data-element="field" data-kind="entity">
      <label htmlFor={id}>{label}{arg.required ? ' *' : ''}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
        aria-required={arg.required ? true : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          if (value) onChange('', '');
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label={label} hidden={!expanded} data-element="options">
        {items.map((item, index) => (
          <li
            key={item.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            data-selected={index === active ? 'true' : 'false'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(item)}
          >
            {item.label}
            {item.description && <span data-element="description">{item.description}</span>}
          </li>
        ))}
      </ul>
      {open && query.trim() && items.length === 0 && (
        <span data-element="empty">{locale.commandArgumentsNoMatches}</span>
      )}
    </div>
  );
}

/**
 * Asks for the arguments a `/` command or entity action still needs, then
 * runs it without the model. Entity arguments search like `@`; closed sets
 * are a select; everything else is text. Escape cancels.
 */
export function CommandArgumentsForm({ pending, onSubmit, onCancel }: CommandArgumentsFormProps) {
  const { interactions, locale } = useChatContext();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...pending.values }));
  const [labels, setLabels] = useState<Record<string, string>>(() => ({ ...pending.valueLabels }));
  const language = interactions?.locale ?? 'en';

  // Start at the first required field still empty (e.g. the person when the task came from `@`).
  useEffect(() => {
    const fields = [...(formRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select') ?? [])];
    const required = (field: HTMLInputElement | HTMLSelectElement) => field.required || field.getAttribute('aria-required') === 'true';
    (fields.find((field) => field.value === '' && required(field))
      ?? fields.find((field) => field.value === '')
      ?? fields[0])?.focus();
  }, []);

  const set = (name: string, value: string, label?: string) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    if (label !== undefined) setLabels((previous) => ({ ...previous, [name]: label }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(values, labels);
  };

  return (
    <form
      ref={formRef}
      data-component="command-arguments"
      aria-label={locale.commandArgumentsLabel.replace('{command}', pending.label)}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p data-element="title">{`/${pending.label}`}</p>
      {pending.error && <p role="alert" data-element="error">{locale.commandArgumentsInvalid}</p>}
      {pending.args.map((arg, index) => {
        const id = `${formId}-${index}`;
        const label = chatText(arg.label, language);
        if (arg.entity) {
          return (
            <EntityField
              key={arg.name}
              id={id}
              label={label}
              arg={arg}
              value={values[arg.name] ?? ''}
              valueLabel={labels[arg.name] ?? ''}
              onChange={(value, valueLabel) => set(arg.name, value, valueLabel)}
            />
          );
        }
        if (arg.options) {
          return (
            <div key={arg.name} data-element="field" data-kind="options">
              <label htmlFor={id}>{label}{arg.required ? ' *' : ''}</label>
              <select
                id={id}
                value={values[arg.name] ?? ''}
                required={arg.required}
                onChange={(event) => set(arg.name, event.target.value)}
              >
                {!arg.required || !values[arg.name] ? <option value="">{locale.commandArgumentsAnyOption}</option> : null}
                {arg.options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
          );
        }
        return (
          <div key={arg.name} data-element="field" data-kind="text">
            <label htmlFor={id}>{label}{arg.required ? ' *' : ''}</label>
            <input
              id={id}
              type="text"
              value={values[arg.name] ?? ''}
              required={arg.required}
              maxLength={500}
              onChange={(event) => set(arg.name, event.target.value)}
            />
          </div>
        );
      })}
      <div data-element="actions">
        <button type="submit" data-action="run">{locale.commandArgumentsSubmit}</button>
        <button type="button" data-action="cancel" onClick={onCancel}>{locale.cancelButton}</button>
      </div>
    </form>
  );
}
```

In `src/react/components/mention-input.tsx`, replace:

```tsx
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
```

with:

```tsx
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { CommandArgumentsForm as DefaultCommandArgumentsForm } from './command-arguments-form.js';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
```

In `src/react/components/mention-input.tsx`, replace:

```tsx
    composerMentions,
    consumeComposerMentions,
  } = useChatContext();
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;

  // References added from outside the composer (`mentionEntity`).
```

with:

```tsx
    composerMentions,
    consumeComposerMentions,
    pendingCommand,
    submitPendingCommand,
    cancelPendingCommand,
  } = useChatContext();
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;
  const ArgumentsForm = components.CommandArgumentsForm ?? DefaultCommandArgumentsForm;

  // References added from outside the composer (`mentionEntity`).
```

In `src/react/components/mention-input.tsx`, replace:

```tsx
  return (
    <div data-component="mention-input" data-mode="providers">
      <form
        onSubmit={(event) => {
```

with:

```tsx
  return (
    <div data-component="mention-input" data-mode="providers">
      {pendingCommand && (
        <ArgumentsForm
          key={`${pendingCommand.commandId}:${JSON.stringify(pendingCommand.values)}:${pendingCommand.error ?? ''}`}
          pending={pendingCommand}
          onSubmit={(values, valueLabels) => {
            submitPendingCommand(values, valueLabels);
            inputRef.current?.focus();
          }}
          onCancel={() => {
            cancelPendingCommand();
            inputRef.current?.focus();
          }}
        />
      )}
      <form
        onSubmit={(event) => {
```

In `src/react/index.ts`, replace:

```ts
  CompletionItemAction,
  CompletionPermissionContext,
  CompletionSearchRequest,
  UiToolCommandSource,
```

with:

```ts
  CompletionItemAction,
  CompletionPermissionContext,
  CommandArgumentsFormProps,
  CompletionSearchRequest,
  UiToolCommandSource,
```

In `src/react/index.ts`, replace:

```ts
} from './completions/completion-search.js';
export { createUiToolCommandProvider } from './completions/ui-tool-command-provider.js';

// Declarative chat interactions: `@` entities and `/` commands
```

with:

```ts
} from './completions/completion-search.js';
export { createUiToolCommandProvider } from './completions/ui-tool-command-provider.js';
export { CommandArgumentsForm } from './components/command-arguments-form.js';

// Declarative chat interactions: `@` entities and `/` commands
```

In `src/react/provider/ai-chat-provider.tsx`, replace:

```tsx
  completionListLabel: 'Suggestions',
  completionResultsLabel: '{count} suggestions',
};

```

with:

```tsx
  completionListLabel: 'Suggestions',
  completionResultsLabel: '{count} suggestions',
  commandArgumentsLabel: 'Details for {command}',
  commandArgumentsSubmit: 'Run',
  commandArgumentsInvalid: 'These values are too long.',
  commandArgumentsAnyOption: 'Any',
  commandArgumentsNoMatches: 'No matches',
};

```

In `src/react/types.ts`, replace:

```ts
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';
import type { ChatInteractionsConfig } from './interactions/registry.js';

export type {
```

with:

```ts
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';
import type { ChatInteractionsConfig, PendingChatCommand } from './interactions/registry.js';

export type {
```

In `src/react/types.ts`, replace:

```ts
  MentionChip?: ComponentType<MentionChipProps>;
  ClarificationCard?: ComponentType<ClarificationCardProps>;
}

```

with:

```ts
  MentionChip?: ComponentType<MentionChipProps>;
  ClarificationCard?: ComponentType<ClarificationCardProps>;
  /** Form for the missing arguments of a `/` command or entity action. */
  CommandArgumentsForm?: ComponentType<CommandArgumentsFormProps>;
}

export interface CommandArgumentsFormProps {
  pending: PendingChatCommand;
  /** Values by argument name, and the labels of picked entities. */
  onSubmit: (values: Readonly<Record<string, string>>, valueLabels: Readonly<Record<string, string>>) => void;
  onCancel: () => void;
}

```

In `src/react/types.ts`, replace:

```ts
  completionListLabel: string;
  completionResultsLabel: string;     // supports `{count}`
}

```

with:

```ts
  completionListLabel: string;
  completionResultsLabel: string;     // supports `{count}`

  // Arguments of `/` commands and entity actions
  commandArgumentsLabel: string;      // supports `{command}`
  commandArgumentsSubmit: string;
  commandArgumentsInvalid: string;
  commandArgumentsAnyOption: string;
  commandArgumentsNoMatches: string;
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/components/__tests__/command-arguments-form.test.tsx --maxWorkers=4 && bunx vitest run src/react --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  5 passed (5)`; the React suites report `Test Files  39 passed (39)`, `Tests  314 passed (314)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/react/components/__tests__/command-arguments-form.test.tsx src/react/components/command-arguments-form.tsx src/react/components/mention-input.tsx src/react/index.ts src/react/provider/ai-chat-provider.tsx src/react/types.ts
git commit -m "feat(react): ask for missing command arguments in a form"
```

### Task 12: Styles for entity actions and the argument form

**Files:**
- Modify: `src/react/styles.css` (one block after the dropdown item rules), `src/embed/chat-styles.generated.ts` (regenerated, never edited)
- Test: `src/react/__tests__/chat-interactions-styles.test.ts` (Create)

**Interfaces:**
- Consumes: the `--cm-*` variables; P07's `scripts/generate-embed-styles.mjs` (the build runs it with `--check`).
- Produces: rules for `[data-element="result-row"]`, `[data-element="entity-actions"]`, `[data-component="mention-action"]` (selected state in `--cm-primary-tint`) and `[data-component="command-arguments"]` (wrapping layout, entity option lists opening upwards inside the panel); the same CSS inside `<glirastes-chat>`.

- [ ] **Step 1: Write the failing tests**

Create `src/react/__tests__/chat-interactions-styles.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAT_STYLES } from '../../embed/chat-styles.generated.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('shipped styles for chat interactions', () => {
  it('puts entity actions beside their result and marks the active one', () => {
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-dropdown"] [data-element="result-row"]'))
      .toContain('display: flex');
    expect(rule('[data-component="ai-chat-panel"] [data-element="result-row"] > [data-component="mention-dropdown-item"]'))
      .toContain('min-width: 0');
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-action"][data-selected="true"]'))
      .toContain('background: var(--cm-primary-tint)');
  });

  it('wraps the argument form on narrow panels and opens entity lists upwards', () => {
    const form = rule('[data-component="ai-chat-panel"] [data-component="command-arguments"]');
    expect(form).toContain('flex-wrap: wrap');
    expect(form).toContain('max-width: 100%');
    expect(rule('[data-component="command-arguments"] [data-element="field"]')).toContain('min-width: 0');
    expect(rule('[data-component="command-arguments"] [data-element="options"]')).toContain('bottom: calc(100% + 0.25rem)');
  });

  it('ships the same rules inside <glirastes-chat>', () => {
    expect(CHAT_STYLES).toBe(css);
    expect(CHAT_STYLES).toContain('[data-component="command-arguments"]');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/__tests__/chat-interactions-styles.test.ts --maxWorkers=4
```

Expected: FAIL — `missing rule for [data-component="ai-chat-panel"] [data-component="mention-dropdown"] [data-element="result-row"]`, and the inlined CSS lacks the form rules. `Test Files  1 failed (1)`, `Tests  3 failed (3)`

- [ ] **Step 3: Add the styles and regenerate the shadow-root CSS**

In `src/react/styles.css`, replace:

```css
[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"] [data-element="description"] {
  font-size: 12px;
  color: var(--cm-text-muted);
}

/* ---------- Structured clarification ---------- */
```

with:

```css
[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"] [data-element="description"] {
  font-size: 12px;
  color: var(--cm-text-muted);
}

/* ---------- Chat interactions: entity actions and command arguments ---------- */
[data-component="ai-chat-panel"] [data-component="mention-dropdown"] [data-element="result-row"] {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-right: 0.5rem;
}
[data-component="ai-chat-panel"] [data-element="result-row"] > [data-component="mention-dropdown-item"] {
  flex: 1 1 auto;
  min-width: 0;
}
[data-component="ai-chat-panel"] [data-element="entity-actions"] {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.25rem;
}
[data-component="ai-chat-panel"] [data-component="mention-action"] {
  padding: 0.125rem 0.5rem;
  background: var(--cm-bg-muted);
  border: 1px solid var(--cm-border);
  border-radius: 999px;
  color: var(--cm-text);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
[data-component="ai-chat-panel"] [data-component="mention-action"][data-selected="true"] {
  background: var(--cm-primary-tint);
  border-color: var(--cm-primary);
}
[data-component="ai-chat-panel"] [data-component="command-arguments"] {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.5rem;
  max-width: 100%;
  margin: 0 0 0.5rem;
  padding: 0.75rem;
  background: var(--cm-bg);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
}
[data-component="command-arguments"] [data-element="title"] {
  flex: 1 1 100%;
  margin: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
[data-component="command-arguments"] [data-element="error"] {
  flex: 1 1 100%;
  margin: 0;
  color: var(--cm-danger);
  font-size: 12px;
}
[data-component="command-arguments"] [data-element="field"] {
  position: relative;
  display: flex;
  flex: 1 1 10rem;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  color: var(--cm-text-muted);
  font-size: 12px;
}
[data-component="command-arguments"] input,
[data-component="command-arguments"] select {
  box-sizing: border-box;
  width: 100%;
  padding: 0.375rem 0.5rem;
  background: var(--cm-bg-muted);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  color: var(--cm-text);
  font: inherit;
  font-size: 14px;
}
[data-component="command-arguments"] input:focus,
[data-component="command-arguments"] select:focus {
  outline: none;
  border-color: var(--cm-primary);
  box-shadow: 0 0 0 3px var(--cm-primary-ring);
}
[data-component="command-arguments"] [data-element="options"] {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 0.25rem);
  z-index: 20;
  max-height: 12rem;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  background: var(--cm-bg);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
[data-component="command-arguments"] [data-element="options"] [role="option"] {
  padding: 0.375rem 0.5rem;
  color: var(--cm-text);
  cursor: pointer;
}
[data-component="command-arguments"] [data-element="options"] [role="option"][data-selected="true"] {
  background: var(--cm-primary-tint);
}
[data-component="command-arguments"] [data-element="actions"] {
  display: flex;
  gap: 0.375rem;
}
[data-component="command-arguments"] [data-action="run"],
[data-component="command-arguments"] [data-action="cancel"] {
  padding: 0.375rem 0.75rem;
  border-radius: var(--cm-radius-sm);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
[data-component="command-arguments"] [data-action="run"] {
  background: var(--cm-primary);
  border: 1px solid var(--cm-primary);
  color: #ffffff;
}
[data-component="command-arguments"] [data-action="cancel"] {
  background: transparent;
  border: 1px solid var(--cm-border);
  color: var(--cm-text);
}

/* ---------- Structured clarification ---------- */
```

Regenerate the inlined shadow-root styles (never edit the generated file by hand):

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && node scripts/generate-embed-styles.mjs
```

Expected: `Generated src/embed/chat-styles.generated.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/react/__tests__/chat-interactions-styles.test.ts --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  3 passed (3)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/embed/chat-styles.generated.ts src/react/__tests__/chat-interactions-styles.test.ts src/react/styles.css
git commit -m "feat(react): style entity actions and the command argument form"
```

### Task 13: Chat interactions on `<glirastes-chat>`

**Files:**
- Modify: `src/embed/glirastes-chat-element.tsx` (`defineEntity`, `defineCommand`, `interactions`, `mentionEntity`, `interactions` and `lang` attributes), `src/embed/index.ts` (exports), `src/react/components/rich-mention-input.tsx` (read the caret through the editor's shadow root)
- Test: `src/embed/__tests__/glirastes-chat-interactions.test.tsx` (Create)

**Interfaces:**
- Consumes: Task 8 `defineChatEntity`, `defineChatCommand`, `ChatInteractionsConfig`; Task 2 `parseChatInteractions`; Task 9 `mentionEntity` through the element's bridge.
- Produces:
  - `GlirastesChatElement.defineEntity(definition)`, `.defineCommand(definition)` (replace by type or id, validated), `.interactions` (get/set validated data), `.mentionEntity(type, id): Promise<boolean>`; attribute `interactions` (empty ⇒ GET `endpoint`, value ⇒ GET that URL, `credentials: 'same-origin'`; failure ⇒ `glirastes-chat:error` `Chat interactions unavailable`); labels follow the nearest `lang` (`de…` ⇒ German, else English). `config.chatInteractions` stays possible; element definitions are appended to it.
  - `glirastes/embed` exports `defineChatEntity`, `defineChatCommand` and the definition and data types (no import of `../react/index.js`).
  - Composer fix: `editorSelection(editor)` uses `ShadowRoot.getSelection()` when the editor lives in a shadow root. Chromium retargets `window.getSelection()` to the shadow host, so `@`/`/` detection and insertion never worked inside `<glirastes-chat>` with providers (P07 only proved the element with its plain textarea).

- [ ] **Step 1: Write the failing tests**

jsdom keeps no selection inside a shadow root, so the test installs a stand-in for Chromium's `ShadowRoot.getSelection()`; Task 14 proves the same flow in real Chrome.

Create `src/embed/__tests__/glirastes-chat-interactions.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../contracts/chat-interactions.js';
import type { ChatTransport } from '../../react/types.js';
import { defineChatEntity, defineGlirastesChatElement, type GlirastesChatElement } from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
  ],
};

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: () => [{ id: '7', label: 'Release prüfen' }],
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
  actions: [{ id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } }],
});

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

async function mount(configure: (element: GlirastesChatElement) => void) {
  defineGlirastesChatElement();
  const element = document.createElement('glirastes-chat') as GlirastesChatElement;
  const chat = transport();
  element.transport = chat;
  configure(element);
  const errors: string[] = [];
  element.addEventListener('glirastes-chat:error', (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  await act(async () => { document.body.append(element); });
  return { element, chat, errors, editor: () => element.shadowRoot!.querySelector<HTMLElement>('[data-element="editor"]')! };
}

/**
 * jsdom keeps no selection inside a shadow root. Chromium does, behind the
 * non-standard `ShadowRoot.getSelection()` that the composer reads; this
 * stands in for it.
 */
function installShadowSelection(): void {
  let current: Range | null = null;
  const selection = {
    get rangeCount() { return current ? 1 : 0; },
    getRangeAt: () => current!,
    removeAllRanges: () => { current = null; },
    addRange: (range: Range) => { current = range; },
  };
  Object.defineProperty(ShadowRoot.prototype, 'getSelection', { configurable: true, value: () => selection });
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = (editor.getRootNode() as ShadowRoot & { getSelection(): Selection }).getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  installShadowSelection();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  await act(async () => { document.body.replaceChildren(); });
  document.documentElement.removeAttribute('lang');
  Reflect.deleteProperty(ShadowRoot.prototype, 'getSelection');
  vi.unstubAllGlobals();
});

describe('<glirastes-chat> chat interactions', () => {
  it('loads derived commands from the endpoint and runs one without the model, like React', async () => {
    const fetch = vi.fn(async () => Response.json(data));
    vi.stubGlobal('fetch', fetch);
    document.documentElement.setAttribute('lang', 'de');
    const { chat, editor } = await mount((node) => {
      node.setAttribute('endpoint', '/chat');
      node.setAttribute('interactions', '');
    });
    expect(fetch).toHaveBeenCalledWith('/chat', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
    await waitFor(() => expect(editor()).toBeTruthy());
    typeInto(editor(), '/über');
    await waitFor(() => expect(editor().getAttribute('aria-activedescendant')).toBeTruthy());
    const option = editor().getRootNode() as ShadowRoot;
    expect(option.querySelector('[role="option"]')?.textContent).toBe('Übersicht öffnen');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(editor().textContent).toBe('/ubersicht-offnen '));
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } },
      label: '/Übersicht öffnen',
    });
  });

  it('takes entities through the JS API, with their actions and mentions by id', async () => {
    const { element, chat, editor } = await mount((node) => { node.defineEntity(task); });
    typeInto(editor(), '@rel');
    await waitFor(() => expect(element.shadowRoot!.querySelector('[role="group"]')).toBeTruthy());
    fireEvent.keyDown(editor(), { key: 'ArrowRight' });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation)
      .toEqual({ commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } });
    let added = false;
    await act(async () => { added = await element.mentionEntity('task', '7'); });
    expect(added).toBe(true);
    await waitFor(() => expect(editor().querySelector('[data-mention-id="7"]')).toBeTruthy());
    expect(await element.mentionEntity('task', 'missing')).toBe(false);
  });

  it('refuses invalid definitions and reports interactions it cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { element, errors } = await mount((node) => {
      node.setAttribute('endpoint', '/chat');
      node.setAttribute('interactions', '/chat/interactions');
    });
    await waitFor(() => expect(errors).toEqual(['Chat interactions unavailable']));
    expect(() => element.defineCommand({ id: 'bad id', label: 'x', run: { kind: 'tool', tool: 'x' } })).toThrow(/commands\[0\]\.id/);
    element.interactions = data;
    expect(element.interactions).toEqual(data);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/embed/__tests__/glirastes-chat-interactions.test.tsx --maxWorkers=4
```

Expected: FAIL — `defineChatEntity is not a function` at module load (`glirastes/embed` does not export it yet), so the file reports no tests; without the element API and the shadow-root caret the three tests would fail next. `Test Files  1 failed (1)`, `Tests  no tests`

- [ ] **Step 3: Implement**

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AiChatPanel } from '../react/components/ai-chat-panel.js';
import { AiChatProvider } from '../react/provider/ai-chat-provider.js';
import { useChatContext } from '../react/provider/chat-context.js';
```

with:

```tsx
import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  parseChatInteractions,
  type ChatInteractionsData,
  type ChatLocaleCode,
} from '../contracts/chat-interactions.js';
import { AiChatPanel } from '../react/components/ai-chat-panel.js';
import {
  defineChatCommand,
  defineChatEntity,
  type ChatCommandDefinition,
  type ChatEntityDefinition,
} from '../react/interactions/definitions.js';
import type { ChatInteractionsConfig } from '../react/interactions/registry.js';
import { AiChatProvider } from '../react/provider/ai-chat-provider.js';
import { useChatContext } from '../react/provider/chat-context.js';
```

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
) => void;

type SendRef = (text: string) => void;

function EmbedBridge({
  emit,
  onSendReady,
}: {
  emit: Emit;
  onSendReady: (send: SendRef | null) => void;
}) {
  const { send, isLoading, error } = useChatContext();
  const previous = useRef<string | null>(null);
  const state = error ? 'error' : isLoading ? 'busy' : 'idle';

  useEffect(() => {
    onSendReady((text) => send(text));
    return () => onSendReady(null);
  }, [send, onSendReady]);

  useEffect(() => {
```

with:

```tsx
) => void;

interface EmbedApi {
  send(text: string): void;
  mentionEntity(type: string, id: string): Promise<boolean>;
}

function EmbedBridge({
  emit,
  onSendReady,
}: {
  emit: Emit;
  onSendReady: (api: EmbedApi | null) => void;
}) {
  const { send, mentionEntity, isLoading, error } = useChatContext();
  const previous = useRef<string | null>(null);
  const state = error ? 'error' : isLoading ? 'busy' : 'idle';

  useEffect(() => {
    onSendReady({ send: (text) => send(text), mentionEntity });
    return () => onSendReady(null);
  }, [send, mentionEntity, onSendReady]);

  useEffect(() => {
```

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
  welcomeMessage?: string;
  emit: Emit;
  onSendReady: (send: SendRef | null) => void;
}) {
  const { headers, bodyExtras, onToolResult, ...providerConfig } = config;
```

with:

```tsx
  welcomeMessage?: string;
  emit: Emit;
  onSendReady: (api: EmbedApi | null) => void;
}) {
  const { headers, bodyExtras, onToolResult, ...providerConfig } = config;
```

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
 *
 * Attributes: `endpoint` (required unless `transport` is set), `theme`
 * (preset name), `placeholder`, `welcome-message`, `voice`, `voice-language`.
 * Properties: `config`, `transport`. Method: `send(text)`.
 * Events (bubbling, composed): `glirastes-chat:ready`, `:status`,
 * `:tool-result`, `:error`. Styling: `--glirastes-chat-*` CSS variables.
 * Removing the element unmounts React and releases the microphone.
 */
export class GlirastesChatElement extends BaseElement {
  static get observedAttributes(): string[] {
    return ['endpoint', 'theme', 'placeholder', 'welcome-message', 'voice', 'voice-language'];
  }

  #root: Root | null = null;
  #style: HTMLStyleElement | null = null;
  #config: GlirastesChatElementConfig = {};
  #transport: ChatTransport | undefined;
  #send: SendRef | null = null;
  #pendingUnmount = false;

  readonly #emit: Emit = (name, detail) => {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  };

  readonly #onSendReady = (send: SendRef | null) => {
    this.#send = send;
  };

```

with:

```tsx
 *
 * Attributes: `endpoint` (required unless `transport` is set), `theme`
 * (preset name), `placeholder`, `welcome-message`, `voice`, `voice-language`,
 * `interactions` (load `@` entities and `/` commands with a GET from the
 * endpoint or the given URL; labels follow the nearest `lang`).
 * Properties: `config`, `transport`, `interactions`. Methods: `send(text)`,
 * `defineEntity(definition)`, `defineCommand(definition)`,
 * `mentionEntity(type, id)`.
 * Events (bubbling, composed): `glirastes-chat:ready`, `:status`,
 * `:tool-result`, `:error`. Styling: `--glirastes-chat-*` CSS variables.
 * Removing the element unmounts React and releases the microphone.
 */
export class GlirastesChatElement extends BaseElement {
  static get observedAttributes(): string[] {
    return ['endpoint', 'theme', 'placeholder', 'welcome-message', 'voice', 'voice-language', 'interactions', 'lang'];
  }

  #root: Root | null = null;
  #style: HTMLStyleElement | null = null;
  #config: GlirastesChatElementConfig = {};
  #transport: ChatTransport | undefined;
  #api: EmbedApi | null = null;
  #pendingUnmount = false;
  #entities: ChatEntityDefinition[] = [];
  #commands: ChatCommandDefinition[] = [];
  #interactions: ChatInteractionsData | undefined;
  #interactionsFromProperty = false;
  #interactionsLoad: AbortController | null = null;

  readonly #emit: Emit = (name, detail) => {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  };

  readonly #onSendReady = (api: EmbedApi | null) => {
    this.#api = api;
  };

```

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
  }

  /** Sends a user message through the embedded chat. False before mount. */
  send(text: string): boolean {
    if (!this.#send || !text.trim()) return false;
    this.#send(text);
    return true;
  }

  connectedCallback(): void {
    this.#pendingUnmount = false;
    if (!this.#root) {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
```

with:

```tsx
  }

  /** Derived `@` entities and `/` commands, e.g. the generated module's `chatInteractions`. */
  get interactions(): ChatInteractionsData | undefined {
    return this.#interactions;
  }

  set interactions(value: ChatInteractionsData | null | undefined) {
    this.#interactionsLoad?.abort();
    this.#interactions = value ? parseChatInteractions(value) : undefined;
    this.#interactionsFromProperty = Boolean(value);
    this.#render();
  }

  /** Adds or replaces (same type) an `@` entity; same definition as `defineChatEntity`. */
  defineEntity(definition: ChatEntityDefinition): void {
    const entity = defineChatEntity(definition);
    this.#entities = [...this.#entities.filter((entry) => entry.type !== entity.type), entity];
    this.#render();
  }

  /** Adds or replaces (same id) a `/` command; same definition as `defineChatCommand`. */
  defineCommand(definition: ChatCommandDefinition): void {
    const command = defineChatCommand(definition);
    this.#commands = [...this.#commands.filter((entry) => entry.id !== command.id), command];
    this.#render();
  }

  /** Adds a reference to an entity, resolved by id, to the composer. False before mount or when refused. */
  async mentionEntity(type: string, id: string): Promise<boolean> {
    return this.#api ? this.#api.mentionEntity(type, id) : false;
  }

  /** Sends a user message through the embedded chat. False before mount. */
  send(text: string): boolean {
    if (!this.#api || !text.trim()) return false;
    this.#api.send(text);
    return true;
  }

  connectedCallback(): void {
    this.#pendingUnmount = false;
    this.#loadInteractions();
    if (!this.#root) {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
```

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
      this.#root = null;
      this.#style = null;
      this.#send = null;
      root?.unmount();
      this.shadowRoot?.replaceChildren();
    });
  }

  attributeChangedCallback(): void {
    this.#render();
  }

```

with:

```tsx
      this.#root = null;
      this.#style = null;
      this.#api = null;
      this.#interactionsLoad?.abort();
      root?.unmount();
      this.shadowRoot?.replaceChildren();
    });
  }

  attributeChangedCallback(name?: string): void {
    if (name === 'interactions' || name === 'endpoint') this.#loadInteractions();
    this.#render();
  }

  #locale(): ChatLocaleCode {
    const lang = this.closest('[lang]')?.getAttribute('lang') ?? '';
    return lang.toLowerCase().startsWith('de') ? 'de' : 'en';
  }

  /** `interactions` attribute: GET the data from its URL, or from the endpoint when empty. */
  #loadInteractions(): void {
    if (this.#interactionsFromProperty || !this.isConnected) return;
    this.#interactionsLoad?.abort();
    this.#interactionsLoad = null;
    const attribute = this.getAttribute('interactions');
    const url = attribute === null ? '' : attribute || this.getAttribute('endpoint') || '';
    if (!url) return;
    const controller = new AbortController();
    this.#interactionsLoad = controller;
    void (async () => {
      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = parseChatInteractions(await response.json());
        if (controller.signal.aborted) return;
        this.#interactions = data;
        this.#render();
      } catch {
        if (!controller.signal.aborted) this.#emit('glirastes-chat:error', { message: 'Chat interactions unavailable' });
      }
    })();
  }

  #chatInteractions(): ChatInteractionsConfig | undefined {
    const base = this.#config.chatInteractions;
    const data = this.#interactions ?? base?.data;
    if (!base && !data && this.#entities.length === 0 && this.#commands.length === 0) return undefined;
    return {
      ...base,
      locale: base?.locale ?? this.#locale(),
      ...(data ? { data } : {}),
      entities: [...(base?.entities ?? []), ...this.#entities],
      commands: [...(base?.commands ?? []), ...this.#commands],
    };
  }

```

In `src/embed/glirastes-chat-element.tsx`, replace:

```tsx
    const placeholder = this.getAttribute('placeholder');
    const voiceLanguage = this.getAttribute('voice-language');
    const config: GlirastesChatElementConfig = {
      ...this.#config,
      ...(placeholder
        ? { locale: { ...(this.#config.locale ?? {}), placeholder } }
```

with:

```tsx
    const placeholder = this.getAttribute('placeholder');
    const voiceLanguage = this.getAttribute('voice-language');
    const chatInteractions = this.#chatInteractions();
    const config: GlirastesChatElementConfig = {
      ...this.#config,
      ...(chatInteractions ? { chatInteractions } : {}),
      ...(placeholder
        ? { locale: { ...(this.#config.locale ?? {}), placeholder } }
```

In `src/embed/index.ts`, replace:

```ts
} from './glirastes-chat-element.js';
export { EMBED_CSS_VARIABLES, embedThemeCss } from './theme.js';
```

with:

```ts
} from './glirastes-chat-element.js';
export { EMBED_CSS_VARIABLES, embedThemeCss } from './theme.js';
export {
  defineChatCommand,
  defineChatEntity,
  type ChatCommandDefinition,
  type ChatEntityAction,
  type ChatEntityCard,
  type ChatEntityDefinition,
  type ChatEntityItem,
  type ChatEntitySearchContext,
} from '../react/interactions/definitions.js';
export type {
  ChatInteractionArg,
  ChatInteractionsData,
  ChatLocaleCode,
  ChatText,
} from '../contracts/chat-interactions.js';
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

function normalizeInputValue(text: string): string {
```

with:

```tsx
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

/**
 * The selection inside the editor's own tree. In a shadow root (the
 * `<glirastes-chat>` element) Chromium retargets `window.getSelection()` to
 * the host, so the caret position would be lost; its `ShadowRoot.getSelection()`
 * keeps the real nodes.
 */
function editorSelection(editor: HTMLElement | null): Selection | null {
  const root = editor?.getRootNode() as (Node & { getSelection?: () => Selection | null }) | undefined;
  if (root && root !== editor?.ownerDocument && typeof root.getSelection === 'function') {
    return root.getSelection() ?? window.getSelection();
  }
  return window.getSelection();
}

function normalizeInputValue(text: string): string {
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
      triggerPos: number;
    } | null => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;

```

with:

```tsx
      triggerPos: number;
    } | null => {
      const selection = editorSelection(editableRef.current);
      if (!selection || selection.rangeCount === 0) return null;

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        if (!editableRef.current) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

```

with:

```tsx
        if (!editableRef.current) return;

        const selection = editorSelection(editableRef.current);
        if (!selection || selection.rangeCount === 0) return;

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
    const runAction = useCallback(
      (result: MentionResult, actionId: string) => {
        const selection = window.getSelection();
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
```

with:

```tsx
    const runAction = useCallback(
      (result: MentionResult, actionId: string) => {
        const selection = editorSelection(editableRef.current);
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        // Backspace: delete chip at cursor boundary (mention mode)
        if (hasMentionSupport && event.key === 'Backspace') {
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
```

with:

```tsx
        // Backspace: delete chip at cursor boundary (mention mode)
        if (hasMentionSupport && event.key === 'Backspace') {
          const selection = editorSelection(editableRef.current);
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        if (!plainText) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

```

with:

```tsx
        if (!plainText) return;

        const selection = editorSelection(editableRef.current);
        if (!selection || selection.rangeCount === 0) return;

```

In `src/react/components/rich-mention-input.tsx`, replace:

```tsx
        if (editableRef.current) {
          const range = document.createRange();
          const selection = window.getSelection();
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
```

with:

```tsx
        if (editableRef.current) {
          const range = document.createRange();
          const selection = editorSelection(editableRef.current);
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bunx vitest run src/embed/__tests__/glirastes-chat-interactions.test.tsx --maxWorkers=4 && bunx vitest run src/embed src/react src/public-subpaths.test.ts --maxWorkers=4 && bun run typecheck
```

Expected: PASS — `Test Files  1 passed (1)`, `Tests  3 passed (3)`; the embed, React and subpath suites (`bunx vitest run src/embed src/react src/public-subpaths.test.ts --maxWorkers=4`) report `Test Files  45 passed (45)`, `Tests  343 passed (343)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add src/embed/__tests__/glirastes-chat-interactions.test.tsx src/embed/glirastes-chat-element.tsx src/embed/index.ts src/react/components/rich-mention-input.tsx
git commit -m "feat(embed): define chat entities and commands on the chat element"
```

### Task 14: Keyboard, ARIA and React/embed parity in Chrome

**Files:**
- Create: `tests/browser/chat-interactions-fixture.tsx` (bundled by Bun from `src/`; the same entities and commands in the React chat and in `<glirastes-chat>`, a recording transport, no model and no network), `tests/chat-interactions-browser.test.mjs` (Node test runner, Playwright from `PLAYWRIGHT_MODULE`, system Chrome)

**Interfaces:**
- Consumes: Tasks 8–13 from source (no `dist/` needed); the self-contained pattern of `tests/voice-press-browser.test.mjs` (own Bun build into a temporary directory, own loopback server, `rmSync` afterwards).
- Produces: `window.interactionsHarness.sent` (deliberately not a typed global: `tests/browser/voice-press-fixture.tsx` declares `window.harness` in the same `typecheck:tests` program); three tests that run unchanged for `?view=react` and `?view=embed`: a `/` command alone (listbox, `aria-controls`, `aria-activedescendant`, live count, ArrowDown, Enter, Enter), an `@` entity action (ArrowRight, ArrowLeft, Enter; the typed `@query` disappears), and the argument form twice (a select by type-ahead for `/Filter Tasks`, an entity combobox for the person of `/Assign @Release prüfen`, focus back in the editor).

- [ ] **Step 1: Write the browser fixture and test**

Create `tests/browser/chat-interactions-fixture.tsx`:

```tsx
// Browser fixture for tests/chat-interactions-browser.test.mjs: the same `@`
// entities and `/` commands in React and in <glirastes-chat>. No model, no
// network: the transport records what the composer sends.
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatInteractionsData } from '../../src/contracts/chat-interactions.js';
import { defineGlirastesChatElement, type GlirastesChatElement } from '../../src/embed/index.js';
import { AiChatPanel } from '../../src/react/components/ai-chat-panel.js';
import { defineChatCommand, defineChatEntity } from '../../src/react/interactions/definitions.js';
import { AiChatProvider } from '../../src/react/provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport } from '../../src/react/types.js';

const sent: string[] = [];
// Not declared as a global `Window` property: other browser fixtures declare
// `window.harness` with their own types in the same `typecheck:tests` program.
Object.assign(window, { interactionsHarness: { sent } });

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: { de: 'Aufgaben filtern', en: 'Filter Tasks' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen', description: 'open' }, { id: '8', label: 'Report schreiben' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  actions: [
    { id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
    { id: 'task.open', label: 'Open', entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
  ],
});

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: (query) => [{ id: 'alice', label: 'Alice Example' }, { id: 'bob', label: 'Bob Builder' }]
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
});

const assign = defineChatCommand({
  id: 'tasks.assign',
  label: 'Assign',
  args: [
    { name: 'taskId', label: 'Task', required: true, entity: 'task' },
    { name: 'assignee', label: 'Person', required: true, entity: 'person' },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

const noop = () => {};

function useRecordingTransport(): ChatTransport {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const sendMessage = useCallback(async ({ text }: { text: string }) => {
    sent.push(text);
    setMessages((previous) => [...previous, { id: `user-${previous.length}`, role: 'user', parts: [{ type: 'text', text }] }]);
  }, []);
  return useMemo<ChatTransport>(() => ({
    messages, status: 'ready', error: null, sendMessage, stop: noop, setMessages, addToolApprovalResponse: noop,
  }), [messages, sendMessage]);
}

function ReactView() {
  const transport = useRecordingTransport();
  const interactions = useMemo(() => ({ data, entities: [task, person], commands: [assign] }), []);
  return (
    <div style={{ height: 640 }}>
      <AiChatProvider transport={transport} chatInteractions={interactions}>
        <AiChatPanel />
      </AiChatProvider>
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'react';
const root = document.getElementById('root')!;
if (view === 'embed') {
  defineGlirastesChatElement();
  const element = document.createElement('glirastes-chat') as GlirastesChatElement;
  element.style.display = 'block';
  element.style.height = '640px';
  element.transport = {
    messages: [], status: 'ready', error: null,
    async sendMessage({ text }) { sent.push(text); },
    stop: noop, setMessages: noop, addToolApprovalResponse: noop,
  };
  element.interactions = data;
  element.defineEntity(task);
  element.defineEntity(person);
  element.defineCommand(assign);
  root.append(element);
} else {
  createRoot(root).render(<ReactView />);
}
```

Create `tests/chat-interactions-browser.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `@` entities and `/` commands with the keyboard only, in real Chrome, once
// in the React chat and once in <glirastes-chat> (shadow DOM): same keys,
// same ARIA, same messages. No model and no network: the transport records.
// Run: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome \
//   node --test tests/chat-interactions-browser.test.mjs
const root = fileURLToPath(new URL('..', import.meta.url));

let workDir;
let server;
let origin;
let browser;

before(async () => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  workDir = mkdtempSync(join(tmpdir(), 'chat-interactions-'));
  // --outdir: the panel imports styles.css, so Bun emits a stylesheet next to the script.
  const build = spawnSync('bun', [
    'build', '--production', '--format=iife',
    'tests/browser/chat-interactions-fixture.tsx',
    '--outdir', workDir,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const script = join(workDir, 'chat-interactions-fixture.js');
  const files = {
    '/': ['text/html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body style="margin:0;font:16px/1.5 system-ui,sans-serif"><div id="root"></div><script src="/fixture.js"></script></body></html>'],
    '/fixture.js': ['text/javascript', readFileSync(script, 'utf8')],
    '/styles.css': ['text/css', readFileSync(join(root, 'src/react/styles.css'), 'utf8')],
  };
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = files[path];
    if (!file) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, { 'content-type': `${file[0]}; charset=utf-8` }).end(file[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** The direct command a sent text carries, or a failed assertion. */
function command(text) {
  const match = /^<!--glirastes:command (\{[^\n]*\})-->\n(.*)$/.exec(text);
  assert.ok(match, `not a direct command: ${text}`);
  return { ...JSON.parse(match[1]), label: match[2] };
}

async function open(view) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(`${origin}/?view=${view}`);
  const editor = page.getByRole('textbox', { name: 'Type a message...' });
  await editor.waitFor();
  const sent = () => page.evaluate(() => window.interactionsHarness.sent);
  const waitForSent = (count) => page.waitForFunction((wanted) => window.interactionsHarness.sent.length === wanted, count);
  /** The editor's `aria-activedescendant`, resolved inside the editor's own tree (document or shadow root). */
  const active = () => editor.evaluate((node) => {
    const id = node.getAttribute('aria-activedescendant');
    const option = id ? node.getRootNode().getElementById(id) : null;
    if (!option) return null;
    const text = option.getAttribute('aria-label') ?? option.querySelector('[data-element="label"]')?.textContent ?? option.textContent;
    return { text, selected: option.getAttribute('aria-selected') };
  });
  /** Focus moves back to the editor once the form is gone; give React that render. */
  const editorFocused = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await editor.evaluate((node) => node.getRootNode().activeElement === node)) return true;
      await page.waitForTimeout(50);
    }
    return false;
  };
  return { page, editor, errors, sent, waitForSent, active, editorFocused, close: () => context.close() };
}

for (const view of ['react', 'embed']) {
  describe(`chat interactions by keyboard (${view})`, () => {
    test('a / command runs alone, with listbox semantics the editor controls', async () => {
      const { page, editor, errors, sent, waitForSent, active, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('/');
        const listbox = page.getByRole('listbox', { name: 'Suggestions' });
        await listbox.waitFor();
        assert.deepEqual(await listbox.getByRole('option').allTextContents(), ['Assign', 'Filter Tasks', 'Open Overview']);
        assert.equal(await editor.getAttribute('aria-controls'), await listbox.getAttribute('id'));
        assert.equal(await editor.getAttribute('aria-autocomplete'), 'list');
        assert.deepEqual(await active(), { text: 'Assign', selected: 'true' });
        assert.equal(await page.getByRole('status').textContent(), '3 suggestions');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.deepEqual(await active(), { text: 'Open Overview', selected: 'true' });
        await page.keyboard.press('Enter');
        assert.equal(await listbox.count(), 0);
        assert.equal(await editor.getAttribute('aria-activedescendant'), null);
        await page.keyboard.press('Enter');
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' }, label: '/Open Overview',
        });
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    test('an @ entity action is reached with ArrowRight and runs with Enter', async () => {
      const { page, editor, errors, sent, waitForSent, active, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        assert.deepEqual(await active(), { text: 'Release prüfen', selected: 'true' });
        await page.keyboard.press('ArrowRight');
        assert.deepEqual(await active(), { text: 'Complete: Release prüfen', selected: 'true' });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowLeft');
        assert.deepEqual(await active(), { text: 'Complete: Release prüfen', selected: 'true' });
        await page.keyboard.press('Enter');
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' }, label: '/Complete @Release prüfen',
        });
        assert.equal(await editor.textContent(), '');
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    test('missing arguments are asked for in a form and the command then runs', async () => {
      const { page, editor, errors, sent, waitForSent, editorFocused, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('/filter');
        await page.getByRole('option', { name: 'Filter Tasks' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const filterForm = page.getByRole('form', { name: 'Details for Filter Tasks' });
        await filterForm.waitFor();
        const status = filterForm.getByRole('combobox', { name: 'Status' });
        assert.equal(await status.evaluate((node) => node.getRootNode().activeElement === node), true);
        await page.keyboard.press('d');
        assert.equal(await status.inputValue(), 'done');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'filter.tasks', tool: 'ui.filter.tasks', args: { status: 'done' }, label: '/Filter Tasks done',
        });
        assert.equal(await filterForm.count(), 0);
        assert.equal(await editorFocused(), true);

        await page.keyboard.type('/assign');
        await page.getByRole('option', { name: 'Assign' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const assignForm = page.getByRole('form', { name: 'Details for Assign' });
        await assignForm.waitFor();
        const person = assignForm.getByRole('combobox', { name: 'Person *' });
        assert.equal(await person.evaluate((node) => node.getRootNode().activeElement === node), true);
        await page.keyboard.type('ali');
        await assignForm.getByRole('option', { name: 'Alice Example' }).waitFor();
        assert.equal(await person.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Enter');
        assert.equal(await person.inputValue(), 'Alice Example');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await waitForSent(2);
        assert.deepEqual(command((await sent())[1]), {
          commandId: 'tasks.assign', tool: 'tasks.assign', args: { taskId: '7', assignee: 'alice' },
          label: '/Assign @Release prüfen @Alice Example',
        });
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });
  });
}
```

- [ ] **Step 2: Run the browser test in Chrome**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-interactions-browser.test.mjs
```

Expected: PASS — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`. These are acceptance tests over Tasks 8–13 and pass on the first run; a failure names the view and the step (keyboard, ARIA, form) and is a defect in the code under test — fix it there, not in the test. No browser is downloaded, and the build directory is removed afterwards.

- [ ] **Step 3: Type-check the test sources**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run build && bun run typecheck:tests
```

Expected: both exit 0 (`Generated 18 subpath shims.`; the fixture passes the strict test program).

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add tests/browser/chat-interactions-fixture.tsx tests/chat-interactions-browser.test.mjs
git commit -m "test(react): prove chat interactions by keyboard in react and the embed"
```

### Task 15: Derived commands in the real Next reference app

**Files:**
- Modify: `examples/source-driven-next/browser-shell/src/app/chat/route.js` (`GET = createChatInteractionsHandler(…)` with the chat's own `managedRuntime`), `examples/source-driven-next/browser-shell/src/app/(app)/layout.jsx` (`useChatInteractionsData('/chat')` feeds `chatInteractions`)
- Test: `tests/source-driven-browser.test.mjs` (Modify: wait for the provider composer before the first `fill`; new direct-command steps after the model-driven ones; diagnostic text)

**Interfaces:**
- Consumes: Tasks 4, 6, 7 and 9–11 through the built package (the shell links this worktree as `glirastes`, so `bun run build` must run first); P04's browser proof (`prepare-browser.mjs`, port 3191, deterministic test model, the archive page added during the test).
- Produces: in the real app the derived commands `filter.tasks`, `open.archive`, `open.home`, `open.layout-proof`, `open.overview`, `open.tasks`, `tasks.highlight` (the browser shell adds `/` and `/layout-proof`, the test adds `/archive`); `GET /chat` answers 401 without a session; `/Open Overview` and `/Filter Tasks` (status `done` through the argument form) run without the test model and reach the app router; the bubble shows `/Open Overview`, never the marker. The earlier model-driven steps keep passing with the provider composer (contenteditable) instead of the textarea.

- [ ] **Step 1: Extend the browser proof**

In `tests/source-driven-browser.test.mjs`, replace:

```js
  const native = page.getByTestId('native-ui');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const input = page.getByRole('textbox', { name: 'Type a message...' });
  async function chat(text) {
```

with:

```js
  const native = page.getByTestId('native-ui');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  // The layout loads the derived `/` commands; the composer then searches them.
  await page.locator('[data-component="mention-input"][data-mode="providers"]').waitFor();
  const input = page.getByRole('textbox', { name: 'Type a message...' });
  async function chat(text) {
```

In `tests/source-driven-browser.test.mjs`, replace:

```js
  await chat('Highlight Write tests');
  await native.locator('li[aria-current="true"]', { hasText: 'Write tests' }).waitFor();
  if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
  await page.goto(`${origin}/layout-proof`);
```

with:

```js
  await chat('Highlight Write tests');
  await native.locator('li[aria-current="true"]', { hasText: 'Write tests' }).waitFor();

  // Direct `/` commands: derived from the code, served per user, run without the model.
  const served = await fetch(`${origin}/chat`, { headers: { cookie } });
  assert.equal(served.status, 200);
  assert.deepEqual((await served.json()).commands.map((entry) => entry.id),
    ['filter.tasks', 'open.archive', 'open.home', 'open.layout-proof', 'open.overview', 'open.tasks', 'tasks.highlight']);
  assert.equal((await fetch(`${origin}/chat`)).status, 401);
  const nextPost = () => page.waitForResponse((response) => response.url() === `${origin}/chat` && response.request().method() === 'POST');
  await input.click();
  await page.keyboard.type('/open-ov');
  await page.getByRole('option', { name: 'Open Overview' }).waitFor();
  await page.keyboard.press('Enter');
  const opened = nextPost();
  await page.keyboard.press('Enter');
  const openedWire = await (await opened).text();
  assert.match(openedWire, /tool-output-available/);
  assert.doesNotMatch(openedWire, /Reference response complete/, 'a direct command must not reach the model');
  await native.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/overview');
  await page.getByText('/Open Overview', { exact: true }).waitFor();
  assert.equal(await page.getByText('glirastes:command').count(), 0);
  await input.click();
  await page.keyboard.type('/filter');
  await page.getByRole('option', { name: 'Filter Tasks' }).waitFor();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.getByRole('form', { name: 'Details for Filter Tasks' }).waitFor();
  await page.keyboard.press('d');
  const filtered = nextPost();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.doesNotMatch(await (await filtered).text(), /Reference response complete/);
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  assert.equal(new URL(page.url()).search, '?status=done');
  if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
  await page.goto(`${origin}/layout-proof`);
```

In `tests/source-driven-browser.test.mjs`, replace:

```js
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /Module not found|Error:|Warning:/);
  t.diagnostic('Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, and common desktop/mobile layout geometry and draft retention. Test model only; no LLM/STT/timing claim.');
});
```

with:

```js
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /Module not found|Error:|Warning:/);
  t.diagnostic('Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, derived / commands run without the model, and common desktop/mobile layout geometry and draft retention. Test model only; no LLM/STT/timing claim.');
});
```

- [ ] **Step 2: Run it to verify it fails**

Port 3191 must be free (`lsof -i :3191` prints nothing; another agent's browser proof uses the same port — wait for it instead of killing anything). Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run build && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
```

Expected: FAIL — the main test stops at `waiting for locator('[data-component="mention-input"][data-mode="providers"]') to be visible` (`TimeoutError` after 30 s: the shell does not load interactions yet, so the composer stays the plain textarea); the five cleanup tests pass. `ℹ tests 6`, `ℹ pass 5`, `ℹ fail 1`

- [ ] **Step 3: Serve and use the interactions in the shell**

In `examples/source-driven-next/browser-shell/src/app/(app)/layout.jsx`, replace:

```jsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import { GlirastesBridge } from '../../glirastes-bridge.jsx';

// The chat and the navigation bridge live in the layout, so they survive the
// page changes that ui.navigate and ui.filter.tasks ask the router for.
export default function AppLayout({ children }) {
  return <main>
    <p>Native app + Glirastes SDK — deterministic test model</p>
    {children}
    <GlirastesBridge />
    <VercelAiChat endpoint="/chat" title="App assistant" defaultOpen showMic={false} />
  </main>;
}
```

with:

```jsx
'use client';
import { useMemo } from 'react';
import { useChatInteractionsData } from 'glirastes/react';
import { VercelAiChat } from 'glirastes/react/vercel';
import { GlirastesBridge } from '../../glirastes-bridge.jsx';

// The chat and the navigation bridge live in the layout, so they survive the
// page changes that ui.navigate and ui.filter.tasks ask the router for.
export default function AppLayout({ children }) {
  // `/` commands derived from the app's pages, filters and actions; they run without the model.
  const data = useChatInteractionsData('/chat');
  const chatInteractions = useMemo(() => (data ? { data } : undefined), [data]);
  return <main>
    <p>Native app + Glirastes SDK — deterministic test model</p>
    {children}
    <GlirastesBridge />
    <VercelAiChat endpoint="/chat" title="App assistant" defaultOpen showMic={false} chatInteractions={chatInteractions} />
  </main>;
}
```

In `examples/source-driven-next/browser-shell/src/app/chat/route.js`, replace:

```js
import { createAiChatHandler } from 'glirastes/server/nextjs';
import { createGeneratedRuntimeSource, materializeManifestToolRegistry } from 'glirastes/runtime';
import * as generated from '../../generated/glirastes/tools.generated.js';
```

with:

```js
import { createAiChatHandler, createChatInteractionsHandler } from 'glirastes/server/nextjs';
import { createGeneratedRuntimeSource, materializeManifestToolRegistry } from 'glirastes/runtime';
import * as generated from '../../generated/glirastes/tools.generated.js';
```

In `examples/source-driven-next/browser-shell/src/app/chat/route.js`, replace:

```js
});

export const runtime = 'nodejs';
export const POST = createAiChatHandler({
  managedRuntime: { resolvePrincipal: resolveSession, resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context) },
  loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings }),
  model: () => testModel(),
  systemPrompt: 'Use only the available native queries; ask when the target is unclear.',
  maxSteps: 3, maxOutputTokens: 200, emitStepReports: true,
});
```

with:

```js
});

const managedRuntime = {
  resolvePrincipal: resolveSession,
  resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context),
};

export const runtime = 'nodejs';
export const POST = createAiChatHandler({
  managedRuntime,
  loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings }),
  model: () => testModel(),
  systemPrompt: 'Use only the available native queries; ask when the target is unclear.',
  maxSteps: 3, maxOutputTokens: 200, emitStepReports: true,
});
// The `/` commands and `@` entities this user may run, derived by `glirastes tools refresh`.
export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, managedRuntime });
```

- [ ] **Step 4: Run the proof in dev and production**

Run (port 3191 free before each run):

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && REFERENCE_NEXT_MODE=production PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
```

Expected: both runs end with `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`; the last test's diagnostic reads "Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, derived / commands run without the model, …". The runner removes its `.browser-proof-*` app afterwards.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add 'examples/source-driven-next/browser-shell/src/app/(app)/layout.jsx' examples/source-driven-next/browser-shell/src/app/chat/route.js tests/source-driven-browser.test.mjs
git commit -m "test(examples): run derived slash commands in the next reference app"
```

### Task 16: Document chat interactions

**Files:**
- Create: `docs/chat-interactions.md`
- Modify: `examples/source-driven-next/README.md` (one paragraph in "Real Next and browser test")

**Interfaces:**
- Consumes: the surface of Tasks 1–15.
- Produces: the developer documentation of derivation, overrides, the GET handler, React, `<glirastes-chat>`, the send semantics (incl. metrics and `directCommands`) and keyboard use. `skills/building-glirastes-chat-ui/SKILL.md` is deliberately not touched (P05 revises every skill; see the merge table).

- [ ] **Step 1: Write the documentation**

Create `docs/chat-interactions.md`:

````markdown
# Chat interactions: `@` entities and `/` commands

Every Glirastes chat can offer the things (`@`) and commands (`/`) of its app.
They are declarative, derived from the code where possible, and run through
the same server-side tool execution as the model. Nothing about them goes to
the Glirastes Platform.

## Where they come from

`glirastes tools refresh` writes `chatInteractions` into the generated module
(`src/generated/glirastes/tools.generated.*`), next to `toolCatalog`:

| Derived from | Becomes |
| --- | --- |
| A page without parameters (`ui.navigate`) | `/` command `open.<path>` ("Open Overview") |
| A URL filter (`ui.filter.<view>`) | `/` command `filter.<view>`; its keys are arguments, enums become choices |
| A client action (`ui.<actionId>`) | `/` command `<actionId>`; its payload fields are arguments |
| A read endpoint with `search`, `q`, `query` or `term` whose output lists objects with `id` and `title`/`name`/`displayName`/`label`/`subject`/`email` (`GET /api/tasks?search=`) | `@` entity `task`, searched with the user's session |
| An endpoint with one path parameter below that collection (`PATCH /api/tasks/:id`, `POST /api/tasks/:id/complete`) | Context action of the entity ("Edit", "Complete") |
| A page with one parameter of that entity (`/tasks/:taskId`) | Context action "Open" |

Only enabled tools count: a disabled, `needs_attention` or excluded tool
derives nothing. Labels are English and German defaults built from
identifiers; better labels, synonyms and icons come from
`.glirastes/chat-interactions.json` (written by people or the
`describing-glirastes-tools` skill, never by the generator):

```json
{
  "schemaVersion": 1,
  "commands": {
    "open.overview": { "label": { "de": "Übersicht öffnen", "en": "Open overview" }, "keywords": ["start"] },
    "filter.tasks": { "hidden": true },
    "standup": { "label": "Stand-up", "run": { "kind": "prompt", "prompt": { "de": "Fasse meinen Tag zusammen." } } }
  },
  "entities": {
    "task": { "label": { "de": "Aufgabe", "en": "Task" }, "actions": { "task.tasks.delete": { "hidden": true } } }
  }
}
```

A patch replaces the fields it names, `hidden: true` removes an entry, and a
complete entry under a new id is added. An invalid file throws when the
handler is created, like an invalid tool policy. `hidden` only shapes the
lists; it is no permission. What a user may run is decided by the tool policy
and the app's endpoints, for direct commands exactly as for the model.

## Serving them

The chat route serves the interactions with a GET next to its POST. With
`managedRuntime` the answer is per user: commands, actions and searches whose
tool this user may not run (Platform disabled, roles, revocation, not
deployed) are left out.

```js
import { createAiChatHandler, createChatInteractionsHandler } from 'glirastes/server/nextjs';
import * as generated from '../../generated/glirastes/tools.generated.js';
import overrides from '../../../.glirastes/chat-interactions.json' with { type: 'json' };

export const POST = createAiChatHandler({ managedRuntime, loadTools, model, systemPrompt });
export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime });
```

Without `managedRuntime` the handler serves the same list to every caller and
checks no session (the list names commands and endpoint paths, never data);
wrap it with the app's own session check when even that should stay private.

## React

```tsx
import { defineChatCommand, defineChatEntity, useChatInteractionsData } from 'glirastes/react';

const person = defineChatEntity({
  type: 'person',
  label: { de: 'Person', en: 'Person' },
  search: async (query, { signal }) => (await fetch(`/api/people?q=${encodeURIComponent(query)}`, { signal })).json(),
  resolve: async (id) => (await fetch(`/api/people/${encodeURIComponent(id)}`)).json(),
  card: (item) => ({ title: item.label, subtitle: item.description }),
});
const assign = defineChatCommand({
  id: 'tasks.assign',
  label: { de: 'Zuweisen', en: 'Assign' },
  args: [
    { name: 'taskId', label: 'Task', required: true, entity: 'task' },
    { name: 'assigneeId', label: 'Person', required: true, entity: 'person' },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

function Chat() {
  const data = useChatInteractionsData('/api/chat');
  const chatInteractions = useMemo(() => ({ data, entities: [person], commands: [assign], locale: 'de' }), [data]);
  return <VercelAiChat endpoint="/api/chat" chatInteractions={chatInteractions} />;
}
```

App definitions replace derived ones with the same id or type.
`useChatContext().mentionEntity('task', id)` puts a reference to one entity
into the composer (through the entity's `resolve`). `chatInteractions` already
offers the generated UI tools as `/` commands; drop an earlier
`createUiToolCommandProvider` from `completionProviders`, or the `/` list can
show a command twice (results are only merged when type and id match), and
the entry of the older provider still goes through the model.

## `<glirastes-chat>`

```html
<glirastes-chat endpoint="/api/chat" interactions></glirastes-chat>
<script type="module">
  import { defineGlirastesChatElement } from 'glirastes/embed';
  defineGlirastesChatElement();
  const chat = document.querySelector('glirastes-chat');
  chat.defineEntity(person);
  chat.defineCommand(assign);
  // chat.interactions = generated.chatInteractions; // instead of the attribute
  // await chat.mentionEntity('task', '42');
</script>
```

`interactions` without a value loads from `endpoint`, with a value from that
URL. Labels follow the nearest `lang` attribute (`de`, else `en`).

## What happens on send

| Run | Effect | Model call |
| --- | --- | --- |
| `ui` | a generated UI tool (navigation, filter, client action); the result's UI action goes to the app's bridge | no |
| `tool` | any catalog tool with the given arguments | no |
| `prompt` | the prepared instruction replaces the command and goes to the model | yes |

A `/` command sent alone (its `@` references fill its entity arguments)
becomes one user message `<!--glirastes:command {"commandId":…,"tool":…,"args":{…}}-->`
plus its visible label. Missing arguments open a form first; a command with
only optional arguments asks once. A command mixed with free text goes to the
model as before, with the command as a tool reference.

The chat handler runs such a message without routing, guardrails or a model:
the tool comes from the same registry, wrapped like on the model path, so the
managed guard (manifest, principal, roles, revocation, budget), confirmation
(`requiresApproval`, risk tier 3), audit and a configured PII shield apply
unchanged (the result stays in the history the model reads on later turns,
so it is pseudonymized like a model call's result). A tool that needs
confirmation answers with the normal approval card; the approval round trip
runs it. Every such request records one metric event: `model: null`, tokens 0,
cost unknown (`null`), the executed call as tool count. `directCommands: false`
on `createAiChatHandler` turns this off; the message then goes to the model.

## Keyboard and screen readers

- The editor is the `textbox` that controls the suggestion `listbox`
  (`aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`); a
  polite live region announces the number of suggestions.
- ArrowUp/ArrowDown move between results, ArrowRight/ArrowLeft between an
  entity and its actions, Enter or Tab picks, Escape closes.
- The argument form starts at the first empty required field; entity fields
  are ARIA 1.2 comboboxes; Escape closes an open list first, then cancels.
````

In `examples/source-driven-next/README.md`, replace:

```markdown
normal app command regenerates the navigation schema before starting Next.

The browser shell's `dev` script runs `glirastes tools refresh --keep-going`
before `next dev`; `build` runs `glirastes tools refresh` before `next build`
```

with:

```markdown
normal app command regenerates the navigation schema before starting Next.

The chat route also serves the `/` commands that `glirastes tools refresh`
derives from the pages, the URL filter and the client action
(`createChatInteractionsHandler`, a GET next to the chat POST; see
`docs/chat-interactions.md`). The test picks `/Open Overview` and `/Filter
Tasks` with the keyboard, fills the filter's argument form and checks that
both run without the test model and still reach the app router.

The browser shell's `dev` script runs `glirastes tools refresh --keep-going`
before `next dev`; `build` runs `glirastes tools refresh` before `next build`
```

- [ ] **Step 2: Check that every documented name exists**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && for name in createChatInteractionsHandler useChatInteractionsData defineChatEntity defineChatCommand mentionEntity directCommands; do printf "%s " "$name"; grep -rl "$name" src/server/adapters/nextjs/index.ts src/server/adapters/nextjs/types.ts src/react/index.ts src/react/provider/chat-context.ts src/embed/index.ts | wc -l; done && git diff --check
```

Expected: every name is found in at least one file — the counts (padded by `wc -l`) are 1 for `createChatInteractionsHandler`, `useChatInteractionsData`, `mentionEntity` and `directCommands` and 2 for `defineChatEntity` and `defineChatCommand` — and `git diff --check` prints nothing.

- [ ] **Step 3: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
git add docs/chat-interactions.md examples/source-driven-next/README.md
git commit -m "docs(chat): document chat entities, commands and direct runs"
```

### Task 17: Full gates, browser tests and CLI smoke run

**Files:** none (verification only, no commit).

- [ ] **Step 1: Run every gate**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && bun run typecheck && bun run build && bun run typecheck:tests && bunx vitest run --maxWorkers=4
```

Expected: every command exits 0 — the build prints `Generated 18 subpath shims.`; Vitest reports `Test Files  224 passed (224)` and `Tests  2353 passed (2353)` (measured in about 120 s at a load average around 20, without timeouts or reruns) (baseline 210 files and 2256 tests plus 14 files and 97 tests from this plan). On a loaded machine a timeout confined to the known timing files (`src/codegen/tools/handler-analysis.test.ts`, `program.test.ts`, `schema-probe.test.ts`, `src/react/components/__tests__/voice-push-to-talk.test.tsx`, the embed timing tests) counts as load noise only if the file passes when rerun alone (`bunx vitest run <file>`); note the load in the checkpoint instead of changing those tests.

- [ ] **Step 2: Run the browser tests**

Port 3191 must be free. Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-interactions-browser.test.mjs
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-browser.test.mjs
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/recording-bar-browser.test.mjs tests/voice-press-browser.test.mjs
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && REFERENCE_NEXT_MODE=production PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
```

Expected: `tests/chat-interactions-browser.test.mjs` `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`; `tests/chat-browser.test.mjs` `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`; recording bar and voice press `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`; the Next proof in dev and in production `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0` each, with the diagnostic of Task 15. No browser is downloaded; no `.browser-proof-*` directory is left in `examples/source-driven-next`.

- [ ] **Step 3: Smoke the built CLI on a copy of the fixture**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat \
  && SMOKE=$(mktemp -d examples/source-driven-next/.smoke-XXXXXX) \
  && cp -R examples/source-driven-next/native/. "$SMOKE" \
  && mkdir -p "$SMOKE/node_modules" && ln -s "$PWD" "$SMOKE/node_modules/glirastes" \
  && node dist/cli/bin.js tools refresh --root "$SMOKE" \
  && node dist/cli/bin.js tools check --root "$SMOKE" \
  && node dist/cli/bin.js tools check --integrity-only --root "$SMOKE" \
  && node --input-type=module -e "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); console.log(m.chatInteractions.commands.map((c) => c.id).join(' '))" "$SMOKE/src/generated/glirastes/tools.generated.js"; \
  STATUS=$?; node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "$SMOKE"; exit $STATUS
```

Expected: refresh prints `Glirastes tools (write): 4 added, 0 changed, 0 removed` with the four tools of P04 (`ui.filter.tasks`, `ui.navigate`, `ui.tasks.highlight`, `tasks.list`), the checks print `Tool outputs match the code.` and `Tool outputs verified (integrity).`, and the last line lists the derived commands `filter.tasks open.overview open.tasks tasks.highlight`; exit 0; the copy is gone afterwards.

- [ ] **Step 4: Record the checkpoint (no commit)**

Note in the P07b checkpoint report: gate results and test counts (with load and any rerun-alone), the five browser runs, the smoke output, and the open items of the Self-Review (Platform lockstep request on direct-command turns, P05 skill and Stage-2 hand-over, P06 fixture derivation, P11 Get It Done wiring, merge order with P04b/P05).

---

## Self-Review

**Spec coverage (spec section → task):**

| Spec | Covered by |
| --- | --- |
| 6a Entitäten: `defineChatEntity({ type, label: { de, en }, search(query, ctx), resolve?(id), card?, actions? })`; the pick inserts a structured reference `{ type, id, label }` the model receives unambiguously | Tasks 2, 8 (definition, search, card), 9 (`mentionEntity` through `resolve`), 10 (`{{mention:type:id:label}}` with the typed trigger) |
| 6a Kontextaktionen per Maus und Tastatur ("Öffnen", "Erledigen", "Zuweisen …") | Tasks 3 (derived), 8 (provider), 10 (group rows, ArrowRight/ArrowLeft, click), 11 (missing arguments), 14 (Chrome) |
| 6a Befehle `defineChatCommand({ id, label, args?, run })` with `ui`, `tool` (same server execution incl. rights, confirmation, revocation, budget) and `prompt` | Tasks 1, 2, 5, 6, 8, 9 |
| 6a Argumente als `@`-Referenzen (`/zuweisen @Aufgabe @Person`); fehlende Argumente fragt die UI gezielt ab | Tasks 8 (`planMessage`), 11 (form), 14 (`/Assign @Release prüfen` then the person) |
| 6a Ableitung: Entitätssuche aus lesenden Such-/Listen-Endpunkten mit Suchparameter und ID/Label im Ausgabeschema; Kontextaktionen aus Endpunkten mit Pfadparameter; Befehle aus UI-Aktionen, Navigation, Filtern | Task 3; Task 4 (Next fixture plus a notes collection) |
| 6a Ausgabe im generierten Modul; Übersteuerung in `.glirastes/chat-interactions.json` oder im App-Code | Task 4 (`chatInteractions`, one export instead of two, see decisions), Tasks 2 and 7 (overrides), Tasks 8 and 13 (app definitions replace derived ones) |
| 6a Framework-unabhängig: React (Provider-Props/Hooks) und `<glirastes-chat>` per JS-API (`el.defineEntity`, `el.defineCommand`) bzw. automatisch | Tasks 9 (`chatInteractions`, `useChatInteractionsData`), 13 (`defineEntity`, `defineCommand`, `interactions`), 14 (parity) |
| 6a Sicherheit: Suchen mit der Session über App-Endpunkte; direkte Tool-Befehle nutzen exakt die normale Tool-Ausführung; nichts an die Platform | Tasks 5–7 (guard, confirmation, PII shield on the command's result, per-user GET), 8 (`credentials: 'same-origin'`), Global Constraints |
| 6a Tests: `ui`/`tool` ohne Modellaufruf (Mock nachweislich nicht aufgerufen); Rückfrage und Rechte; Referenzen strukturiert; Tastatur und ARIA im Browser; React und `<glirastes-chat>` gleich | Tasks 6 (`doStreamCalls` 0), 15 (no test-model text in the wire), 5–6 (confirmation, roles, Platform disable), 10 (references), 14 (keyboard, ARIA, parity) |
| Roadmap: direct commands and the metric recorder; `create-ai-chat-handler.ts` changed by P09 and P07b (P09 item 8, X6) | Tasks 5 and 6 (one event per request, pinned), built on the merged handler |
| P04 item 13: commands from UI tools, bus of `glirastes/browser`, Platform disable / write confirmation / `navigation-bridge-missing` for direct `ui` commands | Tasks 3 (enabled UI tools only), 6 (guard), 9 (the existing `dispatchToolResultUiActions` path) |

Not in P07b by the roadmap or by design: derivation assertions on the React+NestJS and Vue+FastAPI fixtures (P06 builds them; the Vue fixture uses `<glirastes-chat interactions>`), replacing Get It Done's `UI_COMMANDS` and its mention search (P11), labels, synonyms and icons written by Stage 2 into `.glirastes/chat-interactions.json` and the skill text for it (P05), a reader of `.glirastes/chat-interactions.json` inside `tools refresh`/`check` (the file is applied at runtime by `createChatInteractionsHandler`; a refresh-time validation can follow in P05 without changing the format).

**Deliberate decisions and deviations (veto possible):**
- The command travels as a text marker (`<!--glirastes:command {…}-->` plus the label), not as message metadata: it works with every `ChatTransport` (Vercel, LangGraph, custom, `<glirastes-chat>.send`), survives flat `{ role, content }` session stores and mirrors P07's clarification answer. A user who types a marker by hand gains nothing: the server runs exactly what the user may run anyway, with the same confirmation. Like on the model path (the AI SDK reads approvals from the client's history), the confirmation answer comes from the client; it is a safeguard against unintended runs, not a boundary against the user, and the continuation executes the arguments of the marker, never those of the client's tool part.
- Direct `ui` commands go through the server like `tool` commands instead of dispatching to the bus locally. Only then do Platform disables, roles, revocations and the confirmation of a writing client action apply (P04 item 13); the UI action then reaches the bridge through the existing `dispatchToolResultUiActions` path. Cost: one HTTP round trip per navigation command.
- Metrics: direct commands are counted turns (`model: null`, cost unknown, tool counts), not non-turns, so tool usage and tool errors from commands stay visible in "Was kostet" and "Probleme". The confirmation request counts no call; the approved continuation counts the executed call (the model path counts the call in the requesting step) — direct commands report what actually ran.
- Direct commands skip routing, guardrails (no text reaches a model in this request) and the user callback `onFinish`; audit events come from `toolToAiTool` as on the model path. The PII shield is not skipped (plan check): the command's call and result stay in the client's history, the next model turn sends that assistant message to the model, and `anonymizeMessages` only pseudonymizes user messages, so an unshielded result would reach the model provider; the command's tool is wrapped with `wrapToolsWithShield` like a model call (Task 6 Step 1 pins it). For the same reason its tool call id is provider-safe (at most 40 characters, Task 5 Step 1) and the model copy keeps the call and result (Task 6 Step 1).
- Derivation never fails a refresh (plan check): `renderGeneratedModule` runs `deriveChatInteractions` on every refresh, and a strict parse over everything let one unusual identifier (a blank `z.enum(['', 'open'])` choice, a field named `_`, a nested key with a space) throw `ChatInteractionsError` and stop `tools refresh` for the whole app. Each entry is now checked alone and dropped alone (Task 3 Step 1 pins it).
- One export `chatInteractions` (`{ schemaVersion, entities, commands }`) instead of the two names `chatEntities`/`chatCommands` in spec 6a: actions and argument entities refer to each other, and one validated object is what the GET handler, React and the element consume.
- Derived data is served by a GET next to the chat POST instead of being imported into client code: the generated module imports `glirastes/server` and app schema modules, so it is not client-safe, and only the server knows the user's effective policy. Next server components may still pass `generated.chatInteractions` as props.
- Only string arguments are derived (numbers, booleans and objects would need typed form fields); a required non-string argument drops the command or action. Overrides or app definitions can add such commands.
- The interaction labels' language is a config value (`chatInteractions.locale`, default `en`) in React and the nearest `lang` in the element; `ChatLocale` gets seven new English keys for the list and the form.
- Composer changes beyond the new features, needed by them: the prefix of a picked mention is now the trigger the user typed (a `task` result found with `@` used to become `/task`), the caret moves synchronously after a pick (keys typed within the same frame used to land in front of the token), and the editor reads the caret through its shadow root (Chromium's `window.getSelection()` retargets to the host, so `@`/`/` never worked inside `<glirastes-chat>`). P07's 13 + 18 Chrome tests stay green.

**Platform lockstep request (not done here):**
- P09 Platform half / P08c: a turn with `model: null` and zero tokens is a direct command without model cost. The Citadel cost tiles (design 4.1.2, 4.3) count turns with unknown cost as "Anfragen ohne Kostenangabe" and show "mind. {knownUsd}"; the hourly aggregation should count such turns as known 0 (or report them as "Befehle ohne Modell") instead of `unknownCostTurns`. The SDK event stays as P09 specified (its cost schema cannot say "known zero without a source"). Without this Platform change every app that uses `/` commands shows "mind." and a growing "ohne Kostenangabe" count; the controller must route this request to the P08c plan (and the P09 Platform aggregation) before P08c is written.

**Known limits (open items):**
- P05: `skills/building-glirastes-chat-ui/SKILL.md` and `describing-glirastes-tools` need the chat-interactions section and the `.glirastes/chat-interactions.json` workflow (labels, synonyms as `keywords`, icons); refresh-time validation of that file is optional.
- P06: assert the derived interactions of both new fixtures; the Vue fixture mounts `<glirastes-chat interactions>`.
- P11: Get It Done replaces `UI_COMMANDS` and `src/lib/ai/mention-search.ts` with derived interactions plus app definitions for persons and teams (their endpoints return `members`/`teams` lists the derivation recognises), exports `GET = createChatInteractionsHandler(…)` next to its chat route, and passes `chatInteractions={{ data, locale: 'de' }}`. GID's `uiActionSchema` is unaffected: direct UI commands produce the same generated `glirastes.*` actions.
- Safari/WebKit: `ShadowRoot.getSelection` does not exist there, so `<glirastes-chat>` with providers falls back to `window.getSelection()`; only Chrome is proven. A `getComposedRanges` path is a follow-up when a WebKit browser test exists.
- The approval card of a direct command is the generic one (`approvalDescription` gets the model-facing tool name and the arguments); a command-specific text is a follow-up.
- The confirmation round trip of a direct command is proven on the wire (Tasks 5 and 6: approval request, denial, approved continuation under the managed guard) but not in a real browser: the Next fixture has no write tool, and P07's Chrome tests cover no model-path approval either. The client side is the AI SDK's own continuation (`lastAssistantMessageIsCompleteWithApprovalResponses` in the Vercel transport). P06 or P11 (Get It Done has write tools) adds a Chrome step that confirms one direct write command.
- Labels derived without overrides are English words in both languages (`Tasks öffnen`, `Note`); German labels come from `.glirastes/chat-interactions.json` (P05 Stage 2) or app definitions.

**Alignment with P04, P07 and P09 (re-checked against the code at `064f8a9`):** P07's provider search, renderer registry, clarification protocol and voice composer are unchanged in behaviour (their 13 + 18 Chrome tests and the React suites pass); `createUiToolCommandProvider` keeps working beside the new providers. P04's generated UI tools, `uiActionToolToTool`, the bridge and `dispatchToolResultUiActions` are reused as they are; the generated module only gains one export. P09's recorder, sink and event schema are used unchanged (`recordStep` with `UNKNOWN_TURN_COST`, `finish`); the handler's model path, its `turnMetrics` creation and its abort and finish paths are untouched.

**Placeholder scan:** done — every step carries complete code (new files in full, existing files as exact replace blocks that each occur once when applied top to bottom) or exact commands; the only generated file is written by its script; no TBD/TODO, no "similar to Task N". RED and GREEN counts were measured by replaying every task on a fresh `git archive` copy of `064f8a9` with the worktree's `node_modules` linked: each task's test files on its parent (RED), then the task (GREEN), plus the suite runs named in the steps; the browser runs and the CLI smoke ran on the same replay. The plan text was then applied mechanically (every Create and replace block, plus the style generator) to another fresh `git archive` of `064f8a9`; the result is byte-identical to the replayed tree. The plan check re-applied the corrected text with an independent applier to fresh archives and re-measured every count it touched: Task 3 (6), Task 4's generator suites (386), Task 5 (11), Task 6 RED (6 failed) and GREEN (6) with its server suites (43/408), Task 7's server suites (44/412), the full gate of Task 17 (224/2353, typecheck, build and typecheck:tests 0) and the browser runs of Tasks 14 and 15; each new assertion (provider-safe ids, PII shield on the result, derivation that never throws) fails on the uncorrected code and passes on the corrected code.

**Type consistency check:** done — names used verbatim across tasks: `ChatCommandInvocation`, `formatChatCommandMessage`/`parseChatCommandMessage`/`stripChatCommandMarkers`/`serializeChatCommandArgs`/`isChatCommandToolCallId`, `CHAT_COMMAND_TOOL_CALL_PREFIX`, `ChatInteractionsData`/`ChatEntityData`/`ChatCommandData`/`ChatEntityActionData`/`ChatInteractionArg`/`ChatToolRun`/`ChatText`/`ChatLocaleCode`, `parseChatInteractions`/`parseChatInteractionOverrides`/`mergeChatInteractions`/`chatText`/`isChatArgumentPath`, `deriveChatInteractions`, `chatInteractions` (generated export and provider prop), `DirectCommandRequest`/`resolveDirectCommand`/`runDirectCommand`/`stripChatCommandMessages`/`resolveCommandToolName`, `directCommands`, `createChatInteractionsHandler`/`ChatInteractionsHandlerConfig`, `ChatEntityDefinition`/`ChatCommandDefinition`/`ChatEntityItem`/`defineChatEntity`/`defineChatCommand`/`entitiesFromData`/`toChatEntityItem`, `ChatInteractionsConfig`/`ChatInteractionRegistry`/`createChatInteractionRegistry`/`PendingChatCommand`/`ChatSendPlan`, `useChatInteractionsData`, `pendingCommand`/`submitPendingCommand`/`cancelPendingCommand`/`runEntityAction`/`mentionEntity`/`composerMentions`/`consumeComposerMentions`, `CompletionItemAction`, `MentionDropdownOptionProps`, `CommandArgumentsForm`/`CommandArgumentsFormProps`. Compile-time proofs: the strict type-check of a generated `chatInteractions` literal against `ChatInteractionsData` (Task 4), `bun run typecheck` after every task and `bun run typecheck:tests` over every new test and the browser fixture (Tasks 14, 17).
