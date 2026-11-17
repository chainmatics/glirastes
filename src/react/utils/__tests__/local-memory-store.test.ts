import { describe, expect, it } from 'vitest';
import { chatRequestBody } from '../../transports/vercel.js';
import { createLocalMemoryStore } from '../local-memory-store.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const note = { id: 'n1', content: 'Prefers short answers.', createdAt: '2026-01-01T00:00:00.000Z' };

describe('createLocalMemoryStore', () => {
  it('keeps notes under its key and drops malformed ones on read', () => {
    const storage = memoryStorage();
    const store = createLocalMemoryStore({ storageKey: 'app:memory:u1', storage });
    expect(store.read()).toEqual([]);

    store.write([note]);
    expect(store.read()).toEqual([note]);

    storage.values.set('app:memory:u1', JSON.stringify([note, { id: 'n2' }, 'junk']));
    expect(store.read()).toEqual([note]);
    storage.values.set('app:memory:u1', '{not json');
    expect(store.read()).toEqual([]);
  });

  it('removes the key when the last note goes', () => {
    const storage = memoryStorage();
    const store = createLocalMemoryStore({ storageKey: 'k', storage });
    store.write([note]);
    store.write([]);
    expect(storage.values.has('k')).toBe(false);
  });

  it('travels in the request body', () => {
    const store = createLocalMemoryStore({ storageKey: 'k', storage: memoryStorage() });
    store.write([note]);
    expect(chatRequestBody(undefined, store)).toMatchObject({ glirastesMemory: { user: [note] } });
    expect(chatRequestBody(undefined)).not.toHaveProperty('glirastesMemory');
  });
});
