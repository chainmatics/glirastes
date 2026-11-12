import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTROL_PLANE_URL,
  resolveRuntimeConnectionConfig,
  resolveRuntimeMode,
} from '../runtime-mode.js';

const KEY = `gl_${'a'.repeat(32)}`;

describe('resolveRuntimeMode', () => {
  it('resolves standalone without an API key', () => {
    expect(resolveRuntimeMode({})).toBe('standalone');
    expect(resolveRuntimeMode({ GLIRASTES_API_KEY: '' })).toBe('standalone');
    expect(resolveRuntimeMode({ GLIRASTES_API_KEY: '   ' })).toBe('standalone');
  });

  it('stays standalone with only a control plane URL', () => {
    expect(resolveRuntimeMode({
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
    })).toBe('standalone');
  });

  it('resolves managed with the API key alone', () => {
    expect(resolveRuntimeMode({ GLIRASTES_API_KEY: KEY })).toBe('managed');
  });

  it('fails closed on a malformed key, naming the variable but not the value', () => {
    const secret = 'not-a-glirastes-key-value';
    let message = '';
    try {
      resolveRuntimeMode({ GLIRASTES_API_KEY: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/GLIRASTES_API_KEY/);
    expect(message).not.toContain(secret);
  });

  it('fails closed on a control plane URL that is not http(s)', () => {
    for (const url of ['ftp://control.example', 'control.example', 'javascript:alert(1)']) {
      let message = '';
      try {
        resolveRuntimeMode({ GLIRASTES_API_KEY: KEY, GLIRASTES_CONTROL_PLANE_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/GLIRASTES_CONTROL_PLANE_URL/);
      expect(message).not.toContain(url);
    }
  });
});

describe('resolveRuntimeConnectionConfig', () => {
  it('is undefined in standalone', () => {
    expect(resolveRuntimeConnectionConfig({})).toBeUndefined();
  });

  it('defaults to the hosted control plane', () => {
    expect(resolveRuntimeConnectionConfig({ GLIRASTES_API_KEY: ` ${KEY} ` })).toEqual({
      baseUrl: DEFAULT_CONTROL_PLANE_URL,
      apiKey: KEY,
    });
    expect(DEFAULT_CONTROL_PLANE_URL).toBe('https://api.glirastes.io');
  });

  it('uses a self-hosted control plane URL when set', () => {
    expect(resolveRuntimeConnectionConfig({
      GLIRASTES_API_KEY: KEY,
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
    })).toEqual({ baseUrl: 'http://localhost:8101', apiKey: KEY });
  });

  it('ignores the variables the platform now answers', () => {
    expect(resolveRuntimeConnectionConfig({
      GLIRASTES_API_KEY: KEY,
      GLIRASTES_APP_ID: 'whatever',
      GLIRASTES_ENVIRONMENT_ID: 'whatever',
      GLIRASTES_RUNNER_KEY: 'whatever',
    })).toEqual({ baseUrl: DEFAULT_CONTROL_PLANE_URL, apiKey: KEY });
  });
});

describe('GLIRASTES_ENVIRONMENT', () => {
  it('is trimmed, and blank means absent', () => {
    expect(resolveRuntimeConnectionConfig({ GLIRASTES_API_KEY: KEY, GLIRASTES_ENVIRONMENT: ' staging ' })?.environment)
      .toBe('staging');
    expect(resolveRuntimeConnectionConfig({ GLIRASTES_API_KEY: KEY, GLIRASTES_ENVIRONMENT: '  ' }))
      .not.toHaveProperty('environment');
  });

  it.each(['Staging', '-x', 'a_b', 'a'.repeat(65)])('rejects %s', (value) => {
    expect(() => resolveRuntimeConnectionConfig({ GLIRASTES_API_KEY: KEY, GLIRASTES_ENVIRONMENT: value }))
      .toThrow(/GLIRASTES_ENVIRONMENT/);
  });
});
