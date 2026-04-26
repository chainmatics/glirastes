export function deepWalkReplace(value: unknown, replacer: (s: string) => string): unknown {
  if (typeof value === 'string') {
    return replacer(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepWalkReplace(item, replacer));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepWalkReplace(val, replacer);
    }
    return result;
  }
  return value;
}
