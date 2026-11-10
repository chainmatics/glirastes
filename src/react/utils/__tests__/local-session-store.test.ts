import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../types.js';
import { createLocalSessionStore } from '../local-session-store.js';

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    },
  };
}

const user = (text: string): ChatMessage => ({ id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }] }) as ChatMessage;
const assistant = (text: string): ChatMessage => ({ id: `a-${text}`, role: 'assistant', parts: [{ type: 'text', text }] }) as ChatMessage;

function store(storage = memory().storage, clock = { now: 1_000 }) {
  let next = 0;
  return createLocalSessionStore({
    storageKey: 'app:u1',
    storage,
    newTitle: 'Neuer Chat',
    now: () => clock.now,
    createId: () => `s${++next}`,
  });
}

describe('chats kept in the browser', () => {
  it('starts with the one default chat the provider opens', async () => {
    expect(await store().list!()).toEqual([{ id: 'default', title: 'Neuer Chat', createdAt: 1_000, updatedAt: 1_000, messageCount: 0 }]);
  });

  it('keeps the messages of each chat apart and gives them back after a reload', async () => {
    const { storage } = memory();
    const first = store(storage);
    const created = await first.create!();
    await first.save!('default', [user('Welche Aufträge sind offen?'), assistant('Zwei.')]);
    await first.save!(created.id, [user('Zeig die Kunden')]);

    const reloaded = store(storage);
    expect((await reloaded.load!('default'))!.map((message) => (message as ChatMessage).id)).toEqual(['u-Welche Aufträge sind offen?', 'a-Zwei.']);
    expect(await reloaded.load!(created.id)).toHaveLength(1);
    expect(await reloaded.load!('unknown')).toBeNull();
  });

  it('names a chat after its first question while it still has the default name', async () => {
    const sessions = store();
    await sessions.save!('default', [user('Welche Aufträge sind heute offen und wem gehören sie eigentlich genau?'), assistant('Zwei.')]);
    expect((await sessions.list!())[0]).toMatchObject({ title: 'Welche Aufträge sind heute offen und wem…', messageCount: 2 });

    await sessions.rename!('default', 'Offene Aufträge');
    await sessions.save!('default', [user('Etwas ganz anderes'), assistant('Gut.')]);
    expect((await sessions.list!())[0]!.title).toBe('Offene Aufträge');
  });

  it('lists the chat used last first', async () => {
    const clock = { now: 1_000 };
    const sessions = store(memory().storage, clock);
    clock.now = 2_000;
    const second = await sessions.create!({ title: 'Zweiter' });
    clock.now = 3_000;
    await sessions.save!('default', [user('Hallo')]);

    expect((await sessions.list!()).map((session) => session.id)).toEqual(['default', second.id]);
  });

  it('removes a chat with its messages, clears one without removing it, and never lists none', async () => {
    const { storage, data } = memory();
    const sessions = store(storage);
    const second = await sessions.create!();
    await sessions.save!(second.id, [user('Hallo')]);

    await sessions.clear!(second.id);
    expect(await sessions.load!(second.id)).toBeNull();
    expect((await sessions.list!()).map((session) => session.id)).toContain(second.id);

    await sessions.remove!(second.id);
    await sessions.remove!('default');
    expect([...data.keys()].filter((key) => key.includes(':messages:'))).toEqual([]);
    expect(await sessions.list!()).toEqual([expect.objectContaining({ id: 'default', title: 'Neuer Chat' })]);
  });

  it('drops the oldest chats beyond the limit, with their messages', async () => {
    const { storage, data } = memory();
    const clock = { now: 0 };
    let next = 0;
    const sessions = createLocalSessionStore({
      storageKey: 'app:u1', storage, maxSessions: 2, now: () => ++clock.now, createId: () => `s${++next}`,
    });
    await sessions.save!('default', [user('Erster')]);
    const second = await sessions.create!();
    const third = await sessions.create!();

    expect((await sessions.list!()).map((session) => session.id)).toEqual([third.id, second.id]);
    expect(data.has('app:u1:messages:default')).toBe(false);
  });

  it('works as one unsaved chat when the browser gives no storage, and survives broken stored data', async () => {
    const none = createLocalSessionStore({ storageKey: 'app:u1', storage: null, newTitle: 'Neuer Chat' });
    await none.save!('default', [user('Hallo')]);
    expect(await none.load!('default')).toBeNull();
    expect(await none.list!()).toEqual([expect.objectContaining({ id: 'default' })]);

    const { storage, data } = memory();
    data.set('app:u1:sessions', '{not json');
    data.set('app:u1:messages:default', '"text"');
    const broken = store(storage);
    expect(await broken.list!()).toEqual([expect.objectContaining({ id: 'default' })]);
    expect(await broken.load!('default')).toBeNull();
  });

  it('keeps the chats of two users apart', async () => {
    const { storage } = memory();
    const mine = store(storage);
    await mine.save!('default', [user('Meins')]);
    const theirs = createLocalSessionStore({ storageKey: 'app:u2', storage });

    expect(await theirs.load!('default')).toBeNull();
  });
});
