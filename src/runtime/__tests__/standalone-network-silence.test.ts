import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecutionBudget,
  Principal,
} from '../../contracts/index.js';
import { createLocalRuntimeSource } from '../local-runtime-source.js';
import { createManagedTurnGuard } from '../managed-turn.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from '../local-tool-bindings.js';

const DIGEST = `sha256:${'A'.repeat(43)}`;
const ENDPOINT_TOOL_ID = '11111111-1111-4111-8111-111111111111';
const APP_ID = '33333333-3333-4333-8333-333333333333';

function budget(): ExecutionBudget {
  return {
    maxModelSteps: 8,
    maxToolCalls: 16,
    totalTimeoutMs: 60_000,
    toolTimeoutMs: 10_000,
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    maxEstimatedCostUsd: 1,
    maxRepeatedFingerprint: 3,
    maxConsecutiveErrors: 3,
    delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
  };
}

function fixtureArtifact(): unknown {
  return {
    schemaVersion: 1,
    artifactId: '44444444-4444-4444-8444-444444444444',
    runId: '55555555-5555-4555-8555-555555555555',
    appId: APP_ID,
    discoveryDigest: DIGEST,
    assessmentMode: 'autonomous',
    status: 'ready',
    tools: [{
      toolId: ENDPOINT_TOOL_ID,
      sourceFingerprint: DIGEST,
      name: 'tasks.listTasks',
      description: 'List the tasks the caller may see.',
      executionKind: 'endpoint',
      method: 'GET',
      path: '/api/tasks',
      authBindingRef: 'session',
      allowedRoles: ['member'],
      operationGroup: 'read',
      riskClass: 'safe-read',
      enabled: true,
      requiresApproval: false,
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST,
    }],
    planner: {
      plannerId: '66666666-6666-4666-8666-666666666666',
      modelBindingRef: 'default-model',
      promptBindingRef: 'default-prompt',
      budgetProfileRef: 'default-budget',
      toolIds: [ENDPOINT_TOOL_ID],
    },
    prompts: {
      bundleDigest: DIGEST,
      artifactRef: '.glirastes/prompt-bundle.json',
      plannerDigest: DIGEST,
      appBehaviorDigest: DIGEST,
      responseStyleDigest: DIGEST,
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function fixtureBindings(): LocalToolBinding[] {
  return [{
    executionKind: 'endpoint',
    toolId: ENDPOINT_TOOL_ID,
    sourceFingerprint: DIGEST,
    inputSchemaDigest: DIGEST,
    outputSchemaDigest: DIGEST,
    method: 'GET',
    path: '/api/tasks',
    tool: {
      id: 'tasks.listTasks',
      description: 'List the tasks the caller may see.',
      inputSchema: { type: 'object' },
      execute: async () => ({ tasks: [] }),
    },
  }];
}

function principalFor(tenantId: string): Principal {
  return {
    subjectId: 'user-1',
    tenantId,
    roles: ['member'],
    attributes: {},
  };
}

describe('standalone runtime is strictly network-silent', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn(() => {
    throw new Error('standalone must not touch the network');
  });

  beforeEach(() => {
    fetchSpy.mockClear();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('boots, materializes, authorizes, and executes without one fetch', async () => {
    const source = createLocalRuntimeSource({
      setupArtifact: fixtureArtifact(),
      bindings: fixtureBindings(),
      localLimits: budget(),
    });
    const principal = principalFor(source.identity.tenantId);
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });
    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: () => principal,
    });

    const call = {
      toolCallId: 'call-1',
      toolName: 'tasks_listTasks',
      input: {},
    };
    await guard.beforeToolCall(call);
    const result = await registry.tasks_listTasks!.execute(
      {},
      { user: { id: 'user-1', roles: ['member'] } },
    );
    await guard.afterToolCall({ ...call, output: result });
    await guard.afterModelStep({ inputTokens: 10, outputTokens: 10 });

    expect(result).toEqual({ tasks: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
