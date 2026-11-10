import { describe, expect, it, vi } from 'vitest';
import { createHttpEndpointCaller } from '../index.js';

function fetchRecorder(body: unknown = { tasks: [] }, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

function chatRequest(headers: Record<string, string>): Request {
  return new Request('https://app.example/api/chat', { method: 'POST', headers });
}

describe('createHttpEndpointCaller', () => {
  it('calls the fixed API origin with only the cookie and authorization of the chat request', async () => {
    const fetchImpl = fetchRecorder();
    const caller = createHttpEndpointCaller({
      baseUrl: 'http://127.0.0.1:4000',
      request: chatRequest({
        cookie: 'session=abc',
        authorization: 'Bearer user-token',
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-api-key': 'not-forwarded',
      }),
      fetchImpl,
    });

    expect(await caller({ method: 'GET', path: '/api/tasks?status=open' })).toEqual({
      ok: true, status: 200, data: { tasks: [] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4000/api/tasks?status=open');
    expect(init).toEqual({
      method: 'GET',
      headers: { authorization: 'Bearer user-token', cookie: 'session=abc' },
    });
  });

  it('sends a JSON body for writes and reports the API error', async () => {
    const fetchImpl = fetchRecorder({ error: 'Invalid task' }, 400);
    const caller = createHttpEndpointCaller({
      baseUrl: 'https://api.example/',
      request: chatRequest({ cookie: 'session=abc' }),
      fetchImpl,
    });

    expect(await caller({ method: 'POST', path: '/tasks', body: { title: '' } })).toEqual({
      ok: false, status: 400, data: { error: 'Invalid task' }, error: 'Invalid task',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example/tasks');
    expect(init).toEqual({
      method: 'POST',
      headers: { cookie: 'session=abc', 'content-type': 'application/json' },
      body: '{"title":""}',
    });
  });

  it('never lets a default header stand in for a credential the user did not send', async () => {
    const fetchImpl = fetchRecorder();
    const caller = createHttpEndpointCaller({
      baseUrl: 'http://127.0.0.1:4000',
      request: chatRequest({}),
      defaultHeaders: { Authorization: 'Bearer service-account', cookie: 'session=admin', 'x-request-source': 'chat' },
      fetchImpl,
    });

    await caller({ method: 'GET', path: '/api/tasks' });
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: 'GET', headers: { 'x-request-source': 'chat' } });
  });

  it('forwards the configured header names only', async () => {
    const fetchImpl = fetchRecorder();
    const caller = createHttpEndpointCaller({
      baseUrl: 'http://127.0.0.1:4000',
      request: chatRequest({ cookie: 'session=abc', 'X-Tenant': 'acme' }),
      forwardHeaderNames: ['X-Tenant'],
      fetchImpl,
    });

    await caller({ method: 'DELETE', path: '/api/tasks/1' });
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: 'DELETE', headers: { 'x-tenant': 'acme' } });
  });

  it.each([
    ['a path', 'http://127.0.0.1:4000/api', 'baseUrl is an origin'],
    ['a query', 'http://127.0.0.1:4000?x=1', 'baseUrl is an origin'],
    ['credentials', 'http://user:secret@127.0.0.1:4000', 'baseUrl is an origin'],
    ['another protocol', 'file:///etc/passwd', 'http or https URL'],
  ])('refuses a base URL with %s', (_label, baseUrl, message) => {
    expect(() => createHttpEndpointCaller({ baseUrl })).toThrow(message);
  });

  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative path', '//evil.example/steal'],
    ['a relative path', 'api/tasks'],
    ['a backslash path', '/\\evil.example'],
    // A URL parser drops tab, CR and LF before it reads the host, so these would leave the API.
    ['a tab in front of a host', '/\t/evil.example/steal'],
    ['a line feed in front of a host', '/\n/evil.example/steal'],
    ['a carriage return in front of a host', '/\r/evil.example/steal'],
  ])('refuses %s without calling the network', async (_label, path) => {
    const fetchImpl = fetchRecorder();
    const caller = createHttpEndpointCaller({ baseUrl: 'http://127.0.0.1:4000', fetchImpl });

    expect(await caller({ method: 'GET', path })).toEqual({
      ok: false, status: 400, error: 'Endpoint path must be relative to the API',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTTPException', 401, { detail: 'Unauthenticated' }, 'Unauthenticated'],
    ['a validation error', 422, {
      detail: [
        { loc: ['body', 'title'], msg: 'String should have at least 1 character', type: 'string_too_short' },
        { loc: ['query', 'status'], msg: "Input should be 'open' or 'done'", type: 'literal_error' },
      ],
    }, "body.title: String should have at least 1 character; query.status: Input should be 'open' or 'done'"],
  ])('reads the error of a FastAPI %s', async (_label, status, body, error) => {
    const caller = createHttpEndpointCaller({ baseUrl: 'http://127.0.0.1:8000', fetchImpl: fetchRecorder(body, status) });

    expect(await caller({ method: 'POST', path: '/api/tasks', body: { title: '' } })).toMatchObject({ ok: false, status, error });
  });
});
