import { trimTrailingSlashes } from '../contracts/url.js';
import { z } from 'zod';
import { RuntimeControlPlaneRequestError, errorCode } from './control-plane-client.js';

/** What the Platform answers for a runtime key (`GET /v1/runtime/connection`). */
export interface ResolvedRuntimeConnection {
  baseUrl: string;
  appId: string;
  /** Null for a development connection. */
  environmentId: string | null;
  runnerKey: string;
  mode: 'environment' | 'development';
}

const RuntimeConnectionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  environmentId: z.uuid().nullable(),
  mode: z.enum(['environment', 'development']).optional(),
  runnerKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});

/**
 * Asks the Platform which app, environment and runner a runtime key was
 * issued for, so a connected app needs only `GLIRASTES_API_KEY`. Errors name
 * the operation and status only (401 invalid key, 409
 * `connection_key_unbound` for a key not issued by a pairing).
 */
export async function lookupRuntimeConnection(options: {
  baseUrl: string;
  apiKey: string;
  environment?: string;
  nodeEnv?: string;
  digest?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ResolvedRuntimeConnection> {
  const query = new URLSearchParams();
  if (options.environment) query.set('environment', options.environment);
  if (options.nodeEnv) query.set('nodeEnv', options.nodeEnv);
  if (options.digest) query.set('digest', options.digest);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const response = await (options.fetchImpl ?? fetch)(
    `${trimTrailingSlashes(options.baseUrl)}/v1/runtime/connection${suffix}`,
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
    mode: parsed.data.mode ?? 'environment',
  };
}
