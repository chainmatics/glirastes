<p align="center">
  <a href="https://github.com/chainmatics/glirastes">
    <img alt="Glirastes SDK" src=".github/hero.gif" width="100%">
  </a>
</p>

<p align="center">
  <strong>The bridge between AI and your UI.</strong><br/>
  <sub>Define tools once. Execute on the server. React on the client. All type-safe.</sub>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#core-concepts"><strong>Concepts</strong></a> ·
  <a href="#examples"><strong>Examples</strong></a> ·
  <a href="#advanced"><strong>Advanced</strong></a> ·
  <a href="#cli"><strong>CLI</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/glirastes"><img src="https://img.shields.io/npm/v/glirastes?style=flat-square&labelColor=0a0a0a&color=6366f1" alt="npm version"/></a>
  <a href="#"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white&labelColor=0a0a0a" alt="TypeScript"/></a>
  <a href="https://sdk.vercel.ai/"><img src="https://img.shields.io/badge/Vercel_AI_SDK-compatible-8b5cf6?style=flat-square&labelColor=0a0a0a" alt="Vercel AI SDK"/></a>
  <a href="https://langchain-ai.github.io/langgraph/"><img src="https://img.shields.io/badge/LangGraph-compatible-1c3c3c?style=flat-square&labelColor=0a0a0a" alt="LangGraph"/></a>
</p>

<br/>

---

<br/>

## What is this?

**glirastes** is a TypeScript SDK for building AI-powered chat and tool systems. You describe what the AI can do with a handful of declarative tool definitions, and the SDK turns them into [Vercel AI SDK](https://sdk.vercel.ai/)-compatible tools that call your APIs, stream responses to the client, and trigger UI updates — all type-safe, all in one place. If your backend already runs [LangGraph](https://langchain-ai.github.io/langgraph/) instead, the same chat UI works against it via the LangGraph transport — no migration required.

It ships as a single npm package with subpath exports:

```ts
import { defineEndpointTool } from 'glirastes';
import { createAiChatHandler } from 'glirastes/server/nextjs';
import { VercelAiChat } from 'glirastes/react/vercel';
```

The server bits run in Node (Next.js App Router, NestJS, or any framework). The client bits are React. Everything else — PII protection, intent routing, guardrails, approvals — is optional and unlocked via the [Glirastes platform](https://chainmatics.de).

<br/>

## Why glirastes?

Building an AI feature means wiring together **tool definitions**, **API calls**, **streaming responses**, **UI reactions**, and — once real users hit it — **PII handling**, **approval flows**, **guardrails**, and **observability**. Every. Single. Time.

<table>
<tr>
<td width="50%">

**Without glirastes**
```
- Manual tool/function definitions
- Hand-wired UI action dispatch
- Custom PII redaction
- Framework-specific glue
- Bespoke approval flows
- DIY observability
```

</td>
<td width="50%">

**With glirastes**
```
✦ One declarative definition per tool
✦ Auto UI action dispatch
✦ Optional PII Shield
✦ Next.js / NestJS / LangGraph adapters
✦ Pro approval flows via platform
✦ Built-in telemetry
```

</td>
</tr>
</table>

<br/>

## Quick Start ([Next.js](https://nextjs.org/) or [NestJS](https://nestjs.com/))

Pick your stack — both come up in the same four steps.

### 1. Install

```bash
npm install glirastes
```

> **Requirements:** Node.js `>=20`, React `^19` (for the chat UI — `react-dom` is pinned to `^19`).
>
> **Peer dependencies for the React chat UI** (only install what you use):
> ```bash
> # Required for VercelAiChat / LangGraphAiChat:
> npm install react react-dom ai @ai-sdk/react
>
> # Optional — enables Markdown rendering in messages (falls back to plain text):
> npm install react-markdown
>
> # Optional — enables waveform visualization for voice input:
> npm install wavesurfer.js
> ```

### 2. Define a tool

The SDK uses the declared `method` + `path` (or the route the decorator already exposes) to call your own API when the LLM picks this tool — you never write a `fetch` yourself.

<table>
<tr>
<th>Next.js — co-located <code>ai-tool.ts</code></th>
<th>NestJS — decorators on your controller</th>
</tr>
<tr>
<td valign="top">

```ts
// app/api/tasks/ai-tool.ts
import { z } from 'zod';
import { defineEndpointTool } from 'glirastes';

export const listTasks = defineEndpointTool({
  id: 'tasks.list',
  toolName: 'list_tasks',
  description: 'List tasks with an optional status filter.',
  method: 'GET',
  path: '/api/tasks',
  inputSchema: z.object({
    status: z.enum(['open', 'done']).optional(),
  }),
});
```

</td>
<td valign="top">

```ts
// tasks.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { AiModule, AiTool } from 'glirastes/server/nestjs';

@Controller('tasks')
@AiModule({
  intent: 'task_management',
  classification: {
    hint: 'User asks about listing or filtering tasks.',
    examples: ['show me open tasks', 'what is done?', 'list my tasks'],
  },
})
export class TaskController {
  @Get()
  @AiTool({
    name: 'list_tasks',
    description: 'List tasks with an optional status filter.',
  })
  list(@Query('status') status?: 'open' | 'done') {
    return this.taskService.list(status);
  }
}
```

</td>
</tr>
</table>

### 3. Drop a chat widget into your frontend

```tsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';

export default function RootLayout({ children }) {
  return (
    <body>
      {children}
      <VercelAiChat endpoint="/api/chat" />
    </body>
  );
}
```

### 4. Wire up the chat handler

<table>
<tr>
<th>Next.js — <code>app/api/chat/route.ts</code></th>
<th>NestJS — register controllers in <code>AiChatModule</code></th>
</tr>
<tr>
<td valign="top">

```ts
import { createAiChatHandler } from 'glirastes/server/nextjs';
import { endpointToolsToRegistry } from 'glirastes/server';
import { listTasks } from './tasks/ai-tool';

export const POST = createAiChatHandler({
  tools: endpointToolsToRegistry([listTasks]),
});
```

</td>
<td valign="top">

```ts
import { scanNestJsControllers } from 'glirastes/server/nestjs';
import { endpointToolsToRegistry } from 'glirastes/server';
import { TaskController } from './tasks/tasks.controller';

const scan = scanNestJsControllers({ controllers: [TaskController] });
const registry = endpointToolsToRegistry(scan.tools);

// Pass `registry` to createAiChatHandler in your chat route.
```

</td>
</tr>
</table>

Done. AI chat is live, streaming, and your `list_tasks` tool is callable. Add more tools the same way — pick the style that matches your stack. See [NestJS with decorators](#nestjs-with-decorators) below for DTOs, `@AiParam`, and multi-controller scanning.

### Setup notes

#### Recommended `tsconfig.json` for consumers

Glirastes ships ESM with subpath `exports`. Your tsconfig must support that:

```jsonc
{
  "compilerOptions": {
    "module": "node16",          // or "nodenext" / "esnext"
    "moduleResolution": "node16", // or "nodenext" / "bundler"
    "target": "ES2022",
    "esModuleInterop": true,
    "experimentalDecorators": true,    // NestJS only
    "emitDecoratorMetadata": true      // NestJS only
  }
}
```

If you see `Cannot find module 'glirastes/server/nestjs'`, your `moduleResolution` is too old (legacy `"node"` does not understand `exports` maps).

> **NestJS users on the default CommonJS template:** glirastes is published as ESM only. If your backend's `tsconfig` is `"module": "commonjs"`, you'll hit `TS1479: ECMAScript module cannot be imported with require`. Migrate the backend to `module: "node16"` / `"nodenext"` or follow https://github.com/chainmatics/glirastes/issues for dual-bundle progress.

#### Which subpath do I import from?

| Where the code runs | Import from |
|---|---|
| Anywhere (tool definitions, types, helpers) | `glirastes` |
| Server-side core (registry helpers, pipeline) | `glirastes/server` |
| Next.js App Router route handlers | `glirastes/server/nextjs` |
| NestJS controllers / modules | `glirastes/server/nestjs` |
| Test suite without LLM calls | `glirastes/server/testing` |
| React components, client hooks | `glirastes/react` |
| Vercel AI SDK chat widget | `glirastes/react/vercel` |
| LangGraph chat widget | `glirastes/react/langgraph` |
| Default chat panel CSS | `glirastes/react/styles.css` |

<br/>

## Core Concepts

### Tool

A **tool** is something the AI can do. It has a name, a description (so the LLM knows when to use it), an input schema (Zod — validated at the type layer and at runtime), and logic for what happens when it runs.

Two flavors cover ~95% of real-world cases:

### Endpoint Tool — talks to your backend

```ts
import { z } from 'zod';
import { defineEndpointTool } from 'glirastes';

export const listInvoices = defineEndpointTool({
  id: 'invoices.list',
  toolName: 'list_invoices',
  module: 'billing',
  description: 'List invoices with optional status filter.',
  method: 'GET',
  path: '/api/invoices',
  inputSchema: z.object({
    status: z.enum(['paid', 'open', 'overdue']).optional(),
  }),
  uiPattern: {
    type: 'filter-and-navigate',
    target: 'invoices',
    filterMapping: { status: 'status' },
  },
});
```

You declare the HTTP method and path; the SDK generates the `execute` function that calls your API. You never write fetch boilerplate for a tool.

### UI Tool — fires frontend actions

```ts
import { z } from 'zod';
import { defineUiTool } from 'glirastes';

export const openSettings = defineUiTool({
  id: 'settings.open',
  toolName: 'open_settings',
  description: 'Open the settings dialog for the current user.',
  inputSchema: z.object({}),
  uiAction: { type: 'open-dialog', target: 'settings' },
});
```

No API call. The tool result contains a `uiAction` payload that's dispatched to registered React handlers via the `UiActionBus`. This is how "LLM opens a dialog" or "LLM navigates the user" works without round-tripping through your backend.

### Registry

A **registry** is a key-value map (tool name → tool object) that the SDK uses internally. Build one with `endpointToolsToRegistry(...)` or `uiToolsToRegistry(...)`:

```ts
import { endpointToolsToRegistry, uiToolsToRegistry } from 'glirastes/server';

const endpoints = endpointToolsToRegistry([listInvoices, createInvoice]);
const ui = uiToolsToRegistry([openSettings]);
const registry = { ...endpoints, ...ui };
```

Pass the merged registry to `createAiChatHandler({ tools: registry })` and the SDK converts it to AI SDK format at request time.

### UI Patterns

Declarative rules for what the frontend should do after a tool runs. Instead of writing custom dispatch code per tool, declare a pattern and the SDK resolves it automatically:

| Pattern | What it does |
|---|---|
| `filter-and-navigate` | Navigate to a page with filters pre-applied |
| `open-detail` | Open a detail view for a specific entity |
| `open-dialog` | Open a modal dialog |
| `refresh` | Refresh a specific UI region |
| `toast` | Show a notification |

Patterns support `$variable` placeholders that get replaced with values from the tool input or response. Example: `path: '/tasks/$taskId'` becomes `/tasks/abc-123` at runtime.

### UI Action Dispatch

On the frontend, register handlers for action IDs using the `useAiClientAction` hook:

```tsx
import { useAiClientAction } from 'glirastes/react';

function TaskList() {
  useAiClientAction('task-details.open', (payload) => {
    router.push(`/tasks/${payload?.taskId}`);
  });

  useAiClientAction('task-list.filter', (payload) => {
    setFilters(payload);
  });

  return <div>{/* your task list */}</div>;
}
```

When a tool returns a `uiAction` with a matching action ID, your handler fires. That's the full bridge between the LLM and your UI.

### Modules (Intent Routing)

Modules group tools by topic — e.g., a `billing` module contains `list_invoices`, `create_invoice`, `send_reminder`. When a user sends a message, the SDK can classify which module the message belongs to and scope the LLM's tool list to that module alone. Fewer tools = cheaper, faster, more accurate responses.

Module assignment is declared per-tool via the `module` field. Intent classification is a Pro feature that runs through the [Glirastes platform](https://chainmatics.de) via `Lancer` (see [Advanced](#advanced)).

<br/>

## Examples

### Full Next.js backend with the pipeline

The pipeline orchestrates guardrails → intent classification → tool scoping → model selection in one call. It's the recommended setup once you have more than a handful of tools.

```ts
// app/api/chat/route.ts
import { createAiChatHandler } from 'glirastes/server/nextjs';
import { createAiPipeline, endpointToolsToRegistry } from 'glirastes/server';
import { createLancer } from 'glirastes/server/lancer';
import { endpointTools } from '@/lib/ai-tools';
import { modules } from '@/lib/modules';

const lancer = createLancer({
  apiKey: process.env.GLIRASTES_API_KEY,
});

const pipeline = createAiPipeline({
  lancer,
  modules,
  defaultModule: 'general',
});

const registry = endpointToolsToRegistry(endpointTools);

export const POST = createAiChatHandler({
  tools: registry,
  pipeline,
});
```

Without an API key, the pipeline **still works** — every Lancer call falls back to a safe local default. Guardrails pass, classification returns low confidence, telemetry is silently dropped. You can develop and ship without ever talking to the platform.

### NestJS with decorators

Prefer declaring tools where the endpoint lives? Use NestJS decorators. Three pieces: `@AiModule` on the controller, `@AiTool` on the method, `@AiParam` on the DTO properties.

```ts
// tasks.controller.ts
import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { AiModule, AiTool } from 'glirastes/server/nestjs';

@Controller('tasks')
@AiModule({
  intent: 'task_management',
  classification: {
    hint: 'User wants to create, update, or query tasks.',
    examples: ['create a task', 'mark task as done', 'list my tasks'],
  },
})
export class TaskController {
  @Post()
  @AiTool({
    name: 'create_task',
    description: 'Create a new task',
  })
  async create(@Body() dto: CreateTaskDto) {
    return this.taskService.create(dto);
  }

  // Endpoints without @AiTool are not exposed to the AI
  @Get(':id/history')
  getHistory(@Param('id') id: string) {
    return this.taskService.getHistory(id);
  }
}
```

```ts
// create-task.dto.ts
import { IsString, IsOptional } from 'class-validator';
import { AiParam } from 'glirastes/server/nestjs';

export class CreateTaskDto {
  @IsString()
  @AiParam('The task title. Required. Ask the user if missing.')
  title!: string;

  @IsString()
  @IsOptional()
  @AiParam('Optional due date in ISO 8601 format.')
  dueDate?: string;
}
```

`@AiParam` descriptions are what the LLM sees when deciding whether and how to call the tool — write them as instructions for the model, not for humans. The input schema is auto-derived from the DTO's `class-validator` decorators.

Wire it up in your `AiChatModule`:

```ts
import { scanNestJsControllers } from 'glirastes/server/nestjs';
import { endpointToolsToRegistry } from 'glirastes/server';

const scan = scanNestJsControllers({
  controllers: [TaskController, /* ...other controllers */],
});
const registry = endpointToolsToRegistry(scan.tools);
```

`scanNestJsControllers` returns `{ tools, modules, toolsByModule }` — pass `scan.tools` to `endpointToolsToRegistry`, then hand `registry` to `createAiChatHandler({ tools: registry })`. No separate `ai-tool.ts` files, no manual registration.

### Client-side action handlers

```tsx
// components/chat-integration.tsx
'use client';
import { useAiClientAction } from 'glirastes/react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

export function ChatIntegration() {
  const router = useRouter();
  const qc = useQueryClient();

  useAiClientAction('task-details.open', (payload) => {
    router.push(`/tasks/${payload?.taskId}`);
  });

  useAiClientAction('task-list.refresh', () => {
    qc.invalidateQueries({ queryKey: ['tasks'] });
  });

  useAiClientAction('open-dialog.settings', () => {
    // open your settings modal
  });

  return null;
}
```

Render this component anywhere inside your layout. Handlers fire whenever a tool result contains a matching `uiAction`.

### OpenAPI code generation

Already have an OpenAPI spec? Annotate your endpoints with `x-ai` extensions:

```json
{
  "paths": {
    "/api/tasks": {
      "post": {
        "operationId": "createTask",
        "x-ai": {
          "enabled": true,
          "toolName": "create_task",
          "description": "Create a new task",
          "module": "task_management"
        }
      }
    }
  }
}
```

Then generate tool definitions automatically:

```bash
npx glirastes generate --input openapi.json --output src/generated/tools.ts
```

The generator converts OpenAPI parameter schemas to Zod, preserves `x-ai` metadata, and outputs a ready-to-import registry file.

### Testing without LLM calls

```ts
import { createAiTestSuite } from 'glirastes/server/testing';
import { endpointTools } from '@/lib/ai-tools';
import { modules } from '@/lib/modules';

const suite = createAiTestSuite({
  tools: endpointTools,
  modules,
});

suite.expectRouted('show me open tasks', 'task_query');
suite.expectNeedsApproval('delete_task');
suite.expectNoApproval('list_tasks');
suite.expectToolSchema('create_task').toAccept({ title: 'Buy milk' });
```

All assertions run without calling a real LLM or hitting HTTP — perfect for CI.

<br/>

## Advanced

### LangGraph backend

If your server already runs [LangGraph](https://langchain-ai.github.io/langgraph/), swap the drop-in widget for the LangGraph transport. Your LangGraph agent handles the model calls and tool execution; glirastes handles the chat UI and streaming transport:

```tsx
'use client';
import { LangGraphAiChat } from 'glirastes/react/langgraph';

export default function RootLayout({ children }) {
  return (
    <body>
      {children}
      <LangGraphAiChat endpoint="/api/chat" />
    </body>
  );
}
```

No `ai` / `@ai-sdk/react` imports needed — the LangGraph transport is pure HTTP and streams on its own.

### Customizing the chat UI

`VercelAiChat` and `LangGraphAiChat` are thin wrappers around `FloatingChatUI` and accept all its layout props directly:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  title="Ask the assistant"
  defaultOpen={false}
  draggable={true}
  resizable={true}
  size={{ width: 480, height: 640 }}
  shortcut="mod+k"
/>
```

| Prop | What it does |
|---|---|
| `title` | Header text. Default: `"AI Assistant"` |
| `defaultOpen` | Whether the window starts open. Default: `false` |
| `draggable` | Window draggable by its header. Default: `true` |
| `resizable` | Window resizable from corners. Default: `true` |
| `size` | `{ width, height }` or a responsive size config |
| `shortcut` | Keyboard shortcut to toggle, e.g. `'mod+k'`. Pass `false` to disable |
| `hideTriggerWhenOpen` | Hide the floating trigger pill while the window is open |
| `showClearButton` | Show the clear/trash button in the header. Default: `true` |
| `showSessionSwitcher` | `true`, `false`, or `'auto'` (shows if sessions are configured) |
| `headerActions` | Replace the default header actions with a custom `ReactNode` |
| `triggerIcon` | Custom icon inside the floating trigger pill |

### Styling

Every visual slot accepts a class name through the `classNames` prop. Works with Tailwind, CSS Modules, or any class-based styling:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  classNames={{
    window: 'w-[500px] h-[640px] bg-slate-900 border-slate-700 shadow-2xl',
    windowHeader: 'bg-slate-800 text-slate-100',
    messageBubble: 'rounded-xl',
    input: 'bg-slate-800 text-slate-100',
    trigger: 'bottom-8 right-8',
    triggerPill: 'bg-indigo-600 hover:bg-indigo-500',
  }}
/>
```

Available slots: `window`, `windowHeader`, `windowBody`, `panel`, `messageList`, `messageBubble`, `input`, `approvalCard`, `bulkApprovalCard`, `suggestionChip`, `mentionChip`, `pipelineTimeline`, `trigger`, `triggerPill`, `switcher`. Setting `classNames.window` drops the SDK's inline sizing styles so your classes win.

You can also bring your own stylesheet via `import 'glirastes/react/styles.css'` for the default look, or skip it entirely and style everything from scratch.

### Persisting chat across sessions

Every widget accepts a `session` config. The simplest version uses `localStorage`:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  session={{
    save: (id, msgs) => localStorage.setItem(id, JSON.stringify(msgs)),
    load: (id) => {
      const v = localStorage.getItem(id);
      return v ? JSON.parse(v) : null;
    },
  }}
/>
```

For multi-device sync, point `save` and `load` at your own REST endpoints that persist messages to a database. The SDK also supports a full session-list bridge (`list`, `create`, `delete`, `rename`) for apps that show a sidebar of past conversations — see `SessionConfig` in the source for the full shape.

### Manual wiring (sharing chat state with other components)

If you need to trigger chat programmatically from a button, show unread counts in the header, or render transcripts somewhere outside the chat panel, skip the drop-in widget and wire things manually:

```tsx
'use client';
import { AiChatProvider, AiChatPanel, useAiChat } from 'glirastes/react';
import { useVercelAiChatTransport } from 'glirastes/react/vercel';

export function ChatShell({ children }: { children: React.ReactNode }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={transport}>
      {children}
      <AiChatPanel />
    </AiChatProvider>
  );
}

// Anywhere inside the provider:
function HeaderBadge() {
  const { messages, isLoading } = useAiChat();
  return <span>{isLoading ? '•••' : messages.length}</span>;
}
```

### PII Shield — protect personal data from the LLM

```ts
import { createPiiShield, createAiChatHandler } from 'glirastes/server';
import { createLancer } from 'glirastes/server/lancer';

const lancer = createLancer({ apiKey: process.env.GLIRASTES_API_KEY });

const piiShield = createPiiShield({
  lancer,             // delegate detection to Aegis (Pro)
  mode: 'pseudonymize', // same PII → same pseudonym across a conversation
});

export const POST = createAiChatHandler({
  tools: registry,
  piiShield,
});
```

User sends "Email the invoice to john@example.com" → shield replaces `john@example.com` with `Email_A` before the LLM sees it → LLM calls `send_email({ to: 'Email_A' })` → shield rehydrates the real address before your API is called.

The free tier provides a **local detector** if you skip Lancer. Not as accurate as Aegis but zero-dependency and offline-safe.

### Approvals — human-in-the-loop for sensitive tools

Some tools shouldn't run just because the LLM decided to. `delete_user` should require human confirmation. Set it up via Lancer approvals (Pro):

```ts
const lancer = createLancer({
  apiKey: process.env.GLIRASTES_API_KEY,
  approvals: {
    policies: {
      'users.delete': 'require',
      'billing.charge': 'require',
      'users.list': 'auto',
    },
  },
});
```

The chat UI renders an `<ApprovalCard>` in the conversation — "The AI wants to delete user X. Approve or Reject?" — and pauses execution until the user clicks. If Lancer is unavailable, the SDK falls back to the local `needsApproval` flag (deprecated but still functional).

### Followup Suggestions

After the LLM responds, it can suggest follow-up questions as clickable chips. This is powered by an internal `suggest_followups` tool that the LLM calls at the end of a turn. Configurable count (default 3, max 5), locale, and good/bad examples.

Enable via:

```ts
createAiChatHandler({
  tools: registry,
  followups: { enabled: true, count: 3, locale: 'en-US' },
});
```

### Voice input

```tsx
import { VoiceInputButton } from 'glirastes/react';

<VoiceInputButton
  onTranscript={(text) => console.log(text)}
  language="en"
  baseUrl="/api/ai/speech-transcribe"
  getToken={() => authToken}
/>
```

The voice button streams audio to your backend, which proxies it to a speech-to-text provider (Deepgram, etc.). The API key never leaves the server.

> Install `wavesurfer.js` (`npm install wavesurfer.js`) to get the live waveform visualization during recording. Without it the button still works — it just falls back to a static recording indicator.

<br/>

## CLI

The SDK includes a `glirastes` CLI for scaffolding, code generation, and validation. Run any command with `npx glirastes <command>` or `bunx glirastes <command>`:

| Command | What it does |
|---|---|
| `generate` | Generate endpoint tools from an OpenAPI spec |
| `generate-tools` | Scan `*.ai-tool.ts` files, emit registry |
| `generate-endpoint-tools` | Endpoint tool registry only |
| `generate-ui-tools` | UI tool registry + action IDs |
| `generate-modules` | Module (intent) registry |
| `generate-skills` | Export tools as Claude Code / Codex skill files |
| `generate-mcp-server` | Export tools as a standalone MCP server project |
| `generate-auto` | Auto-detect layout and run the right generator |
| `validate` | Validate OpenAPI spec for `x-ai` correctness |
| `validate-tools` | Validate AI tool configuration |
| `coverage` | Report which API routes have AI tools and which don't |
| `scaffold` | Generate an `ai-tool.ts` template from an existing route |
| `test` | Scaffold an AI behavior test file |
| `check-upgrade` | Analyze release notes for breaking changes |
| `sync` | Upload tool schemas to the Glirastes platform |

<br/>

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). You may use, modify, and distribute this SDK freely in commercial and non-commercial projects.

<br/>

---

<p align="center">
  <sub>Built by <a href="https://chainmatics.de">Chainmatics</a></sub>
</p>
