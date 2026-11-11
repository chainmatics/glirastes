import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function setup(extra: Partial<Parameters<typeof createAiChatHandler>[0]> = {}) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never),
    }),
  });
  const tools: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list', description: 'List.', inputSchema: z.object({}).strict(), needsApproval: false, execute: async () => ({ tasks: [] }),
    }),
  };
  const handler = createAiChatHandler({ tools, model, systemPrompt: 'Assistant', ...extra });
  return { handler, model };
}

const body = JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] });

function post(headers: Record<string, string> = {}, payload: BodyInit = body, url = 'https://app.example/api/chat') {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
}

describe('content type', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', ''])(
    'refuses %j with 415 and does not call the model', async (contentType) => {
      const { handler, model } = setup();
      const request = new Request('https://app.example/api/chat', {
        method: 'POST', headers: contentType ? { 'content-type': contentType } : {}, body,
      });
      // A body string sets text/plain itself; the empty case sends it without a type.
      if (!contentType) request.headers.delete('content-type');
      const response = await handler(request);
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error: 'unsupported_media_type' });
      expect(model.doStreamCalls).toHaveLength(0);
    },
  );

  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8'])('accepts %s', async (contentType) => {
    const { handler } = setup();
    const response = await handler(post({ 'content-type': contentType }));
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe('cross-origin requests', () => {
  it.each(['cross-site', 'same-site'])('refuses Sec-Fetch-Site %s with 403', async (site) => {
    const { handler, model } = setup();
    const response = await handler(post({ 'sec-fetch-site': site }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'cross_origin_request_refused' });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it.each(['same-origin', 'none'])('accepts Sec-Fetch-Site %s', async (site) => {
    const { handler } = setup();
    const response = await handler(post({ 'sec-fetch-site': site }));
    expect(response.status).toBe(200);
    await response.text();
  });

  it('lets Sec-Fetch-Site decide over a matching Origin', async () => {
    const { handler } = setup();
    const response = await handler(post({ 'sec-fetch-site': 'cross-site', origin: 'https://app.example' }));
    expect(response.status).toBe(403);
  });

  it.each(['https://evil.example', 'null', 'http://app.example', 'https://app.example.evil.example'])(
    'refuses a foreign Origin %s with 403', async (origin) => {
      const { handler, model } = setup();
      const response = await handler(post({ origin }));
      expect(response.status).toBe(403);
      expect(model.doStreamCalls).toHaveLength(0);
    },
  );

  it('accepts the Origin of the request itself', async () => {
    const { handler } = setup();
    const response = await handler(post({ origin: 'https://app.example' }));
    expect(response.status).toBe(200);
    await response.text();
  });

  it('takes the request origin from the forwarded host and protocol behind a proxy', async () => {
    const { handler } = setup();
    const behindProxy = (origin: string) => post(
      { origin, 'x-forwarded-host': 'chat.example.com', 'x-forwarded-proto': 'https' },
      body,
      'http://localhost:3000/api/chat',
    );
    const ok = await handler(behindProxy('https://chat.example.com'));
    expect(ok.status).toBe(200);
    await ok.text();
    expect((await handler(behindProxy('https://evil.example'))).status).toBe(403);
  });

  it('accepts a request without Origin and Sec-Fetch-Site, as a server-to-server call', async () => {
    const { handler } = setup();
    const response = await handler(post());
    expect(response.status).toBe(200);
    await response.text();
  });

  it('trims trailing slashes of allowedOrigins in linear time (CodeQL js/polynomial-redos)', async () => {
    const hostile = `https://admin.example${'/'.repeat(100_000)}x`;
    const { handler } = setup({ allowedOrigins: [hostile, 'https://front.example///'] });
    const started = performance.now();
    const refused = await handler(post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(refused.status).toBe(403);
    const ok = await handler(post({ origin: 'https://front.example', 'sec-fetch-site': 'cross-site' }));
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('accepts an Origin from allowedOrigins', async () => {
    const { handler } = setup({ allowedOrigins: ['https://admin.example'] });
    const allowed = await handler(post({ origin: 'https://admin.example' }));
    expect(allowed.status).toBe(200);
    await allowed.text();
    expect((await handler(post({ origin: 'https://evil.example' }))).status).toBe(403);
  });

  it.each(['same-site', 'cross-site'])(
    'accepts an Origin from allowedOrigins that a browser sends with Sec-Fetch-Site %s (p9)', async (site) => {
      const { handler } = setup({ allowedOrigins: ['https://admin.example/'] });
      const response = await handler(post({ origin: 'https://admin.example', 'sec-fetch-site': site }));
      expect(response.status).toBe(200);
      await response.text();
    },
  );

  it.each([
    ['without Origin', {}],
    ['with a foreign Origin', { origin: 'https://evil.example' }],
    ['with the own Origin (the browser says it is not)', { origin: 'https://app.example' }],
    ['with Origin null', { origin: 'null' }],
  ])('still refuses Sec-Fetch-Site cross-site %s', async (_label, headers) => {
    const { handler, model } = setup({ allowedOrigins: ['https://admin.example', 'null'] });
    const response = await handler(post({ 'sec-fetch-site': 'cross-site', ...headers }));
    expect(response.status).toBe(403);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('refuses Origin null even when allowedOrigins lists it', async () => {
    const { handler } = setup({ allowedOrigins: ['null'] });
    expect((await handler(post({ origin: 'null' }))).status).toBe(403);
  });

  it('reads the first value of comma-separated forwarded host and protocol (p9)', async () => {
    const { handler } = setup();
    const chained = (origin: string) => post(
      { origin, 'x-forwarded-host': 'app.example, internal', 'x-forwarded-proto': 'https,http' },
      body,
      'http://internal:3000/api/chat',
    );
    const ok = await handler(chained('https://app.example'));
    expect(ok.status).toBe(200);
    await ok.text();
    // The later values (what an inner proxy saw) are not trusted.
    expect((await handler(chained('https://internal'))).status).toBe(403);
    expect((await handler(chained('http://internal'))).status).toBe(403);
  });

  it('does not let a forwarded host equal to the sender\'s own origin pass a cross-site browser request', async () => {
    const { handler, model } = setup();
    for (const site of ['cross-site', 'same-site']) {
      const response = await handler(post(
        { origin: 'https://evil.example', 'sec-fetch-site': site, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', host: 'evil.example' },
      ));
      expect(response.status).toBe(403);
    }
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('accepts the Host header origin of a browser without Sec-Fetch-Site', async () => {
    const { handler } = setup();
    const ok = await handler(post({ origin: 'https://chat.example.com', host: 'chat.example.com' }, body, 'https://localhost:3000/api/chat'));
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('accepts the Host header origin with https and http behind a TLS proxy, for a browser without Sec-Fetch-Site (p30)', async () => {
    const { handler } = setup();
    for (const origin of ['https://chat.example.com', 'http://chat.example.com']) {
      const ok = await handler(post({ origin, host: 'chat.example.com' }, body, 'http://localhost:3000/api/chat'));
      expect(ok.status).toBe(200);
      await ok.text();
    }
    const refused = await handler(post({ origin: 'https://evil.example', host: 'chat.example.com' }, body, 'http://localhost:3000/api/chat'));
    expect(refused.status).toBe(403);
    const otherPort = await handler(post({ origin: 'https://chat.example.com:8443', host: 'chat.example.com' }, body, 'http://localhost:3000/api/chat'));
    expect(otherPort.status).toBe(403);
  });

  it('leaves the endpoint caller on the request URL origin whatever Host says', async () => {
    const { extractOrigin } = await import('../context-helpers.js');
    const request = new Request('http://localhost:3000/api/chat', { headers: { host: 'chat.example.com', origin: 'https://chat.example.com' } });
    expect(extractOrigin(request)).toBe('http://localhost:3000');
  });

  it('can be switched off for an app that authenticates without cookies', async () => {
    const { handler } = setup({ crossOriginProtection: false });
    const response = await handler(post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(200);
    await response.text();
  });

  it('keeps the content type check when the cross-origin check is off', async () => {
    const { handler } = setup({ crossOriginProtection: false });
    const response = await handler(post({ 'content-type': 'text/plain' }));
    expect(response.status).toBe(415);
  });
});

describe('body size', () => {
  const padded = (bytes: number) => JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], pad: 'x'.repeat(bytes) });

  it('refuses a body above 1 MB by default with 413, without calling the model', async () => {
    const { handler, model } = setup();
    const response = await handler(post({}, padded(1_000_001)));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('refuses on the declared Content-Length before reading the body', async () => {
    const { handler } = setup();
    const read = vi.fn();
    const request = post({ 'content-length': '5000000' }, body);
    Object.defineProperty(request, 'json', { value: read });
    Object.defineProperty(request, 'text', { value: read });
    const response = await handler(request);
    expect(response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it('counts the bytes it reads, whatever Content-Length claims', async () => {
    const { handler } = setup({ maxBodyBytes: 100 });
    const response = await handler(post({ 'content-length': '10' }, padded(500)));
    expect(response.status).toBe(413);
  });

  it('counts bytes, not characters', async () => {
    const text = JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], pad: 'ä'.repeat(80) });
    // Fewer characters than the limit, more bytes.
    const { handler } = setup({ maxBodyBytes: text.length + 10 });
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(text.length + 10);
    expect((await handler(post({}, text))).status).toBe(413);
  });

  it('accepts a body at the limit and honours a configured limit', async () => {
    const { handler } = setup({ maxBodyBytes: 4_000_000 });
    const response = await handler(post({}, padded(2_000_000)));
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe('malformed body', () => {
  it.each(['{not json', '', '{"messages": [}'])('answers 400 invalid_json to %j without calling onError or the model', async (text) => {
    const onError = vi.fn();
    const { handler, model } = setup({ onError });
    const response = await handler(post({}, text));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_json' });
    expect(onError).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
