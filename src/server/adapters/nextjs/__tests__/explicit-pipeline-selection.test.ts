import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type PipelineResult } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';

function request() {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{
      id: 'selection-test', role: 'user', parts: [{ type: 'text', text: 'hello' }],
    }] }),
  });
}

const registry = {
  list_tasks: defineTool({
    id: agentRevision.toolAllowlist[0]!, description: 'List tasks',
    inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
};

const result: PipelineResult = {
  model: { modelId: 'fixture' }, tools: [], sanitizedInput: 'hello',
  intent: { intent: 'ambiguous', confidence: 0 }, module: null, followupsEnabled: false,
};

describe('explicit pipeline selection at the Next.js boundary', () => {
  it.each([false, true])('does not re-expand empty selections (discovery=%s)', async (discovery) => {
    let active: string[] | undefined;
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'Assistant', toolDiscovery: discovery,
      pipeline: { process: async () => ({ ...result, toolSelection: 'explicit' }) },
      managedRuntime: {
        resolvePrincipal: async () => principal,
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision, principal, localLimits,
        }),
      },
      streamHandler: async (context) => {
        active = context.toolDiscovery
          ? [...context.toolDiscovery.activeToolNames()]
          : Object.keys(context.tools);
        return new Response('ok');
      },
    });

    expect((await handler(request())).status).toBe(200);
    expect(active).toEqual(discovery ? ['find_tools'] : []);
  });

  it('preserves the unspecified empty selection of legacy custom pipelines', async () => {
    let active: string[] | undefined;
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'Assistant',
      pipeline: { process: async () => result },
      streamHandler: async (context) => {
        active = Object.keys(context.tools);
        return new Response('ok');
      },
    });
    expect((await handler(request())).status).toBe(200);
    expect(active).toEqual(['list_tasks']);
  });
});
