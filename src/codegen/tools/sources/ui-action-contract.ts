import { createJsonSchemaLike } from '../../../runtime/json-schema.js';
import { compareCodeUnits } from '../canonical.js';
import type { SchemaProbeResult } from '../schema-probe.js';
import type { JsonSchemaLike } from '../types.js';

/**
 * The payload schema of a client action read from its probed zod contract
 * (input side), or why it cannot be used. `reason` never carries a value of
 * the schema, only what failed.
 */
export type ProbedPayload =
  | { ok: true; schema: JsonSchemaLike; description?: string }
  | { ok: false; reason: string };

const MAX_DEPTH = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The probe outcome as an object payload schema. The top level is closed
 * like the schema read from the TypeScript type unless the contract itself
 * declares its extra keys (`.passthrough()`, `.catchall()`). A schema the
 * runtime validator cannot compile is not used, so a tool never breaks.
 */
export function probedPayload(result: SchemaProbeResult | undefined): ProbedPayload {
  if (!result) return { ok: false, reason: 'not probed' };
  if (!result.ok) return { ok: false, reason: result.reason };
  if (result.kind !== 'schema') return { ok: false, reason: 'not-a-schema' };
  const json = result.jsonSchema;
  if (!json) return { ok: false, reason: 'no JSON Schema (zod v4, or zod v3 with zod-to-json-schema installed)' };
  if (json.type !== 'object' || !isRecord(json.properties)) return { ok: false, reason: 'not an object schema' };
  const schema: JsonSchemaLike = 'additionalProperties' in json ? json : { ...json, additionalProperties: false };
  try {
    createJsonSchemaLike(schema);
  } catch {
    return { ok: false, reason: 'the runtime validator cannot compile its JSON Schema' };
  }
  return { ok: true, schema, ...(result.description ? { description: result.description } : {}) };
}

/** JSON types a schema admits (`integer` counts as `number`); undefined when it does not say. */
function typesOf(schema: JsonSchemaLike, depth = 0): Set<string> | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const declared = schema.type;
  if (typeof declared === 'string') return new Set([declared === 'integer' ? 'number' : declared]);
  if (Array.isArray(declared)) {
    return new Set(declared.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => (entry === 'integer' ? 'number' : entry)));
  }
  const members = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (!members) return undefined;
  const types = new Set<string>();
  for (const member of members) {
    const inner = isRecord(member) ? typesOf(member, depth + 1) : undefined;
    if (!inner) return undefined;
    for (const type of inner) types.add(type);
  }
  return types;
}

function enumOf(schema: JsonSchemaLike): string[] | undefined {
  const values = Array.isArray(schema.enum) ? schema.enum : 'const' in schema ? [schema.const] : undefined;
  return values?.map((value) => JSON.stringify(value)).sort(compareCodeUnits);
}

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function at(path: string): string {
  return path || 'the payload';
}

/**
 * Where the probed zod schema contradicts the schema read from the
 * TypeScript type: a different JSON type, enum, property set or required
 * set. What only one side states (formats, bounds, descriptions, a type the
 * TypeScript side leaves open) is no contradiction. Names the path only.
 */
export function payloadContradiction(probed: JsonSchemaLike, typed: JsonSchemaLike, path = '', depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const probedTypes = typesOf(probed);
  const typedTypes = typesOf(typed);
  if (!probedTypes || !typedTypes) return undefined;
  if (!sameSet(probedTypes, typedTypes)) return `${at(path)} has a different type`;
  const probedEnum = enumOf(probed);
  const typedEnum = enumOf(typed);
  if (probedEnum && typedEnum && !sameSet(probedEnum, typedEnum)) return `${at(path)} allows different values`;
  if (isRecord(probed.properties) && isRecord(typed.properties)) {
    const probedKeys = Object.keys(probed.properties);
    const typedKeys = Object.keys(typed.properties);
    const missing = [...probedKeys.filter((key) => !typedKeys.includes(key)), ...typedKeys.filter((key) => !probedKeys.includes(key))]
      .sort(compareCodeUnits);
    if (missing.length > 0) return `${missing.map((key) => (path ? `${path}.${key}` : key)).join(', ')} exists on one side only`;
    const required = [...new Set([...stringsOf(probed.required), ...stringsOf(typed.required)])]
      .filter((key) => stringsOf(probed.required).includes(key) !== stringsOf(typed.required).includes(key))
      .sort(compareCodeUnits);
    if (required.length > 0) return `${required.map((key) => (path ? `${path}.${key}` : key)).join(', ')} is required on one side only`;
    for (const key of [...probedKeys].sort(compareCodeUnits)) {
      const left = probed.properties[key];
      const right = typed.properties[key];
      if (!isRecord(left) || !isRecord(right)) continue;
      const found = payloadContradiction(left, right, path ? `${path}.${key}` : key, depth + 1);
      if (found) return found;
    }
  }
  if (isRecord(probed.items) && isRecord(typed.items)) {
    return payloadContradiction(probed.items, typed.items, `${path}[]`, depth + 1);
  }
  return undefined;
}
