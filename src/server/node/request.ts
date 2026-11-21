import type { TLSSocket } from "node:tls";
import { DEFAULT_NODE_MAX_BODY_BYTES, readNodeBody } from "./body.js";
import { genericRequestHeaderDrop, toWebHeaders } from "./headers.js";
import type { NodeRequest } from "./types.js";

export interface ToWebRequestOptions {
  /** Origin of the Request URL, which is the address the default endpoint caller calls. Default: this connection's own local address and port (`http`, or `https` on a TLS socket). Must be an http(s) origin without path. */
  origin?: string;
  /** Default 1_000_000 (the chat handler's own default). Keep it ≥ the handler's `maxBodyBytes`. */
  maxBodyBytes?: number;
  /** Keep `forwarded` / `x-forwarded-*` headers (default false: dropped). Only behind a proxy that always sets them. */
  trustForwardedHeaders?: boolean;
  /** Aborts the Request (default: none; createNodeHandler passes the client-disconnect signal). */
  signal?: AbortSignal;
}

const ORIGIN_ERROR = "origin must be an http(s) origin without a path";

/** Internal. Validates an `origin` option and returns its normalized form. */
export function validateOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError(ORIGIN_ERROR);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new TypeError(ORIGIN_ERROR);
  return url.origin;
}

/** Internal. `http(s)://<local address>:<local port>` of this connection, IPv6 bracketed. */
export function ownOrigin(req: NodeRequest): string {
  const socket = req.socket as Partial<TLSSocket> | undefined;
  const address = socket?.localAddress;
  const port = socket?.localPort;
  if (typeof address !== "string" || address === "" || typeof port !== "number")
    throw new TypeError("Cannot derive the server origin; pass origin");
  const host = address.includes(":") ? `[${address}]` : address;
  return `${socket?.encrypted ? "https" : "http"}://${host}:${port}`;
}

/** Path plus query on a fixed origin; a target that is not origin-form falls back to `/`. */
function requestUrl(target: string, origin: string): URL {
  if (target.startsWith("/")) {
    try {
      const url = new URL(origin + target);
      if (url.origin === origin) return url;
    } catch {
      /* fall back to the root path */
    }
  }
  return new URL("/", origin);
}

/**
 * Builds a Web `Request` from a node:http request. The URL comes from a fixed
 * origin (the option, or the socket's own address), never from `Host`.
 */
export async function toWebRequest(
  req: NodeRequest,
  options: ToWebRequestOptions = {},
): Promise<Request> {
  const origin =
    options.origin === undefined
      ? new URL(ownOrigin(req)).origin
      : validateOrigin(options.origin);
  const url = requestUrl(req.originalUrl ?? req.url ?? "/", origin);
  const method = (req.method ?? "GET").toUpperCase();
  const headers = toWebHeaders(req.headers, {
    drop: genericRequestHeaderDrop(options.trustForwardedHeaders === true),
    multiValue: "append",
  });
  let body: Uint8Array | undefined;
  if (method === "GET" || method === "HEAD") {
    headers.delete("content-length");
  } else {
    const read = await readNodeBody(req, {
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_NODE_MAX_BODY_BYTES,
    });
    if (read.reparsed) headers.delete("content-encoding");
    headers.set("content-length", String(read.bytes.byteLength));
    body = read.bytes;
  }
  return new Request(url, {
    method,
    headers,
    body: body as BodyInit | undefined,
    signal: options.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
