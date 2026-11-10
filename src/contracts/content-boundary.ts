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

const SENSITIVE_STRING_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/,
];

export function findSensitiveStringPath(
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): Array<string | number> | null {
  if (typeof value === 'string') {
    return SENSITIVE_STRING_PATTERNS.some((pattern) => pattern.test(value))
      ? [...path]
      : null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = findSensitiveStringPath(value[index], [...path, index]);
      if (match) return match;
    }
    return null;
  }

  if (value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value)) {
    const match = findSensitiveStringPath(child, [...path, key]);
    if (match) return match;
  }

  return null;
}

export function findForbiddenPlatformContentPath(
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): Array<string | number> | null {
  return findForbiddenContentPath(value, path)
    ?? findSensitiveStringPath(value, path);
}
