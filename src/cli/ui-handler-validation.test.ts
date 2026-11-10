import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverFoundationExecutions } from '../codegen/index.js';
import { runCli } from './index.js';
import { createDoctorReport, formatDoctorReport } from './commands/doctor.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-${suffix.padStart(12, '0')}`;
const digest = (char: string) => `sha256:${char.repeat(43)}`;
const roots: string[] = [];

async function fixture(actionId = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-ui-validation-'));
  roots.push(root);
  await mkdir(join(root, '.glirastes'));
  await mkdir(join(root, 'src'));
  const json = async (path: string, value: unknown) => writeFile(join(root, path), JSON.stringify(value));
  await json('package.json', {
    name: 'ui-fixture', dependencies: { next: '15', 'better-auth': '1' },
    glirastes: { principal: 'server-verified' },
  });
  if (actionId) await writeFile(join(root, 'src/filter.tsx'),
    `import { useAiClientAction } from 'glirastes/react';
     export function Filters() { useAiClientAction('tasks.filter', () => {}); return null; }`);
  const execution = {
    toolId: id('2'), definitionId: 'tasks.filter', stableKey: 'ui:tasks.filter',
    executionKind: 'ui' as const, actionBindingRef: 'ui.tasks.filter',
    ...(actionId ? { actionId: 'tasks.filter' } : {}),
    sourceFingerprint: digest('A'), inputSchemaDigest: digest('B'), outputSchemaDigest: digest('C'),
  };
  const inventory = { schemaVersion: 2, targetAppKey: 'ui-fixture', executions: [execution] };
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  await json('.glirastes/foundation-execution-inventory.json', inventory);
  await json('.glirastes/prompt-bundle.json', {
    schemaVersion: 1, appId: id('1'), artifactRef: 'local://ui-fixture/prompts',
    sections: { planner: 'Plan.', appBehavior: 'Filter tasks.', responseStyle: 'Be brief.', capabilityFragments: {} },
  });
  await json('.glirastes/setup-artifact.json', {
    schemaVersion: 1, artifactId: id('3'), runId: id('4'), appId: id('1'),
    discoveryDigest: discovery.inventoryDigest, assessmentMode: 'interview', status: 'ready',
    tools: [{
      toolId: execution.toolId, name: execution.definitionId, description: 'Filter visible tasks.',
      modelName: 'tasks_filter', module: 'tasks', sharedWith: [], usageHints: ['Filter the task list.'],
      presentation: { locale: 'en-US', singular: 'Task filter', plural: 'Task filters', approval: 'Filter tasks' },
      executionKind: 'ui', operationGroup: 'ui', riskClass: 'safe-read', enabled: true, requiresApproval: false,
      sourceFingerprint: execution.sourceFingerprint, inputSchemaDigest: execution.inputSchemaDigest,
      outputSchemaDigest: execution.outputSchemaDigest,
    }],
    planner: { plannerId: id('5'), modelBindingRef: 'local-model', promptBindingRef: 'local-prompt', budgetProfileRef: 'default', toolIds: [id('2')] },
    prompts: { bundleDigest: digest('D'), artifactRef: 'local://ui-fixture/prompts', plannerDigest: digest('E'), appBehaviorDigest: digest('F'), responseStyleDigest: digest('G'), capabilityFragmentDigests: {} },
    warnings: [], generatedAt: '2026-09-13T10:00:00.000Z',
  });
  await runCli(['setup', '--root', root]);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('declared UI handler freshness', () => {
  it.each(['validate', 'build', 'setup'])('rejects %s after handler removal without replacing the last build', async (command) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await fixture();
    const runtimePath = join(root, '.glirastes/build/runtime-manifest.json');
    const before = await readFile(runtimePath, 'utf8');
    await rm(join(root, 'src/filter.tsx'));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await expect(runCli([command, '--root', root, '--app-id', id('1')])).rejects.toMatchObject({
      code: 'E-BINDING-004', remediation: 'repair-missing-ui-handler',
    });
    expect(await readFile(runtimePath, 'utf8')).toBe(before);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes Doctor fail with the missing-handler next action rather than reporting readiness', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await fixture();
    await rm(join(root, 'src/filter.tsx'));
    const report = await createDoctorReport({ rootDir: root, env: {} });
    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'artifacts', code: 'E-BINDING-004', remediation: 'repair-missing-ui-handler',
    }));
    expect(formatDoctorReport(report)).toContain('UI action handler');
  });

  it('accepts an actually registered handler and preserves legacy binding-only entries', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const declared of [true, false]) {
      const root = await fixture(declared);
      await expect(runCli(['validate', '--root', root, '--app-id', id('1')])).resolves.toBeUndefined();
      expect((await createDoctorReport({ rootDir: root, env: {} })).status).toBe('pass');
    }
  });
});
