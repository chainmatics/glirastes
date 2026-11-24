import { describe, expect, it } from 'vitest';
import { createPiiShield } from '../create-pii-shield.js';
import { createRegexPiiDetector } from '../regex-detector.js';

/**
 * A session that began before the longest-first change. The mapping lives
 * only in the shield's process memory (`createSessionStore`, one `Map` per
 * `createPiiShield`), so a session can only meet the new code in the same
 * process; this replays the same calls. The frozen values below are what
 * the shield of 0.24.2 gave for these calls in session `ai-u1`.
 */
const SESSION = 'ai-u1';
const MESSAGE = 'Mail an max@firma.de, Seite https://firma.de , Telefon +49 151 23456789 bitte.';
const RESULT = {
  email: 'johannes.max@firma.de',
  url: 'https://firma.de/u/max.mustermann@firma.de',
  phone: '+49 151 23456789-12',
  other: 'anna@kanzlei.de',
};
const LATER = 'Und lisa@kanzlei.de';

const V0_24_2 = {
  message: 'Mail an sophie.schmidt@test.de, Seite https://placeholder.de/8212 , Telefon +49 42 8405800 bitte.',
  /** Broken by the old order: each keeps a piece of the original. */
  result: {
    email: 'johannes.sophie.schmidt@test.de',
    url: 'https://placeholder.de/8212/u/max.mustermann@firma.de',
    phone: '+49 42 8405800-12',
    other: 'marie.weber@test.de',
  },
  later: 'Und sophie.becker@test.de',
};

async function replay() {
  const shield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });
  const message = await shield.outbound(MESSAGE, SESSION);
  const result = await shield.anonymizeResult(RESULT, SESSION) as typeof RESULT;
  const later = await shield.outbound(LATER, SESSION);
  return { shield, message, result, later };
}

describe('pii shield: a session that began with the 0.24.2 behaviour', () => {
  it('gives the same pseudonyms as 0.24.2: same values, same order, same generator state', async () => {
    const { message, result, later } = await replay();
    expect(message).toBe(V0_24_2.message);
    expect(result.other).toBe(V0_24_2.result.other);
    // Pseudonyms made after the result are unchanged too: the replacement never draws from the generator.
    expect(later).toBe(V0_24_2.later);
  });

  it('only the values that contain a known one change, to a whole pseudonym', async () => {
    const { result } = await replay();
    for (const field of ['email', 'url', 'phone'] as const) {
      expect(result[field]).not.toBe(V0_24_2.result[field]);
      expect(result[field]).not.toContain('max');
      expect(result[field]).not.toMatch(/-12$/);
    }
  });

  it('restores text the old order broke to the right originals', async () => {
    const { shield } = await replay();
    expect(shield.inbound(JSON.stringify(V0_24_2.result), SESSION)).toBe(JSON.stringify(RESULT));
    expect(shield.rehydrateArgs({ ...V0_24_2.result }, SESSION)).toEqual(RESULT);
    expect(shield.inbound(V0_24_2.message, SESSION)).toBe(MESSAGE);
  });

  it('restores the new pseudonyms of the long values as well', async () => {
    const { shield, result } = await replay();
    expect(shield.rehydrateArgs({ ...result }, SESSION)).toEqual(RESULT);
  });

  it('another process (a restart, the upgrade itself) has no mapping: pseudonyms stay as they are', () => {
    const fresh = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });
    expect(fresh.inbound(V0_24_2.message, SESSION)).toBe(V0_24_2.message);
    expect(fresh.rehydrateArgs({ ...V0_24_2.result }, SESSION)).toEqual(V0_24_2.result);
  });
});
