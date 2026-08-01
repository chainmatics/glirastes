import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouteSourceFingerprint } from '../codegen/index.js';
import { runCli } from './index.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de20${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

async function setupFixture(): Promise<{
  root: string;
  artifact: Record<string, unknown>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-setup-'));
  const source =
    'export async function GET() { return Response.json({ ok: true }); }';
  await mkdir(join(root, 'src/app/api/tasks'), { recursive: true });
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(
    join(root, 'src/app/api/tasks/route.ts'),
    source,
    'utf8',
  );
  await writeFile(
    join(root, '.glirastes/local-execution-inventory.v2.json'),
    JSON.stringify({
      schemaVersion: 2,
      targetAppKey: 'fixture',
      executions: [{
        toolId: id('1'),
        definitionId: 'tasks.list',
        stableKey: 'GET /api/tasks',
        executionKind: 'endpoint',
        sourceFile: 'src/app/api/tasks/route.ts',
        sourceFingerprint: createRouteSourceFingerprint(
          source,
          'GET',
          '/api/tasks',
        ),
        inputSchemaDigest: digest('A'),
        outputSchemaDigest: digest('B'),
        method: 'GET',
        path: '/api/tasks',
      }],
    }),
    'utf8',
  );
  const artifact = {
    schemaVersion: 1,
    artifactId: id('2'),
    runId: id('3'),
    appId: id('4'),
    discoveryDigest: digest('C'),
    assessmentMode: 'interview',
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
      bundleDigest: digest('D'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('E'),
      appBehaviorDigest: digest('F'),
      responseStyleDigest: digest('G'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-07-30T10:00:00.000Z',
  };
  await writeFile(
    join(root, '.glirastes/app-setup.json'),
    JSON.stringify(artifact),
    'utf8',
  );
  return { root, artifact };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('glirastes setup', () => {
  it('scans the positive inventory locally without network access', async () => {
    const { root } = await setupFixture();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await runCli([
      'setup',
      'scan',
      '--root',
      root,
      '--execution-inventory',
      '.glirastes/local-execution-inventory.v2.json',
      '--output',
      '.glirastes/setup-discovery.json',
      '--quiet',
    ]);

    const discovery = JSON.parse(await readFile(
      join(root, '.glirastes/setup-discovery.json'),
      'utf8',
    ));
    expect(discovery.executions).toHaveLength(1);
    expect(discovery.executions[0].toolId).toBe(id('1'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('syncs a final artifact by app without an environment ID', async () => {
    const { root, artifact } = await setupFixture();
    const response = (status: string) => new Response(JSON.stringify({
      runId: artifact.runId,
      appId: artifact.appId,
      status,
      updatedAt: '2026-07-30T10:00:00.000Z',
    }), { status: status === 'discovering' ? 201 : 200 });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('discovering'))
      .mockResolvedValueOnce(response('ready'));
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubEnv('GLIRASTES_API_KEY', 'setup-secret');
    vi.stubEnv('GLIRASTES_ENVIRONMENT_ID', '');

    await runCli([
      'setup',
      'sync',
      '--root',
      root,
      '--artifact',
      '.glirastes/app-setup.json',
      '--base-url',
      'https://control.example',
      '--app-id',
      String(artifact.appId),
      '--quiet',
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url] of fetchImpl.mock.calls) {
      expect(url).toContain(`/v2/apps/${artifact.appId}/runtime-setup`);
      expect(url).not.toContain('environment');
    }
  });

  it('resumes a run status without an environment ID', async () => {
    const { root, artifact } = await setupFixture();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: artifact.runId,
      appId: artifact.appId,
      status: 'waiting_for_interview',
      progress: { completed: 2, total: 4 },
      updatedAt: '2026-07-30T10:00:00.000Z',
    })));
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubEnv('GLIRASTES_API_KEY', 'setup-secret');

    await runCli([
      'setup',
      'status',
      '--root',
      root,
      '--run-id',
      String(artifact.runId),
      '--base-url',
      'https://control.example',
      '--app-id',
      String(artifact.appId),
      '--quiet',
    ]);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://control.example/v2/apps/${artifact.appId}`
        + `/runtime-setup/runs/${artifact.runId}`,
    );
  });

  it('sends the canonical GLIRASTES_API_KEY and ignores the retired name', async () => {
    const { root, artifact } = await setupFixture();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: artifact.runId,
      appId: artifact.appId,
      status: 'ready',
      updatedAt: '2026-07-30T10:00:00.000Z',
    })));
    vi.stubGlobal('fetch', fetchImpl);
    // The retired setup-specific name must not shadow the canonical one.
    vi.stubEnv('GLIRASTES_SETUP_API_KEY', 'retired-name');
    vi.stubEnv('GLIRASTES_API_KEY', 'one-key');

    await runCli([
      'setup',
      'status',
      '--root',
      root,
      '--run-id',
      String(artifact.runId),
      '--base-url',
      'https://control.example',
      '--app-id',
      String(artifact.appId),
      '--quiet',
    ]);

    const headers = new Headers(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers,
    );
    expect(headers.get('authorization')).toBe('Bearer one-key');
  });

  it('fails before network access when app setup credentials are missing', async () => {
    const { root, artifact } = await setupFixture();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    // The retired name alone must not satisfy the requirement.
    vi.stubEnv('GLIRASTES_SETUP_API_KEY', 'retired-name');
    vi.stubEnv('GLIRASTES_API_KEY', '');

    await expect(runCli([
      'setup',
      'status',
      '--root',
      root,
      '--run-id',
      String(artifact.runId),
      '--base-url',
      'https://control.example',
      '--app-id',
      String(artifact.appId),
      '--quiet',
    ])).rejects.toThrow('GLIRASTES_API_KEY');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
