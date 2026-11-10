import { describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { computePolicyDigest, LocalPromptBundleSchema, renderManifestContents } from './validate-build.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de30${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

function artifact(requiresApproval: boolean) {
  return AppSetupArtifactSchema.parse({
    schemaVersion: 1,
    artifactId: id('1'),
    runId: id('2'),
    appId: id('3'),
    discoveryDigest: digest('A'),
    assessmentMode: 'autonomous',
    status: 'ready',
    tools: [{
      toolId: id('4'), sourceFingerprint: digest('B'), name: 'tasks.create', description: 'Create a task.',
      modelName: 'tasks_create', module: 'tasks', sharedWith: [], usageHints: ['Create a task.'],
      presentation: { locale: 'en-US', singular: 'Create task', plural: 'Create tasks', approval: 'Create task' },
      executionKind: 'endpoint', method: 'POST', path: '/api/tasks', operationGroup: 'create',
      riskClass: 'write', enabled: true, requiresApproval, allowedRoles: ['member', 'admin'],
      inputSchemaDigest: digest('C'), outputSchemaDigest: digest('D'),
    }],
    planner: { plannerId: id('5'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('4')] },
    prompts: {
      bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'),
      appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-10-04T08:00:00.000Z',
  });
}

const promptBundle = LocalPromptBundleSchema.parse({
  schemaVersion: 1,
  appId: id('3'),
  artifactRef: 'local://fixture/prompts',
  sections: { planner: 'Plan.', appBehavior: 'Behave.', responseStyle: 'Short.' },
});

const input = {
  appId: id('3'),
  targetAppKey: 'fixture',
  inventoryDigest: digest('I'),
  executions: [{
    toolId: id('4'), stableKey: 'POST /api/tasks', executionKind: 'endpoint' as const,
    sourceFingerprint: digest('B'), inputSchemaDigest: digest('C'), outputSchemaDigest: digest('D'),
  }],
  promptBundle,
};

describe('renderManifestContents', () => {
  it('adds a policy digest that follows the effective policy only when an artifact exists', () => {
    const without = JSON.parse(renderManifestContents(input).runtimeContent) as Record<string, unknown>;
    expect(without).not.toHaveProperty('policyDigest');
    const strict = renderManifestContents({ ...input, setupArtifact: artifact(true) });
    const relaxed = renderManifestContents({ ...input, setupArtifact: artifact(false) });
    expect(JSON.parse(strict.runtimeContent).policyDigest).toBe(computePolicyDigest(artifact(true)));
    expect(strict.runtimeDigest).not.toBe(relaxed.runtimeDigest);
    expect(strict.promptDigest).toBe(relaxed.promptDigest);
  });

  it('ignores role order in the policy digest', () => {
    const reordered = AppSetupArtifactSchema.parse({
      ...artifact(true),
      tools: artifact(true).tools.map((tool) => ({ ...tool, allowedRoles: ['admin', 'member'] })),
    });
    expect(computePolicyDigest(reordered)).toBe(computePolicyDigest(artifact(true)));
  });
});
