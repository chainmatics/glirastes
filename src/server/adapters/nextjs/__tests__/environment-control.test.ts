import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../../../contracts/chat-interactions.js';
import type { ManagedTurnControl } from '../../../../runtime/turn-control.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { createChatInteractionsHandler } from '../index.js';
import type { AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';
import type { ManagedLocalRuntimeConfig } from '../types.js';
import { localLimits, principal, snapshot, streamChunks } from './command-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const toolStep = (toolName: string, input: unknown) => () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
] as never);
const textStep = () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Final answer.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
] as never);

function scriptedModel(steps: Array<() => ReadableStream>) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const next = steps[Math.min(call, steps.length - 1)]!;
      call += 1;
      return { stream: next() };
    },
  });
}

function tools(onList?: () => void) {
  const list = vi.fn(async () => { onList?.(); return { tasks: [] }; });
  const archive = vi.fn(async () => ({ success: true, archived: 't1' }));
  const registry: ToolRegistry = {
    tasks_list: defineTool({ id: 'tasks.list', description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(), execute: list }),
    tasks_archive: defineTool({
      id: 'tasks.archive', description: 'Archive a task.', inputSchema: z.object({ id: z.string() }).strict(),
      needsApproval: true, execute: archive,
    }),
  };
  return { registry, list, archive };
}

const enabled: ManagedTurnControl = { assistant: 'enabled' };
const halted: ManagedTurnControl = { assistant: 'halted', code: 'assistant_halted' };

function managed(control: () => ManagedTurnControl, extra: Partial<ManagedLocalRuntimeConfig> = {}): ManagedLocalRuntimeConfig {
  return {
    resolvePrincipal: async () => principal(),
    resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId),
    loadControl: control,
    ...extra,
  };
}

function post(messages: unknown[]): Request {
  return new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
  });
}
const user = (text: string, id = 'u1') => ({ id, role: 'user', parts: [{ type: 'text', text }] });

function handlerWith(model: MockLanguageModelV3, registry: ToolRegistry, managedRuntime: ManagedLocalRuntimeConfig, config: Partial<AiChatHandlerFullConfig> = {}) {
  return createAiChatHandler({
    tools: registry, model, systemPrompt: 'Assistant', resultHandles: false,
    approvalSecret: 'environment-control-secret-32-chars!',
    managedRuntime,
    ...config,
  });
}

describe('environment control in createAiChatHandler', () => {
  it('refuses a halted turn with 503 assistant_halted before anything reaches the model', async () => {
    const model = scriptedModel([textStep]);
    const { registry, list } = tools();
    const resolvePrincipal = vi.fn(async () => principal());
    const response = await handlerWith(model, registry, managed(() => halted, { resolvePrincipal }))(post([user('Show tasks')]));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'assistant_halted' });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('refuses with 503 control_unknown while the control is not known yet', async () => {
    const model = scriptedModel([textStep]);
    const response = await handlerWith(model, tools().registry, managed(() => ({ assistant: 'halted', code: 'control_unknown' })))(post([user('Show tasks')]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'control_unknown' });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('stops a running turn at the next model step after a halt, keeping the tool call that ran', async () => {
    let control: ManagedTurnControl = enabled;
    const model = scriptedModel([toolStep('tasks_list', { query: 'Release' }), textStep]);
    const { registry, list } = tools(() => { control = halted; });
    const onError = vi.fn();
    const response = await handlerWith(model, registry, managed(() => control), { onError })(post([user('Show tasks')]));
    const chunks = await streamChunks(response);

    expect(list).toHaveBeenCalledTimes(1);
    expect(chunks.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({ toolCallId: 'call-1' });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(chunks.find((chunk) => chunk.type === 'error')).toEqual({ type: 'error', errorText: 'The assistant is halted.' });
    expect(JSON.stringify(chunks)).not.toContain('Final answer.');
  });

  it('refuses the next tool call after a halt mid-step', async () => {
    let control: ManagedTurnControl = enabled;
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        control = halted;
        return { stream: toolStep('tasks_list', { query: 'Release' })() as never };
      },
    });
    const { registry, list } = tools();
    const chunks = await streamChunks(await handlerWith(model, registry, managed(() => control))(post([user('Show tasks')])));

    expect(modelCalls).toBe(1);
    expect(list).not.toHaveBeenCalled();
    // The approval check of the call refuses it, which ends the turn visibly.
    expect(chunks.find((chunk) => chunk.type === 'error')).toEqual({ type: 'error', errorText: 'The assistant is halted.' });
    expect(chunks.some((chunk) => chunk.type === 'tool-output-available')).toBe(false);
  });

  it('refuses approval continuations and direct commands while halted', async () => {
    let control: ManagedTurnControl = enabled;
    const model = scriptedModel([textStep]);
    const { registry, archive, list } = tools();
    const handler = handlerWith(model, registry, managed(() => control));
    const archiveCommand = formatChatCommandMessage({
      commandId: 'task.tasks.archive', tool: 'tasks.archive', args: { id: 't1' }, label: '/Archive',
    });
    const first = await streamChunks(await handler(post([user(archiveCommand)])));
    const request = first.find((chunk) => chunk.type === 'tool-approval-request')!;
    expect(request).toBeDefined();

    control = halted;
    const answer = {
      id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
        type: 'tool-tasks_archive', toolCallId: request.toolCallId, state: 'approval-responded',
        input: { id: 't1' }, approval: { id: request.approvalId, approved: true },
      }],
    };
    const continued = await handler(post([user(archiveCommand), answer]));
    expect(continued.status).toBe(503);
    expect(await continued.json()).toEqual({ error: 'assistant_halted' });

    const listCommand = formatChatCommandMessage({
      commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks',
    });
    expect((await handler(post([user(listCommand)]))).status).toBe(503);
    expect(archive).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('lowers the turn budget to the ceiling, never above the local one', async () => {
    const budgets: unknown[] = [];
    const run = async (control: ManagedTurnControl) => {
      const handler = handlerWith(scriptedModel([textStep]), tools().registry, managed(() => control), {
        streamHandler: async (context) => {
          budgets.push(context.managedTurn?.snapshot.budget);
          return new Response('ok');
        },
      });
      expect((await handler(post([user('Show tasks')]))).status).toBe(200);
    };
    await run({ assistant: 'enabled', budgetCeiling: { maxToolCalls: 2, maxEstimatedCostUsd: 0.25 } });
    await run({ assistant: 'enabled', budgetCeiling: { maxToolCalls: 999, maxModelSteps: 999 } });
    expect(budgets).toEqual([
      { ...localLimits, maxToolCalls: 2, maxEstimatedCostUsd: 0.25 },
      localLimits,
    ]);
  });

  it('refuses a turn the rate limit does not admit with 429 turn_rate_limited', async () => {
    const model = scriptedModel([textStep]);
    const admitTurn = vi.fn(() => ({ admitted: false as const, retryAfterMs: 1_500 }));
    const response = await handlerWith(model, tools().registry, managed(() => enabled, { admitTurn }))(post([user('Show tasks')]));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({ error: 'turn_rate_limited' });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(admitTurn).toHaveBeenCalledWith(expect.objectContaining({ principal: principal() }));
  });

  it('runs unchanged without a control loader', async () => {
    const model = scriptedModel([textStep]);
    const chunks = await streamChunks(await handlerWith(model, tools().registry, {
      resolvePrincipal: async () => principal(),
      resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId),
    })(post([user('Show tasks')])));
    expect(JSON.stringify(chunks)).toContain('Final answer.');
  });
});

describe('environment control in createChatInteractionsHandler', () => {
  const interactions: ChatInteractionsData = {
    schemaVersion: 1,
    entities: [],
    commands: [{ id: 'tasks.search', label: 'Search tasks', run: { kind: 'tool', tool: 'tasks.list' } }],
  };

  it('serves no commands while halted', async () => {
    const handler = createChatInteractionsHandler({ interactions, managedRuntime: managed(() => halted) });
    const response = await handler(new Request('https://app.example/api/chat'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'assistant_halted' });
  });
});
