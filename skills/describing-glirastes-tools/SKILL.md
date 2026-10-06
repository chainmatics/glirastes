---
name: describing-glirastes-tools
description: Use when glirastes tools refresh says tools need a better description, tools have template descriptions or field-name schemas, glirastes tools eval reports ambiguous routing, or an endpoint rejected calls its schema accepted.
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

- Write only `.glirastes/tool-semantics.json`, `.glirastes/tool-resolutions.json`
  and, with `--write-contracts`, new `contract.ts` files next to route
  handlers. Never change a handler, `.glirastes/tool-policy.json` or a
  generated file.
- Fill only open fields and replace only your own earlier output. Fields in
  `protectedFields` (written by a human, supplied by the code or locked by a
  review) stay exactly as they are.
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
