/** One JSON string literal: a quote, escapes or plain characters, a quote. */
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;

/**
 * The text a detector reads for a tool result: its JSON text with every
 * string (value and key) in its real characters instead of JSON escapes.
 *
 * The shield replaces originals in the string values of the result, so a
 * detector must see those values as they are. In plain JSON text a line
 * break is the two characters `\n`: an e-mail after it is found as
 * `nmax@…` (no value contains that, so the original stays) and an IBAN or
 * phone number after it is not found at all. Decoding the literals in place
 * keeps everything else of the JSON text: one text and one detector call per
 * result, the same structure between strings, and - for a result without any
 * escaped character - exactly the text, positions and detections of
 * `JSON.stringify(result)`.
 *
 * `JSON.stringify` semantics stay as they were (`toJSON`, omitted
 * `undefined`, cycles and BigInt throw). A result JSON cannot represent
 * (`undefined`, a function) yields `undefined`, as before.
 */
export function detectionText(result: unknown): string {
  const json = JSON.stringify(result) as string | undefined;
  if (json === undefined) return json as unknown as string;
  return json.replace(STRING_LITERAL, (literal) => (
    literal.includes('\\') ? `"${JSON.parse(literal) as string}"` : literal
  ));
}
