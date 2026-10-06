import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-connect-command-'));
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

function connectedClient() {
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
        baseUrl: 'https://control.example',
        appId,
        environmentId,
        runnerKey: 'server-value-must-not-win',
      },
      apiKey,
    }),
  };
}

describe('glirastes connect command', () => {
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
    });
    expect(output).not.toContain(deviceCode);
    expect(output).not.toContain(apiKey);
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

    it('names the configured sources when the stack has no automatic connection', async () => {
      const rootDir = await fixture();
      await writeFile(join(rootDir, '.glirastes/tools.json'), tools({ sources: ['react-actions', 'url-filters'] }));
      const client = connectedClient();
      await expect(runConnect({ rootDir, baseUrl: 'https://control.example' }, deps(rootDir, client))).rejects.toMatchObject({
        code: 'E-CONNECT-FRAMEWORK-UNSUPPORTED',
        message: 'Automatic connection materialization currently requires Next.js; .glirastes/tools.json declares react-actions, url-filters.',
      });
      expect(client.startPairing).not.toHaveBeenCalled();
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
});
