import { compareCodeUnits, sha256Digest } from './canonical.js';

function uniqueSorted(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * Binds descriptive contracts to the code-visible interface. The handler text
 * is only a fallback for handlers without structured evidence and is
 * whitespace-normalized here; callers pass comment-free printer output.
 */
export function computeInterfaceDigest(input: {
  method?: string;
  path?: string;
  pathParams: string[];
  queryParams: string[];
  schemaBindings: string[];
  bodyKeys: string[] | 'opaque';
  handlerText?: string;
}): string {
  return sha256Digest(JSON.stringify({
    version: 1,
    method: input.method ?? null,
    path: input.path ?? null,
    pathParams: uniqueSorted(input.pathParams),
    queryParams: uniqueSorted(input.queryParams),
    schemaBindings: uniqueSorted(input.schemaBindings),
    bodyKeys: input.bodyKeys === 'opaque' ? 'opaque' : uniqueSorted(input.bodyKeys),
    handlerText: input.handlerText === undefined
      ? null
      : input.handlerText.replace(/\s+/g, ' ').trim(),
  }));
}
