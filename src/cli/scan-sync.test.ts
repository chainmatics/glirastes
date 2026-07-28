import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { runCli } from './index.js';

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-scan-'));
  await mkdir(join(root, 'src/app/api/tasks'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true }),
  );
  await writeFile(
    join(root, 'src/app/api/tasks/route.ts'),
    `export async function GET() {
      return Response.json({ ok: true });
    }`,
  );
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('glirastes scan --sync', () => {
  it('scans locally and imports the redacted artifact with an environment key', async () => {
    const root = await projectFixture();
    const toolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
    const fetchImpl = vi.fn().mockImplementation(
      async (_url: string, request: RequestInit) => {
        const upload = JSON.parse(String(request.body));
        return new Response(JSON.stringify({
          createdDrafts: 1,
          unchanged: 0,
          bindings: [{
            toolId,
            stableKey: 'GET /api/tasks',
            sourceFingerprint: upload.candidates[0].sourceFingerprint,
          }],
          tombstoneCandidates: [],
          interview: [],
        }), { status: 201 });
      },
    );
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubEnv('GLIRASTES_SETUP_API_KEY', 'setup-secret');

    await runCli([
      'scan',
      '--root',
      root,
      '--sync',
      '--base-url',
      'https://control.example',
      '--app-id',
      'app-1',
      '--environment-id',
      'env-1',
      '--quiet',
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain(
      '/v1/apps/app-1/environments/env-1/runtime-setup/scans',
    );
    expect(request.headers).toMatchObject({
      authorization: 'Bearer setup-secret',
    });
    expect(String(request.body)).not.toContain('return Response');
    const uploadedScan = JSON.parse(String(request.body));
    const sourceFingerprint = uploadedScan.candidates[0].sourceFingerprint;
    await expect(readFile(
      join(root, '.glirastes/platform-tool-bindings.json'),
      'utf8',
    ).then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      targetAppId: 'app-1',
      environmentId: 'env-1',
      bindings: [{
        toolId,
        stableKey: 'GET /api/tasks',
        sourceFingerprint,
      }],
    });
  });

  it('fails before network access when required sync configuration is missing', async () => {
    const root = await projectFixture();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubEnv('GLIRASTES_SETUP_API_KEY', '');

    await expect(runCli([
      'scan',
      '--root',
      root,
      '--sync',
      '--base-url',
      'https://control.example',
      '--app-id',
      'app-1',
      '--environment-id',
      'env-1',
      '--quiet',
    ])).rejects.toThrow('GLIRASTES_SETUP_API_KEY');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
