import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  containerRequestHeaderDrop,
  genericRequestHeaderDrop,
  toWebHeaders,
  writeResponseHeaders,
} from "./headers.js";

const names = (headers: Headers) => [...headers.keys()].sort();
const response = () => new ServerResponse(new IncomingMessage(new Socket()));

describe("toWebHeaders", () => {
  it("appends multi-value headers", () => {
    const keep = () => false;
    const appended = toWebHeaders(
      { "set-cookie": ["a=1", "b=2"] },
      { drop: keep, multiValue: "append" },
    );
    expect(appended.getSetCookie()).toEqual(["a=1", "b=2"]);
    const skipped = toWebHeaders(
      { "set-cookie": ["a=1", "b=2"], "x-one": "1" },
      { drop: keep, multiValue: "skip" },
    );
    expect(skipped.has("set-cookie")).toBe(false);
    expect(skipped.get("x-one")).toBe("1");
  });

  it("generic rule drops hop-by-hop and forwarded headers, keeps host", () => {
    const incoming = {
      host: "app.test",
      "x-forwarded-host": "evil.test",
      forwarded: "host=evil.test",
      connection: "keep-alive",
      te: "trailers",
      "x-custom": "1",
    };
    expect(
      names(
        toWebHeaders(incoming, {
          drop: genericRequestHeaderDrop(false),
          multiValue: "append",
        }),
      ),
    ).toEqual(["host", "x-custom"]);
    expect(
      names(
        toWebHeaders(incoming, {
          drop: genericRequestHeaderDrop(true),
          multiValue: "append",
        }),
      ),
    ).toEqual(["forwarded", "host", "x-custom", "x-forwarded-host"]);
  });

  it("container rule equals the old server.ts predicate", () => {
    // Oracle: the inline predicate server.ts used before the bridge extraction.
    const oracle = (name: string) =>
      name === "host" ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name === "connection" ||
      name === "transfer-encoding";
    const table = [
      "host",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "connection",
      "transfer-encoding",
      "te",
      "keep-alive",
      "content-type",
      "authorization",
    ];
    for (const name of table)
      expect(containerRequestHeaderDrop(name), name).toBe(oracle(name));
  });
});

describe("writeResponseHeaders", () => {
  it("writes every Set-Cookie", () => {
    const res = response();
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    writeResponseHeaders(res, new Response(null, { headers }));
    expect(res.getHeader("set-cookie")).toEqual(["a=1", "b=2"]);
  });

  it("keeps headers set before, overrides on conflict", () => {
    const res = response();
    res.setHeader("x-request-id", "r");
    res.setHeader("cache-control", "no-store");
    writeResponseHeaders(
      res,
      new Response(null, {
        status: 201,
        headers: { "content-type": "text/plain", "cache-control": "private" },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.getHeader("x-request-id")).toBe("r");
    expect(res.getHeader("content-type")).toBe("text/plain");
    expect(res.getHeader("cache-control")).toBe("private");
  });

  it("drops content-length and hop-by-hop, adds x-accel-buffering: no", () => {
    const res = response();
    writeResponseHeaders(
      res,
      new Response(null, {
        headers: {
          "content-length": "5",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "x-keep": "1",
        },
      }),
    );
    expect(Object.keys(res.getHeaders()).sort()).toEqual([
      "x-accel-buffering",
      "x-keep",
    ]);
    expect(res.getHeader("x-accel-buffering")).toBe("no");
  });
});
