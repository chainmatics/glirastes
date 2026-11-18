import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  declarationForEntries,
  declaredIdentityOf,
  declaredRecordsOf,
  defineEntity,
  entityDeclarationIssue,
  entityIdKindOf,
  inputEntityRefIssue,
  largestArrayRoute,
  sanitizeEntityDeclarations,
} from '../../contracts/entity-declaration.js';
import { defineTool, type ToolContext } from '../../types.js';
import { compactHistoryResult, type HistoryMarker } from '../adapters/nextjs/history-compaction.js';
import { convertArrayToReadableStream } from 'ai/test';
import {
  collectDeclaredIdLabels,
  collectDeclaredIdLabelsFromMessages,
  collectIdLabels,
  createHideIdsTransform,
  redactIds,
  type IdLabels,
} from '../adapters/nextjs/hide-ids.js';
import { entityDeclarationsOfTools } from '../adapters/nextjs/tool-entities.js';
import { prepareModelMessages } from '../adapters/nextjs/prepare-model-messages.js';
import { endpointToolToTool, toolToAiTool } from './index.js';
import { readResultHandle } from './read-result-tool.js';
import { buildResultOverview, type ResultOverviewMarker } from './result-overview.js';
import { parseResultPath } from './result-paths.js';
import type { ResultHandle } from './result-store.js';

type Entry = Record<string, unknown>;
type Overview = Entry & { _result: ResultOverviewMarker };
const ctx = { currentDate: new Date('2026-11-18'), locale: 'en-US' } as ToolContext;

/** Tracks with a numeric `trackNo` as id (no id-like key), a name under `label_text` and a foreign key. */
const tracks = (count = 40) => ({
  data: Array.from({ length: count }, (_, index) => ({
    trackNo: index + 1,
    label_text: `Track ${index + 1}`,
    albumId: 7,
    lyrics: `La ${index} `.repeat(40),
  })),
});
const TRACK = defineEntity({ type: 'track', id: 'trackNo', name: 'label_text' });

describe('entity declarations (contracts)', () => {
  it('validates declarations without repeating their values', () => {
    expect(entityDeclarationIssue({ id: 'playlist_id', name: 'displayName' })).toBeUndefined();
    expect(entityDeclarationIssue({ id: ['channel', 'rev'], type: 'channel-revision', idKind: 'speaking' })).toBeUndefined();
    expect(entityDeclarationIssue({ id: [] })).toMatch(/no id/);
    expect(entityDeclarationIssue({ id: ['a', 'a'] })).toMatch(/twice/);
    expect(entityDeclarationIssue({ id: 'a', type: 'Playlist' })).toMatch(/lower-case/);
    expect(entityDeclarationIssue({ id: 'a', idKind: 'readable' })).toMatch(/idKind/);
    expect(entityDeclarationIssue({ id: 'a', path: 'data[0]' }, { output: true })).toMatch(/path/);
    expect(entityDeclarationIssue({ id: 'a', path: 'data[]' })).toMatch(/unknown keys/);
    expect(entityDeclarationIssue({ id: 'a', secret: 'sk-live-123' })).not.toContain('sk-live');
    expect(inputEntityRefIssue({ type: 'playlist', args: 'playlist_id', role: 'parent' })).toBeUndefined();
    expect(inputEntityRefIssue({ type: 'playlist', args: 'filter.owner id' })).toMatch(/argument/);
    expect(inputEntityRefIssue({ args: 'x' })).toMatch(/no type/);
    expect(() => defineEntity({ id: '' })).toThrow('defineEntity');
    expect(Object.isFrozen(TRACK)).toBe(true);
  });

  it('defaults the id kind by field: key, slug and code are speaking', () => {
    expect(entityIdKindOf({ id: 'key' })).toBe('speaking');
    expect(entityIdKindOf({ id: ['key', 'slug'] })).toBe('speaking');
    expect(entityIdKindOf({ id: 'id' })).toBe('opaque');
    expect(entityIdKindOf({ id: 'orderNo', idKind: 'speaking' })).toBe('speaking');
  });

  it('reads numeric, composite and nameless identities; a missing id part is no record', () => {
    expect(declaredIdentityOf({ trackNo: 3, label_text: ' T ' }, TRACK)).toMatchObject({ idValues: [3], name: 'T', idKind: 'opaque' });
    const revision = { type: 'revision', id: ['channel', 'rev'], fallback: 'rev' } as const;
    expect(declaredIdentityOf({ channel: 'lobby', rev: 3 }, revision))
      .toMatchObject({ idValues: ['lobby', 3], fallbackField: 'rev', fallbackValue: 3 });
    expect(declaredIdentityOf({ channel: 'lobby' }, revision)).toBeUndefined();
    expect(declaredIdentityOf({ trackNo: 1.5 }, TRACK)).toBeUndefined();
  });

  it('finds declared records at a path, nested, in indexed reads, and at the default path', () => {
    const value = { data: [{ id: 1, owner: { userNo: 9, nick: 'ada' } }, { id: 2, owner: { userNo: 8 } }] };
    const owners = declaredRecordsOf(value, [{ type: 'user', id: 'userNo', name: 'nick', path: 'data[].owner' }]);
    expect([...owners.values()].map((identity) => identity.idValues)).toEqual([[9], [8]]);
    const indexed = declaredRecordsOf({ data: { 2: { trackNo: 3 } } }, [{ ...TRACK, path: 'data[]' }]);
    expect([...indexed.values()].map((identity) => identity.idValues)).toEqual([[3]]);
    expect(largestArrayRoute({ meta: { tags: ['a'] }, data: [{ a: 1 }, { a: 2 }] })).toEqual(['data']);
    expect(declaredRecordsOf(tracks(2), [TRACK]).size).toBe(2);
    expect(declaredRecordsOf({ trackNo: 1, label_text: 'root' }, [{ ...TRACK, path: '' }]).size).toBe(1);
  });

  it('uses the first applicable declaration in list order, in the overview and for records alike', () => {
    const root = { data: [{ trackNo: 1, label_text: 'a', code: 'x' }, { trackNo: 2, label_text: 'b', code: 'y' }] };
    const first = { type: 'track', id: 'trackNo', name: 'label_text' };
    const second = { type: 'track', id: 'code', path: 'data[]' };
    expect(declarationForEntries([first, second], ['data'], root)).toBe(first);
    expect([...declaredRecordsOf(root, [first, second]).values()][0]!.declaration).toBe(first);
    expect(declarationForEntries([second, first], ['data'], root)).toBe(second);
    expect([...declaredRecordsOf(root, [second, first]).values()][0]!.declaration).toBe(second);
  });

  it('matches a path-less declaration only to the largest array', () => {
    const root = { data: [{ a: 1 }, { a: 2 }], other: [{ b: 1 }] };
    expect(declarationForEntries([TRACK], ['data'], root)).toBe(TRACK);
    expect(declarationForEntries([TRACK], ['other'], root)).toBeUndefined();
    const other = { ...TRACK, path: 'other[]' };
    expect(declarationForEntries([TRACK, other], ['other'], root)).toBe(other);
  });

  it('drops invalid tool entries for the browser and keeps valid ones', () => {
    expect(sanitizeEntityDeclarations({
      a: { output: [{ id: 'x' }, { id: 7 }], input: [{ type: 'x', args: 'x_id' }, { type: 'X', args: 'y' }] },
      b: { output: 'nope' },
      c: null,
    })).toEqual({ a: { output: [{ id: 'x' }], input: [{ type: 'x', args: 'x_id' }] } });
  });

  it('rejects an invalid declaration on defineTool and endpointToolToTool', () => {
    const base = { id: 't', description: 'd', inputSchema: z.object({}), execute: async () => ({}) };
    expect(() => defineTool({ ...base, outputEntities: [{ id: '' }] })).toThrow('outputEntities[0]');
    expect(() => defineTool({ ...base, inputEntities: [{ type: 'x', args: [] }] })).toThrow('inputEntities[0]');
    expect(() => endpointToolToTool({
      id: 'e', toolName: 'e', module: 'm', sharedWithModules: [], description: 'd', method: 'GET', path: '/x',
      inputSchema: z.object({}), outputEntities: [{ id: 'a', type: 'BAD' }],
    } as never)).toThrow('outputEntities[0]');
  });
});

describe('overview with a declared identity', () => {
  it('keeps the declared numeric id and name under pressure, and no id-like guess (albumId goes first)', () => {
    const overview = buildResultOverview(tracks(), { id: 'ro_abcdefgh', maxChars: 2_200, readOnly: true, entities: [TRACK] }) as Overview;
    const data = overview.data as Entry[];
    expect(data.length).toBeGreaterThan(0);
    for (const [index, entry] of data.entries()) expect(entry).toEqual({ trackNo: index + 1, label_text: `Track ${index + 1}` });
    expect(overview._result.omitted!.map((field) => field.path)).toEqual(['data[].lyrics', 'data[].albumId']);
  });

  it('without the declaration the guess keeps albumId and drops the name it does not know', () => {
    const overview = buildResultOverview(tracks(), { id: 'ro_abcdefgh', maxChars: 2_200, readOnly: true }) as Overview;
    expect((overview.data as Entry[])[0]).toEqual({ trackNo: 1, albumId: 7 });
  });

  it('keeps the declared identity of the result itself (path "")', () => {
    const value = { orderNo: 'ORD-1', title: 'x'.repeat(50), lines: Array.from({ length: 30 }, (_, index) => ({ sku: `S${index}`, text: 't'.repeat(200) })) };
    const plain = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 900, readOnly: true }) as Overview;
    const declared = buildResultOverview(value, {
      id: 'ro_abcdefgh', maxChars: 900, readOnly: true, entities: [{ type: 'order', id: 'orderNo', path: '' }],
    }) as Overview;
    expect(declared.orderNo).toBe('ORD-1');
    expect(JSON.stringify(declared).length).toBeLessThanOrEqual(900);
    // Without it the root id is one more field to leave out.
    expect(Object.keys(plain)).toEqual(['lines', '_result']);
  });
});

describe('history compaction with a declared identity', () => {
  it('keeps exactly the declared id and name beyond maxItems, keys in declaration order', () => {
    const compacted = compactHistoryResult(tracks(30), { entities: [TRACK] }) as Entry & { _history: HistoryMarker };
    expect((compacted.data as Entry[])[20]).toEqual({ trackNo: 21, label_text: 'Track 21' });
    expect(compacted._history.keys).toEqual(['trackNo', 'label_text']);
  });

  it('keeps every part of a composite key and a fallback for nameless records', () => {
    const revisions = { revisions: Array.from({ length: 30 }, (_, index) => ({ channel: 'lobby', rev: index + 1, at: '2026-01-01', blob: 'b'.repeat(100) })) };
    const compacted = compactHistoryResult(revisions, {
      entities: [{ type: 'revision', id: ['channel', 'rev'], fallback: 'at', path: 'revisions[]' }],
    }) as Entry & { _history: HistoryMarker };
    expect((compacted.revisions as Entry[])[25]).toEqual({ channel: 'lobby', rev: 26, at: '2026-01-01' });
    expect(compacted._history.keys).toEqual(['channel', 'rev', 'at']);
  });

  it('a root list answer matches a data[] declaration', () => {
    const list = tracks(30).data;
    const compacted = compactHistoryResult(list, { entities: [{ ...TRACK, path: 'data[]' }] }) as Entry & { _history: HistoryMarker };
    expect(compacted._history.keys).toEqual(['trackNo', 'label_text']);
  });

  it('is byte-identical to the guess without a declaration', () => {
    const value = tracks(30);
    expect(JSON.stringify(compactHistoryResult(value, { entities: [] }))).toBe(JSON.stringify(compactHistoryResult(value)));
  });
});

describe('read_result with a declared identity', () => {
  it('names entries read below the array by the declared fields', () => {
    const value = { success: true, ...tracks(5) };
    const handle = { id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars: 16_000, value, entities: [TRACK] } as ResultHandle;
    const answer = readResultHandle(handle, { resultId: handle.id, fields: ['data[].lyrics'] }, [parseResultPath('data[].lyrics')!]) as Entry;
    expect(Object.keys((answer.data as Entry[])[0]!)).toEqual(['trackNo', 'label_text', 'lyrics']);
    const plain = readResultHandle({ ...handle, entities: undefined } as ResultHandle, { resultId: handle.id, fields: ['data[].lyrics'] },
      [parseResultPath('data[].lyrics')!]) as Entry;
    expect(Object.keys((plain.data as Entry[])[0]!)).toEqual(['albumId', 'lyrics']);
  });
});

describe('hideIds with a declared identity', () => {
  it('learns declared integer ids with their name and removes them only with an id prefix', () => {
    const labels: IdLabels = new Map();
    collectIdLabels(tracks(5), labels);
    expect(labels.size).toBe(0);
    collectDeclaredIdLabels(tracks(5), [TRACK], labels);
    expect(labels.get('3')).toBe('Track 3');
    expect(redactIds('Track 3 (ID: 3) is in 3 albums; id 4 too.', labels)).toBe('Track 3 is in 3 albums too.');
  });

  it('keeps speaking ids readable and still learns opaque string ids', () => {
    const labels: IdLabels = new Map();
    collectDeclaredIdLabels({ data: [{ key: 'ORD-42', title: 'Order' }] }, [{ id: 'key', name: 'title' }], labels);
    expect(labels.size).toBe(0);
    collectDeclaredIdLabels({ data: [{ ref: 'a1b2c3d4e5', title: 'Doc' }] }, [{ id: 'ref', name: 'title' }], labels);
    expect(redactIds('See a1b2c3d4e5.', labels)).toBe('See Doc.');
  });

  it('leaves the redaction of an app without declarations as it was', () => {
    const labels: IdLabels = new Map();
    collectIdLabels({ data: [{ id: 'a1b2c3d4e5', name: 'Doc' }] }, labels);
    collectDeclaredIdLabels({ data: [{ id: 'a1b2c3d4e5', name: 'Doc' }] }, undefined, labels);
    expect(redactIds('Doc (a1b2c3d4e5), id 3', labels)).toBe('Doc, id 3');
  });
});

describe('declarations travel with the AI tool, never into its output', () => {
  it('puts outputEntities and inputEntities on the AI tool as _entities and leaves results unchanged', async () => {
    const tool = defineTool({
      id: 'tracks.list', description: 'd', inputSchema: z.object({ albumId: z.number().optional() }), method: 'GET',
      outputEntities: [TRACK], inputEntities: [{ type: 'album', args: 'albumId', role: 'parent' }],
      execute: async () => tracks(2),
    });
    const aiTool = toolToAiTool(tool, ctx, 'tracks_list');
    expect(entityDeclarationsOfTools({ tracks_list: aiTool, other: {} })).toEqual({
      tracks_list: { output: [TRACK], input: [{ type: 'album', args: 'albumId', role: 'parent' }] },
    });
    const output = await (aiTool as unknown as { execute(input: unknown): Promise<unknown> }).execute({});
    expect(JSON.stringify(output)).not.toContain('label_text"]');
    expect(entityDeclarationsOfTools({ plain: toolToAiTool(defineTool({ ...tool, outputEntities: undefined, inputEntities: undefined }), ctx) }))
      .toBeUndefined();
  });
});

describe('hideIds keeps declared speaking ids readable', () => {
  it('neither the guess nor the UUID rule removes a declared speaking id', () => {
    const UUID = '3f2a9c1e-4b7d-4e2a-9f10-2c3d4e5f6a7b';
    const value = { data: [{ id: 'ABC123456', title: 'Order' }, { id: UUID, title: 'Coupon' }] };
    const labels: IdLabels = new Map();
    collectIdLabels(value, labels);
    expect(redactIds('ABC123456 and ' + UUID, labels)).toBe('Order and Coupon');
    collectDeclaredIdLabels(value, [{ id: 'id', name: 'title', idKind: 'speaking' }], labels);
    // Learnt again later (another result): still readable.
    collectIdLabels(value, labels);
    expect(redactIds(`Order ABC123456 (abc123456) and coupon ${UUID}; other ${'9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4'}.`, labels))
      .toBe(`Order ABC123456 (abc123456) and coupon ${UUID}; other.`);
  });
});

describe('declared paths on unwrapped lists and path-less root records', () => {
  it('reaches the entries of an unwrapped list through data[]', () => {
    expect(declaredRecordsOf([{ trackNo: 3 }], [{ id: 'trackNo', path: 'data[]' }]).size).toBe(1);
    expect(declaredRecordsOf([{ trackNo: 3 }], [{ id: 'trackNo' }]).size).toBe(1);
  });

  it('keeps the identity of a single record declared without a path', () => {
    const value: Record<string, unknown> = { orderNo: 'ORDER-2026-000001-ALPHA' };
    for (let index = 0; index < 60; index += 1) value[`f${index}`] = `v${index}`;
    const declared = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 1200, readOnly: true, entities: [{ type: 'order', id: 'orderNo' }] }) as Overview;
    expect(declared.orderNo).toBe('ORDER-2026-000001-ALPHA');
    const plain = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 1200, readOnly: true }) as Overview;
    expect(plain.orderNo).toBeUndefined();
  });
});

describe('read_result names nested declared entries', () => {
  it('adds the declared id and name of entries of a nested array, from the offset of the outer one', () => {
    const value = {
      success: true,
      playlists: Array.from({ length: 4 }, (_, outer) => ({
        playlist_id: outer + 1, displayName: `P${outer + 1}`,
        items: [{ item_id: outer * 10 + 1, displayName: `I${outer}a`, durationSec: 5 }, { item_id: outer * 10 + 2, displayName: `I${outer}b`, durationSec: 6 }],
      })),
    };
    const entities = [
      { type: 'playlist', id: 'playlist_id', name: 'displayName', path: 'playlists[]' },
      { type: 'playlist-item', id: 'item_id', name: 'displayName', path: 'playlists[].items[]' },
    ];
    const handle = { id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars: 16_000, value, entities } as ResultHandle;
    const field = 'playlists[].items[].durationSec';
    const answer = readResultHandle(handle, { resultId: handle.id, fields: [field], offset: 2, limit: 1 }, [parseResultPath(field)!]) as Entry;
    const playlist = (answer.playlists as Entry[])[0]!;
    expect(playlist).toMatchObject({ playlist_id: 3, displayName: 'P3' });
    expect(playlist.items).toEqual([{ item_id: 21, displayName: 'I2a', durationSec: 5 }, { item_id: 22, displayName: 'I2b', durationSec: 6 }]);
    // Without the nested declaration the items carry only the selected field, as before.
    const plain = readResultHandle({ ...handle, entities: [entities[0]!] } as ResultHandle, { resultId: handle.id, fields: [field], offset: 2, limit: 1 },
      [parseResultPath(field)!]) as Entry;
    expect((plain.playlists as Entry[])[0]!.items).toEqual([{ durationSec: 5 }, { durationSec: 6 }]);
  });
});

describe('bounds and whole ids', () => {
  it('reads a very large array without spreading it', () => {
    const data = Array.from({ length: 200_000 }, (_, index) => ({ trackNo: index + 1 }));
    expect(declaredRecordsOf({ data }, [{ ...TRACK, path: 'data[]' }]).size).toBe(10_000);
  });

  it('removes a declared short id only as a whole id', () => {
    const labels: IdLabels = new Map();
    collectDeclaredIdLabels(tracks(5), [TRACK], labels);
    expect(redactIds('See ID: 3.14 and ID: 3/7, then ID: 3.', labels)).toBe('See ID: 3.14 and ID: 3/7, then.');
    expect(redactIds('Wert ID: 3,14 und ID: 3, fertig', labels)).toBe('Wert ID: 3,14 und, fertig');
  });
});

describe('hideIds reads read_result answers with the producing tool', () => {
  it('learns a declared id first seen in a read_result answer, in the stream and from earlier messages', async () => {
    const entities = { tracks_list: { output: [{ ...TRACK, path: 'data[]' }] } };
    const parts = [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'tracks_list', input: {}, output: { data: [{ trackNo: 1, label_text: 'One' }], _result: { id: 'ro_abc12345' } } },
      { type: 'tool-result', toolCallId: 'c2', toolName: 'read_result', input: { resultId: 'ro_abc12345' }, output: { data: [{ trackNo: 42, label_text: 'Late' }] } },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', text: 'Late (ID: 42) is here.' },
      { type: 'text-end', id: 't' },
    ];
    const stream = convertArrayToReadableStream(parts as never)
      .pipeThrough(createHideIdsTransform(new Map(), { entities })({ tools: {}, stopStream: () => {} }) as never);
    let text = '';
    for await (const part of stream as unknown as AsyncIterable<{ type: string; text?: string }>) if (part.type === 'text-delta') text += part.text;
    expect(text).toBe('Late is here.');

    const labels: IdLabels = new Map();
    collectDeclaredIdLabelsFromMessages([{ role: 'assistant', parts: [
      { type: 'tool-tracks_list', state: 'output-available', input: {}, output: { data: [{ trackNo: 1, label_text: 'One' }], _result: { id: 'ro_abc12345' } } },
      { type: 'tool-read_result', state: 'output-available', input: { resultId: 'ro_abc12345' }, output: { data: [{ trackNo: 42, label_text: 'Late' }] } },
    ] }], entities, labels);
    expect(labels.get('42')).toBe('Late');
  });
});

describe('history compaction of read_result answers', () => {
  it('keeps the producing tool\'s declared identity of entries read later, in the next turn', async () => {
    const entities = { tracks_list: { output: [{ ...TRACK, path: 'data[]' }] } };
    const read = { data: Array.from({ length: 30 }, (_, index) => ({ trackNo: index + 100, label_text: `Late ${index}`, albumId: 7, lyrics: 'x'.repeat(50) })) };
    const messages = [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Tracks?' }] },
      {
        id: 'a0', role: 'assistant', parts: [
          { type: 'tool-tracks_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { data: [{ trackNo: 1, label_text: 'One' }], _result: { id: 'ro_abc12345', hint: 'x' } } },
          { type: 'tool-read_result', toolCallId: 'c2', state: 'output-available', input: { resultId: 'ro_abc12345' }, output: read },
          { type: 'text', text: 'Read.' },
        ],
      },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'And now?' }] },
    ];
    const prepared = await prepareModelMessages(messages as never, { entities });
    const result = JSON.stringify(prepared);
    expect(result).toContain('{"trackNo":125,"label_text":"Late 25"}');
    const plain = JSON.stringify(await prepareModelMessages(messages as never));
    expect(plain).not.toContain('{"trackNo":125,"label_text":"Late 25"}');
  });
});

describe('read_result producers across turns', () => {
  const entities = { tracks_list: { output: [{ ...TRACK, path: 'data[]' }] } };
  const producerTurn = [
    { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Tracks?' }] },
    { id: 'a0', role: 'assistant', parts: [
      { type: 'tool-tracks_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { data: [{ trackNo: 1, label_text: 'One' }], _result: { id: 'ro_abc12345', hint: 'x' } } },
      { type: 'text', text: 'One.' },
    ] },
  ];

  it('compacts a later turn\'s read_result answer with the producer of an earlier turn', async () => {
    const read = { data: Array.from({ length: 30 }, (_, index) => ({ trackNo: index + 100, label_text: `Late ${index}`, albumId: 7, lyrics: 'x'.repeat(50) })) };
    const messages = [
      ...producerTurn,
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'More?' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'tool-read_result', toolCallId: 'c2', state: 'output-available', input: { resultId: 'ro_abc12345' }, output: read },
        { type: 'text', text: 'Read.' },
      ] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'And now?' }] },
    ];
    const prepared = JSON.stringify(await prepareModelMessages(messages as never, { entities }));
    expect(prepared).toContain('{"trackNo":125,"label_text":"Late 25"}');
  });

  it('streams with the producers of earlier turns', async () => {
    const parts = [
      { type: 'tool-result', toolCallId: 'c2', toolName: 'read_result', input: { resultId: 'ro_abc12345' }, output: { data: [{ trackNo: 42, label_text: 'Late' }] } },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', text: 'Late (ID: 42) is here.' },
      { type: 'text-end', id: 't' },
    ];
    const stream = convertArrayToReadableStream(parts as never)
      .pipeThrough(createHideIdsTransform(new Map(), { entities, messages: producerTurn })({ tools: {}, stopStream: () => {} }) as never);
    let text = '';
    for await (const part of stream as unknown as AsyncIterable<{ type: string; text?: string }>) if (part.type === 'text-delta') text += part.text;
    expect(text).toBe('Late is here.');
  });
});

describe('hideIds and composite keys', () => {
  it('names the whole composite key, never its parts', () => {
    const labels: IdLabels = new Map();
    collectDeclaredIdLabels({ data: [
      { parent: 'abc123456', child: 'def123456', title: 'Dokument' },
      { parent: 'abc123456', child: 'ghi123456', title: 'Anhang' },
    ] }, [{ id: ['parent', 'child'], name: 'title' }], labels);
    expect(redactIds('See abc123456/def123456 and abc123456/ghi123456, parent abc123456.', labels))
      .toBe('See Dokument and Anhang, parent.');
  });
});
