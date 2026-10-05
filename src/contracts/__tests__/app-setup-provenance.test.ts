import { describe, expect, it } from 'vitest';
import {
  APP_SETUP_EXCLUSION_LIMITS,
  AppSetupArtifactSchema,
  AppSetupToolProvenanceSchema,
} from '../app-setup.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

const tool = {
  toolId: id('404'),
  sourceFingerprint: digest('B'),
  name: 'tasks.list',
  executionKind: 'endpoint',
  method: 'GET',
  path: '/api/tasks',
  operationGroup: 'read',
  riskClass: 'safe-read',
  enabled: true,
  requiresApproval: false,
  inputSchemaDigest: digest('C'),
  outputSchemaDigest: digest('D'),
};

const artifact = {
  schemaVersion: 1,
  artifactId: id('401'),
  runId: id('402'),
  appId: id('403'),
  discoveryDigest: digest('A'),
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [tool],
  planner: {
    plannerId: id('405'),
    modelBindingRef: 'default',
    promptBindingRef: 'prompt:fixture',
    budgetProfileRef: 'default',
    toolIds: [id('404')],
  },
  prompts: {
    bundleDigest: digest('E'),
    artifactRef: 'local://fixture/prompts',
    plannerDigest: digest('F'),
    appBehaviorDigest: digest('G'),
    responseStyleDigest: digest('H'),
    capabilityFragmentDigests: {},
  },
  warnings: [],
  generatedAt: '2026-10-05T08:00:00.000Z',
};

const provenance = {
  policyOrigin: {
    enabled: 'code-default',
    requiresApproval: 'local-policy',
    riskClass: 'code-default',
    allowedRoles: 'code-default',
    description: 'local-policy',
  },
  contractSource: 'derived',
  descriptionSource: 'template',
  schemaSource: 'field-names',
};

describe('capability report extensions of the setup artifact (P08b shared contract item 5)', () => {
  it('accepts content-free provenance per tool and reasoned exclusions', () => {
    const parsed = AppSetupArtifactSchema.parse({
      ...artifact,
      tools: [{ ...tool, provenance }],
      exclusions: [
        { stableKey: 'POST /api/auth/token', origin: 'default' },
        { stableKey: 'OPTIONS /api/tasks', origin: 'code' },
        { stableKey: 'PAGE /admin', origin: 'policy' },
      ],
    });
    expect(parsed.tools[0]?.provenance).toEqual(provenance);
    expect(parsed.exclusions).toHaveLength(3);
  });

  it('keeps absent extensions absent instead of defaulting them', () => {
    const parsed = AppSetupArtifactSchema.parse(artifact);
    expect(parsed).not.toHaveProperty('exclusions');
    expect(parsed.tools[0]).not.toHaveProperty('provenance');
  });

  it.each(['zod', 'openapi', 'json-schema', 'agent', 'field-names', 'none'])(
    'accepts the schema quality %s the generator reports',
    (schemaSource) => {
      expect(AppSetupToolProvenanceSchema.safeParse({ schemaSource }).success).toBe(true);
    },
  );

  it.each([
    ['an unknown description source', { descriptionSource: 'llm' }],
    ['a Platform origin, which a local report never has', { policyOrigin: { enabled: 'platform' } }],
    ['an unknown field', { model: 'any' }],
    ['an unknown contract source', { contractSource: 'guess' }],
  ])('rejects provenance with %s', (_label, value) => {
    expect(AppSetupToolProvenanceSchema.safeParse(value).success).toBe(false);
  });

  it('enforces the Platform caps on exclusions', () => {
    const { maxEntries, maxStableKeyLength } = APP_SETUP_EXCLUSION_LIMITS;
    expect([maxEntries, maxStableKeyLength]).toEqual([5_000, 512]);
    const parse = (exclusions: unknown) => AppSetupArtifactSchema.safeParse({ ...artifact, exclusions }).success;
    expect(parse([{ stableKey: `GET /${'a'.repeat(maxStableKeyLength - 5)}`, origin: 'default' }])).toBe(true);
    expect(parse([{ stableKey: `GET /${'a'.repeat(maxStableKeyLength - 4)}`, origin: 'default' }])).toBe(false);
    expect(parse(Array.from({ length: maxEntries + 1 }, (_, index) => ({
      stableKey: `GET /api/hidden/${index}`, origin: 'policy',
    })))).toBe(false);
    expect(parse([{ stableKey: 'GET /api/x', origin: 'manual' }])).toBe(false);
  });
});
