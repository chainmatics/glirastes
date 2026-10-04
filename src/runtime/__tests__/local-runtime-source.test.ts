import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRevisionSchema,
  ManifestRevisionSchema,
  RuntimePolicyRevisionSchema,
  type ExecutionBudget,
  type Principal,
  type SecurityRevocation,
} from '../../contracts/index.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from '../local-tool-bindings.js';
import {
  createLocalRuntimeSource,
  type LocalRuntimeSourceOptions,
  type PlatformRevisionRefs,
} from '../local-runtime-source.js';
import { createManagedTurnGuard } from '../managed-turn.js';
import type { VerifiedPolicyOverlay } from '../policy-overlay.js';
import { isToolRevoked } from '../turn-snapshot.js';

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
        presentation: {
          locale: 'de-DE',
          singular: 'Aufgabenliste',
          plural: 'Aufgabenlisten',
          approval: 'Aufgabenliste anzeigen',
        },
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
        presentation: {
          locale: 'de-DE',
          singular: 'Navigation',
          plural: 'Navigationen',
          approval: 'Ansicht wechseln',
        },
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
    inputSchema: { safeParse: (value: unknown) => ({ success: true as const, data: value }) },
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
    expect(snapshot.manifestRevision.tools[0]?.presentation?.approval)
      .toBe('Aufgabenliste anzeigen');
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

  it('never lets a tier-3 tool run unattended', () => {
    const artifact = fixtureArtifact() as {
      tools: Array<Record<string, unknown>>;
    };
    artifact.tools[0]!.riskClass = 'delete';
    artifact.tools[0]!.requiresApproval = false;
    const source = createLocalRuntimeSource(
      fixtureOptions({ setupArtifact: artifact }),
    );
    const snapshot = source.resolveTurnSnapshot({
      turnId: 't-1',
      principal: fixturePrincipal(source.identity.tenantId),
    });
    expect(snapshot.policyRevision.toolPolicies[0]).toMatchObject({
      toolId: ENDPOINT_TOOL_ID,
      riskClass: 'delete',
      requiresApproval: true,
    });
  });
});

describe('createLocalRuntimeSource with a verified Platform overlay', () => {
  const PLATFORM_IDENTITY = {
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targetAppId: APP_ID,
    environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const OVERLAY_REVISION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const REMOVED_TOOL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const PLATFORM_AGENT_REVISION_ID = '12121212-1212-4212-8212-121212121212';
  const PLATFORM_MANIFEST_REVISION_ID = '13131313-1313-4313-8313-131313131313';
  const principal = fixturePrincipal(PLATFORM_IDENTITY.tenantId);
  const PLATFORM_REVISIONS: PlatformRevisionRefs = {
    agentRevision: { revisionId: PLATFORM_AGENT_REVISION_ID, revision: 7 },
    manifestRevision: { revisionId: PLATFORM_MANIFEST_REVISION_ID, revision: 5 },
  };

  function revocation(
    targets: Partial<Pick<
      SecurityRevocation,
      'toolIds' | 'agentRevisionIds' | 'policyRevisionIds'
    >>,
  ): SecurityRevocation {
    return {
      revocationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      environmentId: PLATFORM_IDENTITY.environmentId,
      effectiveAt: '2026-08-12T00:00:00.000Z',
      reasonCode: 'security-disable',
      toolIds: [],
      agentRevisionIds: [],
      policyRevisionIds: [],
      ...targets,
      signature: {
        algorithm: 'Ed25519',
        keyId: 'platform-key',
        value: 'c2lnbmF0dXJl',
      },
    };
  }

  const AFTER_REVOCATION = new Date('2026-08-12T00:00:01.000Z');

  function overlay(
    entries: VerifiedPolicyOverlay['entries'],
    extra: Partial<VerifiedPolicyOverlay> = {},
  ): VerifiedPolicyOverlay {
    return { revisionId: OVERLAY_REVISION_ID, revision: 3, entries, ...extra };
  }

  function managedSource(
    policyOverlay: () => VerifiedPolicyOverlay | undefined,
    onPolicyOverlayApplied?: LocalRuntimeSourceOptions['onPolicyOverlayApplied'],
    platformRevisions: () => PlatformRevisionRefs | undefined =
      () => PLATFORM_REVISIONS,
  ) {
    return createLocalRuntimeSource(fixtureOptions({
      identity: PLATFORM_IDENTITY,
      policyOverlay,
      platformRevisions,
      ...(onPolicyOverlayApplied ? { onPolicyOverlayApplied } : {}),
    }));
  }

  it('runs a new local tool that the Platform has not seen yet', () => {
    expect(createLocalRuntimeSource(fixtureOptions()).mode).toBe('standalone');
    const source = managedSource(() => overlay([
      { toolId: ENDPOINT_TOOL_ID, enabled: true },
    ]));
    expect(source.mode).toBe('managed');

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });

    expect(Object.keys(registry).sort()).toEqual(['tasks_listTasks', 'ui_navigate']);
  });

  it('applies the overlay restrict-only and ignores ids the code does not have', async () => {
    const applied = vi.fn();
    const source = managedSource(() => overlay([
      { toolId: ENDPOINT_TOOL_ID, riskClass: 'delete', requiresApproval: false },
      { toolId: UI_TOOL_ID, enabled: false },
      { toolId: REMOVED_TOOL_ID, enabled: true, requiresApproval: false },
    ]), applied);

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });

    expect(snapshot.policyRevision.revisionId).toBe(OVERLAY_REVISION_ID);
    expect(snapshot.policyRevision.toolPolicies).toEqual([
      {
        toolId: ENDPOINT_TOOL_ID,
        enabled: true,
        riskClass: 'delete',
        requiresApproval: true,
        allowedRoles: ['member'],
      },
      {
        toolId: UI_TOOL_ID,
        enabled: false,
        riskClass: 'safe-read',
        requiresApproval: false,
        allowedRoles: ['member'],
      },
    ]);
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: REMOVED_TOOL_ID, reason: 'platform-tool-not-in-code' }],
    });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });
    expect(Object.keys(registry)).toEqual(['tasks_listTasks']);
    expect(registry.tasks_listTasks!.needsApproval).toBe(true);

    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });
    await expect(guard.beforeToolCall({
      toolName: 'tasks_removedTask',
      input: {},
    })).rejects.toThrow(/manifest_tool_unavailable/);
  });

  it('pins each turn to the overlay it started with and never calls the network', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      let current = overlay([{ toolId: ENDPOINT_TOOL_ID, enabled: true }]);
      const getOverlay = vi.fn(() => current);
      const source = managedSource(getOverlay);

      const first = source.resolveTurnSnapshot({ turnId: 't-1', principal });
      current = overlay(
        [{ toolId: ENDPOINT_TOOL_ID, enabled: false }],
        { revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', revision: 4 },
      );

      expect(source.resolveTurnSnapshot({ turnId: 't-1', principal }))
        .toBe(first);
      const next = source.resolveTurnSnapshot({ turnId: 't-2', principal });
      expect(first.policyRevision.toolPolicies[0])
        .toMatchObject({ toolId: ENDPOINT_TOOL_ID, enabled: true });
      expect(next.policyRevision.toolPolicies[0])
        .toMatchObject({ toolId: ENDPOINT_TOOL_ID, enabled: false });
      expect(getOverlay).toHaveBeenCalledTimes(2);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps revocations of the Platform policy revision effective', () => {
    const source = managedSource(() => overlay([]));
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });

    expect(isToolRevoked(
      snapshot,
      ENDPOINT_TOOL_ID,
      [revocation({ policyRevisionIds: [OVERLAY_REVISION_ID] })],
      AFTER_REVOCATION,
    )).toBe(true);
  });

  it('keeps revocations of the Platform agent revision effective', () => {
    const source = managedSource(() => overlay([]));
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });

    expect(snapshot.agentRevision).toMatchObject({
      revisionId: PLATFORM_AGENT_REVISION_ID,
      revision: 7,
    });
    expect(snapshot.manifestRevision).toMatchObject({
      revisionId: PLATFORM_MANIFEST_REVISION_ID,
      revision: 5,
    });
    AgentRevisionSchema.parse(snapshot.agentRevision);
    ManifestRevisionSchema.parse(snapshot.manifestRevision);
    expect(isToolRevoked(
      snapshot,
      ENDPOINT_TOOL_ID,
      [revocation({ agentRevisionIds: [PLATFORM_AGENT_REVISION_ID] })],
      AFTER_REVOCATION,
    )).toBe(true);
  });

  it('pins each turn to the Platform revisions it started with', () => {
    let current = PLATFORM_REVISIONS;
    const source = managedSource(() => overlay([]), undefined, () => current);
    const first = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    current = {
      agentRevision: {
        revisionId: '14141414-1414-4414-8414-141414141414',
        revision: 8,
      },
      manifestRevision: PLATFORM_REVISIONS.manifestRevision,
    };
    const next = source.resolveTurnSnapshot({ turnId: 't-2', principal });

    expect(source.resolveTurnSnapshot({ turnId: 't-1', principal }))
      .toBe(first);
    expect(first.agentRevision.revisionId).toBe(PLATFORM_AGENT_REVISION_ID);
    expect(next.agentRevision).toMatchObject({
      revisionId: '14141414-1414-4414-8414-141414141414',
      revision: 8,
    });
    expect(next.manifestRevision.revisionId)
      .toBe(PLATFORM_MANIFEST_REVISION_ID);
  });

  // Regression guard (green before the change): no Platform revision is in
  // effect yet, so only tool-id revocations can apply, and those match.
  it('runs on the local base before the first accepted deployment', () => {
    const managed = managedSource(() => undefined, undefined, () => undefined)
      .resolveTurnSnapshot({ turnId: 't-1', principal });
    const standalone = createLocalRuntimeSource(fixtureOptions({
      identity: PLATFORM_IDENTITY,
    })).resolveTurnSnapshot({ turnId: 't-1', principal });

    expect(managed.agentRevision.revisionId)
      .toBe(standalone.agentRevision.revisionId);
    expect(managed.policyRevision.revisionId)
      .toBe(standalone.policyRevision.revisionId);
    expect(isToolRevoked(
      managed,
      ENDPOINT_TOOL_ID,
      [revocation({ toolIds: [ENDPOINT_TOOL_ID] })],
      AFTER_REVOCATION,
    )).toBe(true);
  });

  it('refuses a turn whose overlay and Platform revisions disagree', () => {
    expect(() => managedSource(() => overlay([]), undefined, () => undefined)
      .resolveTurnSnapshot({ turnId: 't-1', principal }))
      .toThrow(/same accepted deployment/);
    expect(() => managedSource(() => undefined)
      .resolveTurnSnapshot({ turnId: 't-1', principal }))
      .toThrow(/same accepted deployment/);
  });

  it('applies an overlay budget only as a further restriction', () => {
    const tighter = managedSource(() => overlay([], {
      budget: { ...budget(), maxToolCalls: 4 },
    }));
    const looser = managedSource(() => overlay([], {
      budget: { ...budget(), maxToolCalls: 99 },
    }));

    expect(tighter.resolveTurnSnapshot({ turnId: 't-1', principal })
      .budget.maxToolCalls).toBe(4);
    expect(looser.resolveTurnSnapshot({ turnId: 't-1', principal })
      .budget.maxToolCalls).toBe(16);
  });

  it('never enables a tool the local artifact keeps disabled', () => {
    const artifact = fixtureArtifact() as {
      tools: Array<Record<string, unknown>>;
    };
    artifact.tools[1]!.operationGroup = 'needs_attention';
    artifact.tools[1]!.enabled = false;
    const applied = vi.fn();
    const source = createLocalRuntimeSource(fixtureOptions({
      setupArtifact: artifact,
      identity: PLATFORM_IDENTITY,
      policyOverlay: () => overlay([
        { toolId: UI_TOOL_ID, enabled: true, requiresApproval: false },
      ]),
      platformRevisions: () => PLATFORM_REVISIONS,
      onPolicyOverlayApplied: applied,
    }));

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });

    expect(Object.keys(registry)).toEqual(['tasks_listTasks']);
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: UI_TOOL_ID, reason: 'platform-tool-not-in-code' }],
    });
  });

  it('refuses managed mode without the Platform tenant and environment', () => {
    expect(() => createLocalRuntimeSource(fixtureOptions({
      policyOverlay: () => overlay([]),
      platformRevisions: () => PLATFORM_REVISIONS,
    }))).toThrow(/Platform tenantId and environmentId/);
    expect(() => createLocalRuntimeSource(fixtureOptions({
      identity: { tenantId: PLATFORM_IDENTITY.tenantId },
      policyOverlay: () => overlay([]),
      platformRevisions: () => PLATFORM_REVISIONS,
    }))).toThrow(/Platform tenantId and environmentId/);
  });

  it('refuses managed mode without the Platform revisions and vice versa', () => {
    expect(() => createLocalRuntimeSource(fixtureOptions({
      identity: PLATFORM_IDENTITY,
      policyOverlay: () => overlay([]),
    }))).toThrow(/policyOverlay and platformRevisions/);
    expect(() => createLocalRuntimeSource(fixtureOptions({
      identity: PLATFORM_IDENTITY,
      platformRevisions: () => PLATFORM_REVISIONS,
    }))).toThrow(/policyOverlay and platformRevisions/);
  });
});
