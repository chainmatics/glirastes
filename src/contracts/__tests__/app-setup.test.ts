import { describe, expect, it } from 'vitest';
import {
  AppSetupArtifactSchema,
  AppSetupStatusSchema,
  assertAppSetupSemanticParity,
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

describe('tool descriptions', () => {
  const withDescription = (description: unknown) => ({
    ...artifact,
    tools: [{ ...artifact.tools[0], description }],
  });

  /**
   * A reviewer has to know what an operation does before overriding its risk
   * class or approval requirement. A stable identifier like
   * `tasks.listAttachments` does not carry that, so the artifact needs a
   * short validated description beside it.
   */
  it('accepts a short description beside the technical identity', () => {
    const parsed = AppSetupArtifactSchema.parse(
      withDescription('Reads the attachments of a task.'),
    );

    expect(parsed.tools[0].description).toBe('Reads the attachments of a task.');
  });

  it('stays optional so an existing artifact remains valid', () => {
    expect(() => AppSetupArtifactSchema.parse(artifact)).not.toThrow();
  });

  /** A description is prose, never a place to smuggle source or secrets. */
  it('rejects a description long enough to carry source', () => {
    expect(() => AppSetupArtifactSchema.parse(
      withDescription('x'.repeat(1_001)),
    )).toThrow();
  });

  it('rejects a description that is not text', () => {
    expect(() => AppSetupArtifactSchema.parse(withDescription(42))).toThrow();
  });
});

describe('tool metadata', () => {
  const withMetadata = (extra: Record<string, unknown>) => ({
    ...artifact,
    tools: [{ ...artifact.tools[0], ...extra }],
  });

  /**
   * Route and method describe an operation without being prose. Keeping them
   * as their own fields lets the description stay about purpose and lets the
   * dashboard show the technical facts read-only.
   */
  it('carries the route of an endpoint beside the description', () => {
    const parsed = AppSetupArtifactSchema.parse(withMetadata({
      method: 'GET',
      path: '/api/tasks/:id/attachments',
      authBindingRef: 'verified-session',
    }));

    expect(parsed.tools[0].method).toBe('GET');
    expect(parsed.tools[0].path).toBe('/api/tasks/:id/attachments');
  });

  it('carries the action binding of a UI entry', () => {
    const parsed = AppSetupArtifactSchema.parse(withMetadata({
      executionKind: 'ui',
      operationGroup: 'ui',
      actionBindingRef: 'ui.dashboard.refreshStats',
    }));

    expect(parsed.tools[0].actionBindingRef).toBe('ui.dashboard.refreshStats');
  });

  it('rejects a method that is not an HTTP verb', () => {
    expect(() => AppSetupArtifactSchema.parse(withMetadata({ method: 'FETCH' })))
      .toThrow();
  });

  it('rejects a path that is not a route', () => {
    expect(() => AppSetupArtifactSchema.parse(withMetadata({ path: 'tasks' })))
      .toThrow();
  });

  /** A source path would reveal the local tree and stays out of the artifact. */
  it('rejects a source location', () => {
    expect(() => AppSetupArtifactSchema.parse(withMetadata({
      sourceFile: 'src/app/api/tasks/route.ts',
    }))).toThrow();
  });
});

describe('proposed roles', () => {
  it('carries the roles the assessment proposes', () => {
    const parsed = AppSetupArtifactSchema.parse({
      ...artifact,
      tools: [{
        ...artifact.tools[0],
        allowedRoles: ['admin', 'gruppenleiter'],
      }],
    });

    expect(parsed.tools[0].allowedRoles).toEqual(['admin', 'gruppenleiter']);
  });

  it('rejects a role list long enough to be a payload', () => {
    expect(() => AppSetupArtifactSchema.parse({
      ...artifact,
      tools: [{
        ...artifact.tools[0],
        allowedRoles: Array.from({ length: 51 }, (_, i) => `r${i}`),
      }],
    })).toThrow();
  });
});

describe('curated tool semantics', () => {
  const semanticArtifact = {
    ...artifact,
    tools: [{
      ...artifact.tools[0],
      modelName: 'list_tasks',
      module: 'task_query',
      sharedWith: ['task_mutation'],
      usageHints: ['Use for filtered task lists.', 'Excludes deleted tasks.'],
      presentation: {
        locale: 'de-DE',
        singular: 'Aufgabenliste',
        plural: 'Aufgabenlisten',
        approval: 'Aufgabenliste anzeigen',
      },
    }],
  };

  it('validates model names, module membership, and usage hints together', () => {
    const parsed = assertAppSetupSemanticParity(semanticArtifact, ['list_tasks']);

    expect(parsed.tools[0]).toMatchObject({
      modelName: 'list_tasks',
      module: 'task_query',
      sharedWith: ['task_mutation'],
      presentation: {
        locale: 'de-DE',
        singular: 'Aufgabenliste',
        plural: 'Aufgabenlisten',
        approval: 'Aufgabenliste anzeigen',
      },
    });
  });

  it('fails closed when an enabled tool has incomplete semantics', () => {
    expect(() => assertAppSetupSemanticParity({
      ...semanticArtifact,
      tools: [{ ...semanticArtifact.tools[0], usageHints: undefined }],
    }, ['list_tasks'])).toThrow('incomplete curated semantics');
  });

  it('fails closed when an enabled tool has no presentation semantics', () => {
    expect(() => assertAppSetupSemanticParity({
      ...semanticArtifact,
      tools: [{ ...semanticArtifact.tools[0], presentation: undefined }],
    }, ['list_tasks'])).toThrow('incomplete curated semantics');
  });

  it('fails closed on model-safe name collisions', () => {
    expect(() => assertAppSetupSemanticParity({
      ...semanticArtifact,
      tools: [
        semanticArtifact.tools[0],
        { ...semanticArtifact.tools[0], toolId: id('406'), name: 'list.tasks' },
      ],
      planner: { ...semanticArtifact.planner, toolIds: [id('404'), id('406')] },
    }, ['list_tasks', 'list.tasks'])).toThrow('model-facing tool name');
  });

  it('fails when the semantic artifact and served registry differ', () => {
    expect(() => assertAppSetupSemanticParity(
      semanticArtifact,
      ['list_tasks', 'tasks.get'],
    )).toThrow('semantic parity');
  });
});
