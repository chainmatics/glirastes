import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useComposerContext } from '../provider/composer-context.js';
import type { MentionData, RichMentionInputHandle } from '../types.js';
import { isEmptyDraft } from './composer-drafts.js';

function isEditorEmpty(handle: RichMentionInputHandle): boolean {
  return handle.getValue().trim() === '' && handle.getMentions().length === 0;
}

/**
 * Internal: keeps the composer's text per chat. On mount and whenever the
 * open chat changes, the editor shows that chat's draft (empty when it has
 * none); every change of `value` is saved as the open chat's draft. A draft
 * that arrives from storage after the user typed in the new chat is dropped.
 *
 * Call it before `useChatComposerTarget`, so a restore runs before queued
 * composer operations. `restored()` tells whether a draft was put in on
 * mount (an `initialValue` applies only without one).
 */
export function useComposerDraft(
  handleRef: RefObject<RichMentionInputHandle | null>,
  value: string,
  onRestore: (value: string) => void,
): { restored: () => boolean } {
  const { drafts, activeSessionId } = useComposerContext();
  const shownRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  // Restore: on mount and on every change of the open chat.
  useEffect(() => {
    const handle = handleRef.current;
    if (!drafts || !handle || shownRef.current === activeSessionId) return;
    const first = shownRef.current === null;
    // The editor is the truth for the chat being left: a pill's `onChange` may still be pending.
    if (!first) {
      drafts.set(shownRef.current!, { text: handle.getValue(), mentions: handle.getMentions() });
      drafts.flush();
    }
    shownRef.current = activeSessionId;
    const sessionId = activeSessionId;
    const show = (text: string, mentions: ReadonlyArray<MentionData> = []) => {
      handle.setValue(text, [...mentions]);
      onRestoreRef.current(handle.getValue());
    };
    const draft = drafts.get(sessionId);
    if (draft) {
      show(draft.text, draft.mentions);
      if (first) restoredRef.current = true;
      return;
    }
    // On mount the editor keeps what the input put in itself (`initialMentions`).
    if (!first) show('');
    // No cleanup flag: under StrictMode the effect re-runs without loading again.
    void drafts.load(sessionId).then((loaded) => {
      // Too late: another chat is open, or the user typed in this one meanwhile.
      if (shownRef.current !== sessionId || isEmptyDraft(loaded)) return;
      const latest = handleRef.current;
      if (!latest || !isEditorEmpty(latest)) return;
      latest.setValue(loaded!.text, [...(loaded!.mentions ?? [])]);
      onRestoreRef.current(latest.getValue());
    }, () => {});
  }, [drafts, activeSessionId, handleRef]);

  // Save: the editor's current text and pills, as the open chat's draft.
  useEffect(() => {
    const handle = handleRef.current;
    if (!drafts || !handle || shownRef.current !== activeSessionId) return;
    drafts.set(activeSessionId, { text: handle.getValue(), mentions: handle.getMentions() });
  }, [drafts, activeSessionId, handleRef, value]);

  // Unmount: keep what the editor holds (a layout cleanup still sees the editor's handle).
  useLayoutEffect(() => () => {
    const handle = handleRef.current;
    const sessionId = shownRef.current;
    if (drafts && handle && sessionId !== null) {
      drafts.set(sessionId, { text: handle.getValue(), mentions: handle.getMentions() });
    }
  }, [drafts, handleRef]);

  return { restored: useCallback(() => restoredRef.current, []) };
}
