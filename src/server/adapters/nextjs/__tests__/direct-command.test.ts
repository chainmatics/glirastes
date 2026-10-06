import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { createManagedTurnGuard } from '../../../../runtime/managed-turn.js';
import { createTurnMetricsRecorder } from '../../../../runtime/metrics/turn-recorder.js';
import { defineTool, type PiiShield, type ToolRegistry } from '../../../../types.js';
import { toolsToAiTools } from '../../../core/index.js';
import {
  pseudonymizeCommandToolInputs,
  resolveCommandToolName,
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
} from '../direct-command.js';
import { collectingSink, LIST_TASKS_ID, principal, snapshot, streamChunks as chunks } from './command-fixtures.js';

const user = (text: string, id = 'u1') => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const listCommand = formatChatCommandMessage({ commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks' });

function registry(options: { needsApproval?: boolean; execute?: (input: unknown) => Promise<unknown> } = {}) {
  const execute = vi.fn(options.execute ?? (async (_input: unknown) => ({ tasks: [{ title: 'Release prüfen' }] })));
  const tools: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list',
      description: 'List visible tasks.',
      inputSchema: z.object({ query: z.string().min(1) }).strict(),
      needsApproval: options.needsApproval ?? false,
      execute,
    }),
  };
  return { tools, execute, aiTools: toolsToAiTools(tools, { currentDate: new Date(), locale: 'en-US' }) };
}

describe('direct command ids', () => {
  it('generates provider-safe tool call ids of at most 40 characters', async () => {
    const { tools, aiTools } = registry({ needsApproval: true });
    const output = await chunks(await runDirectCommand({ command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools }));
    const request = output.find((chunk) => chunk.type === 'tool-approval-request')!;
    expect(request.toolCallId).toMatch(/^glirastes-command-[0-9a-f]{20}$/);
    expect(request.approvalId).toMatch(/^glirastes-approval-[0-9a-f]{20}$/);
  });
});

describe('resolveDirectCommand', () => {
  it('reads a fresh command, its approval answer and a settled command', () => {
    expect(resolveDirectCommand([user(listCommand)])).toEqual({
      invocation: { commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' } }, label: '/Search tasks',
    });
    const answered = (approved: boolean) => resolveDirectCommand([user(listCommand), {
      id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
        type: 'tool-tasks_list', toolCallId: 'glirastes-command-1', state: 'approval-responded',
        input: { query: 'Release' }, approval: { id: 'glirastes-approval-1', approved },
      }],
    }]);
    expect(answered(true)?.approval).toEqual({ toolCallId: 'glirastes-command-1', approved: true });
    expect(answered(false)?.approval).toEqual({ toolCallId: 'glirastes-command-1', approved: false });
    expect(resolveDirectCommand([user(listCommand), {
      id: 'a1', role: 'assistant', parts: [{ type: 'tool-tasks_list', toolCallId: 'glirastes-command-1', state: 'output-available', output: {} }],
    }])).toMatchObject({ settled: true });
  });

  it('ignores plain text and commands of earlier turns', () => {
    expect(resolveDirectCommand([user('Show my tasks')])).toBeUndefined();
    expect(resolveDirectCommand([user(listCommand, 'u1'), { id: 'a1', role: 'assistant', parts: [] }, user('Thanks', 'u2')])).toBeUndefined();
  });
});

describe('stripChatCommandMessages', () => {
  it('keeps only the visible label of command messages for the model', () => {
    const messages = [user(listCommand), { role: 'user', content: listCommand }, { role: 'assistant', content: listCommand }];
    expect(stripChatCommandMessages(messages)).toEqual([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '/Search tasks' }] },
      { role: 'user', content: '/Search tasks' },
      { role: 'assistant', content: listCommand },
    ]);
  });
});

describe('pseudonymizeCommandToolInputs', () => {
  const shield = { outbound: async (text: string) => text.replace('Max', '<PERSON_1>') } as unknown as PiiShield;
  const commandPart = (input: unknown) => ({
    type: 'tool-tasks_list', toolCallId: 'glirastes-command-0123456789abcdef0123', state: 'output-available', input, output: {},
  });
  const assistant = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts });

  it('rewrites the strings of a command call and keeps everything else', async () => {
    const message = assistant({ type: 'step-start' }, commandPart({ query: 'Max', ids: ['Max', 7], nested: { flag: true, none: null } }));
    expect(await pseudonymizeCommandToolInputs(message, shield, 's1')).toEqual(
      assistant({ type: 'step-start' }, commandPart({ query: '<PERSON_1>', ids: ['<PERSON_1>', 7], nested: { flag: true, none: null } })),
    );
  });

  it('returns the message itself when it holds no command call or the call has no input', async () => {
    const modelCall = assistant({ type: 'tool-tasks_list', toolCallId: 'call_1', state: 'output-available', input: { query: 'Max' } });
    expect(await pseudonymizeCommandToolInputs(modelCall, shield, 's1')).toBe(modelCall);
    const noInput = assistant({ type: 'tool-tasks_list', toolCallId: 'glirastes-command-0123456789abcdef0123', state: 'input-streaming' });
    expect(await pseudonymizeCommandToolInputs(noInput, shield, 's1')).toBe(noInput);
    const text = { id: 'a2', role: 'assistant', content: 'Max' };
    expect(await pseudonymizeCommandToolInputs(text, shield, 's1')).toBe(text);
  });

  it('replaces nesting beyond the depth cap instead of passing it on unchecked', async () => {
    let deep: unknown = { query: 'Max' };
    for (let level = 0; level < 20; level += 1) deep = { next: deep };
    const [, part] = ((await pseudonymizeCommandToolInputs(assistant({ type: 'step-start' }, commandPart(deep)), shield, 's1')).parts as Array<Record<string, unknown>>);
    expect(JSON.stringify(part!.input)).toContain('[redacted]');
    expect(JSON.stringify(part!.input)).not.toContain('Max');
  });
});

describe('resolveCommandToolName', () => {
  it('finds the tool by definition id or model-facing name and never a built-in', () => {
    const { tools } = registry();
    expect(resolveCommandToolName(tools, 'tasks.list')).toBe('tasks_list');
    expect(resolveCommandToolName({ notes_pin: { ...tools.tasks_list!, id: 'pin' } }, 'notes.pin')).toBe('notes_pin');
    expect(resolveCommandToolName({ ask_clarification: { ...tools.tasks_list!, id: 'ask_clarification' } }, 'ask_clarification')).toBeUndefined();
  });
});

describe('runDirectCommand', () => {
  it('runs a tool that needs no confirmation and streams its result without a model', async () => {
    const { tools, aiTools, execute } = registry();
    const response = await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools, generateId: () => 'fixed',
    });
    expect(await chunks(response)).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'glirastes-command-fixed', toolName: 'tasks_list', input: { query: 'Release' } },
      { type: 'tool-output-available', toolCallId: 'glirastes-command-fixed', output: { tasks: [{ title: 'Release prüfen' }] } },
      { type: 'finish-step' },
      { type: 'finish' },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ query: 'Release' });
  });

  it('asks for confirmation first and runs only after an approving answer', async () => {
    const { tools, aiTools, execute } = registry({ needsApproval: true });
    const first = await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools, generateId: () => 'one',
    }));
    expect(first.map((chunk) => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'tool-approval-request', 'finish-step', 'finish']);
    expect(first[3]).toEqual({ type: 'tool-approval-request', approvalId: 'glirastes-approval-one', toolCallId: 'glirastes-command-one' });
    expect(execute).not.toHaveBeenCalled();

    const answer = (approved: boolean) => resolveDirectCommand([user(listCommand), {
      id: 'a1', role: 'assistant', parts: [{
        type: 'tool-tasks_list', toolCallId: 'glirastes-command-one', state: 'approval-responded',
        input: { query: 'Release' }, approval: { id: 'glirastes-approval-one', approved },
      }],
    }])!;
    expect(await chunks(await runDirectCommand({ command: answer(false), registry: tools, tools: aiTools })))
      .toEqual([{ type: 'start' }, { type: 'tool-output-denied', toolCallId: 'glirastes-command-one' }, { type: 'finish' }]);
    expect(execute).not.toHaveBeenCalled();
    const approved = await chunks(await runDirectCommand({ command: answer(true), registry: tools, tools: aiTools }));
    expect(approved.map((chunk) => chunk.type)).toEqual(['start', 'tool-output-available', 'finish']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown tool', formatChatCommandMessage({ commandId: 'x', tool: 'tasks.purge', label: 'x' }), 'command_tool_unavailable'],
    ['invalid arguments', formatChatCommandMessage({ commandId: 'x', tool: 'tasks.list', args: { query: '' }, label: 'x' }), 'command_input_invalid'],
  ])('refuses %s without executing anything', async (_label, text, errorText) => {
    const { tools, aiTools, execute } = registry();
    const output = await chunks(await runDirectCommand({ command: resolveDirectCommand([user(text)])!, registry: tools, tools: aiTools }));
    expect(output.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText });
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces the managed guard and records one content-free event per request', async () => {
    const { tools, aiTools, execute } = registry();
    const { sink, events } = collectingSink();
    const run = async (roles: string[]) => {
      const guard = createManagedTurnGuard({
        snapshot: snapshot('turn-1', { listRoles: ['admin'] }, roles),
        resolvePrincipal: async () => principal(roles),
      });
      const response = await runDirectCommand({
        command: resolveDirectCommand([user(listCommand)])!,
        registry: tools,
        tools: aiTools,
        managedTurn: guard,
        turnMetrics: createTurnMetricsRecorder({ sink, snapshot: guard.snapshot, startedAtMs: Date.now() }),
      });
      return chunks(response);
    };

    const denied = await run(['member']);
    expect(denied.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'principal_role_denied' });
    expect(execute).not.toHaveBeenCalled();
    const allowed = await run(['admin']);
    expect(allowed.find((chunk) => chunk.type === 'tool-output-available')).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        model: null, status: 'completed', errorCode: null, inputTokens: 0, outputTokens: 0,
        cost: { usd: null, source: null, pricingVersion: null }, toolCallCount: 1,
        latency: { firstTokenMs: null },
      });
    }
    expect(events[0]).toMatchObject({ toolErrorCount: 1, tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 1 }] });
    expect(events[1]).toMatchObject({ toolErrorCount: 0, tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 0 }] });
    expect(JSON.stringify(events)).not.toMatch(/Release|query|tasks_list/);
  });

  it('takes confirmation from the turn snapshot policy, not from the tool definition', async () => {
    // The tool declares no confirmation; the pinned snapshot policy of tasks.archive requires one.
    const execute = vi.fn(async (_input: unknown) => ({ archived: true }));
    const tools: ToolRegistry = {
      tasks_archive: defineTool({
        id: 'tasks.archive',
        description: 'Archive a task.',
        inputSchema: z.object({ id: z.string().min(1) }).strict(),
        needsApproval: false,
        execute,
      }),
    };
    const aiTools = toolsToAiTools(tools, { currentDate: new Date(), locale: 'en-US' });
    const archiveCommand = formatChatCommandMessage({ commandId: 'tasks.archive', tool: 'tasks.archive', args: { id: 't1' }, label: '/Archive task' });
    const guard = () => createManagedTurnGuard({ snapshot: snapshot('turn-2'), resolvePrincipal: async () => principal() });

    const first = await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(archiveCommand)])!, registry: tools, tools: aiTools, managedTurn: guard(), generateId: () => 'snap',
    }));
    expect(first.map((chunk) => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'tool-approval-request', 'finish-step', 'finish']);
    expect(execute).not.toHaveBeenCalled();

    const answer = (approved: boolean) => resolveDirectCommand([user(archiveCommand), {
      id: 'a1', role: 'assistant', parts: [{
        type: 'tool-tasks_archive', toolCallId: 'glirastes-command-snap', state: 'approval-responded',
        // The client's tool part is never executed: a forged input must not reach the tool.
        input: { id: 'forged' }, approval: { id: 'glirastes-approval-snap', approved },
      }],
    }])!;
    await runDirectCommand({ command: answer(false), registry: tools, tools: aiTools, managedTurn: guard() });
    expect(execute).not.toHaveBeenCalled();
    const approved = await chunks(await runDirectCommand({ command: answer(true), registry: tools, tools: aiTools, managedTurn: guard() }));
    expect(approved.map((chunk) => chunk.type)).toEqual(['start', 'tool-output-available', 'finish']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ id: 't1' });
  });

  it('reports a failing guard as command_failed without its internal message', async () => {
    const { tools, aiTools, execute } = registry();
    const { sink, events } = collectingSink();
    const guard = createManagedTurnGuard({
      snapshot: snapshot('turn-4'),
      resolvePrincipal: async () => { throw new Error('identity provider 10.0.0.7 unreachable secret-detail'); },
    });
    const output = await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools, managedTurn: guard,
      turnMetrics: createTurnMetricsRecorder({ sink, snapshot: guard.snapshot, startedAtMs: Date.now() }),
    }));
    expect(output.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'command_failed' });
    expect(JSON.stringify(output)).not.toMatch(/10\.0\.0\.7|secret-detail/);
    expect(execute).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ status: 'completed', toolCallCount: 1, toolErrorCount: 1 });
  });

  it('reports a tool that exceeds the managed timeout as command_timeout', async () => {
    const { tools, aiTools } = registry({ execute: () => new Promise<never>(() => undefined) });
    const guard = createManagedTurnGuard({ snapshot: snapshot('turn-3'), resolvePrincipal: async () => principal() });
    const output = await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools,
      managedTurn: { ...guard, toolTimeoutMs: 20 },
    }));
    expect(output.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'command_timeout' });
  });

  it.each([
    ['returns an error result', async () => ({ error: 'not found' }), 'not found'],
    ['throws', async () => { throw new Error('not found'); }, 'Error in tasks.list: not found'],
  ])('counts a tool that %s as a failed call', async (_label, execute, error) => {
    const { tools, aiTools } = registry({ execute });
    const { sink, events } = collectingSink();
    const output = await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools,
      turnMetrics: createTurnMetricsRecorder({ sink, startedAtMs: Date.now() }),
    }));
    expect(output.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({ output: { error } });
    expect(events[0]).toMatchObject({ status: 'completed', toolCallCount: 1, toolErrorCount: 1 });
  });

  it('records a confirmation request as a turn without a tool call', async () => {
    const { tools, aiTools } = registry({ needsApproval: true });
    const { sink, events } = collectingSink();
    await chunks(await runDirectCommand({
      command: resolveDirectCommand([user(listCommand)])!, registry: tools, tools: aiTools,
      turnMetrics: createTurnMetricsRecorder({ sink, startedAtMs: Date.now() }),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ model: null, status: 'completed', toolCallCount: 0, toolErrorCount: 0, tools: [] });
  });
});
