// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbAttachmentStore,
  dataUrlToBlob,
  type AttachmentBlobStore,
} from '../attachment-blob-store.js';

function makeStore(indexedDB = new IDBFactory(), storageKey = 'k'): AttachmentBlobStore {
  const store = createIndexedDbAttachmentStore({ storageKey, indexedDB });
  if (!store) throw new Error('store expected');
  return store;
}

async function bytes(blob: Blob): Promise<number[]> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  return Array.from(new Uint8Array(buffer));
}

const file = (text: string, name = 'a.txt', mediaType = 'text/plain') => ({
  blob: new Blob([text], { type: mediaType }),
  name,
  mediaType,
});

describe('IndexedDB attachment store', () => {
  it('round-trips bytes, name and type; unknown id is null', async () => {
    const store = makeStore();
    await store.put('c1', 'f1', file('hello', 'hi.txt'));
    const got = await store.get('c1', 'f1');
    expect(got?.name).toBe('hi.txt');
    expect(got?.mediaType).toBe('text/plain');
    expect(got?.blob.type).toBe('text/plain');
    expect(await bytes(got!.blob)).toEqual(Array.from(new TextEncoder().encode('hello')));
    expect(await store.get('c1', 'nope')).toBeNull();
  });

  it('overwrites an existing key', async () => {
    const store = makeStore();
    await store.put('c1', 'f1', file('one'));
    await store.put('c1', 'f1', file('two'));
    const got = await store.get('c1', 'f1');
    expect(await bytes(got!.blob)).toEqual(Array.from(new TextEncoder().encode('two')));
  });

  it('deleteConversation leaves other conversations', async () => {
    const store = makeStore();
    await store.put('A', 'f', file('a'));
    await store.put('B', 'f', file('b'));
    await store.deleteConversation('A');
    expect(await store.get('A', 'f')).toBeNull();
    expect(await store.get('B', 'f')).not.toBeNull();
  });

  it('deleteAll removes only its own storageKey', async () => {
    const factory = new IDBFactory();
    const one = makeStore(factory, 'one');
    const two = makeStore(factory, 'two');
    await one.put('c', 'f', file('1'));
    await two.put('c', 'f', file('2'));
    await one.deleteAll();
    expect(await one.get('c', 'f')).toBeNull();
    expect(await two.get('c', 'f')).not.toBeNull();
  });

  it('returns null without an IDBFactory', () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      expect(createIndexedDbAttachmentStore({ storageKey: 'k', indexedDB: undefined })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never rejects when open throws', async () => {
    const broken = {
      open() {
        throw new Error('boom');
      },
    } as unknown as IDBFactory;
    const store = makeStore(broken);
    await expect(store.put('c', 'f', file('x'))).resolves.toBeUndefined();
    await expect(store.get('c', 'f')).resolves.toBeNull();
    await expect(store.deleteConversation('c')).resolves.toBeUndefined();
    await expect(store.deleteAll()).resolves.toBeUndefined();
  });

  it('requests persistent storage once across puts', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { ...navigator, storage: { persist } });
    try {
      const store = makeStore();
      await store.put('c', '1', file('a'));
      await store.put('c', '2', file('b'));
      await store.put('c', '3', file('c'));
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL', () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=');
    expect(blob?.type).toBe('image/png');
    expect(blob?.size).toBe(8);
  });

  it('returns null for non-base64 URLs', () => {
    expect(dataUrlToBlob('data:text/plain,hello')).toBeNull();
    expect(dataUrlToBlob('https://x.test/a.png')).toBeNull();
    expect(dataUrlToBlob('data:image/png;base64,@@@')).toBeNull();
  });
});
