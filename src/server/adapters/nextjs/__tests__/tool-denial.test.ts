import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TechnicalRuntimeEventV2Schema,
  type AgentRevision,
  type ExecutionBudget,
  type ManifestRevision,
  type RuntimePolicyRevision,
  type SecurityRevocation,
} from '../../../../contracts/index.js';
import { ToolExecutionDeniedError } from '../../../../runtime/tool-denial.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { AiChatHandlerConfig } from '../types.js';
import {
  agentRevision, ARCHIVE_TASK_ID, collectingSink, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision,
  principal,
} from './command-fixtures.js';

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

function tools() {
  const list = vi.fn(async () => ({ tasks: [] }));
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

interface TurnRevisions {
  agent?: AgentRevision;
  manifest?: ManifestRevision;
  policy?: RuntimePolicyRevision;
  roles?: string[];
  limits?: ExecutionBudget;
  /** What `loadRevocations` returns for every tool call of the turn. */
  revocations?: SecurityRevocation[];
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

async function runTurn(
  revisions: TurnRevisions,
  steps: Array<() => ReadableStream>,
  config: Partial<AiChatHandlerConfig> = {},
  resolvePrincipal: () => Promise<ReturnType<typeof principal> | undefined> = async () => principal(revisions.roles),
) {
  const { registry, list, archive } = tools();
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
      loadRevocations: async () => revisions.revocations ?? [],
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

/** The tool results the model received in its second call. */
function toolResultsSentToModel(model: MockLanguageModelV3, call = 1): unknown[] {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as unknown[]);
}

describe('recoverable tool denials in a managed model turn', () => {
  it.each(recoverable)('gives the model a tool error for $reason and continues the turn', async ({ reason, revisions }) => {
    const turn = await runTurn(revisions, [listStep(), textStep]);

    expect(toolResultsSentToModel(turn.model)).toEqual([expect.objectContaining({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'tasks_list',
      output: { type: 'error-text', value: `Tool execution denied: ${reason} (tasks_list)` },
    })]);
    expect(turn.wire).toContain('"type":"tool-output-error"');
    expect(turn.wire).toContain('Final answer.');
    expect(turn.wire).not.toContain('tool-approval-request');
    expect(turn.wire).not.toContain('"type":"error"');
    expect(turn.list).not.toHaveBeenCalled();
    expect(turn.onError).not.toHaveBeenCalled();
    expect(turn.onFinish).toHaveBeenCalledWith(expect.objectContaining({ finishReason: 'stop' }));
  });

  it('shows the model only the reason code and the tool name', async () => {
    const turn = await runTurn({ policy: policyRevision({ listRoles: ['admin'] }) }, [listStep(), textStep]);
    const prompt = JSON.stringify(turn.model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain('principal_role_denied');
    expect(prompt).not.toContain('admin');
    expect(prompt).not.toContain('member');
    expect(prompt).not.toContain(LIST_TASKS_ID);
  });

  it('counts a denied call as a tool call and a tool error, within the wire contract', async () => {
    const turn = await runTurn({ policy: policyRevision({ listRoles: ['admin'] }) }, [listStep(), textStep]);
    const event = turn.events[0]!;
    expect(event).toMatchObject({
      status: 'completed',
      toolCallCount: 1,
      toolErrorCount: 1,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 1 }],
    });
    expect(TechnicalRuntimeEventV2Schema.safeParse(event).success).toBe(true);
    const shapeKeys = Object.keys(TechnicalRuntimeEventV2Schema.shape);
    expect(Object.keys(event).every((key) => shapeKeys.includes(key))).toBe(true);
    expect(JSON.stringify(event)).not.toContain('denied');
    expect(turn.onFinish).toHaveBeenCalledWith(expect.objectContaining({ expectedToolFailureCount: 0 }));
  });

  it.each([
    { label: 'without a classifier', config: {} },
    { label: 'with a classifier that marks every failure expected', config: { classifyToolFailure: () => 'expected' as const } },
  ])('stops repeated denials at maxConsecutiveErrors ($label)', async ({ config }) => {
    const limits = { ...localLimits, maxConsecutiveErrors: 2 };
    const turn = await runTurn(
      { policy: policyRevision({ listRoles: ['admin'] }), limits },
      [listStep('call-1'), listStep('call-2'), textStep],
      config,
    );

    expect(turn.model.doStreamCalls[1]!.tools?.length ?? 0).toBeGreaterThan(0);
    expect(turn.model.doStreamCalls[2]!.tools ?? []).toHaveLength(0);
    expect(turn.wire).toContain('Stopped at runtime budget: maxConsecutiveErrors.');
    expect(turn.list).not.toHaveBeenCalled();
    expect(turn.events[0]).toMatchObject({
      status: 'safety-stop',
      errorCode: 'budget_exhausted',
      toolCallCount: 2,
      toolErrorCount: 2,
    });
    expect(turn.onFinish).toHaveBeenCalledWith(expect.objectContaining({ expectedToolFailureCount: 0 }));
  });

  it('denies a registered but not advertised tool as a tool failure under tool discovery', async () => {
    const turn = await runTurn(
      { policy: policyRevision({ listRoles: ['admin'] }) },
      [listStep(), textStep],
      { toolDiscovery: true },
    );

    expect(turn.model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).not.toContain('tasks_list');
    expect(toolResultsSentToModel(turn.model)).toEqual([expect.objectContaining({
      toolName: 'tasks_list',
      output: { type: 'error-text', value: 'Tool execution denied: principal_role_denied (tasks_list)' },
    })]);
    expect(turn.wire).toContain('Final answer.');
    expect(turn.list).not.toHaveBeenCalled();
    expect(turn.onError).not.toHaveBeenCalled();
  });
});

describe('approval and tool denials', () => {
  it('still asks for approval of an allowed tool that needs it', async () => {
    const turn = await runTurn({}, [archiveStep(), textStep]);
    expect(turn.wire).toContain('"type":"tool-approval-request"');
    expect(turn.wire).not.toContain('tool-output-error');
    expect(turn.archive).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'policy_tool_denied', revisions: { policy: policyRevision({ archiveEnabled: false }) } },
    { reason: 'agent_tool_denied', revisions: { agent: { ...agentRevision, toolAllowlist: [LIST_TASKS_ID] } } },
  ])('never asks for approval of a denied tool ($reason)', async ({ reason, revisions }) => {
    const turn = await runTurn(revisions, [archiveStep(), textStep]);
    expect(turn.wire).not.toContain('tool-approval-request');
    expect(turn.wire).not.toContain('approvalId');
    expect(toolResultsSentToModel(turn.model)).toEqual([expect.objectContaining({
      toolName: 'tasks_archive',
      output: { type: 'error-text', value: `Tool execution denied: ${reason} (tasks_archive)` },
    })]);
    expect(turn.wire).toContain('Final answer.');
    expect(turn.archive).not.toHaveBeenCalled();
  });
});

describe('terminal tool denials', () => {
  it.each([
    { reason: 'missing_principal', resolvePrincipal: async () => undefined },
    {
      reason: 'tenant_mismatch',
      resolvePrincipal: async () => ({ ...principal(), tenantId: '019fb710-0000-7000-8000-0000000000ff' }),
    },
  ])('still ends the turn as an error for $reason', async ({ reason, resolvePrincipal }) => {
    // The request starts with a valid principal; it changes before the tool call.
    let resolved = 0;
    const turn = await runTurn({}, [listStep(), textStep], {}, async () => {
      resolved += 1;
      return resolved === 1 ? principal() : resolvePrincipal();
    });

    expect(turn.list).not.toHaveBeenCalled();
    expect(turn.model.doStreamCalls).toHaveLength(1);
    expect(turn.wire).toContain('"type":"error"');
    expect(turn.wire).not.toContain('Final answer.');
    const error = turn.onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ToolExecutionDeniedError);
    expect(error).toMatchObject({ reason, recoverable: false });
    expect(String(error)).toMatch(new RegExp(`Tool execution denied: ${reason} \\(tasks_list\\)`));
  });
});

describe('terminal conditions win over a recoverable tool denial', () => {
  const roleDenied = policyRevision({ listRoles: ['admin'] });
  /** `tasks_list` stays registered, but the signed manifest no longer carries it. */
  const withoutList: TurnRevisions = {
    agent: { ...agentRevision, toolAllowlist: [ARCHIVE_TASK_ID] },
    manifest: { ...manifestRevision, tools: manifestRevision.tools.filter((tool) => tool.toolId !== LIST_TASKS_ID) },
    policy: { ...policyRevision(), toolPolicies: policyRevision().toolPolicies.filter((entry) => entry.toolId !== LIST_TASKS_ID) },
  };
  const revocation = (patch: Partial<SecurityRevocation>): SecurityRevocation => ({
    revocationId: '019fb710-0000-7000-8000-0000000000c1',
    environmentId: manifestRevision.environmentId,
    effectiveAt: new Date(0).toISOString(),
    reasonCode: 'security-disable',
    toolIds: [],
    agentRevisionIds: [],
    policyRevisionIds: [],
    signature: agentRevision.signature,
    ...patch,
  });
  const agentRevoked = revocation({ agentRevisionIds: [agentRevision.revisionId] });
  const policyRevoked = revocation({ policyRevisionIds: [roleDenied.revisionId] });
  const otherTenant = { ...principal(), tenantId: '019fb710-0000-7000-8000-0000000000ff' };

  const cases: Array<{
    label: string;
    reason: string;
    revisions: TurnRevisions;
    /** The principal at the tool call; the request itself always starts with a valid one. */
    atToolCall?: ReturnType<typeof principal> | undefined;
    sessionEnds?: boolean;
  }> = [
    { label: 'expired session + tool not in the manifest', reason: 'missing_principal', revisions: withoutList, sessionEnds: true },
    { label: 'expired session + role-denied tool', reason: 'missing_principal', revisions: { policy: roleDenied }, sessionEnds: true },
    { label: 'tenant mismatch + role-denied tool', reason: 'tenant_mismatch', revisions: { policy: roleDenied }, atToolCall: otherTenant },
    { label: 'tenant mismatch + tool not in the manifest', reason: 'tenant_mismatch', revisions: withoutList, atToolCall: otherTenant },
    { label: 'revoked agent revision + role-denied tool', reason: 'revoked', revisions: { policy: roleDenied, revocations: [agentRevoked] } },
    { label: 'revoked policy revision + role-denied tool', reason: 'revoked', revisions: { policy: roleDenied, revocations: [policyRevoked] } },
    { label: 'revoked agent revision + tool not in the manifest', reason: 'revoked', revisions: { ...withoutList, revocations: [agentRevoked] } },
  ];

  it.each(cases)('$label ends the turn with $reason', async ({ reason, revisions, atToolCall, sessionEnds }) => {
    let resolved = 0;
    const turn = await runTurn(revisions, [listStep(), textStep], {}, async () => {
      resolved += 1;
      if (resolved === 1) return principal();
      return sessionEnds ? undefined : atToolCall ?? principal();
    });

    expect(turn.list).not.toHaveBeenCalled();
    // No tool error is handed to the model: it is never called again.
    expect(turn.model.doStreamCalls).toHaveLength(1);
    expect(turn.wire).not.toContain('"type":"tool-output-error"');
    expect(turn.wire).toContain('"type":"error"');
    expect(turn.wire).not.toContain('Final answer.');
    const error = turn.onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ToolExecutionDeniedError);
    expect(error).toMatchObject({ reason, recoverable: false });
    expect(String(error)).toContain(`Tool execution denied: ${reason} (tasks_list)`);
  });

  it('still recovers from a tool that is not in the manifest when no terminal condition applies', async () => {
    const turn = await runTurn(withoutList, [listStep(), textStep]);
    expect(toolResultsSentToModel(turn.model)).toEqual([expect.objectContaining({
      toolName: 'tasks_list',
      output: { type: 'error-text', value: 'Tool execution denied: manifest_tool_unavailable (tasks_list)' },
    })]);
    expect(turn.wire).toContain('Final answer.');
    expect(turn.onError).not.toHaveBeenCalled();
  });
});
