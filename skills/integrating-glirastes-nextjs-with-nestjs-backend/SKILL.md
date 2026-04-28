---
name: integrating-glirastes-nextjs-with-nestjs-backend
description: Integrating Glirastes into a full-stack monorepo with Next.js frontend and a separate NestJS backend — chat route on the backend, widget on the frontend, CORS, JWT forwarding, env separation. Use when the same workspace contains both a Next.js app and a NestJS API service.
version: 1.0.0
tags:
  - glirastes
  - nextjs
  - nestjs
  - monorepo
  - full-stack
triggers:
  - integrate glirastes nextjs nestjs
  - frontend backend chat
  - monorepo glirastes
  - next.js with nestjs
  - chat across frontend backend
  - full stack glirastes
---

# Integrating Glirastes — Next.js Frontend + NestJS Backend

> **Architectural rule:** When you have both a Next.js frontend and a separate NestJS backend, the chat route belongs on the **backend**. Putting it on the Next.js side means duplicating auth, an extra HTTP hop per tool call, and a forking source-of-truth for tool definitions. This skill assumes you've already accepted that — it walks the wiring.
>
> **Companion skills:**
> - [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md) — pure NestJS deep-dive (decorators, DI, WS)
> - [maintaining-glirastes-tools](../maintaining-glirastes-tools/SKILL.md) — tool authoring + CLI
> - [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md) — chat UI customization

## Stack detection

Confirm the workspace looks like this:

```
my-app/
├── frontend/        ← Next.js (next.config.{ts,js,mjs}, React 19+)
│   ├── package.json
│   └── src/app/
├── backend/         ← NestJS (nest-cli.json, @nestjs/core)
│   ├── package.json
│   └── src/
├── shared/          ← optional shared DTOs
│   └── package.json
└── package.json     ← optional workspace root
```

If only one of the two exists, switch to the appropriate single-stack skill — [Next.js](../integrating-glirastes-nextjs/SKILL.md) or [NestJS](../integrating-glirastes-nestjs/SKILL.md).

## Step 1 — Install in both packages

### Backend

```bash
cd backend
npm install glirastes @ai-sdk/openai
# Optional: speech-to-text via Deepgram
# npm install ws
```

### Frontend

```bash
cd frontend
npm install glirastes @ai-sdk/react react-markdown
# Optional: voice input UI
# npm install wavesurfer.js
```

The frontend gets the React UI peers but not `@ai-sdk/openai` — the model never runs in the browser. The backend gets the model provider.

## Step 2 — Environment variables

### Backend `.env`

```
OPENAI_API_KEY=sk-...
# Optional speech-to-text:
# DEEPGRAM_API_KEY=...
# Optional Glirastes platform:
# GLIRASTES_API_KEY=glir_...
```

### Frontend `.env.local`

```
NEXT_PUBLIC_API_URL=http://localhost:3000
```

The frontend only needs to know where the backend lives. **Never** put `OPENAI_API_KEY` in the frontend env — the model call lives on the backend.

## Step 3 — Backend tsconfig (no changes needed)

Glirastes 0.3.1+ ships dual CJS+ESM bundles plus subpath shims. The default NestJS template (`module: "commonjs"`, no explicit `moduleResolution`) works as-is. If your project is on a modern config (`module: "node16"` or similar), that's fine too.

## Step 4 — Annotate existing controllers (backend)

Pick controllers that should expose AI-callable methods. Annotate the class with `@AiModule` and each method with `@AiTool`:

```ts
// backend/src/tasks/tasks.controller.ts
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiModule, AiTool } from 'glirastes/server/nestjs';
import { TasksService } from './tasks.service';
import { CreateTaskDto, ListTasksQueryDto } from 'shared'; // shared DTOs

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

If you have a `shared/` package with DTOs, annotate the DTO fields with `@AiParam` so the LLM gets descriptions:

```ts
// shared/src/dtos/list-tasks.dto.ts
import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AiParam } from 'glirastes/server/nestjs';

export class ListTasksQueryDto {
  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  @AiParam('Optional status filter — one of "open" | "done".')
  status?: 'open' | 'done';
}
```

> **Watch the `shared/dist` cache.** If you previously experimented with `@AiTool`/`@AiParam` decorators in `shared/`, an old `dist/` copy may import a stale `glirastes/server/nestjs` path. Run `cd shared && npm run build` (or `./rebuild-shared.sh` if your workspace has one) to overwrite. Then `npm install` in the backend so the file:-dep refreshes.

## Step 5 — Wire AiChatModule on the backend

```ts
// backend/src/chat/chat.module.ts
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

Register in `AppModule`:

```ts
// backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    // ... existing modules (Auth, Tasks, etc.)
    ChatModule,
  ],
})
export class AppModule {}
```

The same JWT guard that protects your other endpoints now protects `/api/ai/chat` — single source of auth.

## Step 6 — CORS on the backend

The browser will hit the backend directly. Allow the frontend origin in `main.ts`:

```ts
// backend/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(3000);
}
bootstrap();
```

If your deployment puts both apps behind the same reverse proxy (nginx, Cloudflare) under a single hostname, you can skip CORS — same-origin requests don't need it.

## Step 7 — Mount the chat widget (frontend)

Use `VercelAiChat` and point `endpoint` at the backend. Pass the user's JWT through `headers`:

```tsx
// frontend/src/components/chat/ChatWidget.tsx
'use client';

import { VercelAiChat } from 'glirastes/react/vercel';
import { getToken } from '@/lib/auth'; // your existing token reader

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export function ChatWidget() {
  return (
    <VercelAiChat
      endpoint={`${API_URL}/api/ai/chat`}
      headers={() => {
        const token = getToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      }}
    />
  );
}
```

```tsx
// frontend/src/app/layout.tsx
import { ChatWidget } from '@/components/chat/ChatWidget';
import 'glirastes/react/styles.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <ChatWidget />
      </body>
    </html>
  );
}
```

`headers` is a function — re-evaluated on every request, so token rotation works without a remount.

## Step 8 — UI actions on the frontend (optional)

Endpoint tools that declare `uiPattern: { type: 'open-detail' | 'open-dialog' | 'refresh' | 'toast' }` emit a structured action through the `UiActionBus`. Register handlers in your frontend:

```tsx
'use client';
import { useAiClientAction } from 'glirastes/react';
import { useRouter } from 'next/navigation';

export function TaskList() {
  const router = useRouter();

  useAiClientAction('task-details.open', (payload) => {
    router.push(`/tasks/${payload?.taskId}`);
  });
  useAiClientAction('tasks.refresh', () => {
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  });

  // ...
}
```

The action ID is derived from the tool's `uiPattern`. See [maintaining-glirastes-tools](../maintaining-glirastes-tools/SKILL.md) for the mapping.

## Step 9 — Verify

In two terminals:

```bash
# Terminal 1
cd backend && npm run start:dev

# Terminal 2
cd frontend && npm run dev
```

Then:

1. Open the frontend (default `http://localhost:3001`)
2. Log in (so a JWT is in storage)
3. Click the floating chat trigger
4. Send *"show me my open tasks"*

Expected:
- Backend log shows `POST /api/ai/chat` and `GET /api/tasks` (the tool firing)
- Chat shows the result
- If a `uiPattern: 'filter-and-navigate'` is on the tool, the URL changes to `/tasks?status=open`

If the request fails with 401: the JWT isn't reaching the backend. Check `headers()` returns the right token. If 403: the JWT is valid but lacks permissions — the same RBAC your other endpoints enforce applies here.

## Step 10 — Optional: speech-to-text

Add `features: { speechToText: true }` to `AiChatModule.forRoot`, install `ws` on the backend, set `DEEPGRAM_API_KEY`, and call `await AiChatModule.attachWebSockets(app)` after `app.listen()`. Frontend: `showMic={true}` on `<VercelAiChat />` and install `wavesurfer.js`. Full instructions in [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md) → "Speech-to-text WebSocket".

## Architectural decisions made

| Decision | Reason |
|---|---|
| Chat route on the backend, not Next.js Route Handler | Tools are NestJS controllers — annotating them in place avoids a duplicate code path. JWT guard already exists. No HTTP hop per tool call. |
| `@ai-sdk/openai` lives only in backend | Model calls are server-side; the API key must never reach the browser. |
| `@ai-sdk/react` and `react-markdown` only in frontend | Optional peers since 0.3.1; backend doesn't need React. |
| `wavesurfer.js` only in frontend (and only if voice) | Browser-only library; backend doesn't render waveforms. |
| `ws` only in backend (and only if speech-to-text) | Server-side WebSocket proxy to Deepgram. Loaded via runtime helper since 0.3.1 — won't crash if missing when the feature is off. |
| CORS configured backend-side | Same-origin convenience requires a reverse proxy; without one, CORS is the cleanest path. |

## Common pitfalls (specific to this stack combination)

| Symptom | Cause | Fix |
|---|---|---|
| `CORS: Access-Control-Allow-Origin missing` in browser console | `enableCors` not configured | Add `app.enableCors({ origin: FRONTEND_URL, credentials: true })` |
| Chat returns 401 even though user is logged in | `headers()` not passing JWT, or token in wrong cookie/storage | DevTools → Network → check the `Authorization` header on `POST /api/ai/chat` |
| Tool fires but UI never reacts | `useAiClientAction` handler in a component not mounted on the active page | Move the handler to a layout that's always rendered, or to a global provider |
| Backend imports `glirastes/server/nestjs` but build fails | Old SDK (≤0.3.0 was ESM-only); workspace contains stale `shared/dist` | Upgrade to ≥0.3.1; rebuild `shared` package |
| Chat works in dev but breaks in production | `NEXT_PUBLIC_API_URL` not set in the production env | Set in your hosting provider's env config |
| Two chat widgets render on the page | `<ChatWidget />` duplicated | Render exactly once in the root layout |
| Voice input fails silently | `ws` missing on backend, or `wavesurfer.js` missing on frontend | Install on the side that needs it; check both browser DevTools (WS frame) and backend logs |

## What this skill does NOT cover

- **Pure Next.js (no separate backend)** — see [integrating-glirastes-nextjs](../integrating-glirastes-nextjs/SKILL.md)
- **Pure NestJS (Swagger UI as client)** — see [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md)
- **Tool authoring deep-dive** — see [maintaining-glirastes-tools](../maintaining-glirastes-tools/SKILL.md)
- **Chat UI customization** — see [building-glirastes-chat-ui](../building-glirastes-chat-ui/SKILL.md)
- **LangGraph backend** — swap `AiChatModule` (NestJS doesn't ship a LangGraph adapter directly); use the LangGraph transport on the React side
- **Glirastes platform features** — opt in via `GLIRASTES_API_KEY`; the SDK falls back to free-tier without it
