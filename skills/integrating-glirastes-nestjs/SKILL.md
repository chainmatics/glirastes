---
name: integrating-glirastes-nestjs
description: Integrating the Glirastes SDK into a NestJS backend — AiChatModule wiring, @AiTool / @AiModule / @AiParam decorators, scanNestJsControllers, attachWebSockets for speech-to-text. Use when adding AI chat to a NestJS service or to a NestJS+Next.js full-stack app.
version: 1.0.0
tags:
  - glirastes
  - nestjs
  - ai
  - decorators
triggers:
  - integrate glirastes nestjs
  - AiChatModule
  - AiModule decorator
  - AiTool decorator
  - AiParam
  - scanNestJsControllers
  - chat module nestjs
  - ai chat backend
  - attachWebSockets
---

# Integrating Glirastes into NestJS

> **Why pick this adapter:** NestJS already has your auth (JWT guard), tenant context, services and controllers. The decorators turn existing controllers into AI-callable tools — no second code path, no HTTP hop from frontend to backend per tool call. If you also have a Next.js frontend in the same workspace, the chat route still belongs **here**, not in a Next.js Route Handler.
>
> **Companion skills:**
> - [maintaining-glirastes-tools](../maintaining-glirastes-tools/SKILL.md) — tool authoring deep-dive, all CLI commands, codegen workflow
> - [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md) — chat UI in your frontend (talks to this backend)

## Stack detection

Confirm before applying:

- `nest-cli.json` exists at the project root → NestJS ✅
- `package.json` has `@nestjs/core` and `@nestjs/common`
- TypeScript backend (this adapter is type-driven)

## Step 1 — Install

```bash
npm install glirastes @ai-sdk/openai
# Optional: speech-to-text proxy via Deepgram WebSocket
npm install ws
```

`@ai-sdk/openai` is the OpenAI provider — swap for `@ai-sdk/anthropic`, `@ai-sdk/mistral`, etc. as needed.

`ws` is **only** needed if you enable `features.speechToText` and call `AiChatModule.attachWebSockets(app)`. Without that feature it's never loaded.

## Step 2 — Environment variables

`.env`:

```
OPENAI_API_KEY=sk-...
# Optional speech-to-text:
# DEEPGRAM_API_KEY=...
# Optional Glirastes platform (PII Shield, intent routing, telemetry):
# GLIRASTES_API_KEY=glir_...
```

## Step 3 — `tsconfig.json`

The default NestJS template (`module: "commonjs"`) works as-is on Glirastes 0.3.1+ — no changes needed. The package ships dual CJS+ESM bundles plus subpath shims.

If you're on a modern setup, this also works:

```jsonc
{
  "compilerOptions": {
    "module": "node16",          // or "nodenext" / "esnext"
    "moduleResolution": "node16", // or "nodenext" / "bundler"
    "target": "ES2022",
    "esModuleInterop": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`emitDecoratorMetadata` and `experimentalDecorators` are **required** — Glirastes' decorator scanner reads metadata.

## Step 4 — Annotate existing controllers

Two decorators turn an existing controller into an AI module:

- `@AiModule({ intent, classification })` on the class — declares the intent group + classification hints
- `@AiTool({ name, description })` on each AI-callable method
- `@AiParam('description')` on DTO fields the LLM should fill (only needed for body/query DTOs; path params from `@Param()` are auto-extracted)

```ts
// src/tasks/tasks.controller.ts
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiModule, AiTool } from 'glirastes/server/nestjs';
import { TasksService } from './tasks.service';
import { CreateTaskDto, ListTasksQueryDto } from './dto';

@Controller('tasks')
@UseGuards(AuthGuard('jwt'))
@AiModule({
  intent: 'task_management',
  classification: {
    hint: 'User asks about listing, filtering, creating, or updating tasks.',
    examples: [
      'show me open tasks',
      'create a task: review PR',
      'mark task 42 as done',
    ],
  },
})
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  @AiTool({
    name: 'list_tasks',
    description: 'List tasks with an optional status filter.',
  })
  list(@Query() q: ListTasksQueryDto) {
    return this.tasksService.list(q);
  }

  @Get(':id')
  @AiTool({
    name: 'get_task',
    description: 'Fetch a single task by its ID.',
  })
  get(@Param('id') id: string) {
    return this.tasksService.get(id);
  }

  @Post()
  @AiTool({
    name: 'create_task',
    description: 'Create a new task. Always confirm the title with the user first.',
  })
  create(@Body() dto: CreateTaskDto) {
    return this.tasksService.create(dto);
  }
}
```

```ts
// src/tasks/dto.ts
import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AiParam } from 'glirastes/server/nestjs';

export class ListTasksQueryDto {
  @IsString()
  @IsOptional()
  @AiParam('Optional status filter — one of "open" | "done".')
  @ApiProperty({ required: false })
  status?: 'open' | 'done';
}

export class CreateTaskDto {
  @IsString()
  @AiParam('The task title (required). Must be confirmed with the user.')
  @ApiProperty()
  title!: string;

  @IsString()
  @IsOptional()
  @AiParam('Optional assignee user ID — never invent, look up via find_user first.')
  @ApiProperty({ required: false })
  assigneeId?: string;
}
```

The scanner derives the Zod input schema from your DTOs (`class-validator` decorators + `@AiParam` descriptions) and auto-extracts path params from `@Param()`. You write DTOs once for HTTP, Swagger, validation, and AI.

## Step 5 — Wire AiChatModule

Create a `ChatModule` that:
1. Imports the modules whose controllers carry `@AiTool` decorators.
2. Calls `AiChatModule.forRoot({ ... })` with model, system prompt, and your existing auth guard.

```ts
// src/chat/chat.module.ts
import { openai } from '@ai-sdk/openai';
import { Module } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiChatModule } from 'glirastes/server/nestjs';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [
    TasksModule,
    AiChatModule.forRoot({
      model: openai('gpt-4o-mini'),
      systemPrompt: ({ currentDate }) =>
        `You are a helpful assistant. Today is ${currentDate}.`,
      authGuard: AuthGuard('jwt'),
    }),
  ],
})
export class ChatModule {}
```

Register `ChatModule` in `AppModule`:

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
// ... your other imports

@Module({
  imports: [
    // ... existing modules
    ChatModule,
  ],
})
export class AppModule {}
```

`AiChatModule` exposes `POST /api/ai/chat` (and `GET /api/ai/tools` to inspect the registered tools). The `authGuard` runs before every chat request, so the same JWT validation that protects your other endpoints applies here too.

## Step 6 — Verify

```bash
npm run build       # NestJS build
npm start           # or npm run start:dev for watch mode
```

Then check the tool registry directly:

```bash
curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/ai/tools
```

You should see a JSON list of all tools the scanner discovered. Send a chat request:

```bash
curl -X POST http://localhost:3000/api/ai/chat \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"list my open tasks"}]}'
```

The response is a streaming SSE — your frontend's `<VercelAiChat endpoint="...api/ai/chat" />` consumes it directly.

## Step 7 — Frontend connection

Your React frontend (any framework — Next.js, Vite + React, etc.) connects via the `endpoint` prop:

```tsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export function ChatWidget() {
  return (
    <VercelAiChat
      endpoint={`${API_URL}/api/ai/chat`}
      headers={() => ({ Authorization: `Bearer ${getToken()}` })}
    />
  );
}
```

CORS: ensure your NestJS app enables CORS for the frontend origin (typically in `main.ts` via `app.enableCors({ origin: '...', credentials: true })`).

For UI customization, see [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md).

## Step 8 — Optional: Speech-to-text WebSocket

To enable live voice transcription via Deepgram:

1. Set `features.speechToText: true` and provide an env var `DEEPGRAM_API_KEY`:

   ```ts
   AiChatModule.forRoot({
     model: openai('gpt-4o-mini'),
     authGuard: AuthGuard('jwt'),
     features: { speechToText: true },
   })
   ```

2. In your `main.ts`, attach the WebSocket server **after** `app.listen()`:

   ```ts
   // src/main.ts
   import { NestFactory } from '@nestjs/core';
   import { AiChatModule } from 'glirastes/server/nestjs';
   import { AppModule } from './app.module';

   async function bootstrap() {
     const app = await NestFactory.create(AppModule);
     await app.listen(3000);
     await AiChatModule.attachWebSockets(app); // async since 0.3.1
   }
   bootstrap();
   ```

3. Install `ws`: `npm install ws` (only needed for this feature).

4. Frontend: pass `showMic={true}` and install `wavesurfer.js` for the live waveform UI.

The WebSocket lives at `/api/ai/speech-stream`. The browser sends audio frames; the SDK proxies them to Deepgram with your `DEEPGRAM_API_KEY` server-side and streams transcriptions back.

## Multi-controller scanning (advanced)

By default, `AiChatModule.forRoot` discovers tools at runtime via the `DiscoveryService`. For build-time scanning (e.g. to validate the registry before deploy), use `scanNestJsControllers`:

```ts
import { scanNestJsControllers } from 'glirastes/server/nestjs';
import { endpointToolsToRegistry } from 'glirastes/server';
import { TasksController } from './tasks/tasks.controller';
import { UsersController } from './users/users.controller';

const scan = scanNestJsControllers({
  controllers: [TasksController, UsersController],
});

// scan.tools — flat array of tool definitions
// scan.modules — module metadata
// scan.toolsByModule — grouped by module
const registry = endpointToolsToRegistry(scan.tools);
```

You typically don't need this — runtime DI is simpler — but it's useful when generating skill files (`glirastes generate-skills`) or MCP servers without booting NestJS.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module 'glirastes/server/nestjs'` | Old SDK version (≤0.3.0 was ESM-only) | Upgrade to ≥0.3.1 — dual-bundle works with default CJS NestJS template |
| `TS1479: ECMAScript module cannot be imported with require` | Same as above | Upgrade to ≥0.3.1 |
| Tools missing from `/api/ai/tools` | Module not in `imports: [...]` of `ChatModule` | Add the module that owns the controller — DI must reach it |
| `attachWebSockets is not async` warning | Old SDK pre-0.3.1 | Upgrade to ≥0.3.1 and add `await` |
| `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'` at startup | `features.speechToText: true` without `ws` installed | `npm install ws` (only required when speech-to-text is on) |
| Tool description ignored by the LLM | Description too vague | Rewrite as *"WHEN to call: ... WHAT it returns: ..."* — descriptions are the primary LLM hint |
| Path param missing in tool input | DTO field with the same name shadows it | Path params are auto-extracted from `@Param()` — don't add them to your DTO |
| LLM hallucinates IDs | No lookup tool exposed | Add a `find_user` / `list_*` tool the LLM can call to resolve IDs first |

## What this skill does NOT cover

- **Tool authoring deep-dive** (input schemas, UI patterns, output schemas, approvals, `module`/`sharedWith`, classification, codegen) — see [maintaining-glirastes-tools](../maintaining-glirastes-tools/SKILL.md)
- **Chat UI customization** (theming, mentions, voice input UI, approval cards, action bus, ChatWindow portal) — see [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md)
- **Next.js standalone integration** (Next.js as the only backend) — see [integrating-glirastes-nextjs](../integrating-glirastes-nextjs/SKILL.md)
- **LangGraph transport** — if your backend speaks LangGraph instead, swap `AiChatModule` for the LangGraph wiring patterns; client-side, swap `VercelAiChat` for `LangGraphAiChat` from `glirastes/react/langgraph`
- **Glirastes platform features** (PII Shield via `createPiiShield`, intent routing via `createLancer`, guardrails, telemetry) — opt in via `GLIRASTES_API_KEY` env var; the SDK falls back to free-tier behaviour without it
