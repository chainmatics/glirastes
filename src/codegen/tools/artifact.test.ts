import { describe, expect, it } from 'vitest';
import { assertAppSetupSemanticParity, type AppSetupOperationGroup } from '../../contracts/index.js';
import type { EffectiveToolPolicy } from '../../contracts/tool-policy.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  buildSetupArtifact,
  clipExclusions,
  EPOCH,
  promptMetadata,
  renderToolContracts,
  renderToolReport,
  schemaQualityOf,
  ToolReportFileSchema,
  type ArtifactToolInput,
} from './artifact.js';
import { canonicalJson, sha256Digest } from './canonical.js';
import { ToolContractsFileSchema } from './files.js';
import { toolFinding } from './findings.js';
import type { ToolContract } from './types.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const bundle = {
  artifactRef: 'local://fixture/prompts',
  sections: { planner: 'Plan.', appBehavior: 'Behave.', responseStyle: 'Short.', capabilityFragments: { tasks: 'Tasks.' } },
};

function effective(overrides: Partial<EffectiveToolPolicy> = {}): EffectiveToolPolicy {
  return {
    enabled: true,
    requiresApproval: false,
    riskClass: 'safe-read',
    allowedRoles: [],
    origin: {
      enabled: 'code-default', requiresApproval: 'code-default', riskClass: 'code-default',
      allowedRoles: 'code-default', description: 'code-default',
    },
    ...overrides,
  };
}

function tool(
  toolId: string,
  definitionId: string,
  overrides: { effective?: Partial<EffectiveToolPolicy>; operationGroup?: AppSetupOperationGroup } = {},
): ArtifactToolInput {
  return {
    execution: {
      toolId, definitionId, stableKey: `GET /api/${definitionId}`, executionKind: 'endpoint', sourceKind: 'next-app',
      sourceFile: `src/app/api/${definitionId}/route.ts`, method: 'GET', path: `/api/${definitionId}`,
      sourceFingerprint: digest('F'), inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
    },
    prose: {
      description: `Run ${definitionId}.`, descriptionOrigin: 'code', module: 'tasks', sharedWith: [],
      usageHints: [`Run ${definitionId}.`],
      presentation: { locale: 'en-US', singular: definitionId, plural: definitionId, approval: definitionId },
      findings: [],
    },
    effective: effective(overrides.effective),
    operationGroup: overrides.operationGroup ?? 'read',
  };
}

const TOOL_A = '019fb007-0000-7000-8000-0000000000b1';
const TOOL_B = '019fb007-0000-7000-8000-0000000000b2';
const base = {
  appId: APP_ID,
  targetAppKey: 'fixture',
  discoveryDigest: digest('D'),
  promptBundle: bundle,
  warnings: [],
};

describe('setup artifact', () => {
  it('derives identifiers from content and passes semantic parity', () => {
    const first = buildSetupArtifact({ ...base, tools: [tool(TOOL_B, 'notes.list'), tool(TOOL_A, 'tasks.list')], now: () => new Date('2026-10-04T10:00:00.000Z') });
    const second = buildSetupArtifact({ ...base, tools: [tool(TOOL_A, 'tasks.list'), tool(TOOL_B, 'notes.list')], now: () => new Date('2026-10-05T10:00:00.000Z') });
    expect(second.artifact.artifactId).toBe(first.artifact.artifactId);
    expect(second.artifact.runId).toBe(first.artifact.runId);
    expect(first.artifact.artifactId).not.toBe(first.artifact.runId);
    expect(first.artifact.tools.map((entry) => entry.toolId)).toEqual([TOOL_A, TOOL_B]);
    expect(first.artifact.generatedAt).toBe('2026-10-04T10:00:00.000Z');
    expect(first.raw).toBe(canonicalJson(first.artifact));
    expect(() => assertAppSetupSemanticParity(first.artifact, ['notes.list', 'tasks.list'])).not.toThrow();
    expect(first.artifact.tools[0]).toMatchObject({
      modelName: 'tasks_list', authBindingRef: 'endpoint-authorization', method: 'GET', path: '/api/tasks.list',
    });
  });

  it('carries generatedAt for unchanged content and never reads the clock in frozen mode', () => {
    const first = buildSetupArtifact({ ...base, tools: [tool(TOOL_A, 'tasks.list')], now: () => new Date('2026-10-04T10:00:00.000Z') });
    const carried = buildSetupArtifact({
      ...base, tools: [tool(TOOL_A, 'tasks.list')], previous: { artifact: first.artifact, planner: first.artifact.planner },
      now: () => new Date('2026-12-31T00:00:00.000Z'),
    });
    expect(carried.raw).toBe(first.raw);
    const changed = buildSetupArtifact({
      ...base, tools: [tool(TOOL_A, 'tasks.list', { effective: { enabled: false } })],
      previous: { artifact: first.artifact }, now: null,
    });
    expect(changed.artifact.generatedAt).toBe('2026-10-04T10:00:00.000Z');
    expect(buildSetupArtifact({ ...base, tools: [], now: null }).artifact.generatedAt).toBe(EPOCH);
  });

  it('applies the confirmation floor, keeps the planner and reports attention as review', () => {
    const previousPlanner = {
      plannerId: '019fb007-0000-7000-8000-0000000000c3', modelBindingRef: 'balanced',
      promptBindingRef: 'prompt:pilot', budgetProfileRef: 'foundation-default', toolIds: [],
    };
    const { artifact } = buildSetupArtifact({
      ...base,
      tools: [
        tool(TOOL_A, 'tasks.delete', { effective: { riskClass: 'delete', requiresApproval: false } }),
        tool(TOOL_B, 'notes.list', { effective: { enabled: false }, operationGroup: 'needs_attention' }),
      ],
      previous: { planner: previousPlanner },
      now: null,
    });
    expect(artifact.tools.find((entry) => entry.toolId === TOOL_A)?.requiresApproval).toBe(true);
    expect(artifact.planner).toEqual({ ...previousPlanner, toolIds: [TOOL_A] });
    expect(artifact.status).toBe('review');
  });

  it('digests the local prompt bundle like the runtime and the prompt manifest', () => {
    expect(promptMetadata(bundle)).toEqual({
      bundleDigest: sha256Digest(canonicalRuntimeJson(bundle.sections)),
      artifactRef: 'local://fixture/prompts',
      plannerDigest: sha256Digest('Plan.'),
      appBehaviorDigest: sha256Digest('Behave.'),
      responseStyleDigest: sha256Digest('Short.'),
      capabilityFragmentDigests: { tasks: sha256Digest('Tasks.') },
    });
  });
});

describe('tool contracts and report', () => {
  const contract: ToolContract = {
    source: 'derived', loadBearing: false, input: { type: 'object' }, output: {},
    params: { path: [], query: ['q'], body: [] }, interfaceDigest: digest('N'),
    runtime: { input: { kind: 'json', schema: { type: 'object' } }, output: { kind: 'json', schema: {} } },
  };
  const defaults = { operationGroup: 'read' as const, riskClass: 'safe-read' as const, requiresApproval: false, rulesVersion: 1 as const };

  it('renders tool-contracts.json sorted and parseable', () => {
    const raw = renderToolContracts(APP_ID, [
      { toolId: TOOL_B, stableKey: 'GET /api/b', definitionId: 'b.list', contract: null, defaults },
      { toolId: TOOL_A, stableKey: 'GET /api/a', definitionId: 'a.list', contract, defaults },
    ]);
    const parsed = ToolContractsFileSchema.parse(JSON.parse(raw));
    expect(parsed.tools.map((entry) => entry.toolId)).toEqual([TOOL_A, TOOL_B]);
    expect(raw).toBe(canonicalJson(parsed));
  });

  it('keeps the report content-free and free of change-relative findings', () => {
    const raw = renderToolReport({
      appId: APP_ID,
      discoveryDigest: digest('D'),
      tools: [{
        toolId: TOOL_A, stableKey: 'GET /api/a', definitionId: 'a.list', enabled: true, riskClass: 'safe-read',
        requiresApproval: false, contractSource: 'derived', quality: { description: 'template', schema: 'field-names' },
      }],
      findings: [
        toolFinding('contract-derived', 'warning', 'GET /api/a', 'Only names.'),
        toolFinding('contract-derived', 'warning', 'GET /api/a', 'Only names.'),
        toolFinding('risk-raised', 'warning', 'GET /api/a', 'Raised.'),
      ],
      excluded: [{ stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' }],
    });
    const report = ToolReportFileSchema.parse(JSON.parse(raw));
    expect(report.findings).toEqual([{
      code: 'contract-derived', severity: 'warning', subjectRef: 'GET /api/a',
      nextAction: toolFinding('contract-derived', 'warning', 'x', 'x').nextAction,
    }]);
    expect(raw).not.toContain('"message"');
  });

  it('accepts generator-owned exclusions of unsupported methods', () => {
    const raw = renderToolReport({
      appId: APP_ID,
      discoveryDigest: digest('D'),
      tools: [],
      findings: [],
      excluded: [
        { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
        { stableKey: 'OPTIONS /api/x', reason: 'unsupported-method', origin: 'code' },
      ],
    });
    expect(ToolReportFileSchema.parse(JSON.parse(raw)).excluded).toEqual([
      { stableKey: 'OPTIONS /api/x', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
    ]);
  });

  it('grades schema quality by contract source', () => {
    expect(schemaQualityOf(undefined)).toBe('none');
    expect(schemaQualityOf(contract)).toBe('field-names');
    expect(schemaQualityOf({ ...contract, source: 'native' })).toBe('zod');
    expect(schemaQualityOf({ ...contract, source: 'resolution' }, 'agent')).toBe('agent');
    expect(schemaQualityOf({ ...contract, source: 'resolution' }, 'human')).toBe('json-schema');
  });
});

describe('capability report fields', () => {
  it('clips exclusions to the Platform caps in a stable order', () => {
    const excluded = [
      { stableKey: `GET /${'x'.repeat(600)}`, reason: 'policy', origin: 'policy' as const },
      ...Array.from({ length: 5_001 }, (_, index) => ({
        stableKey: `GET /api/hidden/${String(index).padStart(4, '0')}`, reason: 'internal', origin: 'policy' as const,
      })),
      { stableKey: 'GET /api/hidden/0000', reason: 'duplicate', origin: 'default' as const },
    ];
    const clipped = clipExclusions(excluded);
    expect(clipped).toHaveLength(5_000);
    expect(clipped[0]).toEqual({ stableKey: 'GET /api/hidden/0000', origin: 'policy' });
    expect(clipped.at(-1)).toEqual({ stableKey: 'GET /api/hidden/4999', origin: 'policy' });
    expect(clipped.some((entry) => entry.stableKey.length > 512)).toBe(false);
  });

  it('carries provenance per tool and the reasoned exclusions', () => {
    const provenance = { descriptionSource: 'code' as const, schemaSource: 'zod' as const, contractSource: 'native' as const };
    const plain = buildSetupArtifact({ ...base, tools: [tool(TOOL_A, 'tasks.list')], now: null });
    const reported = buildSetupArtifact({
      ...base,
      tools: [{ ...tool(TOOL_A, 'tasks.list'), provenance }],
      exclusions: [{ stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' }],
      now: null,
    });
    expect(reported.artifact.tools[0]?.provenance).toEqual(provenance);
    expect(reported.artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
    expect(reported.artifact.artifactId).not.toBe(plain.artifact.artifactId);
    expect(plain.artifact).not.toHaveProperty('exclusions');
  });
});
