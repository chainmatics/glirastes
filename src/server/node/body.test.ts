import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readNodeBody, RequestBodyTooLargeError } from "./body.js";
import type { NodeRequest } from "./types.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function request(
  source: Iterable<unknown> | AsyncIterable<unknown>,
  extra: Record<string, unknown> = {},
  highWaterMark?: number,
): NodeRequest {
  const readable = Readable.from(
    source as Iterable<unknown>,
    highWaterMark === undefined ? {} : { highWaterMark },
  );
  return Object.assign(readable, {
    headers: {},
    ...extra,
  }) as unknown as NodeRequest;
}

async function drained(extra: Record<string, unknown> = {}) {
  const req = request([Buffer.from("ignored")], extra);
  for await (const _chunk of req) void _chunk;
  return req;
}

describe("readNodeBody", () => {
  it("refuses a maxBodyBytes that is not a positive safe integer", async () => {
    await expect(
      readNodeBody(request([Buffer.from("x".repeat(100))]), { maxBodyBytes: Number.NaN }),
    ).rejects.toThrow(new RangeError("maxBodyBytes must be a positive safe integer"));
  });

  it("reads a streamed body in chunks", async () => {
    const req = request([Buffer.from("ab"), Buffer.from("cd"), Buffer.from("e")]);
    const out = await readNodeBody(req, { maxBodyBytes: 100 });
    expect(text(out.bytes)).toBe("abcde");
    expect(out.reparsed).toBe(false);
  });

  it("refuses by content-length before reading", async () => {
    const req = request([Buffer.from("x")]);
    req.headers["content-length"] = "11";
    const read = vi.spyOn(req as unknown as Readable, "_read");
    const error = await readNodeBody(req, { maxBodyBytes: 10 }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
    expect(error.status).toBe(413);
    expect(error.code).toBe("body_too_large");
    expect(error.maxBodyBytes).toBe(10);
    expect(error.message).toBe("Request body exceeds maxBodyBytes");
    expect(read).not.toHaveBeenCalled();
  });

  it("stops at the first chunk over the limit", async () => {
    let third = false;
    async function* source() {
      yield Buffer.alloc(6);
      yield Buffer.alloc(6);
      third = true;
      yield Buffer.alloc(6);
    }
    // highWaterMark 0: the stream pulls only what the reader asks for.
    const req = request(source(), {}, 0);
    await expect(readNodeBody(req, { maxBodyBytes: 10 })).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
  });

  it("uses req.rawBody / req.body when the stream was already consumed", async () => {
    const raw = await readNodeBody(
      await drained({ rawBody: Buffer.from('{"a":1}'), body: { other: true } }),
      { maxBodyBytes: 100 },
    );
    expect(text(raw.bytes)).toBe('{"a":1}');
    expect(raw.reparsed).toBe(false);

    const parsed = await readNodeBody(await drained({ body: { a: 1 } }), {
      maxBodyBytes: 100,
    });
    expect(text(parsed.bytes)).toBe('{"a":1}');
    expect(parsed.reparsed).toBe(true);

    const string = await readNodeBody(await drained({ body: '{"a":1}' }), {
      maxBodyBytes: 100,
    });
    expect(text(string.bytes)).toBe('{"a":1}');
    expect(string.reparsed).toBe(false);

    const empty = await readNodeBody(await drained(), { maxBodyBytes: 100 });
    expect(empty.bytes.byteLength).toBe(0);
    expect(empty.reparsed).toBe(false);
  });

  it("prefers an unconsumed stream over req.body", async () => {
    const req = request([Buffer.from('{"s":1}')], { body: {} });
    const out = await readNodeBody(req, { maxBodyBytes: 100 });
    expect(text(out.bytes)).toBe('{"s":1}');
    expect(out.reparsed).toBe(false);
  });

  it("applies the limit to a pre-parsed body", async () => {
    // {"a":"1234"} is 12 bytes; {"a":"123"} is 11.
    await expect(
      readNodeBody(await drained({ body: { a: "123" } }), { maxBodyBytes: 10 }),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    await expect(
      readNodeBody(await drained({ rawBody: Buffer.alloc(11) }), {
        maxBodyBytes: 10,
      }),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
