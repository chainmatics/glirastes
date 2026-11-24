import { useContext, useEffect, useRef, useState } from 'react';
import { ChatContext } from '../provider/chat-context.js';
import { composerContextOf } from '../provider/composer-context.js';
import type { ChatMentionContext } from './registry.js';

/** Render order of the calls: a component takes its number at its first render (a parent before its children). */
let renderOrder = 0;

/**
 * Sets the `@` context of the chat while the calling component is mounted,
 * e.g. on a project page `{ preferredTypes: ['task'], presetType: 'task' }`.
 * Of the mounted calls with a value, the one rendered last wins: a nested
 * component over its ancestors, a later sibling over an earlier one, a
 * component mounted later over those mounted before, whatever order React
 * runs their effects in. Every call wins over the provider's
 * `mentionContext` prop; unmounting restores the one before. `null` or
 * `undefined` contributes nothing. The value is read at search time, so a
 * new object every render costs nothing. Outside an `AiChatProvider` it
 * does nothing.
 */
export function useMentionContext(value: ChatMentionContext | null | undefined): void {
  const register = composerContextOf(useContext(ChatContext)).registerMentionContext;
  const [order] = useState(() => {
    renderOrder += 1;
    return renderOrder;
  });
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!register) return undefined;
    return register(() => valueRef.current, order);
  }, [register, order]);
}
