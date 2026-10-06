import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type PipelineResult } from '../../../../types.js';
import type { InternalApiCaller } from '../../../core/index.js';
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

function chatRequest(url: string, headers: Record<string, string>) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{
      id: 'internal-caller', role: 'user', parts: [{ type: 'text', text: 'Tasks' }],
    }] }),
  });
}

/** Runs one chat turn and returns the caller the handler gave `loadTools`. */
async function callerFor(request: Request, pipeline: boolean): Promise<InternalApiCaller> {
  let caller: InternalApiCaller | undefined;
  const handler = createAiChatHandler({
    loadTools: async (context) => {
      caller = context.callEndpoint;
      return registry;
    },
    model: {},
    systemPrompt: 'Assistant',
    ...(pipeline ? { pipeline: { process: async () => pipelineResult } } : {}),
    streamHandler: async () => new Response('ok'),
  });
  await handler(request);
  return caller!;
}

/**
 * The integrating-glirastes-web skill tells agents what the chat handler's
 * endpoint caller can reach. These tests pin that claim to the handler: the
 * caller is built from the chat request, there is no option to replace it.
 */
describe('endpoint caller of the chat handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['legacy mode', false],
    ['pipeline mode', true],
  ])('calls the origin of the chat request and forwards only its cookie (%s)', async (_label, pipeline) => {
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
    }), pipeline);
    const result = await caller({ method: 'GET', path: '/api/tasks' });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://public.example/api/tasks');
    expect(init.headers).toEqual({ cookie: 'session=abc' });
  });
});
