import type { ComposerDraft, ComposerDraftStorage, MentionData } from '../types.js';

/**
 * Internal: the unsent composer text of each chat, owned by one
 * `AiChatProvider` instance (it dies with the provider, so a remount for
 * another identity starts empty). Attachments are never part of a draft.
 * With a `ComposerDraftStorage`, changes are also written there (debounced)
 * and a chat with nothing in memory is read from there.
 */
export interface ComposerDraftController {
  /** The draft held in memory for a chat. */
  get(sessionId: string): ComposerDraft | undefined;
  /** Replaces the chat's draft; `null` or an empty draft removes it. */
  set(sessionId: string, draft: ComposerDraft | null): void;
  /** The chat's draft from memory, else from storage; `null` when none. */
  load(sessionId: string): Promise<ComposerDraft | null>;
  /** Writes pending changes to storage at once. */
  flush(): void;
  /**
   * Drops the chat's draft from memory and cancels its pending write (the
   * store removes the stored one). With `gone` (chat removed), later changes
   * for it are ignored until the chat is shown again (`load`).
   */
  forget(sessionId: string, options?: { gone?: boolean }): void;
}

/** Writes wait this long after the last change. */
export const DRAFT_SAVE_DELAY_MS = 300;
/** Longer drafts stay in memory only. */
export const MAX_STORED_DRAFT_LENGTH = 20_000;

export function isEmptyDraft(draft: ComposerDraft | null | undefined): boolean {
  return !draft || (draft.text.trim() === '' && !(draft.mentions?.length));
}

function normalize(draft: ComposerDraft | null | undefined): ComposerDraft | null {
  if (isEmptyDraft(draft)) return null;
  return { text: draft!.text, ...(draft!.mentions?.length ? { mentions: [...draft!.mentions] } : {}) };
}

function same(left: ComposerDraft | null | undefined, right: ComposerDraft | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.text === right.text && JSON.stringify(left.mentions ?? []) === JSON.stringify(right.mentions ?? []);
}

function isMention(value: unknown): value is MentionData {
  const mention = value as Partial<MentionData> | null;
  return typeof mention === 'object' && mention !== null
    && typeof mention.id === 'string' && typeof mention.type === 'string' && typeof mention.label === 'string';
}

/** A stored draft as the editor can take it: text, and only well-formed pills. */
function readDraft(value: unknown): ComposerDraft | null {
  const draft = value as { text?: unknown; mentions?: unknown } | null;
  if (typeof draft !== 'object' || draft === null || typeof draft.text !== 'string') return null;
  const mentions = Array.isArray(draft.mentions) ? draft.mentions.filter(isMention) : [];
  return normalize({ text: draft.text, mentions });
}

/** `storage` is read on every use, so the provider can hand in the current `session.draft`. */
export function createComposerDraftController(
  storage: () => ComposerDraftStorage | undefined = () => undefined,
): ComposerDraftController {
  const memory = new Map<string, ComposerDraft>();
  const dirty = new Map<string, ComposerDraft | null>();
  const gone = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const target = storage();
    const pending = [...dirty];
    dirty.clear();
    if (!target) return;
    for (const [sessionId, draft] of pending) {
      // Too long for the browser storage: kept in memory, and no older version comes back after a reload.
      const value = draft && draft.text.length > MAX_STORED_DRAFT_LENGTH ? null : draft;
      try {
        void Promise.resolve(target.save(sessionId, value)).catch(() => {});
      } catch {
        // storage failed: the draft stays in memory only
      }
    }
  };

  return {
    get: (sessionId) => memory.get(sessionId),
    set(sessionId, draft) {
      if (gone.has(sessionId)) return;
      const next = normalize(draft);
      if (same(memory.get(sessionId), next)) return;
      if (next) memory.set(sessionId, next);
      else memory.delete(sessionId);
      if (!storage()) return;
      dirty.set(sessionId, next);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
    },
    async load(sessionId) {
      gone.delete(sessionId);
      const held = memory.get(sessionId);
      if (held) return held;
      const target = storage();
      if (!target || dirty.has(sessionId)) return null;
      let loaded: unknown = null;
      try {
        loaded = await target.load(sessionId);
      } catch {
        return null;
      }
      const draft = readDraft(loaded);
      // Typed or saved meanwhile: what is in memory now wins.
      if (draft && !memory.has(sessionId) && !dirty.has(sessionId)) memory.set(sessionId, draft);
      return memory.get(sessionId) ?? null;
    },
    flush,
    forget(sessionId, options) {
      memory.delete(sessionId);
      dirty.delete(sessionId);
      if (options?.gone) gone.add(sessionId);
      if (dirty.size === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
