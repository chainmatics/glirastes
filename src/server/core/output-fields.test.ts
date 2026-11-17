import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool, defineTool, type PiiDetector, type PiiEntity, type Tool, type ToolContext } from '../../types.js';
import { createPiiShield } from '../pii-shield/create-pii-shield.js';
import { endpointToolToTool, toolToAiTool, type InternalApiResponse } from './index.js';
import {
  anyDepthKeys,
  applyOutputBound,
  intersectOutputFields,
  isValidOutputFields,
  leftOutFields,
  MAX_ANY_DEPTH,
  normalizeOutputFields,
  outputBoundOf,
  outputFieldTree,
  parseAnyDepthKey,
  parseOutputFieldPath,
} from './output-fields.js';
import { createReadResultTool } from './read-result-tool.js';
import { buildResultOverview, type ResultOverviewMarker } from './result-overview.js';
import { createResultStore, type ResultStore } from './result-store.js';
import { zodToCompactDescription } from './zod-compact.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Overview = Record<string, unknown> & { _result: ResultOverviewMarker };
const ctx = { currentDate: new Date('2026-11-17'), locale: 'en-US' } as ToolContext;

/** A tool returning `value`; `method` decides read or write. */
function toolOf(value: unknown, fields: Partial<Pick<Tool, 'outputAllowedFields' | 'outputDeniedFields' | 'outputDefaultFields' | 'method'>> = {}): Tool {
  return defineTool({
    id: 'items.list', description: 'Items.', inputSchema: z.object({}).strict(), method: 'GET',
    ...fields,
    execute: async () => JSON.parse(JSON.stringify(value)) as unknown,
  });
}

async function first(tool: Tool, store?: ResultStore, maxResultChars?: number): Promise<Record<string, unknown>> {
  return await toolToAiTool(tool, ctx, 'items_list', {
    ...(store ? { resultStore: store } : {}),
    ...(maxResultChars !== undefined ? { maxResultChars } : {}),
  }).execute({}) as Record<string, unknown>;
}

async function read(store: ResultStore, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await toolToAiTool(createReadResultTool(store), ctx, 'read_result', { resultStore: store }).execute(input) as Record<string, unknown>;
}

/** 20 entries with a large field each: over the default limit. */
const paginated = (count = 20, pad = 900) => ({
  data: Array.from({ length: count }, (_, index) => ({
    id: `d${index}`, name: `Design ${index}`, status: index % 2 ? 'draft' : 'live',
    owner: { name: `Owner ${index}`, email: `owner${index}@corp.example` },
    notes: 'n'.repeat(pad),
  })),
  meta: { page: 1, total: count },
});

describe('declaration grammar', () => {
  it('accepts paths of the read_result grammar without an index, normalized', () => {
    expect(normalizeOutputFields(['meta', 'data[].name', 'data[].owner.name', 'meta'])).toEqual(['data[].name', 'data[].owner.name', 'meta']);
    expect(normalizeOutputFields([])).toEqual([]);
    expect(parseOutputFieldPath('matrix[][]')).toEqual([{ kind: 'key', key: 'matrix' }, { kind: 'each' }, { kind: 'each' }]);
  });

  it.each([
    ['not an array', 'data'],
    ['an index', ['data[2].name']],
    ['a root array', ['[].name']],
    ['an empty path', ['']],
    ['a non-string', [3]],
    ['an unparsable path', ['data..name']],
    ['a too long path', ['x'.repeat(201)]],
    ['too many paths', Array.from({ length: 201 }, (_, index) => `f${index}`)],
    ['the any-depth form', ['**.fileUrl']],
    ['a ** segment', ['data.**.x']],
  ])('rejects %s', (_label, value) => {
    expect(normalizeOutputFields(value)).toBeUndefined();
    expect(isValidOutputFields(value, 'outputDefaultFields')).toBe(false);
  });

  it('accepts **.<key> only in outputDeniedFields, with exactly one key after it', () => {
    expect(parseAnyDepthKey('**.fileUrl')).toBe('fileUrl');
    for (const bad of ['**', '**.a.b', '**.a[]', '**.**', 'a.**.b', '*.fileUrl', '**.']) expect(parseAnyDepthKey(bad)).toBeUndefined();
    expect(normalizeOutputFields(['**.fileUrl', 'data[].x'], 'outputDeniedFields')).toEqual(['**.fileUrl', 'data[].x']);
    expect(normalizeOutputFields(['**.a.b'], 'outputDeniedFields')).toBeUndefined();
    expect(normalizeOutputFields(['**.fileUrl'], 'outputAllowedFields')).toBeUndefined();
    expect(anyDepthKeys(['**.fileUrl', 'data[].x', '**.thumbnailUrl'])).toEqual(new Set(['fileUrl', 'thumbnailUrl']));
  });

  it('intersects a default view with an allow-list as subtrees', () => {
    expect(intersectOutputFields(['data[].owner.name', 'data', 'meta', 'x'], ['data[].owner', 'data[].name'])).toEqual(
      ['data[].name', 'data[].owner', 'data[].owner.name'],
    );
  });

  it('throws at creation for an invalid declaration, without repeating it', () => {
    for (const name of ['outputAllowedFields', 'outputDeniedFields', 'outputDefaultFields'] as const) {
      expect(() => toolOf({}, { [name]: ['data[0].SECRET_VALUE'] })).toThrow(`defineTool(items.list): ${name} must be a list`);
      try {
        toolOf({}, { [name]: ['data[0].SECRET_VALUE'] });
      } catch (error) {
        expect((error as Error).message).not.toContain('SECRET_VALUE');
      }
      expect(() => endpointToolToTool(defineEndpointTool({
        id: 'x.get', toolName: 'x_get', description: 'X.', method: 'GET', path: '/x', inputSchema: z.object({}),
        [name]: 'data',
      }))).toThrow(`endpointToolToTool(x.get): ${name} must be a list`);
    }
    expect(() => toolOf({}, { outputAllowedFields: ['**.fileUrl'] })).toThrow('no "**"');
  });
});

describe('the upper bound on a result', () => {
  it('keeps allowed subtrees, positions and counts; drops everything else as if it did not exist', () => {
    const tree = outputFieldTree(['data[].name', 'data[].owner.name', 'meta']);
    const value = {
      success: true, uiAction: { type: 'x', secret: 1 },
      data: [{ name: 'a', secret: 1, owner: { name: 'o', email: 'e' } }, 5, { other: 1 }, { owner: 'scalar' }],
      meta: { page: 1 }, hidden: { x: 1 },
    };
    expect(applyOutputBound(value, { allowed: tree })).toEqual({
      success: true, uiAction: { type: 'x', secret: 1 },
      data: [{ name: 'a', owner: { name: 'o' } }, {}, {}, {}],
      meta: { page: 1 },
    });
  });

  it('removes denied paths through arrays, also below an allowed parent, and any-depth keys at every level', () => {
    const value = {
      fileUrl: 'top',
      data: [{ id: 1, draftVersion: { fileUrl: 'a', variants: [{ size: 1, fileUrl: 'b' }] }, items: [[{ fileUrl: 'c', ok: 1 }]] }],
    };
    expect(applyOutputBound(value, outputBoundOf({ outputAllowedFields: ['data'], outputDeniedFields: ['data[].draftVersion.variants[].fileUrl'] })!)).toEqual({
      data: [{ id: 1, draftVersion: { fileUrl: 'a', variants: [{ size: 1 }] }, items: [[{ fileUrl: 'c', ok: 1 }]] }],
    });
    expect(applyOutputBound(value, outputBoundOf({ outputDeniedFields: ['**.fileUrl'] })!)).toEqual({
      data: [{ id: 1, draftVersion: { variants: [{ size: 1 }] }, items: [[{ ok: 1 }]] }],
    });
    // success and uiAction are never removed, also when named like a pattern.
    expect(applyOutputBound({ success: true, uiAction: { a: 1 }, x: 1 }, outputBoundOf({ outputDeniedFields: ['**.uiAction', '**.success'] })!))
      .toEqual({ success: true, uiAction: { a: 1 }, x: 1 });
  });

  it('fails closed beyond the depth bound of an any-depth key', () => {
    let deep: Json = { fileUrl: 'deepest', keep: 'v' };
    for (let index = 0; index < MAX_ANY_DEPTH + 5; index += 1) deep = { level: deep };
    const bounded = applyOutputBound({ deep, list: [[[{ fileUrl: 'x', ok: 1 }]]] }, outputBoundOf({ outputDeniedFields: ['**.fileUrl'] })!)!;
    const text = JSON.stringify(bounded);
    expect(text).not.toContain('deepest');
    expect(text).not.toContain('"keep"');
    expect(text).not.toContain('fileUrl');
    expect(bounded.list).toEqual([[[{ ok: 1 }]]]);
    // Within the bound nothing else is lost.
    let shallow: Json = { fileUrl: 'x', keep: 'v' };
    for (let index = 0; index < MAX_ANY_DEPTH - 2; index += 1) shallow = { level: shallow };
    expect(JSON.stringify(applyOutputBound({ shallow }, outputBoundOf({ outputDeniedFields: ['**.fileUrl'] })!))).toContain('"keep":"v"');
  });

  it('allows nothing for an invalid declaration on a tool not built with defineTool (fail closed)', () => {
    const bound = outputBoundOf({ outputDeniedFields: ['data[0]'] })!;
    expect(applyOutputBound({ success: true, data: [1] }, bound)).toEqual({ success: true });
  });

  it('lists what a default view leaves out, aggregated, largest first', () => {
    const left = leftOutFields(paginated(3, 10), outputFieldTree(['data[].name', 'meta']));
    expect(left.map((field) => field.path).slice(0, 2)).toEqual(['data[].owner', 'data[].notes']);
    expect(left.map((field) => field.path).sort()).toEqual(['data[].id', 'data[].notes', 'data[].owner', 'data[].status']);
    expect([...left[0]!.children.keys()]).toEqual(['name', 'email']);
  });
});

describe('the Returns: description of the output schema', () => {
  const schema = z.object({
    data: z.array(z.object({ id: z.string(), name: z.string(), fileUrl: z.string(), owner: z.object({ name: z.string(), email: z.string() }) })),
    meta: z.object({ page: z.number() }),
  });

  it('is reduced to the upper bound', () => {
    expect(zodToCompactDescription(schema, 5, outputBoundOf({ outputAllowedFields: ['data[].name', 'data[].owner.name'] })))
      .toBe('{ data?: Array<{ name: string, owner?: { name: string } }> }');
    expect(zodToCompactDescription(schema, 5, outputBoundOf({ outputDeniedFields: ['**.fileUrl', 'data[].owner.email'] })))
      .toBe('{ data?: Array<{ id: string, name: string, owner?: { name: string } }>, meta: { page: number } }');
    expect(zodToCompactDescription(schema, 4)).toContain('fileUrl');
  });

  it('is applied by endpointToolToTool, and unchanged without a declaration', () => {
    const make = (extra: object) => endpointToolToTool(defineEndpointTool({
      id: 'x.get', toolName: 'x_get', description: 'X.', method: 'GET', path: '/x', inputSchema: z.object({}), outputSchema: schema, ...extra,
    }));
    expect(make({}).description).toContain('fileUrl');
    expect(make({ outputDeniedFields: ['**.fileUrl'] }).description).not.toContain('fileUrl');
    expect(make({ outputAllowedFields: ['meta'] }).description).toBe('X.\n\nReturns: { meta: { page: number } }');
  });
});

describe('toolToAiTool: the upper bound', () => {
  it('applies before the store, the overview and the cut, and keeps success, uiAction and failures', async () => {
    const store = createResultStore();
    const result = await first(toolOf({ ...paginated(), uiAction: { type: 'open', id: 'secretUi' } }, {
      outputAllowedFields: ['data[].name', 'data[].notes', 'meta'],
    }), store);
    const text = JSON.stringify(result);
    expect(text).not.toContain('owner');
    expect(text).not.toContain('d1"');
    expect(result.uiAction).toEqual({ type: 'open', id: 'secretUi' });
    const stored = store.get((result as Overview)._result.id)!.value;
    expect(JSON.stringify(stored)).not.toContain('owner');
    const failure = { success: false, error: 'boom', status: 404, body: { detail: 'missing', secret: 's' } };
    const failing = (fields: object) => defineTool({
      id: 'f', description: 'F.', inputSchema: z.object({}), ...fields, execute: async () => ({ ...failure }),
    });
    // A failure is not a record of the declared shape: it is bounded as today, not projected.
    expect(await first(failing({ outputAllowedFields: ['data'], outputDeniedFields: ['**.secret'] })))
      .toEqual(await first(failing({})));
  });

  it('builds uiAction from the full backend answer (endpoint tools)', async () => {
    const response: InternalApiResponse = { ok: true, status: 201, data: { id: 'task-7', title: 'T', secret: 's' } };
    const tool = endpointToolToTool(defineEndpointTool({
      id: 'tasks.create', toolName: 'tasks_create', description: 'Create.', method: 'POST', path: '/tasks',
      inputSchema: z.object({}).strict(), outputAllowedFields: ['title'],
      uiPattern: { type: 'open-detail', entity: 'task', idField: 'id' },
    }));
    const result = await toolToAiTool(tool, { ...ctx, callEndpoint: async () => response } as never, 'tasks_create').execute({}) as Record<string, unknown>;
    expect(result).toMatchObject({ success: true, title: 'T' });
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('secret');
    expect(JSON.stringify(result.uiAction)).toContain('task-7');
  });

  it('leaves the withheld answer of a schema mismatch as it is', async () => {
    const tool = defineTool({
      id: 'x', description: 'X.', inputSchema: z.object({}), outputSchema: z.object({ a: z.number() }),
      outputAllowedFields: ['b'], execute: async () => ({ a: 'not a number' }) as never,
    });
    expect(await first(tool)).toMatchObject({ success: true, outputWithheld: true });
  });

  it('withholds a result that cannot be serialized, without a default view', async () => {
    const tool = defineTool({
      id: 'x', description: 'X.', inputSchema: z.object({}), outputDeniedFields: ['secret'], outputDefaultFields: ['a'],
      execute: async () => ({ a: 1n, secret: 's' }),
    });
    const result = await first(tool, createResultStore());
    expect(result).toMatchObject({ success: true, outputWithheld: true });
    expect(result).not.toHaveProperty('_result');
    expect(result).not.toHaveProperty('_truncated');
  });

  it('makes a non-record result travel under data', async () => {
    const tool = defineTool({ id: 'x', description: 'X.', inputSchema: z.object({}), outputAllowedFields: ['data[].a'], execute: async () => [{ a: 1, b: 2 }] });
    expect(await first(tool)).toEqual({ data: [{ a: 1 }] });
  });
});

describe('toolToAiTool: the default view', () => {
  const view = { outputDefaultFields: ['data[].id', 'data[].name', 'meta'] };

  it('applies below the limit and creates a handle only when something is left out', async () => {
    const store = createResultStore();
    const result = await first(toolOf(paginated(3, 10), view), store) as Overview;
    expect(result.data).toEqual([{ id: 'd0', name: 'Design 0' }, { id: 'd1', name: 'Design 1' }, { id: 'd2', name: 'Design 2' }]);
    expect(result.meta).toEqual({ page: 1, total: 3 });
    expect(result._result.omitted!.map((entry) => entry.path)).toEqual(['data[].owner', 'data[].notes', 'data[].status']);
    expect(result._result.omitted![0]).toMatchObject({ keys: ['email', 'name'] });
    expect(result._result.hint).toContain('Read more with read_result');
    expect(store.size).toBe(1);
    const rest = await read(store, { resultId: result._result.id, fields: ['data[].owner.email'] });
    expect(JSON.stringify(rest)).toContain('owner0@corp.example');
    // Nothing left out: as today, no handle and no marker.
    const plain = await first(toolOf({ data: [{ id: 'a', name: 'b' }], meta: {} }, view), store);
    expect(plain).toEqual({ data: [{ id: 'a', name: 'b' }], meta: {} });
    expect(store.size).toBe(1);
  });

  it('drops the declared fields last when the view itself is over the limit', async () => {
    const big = {
      data: Array.from({ length: 40 }, (_, index) => ({
        id: `d${index}`, name: `Design ${index}`, label: `L${index}`, description: 'w '.repeat(150), extra: 'e'.repeat(500),
      })),
    };
    const store = createResultStore();
    const result = await first(toolOf(big, { outputDefaultFields: ['data[].name', 'data[].description', 'data[].label'] }), store, 5_000) as Overview;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(5_000);
    const paths = result._result.omitted!.map((entry) => entry.path);
    // The heuristics drop the long description first, but never a field outside the view in its place.
    expect(paths).toContain('data[].extra');
    expect(paths).toContain('data[].description');
    expect(paths).toContain('data[].id');
    const entry = (result.data as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(entry).sort()).toEqual(['label', 'name']);
  });

  it('without a store applies the view and does not point to read_result', async () => {
    const result = await first(toolOf(paginated(3, 10), view));
    expect(result.data).toEqual([{ id: 'd0', name: 'Design 0' }, { id: 'd1', name: 'Design 1' }, { id: 'd2', name: 'Design 2' }]);
    const marker = result._truncated as { omitted: Array<{ path: string }>; hint: string };
    expect(marker.omitted.map((entry) => entry.path)).toEqual(['data[].owner', 'data[].notes', 'data[].status']);
    expect(marker.hint).toContain('cannot be read in this turn');
    expect(JSON.stringify(result)).not.toContain('read_result');
    // Over the limit too: within it, and still no read_result.
    const cut = await first(toolOf(paginated(40, 10), { outputDefaultFields: ['data'] }), undefined, 1_000);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(cut)).not.toContain('read_result');
    expect(cut._truncated).toMatchObject({ omitted: [{ path: 'meta' }] });
  });

  it('falls back to the view without a handle when the store refuses', async () => {
    const store = createResultStore({ maxResults: 1 });
    await first(toolOf(paginated(3, 10), view), store);
    const second = await first(toolOf(paginated(3, 10), view), store);
    expect(second).not.toHaveProperty('_result');
    expect((second._truncated as { hint: string }).hint).toContain('cannot be read');
  });

  it('keeps the write-origin wording for a write tool', async () => {
    const store = createResultStore();
    const result = await first(toolOf(paginated(3, 10), { ...view, method: 'POST' }), store) as Overview;
    expect(result._result.id).toMatch(/^rw_/);
    expect(result._result.hint).toContain('do not call the tool again');
    const unstored = await first(toolOf(paginated(3, 10), { ...view, method: 'POST' }));
    expect((unstored._truncated as { hint: string }).hint).toContain('do not call it again');
  });

  it('never shows a denied or a non-allowed default field', async () => {
    const store = createResultStore();
    const result = await first(toolOf(paginated(3, 10), {
      outputAllowedFields: ['data[].id', 'data[].owner', 'meta'],
      outputDeniedFields: ['data[].owner.email'],
      outputDefaultFields: ['data[].name', 'data[].owner', 'meta'],
    }), store) as Overview;
    expect(result.data).toEqual([{ owner: { name: 'Owner 0' } }, { owner: { name: 'Owner 1' } }, { owner: { name: 'Owner 2' } }]);
    expect(result._result.omitted!.map((entry) => entry.path)).toEqual(['data[].id']);
  });
});

describe('PII shield and the upper bound', () => {
  const detector: PiiDetector = {
    detect(text) {
      const found: PiiEntity[] = [];
      for (const match of text.matchAll(/owner\d+@corp\.example/g)) {
        found.push({ type: 'email', start: match.index, end: match.index + match[0].length, score: 1, text: match[0] });
      }
      return found;
    },
  };

  it('projects before sealing: the seal never sees a removed field, and pseudonyms stay stable across reads', async () => {
    const shield = createPiiShield({ locale: 'en-US', detector });
    const seal = vi.fn((value: unknown) => shield.anonymizeResult(value, 's1'));
    const store = createResultStore({ seal });
    const tool = toolOf({ ...paginated(), secret: 'SECRET-TOP' }, {
      outputDeniedFields: ['**.notes', 'secret'], outputDefaultFields: ['data[].id', 'data[].owner'],
    });
    const overview = await first(tool, store) as Overview;
    expect(seal).toHaveBeenCalledTimes(1);
    const sealedInput = JSON.stringify(seal.mock.calls[0]![0]);
    expect(sealedInput).not.toContain('SECRET-TOP');
    expect(sealedInput).not.toContain('nnnn');
    const firstEmail = ((overview.data as Array<{ owner: { email: string } }>)[0]!).owner.email;
    expect(firstEmail).not.toBe('owner0@corp.example');
    const again = await read(store, { resultId: overview._result.id, fields: ['data[].owner.email'], limit: 1 });
    expect(((again.data as Array<{ owner: { email: string } }>)[0]!).owner.email).toBe(firstEmail);
  });
});

/** The practice case: signed URLs under four version objects, directly and in variants, and in playlist items. */
function designs() {
  const version = (prefix: string, index: number) => ({
    title: `${prefix} ${index}`,
    fileUrl: `https://s3.example/${prefix}-${index}?X-Signature=SIGNED${prefix}${index}`,
    thumbnailUrl: `https://s3.example/thumb-${prefix}-${index}?X-Signature=THUMB${prefix}${index}`,
    variants: [0, 1].map((variant) => ({
      size: variant, fileUrl: `https://s3.example/v?X-Signature=VARIANT${prefix}${index}x${variant}`,
      thumbnailUrl: `https://s3.example/v?X-Signature=VTHUMB${prefix}${index}x${variant}`,
    })),
  });
  return {
    data: Array.from({ length: 12 }, (_, index) => ({
      id: `design-${index}`, name: `Design ${index}`,
      draftVersion: version('draft', index), publishedVersion: version('pub', index),
      pendingVersion: version('pend', index), lastSubmittedVersion: version('last', index),
      items: [{ position: 1, design: { name: 'Nested', fileUrl: `https://s3.example/i?X-Signature=ITEM${index}`, thumbnailUrl: `https://s3.example/i?X-Signature=ITHUMB${index}` } }],
    })),
    meta: { page: 1 },
  };
}

describe('the signed-URL practice case', () => {
  async function everything(tool: Tool, maxChars: number) {
    const store = createResultStore();
    const answers: unknown[] = [];
    const overview = await first(tool, store, maxChars) as Overview;
    answers.push(overview);
    const id = overview._result.id;
    for (const fields of [
      undefined, ['data[].draftVersion.variants'], ['data[].draftVersion'], ['data[].items'], ['data[].items[].design'],
      ['data[].draftVersion.variants[].fileUrl'], ['data[].draftVersion.fileUrl'], ['data[].items[].design.thumbnailUrl'],
      ['**.fileUrl'], ['data[0].publishedVersion'], ['data[0].pendingVersion.variants[1]'], ['data[].lastSubmittedVersion.nope'],
      ['data'], ['data[].nope.deeper'],
    ]) {
      for (const offset of [0, 3]) answers.push(await read(store, { resultId: id, ...(fields ? { fields } : {}), offset, limit: 4 }));
    }
    return { store, overview, answers, text: JSON.stringify(answers) };
  }

  it('excludes fileUrl and thumbnailUrl on every channel with two any-depth paths', async () => {
    const { text, answers } = await everything(toolOf(designs(), { outputDeniedFields: ['**.fileUrl', '**.thumbnailUrl'] }), 2_000);
    for (const secret of ['X-Signature', 'SIGNED', 'THUMB', 'VARIANT', 'ITEM', 's3.example']) expect(text).not.toContain(secret);
    // The key names appear only where the model itself asked for them (unknownFields of answers 11 to 16).
    const unasked = JSON.stringify([...answers.slice(0, 11), ...answers.slice(17)]);
    expect(unasked).not.toContain('fileUrl');
    expect(unasked).not.toContain('thumbnailUrl');
    // A parent of a denied field returns the rest of it.
    const variants = answers[3] as { data: Array<{ draftVersion: { variants: unknown[] } }> };
    expect(variants.data[0]!.draftVersion.variants).toEqual([{ size: 0 }, { size: 1 }]);
    // The denied path itself answers like a field that does not exist; **. is no read path.
    expect(answers[11]).toMatchObject({ error: 'unknown_fields' });
    expect(answers[17]).toMatchObject({ error: 'invalid_fields' });
  });

  it('excludes one field deep in the tree with one exact path; the same name elsewhere stays', async () => {
    const tool = toolOf(designs(), { outputDeniedFields: ['data[].draftVersion.variants[].fileUrl'] });
    const { answers } = await everything(tool, 2_000);
    const variants = answers[3] as { data: Array<{ draftVersion: { variants: unknown[] } }> };
    expect(variants.data[0]!.draftVersion.variants).toEqual([
      { size: 0, thumbnailUrl: 'https://s3.example/v?X-Signature=VTHUMBdraft0x0' },
      { size: 1, thumbnailUrl: 'https://s3.example/v?X-Signature=VTHUMBdraft0x1' },
    ]);
    expect(JSON.stringify(answers)).not.toContain('VARIANTdraft');
    expect(JSON.stringify(answers)).toContain('VARIANTpub');
    // Reading the denied path answers exactly like reading a path that never existed.
    const store = createResultStore();
    const overview = await first(tool, store, 2_000) as Overview;
    const denied = await read(store, { resultId: overview._result.id, fields: ['data[].draftVersion.variants[].fileUrl'] });
    const missing = await read(store, { resultId: overview._result.id, fields: ['data[].draftVersion.variants[].fileUrX'] });
    expect(JSON.stringify(denied).replaceAll('fileUrl', 'fileUrX')).toBe(JSON.stringify(missing));
  });
});

describe('a field outside the upper bound is indistinguishable from one that does not exist', () => {
  const withSecret = () => ({
    data: paginated(20, 600).data.map((entry, index) => ({ ...entry, secretToken: `tok${index}`, cost: { cents: index } })),
    meta: { page: 1, total: 20, internal: 'x' },
  });
  const without = () => ({
    data: paginated(20, 600).data,
    meta: { page: 1, total: 20 },
  });
  const normalize = (value: unknown) => JSON.stringify(value).replace(/"(r[ow]_[0-9a-z]{8})"/g, '"ID"');

  it.each([
    ['allowed', { outputAllowedFields: ['data[].id', 'data[].name', 'data[].status', 'data[].owner', 'data[].notes', 'meta.page', 'meta.total'] }],
    ['denied', { outputDeniedFields: ['data[].secretToken', 'data[].cost', 'meta.internal'] }],
    ['denied any depth', { outputDeniedFields: ['**.secretToken', '**.cost', '**.internal'] }],
  ] as Array<[string, Partial<Pick<Tool, 'outputAllowedFields' | 'outputDeniedFields'>>]>)('gives byte-identical answers (%s)', async (_label, fields) => {
    const left = createResultStore();
    const right = createResultStore();
    const a = await first(toolOf(withSecret(), fields), left, 4_000) as Overview;
    const b = await first(toolOf(without(), {}), right, 4_000) as Overview;
    expect(normalize(a)).toBe(normalize(b));
    for (const input of [
      {}, { fields: ['data[].secretToken'] }, { fields: ['data[].cost.cents', 'data[].id'] }, { fields: ['meta.internal'] },
      { fields: ['data[0].secretToken'] }, { fields: ['data[30].id'] }, { fields: ['data[].owner'], offset: 5, limit: 3 },
      { fields: ['meta', 'data[].nope'] }, { fields: ['data[0]'] },
    ]) {
      expect(normalize(await read(left, { resultId: a._result.id, ...input })))
        .toBe(normalize(await read(right, { resultId: b._result.id, ...input })));
    }
  });
});

describe('non-leak property test of the upper bound', () => {
  /** Deterministic pseudo-random numbers. */
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const SHARED = 'Qzsecr';

  /**
   * A random result whose keys (`Qz` + 4 letters) and string values (`Wq` + 4
   * letters) are unique; `Qzsecr` is planted at random places, also at the top
   * level and inside arrays of arrays.
   */
  function generate(next: () => number) {
    let counter = 0;
    const token = (prefix: string) => {
      let n = counter += 1;
      let text = '';
      for (let index = 0; index < 4; index += 1) {
        text += letters[n % 26];
        n = Math.floor(n / 26);
      }
      return prefix + text;
    };
    const value = (depth: number): Json => {
      const roll = next();
      if (depth > 3 || roll < 0.35) return token('Wq');
      if (roll < 0.55) return Array.from({ length: 1 + Math.floor(next() * 3) }, () => value(depth + 1));
      return object(depth + 1);
    };
    const object = (depth: number): { [key: string]: Json } => {
      const output: { [key: string]: Json } = {};
      for (let index = 0, count = 1 + Math.floor(next() * 3); index < count; index += 1) output[token('Qz')] = value(depth);
      if (next() < 0.3) output[SHARED] = token('Wq');
      return output;
    };
    const root = object(0);
    root.data = Array.from({ length: 4 }, () => object(1));
    root[SHARED] = { inner: token('Wq') };
    root.nested = [[{ [SHARED]: token('Wq'), keep: token('Wq') }]];
    return root;
  }

  type Step = { kind: 'key'; key: string } | { kind: 'each' };
  /** Every key with its path, and every string leaf with its own path. */
  function walk(value: Json, steps: Step[] = [], found = { keys: [] as Array<{ steps: Step[]; key: string }>, leaves: [] as Array<{ steps: Step[]; value: string }> }) {
    if (Array.isArray(value)) value.forEach((entry) => walk(entry, [...steps, { kind: 'each' }], found));
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const childSteps: Step[] = [...steps, { kind: 'key', key }];
        found.keys.push({ steps: childSteps, key });
        walk(child, childSteps, found);
      }
    } else if (typeof value === 'string') found.leaves.push({ steps, value });
    return found;
  }
  const format = (steps: Step[]) => steps.map((step, index) => (step.kind === 'each' ? '[]' : index === 0 ? step.key : `.${step.key}`)).join('');
  const same = (left: Step, right: Step) => left.kind === right.kind && (left.kind === 'each' || left.key === (right as { key: string }).key);
  const prefixOf = (prefix: Step[], steps: Step[]) => prefix.length <= steps.length && prefix.every((step, index) => same(step, steps[index]!));

  it('never shows a key or value outside the upper bound on any channel', async () => {
    let withHandle = 0;
    let checked = 0;
    for (let seed = Number(process.env.SEED ?? 1); seed <= Number(process.env.SEED ?? 60); seed += 1) {
      const next = random(seed);
      const root = generate(next);
      const found = walk(root);
      const all = found.keys;
      const pick = () => all[Math.floor(next() * all.length)]!;
      const mode = seed % 3;
      const allowed = mode === 1 ? undefined : Array.from({ length: 1 + Math.floor(next() * 6) }, () => format(pick().steps));
      const exactDenied = mode === 0 ? [] : Array.from({ length: 1 + Math.floor(next() * 3) }, () => format(pick().steps));
      const patterns = seed % 2 === 0 ? [`**.${SHARED}`] : [];
      const denied = [...exactDenied, ...patterns];
      const allowedSteps = (allowed ?? []).map((text) => parseOutputFieldPath(text)! as Step[]);
      const deniedSteps = exactDenied.map((text) => parseOutputFieldPath(text)! as Step[]);
      const hidden = (steps: Step[], leaf: boolean) => (
        (allowed !== undefined && !allowedSteps.some((prefix) => prefixOf(prefix, steps))
          && (leaf || !allowedSteps.some((inner) => prefixOf(steps, inner))))
        || deniedSteps.some((prefix) => prefixOf(prefix, steps))
        || (patterns.length > 0 && steps.some((step) => step.kind === 'key' && step.key === SHARED))
      );
      const forbidden = new Set<string>();
      for (const entry of all) if (hidden(entry.steps, false)) forbidden.add(entry.key);
      // A shared key name may also be visible elsewhere; every value is unique.
      for (const entry of all) if (!hidden(entry.steps, false)) forbidden.delete(entry.key);
      for (const leaf of found.leaves) if (hidden(leaf.steps, true)) forbidden.add(leaf.value);
      // The pattern key itself: hidden everywhere when declared.
      if (patterns.length > 0) expect(forbidden.has(SHARED)).toBe(true);

      const tool = toolOf(root, {
        ...(allowed ? { outputAllowedFields: allowed } : {}),
        ...(denied.length > 0 ? { outputDeniedFields: denied } : {}),
        ...(seed % 4 !== 0 ? { outputDefaultFields: [format(pick().steps), format(pick().steps)] } : {}),
      });
      const store = createResultStore();
      const limit = next() < 0.7 ? 1_000 : 16_000;
      /** Every answer with the names the model itself wrote in its request (echoed as unknownFields, as for any path). */
      const answers: Array<{ answer: unknown; asked: string }> = [
        { answer: await first(tool, store, limit), asked: '' },
        { answer: await first(tool, undefined, limit), asked: '' },
      ];
      const id = (answers[0]!.answer as { _result?: { id: string } })._result?.id;
      if (id) {
        withHandle += 1;
        const requests: Array<string[] | undefined> = [undefined];
        for (let index = 0; index < 12; index += 1) {
          const text = format(pick().steps);
          requests.push([text], [`${text}.Qznope`], [text.replace(/\[\]/, '[0]')], [text.replace(/\[\]/, '[99]')], [`data[].${pick().key}`]);
        }
        for (const fields of requests) {
          const asked = JSON.stringify(fields ?? []);
          answers.push({ answer: await read(store, { resultId: id, ...(fields ? { fields } : {}) }), asked });
          answers.push({ answer: await read(store, { resultId: id, ...(fields ? { fields } : {}), offset: 1, limit: 1 }), asked });
        }
      }
      checked += forbidden.size;
      for (const { answer, asked } of answers) {
        const text = JSON.stringify(answer);
        for (const marker of forbidden) {
          if (text.includes(marker) && !asked.includes(marker)) {
            throw new Error(`seed ${seed}: ${marker} leaked (allowed ${JSON.stringify(allowed)}, denied ${JSON.stringify(denied)}): ${text.slice(0, 400)}`);
          }
        }
      }
    }
    // The run exercised handles and hidden markers, not only trivial cases.
    if (!process.env.SEED) {
      expect(withHandle).toBeGreaterThanOrEqual(30);
      expect(checked).toBeGreaterThanOrEqual(500);
    }
  });
});

describe('buildResultOverview with a default view', () => {
  it('is byte-identical without one', () => {
    const value = paginated();
    expect(JSON.stringify(buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true })))
      .toBe(JSON.stringify(buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true, defaultFields: undefined })));
  });
});
