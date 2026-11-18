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
      { type: 'track', id: '4/1', label: 'Intro' },
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
