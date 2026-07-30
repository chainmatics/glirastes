import { describe, expect, it } from 'vitest';
import {
  AppSetupArtifactSchema,
  AppSetupStatusSchema,
} from '../app-setup.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

const artifact = {
  schemaVersion: 1,
  artifactId: id('401'),
  runId: id('402'),
  appId: id('403'),
  discoveryDigest: digest('A'),
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [{
    toolId: id('404'),
    sourceFingerprint: digest('B'),
    name: 'list_tasks',
    executionKind: 'endpoint',
    operationGroup: 'read',
    riskClass: 'safe-read',
    enabled: true,
    requiresApproval: false,
    inputSchemaDigest: digest('C'),
    outputSchemaDigest: digest('D'),
  }],
  planner: {
    plannerId: id('405'),
    modelBindingRef: 'model-standard',
    promptBindingRef: 'prompt-gid-v1',
    budgetProfileRef: 'interactive-default',
    toolIds: [id('404')],
  },
  prompts: {
    bundleDigest: digest('E'),
    artifactRef: 'registry://get-it-done/prompts/v1',
    plannerDigest: digest('F'),
    appBehaviorDigest: digest('G'),
    responseStyleDigest: digest('H'),
    capabilityFragmentDigests: {
      taskManagement: digest('I'),
    },
  },
  warnings: [{
    code: 'tool.requires_review',
    subjectRef: id('404'),
  }],
  generatedAt: '2026-07-30T10:00:00.000Z',
} as const;

describe('AppSetupStatusSchema', () => {
  it.each([
    'discovering',
    'assessing',
    'waiting_for_interview',
    'review',
    'ready',
    'published',
    'failed',
  ])('accepts the lifecycle state %s', (status) => {
    expect(AppSetupStatusSchema.parse(status)).toBe(status);
  });
});

describe('AppSetupArtifactSchema', () => {
  it('accepts app-scoped technical setup metadata without an environment', () => {
    const parsed = AppSetupArtifactSchema.parse(artifact);

    expect(parsed.appId).toBe(artifact.appId);
    expect(parsed.tools[0]?.toolId).toBe(artifact.tools[0].toolId);
    expect(parsed).not.toHaveProperty('environmentId');
  });

  it.each([
    ['source code', { sourceCode: 'export async function GET() {}' }],
    ['raw credentials', { credentials: { apiKey: 'not-for-platform' } }],
    ['business payloads', { businessData: { title: 'Private task' } }],
    ['model transcripts', { modelTranscript: 'tool should be exposed' }],
    ['raw prompts', { systemPrompt: 'Sensitive local instructions' }],
  ])('rejects %s at any depth', (_label, forbidden) => {
    const candidate = structuredClone(artifact) as Record<string, unknown>;
    candidate.tools = [{
      ...(candidate.tools as Array<Record<string, unknown>>)[0],
      assessment: forbidden,
    }];

    const result = AppSetupArtifactSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain('Private task');
      expect(JSON.stringify(result.error.issues)).not.toContain('not-for-platform');
      expect(JSON.stringify(result.error.issues)).not.toContain('Sensitive local instructions');
    }
  });

  it.each([
    ['Bearer abcdefghijklmnopqrstuvwxyz', 'planner.modelBindingRef'],
    ['sk-or-v1-abcdefghijklmnopqrstuvwxyz123456', 'prompts.artifactRef'],
    ['-----BEGIN PRIVATE KEY-----', 'warnings.0.subjectRef'],
  ])('rejects secret-shaped values without echoing them', (secret, field) => {
    const candidate = structuredClone(artifact) as Record<string, unknown>;
    const segments = field.split('.');
    let target: Record<string, unknown> = candidate;
    for (const segment of segments.slice(0, -1)) {
      target = Array.isArray(target)
        ? target[Number(segment)] as Record<string, unknown>
        : target[segment] as Record<string, unknown>;
    }
    target[segments.at(-1)!] = secret;

    const result = AppSetupArtifactSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain(secret);
    }
  });

  it('rejects planner references to tools outside the artifact', () => {
    expect(AppSetupArtifactSchema.safeParse({
      ...artifact,
      planner: {
        ...artifact.planner,
        toolIds: [id('499')],
      },
    }).success).toBe(false);
  });
});
