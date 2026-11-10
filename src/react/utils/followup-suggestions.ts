export interface ExtractedFollowupSuggestions {
  text: string;
  suggestions: string[];
}

const TRAILING_HEADING = /(?:^|\n)[ \t]{0,3}(?:\*\*|__)?(?:Vorschläge|Suggestions):?(?:\*\*|__)?[ \t]*\n([\s\S]+)$/i;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.+?)[ \t]*$/;
const MAX_FALLBACK_SUGGESTIONS = 5;

/**
 * Extract a strictly delimited, trailing Markdown follow-up list.
 *
 * This is a presentation fallback for models that write suggestions instead
 * of calling `suggest_followups`. Unmatched text is returned unchanged.
 */
export function extractTrailingFollowupSuggestions(
  text: string,
  limit = MAX_FALLBACK_SUGGESTIONS,
): ExtractedFollowupSuggestions {
  const match = TRAILING_HEADING.exec(text);
  if (!match || match.index === undefined) {
    return { text, suggestions: [] };
  }

  const lines = match[1].trimEnd().split('\n');
  if (lines.length < 1 || lines.length > MAX_FALLBACK_SUGGESTIONS) {
    return { text, suggestions: [] };
  }

  const parsed: string[] = [];
  for (const line of lines) {
    const item = LIST_ITEM.exec(line);
    if (!item || item[1].trim().length === 0) {
      return { text, suggestions: [] };
    }
    parsed.push(item[1].trim());
  }

  const boundedLimit = Math.max(1, Math.min(MAX_FALLBACK_SUGGESTIONS, limit));
  const suggestions = Array.from(new Set(parsed)).slice(0, boundedLimit);
  if (suggestions.length === 0) {
    return { text, suggestions: [] };
  }

  return {
    text: text.slice(0, match.index).trimEnd(),
    suggestions,
  };
}
