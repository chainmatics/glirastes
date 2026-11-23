import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  compactHistoryResult,
  compactToolOutput,
  HISTORY_MARKER_KEY,
  HISTORY_TEXT_ONLY_NOTE,
  type HistoryMarker,
} from '../history-compaction.js';
import { prepareModelMessages } from '../prepare-model-messages.js';

type Entry = Record<string, unknown>;
type Compacted = { data: Entry[]; _history: HistoryMarker } & Record<string, unknown>;

const uuid = (index: number) =>
  `${(0x10000000 + index * 7919).toString(16).padStart(8, '0')}-4b5d-4af5-9d20-${(index * 104729).toString(16).padStart(12, '0')}`;

function playlists(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: uuid(index),
    name: `Playlist ${index + 1} Sommerhits`,
    description: 'Eine Sammlung von Liedern für den Sommer und gute Laune.',
    trackCount: 10 + index,
    createdAt: '2026-05-01T10:00:00.000Z',
    ownerId: uuid(1000 + index),
  }));
}

function designs(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    uuid: uuid(index),
    name: `Design ${String(index + 1).padStart(3, '0')} – Herbstkampagne Banner`,
    status: 'draft',
    updatedAt: '2026-05-01T10:00:00.000Z',
  }));
}

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const listTurn = (id: string, name: string, output: unknown, answer: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'step-start' },
    { type: `tool-${name}`, toolCallId: `call-${id}`, state: 'output-available', input: {}, output },
    { type: 'text', text: answer },
  ],
}) as UIMessage;

function toolValues(messages: unknown[]): unknown[] {
  return (messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as Array<{ output: { value: unknown } }>)
    .map((part) => part.output.value);
}

const pairsOf = (entries: Entry[], idKey: string) => entries.map((entry) => [entry[idKey], entry.name]);

/** The pilot: a list in turn 1, a follow-up about one entry in turn 2. */
async function followUp(value: unknown, answer: string, options?: Parameters<typeof prepareModelMessages>[1]) {
  return prepareModelMessages([
    user('u1', 'Welche Playlists gibt es?'),
    listTurn('a1', 'list_playlists', value, answer),
    user('u2', 'Was ist in Playlist 14?'),
  ], options);
}

describe('history compaction keeps every entry\'s identity', () => {
  it('20 playlists: all ids with their own names, entries 11-20 reduced, marked', async () => {
    const source = playlists(20);
    const messages = await followUp({ data: source }, source.map((entry) => entry.name).join('\n'));
    const [value] = toolValues(messages) as [Compacted];
    expect(pairsOf(value.data, 'id')).toEqual(pairsOf(source, 'id'));
    expect(value.data.slice(0, 10)).toEqual(source.slice(0, 10));
    for (const entry of value.data.slice(10)) expect(Object.keys(entry)).toEqual(['id', 'name']);
    expect(value._history).toEqual({
      field: 'data', showing: 20, full: 10, total: 20, keys: ['id', 'name'],
      hint: 'Shortened copy of a result from an earlier turn: 20 of 20 entries of data, the first 10 complete, '
        + 'the other 10 reduced to id, name. Never pair an id with a name from another entry; for fields not shown call a read tool again.',
    });
  });

  it('45 designs with uuid ids: all present, in order', async () => {
    const source = designs(45);
    const messages = await followUp({ data: source }, 'Es gibt 45 Designs.');
    const [value] = toolValues(messages) as [Compacted];
    expect(pairsOf(value.data, 'uuid')).toEqual(pairsOf(source, 'uuid'));
    expect(value._history).toMatchObject({ showing: 45, full: 10, total: 45, keys: ['uuid', 'name'] });
  });

  it('500 designs: the history bound holds, the marker says how many are listed, pairs stay exact', async () => {
    const source = designs(500);
    const messages = await followUp({ data: source }, 'Es gibt 500 Designs.');
    const previous = (messages as unknown[]).slice(0, -1);
    expect(Math.ceil(JSON.stringify(previous).length / 4)).toBeLessThanOrEqual(4_000);
    const [value] = toolValues(messages) as [Compacted];
    const showing = value._history.showing;
    expect(showing).toBeGreaterThan(100);
    expect(showing).toBeLessThan(500);
    expect(value._history).toMatchObject({ full: 0, total: 500, keys: ['uuid', 'name'] });
    expect(value._history.hint).toContain(`${showing} of 500 entries of data, reduced to uuid, name.`);
    expect(value._history.hint).toContain('Entries not listed are not known here: get them with a read tool (call the list tool again) before using their id.');
    expect(value.data).toEqual(source.slice(0, showing).map((entry) => ({ uuid: entry.uuid, name: entry.name })));
  });

  it('keepIdentity: false drops the entries beyond maxItems as before', async () => {
    const source = playlists(20);
    const [value] = toolValues(await followUp({ data: source }, 'ok', { history: { keepIdentity: false } })) as [{ data: unknown[] }];
    expect(value).toEqual(compactToolOutput({ data: source }));
    expect(value.data.at(-1)).toBe('[10 more items, 20 total]');
  });

  it('gives way in order: complete entries (last first), then extra identity fields, then trailing entries', () => {
    const source = Array.from({ length: 30 }, (_, index) => ({
      id: `id-${index}`, slug: `slug-${index}`, title: `Title ${index}`, body: 'x'.repeat(200),
    }));
    const size = (value: unknown) => JSON.stringify(value).length;
    const loose = compactHistoryResult({ data: source }) as Compacted;
    expect(loose._history).toMatchObject({ full: 10, showing: 30, keys: ['id', 'slug', 'title'] });

    const fewerFull = compactHistoryResult({ data: source }, { maxChars: size(loose) - 300 }) as Compacted;
    expect(fewerFull._history.full).toBeLessThan(10);
    expect(fewerFull._history.full).toBeGreaterThan(0);
    expect(fewerFull.data.slice(0, fewerFull._history.full)).toEqual(source.slice(0, fewerFull._history.full));

    const noFull = compactHistoryResult({ data: source }, { maxChars: 1_500 }) as Compacted;
    expect(noFull._history).toMatchObject({ full: 0, showing: 30, keys: ['id', 'title'] });
    expect(noFull.data).toEqual(source.map((entry) => ({ id: entry.id, title: entry.title })));

    const leading = compactHistoryResult({ data: source }, { maxChars: 900 }) as Compacted;
    expect(leading._history.full).toBe(0);
    expect(leading._history.showing).toBeLessThan(30);
    expect(leading.data).toEqual(source.slice(0, leading._history.showing).map((entry) => ({ id: entry.id, title: entry.title })));
    expect(size(leading)).toBeLessThanOrEqual(900);

    // Not even the marker fits: the earlier compaction, and the caller sends the turn as text.
    expect(compactHistoryResult({ data: source }, { maxChars: 50 })).toEqual(compactToolOutput({ data: source }));
  });

  it('clips long names before leaving entries out, and keeps a name too long to be an identity field', () => {
    const long = (index: number) => `Kampagne ${index} ${'Herbst Winter Frühjahr Sommer '.repeat(4)}`;
    const source = Array.from({ length: 40 }, (_, index) => ({ id: `d-${index}`, name: long(index) }));
    const loose = compactHistoryResult({ data: source }, { maxItems: 0 }) as Compacted;
    expect(loose.data[3]).toEqual({ id: 'd-3', name: long(3) });
    const tight = compactHistoryResult({ data: source }, { maxItems: 0, maxChars: JSON.stringify(loose).length - 500 }) as Compacted;
    expect(tight._history.showing).toBe(40);
    expect(tight.data[3]).toEqual({ id: 'd-3', name: `${long(3).slice(0, 60)}…[clipped]` });
    expect(tight._history.hint).toContain('Names ending in …[clipped] are shortened.');
    // A name over 200 characters is no identity field of the overview, but a reduced entry keeps it clipped.
    const huge = compactHistoryResult({ data: [{ id: 'x', name: 'n'.repeat(400) }] }, { maxItems: 0 }) as Compacted;
    expect(huge.data[0]).toEqual({ id: 'x', name: `${'n'.repeat(60)}…[clipped]` });
  });

  it('nested shapes: the dominant array is reduced, other fields stay', () => {
    const meta = { page: 1, note: 'n'.repeat(400) };
    const value = compactHistoryResult({ result: { items: playlists(15) }, meta }) as {
      result: { items: Entry[] }; meta: unknown; _history: HistoryMarker;
    };
    expect(value.meta).toEqual(compactToolOutput(meta));
    expect(value.result.items).toHaveLength(15);
    expect(value._history).toMatchObject({ field: 'result.items', showing: 15, full: 10 });
  });

  it('a top-level array becomes { data, _history }', () => {
    const value = compactHistoryResult(playlists(12)) as Compacted;
    expect(Object.keys(value)).toEqual(['data', HISTORY_MARKER_KEY]);
    expect(value.data).toHaveLength(12);
    expect(value._history.field).toBe('data');
  });

  it('nested arrays inside entries keep the earlier treatment', () => {
    const source = Array.from({ length: 12 }, (_, index) => ({
      id: `p-${index}`, name: `P ${index}`, tracks: Array.from({ length: 15 }, (__, track) => ({ id: `t-${track}`, name: `T ${track}` })),
    }));
    const value = compactHistoryResult({ data: source }) as Compacted;
    expect((value.data[0]!.tracks as unknown[]).at(-1)).toBe('[5 more items, 15 total]');
    expect(value.data[11]).toEqual({ id: 'p-11', name: 'P 11' });
  });

  it('entries without identity fields and non-object entries keep the earlier compaction', () => {
    const anonymous = { data: Array.from({ length: 20 }, (_, index) => ({ count: index, note: 'x' })) };
    expect(compactHistoryResult(anonymous)).toEqual(compactToolOutput(anonymous));
    const scalars = { data: Array.from({ length: 20 }, (_, index) => `name ${index}`) };
    expect(compactHistoryResult(scalars)).toEqual(compactToolOutput(scalars));
    // Mixed: entries beyond the complete ones without identity are left out and counted.
    const mixed = { data: [...playlists(10), 'loose', { count: 1 }, ...playlists(12).slice(10)] };
    const value = compactHistoryResult(mixed) as Compacted;
    expect(value.data.slice(10)).toEqual(playlists(12).slice(10).map((entry) => ({ id: entry.id, name: entry.name })));
    expect(value._history).toMatchObject({ showing: 12, total: 14 });
    expect(value._history.hint).toContain('Entries not listed are not known here');
  });

  it('an already cut result keeps its _truncated marker and reports the original total', () => {
    const cut = {
      data: designs(40),
      _truncated: { field: 'data', showing: 40, total: 500, hint: 'Result cut to fit the size limit: showing 40 of 500 entries of data.' },
    };
    const value = compactHistoryResult(cut) as Compacted & { _truncated: unknown };
    expect(value._truncated).toEqual(cut._truncated);
    expect(value._history).toMatchObject({ showing: 40, full: 10, total: 500 });
    expect(value._history.hint).toContain('40 of 500 entries of data');
    expect(value._history.hint).toContain('Entries not listed are not known here');
  });

  it('an overview from an earlier turn says its handle expired, with the read or write instruction', () => {
    const overview = (id: string, count: number) => ({
      data: designs(count).map(({ uuid: key, name }) => ({ uuid: key, name })),
      _result: { id, showing: count, total: 60, hint: 'Overview: 45 of 60 entries of data. Read more with read_result in this turn.' },
    });
    const read = compactHistoryResult(overview('ro_abc', 45)) as Compacted & { _result: Record<string, unknown> };
    expect(read._result).toMatchObject({ id: 'ro_abc', showing: 45, total: 60 });
    expect(read._result.hint).toBe('From an earlier turn: this result id has expired, do not pass it to read_result. '
      + 'For anything not shown, call the original tool again.');
    expect(read._history).toMatchObject({ showing: 45, total: 60 });

    const write = compactHistoryResult(overview('rw_abc', 5)) as { _result: Record<string, unknown> };
    expect(write._result.hint).toBe('From an earlier turn: this result id has expired, do not pass it to read_result. '
      + 'For anything not shown, do not call the tool again (it has run); say the details are no longer available or use a read tool.');
    // Below the limits only the hint differs.
    expect({ ...write, _result: { ...write._result, hint: 'x' } })
      .toEqual(compactToolOutput({ ...overview('rw_abc', 5), _result: { ...overview('rw_abc', 5)._result, hint: 'x' } }));
    // A payload's own `_result` (no handle id) is left alone.
    const own = { _result: { id: 'abc', hint: 'own' } };
    expect(compactHistoryResult(own)).toEqual(own);
  });

  it('results at or below the limits are byte-identical to the earlier compaction', () => {
    const samples: unknown[] = [
      { data: playlists(10) },
      playlists(3),
      { tasks: playlists(10), meta: { text: 'y'.repeat(500) } },
      'plain text result',
      { success: false, error: 'x'.repeat(400) },
      { list: [1, 2, 3], nested: { deep: { deeper: { deepest: { bottom: { floor: [1] } } } } } },
    ];
    for (const sample of samples) {
      expect(JSON.stringify(compactHistoryResult(sample))).toBe(JSON.stringify(compactToolOutput(sample)));
    }
  });
});

describe('history text-only note', () => {
  const short = (id: string) => listTurn(id, 'list_playlists', { data: playlists(3) }, `Antwort ${id}`);
  const noteCount = (messages: unknown[]) => JSON.stringify(messages).split(HISTORY_TEXT_ONLY_NOTE.slice(0, 40)).length - 1;

  it('the newest turn sent as text whose tool results were left out says so, once', async () => {
    const messages = await prepareModelMessages([
      user('u1', 'Eins'), short('a1'),
      user('u2', 'Zwei'), short('a2'),
      user('u3', 'Drei'), short('a3'),
      user('u4', 'Vier'),
    ]);
    expect(noteCount(messages)).toBe(1);
    const assistantTexts = (messages as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === 'assistant')
      .map((message) => JSON.stringify(message.content));
    // a1 and a2 went as text; a2 carries the note, a3 keeps its tool results.
    expect(assistantTexts[1]).toContain(HISTORY_TEXT_ONLY_NOTE);
    expect(toolValues(messages)).toHaveLength(1);
  });

  it('a previous turn too large for its results goes as text with the note', async () => {
    const value = { blob: 'z'.repeat(40_000) };
    const messages = await followUp(value, 'Fertig.', { history: { maxStringLength: 100_000 } });
    expect(toolValues(messages)).toHaveLength(0);
    expect(JSON.stringify(messages)).toContain(HISTORY_TEXT_ONLY_NOTE);
  });

  it('no note without tool results left out', async () => {
    const plain = await prepareModelMessages([
      user('u1', 'Hallo'), { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi.' }] } as UIMessage,
      user('u2', 'Und?'), { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Ja.' }] } as UIMessage,
      user('u3', 'Gut.'),
    ]);
    expect(noteCount(plain)).toBe(0);
    const kept = await prepareModelMessages([user('u1', 'Eins'), short('a1'), user('u2', 'Zwei')]);
    expect(noteCount(kept)).toBe(0);
  });

  it('the note counts against the token budget', async () => {
    const answer = 'w'.repeat(3_000);
    const messages = await prepareModelMessages([
      user('u1', 'Eins'), listTurn('a1', 'list_playlists', { data: playlists(2) }, answer),
      user('u2', 'Zwei'), listTurn('a2', 'list_playlists', { data: playlists(2) }, answer),
      user('u3', 'Drei'),
    ], { history: { maxTokens: 2_000 } });
    expect(Math.ceil(JSON.stringify((messages as unknown[]).slice(0, -1)).length / 4)).toBeLessThanOrEqual(2_000);
  });
});

/** A small deterministic PRNG so the property test is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ID_KEYS = ['id', 'uuid', 'key', 'slug', 'code'];
const NAME_KEYS = ['name', 'title', 'label', 'displayName'];

function randomEntry(next: () => number, index: number, loose: number): unknown {
  const roll = next();
  if (roll < loose / 2) return `scalar ${index}`;
  if (roll < loose) return { other: index };
  const entry: Entry = {};
  const keys = [...ID_KEYS, ...NAME_KEYS, 'body', 'ownerId', 'tags'].filter(() => next() < 0.45);
  for (const key of keys) {
    if (key === 'tags') entry[key] = Array.from({ length: Math.floor(next() * 14) }, (_, tag) => `t${tag}`);
    else if (key === 'body') entry[key] = 'b"\\é'.repeat(Math.floor(next() * 120));
    else entry[key] = next() < 0.1 ? 'L'.repeat(Math.floor(next() * 300)) : `${key}-${index}-${Math.floor(next() * 1e6)}`;
  }
  return entry;
}

describe('history compaction properties', () => {
  it('every id/name pair is the source\'s, in order; the bound holds; deterministic', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed);
      const loose = next() < 0.5 ? 0 : 0.1;
      const entries = Array.from({ length: Math.floor(next() * 120) }, (_, index) => randomEntry(next, index, loose));
      const value = next() < 0.2 ? entries : next() < 0.5 ? { data: entries, meta: { n: entries.length } } : { page: { items: entries } };
      const options = {
        maxItems: Math.floor(next() * 15),
        maxStringLength: 5 + Math.floor(next() * 400),
        maxChars: 200 + Math.floor(next() * (next() < 0.5 ? 4_000 : 40_000)),
      };
      const label = `seed ${seed}`;
      const output = compactHistoryResult(value, options);
      expect(JSON.stringify(compactHistoryResult(value, options)), label).toBe(JSON.stringify(output));
      if (typeof output !== 'object' || output === null || !(HISTORY_MARKER_KEY in output)) continue;
      expect(JSON.stringify(output).length, label).toBeLessThanOrEqual(options.maxChars);
      const marker = (output as Record<string, HistoryMarker>)[HISTORY_MARKER_KEY]!;
      const listed = (marker.field === 'data'
        ? (output as unknown as { data: unknown[] }).data
        : (output as unknown as { page: { items: unknown[] } }).page.items);
      expect(listed, label).toHaveLength(marker.showing);
      // Reduced entries: identity fields only, exactly a source entry's, sources in increasing order.
      let from = marker.full;
      for (const entry of listed.slice(marker.full) as Entry[]) {
        const keys = Object.keys(entry);
        // `ownerId` is id-like: kept only by an entry without a recognised id (checked below).
        expect(keys.every((key) => ID_KEYS.includes(key) || NAME_KEYS.includes(key) || key === 'ownerId'), label).toBe(true);
        const same = (candidate: Entry, key: string) => candidate[key] === entry[key]
          || (typeof entry[key] === 'string' && (entry[key] as string).endsWith('…[clipped]')
            && NAME_KEYS.includes(key) && typeof candidate[key] === 'string'
            && (candidate[key] as string).startsWith((entry[key] as string).slice(0, -'…[clipped]'.length)));
        const match = entries.findIndex((candidate, index) => index >= from
          && typeof candidate === 'object' && candidate !== null
          && keys.every((key) => same(candidate as Entry, key)));
        expect(match, label).toBeGreaterThanOrEqual(from);
        // An entry with an id has a name exactly when its source entry has a scalar name.
        const source = entries[match] as Entry;
        const recognised = ID_KEYS.some((key) => typeof source[key] === 'string' && source[key] !== ''
          && JSON.stringify(key).length + 1 + JSON.stringify(source[key]).length <= 200);
        if (keys.includes('ownerId')) expect(recognised, label).toBe(false);
        if (keys.some((key) => ID_KEYS.includes(key))) {
          const sourceHasName = NAME_KEYS.some((key) => key in source && typeof source[key] !== 'object');
          expect(keys.some((key) => NAME_KEYS.includes(key)), label).toBe(sourceHasName);
        }
        from = match + 1;
      }
    }
  });
});
