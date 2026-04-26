# glirastes — Simple Explanation

## What is this?

A toolkit for adding AI chat to your app. You define what the AI can do (tools), the SDK handles calling your APIs, filtering who can use what, protecting personal data, and updating the UI — all through a streaming chat experience.

---

## The Main Flow

```
User sends message → Guardrails check → Intent classification → Pick tools → LLM runs → Tool executes → UI updates
```

---

## Core Concepts

### Tool

A tool is something the AI can do. It has a name, a description (so the LLM knows when to use it), an input schema (what parameters it needs), and logic for what happens when it runs.

Example: a tool called `list_invoices` that calls `GET /api/invoices` and returns a list.

### defineEndpointTool()

The main way to create a tool. You declare the HTTP method and path, and the SDK calls your API for you. You never write the execute function — the SDK builds it automatically.

```ts
defineEndpointTool({
  toolName: 'list_invoices',
  method: 'GET',
  path: '/api/invoices',
  inputSchema: z.object({ status: z.string().optional() }),
  allowedRoles: ['accountant', 'admin'],
})
```

### defineUiTool()

A tool that doesn't call any API. It just tells the frontend to do something — open a dialog, navigate somewhere, show a toast. Client-side only.

```ts
defineUiTool({
  toolName: 'open_settings',
  inputSchema: z.object({}),
  uiAction: { type: 'navigate', path: '/settings' },
})
```

### defineTool() (likely to be deprecated)

Low-level tool where you write the execute function yourself. Used internally by the SDK (endpointToolToTool and uiToolToTool both compile down to this). Not meant for app developers. Still exported but has zero external usage — only used inside server-core.

---

## RBAC (Role-Based Access Control)

Assigns different roles to users, which controls which tools the AI can see and use.

If a free-tier user can't do some calls (like advanced analytics), RBAC removes those tools from the LLM's context entirely. The LLM never sees them, never tries them, never fails. This prevents wasted API calls, bad user experience, and also keeps the tool set small so the LLM makes better decisions.

It is NOT a security layer — your backend still enforces its own auth. RBAC is a product/UX layer that shapes what the AI agent can offer to each user.

Two levels:
- **Local** (server-core): checks `allowedRoles` on each tool against the user's roles. In-memory, no network.
- **Delegated** (server-pro): asks Glirastes Gate service to decide. Lets you manage permissions from a dashboard without redeploying code.

---

## Registry

A registry is just a collection of tools stored as a key-value map (tool name → tool object).

- `endpointToolsToRegistry()` — takes an array of endpoint tools, returns a registry
- `uiToolsToRegistry()` — takes an array of UI tools, returns a registry
- `toolsToAiTools()` — takes a registry + user context, filters by RBAC, and outputs AI SDK-compatible tools that can be passed to `streamText()`

---

## UI Patterns

Declarative rules for what the frontend should do after a tool runs. Instead of writing custom code per tool, you declare a pattern and the SDK resolves it automatically.

- **filter-and-navigate**: Go to a page with filters applied (e.g., show invoices filtered by status)
- **open-detail**: Open a detail view for a specific entity (e.g., open task #123)
- **open-dialog**: Open a dialog (e.g., create-task form)
- **refresh**: Refresh a specific UI region (e.g., reload the task list)
- **toast**: Show a notification message

Patterns support `$variable` placeholders that get replaced with actual values from the tool input or response. Example: `path: '/tasks/$taskId'` becomes `/tasks/abc-123`.

---

## UI Action Dispatch (ui-react)

The bridge between AI tool results and your frontend components.

- **UiActionBus**: An event bus. When a tool produces a UI action, the bus dispatches it to registered handlers.
- **useAiClientAction(actionId, handler)**: React hook. You register a handler for a specific action ID (e.g., `'task-details.open'`), and it fires when that action comes through.
- **ActionIdRegistry**: Auto-generated map of all action IDs. In dev mode, warns you if an action fires but no handler is registered.

---

## Modules (Intent System)

Modules group tools by topic. Example: a "task management" module contains `list_tasks`, `create_task`, `update_task`. A "reporting" module contains `generate_report`, `export_csv`.

When a user sends a message, the SDK classifies which module the message belongs to (intent classification). Then it only gives the LLM the tools from that module instead of all tools. This makes the LLM more focused and accurate.

Confidence-based scoping:
- High confidence (85%+): only that module's tools
- Medium (70-85%): that module's tools + shared tools
- Low (<70%): all tools (can't determine intent, give everything)

Each module can also specify:
- `maxSteps`: how many LLM turns to allow
- `modelTier`: fast / standard / powerful (pick cheaper or smarter model based on task complexity)
- `systemPrompt`: custom instructions for that module
- `classificationHint` + `examples`: helps the intent classifier understand what belongs to this module

---

## Lancer (Glirastes Platform Client)

A client that talks to the Glirastes cloud platform. It adds "smart" features on top of the core SDK. Created with `createLancer(config)`.

Has 7 namespaces (each talks to a different Glirastes service):

| Namespace | What it does |
|-----------|-------------|
| **Gate** | RBAC — asks the platform which tools a user can access |
| **Primus** | Intent classification — figures out which module a message belongs to |
| **Warden** | Guardrails — checks if input is safe/on-topic before the LLM sees it |
| **Aegis** | PII detection — finds personal data (names, emails, etc.) and anonymizes it |
| **Config** | Dynamic configuration — fetch prompt overrides and settings without redeploying |
| **Telemetry** | Event logging — sends usage events to the platform dashboard (fire-and-forget) |
| **Approvals** | Tool approval — checks if a tool call needs human approval before executing |

### Graceful degradation

If Glirastes is unreachable, **everything still works**. Every namespace has a permissive fallback:

- Gate: all tools allowed (falls back to local RBAC)
- Warden: all input passes (no guardrail blocking)
- Primus: confidence = 0 (all tools given to LLM)
- Aegis: text passes through unchanged (no anonymization)
- Config: no overrides applied
- Telemetry: events silently dropped
- Approvals: falls back to local config

You can override this per service: `'fallback'` (default), `'silent'` (quiet fail), or `'block'` (hard error).

---

## Pipeline (server-pro)

The Pro pipeline is the full processing chain for a user message. Created with `createAiPipeline()`.

Steps in order:
1. **Guardrails** — Warden checks if the message is safe. Blocks harmful/off-topic input.
2. **Intent Classification** — Primus classifies which module the message belongs to.
3. **Tool Scoping** — Selects the right tools based on the classified module + confidence level.
4. **Model Selection** — Picks the right model tier (fast/standard/powerful) based on complexity.
5. **Returns** everything needed for `streamText()`: model, filtered tools, sanitized input, intent metadata.

If any Lancer call fails, the pipeline continues with fallback values (see degradation above).

### Legacy Mode (without Lancer)

If you don't use Lancer/Pro, you can provide your own `IntentRouter` callback that does classification and routing locally. The handler in adapter-nextjs supports both modes.

---

## PII Shield (pii-shield)

Protects personal data from leaking to the LLM. Created with `createPiiShield(config)`.

Four operations:
- **outbound(text)**: User sends a message → detect PII → replace "John Smith" with "Person_A" → send anonymized text to LLM
- **inbound(text)**: LLM responds with "Person_A" → replace back with "John Smith" → show real text to user
- **rehydrateArgs(args)**: LLM calls a tool with "Person_A" as an argument → replace with "John Smith" before calling the real API
- **anonymizeResult(result)**: Tool returns data containing PII → anonymize before LLM sees it

Two modes:
- `anonymize`: random replacements each time
- `pseudonymize`: deterministic — same PII always maps to the same pseudonym (so the LLM can reason about "Person_A" consistently across the conversation)

Can delegate detection to Glirastes Aegis or run locally.

---

## Approvals

Some tools can require human approval before executing. Example: `delete_user` should not run just because the LLM decided to — a human must confirm first.

Set via `needsApproval: true` on a tool definition. By default, non-GET endpoint tools require approval (mutations are gated), GET tools don't.

The chat-react package provides `ApprovalCard` and `BulkApprovalCard` components. The user sees a card in the chat: "The AI wants to delete user X. Approve or Reject?"

---

## Truncation

LLMs have limited context. If a tool returns a huge response (e.g., 10,000 rows), the SDK truncates it to ~16K characters. It uses binary search to find the largest array in the response and progressively removes items until it fits. Adds a `_truncated` marker so the LLM knows data was cut.

---

## Followup Suggestions

After the AI responds, it can suggest follow-up questions as clickable chips. This is powered by an internal tool (`suggest_followups`) that the LLM calls at the end of a turn. The UI renders them as buttons the user can click to continue the conversation.

Configurable: number of suggestions (default 3, max 5), locale, good/bad examples, which roles see them.

---

## Chat UI (chat-react)

React components and hooks for the chat experience. Styling-neutral (you provide classNames).

**Provider**: `AiChatProvider` wraps everything and manages state.

**Key hooks**:
- `useAiChat()` — messages, send, stop, clear, loading state
- `useApprovals()` — pending approvals, approve/reject
- `useMentions()` — @mention entities in messages
- `useSuggestions()` — followup suggestion chips
- `useDeepgramTranscription()` — voice input

**Key components**: MessageList, MessageBubble, ChatInput, ApprovalCard, PipelineTimeline, SuggestionBar, VoiceInputButton, AiTriggerButton.

---

## Frontend Transport (Do I need Vercel AI SDK on the frontend?)

The chat UI needs to talk to the backend somehow (send messages, receive streamed responses). This is called the "transport".

**Right now**, the only built-in transport uses the Vercel AI SDK (`@ai-sdk/react`'s `useChat` hook). So if you use `chat-react` today, you need `@ai-sdk/react` and `ai` installed on the frontend too.

**But the architecture doesn't require it.** There is a `ChatTransport` interface that is completely transport-agnostic. The `AiChatProvider` accepts a `transport` prop — you can plug in any implementation:

```tsx
// Default: Vercel AI SDK transport (requires @ai-sdk/react)
<AiChatProvider transport={vercelTransport}>

// Custom: your own SSE, WebSocket, or plain fetch transport (no Vercel needed)
<AiChatProvider transport={myCustomTransport}>
```

The `ChatTransport` interface is simple — just `messages`, `status`, `sendMessage()`, `stop()`, `setMessages()`, and `addToolApprovalResponse()`. You could implement it with a plain `fetch()` + `ReadableStream` and drop the Vercel dependency entirely.

All the AI logic (tool execution, RBAC, guardrails, etc.) runs on the backend. The frontend transport is just a pipe for streaming text back and forth.

---

## Server Adapters

The core logic lives in server-core. Adapters plug it into your framework.

### adapter-nextjs

`createAiChatHandler()` — creates a Next.js App Router route handler. Handles auth, message prep, intent routing (legacy or pipeline), RBAC filtering, and streaming. Emits `PipelineStepReport` events for real-time progress in the UI.

### adapter-nestjs

Uses decorators (`@AiModule()`, `@AiTool()`, `@AiParam()`) on NestJS controllers. `scanNestJsControllers()` introspects metadata at runtime and auto-builds endpoint tool definitions from decorated methods. No manual ai-tool.ts files needed.

---

## Codegen

Automates boring setup work.

- **Endpoint scanner**: Finds all `ai-tool.ts` files in your project, generates a registry file that imports and collects them
- **UI scanner**: Same for UI tools
- **Action ID registry**: Generates a map of all action IDs so the frontend can validate handlers exist
- **Module registry**: Generates module definitions combining tools into intent groups

---

## OpenAPI Generator (openapi-gen)

If you have an OpenAPI spec, this generates tool definitions from it automatically. Reads `x-ai` extensions on your endpoints to know which ones to expose as AI tools. Converts OpenAPI schemas to Zod code. Outputs a TypeScript file with all generated tools ready to use.

---

## CLI

Developer tool for working with the SDK.

| Command | What it does |
|---------|-------------|
| `init` | Interactive setup wizard — detects framework, scaffolds config |
| `generate` | Scan ai-tool.ts files, generate registries |
| `validate` | Check OpenAPI spec for issues (duplicates, missing metadata) |
| `coverage` | Report which API routes have AI tool definitions and which don't |
| `scaffold` | Auto-generate an ai-tool.ts template from an existing route |
| `test` | Scaffold a test file for AI behavior testing |
| `generate-skills` | Export tools as Claude Code / Codex skill files |
| `generate-mcp-server` | Export tools as a standalone MCP server |
| `sync` | Upload tool schemas to Glirastes platform |
| `upgrade` | Update all glirastes-* packages |

---

## Testing (testing package)

Test your AI tool setup without making real LLM calls.

- **Smoke tests**: Do all tools have valid schemas? Can they serialize/deserialize?
- **Routing tests**: Does intent classification pick the right module?
- **Guardrails tests**: Do unsafe inputs get blocked?
- **Approval tests**: Do mutating tools require approval?
- **Edge case tests**: Empty inputs, max-length inputs, unicode, special characters
- **Regression tests**: Do previously-fixed bugs stay fixed?

Uses `createMockToolExecutor()` to simulate tool execution without HTTP.

---

## Package Dependency Layers

```
Layer 0 (no internal deps):
  contracts    — types, schemas, definition helpers
  lancer       — Glirastes platform client

Layer 1 (depends on Layer 0):
  server-core  — tool conversion, RBAC, transport adapters
  codegen      — file scanning, code generation
  openapi-gen  — OpenAPI → tool definitions
  ui-react     — UiActionBus, action dispatch hooks

Layer 2 (depends on Layer 0 + 1):
  server-pro   — Pro pipeline (Lancer-powered)
  adapter-nextjs — Next.js handler
  adapter-nestjs — NestJS decorators + scanning
  chat-react   — chat UI components
  pii-shield   — PII anonymization
  cli          — developer CLI
  testing      — test utilities
```

---

## Open-Core Model

- **Free (MIT)**: contracts, server-core, ui-react, chat-react, codegen, openapi-gen, cli, adapters, testing
- **Pro (proprietary)**: server-pro (pipeline with Lancer delegation)
- **Lancer free tier**: telemetry reporting to Glirastes dashboard
- **Lancer pro tier**: guardrails, intent routing, PII protection, dynamic config, approval flows
