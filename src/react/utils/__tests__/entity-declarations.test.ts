import { describe, expect, it } from 'vitest';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { collectKnownEntities, splitEntityText } from '../../entity-links/entity-links.js';
import { flaggedApprovalSubjects } from '../../components/approval-card.js';
import { resolveApprovalSubjects } from '../approval-subjects.js';
import { collectEntitySightings, collectSeenEntityIds, userTextsOf } from '../entity-names.js';

function tool(name: string, output: unknown, input: unknown = {}) {
  return { role: 'assistant', parts: [{ type: `tool-${name}`, toolCallId: `c-${name}`, state: 'output-available', input, output }] };
}
const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] });

/** Albums with a numeric `albumNo`, tracks with a composite key, orders with a speaking key. */
const DECLARED: EntityDeclarationsByTool = {
  albums_list: { output: [{ type: 'album', id: 'albumNo', name: 'caption', path: 'albums[]' }] },
  album_tracks: {
    output: [
      { type: 'album', id: 'albumNo', name: 'caption', path: '' },
      { type: 'track', id: ['albumNo', 'trackNo'], name: 'caption', path: 'tracks[]' },
    ],
  },
  orders_list: { output: [{ type: 'order', id: 'orderKey', name: 'customer', idKind: 'speaking', path: 'orders[]' }] },
  albums_delete: { input: [{ type: 'album', args: 'albumNo' }] },
  tracks_delete: { input: [{ type: 'track', args: ['albumNo', 'trackNo'] }] },
  orders_cancel: { input: [{ type: 'order', args: 'orderKey' }] },
  people_delete: { input: [{ type: 'person', args: 'personNo' }] },
};

const conversation = [
  user('Show albums and the orders, cancel ord-7'),
  tool('albums_list', { albums: [{ albumNo: 4, caption: 'Blue' }, { albumNo: 5, caption: 'Red' }] }),
  tool('album_tracks', { albumNo: 4, caption: 'Blue', tracks: [{ albumNo: 4, trackNo: 1, caption: 'Intro' }, { albumNo: 4, trackNo: 2 }] }),
  tool('orders_list', { orders: [{ orderKey: 'ORD-9', customer: 'Ada' }] }),
];

const subjects = (toolName: string, args: Record<string, unknown>, messages: unknown[] = conversation) => resolveApprovalSubjects(
  args,
  collectEntitySightings(messages, DECLARED),
  collectSeenEntityIds(messages, DECLARED),
  { toolName, inputEntities: DECLARED[toolName]?.input ?? [], userTexts: userTextsOf(messages), declarations: DECLARED },
);

describe('declared identity in the browser', () => {
  it('names a numeric declared id and types the subject', () => {
    expect(subjects('albums_delete', { albumNo: 5 })).toEqual([{
      path: 'albumNo', id: '5', status: 'named', name: 'Red', label: 'Album', type: 'album', role: 'target', idKind: 'opaque', provenance: 'tool-result',
    }]);
  });

  it('resolves a composite key as one subject, also a nested record without a name', () => {
    expect(subjects('tracks_delete', { albumNo: 4, trackNo: 1 })).toEqual([{
      path: 'albumNo,trackNo', id: '4/1', status: 'named', name: 'Intro', label: 'Track', type: 'track', role: 'target', idKind: 'opaque', provenance: 'tool-result',
    }]);
    expect(subjects('tracks_delete', { albumNo: 4, trackNo: 2 })[0]).toMatchObject({ id: '4/2', status: 'seen', provenance: 'tool-result' });
    expect(subjects('tracks_delete', { albumNo: 4, trackNo: 9 })[0]).toMatchObject({ id: '4/9', status: 'unknown' });
  });

  it('matches a speaking key case-insensitively and shows it as the call carries it', () => {
    expect(subjects('orders_cancel', { orderKey: 'ord-9' })).toEqual([{
      path: 'orderKey', id: 'ord-9', status: 'named', name: 'Ada', label: 'Order', type: 'order', role: 'target', idKind: 'speaking', provenance: 'tool-result',
    }]);
  });

  it('counts an id typed verbatim by the user as provenance: seen, no warning', () => {
    const typed = subjects('orders_cancel', { orderKey: 'ORD-7' });
    expect(typed).toEqual([{
      path: 'orderKey', id: 'ORD-7', status: 'seen', label: 'Order', type: 'order', role: 'target', idKind: 'speaking', provenance: 'user-message',
    }]);
    // An opaque id must be typed exactly; a partial word is no provenance.
    expect(subjects('albums_delete', { albumNo: 77 }, [...conversation, user('album 7 please')])[0]).toMatchObject({ status: 'unknown' });
  });

  it('gives a speaking id nobody named no warning, an opaque one a warning', () => {
    const speaking = subjects('orders_cancel', { orderKey: 'ORD-1' });
    const opaque = subjects('albums_delete', { albumNo: 99 });
    expect(speaking[0]).toMatchObject({ status: 'unknown', idKind: 'speaking' });
    const approval = (list: typeof speaking) => [{ id: 'a', toolName: 't', args: {}, messageId: '', description: '', details: [], subjects: list }];
    expect(flaggedApprovalSubjects(approval(speaking))).toEqual([]);
    expect(flaggedApprovalSubjects(approval(opaque))).toHaveLength(1);
  });

  it('never names a declared record of another type (person 4 is not album 4)', () => {
    expect(subjects('people_delete', { personNo: 4 })).toEqual([{
      path: 'personNo', id: '4', status: 'unknown', label: 'Person', type: 'person', role: 'target', idKind: 'opaque',
    }]);
    // The key-based guess is held to the declared type too.
    expect(resolveApprovalSubjects({ person_id: 4 }, collectEntitySightings(conversation, DECLARED), collectSeenEntityIds(conversation, DECLARED)))
      .toEqual([{ path: 'person_id', id: '4', status: 'unknown', label: 'Person' }]);
  });

  it('marks an id only an @ mention named', () => {
    const mentioned = [user('{{mention:album:12:Green}} delete it')];
    expect(subjects('albums_delete', { albumNo: 12 }, mentioned)[0]).toMatchObject({ status: 'named', name: 'Green', provenance: 'mention' });
  });

  it('keeps sightings and subjects of an app without declarations exactly as before', () => {
    const plain = [tool('albums_list', { albums: [{ id: 'a1', name: 'Blue' }] })];
    expect(collectEntitySightings(plain)).toEqual(collectEntitySightings(plain, undefined));
    expect([...collectEntitySightings(plain).values()][0]).toEqual({ name: 'Blue', names: ['Blue'] });
    expect(resolveApprovalSubjects({ id: 'a1' }, collectEntitySightings(plain), collectSeenEntityIds(plain)))
      .toEqual([{ path: 'id', id: 'a1', status: 'named', name: 'Blue' }]);
  });
});

describe('entity links with declarations (D1–D4)', () => {
  it('D1: links the declared records of any tool result, also nested', () => {
    expect(collectKnownEntities(conversation as never, [], DECLARED)).toEqual([
      { type: 'album', id: '4', label: 'Blue' },
      { type: 'album', id: '5', label: 'Red' },
      { type: 'track', id: '4/1', label: 'Intro', data: { idValues: [4, 1] } },
      { type: 'order', id: 'ORD-9', label: 'Ada' },
    ]);
    expect(collectKnownEntities(conversation as never, [])).toEqual([]);
  });

  it('D2: two records with one name link the first by default, stay text with ambiguousNames: text, or ask the hook', () => {
    const known = [{ type: 'album', id: '1', label: 'Lobby Loop' }, { type: 'album', id: '2', label: 'Lobby Loop' }];
    expect(splitEntityText('Lobby Loop', { known })[0]).toMatchObject({ kind: 'entity', reference: { id: '1' } });
    expect(splitEntityText('Lobby Loop', { known, ambiguousNames: 'text' })).toEqual([{ kind: 'text', text: 'Lobby Loop' }]);
    expect(splitEntityText('Lobby Loop', { known, resolveAmbiguous: (_label, candidates) => candidates[1] })[0])
      .toMatchObject({ kind: 'entity', reference: { id: '2' } });
    // The same record twice is no ambiguity.
    expect(splitEntityText('Lobby Loop', { known: [known[0]!, known[0]!], ambiguousNames: 'text' })[0]).toMatchObject({ kind: 'entity' });
  });
});

describe('declared types are compared exactly', () => {
  const VERSIONS: EntityDeclarationsByTool = {
    playlist_versions: { output: [{ type: 'playlist-version', id: 'version_id', fallback: 'n', path: 'versions[]' }] },
    channel_versions_rollback: { input: [{ type: 'channel-version', args: 'version_id' }] },
  };
  const UUID = '3f2a9c1e-4b7d-4e2a-9f10-2c3d4e5f6a7b';

  it('never names a channel-version after a playlist-version with the same id, a UUID included', () => {
    for (const id of [7, UUID]) {
      const messages = [tool('playlist_versions', { versions: [{ version_id: id, n: 3 }] })];
      const resolved = resolveApprovalSubjects({ version_id: id }, collectEntitySightings(messages, VERSIONS), collectSeenEntityIds(messages, VERSIONS), {
        toolName: 'channel_versions_rollback', inputEntities: VERSIONS.channel_versions_rollback!.input!, userTexts: [], declarations: VERSIONS,
      });
      expect(resolved[0]).toMatchObject({ status: 'unknown', type: 'channel-version' });
    }
  });
});

describe('composite keys and nameless records of several types', () => {
  it('keeps composite keys apart whose parts contain the separator', () => {
    const PARTS: EntityDeclarationsByTool = {
      files_list: { output: [{ type: 'file', id: ['dir', 'name'], name: 'title', path: 'files[]' }] },
      files_delete: { input: [{ type: 'file', args: ['dir', 'name'] }] },
    };
    const messages = [tool('files_list', { files: [{ dir: 'a/b', name: 'c', title: 'First' }] })];
    const resolve = (args: Record<string, unknown>) => resolveApprovalSubjects(args, collectEntitySightings(messages, PARTS), collectSeenEntityIds(messages, PARTS), {
      toolName: 'files_delete', inputEntities: PARTS.files_delete!.input!, userTexts: [], declarations: PARTS,
    });
    expect(resolve({ dir: 'a/b', name: 'c' })[0]).toMatchObject({ id: 'a/b/c', status: 'named', name: 'First' });
    expect(resolve({ dir: 'a', name: 'b/c' })[0]).toMatchObject({ id: 'a/b/c', status: 'unknown' });
  });

  it('keeps the fallback of each declared type for one id value', () => {
    const TWO: EntityDeclarationsByTool = {
      playlist_versions: { output: [{ type: 'playlist-version', id: 'version_id', fallback: 'n', path: 'versions[]' }] },
      channel_versions: { output: [{ type: 'channel-version', id: 'version_id', fallback: 'rev', path: 'versions[]' }] },
      playlist_rollback: { input: [{ type: 'playlist-version', args: 'version_id' }] },
      channel_rollback: { input: [{ type: 'channel-version', args: 'version_id' }] },
    };
    const messages = [
      tool('playlist_versions', { versions: [{ version_id: 7, n: 3 }] }),
      tool('channel_versions', { versions: [{ version_id: 7, rev: 9 }] }),
    ];
    const resolve = (toolName: string) => resolveApprovalSubjects({ version_id: 7 }, collectEntitySightings(messages, TWO), collectSeenEntityIds(messages, TWO), {
      toolName, inputEntities: TWO[toolName]!.input!, userTexts: [], declarations: TWO,
    })[0];
    expect(resolve('playlist_rollback')).toMatchObject({ status: 'seen', fallback: 'N 3', fallbackField: 'n' });
    expect(resolve('channel_rollback')).toMatchObject({ status: 'seen', fallback: 'Rev 9', fallbackField: 'rev' });
  });
});

describe('explicit mention types on declared arguments', () => {
  it('does not name a channel-version after a mentioned playlist-version with the same id', () => {
    const REFS: EntityDeclarationsByTool = {
      channel_rollback: { input: [{ type: 'channel-version', args: 'version_id' }] },
      playlist_rollback: { input: [{ type: 'playlist-version', args: 'version_id' }] },
    };
    const messages = [user('{{mention:playlist-version:7:Version A}}')];
    const resolve = (toolName: string) => resolveApprovalSubjects({ version_id: 7 }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName, inputEntities: REFS[toolName]!.input!, userTexts: [], declarations: REFS,
    })[0];
    expect(resolve('channel_rollback')).toMatchObject({ status: 'unknown' });
    expect(resolve('playlist_rollback')).toMatchObject({ status: 'named', name: 'Version A', provenance: 'mention' });
  });
});

describe('exact declared types and read_result links', () => {
  it('keeps playlist-version and playlist.version apart', () => {
    const REFS: EntityDeclarationsByTool = {
      a_list: { output: [{ type: 'playlist-version', id: 'v', name: 'n', path: 'items[]' }] },
      b_rollback: { input: [{ type: 'playlist.version', args: 'v' }] },
    };
    const messages = [tool('a_list', { items: [{ v: 7, n: 'Seven' }] })];
    expect(resolveApprovalSubjects({ v: 7 }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'b_rollback', inputEntities: REFS.b_rollback!.input!, userTexts: [], declarations: REFS,
    })[0]).toMatchObject({ status: 'unknown' });
  });

  it('links a record a read_result answer names, by the producing tool', () => {
    const messages = [
      tool('albums_list', { albums: [{ albumNo: 4 }], _result: { id: 'ro_abc12345', hint: 'Overview' } }),
      { role: 'assistant', parts: [{ type: 'tool-read_result', toolCallId: 'r1', state: 'output-available', input: { resultId: 'ro_abc12345' }, output: { albums: [{ albumNo: 4, caption: 'Blue' }] } }] },
    ];
    expect(collectKnownEntities(messages as never, [], DECLARED)).toEqual([{ type: 'album', id: '4', label: 'Blue' }]);
  });
});

describe('typed composite keys', () => {
  it('never counts a composite key as typed by the user', () => {
    const PARTS: EntityDeclarationsByTool = { files_delete: { input: [{ type: 'file', args: ['dir', 'name'] }] } };
    const resolved = resolveApprovalSubjects({ dir: 'a', name: 'b/c' }, new Map(), new Map(), {
      toolName: 'files_delete', inputEntities: PARTS.files_delete!.input!, userTexts: ['delete a/b/c'], declarations: PARTS,
    });
    expect(resolved[0]).toMatchObject({ id: 'a/b/c', status: 'unknown' });
  });
});

describe('provenance and id kind stay with the type', () => {
  it('takes no id kind from a record of another type', () => {
    const REFS: EntityDeclarationsByTool = {
      channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
      people_delete: { input: [{ type: 'person', args: 'personNo' }] },
    };
    const messages = [tool('channels_list', { channels: [{ key: '4', title: 'Four' }] })];
    const resolved = resolveApprovalSubjects({ personNo: 4 }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'people_delete', inputEntities: REFS.people_delete!.input!, userTexts: userTextsOf(messages), declarations: REFS,
    });
    expect(resolved[0]).toMatchObject({ status: 'unknown', idKind: 'opaque' });
  });

  it('never counts the id inside a mention as typed', () => {
    const REFS: EntityDeclarationsByTool = { channel_rollback: { input: [{ type: 'channel-version', args: 'version_id' }] } };
    const messages = [user('Roll back {{mention:playlist-version:7:Version A}}')];
    expect(userTextsOf(messages)).toEqual(['Roll back  ']);
    const resolved = resolveApprovalSubjects({ version_id: 7 }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'channel_rollback', inputEntities: REFS.channel_rollback!.input!, userTexts: userTextsOf(messages), declarations: REFS,
    });
    expect(resolved[0]).toMatchObject({ status: 'unknown' });
  });
});

describe('typed ids are whole tokens', () => {
  it('does not count 12 of 12.5, 12,5, 12/34 or v:12 as typed, but "album 12." does', () => {
    const typed = (text: string) => subjects('albums_delete', { albumNo: 12 }, [user(text)])[0]!.status;
    for (const text of ['make it 12.5', 'make it 12,5', 'pair 12/34', 'v:12']) expect(typed(text), text).toBe('unknown');
    expect(typed('delete album 12.')).toBe('seen');
  });
});

describe('opaque ids are case-sensitive', () => {
  it('does not name abc-7 after a listed AbC-7, but a speaking key matches either way', () => {
    const REFS: EntityDeclarationsByTool = {
      docs_list: { output: [{ type: 'doc', id: 'ref', name: 'title', path: 'docs[]' }] },
      docs_delete: { input: [{ type: 'doc', args: 'ref' }] },
    };
    const messages = [tool('docs_list', { docs: [{ ref: 'AbC-7', title: 'Upper' }] })];
    const resolve = (ref: string) => resolveApprovalSubjects({ ref }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'docs_delete', inputEntities: REFS.docs_delete!.input!, userTexts: [], declarations: REFS,
    })[0];
    expect(resolve('AbC-7')).toMatchObject({ status: 'named', name: 'Upper' });
    expect(resolve('abc-7')).toMatchObject({ status: 'unknown' });
    expect(subjects('orders_cancel', { orderKey: 'ord-9' })[0]).toMatchObject({ status: 'named', name: 'Ada' });
  });
});

describe('case-sensitive ids of different types', () => {
  it('keeps a document AbC-7 and a folder abc-7 apart', () => {
    const REFS: EntityDeclarationsByTool = {
      docs_list: { output: [{ type: 'document', id: 'ref', name: 'title', path: 'docs[]' }] },
      folders_list: { output: [{ type: 'folder', id: 'ref', name: 'title', path: 'folders[]' }] },
      docs_delete: { input: [{ type: 'document', args: 'ref' }] },
    };
    const messages = [
      tool('docs_list', { docs: [{ ref: 'AbC-7', title: 'Dokument A' }] }),
      tool('folders_list', { folders: [{ ref: 'abc-7', title: 'Ordner' }] }),
    ];
    const resolve = (ref: string) => resolveApprovalSubjects({ ref }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'docs_delete', inputEntities: REFS.docs_delete!.input!, userTexts: [], declarations: REFS,
    })[0];
    expect(resolve('abc-7')).toMatchObject({ status: 'unknown' });
    expect(resolve('AbC-7')).toMatchObject({ status: 'named', name: 'Dokument A' });
  });
});

describe('opaque and speaking ids sharing a lower-cased value', () => {
  it('still names the order abc next to a document ABC', () => {
    const REFS: EntityDeclarationsByTool = {
      docs_list: { output: [{ type: 'document', id: 'ref', name: 'title', path: 'docs[]' }] },
      orders_list: { output: [{ type: 'order', id: 'orderKey', name: 'customer', idKind: 'speaking', path: 'orders[]' }] },
      orders_cancel: { input: [{ type: 'order', args: 'orderKey' }] },
    };
    const messages = [
      tool('docs_list', { docs: [{ ref: 'ABC', title: 'Doc' }] }),
      tool('orders_list', { orders: [{ orderKey: 'abc', customer: 'Ada' }] }),
    ];
    expect(resolveApprovalSubjects({ orderKey: 'abc' }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'orders_cancel', inputEntities: REFS.orders_cancel!.input!, userTexts: [], declarations: REFS,
    })[0]).toMatchObject({ status: 'named', name: 'Ada', idKind: 'speaking' });
  });
});

describe('long composite keys', () => {
  it('looks up a composite key of long parts exactly', () => {
    const REFS: EntityDeclarationsByTool = {
      blobs_list: { output: [{ type: 'blob', id: ['bucket', 'object'], name: 'title', path: 'blobs[]' }] },
      blobs_delete: { input: [{ type: 'blob', args: ['bucket', 'object'] }] },
    };
    const bucket = 'B'.repeat(150);
    const messages = [tool('blobs_list', { blobs: [{ bucket, object: 'O'.repeat(150), title: 'Upper' }] })];
    const resolve = (object: string) => resolveApprovalSubjects({ bucket, object }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'blobs_delete', inputEntities: REFS.blobs_delete!.input!, userTexts: [], declarations: REFS,
    })[0];
    expect(resolve('O'.repeat(150))).toMatchObject({ status: 'named', name: 'Upper' });
    expect(resolve('o'.repeat(150))).toMatchObject({ status: 'unknown' });
  });
});

describe('a mention and a tool result of one declared record', () => {
  it('are one kind: the record stays named', () => {
    const REFS: EntityDeclarationsByTool = {
      versions_list: { output: [{ type: 'playlist-version', id: 'version_id', name: 'label', path: 'versions[]' }] },
      versions_rollback: { input: [{ type: 'playlist-version', args: 'version_id' }] },
    };
    const messages = [
      tool('versions_list', { versions: [{ version_id: 7, label: 'Version A' }] }),
      user('Roll back {{mention:playlist-version:7:Version A}}'),
    ];
    expect(resolveApprovalSubjects({ version_id: 7 }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'versions_rollback', inputEntities: REFS.versions_rollback!.input!, userTexts: userTextsOf(messages), declarations: REFS,
    })[0]).toMatchObject({ status: 'named', name: 'Version A' });
  });
});

describe('a mentioned opaque id of other case', () => {
  it('does not name abc-7 after a mention of AbC-7', () => {
    const REFS: EntityDeclarationsByTool = { docs_delete: { input: [{ type: 'doc', args: 'ref', idKind: 'opaque' }] } };
    const messages = [user('{{mention:doc:AbC-7:Dokument A}}')];
    const resolve = (ref: string) => resolveApprovalSubjects({ ref }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'docs_delete', inputEntities: REFS.docs_delete!.input!, userTexts: userTextsOf(messages), declarations: REFS,
    })[0];
    expect(resolve('abc-7')).toMatchObject({ status: 'unknown' });
    expect(resolve('AbC-7')).toMatchObject({ status: 'named', name: 'Dokument A', provenance: 'mention' });
  });
});

describe('reads keep the declared path of the producing result', () => {
  it('does not take a read of the smaller array for the declared records', () => {
    const REFS: EntityDeclarationsByTool = {
      library_get: { output: [{ type: 'track', id: 'n', name: 'title' }] },
      tracks_delete: { input: [{ type: 'track', args: 'n' }] },
    };
    const messages = [
      tool('library_get', {
        tracks: Array.from({ length: 5 }, (_, index) => ({ n: index + 1, title: `Track ${index + 1}` })),
        tags: [{ n: 9, title: 'Tag' }],
        _result: { id: 'ro_abc12345', arrays: { tracks: 5, tags: 1 }, hint: 'x' },
      }),
      { role: 'assistant', parts: [{ type: 'tool-read_result', toolCallId: 'r1', state: 'output-available', input: { resultId: 'ro_abc12345', fields: ['tags'] }, output: { tags: [{ n: 9, title: 'Tag' }] } }] },
      { role: 'assistant', parts: [{ type: 'tool-read_result', toolCallId: 'r2', state: 'output-available', input: { resultId: 'ro_abc12345', fields: ['tracks[]'] }, output: { tracks: [{ n: 8, title: 'Late track' }] } }] },
    ];
    const resolve = (n: number) => resolveApprovalSubjects({ n }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'tracks_delete', inputEntities: REFS.tracks_delete!.input!, userTexts: [], declarations: REFS,
    })[0];
    expect(resolve(9)).toMatchObject({ status: 'unknown' });
    expect(resolve(8)).toMatchObject({ status: 'named', name: 'Late track' });
    expect(collectKnownEntities(messages as never, [], REFS).map((reference) => reference.label)).not.toContain('Tag');
  });
});

describe('composite keys with escaped parts', () => {
  it('resolves four 200-character parts that JSON escapes', () => {
    const REFS: EntityDeclarationsByTool = {
      cells_list: { output: [{ type: 'cell', id: ['a', 'b', 'c', 'd'], name: 'title', path: 'cells[]' }] },
      cells_delete: { input: [{ type: 'cell', args: ['a', 'b', 'c', 'd'] }] },
    };
    const part = '\u0001'.repeat(200);
    const record = { a: part, b: part, c: part, d: part, title: 'Escaped' };
    const messages = [tool('cells_list', { cells: [record] })];
    expect(resolveApprovalSubjects({ a: part, b: part, c: part, d: part }, collectEntitySightings(messages, REFS), collectSeenEntityIds(messages, REFS), {
      toolName: 'cells_delete', inputEntities: REFS.cells_delete!.input!, userTexts: [], declarations: REFS,
    })[0]).toMatchObject({ status: 'named', name: 'Escaped' });
  });
});
