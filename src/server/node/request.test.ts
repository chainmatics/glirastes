import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { RequestBodyTooLargeError } from "./body.js";
import { toWebRequest, type ToWebRequestOptions } from "./request.js";
import type { NodeRequest } from "./types.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

/** Sends one raw request to a server that converts it and reports the result. */
async function convert(
  raw: string,
  options?: ToWebRequestOptions,
): Promise<{ port: number; request?: Request; error?: unknown }> {
  let settle!: (value: { request?: Request; error?: unknown }) => void;
  const result = new Promise<{ request?: Request; error?: unknown }>(
    (r) => (settle = r),
  );
  const server = createServer((req, res) => {
    toWebRequest(req, options).then(
      (request) => {
        settle({ request });
        res.end();
      },
      (error) => {
        settle({ error });
        res.end();
      },
    );
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(raw);
  const out = await result;
  socket.destroy();
  return { port, ...out };
}

async function consumed(extra: Record<string, unknown>): Promise<NodeRequest> {
  const readable = Readable.from([]);
  for await (const _chunk of readable) void _chunk;
  return Object.assign(readable, {
    method: "POST",
    url: "/chat",
    headers: {} as Record<string, string>,
    socket: { localAddress: "127.0.0.1", localPort: 4000 },
    ...extra,
  }) as unknown as NodeRequest;
}

describe("toWebRequest", () => {
  it("builds the URL from the socket's own address, never from Host", async () => {
    const { port, request } = await convert(
      "GET /chat?x=1 HTTP/1.1\r\nHost: evil.test\r\n\r\n",
    );
    expect(request!.url).toBe(`http://127.0.0.1:${port}/chat?x=1`);
    expect(request!.headers.get("host")).toBe("evil.test");
  });

  it("uses origin when given and refuses a non-origin", async () => {
    const { request } = await convert(
      "GET /chat HTTP/1.1\r\nHost: evil.test\r\n\r\n",
      { origin: "https://app.example" },
    );
    expect(request!.url).toBe("https://app.example/chat");
    for (const origin of ["https://app.example/x", "ftp://a", "https://u:p@a", "nope"]) {
      const req = await consumed({});
      await expect(toWebRequest(req, { origin })).rejects.toThrow(
        new TypeError("origin must be an http(s) origin without a path"),
      );
    }
  });

  it("keeps a protocol-relative request target on the fixed origin", async () => {
    const { port, request } = await convert(
      "GET //evil.test/chat HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(new URL(request!.url).host).toBe(`127.0.0.1:${port}`);
    expect(new URL(request!.url).pathname).toBe("//evil.test/chat");
    const absolute = await convert(
      "GET http://evil.test/chat HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(absolute.request!.url).toBe(`http://127.0.0.1:${absolute.port}/`);
  });

  it("drops x-forwarded-* unless trusted", async () => {
    const raw =
      "GET /chat HTTP/1.1\r\nHost: a\r\nX-Forwarded-Host: evil.test\r\nForwarded: host=evil\r\n\r\n";
    const dropped = await convert(raw);
    expect(dropped.request!.headers.has("x-forwarded-host")).toBe(false);
    expect(dropped.request!.headers.has("forwarded")).toBe(false);
    const kept = await convert(raw, { trustForwardedHeaders: true });
    expect(kept.request!.headers.get("x-forwarded-host")).toBe("evil.test");
    expect(kept.request!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/chat$/);
  });

  it("never attaches a body to GET or HEAD", async () => {
    for (const method of ["GET", "HEAD"]) {
      const { request, error } = await convert(
        `${method} /chat HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\n\r\n{}`,
      );
      expect(error).toBeUndefined();
      expect(request!.method).toBe(method);
      expect(request!.body).toBeNull();
    }
  });

  it("reads a streamed POST body", async () => {
    const { request } = await convert(
      "POST /chat HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
    );
    expect(await request!.text()).toBe('{"a":1}');
    expect(request!.headers.get("content-length")).toBe("7");
  });

  it("re-serializes a pre-parsed body with a correct content-length", async () => {
    const req = await consumed({
      body: { a: "ä" },
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "30",
      },
    });
    const request = await toWebRequest(req);
    expect(request.url).toBe("http://127.0.0.1:4000/chat");
    const text = '{"a":"ä"}';
    expect(request.headers.get("content-length")).toBe(
      String(Buffer.byteLength(text)),
    );
    expect(request.headers.has("content-encoding")).toBe(false);
    expect(await request.text()).toBe(text);
  });

  it("rejects with RequestBodyTooLargeError over maxBodyBytes", async () => {
    const { error } = await convert(
      "POST /chat HTTP/1.1\r\nHost: a\r\nContent-Length: 20\r\n\r\n",
      { maxBodyBytes: 10 },
    );
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5])(
    "refuses maxBodyBytes %s instead of reading without a limit",
    async (maxBodyBytes) => {
      await expect(
        toWebRequest(await consumed({ body: { a: 1 } }), { maxBodyBytes }),
      ).rejects.toThrow(new RangeError("maxBodyBytes must be a positive safe integer"));
    },
  );

  it("follows options.signal", async () => {
    const controller = new AbortController();
    const request = await toWebRequest(await consumed({ body: {} }), {
      signal: controller.signal,
    });
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("refuses without an origin when the socket has no address", async () => {
    await expect(
      toWebRequest(await consumed({ socket: {} })),
    ).rejects.toThrow(new TypeError("Cannot derive the server origin; pass origin"));
  });
});
