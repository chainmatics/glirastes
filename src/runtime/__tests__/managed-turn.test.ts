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
});
