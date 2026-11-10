import { describe, expect, it } from 'vitest';
import { parseMentionSegments } from '../mention-markup.js';

describe('parseMentionSegments on hostile input', () => {
  it('stays fast on many unclosed mention markers', () => {
    const input = `{{{{mention:9:9:${'{{{{mention:9:9:|'.repeat(20_000)}`;
    const started = performance.now();
    expect(parseMentionSegments(input)).toEqual([{ kind: 'text', text: input }]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('still parses a regular marker', () => {
    expect(parseMentionSegments('a {{mention:task:t1:Erste Aufgabe}} b').map((s) => s.kind)).toEqual(['text', 'mention', 'text']);
  });
});
