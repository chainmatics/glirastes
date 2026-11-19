import { readUIMessageStream, type UIMessage } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { defineEndpointTool, type AiEndpointToolDefinition, type ToolRegistry } from '../../../../types.js';
import { endpointToolsToRegistry, type InternalApiRequest, type InternalApiResponse } from '../../../core/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

export const SECRET = 'approval-subject-secret-with-32-chars';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** The model makes `calls` in its first step, then answers with text. Its prompts are kept. */
export function callingModel(calls: Array<{ toolName: string; input: unknown; id?: string }>) {
  let step = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      step += 1;
      prompts.push(options.prompt);
      return {
        stream: convertArrayToReadableStream((step === 1
          ? [
            { type: 'stream-start', warnings: [] },
            ...calls.map((call, index) => ({
              type: 'tool-call', toolCallId: call.id ?? `call-${index + 1}`, toolName: call.toolName, input: JSON.stringify(call.input),
            })),
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Done.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]) as never),
      };
    },
  });
  return { model, prompts };
}

export interface BackendCall extends InternalApiRequest {
  authorization: string | null;
}

/** A fake backend: `routes` answers by `METHOD path`; every call is recorded with the request's credentials. */
export function fakeBackend(routes: Record<string, (request: InternalApiRequest) => InternalApiResponse | Promise<InternalApiResponse>>) {
  const calls: BackendCall[] = [];
  const endpointCaller = (req: Request) => async (request: InternalApiRequest): Promise<InternalApiResponse> => {
    calls.push({ ...request, authorization: req.headers.get('authorization') });
    const route = routes[`${request.method} ${request.path}`];
    if (!route) return { ok: false, status: 404, data: { detail: 'Not found' }, error: 'Not found' };
    return route(request);
  };
  return { calls, endpointCaller };
}

export const ok = (data: unknown): InternalApiResponse => ({ ok: true, status: 200, data });
export const failure = (status: number, data: unknown = { detail: 'backend secret detail' }): InternalApiResponse => ({
  ok: false, status, data, error: `Endpoint failed (${status})`,
});

const tool = (definition: Partial<AiEndpointToolDefinition> & Pick<AiEndpointToolDefinition, 'id' | 'toolName' | 'method' | 'path' | 'inputSchema'>) =>
  defineEndpointTool({ description: definition.toolName, ...definition } as AiEndpointToolDefinition);

/** The reference tools: playlists (numeric ids), versions (a list by parent), channels (speaking keys, a complete list), users (one page). */
export function referenceTools(overrides: {
  getPlaylist?: Partial<AiEndpointToolDefinition>;
  deletePlaylist?: Partial<AiEndpointToolDefinition>;
  extra?: AiEndpointToolDefinition[];
} = {}): ToolRegistry {
  return endpointToolsToRegistry([
    tool({
      id: 'playlists.get', toolName: 'get_playlist', method: 'GET', path: '/playlists/:playlist_id',
      inputSchema: z.object({ playlist_id: z.number().int() }).strict(),
      outputEntities: [{ type: 'playlist', id: 'playlist_id', name: 'displayName', path: '' }],
      entityLookup: { type: 'playlist', params: { playlist_id: 'playlist_id' } },
      ...overrides.getPlaylist,
    }),
    tool({
      id: 'playlists.delete', toolName: 'delete_playlist', method: 'DELETE', path: '/playlists/:playlist_id',
      inputSchema: z.object({ playlist_id: z.number().int() }).strict(),
      inputEntities: [{ type: 'playlist', args: 'playlist_id' }],
      ...overrides.deletePlaylist,
    }),
    tool({
      id: 'users.get', toolName: 'get_user', method: 'GET', path: '/users/:id',
      inputSchema: z.object({ id: z.number().int() }).strict(),
      outputEntities: [{ type: 'user', id: 'id', name: 'displayName', path: '' }],
    }),
    tool({
      id: 'versions.list', toolName: 'list_playlist_versions', method: 'GET', path: '/playlists/:playlist_id/versions',
      inputSchema: z.object({ playlist_id: z.number().int() }).strict(),
      outputEntities: [{ type: 'playlist-version', id: 'version_id', fallback: 'versionNumber', path: 'data[]' }],
      entityLookup: { type: 'playlist-version', params: { playlist_id: { ref: 'playlist' } }, complete: true },
    }),
    tool({
      id: 'playlists.rollback', toolName: 'roll_back_playlist', method: 'POST', path: '/playlists/:playlist_id/rollback',
      inputSchema: z.object({ playlist_id: z.number().int(), version_id: z.number().int() }).strict(),
      inputEntities: [{ type: 'playlist', args: 'playlist_id', role: 'parent' }, { type: 'playlist-version', args: 'version_id' }],
    }),
    tool({
      id: 'channels.list', toolName: 'list_channels', method: 'GET', path: '/channels',
      inputSchema: z.object({}).strict(),
      outputEntities: [{ type: 'channel', id: 'key', name: 'title', path: 'data[]' }],
      entityLookup: { type: 'channel', params: {}, complete: true },
    }),
    tool({
      id: 'channels.delete', toolName: 'delete_channel', method: 'DELETE', path: '/channels/:key',
      inputSchema: z.object({ key: z.string() }).strict(),
      inputEntities: [{ type: 'channel', args: 'key' }],
    }),
    tool({
      id: 'users.list', toolName: 'list_users', method: 'GET', path: '/users',
      inputSchema: z.object({ limit: z.number().int().optional() }).strict(),
      outputEntities: [{ type: 'member', id: 'user_id', name: 'name', path: 'items[]' }],
      entityLookup: { type: 'member', params: {}, const: { limit: 2 } },
    }),
    tool({
      id: 'users.delete', toolName: 'delete_user', method: 'DELETE', path: '/users/:user_id',
      inputSchema: z.object({ user_id: z.number().int() }).strict(),
      inputEntities: [{ type: 'member', args: 'user_id' }],
    }),
    ...(overrides.extra ?? []),
  ]);
}

export const post = (messages: unknown[], authorization = 'Bearer user-token') => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ messages }),
});
export const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Please do it' }] };

export async function streamChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** The assistant message the browser holds after the stream. */
export async function clientMessage(chunks: Array<Record<string, unknown>>): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk as never); controller.close(); } }),
  })) last = message;
  return JSON.parse(JSON.stringify(last)) as UIMessage;
}

/** `addToolApprovalResponse` of the AI SDK client for every open request. */
export function answered(message: UIMessage, approved: boolean, edit?: (part: Record<string, unknown>) => Record<string, unknown>): UIMessage {
  const parts = message.parts.map((part) => {
    const record = part as Record<string, unknown>;
    if (record.state !== 'approval-requested') return edit && record.type === 'data-approval-subjects' ? edit(record) as never : part;
    const next = { ...record, state: 'approval-responded', approval: { id: (record.approval as { id: string }).id, approved } };
    return (edit ? edit(next) : next) as never;
  });
  return JSON.parse(JSON.stringify({ ...message, parts }));
}

export async function turn(config: Parameters<typeof createAiChatHandler>[0], messages: unknown[] = [user]) {
  const handler = createAiChatHandler(config);
  const chunks = await streamChunks(await handler(post(messages)));
  return { handler, chunks, message: await clientMessage(chunks) };
}

export const subjectsPart = (chunks: Array<Record<string, unknown>>, toolCallId = 'call-1') =>
  chunks.find((chunk) => chunk.type === 'data-approval-subjects' && chunk.id === toolCallId) as
    | { type: string; id: string; data: { v: number; toolCallId: string; subjects: Array<Record<string, unknown>>; preview?: Record<string, unknown> } }
    | undefined;

/** Everything the model was sent, as one string. */
export const promptText = (prompts: unknown[]) => JSON.stringify(prompts);
