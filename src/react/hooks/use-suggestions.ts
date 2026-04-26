import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { UseSuggestionsReturn } from '../types.js';

/**
 * Hook for accessing followup suggestion chips.
 *
 * @example
 * ```tsx
 * function SuggestionBar() {
 *   const { chips, select, isGenerating } = useSuggestions();
 *
 *   return (
 *     <div>
 *       {chips.map(chip => (
 *         <button key={chip} onClick={() => select(chip)}>
 *           {chip}
 *         </button>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSuggestions(): UseSuggestionsReturn {
  const ctx = useChatContext();

  return useMemo(
    () => ({
      chips: ctx.suggestionChips,
      refresh: ctx.refreshSuggestions,
      select: ctx.selectSuggestion,
      isGenerating: ctx.isSuggestionsGenerating,
    }),
    [
      ctx.suggestionChips,
      ctx.refreshSuggestions,
      ctx.selectSuggestion,
      ctx.isSuggestionsGenerating,
    ],
  );
}
