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
  const kept = useRef(value);
  if (!sameConfig(kept.current, value)) kept.current = value;
  return kept.current;
}
