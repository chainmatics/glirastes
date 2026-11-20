import { describe, expect, it } from 'vitest';
import { parseMentionSegments } from '../mention-markup.js';

describe('parseMentionSegments on hostile input', () => {
  it('stays fast on many unclosed mention markers', () => {
    const input = `{{{{mention:9:9:${'{{{{mention:9:9:|'.repeat(20_000)}`;
    expect(parseMentionSegments(input)).toEqual([{ kind: 'text', text: input }]);
    // A real duration: the bounded marker pattern parses this in about 40 ms, an unbounded
    // (backtracking) one needs about 3 s. Only the parse is timed, and the fastest of three runs
    // counts, because a loaded runner only ever adds time: one timed run including the comparison
    // took 690 ms on a loaded machine and failed the former 500 ms bound with the parser unchanged.
    let fastest = Infinity;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      parseMentionSegments(input);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(1_000);
  });

  it('still parses a regular marker', () => {
    expect(parseMentionSegments('a {{mention:task:t1:Erste Aufgabe}} b').map((s) => s.kind)).toEqual(['text', 'mention', 'text']);
  });
});
