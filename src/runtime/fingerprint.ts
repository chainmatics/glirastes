import { createHash } from 'node:crypto';

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (value === undefined) return null;
    return value;
  }
  if (seen.has(value)) throw new TypeError('Cannot fingerprint cyclic data');
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return normalized;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalize((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return normalized;
}

export function createExecutionFingerprint(input: {
  toolId: string;
  arguments: unknown;
  result: unknown;
  progress?: unknown;
}): string {
  const serialized = JSON.stringify(normalize(input, new WeakSet()));
  return `sha256:${createHash('sha256').update(serialized).digest('base64url')}`;
}

/**
 * Fingerprint of a call before it runs: tool name and normalized arguments
 * (key order does not matter). Used to recognize a call that already ran.
 */
export function createCallFingerprint(input: { toolName: string; arguments: unknown }): string {
  const serialized = JSON.stringify(normalize({ toolName: input.toolName, arguments: input.arguments }, new WeakSet()));
  return `sha256:${createHash('sha256').update(serialized).digest('base64url')}`;
}
