import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function model(answer: string) {
  const prompts: unknown[] = [];
  return {
    prompts,
    model: new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: answer },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ] as never),
        };
      },
    }),
  };
}

const tracks = (declared: boolean) => defineTool({
  id: 'tracks.list',
  description: 'List tracks.',
  inputSchema: z.object({}),
  method: 'GET',
  ...(declared ? { outputEntities: [{ type: 'track', id: 'trackNo', name: 'title', path: 'tracks[]' }] } : {}),
  execute: async () => ({ tracks: [{ trackNo: 3, title: 'Intro' }] }),
});

/** A conversation whose earlier turn listed track 3. */
function request() {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Tracks?' }] },
        {
          id: 'a0', role: 'assistant', parts: [{
            type: 'tool-tracks_list', toolCallId: 'c1', state: 'output-available', input: {},
            output: { success: true, tracks: [{ trackNo: 3, title: 'Intro' }] },
          }, { type: 'text', text: 'One track.' }],
        },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Delete it' }] },
      ],
    }),
  });
}

describe('declared identity in the chat handler', () => {
  it('sends a transient data-tool-entities part and hides a declared integer id only with a prefix', async () => {
    const { model: chatModel } = model('Deleted Intro (ID: 3) of 3 tracks.');
    const handler = createAiChatHandler({ tools: { tracks_list: tracks(true) }, model: chatModel, systemPrompt: 'A.', intentRouting: false } as never);
    const body = await (await handler(request())).text();
    expect(body).toContain('"type":"data-tool-entities"');
    expect(body).toContain('"trackNo"');
    expect(body).toContain('Deleted Intro of 3 tracks.');
  });

  it('sends nothing new and leaves the answer as before for an app without declarations', async () => {
    const { model: chatModel } = model('Deleted Intro (ID: 3) of 3 tracks.');
    const handler = createAiChatHandler({ tools: { tracks_list: tracks(false) }, model: chatModel, systemPrompt: 'A.', intentRouting: false } as never);
    const body = await (await handler(request())).text();
    expect(body).not.toContain('data-tool-entities');
    expect(body).toContain('Deleted Intro (ID: 3) of 3 tracks.');
  });
});
