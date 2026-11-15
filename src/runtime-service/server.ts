import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { RuntimeServiceConfig } from "./config.js";

export interface RuntimeHttpOptions {
  config: RuntimeServiceConfig;
  handleChat: (request: Request) => Promise<Response>;
  isReady: () => Promise<boolean>;
  onEvent?: (event: {
    type: string;
    traceId: string;
    status: number;
    durationMs: number;
  }) => void;
}
/** Bounded Node/Web adapter. The operator's public origin is authoritative. */
export function createRuntimeHttpServer(options: RuntimeHttpOptions) {
  const { config } = options;
  const active = new Set<AbortController>();
  let draining = false;
  const server = createServer(async (incoming, outgoing) => {
    const started = Date.now();
    const traceId = randomUUID();
    const abort = new AbortController();
    const disconnect = () => {
      if (!outgoing.writableFinished) abort.abort();
    };
    incoming.on("aborted", () => abort.abort());
    outgoing.on("close", disconnect);
    outgoing.setHeader("x-request-id", traceId);
    outgoing.setHeader("cache-control", "no-store");
    outgoing.setHeader("x-content-type-options", "nosniff");
    const reply = (status: number, error: string) => {
      if (outgoing.destroyed) return;
      outgoing.statusCode = status;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error }));
    };
    let tracked = false;
    try {
      const pathname = incoming.url ?? "/";
      if (incoming.method === "GET" && pathname === "/healthz") {
        reply(200, "alive");
        return;
      }
      if (incoming.method === "GET" && pathname === "/readyz") {
        reply(!draining && (await options.isReady()) ? 200 : 503, "readiness");
        return;
      }
      if (incoming.method !== "POST" || pathname !== config.server.chatPath) {
        reply(404, "not_found");
        return;
      }
      if (draining || !(await options.isReady())) {
        reply(503, "runtime_not_ready");
        return;
      }
      if (active.size >= config.server.maxConcurrentTurns) {
        reply(429, "runtime_busy");
        return;
      }
      if (
        !(incoming.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        reply(415, "json_required");
        return;
      }
      const origin = incoming.headers.origin;
      const fetchSite = incoming.headers["sec-fetch-site"];
      if (
        (origin && origin !== new URL(config.server.publicOrigin).origin) ||
        (!origin &&
          fetchSite &&
          fetchSite !== "same-origin" &&
          fetchSite !== "none")
      ) {
        reply(403, "origin_denied");
        return;
      }
      active.add(abort);
      tracked = true;
      const chunks: Buffer[] = [];
      let size = 0;
      if (
        Number(incoming.headers["content-length"] ?? 0) >
        config.server.maxBodyBytes
      ) {
        reply(413, "body_too_large");
        return;
      }
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > config.server.maxBodyBytes) {
          reply(413, "body_too_large");
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (abort.signal.aborted) return;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (
          name === "host" ||
          name === "forwarded" ||
          name.startsWith("x-forwarded-") ||
          name === "connection" ||
          name === "transfer-encoding"
        )
          continue;
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(
        new URL(config.server.chatPath, config.server.publicOrigin),
        {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
          signal: abort.signal,
        },
      );
      const response = await options.handleChat(request);
      if (abort.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (
          !["connection", "transfer-encoding", "content-length"].includes(name)
        )
          outgoing.setHeader(name, value);
      });
      outgoing.setHeader("x-accel-buffering", "no");
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || abort.signal.aborted) break;
            if (!outgoing.write(value))
              await once(outgoing, "drain", { signal: abort.signal });
          }
        } finally {
          abort.signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      }
      if (!outgoing.destroyed) outgoing.end();
    } catch {
      if (!outgoing.headersSent)
        reply(abort.signal.aborted ? 499 : 500, "request_failed");
      else outgoing.destroy();
    } finally {
      if (tracked) active.delete(abort);
      try {
        options.onEvent?.({
          type: "request",
          traceId,
          status: outgoing.statusCode,
          durationMs: Date.now() - started,
        });
      } catch {
        /* logging cannot affect requests */
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5000;
  return {
    server,
    abortAll() {
      for (const abort of active) abort.abort();
    },
    async close() {
      draining = true;
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        for (const abort of active) abort.abort();
        server.closeAllConnections();
      }, config.server.drainTimeoutMs);
      timer.unref();
      await closed;
      clearTimeout(timer);
    },
  };
}
