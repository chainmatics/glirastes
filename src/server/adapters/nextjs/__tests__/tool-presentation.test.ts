import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { toolPresentationOf } from '../tool-presentation.js';

const presentation = { locale: 'de-DE', singular: 'Aufgabe', plural: 'Aufgaben', approval: 'Aufgaben auflisten?' };

/** The fixture manifest with a wording on its first tool, as `glirastes tools refresh` derives one for every tool. */
const worded = {
  ...manifestRevision,
  tools: manifestRevision.tools.map((tool, index) => (index === 0
    ? { ...tool, modelName: 'list_tasks', presentation }
    : tool)),
};

describe('the wording the chat UI gets for the tools of a turn', () => {
  it('names every worded tool by its model name, without the question mark of the confirmation', () => {
    expect(toolPresentationOf(worded)).toEqual({
      locale: 'de-DE',
      tools: { list_tasks: { label: 'Aufgaben auflisten' } },
    });
  });

  it('falls back to the tool name when the manifest has no model name', () => {
    const tool = { ...worded.tools[0]!, modelName: undefined };
    expect(Object.keys(toolPresentationOf({ ...worded, tools: [tool] })!.tools)).toEqual([tool.name]);
  });

  it('is nothing for a manifest without wordings', () => {
    expect(toolPresentationOf({ ...worded, tools: worded.tools.map(({ presentation: _dropped, ...tool }) => tool) })).toBeNull();
    expect(toolPresentationOf(undefined)).toBeNull();
  });
});

describe('a managed chat turn', () => {
  const request = () => new Request('https://tasks.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] }] }),
  });
  const model = () => new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Hallo' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ]),
    }),
  });
  const tools = {
    list_tasks: defineTool({
      id: agentRevision.toolAllowlist[0]!,
      description: 'List tasks.',
      inputSchema: z.object({}),
      execute: async () => ({ tasks: [] }),
    }),
  };

  it('sends the wording of its tools ahead of the answer', async () => {
    const handler = createAiChatHandler({
      tools,
      model: model(),
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => principal,
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision: worded, policyRevision, principal, localLimits,
        }),
      },
    });

    const body = await (await handler(request())).text();

    expect(body).toContain('"type":"data-tool-presentation"');
    expect(body).toContain('"list_tasks":{"label":"Aufgaben auflisten"}');
    expect(body.indexOf('data-tool-presentation')).toBeLessThan(body.indexOf('text-delta'));
  });

  it('sends none without a pinned tool state', async () => {
    const handler = createAiChatHandler({ tools: {}, model: model(), systemPrompt: 'Assistant' });

    expect(await (await handler(request())).text()).not.toContain('data-tool-presentation');
  });
});
