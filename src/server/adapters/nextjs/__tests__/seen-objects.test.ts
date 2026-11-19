import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { EntityDeclarationsByTool } from '../../../../contracts/entity-declaration.js';
import { prepareModelMessages, type ModelInputBreakdown } from '../prepare-model-messages.js';
import { collectSeenObjects, renderSeenObjects, SEEN_OBJECTS_HEADER } from '../seen-objects.js';

type Part = Record<string, unknown>;

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const assistant = (id: string, parts: Part[]): UIMessage =>
  ({ id, role: 'assistant', parts }) as UIMessage;
const toolPart = (name: string, id: string, input: unknown, output: unknown): Part => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output,
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const entities: EntityDeclarationsByTool = {
  playlists_list: { output: [{ type: 'playlist', id: 'playlist_id', name: 'displayName', path: 'data[]' }] },
  revisions_list: { output: [{ type: 'channel-revision', id: ['channelKey', 'rev'], path: 'revisions[]', fallback: 'rev' }] },
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', idKind: 'speaking', path: 'channels[]' }] },
};

const playlistResult = (ids: number[]) => ({
  success: true,
  data: ids.map((n) => ({ playlist_id: n, displayName: `Playlist ${n}`, durationSeconds: 1800 })),
});

/** A list turn, then a turn without tools, then the current question. */
function afterThanks(list: Part): UIMessage[] {
  return [
    user('u0', 'Show my playlists'),
    assistant('a0', [{ type: 'step-start' }, list, { type: 'text', text: 'Here they are.' }]),
    user('u1', 'thanks'), assistant('a1', [{ type: 'text', text: 'Welcome.' }]),
    user('uq', 'Rename Playlist 3'),
  ];
}

const memoText = (messages: unknown[]): string | undefined => {
  const first = messages[0] as { role: string; content: Array<{ text: string }> };
  return first.role === 'user' && first.content[0]?.text.startsWith('<seen-objects>') ? first.content[0].text : undefined;
};

describe('seen-objects memo', () => {
  it('is off by default: the model input is unchanged', async () => {
    const messages = afterThanks(toolPart('playlists_list', 'c0', {}, playlistResult([1, 2, 3])));
    const off = await prepareModelMessages(messages, { entities });
    expect(memoText(off)).toBeUndefined();
    expect(JSON.stringify(off)).not.toContain('seen-objects');
  });

  it('lists declared objects of results the history left out, with declared field names and number ids', async () => {
    const messages = afterThanks(toolPart('playlists_list', 'c0', {}, playlistResult([1, 2, 3])));
    let breakdown: ModelInputBreakdown | undefined;
    const sent = await prepareModelMessages(messages, { entities, history: { seenObjects: true }, onBreakdown: (value) => { breakdown = value; } });
    const memo = memoText(sent)!;
    expect(memo).toContain(SEEN_OBJECTS_HEADER);
    expect(memo).toContain('may be outdated or deleted');
    expect(memo).toContain('never invent');
    expect(memo).toContain('Result ids from earlier turns have expired');
    // Most recently seen first; numbers stay numbers; other fields never.
    expect(memo).toContain('playlist: {"playlist_id":3,"displayName":"Playlist 3"}');
    expect(memo.indexOf('"playlist_id":3')).toBeLessThan(memo.indexOf('"playlist_id":1'));
    expect(memo).not.toContain('durationSeconds');
    expect(breakdown!.seenObjects).toMatchObject({ omitted: 0, objects: [{ type: 'playlist' }, {}, {}] });
  });

  it('a tool or a record without declaration contributes nothing, whatever its field names', async () => {
    const undeclared = toolPart('tracks_list', 'c0', {}, { success: true, data: [{ id: uuid(1), name: 'Intro' }] });
    const sent = await prepareModelMessages(afterThanks(undeclared), { entities, history: { seenObjects: true } });
    expect(memoText(sent)).toBeUndefined();
    const noEntities = await prepareModelMessages(afterThanks(toolPart('playlists_list', 'c0', {}, playlistResult([1]))), { history: { seenObjects: true } });
    expect(memoText(noEntities)).toBeUndefined();
  });

  it('leaves out objects the history still shows', async () => {
    const messages: UIMessage[] = [
      user('u0', 'list'), assistant('a0', [{ type: 'step-start' }, toolPart('playlists_list', 'c0', {}, playlistResult([1, 2])), { type: 'text', text: 'Two.' }]),
      user('u1', 'and more'), assistant('a1', [{ type: 'step-start' }, toolPart('playlists_list', 'c1', {}, playlistResult([2, 3])), { type: 'text', text: 'Two.' }]),
      user('uq', 'rename 1'),
    ];
    const sent = await prepareModelMessages(messages, { entities, history: { seenObjects: true } });
    const memo = memoText(sent)!;
    expect(memo).toContain('"playlist_id":1');
    expect(memo).not.toContain('"playlist_id":2');
    expect(memo).not.toContain('"playlist_id":3');
  });

  it('keeps composite and speaking keys exactly, and a fallback for nameless records', async () => {
    const messages = afterThanks(toolPart('revisions_list', 'c0', {}, { revisions: [{ channelKey: 'lobby', rev: 503 }, { channelKey: 'lobby/x', rev: 1 }] }));
    messages.splice(2, 0, user('ux', 'channels'), assistant('ax', [{ type: 'step-start' }, toolPart('channels_list', 'cx', {}, { channels: [{ key: 'LOBBY-1', title: 'Lobby' }] })]));
    const memo = memoText(await prepareModelMessages(messages, { entities, maxContextMessages: 60, history: { seenObjects: true } }))!;
    expect(memo).toContain('channel-revision: {"channelKey":"lobby","rev":503}');
    expect(memo).toContain('channel-revision: {"channelKey":"lobby/x","rev":1}');
    expect(memo).toContain('channel: {"key":"LOBBY-1","title":"Lobby"}');
  });

  it('copies values as the history has them: pseudonyms stay pseudonyms, a removed name stays removed', async () => {
    const result = { success: true, data: [{ playlist_id: 7, displayName: '<PERSON_1>' }, { playlist_id: 8 }] };
    const memo = memoText(await prepareModelMessages(afterThanks(toolPart('playlists_list', 'c0', {}, result)), { entities, history: { seenObjects: true } }))!;
    expect(memo).toContain('"displayName":"<PERSON_1>"');
    // Without its (denied or absent) name the record has nothing to match the user's words: not listed.
    expect(memo).not.toContain('"playlist_id":8');
  });

  it('bounds entries and tokens, dropping the least recently seen first', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => index + 1);
    const messages = afterThanks(toolPart('playlists_list', 'c0', {}, playlistResult(ids)));
    let breakdown: ModelInputBreakdown | undefined;
    const memo = memoText(await prepareModelMessages(messages, { entities, history: { seenObjects: { maxEntries: 5 } }, onBreakdown: (value) => { breakdown = value; } }))!;
    expect(memo).toContain('"playlist_id":60');
    expect(memo).toContain('"playlist_id":56');
    expect(memo).not.toContain('"playlist_id":55,');
    expect(memo).toContain('[55 less recently seen objects left out]');
    expect(breakdown!.seenObjects!.omitted).toBe(55);
    const small = memoText(await prepareModelMessages(messages, { entities, history: { seenObjects: { maxTokens: 200 } } }))!;
    expect(small.length).toBeLessThanOrEqual(200 * 4);
  });

  it('never clips an id whose field is also the declared name', () => {
    const key = `release-${'x'.repeat(80)}`;
    const objects = collectSeenObjects([{ value: { data: [{ key }] }, declarations: [{ type: 'release', id: 'key', name: 'key', path: 'data[]' }] }]);
    expect(objects).toEqual([{ type: 'release', id: [['key', key]] }]);
    expect(renderSeenObjects(objects)!.text).toContain(`release: {"key":"${key}"}`);
  });

  it('an object seen again moves to the front', () => {
    const declarations = entities.playlists_list!.output!;
    const objects = collectSeenObjects([
      { value: playlistResult([1, 2]), declarations },
      { value: playlistResult([1]), declarations },
    ]);
    expect(objects.map((object) => object.id[0]![1])).toEqual([1, 2]);
    expect(renderSeenObjects([], {})).toBeUndefined();
  });

  it('reads earlierMessages the window or chat memory left out, but only their tool results', async () => {
    const earlierMessages = [
      user('e0', 'secret user text'),
      assistant('ea', [{ type: 'step-start' }, toolPart('playlists_list', 'ce', {}, playlistResult([42])), { type: 'text', text: 'One.' }]),
    ];
    const memo = memoText(await prepareModelMessages([user('uq', 'Rename it')], { entities, earlierMessages, history: { seenObjects: true } }))!;
    expect(memo).toContain('"playlist_id":42');
    expect(memo).not.toContain('secret user text');
  });

  it('reads a read_result answer by the declarations of the tool that produced the handle, never promising the handle', async () => {
    const overview = { success: true, data: [{ playlist_id: 1, displayName: 'Playlist 1' }], _result: { id: 'ro_abcd1234', showing: 1, total: 2, hint: 'h' } };
    const read = { success: true, data: { 1: { playlist_id: 2, displayName: 'Playlist 2' } } };
    const messages = afterThanks(toolPart('playlists_list', 'c0', {}, overview));
    (messages[1] as { parts: Part[] }).parts.splice(2, 0, { type: 'step-start' }, toolPart('read_result', 'r0', { resultId: 'ro_abcd1234', path: 'data[1]' }, read));
    const memo = memoText(await prepareModelMessages(messages, { entities, history: { seenObjects: true } }))!;
    expect(memo).toContain('"playlist_id":1');
    expect(memo).toContain('playlist: {"playlist_id":2,"displayName":"Playlist 2"}');
    expect(memo).not.toContain('ro_abcd1234');
  });

  it('lists the entries a still compacted result had to drop, not those it keeps', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => index + 1);
    const messages: UIMessage[] = [
      user('u0', 'list'),
      assistant('a0', [{ type: 'step-start' }, toolPart('playlists_list', 'c0', {}, playlistResult(ids)), { type: 'text', text: 'Many.' }]),
      user('uq', 'rename the last one'),
    ];
    let breakdown: ModelInputBreakdown | undefined;
    const sent = await prepareModelMessages(messages, { entities, history: { seenObjects: true, maxTokens: 1_000 }, onBreakdown: (value) => { breakdown = value; } });
    expect(breakdown!.turns[0]!.mode).toBe('compacted');
    const memo = memoText(sent)!;
    const history = JSON.stringify(sent.slice(1));
    expect(history).not.toContain('"playlist_id":300');
    expect(memo).toContain('playlist: {"playlist_id":300,"displayName":"Playlist 300"}');
    expect(history).toContain('"playlist_id":1,');
    expect(memo).not.toContain('"playlist_id":1,');
  });

  it('is not built with history: false', async () => {
    const messages = afterThanks(toolPart('playlists_list', 'c0', {}, playlistResult([1])));
    const sent = await prepareModelMessages(messages, { entities, history: false });
    expect(memoText(sent)).toBeUndefined();
  });
});
