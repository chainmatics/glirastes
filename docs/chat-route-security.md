# Chat route security

The chat handler from `glirastes/server/nextjs` (`createAiChatHandler`) protects the route for you. This page lists what it enforces and what you configure.

## Approvals and request checks

Set `GLIRASTES_APPROVAL_SECRET` (at
least 16 characters, the same on every instance) before production: it signs
each approval the handler asks for to that tool call, its input, an expiry
(15 minutes by default) and the user (the managed principal, as in the README quickstart, or your
`approvalScope(request)`), so an approval in a forged or edited chat history
runs nothing; production refuses to serve approvals without it. An approved
call runs only when every check passed in that request; any other approved
call without a result in the history is denied. With the default in-process store, each
approval runs at most once per process within its lifetime, and each caller
holds at most 200 live approvals. Without a managed runtime or
`approvalScope`, the caller is told apart by a keyed hash of the request's
`Authorization` or `Cookie` header (only requests without credentials share
one quota); `approvalScope` also binds each approval to its user. With several instances, pass a
shared `approvalStore` (e.g. Redis), or a replayed history can run once more
on another instance. The handler also answers 415 to a body that is not
`application/json`, 403 to a browser request from another origin (list yours
in `allowedOrigins`), 413 above `maxBodyBytes` (1 MB), and 400 to a body that
is not JSON (`invalid_json`), to a history that repeats a tool call id or an
approval id (`duplicate_tool_call_id`, `duplicate_approval_id`), to a
malformed tool part or approval (`tool_part_malformed`, `approval_malformed`)
and to more than 32 approved calls in one request (`too_many_approvals`).

## Frontend and API on different origins

When the chat UI runs on another origin than the handler, for example a Vite
or Angular frontend on `https://app.example.com` and a NestJS API that mounts
the handler on `https://api.example.com`, list the frontend's origin in
`allowedOrigins`:

```ts
createAiChatHandler({
  // ...
  allowedOrigins: ['https://app.example.com'],
});
```

This is mandatory, also when the frontend authenticates with a Bearer token
instead of a cookie. The browser marks such a request as cross-site
(`Sec-Fetch-Site`) and sends its `Origin`; an origin that is not listed is
refused with `403` and `{"error":"cross_origin_request_refused"}` before the
turn starts. Give exact origins (scheme, host and port, no path); the
handler's own origin needs no entry. Your framework's CORS setup (for the
preflight and the `Authorization` header) is separate and still required.
Do not set `crossOriginProtection: false` instead: that turns the check off
for every origin and is only acceptable when no cookie authenticates the route.

## Attachments

File parts are refused (400 `attachments_disabled`) unless
`attachments.enabled` is set; then `maxBodyBytes` defaults to 50 MB, only
`data:` URLs are accepted, and each file's type, size and first bytes are
checked. The PII shield does not see file contents, so `piiShield` together
with attachments needs `allowWithPiiShield: true`. See
[chat attachments](chat-attachments.md).

## Where endpoint tools call

Endpoint tools call the origin of the chat request's URL, the address your
Next.js server listens on, so they reach the app's own route handlers. If your
API runs in another process, even under the same public origin behind a
proxy, pass `endpointCaller: (request) => createHttpEndpointCaller({ baseUrl,
request })` with its origin; `trustForwardedHeaders: true` is the alternative
only when every request comes through a proxy that sets `x-forwarded-host`
(otherwise a client can aim the calls, with the user's cookie, at any host).

## Direct execution

`executeTool` and routes built from `glirastes/runtime/ai-sdk` alone run a tool
without these approval checks; give them only input your server has authorized.

## Tool middleware

`toolMiddleware` (on `createAiChatHandler` and `toolsToAiTools`) wraps the
execution of the app's own tools, for logging, metrics, tenant context or
error mapping. It runs inside every guard. One tool call, outermost first:

1. AI SDK `needsApproval` and the approval subject lookup (the lookup's own
   source call runs through the chain too, see below).
2. The handler's guard: abort check, approval gate, denied-call handling,
   managed `beforeToolCall` (pinned snapshot, freshly resolved principal,
   budgets, revocations), input parsing, tool timeout.
3. PII shield rehydration, when configured.
4. Abort check and result-store owner capture.
5. **`toolMiddleware[0]` → ... → `toolMiddleware[n-1]` → the tool.**
6. Output fields, the result store or truncation, uiAction normalization,
   audit `tool.executed`.
7. `afterToolCall` (budget fingerprint over the returned result) and PII
   anonymization.

A call that a guard stops (role, policy, revocation, budget, missing or used
approval) never reaches a middleware.

Each middleware is `(call, next) => result`. `call` carries `toolName`,
`toolId`, `toolCallId` (the AI SDK id; undefined for a direct command),
`input`, `method` (upper case, endpoint tools only), `readOnly`, `context` and
`abortSignal`. `call.input` is a structured clone of the validated input: the
tool always runs with the original, so an approval stays bound to exactly what
executes. The input must be structured-cloneable while `toolMiddleware` is
set. `next()` takes no arguments and runs the rest of the chain once; a second
call, or a call after the tool call ended, rejects without running anything.
Returning a value without calling `next()` short-circuits; that value still
goes through step 6. A throw before or after `next()` is a tool error: audit
`tool.failed`, `onToolError(toolId, error)` and the standard
`{ error: 'Error in <toolName>: <message>', hint }` result, exactly as a
throwing tool. An approval subject lookup (`docs/approval-subjects.md`) runs
its source tool through the same chain, as a read call: `toolName` is the
source tool, `readOnly` is `true` and `toolCallId` is the id of the approval
it serves, so tenant context and audit middleware see these backend reads
too. A lookup a middleware rejects shows the subject as not checked. The
handler's built-ins (`find_tools`, `read_result`,
clarification, plan, follow-ups, memory) bypass the chain. Tool arguments and
results stay in your process; nothing here is sent to the Platform.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

const toolCall = new AsyncLocalStorage<{ toolCallId?: string; tenantId: string }>();

createAiChatHandler({
  // ...
  toolMiddleware: [
    // Timing and logging, without arguments or results in the log line.
    async (call, next) => {
      const started = Date.now();
      try {
        return await next();
      } finally {
        logger.info({ tool: call.toolName, ms: Date.now() - started });
      }
    },
    // Tenant context for code the tool calls (endpointCaller, repositories).
    (call, next) => toolCall.run({ toolCallId: call.toolCallId, tenantId: currentTenant() }, next),
    // Error mapping: a domain error becomes a short message for the model.
    async (_call, next) => {
      try {
        return await next();
      } catch (error) {
        if (error instanceof TaskLockedError) throw new Error('The task is locked; ask the user.');
        throw error;
      }
    },
  ],
});
```

## Running more than one instance

The default approval store lives in the memory of one process. Behind a load
balancer, an approved history replayed to another instance runs there once
more, as long as the approval is valid: `approvalMaxAgeMs` (15 minutes by
default) plus 60 seconds of allowed clock skew. A restart clears the memory
store and opens the same window. With more than one instance, or restarts
within that window:

- give every instance the same `GLIRASTES_APPROVAL_SECRET`, and
- pass one shared `approvalStore`. Its `consume(approvalId, expiresAtMs, { scope })`
  returns `true` exactly once per id.

PostgreSQL:

```sql
create table glirastes_consumed_approvals (
  approval_id text primary key,
  expires_at timestamptz not null
);
```

```ts
const approvalStore: ApprovalStore = {
  async consume(approvalId, expiresAtMs) {
    const result = await pool.query(
      `insert into glirastes_consumed_approvals (approval_id, expires_at)
       values ($1, to_timestamp($2 / 1000.0) + interval '60 seconds')
       on conflict (approval_id) do nothing`,
      [approvalId, expiresAtMs],
    );
    return result.rowCount === 1;
  },
};
// periodically: delete from glirastes_consumed_approvals where expires_at < now()
```

Redis:

```ts
const approvalStore: ApprovalStore = {
  async consume(approvalId, expiresAtMs) {
    const ttl = Math.max(1, expiresAtMs - Date.now() + 60_000);
    // Redis 6.2 or later can use PXAT expiresAtMs + 60_000 instead.
    return (await redis.set(`glirastes:approval:${approvalId}`, '1', { NX: true, PX: ttl })) === 'OK';
  },
};
```

Let a store error throw: the handler then refuses the approval
(`approval_store_unavailable`), which fails closed. Never return `true` on an
error. The `scope` argument is for quotas only; single use is by id. Make
backend writes idempotent anyway, for example with a middleware that puts
`call.toolCallId` into an `AsyncLocalStorage` and an `endpointCaller` that
sends it as `Idempotency-Key`. The configured runtime container already
persists approvals in PostgreSQL; that store stays internal to the container.
