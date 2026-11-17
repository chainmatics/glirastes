import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool, defineTool, type ToolContext } from '../../types.js';
import { endpointToolToTool, toolToAiTool, type InternalApiResponse } from './index.js';
import { createReadResultTool } from './read-result-tool.js';
import { buildResultOverview, type ResultOverviewMarker } from './result-overview.js';
import { parseResultPath, projectResult } from './result-paths.js';
import { createResultStore, DEFAULT_RESULT_HANDLE_LIMITS } from './result-store.js';
import { createExecutionFingerprint } from '../../runtime/fingerprint.js';
import { toolResultForFingerprint } from '../../runtime/tool-failure.js';

type Overview = Record<string, unknown> & { _result: ResultOverviewMarker };

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
  ])('parses %s', (text, expected) => {
    expect(parseResultPath(text)?.steps.map((step) => (step.kind === 'each' ? '[]' : step.key))).toEqual(expected);
  });

  it.each(['', 'data..name', 'data[0]', 'data[*]', '*', 'data.[]', '.data', 'data.', 'a[]b', '!data', 'x'.repeat(201)])(
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
    expect(read._result.hint).toContain('during this turn');
    expect(read._result.hint).toContain('If read_result answers result_expired, call the original tool again.');
    const write = buildResultOverview(playlists(), { id: 'rw_abcdefgh', maxChars: 16_000, readOnly: false }) as Overview;
    expect(write._result.hint).toContain('do not call it again');
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

  it('creates no handle without an owner when one is asked for', async () => {
    expect(await put(createResultStore({ owner: async () => undefined }))).toBeUndefined();
    const store = createResultStore({ owner: async () => ({ subjectId: 'alice', tenantId: 't1' }) });
    const overview = await put(store) as Overview;
    expect(store.get(overview._result.id)?.owner).toEqual({ subjectId: 'alice', tenantId: 't1' });
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
    expect(result.data).toEqual([{ id: 'p2', tracks: 'x'.repeat(8_000) }]);
    expect(result._result).toMatchObject({ offset: 2, returned: 1, total: 20, nextOffset: 3 });
    expect(store.isIssued(result)).toBe(true);
    expect(result).not.toHaveProperty('uiAction');
  });

  it('reads nested paths and a paginated envelope', async () => {
    const { read } = await setup({ data: { items: playlists().data, page: 1 } });
    const result = await read({ fields: ['data.items[].owner.name', 'data.page'], limit: 2 });
    expect(result.data).toEqual({ items: [{ owner: { name: 'Owner 0' } }, { owner: { name: 'Owner 1' } }], page: 1 });
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
    expect(JSON.stringify(result._truncated)).toContain('read_result');
    expect((result._result as { returned: number }).returned).toBe(1);
  });

  it('reads everything but uiAction without fields', async () => {
    const { read } = await setup({ ...playlists(2, 100), uiAction: { type: 'navigate', path: '/x' } }, 1_000);
    const result = await read({});
    expect(result).not.toHaveProperty('uiAction');
    expect(result.meta).toEqual({ page: 1 });
    expect(result.success).toBe(true);
  });

  it('lists unknown paths and rejects invalid ones without echoing them', async () => {
    const { read } = await setup();
    const unknown = await read({ fields: ['data[].name', 'data[].nope', 'missing'] });
    // By position only: the answer is not shielded again, so no path the model wrote comes back.
    expect((unknown._result as { unknownFields: number[] }).unknownFields).toEqual([2, 3]);
    expect(JSON.stringify(unknown)).not.toContain('nope');
    expect(JSON.stringify(unknown)).not.toContain('missing');
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
      ];
      for (const fields of fieldLists) {
        for (const window of [{}, { offset: 3 }, { limit: 1 }, { offset: 1, limit: 1_000 }]) {
          const answer = await tool.execute({ resultId: overview._result.id, ...(fields ? { fields } : {}), ...window }, {} as ToolContext);
          expect(JSON.stringify(answer).length).toBeLessThanOrEqual(maxChars);
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
    expect((answer._result as { unknownFields: number[] }).unknownFields).toEqual([3, 4]);
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
    expect(answer._truncated).toMatchObject({ showing: 1, total: 2 });
    expect(String((answer._truncated as { hint: string }).hint)).toContain('showing 1 of 2 entries');
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
