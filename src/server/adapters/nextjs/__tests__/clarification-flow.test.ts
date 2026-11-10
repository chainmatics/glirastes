import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatClarificationAnswer } from '../../../../contracts/clarification.js';
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

function clarifyingModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'ask_clarification',
          input: JSON.stringify({
            question: 'Welche Aufgabe soll ich löschen?',
            target: 'object',
            options: [
              { id: 'task-1', label: 'Bericht schreiben' },
              { id: 'task-2', label: 'Release prüfen' },
            ],
          }),
        },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ]),
    }),
  });
}

function answeringModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Erledigt.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ]),
    }),
  });
}

/** First step suggests follow-ups, the second answers and stops. */
function followupModel() {
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
              toolCallId: 'call-f1',
              toolName: 'suggest_followups',
              input: JSON.stringify({ suggestions: ['Zeige erledigte Aufgaben'] }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        };
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hier sind deine Aufgaben.' },
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

describe('structured clarification in the chat handler', () => {
  it('asks inside the normal model step and ends the turn without a planner call', async () => {
    const model = clarifyingModel();
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      clarification: {},
      managedRuntime,
      pipeline: { process: async () => focusedNoMatch },
    });

    const response = await handler(request([{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösche die Aufgabe' }],
    }]));
    const wire = await response.text();

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).toEqual(['ask_clarification']);
    expect(wire).toContain('"toolName":"ask_clarification"');
    expect(wire).toContain('tool-output-available');
    expect(wire).toContain('Welche Aufgabe soll ich löschen?');
    expect(wire).not.toContain('manifest_tool_unavailable');
    expect(wire).not.toContain('tool-output-error');
  });

  it('keeps clarification active next to find_tools for an empty focused selection', async () => {
    let active: string[] = [];
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'Assistant',
      clarification: {}, toolDiscovery: true, managedRuntime,
      pipeline: { process: async () => focusedNoMatch },
      streamHandler: async (context) => {
        active = [...context.toolDiscovery!.activeToolNames()];
        return new Response('ok');
      },
    });
    await handler(request([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hm' }] }]));
    expect(active).toEqual(['ask_clarification', 'find_tools']);
  });

  it('resumes the original request with the answer for routing and the model', async () => {
    const model = answeringModel();
    // Typed parameter: `mock.calls[0]![0]` must typecheck under typecheck:tests.
    const process = vi.fn(async (_userText: string) => ({
      ...focusedNoMatch, tools: ['list_tasks'],
    }));
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      clarification: {},
      managedRuntime,
      maxContextMessages: 1,
      pipeline: { process },
    });

    const response = await handler(request([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösche die Aufgabe' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{
          type: 'tool-ask_clarification',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { question: 'Welche Aufgabe soll ich löschen?', target: 'object' },
          output: { success: true },
        }],
      },
      {
        id: 'u2',
        role: 'user',
        parts: [{
          type: 'text',
          text: formatClarificationAnswer({
            toolCallId: 'call-1', optionId: 'task-1', answer: 'Bericht schreiben',
          }),
        }],
      },
    ]));
    await response.text();

    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]![0]).toBe(
      'Lösche die Aufgabe\nWelche Aufgabe soll ich löschen? Bericht schreiben',
    );
    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('Original request: Lösche die Aufgabe');
    expect(prompt).toContain('Answer: Bericht schreiben');
    expect(prompt).not.toContain('glirastes:clarification');
  });

  it('keeps selected follow-up suggestions callable under the managed guard', async () => {
    const model = followupModel();
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      followups: {},
      toolDiscovery: true,
      managedRuntime,
      pipeline: {
        process: async () => ({
          ...focusedNoMatch, tools: ['suggest_followups'], followupsEnabled: true,
        }),
      },
    });

    const response = await handler(request([{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Zeige meine Aufgaben' }],
    }]));
    const wire = await response.text();

    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name).sort())
      .toEqual(['find_tools', 'suggest_followups']);
    expect(wire).toContain('"toolName":"suggest_followups"');
    expect(wire).toContain('tool-output-available');
    expect(wire).not.toContain('manifest_tool_unavailable');
    expect(wire).not.toContain('tool-output-error');
  });
});

describe('manifest-bound tools named like an SDK built-in', () => {
  const followupToolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a0a';
  const boundManifest = {
    ...manifestRevision,
    tools: [
      ...manifestRevision.tools,
      {
        ...manifestRevision.tools[0]!,
        toolId: followupToolId,
        name: 'suggest_followups',
        description: 'Manifest-bound follow-up suggestions.',
      },
    ],
  };
  const boundAgent = {
    ...agentRevision,
    toolAllowlist: [...agentRevision.toolAllowlist, followupToolId],
  };
  const boundPolicy = {
    ...policyRevision,
    toolPolicies: [
      ...policyRevision.toolPolicies,
      { ...policyRevision.toolPolicies[0]!, toolId: followupToolId },
    ],
  };
  const revocation = {
    revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a0b',
    environmentId: manifestRevision.environmentId,
    effectiveAt: new Date(0).toISOString(),
    reasonCode: 'security-disable',
    toolIds: [followupToolId],
    agentRevisionIds: [],
    policyRevisionIds: [],
    signature: agentRevision.signature,
  };

  it.each([
    { toolDiscovery: false, offered: ['suggest_followups'] },
    { toolDiscovery: true, offered: ['find_tools'] },
  ])(
    'denies a revoked manifest-bound suggest_followups (toolDiscovery: $toolDiscovery)',
    async ({ toolDiscovery, offered }) => {
      const execute = vi.fn(async () => ({ success: true }));
      const onError = vi.fn();
      const model = followupModel();
      const handler = createAiChatHandler({
        tools: {
          ...registry,
          suggest_followups: defineTool({
            id: followupToolId,
            description: 'Manifest-bound follow-up suggestions.',
            inputSchema: z.object({ suggestions: z.array(z.string()) }),
            execute,
          }),
        },
        model,
        systemPrompt: 'Assistant',
        followups: {},
        toolDiscovery,
        onError,
        managedRuntime: {
          resolvePrincipal: async () => principal,
          resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
            turnId,
            agentRevision: boundAgent,
            manifestRevision: boundManifest,
            policyRevision: boundPolicy,
            principal,
            localLimits,
          }),
          loadRevocations: async () => [revocation],
        },
        pipeline: {
          process: async () => ({
            ...focusedNoMatch, tools: ['suggest_followups'], followupsEnabled: true,
          }),
        },
      });

      const response = await handler(request([{
        id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Zeige meine Aufgaben' }],
      }]));
      const wire = await response.text();

      expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).toEqual(offered);
      expect(wire).toContain('"toolName":"suggest_followups"');
      expect(wire).not.toContain('tool-output-available');
      expect(execute).not.toHaveBeenCalled();
      expect(String(onError.mock.calls[0]?.[0])).toMatch(/Tool execution denied: revoked/);
    },
  );
});
