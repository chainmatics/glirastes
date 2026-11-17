import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createJsonSchemaLike } from '../../runtime/json-schema.js';
import {
  assertMaxResultChars,
  DEFAULT_MAX_RESULT_CHARS,
  isValidMaxResultChars,
  MAX_MAX_RESULT_CHARS,
  MIN_MAX_RESULT_CHARS,
} from '../../runtime/result-limit.js';
import { truncateToolResult, type TruncatedMarker } from './truncate-tool-result.js';
import * as core from './index.js';

const size = (value: unknown): number => JSON.stringify(value).length;
const marker = (value: unknown): TruncatedMarker => (value as { _truncated: TruncatedMarker })._truncated;

function entry(index: number, chars: number): Record<string, unknown> {
  return { id: `id-${index}`, name: `Playlist ${index}`, description: 'x'.repeat(chars) };
}

/** A small deterministic PRNG so the property test is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = next();
  if (depth <= 0 || pick < 0.3) {
    const kind = Math.floor(next() * 5);
    if (kind === 0) return Math.floor(next() * 1e6);
    if (kind === 1) return next() < 0.5;
    if (kind === 2) return null;
    return 'abc"\\\né'.repeat(Math.floor(next() * 600));
  }
  if (pick < 0.65) {
    return Array.from({ length: Math.floor(next() * (depth >= 4 ? 30 : 4)) }, () => randomValue(next, depth - 1));
  }
  const wide = next() < 0.1;
  return Object.fromEntries(Array.from({ length: Math.floor(next() * (wide ? 600 : 5)) }, (_, index) => (
    [next() < 0.05 ? `${'long-key-'.repeat(Math.floor(next() * 40))}${index}` : `k${index}`, randomValue(next, wide ? 0 : depth - 1)]
  )));
}

describe('maxResultChars bounds', () => {
  it('exports the bounds and validates them', () => {
    expect([DEFAULT_MAX_RESULT_CHARS, MIN_MAX_RESULT_CHARS, MAX_MAX_RESULT_CHARS]).toEqual([16_000, 1_000, 200_000]);
    expect(isValidMaxResultChars(1_000)).toBe(true);
    expect(isValidMaxResultChars(200_000)).toBe(true);
    for (const bad of [999, 200_001, 1_500.5, '2000', Number.NaN, null]) {
      expect(isValidMaxResultChars(bad)).toBe(false);
    }
    expect(() => assertMaxResultChars(undefined, 'x')).not.toThrow();
    expect(() => assertMaxResultChars(500, 'createAiChatHandler')).toThrow(
      'createAiChatHandler: maxResultChars must be an integer from 1000 to 200000',
    );
  });
});

describe('truncateToolResult', () => {
  it('is still exported from the server core, with the limit bounds', () => {
    expect(core.truncateToolResult).toBe(truncateToolResult);
    expect(core.DEFAULT_MAX_RESULT_CHARS).toBe(DEFAULT_MAX_RESULT_CHARS);
    expect(core.isValidMaxResultChars).toBe(isValidMaxResultChars);
  });

  it('never mutates its input and returns unserializable input as it is', () => {
    const result = { success: true, uiAction: { type: 'x' }, data: { items: Array.from({ length: 30 }, (_, index) => entry(index, 1_000)) } };
    const before = JSON.stringify(result);
    truncateToolResult(result, 2_000);
    expect(JSON.stringify(result)).toBe(before);
    const cyclic: Record<string, unknown> = { text: 'c'.repeat(5_000) };
    cyclic.self = cyclic;
    expect(truncateToolResult(cyclic, 1_000)).toBe(cyclic);
    const big = { id: 1n, text: 'b'.repeat(5_000) };
    expect(truncateToolResult(big, 1_000)).toBe(big);
  });

  it('leaves out fields whose key alone is too long, without naming them', () => {
    const longKey = 'x'.repeat(5_000);
    const cut = truncateToolResult({ [longKey]: 1, x: 2 }, 1_000) as Record<string, unknown>;
    expect(size(cut)).toBeLessThanOrEqual(1_000);
    expect(cut.x).toBe(2);
    expect(marker(cut).omittedKeys).toBe(1);
    expect(JSON.stringify(cut)).not.toContain('xxxxxxxxxx');
    const nested = truncateToolResult({ data: [{ id: 1, [longKey]: 'v' }], meta: { [longKey]: 1, ok: true } }, 1_000);
    expect(size(nested)).toBeLessThanOrEqual(1_000);
    expect(marker(nested).omittedKeys).toBe(2);
    expect(nested).toMatchObject({ data: [{ id: 1 }], meta: { ok: true } });
  });

  it('keeps a top-level __proto__ key as an own field and compacts it', () => {
    const parsed = JSON.parse(`{"__proto__":{"a":"${'x'.repeat(5_000)}"},"items":[1,2,3]}`) as Record<string, unknown>;
    const cut = truncateToolResult(parsed, 1_000) as Record<string, unknown>;
    expect(size(cut)).toBeLessThanOrEqual(1_000);
    expect(Object.getPrototypeOf(cut)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(cut, '__proto__')).toBe(true);
    const own = Object.getOwnPropertyDescriptor(cut, '__proto__')!.value as { a: string };
    expect(own.a.endsWith('…[clipped]')).toBe(true);
    expect(cut.items).toEqual([1, 2, 3]);
    expect(marker(cut).compacted).toEqual(['__proto__.a']);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it('bounds an 8 MB flat object and a nested object of 40k keys quickly', () => {
    const flat = Object.fromEntries(Array.from({ length: 40_000 }, (_, index) => [`k${index}`, 'y'.repeat(200)]));
    const nested = { a: Object.fromEntries(Array.from({ length: 40_000 }, (_, index) => [`k${index}`, { x: 'z'.repeat(150) }])) };
    const mixed = {
      data: Array.from({ length: 40_000 }, (_, index) => ({ id: index, t: 'z'.repeat(150) })),
      meta: Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`m${index}`, 'z'.repeat(150)])),
    };
    for (const value of [flat, nested, mixed]) {
      const started = performance.now();
      const cut = truncateToolResult(value, 16_000);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(size(cut)).toBeLessThanOrEqual(16_000);
    }
  }, 30_000);

  it('returns small results, primitives and failures unchanged (same reference)', () => {
    const small = { success: true, data: [entry(1, 10)] };
    expect(truncateToolResult(small)).toBe(small);
    expect(truncateToolResult('text')).toBe('text');
    expect(truncateToolResult(null)).toBe(null);
    const failure = { success: false, error: 'x'.repeat(50_000) };
    expect(truncateToolResult(failure, 1_000)).toBe(failure);
    const smallArray = [1, 2, 3];
    expect(truncateToolResult(smallArray)).toBe(smallArray);
  });

  it('keeps the (result, maxChars) call shape and the default limit', () => {
    const result = { data: Array.from({ length: 40 }, (_, index) => entry(index, 800)) };
    const cut = truncateToolResult(result);
    expect(size(cut)).toBeLessThanOrEqual(DEFAULT_MAX_RESULT_CHARS);
    expect(marker(cut)).toMatchObject({ field: 'data', total: 40 });
    const tighter = truncateToolResult(result, 5_000);
    expect(size(tighter)).toBeLessThanOrEqual(5_000);
  });

  it('cuts a nested array, keeps sibling fields and reports the dot path', () => {
    const result = {
      success: true,
      data: { items: Array.from({ length: 20 }, (_, index) => entry(index, 2_000)), page: 1 },
      meta: { total: 20, next: 'cursor-2' },
    };
    const cut = truncateToolResult(result, 16_000) as typeof result;
    expect(size(cut)).toBeLessThanOrEqual(16_000);
    expect(cut.meta).toEqual(result.meta);
    expect(cut.data.page).toBe(1);
    expect(cut.data.items.length).toBeGreaterThan(5);
    expect(cut.data.items).toEqual(result.data.items.slice(0, cut.data.items.length));
    expect(marker(cut)).toMatchObject({ field: 'data.items', showing: cut.data.items.length, total: 20 });
  });

  it('keeps meta next to a top-level data array', () => {
    const result = { data: Array.from({ length: 30 }, (_, index) => entry(index, 1_000)), meta: { count: 30 } };
    const cut = truncateToolResult(result, 8_000) as typeof result;
    expect(cut.meta).toEqual({ count: 30 });
    expect(marker(cut).field).toBe('data');
    expect(size(cut)).toBeLessThanOrEqual(8_000);
  });

  it('chooses the array by serialized size, not by element count', () => {
    const result = {
      tags: Array.from({ length: 200 }, (_, index) => index),
      items: Array.from({ length: 10 }, (_, index) => entry(index, 3_000)),
    };
    const cut = truncateToolResult(result, 10_000) as typeof result;
    expect(marker(cut).field).toBe('items');
    expect(cut.tags).toHaveLength(200);
  });

  it('compacts a single entry larger than the limit instead of exceeding it', () => {
    const result = {
      data: [{ id: 'a', title: 'First', body: 'y'.repeat(30_000), nested: { deep: 'z'.repeat(5_000) } }, entry(2, 10)],
    };
    const cut = truncateToolResult(result, 4_000) as { data: Array<Record<string, unknown>> };
    expect(size(cut)).toBeLessThanOrEqual(4_000);
    expect(cut.data).toHaveLength(1);
    expect(cut.data[0]!.id).toBe('a');
    expect(cut.data[0]!.title).toBe('First');
    expect(marker(cut)).toMatchObject({ field: 'data', showing: 1, total: 2 });
    expect(marker(cut).compacted).toEqual(expect.arrayContaining(['data.0.body']));
  });

  it('keeps zero entries when even a compacted entry cannot fit', () => {
    const wide = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`f${index}`, index]));
    const result = { data: [wide, wide] };
    const cut = truncateToolResult(result, 1_000) as { data: unknown[] };
    expect(size(cut)).toBeLessThanOrEqual(1_000);
    expect(cut.data).toEqual([]);
    expect(marker(cut)).toMatchObject({ field: 'data', showing: 0, total: 2 });
  });

  it('clips long strings of an oversized result without arrays and names them', () => {
    const result = { id: 'doc-1', title: 'Report', body: 'b'.repeat(40_000), summary: 's'.repeat(3_000) };
    const cut = truncateToolResult(result, 10_000) as Record<string, string>;
    expect(size(cut)).toBeLessThanOrEqual(10_000);
    expect(cut.id).toBe('doc-1');
    expect(cut.title).toBe('Report');
    expect(cut.summary).toBe(result.summary);
    expect(cut.body.startsWith('bbbb')).toBe(true);
    expect(cut.body.endsWith('…[clipped]')).toBe(true);
    expect(marker(cut).compacted).toEqual(['body']);
    expect(marker(cut).field).toBeUndefined();
    expect(marker(cut).hint).toContain('do not call it again');
    const read = truncateToolResult(result, 10_000, { readOnly: true });
    expect(marker(read).hint).toContain('incomplete');
  });

  it('replaces the largest fields by placeholders when clipping one string is not enough', () => {
    const result = {
      a: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`k${index}`, index])),
      b: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`k${index}`, index])),
      keep: 'small',
    };
    const cut = truncateToolResult(result, 3_000) as Record<string, unknown>;
    expect(size(cut)).toBeLessThanOrEqual(3_000);
    expect(cut.keep).toBe('small');
    expect(cut.a).toBe('[omitted: object with 300 keys]');
  });

  it('wraps a root array that has to be cut under data', () => {
    const result = Array.from({ length: 50 }, (_, index) => entry(index, 500));
    const cut = truncateToolResult(result, 5_000) as { data: unknown[] };
    expect(Array.isArray(cut)).toBe(false);
    expect(size(cut)).toBeLessThanOrEqual(5_000);
    expect(cut.data).toEqual(result.slice(0, cut.data.length));
    expect(marker(cut)).toMatchObject({ field: 'data', total: 50 });
  });

  it('writes a hint with showing N of M and the tool\'s paging parameters', () => {
    const result = { data: Array.from({ length: 20 }, (_, index) => entry(index, 2_000)) };
    const zodInput = z.object({ query: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() });
    const cut = truncateToolResult(result, 16_000, { inputSchema: zodInput, readOnly: true });
    const { showing, total, hint } = marker(cut);
    expect(hint).toContain(`showing ${showing} of ${total}`);
    expect(hint).toContain('filter');
    expect(hint).toContain('next page with the parameters limit, offset');
    expect(hint).not.toContain('query');

    const jsonInput = createJsonSchemaLike({
      type: 'object',
      properties: { cursor: { type: 'string' }, per_page: { type: 'integer' }, name: { type: 'string' } },
    });
    expect(marker(truncateToolResult(result, 16_000, { inputSchema: jsonInput, readOnly: true })).hint)
      .toContain('parameters cursor, per_page');

    const plain = marker(truncateToolResult(result, 16_000, { readOnly: true })).hint;
    expect(plain).toContain('fetch the rest in pages');
    expect(marker(truncateToolResult(result, 16_000, { paginationParams: ['page'], readOnly: true })).hint)
      .toContain('parameters page');
  });

  it('never invites a write tool, or a tool of unknown kind, to be called again', () => {
    const result = { data: Array.from({ length: 20 }, (_, index) => entry(index, 2_000)) };
    const creditInput = z.object({ name: z.string(), limit: z.number() });
    for (const options of [{ inputSchema: creditInput, readOnly: false }, { inputSchema: creditInput }, undefined]) {
      const { showing, total, hint } = marker(truncateToolResult(result, 16_000, options));
      expect(hint).toContain('do not call it again just to see more');
      expect(hint).toContain(`result was shortened (showing ${showing} of ${total})`);
      expect(hint).not.toContain('next page');
      expect(hint).not.toContain('parameters');
      expect(hint).not.toContain('filter');
    }
    const noArray = marker(truncateToolResult({ text: 't'.repeat(5_000) }, 1_000, { readOnly: false })).hint;
    expect(noArray).toContain('do not call it again just to see more');
    expect(noArray).toContain('Tell the user the result was shortened.');
  });

  it('never alters or removes success and uiAction', () => {
    const uiAction = { type: 'navigate', payload: { href: '/playlists' } };
    const result = { success: true, uiAction, data: Array.from({ length: 30 }, (_, index) => entry(index, 1_000)) };
    const cut = truncateToolResult(result, 2_000) as Record<string, unknown>;
    expect(cut.success).toBe(true);
    expect(cut.uiAction).toBe(uiAction);
    expect(size(cut)).toBeLessThanOrEqual(2_000);

    const noArray = { success: true, uiAction, text: 't'.repeat(10_000) };
    const clipped = truncateToolResult(noArray, 1_000) as Record<string, unknown>;
    expect(clipped.uiAction).toBe(uiAction);
    expect(clipped.success).toBe(true);
    expect(size(clipped)).toBeLessThanOrEqual(1_000);
  });

  it('keeps an oversized uiAction even if that exceeds the limit (documented exception)', () => {
    const uiAction = { type: 'show', payload: 'u'.repeat(5_000) };
    const cut = truncateToolResult({ success: true, uiAction, data: ['x'.repeat(100)] }, 1_000) as Record<string, unknown>;
    expect(cut.uiAction).toBe(uiAction);
    expect(cut.success).toBe(true);
    expect(cut.data).toBeUndefined();
  });

  it('is deterministic', () => {
    const result = {
      data: { items: Array.from({ length: 25 }, (_, index) => entry(index, 1_700)) },
      text: 'q'.repeat(9_000),
    };
    expect(JSON.stringify(truncateToolResult(result, 7_000))).toBe(JSON.stringify(truncateToolResult(result, 7_000)));
  });

  it('holds the upper bound for varied shapes (property test)', () => {
    const limits = [1_000, 1_500, 4_000, 16_000];
    let checked = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const value = randomValue(next, 4);
      const result = Array.isArray(value) || (value !== null && typeof value === 'object')
        ? (next() < 0.5 ? { success: true, data: value } : value)
        : { data: value };
      for (const limit of limits) {
        const cut = truncateToolResult(result, limit);
        expect(size(cut), `seed ${seed}, limit ${limit}`).toBeLessThanOrEqual(limit);
        if (size(result) > limit) {
          expect(marker(cut).hint.length).toBeGreaterThan(0);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  }, 30_000);
});
