import { describe, expect, it, vi } from 'vitest';
import type { Principal, SecurityRevocation } from '../../contracts/index.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from './turn-snapshot.test.js';
import { createTurnSnapshot, type TurnSnapshot } from '../turn-snapshot.js';
import { createManagedTurnGuard } from '../managed-turn.js';
import { isRecoverableToolDenial, ToolExecutionDeniedError } from '../tool-denial.js';

function createSnapshot() {
  return createTurnSnapshot({
    turnId: 'turn-1',
    agentRevision,
    manifestRevision,
    policyRevision,
    principal,
    localLimits,
  });
}

describe('createManagedTurnGuard', () => {
  it('authorizes calls addressed by the model-safe encoded name', async () => {
    // The registry exposes dotted manifest names in their model-safe
    // encoding, so authorization must resolve the same encoding — otherwise
    // every call to a definitionId-named tool dies fail-closed as
    // manifest_tool_unavailable.
    const base = createSnapshot();
    const snapshot = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{
          ...base.manifestRevision.tools[0]!,
          name: 'ui.taskView.switch',
        }],
      },
    };
    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });

    await expect(guard.beforeToolCall({
      toolName: 'ui_taskView_switch',
      input: {},
    })).resolves.toBeUndefined();
  });

  it('re-resolves the server principal before every tool call', async () => {
    let currentPrincipal: Principal | undefined = principal;
    const resolvePrincipal = vi.fn(async () => currentPrincipal);
    const guard = createManagedTurnGuard({
      snapshot: createSnapshot(),
      resolvePrincipal,
    });

    await guard.beforeToolCall({
      toolName: 'list_tasks',
      input: { status: 'open' },
    });

    currentPrincipal = { ...principal, roles: ['viewer'] };

    await expect(guard.beforeToolCall({
      toolName: 'list_tasks',
      input: { status: 'open' },
    })).rejects.toThrow(/principal_role_denied/);
    expect(resolvePrincipal).toHaveBeenCalledTimes(2);
  });

  it('applies newly received security revocations before execution', async () => {
    let revocations: SecurityRevocation[] = [];
    const guard = createManagedTurnGuard({
      snapshot: createSnapshot(),
      resolvePrincipal: async () => principal,
      loadRevocations: async () => revocations,
    });

    await guard.beforeToolCall({ toolName: 'list_tasks', input: {} });

    revocations = [{
      revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a09',
      environmentId: manifestRevision.environmentId,
      effectiveAt: new Date(0).toISOString(),
      reasonCode: 'security-disable',
      toolIds: [agentRevision.toolAllowlist[0]!],
      agentRevisionIds: [],
      policyRevisionIds: [],
      signature: agentRevision.signature,
    }];

    await expect(guard.beforeToolCall({
      toolName: 'list_tasks',
      input: {},
    })).rejects.toThrow(/revoked/);
  });

  it('hard-stops before a tool call would exceed the pinned budget', async () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-budget',
      agentRevision: {
        ...agentRevision,
        budget: { ...agentRevision.budget, maxToolCalls: 1 },
      },
      manifestRevision,
      policyRevision,
      principal,
      localLimits,
    });
    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });

    await guard.beforeToolCall({ toolName: 'list_tasks', input: {} });
    await guard.afterToolCall({
      toolName: 'list_tasks',
      input: {},
      result: { tasks: [] },
      durationMs: 1,
    });

    await expect(guard.beforeToolCall({
      toolName: 'list_tasks',
      input: {},
    })).rejects.toMatchObject({
      reason: 'budget_exhausted',
      recoverable: false,
      budget: [{ dimension: 'maxToolCalls', limit: 1, used: 1 }],
      message: 'Tool call not executed: the limit of 1 tool call per turn is reached (1 used). '
        + 'Do not retry in this turn; tell the user which requests are still open.',
    });
    expect(guard.tracker.usage.toolCalls).toBe(1);
  });

  it('records model steps and token usage against the pinned budget', async () => {
    const onBudgetSignal = vi.fn();
    const guard = createManagedTurnGuard({
      snapshot: createSnapshot(),
      resolvePrincipal: async () => principal,
      onBudgetSignal,
    });

    await guard.afterModelStep({
      inputTokens: 40_000,
      outputTokens: 8_000,
    });

    expect(guard.tracker.usage).toMatchObject({
      modelSteps: 1,
      inputTokens: 40_000,
      outputTokens: 8_000,
    });
    expect(onBudgetSignal).toHaveBeenCalledWith(expect.objectContaining({
      evaluation: expect.objectContaining({ state: 'soft-limit' }),
    }));
  });

  it('derives approval solely from the pinned policy', async () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-approval',
      agentRevision,
      manifestRevision,
      policyRevision: {
        ...policyRevision,
        toolPolicies: policyRevision.toolPolicies.map((policy) => ({
          ...policy,
          requiresApproval: true,
        })),
      },
      principal,
      localLimits,
    });
    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });

    await expect(guard.resolveApproval({
      toolName: 'list_tasks',
      input: {},
    })).resolves.toBe(true);
  });

  it('confirms a tier-3 call even if its pinned policy says no', async () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-tier-3',
      agentRevision,
      manifestRevision: {
        ...manifestRevision,
        tools: manifestRevision.tools.map((tool) => ({
          ...tool,
          riskClass: 'delete' as const,
        })),
      },
      policyRevision: {
        ...policyRevision,
        toolPolicies: policyRevision.toolPolicies.map((policy) => ({
          ...policy,
          riskClass: 'delete' as const,
          requiresApproval: false,
        })),
      },
      principal,
      localLimits,
    });
    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });

    await expect(guard.resolveApproval({
      toolName: 'list_tasks',
      input: {},
    })).resolves.toBe(true);
  });
});

describe('createManagedTurnGuard: expected tool failures', () => {
  const call = (result: unknown, input: Record<string, unknown> = {}) => ({
    toolName: 'list_tasks',
    input,
    result,
    durationMs: 1,
  });
  const error = { success: false, error: 'Forbidden', retryable: false, status: 403 };
  const expected = { ...error, expectedFailure: true };
  const guard = () => createManagedTurnGuard({
    snapshot: createSnapshot(),
    resolvePrincipal: async () => principal,
  });

  it('counts a failure result as a consecutive error by default', async () => {
    const turn = guard();
    await turn.afterToolCall(call(error, { n: 1 }));
    await turn.afterToolCall(call({ error: 'x' }, { n: 2 }));
    expect(turn.tracker.usage.consecutiveErrors).toBe(2);
    await turn.afterToolCall(call({ tasks: [] }, { n: 3 }));
    expect(turn.tracker.usage.consecutiveErrors).toBe(0);
  });

  it('neither increments nor resets the consecutive errors for an expected failure', async () => {
    const turn = guard();
    await turn.afterToolCall(call(expected, { n: 1 }));
    expect(turn.tracker.usage.consecutiveErrors).toBe(0);
    await turn.afterToolCall(call(error, { n: 2 }));
    await turn.afterToolCall(call(expected, { n: 3 }));
    expect(turn.tracker.usage.consecutiveErrors).toBe(1);
    await turn.afterToolCall(call(error, { n: 4 }));
    expect(turn.tracker.usage.consecutiveErrors).toBe(2);
  });

  it('still records the fingerprint of an expected failure', async () => {
    const turn = guard();
    await turn.afterToolCall(call(expected));
    await turn.afterToolCall(call(expected));
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(2);
  });

  it('trips the repeated-fingerprint limit when failure bodies differ only by a timestamp', async () => {
    const turn = guard();
    const limit = turn.snapshot.budget.maxRepeatedFingerprint;
    for (let index = 0; index <= limit; index += 1) {
      await turn.afterToolCall(call({
        ...expected,
        body: { code: 'NO_ROLE', timestamp: `2026-11-16T10:00:0${index % 10}.000Z`, traceId: `trace-${index}` },
        ...(index % 2 === 0 ? { bodyTruncated: true } : {}),
      }));
    }
    expect(turn.tracker.usage.consecutiveErrors).toBe(0);
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(limit + 1);
    const evaluation = turn.tracker.evaluate();
    expect(evaluation.state).toBe('hard-limit');
    expect(evaluation.reasons).toContain('maxRepeatedFingerprint');
  });

  it('trips the repeated-fingerprint limit when a text body repeats in error and body', async () => {
    // A plain-text 500: `error` is the body text, so both differ per call.
    const turn = guard();
    const limit = turn.snapshot.budget.maxRepeatedFingerprint;
    for (let index = 0; index <= limit; index += 1) {
      const text = `500 Internal Server Error, request ${index} at 10:00:0${index}`;
      await turn.afterToolCall(call({
        success: false, error: text, retryable: false, status: 500, body: text, expectedFailure: true,
      }));
    }
    expect(turn.tracker.usage.consecutiveErrors).toBe(0);
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(limit + 1);
    const evaluation = turn.tracker.evaluate();
    expect(evaluation.state).toBe('hard-limit');
    expect(evaluation.reasons).toContain('maxRepeatedFingerprint');
  });

  it('trips the repeated-fingerprint limit when a JSON message carries a trace id', async () => {
    const turn = guard();
    const limit = turn.snapshot.budget.maxRepeatedFingerprint;
    for (let index = 0; index <= limit; index += 1) {
      const message = `Access denied, traceId=abc${index}`;
      await turn.afterToolCall(call({ ...expected, error: message, body: { message } }));
    }
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(limit + 1);
    const evaluation = turn.tracker.evaluate();
    expect(evaluation.state).toBe('hard-limit');
    expect(evaluation.reasons).toContain('maxRepeatedFingerprint');
  });

  it('fingerprints an endpoint failure by its stable fields only, whatever else the result carries', async () => {
    const turn = guard();
    const limit = turn.snapshot.budget.maxRepeatedFingerprint;
    for (let index = 0; index <= limit; index += 1) {
      await turn.afterToolCall(call({ ...expected, requestId: `req-${index}`, details: { attempt: index } }));
    }
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(limit + 1);
    expect(turn.tracker.evaluate().reasons).toContain('maxRepeatedFingerprint');
  });

  it('keeps status, retryable and classification in the fingerprint of an endpoint failure', async () => {
    const turn = guard();
    await turn.afterToolCall(call({ ...error, body: 'a' }));
    await turn.afterToolCall(call({ ...error, status: 500, body: 'a' }));
    await turn.afterToolCall(call({ ...error, retryable: true, body: 'a' }));
    await turn.afterToolCall(call({ ...expected, body: 'a' }));
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(1);
  });

  it('keeps the error text in the fingerprint of a failure without a status', async () => {
    // A tool's own failure: its text is not backend noise.
    const turn = guard();
    await turn.afterToolCall(call({ success: false, error: 'Missing title', retryable: false }));
    await turn.afterToolCall(call({ success: false, error: 'Missing assignee', retryable: false }));
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(1);
    await turn.afterToolCall(call({ success: false, error: 'Missing title', retryable: false }));
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(2);
  });

  it('keeps the whole result in the fingerprint of a success', async () => {
    const turn = guard();
    await turn.afterToolCall(call({ body: 'a', tasks: [] }));
    await turn.afterToolCall(call({ body: 'b', tasks: [] }));
    expect(turn.tracker.usage.maxFingerprintRepeats).toBe(1);
  });
});

describe('createManagedTurnGuard: tool denials', () => {
  const viewer = { ...principal, roles: ['viewer'] };

  it('throws a typed, recoverable denial and counts it as a call and an error', async () => {
    const guard = createManagedTurnGuard({ snapshot: createSnapshot(), resolvePrincipal: async () => viewer });

    const denial = await guard.beforeToolCall({ toolName: 'list_tasks', input: {} }).catch((error: unknown) => error);
    expect(denial).toBeInstanceOf(ToolExecutionDeniedError);
    expect(denial).toMatchObject({
      reason: 'principal_role_denied',
      toolName: 'list_tasks',
      recoverable: true,
      message: 'Tool execution denied: principal_role_denied (list_tasks)',
    });
    expect(guard.tracker.usage).toMatchObject({ toolCalls: 1, consecutiveErrors: 1 });
    await expect(guard.resolveApproval({ toolName: 'list_tasks', input: {} }))
      .rejects.toMatchObject({ reason: 'principal_role_denied', recoverable: true });
  });

  it('reaches maxConsecutiveErrors through repeated denials', async () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-denials', agentRevision, manifestRevision, policyRevision, principal,
      localLimits: { ...localLimits, maxConsecutiveErrors: 2 },
    });
    const guard = createManagedTurnGuard({ snapshot, resolvePrincipal: async () => viewer });
    await expect(guard.beforeToolCall({ toolName: 'list_tasks', input: {} })).rejects.toThrow(/principal_role_denied/);
    await expect(guard.beforeToolCall({ toolName: 'list_tasks', input: {} })).rejects.toThrow(/principal_role_denied/);
    expect(guard.tracker.evaluate()).toMatchObject({ state: 'hard-limit', reasons: ['maxConsecutiveErrors'] });
    await expect(guard.beforeToolCall({ toolName: 'list_tasks', input: {} }))
      .rejects.toMatchObject({ reason: 'budget_exhausted', recoverable: false });
  });

  it('marks an unknown tool as a recoverable manifest_tool_unavailable denial', async () => {
    const guard = createManagedTurnGuard({ snapshot: createSnapshot(), resolvePrincipal: async () => principal });
    await expect(guard.beforeToolCall({ toolName: 'unknown_tool', input: {} }))
      .rejects.toMatchObject({ reason: 'manifest_tool_unavailable', recoverable: true });
  });

  it.each([
    { reason: 'missing_principal', resolved: undefined },
    { reason: 'tenant_mismatch', resolved: { ...principal, tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3aff' } },
  ])('keeps $reason terminal and uncounted', async ({ reason, resolved }) => {
    const guard = createManagedTurnGuard({ snapshot: createSnapshot(), resolvePrincipal: async () => resolved });
    await expect(guard.beforeToolCall({ toolName: 'list_tasks', input: {} }))
      .rejects.toMatchObject({ reason, recoverable: false });
    expect(guard.tracker.usage).toMatchObject({ toolCalls: 0, consecutiveErrors: 0 });
  });

  describe('a failing terminal check is never a recoverable denial', () => {
    // The checks that end a turn run before any recoverable denial. When one
    // of them cannot be evaluated, the guard fails closed: the plain error
    // propagates, uncounted, instead of the denial the model could recover from.
    const unreachable = new Error('revocation store unreachable');
    const noSession = new Error('session lookup failed');

    it.each([
      {
        label: 'loadRevocations rejecting for a tool not in the manifest', toolName: 'unknown_tool', error: unreachable,
        resolvePrincipal: async () => principal, loadRevocations: async () => { throw unreachable; },
      },
      {
        label: 'loadRevocations rejecting for a role-denied tool', toolName: 'list_tasks', error: unreachable,
        resolvePrincipal: async () => viewer, loadRevocations: async () => { throw unreachable; },
      },
      {
        label: 'resolvePrincipal rejecting for a tool not in the manifest', toolName: 'unknown_tool', error: noSession,
        resolvePrincipal: async () => { throw noSession; }, loadRevocations: async () => [],
      },
    ])('$label propagates the error, uncounted', async ({ toolName, error, resolvePrincipal, loadRevocations }) => {
      const guard = createManagedTurnGuard({ snapshot: createSnapshot(), resolvePrincipal, loadRevocations });
      const call = { toolName, input: {} };

      const before = await guard.beforeToolCall(call).then(() => 'resolved', (rejection: unknown) => rejection);
      expect(before).toBe(error);
      expect(before).not.toBeInstanceOf(ToolExecutionDeniedError);
      expect(isRecoverableToolDenial(before)).toBe(false);
      expect(guard.tracker.usage).toMatchObject({ toolCalls: 0, consecutiveErrors: 0 });

      const approval = await guard.resolveApproval(call).then(() => 'resolved', (rejection: unknown) => rejection);
      expect(approval).toBe(error);
      expect(isRecoverableToolDenial(approval)).toBe(false);
      expect(guard.tracker.usage).toMatchObject({ toolCalls: 0, consecutiveErrors: 0 });
    });
  });

  describe('terminal conditions win over a recoverable denial', () => {
    const otherTenant = { ...principal, tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3aff' };
    const revocation = (patch: Partial<SecurityRevocation>): SecurityRevocation => ({
      revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a09',
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
    const policyRevoked = revocation({ policyRevisionIds: [policyRevision.revisionId] });
    const toolRevoked = revocation({ toolIds: [agentRevision.toolAllowlist[0]!] });
    /** Pinned revisions under which `list_tasks` is denied with each recoverable reason. */
    type DeniedReason = 'agent_tool_denied' | 'manifest_tool_unavailable' | 'policy_tool_denied' | 'principal_role_denied';
    const denied: Record<DeniedReason, Partial<TurnSnapshot>> = {
      agent_tool_denied: { agentRevision: { ...agentRevision, toolAllowlist: [] } },
      manifest_tool_unavailable: {
        manifestRevision: { ...manifestRevision, tools: manifestRevision.tools.map((tool) => ({ ...tool, enabled: false })) },
      },
      policy_tool_denied: {
        policyRevision: {
          ...policyRevision,
          toolPolicies: policyRevision.toolPolicies.map((policy) => ({ ...policy, enabled: false })),
        },
      },
      principal_role_denied: {},
    };
    const snapshotFor = (reason: DeniedReason): TurnSnapshot => ({ ...createSnapshot(), ...denied[reason] });
    const principalFor = (reason: DeniedReason) => (reason === 'principal_role_denied' ? viewer : principal);

    const cases: Array<{
      label: string;
      expected: string;
      toolName: string;
      resolved: Principal | undefined;
      revocations?: SecurityRevocation[];
      snapshot?: TurnSnapshot;
    }> = [
      { label: 'expired session + tool not in the manifest', expected: 'missing_principal', toolName: 'unknown_tool', resolved: undefined },
      { label: 'tenant mismatch + tool not in the manifest', expected: 'tenant_mismatch', toolName: 'unknown_tool', resolved: otherTenant },
      {
        label: 'tenant mismatch + role-denied tool', expected: 'tenant_mismatch', toolName: 'list_tasks',
        resolved: { ...otherTenant, roles: ['viewer'] },
      },
      { label: 'revoked agent revision + role-denied tool', expected: 'revoked', toolName: 'list_tasks', resolved: viewer, revocations: [agentRevoked] },
      { label: 'revoked policy revision + role-denied tool', expected: 'revoked', toolName: 'list_tasks', resolved: viewer, revocations: [policyRevoked] },
      { label: 'revoked tool + role-denied tool', expected: 'revoked', toolName: 'list_tasks', resolved: viewer, revocations: [toolRevoked] },
      { label: 'revoked agent revision + tool not in the manifest', expected: 'revoked', toolName: 'unknown_tool', resolved: principal, revocations: [agentRevoked] },
      { label: 'revoked policy revision + tool not in the manifest', expected: 'revoked', toolName: 'unknown_tool', resolved: principal, revocations: [policyRevoked] },
      ...(['agent_tool_denied', 'manifest_tool_unavailable', 'policy_tool_denied'] as const).flatMap((reason) => [
        { label: `expired session + ${reason}`, expected: 'missing_principal', toolName: 'list_tasks', resolved: undefined, snapshot: snapshotFor(reason) },
        {
          label: `revoked agent revision + ${reason}`, expected: 'revoked', toolName: 'list_tasks', resolved: principal,
          revocations: [agentRevoked], snapshot: snapshotFor(reason),
        },
        {
          label: `revoked tool + ${reason}`, expected: 'revoked', toolName: 'list_tasks', resolved: principal,
          revocations: [toolRevoked], snapshot: snapshotFor(reason),
        },
      ]),
      // A missing principal outranks a revocation, as before.
      { label: 'expired session + revoked agent revision', expected: 'missing_principal', toolName: 'list_tasks', resolved: undefined, revocations: [agentRevoked] },
    ];

    it.each(cases)('$label ends the turn with $expected, uncounted', async ({ expected, toolName, resolved, revocations, snapshot }) => {
      const guard = createManagedTurnGuard({
        snapshot: snapshot ?? createSnapshot(),
        resolvePrincipal: async () => resolved,
        loadRevocations: async () => revocations ?? [],
      });
      const call = { toolName, input: {} };

      const denial = await guard.beforeToolCall(call).catch((error: unknown) => error);
      expect(denial).toBeInstanceOf(ToolExecutionDeniedError);
      expect(denial).toMatchObject({ reason: expected, toolName, recoverable: false });
      expect(guard.tracker.usage).toMatchObject({ toolCalls: 0, consecutiveErrors: 0 });
      await expect(guard.resolveApproval(call)).rejects.toMatchObject({ reason: expected, recoverable: false });
      await expect(guard.afterToolCall({ ...call, result: {}, durationMs: 1 }))
        .rejects.toMatchObject({ reason: expected, recoverable: false });
    });

    it.each(Object.keys(denied) as DeniedReason[])(
      'still recovers from %s when no terminal condition applies',
      async (reason) => {
        const future = revocation({
          agentRevisionIds: [agentRevision.revisionId],
          effectiveAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        const otherEnvironment = revocation({
          agentRevisionIds: [agentRevision.revisionId],
          environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3afe',
        });
        const guard = createManagedTurnGuard({
          snapshot: snapshotFor(reason),
          resolvePrincipal: async () => principalFor(reason),
          loadRevocations: async () => [future, otherEnvironment],
        });
        await expect(guard.beforeToolCall({ toolName: 'list_tasks', input: {} }))
          .rejects.toMatchObject({ reason, recoverable: true });
        expect(guard.tracker.usage).toMatchObject({ toolCalls: 1, consecutiveErrors: 1 });
      },
    );

    it('still recovers from a tool that is not in the manifest when no terminal condition applies', async () => {
      const guard = createManagedTurnGuard({
        snapshot: createSnapshot(),
        resolvePrincipal: async () => principal,
        loadRevocations: async () => [toolRevoked],
      });
      await expect(guard.beforeToolCall({ toolName: 'unknown_tool', input: {} }))
        .rejects.toMatchObject({ reason: 'manifest_tool_unavailable', recoverable: true });
      expect(guard.tracker.usage).toMatchObject({ toolCalls: 1, consecutiveErrors: 1 });
    });
  });
});
