import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ExecutionBudget,
  Principal,
} from '../../contracts/index.js';
import { assertModuleRegistryParity } from '../../server/testing/registry-parity.js';
import { createEphemeralLocalSigner } from '../local-signer.js';
import { createLocalRuntimeSource } from '../local-runtime-source.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from '../local-tool-bindings.js';
import { createTurnSnapshot } from '../turn-snapshot.js';

const DIGEST = `sha256:${'A'.repeat(43)}`;
const ENDPOINT_TOOL_ID = '11111111-1111-4111-8111-111111111111';
const UI_TOOL_ID = '22222222-2222-4222-8222-222222222222';
const APP_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '99999999-9999-4999-8999-999999999999';
const ENVIRONMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

const TOOL_FACTS = [
  {
    toolId: ENDPOINT_TOOL_ID,
    name: 'tasks.listTasks',
    description: 'List the tasks the caller may see.',
    executionKind: 'endpoint' as const,
    method: 'GET' as const,
    path: '/api/tasks',
    riskClass: 'safe-read' as const,
    requiresApproval: false,
    allowedRoles: ['member'],
  },
  {
    toolId: UI_TOOL_ID,
    name: 'ui.navigate',
    description: 'Navigate the app to a named view.',
    executionKind: 'ui' as const,
    actionBindingRef: 'navigate',
    riskClass: 'safe-read' as const,
    requiresApproval: false,
    allowedRoles: ['member'],
  },
];

function fixtureBindings(): LocalToolBinding[] {
  return TOOL_FACTS.map((fact) => {
    const base = {
      toolId: fact.toolId,
      sourceFingerprint: DIGEST,
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST,
      tool: {
        id: fact.name,
        description: fact.description,
        inputSchema: { type: 'object' },
        execute: async () => ({}),
      },
    };
    return fact.executionKind === 'endpoint'
      ? {
        ...base,
        executionKind: 'endpoint' as const,
        method: fact.method!,
        path: fact.path!,
      }
      : {
        ...base,
        executionKind: 'ui' as const,
        actionBindingRef: fact.actionBindingRef!,
      };
  });
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
    tools: TOOL_FACTS.map((fact) => ({
      toolId: fact.toolId,
      sourceFingerprint: DIGEST,
      name: fact.name,
      description: fact.description,
      executionKind: fact.executionKind,
      ...(fact.executionKind === 'endpoint'
        ? { method: fact.method, path: fact.path, authBindingRef: 'session' }
        : { actionBindingRef: fact.actionBindingRef }),
      allowedRoles: fact.allowedRoles,
      operationGroup: fact.executionKind === 'ui' ? 'ui' : 'read',
      riskClass: fact.riskClass,
      enabled: true,
      requiresApproval: fact.requiresApproval,
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST,
    })),
    planner: {
      plannerId: '66666666-6666-4666-8666-666666666666',
      modelBindingRef: 'default-model',
      promptBindingRef: 'default-prompt',
      budgetProfileRef: 'default-budget',
      toolIds: TOOL_FACTS.map((fact) => fact.toolId),
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

/** A platform-shaped snapshot carrying the same tool facts, signed like managed. */
function managedStyleSnapshot(principal: Principal) {
  const signer = createEphemeralLocalSigner();
  const manifestRevision = signer.sign({
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    revision: 7,
    tenantId: TENANT_ID,
    targetAppId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    sourceDigest: DIGEST,
    tools: TOOL_FACTS.map((fact) => ({
      toolId: fact.toolId,
      sourceFingerprint: DIGEST,
      name: fact.name,
      description: fact.description,
      riskClass: fact.riskClass,
      enabled: true,
      tombstone: false,
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST,
      ...(fact.executionKind === 'endpoint'
        ? {
          executionKind: 'endpoint' as const,
          method: fact.method!,
          path: fact.path!,
          authBindingRef: 'session',
        }
        : {
          executionKind: 'ui' as const,
          actionBindingRef: fact.actionBindingRef!,
        }),
    })),
    publishedAt: '2026-08-12T00:00:00.000Z',
  });
  const agentRevision = signer.sign({
    revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    revision: 7,
    agentId: '66666666-6666-4666-8666-666666666666',
    tenantId: TENANT_ID,
    name: 'Managed planner',
    objective: 'Serve the published inventory.',
    modelAlias: 'default-model',
    promptBindingRef: 'default-prompt',
    toolAllowlist: TOOL_FACTS.map((fact) => fact.toolId),
    budget: budget(),
    publishedAt: '2026-08-12T00:00:00.000Z',
  });
  const policyRevision = signer.sign({
    revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    revision: 7,
    tenantId: TENANT_ID,
    environmentId: ENVIRONMENT_ID,
    budget: budget(),
    toolPolicies: TOOL_FACTS.map((fact) => ({
      toolId: fact.toolId,
      enabled: true,
      riskClass: fact.riskClass,
      requiresApproval: fact.requiresApproval,
      allowedRoles: fact.allowedRoles,
    })),
    publishedAt: '2026-08-12T00:00:00.000Z',
  });
  return createTurnSnapshot({
    turnId: 'managed-turn',
    agentRevision,
    manifestRevision,
    policyRevision,
    principal,
    localLimits: budget(),
  });
}

function principalFor(tenantId: string): Principal {
  return {
    subjectId: 'user-1',
    tenantId,
    roles: ['member'],
    attributes: {},
  };
}

describe('managed and standalone sources materialize identically', () => {
  it('exposes identical registries for identical tool facts', () => {
    const source = createLocalRuntimeSource({
      setupArtifact: fixtureArtifact(),
      bindings: fixtureBindings(),
      localLimits: budget(),
    });
    const standaloneRegistry = materializeManifestToolRegistry({
      snapshot: source.resolveTurnSnapshot({
        turnId: 't-1',
        principal: principalFor(source.identity.tenantId),
      }),
      bindings: fixtureBindings(),
    });
    const managedRegistry = materializeManifestToolRegistry({
      snapshot: managedStyleSnapshot(principalFor(TENANT_ID)),
      bindings: fixtureBindings(),
    });

    expect(Object.keys(standaloneRegistry).sort())
      .toEqual(Object.keys(managedRegistry).sort());
    for (const name of Object.keys(managedRegistry)) {
      expect(standaloneRegistry[name]!.description)
        .toBe(managedRegistry[name]!.description);
      expect(standaloneRegistry[name]!.needsApproval)
        .toBe(managedRegistry[name]!.needsApproval);
    }
  });

  it('passes the shared module parity gate from both sources', () => {
    const modules = [
      { id: 'tasks', tools: ['tasks.listTasks'] },
      { id: 'navigation', tools: ['ui_navigate'] },
    ];
    const source = createLocalRuntimeSource({
      setupArtifact: fixtureArtifact(),
      bindings: fixtureBindings(),
      localLimits: budget(),
    });
    const standaloneRegistry = materializeManifestToolRegistry({
      snapshot: source.resolveTurnSnapshot({
        turnId: 't-1',
        principal: principalFor(source.identity.tenantId),
      }),
      bindings: fixtureBindings(),
    });
    const managedRegistry = materializeManifestToolRegistry({
      snapshot: managedStyleSnapshot(principalFor(TENANT_ID)),
      bindings: fixtureBindings(),
    });

    for (const registry of [standaloneRegistry, managedRegistry]) {
      expect(() => assertModuleRegistryParity({
        modules,
        servedToolNames: Object.keys(registry),
      })).not.toThrow();
      expect(() => assertModuleRegistryParity({
        modules: [{ id: 'ghost', tools: ['tasks.retiredSnakeCase'] }],
        servedToolNames: Object.keys(registry),
      })).toThrow(/drift/i);
    }
  });
});
