import { describe, expect, it, vi } from 'vitest';
import type { Principal, SecurityRevocation } from '../../contracts/index.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from './turn-snapshot.test.js';
import { createTurnSnapshot } from '../turn-snapshot.js';
import { createManagedTurnGuard } from '../managed-turn.js';

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
    })).rejects.toThrow(/maxToolCalls/);
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
