import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool, defineTool, type PiiDetector, type PiiEntity, type ToolContext } from '../../types.js';
import { endpointToolToTool, toolToAiTool, type InternalApiResponse } from './index.js';
import { createReadResultTool, readResultHandle, type ReadResultInput, type ReadResultMarker } from './read-result-tool.js';
import { buildResultOverview, identityFieldsOf, type ResultOverviewMarker } from './result-overview.js';
import {
  formatResultPath, isSelectablePath, mixedArraySelections, parseResultPath, projectResult, type ParsedPath, type PathStep,
} from '../../contracts/result-paths.js';
import { createPiiShield } from '../pii-shield/create-pii-shield.js';
import { createFakeDataGenerator } from '../pii-shield/fake-data.js';
import { createResultStore, DEFAULT_RESULT_HANDLE_LIMITS, type ResultHandle } from './result-store.js';
import { createExecutionFingerprint } from '../../runtime/fingerprint.js';
import { toolResultForFingerprint } from '../../runtime/tool-failure.js';

type Overview = Record<string, unknown> & { _result: ResultOverviewMarker };
type ReadMarker = ReadResultMarker;

/** 20 playlists of ~8,000 characters each. */
const playlists = (count = 20, tracks = 8_000) => ({
  success: true,
  data: Array.from({ length: count }, (_, index) => ({
    id: `p${index}`, name: `List ${index}`, owner: { name: `Owner ${index}`, bio: 'b'.repeat(300) }, tracks: 'x'.repeat(tracks),
  })),
  meta: { page: 1 },
});

const size = (value: unknown) => JSON.stringify(value).length;

describe('result paths', () => {
  it.each([
    ['data[].name', ['data', '[]', 'name']],
    ['data[].owner.name', ['data', '[]', 'owner', 'name']],
    ['meta', ['meta']],
    ['[]', ['[]']],
    ['[].id', ['[]', 'id']],
    ['matrix[][]', ['matrix', '[]', '[]']],
    ['data[0]', ['data', '[0]']],
    ['data[3].owner.name', ['data', '[3]', 'owner', 'name']],
    ['data[0].items', ['data', '[0]', 'items']],
    ['[2].id', ['[2]', 'id']],
    ['matrix[1][]', ['matrix', '[1]', '[]']],
    ['data[].items[10]', ['data', '[]', 'items', '[10]']],
  ])('parses %s', (text, expected) => {
    expect(parseResultPath(text)?.steps.map((step) => (
      step.kind === 'each' ? '[]' : step.kind === 'index' ? `[${step.index}]` : step.key
    ))).toEqual(expected);
  });

  it.each(['', 'data..name', 'data[01]', 'data[-1]', 'data[1.5]', 'data[ 1]', 'data[1234567890]', 'data[0]x', 'data[*]', '*', 'data.[]', '.data', 'data.', 'a[]b', '!data', 'x'.repeat(201)])(
    'rejects %j',
    (text) => {
      if (text === '*' || text === '!data') {
        // A plain field name: no wildcard or negation semantics, it just names a field.
        expect(parseResultPath(text)?.steps).toEqual([{ kind: 'key', key: text }]);
      } else {
        expect(parseResultPath(text)).toBeUndefined();
      }
    },
  );

  it('projects nested and array paths and pages the outermost array', () => {
    const root = {
      data: { items: [{ id: 1, owner: { name: 'a', mail: 'x' } }, { id: 2, owner: { name: 'b' } }, { id: 3 }], page: 2 },
      meta: { total: 3 },
    };
    const projection = projectResult(root, [parseResultPath('data.items[].owner.name')!, parseResultPath('meta')!], { offset: 1, limit: 2 });
    expect(projection.value).toEqual({ data: { items: [{ owner: { name: 'b' } }, {}] }, meta: { total: 3 } });
    expect(projection.slices).toEqual([{ path: 'data.items', total: 3, returned: 2 }]);
  });

  it('pages a path that selects an array itself', () => {
    const projection = projectResult({ list: [1, 2, 3, 4] }, [parseResultPath('list')!], { offset: 2 });
    expect(projection.value).toEqual({ list: [3, 4] });
  });
});

describe('buildResultOverview', () => {
  it('shows all 20 entries with their small fields at the default limit and names the large field', () => {
    const overview = buildResultOverview(playlists(), { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(16_000);
    const data = overview.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(20);
    expect(data.map((entry) => entry.name)).toEqual(Array.from({ length: 20 }, (_, index) => `List ${index}`));
    expect(data[0]).not.toHaveProperty('tracks');
    expect(overview._result).toMatchObject({
      id: 'ro_abcdefgh', arrays: { data: 20 }, showing: 20, total: 20,
      omitted: [{ path: 'data[].tracks', approxChars: 160_000 }],
    });
    expect(overview.meta).toEqual({ page: 1 });
    expect(overview.success).toBe(true);
  });

  it('leaves out the next largest field (nested) when the first is not enough', () => {
    const overview = buildResultOverview(playlists(), { id: 'ro_abcdefgh', maxChars: 4_000, readOnly: true }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(4_000);
    expect((overview.data as unknown[])).toHaveLength(20);
    expect(overview._result.omitted?.map((entry) => entry.path)).toEqual(['data[].tracks', 'data[].owner.bio']);
    expect((overview.data as Array<{ owner: unknown }>)[3]!.owner).toEqual({ name: 'Owner 3' });
  });

  it('reduces the entries only when the small fields alone do not fit', () => {
    const value = { items: Array.from({ length: 2_000 }, (_, index) => ({ id: `p${index}`, name: `List number ${index}`, desc: 'd'.repeat(50) })) };
    const overview = buildResultOverview(value, { id: 'rw_abcdefgh', maxChars: 16_000, readOnly: false }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(16_000);
    const items = overview.items as Array<Record<string, unknown>>;
    expect(overview._result.showing).toBe(items.length);
    expect(items.length).toBeGreaterThan(300);
    expect(items.length).toBeLessThan(2_000);
    expect(Object.keys(items[0]!)).toEqual(['id', 'name']);
    expect(overview._result.total).toBe(2_000);
  });

  it('finds the dominant array inside an envelope ({ data: { items } })', () => {
    const value = { data: { items: playlists().data, page: 1, pageSize: 20 } };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect((overview.data as { items: unknown[]; page: number }).items).toHaveLength(20);
    expect((overview.data as { page: number }).page).toBe(1);
    expect(overview._result.omitted?.[0]?.path).toBe('data.items[].tracks');
  });

  it('leaves out the largest fields of a result without an array', () => {
    const value = { title: 'Report', body: 'r'.repeat(30_000), appendix: { notes: 'n'.repeat(5_000), author: 'A' } };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(overview.title).toBe('Report');
    expect(overview).not.toHaveProperty('body');
    expect(overview.appendix).toEqual({ notes: 'n'.repeat(5_000), author: 'A' });
    expect(overview._result.omitted).toEqual([{ path: 'body', approxChars: 30_000 }]);
    expect(overview._result).not.toHaveProperty('showing');
  });

  it('keeps success and uiAction untouched', () => {
    const uiAction = { type: 'navigate', path: '/playlists' };
    const overview = buildResultOverview({ ...playlists(), uiAction }, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(overview.uiAction).toEqual(uiAction);
    expect(overview.success).toBe(true);
  });

  it('is deterministic and shares no object with its input', () => {
    const value = playlists();
    const first = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 6_000, readOnly: true });
    const second = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 6_000, readOnly: true });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    (first!.meta as Record<string, unknown>).page = 99;
    expect(value.meta.page).toBe(1);
  });

  it('stays within the limit for many shapes and limits (property-style)', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const text = (length: number) => 'abcdefghij'.repeat(Math.ceil(length / 10)).slice(0, length);
    const entry = (): Record<string, unknown> => ({
      id: Math.floor(random() * 1e6),
      label: text(Math.floor(random() * 40)),
      body: text(Math.floor(random() * 3_000)),
      nested: { deep: { deeper: { text: text(Math.floor(random() * 500)) } }, tags: [text(10), text(20)] },
    });
    for (let round = 0; round < 60; round += 1) {
      const count = Math.floor(random() * 300);
      const value: Record<string, unknown> = random() < 0.5
        ? { success: true, data: Array.from({ length: count }, entry), meta: { note: text(Math.floor(random() * 2_000)) } }
        : { result: { rows: Array.from({ length: count }, entry) }, extra: text(Math.floor(random() * 20_000)) };
      if (size(value) <= 1_000) continue;
      const maxChars = 1_000 + Math.floor(random() * 30_000);
      const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars, readOnly: random() < 0.5 });
      if (overview) expect(size(overview)).toBeLessThanOrEqual(maxChars);
    }
  });

  it('words the hint for a read tool and for a write tool', () => {
    const read = buildResultOverview(playlists(), { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(read._result.hint).toContain('read_result');
    expect(read._result.hint).toContain('in this turn');
    expect(read._result.hint).toContain('On result_expired call the original tool again.');
    const write = buildResultOverview(playlists(), { id: 'rw_abcdefgh', maxChars: 16_000, readOnly: false }) as Overview;
    expect(write._result.hint).toContain('do not call the tool again (it has run)');
    expect(write._result.hint).toContain('no longer available');
    expect(write._result.hint).not.toContain('call the original tool again');
  });
});

describe('createResultStore', () => {
  const put = (store: ReturnType<typeof createResultStore>, value: Record<string, unknown> = playlists(), readOnly = true) =>
    store.put({ toolName: 'playlists_list', readOnly, maxChars: 16_000, value });

  it('gives read tools ro_ and other tools rw_ ids of 8 random base36 characters', async () => {
    const store = createResultStore();
    const read = await put(store) as Overview;
    const write = await put(store, playlists(), false) as Overview;
    expect(read._result.id).toMatch(/^ro_[0-9a-z]{8}$/);
    expect(write._result.id).toMatch(/^rw_[0-9a-z]{8}$/);
    expect(read._result.id).not.toBe(write._result.id);
    expect(store.get(read._result.id)?.toolName).toBe('playlists_list');
  });

  it('refuses a ninth handle, a result over 2 MiB and a turn over 16 MiB by default', async () => {
    expect(DEFAULT_RESULT_HANDLE_LIMITS).toEqual({ maxResults: 8, maxResultBytes: 2 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 });
    const counted = createResultStore();
    for (let index = 0; index < 8; index += 1) expect(await put(counted)).toBeDefined();
    expect(await put(counted)).toBeUndefined();

    const sized = createResultStore();
    expect(await put(sized, playlists(1, 2 * 1024 * 1024))).toBeUndefined();
    expect(await put(sized, playlists(1, 2 * 1024 * 1024 - 1_000))).toBeDefined();

    const total = createResultStore({ maxResults: 100 });
    const nearlyTwo = playlists(1, 2 * 1024 * 1024 - 1_000);
    for (let index = 0; index < 8; index += 1) expect(await put(total, nearlyTwo)).toBeDefined();
    expect(await put(total, playlists(1, 200_000))).toBeUndefined();
  });

  it('honours custom limits and refuses after clear', async () => {
    const store = createResultStore({ maxResults: 1 });
    const first = await put(store) as Overview;
    expect(await put(store)).toBeUndefined();
    store.clear();
    expect(store.get(first._result.id)).toBeUndefined();
    expect(await put(createResultStore({ maxResultBytes: 1_000 }))).toBeUndefined();
    expect(await put(createResultStore({ maxTotalBytes: 1_000 }))).toBeUndefined();
    expect(() => createResultStore({ maxResults: 0 })).toThrow('maxResults must be a positive integer');
  });

  it('seals the complete result once and keeps only the sealed copy', async () => {
    const seal = vi.fn(async (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('Owner', 'Person')) as unknown);
    const store = createResultStore({ seal });
    const uiAction = { type: 'navigate', path: '/Owner' };
    const overview = await put(store, { ...playlists(), uiAction }) as Overview;
    expect(seal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(seal.mock.calls[0]![0])).toContain('"uiAction"');
    expect(JSON.stringify(overview)).not.toContain('Owner');
    expect(JSON.stringify(store.get(overview._result.id)!.value)).not.toContain('Owner');
    expect(store.isIssued(overview)).toBe(true);
  });

  it('binds a handle to the owner captured before the tool ran, and only while it is still current', async () => {
    const alice = { subjectId: 'alice', tenantId: 't1' };
    let current: typeof alice | undefined = alice;
    const store = createResultStore({ owner: async () => current });
    const putAs = (owner?: typeof alice) => store.put({
      toolName: 'playlists_list', readOnly: true, maxChars: 16_000, value: playlists(), ...(owner ? { owner } : {}),
    });
    const captured = await store.captureOwner();
    expect(captured).toEqual(alice);
    const overview = await putAs(captured) as Overview;
    expect(store.get(overview._result.id)?.owner).toEqual(alice);
    // No captured owner, another subject, another tenant, or no principal now: no handle.
    expect(await putAs()).toBeUndefined();
    current = { subjectId: 'bob', tenantId: 't1' };
    expect(await putAs(alice)).toBeUndefined();
    current = { subjectId: 'alice', tenantId: 't2' };
    expect(await putAs(alice)).toBeUndefined();
    current = undefined;
    expect(await putAs(alice)).toBeUndefined();
    expect(store.size).toBe(1);
    expect(createResultStore().captureOwner()).toBeUndefined();
  });
});

describe('read_result', () => {
  async function setup(value: Record<string, unknown> = playlists(), maxChars = 16_000, readOnly = true) {
    const store = createResultStore();
    const overview = await store.put({ toolName: 'playlists_list', readOnly, maxChars, value }) as Overview;
    const tool = createReadResultTool(store);
    const read = (input: Record<string, unknown>) => tool.execute({ resultId: overview._result.id, ...input }, {} as ToolContext) as Promise<Record<string, unknown>>;
    return { store, overview, tool, read };
  }

  it('reads omitted fields of chosen entries with offset and limit', async () => {
    const { read, store } = await setup();
    const result = await read({ fields: ['data[].id', 'data[].tracks'], offset: 2, limit: 1 });
    // The entry's own name comes with it (identity fields); id was selected anyway.
    expect(result.data).toEqual([{ name: 'List 2', id: 'p2', tracks: 'x'.repeat(8_000) }]);
    expect(result._result).toMatchObject({ offset: 2, returned: 1, total: 20, nextOffset: 3 });
    expect(store.isIssued(result)).toBe(true);
    expect(result).not.toHaveProperty('uiAction');
  });

  it('reads nested paths and a paginated envelope', async () => {
    const { read } = await setup({ data: { items: playlists().data, page: 1 } });
    const result = await read({ fields: ['data.items[].owner.name', 'data.page'], limit: 2 });
    expect(result.data).toEqual({
      items: [{ id: 'p0', name: 'List 0', owner: { name: 'Owner 0' } }, { id: 'p1', name: 'List 1', owner: { name: 'Owner 1' } }], page: 1,
    });
  });

  it('pages within the origin tool\'s limit and says where to continue', async () => {
    const { read } = await setup();
    const result = await read({ fields: ['data[].tracks'] });
    expect(size(result)).toBeLessThanOrEqual(16_000);
    expect(result._result).toMatchObject({ offset: 0, total: 20 });
    const { returned, nextOffset } = result._result as { returned: number; nextOffset: number };
    expect(returned).toBeGreaterThan(0);
    expect(nextOffset).toBe(returned);
  });

  it('cuts a single entry larger than the limit with a hint to read_result paging', async () => {
    const { read } = await setup(playlists(3, 40_000), 16_000);
    const result = await read({ fields: ['data[].tracks'] });
    expect(size(result)).toBeLessThanOrEqual(16_000);
    // One instruction: `_result.hint`; `_truncated` only says what was cut.
    expect(result._truncated).not.toHaveProperty('hint');
    expect((result._result as ReadMarker).hint).toContain('Entry 0 is shortened (see _truncated)');
    expect((result._result as { returned: number }).returned).toBe(1);
  });

  it('reads everything but uiAction without fields', async () => {
    const { read } = await setup({ ...playlists(2, 100), uiAction: { type: 'navigate', path: '/x' } }, 1_000);
    const result = await read({});
    expect(result).not.toHaveProperty('uiAction');
    expect(result.meta).toEqual({ page: 1 });
    expect(result.success).toBe(true);
  });

  it('lists unknown paths in their normalized form and rejects invalid ones without echoing them', async () => {
    const { read } = await setup();
    const unknown = await read({ fields: ['data[].name', 'data[].nope', 'missing'] });
    // Re-formatted from the parsed steps, identifier-like names only.
    expect((unknown._result as { unknownFields: unknown[] }).unknownFields).toEqual(['data[].nope', 'missing']);
    const invalid = await read({ fields: ['data[].name', `bad[0]${'z'.repeat(150)}`] });
    expect(invalid.error).toBe('invalid_fields');
    expect(String(invalid.hint)).toContain('number 2');
    expect(JSON.stringify(invalid)).not.toContain('zzzz');
  });

  it('answers result_expired with the instruction of the id\'s prefix', async () => {
    const tool = createReadResultTool(createResultStore());
    const read = await tool.execute({ resultId: 'ro_00000000' }, {} as ToolContext) as Record<string, string>;
    expect(read.error).toBe('result_expired');
    expect(read.hint).toContain('Call the original tool again');
    for (const resultId of ['rw_00000000', 'zz_unknown']) {
      const other = await tool.execute({ resultId }, {} as ToolContext) as Record<string, string>;
      expect(other.error).toBe('result_expired');
      expect(other.hint).toContain('Do not call the tool that produced it again');
      expect(other.hint).not.toContain('Call the original tool again');
    }
  });

  it('validates its input', () => {
    const schema = createReadResultTool(createResultStore()).inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({ resultId: 'ro_x', fields: Array.from({ length: 51 }, () => 'a') }).success).toBe(false);
    expect(schema.safeParse({ resultId: 'ro_x', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ resultId: 'ro_x', limit: 1_001 }).success).toBe(false);
    expect(schema.safeParse({ resultId: 'ro_x', offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ resultId: 'x'.repeat(65) }).success).toBe(false);
    expect(schema.safeParse({ resultId: 'ro_x', fields: ['a'], offset: 0, limit: 5 }).success).toBe(true);
  });
});

describe('toolToAiTool with a result store', () => {
  const response: InternalApiResponse = { ok: true, status: 200, data: playlists() };

  function tools(method: 'GET' | 'POST') {
    const callEndpoint = vi.fn(async () => response);
    const tool = endpointToolToTool(defineEndpointTool({
      id: 'playlists.call', toolName: 'playlists_call', description: 'Playlists.', method, path: '/api/playlists',
      inputSchema: z.object({}).strict(),
    }));
    const context = { currentDate: '2026-11-17', locale: 'en-US', callEndpoint } as never as ToolContext;
    return { tool, context, callEndpoint };
  }

  it('returns an overview with a handle instead of a cut result, and read_result never calls the backend', async () => {
    const { tool, context, callEndpoint } = tools('POST');
    const store = createResultStore();
    const overview = await toolToAiTool(tool, context, 'playlists_call', { resultStore: store }).execute({}) as Overview;
    expect(overview._result.id).toMatch(/^rw_/);
    expect(overview).not.toHaveProperty('_truncated');
    expect(store.isIssued(overview)).toBe(true);
    const reader = toolToAiTool(createReadResultTool(store), context, 'read_result', { resultStore: store });
    const read = await reader.execute({ resultId: overview._result.id, fields: ['data[].tracks'], limit: 1 }) as Record<string, unknown>;
    expect((read.data as unknown[])).toHaveLength(1);
    expect((read._result as { id: string }).id).toBe(overview._result.id);
    expect(store.isIssued(read)).toBe(true);
    expect(store.size).toBe(1);
    expect(callEndpoint).toHaveBeenCalledTimes(1);
  });

  it('leaves a result within the limit unchanged and cuts as before when the store refuses', async () => {
    const small = defineTool({ id: 'small', description: 'Small.', inputSchema: z.object({}), execute: async () => ({ ok: true }) });
    const store = createResultStore({ maxResults: 1 });
    expect(await toolToAiTool(small, {} as ToolContext, 'small', { resultStore: store }).execute({})).toEqual({ ok: true });
    const { tool, context } = tools('GET');
    const aiTool = toolToAiTool(tool, context, 'playlists_call', { resultStore: store });
    expect(await aiTool.execute({})).toHaveProperty('_result');
    const second = await aiTool.execute({}) as Record<string, unknown>;
    expect(second).not.toHaveProperty('_result');
    expect(second).toHaveProperty('_truncated');
    expect(store.isIssued(second)).toBe(false);
  });

  it('keeps PR F behaviour without a store', async () => {
    const { tool, context } = tools('GET');
    const result = await toolToAiTool(tool, context, 'playlists_call').execute({}) as Record<string, unknown>;
    expect(result).toHaveProperty('_truncated');
    expect(result).not.toHaveProperty('_result');
  });

  it('gives no handle to a failure or an array result', async () => {
    const store = createResultStore();
    const failing = defineTool({
      id: 'failing', description: 'Fails.', inputSchema: z.object({}),
      execute: async () => ({ success: false, error: 'e'.repeat(20_000) }),
    });
    await toolToAiTool(failing, {} as ToolContext, 'failing', { resultStore: store }).execute({});
    const array = defineTool({
      id: 'array', description: 'Array.', inputSchema: z.object({}),
      execute: async () => Array.from({ length: 50 }, () => 'a'.repeat(1_000)),
    });
    expect(await toolToAiTool(array, {} as ToolContext, 'array', { resultStore: store }).execute({})).toHaveProperty('_truncated');
    expect(store.size).toBe(0);
  });
});

describe('loop detection of a tool whose result has a handle', () => {
  it('ignores the random handle id, so the same call with the same result still repeats', async () => {
    const store = createResultStore();
    const value = playlists();
    const first = await store.put({ toolName: 'playlists_list', readOnly: true, maxChars: 16_000, value }) as Overview;
    const second = await store.put({ toolName: 'playlists_list', readOnly: true, maxChars: 16_000, value }) as Overview;
    expect(first._result.id).not.toBe(second._result.id);
    const fingerprint = (result: unknown) => createExecutionFingerprint({
      toolId: 'playlists.list', arguments: {}, result: toolResultForFingerprint(result),
    });
    expect(fingerprint(first)).toBe(fingerprint(second));
    const other = await store.put({ toolName: 'playlists_list', readOnly: true, maxChars: 16_000, value: playlists(19) });
    expect(fingerprint(other)).not.toBe(fingerprint(first));
  });
});

describe('read_result stays within the origin tool\'s limit', () => {
  it('bounds every answer, marker included (property-style)', async () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let checked = 0;
    const longKey = (index: number) => `k${index}${'K'.repeat(Math.floor(random() * 5_000))}`;
    for (let round = 0; round < 40; round += 1) {
      const value: Record<string, unknown> = { success: true };
      const arrays = 1 + Math.floor(random() * 6);
      const keys: string[] = [];
      for (let index = 0; index < arrays; index += 1) {
        const key = random() < 0.5 ? longKey(index) : `list${index}`;
        keys.push(key);
        value[key] = Array.from({ length: 1 + Math.floor(random() * 40) }, (_, entry) => ({
          id: entry, [longKey(entry)]: 'v'.repeat(Math.floor(random() * 3_000)),
        }));
      }
      const maxChars = 1_000 + Math.floor(random() * 20_000);
      if (JSON.stringify(value).length <= maxChars) continue;
      const store = createResultStore();
      const overview = await store.put({ toolName: 't', readOnly: true, maxChars, value }) as Overview | undefined;
      if (!overview) continue;
      const tool = createReadResultTool(store);
      const fieldLists: Array<string[] | undefined> = [
        undefined,
        keys.map((key) => `${key}[]`),
        Array.from({ length: 50 }, (_, index) => `${'u'.repeat(190)}${index}`),
        [...keys, ...Array.from({ length: 20 }, (_, index) => `missing${'m'.repeat(180)}${index}`)].slice(0, 50),
        keys.map((key) => `${key}[0]`),
        keys.map((key) => `${key}[1].id`),
        [`${keys[0]}[0]`, ...Array.from({ length: 12 }, (_, index) => `${keys[0]}[0].nope${index}`)],
      ];
      for (const fields of fieldLists) {
        for (const window of [{}, { offset: 3 }, { limit: 1 }, { offset: 1, limit: 1_000 }]) {
          const answer = await tool.execute({ resultId: overview._result.id, ...(fields ? { fields } : {}), ...window }, {} as ToolContext);
          expect(JSON.stringify(answer).length).toBeLessThanOrEqual(maxChars);
          // An incomplete answer always says so, with the offset to continue at.
          const marker = (answer as { _result?: ReadMarker })._result;
          if (marker?.nextOffset !== undefined) expect(marker.hint).toContain(`offset ${marker.nextOffset}`);
          const offset = (window as { offset?: number }).offset ?? 0;
          if (marker?.total !== undefined && offset + (marker.returned ?? 0) < marker.total) {
            expect(marker.hint).toMatch(/^Incomplete: /);
            const next = offset + Math.max(marker.returned ?? 0, 1);
            expect(marker.nextOffset).toBe(next < marker.total ? next : undefined);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('stays within the smallest limit with ten long unknown paths (regression)', async () => {
    const store = createResultStore();
    const value = { success: true, data: Array.from({ length: 30 }, (_, index) => ({ id: index, text: 't'.repeat(100) })) };
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 1_000, value }) as Overview;
    const answer = await createReadResultTool(store).execute({
      resultId: overview._result.id,
      fields: Array.from({ length: 10 }, (_, index) => `${'p'.repeat(190)}${index}`),
    }, {} as ToolContext);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(1_000);
  });

  it('bounds five arrays with 5,000-character keys at the default limit (regression)', async () => {
    const store = createResultStore();
    const value: Record<string, unknown> = {};
    for (let index = 0; index < 5; index += 1) {
      value[`${index}${'a'.repeat(5_000)}`] = Array.from({ length: 10 }, (_, entry) => ({ entry, text: 'x'.repeat(200) }));
    }
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value }) as Overview;
    const answer = await createReadResultTool(store).execute({ resultId: overview._result.id }, {} as ToolContext);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(16_000);
  });
});

describe('edge cases of stored results', () => {
  it('reads prototype-like keys as plain data and never touches prototypes', async () => {
    const store = createResultStore();
    const value = JSON.parse(`{"__proto__":{"polluted":true},"constructor":"c","data":${JSON.stringify(playlists().data)}}`) as Record<string, unknown>;
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value }) as Overview;
    expect(Object.prototype.hasOwnProperty.call(overview, '__proto__')).toBe(true);
    const answer = await createReadResultTool(store).execute({
      resultId: overview._result.id, fields: ['__proto__', 'constructor', 'toString', 'data[].__proto__', '__proto__.polluted'],
    }, {} as ToolContext) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(answer, '__proto__')).toBe(true);
    expect(answer.constructor).toBe('c');
    expect((answer._result as { unknownFields: unknown[] }).unknownFields).toEqual(['toString', 'data[].__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('creates no handle for a payload with its own _result', async () => {
    const store = createResultStore();
    const tool = defineTool({
      id: 'own', description: 'Own marker.', inputSchema: z.object({}),
      execute: async () => ({ ...playlists(), _result: { id: 'app-1', state: 'final' } }),
    });
    const result = await toolToAiTool(tool, {} as ToolContext, 'own', { resultStore: store }).execute({}) as Record<string, unknown>;
    expect(result._result).toEqual({ id: 'app-1', state: 'final' });
    expect(result).toHaveProperty('_truncated');
    expect(store.size).toBe(0);
  });

  it('strips only an SDK handle id from a fingerprint', () => {
    expect(toolResultForFingerprint({ a: 1, _result: { id: 'ro_abc12345', showing: 2 } })).toEqual({ a: 1, _result: { showing: 2 } });
    for (const id of ['app-1', 'ro_ABC12345', 'rw_abc', 'xx_abc12345']) {
      expect(toolResultForFingerprint({ a: 1, _result: { id } })).toEqual({ a: 1, _result: { id } });
    }
  });

  it('returns a result within the limit as the same object', async () => {
    const small = { ok: true, items: [1, 2, 3] };
    const tool = defineTool({ id: 'small', description: 'Small.', inputSchema: z.object({}), execute: async () => small });
    const store = createResultStore();
    expect(await toolToAiTool(tool, {} as ToolContext, 'small', { resultStore: store }).execute({})).toBe(small);
  });

  it.each([
    ['throws', () => { throw new Error('detector down'); }],
    ['rejects', async () => { throw new Error('detector down'); }],
  ])('keeps nothing when the seal %s; the result is cut as without a store', async (_label, seal) => {
    const store = createResultStore({ seal });
    const { tool, context } = (() => {
      const response: InternalApiResponse = { ok: true, status: 200, data: playlists() };
      return {
        tool: endpointToolToTool(defineEndpointTool({
          id: 'p.list', toolName: 'p_list', description: 'P.', method: 'GET', path: '/p', inputSchema: z.object({}).strict(),
        })),
        context: { currentDate: '2026-11-17', locale: 'en-US', callEndpoint: async () => response } as never as ToolContext,
      };
    })();
    const result = await toolToAiTool(tool, context, 'p_list', { resultStore: store }).execute({}) as Record<string, unknown>;
    expect(store.size).toBe(0);
    expect(result).toHaveProperty('_truncated');
    expect(result).not.toHaveProperty('_result');
    // Not issued: the PII shield wrapper shields it as any other result.
    expect(store.isIssued(result)).toBe(false);
  });
});

describe('read_result paging across several arrays', () => {
  const stored = () => ({
    warnings: ['note'],
    data: Array.from({ length: 20 }, (_, index) => ({ id: `d${index}`, text: 'x'.repeat(1_200) })),
    meta: { tags: Array.from({ length: 7 }, (_, index) => `tag${index}`) },
  });

  async function walk(fields: string[] | undefined, limit: number | undefined, maxChars = 16_000) {
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars, value: stored() }) as Overview;
    const tool = createReadResultTool(store);
    const seen = { warnings: [] as unknown[], data: [] as string[], tags: [] as unknown[] };
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const answer = await tool.execute({
        resultId: overview._result.id, offset, ...(fields ? { fields } : {}), ...(limit !== undefined ? { limit } : {}),
      }, {} as ToolContext) as Record<string, unknown> & { _result: { total: number; nextOffset?: number; returned: number } };
      expect(JSON.stringify(answer).length).toBeLessThanOrEqual(maxChars);
      expect(answer._result.total).toBe(20);
      seen.warnings.push(...((answer.warnings as unknown[] | undefined) ?? []));
      seen.data.push(...((answer.data as Array<{ id: string }> | undefined) ?? []).map((entry) => entry.id));
      seen.tags.push(...(((answer.meta as { tags?: unknown[] } | undefined)?.tags) ?? []));
      offset = answer._result.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(50);
    }
    return { seen, pages };
  }

  it.each([
    ['without fields, limit 1', undefined, 1],
    ['without fields, limit 3', undefined, 3],
    ['without fields or limit (bounded by size)', undefined, undefined],
    ['with fields, limit 1', ['warnings', 'data[].id', 'meta.tags'], 1],
    ['with fields, limit 4', ['data[].id', 'warnings', 'meta.tags'], 4],
  ] as const)('delivers every entry of every array exactly once (%s)', async (_label, fields, limit) => {
    const { seen } = await walk(fields as string[] | undefined, limit);
    expect(seen.data).toEqual(Array.from({ length: 20 }, (_, index) => `d${index}`));
    expect(seen.warnings).toEqual(['note']);
    expect(seen.tags).toEqual(Array.from({ length: 7 }, (_, index) => `tag${index}`));
  });

  it('reports the array with the most entries and every paged array', async () => {
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value: stored() }) as Overview;
    const answer = await createReadResultTool(store).execute({ resultId: overview._result.id, limit: 1 }, {} as ToolContext) as Record<string, unknown>;
    expect(answer._result).toMatchObject({
      returned: 1, total: 20, nextOffset: 1,
      arrays: { warnings: { returned: 1, total: 1 }, data: { returned: 1, total: 20 }, 'meta.tags': { returned: 1, total: 7 } },
    });
  });

  it('does not let a cut single entry read as the whole array', async () => {
    const store = createResultStore();
    const value = { data: Array.from({ length: 2 }, (_, index) => ({ id: index, body: 'b'.repeat(30_000) })) };
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value }) as Overview;
    const answer = await createReadResultTool(store).execute({ resultId: overview._result.id, fields: ['data[].body'] }, {} as ToolContext) as Record<string, unknown>;
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(16_000);
    expect(answer._result).toMatchObject({ returned: 1, total: 2, nextOffset: 1 });
    // `_truncated` says only what was cut; the entry counts are those of `_result`.
    expect(answer._truncated).toEqual({ compacted: ['data.0.body'] });
  });

  it('keeps unknownCount when the positions do not fit', async () => {
    const store = createResultStore();
    const value = { data: Array.from({ length: 2 }, (_, index) => ({ id: index, body: 'b'.repeat(30_000) })) };
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 1_000, value }) as Overview;
    const answer = await createReadResultTool(store).execute({
      resultId: overview._result.id, fields: ['data[].body', 'nope1', 'nope2'],
    }, {} as ToolContext) as Record<string, unknown>;
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(1_000);
    expect((answer._result as { unknownCount?: number }).unknownCount).toBe(2);
  });
});

describe('pilot feedback: incomplete answers say so', () => {
  async function setup(value: Record<string, unknown> = playlists(), maxChars = 16_000) {
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars, value }) as Overview;
    const tool = createReadResultTool(store);
    const read = (input: Record<string, unknown>) => tool.execute({ resultId: overview._result.id, ...input }, {} as ToolContext) as Promise<Record<string, unknown> & {
      _result: ReadMarker;
    }>;
    return { read, overview };
  }

  it('carries a hint with the range, the next offset and no statement about all entries', async () => {
    const { read } = await setup();
    const answer = await read({ fields: ['data[].name', 'data[].tracks'] });
    const { returned, nextOffset, hint } = answer._result;
    expect(nextOffset).toBe(returned);
    expect(hint).toBe(`Incomplete: entries 0 to ${returned! - 1} of 20 (total exact). Call read_result again with the same resultId `
      + `and fields and offset ${nextOffset}. Before the rest is read, say nothing about the content of all entries (which match, all, none, only).`);
    expect(size(answer)).toBeLessThanOrEqual(16_000);
  });

  it('carries no hint when the answer is complete', async () => {
    const { read } = await setup();
    const answer = await read({ fields: ['data[].name'] });
    expect(answer._result).toEqual({ id: answer._result.id, offset: 0, returned: 20, total: 20 });
    const last = await read({ fields: ['data[].tracks'], offset: 19 });
    expect(last._result.nextOffset).toBeUndefined();
    expect(last._result.hint).toBeUndefined();
  });

  it('keeps the hint and gives up entries when space is short', async () => {
    const { read } = await setup(playlists(20, 900), 1_000);
    const answer = await read({ fields: ['data[].tracks'] });
    expect(size(answer)).toBeLessThanOrEqual(1_000);
    expect(answer._result.hint).toContain('Incomplete');
    expect(answer._result.hint).toContain(`offset ${answer._result.nextOffset}`);
  });

  it('says that an entry was cut when not even one fits', async () => {
    const { read } = await setup(playlists(3, 40_000));
    const answer = await read({ fields: ['data[].tracks'] });
    expect(answer._result.hint).toBe('Incomplete: entries 0 to 0 of 3. Call read_result again with the same resultId and fields and offset 1. '
      + 'Entry 0 is shortened (see _truncated); it cannot be read in full.');
  });

  it('names unknown fields, says they do not exist and lists the nearest parent with its keys', async () => {
    const { read } = await setup();
    const answer = await read({ fields: ['data[].name', 'data[].owner.mail', 'data.name'], limit: 2 });
    expect(answer._result.unknownFields).toEqual(['data[].owner.mail', 'data.name']);
    expect(answer._result.parentKeys).toEqual({ 'data[].owner': ['name', 'bio'], 'data[]': ['id', 'name', 'owner', 'tracks'] });
    expect(answer._result.hint).toContain('2 requested fields do not exist in this result (unknownFields): do not infer them from other fields;'
      + ' say they are not known or pick a field from parentKeys.');
  });

  it('keeps the unknown-field hint when the details do not fit', async () => {
    const { read } = await setup(playlists(20, 900), 1_000);
    const answer = await read({ fields: ['data[].tracks', 'data[].nope'] });
    expect(size(answer)).toBeLessThanOrEqual(1_000);
    expect(answer._result.hint).toContain('A requested field does not exist in this result');
  });
});

describe('pilot feedback: unknown paths are echoed only in a safe normalized form', () => {
  it('never echoes a generated pseudonym, a long path or a name that is not an identifier', async () => {
    const generator = createFakeDataGenerator(42, 'de-DE');
    const categories = ['person', 'email', 'phone', 'iban', 'credit_card', 'cvv', 'card_expiry', 'address', 'date_of_birth',
      'tax_id', 'ssn', 'ip_address', 'url', 'custom'];
    const pseudonyms = Array.from({ length: 3 }, () => categories.map((category) => generator.generate(category))).flat();
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value: playlists() }) as Overview;
    const tool = createReadResultTool(store);
    for (const pseudonym of pseudonyms) {
      for (const field of [pseudonym, `data[].${pseudonym}`, `data[0].${pseudonym}`]) {
        const answer = await tool.execute({ resultId: overview._result.id, fields: ['data[].id', field] }, {} as ToolContext) as Record<string, unknown>;
        const text = JSON.stringify(answer);
        expect(text).not.toContain(pseudonym);
        if (!answer.error) expect((answer._result as ReadMarker).unknownFields).toEqual([2]);
      }
    }
    const long = `data[].${'a'.repeat(60)}.${'b'.repeat(60)}`;
    const answer = await tool.execute({ resultId: overview._result.id, fields: [long, 'data[].owner.nickName'] }, {} as ToolContext) as Record<string, unknown>;
    expect(answer).toMatchObject({ error: 'unknown_fields', unknownFields: [1, 'data[].owner.nickName'] });
  });
});

describe('pilot feedback: one entry by index', () => {
  const lists = () => ({
    data: Array.from({ length: 20 }, (_, index) => ({
      id: `p${index}`, name: `List ${index}`, items: Array.from({ length: 10 + index }, (_, item) => ({ n: item, title: `t${index}-${item}`, body: 'x'.repeat(400) })),
    })),
    meta: { page: 1 },
  });

  async function setup(maxChars = 16_000) {
    const store = createResultStore();
    const overview = await store.put({ toolName: 'playlists_list', readOnly: true, maxChars, value: lists() }) as Overview;
    const tool = createReadResultTool(store);
    const read = (input: Record<string, unknown>) => tool.execute({ resultId: overview._result.id, ...input }, {} as ToolContext) as Promise<Record<string, unknown> & {
      _result: ReadMarker;
    }>;
    return { read };
  }

  it('projects an element keyed by its index and pages the arrays inside it', () => {
    const projection = projectResult(lists(), [parseResultPath('data[3].items')!], { offset: 2, limit: 2 });
    expect(projection.value).toEqual({ data: { 3: { items: lists().data[3]!.items.slice(2, 4) } } });
    expect(projection.slices).toEqual([{ path: 'data[3].items', total: 13, returned: 2 }]);
    expect(projectResult(lists(), [parseResultPath('data[3].name')!, parseResultPath('data[1].name')!], { offset: 0 }).value)
      .toEqual({ data: { 1: { name: 'List 1' }, 3: { name: 'List 3' } } });
  });

  it('reads the items of one playlist with offset and limit', async () => {
    const { read } = await setup();
    const answer = await read({ fields: ['data[0].items'], limit: 4, offset: 4 });
    expect((answer.data as Record<string, { items: Array<{ n: number }> }>)['0']!.items.map((item) => item.n)).toEqual([4, 5, 6, 7]);
    expect(answer._result).toMatchObject({ offset: 4, returned: 4, total: 10, nextOffset: 8 });
    const entry = await read({ fields: ['data[3]'], limit: 1 });
    expect((entry.data as Record<string, { name: string; items: unknown[] }>)['3']).toMatchObject({ name: 'List 3', items: [lists().data[3]!.items[0]] });
    expect(entry._result).toMatchObject({ returned: 1, total: 13, nextOffset: 1 });
    const nested = await read({ fields: ['data[3].items[2].title'] });
    // An indexed entry carries its identity fields too; nested arrays do not.
    expect(nested.data).toEqual({ 3: { id: 'p3', name: 'List 3', items: { 2: { title: 't3-2' } } } });
    expect(Object.keys((answer.data as Record<string, object>)['0']!)).toEqual(['id', 'name', 'items']);
    expect(nested._result).toEqual({ id: nested._result.id, offset: 0 });
  });

  it.each([1, 3, 7, undefined])('delivers every item of one entry exactly once (limit %s)', async (limit) => {
    const { read } = await setup(4_000);
    const seen: number[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const answer = await read({ fields: ['data[5].items[].n', 'data[5].name'], offset, ...(limit !== undefined ? { limit } : {}) });
      expect(size(answer)).toBeLessThanOrEqual(4_000);
      expect(answer._result.total).toBe(15);
      seen.push(...(answer.data as Record<string, { items: Array<{ n: number }> }>)['5']!.items.map((item) => item.n));
      if (answer._result.nextOffset !== undefined) expect(answer._result.hint).toContain(`offset ${answer._result.nextOffset}`);
      offset = answer._result.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(40);
    }
    expect(seen).toEqual(Array.from({ length: 15 }, (_, index) => index));
  });

  it('answers an index beyond the array with the valid range', async () => {
    const { read } = await setup();
    expect(await read({ fields: ['meta', 'data[20].items'] })).toEqual({
      error: 'index_out_of_range',
      hint: 'Field path number 2 (data) selects entry 20, but the array there has 20 entries: use an index from 0 to 19.',
    });
    expect((await read({ fields: ['data[].items[40]'] })).hint)
      .toBe('Field path number 1 (data[].items) selects entry 40, but the array there has at most 29 entries: use an index from 0 to 28.');
  });

  it('refuses every entry and single entries of the same array in one call', async () => {
    const { read } = await setup();
    const mixed = await read({ fields: ['data[].name', 'meta', 'data[0].items'] });
    expect(mixed.error).toBe('invalid_fields');
    expect(mixed.hint).toContain('Field paths number 1, 3 select both every entry ("[]") and single entries ("[2]") of the same array');
    expect(mixedArraySelections(['data[].items[0]', 'data[].items[]', 'data[1]', 'meta.tags[0]'].map((text) => parseResultPath(text)!)))
      .toEqual([1, 2, 3]);
    // Single entries of different arrays, or several single entries of one, combine.
    const several = await read({ fields: ['data[0].name', 'data[2].name'] });
    expect(several.data).toEqual({ 0: { id: 'p0', name: 'List 0' }, 2: { id: 'p2', name: 'List 2' } });
  });

  it('names the accepted forms and offset/limit for an invalid path', async () => {
    const { read } = await setup();
    const invalid = await read({ fields: ['data[x].name'] });
    expect(invalid).toEqual({
      error: 'invalid_fields',
      hint: 'Field path(s) number 1 are not valid. Accepted forms: "data[].name" (a field of every entry), "data[2].items" (one entry, '
        + 'index from 0) and "meta" (a field); join field names with ".". Page through entries with offset and limit.',
    });
  });

  it('mentions the index form in the tool description and the overview hint', async () => {
    expect(createReadResultTool(createResultStore()).description).toContain('"[2]" one element, returned keyed by its index: "data[2].items"');
    const overview = buildResultOverview(lists(), { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(overview._result.hint).toContain('"[2]" one');
  });
});

describe('pilot feedback: the overview keeps short labels and drops opaque ids first', () => {
  const uuid = (seed: number) => {
    const hex = (value: number) => ((value * 2_654_435_761) >>> 0).toString(16).padStart(8, '0');
    const text = `${hex(seed + 1)}${hex(seed + 2)}${hex(seed + 3)}${hex(seed + 4)}`;
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-a${text.slice(17, 20)}-${text.slice(20, 32)}`;
  };
  const variants = (seed: number, count: number) => Array.from({ length: count }, (_, index) => ({
    id: uuid(seed * 100 + index), label: `Variant ${index}`, spec: 'v'.repeat(150),
  }));
  /** 45 designs shaped like the pilot's list_designs (~100k characters). */
  const designs = () => ({
    success: true,
    data: Array.from({ length: 45 }, (_, index) => ({
      id: uuid(index),
      name: `Design ${index}`,
      approvalStatus: ['approved', 'pending', 'rejected'][index % 3],
      reviewState: ['open', 'in_review', 'done'][index % 3],
      contentType: ['image', 'video', 'carousel'][index % 3],
      hasDraftChanges: index % 2 === 0,
      isDraft: index % 5 === 0,
      brandKitId: uuid(1_000 + index),
      tenantId: uuid(2_000),
      folderId: uuid(3_000 + (index % 7)),
      createdAt: `2026-0${1 + (index % 9)}-1${index % 10}T08:${10 + index}:00.000Z`,
      updatedAt: `2026-1${index % 3}-0${1 + (index % 9)}T17:${10 + index}:00.000Z`,
      thumbnailUrl: `https://cdn.example.com/thumbs/${uuid(5_000 + index)}.png`,
      draftVersion: { variants: variants(index, 5) },
      publishedVersion: index % 4 === 0 ? null : { variants: variants(index + 50, 4) },
      folder: { id: uuid(3_000 + (index % 7)), url: `https://cdn.example.com/folders/${uuid(index)}` },
    })),
  });

  it('keeps the enum and boolean fields of all 45 entries within 16,000 characters and drops the UUID foreign keys first', () => {
    const value = designs();
    expect(size(value)).toBeGreaterThan(95_000);
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(16_000);
    const data = overview.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(45);
    for (const [index, entry] of data.entries()) {
      expect(entry).toMatchObject({
        id: value.data[index]!.id, name: `Design ${index}`, approvalStatus: value.data[index]!.approvalStatus,
        reviewState: value.data[index]!.reviewState, contentType: value.data[index]!.contentType,
        hasDraftChanges: index % 2 === 0, isDraft: index % 5 === 0,
      });
      for (const key of ['brandKitId', 'tenantId', 'folderId', 'thumbnailUrl', 'draftVersion']) expect(entry).not.toHaveProperty(key);
      // No empty shells: an object whose fields were all left out is gone; null stays null.
      if (index % 4 === 0) expect(entry.publishedVersion).toBeNull();
      else expect(entry).not.toHaveProperty('publishedVersion');
    }
    expect(JSON.stringify(overview)).not.toContain('{}');
    const omitted = overview._result.omitted!.map((entry) => entry.path);
    expect(omitted).toEqual(expect.arrayContaining([
      'data[].draftVersion', 'data[].publishedVersion.variants', 'data[].brandKitId', 'data[].tenantId', 'data[].folderId',
    ]));
    // Opaque values (foreign keys, URLs, nested arrays) went before dates and labels.
    expect(omitted.every((path) => /draftVersion|variants|Id$|Url$|url$/.test(path))).toBe(true);
    expect(omitted.some((path) => /approvalStatus|reviewState|contentType|hasDraftChanges|isDraft/.test(path))).toBe(false);
    expect(overview._result.hint).toContain('Do not infer missing fields from other fields; read them or say they are not known.');
  });

  it('drops foreign keys and URLs before dates and labels when only a little has to go', () => {
    const value = designs();
    const small = { data: value.data.map(({ draftVersion: _d, publishedVersion: _p, folder: _f, ...rest }) => rest) };
    const overview = buildResultOverview(small, { id: 'ro_abcdefgh', maxChars: size(small) - 6_000, readOnly: true }) as Overview;
    const omitted = overview._result.omitted!.map((entry) => entry.path);
    expect(omitted).toEqual(expect.arrayContaining(['data[].thumbnailUrl', 'data[].brandKitId']));
    for (const path of omitted) expect(['data[].brandKitId', 'data[].tenantId', 'data[].folderId', 'data[].thumbnailUrl']).toContain(path);
  });

  it('removes shells, keeps an object that was empty, and its omitted paths stay readable with read_result', async () => {
    const value = {
      data: Array.from({ length: 30 }, (_, index) => ({
        id: index, status: index % 2 ? 'on' : 'off', extra: index === 0 ? {} : { blob: 'b'.repeat(600), ref: uuid(index) },
      })),
    };
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 2_000, value }) as Overview;
    const data = overview.data as Array<Record<string, unknown>>;
    expect(data[0]!.extra).toEqual({});
    expect(data[1]).toEqual({ id: 1, status: 'on' });
    // `data[].extra` itself stays (entry 0 shows it), so its left-out fields are listed one by one.
    expect(overview._result.omitted?.map((entry) => entry.path)).toEqual(['data[].extra.blob', 'data[].extra.ref']);
    const read = await createReadResultTool(store).execute({ resultId: overview._result.id, fields: overview._result.omitted!.map((entry) => entry.path), limit: 2 }, {} as ToolContext) as Record<string, unknown>;
    expect(read.data).toEqual([{ id: 0 }, { id: 1, extra: value.data[1]!.extra }]);
    // Without the empty one, the parent is listed once.
    const whole = buildResultOverview({ data: value.data.slice(1) }, { id: 'ro_abcdefgh', maxChars: 2_000, readOnly: true }) as Overview;
    expect(whole._result.omitted).toEqual([{ path: 'data[].extra', approxChars: expect.any(Number), keys: ['blob', 'ref'] }]);
    expect((whole.data as Array<Record<string, unknown>>)[0]).toEqual({ id: 1, status: 'on' });
  });

  it('ranks numeric foreign keys and URLs below short labels, by their values', () => {
    const value = {
      items: Array.from({ length: 40 }, (_, index) => ({
        id: index, kind: ['a', 'b'][index % 2], ownerId: 100_000 + index, link: `https://x.example/${index}`, score: index / 3,
      })),
    };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: size(value) - 1_200, readOnly: true }) as Overview;
    expect(Object.keys((overview.items as Array<Record<string, unknown>>)[1]!)).toEqual(['id', 'kind', 'score']);
    expect(overview._result.omitted!.map((entry) => entry.path)).toEqual(['items[].link', 'items[].ownerId']);
  });
});

describe('second pilot run: an entry\'s own labels outrank nested scalars, left-out parents name their keys', () => {
  const uuid = (index: number) => `0b9d5c1e-7a3f-4c2b-9e1d-${String(index).padStart(12, '0')}`;
  const body = 'v'.repeat(700);
  const states = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'NOT_REQUESTED'];
  /** 45 designs (~102k characters) whose longest enum is the largest field of the last class. */
  const designs = (pad: number) => ({
    data: Array.from({ length: 45 }, (_, index) => ({
      id: uuid(index), name: `Design number ${index} for the autumn campaign`, approvalStatus: states[index % 4]!,
      reviewState: ['OPEN', 'DONE'][index % 2]!, contentType: ['IMAGE', 'VIDEO'][index % 2]!, isDraft: index % 2 === 0,
      hasDraftChanges: index % 3 === 0, draftRevision: index % 7, brandKitId: uuid(index + 100), tenantId: uuid(1),
      folderId: uuid(index % 5), createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z',
      description: 'd'.repeat(pad), width: 1920, height: 1080, durationMs: 15_000, sortOrder: index, version: 3,
      publishedVersion: { versionNumber: index % 4, status: 'LIVE', publishedAt: '2026-10-05T10:00:00.000Z', variants: [{ label: 'a', body }] },
      draftVersion: { versionNumber: 1 + (index % 4), variants: [{ label: 'a', body }] },
    })),
  });

  it.each([0, 40, 130])('keeps the own status, type and flag fields of all 45 entries at 16,000 (description %i)', (pad) => {
    const value = designs(pad);
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(16_000);
    const data = overview.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(45);
    for (const [index, entry] of data.entries()) {
      const { approvalStatus, reviewState, contentType, isDraft, hasDraftChanges } = value.data[index]!;
      expect(entry).toMatchObject({ approvalStatus, reviewState, contentType, isDraft, hasDraftChanges });
    }
    const omitted = overview._result.omitted!.map((entry) => entry.path);
    for (const key of ['approvalStatus', 'reviewState', 'contentType', 'isDraft', 'hasDraftChanges']) expect(omitted).not.toContain(`data[].${key}`);
  });

  /** 30 entries whose `extra` is always left out whole; its child keys differ in size. */
  const keyed = () => ({
    data: Array.from({ length: 30 }, (_, index) => ({
      id: index,
      extra: {
        ...Object.fromEntries(Array.from({ length: 10 }, (_, key) => [`k${key}`, 'x'.repeat(10 * (key + 1))])),
        'a.b': 'y'.repeat(500), ['l'.repeat(65)]: 'z'.repeat(400),
      },
    })),
  });

  it('names up to eight selectable child keys of a left-out parent, largest first, and counts the others', () => {
    const overview = buildResultOverview(keyed(), { id: 'ro_abcdefgh', maxChars: 2_000, readOnly: true }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(2_000);
    expect(overview._result.omitted).toEqual([{
      path: 'data[].extra', approxChars: expect.any(Number), keys: ['k9', 'k8', 'k7', 'k6', 'k5', 'k4', 'k3', 'k2'], keysMore: 4,
    }]);
    expect(overview._result.hint).toContain('fields as in omitted (path or path.key)');
  });

  it('gives up keys before any field when space is short', () => {
    const value = designs(0);
    const keyedOverview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }) as Overview;
    const parents = keyedOverview._result.omitted!.filter((entry) => entry.keys);
    expect(parents.map((entry) => [entry.path, entry.keys])).toEqual([
      ['data[].publishedVersion', ['variants', 'publishedAt', 'versionNumber', 'status']],
      ['data[].draftVersion', ['variants', 'versionNumber']],
    ]);
    // The same overview without keys: exactly as large as a limit that leaves no room for them.
    const bare = JSON.parse(JSON.stringify(keyedOverview)) as Overview;
    for (const entry of bare._result.omitted!) {
      delete entry.keys;
      delete entry.keysMore;
    }
    bare._result.hint = bare._result.hint.replace(' (path or path.key)', '');
    const tight = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: size(bare), readOnly: true }) as Overview;
    expect(tight).toEqual(bare);
  });
});

describe('review round: guarantees of every answer', () => {
  const handleOf = (value: Record<string, unknown>, maxChars: number) => ({
    id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars, value,
  }) as ResultHandle;
  const readDirect = (value: Record<string, unknown>, maxChars: number, input: Omit<ReadResultInput, 'resultId'>) => readResultHandle(
    handleOf(value, maxChars), { resultId: 'ro_abcdefgh', ...input }, input.fields?.map((field) => parseResultPath(field)!),
  ) as Record<string, unknown> & { _result?: ReadMarker };

  /** G1 and G2 for one answer: within the limit; incomplete says so; nextOffset iff entries remain past it. */
  const expectBoundedAndHonest = (answer: Record<string, unknown>, maxChars: number, offset: number) => {
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(maxChars);
    const marker = answer._result as ReadMarker | undefined;
    if (!marker || marker.total === undefined || offset >= marker.total) return;
    const returned = marker.returned ?? 0;
    const next = offset + Math.max(returned, 1);
    expect(marker.nextOffset).toBe(next < marker.total ? next : undefined);
    if (offset + returned < marker.total || answer._truncated !== undefined) expect(marker.hint).toMatch(/^Incomplete: /);
    if (marker.nextOffset !== undefined) expect(marker.hint).toContain(`offset ${marker.nextOffset}`);
  };

  it.each([[60, 60], [99, 99]])('keeps one cut entry with returned, nextOffset and an incomplete hint (route %i.%i, regression)', (left, right) => {
    const a = 'a'.repeat(left);
    const b = 'b'.repeat(right);
    const value = { [a]: { [b]: Array.from({ length: 40 }, (_, index) => ({ id: index, body: 'x'.repeat(3_000), note: 'y'.repeat(1_000) })) } };
    const answer = readDirect(value, 1_000, { fields: [`${a}.${b}`], offset: 5 });
    expect((answer[a] as Record<string, unknown[]>)[b]).toHaveLength(1);
    expect(answer._result).toMatchObject({ returned: 1, total: 40, nextOffset: 6 });
    expect(answer._result!.hint).toContain('Entry 5 is shortened (see _truncated); for more, read a narrower path below it.');
    expectBoundedAndHonest(answer, 1_000, 5);
  });

  it('answers an entry that does not fit even shortened with returned 0, nextOffset and an incomplete hint', () => {
    const entry = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`${'k'.repeat(100)}${index}`, index]));
    const value = { data: Array.from({ length: 10 }, () => entry) };
    const answer = readDirect(value, 1_000, { offset: 4 });
    expect(answer).not.toHaveProperty('data');
    expect(answer._result).toMatchObject({ returned: 0, total: 10, nextOffset: 5 });
    expect(answer._result!.hint).toBe('Incomplete: entry 4 of 10 does not fit the size limit even shortened; select fewer or narrower fields. '
      + 'Next entries: offset 5.');
    const last = readDirect(value, 1_000, { offset: 9 });
    expect(last._result).toMatchObject({ returned: 0, total: 10 });
    expect(last._result).not.toHaveProperty('nextOffset');
    expect(last._result!.hint).toMatch(/^Incomplete: entry 9 of 10 /);
  });

  it('says so in every incomplete answer at 1,000, 2,000 and 16,000 characters with long routes (property-style)', () => {
    let seed = 5;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let checked = 0;
    for (const maxChars of [1_000, 2_000, 16_000]) {
      for (const half of [1, 40, 70, 95]) {
        const a = 'a'.repeat(half);
        const b = 'b'.repeat(half);
        const count = 1 + Math.floor(random() * 40);
        const entries = Array.from({ length: count }, (_, index) => ({
          id: index, body: 'x'.repeat(Math.floor(random() * maxChars * 1.5)), note: 'y'.repeat(Math.floor(random() * 400)),
          nested: { deep: 'z'.repeat(Math.floor(random() * maxChars)), tags: ['t1', 't2'] },
        }));
        const value = { [a]: { [b]: entries }, meta: { note: 'm'.repeat(Math.floor(random() * 300)) } };
        const route = `${a}.${b}`;
        const fieldLists: Array<string[] | undefined> = [
          undefined, [route], [`${route}[].body`], [`${route}[].body`, `${route}[].note`], [`${route}[].nested`, 'meta', `${route}[].nope`],
        ];
        for (const fields of fieldLists) {
          for (const offset of [0, 3, count - 1]) {
            for (const limit of [undefined, 1, 7]) {
              const answer = readDirect(value, maxChars, { ...(fields ? { fields } : {}), offset, ...(limit ? { limit } : {}) });
              expectBoundedAndHonest(answer, maxChars, offset);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('has one instruction in a cut answer, worded for what was selected', () => {
    const value = { data: Array.from({ length: 3 }, (_, index) => ({ id: index, body: 'b'.repeat(3_000), note: 'n'.repeat(3_000) })) };
    const several = readDirect(value, 1_000, { fields: ['data[].body', 'data[].note'] });
    expect(several._truncated).not.toHaveProperty('hint');
    expect(several._result!.hint).toContain('Entry 0 is shortened (see _truncated); for more, select fewer fields.');
    expect(readDirect(value, 1_000, { fields: ['data'] })._result!.hint).toContain('for more, read a narrower path below it.');
    expect(readDirect(value, 1_000, { fields: ['data[].body'] })._result!.hint).toContain('it cannot be read in full.');
  });
});

describe('review round: a read that reads nothing is an error', () => {
  it('answers unknown_fields when no requested field exists, with the details that fit', async () => {
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value: playlists() }) as Overview;
    const tool = createReadResultTool(store);
    const answer = await tool.execute({ resultId: overview._result.id, fields: ['data[].nope', 'data[].x123'] }, {} as ToolContext);
    expect(answer).toEqual({
      error: 'unknown_fields',
      unknownFields: ['data[].nope', 2],
      parentKeys: { 'data[]': ['id', 'name', 'owner', 'tracks'] },
      hint: 'None of the requested fields exist in this result (unknownFields): do not infer them from other fields; '
        + 'say they are not known or pick a field from parentKeys. A number in unknownFields is a position in fields.',
    });
    // Within the smallest limit: the details give way, the count stays.
    const small = readResultHandle(
      { id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars: 1_000, value: playlists() } as ResultHandle,
      { resultId: 'ro_abcdefgh' },
      Array.from({ length: 12 }, (_, index) => parseResultPath(`data[].${'p'.repeat(61)}${index + 10}.${'q'.repeat(48)}`)!),
    );
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(1_000);
    expect(small).toMatchObject({ error: 'unknown_fields', unknownCount: 12 });
    expect(small.hint).toBe('None of the requested fields exist in this result (unknownCount): do not infer them from other fields; say they are not known.');
  });
});

describe('review round: no answer is a rehydration oracle', () => {
  const categories = ['person', 'email', 'phone', 'iban', 'credit_card', 'cvv', 'card_expiry', 'address', 'date_of_birth',
    'tax_id', 'ssn', 'ip_address', 'url', 'custom'] as const;
  /** One original per category; none contains another. */
  const originals: Record<(typeof categories)[number], string> = {
    person: 'Erika Mustermann', email: 'erika@corp.example', phone: '+49 30 7654321', iban: 'DE89 3704 0044 0532 0130 00',
    credit_card: '4111 1111 1111 1111', cvv: '424', card_expiry: '12/29', address: 'Hauptstr. 5, 10115 Berlin',
    date_of_birth: '01.02.1980', tax_id: '98765432109', ssn: '123456789012', ip_address: '192.168.1.20',
    url: 'https://corp.example/a', custom: 'SECRET-XYZ',
  };
  const detector: PiiDetector = {
    detect(text) {
      const found: PiiEntity[] = [];
      for (const category of categories) {
        const original = originals[category];
        for (let start = text.indexOf(original); start >= 0; start = text.indexOf(original, start + 1)) {
          found.push({ type: category, start, end: start + original.length, score: 1, text: original });
        }
      }
      return found;
    },
  };

  it.each(['de-DE', 'en-US'])('echoes no pseudonym of any built-in generator, so inbound changes nothing (%s)', async (locale) => {
    const shield = createPiiShield({ locale, detector });
    const value = {
      data: Array.from({ length: 20 }, (_, index) => ({ id: index, ...(index === 0 ? { pii: originals } : {}), pad: 'p'.repeat(50) })),
    };
    const sealed = await shield.anonymizeResult(value, 's1') as { data: Array<Record<string, unknown>> };
    const pseudonyms = categories.map((category) => (sealed.data[0]!.pii as Record<string, string>)[category]!);
    pseudonyms.forEach((pseudonym, index) => expect(pseudonym).not.toBe(originals[categories[index]!]));
    // Keys that embed pseudonyms, for parentKeys.
    const withKeys = {
      data: sealed.data.map((entry, index) => (index === 0
        ? { ...entry, ...Object.fromEntries(pseudonyms.flatMap((pseudonym) => [[`k${pseudonym}`, 1], [`${pseudonym}_k`, 2]])) }
        : entry)),
    };
    const handle = { id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars: 16_000, value: withKeys } as ResultHandle;
    let reportedByName = 0;
    for (const pseudonym of pseudonyms) {
      for (const field of [`x${pseudonym}`, `${pseudonym}_y`, `x${pseudonym}y`]) {
        for (const fields of [[field], ['data[].id', `data[].${field}`], [`data[0].${field}`, 'data[].nope'], [`data[].${field}.deeper`]]) {
          const parsed = fields.map((text) => parseResultPath(text));
          // An unparsable path is refused by the tool before any read, without echo.
          if (parsed.some((path) => !path)) continue;
          const answer = readResultHandle(handle, { resultId: handle.id, fields }, parsed as ParsedPath[]);
          const text = JSON.stringify(answer);
          expect(text).not.toContain(pseudonym);
          expect(shield.inbound(text, 's1')).toBe(text);
          const listed = (answer.unknownFields ?? (answer._result as ReadMarker | undefined)?.unknownFields ?? []) as unknown[];
          reportedByName += listed.filter((entry) => typeof entry === 'string' && entry.includes(field)).length;
        }
      }
    }
    // Names without a three-digit run (e.g. a person's name with its space) never parse to an echoable key anyway.
    expect(reportedByName).toBe(0);
    // The keys of a parent are filtered the same way.
    const parents = readResultHandle(handle, { resultId: handle.id, fields: ['data[].id', 'data[].nope'] }, ['data[].id', 'data[].nope'].map((text) => parseResultPath(text)!));
    expect((parents._result as ReadMarker).parentKeys).toEqual({ 'data[]': ['id', 'pii', 'pad'] });
    expect(shield.inbound(JSON.stringify(parents), 's1')).toBe(JSON.stringify(parents));
  });

  it('echoes an identifier with at most two digits in a row, but not one with three', async () => {
    const store = createResultStore();
    const overview = await store.put({ toolName: 't', readOnly: true, maxChars: 16_000, value: playlists() }) as Overview;
    const answer = await createReadResultTool(store).execute({
      resultId: overview._result.id, fields: ['data[].id', 'data[].x12y34', 'data[].x123', 'data[].a.b999'],
    }, {} as ToolContext) as { _result: ReadMarker };
    expect(answer._result.unknownFields).toEqual(['data[].x12y34', 3, 4]);
    expect(answer._result.hint).toContain('A number in unknownFields is a position in fields.');
  });
});

describe('review round: every listed omitted path reads exactly the left-out data', () => {
  /** What a path selects, built independently of projectResult: entries it does not reach stay as {}. */
  const select = (value: unknown, steps: ReadonlyArray<PathStep>): unknown => {
    if (steps.length === 0) return value;
    const [step, ...rest] = steps;
    if (step!.kind === 'each') {
      if (!Array.isArray(value)) return undefined;
      const entries = value.map((entry) => select(entry, rest));
      return entries.every((entry) => entry === undefined) && entries.length > 0 ? undefined : entries.map((entry) => entry ?? {});
    }
    if (step!.kind !== 'key' || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, step!.key)) return undefined;
    const inner = select((value as Record<string, unknown>)[step!.key], rest);
    return inner === undefined ? undefined : { [step!.key]: inner };
  };
  /**
   * The identity fields read_result adds: for a path that reads below the
   * entries of its outermost array, each entry's `identityFieldsOf` that the
   * path does not select itself and the entry does not already show.
   */
  const withIdentity = (expected: unknown, value: unknown, steps: ReadonlyArray<PathStep>): unknown => {
    const at = steps.findIndex((step) => step.kind !== 'key');
    if (at < 0 || at === steps.length - 1 || steps[at]!.kind !== 'each') return expected;
    const route = steps.slice(0, at).map((step) => (step as { key: string }).key);
    const selected = at + 2 === steps.length && steps[at + 1]!.kind === 'key' ? (steps[at + 1] as { key: string }).key : undefined;
    const copy = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    let holder: Record<string, unknown> = copy;
    let original = value as Record<string, unknown>;
    for (const key of route.slice(0, -1)) {
      holder = holder[key] as Record<string, unknown>;
      original = original[key] as Record<string, unknown>;
    }
    const last = route[route.length - 1]!;
    const entries = original[last] as Array<Record<string, unknown>>;
    holder[last] = (holder[last] as Array<Record<string, unknown>>).map((entry, index) => {
      const own = entries[index];
      if (typeof own !== 'object' || own === null || Array.isArray(own)) return entry;
      const added = identityFieldsOf(own).filter(([key]) => key !== selected && !(key in entry));
      return { ...Object.fromEntries(added), ...entry };
    });
    return copy;
  };
  /** Pages joined: arrays concatenated, objects merged. */
  const merge = (left: unknown, right: unknown): unknown => {
    if (left === undefined) return right;
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
    if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
      const output: Record<string, unknown> = { ...(left as Record<string, unknown>) };
      for (const [key, inner] of Object.entries(right as Record<string, unknown>)) output[key] = merge(output[key], inner);
      return output;
    }
    return right;
  };

  const shapes = (): Array<Record<string, unknown>> => [
    {
      data: Array.from({ length: 30 }, (_, index) => ({
        id: index, 'a.b': 'x'.repeat(200), 'c[0]': 'y'.repeat(200), '': 'z'.repeat(200), ['k'.repeat(130)]: 'w'.repeat(200),
        c: ['first', 'second'], owner: { name: `Owner ${index}`, bio: 'b'.repeat(150), links: { site: `https://x.example/${index}` } },
        status: index % 2 ? 'open' : 'done',
      })),
      meta: { info: { a: 'q'.repeat(300), b: 'r'.repeat(300) }, tags: Array.from({ length: 12 }, (_, index) => `tag-${index}`) },
    },
    { report: { sections: Array.from({ length: 8 }, (_, index) => ({ title: `S${index}`, body: 'b'.repeat(400), notes: { text: 'n'.repeat(200) } })) }, extra: 'e'.repeat(900) },
    { title: 'Report', body: 'r'.repeat(1_500), appendix: { notes: 'n'.repeat(1_200), author: 'A', 'odd key': 'o'.repeat(400) } },
    { items: Array.from({ length: 30 }, (_, index) => ({ id: index, more: { body: 'b'.repeat(400), note: { text: `n${index}`.repeat(150) } } })) },
  ];

  it.each([2_000, 4_000, 8_000])('round-trips page by page at %i characters, and never lists an unselectable key', async (maxChars) => {
    let listedPaths = 0;
    let keyPaths = 0;
    for (const value of shapes()) {
      if (JSON.stringify(value).length <= maxChars) continue;
      const store = createResultStore();
      const overview = await store.put({ toolName: 't', readOnly: true, maxChars, value }) as Overview;
      const tool = createReadResultTool(store);
      const roundTrip = async (path: string) => {
        const parsed = parseResultPath(path)!;
        expect(formatResultPath(parsed.steps)).toBe(path);
        let joined: unknown;
        let offset: number | undefined = 0;
        for (let pages = 0; offset !== undefined; pages += 1) {
          expect(pages).toBeLessThan(100);
          const answer = await tool.execute({ resultId: overview._result.id, fields: [path], offset }, {} as ToolContext) as Record<string, unknown>;
          expect(answer).not.toHaveProperty('error');
          expect(answer).not.toHaveProperty('_truncated');
          const { _result: marker, ...data } = answer as { _result: ReadMarker };
          joined = merge(joined, data);
          offset = marker.nextOffset;
        }
        expect(joined).toEqual(withIdentity(select(value, parsed.steps), value, parsed.steps));
      };
      for (const { path, keys } of overview._result.omitted ?? []) {
        await roundTrip(path);
        listedPaths += 1;
        // Every key named inside a left-out parent reads exactly that child as `path.key`.
        for (const key of keys ?? []) {
          await roundTrip(`${path}.${key}`);
          keyPaths += 1;
        }
      }
      const listed = (overview._result.omitted ?? []).map((entry) => [entry.path, ...(entry.keys ?? [])].join(' ')).join(' ');
      for (const odd of ['a.b', 'c[0]', 'kkkk', '[].)', 'odd key']) expect(listed).not.toContain(odd);
    }
    expect(listedPaths).toBeGreaterThan(0);
    expect(keyPaths).toBeGreaterThan(0);
  });

  it('counts fields a path cannot name in omittedMore and says how to read them', () => {
    const value = shapes()[0]!;
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 2_000, readOnly: true }) as Overview;
    const listed = overview._result.omitted!.map((entry) => entry.path);
    expect(listed).not.toContain('data[].c[0]');
    expect(listed.every((path) => isSelectablePath(parseResultPath(path)!.steps, 120))).toBe(true);
    expect(overview._result.omittedMore).toBeGreaterThanOrEqual(4);
    expect(overview._result.hint).toContain('Fields with unusual key names are only counted (omittedMore); read them with their parent.');
  });
});

describe('review round: details no other test pins', () => {
  const handleOf = (value: Record<string, unknown>, maxChars = 16_000) => ({
    id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars, value,
  }) as ResultHandle;
  const read = (value: Record<string, unknown>, fields: string[], maxChars = 16_000) => readResultHandle(
    handleOf(value, maxChars), { resultId: 'ro_abcdefgh', fields }, fields.map((field) => parseResultPath(field)!),
  ) as Record<string, unknown> & { _result: ReadMarker };

  it('lists at most twelve keys of at most three parents', () => {
    const keys = (prefix: string) => Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`${prefix}${String.fromCharCode(97 + index)}`, index]));
    const value = { data: [keys('d')], meta: keys('m'), info: keys('i'), extra: keys('e') };
    const answer = read(value, ['data[].da', 'data[].nope', 'meta.nope', 'info.nope', 'extra.nope']);
    expect(Object.keys(answer._result.parentKeys!)).toEqual(['data[]', 'meta', 'info']);
    for (const listed of Object.values(answer._result.parentKeys!)) expect(listed).toHaveLength(12);
    expect(answer._result.parentKeys!.meta).toEqual(Object.keys(keys('m')).slice(0, 12));
  });

  it('lists only echoable keys of a parent', () => {
    const value = { data: [{ id: 1, ok: 2, x12: 3, x123: 4, 'a-b': 5, 'first name': 6, $v: 7, ['l'.repeat(65)]: 8 }] };
    expect(read(value, ['data[].id', 'data[].nope'])._result.parentKeys).toEqual({ 'data[]': ['id', 'ok', 'x12', '$v'] });
  });

  it('names the parents only when they fit next to the whole page', () => {
    const value = {
      data: Array.from({ length: 10 }, (_, index) => ({ id: index, text: 't'.repeat(100), ...Object.fromEntries(Array.from({ length: 12 }, (_, key) => [`${'k'.repeat(50)}${String.fromCharCode(97 + key)}`, key])) })),
    };
    const fields = ['data[].id', 'data[].text', 'data[].nope'];
    const roomy = read(value, fields, 100_000);
    expect(roomy._result.parentKeys).toBeDefined();
    const withoutParents = { ...roomy, _result: { ...roomy._result, parentKeys: undefined, hint: roomy._result.hint!.replace(' or pick a field from parentKeys', '') } };
    // Room for the whole page without the parents, not with them: the page wins.
    const maxChars = JSON.stringify(withoutParents).length;
    expect(JSON.stringify(roomy).length).toBeGreaterThan(maxChars);
    const answer = read(value, fields, maxChars);
    expect(answer._result).toMatchObject({ returned: 10, total: 10, unknownFields: ['data[].nope'] });
    expect(answer._result).not.toHaveProperty('parentKeys');
    expect(answer._result).not.toHaveProperty('nextOffset');
  });

  it('keeps an enum-like label longer than a free-text field', () => {
    const value = { items: Array.from({ length: 100 }, (_, index) => ({ id: index, status: ['pending_review_x', 'approved_final_x'][index % 2], tag: `tag-${index}` })) };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: size(value), readOnly: true }) as Overview;
    expect(overview._result.omitted!.map((entry) => entry.path)).toEqual(['items[].tag']);
  });

  it.each([
    ['UUIDs', (index: number) => `${(index * 2_654_435_761 >>> 0).toString(16).padStart(8, '0')}-0000-4000-a000-${String(index).padStart(12, '0')}`],
    ['URLs', (index: number) => `https://x.example/${index}`],
  ])('drops opaque values (%s) before a larger free-text field', (_label, opaque) => {
    const value = { items: Array.from({ length: 40 }, (_, index) => ({ id: index, ref: opaque(index), note: `A note about item number ${index} that is long` })) };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: size(value) - 100, readOnly: true }) as Overview;
    expect(overview._result.omitted!.map((entry) => entry.path)).toEqual(['items[].ref']);
  });

  it('ranks a field ending in a capital ID as a foreign key only after a lower-case letter, digit or underscore', () => {
    const value = { items: Array.from({ length: 40 }, (_, index) => ({ id: index, VALID: index % 2 ? 'yes' : 'no', label2: `L${index}` })) };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: size(value) - 40, readOnly: true }) as Overview;
    expect(overview._result.omitted!.map((entry) => entry.path)).toEqual(['items[].label2']);
    const keyed = { items: Array.from({ length: 40 }, (_, index) => ({ id: index, ownerID: index % 2 ? 'yes' : 'no', label2: `L${index}` })) };
    const foreign = buildResultOverview(keyed, { id: 'ro_abcdefgh', maxChars: size(keyed) - 40, readOnly: true }) as Overview;
    expect(foreign._result.omitted!.map((entry) => entry.path)).toEqual(['items[].ownerID']);
  });

  it('breaks a size tie between arrays by code-unit order, not by locale', () => {
    const value = { b: [1, 2, 3], B: [4, 5, 6], body: 'x'.repeat(2_000) };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 1_000, readOnly: true }) as Overview;
    expect(Object.keys(overview._result.arrays!)).toEqual(['B', 'b']);
  });
});

describe('final check: an entry the answer does not show is never counted as returned', () => {
  const handleOf = (value: Record<string, unknown>) => (
    { id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars: 1_000, value } as ResultHandle
  );
  const read = (value: Record<string, unknown>, fields: string[], offset = 0) => readResultHandle(
    handleOf(value),
    { resultId: 'ro_abcdefgh', offset } as ReadResultInput,
    fields.map((field) => parseResultPath(field)!),
  ) as { _result: ReadResultMarker; data?: unknown; _truncated?: unknown };

  it('does not claim an item of an indexed entry that the cut removed', () => {
    const entry = {
      status: 'open',
      s0: 'y'.repeat(400),
      items: Array.from({ length: 25 }, (_, j) => ({ j, t: 'q'.repeat(600) })),
      more: Array.from({ length: 10 }, (_, j) => ({ j })),
    };
    const answer = read({ data: [entry, entry] }, ['data[0]']);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(1_000);
    const items = (answer.data as { 0?: { items?: unknown[] } } | undefined)?.[0]?.items;
    // Either the item is there, or the answer says that nothing was returned.
    if (answer._result.returned === 1) expect(items).toHaveLength(1);
    else {
      expect(answer._result.returned).toBe(0);
      expect(answer._result.hint).toContain('does not fit');
    }
    expect(answer._result.hint).toMatch(/^Incomplete/);
    expect(answer._result.nextOffset).toBe(1);
  });

  it('does not count an entry of which only a placeholder is left', () => {
    const sub = {
      ...Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`f${k}`, 'z'.repeat(100)])),
      list: Array.from({ length: 30 }, (_, j) => ({ j, t: 'w'.repeat(40) })),
    };
    const answer = read({ data: [{ sub: { a: 1 } }, { sub }, { sub: { a: 2 } }] }, ['data'], 1);
    expect(JSON.stringify(answer)).not.toContain('[omitted: object');
    expect(answer._result).toMatchObject({ returned: 0, total: 3, nextOffset: 2 });
    expect(answer._result.hint).toContain('does not fit');
  });

  it('shows the entries of a page that all lack the selected field', () => {
    const data = Array.from({ length: 6 }, (_, i) => ({ id: i, ...(i >= 3 ? { published: { label: `p${i}` } } : {}) }));
    const answer = readResultHandle(
      { ...handleOf({ data }), maxChars: 16_000 },
      { resultId: 'ro_abcdefgh', limit: 3 } as ReadResultInput,
      [parseResultPath('data[].published.label')!],
    );
    // Each entry still says which one it is (its identity fields).
    expect(answer.data).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(answer._result).toMatchObject({ returned: 3, total: 6, nextOffset: 3 });
    expect((answer._result as ReadResultMarker).unknownFields).toBeUndefined();
  });
});
