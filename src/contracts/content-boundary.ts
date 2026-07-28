const FORBIDDEN_CONTENT_KEYS = new Set([
  'apikey',
  'argument',
  'arguments',
  'authorization',
  'content',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'message',
  'messages',
  'password',
  'prompt',
  'result',
  'secret',
  'systemprompt',
  'token',
  'toolargument',
  'toolarguments',
  'toolresult',
  'toolresults',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenContentKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return FORBIDDEN_CONTENT_KEYS.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('authorization')
    || normalized.endsWith('cookie')
    || normalized.endsWith('credential')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token');
}

export function findForbiddenContentPath(
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): Array<string | number> | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = findForbiddenContentPath(value[index], [...path, index]);
      if (match) return match;
    }
    return null;
  }

  if (value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isForbiddenContentKey(key)) return nextPath;
    const match = findForbiddenContentPath(child, nextPath);
    if (match) return match;
  }

  return null;
}
