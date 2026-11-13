import { describe, expect, it, vi } from 'vitest';
import { lookupRuntimeConnection } from '../connection-lookup.js';
import { RuntimeControlPlaneRequestError } from '../control-plane-client.js';

const API_KEY = `gl_${'k'.repeat(40)}`;
const APP_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
const ENVIRONMENT_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught as Error;
  }
  throw new Error('expected the lookup to reject');
}

describe('lookupRuntimeConnection', () => {
  it('asks the platform which app, environment and runner the key belongs to', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      schemaVersion: 1,
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'get-it-done-production',
    }));

    const connection = await lookupRuntimeConnection({
      baseUrl: 'https://control.example.test/',
      apiKey: API_KEY,
      fetchImpl,
    });

    expect(connection).toEqual({
      baseUrl: 'https://control.example.test/',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'get-it-done-production',
      mode: 'environment',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://control.example.test/v1/runtime/connection');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ 'x-api-key': API_KEY, accept: 'application/json' });
  });

  it.each([401, 409, 500])('fails with the operation and status only on %s', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ code: 'connection_key_unbound' }, status));

    const error = await rejectionOf(lookupRuntimeConnection({
      baseUrl: 'https://control.example.test',
      apiKey: API_KEY,
      fetchImpl,
    }));

    expect(error).toBeInstanceOf(RuntimeControlPlaneRequestError);
    expect((error as RuntimeControlPlaneRequestError).operation).toBe('connection');
    expect((error as RuntimeControlPlaneRequestError).status).toBe(status);
    expect(error.message).not.toContain(API_KEY);
  });

  it('names the unbound key code on 409', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ code: 'connection_key_unbound' }, 409));

    const error = await rejectionOf(lookupRuntimeConnection({
      baseUrl: 'https://control.example.test',
      apiKey: API_KEY,
      fetchImpl,
    }));

    expect((error as RuntimeControlPlaneRequestError & { code?: string }).code)
      .toBe('connection_key_unbound');
  });

  it('rejects an answer that does not match the contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      schemaVersion: 1,
      appId: 'not-a-uuid',
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner',
    }));

    const error = await rejectionOf(lookupRuntimeConnection({
      baseUrl: 'https://control.example.test',
      apiKey: API_KEY,
      fetchImpl,
    }));

    expect(error.message).toMatch(/connection/);
    expect(error.message).not.toContain('not-a-uuid');
  });

  it('sends the environment, NODE_ENV and digest only when set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      schemaVersion: 1, mode: 'environment', appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'env-staging',
    }));

    await lookupRuntimeConnection({
      baseUrl: 'https://control.example.test',
      apiKey: API_KEY,
      environment: 'staging',
      nodeEnv: 'production',
      fetchImpl,
    });

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/v1/runtime/connection');
    expect(url.searchParams.get('environment')).toBe('staging');
    expect(url.searchParams.get('nodeEnv')).toBe('production');
    expect(url.searchParams.has('digest')).toBe(false);
  });

  it('maps an answer without mode to environment and reads a development answer', async () => {
    const old = vi.fn().mockResolvedValue(json({
      schemaVersion: 1, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'local-x',
    }));
    const dev = vi.fn().mockResolvedValue(json({
      schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: null, runnerKey: 'dev-abcdefghijklm',
    }));
    const common = { baseUrl: 'https://control.example.test', apiKey: API_KEY };

    expect((await lookupRuntimeConnection({ ...common, fetchImpl: old })).mode).toBe('environment');
    expect(await lookupRuntimeConnection({ ...common, fetchImpl: dev })).toMatchObject({
      mode: 'development', environmentId: null,
    });
  });
});
