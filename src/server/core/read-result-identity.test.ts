import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type Tool, type ToolContext } from '../../types.js';
import { toolToAiTool } from './index.js';
import { createReadResultTool, readResultHandle, type ReadResultInput, type ReadResultMarker } from './read-result-tool.js';
import { parseResultPath } from '../../contracts/result-paths.js';
import { createResultStore, type ResultHandle } from './result-store.js';

type Answer = Record<string, unknown> & { _result: ReadResultMarker };
const ctx = { currentDate: new Date('2026-11-17'), locale: 'en-US' } as ToolContext;

/** 45 designs, some with more than one variant. */
const designs = () => ({
  data: Array.from({ length: 45 }, (_, index) => ({
    id: `d${index}`, name: `Design ${index}`, status: 'live', description: 'x'.repeat(300),
    draftVersion: { title: `Draft ${index}`, variants: Array.from({ length: 1 + (index % 3) }, (_, variant) => ({ size: variant, label: `v${variant}` })) },
  })),
  meta: { total: 45 },
});

const handleOf = (value: Record<string, unknown>, maxChars = 16_000): ResultHandle => ({
  id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars, value,
}) as ResultHandle;
const read = (value: Record<string, unknown>, fields: string[] | undefined, extra: Partial<ReadResultInput> = {}, maxChars = 16_000) => readResultHandle(
  handleOf(value, maxChars), { resultId: 'ro_abcdefgh', ...(fields ? { fields } : {}), ...extra },
  fields?.map((field) => parseResultPath(field)!),
) as Answer;

describe('read_result: identity fields of the entries read below an array', () => {
  it('names each entry when reading below it, also on a later page', () => {
    const answer = read(designs(), ['data[].draftVersion.variants'], { offset: 3, limit: 2 });
    expect(answer.data).toEqual([
      { id: 'd3', name: 'Design 3', draftVersion: { variants: [{ size: 0, label: 'v0' }] } },
      { id: 'd4', name: 'Design 4', draftVersion: { variants: [{ size: 0, label: 'v0' }, { size: 1, label: 'v1' }] } },
    ]);
    expect(Object.keys((answer.data as object[])[0]!)).toEqual(['id', 'name', 'draftVersion']);
    expect(answer._result).toMatchObject({ offset: 3, returned: 2, total: 45, nextOffset: 5 });
  });

  it('adds them to an indexed entry, never to nested arrays, and never twice', () => {
    expect(read(designs(), ['data[2].draftVersion.variants']).data)
      .toEqual({ 2: { id: 'd2', name: 'Design 2', draftVersion: { variants: [{ size: 0, label: 'v0' }, { size: 1, label: 'v1' }, { size: 2, label: 'v2' }] } } });
    // `label` of a variant is an identity key, but variants are a nested array: not added.
    expect(read(designs(), ['data[].draftVersion.variants[].size'], { limit: 1 }).data)
      .toEqual([{ id: 'd0', name: 'Design 0', draftVersion: { variants: [{ size: 0 }] } }]);
    expect(read(designs(), ['data[].name', 'data[].status'], { limit: 1 }).data).toEqual([{ id: 'd0', name: 'Design 0', status: 'live' }]);
  });

  it('adds nothing without fields, for whole entries, for entries that are no object, or non-scalar and long values', () => {
    expect(read({ data: [{ id: 1, x: 2 }] }, undefined).data).toEqual([{ id: 1, x: 2 }]);
    expect(read({ data: [{ id: 1, x: 2 }] }, ['data[]']).data).toEqual([{ id: 1, x: 2 }]);
    expect(read({ data: { id: 1, x: { y: 2 } } }, ['data.x.y']).data).toEqual({ x: { y: 2 } });
    expect(read({ data: ['a', { id: 1, x: { y: 2 } }] }, ['data[].x']).data).toEqual([{}, { id: 1, x: { y: 2 } }]);
    expect(read({ data: [{ id: { nested: 1 }, name: 'n'.repeat(200), code: 7, x: 1 }] }, ['data[].x']).data).toEqual([{ code: 7, x: 1 }]);
  });

  it('keeps every answer within the limit and every entry exactly once while paging', () => {
    for (const maxChars of [1_000, 2_000, 5_000]) {
      const value = {
        data: Array.from({ length: 60 }, (_, index) => ({
          id: `d${index}`, name: `${'N'.repeat(index % 150)}${index}`, body: { text: 't'.repeat((index * 37) % 400) },
        })),
      };
      const seen: string[] = [];
      let offset: number | undefined = 0;
      for (let pages = 0; offset !== undefined; pages += 1) {
        expect(pages).toBeLessThan(200);
        const answer = read(value, ['data[].body'], { offset }, maxChars);
        expect(JSON.stringify(answer).length).toBeLessThanOrEqual(maxChars);
        const entries = (answer.data ?? []) as Array<{ id: string }>;
        seen.push(...entries.map((entry) => entry.id));
        if (answer._result.nextOffset !== undefined) {
          expect(answer._result.hint).toMatch(/^Incomplete:/);
          expect(answer._result.nextOffset).toBe(offset + (answer._result.returned ?? 0) + ((answer._result.returned ?? 0) === 0 ? 1 : 0));
        }
        offset = answer._result.nextOffset;
      }
      expect(seen).toEqual(value.data.map((entry) => entry.id));
      // Deterministic.
      expect(JSON.stringify(read(value, ['data[].body'], { offset: 7 }, maxChars))).toBe(JSON.stringify(read(value, ['data[].body'], { offset: 7 }, maxChars)));
    }
  });

  it('keeps the identity fields when one entry has to be cut', () => {
    const answer = read({ data: [{ id: 'big', name: 'Big one', body: { text: 'w '.repeat(3_000), more: 'm'.repeat(2_000) } }] }, ['data[].body'], {}, 1_000);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(1_000);
    expect(answer).toHaveProperty('_truncated');
    expect((answer.data as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'big', name: 'Big one' });
  });

  it('never adds an identity field outside the tool\'s upper bound', async () => {
    const run = async (fields: Partial<Pick<Tool, 'outputAllowedFields' | 'outputDeniedFields'>>, read: string[]) => {
      const store = createResultStore();
      const tool = defineTool({ id: 't', description: 'T.', inputSchema: z.object({}), ...fields, outputDefaultFields: ['meta'], execute: async () => designs() });
      const overview = await toolToAiTool(tool, ctx, 't', { resultStore: store }).execute({}) as { _result: { id: string } };
      return await toolToAiTool(createReadResultTool(store), ctx, 'read_result', { resultStore: store })
        .execute({ resultId: overview._result.id, fields: read, limit: 2 }) as Answer;
    };
    const denied = await run({ outputDeniedFields: ['**.name'] }, ['data[].status']);
    expect(denied.data).toEqual([{ id: 'd0', status: 'live' }, { id: 'd1', status: 'live' }]);
    const allowed = await run({ outputAllowedFields: ['data[].name', 'data[].status', 'meta'] }, ['data[].status']);
    expect(allowed.data).toEqual([{ name: 'Design 0', status: 'live' }, { name: 'Design 1', status: 'live' }]);
    // Indistinguishable: the same as a result that never had the field.
    const store = createResultStore();
    const without = designs();
    for (const entry of without.data as Array<Record<string, unknown>>) delete entry.name;
    const tool = defineTool({ id: 't', description: 'T.', inputSchema: z.object({}), outputDefaultFields: ['meta'], execute: async () => without });
    const overview = await toolToAiTool(tool, ctx, 't', { resultStore: store }).execute({}) as { _result: { id: string } };
    const plain = await createReadResultTool(store).execute({ resultId: overview._result.id, fields: ['data[].status'], limit: 2 }, ctx) as Answer;
    expect(JSON.stringify(plain).replace(/ro_[0-9a-z]{8}/g, 'ID')).toBe(JSON.stringify(denied).replace(/ro_[0-9a-z]{8}/g, 'ID'));
  });
});
