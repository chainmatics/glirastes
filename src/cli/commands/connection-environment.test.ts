import { execFile } from 'node:child_process';
import { realpath as realpathCallback } from 'node:fs';
import {
  chmod,
  lstat,
  lutimes,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foundationDiagnosticJson } from '../../diagnostics/foundation-diagnostic.js';
import {
  materializeConnectionEnvironment,
  prepareSecretStaging,
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
const execFileAsync = promisify(execFile);
const realpathNative = promisify(realpathCallback.native);

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

  it('targets no secret file without Next.js or a chosen env file', async () => {
    const { root, descriptorPath } = await fixture();
    const isGitIgnored = vi.fn();
    await expect(preflightConnectionEnvironment({ projectRoot: root, isGitIgnored }))
      .resolves.toEqual({ projectRoot: root, descriptorPath });
    expect(isGitIgnored).not.toHaveBeenCalled();
  });

  it('rejects symlinks and outside-root overrides', async () => {
    const { root, environmentPath } = await fixture();

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

describe('connection environment preflight with a real Git repository', () => {
  async function gitFixture() {
    const { root } = await fixture();
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    // Independent of the developer's global excludes file.
    await execFileAsync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: root });
    await mkdir(join(root, 'apps/backend'), { recursive: true });
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await mkdir(join(root, 'apps/web'), { recursive: true });
    // A pattern in the root .gitignore and a nested .gitignore.
    await writeFile(join(root, '.gitignore'), 'apps/api/.env\n');
    await writeFile(join(root, 'apps/backend/.gitignore'), '.env\n');
    return root;
  }

  it.each([
    ['a nested .gitignore', 'apps/backend/.env'],
    ['a pattern in the root .gitignore', 'apps/api/.env'],
  ])('accepts a nested env file ignored by %s', async (_label, environmentPath) => {
    const root = await gitFixture();
    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath }))
      .resolves.toMatchObject({ environmentPath: join(root, environmentPath), environmentKind: 'custom' });
  });

  it('rejects a nested env file that Git does not ignore', async () => {
    const root = await gitFixture();
    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'apps/web/.env' }))
      .rejects.toMatchObject({
        code: 'E-CONNECT-SECRET-TRACKED',
        remediation: 'ignore-connection-env-file',
        path: join('apps', 'web', '.env'),
      });
  });
});

describe('connection environment in a chosen env file', () => {
  const lines = (newline: string, ...values: string[]) => values.join(newline);

  it.each([['LF', '\n'], ['CRLF', '\r\n']])(
    'replaces only the key line and keeps every other byte (%s)',
    async (_label, newline) => {
      const { root } = await fixture();
      const path = join(root, '.env');
      await writeFile(path, lines(newline,
        '# Backend settings',
        'DATABASE_URL="postgres://db"',
        '',
        'export GLIRASTES_API_KEY=gl_old',
        'GLIRASTES_APP_ID=kept-in-a-chosen-file',
        '  # indented comment',
        'TAIL=1',
        '',
      ));

      await materializeConnectionEnvironment({
        projectRoot: root,
        environmentPath: '.env',
        connection: { ...connection, baseUrl: 'https://api.glirastes.io' },
        apiKey: credential,
        isGitIgnored: vi.fn().mockResolvedValue(true),
      });

      await expect(readFile(path, 'utf8')).resolves.toBe(lines(newline,
        '# Backend settings',
        'DATABASE_URL="postgres://db"',
        '',
        `export GLIRASTES_API_KEY=${credential}`,
        'GLIRASTES_APP_ID=kept-in-a-chosen-file',
        '  # indented comment',
        'TAIL=1',
        '',
      ));
    },
  );

  it.each([['LF', '\n'], ['CRLF', '\r\n']])(
    'appends the key without adding a final newline the file did not have (%s)',
    async (_label, newline) => {
      const { root } = await fixture();
      const path = join(root, '.env');
      await writeFile(path, lines(newline, 'A=1', 'B=2'));

      await materializeConnectionEnvironment({
        projectRoot: root,
        environmentPath: '.env',
        connection,
        apiKey: credential,
        isGitIgnored: vi.fn().mockResolvedValue(true),
      });

      await expect(readFile(path, 'utf8')).resolves.toBe(lines(newline,
        'A=1',
        'B=2',
        `GLIRASTES_CONTROL_PLANE_URL=${connection.baseUrl}`,
        `GLIRASTES_API_KEY=${credential}`,
      ));
    },
  );

  it('keeps mixed line endings line by line', async () => {
    const { root } = await fixture();
    const path = join(root, '.env');
    await writeFile(path, 'A=1\r\nGLIRASTES_API_KEY=gl_old\nB=2\r\n');

    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: '.env',
      connection: { ...connection, baseUrl: 'https://api.glirastes.io/' },
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    await expect(readFile(path, 'utf8'))
      .resolves.toBe(`A=1\r\nGLIRASTES_API_KEY=${credential}\nB=2\r\n`);
  });

  it('keeps a URL line that already names the hosted Platform', async () => {
    const { root } = await fixture();
    const path = join(root, '.env');
    await writeFile(path, 'GLIRASTES_CONTROL_PLANE_URL="https://api.glirastes.io"\n');

    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: '.env',
      connection: { ...connection, baseUrl: 'https://api.glirastes.io' },
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    await expect(readFile(path, 'utf8')).resolves
      .toBe(`GLIRASTES_CONTROL_PLANE_URL="https://api.glirastes.io"\nGLIRASTES_API_KEY=${credential}\n`);
  });

  it.skipIf(process.platform === 'win32')('keeps the mode of an existing chosen file and creates a new one as 0600', async () => {
    const { root } = await fixture();
    const shared = join(root, 'shared.env');
    await writeFile(shared, 'A=1\nGLIRASTES_API_KEY=gl_old\n');
    await chmod(shared, 0o644);

    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: 'shared.env',
      connection: { ...connection, baseUrl: 'https://api.glirastes.io' },
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect((await stat(shared)).mode & 0o777).toBe(0o644);
    await expect(readFile(shared, 'utf8')).resolves.toBe(`A=1\nGLIRASTES_API_KEY=${credential}\n`);
    expect((await readdir(root)).filter((name) => name.includes('glirastes-'))).toEqual([]);

    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: 'new.env',
      connection: { ...connection, baseUrl: 'https://api.glirastes.io' },
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });
    expect((await stat(join(root, 'new.env'))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('keeps .env.local at 0600 whatever its previous mode', async () => {
    const { root, environmentPath } = await fixture();
    await writeFile(environmentPath, 'A=1\n');
    await chmod(environmentPath, 0o644);

    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection,
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect((await stat(environmentPath)).mode & 0o777).toBe(0o600);
  });

  it('writes only the descriptor when no secret file is targeted', async () => {
    const { root, descriptorPath } = await fixture();

    await expect(materializeConnectionEnvironment({
      projectRoot: root,
      connection,
      apiKey: credential,
    })).resolves.toEqual({ descriptorPath });

    expect(JSON.parse(await readFile(descriptorPath, 'utf8'))).toEqual(connection);
    expect(await readdir(root)).toEqual(['.glirastes']);
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

  it('writes an app connection without environmentId and keeps GLIRASTES_ENVIRONMENT', async () => {
    const { root, environmentPath, descriptorPath } = await fixture();
    await writeFile(environmentPath, 'GLIRASTES_ENVIRONMENT=staging\nKEEP=1\n');
    const { environmentId: _unused, ...appConnection } = connection;

    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection: appConnection,
      apiKey: credential,
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    const env = await readFile(environmentPath, 'utf8');
    expect(env).toContain('GLIRASTES_ENVIRONMENT=staging');
    expect(env).toContain(`GLIRASTES_API_KEY=${credential}`);
    expect(JSON.parse(await readFile(descriptorPath, 'utf8')))
      .not.toHaveProperty('environmentId');
  });

  it('writes only the key for the hosted platform and removes a stale URL', async () => {
    const { root, environmentPath } = await fixture();
    await writeFile(environmentPath, 'GLIRASTES_CONTROL_PLANE_URL=http://localhost:8101\nKEEP=1\n');

    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection: { ...connection, baseUrl: 'https://api.glirastes.io' },
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

describe('secret file safety against a real Git repository', () => {
  async function repository(gitignore: string) {
    const { root } = await fixture();
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await execFileAsync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(join(root, '.gitignore'), gitignore);
    return root;
  }

  async function commit(root: string, ...paths: string[]) {
    await execFileAsync('git', ['add', '-f', '--', ...paths], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  }

  async function caseInsensitive(root: string): Promise<boolean> {
    await writeFile(join(root, 'case-probe'), '');
    return stat(join(root, 'CASE-PROBE')).then(() => true, () => false);
  }

  /** Every path Git would add (untracked, not ignored, or modified) with its content. */
  async function committable(root: string): Promise<Array<{ path: string; content: string }>> {
    const { stdout } = await execFileAsync(
      'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root },
    );
    const paths = stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3));
    return Promise.all(paths.map(async (path) => ({
      path,
      content: await readFile(join(root, path), 'utf8').catch(() => ''),
    })));
  }

  it('refuses an ignored file that Git tracks', async () => {
    const root = await repository('.env\n');
    await writeFile(join(root, '.env'), 'A=1\n');
    await commit(root, '.env');

    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: '.env' }))
      .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED', path: '.env' });
  });

  it('refuses a differently cased alias of a tracked file', async () => {
    const root = await repository('*.env\n');
    if (!await caseInsensitive(root)) return;
    await writeFile(join(root, 'Backend.env'), 'A=1\n');
    await commit(root, 'Backend.env');

    await expect(materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: 'backend.env',
      connection,
      apiKey: credential,
    })).rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED', path: 'Backend.env' });
    await expect(readFile(join(root, 'Backend.env'), 'utf8')).resolves.toBe('A=1\n');
  });

  it('refuses the descriptor or a cased alias of it as the env file', async () => {
    const root = await repository('*.json\n');
    await writeFile(join(root, '.glirastes/platform-connection.json'), '{}');
    for (const environmentPath of ['.glirastes/platform-connection.json', '.GLIRASTES/platform-connection.json']) {
      await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath }))
        .rejects.toMatchObject({ code: 'E-CONNECT-PATH-INVALID' });
    }
  });

  it('follows negation patterns', async () => {
    const root = await repository('*.env\n!public.env\n');
    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'private.env' }))
      .resolves.toMatchObject({ environmentKind: 'custom' });
    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'public.env' }))
      .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED' });
  });

  it('writes outside any Git repository, where nothing can be committed', async () => {
    const { root } = await fixture();
    await materializeConnectionEnvironment({
      projectRoot: root, environmentPath: '.env', connection, apiKey: credential,
    });
    await expect(readFile(join(root, '.env'), 'utf8')).resolves.toContain(credential);
  });

  it('refuses before pairing when Git cannot read an existing repository', async () => {
    const { root } = await fixture();
    await writeFile(join(root, '.git'), 'gitdir: /nonexistent/glirastes-test\n');
    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: '.env' }))
      .rejects.toMatchObject({ code: 'E-CONNECT-GIT-UNAVAILABLE' });
  });

  const noRename = async () => false;

  it('stages beside the file only when Git ignores the staging and backup names', async () => {
    const notIgnored = await repository('.env\n');
    const targets = await preflightConnectionEnvironment({ projectRoot: notIgnored, environmentPath: '.env' });
    await expect(prepareSecretStaging(targets, { canRenameInto: noRename }))
      .rejects.toMatchObject({ code: 'E-CONNECT-STAGING-NOT-IGNORED' });

    const ignored = await repository('.env\n*.glirastes-stage-*\n*.glirastes-backup-*\n');
    const staging = await prepareSecretStaging(
      await preflightConnectionEnvironment({ projectRoot: ignored, environmentPath: '.env' }),
      { canRenameInto: noRename },
    );
    expect(staging.directory).toBeUndefined();
  });

  it('stages a Next.js .env.local in the git dir when the temporary directory is on another filesystem', async () => {
    const root = await repository('.env*.local\n');
    const outside = await mkdtemp(join(tmpdir(), 'glirastes-other-device-'));
    const realOutside = await realpathNative(outside);
    // The temporary directory cannot rename into the project ("EXDEV").
    const canRenameInto = async (from: string) => !from.startsWith(realOutside);
    let stagedIn: string | undefined;

    await materializeConnectionEnvironment({
      projectRoot: root,
      framework: 'nextjs',
      connection,
      apiKey: credential,
      temporaryDirectory: outside,
      canRenameInto,
      atomicWriteHooks: {
        async afterStage() {
          stagedIn = (await readdir(join(root, '.git'))).find((name) => name.startsWith('glirastes-connect-staging-'));
          // A kill here leaves nothing Git would show or add that holds the key.
          for (const entry of await committable(root)) expect(entry.content).not.toContain(credential);
        },
      },
    });

    expect(stagedIn).toBeDefined();
    await expect(readFile(join(root, '.env.local'), 'utf8')).resolves
      .toBe(`GLIRASTES_CONTROL_PLANE_URL=${connection.baseUrl}\nGLIRASTES_API_KEY=${credential}\n`);
    expect((await readdir(join(root, '.git'))).filter((name) => name.startsWith('glirastes-connect-staging-'))).toEqual([]);
    expect((await committable(root)).map(({ path }) => path)).not.toContain('.env.local');
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses before writing when no staging place renames into the target directory', async () => {
    const root = await repository('.env\n');
    await expect(materializeConnectionEnvironment({
      projectRoot: root, environmentPath: '.env', connection, apiKey: credential, canRenameInto: noRename,
    })).rejects.toMatchObject({ code: 'E-CONNECT-STAGING-NOT-IGNORED' });
    expect(await readdir(root)).not.toContain('.env');
  });

  it('never stages in a temporary directory inside the project', async () => {
    const { root } = await fixture();
    const inProject = join(root, 'tmp');
    await mkdir(inProject);
    const seen: string[] = [];

    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: '.env',
      connection,
      apiKey: credential,
      temporaryDirectory: inProject,
      atomicWriteHooks: {
        async afterStage() {
          seen.push(...await readdir(inProject), ...await readdir(root));
        },
      },
    });

    // No repository and the temporary directory is inside: staged beside the file.
    expect(await readdir(inProject)).toEqual([]);
    expect(seen.some((name) => name.startsWith('.env.glirastes-stage-'))).toBe(true);
  });

  it('skips a missing temporary directory', async () => {
    const { root } = await fixture();
    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: '.env',
      connection,
      apiKey: credential,
      temporaryDirectory: join(root, 'missing', 'tmp'),
    });
    await expect(readFile(join(root, '.env'), 'utf8')).resolves.toContain(credential);
  });

  it('asks the nested repository that owns the file', async () => {
    const root = await repository('*.env\n');
    const nested = join(root, 'nested');
    await mkdir(nested);
    await execFileAsync('git', ['init', '--quiet'], { cwd: nested });
    await execFileAsync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: nested });
    await writeFile(join(nested, 'x.env'), 'A=1\n');
    await execFileAsync('git', ['add', 'x.env'], { cwd: nested });
    await execFileAsync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '--quiet', '-m', 'x'], { cwd: nested });

    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'nested/x.env' }))
      .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED' });
  });

  it('checks and stages a file in a submodule against the submodule', async () => {
    const library = await repository('.env\n');
    await commit(library, '.gitignore');
    const root = await repository('');
    await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', library, 'lib'], { cwd: root });
    let stagedInModules = false;

    await materializeConnectionEnvironment({
      projectRoot: root,
      environmentPath: 'lib/.env',
      connection,
      apiKey: credential,
      atomicWriteHooks: {
        async afterStage() {
          const modules = join(root, '.git', 'modules', 'lib');
          stagedInModules = (await readdir(modules)).some((name) => name.startsWith('glirastes-connect-staging-'));
        },
      },
    });

    expect(stagedInModules).toBe(true);
    await expect(readFile(join(root, 'lib/.env'), 'utf8')).resolves.toContain(credential);
  });

  it('refuses a tracked file that is deleted on disk and ignored by name', async () => {
    const root = await repository('');
    await writeFile(join(root, 'Backend.env'), 'A=1\n');
    await commit(root, 'Backend.env');
    await rm(join(root, 'Backend.env'));
    await writeFile(join(root, '.gitignore'), '*.env\n');

    // check-ignore alone says "ignored" for this name; only the tracked check catches it.
    await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'backend.env' }))
      .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED' });
  });

  describe('hardening', () => {
    const created: string[] = [];
    const track = <T extends string>(path: T): T => {
      created.push(path);
      return path;
    };
    afterEach(async () => {
      vi.unstubAllEnvs();
      await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('ignores an exported GIT_DIR that would make the file directory the top level', async () => {
      const root = track(await repository(''));
      await mkdir(join(root, 'sub'));
      await writeFile(join(root, 'sub/.gitignore'), '.env\n');
      await writeFile(join(root, 'sub/.env'), 'A=1\n');
      await commit(root, 'sub/.env', 'sub/.gitignore');

      vi.stubEnv('GIT_DIR', join(root, '.git'));
      await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'sub/.env' }))
        .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED' });
    });

    /** A yadm/vcsh style dotfile repository: bare `dot.git`, work tree `home`, reachable only through GIT_DIR + GIT_WORK_TREE. */
    async function dotfiles() {
      const base = track(await mkdtemp(join(tmpdir(), 'glirastes-dotfiles-')));
      const gitDir = join(base, 'dot.git');
      const home = join(base, 'home');
      const project = join(home, 'proj');
      await mkdir(join(project, '.glirastes'), { recursive: true });
      await execFileAsync('git', ['init', '--quiet', '--bare', gitDir]);
      const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: home };
      await execFileAsync('git', ['config', 'core.excludesFile', '/dev/null'], { env });
      await writeFile(join(project, '.env'), 'A=1\n');
      await writeFile(join(home, '.gitignore'), 'proj/.env.local\n');
      await execFileAsync('git', ['add', '--', 'proj/.env', '.gitignore'], { cwd: home, env });
      return { gitDir, home, project };
    }

    it('refuses a file tracked by a dotfile repository that only GIT_DIR and GIT_WORK_TREE reach', async () => {
      const { gitDir, home, project } = await dotfiles();
      vi.stubEnv('GIT_DIR', gitDir);
      vi.stubEnv('GIT_WORK_TREE', home);

      await expect(preflightConnectionEnvironment({ projectRoot: project, environmentPath: '.env' }))
        .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED', path: '.env' });
      // A differently cased alias is the same file on a case-insensitive filesystem.
      if (await stat(join(project, '.ENV')).then(() => true, () => false)) {
        await expect(preflightConnectionEnvironment({ projectRoot: project, environmentPath: '.ENV' }))
          .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED' });
      }
    });

    it('accepts an untracked ignored file in the same dotfile environment', async () => {
      const { gitDir, home, project } = await dotfiles();
      vi.stubEnv('GIT_DIR', gitDir);
      vi.stubEnv('GIT_WORK_TREE', home);

      await expect(preflightConnectionEnvironment({ projectRoot: project, environmentPath: '.env.local' }))
        .resolves.toMatchObject({ environmentKind: 'custom' });
    });

    it('fails closed with a clear message when GIT_DIR names no repository', async () => {
      const { root } = await fixture();
      track(root);
      vi.stubEnv('GIT_DIR', join(root, 'no-such-repository.git'));

      await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: '.env' }))
        .rejects.toMatchObject({
          code: 'E-CONNECT-GIT-UNAVAILABLE',
          remediation: 'fix-or-unset-git-dir',
          message: expect.stringContaining('GIT_DIR is set, but Git cannot open it'),
        });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'reports a read-only env file directory as missing write permission, not as another filesystem',
      async () => {
        const { root } = await fixture();
        track(root);
        const locked = join(root, 'locked');
        await mkdir(locked);
        const targets = await preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'locked/.env' });
        await chmod(locked, 0o555);
        try {
          const error = await prepareSecretStaging(targets).catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            code: 'E-CONNECT-PATH-NOT-WRITABLE',
            remediation: 'make-env-file-directory-writable',
            path: join('locked', '.env'),
          });
          expect((error as Error).message).toContain('cannot write into locked');
          await expect(materializeConnectionEnvironment({
            projectRoot: root, environmentPath: 'locked/.env', connection, apiKey: credential,
          })).rejects.toMatchObject({ code: 'E-CONNECT-PATH-NOT-WRITABLE' });
        } finally {
          await chmod(locked, 0o755);
        }
        expect(await readdir(locked)).toEqual([]);
      },
    );

    it('refuses a Unicode case alias of a tracked file deleted on disk', async () => {
      const root = track(await repository(''));
      if (!await caseInsensitive(root)) return;
      await writeFile(join(root, 'café.env'), 'A=1\n');
      await commit(root, 'café.env');
      await rm(join(root, 'café.env'));
      await writeFile(join(root, '.gitignore'), '*.env\n');

      await expect(preflightConnectionEnvironment({ projectRoot: root, environmentPath: 'CAFÉ.env' }))
        .rejects.toMatchObject({ code: 'E-CONNECT-SECRET-TRACKED' });
    });

    it('skips a temporary directory in the work tree of the monorepo around the project', async () => {
      const repo = track(await repository('apps/api/.env\n'));
      const project = join(repo, 'apps', 'api');
      await mkdir(project, { recursive: true });
      await mkdir(join(repo, 'tmp'));
      const targets = await preflightConnectionEnvironment({ projectRoot: project, environmentPath: '.env' });
      // The git dir is not usable for staging (e.g. another filesystem).
      const options = { temporaryDirectory: join(repo, 'tmp'), gitDirectoryOf: async () => undefined };

      await expect(prepareSecretStaging(targets, options))
        .rejects.toMatchObject({ code: 'E-CONNECT-STAGING-NOT-IGNORED' });
      expect(await readdir(join(repo, 'tmp'))).toEqual([]);

      // Ignored beside the file only: the temporary directory stays unusable.
      await writeFile(join(repo, '.gitignore'), 'apps/api/.env\napps/api/*.glirastes-stage-*\napps/api/*.glirastes-backup-*\n');
      const beside = await prepareSecretStaging(targets, options);
      expect(beside.directory).toBeUndefined();
      expect(await readdir(join(repo, 'tmp'))).toEqual([]);

      // Ignored everywhere: the staged names are safe in the temporary directory too.
      await writeFile(join(repo, '.gitignore'), 'apps/api/.env\n*.glirastes-stage-*\n*.glirastes-backup-*\n');
      const temporary = await prepareSecretStaging(targets, options);
      expect(temporary.directory?.startsWith(await realpathNative(join(repo, 'tmp')))).toBe(true);
      await temporary.release();
    });

    it('stages in a temporary directory inside an unrelated repository only when Git ignores it there', async () => {
      const other = track(await repository(''));
      const { root } = await fixture();
      track(root);
      const targets = await preflightConnectionEnvironment({ projectRoot: root, environmentPath: '.env' });

      const notIgnored = await prepareSecretStaging(targets, { temporaryDirectory: other });
      expect(notIgnored.directory).toBeUndefined();

      // A rule that matches some other name inside the staging directory does
      // not cover the staged copy and the backup.
      await writeFile(join(other, '.gitignore'), 'secret\n*.glirastes-stage-*\n');
      const partly = await prepareSecretStaging(targets, { temporaryDirectory: other });
      expect(partly.directory).toBeUndefined();

      await writeFile(join(other, '.gitignore'), 'glirastes-connect-staging-*/\n');
      const ignored = await prepareSecretStaging(targets, { temporaryDirectory: other });
      expect(ignored.directory?.startsWith(await realpathNative(other))).toBe(true);
      await ignored.release();
    });

    it('removes only stale staging directories', async () => {
      const { root } = await fixture();
      track(root);
      const temporary = track(await mkdtemp(join(tmpdir(), 'glirastes-stale-')));
      const elsewhere = track(await mkdtemp(join(tmpdir(), 'glirastes-stale-target-')));
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const stale = join(temporary, 'glirastes-connect-staging-stale');
      const fresh = join(temporary, 'glirastes-connect-staging-fresh');
      const file = join(temporary, 'glirastes-connect-staging-file');
      const link = join(temporary, 'glirastes-connect-staging-link');
      await mkdir(stale);
      await mkdir(fresh);
      await writeFile(file, '');
      await symlink(elsewhere, link);
      for (const path of [stale, file, elsewhere]) await utimes(path, old, old);
      await lutimes(link, old, old);

      const staging = await prepareSecretStaging(
        await preflightConnectionEnvironment({ projectRoot: root, environmentPath: '.env' }),
        { temporaryDirectory: temporary },
      );
      await staging.release();

      const left = await readdir(temporary);
      expect(left).not.toContain('glirastes-connect-staging-stale');
      expect(left).toEqual(expect.arrayContaining([
        'glirastes-connect-staging-fresh', 'glirastes-connect-staging-file', 'glirastes-connect-staging-link',
      ]));
      await expect(stat(elsewhere)).resolves.toBeDefined();
    });

    it('refuses to stage beside the file when Git ignores the staging but not the backup name', async () => {
      const root = track(await repository('.env\n*.glirastes-stage-*\n'));
      const targets = await preflightConnectionEnvironment({ projectRoot: root, environmentPath: '.env' });
      await expect(prepareSecretStaging(targets, { canRenameInto: noRename }))
        .rejects.toMatchObject({ code: 'E-CONNECT-STAGING-NOT-IGNORED' });
    });

    it('probes renames for real: into the target directory, not into a missing one', async () => {
      const { root, descriptorPath } = await fixture();
      track(root);
      const temporary = track(await mkdtemp(join(tmpdir(), 'glirastes-probe-')));

      const same = await prepareSecretStaging(
        { projectRoot: root, environmentPath: join(root, '.env'), environmentKind: 'custom', descriptorPath },
        { temporaryDirectory: temporary },
      );
      expect(same.directory?.startsWith(await realpathNative(temporary))).toBe(true);
      await same.release();

      const missing = await prepareSecretStaging(
        { projectRoot: root, environmentPath: join(root, 'missing', '.env'), environmentKind: 'custom', descriptorPath },
        { temporaryDirectory: temporary },
      );
      // No place renames into it; no repository, so beside the file.
      expect(missing.directory).toBeUndefined();
      expect(await readdir(temporary)).toEqual([]);
    });
  });

  it('refuses a connection variable that opens a multi-line quoted value', async () => {
    const { root } = await fixture();
    await writeFile(join(root, '.env'), 'GLIRASTES_API_KEY="gl_old\nsecond line"\n');
    await expect(preflightConnectionEnvironment({
      projectRoot: root, environmentPath: '.env', intendedBaseUrl: 'https://api.glirastes.io',
    })).rejects.toMatchObject({ code: 'E-CONNECT-ENV-UNSUPPORTED' });
  });

  it.each([
    ['a chosen env file', { environmentPath: '.env' }, '.env'],
    ['.env.local', { framework: 'nextjs' as const }, '.env.local'],
  ])('leaves no key or old secret where Git could pick it up at any crash point (%s)', async (_label, target, file) => {
    const root = await repository('.env\n.env*.local\n');
    await writeFile(join(root, file), 'OLD_SECRET=s3cr3t\n');
    const states: Array<Array<{ path: string; content: string }>> = [];
    let stagedModes: number[] = [];
    const record = async () => {
      states.push(await committable(root));
    };
    const recordStage = async () => {
      await record();
      const gitDirectory = join(root, '.git');
      const [privateDirectory] = (await readdir(gitDirectory)).filter((name) => name.startsWith('glirastes-connect-staging-'));
      if (privateDirectory) {
        const directory = join(gitDirectory, privateDirectory);
        stagedModes = await Promise.all((await readdir(directory))
          .filter((name) => name.includes('glirastes-stage'))
          .map(async (name) => (await stat(join(directory, name))).mode & 0o777));
      }
    };

    await materializeConnectionEnvironment({
      projectRoot: root,
      ...target,
      connection,
      apiKey: credential,
      atomicWriteHooks: { afterStage: recordStage, afterReplace: record },
    });

    expect(states).toHaveLength(3);
    for (const state of states) {
      for (const entry of state) {
        // The descriptor holds no secret and stages beside itself; the secret never does.
        expect(entry.path.startsWith(`${file}.glirastes-`)).toBe(false);
        expect(entry.content).not.toContain(credential);
        expect(entry.content).not.toContain('s3cr3t');
      }
    }
    if (process.platform !== 'win32') expect(stagedModes).toEqual([0o600]);
    // The secret file is replaced before the descriptor is written.
    expect(states[1]!.map(({ path }) => path)).not.toContain('.glirastes/platform-connection.json');
    expect((await readdir(join(root, '.git'))).filter((name) => name.startsWith('glirastes-connect-staging-'))).toEqual([]);
  });

  it('refuses a connection variable inside a multi-line quoted value before pairing', async () => {
    const { root } = await fixture();
    await writeFile(join(root, '.env'), 'CERT="-----BEGIN\nGLIRASTES_API_KEY=inside\n-----END"\n');
    await expect(preflightConnectionEnvironment({
      projectRoot: root, environmentPath: '.env', intendedBaseUrl: 'https://api.glirastes.io',
    })).rejects.toMatchObject({ code: 'E-CONNECT-ENV-UNSUPPORTED' });
  });

  it('keeps multi-line quoted values that hold no connection variable', async () => {
    const { root } = await fixture();
    const original = 'CERT="-----BEGIN\nOTHER=1\n-----END"\nA=1\n';
    await writeFile(join(root, '.env'), original);
    await materializeConnectionEnvironment({
      projectRoot: root, environmentPath: '.env', connection: { ...connection, baseUrl: 'https://api.glirastes.io' }, apiKey: credential,
    });
    await expect(readFile(join(root, '.env'), 'utf8')).resolves.toBe(`${original}GLIRASTES_API_KEY=${credential}\n`);
  });
});
