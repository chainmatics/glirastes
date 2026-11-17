import {
  MEMORY_MAX_USER_NOTES,
  readMemoryEntries,
  type MemoryEntry,
} from '../../contracts/memory.js';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Notes about the user that stay in the browser and travel with each chat request. */
export interface BrowserMemoryStore {
  read(): MemoryEntry[];
  write(entries: MemoryEntry[]): void;
}

export interface LocalMemoryStoreOptions {
  /**
   * Key the notes are stored under. Include the signed-in user, so two people
   * on one browser never share notes, e.g. `myapp:memory:${userId}`.
   */
  storageKey: string;
  /** Defaults to `localStorage`; `null` keeps nothing. */
  storage?: KeyValueStorage | null;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

/**
 * Browser-side home of the user's notes for a handler with `memory.user: true`.
 * Pass it to `useVercelAiChatTransport({ memory })`.
 */
export function createLocalMemoryStore(options: LocalMemoryStoreOptions): BrowserMemoryStore {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  return {
    read() {
      try {
        const raw = storage?.getItem(options.storageKey);
        return raw ? readMemoryEntries(JSON.parse(raw), MEMORY_MAX_USER_NOTES) : [];
      } catch {
        return [];
      }
    },
    write(entries) {
      try {
        if (entries.length === 0) storage?.removeItem(options.storageKey);
        else storage?.setItem(options.storageKey, JSON.stringify(entries));
      } catch {
        // storage full or blocked: the notes of this turn are lost, the chat goes on
      }
    },
  };
}
