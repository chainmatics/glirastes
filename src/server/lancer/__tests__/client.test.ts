import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createLancer } from '../client';
import { ServiceBlockedError } from '../errors';
import type { Lancer } from '../types';

describe('createLancer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: Lancer;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    client?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -- config.fetch ---------------------------------------------------------

  describe('config.fetch', () => {
    it('fetches config and stores ETag', async () => {
      const body = { modules: { a: {} } };
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        headers: new Headers({ etag: '"v1"' }),
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.config.fetch(['a']);

      expect(result).toEqual(body);

      // Second call should come from cache
      const result2 = await client.config.fetch(['a']);
      expect(result2).toEqual(body);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('sends If-None-Match when ETag is cached and cache expired', async () => {
      const body = { modules: { a: {} } };
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        headers: new Headers({ etag: '"v1"' }),
      });

      client = createLancer({ apiKey: 'key', cache: { ttl: 1_000 } });
      await client.config.fetch(['a']);

      // Expire cache
      vi.advanceTimersByTime(1_001);

      // Return 304
      fetchMock.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Headers(),
      });

      const result2 = await client.config.fetch(['a']);
      // Should still return empty modules (cache was expired, 304 fallback)
      expect(result2).toBeDefined();

      // The second call should have sent If-None-Match
      const secondCall = fetchMock.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBe('"v1"');
    });

    it('fires onDegraded when the API is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('offline'));
      const onDegraded = vi.fn();

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        onDegraded,
      });

      const result = await client.config.fetch(['x']);
      expect(result).toEqual({ modules: {} });
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  // -- primus.classify ------------------------------------------------------

  describe('primus.classify', () => {
    it('calls the API and returns classification', async () => {
      const apiResult = { moduleId: 'mod-1', confidence: 0.95, modelTier: 'advanced' };
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => apiResult,
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.primus.classify('hello', [{ moduleId: 'mod-1' }]);

      expect(result).toEqual(apiResult);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.glirastes.chainmatics.io/v1/primus/classify');
      expect(JSON.parse(init.body)).toEqual({ message: 'hello', modules: ['mod-1'] });
    });

    it('falls back to empty classification on failure', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({ apiKey: 'key', retry: { maxRetries: 0 }, onDegraded });
      const result = await client.primus.classify('hello', [{ moduleId: 'mod-1' }]);

      expect(result).toEqual({ moduleId: '', confidence: 0, modelTier: 'standard' });
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  // -- warden.check ---------------------------------------------------------

  describe('warden.check', () => {
    it('calls the API and maps policy to rule', async () => {
      const apiResult = {
        passed: false,
        violations: [
          { policy: 'no-profanity', type: 'content', message: 'Profanity detected', severity: 'high' },
        ],
      };
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => apiResult,
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.warden.check('bad input', ['no-profanity']);

      expect(result.passed).toBe(false);
      expect(result.violations).toEqual([
        { rule: 'no-profanity', severity: 'high', message: 'Profanity detected' },
      ]);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.glirastes.chainmatics.io/v1/warden/check');
      expect(JSON.parse(init.body)).toEqual({ input: 'bad input', policies: ['no-profanity'] });
    });

    it('returns passed: true with no violations on API success', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ passed: true, violations: [] }),
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.warden.check('safe input', ['no-profanity']);

      expect(result).toEqual({ passed: true, violations: [] });
    });

    it('falls back to passed: true on failure', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({ apiKey: 'key', retry: { maxRetries: 0 }, onDegraded });
      const result = await client.warden.check('input', ['policy']);

      expect(result).toEqual({ passed: true, violations: [] });
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  // -- aegis.analyze --------------------------------------------------------

  describe('aegis.analyze', () => {
    it('calls the API and returns PII analysis', async () => {
      const apiResult = {
        entities: [{ type: 'EMAIL', value: 'a@b.com', start: 0, end: 7 }],
        anonymized: '<EMAIL>',
        mappingToken: 'tok-123',
      };
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => apiResult,
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.aegis.analyze('a@b.com', { locales: ['en'] });

      expect(result).toEqual(apiResult);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.glirastes.chainmatics.io/v1/aegis/analyze');
      expect(JSON.parse(init.body)).toEqual({ text: 'a@b.com', locales: ['en'], mode: 'pseudonymize', sessionId: undefined });
    });

    it('falls back to passthrough on failure', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({ apiKey: 'key', retry: { maxRetries: 0 }, onDegraded });
      const result = await client.aegis.analyze('hello', { locales: ['en'] });

      expect(result).toEqual({ entities: [], anonymized: 'hello', mappingToken: null });
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  // -- aegis.rehydrate ------------------------------------------------------

  describe('aegis.rehydrate', () => {
    it('calls the API and returns rehydrated text', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ rehydrated: 'a@b.com' }),
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.aegis.rehydrate('<EMAIL>', 'tok-123');

      expect(result).toBe('a@b.com');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.glirastes.chainmatics.io/v1/aegis/rehydrate');
      expect(JSON.parse(init.body)).toEqual({ text: '<EMAIL>', mappingToken: 'tok-123' });
    });

    it('falls back to original text on failure', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({ apiKey: 'key', retry: { maxRetries: 0 }, onDegraded });
      const result = await client.aegis.rehydrate('<EMAIL>', 'tok-123');

      expect(result).toBe('<EMAIL>');
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  // -- aegis.checkLeakage ---------------------------------------------------

  describe('aegis.checkLeakage', () => {
    it('calls the API and returns leakage result', async () => {
      const apiResult = {
        leaked: true,
        entities: [{ type: 'EMAIL', value: 'leaked@test.com', start: 0, end: 15, confidence: 0.95 }],
        totalDetected: 1,
        filteredAsKnown: 0,
      };
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => apiResult,
      });

      client = createLancer({ apiKey: 'key' });
      const result = await client.aegis.checkLeakage('leaked@test.com', 'tok-123', ['en']);

      expect(result).toEqual(apiResult);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.glirastes.chainmatics.io/v1/aegis/check-leakage');
      expect(JSON.parse(init.body)).toEqual({ text: 'leaked@test.com', mappingToken: 'tok-123', locales: ['en'] });
    });

    it('falls back to no-leakage on failure', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({ apiKey: 'key', retry: { maxRetries: 0 }, onDegraded });
      const result = await client.aegis.checkLeakage('test', 'tok-123');

      expect(result).toEqual({ leaked: false, entities: [], totalDetected: 0, filteredAsKnown: 0 });
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  // -- telemetry ------------------------------------------------------------

  describe('telemetry', () => {
    it('emits events and flushes them', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      client = createLancer({ apiKey: 'key' });
      client.telemetry.emit({ eventType: 'test' });
      await client.telemetry.flush();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.glirastes.chainmatics.io/v1/proctor/events');
      const body = JSON.parse(init.body as string);
      expect(body.events).toHaveLength(1);
      expect(body.events[0].eventType).toBe('test');
    });
  });

  // -- destroy --------------------------------------------------------------

  describe('destroy', () => {
    it('cleans up without errors', () => {
      client = createLancer({ apiKey: 'key' });
      expect(() => client.destroy()).not.toThrow();
    });
  });

  // -- degradation modes ----------------------------------------------------

  describe('degradation: block action', () => {
    it('throws ServiceBlockedError for warden when degradation.warden is block', async () => {
      fetchMock.mockRejectedValue(new Error('down'));

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        degradation: { warden: 'block' },
      });

      await expect(client.warden.check('input', ['policy'])).rejects.toThrow(ServiceBlockedError);
    });

    it('ServiceBlockedError carries the service name', async () => {
      fetchMock.mockRejectedValue(new Error('down'));

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        degradation: { primus: 'block' },
      });

      const err = await client.primus.classify('hello', []).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceBlockedError);
      expect((err as ServiceBlockedError).service).toBe('primus');
    });
  });

  describe('degradation: silent action', () => {
    it('returns fallback without calling onDegraded for silent services', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        degradation: { warden: 'silent' },
        onDegraded,
      });

      const result = await client.warden.check('input', ['policy']);
      expect(result).toEqual({ passed: true, violations: [] });
      expect(onDegraded).not.toHaveBeenCalled();
    });

    it('fallback action still calls onDegraded', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onDegraded = vi.fn();

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        degradation: { warden: 'fallback' },
        onDegraded,
      });

      await client.warden.check('input', ['policy']);
      expect(onDegraded).toHaveBeenCalledOnce();
    });
  });

  describe('degradation: onServiceUnavailable callback', () => {
    it('callback overrides static default and returns fallback', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onServiceUnavailable = vi.fn().mockResolvedValue('fallback');
      const onDegraded = vi.fn();

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        // static default would be 'fallback' anyway, but callback overrides
        onServiceUnavailable,
        onDegraded,
      });

      const result = await client.warden.check('input', ['policy']);
      expect(result).toEqual({ passed: true, violations: [] });
      expect(onServiceUnavailable).toHaveBeenCalledOnce();
      expect(onServiceUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'warden', error: expect.any(Error) }),
      );
      expect(onDegraded).toHaveBeenCalledOnce();
    });

    it('callback can escalate to block', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onServiceUnavailable = vi.fn().mockResolvedValue('block');

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        onServiceUnavailable,
      });

      await expect(client.warden.check('input', ['policy'])).rejects.toThrow(ServiceBlockedError);
    });

    it('callback receives the correct service name for each call', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const onServiceUnavailable = vi.fn().mockResolvedValue('silent');

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        onServiceUnavailable,
      });

      await client.primus.classify('msg', []);
      expect(onServiceUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'primus' }),
      );

      await client.aegis.analyze('text', { locales: ['en'] });
      expect(onServiceUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'aegis' }),
      );
    });

    it('callback overrides degradation defaults', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      // static default says 'block', callback says 'silent' → silent wins
      const onServiceUnavailable = vi.fn().mockResolvedValue('silent');
      const onDegraded = vi.fn();

      client = createLancer({
        apiKey: 'key',
        retry: { maxRetries: 0 },
        degradation: { warden: 'block' },
        onServiceUnavailable,
        onDegraded,
      });

      const result = await client.warden.check('input', ['policy']);
      expect(result).toEqual({ passed: true, violations: [] });
      expect(onDegraded).not.toHaveBeenCalled();
    });
  });
});
