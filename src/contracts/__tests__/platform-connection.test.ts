import { describe, expect, it } from 'vitest';
import {
  PairingStartRequestSchema,
  PairingStartResponseSchema,
  PairingTokenResultSchema,
  PlatformConnectionDescriptorSchema,
} from '../index.js';

const appId = '019fa9a9-d5f7-7ec3-a3c7-8899de400001';
const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de400002';
const artifactDigest = `sha256:${'A'.repeat(43)}`;

describe('PlatformConnectionDescriptorSchema', () => {
  it('accepts HTTPS and loopback HTTP without carrying credentials', () => {
    const descriptor = PlatformConnectionDescriptorSchema.parse({
      schemaVersion: 1,
      baseUrl: 'https://platform.glirastes.io',
      appId,
      environmentId,
      runnerKey: 'local-7ec3',
    });

    expect(descriptor.baseUrl).toBe('https://platform.glirastes.io');
    expect(descriptor).not.toHaveProperty('apiKey');
    expect(PlatformConnectionDescriptorSchema.parse({
      ...descriptor,
      baseUrl: 'http://localhost:8101',
    }).baseUrl).toBe('http://localhost:8101');
  });

  it.each([
    'http://platform.glirastes.io',
    'ftp://platform.glirastes.io',
    'https://user:password@platform.glirastes.io',
  ])('rejects an unsafe control-plane URL: %s', (baseUrl) => {
    expect(() => PlatformConnectionDescriptorSchema.parse({
      schemaVersion: 1,
      baseUrl,
      appId,
      environmentId,
      runnerKey: 'local-7ec3',
    })).toThrow();
  });

  it('rejects unknown fields so a secret cannot enter the tracked descriptor', () => {
    expect(() => PlatformConnectionDescriptorSchema.parse({
      schemaVersion: 1,
      baseUrl: 'https://platform.glirastes.io',
      appId,
      environmentId,
      runnerKey: 'local-7ec3',
      apiKey: `gl_${'x'.repeat(40)}`,
    })).toThrow();
  });
});

describe('browser pairing contracts', () => {
  it('bounds the local identity sent when a pairing starts', () => {
    expect(PairingStartRequestSchema.parse({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: 'Get It Done',
      artifactDigest,
    })).toEqual({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: 'Get It Done',
      artifactDigest,
    });
    expect(() => PairingStartRequestSchema.parse({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: 'x'.repeat(101),
      artifactDigest,
    })).toThrow();
  });

  it('validates the one-time device response without accepting extra data', () => {
    const response = PairingStartResponseSchema.parse({
      schemaVersion: 1,
      deviceCode: 'device_abcdefghijklmnopqrstuvwxyz0123456789',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://platform.glirastes.io/connect/pair',
      expiresInSeconds: 600,
      pollIntervalMs: 2_000,
    });
    expect(response.userCode).toBe('ABCD-EFGH');
    expect(() => PairingStartResponseSchema.parse({
      ...response,
      apiKey: `gl_${'x'.repeat(40)}`,
    })).toThrow();
  });

  it.each(['pending', 'denied', 'expired'] as const)(
    'accepts the bounded %s state',
    (status) => {
      const value = status === 'pending'
        ? { status, pollAfterMs: 2_000 }
        : { status };
      expect(PairingTokenResultSchema.parse(value).status).toBe(status);
    },
  );

  it('allows a credential only in the one-time connected response', () => {
    const result = PairingTokenResultSchema.parse({
      status: 'connected',
      connection: {
        schemaVersion: 1,
        baseUrl: 'https://platform.glirastes.io',
        appId,
        environmentId,
        runnerKey: 'local-7ec3',
      },
      apiKey: `gl_${'x'.repeat(40)}`,
    });
    expect(result.status).toBe('connected');
    expect(() => PairingTokenResultSchema.parse({
      status: 'pending',
      pollAfterMs: 2_000,
      apiKey: `gl_${'x'.repeat(40)}`,
    })).toThrow();
  });
});
