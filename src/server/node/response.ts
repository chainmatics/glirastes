import { once } from "node:events";
import { writeResponseHeaders } from "./headers.js";
import type { NodeResponse } from "./types.js";

export interface SendWebResponseOptions {
  /** Stops streaming and cancels the body when aborted (in addition to the response's own `close`). */
  signal?: AbortSignal;
  /** Request method; `HEAD` writes status and headers only. Default: `res.req?.method`. */
  method?: string;
}

/**
 * Writes a Web `Response` to a node:http `ServerResponse`: status and headers,
 * then the body chunk by chunk with backpressure. Stops and cancels the body
 * when the client leaves or `signal` aborts. A read error after the headers
 * were sent destroys the socket and resolves; a read error before the first
 * write rejects so the caller can still answer 500.
 */
export async function sendWebResponse(
  res: NodeResponse,
  response: Response,
  options: SendWebResponseOptions = {},
): Promise<void> {
  const body = response.body;
  if (res.destroyed) {
    await body?.cancel().catch(() => {});
    return;
  }
  res.statusCode = response.status;
  writeResponseHeaders(res, response);
  const method = (options.method ?? res.req?.method ?? "").toUpperCase();
  if (method === "HEAD" || !body) {
    if (body) await body.cancel().catch(() => {});
    res.end();
    return;
  }
  const reader = body.getReader();
  const stop = new AbortController();
  const halt = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    void reader.cancel().catch(() => {});
  };
  const onClose = () => {
    if (!res.writableFinished) halt();
  };
  const { signal } = options;
  if (signal?.aborted) halt();
  else signal?.addEventListener("abort", halt, { once: true });
  res.on("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stop.signal.aborted) break;
      if (!res.write(value)) await once(res, "drain", { signal: stop.signal });
      (res as { flush?: () => void }).flush?.();
    }
  } catch (error) {
    if (!res.headersSent) throw error;
    res.destroy();
  } finally {
    signal?.removeEventListener("abort", halt);
    res.off("close", onClose);
    reader.releaseLock();
  }
  if (!res.destroyed) res.end();
}
