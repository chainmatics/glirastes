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
    expect(cases.length).toBeGreaterThanOrEqual(80);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(serializeMentionsForSend(entry.text, entry.mentions, entry.options)).toBe(entry.expected);
  });
});
