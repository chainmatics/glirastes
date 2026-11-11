import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { defineTool, type PipelineResult } from '../../../../types.js';
import { createHttpEndpointCaller, type InternalApiCaller } from '../../../core/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const registry = {
  list_tasks: defineTool({
    id: 'tasks.list', description: 'List visible tasks.',
    inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
};

const pipelineResult: PipelineResult = {
  model: { modelId: 'fixture' }, tools: [], sanitizedInput: 'Tasks',
  intent: { intent: 'ambiguous', confidence: 0 }, module: null, followupsEnabled: false,
};

type Mode = 'legacy' | 'pipeline' | 'direct command';

/** A `/` command sent alone: the handler runs its tool without a model call. */
const directCommand = formatChatCommandMessage({ commandId: 'tasks.list', tool: 'tasks.list', args: {}, label: '/List tasks' });

function chatRequest(url: string, headers: Record<string, string>, text = 'Tasks') {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{
      id: 'internal-caller', role: 'user', parts: [{ type: 'text', text }],
    }] }),
  });
}

/** Runs one chat turn and returns the caller the handler gave `loadTools`. */
async function callerFor(
  request: Request,
  mode: Mode,
  endpointCaller?: (request: Request) => InternalApiCaller,
  extra: Record<string, unknown> = {},
): Promise<InternalApiCaller> {
  let caller: InternalApiCaller | undefined;
  let streamed = false;
  const handler = createAiChatHandler({
    ...(endpointCaller ? { endpointCaller } : {}),
    loadTools: async (context) => {
      caller = context.callEndpoint;
      return registry;
    },
    model: {},
    systemPrompt: 'Assistant',
    ...(mode === 'pipeline' ? { pipeline: { process: async () => pipelineResult } } : {}),
    ...extra,
    streamHandler: async () => {
      streamed = true;
      return new Response('ok');
    },
  });
  await (await handler(request)).text();
  // A direct command takes its own path: it never reaches the model's stream handler.
  expect(streamed).toBe(mode !== 'direct command');
  return caller!;
}

/**
 * The integrating-glirastes-web skill tells agents what the chat handler's
 * endpoint caller can reach. These tests pin that claim to the handler: by
 * default the caller is built from the chat request (its origin and cookie),
 * and `endpointCaller` replaces it in every mode.
 */
describe('endpoint caller of the chat handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['legacy mode', 'legacy'],
    ['pipeline mode', 'pipeline'],
    ['direct command', 'direct command'],
  ] as const)('calls the origin of the chat request URL, not a forwarded host, and forwards only its cookie (%s)', async (_label, mode) => {
    const fetchMock = vi.fn(async () => new Response('{"tasks":[]}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const caller = await callerFor(chatRequest('https://app.example/api/chat', {
      cookie: 'session=abc',
      authorization: 'Bearer user-token',
      'x-forwarded-host': 'public.example',
      'x-forwarded-proto': 'https',
      'x-api-key': 'not-forwarded',
    }, mode === 'direct command' ? directCommand : 'Tasks'), mode);
    const result = await caller({ method: 'GET', path: '/api/tasks' });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.example/api/tasks');
    expect(init.headers).toEqual({ cookie: 'session=abc' });
  });

  it.each([
    ['legacy mode', 'legacy'],
    ['pipeline mode', 'pipeline'],
    ['direct command', 'direct command'],
  ] as const)('never sends the cookie to a host the client names in x-forwarded-host or Host (p16, %s)', async (_label, mode) => {
    const fetchMock = vi.fn(async () => new Response('{"tasks":[]}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    for (const headers of [
      { 'x-forwarded-host': 'attacker.example, app.example', 'x-forwarded-proto': 'https, https' },
      { 'x-forwarded-host': '169.254.169.254', 'x-forwarded-proto': 'http' },
      { host: 'attacker.example' },
    ]) {
      const caller = await callerFor(chatRequest('http://internal:3000/api/chat', { cookie: 'session=victim', ...headers }, mode === 'direct command' ? directCommand : 'Tasks'), mode);
      await caller({ method: 'GET', path: '/api/tasks' });
    }
    const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map(([url]) => url);
    expect(urls).toEqual(Array(3).fill('http://internal:3000/api/tasks'));
  });

  it.each([
    ['legacy mode', 'legacy'],
    ['pipeline mode', 'pipeline'],
    ['direct command', 'direct command'],
  ] as const)('with trustForwardedHeaders, calls the host the nearest proxy set: the last forwarded value (%s)', async (_label, mode) => {
    const fetchMock = vi.fn(async () => new Response('{"tasks":[]}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const text = mode === 'direct command' ? directCommand : 'Tasks';
    const trusted = { trustForwardedHeaders: true };
    await (await callerFor(chatRequest('http://internal:3000/api/chat', { 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' }, text), mode, undefined, trusted))({ method: 'GET', path: '/api/a' });
    await (await callerFor(chatRequest('http://internal:3000/api/chat', { 'x-forwarded-host': 'attacker.example, public.example', 'x-forwarded-proto': 'http, https' }, text), mode, undefined, trusted))({ method: 'GET', path: '/api/b' });
    await (await callerFor(chatRequest('http://internal:3000/api/chat', { 'x-forwarded-host': 'evil.example/x@y' }, text), mode, undefined, trusted))({ method: 'GET', path: '/api/c' });
    const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map(([url]) => url);
    expect(urls).toEqual(['https://public.example/api/a', 'https://public.example/api/b', 'http://internal:3000/api/c']);
  });

  it.each([
    ['legacy mode', 'legacy'],
    ['pipeline mode', 'pipeline'],
    ['direct command', 'direct command'],
  ] as const)('uses the configured endpoint caller for an API on its own origin (%s)', async (_label, mode) => {
    const fetchMock = vi.fn(async () => new Response('{"tasks":[]}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const requests: Request[] = [];

    const caller = await callerFor(chatRequest('https://app.example/api/chat', {
      cookie: 'session=abc',
      authorization: 'Bearer user-token',
      'x-forwarded-host': 'public.example',
      'x-api-key': 'not-forwarded',
    }, mode === 'direct command' ? directCommand : 'Tasks'), mode, (request) => {
      requests.push(request);
      return createHttpEndpointCaller({ baseUrl: 'http://127.0.0.1:4000', request });
    });
    const result = await caller({ method: 'GET', path: '/api/tasks' });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://app.example/api/chat');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4000/api/tasks');
    expect(init.headers).toEqual({ authorization: 'Bearer user-token', cookie: 'session=abc' });
  });
});
