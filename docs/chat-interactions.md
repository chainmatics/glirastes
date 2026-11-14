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
| A page without parameters (`ui.navigate`) | `/` command `open.<path>`, the path segments joined by dots (`/overview` is `open.overview`, `/settings/profile` is `open.settings.profile`, `/` is `open.home`; "Open Overview") |
| A URL filter (`ui.filter.<view>`) | `/` command `filter.<view>`; its string keys are arguments, enums become choices |
| A client action (`ui.<actionId>`) | `/` command `<actionId>`; its string payload fields are arguments |
| A read endpoint with `search`, `q`, `query` or `term` whose output lists objects with `id` and `title`/`name`/`displayName`/`label`/`subject`/`email` (`GET /api/tasks?search=`) | `@` entity `task`, searched with the user's session |
| An endpoint with one path parameter below that collection (`PATCH /api/tasks/:id`, `POST /api/tasks/:id/complete`) | Context action of the entity ("Edit", "Complete") |
| A page with one parameter of that entity (`/tasks/:taskId`) | Context action "Open" |

Only string arguments are derived. An optional array, number or object key
is left out of the form, and a command or action with a required key of
another type is not offered at all.

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
complete entry under a new id is added (a command needs `label` and `run`, an
action `label`, `entityArg` and `run`, an entity `label` and a `search` or an
action). A patch under an id or type that is not derived and is no complete
entry is stale, typically after a refresh stopped deriving a tool: it is
ignored and the handler logs one console warning naming it, so the route still
loads. Remove stale patches, and load the chat route after every refresh. An
invalid file (unknown field, wrong type) throws when the handler is created,
like an invalid tool policy. `hidden` only shapes the lists; it is no
permission. What a user may run is decided by the tool policy and the app's
endpoints, for direct commands exactly as for the model.

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

## Pills in the composer

With `chatInteractions` (or `completionProviders`) the default `ChatInput`
is the pill composer: a picked `/` command and a picked `@` entity both
become pills inside the text, `data-mention-kind="command"` or `"entity"`,
styled apart. Backspace right behind a pill and Delete right before it
remove the whole pill. `RichMentionInput commandPills={false}` keeps the
earlier behaviour of a command inserted as `/slug ` text.

Pill colors are CSS variables, light and dark come from the theme:

| Variable | Theme color | Unset |
| --- | --- | --- |
| `--cm-pill-command-bg`, `--cm-pill-command-text` | `pillCommand`, `pillCommandText` | the primary tint and color |
| `--cm-pill-entity-bg`, `--cm-pill-entity-text` | `pillEntity`, `pillEntityText` | a teal tint, mixed with the text color |

A chat rendered `unstyled`, or a composer of its own built on
`RichMentionInput`, gets the same pills from `import 'glirastes/react/pills.css'`
(zero specificity, every app rule wins) and sets the variables itself:

```css
:root { --cm-pill-command-bg: #ede9fe; --cm-pill-command-text: #5b21b6; --cm-pill-entity-bg: #ccfbf1; --cm-pill-entity-text: #115e59; }
.dark { --cm-pill-command-bg: #4c1d95; --cm-pill-command-text: #ede9fe; --cm-pill-entity-bg: #134e4a; --cm-pill-entity-text: #ccfbf1; }
```

## Starting a chat about something

`useChatComposer()` works anywhere below `AiChatProvider` (`VercelAiChat`),
for a right-click "Chat about this" entry or an AI button in a detail view:

```tsx
import { useChatComposer } from 'glirastes/react';

function TaskMenu({ task }) {
  const composer = useChatComposer();
  return (
    <>
      <MenuItem onSelect={() => composer.chatAbout({ type: 'task', id: task.id, label: task.title })}>
        {composer.chatAboutLabel /* "Chat about this", German "Mit KI besprechen" */}
      </MenuItem>
      <MenuItem onSelect={() => composer.chatAbout({ type: 'task', id: task.id, label: task.title }, { command: 'tasks.summarize' })}>
        Summarize
      </MenuItem>
    </>
  );
}
```

| Method | Effect |
| --- | --- |
| `open()` | Calls the provider's `onOpenRequest`, else opens the surrounding `AssistantLayoutProvider` |
| `chatAbout(entity, { command?, args?, text?, append? })` | `open()`, then replaces the draft (or adds to it with `append`) with the command pill, the entity pill and the text, and focuses the editor |
| `insertMention({ type, id, label? })` | An `@` pill at the caret; without `label` the entity's `resolve` looks it up (false when neither gives one) |
| `insertCommand(id, args?)` | A `/` pill for a known command (false otherwise); `args` fill its arguments, so sent alone it runs without the form |
| `setDraft(text, mentions?)`, `insertText(text)`, `clear()`, `focus()` | The draft itself |
| `hasCommand(id)`, `hasEntity(type)`, `chatAboutLabel` | For building menus |

Requests wait until a composer is mounted, so a closed chat that mounts its
panel on open still receives them. A composer of its own built on
`RichMentionInput` takes them with `useChatComposerTarget(inputRef, { onChange })`.
`chatAbout` with a command whose entity argument the pill fills runs the
command directly when sent alone, like a command picked from the list.

## Entity chips in answers

`entityLinks` on the provider turns references in assistant text into chips:

```tsx
const entityLinks = useMemo(() => ({
  // App-specific references, e.g. task keys. `resolve` may return undefined (not visible): the text stays.
  matchers: [{ type: 'task', pattern: /[A-Z][A-Z0-9]{1,5}-\d+/, resolve: (key) => lookupTask(key) }],
  // Optional: open a reference yourself; return false to fall through to the default.
  open: (ref) => (ref.type === 'task' ? openTaskDetails(ref.id) : false),
}), []);
<VercelAiChat endpoint="/api/chat" chatInteractions={chatInteractions} entityLinks={entityLinks} />
```

Besides the matchers, names the conversation already referenced become chips
(`known`, default on, names of at least `minLabelLength` = 4 characters):
`@` mentions and the hits of an entity's search tool (`GET /api/tasks?search=`).
A chip opens through `open`, else through the entity's derived "Open" action
(a page like `/tasks/:taskId`) on the navigation bridge, without a chat
message; without either it is shown but not clickable. `@` pills in sent
messages open the same way, also without `entityLinks`. A custom `Markdown`
component keeps the chips with `useChatEntityLinks().markdownComponents`
(for `react-markdown`) or `linkify(children)`; `EntityText` renders one string.

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
cost unknown (`null`), the executed call as tool count. An endpoint that
refuses the command's schema-valid call with 400 or 422 also records a
`tool_contract_rejected` event, without content, exactly as for a model call.
`directCommands: false` on `createAiChatHandler` turns this off; the message
then goes to the model.

## Keyboard and screen readers

- The editor is the `textbox` that controls the suggestion `listbox`
  (`aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`); a
  polite live region announces the number of suggestions.
- ArrowUp/ArrowDown move between results, ArrowRight/ArrowLeft between an
  entity and its actions, Enter or Tab picks, Escape closes.
- Backspace behind a pill and Delete before it remove the whole pill; each
  pill's remove control is named by `locale.removeMentionLabel`.
- A chip in an answer is a button named by `locale.openEntityLabel`.
- The argument form starts at the first empty required field; entity fields
  are ARIA 1.2 comboboxes; Escape closes an open list first, then cancels.
