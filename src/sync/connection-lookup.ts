import { z } from 'zod';
import { RuntimeControlPlaneRequestError } from './control-plane-client.js';

/** What the Platform answers for a runtime key (`GET /v1/runtime/connection`). */
export interface ResolvedRuntimeConnection {
  baseUrl: string;
  appId: string;
  environmentId: string;
  runnerKey: string;
}

const RuntimeConnectionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  environmentId: z.uuid(),
  runnerKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});

// Only short, machine-readable codes are surfaced; anything else is dropped.
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { code?: unknown } | null;
    return typeof body?.code === 'string' && ERROR_CODE_PATTERN.test(body.code)
      ? body.code
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the Platform which app, environment and runner a runtime key was
 * issued for, so a connected app needs only `GLIRASTES_API_KEY`. Errors name
 * the operation and status only (401 invalid key, 409
 * `connection_key_unbound` for a key not issued by a pairing).
 */
export async function lookupRuntimeConnection(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ResolvedRuntimeConnection> {
  const response = await (options.fetchImpl ?? fetch)(
    `${options.baseUrl.replace(/\/+$/, '')}/v1/runtime/connection`,
    {
      method: 'GET',
      headers: { 'x-api-key': options.apiKey, accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!response.ok) {
    throw new RuntimeControlPlaneRequestError(
      'connection',
      response.status,
      await errorCode(response),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = RuntimeConnectionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Glirastes Control Plane connection response is invalid');
  }
  return {
    baseUrl: options.baseUrl,
    appId: parsed.data.appId,
    environmentId: parsed.data.environmentId,
    runnerKey: parsed.data.runnerKey,
  };
}
