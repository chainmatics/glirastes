/**
 * Escaping of data values that the SDK writes into delimited blocks of
 * model-facing text (`<seen-objects>`, `<memory>`, `<!--context:...-->`), so a
 * stored value (a record name a colleague chose, a shared note) can never
 * close its block and continue as apparent instructions. Text without a
 * delimiter character stays byte-identical. No dependencies.
 *
 * @module
 */

const unicodeEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * JSON text with `<` and `>` as their JSON escapes (backslash, `u003c` /
 * `u003e`): valid JSON with the same value, and it can never close a surrounding comment or tag. What
 * the tool reference and the command marker have always sent.
 */
export function escapeJsonAngles(json: string): string {
  return json.replace(/[<>]/g, unicodeEscape);
}

/**
 * JSON text for a line inside a tag-delimited block: `<`, `>`, `&`, U+2028
 * and U+2029 as `\u...` escapes. These characters only occur inside JSON
 * strings, so the result is valid JSON that parses to the same value.
 * Bidi controls and zero-width characters are left as they are.
 */
export function escapeJsonForBlock(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, unicodeEscape);
}

// At most 64 whitespace characters between `<`, `/` and the name keep the scan linear.
const tagPattern = (tag: string, prefix: string) =>
  new RegExp(`${prefix}(?=\\s{0,64}\\/?\\s{0,64}${tag}(?!\\w))`, 'gi');

/**
 * Free text for a block delimited by `<tag>` ... `</tag>`: every `<` that opens
 * or closes that tag (any case, whitespace allowed) becomes `&lt;`, and an
 * `&` that already starts such an escape becomes `&amp;`, so the escape is
 * reversible (`unescapeTagInText`) and unambiguous. Text without the tag
 * stays byte-identical. `tag` must be a plain name (`[a-z-]`).
 */
export function escapeTagInText(text: string, tag: string): string {
  return text.replace(tagPattern(tag, '(?:<|&(?:amp;)*lt;)'), (match) => (match === '<' ? '&lt;' : `&amp;${match.slice(1)}`));
}

/** The inverse of `escapeTagInText`. */
export function unescapeTagInText(text: string, tag: string): string {
  return text.replace(tagPattern(tag, '&(?:amp;)*lt;'), (match) => (match === '&lt;' ? '<' : `&${match.slice(5)}`));
}

/**
 * Free text inside an HTML comment (`<!--context:...-->`): the `>` of `-->`
 * (and of `--!>`, which HTML also reads as a comment end) and the `<` of `<!--` become their JSON escapes (backslash, `u003e` /
 * `u003c`), as the tool reference in the same block has them. Text without
 * `-->`, `--!>` or `<!--` stays byte-identical.
 */
export function escapeCommentDelimiters(text: string): string {
  return text.replace(/--(!?)>/g, '--$1\\u003e').replace(/<!--/g, '\\u003c!--');
}
