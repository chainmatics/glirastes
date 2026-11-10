/**
 * Schema introspection helpers (Zod v3/v4 and generated JSON Schema).
 *
 * Centralizes all access to Zod's internal `_zod.def` representation so the
 * test-suite generators (`edge-cases.ts`, `schema-consistency.ts`) don't each
 * reach into internals independently. If a future Zod version changes its
 * internal shape, only this file — covered by `zod-introspect.test.ts` — needs
 * updating, and the unit tests will catch a silent regression (introspection
 * returning nothing) instead of letting it ship as a green-but-empty suite.
 */

const ZOD_3_TYPES: Record<string, string> = {
  ZodArray: 'array',
  ZodBoolean: 'boolean',
  ZodCatch: 'catch',
  ZodDefault: 'default',
  ZodDiscriminatedUnion: 'union',
  ZodEffects: 'effects',
  ZodEnum: 'enum',
  ZodLazy: 'lazy',
  ZodNativeEnum: 'enum',
  ZodNullable: 'nullable',
  ZodNumber: 'number',
  ZodObject: 'object',
  ZodOptional: 'optional',
  ZodPipeline: 'pipe',
  ZodReadonly: 'readonly',
  ZodString: 'string',
  ZodTuple: 'tuple',
  ZodUnion: 'union',
};

const JSON_SCHEMA_NODE = Symbol('glirastes.json-schema-node');
const JSON_SCHEMA_REQUIRED = Symbol('glirastes.json-schema-required');

interface JsonSchemaFieldRef {
  [JSON_SCHEMA_NODE]: Record<string, unknown>;
  [JSON_SCHEMA_REQUIRED]: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonSchemaRef(schema: unknown): JsonSchemaFieldRef | undefined {
  if (!isRecord(schema)) return undefined;
  const marked = schema as unknown as Partial<JsonSchemaFieldRef>;
  if (marked[JSON_SCHEMA_NODE]) {
    return marked as JsonSchemaFieldRef;
  }
  if (isRecord(schema.jsonSchema)) {
    return {
      [JSON_SCHEMA_NODE]: schema.jsonSchema,
      [JSON_SCHEMA_REQUIRED]: true,
    };
  }
  if (
    !('_def' in schema)
    && !('_zod' in schema)
    && (
      'type' in schema
      || 'enum' in schema
      || 'properties' in schema
      || 'anyOf' in schema
      || 'oneOf' in schema
    )
  ) {
    return {
      [JSON_SCHEMA_NODE]: schema,
      [JSON_SCHEMA_REQUIRED]: true,
    };
  }
  return undefined;
}

function jsonAllowsNull(node: Record<string, unknown>): boolean {
  if (node.nullable === true) return true;
  if (Array.isArray(node.type) && node.type.includes('null')) return true;
  for (const branchKey of ['anyOf', 'oneOf'] as const) {
    const branches = node[branchKey];
    if (
      Array.isArray(branches)
      && branches.some((branch) => isRecord(branch) && branch.type === 'null')
    ) {
      return true;
    }
  }
  return false;
}

function unwrapJsonRef(ref: JsonSchemaFieldRef): JsonSchemaFieldRef {
  const node = ref[JSON_SCHEMA_NODE];
  for (const branchKey of ['anyOf', 'oneOf'] as const) {
    const branches = node[branchKey];
    if (Array.isArray(branches)) {
      const branch = branches.find(
        (candidate) => isRecord(candidate) && candidate.type !== 'null',
      );
      if (isRecord(branch)) {
        return {
          [JSON_SCHEMA_NODE]: branch,
          [JSON_SCHEMA_REQUIRED]: ref[JSON_SCHEMA_REQUIRED],
        };
      }
    }
  }
  return ref;
}

function jsonSchemaType(ref: JsonSchemaFieldRef): string | undefined {
  const node = unwrapJsonRef(ref)[JSON_SCHEMA_NODE];
  if (Array.isArray(node.enum)) return 'enum';
  if (Array.isArray(node.type)) {
    return node.type.find((value) => value !== 'null') as string | undefined;
  }
  return typeof node.type === 'string' ? node.type : undefined;
}

/** Read and normalize Zod v3/v4 internal schema definitions. */
function getDef(schema: unknown): any {
  const v4 = (schema as any)?._zod?.def;
  if (v4) return v4;
  const v3 = (schema as any)?._def;
  if (!v3) return undefined;
  return {
    ...v3,
    type: ZOD_3_TYPES[v3.typeName] ?? v3.typeName,
    element: v3.type,
    entries: v3.values
      ? Object.fromEntries(v3.values.map((value: string) => [value, value]))
      : v3.values,
    in: v3.in ?? v3.schema,
  };
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
  const json = jsonSchemaRef(schema);
  if (json) return jsonSchemaType(json);
  return getDef(schema)?.type;
}

/**
 * True if the field is optional, nullable, or has a default — i.e. an input
 * is not strictly required to provide a concrete value. Matches the historical
 * behaviour of the edge-case generator, which skips the "rejects missing"
 * boundary test for any of these.
 */
export function isOptional(schema: unknown): boolean {
  const json = jsonSchemaRef(schema);
  if (json) {
    const node = json[JSON_SCHEMA_NODE];
    return (
      !json[JSON_SCHEMA_REQUIRED]
      || 'default' in node
      || jsonAllowsNull(node)
    );
  }
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
  const json = jsonSchemaRef(schema);
  if (json) return unwrapJsonRef(json) as T;
  const def = getDef(schema);
  const type = def?.type;
  if (WRAPPER_TYPES.has(type)) return unwrap(def.innerType);
  if (type === 'pipe') return unwrap(def.in);
  if (type === 'effects') return unwrap(def.schema);
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
  const json = jsonSchemaRef(schema);
  if (json) {
    const node = unwrapJsonRef(json)[JSON_SCHEMA_NODE];
    if (jsonSchemaType(json) !== 'object' || !isRecord(node.properties)) {
      return null;
    }
    const required = new Set(
      Array.isArray(node.required)
        ? node.required.filter(
          (field): field is string => typeof field === 'string',
        )
        : [],
    );
    return Object.fromEntries(
      Object.entries(node.properties)
        .filter((entry): entry is [string, Record<string, unknown>] =>
          isRecord(entry[1]))
        .map(([field, child]) => [
          field,
          {
            [JSON_SCHEMA_NODE]: child,
            [JSON_SCHEMA_REQUIRED]: required.has(field),
          } satisfies JsonSchemaFieldRef,
        ]),
    );
  }
  const def = getDef(schema);
  if (!def) return null;
  if (def.type === 'object') {
    return (
      typeof def.shape === 'function' ? def.shape() : def.shape
    ) as Record<string, unknown>;
  }
  if (WRAPPER_TYPES.has(def.type) && def.innerType) {
    return getObjectShape(def.innerType);
  }
  if (def.type === 'pipe' && def.in) {
    return getObjectShape(def.in);
  }
  if (def.type === 'effects' && def.schema) {
    return getObjectShape(def.schema);
  }
  return null;
}

/** The string members of an enum schema (after unwrapping). */
export function getEnumValues(schema: unknown): string[] {
  const json = jsonSchemaRef(schema);
  if (json) {
    const values = unwrapJsonRef(json)[JSON_SCHEMA_NODE].enum;
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : [];
  }
  const def = getDef(unwrap(schema));
  if (def?.type !== 'enum') return [];
  return Object.values(def.entries as Record<string, string | number>).filter(
    (v): v is string => typeof v === 'string',
  );
}

/** The element schema of an array (after unwrapping), or null. */
export function getArrayElement(schema: unknown): unknown | null {
  const json = jsonSchemaRef(schema);
  if (json) {
    const node = unwrapJsonRef(json)[JSON_SCHEMA_NODE];
    return isRecord(node.items)
      ? {
        [JSON_SCHEMA_NODE]: node.items,
        [JSON_SCHEMA_REQUIRED]: true,
      } satisfies JsonSchemaFieldRef
      : null;
  }
  const def = getDef(unwrap(schema));
  return def?.type === 'array' ? def.element : null;
}

/** The `.max(n)` length constraint on an array schema, or null. */
export function getArrayMax(schema: unknown): number | null {
  const json = jsonSchemaRef(schema);
  if (json) {
    const maximum = unwrapJsonRef(json)[JSON_SCHEMA_NODE].maxItems;
    return typeof maximum === 'number' ? maximum : null;
  }
  const def = getDef(unwrap(schema));
  if (def?.type !== 'array') return null;
  if (def.maxLength?.value !== undefined) {
    return def.maxLength.value as number;
  }
  for (const check of def.checks ?? []) {
    const cd = check?._zod?.def;
    if (cd?.check === 'max_length') return cd.maximum as number;
  }
  return null;
}

/** True if a string schema carries the given format check (e.g. 'uuid'). */
export function hasStringFormat(schema: unknown, format: string): boolean {
  const json = jsonSchemaRef(schema);
  if (json) {
    const node = unwrapJsonRef(json)[JSON_SCHEMA_NODE];
    return jsonSchemaType(json) === 'string' && node.format === format;
  }
  const def = getDef(unwrap(schema));
  if (def?.type !== 'string') return false;
  return (def.checks ?? []).some((check: any) => {
    const cd = check?._zod?.def;
    return (
      (cd?.check === 'string_format' && cd?.format === format)
      || check?.kind === format
    );
  });
}

/** True if a string schema is a UUID. */
export function isUuidString(schema: unknown): boolean {
  return hasStringFormat(schema, 'uuid');
}
