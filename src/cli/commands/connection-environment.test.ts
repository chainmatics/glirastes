import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { foundationDiagnosticJson } from '../../diagnostics/foundation-diagnostic.js';
import {
  materializeConnectionEnvironment,
  preflightConnectionEnvironment,
} from './connection-environment.js';

const connection = {
  schemaVersion: 1 as const,
  baseUrl: 'https://platform.glirastes.io',
  appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400001',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de400002',
  runnerKey: 'local-019fa9a9',
};
const credential = `gl_${'x'.repeat(40)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-connection-env-'));
  await mkdir(join(root, '.glirastes'));
  return {
    root,
    environmentPath: join(root, '.env.local'),
    descriptorPath: join(root, '.glirastes', 'platform-connection.json'),
  };
}

describe('connection environment preflight', () => {
  it('fails before credential consumption when the secret file is tracked', async () => {
    const { root } = await fixture();
    const consumeCredential = vi.fn();
    let error: unknown;
    try {
      await preflightConnectionEnvironment({
        projectRoot: root,
        framework: 'nextjs',
        isGitIgnored: vi.fn().mockResolvedValue(false),
      });
    } catch (caught) {
      error = caught;
    }

    expect(consumeCredential).not.toHaveBeenCalled();
    expect(foundationDiagnosticJson(error, 'connect')).toMatchObject({
      code: 'E-CONNECT-SECRET-TRACKED',
      remediation: 'ignore-env-local',
    });
    expect(JSON.stringify(foundationDiagnosticJson(error, 'connect')))
      .not.toContain(credential);
  });

  it('rejects unsupported frameworks, symlinks, and outside-root overrides', async () => {
    const { root, environmentPath } = await fixture();
    await expect(preflightConnectionEnvironment({
      projectRoot: root,
      framework: 'express' as never,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow('Next.js');

    await symlink(join(root, 'elsewhere'), environmentPath);
    await expect(preflightConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      isGitIgnored: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow('symlink');

    await expect(preflightConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      environmentPath: join(root, '..', '.env.local'),
      isGitIgnored: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow('inside the project');
  });
});

describe('connection environment materialization', () => {
  it('writes the key and a self-hosted URL, dropping the obsolete variables', async () => {
    const { root, environmentPath } = await fixture();
    const original = [
      '# existing',
      'UNRELATED=value',
      'GLIRASTES_APP_ID=old',
      'GLIRASTES_ENVIRONMENT_ID=old',
      'GLIRASTES_RUNNER_KEY=old',
      'TAIL=kept',
      '',
    ].join('\r\n');
    await writeFile(environmentPath, original);

    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection,
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    const result = await readFile(environmentPath, 'utf8');
    expect(result).toContain('# existing\r\nUNRELATED=value\r\n');
    expect(result).toContain('\r\nTAIL=kept\r\n');
    for (const name of ['GLIRASTES_APP_ID', 'GLIRASTES_ENVIRONMENT_ID', 'GLIRASTES_RUNNER_KEY']) {
      expect(result).not.toContain(name);
    }
    expect(result.match(/^GLIRASTES_API_KEY=/gm)).toHaveLength(1);
    expect(result).toContain(`GLIRASTES_API_KEY=${credential}`);
    expect(result).toContain(`GLIRASTES_CONTROL_PLANE_URL=${connection.baseUrl}`);
  });

  it('writes only the key for the hosted platform and removes a stale URL', async () => {
    const { root, environmentPath } = await fixture();
    await writeFile(environmentPath, 'GLIRASTES_CONTROL_PLANE_URL=http://localhost:8101\nKEEP=1\n');

    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection: { ...connection, baseUrl: 'https://api.glirastes.chainmatics.io' },
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    await expect(readFile(environmentPath, 'utf8'))
      .resolves.toBe(`KEEP=1\nGLIRASTES_API_KEY=${credential}\n`);
  });

  it('writes a secret-free descriptor and creates the secret file as 0600', async () => {
    const { root, environmentPath, descriptorPath } = await fixture();
    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection,
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    const descriptor = await readFile(descriptorPath, 'utf8');
    expect(JSON.parse(descriptor)).toEqual(connection);
    expect(descriptor).not.toContain(credential);
    expect((await stat(environmentPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects duplicate connection variables without changing bytes', async () => {
    const { root, environmentPath } = await fixture();
    const original = 'GLIRASTES_APP_ID=one\nGLIRASTES_APP_ID=two\n';
    await writeFile(environmentPath, original);
    await expect(materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection,
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow('duplicate');
    await expect(readFile(environmentPath, 'utf8')).resolves.toBe(original);
  });

  it('restores descriptor and secret bytes when either replacement fails', async () => {
    const { root, environmentPath, descriptorPath } = await fixture();
    await writeFile(environmentPath, 'OLD_ENV=1\n');
    await writeFile(descriptorPath, 'old-descriptor');

    await expect(materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection,
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
      atomicWriteHooks: {
        afterReplace(index) {
          if (index === 0) throw new Error('injected replacement failure');
        },
      },
    })).rejects.toThrow('injected');

    await expect(readFile(environmentPath, 'utf8')).resolves.toBe('OLD_ENV=1\n');
    await expect(readFile(descriptorPath, 'utf8')).resolves.toBe('old-descriptor');
    await expect(lstat(environmentPath)).resolves.toBeDefined();
  });
});
