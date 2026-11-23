import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { FIND_TOOLS_PROMPT } from '../tool-discovery.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

async function systemTextOf(toolDiscovery: boolean): Promise<string> {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] as never),
      };
    },
  });
  const handler = createAiChatHandler({
    tools: {
      playlists_list: defineTool({
        id: 'playlists.list', description: 'List playlists.', method: 'GET',
        inputSchema: z.object({}), execute: async () => ({ data: [] }),
      }),
    },
    model,
    systemPrompt: 'Assistant.',
    toolDiscovery,
  } as never);
  await (await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Zeig mir meine Playlists' }] }] }),
  }))).text();
  const system = (prompts[0] as Array<{ role: string; content: unknown }>).find((message) => message.role === 'system');
  return String(system?.content ?? '');
}

describe('the find_tools note in the system prompt', () => {
  it('tells the model to search before saying it cannot do something, when discovery is on', async () => {
    const system = await systemTextOf(true);
    expect(system.startsWith('Assistant.\n\n')).toBe(true);
    expect(system.endsWith(`\n\n${FIND_TOOLS_PROMPT}`)).toBe(true);
  });

  it('is absent without discovery', async () => {
    expect(await systemTextOf(false)).not.toContain('find_tools');
  });
});
