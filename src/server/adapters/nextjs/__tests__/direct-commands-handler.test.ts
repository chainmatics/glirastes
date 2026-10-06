import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { defineTool, type PiiShield, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { collectingSink, principal, snapshot, streamChunks } from './command-fixtures.js';

const archiveCommand = formatChatCommandMessage({
  commandId: 'task.tasks.archive', tool: 'tasks.archive', args: { id: 't1' }, label: '/Archive Release prüfen',
});
const listCommand = formatChatCommandMessage({
  commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks',
});

function model() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Model answer.' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish', finishReason: { unified: 'stop', raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        },
      ] as never),
    }),
  });
}

function tools() {
  const list = vi.fn(async () => ({ tasks: [{ id: 't1', title: 'Release prüfen' }] }));
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

function post(messages: unknown[]): Request {
  return new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
  });
}

const user = (text: string, id = 'u1') => ({ id, role: 'user', parts: [{ type: 'text', text }] });

function approvalAnswer(approved: boolean, toolCallId: string) {
  return {
    id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
      type: 'tool-tasks_archive', toolCallId, state: 'approval-responded',
      input: { id: 't1' }, approval: { id: 'glirastes-approval-1', approved },
    }],
  };
}

describe('direct commands in createAiChatHandler', () => {
  it('runs a command without routing or a model call', async () => {
    const languageModel = model();
    const process = vi.fn();
    const { registry, list } = tools();
    const handler = createAiChatHandler({
      tools: registry, model: languageModel, systemPrompt: 'Assistant',
      pipeline: { process } as never,
    });
    const output = await streamChunks(await handler(post([user(listCommand)])));
    expect(output.find((chunk) => chunk.type === 'tool-output-available'))
      .toMatchObject({ output: { tasks: [{ id: 't1', title: 'Release prüfen' }] } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);
    expect(process).not.toHaveBeenCalled();
  });

  it('keeps the confirmation of a write tool, under the managed guard, across the approval round trip', async () => {
    const languageModel = model();
    const { registry, archive } = tools();
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry, model: languageModel, systemPrompt: 'Assistant', metrics: sink,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId),
      },
    });
    const first = await streamChunks(await handler(post([user(archiveCommand)])));
    const request = first.find((chunk) => chunk.type === 'tool-approval-request');
    expect(request).toMatchObject({ toolCallId: expect.stringMatching(/^glirastes-command-[0-9a-f]{20}$/) });
    expect(archive).not.toHaveBeenCalled();

    const toolCallId = request!.toolCallId as string;
    const denied = await streamChunks(await handler(post([user(archiveCommand), approvalAnswer(false, toolCallId)])));
    expect(denied.map((chunk) => chunk.type)).toContain('tool-output-denied');
    expect(archive).not.toHaveBeenCalled();
    const approved = await streamChunks(await handler(post([user(archiveCommand), approvalAnswer(true, toolCallId)])));
    expect(approved.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({ toolCallId, output: { archived: 't1' } });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);

    expect(events.map((event) => [event.model, event.toolCallCount, event.cost.usd])).toEqual([
      [null, 0, null], [null, 0, null], [null, 1, null],
    ]);
  });

  it('refuses a tool the Platform disabled or the principal may not use', async () => {
    const { registry, archive, list } = tools();
    const handler = (options: Parameters<typeof snapshot>[1]) => createAiChatHandler({
      tools: registry, model: model(), systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId, options),
      },
    });
    const disabled = await streamChunks(await handler({ archiveEnabled: false })(post([user(archiveCommand)])));
    expect(disabled.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'policy_tool_denied' });
    const forbidden = await streamChunks(await handler({ listRoles: ['admin'] })(post([user(listCommand)])));
    expect(forbidden.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'principal_role_denied' });
    expect(archive).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('does not run a settled command again when the history is replayed', async () => {
    const languageModel = model();
    const { registry, list } = tools();
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant', metrics: sink });
    const settled = {
      id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
        type: 'tool-tasks_list', toolCallId: 'glirastes-command-0123456789abcdef0123', state: 'output-available',
        input: { query: 'Release' }, output: { tasks: [] },
      }],
    };
    const output = await streamChunks(await handler(post([user(listCommand), settled])));
    expect(output.map((chunk) => chunk.type)).toEqual(['start', 'finish']);
    expect(list).not.toHaveBeenCalled();
    expect(languageModel.doStreamCalls).toHaveLength(0);
    expect(events.map((event) => [event.status, event.model, event.toolCallCount])).toEqual([['completed', null, 0]]);
  });

  it('reports an unexpected failure as a pipeline error without leaking its message', async () => {
    const languageModel = model();
    const onError = vi.fn();
    const { sink, events } = collectingSink();
    const registry: ToolRegistry = {
      tasks_list: defineTool({
        id: 'tasks.list', description: 'List tasks.',
        inputSchema: z.object({ query: z.string() }).strict().superRefine(() => { throw new Error('secret backend detail'); }),
        execute: async () => ({ tasks: [] }),
      }),
    };
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant', metrics: sink, onError });
    const output = await streamChunks(await handler(post([user(listCommand)])));
    expect(output.find((chunk) => chunk.type === 'error')).toMatchObject({ errorText: 'Command failed' });
    expect(JSON.stringify(output)).not.toContain('secret backend detail');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);
    expect(events.map((event) => [event.status, event.errorCode, event.toolCallCount])).toEqual([['error', 'pipeline_error', 0]]);
  });

  it('pseudonymizes the result through the PII shield, because later model turns read it', async () => {
    const languageModel = model();
    const { registry, list } = tools();
    const anonymizeResult = vi.fn(async () => ({ tasks: [{ id: 't1', title: '<PERSON_1>' }] }));
    const piiShield = {
      outbound: vi.fn(async (text: string) => text),
      inbound: (text: string) => text,
      rehydrateArgs: (args: Record<string, unknown>) => args,
      anonymizeResult,
      getComplianceSummary: vi.fn(),
      clearSession: vi.fn(),
    } as unknown as PiiShield;
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant', piiShield });
    const output = await streamChunks(await handler(post([user(listCommand)])));
    expect(output.find((chunk) => chunk.type === 'tool-output-available'))
      .toMatchObject({ output: { tasks: [{ id: 't1', title: '<PERSON_1>' }] } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(anonymizeResult).toHaveBeenCalledTimes(1);
    expect(languageModel.doStreamCalls).toHaveLength(0);
  });

  it('shows the model earlier commands only by their label', async () => {
    const languageModel = model();
    const { registry } = tools();
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant' });
    const history = [
      user(listCommand, 'u1'),
      {
        id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
          type: 'tool-tasks_list', toolCallId: 'glirastes-command-0123456789abcdef0123', state: 'output-available',
          input: { query: 'Release' }, output: { tasks: [{ id: 't1', title: 'Release prüfen' }] },
        }],
      },
      user('Which one is due first?', 'u2'),
    ];
    await (await handler(post(history))).text();
    expect(languageModel.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(languageModel.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('/Search tasks');
    // The command's call and result reach the model like a model call, with the replayable id.
    expect(prompt).toContain('glirastes-command-0123456789abcdef0123');
    expect(prompt).toContain('Release prüfen');
    expect(prompt).not.toContain('glirastes:command');
  });

  it('hands a command message to the model as text when direct commands are off', async () => {
    const languageModel = model();
    const { registry, list } = tools();
    const handler = createAiChatHandler({ tools: registry, model: languageModel, systemPrompt: 'Assistant', directCommands: false });
    await (await handler(post([user(listCommand)]))).text();
    expect(list).not.toHaveBeenCalled();
    expect(languageModel.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(languageModel.doStreamCalls[0]!.prompt)).not.toContain('glirastes:command');
  });
});
