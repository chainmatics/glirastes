import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { StreamHandlerContext } from '../create-ai-chat-handler.js';

const registry = {
  list_tasks: defineTool({
    id: 'tasks.list', description: 'List visible tasks.',
    inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
  create_task: defineTool({
    id: 'tasks.create', description: 'Create a task.',
    inputSchema: z.object({}), execute: async () => ({ created: true }),
  }),
};

function request(text: string) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{
      id: 'registry-discovery', role: 'user', parts: [{ type: 'text', text }],
    }] }),
  });
}

describe('find_tools without a runtime source (registry mode)', () => {
  it('exposes discovery over the deployed registry and activates by synonym', async () => {
    let context: StreamHandlerContext | undefined;
    const handler = createAiChatHandler({
      tools: registry,
      model: {},
      systemPrompt: 'Assistant',
      toolDiscovery: true,
      toolSemantics: { create_task: { synonyms: ['Aufgabe anlegen'] } },
      intentRouter: async () => ({ toolNames: ['list_tasks'] }),
      streamHandler: async (ctx) => {
        context = ctx;
        return new Response('ok');
      },
    });

    expect((await handler(request('Bitte eine Aufgabe anlegen'))).status).toBe(200);
    expect(context?.toolDiscovery?.activeToolNames()).toEqual(['find_tools', 'list_tasks']);
    const findTools = context!.tools.find_tools as {
      execute(input: unknown): Promise<{ tools: Array<{ name: string }> }>;
    };
    const found = await findTools.execute({ query: 'Aufgabe anlegen' });
    expect(found.tools.map((tool) => tool.name)).toEqual(['create_task']);
    expect(context?.toolDiscovery?.activeToolNames())
      .toEqual(['create_task', 'find_tools', 'list_tasks']);
  });

  it('never indexes SDK built-in tool names as domain capabilities', async () => {
    let context: StreamHandlerContext | undefined;
    const handler = createAiChatHandler({
      tools: {
        ...registry,
        suggest_followups: defineTool({
          id: 'sdk.followups', description: 'Suggest follow-up prompts for tasks.',
          inputSchema: z.object({}), execute: async () => ({ suggestions: [] }),
        }),
      },
      model: {},
      systemPrompt: 'Assistant',
      toolDiscovery: true,
      streamHandler: async (ctx) => {
        context = ctx;
        return new Response('ok');
      },
    });

    await handler(request('Aufgaben'));
    const findTools = context!.tools.find_tools as {
      execute(input: unknown): Promise<{ tools: Array<{ name: string }> }>;
    };
    const found = await findTools.execute({ query: 'follow-up prompts for tasks' });
    expect(found.tools.map((tool) => tool.name)).not.toContain('suggest_followups');
    expect(context?.toolDiscovery?.activeToolNames()).not.toContain('suggest_followups');
  });

  it('keeps static scoping when discovery is disabled', async () => {
    let names: string[] = [];
    const handler = createAiChatHandler({
      tools: registry,
      model: {},
      systemPrompt: 'Assistant',
      intentRouter: async () => ({ toolNames: ['list_tasks'] }),
      streamHandler: async (ctx) => {
        names = Object.keys(ctx.tools);
        return new Response('ok');
      },
    });
    await handler(request('Liste'));
    expect(names).toEqual(['list_tasks']);
  });
});
