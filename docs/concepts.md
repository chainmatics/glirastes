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
- **useAiClientAction(actionId, handler, contract?, { route? })**: React hook. You register a handler for a specific action ID (e.g., `'task-details.open'`) in the component that owns the effect, and it fires when that action comes through. When that component lives on one page, pass its static path as `route`: from any other page the chat opens the route through the navigation bridge, waits for the page to register the action and then runs it. A handler returns `false` when it could not do its work, so the chat does not report it as done. `registerAiClientAction` (`glirastes/browser`) takes the same `{ route }` options.
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

LLMs have limited context. A successful tool result whose JSON is longer than the limit (16,000 characters by default, roughly 4,000 tokens) is cut until it fits, so the limit is a true upper bound:

1. Fields whose key alone is longer than 120 characters are left out at any depth (counted, never named).
2. The array with the largest serialized size, at any depth (`data.items`), keeps as many leading entries as fit (binary search) when removing it could make the result fit or it is at least half of it. Sibling fields such as `meta` stay; if they alone are too large they are compacted first. If not even one entry fits, that entry is compacted (long strings clipped, nested objects and arrays replaced by short placeholders); if it still does not fit, no entry is kept.
3. A result without such an array has its long strings clipped and its largest fields replaced by placeholders. If that is still too large (thousands of fields), the leading top-level fields that fit are kept and the rest left out.
4. A `_truncated` marker is added: `field` (dot path), `showing` and `total` when an array was cut, `compacted` with up to five changed paths, `omittedKeys`, and a `hint` for the model. For a **read** tool (a GET or HEAD endpoint, or a tool without a method that needs no approval) the hint tells it to say "showing N of M" and offer filtering or the next page, naming the tool's paging parameters (`page`, `limit`, `offset`, `cursor`, `pageSize`, `per_page`, `skip`, `take`) when its input has them. For every other tool, which may already have written, the hint says not to call the tool again just to see more and to tell the user the result was shortened.

`success` and `uiAction` are never changed, so the one remaining exception to the bound is a `uiAction` that, with `success` and the marker, is itself larger than the limit; the result then keeps it and exceeds the limit. Failure results (`success: false`) are bounded separately, and values JSON cannot serialize (a cycle, a BigInt) are passed on unchanged. A root array that has to be cut comes back as `{ data: [...], _truncated }`. The input object is never modified, and the cost is linear in the result size (an 8 MB result takes well under a second).

### Result handles and `read_result`

With `createAiChatHandler` a large result is not simply cut (on by default, `resultHandles`). A successful record result over its limit is kept in full in a store that belongs to the running request, and the model gets an **overview** instead, breadth first: every entry of the largest array (reached through object properties, e.g. `data.items`) stays visible with its small fields, the largest fields measured across all entries (nested fields down to three levels) are left out first, and only when the small fields alone do not fit are entries dropped from the end. Fields that name an entry (`id`, `name`, `title`, `*Id`, …) stay. So "which playlists exist?" is answered without reading more. A result without such an array has its largest fields left out the same way. `success` and `uiAction` are untouched, and the overview always fits the limit (otherwise the result is cut as above):

```json
{ "success": true, "data": [{ "id": "p1", "name": "Road trip" }, "…all 20…"], "meta": { "page": 1 },
  "_result": { "id": "ro_ab12cd34", "arrays": { "data": 20 }, "showing": 20, "total": 20,
               "omitted": [{ "path": "data[].tracks", "approxChars": 160000 }], "hint": "…" } }
```

`approxChars` is the approximate serialized size of the field across all entries. The model reads more with the built-in tool `read_result`: `resultId`, `fields` (paths joined by `.`, `[]` for every element of an array: `data[].tracks`, `data[].owner.name`, `meta`; at most 50, no wildcards or filters), `offset` and `limit` (1 to 1,000; one window for the outermost arrays of every selected path, also arrays inside a selected object). Its answer carries `_result: { id, offset, returned, total, nextOffset }` for the paged array with the most entries, so `nextOffset` is present while any paged array has more, and `arrays` with `{ returned, total }` per array when several were paged; stays within the origin tool's limit (fewer entries first, then the usual cut of a single entry), reports paths that select nothing by their position in `unknownFields` (never the paths themselves), and never calls the backend: a write tool runs exactly once. Errors come back as results the model can act on: `invalid_fields`, `result_denied`, `budget_exhausted` and `result_expired`.

A handle lives only in its request. The id is random (`ro_` for a read tool, `rw_` otherwise), so an id from the history never reaches a handle of a later turn; an approval continuation (a new request) or a later turn answers `result_expired`. The hint is written for that: after a read tool the model calls the tool again, after any other tool it must not (the tool has run) and tells the user the details are no longer available. Per turn at most 8 handles, 2 MiB per result and 16 MiB in total are kept (`resultHandles: { maxResults, maxResultBytes, maxTotalBytes }`); beyond that, and with `resultHandles: false`, the result is cut as described above. Direct commands, `toolsToAiTools` without `resultStore`, the NestJS adapter and a turn whose registry has its own tool named `read_result` never create handles. The store is dropped when the response stream ends, fails or is cancelled; until then a request holds up to `maxTotalBytes` of serialized JSON per turn (more as JS objects in the heap).

Behaviour notes:

- A payload that carries its own top-level `_result` gets no handle; it is cut as described above, so its field is never dropped or overwritten. Loop detection strips `_result.id` only when it has the form of an issued handle id (`ro_`/`rw_` and 8 base36 characters).
- A registry tool named `read_result` stays the app's tool: that turn keeps no handles, and like every built-in name it is not indexed by `find_tools` in a turn without `managedRuntime`.
- In a managed turn a read that reads nothing (unknown or expired id, invalid fields, a handle of another principal) counts as a tool call and an error, so `maxToolCalls` and `maxConsecutiveErrors` bound a model that keeps asking, also with parallel calls; at the budget it answers `budget_exhausted`.

In a managed turn every read runs the origin tool's guard: it counts toward `maxToolCalls`, needs a freshly resolved principal and an unrevoked tool under the pinned revisions, and is fingerprinted with its arguments, so the same read three times trips `maxRepeatedFingerprint` while reads of other fields or offsets do not (the random `_result.id` is left out of the origin tool's own fingerprint). A handle also answers only the subject and tenant it was created for (`result_denied`). Without `managedRuntime` there is no principal: the handle is bound to the request alone, and `maxSteps` bounds the reads.

With `piiShield`, the complete result (including `uiAction`) is pseudonymized once when it is stored, and only that copy is kept. The overview and every `read_result` answer are cut from it and do not pass the shield again: detection depends on the surrounding text, so shielding excerpts separately could leave a name raw in one of them, and a pseudonym that looks like PII would be mapped a second time. Results without a handle are shielded as before. The arguments of `read_result` are never rehydrated (they are paths and ids), and no answer repeats what the model wrote (unknown paths come back by position, an expired id is not echoed), so `read_result` cannot turn a pseudonym into its original. The browser receives the overview and the `read_result` answers exactly as the model does; tool renderers and entity links only see what the overview contains.

Set the limit globally with `maxResultChars` on `createAiChatHandler` or `createGlirastes` (the runtime container: `application.maxResultChars`), or per tool with `maxResultChars` on the endpoint tool definition, `maxResultChars` in a sibling `contract.ts` entry, or the OpenAPI extension `x-glirastes-max-result-chars`. The tool value wins over the global one, the global one over the default. Values are integers from 1,000 to 200,000 (`MIN_MAX_RESULT_CHARS`, `MAX_MAX_RESULT_CHARS`); an invalid global value throws when the handler is created, an invalid extension is reported as `max-result-chars-invalid` (warning) and ignored. The per-tool value stays local in `.glirastes/tool-contracts.json` and the generated module; it is never sent to the Platform.

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

Request protection, on by default: the body must be `application/json` (415) and valid JSON (400 `invalid_json`), a browser request must come from the handler's own origin or from `allowedOrigins` (403; `crossOriginProtection: false` turns this off for apps that authenticate without cookies; a browser without `Sec-Fetch-Site` may also send the `Host` header's origin with `https` or `http`), and the body is capped at `maxBodyBytes`, 1 MB (413). Approvals are bound to the tool call they were asked for: the handler signs the approval id (HMAC-SHA-256 over tool call id, tool name, canonical input, issue time, expiry and the scope: the managed principal's tenant and subject, else `approvalScope(request)`, else `''` for everyone) with `approvalSecret` / `GLIRASTES_APPROVAL_SECRET`. Before the model runs, every tool part in the history that carries an approval id is checked against its own call. A history that repeats a tool call id or an approval id, or holds a malformed tool part or approval, is refused with 400 (`duplicate_tool_call_id`, `duplicate_approval_id`, `tool_part_malformed`, `approval_malformed`). An approved call without a result in the last step of the last assistant message must verify, be unexpired (`approvalMaxAgeMs`, 15 minutes, at most 24 hours) and unused; it is then consumed and may run, and more than 32 of them are refused (`too_many_approvals`). Every other approved call without a result is denied (`approval_not_runnable`), whatever follows it in the history, so only fully checked calls can run. A part whose id does not verify loses its approval. A `providerExecuted` flag that the client set on a tool of the handler's own registry is ignored. Single use: the default in-process store keeps each consumed approval until its signed expiry, so it runs at most once per process within its lifetime; it holds 20,000 live approvals, at most 200 per scope (without a managed principal or `approvalScope`, the quota scope is a keyed HMAC of the request's `Authorization`, else `Cookie`, header, which only partitions the quota and is not signed into the id; only requests without credentials share one quota), and refuses further approvals when full (`approval_store_unavailable`). Several instances need a shared `approvalStore`. Pipeline tool selection is routing, not authorization: an approved tool stays callable even if the selection for the continuation leaves it out. Endpoint tools call the origin of the request URL and never read `Host` or `x-forwarded-host` themselves; in Next.js that URL is the server's own listen address, outside Next.js it is whatever the adapter puts into the Web `Request` URL, so an adapter must build it from a fixed own origin, never from `Host` (or pass `endpointCaller` with a fixed `baseUrl`); an API in another process needs `endpointCaller` with a fixed `baseUrl`, or `trustForwardedHeaders` behind a proxy that always sets the header. Production refuses to serve approvals without the secret.

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
