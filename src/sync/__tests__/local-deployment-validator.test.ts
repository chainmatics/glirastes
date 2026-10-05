import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolRiskClass } from '../../contracts/index.js';
import type { LocalToolBinding } from '../../runtime/local-tool-bindings.js';
import type { MaterializedDeploymentRevisions } from '../materialize-deployment.js';
import { validateLocalDeploymentBindings } from '../local-deployment-validator.js';

const toolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
const tenantId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902';
const targetAppId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903';
const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904';
const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'runtime-key',
  value: 'signed-value',
};
const budget = {
  maxModelSteps: 10,
  maxToolCalls: 8,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 10_000,
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 2,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 2, sharedBudget: true },
};

function revisions(): MaterializedDeploymentRevisions {
  return {
    agentRevision: {
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      revision: 1,
      agentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
      tenantId,
      name: 'Task agent',
      objective: 'Manage tasks',
      modelAlias: 'standard',
      promptBindingRef: 'local://prompts/task-agent',
      toolAllowlist: [toolId],
      budget,
      publishedAt: '2026-07-29T00:00:00.000Z',
      signature,
    },
    manifestRevision: {
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3907',
      revision: 1,
      tenantId,
      targetAppId,
      environmentId,
      sourceDigest: 'sha256:c291cmNl',
      tools: [{
        toolId,
        sourceFingerprint: 'sha256:ZmluZ2VycHJpbnQ',
        name: 'list_tasks',
        description: 'List tasks',
        riskClass: 'safe-read',
        enabled: true,
        tombstone: false,
        inputSchemaDigest: 'sha256:aW5wdXQ',
        outputSchemaDigest: 'sha256:b3V0cHV0',
        executionKind: 'endpoint',
        method: 'GET',
        path: '/api/tasks',
        authBindingRef: 'principal:task-reader',
      }],
      publishedAt: '2026-07-29T00:00:00.000Z',
      signature,
    },
    policyRevision: {
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3908',
      revision: 1,
      tenantId,
      environmentId,
      budget,
      toolPolicies: [{
        toolId,
        enabled: true,
        riskClass: 'safe-read',
        requiresApproval: false,
        allowedRoles: ['member'],
      }],
      toolOverrides: [],
      publishedAt: '2026-07-29T00:00:00.000Z',
      signature,
    },
  };
}

function bindings(): LocalToolBinding[] {
  return [{
    toolId,
    sourceFingerprint: 'sha256:ZmluZ2VycHJpbnQ',
    executionKind: 'endpoint',
    method: 'GET',
    path: '/api/tasks',
    inputSchemaDigest: 'sha256:aW5wdXQ',
    outputSchemaDigest: 'sha256:b3V0cHV0',
    tool: {
      id: 'local-list-tasks',
      description: 'Local task implementation',
      inputSchema: z.object({}),
      execute: async () => ({ tasks: [] }),
    },
  }];
}

describe('validateLocalDeploymentBindings', () => {
  it('accepts a deployment whose effective tools exactly match local bindings', () => {
    expect(() => validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: bindings(),
    })).not.toThrow();
  });

  it('rejects a changed source fingerprint before activation', () => {
    const localBindings = bindings();
    localBindings[0] = {
      ...localBindings[0]!,
      sourceFingerprint: 'sha256:b3RoZXI',
    };

    expect(() => validateLocalDeploymentBindings({
      revisions: revisions(),
      bindings: localBindings,
    })).toThrow(/source fingerprint/i);
  });

  it('rejects an allowlisted tool without an enabled policy', () => {
    const deployment = revisions();
    deployment.policyRevision.toolPolicies = [];

    expect(() => validateLocalDeploymentBindings({
      revisions: deployment,
      bindings: bindings(),
    })).toThrow(/policy/i);
  });

  it('accepts a policy that raises the manifest risk', () => {
    const deployment = revisions();
    deployment.policyRevision.toolPolicies[0]!.riskClass = 'write';

    expect(() => validateLocalDeploymentBindings({
      revisions: deployment,
      bindings: bindings(),
    })).not.toThrow();
  });

  it('rejects a policy below the manifest risk', () => {
    const deployment = revisions();
    deployment.manifestRevision.tools[0]!.riskClass = 'write';

    expect(() => validateLocalDeploymentBindings({
      revisions: deployment,
      bindings: bindings(),
    })).toThrow(/risk below manifest/i);
  });

  it.each(['Delete', 'constructor'])(
    'rejects a manifest risk class %j that is out of enum above its policy',
    (label) => {
      const deployment = revisions();
      deployment.manifestRevision.tools[0]!.riskClass = label as ToolRiskClass;

      expect(() => validateLocalDeploymentBindings({
        revisions: deployment,
        bindings: bindings(),
      })).toThrow(/risk below manifest/i);
    },
  );
});
