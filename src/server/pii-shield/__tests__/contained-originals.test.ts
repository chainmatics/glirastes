import { describe, expect, it } from 'vitest';
import { createPiiShield } from '../create-pii-shield.js';
import { createRegexPiiDetector } from '../regex-detector.js';
import type { PiiAuditEntry, PiiDetector, PiiEntity } from '../../../types.js';

/**
 * A known original that is part of a longer one must not break the longer
 * one: the shield replaces the longest original first, in one pass, so no
 * piece of the longer original stays in clear text and no pseudonym already
 * set is changed again.
 */

/**
 * Every piece of `original` of at least `min` characters that `text` still
 * holds. Pieces of or with `https://` are left aside: pseudonym URLs share them.
 */
function fragmentsOf(original: string, text: string, min = 6): string[] {
  const found: string[] = [];
  for (let start = 0; start + min <= original.length; start += 1) {
    const piece = original.slice(start, start + min);
    if (!'https://'.includes(piece) && !piece.includes('://') && text.includes(piece)) found.push(piece);
  }
  return found;
}

const regexShield = () => createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });

describe('pii shield: an original contained in a longer one', () => {
  it('label and id in one result: the longer e-mail is replaced whole', async () => {
    const shield = regexShield();
    const shown = JSON.stringify(await shield.anonymizeResult(
      [{ label: 'Max <max@firma.de>', id: 'johannes.max@firma.de' }], 's',
    ));
    expect(fragmentsOf('johannes.max@firma.de', shown)).toEqual([]);
    expect(fragmentsOf('max@firma.de', shown)).toEqual([]);
  });

  it('label in one result, id in a later one of the same session', async () => {
    const shield = regexShield();
    await shield.anonymizeResult({ label: 'Max <max@firma.de>' }, 's');
    const shown = JSON.stringify(await shield.anonymizeResult({ id: 'johannes.max@firma.de' }, 's'));
    expect(fragmentsOf('johannes.max@firma.de', shown)).toEqual([]);
  });

  it('a URL from the user message, then a longer URL with an e-mail in a value', async () => {
    const shield = regexShield();
    const message = await shield.outbound('Schau auf https://firma.de nach', 's');
    expect(message).not.toContain('firma.de');
    const shown = JSON.stringify(await shield.anonymizeResult(
      { label: 'Profil https://firma.de/u/max.mustermann@firma.de' }, 's',
    ));
    expect(fragmentsOf('https://firma.de/u/max.mustermann@firma.de', shown)).toEqual([]);
  });

  it('outbound replaces what it detects, so a longer value in a later message is replaced whole', async () => {
    const shield = regexShield();
    await shield.outbound('Schreib an max@firma.de', 's');
    const message = await shield.outbound('und an johannes.max@firma.de', 's');
    expect(fragmentsOf('johannes.max@firma.de', message)).toEqual([]);
  });

  describe.each([
    ['long known first', ['johannes.max@firma.de'], 'johannes.max@firma.de und max@firma.de'],
    ['short known first', ['max@firma.de'], 'johannes.max@firma.de und max@firma.de'],
    ['both in the same text', [], 'max@firma.de und johannes.max@firma.de'],
    ['three nested values', ['max@firma.de', 'https://firma.de'], 'https://firma.de/u/johannes.max@firma.de, johannes.max@firma.de, max@firma.de'],
  ])('order: %s', (_name, known, text) => {
    it('leaves no piece of any original and restores every pseudonym', async () => {
      const shield = regexShield();
      for (const value of known) await shield.outbound(`Bekannt: ${value}`, 's');
      const shown = await shield.anonymizeResult({ text }, 's') as { text: string };
      for (const original of ['https://firma.de/u/johannes.max@firma.de', 'johannes.max@firma.de', 'max@firma.de']) {
        expect(fragmentsOf(original, shown.text)).toEqual([]);
      }
      expect(shield.inbound(shown.text, 's')).toBe(text);
      expect(shield.rehydrateArgs({ text: shown.text }, 's')).toEqual({ text });
    });
  });

  it('a pseudonym set once is not changed by a later original it happens to contain', async () => {
    // The detector finds the listed names; the second name is the last name
    // of the first name's pseudonym, so a replacement in sequence would
    // replace inside the pseudonym again.
    const names = ['Kai Fischer'];
    const detector: PiiDetector = {
      detect(text) {
        const found: PiiEntity[] = [];
        for (const name of names) {
          for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + name.length)) {
            found.push({ type: 'person', start: at, end: at + name.length, score: 1, text: name });
          }
        }
        return found.sort((a, b) => a.start - b.start).filter((e, i, all) => i === 0 || e.start >= all[i - 1]!.end);
      },
    };
    const shield = createPiiShield({ locale: 'de', detector });
    const first = await shield.outbound('Kai Fischer', 's');
    const lastName = first.split(' ')[1]!;
    names.push(lastName);
    const shown = await shield.anonymizeResult({ a: 'Kai Fischer', b: lastName }, 's') as { a: string; b: string };
    expect(shown.a).toBe(first);
    expect(shown.b).not.toBe(lastName);
    expect(shield.rehydrateArgs(shown, 's')).toEqual({ a: 'Kai Fischer', b: lastName });
  });

  it('back translation: a pseudonym that is part of another pseudonym does not break it', async () => {
    // 150 people exhaust the pool of 100 fake names, so the session gives
    // suffixed pseudonyms (`Anna Müller-1`) that contain an earlier one.
    const people = Array.from({ length: 150 }, (_, index) => `Person${String(index).padStart(3, '0')}`);
    const detector: PiiDetector = {
      detect(text) {
        return [...text.matchAll(/Person\d{3}/g)].map((m) => ({ type: 'person', start: m.index!, end: m.index! + m[0].length, score: 1, text: m[0] }));
      },
    };
    const shield = createPiiShield({ locale: 'de', detector });
    const pseudonyms = (await shield.outbound(people.join('|'), 's')).split('|');
    const suffixed = pseudonyms.filter((p) => pseudonyms.some((other) => other !== p && p.includes(other)));
    expect(suffixed.length).toBeGreaterThan(0);
    pseudonyms.forEach((pseudonym, index) => {
      expect(shield.inbound(`Ruf ${pseudonym} an.`, 's')).toBe(`Ruf ${people[index]} an.`);
      expect(shield.rehydrateArgs({ who: pseudonym, note: `für ${pseudonym}` }, 's')).toEqual({ who: people[index], note: `für ${people[index]}` });
    });
  });

  it('back translation of the pseudonyms of a long and a short value, alone and inside text', async () => {
    const shield = regexShield();
    await shield.outbound('max@firma.de', 's');
    const shown = await shield.anonymizeResult({ id: 'johannes.max@firma.de' }, 's') as { id: string };
    const short = await shield.outbound('max@firma.de', 's');
    expect(shield.rehydrateArgs({ to: shown.id, cc: short, body: `an ${shown.id}, cc ${short}` }, 's')).toEqual({
      to: 'johannes.max@firma.de', cc: 'max@firma.de', body: 'an johannes.max@firma.de, cc max@firma.de',
    });
  });

  /**
   * Known limit: two originals that overlap without one containing the
   * other. The longer one is replaced, the rest of the shorter one stays.
   * Here `37/1571/24067` is known and the detector reads the e-mail as
   * `24067Z.huber@kanzlei-x.de`, so `37/1571/` stays in clear text.
   */
  it('known limit: a partial overlap leaves the rest of the shorter original', async () => {
    const shield = regexShield();
    await shield.outbound('Steuer 37/1571/24067', 's');
    const shown = await shield.anonymizeResult({ file: 'Akte 37/1571/24067Z.huber@kanzlei-x.de' }, 's') as { file: string };
    expect(shown.file).not.toContain('huber@kanzlei-x.de');
    expect(shown.file.startsWith('Akte 37/1571/')).toBe(true);
  });

  it.fails('known limit, wanted: no piece of a partially overlapping original stays', async () => {
    const shield = regexShield();
    await shield.outbound('Steuer 37/1571/24067', 's');
    const shown = await shield.anonymizeResult({ file: 'Akte 37/1571/24067Z.huber@kanzlei-x.de' }, 's') as { file: string };
    expect(fragmentsOf('37/1571/24067', shown.file)).toEqual([]);
  });
});

/**
 * Inputs whose originals are never part of one another give the same text,
 * the same pseudonyms and the same audit as before the longest-first change.
 * The digest below was computed with the shield of 0.24.2 for this fixed
 * sample (seeded, 300 sessions).
 */
describe('pii shield: unchanged output without contained originals', () => {
  it('matches the frozen digest of a fixed random sample', async () => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    for (const line of await differentialSample(300)) hash.update(`${line}\n`);
    expect(hash.digest('hex')).toBe(FROZEN_DIGEST);
  });
});

const FROZEN_DIGEST = '6be3c05846af478dcbc198fe4694f1953d8c912cf7d64f7f6044d029b4ac0a95';

/** xorshift32, seeded. */
function prng(seed: number) {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

const CATEGORIES = ['person', 'email', 'phone', 'iban', 'url', 'custom', 'address', 'tax_id'];

/**
 * One line per call of a seeded sample: sessions with up to 30 originals
 * (`⟨…⟩`, distinct, so none is part of another and occurrences never
 * overlap), texts and objects of filler, originals and pseudonyms, through
 * `outbound`, `anonymizeResult`, `inbound` and `rehydrateArgs`, plus the
 * audit entries (without timestamps).
 */
export async function differentialSample(sessions: number, seed = 20261124): Promise<string[]> {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const word = (min: number, max: number, alphabet: string) =>
    Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => pick(alphabet as unknown as string[])).join('');
  const filler = () => word(0, 12, 'abc xyz.,:-/@1234567890ÄöüßAB');
  const lines: string[] = [];
  for (let s = 0; s < sessions; s += 1) {
    const originals = new Map<string, string>();
    const count = 1 + Math.floor(random() * 30);
    while (originals.size < count) originals.set(`⟨${word(1, 10, 'abcdefghXYZ0123456789@._-')}⟩`, pick(CATEGORIES));
    const list = [...originals.keys()];
    const detectable = new Set(list.filter(() => random() < 0.7));
    const audits: PiiAuditEntry[] = [];
    const detector: PiiDetector = {
      detect(text) {
        const found: PiiEntity[] = [];
        for (const match of text.matchAll(/⟨[^⟨⟩]*⟩/g)) {
          if (detectable.has(match[0]) && random() < 0.75) {
            found.push({ type: originals.get(match[0])!, start: match.index!, end: match.index! + match[0].length, score: 0.9, text: match[0] });
          }
        }
        return found;
      },
    };
    const shield = createPiiShield({ locale: pick(['de', 'en']), detector, onAudit: (entry) => audits.push(entry) });
    const sessionId = `session-${s}`;
    const pseudonyms: string[] = [];
    const text = (n: number) => Array.from({ length: n }, () => (random() < 0.5 ? pick(list) : filler())).join(random() < 0.5 ? ' ' : '');
    const modelText = (n: number) => Array.from({ length: n }, () => (random() < 0.5 && pseudonyms.length ? pick(pseudonyms) : filler())).join(' ');
    const collect = (value: unknown) => {
      for (const match of JSON.stringify(value).matchAll(/[^"\\⟨⟩]+/g)) pseudonyms.push(match[0]);
    };
    const calls = 2 + Math.floor(random() * 8);
    for (let c = 0; c < calls; c += 1) {
      const kind = Math.floor(random() * 4);
      if (kind === 0) {
        const out = await shield.outbound(text(1 + Math.floor(random() * 6)), sessionId);
        lines.push(`outbound ${JSON.stringify(out)}`);
      } else if (kind === 1) {
        const value = random() < 0.3
          ? text(1 + Math.floor(random() * 6))
          : { a: text(3), list: [text(2), pick(list), 42, null, true], nested: { b: text(2), [pick(['x', 'y'])]: text(1) } };
        const out = await shield.anonymizeResult(value, sessionId);
        collect(out);
        lines.push(`result ${JSON.stringify(out)}`);
      } else if (kind === 2) {
        lines.push(`inbound ${JSON.stringify(shield.inbound(modelText(1 + Math.floor(random() * 6)), sessionId))}`);
      } else {
        const whole = pseudonyms.length ? pick(pseudonyms) : filler();
        const out = shield.rehydrateArgs({ id: whole, note: modelText(3), list: [modelText(1), 7] }, sessionId);
        lines.push(`rehydrate ${JSON.stringify(out)}`);
      }
    }
    lines.push(`audit ${JSON.stringify(audits.map(({ timestamp: _t, ...rest }) => rest))}`);
    const { duration: _d, ...summary } = shield.getComplianceSummary(sessionId);
    lines.push(`summary ${JSON.stringify(summary)}`);
  }
  return lines;
}
