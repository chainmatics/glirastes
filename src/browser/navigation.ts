import { getDefaultUiActionBus, type UiAction, type UiActionBus } from './ui-action-bus.js';

/** Action id of every generated navigation and filter tool (`ui.navigate`, `ui.filter.<view>`). */
export const GLIRASTES_NAVIGATE_ACTION_ID = 'glirastes.navigate';

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>;

/** `.` and `..` path segments, also percent-encoded; URL parsing resolves them. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * An app-internal path: one leading slash, no scheme, no protocol-relative
 * `//host`, no backslash, no control characters and no dot segment in the
 * path (`/a/..//host` resolves to the protocol-relative `//host`).
 */
export function isSafeAppHref(href: unknown): href is string {
  return typeof href === 'string'
    && href.length > 0
    && href.length <= 2_048
    && href.startsWith('/')
    && !href.startsWith('//')
    && !href.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(href)
    && !href.split(/[?#]/, 1)[0]!.split('/').some((segment) => DOT_SEGMENT.test(segment));
}

/**
 * Builds the href a navigation or filter tool pushes. `destination` uses the
 * route spelling of the tool (`/tasks/:id`); query values keep key order,
 * arrays are joined with commas (nuqs `parseAsArrayOf`) or repeated
 * (`searchParams.getAll`).
 */
export function buildNavigationHref(input: {
  destination: string;
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, QueryValue>>;
  arrayFormats?: Readonly<Record<string, 'comma' | 'repeat'>>;
}): string {
  const path = input.destination.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const name = segment.slice(1);
    const value = input.params?.[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing route parameter ${name}`);
    }
    // `.` and `..` would move the path instead of naming one segment.
    if (value === '.' || value === '..') throw new Error(`Invalid route parameter ${name}`);
    return encodeURIComponent(value);
  }).join('/');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (input.arrayFormats?.[key] === 'repeat') {
        for (const item of value) search.append(key, String(item));
      } else {
        search.append(key, value.map(String).join(','));
      }
      continue;
    }
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export interface NavigationBridgeOptions {
  /** The router's push, e.g. Next.js `router.push` or vue-router `router.push`. */
  push: (href: string) => unknown;
  bus?: UiActionBus;
}

function hrefOf(action: UiAction): unknown {
  const payload = action.payload;
  return payload && typeof payload === 'object' ? (payload as { href?: unknown }).href : undefined;
}

/**
 * Executes `ui.navigate` and `ui.filter.<view>` results with the app's own
 * router. Returns the unsubscribe function.
 */
export function registerNavigationBridge(options: NavigationBridgeOptions): () => void {
  const bus = options.bus ?? getDefaultUiActionBus();
  return bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, async (action) => {
    const href = hrefOf(action);
    if (!isSafeAppHref(href)) throw new Error('Unsafe navigation target');
    await options.push(href);
  });
}
