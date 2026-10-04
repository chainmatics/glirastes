# Routing, Suche, Rückfragen, Chat-UI, Einbettung und STT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close FR-3 to FR-5 in the SDK: relevant DE/EN `find_tools` hits in every runtime mode, structured clarification that resumes the original request, generic `/` and `@` providers, versioned local result renderers, a framework-neutral `<glirastes-chat>` element and push-to-talk STT that never leaves a live microphone, all proven in jsdom and real Chrome.

**Architecture:** Discovery gets a deterministic Unicode/Snowball search index shared by the pinned-snapshot path and a new registry path for apps without a runtime source; clarification is an SDK built-in tool that ends the turn inside the normal model step and is resumed on the server from an invisible answer marker. The React layer gains provider search, a renderer registry, push-to-talk and route/session-aware cleanup on the existing single STT controller, and `glirastes/embed` wraps that React UI in a Shadow DOM custom element. Work happens in the isolated worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat` on branch `codex/mvp-chat`, branched from `codex/glirastes-foundation-runtime` once P01 has landed there; it runs in parallel to P02/P03 and never touches `src/codegen` or `src/contracts/tool-policy.ts`.

**Tech Stack:** TypeScript 5 (strict, NodeNext, `.js` import suffixes), Zod 4, `ai@6` with `MockLanguageModelV3`, React 19, Vitest 4 with jsdom and Testing Library, `snowball-stemmers`, Bun (`bun build --production`) for the browser harness, Playwright (installed module via `PLAYWRIGHT_MODULE`) with system Chrome and Chrome's fake media device, Node test runner.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (sections 1 Erfolgskriterium 4, 3 TP3, 4.6 skill `building-glirastes-chat-ui`, 6 TP3, 10, 11); acceptance from /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-09-13-mvp-scope-and-requirements.md (FR-3, FR-4, FR-5, §3 "Bestehendes Verhalten ändern", §6 Suche/Klärung/UI/STT).

## Global Constraints

- `find_tools` tokenizer is Unicode-aware (`\p{L}\p{N}`); stemming uses the existing `snowball-stemmers` dependency for DE and EN; synonyms come from usage hints and tool semantics.
- No embedding service and no separate search agent (scope v1.2 §3).
- `find_tools` is available in standalone mode too, and never returns unauthorized or not-deployed tools.
- Test corpus for search: German and English terms, synonyms, zero hits, missing permissions (FR-3).
- Clarification: structured tool with options and free text as SDK component; the original request stays in the session and continues with the answer.
- No additional planner model call in the normal case; no clarification when the intent is clear.
- `/` commands and `@` mentions: generic provider API with async search, keyboard control, stable IDs and permission context; a built-in command provider from the catalog's UI tools.
- Result renderer registry per tool: `definitionId`, schema version, safe fallback for old messages.
- Mobile layout covered by a browser test (viewport 375 × 812).
- Embedding: new subpath `glirastes/embed` with custom element `<glirastes-chat>` (Shadow DOM, CSS variables, events, clean unmount); internally the React UI.
- STT: push-to-talk (hold, key and button) in addition to toggle; interim text also in the recording bar; edit before sending; no auto-send on finalization; exactly one controller and one microphone stream.
- STT browser tests use Chrome's fake media device (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`): stop, cancel, retry, route change, session switch and unmount leave no live `MediaStreamTrack`.
- Live runs only with the deterministic test model; no OpenRouter key use without Philipp's approval (spec §6 Messung).
- Do not touch `src/codegen/**`, `src/contracts/tool-policy.ts` or Omnify; no pushes, merges, releases or deployments (spec §11).
- Package manager Bun; tests with Vitest; no new runtime dependencies.
- P07 starts after P01 (roadmap): the base branch carries P01's `bun run typecheck:tests` gate (`tsconfig.test.json` over `src` and `tests`, `glirastes/*` self-imports resolve through `dist/`, so build first). Every new or changed test file, including `tests/browser/chat-harness.tsx`, must pass it; the per-plan SDK gate is `bun run typecheck`, `bun run typecheck:tests`, `bun run test`, `bun run build` plus the browser tests.

## Review Focus

1. **German inflections, umlauts, ß and compounds in `find_tools` queries.** The current tokenizer (`[^a-z0-9]+`) drops every umlaut word and never matches "Lösche die Aufgabe" against "Aufgabe löschen". Pinned by Task 1 Step 1 (`searchTokens('Lösche … Straße')`, `Größe`) and Task 2 Step 1 (DE corpus incl. "Füge eine neue Aufgabe hinzu", "Aufgabenliste").
2. **Search leaking tools the user must not see.** Synonyms of admin-only, undeployed or revoked tools could rank them. Pinned by Task 2 Step 1 ("Protokoll"/"Rechnungen" return nothing for a member, revoked delete tool never returned, synonyms never in results).
3. **SDK built-ins (clarification, follow-ups) under the managed guard and a tiny context window.** The turn guard denies every non-manifest tool (`manifest_tool_unavailable`), hybrid discovery keeps only manifest-eligible names active, and `prepareModelMessages` slices to `maxContextMessages`, which would drop the original request. Pinned by Task 8 Step 1 (managed runtime, `doStreamCalls` length 1, `maxContextMessages: 1` still contains "Original request", and `suggest_followups` active and executed under managed discovery).
4. **Microphone left live after navigation, session switch, unmount or a failed provider, and the press-and-hold gesture in a real browser.** Pinned by Task 20 Step 1 (jsdom lifecycle incl. adapter identity) and Task 24 Step 1 (Chrome fake device: stop, cancel, retry, route, back, session, unmount, button hold, hotkey hold, one live track max).
5. **Old stored messages and broken custom renderers.** A renderer for schema v2 must not crash on a v1 message or take the chat down when it throws. Pinned by Task 15 Step 1 (old output falls back to the default block, throwing renderer degrades) and Task 14 Step 1 (older version selected, throwing schema ignored).

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `src/runtime/tool-search.ts` | Create | Unicode tokens, DE/EN stems, IDF-weighted field ranking (`createToolSearchIndex`). |
| `src/runtime/tool-discovery.ts` | Modify (full rewrite of ranking) | Snapshot discovery on the search index, `semantics` synonyms, `createRegistryToolDiscovery`. |
| `src/runtime/index.ts` | Modify | Export the search index and registry discovery. |
| `src/server/adapters/nextjs/tool-discovery.ts` | Modify | `NON_DOMAIN_TOOL_NAMES`, `builtinToolNames` in the hybrid controller. |
| `src/server/adapters/nextjs/create-ai-chat-handler.ts` | Modify | Registry discovery without runtime source, `toolSemantics`, clarification registry/scope/stop/resume, guard bypass and discovery activity for all SDK built-ins (incl. `suggest_followups`). |
| `src/server/adapters/nextjs/types.ts` | Modify | `toolSemantics`, `clarification` config. |
| `src/server/adapters/nextjs/index.ts` | Modify | Export new names. |
| `src/contracts/clarification.ts` | Create | Dependency-free clarification wire protocol (tool name, marker format, parse/strip). |
| `src/server/core/clarification-tool.ts` | Create | Built-in `ask_clarification` tool and `ClarificationConfig`. |
| `src/server/core/index.ts` | Modify | Export the clarification tool. |
| `src/server/adapters/nextjs/clarification-resume.ts` | Create | Resolve answer → original request; model-only rewrite. |
| `src/react/utils/clarification.ts` | Create | Read clarification parts, find the open question. |
| `src/react/components/clarification-card.tsx` | Create | Options + free-text answer card. |
| `src/react/components/message-bubble.tsx` | Modify | Render clarification cards, strip markers, custom renderers with fallback. |
| `src/react/completions/completion-search.ts` | Create | Merge `/`/`@` providers: abort, timeout, stable keys, permission context. |
| `src/react/completions/ui-tool-command-provider.ts` | Create | Built-in `/` provider over catalog UI tools. |
| `src/react/components/rich-mention-input.tsx` | Modify | Stable list keys, `slug`, structured mentions on submit. |
| `src/react/components/mention-input.tsx` | Modify | Provider mode next to unchanged legacy mode. |
| `src/react/components/ai-chat-panel.tsx` | Modify | Use the mention composer when providers exist. |
| `src/react/tool-renderers/registry.ts` | Create | Versioned renderer registry per `definitionId`. |
| `src/react/tool-renderers/renderer-boundary.tsx` | Create | Error boundary that falls back to the default block. |
| `src/react/hooks/use-push-to-talk-hotkey.ts` | Create | Hold-to-talk hotkey hook. |
| `src/react/components/voice-input-addon.tsx` | Modify (rewrite) | Adapter choice, push-to-talk, retry, route/session/history stop, stream to the bar. |
| `src/react/components/recording-bar.tsx` | Modify | Interim transcript next to the waveform. |
| `src/react/components/chat-input.tsx` | Modify | Pass adapter, push-to-talk and route key. |
| `src/react/provider/ai-chat-provider.tsx` | Modify | Locale keys, answer wrapping, providers, renderers, `themeScope`. |
| `src/react/provider/chat-context.ts` | Modify | `send` options, completion search, renderer registry. |
| `src/react/types.ts` | Modify | All new public types and config fields. |
| `src/react/index.ts` | Modify | Public exports. |
| `src/react/styles.css` | Modify | Styles for provider composer, list, clarification, voice controls. |
| `scripts/generate-embed-styles.mjs` | Create | Inline `styles.css` into the shadow-root module; `--check` for builds. |
| `src/embed/chat-styles.generated.ts` | Create (generated) | `CHAT_STYLES` string. |
| `src/embed/theme.ts` | Create | `--glirastes-chat-*` → `--cm-*` mapping. |
| `src/embed/glirastes-chat-element.tsx` | Create | `<glirastes-chat>` custom element. |
| `src/embed/index.ts` | Create | `glirastes/embed` public surface. |
| `package.json`, `scripts/generate-subpath-shims.mjs`, `.gitignore` | Modify | `./embed` export, shim, build check. |
| `src/public-subpaths.test.ts` | Modify | Guard the embed subpath. |
| `tests/browser/harness-server.mjs` | Create | Bun bundle + loopback server for the harness. |
| `tests/browser/chat-harness.tsx` | Create | STT, mobile and embed views with fake transport/provider. |
| `tests/chat-browser.test.mjs` | Create | Real Chrome tests with fake media device. |
| `skills/building-glirastes-chat-ui/SKILL.md` | Modify | Document providers, clarification, renderers, embed, push-to-talk. |
| `src/cli/commands/install-skills.test.ts` | Modify | Guard the skill content. |

Tests created: `src/runtime/__tests__/tool-search.test.ts`, `src/runtime/__tests__/tool-discovery-relevance.test.ts`, `src/server/adapters/nextjs/__tests__/registry-discovery.test.ts`, `src/contracts/__tests__/clarification.test.ts`, `src/server/core/__tests__/clarification-tool.test.ts`, `src/server/adapters/nextjs/__tests__/clarification-resume.test.ts`, `src/server/adapters/nextjs/__tests__/clarification-flow.test.ts`, `src/react/components/__tests__/clarification-card.test.tsx`, `src/react/provider/__tests__/clarification-answer.test.tsx`, `src/react/completions/__tests__/completion-search.test.ts`, `src/react/completions/__tests__/ui-tool-command-provider.test.ts`, `src/react/components/__tests__/completion-composer.test.tsx`, `src/react/tool-renderers/__tests__/registry.test.ts`, `src/react/components/__tests__/tool-renderers.test.tsx`, `src/react/__tests__/composer-styles.test.ts`, `src/react/provider/__tests__/theme-scope.test.tsx`, `src/react/hooks/__tests__/use-push-to-talk-hotkey.test.tsx`, `src/react/components/__tests__/voice-push-to-talk.test.tsx`, `src/react/components/__tests__/voice-draft.test.tsx`, `src/embed/__tests__/chat-styles.test.ts`, `src/embed/__tests__/embed-module.test.ts`, `src/embed/__tests__/glirastes-chat-element.test.tsx`.

All commands below run from `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat` unless stated otherwise. Agent shells reset the working directory and drop exported variables between calls, so prefix every command with `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat && ` and keep `PLAYWRIGHT_MODULE` inside the same command (as the browser steps do).

---

### Task 0: Isolated worktree and green baseline

**Files:** none changed.

**Interfaces:** Consumes branch `codex/glirastes-foundation-runtime`. Produces worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat` on branch `codex/mvp-chat`.

- [ ] **Step 1: Create the worktree**

```bash
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1 \
  worktree add -b codex/mvp-chat \
  /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat \
  codex/glirastes-foundation-runtime
```

Expected: `Preparing worktree (new branch 'codex/mvp-chat')`.

- [ ] **Step 2: Install and run the baseline**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-chat
grep -q '"typecheck:tests"' package.json && echo "P01 present"
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run typecheck:tests
bunx vitest run src/runtime src/server/adapters/nextjs src/react src/public-subpaths.test.ts src/cli/commands/install-skills.test.ts
```

Expected: `P01 present` (otherwise P01 has not landed on `codex/glirastes-foundation-runtime`: stop and report, P07 depends on it); build ends with `Generated 16 subpath shims.`; both typechecks exit 0; all listed test files pass. If `bun install --frozen-lockfile` reports a lockfile change, stop and report instead of updating `bun.lock`.

- [ ] **Step 3: Locate the installed Playwright module (no download)**

```bash
ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1
ls -d "/Applications/Google Chrome.app"
```

Expected: one absolute path (use it as `PLAYWRIGHT_MODULE` in Tasks 24, 25 and 27) and the Chrome app. If either is missing, stop and ask; never run `npx playwright install`.

No commit in this task.

---

### Task 1: Unicode DE/EN tool search index

**Files:**
- Create: `src/runtime/tool-search.ts`
- Test: `src/runtime/__tests__/tool-search.test.ts`

**Interfaces:**
- Consumes: `newStemmer(locale: string): Stemmer` from `snowball-stemmers` (already a dependency, used by `src/server/core/intent-classifier.ts:9`).
- Produces:
  - `export interface ToolSearchDocument { readonly name: string; readonly description: string; readonly module?: string; readonly sharedWith?: ReadonlyArray<string>; readonly usageHints?: ReadonlyArray<string>; readonly synonyms?: ReadonlyArray<string> }`
  - `export interface ToolSearchIndex { search(query: string, limit: number): ReadonlyArray<string> }`
  - `export function searchTokens(text: string): string[]`
  - `export function searchTermVariants(text: string): ReadonlyArray<ReadonlyArray<string>>`
  - `export function createToolSearchIndex(documents: ReadonlyArray<ToolSearchDocument>): ToolSearchIndex`

- [ ] **Step 1: Write the failing test**

Create `src/runtime/__tests__/tool-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createToolSearchIndex,
  searchTermVariants,
  searchTokens,
} from '../tool-search.js';

describe('searchTokens', () => {
  it('keeps Unicode letters and digits, splits names and folds diacritics', () => {
    expect(searchTokens('Lösche tasks.listTasks für Straße 2026'))
      .toEqual(['losche', 'tasks', 'list', 'tasks', 'strasse', '2026']);
    expect(searchTokens('Größe')).toEqual(['grosse']);
    expect(searchTokens('Задачи 東京')).toEqual(['задачи', '東京']);
  });

  it('drops German and English function words', () => {
    expect(searchTokens('Zeige mir bitte die Aufgaben von Alice'))
      .toEqual(['zeige', 'aufgaben', 'alice']);
    expect(searchTokens('show me all of the tasks')).toEqual(['tasks']);
  });
});

describe('searchTermVariants', () => {
  it('adds German and English Snowball stems to every token', () => {
    expect(searchTermVariants('Aufgaben löschen')).toEqual([
      ['aufgaben', 'aufgab'],
      ['loschen', 'losch'],
    ]);
    expect(searchTermVariants('deleted tasks')).toEqual([
      ['deleted', 'delet'],
      ['tasks', 'task'],
    ]);
  });
});

describe('createToolSearchIndex', () => {
  const index = createToolSearchIndex([
    {
      name: 'tasks_listTasks',
      description: 'Show visible tasks with status and due date filters.',
      synonyms: ['Aufgaben anzeigen', 'Aufgabenliste'],
    },
    {
      name: 'tasks_deleteTask',
      description: 'Delete a task permanently.',
      synonyms: ['Aufgabe löschen'],
    },
    {
      name: 'reports_weeklySummary',
      description: 'Summarize completed work for the current week.',
      synonyms: ['Wochenbericht'],
    },
  ]);

  it('matches German stems and synonyms across inflections', () => {
    expect(index.search('Lösche die Aufgabe', 8)[0]).toBe('tasks_deleteTask');
    expect(index.search('Wochenbericht', 8)).toEqual(['reports_weeklySummary']);
  });

  it('prefers rare terms over terms every tool shares', () => {
    expect(index.search('Aufgabe löschen', 8)).toEqual([
      'tasks_deleteTask',
      'tasks_listTasks',
    ]);
  });

  it('ranks an exact model name first and respects the limit', () => {
    expect(index.search('tasks.listTasks', 1)).toEqual(['tasks_listTasks']);
  });

  it('returns no hits for unrelated or function-word-only queries', () => {
    expect(index.search('Wetter in Berlin', 8)).toEqual([]);
    expect(index.search('the of und die', 8)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/runtime/__tests__/tool-search.test.ts`
Expected: FAIL with `Failed to load url ../tool-search.js` (module does not exist).

- [ ] **Step 3: Implement the index**

Create `src/runtime/tool-search.ts`:

```ts
import { newStemmer, type Stemmer } from 'snowball-stemmers';

/**
 * Searchable, content-bounded tool facts. Discovery builds these from the
 * pinned manifest or the deployed registry; nothing here grants access.
 */
export interface ToolSearchDocument {
  readonly name: string;
  readonly description: string;
  readonly module?: string;
  readonly sharedWith?: ReadonlyArray<string>;
  readonly usageHints?: ReadonlyArray<string>;
  readonly synonyms?: ReadonlyArray<string>;
}

export interface ToolSearchIndex {
  /** Document names ordered by relevance; empty when no query term matches. */
  search(query: string, limit: number): ReadonlyArray<string>;
}

const STEMMERS: ReadonlyArray<Stemmer> = [
  newStemmer('german'),
  newStemmer('english'),
];

/** Folded (lower-case, no diacritics, ß → ss) German and English function words. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can',
  'could', 'do', 'does', 'for', 'from', 'get', 'give', 'how', 'in', 'into',
  'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'show', 'some',
  'that', 'the', 'these', 'this', 'those', 'to', 'we', 'what', 'which',
  'who', 'with', 'would', 'you', 'your',
  'alle', 'allen', 'als', 'am', 'auch', 'auf', 'aus', 'bei', 'bitte', 'das',
  'dass', 'dem', 'den', 'der', 'des', 'die', 'dies', 'diese', 'diesem',
  'diesen', 'dieser', 'dieses', 'du', 'ein', 'eine', 'einem', 'einen',
  'einer', 'eines', 'es', 'fur', 'gib', 'habe', 'haben', 'hat', 'ich',
  'ihr', 'im', 'ist', 'kann', 'kannst', 'mal', 'man', 'mein', 'meine',
  'meinem', 'meinen', 'meiner', 'meines', 'mich', 'mir', 'mit', 'nach',
  'noch', 'oder', 'sind', 'uber', 'und', 'uns', 'unser', 'unsere', 'vom',
  'von', 'was', 'welche', 'welcher', 'welches', 'wer', 'wie', 'wir', 'wo',
  'zu', 'zum', 'zur',
]);

const MIN_TOKEN_LENGTH = 2;
const MIN_PREFIX_LENGTH = 5;
const FIELD_WEIGHTS = {
  name: 8,
  synonyms: 6,
  description: 4,
  module: 3,
  hints: 2,
} as const;
type SearchField = keyof typeof FIELD_WEIGHTS;
const SEARCH_FIELDS = Object.keys(FIELD_WEIGHTS) as SearchField[];

/**
 * Unicode-aware tokens: camelCase and snake/dot names split, letters and
 * digits of every script kept, German/English diacritics folded, function
 * words dropped.
 */
export function searchTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) =>
      token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token));
}

function termVariants(token: string): ReadonlyArray<string> {
  const variants = new Set<string>([token]);
  for (const stemmer of STEMMERS) {
    const stem = stemmer.stem(token);
    if (stem.length >= MIN_TOKEN_LENGTH) variants.add(stem);
  }
  return [...variants];
}

/** Each query token with its German and English Snowball stems. */
export function searchTermVariants(
  text: string,
): ReadonlyArray<ReadonlyArray<string>> {
  return searchTokens(text).map(termVariants);
}

function fieldVariants(text: string): ReadonlySet<string> {
  const variants = new Set<string>();
  for (const term of searchTermVariants(text)) {
    for (const variant of term) variants.add(variant);
  }
  return variants;
}

/** 1 for an exact token/stem hit, 0.5 for a compound prefix, else 0. */
function matchStrength(
  term: ReadonlyArray<string>,
  field: ReadonlySet<string>,
): number {
  for (const variant of term) if (field.has(variant)) return 1;
  for (const variant of term) {
    if (variant.length < MIN_PREFIX_LENGTH) continue;
    for (const candidate of field) {
      if (candidate.length < MIN_PREFIX_LENGTH) continue;
      if (candidate.startsWith(variant) || variant.startsWith(candidate)) {
        return 0.5;
      }
    }
  }
  return 0;
}

interface IndexedDocument {
  readonly name: string;
  readonly normalizedName: string;
  readonly fields: Readonly<Record<SearchField, ReadonlySet<string>>>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
  return {
    name: document.name,
    normalizedName: searchTokens(document.name).join(' '),
    fields: {
      name: fieldVariants(document.name),
      synonyms: fieldVariants((document.synonyms ?? []).join(' ')),
      description: fieldVariants(document.description),
      module: fieldVariants(
        [document.module, ...(document.sharedWith ?? [])]
          .filter((value): value is string => Boolean(value))
          .join(' '),
      ),
      hints: fieldVariants((document.usageHints ?? []).join(' ')),
    },
  };
}

/**
 * Builds a deterministic relevance index. Ranking: exact name, then the sum
 * over query terms of the best field hit (name > synonyms > description >
 * module > hints) weighted by inverse document frequency, then name.
 * No embeddings, network or model call.
 */
export function createToolSearchIndex(
  documents: ReadonlyArray<ToolSearchDocument>,
): ToolSearchIndex {
  const indexed = documents.map(indexDocument);

  const documentFrequency = (term: ReadonlyArray<string>) =>
    indexed.filter((document) =>
      SEARCH_FIELDS.some((field) =>
        matchStrength(term, document.fields[field]) > 0)).length;

  return Object.freeze({
    search(query: string, limit: number) {
      const terms = searchTermVariants(query);
      if (terms.length === 0 || indexed.length === 0) return Object.freeze([]);
      const inverseFrequency = terms.map((term) =>
        Math.log(1 + indexed.length / Math.max(1, documentFrequency(term))));
      const normalizedQuery = searchTokens(query).join(' ');

      const ranked = indexed
        .map((document) => {
          let score = 0;
          terms.forEach((term, index) => {
            let best = 0;
            for (const field of SEARCH_FIELDS) {
              best = Math.max(
                best,
                matchStrength(term, document.fields[field]) * FIELD_WEIGHTS[field],
              );
            }
            score += best * inverseFrequency[index]!;
          });
          return {
            name: document.name,
            exact: normalizedQuery === document.normalizedName ? 1 : 0,
            score,
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) =>
          right.exact - left.exact
          || right.score - left.score
          || left.name.localeCompare(right.name))
        .slice(0, Math.max(0, Math.trunc(limit)))
        .map((candidate) => candidate.name);
      return Object.freeze(ranked);
    },
  });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/runtime/__tests__/tool-search.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/tool-search.ts src/runtime/__tests__/tool-search.test.ts
git commit -m "feat(runtime): add unicode de/en tool search index"
```

---

### Task 2: Discovery on the search index, synonyms and registry discovery

**Files:**
- Modify: `src/runtime/tool-discovery.ts` (replace the whole file; old `words()` at lines 46-52 and `rank()` at 64-79 go away)
- Modify: `src/runtime/index.ts` (export block at lines 57-62)
- Test: `src/runtime/__tests__/tool-discovery-relevance.test.ts`; existing `src/runtime/__tests__/tool-discovery.test.ts` must stay green unchanged.

**Interfaces:**
- Consumes: `createToolSearchIndex` (Task 1), `authorizeToolCall`, `modelFacingToolName`, `TurnSnapshot`, `ToolRegistry`.
- Produces:
  - `export interface ToolSearchSemantics { readonly synonyms?: ReadonlyArray<string> }`
  - `export type ToolSearchSemanticsMap = Readonly<Record<string, ToolSearchSemantics>>` (keyed by model-facing tool name; this is the optional `synonyms?: string[]` input that P05's tool semantics will feed)
  - `createTurnToolDiscovery(input: { snapshot: TurnSnapshot; registry: ToolRegistry; revokedToolIds?: ReadonlyArray<string>; semantics?: ToolSearchSemanticsMap }, options?: TurnToolDiscoveryOptions): TurnToolDiscovery`
  - `export function createRegistryToolDiscovery(input: { turnId: string; registry: ToolRegistry; excludeNames?: ReadonlyArray<string>; semantics?: ToolSearchSemanticsMap }, options?: TurnToolDiscoveryOptions): TurnToolDiscovery`

- [ ] **Step 1: Write the failing relevance corpus**

Create `src/runtime/__tests__/tool-discovery-relevance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ToolRegistry } from '../../types.js';
import type { TurnSnapshot } from '../turn-snapshot.js';
import {
  createRegistryToolDiscovery,
  createTurnToolDiscovery,
  type ToolSearchSemanticsMap,
} from '../tool-discovery.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const toolId = (suffix: number) =>
  `22222222-2222-4222-8222-${String(suffix).padStart(12, '0')}`;

interface CorpusTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly module: string;
  readonly hints: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<string>;
  readonly deployed?: boolean;
}

const CORPUS: ReadonlyArray<CorpusTool> = [
  {
    id: toolId(1), name: 'tasks.listTasks', module: 'task_query',
    description: 'Show visible tasks with status and due date filters.',
    hints: ['Use when the user asks for an overview of open or completed work.'],
    roles: ['member'],
  },
  {
    id: toolId(2), name: 'tasks.createTask', module: 'task_mutation',
    description: 'Create a new task with title, due date and assignee.',
    hints: ['Use when the user wants to add work.'], roles: ['member'],
  },
  {
    id: toolId(3), name: 'tasks.deleteTask', module: 'task_mutation',
    description: 'Delete a task permanently.',
    hints: ['Destructive; always confirm.'], roles: ['member'],
  },
  {
    id: toolId(4), name: 'teams.listMembers', module: 'teams',
    description: 'List the members of a team.',
    hints: ['Use for questions about colleagues.'], roles: ['member'],
  },
  {
    id: toolId(5), name: 'reports.weeklySummary', module: 'reporting',
    description: 'Summarize completed work for the current week.',
    hints: ['Use for weekly reviews.'], roles: ['member'],
  },
  {
    id: toolId(6), name: 'admin.auditLog', module: 'administration',
    description: 'List audit log entries.',
    hints: ['Use for compliance questions.'], roles: ['admin'],
  },
  {
    id: toolId(7), name: 'billing.listInvoices', module: 'billing',
    description: 'List invoices and payment status.',
    hints: ['Use for invoices.'], roles: ['member'], deployed: false,
  },
];

const SEMANTICS: ToolSearchSemanticsMap = {
  tasks_listTasks: {
    synonyms: ['Aufgaben anzeigen', 'Aufgaben zeigen', 'Aufgabenliste', 'offene Aufgaben', 'To-dos'],
  },
  tasks_createTask: {
    synonyms: ['Aufgabe anlegen', 'Aufgabe erstellen', 'neue Aufgabe', 'hinzufügen', 'add task'],
  },
  tasks_deleteTask: {
    synonyms: ['Aufgabe löschen', 'entfernen', 'remove task'],
  },
  teams_listMembers: {
    synonyms: ['Teammitglieder', 'Kollegen', 'Mitglieder'],
  },
  reports_weeklySummary: {
    synonyms: ['Wochenbericht', 'Zusammenfassung der Woche', 'weekly report'],
  },
  admin_auditLog: { synonyms: ['Protokoll', 'Prüfprotokoll'] },
  billing_listInvoices: { synonyms: ['Rechnungen', 'Rechnung bezahlen'] },
};

function corpus(roles: ReadonlyArray<string>): {
  snapshot: TurnSnapshot;
  registry: ToolRegistry;
} {
  const snapshot = {
    turnId: 'turn-relevance',
    startedAt: '2026-10-04T08:00:00.000Z',
    principal: { subjectId: 'u1', tenantId: TENANT, roles: [...roles], attributes: {} },
    agentRevision: { tenantId: TENANT, toolAllowlist: CORPUS.map((tool) => tool.id) },
    manifestRevision: {
      tenantId: TENANT,
      tools: CORPUS.map((tool) => ({
        toolId: tool.id,
        sourceFingerprint: 'sha256:tool',
        executionKind: 'endpoint' as const,
        name: tool.name,
        description: tool.description,
        modelName: tool.name.replaceAll('.', '_'),
        module: tool.module,
        sharedWith: [],
        usageHints: [...tool.hints],
        riskClass: 'safe-read' as const,
        enabled: true,
        tombstone: false,
        method: 'GET' as const,
        path: `/api/${tool.name}`,
        authBindingRef: 'session',
        inputSchemaDigest: 'sha256:input',
        outputSchemaDigest: 'sha256:output',
      })),
    },
    policyRevision: {
      tenantId: TENANT,
      toolPolicies: CORPUS.map((tool) => ({
        toolId: tool.id,
        enabled: true,
        riskClass: 'safe-read',
        requiresApproval: false,
        allowedRoles: [...tool.roles],
      })),
    },
    budget: {},
  } as unknown as TurnSnapshot;
  const registry: ToolRegistry = Object.fromEntries(CORPUS
    .filter((tool) => tool.deployed !== false)
    .map((tool) => [tool.name.replaceAll('.', '_'), {
      id: tool.id,
      description: tool.description,
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    }]));
  return { snapshot, registry };
}

const member = () => createTurnToolDiscovery({ ...corpus(['member']), semantics: SEMANTICS });
const top = (query: string) => member().search(query)[0]?.name;

describe('find_tools DE/EN relevance corpus', () => {
  it.each([
    ['show my open tasks', 'tasks_listTasks'],
    ['create a task', 'tasks_createTask'],
    ['remove task', 'tasks_deleteTask'],
    ['weekly report', 'reports_weeklySummary'],
    ['Zeige meine Aufgaben', 'tasks_listTasks'],
    ['Neue Aufgabe anlegen', 'tasks_createTask'],
    ['Füge eine neue Aufgabe hinzu', 'tasks_createTask'],
    ['Lösche die Aufgabe', 'tasks_deleteTask'],
    ['Wer ist in meinem Team?', 'teams_listMembers'],
    ['erledigte Aufgaben dieser Woche zusammenfassen', 'reports_weeklySummary'],
  ])('ranks %j first as %s', (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it.each([
    ['Kollegen', 'teams_listMembers'],
    ['Wochenbericht', 'reports_weeklySummary'],
    ['To-dos', 'tasks_listTasks'],
    ['Aufgabenliste', 'tasks_listTasks'],
  ])('resolves the synonym %j to %s', (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it.each([
    'Wetter in Berlin',
    'Rechnung bezahlen',
    'Rechnungen',
    'audit',
    'Protokoll',
  ])('returns no tool for %j (unrelated, undeployed or unauthorized)', (query) => {
    expect(member().search(query)).toEqual([]);
  });

  it('never lists unauthorized or undeployed tools as eligible', () => {
    expect(member().eligibleNames).toEqual([
      'reports_weeklySummary',
      'tasks_createTask',
      'tasks_deleteTask',
      'tasks_listTasks',
      'teams_listMembers',
    ]);
  });

  it('finds the admin tool only for a principal holding the role', () => {
    const admin = createTurnToolDiscovery({
      ...corpus(['member', 'admin']), semantics: SEMANTICS,
    });
    expect(admin.search('Protokoll')[0]?.name).toBe('admin_auditLog');
  });

  it('does not let synonyms of revoked tools leak into results', () => {
    const discovery = createTurnToolDiscovery({
      ...corpus(['member']),
      semantics: SEMANTICS,
      revokedToolIds: [toolId(3)],
    });
    expect(discovery.search('Aufgabe löschen').map((result) => result.name))
      .not.toContain('tasks_deleteTask');
  });

  it('never returns synonyms in the model-facing result', () => {
    expect(JSON.stringify(member().search('Kollegen'))).not.toContain('Teammitglieder');
  });
});

describe('createRegistryToolDiscovery', () => {
  const registry: ToolRegistry = {
    list_tasks: {
      id: 'tasks.list', description: 'List visible tasks.',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    },
    create_task: {
      id: 'tasks.create', description: 'Create a task.',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    },
    suggest_followups: {
      id: 'suggest_followups', description: 'Suggest follow-up tasks.',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    },
  };

  it('indexes the deployed registry with synonyms and skips built-ins', () => {
    const discovery = createRegistryToolDiscovery({
      turnId: 'turn-registry',
      registry,
      excludeNames: ['suggest_followups'],
      semantics: { create_task: { synonyms: ['Aufgabe anlegen'] } },
    });
    expect(discovery.eligibleNames).toEqual(['create_task', 'list_tasks']);
    expect(discovery.search('Aufgabe anlegen').map((result) => result.name))
      .toEqual(['create_task']);
    expect(discovery.search('follow-up')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/runtime/__tests__/tool-discovery-relevance.test.ts`
Expected: FAIL. German queries such as `'Zeige meine Aufgaben'` return `undefined` and `createRegistryToolDiscovery is not a function`.

- [ ] **Step 3: Replace the discovery implementation**

Replace the entire content of `src/runtime/tool-discovery.ts` with:

```ts
import type { ToolPresentation } from '../contracts/index.js';
import type { ToolRegistry } from '../types.js';
import { authorizeToolCall } from './authorization.js';
import { modelFacingToolName } from './local-tool-bindings.js';
import { createToolSearchIndex } from './tool-search.js';
import type { TurnSnapshot } from './turn-snapshot.js';

export interface ToolDiscoveryResult {
  readonly name: string;
  readonly description: string;
  readonly module?: string;
  readonly usageHints?: ReadonlyArray<string>;
  readonly presentation?: Readonly<ToolPresentation>;
}

export interface TurnToolDiscovery {
  readonly turnId: string;
  readonly eligibleNames: ReadonlyArray<string>;
  search(query: string, limit?: number): ReadonlyArray<ToolDiscoveryResult>;
}

export interface TurnToolDiscoveryOptions {
  maxQueryLength?: number;
  maxResults?: number;
  maxDescriptionLength?: number;
  maxHintLength?: number;
}

/**
 * Search-only enrichment keyed by the model-facing tool name. Synonyms are
 * indexed but never returned and never make a tool eligible.
 */
export interface ToolSearchSemantics {
  readonly synonyms?: ReadonlyArray<string>;
}

export type ToolSearchSemanticsMap = Readonly<Record<string, ToolSearchSemantics>>;

interface DiscoveryEntry {
  result: ToolDiscoveryResult;
  synonyms: ReadonlyArray<string>;
  sharedWith: ReadonlyArray<string>;
}

const DEFAULT_MAX_QUERY_LENGTH = 200;
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 20;
const DEFAULT_MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_MAX_HINT_LENGTH = 300;
const MAX_SYNONYMS = 20;
const MAX_SYNONYM_LENGTH = 100;

function bounded(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function freezeResult(result: ToolDiscoveryResult): ToolDiscoveryResult {
  if (result.usageHints) Object.freeze(result.usageHints);
  if (result.presentation) Object.freeze(result.presentation);
  return Object.freeze(result);
}

function boundedSynonyms(
  semantics: ToolSearchSemanticsMap | undefined,
  name: string,
): ReadonlyArray<string> {
  const entry = semantics && Object.hasOwn(semantics, name)
    ? semantics[name]
    : undefined;
  return (entry?.synonyms ?? [])
    .filter((synonym): synonym is string => typeof synonym === 'string')
    .slice(0, MAX_SYNONYMS)
    .map((synonym) => bounded(synonym, MAX_SYNONYM_LENGTH));
}

function resolveLimits(options: TurnToolDiscoveryOptions) {
  return {
    maxQueryLength: Math.min(
      Math.max(options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH, 1),
      DEFAULT_MAX_QUERY_LENGTH,
    ),
    maxResults: Math.min(
      Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1),
      HARD_MAX_RESULTS,
    ),
    maxDescriptionLength: Math.min(
      Math.max(options.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH, 1),
      DEFAULT_MAX_DESCRIPTION_LENGTH,
    ),
    maxHintLength: Math.min(
      Math.max(options.maxHintLength ?? DEFAULT_MAX_HINT_LENGTH, 1),
      DEFAULT_MAX_HINT_LENGTH,
    ),
  };
}

function createDiscovery(
  turnId: string,
  unsortedEntries: DiscoveryEntry[],
  limits: ReturnType<typeof resolveLimits>,
): TurnToolDiscovery {
  const entries = [...unsortedEntries].sort((left, right) =>
    left.result.name.localeCompare(right.result.name));
  Object.freeze(entries);
  const byName = new Map(entries.map((entry) => [entry.result.name, entry.result] as const));
  const eligibleNames = Object.freeze(entries.map((entry) => entry.result.name));
  const index = createToolSearchIndex(entries.map((entry) => ({
    name: entry.result.name,
    description: entry.result.description,
    ...(entry.result.module ? { module: entry.result.module } : {}),
    sharedWith: entry.sharedWith,
    ...(entry.result.usageHints ? { usageHints: entry.result.usageHints } : {}),
    synonyms: entry.synonyms,
  })));

  return Object.freeze({
    turnId,
    eligibleNames,
    search(query: string, limit = limits.maxResults) {
      if (query.length > limits.maxQueryLength) {
        throw new Error('Tool discovery query exceeds the configured limit.');
      }
      const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), limits.maxResults);
      return Object.freeze(index.search(query, boundedLimit)
        .map((name) => byName.get(name))
        .filter((result): result is ToolDiscoveryResult => result !== undefined));
    },
  });
}

/**
 * Builds a content-bounded search index from the immutable turn snapshot and
 * the already materialized local registry. Discovery neither grants access
 * nor holds an executor or schema reference.
 */
export function createTurnToolDiscovery(
  input: {
    snapshot: TurnSnapshot;
    registry: ToolRegistry;
    revokedToolIds?: ReadonlyArray<string>;
    semantics?: ToolSearchSemanticsMap;
  },
  options: TurnToolDiscoveryOptions = {},
): TurnToolDiscovery {
  const limits = resolveLimits(options);
  const { maxDescriptionLength, maxHintLength } = limits;
  const revoked = new Set(input.revokedToolIds ?? []);
  const policies = new Map(input.snapshot.policyRevision.toolPolicies.map(
    (policy) => [policy.toolId, policy] as const,
  ));
  const entries: DiscoveryEntry[] = [];

  for (const manifestTool of input.snapshot.manifestRevision.tools) {
    const name = modelFacingToolName(manifestTool.name);
    const binding = input.registry[name];
    const policy = policies.get(manifestTool.toolId);
    const authorization = authorizeToolCall({
      principal: input.snapshot.principal,
      agentRevision: input.snapshot.agentRevision,
      manifestRevision: input.snapshot.manifestRevision,
      policyRevision: input.snapshot.policyRevision,
      toolId: manifestTool.toolId,
    });
    if (
      revoked.has(manifestTool.toolId)
      || !binding
      || binding.id !== manifestTool.toolId
      || !policy
      || policy.riskClass !== manifestTool.riskClass
      || !authorization.allowed
    ) {
      continue;
    }
    const description = bounded(manifestTool.description, maxDescriptionLength);
    const usageHints = manifestTool.usageHints?.map((hint) =>
      bounded(hint, maxHintLength));
    const result = freezeResult({
      name,
      description,
      ...(manifestTool.module ? { module: manifestTool.module } : {}),
      ...(usageHints ? { usageHints } : {}),
      ...(manifestTool.presentation
        ? { presentation: { ...manifestTool.presentation } }
        : {}),
    });
    entries.push({
      result,
      synonyms: boundedSynonyms(input.semantics, name),
      sharedWith: manifestTool.sharedWith ?? [],
    });
  }
  return createDiscovery(input.snapshot.turnId, entries, limits);
}

/**
 * Discovery for apps without a managed or standalone runtime source. The
 * per-request registry is the deployed, app-authorized tool set; names in
 * `excludeNames` (SDK built-ins) are never indexed.
 */
export function createRegistryToolDiscovery(
  input: {
    turnId: string;
    registry: ToolRegistry;
    excludeNames?: ReadonlyArray<string>;
    semantics?: ToolSearchSemanticsMap;
  },
  options: TurnToolDiscoveryOptions = {},
): TurnToolDiscovery {
  const limits = resolveLimits(options);
  const excluded = new Set(input.excludeNames ?? []);
  const entries: DiscoveryEntry[] = [];
  for (const [name, tool] of Object.entries(input.registry)) {
    if (excluded.has(name) || typeof tool?.description !== 'string') continue;
    entries.push({
      result: freezeResult({
        name,
        description: bounded(tool.description, limits.maxDescriptionLength),
      }),
      synonyms: boundedSynonyms(input.semantics, name),
      sharedWith: [],
    });
  }
  return createDiscovery(input.turnId, entries, limits);
}
```

- [ ] **Step 4: Export from the runtime surface**

In `src/runtime/index.ts` replace:

```ts
export {
  createTurnToolDiscovery,
  type ToolDiscoveryResult,
  type TurnToolDiscovery,
  type TurnToolDiscoveryOptions,
} from './tool-discovery.js';
```

with:

```ts
export {
  createRegistryToolDiscovery,
  createTurnToolDiscovery,
  type ToolDiscoveryResult,
  type ToolSearchSemantics,
  type ToolSearchSemanticsMap,
  type TurnToolDiscovery,
  type TurnToolDiscoveryOptions,
} from './tool-discovery.js';
export {
  createToolSearchIndex,
  searchTermVariants,
  searchTokens,
  type ToolSearchDocument,
  type ToolSearchIndex,
} from './tool-search.js';
```

- [ ] **Step 5: Run the corpus and the existing discovery tests**

Run: `bunx vitest run src/runtime/__tests__/tool-discovery-relevance.test.ts src/runtime/__tests__/tool-discovery.test.ts src/runtime/__tests__/standalone-network-silence.test.ts`
Expected: PASS (existing ranking expectations such as `'list'` → `['tasks_listTasks', 'reports_taskSummary']` still hold).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/tool-discovery.ts src/runtime/index.ts src/runtime/__tests__/tool-discovery-relevance.test.ts
git commit -m "feat(runtime): rank find_tools with stems, synonyms and registry mode"
```

---

### Task 3: `find_tools` without a runtime source and `toolSemantics`

**Files:**
- Modify: `src/server/adapters/nextjs/tool-discovery.ts` (after `FindToolsInputSchema`, line 9)
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.ts` (imports lines 28-38, destructure line 560-561, `buildDiscovery` lines 684-711)
- Modify: `src/server/adapters/nextjs/types.ts` (import lines 23-26, `toolDiscovery` doc lines 180-184)
- Modify: `src/server/adapters/nextjs/index.ts` (tool-discovery export)
- Test: `src/server/adapters/nextjs/__tests__/registry-discovery.test.ts`

**Interfaces:**
- Consumes: `createRegistryToolDiscovery`, `ToolSearchSemanticsMap` (Task 2).
- Produces: `export const NON_DOMAIN_TOOL_NAMES: readonly ['find_tools', 'suggest_followups', 'ask_clarification']`; `AiChatHandlerConfig.toolSemantics?: ToolSearchSemanticsMap`; `toolDiscovery: true` now works without `managedRuntime`.

- [ ] **Step 1: Write the failing test**

Create `src/server/adapters/nextjs/__tests__/registry-discovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { StreamHandlerContext } from '../create-ai-chat-handler.js';

const registry = {
  list_tasks: defineTool({
    id: 'tasks.list', description: 'List visible tasks.',
    inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
  create_task: defineTool({
    id: 'tasks.create', description: 'Create a task.',
    inputSchema: z.object({}), execute: async () => ({ created: true }),
  }),
};

function request(text: string) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{
      id: 'registry-discovery', role: 'user', parts: [{ type: 'text', text }],
    }] }),
  });
}

describe('find_tools without a runtime source (registry mode)', () => {
  it('exposes discovery over the deployed registry and activates by synonym', async () => {
    let context: StreamHandlerContext | undefined;
    const handler = createAiChatHandler({
      tools: registry,
      model: {},
      systemPrompt: 'Assistant',
      toolDiscovery: true,
      toolSemantics: { create_task: { synonyms: ['Aufgabe anlegen'] } },
      intentRouter: async () => ({ toolNames: ['list_tasks'] }),
      streamHandler: async (ctx) => {
        context = ctx;
        return new Response('ok');
      },
    });

    expect((await handler(request('Bitte eine Aufgabe anlegen'))).status).toBe(200);
    expect(context?.toolDiscovery?.activeToolNames()).toEqual(['find_tools', 'list_tasks']);
    const findTools = context!.tools.find_tools as {
      execute(input: unknown): Promise<{ tools: Array<{ name: string }> }>;
    };
    const found = await findTools.execute({ query: 'Aufgabe anlegen' });
    expect(found.tools.map((tool) => tool.name)).toEqual(['create_task']);
    expect(context?.toolDiscovery?.activeToolNames())
      .toEqual(['create_task', 'find_tools', 'list_tasks']);
  });

  it('keeps static scoping when discovery is disabled', async () => {
    let names: string[] = [];
    const handler = createAiChatHandler({
      tools: registry,
      model: {},
      systemPrompt: 'Assistant',
      intentRouter: async () => ({ toolNames: ['list_tasks'] }),
      streamHandler: async (ctx) => {
        names = Object.keys(ctx.tools);
        return new Response('ok');
      },
    });
    await handler(request('Liste'));
    expect(names).toEqual(['list_tasks']);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/server/adapters/nextjs/__tests__/registry-discovery.test.ts`
Expected: FAIL in the first test: `context?.toolDiscovery` is `undefined` (discovery requires `managedRuntime` today, `create-ai-chat-handler.ts:688`).

- [ ] **Step 3: Add the non-domain tool list**

In `src/server/adapters/nextjs/tool-discovery.ts` replace:

```ts
const FindToolsInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
});
```

with:

```ts
const FindToolsInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
});

/**
 * SDK-provided tools that are never domain capabilities: registry-mode
 * `find_tools` never indexes them, and they are not manifest tools.
 */
export const NON_DOMAIN_TOOL_NAMES = Object.freeze([
  'find_tools',
  'suggest_followups',
  'ask_clarification',
] as const);
```

- [ ] **Step 4: Wire registry discovery into the handler**

In `src/server/adapters/nextjs/create-ai-chat-handler.ts` replace:

```ts
import {
  createManagedTurnGuard,
  createTurnToolDiscovery,
  isToolRevoked,
  type BudgetEvaluation,
  type ManagedTurnGuard,
} from '../../../runtime/index.js';
import {
  createHybridToolDiscovery,
  type HybridToolDiscovery,
} from './tool-discovery.js';
```

with:

```ts
import {
  createManagedTurnGuard,
  createRegistryToolDiscovery,
  createTurnToolDiscovery,
  isToolRevoked,
  type BudgetEvaluation,
  type ManagedTurnGuard,
} from '../../../runtime/index.js';
import {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';
```

Replace:

```ts
    streamHandler: customStreamHandler,
    toolDiscovery: enableToolDiscovery = false,
  } = config;
```

with:

```ts
    streamHandler: customStreamHandler,
    toolDiscovery: enableToolDiscovery = false,
    toolSemantics,
  } = config;
```

Replace:

```ts
      ): Promise<HybridToolDiscovery | undefined> => {
        if (!enableToolDiscovery || !managedTurn) return undefined;
        const revocations
```

with:

```ts
      ): Promise<HybridToolDiscovery | undefined> => {
        if (!enableToolDiscovery) return undefined;
        if (!managedTurn) {
          return createHybridToolDiscovery({
            discovery: createRegistryToolDiscovery({
              turnId,
              registry,
              excludeNames: NON_DOMAIN_TOOL_NAMES,
              semantics: toolSemantics,
            }),
            initialToolNames,
          });
        }
        const revocations
```

Replace:

```ts
          discovery: createTurnToolDiscovery({
            snapshot: managedTurn.snapshot,
            registry,
            revokedToolIds,
          }),
```

with:

```ts
          discovery: createTurnToolDiscovery({
            snapshot: managedTurn.snapshot,
            registry,
            revokedToolIds,
            semantics: toolSemantics,
          }),
```

- [ ] **Step 5: Extend the config type**

In `src/server/adapters/nextjs/types.ts` replace:

```ts
import type {
  ManagedTurnBudgetSignal,
  TurnSnapshot,
} from '../../../runtime/index.js';
```

with:

```ts
import type {
  ManagedTurnBudgetSignal,
  ToolSearchSemanticsMap,
  TurnSnapshot,
} from '../../../runtime/index.js';
```

Replace:

```ts
  /**
   * Enable turn-pinned local `find_tools` recovery. It requires managedRuntime
   * and a manifest-materialized registry; false preserves static scoping.
   */
  toolDiscovery?: boolean;
```

with:

```ts
  /**
   * Enable local `find_tools` recovery. With managedRuntime (managed or
   * standalone source) discovery is pinned to the turn snapshot and its
   * authorization; without it the per-request registry is the deployed,
   * app-authorized tool set. false preserves static scoping.
   */
  toolDiscovery?: boolean;

  /**
   * Search-only synonyms keyed by model-facing tool name (for example from
   * generated tool semantics). They improve `find_tools` ranking and never
   * make a tool eligible or reach the model.
   */
  toolSemantics?: ToolSearchSemanticsMap;
```

In `src/server/adapters/nextjs/index.ts` replace:

```ts
export {
  createHybridToolDiscovery,
  type HybridToolDiscovery,
} from './tool-discovery.js';
```

with:

```ts
export {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';
```

- [ ] **Step 6: Run the adapter suite**

Run: `bunx vitest run src/server/adapters/nextjs && bun run typecheck && bun run typecheck:tests`
Expected: PASS, both typechecks exit 0 (managed-runtime and explicit-selection tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/server/adapters/nextjs/tool-discovery.ts src/server/adapters/nextjs/create-ai-chat-handler.ts src/server/adapters/nextjs/types.ts src/server/adapters/nextjs/index.ts src/server/adapters/nextjs/__tests__/registry-discovery.test.ts
git commit -m "feat(nextjs): offer find_tools without a runtime source"
```

---

### Task 4: Clarification wire protocol

**Files:**
- Create: `src/contracts/clarification.ts` (not added to `src/contracts/index.ts`, so P02/P03 edits there never conflict)
- Test: `src/contracts/__tests__/clarification.test.ts`

**Interfaces:**
- Produces:
  - `export const CLARIFICATION_TOOL_NAME: 'ask_clarification'`
  - `export type ClarificationTarget = 'person' | 'object' | 'time' | 'scope' | 'other'`
  - `export interface ClarificationOption { readonly id: string; readonly label: string; readonly description?: string }`
  - `export interface ClarificationRequest { readonly question: string; readonly target: ClarificationTarget; readonly options: ReadonlyArray<ClarificationOption>; readonly allowFreeText: boolean }`
  - `export interface ClarificationAnswerReference { readonly toolCallId: string; readonly optionId?: string }`
  - `export interface ParsedClarificationAnswer { readonly reference: ClarificationAnswerReference; readonly answer: string }`
  - `export function formatClarificationAnswer(input: { toolCallId: string; answer: string; optionId?: string }): string`
  - `export function parseClarificationAnswer(text: string): ParsedClarificationAnswer | undefined`
  - `export function stripClarificationMarkers(text: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/clarification.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_TOOL_NAME,
  formatClarificationAnswer,
  parseClarificationAnswer,
  stripClarificationMarkers,
} from '../clarification.js';

describe('clarification answer protocol', () => {
  it('round-trips the tool call reference and the visible answer', () => {
    const text = formatClarificationAnswer({
      toolCallId: 'call_1', optionId: 'task-42', answer: '  Bericht schreiben ',
    });
    expect(text).toBe(
      '<!--glirastes:clarification {"toolCallId":"call_1","optionId":"task-42"}-->\nBericht schreiben',
    );
    expect(parseClarificationAnswer(text)).toEqual({
      reference: { toolCallId: 'call_1', optionId: 'task-42' },
      answer: 'Bericht schreiben',
    });
    expect(stripClarificationMarkers(text)).toBe('Bericht schreiben');
    expect(CLARIFICATION_TOOL_NAME).toBe('ask_clarification');
  });

  it('keeps free-text answers without an option id', () => {
    const text = formatClarificationAnswer({ toolCallId: 'call-2', answer: 'Alice' });
    expect(parseClarificationAnswer(`Prefix ${text}`)).toEqual({
      reference: { toolCallId: 'call-2' },
      answer: 'Prefix Alice',
    });
  });

  it.each([
    '<!--glirastes:clarification {"toolCallId":"call 1"}-->\nx',
    '<!--glirastes:clarification {"toolCallId":"call-1","extra":true}-->\nx',
    '<!--glirastes:clarification {"toolCallId":"call-1","optionId":"<b>"}-->\nx',
    '<!--glirastes:clarification not-json-->\nx',
    '<!--glirastes:clarification {"toolCallId":"call-1"}-->\n   ',
    'plain text',
  ])('ignores malformed or empty markers: %s', (text) => {
    expect(parseClarificationAnswer(text)).toBeUndefined();
  });

  it('rejects ids that could break the marker', () => {
    expect(() => formatClarificationAnswer({ toolCallId: 'a-->', answer: 'x' })).toThrow();
    expect(() => formatClarificationAnswer({ toolCallId: 'a', optionId: 'x y', answer: 'x' })).toThrow();
    expect(() => formatClarificationAnswer({ toolCallId: 'a', answer: '  ' })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/contracts/__tests__/clarification.test.ts`
Expected: FAIL, `../clarification.js` cannot be resolved.

- [ ] **Step 3: Implement the protocol**

Create `src/contracts/clarification.ts`:

```ts
/**
 * Wire protocol between the built-in `ask_clarification` tool, the chat UI
 * and the server-side resume. Dependency-free so both the React bundle and
 * the server adapters can import it without pulling in Zod.
 */

export const CLARIFICATION_TOOL_NAME = 'ask_clarification' as const;

export type ClarificationTarget = 'person' | 'object' | 'time' | 'scope' | 'other';

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ClarificationRequest {
  readonly question: string;
  readonly target: ClarificationTarget;
  readonly options: ReadonlyArray<ClarificationOption>;
  readonly allowFreeText: boolean;
}

export interface ClarificationAnswerReference {
  readonly toolCallId: string;
  readonly optionId?: string;
}

export interface ParsedClarificationAnswer {
  readonly reference: ClarificationAnswerReference;
  /** The user's visible answer, marker removed and trimmed. */
  readonly answer: string;
}

const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const OPTION_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_ANSWER_LENGTH = 1_000;
const MARKER = /<!--glirastes:clarification (\{[^<>\n]{1,400}\})-->/;
const MARKERS = /<!--glirastes:clarification \{[^<>\n]{0,400}\}-->[ \t]*\n?/g;

/**
 * Text the chat UI sends to answer a clarification. The marker is invisible
 * in rendered bubbles and survives mention serialization (it is not a
 * `<!--context:...-->` block).
 */
export function formatClarificationAnswer(input: {
  toolCallId: string;
  answer: string;
  optionId?: string;
}): string {
  if (!TOOL_CALL_ID.test(input.toolCallId)) {
    throw new Error('Invalid clarification tool call id');
  }
  if (input.optionId !== undefined && !OPTION_ID.test(input.optionId)) {
    throw new Error('Invalid clarification option id');
  }
  const answer = input.answer.trim().slice(0, MAX_ANSWER_LENGTH);
  if (!answer) throw new Error('A clarification answer must not be empty');
  const reference: ClarificationAnswerReference = input.optionId === undefined
    ? { toolCallId: input.toolCallId }
    : { toolCallId: input.toolCallId, optionId: input.optionId };
  return `<!--glirastes:clarification ${JSON.stringify(reference)}-->\n${answer}`;
}

/** Parses the first clarification marker; anything malformed is ignored. */
export function parseClarificationAnswer(
  text: string,
): ParsedClarificationAnswer | undefined {
  const match = MARKER.exec(text);
  if (!match) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return undefined;
  }
  const record = decoded as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'toolCallId' && key !== 'optionId')) return undefined;
  if (typeof record.toolCallId !== 'string' || !TOOL_CALL_ID.test(record.toolCallId)) {
    return undefined;
  }
  if (
    record.optionId !== undefined
    && (typeof record.optionId !== 'string' || !OPTION_ID.test(record.optionId))
  ) {
    return undefined;
  }
  const answer = stripClarificationMarkers(text).trim().slice(0, MAX_ANSWER_LENGTH);
  if (!answer) return undefined;
  return {
    reference: typeof record.optionId === 'string'
      ? { toolCallId: record.toolCallId, optionId: record.optionId }
      : { toolCallId: record.toolCallId },
    answer,
  };
}

/** Removes every clarification marker for display or routing. */
export function stripClarificationMarkers(text: string): string {
  return text.replace(MARKERS, '');
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/contracts/__tests__/clarification.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/clarification.ts src/contracts/__tests__/clarification.test.ts
git commit -m "feat(contracts): define the clarification answer protocol"
```

---

### Task 5: Built-in `ask_clarification` tool

**Files:**
- Create: `src/server/core/clarification-tool.ts`
- Modify: `src/server/core/index.ts` (after `export { createFollowupTool } from './followup-tool.js';`, line 1136)
- Test: `src/server/core/__tests__/clarification-tool.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `Tool` from `src/types.ts`; `CLARIFICATION_TOOL_NAME`, `ClarificationRequest` (Task 4).
- Produces:
  - `export interface ClarificationConfig { enabled?: boolean; description?: string }`
  - `export const ClarificationInputSchema` (Zod object: `question`, `target`, `options?` max 6, `allowFreeText?`)
  - `export function createClarificationTool(config?: ClarificationConfig): Tool | null` — output `{ success: true; clarification: ClarificationRequest; _instruction: string }`

- [ ] **Step 1: Write the failing test**

Create `src/server/core/__tests__/clarification-tool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createClarificationTool } from '../clarification-tool.js';

const context = { currentDate: new Date('2026-10-04T08:00:00.000Z'), locale: 'de-DE' };

describe('createClarificationTool', () => {
  it('returns a structured request without touching the app', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const tool = createClarificationTool()!;
      expect(tool.id).toBe('ask_clarification');
      expect(tool.needsApproval).toBe(false);
      const input = tool.inputSchema.safeParse({
        question: 'Welche Aufgabe soll ich löschen?',
        target: 'object',
        options: [
          { id: 'task-1', label: 'Bericht schreiben' },
          { id: 'task-2', label: 'Release prüfen' },
        ],
      });
      expect(input.success).toBe(true);
      const result = await tool.execute((input as { data: unknown }).data, context);
      expect(result).toEqual({
        success: true,
        clarification: {
          question: 'Welche Aufgabe soll ich löschen?',
          target: 'object',
          options: [
            { id: 'task-1', label: 'Bericht schreiben' },
            { id: 'task-2', label: 'Release prüfen' },
          ],
          allowFreeText: true,
        },
        _instruction: expect.stringMatching(/wait for the answer/),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [{ question: '', target: 'object' }],
    [{ question: 'Wer?', target: 'manager' }],
    [{ question: 'Wer?', target: 'person', options: [], allowFreeText: false }],
    [{ question: 'Wer?', target: 'person', options: [
      { id: 'a', label: 'Alice' }, { id: 'a', label: 'Alex' },
    ] }],
    [{ question: 'Wer?', target: 'person', options: Array.from({ length: 7 }, (_, index) => ({
      id: `p${index}`, label: `Person ${index}`,
    })) }],
  ])('rejects invalid requests %j', (input) => {
    expect(createClarificationTool()!.inputSchema.safeParse(input).success).toBe(false);
  });

  it('can be disabled and re-described', () => {
    expect(createClarificationTool({ enabled: false })).toBeNull();
    expect(createClarificationTool({ description: 'Rückfrage stellen.' })!.description)
      .toBe('Rückfrage stellen.');
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/server/core/__tests__/clarification-tool.test.ts`
Expected: FAIL, `../clarification-tool.js` cannot be resolved.

- [ ] **Step 3: Implement the tool**

Create `src/server/core/clarification-tool.ts`:

```ts
import { z } from 'zod';
import { defineTool, type Tool } from '../../types.js';
import {
  CLARIFICATION_TOOL_NAME,
  type ClarificationRequest,
} from '../../contracts/clarification.js';

export interface ClarificationConfig {
  /** Default true when the object is provided. */
  enabled?: boolean;
  /** Replaces the model-facing description, e.g. for a German-only prompt. */
  description?: string;
}

const DEFAULT_DESCRIPTION = [
  'Ask the user exactly one targeted question when the request lacks a required',
  'target person, object, time or scope that cannot be derived from the',
  'conversation, mentions or app context. Offer up to 6 concrete options when',
  'you know them. Never ask when the intent is clear: act instead. After calling',
  'this tool, end your turn and wait for the answer.',
].join(' ');

const OptionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(200).optional(),
});

export const ClarificationInputSchema = z.object({
  question: z.string().trim().min(1).max(300),
  target: z.enum(['person', 'object', 'time', 'scope', 'other']),
  options: z.array(OptionSchema).max(6).optional(),
  allowFreeText: z.boolean().optional(),
}).superRefine((input, context) => {
  const ids = (input.options ?? []).map((option) => option.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Option ids must be unique', path: ['options'] });
  }
  if (ids.length === 0 && input.allowFreeText === false) {
    context.addIssue({
      code: 'custom',
      message: 'Provide options or allow a free-text answer',
      path: ['allowFreeText'],
    });
  }
});

/**
 * Built-in, side-effect-free clarification tool. It never calls the app; the
 * chat UI renders the request and resumes the original task with the answer.
 */
export function createClarificationTool(config?: ClarificationConfig): Tool | null {
  if (config?.enabled === false) return null;
  return defineTool({
    id: CLARIFICATION_TOOL_NAME,
    description: config?.description ?? DEFAULT_DESCRIPTION,
    inputSchema: ClarificationInputSchema,
    needsApproval: false,
    execute: async (input) => {
      const clarification: ClarificationRequest = {
        question: input.question,
        target: input.target,
        options: input.options ?? [],
        allowFreeText: input.allowFreeText ?? true,
      };
      return {
        success: true,
        clarification,
        _instruction:
          'The question is shown to the user. End this turn now and wait for the answer.',
      };
    },
  });
}
```

In `src/server/core/index.ts` replace:

```ts
export { createFollowupTool } from './followup-tool.js';
```

with:

```ts
export { createFollowupTool } from './followup-tool.js';

// ============================================================================
// Clarification Tool
// ============================================================================

export {
  createClarificationTool,
  ClarificationInputSchema,
  type ClarificationConfig,
} from './clarification-tool.js';
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/server/core/__tests__/clarification-tool.test.ts && bun run typecheck && bun run typecheck:tests`
Expected: PASS, 7 tests; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/core/clarification-tool.ts src/server/core/index.ts src/server/core/__tests__/clarification-tool.test.ts
git commit -m "feat(server): add the built-in ask_clarification tool"
```

---

### Task 6: Resume the original request from a clarification answer

**Files:**
- Create: `src/server/adapters/nextjs/clarification-resume.ts`
- Test: `src/server/adapters/nextjs/__tests__/clarification-resume.test.ts`

**Interfaces:**
- Consumes: `CLARIFICATION_TOOL_NAME`, `parseClarificationAnswer`, `stripClarificationMarkers` (Task 4).
- Produces:
  - `export interface ClarificationResume { readonly originalRequest: string; readonly question: string; readonly answer: string; readonly optionId?: string; readonly routingText: string; readonly modelText: string; readonly answerMessageIndex: number }`
  - `export function resolveClarificationResume(messages: ReadonlyArray<unknown>): ClarificationResume | undefined`
  - `export function applyClarificationResume(messages: ReadonlyArray<unknown>, resume: ClarificationResume): unknown[]`

- [ ] **Step 1: Write the failing test**

Create `src/server/adapters/nextjs/__tests__/clarification-resume.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatClarificationAnswer } from '../../../../contracts/clarification.js';
import {
  applyClarificationResume,
  resolveClarificationResume,
} from '../clarification-resume.js';

function clarificationTurn(toolCallId: string, question: string) {
  return {
    id: `assistant-${toolCallId}`,
    role: 'assistant',
    parts: [{
      type: 'tool-ask_clarification',
      toolCallId,
      state: 'output-available',
      input: { question, target: 'object', options: [], allowFreeText: true },
      output: { success: true },
    }],
  };
}

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('clarification resume', () => {
  it('joins the original request, the question and the answer', () => {
    const messages = [
      user('u1', 'Lösche die Aufgabe'),
      clarificationTurn('call-1', 'Welche Aufgabe?'),
      user('u2', formatClarificationAnswer({
        toolCallId: 'call-1', optionId: 'task-1', answer: 'Bericht schreiben',
      })),
    ];
    const resume = resolveClarificationResume(messages)!;
    expect(resume).toMatchObject({
      originalRequest: 'Lösche die Aufgabe',
      question: 'Welche Aufgabe?',
      answer: 'Bericht schreiben',
      optionId: 'task-1',
      routingText: 'Lösche die Aufgabe\nWelche Aufgabe? Bericht schreiben',
      answerMessageIndex: 2,
    });
    const rewritten = applyClarificationResume(messages, resume);
    expect(rewritten[0]).toBe(messages[0]);
    expect(rewritten[2]).toEqual({
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: resume.modelText }],
    });
    expect(resume.modelText).toContain('Original request: Lösche die Aufgabe');
    expect(JSON.stringify(messages[2])).toContain('glirastes:clarification');
  });

  it('follows chained clarifications back to the first request', () => {
    const messages = [
      user('u1', 'Weise die Aufgabe zu'),
      clarificationTurn('call-1', 'Welche Aufgabe?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-1', answer: 'Release prüfen' })),
      clarificationTurn('call-2', 'Wem?'),
      user('u3', formatClarificationAnswer({ toolCallId: 'call-2', answer: 'Alice' })),
    ];
    expect(resolveClarificationResume(messages)?.routingText).toBe(
      'Weise die Aufgabe zu\nWelche Aufgabe? Release prüfen\nWem? Alice',
    );
  });

  it.each([
    ['a plain message', [user('u1', 'Hallo')]],
    ['an unknown tool call id', [
      user('u1', 'Lösche'),
      clarificationTurn('call-1', 'Welche?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-9', answer: 'x' })),
    ]],
    ['an answer without an original request', [
      clarificationTurn('call-1', 'Welche?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-1', answer: 'x' })),
    ]],
    ['a marker on an older message only', [
      user('u1', 'Lösche'),
      clarificationTurn('call-1', 'Welche?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-1', answer: 'x' })),
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Erledigt.' }] },
      user('u3', 'Neue Frage'),
    ]],
  ])('does not resume for %s', (_label, messages) => {
    expect(resolveClarificationResume(messages)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/server/adapters/nextjs/__tests__/clarification-resume.test.ts`
Expected: FAIL, `../clarification-resume.js` cannot be resolved.

- [ ] **Step 3: Implement the resume**

Create `src/server/adapters/nextjs/clarification-resume.ts`:

```ts
import {
  CLARIFICATION_TOOL_NAME,
  parseClarificationAnswer,
  stripClarificationMarkers,
} from '../../../contracts/clarification.js';

/**
 * A clarification answer joined with the request it completes. The original
 * request stays in the client session; this only shapes routing input and
 * the model-facing copy of the latest user message.
 */
export interface ClarificationResume {
  readonly originalRequest: string;
  readonly question: string;
  readonly answer: string;
  readonly optionId?: string;
  /** Input for intent routing: no extra planner model call is needed. */
  readonly routingText: string;
  /** Replaces the latest user text for the model only. */
  readonly modelText: string;
  /** Index of the latest user message in the request's message array. */
  readonly answerMessageIndex: number;
}

const MAX_CHAIN_DEPTH = 3;
const MAX_ORIGINAL_LENGTH = 2_000;

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === 'object' && value !== null;
}

function messageText(message: MessageRecord): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .filter((part): part is MessageRecord =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

function clarificationQuestion(
  message: MessageRecord,
  toolCallId: string,
): string | undefined {
  if (message.role !== 'assistant' || !Array.isArray(message.parts)) return undefined;
  for (const part of message.parts) {
    if (!isRecord(part) || part.toolCallId !== toolCallId) continue;
    const isClarification = part.type === `tool-${CLARIFICATION_TOOL_NAME}`
      || (part.type === 'dynamic-tool' && part.toolName === CLARIFICATION_TOOL_NAME);
    if (!isClarification || !isRecord(part.input)) continue;
    const question = part.input.question;
    if (typeof question === 'string' && question.trim()) return question.trim();
  }
  return undefined;
}

function resolveAt(
  messages: ReadonlyArray<unknown>,
  userIndex: number,
  depth: number,
): ClarificationResume | undefined {
  const latest = messages[userIndex];
  if (!isRecord(latest) || latest.role !== 'user') return undefined;
  const parsed = parseClarificationAnswer(messageText(latest));
  if (!parsed) return undefined;

  let assistantIndex = -1;
  let question: string | undefined;
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isRecord(candidate)) continue;
    question = clarificationQuestion(candidate, parsed.reference.toolCallId);
    if (question) {
      assistantIndex = index;
      break;
    }
  }
  if (!question || assistantIndex < 0) return undefined;

  let originalIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isRecord(candidate) && candidate.role === 'user') {
      originalIndex = index;
      break;
    }
  }
  if (originalIndex < 0) return undefined;

  const earlier = depth < MAX_CHAIN_DEPTH
    ? resolveAt(messages, originalIndex, depth + 1)
    : undefined;
  const originalRequest = (earlier?.routingText
    ?? stripClarificationMarkers(messageText(messages[originalIndex] as MessageRecord)).trim())
    .slice(0, MAX_ORIGINAL_LENGTH);
  if (!originalRequest) return undefined;

  return {
    originalRequest,
    question,
    answer: parsed.answer,
    ...(parsed.reference.optionId ? { optionId: parsed.reference.optionId } : {}),
    routingText: `${originalRequest}\n${question} ${parsed.answer}`,
    modelText: [
      `Original request: ${originalRequest}`,
      `Clarification question: ${question}`,
      `Answer: ${parsed.answer}`,
      'Continue the original request with this answer.',
    ].join('\n'),
    answerMessageIndex: userIndex,
  };
}

/** Resolves the latest user message as a clarification answer, if it is one. */
export function resolveClarificationResume(
  messages: ReadonlyArray<unknown>,
): ClarificationResume | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isRecord(candidate) && candidate.role === 'user') {
      return resolveAt(messages, index, 1);
    }
  }
  return undefined;
}

/** Returns a copy whose latest user message carries the model-facing resume text. */
export function applyClarificationResume(
  messages: ReadonlyArray<unknown>,
  resume: ClarificationResume,
): unknown[] {
  return messages.map((message, index) => {
    if (index !== resume.answerMessageIndex || !isRecord(message)) return message;
    if (Array.isArray(message.parts)) {
      const others = message.parts.filter((part) =>
        !(isRecord(part) && part.type === 'text'));
      return { ...message, parts: [{ type: 'text', text: resume.modelText }, ...others] };
    }
    return { ...message, content: resume.modelText };
  });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/server/adapters/nextjs/__tests__/clarification-resume.test.ts && bun run typecheck:tests`
Expected: PASS, 6 tests; typecheck:tests exit 0 (the test reads the untouched answer through `JSON.stringify`, because `parts[0]` of the union-typed fixture has no `text` for the type checker).

- [ ] **Step 5: Commit**

```bash
git add src/server/adapters/nextjs/clarification-resume.ts src/server/adapters/nextjs/__tests__/clarification-resume.test.ts
git commit -m "feat(nextjs): resume the original request from a clarification answer"
```

---

### Task 7: Built-in tools stay active in hybrid discovery

**Files:**
- Modify: `src/server/adapters/nextjs/tool-discovery.ts` (`createHybridToolDiscovery`, original lines 29-40)
- Test: `src/server/adapters/nextjs/tool-discovery.test.ts` (add one case before `'does not share loaded state across controllers or turns'`)

**Interfaces:**
- Produces: `createHybridToolDiscovery(options: { discovery: TurnToolDiscovery; initialToolNames: ReadonlyArray<string>; builtinToolNames?: ReadonlyArray<string> }): HybridToolDiscovery` — built-ins are always in `activeToolNames()`, never searchable, never model-supplied.

- [ ] **Step 1: Write the failing test**

In `src/server/adapters/nextjs/tool-discovery.test.ts` replace:

```ts
  it('does not share loaded state across controllers or turns', async () => {
```

with:

```ts
  it('keeps server-configured built-ins active without making them searchable', async () => {
    const controller = createHybridToolDiscovery({
      discovery: discovery(),
      initialToolNames: [],
      builtinToolNames: ['ask_clarification', 'find_tools', 'tasks_list'],
    });
    expect(controller.activeToolNames()).toEqual([
      'ask_clarification',
      'find_tools',
    ]);
    await controller.tool.execute({ query: 'ask_clarification' });
    expect(controller.activeToolNames()).toEqual([
      'ask_clarification',
      'find_tools',
    ]);
  });

  it('does not share loaded state across controllers or turns', async () => {
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/server/adapters/nextjs/tool-discovery.test.ts`
Expected: FAIL: received `['find_tools']`, expected `['ask_clarification', 'find_tools']`.

- [ ] **Step 3: Implement built-in names**

In `src/server/adapters/nextjs/tool-discovery.ts` replace:

```ts
export function createHybridToolDiscovery(options: {
  discovery: TurnToolDiscovery;
  initialToolNames: ReadonlyArray<string>;
}): HybridToolDiscovery {
  const eligible = new Set(options.discovery.eligibleNames);
  const active = new Set(
    options.initialToolNames.filter((name) => eligible.has(name)),
  );
  const activeNames = () => Object.freeze(
    ['find_tools', ...active].sort((left, right) => left.localeCompare(right)),
  );
```

with:

```ts
export function createHybridToolDiscovery(options: {
  discovery: TurnToolDiscovery;
  initialToolNames: ReadonlyArray<string>;
  /**
   * Server-configured SDK tools (for example `ask_clarification`) that stay
   * active for the whole turn. They are never searchable or model-supplied.
   */
  builtinToolNames?: ReadonlyArray<string>;
}): HybridToolDiscovery {
  const eligible = new Set(options.discovery.eligibleNames);
  const builtins = [...new Set(options.builtinToolNames ?? [])]
    .filter((name) => name !== 'find_tools' && !eligible.has(name));
  const active = new Set(
    options.initialToolNames.filter((name) => eligible.has(name)),
  );
  const activeNames = () => Object.freeze(
    ['find_tools', ...builtins, ...active]
      .sort((left, right) => left.localeCompare(right)),
  );
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/server/adapters/nextjs/tool-discovery.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/adapters/nextjs/tool-discovery.ts src/server/adapters/nextjs/tool-discovery.test.ts
git commit -m "feat(nextjs): keep built-in tools active during discovery"
```

---

### Task 8: Clarification in the chat handler

**Files:**
- Modify: `src/server/adapters/nextjs/create-ai-chat-handler.ts` (line numbers refer to the file before Task 3; the replacement anchors are exact: import line 1; `shouldStopManagedExecution` lines 160-167; `defaultStreamHandler` lines 287-304 and 314-318; config destructure line 524; after the `staticTools`/`loadTools` guard line 618-622; request parsing lines 627-634; the head of `buildDiscovery` and both `createHybridToolDiscovery` calls in it; pipeline registry/user text lines 770-779; pipeline scoping lines 852-867; legacy registry lines 1015-1022; legacy routing text line 1034; legacy scoping lines 1041-1048)
- Modify: `src/server/adapters/nextjs/types.ts` (import line 18; after `followups` line 204; re-export line 370)
- Modify: `src/server/adapters/nextjs/index.ts`
- Test: `src/server/adapters/nextjs/__tests__/clarification-flow.test.ts`

**Interfaces:**
- Consumes: `createClarificationTool`, `ClarificationConfig` (Task 5); `resolveClarificationResume`, `applyClarificationResume` (Task 6); `builtinToolNames` (Task 7); `CLARIFICATION_TOOL_NAME` (Task 4).
- Produces:
  - `AiChatHandlerConfig.clarification?: ClarificationConfig`
  - `shouldStopManagedExecution(options: { stepCount: number; maxSteps: number; budgetState?: BudgetEvaluation['state']; lastStepToolNames?: ReadonlyArray<string> }): boolean`
  - Exports from `glirastes/server/nextjs`: `type ClarificationConfig`, `resolveClarificationResume`, `applyClarificationResume`, `type ClarificationResume`.
  - Behaviour: every SDK built-in in `NON_DOMAIN_TOOL_NAMES` (`find_tools`, `ask_clarification`, `suggest_followups`) runs outside the managed guard in `defaultStreamHandler`; with `toolDiscovery`, `buildDiscovery` keeps `ask_clarification` (when configured) and `suggest_followups` (when the pipeline selected it this turn) active as `builtinToolNames`.

- [ ] **Step 1: Write the failing test**

Create `src/server/adapters/nextjs/__tests__/clarification-flow.test.ts`:

```ts
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatClarificationAnswer } from '../../../../contracts/clarification.js';
import { defineTool, type PipelineResult } from '../../../../types.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function clarifyingModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'ask_clarification',
          input: JSON.stringify({
            question: 'Welche Aufgabe soll ich löschen?',
            target: 'object',
            options: [
              { id: 'task-1', label: 'Bericht schreiben' },
              { id: 'task-2', label: 'Release prüfen' },
            ],
          }),
        },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ]),
    }),
  });
}

function answeringModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Erledigt.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ]),
    }),
  });
}

/** First step suggests follow-ups, the second answers and stops. */
function followupModel() {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-f1',
              toolName: 'suggest_followups',
              input: JSON.stringify({ suggestions: ['Zeige erledigte Aufgaben'] }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        };
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hier sind deine Aufgaben.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ]),
      };
    },
  });
}

const registry = {
  list_tasks: defineTool({
    id: agentRevision.toolAllowlist[0]!, description: 'List visible tasks.',
    inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
};

const focusedNoMatch: PipelineResult = {
  model: { modelId: 'fixture' }, tools: [], toolSelection: 'explicit',
  sanitizedInput: '', intent: { intent: 'ambiguous', confidence: 0.2 },
  module: null, followupsEnabled: false,
};

const managedRuntime = {
  resolvePrincipal: async () => principal,
  resolveTurnSnapshot: async ({ turnId }: { turnId: string }) => createTurnSnapshot({
    turnId, agentRevision, manifestRevision, policyRevision, principal, localLimits,
  }),
};

function request(messages: unknown[]) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

describe('structured clarification in the chat handler', () => {
  it('asks inside the normal model step and ends the turn without a planner call', async () => {
    const model = clarifyingModel();
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      clarification: {},
      managedRuntime,
      pipeline: { process: async () => focusedNoMatch },
    });

    const response = await handler(request([{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösche die Aufgabe' }],
    }]));
    const wire = await response.text();

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).toEqual(['ask_clarification']);
    expect(wire).toContain('"toolName":"ask_clarification"');
    expect(wire).toContain('tool-output-available');
    expect(wire).toContain('Welche Aufgabe soll ich löschen?');
    expect(wire).not.toContain('manifest_tool_unavailable');
    expect(wire).not.toContain('tool-output-error');
  });

  it('keeps clarification active next to find_tools for an empty focused selection', async () => {
    let active: string[] = [];
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'Assistant',
      clarification: {}, toolDiscovery: true, managedRuntime,
      pipeline: { process: async () => focusedNoMatch },
      streamHandler: async (context) => {
        active = [...context.toolDiscovery!.activeToolNames()];
        return new Response('ok');
      },
    });
    await handler(request([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hm' }] }]));
    expect(active).toEqual(['ask_clarification', 'find_tools']);
  });

  it('resumes the original request with the answer for routing and the model', async () => {
    const model = answeringModel();
    // Typed parameter: `mock.calls[0]![0]` must typecheck under typecheck:tests.
    const process = vi.fn(async (_userText: string) => ({
      ...focusedNoMatch, tools: ['list_tasks'],
    }));
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      clarification: {},
      managedRuntime,
      maxContextMessages: 1,
      pipeline: { process },
    });

    const response = await handler(request([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösche die Aufgabe' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{
          type: 'tool-ask_clarification',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { question: 'Welche Aufgabe soll ich löschen?', target: 'object' },
          output: { success: true },
        }],
      },
      {
        id: 'u2',
        role: 'user',
        parts: [{
          type: 'text',
          text: formatClarificationAnswer({
            toolCallId: 'call-1', optionId: 'task-1', answer: 'Bericht schreiben',
          }),
        }],
      },
    ]));
    await response.text();

    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]![0]).toBe(
      'Lösche die Aufgabe\nWelche Aufgabe soll ich löschen? Bericht schreiben',
    );
    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('Original request: Lösche die Aufgabe');
    expect(prompt).toContain('Answer: Bericht schreiben');
    expect(prompt).not.toContain('glirastes:clarification');
  });

  it('keeps selected follow-up suggestions callable under the managed guard', async () => {
    const model = followupModel();
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      followups: {},
      toolDiscovery: true,
      managedRuntime,
      pipeline: {
        process: async () => ({
          ...focusedNoMatch, tools: ['suggest_followups'], followupsEnabled: true,
        }),
      },
    });

    const response = await handler(request([{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Zeige meine Aufgaben' }],
    }]));
    const wire = await response.text();

    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name).sort())
      .toEqual(['find_tools', 'suggest_followups']);
    expect(wire).toContain('"toolName":"suggest_followups"');
    expect(wire).toContain('tool-output-available');
    expect(wire).not.toContain('manifest_tool_unavailable');
    expect(wire).not.toContain('tool-output-error');
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/server/adapters/nextjs/__tests__/clarification-flow.test.ts`
Expected: FAIL: the first test sees an empty tool list (`[]` instead of `['ask_clarification']`), the second `['find_tools']`, the third a routing text containing the raw marker, the fourth `['find_tools']` without `suggest_followups` (hybrid discovery keeps only manifest-eligible names active; once active, the managed guard would still deny it with `manifest_tool_unavailable`, so the test pins both halves of the fix).

- [ ] **Step 3: Imports and the stop condition**

In `src/server/adapters/nextjs/create-ai-chat-handler.ts` replace line 1:

```ts
import { toolsToAiTools, createFollowupTool } from '../../core/index.js';
```

with:

```ts
import {
  toolsToAiTools,
  createFollowupTool,
  createClarificationTool,
} from '../../core/index.js';
import { CLARIFICATION_TOOL_NAME } from '../../../contracts/clarification.js';
import {
  applyClarificationResume,
  resolveClarificationResume,
} from './clarification-resume.js';
```

Replace:

```ts
export function shouldStopManagedExecution(options: {
  stepCount: number;
  maxSteps: number;
  budgetState?: BudgetEvaluation['state'];
}): boolean {
  return options.stepCount >= options.maxSteps
    || options.budgetState === 'hard-limit';
}
```

with:

```ts
export function shouldStopManagedExecution(options: {
  stepCount: number;
  maxSteps: number;
  budgetState?: BudgetEvaluation['state'];
  /** Tool names called in the latest step; a clarification ends the turn. */
  lastStepToolNames?: ReadonlyArray<string>;
}): boolean {
  return options.stepCount >= options.maxSteps
    || options.budgetState === 'hard-limit'
    || (options.lastStepToolNames ?? []).includes(CLARIFICATION_TOOL_NAME);
}
```

- [ ] **Step 4: Default stream handler: built-ins bypass the manifest guard, clarification stops**

Replace:

```ts
  const { find_tools: findTools, ...domainTools } = ctx.tools;
  const vercelTools = wrapToolsForVercelAi(
```

with:

```ts
  const {
    find_tools: findTools,
    [CLARIFICATION_TOOL_NAME]: clarificationTool,
    suggest_followups: followupTool,
    ...domainTools
  } = ctx.tools;
  const vercelTools = wrapToolsForVercelAi(
```

Replace:

```ts
  if (findTools) {
    Object.assign(
      vercelTools,
      wrapToolsForVercelAi({ find_tools: findTools }),
    );
  }
```

with:

```ts
  // SDK built-ins are not manifest tools: the managed guard would deny them.
  const builtinTools = {
    ...(findTools ? { find_tools: findTools } : {}),
    ...(clarificationTool ? { [CLARIFICATION_TOOL_NAME]: clarificationTool } : {}),
    ...(followupTool ? { suggest_followups: followupTool } : {}),
  };
  if (Object.keys(builtinTools).length > 0) {
    Object.assign(vercelTools, wrapToolsForVercelAi(builtinTools));
  }
```

Replace:

```ts
  }) => shouldStopManagedExecution({
    stepCount: event.steps.length,
    maxSteps: ctx.maxSteps,
    budgetState: ctx.managedTurn?.tracker.evaluate().state,
  });
```

with:

```ts
  }) => shouldStopManagedExecution({
    stepCount: event.steps.length,
    maxSteps: ctx.maxSteps,
    budgetState: ctx.managedTurn?.tracker.evaluate().state,
    lastStepToolNames: event.steps.at(-1)?.toolCalls.map((call) => call.toolName),
  });
```

- [ ] **Step 5: Handler configuration, registry and resume**

Replace:

```ts
    pipeline,
    followups,

    loadTools,
```

with:

```ts
    pipeline,
    followups,
    clarification,

    loadTools,
```

Replace:

```ts
  if (!staticTools && !loadTools) {
    throw new Error(
      'createAiChatHandler: either tools or loadTools must be provided',
    );
  }
```

with:

```ts
  if (!staticTools && !loadTools) {
    throw new Error(
      'createAiChatHandler: either tools or loadTools must be provided',
    );
  }

  const clarificationTool = clarification
    ? createClarificationTool(clarification)
    : null;
  const withClarification = (registry: ToolRegistry): ToolRegistry =>
    clarificationTool && !registry[CLARIFICATION_TOOL_NAME]
      ? { ...registry, [CLARIFICATION_TOOL_NAME]: clarificationTool }
      : registry;
```

Replace:

```ts
      const { messages } = await req.json();

      if (!Array.isArray(messages)) {
        return new Response(
          JSON.stringify({ error: 'messages must be an array' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
```

with:

```ts
      const { messages: requestMessages } = await req.json();

      if (!Array.isArray(requestMessages)) {
        return new Response(
          JSON.stringify({ error: 'messages must be an array' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // A clarification answer resumes its original request: routing sees
      // request + answer, the model sees an explicit continuation. The client
      // session keeps the untouched messages.
      const clarificationResume = resolveClarificationResume(requestMessages);
      const messages: unknown[] = clarificationResume
        ? applyClarificationResume(requestMessages, clarificationResume)
        : requestMessages;
```

At the head of `buildDiscovery` replace:

```ts
        if (!enableToolDiscovery) return undefined;
        if (!managedTurn) {
```

with:

```ts
        if (!enableToolDiscovery) return undefined;
        // SDK built-ins stay active next to the searchable domain tools:
        // clarification whenever configured, follow-ups when this turn's
        // pipeline selected them.
        const builtinToolNames = NON_DOMAIN_TOOL_NAMES.filter((name) =>
          name !== 'find_tools'
          && registry[name] !== undefined
          && (name === CLARIFICATION_TOOL_NAME || initialToolNames.includes(name)));
        if (!managedTurn) {
```

then replace:

```ts
              excludeNames: NON_DOMAIN_TOOL_NAMES,
              semantics: toolSemantics,
            }),
            initialToolNames,
          });
```

with:

```ts
              excludeNames: NON_DOMAIN_TOOL_NAMES,
              semantics: toolSemantics,
            }),
            initialToolNames,
            builtinToolNames,
          });
```

and replace:

```ts
            revokedToolIds,
            semantics: toolSemantics,
          }),
          initialToolNames,
        });
```

with:

```ts
            revokedToolIds,
            semantics: toolSemantics,
          }),
          initialToolNames,
          builtinToolNames,
        });
```

- [ ] **Step 6: Pipeline and legacy paths**

Replace:

```ts
        // Add followup tool if configured
        if (followups) {
          const followupTool = createFollowupTool(followups);
          if (followupTool && !registry[followupTool.id]) {
            registry = { ...registry, [followupTool.id]: followupTool };
          }
        }

        // Extract user input for pipeline
        let userText = extractLastUserText(messages);
```

with:

```ts
        // Add followup tool if configured
        if (followups) {
          const followupTool = createFollowupTool(followups);
          if (followupTool && !registry[followupTool.id]) {
            registry = { ...registry, [followupTool.id]: followupTool };
          }
        }
        registry = withClarification(registry);

        // Extract user input for pipeline
        let userText = clarificationResume?.routingText
          ?? extractLastUserText(messages);
```

Replace:

```ts
        // Convert all tools to AI tools
        let aiTools = await toolsToAiTools(registry, endpointToolContext, toolOptions);

        // Scope tools to pipeline selection
        if (pipelineResult.blocked) {
          // Guardrails blocked — no tools allowed
          aiTools = {};
        } else if (!discoveryController && (hasExplicitSelection || pipelineResult.tools.length > 0)) {
          aiTools = scopePipelineTools({
            aiTools,
            registryToolNames: new Set(Object.keys(registry)),
            selected: pipelineResult.tools,
            fallbackToAll: !hasExplicitSelection,
          });
        }
```

with:

```ts
        // Convert all tools to AI tools
        let aiTools = await toolsToAiTools(registry, endpointToolContext, toolOptions);
        const clarificationAiTool = aiTools[CLARIFICATION_TOOL_NAME];

        // Scope tools to pipeline selection
        if (pipelineResult.blocked) {
          // Guardrails blocked — no tools allowed
          aiTools = {};
        } else if (!discoveryController && (hasExplicitSelection || pipelineResult.tools.length > 0)) {
          aiTools = scopePipelineTools({
            aiTools,
            registryToolNames: new Set(Object.keys(registry)),
            selected: pipelineResult.tools,
            fallbackToAll: !hasExplicitSelection,
          });
          // Clarification stays callable, also for an empty focused selection.
          if (clarificationAiTool) {
            aiTools = { ...aiTools, [CLARIFICATION_TOOL_NAME]: clarificationAiTool };
          }
        }
```

Replace:

```ts
      // Load tools
      let registry: ToolRegistry;
      if (staticTools) {
        registry = staticTools;
      } else {
        registry = await loadTools!(endpointToolContext);
      }
      const allToolNames = Object.keys(registry);
```

with:

```ts
      // Load tools
      let registry: ToolRegistry;
      if (staticTools) {
        registry = staticTools;
      } else {
        registry = await loadTools!(endpointToolContext);
      }
      registry = withClarification(registry);
      const allToolNames = Object.keys(registry)
        .filter((name) => name !== CLARIFICATION_TOOL_NAME);
```

Replace:

```ts
      if (intentRouter) {
        const text = extractLastUserText(processedMessages);
        routing = await intentRouter(text, allToolNames);
      }
```

with:

```ts
      if (intentRouter) {
        const text = clarificationResume?.routingText
          ?? extractLastUserText(processedMessages);
        routing = await intentRouter(text, allToolNames);
      }
```

Replace:

```ts
      // Scope tools by intent
      if (routing?.toolNames && routing.toolNames.length > 0) {
        const scoped: typeof aiTools = {};
        for (const name of routing.toolNames) {
          if (aiTools[name]) scoped[name] = aiTools[name];
        }
        if (Object.keys(scoped).length > 0) aiTools = scoped;
      }
```

with:

```ts
      // Scope tools by intent
      if (routing?.toolNames && routing.toolNames.length > 0) {
        const scoped: typeof aiTools = {};
        for (const name of routing.toolNames) {
          if (aiTools[name]) scoped[name] = aiTools[name];
        }
        if (Object.keys(scoped).length > 0) {
          aiTools = aiTools[CLARIFICATION_TOOL_NAME]
            ? { ...scoped, [CLARIFICATION_TOOL_NAME]: aiTools[CLARIFICATION_TOOL_NAME] }
            : scoped;
        }
      }
```

- [ ] **Step 7: Types and exports**

In `src/server/adapters/nextjs/types.ts` replace:

```ts
import type { Lancer } from '../../lancer/index.js';
import type { InternalApiCaller } from '../../core/index.js';
```

with:

```ts
import type { Lancer } from '../../lancer/index.js';
import type { ClarificationConfig, InternalApiCaller } from '../../core/index.js';
```

Replace:

```ts
  /**
   * Followups configuration. Pro feature — requires pipeline from glirastes/server.
   * Only used with pipeline mode.
   */
  followups?: FollowupsConfig;
```

with:

```ts
  /**
   * Followups configuration. Pro feature — requires pipeline from glirastes/server.
   * Only used with pipeline mode.
   */
  followups?: FollowupsConfig;

  /**
   * Built-in structured clarification (`ask_clarification`). The model asks
   * one targeted question inside its normal step (no extra planner call);
   * the turn ends after the question, and the UI's answer resumes the
   * original request. Omit to keep the tool unavailable.
   */
  clarification?: ClarificationConfig;
```

Replace:

```ts
export type { AiPipeline, FollowupsConfig, PipelineResult };
```

with:

```ts
export type { AiPipeline, FollowupsConfig, PipelineResult };
export type { ClarificationConfig };
```

In `src/server/adapters/nextjs/index.ts` replace:

```ts
  // Re-exported from glirastes
  AiPipeline,
  FollowupsConfig,
```

with:

```ts
  // Re-exported from glirastes
  AiPipeline,
  ClarificationConfig,
  FollowupsConfig,
```

and replace:

```ts
export {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';
```

with:

```ts
export {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';
export {
  applyClarificationResume,
  resolveClarificationResume,
  type ClarificationResume,
} from './clarification-resume.js';
```

- [ ] **Step 8: Run the server and runtime suites**

Run: `bunx vitest run src/server src/runtime src/contracts && bun run typecheck && bun run typecheck:tests`
Expected: PASS (clarification-flow 4 tests plus the re-run of imported turn-snapshot cases; existing managed-runtime, explicit-selection and follow-up tests unchanged); both typechecks exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/server/adapters/nextjs/create-ai-chat-handler.ts src/server/adapters/nextjs/types.ts src/server/adapters/nextjs/index.ts src/server/adapters/nextjs/__tests__/clarification-flow.test.ts
git commit -m "feat(nextjs): ask structured clarifications and resume the request"
```

---

### Task 9: Clarification card in the React chat

**Files:**
- Create: `src/react/utils/clarification.ts`
- Create: `src/react/components/clarification-card.tsx`
- Modify: `src/react/components/message-bubble.tsx` (imports lines 1-6, `shouldRenderToolResult` lines 34-45, `MessageBubble` head lines 60-64, text map line 73, empty-message check lines 115-131, part rendering lines 183-196)
- Modify: `src/react/types.ts` (line 1 import, `ChatComponents` line 437, `ChatLocale` end line 495, before `ToolResultBlockProps` line 894)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`DEFAULT_LOCALE` end line 76)
- Modify: `src/react/index.ts`
- Test: `src/react/components/__tests__/clarification-card.test.tsx`

**Interfaces:**
- Consumes: `CLARIFICATION_TOOL_NAME`, `ClarificationRequest`, `formatClarificationAnswer`, `stripClarificationMarkers` (Task 4); chat context `send`, `messages`, `isLoading`, `locale`, `classNames`.
- Produces:
  - `export interface ClarificationPart { readonly toolCallId: string; readonly request: ClarificationRequest; readonly ready: boolean }`
  - `export function readClarificationPart(part: unknown): ClarificationPart | undefined`
  - `export function findOpenClarification(messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>): ClarificationPart | undefined`
  - `export interface ClarificationCardProps { toolCallId: string; request: ClarificationRequest; interactive: boolean; onAnswer: (answer: { text: string; optionId?: string }) => void; className?: string }`
  - `export function ClarificationCard(props: ClarificationCardProps): JSX.Element`
  - `ChatComponents.ClarificationCard?: ComponentType<ClarificationCardProps>`; `ChatLocale.clarificationInputLabel: string`, `ChatLocale.clarificationSubmitButton: string`

- [ ] **Step 1: Write the failing test**

Create `src/react/components/__tests__/clarification-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types.js';
import { MessageBubble } from '../message-bubble.js';

const clarificationMessage = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [{
    type: 'tool-ask_clarification',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { question: 'Welche Aufgabe?', target: 'object' },
    output: {
      success: true,
      clarification: {
        question: 'Welche Aufgabe soll ich löschen?',
        target: 'object',
        options: [
          { id: 'task-1', label: 'Bericht schreiben' },
          { id: 'task-2', label: 'Release prüfen', description: 'fällig morgen' },
        ],
        allowFreeText: true,
      },
    },
  }],
} as unknown as ChatMessage;

const chatContext = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

function setContext(messages: ChatMessage[], overrides: Record<string, unknown> = {}) {
  const send = vi.fn();
  chatContext.current = {
    classNames: {},
    components: { Markdown: ({ content }: { content: string }) => <div>{content}</div> },
    toolResults: { mode: 'default' },
    locale: { clarificationInputLabel: 'Deine Antwort', clarificationSubmitButton: 'Antworten' },
    messages,
    send,
    isLoading: false,
    ...overrides,
  };
  return send;
}

describe('structured clarification card', () => {
  afterEach(cleanup);

  it('answers with a concrete option and resumes the original request', () => {
    const send = setContext([clarificationMessage]);
    render(<MessageBubble message={clarificationMessage} />);

    expect(screen.getByRole('group', { name: 'Welche Aufgabe soll ich löschen?' })).toBeTruthy();
    expect(document.querySelector('[data-component="tool-result"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Release prüfen/ }));

    expect(send).toHaveBeenCalledExactlyOnceWith(
      '<!--glirastes:clarification {"toolCallId":"call-1","optionId":"task-2"}-->\nRelease prüfen',
    );
    expect(screen.getByRole('button', { name: /Bericht schreiben/ }).hasAttribute('disabled'))
      .toBe(true);
  });

  it('answers with free text from the keyboard', () => {
    const send = setContext([clarificationMessage]);
    render(<MessageBubble message={clarificationMessage} />);

    const input = screen.getByRole('textbox', { name: 'Deine Antwort' });
    fireEvent.change(input, { target: { value: 'die von gestern' } });
    fireEvent.submit(input.closest('form')!);

    expect(send).toHaveBeenCalledExactlyOnceWith(
      '<!--glirastes:clarification {"toolCallId":"call-1"}-->\ndie von gestern',
    );
  });

  it('is read-only once a newer message exists or a turn is running', () => {
    const answer = {
      id: 'user-2', role: 'user',
      parts: [{ type: 'text', text: '<!--glirastes:clarification {"toolCallId":"call-1"}-->\nAlice' }],
    } as ChatMessage;
    setContext([clarificationMessage, answer]);
    const { rerender } = render(<MessageBubble message={clarificationMessage} />);
    expect(document.querySelector('[data-component="clarification-card"]')?.getAttribute('data-state'))
      .toBe('answered');
    expect(screen.queryByRole('textbox')).toBeNull();

    setContext([clarificationMessage], { isLoading: true });
    rerender(<MessageBubble message={clarificationMessage} />);
    expect(screen.getByRole('button', { name: /Bericht schreiben/ }).hasAttribute('disabled'))
      .toBe(true);
  });

  it('shows only the visible answer in the user bubble', () => {
    const answer = {
      id: 'user-2', role: 'user',
      parts: [{ type: 'text', text: '<!--glirastes:clarification {"toolCallId":"call-1"}-->\nAlice' }],
    } as ChatMessage;
    setContext([clarificationMessage, answer]);
    render(<MessageBubble message={answer} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(document.body.textContent).not.toContain('glirastes:clarification');
  });

  it('renders a request from tool input when stored output is incomplete', () => {
    const legacy = {
      ...clarificationMessage,
      parts: [{
        type: 'tool-ask_clarification', toolCallId: 'call-9', state: 'output-available',
        input: { question: 'Wen meinst du?', target: 'person', options: [{ id: 'a', label: 'Alice' }] },
        output: { success: true },
      }],
    } as unknown as ChatMessage;
    setContext([legacy]);
    render(<MessageBubble message={legacy} />);
    expect(screen.getByRole('group', { name: 'Wen meinst du?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/components/__tests__/clarification-card.test.tsx`
Expected: FAIL: no element with role `group` (the clarification part renders as raw tool output or is skipped).

- [ ] **Step 3: Client helpers**

Create `src/react/utils/clarification.ts`:

```ts
import {
  CLARIFICATION_TOOL_NAME,
  type ClarificationOption,
  type ClarificationRequest,
  type ClarificationTarget,
} from '../../contracts/clarification.js';

export interface ClarificationPart {
  readonly toolCallId: string;
  readonly request: ClarificationRequest;
  /** True once the tool output exists; only then can the user answer. */
  readonly ready: boolean;
}

const TARGETS: ReadonlySet<string> = new Set(['person', 'object', 'time', 'scope', 'other']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptions(value: unknown): ClarificationOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: ClarificationOption[] = [];
  for (const candidate of value.slice(0, 6)) {
    if (!isRecord(candidate)) continue;
    const { id, label, description } = candidate;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) continue;
    if (typeof label !== 'string' || !label.trim() || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: label.trim().slice(0, 120),
      ...(typeof description === 'string' && description.trim()
        ? { description: description.trim().slice(0, 200) }
        : {}),
    });
  }
  return options;
}

function readRequest(value: unknown): ClarificationRequest | undefined {
  if (!isRecord(value) || typeof value.question !== 'string' || !value.question.trim()) {
    return undefined;
  }
  const options = readOptions(value.options);
  const allowFreeText = value.allowFreeText !== false || options.length === 0;
  const target = typeof value.target === 'string' && TARGETS.has(value.target)
    ? value.target as ClarificationTarget
    : 'other';
  return {
    question: value.question.trim().slice(0, 300),
    target,
    options,
    allowFreeText,
  };
}

/** Reads an `ask_clarification` tool part from AI SDK 5/6 UI messages. */
export function readClarificationPart(part: unknown): ClarificationPart | undefined {
  if (!isRecord(part) || typeof part.toolCallId !== 'string') return undefined;
  const isClarification = part.type === `tool-${CLARIFICATION_TOOL_NAME}`
    || (part.type === 'dynamic-tool' && part.toolName === CLARIFICATION_TOOL_NAME);
  if (!isClarification) return undefined;
  const fromOutput = isRecord(part.output) ? readRequest(part.output.clarification) : undefined;
  const request = fromOutput ?? readRequest(part.input);
  if (!request) return undefined;
  return {
    toolCallId: part.toolCallId,
    request,
    ready: part.state === 'output-available',
  };
}

/** The clarification the latest assistant message is waiting on, if any. */
export function findOpenClarification(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
): ClarificationPart | undefined {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'assistant') return undefined;
  for (let index = latest.parts.length - 1; index >= 0; index -= 1) {
    const clarification = readClarificationPart(latest.parts[index]);
    if (clarification?.ready) return clarification;
  }
  return undefined;
}
```

- [ ] **Step 4: The card component**

Create `src/react/components/clarification-card.tsx`:

```tsx
import { useId, useState, type FormEvent } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { ClarificationCardProps } from '../types.js';

/**
 * Structured clarification: concrete options plus an optional free-text
 * answer. Answering sends one user message that resumes the original task.
 */
export function ClarificationCard({
  toolCallId,
  request,
  interactive,
  onAnswer,
  className,
}: ClarificationCardProps) {
  const { classNames, locale } = useChatContext();
  const questionId = useId();
  const [draft, setDraft] = useState('');
  const [answered, setAnswered] = useState(false);
  const enabled = interactive && !answered;

  const answer = (text: string, optionId?: string) => {
    const trimmed = text.trim();
    if (!enabled || !trimmed) return;
    setAnswered(true);
    onAnswer(optionId === undefined ? { text: trimmed } : { text: trimmed, optionId });
  };

  const submitFreeText = (event: FormEvent) => {
    event.preventDefault();
    answer(draft);
  };

  return (
    <div
      className={className ?? classNames.clarificationCard}
      data-component="clarification-card"
      data-state={enabled ? 'open' : 'answered'}
      data-tool-call-id={toolCallId}
      role="group"
      aria-labelledby={questionId}
    >
      <p id={questionId} data-element="question">{request.question}</p>
      {request.options.length > 0 && (
        <div data-element="options">
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              data-action="answer-option"
              data-option-id={option.id}
              disabled={!enabled}
              onClick={() => answer(option.label, option.id)}
            >
              <span data-element="label">{option.label}</span>
              {option.description && (
                <span data-element="description">{option.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {request.allowFreeText && enabled && (
        <form data-element="free-text" onSubmit={submitFreeText}>
          <input
            type="text"
            value={draft}
            maxLength={500}
            aria-label={locale.clarificationInputLabel}
            placeholder={locale.clarificationInputLabel}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" data-action="answer-free-text" disabled={!draft.trim()}>
            {locale.clarificationSubmitButton}
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Types, locale and exports**

In `src/react/types.ts` replace line 1:

```ts
import type { ReactNode, ReactElement, ComponentType, MouseEvent as ReactMouseEvent } from 'react';
```

with:

```ts
import type { ReactNode, ReactElement, ComponentType, MouseEvent as ReactMouseEvent } from 'react';
import type { ClarificationRequest } from '../contracts/clarification.js';

export type {
  ClarificationOption,
  ClarificationRequest,
  ClarificationTarget,
} from '../contracts/clarification.js';
```

Replace:

```ts
  SuggestionChip?: ComponentType<SuggestionChipProps>;
  MentionChip?: ComponentType<MentionChipProps>;
}
```

with:

```ts
  SuggestionChip?: ComponentType<SuggestionChipProps>;
  MentionChip?: ComponentType<MentionChipProps>;
  ClarificationCard?: ComponentType<ClarificationCardProps>;
}
```

Replace:

```ts
  renameSessionAriaLabel: string;
  renameSessionPlaceholder: string;
}
```

with:

```ts
  renameSessionAriaLabel: string;
  renameSessionPlaceholder: string;

  // Structured clarification
  clarificationInputLabel: string;
  clarificationSubmitButton: string;
}
```

Replace:

```ts
export interface ToolResultBlockProps {
```

with:

```ts
export interface ClarificationCardProps {
  toolCallId: string;
  request: ClarificationRequest;
  /** False once answered or when a newer message exists. */
  interactive: boolean;
  onAnswer: (answer: { text: string; optionId?: string }) => void;
  className?: string;
}

export interface ToolResultBlockProps {
```

In `src/react/provider/ai-chat-provider.tsx` replace:

```ts
  renameSessionAriaLabel: 'Rename conversation',
  renameSessionPlaceholder: 'Conversation title',
};
```

with:

```ts
  renameSessionAriaLabel: 'Rename conversation',
  renameSessionPlaceholder: 'Conversation title',
  clarificationInputLabel: 'Your answer',
  clarificationSubmitButton: 'Answer',
};
```

In `src/react/index.ts` replace:

```ts
  ToolResultBlockProps,
  MarkdownProps,
```

with:

```ts
  ToolResultBlockProps,
  ClarificationCardProps,
  ClarificationOption,
  ClarificationRequest,
  ClarificationTarget,
  MarkdownProps,
```

Replace:

```ts
export { SessionSwitcher, type SessionSwitcherProps } from './components/session-switcher.js';
```

with:

```ts
export { SessionSwitcher, type SessionSwitcherProps } from './components/session-switcher.js';
export { ClarificationCard } from './components/clarification-card.js';
```

Replace:

```ts
export {
  createApprovalDescriptionGenerator,
  type ApprovalDescriptionConfig,
} from './utils/create-approval-description.js';
```

with:

```ts
export {
  createApprovalDescriptionGenerator,
  type ApprovalDescriptionConfig,
} from './utils/create-approval-description.js';
export {
  findOpenClarification,
  readClarificationPart,
  type ClarificationPart,
} from './utils/clarification.js';
export {
  formatClarificationAnswer,
  stripClarificationMarkers,
} from '../contracts/clarification.js';
```

- [ ] **Step 6: Render the card in `MessageBubble`**

In `src/react/components/message-bubble.tsx` replace:

```ts
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import type { MessageBubbleProps, TextPart } from '../types.js';
```

with:

```ts
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import { readClarificationPart } from '../utils/clarification.js';
import { ClarificationCard as DefaultClarificationCard } from './clarification-card.js';
import {
  CLARIFICATION_TOOL_NAME,
  formatClarificationAnswer,
  stripClarificationMarkers,
} from '../../contracts/clarification.js';
import type { MessageBubbleProps, TextPart } from '../types.js';
```

Replace:

```ts
  if (toolName === 'suggest_followups') return false;
```

with:

```ts
  if (toolName === 'suggest_followups') return false;
  // Clarifications render as an answerable card, never as raw output.
  if (toolName === CLARIFICATION_TOOL_NAME) return false;
```

Replace:

```ts
export function MessageBubble({ message, className }: MessageBubbleProps) {
  const { classNames, components, toolResults } = useChatContext();
  const MarkdownComponent = components.Markdown ?? DefaultMarkdown;
  const ToolResultComponent = components.ToolResultBlock ?? DefaultToolResult;
  const MentionChipComponent = components.MentionChip ?? DefaultMentionChip;
```

with:

```ts
export function MessageBubble({ message, className }: MessageBubbleProps) {
  const {
    classNames,
    components,
    toolResults,
    messages,
    send,
    isLoading,
  } = useChatContext();
  const MarkdownComponent = components.Markdown ?? DefaultMarkdown;
  const ToolResultComponent = components.ToolResultBlock ?? DefaultToolResult;
  const MentionChipComponent = components.MentionChip ?? DefaultMentionChip;
  const ClarificationComponent = components.ClarificationCard ?? DefaultClarificationCard;
  const isLatestMessage = messages?.[messages.length - 1]?.id === message.id;
```

Replace:

```ts
    .map((p) => stripContextBlocks(p.text))
```

with:

```ts
    .map((p) => stripClarificationMarkers(stripContextBlocks(p.text)))
```

Replace:

```ts
    const hasVisibleToolOutput = message.parts.some(p => {
      if (!isRecord(p)) return false;
```

with:

```ts
    const hasVisibleToolOutput = message.parts.some(p => {
      if (readClarificationPart(p)) return true;
      if (!isRecord(p)) return false;
```

Replace:

```tsx
      {message.parts.map((part, i) => {
        // Standard ToolResultPart
```

with:

```tsx
      {message.parts.map((part, i) => {
        const clarification = readClarificationPart(part);
        if (clarification) {
          return (
            <ClarificationComponent
              key={`clarification-${clarification.toolCallId}`}
              toolCallId={clarification.toolCallId}
              request={clarification.request}
              interactive={clarification.ready && isLatestMessage && !isLoading}
              onAnswer={(answer) => send(formatClarificationAnswer({
                toolCallId: clarification.toolCallId,
                answer: answer.text,
                ...(answer.optionId ? { optionId: answer.optionId } : {}),
              }))}
            />
          );
        }

        // Standard ToolResultPart
```

- [ ] **Step 7: Run the React suite**

Run: `bunx vitest run src/react && bun run typecheck && bun run typecheck:tests`
Expected: PASS (new 5 tests; existing `message-bubble.test.tsx` still passes with its partial context mock); both typechecks exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/react/utils/clarification.ts src/react/components/clarification-card.tsx src/react/components/message-bubble.tsx src/react/types.ts src/react/provider/ai-chat-provider.tsx src/react/index.ts src/react/components/__tests__/clarification-card.test.tsx
git commit -m "feat(react): render answerable clarification cards"
```

---

### Task 10: Composer text answers an open clarification

**Files:**
- Modify: `src/react/provider/ai-chat-provider.tsx` (imports line 26; inside `send`, after the `onBeforeSend` block lines 828-830)
- Test: `src/react/provider/__tests__/clarification-answer.test.tsx`

**Interfaces:**
- Consumes: `findOpenClarification` (Task 9), `formatClarificationAnswer`, `parseClarificationAnswer` (Task 4).
- Produces: `send(text)` wraps text ≤ 1000 characters as the answer when the latest assistant message waits on a free-text clarification.

- [ ] **Step 1: Write the failing test**

Create `src/react/provider/__tests__/clarification-answer.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatTransport } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

function transport(messages: ChatMessage[]): ChatTransport {
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

function SendProbe({ text }: { text: string }) {
  const { send } = useChatContext();
  return <button type="button" onClick={() => send(text)}>send</button>;
}

const openClarification = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [{
    type: 'tool-ask_clarification',
    toolCallId: 'call-7',
    state: 'output-available',
    input: { question: 'Wem zuweisen?', target: 'person', allowFreeText: true },
    output: { success: true },
  }],
} as unknown as ChatMessage;

describe('composer answers to an open clarification', () => {
  afterEach(cleanup);

  it('marks typed text as the answer so the server resumes the original task', async () => {
    const chat = transport([
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Weise die Aufgabe zu' }] },
      openClarification,
    ]);
    render(<AiChatProvider transport={chat}><SendProbe text="Alice" /></AiChatProvider>);
    await act(async () => { screen.getByRole('button', { name: 'send' }).click(); });
    expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '<!--glirastes:clarification {"toolCallId":"call-7"}-->\nAlice',
    });
  });

  it('leaves ordinary messages untouched when nothing is open', async () => {
    const chat = transport([
      { id: 'assistant-0', role: 'assistant', parts: [{ type: 'text', text: 'Fertig.' }] },
    ]);
    render(<AiChatProvider transport={chat}><SendProbe text="Danke" /></AiChatProvider>);
    await act(async () => { screen.getByRole('button', { name: 'send' }).click(); });
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Danke' });
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/provider/__tests__/clarification-answer.test.tsx`
Expected: FAIL: first test receives `{ text: 'Alice' }`.

- [ ] **Step 3: Wrap composer text**

In `src/react/provider/ai-chat-provider.tsx` replace:

```ts
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
```

with:

```ts
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import { findOpenClarification } from '../utils/clarification.js';
import {
  formatClarificationAnswer,
  parseClarificationAnswer,
} from '../../contracts/clarification.js';
```

Replace:

```ts
    if (onBeforeSend) {
      processedMessage = onBeforeSend(processedMessage, activeMentions);
    }
```

with:

```ts
    if (onBeforeSend) {
      processedMessage = onBeforeSend(processedMessage, activeMentions);
    }

    // Typing into the composer while a clarification is open answers it, so
    // the server resumes the original request instead of starting over.
    const openClarification = findOpenClarification(
      rawMessages as unknown as Array<{ role: string; parts: unknown[] }>,
    );
    if (
      openClarification?.request.allowFreeText
      && processedMessage.trim().length > 0
      && processedMessage.length <= 1_000
      && !parseClarificationAnswer(processedMessage)
    ) {
      processedMessage = formatClarificationAnswer({
        toolCallId: openClarification.toolCallId,
        answer: processedMessage,
      });
    }
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/provider`
Expected: PASS (new 2 tests plus existing provider tests).

- [ ] **Step 5: Commit**

```bash
git add src/react/provider/ai-chat-provider.tsx src/react/provider/__tests__/clarification-answer.test.tsx
git commit -m "feat(react): treat composer text as the open clarification answer"
```

---

### Task 11: Generic completion search for `/` and `@`

**Files:**
- Create: `src/react/completions/completion-search.ts`
- Modify: `src/react/types.ts` (`MentionResult` lines 224-230; insert before `MentionSerializationConfig` line 246)
- Modify: `src/react/index.ts`
- Test: `src/react/completions/__tests__/completion-search.test.ts`

**Interfaces:**
- Produces (types in `src/react/types.ts`):
  - `MentionResult.key?: string`, `MentionResult.slug?: string`
  - `export interface CompletionPermissionContext { readonly roles?: ReadonlyArray<string>; readonly attributes?: Readonly<Record<string, unknown>> }`
  - `export interface CompletionItem { id: string; type: string; label: string; description?: string; slug?: string }`
  - `export interface CompletionSearchRequest { query: string; trigger: string; signal: AbortSignal; context: CompletionPermissionContext; limit: number }`
  - `export interface ChatCompletionProvider { id: string; trigger: '@' | '/'; search(request: CompletionSearchRequest): Promise<ReadonlyArray<CompletionItem>> | ReadonlyArray<CompletionItem> }`
- Produces (implementation):
  - `export interface CompletionSearchOptions { context?: CompletionPermissionContext; limitPerProvider?: number; maxResults?: number; timeoutMs?: number; onProviderError?: (providerId: string, error: unknown) => void }`
  - `export type CompletionSearch = (query: string, trigger: string) => Promise<MentionResult[]>`
  - `export function createCompletionSearch(providers: ReadonlyArray<ChatCompletionProvider>, options?: CompletionSearchOptions): CompletionSearch`

- [ ] **Step 1: Write the failing test**

Create `src/react/completions/__tests__/completion-search.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionProvider } from '../../types.js';
import { createCompletionSearch } from '../completion-search.js';

const people: ChatCompletionProvider = {
  id: 'people',
  trigger: '@',
  search: async ({ query }) => [
    { id: '42', type: 'user', label: 'Alice Doe', description: `match ${query}` },
    { id: '43', type: 'user', label: 'Alex Roe' },
  ],
};

const tasks: ChatCompletionProvider = {
  id: 'tasks',
  trigger: '@',
  search: () => [
    { id: '42', type: 'task', label: 'Bericht schreiben' },
    { id: '42', type: 'user', label: 'Duplicate Alice' },
  ],
};

describe('createCompletionSearch', () => {
  it('merges providers of one trigger with stable keys and app ids', async () => {
    const search = createCompletionSearch([people, tasks]);
    expect(await search('al', '@')).toEqual([
      { id: '42', key: 'people:42', type: 'user', label: 'Alice Doe', description: 'match al' },
      { id: '43', key: 'people:43', type: 'user', label: 'Alex Roe' },
      { id: '42', key: 'tasks:42', type: 'task', label: 'Bericht schreiben' },
    ]);
    expect(await search('al', '/')).toEqual([]);
  });

  it('passes the permission context, limit and an abort signal', async () => {
    const search = vi.fn(() => []);
    await createCompletionSearch(
      [{ id: 'commands', trigger: '/', search }],
      { context: { roles: ['member'] }, limitPerProvider: 3 },
    )('nav', '/');
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'nav',
      trigger: '/',
      limit: 3,
      context: { roles: ['member'] },
      signal: expect.any(AbortSignal),
    }));
  });

  it('isolates failing and slow providers', async () => {
    vi.useFakeTimers();
    try {
      const onProviderError = vi.fn();
      const search = createCompletionSearch([
        { id: 'broken', trigger: '@', search: async () => { throw new Error('offline'); } },
        { id: 'slow', trigger: '@', search: () => new Promise(() => {}) },
        people,
      ], { timeoutMs: 50, onProviderError });
      const pending = search('al', '@');
      await vi.advanceTimersByTimeAsync(60);
      expect((await pending).map((result) => result.key)).toEqual(['people:42', 'people:43']);
      expect(onProviderError.mock.calls.map(([id]) => id)).toEqual(['broken', 'slow']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a superseded search and returns nothing for it', async () => {
    let firstSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const search = createCompletionSearch([{
      id: 'people',
      trigger: '@',
      search: async ({ query, signal }) => {
        if (query === 'a') {
          firstSignal = signal;
          await gate;
        }
        return [{ id: query, type: 'user', label: query }];
      },
    }]);
    const first = search('a', '@');
    const second = await search('al', '@');
    release();
    expect(await first).toEqual([]);
    expect(firstSignal?.aborted).toBe(true);
    expect(second.map((result) => result.id)).toEqual(['al']);
  });

  it('drops items that would break mention markers and rejects bad providers', async () => {
    const search = createCompletionSearch([{
      id: 'people',
      trigger: '@',
      search: () => [
        { id: 'a:b', type: 'user', label: 'Colon' },
        { id: 'ok', type: 'User Type', label: 'Bad type' },
        { id: 'x', type: 'user', label: '   ' },
        { id: 'fine', type: 'user', label: 'Fine' },
      ],
    }]);
    expect((await search('', '@')).map((result) => result.id)).toEqual(['fine']);
    expect(() => createCompletionSearch([people, people])).toThrow(/Duplicate/);
    expect(() => createCompletionSearch([{ ...people, id: 'Bad Id' }])).toThrow(/Invalid/);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/completions/__tests__/completion-search.test.ts`
Expected: FAIL, `../completion-search.js` cannot be resolved.

- [ ] **Step 3: Types**

In `src/react/types.ts` replace:

```ts
export interface MentionResult {
  id: string;
  type: string;
  label: string;
  description?: string;
  icon?: string;
}
```

with:

```ts
export interface MentionResult {
  id: string;
  type: string;
  label: string;
  description?: string;
  icon?: string;
  /** Stable list identity when several providers may return the same id. */
  key?: string;
  /** Token text after the trigger; defaults to a slug of `label`. */
  slug?: string;
}
```

Replace:

```ts
export interface MentionSerializationConfig {
```

with:

```ts
// ============================================================================
// Completion Providers ('/' commands and '@' mentions)
// ============================================================================

/**
 * What the app UI knows about the signed-in user. Providers use it to hide
 * entries; it never authorizes anything (the server and the app do).
 */
export interface CompletionPermissionContext {
  readonly roles?: ReadonlyArray<string>;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface CompletionItem {
  /** The app's own stable id; it reaches the model via the mention marker. */
  id: string;
  /** Mention type, e.g. `user`, `task`, `command`. */
  type: string;
  label: string;
  description?: string;
  slug?: string;
}

export interface CompletionSearchRequest {
  query: string;
  trigger: string;
  /** Aborted when a newer search starts; pass it to `fetch`. */
  signal: AbortSignal;
  context: CompletionPermissionContext;
  limit: number;
}

export interface ChatCompletionProvider {
  /** Stable, unique provider id (`[a-z0-9-]`, max 40). */
  id: string;
  trigger: '@' | '/';
  search(
    request: CompletionSearchRequest,
  ): Promise<ReadonlyArray<CompletionItem>> | ReadonlyArray<CompletionItem>;
}

export interface MentionSerializationConfig {
```

- [ ] **Step 4: Implementation**

Create `src/react/completions/completion-search.ts`:

```ts
import type {
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  MentionResult,
} from '../types.js';

export interface CompletionSearchOptions {
  /** Passed to every provider; it only hides entries, the server authorizes. */
  context?: CompletionPermissionContext;
  /** Per-provider cap (default 8, max 20). */
  limitPerProvider?: number;
  /** Overall cap across providers (default 12, max 50). */
  maxResults?: number;
  /** A provider slower than this contributes nothing (default 3000 ms). */
  timeoutMs?: number;
  onProviderError?: (providerId: string, error: unknown) => void;
}

/** Compatible with `RichMentionInput`'s `onSearch`. */
export type CompletionSearch = (query: string, trigger: string) => Promise<MentionResult[]>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function isItem(value: unknown): value is CompletionItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200
    && !/[:}]/.test(item.id)
    && typeof item.type === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(item.type)
    && typeof item.label === 'string' && item.label.trim().length > 0;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Completion provider timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Merges `/` and `@` providers into one async search. Item ids stay the
 * app's ids (they reach the model through mention markers); `key` is the
 * stable list identity `providerId:itemId`. A newer search aborts the older
 * one, and a failing or slow provider never empties the others.
 */
export function createCompletionSearch(
  providers: ReadonlyArray<ChatCompletionProvider>,
  options: CompletionSearchOptions = {},
): CompletionSearch {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!PROVIDER_ID.test(provider.id)) {
      throw new Error(`Invalid completion provider id: ${provider.id}`);
    }
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate completion provider id: ${provider.id}`);
    }
    ids.add(provider.id);
  }
  const limit = clamp(options.limitPerProvider, 8, 20);
  const maxResults = clamp(options.maxResults, 12, 50);
  const timeoutMs = clamp(options.timeoutMs, 3_000, 30_000);
  const context = Object.freeze({ ...(options.context ?? {}) });
  let current: AbortController | null = null;

  return async (query, trigger) => {
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const settled = await Promise.all(providers
      .filter((provider) => provider.trigger === trigger)
      .map(async (provider) => {
        try {
          const items = await withTimeout(Promise.resolve(provider.search({
            query, trigger, signal: controller.signal, context, limit,
          })), timeoutMs);
          return { provider, items: Array.isArray(items) ? items.slice(0, limit) : [] };
        } catch (error) {
          if (!controller.signal.aborted) options.onProviderError?.(provider.id, error);
          return { provider, items: [] };
        }
      }));
    if (controller.signal.aborted) return [];
    if (current === controller) current = null;

    const seen = new Set<string>();
    const results: MentionResult[] = [];
    for (const { provider, items } of settled) {
      for (const item of items) {
        if (!isItem(item)) continue;
        const identity = `${item.type}:${item.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        results.push({
          id: item.id,
          key: `${provider.id}:${item.id}`,
          type: item.type,
          label: item.label.trim(),
          ...(item.description ? { description: item.description } : {}),
          ...(item.slug ? { slug: item.slug } : {}),
        });
        if (results.length >= maxResults) return results;
      }
    }
    return results;
  };
}
```

In `src/react/index.ts` replace:

```ts
  // Mentions
  MentionResult,
  MentionData,
  MentionConfig,
  MentionSerializationConfig,
```

with:

```ts
  // Mentions
  MentionResult,
  MentionData,
  MentionConfig,
  MentionSerializationConfig,
  // Completion providers
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  CompletionSearchRequest,
```

Replace:

```ts
// Bridges
export {
```

with:

```ts
// Completion providers
export {
  createCompletionSearch,
  type CompletionSearch,
  type CompletionSearchOptions,
} from './completions/completion-search.js';

// Bridges
export {
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `bunx vitest run src/react/completions/__tests__/completion-search.test.ts && bun run typecheck && bun run typecheck:tests`
Expected: PASS, 5 tests; both typechecks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/react/completions/completion-search.ts src/react/types.ts src/react/index.ts src/react/completions/__tests__/completion-search.test.ts
git commit -m "feat(react): add a generic provider search for commands and mentions"
```

---

### Task 12: Built-in `/` command provider from catalog UI tools

**Files:**
- Create: `src/react/completions/ui-tool-command-provider.ts`
- Modify: `src/react/types.ts` (after `ChatCompletionProvider`)
- Modify: `src/react/index.ts`
- Test: `src/react/completions/__tests__/ui-tool-command-provider.test.ts`

**Interfaces:**
- Produces:
  - `export interface UiToolCommandSource { readonly definitionId: string; readonly label: string; readonly description?: string; readonly keywords?: ReadonlyArray<string>; readonly allowedRoles?: ReadonlyArray<string> }` (fed from the generated catalog's UI tools by the app)
  - `export function createUiToolCommandProvider(options: { tools: ReadonlyArray<UiToolCommandSource>; id?: string }): ChatCompletionProvider` — items `{ id: definitionId, type: 'command', label, description? }`

- [ ] **Step 1: Write the failing test**

Create `src/react/completions/__tests__/ui-tool-command-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createUiToolCommandProvider } from '../ui-tool-command-provider.js';

const provider = createUiToolCommandProvider({
  tools: [
    { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen', keywords: ['dashboard'] },
    { definitionId: 'ui.filter.doneTasks', label: 'Erledigte Aufgaben filtern' },
    { definitionId: 'ui.navigate.admin', label: 'Administration öffnen', allowedRoles: ['admin'] },
    { definitionId: 'ui.dialog.newTask', label: 'Neue Aufgabe', description: 'Dialog öffnen' },
  ],
});

const search = (query: string, roles: string[] = ['member'], limit = 8) =>
  provider.search({
    query,
    trigger: '/',
    signal: new AbortController().signal,
    context: { roles },
    limit,
  }) as ReadonlyArray<{ id: string; type: string; label: string }>;

describe('createUiToolCommandProvider', () => {
  it('offers UI tools as / commands with their definition ids', () => {
    expect(provider).toMatchObject({ id: 'ui-tools', trigger: '/' });
    expect(search('über')).toEqual([
      { id: 'ui.navigate.overview', type: 'command', label: 'Übersicht öffnen' },
    ]);
  });

  it('folds diacritics and ranks label prefixes before word and id matches', () => {
    expect(search('ub').map((item) => item.id)).toEqual(['ui.navigate.overview']);
    expect(search('offnen').map((item) => item.id)).toEqual(['ui.navigate.overview']);
    expect(search('dashboard').map((item) => item.id)).toEqual(['ui.navigate.overview']);
    expect(search('newtask').map((item) => item.id)).toEqual(['ui.dialog.newTask']);
  });

  it('hides role-restricted commands unless the context holds the role', () => {
    expect(search('').map((item) => item.id)).not.toContain('ui.navigate.admin');
    expect(search('admin', ['admin']).map((item) => item.id)).toEqual(['ui.navigate.admin']);
  });

  it('lists everything for an empty query, sorted and limited', () => {
    expect(search('', ['member'], 2).map((item) => item.label)).toEqual([
      'Erledigte Aufgaben filtern',
      'Neue Aufgabe',
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/completions/__tests__/ui-tool-command-provider.test.ts`
Expected: FAIL, `../ui-tool-command-provider.js` cannot be resolved.

- [ ] **Step 3: Type and implementation**

In `src/react/types.ts` replace:

```ts
  search(
    request: CompletionSearchRequest,
  ): Promise<ReadonlyArray<CompletionItem>> | ReadonlyArray<CompletionItem>;
}
```

with:

```ts
  search(
    request: CompletionSearchRequest,
  ): Promise<ReadonlyArray<CompletionItem>> | ReadonlyArray<CompletionItem>;
}

/** A catalog UI tool offered as a `/` command. */
export interface UiToolCommandSource {
  readonly definitionId: string;
  readonly label: string;
  readonly description?: string;
  readonly keywords?: ReadonlyArray<string>;
  /** Empty or omitted: visible to everyone. */
  readonly allowedRoles?: ReadonlyArray<string>;
}
```

Create `src/react/completions/ui-tool-command-provider.ts`:

```ts
import type {
  ChatCompletionProvider,
  CompletionItem,
  UiToolCommandSource,
} from '../types.js';

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();
}

function rank(tool: UiToolCommandSource, needle: string): number | undefined {
  if (!needle) return 0;
  const label = fold(tool.label);
  if (label.startsWith(needle)) return 0;
  if (label.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  if (fold(tool.definitionId).includes(needle)) return 3;
  if ((tool.keywords ?? []).some((keyword) => fold(keyword).includes(needle))) return 4;
  return undefined;
}

/**
 * Built-in `/` command provider over the catalog's UI tools (navigation,
 * filters, dialogs). Role filtering only hides commands; executing one still
 * goes through the model, the turn snapshot and the app's own checks.
 */
export function createUiToolCommandProvider(options: {
  tools: ReadonlyArray<UiToolCommandSource>;
  id?: string;
}): ChatCompletionProvider {
  const tools = options.tools.filter((tool) =>
    tool.definitionId.trim() && tool.label.trim());
  return {
    id: options.id ?? 'ui-tools',
    trigger: '/',
    search({ query, context, limit }) {
      const roles = new Set(context.roles ?? []);
      const needle = fold(query);
      return tools
        .filter((tool) => !tool.allowedRoles?.length
          || tool.allowedRoles.some((role) => roles.has(role)))
        .map((tool) => ({ tool, rank: rank(tool, needle) }))
        .filter((candidate): candidate is { tool: UiToolCommandSource; rank: number } =>
          candidate.rank !== undefined)
        .sort((left, right) =>
          left.rank - right.rank || left.tool.label.localeCompare(right.tool.label))
        .slice(0, limit)
        .map(({ tool }): CompletionItem => ({
          id: tool.definitionId,
          type: 'command',
          label: tool.label,
          ...(tool.description ? { description: tool.description } : {}),
        }));
    },
  };
}
```

In `src/react/index.ts` replace:

```ts
  CompletionSearchRequest,
```

with:

```ts
  CompletionSearchRequest,
  UiToolCommandSource,
```

and replace:

```ts
} from './completions/completion-search.js';
```

with:

```ts
} from './completions/completion-search.js';
export { createUiToolCommandProvider } from './completions/ui-tool-command-provider.js';
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/completions && bun run typecheck && bun run typecheck:tests`
Expected: PASS, 9 tests; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/react/completions/ui-tool-command-provider.ts src/react/types.ts src/react/index.ts src/react/completions/__tests__/ui-tool-command-provider.test.ts
git commit -m "feat(react): offer catalog ui tools as slash commands"
```

---

### Task 13: Composer with providers, keyboard selection and structured ids

**Files:**
- Modify: `src/react/types.ts` (`AiChatProviderConfig` line 525, `RichMentionInputProps.onSubmit` line 771)
- Modify: `src/react/provider/chat-context.ts` (import block lines 3-22, `send` line 55, mentions block lines 86-87)
- Modify: `src/react/provider/ai-chat-provider.tsx` (imports, props destructure line 350, before `// Refs for deduplication` line 463, `send` lines 810-830, context value lines 1246-1247 and deps line 1306)
- Modify: `src/react/components/ai-chat-panel.tsx` (lines 23-27, 48)
- Modify: `src/react/components/rich-mention-input.tsx` (`insertMention` slug line 327, `submit` lines 432-441, imperative `getMentions` line 735, deps line 744, dropdown key line 785)
- Modify: `src/react/components/mention-input.tsx` (lines 1-15: split into provider and legacy variants)
- Test: `src/react/components/__tests__/completion-composer.test.tsx`

**Interfaces:**
- Consumes: `createCompletionSearch`, `CompletionSearch` (Task 11), `createUiToolCommandProvider` (Task 12).
- Produces:
  - `AiChatProviderConfig.completionProviders?: ReadonlyArray<ChatCompletionProvider>`, `.completionContext?: CompletionPermissionContext`, `.onCompletionProviderError?: (providerId: string, error: unknown) => void`
  - `ChatContextValue.send: (message: string, options?: { mentions?: MentionData[] }) => void`; `ChatContextValue.completionSearch?: CompletionSearch`; `ChatContextValue.hasCompletions: boolean`
  - `RichMentionInputProps.onSubmit?: (message: string, mentions: MentionData[]) => void`; `RichMentionInputHandle.getMentions()` now also returns text-inserted commands still present.

- [ ] **Step 1: Write the failing test**

Create `src/react/components/__tests__/completion-composer.test.tsx`:

```tsx
// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionProvider, ChatTransport } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { createUiToolCommandProvider } from '../../completions/ui-tool-command-provider.js';
import { MentionInput } from '../mention-input.js';

function transport(): ChatTransport {
  return {
    messages: [],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const people: ChatCompletionProvider = {
  id: 'people',
  trigger: '@',
  search: ({ context }) => (context.roles?.includes('member')
    ? [{ id: '42', type: 'user', label: 'Alice Doe' }]
    : []),
};

function Composer({ chat }: { chat: ChatTransport }) {
  const providers = useMemo(() => [
    createUiToolCommandProvider({ tools: [
      { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen' },
      { definitionId: 'ui.filter.done', label: 'Erledigte filtern' },
    ] }),
    people,
  ], []);
  const context = useMemo(() => ({ roles: ['member'] }), []);
  return (
    <AiChatProvider transport={chat} completionProviders={providers} completionContext={context}>
      <MentionInput />
    </AiChatProvider>
  );
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

describe('composer with completion providers', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(async () => {
    // insertMention restores the caret in a rAF; flush it before unmounting.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    cleanup();
  });

  it('selects a / command by keyboard and sends its stable definition id', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '/er');
    await waitFor(() => expect(screen.getByText('Erledigte filtern')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.textContent).toBe('/erledigte-filtern '));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '{{mention:command:ui.filter.done:Erledigte filtern}}',
    }));
  });

  it('navigates @ results with arrow keys and keeps the user id', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Frag @al');
    await waitFor(() => expect(screen.getByText('Alice Doe')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Tab' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="42"]')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: 'Frag {{mention:user:42:Alice Doe}}',
    }));
  });

  it('closes the list with Escape without sending', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });
    typeInto(editor, '/ub');
    await waitFor(() => expect(screen.getByText('Übersicht öffnen')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(document.querySelector('[data-component="mention-dropdown"]')).toBeNull();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/components/__tests__/completion-composer.test.tsx`
Expected: FAIL: `getByRole('textbox')` finds the plain editor but no dropdown ever appears (`completionProviders` is ignored).

- [ ] **Step 3: Public types**

In `src/react/types.ts` replace:

```ts
export interface AiChatProviderConfig {
  mentions?: MentionConfig;
```

with:

```ts
export interface AiChatProviderConfig {
  mentions?: MentionConfig;
  /**
   * Generic `/` and `@` providers. Memoize the array: a new identity
   * rebuilds the search. When set, the composer uses provider search with
   * keyboard navigation and keeps structured ids on send.
   */
  completionProviders?: ReadonlyArray<ChatCompletionProvider>;
  completionContext?: CompletionPermissionContext;
  onCompletionProviderError?: (providerId: string, error: unknown) => void;
```

Replace (inside `RichMentionInputProps`):

```ts
  onChange?: (nextValue: string) => void;
  onSubmit?: (message: string) => void;
  /** Search callback for mention autocomplete (BYOS).
```

with:

```ts
  onChange?: (nextValue: string) => void;
  /** Receives the text and the structured mentions (chips and commands) still in it. */
  onSubmit?: (message: string, mentions: MentionData[]) => void;
  /** Search callback for mention autocomplete (BYOS).
```

- [ ] **Step 4: Chat context**

In `src/react/provider/chat-context.ts` replace:

```ts
  SessionSummary,
} from '../types.js';
```

with:

```ts
  SessionSummary,
} from '../types.js';
import type { CompletionSearch } from '../completions/completion-search.js';
```

Replace:

```ts
  send: (message: string) => void;
```

with:

```ts
  /** `mentions` replaces the provider's active mentions for this message. */
  send: (message: string, options?: { mentions?: MentionData[] }) => void;
```

Replace:

```ts
  isMentionSearching: boolean;
  hasMentions: boolean;
```

with:

```ts
  isMentionSearching: boolean;
  hasMentions: boolean;

  // Completion providers
  completionSearch?: CompletionSearch;
  hasCompletions: boolean;
```

- [ ] **Step 5: Provider**

In `src/react/provider/ai-chat-provider.tsx` replace:

```ts
import { findOpenClarification } from '../utils/clarification.js';
```

with:

```ts
import { findOpenClarification } from '../utils/clarification.js';
import { createCompletionSearch } from '../completions/completion-search.js';
```

Replace (props destructure):

```ts
  transport,
  mentions,
  toolResults: userToolResults,
```

with:

```ts
  transport,
  mentions,
  completionProviders,
  completionContext,
  onCompletionProviderError,
  toolResults: userToolResults,
```

Replace:

```ts
  // Refs for deduplication
  const processedToolCallsRef
```

with:

```ts
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
  const processedToolCallsRef
```

Replace:

```ts
  const send = useCallback(async (message: string) => {
```

with:

```ts
  const send = useCallback(async (
    message: string,
    sendOptions?: { mentions?: MentionData[] },
  ) => {
    const mentionsForSend = sendOptions?.mentions ?? activeMentions;
```

Replace:

```ts
      processedMessage = serializeMentionsForSend(
        processedMessage,
        activeMentions,
        mentionSerializeConfig,
      );
    }
    if (onBeforeSend) {
      processedMessage = onBeforeSend(processedMessage, activeMentions);
    }
```

with:

```ts
      processedMessage = serializeMentionsForSend(
        processedMessage,
        mentionsForSend,
        mentionSerializeConfig,
      );
    }
    if (onBeforeSend) {
      processedMessage = onBeforeSend(processedMessage, mentionsForSend);
    }
```

Replace (context value):

```ts
      isMentionSearching,
      hasMentions: !!mentions,
      suggestionChips,
```

with:

```ts
      isMentionSearching,
      hasMentions: !!mentions,
      completionSearch,
      hasCompletions: completionSearch !== undefined,
      suggestionChips,
```

Replace (dependency list):

```ts
      isMentionSearching,
      suggestionChips,
      selectSuggestion,
```

with:

```ts
      isMentionSearching,
      completionSearch,
      suggestionChips,
      selectSuggestion,
```

- [ ] **Step 6: Panel picks the mention composer**

In `src/react/components/ai-chat-panel.tsx` replace:

```ts
    classNames,
    hasMentions,
    locale,
```

with:

```ts
    classNames,
    hasMentions,
    hasCompletions,
    locale,
```

Replace:

```ts
  const InputComponent = components.ChatInput ?? (hasMentions ? MentionInput : ChatInput);
```

with:

```ts
  const InputComponent = components.ChatInput
    ?? (hasMentions || hasCompletions ? MentionInput : ChatInput);
```

- [ ] **Step 7: `RichMentionInput` keeps ids for commands and lists**

In `src/react/components/rich-mention-input.tsx` replace:

```ts
        const prefix = inferMentionPrefix(result.type);
        const slug = normalizeMentionSlug(result.label);
```

with:

```ts
        const prefix = inferMentionPrefix(result.type);
        const slug = typeof result.slug === 'string' && result.slug.trim().length > 0
          ? normalizeMentionSlug(result.slug)
          : normalizeMentionSlug(result.label);
```

Replace:

```ts
    const submit = useCallback(() => {
      if (disabled) return;

      const text = hasMentionSupport
        ? getFullValue()
        : normalizeInputValue((editableRef.current?.innerText ?? '').trim());

      if (!text) return;

      onSubmit?.(text);
```

with:

```ts
    /** Chips in the DOM plus text-inserted commands whose token is still present. */
    const collectMentions = useCallback((text: string): MentionData[] => {
      if (!hasMentionSupport) return [];
      const tokens = new Set(text.split(/\s+/));
      const commands = mentions.filter((mention) =>
        mention.type === 'command'
        && typeof mention.prefix === 'string'
        && typeof mention.slug === 'string'
        && tokens.has(`${mention.prefix}${mention.slug}`));
      return [...getMentionsFromDOM(), ...commands];
    }, [hasMentionSupport, mentions, getMentionsFromDOM]);

    const submit = useCallback(() => {
      if (disabled) return;

      const text = hasMentionSupport
        ? getFullValue()
        : normalizeInputValue((editableRef.current?.innerText ?? '').trim());

      if (!text) return;

      onSubmit?.(text, collectMentions(text));
```

Replace:

```ts
    }, [disabled, hasMentionSupport, getFullValue, onSubmit, setValue]);
```

with:

```ts
    }, [disabled, hasMentionSupport, getFullValue, onSubmit, setValue, collectMentions]);
```

Replace:

```ts
        getMentions: () => (hasMentionSupport ? getMentionsFromDOM() : []),
```

with:

```ts
        getMentions: () => (hasMentionSupport ? collectMentions(getFullValue()) : []),
```

Replace:

```ts
      [hasMentionSupport, setValue, getFullValue, getMentionsFromDOM, createChipElement, closeDropdown],
```

with:

```ts
      [hasMentionSupport, setValue, getFullValue, collectMentions, createChipElement, closeDropdown],
```

Replace:

```tsx
            {searchResults.map((result, index) => (
              <DropdownItem
                key={result.id}
```

with:

```tsx
            {searchResults.map((result, index) => (
              <DropdownItem
                key={result.key ?? `${result.type}:${result.id}`}
```

- [ ] **Step 8: `MentionInput` provider mode (legacy mode unchanged)**

In `src/react/components/mention-input.tsx` replace:

```tsx
import { useState, useRef, useCallback, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import { useChatContext } from '../provider/chat-context.js';
import { inferMentionPrefix, normalizeMentionSlug } from '../utils/mention-markup.js';
import type { MentionInputProps, RichMentionInputHandle } from '../types.js';

/**
 * Chat input with mention autocomplete support.
 *
 * Uses `RichMentionInput` for editing, provides autocomplete for `@` and `/`,
 * and keeps selected mentions in provider state for serialization on send.
 */
export function MentionInput({ className, onSubmit }: MentionInputProps) {
```

with:

```tsx
import { useState, useRef, useCallback, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import { useChatContext } from '../provider/chat-context.js';
import { inferMentionPrefix, normalizeMentionSlug } from '../utils/mention-markup.js';
import type {
  MentionData,
  MentionInputProps,
  RichMentionInputHandle,
} from '../types.js';

/**
 * Chat input with `@` mention and `/` command autocomplete.
 *
 * With `completionProviders` the editor searches the providers directly
 * (debounced, arrow keys, Tab/Enter, Escape) and submits structured ids.
 * Without them the legacy `mentions` flow is unchanged.
 */
export function MentionInput(props: MentionInputProps) {
  const { completionSearch } = useChatContext();
  return completionSearch
    ? <ProviderMentionInput {...props} />
    : <LegacyMentionInput {...props} />;
}

function ProviderMentionInput({ className, onSubmit }: MentionInputProps) {
  const {
    send,
    stop,
    isLoading,
    classNames,
    locale,
    components,
    completionSearch,
    voice,
  } = useChatContext();
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;

  const submit = useCallback((text: string, mentions: MentionData[]) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return false;
    if (onSubmit) {
      onSubmit(trimmed);
    } else {
      send(trimmed, { mentions });
    }
    setValue('');
    return true;
  }, [isLoading, onSubmit, send]);

  return (
    <div data-component="mention-input" data-mode="providers">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const handle = inputRef.current;
          if (handle && submit(handle.getValue(), handle.getMentions())) handle.clear();
        }}
        className={className ?? classNames.input}
      >
        <RichMentionInput
          ref={inputRef}
          onChange={setValue}
          onSubmit={(text, mentions) => { submit(text, mentions); }}
          onSearch={completionSearch}
          placeholder={locale.placeholder}
          disabled={isLoading}
        />
        {voice.enabled && (
          <VoiceInputAddon
            disabled={isLoading}
            language={voice.language ?? 'de'}
            baseUrl={voice.baseUrl}
            getToken={voice.getToken}
            onTranscript={(text) => {
              const handle = inputRef.current;
              if (!handle) return;
              const current = handle.getValue();
              handle.setValue(current ? `${current} ${text}` : text, handle.getMentions());
            }}
            onError={voice.onError}
            showRecordingBar={voice.recordingBar?.enabled ?? true}
            recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
          />
        )}
        {InputExtra && <InputExtra />}
        {isLoading ? (
          <button type="button" onClick={stop} data-action="stop">
            {locale.stopButton}
          </button>
        ) : (
          <button type="submit" disabled={!value.trim()} data-action="send">
            {locale.sendButton}
          </button>
        )}
      </form>
    </div>
  );
}

function LegacyMentionInput({ className, onSubmit }: MentionInputProps) {
```

- [ ] **Step 9: Run the React suite and typecheck**

Run: `bunx vitest run src/react && bun run typecheck && bun run typecheck:tests`
Expected: PASS (3 new composer tests; `mention-draft.test.tsx` unchanged and green); both typechecks exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/react/types.ts src/react/provider/chat-context.ts src/react/provider/ai-chat-provider.tsx src/react/components/ai-chat-panel.tsx src/react/components/rich-mention-input.tsx src/react/components/mention-input.tsx src/react/components/__tests__/completion-composer.test.tsx
git commit -m "feat(react): wire command and mention providers into the composer"
```

---

### Task 14: Versioned tool result renderer registry

**Files:**
- Create: `src/react/tool-renderers/registry.ts`
- Create: `src/react/tool-renderers/renderer-boundary.tsx`
- Test: `src/react/tool-renderers/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `SchemaLike` from `src/types.ts`.
- Produces:
  - `export interface ToolResultRendererProps<TOutput = unknown> { definitionId: string; toolName: string; schemaVersion: number; output: TOutput }`
  - `export interface ToolResultRenderer<TOutput = unknown> { definitionId: string; schemaVersion: number; outputSchema: SchemaLike<TOutput>; component: ComponentType<ToolResultRendererProps<TOutput>> }`
  - `export type AnyToolResultRenderer = ToolResultRenderer<any>`
  - `export interface ResolvedToolResultRenderer { renderer: AnyToolResultRenderer; output: unknown }`
  - `export interface ToolResultRendererRegistry { readonly size: number; resolve(toolName: string, output: unknown): ResolvedToolResultRenderer | undefined }`
  - `export function defineToolResultRenderer<TOutput>(renderer: ToolResultRenderer<TOutput>): ToolResultRenderer<TOutput>`
  - `export function createToolResultRendererRegistry(renderers: ReadonlyArray<AnyToolResultRenderer>): ToolResultRendererRegistry`
  - `export class RendererBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `src/react/tool-renderers/__tests__/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createToolResultRendererRegistry,
  defineToolResultRenderer,
} from '../registry.js';

const V1 = defineToolResultRenderer({
  definitionId: 'tasks.listTasks',
  schemaVersion: 1,
  outputSchema: z.object({ success: z.literal(true), data: z.array(z.string()) }),
  component: () => null,
});

const V2 = defineToolResultRenderer({
  definitionId: 'tasks.listTasks',
  schemaVersion: 2,
  outputSchema: z.object({
    success: z.literal(true),
    data: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  component: () => null,
});

describe('createToolResultRendererRegistry', () => {
  const registry = createToolResultRendererRegistry([V1, V2]);

  it('matches the model-facing and the definition name', () => {
    const output = { success: true, data: [{ id: '1', title: 'Bericht' }] };
    expect(registry.resolve('tasks_listTasks', output)?.renderer).toBe(V2);
    expect(registry.resolve('tasks.listTasks', output)?.renderer).toBe(V2);
    expect(registry.size).toBe(2);
  });

  it('falls back to an older version for an old stored message', () => {
    expect(registry.resolve('tasks_listTasks', { success: true, data: ['Bericht'] }))
      .toEqual({ renderer: V1, output: { success: true, data: ['Bericht'] } });
  });

  it('returns nothing for unknown tools, failed results or throwing schemas', () => {
    expect(registry.resolve('tasks_createTask', { success: true })).toBeUndefined();
    expect(registry.resolve('tasks_listTasks', { success: false, error: 'x' })).toBeUndefined();
    const throwing = createToolResultRendererRegistry([{
      ...V1,
      outputSchema: { safeParse: () => { throw new Error('boom'); } },
    }]);
    expect(throwing.resolve('tasks_listTasks', {})).toBeUndefined();
  });

  it('rejects duplicate versions and invalid metadata', () => {
    expect(() => createToolResultRendererRegistry([V1, V1])).toThrow(/Duplicate/);
    expect(() => createToolResultRendererRegistry([{ ...V1, schemaVersion: 0 }])).toThrow(/schemaVersion/);
    expect(() => createToolResultRendererRegistry([{ ...V1, definitionId: 'a b' }])).toThrow(/definitionId/);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/tool-renderers/__tests__/registry.test.ts`
Expected: FAIL, `../registry.js` cannot be resolved.

- [ ] **Step 3: Implement the registry and the boundary**

Create `src/react/tool-renderers/registry.ts`:

```ts
import type { ComponentType } from 'react';
import type { SchemaLike } from '../../types.js';

export interface ToolResultRendererProps<TOutput = unknown> {
  definitionId: string;
  /** Model-facing tool name as stored in the message. */
  toolName: string;
  schemaVersion: number;
  output: TOutput;
}

/**
 * A local, compact result component for one tool. `outputSchema` guards the
 * stored output: messages written by an older tool version fall back to an
 * older renderer version or the default block instead of crashing.
 */
export interface ToolResultRenderer<TOutput = unknown> {
  definitionId: string;
  schemaVersion: number;
  outputSchema: SchemaLike<TOutput>;
  component: ComponentType<ToolResultRendererProps<TOutput>>;
}

// Renderers are invariant in their output type; the registry erases it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolResultRenderer = ToolResultRenderer<any>;

export interface ResolvedToolResultRenderer {
  renderer: AnyToolResultRenderer;
  output: unknown;
}

export interface ToolResultRendererRegistry {
  readonly size: number;
  resolve(toolName: string, output: unknown): ResolvedToolResultRenderer | undefined;
}

const DEFINITION_ID = /^[A-Za-z0-9_.-]{1,200}$/;

export function defineToolResultRenderer<TOutput>(
  renderer: ToolResultRenderer<TOutput>,
): ToolResultRenderer<TOutput> {
  return renderer;
}

function modelFacingName(definitionId: string): string {
  return definitionId.replace(/\./g, '_');
}

export function createToolResultRendererRegistry(
  renderers: ReadonlyArray<AnyToolResultRenderer>,
): ToolResultRendererRegistry {
  const byName = new Map<string, AnyToolResultRenderer[]>();
  const seen = new Set<string>();
  for (const renderer of renderers) {
    if (!DEFINITION_ID.test(renderer.definitionId)) {
      throw new Error(`Invalid renderer definitionId: ${renderer.definitionId}`);
    }
    if (!Number.isInteger(renderer.schemaVersion) || renderer.schemaVersion < 1) {
      throw new Error(`Renderer ${renderer.definitionId} needs a positive integer schemaVersion`);
    }
    const identity = `${renderer.definitionId}@${renderer.schemaVersion}`;
    if (seen.has(identity)) throw new Error(`Duplicate renderer: ${identity}`);
    seen.add(identity);
    for (const name of new Set([renderer.definitionId, modelFacingName(renderer.definitionId)])) {
      const list = byName.get(name) ?? [];
      list.push(renderer);
      list.sort((left, right) => right.schemaVersion - left.schemaVersion);
      byName.set(name, list);
    }
  }

  return Object.freeze({
    size: seen.size,
    resolve(toolName: string, output: unknown) {
      for (const renderer of byName.get(toolName) ?? []) {
        let parsed: ReturnType<AnyToolResultRenderer['outputSchema']['safeParse']>;
        try {
          parsed = renderer.outputSchema.safeParse(output);
        } catch {
          continue;
        }
        if (parsed.success) return { renderer, output: parsed.data };
      }
      return undefined;
    },
  });
}
```

Create `src/react/tool-renderers/renderer-boundary.tsx`:

```tsx
import { Component, type ReactNode } from 'react';

interface RendererBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

/** A failing custom renderer degrades to the default tool result block. */
export class RendererBoundary extends Component<RendererBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/tool-renderers/__tests__/registry.test.ts && bun run typecheck && bun run typecheck:tests`
Expected: PASS, 4 tests; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/react/tool-renderers/registry.ts src/react/tool-renderers/renderer-boundary.tsx src/react/tool-renderers/__tests__/registry.test.ts
git commit -m "feat(react): add a versioned tool result renderer registry"
```

---

### Task 15: Custom result components in the message list

**Files:**
- Modify: `src/react/types.ts` (imports; `AiChatProviderConfig`)
- Modify: `src/react/provider/chat-context.ts`
- Modify: `src/react/provider/ai-chat-provider.tsx` (props destructure, after `toolResultConfig` line 385-388, context value line 1212 and its dependency entry)
- Modify: `src/react/components/message-bubble.tsx`
- Modify: `src/react/index.ts`
- Test: `src/react/components/__tests__/tool-renderers.test.tsx`

**Interfaces:**
- Consumes: `createToolResultRendererRegistry`, `RendererBoundary`, `AnyToolResultRenderer` (Task 14).
- Produces: `AiChatProviderConfig.toolRenderers?: ReadonlyArray<AnyToolResultRenderer>`; `ChatContextValue.toolRendererRegistry?: ToolResultRendererRegistry`; exports `createToolResultRendererRegistry`, `defineToolResultRenderer` and types from `glirastes/react`.

- [ ] **Step 1: Write the failing test**

Create `src/react/components/__tests__/tool-renderers.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage, ChatTransport } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import {
  defineToolResultRenderer,
  type AnyToolResultRenderer,
} from '../../tool-renderers/registry.js';
import { MessageList } from '../message-list.js';

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function toolMessage(id: string, output: unknown): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'tool-tasks_listTasks', toolCallId: `call-${id}`, state: 'output-available', output }],
  } as unknown as ChatMessage;
}

const taskList = defineToolResultRenderer({
  definitionId: 'tasks.listTasks',
  schemaVersion: 2,
  outputSchema: z.object({
    success: z.literal(true),
    data: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  component: ({ output }) => (
    <ul aria-label="Aufgaben">
      {output.data.map((task) => <li key={task.id}>{task.title}</li>)}
    </ul>
  ),
});

function renderWith(messages: ChatMessage[], renderers: AnyToolResultRenderer[]) {
  return render(
    <AiChatProvider transport={transport(messages)} toolRenderers={renderers}>
      <MessageList />
    </AiChatProvider>,
  );
}

describe('custom tool result renderers', () => {
  afterEach(cleanup);

  it('renders a registered compact component with its definition and version', () => {
    renderWith(
      [toolMessage('m1', { success: true, data: [{ id: '1', title: 'Bericht schreiben' }] })],
      [taskList],
    );
    expect(screen.getByRole('list', { name: 'Aufgaben' }).textContent).toBe('Bericht schreiben');
    const block = document.querySelector('[data-renderer="tasks.listTasks"]');
    expect(block?.getAttribute('data-schema-version')).toBe('2');
  });

  it('uses the default block for an old message that no version accepts', () => {
    renderWith([toolMessage('m1', { success: true, data: ['nur Titel'] })], [taskList]);
    expect(screen.queryByRole('list', { name: 'Aufgaben' })).toBeNull();
    expect(document.querySelector('[data-component="tool-result"] summary')?.textContent)
      .toBe('tasks_listTasks');
  });

  it('degrades to the default block when the custom renderer throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWith(
        [toolMessage('m1', { success: true, data: [{ id: '1', title: 'x' }] })],
        [{ ...taskList, component: () => { throw new Error('render bug'); } }],
      );
      expect(document.querySelector('[data-component="tool-result"] summary')?.textContent)
        .toBe('tasks_listTasks');
    } finally {
      consoleError.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/components/__tests__/tool-renderers.test.tsx`
Expected: FAIL in the first test only: no list named "Aufgaben" (renderers are ignored). The two fallback tests already pass because nothing uses a custom renderer yet; after Step 4 they pin that an unmatched old output and a throwing renderer both end in the default block.

- [ ] **Step 3: Configuration and context**

In `src/react/types.ts` replace:

```ts
import type { ClarificationRequest } from '../contracts/clarification.js';
```

with:

```ts
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';
```

Replace:

```ts
export interface AiChatProviderConfig {
  mentions?: MentionConfig;
```

with:

```ts
export interface AiChatProviderConfig {
  mentions?: MentionConfig;
  /**
   * Local compact result components per tool `definitionId` and schema
   * version. Memoize the array. Unknown tools, outputs that fail every
   * version's schema, and throwing renderers use the default block.
   */
  toolRenderers?: ReadonlyArray<AnyToolResultRenderer>;
```

In `src/react/provider/chat-context.ts` replace:

```ts
import type { CompletionSearch } from '../completions/completion-search.js';
```

with:

```ts
import type { CompletionSearch } from '../completions/completion-search.js';
import type { ToolResultRendererRegistry } from '../tool-renderers/registry.js';
```

Replace:

```ts
  toolResults: ToolResultDisplayConfig;
  voice: VoiceInputConfig;
```

with:

```ts
  toolResults: ToolResultDisplayConfig;
  /** Custom result components; absent when none are configured. */
  toolRendererRegistry?: ToolResultRendererRegistry;
  voice: VoiceInputConfig;
```

In `src/react/provider/ai-chat-provider.tsx` replace:

```ts
import { createCompletionSearch } from '../completions/completion-search.js';
```

with:

```ts
import { createCompletionSearch } from '../completions/completion-search.js';
import { createToolResultRendererRegistry } from '../tool-renderers/registry.js';
```

Replace:

```ts
  completionProviders,
  completionContext,
  onCompletionProviderError,
  toolResults: userToolResults,
```

with:

```ts
  completionProviders,
  completionContext,
  onCompletionProviderError,
  toolRenderers,
  toolResults: userToolResults,
```

Replace:

```ts
  const toolResultConfig = useMemo(
    () => ({ mode: 'default' as const, allowlist: [], ...userToolResults }),
    [userToolResults],
  );
```

with:

```ts
  const toolResultConfig = useMemo(
    () => ({ mode: 'default' as const, allowlist: [], ...userToolResults }),
    [userToolResults],
  );
  const toolRendererRegistry = useMemo(
    () => (toolRenderers && toolRenderers.length > 0
      ? createToolResultRendererRegistry(toolRenderers)
      : undefined),
    [toolRenderers],
  );
```

Replace:

```ts
      toolLabels,
      toolResults: toolResultConfig,
      voice: voiceConfig,
      mentionConfig: mentions,
```

with:

```ts
      toolLabels,
      toolResults: toolResultConfig,
      toolRendererRegistry,
      voice: voiceConfig,
      mentionConfig: mentions,
```

Replace:

```ts
      toolLabels,
      toolResultConfig,
      voiceConfig,
```

with:

```ts
      toolLabels,
      toolResultConfig,
      toolRendererRegistry,
      voiceConfig,
```

- [ ] **Step 4: Render through the registry in `MessageBubble`**

In `src/react/components/message-bubble.tsx` replace:

```ts
import { ClarificationCard as DefaultClarificationCard } from './clarification-card.js';
```

with:

```ts
import { ClarificationCard as DefaultClarificationCard } from './clarification-card.js';
import { RendererBoundary } from '../tool-renderers/renderer-boundary.js';
```

Replace:

```ts
    toolResults,
    messages,
    send,
    isLoading,
  } = useChatContext();
```

with:

```ts
    toolResults,
    toolRendererRegistry,
    messages,
    send,
    isLoading,
  } = useChatContext();
```

Replace:

```ts
  const isLatestMessage = messages?.[messages.length - 1]?.id === message.id;
```

with:

```tsx
  const isLatestMessage = messages?.[messages.length - 1]?.id === message.id;

  const renderToolResult = (key: string, toolName: string, result: unknown) => {
    const fallback = <ToolResultComponent key={key} toolName={toolName} result={result} />;
    const resolved = toolRendererRegistry?.resolve(toolName, result);
    if (!resolved) return fallback;
    const Renderer = resolved.renderer.component;
    return (
      <RendererBoundary
        key={key}
        fallback={<ToolResultComponent toolName={toolName} result={result} />}
      >
        <div
          data-component="tool-result"
          data-tool={toolName}
          data-renderer={resolved.renderer.definitionId}
          data-schema-version={resolved.renderer.schemaVersion}
        >
          <Renderer
            definitionId={resolved.renderer.definitionId}
            toolName={toolName}
            schemaVersion={resolved.renderer.schemaVersion}
            output={resolved.output}
          />
        </div>
      </RendererBoundary>
    );
  };
```

Replace:

```tsx
          if (!shouldRenderToolResult(part.toolName, mode, allowlist)) return null;
          return (
            <ToolResultComponent
              key={`tool-${i}`}
              toolName={part.toolName}
              result={part.result}
            />
          );
```

with:

```tsx
          if (!shouldRenderToolResult(part.toolName, mode, allowlist)) return null;
          return renderToolResult(`tool-${i}`, part.toolName, part.result);
```

Replace:

```tsx
            if (!shouldRenderToolResult(toolName, mode, allowlist)) return null;
            return (
              <ToolResultComponent
                key={`tool-${i}`}
                toolName={toolName}
                result={part.output}
              />
            );
```

with:

```tsx
            if (!shouldRenderToolResult(toolName, mode, allowlist)) return null;
            return renderToolResult(`tool-${i}`, toolName, part.output);
```

In `src/react/index.ts` replace:

```ts
// Completion providers
export {
  createCompletionSearch,
```

with:

```ts
// Tool result renderers
export {
  createToolResultRendererRegistry,
  defineToolResultRenderer,
  type AnyToolResultRenderer,
  type ResolvedToolResultRenderer,
  type ToolResultRenderer,
  type ToolResultRendererProps,
  type ToolResultRendererRegistry,
} from './tool-renderers/registry.js';

// Completion providers
export {
  createCompletionSearch,
```

- [ ] **Step 5: Run the React suite**

Run: `bunx vitest run src/react && bun run typecheck && bun run typecheck:tests`
Expected: PASS (3 new tests; hidden/allowlist cases in `message-bubble.test.tsx` still pass because visibility is checked before rendering); both typechecks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/react/types.ts src/react/provider/chat-context.ts src/react/provider/ai-chat-provider.tsx src/react/components/message-bubble.tsx src/react/index.ts src/react/components/__tests__/tool-renderers.test.tsx
git commit -m "feat(react): render tool results through local versioned components"
```

---

### Task 16: Styles for provider composer, clarification and voice controls

**Files:**
- Modify: `src/react/styles.css` (insert directly before the block comment `/* ===...` "Drop-in defaults for the floating trigger button and chat window." around line 385)
- Test: `src/react/__tests__/composer-styles.test.ts`

**Interfaces:** Produces CSS rules for `[data-component="rich-mention-input"]`, its `mention-dropdown`, `mention-dropdown-item`, `clarification-card`, `voice-input-addon`, `[data-action="retry-recording"]`, `recording-bar`.

- [ ] **Step 1: Write the failing test**

Create `src/react/__tests__/composer-styles.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('shipped styles for the new chat surfaces', () => {
  it('anchors the / and @ list to the provider editor and keeps it on screen', () => {
    const dropdown = rule(
      '[data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-component="mention-dropdown"]',
    );
    expect(dropdown).toContain('position: absolute');
    expect(dropdown).toContain('max-height: min(40vh, 16rem)');
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"][data-selected="true"]'))
      .toContain('background: var(--cm-primary-tint)');
  });

  it('wraps clarification options instead of overflowing narrow screens', () => {
    expect(rule('[data-component="clarification-card"] [data-element="options"]'))
      .toContain('flex-wrap: wrap');
    expect(rule('[data-component="clarification-card"] [data-element="free-text"] input'))
      .toContain('min-width: 0');
  });

  it('keeps push-to-talk holds from scrolling or opening touch menus', () => {
    const mic = rule('[data-component="ai-chat-panel"] [data-action="retry-recording"]');
    expect(mic).toContain('touch-action: none');
    expect(mic).toContain('-webkit-touch-callout: none');
    expect(rule('[data-component="ai-chat-panel"] [data-component="recording-bar"]'))
      .toContain('min-width: 0');
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/__tests__/composer-styles.test.ts`
Expected: FAIL with `missing rule for [data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-component="mention-dropdown"]`.

- [ ] **Step 3: Add the CSS**

In `src/react/styles.css` insert the following block immediately before the line `/* ===========================================================================` that opens the "Drop-in defaults for the floating trigger button and chat window." comment:

```css
/* ---------- Provider composer, '/' and '@' list ---------- */
[data-component="ai-chat-panel"] [data-component="rich-mention-input"] {
  position: relative;
  flex: 1;
  min-width: 0;
}
[data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-element="editor"] {
  box-sizing: border-box;
  min-height: 40px;
  max-height: 160px;
  overflow-y: auto;
  overflow-wrap: anywhere;
  padding: 0.5rem 0.75rem;
  background: var(--cm-bg-muted);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  color: var(--cm-text);
  outline: none;
}
[data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-element="editor"]:focus {
  border-color: var(--cm-primary);
  box-shadow: 0 0 0 3px var(--cm-primary-ring);
}
[data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-element="placeholder"] {
  position: absolute;
  top: 0.5rem;
  left: 0.75rem;
  color: var(--cm-text-muted);
  pointer-events: none;
}
[data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-component="mention-dropdown"] {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 0.25rem);
  z-index: 20;
  display: flex;
  flex-direction: column;
  max-height: min(40vh, 16rem);
  overflow-y: auto;
  background: var(--cm-bg);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"] {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: transparent;
  border: none;
  color: var(--cm-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"][data-selected="true"] {
  background: var(--cm-primary-tint);
}
[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"] [data-element="description"] {
  font-size: 12px;
  color: var(--cm-text-muted);
}

/* ---------- Structured clarification ---------- */
[data-component="ai-chat-panel"] [data-component="clarification-card"] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 100%;
  margin: 0.375rem 0;
  padding: 0.75rem;
  background: var(--cm-bg);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
}
[data-component="clarification-card"] [data-element="question"] {
  margin: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
[data-component="clarification-card"] [data-element="options"] {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}
[data-component="clarification-card"] [data-action="answer-option"] {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 100%;
  padding: 0.375rem 0.75rem;
  background: var(--cm-bg-muted);
  border: 1px solid var(--cm-border);
  border-radius: 9999px;
  color: var(--cm-text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
[data-component="clarification-card"] [data-action="answer-option"]:disabled {
  opacity: 0.6;
  cursor: default;
}
[data-component="clarification-card"] [data-element="description"] {
  font-size: 11px;
  color: var(--cm-text-muted);
}
[data-component="clarification-card"] [data-element="free-text"] {
  display: flex;
  gap: 0.375rem;
}
[data-component="clarification-card"] [data-element="free-text"] input {
  flex: 1;
  min-width: 0;
  padding: 0.375rem 0.625rem;
  background: var(--cm-bg-muted);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  color: var(--cm-text);
  font: inherit;
}
[data-component="clarification-card"] [data-action="answer-free-text"] {
  padding: 0.375rem 0.75rem;
  background: var(--cm-primary);
  border: none;
  border-radius: var(--cm-radius-sm);
  color: #fff;
  font: inherit;
  cursor: pointer;
}
[data-component="clarification-card"] [data-action="answer-free-text"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- Voice: mic, push-to-talk, retry, recording bar ---------- */
[data-component="ai-chat-panel"] [data-component="voice-input-addon"],
[data-component="ai-chat-panel"] [data-action="retry-recording"] {
  flex-shrink: 0;
  min-width: 40px;
  min-height: 40px;
  padding: 0 0.625rem;
  background: var(--cm-bg-muted);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  color: var(--cm-text);
  font: inherit;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
[data-component="ai-chat-panel"] [data-component="voice-input-addon"][data-state="recording"] {
  border-color: var(--cm-danger);
  color: var(--cm-danger);
}
[data-component="ai-chat-panel"] [data-component="recording-bar"] {
  min-width: 0;
}

```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/__tests__/composer-styles.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/react/styles.css src/react/__tests__/composer-styles.test.ts
git commit -m "feat(react): style provider composer, clarification and voice controls"
```

---

### Task 17: `themeScope` lets host stylesheets own theme variables

**Files:**
- Modify: `src/react/types.ts` (`AiChatProviderConfig.theme`, line 554)
- Modify: `src/react/provider/ai-chat-provider.tsx` (props line 358, `themeVars` lines 374-377)
- Test: `src/react/provider/__tests__/theme-scope.test.tsx`

**Interfaces:**
- Produces: `AiChatProviderConfig.themeScope?: 'inline' | 'inherit'` (default `'inline'`; `'inherit'` yields empty `themeVars`).

- [ ] **Step 1: Write the failing test**

Create `src/react/provider/__tests__/theme-scope.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTransport } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';

const transport: ChatTransport = {
  messages: [], status: 'ready', error: null,
  sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
  addToolApprovalResponse: vi.fn(async () => {}),
};

const panelStyle = () =>
  document.querySelector('[data-component="ai-chat-panel"]')?.getAttribute('style') ?? '';

describe('themeScope', () => {
  afterEach(cleanup);

  it('writes inline theme variables by default', () => {
    render(<AiChatProvider transport={transport} theme="professional-dark"><AiChatPanel /></AiChatProvider>);
    expect(panelStyle()).toContain('--cm-primary');
  });

  it('leaves variables to stylesheets and host CSS when inherit is chosen', () => {
    render(
      <AiChatProvider transport={transport} theme="professional-dark" themeScope="inherit">
        <AiChatPanel />
      </AiChatProvider>,
    );
    expect(panelStyle()).not.toContain('--cm-');
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/provider/__tests__/theme-scope.test.tsx`
Expected: FAIL in the second test (style still contains `--cm-primary`).

- [ ] **Step 3: Implement**

In `src/react/types.ts` replace:

```ts
  theme?: ChatTheme;
  onToolResult?: OnToolResult;
```

with:

```ts
  theme?: ChatTheme;
  /**
   * `inline` (default) writes the theme as inline `--cm-*` variables on
   * widget roots. `inherit` leaves them to stylesheets and host variables;
   * `<glirastes-chat>` uses it so page CSS can theme the shadow root.
   */
  themeScope?: 'inline' | 'inherit';
  onToolResult?: OnToolResult;
```

In `src/react/provider/ai-chat-provider.tsx` replace:

```ts
  theme: userTheme,
  onToolResult,
```

with:

```ts
  theme: userTheme,
  themeScope = 'inline',
  onToolResult,
```

Replace:

```ts
  const themeVars = useMemo<CSSProperties>(
    () => getThemeVars(userTheme) as CSSProperties,
    [userTheme],
  );
```

with:

```ts
  const themeVars = useMemo<CSSProperties>(
    () => (themeScope === 'inherit' ? {} : getThemeVars(userTheme)) as CSSProperties,
    [userTheme, themeScope],
  );
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/provider && bun run typecheck && bun run typecheck:tests`
Expected: PASS; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/react/types.ts src/react/provider/ai-chat-provider.tsx src/react/provider/__tests__/theme-scope.test.tsx
git commit -m "feat(react): let host stylesheets own chat theme variables"
```

---

### Task 18: Interim transcript in the recording bar

**Files:**
- Modify: `src/react/components/recording-bar.tsx` (`RecordingBarInner` lines 21-53)
- Modify: `src/react/types.ts` (`RecordingBarProps.transcript` doc, lines 131-132)
- Modify: `src/react/components/__tests__/ui-components.test.tsx` (test at lines 133-152 changes its expectation: interim text now appears in the bar, still not in the editor)

**Interfaces:**
- Produces: `RecordingBarProps.transcript?: string` is rendered as `[data-part="interim-transcript"]` (`aria-live="polite"`, newest 80 characters, full text in `title`).

- [ ] **Step 1: Change the test to the FR-5 behavior**

In `src/react/components/__tests__/ui-components.test.tsx` replace the whole test:

```tsx
  it('replaces the full input width with a waveform while recording', () => {
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript="Interim text stays out of the editor"
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const bar = document.querySelector<HTMLElement>(
      '[data-component="recording-bar"]',
    );
    expect(bar?.style.width).toBe('100%');
    expect(document.querySelector('[data-element="waveform"]')).toBeTruthy();
    expect(screen.queryByText('Interim text stays out of the editor'))
      .toBeNull();
  });
```

with:

```tsx
  it('replaces the full input width with a waveform and the live transcript while recording', () => {
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript="Interim text stays out of the editor"
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const bar = document.querySelector<HTMLElement>(
      '[data-component="recording-bar"]',
    );
    expect(bar?.style.width).toBe('100%');
    expect(document.querySelector('[data-element="waveform"]')).toBeTruthy();
    const interim = document.querySelector('[data-part="interim-transcript"]');
    expect(interim?.textContent).toBe('Interim text stays out of the editor');
    expect(interim?.getAttribute('aria-live')).toBe('polite');
  });

  it('shows only the newest words of a long interim transcript', () => {
    const long = `${'alt '.repeat(40)}neueste Worte`;
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript={long}
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const interim = document.querySelector('[data-part="interim-transcript"]')!;
    expect(interim.textContent!.length).toBe(80);
    expect(interim.textContent!.startsWith('…')).toBe(true);
    expect(interim.textContent!.endsWith('neueste Worte')).toBe(true);
    expect(interim.getAttribute('title')).toBe(long.trim());
  });
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/components/__tests__/ui-components.test.tsx`
Expected: FAIL: `interim` is `null` in both recording-bar tests.

- [ ] **Step 3: Render the transcript**

In `src/react/components/recording-bar.tsx` replace:

```tsx
function RecordingBarInner({
  isConnecting,
  stream,
  onCancel,
  onStop,
  variant,
  className,
}: RecordingBarProps) {
```

with:

```tsx
const MAX_VISIBLE_TRANSCRIPT = 80;

/** Shows the newest words; the full text stays available as a tooltip. */
function InterimTranscript({ text }: { text?: string }) {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return null;
  const visible = trimmed.length > MAX_VISIBLE_TRANSCRIPT
    ? `…${trimmed.slice(-(MAX_VISIBLE_TRANSCRIPT - 1))}`
    : trimmed;
  return (
    <span
      data-part="interim-transcript"
      aria-live="polite"
      title={trimmed}
      style={{
        flex: '2 1 0',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '0.8125rem',
        opacity: 0.85,
      }}
    >
      {visible}
    </span>
  );
}

function RecordingBarInner({
  isConnecting,
  stream,
  transcript,
  onCancel,
  onStop,
  variant,
  className,
}: RecordingBarProps) {
```

Replace:

```tsx
        {isConnecting ? <LoadingDots /> : <StreamWaveform stream={stream} />}
      </div>
```

with:

```tsx
        {isConnecting ? <LoadingDots /> : <StreamWaveform stream={stream} />}
      </div>

      <InterimTranscript text={transcript} />
```

In `src/react/types.ts` replace:

```ts
  /** @deprecated Interim text is intentionally not rendered while recording. */
  transcript?: string;
```

with:

```ts
  /**
   * Live final plus interim transcript shown next to the waveform. It is
   * never written into the editor before Stop.
   */
  transcript?: string;
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/components && bun run typecheck && bun run typecheck:tests`
Expected: PASS; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/react/components/recording-bar.tsx src/react/types.ts src/react/components/__tests__/ui-components.test.tsx
git commit -m "feat(stt): show the interim transcript in the recording bar"
```

---

### Task 19: Hold-to-talk hotkey hook

**Files:**
- Create: `src/react/hooks/use-push-to-talk-hotkey.ts`
- Modify: `src/react/index.ts` (after `export { useKeyboardShortcut } ...`)
- Test: `src/react/hooks/__tests__/use-push-to-talk-hotkey.test.tsx`

**Interfaces:**
- Produces:
  - `export const DEFAULT_PUSH_TO_TALK_HOTKEY = 'mod+shift+space'`
  - `export function parseHoldCombo(combo: string): { key: string; mod: boolean; shift: boolean; alt: boolean } | null`
  - `export function usePushToTalkHotkey(options: { hotkey: string | false | undefined; enabled: boolean; onPress: () => void; onRelease: () => void }): void`

- [ ] **Step 1: Write the failing test**

Create `src/react/hooks/__tests__/use-push-to-talk-hotkey.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  parseHoldCombo,
  usePushToTalkHotkey,
} from '../use-push-to-talk-hotkey.js';

const space = { key: ' ', code: 'Space' };

function setup(hotkey: string | false = DEFAULT_PUSH_TO_TALK_HOTKEY, enabled = true) {
  const onPress = vi.fn();
  const onRelease = vi.fn();
  const hook = renderHook(
    (props: { enabled: boolean }) => usePushToTalkHotkey({ hotkey, enabled: props.enabled, onPress, onRelease }),
    { initialProps: { enabled } },
  );
  return { onPress, onRelease, ...hook };
}

describe('usePushToTalkHotkey', () => {
  afterEach(cleanup);

  it('parses hold combos including space', () => {
    expect(parseHoldCombo('mod+shift+space')).toEqual({ key: 'space', mod: true, shift: true, alt: false });
    expect(parseHoldCombo('alt+m')).toEqual({ key: 'm', mod: false, shift: false, alt: true });
    expect(parseHoldCombo('shift')).toBeNull();
  });

  it('presses once on keydown, ignores repeats and releases on keyup', () => {
    const { onPress, onRelease } = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true, repeat: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { ...space, ctrlKey: true, shiftKey: true });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('ends the hold when a modifier is released first (macOS swallows keyup under ⌘)', () => {
    const { onRelease } = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    fireEvent.keyUp(window, { key: 'Shift', ctrlKey: true });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('ends the hold on window blur and on unmount', () => {
    const blurred = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    fireEvent.blur(window);
    expect(blurred.onRelease).toHaveBeenCalledTimes(1);
    blurred.unmount();

    const unmounted = setup();
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    unmounted.unmount();
    expect(unmounted.onRelease).toHaveBeenCalledTimes(1);
  });

  it('ignores other combos and stays inactive when disabled or false', () => {
    const plain = setup();
    fireEvent.keyDown(window, { ...space });
    fireEvent.keyDown(window, { ...space, ctrlKey: true });
    expect(plain.onPress).not.toHaveBeenCalled();
    plain.unmount();

    const disabled = setup(DEFAULT_PUSH_TO_TALK_HOTKEY, false);
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    expect(disabled.onPress).not.toHaveBeenCalled();
    disabled.unmount();

    const off = setup(false);
    fireEvent.keyDown(window, { ...space, ctrlKey: true, shiftKey: true });
    expect(off.onPress).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/react/hooks/__tests__/use-push-to-talk-hotkey.test.tsx`
Expected: FAIL, `../use-push-to-talk-hotkey.js` cannot be resolved.

- [ ] **Step 3: Implement the hook**

Create `src/react/hooks/use-push-to-talk-hotkey.ts`:

```ts
import { useEffect, useRef } from 'react';

/** Hold to talk; `mod` is ⌘ on macOS and Ctrl elsewhere. */
export const DEFAULT_PUSH_TO_TALK_HOTKEY = 'mod+shift+space';

interface HoldCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

export function parseHoldCombo(combo: string): HoldCombo | null {
  const parts = combo.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  const result: HoldCombo = { key: '', mod: false, shift: false, alt: false };
  for (const part of parts) {
    if (['mod', 'cmd', 'ctrl', 'meta', 'control'].includes(part)) result.mod = true;
    else if (part === 'shift') result.shift = true;
    else if (['alt', 'option', 'opt'].includes(part)) result.alt = true;
    else result.key = part;
  }
  return result.key ? result : null;
}

function keyName(event: KeyboardEvent): string {
  return event.key === ' ' || event.code === 'Space' ? 'space' : event.key.toLowerCase();
}

/**
 * Calls `onPress` when the combo goes down and `onRelease` when any key of
 * it is released, the window blurs or the hook unmounts. macOS does not
 * deliver keyup for other keys while ⌘ is held, so releasing ⌘ also ends
 * the hold. Fires inside text fields: the combo always has a modifier or is
 * explicitly chosen by the app.
 */
export function usePushToTalkHotkey(options: {
  hotkey: string | false | undefined;
  enabled: boolean;
  onPress: () => void;
  onRelease: () => void;
}): void {
  const pressRef = useRef(options.onPress);
  pressRef.current = options.onPress;
  const releaseRef = useRef(options.onRelease);
  releaseRef.current = options.onRelease;

  useEffect(() => {
    if (!options.enabled || !options.hotkey) return;
    const combo = parseHoldCombo(options.hotkey);
    if (!combo) return;
    let holding = false;

    const matches = (event: KeyboardEvent) =>
      keyName(event) === combo.key
      && (isMac() ? event.metaKey : event.ctrlKey) === combo.mod
      && event.shiftKey === combo.shift
      && event.altKey === combo.alt;

    const end = () => {
      if (!holding) return;
      holding = false;
      releaseRef.current();
    };
    const down = (event: KeyboardEvent) => {
      if (holding) {
        if (keyName(event) === combo.key) event.preventDefault();
        return;
      }
      if (event.repeat || !matches(event)) return;
      event.preventDefault();
      holding = true;
      pressRef.current();
    };
    const up = (event: KeyboardEvent) => {
      if (!holding) return;
      const name = keyName(event);
      if (
        name === combo.key
        || (combo.mod && (name === 'meta' || name === 'control'))
        || (combo.shift && name === 'shift')
        || (combo.alt && name === 'alt')
      ) {
        event.preventDefault();
        end();
      }
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', end);
      end();
    };
  }, [options.enabled, options.hotkey]);
}
```

In `src/react/index.ts` replace:

```ts
export { useKeyboardShortcut } from './hooks/use-keyboard-shortcut.js';
```

with:

```ts
export { useKeyboardShortcut } from './hooks/use-keyboard-shortcut.js';
export {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  usePushToTalkHotkey,
} from './hooks/use-push-to-talk-hotkey.js';
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/react/hooks/__tests__/use-push-to-talk-hotkey.test.tsx && bun run typecheck && bun run typecheck:tests`
Expected: PASS, 5 tests; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/react/hooks/use-push-to-talk-hotkey.ts src/react/index.ts src/react/hooks/__tests__/use-push-to-talk-hotkey.test.tsx
git commit -m "feat(stt): add a hold-to-talk hotkey hook"
```

---

### Task 20: Push-to-talk, retry and lifecycle-safe voice input

**Files:**
- Modify: `src/react/components/voice-input-addon.tsx` (replace the whole file; keeps the existing `mic`/`stop` button names and the coalesced `stopAndSubmit`)
- Modify: `src/react/types.ts` (`VoiceInputConfig` lines 364-375; `ChatLocale` clarification block from Task 9)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`DEFAULT_LOCALE`)
- Modify: `src/react/components/chat-input.tsx` (lines 89-100)
- Modify: `src/react/components/mention-input.tsx` (both `VoiceInputAddon` usages)
- Modify: `src/react/index.ts`
- Test: `src/react/components/__tests__/voice-push-to-talk.test.tsx`, `src/react/components/__tests__/voice-draft.test.tsx`; existing `voice-window-lifecycle.test.tsx` stays green unchanged.

**Interfaces:**
- Consumes: `useStt` (`src/react/stt/use-stt.ts`), `DeepgramSttAdapter`, `SttProviderAdapter`, `usePushToTalkHotkey` (Task 19), `ChatContext` (`activeSessionId`, `locale`), `ChatWindowVisibilityContext`.
- Produces:
  - `export interface VoicePushToTalkConfig { hotkey?: string | false; holdThresholdMs?: number }`
  - `VoiceInputConfig.adapter?: SttProviderAdapter`, `VoiceInputConfig.pushToTalk?: VoicePushToTalkConfig | false`, `VoiceInputConfig.routeKey?: string`
  - `ChatLocale.retryRecordingAriaLabel: string`
  - `VoiceInputAddon` props add `adapter?`, `pushToTalk?`, `routeKey?`, `now?: () => number` (internal component).

- [ ] **Step 1: Write the failing tests**

Create `src/react/components/__tests__/voice-push-to-talk.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { VoiceInputAddon } from '../voice-input-addon.js';

let stopTrack = vi.fn();
let getUserMedia = vi.fn();

function fakeAdapter(options: { failFirst?: boolean } = {}): SttProviderAdapter {
  let connects = 0;
  return {
    connect: vi.fn(async ({ events }) => {
      connects += 1;
      if (options.failFirst && connects === 1) throw new Error('fixture provider unavailable');
      events.onSegment({ id: 's1', sequence: 1, text: 'hallo wel', isFinal: false });
      return {
        finalize: async () => {
          events.onSegment({ id: 's1', sequence: 1, text: 'Hallo Welt', isFinal: true });
        },
        cancel: async () => {},
        close: async () => {},
      };
    }),
  };
}

const mic = () => screen.getByRole('button', { name: /^(mic|stop)$/ });
const state = () => document.querySelector('[data-component="voice-input-addon"]')?.getAttribute('data-state');

beforeEach(() => {
  stopTrack = vi.fn();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('push-to-talk and interim transcript', () => {
  it('records while the button is held and inserts the final text on release', async () => {
    let clock = 0;
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} now={() => clock} />);

    fireEvent.pointerDown(mic(), { button: 0 });
    await waitFor(() => expect(state()).toBe('recording'));
    expect(document.querySelector('[data-part="interim-transcript"]')?.textContent).toBe('hallo wel');
    expect(received).not.toHaveBeenCalled();

    clock = 500;
    fireEvent.pointerUp(window);
    fireEvent.click(mic());
    await waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    expect(stopTrack).toHaveBeenCalled();
    expect(state()).toBe('idle');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps recording after a short tap and stops on the next click (toggle)', async () => {
    let clock = 0;
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} now={() => clock} />);

    fireEvent.pointerDown(mic(), { button: 0 });
    clock = 120;
    fireEvent.pointerUp(window);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    expect(received).not.toHaveBeenCalled();

    fireEvent.click(mic());
    await waitFor(() => expect(received).toHaveBeenCalledWith('Hallo Welt'));
  });

  it('records while the hotkey is held', async () => {
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={received} />);

    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(state()).toBe('recording'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, repeat: true });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith('Hallo Welt'));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('can turn push-to-talk off and keep toggle only', async () => {
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()}
      onTranscript={vi.fn()} pushToTalk={false} />);
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    fireEvent.pointerDown(mic(), { button: 0 });
    await act(async () => {});
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
  });
});

describe('recording lifecycle boundaries', () => {
  it('stops on a route change and keeps the speech as draft', async () => {
    const received = vi.fn();
    const adapter = fakeAdapter();
    const view = (route: string) => <VoiceInputAddon disabled={false} language="de"
      adapter={adapter} onTranscript={received} routeKey={route} />;
    const { rerender } = render(view('/tasks'));
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    rerender(view('/reports'));
    await waitFor(() => expect(received).toHaveBeenCalledWith('Hallo Welt'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('stops on browser back/forward navigation', async () => {
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()} onTranscript={vi.fn()} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });

  it('stops when the chat session switches', async () => {
    const received = vi.fn();
    const adapter = fakeAdapter();
    const view = (activeSessionId: string) => (
      <ChatContext.Provider value={{ activeSessionId, locale: {} } as unknown as ChatContextValue}>
        <VoiceInputAddon disabled={false} language="de" adapter={adapter} onTranscript={received} />
      </ChatContext.Provider>
    );
    const { rerender } = render(view('a'));
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    rerender(view('b'));
    await waitFor(() => expect(received).toHaveBeenCalledWith('Hallo Welt'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('offers an explicit retry after a provider failure', async () => {
    const onError = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter({ failFirst: true })}
      onTranscript={vi.fn()} onError={onError} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('failed'));
    expect(onError).toHaveBeenCalledWith('fixture provider unavailable');
    expect(stopTrack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry recording' }));
    await waitFor(() => expect(state()).toBe('recording'));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('cancels without inserting text and releases the microphone', async () => {
    const received = vi.fn();
    render(<VoiceInputAddon disabled={false} language="de" adapter={fakeAdapter()} onTranscript={received} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    fireEvent.click(document.querySelector('[data-element="cancel-button"]')!);
    await waitFor(() => expect(state()).toBe('idle'));
    expect(stopTrack).toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });

  it('releases the microphone on unmount', async () => {
    const { unmount } = render(<VoiceInputAddon disabled={false} language="de"
      adapter={fakeAdapter()} onTranscript={vi.fn()} />);
    fireEvent.click(mic());
    await waitFor(() => expect(state()).toBe('recording'));
    unmount();
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });
});
```

Create `src/react/components/__tests__/voice-draft.test.tsx`:

```tsx
// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import type { ChatTransport } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { ChatInput } from '../chat-input.js';

const adapter: SttProviderAdapter = {
  connect: async ({ events }) => ({
    finalize: async () => {
      events.onSegment({ id: 's1', sequence: 1, text: 'Neue Aufgabe für morgen', isFinal: true });
    },
    cancel: async () => {},
    close: async () => {},
  }),
};

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Composer({ chat }: { chat: ChatTransport }) {
  const voice = useMemo(() => ({ enabled: true, adapter }), []);
  return (
    <AiChatProvider transport={chat} voice={voice}>
      <ChatInput />
    </AiChatProvider>
  );
}

describe('speech into the draft', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
  });
  afterEach(cleanup);

  it('never sends on finalization and sends the edited draft only on Enter', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Bitte:' } });

    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));

    await waitFor(() => expect(editor.value).toBe('Bitte: Neue Aufgabe für morgen'));
    expect(chat.sendMessage).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: 'Bitte: Neue Aufgabe für Freitag' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledExactlyOnceWith({
      text: 'Bitte: Neue Aufgabe für Freitag',
    }));
  });
});
```

- [ ] **Step 2: Run them and confirm the failure**

Run: `bunx vitest run src/react/components/__tests__/voice-push-to-talk.test.tsx src/react/components/__tests__/voice-draft.test.tsx`
Expected: FAIL: the `adapter` prop is ignored (the Deepgram adapter tries a WebSocket under jsdom), so no test reaches `recording`.

- [ ] **Step 3: Public types and locale**

In `src/react/types.ts` replace:

```ts
export interface VoiceInputConfig {
  enabled?: boolean;
  language?: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
```

with:

```ts
export interface VoicePushToTalkConfig {
  /**
   * Hold this combo to talk; `mod` is ⌘ on macOS and Ctrl elsewhere.
   * Default `mod+shift+space`. `false` disables only the hotkey.
   */
  hotkey?: string | false;
  /**
   * Holding the mic button at least this long (default 350 ms) stops on
   * release; a shorter tap toggles recording on.
   */
  holdThresholdMs?: number;
}

export interface VoiceInputConfig {
  enabled?: boolean;
  language?: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  /**
   * Speech provider adapter; defaults to the Deepgram speech-stream adapter.
   * Keep its identity stable: a new adapter restarts the controller.
   */
  adapter?: import('./stt/controller.js').SttProviderAdapter;
  /** Push-to-talk in addition to tap-to-toggle; `false` keeps toggle only. */
  pushToTalk?: VoicePushToTalkConfig | false;
  /**
   * Pass the current route (e.g. `usePathname()`); a change stops recording
   * and keeps the speech as editable draft. Back/forward is detected too.
   */
  routeKey?: string;
```

Replace:

```ts
  // Structured clarification
  clarificationInputLabel: string;
  clarificationSubmitButton: string;
}
```

with:

```ts
  // Structured clarification
  clarificationInputLabel: string;
  clarificationSubmitButton: string;

  // Speech-to-text
  retryRecordingAriaLabel: string;
}
```

In `src/react/provider/ai-chat-provider.tsx` replace:

```ts
  clarificationInputLabel: 'Your answer',
  clarificationSubmitButton: 'Answer',
};
```

with:

```ts
  clarificationInputLabel: 'Your answer',
  clarificationSubmitButton: 'Answer',
  retryRecordingAriaLabel: 'Retry recording',
};
```

In `src/react/index.ts` replace:

```ts
  VoiceInputConfig,
  // Mention chips
```

with:

```ts
  VoiceInputConfig,
  VoicePushToTalkConfig,
  // Mention chips
```

- [ ] **Step 4: Replace `VoiceInputAddon`**

Replace the entire content of `src/react/components/voice-input-addon.tsx` with:

```tsx
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { DeepgramSttAdapter } from '../stt/deepgram.js';
import type { SttProviderAdapter } from '../stt/controller.js';
import { useStt } from '../stt/use-stt.js';
import { ChatContext } from '../provider/chat-context.js';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  usePushToTalkHotkey,
} from '../hooks/use-push-to-talk-hotkey.js';
import type { VoicePushToTalkConfig } from '../types.js';
import { RecordingBar } from './recording-bar.js';
import { ChatWindowVisibilityContext } from './chat-window-visibility.js';

const DEFAULT_HOLD_THRESHOLD_MS = 350;

interface VoiceInputAddonProps {
  disabled: boolean;
  language: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  /** Speech provider; defaults to the Deepgram speech-stream adapter. */
  adapter?: SttProviderAdapter;
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  showRecordingBar?: boolean;
  recordingBarVariant?: 'trigger' | 'inline';
  /** Hold the button or hotkey to talk; false keeps tap-to-toggle only. */
  pushToTalk?: VoicePushToTalkConfig | false;
  /** A changed value (e.g. the pathname) stops and keeps speech as draft. */
  routeKey?: string;
  /** Clock for hold detection; tests inject a fake one. */
  now?: () => number;
}

/**
 * The composer's single STT controller and microphone stream. Stop inserts
 * the transcript into the draft for editing; nothing is sent automatically.
 * Hide, route change, session switch and unmount release the microphone.
 */
export function VoiceInputAddon({
  disabled,
  language,
  baseUrl,
  getToken,
  adapter,
  onTranscript,
  onError,
  showRecordingBar = true,
  recordingBarVariant = 'inline',
  pushToTalk,
  routeKey,
  now = Date.now,
}: VoiceInputAddonProps) {
  const visible = useContext(ChatWindowVisibilityContext);
  const chat = useContext(ChatContext);
  const transcriptCallback = useRef(onTranscript);
  transcriptCallback.current = onTranscript;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const pendingStop = useRef<Promise<void> | null>(null);

  const resolvedAdapter = useMemo<SttProviderAdapter>(
    () => adapter ?? new DeepgramSttAdapter({
      baseUrl,
      getToken: () => getTokenRef.current?.(),
    }),
    [adapter, baseUrl],
  );
  const {
    phase,
    isRecording,
    isConnecting,
    displayTranscript,
    stream,
    startRecording,
    stopRecording,
    cancelRecording,
    retry,
  } = useStt({ adapter: resolvedAdapter, language, onError });
  const active = isRecording || isConnecting;
  const activeRef = useRef(active);
  activeRef.current = active;

  // Multiple controls and a visibility change may stop the same recording.
  // The controller coalesces cleanup; this boundary also inserts text once.
  const stopAndSubmit = useCallback(() => {
    if (pendingStop.current) return pendingStop.current;
    const pending = Promise.resolve().then(async () => {
      const transcript = (await stopRecording()).trim();
      if (transcript.length > 0) transcriptCallback.current(transcript);
    }).catch(() => {
      // The shared controller has already reported the provider error through
      // onError and released its resources. No unhandled event promise.
    }).finally(() => { if (pendingStop.current === pending) pendingStop.current = null; });
    pendingStop.current = pending;
    return pending;
  }, [stopRecording]);
  const stopAndSubmitRef = useRef(stopAndSubmit);
  stopAndSubmitRef.current = stopAndSubmit;

  const start = useCallback(() => {
    // Failures surface through onError and the failed phase (retry button).
    void startRecording().catch(() => {});
  }, [startRecording]);

  useEffect(() => {
    if (!visible && active) void stopAndSubmit();
  }, [visible, active, stopAndSubmit]);

  // Route and session changes end the recording; the speech stays as draft.
  const routeRef = useRef(routeKey);
  useEffect(() => {
    if (routeRef.current === routeKey) return;
    routeRef.current = routeKey;
    if (activeRef.current) void stopAndSubmitRef.current();
  }, [routeKey]);
  const sessionId = chat?.activeSessionId;
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    if (activeRef.current) void stopAndSubmitRef.current();
  }, [sessionId]);
  useEffect(() => {
    const onHistory = () => {
      if (activeRef.current) void stopAndSubmitRef.current();
    };
    window.addEventListener('popstate', onHistory);
    window.addEventListener('hashchange', onHistory);
    return () => {
      window.removeEventListener('popstate', onHistory);
      window.removeEventListener('hashchange', onHistory);
    };
  }, []);

  // Push-to-talk: a hold of at least the threshold stops on release; a
  // shorter tap keeps recording (toggle). Keyboard activation toggles.
  const pushToTalkEnabled = pushToTalk !== false;
  const holdThresholdMs = (pushToTalk === false ? undefined : pushToTalk?.holdThresholdMs)
    ?? DEFAULT_HOLD_THRESHOLD_MS;
  const pressStartedAt = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const hotkeyHeld = useRef(false);

  const release = useCallback(() => {
    const startedAt = pressStartedAt.current;
    pressStartedAt.current = null;
    if (startedAt !== null && now() - startedAt >= holdThresholdMs) {
      void stopAndSubmitRef.current();
    }
  }, [now, holdThresholdMs]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!pushToTalkEnabled || disabled || activeRef.current) return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    pressStartedAt.current = now();
    suppressClick.current = true;
    window.addEventListener('pointerup', release, { once: true });
    window.addEventListener('pointercancel', release, { once: true });
    start();
  };

  useEffect(() => () => {
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  }, [release]);

  const handleClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (isRecording) {
      void stopAndSubmit();
      return;
    }
    if (!isConnecting) start();
  };

  usePushToTalkHotkey({
    hotkey: pushToTalk === false
      ? false
      : pushToTalk?.hotkey ?? DEFAULT_PUSH_TO_TALK_HOTKEY,
    enabled: pushToTalkEnabled && visible && !disabled,
    onPress: () => {
      if (activeRef.current) return;
      hotkeyHeld.current = true;
      start();
    },
    onRelease: () => {
      if (!hotkeyHeld.current) return;
      hotkeyHeld.current = false;
      void stopAndSubmitRef.current();
    },
  });

  const state = phase === 'failed'
    ? 'failed'
    : isConnecting
      ? 'connecting'
      : isRecording
        ? 'recording'
        : 'idle';

  return (
    <>
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        disabled={disabled}
        aria-busy={isConnecting}
        data-component="voice-input-addon"
        data-state={state}
      >
        {isRecording ? 'stop' : 'mic'}
      </button>

      {phase === 'failed' && (
        <button
          type="button"
          onClick={() => { void retry().catch(() => {}); }}
          disabled={disabled}
          aria-label={chat?.locale.retryRecordingAriaLabel ?? 'Retry recording'}
          data-action="retry-recording"
        >
          retry
        </button>
      )}

      {showRecordingBar && active && (
        <RecordingBar
          isConnecting={isConnecting}
          stream={stream}
          transcript={displayTranscript}
          onCancel={() => { void cancelRecording().catch(() => {}); }}
          onStop={() => { void stopAndSubmit(); }}
          variant={recordingBarVariant}
        />
      )}
    </>
  );
}
```

- [ ] **Step 5: Pass the new voice options from every composer**

In `src/react/components/chat-input.tsx` replace:

```tsx
          onError={voice.onError}
          showRecordingBar={voice.recordingBar?.enabled ?? true}
          recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
        />
```

with:

```tsx
          onError={voice.onError}
          showRecordingBar={voice.recordingBar?.enabled ?? true}
          recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
          adapter={voice.adapter}
          pushToTalk={voice.pushToTalk}
          routeKey={voice.routeKey}
        />
```

In `src/react/components/mention-input.tsx` replace both occurrences (provider and legacy variant; use replace-all) of:

```tsx
            onError={voice.onError}
            showRecordingBar={voice.recordingBar?.enabled ?? true}
            recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
          />
```

with:

```tsx
            onError={voice.onError}
            showRecordingBar={voice.recordingBar?.enabled ?? true}
            recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
            adapter={voice.adapter}
            pushToTalk={voice.pushToTalk}
            routeKey={voice.routeKey}
          />
```

- [ ] **Step 6: Run the React and STT suites**

Run: `bunx vitest run src/react && bun run typecheck && bun run typecheck:tests`
Expected: PASS: 10 push-to-talk/lifecycle tests, 1 draft test, `voice-window-lifecycle.test.tsx` (3 cases, Deepgram module mocked) and `stt/__tests__/controller.test.ts` unchanged; both typechecks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/react/components/voice-input-addon.tsx src/react/types.ts src/react/provider/ai-chat-provider.tsx src/react/components/chat-input.tsx src/react/components/mention-input.tsx src/react/index.ts src/react/components/__tests__/voice-push-to-talk.test.tsx src/react/components/__tests__/voice-draft.test.tsx
git commit -m "feat(stt): add push-to-talk and stop on route or session change"
```

---

### Task 21: Inline the chat CSS for shadow roots

**Files:**
- Create: `scripts/generate-embed-styles.mjs`
- Create (generated, committed): `src/embed/chat-styles.generated.ts`
- Test: `src/embed/__tests__/chat-styles.test.ts`

**Interfaces:**
- Consumes: `src/react/styles.css` (after Task 16).
- Produces: `export const CHAT_STYLES: string` (byte-identical copy of `styles.css`); `node scripts/generate-embed-styles.mjs [--check]` (exit 1 with a hint when stale).

- [ ] **Step 1: Write the failing test**

Create `src/embed/__tests__/chat-styles.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAT_STYLES } from '../chat-styles.generated.js';

describe('inlined shadow-root styles', () => {
  it('match src/react/styles.css byte for byte', () => {
    const css = readFileSync(new URL('../../react/styles.css', import.meta.url), 'utf8');
    expect(CHAT_STYLES).toBe(css);
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/embed/__tests__/chat-styles.test.ts`
Expected: FAIL, `../chat-styles.generated.js` cannot be resolved.

- [ ] **Step 3: Add the generator and generate the module**

Create `scripts/generate-embed-styles.mjs`:

```js
// Inlines src/react/styles.css into the <glirastes-chat> shadow root module.
// A shadow root cannot see document stylesheets, so the custom element ships
// the same CSS as a string. `--check` fails when the generated file is stale.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'src/react/styles.css');
const TARGET = join(ROOT, 'src/embed/chat-styles.generated.ts');

const css = readFileSync(SOURCE, 'utf8');
const generated = '// Generated by scripts/generate-embed-styles.mjs from src/react/styles.css.\n'
  + '// Do not edit by hand.\n'
  + `export const CHAT_STYLES = ${JSON.stringify(css)};\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    current = '';
  }
  if (current !== generated) {
    console.error('src/embed/chat-styles.generated.ts is stale. Run: node scripts/generate-embed-styles.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(TARGET, generated);
  console.log('Generated src/embed/chat-styles.generated.ts');
}
```

Run:

```bash
mkdir -p src/embed
node scripts/generate-embed-styles.mjs
node scripts/generate-embed-styles.mjs --check && echo fresh
```

Expected: `Generated src/embed/chat-styles.generated.ts`, then `fresh`. The file starts with the two comment lines and `export const CHAT_STYLES = "/* glirastes — default chat panel styles.\n`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/embed/__tests__/chat-styles.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-embed-styles.mjs src/embed/chat-styles.generated.ts src/embed/__tests__/chat-styles.test.ts
git commit -m "build(embed): inline chat styles for shadow roots"
```

---

### Task 22: `<glirastes-chat>` custom element

**Files:**
- Create: `src/embed/theme.ts`
- Create: `src/embed/glirastes-chat-element.tsx`
- Create: `src/embed/index.ts`
- Test: `src/embed/__tests__/glirastes-chat-element.test.tsx` (jsdom), `src/embed/__tests__/embed-module.test.ts` (node, SSR import)

**Interfaces:**
- Consumes: `AiChatPanel`, `AiChatProvider`, `useChatContext`, `VercelAiChat`, `CHAT_THEME_PRESETS`, `getThemeVars`, `themeScope: 'inherit'` (Task 17), `CHAT_STYLES` (Task 21).
- Produces (`glirastes/embed`):
  - `export const GLIRASTES_CHAT_TAG = 'glirastes-chat'`
  - `export interface GlirastesChatEventMap { 'glirastes-chat:ready': Record<string, never>; 'glirastes-chat:status': { state: 'idle' | 'busy' | 'error' }; 'glirastes-chat:tool-result': { toolName: string; result: unknown }; 'glirastes-chat:error': { message: string } }`
  - `export type GlirastesChatEventName = keyof GlirastesChatEventMap`
  - `export interface GlirastesChatElementConfig extends Omit<AiChatProviderConfig, 'theme' | 'themeScope'> { headers?: Record<string, string> | (() => Record<string, string>); bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>) }`
  - `export class GlirastesChatElement extends HTMLElement { config: GlirastesChatElementConfig; transport: ChatTransport | undefined; send(text: string): boolean }` — attributes `endpoint`, `theme`, `placeholder`, `welcome-message`, `voice`, `voice-language`
  - `export function defineGlirastesChatElement(tagName?: string): typeof GlirastesChatElement`
  - `export const EMBED_CSS_VARIABLES: readonly string[]`; `export function embedThemeCss(preset?: ChatThemePreset): string`

- [ ] **Step 1: Write the failing tests**

Create `src/embed/__tests__/glirastes-chat-element.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatTransport } from '../../react/types.js';
import { CHAT_STYLES } from '../chat-styles.generated.js';
import {
  EMBED_CSS_VARIABLES,
  GlirastesChatElement,
  defineGlirastesChatElement,
  embedThemeCss,
} from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function transport(messages: ChatMessage[] = []): ChatTransport {
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

async function mount(
  configure: (element: GlirastesChatElement) => void = () => {},
  tag = 'glirastes-chat',
) {
  defineGlirastesChatElement(tag);
  const element = document.createElement(tag) as GlirastesChatElement;
  configure(element);
  const events: Array<{ type: string; detail: unknown }> = [];
  for (const type of ['ready', 'status', 'tool-result', 'error']) {
    document.addEventListener(`glirastes-chat:${type}`, (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    });
  }
  await act(async () => { document.body.append(element); });
  return { element, events };
}

afterEach(async () => {
  await act(async () => { document.body.replaceChildren(); });
});

describe('<glirastes-chat>', () => {
  it('renders the React chat inside an open shadow root with the shared CSS', async () => {
    const chat = transport();
    const { element, events } = await mount((node) => {
      node.setAttribute('placeholder', 'Frag deine App');
      node.transport = chat;
    });
    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('[data-component="ai-chat-panel"]')).toBeTruthy();
    expect(shadow.querySelector('style')?.textContent).toContain(CHAT_STYLES);
    expect(shadow.querySelector('textarea')?.getAttribute('placeholder')).toBe('Frag deine App');
    expect(document.body.querySelector('[data-component="ai-chat-panel"]')).toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      'glirastes-chat:ready',
      'glirastes-chat:status',
    ]);
  });

  it('lets host CSS variables theme the panel instead of inline variables', async () => {
    const { element } = await mount((node) => {
      node.setAttribute('theme', 'professional-dark');
      node.transport = transport();
    });
    const panel = element.shadowRoot!.querySelector<HTMLElement>('[data-component="ai-chat-panel"]')!;
    expect(panel.getAttribute('style') ?? '').not.toContain('--cm-primary');
    const css = element.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toContain(embedThemeCss('professional-dark'));
    expect(css).toMatch(/--cm-primary: var\(--glirastes-chat-primary, [^)]+\);/);
    expect(EMBED_CSS_VARIABLES).toContain('--glirastes-chat-primary');
  });

  it('sends from the keyboard and through the element API', async () => {
    const chat = transport();
    const { element } = await mount((node) => { node.transport = chat; });
    const textarea = element.shadowRoot!.querySelector('textarea')!;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Zeige meine Aufgaben' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Zeige meine Aufgaben' }));
    await act(async () => { expect(element.send('Und morgen?')).toBe(true); });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Und morgen?' }));
  });

  it('emits tool results for host-side UI actions', async () => {
    const chat = transport([{
      id: 'a1',
      role: 'assistant',
      parts: [{
        type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available',
        output: { success: true, uiAction: { type: 'navigate', path: '/tasks' } },
      }],
    } as unknown as ChatMessage]);
    const { events } = await mount((node) => { node.transport = chat; });
    expect(events).toContainEqual({
      type: 'glirastes-chat:tool-result',
      detail: {
        toolName: 'ui_navigate',
        result: { success: true, uiAction: { type: 'navigate', path: '/tasks' } },
      },
    });
  });

  it('reports a missing endpoint instead of rendering a broken chat', async () => {
    const { element, events } = await mount();
    expect(element.shadowRoot!.querySelector('[data-component="ai-chat-panel"]')).toBeNull();
    expect(events).toContainEqual({
      type: 'glirastes-chat:error',
      detail: { message: 'Missing endpoint attribute' },
    });
  });

  it('unmounts cleanly on removal but survives a move', async () => {
    const { element } = await mount((node) => { node.transport = transport(); });
    const other = document.createElement('section');
    document.body.append(other);
    await act(async () => { other.append(element); });
    expect(element.shadowRoot!.querySelector('[data-component="ai-chat-panel"]')).toBeTruthy();

    await act(async () => { element.remove(); });
    await act(async () => { await Promise.resolve(); });
    expect(element.shadowRoot!.childNodes).toHaveLength(0);
    expect(element.send('late')).toBe(false);
  });

  it('defines each tag once and refuses foreign definitions', () => {
    const first = defineGlirastesChatElement('glirastes-chat-twice');
    expect(defineGlirastesChatElement('glirastes-chat-twice')).toBe(first);
    customElements.define('foreign-chat', class extends HTMLElement {});
    expect(() => defineGlirastesChatElement('foreign-chat')).toThrow(/already defined/);
  });
});
```

Create `src/embed/__tests__/embed-module.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('glirastes/embed module', () => {
  it('can be imported where no DOM exists (SSR) and fails clearly on define', async () => {
    expect(typeof globalThis.HTMLElement).toBe('undefined');
    const embed = await import('../index.js');
    expect(embed.GLIRASTES_CHAT_TAG).toBe('glirastes-chat');
    expect(() => embed.defineGlirastesChatElement()).toThrow(/Custom Elements/);
  });
});
```

- [ ] **Step 2: Run them and confirm the failure**

Run: `bunx vitest run src/embed`
Expected: FAIL, `../index.js` cannot be resolved (chat-styles test still passes).

- [ ] **Step 3: Theme mapping**

Create `src/embed/theme.ts`:

```ts
import { CHAT_THEME_PRESETS, getThemeVars } from '../react/themes.js';
import type { ChatThemePreset } from '../react/types.js';

/** Public CSS custom properties a host page may set on `<glirastes-chat>`. */
export const EMBED_CSS_VARIABLES = Object.freeze([
  '--glirastes-chat-primary',
  '--glirastes-chat-primary-soft',
  '--glirastes-chat-primary-tint',
  '--glirastes-chat-bg',
  '--glirastes-chat-bg-muted',
  '--glirastes-chat-bubble-user',
  '--glirastes-chat-bubble-assistant',
  '--glirastes-chat-text',
  '--glirastes-chat-text-muted',
  '--glirastes-chat-border',
  '--glirastes-chat-danger',
  '--glirastes-chat-radius',
  '--glirastes-chat-radius-sm',
  '--glirastes-chat-font',
] as const);

export function isChatThemePreset(value: string | null | undefined): value is ChatThemePreset {
  return typeof value === 'string' && Object.hasOwn(CHAT_THEME_PRESETS, value);
}

/**
 * Shadow-root theme rules. Host CSS variables (`--glirastes-chat-*`) win;
 * the selected preset supplies the fallback. Inline panel variables are
 * disabled in the embed (`themeScope: 'inherit'`) so these rules apply.
 */
export function embedThemeCss(preset?: ChatThemePreset): string {
  const declarations = Object.entries(getThemeVars(preset))
    .map(([name, value]) => {
      const publicName = name.replace(/^--cm-/, '--glirastes-chat-');
      return `  ${name}: var(${publicName}, ${value});`;
    })
    .join('\n');
  return [
    ':host { display: block; position: relative; height: 100%; min-height: 0; }',
    ':host([hidden]) { display: none; }',
    '[data-part="mount"] { height: 100%; }',
    `[data-component="ai-chat-panel"] {\n${declarations}\n}`,
  ].join('\n');
}
```

- [ ] **Step 4: The element**

Create `src/embed/glirastes-chat-element.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AiChatPanel } from '../react/components/ai-chat-panel.js';
import { AiChatProvider } from '../react/provider/ai-chat-provider.js';
import { useChatContext } from '../react/provider/chat-context.js';
import { VercelAiChat } from '../react/transports/vercel/vercel-ai-chat.js';
import type { AiChatProviderConfig, ChatTransport } from '../react/types.js';
import { CHAT_STYLES } from './chat-styles.generated.js';
import { embedThemeCss, isChatThemePreset } from './theme.js';

export const GLIRASTES_CHAT_TAG = 'glirastes-chat';

export interface GlirastesChatEventMap {
  'glirastes-chat:ready': Record<string, never>;
  'glirastes-chat:status': { state: 'idle' | 'busy' | 'error' };
  'glirastes-chat:tool-result': { toolName: string; result: unknown };
  'glirastes-chat:error': { message: string };
}

export type GlirastesChatEventName = keyof GlirastesChatEventMap;

/** JS-only settings that do not fit attributes. Theme comes from the attribute. */
export interface GlirastesChatElementConfig
  extends Omit<AiChatProviderConfig, 'theme' | 'themeScope'> {
  headers?: Record<string, string> | (() => Record<string, string>);
  bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>);
}

type Emit = <TName extends GlirastesChatEventName>(
  name: TName,
  detail: GlirastesChatEventMap[TName],
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
    emit('glirastes-chat:ready', {});
  }, [emit]);

  useEffect(() => {
    if (previous.current === state) return;
    previous.current = state;
    emit('glirastes-chat:status', { state });
  }, [state, emit]);

  return null;
}

function EmbeddedChat({
  endpoint,
  transport,
  config,
  welcomeMessage,
  emit,
  onSendReady,
}: {
  endpoint: string;
  transport?: ChatTransport;
  config: GlirastesChatElementConfig;
  welcomeMessage?: string;
  emit: Emit;
  onSendReady: (send: SendRef | null) => void;
}) {
  const { headers, bodyExtras, onToolResult, ...providerConfig } = config;
  const shared = {
    ...providerConfig,
    themeScope: 'inherit' as const,
    onToolResult: (toolName: string, result: unknown) => {
      onToolResult?.(toolName, result);
      emit('glirastes-chat:tool-result', { toolName, result });
    },
  };
  const body = (
    <>
      <EmbedBridge emit={emit} onSendReady={onSendReady} />
      <AiChatPanel welcomeMessage={welcomeMessage} />
    </>
  );
  if (transport) {
    return <AiChatProvider transport={transport} {...shared}>{body}</AiChatProvider>;
  }
  return (
    <VercelAiChat endpoint={endpoint} headers={headers} bodyExtras={bodyExtras} {...shared}>
      {body}
    </VercelAiChat>
  );
}

// Importing on a server (SSR) must not touch DOM globals.
const BaseElement = (typeof HTMLElement === 'undefined'
  ? class {}
  : HTMLElement) as typeof HTMLElement;

/**
 * `<glirastes-chat endpoint="/api/chat">`: the React chat UI inside a Shadow
 * DOM for Vue, Angular, Svelte or plain HTML hosts.
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

  get config(): GlirastesChatElementConfig {
    return this.#config;
  }

  set config(value: GlirastesChatElementConfig | null | undefined) {
    this.#config = value ?? {};
    this.#render();
  }

  get transport(): ChatTransport | undefined {
    return this.#transport;
  }

  set transport(value: ChatTransport | undefined) {
    this.#transport = value;
    this.#render();
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
      const style = document.createElement('style');
      const mount = document.createElement('div');
      mount.setAttribute('data-part', 'mount');
      shadow.replaceChildren(style, mount);
      this.#style = style;
      this.#root = createRoot(mount);
    }
    this.#render();
  }

  disconnectedCallback(): void {
    // A move (disconnect + connect in one task) keeps the mounted chat.
    this.#pendingUnmount = true;
    queueMicrotask(() => {
      if (!this.#pendingUnmount || this.isConnected) return;
      this.#pendingUnmount = false;
      const root = this.#root;
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

  #render(): void {
    if (!this.#root || !this.#style) return;
    const theme = this.getAttribute('theme');
    this.#style.textContent = `${CHAT_STYLES}\n${embedThemeCss(
      isChatThemePreset(theme) ? theme : undefined,
    )}`;
    const endpoint = this.getAttribute('endpoint') ?? '';
    if (!endpoint && !this.#transport) {
      this.#root.render(null);
      this.#emit('glirastes-chat:error', { message: 'Missing endpoint attribute' });
      return;
    }
    const placeholder = this.getAttribute('placeholder');
    const voiceLanguage = this.getAttribute('voice-language');
    const config: GlirastesChatElementConfig = {
      ...this.#config,
      ...(placeholder
        ? { locale: { ...(this.#config.locale ?? {}), placeholder } }
        : {}),
      ...(this.hasAttribute('voice')
        ? {
          voice: {
            ...(this.#config.voice ?? {}),
            enabled: true,
            ...(voiceLanguage ? { language: voiceLanguage } : {}),
          },
        }
        : {}),
    };
    this.#root.render(
      <EmbeddedChat
        endpoint={endpoint}
        transport={this.#transport}
        config={config}
        welcomeMessage={this.getAttribute('welcome-message') ?? undefined}
        emit={this.#emit}
        onSendReady={this.#onSendReady}
      />,
    );
  }
}

/**
 * Registers the element once per tag name and returns its class. Each tag
 * gets its own subclass, so a page may register several names.
 */
export function defineGlirastesChatElement(
  tagName: string = GLIRASTES_CHAT_TAG,
): typeof GlirastesChatElement {
  if (typeof customElements === 'undefined') {
    throw new Error('glirastes/embed needs a browser with Custom Elements support');
  }
  const existing = customElements.get(tagName);
  if (existing) {
    if (!(existing.prototype instanceof GlirastesChatElement)) {
      throw new Error(`<${tagName}> is already defined by another element`);
    }
    return existing as typeof GlirastesChatElement;
  }
  const ElementClass = class extends GlirastesChatElement {};
  customElements.define(tagName, ElementClass);
  return ElementClass;
}
```

Create `src/embed/index.ts`:

```ts
// ============================================================================
// glirastes/embed
//
// Framework-neutral chat embedding: <glirastes-chat> wraps the React chat UI
// in a Shadow DOM for non-React hosts (Vue, Angular, Svelte, plain HTML).
// Peer requirements: react, react-dom, @ai-sdk/react and ai.
// ============================================================================

export {
  GLIRASTES_CHAT_TAG,
  GlirastesChatElement,
  defineGlirastesChatElement,
  type GlirastesChatElementConfig,
  type GlirastesChatEventMap,
  type GlirastesChatEventName,
} from './glirastes-chat-element.js';
export { EMBED_CSS_VARIABLES, embedThemeCss } from './theme.js';
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `bunx vitest run src/embed && bun run typecheck && bun run typecheck:tests`
Expected: PASS: 7 element tests, 1 SSR test, 1 styles test; both typechecks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/embed/theme.ts src/embed/glirastes-chat-element.tsx src/embed/index.ts src/embed/__tests__/glirastes-chat-element.test.tsx src/embed/__tests__/embed-module.test.ts
git commit -m "feat(embed): add the glirastes-chat custom element"
```

---

### Task 23: Publish `glirastes/embed` as a subpath

**Files:**
- Modify: `package.json` (`exports` after `"./react/styles.css"`, `files` after `"!react/langgraph"`, `scripts.build`)
- Modify: `scripts/generate-subpath-shims.mjs` (`SHIMS`, after `['react/langgraph', ...]`)
- Modify: `.gitignore` (generated shim directory)
- Modify: `src/public-subpaths.test.ts`

**Interfaces:**
- Produces: `import { defineGlirastesChatElement } from 'glirastes/embed'` (ESM like `./react`, types `./dist/embed/index.d.ts`); legacy shim `embed/package.json`; `bun run build` fails when the inlined CSS is stale.

- [ ] **Step 1: Write the failing test**

In `src/public-subpaths.test.ts` replace:

```ts
    [
      'Next.js adapter',
      './adapter/nextjs',
      './dist/server/adapters/nextjs/index.js',
    ],
  ])('exports the independently importable %s surface', async (
```

with:

```ts
    [
      'Next.js adapter',
      './adapter/nextjs',
      './dist/server/adapters/nextjs/index.js',
    ],
    ['framework-neutral chat embed', './embed', './dist/embed/index.js'],
  ])('exports the independently importable %s surface', async (
```

Replace:

```ts
  it('keeps the standalone STT surface framework-neutral', async () => {
```

with:

```ts
  it('ships the embed subpath with its legacy shim and fresh inlined styles', async () => {
    const [packageJson, shims, embedSource] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/generate-subpath-shims.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./embed/index.ts', import.meta.url), 'utf8'),
    ]);
    const parsed = JSON.parse(packageJson) as { files?: string[]; scripts?: Record<string, string> };
    expect(parsed.files).toContain('embed');
    expect(parsed.scripts?.build).toContain('generate-embed-styles.mjs --check');
    expect(shims).toContain("['embed', 'embed']");
    expect(embedSource).toContain('defineGlirastesChatElement');
    expect(embedSource).not.toMatch(/from ['"]\.\.\/react\/index\.js['"]/);
  });

  it('keeps the standalone STT surface framework-neutral', async () => {
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/public-subpaths.test.ts`
Expected: FAIL: `exports['./embed']` is undefined and `files` lacks `embed`.

- [ ] **Step 3: Package metadata, shim and ignore rule**

In `package.json` replace:

```json
    "./react/styles.css": "./dist/react/styles.css",
```

with:

```json
    "./react/styles.css": "./dist/react/styles.css",
    "./embed": {
      "types": "./dist/embed/index.d.ts",
      "default": "./dist/embed/index.js"
    },
```

Replace:

```json
    "react",
    "!react/langgraph",
```

with:

```json
    "react",
    "!react/langgraph",
    "embed",
```

Replace:

```json
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.cjs.json && cp src/react/styles.css dist/react/styles.css && node -e \"require('fs').writeFileSync('dist/cjs/package.json', '{\\\"type\\\":\\\"commonjs\\\"}\\n')\" && node scripts/generate-subpath-shims.mjs",
```

with:

```json
    "build": "node scripts/generate-embed-styles.mjs --check && tsc -p tsconfig.json && tsc -p tsconfig.cjs.json && cp src/react/styles.css dist/react/styles.css && node -e \"require('fs').writeFileSync('dist/cjs/package.json', '{\\\"type\\\":\\\"commonjs\\\"}\\n')\" && node scripts/generate-subpath-shims.mjs",
```

In `scripts/generate-subpath-shims.mjs` replace:

```js
  ['react/langgraph', 'react/transports/langgraph'],
```

with:

```js
  ['react/langgraph', 'react/transports/langgraph'],
  ['embed', 'embed'],
```

In `.gitignore` replace:

```
/codegen/
/openapi/
```

with:

```
/codegen/
/openapi/
/embed/
```

- [ ] **Step 4: Run tests and a production build**

Run: `bunx vitest run src/public-subpaths.test.ts && bun run build && ls dist/embed/index.js dist/embed/index.d.ts embed/package.json && git status --short embed`
Expected: PASS (all subpath tests); build prints `Generated 17 subpath shims.`; the three files exist; `git status` shows nothing for the ignored `embed/` shim.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/generate-subpath-shims.mjs .gitignore src/public-subpaths.test.ts
git commit -m "build(embed): publish glirastes/embed as a package subpath"
```

---

### Task 24: Chrome fake-microphone tests for the STT lifecycle

**Files:**
- Create: `tests/chat-browser.test.mjs`
- Create: `tests/browser/harness-server.mjs`
- Create: `tests/browser/chat-harness.tsx` (STT view; Task 25 adds the mobile and embed views)

**Interfaces:**
- Consumes: built-in Bun bundler (`bun build --production`; `--production` is required, a plain `--define` keeps the dev JSX runtime and fails with `jsxDEV is not a function`), `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_CHANNEL=chrome`, Chrome flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
- Produces: `export async function startChatHarness(): Promise<{ origin: string; close(): Promise<void> }>`; page API `window.harness = { sent, events, streamCount(), liveTrackCount(), maxConcurrentLiveTracks(), failNextConnect() }`.

- [ ] **Step 1: Write the failing browser test**

Create `tests/chat-browser.test.mjs`:

```js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { startChatHarness } from './browser/harness-server.mjs';

// Real Chrome with a fake microphone: FR-4/FR-5 lifecycle, mobile layout and
// <glirastes-chat>. Run: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs
// PLAYWRIGHT_CHANNEL=chrome node --test tests/chat-browser.test.mjs
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
let harness;
let browser;

before(async () => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  harness = await startChatHarness();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});

after(async () => {
  await browser?.close();
  await harness?.close();
});

async function openPage(view, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(`${harness.origin}/?view=${view}`);
  return { page, errors, close: () => context.close() };
}

const liveTracks = (page) => page.evaluate(() => window.harness.liveTrackCount());
const waitForNoLiveTrack = (page) =>
  page.waitForFunction(() => window.harness.liveTrackCount() === 0, null, { timeout: 5_000 });

async function startRecording(page) {
  await page.getByRole('button', { name: 'mic', exact: true }).click();
  await page.locator('[data-component="voice-input-addon"][data-state="recording"]').waitFor();
  await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt aus dem browser' }).waitFor();
  assert.equal(await liveTracks(page), 1, 'exactly one live microphone track while recording');
}

async function assertSingleStream(page, errors) {
  assert.equal(await page.evaluate(() => window.harness.maxConcurrentLiveTracks()), 1);
  assert.deepEqual(errors, []);
}

describe('speech-to-text lifecycle in Chrome with a fake microphone', () => {
  test('stop finalizes into the editable draft without sending and releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      const editor = page.getByRole('textbox', { name: 'Type a message...' });
      await editor.fill('Bitte:');
      await startRecording(page);
      assert.equal(await editor.inputValue(), 'Bitte:', 'interim text must not enter the editor');
      await page.locator('[data-element="stop-button"]').click();
      await waitForNoLiveTrack(page);
      assert.equal(await editor.inputValue(), 'Bitte: Hallo Welt aus dem Browser');
      assert.deepEqual(await page.evaluate(() => window.harness.sent), []);
      await editor.fill('Bitte: Hallo Welt, morgen');
      await editor.press('Enter');
      await page.waitForFunction(() => window.harness.sent.length === 1);
      assert.deepEqual(await page.evaluate(() => window.harness.sent), ['Bitte: Hallo Welt, morgen']);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('cancel keeps the previous draft and releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      const editor = page.getByRole('textbox', { name: 'Type a message...' });
      await editor.fill('Entwurf');
      await startRecording(page);
      await page.locator('[data-element="cancel-button"]').click();
      await waitForNoLiveTrack(page);
      assert.equal(await editor.inputValue(), 'Entwurf');
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('retry after a provider failure records again with one stream at a time', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await page.evaluate(() => window.harness.failNextConnect());
      await page.getByRole('button', { name: 'mic', exact: true }).click();
      await page.locator('[data-component="voice-input-addon"][data-state="failed"]').waitFor();
      await waitForNoLiveTrack(page);
      await page.getByRole('button', { name: 'Retry recording' }).click();
      await page.locator('[data-component="voice-input-addon"][data-state="recording"]').waitFor();
      assert.equal(await liveTracks(page), 1);
      await page.locator('[data-element="stop-button"]').click();
      await waitForNoLiveTrack(page);
      assert.equal(await page.evaluate(() => window.harness.streamCount()), 2);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  for (const [label, action] of [
    ['a route change', (page) => page.getByRole('button', { name: 'Go to reports' }).click()],
    ['a session switch', (page) => page.getByRole('button', { name: 'Switch session' }).click()],
  ]) {
    test(`${label} stops recording, keeps the speech as draft and releases the mic`, async () => {
      const { page, errors, close } = await openPage('stt');
      try {
        await startRecording(page);
        await action(page);
        await waitForNoLiveTrack(page);
        assert.match(
          await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
          /Hallo Welt aus dem Browser/,
        );
        await assertSingleStream(page, errors);
      } finally {
        await close();
      }
    });
  }

  test('browser back navigation releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await page.getByRole('button', { name: 'Go to reports' }).click();
      await startRecording(page);
      await page.goBack();
      await waitForNoLiveTrack(page);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('unmounting the chat releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await startRecording(page);
      await page.getByRole('button', { name: 'Unmount chat' }).click();
      await waitForNoLiveTrack(page);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('push-to-talk: holding the button records until release', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      const mic = page.getByRole('button', { name: 'mic', exact: true });
      const box = await mic.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt' }).waitFor();
      await delay(450);
      await page.mouse.up();
      await waitForNoLiveTrack(page);
      assert.equal(
        await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
        'Hallo Welt aus dem Browser',
      );
      assert.deepEqual(await page.evaluate(() => window.harness.sent), []);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('push-to-talk: holding the hotkey records until release', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await page.getByRole('textbox', { name: 'Type a message...' }).focus();
      await page.keyboard.down(MOD);
      await page.keyboard.down('Shift');
      await page.keyboard.down('Space');
      await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt' }).waitFor();
      await page.keyboard.up('Space');
      await page.keyboard.up('Shift');
      await page.keyboard.up(MOD);
      await waitForNoLiveTrack(page);
      assert.equal(
        await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
        'Hallo Welt aus dem Browser',
      );
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run:

```bash
export PLAYWRIGHT_MODULE="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1)"
PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-browser.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tests/browser/harness-server.mjs`.

- [ ] **Step 3: Harness server**

Create `tests/browser/harness-server.mjs`:

```js
// Bundles tests/browser/chat-harness.tsx with Bun and serves it on a
// loopback port. A loopback origin is a secure context, so getUserMedia works
// with Chrome's fake media device. Nothing is downloaded.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENTRY = join(ROOT, 'tests/browser/chat-harness.tsx');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export async function startChatHarness() {
  const outdir = await mkdtemp(join(tmpdir(), 'glirastes-chat-harness-'));
  const build = spawn('bun', [
    'build', ENTRY,
    '--outdir', outdir,
    '--target', 'browser',
    '--format', 'esm',
    '--production',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let output = '';
  build.stdout.on('data', (chunk) => { output += chunk; });
  build.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(build, 'exit');
  if (code !== 0) {
    await rm(outdir, { recursive: true, force: true });
    throw new Error(`Harness build failed:\n${output}`);
  }
  await writeFile(join(outdir, 'index.html'), [
    '<!doctype html>',
    '<html lang="de"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="/chat-harness.css">',
    '<style>body{margin:0;font:16px/1.5 system-ui,sans-serif}</style>',
    '</head><body><div id="root"></div>',
    '<script type="module" src="/chat-harness.js"></script>',
    '</body></html>',
  ].join(''));

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = path.endsWith('.js') || path.endsWith('.css') ? path.slice(1) : 'index.html';
    try {
      const body = await readFile(join(outdir, file));
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(outdir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4: Harness page (STT view)**

Create `tests/browser/chat-harness.tsx`:

```tsx
// Browser harness for tests/chat-browser.test.mjs. Bundled by Bun from the
// SDK sources; no model, network provider, app data or credentials.
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AiChatPanel,
  AiChatProvider,
  useChatContext,
  type ChatMessage,
  type ChatTransport,
  type SessionConfig,
  type SessionSummary,
  type SttProviderAdapter,
} from '../../src/react/index.js';

interface HarnessApi {
  sent: string[];
  events: Array<{ type: string; detail: unknown }>;
  streamCount(): number;
  liveTrackCount(): number;
  maxConcurrentLiveTracks(): number;
  failNextConnect(): void;
}

declare global {
  interface Window {
    harness: HarnessApi;
  }
}

const sent: string[] = [];
const events: Array<{ type: string; detail: unknown }> = [];
const streams: MediaStream[] = [];
let maxConcurrent = 0;
let failNext = false;

const liveTrackCount = () => streams
  .flatMap((stream) => stream.getTracks())
  .filter((track) => track.readyState === 'live').length;

// Count every microphone the SDK opens; Chrome's fake device supplies audio.
const mediaDevices = navigator.mediaDevices;
const realGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
mediaDevices.getUserMedia = async (constraints) => {
  const stream = await realGetUserMedia(constraints);
  streams.push(stream);
  maxConcurrent = Math.max(maxConcurrent, liveTrackCount());
  return stream;
};

window.harness = {
  sent,
  events,
  streamCount: () => streams.length,
  liveTrackCount,
  maxConcurrentLiveTracks: () => maxConcurrent,
  failNextConnect: () => { failNext = true; },
};

/** Deterministic speech provider: interim text while recording, final on Stop. */
const speech: SttProviderAdapter = {
  async connect({ events: sink, signal }) {
    if (failNext) {
      failNext = false;
      throw new Error('fixture provider unavailable');
    }
    const timer = setTimeout(() => sink.onSegment({
      id: 's1', sequence: 1, text: 'hallo welt aus dem browser', isFinal: false,
    }), 30);
    signal.addEventListener('abort', () => clearTimeout(timer));
    return {
      finalize: async () => {
        clearTimeout(timer);
        sink.onSegment({ id: 's1', sequence: 1, text: 'Hallo Welt aus dem Browser', isFinal: true });
      },
      cancel: async () => clearTimeout(timer),
      close: async () => clearTimeout(timer),
    };
  },
};

const noop = () => {};

/** Like a real transport: stable callbacks, only `messages` changes. */
function useFakeTransport(initial: ChatMessage[]): ChatTransport {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const sendMessage = useCallback(async ({ text }: { text: string }) => {
    sent.push(text);
    setMessages((previous) => [...previous, {
      id: `user-${previous.length}`, role: 'user', parts: [{ type: 'text', text }],
    }]);
  }, []);
  const replaceMessages = useCallback((next: ChatMessage[]) => setMessages(next), []);
  return useMemo<ChatTransport>(() => ({
    messages,
    status: 'ready',
    error: null,
    sendMessage,
    stop: noop,
    setMessages: replaceMessages,
    addToolApprovalResponse: noop,
  }), [messages, sendMessage, replaceMessages]);
}

const sessionRows = new Map<string, ChatMessage[]>([['first', []], ['second', []]]);
const sessionList: SessionSummary[] = [
  { id: 'first', title: 'Erste Sitzung' },
  { id: 'second', title: 'Zweite Sitzung' },
];
const sessions: SessionConfig = {
  defaultActiveId: 'first',
  list: async () => sessionList,
  load: async (id) => sessionRows.get(id) ?? [],
  save: async (id, rows) => { sessionRows.set(id, rows); },
  create: async () => sessionList[0]!,
  remove: async () => {},
};

function SessionButton() {
  const { switchSession, activeSessionId } = useChatContext();
  return (
    <button type="button" onClick={() => { void switchSession(activeSessionId === 'first' ? 'second' : 'first'); }}>
      Switch session
    </button>
  );
}

function SttView() {
  const [route, setRoute] = useState(location.pathname);
  const [mounted, setMounted] = useState(true);
  const transport = useFakeTransport([]);
  const voice = useMemo(() => ({ enabled: true, adapter: speech, routeKey: route }), [route]);
  window.onpopstate = () => setRoute(location.pathname);
  return (
    <main>
      <nav>
        <button type="button" onClick={() => {
          history.pushState({}, '', '/reports');
          setRoute('/reports');
        }}>Go to reports</button>
        <button type="button" onClick={() => setMounted(false)}>Unmount chat</button>
      </nav>
      {mounted && (
        <AiChatProvider transport={transport} voice={voice} session={sessions}>
          <SessionButton />
          <div style={{ height: 600 }}><AiChatPanel /></div>
        </AiChatProvider>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<SttView />);
```

- [ ] **Step 5: Run it and confirm it passes**

Run (self-contained: agent shells do not keep exported variables between calls):

```bash
export PLAYWRIGHT_MODULE="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1)"
PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-browser.test.mjs
```

Expected: 9 passing tests in "speech-to-text lifecycle in Chrome with a fake microphone" (about 15 s), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add tests/chat-browser.test.mjs tests/browser/harness-server.mjs tests/browser/chat-harness.tsx
git commit -m "test(stt): prove microphone release in chrome with a fake device"
```

---

### Task 25: Mobile layout and `<glirastes-chat>` in Chrome

**Files:**
- Modify: `tests/browser/chat-harness.tsx` (imports, before `createRoot(...)`, the `createRoot(...)` line)
- Modify: `tests/chat-browser.test.mjs` (append two `describe` blocks)

**Interfaces:**
- Consumes: `FloatingChatUI`, `createUiToolCommandProvider` (Task 12), clarification card (Task 9), `defineGlirastesChatElement` (Task 22).
- Produces: harness views `?view=mobile` (sidebar chat at 375 × 812 with an open clarification, `/` commands and voice) and `?view=embed` (`<glirastes-chat>` with `--glirastes-chat-primary: #10b981`).

- [ ] **Step 1: Write the failing browser tests**

Append to `tests/chat-browser.test.mjs`:

```js

describe('mobile layout (375 × 812)', () => {
  test('chat, clarification, commands and recording stay inside the viewport', async () => {
    const { page, errors, close } = await openPage('mobile', { width: 375, height: 812 });
    try {
      const inside = async (locator, label) => {
        const box = await locator.boundingBox();
        assert.ok(box, `${label} is not rendered`);
        assert.ok(box.x >= 0 && box.x + box.width <= 375.5, `${label} overflows horizontally`);
        assert.ok(box.y >= 0 && box.y + box.height <= 812.5, `${label} overflows vertically`);
      };
      const panel = page.locator('[data-component="chat-window"]');
      await page.locator('[data-component="clarification-card"]').waitFor();
      const panelBox = await panel.boundingBox();
      assert.equal(Math.round(panelBox.width), 375);
      assert.equal(Math.round(panelBox.height), 812);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'page scrolls horizontally');

      const card = page.locator('[data-component="clarification-card"]');
      await inside(card, 'clarification card');
      for (const option of await card.locator('[data-action="answer-option"]').all()) {
        await inside(option, 'clarification option');
      }
      assert.ok(await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));

      const editor = page.getByRole('textbox', { name: 'Type a message...' });
      await inside(editor, 'composer');
      await inside(page.getByRole('button', { name: 'mic', exact: true }), 'mic button');
      await editor.click();
      await page.keyboard.type('/erl');
      const dropdown = page.locator('[data-component="mention-dropdown"]');
      await dropdown.waitFor();
      await inside(dropdown, 'command list');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');

      await startRecording(page);
      await inside(page.locator('[data-component="recording-bar"]'), 'recording bar');
      await page.locator('[data-element="stop-button"]').click();
      await waitForNoLiveTrack(page);

      await card.getByRole('button', { name: 'Release prüfen' }).click();
      await page.waitForFunction(() => window.harness.sent.length === 1);
      assert.match(
        (await page.evaluate(() => window.harness.sent))[0],
        /^<!--glirastes:clarification \{"toolCallId":"call-1","optionId":"task-2"\}-->\nRelease prüfen$/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
});

describe('<glirastes-chat> in a plain page', () => {
  test('renders in shadow DOM, takes host CSS variables, sends by keyboard and unmounts cleanly', async () => {
    const { page, errors, close } = await openPage('embed');
    try {
      const textarea = page.locator('glirastes-chat textarea');
      await textarea.waitFor();
      assert.equal(await textarea.getAttribute('placeholder'), 'Frag deine App');
      const primary = await page.evaluate(() => {
        const host = document.querySelector('glirastes-chat');
        const panel = host.shadowRoot.querySelector('[data-component="ai-chat-panel"]');
        return getComputedStyle(panel).getPropertyValue('--cm-primary').trim();
      });
      assert.equal(primary, '#10b981');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-component="ai-chat-panel"]').length), 0,
        'the chat must live in the shadow root only');

      await textarea.focus();
      await page.keyboard.type('Zeige meine Aufgaben');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.harness.sent.includes('Zeige meine Aufgaben'));
      const types = await page.evaluate(() => window.harness.events.map((event) => event.type));
      assert.ok(types.includes('glirastes-chat:ready'));

      const remaining = await page.evaluate(async () => {
        const host = document.querySelector('glirastes-chat');
        host.remove();
        await new Promise((done) => setTimeout(done, 0));
        return host.shadowRoot.childNodes.length;
      });
      assert.equal(remaining, 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `PLAYWRIGHT_MODULE="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1)" PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-browser.test.mjs`
Expected: exit 1 with 9 passed and 2 failed: the 9 STT tests pass; the mobile test fails with `locator.waitFor: Timeout 30000ms exceeded` for `[data-component="clarification-card"]`, the embed test with the same timeout for `glirastes-chat textarea` (both views still render the STT page).

- [ ] **Step 3: Add the mobile and embed views**

In `tests/browser/chat-harness.tsx` replace:

```tsx
import {
  AiChatPanel,
  AiChatProvider,
  useChatContext,
  type ChatMessage,
  type ChatTransport,
  type SessionConfig,
  type SessionSummary,
  type SttProviderAdapter,
} from '../../src/react/index.js';
```

with:

```tsx
import {
  AiChatPanel,
  AiChatProvider,
  FloatingChatUI,
  createUiToolCommandProvider,
  useChatContext,
  type ChatMessage,
  type ChatTransport,
  type SessionConfig,
  type SessionSummary,
  type SttProviderAdapter,
} from '../../src/react/index.js';
import { defineGlirastesChatElement, type GlirastesChatElement } from '../../src/embed/index.js';
```

Replace:

```tsx
createRoot(document.getElementById('root')!).render(<SttView />);
```

with:

```tsx
const clarification = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [{
    type: 'tool-ask_clarification',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { question: 'Welche Aufgabe soll ich verschieben?', target: 'object' },
    output: {
      success: true,
      clarification: {
        question: 'Welche Aufgabe soll ich verschieben?',
        target: 'object',
        options: [
          { id: 'task-1', label: 'Quartalsbericht für die Geschäftsführung fertigstellen' },
          { id: 'task-2', label: 'Release prüfen' },
          { id: 'task-3', label: 'Kundentermin vorbereiten' },
        ],
        allowFreeText: true,
      },
    },
  }],
} as unknown as ChatMessage;

const commands = createUiToolCommandProvider({ tools: [
  { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen' },
  { definitionId: 'ui.filter.done', label: 'Erledigte Aufgaben filtern' },
] });

function MobileView() {
  const transport = useFakeTransport([
    { id: 'user-0', role: 'user', parts: [{ type: 'text', text: 'Verschiebe die Aufgabe auf morgen' }] },
    clarification,
  ]);
  const voice = useMemo(() => ({ enabled: true, adapter: speech }), []);
  const providers = useMemo(() => [commands], []);
  return (
    <div style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
      <main style={{ flex: 1, minWidth: 0 }}><h1>Native application</h1></main>
      <AiChatProvider transport={transport} voice={voice} completionProviders={providers}>
        <FloatingChatUI portal={false} defaultOpen keepMounted layoutControls defaultMode="sidebar" />
      </AiChatProvider>
    </div>
  );
}

function EmbedView() {
  return <main><h1>Plain host</h1><div id="embed-slot" style={{ height: 600 }} /></main>;
}

const view = new URLSearchParams(location.search).get('view') ?? 'stt';
createRoot(document.getElementById('root')!).render(
  view === 'mobile' ? <MobileView /> : view === 'embed' ? <EmbedView /> : <SttView />,
);

if (view === 'embed') {
  defineGlirastesChatElement();
  for (const type of ['ready', 'status', 'tool-result', 'error']) {
    document.addEventListener(`glirastes-chat:${type}`, (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    });
  }
  const mountEmbed = () => {
    const slot = document.getElementById('embed-slot');
    if (!slot) {
      requestAnimationFrame(mountEmbed);
      return;
    }
    const element = document.createElement('glirastes-chat') as GlirastesChatElement;
    element.setAttribute('endpoint', '/api/chat');
    element.setAttribute('placeholder', 'Frag deine App');
    element.style.setProperty('--glirastes-chat-primary', '#10b981');
    element.transport = {
      messages: [],
      status: 'ready',
      error: null,
      async sendMessage({ text }) { sent.push(text); },
      stop() {},
      setMessages() {},
      addToolApprovalResponse() {},
    };
    slot.append(element);
  };
  mountEmbed();
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `PLAYWRIGHT_MODULE="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1)" PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-browser.test.mjs && bun run typecheck:tests`
Expected: 11 passing tests (9 STT, 1 mobile, 1 embed), 0 failures, about 20 s; typecheck:tests exit 0 (it covers `tests/browser/chat-harness.tsx`).

- [ ] **Step 5: Commit**

```bash
git add tests/browser/chat-harness.tsx tests/chat-browser.test.mjs
git commit -m "test(react): check mobile layout and the chat element in chrome"
```

---

### Task 26: Chat UI skill documents the new surfaces

**Files:**
- Modify: `skills/building-glirastes-chat-ui/SKILL.md` (insert before `## Mentions and suggestions`; STT bullet list; before the `` `useStt` is the hook`` paragraph)
- Modify: `src/cli/commands/install-skills.test.ts` (new case before `'installs only foundation-supported skills for the all profile'`)

**Interfaces:** Consumes the public names from Tasks 3-25. Produces skill guidance; the existing guard "names only React surfaces that actually exist in the chat UI skill" keeps every backticked capitalized name resolvable in `src/react` (`ClarificationCard`, `ToolResultBlock`).

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/install-skills.test.ts` replace:

```ts
  it('installs only foundation-supported skills for the all profile', async () => {
```

with:

```ts
  it('documents commands, mentions, clarification, renderers, embedding and push-to-talk', async () => {
    const source = await skillSource('building-glirastes-chat-ui');

    for (const surface of [
      'completionProviders',
      'createUiToolCommandProvider',
      'completionContext',
      'ClarificationCard',
      'clarification',
      'toolRenderers',
      'defineToolResultRenderer',
      'glirastes/embed',
      'defineGlirastesChatElement',
      '--glirastes-chat-',
      'pushToTalk',
      'routeKey',
    ]) {
      expect(source).toContain(surface);
    }
    expect(source).toContain('only hides entries');
    expect(source).toContain('no automatic send on finalization');
  });

  it('installs only foundation-supported skills for the all profile', async () => {
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `bunx vitest run src/cli/commands/install-skills.test.ts`
Expected: FAIL on `expect(source).toContain('completionProviders')`.

- [ ] **Step 3: Update the skill**

In `skills/building-glirastes-chat-ui/SKILL.md` replace:

```markdown
## Mentions and suggestions
```

with:

```markdown
## Commands, mentions and clarification

`completionProviders` turns the composer into provider search. Each provider
has a stable `id`, a `trigger` (`/` or `@`) and an async `search` that gets
the query, an abort `signal`, a `limit` and the `completionContext` (roles and
attributes the UI knows). Arrow keys, Tab/Enter and Escape work in the list,
and the selected item's own id reaches the model in the mention marker.
`createUiToolCommandProvider` offers the catalog's UI tools as `/` commands.
Role filtering only hides entries: the server and the app still authorize.
Memoize the providers array; a new identity rebuilds the search.

Enable `clarification` on `createAiChatHandler`. The model asks one targeted
question through the built-in clarification tool inside its normal step, no
extra planner call. `ClarificationCard` renders the options and a free-text
answer; the answer resumes the original request, and typing into the composer
while a question is open answers it too.

## Result components

`toolRenderers` maps a tool's `definitionId` and `schemaVersion` to a compact
local component built with `defineToolResultRenderer`. Each version's
`outputSchema` guards stored messages: when no version accepts the output or
the component throws, the default `ToolResultBlock` renders instead.

## Non-React hosts

`glirastes/embed` registers `<glirastes-chat endpoint="/api/chat">` through
`defineGlirastesChatElement()`. The React UI runs in a Shadow DOM, page CSS
themes it with `--glirastes-chat-primary` and the other `--glirastes-chat-*`
variables, `glirastes-chat:ready`, `:status`, `:tool-result` and `:error`
events bubble out, and removing the element unmounts it and frees the
microphone. The host needs `react`, `react-dom`, `@ai-sdk/react` and `ai`.

## Mentions and suggestions
```

Replace:

```markdown
- let the user edit before sending;
```

with:

```markdown
- let the user edit before sending;
- no automatic send on finalization: only the user sends;
```

Replace:

```markdown
`useStt` is the hook, `VoiceInputButton` and `RecordingBar` the surface. Speech
```

with:

```markdown
`voice.pushToTalk` adds hold-to-talk on the mic button and a hold hotkey
(default `mod+shift+space`) next to tap-to-toggle. Pass `voice.routeKey` (for
example the pathname) so navigation stops recording and keeps the speech as
draft; back/forward, session switches and unmount release the microphone as
well. `voice.adapter` plugs in another provider; keep its identity stable.

`useStt` is the hook, `VoiceInputButton` and `RecordingBar` the surface. Speech
```

- [ ] **Step 4: Run the skill guards**

Run: `bunx vitest run src/cli`
Expected: PASS, including `keeps STT local and uses the single-stream controller` and `names only React surfaces that actually exist in the chat UI skill`.

- [ ] **Step 5: Commit**

```bash
git add skills/building-glirastes-chat-ui/SKILL.md src/cli/commands/install-skills.test.ts
git commit -m "docs(skills): document providers, clarification, renderers and embed"
```

---

### Task 27: Full verification

**Files:** none (fix forward in the owning task's files only if a gate fails, then commit with that task's scope).

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Generated files and types**

Run: `node scripts/generate-embed-styles.mjs --check && bun run typecheck && bun run typecheck:tests`
Expected: exit 0 for all three (`typecheck:tests` also covers `tests/browser/chat-harness.tsx` and every new `__tests__` file).

- [ ] **Step 2: Full unit suite**

Run: `bun run test`
Expected: all files pass. `tests/source-driven-build.test.ts > stops the normal app build before Next when source assessment fails` spawns a full build; P01 gave it an explicit 30 s timeout (before P01 it timed out at the 5 s default under full-suite load). If it still fails only under load, re-run `bunx vitest run tests/source-driven-build.test.ts` alone (expected all passed), report it and do not change that test here.

- [ ] **Step 3: Production build**

Run: `bun run build`
Expected: exit 0, `Generated 17 subpath shims.`, `dist/embed/index.js` and `dist/cjs/embed/index.js` exist.

- [ ] **Step 4: Browser gates**

```bash
export PLAYWRIGHT_MODULE="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.mjs | head -1)"
PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/chat-browser.test.mjs
PLAYWRIGHT_CHANNEL=chrome node --test tests/source-driven-browser.test.mjs
```

Expected: 11/11 in `chat-browser`; the existing Next reference (`source-driven-browser`, dev mode, port 3191 free) stays green, proving layout and draft retention are unchanged.

- [ ] **Step 5: Branch state**

Run: `git status --short && git log --oneline codex/glirastes-foundation-runtime..codex/mvp-chat`
Expected: clean tree; one commit per Task 1-26. No push, merge or publish.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| §6 / FR-3 `find_tools`: Unicode tokenizer `\p{L}\p{N}` | 1 |
| §6 / FR-3 DE/EN stemming via `snowball-stemmers` | 1 |
| §6 / FR-3 synonyms from `usageHints`/semantics (optional `synonyms` input for P05) | 2 (`ToolSearchSemanticsMap`), 3 (`toolSemantics`) |
| §6 / FR-3 also in standalone mode (today only managed, `create-ai-chat-handler.ts:688`) | 3 (registry discovery); snapshot path unchanged for managed and the standalone runtime source |
| §6 / FR-3 never unauthorized or undeployed tools; DE/EN corpus incl. synonyms, zero hits, missing permissions | 2 |
| §6 Rückfragen: structured tool with options and free text as SDK component | 4, 5, 9 |
| §6 original request kept and resumed with the answer | 6, 8, 10 |
| §6 no extra planner model call; no clarification when intent is clear (tool description, no forced call) | 5, 8 (`doStreamCalls` length 1) |
| Scope §3: built-in tools not denied by the managed guard; turn ends after the question | 8 |
| FR-4 follow-up suggestion pills keep working under the managed guard and hybrid discovery (`suggest_followups` built-in) | 8 (fourth `clarification-flow` test) |
| §6 Chat-UI: generic `/` and `@` provider API (async, keyboard, stable ids, permission context) | 11, 13 |
| §6 built-in command provider from catalog UI tools | 12 |
| §6 result component registry per tool (`definitionId`, schema version, safe fallback) | 14, 15 |
| §6 mobile display with browser test | 16, 25 |
| §6 `glirastes/embed`, `<glirastes-chat>`, Shadow DOM, CSS variables, events, clean unmount, React inside | 17, 21, 22, 23, 25 |
| §6 STT push-to-talk (key and button) besides toggle | 19, 20, 24 |
| §6 interim text also in the recording bar | 18, 20, 24 |
| §6 edit before send, no auto-send on finalization | 20 (`voice-draft`), 24 |
| §6 exactly one controller and one microphone stream | 20, 24 (`maxConcurrentLiveTracks() === 1`, `streamCount`) |
| §6 Chrome fake media device: stop, cancel, retry, route, session, unmount | 24 |
| §4.6 skill `building-glirastes-chat-ui` revised | 26 |
| §1 Erfolgskriterium 4 (FR-3 to FR-5 in browser tests) | 24, 25, 27 |
| Constraint: untouched `src/codegen`, `src/contracts/tool-policy.ts`, `src/contracts/index.ts` | all (clarification protocol lives in its own file) |

Not covered here, by design: §6 "Messung" (comparison corpus with identical model, live OpenRouter runs) needs Philipp's approval and belongs to TP6; wiring `toolSemantics`, `completionProviders`, `voice.routeKey` and `<glirastes-chat>` into Get It Done and the Vue fixture belongs to the TP2 and fixture plans; P05 feeds `toolSemantics` from `tool-semantics.json` and can reuse `createToolSearchIndex` for `tools eval`.

**Placeholder scan:** done. Every code step contains complete code or an exact replacement pair; the only generated file (`src/embed/chat-styles.generated.ts`) is produced by the committed script in Task 21 Step 3 and pinned by a byte-equality test. No "TBD", "TODO", "similar to" or undefined helper remains.

**Type consistency:** done. `ToolSearchSemanticsMap` (Task 2) is the type of `toolSemantics` (Task 3) and of `semantics` in both discovery factories; `NON_DOMAIN_TOOL_NAMES` (Task 3) already lists `ask_clarification` used from Task 8; `CLARIFICATION_TOOL_NAME`, `ClarificationRequest`, `formatClarificationAnswer` and `parseClarificationAnswer` (Task 4) are the only clarification identifiers used by Tasks 5, 6, 8, 9, 10; `builtinToolNames` (Task 7) is computed once at the head of `buildDiscovery` from `NON_DOMAIN_TOOL_NAMES` and passed in both of its branches (Task 8); `MentionResult.key`/`slug` (Task 11) are consumed by `RichMentionInput` (Task 13); `send(message, { mentions })` (Task 13) matches `ProviderMentionInput`; `AnyToolResultRenderer` and `ToolResultRendererRegistry` (Task 14) match the provider and context fields (Task 15); `themeScope: 'inherit'` (Task 17) is what the element sets (Task 22); `VoicePushToTalkConfig` and `retryRecordingAriaLabel` (Task 20) match `VoiceInputAddon`; `usePushToTalkHotkey` options (Task 19) match its call in Task 20; `GlirastesChatElement.transport` (Task 22) is what the harness sets (Task 25).

**Spec ambiguities resolved in this plan**

1. "Standalone too (today only managed)": the standalone runtime source already enters through `managedRuntime`; the real gap is the `!managedTurn` early return. Apps without any runtime source now get registry discovery; `toolDiscovery` stays opt-in so existing static scoping is unchanged.
2. Synonyms are search-only input keyed by model-facing name (`toolSemantics`), not a new field on the signed manifest contract; P05 feeds them from `tool-semantics.json`.
3. Clarification is opt-in per handler (`clarification: {}`) like `followups`, so default tool lists and existing tests stay unchanged. The answer travels as an invisible `<!--glirastes:clarification {...}-->` marker because `<!--context:...-->` blocks are stripped by mention serialization; the server rewrites only the model copy of the latest message and keeps the client session untouched. Composer text sent while a question is open (≤ 1000 characters) counts as the answer.
4. Push-to-talk: button hold ≥ 350 ms stops on release, a shorter tap toggles; default hotkey `mod+shift+space`, and releasing any combo key ends the hold (macOS swallows keyup under ⌘). Route change uses an explicit `voice.routeKey` plus `popstate`/`hashchange`, not the Navigation API, which would also fire on `replaceState` filter updates (nuqs). Route and session changes stop and keep the speech as draft instead of discarding it.
5. Embedding: `styles.css` sets `--cm-*` on the panel itself, so host variables could never reach it; the element uses `themeScope: 'inherit'` and maps public `--glirastes-chat-*` variables onto `--cm-*`. The subpath is ESM-only like `./react` and safe to import during bundler-driven SSR (Next, Nuxt, Vite; pinned by `embed-module.test.ts`). Like `glirastes/react`, plain Node cannot load it, because `AiChatPanel` keeps its `import '../styles.css'` side effect (`ERR_UNKNOWN_FILE_EXTENSION`); in a bundled host that import also adds the data-attribute-scoped panel CSS to the document, which is harmless next to the shadow-root copy.
6. Renderer schema versions are selected by trying each registered version's `outputSchema`, newest first; no server-side version field is needed for old messages.

7. Follow-up suggestions (checker addition): before this plan, `defaultStreamHandler` wrapped `suggest_followups` with the managed guard and hybrid discovery kept only manifest-eligible names active. In a managed or standalone runtime, a follow-up tool missing from the manifest was therefore dropped from the active set (with `toolDiscovery`) or denied with `manifest_tool_unavailable` (without it). The Get It Done pilot only works today because its local inventory and runtime manifest carry `UI suggest_followups` as a manifest tool. P11 regenerates GID from app code, which has no reason to emit an SDK built-in. Task 8 therefore treats every name in `NON_DOMAIN_TOOL_NAMES` as a built-in. `suggest_followups` bypasses the guard and stays active under discovery when the pipeline selected it for the turn, pinned by the fourth `clarification-flow` test. Without discovery, pipeline scoping still decides whether the tool is offered.

**Gate alignment with P01 (checker note):** P07 branches after P01, so `bun run typecheck:tests` is part of every gate here (Task 0 baseline, every step that already ran `bun run typecheck`, Task 6 Step 4, Task 27 Step 1). Two test lines were written to satisfy it: `clarification-resume.test.ts` reads the untouched answer through `JSON.stringify(messages[2])`, and `clarification-flow.test.ts` types the pipeline mock parameter (`vi.fn(async (_userText: string) => …)`) so `mock.calls[0]![0]` is a `string`. Measured on the applied plan: these were the only two new `typecheck:tests` errors; everything else in `src/**` tests and `tests/**` matched the pre-P01 baseline of 92.
