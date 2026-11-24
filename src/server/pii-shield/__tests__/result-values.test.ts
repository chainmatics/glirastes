import { describe, expect, it } from 'vitest';
import { createPiiShield } from '../create-pii-shield.js';
import { createRegexPiiDetector } from '../regex-detector.js';
import { decodeJsonStrings } from '../detection-text.js';
import type { PiiAuditEntry, PiiDetector } from '../../../types.js';

/**
 * anonymizeResult finds personal values in the string values of a result as
 * they are, not only in their JSON escapes. In the JSON text a line break is
 * the two characters `\n`: the e-mail after it was found as `nmax…` and left
 * in place, an IBAN or phone number after it was not found at all. It now
 * detects in the JSON text (as before) and, where that has escapes, also in
 * the decoded text, and never replaces less than before.
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
      // Only this one string: no other occurrence of the value can rescue it.
      const out = await shieldWith().anonymizeResult({ note: wrap(value) }, 's');
      expect(visible(out)).not.toContain(CORE[value]);
    });

    it(`${valueName} nested in arrays and objects after \\n does not reach the output`, async () => {
      const out = await shieldWith().anonymizeResult({ a: [{ b: { c: `Info\n${value}` } }] }, 's');
      expect(visible(out)).not.toContain(CORE[value]);
    });

    it(`${valueName} in a key after \\n is still found: the same value in a string is replaced`, async () => {
      const out = await shieldWith().anonymizeResult({ [`k\n${value}`]: `an ${value} x` }, 's');
      expect(Object.values(out as Record<string, string>)[0]).not.toContain(CORE[value]);
    });
  }

  it('a key is decoded too: a phone number after \\n in a key is learned and replaced where a string holds it', async () => {
    // In the string the number has no word boundary in front, so only the key finds it.
    const out = await shieldWith().anonymizeResult({ [`k\n${PHONE}`]: `x${PHONE}y` }, 's');
    expect(Object.values(out as Record<string, string>)[0]).not.toContain('12345678');
  });

  it('a value after an escaped quote and a line break (\\" then \\n) is found', async () => {
    const out = await shieldWith().anonymizeResult({ note: `Er sagte: "Hallo"\n${EMAIL}` }, 's');
    expect(visible(out)).not.toContain('max.mustermann');
  });

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

/**
 * Never less protection than detecting on the JSON text alone (the behavior up
 * to 0.24.2): the decoded text lets the built-in patterns run on across a real
 * line break or tab, where validation or overlap then drops a value the JSON
 * text still found. Each case was protected before and must stay protected.
 */
describe('anonymizeResult never replaces less than the JSON-text detection did', () => {
  const cases: Array<[string, unknown, string[]]> = [
    ['B1 phone before a line with a postcode', { kontakt: 'Tel.: +49 30 1234567\n10115 Berlin' }, ['1234567']],
    ['B1 mobile before a line with a postcode', { kontakt: 'Mobil: +49 151 98761234\n10115 Berlin' }, ['98761234']],
    ['B1 0049 number before a tab and digits', { row: '0049 30 1234567\t20240101' }, ['1234567']],
    ['B2 URL running into U+0001 and a phone', { a: 'https://x.example/p\u0001+49 40 7654321' }, ['7654321', 'x.example']],
    ['B2 URL running into a lone surrogate and a phone', { a: 'https://x.example/p\ud800+49 40 7654321' }, ['7654321', 'x.example']],
    ['B3 postcode, line break, city glued to an e-mail that also stands alone', { a: '10115\nBerlin.max@firma.de', b: 'an max@firma.de' }, ['max@firma']],
    ['B4 phone, tab, a date learned before', { geb: '12.03.1985', row: '030 12345678\t12.03.1985' }, ['12345678', '12.03.1985']],
  ];

  it.each(cases)('%s', async (_name, result, cores) => {
    const out = await shieldWith().anonymizeResult(result, 's');
    for (const core of cores) expect(visible(out)).not.toContain(core);
  });

  it('B5 an app detector with \\b before a non-word character still finds a value after a line break', async () => {
    const detector: PiiDetector = {
      detect: (text) => [...text.matchAll(/\b\+49\d{6,}/g)].map((m) => ({
        type: 'phone', start: m.index!, end: m.index! + m[0].length, score: 1, text: m[0],
      })),
    };
    const out = await shieldWith(detector).anonymizeResult({ note: 'Tel\n+4930123456' }, 's');
    expect(visible(out)).not.toContain('4930123456');
  });

  it('a value found only in decoded text earlier in the session does not cut into a value of a later result', async () => {
    const shield = shieldWith();
    // Only the decoded text finds this phone number (no word boundary after `u0012` in the JSON text).
    await shield.anonymizeResult({ a: 'x\u0012089 9876543' }, 's');
    // The JSON text of this result finds the longer e-mail value that contains the phone digits.
    const out = await shield.anonymizeResult({ a: '\u0012089 9876543+.j_doe+tag@mail.example.org' }, 's');
    expect(visible(out)).not.toContain('j_doe+tag');
  });

  it('a tab column next to a phone number the JSON text found stays its own column', async () => {
    const out = await shieldWith().anonymizeResult({ tsv: 'Muster\t+49 151 98761234\t42' }, 's') as { tsv: string };
    expect(out.tsv).not.toContain('98761234');
    expect(out.tsv.endsWith('\t42')).toBe(true);
  });
});

/** The built-in detector, answering after `ms` (a remote detector, or one under load). */
const slowDetector = (ms: number, inner: PiiDetector = createRegexPiiDetector()): PiiDetector => ({
  detect: async (text, locales) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return inner.detect(text, locales);
  },
});

/** A: its JSON text finds the phone number, and it has an escape (a second detector call). C: only A's value protects it. */
const A = { note: 'Tel 030 1234567\nRueckruf' };
const C = { note: 'Tel030 1234567' };

describe('results of one session shielded at the same time', () => {
  it('a value one result learned from its JSON text protects a parallel result as before', async () => {
    for (const detector of [createRegexPiiDetector(), slowDetector(20)]) {
      const shield = shieldWith(detector);
      const [a, c] = await Promise.all([shield.anonymizeResult(A, 's'), shield.anonymizeResult(C, 's')]);
      expect(visible(a)).not.toContain('1234567');
      expect(visible(c)).not.toContain('1234567');
    }
  });

  it('only the second detector call fails: that result is refused, the next one is still protected', async () => {
    const inner = createRegexPiiDetector();
    let failed = false;
    const detector: PiiDetector = {
      detect: async (text, locales) => {
        if (text.includes('\n') && !failed) { failed = true; throw new Error('detector timeout'); }
        return inner.detect(text, locales);
      },
    };
    const shield = shieldWith(detector);
    await expect(shield.anonymizeResult(A, 's')).rejects.toThrow('detector timeout');
    expect(visible(await shield.anonymizeResult(C, 's'))).not.toContain('1234567');
  });
});

describe('the order of replacement across a session', () => {
  /** `ab12cd` only right after a real line break (so only in decoded text); the longer value anywhere but not after a word character. */
  const detector: PiiDetector = {
    detect: (text) => [...text.matchAll(/(?<=\n)ab12cd|(?<![\\\w])erika ab12cd musterfrau/g)].map((m) => ({
      type: 'person', start: m.index!, end: m.index! + m[0].length, score: 1, text: m[0],
    })),
  };

  it('a value from a user message is replaced before a value found only in decoded text earlier', async () => {
    const shield = shieldWith(detector);
    await shield.anonymizeResult({ a: '\nab12cd' }, 's');
    await shield.outbound('Bitte an erika ab12cd musterfrau', 's');
    // Here the JSON text does not find the longer value (`n` before it); the user message taught it.
    const out = await shield.anonymizeResult({ a: '\nerika ab12cd musterfrau' }, 's');
    expect(visible(out)).not.toContain('musterfrau');
  });

  it('clearSession forgets the order too: the session then behaves like a new one', async () => {
    const steps = async (shield: ReturnType<typeof shieldWith>) => [
      await shield.anonymizeResult({ a: '\nab12cd' }, 's'),
      await shield.anonymizeResult({ a: '\nerika ab12cd musterfrau' }, 's'),
    ];
    const used = shieldWith(detector);
    await used.anonymizeResult({ a: 'erika ab12cd musterfrau' }, 's');
    used.clearSession('s');
    expect(await steps(used)).toEqual(await steps(shieldWith(detector)));
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

  it('with escaped characters: first the JSON text, then the same text with every string decoded, also keys', async () => {
    const { texts, detector } = recording();
    const result = { 'k\ney': `a\n"b"\\c\u0001\ud800`, list: ['x\ty'] };
    await shieldWith(detector).anonymizeResult(result, 's');
    expect(texts).toEqual([JSON.stringify(result), '{"k\ney":"a\n"b"\\c\u0001\ud800","list":["x\ty"]}']);
  });

  it('one audit entry per result: the JSON-text detections, then those only the decoded text found', async () => {
    const audit: PiiAuditEntry[] = [];
    const shield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector(), onAudit: (entry) => audit.push(entry) });
    await shield.anonymizeResult({ note: `Kontakt:\n${EMAIL}` }, 's');
    expect(audit).toHaveLength(1);
    // `nmax.mustermann@firma.de` (JSON text, as before) and `max.mustermann@firma.de` (decoded text).
    expect(audit[0]!.totalDetected).toBe(2);
    expect(shield.getComplianceSummary('s').totalToolCalls).toBe(1);
  });

  it('keeps JSON.stringify semantics: toJSON, omitted undefined, cycles and BigInt throw', async () => {
    expect(decodeJsonStrings(JSON.stringify({ d: new Date(0), u: undefined, t: { toJSON: () => 'a\nb' } })))
      .toBe('{"d":"1970-01-01T00:00:00.000Z","t":"a\nb"}');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(shieldWith().anonymizeResult(cycle, 's')).rejects.toThrow(TypeError);
    await expect(shieldWith().anonymizeResult({ n: 1n }, 's')).rejects.toThrow(TypeError);
  });
});
