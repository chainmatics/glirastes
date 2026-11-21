# Node servers (Express, Fastify, NestJS)

`createAiChatHandler` (from `glirastes/server/http` or `glirastes/server/nextjs`)
is a Web-standard handler: it takes a `Request` and returns a `Response`.
Next.js route handlers call it directly. Servers built on `node:http`
(`IncomingMessage` / `ServerResponse`) need a bridge, and
`glirastes/server/node` is that bridge. It runs in your process only, sends
nothing to the Platform and has no dependency beyond Node's built-ins.

Support level: integration-tested on raw `node:http` and Express 5. The
Fastify and NestJS sections are recipes without a test in this repository.

## The bridge

```ts
import { createAiChatHandler } from 'glirastes/server/http';
import { createNodeHandler } from 'glirastes/server/node';

const chat = createAiChatHandler({ /* ... */ });
const node = createNodeHandler(chat, { maxBodyBytes: 2_000_000 });
// node(req, res): Promise<void>, never rejects
```

- `createNodeHandler(handler, options)` returns `(req, res) => Promise<void>`.
  It builds the `Request`, calls the handler and streams the `Response` back.
  Invalid options throw when it is created.
- `toWebRequest(req, options)` and `sendWebResponse(res, response, options)`
  are the two halves, for a server that needs its own code in between.

**The Request URL comes from a fixed origin, never from `Host`.** The default
is the connection's own local address and port (`http`, or `https` on a TLS
socket), so the default endpoint caller reaches your own server. Pass
`origin: 'https://app.example.com'` to fix it yourself (an http(s) origin
without a path; anything else throws). The `Host` header is passed on
unchanged, because the handler's cross-origin check needs it.
`forwarded` / `x-forwarded-*` headers are dropped unless you set
`trustForwardedHeaders: true`, which is only safe behind a proxy that always
sets them. Hop-by-hop headers (`connection`, `keep-alive`, `te`, ...) are
always dropped. Behind TLS termination, or when your API runs in another
process, pass `origin` or give the handler an `endpointCaller` with a fixed
`baseUrl` (see [chat route security](chat-route-security.md#where-endpoint-tools-call)).

**The request body is read incrementally and bounded.** The default limit is
1 MB (`maxBodyBytes`, the handler's own default); the first byte over it ends
the read with 413. Keep the bridge's `maxBodyBytes` at least as large as the
handler's, or the bridge refuses bodies the handler would accept. When a body
parser already consumed the stream, the bridge uses `req.rawBody` (exact
bytes) or `req.body` (re-serialized as JSON, with a corrected
`content-length` and without `content-encoding`). The limit applies to every
source.

**The response streams with backpressure.** Each chunk is written as it
arrives; the bridge waits for `drain` when the socket is full, calls
`res.flush()` when a compression layer provides it, and sets
`x-accel-buffering: no` so nginx does not buffer the chat. When the client
disconnects, `request.signal` aborts (the turn stops) and the response body is
cancelled.

**Methods.** `GET` and `HEAD` requests never get a body; a `HEAD` response
writes status and headers only. Mount the chat route on `POST` only, so your
framework's CORS middleware answers `OPTIONS` preflights.

**Errors.** Over the limit: 413 `{"error":"body_too_large"}`
(`RequestBodyTooLargeError`). Any other failure before the response started:
500 `{"error":"request_failed"}` (499 when the client already left). Both are
fixed texts with `content-type: application/json`. A failure after the
headers were sent destroys the socket, since a status can no longer be sent.

## Express 5

```ts
import express from 'express';
import { createNodeHandler } from 'glirastes/server/node';

const app = express();
app.post(
  '/api/chat',
  express.json({ limit: '2mb' }),
  createNodeHandler(chat, { maxBodyBytes: 2_000_000 }),
);
```

`express.json()` is optional: without it the bridge reads the stream itself.
With it, raise its limit, because body-parser's default is 100 kB and refuses
attachment-sized chats before the bridge runs. The bridge uses
`req.originalUrl`, so a route under `app.use('/api', router)` keeps its full
path. If you use `compression`, it must not buffer the stream: the bridge
calls `res.flush()` after each chunk, or exclude the chat route from
compression. A proxy in front should not buffer either (`x-accel-buffering: no`
is set for nginx).

## Fastify

Recipe without a test in this repository:

```ts
const node = createNodeHandler(chat, { maxBodyBytes: 2_000_000 });

fastify.post('/api/chat', async (request, reply) => {
  reply.hijack();
  await node(Object.assign(request.raw, { body: request.body }), reply.raw);
});
```

`reply.hijack()` tells Fastify that the bridge writes the response.
Fastify's JSON parser has already consumed the stream, so the parsed body is
handed over as `body`. Fastify's own `bodyLimit` (1 MB by default) applies
first.

## NestJS on Express

Recipe without a test in this repository:

```ts
import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createNodeHandler } from 'glirastes/server/node';

@Controller()
export class ChatController {
  private readonly node = createNodeHandler(chat, { maxBodyBytes: 2_000_000 });

  @Post('chat')
  async chat(@Req() req: Request, @Res() res: Response) {
    await this.node(req, res);
  }
}
```

With `@Res()` Nest leaves the response to the bridge. Start the app with
`NestFactory.create(AppModule, { rawBody: true })` to forward the exact request
bytes (`req.rawBody`) instead of a re-serialized body; Nest's body parser
limit (100 kB by default) still applies, so raise it for attachments. Exclude
the chat controller from tool generation, so the chat route does not become a
tool of itself.

## Zod validation pipe for NestJS

The `nest` tool source reads a parameter's schema from a pipe's first
constructor argument. A small pipe is enough:

```ts
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
    );
  }
}
```

Use it with a module-level schema constant, so the scanner can resolve it:

```ts
const CreateTaskBody = z.object({ title: z.string().min(1) }).strict();
const ListTasksQuery = z.object({ status: z.enum(['open', 'done']).optional() });

@Post()
create(@Body(new ZodValidationPipe(CreateTaskBody)) body: z.infer<typeof CreateTaskBody>) { /* ... */ }

@Get()
list(@Query(new ZodValidationPipe(ListTasksQuery)) query: z.infer<typeof ListTasksQuery>) { /* ... */ }
```

A rejected input answers 400 with `{ message: string[], error: 'Bad Request' }`.
An endpoint tool turns that into `Bad Request: title: Too small ...; ...` for
the model, which can then correct its arguments.
