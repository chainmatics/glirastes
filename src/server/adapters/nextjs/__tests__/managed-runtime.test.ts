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
  it('exposes turn-pinned hybrid discovery to a custom stream handler', async () => {
    const revisionBoundTools = {
      list_tasks: defineTool({
        id: agentRevision.toolAllowlist[0]!,
        description: 'List visible tasks.',
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        execute: async () => ({ tasks: [] }),
      }),
    };
    const streamHandler = vi.fn(async (context) => {
      expect(context.toolDiscovery?.turnId).toBe('ai-message-1');
      expect(Object.keys(context.tools).sort()).toEqual([
        'find_tools',
        'list_tasks',
      ]);
      const findTools = context.tools.find_tools as {
        execute(input: unknown): Promise<{ tools: Array<{ name: string }> }>;
      };
      const found = await findTools.execute({ query: 'list' });
      expect(found.tools.map((tool) => tool.name)).toEqual(['list_tasks']);
      expect(context.toolDiscovery?.activeToolNames()).toEqual([
        'find_tools',
        'list_tasks',
      ]);
      return new Response('ok');
    });
    const handler = createAiChatHandler({
      tools: revisionBoundTools,
      model: {},
      systemPrompt: 'Assistant',
      toolDiscovery: true,
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
      streamHandler,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(streamHandler).toHaveBeenCalledTimes(1);
  });

  describe('on a turn whose snapshot was pinned for other roles', () => {
    const revisionBoundTools = {
      list_tasks: defineTool({
        id: agentRevision.toolAllowlist[0]!,
        description: 'List visible tasks.',
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        execute: async () => ({ tasks: [] }),
      }),
    };
    /** The snapshot a runtime pinned when the turn started with the `admin` role. */
    const pinned = createTurnSnapshot({
      turnId: 'ai-message-1', agentRevision, manifestRevision, policyRevision, principal, localLimits,
    });

    async function offered(options: {
      roles: string[];
      revokedToolIds?: string[];
      pinned?: typeof pinned;
    }) {
      const turn = options.pinned ?? pinned;
      const seen: {
        roles?: ReadonlyArray<string>;
        promptRoles?: ReadonlyArray<string>;
        active?: ReadonlyArray<string>;
        found?: ReadonlyArray<string>;
      } = {};
      const handler = createAiChatHandler({
        tools: revisionBoundTools,
        model: {},
        systemPrompt: ({ turnSnapshot }) => {
          seen.promptRoles = turnSnapshot?.principal.roles;
          return 'Assistant';
        },
        toolDiscovery: true,
        managedRuntime: {
          resolvePrincipal: async () => ({ ...principal, roles: options.roles }),
          resolveTurnSnapshot: async () => turn,
          loadRevocations: async () => (options.revokedToolIds ? [{
            revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a09',
            environmentId: manifestRevision.environmentId,
            effectiveAt: '2026-07-28T20:00:00.000Z',
            reasonCode: 'incident',
            toolIds: options.revokedToolIds,
            agentRevisionIds: [],
            policyRevisionIds: [],
            signature: { algorithm: 'Ed25519' as const, keyId: 'key-1', value: 'c2lnbmF0dXJl' },
          }] : []),
        },
        streamHandler: async (context) => {
          seen.roles = context.managedTurn?.snapshot.principal.roles;
          const findTools = context.tools.find_tools as {
            execute(input: unknown): Promise<{ tools: Array<{ name: string }> }>;
          };
          seen.found = (await findTools.execute({ query: 'list' })).tools.map((tool) => tool.name);
          seen.active = context.toolDiscovery?.activeToolNames();
          expect(context.managedTurn?.snapshot.manifestRevision).toEqual(turn.manifestRevision);
          expect(context.managedTurn?.snapshot.startedAt).toBe(turn.startedAt);
          return new Response('ok');
        },
      });
      expect((await handler(request())).status).toBe(200);
      return seen;
    }

    it('offers and finds only the tools the current roles allow', async () => {
      expect(await offered({ roles: ['viewer'] })).toEqual({
        roles: ['viewer'], promptRoles: ['viewer'], active: ['find_tools'], found: [],
      });
      expect(await offered({ roles: ['admin'] })).toEqual({
        roles: ['admin'], promptRoles: ['admin'], active: ['find_tools', 'list_tasks'], found: ['list_tasks'],
      });
    });

    it('takes a role the principal gained into account', async () => {
      const viewerPinned = createTurnSnapshot({
        turnId: 'ai-message-1', agentRevision, manifestRevision, policyRevision,
        principal: { ...principal, roles: ['viewer'] }, localLimits,
      });
      expect(await offered({ roles: ['viewer', 'admin'], pinned: viewerPinned })).toEqual({
        roles: ['viewer', 'admin'], promptRoles: ['viewer', 'admin'], active: ['find_tools', 'list_tasks'], found: ['list_tasks'],
      });
    });

    it('neither offers nor finds a revoked tool', async () => {
      expect(await offered({ roles: ['admin'], revokedToolIds: [agentRevision.toolAllowlist[0]!] })).toEqual({
        roles: ['admin'], promptRoles: ['admin'], active: ['find_tools'], found: [],
      });
    });
  });

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

  it('assembles the system prompt against the snapshot pinned for this turn', async () => {
    const seen: Array<string | undefined> = [];
    const handler = createAiChatHandler({
      tools,
      model: {},
      systemPrompt: (context) => {
        seen.push(context.turnSnapshot?.turnId);
        return 'Assistant';
      },
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
    expect(seen).toEqual(['ai-message-1']);
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

  it('handles an asynchronously rejected pipeline stream', async () => {
    const streamFailure = new Error('stream failed');
    const onError = vi.fn();
    const handler = createAiChatHandler({
      tools,
      pipeline: {
        process: async () => ({
          model: { modelId: 'test', instance: {} },
          tools: ['list_tasks'],
          sanitizedInput: 'show tasks',
          intent: { intent: 'task_query', confidence: 1 },
          module: null,
          followupsEnabled: false,
        }),
      },
      systemPrompt: 'Assistant',
      streamHandler: async () => {
        throw streamFailure;
      },
      onError,
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'AI request failed',
    });
    expect(onError).toHaveBeenCalledWith(streamFailure, expect.any(Request));
  });
});
