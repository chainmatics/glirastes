import type { ChatMessage, ChatTriggerDefinition, SessionConfig, SessionSummary, WireChatMessage } from '../types.js';
import { attachmentIdOf } from '../../contracts/attachments.js';
import { fileToDataUrl, omitAttachmentData } from './attachments.js';
import { createIndexedDbAttachmentStore, dataUrlToBlob, type AttachmentBlobStore } from './attachment-blob-store.js';
import { sanitizeStoredMessages } from './sanitize-stored-messages.js';
import { parseMentionSegments } from './mention-markup.js';
import { createMentionPrefixLookup } from '../completions/triggers.js';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'length' | 'key'>>;

export interface LocalSessionStoreOptions {
  /**
   * Prefix of every key this store writes. Include the signed-in user, so two
   * people on one browser never see each other's chats, e.g. `myapp:${userId}`.
   */
  storageKey: string;
  /** Defaults to `localStorage`; `null` keeps nothing (one unsaved chat). */
  storage?: KeyValueStorage | null;
  /** Name of a chat nobody has written in yet. Default: "New chat". */
  newTitle?: string;
  /** Chats kept; the one used longest ago goes first. Default: 30. */
  maxSessions?: number;
  /**
   * Messages kept per chat (newest). Default: no limit. Values below 1 count as
   * 1. The kept part starts with a user message, so it can hold fewer messages
   * than the limit (or more, when the limit would cut off every user message).
   * The title still comes from the first question.
   */
  maxMessagesPerSession?: number;
  /**
   * Where attachment files live (IndexedDB). Default: IndexedDB when `storage`
   * is set; `null` keeps no files.
   */
  attachmentStore?: AttachmentBlobStore | null;
  /**
   * The provider's `triggers` (same array): a title shows a mention of a
   * trigger's `types` with its prefix (`#Bug 7`) instead of `@`.
   */
  triggers?: ReadonlyArray<ChatTriggerDefinition>;
  now?: () => number;
  createId?: () => string;
}

const DEFAULT_ID = 'default';
const TITLE_LENGTH = 40;

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function textOf(message: ChatMessage | WireChatMessage): string {
  const parts = (message as { parts?: unknown }).parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((part): part is { type: 'text'; text: string } =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        && typeof (part as { text?: unknown }).text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/**
 * The newest `max` messages, starting at a user message so the model never
 * gets an assistant or tool turn first. When they hold no user message, it
 * starts at the last user message instead.
 */
function tail<T extends ChatMessage | WireChatMessage>(messages: T[], max: number): T[] {
  if (messages.length <= max) return messages;
  const cut = messages.slice(-max);
  const first = cut.findIndex((message) => message.role === 'user');
  if (first >= 0) return cut.slice(first);
  const last = messages.map((message) => message.role).lastIndexOf('user');
  return last >= 0 ? messages.slice(last) : cut;
}

/** The first question of a chat, cut at a word, as its name. */
function titleFrom(
  messages: ReadonlyArray<ChatMessage | WireChatMessage>,
  prefixOf: (type: string) => string,
): string | null {
  const first = messages.find((message) => message.role === 'user');
  const raw = first ? textOf(first) : '';
  // Mentions read as `@Name` and `/Command`, not as their markup.
  const text = parseMentionSegments(raw, prefixOf)
    .map((segment) => (segment.kind === 'text' ? segment.text : `${segment.mention.prefix ?? ''}${segment.mention.displayName}`))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  if (text.length <= TITLE_LENGTH) return text;
  const head = text.slice(0, TITLE_LENGTH + 1);
  const cut = head.lastIndexOf(' ');
  return `${head.slice(0, cut > 0 ? cut : TITLE_LENGTH)}…`;
}

function isSummary(value: unknown): value is SessionSummary & { createdAt: number; updatedAt: number } {
  const entry = value as Partial<SessionSummary> | null;
  return typeof entry === 'object' && entry !== null
    && typeof entry.id === 'string' && entry.id !== ''
    && typeof entry.title === 'string'
    && typeof entry.createdAt === 'number' && typeof entry.updatedAt === 'number';
}

/** Forgets every chat of this `storageKey` (every key starting with `${storageKey}:`), files included, e.g. on sign-out. */
export async function clearLocalSessionStore(options: {
  storageKey: string;
  storage?: KeyValueStorage | null;
  attachmentStore?: AttachmentBlobStore | null;
}): Promise<void> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const prefix = `${options.storageKey}:`;
  try {
    if (storage?.length !== undefined && storage.key) {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    }
  } catch {
    // storage blocked: nothing to remove
  }
  const files = options.attachmentStore === undefined
    ? createIndexedDbAttachmentStore({ storageKey: options.storageKey })
    : options.attachmentStore;
  await files?.deleteAll();
}

/**
 * Several chats per user, kept in the browser: pass the result as `session`
 * to the chat provider and the session switcher lists them, with new, rename
 * and delete. Nothing leaves the browser, and a chat is gone when its storage
 * is cleared; an app that needs chats on every device supplies its own
 * `SessionConfig` backed by its server instead.
 *
 *   <VercelAiChat endpoint="/api/chat" session={createLocalSessionStore({ storageKey: `myapp:${userId}` })} />
 *
 * Create it once per user (module scope or `useMemo`), not on every render.
 */
export function createLocalSessionStore(options: LocalSessionStoreOptions): SessionConfig {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const newTitle = options.newTitle ?? 'New chat';
  const maxSessions = Math.max(1, options.maxSessions ?? 30);
  const maxMessages = options.maxMessagesPerSession === undefined
    ? Infinity : Math.max(1, Math.floor(options.maxMessagesPerSession));
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? randomId;
  const prefixOf = createMentionPrefixLookup(options.triggers);
  const files = options.attachmentStore === undefined
    ? (storage ? createIndexedDbAttachmentStore({ storageKey: options.storageKey }) : null)
    : options.attachmentStore;
  const written = new Set<string>();
  const failures = new Map<string, number>();
  // A permanently failing IndexedDB must not re-decode every file on every save.
  const MAX_WRITE_ATTEMPTS = 2;
  const pending = new Map<string, Set<Promise<void>>>();
  // A put must not land after its chat's delete, so the delete waits for it.
  const deleteFiles = async (conversationId: string): Promise<void> => {
    if (!files) return;
    for (const marker of [...written, ...failures.keys()]) {
      if (!marker.startsWith(`${conversationId}\u0000`)) continue;
      written.delete(marker);
      failures.delete(marker);
    }
    await Promise.allSettled([...(pending.get(conversationId) ?? [])]);
    try {
      await files.deleteConversation(conversationId);
    } catch {
      // files stay until the next delete
    }
  };
  const activeKey = `${options.storageKey}:active`;
  const indexKey = `${options.storageKey}:sessions`;
  const messagesKey = (id: string) => `${options.storageKey}:messages:${id}`;
  type Entry = SessionSummary & { createdAt: number; updatedAt: number; named?: boolean; trimmed?: boolean };

  const read = (key: string): unknown => {
    try {
      const raw = storage?.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch {
      return null; // unreadable or not JSON
    }
  };
  const write = (key: string, value: unknown): void => {
    try {
      storage?.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or blocked: the chat goes on unsaved
    }
  };
  const drop = (key: string): void => {
    try {
      storage?.removeItem(key);
    } catch {
      // nothing to remove
    }
  };

  const fresh = (id: string, title = newTitle): Entry => {
    const at = now();
    return { id, title, createdAt: at, updatedAt: at, messageCount: 0 };
  };
  const sorted = (entries: Entry[]) =>
    [...entries].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);

  /** The stored chats, newest first; always at least the default one. */
  const entries = (): Entry[] => {
    const stored = read(indexKey);
    const valid = Array.isArray(stored) ? (stored.filter(isSummary) as Entry[]) : [];
    return valid.length > 0 ? sorted(valid) : [fresh(DEFAULT_ID)];
  };
  const persist = (list: Entry[]): Entry[] => {
    const ordered = sorted(list);
    for (const removed of ordered.slice(maxSessions)) {
      drop(messagesKey(removed.id));
      void deleteFiles(removed.id);
    }
    const kept = ordered.slice(0, maxSessions);
    write(indexKey, kept);
    return kept;
  };
  const summary = ({ named: _named, trimmed: _trimmed, ...entry }: Entry): SessionSummary => entry;

  const rehydrate = async (conversationId: string, messages: Array<ChatMessage | WireChatMessage>) => {
    if (!files) return messages;
    return Promise.all(messages.map(async (message) => {
      const parts = (message as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) return message;
      const next = await Promise.all(parts.map(async (part: unknown) => {
        const file = part as { type?: unknown; url?: unknown };
        const id = attachmentIdOf(part);
        if (file?.type !== 'file' || file.url !== '' || !id) return part;
        try {
          const stored = await files.get(conversationId, id);
          if (!stored) return part;
          written.add(`${conversationId}\u0000${id}`);
          return { ...file, url: await fileToDataUrl(stored.blob) };
        } catch {
          return part;
        }
      }));
      return { ...message, parts: next } as ChatMessage;
    }));
  };

  return {
    ...(files ? { attachments: files } : {}),
    get defaultActiveId() {
      const active = read(activeKey);
      const list = entries();
      return typeof active === 'string' && list.some((entry) => entry.id === active)
        ? active : list[0]!.id;
    },
    onActiveIdChange(id) { write(activeKey, id); },
    async list() {
      return persist(entries()).map(summary);
    },
    async create(opts) {
      const entry = { ...fresh(createId(), opts?.title?.trim() || newTitle), ...(opts?.title?.trim() ? { named: true } : {}) };
      persist([...entries(), entry]);
      return summary(entry);
    },
    async remove(conversationId) {
      drop(messagesKey(conversationId));
      const remaining = entries().filter((entry) => entry.id !== conversationId);
      if (remaining.length === 0) drop(indexKey);
      else persist(remaining);
      await deleteFiles(conversationId);
    },
    async rename(conversationId, title) {
      const next = title.trim();
      if (next === '') return;
      persist(entries().map((entry) => (entry.id === conversationId ? { ...entry, title: next, named: true } : entry)));
    },
    save(conversationId, allMessages) {
      if (!storage) return;
      const messages = tail(allMessages, maxMessages);
      const list = entries();
      const existing = list.find((entry) => entry.id === conversationId) ?? fresh(conversationId);
      // Once a save has trimmed the chat, the first stored user message is no longer the first question.
      const derived = existing.named || existing.trimmed ? null : titleFrom(allMessages, prefixOf);
      const entry: Entry = {
        ...existing,
        ...(messages.length < allMessages.length ? { trimmed: true } : {}),
        title: derived ?? existing.title,
        updatedAt: now(),
        messageCount: messages.length,
      };
      // Base64 attachments would fill the storage quota within a few images.
      write(messagesKey(conversationId), omitAttachmentData(messages));
      if (files) {
        for (const message of messages) {
          for (const part of message.parts ?? []) {
            const url = (part as { url?: unknown }).url;
            const id = attachmentIdOf(part);
            if (part.type !== 'file' || typeof url !== 'string' || !id) continue;
            const marker = `${conversationId}\u0000${id}`;
            const blob = written.has(marker) ? null : dataUrlToBlob(url);
            if (!blob) continue;
            written.add(marker);
            const filename = (part as { filename?: string }).filename;
            const task = (async () => {
              let ok = false;
              try {
                ok = (await files.put(conversationId, id, { blob, name: filename ?? 'file', mediaType: blob.type })) !== false;
              } catch {
                // counted as a failed attempt below
              }
              if (ok) {
                failures.delete(marker);
                return;
              }
              const attempts = (failures.get(marker) ?? 0) + 1;
              failures.set(marker, attempts);
              if (attempts < MAX_WRITE_ATTEMPTS) written.delete(marker);
            })();
            const set = pending.get(conversationId) ?? new Set<Promise<void>>();
            pending.set(conversationId, set);
            set.add(task);
            void task.then(() => {
              set.delete(task);
              if (set.size === 0 && pending.get(conversationId) === set) pending.delete(conversationId);
            });
          }
        }
      }
      persist([...list.filter((other) => other.id !== conversationId), entry]);
    },
    load(conversationId) {
      const stored = read(messagesKey(conversationId));
      if (!Array.isArray(stored) || stored.length === 0) return null;
      const messages = sanitizeStoredMessages(stored) as Array<ChatMessage | WireChatMessage>;
      return files ? rehydrate(conversationId, messages) : messages;
    },
    async clear(conversationId) {
      const id = conversationId ?? DEFAULT_ID;
      drop(messagesKey(id));
      persist(entries().map((entry) => (entry.id === id ? { ...entry, messageCount: 0 } : entry)));
      await deleteFiles(id);
    },
  };
}
