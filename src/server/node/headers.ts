import type { IncomingHttpHeaders } from "node:http";
import type { NodeResponse } from "./types.js";

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
];
const SKIPPED_RESPONSE_HEADERS = [
  "connection",
  "transfer-encoding",
  "content-length",
  "keep-alive",
];

/** Internal. Converts node:http request headers into Web `Headers`. */
export function toWebHeaders(
  incoming: IncomingHttpHeaders,
  options: { drop: (name: string) => boolean; multiValue: "append" | "skip" },
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || options.drop(name)) continue;
    if (typeof value === "string") headers.set(name, value);
    else if (options.multiValue === "append")
      for (const item of value) headers.append(name, item);
  }
  return headers;
}

/** Internal: the generic bridge's drop rule (hop-by-hop always, forwarded unless trusted). */
export function genericRequestHeaderDrop(
  trustForwardedHeaders: boolean,
): (name: string) => boolean {
  return (name) =>
    HOP_BY_HOP.includes(name) ||
    (!trustForwardedHeaders &&
      (name === "forwarded" || name.startsWith("x-forwarded-")));
}

/** Internal: the container's drop rule, verbatim from server.ts. */
export function containerRequestHeaderDrop(name: string): boolean {
  return (
    name === "host" ||
    name === "forwarded" ||
    name.startsWith("x-forwarded-") ||
    name === "connection" ||
    name === "transfer-encoding"
  );
}

/** Internal. Copies status and headers onto res with setHeader (keeps headers earlier middleware set). */
export function writeResponseHeaders(
  res: NodeResponse,
  response: Response,
): void {
  res.statusCode = response.status;
  let cookiesWritten = false;
  response.headers.forEach((value, name) => {
    if (SKIPPED_RESPONSE_HEADERS.includes(name)) return;
    if (name === "set-cookie") {
      if (!cookiesWritten) res.setHeader(name, response.headers.getSetCookie());
      cookiesWritten = true;
      return;
    }
    res.setHeader(name, value);
  });
  res.setHeader("x-accel-buffering", "no");
}
