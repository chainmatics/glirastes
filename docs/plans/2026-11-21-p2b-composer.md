# P2b Composer Rest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status: owner decisions D1–D9 (end of this file) are confirmed** as the
> recommended option of each.

**Goal:** Finish the composer generalization from omnify: starter chips on an empty chat, a keyboard hint line, a draft that survives session switch, remount and reload (identity-scoped), clarification answers as chips above the composer, descriptions and icons in the plus menu, and the parked P2a trigger-cleanup residual.

**Architecture:** Everything hangs off the existing `ComposerConfig` (`AiChatProvider composer`) and the internal `ComposerContextValue`; no new provider prop. Nothing changes in the default DOM without config, except the draft swap on session switch (D5). Drafts live in a provider-owned in-memory map (dies with the provider, so an identity remount drops it) and, when the session store offers `SessionConfig.draft`, in that store under its identity-scoped `storageKey`. Starters and clarification chips are small components rendered by `AiChatPanel` and exported for custom panels.

**Tech Stack:** TypeScript strict ESM (NodeNext), React 18/19, vitest + Testing Library (jsdom), Bun.

**Spec:** Scope from the session package list (P2b: "Starter-Chips, Hinweiszeile („↵ Senden · ⇧↵ Zeilenumbruch“), Entwurf behalten, Rückfrage-Chips") plus the parked items "description and icon in the plus menu" and the P2a re-review residual ("if the handler inserts content before the trigger, the offset shifts and `#bu` stays"). Owner rule: "mach die einfache konfiguration erstmal". Reference implementation (read only, never modify, no migration): omnify `apps/web/app/components/ai/`.

### What omnify does (reference, read only)

| Feature | omnify (file:line) | SDK today |
|---|---|---|
| Starter chips | `streaming-chat-input.tsx:469-487`: first 3 `PROMPT_ACTIONS` when `messages.length === 0`, icon + label, `title=description`, click puts the prompt into the draft (`pickAction` :403-408, appends on a new line), disabled while loading | `suggestions.staticChips` in `SuggestionBar` (one rotating chip, click **sends**) |
| Hint line | `streaming-chat-input.tsx:770-777`, CSS swap `prompt-bar.module.css:218-224` (`:has([role=option])`) | none |
| Draft | `chat-composer-state.tsx:1-28` + `ai-chat-widget.tsx:192-204`: one in-memory string above the widget, survives remount only; not per session, not across reload | text stays in the editor and is carried into the next session on switch; lost on remount |
| Clarification chips | `streaming-chat-input.tsx:454-468` + `clarification.ts`: options of the open `ask_clarification` above the composer, hidden while loading/recording, click sends the option | `ClarificationCard` in the message (`clarification-card.tsx`), options + free text, typed answer also answers |
| Plus menu rows | `streaming-chat-input.tsx:536-585`: icon, bold label, small description, section headings | `composer-plus-menu.tsx`: label + optional `icon` for `composer.items` rows only; no description; trigger/source rows without icon |
| Follow-ups | `chat-message-bubble.tsx` footer "WEITERFRAGEN" | model-generated via `suggest_followups` (`src/server/core/followup-tool.ts`) and trailing-text extraction (`ai-chat-provider.tsx:1815-1838`); placement is P6, not this plan (D8) |

## Global Constraints

- Additions only against the released 0.22.0 API; no removed or renamed export. Every new public key is listed in an upgrade note `surface` (`src/upgrade-notes.test.ts` enforces it against `upgrade-notes/api-surface.released.json`; do not run `bun run api-surface` — that is a release step).
- Without new config the rendered DOM is byte-identical to 0.22.0. The existing default-DOM tests (`src/react/components/__tests__/composer-toolbar.test.tsx`, `src/react/__tests__/consumer-inputs-0-19.test.tsx`, `ai-chat-panel.test.tsx`) stay green unchanged. Sole intended behavior change: D5 (draft per session).
- One upgrade note per change: `upgrade-notes/unreleased/<id>.json`, schema `src/cli/commands/upgrade/notes.ts` (`id` `^[a-z0-9][a-z0-9-]{2,79}$`, `kind`, `summary` ≤ 300 chars, `howTo` ≤ 2000, `skill: "building-glirastes-chat-ui"`, `affectedWhen.imports: ["glirastes/react"]`, `surface`). Plus one line under `## [Unreleased]` in `CHANGELOG.md`.
- Skill: `skills/building-glirastes-chat-ui/SKILL.md` is at 399/400 lines (`src/cli/commands/skill-lint.test.ts`). Net line change in SKILL.md ≤ +1 for the whole plan; detail goes into the new `references/composer-starters-drafts.md` (with a `## Contents` list) and `references/composer-triggers-toolbar.md`.
- i18n: every new visible text is an optional `ChatLocale` key with an English default in `DEFAULT_LOCALE` (`src/react/provider/ai-chat-provider.tsx:92`) and a German text in `deChatLocale` (`src/react/locale-de.ts`); `src/react/__tests__/locale-de.test.ts` stays green. Keys and texts are fixed in the tasks below.
- Console output only fixed text, never ids, labels or draft text (`src/react/__tests__/sensitive-diagnostics.test.ts`).
- Nothing new leaves the browser: drafts are stored only in the app's session store / memory; no Platform call, no new server route.
- Identity: drafts are keyed by conversation id inside the session store's `storageKey` (which the skill already tells apps to build from app, environment, business tenant and verified user). No module-scope draft state.
- Accessibility: every new control is a native `<button type="button">` reachable by Tab, with an accessible name; groups have `role="group"` + `aria-label`; disabled when `canCompose` is false.
- `src/react/styles.css` changes are followed by `node scripts/generate-embed-styles.mjs` (writes `src/embed/chat-styles.generated.ts`; `bun run build` runs it with `--check`). All new selectors use the existing `:where(:not([data-unstyled], [data-unstyled] *))` guard.
- Commits: conventional (`feat(react): …`, `fix(react): …`), explicit paths, no AI attribution, no push.
- Gate per task: `bun run typecheck`, the task's test files via `bunx vitest run <files>`, `bunx vitest run src/upgrade-notes.test.ts src/react/__tests__/sensitive-diagnostics.test.ts src/react/__tests__/locale-de.test.ts`. Last task: `bun run build`, `bun run typecheck:tests`, `bun run test` (known load flakes that pass alone: `src/codegen/tools/schema-probe.test.ts`, `src/cli/commands/upgrade/detect.test.ts`).

## Review Focus

1. **Async draft restore vs. typing:** switching to a session whose `draft.load` is still pending while the user already types — the typed text must win; a late load must not overwrite it (Task 7 test `late load does not overwrite typing`).
2. **Two users on one browser:** after an identity change the app remounts the chat with a new `storageKey`; user B must never see user A's draft, neither from memory nor storage (Task 7 `drafts die with the provider`, Task 8 `drafts are namespaced by storageKey`).
3. **Starters while the composer is locked** (streaming without queue, open approval, pending command form): chips are disabled and a click does nothing, also a `send: true` starter (Task 5 `locked composer`).
4. **Hint while a list opened programmatically** (`openCompletion`, plus-menu trigger rows) and on touch devices: the list hint shows for any open list; touch hides the hint by CSS (Task 4 `list opened by openCompletion`).
5. **Storage blocked or full** (Safari private mode, quota): drafts silently fall back to memory, nothing throws, no console text with content (Task 8 `blocked storage`).

---

### Task 1: Handled pick removes the trigger even when the handler inserts text before it

**Files:**
- Modify: `src/react/components/rich-mention-input.tsx` (`deleteSnapshot` ~:139, `snapshotTrigger` ~:859, `pickResult` ~:913-926)
- Test: `src/react/components/__tests__/rich-mention-input-select.test.tsx`
- Create: `upgrade-notes/unreleased/completion-select-prepend-cleanup.json`

**Interfaces:**
- Consumes: existing `TextSnapshot { start: number; text: string }`, `deleteSnapshot`.
- Produces: no public change. Internal: `TextSnapshot` gains `range?: Range` (a live DOM Range over the trigger text, taken with the snapshot).

- [ ] **Step 1: Write the failing tests** next to `'onCompletionSelect that appends text and returns true still loses the typed trigger'`:

```tsx
it('onCompletionSelect that puts text before the trigger and returns true still loses it', async () => {
  const onCompletionSelect = vi.fn<NonNullable<AiChatProviderConfig['onCompletionSelect']>>((item, { controls }) => {
    controls.setText(`Vorab ${controls.value}`);   // rebuilds the editor, shifts every offset
    return true;
  });
  render(<Composer chat={transport()} onCompletionSelect={onCompletionSelect} />);
  const editor = screen.getByRole('textbox', { name: 'Type a message...' });
  typeInto(editor, 'Siehe #bu');
  await waitFor(() => expect(option('Bug sieben')).toBeTruthy());
  fireEvent.click(option('Bug sieben'));
  expect(editor.textContent).toBe('Vorab Siehe ');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('a handled pick leaves the text alone when the trigger text occurs twice after a rebuild', async () => {
  // handler: setText(`#bu ${value}`) → "#bu Siehe #bu": ambiguous, nothing is deleted
  ...
  expect(editor.textContent).toBe('#bu Siehe #bu');
});
```
Also a standalone `RichMentionInput` case where the handler calls `handleRef.current.insertMention(...)` at position 0 (a pill before the text) → trigger gone, pill kept.

- [ ] **Step 2: Run** `bunx vitest run src/react/components/__tests__/rich-mention-input-select.test.tsx` — Expected: the two new cases FAIL (`#bu` remains).

- [ ] **Step 3: Implement** in `rich-mention-input.tsx`. Removal order after a handled pick: (1) the live `range` from the snapshot when it is not collapsed and `range.toString() === snapshot.text` and outside a pill → `range.deleteContents()` (live ranges follow `insertData` before them); (2) else the existing offset match (`deleteSnapshot`); (3) else the snapshot text at a word start (start of text or after whitespace), only when it occurs exactly once in the editor's text nodes outside pills. Zero or several matches: delete nothing. The one-space merge of `deleteSnapshot` applies in all three paths. Caret goes to the removal point.

- [ ] **Step 4: Run** the same file — Expected: PASS, including the existing `'a handled pick in the middle of the text leaves one space'`.

- [ ] **Step 5: Upgrade note** `completion-select-prepend-cleanup`, `kind: "optional"`, summary: "onCompletionSelect returning true now also removes the typed trigger and query when the handler put text or a pill before them; when the text became ambiguous nothing is removed.", no `surface`. CHANGELOG `### Fixed` line.

- [ ] **Step 6: Commit**
```bash
git add src/react/components/rich-mention-input.tsx src/react/components/__tests__/rich-mention-input-select.test.tsx upgrade-notes/unreleased/completion-select-prepend-cleanup.json CHANGELOG.md
git commit -m "fix(react): remove the typed trigger after a handled pick that put text before it"
```

---

### Task 2: Descriptions and icons in the plus menu, icon names through `composer.renderIcon` (D9)

**Files:**
- Modify: `src/react/types.ts` (`ComposerToolbarItem` ~:1016, `ComposerConfig` ~:1027, `ChatTriggerDefinition` ~:451)
- Modify: `src/react/completions/triggers.ts` (`normalizeTrigger` carries `icon`, `description`)
- Modify: `src/react/components/composer-plus-menu.tsx` (`MenuRow`, `renderRow`)
- Modify: `src/react/components/composer-toolbar.tsx` (trigger button: icon when set)
- Modify: `src/react/components/rich-mention-input.tsx` (`DefaultDropdownItem` ~:209)
- Modify: `src/react/styles.css`, `src/embed/chat-styles.generated.ts` (generated)
- Test: `src/react/components/__tests__/composer-plus-menu.test.tsx`, `src/react/components/__tests__/composer-toolbar.test.tsx`, `src/react/components/__tests__/completion-composer.test.tsx`
- Modify: `skills/building-glirastes-chat-ui/references/composer-triggers-toolbar.md` (`## Plus menu`)
- Create: `upgrade-notes/unreleased/composer-menu-descriptions-icons.json`

**Interfaces:**
- Produces (public, `glirastes/react`):
  - `ComposerToolbarItem.description?: string`
  - `ChatTriggerDefinition.icon?: ReactNode`, `ChatTriggerDefinition.description?: string`
  - `ComposerConfig.renderIcon?: (name: string, context: { type: string; trigger?: string }) => ReactNode` — turns the string `icon` of completion entries (`MentionResult.icon`, `ChatCommandDefinition.icon`, `ChatEntityDefinition.icon`) and string starter icons (Task 5) into an element. Without it string icons render nothing (as today).
- Internal: `MenuRow.description?: string`; `ResolvedChatTrigger.icon`, `.description`.

- [ ] **Step 1: Write the failing tests**
  - `composer-plus-menu.test.tsx`: `'a row shows the description of its item and links it'` — `items: { help: { label: 'Hilfe', description: 'Kurze Anleitung', onSelect } }`, `plusMenu: { items: ['help'] }`: the menuitem has accessible name `Hilfe` and `aria-describedby` pointing at an element with text `Kurze Anleitung` (`[data-element="plus-menu-description"]`).
  - `'a trigger row shows the trigger icon and description'` — `triggers: [{ char: '#', label: 'Tickets', icon: <svg data-testid="t-icon" />, description: 'Tickets suchen' }]`: row contains `t-icon` inside `[data-element="plus-menu-icon"][aria-hidden="true"]` and the description.
  - `'a source row shows the entry description and its icon through renderIcon'` — source entry `{ description: 'Vorlage', icon: 'sparkle' }`, `renderIcon: (name) => <i data-icon={name} />` → `i[data-icon="sparkle"]` and text `Vorlage` in the row.
  - `'without description, icon and renderIcon a row is unchanged'` — exact `innerHTML` of a row equals the 0.22.0 markup (`<span data-element="plus-menu-label">…</span>` only).
  - `composer-toolbar.test.tsx`: `'a trigger button with an icon shows the icon and keeps the label as its name'`.
  - `completion-composer.test.tsx`: `'the default list item renders a string icon through renderIcon'`; without `renderIcon` no icon element.

- [ ] **Step 2: Run** the three files — Expected: new cases FAIL.

- [ ] **Step 3: Implement.** Row markup: `[icon span?][label span][description span?]`; description span gets a `useId`-based id referenced by the row's `aria-describedby`. Source rows use `result.description`, and `result.icon` through `renderIcon` with `{ type: result.type, trigger }`. `DefaultDropdownItem` renders `<span data-element="icon" aria-hidden="true">` before the label only when `renderIcon` returns non-null. `renderIcon` reaches the input through `ComposerContextValue.composer` (already present). CSS: description in `--cm-text-muted`, smaller font, on its own line under the label. Run `node scripts/generate-embed-styles.mjs`.

- [ ] **Step 4: Run** the three files plus `composer-example.test.tsx` — Expected: PASS.

- [ ] **Step 5: Docs + note.** Reference section "Plus menu": rows, descriptions, `renderIcon` example with a lucide map. Note `composer-menu-descriptions-icons`, `kind: "optional"`, `surface`: `glirastes/react#ComposerToolbarItem.description`, `glirastes/react#ChatTriggerDefinition.icon`, `glirastes/react#ChatTriggerDefinition.description`, `glirastes/react#ComposerConfig.renderIcon`. howTo mentions that `plusMenu.source` rows now show the entry's `description` when the entry has one (visible change, D9).

- [ ] **Step 6: Commit**
```bash
git add src/react/types.ts src/react/completions/triggers.ts src/react/components/composer-plus-menu.tsx src/react/components/composer-toolbar.tsx src/react/components/rich-mention-input.tsx src/react/styles.css src/embed/chat-styles.generated.ts src/react/components/__tests__/composer-plus-menu.test.tsx src/react/components/__tests__/composer-toolbar.test.tsx src/react/components/__tests__/completion-composer.test.tsx skills/building-glirastes-chat-ui/references/composer-triggers-toolbar.md upgrade-notes/unreleased/composer-menu-descriptions-icons.json CHANGELOG.md
git commit -m "feat(react): descriptions and icons in the composer plus menu"
```

---

### Task 3: The plain input joins `useChatComposer`

Prerequisite for Tasks 5 and 7: today only composers on `useChatComposerInput` receive `useChatComposer()` operations; the plain textarea (`PlainChatInput`, used when there is no completion and no attachments) ignores them.

**Files:**
- Create: `src/react/components/textarea-composer-handle.ts`
- Modify: `src/react/components/chat-input.tsx` (`PlainChatInput`)
- Test: `src/react/components/__tests__/chat-input-composer.test.tsx` (new)
- Create: `upgrade-notes/unreleased/plain-input-composer-api.json`

**Interfaces:**
- Produces (internal): `createTextareaComposerHandle(ref: RefObject<HTMLTextAreaElement | null>, setValue: (text: string) => void): RichMentionInputHandle` — `getValue` = textarea value; `setValue(text)` ignores mentions; `insertMention`/`addMention` insert `prefix + label` as text (prefix `/` for `type: 'command'`, else `@`) at the caret, or at the end; `getMentions` → `[]`; `clear`; `focus`; no `openCompletion`.
- `PlainChatInput` calls `useChatComposerTarget(handleRef, { onChange: setValue })`.

- [ ] **Step 1: Write the failing tests** (`chat-input-composer.test.tsx`, provider without completion): `'insertText from useChatComposer reaches the plain input'` (`insertText('Hallo')` → textarea value `Hallo`), `'setDraft replaces the text'`, `'chatAbout puts the label as text'` (`@Bug 7`), `'clear empties it'`.
- [ ] **Step 2: Run** — Expected: FAIL (value stays empty).
- [ ] **Step 3: Implement** `createTextareaComposerHandle` and wire it with a stable `useRef` handle in `PlainChatInput`.
- [ ] **Step 4: Run** the new file plus `ai-chat-panel.test.tsx`, `consumer-inputs-0-19.test.tsx` — Expected: PASS, default DOM unchanged.
- [ ] **Step 5: Note** `plain-input-composer-api`, `kind: "optional"`, summary: "useChatComposer (insertText, setDraft, chatAbout, clear, focus) now also fills the plain chat input; mentions arrive there as text.", no surface. CHANGELOG `### Fixed`.
- [ ] **Step 6: Commit**
```bash
git add src/react/components/textarea-composer-handle.ts src/react/components/chat-input.tsx src/react/components/__tests__/chat-input-composer.test.tsx upgrade-notes/unreleased/plain-input-composer-api.json CHANGELOG.md
git commit -m "feat(react): the plain chat input receives useChatComposer operations"
```

---

### Task 4: Hint line under the composer (`composer.hint`, D1)

**Files:**
- Create: `src/react/components/composer-hint.tsx`
- Modify: `src/react/types.ts` (`ComposerConfig.hint`, `ChatLocale` keys, `RichMentionInputProps.onListOpenChange`, `ChatComposerInput.completionOpen`)
- Modify: `src/react/components/rich-mention-input.tsx` (fire `onListOpenChange` when `listOpen` flips)
- Modify: `src/react/hooks/use-chat-composer-input.tsx` (state `completionOpen`, passes `onListOpenChange` in `inputProps`)
- Modify: `src/react/components/mention-input.tsx` (`ProviderMentionInput`: hint as last child of the wrapper), `src/react/components/chat-input.tsx` (`PlainChatInput`: hint as last child of the form)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`DEFAULT_LOCALE`), `src/react/locale-de.ts`, `src/react/index.ts`, `src/react/styles.css`, `src/embed/chat-styles.generated.ts`
- Test: `src/react/components/__tests__/composer-hint.test.tsx` (new)
- Create: `upgrade-notes/unreleased/composer-hint.json`

**Interfaces:**
- Produces (public):
  - `ComposerConfig.hint?: boolean` — default `false` (D1).
  - `ComposerHint(props: { completionOpen?: boolean; className?: string }): JSX.Element` exported from `glirastes/react` (for own composers; reads `locale` from context).
  - `RichMentionInputProps.onListOpenChange?: (open: boolean) => void`
  - `ChatComposerInput.completionOpen: boolean`
  - `ChatLocale` optional keys (en / de): `composerHintSend` `'Send'`/`'Senden'`, `composerHintNewline` `'New line'`/`'Zeilenumbruch'`, `composerHintNavigate` `'Navigate'`/`'Navigieren'`, `composerHintPick` `'Pick suggestion'`/`'Vorschlag übernehmen'`, `composerHintClose` `'Close'`/`'Schließen'`.
- Markup (exact):
```html
<div data-component="composer-hint" aria-hidden="true">
  <span data-hint="compose"><kbd>↵</kbd> Senden · <kbd>⇧ ↵</kbd> Zeilenumbruch</span>
</div>
<!-- list open: -->
  <span data-hint="completion"><kbd>↑ ↓</kbd> Navigieren · <kbd>↵</kbd> Vorschlag übernehmen · <kbd>Esc</kbd> Schließen</span>
```
  `aria-hidden`: the hint repeats the standard textbox keys and the list already announces itself through `completion-status`; screen readers get no duplicated glyph text.

- [ ] **Step 1: Write the failing tests** (`composer-hint.test.tsx`):
  - `'no hint without composer.hint'` — no `[data-component="composer-hint"]`.
  - `'composer.hint shows send and new line in the chat language'` — `language: 'de'` → text `↵ Senden · ⇧ ↵ Zeilenumbruch`; English default `↵ Send · ⇧ ↵ New line`.
  - `'the hint switches while a completion list is open and back after Escape'` — type `@`, provider returns one entry → `[data-hint="completion"]`; Escape → `[data-hint="compose"]`.
  - `'list opened by openCompletion'` — `useChatComposer().openCompletion({ trigger: '/' })` → completion hint.
  - `'the plain input shows the compose hint'` — provider without completion, `composer: { hint: true }`.
  - `'locale overrides the hint texts'` — `locale: { composerHintSend: 'Abschicken' }`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `onListOpenChange` fires from an effect on `listOpen` change only (not on mount with `false`). CSS: hint is a full-width row (`flex: 1 1 100%`; plain input form gets `flex-wrap: wrap` when it has a hint child), `--cm-text-muted`, 0.6875rem, right-aligned; `kbd` inherits font; `@media (hover: none) and (pointer: coarse)` hides it. Regenerate embed styles.
- [ ] **Step 4: Run** the new file plus `rich-mention-input-open-completion.test.tsx`, `composer-toolbar.test.tsx` — Expected: PASS.
- [ ] **Step 5: Docs + note.** New reference `skills/building-glirastes-chat-ui/references/composer-starters-drafts.md` with `## Contents` (Hint line, Starters, Clarification chips, Drafts) and the "Hint line" section (config, `ComposerHint` for own composers with `composer.completionOpen`). Note `composer-hint`, `kind: "optional"`, `surface`: `glirastes/react#ComposerConfig.hint`, `glirastes/react#ComposerHint`, `glirastes/react#RichMentionInputProps.onListOpenChange`, `glirastes/react#ChatComposerInput.completionOpen`, the five `glirastes/react#ChatLocale.composerHint…` keys.
- [ ] **Step 6: Commit**
```bash
git add src/react/components/composer-hint.tsx src/react/types.ts src/react/components/rich-mention-input.tsx src/react/hooks/use-chat-composer-input.tsx src/react/components/mention-input.tsx src/react/components/chat-input.tsx src/react/provider/ai-chat-provider.tsx src/react/locale-de.ts src/react/index.ts src/react/styles.css src/embed/chat-styles.generated.ts src/react/components/__tests__/composer-hint.test.tsx skills/building-glirastes-chat-ui/references/composer-starters-drafts.md upgrade-notes/unreleased/composer-hint.json CHANGELOG.md
git commit -m "feat(react): keyboard hint line under the composer"
```

---

### Task 5: Starter chips on an empty chat (`composer.starters`, D2–D4)

**Files:**
- Create: `src/react/components/chat-starters.tsx`
- Modify: `src/react/types.ts` (`ChatStarter`, `ComposerConfig.starters`, `ChatLocale.startersLabel`)
- Modify: `src/react/components/ai-chat-panel.tsx` (render above the queue/input when `messages.length === 0`; hide `SuggestionBar` then)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`DEFAULT_LOCALE`), `src/react/locale-de.ts`, `src/react/index.ts`, `src/react/styles.css`, `src/embed/chat-styles.generated.ts`
- Test: `src/react/components/__tests__/chat-starters.test.tsx` (new)
- Modify: `skills/building-glirastes-chat-ui/references/composer-starters-drafts.md` ("Starters")
- Create: `upgrade-notes/unreleased/composer-starters.json`

**Interfaces:**
- Consumes: `useChatComposer()` (`insertText`, `setDraft`, `focus`; Task 3 makes it reach the plain input), `send` and `canCompose` from `useChatContext()`, `ComposerConfig.renderIcon` (Task 2).
- Produces (public):
```ts
export interface ChatStarter {
  label: string;
  /** Text for the composer (or the message with `send`); default `label`. */
  prompt?: string;
  /** Shown as the chip's tooltip (`title`). */
  description?: string;
  /** An element, or an icon name for `composer.renderIcon`. */
  icon?: ReactNode;
  /** Send at once instead of filling the composer. Default false (D3). */
  send?: boolean;
}
ComposerConfig.starters?: ReadonlyArray<string | ChatStarter>;   // a string is { label }
export function ChatStarters(props: { className?: string }): JSX.Element | null;
ChatLocale.startersLabel?: string;   // 'Suggestions' / 'Vorschläge'
```
- Markup: `<div data-component="chat-starters" role="group" aria-label={startersLabel}>` with one `<button type="button" data-element="starter">` per entry (`[data-element="starter-icon"][aria-hidden]` + label).

- [ ] **Step 1: Write the failing tests:**
  - `'no starters without config; the empty state is unchanged'`.
  - `'starters show on an empty chat and disappear after the first message'`.
  - `'a click puts the prompt into an empty composer and focuses it'` — `{ label: 'Zusammenfassen', prompt: 'Fasse den Auftrag zusammen' }` → editor text `Fasse den Auftrag zusammen`, `document.activeElement` is the editor, nothing sent.
  - `'a click with text already in the composer appends the prompt'` (space-joined, like `insertText`).
  - `'send: true sends the prompt'` → transport `sendMessage` called once with the prompt.
  - `'locked composer'` — transport `status: 'streaming'`, queue off: buttons `disabled`, click sends nothing; same for an open approval.
  - `'string icon goes through renderIcon'`; `'description is the title'`.
  - `'staticChips are hidden on an empty chat while starters show'` — `suggestions: { staticChips: ['A'] }` + starters → no `[data-component="suggestion-bar"]` before the first message.
  - `'works in the plain input'` (no completion).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `ChatStarters` (returns null without starters or with messages). Empty composer → `setDraft(prompt)`; non-empty → `insertText(prompt)`; then `focus()`. `send` → `send(prompt)` from context. `AiChatPanel` renders `<ChatStarters />` before `SuggestionBar`, and `SuggestionBar` only when `!(messages.length === 0 && starters?.length)`. CSS: wrapping row of pill buttons, gap 0.375rem, padding matching the composer.
- [ ] **Step 4: Run** the new file plus `ai-chat-panel.test.tsx` — Expected: PASS.
- [ ] **Step 5: Docs + note.** "Starters" section: static list, dynamic list via `useMemo` in the app (page-aware), insert vs `send`, relation to `staticChips`. Note `composer-starters`, `kind: "optional"`, `surface`: `glirastes/react#ChatStarter.*`, `glirastes/react#ChatStarters`, `glirastes/react#ComposerConfig.starters`, `glirastes/react#ChatLocale.startersLabel`.
- [ ] **Step 6: Commit**
```bash
git add src/react/components/chat-starters.tsx src/react/types.ts src/react/components/ai-chat-panel.tsx src/react/provider/ai-chat-provider.tsx src/react/locale-de.ts src/react/index.ts src/react/styles.css src/embed/chat-styles.generated.ts src/react/components/__tests__/chat-starters.test.tsx skills/building-glirastes-chat-ui/references/composer-starters-drafts.md upgrade-notes/unreleased/composer-starters.json CHANGELOG.md
git commit -m "feat(react): starter chips on an empty chat"
```

---

### Task 6: Clarification options as chips above the composer (`composer.clarificationChips`, D7)

**Files:**
- Create: `src/react/components/clarification-chips.tsx`
- Modify: `src/react/types.ts` (`ComposerConfig.clarificationChips`, `ClarificationCardProps.showOptions`, `ChatLocale.clarificationChipsLabel`)
- Modify: `src/react/components/clarification-card.tsx` (omit the option buttons when `showOptions === false`)
- Modify: `src/react/components/message-bubble.tsx` (~:541, passes `showOptions={!composer?.clarificationChips}`)
- Modify: `src/react/components/ai-chat-panel.tsx` (render `<ClarificationChips />` above the composer)
- Modify: `src/react/provider/ai-chat-provider.tsx` (`DEFAULT_LOCALE`), `src/react/locale-de.ts`, `src/react/index.ts`, `src/react/styles.css`, `src/embed/chat-styles.generated.ts`
- Test: `src/react/components/__tests__/clarification-chips.test.tsx` (new), `src/react/components/__tests__/clarification-card.test.tsx`
- Create: `upgrade-notes/unreleased/composer-clarification-chips.json`

**Interfaces:**
- Consumes: `findOpenClarification`, `clarificationAnswerMessage` (`src/react/utils/clarification.ts`), `send`, `isLoading`, `canCompose`.
- Produces (public): `ComposerConfig.clarificationChips?: boolean` (default false); `ClarificationChips(props: { className?: string }): JSX.Element | null`; `ClarificationCardProps.showOptions?: boolean` (default true); `ChatLocale.clarificationChipsLabel?: string` (`'Answer options'` / `'Antwortmöglichkeiten'`).
- Markup: `<div data-component="clarification-chips" role="group" aria-label={clarificationChipsLabel}>` + `<button type="button" data-element="option" data-option-id title={description}>{label}</button>`.

- [ ] **Step 1: Write the failing tests:**
  - `'no chips without config'`.
  - `'an open clarification shows its options above the composer and the card keeps question and free text only'`.
  - `'a chip sends the same answer message as the card'` — sent text equals `clarificationAnswerMessage({ toolCallId, text: label, optionId })`.
  - `'chips hide while loading and once answered'` — also when answered by typing into the composer.
  - `'chips are disabled while the composer is locked'`.
  - `clarification-card.test.tsx`: `'showOptions false renders no option buttons'`; default unchanged.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Chips show when `findOpenClarification(messages)` is ready, has options, `!isLoading`, not answered. Without options (free text only) nothing shows. CSS like starters.
- [ ] **Step 4: Run** both files plus `ai-chat-panel.test.tsx` — Expected: PASS.
- [ ] **Step 5: Docs + note.** Reference "Clarification chips". Note `composer-clarification-chips`, `kind: "optional"`, `surface`: `glirastes/react#ComposerConfig.clarificationChips`, `glirastes/react#ClarificationChips`, `glirastes/react#ClarificationCardProps.showOptions`, `glirastes/react#ChatLocale.clarificationChipsLabel`.
- [ ] **Step 6: Commit**
```bash
git add src/react/components/clarification-chips.tsx src/react/types.ts src/react/components/clarification-card.tsx src/react/components/message-bubble.tsx src/react/components/ai-chat-panel.tsx src/react/provider/ai-chat-provider.tsx src/react/locale-de.ts src/react/index.ts src/react/styles.css src/embed/chat-styles.generated.ts src/react/components/__tests__/clarification-chips.test.tsx src/react/components/__tests__/clarification-card.test.tsx skills/building-glirastes-chat-ui/references/composer-starters-drafts.md upgrade-notes/unreleased/composer-clarification-chips.json CHANGELOG.md
git commit -m "feat(react): clarification options as chips above the composer"
```

---

### Task 7: Draft per session, in memory (D5)

**Files:**
- Create: `src/react/composer/composer-drafts.ts` (controller), `src/react/composer/use-composer-draft.ts` (hook)
- Modify: `src/react/provider/composer-context.ts` (`ComposerContextValue.drafts`)
- Modify: `src/react/provider/ai-chat-provider.tsx` (creates the controller once per provider instance, `useRef`)
- Modify: `src/react/hooks/use-chat-composer-input.tsx`, `src/react/components/chat-input.tsx` (`PlainChatInput`, via the Task 3 handle)
- Modify: `src/react/types.ts` (`ComposerDraft`)
- Test: `src/react/composer/__tests__/composer-drafts.test.tsx` (new)
- Create: `upgrade-notes/unreleased/composer-draft-per-session.json`

**Interfaces:**
- Produces (public): `export interface ComposerDraft { text: string; mentions?: ReadonlyArray<MentionData> }` (attachments are never part of a draft).
- Produces (internal):
```ts
interface ComposerDraftController {
  get(sessionId: string): ComposerDraft | undefined;            // memory
  set(sessionId: string, draft: ComposerDraft | null): void;    // memory now, storage debounced (Task 8)
  load(sessionId: string): Promise<ComposerDraft | null>;       // storage; Task 7: resolves memory or null
  flush(): void;
}
function createComposerDraftController(storage?: ComposerDraftStorage): ComposerDraftController;
function useComposerDraft(handleRef: RefObject<RichMentionInputHandle | null>, onRestore: (value: string) => void): {
  onChange(value: string): void; onSubmitted(): void;
};
```
- Rules: the draft of session X is saved on every change (memory) and when the active session changes away from X; the composer then shows the draft of the new session (empty when none). A successful submit sets `null`. Restore runs after the input's `initialMentions` and before `useChatComposerTarget` operations; `initialValue` applies only when the restored draft is empty. A restore that arrives after the user typed in the new session is dropped.

- [ ] **Step 1: Write the failing tests:**
  - `'text typed in chat A is back after switching to B and back; B starts empty'` (session store with two chats, `selectSession`).
  - `'the draft survives a remount of the input'` (toggle rendering `AiChatPanel` inside one provider).
  - `'a sent message clears the draft'`.
  - `'mentions survive a switch'` (a pill in A is a pill again, same id).
  - `'drafts die with the provider'` — unmount provider, mount a new one: empty composer.
  - `'late load does not overwrite typing'` — controller with a deferred `load`; type `x` before it resolves → text stays `x`.
  - `'initialValue applies only without a draft'`.
  - `'the plain input keeps its draft per session too'`.
- [ ] **Step 2: Run** `bunx vitest run src/react/composer/__tests__/composer-drafts.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** controller (a `Map<string, ComposerDraft>`), the hook (subscribes to `activeSessionId` from context; saves on change through `onChange`), wiring in both inputs. No storage yet.
- [ ] **Step 4: Run** the new file plus `chat-queue-session-switch.test.tsx`, `completion-composer.test.tsx`, `consumer-inputs-0-19.test.tsx` — Expected: PASS.
- [ ] **Step 5: Docs + note.** Reference "Drafts" (memory part). Note `composer-draft-per-session`, `kind: "recommended"`, summary: "Visible change: composer text now belongs to its chat. Switching chats shows that chat's unsent text instead of carrying the text over, and the text survives a remount of the input.", howTo: tests that expect carried-over text must switch back; `ComposerDraft` for own stores. `surface`: `glirastes/react#ComposerDraft.*`.
- [ ] **Step 6: Commit**
```bash
git add src/react/composer/composer-drafts.ts src/react/composer/use-composer-draft.ts src/react/provider/composer-context.ts src/react/provider/ai-chat-provider.tsx src/react/hooks/use-chat-composer-input.tsx src/react/components/chat-input.tsx src/react/types.ts src/react/composer/__tests__/composer-drafts.test.tsx skills/building-glirastes-chat-ui/references/composer-starters-drafts.md upgrade-notes/unreleased/composer-draft-per-session.json CHANGELOG.md
git commit -m "feat(react): keep the composer draft per chat"
```

---

### Task 8: Drafts survive a reload (`SessionConfig.draft`, `createLocalSessionStore`, D6)

**Files:**
- Modify: `src/react/types.ts` (`ComposerDraftStorage`, `SessionConfig.draft`)
- Modify: `src/react/composer/composer-drafts.ts` (storage, debounce, flush)
- Modify: `src/react/provider/ai-chat-provider.tsx` (pass `session?.draft`; flush on `pagehide` and unmount)
- Modify: `src/react/utils/local-session-store.ts` (`LocalSessionStoreOptions.drafts`, `draft` adapter, drop on `remove`/`clear`/eviction in `persist`)
- Test: `src/react/utils/__tests__/local-session-store.test.ts`, `src/react/composer/__tests__/composer-drafts.test.tsx`
- Create: `upgrade-notes/unreleased/session-store-drafts.json`

**Interfaces:**
- Produces (public):
```ts
export interface ComposerDraftStorage {
  load(conversationId: string): ComposerDraft | null | Promise<ComposerDraft | null>;
  /** `null` removes the draft (sent or emptied). */
  save(conversationId: string, draft: ComposerDraft | null): void | Promise<void>;
}
SessionConfig.draft?: ComposerDraftStorage;
LocalSessionStoreOptions.drafts?: boolean;   // default true (D6); false: no draft adapter
```
- Storage key: `${storageKey}:draft:${conversationId}`, JSON `{ text, mentions }`; therefore `clearLocalSessionStore` removes drafts by prefix with no change.
- Values: debounce `300` ms; drafts longer than `20000` characters stay in memory only; a throwing or rejecting `load`/`save` is swallowed (memory only), no console output.

- [ ] **Step 1: Write the failing tests:**
  - `local-session-store.test.ts`: `'draft.save and draft.load round-trip under the storageKey'`; `'save(null) removes the key'`; `'remove and clear drop the draft'`; `'an evicted chat (maxSessions) loses its draft'`; `'clearLocalSessionStore removes drafts'`; `'drafts: false offers no draft adapter'`; `'drafts are namespaced by storageKey'` (two stores, same id, different keys); `'blocked storage'` (`getItem`/`setItem` throw → no throw, `load` returns null).
  - `composer-drafts.test.tsx`: `'a draft is back after a reload'` (fake `localStorage`, unmount + remount provider with the same store); `'writes are debounced and flushed on switch'` (fake timers: 5 keystrokes → 1 `save`; switch before 300 ms → saved); `'pagehide flushes'`; `'a 20001-character draft is not written'`.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement** the adapter in `createLocalSessionStore` (reuse `read`/`write`/`drop`; `persist()` drops `draftKey(removed.id)` next to `messagesKey`), and storage in the controller (memory first, `load` only when memory has nothing for that id).
- [ ] **Step 4: Run** both files plus `chat-queue-session-switch.test.tsx` — Expected: PASS.
- [ ] **Step 5: Docs + note.** Reference "Drafts": what is stored, where, lifetime (until sent, chat removed/cleared/evicted, `clearLocalSessionStore` on sign-out), `drafts: false`, own server stores implementing `draft`. Note `session-store-drafts`, `kind: "recommended"`, summary: "createLocalSessionStore now keeps each chat's unsent composer text in the same browser storage and key prefix as the chat, so it survives a reload; drafts: false turns it off. Own SessionConfig stores can add draft.", `surface`: `glirastes/react#ComposerDraftStorage.*`, `glirastes/react#SessionConfig.draft`, `glirastes/react#LocalSessionStoreOptions.drafts`.
- [ ] **Step 6: Commit**
```bash
git add src/react/types.ts src/react/composer/composer-drafts.ts src/react/provider/ai-chat-provider.tsx src/react/utils/local-session-store.ts src/react/utils/__tests__/local-session-store.test.ts src/react/composer/__tests__/composer-drafts.test.tsx skills/building-glirastes-chat-ui/references/composer-starters-drafts.md upgrade-notes/unreleased/session-store-drafts.json CHANGELOG.md
git commit -m "feat(react): keep composer drafts across reloads in the local session store"
```

---

### Task 9: Skill entry, coverage and full gate

**Files:**
- Modify: `skills/building-glirastes-chat-ui/SKILL.md` (`## Mentions and suggestions` ~:266 and `## Sessions` ~:288)
- Modify: `tests/skill-coverage-allowlist.json` only if `tests/skill-coverage.test.ts` demands it for an internal file

- [ ] **Step 1: SKILL.md.** In "Mentions and suggestions" replace the `suggestions` sentence with one that also names `composer.starters`, `composer.hint`, `composer.clarificationChips` and links `references/composer-starters-drafts.md`. In "Sessions" extend one existing line: "`createLocalSessionStore` also keeps each chat's unsent draft (`drafts: false` turns it off)." Net SKILL.md change ≤ +1 line.
- [ ] **Step 2: Run** `bunx vitest run src/cli/commands/skill-lint.test.ts tests/skill-coverage.test.ts tests/skill-scenarios.test.ts src/upgrade-notes.test.ts` — Expected: PASS.
- [ ] **Step 3: Full gate:** `bun run build && bun run typecheck && bun run typecheck:tests && bun run test` — Expected: all green apart from the two known load flakes, each passing alone.
- [ ] **Step 4: Commit**
```bash
git add skills/building-glirastes-chat-ui/SKILL.md
git commit -m "docs(skills): starters, hint, clarification chips and drafts in the chat UI skill"
```

---

## Out of scope

- Follow-up chips under the answer, copy, sources (P6). The model already generates follow-ups (`suggest_followups`).
- `glirastes/embed` options for the new composer config (later, own note).
- The legacy `mentions` input (`LegacyMentionInput`): no hint, no starters fill, no drafts.
- Attachments in drafts.
- Quote card for "ask about selection" (separate item).

## Owner decisions (confirmed: the recommended option of each)

- **D1 Defaults.** (a) hint, starters and clarification chips opt-in; (b) hint on by default; (c) everything on. **Recommended (a):** the P2a rule "default DOM unchanged" holds, and each feature is one line of config.
- **D2 Where starters come from.** (a) static `composer.starters` from the app (dynamic via app state); (b) derived from `chatInteractions` commands (`starter: true` on a prompt command); (c) generated by the model/server before the first message. **Recommended (a):** the smallest surface, no model call on an empty chat; (b) can be added later on top of it.
- **D3 What a starter click does.** (a) fills the composer, `send: true` per starter sends; (b) sends at once (like `staticChips` today); **Recommended (a):** omnify behavior, the user can still edit, no unwanted model call.
- **D4 Starters vs. `suggestions.staticChips`.** (a) hide the SuggestionBar on an empty chat while starters show; (b) show both; (c) deprecate `staticChips` in favor of starters. **Recommended (a)**, revisit (c) with P6.
- **D5 Draft scope.** (a) one draft per chat (text no longer carried into another chat); (b) one global draft (omnify, today's carry-over). **Recommended (a)**; this is the only default behavior change of the plan (`kind: recommended`).
- **D6 Draft storage and lifetime.** (a) `SessionConfig.draft` adapter; `createLocalSessionStore` stores drafts by default under its identity-scoped `storageKey`, gone when sent, when the chat is removed/cleared/evicted or on `clearLocalSessionStore`; (b) same, but opt-in `drafts: true`; (c) memory only, no reload persistence. **Recommended (a):** the app already chose to keep chat content on the device with this store, and the draft has the same lifetime as the chat. No attachments, 20,000-character cap.
- **D7 Clarification chips.** (a) `composer.clarificationChips`: chips above the composer, the card in the message keeps question and free text without the option buttons; (b) chips plus the full card (options twice); (c) drop the item, the card already covers it. **Recommended (a).**
- **D8 Follow-up chips.** (a) keep them for P6 (footer under the answer); (b) add `suggestions.display: 'row'` in P2b. **Recommended (a):** P6 moves them anyway; doing it twice costs a second migration.
- **D9 Icons and descriptions.** (a) `composer.renderIcon(name)` resolver for string icon names, no shipped icon set; (b) ship a small built-in set; (c) ReactNode only, string icons stay unrendered. **Recommended (a).** Confirmed side effect: `plusMenu.source` rows start showing the entry's existing `description` (visible change for apps using `source`).
