import { describe, expect, it } from 'vitest';
import { createPiiShield } from '../create-pii-shield.js';
import { createRegexPiiDetector } from '../regex-detector.js';
import { detectionText } from '../detection-text.js';
import type { PiiDetector } from '../../../types.js';

/**
 * anonymizeResult finds personal values in the string values of a result as
 * they are, not in their JSON escapes. In the JSON text a line break is the
 * two characters `\n`: the e-mail after it was found as `nmax…` and left in
 * place, an IBAN or phone number after it was not found at all.
 */

const EMAIL = 'max.mustermann@firma.de';
const IBAN = 'DE89370400440532013000';
const PHONE = '030 12345678';
/** Identifying part of each value; a pseudonym may share a format prefix such as "+49 30", never this. */
const CORE: Record<string, string> = { [EMAIL]: 'max.mustermann', [IBAN]: '370400440532013000', [PHONE]: '12345678' };

const VALUES: Array<[string, string]> = [['e-mail', EMAIL], ['IBAN', IBAN], ['phone', PHONE]];
const CONTEXTS: Array<[string, (value: string) => string]> = [
  ['after \\n', (v) => `Kontakt:\n${v}`],
  ['after \\r\\n', (v) => `Kontakt:\r\n${v}`],
  ['after \\t', (v) => `Kontakt:\t${v}`],
  ['after \\b', (v) => `x\b${v}`],
  ['after \\f', (v) => `x\f${v}`],
  ['after a quote', (v) => `Er sagte "${v}"`],
  ['after a backslash', (v) => `C:\\${v}`],
  ['next to unescaped non-ASCII', (v) => `Grüße ä${v}`],
  ['after U+0001', (v) => `x\u0001${v}`],
  ['after U+001F', (v) => `x\u001f${v}`],
  ['after U+2028', (v) => `x\u2028${v}`],
  ['after a lone surrogate', (v) => `x\ud800${v}`],
  ['at the string start', (v) => `${v} ist die Adresse`],
  ['at the string end', (v) => `Adresse: ${v}`],
  ['before \\n', (v) => `${v}\nweiter`],
];

const shieldWith = (detector: PiiDetector = createRegexPiiDetector()) => createPiiShield({ locale: 'de', detector });

/** All strings and numbers of a value, keys included, kept apart so no fragment spans two of them. */
function visible(value: unknown, out: string[] = []): string {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => visible(item, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.push(key); visible(item, out); }
  return out.join('\u0000');
}

describe('anonymizeResult on string values with JSON escapes', () => {
  for (const [valueName, value] of VALUES) {
    it.each(CONTEXTS)(`${valueName} %s does not reach the output`, async (_name, wrap) => {
      const result = { note: wrap(value), nested: [{ deep: { text: `Info\n${value}` } }] };
      const out = await shieldWith().anonymizeResult(result, 's');
      expect(visible(out)).not.toContain(CORE[value]);
    });
  }

  it('a value that itself contains an escaped character is found and replaced as one', async () => {
    const out = await shieldWith().anonymizeResult({ note: 'Tel 030\t12345678' }, 's');
    expect(visible(out)).not.toContain('12345678');
  });

  it('a plain string result is unchanged in behavior (never JSON-encoded)', async () => {
    const out = await shieldWith().anonymizeResult(`Kontakt:\n${EMAIL}`, 's');
    expect(out).not.toContain('max.mustermann');
  });

  it('the pseudonym sent back in tool arguments rehydrates to the original with its escapes around it', async () => {
    const shield = shieldWith();
    const result = { note: `Kontakt:\n${EMAIL}`, iban: `Konto:\r\n${IBAN}`, tel: [`x\u0001${PHONE}`] };
    const out = await shield.anonymizeResult(result, 's') as typeof result;
    const pseudonymEmail = out.note.slice('Kontakt:\n'.length);
    expect(pseudonymEmail).not.toBe(EMAIL);
    expect(shield.rehydrateArgs({ to: pseudonymEmail }, 's')).toEqual({ to: EMAIL });
    expect(shield.rehydrateArgs(out as unknown as Record<string, unknown>, 's')).toEqual(result);
  });

  it('keeps the structure: same keys, types and array lengths', async () => {
    const result = { a: [`x\n${EMAIL}`, 1, true, null, { b: `\t${IBAN}` }], 'k\ney': 'v', n: 4930123456789 };
    const out = await shieldWith().anonymizeResult(result, 's') as typeof result;
    expect(Object.keys(out)).toEqual(Object.keys(result));
    expect(out.a).toHaveLength(5);
    expect(out.a.slice(1, 4)).toEqual([1, true, null]);
    expect(out.n).toBe(4930123456789);
  });

  // Unchanged limits, kept visible: keys are never rewritten (the result keeps its
  // shape) and numbers are not strings, so neither is pseudonymized.
  it('known limit, as before: object keys and numbers pass through unchanged', async () => {
    const out = await shieldWith().anonymizeResult({ [EMAIL]: 'x', phone: 4930123456789 }, 's');
    expect(out).toEqual({ [EMAIL]: 'x', phone: 4930123456789 });
  });

  it('a key is still detected: the same value in a string is replaced', async () => {
    const out = await shieldWith().anonymizeResult({ [`k\n${EMAIL}`]: `an ${EMAIL}` }, 's');
    expect(Object.values(out as Record<string, string>)[0]).not.toContain('max.mustermann');
  });
});

describe('the detector input', () => {
  function recording() {
    const texts: string[] = [];
    const inner = createRegexPiiDetector();
    const detector: PiiDetector = { detect: (text, locales) => { texts.push(text); return inner.detect(text, locales); } };
    return { texts, detector };
  }

  it('is exactly JSON.stringify(result) for a result without escaped characters, in one call', async () => {
    const { texts, detector } = recording();
    const result = { list: [{ name: 'Max', mail: EMAIL, n: 3, ok: true, none: null }], 'ä😀': 'Grüße' };
    await shieldWith(detector).anonymizeResult(result, 's');
    expect(texts).toEqual([JSON.stringify(result)]);
  });

  it('is one text per result with every string decoded, also keys', async () => {
    const { texts, detector } = recording();
    await shieldWith(detector).anonymizeResult({ 'k\ney': `a\n"b"\\c\u0001\ud800`, list: ['x\ty'] }, 's');
    expect(texts).toEqual(['{"k\ney":"a\n"b"\\c\u0001\ud800","list":["x\ty"]}']);
  });

  it('keeps JSON.stringify semantics: toJSON, omitted undefined, cycles and BigInt throw', () => {
    expect(detectionText({ d: new Date(0), u: undefined, t: { toJSON: () => 'a\nb' } }))
      .toBe('{"d":"1970-01-01T00:00:00.000Z","t":"a\nb"}');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => detectionText(cycle)).toThrow(TypeError);
    expect(() => detectionText({ n: 1n })).toThrow(TypeError);
    expect(detectionText(undefined)).toBeUndefined();
  });
});
