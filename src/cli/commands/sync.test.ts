import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../index.js';
import type { SetupPlan } from './setup-plan.js';
import {
  runSync,
  type SyncCommandDependencies,
} from './sync.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de60${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const appId = id('1');
const environmentId = id('2');
const runId = id('3');
const planDigest = digest('P');

const artifact = {
  schemaVersion: 1,
  artifactId: id('4'),
  runId,
  appId,
  discoveryDigest: digest('D'),
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [],
  planner: {
    plannerId: id('5'),
    modelBindingRef: 'model-standard',
    promptBindingRef: 'prompt-v1',
    budgetProfileRef: 'interactive-default',
    toolIds: [],
  },
  prompts: {
    bundleDigest: digest('B'),
    artifactRef: 'registry://fixture/prompts/v1',
    plannerDigest: digest('C'),
    appBehaviorDigest: digest('E'),
    responseStyleDigest: digest('F'),
    capabilityFragmentDigests: {},
  },
  warnings: [],
  generatedAt: '2026-08-14T10:00:00.000Z',
} as const;
const artifactRaw = `${JSON.stringify(artifact, null, 2)}\n`;
const artifactDigest = `sha256:${createHash('sha256')
  .update(artifactRaw).digest('base64url')}`;

function plan(mode: 'standalone' | 'managed' = 'standalone'): SetupPlan {
  return {
    schemaVersion: 1,
    mode,
    planDigest,
    operations: [
      { kind: 'validate', path: '.glirastes/setup-artifact.json', digest: artifactDigest },
      { kind: 'adopt', path: '.glirastes/setup-artifact.json', digest: artifactDigest },
      { kind: 'build', path: '.glirastes/build', digest: digest('G') },
      { kind: 'receipt', path: '.glirastes/setup-receipt.json', digest: artifactDigest },
      ...(mode === 'managed'
        ? [{ kind: 'sync' as const, path: '.glirastes/setup-artifact.json', digest: artifactDigest }]
        : []),
    ],
    counts: { tools: 0, semanticChanges: 0 },
    semanticChanges: [],
    diagnostics: [],
    requiresConfirmation: false,
  };
}

async function fixture(overrides?: {
  descriptorAppId?: string;
  descriptorEnvironmentId?: string;
  receiptAppId?: string;
  receiptPlanDigest?: string;
  receiptRuntimeDigest?: string;
  receiptPromptDigest?: string;
  environment?: string;
  writeEnvironment?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-sync-'));
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(
    join(root, '.glirastes/setup-artifact.json'),
    artifactRaw,
  );
  await writeFile(
    join(root, '.glirastes/setup-receipt.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      planDigest: overrides?.receiptPlanDigest ?? planDigest,
      mode: 'standalone',
      appId: overrides?.receiptAppId ?? appId,
      toolCount: 0,
      runtimeDigest: overrides?.receiptRuntimeDigest ?? digest('R'),
      promptDigest: overrides?.receiptPromptDigest ?? digest('S'),
      restartRequired: true,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(root, '.glirastes/platform-connection.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId: overrides?.descriptorAppId ?? appId,
      environmentId: overrides?.descriptorEnvironmentId ?? environmentId,
      runnerKey: 'fixture-runner',
    }, null, 2)}\n`,
  );
  if (overrides?.writeEnvironment !== false) {
    await writeFile(
      join(root, '.env.local'),
      overrides?.environment ?? [
        'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
        `GLIRASTES_APP_ID=${appId}`,
        `GLIRASTES_ENVIRONMENT_ID=${environmentId}`,
        'GLIRASTES_RUNNER_KEY=fixture-runner',
        'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
        '',
      ].join('\n'),
    );
  }
  return root;
}

function dependencies(overrides: Partial<SyncCommandDependencies> = {}) {
  const createRun = vi.fn().mockResolvedValue({
    runId,
    appId,
    status: 'ready',
    updatedAt: '2026-08-14T10:00:00.000Z',
  });
  const uploadArtifact = vi.fn().mockResolvedValue({
    runId,
    appId,
    status: 'ready',
    artifactDigest,
    updatedAt: '2026-08-14T10:00:00.000Z',
  });
  const syncArtifact = vi.fn(async (value: typeof artifact) => {
    await createRun({
      runId: value.runId,
      assessmentMode: value.assessmentMode,
      discoveryDigest: value.discoveryDigest,
    });
    return uploadArtifact(value);
  });
  const clientFactory = vi.fn(() => ({ syncArtifact }));
  return {
    value: {
      env: {},
      createPlan: vi.fn().mockResolvedValue(plan()),
      currentManifestDigests: vi.fn().mockResolvedValue({
        runtimeDigest: digest('R'),
        promptDigest: digest('S'),
      }),
      isGitIgnored: vi.fn().mockResolvedValue(true),
      clientFactory,
      log: vi.fn(),
      ...overrides,
    } satisfies SyncCommandDependencies,
    createRun,
    uploadArtifact,
    clientFactory,
  };
}

describe('runSync', () => {
  it('is available as the top-level sync command and through the deprecated setup adapter', async () => {
    const rootDir = await fixture();
    const first = dependencies();
    const second = dependencies();

    await runCli(['sync', '--root', rootDir, '--json'], { sync: first.value });
    await runCli(['setup', 'sync', '--root', rootDir, '--quiet'], { sync: second.value });

    expect(first.createRun).toHaveBeenCalledOnce();
    expect(second.createRun).toHaveBeenCalledOnce();
  });

  it('syncs the canonical local artifact without setup flags or reassessment', async () => {
    const rootDir = await fixture();
    const deps = dependencies();

    await runSync({ rootDir, json: true }, deps.value);

    expect(deps.createRun).toHaveBeenCalledWith({
      runId,
      assessmentMode: 'autonomous',
      discoveryDigest: artifact.discoveryDigest,
    });
    expect(deps.uploadArtifact).toHaveBeenCalledWith(artifact);
    expect(deps.value.createPlan).toHaveBeenCalledWith({
      rootDir,
      managed: false,
    });
    expect(deps.clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://control.example',
      appId,
      setupApiKey: 'gl_abcdefghijklmnopqrstuvwxyz123456',
    }));
    const output = String(vi.mocked(deps.value.log!).mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      status: 'ready',
      appId,
      environmentId,
      counts: { tools: 0, warnings: 0 },
      digests: {
        plan: planDigest,
        discovery: artifact.discoveryDigest,
        artifact: artifactDigest,
      },
    });
    expect(output).not.toContain('gl_abcdefghijklmnopqrstuvwxyz123456');
  });

  it('uses a complete process credential set without requiring .env.local', async () => {
    const rootDir = await fixture({
      writeEnvironment: false,
    });
    const isGitIgnored = vi.fn();
    const deps = dependencies({
      isGitIgnored,
      env: {
        GLIRASTES_CONTROL_PLANE_URL: 'https://control.example',
        GLIRASTES_APP_ID: appId,
        GLIRASTES_ENVIRONMENT_ID: environmentId,
        GLIRASTES_RUNNER_KEY: 'fixture-runner',
        GLIRASTES_API_KEY: 'gl_processprocessprocessprocess1234',
      },
    });

    await runSync({ rootDir }, deps.value);

    expect(deps.clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      setupApiKey: 'gl_processprocessprocessprocess1234',
    }));
    expect(isGitIgnored).not.toHaveBeenCalled();
  });

  it('fills a partial process credential set only from verified .env.local', async () => {
    const rootDir = await fixture();
    const isGitIgnored = vi.fn().mockResolvedValue(true);
    const deps = dependencies({
      isGitIgnored,
      env: {
        GLIRASTES_API_KEY: 'gl_processprocessprocessprocess1234',
      },
    });

    await runSync({ rootDir }, deps.value);

    expect(isGitIgnored).toHaveBeenCalledOnce();
    expect(deps.clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://control.example',
      appId,
      setupApiKey: 'gl_processprocessprocessprocess1234',
    }));
  });

  it.each([
    ['descriptor app', { descriptorAppId: id('80') }],
    ['descriptor environment', { descriptorEnvironmentId: id('81') }],
    ['receipt app', { receiptAppId: id('83') }],
    ['credential environment', {
      environment: [
        'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
        `GLIRASTES_APP_ID=${appId}`,
        `GLIRASTES_ENVIRONMENT_ID=${id('82')}`,
        'GLIRASTES_RUNNER_KEY=fixture-runner',
        'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
        '',
      ].join('\n'),
    }],
  ] as const)('rejects %s scope drift before constructing a network client', async (_name, values) => {
    const rootDir = await fixture(values);
    const deps = dependencies();

    await expect(runSync({ rootDir }, deps.value)).rejects.toMatchObject({
      code: 'E-SYNC-SCOPE-MISMATCH',
    });

    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  it('rejects an unignored local secret target before constructing a network client', async () => {
    const rootDir = await fixture();
    const deps = dependencies({
      env: {
        GLIRASTES_API_KEY: 'gl_processprocessprocessprocess1234',
      },
      isGitIgnored: vi.fn().mockResolvedValue(false),
    });

    await expect(runSync({ rootDir }, deps.value)).rejects.toMatchObject({
      code: 'E-CONNECT-SECRET-TRACKED',
    });

    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  it('rejects a stale setup receipt before constructing a network client', async () => {
    const rootDir = await fixture({ receiptPlanDigest: digest('Z') });
    const deps = dependencies();

    await expect(runSync({ rootDir }, deps.value)).rejects.toMatchObject({
      code: 'E-SYNC-SETUP-STALE',
    });

    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['runtime', { receiptRuntimeDigest: digest('Z') }],
    ['prompt', { receiptPromptDigest: digest('Z') }],
  ] as const)('rejects a stale %s manifest digest before network access', async (_name, values) => {
    const rootDir = await fixture(values);
    const deps = dependencies();

    await expect(runSync({ rootDir }, deps.value)).rejects.toMatchObject({
      code: 'E-SYNC-SETUP-STALE',
    });

    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  it('accepts the Platform idempotently returning the existing run and artifact', async () => {
    const rootDir = await fixture();
    const deps = dependencies();
    deps.createRun.mockResolvedValueOnce({
      runId,
      appId,
      status: 'ready',
      artifactDigest,
      updatedAt: '2026-08-14T10:00:00.000Z',
    });

    await expect(runSync({ rootDir }, deps.value)).resolves.toBeUndefined();

    expect(deps.createRun).toHaveBeenCalledOnce();
    expect(deps.uploadArtifact).toHaveBeenCalledOnce();
  });
});
