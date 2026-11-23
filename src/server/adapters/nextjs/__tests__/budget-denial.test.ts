import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ExecutionBudget, SecurityRevocation } from '../../../../contracts/index.js';
import { ToolExecutionDeniedError } from '../../../../runtime/tool-denial.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { AiChatHandlerConfig } from '../types.js';
import {
  agentRevision, collectingSink, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision, principal, streamChunks,
} from './command-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** One model step that calls `tasks_list` `count` times in parallel. */
const parallelListStep = (count: number) => () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  ...Array.from({ length: count }, (_, index) => ({
    type: 'tool-call', toolCallId: `call-${index}`, toolName: 'tasks_list', input: JSON.stringify({ query: `q${index}` }),
  })),
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
] as never);
const textStep = () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Final answer.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
] as never);

const BUDGET_TEXT = 'Tool call not executed: the limit of 3 tool calls per turn is reached (3 used). '
  + 'Do not retry in this turn; tell the user which requests are still open.';

async function runTurn(options: {
  limits?: Partial<ExecutionBudget>;
  steps: Array<() => ReadableStream>;
  list?: () => Promise<unknown>;
  config?: Partial<AiChatHandlerConfig>;
  revocations?: SecurityRevocation[];
}) {
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: options.steps[Math.min(call++, options.steps.length - 1)]!() }),
  });
  const list = vi.fn(options.list ?? (async () => ({ tasks: [] })));
  const registry: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list', description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(), execute: list,
    }),
  };
  const { sink, events } = collectingSink();
  const onError = vi.fn();
  const handler = createAiChatHandler({
    tools: registry,
    model,
    systemPrompt: 'Assistant',
    metrics: sink,
    onError,
    resultHandles: false,
    managedRuntime: {
      resolvePrincipal: async () => principal(),
      resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
        turnId,
        agentRevision,
        manifestRevision,
        policyRevision: policyRevision(),
        principal: principal(),
        localLimits: { ...localLimits, ...options.limits },
      }),
      loadRevocations: async () => options.revocations ?? [],
    },
    ...options.config,
  });
  const request = new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] }] }),
  });
  const chunks = await streamChunks(await handler(request));
  return { chunks, model, list, onError, events, request };
}

/** The tool results the model received in the given call. */
function toolResults(model: MockLanguageModelV3, call: number) {
  return (model.doStreamCalls[call]?.prompt ?? [])
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as Array<{ toolCallId: string; output: unknown }>);
}

describe('a tool call denied by the turn budget', () => {
  it('tells the model the limit and the use, and the chat the reached limit', async () => {
    const turn = await runTurn({ limits: { maxToolCalls: 3 }, steps: [parallelListStep(5), textStep] });

    expect(turn.list).toHaveBeenCalledTimes(3);
    const results = toolResults(turn.model, 1);
    expect(results.filter((result) => (result.output as { type: string }).type === 'json')).toHaveLength(3);
    expect(results.filter((result) => (result.output as { type: string }).type === 'error-text').map((result) => result.output))
      .toEqual([{ type: 'error-text', value: BUDGET_TEXT }, { type: 'error-text', value: BUDGET_TEXT }]);

    const failed = turn.chunks.filter((chunk) => chunk.type === 'tool-output-error');
    expect(failed.map((chunk) => chunk.errorText)).toEqual([
      'Tool call limit for this turn reached (3).',
      'Tool call limit for this turn reached (3).',
    ]);
    expect(JSON.stringify(turn.chunks)).not.toContain('AI request failed');
  });

  it('reports each denied call once to onError, marked as a tool call failure', async () => {
    const turn = await runTurn({ limits: { maxToolCalls: 3 }, steps: [parallelListStep(5), textStep] });

    expect(turn.onError).toHaveBeenCalledTimes(2);
    for (const [error, req, info] of turn.onError.mock.calls) {
      expect(error).toBeInstanceOf(ToolExecutionDeniedError);
      expect(error).toMatchObject({
        reason: 'budget_exhausted',
        recoverable: false,
        budget: [{ dimension: 'maxToolCalls', limit: 3, used: 3 }],
      });
      expect(req).toBeInstanceOf(Request);
      expect(info).toEqual({ source: 'tool-call', kind: 'denied' });
    }
    expect(new Set(turn.onError.mock.calls.map(([error]) => error)).size).toBe(2);
  });

  it('still ends the turn at the budget with one tool-free final step', async () => {
    const turn = await runTurn({ limits: { maxToolCalls: 3 }, steps: [parallelListStep(5), textStep] });

    expect(turn.model.doStreamCalls).toHaveLength(2);
    expect(turn.model.doStreamCalls[1]!.toolChoice).toEqual({ type: 'none' });
    expect(turn.events[0]).toMatchObject({ status: 'safety-stop', errorCode: 'budget_exhausted', toolCallCount: 5 });
  });

  it('keeps the stream intact when the app\'s onError throws', async () => {
    const throwing = vi.fn(() => { throw new Error('logger down'); });
    const turn = await runTurn({
      limits: { maxToolCalls: 3 }, steps: [parallelListStep(5), textStep], config: { onError: throwing },
    });

    expect(throwing).toHaveBeenCalledTimes(2);
    expect(turn.chunks.filter((chunk) => chunk.type === 'tool-output-error')).toHaveLength(2);
    expect(turn.chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(JSON.stringify(turn.chunks)).toContain('Final answer.');
  });
});

describe('a tool call failing with an error the SDK does not name', () => {
  it('shows the chat only the generic text and reports the cause to onError', async () => {
    const turn = await runTurn({
      limits: { toolTimeoutMs: 20 },
      steps: [parallelListStep(1), textStep],
      list: () => new Promise((resolve) => setTimeout(() => resolve({ tasks: [] }), 500)),
    });

    const failed = turn.chunks.filter((chunk) => chunk.type === 'tool-output-error');
    expect(failed.map((chunk) => chunk.errorText)).toEqual(['AI request failed']);
    expect(JSON.stringify(turn.chunks)).not.toContain('timed out');
    expect(turn.onError).toHaveBeenCalledTimes(1);
    expect(String(turn.onError.mock.calls[0]![0])).toContain('timed out after 20ms');
    expect(turn.onError.mock.calls[0]![2]).toEqual({ source: 'tool-call', kind: 'failed' });
  });
});

describe('other denials of the managed turn guard', () => {
  it('get a fixed text without the error message', async () => {
    // A principal without the role: a recoverable denial, which the model gets
    // back as its result and which is no failure of the app.
    let call = 0;
    const steps: Array<() => ReadableStream> = [parallelListStep(1), textStep];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: steps[Math.min(call++, 1)]!() }),
    });
    const onError = vi.fn();
    const handler = createAiChatHandler({
      tools: {
        tasks_list: defineTool({
          id: 'tasks.list', description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(),
          execute: async () => ({ tasks: [] }),
        }),
      },
      model,
      systemPrompt: 'Assistant',
      onError,
      resultHandles: false,
      authorizedToolsOnly: false,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision: policyRevision({ listRoles: ['admin'] }),
          principal: principal(), localLimits,
        }),
        loadRevocations: async () => [],
      },
    });
    const chunks = await streamChunks(await handler(new Request('https://app.example/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] }] }),
    })));

    expect(chunks.filter((chunk) => chunk.type === 'tool-output-error').map((chunk) => chunk.errorText))
      .toEqual(['You are not permitted to use this tool.']);
    expect(JSON.stringify(chunks)).not.toContain('principal_role_denied');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('a denial that ends the turn before the tool runs', () => {
  it('reaches the chat as its fixed text and onError once', async () => {
    // A revoked tool fails the approval check: the AI SDK ends the stream with
    // an error part, which its stream hook and the UI error mask both see.
    const revocation: SecurityRevocation = {
      revocationId: '019fb710-0000-7000-8000-0000000000c2',
      environmentId: manifestRevision.environmentId,
      effectiveAt: new Date(0).toISOString(),
      reasonCode: 'security-disable',
      toolIds: [LIST_TASKS_ID],
      agentRevisionIds: [],
      policyRevisionIds: [],
      signature: agentRevision.signature,
    };
    const turn = await runTurn({
      steps: [parallelListStep(1), textStep],
      revocations: [revocation],
      config: { authorizedToolsOnly: false },
    });

    expect(turn.list).not.toHaveBeenCalled();
    expect(turn.chunks.filter((chunk) => chunk.type === 'error').map((chunk) => chunk.errorText))
      .toEqual(['This tool has been disabled.']);
    expect(turn.onError).toHaveBeenCalledTimes(1);
    expect(turn.onError.mock.calls[0]![0]).toMatchObject({ reason: 'revoked' });
    expect(turn.onError.mock.calls[0]).toHaveLength(2);
  });
});
