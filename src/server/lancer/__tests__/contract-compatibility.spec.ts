import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createLancer } from '../client';
import type { Lancer } from '../types';

/**
 * Contract-compatibility tests
 *
 * These tests lock the exact HTTP request shapes the Lancer SDK sends to the
 * Glirastes API.  If a refactor accidentally changes a field name, HTTP method,
 * or query-param encoding these tests will catch it.
 */
describe('Lancer runtime contract compatibility', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: Lancer;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    client?.destroy();
    vi.restoreAllMocks();
  });

  // -- config.fetch contract --------------------------------------------------

  describe('config.fetch — GET /v1/config?modules=...', () => {
    it('uses GET with query params instead of POST body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ modules: { a: {}, b: {} } }),
        headers: new Headers({ etag: '"v2"' }),
      });

      client = createLancer({ apiKey: 'k', baseUrl: 'http://localhost' });
      await client.config.fetch(['a', 'b']);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];

      // Must be GET
      expect(init.method).toBe('GET');

      // Modules passed as comma-separated query param
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/v1/config');
      expect(parsed.searchParams.get('modules')).toBe('a,b');

      // No request body
      expect(init.body).toBeUndefined();
    });

    it('preserves ETag / If-None-Match on conditional GET', async () => {
      vi.useFakeTimers();

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ modules: { x: {} } }),
        headers: new Headers({ etag: '"etag-1"' }),
      });

      client = createLancer({
        apiKey: 'k',
        baseUrl: 'http://localhost',
        cache: { ttl: 500 },
      });
      await client.config.fetch(['x']);

      // Expire cache
      vi.advanceTimersByTime(501);

      fetchMock.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Headers(),
      });

      await client.config.fetch(['x']);

      const secondCall = fetchMock.mock.calls[1];
      expect(secondCall[1].method).toBe('GET');
      expect(secondCall[1].headers['If-None-Match']).toBe('"etag-1"');

      vi.useRealTimers();
    });
  });

  // -- primus.classify contract -----------------------------------------------

  describe('primus.classify — POST /v1/primus/classify', () => {
    it('normalizes modules to string[] even when caller passes { moduleId }[]', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ moduleId: 'mod-a', confidence: 0.9, modelTier: 'standard' }),
      });

      client = createLancer({ apiKey: 'k', baseUrl: 'http://localhost' });
      await client.primus.classify('route me', [
        { moduleId: 'mod-a' },
        { moduleId: 'mod-b' },
      ]);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];

      expect(init.method).toBe('POST');
      expect(url).toBe('http://localhost/v1/primus/classify');

      // The wire format must send modules as plain string array
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        message: 'route me',
        modules: ['mod-a', 'mod-b'],
      });
    });
  });
});
