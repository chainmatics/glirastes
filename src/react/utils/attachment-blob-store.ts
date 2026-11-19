export interface StoredAttachment {
  blob: Blob;
  name: string;
  mediaType: string;
}

export interface AttachmentBlobStore {
  put(conversationId: string, id: string, file: StoredAttachment): Promise<void>;
  get(conversationId: string, id: string): Promise<StoredAttachment | null>;
  deleteConversation(conversationId: string): Promise<void>;
  deleteAll(): Promise<void>;
}

const DB_NAME = 'glirastes-chat-attachments';
const DB_VERSION = 1;
const STORE = 'files';

interface AttachmentRecord {
  storageKey: string;
  conversationId: string;
  id: string;
  buffer: ArrayBuffer;
  name: string;
  mediaType: string;
}

// Buffers, not Blobs: Blob structured-cloning is not portable (jsdom, fake-indexeddb).
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(factory: IDBFactory, onClosed: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, {
        keyPath: ['storageKey', 'conversationId', 'id'],
      });
      store.createIndex('byConversation', ['storageKey', 'conversationId']);
      store.createIndex('byStorageKey', 'storageKey');
    };
    req.onsuccess = () => {
      const handle = req.result;
      handle.onversionchange = () => {
        handle.close();
        onClosed();
      };
      handle.onclose = onClosed;
      resolve(handle);
    };
    req.onerror = () => reject(req.error);
  });
}

export function createIndexedDbAttachmentStore(options: {
  storageKey: string;
  indexedDB?: IDBFactory;
}): AttachmentBlobStore | null {
  let factory: IDBFactory | undefined;
  try {
    factory =
      options.indexedDB ??
      (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  } catch {
    return null;
  }
  if (!factory) return null;
  const { storageKey } = options;

  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      try {
        const opened = openDb(factory, () => {
          if (dbPromise === opened) dbPromise = null;
        });
        dbPromise = opened;
      } catch (error) {
        dbPromise = Promise.reject(error);
      }
      const current = dbPromise;
      current.catch(() => {
        if (dbPromise === current) dbPromise = null;
      });
    }
    return dbPromise;
  };

  let persistRequested = false;
  const requestPersistence = () => {
    if (persistRequested) return;
    persistRequested = true;
    try {
      void Promise.resolve(globalThis.navigator?.storage?.persist?.()).catch(
        () => undefined,
      );
    } catch {
      // persistence is best effort
    }
  };

  async function run<T>(fallback: T, work: (db: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      return await work(await db());
    } catch {
      return fallback;
    }
  }

  async function deleteRange(
    handle: IDBDatabase,
    range: (store: IDBObjectStore) => IDBRequest<IDBValidKey[]>,
  ): Promise<void> {
    const tx = handle.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const keys = await request(range(store));
    for (const key of keys) store.delete(key);
    await transactionDone(tx);
  }

  return {
    put: (conversationId, id, file) =>
      run<void>(undefined, async (handle) => {
        requestPersistence();
        const buffer = await readBlob(file.blob);
        const record: AttachmentRecord = {
          storageKey,
          conversationId,
          id,
          buffer,
          name: file.name,
          mediaType: file.mediaType,
        };
        const tx = handle.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        await transactionDone(tx);
      }),
    get: (conversationId, id) =>
      run<StoredAttachment | null>(null, async (handle) => {
        const record = (await request(
          handle
            .transaction(STORE, 'readonly')
            .objectStore(STORE)
            .get([storageKey, conversationId, id]),
        )) as AttachmentRecord | undefined;
        if (!record) return null;
        return { blob: new Blob([record.buffer], { type: record.mediaType }), name: record.name, mediaType: record.mediaType };
      }),
    deleteConversation: (conversationId) =>
      run<void>(undefined, (handle) =>
        deleteRange(handle, (store) =>
          store.index('byConversation').getAllKeys([storageKey, conversationId]),
        ).then(() => undefined),
      ),
    deleteAll: () =>
      run<void>(undefined, (handle) =>
        deleteRange(handle, (store) =>
          store.index('byStorageKey').getAllKeys(storageKey),
        ),
      ),
  };
}

export function createMemoryAttachmentStore(): AttachmentBlobStore {
  const conversations = new Map<string, Map<string, StoredAttachment>>();
  return {
    async put(conversationId, id, file) {
      let files = conversations.get(conversationId);
      if (!files) conversations.set(conversationId, (files = new Map()));
      files.set(id, file);
    },
    async get(conversationId, id) {
      return conversations.get(conversationId)?.get(id) ?? null;
    },
    async deleteConversation(conversationId) {
      conversations.delete(conversationId);
    },
    async deleteAll() {
      conversations.clear();
    },
  };
}

export function dataUrlToBlob(url: string): Blob | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*);base64,(.*)$/s.exec(url);
  if (!match) return null;
  try {
    const binary = atob(match[3]!);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return new Blob([data], { type: match[1] ?? '' });
  } catch {
    return null;
  }
}
