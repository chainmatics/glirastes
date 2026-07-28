import { describe, expect, it, vi } from 'vitest';
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

const tools = {
  list_tasks: defineTool({
    id: 'tasks.list',
    description: 'List tasks.',
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    execute: async () => ({ tasks: [] }),
  }),
};

function request() {
  return new Request('https://tasks.example/api/ai/chat-v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Zeige meine Aufgaben' }],
      }],
    }),
  });
}

describe('createAiChatHandler managed runtime', () => {
  it('fails closed before streaming when no verified principal exists', async () => {
    const streamHandler = vi.fn(async () => new Response('unexpected'));
    const handler = createAiChatHandler({
      tools,
      model: {},
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => undefined,
        resolveTurnSnapshot: async () => {
          throw new Error('must not resolve a snapshot');
        },
      },
      streamHandler,
    });

    const response = await handler(request());

    expect(response.status).toBe(401);
    expect(streamHandler).not.toHaveBeenCalled();
  });

  it('pins one snapshot and exposes its guard to the stream handler', async () => {
    const resolvePrincipal = vi.fn(async () => principal);
    const resolveTurnSnapshot = vi.fn(async ({ turnId }: { turnId: string }) =>
      createTurnSnapshot({
        turnId,
        agentRevision,
        manifestRevision,
        policyRevision,
        principal,
        localLimits,
      }));
    const streamHandler = vi.fn(async (context) => {
      expect(context.managedTurn?.snapshot.turnId).toBe('ai-message-1');
      await context.managedTurn?.beforeToolCall({
        toolName: 'list_tasks',
        input: {},
      });
      return new Response('ok');
    });
    const handler = createAiChatHandler({
      tools,
      model: {},
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal,
        resolveTurnSnapshot,
      },
      streamHandler,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(resolveTurnSnapshot).toHaveBeenCalledTimes(1);
    expect(resolvePrincipal).toHaveBeenCalledTimes(2);
    expect(streamHandler).toHaveBeenCalledTimes(1);
  });

  it('loads dynamic tools from the snapshot pinned for this turn', async () => {
    let loadedSnapshot: unknown;
    const loadTools = vi.fn((context) => {
      loadedSnapshot = (
        context as typeof context & { turnSnapshot?: unknown }
      ).turnSnapshot;
      return tools;
    });
    const handler = createAiChatHandler({
      loadTools,
      model: {},
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => principal,
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId,
          agentRevision,
          manifestRevision,
          policyRevision,
          principal,
          localLimits,
        }),
      },
      streamHandler: async () => new Response('ok'),
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadedSnapshot).toMatchObject({
      turnId: 'ai-message-1',
      manifestRevision: { revisionId: manifestRevision.revisionId },
    });
  });

  it('preserves a revision-bound followup tool already in the registry', async () => {
    const revisionBoundTools = {
      ...tools,
      suggest_followups: defineTool({
        id: 'published-followup-id',
        description: 'Published followup description.',
        inputSchema: {
          safeParse: (value: unknown) => ({
            success: true as const,
            data: value,
          }),
        },
        execute: async () => ({ success: true }),
      }),
    };
    const streamHandler = vi.fn(async ({ tools: aiTools }) => {
      expect((
        aiTools.suggest_followups as { description?: string }
      ).description).toBe('Published followup description.');
      return new Response('ok');
    });
    const handler = createAiChatHandler({
      tools: revisionBoundTools,
      pipeline: {
        process: async () => ({
          model: { modelId: 'test', instance: {} },
          tools: ['suggest_followups'],
          sanitizedInput: 'show tasks',
          intent: { intent: 'task_query', confidence: 1 },
          module: null,
          followupsEnabled: true,
        }),
      },
      followups: { enabled: true },
      systemPrompt: 'Assistant',
      streamHandler,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(streamHandler).toHaveBeenCalledTimes(1);
  });

  it('rejects a snapshot pinned for a different subject', async () => {
    const handler = createAiChatHandler({
      tools,
      model: {},
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => principal,
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId,
          agentRevision,
          manifestRevision,
          policyRevision,
          principal: { ...principal, subjectId: 'other-user' },
          localLimits,
        }),
      },
      streamHandler: async () => new Response('unexpected'),
    });

    const response = await handler(request());

    expect(response.status).toBe(403);
  });
});
