import { createHash } from 'node:crypto';
import { createJsonSchemaLike, type LocalJsonSchema } from '../../runtime/json-schema.js';
import { createLocalSchemaDigest } from '../../runtime/local-tool-bindings.js';

/** Locale-independent ordering so outputs are byte-identical across Node versions. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]));
}

/** Canonical file form for every generator-owned JSON output. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('base64url')}`;
}

/** UUIDv5-shaped identifier scoped to the app; same inputs, same identifier. */
export function deterministicUuid(appId: string, parts: ReadonlyArray<string>): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(appId.replaceAll('-', ''), 'hex'))
    .update(JSON.stringify(['glirastes.tools.v1', ...parts]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const OPAQUE_JSON_SCHEMA: LocalJsonSchema = Object.freeze({});

/** Must equal what the runtime computes for `createJsonSchemaLike(schema)` at boot. */
export function jsonSchemaDigest(schema: LocalJsonSchema): string {
  return createLocalSchemaDigest(createJsonSchemaLike(schema));
}
