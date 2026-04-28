---
name: maintaining-glirastes-tools
description: Authoring and maintaining Glirastes AI tool definitions, modules, and the codegen pipeline. Use when defining ai-tool.ts files, refining tool descriptions, configuring intent modules, declaring UI patterns, validating coverage, or wiring CI gates.
version: 1.0.0
tags:
  - glirastes
  - ai-tools
  - codegen
  - cli
triggers:
  - defineEndpointTool
  - defineUiTool
  - ai-tool.ts
  - ai-ui-tool.ts
  - tool definition
  - module-meta
  - intent module
  - uiPattern
  - generate-tools
  - validate-tools
  - coverage
  - scaffold ai-tool
  - tool authoring
  - tool description
---

# Maintaining Glirastes AI Tools

> **Framework wiring lives elsewhere:**
> - [integrating-glirastes-nextjs](../integrating-glirastes-nextjs/SKILL.md) — chat route + widget on Next.js
> - [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md) — `@AiTool` decorators + `AiChatModule`
> - [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md) — chat UI customization

## Two flavors of tool

A **tool** is something the AI can do. Glirastes ships two definitions; ~95% of real apps need only these two.

### Endpoint Tool — calls your backend

```ts
import { z } from 'zod';
import { defineEndpointTool } from 'glirastes';

export const aiTool = defineEndpointTool({
  id: 'tasks.list',           // unique dot-notation id
  toolName: 'list_tasks',     // unique snake_case name (what the LLM sees)
  module: 'task_query',       // intent module — controls routing & model tier
  sharedWith: ['task_mutation'], // also available to these modules
  description: `List tasks with an optional status filter.
WHEN to call: user asks to see tasks, or you need a task ID for a follow-up tool.
RETURNS: array of { id, title, status }.`,
  method: 'GET',
  path: '/api/tasks',
  inputSchema: z.object({
    status: z.enum(['open', 'done']).optional(),
  }),
  // outputSchema: z.array(...) — optional, helps the SDK validate responses
  uiPattern: {
    type: 'filter-and-navigate',
    target: 'tasks',
    filterMapping: { status: 'status' },
  },
});
```

### UI Tool — fires a frontend action without an API call

```ts
import { z } from 'zod';
import { defineUiTool } from 'glirastes';

export const openSettings = defineUiTool({
  id: 'settings.open',
  toolName: 'open_settings',
  module: 'navigation',
  description: 'Open the settings dialog for the current user.',
  inputSchema: z.object({}),
  uiAction: {
    type: 'run-client-action',
    actionId: 'settings.open',
  },
});
```

UI tools never round-trip to the server; the result is a `uiAction` payload that the frontend's `UiActionBus` dispatches to a registered `useAiClientAction(...)` handler.

## Description anatomy — what the LLM actually reads

The description is the **only** signal the LLM has for *when* to call the tool. Treat it as a prompt fragment, not a docstring:

```
description: `<one-line summary>.
WHEN to call: <concrete trigger phrasing the user might use>.
WHAT it returns: <shape>.
DO NOT: <common LLM mistakes — invented IDs, premature mutations, etc.>.`
```

Real-world examples that drove down hallucinations:

```ts
description: `Create a new task.
IMPORTANT: confirm the title with the user FIRST.
DO NOT INVENT IDs — call list_users / list_groups to resolve names.`
```

```ts
description: `List tasks with an optional status filter.
WHEN to call: user asks to see, browse, or filter tasks; or you need a task ID for another tool.
RETURNS: array of { id, title, status, assigneeId }.`
```

## Input schema — Zod, with `.describe()`

Every input field should have `.describe()` — the LLM uses it as field-level docs:

```ts
inputSchema: z.object({
  search: z.string().optional().describe('free-text search over title and description'),
  status: z.enum(['open', 'done']).optional().describe('filter by lifecycle status'),
  assigneeId: z.string().uuid().optional().describe('user UUID — never invent, look up via find_user'),
}),
```

Path params (`:id` in the route): if the route is `/api/tasks/:id`, include `id` in the input schema. The SDK substitutes it into the URL at call time. (NestJS decorator mode auto-extracts these from `@Param()` — see [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md).)

## Approval flow

`needsApproval` controls whether mutations show an approval card before executing:

```ts
needsApproval: true,   // always require approval
needsApproval: false,  // never require approval
needsApproval: (input, ctx) => input.amount > 1000,  // dynamic
```

**Defaults** (when `needsApproval` is omitted):
- `GET` → `false`
- `POST` / `PATCH` / `PUT` / `DELETE` → `true`

So mutations get approval cards by default; you only specify when you want to override.

## UI Patterns — declarative reactions

After a tool runs, what should the UI do? Glirastes ships 5 patterns. Use them instead of writing custom dispatch code:

| Pattern | Use case | Example |
|---|---|---|
| `filter-and-navigate` | GET tools that map a filter to a page URL | `{ type: 'filter-and-navigate', target: 'tasks', filterMapping: { status: 'status' } }` |
| `open-detail` | After lookup or creation, open a detail view | `{ type: 'open-detail', entity: 'task', idField: 'taskId' }` |
| `open-dialog` | Open a modal (create / edit) | `{ type: 'open-dialog', dialog: 'create-task' }` |
| `refresh` | Refresh a region after mutation | `{ type: 'refresh', target: 'tasks' }` |
| `toast` | Show a notification | `{ type: 'toast', message: '$message', variant: 'success' }` |

Patterns support `$variable` placeholders that interpolate from the **response** body (`$id`, `$message`) or from the **input** (`$status`).

### Compound patterns

Pass an array for multiple effects (toast + refresh after a mutation):

```ts
uiPattern: [
  { type: 'toast', message: '$message', variant: 'success' },
  { type: 'refresh', target: 'tasks' },
],
```

Each entry is processed sequentially. Patterns with unmet `condition` fields are skipped — others still fire.

### Manual `uiActionOnSuccess` (escape hatch)

When no built-in pattern fits, emit a raw action:

```ts
uiActionOnSuccess: {
  type: 'run-client-action',
  actionId: 'tasks.celebrate',
  payload: { taskId: '$id' },
},
```

Frontend handler (anywhere a relevant component mounts):

```tsx
import { useAiClientAction } from 'glirastes/react';

useAiClientAction('tasks.celebrate', (payload) => {
  fireConfetti();
});
```

**Priority** when multiple are present: response `uiAction` field > `uiPattern` > `uiActionOnSuccess`.

## Module definitions (intent routing)

> Module-based routing is a **Pro feature** — it requires `GLIRASTES_API_KEY` and a `lancer` client (intent classification via the Glirastes platform). Without it, all tools are exposed to the LLM on every request (free-tier mode). Module definitions are still useful pre-Pro: you author them upfront, they activate when you flip the env var.

Modules group tools by intent. Define them in `src/lib/ai/module-meta.ts`:

```ts
import type { ModuleMeta } from 'glirastes';

export const moduleMeta: Record<string, ModuleMeta> = {
  task_query: {
    classification: {
      hint: 'User asks to view, list, or filter tasks (NOT create/modify).',
      examples: ['show me open tasks', 'what is done?', 'filter by status'],
    },
    execution: {
      maxSteps: 2,           // LLM tool-call rounds for this module
      contextWindow: 12,     // messages sent to the LLM
      modelTier: 'fast',     // fast | standard | powerful
    },
    systemPrompt: `Focus: list and filter tasks.
For filter requests use list_tasks with appropriate status.`,
  },
  task_mutation: {
    classification: {
      hint: 'User asks to create, update, delete, or assign tasks.',
      examples: ['create a task', 'mark as done', 'assign to Alice'],
    },
    execution: { maxSteps: 4, contextWindow: 16, modelTier: 'standard' },
    systemPrompt: `Focus: mutate tasks.
NEVER invent IDs — use list_tasks / find_user first.`,
  },
};
```

**Field cheat-sheet:**
- `classification.hint` + `examples` → auto-generate the intent classifier prompt
- `execution.modelTier` → which model tier handles the request (`fast` ≈ gpt-4o-mini, `standard` ≈ Sonnet, `powerful` ≈ Opus)
- `execution.maxSteps` → cap LLM tool-call rounds (cost control)
- `systemPrompt` → appended to the system prompt for this module only

### Related modules (medium-confidence routing)

When the intent classifier is uncertain (confidence 0.7–0.85), the router can include tools from related modules:

```ts
const moduleMeta: Record<string, ModuleMeta> = {
  task_query: { /* ... */, related: ['task_mutation'] },
  task_mutation: { /* ... */, related: ['task_query'] },
};
```

## Codegen pipeline — scale to 50+ tools

Hand-importing every tool into the chat route doesn't scale. The CLI generates a registry from co-located `ai-tool.ts` files.

### Recommended `package.json` scripts

```json
{
  "scripts": {
    "predev":   "glirastes generate-tools --quiet",
    "prebuild": "glirastes generate-tools --quiet",
    "ai:scaffold":     "glirastes scaffold",
    "ai:generate":     "glirastes generate-tools",
    "ai:coverage":     "glirastes coverage",
    "ai:coverage:ci":  "glirastes coverage --ci",
    "ai:validate":     "glirastes validate-tools",
    "ai:validate:ci":  "glirastes validate-tools --ci",
    "ai:test":         "glirastes test"
  }
}
```

The `predev` / `prebuild` hooks regenerate the registry on every dev start and CI build — the generated files become source-of-truth.

### Output

After `glirastes generate-tools`:

```
src/generated/ai-tools/
├── endpoint.generated.ts    # exports `endpointToolRegistry`
├── ui.generated.ts          # exports `uiToolRegistry`
├── modules.generated.ts     # exports `toolsByModule`, `moduleTypes`, `relatedModules`,
│                            #         `IntentType`, `IntentSchema`, `buildIntentModule`,
│                            #         and (with --meta) `INTENT_MODULES`, `CLASSIFICATION_PROMPT`
└── action-ids.generated.ts  # union of action IDs (for type-safe useAiClientAction)
```

Import in your chat route:

```ts
import { endpointToolRegistry } from '@/generated/ai-tools/endpoint.generated';
import { uiToolRegistry } from '@/generated/ai-tools/ui.generated';

const tools = { ...endpointToolRegistry, ...uiToolRegistry };
```

### Module bridge file (when using intent routing)

The codegen produces raw module data (`toolsByModule`, `moduleTypes`). The pipeline (`createAiPipeline` / `createAiTestSuite`) consumes a `ModuleDefinition[]` shape. Author a thin bridge file that joins your `module-meta.ts` with the generated metadata:

```ts
// src/lib/ai/module-definitions.ts
import type { ModuleDefinition } from 'glirastes';
import {
  toolsByModule,
  moduleTypes,
  relatedModules,
  type IntentType,
} from '@/generated/ai-tools/modules.generated';
import { moduleMeta } from '@/lib/ai/module-meta';

function buildModuleDefinition(type: IntentType): ModuleDefinition {
  const meta = moduleMeta[type];
  return {
    id: type,
    name: type.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
    description: meta.classification.hint,
    tools: [...toolsByModule[type]],
    executionDefaults: {
      contextWindow: meta.execution.contextWindow,
      modelTier: meta.execution.modelTier,
    },
    classification: meta.classification,
    systemPrompt: meta.systemPrompt,
  };
}

export const modules: ModuleDefinition[] = moduleTypes.map(buildModuleDefinition);
export { relatedModules };
```

The chat handler and the test suite both import `modules` from this file.

### Module metadata flag

If your `module-meta.ts` lives at a non-default path:

```bash
glirastes generate-tools --meta @/lib/ai/module-meta
```

`@/...` resolves to your TS path alias.

## All CLI commands

| Command | Purpose | Common flags |
|---|---|---|
| `glirastes scaffold --route <file>` | Bootstrap `ai-tool.ts` next to a `route.ts` from method, path params, body fields | `--dry-run`, `--force`, `--root <dir>` |
| `glirastes generate-tools` | Run all generators (endpoint + UI + modules + action IDs) | `--meta <import-path>`, `--quiet` |
| `glirastes generate-endpoint-tools` | Endpoint registry only | `--quiet` |
| `glirastes generate-ui-tools` | UI tool registry + action IDs | `--quiet` |
| `glirastes generate-modules` | Module/intent registry only | `--meta <import-path>` |
| `glirastes generate-auto` | Auto-detect repo layout, choose generator + skill/MCP output | — |
| `glirastes generate <openapi.yaml>` | Generate endpoint tools from an OpenAPI spec (good for legacy backends) | `--out <file>` |
| `glirastes validate <openapi.yaml>` | Validate `x-ai` extensions in an OpenAPI spec | `--ci` |
| `glirastes validate-tools` | Validate naming, duplicates, missing approvals, path mismatches | `--ci`, `--fix`, `--quiet` |
| `glirastes coverage` | Routes without `ai-tool.ts`, orphan handlers, unhandled action IDs | `--ci`, `--quiet` |
| `glirastes test` | Scaffold an AI behaviour test file (Vitest, no LLM call) | `--output <file>`, `--force`, `--dry-run` |
| `glirastes install-skills` | Install the bundled agent skills (this directory) into a target like `.claude/skills` | `--target <dir>`, `--stack nextjs\|nestjs\|nextjs+nestjs\|all`, `--symlink`, `--force`, `--dry-run` |
| `glirastes generate-skills` | Export the registry as Claude Code / Codex skill files (so *agents* can call your tools) | `--app-name`, `--base-url`, `--auth bearer\|api-key\|oauth2\|cookie`, `--token-env`, `--format markdown\|json\|both`, `--output-dir`, `--sync`, `--remote` |
| `glirastes generate-mcp-server` | Export the registry as a standalone MCP server project | `--app-name`, `--base-url`, `--auth ...` |
| `glirastes check-upgrade` | Compare current code against SDK release notes; flag breaking changes | `--from-version <ver>` |
| `glirastes sync` | Upload tool schemas to the Glirastes platform (Pro registry) | `--api-key` (or `GLIRASTES_API_KEY` env), `--url` |

### CLI flag deep-dive

| Flag | Effect |
|---|---|
| `--quiet` | One-line output — ideal for `predev`/`prebuild` hooks |
| `--ci` | Exit code 1 on any issue — for CI pipelines |
| `--fix` | On `validate-tools`, prints quick-fix scaffold commands per missing tool |
| `--dry-run` | On `scaffold` / `test`, preview generated code without writing |
| `--force` | On `scaffold` / `test`, overwrite existing file |
| `--meta <path>` | Path to `module-meta.ts` (uses TS path aliases like `@/lib/ai/module-meta`) |
| `--app-name` (skills/mcp) | Name for the skill or MCP server |
| `--base-url` (skills/mcp) | Backend base URL the agent should call |
| `--auth bearer` (skills/mcp) | Auth strategy. `bearer` reads token from env var (default `API_TOKEN`); `api-key` uses an API key header; `oauth2` adds OAuth flow scaffolding; `cookie` uses session cookies |
| `--token-env <NAME>` | For bearer auth, the env var the agent reads the token from |
| `--sync` (skills) | Upload to Glirastes platform after generating |
| `--remote` (skills) | `--sync` + trigger remote regeneration on the platform |

### Coverage report — what it catches

| Section | Catches |
|---|---|
| **Uncovered Routes** | `route.ts` without an `ai-tool.ts` next to it (with `glirastes scaffold` suggestion) |
| **Uncovered Components** | Component directory without an `ai-ui-tool.ts` |
| **Missing Handlers** | UI tool defines `actionId` X, but no `useAiClientAction('X')` found in `.tsx` files |
| **Orphan Handlers** | `useAiClientAction('X')` exists, but no UI tool defines `actionId: 'X'` |

### Validation report — severities

- **Errors** (block CI with `--ci`): orphaned `ai-tool.ts` without a `route.ts`, missing exports, malformed Zod schemas
- **Warnings**: routes without an `ai-tool.ts` (with scaffold suggestion), path mismatches between `path` and route filesystem location
- **Info**: tools without a `module` field (with module-assignment hint)

Add `--fix` to get a consolidated quick-fix block at the bottom.

### Excluding routes from coverage

Skip a route from coverage and validation:

- File-level: `// @ai-ignore` at the top of `route.ts`
- Directory-level: a `.ai-ignore` file in any directory excludes the entire subtree

## Testing — deterministic, no LLM

`glirastes test` scaffolds a Vitest test file using `glirastes/server/testing`:

```ts
import { createAiTestSuite } from 'glirastes/server/testing';
import { modules } from '@/lib/ai/module-definitions';
import { endpointToolRegistry } from '@/generated/ai-tools/endpoint.generated';
import { uiToolRegistry } from '@/generated/ai-tools/ui.generated';

const suite = createAiTestSuite({
  tools: { ...endpointToolRegistry, ...uiToolRegistry },
  modules,
});

suite.smokeTest();        // module completeness, naming, no duplicates
suite.guardrailsTest();   // injection, length, sanitization
suite.approvalTest();     // POST/DELETE → needsApproval:true (default)
suite.routingTest([
  { input: 'show tasks', expectModule: 'task_query', expectTools: ['list_tasks'] },
  { input: 'create a task: review PR', expectModule: 'task_mutation' },
]);

// Low-level: simulate the pipeline directly
const result = await suite.simulatePipeline('list my tasks', {
  intent: 'task_query', confidence: 0.95,
});
expect(result.tools).toContain('list_tasks');
```

**When to update tests:**
- New tool → add a routing case
- Tool moved to a different module → update `expectModule`
- Tool renamed → update `expectTools`
- New mutation → confirm `needsApproval: true`
- New module → add smoke + routing cases

## Naming conventions

| Field | Format | Example |
|---|---|---|
| `id` | dot-notation, `<resource>.<action>` | `tasks.list`, `tasks.bulk.update`, `users.search` |
| `toolName` | snake_case | `list_tasks`, `bulk_update_tasks`, `find_user` |
| `module` | snake_case noun phrase | `task_query`, `task_mutation`, `navigation` |
| `actionId` (UI) | dot-notation, `<entity>.<action>` | `task-details.open`, `tasks.refresh` |

Both `id` and `toolName` must be unique across the whole registry — `glirastes validate-tools` enforces this.

## After every change — run the validation chain

1. `npm run ai:generate` — regenerate registries
2. `npm run ai:validate` — naming, duplicates, missing approvals, path mismatches
3. `npm run ai:coverage` — routes without ai-tool.ts, orphan handlers
4. `npm run ai:test` (if you have behaviour tests)
5. `npm run build` — final type-check + Next.js / NestJS build

CI: add `ai:coverage:ci` and `ai:validate:ci` as required steps.

## What this skill does NOT cover

- **Framework wiring** (chat route, decorators, `AiChatModule`) — see [integrating-glirastes-nextjs](../integrating-glirastes-nextjs/SKILL.md) or [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md)
- **Chat UI customization** (theming, mentions, voice, approval cards) — see [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md)
- **Glirastes platform deep-dive** (PII Shield via `createPiiShield`, intent routing via `createLancer`, custom guardrails, service degradation) — opt in via `GLIRASTES_API_KEY`; documented separately at [docs.chainmatics.de](https://chainmatics.de)
