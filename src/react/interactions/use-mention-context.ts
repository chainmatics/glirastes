import { useContext, useEffect, useRef } from 'react';
import { ChatContext } from '../provider/chat-context.js';
import { composerContextOf } from '../provider/composer-context.js';
import type { ChatMentionContext } from './registry.js';

/**
 * Sets the `@` context of the chat while the calling component is mounted,
 * e.g. on a project page `{ preferredTypes: ['task'], presetType: 'task' }`.
 * The most recently mounted call with a value wins over earlier ones and
 * over the provider's `mentionContext` prop; unmounting restores the one
 * before. `null` or `undefined` contributes nothing. The value is read at
 * search time, so a new object every render costs nothing. Outside an
 * `AiChatProvider` it does nothing.
 */
export function useMentionContext(value: ChatMentionContext | null | undefined): void {
  const register = composerContextOf(useContext(ChatContext)).registerMentionContext;
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!register) return undefined;
    return register(() => valueRef.current);
  }, [register]);
}
