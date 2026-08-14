import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRouteSourceFingerprint } from '../../codegen/index.js';
import { discoverFoundationExecutions } from '../../codegen/execution-inventory.js';
import { applySetupPlan } from './apply-setup-plan.js';
import { createSetupPlan } from './setup-plan.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de40${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-apply-plan-'));
  const source = 'export async function GET() { return Response.json({ ok: true }); }';
  await mkdir(join(root, 'src/app/api/tasks'), { recursive: true });
  await writeFile(join(root, 'src/app/api/tasks/route.ts'), source, 'utf8');
  const inventory = {
    schemaVersion: 2 as const,
    targetAppKey: 'fixture',
    executions: [{
      toolId: id('1'),
      definitionId: 'tasks.list',
      stableKey: 'GET /api/tasks',
      executionKind: 'endpoint' as const,
      sourceFile: 'src/app/api/tasks/route.ts',
      sourceFingerprint: createRouteSourceFingerprint(source, 'GET', '/api/tasks'),
      inputSchemaDigest: digest('A'),
      outputSchemaDigest: digest('B'),
      method: 'GET' as const,
      path: '/api/tasks',
    }],
  };
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  await writeJson(root, 'package.json', {
    name: 'fixture',
    dependencies: { next: '16.0.0' },
    glirastes: {
      principal: 'server-verified',
      setupArtifact: '.glirastes/proposed-setup.json',
    },
  });
  await writeJson(root, '.glirastes/foundation-execution-inventory.json', inventory);
  await writeJson(root, '.glirastes/prompt-bundle.json', {
    schemaVersion: 1,
    appId: id('2'),
    artifactRef: 'local://fixture/prompts',
    sections: {
      planner: 'Plan safely.',
      appBehavior: 'Use the fixture.',
      responseStyle: 'Be concise.',
      capabilityFragments: {},
    },
  });
  const proposed = {
    schemaVersion: 1,
    artifactId: id('3'),
    runId: id('4'),
    appId: id('2'),
    discoveryDigest: discovery.inventoryDigest,
    assessmentMode: 'interview',
    status: 'ready',
    tools: [{
      toolId: id('1'),
      sourceFingerprint: inventory.executions[0]!.sourceFingerprint,
      name: 'tasks.list',
      description: 'List visible tasks.',
      modelName: 'tasks_list',
      module: 'tasks',
      sharedWith: [],
      usageHints: ['Use for visible task lists.'],
      presentation: {
        locale: 'en-US',
        singular: 'Task list',
        plural: 'Task lists',
        approval: 'Show task list',
      },
      executionKind: 'endpoint',
      method: 'GET',
      path: '/api/tasks',
      operationGroup: 'read',
      riskClass: 'safe-read',
      enabled: true,
      requiresApproval: false,
      inputSchemaDigest: digest('A'),
      outputSchemaDigest: digest('B'),
    }],
    planner: {
      plannerId: id('5'),
      modelBindingRef: 'model-standard',
      promptBindingRef: 'prompt-v1',
      budgetProfileRef: 'interactive-default',
      toolIds: [id('1')],
    },
    prompts: {
      bundleDigest: digest('C'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('D'),
      appBehaviorDigest: digest('E'),
      responseStyleDigest: digest('F'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-08-14T10:00:00.000Z',
  };
  await writeJson(root, '.glirastes/proposed-setup.json', proposed);
  await writeJson(root, '.glirastes/setup-artifact.json', {
    ...proposed,
    tools: proposed.tools.map((tool) => ({ ...tool, requiresApproval: true })),
  });
  return root;
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('applySetupPlan', () => {
  it('adopts the proposal, preserves the baseline and writes manifests once', async () => {
    const rootDir = await fixture();
    const plan = await createSetupPlan({ rootDir });
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const result = await applySetupPlan({ rootDir, plan });

    const canonical = JSON.parse(await readFile(
      join(rootDir, '.glirastes/setup-artifact.json'), 'utf8'));
    const previous = JSON.parse(await readFile(
      join(rootDir, '.glirastes/previous-setup-artifact.json'), 'utf8'));
    const receipt = JSON.parse(await readFile(
      join(rootDir, '.glirastes/setup-receipt.json'), 'utf8'));
    expect(canonical.tools[0].requiresApproval).toBe(false);
    expect(previous.tools[0].requiresApproval).toBe(true);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      planDigest: plan.planDigest,
      mode: 'standalone',
      appId: id('2'),
      toolCount: 1,
      restartRequired: true,
    });
    expect(result.runtimeDigest).toMatch(/^sha256:/);
    expect(await present(join(rootDir, '.glirastes/build/runtime-manifest.json')))
      .toBe(true);
    expect(await present(join(rootDir, '.glirastes/build/prompt-manifest.json')))
      .toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('restores every authoritative byte after a replacement failure', async () => {
    const rootDir = await fixture();
    const plan = await createSetupPlan({ rootDir });
    const canonicalPath = join(rootDir, '.glirastes/setup-artifact.json');
    const before = await readFile(canonicalPath, 'utf8');

    await expect(applySetupPlan({
      rootDir,
      plan,
      hooks: { afterReplace: (index) => {
        if (index === 1) throw new Error('injected replacement failure');
      } },
    })).rejects.toThrow('injected replacement failure');

    expect(await readFile(canonicalPath, 'utf8')).toBe(before);
    expect(await present(join(rootDir, '.glirastes/setup-receipt.json')))
      .toBe(false);
  });
});
