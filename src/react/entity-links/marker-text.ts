/**
 * A mention marker kept in Markdown text (`mentionMarkers: 'markdown'`):
 * `\u2060`, its index in zero-width digits (`\u200B` 0, `\u200C` 1),
 * `\u2063`, its label, `\u2060`. Invisible where nothing renders a chip; the
 * index keeps markers with one label apart. Its own module so the raw
 * Markdown fallback can read it without the React entity-link graph.
 */
export const MARKER_EDGE = '\u2060';
export const MARKER_SPAN = /\u2060([\u200B\u200C]+)\u2063([^\u2060]*)\u2060/g;
export const MARKER_CHARS = /[\u2060\u2063]/g;

/**
 * The characters escaped in a marker label: those that can start an inline
 * construct there (CommonMark: `\` escape, `` ` `` code span, `*` `_`
 * emphasis, `[` `]` link and image text (`!` only matters before `[`), `<`
 * autolink and raw HTML, `&` entity reference; GFM: `~` strikethrough, `|`
 * table cell). The label never starts a line (the marker's invisible
 * characters come first), so block syntax (`#`, `-`, `+`, `>`, `1.`) cannot
 * start in it, and `(` `)` `{` `}` `.` `!` `#` mean nothing inline there.
 */
const LABEL_SPECIAL = /[\\`*_[\]<&|~]/g;
const LABEL_ESCAPE = /\\([\\`*_[\]<&|~])/g;

/** A marker label with its Markdown characters escaped. */
export function escapeMarkerLabel(label: string): string {
  return label.replace(LABEL_SPECIAL, (char) => `\\${char}`);
}

/**
 * Markdown text with marker labels as they read: the escapes the SDK put
 * into each label (`escapeMarkerLabel`) removed, everything else unchanged.
 * For the raw text shown while react-markdown loads, after its time limit,
 * or without it; backslashes the answer itself wrote stay.
 */
export function unescapeMarkerLabels(content: string): string {
  if (!content.includes('\u2063')) return content;
  return content.replace(MARKER_SPAN, (span, index: string, label: string) => (
    label.includes('\\') ? `${MARKER_EDGE}${index}\u2063${label.replace(LABEL_ESCAPE, '$1')}${MARKER_EDGE}` : span
  ));
}
