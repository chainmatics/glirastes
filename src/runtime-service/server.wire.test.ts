import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeHttpServer } from "./server.js";
import { parseRuntimeConfig } from "./config.js";

// Same fixture as server.test.ts; maxBodyBytes at its floor keeps overflow
// requests small enough to arrive in one socket read.
const config = parseRuntimeConfig({
  schemaVersion: 1,
  server: {
    publicOrigin: "http://app.test",
    drainTimeoutMs: 100,
    maxBodyBytes: 1024,
  },
  application: {
    artifact: "/artifact",
    apiOrigin: "http://api.test",
    allowedPathPrefixes: ["/api"],
  },
  identity: { endpoint: "/api/me", credential: { type: "bearer" } },
  model: { name: "test", apiKeyFile: "/secret" },
  approvals: { secretFile: "/secret", connectionStringFile: "/db" },
});

const cleanups: Array<() => Promise<void>> = [];
let lastHost: ReturnType<typeof createRuntimeHttpServer> | undefined;
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function start(
  handleChat: (r: Request) => Promise<Response>,
  ready = true,
) {
  const host = createRuntimeHttpServer({
    config,
    handleChat,
    isReady: async () => ready,
  });
  await new Promise<void>((resolve) =>
    host.server.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(host.close);
  lastHost = host;
  return (host.server.address() as { port: number }).port;
}

/** Writes one raw HTTP/1.1 request (adds Connection: close) and returns the normalized response text. */
function rawExchange(
  port: number,
  request: string,
  onData?: (text: string) => void,
): Promise<string> {
  const [head, ...rest] = request.split("\r\n\r\n");
  const [line, ...headers] = head!.split("\r\n");
  const raw = [line, ...headers, "Connection: close"].join("\r\n") +
    "\r\n\r\n" +
    rest.join("\r\n\r\n");
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      onData?.(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", reject);
    socket.on("close", () =>
      resolve(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/^Date: .*$/m, "Date: <date>")
          .replace(/^x-request-id: .*$/m, "x-request-id: <id>"),
      ),
    );
    socket.write(raw);
  });
}

const post = (body: string, extra: string[] = []) =>
  [
    "POST /glirastes/chat HTTP/1.1",
    "Host: 127.0.0.1",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...extra,
  ].join("\r\n") +
  "\r\n\r\n" +
  body;

describe("runtime HTTP host wire bytes", () => {
  it("200 JSON from the handler", async () => {
    const port = await start(async () => Response.json({ ok: true }));
    expect(await rawExchange(port, post("{}"))).toMatchInlineSnapshot(`
      "HTTP/1.1 200 OK
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      x-accel-buffering: no
      Date: <date>
      Connection: close
      Transfer-Encoding: chunked

      b
      {"ok":true}
      0

      "
    `);
  });

  it("streamed body in three chunks", async () => {
    const port = await start(
      async () =>
        new Response(
          new ReadableStream({
            async start(c) {
              const enc = new TextEncoder();
              c.enqueue(enc.encode("a"));
              await sleep(5);
              c.enqueue(enc.encode("b"));
              await sleep(5);
              c.enqueue(enc.encode("c"));
              c.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    );
    expect(await rawExchange(port, post("{}"))).toMatchInlineSnapshot(`
      "HTTP/1.1 200 OK
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: text/plain
      x-accel-buffering: no
      Date: <date>
      Connection: close
      Transfer-Encoding: chunked

      1
      a
      1
      b
      1
      c
      0

      "
    `);
  });

  it("413 by content-length", async () => {
    const port = await start(async () => new Response("never"));
    const request =
      [
        "POST /glirastes/chat HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        "Content-Length: 2000",
      ].join("\r\n") + "\r\n\r\n";
    expect(await rawExchange(port, request)).toMatchInlineSnapshot(`
      "HTTP/1.1 413 Payload Too Large
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 26

      {"error":"body_too_large"}"
    `);
  });

  it("413 by streamed overflow", async () => {
    const port = await start(async () => new Response("never"));
    const chunk = "x".repeat(1100);
    const request =
      [
        "POST /glirastes/chat HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
      ].join("\r\n") +
      "\r\n\r\n" +
      `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
    expect(await rawExchange(port, request)).toMatchInlineSnapshot(`
      "HTTP/1.1 413 Payload Too Large
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 26

      {"error":"body_too_large"}"
    `);
  });

  it("415", async () => {
    const port = await start(async () => new Response("never"));
    const request =
      [
        "POST /glirastes/chat HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: text/plain",
        "Content-Length: 2",
      ].join("\r\n") + "\r\n\r\n{}";
    expect(await rawExchange(port, request)).toMatchInlineSnapshot(`
      "HTTP/1.1 415 Unsupported Media Type
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 25

      {"error":"json_required"}"
    `);
  });

  it("403 origin_denied", async () => {
    const port = await start(async () => new Response("never"));
    expect(
      await rawExchange(port, post("{}", ["Origin: https://evil.test"])),
    ).toMatchInlineSnapshot(`
      "HTTP/1.1 403 Forbidden
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 25

      {"error":"origin_denied"}"
    `);
  });

  it("404 not_found", async () => {
    const port = await start(async () => new Response("never"));
    expect(
      await rawExchange(port, "GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
    ).toMatchInlineSnapshot(`
      "HTTP/1.1 404 Not Found
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 21

      {"error":"not_found"}"
    `);
  });

  it("503 runtime_not_ready", async () => {
    const port = await start(async () => new Response("never"), false);
    expect(await rawExchange(port, post("{}"))).toMatchInlineSnapshot(`
      "HTTP/1.1 503 Service Unavailable
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 29

      {"error":"runtime_not_ready"}"
    `);
  });

  it("200 /healthz", async () => {
    const port = await start(async () => new Response("never"));
    expect(
      await rawExchange(
        port,
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      ),
    ).toMatchInlineSnapshot(`
      "HTTP/1.1 200 OK
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 17

      {"error":"alive"}"
    `);
  });

  it("500 when the handler throws before headers", async () => {
    const port = await start(async () => {
      throw new Error("boom");
    });
    expect(await rawExchange(port, post("{}"))).toMatchInlineSnapshot(`
      "HTTP/1.1 500 Internal Server Error
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: application/json
      Date: <date>
      Connection: close
      Content-Length: 26

      {"error":"request_failed"}"
    `);
  });

  it("handler-seen headers", async () => {
    let seen: string[][] = [];
    const port = await start(async (r) => {
      seen = [...r.headers].map(([k, v]) => [k, v]);
      return new Response(null, { status: 204 });
    });
    const body = "{}";
    const request =
      [
        "POST /glirastes/chat HTTP/1.1",
        "Host: evil.test",
        "X-Forwarded-Host: evil.test",
        "Forwarded: host=evil.test",
        "Connection: keep-alive",
        "TE: trailers",
        "X-Custom: 1",
        "Content-Type: application/json",
        `Content-Length: ${body.length}`,
      ].join("\r\n") +
      "\r\n\r\n" +
      body;
    await rawExchange(port, request);
    expect(seen.sort()).toMatchInlineSnapshot(`
      [
        [
          "content-length",
          "2",
        ],
        [
          "content-type",
          "application/json",
        ],
        [
          "te",
          "trailers",
        ],
        [
          "x-custom",
          "1",
        ],
      ]
    `);
  });

  it("abortAll mid-stream ends the chunked response cleanly", async () => {
    let cancelled = false;
    const port = await start(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("a"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    );
    let aborted = false;
    const text = await rawExchange(port, post("{}"), (soFar) => {
      if (!aborted && soFar.includes("\r\na\r\n")) {
        aborted = true;
        lastHost!.abortAll();
      }
    });
    expect(cancelled).toBe(true);
    expect(text).toMatchInlineSnapshot(`
      "HTTP/1.1 200 OK
      x-request-id: <id>
      cache-control: no-store
      x-content-type-options: nosniff
      content-type: text/plain
      x-accel-buffering: no
      Date: <date>
      Connection: close
      Transfer-Encoding: chunked

      1
      a
      0

      "
    `);
  });
});
