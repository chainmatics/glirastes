import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { UseSuggestionsReturn } from '../types.js';

/**
 * Hook for accessing followup suggestion chips.
 *
 * `chips` are the latest turn's follow-ups, else `suggestions.staticChips`.
 * `suggestions.enabled: false` hides the SDK's `SuggestionBar` and the
 * follow-ups under the answer, but `chips` stays filled: a bar of your own
 * that should honour the switch checks the config itself.
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
