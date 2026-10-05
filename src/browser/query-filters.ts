import { buildNavigationHref, type QueryValue } from './navigation.js';

export type QueryFilterScalar = 'string' | 'integer' | 'number' | 'boolean' | readonly [string, ...string[]];
export type QueryFilterSpec =
  | QueryFilterScalar
  | { readonly arrayOf: QueryFilterScalar; readonly format?: 'comma' | 'repeat' };

type ScalarValue<S> = S extends 'integer' | 'number' ? number
  : S extends 'boolean' ? boolean
    : S extends readonly (infer L)[] ? L
      : string;
type FilterValue<S> = S extends { readonly arrayOf: infer V } ? Array<ScalarValue<V>> : ScalarValue<S>;

export type QueryFilterValues<F extends Record<string, QueryFilterSpec>> = {
  [K in keyof F]?: FilterValue<F[K]>;
};

export interface QueryFiltersDefinition<F extends Record<string, QueryFilterSpec>> {
  readonly path: string;
  readonly filters: F;
  /** Typed filter values from a query string; values outside the domain are dropped. */
  read(search: string | URLSearchParams): QueryFilterValues<F>;
  /** The href `ui.filter.<view>` pushes for these values. */
  href(values: QueryFilterValues<F>, params?: Readonly<Record<string, string>>): string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const KINDS = new Set(['string', 'integer', 'number', 'boolean']);

function scalarOf(spec: QueryFilterSpec): QueryFilterScalar {
  return typeof spec === 'object' && !Array.isArray(spec) && 'arrayOf' in spec ? spec.arrayOf : spec as QueryFilterScalar;
}

function assertScalar(key: string, scalar: unknown): void {
  if (Array.isArray(scalar)) {
    if (scalar.length === 0 || scalar.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new Error(`Filter ${key} needs at least one non-empty value`);
    }
    return;
  }
  if (typeof scalar !== 'string' || !KINDS.has(scalar)) {
    throw new Error(`Filter ${key} must be string, integer, number, boolean or a list of values`);
  }
}

function parseScalar(scalar: QueryFilterScalar, raw: string): unknown {
  if (Array.isArray(scalar)) return scalar.includes(raw) ? raw : undefined;
  switch (scalar) {
    case 'integer':
      return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
    case 'number': {
      const value = Number(raw);
      return raw.trim() !== '' && Number.isFinite(value) ? value : undefined;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    default:
      return raw;
  }
}

/**
 * Declares the URL filters of a view for apps without a framework source
 * (SPAs, Vue). `glirastes tools refresh` reads the literal definition and
 * generates `ui.filter.<view>`; the app uses `read` to apply the URL.
 */
export function defineQueryFilters<const F extends Record<string, QueryFilterSpec>>(definition: {
  path: string;
  filters: F;
}): QueryFiltersDefinition<F> {
  if (typeof definition.path !== 'string' || !definition.path.startsWith('/') || definition.path.startsWith('//')) {
    throw new Error('defineQueryFilters needs an app path starting with /');
  }
  for (const [key, spec] of Object.entries(definition.filters)) {
    if (!NAME.test(key)) throw new Error(`Filter key ${JSON.stringify(key)} is not a plain name`);
    assertScalar(key, scalarOf(spec));
  }
  const arrayFormats: Record<string, 'comma' | 'repeat'> = {};
  for (const [key, spec] of Object.entries(definition.filters)) {
    if (typeof spec === 'object' && !Array.isArray(spec) && 'arrayOf' in spec) arrayFormats[key] = spec.format ?? 'comma';
  }
  return {
    path: definition.path,
    filters: definition.filters,
    read(search) {
      const params = typeof search === 'string' ? new URLSearchParams(search) : search;
      const values: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(definition.filters)) {
        const scalar = scalarOf(spec);
        if (arrayFormats[key]) {
          const raw = arrayFormats[key] === 'repeat' ? params.getAll(key) : (params.get(key)?.split(',') ?? []);
          const parsed = raw.map((value) => parseScalar(scalar, value)).filter((value) => value !== undefined);
          if (parsed.length > 0) values[key] = parsed;
          continue;
        }
        const raw = params.get(key);
        const parsed = raw === null ? undefined : parseScalar(scalar, raw);
        if (parsed !== undefined) values[key] = parsed;
      }
      return values as QueryFilterValues<F>;
    },
    href(values, params) {
      return buildNavigationHref({
        destination: definition.path,
        ...(params ? { params } : {}),
        query: values as Record<string, QueryValue>,
        arrayFormats,
      });
    },
  };
}
