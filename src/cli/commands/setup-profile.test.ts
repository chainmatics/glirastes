import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { detectSetupProfile } from './setup-profile.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de20${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture(options: {
  setupPath?: string;
  appId?: string;
  promptAppId?: string;
  glirastes?: Record<string, unknown>;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-setup-profile-'));
  const appId = options.appId ?? id('1');
  const setupPath = options.setupPath ?? '.glirastes/setup-artifact.json';
  await writeJson(root, 'package.json', {
    name: 'fixture-app',
    dependencies: {
      next: '16.0.0',
      '@clerk/nextjs': '6.0.0',
    },
    glirastes: {
      principal: 'server-verified',
      ...options.glirastes,
    },
  });
  await writeJson(root, '.glirastes/foundation-execution-inventory.json', {
    schemaVersion: 2,
    targetAppKey: 'fixture-app',
    executions: [],
  });
  await writeJson(root, setupPath, {
    schemaVersion: 1,
    artifactId: id('2'),
    runId: id('3'),
    appId,
    discoveryDigest: digest('A'),
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
      bundleDigest: digest('B'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('C'),
      appBehaviorDigest: digest('D'),
      responseStyleDigest: digest('E'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-08-14T10:00:00.000Z',
  });
  await writeJson(root, '.glirastes/prompt-bundle.json', {
    schemaVersion: 1,
    appId: options.promptAppId ?? appId,
    artifactRef: 'local://fixture/prompts',
    sections: {
      planner: 'Plan safely.',
      appBehavior: 'Use the fixture application.',
      responseStyle: 'Be concise.',
      capabilityFragments: {},
    },
  });
  return root;
}

describe('detectSetupProfile', () => {
  it('detects the framework, auth marker, principal, paths and app identity', async () => {
    const rootDir = await fixture();

    const profile = await detectSetupProfile({ rootDir });

    expect(profile).toMatchObject({
      schemaVersion: 1,
      projectName: 'fixture-app',
      framework: 'nextjs',
      authProviders: ['clerk'],
      principal: 'server-verified',
      mode: 'standalone',
      appId: id('1'),
      toolCount: 0,
      paths: {
        inventory: '.glirastes/foundation-execution-inventory.json',
        setupArtifact: '.glirastes/setup-artifact.json',
        promptBundle: '.glirastes/prompt-bundle.json',
      },
    });
  });

  it('enters Managed mode only when explicitly requested', async () => {
    const rootDir = await fixture();

    expect((await detectSetupProfile({ rootDir })).mode).toBe('standalone');
    expect((await detectSetupProfile({ rootDir, managed: true })).mode)
      .toBe('managed');
  });

  it('uses bounded configured artifact paths', async () => {
    const rootDir = await fixture({
      setupPath: '.config/proposed.json',
      glirastes: {
        setupArtifact: '.config/proposed.json',
        inventory: '.glirastes/foundation-execution-inventory.json',
        promptBundle: '.glirastes/prompt-bundle.json',
      },
    });

    const profile = await detectSetupProfile({ rootDir });

    expect(profile.paths.setupArtifact).toBe('.config/proposed.json');
  });

  it('fails closed when local artifacts disagree on app identity', async () => {
    const rootDir = await fixture({ promptAppId: id('9') });

    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject({
      code: 'E-SCOPE-002',
      operation: 'setup.profile',
    } satisfies Partial<FoundationDiagnosticError>);
  });

  it('fails closed when two undeclared setup candidates are present', async () => {
    const rootDir = await fixture();
    const raw = await import('node:fs/promises').then(({ readFile }) =>
      readFile(join(rootDir, '.glirastes/setup-artifact.json'), 'utf8'));
    await writeFile(
      join(rootDir, '.glirastes/app-setup-artifact.json'),
      raw,
      'utf8',
    );

    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject({
      code: 'E-SETUP-004',
      operation: 'setup.profile',
    } satisfies Partial<FoundationDiagnosticError>);
  });

  it('rejects configured paths outside the workspace', async () => {
    const rootDir = await fixture({
      glirastes: { setupArtifact: '../outside.json' },
    });

    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject({
      code: 'E-SETUP-003',
      operation: 'setup.profile',
    } satisfies Partial<FoundationDiagnosticError>);
  });

  it('never returns credential values', async () => {
    const rootDir = await fixture();
    const profile = await detectSetupProfile({ rootDir, managed: true });
    const serialized = JSON.stringify(profile);

    expect(serialized).not.toContain('GLIRASTES_API_KEY');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('CONTROL_PLANE_URL');
  });
});
