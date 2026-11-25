import { useRef } from 'react';

/**
 * Equal config: the same value, or plain objects and arrays (a few levels deep) with equal entries.
 * Functions, components, regexes, class instances and anything deeper count only when they are the same.
 */
export function sameConfig(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 4 || !isPlain(a) || !isPlain(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameConfig(a[index], b[index], depth + 1)) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !sameConfig(a[key], b[key], depth + 1)) return false;
  }
  return true;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  // A React element counts by identity, the same in development and production.
  if ('$$typeof' in value) return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The value of the previous render while the new one is equal config
 * (`sameConfig`): what is derived from it keeps its identity when an app
 * passes an inline object with the same content on every render.
 */
export function useEqualValue<T>(value: T): T {
  // Compared with a copy of what was taken over, not with it: an entry the app changes in place and passes
  // in a new object is a change (the kept value shares the app's entries).
  const kept = useRef<{ value: T; copy: unknown } | null>(null);
  if (!kept.current || !sameConfig(kept.current.copy, value)) kept.current = { value, copy: copyConfig(value) };
  return kept.current.value;
}

/** A copy of the plain objects and arrays `sameConfig` compares by value; everything else as it is. */
export function copyConfig<T>(value: T, depth = 0): T {
  if (depth > 4 || !isPlain(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => copyConfig(entry, depth + 1)) as T;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = copyConfig((value as Record<string, unknown>)[key], depth + 1);
  return copy as T;
}
