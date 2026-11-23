import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { uiActionToolToTool } from '../../../core/index.js';
import { createJsonSchemaLike } from '../../../../runtime/json-schema.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import type { ExecutionBudget } from '../../../../contracts/index.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';
import {
  agentRevision, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision, principal, streamChunks,
} from './command-fixtures.js';

/**
 * The handler writes the step reports and the final pipeline state from the
 * step and finish callbacks of `streamText`. Where they land relative to the
 * model's `finish` part used to depend on the scheduler. Here the callbacks
 * take a timer tick (as a slow budget check or app callback would), which
 * puts them after `finish` on code that does not sequence them. Covers the
 * end paths through the whole handler; `side-part-order.test.ts` covers the
 * sequencer itself.
 */
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const later = <A extends unknown[], R>(callback: ((...args: A) => R) | undefined) => callback
    ? async (...args: A) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return callback(...args);
    }
    : undefined;
  return {
    ...actual,
    streamText: (options: Parameters<typeof actual.streamText>[0]) => actual.streamText({
      ...options,
      onStepFinish: later(options.onStepFinish),
      onFinish: later(options.onFinish),
    } as Parameters<typeof actual.streamText>[0]),
  };
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type Call = { toolName: string; input?: Record<string, unknown> };

/** One model step per entry: tool calls, or (for a string) a text answer. */
function scriptedModel(...steps: Array<Call[] | string>) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[call] ?? 'Done.';
      call += 1;
      return {
        stream: convertArrayToReadableStream((typeof step === 'string'
          ? [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: `t${call}` },
            { type: 'text-delta', id: `t${call}`, delta: step },
            { type: 'text-end', id: `t${call}` },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            ...step.map((tool, index) => ({
              type: 'tool-call',
              toolCallId: `call-${call}-${index}`,
              toolName: tool.toolName,
              input: JSON.stringify(tool.input ?? {}),
            })),
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]) as never),
      };
    },
  });
}

const registry: ToolRegistry = {
  tasks_list: defineTool({
    id: LIST_TASKS_ID,
    description: 'List tasks.',
    inputSchema: z.object({}),
    execute: async () => ({ success: true, tasks: [{ id: 't1', name: 'Release' }] }),
  }),
  tasks_delete: defineTool({
    id: 'tasks.delete',
    description: 'Delete a task.',
    inputSchema: z.object({ id: z.string() }),
    needsApproval: true,
    execute: async () => ({ success: true }),
  }),
  ui_navigate: uiActionToolToTool({
    id: 'ui.navigate',
    toolName: 'ui_navigate',
    description: 'Open a page of the app.',
    inputSchema: createJsonSchemaLike({ type: 'object', properties: { destination: { type: 'string' } } }),
    needsApproval: false,
    action: { kind: 'navigate' },
  }),
};

const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] };

async function turn(
  model: MockLanguageModelV3,
  options: { config?: Partial<AiChatHandlerFullConfig>; body?: Record<string, unknown>; messages?: unknown[] } = {},
) {
  const handler = createAiChatHandler({
    tools: registry,
    systemPrompt: 'Assistant',
    approvalSecret: 'stream-end-order-test-secret-32-chars!!',
    ...options.config,
    model,
  });
  return streamChunks(await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: options.messages ?? [user], ...options.body }),
  })));
}

/** The handler options of a managed runtime turn with these limits. */
function managed(limits: Partial<ExecutionBudget>): Partial<AiChatHandlerFullConfig> {
  return {
    onError: () => undefined,
    managedRuntime: {
      resolvePrincipal: async () => principal(),
      resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
        turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
        localLimits: { ...localLimits, ...limits },
      }),
      loadRevocations: async () => [],
    },
  } as Partial<AiChatHandlerFullConfig>;
}

/**
 * `finish` is the last part and comes once; every step report sits right
 * before a `finish-step`; the final (persistent) pipeline state comes after
 * the last `finish-step` and before `finish`.
 */
function expectTrailingPartsBeforeFinish(chunks: Array<Record<string, unknown>>, steps: number) {
  const types = chunks.map((chunk) => chunk.type);
  expect(types.at(-1)).toBe('finish');
  expect(types.filter((type) => type === 'finish')).toHaveLength(1);
  const reports = types.flatMap((type, index) => (type === 'data-step-report' ? [index] : []));
  expect(reports).toHaveLength(steps);
  for (const index of reports) expect(types[index + 1]).toBe('finish-step');
  const stateAt = types.lastIndexOf('data-pipeline-state');
  expect(chunks[stateAt]!.transient).toBe(false);
  expect(stateAt).toBeGreaterThan(types.lastIndexOf('finish-step'));
  return chunks[stateAt]!.data as Record<string, unknown>;
}

describe('the end of the chat stream', () => {
  it('writes the final state before finish for an answer without a tool call', async () => {
    const chunks = await turn(scriptedModel('Hello.'));
    expect(expectTrailingPartsBeforeFinish(chunks, 1)).toMatchObject({ status: 'completed', totalSteps: 1 });
  });

  it('writes every step report and the final state before finish for a turn with several steps', async () => {
    const chunks = await turn(scriptedModel([{ toolName: 'tasks_list' }], [{ toolName: 'tasks_list' }], 'Two lists.'));
    expect(expectTrailingPartsBeforeFinish(chunks, 3)).toMatchObject({ status: 'completed', totalSteps: 3 });
  });

  it('writes the final state before finish when the turn pauses for an approval', async () => {
    const chunks = await turn(scriptedModel([{ toolName: 'tasks_delete', input: { id: 't1' } }]));
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
    expectTrailingPartsBeforeFinish(chunks, 1);
  });

  it('writes the final state before finish when the turn ends for a UI outcome', async () => {
    const chunks = await turn(
      scriptedModel([{ toolName: 'ui_navigate', input: { destination: '/tasks' } }], 'Should not run.'),
      { body: { glirastesUiOutcomes: 1 } },
    );
    expect(expectTrailingPartsBeforeFinish(chunks, 1)).toMatchObject({ status: 'completed', totalSteps: 1 });
  });

  it('writes the final state before finish in the continuation after a reported outcome', async () => {
    const history = [user, {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'step-start' }, {
        type: 'tool-ui_navigate',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { destination: '/tasks' },
        output: { success: true, awaitsOutcome: true, outcome: { v: 1, code: 'ok', at: 1 } },
      }],
    }];
    const chunks = await turn(scriptedModel('It is open.'), { body: { glirastesUiOutcomes: 1 }, messages: history });
    expect(expectTrailingPartsBeforeFinish(chunks, 1)).toMatchObject({ status: 'completed' });
  });

  it('writes the closing notice and the final state before finish at the step cap', async () => {
    const chunks = await turn(
      scriptedModel([{ toolName: 'tasks_list' }], [{ toolName: 'tasks_list' }], 'Should not run.'),
      { config: { maxSteps: 2 } },
    );
    expect(chunks.some((chunk) => chunk.type === 'text-start' && chunk.id === 'glirastes-stop-notice')).toBe(true);
    expect(expectTrailingPartsBeforeFinish(chunks, 2)).toMatchObject({ message: 'Paused at configured step cap.' });
  });

  it('writes the error state before finish when the model step fails', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: new Error('provider down') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage },
        ] as never),
      }),
    });
    const chunks = await turn(model);
    const types = chunks.map((chunk) => chunk.type);
    const finishAt = types.lastIndexOf('finish');
    const stateAt = types.lastIndexOf('data-pipeline-state');
    expect(stateAt).toBeGreaterThan(-1);
    if (finishAt > -1) expect(stateAt).toBeLessThan(finishAt);
    expect(chunks.filter((chunk) => chunk.type === 'data-pipeline-state').at(-1)!.data).toMatchObject({ status: 'error' });
  });

  it('writes the closing notice and the final state before finish at the runtime step budget', async () => {
    const chunks = await turn(
      scriptedModel([{ toolName: 'tasks_list' }], [{ toolName: 'tasks_list' }], 'Should not run.'),
      { config: managed({ maxModelSteps: 2 }) },
    );
    expect(chunks.some((chunk) => chunk.type === 'text-start' && chunk.id === 'glirastes-stop-notice')).toBe(true);
    expect(expectTrailingPartsBeforeFinish(chunks, 2)).toMatchObject({ status: 'safety-stop' });
  });

  it('writes the aborted state before abort when the turn time limit stops the model call', async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        call += 1;
        if (call > 1) await new Promise((resolve) => setTimeout(resolve, 400));
        options.abortSignal?.throwIfAborted();
        return scriptedModel([{ toolName: 'tasks_list' }]).doStream(options);
      },
    });
    const chunks = await turn(model, { config: managed({ totalTimeoutMs: 150 }) });
    const types = chunks.map((chunk) => chunk.type);
    expect(types.at(-1)).toBe('abort');
    expect(types.filter((type) => type === 'abort')).toHaveLength(1);
    expect(types).not.toContain('finish');
    const stateAt = types.lastIndexOf('data-pipeline-state');
    expect(chunks[stateAt]!.data).toMatchObject({ status: 'aborted' });
    // The first step finished before the time limit: its report sits right before its finish-step.
    const reports = types.flatMap((type, index) => (type === 'data-step-report' ? [index] : []));
    expect(reports).toHaveLength(1);
    expect(types[reports[0]! + 1]).toBe('finish-step');
    expect(stateAt).toBeGreaterThan(reports[0]!);
  });
});
