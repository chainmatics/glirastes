import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentRevisionSchema,
  ManifestRevisionSchema,
  RuntimePolicyRevisionSchema,
  type ExecutionBudget,
  type Principal,
} from '../../contracts/index.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from '../local-tool-bindings.js';
import {
  createLocalRuntimeSource,
  type LocalRuntimeSourceOptions,
} from '../local-runtime-source.js';

const DIGEST = `sha256:${'A'.repeat(43)}`;
const ENDPOINT_TOOL_ID = '11111111-1111-4111-8111-111111111111';
const UI_TOOL_ID = '22222222-2222-4222-8222-222222222222';
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
    tools: [
      {
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
      },
      {
        toolId: UI_TOOL_ID,
        sourceFingerprint: DIGEST,
        name: 'ui.navigate',
        description: 'Navigate the app to a named view.',
        executionKind: 'ui',
        actionBindingRef: 'navigate',
        allowedRoles: ['member'],
        operationGroup: 'ui',
        riskClass: 'safe-read',
        enabled: true,
        requiresApproval: false,
        inputSchemaDigest: DIGEST,
        outputSchemaDigest: DIGEST,
      },
    ],
    planner: {
      plannerId: '66666666-6666-4666-8666-666666666666',
      modelBindingRef: 'default-model',
      promptBindingRef: 'default-prompt',
      budgetProfileRef: 'default-budget',
      toolIds: [ENDPOINT_TOOL_ID, UI_TOOL_ID],
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
  const tool = (id: string, description: string) => ({
    id,
    description,
    inputSchema: { type: 'object' },
    execute: async () => ({}),
  });
  return [
    {
      executionKind: 'endpoint',
      toolId: ENDPOINT_TOOL_ID,
      sourceFingerprint: DIGEST,
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST,
      method: 'GET',
      path: '/api/tasks',
      tool: tool('tasks.listTasks', 'List the tasks the caller may see.'),
    },
    {
      executionKind: 'ui',
      toolId: UI_TOOL_ID,
      sourceFingerprint: DIGEST,
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST,
      actionBindingRef: 'navigate',
      tool: tool('ui.navigate', 'Navigate the app to a named view.'),
    },
  ];
}

function fixturePromptBundle(): unknown {
  const sections = {
    planner: 'Plan with the available tools.',
    appBehavior: 'Get It Done behaves like Get It Done.',
    responseStyle: 'Answer briefly.',
    capabilityFragments: [],
  };
  const bundleDigest = `sha256:${createHash('sha256')
    .update(canonicalRuntimeJson(sections))
    .digest('base64url')}`;
  return {
    schemaVersion: 1,
    bundleId: '77777777-7777-4777-8777-777777777777',
    appId: APP_ID,
    revisionId: '88888888-8888-4888-8888-888888888888',
    revision: 1,
    bundleDigest,
    sections,
    createdAt: '2026-08-12T00:00:00.000Z',
  };
}

function fixtureOptions(
  overrides: Partial<LocalRuntimeSourceOptions> = {},
): LocalRuntimeSourceOptions {
  return {
    setupArtifact: fixtureArtifact(),
    bindings: fixtureBindings(),
    localLimits: budget(),
    ...overrides,
  };
}

function fixturePrincipal(tenantId: string): Principal {
  return {
    subjectId: 'user-1',
    tenantId,
    roles: ['member'],
    attributes: {},
  };
}

describe('createLocalRuntimeSource', () => {
  it('materializes schema-valid, self-signed revisions at boot', () => {
    const source = createLocalRuntimeSource(fixtureOptions());
    const snapshot = source.resolveTurnSnapshot({
      turnId: 't-1',
      principal: fixturePrincipal(source.identity.tenantId),
    });
    ManifestRevisionSchema.parse(snapshot.manifestRevision);
    AgentRevisionSchema.parse(snapshot.agentRevision);
    RuntimePolicyRevisionSchema.parse(snapshot.policyRevision);
    expect(snapshot.manifestRevision.signature.keyId).toBe(source.keyId);
    expect(snapshot.agentRevision.signature.keyId).toBe(source.keyId);
    expect(snapshot.policyRevision.signature.keyId).toBe(source.keyId);
  });

  it('yields a registry in the model-safe manifest name domain', () => {
    const source = createLocalRuntimeSource(fixtureOptions());
    const snapshot = source.resolveTurnSnapshot({
      turnId: 't-1',
      principal: fixturePrincipal(source.identity.tenantId),
    });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });
    expect(Object.keys(registry).sort()).toEqual([
      'tasks_listTasks',
      'ui_navigate',
    ]);
    expect(registry.tasks_listTasks!.needsApproval).toBe(false);
  });

  it('pins one snapshot per turnId and keeps the tenant gate closed', () => {
    const source = createLocalRuntimeSource(fixtureOptions());
    const principal = fixturePrincipal(source.identity.tenantId);
    const first = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const again = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    expect(again).toBe(first);
    expect(() => source.resolveTurnSnapshot({
      turnId: 't-2',
      principal: fixturePrincipal('someone-elses-tenant'),
    })).toThrow(/tenant/i);
  });

  it('derives a stable identity across boots', () => {
    const first = createLocalRuntimeSource(fixtureOptions());
    const second = createLocalRuntimeSource(fixtureOptions());
    expect(second.identity).toEqual(first.identity);
  });

  it('rejects a setup artifact that fails the contract schema', () => {
    expect(() => createLocalRuntimeSource(
      fixtureOptions({ setupArtifact: { nope: true } }),
    )).toThrow();
  });

  it('fails closed on disabled tools and missing risk assessments', () => {
    const artifact = fixtureArtifact() as {
      tools: Array<Record<string, unknown>>;
      planner: { toolIds: string[] };
    };
    artifact.tools[0]!.enabled = false;
    const source = createLocalRuntimeSource(
      fixtureOptions({ setupArtifact: artifact }),
    );
    const snapshot = source.resolveTurnSnapshot({
      turnId: 't-1',
      principal: fixturePrincipal(source.identity.tenantId),
    });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });
    expect(Object.keys(registry)).toEqual(['ui_navigate']);
  });

  it('carries the prompt pin when a prompt bundle is provided', () => {
    const source = createLocalRuntimeSource(
      fixtureOptions({ promptBundle: fixturePromptBundle() }),
    );
    const snapshot = source.resolveTurnSnapshot({
      turnId: 't-1',
      principal: fixturePrincipal(source.identity.tenantId),
    });
    expect(snapshot.promptPin?.revision).toBe(1);
    expect(snapshot.promptPin?.bundleDigest).toMatch(/^sha256:/);
  });

  it('rejects a prompt bundle whose digest does not match its sections', () => {
    const bundle = fixturePromptBundle() as { bundleDigest: string };
    bundle.bundleDigest = DIGEST;
    expect(() => createLocalRuntimeSource(
      fixtureOptions({ promptBundle: bundle }),
    )).toThrow(/digest/i);
  });
});
