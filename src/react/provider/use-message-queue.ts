import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatQueueChangeReason,
  ChatQueueConfig,
  ChatQueuePauseTrigger,
  ChatQueueStorage,
  QueuedMessage,
} from '../types.js';

const ALL_PAUSE_TRIGGERS: ReadonlyArray<ChatQueuePauseTrigger> = ['error', 'aborted', 'safety-stop', 'truncation'];
const DEFAULT_MAX_SIZE = 10;

export interface ResolvedChatQueueConfig {
  enabled: boolean;
  autoFlush: boolean;
  sendNowBehavior: 'next' | 'abort';
  maxSize: number;
  pauseOn: ReadonlySet<ChatQueuePauseTrigger>;
  sendNowDuringApproval: 'refuse' | 'reject-approval';
}

/** The queue options with their defaults, keyed on the fields so an inline object does not re-render. */
export function useResolvedQueueConfig(config: ChatQueueConfig | undefined): ResolvedChatQueueConfig {
  const enabled = config?.enabled === true;
  const autoFlush = config?.autoFlush !== false;
  const sendNowBehavior = config?.sendNowBehavior === 'abort' ? 'abort' : 'next';
  const rawMax = config?.maxSize;
  const maxSize = rawMax === null || rawMax === Infinity
    ? Infinity
    : typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : DEFAULT_MAX_SIZE;
  const pauseKey = (config?.pauseOn ?? ALL_PAUSE_TRIGGERS)
    .filter((trigger) => ALL_PAUSE_TRIGGERS.includes(trigger)).slice().sort().join(',');
  const sendNowDuringApproval = config?.sendNowDuringApproval === 'reject-approval' ? 'reject-approval' : 'refuse';
  return useMemo(() => ({
    enabled,
    autoFlush,
    sendNowBehavior,
    maxSize,
    pauseOn: new Set(pauseKey ? pauseKey.split(',') as ChatQueuePauseTrigger[] : []),
    sendNowDuringApproval,
  }), [enabled, autoFlush, sendNowBehavior, maxSize, pauseKey, sendNowDuringApproval]);
}

let queueCounter = 0;
function queueId(): string {
  queueCounter += 1;
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `queued_${queueCounter}_${random}`;
}

export function createQueuedMessage(
  text: string,
  options: { mentions?: QueuedMessage['mentions']; files?: QueuedMessage['files'] },
): QueuedMessage {
  return {
    id: queueId(),
    text,
    createdAt: new Date().toISOString(),
    ...(options.mentions && options.mentions.length > 0 ? { mentions: [...options.mentions] } : {}),
    ...(options.files && options.files.length > 0 ? { files: [...options.files] } : {}),
  };
}

/** Items a storage adapter returned, without files and without malformed entries. */
function readStoredItems(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return [];
  const items: QueuedMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== 'string' || record.text.trim() === '') continue;
    if (Array.isArray(record.files) && record.files.length > 0) continue;
    items.push({
      id: typeof record.id === 'string' && record.id ? record.id : queueId(),
      text: record.text,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
      ...(Array.isArray(record.mentions) && record.mentions.length > 0
        ? { mentions: record.mentions.filter((mention) => typeof mention === 'object' && mention !== null) }
        : {}),
    });
  }
  return items;
}

/** What `queue.storage` keeps: items with files cannot survive a reload. */
function persistable(items: ReadonlyArray<QueuedMessage>): QueuedMessage[] {
  return items.filter((item) => !item.files || item.files.length === 0);
}

export interface MessageQueueStore {
  items: ReadonlyArray<QueuedMessage>;
  paused: boolean;
  /** Current values, also between renders. */
  itemsRef: { readonly current: ReadonlyArray<QueuedMessage> };
  pausedRef: { readonly current: boolean };
  /** The item `sendNow` put first: it goes next even while paused or without `autoFlush`. */
  priorityRef: { current: string | null };
  /** Replaces the queue and reports the change. `persist: false` for a reset that must not overwrite storage. */
  commit(items: ReadonlyArray<QueuedMessage>, paused: boolean, reason: ChatQueueChangeReason, persist?: boolean): void;
  /** Empties the queue for good: a stored queue still loading is dropped, and an empty one is saved. */
  clearAll(): void;
}

/**
 * State of the message queue of the active conversation: items, the pause
 * flag, the change callback and the storage adapter. Sending is the
 * provider's part.
 */
export function useMessageQueueStore(
  config: ChatQueueConfig | undefined,
  enabled: boolean,
  sessionId: string,
): MessageQueueStore {
  const [items, setItems] = useState<ReadonlyArray<QueuedMessage>>([]);
  const [paused, setPaused] = useState(false);
  const itemsRef = useRef<ReadonlyArray<QueuedMessage>>([]);
  const pausedRef = useRef(false);
  const priorityRef = useRef<string | null>(null);
  const onChangeRef = useRef(config?.onQueueChange);
  onChangeRef.current = config?.onQueueChange;
  const storageRef = useRef<ChatQueueStorage | undefined>(config?.storage);
  storageRef.current = enabled ? config?.storage : undefined;
  const hasStorage = enabled && config?.storage !== undefined;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  // The session whose stored queue was read; nothing is saved for a session before that.
  const loadedForRef = useRef<string | null>(null);
  // Bumped by `clearAll`: a load that started before it must not bring the cleared queue back.
  const clearGenerationRef = useRef(0);

  // One write at a time per conversation, the latest state last: an older write never lands after a newer one.
  const writesRef = useRef(new Map<string, { running: boolean; next?: QueuedMessage[] }>());
  const save = useCallback((id: string, next: ReadonlyArray<QueuedMessage>) => {
    const storage = storageRef.current;
    if (!storage || loadedForRef.current !== id) return;
    const writes = writesRef.current;
    const slot = writes.get(id) ?? { running: false };
    slot.next = persistable(next);
    writes.set(id, slot);
    if (slot.running) return;
    slot.running = true;
    void (async () => {
      while (slot.next) {
        const items = slot.next;
        slot.next = undefined;
        try {
          await Promise.resolve(storage.save(id, items));
        } catch {
          console.warn('[glirastes] queue.storage.save failed');
        }
      }
      slot.running = false;
      writes.delete(id);
    })();
  }, []);

  const commit = useCallback((
    next: ReadonlyArray<QueuedMessage>,
    nextPaused: boolean,
    reason: ChatQueueChangeReason,
    persist = true,
  ) => {
    // A pause belongs to what is queued: an emptied queue is no longer paused.
    const effectivePaused = next.length === 0 && reason !== 'paused' ? false : nextPaused;
    if (priorityRef.current && !next.some((item) => item.id === priorityRef.current)) priorityRef.current = null;
    itemsRef.current = next;
    pausedRef.current = effectivePaused;
    setItems(next);
    setPaused(effectivePaused);
    if (persist) save(sessionRef.current, next);
    try {
      onChangeRef.current?.({ queued: next, paused: effectivePaused, reason });
    } catch {
      // The app's callback never breaks the chat.
    }
  }, [save]);

  // Another conversation: its queue is not this one's. With storage, read the new one's.
  const queueSessionRef = useRef(sessionId);
  useEffect(() => {
    if (queueSessionRef.current !== sessionId) {
      queueSessionRef.current = sessionId;
      if (itemsRef.current.length > 0 || pausedRef.current) commit([], false, 'cleared', false);
    }
    loadedForRef.current = null;
    const storage = storageRef.current;
    if (!hasStorage || !storage) return undefined;
    let cancelled = false;
    const generation = clearGenerationRef.current;
    void (async () => {
      let stored: QueuedMessage[] = [];
      try {
        stored = readStoredItems(await Promise.resolve(storage.load(sessionId)));
      } catch {
        console.warn('[glirastes] queue.storage.load failed');
      }
      if (cancelled || sessionRef.current !== sessionId || clearGenerationRef.current !== generation) return;
      loadedForRef.current = sessionId;
      if (stored.length === 0) {
        // Queued while the stored queue was read: keep it now.
        if (itemsRef.current.length > 0) save(sessionId, itemsRef.current);
        return;
      }
      const known = new Set(itemsRef.current.map((item) => item.id));
      // Never sent by itself after a reload: the user resumes.
      commit([...stored.filter((item) => !known.has(item.id)), ...itemsRef.current], true, 'restored');
    })();
    return () => { cancelled = true; };
  }, [sessionId, hasStorage, commit, save]);

  const clearAll = useCallback(() => {
    clearGenerationRef.current += 1;
    // What is cleared now is this conversation's queue, also before its stored one was read.
    if (storageRef.current) loadedForRef.current = sessionRef.current;
    if (itemsRef.current.length > 0 || pausedRef.current) commit([], false, 'cleared');
    else save(sessionRef.current, []);
  }, [commit, save]);

  return useMemo(
    () => ({ items, paused, itemsRef, pausedRef, priorityRef, commit, clearAll }),
    [items, paused, commit, clearAll],
  );
}
