import type { EndpointMethod } from '../types.js';
import { createRouteSourceFingerprint } from './route-fingerprint.js';
import { sortKeysDeep } from './tools/canonical.js';

/** The largest OpenAPI export the generator reads. */
export const OPENAPI_DOCUMENT_LIMIT = 2 * 1024 * 1024;
const MAX_REFERENCE_DEPTH = 32;
/** Operations of a path item, in OpenAPI order. */
export const OPENAPI_OPERATION_KEYS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
/** The operations that become endpoint tools; `options` and `trace` are reported, never dropped. */
export const OPENAPI_TOOL_METHODS: Readonly<Partial<Record<string, EndpointMethod>>> = {
  get: 'GET', head: 'HEAD', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE',
};

type JsonObject = Record<string, unknown>;

export interface OpenapiDocument {
  openapi: string;
  paths: Record<string, unknown>;
  components?: unknown;
  security?: unknown;
}

export interface OpenapiOperationEntry {
  /** The path as written in the document, `{taskId}` placeholders included. */
  documentPath: string;
  /** The path in stable-key form (`:taskId`), or undefined when a segment mixes a placeholder with text. */
  path: string | undefined;
  operationKey: (typeof OPENAPI_OPERATION_KEYS)[number];
  operation: JsonObject;
  pathItem: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The document, or why it is not an OpenAPI 3.0 or 3.1 JSON export the
 * generator reads. A 3.1 document is returned exactly as parsed; a 3.0
 * document (what @nestjs/swagger writes) is normalized to the 3.1 / JSON
 * Schema shape first, so everything downstream sees one dialect.
 */
export function parseOpenapiDocument(text: string): { ok: true; document: OpenapiDocument } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'is not valid JSON' };
  }
  if (!isObject(json) || typeof json.openapi !== 'string') return { ok: false, reason: 'is not an OpenAPI document' };
  const v30 = /^3\.0\.\d+$/.test(json.openapi);
  if (!v30 && !/^3\.1\.\d+$/.test(json.openapi)) {
    return { ok: false, reason: `is OpenAPI ${json.openapi}; the generator reads OpenAPI 3.0 and 3.1 exports` };
  }
  if (!isObject(json.paths)) return { ok: false, reason: 'has no paths object' };
  return { ok: true, document: (v30 ? normalizeOpenapi30(json) : json) as unknown as OpenapiDocument };
}

/** Keywords that only describe a schema; they stay on the outer schema when a nullable one is wrapped. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'title', 'description', 'default', 'example', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs', 'xml',
]);
/** Keywords that can reject `null` even when `type` allows it, so `nullable` must wrap them. */
const NULL_REJECTING_KEYWORDS = ['$ref', 'allOf', 'oneOf', 'anyOf', 'not'] as const;

/**
 * OpenAPI 3.0 Schema Objects → the JSON Schema shape of OpenAPI 3.1, which the
 * runtime compiles with Ajv (draft-07). Only schema positions are walked:
 * `components.schemas`, the `schema` of parameters and headers, `content.*.schema`
 * of request bodies and responses (inline and in `components`), and inside a
 * schema `properties`, `items`, `additionalProperties`, `allOf`/`oneOf`/`anyOf`
 * and `not`. Payloads (`example`, `default`, `enum`, extensions) are copied
 * untouched, and a property named `nullable` is a property, not the keyword.
 *
 * Rules, applied to every schema after its children:
 * - `nullable: true` on a schema with `$ref`, `allOf`, `oneOf`, `anyOf` or
 *   `not` → `{ <annotations>, anyOf: [<the rest>, { type: 'null' }] }`; the
 *   annotations (title, description, default, example, deprecated, readOnly,
 *   writeOnly, externalDocs, xml, `x-*`) stay outside.
 * - otherwise `nullable: true` with a string `type: T` → `type: [T, 'null']`,
 *   and an `enum` without `null` gets `null` appended (OpenAPI 3.0 writers omit
 *   it; a closed enum would reject null). Without `type` the remaining
 *   keywords already accept null.
 * - `nullable` is removed in every case (`false` means nothing).
 * - boolean `exclusiveMinimum`/`exclusiveMaximum`: `true` with a numeric
 *   `minimum`/`maximum` → the number moves into `exclusiveMinimum`/
 *   `exclusiveMaximum` and `minimum`/`maximum` is removed; `false`, or `true`
 *   without a bound, removes the keyword.
 * Everything else (`discriminator`, `example`, `format`) is kept; Ajv ignores
 * what it does not know. The result depends only on the input.
 */
function normalizeOpenapi30(document: JsonObject): JsonObject {
  const schemaMap = (value: unknown): unknown => isObject(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeSchema(child)]))
    : value;
  const mediaMap = (value: unknown): unknown => isObject(value)
    ? Object.fromEntries(Object.entries(value).map(([key, media]) => [key, isObject(media) && 'schema' in media
      ? { ...media, schema: normalizeSchema(media.schema) }
      : media]))
    : value;
  /** A parameter or header: `schema` or `content`. */
  const withSchema = (value: unknown): unknown => {
    if (!isObject(value)) return value;
    const next: JsonObject = { ...value };
    if ('schema' in next) next.schema = normalizeSchema(next.schema);
    if ('content' in next) next.content = mediaMap(next.content);
    return next;
  };
  /** A request body or response: `content`, and for responses `headers`. */
  const withContent = (value: unknown): unknown => {
    if (!isObject(value)) return value;
    const next: JsonObject = { ...value };
    if ('content' in next) next.content = mediaMap(next.content);
    if (isObject(next.headers)) next.headers = Object.fromEntries(Object.entries(next.headers).map(([key, header]) => [key, withSchema(header)]));
    return next;
  };
  const list = (value: unknown, each: (item: unknown) => unknown): unknown => Array.isArray(value) ? value.map(each) : value;
  const map = (value: unknown, each: (item: unknown) => unknown): unknown => isObject(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, each(item)]))
    : value;

  const next: JsonObject = { ...document };
  next.paths = map(document.paths, (pathItem) => {
    if (!isObject(pathItem)) return pathItem;
    const item: JsonObject = { ...pathItem, ...('parameters' in pathItem ? { parameters: list(pathItem.parameters, withSchema) } : {}) };
    for (const key of OPENAPI_OPERATION_KEYS) {
      const operation = pathItem[key];
      if (!isObject(operation)) continue;
      const op: JsonObject = { ...operation };
      if ('parameters' in op) op.parameters = list(op.parameters, withSchema);
      if ('requestBody' in op) op.requestBody = withContent(op.requestBody);
      if ('responses' in op) op.responses = map(op.responses, withContent);
      item[key] = op;
    }
    return item;
  });
  if (isObject(document.components)) {
    const components: JsonObject = { ...document.components };
    if ('schemas' in components) components.schemas = schemaMap(components.schemas);
    if ('parameters' in components) components.parameters = map(components.parameters, withSchema);
    if ('headers' in components) components.headers = map(components.headers, withSchema);
    if ('requestBodies' in components) components.requestBodies = map(components.requestBodies, withContent);
    if ('responses' in components) components.responses = map(components.responses, withContent);
    next.components = components;
  }
  return next;
}

function normalizeSchema(value: unknown): unknown {
  if (!isObject(value)) return value;
  const schema: JsonObject = { ...value };
  if (isObject(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, normalizeSchema(child)]));
  }
  if ('items' in schema) schema.items = Array.isArray(schema.items) ? schema.items.map(normalizeSchema) : normalizeSchema(schema.items);
  if (isObject(schema.additionalProperties)) schema.additionalProperties = normalizeSchema(schema.additionalProperties);
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[key])) schema[key] = (schema[key] as unknown[]).map(normalizeSchema);
  }
  if ('not' in schema) schema.not = normalizeSchema(schema.not);

  for (const [exclusive, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (typeof schema[exclusive] !== 'boolean') continue;
    if (schema[exclusive] === true && typeof schema[bound] === 'number') {
      schema[exclusive] = schema[bound];
      delete schema[bound];
    } else {
      delete schema[exclusive];
    }
  }

  if (!('nullable' in schema)) return schema;
  const nullable = schema.nullable === true;
  delete schema.nullable;
  if (!nullable) return schema;
  if (NULL_REJECTING_KEYWORDS.some((key) => key in schema)) {
    const outer: JsonObject = {};
    const inner: JsonObject = {};
    for (const [key, child] of Object.entries(schema)) {
      if (ANNOTATION_KEYWORDS.has(key) || key.startsWith('x-')) outer[key] = child;
      else inner[key] = child;
    }
    return { ...outer, anyOf: [inner, { type: 'null' }] };
  }
  if (typeof schema.type === 'string') schema.type = [schema.type, 'null'];
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) schema.enum = [...schema.enum, null];
  return schema;
}

/** `/api/tasks/{taskId}` → `/api/tasks/:taskId`; undefined for `/files/{name}.json`. */
export function colonPath(documentPath: string): string | undefined {
  const segments = documentPath.split('/').map((segment) => {
    const whole = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment);
    if (whole) return `:${whole[1]!}`;
    return /[{}]/.test(segment) ? undefined : segment;
  });
  return segments.includes(undefined) ? undefined : segments.join('/');
}

export function operationsOf(document: OpenapiDocument): OpenapiOperationEntry[] {
  const entries: OpenapiOperationEntry[] = [];
  for (const [documentPath, pathItem] of Object.entries(document.paths)) {
    if (!isObject(pathItem)) continue;
    for (const operationKey of OPENAPI_OPERATION_KEYS) {
      const operation = pathItem[operationKey];
      if (!isObject(operation)) continue;
      entries.push({ documentPath, path: colonPath(documentPath), operationKey, operation, pathItem });
    }
  }
  return entries;
}

function pointer(document: OpenapiDocument, reference: string): unknown {
  let value: unknown = document;
  for (const raw of reference.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(value) || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
}

export interface Dereferenced {
  value: unknown;
  /** Why parts of the value were replaced by `{}`: an external, missing, recursive or too deep reference. */
  problems: string[];
}

/**
 * Replace local `$ref`s by their targets. Siblings of a `$ref` (OpenAPI 3.1
 * allows `description` next to it) win over the target's keys; a nullable
 * `$ref` of a 3.0 document was already wrapped in `anyOf` by
 * `parseOpenapiDocument`, so no `nullable` sibling reaches this merge. A reference
 * the generator cannot follow becomes `{}`, which accepts anything, and is
 * named in `problems`.
 */
export function dereference(document: OpenapiDocument, value: unknown): Dereferenced {
  const problems: string[] = [];
  const walk = (node: unknown, stack: ReadonlyArray<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, stack));
    if (!isObject(node)) return node;
    const reference = node.$ref;
    if (typeof reference === 'string') {
      const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
      if (!reference.startsWith('#/')) {
        problems.push(`external reference ${reference}`);
        return walk(siblings, stack);
      }
      if (stack.includes(reference)) {
        problems.push(`recursive reference ${reference}`);
        return walk(siblings, stack);
      }
      if (stack.length >= MAX_REFERENCE_DEPTH) {
        problems.push(`reference ${reference} nested deeper than ${MAX_REFERENCE_DEPTH}`);
        return walk(siblings, stack);
      }
      const target = pointer(document, reference);
      if (target === undefined) {
        problems.push(`missing reference ${reference}`);
        return walk(siblings, stack);
      }
      const resolved = walk(target, [...stack, reference]);
      return { ...(isObject(resolved) ? resolved : {}), ...(walk(siblings, stack) as JsonObject) };
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child, stack)]));
  };
  return { value: walk(value, []), problems: [...new Set(problems)].sort() };
}

/**
 * The fingerprint of one operation: its dereferenced definition, the path
 * item's parameters and the document's global security. Any change to the
 * schemas the server validates changes it.
 */
export function operationFingerprint(
  document: OpenapiDocument,
  entry: OpenapiOperationEntry,
  method: EndpointMethod,
  path: string,
): string {
  const subject = dereference(document, {
    operation: entry.operation,
    parameters: entry.pathItem.parameters ?? [],
    security: document.security ?? null,
  }).value;
  return createRouteSourceFingerprint(JSON.stringify(sortKeysDeep(subject)), method, path);
}
