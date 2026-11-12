import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler, withCacheBreakpoints } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function capturingModel() {
  const calls: Array<{ prompt: Array<Record<string, unknown>>; tools?: Array<{ name: string }> }> = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls.push(options as never);
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Okay.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] as never),
      };
    },
  });
  return { model, calls };
}

const tool = (id: string, description: string) => defineTool({
  id, description, inputSchema: z.object({}), execute: async () => ({ ok: true }),
});

const registry = {
  admin_audit: tool('admin.audit', 'Show the audit log.'),
  tasks_create: tool('tasks.create', 'Create a task.'),
  teams_list: tool('teams.list', 'List teams.'),
  ui_navigate: tool('ui.navigate', 'Go to a page of the app.'),
};

function request(text: string) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
  });
}

describe('prompt caching', () => {
  it('marks the system prompt and the newest message as cache breakpoints', async () => {
    const { model, calls } = capturingModel();
    await (await createAiChatHandler({ tools: registry, model, systemPrompt: 'Static app prompt.' })(request('Hallo'))).text();

    const prompt = calls[0]!.prompt;
    expect(prompt[0]).toMatchObject({
      role: 'system',
      content: 'Static app prompt.',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(prompt.at(-1)).toMatchObject({
      role: 'user',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('sends the active tools first and in a stable order', async () => {
    const { model, calls } = capturingModel();
    const handler = createAiChatHandler({
      tools: registry, model, systemPrompt: 'Static app prompt.', toolDiscovery: true,
    });
    await (await handler(request('Create a task'))).text();
    await (await handler(request('Create a task'))).text();

    const names = calls.map((call) => (call.tools ?? []).map((entry) => entry.name));
    expect(names[0]).toEqual(names[1]);
    expect(names[0]![0]).toBe('find_tools');
    expect(names[0]).toContain('tasks_create');
  });

  it('merges the breakpoint into provider options the message already has', () => {
    const [, last] = withCacheBreakpoints('S', [{
      role: 'user',
      content: [{ type: 'text', text: 'Hallo' }],
      providerOptions: {
        anthropic: { sendReasoning: false },
        openrouter: { reasoning: { effort: 'low' } },
        openai: { store: false },
      },
    }]) as Array<{ providerOptions: Record<string, unknown> }>;
    expect(last!.providerOptions).toEqual({
      anthropic: { sendReasoning: false, cacheControl: { type: 'ephemeral' } },
      openrouter: { reasoning: { effort: 'low' }, cacheControl: { type: 'ephemeral' } },
      openai: { store: false },
    });
  });

  it('can be switched off', async () => {
    const { model, calls } = capturingModel();
    await (await createAiChatHandler({
      tools: registry, model, systemPrompt: 'Static app prompt.', promptCaching: false,
    })(request('Hallo'))).text();
    expect(JSON.stringify(calls[0]!.prompt)).not.toContain('cacheControl');
  });
});
