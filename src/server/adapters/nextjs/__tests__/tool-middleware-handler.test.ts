import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  RuntimePolicyRevision,
  SecurityRevocation,
} from '../../../../contracts/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import type { ToolMiddleware, ToolMiddlewareCall, ToolMiddlewareNext } from '../../../core/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { AiChatHandlerConfig } from '../types.js';
import {
  agentRevision, ARCHIVE_TASK_ID, collectingSink, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision,
  principal, streamChunks,
} from './command-fixtures.js';

/**
 * `toolMiddleware` wraps only the execution of an app tool: every identity,
 * RBAC, approval, budget and revocation check runs before it, so a call those
 * checks stop never reaches a middleware.
 */

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const toolStep = (toolName: string, callId: string, input: unknown) => () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
] as never);
const listStep = (callId = 'call-1') => toolStep('tasks_list', callId, { query: 'Release' });
const archiveStep = (callId = 'call-1') => toolStep('tasks_archive', callId, { id: 't1' });
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

function tools(options: TurnHooks = {}) {
  const list = vi.fn(async () => { options.onList?.(); return { tasks: [] }; });
  const archive = vi.fn(async () => ({ success: true, archived: 't1' }));
  const registry: ToolRegistry = {
    tasks_list: defineTool({ id: 'tasks.list', description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(), execute: list }),
    tasks_archive: defineTool({
      id: 'tasks.archive', description: 'Archive a task.', inputSchema: z.object({ id: z.string() }).strict(),
      needsApproval: true, execute: archive,
    }),
    ...(options.withPurgeTool
      ? { tasks_purge: defineTool({ id: 'tasks.purge', description: 'Purge all tasks.', inputSchema: z.object({}).strict(), execute: async () => ({ success: true }) }) }
      : {}),
  };
  return { registry, list, archive };
}

interface TurnHooks {
  /** Runs when `tasks_list` executes: the point where a test changes roles, session or revocations mid-request. */
  onList?: () => void;
  /** Registers `tasks_purge`, a tool the signed manifest does not carry. */
  withPurgeTool?: boolean;
}

interface TurnRevisions {
  agent?: AgentRevision;
  manifest?: ManifestRevision;
  policy?: RuntimePolicyRevision;
  roles?: string[];
  limits?: ExecutionBudget;
  /** What `loadRevocations` returns for every tool call of the turn; a function is asked each time. */
  revocations?: SecurityRevocation[] | (() => SecurityRevocation[]);
}

function withListPolicy(patch: Partial<RuntimePolicyRevision['toolPolicies'][number]>): RuntimePolicyRevision {
  const policy = policyRevision();
  return {
    ...policy,
    toolPolicies: policy.toolPolicies.map((entry) => (entry.toolId === LIST_TASKS_ID ? { ...entry, ...patch } : entry)),
  };
}

/** One revision set per recoverable reason; the call is always `tasks_list`. */
const recoverable: Array<{ reason: string; revisions: TurnRevisions }> = [
  { reason: 'principal_role_denied', revisions: { policy: policyRevision({ listRoles: ['admin'] }) } },
  { reason: 'policy_tool_denied', revisions: { policy: withListPolicy({ enabled: false }) } },
  { reason: 'agent_tool_denied', revisions: { agent: { ...agentRevision, toolAllowlist: [ARCHIVE_TASK_ID] } } },
  {
    reason: 'manifest_tool_unavailable',
    revisions: {
      manifest: {
        ...manifestRevision,
        tools: manifestRevision.tools.map((tool) => (tool.toolId === LIST_TASKS_ID ? { ...tool, enabled: false } : tool)),
      },
    },
  },
];

type ResolvePrincipal = () => Promise<ReturnType<typeof principal> | undefined>;

/** A managed turn with the handler's defaults: the model gets only the tools the principal may use. */
async function runDefaultTurn(
  revisions: TurnRevisions,
  steps: Array<() => ReadableStream>,
  config: Partial<AiChatHandlerConfig> = {},
  resolvePrincipal: ResolvePrincipal = async () => principal(revisions.roles),
  hooks: TurnHooks = {},
) {
  const { registry, list, archive } = tools(hooks);
  const { sink, events } = collectingSink();
  const onError = vi.fn();
  const onFinish = vi.fn();
  const model = scriptedModel(steps);
  const handler = createAiChatHandler({
    tools: registry,
    model,
    systemPrompt: 'Assistant',
    metrics: sink,
    onError,
    onFinish,
    approvalSecret: 'tool-denial-test-secret-32-chars!!',
    // These tests name the domain tools offered; read_result has its own tests (result-handles-handler).
    resultHandles: false,
    managedRuntime: {
      resolvePrincipal,
      resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
        turnId,
        agentRevision: revisions.agent ?? agentRevision,
        manifestRevision: revisions.manifest ?? manifestRevision,
        policyRevision: revisions.policy ?? policyRevision(),
        principal: principal(revisions.roles),
        localLimits: revisions.limits ?? localLimits,
      }),
      loadRevocations: async () => (
        typeof revisions.revocations === 'function' ? revisions.revocations() : revisions.revocations ?? []
      ),
    },
    ...config,
  });
  const wire = await (await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] }] }),
  }))).text();
  return { wire, model, events, onError, onFinish, list, archive };
}

/**
 * `authorizedToolsOnly: false`: every registry tool reaches the model, so the
 * guard is asked for every call the model makes, also for a tool the
 * principal could never use.
 */
const runTurn = (
  revisions: TurnRevisions,
  steps: Array<() => ReadableStream>,
  config: Partial<AiChatHandlerConfig> = {},
  resolvePrincipal?: ResolvePrincipal,
) => runDefaultTurn(revisions, steps, { authorizedToolsOnly: false, ...config }, resolvePrincipal);

/** The tool results the model received in its second call. */
function toolResultsSentToModel(model: MockLanguageModelV3, call = 1): unknown[] {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as unknown[]);
}

const securityRevocation = (patch: Partial<SecurityRevocation>): SecurityRevocation => ({
  revocationId: '019fb710-0000-7000-8000-0000000000c2',
  environmentId: manifestRevision.environmentId,
  effectiveAt: new Date(0).toISOString(),
  reasonCode: 'security-disable',
  toolIds: [],
  agentRevisionIds: [],
  policyRevisionIds: [],
  signature: agentRevision.signature,
  ...patch,
});

const mwSpy = () => vi.fn<ToolMiddleware>(async (_call: ToolMiddlewareCall, next: ToolMiddlewareNext) => next());
const callNames = (mw: ReturnType<typeof mwSpy>) => mw.mock.calls.map(([call]) => call.toolName);

const post = (messages: unknown[]) => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
});
const user = (text: string) => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] });

describe('createAiChatHandler({ toolMiddleware })', () => {
  it('runs for an allowed call with the AI SDK tool call id', async () => {
    const mw = mwSpy();
    const turn = await runDefaultTurn({}, [listStep('call-1'), textStep], { toolMiddleware: [mw] });
    expect(mw).toHaveBeenCalledTimes(1);
    expect(mw.mock.calls[0]![0]).toMatchObject({
      toolName: 'tasks_list', toolId: 'tasks.list', toolCallId: 'call-1', input: { query: 'Release' },
    });
    expect(turn.list).toHaveBeenCalledTimes(1);
  });

  it.each(recoverable)('is never reached for a call the managed guard denies ($reason)', async ({ revisions }) => {
    const mw = mwSpy();
    const turn = await runTurn(revisions, [listStep(), textStep], { toolMiddleware: [mw] });
    expect(mw).not.toHaveBeenCalled();
    expect(turn.list).not.toHaveBeenCalled();
  });

  it('is never reached for a revoked tool', async () => {
    const mw = mwSpy();
    const turn = await runTurn(
      { revocations: [securityRevocation({ toolIds: [LIST_TASKS_ID] })] },
      [listStep(), textStep],
      { toolMiddleware: [mw] },
    );
    expect(mw).not.toHaveBeenCalled();
    expect(turn.list).not.toHaveBeenCalled();
  });

  it('is never reached over the tool-call budget', async () => {
    const mw = mwSpy();
    const turn = await runDefaultTurn(
      { limits: { ...localLimits, maxToolCalls: 1 } },
      [listStep('call-1'), listStep('call-2'), textStep],
      { toolMiddleware: [mw] },
    );
    expect(mw).toHaveBeenCalledTimes(1);
    expect(mw.mock.calls[0]![0].toolCallId).toBe('call-1');
    expect(turn.list).toHaveBeenCalledTimes(1);
  });

  it('is never reached for an approval tool without an approval', async () => {
    const mw = mwSpy();
    const turn = await runDefaultTurn({}, [archiveStep(), textStep], { toolMiddleware: [mw] });
    expect(mw).not.toHaveBeenCalled();
    expect(turn.archive).not.toHaveBeenCalled();
    expect(turn.wire).toContain('tool-approval-request');
  });

  it('runs once for a verified approval, and not again for a replay', async () => {
    const mw = mwSpy();
    const { registry, archive } = tools();
    const handler = createAiChatHandler({
      tools: registry,
      model: scriptedModel([archiveStep('call-1'), textStep]),
      systemPrompt: 'Assistant',
      approvalSecret: 'tool-middleware-test-secret-32-chars!',
      resultHandles: false,
      toolMiddleware: [mw],
    });
    const first = await streamChunks(await handler(post([user('Archive t1')])));
    const request = first.find((chunk) => chunk.type === 'tool-approval-request');
    expect(request).toBeDefined();
    expect(mw).not.toHaveBeenCalled();
    const approved = {
      id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, {
        type: 'tool-tasks_archive', toolCallId: request!.toolCallId, state: 'approval-responded',
        input: { id: 't1' }, approval: { id: request!.approvalId, approved: true },
      }],
    };
    await streamChunks(await handler(post([user('Archive t1'), approved])));
    expect(archive).toHaveBeenCalledTimes(1);
    expect(mw).toHaveBeenCalledTimes(1);
    expect(mw.mock.calls[0]![0]).toMatchObject({ toolName: 'tasks_archive', input: { id: 't1' }, readOnly: false });
    const replay = await streamChunks(await handler(post([user('Archive t1'), approved])));
    // The default store consumed the approval: the replayed call does not run again.
    expect(replay.some((chunk) => chunk.type === 'tool-output-available')).toBe(false);
    expect(mw).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('SDK built-ins bypass it', async () => {
    const mw = mwSpy();
    const builtins = () => convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'read-1', toolName: 'read_result', input: JSON.stringify({ resultId: 'ro_00000000' }) },
      { type: 'tool-call', toolCallId: 'find-1', toolName: 'find_tools', input: JSON.stringify({ query: 'tasks' }) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ] as never);
    const turn = await runDefaultTurn({}, [listStep('call-1'), builtins, textStep], {
      toolMiddleware: [mw], resultHandles: true, toolDiscovery: true,
    });
    const offered = turn.model.doStreamCalls[1]!.tools?.map((tool) => tool.name) ?? [];
    expect(offered).toEqual(expect.arrayContaining(['find_tools', 'read_result']));
    expect(JSON.stringify(turn.model.doStreamCalls[2]!.prompt)).toContain('read-1');
    expect(callNames(mw)).toEqual(['tasks_list']);
  });

  it('a throwing middleware ends the call as a tool error and the turn continues', async () => {
    const mw = vi.fn<ToolMiddleware>(() => {
      throw new Error('mapped');
    });
    const onToolError = vi.fn();
    const turn = await runDefaultTurn({}, [listStep(), textStep], { toolMiddleware: [mw], onToolError });
    expect(JSON.stringify(toolResultsSentToModel(turn.model))).toContain('Error in tasks_list: mapped');
    expect(turn.list).not.toHaveBeenCalled();
    expect(onToolError).toHaveBeenCalledWith('tasks.list', expect.objectContaining({ message: 'mapped' }));
    expect(turn.wire).toContain('Final answer.');
  });

  it('runs for direct commands', async () => {
    const mw = mwSpy();
    const { registry, list } = tools();
    const languageModel = scriptedModel([textStep]);
    const handler = createAiChatHandler({
      tools: registry, model: languageModel, systemPrompt: 'Assistant', toolMiddleware: [mw],
    });
    const command = formatChatCommandMessage({
      commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks',
    });
    await streamChunks(await handler(post([user(command)])));
    expect(list).toHaveBeenCalledTimes(1);
    expect(mw).toHaveBeenCalledTimes(1);
    expect(mw.mock.calls[0]![0]).toMatchObject({ toolName: 'tasks_list', input: { query: 'Release' } });
    expect(languageModel.doStreamCalls).toHaveLength(0);
  });

  it('rejects a non-array toolMiddleware at construction', () => {
    expect(() => createAiChatHandler({
      tools: tools().registry, model: scriptedModel([textStep]), systemPrompt: 'Assistant',
      toolMiddleware: (() => {}) as never,
    })).toThrow(new TypeError('toolMiddleware must be an array of functions'));
  });
});
