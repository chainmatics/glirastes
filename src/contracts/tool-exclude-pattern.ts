export interface ExcludePattern {
  /** Absent for `*` and for a pattern without a method: any method. */
  method: string | undefined;
  /** Path segments; `*` is one segment, `**` any number of segments. */
  segments: string[];
}

const EXCLUDE_PATTERN = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|\*)\s+)?(\/\S*)$/;

function isValidSegment(segment: string): boolean {
  if (segment === '*' || segment === '**') return true;
  // Route paths carry `:id` and `*slug`, never the Next.js file-system spelling.
  if (/^\[.*\]$/.test(segment) || /^\(.*\)$/.test(segment)) return false;
  // `*slug` is a catch-all stable-key segment and matches literally; any other `*` is a partial glob.
  return !segment.includes('*') || /^\*[^*]+$/.test(segment);
}

/**
 * The grammar of `.glirastes/tool-policy.json` `exclude[].match`:
 * `[METHOD|*] /path/glob`, upper-case methods only. Undefined for anything
 * else, because such a pattern would exclude nothing and say so to nobody.
 */
export function parseExcludePattern(pattern: string): ExcludePattern | undefined {
  const match = EXCLUDE_PATTERN.exec(pattern.trim());
  if (!match) return undefined;
  const [, method, path] = match;
  const segments = path!.split('/').filter(Boolean);
  if (!segments.every(isValidSegment)) return undefined;
  return { method: method === '*' ? undefined : method, segments };
}
