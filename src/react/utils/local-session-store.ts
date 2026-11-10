import type { ChatMessage, SessionConfig, SessionSummary, WireChatMessage } from '../types.js';
import { sanitizeStoredMessages } from './sanitize-stored-messages.js';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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

/** The first question of a chat, cut at a word, as its name. */
function titleFrom(messages: ReadonlyArray<ChatMessage | WireChatMessage>): string | null {
  const first = messages.find((message) => message.role === 'user');
  const text = first ? textOf(first).replace(/\s+/g, ' ').trim() : '';
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
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? randomId;
  const indexKey = `${options.storageKey}:sessions`;
  const messagesKey = (id: string) => `${options.storageKey}:messages:${id}`;
  type Entry = SessionSummary & { createdAt: number; updatedAt: number; named?: boolean };

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
    for (const removed of ordered.slice(maxSessions)) drop(messagesKey(removed.id));
    const kept = ordered.slice(0, maxSessions);
    write(indexKey, kept);
    return kept;
  };
  const summary = ({ named: _named, ...entry }: Entry): SessionSummary => entry;

  return {
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
    },
    async rename(conversationId, title) {
      const next = title.trim();
      if (next === '') return;
      persist(entries().map((entry) => (entry.id === conversationId ? { ...entry, title: next, named: true } : entry)));
    },
    save(conversationId, messages) {
      if (!storage) return;
      const list = entries();
      const existing = list.find((entry) => entry.id === conversationId) ?? fresh(conversationId);
      const derived = existing.named ? null : titleFrom(messages);
      const entry: Entry = {
        ...existing,
        title: derived ?? existing.title,
        updatedAt: now(),
        messageCount: messages.length,
      };
      write(messagesKey(conversationId), messages);
      persist([...list.filter((other) => other.id !== conversationId), entry]);
    },
    load(conversationId) {
      const stored = read(messagesKey(conversationId));
      if (!Array.isArray(stored) || stored.length === 0) return null;
      return sanitizeStoredMessages(stored) as Array<ChatMessage | WireChatMessage>;
    },
    clear(conversationId) {
      const id = conversationId ?? DEFAULT_ID;
      drop(messagesKey(id));
      persist(entries().map((entry) => (entry.id === id ? { ...entry, messageCount: 0 } : entry)));
    },
  };
}
