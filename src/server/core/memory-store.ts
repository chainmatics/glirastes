import type { MemoryEntry } from '../../contracts/memory.js';

export type { MemoryEntry } from '../../contracts/memory.js';

/** Whose notes: one user's, or the ones every user of a workspace shares. */
export interface MemoryScope {
  kind: 'user' | 'shared';
  /** The host's key for it, e.g. a user id or a tenant id. */
  key: string;
}

/**
 * Where notes live. Three methods any database can implement; the chat
 * handler enforces sizes and counts, the store only persists.
 */
export interface MemoryStore {
  /** The scope's notes, oldest first. */
  list(scope: MemoryScope): Promise<MemoryEntry[]>;
  /** Stores a note and returns it with the id and timestamp the store gave it. */
  add(scope: MemoryScope, note: { content: string; authorId?: string }): Promise<MemoryEntry>;
  /** Removes a note of this scope; false when the scope has no such note. */
  remove(scope: MemoryScope, id: string): Promise<boolean>;
}

/** Process-local store for tests and single-process development. */
export function createInMemoryMemoryStore(): MemoryStore {
  const scopes = new Map<string, MemoryEntry[]>();
  const notesOf = (scope: MemoryScope) => {
    const key = `${scope.kind}\u0000${scope.key}`;
    let notes = scopes.get(key);
    if (!notes) scopes.set(key, notes = []);
    return notes;
  };
  return {
    async list(scope) {
      return [...notesOf(scope)];
    },
    async add(scope, note) {
      const entry: MemoryEntry = {
        id: globalThis.crypto.randomUUID(),
        content: note.content,
        ...(note.authorId ? { authorId: note.authorId } : {}),
        createdAt: new Date().toISOString(),
      };
      notesOf(scope).push(entry);
      return entry;
    },
    async remove(scope, id) {
      const notes = notesOf(scope);
      const index = notes.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      notes.splice(index, 1);
      return true;
    },
  };
}

/**
 * Checks a store against the contract the chat handler relies on and throws
 * on the first violation. Run it in a test against the real database; it
 * writes into two throwaway scopes and removes what it wrote. Pass `authorId`
 * when the store only accepts real ids there, e.g. a foreign key to users.
 */
export async function verifyMemoryStore(
  store: MemoryStore,
  options: { authorId?: string } = {},
): Promise<void> {
  const authorId = options.authorId ?? 'author-1';
  const run = globalThis.crypto.randomUUID();
  const user: MemoryScope = { kind: 'user', key: `verify-${run}` };
  const shared: MemoryScope = { kind: 'shared', key: `verify-${run}` };
  const fail = (message: string): never => {
    throw new Error(`verifyMemoryStore: ${message}`);
  };
  const created: Array<[MemoryScope, string]> = [];
  try {
    if ((await store.list(user)).length !== 0) fail('a new scope must list no notes');
    const first = await store.add(user, { content: 'first note', authorId });
    created.push([user, first.id]);
    const second = await store.add(user, { content: 'second note' });
    created.push([user, second.id]);
    if (!first.id || first.id === second.id) fail('add must return a unique, non-empty id');
    if (first.content !== 'first note') fail('add must return the stored content');
    if (first.authorId !== authorId) fail('add must keep authorId');
    if (Number.isNaN(Date.parse(first.createdAt))) fail('createdAt must be an ISO timestamp');
    const listed = await store.list(user);
    if (listed.map((entry) => entry.id).join() !== [first.id, second.id].join()) {
      fail('list must return the notes of the scope, oldest first');
    }
    if ((await store.list(shared)).length !== 0) {
      fail('the same key under another kind must be a separate scope');
    }
    if (await store.remove(shared, first.id)) fail('remove must not reach into another scope');
    if ((await store.list(user)).length !== 2) fail('a refused remove must not delete anything');
    if (!(await store.remove(user, first.id))) fail('remove must return true for a removed note');
    if (await store.remove(user, first.id)) fail('remove must return false for a missing note');
    if ((await store.list(user)).map((entry) => entry.id).join() !== second.id) {
      fail('list must no longer return a removed note');
    }
  } finally {
    for (const [scope, id] of created) await store.remove(scope, id).catch(() => undefined);
  }
}
