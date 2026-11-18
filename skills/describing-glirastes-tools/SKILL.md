---
name: describing-glirastes-tools
description: Use when glirastes tools refresh says tools need a better description, tools have template descriptions or field-name schemas, glirastes tools eval reports ambiguous routing, an endpoint rejected calls its schema accepted, or the chat's derived entities and commands need better labels.
---

# Describing Glirastes Tools

Stage 2 makes the model understand every tool as if a developer had documented
it: description, typed input and output schemas, synonyms, titles, display
texts, confirmation hints and example sentences. You, the app's coding agent,
write them; Glirastes never calls a model. `glirastes tools describe --print`
says what is missing and where it goes; the next refresh checks every entry
and ignores an invalid one (`resolution-rejected`) while the tool keeps its
fallback. Tools stay active without stage 2, only less well described.

## Boundaries

- Write only `.glirastes/tool-semantics.json`, `.glirastes/tool-resolutions.json`,
  the chat texts in `.glirastes/chat-interactions.json` (section below) and,
  with `--write-contracts`, new `contract.ts` files next to route handlers.
  Never change a handler, `.glirastes/tool-policy.json` or a generated file.
- Fill only open fields and replace only your own earlier output. Fields in
  `protectedFields` (written by a human, supplied by the code or locked by a
  review) stay exactly as they are.
- An agent entry written for the current `interfaceDigest` is finished: do not
  rewrite it, only add a missing language. Renew agent fields only when the
  tool shows `semantics-stale` or `enrichment-stale`. The managed CI job
  enforces this: it keeps only the fields `targets.semantics.expected` shows
  and discards everything else it is sent.
- Every input key needs evidence in the code, and every key the handler reads
  stays in the schema. Effects may only raise the risk, never lower it.
- Examples are neutral sentences a user could type; no customer names,
  e-mail addresses, phone or account numbers, no secrets or keys.

## Work list

Each item of `glirastes tools describe --print` names the tool, its module,
its `gaps`, the `files` to read, the code `evidence` (route, parameters,
`interfaceDigest`, risk, current quality), `protectedFields`,
`missingExamples` (languages), `routing` (sentences that miss the tool) and
the targets:

- `targets.semantics`: the entry for `.glirastes/tool-semantics.json`. Add it
  to `tools`, or merge it into the entry with the same `stableKey`.
- `targets.schema`: the typed contract for `.glirastes/tool-resolutions.json`
  (`tools["<stableKey>"]`), when the code only shows field names or the
  output is opaque.
- `targets.contract`: with `--write-contracts`, a new `contract.ts` (Zod) next
  to the route handler; afterwards the generator reads it as code.

Tools of one module come together (`modules`): describe them together and say
in each description which neighbour fits better for which request.

## Workflow

1. Run `glirastes tools describe --print`. Name tools to describe only those
   (for example a tool an endpoint rejected calls for), or `--all` to review
   every tool.
2. For each module, read the handler, the services and schemas it imports and
   the pages that use it. Then write, replacing every `<…>` placeholder:
   - `description`: what the tool does, when it fits, which tool fits better.
     Always in English, for every tool and every app: only the model reads
     it, and descriptions from code comments are English too, so a mixed set
     never arises. Everything people read (`title`, `presentation`,
     `synonyms`, `examples`) follows the languages of the work list.
   - The input schema: types, required fields, enums, formats, bounds and a
     description per parameter; strict JSON Schema 2020-12, an object with
     `additionalProperties: false`, at most 32 KB. An output schema where the
     returned shape is visible in code.
   - `synonyms` (up to 20 per language) and `examples` (3 to 5 per language
     listed in `languages`), plus `exampleCalls` whose `input` matches the
     input schema.
   - `title` per language, `presentation` (singular, plural, the confirmation
     question) in the app's locale, `approvalHint` for tools that ask first.
3. Mark every field you wrote with `"origin": { "<field>": "agent" }` and keep
   `"agent": { "model": "<you>", "interfaceDigest": "<as printed>" }`.
4. Run `glirastes tools refresh`, then `glirastes tools eval`. Each
   `routing-ambiguous` line names the sentence and the tools ahead of it:
   sharpen the descriptions and synonyms of both tools once. What still fails
   stays reported as a warning; do not loop.
5. Run `glirastes tools describe --print` again until only tools you cannot
   improve from the code are left. After a code change, a tool reappears with
   `semantics-stale` or `enrichment-stale`; describe it again.
6. The developer reviews the diff and locks the reviewed entries with
   `glirastes tools verify <tool>`; you never lock your own output.

```json
{
  "stableKey": "GET /api/tasks",
  "description": "Lists the caller's tasks, optionally by status. Use tasks.search for full-text search.",
  "synonyms": { "de": ["Aufgabenliste", "offene Aufgaben"], "en": ["to-dos"] },
  "examples": {
    "de": ["Zeig meine offenen Aufgaben", "Welche Aufgaben sind erledigt?", "Liste alle Aufgaben"],
    "en": ["list my open tasks", "which tasks are done", "show the task list"]
  },
  "exampleCalls": [{ "sentence": "list my open tasks", "input": { "status": ["open"] } }],
  "origin": { "description": "agent", "synonyms": "agent", "examples": "agent", "exampleCalls": "agent" },
  "agent": { "model": "claude-code", "interfaceDigest": "sha256:…" }
}
```

### What the model sees when

- When it calls the tool: the `description` and the input schema with its
  property descriptions (for the `openapi` source also the parameter
  descriptions, see `docs/tool-policy.md`). Put everything that must hold at
  call time there ("Omit limit to get all").
- Only in `find_tools` results: `usageHints` (each cut to 300 characters,
  the description there to 500), never in the definition used for the call.
- Never: `synonyms` and `examples` only feed the search index (`find_tools`
  and the start set of a turn) and are never shown. `glirastes tools eval`
  ranks each example against an index without examples, so a passing eval
  still means name, description, hints and synonyms find the tool.
- An `examples` list with fewer than 3 (or more than 5) sentences in one
  language rejects the whole entry (`tool-semantics-invalid`,
  `resolution-rejected` for an agent entry): its other texts are lost too.
- The description the model gets is the first non-empty of: `description`
  in `.glirastes/tool-policy.json`, the code comment (JSDoc above the handler,
  method or client action registration; for `openapi` the operation's
  `description`, else `summary`), the `contract.ts` description (for
  `ui.navigate` and `ui.filter.*` a generated text), the schema's
  `.describe()`, then the `description` you write in `tool-semantics.json`;
  the same for endpoint and UI tools. So a tool with a JSDoc comment ignores
  your `description` today; if the comment is too thin, tell the developer
  (you never change handler code). The next minor release is planned to let a maintained
  `tool-semantics.json` entry win over the JSDoc.
- Synonyms weigh second only to the name in the search. Never give a
  collective tool (navigation, a generic "open object" tool) the names of its
  targets as synonyms (`Playlists` on a navigation tool): it then joins every
  request with that word and crowds out the tool that lists them. Give it
  synonyms for the act only ("go to", "open page").
- An entry whose `stableKey` or `name` matches no tool is reported as
  `semantics-entry-orphaned`; re-key it (`"METHOD /path"`) or delete it.
- In later turns the model sees earlier lists reduced to id and name (only
  the first 10 entries complete), and older turns without tool results. A
  tool that takes an id should say in its description to look the id up by
  name with a list or search tool when it is not visible.
- After a 404 of a route with path parameters (`/playlists/:id`) the failure
  result carries a fixed `hint`: look the value up with a list or search
  tool, and tell the user it was not found only when there is none or the
  lookup finds nothing. It names the path parameters, never a value.

## Chat entities and commands

When the app has a chat, `glirastes tools refresh` also derives its `@`
entities and `/` commands from the enabled tools (`chatInteractions` in the
generated module; `docs/chat-interactions.md` in the Glirastes repository,
which is not shipped in the package). The ids you patch follow the code:

- A page without parameters is the command `open.<path>`, segments joined by
  dots (`/settings/profile` is `open.settings.profile`, `/` is `open.home`); a
  URL filter is `filter.<view>`; a client action is `<actionId>`.
- A read endpoint with a `search`, `q`, `query` or `term` parameter that lists
  objects with an `id` and a title-like field is the entity type `task` (from
  `GET /api/tasks?search=`); an item endpoint or page below it is a context
  action of that entity, id `task.tasks.complete`.
- Only string arguments are derived; a disabled, `needs_attention` or
  excluded tool derives nothing.

A tool's title becomes the default label of its command or entity action,
and the presentation noun names its entity; without them the label is verb
plus object from identifiers. Fix a poor label in the title first. What a
title cannot say goes as stage-2 texts into
`.glirastes/chat-interactions.json`, in the same languages as the synonyms:

- Patch only ids and types the generated `chatInteractions` lists:
  `commands["<id>"]` with `label`, `description`, `keywords` (up to 20, the
  synonyms a user types after `/`) and `icon` (lowercase name, digits and
  `-`); `entities["<type>"]` with `label` and `icon`, and its
  `actions["<id>"]` with `label`.
- A patch replaces each field it names, so a `keywords` patch lists every
  keyword to keep.
- A patch for an id the generated list no longer has is stale, unless the
  developer wrote it as a complete new entry: the chat route ignores it and
  logs one console warning naming it. Remove stale patches; after every
  refresh, compare the file with the ids the new `chatInteractions` lists.
- Leave `hidden`, `run`, `args`, `search` and new entries to the developer
  and `curating-glirastes-chat-interactions`: they decide what the chat offers. `hidden` is no permission either; the
  tool policy and the endpoints decide what a user may run.
- `glirastes tools refresh` does not read this file; the chat route reads it
  when it creates its `createChatInteractionsHandler` and fails to load on an
  invalid entry (an unknown field or a wrong type). Load the chat route once
  (the app's tests or dev server) after editing the file and after every
  refresh, and read its console for the stale-patch warning.

```json
{
  "schemaVersion": 1,
  "commands": {
    "open.overview": { "label": { "de": "Übersicht öffnen", "en": "Open overview" }, "keywords": ["start", "dashboard"] },
    "filter.tasks": { "label": { "de": "Aufgaben filtern", "en": "Filter tasks" }, "icon": "filter" }
  },
  "entities": {
    "task": {
      "label": { "de": "Aufgabe", "en": "Task" },
      "actions": { "task.tasks.complete": { "label": { "de": "Erledigen", "en": "Complete" } } }
    }
  }
}
```

## Commands

```bash
glirastes tools describe --print
glirastes tools describe --print <tool>
glirastes tools describe --print --all
glirastes tools describe --print --write-contracts
glirastes tools refresh
glirastes tools eval
glirastes tools eval --json
glirastes tools status
# developer only, after reviewing the diff
glirastes tools verify <tool>
```

## Verification

- `glirastes tools describe --print` lists no tool you could still improve.
- `glirastes tools refresh` reports no `resolution-rejected` for your entries.
- `glirastes tools eval` finds every example sentence's tool, or reports the
  remaining ambiguity with its competitors.
- `glirastes tools status` shows `description: agent` (or `human` after
  verify) and `schema: agent` or better for the tools you described.
- `glirastes tools check` still passes in CI.
- The chat route still loads after an edit of `.glirastes/chat-interactions.json`
  and after every refresh, logs no stale-patch warning, and the `/` and `@`
  lists show your labels.
