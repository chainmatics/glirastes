import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RuntimePolicyRevisionSchema, ToolRiskClassSchema } from '../revisions.js';
import {
  ToolOverrideDeltaSchema,
  ToolPolicyEntrySchema as LeafEntrySchema,
  ToolPolicyPinSchema as LeafPinSchema,
  ToolRiskClassSchema as LeafRiskClassSchema,
} from '../tool-policy-entry.js';
import { ToolPolicyEntrySchema, ToolPolicyPinSchema } from '../tool-policy.js';

const TOOL_A = '019fb001-0000-7000-8000-000000000006';
const TOOL_B = '019fb001-0000-7000-8000-000000000007';

const policyRevision = {
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3920',
  revision: 3,
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3921',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3922',
  budget: {
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
  },
  toolPolicies: [{ toolId: TOOL_A, enabled: true, riskClass: 'write', requiresApproval: true, allowedRoles: [] }],
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature: { algorithm: 'Ed25519' as const, keyId: 'runtime-signing-2026-10', value: 'c2lnbmF0dXJl' },
};

describe('RuntimePolicyRevision.toolOverrides (P08b shared contract items 1-2)', () => {
  it('reads a policy without decisions as an empty delta list', () => {
    expect(RuntimePolicyRevisionSchema.parse(policyRevision).toolOverrides).toEqual([]);
  });

  it('accepts the signed decision deltas of the shared contract', () => {
    const toolOverrides = [
      { toolId: TOOL_A, enabled: false, riskClass: 'delete', allowedRoles: ['admin'], description: 'Archives a task.' },
      { toolId: TOOL_B, requiresApproval: false, pin: { toolId: TOOL_B, atRiskClass: 'write' } },
    ];
    expect(RuntimePolicyRevisionSchema.parse({ ...policyRevision, toolOverrides }).toolOverrides)
      .toEqual(toolOverrides);
  });

  it.each([
    ['an unknown field', [{ toolId: TOOL_A, enabledEverywhere: true }]],
    ['an unknown risk class', [{ toolId: TOOL_A, riskClass: 'catastrophic' }]],
    ['a malformed tool id', [{ toolId: 'tasks.list', enabled: false }]],
    ['two deltas for one tool', [{ toolId: TOOL_A, enabled: false }, { toolId: TOOL_A, riskClass: 'delete' }]],
  ])('rejects %s', (_label, toolOverrides) => {
    expect(RuntimePolicyRevisionSchema.safeParse({ ...policyRevision, toolOverrides }).success).toBe(false);
  });

  it('shares one entry schema between local files and Platform deltas', () => {
    expect(ToolPolicyEntrySchema).toBe(LeafEntrySchema);
    expect(ToolPolicyPinSchema).toBe(LeafPinSchema);
    expect(ToolRiskClassSchema).toBe(LeafRiskClassSchema);
    expect(ToolOverrideDeltaSchema.safeParse({ toolId: TOOL_A, description: 'x'.repeat(4_001) }).success).toBe(false);
  });

  it('keeps the policy entry module a leaf, so revisions.ts never imports tool-policy.ts', async () => {
    const importsOf = async (file: string) => [...(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'))
      .matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
    expect(await importsOf('tool-policy-entry.ts')).toEqual([]);
    expect(await importsOf('revisions.ts')).not.toContain('./tool-policy.js');
  });
});
