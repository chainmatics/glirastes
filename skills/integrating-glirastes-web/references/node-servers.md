# Node servers: Express, Fastify, NestJS

Use this when the chat handler runs in an existing `node:http`-style server.
The full text is `docs/node-servers.md` and, for middleware and several
instances, `docs/chat-route-security.md` in the matching SDK checkout.

## Contents

- Bridge contract
- Express
- Fastify
- NestJS
- NestJS Zod pipe
- More than one instance

## Bridge contract

`glirastes/server/node` connects `IncomingMessage` / `ServerResponse` to the
Web `Request`/`Response` handler from `createAiChatHandler`. It runs in the
consumer's process only and sends nothing to the Platform.

- `createNodeHandler(handler: WebHandler, options?: NodeHandlerOptions)`
  returns a `NodeHandler` `(req: NodeRequest, res: NodeResponse) => Promise<void>`
  that never rejects. Invalid options throw at creation.
- `toWebRequest(req, options?: ToWebRequestOptions)` and
  `sendWebResponse(res, response, options?: SendWebResponseOptions)` are the
  two halves for custom servers.
- URL: from `origin` or the socket's own address, never from `Host`.
  `x-forwarded-*` only with `trustForwardedHeaders: true` behind a proxy that
  always sets them. HTTPS or an API in another process: pass `origin`, or an
  `endpointCaller` with a fixed `baseUrl`.
- Body: read incrementally, default limit 1 MB (`maxBodyBytes`); keep it at
  least the handler's. A consumed stream falls back to `req.rawBody`, then
  `req.body` (re-serialized). Over the limit: 413 `body_too_large`
  (`RequestBodyTooLargeError`); other failures 500 `request_failed`; after
  headers the socket is destroyed.
- Response: streamed with backpressure, `res.flush()` when present,
  `x-accel-buffering: no`; client disconnect aborts `request.signal`.
- GET/HEAD never get a body. Mount the chat route on POST only so the
  framework's CORS answers OPTIONS.
- Tested: raw `node:http` and Express 5. Fastify and NestJS are recipes
  without a test in this repository; say so in the support record.

## Express

```ts
app.post('/api/chat', express.json({ limit: '2mb' }),
  createNodeHandler(chat, { maxBodyBytes: 2_000_000 }));
```

body-parser's default limit is 100 kB: raise it or leave `express.json()` off
the route. `compression` must not buffer the route (the bridge calls
`res.flush()`), and neither should a proxy.

## Fastify

Recipe, no test here:

```ts
fastify.post('/api/chat', async (request, reply) => {
  reply.hijack();
  await node(Object.assign(request.raw, { body: request.body }), reply.raw);
});
```

## NestJS

Recipe, no test here: a controller method
`@Post('chat') async chat(@Req() req, @Res() res) { await this.node(req, res); }`
with `NestFactory.create(AppModule, { rawBody: true })` for exact bytes.
Exclude the chat controller from tool generation.

## NestJS Zod pipe

The `nest` source reads the schema from a pipe's first constructor argument:
`@Body(new ZodValidationPipe(CreateTaskBody))`, `@Query(new ZodValidationPipe(ListTasksQuery))`
with module-level schema constants. The pipe calls `safeParse` and throws
`BadRequestException(issues.map((i) => \`${i.path.join('.') || '(body)'}: ${i.message}\`))`;
the model then sees `Bad Request: field: message; ...`. Full pipe in
`docs/node-servers.md`.

## More than one instance

The default approval store is per process: behind a load balancer, or after a
restart, a replayed approved history can run once more within
`approvalMaxAgeMs` (15 minutes by default) plus 60 s. Give every instance the
same `GLIRASTES_APPROVAL_SECRET` and one shared `approvalStore`
(PostgreSQL `INSERT ... ON CONFLICT DO NOTHING`, or Redis `SET NX PX`; recipes
in `docs/chat-route-security.md`). A store error must throw, never return
`true`. The runtime container keeps its own PostgreSQL store.
