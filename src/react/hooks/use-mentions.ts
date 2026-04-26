import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { UseMentionsReturn } from '../types.js';

/**
 * Hook for accessing mention search and selection.
 *
 * @example
 * ```tsx
 * function MentionSearch() {
 *   const { query, results, select, isSearching } = useMentions();
 *
 *   return (
 *     <div>
 *       {isSearching && <Spinner />}
 *       {results.map(r => (
 *         <button key={r.id} onClick={() => select(r)}>
 *           {r.label}
 *         </button>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useMentions(): UseMentionsReturn {
  const ctx = useChatContext();

  return useMemo(
    () => ({
      query: ctx.mentionQuery,
      results: ctx.mentionResults,
      select: ctx.selectMention,
      activeMentions: ctx.activeMentions,
      isSearching: ctx.isMentionSearching,
    }),
    [
      ctx.mentionQuery,
      ctx.mentionResults,
      ctx.selectMention,
      ctx.activeMentions,
      ctx.isMentionSearching,
    ],
  );
}
