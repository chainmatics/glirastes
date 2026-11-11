import type {
  ToolContext,
  RuntimeContext,
} from '../../../types.js';
import {
  createNextInternalApiCaller,
  type InternalApiCaller,
  type NextInternalApiCallerOptions,
} from '../../core/index.js';

export interface OriginOptions {
  /**
   * Take the origin from `x-forwarded-host` / `x-forwarded-proto` (their
   * last value, the one the proxy nearest to the app set). Only for an app
   * that is reachable solely through a proxy that sets or appends these
   * headers: anyone who can reach the app directly can name any host in
   * them, and endpoint tools send the user's cookie to that host. Default
   * `false`: the origin of the request URL.
   */
  trustForwardedHeaders?: boolean;
}

/**
 * The origin the app calls itself on, for the default endpoint caller and
 * `runtime.origin`.
 *
 * By default this is the origin of the request URL. Next.js builds it from
 * the address the server listens on (or from the Host header only with
 * `experimental.trustHostHeader`, which Vercel sets), never from a header
 * the client chose. `Host` and `x-forwarded-host` are not read: a client that
 * reaches the app without a proxy that overwrites them would make the app
 * send the user's cookie to a host of its choice. With
 * `trustForwardedHeaders` the last forwarded value is used; a value that is
 * not a plain host falls back to the request URL.
 */
export function extractOrigin(req: Request, options: OriginOptions = {}): string {
  const own = requestUrlOrigin(req);
  if (options.trustForwardedHeaders) {
    const host = lastForwardedValue(req.headers.get('x-forwarded-host'));
    const proto = lastForwardedValue(req.headers.get('x-forwarded-proto')) ?? new URL(own).protocol.replace(':', '');
    if (host && (proto === 'http' || proto === 'https')) {
      try {
        const url = new URL(`${proto}://${host}`);
        if (url.host === host.toLowerCase() && url.pathname === '/' && !url.username && !url.password) return url.origin;
      } catch {
        // Not a host: use the request URL.
      }
    }
  }
  return own;
}

function requestUrlOrigin(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

function lastForwardedValue(value: string | null): string | undefined {
  const last = value?.split(',').at(-1)?.trim();
  return last ? last : undefined;
}

/**
 * The origins a browser on the app's public address may send as `Origin`,
 * for the cross-origin check only, never for the endpoint caller: the
 * request URL's origin, the Host header with `https` and with `http`, and
 * the first forwarded host and protocol (what the outermost proxy saw).
 *
 * Both schemes for Host, because behind a TLS-terminating proxy the request
 * URL says `http` while the browser's Origin says `https`. This does not
 * widen what a cross-origin page can do: the browser sets `Host` itself to
 * the host it sends the request to, a page cannot choose it (it is a
 * forbidden header), and `x-forwarded-*` would need a CORS preflight, which
 * the JSON content type needs anyway. A request whose Origin matches the
 * Host was therefore sent by a page of that very host; a client that sets
 * these headers itself is not a browser and carries no victim's cookie. The
 * one thing added is the plain-http page of the same host, which only a
 * network attacker could serve, and only where the host is reachable over
 * http without HSTS. The check consults these origins only for a browser
 * that sends no `Sec-Fetch-Site`.
 */
export function publicOrigins(req: Request): string[] {
  const own = requestUrlOrigin(req);
  const origins = [own];
  const host = req.headers.get('host');
  if (host) origins.push(`https://${host}`, `http://${host}`);
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) {
    const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    origins.push(`${forwardedProto}://${forwardedHost}`);
  }
  return origins;
}

/**
 * Build a RuntimeContext from a Next.js request.
 */
export function buildRuntimeContext(req: Request, options: OriginOptions = {}): RuntimeContext {
  return {
    origin: extractOrigin(req, options),
    cookieHeader: req.headers.get('cookie') ?? undefined,
  };
}

/**
 * Build a complete ToolContext from a Next.js request.
 */
export function buildToolContext(
  req: Request,
  options?: { locale?: string } & OriginOptions,
): ToolContext {
  return {
    currentDate: new Date(),
    locale: options?.locale ?? 'en-US',
    runtime: buildRuntimeContext(req, { trustForwardedHeaders: options?.trustForwardedHeaders }),
  };
}

/**
 * Create an InternalApiCaller from a Next.js request: calls go to
 * `overrides.origin` when given, else to `extractOrigin(req, overrides)`, and
 * carry the request's cookie.
 */
export function createInternalApiCallerFromRequest(
  req: Request,
  overrides?: Partial<NextInternalApiCallerOptions> & OriginOptions,
): InternalApiCaller {
  const { trustForwardedHeaders, ...callerOverrides } = overrides ?? {};
  return createNextInternalApiCaller({
    origin: extractOrigin(req, { trustForwardedHeaders }),
    cookieHeader: req.headers.get('cookie') ?? undefined,
    ...callerOverrides,
  });
}
