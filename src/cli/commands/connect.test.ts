import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../index.js';
import {
  openVerificationUrl,
  runConnect,
  type ConnectCommandDependencies,
} from './connect.js';

const appId = '019fa9a9-d5f7-7ec3-a3c7-8899de400001';
const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de400002';
const artifactRaw = JSON.stringify({ appId });
const artifactDigest = `sha256:${createHash('sha256')
  .update(artifactRaw).digest('base64url')}`;
const deviceCode = `device_${'d'.repeat(43)}`;
const apiKey = `gl_${'k'.repeat(40)}`;

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];
afterAll(async () => {
  await Promise.all(createdRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function gitInit(root: string, gitignore: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: root });
  await writeFile(join(root, '.gitignore'), gitignore);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-connect-command-'));
  createdRoots.push(root);
  await mkdir(join(root, '.glirastes'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: '@example/fixture-app',
    dependencies: { next: '16.0.0' },
  }));
  await writeFile(join(root, '.glirastes/setup-receipt.json'), JSON.stringify({
    schemaVersion: 1,
    planDigest: `sha256:${'P'.repeat(43)}`,
    mode: 'standalone',
    appId,
    toolCount: 1,
    runtimeDigest: `sha256:${'R'.repeat(43)}`,
    promptDigest: `sha256:${'Q'.repeat(43)}`,
    restartRequired: true,
  }));
  await writeFile(join(root, '.glirastes/app-setup.json'), artifactRaw);
  return root;
}

async function recordReceiptPlanDigest(root: string, planDigest: string): Promise<void> {
  const path = join(root, '.glirastes/setup-receipt.json');
  const receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...receipt, planDigest }));
}

function plan() {
  return {
    schemaVersion: 1 as const,
    mode: 'standalone' as const,
    planDigest: `sha256:${'P'.repeat(43)}`,
    operations: [
      { kind: 'validate' as const, path: '.glirastes/app-setup.json', digest: artifactDigest },
      { kind: 'adopt' as const, path: '.glirastes/app-setup.json', digest: artifactDigest },
      { kind: 'build' as const, path: '.glirastes/build', digest: `sha256:${'B'.repeat(43)}` },
      { kind: 'receipt' as const, path: '.glirastes/setup-receipt.json', digest: artifactDigest },
    ],
    counts: { tools: 1, semanticChanges: 0 },
    semanticChanges: [],
    diagnostics: [],
    requiresConfirmation: false,
  };
}

function connectedClient(
  environment: string | null = environmentId,
  baseUrl = 'https://control.example',
) {
  return {
    startPairing: vi.fn().mockResolvedValue({
      schemaVersion: 1 as const,
      deviceCode,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://platform.example/connect/pair',
      expiresInSeconds: 60,
      pollIntervalMs: 1_000,
    }),
    pollForConnection: vi.fn().mockResolvedValue({
      status: 'connected' as const,
      connection: {
        schemaVersion: 1 as const,
        baseUrl,
        appId,
        environmentId: environment,
        runnerKey: 'server-value-must-not-win',
      },
      apiKey,
    }),
  };
}

describe('glirastes connect command', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['the hosted Platform without flag or env', undefined, undefined, 'https://api.glirastes.io'],
    ['GLIRASTES_CONTROL_PLANE_URL over the default', undefined, 'https://self.example', 'https://self.example'],
    ['the flag over the env', 'https://flag.example', 'https://self.example', 'https://flag.example'],
  ])('pairs against %s', async (_label, flag, env, expected) => {
    vi.stubEnv('GLIRASTES_CONTROL_PLANE_URL', env ?? '');
    const rootDir = await fixture();
    const clientFactory = vi.fn(() => ({
      startPairing: vi.fn().mockRejectedValue(new Error('stop')),
      pollForConnection: vi.fn(),
    }));

    await expect(runConnect({ rootDir, baseUrl: flag }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight: vi.fn(async () => ({
        projectRoot: rootDir,
        environmentPath: join(rootDir, '.env.local'),
        descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
      })),
      clientFactory,
      log: vi.fn(),
    })).rejects.toThrow('stop');

    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: expected }));
  });

  it('opens Windows verification URLs with metacharacters without a shell', async () => {
    const url = 'https://platform.example/connect/pair?code=A&B=x|calc.exe';
    const launch = vi.fn().mockResolvedValue(undefined);

    await openVerificationUrl(url, 'win32', launch);

    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', url],
    );
    expect(launch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(?:cmd|powershell)(?:\.exe)?$/i),
      expect.anything(),
    );
  });

  it('preflights, pairs the green receipt, and materializes only after identity validation', async () => {
    const rootDir = await fixture();
    const client = connectedClient();
    const calls: string[] = [];
    const log = vi.fn();
    const materialize = vi.fn(async (options) => {
      calls.push('materialize');
      expect(options.connection).toMatchObject({ appId, runnerKey: 'local-runner' });
      expect(options.apiKey).toBe(apiKey);
      return { descriptorPath: 'descriptor', environmentPath: 'environment' };
    });
    const dependencies: ConnectCommandDependencies = {
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight: vi.fn(async () => {
        calls.push('preflight');
        return {
          projectRoot: rootDir,
          environmentPath: join(rootDir, '.env.local'),
          descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
        };
      }),
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(async (url) => { calls.push('open'); expect(url).toBe('https://platform.example/connect/pair'); }),
      materialize,
      createRunnerKey: () => 'local-runner',
      log,
    };

    await runConnect({ rootDir, baseUrl: 'https://control.example' }, dependencies);

    expect(calls).toEqual(['preflight', 'open', 'materialize']);
    expect(client.startPairing).toHaveBeenCalledWith({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: '@example/fixture-app',
      artifactDigest,
      capabilities: { appConnection: 1 },
    }, undefined);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('https://platform.example/connect/pair');
    expect(output).toContain('ABCD-EFGH');
    expect(output).not.toContain(deviceCode);
    expect(output).not.toContain(apiKey);
  });

  it('emits bounded JSON without device codes or credentials', async () => {
    const rootDir = await fixture();
    const client = connectedClient();
    const log = vi.fn();
    await runConnect({ rootDir, baseUrl: 'https://control.example', json: true }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight: vi.fn().mockResolvedValue({
        projectRoot: rootDir,
        environmentPath: join(rootDir, '.env.local'),
        descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
      }),
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      materialize: vi.fn().mockResolvedValue({}),
      createRunnerKey: () => 'local-runner',
      log,
    });

    const output = log.mock.calls.flat().join('\n');
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      status: 'connected',
      appId,
      environmentId,
      secretTarget: 'file',
      envFile: '.env.local',
    });
    expect(output).not.toContain(deviceCode);
    expect(output).not.toContain(apiKey);
  });

  it('writes an app connection without environmentId and reports null', async () => {
    const rootDir = await fixture();
    const client = connectedClient(null);
    const log = vi.fn();
    const materialize = vi.fn().mockResolvedValue({});
    await runConnect({ rootDir, baseUrl: 'https://control.example', json: true }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight: vi.fn().mockResolvedValue({
        projectRoot: rootDir,
        environmentPath: join(rootDir, '.env.local'),
        descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
      }),
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      materialize,
      createRunnerKey: () => 'local-runner',
      log,
    });

    expect(JSON.parse(log.mock.calls.flat().join('\n'))).toEqual({
      schemaVersion: 1, status: 'connected', appId, environmentId: null, secretTarget: 'file', envFile: '.env.local',
    });
    expect(materialize.mock.calls[0]?.[0].connection).not.toHaveProperty('environmentId');
  });

  it('requires a current setup receipt before starting or consuming pairing', async () => {
    const rootDir = await fixture();
    await writeFile(join(rootDir, '.glirastes/setup-receipt.json'), JSON.stringify({
      schemaVersion: 1,
      planDigest: `sha256:${'S'.repeat(43)}`,
      appId,
    }));
    const client = connectedClient();
    await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      clientFactory: vi.fn(() => client),
      preflight: vi.fn(),
    })).rejects.toMatchObject({ code: 'E-CONNECT-SETUP-STALE' });
    expect(client.startPairing).not.toHaveBeenCalled();
    expect(client.pollForConnection).not.toHaveBeenCalled();
  });

  it('accepts the self-plan digest of a tools-generated receipt', async () => {
    const rootDir = await fixture();
    const selfDigest = `sha256:${'S'.repeat(43)}`;
    await recordReceiptPlanDigest(rootDir, selfDigest);
    const client = connectedClient();
    const createSelfPlan = vi.fn().mockResolvedValue({ ...plan(), planDigest: selfDigest });
    await runConnect({ rootDir, baseUrl: 'https://control.example', json: true }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      createSelfPlan,
      preflight: vi.fn().mockResolvedValue({}),
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      materialize: vi.fn().mockResolvedValue({}),
      createRunnerKey: () => 'local-runner',
      log: vi.fn(),
    });
    expect(createSelfPlan).toHaveBeenCalledWith({ rootDir });
    expect(client.startPairing).toHaveBeenCalledOnce();
  });

  it('rejects a receipt that matches neither the plan nor the self-plan', async () => {
    const rootDir = await fixture();
    await recordReceiptPlanDigest(rootDir, `sha256:${'S'.repeat(43)}`);
    const client = connectedClient();
    await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      createSelfPlan: vi.fn().mockResolvedValue({ ...plan(), planDigest: `sha256:${'Q'.repeat(43)}` }),
      clientFactory: vi.fn(() => client),
      preflight: vi.fn(),
    })).rejects.toMatchObject({ code: 'E-CONNECT-SETUP-STALE' });
    expect(client.startPairing).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable local setup identity before pairing', async () => {
    const rootDir = await fixture();
    await writeFile(join(rootDir, '.glirastes/app-setup.json'), '{invalid');
    const client = connectedClient();
    await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      clientFactory: vi.fn(() => client),
    })).rejects.toMatchObject({ code: 'E-CONNECT-SETUP-STALE' });
    expect(client.startPairing).not.toHaveBeenCalled();
  });

  it.each(['denied', 'expired'] as const)(
    'does not materialize after %s pairing',
    async (status) => {
      const rootDir = await fixture();
      const client = connectedClient();
      client.pollForConnection.mockResolvedValueOnce({ status } as never);
      const materialize = vi.fn();
      await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, {
        createPlan: vi.fn().mockResolvedValue(plan()),
        preflight: vi.fn().mockResolvedValue({}),
        clientFactory: vi.fn(() => client),
        openBrowser: vi.fn(),
        materialize,
        log: vi.fn(),
      })).rejects.toMatchObject({
        code: status === 'denied' ? 'E-CONNECT-DENIED' : 'E-CONNECT-EXPIRED',
      });
      expect(materialize).not.toHaveBeenCalled();
    },
  );

  it('rejects app identity mismatch without materializing any bytes', async () => {
    const rootDir = await fixture();
    const client = connectedClient();
    client.pollForConnection.mockResolvedValueOnce({
      status: 'connected',
      connection: {
        schemaVersion: 1,
        baseUrl: 'https://control.example',
        appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400099',
        environmentId,
        runnerKey: 'server-runner',
      },
      apiKey,
    } as never);
    const materialize = vi.fn();
    await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight: vi.fn().mockResolvedValue({}),
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      materialize,
      log: vi.fn(),
    })).rejects.toMatchObject({ code: 'E-CONNECT-APP-MISMATCH' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('restores prior connection bytes when atomic materialization fails', async () => {
    const rootDir = await fixture();
    const environmentPath = join(rootDir, '.env.local');
    const descriptorPath = join(rootDir, '.glirastes/platform-connection.json');
    await writeFile(environmentPath, 'ORIGINAL_ENV=kept\n');
    await writeFile(descriptorPath, 'original descriptor');

    await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      clientFactory: vi.fn(() => connectedClient()),
      openBrowser: vi.fn(),
      isGitIgnored: vi.fn().mockResolvedValue(true),
      createRunnerKey: () => 'local-runner',
      atomicWriteHooks: {
        afterReplace(index) {
          if (index === 0) throw new Error('injected write failure');
        },
      },
      log: vi.fn(),
    })).rejects.toThrow('injected write failure');

    await expect(readFile(environmentPath, 'utf8')).resolves.toBe('ORIGINAL_ENV=kept\n');
    await expect(readFile(descriptorPath, 'utf8')).resolves.toBe('original descriptor');
  });

  describe('tools.json', () => {
    const tools = (patch: Record<string, unknown> = {}) => JSON.stringify({
      schemaVersion: 1, appId, targetAppKey: 'fixture-app', locale: 'en', sources: ['next-app', 'react-actions'], ...patch,
    });
    const deps = (rootDir: string, client: ReturnType<typeof connectedClient>, preflight = vi.fn().mockResolvedValue({
      projectRoot: rootDir,
      environmentPath: join(rootDir, '.env.local'),
      descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
    })): ConnectCommandDependencies => ({
      createPlan: vi.fn().mockResolvedValue(plan()),
      preflight,
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      materialize: vi.fn().mockResolvedValue({}),
      createRunnerKey: () => 'local-runner',
      log: vi.fn(),
    });

    it('takes the framework from the configured sources instead of package.json', async () => {
      const rootDir = await fixture();
      await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: '@example/fixture-app', dependencies: {} }));
      await writeFile(join(rootDir, '.glirastes/tools.json'), tools());
      const client = connectedClient();
      const preflight = vi.fn().mockResolvedValue({
        projectRoot: rootDir,
        environmentPath: join(rootDir, '.env.local'),
        descriptorPath: join(rootDir, '.glirastes/platform-connection.json'),
      });
      await runConnect({ rootDir, baseUrl: 'https://control.example' }, deps(rootDir, client, preflight));
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ framework: 'nextjs' }));
      expect(client.startPairing).toHaveBeenCalledOnce();
    });

    it.each([
      ['tools.json names another app', '.glirastes/tools.json', () => tools({ appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400009' })],
      ['the checkout is already connected as another app', '.glirastes/platform-connection.json', () => JSON.stringify({
        schemaVersion: 1, baseUrl: 'https://control.example', appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400009', environmentId, runnerKey: 'local-runner',
      })],
    ])('refuses to change the app id silently when %s', async (_label, path, content) => {
      const rootDir = await fixture();
      await writeFile(join(rootDir, path), content());
      const client = connectedClient();
      await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, deps(rootDir, client)))
        .rejects.toMatchObject({ code: 'E-CONNECT-APP-ID-CHANGED' });
      expect(client.startPairing).not.toHaveBeenCalled();
    });
  });

  describe('apps without Next.js', () => {
    const toolsConfig = (sources: unknown[], patch: Record<string, unknown> = {}) => JSON.stringify({
      schemaVersion: 1, appId, targetAppKey: 'backend', locale: 'en', sources, ...patch,
    });

    async function backendFixture(sources: unknown[] = ['openapi'], patch: Record<string, unknown> = {}) {
      const rootDir = await fixture();
      await writeFile(join(rootDir, 'package.json'), JSON.stringify({
        name: '@example/backend',
        dependencies: { '@nestjs/core': '11.0.0' },
      }));
      await writeFile(join(rootDir, '.glirastes/tools.json'), toolsConfig(sources, patch));
      return rootDir;
    }

    function backendDeps(
      client: ReturnType<typeof connectedClient>,
      overrides: Partial<ConnectCommandDependencies> = {},
    ) {
      const log = vi.fn();
      return {
        log,
        output: () => log.mock.calls.flat().join('\n'),
        value: {
          createPlan: vi.fn().mockResolvedValue(plan()),
          clientFactory: vi.fn(() => client),
          openBrowser: vi.fn(),
          createRunnerKey: () => 'local-runner',
          isGitIgnored: vi.fn().mockResolvedValue(true),
          isTTY: () => true,
          log,
          ...overrides,
        } satisfies ConnectCommandDependencies,
      };
    }

    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

    it.each([
      ['an openapi source', ['openapi']],
      ['a nest source', ['nest']],
    ])('pairs %s, writes the descriptor and shows the key once on a terminal', async (_label, sources) => {
      const rootDir = await backendFixture(sources);
      const client = connectedClient(null, 'https://api.glirastes.io');
      const deps = backendDeps(client);

      await runConnect({ rootDir, baseUrl: 'https://api.glirastes.io' }, deps.value);

      expect(client.startPairing).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(join(rootDir, '.glirastes/platform-connection.json'), 'utf8')))
        .toEqual({ schemaVersion: 1, baseUrl: 'https://api.glirastes.io', appId, runnerKey: 'local-runner' });
      expect(await readdir(rootDir)).not.toContain('.env.local');
      expect(await readdir(rootDir)).not.toContain('.env');
      const output = deps.output();
      expect(occurrences(output, apiKey)).toBe(1);
      expect(output).toContain('Connected to the Glirastes Platform.');
      expect(output).toContain('GLIRASTES_API_KEY in the environment of the server process');
      expect(output).toContain('cannot be shown again');
      expect(output).not.toContain('GLIRASTES_CONTROL_PLANE_URL');
      expect(output).not.toContain(deviceCode);
      expect(deps.value.isGitIgnored).not.toHaveBeenCalled();
    });

    it('names GLIRASTES_CONTROL_PLANE_URL for a self-hosted Platform', async () => {
      const rootDir = await backendFixture();
      const deps = backendDeps(connectedClient(null));

      await runConnect({ rootDir, baseUrl: 'https://control.example' }, deps.value);

      expect(deps.output()).toContain('GLIRASTES_CONTROL_PLANE_URL=https://control.example');
      expect(occurrences(deps.output(), apiKey)).toBe(1);
    });

    it('returns the key exactly once in JSON, even without a terminal', async () => {
      const rootDir = await backendFixture(['nest']);
      const deps = backendDeps(connectedClient(null), { isTTY: () => false });

      await runConnect({ rootDir, baseUrl: 'https://control.example', json: true }, deps.value);

      const output = deps.output();
      expect(JSON.parse(output)).toEqual({
        schemaVersion: 1,
        status: 'connected',
        appId,
        environmentId: null,
        secretTarget: 'output',
        apiKey,
        controlPlaneUrl: 'https://control.example',
      });
      expect(occurrences(output, apiKey)).toBe(1);
      expect(output).not.toContain(deviceCode);
    });

    it('refuses to print the key into a non-terminal before pairing', async () => {
      const rootDir = await backendFixture();
      const client = connectedClient(null);
      const deps = backendDeps(client, { isTTY: () => false });

      const error = await runConnect({ rootDir, baseUrl: 'https://control.example' }, deps.value)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'E-CONNECT-SECRET-OUTPUT-REFUSED',
        remediation: 'choose-connection-secret-target',
      });
      expect((error as Error).message).toContain('--dotenv <path>');
      expect((error as Error).message).toContain('--json');
      expect(client.startPairing).not.toHaveBeenCalled();
      expect(await readdir(join(rootDir, '.glirastes'))).not.toContain('platform-connection.json');
    });

    it('writes the key to --dotenv and reports the file, not the key', async () => {
      const rootDir = await backendFixture();
      await mkdir(join(rootDir, 'apps/backend'), { recursive: true });
      await writeFile(join(rootDir, 'apps/backend/.env'), '# backend\nDATABASE_URL=postgres://db\n');
      const deps = backendDeps(connectedClient(null), { isTTY: () => false });

      await runConnect({
        rootDir, baseUrl: 'https://control.example', json: true, envFile: 'apps/backend/.env',
      }, deps.value);

      expect(JSON.parse(deps.output())).toEqual({
        schemaVersion: 1,
        status: 'connected',
        appId,
        environmentId: null,
        secretTarget: 'file',
        envFile: join('apps', 'backend', '.env'),
      });
      expect(deps.output()).not.toContain(apiKey);
      await expect(readFile(join(rootDir, 'apps/backend/.env'), 'utf8')).resolves.toBe(
        `# backend\nDATABASE_URL=postgres://db\nGLIRASTES_CONTROL_PLANE_URL=https://control.example\nGLIRASTES_API_KEY=${apiKey}\n`,
      );
      expect(await readdir(rootDir)).not.toContain('.env.local');
    });

    it('names the written file in text mode without printing the key', async () => {
      const rootDir = await backendFixture();
      const deps = backendDeps(connectedClient(null, 'https://api.glirastes.io'), { isTTY: () => false });

      await runConnect({ rootDir, baseUrl: 'https://api.glirastes.io', envFile: '.env' }, deps.value);

      expect(deps.output()).toContain('GLIRASTES_API_KEY was written to .env.');
      expect(deps.output()).not.toContain(apiKey);
      await expect(readFile(join(rootDir, '.env'), 'utf8')).resolves.toBe(`GLIRASTES_API_KEY=${apiKey}\n`);
    });

    it.each([
      ['not ignored by Git', 'apps/backend/.env', { isGitIgnored: vi.fn().mockResolvedValue(false) }, 'E-CONNECT-SECRET-TRACKED'],
      ['outside the project', '../shared/.env', {}, 'E-CONNECT-PATH-OUTSIDE'],
      ['in a missing directory', 'apps/missing/.env', {}, 'E-CONNECT-PATH-INVALID'],
    ] as const)('aborts before pairing when --dotenv is %s', async (_label, envFile, overrides, code) => {
      const rootDir = await backendFixture();
      await mkdir(join(rootDir, 'apps/backend'), { recursive: true });
      const client = connectedClient(null);
      const deps = backendDeps(client, overrides);

      const error = await runConnect({ rootDir, baseUrl: 'https://control.example', envFile }, deps.value)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code });
      expect(client.startPairing).not.toHaveBeenCalled();
      expect(JSON.stringify(error)).not.toContain(apiKey);
      if (code === 'E-CONNECT-SECRET-TRACKED') {
        expect(error).toMatchObject({ remediation: 'ignore-connection-env-file', path: join('apps', 'backend', '.env') });
      }
    });

    it('aborts before pairing when the env file points at another Control Plane', async () => {
      const rootDir = await backendFixture();
      const original = 'GLIRASTES_CONTROL_PLANE_URL=https://other.example\nKEEP=1\n';
      await writeFile(join(rootDir, '.env'), original);
      const client = connectedClient(null, 'https://api.glirastes.io');

      await expect(runConnect(
        { rootDir, baseUrl: 'https://api.glirastes.io', envFile: '.env' },
        backendDeps(client).value,
      )).rejects.toMatchObject({ code: 'E-CONNECT-ENV-PLANE-CONFLICT' });

      expect(client.startPairing).not.toHaveBeenCalled();
      await expect(readFile(join(rootDir, '.env'), 'utf8')).resolves.toBe(original);
    });

    it('takes --dotenv from the CLI', async () => {
      const rootDir = await backendFixture();
      vi.stubEnv('GLIRASTES_CONTROL_PLANE_URL', 'https://control.example');
      const deps = backendDeps(connectedClient(null), { isTTY: () => false });

      await runCli(['connect', '--root', rootDir, '--dotenv', '.env', '--json'], { connect: deps.value });

      expect(JSON.parse(deps.output())).toMatchObject({ secretTarget: 'file', envFile: '.env' });
      await expect(runCli(['connect', '--root', rootDir, '--dotenv', '--json'], { connect: deps.value }))
        .rejects.toMatchObject({ code: 'E-SETUP-031' });
    });

    it('takes --dotenv=<path> and refuses a repeated --dotenv before pairing', async () => {
      const rootDir = await backendFixture();
      await mkdir(join(rootDir, 'apps/backend'), { recursive: true });
      const client = connectedClient(null);
      const deps = backendDeps(client, { isTTY: () => false });

      await runCli(['connect', `--root=${rootDir}`, '--base-url=https://control.example', '--dotenv=apps/backend/.env', '--json'], { connect: deps.value });

      expect(JSON.parse(deps.output())).toMatchObject({ secretTarget: 'file', envFile: join('apps', 'backend', '.env') });
      expect(deps.output()).not.toContain(apiKey);

      const repeated = connectedClient(null);
      await expect(runCli(
        ['connect', '--root', rootDir, '--dotenv=a.env', '--dotenv', 'b.env', '--json'],
        { connect: backendDeps(repeated).value },
      )).rejects.toMatchObject({ code: 'E-SETUP-032' });
      expect(repeated.startPairing).not.toHaveBeenCalled();
    });

    it('refuses before pairing when no staging place renames into the env file directory', async () => {
      const rootDir = await backendFixture();
      await gitInit(rootDir, '.env\n');
      const client = connectedClient(null);
      const deps = backendDeps(client, {
        isGitIgnored: undefined,
        staging: { canRenameInto: async () => false },
      });

      await expect(runConnect({ rootDir, baseUrl: 'https://control.example', envFile: '.env' }, deps.value))
        .rejects.toMatchObject({ code: 'E-CONNECT-STAGING-NOT-IGNORED' });
      expect(client.startPairing).not.toHaveBeenCalled();
    });

    it('says the issued key was not stored when staging fails after pairing', async () => {
      const rootDir = await backendFixture();
      await gitInit(rootDir, '.env\n');
      const client = connectedClient(null);
      let probes = 0;
      // The private place renames into the directory at preflight, not later.
      const deps = backendDeps(client, {
        isGitIgnored: undefined,
        staging: { canRenameInto: async () => (probes += 1) === 1 },
      });

      const error = await runConnect({ rootDir, baseUrl: 'https://control.example', envFile: '.env' }, deps.value)
        .catch((caught: unknown) => caught);

      expect(client.startPairing).toHaveBeenCalled();
      expect(error).toMatchObject({
        code: 'E-CONNECT-SECRET-NOT-STORED',
        remediation: 'rerun-connect-and-revoke-unused-key',
      });
      expect((error as Error).message).toContain('issued a connection key');
      expect((error as Error).message).toContain('revoke the unused key');
      expect((error as Error).message).toContain('E-CONNECT-STAGING-NOT-IGNORED');
      expect(JSON.stringify(error) + (error as Error).message + deps.output()).not.toContain(apiKey);
      expect(await readdir(rootDir)).not.toContain('.env');
    });

    it('detects Next.js from package.json when tools.json has no next-* source', async () => {
      const rootDir = await backendFixture(['openapi', 'react-actions']);
      await writeFile(join(rootDir, 'package.json'), JSON.stringify({
        name: '@example/next-app', dependencies: { next: '16.0.0' },
      }));
      const deps = backendDeps(connectedClient(null), { isTTY: () => false });

      await runConnect({ rootDir, baseUrl: 'https://control.example', json: true }, deps.value);

      expect(JSON.parse(deps.output())).toMatchObject({ secretTarget: 'file', envFile: '.env.local' });
      await expect(readFile(join(rootDir, '.env.local'), 'utf8')).resolves.toContain(`GLIRASTES_API_KEY=${apiKey}`);
    });

    it('uses connection.envFile of tools.json, and the flag wins over it', async () => {
      const rootDir = await backendFixture(['openapi'], { connection: { envFile: 'config/.env' } });
      await mkdir(join(rootDir, 'config'));
      const fromConfig = backendDeps(connectedClient(null), { isTTY: () => false });
      await runConnect({ rootDir, baseUrl: 'https://control.example', json: true }, fromConfig.value);
      expect(JSON.parse(fromConfig.output())).toMatchObject({ secretTarget: 'file', envFile: join('config', '.env') });
      await expect(readFile(join(rootDir, 'config/.env'), 'utf8')).resolves.toContain(`GLIRASTES_API_KEY=${apiKey}`);

      const fromFlag = backendDeps(connectedClient(null), { isTTY: () => false });
      await runConnect({ rootDir, baseUrl: 'https://control.example', json: true, envFile: '.env.backend' }, fromFlag.value);
      expect(JSON.parse(fromFlag.output())).toMatchObject({ secretTarget: 'file', envFile: '.env.backend' });
    });
  });

  it('connects a Next.js app whose temporary directory is on another filesystem', async () => {
    const rootDir = await fixture();
    await gitInit(rootDir, '.env*.local\n');
    const elsewhere = await mkdtemp(join(tmpdir(), 'glirastes-other-device-'));
    createdRoots.push(elsewhere);
    const client = connectedClient();
    await runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      clientFactory: vi.fn(() => client),
      openBrowser: vi.fn(),
      // Only the git dir renames into the project; the temporary directory gives EXDEV.
      staging: {
        temporaryDirectory: elsewhere,
        canRenameInto: async (from) => from.includes(`${join('.git', 'glirastes-connect-staging-')}`),
      },
      createRunnerKey: () => 'local-runner',
      log: vi.fn(),
    });
    expect(client.startPairing).toHaveBeenCalledOnce();
    await expect(readFile(join(rootDir, '.env.local'), 'utf8')).resolves.toContain(`GLIRASTES_API_KEY=${apiKey}`);
  });

  it('keeps writing .env.local for Next.js without a terminal', async () => {
    const rootDir = await fixture();
    const log = vi.fn();
    await runConnect({ rootDir, baseUrl: 'https://control.example' }, {
      createPlan: vi.fn().mockResolvedValue(plan()),
      clientFactory: vi.fn(() => connectedClient()),
      openBrowser: vi.fn(),
      isGitIgnored: vi.fn().mockResolvedValue(true),
      isTTY: () => false,
      createRunnerKey: () => 'local-runner',
      log,
    });
    await expect(readFile(join(rootDir, '.env.local'), 'utf8')).resolves.toContain(`GLIRASTES_API_KEY=${apiKey}`);
    expect(log.mock.calls.flat().join('\n')).not.toContain(apiKey);
    expect(log).toHaveBeenLastCalledWith('Connected to the Glirastes Platform. Restart the application.');
  });
});
