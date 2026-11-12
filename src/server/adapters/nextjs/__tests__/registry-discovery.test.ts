import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { StreamHandlerContext } from '../create-ai-chat-handler.js';
import {
  fixtureModelName,
  ROUTING_FIXTURE_SYNONYMS,
  ROUTING_FIXTURE_TOOLS,
} from './fixtures/routing-app-tools.js';

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

describe('default intent routing with discovery and no intentRouter', () => {
  const appRegistry = Object.fromEntries(ROUTING_FIXTURE_TOOLS.map((tool) => [
    fixtureModelName(tool.name),
    defineTool({
      id: tool.name, description: tool.description, method: tool.method,
      inputSchema: z.object({}), execute: async () => ({ ok: true }),
    }),
  ]));

  function conversation(messages: unknown[]) {
    return new Request('https://app.example/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
  }

  async function activeFor(body: Request, extra: Record<string, unknown> = {}) {
    let context: StreamHandlerContext | undefined;
    const handler = createAiChatHandler({
      tools: appRegistry,
      model: {},
      systemPrompt: 'Assistant',
      toolDiscovery: true,
      toolSemantics: ROUTING_FIXTURE_SYNONYMS,
      ...extra,
      streamHandler: async (ctx) => {
        context = ctx;
        return new Response('ok');
      },
    });
    expect((await handler(body)).status).toBe(200);
    return { active: [...context!.toolDiscovery!.activeToolNames()], context: context! };
  }

  it('starts with a small relevant set instead of every tool', async () => {
    const { active, context } = await activeFor(request('Lege eine neue Aufgabe an'));
    expect(active).toContain('tasks_create');
    expect(active).toContain('find_tools');
    expect(active.length).toBeLessThanOrEqual(15);
    // Every eligible tool stays callable through discovery.
    expect(Object.keys(context.tools).length).toBeGreaterThan(100);
  });

  it('keeps the previous turn\'s tool for a follow-up without domain words', async () => {
    const { active } = await activeFor(conversation([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Nur offene Aufgaben mit hoher Priorität' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'tool-ui_tasks_filters_apply', toolCallId: 'c1', state: 'output-available', input: {}, output: { ok: true } },
        { type: 'text', text: 'Erledigt.' },
      ] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'okay aber bitte wieder auf den Filter den wir eben hatten' }] },
    ]));
    expect(active).toContain('ui_tasks_filters_apply');
    expect(active.length).toBeLessThanOrEqual(15);
  });

  it('keeps every tool active with intentRouting: false', async () => {
    const { active } = await activeFor(request('Lege eine neue Aufgabe an'), { intentRouting: false });
    expect(active.length).toBeGreaterThan(100);
  });

  it('accepts tuning options', async () => {
    const { active } = await activeFor(request('Hallo'), {
      intentRouting: { maxStartTools: 2, alwaysAvailable: ['dashboard_get'] },
    });
    expect(active).toEqual(['dashboard_get', 'find_tools']);
  });
});
