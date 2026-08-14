import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverFoundationExecutions } from '../../codegen/index.js';
import { runCli } from '../index.js';
import { applySetupPlan } from './apply-setup-plan.js';
import { createDoctorReport, formatDoctorReport } from './doctor.js';
import { createSetupPlan } from './setup-plan.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de50${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture(principal = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-doctor-'));
  const inventory = {
    schemaVersion: 2 as const,
    targetAppKey: 'fixture',
    executions: [],
  };
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  await writeJson(root, 'package.json', {
    name: 'fixture',
    dependencies: { next: '16.0.0', 'better-auth': '1.0.0' },
    glirastes: principal ? { principal: 'server-verified' } : {},
  });
  await writeJson(root, '.glirastes/foundation-execution-inventory.json', inventory);
  await writeJson(root, '.glirastes/prompt-bundle.json', {
    schemaVersion: 1,
    appId: id('1'),
    artifactRef: 'local://fixture/prompts',
    sections: {
      planner: 'Plan safely.',
      appBehavior: 'Use the fixture.',
      responseStyle: 'Be concise.',
      capabilityFragments: {},
    },
  });
  await writeJson(root, '.glirastes/setup-artifact.json', {
    schemaVersion: 1,
    artifactId: id('2'),
    runId: id('3'),
    appId: id('1'),
    discoveryDigest: discovery.inventoryDigest,
    assessmentMode: 'interview',
    status: 'ready',
    tools: [],
    planner: {
      plannerId: id('4'),
      modelBindingRef: 'model-standard',
      promptBindingRef: 'prompt-v1',
      budgetProfileRef: 'interactive-default',
      toolIds: [],
    },
    prompts: {
      bundleDigest: digest('A'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('B'),
      appBehaviorDigest: digest('C'),
      responseStyleDigest: digest('D'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-08-14T10:00:00.000Z',
  });
  const plan = await createSetupPlan({ rootDir: root });
  await applySetupPlan({ rootDir: root, plan });
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('createDoctorReport', () => {
  it('validates a Connected descriptor, ignored secret, scope, and credential offline', async () => {
    const rootDir = await fixture();
    const appId = id('1');
    const environmentId = id('9');
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId,
      environmentId,
      runnerKey: 'fixture-runner',
    });
    await writeFile(join(rootDir, '.env.local'), [
      'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
      `GLIRASTES_APP_ID=${appId}`,
      `GLIRASTES_ENVIRONMENT_ID=${environmentId}`,
      'GLIRASTES_RUNNER_KEY=fixture-runner',
      'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
      '',
    ].join('\n'));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const report = await createDoctorReport({
      rootDir,
      env: {},
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect(report.status).toBe('pass');
    expect(report.mode).toBe('connected');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'connection-descriptor', status: 'pass' }),
      expect.objectContaining({ name: 'connection-secret-path', status: 'pass' }),
      expect.objectContaining({ name: 'connection-scope', status: 'pass' }),
      expect.objectContaining({ name: 'connection-credential', status: 'pass' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('gl_abcdefghijklmnopqrstuvwxyz123456');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails Connected Doctor scope checks before any network access', async () => {
    const rootDir = await fixture();
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId: id('1'),
      environmentId: id('9'),
      runnerKey: 'fixture-runner',
    });
    await writeFile(join(rootDir, '.env.local'), [
      'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
      `GLIRASTES_APP_ID=${id('1')}`,
      `GLIRASTES_ENVIRONMENT_ID=${id('8')}`,
      'GLIRASTES_RUNNER_KEY=fixture-runner',
      'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
      '',
    ].join('\n'));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const report = await createDoctorReport({
      rootDir,
      env: {},
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'connection-scope', status: 'fail', code: 'E-SCOPE-004',
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('passes a current local setup with bounded deterministic checks', async () => {
    const rootDir = await fixture();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const before = await readFile(join(rootDir, '.glirastes/setup-artifact.json'), 'utf8');

    const first = await createDoctorReport({ rootDir });
    const second = await createDoctorReport({ rootDir });

    expect(second).toEqual(first);
    expect(first.status).toBe('pass');
    expect(first).toMatchObject({
      schemaVersion: 1,
      mode: 'standalone',
      counts: { tools: 0, passed: expect.any(Number), warnings: 0, failed: 0 },
    });
    expect(first.checks.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'project', 'framework', 'auth-provider', 'principal', 'artifacts',
      'build', 'receipt', 'runtime-mode',
    ]));
    expect(formatDoctorReport(first)).toMatch(/restart the application/i);
    expect(JSON.stringify(first)).not.toMatch(/prompt|secret|credential|source/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(join(rootDir, '.glirastes/setup-artifact.json'), 'utf8'))
      .toBe(before);
  });

  it('fails when server-verified principal wiring is not declared', async () => {
    const rootDir = await fixture(false);

    const report = await createDoctorReport({ rootDir });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'principal',
      status: 'fail',
      code: 'E-SCOPE-003',
    }));
  });

  it('fails when built artifacts no longer match the local inputs', async () => {
    const rootDir = await fixture();
    await writeFile(
      join(rootDir, '.glirastes/build/runtime-manifest.json'),
      '{"stale":true}\n',
      'utf8',
    );

    const report = await createDoctorReport({ rootDir });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'build', status: 'fail', code: 'E-SETUP-008',
    }));
  });

  it('fails explicit Managed checks without reading or printing values', async () => {
    const rootDir = await fixture();
    vi.stubEnv('GLIRASTES_CONTROL_PLANE_URL', '');
    vi.stubEnv('GLIRASTES_API_KEY', '');

    const report = await createDoctorReport({ rootDir, managed: true });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'runtime-mode', status: 'fail', code: 'E-SETUP-009',
    }));
    expect(JSON.stringify(report)).not.toContain('GLIRASTES_API_KEY');
  });

  it('prints one JSON report and sets a non-zero exit code on failure', async () => {
    const rootDir = await fixture(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli(['doctor', '--root', rootDir, '--json']);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).status).toBe('fail');
    expect(process.exitCode).toBe(1);
    log.mockRestore();
  });
});
