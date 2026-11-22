import type { ComposerDraft } from '../types.js';

/**
 * Internal: the unsent composer text of each chat, owned by one
 * `AiChatProvider` instance (it dies with the provider, so a remount for
 * another identity starts empty). Attachments are never part of a draft.
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
}

export function isEmptyDraft(draft: ComposerDraft | null | undefined): boolean {
  return !draft || (draft.text.trim() === '' && !(draft.mentions?.length));
}

export function createComposerDraftController(): ComposerDraftController {
  const memory = new Map<string, ComposerDraft>();
  return {
    get: (sessionId) => memory.get(sessionId),
    set(sessionId, draft) {
      if (isEmptyDraft(draft)) memory.delete(sessionId);
      else memory.set(sessionId, { text: draft!.text, ...(draft!.mentions?.length ? { mentions: [...draft!.mentions] } : {}) });
    },
    load: async (sessionId) => memory.get(sessionId) ?? null,
    flush() {},
  };
}
