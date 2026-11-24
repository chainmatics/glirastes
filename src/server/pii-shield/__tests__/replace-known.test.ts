import { describe, expect, it } from 'vitest';
import { longestFirst, OVERLAP_PLACEHOLDER, replaceKnown } from '../replace-known.js';

const replace = (text: string, pairs: Array<[string, string]>) => replaceKnown(text, longestFirst(pairs));
const covered = (text: string, pairs: Array<[string, string]>) => replaceKnown(text, longestFirst(pairs), '#');

describe('replaceKnown', () => {
  it('replaces the longest value first, whichever order the values came in', () => {
    const pairs: Array<[string, string]> = [['max@firma.de', 'S'], ['johannes.max@firma.de', 'L']];
    expect(replace('johannes.max@firma.de, max@firma.de', pairs)).toBe('L, S');
    expect(replace('johannes.max@firma.de, max@firma.de', [...pairs].reverse())).toBe('L, S');
  });

  it('three nested values', () => {
    expect(replace('https://f.de/u/a@f.de|a@f.de|https://f.de', [
      ['https://f.de', 'U'], ['a@f.de', 'E'], ['https://f.de/u/a@f.de', 'P'],
    ])).toBe('P|E|U');
  });

  it('never searches a replacement again', () => {
    expect(replace('Kai Fischer, Weber', [['Kai Fischer', 'Lena Weber'], ['Weber', 'Tom Roe']])).toBe('Lena Weber, Tom Roe');
  });

  it('keeps the given order for values of equal length', () => {
    expect(replace('abc', [['ab', 'X'], ['bc', 'Y']])).toBe('Xc');
    expect(replace('abc', [['bc', 'Y'], ['ab', 'X']])).toBe('aY');
  });

  it('a partial overlap without cover (the way back): the longer value wins, the rest of the shorter one stays', () => {
    expect(replace('37/1571/24067Z.huber@kanzlei-x.de', [['37/1571/24067', 'T'], ['24067Z.huber@kanzlei-x.de', 'E']])).toBe('37/1571/E');
  });

  it('a partial overlap with cover (to the model): the rest of the shorter value becomes the cover', () => {
    expect(covered('37/1571/24067Z.huber@kanzlei-x.de', [['37/1571/24067', 'T'], ['24067Z.huber@kanzlei-x.de', 'E']])).toBe('#E');
    expect(covered('030 123456 030 123456-99', [['030 123456', 'S'], ['030 123456 030', 'L']])).toBe('L#-99');
    // A rest on both sides of a longer value, and a value between two longer ones.
    expect(covered('xabcdefgy', [['abcdefg', 'L'], ['xabc', 'A'], ['efgy', 'B']])).toBe('#L#');
    expect(covered('ab1234cd', [['ab12', 'A'], ['34cd', 'B'], ['1234', 'C']])).toBe('AB');
    expect(covered('ab12x34cd', [['ab12', 'A'], ['34cd', 'B'], ['12x34', 'C']])).toBe('#C#');
  });

  it('with cover, an occurrence that overlaps another of the same value is covered too; neighbouring covers become one', () => {
    expect(covered('abcabcab', [['abcab', 'P']])).toBe('P#');
    expect(replace('abcabcab', [['abcab', 'P']])).toBe('Pcab');
    expect(covered('aaaaa', [['aa', 'X']])).toBe('XX#');
    expect(covered('a'.repeat(2500), [['a'.repeat(1000), 'P']])).toBe('PP#');
    expect(OVERLAP_PLACEHOLDER).toBe('[REDACTED]');
  });

  it('takes occurrences left to right without overlap, as split does', () => {
    expect(replace('aaaaa', [['aa', 'X']])).toBe('XXa');
    expect(replace('aaaaa', [['aaa', 'Y'], ['aa', 'X']])).toBe('YX');
  });

  it('leaves empty values out and returns the same text without a match', () => {
    expect(replace('abc', [['', 'X']])).toBe('abc');
    const text = 'nothing known here';
    expect(replace(text, [['zzz', 'X']])).toBe(text);
  });

  it('stays linear in a periodic text: the time does not grow with the length of the value', () => {
    const text = 'a'.repeat(400_000);
    const time = (length: number, cover?: string) => {
      const pairs = longestFirst(Array.from({ length: 21 }, (_, index): [string, string] => ['a'.repeat(length - index), `<${index}>`]));
      let best = Infinity;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        replaceKnown(text.slice(0, text.length - 7), pairs, cover);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    for (const cover of [undefined, '#']) {
      const short = time(1_000, cover);
      const long = time(16_000, cover);
      // O(n·L) would make the long values about 16 times slower.
      expect(long).toBeLessThan(Math.max(4 * short, 50));
    }
  });

  it('equals replacing one value after the other when no value is part of another', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 2000; round += 1) {
      const values = new Set<string>();
      while (values.size < 1 + Math.floor(random() * 8)) values.add(`<${Math.floor(random() * 1e6)}>`);
      const pairs = [...values].map((value, index): [string, string] => [value, `#${index}#`]);
      const text = Array.from({ length: 10 }, () => (random() < 0.5 ? pairs[Math.floor(random() * pairs.length)]![0] : 'x y')).join('');
      let sequential = text;
      for (const [from, to] of pairs) sequential = sequential.split(from).join(to);
      expect(replace(text, pairs)).toBe(sequential);
    }
  });
});
