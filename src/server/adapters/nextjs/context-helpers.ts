import type {
  ToolContext,
  RuntimeContext,
} from '../../../types.js';
import {
  createNextInternalApiCaller,
  type InternalApiCaller,
  type NextInternalApiCallerOptions,
} from '../../core/index.js';

/**
 * Extract origin from a Next.js request.
 * Checks x-forwarded-host/host headers, falls back to req.url.
 */
export function extractOrigin(req: Request): string {
  // A chain of proxies may list several values; the first one is what the
  // outermost proxy saw from the client.
  const forwardedHost = firstForwardedValue(req.headers.get('x-forwarded-host'));
  const forwardedProto = firstForwardedValue(req.headers.get('x-forwarded-proto')) ?? 'https';

  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const host = req.headers.get('host');
  if (host) {
    const proto = host.startsWith('localhost') ? 'http' : 'https';
    return `${proto}://${host}`;
  }

  try {
    const url = new URL(req.url);
    return url.origin;
  } catch {
    return 'http://localhost:3000';
  }
}

function firstForwardedValue(value: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first ? first : undefined;
}

/**
 * Build a RuntimeContext from a Next.js request.
 */
export function buildRuntimeContext(req: Request): RuntimeContext {
  return {
    origin: extractOrigin(req),
    cookieHeader: req.headers.get('cookie') ?? undefined,
  };
}

/**
 * Build a complete ToolContext from a Next.js request.
 */
export function buildToolContext(
  req: Request,
  options?: { locale?: string },
): ToolContext {
  return {
    currentDate: new Date(),
    locale: options?.locale ?? 'en-US',
    runtime: buildRuntimeContext(req),
  };
}

/**
 * Create an InternalApiCaller from a Next.js request.
 * Automatically extracts origin and cookies.
 */
export function createInternalApiCallerFromRequest(
  req: Request,
  overrides?: Partial<NextInternalApiCallerOptions>,
): InternalApiCaller {
  return createNextInternalApiCaller({
    origin: extractOrigin(req),
    cookieHeader: req.headers.get('cookie') ?? undefined,
    ...overrides,
  });
}
