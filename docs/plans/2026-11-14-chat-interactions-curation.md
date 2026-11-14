# Chat Interactions Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is TDD: write the failing test, see it fail for the stated reason, implement, see it pass, commit.

**Goal:** The derived `@` entities and `/` commands (P07b, `docs/plans/2026-10-05-mvp-plan-07b-mentions-commands.md`) become usable without hand-patching every label: German and English labels come from the tools' reviewed titles with a grammatical fallback, action labels stop being a bare path segment, chat-internal UI actions are not offered, a custom composer keeps the whole interaction logic through `useChatComposer()` or the slots of the SDK composer, and a new skill `curating-glirastes-chat-interactions` walks an app's coding agent through derive, review, override, wire, verify.

**Architecture:** Three work packages in this order.

- **WP1 Derivation quality (Tasks 1–5).** `.glirastes/tool-semantics.json` already carries a reviewed `title: { de, en }` per tool (Get It Done: 110 of 111 tools) and the setup artifact carries `presentation.singular` in the app's locale. Neither reaches `deriveChatInteractions` today. Task 1 copies the checked title into `.glirastes/tool-contracts.json` (optional `title`, next to `search`), so `refresh`, `check` and `check --integrity-only` all render labels from the same committed file and the module stays byte-stable. Task 2 adds a pure label module (`chat-labels.ts`: verb table, verb-object phrase, action decision table). Task 3 wires titles, entity nouns and the fallback into the derivation and orders destructive actions last. Task 4 leaves chat-internal client actions out. Task 5 derives an entity from a `/search` endpoint. No model call, no new input file, no change to the wire protocol (`ChatInteractionsData` stays as is).
- **WP2 Custom composers (Tasks 6–8).** The logic of `ProviderMentionInput` (`src/react/components/mention-input.tsx`; this is the composer `AiChatPanel` picks whenever completions exist, the plain `ChatInput` has none of it) moves into one hook, `useChatComposer()`. The SDK composer is rebuilt on that hook and gains optional props; a fully custom input uses the hook with `RichMentionInput`. Task 8 adds the cheap popover defaults.
- **WP3 Skill and docs (Tasks 9–10).** New skill, registered in the lint list and the `chat-ui` installer part, cross-referenced from the two existing skills, `docs/chat-interactions.md` and the READMEs.

**Tech stack:** TypeScript strict (NodeNext, `.js` import suffixes), Zod 4 (codegen only; `src/contracts/chat-*.ts` and `src/react/**` stay dependency-free), React 19, Vitest 4 with jsdom and Testing Library, Bun.

**Worktree:** `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation`, branch `feat/chat-interactions-curation` (from `origin/main`, 0.7.1). Every command below starts with an absolute `cd` into it.

## Findings from Get It Done (origin/staging) that shape the plan

| Observation | Cause | Handled in |
| --- | --- | --- |
| `de` equals `en` ("Task create dialog open") | labels are built from identifiers only; the tool titles ("Dialog Aufgabe anlegen") never reach the derivation | Tasks 1–3 |
| "Permanent" (`DELETE /api/tasks/:id/permanent`), "Attachable", "Subtasks" (`tasks.addSubtask`), "Activity" | `verbLabel` takes the trailing path segment as the whole label | Tasks 2–3 |
| `aiChat.open`, `commandPalette.open` offered inside the chat | every client action becomes a command | Task 4 |
| Only `task` is an `@` entity; no person, no team | **Not a derivation bug.** `GET /api/teams/members` and `GET /api/teams` declare and read no search parameter (`params.query: []`; the route ignores `?search=`, the old `mention-search.ts` got the unfiltered list). The one generic gap: `GET /api/users/search?name=` is skipped because its last segment is `search` and `name` is no search parameter | Task 5 (generic part); the app part is a checklist item of the skill (Task 9) |
| No `open.*` commands, filters ask for `params.locale` | every page is `/:locale/...` because `.glirastes/tools.json` sets no `stripSegments: ["[locale]"]` on `next-pages`/`url-filters` (already supported) | skill checklist (Task 9); no SDK change |
| The custom `ChatInput` calls `send(text)` without mentions and passes its own `onSearch` | the interaction logic lives only in `ProviderMentionInput` | Tasks 6–7 |
| `task` has 13 inline actions | derivation offers every item endpoint | skill checklist (hide to about five); see Open decisions |

Fixture reference (read only, never copied wholesale): `cd /Users/philipprollmann/Dev/chainmatics/get-it-done && git show origin/staging:.glirastes/tool-semantics.json`, `…:.glirastes/tool-contracts.json`, `…:src/generated/glirastes/tools.generated.ts`, `…:src/components/ai/chat-wrapper.tsx`.

## Global constraints

- No push, merge, npm publish or deploy. No edits outside this worktree; Get It Done and the Platform are read only. No secret is read or printed, no live model call.
- Bun only. Affected tests per task; the full suite runs in Task 0 and Task 11 only (`--maxWorkers=4`).
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution. Commit with explicit paths.
- Code comments: only a non-obvious "why", one or two lines. Do not rewrite existing comments.
- Byte stability: `deriveChatInteractions` stays a pure function of the setup artifact and the contracts entries. Anything a label needs must be in those two inputs. Sorting uses `compareCodeUnits`, never `localeCompare`.
- Backwards compatibility: every new prop, option and file field is optional; `ChatInteractionsData`, the override file format and the direct-command protocol do not change; `MentionInput`, `ChatInput` and `RichMentionInput` render the same DOM when no new prop is set. Two visible changes are intended and go into the CHANGELOG: derived labels change (overrides still win), and `ChatLocale` gains one required key.
- `tests/chat-interactions-next.test.ts` and the browser proofs need a built SDK (`assertBuiltSdk`): run `bun run build` before them.

## Out of scope

- A `destructive` flag in the protocol, a different look for destructive actions, a cap or submenu for many entity actions.
- Client-side filtering of list endpoints without a search parameter (teams, saved views); the skill points to `defineChatEntity` or to adding the parameter.
- Translating nouns in fallback labels and argument labels ("Assignee id"); titles and overrides cover it.
- Umlaut-tolerant matching inside the app's own entity search endpoints.
- Ambient path parameters; `stripSegments` already solves the locale case.
- Changing the overall completion caps (8 per provider, 12 in all already meet "6–8 hits" for the interaction providers).
- Migrating Get It Done itself; that is consumer work after a staging release (see the last section).

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/codegen/tools/types.ts`, `src/codegen/tools/files.ts` | Modify (Task 1) | optional `title?: { de?: string; en?: string }` on `ToolContractsEntry` and in `ToolContractsFileSchema` |
| `src/codegen/tools/semantics.ts` | Modify (Task 1) | `semanticsTitle(entry)` |
| `src/codegen/tools/pipeline.ts` | Modify (Task 1) | write `title` into the contracts entry |
| `src/codegen/tools/chat-labels.ts` (+ `.test.ts`) | Create (Task 2) | `VERBS`, `identifierWords`, `phraseLabel`, `actionLabel`, `commandLabel`, `humanizeIdentifier` (moved) |
| `src/codegen/tools/chat-interactions.ts` (+ `.test.ts`) | Modify (Tasks 3–5) | titles, entity nouns, destructive last, chat-internal filter, `/search` endpoints |
| `tests/chat-interactions-next.test.ts` | Modify (Task 3) | new default labels, title end to end with `check`/`integrity` |
| `src/react/hooks/use-chat-composer.tsx` (+ `__tests__/use-chat-composer.test.tsx`) | Create (Task 6) | `useChatComposer`, `ChatComposer`, `ChatComposerControls` |
| `src/react/components/mention-input.tsx` | Modify (Tasks 6–7) | `ProviderMentionInput` on the hook, new props |
| `src/react/components/rich-mention-input.tsx` | Modify (Tasks 7–8) | `wrapperClassName`, group headings, `emptyLabel` |
| `src/react/types.ts`, `src/react/index.ts` | Modify (Tasks 6–8) | prop and locale types, exports |
| `src/react/components/__tests__/mention-input-slots.test.tsx` | Create (Task 7) | slot behaviour |
| `src/react/completions/completion-search.ts`, `src/react/interactions/registry.ts` (+ tests) | Modify (Task 8) | `group`, umlaut folding |
| `src/react/provider/ai-chat-provider.tsx`, `src/react/locale-de.ts`, `src/react/styles.css`, `src/embed/chat-styles.generated.ts` | Modify (Task 8) | `completionEmptyLabel`, heading and empty-state styles (regenerated embed styles) |
| `skills/curating-glirastes-chat-interactions/SKILL.md` | Create (Task 9) | the workflow |
| `src/cli/commands/installer-parts.ts`, `skill-lint.test.ts`, `installer-parts.test.ts`, `install-skills.test.ts`, `src/cli/installer-e2e.test.ts`, `tests/skill-scenarios.test.ts` | Modify (Task 9) | registration, lint, scenario |
| `skills/building-glirastes-chat-ui/SKILL.md`, `skills/describing-glirastes-tools/SKILL.md`, `skills/README.md`, `README.md`, `docs/chat-interactions.md`, `src/cli/commands/setup-skill-workflow.test.ts` | Modify (Task 10) | cross-references and the changed facts |
| `CHANGELOG.md` | Modify (Task 11) | `[Unreleased]` |

---

## Task 0: Baseline

- [ ] `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && git status --short && bun install --frozen-lockfile`
- [ ] `bun run typecheck && bun run typecheck:tests && bun run build && bunx vitest run --maxWorkers=4` — record the pass count; a red baseline stops the plan (report, do not fix here).

No commit.

---

## Task 1: Carry the checked tool title into `tool-contracts.json`

**Files:** `src/codegen/tools/types.ts`, `src/codegen/tools/files.ts`, `src/codegen/tools/semantics.ts`, `src/codegen/tools/pipeline.ts`; tests `src/codegen/tools/semantics.test.ts`, `src/codegen/tools/pipeline.test.ts`.

**Failing tests first**

1. `semantics.test.ts`, next to the `semanticsSearch` test:
   - `semanticsTitle({ title: { de: ' Aufgabe anlegen ', en: 'Create task' } })` equals `{ de: 'Aufgabe anlegen', en: 'Create task' }`.
   - `semanticsTitle({ title: { de: 'Aufgabe\u0007' , en: 'Create task' } })` equals `{ en: 'Create task' }` (a control character drops that language, not the entry).
   - `semanticsTitle({})`, `semanticsTitle(undefined)` and `semanticsTitle({ title: {} })` are `undefined`.
2. `pipeline.test.ts`, in `'carries checked synonyms and examples into the contracts file, the module and the tool view'`: add `title: { de: 'Aufgaben auflisten', en: 'List tasks' }` to the semantics entry and `title: 'agent'` to its `origin`; assert `entry?.title` equals `{ de: 'Aufgaben auflisten', en: 'List tasks' }` and that `runToolsPipeline({ root, mode: 'frozen' })` and `{ mode: 'integrity' }` both return `driftPaths` `[]`.
3. Same file, new test `'leaves the title out when the semantics entry is rejected or has none'`: after a refresh without a semantics file no contracts entry has a `title` key (`Object.hasOwn(entry, 'title')` is false for all), so existing apps without titles get a byte-identical contracts file.

**Implementation notes**

- `types.ts`: `export interface ToolTitle { de?: string; en?: string }` and `title?: ToolTitle` on `ToolContractsEntry`.
- `files.ts`: `const ToolTitleSchema = z.object({ de: z.string().min(1).max(200).optional(), en: z.string().min(1).max(200).optional() }).strict();` and `title: ToolTitleSchema.optional()` in the tools entry (after `search`). `toToolContractsEntry` keeps type-checking; that is the compile-time proof the schema matches the interface.
- `semantics.ts`: `export function semanticsTitle(entry: ToolSemanticsEntry | undefined): ToolTitle | undefined` — per language of `SEMANTICS_LANGUAGES`: trim, keep when non-empty, at most `SEMANTICS_LIMITS.title` and without `/[\u0000-\u001F]/`; `undefined` when no language is left.
- `pipeline.ts` (around the `semanticsSearch(semantics.entry)` call): `const title = semanticsTitle(semantics.entry);` and `...(title ? { title } : {})` in the pushed contracts entry. `semantics.entry` is the checked entry, so a rejected entry contributes nothing.
- The setup artifact is not touched (it syncs to the Platform under a strict schema).

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/codegen/tools/semantics.test.ts src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline-integrity.test.ts && bun run typecheck`

**Commit:** `feat(tools): carry checked tool titles into tool-contracts.json`

---

## Task 2: Label module with verb table and verb-object order

**Files:** create `src/codegen/tools/chat-labels.ts`, `src/codegen/tools/chat-labels.test.ts`.

**API**

```ts
export interface Label { en: string; de: string }
export const VERBS: Readonly<Record<string, Label>>;
export function humanizeIdentifier(value: string): string;            // moved unchanged from chat-interactions.ts
export function identifierWords(value: string): string[];             // 'taskCreateDialog.open' -> ['task','create','dialog','open']
export function phraseLabel(words: ReadonlyArray<string>, fallbackVerb?: string): Label | undefined;
export function commandLabel(id: string, title?: ToolTitle): Label;   // client actions
export function actionLabel(input: { definitionId: string; method?: string; trailingSegment?: string; title?: ToolTitle }): Label;
```

**Verb table** (key → en / de; several keys may share a value; the existing eight keep their texts):

| Keys | en | de |
| --- | --- | --- |
| `get`, `show`, `view`, `list`, `read` | Show | Anzeigen |
| `check` | Check | Prüfen |
| `open` | Open | Öffnen |
| `create`, `new` | Create | Erstellen |
| `add` | Add | Hinzufügen |
| `update`, `edit`, `change` | Edit | Bearbeiten |
| `set` | Set | Setzen |
| `delete`, `destroy` | Delete | Löschen |
| `remove` | Remove | Entfernen |
| `complete` / `archive` / `assign` / `close` / `reopen` | Complete / Archive / Assign / Close / Reopen | Erledigen / Archivieren / Zuweisen / Schließen / Wieder öffnen |
| `apply` | Apply | Anwenden |
| `switch` | Switch | Wechseln |
| `refresh`, `reload` | Refresh | Aktualisieren |
| `restore` | Restore | Wiederherstellen |
| `duplicate`, `copy`, `clone` | Duplicate | Duplizieren |
| `convert` | Convert | Umwandeln |
| `move` | Move | Verschieben |
| `share` / `invite` / `send` / `save` | Share / Invite / Send / Save | Teilen / Einladen / Senden / Speichern |
| `import` / `export` / `upload` / `download` | Import / Export / Upload / Download | Importieren / Exportieren / Hochladen / Herunterladen |
| `search`, `find` | Search | Suchen |
| `filter` | Filter | Filtern |
| `select` | Select | Auswählen |
| `toggle` | Toggle | Umschalten |
| `start` / `stop` / `cancel` | Start / Stop / Cancel | Starten / Stoppen / Abbrechen |
| `approve` / `reject` | Approve / Reject | Freigeben / Ablehnen |
| `publish` / `sync` / `reset` / `rename` | Publish / Sync / Reset / Rename | Veröffentlichen / Synchronisieren / Zurücksetzen / Umbenennen |
| `pin` / `unpin` / `highlight` | Pin / Unpin / Highlight | Anheften / Lösen / Hervorheben |

Declare it with `Object.freeze` and look keys up with `Object.hasOwn` (an identifier word such as `constructor` must not hit the prototype).

**Rules**

- `phraseLabel(words, fallbackVerb)`: the verb is the last word if it is in `VERBS`, else the first word if it is, else `fallbackVerb`; without any verb return `undefined`. The object is the remaining words joined by a space. English: `"<Verb> <object>"` ("Open task create dialog"). German: `"<Object> <verb lowercase>"` with the object's first letter upper-cased ("Task create dialog öffnen"). Without an object: the verb alone in both languages.
- `commandLabel(id, title)`: per language `title[lang] ?? phraseLabel(identifierWords(id))?.[lang] ?? humanizeIdentifier(id)`.
- `actionLabel`: per language the title wins; the fallback is this table, first match:

| # | Condition | Fallback label | Example |
| --- | --- | --- | --- |
| 1 | the last id segment has several words and one of them (last or first) is a verb | `phraseLabel(tailWords)` | `tasks.permanentDelete` → Delete permanent / Permanent löschen; `tasks.addSubtask` → Add subtask / Subtask hinzufügen; `tasks.getActivity` → Show activity / Activity anzeigen |
| 2 | a trailing path segment whose first or last word is a verb | `phraseLabel(segmentWords)` | `/complete` → Complete / Erledigen; `/convert-to-team` → Convert to team / To team umwandeln |
| 3 | trailing segment, method `GET`/`HEAD` | `phraseLabel(segmentWords, 'show')` | `/attachable` → Show attachable / Attachable anzeigen |
| 4 | trailing segment, method `DELETE` | `phraseLabel(segmentWords, 'delete')` | `/permanent` → Delete permanent / Permanent löschen |
| 5 | trailing segment is plural (its last word differs from its singular), method `POST` | `phraseLabel(words with the last one singular, 'add')` | `/subtasks` → Add subtask / Subtask hinzufügen |
| 6 | trailing segment is plural, method `PUT`/`PATCH` | `phraseLabel(segmentWords, 'update')` | `/reminders` → Edit reminders / Reminders bearbeiten |
| 7 | any other trailing segment | `humanizeIdentifier(segment)` in both languages (today's behaviour) | `/pin` on an id ending in `create` → Pin (via rule 2 once `pin` is a verb: Pin / Anheften) |
| 8 | no trailing segment | `VERBS[tail]` or `humanizeIdentifier(tail)` | `tasks.update` → Edit / Bearbeiten |

  Rule 5 needs the `singular` helper: move `singular` and `IRREGULAR` from `chat-interactions.ts` into `chat-labels.ts` and import them back.
- Every result is clamped to `CHAT_INTERACTION_LIMITS.labelLength` by the caller (Task 3), not here.

**Failing tests first** (`chat-labels.test.ts`; assert whole `{ en, de }` objects)

- `identifierWords('taskCreateDialog.open')` → `['task','create','dialog','open']`; `identifierWords('convert-to-team')` → `['convert','to','team']`.
- `commandLabel('taskCreateDialog.open')` → `{ en: 'Open task create dialog', de: 'Task create dialog öffnen' }`; `'tasks.filters.apply'` → `Apply tasks filters` / `Tasks filters anwenden`; `'tasks.view.switch'` → `Switch tasks view` / `Tasks view wechseln`; `'dashboard.refresh'` → `Refresh dashboard` / `Dashboard aktualisieren`; `'action.navigate'` → `Action navigate` in both (no verb).
- `commandLabel('taskCreateDialog.open', { de: 'Dialog Aufgabe anlegen' })` → `{ en: 'Open task create dialog', de: 'Dialog Aufgabe anlegen' }` (per-language fallback).
- `actionLabel` for each example row of the table above, plus: `{ definitionId: 'tasks.permanentDelete', method: 'DELETE', trailingSegment: 'permanent', title: { de: 'Aufgabe endgültig löschen', en: 'Permanently delete task' } }` returns the title; `{ definitionId: 'tasksAttachable.list', method: 'GET', trailingSegment: 'attachable' }` → `Show attachable` / `Attachable anzeigen`; `{ definitionId: 'tasks.complete', method: 'POST', trailingSegment: 'complete' }` → `Complete` / `Erledigen`; `{ definitionId: 'tasks.constructor' }` → `Constructor` in both.
- `humanizeIdentifier` keeps its three existing expectations.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/codegen/tools/chat-labels.test.ts`

**Commit:** `feat(tools): add verb-object label rules for chat interactions`

---

## Task 3: Use titles, entity nouns and the new fallback in the derivation

**Files:** `src/codegen/tools/chat-interactions.ts`, `src/codegen/tools/chat-interactions.test.ts`, `tests/chat-interactions-next.test.ts`.

**Failing tests first** (`chat-interactions.test.ts`)

Extend the local `Spec` with `title?: ToolTitle`, `presentation?: { locale: string; singular: string; plural: string; approval: string }` and `riskClass?: string`; `catalog()` puts `title` on the contracts entry, `presentation` and `riskClass` on the artifact tool.

1. `'labels commands, actions and entities from titles and the presentation noun'` — a catalog shaped like Get It Done:
   - `tasks.list` (`GET /api/tasks`, as `SPECS[0]`) with `presentation: { locale: 'de-DE', singular: 'Aufgabe', plural: 'Aufgaben', approval: 'Aufgaben abrufen?' }`;
   - `tasks.permanentDelete` (`DELETE /api/tasks/:id/permanent`, `riskClass: 'delete'`, title `{ de: 'Aufgabe endgültig löschen', en: 'Permanently delete task' }`);
   - `tasks.addSubtask` (`POST /api/tasks/:id/subtasks`, input `id` and required string `title`, no tool title);
   - `tasksAttachable.list` (`GET /api/tasks/:id/attachable`, no title);
   - `tasks.delete` (`DELETE /api/tasks/:id`, `riskClass: 'delete'`, no title);
   - `ui.taskCreateDialog.open` (client action `task-create-dialog.open`, title `{ de: 'Dialog Aufgabe anlegen', en: 'Open create-task dialog' }`);
   - `ui.tasks.view.switch` (client action, no title);
   - `ui.filter.tasks` with title `{ de: 'Aufgaben filtern' }`.

   Assert:
   - `entities[0].label` equals `{ en: 'Task', de: 'Aufgabe' }`;
   - the action labels by id: `task.tasks.permanentDelete` → `{ en: 'Permanently delete task', de: 'Aufgabe endgültig löschen' }`, `task.tasks.addSubtask` → `{ en: 'Add subtask', de: 'Subtask hinzufügen' }`, `task.tasksAttachable.list` → `{ en: 'Show attachable', de: 'Attachable anzeigen' }`, `task.tasks.delete` → `{ en: 'Delete', de: 'Löschen' }`;
   - the action id order is `['task.tasks.addSubtask', 'task.tasksAttachable.list', 'task.tasks.delete', 'task.tasks.permanentDelete']` (destructive last, each half in code-unit order);
   - commands: `taskCreateDialog.open` → the title in both languages, `tasks.view.switch` → `{ en: 'Switch tasks view', de: 'Tasks view wechseln' }`, `filter.tasks` → `{ en: 'Filter Tasks', de: 'Aufgaben filtern' }`.
2. `'falls back per language and ignores a title the list cannot show'`: a title with only `en` keeps the derived `de`; a title of 201 characters is clamped to 200 with `…`; the entry is still derived.
3. `'uses the presentation noun only in its own language'`: `presentation.locale: 'en-US', singular: 'To-do'` gives `{ en: 'To-do', de: 'Task' }`; no presentation gives `{ en: 'Task', de: 'Task' }` (today's value).
4. Update the existing big expectation: `tasks.highlight` becomes `{ en: 'Highlight tasks', de: 'Tasks hervorheben' }`. Every other label in that test stays as it is (proves the fallback is unchanged for `Assign`, `Complete`, `Edit`, `Open`, navigation and filters).
5. The existing byte-stability tests (`'is a pure function…'`, `'derives the same data from the observed contracts and from tool-contracts.json'`) run with the new specs added to their input.

`tests/chat-interactions-next.test.ts`:

6. Update `tasks.highlight` in the first test to the new label.
7. New test `'labels an action from a reviewed title and keeps check and integrity green'`: `copyApp(NATIVE_APP)`, `addNotes(root)`, write `.glirastes/tool-semantics.json` with `{ schemaVersion: 1, tools: [{ stableKey: 'POST /api/notes/:id/pin', title: { de: 'Notiz anheften', en: 'Pin note' } }] }`, run `write`; the action `note.notesPin.create` has `label: { en: 'Pin note', de: 'Notiz anheften' }`; `frozen` and `integrity` return `driftPaths` `[]`. (Without the title the second existing test now expects `{ en: 'Pin', de: 'Anheften' }`; update it.)

**Implementation notes**

- `BoundTool` gains `title?: ToolTitle`, `riskClass: string` and `noun?: { language: 'de' | 'en'; text: string }`. Fill them in the `tools` mapping: `title` from the contracts entry, `riskClass` from the artifact tool, `noun` from `tool.presentation` (`language` is `'de'` when `presentation.locale.toLowerCase().startsWith('de')`, `'en'` when it starts with `en`, otherwise no noun).
- A local `safe(text)` returns `undefined` for a blank string or one with `/[\u0000-\u001F]/`, else `clamp(text)`; apply it to every title and noun before use, so a bad text falls back instead of dropping the entry in `carries`.
- Entity label in `searchEntity`: `{ en: noun?.language === 'en' ? noun.text : label, de: noun?.language === 'de' ? noun.text : label }`.
- Replace `verbLabel` with `actionLabel({ definitionId, method, trailingSegment: match[2], title })`; client-action commands use `commandLabel(id, title)`; filter commands use `title?.[lang] ?? <today's text>`; clamp all.
- Destructive last: `const destructive = (toolName) => riskClass === 'delete' || method === 'DELETE'`; keep a `Map<actionId, boolean>` while adding actions and sort the final list with `(Number(a) - Number(b)) || compareCodeUnits(left.id, right.id)` before the `actionsPerEntity` slice. `task.open` (a `ui` run) is never destructive.
- `humanizeIdentifier` is imported from `chat-labels.ts` and re-exported from `chat-interactions.ts` (the test imports it from there).
- Update the doc comment of `deriveChatInteractions`: labels come from the tool title and presentation noun where the app has them, else from identifiers.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/codegen/tools/chat-interactions.test.ts src/codegen/tools/chat-labels.test.ts src/codegen/tools/emit-module-chat.test.ts src/codegen/tools/emit-module.test.ts && bun run build && bunx vitest run tests/chat-interactions-next.test.ts && bun run typecheck:tests`

**Commit:** `feat(tools): label derived chat interactions from tool titles`

---

## Task 4: Leave chat-internal client actions out of the `/` list

**Files:** `src/codegen/tools/chat-interactions.ts`, `src/codegen/tools/chat-interactions.test.ts`.

**Rule:** a client action is chat-internal when its `uiAction.actionId` matches `/^(?:ai-?chat|chat|assistant|command-?palette|command-?menu|cmdk)(?:[.\-_]|$)/i` (exported as `CHAT_INTERNAL_ACTION`). Such a tool derives no command. It stays a tool for the model. Override: a complete entry in `.glirastes/chat-interactions.json` (`{ "aiChat.open": { "label": …, "run": { "kind": "ui", "tool": "ui.aiChat.open" } } }`) adds it back through the existing merge; no new file field.

**Failing tests first**

1. `'does not offer the chat window or the command palette inside the chat'`: client actions `ai-chat.open` (`ui.aiChat.open`), `command-palette.open` (`ui.commandPalette.open`), `chat.clear` (`ui.chat.clear`) and `chatbot-settings.open` (`ui.chatbotSettings.open`) → `commands.map(id)` equals `['chatbotSettings.open']` (the pattern needs a separator after the word).
2. `'lets an override add a chat-internal action back'`: `mergeChatInteractions(derived, parseChatInteractionOverrides({ schemaVersion: 1, commands: { 'aiChat.open': { label: 'KI-Chat öffnen', run: { kind: 'ui', tool: 'ui.aiChat.open' } } } }))` lists `aiChat.open` and logs no stale-patch warning (`vi.spyOn(console, 'warn')` not called).

**Implementation:** in the client-action branch of the commands loop, `if (action.kind === 'client-action' && CHAT_INTERNAL_ACTION.test(action.actionId)) continue;` before `argsFor`.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/codegen/tools/chat-interactions.test.ts`

**Commit:** `feat(tools): hide chat-internal ui actions from derived commands`

---

## Task 5: Derive an entity from a `/search` endpoint

**Files:** `src/codegen/tools/chat-interactions.ts`, `src/codegen/tools/chat-interactions.test.ts`.

**Rule:** when the last static segment of a parameter-free read path is `search`, the entity type comes from the segment before it and the collection for actions is the parent path; on such a path `name` is accepted as the search parameter after `search`, `q`, `query`, `term`. Everything else (output list, id and label fields, one entity per type with the code-unit-first search path winning) is unchanged, so `/api/users?search=` still beats `/api/users/search`.

**Failing tests first**

1. `'derives an entity from a search endpoint and hangs item actions on its collection'`: `users.search` (`GET /api/users/search`, `params.query: ['email', 'name', 'teamId']`, output `{ users: [{ id, displayName, email, role }], count: number }`), `users.updateRole` (`PATCH /api/users/:id/role`, input `id` and string enum `role`), `users.delete` (`DELETE /api/users/:id`, `riskClass: 'delete'`). Expect one entity: `type: 'user'`, `search: { tool: 'users.search', path: '/api/users/search', queryParam: 'name', itemsPath: ['users'], idField: 'id', labelField: 'displayName', descriptionField: 'email' }`, actions `['user.users.updateRole', 'user.users.delete']`.
2. `'accepts name as a search parameter only on a search endpoint'`: `GET /api/reports?name=` (no `/search`) derives no entity.
3. `'prefers the collection search over a search endpoint of the same type'`: with both `GET /api/users?q=` and `GET /api/users/search?name=`, `search.path` is `/api/users`.
4. `'derives nothing from a bare /search path'`: `GET /search?q=` has no segment before `search` → no entity.

**Implementation notes**

- In `searchEntity`: `const isSearchPath = segments.at(-1) === 'search' && segments.length > 1;` the type segment is `segments.at(isSearchPath ? -2 : -1)`; the preferred list name is that segment too; `queryParam` is searched in `isSearchPath ? [...SEARCH_PARAMS, 'name'] : SEARCH_PARAMS`.
- `SearchCandidate` gains `collection: string` (`tool.path` without the trailing `/search`); the actions loop builds its regular expression from `candidate.collection` instead of `entity.search.path`. The duplicate sort keeps using `entity.search.path`.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/codegen/tools/chat-interactions.test.ts && bun run typecheck`

**Commit:** `feat(tools): derive chat entities from search endpoints`

---

## Task 6: `useChatComposer()` and the SDK composer built on it

**Files:** create `src/react/hooks/use-chat-composer.tsx`, `src/react/hooks/__tests__/use-chat-composer.test.tsx`; modify `src/react/components/mention-input.tsx`, `src/react/index.ts`.

**API**

```ts
export interface UseChatComposerOptions {
  /** Called instead of `send`; the composer clears afterwards. */
  onSubmit?: (message: string, mentions: MentionData[]) => void;
  /** Text put into the editor once on mount, after `initialMentions` of the input. */
  initialValue?: string;
}

export interface ChatComposerControls {
  /** Current text including `@`/`/` tokens. */
  readonly value: string;
  readonly isLoading: boolean;
  /** Non-blank text and not loading. */
  readonly canSend: boolean;
  /** Sends editor text and structured mentions; false when nothing was taken (the text stays). */
  submit(): boolean;
  stop(): void;
  /** Replaces the text; references whose token is not in it are dropped. */
  setText(text: string): void;
  /** Appends with one space, e.g. a voice transcript; references stay. */
  appendText(text: string): void;
  focus(): void;
}

export interface ChatComposer extends ChatComposerControls {
  /** `<RichMentionInput ref={composer.inputRef} {...composer.inputProps} />` */
  readonly inputRef: RefObject<RichMentionInputHandle | null>;
  readonly inputProps: Pick<RichMentionInputProps,
    'onChange' | 'onSubmit' | 'onSearch' | 'onEntityAction' | 'placeholder' | 'disabled' | 'listLabel' | 'resultsLabel'>;
  readonly pendingCommand: PendingChatCommand | null;
  submitPendingCommand(values: Readonly<Record<string, string>>, valueLabels?: Readonly<Record<string, string>>): boolean;
  cancelPendingCommand(): void;
  /** The argument form (`components.CommandArgumentsForm` or the default), `null` when nothing is pending. */
  readonly argumentsForm: ReactNode;
}

export function useChatComposer(options?: UseChatComposerOptions): ChatComposer;
```

**Failing tests first** (`use-chat-composer.test.tsx`, jsdom; reuse the `task` entity, `commands`, `transport()`, `typeInto` and the `afterEach` frame flush of `chat-interactions-composer.test.tsx`). The component under test is a hand-built composer, the shape Get It Done has:

```tsx
function Custom() {
  const composer = useChatComposer();
  return (
    <form onSubmit={(event) => { event.preventDefault(); composer.submit(); }}>
      {composer.argumentsForm}
      <RichMentionInput ref={composer.inputRef} {...composer.inputProps} />
      <button type="button" onClick={() => composer.appendText('diktiert')}>mic</button>
      <button type="submit" disabled={!composer.canSend}>go</button>
    </form>
  );
}
```

1. `'runs a picked command without the model from a custom composer'`: type `/open`, Enter (pick), click `go` → `chat.sendMessage` called once and `parseChatCommandMessage(text)?.invocation` equals `{ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } }`; the editor is empty afterwards.
2. `'runs an entity action picked in a custom composer'`: type `@rel`, click the option named `Complete: Release prüfen` → one `sendMessage` whose invocation is `{ commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } }`.
3. `'shows the argument form for a command that needs values and sends after it'`: add `defineChatCommand({ id: 'tasks.rename', label: 'Rename', args: [{ name: 'title', label: 'Title', required: true }], run: { kind: 'tool', tool: 'tasks.rename' } })`; pick it and submit → `container.querySelector('[data-component="command-arguments"]')` exists and nothing was sent; fill the field, submit the form → one `sendMessage` with `args: { title: 'Neu' }` and the form is gone.
4. `'keeps a picked command when text is appended'`: pick `/open`, click `mic` → `composer.inputRef.current!.getMentions()` (read through a ref probe) still contains `{ type: 'command', id: 'open.overview' }` and the editor text ends with `diktiert`.
5. `'inserts references requested through mentionEntity'`: `await act(() => context!.mentionEntity('task', '7'))` → the editor contains `[data-mention-id="7"]`.
6. `'puts the initial text into the editor once'`: `useChatComposer({ initialValue: 'Hallo' })` → editor text `Hallo`, `canSend` true (the `go` button is enabled); a rerender does not write it again after the user cleared the editor.
7. `'reports whether the message was taken'`: with an open approval in the transport fixture (same setup as `approval-lifecycle.test.tsx`) `submit()` returns false and the text stays.

**Implementation notes**

- Move the body of `ProviderMentionInput` into the hook unchanged in behaviour: the `composerMentions` effect, `submit(text, mentions)` (the internal `submitText`), `ArgumentsForm` selection with the same `key`, and the two focus rules of the form callbacks. `inputProps.onSubmit` is `(text, mentions) => { submitText(text, mentions); }` (the editor clears itself on Enter, as today); `submit()` reads `handle.getValue()`/`handle.getMentions()` and calls `handle.clear()` on success.
- `appendText` is today's voice `onTranscript` body; `setText(text)` is `handle.setValue(text, handle.getMentions())`; both call the hook's `setValue` state with `handle.getValue()`.
- `initialValue`: a mount-only effect (ref guard) that reads the handle's current value and mentions (the input's own `initialMentions` effect has already run, child effects first) and calls `handle.setValue(prefix ? `${prefix} ${initialValue}` : initialValue, mentions)`.
- `ProviderMentionInput` becomes: `const composer = useChatComposer({ onSubmit: onSubmit ? (message) => onSubmit(message) : undefined });` plus the JSX it has today, reading `composer.*`. Its DOM does not change.
- `src/react/index.ts`: export `useChatComposer` and the types `UseChatComposerOptions`, `ChatComposer`, `ChatComposerControls`.
- The hook works without completions too: `inputProps.onSearch` is then `undefined` and `RichMentionInput` runs in plain mode.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/react/hooks/__tests__/use-chat-composer.test.tsx src/react/components/__tests__/chat-interactions-composer.test.tsx src/react/components/__tests__/completion-composer.test.tsx src/react/components/__tests__/command-arguments-form.test.tsx src/react/components/__tests__/voice-draft.test.tsx src/react/provider/__tests__/mention-draft.test.tsx && bun run typecheck && bun run typecheck:tests` — the five existing suites pass without an edit; that is the compatibility proof.

**Commit:** `feat(react): add useChatComposer for custom chat inputs`

---

## Task 7: Slots on the SDK composer

What Get It Done's `chat-wrapper.tsx` needs, and where it goes:

| Need in `CustomChatInput` | Slot |
| --- | --- |
| `initialMentions` (task chip), re-mount per task | `MentionInputProps.initialMentions`; the app keys `<MentionInput key={taskId}>` |
| `initialSuggestion` written with `setValue` | `MentionInputProps.initialValue` |
| `components={{ DropdownItem: MentionDropdownItem }}` | `MentionInputProps.components.DropdownItem`, and `ChatComponents.MentionDropdownItem` for `VercelAiChat`/`AiChatProvider` without a wrapper |
| own microphone button writing a transcript, `RecordingBar` | `renderActions(composer)` with `composer.appendText`/`setText` (first choice stays the built-in `voice={{ enabled: true, adapter, baseUrl, getToken }}`) |
| icon send and stop buttons | `renderSubmit(composer)` |
| Tailwind classes on the form, the input box and the editor | `className` (exists), `inputClassName`, `editorClassName` |

**Files:** `src/react/types.ts`, `src/react/components/mention-input.tsx`, `src/react/components/rich-mention-input.tsx`; create `src/react/components/__tests__/mention-input-slots.test.tsx`.

**Types** (`types.ts`; all optional)

```ts
export interface MentionInputProps {
  className?: string;
  onSubmit?: (message: string) => void;
  initialValue?: string;
  initialMentions?: MentionData[];
  /** Class of the box around editor, placeholder and list. */
  inputClassName?: string;
  /** Class of the editable element. */
  editorClassName?: string;
  components?: RichMentionInputComponents;
  /** Extra controls between the editor and the send button, e.g. the app's own microphone. */
  renderActions?: (composer: ChatComposerControls) => ReactNode;
  /** Replaces the default send and stop buttons; a `type="submit"` button sends. */
  renderSubmit?: (composer: ChatComposerControls) => ReactNode;
}
// ChatComponents: MentionDropdownItem?: ComponentType<MentionDropdownItemProps>;
// RichMentionInputProps: wrapperClassName?: string;
```

`ChatInputProps` stays as it is; `AiChatPanel` keeps rendering `<InputComponent />` without props, so an app passes the props through `components.ChatInput: () => <MentionInput … />`.

**Failing tests first** (`mention-input-slots.test.tsx`; provider with `chatInteractions={{ entities: [task], commands }}` as in Task 6)

1. `'renders the app item for suggestions, from the prop and from the provider'`: `<MentionInput components={{ DropdownItem: Item }} />` where `Item` renders `<button {...optionProps} data-testid="app-item" onClick={onClick}>{result.label}</button>`; typing `/open` shows two `app-item` elements that are `role="option"`. Second case: no prop, `components={{ MentionDropdownItem: Item }}` on `AiChatProvider` → same; with both, the prop wins.
2. `'hands the composer to extra actions'`: `renderActions={(composer) => <button type="button" onClick={() => composer.appendText('diktiert')}>mic</button>}` → after a click the editor text is `diktiert`, the `mic` button sits inside the form before `[data-action="send"]`, and the send button is enabled.
3. `'replaces the send and stop buttons'`: `renderSubmit={(composer) => <button type="submit" aria-label="Senden" disabled={!composer.canSend} />}` → no `[data-action="send"]` in the DOM; typing `Hallo` and clicking `Senden` calls `sendMessage` once.
4. `'starts with a reference and a text'`: `initialMentions={[{ id: '7', type: 'task', label: 'Release prüfen' }]} initialValue="Was ist offen?"` → the editor contains `[data-mention-id="7"]` and the text; clicking send delivers a message whose text contains `mention:task:7` and `Was ist offen?`.
5. `'applies the class names'`: `inputClassName="box" editorClassName="edit"` → `[data-component="rich-mention-input"]` has class `box`, `[data-element="editor"]` has class `edit`.
6. `'renders the same composer without the new props'`: `<MentionInput />` → `[data-component="mention-input"][data-mode="providers"] form > [data-component="rich-mention-input"]` and a `[data-action="send"]` button with `locale.sendButton` as text.

**Implementation notes**

- `ProviderMentionInput`: pass `initialValue` to the hook; `initialMentions`, `wrapperClassName={inputClassName}`, `className={editorClassName}` and `components={{ DropdownItem: props.components?.DropdownItem ?? chat.components.MentionDropdownItem }}` (omit the prop when both are undefined) to `RichMentionInput`. Render order in the form: editor, built-in voice addon, `renderActions?.(composer)`, `InputExtra`, then `renderSubmit ? renderSubmit(composer) : <default buttons>`.
- `RichMentionInput`: `wrapperClassName` on the mention-mode wrapper `div` only (plain mode has no wrapper; there `className` already styles the element).
- `LegacyMentionInput` ignores the new props (documented in Task 10).

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/react/components/__tests__/mention-input-slots.test.tsx src/react/components/__tests__/chat-interactions-composer.test.tsx src/react/components/__tests__/completion-composer.test.tsx src/react/components/__tests__/rich-mention-input-whitespace.test.tsx src/react/components/__tests__/ai-chat-panel.test.tsx && bun run typecheck && bun run typecheck:tests`

**Commit:** `feat(react): add slots to the mention composer`

---

## Task 8: Popover defaults: groups, umlauts, empty state

Only what is cheap and generic. Already true and left alone: at most 8 hits per provider and 12 in all; destructive actions are confirmed by the server (`requiresApproval` or risk tier 3) on the direct-command path.

**Files:** `src/react/types.ts`, `src/react/completions/completion-search.ts`, `src/react/interactions/registry.ts`, `src/react/components/rich-mention-input.tsx`, `src/react/hooks/use-chat-composer.tsx`, `src/react/provider/ai-chat-provider.tsx`, `src/react/locale-de.ts`, `src/react/styles.css`, `src/embed/chat-styles.generated.ts`; tests `src/react/interactions/__tests__/registry.test.ts`, the completion-search test file next to `completion-search.ts` (create `src/react/completions/__tests__/completion-search-groups.test.ts` if none covers it), `src/react/components/__tests__/chat-interactions-composer.test.tsx`.

**Failing tests first**

1. Registry, `'finds commands with umlauts typed either way'`: commands labelled `Löschen`, `Schließen`, `Übersicht öffnen`; `search('loe', '/')`, `search('los', '/')` → `Löschen`; `search('ueber', '/')` and `search('uber', '/')` → `Übersicht öffnen`; `search('schliessen', '/')` → `Schließen`; `search('oeffnen', '/')` → `Übersicht öffnen`.
2. Registry, `'names the group of every hit'`: with `locale: 'de'` a command hit has `group: 'Befehle'` (`'Commands'` for `en`), an entity hit has `group` equal to the entity label in the locale (`'Task'` for the fixture). Add the `group` field to the existing strict `toEqual` expectations of this file.
3. Completion search, `'keeps the hits of a group together in first-seen order'`: one provider returning `[A1(group a), B1(group b), A2(group a), X(no group)]` → result order `A1, A2, B1, X`; a `group` that is blank, not a string or longer than 100 characters is dropped from the item while the item stays.
4. Composer, `'shows a heading per group only when there are several'`: add a second entity `person` to the fixture; `@r` with hits of both types renders two `[data-element="group-heading"]` (texts `Task`, `Person`), each directly before its first row; `screen.getAllByRole('option')` and the ArrowDown order follow the grouped order; `/open` (one group) renders no heading.
5. Composer, `'says so when nothing matches and how the list works'`: typing `/zzz` renders `[data-component="mention-dropdown"][data-state="empty"]` with the text `No matches. @ for things, / for commands`, no `listbox`, and the one `role="status"` element carries the same text; Escape or deleting the trigger removes it. With a bare `RichMentionInput` (no `emptyLabel`) nothing is rendered for an empty result (today's behaviour).

**Implementation notes**

- `types.ts`: `group?: string` on `CompletionItem` and `MentionResult` ("Heading the list shows above this hit's group"); `emptyLabel?: string` on `RichMentionInputProps`; `completionEmptyLabel: string` on `ChatLocale`.
- `completion-search.ts`: copy a valid trimmed `group`; after the collection loop, regroup stably by first appearance (`''` for no group) when at least one hit has a group. Regrouping happens after the `maxResults` cut.
- `registry.ts`: replace `fold` use in `rank` by two foldings, `fold` (today's) and `transliterate` (lowercase, then `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, then `fold`); `rank` returns the best rank over both `(label, needle)` pairs, with keywords and id checked under both as well. Set `group` in both providers; the command heading is `locale === 'de' ? 'Befehle' : 'Commands'`.
- `rich-mention-input.tsx`: `const showHeadings = new Set(searchResults.map((result) => result.group ?? '')).size > 1;` render `<div role="presentation" data-element="group-heading">` before a result whose `group` is set and differs from the previous result's. Indices and ARIA ids stay those of the flat array. Empty state: a `noMatches` state set in `performSearch` (`results.length === 0` for the current version), cleared in `closeDropdown` and on a new non-empty result; Escape clears it when no list is open; render the empty element only when `emptyLabel` is set; the live region text is `listOpen ? count text : noMatches && emptyLabel ? emptyLabel : ''`.
- `use-chat-composer.tsx`: add `emptyLabel: locale.completionEmptyLabel` to `inputProps` (and to its `Pick`).
- Locale: `completionEmptyLabel: 'No matches. @ for things, / for commands'` in the provider default, `'Keine Treffer. @ für Dinge, / für Befehle'` in `locale-de.ts`.
- `styles.css`: one rule for `[data-element="group-heading"]` (small, muted, non-interactive) and one for `[data-component="mention-dropdown"][data-state="empty"]`, both under the existing `:where(:not([data-unstyled], [data-unstyled] *))` prefix; then `node scripts/generate-embed-styles.mjs` (the build checks it with `--check`).

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && node scripts/generate-embed-styles.mjs --check && bunx vitest run src/react/interactions src/react/completions src/react/components/__tests__/chat-interactions-composer.test.tsx src/react/components/__tests__/completion-composer.test.tsx src/react/components/__tests__/mention-input-slots.test.tsx src/react/hooks/__tests__/use-chat-composer.test.tsx src/embed && bun run typecheck && bun run typecheck:tests`

**Commit:** `feat(react): group suggestions, fold umlauts and show an empty state`

---

## Task 9: Skill `curating-glirastes-chat-interactions`

**What a shipped skill must satisfy** (`src/cli/commands/__tests__/skill-lint.ts`, `install-skills.test.ts`):

- Frontmatter with exactly `name` and `description`, in that order; `name` equals the folder; `description` starts with `Use when` and contains no `: ` (it must stay a plain YAML scalar).
- The sections `## Boundaries`, `## Workflow`, `## Commands`, `## Verification` in this order; `## Commands` has one `bash` block whose lines are `glirastes …` commands the CLI knows (comments allowed).
- Every `glirastes tools <sub>` mentioned anywhere is a real subcommand; every `.glirastes/…` path is in `KNOWN_PATHS` (`.glirastes/chat-interactions.json`, `.glirastes/tool-semantics.json`, `.glirastes/tool-policy.json` and `.glirastes/tools.json` are).
- Contains the words `never calls a model`; no `--force`, no key, no decorators, no removed commands; under 400 lines.
- Every `glirastes tools …` line of the Commands block is executed by a scenario in `tests/skill-scenarios.test.ts`.

**Files:** create `skills/curating-glirastes-chat-interactions/SKILL.md`; modify `src/cli/commands/skill-lint.test.ts`, `src/cli/commands/installer-parts.ts`, `src/cli/commands/installer-parts.test.ts`, `src/cli/commands/install-skills.test.ts`, `src/cli/installer-e2e.test.ts`, `src/cli/commands/setup-skill-workflow.test.ts`, `tests/skill-scenarios.test.ts`.

**Failing tests first**

1. `skill-lint.test.ts`: append `'curating-glirastes-chat-interactions'` to `LINTED_SKILLS` (fails: file missing).
2. `installer-parts.test.ts`: `resolvePartSkills(['chat-ui'], { stack: 'nextjs' })` equals `['building-glirastes-chat-ui', 'curating-glirastes-chat-interactions']`.
3. `installer-e2e.test.ts`: add the skill to the sorted manifest list (after `building-glirastes-chat-ui`) and to the `chat-ui`-only expectation (`['building-glirastes-chat-ui', 'curating-glirastes-chat-interactions']`).
4. `install-skills.test.ts`: add the skill to `foundationSkills` (portable frontmatter check).
5. `setup-skill-workflow.test.ts`, new test `'teaches curating chat interactions end to end'`: the skill source (whitespace collapsed) contains each of `glirastes tools refresh`, `chatInteractions`, `.glirastes/chat-interactions.json`, `defineChatEntity`, `defineChatCommand`, `createChatInteractionsHandler`, `` `managedRuntime` once as a `const` ``, `useChatComposer`, `renderActions`, `stripSegments`, `onSearch`, `hidden` is no permission, `without a model call`, `ArrowRight`, `role`; and every JSON block in it that starts with `{\n  "schemaVersion": 1` passes `parseChatInteractionOverrides`.
6. `install-skills.test.ts`, new test modelled on `'names only React surfaces that actually exist in the chat UI skill'`: every backticked identifier in the new skill that looks like a React surface (`/^(use[A-Z]|[A-Z])/`) occurs in `src/react` or `src/server` sources.
7. `tests/skill-scenarios.test.ts`, new scenario `'curating-glirastes-chat-interactions derives, confirms and checks'` on `nextApp({ 'src/components/bridge.tsx': BRIDGE, 'src/app/tasks/page.tsx': TASKS_PAGE }, { sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'] })`: `glirastes tools refresh` exits 0 and the generated module (`fixture.read(DEFAULT_GENERATED_MODULE)`) contains `export const chatInteractions` and `"id": "open.tasks"`; `glirastes tools status` lists `+ ui.navigate`; `glirastes tools policy confirm <tool>` with `tool: 'tasks.list'` exits 0; `glirastes tools refresh` again exits 0; `glirastes tools check` prints `Tool outputs match the code.`.

**Skill content** (target 150–220 lines; English like the other skills)

Frontmatter:

```
---
name: curating-glirastes-chat-interactions
description: Use when the chat's derived `@` entities and `/` commands need a review after glirastes tools refresh, when things are missing from the `@` list, the `/` list shows noise or poor labels, a custom chat input lost the lists, or hand-built mention search and command lists should be removed.
---
```

Intro: what the derived lists are, that the agent curates and Glirastes never calls a model, and that labels come from tool titles (`describing-glirastes-tools`).

`## Boundaries`: never edit the generated module; `hidden`, `run`, `args`, `search` and new entries are product decisions, propose them as a list and apply after the developer agreed; `hidden` is no permission, the tool policy and the endpoints decide; nothing about interactions goes to the Platform; do not weaken a confirmation to make a command feel faster.

`## Workflow` (numbered; each step ends in something checkable):

1. **Derive.** Run `glirastes tools refresh`; read `chatInteractions` in the generated module (entities with `search` and `actions`, commands).
2. **Review with the checklist** and write the findings down as a table (id, finding, proposed fix):
   - *Missing entities.* A thing users mention has no `@` type. Causes in order: the list endpoint has no `search`/`q`/`query`/`term` parameter in its contract (add it to the endpoint and its schema, also when the old search fetched everything); the search lives under `/search` with another parameter name than `name`; the output is not a list of objects with `id` and a title-like field; the tool is disabled. What the code cannot show (another service, a small list filtered in the browser) becomes `defineChatEntity`.
   - *Missing pages.* No `open.*` commands and every destination starts with a locale parameter: set `stripSegments` (for example `["[locale]"]`) on the `next-pages` and `url-filters` sources in `.glirastes/tools.json` and let the navigation bridge push through the i18n router. This changes the stable keys of the filter tools: rename their entries in `.glirastes/tool-semantics.json` and the policy in the same change (`maintaining-glirastes-tools`).
   - *UI noise.* Commands that only make sense with a selected thing (delete dialog, edit dialog), duplicates of navigation (an app-specific `navigate` action next to `open.*`), filters of detail pages, more than about five actions on an entity, read actions nobody asks for by name. Hide them.
   - *Poor labels.* First fix the tool's `title` in `.glirastes/tool-semantics.json` (it feeds the chat label and the tool cards); use an override only for what a title cannot say (a short context-menu label such as "Erledigen", `keywords`, `icon`).
   - *Destructive actions.* They are listed last. Each must answer with the approval card: check `requiresApproval` in `glirastes tools status`; where it is off, `glirastes tools policy confirm <tool>`. Hide irreversible ones the chat should not offer at all.
3. **Override.** Texts, `hidden`, `keywords`, `icon` in `.glirastes/chat-interactions.json` (one valid example block with a hidden command, a relabelled action, keywords, and a re-added chat-internal command as a complete entry); search and resolve logic in code with `defineChatEntity`/`defineChatCommand` (short example with `search`, `resolve`, `card`). Remove stale patches after every refresh.
4. **Wire.** `export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime })` next to the POST; define `managedRuntime` once as a `const` and pass the same object to both; in React `useChatInteractionsData(endpoint)` and a memoized `chatInteractions={{ data, entities, commands, locale }}`.
5. **Custom composer.** If the app replaces the input (`components.ChatInput`): first try the SDK `MentionInput` with its props (`initialMentions`, `initialValue`, `components={{ DropdownItem }}`, `renderActions`, `renderSubmit`, `inputClassName`, `editorClassName`; or the built-in `voice` config instead of an own microphone). Only for a layout the props cannot express, build the input on `useChatComposer()` with `RichMentionInput` (short example, the one of Task 6). A custom `DropdownItem` must spread `optionProps`. Never call `send(text)` without the editor's mentions and never pass an own `onSearch` next to `chatInteractions`.
6. **Remove the legacy path.** Delete hand-built `onSearch` functions, command arrays and `createUiToolCommandProvider`; prompt-style commands that should stay become `run: { kind: 'prompt' }` entries.
7. **Verify** (see below).

`## Commands`:

```bash
glirastes tools refresh
glirastes tools status
glirastes tools policy confirm <tool>
glirastes tools check
```

`## Verification`: keyboard only (ArrowUp/ArrowDown, ArrowRight/ArrowLeft into actions, Enter or Tab, Escape; the argument form by Tab); one `/` command sent alone runs without a model call (no model request in the network log or the app's model mock, the bubble shows the label); a destructive action shows the approval card; a role-restricted user gets a shorter GET list and a refused POST for a hand-typed command; the chat route logs no stale-patch warning; `glirastes tools check` passes.

**Implementation:** `installer-parts.ts`: `'chat-ui': ['building-glirastes-chat-ui', 'curating-glirastes-chat-interactions']`.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/installer-parts.test.ts src/cli/commands/install-skills.test.ts src/cli/commands/setup-skill-workflow.test.ts src/cli/installer-e2e.test.ts tests/skill-scenarios.test.ts tests/pack-completeness.test.ts`

**Commit:** `feat(skills): add curating-glirastes-chat-interactions`

---

## Task 10: Cross-references and documentation

**Files:** `skills/building-glirastes-chat-ui/SKILL.md`, `skills/describing-glirastes-tools/SKILL.md`, `skills/README.md`, `README.md`, `docs/chat-interactions.md`, `src/cli/commands/setup-skill-workflow.test.ts`.

**Failing tests first** (`setup-skill-workflow.test.ts`, in `'teaches chat entities and commands in the chat UI and the describing skill'`)

- Replace the two assertions that are no longer true (`/hand-composed\s+`RichMentionInput`/` and `not.toMatch(/custom `components\.DropdownItem`/)`) by: the chat UI skill contains `curating-glirastes-chat-interactions`, `useChatComposer`, `components.MentionDropdownItem`, `renderActions` and still `optionProps`; it no longer contains `Labels are English words built from identifiers`.
- The describing skill contains `curating-glirastes-chat-interactions` and (whitespace collapsed) `title becomes the default label`.
- New assertion: `skills/README.md` and `README.md` say `eight skills` and name the new skill.

**Edits**

- `building-glirastes-chat-ui`: in "`@` entities and `/` commands" replace the label sentence (titles and presentation noun first, identifiers as fallback, chat-internal actions left out, `/search` endpoints, destructive last); replace the "`VercelAiChat` has no slot…" bullet by the slots (`components.MentionDropdownItem`, the `MentionInput` props) and `useChatComposer`; add group headings and the empty state to the keyboard paragraph; point to the new skill for review and overrides. Keep it under 400 lines (it has 393: tighten the replaced bullets rather than adding).
- `describing-glirastes-tools`: in "Chat entities and commands" state that a tool's `title` becomes the default label of its command or action and the presentation noun the entity label, so titles come first; keep the patch rules; hand `hidden`, `args`, `search` and new entries to `curating-glirastes-chat-interactions`.
- `skills/README.md`: "eight skills", one table row. `README.md`: "eight skills", the list of names, and in the chat section a sentence on `useChatComposer` with a link to `docs/chat-interactions.md`.
- `docs/chat-interactions.md`: update "Where they come from" (label sources, the `/search` row, the chat-internal rule with the override example, destructive last, `title` in `.glirastes/tool-contracts.json` and "run `glirastes tools refresh` after upgrading"); new section "Custom composers" with the props table of Task 7, the hook example of Task 6 and the note that the legacy `mentions` composer ignores the props; extend "Keyboard and screen readers" with headings and the empty state; link the new skill.

**Verify:** `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bunx vitest run src/cli/commands/setup-skill-workflow.test.ts src/cli/commands/skill-lint.test.ts src/cli/commands/install-skills.test.ts tests/skill-scenarios.test.ts tests/support-matrix.test.ts`

**Commit:** `docs: describe chat interaction curation and custom composers`

---

## Task 11: Gate and changelog

- [ ] `CHANGELOG.md`, under `## [Unreleased]`:

  ```markdown
  ### Added

  - `useChatComposer()` exposes the composer logic (suggestion search, direct `/` commands, the argument form, entity actions, references from `mentionEntity`) for a custom chat input; `MentionInput` takes `initialValue`, `initialMentions`, `components.DropdownItem`, `renderActions`, `renderSubmit`, `inputClassName` and `editorClassName`, and `components.MentionDropdownItem` sets the suggestion item for the whole chat.
  - Suggestions are grouped under headings when a list mixes types, `/` search matches umlauts typed as `ae`/`oe`/`ue`/`ss`, and an empty result shows a hint (`locale.completionEmptyLabel`).
  - Skill `curating-glirastes-chat-interactions`: review and curate the derived `@` entities and `/` commands, wire them, move a custom composer onto the SDK logic.
  - A search endpoint (`GET /api/users/search?name=`) derives an `@` entity; item endpoints of its collection become its actions.

  ### Changed

  - Derived chat labels: commands and entity actions take the tool's reviewed `title` from `.glirastes/tool-semantics.json`, entities the presentation noun; without them the fallback is verb plus object in English and object plus verb in German ("Dashboard aktualisieren"). Action labels no longer consist of the last path segment ("Permanent" is now "Delete permanent", or the title). Overrides in `.glirastes/chat-interactions.json` still win. Destructive actions are listed last.
  - Client actions of the chat itself (`ai-chat.*`, `chat.*`, `assistant.*`, `command-palette.*`, `command-menu.*`, `cmdk.*`) are no longer offered as `/` commands; a complete entry in `.glirastes/chat-interactions.json` adds one back.
  - `.glirastes/tool-contracts.json` carries an optional `title` per tool. Run `glirastes tools refresh` after upgrading and commit the result; `glirastes tools check` reports drift until then.
  - `ChatLocale` has a new key `completionEmptyLabel`; a locale object typed as the full `ChatLocale` needs it.
  ```

- [ ] `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/chat-interactions-curation && bun run typecheck && bun run typecheck:tests && bun run build && bun run test -- --maxWorkers=4` — all green; compare the count with Task 0 (only additions).
- [ ] Skill lint and registration once more on their own: `bunx vitest run src/cli/commands/skill-lint.test.ts src/cli/commands/install-skills.test.ts src/cli/commands/installer-parts.test.ts tests/skill-scenarios.test.ts tests/pack-completeness.test.ts`.
- [ ] Byte stability on the Next reference fixture: `bunx vitest run tests/chat-interactions-next.test.ts src/codegen/tools/pipeline-integrity.test.ts`.
- [ ] Browser proofs that touch the composer, when `PLAYWRIGHT_MODULE` and Chrome are available on the machine: `node --test tests/chat-interactions-browser.test.mjs tests/source-driven-browser.test.mjs` (they select options by role and text; update a label they pin if Task 3 changed it). When they cannot run, say so in the final report instead of skipping silently.
- [ ] Read-only check against Get It Done's data (nothing is written to that repository): copy `origin/staging` into a temporary directory with `git -C /Users/philipprollmann/Dev/chainmatics/get-it-done worktree add --detach <tmp> origin/staging` is **not** allowed (it writes to that repository's metadata); instead load `git show origin/staging:.glirastes/setup-artifact.json` and `…/tool-contracts.json` plus the titles from `…/tool-semantics.json` in a throwaway script in the scratchpad, call the built `deriveChatInteractions`, and confirm by eye: no `aiChat.open`/`commandPalette.open`, `task.tasks.permanentDelete` reads "Aufgabe endgültig löschen", `taskCreateDialog.open` reads "Dialog Aufgabe anlegen", entity label `Aufgabe`, a `user` entity exists, delete actions are last. Put the resulting labels into the final report.
- [ ] `git status --short` shows only the files of this plan.

**Commit:** `docs(changelog): note chat interaction curation`

---

## Consumer follow-up (not part of this plan)

After a staging prerelease, Get It Done follows the new skill: `stripSegments: ["[locale]"]`, a `search` parameter on `GET /api/teams` and `GET /api/teams/members` (or `defineChatEntity`), the GET handler with the shared `managedRuntime`, `chatInteractions` on the provider, `CustomChatInput` replaced by `MentionInput` with `initialMentions`, `initialValue`, `components.DropdownItem`, `renderActions` (microphone) and `renderSubmit` (icon buttons), and `mention-search.ts` deleted. Mention ids change from `task-<id>` to the plain id.

## Open decisions

1. **Title in `tool-contracts.json` (recommended, planned).** It is the only way to keep `check --integrity-only` byte-stable without reading a third file there. Cost: every app with titles sees one contracts diff after the upgrade, and an SDK older than this release cannot read the new file (strict schema). Alternative: read `.glirastes/tool-semantics.json` again in integrity mode; more plumbing and a second source of truth.
2. **Entity actions show the full title** ("Aufgabe endgültig löschen" in the task's own menu). Short context labels ("Endgültig löschen") cannot be derived reliably in German; the skill uses overrides for them. Say so if short labels should win over titles for the eight classic verbs.
3. **Many actions per entity** (Get It Done: 13 on `task`). Planned: curation hides them. A generic default (for example read-only sub-resource actions hidden unless overridden) would need a protocol or override change; decide after the first curated app.
4. **Empty-state wording.** "@ für Dinge, / für Befehle" is implemented as the no-match hint of the list (with "Keine Treffer."), not as a permanent line under the input. A permanent hint would change every chat's default look.
