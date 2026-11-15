import { describe, expect, it, vi } from 'vitest';
import { createHttpEndpointCaller, toolToAiTool, type EndpointToolContext, type InternalApiRequest } from '../index.js';
import { defineTool } from '../../../types.js';
import { z } from 'zod';

describe('HTTP endpoint execution boundary', () => {
  it('denies redirects without fetching their destinations', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return new Response('', { status: 302, headers: { location: 'https://other.test/' } });
    });
    const call = createHttpEndpointCaller({ baseUrl: 'https://api.test', fetchImpl });
    expect(await call({ method: 'GET', path: '/api/tasks' })).toMatchObject({ ok: false, status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['/private', '/api-other/x', '/api/../private', '/api/%2e%2e/private', '/api/%252e%252e/private', '/api/a%2fb', '/api/a%5cb'])('refuses paths outside canonical permitted prefixes: %s', async (path) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const call = createHttpEndpointCaller({ baseUrl: 'https://api.test', allowedPathPrefixes: ['/api/'], fetchImpl });
    expect(await call({ method: 'GET', path })).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows the configured prefix and query strings', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const call = createHttpEndpointCaller({ baseUrl: 'https://api.test', allowedPathPrefixes: ['/api'], fetchImpl });
    expect(await call({ method: 'GET', path: '/api/tasks?q=%2f' })).toMatchObject({ ok: true });
  });

  it('bounds a streamed response even without content-length', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(8)); c.enqueue(new Uint8Array(8)); }, cancel,
    }), { headers: { 'content-type': 'application/json' } }));
    const call = createHttpEndpointCaller({ baseUrl: 'https://api.test', maxResponseBytes: 10, fetchImpl });
    await expect(call({ method: 'GET', path: '/api/tasks' })).rejects.toThrow('response exceeds');
    expect(cancel).toHaveBeenCalled();
  });

  it('aborts the network on request cancellation', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      received = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => received!.addEventListener('abort', () => reject(received!.reason), { once: true }));
    });
    const call = createHttpEndpointCaller({ baseUrl: 'https://api.test', request: new Request('https://app.test/chat', { signal: controller.signal }), fetchImpl });
    const promise = call({ method: 'GET', path: '/api/tasks' });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(received?.aborted).toBe(true);
  });

  it('aborts timed out network work', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const call = createHttpEndpointCaller({ baseUrl: 'https://api.test', timeoutMs: 10, fetchImpl });
    await expect(call({ method: 'GET', path: '/api/tasks' })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('passes the AI SDK execution signal into endpoint context without changing shared context', async () => {
    const controller = new AbortController();
    const callEndpoint = vi.fn(async (_request: InternalApiRequest) => ({ ok: true, status: 200 }));
    const context: EndpointToolContext = { currentDate: new Date(), locale: 'en', callEndpoint };
    const tool = toolToAiTool(defineTool({ id: 'list', description: 'List', inputSchema: z.object({}), execute: async (_input, ctx) => (ctx as EndpointToolContext).callEndpoint({ method: 'GET', path: '/api/tasks' }) }), context);
    await tool.execute({}, { abortSignal: controller.signal });
    expect(callEndpoint.mock.calls[0]?.[0]).toMatchObject({ signal: controller.signal });
    expect(context.callEndpoint).toBe(callEndpoint);
  });
});

describe('content-free output diagnostics', () => {
  it('does not log backend values or property paths when output validation fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tool = toolToAiTool(defineTool({ id: 'read', description: 'Read', inputSchema: z.object({}),
        outputSchema: z.object({ PRIVATE_CUSTOMER_NAME: z.enum(['expected']) }),
        execute: async () => ({ PRIVATE_CUSTOMER_NAME: 'SECRET_VALUE' }),
      }), { currentDate: new Date(), locale: 'en' });
      await tool.execute({});
      const printed = JSON.stringify(warning.mock.calls);
      expect(printed).not.toContain('PRIVATE_CUSTOMER_NAME');
      expect(printed).not.toContain('SECRET_VALUE');
      expect(printed).toContain('1 issue');
    } finally { warning.mockRestore(); }
  });
});

describe('query values', () => {
  it('preserves explicit empty scalar and repeated values while omitting null and undefined', async () => {
    const { buildQueryString } = await import('../index.js');
    const query = buildQueryString({ empty: '', repeated: ['', 'next', null, undefined], absent: undefined, nullable: null, count: 0, flag: false });
    const parameters = new URLSearchParams(query);
    expect(parameters.has('empty')).toBe(true);
    expect(parameters.get('empty')).toBe('');
    expect(parameters.getAll('repeated')).toEqual(['', 'next']);
    expect(parameters.has('absent')).toBe(false);
    expect(parameters.has('nullable')).toBe(false);
    expect(parameters.get('count')).toBe('0');
    expect(parameters.get('flag')).toBe('false');
  });
});
