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
