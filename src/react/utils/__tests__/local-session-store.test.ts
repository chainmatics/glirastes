// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types.js';
import { clearLocalSessionStore, createLocalSessionStore } from '../local-session-store.js';
import { createMemoryAttachmentStore, type AttachmentBlobStore } from '../attachment-blob-store.js';
import { formatChatCommandMessage } from '../../../contracts/chat-command.js';
import { formatClarificationAnswer } from '../../../contracts/clarification.js';

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

  it('restores the selected chat, including an empty one, and falls back after deletion', async () => {
    const { storage } = memory();
    const sessions = store(storage);
    const created = await sessions.create!();
    sessions.onActiveIdChange!(created.id);
    expect(store(storage).defaultActiveId).toBe(created.id);
    sessions.onActiveIdChange!('default');
    expect(store(storage).defaultActiveId).toBe('default');
    sessions.onActiveIdChange!(created.id);
    await sessions.remove!(created.id);
    expect(store(storage).defaultActiveId).toBe('default');
  });

  it('names a chat after its first question while it still has the default name', async () => {
    const sessions = store();
    await sessions.save!('default', [user('Welche Aufträge sind heute offen und wem gehören sie eigentlich genau?'), assistant('Zwei.')]);
    expect((await sessions.list!())[0]).toMatchObject({ title: 'Welche Aufträge sind heute offen und wem…', messageCount: 2 });

    await sessions.rename!('default', 'Offene Aufträge');
    await sessions.save!('default', [user('Etwas ganz anderes'), assistant('Gut.')]);
    expect((await sessions.list!())[0]!.title).toBe('Offene Aufträge');
  });

  it('names a chat with readable mentions instead of their markup', async () => {
    const sessions = store();
    await sessions.save!('default', [user('{{mention:command:tasks.summarize:Zusammenfassen}} {{mention:task:a65e:Release prüfen}} bitte')]);
    expect((await sessions.list!())[0]!.title).toBe('/Zusammenfassen @Release prüfen bitte');
  });

  // #19: the title is the visible label line, as the bubble shows it, not the marker of a direct command.
  it('names a chat after the visible label of a direct command, without its marker', async () => {
    const sessions = store();
    const text = formatChatCommandMessage({
      commandId: 'tasks.create',
      tool: 'createTask',
      args: { title: 'Release' },
      label: '/Aufgabe anlegen Release',
    });
    await sessions.save!('default', [user(text)]);
    expect((await sessions.list!())[0]!.title).toBe('/Aufgabe anlegen Release');
  });

  it('names a chat without context blocks and clarification markers', async () => {
    const sessions = store();
    await sessions.save!('default', [user('<!-- context: {"page":"tasks"} -->\nWelche Aufgaben sind offen?')]);
    expect((await sessions.list!())[0]!.title).toBe('Welche Aufgaben sind offen?');

    const other = store();
    await other.save!('default', [user(formatClarificationAnswer({ toolCallId: 'call_1', answer: 'Nur meine' }))]);
    expect((await other.list!())[0]!.title).toBe('Nur meine');
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

describe('attachments in stored chats', () => {
  it('stores file parts without their data', async () => {
    const { data, storage } = memory();
    const chats = store(storage);
    const withImage: ChatMessage = {
      id: 'u1', role: 'user',
      parts: [{ type: 'text', text: 'Sieh mal' }, { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'a.png' }],
    };
    await chats.save!('default', [withImage]);
    expect(data.get('app:u1:messages:default')).not.toContain('base64');
    const [loaded] = (await chats.load!('default')) as ChatMessage[];
    expect(loaded!.parts[1]).toEqual({ type: 'file', mediaType: 'image/png', url: '', filename: 'a.png' });
  });
});

describe('attachment files kept as long as their chat', () => {
  const ID_A = 'att_aaaaaaaaaaaaaaaaaaaaaaaa';
  const ID_B = 'att_bbbbbbbbbbbbbbbbbbbbbbbb';
  const DATA = 'data:image/png;base64,AAAA';
  const withFile = (id: string): ChatMessage => ({
    id: `u-${id}`, role: 'user',
    parts: [
      { type: 'text', text: `Datei ${id}` },
      { type: 'file', mediaType: 'image/png', url: DATA, filename: 'a.png', providerMetadata: { glirastes: { attachmentId: id } } },
    ],
  }) as ChatMessage;
  const sessions = (storage: ReturnType<typeof memory>['storage'], attachmentStore: AttachmentBlobStore | null) => {
    let next = 0;
    return createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore, createId: () => `s${++next}` });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('gives a file back after a reload, without base64 in localStorage', async () => {
    const { data, storage } = memory();
    const files = createMemoryAttachmentStore();
    sessions(storage, files).save!('A', [withFile(ID_A)]);
    await flush();
    expect([...data.values()].join('')).not.toContain('base64');

    const [loaded] = (await sessions(storage, files).load!('A')) as ChatMessage[];
    expect((loaded!.parts[1] as { url: string }).url).toMatch(/^data:image\/png;base64,/);
  });

  it('leaves url empty when the file is gone', async () => {
    const { storage } = memory();
    const files = createMemoryAttachmentStore();
    sessions(storage, files).save!('A', [withFile(ID_A)]);
    await flush();
    await files.deleteAll();
    const [loaded] = (await sessions(storage, files).load!('A')) as ChatMessage[];
    expect((loaded!.parts[1] as { url: string }).url).toBe('');
  });

  it('remove deletes the files of that chat only', async () => {
    const { storage } = memory();
    const files = createMemoryAttachmentStore();
    const chats = sessions(storage, files);
    chats.save!('A', [withFile(ID_A)]);
    chats.save!('B', [withFile(ID_B)]);
    await flush();
    await chats.remove!('A');
    expect(await files.get('A', ID_A)).toBeNull();
    expect(await files.get('B', ID_B)).not.toBeNull();
  });

  it('clear deletes the files of that chat', async () => {
    const { storage } = memory();
    const files = createMemoryAttachmentStore();
    const chats = sessions(storage, files);
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    await chats.clear!('A');
    expect(await files.get('A', ID_A)).toBeNull();
  });

  it('deletes the blobs of a chat evicted by maxSessions', async () => {
    const { storage } = memory();
    const files = createMemoryAttachmentStore();
    let at = 0;
    const chats = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: files, maxSessions: 2, now: () => ++at });
    chats.save!('A', [withFile(ID_A)]);
    chats.save!('B', [withFile(ID_B)]);
    await flush();
    chats.save!('C', [user('hi')]);
    await flush();
    expect(await files.get('A', ID_A)).toBeNull();
    expect(await files.get('B', ID_B)).not.toBeNull();
  });

  it('clearLocalSessionStore removes its keys, keeps others and empties the files', async () => {
    const data = new Map<string, string>([['app:u1:x', '1'], ['app:u1:messages:A', '[]'], ['other:u1:x', '2']]);
    const storage = {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    const files = createMemoryAttachmentStore();
    await files.put('A', ID_A, { blob: new Blob(['x']), name: 'a', mediaType: 'image/png' });
    await clearLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: files });
    expect([...data.keys()]).toEqual(['other:u1:x']);
    expect(await files.get('A', ID_A)).toBeNull();
  });

  const slowPut = (inner: AttachmentBlobStore): AttachmentBlobStore => ({
    ...inner,
    put: async (...args) => { await new Promise((resolve) => setTimeout(resolve, 5)); return inner.put(...args); },
  });

  it('remove waits for a pending write, so no blob outlives its chat', async () => {
    const { storage } = memory();
    const inner = createMemoryAttachmentStore();
    const chats = sessions(storage, slowPut(inner));
    chats.save!('A', [withFile(ID_A)]);
    await chats.remove!('A');
    await flush();
    expect(await inner.get('A', ID_A)).toBeNull();
  });

  it('writes a file again after its chat was cleared', async () => {
    const { storage } = memory();
    const files = createMemoryAttachmentStore();
    const chats = sessions(storage, files);
    chats.save!('A', [withFile(ID_A)]);
    await chats.clear!('A');
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    expect(await files.get('A', ID_A)).not.toBeNull();
  });

  it('retries a failed write on the next save', async () => {
    const { storage } = memory();
    const inner = createMemoryAttachmentStore();
    let fail = true;
    const files: AttachmentBlobStore = { ...inner, put: async (...args) => { if (fail) throw new Error('quota'); return inner.put(...args); } };
    const chats = sessions(storage, files);
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    fail = false;
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    expect(await inner.get('A', ID_A)).not.toBeNull();
  });

  it('retries a write that resolved false on the next save', async () => {
    const { storage } = memory();
    const inner = createMemoryAttachmentStore();
    const put = vi.fn(async () => false);
    const chats = sessions(storage, { ...inner, put });
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('gives up on a file after two failed writes', async () => {
    const { storage } = memory();
    const put = vi.fn(async () => false);
    const chats = sessions(storage, { ...createMemoryAttachmentStore(), put });
    for (let i = 0; i < 5; i++) {
      chats.save!('A', [withFile(ID_A)]);
      await flush();
    }
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('does not write restored files again after a reload', async () => {
    const { storage } = memory();
    const inner = createMemoryAttachmentStore();
    sessions(storage, inner).save!('A', [withFile(ID_A)]);
    await flush();
    const put = vi.fn(inner.put);
    const reloaded = sessions(storage, { ...inner, put });
    const loaded = (await reloaded.load!('A')) as ChatMessage[];
    reloaded.save!('A', loaded);
    await flush();
    expect(put).not.toHaveBeenCalled();
  });

  it('survives a store whose methods reject', async () => {
    const { storage } = memory();
    const boom = () => Promise.reject(new Error('boom'));
    const files: AttachmentBlobStore = { put: boom, get: boom, deleteConversation: boom, deleteAll: boom };
    const chats = sessions(storage, files);
    chats.save!('A', [withFile(ID_A)]);
    await flush();
    const [loaded] = (await chats.load!('A')) as ChatMessage[];
    expect((loaded!.parts[1] as { url: string }).url).toBe('');
    await chats.clear!('A');
    await chats.remove!('A');
    await flush();
  });

  it('clearLocalSessionStore leaves a longer storageKey alone', async () => {
    const data = new Map<string, string>([['app:u1:x', '1'], ['app:u10:x', '2']]);
    const storage = {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: () => {},
      removeItem: (key: string) => { data.delete(key); },
    };
    await clearLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    expect([...data.keys()]).toEqual(['app:u10:x']);
  });

  it('exposes the attachment store on the session config', () => {
    const files = createMemoryAttachmentStore();
    expect(sessions(memory().storage, files).attachments).toBe(files);
  });

  it('works without IndexedDB', async () => {
    const { storage } = memory();
    const chats = sessions(storage, null);
    chats.save!('A', [withFile(ID_A)]);
    const loaded = chats.load!('A');
    expect(loaded).not.toBeInstanceOf(Promise);
    expect(((loaded as ChatMessage[])[0]!.parts[1] as { url: string }).url).toBe('');
    await chats.remove!('A');
    expect(chats.attachments).toBeUndefined();
  });
});

describe('maxMessagesPerSession', () => {
  const capped = (max: number | undefined, extra: Record<string, unknown> = {}) => {
    const { storage } = memory();
    return createLocalSessionStore({ storageKey: 'app:u1', storage, maxMessagesPerSession: max, ...extra });
  };
  const ids = async (s: ReturnType<typeof capped>) => (await s.load!('default'))!.map((m) => (m as ChatMessage).id);

  it('keeps the last N messages', async () => {
    const s = capped(2);
    await s.save!('default', [user('a'), assistant('b'), user('c'), assistant('d')]);
    expect(await ids(s)).toEqual(['u-c', 'a-d']);
  });

  it('is unlimited by default and clamps values below 1 to 1', async () => {
    const all = [user('a'), assistant('b'), user('c')];
    const open = capped(undefined);
    await open.save!('default', all);
    expect(await ids(open)).toHaveLength(3);
    const one = capped(0);
    await one.save!('default', all);
    expect(await ids(one)).toEqual(['u-c']);
  });

  it('the kept tail starts with a user message', async () => {
    const s = capped(3);
    await s.save!('default', [user('a'), assistant('b'), assistant('c'), assistant('d')]);
    expect(await ids(s)).toEqual(['u-a', 'a-b', 'a-c', 'a-d']);
    await s.save!('default', [user('a'), assistant('b'), user('c'), assistant('d'), assistant('e')]);
    expect(await ids(s)).toEqual(['u-c', 'a-d', 'a-e']);
    await s.save!('default', [user('a'), assistant('b'), assistant('c'), user('d'), assistant('e')]);
    expect(await ids(s)).toEqual(['u-d', 'a-e']);
  });

  it('title still comes from the first user message ever, messageCount is the stored count', async () => {
    const s = capped(2);
    await s.save!('default', [user('Erste Frage'), assistant('b'), user('c'), assistant('d')]);
    const [entry] = await s.list!();
    expect(entry!.title).toBe('Erste Frage');
    expect(entry!.messageCount).toBe(2);
  });

  it('keeps the derived title when the trimmed list is saved again', async () => {
    const s = capped(2);
    await s.save!('default', [user('Erste Frage'), assistant('b'), user('c'), assistant('d')]);
    const loaded = (await s.load!('default')) as ChatMessage[];
    await s.save!('default', [...loaded, user('e'), assistant('f')]);
    const [entry] = await s.list!();
    expect(entry!.title).toBe('Erste Frage');
  });

  it('without a cap, a placeholder-titled chat keeps deriving its title', async () => {
    const data = memory();
    await store(data.storage).save!('default', [user('Hallo')]);
    let next = 0;
    const localized = createLocalSessionStore({
      storageKey: 'app:u1', storage: data.storage, newTitle: 'New chat', now: () => 2_000, createId: () => `t${++next}`,
    });
    await localized.save!('default', [user('Erste Frage'), assistant('b')]);
    expect((await localized.list!())[0]!.title).toBe('Erste Frage');
  });

  it('writes no blobs for dropped messages', async () => {
    const files = createMemoryAttachmentStore();
    const put = vi.spyOn(files, 'put');
    const withFile = (id: string): ChatMessage => ({
      id, role: 'user',
      parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'a.png', providerMetadata: { glirastes: { attachmentId: id === 'old' ? 'att_oooooooooooooooooooooooo' : 'att_nnnnnnnnnnnnnnnnnnnnnnnn' } } }],
    }) as unknown as ChatMessage;
    const s = capped(1, { attachmentStore: files });
    await s.save!('default', [withFile('old'), assistant('x'), withFile('new')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(put.mock.calls.map((call) => call[1])).toEqual(['att_nnnnnnnnnnnnnnnnnnnnnnnn']);
  });
});

describe('composer drafts kept next to the chats', () => {
  it('draft.save and draft.load round-trip under the storageKey', async () => {
    const { data, storage } = memory();
    const sessions = store(storage);
    const mention = { id: '7', type: 'person', label: 'Bug sieben' };
    await sessions.draft!.save('default', { text: 'halb fertig', mentions: [mention] });
    expect(JSON.parse(data.get('app:u1:draft:default')!)).toEqual({ text: 'halb fertig', mentions: [mention] });
    expect(await store(storage).draft!.load('default')).toEqual({ text: 'halb fertig', mentions: [mention] });
    expect(await store(storage).draft!.load('other')).toBeNull();
  });

  it('save(null) removes the key', async () => {
    const { data, storage } = memory();
    const sessions = store(storage);
    await sessions.draft!.save('default', { text: 'weg damit' });
    await sessions.draft!.save('default', null);
    expect(data.has('app:u1:draft:default')).toBe(false);
  });

  it('remove and clear drop the draft', async () => {
    const { data, storage } = memory();
    const sessions = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null, createId: () => 'x' });
    const created = await sessions.create!();
    await sessions.draft!.save(created.id, { text: 'in x' });
    await sessions.draft!.save('default', { text: 'in default' });
    await sessions.remove!(created.id);
    expect(data.has('app:u1:draft:x')).toBe(false);
    await sessions.clear!();
    expect(data.has('app:u1:draft:default')).toBe(false);
  });

  it('an evicted chat (maxSessions) loses its draft', async () => {
    const { data, storage } = memory();
    const clock = { now: 1_000 };
    let next = 0;
    const sessions = createLocalSessionStore({
      storageKey: 'app:u1', storage, attachmentStore: null, maxSessions: 1, now: () => clock.now, createId: () => `s${++next}`,
    });
    await sessions.save!('default', [user('Erste Frage')]);
    await sessions.draft!.save('default', { text: 'alt' });
    clock.now = 2_000;
    await sessions.create!();
    expect(data.has('app:u1:draft:default')).toBe(false);
  });

  it('clearLocalSessionStore removes drafts', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
    };
    const sessions = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    await sessions.draft!.save('default', { text: 'abmelden' });
    await clearLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    expect(data.has('app:u1:draft:default')).toBe(false);
  });

  it('drafts: false offers no draft adapter', () => {
    expect(createLocalSessionStore({ storageKey: 'app:u1', storage: memory().storage, attachmentStore: null, drafts: false }).draft).toBeUndefined();
  });

  it('drafts are namespaced by storageKey', async () => {
    const { data, storage } = memory();
    const first = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    const second = createLocalSessionStore({ storageKey: 'app:u2', storage, attachmentStore: null });
    await first.draft!.save('default', { text: 'von u1' });
    expect(await second.draft!.load('default')).toBeNull();
    expect(data.has('app:u1:draft:default')).toBe(true);
  });

  it('blocked storage', async () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const sessions = createLocalSessionStore({ storageKey: 'app:u1', storage: blocked, attachmentStore: null });
    await expect(Promise.resolve(sessions.draft!.save('default', { text: 'x' }))).resolves.toBeUndefined();
    expect(await sessions.draft!.load('default')).toBeNull();
  });
});
