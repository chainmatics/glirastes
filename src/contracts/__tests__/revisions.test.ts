import { describe, expect, it } from 'vitest';
import {
  AgentRevisionSchema,
  ManifestRevisionSchema,
  RuntimePolicyRevisionSchema,
} from '../revisions.js';
import { TechnicalRuntimeEventSchema } from '../events.js';

const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'runtime-signing-2026-01',
  value: 'c2lnbmF0dXJl',
};

const budget = {
  maxModelSteps: 12,
  maxToolCalls: 8,
  totalTimeoutMs: 120_000,
  toolTimeoutMs: 15_000,
  maxInputTokens: 40_000,
  maxOutputTokens: 8_000,
  maxEstimatedCostUsd: 2,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 2, maxBreadth: 3, sharedBudget: true },
};

describe('ManifestRevisionSchema', () => {
  const manifest = {
    revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
    revision: 1,
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
    targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
    environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
    sourceDigest: 'sha256:manifest',
    publishedAt: '2026-07-28T20:00:00.000Z',
    signature,
    tools: [{
      toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      sourceFingerprint: 'sha256:tool',
      executionKind: 'endpoint',
      name: 'list_tasks',
      description: 'List visible tasks.',
      riskClass: 'safe-read',
      enabled: true,
      tombstone: false,
      method: 'GET',
      path: '/api/tasks',
      inputSchemaDigest: 'sha256:input',
      outputSchemaDigest: 'sha256:output',
      authBindingRef: 'task-session',
    }],
  };

  it('accepts immutable tool identity and source fingerprints', () => {
    expect(ManifestRevisionSchema.parse(manifest).tools[0]?.toolId)
      .toBe(manifest.tools[0]?.toolId);
  });

  it('rejects a tombstone that remains enabled', () => {
    const candidate = structuredClone(manifest);
    candidate.tools[0]!.tombstone = true;
    expect(ManifestRevisionSchema.safeParse(candidate).success).toBe(false);
  });

  it('accepts a local UI action binding without an HTTP endpoint', () => {
    const uiTool = {
      ...manifest.tools[0],
      toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
      sourceFingerprint: 'sha256:ui-tool',
      executionKind: 'ui',
      name: 'open_task_details',
      riskClass: 'safe-read',
      actionBindingRef: 'task-details.open',
    };
    delete (uiTool as Partial<typeof uiTool>).method;
    delete (uiTool as Partial<typeof uiTool>).path;
    delete (uiTool as Partial<typeof uiTool>).authBindingRef;

    expect(ManifestRevisionSchema.safeParse({
      ...manifest,
      tools: [uiTool],
    }).success).toBe(true);
  });

  it('rejects secret-bearing revision payloads', () => {
    expect(ManifestRevisionSchema.safeParse({
      ...manifest,
      bindings: [{
        bindingId: 'model-primary',
        kind: 'model',
        secret: 'provider-secret',
      }],
    }).success).toBe(false);
  });
});

describe('agent and policy revisions', () => {
  it('accepts local binding references instead of values', () => {
    expect(AgentRevisionSchema.safeParse({
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3910',
      revision: 3,
      agentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3911',
      tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3912',
      name: 'Get It Done Assistant',
      objective: 'Help users complete task-management outcomes.',
      modelAlias: 'standard',
      promptBindingRef: 'gid-assistant-v3',
      toolAllowlist: ['019fa9a9-d5f7-7ec3-a3c7-8899de1d3913'],
      budget,
      publishedAt: '2026-07-28T20:00:00.000Z',
      signature,
    }).success).toBe(true);
  });

  it('rejects raw prompts in a control-plane agent revision', () => {
    expect(AgentRevisionSchema.safeParse({
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3910',
      revision: 3,
      agentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3911',
      tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3912',
      name: 'Assistant',
      objective: 'Help.',
      modelAlias: 'standard',
      promptBindingRef: 'gid-assistant-v3',
      systemPrompt: 'Sensitive customer prompt',
      toolAllowlist: [],
      budget,
      publishedAt: '2026-07-28T20:00:00.000Z',
      signature,
    }).success).toBe(false);
  });

  it('requires a signed positive runtime-policy revision', () => {
    expect(RuntimePolicyRevisionSchema.safeParse({
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3920',
      revision: 0,
      tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3921',
      environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3922',
      budget,
      toolPolicies: [],
      publishedAt: '2026-07-28T20:00:00.000Z',
      signature,
    }).success).toBe(false);
  });
});

describe('TechnicalRuntimeEventSchema', () => {
  const event = {
    eventId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3930',
    occurredAt: '2026-07-28T20:00:00.000Z',
    eventType: 'run.completed',
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3931',
    targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3932',
    environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3933',
    agentRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3934',
    runId: 'run-1',
    status: 'completed',
    durationMs: 422,
    budget: { modelSteps: 2, toolCalls: 1, inputTokens: 120, outputTokens: 30 },
    metadata: { rollout: 'stable' },
  };

  it('accepts content-free operational metadata', () => {
    expect(TechnicalRuntimeEventSchema.parse(event).status).toBe('completed');
  });

  it.each([
    { prompt: 'show all tasks' },
    { toolArguments: { tenantId: 'customer-value' } },
    { result: { title: 'customer task' } },
    { nested: { authorization: 'Bearer secret' } },
  ])('rejects content or credentials in metadata', (metadata) => {
    expect(TechnicalRuntimeEventSchema.safeParse({
      ...event,
      metadata,
    }).success).toBe(false);
  });
});
