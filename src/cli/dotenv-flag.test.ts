import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createRouteSourceFingerprint,
  discoverFoundationExecutions,
} from '../codegen/index.js';
import { createSelfSetupPlan } from './commands/setup-plan.js';
import { runCli } from './index.js';

const SDK_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const BIN = join(SDK_ROOT, 'dist/cli/bin.js');
// The real Node.js binary: the point of these tests is what Node does with argv.
const NODE = process.versions.bun ? 'node' : process.execPath;
const NODE_MAJOR = Number(execFileSync(NODE, ['-p', 'process.versions.node'], { encoding: 'utf8' }).split('.')[0]);

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('--env-file is refused because Node.js owns it', () => {
  it.each([
    ['connect', ['connect', '--env-file', 'backend.env']],
    ['connect with =', ['connect', '--env-file=backend.env', '--json']],
    ['sync', ['sync', '--env-file', 'backend.env']],
    ['doctor', ['doctor', '--env-file=backend.env']],
    ['setup', ['setup', '--managed', '--env-file', 'backend.env']],
    ['setup sync', ['setup', 'sync', '--env-file=backend.env']],
  ])('stops %s before anything runs, naming --dotenv', async (_label, args) => {
    const clientFactory = vi.fn();
    const sync = vi.fn();
    const error = await runCli(args, {
      connect: { clientFactory, createPlan: vi.fn() },
      sync: { clientFactory: sync, createPlan: vi.fn() },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'E-SETUP-033',
      operation: 'cli',
      message: '--env-file is taken by Node.js itself: Node.js may already have loaded the variables of that file into this process. glirastes takes the secret file as --dotenv <path>.',
    });
    expect((error as Error).message).not.toContain('backend.env');
    expect(clientFactory).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('leaves --env-file of other commands alone', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['validate', '--help', '--env-file', 'x'])).resolves.toBeUndefined();
    log.mockRestore();
  });
});

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de70${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const apiKey = `gl_${'n'.repeat(40)}`;

/** A real Standalone setup with a current receipt, so the built CLI runs its own plan checks. */
async function setupProject(): Promise<{ root: string; appId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-dotenv-bin-'));
  created.push(root);
  const source = 'export async function GET() { return Response.json({ ok: true }); }';
  await mkdir(join(root, 'src/app/api/tasks'), { recursive: true });
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(join(root, 'src/app/api/tasks/route.ts'), source);
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
  await writeFile(join(root, '.glirastes/local-execution-inventory.v2.json'), JSON.stringify(inventory));
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  const appId = id('4');
  const artifact = JSON.stringify({
    schemaVersion: 1,
    artifactId: id('2'),
    runId: id('3'),
    appId,
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
      presentation: { locale: 'en-US', singular: 'Task list', plural: 'Task lists', approval: 'Show task list' },
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
      bundleDigest: digest('D'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('E'),
      appBehaviorDigest: digest('F'),
      responseStyleDigest: digest('G'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-07-30T10:00:00.000Z',
  });
  await writeFile(join(root, '.glirastes/app-setup.json'), artifact);
  await writeFile(join(root, '.glirastes/setup-artifact.json'), artifact);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    dependencies: { next: '16.0.0' },
    glirastes: {
      principal: 'server-verified',
      setupArtifact: '.glirastes/app-setup.json',
      inventory: '.glirastes/local-execution-inventory.v2.json',
      promptBundle: '.glirastes/prompt-bundle.json',
    },
  }));
  await writeFile(join(root, '.glirastes/prompt-bundle.json'), JSON.stringify({
    schemaVersion: 1,
    appId,
    artifactRef: 'local://fixture/prompts',
    sections: { planner: 'Plan safely.', appBehavior: 'Use the fixture.', responseStyle: 'Be concise.', capabilityFragments: {} },
  }));
  // The receipt `glirastes tools refresh` records: the self-plan digest.
  await writeFile(join(root, '.glirastes/setup-receipt.json'), JSON.stringify({
    schemaVersion: 1,
    planDigest: (await createSelfSetupPlan({ rootDir: root })).planDigest,
    mode: 'standalone',
    appId,
    toolCount: 1,
    runtimeDigest: digest('R'),
    promptDigest: digest('Q'),
    restartRequired: true,
  }));
  return { root, appId };
}

let stubBin: string;
let childEnv: NodeJS.ProcessEnv;

/** Runs the built CLI through Node.js, as `npx glirastes` does. */
function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(NODE, [BIN, ...args], { cwd, env: childEnv, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

/** A Control Plane stub that approves every pairing at once. */
async function controlPlane(appId: string): Promise<{ baseUrl: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  let baseUrl = '';
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/runtime-connect/pairings') {
        response.end(JSON.stringify({
          schemaVersion: 1,
          deviceCode: `device_${'d'.repeat(43)}`,
          userCode: 'ABCD-EFGH',
          verificationUri: `${baseUrl}/connect/pair`,
          expiresInSeconds: 60,
          pollIntervalMs: 1_000,
        }));
      } else if (request.url === '/v1/runtime-connect/pairings/token') {
        response.end(JSON.stringify({
          status: 'connected',
          connection: { schemaVersion: 1, baseUrl, appId, environmentId: null, runnerKey: 'server-runner' },
          apiKey,
        }));
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, requests, close: () => new Promise((closed) => server.close(() => closed())) };
}

describe('the built CLI binary and the secret file flag', () => {
  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error('Run bun run build first: dist/cli/bin.js is missing.');
    if (!readFileSync(join(SDK_ROOT, 'dist/cli/index.js'), 'utf8').includes('E-SETUP-033')) {
      throw new Error('Run bun run build first: dist/ predates the --dotenv flag.');
    }
    // `connect` opens the verification URL with `open` / `xdg-open`: shadow both.
    stubBin = await mkdtemp(join(tmpdir(), 'glirastes-dotenv-stub-bin-'));
    created.push(stubBin);
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(stubBin, name), '#!/bin/sh\nexit 0\n');
      await chmod(join(stubBin, name), 0o755);
    }
    childEnv = { ...process.env, PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}` };
    for (const name of Object.keys(childEnv)) {
      if (name.startsWith('GLIRASTES_') || name.startsWith('GIT_') || name === 'NODE_OPTIONS') delete childEnv[name];
    }
  });

  // The verification URL opener is a shell script stub; Windows has neither it nor `open`.
  describe.skipIf(process.platform === 'win32')('connect --dotenv', () => {
    it('reaches the CLI with a file that does not exist yet and creates it with the key', async () => {
      const { root, appId } = await setupProject();
      const plane = await controlPlane(appId);
      try {
        const result = await cli(['connect', '--base-url', plane.baseUrl, '--dotenv', 'backend.env', '--json'], root);

        expect(result.stderr).toBe('');
        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ status: 'connected', secretTarget: 'file', envFile: 'backend.env' });
        expect(result.stdout).not.toContain(apiKey);
        // A loopback Platform is self-hosted, so its URL is written next to the key.
        await expect(readFile(join(root, 'backend.env'), 'utf8')).resolves
          .toBe(`GLIRASTES_CONTROL_PLANE_URL=${plane.baseUrl}\nGLIRASTES_API_KEY=${apiKey}\n`);
      } finally {
        await plane.close();
      }
    }, 60_000);

    it('replaces only the key line of an existing file, and Node.js never loads it', async () => {
      const { root, appId } = await setupProject();
      const plane = await controlPlane(appId);
      try {
        // Had Node.js loaded this file (as it does for --env-file), the
        // NODE_OPTIONS line would preload a missing module and crash it.
        const before = [
          '# backend settings',
          'DATABASE_URL="postgres://localhost/app"',
          'NODE_OPTIONS="--require ./does-not-exist.cjs"',
          '',
          `GLIRASTES_CONTROL_PLANE_URL=${plane.baseUrl}`,
          `GLIRASTES_API_KEY=gl_${'o'.repeat(40)}`,
          'export FEATURE_FLAG=on # trailing comment',
          '',
        ].join('\n');
        await writeFile(join(root, 'backend.env'), before);

        const result = await cli(['connect', '--base-url', plane.baseUrl, '--dotenv=backend.env', '--json'], root);

        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
        const after = await readFile(join(root, 'backend.env'), 'utf8');
        const expected = before.split('\n');
        expected[5] = `GLIRASTES_API_KEY=${apiKey}`;
        expect(after).toBe(expected.join('\n'));
      } finally {
        await plane.close();
      }
    }, 60_000);

    it('appends exactly one key line to an existing file without one', async () => {
      const { root, appId } = await setupProject();
      const plane = await controlPlane(appId);
      try {
        const before = `# backend\nPORT=3000\nGLIRASTES_CONTROL_PLANE_URL=${plane.baseUrl}\n`;
        await writeFile(join(root, 'backend.env'), before);

        const result = await cli(['connect', '--base-url', plane.baseUrl, '--dotenv', 'backend.env', '--json'], root);

        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
        await expect(readFile(join(root, 'backend.env'), 'utf8')).resolves.toBe(`${before}GLIRASTES_API_KEY=${apiKey}\n`);
      } finally {
        await plane.close();
      }
    }, 60_000);
  });

  describe('connect --env-file', () => {
    it.each([
      ['--env-file <path>', ['--env-file', 'backend.env']],
      ['--env-file=<path>', ['--env-file=backend.env']],
    ])('stops with E-SETUP-033 for an existing file (%s) and prints nothing of it', async (_label, flag) => {
      const root = await mkdtemp(join(tmpdir(), 'glirastes-dotenv-reserved-'));
      created.push(root);
      const secret = `gl_${'s'.repeat(40)}`;
      await writeFile(join(root, 'backend.env'), `GLIRASTES_API_KEY=${secret}\nOTHER_SECRET=marker-value-1234\n`);
      const plane = await controlPlane(id('9'));
      try {
        for (const json of [false, true]) {
          const result = await cli(
            ['connect', '--base-url', plane.baseUrl, ...flag, ...(json ? ['--json'] : [])],
            root,
          );
          const output = `${result.stdout}${result.stderr}`;

          expect(result.code).not.toBe(0);
          expect(output).toContain('E-SETUP-033');
          expect(output).toContain('--dotenv <path>');
          expect(output).not.toMatch(/unknown/i);
          expect(output).not.toContain(secret);
          expect(output).not.toContain('marker-value-1234');
          if (json) expect(JSON.parse(result.stdout)).toMatchObject({ code: 'E-SETUP-033' });
        }
        expect(plane.requests).toEqual([]);
        await expect(readFile(join(root, 'backend.env'), 'utf8')).resolves
          .toBe(`GLIRASTES_API_KEY=${secret}\nOTHER_SECRET=marker-value-1234\n`);
      } finally {
        await plane.close();
      }
    }, 60_000);

    // A missing file cannot be caught: Node.js (20 and later) reads
    // `--env-file` even after the script name and exits 9 with
    // `node: <path>: not found` before glirastes runs. Pinned here so the docs
    // stay true; Node.js 18 does not do this.
    it.skipIf(NODE_MAJOR < 20)('documents that Node.js exits 9 before the CLI for a missing file', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glirastes-dotenv-missing-'));
      created.push(root);

      const result = await cli(['connect', '--env-file', 'missing.env'], root);

      expect(result.code).toBe(9);
      expect(result.stderr).toContain('missing.env: not found');
      expect(result.stderr).not.toContain('E-');
    }, 30_000);
  });
});
