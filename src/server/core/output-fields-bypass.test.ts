import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool, defineTool, type AiEndpointToolDefinition, type Tool, type ToolContext } from '../../types.js';
import { executeTool } from '../adapters/nextjs/server-action-helper.js';
import { endpointToolToTool, toolToAiTool, type InternalApiResponse } from './index.js';
import { applyOutputBound, FAILURE_BODY_WITHHELD, outputBoundOf, parseOutputFieldPath } from './output-fields.js';
import { createReadResultTool } from './read-result-tool.js';
import { createResultStore } from './result-store.js';
import { zodToCompactDescription } from './zod-compact.js';

const ctx = (response: InternalApiResponse): ToolContext => ({
  currentDate: new Date('2026-11-17'), locale: 'en-US', callEndpoint: async () => response,
} as never);
const SIG = 'https://s3.example/x?X-Signature=SECRETSIG';
const body = { data: [{ id: 'd0', name: 'D0', draftVersion: { fileUrl: SIG, variants: [{ size: 1, fileUrl: SIG }] }, tokens: ['TOKA', 'TOKB'] }], meta: { total: 1 } };

function endpoint(extra: Partial<AiEndpointToolDefinition>): Tool {
  return endpointToolToTool(defineEndpointTool({
    id: 'designs.list', toolName: 'designs_list', description: 'List.', method: 'GET', path: '/api/designs',
    inputSchema: z.object({}).strict(), ...extra,
  }));
}
const shown = async (tool: Tool, response: InternalApiResponse) => (
  await toolToAiTool(tool, ctx(response), 'designs_list').execute({}) as Record<string, unknown>
);
const viaServerAction = async (tool: Tool, response: InternalApiResponse) => executeTool({
  toolName: 'designs_list', input: {}, tools: { designs_list: { ...tool, execute: (input: unknown) => tool.execute(input, ctx(response)) } },
});

describe('1: a denied path ending in [] empties every entry', () => {
  it.each([
    [['data[]'], { data: [{}], meta: { total: 1 } }],
    [['data[].tokens[]'], { data: [{ ...body.data[0], draftVersion: body.data[0]!.draftVersion, tokens: [{}, {}] }], meta: { total: 1 } }],
  ])('%j', (denied, expected) => {
    expect(applyOutputBound(body, outputBoundOf({ outputDeniedFields: denied })!)).toEqual(expected);
  });

  it('makes nested and scalar entries {} too, and an allow path ending in [] keeps whole entries', () => {
    // A value where the path needs an array stays, as for every denied path that does not match.
    expect(applyOutputBound({ m: [[1, { a: 'X' }], 'S'] }, outputBoundOf({ outputDeniedFields: ['m[][]'] })!)).toEqual({ m: [[{}, {}], 'S'] });
    expect(applyOutputBound({ m: [1, { a: 2 }], o: 1 }, outputBoundOf({ outputAllowedFields: ['m[]'] })!)).toEqual({ m: [1, { a: 2 }] });
  });

  it('reads like an emptied entry through read_result', async () => {
    const store = createResultStore();
    const tool = defineTool({
      id: 't', description: 'T.', inputSchema: z.object({}), outputDeniedFields: ['data[].tokens[]'], outputDefaultFields: ['data[].id'],
      execute: async () => body,
    });
    const overview = await toolToAiTool(tool, ctx({ ok: true, status: 200 }), 't', { resultStore: store }).execute({}) as { _result: { id: string } };
    const read = await toolToAiTool(createReadResultTool(store), ctx({ ok: true, status: 200 }), 'read_result', { resultStore: store })
      .execute({ resultId: overview._result.id, fields: ['data[].tokens'] });
    expect(JSON.stringify(read)).not.toContain('TOK');
  });
});

describe('3: uiAction and success under a bound', () => {
  it('removes any-depth keys from a uiAction built with $data, a filterMapping and a backend uiAction; exact paths do not apply to it', async () => {
    const ok = { ok: true, status: 200, data: body };
    const cases: Array<[Partial<AiEndpointToolDefinition>, InternalApiResponse]> = [
      [{ uiActionOnSuccess: { type: 'run-client-action', actionId: 'designs.show', payload: { items: '$data' } } }, ok],
      [{ uiPattern: { type: 'filter-and-navigate', target: '/designs', filterMapping: { status: 'data' } } }, ok],
      [{}, { ok: true, status: 200, data: { ...body, uiAction: { type: 'x', payload: { fileUrl: SIG } } } }],
    ];
    for (const [extra, response] of cases) {
      const tool = endpoint({ outputDeniedFields: ['**.fileUrl', 'data[].tokens'], ...extra });
      for (const result of [await shown(tool, response), await viaServerAction(tool, response)]) {
        expect(JSON.stringify(result)).not.toContain('SECRETSIG');
        expect(JSON.stringify(result)).toContain('uiAction');
      }
    }
    // The exact path bounds the result data only: the $data copy in uiAction keeps tokens.
    const result = await shown(endpoint({ outputDeniedFields: ['data[].tokens'], uiActionOnSuccess: { type: 'show', payload: '$data' } }), ok);
    expect(JSON.stringify(result.data)).not.toContain('TOKA');
    expect(JSON.stringify(result.uiAction)).toContain('TOKA');
  });

  it('honours a backend success only as a boolean once a bound is declared; unchanged without one', async () => {
    const response = { ok: true, status: 200, data: { success: { fileUrl: SIG }, data: [] } };
    expect(await shown(endpoint({ outputDeniedFields: ['**.fileUrl'] }), response)).toEqual({ data: [] });
    expect(await shown(endpoint({}), response)).toEqual({ success: { fileUrl: SIG }, data: [] });
  });
});

describe('4: failure bodies under a bound', () => {
  const conflict = { ok: false, status: 409, error: 'Conflict', data: { message: 'stale', entity: body.data[0] } };

  it('removes denied keys and paths from a JSON body', async () => {
    const result = await shown(endpoint({ outputDeniedFields: ['**.fileUrl', 'entity.tokens'] }), conflict);
    expect(result).toMatchObject({ success: false, status: 409, body: { message: 'stale', entity: { id: 'd0' } } });
    expect(JSON.stringify(result)).not.toContain('SECRETSIG');
    expect(JSON.stringify(result)).not.toContain('TOKA');
  });

  it('reduces a long body before it is cut', async () => {
    const long = { ok: false, status: 422, error: 'Invalid', data: { pad: 'p'.repeat(5_000), fileUrl: SIG } };
    const result = await shown(endpoint({ outputDeniedFields: ['**.fileUrl'] }), long);
    expect(result.bodyTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRETSIG');
  });

  it('withholds the body with an allow-list, and a body that is not JSON under any bound', async () => {
    const allowed = await shown(endpoint({ outputAllowedFields: ['data'] }), conflict);
    expect(allowed).toEqual({ success: false, error: 'Conflict', retryable: false, status: 409, bodyWithheld: FAILURE_BODY_WITHHELD.allowed });
    const html = { ok: false, status: 500, error: 'Server error', data: `<html>${SIG}</html>` };
    const denied = await shown(endpoint({ outputDeniedFields: ['**.fileUrl'] }), html);
    expect(denied).toMatchObject({ status: 500, bodyWithheld: FAILURE_BODY_WITHHELD.unchecked });
    expect(JSON.stringify(denied)).not.toContain('SECRETSIG');
  });

  it('is byte-identical without a declaration, and the classifier still gets the original body', async () => {
    const seen: unknown[] = [];
    const response = { ...conflict };
    const tool = endpoint({});
    const plain = await toolToAiTool(tool, { ...ctx(response), classifyToolFailure: (info: { body: unknown }) => { seen.push(info.body); return 'error'; } } as never, 'designs_list').execute({});
    expect(JSON.stringify(plain)).toBe(JSON.stringify({ success: false, error: 'Conflict', retryable: false, status: 409, body: conflict.data }));
    const bounded = endpoint({ outputAllowedFields: ['data'] });
    await toolToAiTool(bounded, { ...ctx(response), classifyToolFailure: (info: { body: unknown }) => { seen.push(info.body); return 'error'; } } as never, 'designs_list').execute({});
    expect(seen).toEqual([conflict.data, conflict.data]);
  });

  it('reduces the body already in the endpoint tool, for code that calls its execute directly', async () => {
    const tool = endpoint({ outputDeniedFields: ['**.fileUrl'] });
    const raw = await tool.execute({}, ctx(conflict));
    expect(JSON.stringify(raw)).not.toContain('SECRETSIG');
    expect(JSON.stringify(await endpoint({}).execute({}, ctx(conflict)))).toContain('SECRETSIG');
  });

  it('applies the bound of the tool that shows the failure (a tool copied with a declaration)', async () => {
    const plain = endpoint({});
    const copied = { ...plain, outputDeniedFields: ['**.fileUrl'] };
    expect(JSON.stringify(await shown(copied, conflict))).not.toContain('SECRETSIG');
  });
});

describe('5: executeTool reduces failures like toolToAiTool', () => {
  it('for a 2xx body with success:false, a backend failure and a custom tool failure', async () => {
    const bounded = endpoint({ outputDeniedFields: ['**.fileUrl'] });
    for (const response of [
      { ok: true, status: 200, data: { success: false, error: 'partial', ...body } },
      { ok: false, status: 409, error: 'Conflict', data: { entity: body.data[0] } },
    ]) {
      const result = await viaServerAction(bounded, response);
      expect(JSON.stringify(result)).not.toContain('SECRETSIG');
      expect(result.success).toBe(false);
      expect(result.data).toEqual(await shown(bounded, response));
    }
    const custom = defineTool({
      id: 'c', description: 'C.', inputSchema: z.object({}), outputDeniedFields: ['**.fileUrl'],
      execute: async () => ({ success: false, error: 'x', data: body }),
    });
    const result = await executeTool({ toolName: 'c', input: {}, tools: { c: custom } });
    expect(result.data).toEqual({ success: false, error: 'x', retryable: false });
    // Without a declaration unchanged.
    const plainCustom = defineTool({ id: 'c', description: 'C.', inputSchema: z.object({}), execute: async () => ({ success: false, error: 'x', data: 1 }) });
    expect((await executeTool({ toolName: 'c', input: {}, tools: { c: plainCustom } })).data).toEqual({ success: false, error: 'x', data: 1 });
  });
});

describe('7: whitespace makes a path invalid', () => {
  it.each(['**.fileUrl ', ' a', 'a .b', 'a\tb', 'data[]. x'])('%j', (path) => {
    expect(parseOutputFieldPath(path)).toBeUndefined();
    expect(() => defineTool({ id: 't', description: 'T.', inputSchema: z.object({}), outputDeniedFields: [path], execute: async () => ({}) }))
      .toThrow('outputDeniedFields must be a list');
  });
});

describe('10: the Returns: text never names a field outside the bound', () => {
  const item = z.object({ id: z.string(), secretKey: z.string().describe('see secretKey') });
  const describe_ = (schema: z.ZodTypeAny, fields: object) => zodToCompactDescription(schema, 6, outputBoundOf(fields));
  it.each([
    ['root array, exact', z.array(item), { outputDeniedFields: ['data[].secretKey'] }, 'Array<{ id: string }>'],
    ['root array, allow', z.array(item), { outputAllowedFields: ['data[].id'] }, 'Array<{ id: string }>'],
    ['tuple', z.object({ t: z.tuple([item, item]) }), { outputDeniedFields: ['**.secretKey'] }, '{ t: [{ id: string }, { id: string }] }'],
    ['tuple, exact', z.object({ t: z.tuple([item]) }), { outputDeniedFields: ['t[].secretKey'] }, '{ t?: [{ id: string }] }'],
    ['record, exact below a key', z.object({ m: z.record(z.string(), item) }), { outputDeniedFields: ['m.x.secretKey'] }, '{ m?: Record<string, unknown> }'],
    ['record, any depth', z.object({ m: z.record(z.string(), item) }), { outputDeniedFields: ['**.secretKey'] }, '{ m: Record<string, { id: string }> }'],
    ['discriminated union', z.object({ d: z.discriminatedUnion('k', [z.object({ k: z.literal('a'), secretKey: z.string() }), z.object({ k: z.literal('b') })]) }), { outputDeniedFields: ['**.secretKey'] }, '{ d: { k: "a" } | { k: "b" } }'],
    ['nested optional and nullable', z.object({ o: item.optional().nullable() }), { outputDeniedFields: ['o.secretKey'] }, '{ o?: { id: string } }'],
    ['intersection', z.object({ i: z.intersection(item, z.object({ x: z.string() })) }), { outputDeniedFields: ['i.secretKey'] }, '{ i?: unknown }'],
    ['map', z.object({ m: z.map(z.string(), item) }), { outputDeniedFields: ['**.secretKey'] }, '{ m: unknown }'],
  ] as const)('%s', (_label, schema, fields, expected) => {
    const text = describe_(schema, fields);
    expect(text).toBe(expected);
    expect(text).not.toContain('secretKey');
  });

  it('is unchanged without a bound', () => {
    expect(zodToCompactDescription(z.array(item), 6)).toBe('Array<{ id: string, secretKey: string }>');
  });
});

describe('bypass property test: uiAction, failures, executeTool, [] paths and the Returns: text', () => {
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }
  /** Planted under the any-depth key Qzsecr (removed everywhere, uiAction included) and inside items[] entries (exact, result data only). */
  function plant(next: () => number) {
    let counter = 0;
    const mark = (prefix: string) => `${prefix}${(counter += 1).toString(36).padStart(4, 'a').replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!)}X`;
    const value = (depth: number): unknown => {
      const roll = next();
      if (depth > 4 || roll < 0.3) return mark('Wv');
      if (roll < 0.5) return Array.from({ length: 1 + Math.floor(next() * 3) }, () => value(depth + 1));
      const object: Record<string, unknown> = { k: value(depth + 1) };
      if (next() < 0.5) object.Qzsecr = { inner: mark('Wsecr') };
      return object;
    };
    const items = () => [mark('Witem'), { x: mark('Witem'), Qzsecr: mark('Wsecr') }, [mark('Witem')]];
    const entry = () => ({
      k: next() < 0.5 ? { v: value(2), items: items() } : value(2),
      ...(next() < 0.5 ? { items: items() } : {}),
      ...(next() < 0.3 ? { Qzsecr: [value(2)] } : {}),
    });
    return {
      data: Array.from({ length: 3 }, entry),
      Qzsecr: mark('Wsecr'),
      list: [[{ Qzsecr: mark('Wsecr') }]],
    };
  }

  it('shows no planted secret to the model or the browser', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      const data = plant(next);
      const allow = seed % 3 === 0;
      const declarations = {
        outputDeniedFields: ['**.Qzsecr', 'data[].items[]', 'data[].k.items[]'],
        ...(allow ? { outputAllowedFields: ['data', 'list'] } : {}),
      };
      const tool = endpoint({ ...declarations, uiActionOnSuccess: { type: 'show', payload: '$data' } });
      const responses: InternalApiResponse[] = [
        { ok: true, status: 200, data },
        { ok: true, status: 200, data: data.data },
        { ok: true, status: 200, data: { success: false, error: 'partial', ...data } },
        { ok: false, status: 409, error: 'Conflict', data },
        { ok: false, status: 500, error: 'Server error', data: JSON.stringify(data) },
      ];
      for (const response of responses) {
        const outputs = [await shown(tool, response), (await viaServerAction(tool, response)) as unknown];
        const store = createResultStore();
        const stored = await toolToAiTool({ ...tool, outputDefaultFields: ['data[].k'] }, ctx(response), 'designs_list', { resultStore: store }).execute({}) as { _result?: { id: string } };
        outputs.push(stored);
        if (stored._result) {
          const reader = toolToAiTool(createReadResultTool(store), ctx(response), 'read_result', { resultStore: store });
          for (const fields of [undefined, ['data'], ['data[].items'], ['data[].k'], ['list']]) outputs.push(await reader.execute({ resultId: stored._result.id, ...(fields ? { fields } : {}) }));
        }
        for (const output of outputs) {
          const text = JSON.stringify(output);
          expect(text, `seed ${seed}`).not.toMatch(/Wsecr|Qzsecr/);
          // Exact paths bound the result data, not the uiAction copy of it.
          const withoutUi = JSON.stringify(output, (key, value) => (key === 'uiAction' ? undefined : value));
          expect(withoutUi, `seed ${seed}`).not.toContain('Witem');
        }
      }
    }
  });

  it('never names a denied key in the Returns: text of a random Zod schema', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed);
      let counter = 0;
      const exactKey = 'Qzexact';
      let exactPath: string | undefined;
      const build = (depth: number, path: string): z.ZodTypeAny => {
        const roll = next();
        if (depth > 3 || roll < 0.25) return [z.string(), z.number(), z.boolean()][Math.floor(next() * 3)]!;
        if (roll < 0.4) return z.array(build(depth + 1, `${path}[]`));
        if (roll < 0.45) return z.tuple([build(depth + 1, `${path}[]`), build(depth + 1, `${path}[]`)]);
        if (roll < 0.5) return z.record(z.string(), build(depth + 1, `${path}.r`));
        if (roll < 0.55) return z.union([build(depth + 1, path), build(depth + 1, path)]);
        const shape: Record<string, z.ZodTypeAny> = {};
        const key = `f${counter += 1}`;
        shape[key] = build(depth + 1, path ? `${path}.${key}` : key);
        if (next() < 0.4) shape.Qzsecr = build(depth + 1, `${path}.Qzsecr`).describe('secret');
        if (!exactPath && next() < 0.5) {
          exactPath = path ? `${path}.${exactKey}` : exactKey;
          shape[exactKey] = z.string();
        }
        const object = z.object(shape);
        return next() < 0.2 ? object.optional().nullable() : object;
      };
      const root = next() < 0.4 ? z.array(build(1, 'data[]')) : build(0, '');
      const denied = ['**.Qzsecr', ...(exactPath && !exactPath.startsWith('.') ? [exactPath] : [])];
      const text = zodToCompactDescription(root, 8, outputBoundOf({ outputDeniedFields: denied.filter((path) => parseOutputFieldPath(path) || path.startsWith('**.')) }));
      expect(text, `seed ${seed}`).not.toContain('Qzsecr');
      if (denied.length > 1 && parseOutputFieldPath(denied[1]!)) expect(text, `seed ${seed}: ${denied[1]}`).not.toContain(exactKey);
    }
  });
});

describe('review round 2: a withheld result keeps no denied value in its uiAction', () => {
  const custom = (result: unknown, extra: Record<string, unknown> = {}): Tool => defineTool({
    id: 'custom.act', description: 'Act.', inputSchema: z.object({}).strict(),
    outputDeniedFields: ['**.fileUrl'],
    execute: async () => result,
    ...extra,
  } as never);
  const run = async (tool: Tool) => (
    await toolToAiTool(tool, ctx({ ok: true, status: 200, data: {} } as never), 'custom_act').execute({}) as Record<string, unknown>
  );

  it('filters the uiAction when the result does not match the output schema', async () => {
    const tool = custom(
      { success: true, id: 42, uiAction: { type: 'open', payload: { id: 'd0', fileUrl: SIG } } },
      { outputSchema: z.object({ id: z.string() }) },
    );
    const answer = await run(tool);
    expect(answer.outputWithheld).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('SECRETSIG');
    expect(answer.uiAction).toEqual({ type: 'open', payload: { id: 'd0' } });
  });

  it('drops the uiAction when the result cannot be serialized', async () => {
    const cyclic: Record<string, unknown> = { success: true, uiAction: { type: 'open', payload: { fileUrl: SIG } } };
    cyclic.self = cyclic;
    const answer = await run(custom(cyclic));
    expect(answer.outputWithheld).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('SECRETSIG');
  });
});
