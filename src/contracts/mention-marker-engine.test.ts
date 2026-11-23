import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalMentionLabel,
  cleanDisplayText,
  cleanDisplayTextWithPassLimit,
  parseMentionMarkers,
  serializeMentionMarker,
} from './mention-marker.js';
import { serializeMentionsForSend } from '../react/utils/mention-markup.js';

type ModuleUnderTest = typeof import('./mention-marker.js');

/** Loads the module afresh with a global `RegExp` that throws for sources matching `rejects`. */
async function loadWithEngine(rejects: RegExp): Promise<ModuleUnderTest> {
  const Original = RegExp;
  class LimitedRegExp extends Original {
    constructor(pattern: string | RegExp, flags?: string) {
      const source = typeof pattern === 'string' ? pattern : pattern.source;
      if (rejects.test(source)) throw new SyntaxError(`Invalid regular expression: /${source}/: Invalid property name`);
      super(pattern, flags);
    }
  }
  vi.resetModules();
  vi.stubGlobal('RegExp', LimitedRegExp);
  try {
    return await import('./mention-marker.js');
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const PERSIAN = 'می\u200cخواهم';
const MALAYALAM_CHILLU = 'മോഹന\u0d4d\u200d';
const MONGOLIAN = 'ᠪᠠ\u180bᠢ\u180eᠠ';
const FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';

describe('engines without newer Unicode properties or scripts', () => {
  it('loads when every Script_Extensions value is rejected, and drops the script joiner exceptions', async () => {
    const limited = await loadWithEngine(/\\p\{scx=/);
    expect(limited.canonicalMentionLabel(PERSIAN)).toBe('میخواهم');
    expect(limited.canonicalMentionLabel(MALAYALAM_CHILLU)).toBe('മോഹന\u0d4d');
    expect(limited.canonicalMentionLabel(MONGOLIAN)).toBe('ᠪᠠᠢᠠ');
    // Everything else still works.
    expect(limited.canonicalMentionLabel(`Acme <!--x--> ${FAMILY}`)).toBe(`Acme ‹!--x--› ${FAMILY}`);
    expect(limited.parseMentionMarkers('{{mention:t:1:A}}')).toHaveLength(1);
    expect(limited.serializeMentionMarker({ type: 't', id: '1', label: PERSIAN })).toBe('{{mention:t:1:میخواهم}}');
  });

  it('keeps the scripts the engine knows when only newer ones are rejected', async () => {
    const limited = await loadWithEngine(/\\p\{scx=(Ougr|Chrs|Sogd|Rohg|Arab)\}/);
    expect(limited.canonicalMentionLabel(PERSIAN)).toBe('میخواهم');
    expect(limited.canonicalMentionLabel('क\u094d\u200dष')).toBe('क\u094d\u200dष');
  });

  it('loads without Extended_Pictographic and falls back to Emoji_Presentation for emoji joiners', async () => {
    const limited = await loadWithEngine(/Extended_Pictographic/);
    expect(limited.canonicalMentionLabel(FAMILY)).toBe(FAMILY);
    expect(limited.canonicalMentionLabel('a\u200d\u{1f468}')).toBe('a\u{1f468}');
  });

  it('loads when the engine rejects every property escape it might not know', async () => {
    const limited = await loadWithEngine(/\\p\{(scx=|Extended_Pictographic)/);
    expect(() => limited.canonicalMentionLabel(`${PERSIAN} ${FAMILY} ${MONGOLIAN}`)).not.toThrow();
    expect(limited.isMentionMarkerId('a b')).toBe(true);
  });

  it('works without Intl.Segmenter', () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const original = intl.Segmenter;
    intl.Segmenter = undefined;
    try {
      expect(canonicalMentionLabel(`${'x'.repeat(119)}${FAMILY}`)).toBe(`${'x'.repeat(119)}…`);
    } finally {
      intl.Segmenter = original;
    }
  });
});

describe('repeated removal and NFC reach a fixed point', () => {
  // Removing a joiner lets NFC reorder the marks around it, which changes the neighbours of the next joiner.
  const reviewerInputs = [
    'ൺ\u200d\u0952\u200c\u0338\u0951',
    '\u0654\u200d\u064e\u200d\u0338\u0654',
  ];

  it.each(reviewerInputs)('%j: the second call equals the first', (input) => {
    const once = canonicalMentionLabel(input, { id: '1' });
    expect(canonicalMentionLabel(once, { id: '1' })).toBe(once);
    expect(cleanDisplayText(cleanDisplayText(input))).toBe(cleanDisplayText(input));
  });

  it.each(reviewerInputs)('%j: marker label and context block label agree, and the marker reads back canonical', (input) => {
    const sent = serializeMentionsForSend('@x', [{ id: '7', type: 'user', label: input, slug: 'x', prefix: '@' }], { includeContextBlock: true });
    const block = /^<!--context:\[Referenced entities: (.*) \(ID: 7\)\]--> /u.exec(sent)!;
    const [marker] = parseMentionMarkers(sent);
    expect(marker!.label).toBe(block[1]);
    expect(marker!.canonical).toBe(true);
    const written = serializeMentionMarker({ type: 'user', id: '7', label: input })!;
    expect(parseMentionMarkers(written)[0]!.canonical).toBe(true);
  });

  it('is idempotent with stacked marks of different combining classes around joiners (property)', () => {
    let seed = 0x0c1a55;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pieces = ['\u200d', '\u200c', '\u0338', '\u0316', '\u0951', '\u0952', '\u064e', '\u0654', '\u05b0', '\u0301',
      'ൺ', 'ന', '\u0d4d', 'م', 'ی', 'क', '\u094d', 'e', '\u{1f468}', '\ufe0f', '\u180e', 'ᠠ'];
    for (let run = 0; run < 5_000; run += 1) {
      let label = '';
      const parts = 1 + Math.floor(next() * 12);
      for (let i = 0; i < parts; i += 1) label += pieces[Math.floor(next() * pieces.length)];
      const once = canonicalMentionLabel(label, { id: '1' });
      expect(canonicalMentionLabel(once, { id: '1' }), JSON.stringify(label)).toBe(once);
      expect(once.normalize('NFC'), JSON.stringify(label)).toBe(once);
      const marker = serializeMentionMarker({ type: 'user', id: '1', label })!;
      expect(parseMentionMarkers(marker)[0]!.canonical, JSON.stringify(label)).toBe(true);
    }
  }, 30_000);

  it('at the pass bound, removes every remaining joiner and invisible character, and the result is stable', () => {
    for (const input of reviewerInputs) {
      const capped = cleanDisplayTextWithPassLimit(input, 1);
      expect(capped).not.toMatch(/[\u200c\u200d\p{Cf}\p{Default_Ignorable_Code_Point}]/u);
      expect(cleanDisplayText(capped)).toBe(capped);
      expect(capped.normalize('NFC')).toBe(capped);
    }
    // Without hitting the bound the joiners the rules keep stay.
    expect(cleanDisplayTextWithPassLimit('می\u200cخ', 1)).toBe('می\u200cخ');
  });
});
