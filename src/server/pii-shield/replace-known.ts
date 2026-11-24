/** Pairs of a known value and what it becomes, longest value first (see {@link longestFirst}). */
export type Replacements = ReadonlyArray<readonly [from: string, to: string]>;

/**
 * What stands for the rest of a known original that partly overlaps a longer
 * one (see {@link replaceKnown} with `cover`). It is no pseudonym (the
 * generated ones of unknown categories read `[REDACTED_1234]`), so the way
 * back leaves it as it is: the rest is not restored, never restored wrong.
 */
export const OVERLAP_PLACEHOLDER = '[REDACTED]';

/**
 * `pairs` ordered for {@link replaceKnown}: the longest `from` first, pairs
 * of equal length in their given order (the sort is stable). Empty values
 * are left out: they occur everywhere and mean nothing.
 */
export function longestFirst(pairs: Iterable<readonly [string, string]>): Replacements {
  return [...pairs].filter(([from]) => from.length > 0).sort((a, b) => b[0].length - a[0].length);
}

/** The smallest period of `value` (its length when it has none shorter), from the prefix function. */
function smallestPeriod(value: string): number {
  const border = new Int32Array(value.length);
  for (let index = 1, length = 0; index < value.length; index += 1) {
    while (length > 0 && value[index] !== value[length]) length = border[length - 1]!;
    if (value[index] === value[length]) length += 1;
    border[index] = length;
  }
  return value.length - (value.length > 0 ? border[value.length - 1]! : 0);
}

interface Claim {
  start: number;
  end: number;
  to: string;
  placeholder: boolean;
}

/**
 * The taken positions of a text: `taken[i]` for a constant-time check, and
 * `next` (union-find with path halving) for the first free position at or
 * after `i` (the length of the text when none is left).
 */
class Positions {
  readonly taken: Uint8Array;
  private readonly next: Int32Array;

  constructor(length: number) {
    this.taken = new Uint8Array(length);
    this.next = new Int32Array(length + 1);
    for (let index = 0; index <= length; index += 1) this.next[index] = index;
  }

  firstFree(from: number): number {
    let index = from;
    while (this.next[index] !== index) {
      const parent = this.next[index]!;
      this.next[index] = this.next[parent]!;
      index = parent;
    }
    return index;
  }

  take(start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
      this.taken[index] = 1;
      this.next[index] = index + 1;
    }
  }
}

/**
 * `text` with every known value replaced, in one pass over the original
 * text. Values go longest first (`replacements` from {@link longestFirst}).
 * Each value takes its occurrences left to right that overlap nothing taken
 * yet, as a split does, and becomes its `to` there; so a value that is part
 * of a longer one never breaks the longer one, and what a value became is
 * never searched again.
 *
 * Every taken stretch is at least as long as the value at hand (it comes from
 * longer or equal values), so an occurrence that overlaps one holds its first
 * or its last position: checked in constant time.
 *
 * With `cover` (the direction to the model), no position of any occurrence of
 * a known value stays as it is: an occurrence that only partly overlaps what
 * is taken (another value's occurrence, or another occurrence of the same
 * value) has its free rest replaced by `cover`, after the value's own
 * occurrences are placed; neighbouring `cover` stretches become one. Without
 * `cover` (the way back), such an occurrence stays as it is.
 *
 * Cost per value: the searches a split makes. With `cover`, occurrences that
 * overlap each other are all visited: in a periodic stretch each next one is
 * found by comparing one period, so the work stays linear in the text.
 * Without `cover`, a search goes on behind the taken stretch it ran into.
 */
export function replaceKnown(text: string, replacements: Replacements, cover?: string): string {
  const size = text.length;
  // Values longer than the text cannot occur: start at the first that fits.
  let low = 0;
  let high = replacements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (replacements[middle]![0].length > size) low = middle + 1;
    else high = middle;
  }
  let positions: Positions | undefined;
  const claims: Claim[] = [];
  for (let index = low; index < replacements.length; index += 1) {
    const [from, to] = replacements[index]!;
    let at = text.indexOf(from);
    if (at === -1) continue;
    positions ??= new Positions(size);
    if (positions.firstFree(0) === size) break;
    const { taken } = positions;
    const length = from.length;
    if (cover === undefined) {
      while (at !== -1) {
        const end = at + length;
        if (taken[at] === 0 && taken[end - 1] === 0) {
          claims.push({ start: at, end, to, placeholder: false });
          positions.take(at, end);
          at = text.indexOf(from, end);
        } else {
          at = text.indexOf(from, positions.firstFree(taken[at] === 1 ? at : end - 1));
        }
      }
      continue;
    }
    const period = smallestPeriod(from);
    const tail = from.slice(length - period);
    const afterMiss = Math.min(length, Math.max(period + 1, length - period + 1));
    const partial: number[] = [];
    while (at !== -1) {
      const end = at + length;
      if (taken[at] === 0 && taken[end - 1] === 0) {
        claims.push({ start: at, end, to, placeholder: false });
        positions.take(at, end);
      } else {
        partial.push(at);
      }
      // The next occurrence, overlapping ones included: one period on when
      // the text goes on periodically, else no overlapping one before
      // `afterMiss` (a shorter shift would be a period of `from` and imply
      // the occurrence one period on).
      at = period < length && text.startsWith(tail, end) ? at + period : text.indexOf(from, at + afterMiss);
    }
    for (const start of partial) {
      const end = start + length;
      let free = positions.firstFree(start);
      while (free < end) {
        let stop = free;
        while (stop < end && taken[stop] === 0) stop += 1;
        claims.push({ start: free, end: stop, to: cover, placeholder: true });
        positions.take(free, stop);
        free = positions.firstFree(stop);
      }
    }
  }
  if (claims.length === 0) return text;
  claims.sort((a, b) => a.start - b.start);
  let result = '';
  let position = 0;
  let previous: Claim | undefined;
  for (const claim of claims) {
    const joined = previous?.placeholder === true && claim.placeholder && previous.end === claim.start;
    result += text.slice(position, claim.start) + (joined ? '' : claim.to);
    position = claim.end;
    previous = claim;
  }
  return result + text.slice(position);
}
