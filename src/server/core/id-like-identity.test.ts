import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { idLikeFieldsOf, isIdLikeKey, MAX_ID_LIKE_FIELDS } from '../../contracts/record-identity.js';
import { defineTool, type ToolContext } from '../../types.js';
import { compactHistoryResult, HISTORY_MARKER_KEY, type HistoryMarker } from '../adapters/nextjs/history-compaction.js';
import { toolToAiTool } from './index.js';
import { createReadResultTool, readResultHandle, type ReadResultMarker } from './read-result-tool.js';
import { buildResultOverview, type ResultOverviewMarker } from './result-overview.js';
import { parseResultPath } from '../../contracts/result-paths.js';
import { createResultStore, type ResultHandle } from './result-store.js';

type Entry = Record<string, unknown>;
type Overview = Record<string, unknown> & { _result: ResultOverviewMarker };
const ctx = { currentDate: new Date('2026-11-18'), locale: 'en-US' } as ToolContext;
const size = (value: unknown) => JSON.stringify(value).length;

/** Entries whose own id is `playlist_id` (no `id`, `uuid`, `key`, `slug` or `code`), with a foreign key and a long text. */
const playlists = (count = 40, idKey = 'playlist_id', ownerKey = 'owner_id') => ({
  data: Array.from({ length: count }, (_, index) => ({
    [idKey]: index + 1,
    displayName: `Playlist ${index + 1}`,
    [ownerKey]: 100 + (index % 5),
    description: `Text ${index} `.repeat(30),
  })),
});

const read = (value: Entry, fields: string[], extra: Entry = {}) => readResultHandle(
  { id: 'ro_abcdefgh', toolName: 't', readOnly: true, maxChars: 16_000, value } as ResultHandle,
  { resultId: 'ro_abcdefgh', fields, ...extra },
  fields.map((field) => parseResultPath(field)!),
) as Entry & { _result: ReadResultMarker };

describe('id-like fields (record-identity)', () => {
  it('takes keys ending in Id, ID or _id after a word, not words, bare ids or plurals', () => {
    for (const key of ['playlist_id', 'playlistId', 'playlistID', 'user_ID', 'owner_Id', 'x1Id', 'a_id']) expect(isIdLikeKey(key), key).toBe(true);
    for (const key of ['VALID', 'COVID', 'paid', 'id', '_id', 'Id', 'ID', 'track_ids', 'trackIds', 'trackIDs', 'idea', 'video', 'IdCard'])
      expect(isIdLikeKey(key), key).toBe(false);
  });

  it('keeps every id-like scalar of an entry without a recognised id, in key order, bounded', () => {
    expect(idLikeFieldsOf({ name: 'n', playlist_id: 3, ownerId: 'ada', VALID: 1, track_ids: [1, 2], folderId: { id: 1 } }))
      .toEqual(['playlist_id', 'ownerId']);
    // A recognised id: nothing here, the entry keeps today's identity.
    expect(idLikeFieldsOf({ id: 1, folderId: 2 })).toEqual([]);
    expect(idLikeFieldsOf({ key: 'lobby', playlist_id: 3 })).toEqual([]);
    // An unusable recognised id does not count.
    expect(idLikeFieldsOf({ id: '', playlist_id: 3 })).toEqual(['playlist_id']);
    // Values: a non-empty string or a safe integer, the field at most 200 characters.
    expect(idLikeFieldsOf({ aId: 1.5, bId: '', cId: true, dId: null, eId: 'x'.repeat(300), fId: 2 ** 60, gId: 'g' })).toEqual(['gId']);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`f${index}Id`, index]));
    expect(idLikeFieldsOf(many)).toEqual(Object.keys(many).slice(0, MAX_ID_LIKE_FIELDS));
  });
});

describe('overview: an entry without a recognised id keeps every id-like field', () => {
  it('keeps playlist_id and owner_id under a tight limit and leaves the long text out', () => {
    const value = playlists();
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 3_000, readOnly: true }) as Overview;
    expect(size(overview)).toBeLessThanOrEqual(3_000);
    const data = overview.data as Entry[];
    expect(data.length).toBeGreaterThan(0);
    for (const [index, entry] of data.entries()) {
      expect(entry).toEqual({ playlist_id: index + 1, displayName: `Playlist ${index + 1}`, owner_id: 100 + (index % 5) });
    }
    expect(overview._result.omitted!.map((field) => field.path)).toEqual(['data[].description']);
  });

  it('does the same for camelCase ids', () => {
    const overview = buildResultOverview(playlists(40, 'playlistId', 'ownerId'), { id: 'ro_abcdefgh', maxChars: 3_000, readOnly: true }) as Overview;
    expect(Object.keys((overview.data as Entry[])[0]!)).toEqual(['playlistId', 'displayName', 'ownerId']);
  });

  it('still leaves folderId out first next to an id', () => {
    const value = { data: Array.from({ length: 40 }, (_, index) => ({ id: index, kind: ['a', 'b'][index % 2], folderId: 100_000 + index, score: index * 2 })) };
    const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: size(value) - 200, readOnly: true }) as Overview;
    expect(Object.keys((overview.data as Entry[])[0]!)).toEqual(['id', 'kind', 'score']);
    expect(overview._result.omitted!.map((field) => field.path)).toEqual(['data[].folderId']);
  });

  it('holds the bound: other fields go first, then trailing entries; undefined when not even the marker fits', () => {
    const value = { data: Array.from({ length: 200 }, (_, index) => ({
      aId: `a-${index}`, bId: `b-${index}`, c_id: index, d_id: index * 7, label: `L${index}`, text: 't'.repeat(80),
    })) };
    for (const maxChars of [600, 1_500, 4_000, 12_000]) {
      const overview = buildResultOverview(value, { id: 'ro_abcdefgh', maxChars, readOnly: true }) as Overview;
      expect(size(overview), String(maxChars)).toBeLessThanOrEqual(maxChars);
      const data = overview.data as Entry[];
      for (const entry of data) expect(Object.keys(entry)).toEqual(['aId', 'bId', 'c_id', 'd_id', 'label']);
      expect(overview._result.showing).toBe(data.length);
      expect(JSON.stringify(buildResultOverview(value, { id: 'ro_abcdefgh', maxChars, readOnly: true }))).toBe(JSON.stringify(overview));
    }
    expect(buildResultOverview(value, { id: 'ro_abcdefgh', maxChars: 100, readOnly: true })).toBeUndefined();
  });

  it('never brings back a denied field, in the overview or through read_result', async () => {
    const store = createResultStore();
    const tool = defineTool({
      id: 't', description: 'T.', inputSchema: z.object({}), outputDeniedFields: ['data[].owner_id'],
      outputDefaultFields: ['data[].displayName'], execute: async () => playlists(),
    });
    const overview = await toolToAiTool(tool, ctx, 't', { resultStore: store }).execute({}) as Overview;
    expect(JSON.stringify(overview)).not.toContain('owner_id');
    const answer = await toolToAiTool(createReadResultTool(store), ctx, 'read_result', { resultStore: store })
      .execute({ resultId: overview._result.id, fields: ['data[].description'], limit: 2 }) as Entry;
    expect(JSON.stringify(answer)).not.toContain('owner_id');
    expect(Object.keys((answer.data as Entry[])[0]!)).toEqual(['playlist_id', 'displayName', 'description']);
  });
});

describe('history: entries beyond maxItems keep their id-like fields', () => {
  it('keeps playlist_id and owner_id and names them in the marker', () => {
    const compacted = compactHistoryResult(playlists(), { maxItems: 2 }) as Entry;
    const data = compacted.data as Entry[];
    expect(data).toHaveLength(40);
    expect(data[13]).toEqual({ playlist_id: 14, displayName: 'Playlist 14', owner_id: 103 });
    const marker = compacted[HISTORY_MARKER_KEY] as HistoryMarker;
    expect(marker).toMatchObject({ field: 'data', showing: 40, full: 2, total: 40, keys: ['playlist_id', 'owner_id', 'displayName'] });
    expect(marker.hint).toContain('reduced to playlist_id, owner_id, displayName');
  });

  it('keeps them on every level when space is short', () => {
    const value = playlists(40, 'playlist_id', 'owner_id');
    for (const entry of value.data) entry.displayName = `${entry.displayName} ${'n'.repeat(120)}`;
    const compacted = compactHistoryResult(value, { maxItems: 2, maxChars: 2_000 }) as Entry;
    expect(size(compacted)).toBeLessThanOrEqual(2_000);
    for (const entry of compacted.data as Entry[]) expect(Object.keys(entry)).toEqual(['playlist_id', 'displayName', 'owner_id']);
  });
});

describe('read_result: id-like fields of the entries read below an array', () => {
  it('adds playlist_id and owner_id when reading a description', () => {
    const answer = read(playlists(), ['data[].description'], { offset: 3, limit: 1 });
    expect(answer.data).toEqual([{ playlist_id: 4, displayName: 'Playlist 4', owner_id: 103, description: playlists().data[3]!.description }]);
  });
});

/**
 * Entries with a recognised id: overview, history and read_result are the same,
 * byte for byte, as before id-like fields were kept (hashes taken from 0.17.1's code).
 */
describe('entries with a recognised id are unchanged', () => {
  const uuid = (seed: number) => `0b9d5c1e-7a3f-4c2b-9e1d-${String(seed).padStart(12, '0')}`;
  const designs = () => ({
    success: true,
    data: Array.from({ length: 45 }, (_, index) => ({
      id: uuid(index), name: `Design ${index}`, status: ['live', 'draft'][index % 2], brandKitId: uuid(1_000 + index),
      tenant_id: uuid(2_000), folderId: 300 + (index % 7), ownerId: `user-${index % 4}`, body: 'b'.repeat(300 + index),
      draft: { versionId: index, title: `Draft ${index}` },
    })),
  });
  const keyed = () => ({ items: Array.from({ length: 30 }, (_, index) => ({ key: `k${index}`, title: `T${index}`, parent_id: index % 3, text: 'x'.repeat(200) })) });

  it('produces the same overview, history and read_result output', () => {
    const outputs = [
      buildResultOverview(designs(), { id: 'ro_abcdefgh', maxChars: 4_000, readOnly: true }),
      buildResultOverview(designs(), { id: 'ro_abcdefgh', maxChars: 16_000, readOnly: true }),
      buildResultOverview(keyed(), { id: 'rw_abcdefgh', maxChars: 2_000, readOnly: false }),
      compactHistoryResult(designs(), { maxItems: 3 }),
      compactHistoryResult(designs(), { maxItems: 1, maxChars: 1_500 }),
      compactHistoryResult(keyed(), { maxItems: 2 }),
      read(designs(), ['data[].body'], { offset: 2, limit: 3 }),
      read(keyed(), ['items[].text'], { limit: 2 }),
    ];
    const digest = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
    expect(digest).toBe('a0e14617c785b9908329195603b8202de1e126bf4403fc66f1525b5b0ef964fe');
  });
});

describe('the id-like field length bound is the identity field bound', () => {
  // `"playlist_id":"…",` is 200 characters with a 183-character value, 201 with 184.
  const entry = (chars: number): Entry => ({ playlist_id: 'p'.repeat(chars), description: 'text' });

  it('recognises a field of exactly 200 serialized characters and adds it in read_result', () => {
    expect(idLikeFieldsOf(entry(183))).toEqual(['playlist_id']);
    const page = read({ data: [entry(183)] }, ['data[].description']);
    expect((page.data as Entry[])[0]).toHaveProperty('playlist_id');
  });

  it('treats a longer field the same way everywhere: not id-like, not added', () => {
    expect(idLikeFieldsOf(entry(184))).toEqual([]);
    const page = read({ data: [entry(184)] }, ['data[].description']);
    expect((page.data as Entry[])[0]).not.toHaveProperty('playlist_id');
  });
});
