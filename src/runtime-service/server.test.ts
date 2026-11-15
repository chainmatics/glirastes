import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeHttpServer } from "./server.js";
import { parseRuntimeConfig } from "./config.js";
const config = parseRuntimeConfig({
  schemaVersion: 1,
  server: { publicOrigin: "http://app.test", drainTimeoutMs: 100 },
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
  const address = host.server.address() as { port: number };
  return { host, url: `http://127.0.0.1:${address.port}` };
}
describe("runtime HTTP host", () => {
  it("pins Request origin and removes proxy spoofing", async () => {
    let seen: Request | undefined;
    const { url } = await start(async (r) => {
      seen = r;
      return Response.json({ ok: true });
    });
    const response = await fetch(url + "/glirastes/chat", {
      method: "POST",
      headers: {
        host: "evil.test",
        "x-forwarded-host": "evil.test",
        origin: "http://app.test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(seen?.url).toBe("http://app.test/glirastes/chat");
    expect(seen?.headers.has("x-forwarded-host")).toBe(false);
  });
  it("rejects untrusted browser origins before handler", async () => {
    let calls = 0;
    const { url } = await start(async () => {
      calls++;
      return new Response();
    });
    expect(
      (
        await fetch(url + "/glirastes/chat", {
          method: "POST",
          headers: {
            origin: "https://evil.test",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(calls).toBe(0);
  });
  it("has separate liveness/readiness and fails closed", async () => {
    const { url } = await start(async () => new Response(), false);
    expect((await fetch(url + "/healthz")).status).toBe(200);
    expect((await fetch(url + "/readyz")).status).toBe(503);
    expect(
      (
        await fetch(url + "/glirastes/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
  });
  it("bounds body and rejects non-JSON content", async () => {
    const { url } = await start(async () => new Response());
    expect(
      (await fetch(url + "/glirastes/chat", { method: "POST", body: "{}" }))
        .status,
    ).toBe(415);
    expect(
      (
        await fetch(url + "/glirastes/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(config.server.maxBodyBytes + 1),
        })
      ).status,
    ).toBe(413);
  });
  it("aborts a handler when the client disconnects", async () => {
    let aborted!: () => void;
    const didAbort = new Promise<void>((r) => (aborted = r));
    let started!: () => void;
    const didStart = new Promise<void>((r) => (started = r));
    const { url } = await start(async (r) => {
      started();
      r.signal.addEventListener("abort", aborted, { once: true });
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
    const response = await fetch(url + "/glirastes/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    await didStart;
    await response.body?.getReader().read();
    controller.abort();
    await didAbort;
  });
});
