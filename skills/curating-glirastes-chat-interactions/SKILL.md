---
name: curating-glirastes-chat-interactions
description: Use when the chat's derived `@` entities and `/` commands need a review after glirastes tools refresh, when things are missing from the `@` list, the `/` list shows noise or poor labels, a custom chat input lost the lists, or hand-built mention search and command lists should be removed.
---

# Curating Glirastes Chat Interactions

`glirastes tools refresh` derives the chat's `@` entities (things a user can
reference, with context actions) and `/` commands (pages, filters, client
actions) from the enabled tools and writes them as `chatInteractions` into the
generated module. You, the app's coding agent, review that list, propose
what to hide, rename or add, and wire it into the chat. Glirastes
never calls a model for any of this: derivation is deterministic, and the
review is yours.

Labels come from each tool's reviewed `title` in
`.glirastes/tool-semantics.json` (`describing-glirastes-tools`) and from the
presentation noun; without them the fallback is verb plus object built from
identifiers ("Open task create dialog", German "Task create dialog öffnen").

## Boundaries

- Never edit the generated module; it is rewritten on every refresh.
- `hidden`, `run`, `args`, `search` and new entries are product decisions:
  propose them as a list and apply them after the developer agreed.
- `hidden` is no permission. It only shapes the list; the tool policy and the
  app's endpoints still decide who may run what.
- Nothing about entities or commands goes to the Glirastes Platform; the
  list is served by the app's own chat route.
- Never weaken a confirmation to make a command feel faster.

## Workflow

1. **Derive.** Run `glirastes tools refresh` and read `chatInteractions` in
   the generated module: entities with `search` and `actions`, then commands.
2. **Review with this checklist** and write the findings as a table (id,
   finding, proposed fix):
   - *Missing entities.* A thing users mention has no `@` type. Causes, most
     likely first: the list endpoint declares no `search`, `q`, `query` or
     `term` parameter in its contract (add it to the endpoint and its schema,
     also when an old hand-built search fetched everything and filtered in
     the browser); a search under `/search` uses a parameter other than
     `name`; the output is not a list of objects with an `id` and a
     title-like field; the tool is disabled. What the code cannot show
     (another service, a short list filtered in the browser) becomes a
     `defineChatEntity`.
   - *Missing pages.* There are no `open.*` commands and every destination
     starts with a locale parameter: set `stripSegments` (for example
     `["[locale]"]`) on the `next-pages` and `url-filters` sources in
     `.glirastes/tools.json`, and let the navigation bridge push through the
     app's i18n router. This changes the stable keys of the filter tools:
     rename their entries in `.glirastes/tool-semantics.json` and
     `.glirastes/tool-policy.json` in the same change
     (`maintaining-glirastes-tools`).
   - *UI noise.* Hide commands that only make sense with a selected thing
     (delete or edit dialogs), duplicates of navigation (an app-specific
     navigate action next to `open.*`), filters of detail pages, read actions
     nobody asks for by name, and keep about five actions per entity.
     Client actions of the chat itself (`ai-chat.*`, `chat.*`,
     `command-palette.*`, `cmdk.*`) are already left out.
   - *Poor labels.* First fix the tool's `title` in
     `.glirastes/tool-semantics.json`; it feeds the chat label and the tool
     cards. Use an override only for what a title cannot say: a short
     context-menu label ("Erledigen" inside the task menu), `keywords`,
     `icon`.
   - *Destructive actions.* They are listed last. Each must answer with the
     approval card: check `requiresApproval` in `glirastes tools status` and
     run `glirastes tools policy confirm <tool>` where it is off. Hide
     irreversible ones the chat should not offer at all.
3. **Override.** Texts, `hidden`, `keywords` and `icon` go into
   `.glirastes/chat-interactions.json`. A command the derivation leaves out
   comes back as a complete entry with `label` and `run`:

   ```json
   {
     "schemaVersion": 1,
     "commands": {
       "taskDeleteDialog.open": { "hidden": true },
       "open.overview": { "label": { "de": "Übersicht öffnen", "en": "Open overview" }, "keywords": ["start", "dashboard"] },
       "aiChat.open": { "label": { "de": "KI-Chat öffnen", "en": "Open AI chat" }, "run": { "kind": "ui", "tool": "ui.aiChat.open" } }
     },
     "entities": {
       "task": {
         "actions": {
           "task.tasks.complete": { "label": { "de": "Erledigen", "en": "Complete" } },
           "task.tasksActivity.list": { "hidden": true }
         }
       }
     }
   }
   ```

   Search and resolve logic lives in code:

   ```ts
   const person = defineChatEntity({
     type: 'person',
     label: { de: 'Person', en: 'Person' },
     search: (query, { signal }) => searchPeople(query, signal),
     resolve: (id) => findPerson(id),
     card: (item) => ({ title: item.label, subtitle: item.description }),
   });
   const standup = defineChatCommand({
     id: 'standup', label: { de: 'Tagesrückblick', en: 'Stand-up' },
     run: { kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.', en: 'Summarize my day.' } },
   });
   ```

   Remove stale patches after every refresh; the chat route logs one warning
   per patch whose id the refresh no longer derives.
4. **Wire.** Next to the chat POST:
   `export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime })`.
   Define `managedRuntime` once as a `const` at module scope and pass the
   same object to the POST and the GET, so the list leaves out exactly what
   the POST refuses. In React load the list with
   `useChatInteractionsData('/api/chat')` and pass a memoized
   `chatInteractions={{ data, entities, commands, locale }}` to the chat.
5. **Custom composer.** When the app replaces the input
   (`components.ChatInput`), first try the SDK `MentionInput` with its props:
   `initialMentions`, `initialValue`, `components={{ DropdownItem }}`,
   `renderActions` (an own microphone; or the built-in `voice` config),
   `renderSubmit` (icon buttons), `inputClassName`, `editorClassName`. Only a
   layout those props cannot express builds the input on `useChatComposer`:

   ```tsx
   function Composer() {
     const composer = useChatComposer();
     return (
       <form onSubmit={(event) => { event.preventDefault(); composer.submit(); }}>
         {composer.argumentsForm}
         <RichMentionInput ref={composer.inputRef} {...composer.inputProps} />
         <button type="submit" disabled={!composer.canSend}>Senden</button>
       </form>
     );
   }
   ```

   A custom `DropdownItem` spreads `optionProps` onto its clickable element.
   Never call `send(text)` without the editor's mentions, and never pass an
   own `onSearch` next to `chatInteractions`: both bypass direct commands and
   entity actions.
6. **Remove the legacy path.** Delete hand-built `onSearch` functions,
   command arrays and `createUiToolCommandProvider`; prompt-style commands
   that should stay become `run: { kind: 'prompt' }` entries.
7. **Verify** as below, then run `glirastes tools check`.

## Commands

```bash
glirastes tools refresh
glirastes tools status
glirastes tools policy confirm <tool>
glirastes tools check
```

## Verification

- Keyboard only: ArrowUp and ArrowDown move through the list, ArrowRight and
  ArrowLeft into an entity's actions, Enter or Tab picks, Escape closes; the
  argument form is reached with Tab. Headings appear when the list mixes
  types, and a search without hits says so.
- A `/` command sent alone runs without a model call: no model request in the
  network log or the app's model mock, and the bubble shows the label.
- A destructive action answers with the approval card.
- A user with a narrower role gets a shorter GET list and a refused POST for
  a hand-typed command.
- The chat route logs no stale-patch warning, and `glirastes tools check`
  passes.
