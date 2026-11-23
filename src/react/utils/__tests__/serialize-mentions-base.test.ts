import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MentionData, MentionSerializationConfig } from '../../types.js';
import { serializeMentionsForSend } from '../mention-markup.js';

interface BaseCase {
  name: string;
  text: string;
  mentions: MentionData[];
  options?: MentionSerializationConfig;
  /** What `serializeMentionsForSend` of origin/main (0.23.0, before canonical labels) sent. */
  expected: string;
}

const cases = JSON.parse(
  readFileSync(new URL('./__fixtures__/serialize-mentions-base.json', import.meta.url), 'utf8'),
) as BaseCase[];

describe('serializeMentionsForSend sends ordinary input byte-identical to the release before', () => {
  it('has the recorded corpus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(93);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(serializeMentionsForSend(entry.text, entry.mentions, entry.options)).toBe(entry.expected);
  });
});

interface OverlapCase extends BaseCase {
  /** Whether base wrote no marker inside another one. */
  baseWellFormed: boolean;
}

const overlapCases = JSON.parse(
  readFileSync(new URL('./__fixtures__/serialize-mentions-overlap-base.json', import.meta.url), 'utf8'),
) as OverlapCase[];

const MARKER = /\{\{mention:([^:}]{1,200}):([^:}]{1,200}):([^}]{1,1000})\}\}/g;
const wellFormed = (out: string) => {
  const markers = [...out.matchAll(MARKER)];
  return markers.length === out.split('{{mention:').length - 1 && markers.every((m) => !m[3]!.includes('{{'));
};

describe('tokens with whitespace, overlaps and repeats: as base, recorded from base code', () => {
  it('a token with whitespace keeps every occurrence base replaced', () => {
    expect(serializeMentionsForSend('#t @p @p @p', [
      { id: '1', type: 'user', label: 'T', prefix: '#', slug: 't @p' },
      { id: '2', type: 'user', label: 'P', prefix: '@', slug: 'p @p' },
    ])).toBe('{{mention:user:1:T}} {{mention:user:2:P}}');
  });

  it('has the recorded fuzz corpus', () => {
    expect(overlapCases.length).toBeGreaterThanOrEqual(600);
  });

  it('is byte-identical to base wherever base wrote no nested marker', () => {
    const differences = overlapCases
      .filter((entry) => entry.baseWellFormed)
      .filter((entry) => serializeMentionsForSend(entry.text, entry.mentions, entry.options) !== entry.expected)
      .map((entry) => entry.name);
    expect(differences).toEqual([]);
  });

  it('writes no nested marker where base did (the declared single-pass change)', () => {
    const nested = overlapCases.filter((entry) => !entry.baseWellFormed);
    expect(nested.length).toBeGreaterThan(0);
    for (const entry of nested) {
      const sent = serializeMentionsForSend(entry.text, entry.mentions, entry.options);
      expect(wellFormed(sent), entry.name).toBe(true);
    }
  });
});

const whitespaceCases = JSON.parse(
  readFileSync(new URL('./__fixtures__/serialize-mentions-whitespace-base.json', import.meta.url), 'utf8'),
) as OverlapCase[];

describe('prefixes and slugs with whitespace: boundaries as base, recorded from base code', () => {
  it('a space base consumed for a match is no boundary for the next one', () => {
    expect(serializeMentionsForSend('a    b', [{ id: '1', type: 'u', label: '!', prefix: ' ' }]))
      .toBe('a {{mention:u:1:!}}  b');
  });

  it('a space an earlier mention claimed is no boundary', () => {
    expect(serializeMentionsForSend('a   x', [
      { id: '1', type: 'u', label: '!', prefix: ' ' },
      { id: '2', type: 'u', label: 'X', slug: 'x', prefix: ' ' },
    ])).toBe('a {{mention:u:1:!}} x');
  });

  it('has the recorded fuzz corpus (canonical and raw)', () => {
    expect(whitespaceCases.length).toBeGreaterThanOrEqual(800);
    expect(whitespaceCases.some((entry) => entry.options?.labels === 'raw')).toBe(true);
  });

  it('is byte-identical to base wherever base wrote well-formed markers', () => {
    const differences = whitespaceCases
      .filter((entry) => entry.baseWellFormed)
      .filter((entry) => serializeMentionsForSend(entry.text, entry.mentions, entry.options) !== entry.expected)
      .map((entry) => entry.name);
    expect(differences).toEqual([]);
  });
});
