/**
 * Zod schema introspection helpers (Zod v4).
 *
 * Centralizes all access to Zod's internal `_zod.def` representation so the
 * test-suite generators (`edge-cases.ts`, `schema-consistency.ts`) don't each
 * reach into internals independently. If a future Zod version changes its
 * internal shape, only this file — covered by `zod-introspect.test.ts` — needs
 * updating, and the unit tests will catch a silent regression (introspection
 * returning nothing) instead of letting it ship as a green-but-empty suite.
 */

/** Read Zod v4's internal schema definition (`schema._zod.def`). */
function getDef(schema: unknown): any {
  return (schema as any)?._zod?.def;
}

/** Wrapper types that hold their inner schema in `def.innerType`. */
const WRAPPER_TYPES = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
]);

/** The normalized Zod v4 type tag (e.g. 'object', 'string', 'array', 'enum'). */
export function getSchemaType(schema: unknown): string | undefined {
  return getDef(schema)?.type;
}

/**
 * True if the field is optional, nullable, or has a default — i.e. an input
 * is not strictly required to provide a concrete value. Matches the historical
 * behaviour of the edge-case generator, which skips the "rejects missing"
 * boundary test for any of these.
 */
export function isOptional(schema: unknown): boolean {
  const type = getSchemaType(schema);
  return (
    type === 'optional' ||
    type === 'default' ||
    type === 'prefault' ||
    type === 'nullable'
  );
}

/** Strip optional/nullable/default/pipe wrappers to the base schema. */
export function unwrap<T = unknown>(schema: T): T {
  const def = getDef(schema);
  const type = def?.type;
  if (WRAPPER_TYPES.has(type)) return unwrap(def.innerType);
  if (type === 'pipe') return unwrap(def.in);
  return schema;
}

/** The base Zod type tag after unwrapping (e.g. an optional string → 'string'). */
export function getBaseType(schema: unknown): string | undefined {
  return getSchemaType(unwrap(schema));
}

/**
 * The field map of an object schema, unwrapping optional/default/pipe wrappers.
 * Returns null for non-object schemas.
 */
export function getObjectShape(
  schema: unknown,
): Record<string, unknown> | null {
  const def = getDef(schema);
  if (!def) return null;
  if (def.type === 'object') {
    return def.shape as Record<string, unknown>;
  }
  if (WRAPPER_TYPES.has(def.type) && def.innerType) {
    return getObjectShape(def.innerType);
  }
  if (def.type === 'pipe' && def.in) {
    return getObjectShape(def.in);
  }
  return null;
}

/** The string members of an enum schema (after unwrapping). */
export function getEnumValues(schema: unknown): string[] {
  const def = getDef(unwrap(schema));
  if (def?.type !== 'enum') return [];
  return Object.values(def.entries as Record<string, string | number>).filter(
    (v): v is string => typeof v === 'string',
  );
}

/** The element schema of an array (after unwrapping), or null. */
export function getArrayElement(schema: unknown): unknown | null {
  const def = getDef(unwrap(schema));
  return def?.type === 'array' ? def.element : null;
}

/** The `.max(n)` length constraint on an array schema, or null. */
export function getArrayMax(schema: unknown): number | null {
  const def = getDef(unwrap(schema));
  if (def?.type !== 'array') return null;
  for (const check of def.checks ?? []) {
    const cd = check?._zod?.def;
    if (cd?.check === 'max_length') return cd.maximum as number;
  }
  return null;
}

/** True if a string schema carries the given format check (e.g. 'uuid'). */
export function hasStringFormat(schema: unknown, format: string): boolean {
  const def = getDef(unwrap(schema));
  if (def?.type !== 'string') return false;
  return (def.checks ?? []).some((check: any) => {
    const cd = check?._zod?.def;
    return cd?.check === 'string_format' && cd?.format === format;
  });
}

/** True if a string schema is a UUID. */
export function isUuidString(schema: unknown): boolean {
  return hasStringFormat(schema, 'uuid');
}
