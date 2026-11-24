const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * A JSON text with every string literal (value and key) decoded to its real
 * characters, everything between the literals as it is.
 *
 * `anonymizeResult` detects in the JSON text of a result and, when that has
 * escapes, also in this text. In the JSON text a line break is the two
 * characters `\n`: an e-mail after it is found as `nmax@…` (no value contains
 * that) and an IBAN or phone number after it not at all. Here the detector sees
 * the values as the result holds them. Without any escape the text is the JSON
 * text itself (the caller then detects once). `undefined` (a result JSON
 * cannot represent) is returned as it is.
 */
export function decodeJsonStrings(json: string): string {
  if (typeof json !== 'string' || !json.includes('\\')) return json;
  // One linear pass. Outside string literals JSON text has no quote and no
  // backslash, so every quote found here opens a literal.
  let text = '';
  let copied = 0;
  for (let start = json.indexOf('"'); start !== -1; start = json.indexOf('"', copied)) {
    let end = start + 1;
    let escaped = false;
    for (let code = json.charCodeAt(end); code !== QUOTE && end < json.length; code = json.charCodeAt(end)) {
      if (code === BACKSLASH) { escaped = true; end += 2; } else end += 1;
    }
    end += 1;
    if (escaped) text += `${json.slice(copied, start)}"${JSON.parse(json.slice(start, end)) as string}"`;
    else text += json.slice(copied, end);
    copied = end;
  }
  return text + json.slice(copied);
}
