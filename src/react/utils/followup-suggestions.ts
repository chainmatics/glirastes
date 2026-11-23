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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed, each text once (they are button labels and React keys). */
function unique(entries: readonly string[]): string[] {
  return [...new Set(entries.map((entry) => entry.trim()))];
}

/**
 * The follow-ups of one assistant message: the last finished
 * `suggest_followups` call with non-blank strings, else the trailing list of
 * its last text part that has one; trimmed, each once, at most `count`. None
 * for other roles.
 */
export function readMessageFollowups(
  message: { role: string; parts: ReadonlyArray<unknown> },
  count: number,
): string[] {
  if (message.role !== 'assistant') return [];
  let structured: string[] = [];
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== 'tool-suggest_followups') continue;
    if (part.state !== 'output-available' || !isRecord(part.output) || !Array.isArray(part.output.followups)) continue;
    const followups = unique(part.output.followups.filter(
      (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    ));
    if (followups.length > 0) structured = followups.slice(0, count);
  }
  if (structured.length > 0) return structured;
  let trailing: string[] = [];
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    const extracted = extractTrailingFollowupSuggestions(part.text, count);
    if (extracted.suggestions.length > 0) trailing = unique(extracted.suggestions);
  }
  return trailing;
}
