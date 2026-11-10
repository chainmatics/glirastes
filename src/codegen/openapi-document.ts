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

/** The document, or why it is not an OpenAPI 3.1 export the generator reads. */
export function parseOpenapiDocument(text: string): { ok: true; document: OpenapiDocument } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'is not valid JSON' };
  }
  if (!isObject(json) || typeof json.openapi !== 'string') return { ok: false, reason: 'is not an OpenAPI document' };
  if (!/^3\.1\.\d+$/.test(json.openapi)) {
    return { ok: false, reason: `is OpenAPI ${json.openapi}; the generator reads OpenAPI 3.1 exports (FastAPI 0.99 and later write 3.1)` };
  }
  if (!isObject(json.paths)) return { ok: false, reason: 'has no paths object' };
  return { ok: true, document: json as unknown as OpenapiDocument };
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
 * allows `description` next to it) win over the target's keys. A reference
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
