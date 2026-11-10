import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type PipelineResult } from '../../../../types.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** First step records a plan, the second answers and stops. */
function planningModel() {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-p1',
              toolName: 'update_plan',
              input: JSON.stringify({
                items: [
                  { title: 'Aufgaben suchen', status: 'in_progress' },
                  { title: 'Team anlegen', status: 'pending' },
                ],
              }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        };
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Erledigt.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ]),
      };
    },
  });
}

const registry = {
  list_tasks: defineTool({
    id: agentRevision.toolAllowlist[0]!, description: 'List visible tasks.',
    inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
};

const focusedNoMatch: PipelineResult = {
  model: { modelId: 'fixture' }, tools: [], toolSelection: 'explicit',
  sanitizedInput: '', intent: { intent: 'ambiguous', confidence: 0.2 },
  module: null, followupsEnabled: false,
};

const managedRuntime = {
  resolvePrincipal: async () => principal,
  resolveTurnSnapshot: async ({ turnId }: { turnId: string }) => createTurnSnapshot({
    turnId, agentRevision, manifestRevision, policyRevision, principal, localLimits,
  }),
};

function request(messages: unknown[]) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

describe('built-in plan tool in the chat handler', () => {
  it('stays unavailable without planning config', async () => {
    const model = planningModel();
    const handler = createAiChatHandler({
      tools: registry, model, systemPrompt: 'Assistant', managedRuntime,
      pipeline: { process: async () => ({ ...focusedNoMatch, tools: ['list_tasks'] }) },
    });
    const response = await handler(request([{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }],
    }]));
    await response.text();
    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).not.toContain('update_plan');
  });

  it('records the plan and lets the turn continue', async () => {
    const model = planningModel();
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      planning: {},
      managedRuntime,
      pipeline: { process: async () => focusedNoMatch },
    });

    const response = await handler(request([{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Suche Aufgaben und lege ein Team an' }],
    }]));
    const wire = await response.text();

    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).toEqual(['update_plan']);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(wire).toContain('"toolName":"update_plan"');
    expect(wire).toContain('tool-output-available');
    expect(wire).toContain('Erledigt.');
    expect(wire).not.toContain('manifest_tool_unavailable');
    expect(wire).not.toContain('tool-output-error');
  });

  it('keeps the plan tool active next to find_tools', async () => {
    let active: string[] = [];
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'Assistant',
      planning: {}, clarification: {}, toolDiscovery: true, managedRuntime,
      pipeline: { process: async () => focusedNoMatch },
      streamHandler: async (context) => {
        active = [...context.toolDiscovery!.activeToolNames()];
        return new Response('ok');
      },
    });
    await handler(request([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hm' }] }]));
    expect(active).toEqual(['ask_clarification', 'find_tools', 'update_plan']);
  });
});
