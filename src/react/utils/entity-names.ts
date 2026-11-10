const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_KEYS = ['title', 'name', 'displayName', 'label'] as const;
const MAX_DEPTH = 6;
const MAX_NODES = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The display names of the records the tools of this conversation returned,
 * by record id. Only finished tool results count, never what the model put
 * into a call, so a name found here is one the app itself reported.
 */
export function collectEntityNames(
  messages: ReadonlyArray<unknown>,
): Map<string, string> {
  const names = new Map<string, string>();
  let budget = MAX_NODES;

  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.id === 'string' && UUID_REGEX.test(value.id)) {
      for (const key of NAME_KEYS) {
        const name = value[key];
        if (typeof name === 'string' && name.trim()) {
          names.set(value.id.toLowerCase(), name);
          break;
        }
      }
    }
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) walk(child, depth + 1);
    }
  };

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (
        isRecord(part)
        && typeof part.type === 'string'
        && part.type.startsWith('tool-')
        && part.state === 'output-available'
      ) {
        walk(part.output, 0);
      }
    }
  }
  return names;
}
