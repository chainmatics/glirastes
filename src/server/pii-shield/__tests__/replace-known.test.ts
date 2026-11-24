import { describe, expect, it } from 'vitest';
import { longestFirst, replaceKnown } from '../replace-known.js';

const replace = (text: string, pairs: Array<[string, string]>) => replaceKnown(text, longestFirst(pairs));

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

  it('a partial overlap: the longer value wins, the rest of the shorter one stays', () => {
    expect(replace('37/1571/24067Z.huber@kanzlei-x.de', [['37/1571/24067', 'T'], ['24067Z.huber@kanzlei-x.de', 'E']])).toBe('37/1571/E');
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
