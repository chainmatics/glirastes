import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeHandler } from "./handler.js";
import type { WebHandler } from "./types.js";

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

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const serve = (handler: WebHandler, options?: Parameters<typeof createNodeHandler>[1]) =>
  listen(createServer(createNodeHandler(handler, options)));

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const echo: WebHandler = async (request) => Response.json(await request.json());
const postJson = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("createNodeHandler", () => {
  it("round-trips a chat-shaped POST", async () => {
    const url = await serve(echo);
    const body = { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }] };
    const response = await postJson(url + "/chat", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  it("streams a UI message stream response", async () => {
    const gate = deferred();
    const url = await serve(async () =>
      createUIMessageStreamResponse({
        stream: createUIMessageStream({
          async execute({ writer }) {
            writer.write({ type: "text-start", id: "t" });
            writer.write({ type: "text-delta", id: "t", delta: "one" });
            await gate.promise;
            writer.write({ type: "text-delta", id: "t", delta: "two" });
            writer.write({ type: "text-delta", id: "t", delta: "three" });
            writer.write({ type: "text-end", id: "t" });
          },
        }),
      }),
    );
    const response = await postJson(url + "/chat", {});
    const reader = response.body!.getReader();
    let seen = "";
    while (!seen.includes('"delta":"one"')) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended early");
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toMatch(/^data: /);
    expect(seen).not.toContain('"delta":"two"');
    gate.resolve();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain('"delta":"three"');
  });

  it("aborts request.signal when the client disconnects mid-stream", async () => {
    const didAbort = deferred();
    const didStart = deferred();
    const url = await serve(async (r) => {
      didStart.resolve();
      r.signal.addEventListener("abort", () => didAbort.resolve(), { once: true });
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("hello"));
            r.signal.addEventListener("abort", () => c.close(), { once: true });
          },
        }),
      );
    });
    const controller = new AbortController();
    const response = await fetch(url + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    await didStart.promise;
    await response.body?.getReader().read();
    controller.abort();
    await didAbort.promise;
  });

  it("answers no 500 after the client left", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const left = deferred();
      const threw = deferred();
      const started = deferred();
      const handler = createNodeHandler(async (r) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          r.signal.aborted ? resolve() : r.signal.addEventListener("abort", () => resolve()),
        );
        await left.promise;
        threw.resolve();
        throw new Error("late failure");
      });
      const writes = vi.fn();
      const done = deferred<string>();
      const server = createServer((req, res) => {
        const write = res.write.bind(res) as (chunk: unknown) => boolean;
        const end = res.end.bind(res) as (chunk?: unknown) => typeof res;
        res.write = ((chunk: unknown) => (writes(), write(chunk))) as typeof res.write;
        res.end = ((chunk?: unknown) => (chunk !== undefined && writes(), end(chunk))) as typeof res.end;
        handler(req, res).then(
          () => done.resolve("resolved"),
          () => done.resolve("rejected"),
        );
      });
      const url = await listen(server);
      const controller = new AbortController();
      const request = fetch(url + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }).catch(() => undefined);
      // Abort only once the handler runs, so the request surely reached the server.
      await started.promise;
      controller.abort();
      await request;
      await new Promise((r) => setTimeout(r, 30));
      left.resolve();
      await threw.promise;
      expect(await done.promise).toBe("resolved");
      expect(writes).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("413 with fixed JSON over maxBodyBytes", async () => {
    const url = await serve(echo, { maxBodyBytes: 10 });
    const response = await postJson(url + "/chat", { long: "x".repeat(50) });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"error":"body_too_large"}');
  });

  it("500 request_failed when the handler throws", async () => {
    const url = await serve(async () => {
      throw new Error("secret detail");
    });
    const response = await postJson(url + "/chat", {});
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"error":"request_failed"}');
  });

  it("passes OPTIONS through without a body", async () => {
    let seen: { method: string; body: unknown } | undefined;
    const url = await serve(async (r) => {
      seen = { method: r.method, body: r.body };
      return new Response(null, { status: 204, headers: { allow: "POST" } });
    });
    const response = await fetch(url + "/chat", { method: "OPTIONS" });
    expect(seen?.method).toBe("OPTIONS");
    expect(seen?.body).toBeNull();
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("validates options at creation", () => {
    expect(() => createNodeHandler(echo, { maxBodyBytes: 0 })).toThrow(
      new RangeError("maxBodyBytes must be a positive safe integer"),
    );
    expect(() => createNodeHandler(echo, { maxBodyBytes: 1.5 })).toThrow(RangeError);
    expect(() => createNodeHandler(echo, { origin: "https://a/x" })).toThrow(
      new TypeError("origin must be an http(s) origin without a path"),
    );
  });

  it("works behind express.json()", async () => {
    let contentLength: string | null = null;
    const app = express();
    app.post(
      "/chat",
      express.json({ limit: "2mb" }),
      createNodeHandler(async (request) => {
        contentLength = request.headers.get("content-length");
        return echo(request);
      }),
    );
    const url = await listen(createServer(app));
    const body = { text: "ä ".repeat(10), nested: { a: [1, 2] } };
    const sent = JSON.stringify(body, null, 2);
    const response = await fetch(url + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sent,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(contentLength).toBe(String(Buffer.byteLength(JSON.stringify(body))));
  });

  it("works under an Express mount path", async () => {
    let seenUrl = "";
    const app = express();
    const router = express.Router();
    router.post(
      "/chat",
      createNodeHandler(async (request) => {
        seenUrl = request.url;
        return new Response("ok");
      }),
    );
    app.use("/api", router);
    const url = await listen(createServer(app));
    const response = await postJson(url + "/api/chat", {});
    expect(await response.text()).toBe("ok");
    expect(seenUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/chat$/);
  });
});
