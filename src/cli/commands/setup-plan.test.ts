import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { createSetupPlan, assertSetupPlanConfirmation } from './setup-plan.js';

const id = (suffix: string) =>
  `019fa9a9-d5f7-7ec3-a3c7-8899de30${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

function artifact(overrides: Record<string, unknown> = {}) {
  const tool = {
    toolId: id('4'),
    sourceFingerprint: digest('B'),
    name: 'tasks.list',
    description: 'List visible tasks.',
    modelName: 'tasks_list',
    module: 'task_query',
    sharedWith: [],
    usageHints: ['Use for visible task lists.'],
    presentation: {
      locale: 'de-DE',
      singular: 'Aufgabenliste',
      plural: 'Aufgabenlisten',
      approval: 'Aufgabenliste anzeigen',
    },
    executionKind: 'endpoint',
    method: 'GET',
    path: '/api/tasks',
    operationGroup: 'read',
    riskClass: 'safe-read',
    enabled: true,
    requiresApproval: false,
    inputSchemaDigest: digest('C'),
    outputSchemaDigest: digest('D'),
    ...overrides,
  };
  return {
    schemaVersion: 1,
    artifactId: id('1'),
    runId: id('2'),
    appId: id('3'),
    discoveryDigest: digest('A'),
    assessmentMode: 'interview',
    status: 'ready',
    tools: [tool],
    planner: {
      plannerId: id('5'),
      modelBindingRef: 'model-standard',
      promptBindingRef: 'prompt-v1',
      budgetProfileRef: 'interactive-default',
      toolIds: [id('4')],
    },
    prompts: {
      bundleDigest: digest('E'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('F'),
      appBehaviorDigest: digest('G'),
      responseStyleDigest: digest('H'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-08-14T08:00:00.000Z',
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-setup-plan-'));
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(
    join(root, '.glirastes/app-setup-artifact.json'),
    `${JSON.stringify(artifact())}\n`,
  );
  await writeFile(
    join(root, '.glirastes/previous-app-setup-artifact.json'),
    `${JSON.stringify(artifact())}\n`,
  );
  return root;
}

describe('createSetupPlan', () => {
  it('is byte-deterministic and contains bounded technical facts only', async () => {
    const root = await fixture();
    const first = await createSetupPlan({ rootDir: root });
    const second = await createSetupPlan({ rootDir: root });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first).toMatchObject({
      schemaVersion: 1,
      counts: { tools: 1, semanticChanges: 1 },
      requiresConfirmation: false,
    });
    expect(first.operations.map((operation) => operation.kind)).toEqual([
      'validate',
      'sync',
    ]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toMatch(
      /sourceCode|inputSchema|outputSchema|prompt|argument|result|credential|Private task/,
    );
    expect(first.planDigest).toMatch(/^sha256:/);
  });

  it('marks a loosening and binds confirmation to its exact digest', async () => {
    const root = await fixture();
    await writeFile(
      join(root, '.glirastes/previous-app-setup-artifact.json'),
      `${JSON.stringify(artifact({ requiresApproval: true }))}\n`,
    );
    const plan = await createSetupPlan({ rootDir: root });
    expect(plan.semanticChanges[0]).toMatchObject({
      classification: 'loosening',
      fields: ['requiresApproval'],
      requiresConfirmation: true,
    });
    expect(() => assertSetupPlanConfirmation(plan, {})).toThrowError(
      expect.objectContaining<Partial<FoundationDiagnosticError>>({
        code: 'E-SEMANTICS-004',
      }),
    );
    expect(() => assertSetupPlanConfirmation(plan, {
      confirmLoosening: true,
      planDigest: plan.planDigest,
    })).not.toThrow();
    expect(() => assertSetupPlanConfirmation(plan, {
      confirmLoosening: true,
      planDigest: digest('Z'),
    })).toThrowError(expect.objectContaining({ code: 'E-SEMANTICS-004' }));
  });

  it('does not call network or mutation dependencies', async () => {
    const root = await fixture();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const before = await readFile(
      join(root, '.glirastes/app-setup-artifact.json'),
      'utf8',
    );
    await createSetupPlan({ rootDir: root });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(
      join(root, '.glirastes/app-setup-artifact.json'),
      'utf8',
    )).toBe(before);
    vi.unstubAllGlobals();
  });
});
