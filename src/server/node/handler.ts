import { assertMaxBodyBytes, RequestBodyTooLargeError } from "./body.js";
import { toWebRequest, validateOrigin, type ToWebRequestOptions } from "./request.js";
import { sendWebResponse } from "./response.js";
import type { NodeHandler, NodeResponse, WebHandler } from "./types.js";

export interface NodeHandlerOptions extends Omit<ToWebRequestOptions, "signal"> {}

function reply(res: NodeResponse, status: number, error: string): void {
  if (res.destroyed || res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error }));
}

/**
 * Wraps a Web handler (`createAiChatHandler`) as a `(req, res)` handler for
 * node:http-style servers: bounded body read, streamed response with
 * backpressure, abort on client disconnect. The returned promise never rejects.
 */
export function createNodeHandler(
  handler: WebHandler,
  options: NodeHandlerOptions = {},
): NodeHandler {
  if (options.origin !== undefined) validateOrigin(options.origin);
  if (options.maxBodyBytes !== undefined) assertMaxBodyBytes(options.maxBodyBytes);
  return async (req, res) => {
    const abort = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) abort.abort();
    };
    const onAborted = () => abort.abort();
    req.on("aborted", onAborted);
    res.on("close", disconnect);
    try {
      const request = await toWebRequest(req, { ...options, signal: abort.signal });
      const response = await handler(request);
      if (abort.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      await sendWebResponse(res, response, { signal: abort.signal, method: req.method });
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (error instanceof RequestBodyTooLargeError)
        reply(res, 413, "body_too_large");
      else reply(res, abort.signal.aborted ? 499 : 500, "request_failed");
    } finally {
      req.off("aborted", onAborted);
      res.off("close", disconnect);
    }
  };
}
