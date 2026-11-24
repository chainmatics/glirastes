/** Pairs of a known value and what it becomes, longest value first (see {@link longestFirst}). */
export type Replacements = ReadonlyArray<readonly [from: string, to: string]>;

/**
 * `pairs` ordered for {@link replaceKnown}: the longest `from` first, pairs
 * of equal length in their given order (the sort is stable). Empty values
 * are left out: they occur everywhere and mean nothing.
 */
export function longestFirst(pairs: Iterable<readonly [string, string]>): Replacements {
  return [...pairs].filter(([from]) => from.length > 0).sort((a, b) => b[0].length - a[0].length);
}

interface Claim {
  start: number;
  end: number;
  to: string;
}

/**
 * `text` with every known value replaced, in one pass over the original
 * text. Values go longest first (`replacements` from {@link longestFirst}):
 * each takes its occurrences left to right that overlap no occurrence a
 * longer value took, so a value that is part of a longer one never breaks
 * the longer one. What a value becomes is never searched again, so no later
 * value changes it. Without a value that is part of another (and without
 * overlapping occurrences) this gives what replacing one value after the
 * other gives. Each value costs one search of the text, as a split does;
 * taken positions are marked once and checked in constant time.
 */
export function replaceKnown(text: string, replacements: Replacements): string {
  let taken: Uint8Array | undefined;
  const claims: Claim[] = [];
  for (const [from, to] of replacements) {
    let at = text.indexOf(from);
    while (at !== -1) {
      const end = at + from.length;
      // Every taken stretch is at least as long as `from` (longest first), so
      // one that overlaps `[at, end)` holds its first or its last position.
      if (taken !== undefined && (taken[at] === 1 || taken[end - 1] === 1)) {
        at = text.indexOf(from, at + 1);
        continue;
      }
      taken ??= new Uint8Array(text.length);
      taken.fill(1, at, end);
      claims.push({ start: at, end, to });
      at = text.indexOf(from, end);
    }
  }
  if (claims.length === 0) return text;
  claims.sort((a, b) => a.start - b.start);
  let result = '';
  let position = 0;
  for (const claim of claims) {
    result += text.slice(position, claim.start) + claim.to;
    position = claim.end;
  }
  return result + text.slice(position);
}
