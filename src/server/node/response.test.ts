import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebResponse } from "./response.js";
import type { NodeResponse } from "./types.js";

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

const enc = new TextEncoder();
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

async function serve(
  handle: (res: NodeResponse, method: string | undefined) => Promise<void>,
) {
  const server = createServer((req, res) => {
    void handle(res, req.method);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("sendWebResponse", () => {
  it("streams chunks as they come, without buffering the whole body", async () => {
    const clientSawA = deferred();
    const enqueuedB = vi.fn();
    const url = await serve((res) =>
      sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(enc.encode("a"));
              await clientSawA.promise;
              enqueuedB();
              c.enqueue(enc.encode("b"));
              c.close();
            },
          }),
        ),
      ),
    );
    const response = await fetch(url);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("a");
    expect(enqueuedB).not.toHaveBeenCalled();
    clientSawA.resolve();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("b");
  });

  it("respects backpressure", async () => {
    const chunk = 64 * 1024;
    const count = 64;
    let falseWrites = 0;
    const done = deferred();
    const url = await serve(async (res) => {
      const write = res.write.bind(res) as (chunk: unknown) => boolean;
      res.write = ((value: unknown) => {
        const ok = write(value);
        if (!ok) falseWrites++;
        return ok;
      }) as typeof res.write;
      let i = 0;
      await sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            pull(c) {
              if (i === count) return c.close();
              c.enqueue(new Uint8Array(chunk).fill(i++ % 251));
            },
          }),
        ),
      );
      done.resolve();
    });
    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(url, (res) => {
        res.pause();
        setTimeout(() => {
          res.on("data", (b: Buffer) => received.push(b));
          res.on("end", () => resolve());
          res.resume();
        }, 100);
      });
      req.on("error", reject);
      req.end();
    });
    await done.promise;
    expect(falseWrites).toBeGreaterThan(0);
    const all = Buffer.concat(received);
    expect(all.length).toBe(chunk * count);
    for (let i = 0; i < count; i++) expect(all[i * chunk]).toBe(i % 251);
  });

  it("stops reading and cancels the body when the client closes", async () => {
    const cancelled = deferred<number>();
    const settled = deferred<string>();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const url = await serve(async (res) => {
        await sendWebResponse(
          res,
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(enc.encode("a"));
              },
              cancel() {
                cancelled.resolve(Date.now());
              },
            }),
          ),
        ).then(
          () => settled.resolve("resolved"),
          () => settled.resolve("rejected"),
        );
      });
      const { port } = new URL(url);
      const socket = connect(Number(port), "127.0.0.1");
      socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
      await new Promise((r) => socket.once("data", r));
      const destroyedAt = Date.now();
      socket.destroy();
      expect((await cancelled.promise) - destroyedAt).toBeLessThan(100);
      expect(await settled.promise).toBe("resolved");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("calls res.flush() after every chunk when a compression layer provides it", async () => {
    const flush = vi.fn();
    const release = deferred();
    const url = await serve(async (res) => {
      const pending: unknown[] = [];
      const write = res.write.bind(res) as (chunk: unknown) => boolean;
      res.write = ((value: unknown) => {
        pending.push(value);
        return true;
      }) as typeof res.write;
      Object.assign(res, {
        flush: () => {
          flush();
          for (const value of pending.splice(0)) write(value);
        },
      });
      await sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(enc.encode("1"));
              await release.promise;
              c.enqueue(enc.encode("2"));
              c.enqueue(enc.encode("3"));
              c.close();
            },
          }),
        ),
      );
    });
    const reader = (await fetch(url)).body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("1");
    release.resolve();
    while (!(await reader.read()).done);
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("sets x-accel-buffering: no", async () => {
    const url = await serve((res) =>
      sendWebResponse(res, new Response("ok", { status: 202 })),
    );
    const response = await fetch(url);
    expect(response.status).toBe(202);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await response.text()).toBe("ok");
  });

  it("writes headers but no body for HEAD", async () => {
    const cancel = vi.fn();
    const url = await serve((res, method) =>
      sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode("body"));
            },
            cancel,
          }),
          { headers: { "x-head": "1" } },
        ),
        { method },
      ),
    );
    const { port } = new URL(url);
    const text = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), "127.0.0.1");
      let out = "";
      socket.on("data", (b) => (out += b.toString()));
      socket.on("close", () => resolve(out));
      socket.write("HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    expect(text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(text).toMatch(/x-head: 1/);
    expect(text.endsWith("\r\n\r\n")).toBe(true);
    expect(text).not.toContain("body");
    expect(cancel).toHaveBeenCalled();
  });

  it("stops on options.signal", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const writesAfterAbort = vi.fn();
    const finished = deferred();
    const url = await serve(async (res) => {
      const write = res.write.bind(res) as (chunk: unknown) => boolean;
      res.write = ((value: unknown) => {
        if (controller.signal.aborted) writesAfterAbort();
        return write(value);
      }) as typeof res.write;
      await sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode("a"));
              controller.signal.addEventListener("abort", () =>
                setTimeout(() => {
                  try {
                    c.enqueue(enc.encode("late"));
                  } catch {
                    /* cancelled */
                  }
                }, 5),
              );
            },
            cancel,
          }),
        ),
        { signal: controller.signal },
      );
      finished.resolve();
    });
    const reader = (await fetch(url)).body!.getReader();
    await reader.read();
    controller.abort();
    await finished.promise;
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("");
    expect(cancel).toHaveBeenCalled();
    expect(writesAfterAbort).not.toHaveBeenCalled();
  });

  it("destroys the socket on a read error after headers", async () => {
    const settled = deferred<string>();
    const url = await serve(async (res) => {
      await sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(enc.encode("a"));
              await new Promise((r) => setTimeout(r, 10));
              c.error(new Error("source failed"));
            },
          }),
        ),
      ).then(
        () => settled.resolve("resolved"),
        () => settled.resolve("rejected"),
      );
    });
    const reader = (await fetch(url)).body!.getReader();
    await reader.read();
    await expect(
      (async () => {
        while (!(await reader.read()).done);
      })(),
    ).rejects.toThrow();
    expect(await settled.promise).toBe("resolved");
  });

  it("rejects on a read error before the first write", async () => {
    const settled = deferred<{ outcome: string; headersSent: boolean }>();
    const url = await serve(async (res) => {
      await sendWebResponse(
        res,
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("source failed"));
            },
          }),
        ),
      ).then(
        () => settled.resolve({ outcome: "resolved", headersSent: res.headersSent }),
        () => {
          settled.resolve({ outcome: "rejected", headersSent: res.headersSent });
          res.statusCode = 500;
          res.end("failed");
        },
      );
    });
    const response = await fetch(url);
    expect(await settled.promise).toEqual({
      outcome: "rejected",
      headersSent: false,
    });
    expect(response.status).toBe(500);
  });
});
