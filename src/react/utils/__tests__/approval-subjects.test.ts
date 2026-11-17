import { describe, expect, it } from 'vitest';
import { resolveApprovalSubjects, isIdKey } from '../approval-subjects.js';
import { collectEntitySightings } from '../entity-names.js';

const P1 = '14f1e041-4609-4b24-a723-631b133115cc';
const P2 = '0df1344c-6fa7-4ea1-bc23-f0d12e01a0b1';
const P3 = 'a42b5f62-5851-4350-bd72-187314ae3e4f';
const ALBUM = '6c1d1a3e-2b0f-4f61-9c55-3e6a1f6f2b11';
const UNSEEN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';

function tool(name: string, output: unknown) {
  return { role: 'assistant', parts: [{ type: `tool-${name}`, toolCallId: `c-${name}`, state: 'output-available', input: {}, output }] };
}

describe('collectEntitySightings', () => {
  it('reads the entries an overview kept', () => {
    const seen = collectEntitySightings([
      tool('playlists_list', {
        success: true,
        data: [{ id: P1, name: 'Abend-Promos' }, { id: P2, name: 'Morgen-Mix' }],
        _result: { id: 'ro_ab12cd34', arrays: { data: 2 }, showing: 2, total: 2, omitted: ['data[].tracks'], hint: 'Overview: …' },
      }),
    ]);
    expect(seen.get(P1)?.name).toBe('Abend-Promos');
    expect(seen.get(P2)?.name).toBe('Morgen-Mix');
  });

  it('reads read_result answers, their identity fields and indexed reads keyed by index', () => {
    const seen = collectEntitySightings([
      tool('read_result', {
        data: [{ id: 'd3', name: 'Design 3', draftVersion: { variants: [] } }],
        _result: { id: 'ro_ab12cd34', offset: 3, returned: 1, total: 5, nextOffset: 4 },
      }),
      tool('read_result', {
        data: { 2: { id: P3, title: 'Wochenende', items: [{ id: ALBUM, name: 'Album X' }] } },
        _result: { id: 'ro_ab12cd34', offset: 0, returned: 1, total: 1 },
      }),
    ]);
    expect(seen.get('d3')?.name).toBe('Design 3');
    expect(seen.get(P3)?.name).toBe('Wochenende');
    expect(seen.get(ALBUM)?.name).toBe('Album X');
  });

  it('reads integer ids and mentions the user picked, not those the model wrote', () => {
    const seen = collectEntitySightings([
      tool('users_list', { data: [{ id: 7, displayName: 'Ada' }] }),
      { role: 'user', parts: [{ type: 'text', text: 'Lösch {{mention:playlist:p-9:Sommerhits}}' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Meinst du {{mention:playlist:p-10:Erfunden}}?' }] },
    ]);
    expect(seen.get('7')?.name).toBe('Ada');
    expect(seen.get('p-9')).toEqual({ name: 'Sommerhits', names: ['Sommerhits'], type: 'playlist' });
    expect(seen.has('p-10')).toBe(false);
  });

  it('keeps every distinct name, most recent first', () => {
    const seen = collectEntitySightings([
      tool('playlists_list', { data: [{ id: 'p-1', name: 'Alt' }] }),
      tool('playlists_update', { data: { id: 'p-1', name: 'Neu' } }),
    ]);
    expect(seen.get('p-1')).toEqual({ name: 'Neu', names: ['Neu', 'Alt'] });
  });

  it('keeps the newest results when a long history exceeds the walk budget', () => {
    const big = Array.from({ length: 25_000 }, (_, i) => ({ n: i }));
    const seen = collectEntitySightings([
      tool('bulk', { data: big }),
      tool('playlists_get', { data: { id: P1, name: 'Abend-Promos' } }),
    ]);
    expect(seen.get(P1)?.name).toBe('Abend-Promos');
  });
});

describe('isIdKey', () => {
  it('takes id, ids and keys ending in Id, _id or ID (also plural)', () => {
    for (const key of ['id', 'ids', 'ID', '_id', 'playlistId', 'playlist_id', 'playlistID', 'trackIds', 'track_ids', 'USER_ID']) {
      expect(isIdKey(key), key).toBe(true);
    }
    for (const key of ['paid', 'valid', 'idea', 'identity', 'name', 'width']) {
      expect(isIdKey(key), key).toBe(false);
    }
  });
});

describe('resolveApprovalSubjects', () => {
  const seen = collectEntitySightings([
    tool('playlists_list', { data: [{ id: P1, name: 'Abend-Promos' }, { id: P2, name: 'Morgen-Mix' }] }),
    tool('users_list', { data: [{ id: 7, name: 'Ada' }] }),
    tool('groups_list', { data: [{ id: 7, name: 'Vertrieb' }] }),
    tool('playlists_update', { data: { id: P1, name: 'Abend-Promos neu' } }),
  ]);

  it('names a seen id and labels it by its key', () => {
    expect(resolveApprovalSubjects({ playlistId: P2 }, seen)).toEqual([
      { path: 'playlistId', id: P2, status: 'named', name: 'Morgen-Mix', label: 'Playlist' },
    ]);
  });

  it('marks an unseen id as unknown and keeps it as written', () => {
    expect(resolveApprovalSubjects({ id: UNSEEN.toUpperCase() }, seen)).toEqual([
      { path: 'id', id: UNSEEN.toUpperCase(), status: 'unknown' },
    ]);
  });

  it('checks several id arguments, arrays of ids, nested ids and UUIDs under other keys', () => {
    const subjects = resolveApprovalSubjects({
      targetFolderId: 'f-1',
      trackIds: [P1, UNSEEN],
      playlist: { id: P2 },
      items: [{ productId: 7 }],
      moveTo: P2,
      title: 'Neu',
      count: 3,
    }, seen);
    expect(subjects.map((s) => [s.path, s.label, s.status])).toEqual([
      ['targetFolderId', 'Target folder', 'unknown'],
      ['trackIds', 'Tracks', 'named'],
      ['trackIds', 'Tracks', 'unknown'],
      ['playlist.id', 'Playlist', 'named'],
      ['items[].productId', 'Product', 'ambiguous'],
      ['moveTo', 'Move to', 'named'],
    ]);
  });

  it('shows the latest name of a renamed UUID without a warning, but flags a short id with different names', () => {
    const [renamed] = resolveApprovalSubjects({ id: P1 }, seen);
    expect(renamed).toEqual({ path: 'id', id: P1, status: 'named', name: 'Abend-Promos neu' });
    const [shared] = resolveApprovalSubjects({ userId: 7 }, seen);
    expect(shared).toEqual({ path: 'userId', id: '7', status: 'ambiguous', name: 'Vertrieb', names: ['Vertrieb', 'Ada'], label: 'User' });
  });

  it('labels a bare id by the type of a mention the user picked', () => {
    const mentioned = collectEntitySightings([{ role: 'user', parts: [{ type: 'text', text: '{{mention:playlist:p-9:Sommerhits}}' }] }]);
    expect(resolveApprovalSubjects({ id: 'p-9' }, mentioned)).toEqual([
      { path: 'id', id: 'p-9', status: 'named', name: 'Sommerhits', label: 'Playlist' },
    ]);
  });

  it('leaves calls without ids alone and bounds the ids checked', () => {
    expect(resolveApprovalSubjects({ title: 'Bericht', done: true, n: 4, tags: ['a'] }, seen)).toEqual([]);
    expect(resolveApprovalSubjects({ ids: Array.from({ length: 500 }, (_, i) => `x-${i}`) }, seen)).toHaveLength(100);
  });
});
