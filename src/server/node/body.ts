import { DEFAULT_MAX_BODY_BYTES } from "../body-limit.js";
import type { NodeRequest } from "./types.js";

/** Internal default; equals the chat handler's own `maxBodyBytes` default. */
export const DEFAULT_NODE_MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

/** The request body is larger than the configured `maxBodyBytes`. */
export class RequestBodyTooLargeError extends Error {
  readonly status = 413 as const;
  readonly code = "body_too_large" as const;
  constructor(readonly maxBodyBytes: number) {
    super("Request body exceeds maxBodyBytes");
    this.name = "RequestBodyTooLargeError";
  }
}

/** Internal. A limit that is not a positive safe integer (NaN, Infinity, 0, a fraction) would read without bound: refused. */
export function assertMaxBodyBytes(value: number): void {
  if (!(Number.isSafeInteger(value) && value > 0))
    throw new RangeError("maxBodyBytes must be a positive safe integer");
}

function bounded(bytes: Uint8Array, maxBodyBytes: number): Uint8Array {
  if (bytes.byteLength > maxBodyBytes)
    throw new RequestBodyTooLargeError(maxBodyBytes);
  return bytes;
}

/**
 * Internal. Reads the request body incrementally and stops at the first byte
 * over the limit. An already consumed stream falls back to `req.rawBody`, then
 * `req.body` (re-serialized as JSON when it is neither bytes nor a string).
 */
export async function readNodeBody(
  req: NodeRequest,
  options: { maxBodyBytes: number },
): Promise<{ bytes: Uint8Array; reparsed: boolean }> {
  const { maxBodyBytes } = options;
  assertMaxBodyBytes(maxBodyBytes);
  if (!req.readableEnded && req.readable) {
    if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes)
      throw new RequestBodyTooLargeError(maxBodyBytes);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Uint8Array).length;
      if (size > maxBodyBytes) throw new RequestBodyTooLargeError(maxBodyBytes);
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return { bytes: Buffer.concat(chunks), reparsed: false };
  }
  const raw = req.rawBody;
  if (raw instanceof Uint8Array)
    return { bytes: bounded(raw, maxBodyBytes), reparsed: false };
  if (typeof raw === "string")
    return { bytes: bounded(Buffer.from(raw, "utf8"), maxBodyBytes), reparsed: false };
  const body = req.body;
  if (body instanceof Uint8Array)
    return { bytes: bounded(body, maxBodyBytes), reparsed: false };
  if (typeof body === "string")
    return { bytes: bounded(Buffer.from(body, "utf8"), maxBodyBytes), reparsed: false };
  if (body === undefined) return { bytes: new Uint8Array(0), reparsed: false };
  const json = JSON.stringify(body) ?? "";
  return { bytes: bounded(Buffer.from(json, "utf8"), maxBodyBytes), reparsed: true };
}
