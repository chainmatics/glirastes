import { describe, expect, it } from 'vitest';
import { resolveApprovalSubjects, isIdKey } from '../approval-subjects.js';
import { collectEntitySightings, collectSeenEntityIds } from '../entity-names.js';

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

  it('shows the latest name of a renamed UUID without a warning; a short id of two kinds is named by the kind its key picks', () => {
    const [renamed] = resolveApprovalSubjects({ id: P1 }, seen);
    expect(renamed).toEqual({ path: 'id', id: P1, status: 'named', name: 'Abend-Promos neu' });
    // User 7 and group 7: `userId` picks the users.
    expect(resolveApprovalSubjects({ userId: 7 }, seen)).toEqual([{ path: 'userId', id: '7', status: 'named', name: 'Ada', label: 'User' }]);
    // `productId` picks neither: no name, every candidate.
    expect(resolveApprovalSubjects({ productId: 7 }, seen)).toEqual([{
      path: 'productId', id: '7', status: 'ambiguous', names: ['Vertrieb', 'Ada'], label: 'Product',
      candidates: [{ label: 'Group', name: 'Vertrieb' }, { label: 'User', name: 'Ada' }],
    }]);
  });

  it('flags a short id of one kind shown with different names, as before', () => {
    const renamed = collectEntitySightings([
      tool('users_list', { data: [{ id: 7, name: 'Ada' }] }),
      tool('users_update', { data: { id: 7, name: 'Ada L.' } }),
    ]);
    expect(renamed.get('7')).toEqual({ name: 'Ada L.', names: ['Ada L.', 'Ada'] });
    expect(resolveApprovalSubjects({ userId: 7 }, renamed)).toEqual([
      { path: 'userId', id: '7', status: 'ambiguous', name: 'Ada L.', names: ['Ada L.', 'Ada'], label: 'User' },
    ]);
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

describe('ids a tool result carried without a name', () => {
  const VERSION = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
  const BARE = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f';
  const history = [
    tool('playlist_versions_list', { data: [{ id: VERSION, versionNumber: 3, status: 'draft' }, { id: BARE, createdAt: '2026-11-01' }] }),
    tool('playlists_get', { data: { id: P1, name: 'Abend-Promos', draftVersionId: UNSEEN } }),
  ];

  it('marks such an id as seen, with a fallback field of its record when it has one', () => {
    const subjects = resolveApprovalSubjects(
      { playlistId: P1, versionId: VERSION, baseVersionId: BARE },
      collectEntitySightings(history),
      collectSeenEntityIds(history),
    );
    expect(subjects).toEqual([
      { path: 'playlistId', id: P1, status: 'named', name: 'Abend-Promos', label: 'Playlist' },
      { path: 'versionId', id: VERSION, status: 'seen', label: 'Version', fallback: 'Version number 3' },
      { path: 'baseVersionId', id: BARE, status: 'seen', label: 'Base version' },
    ]);
  });

  it('keeps unknown for an id that occurred only as a reference or nowhere', () => {
    const subjects = resolveApprovalSubjects(
      { versionId: UNSEEN, otherId: 'zz-1' },
      collectEntitySightings(history),
      collectSeenEntityIds(history),
    );
    expect(subjects.map((subject) => subject.status)).toEqual(['unknown', 'unknown']);
  });

  it('reads tool results only, never the model calls or mentions', () => {
    const seen = collectSeenEntityIds([
      { role: 'assistant', parts: [{ type: 'tool-versions_approve', toolCallId: 'c1', state: 'approval-requested', input: { id: VERSION } }] },
      { role: 'user', parts: [{ type: 'text', text: `{{mention:version:${BARE}:Version 2}}` }] },
    ]);
    expect(seen.size).toBe(0);
  });

  it('takes the fallback from the newest result and bounds its length', () => {
    const seen = collectSeenEntityIds([
      tool('versions_list', { data: [{ id: 'v1', version: '1.0' }] }),
      tool('versions_get', { data: { id: 'v1', version: '1.1' } }),
      tool('designs_list', { data: [{ id: 'd1', code: 'x'.repeat(81) }] }),
    ]);
    expect(seen.get('v1')).toEqual({ fallback: 'Version 1.1' });
    expect(seen.get('d1')).toEqual({});
  });
});

describe('an id seen for records of different kinds', () => {
  /** User 3, playlist 3 (own id `playlist_id`), and a version that refers to playlist 3. */
  const history = [
    tool('users_list', { users: [{ id: 1, displayName: 'Ada' }, { id: 3, displayName: 'Linus' }] }),
    tool('playlists_list', { playlists: [{ playlist_id: 3, displayName: 'Lobby Loop' }], _result: { id: 'ro_aaaaaaaa', hint: '…' } }),
  ];
  const resolve = (args: Record<string, unknown>, messages: unknown[] = history, toolName?: string) => resolveApprovalSubjects(
    args, collectEntitySightings(messages), collectSeenEntityIds(messages), toolName ? { toolName } : {},
  );

  it('records the kinds of a colliding id only, newest first', () => {
    const seen = collectEntitySightings(history);
    expect(seen.get('3')).toEqual({
      name: 'Linus', names: ['Linus'],
      kinds: [{ kind: 'playlist', names: ['Lobby Loop'] }, { kind: 'user', names: ['Linus'] }],
    });
    expect(seen.get('1')).toEqual({ name: 'Ada', names: ['Ada'] });
  });

  it('shows no name but every candidate when the argument does not pick a kind', () => {
    const expected = { status: 'ambiguous', names: ['Lobby Loop', 'Linus'], candidates: [{ label: 'Playlist', name: 'Lobby Loop' }, { label: 'User', name: 'Linus' }] };
    expect(resolve({ target_id: 3 })).toEqual([{ path: 'target_id', id: '3', label: 'Target', ...expected }]);
    expect(resolve({ id: 3 })).toEqual([{ path: 'id', id: '3', ...expected }]);
    expect(resolve({ id: 3 }, history, 'archive')).toEqual([{ path: 'id', id: '3', ...expected }]);
  });

  it('names the record when the argument picks exactly one kind: key, parent object or tool name', () => {
    expect(resolve({ playlist_id: 3 })).toEqual([{ path: 'playlist_id', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist' }]);
    expect(resolve({ userId: 3 })).toEqual([{ path: 'userId', id: '3', status: 'named', name: 'Linus', label: 'User' }]);
    expect(resolve({ user: { id: 3 } })).toEqual([{ path: 'user.id', id: '3', status: 'named', name: 'Linus', label: 'User' }]);
    expect(resolve({ id: 3 }, history, 'playlists_delete')).toEqual([{ path: 'id', id: '3', status: 'named', name: 'Lobby Loop' }]);
    expect(resolve({ id: 3 }, history, 'delete_user')).toEqual([{ path: 'id', id: '3', status: 'named', name: 'Linus' }]);
  });

  it('counts a nested record as its own kind (owner), not as the record that holds it', () => {
    const nested = [tool('playlists_list', { data: [{ id: 3, name: 'Lobby Loop', owner: { id: 3, displayName: 'Linus' } }] })];
    expect(collectEntitySightings(nested).get('3')?.kinds).toEqual([{ kind: 'playlist', names: ['Lobby Loop'] }, { kind: 'owner', names: ['Linus'] }]);
    expect(resolve({ playlistId: 3 }, nested)).toEqual([{ path: 'playlistId', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist' }]);
    expect(resolve({ ownerId: 3 }, nested)).toEqual([{ path: 'ownerId', id: '3', status: 'named', name: 'Linus', label: 'Owner' }]);
    expect(resolve({ id: 3 }, nested)[0]).toMatchObject({ status: 'ambiguous', names: ['Lobby Loop', 'Linus'] });
  });

  it('takes the same record from a list, a get and a read_result answer as one kind', () => {
    const same = [
      tool('playlists_list', { data: [{ id: 3, name: 'Lobby Loop' }], _result: { id: 'ro_bbbbbbbb', hint: '…' } }),
      tool('playlists_get', { data: { id: 3, name: 'Lobby Loop', tracks: [{ id: 9, title: 'Intro' }] } }),
      { role: 'assistant', parts: [{ type: 'tool-read_result', toolCallId: 'r1', state: 'output-available',
        input: { resultId: 'ro_bbbbbbbb', fields: ['data[0].name'] }, output: { data: { 0: { id: 3, name: 'Lobby Loop' } } } }] },
      { role: 'user', parts: [{ type: 'text', text: '{{mention:playlist:3:Lobby Loop}}' }] },
    ];
    expect(collectEntitySightings(same).get('3')).toEqual({ name: 'Lobby Loop', names: ['Lobby Loop'], type: 'playlist' });
    expect(resolve({ id: 3 }, same)).toEqual([{ path: 'id', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist' }]);
  });

  it('leaves a UUID seen for two kinds named, as before', () => {
    const uuids = [
      tool('users_list', { data: [{ id: P1, name: 'Ada' }] }),
      tool('playlists_list', { data: [{ id: 'p-1', name: 'Mix', owner: { id: P1, name: 'Ada' } }] }),
    ];
    expect(collectEntitySightings(uuids).get(P1)?.kinds).toHaveLength(2);
    expect(resolve({ assigneeId: P1 }, uuids)).toEqual([{ path: 'assigneeId', id: P1, status: 'named', name: 'Ada', label: 'Assignee' }]);
  });

  it('treats a short text key that two kinds share the same way', () => {
    const keys = [
      tool('teams_list', { teams: [{ id: 'ops', name: 'Operations' }] }),
      tool('channels_list', { channels: [{ id: 'ops', title: 'Ops alerts' }] }),
    ];
    expect(resolve({ channel_id: 'ops' }, keys)).toEqual([{ path: 'channel_id', id: 'ops', status: 'named', name: 'Ops alerts', label: 'Channel' }]);
    expect(resolve({ ref_id: 'OPS' }, keys)).toEqual([{
      path: 'ref_id', id: 'OPS', status: 'ambiguous', names: ['Ops alerts', 'Operations'], label: 'Ref',
      candidates: [{ label: 'Channel', name: 'Ops alerts' }, { label: 'Team', name: 'Operations' }],
    }]);
  });

  it('marks the picked kind as seen when its records had no name', () => {
    const versions = [
      tool('users_list', { users: [{ id: 303, displayName: 'Grace' }] }),
      tool('versions_list', { versions: [{ version_id: 303, versionNumber: 3 }] }),
    ];
    expect(resolve({ version_id: 303 }, versions)).toEqual([{ path: 'version_id', id: '303', status: 'seen', label: 'Version' }]);
    expect(resolve({ x_id: 303 }, versions)[0]).toMatchObject({
      status: 'ambiguous', names: ['Grace'], candidates: [{ label: 'Version' }, { label: 'User', name: 'Grace' }],
    });
  });
});
