import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_MARKER,
  BOT_NAME,
  execFileRunner,
  GitCommandError,
  GitRepository,
  loopGuard,
  pathViolations,
  type Exec,
} from '../git.js';

let base: string;
let root: string;

/** Real git, isolated from the machine's global and system configuration. */
const isolated: Exec = (file, args, options) => execFileRunner(file, args, {
  ...options,
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
});

async function git(...args: string[]): Promise<string> {
  const result = await isolated('git', args, { cwd: root });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'glirastes-git-'));
  root = join(base, 'app');
  await mkdir(root);
  await isolated('git', ['init', '--quiet', '--bare', join(base, 'origin.git')], { cwd: base });
  await git('init', '--quiet', '--initial-branch=feature/tasks');
  await git('config', 'user.name', 'Developer');
  await git('config', 'user.email', 'developer@example.com');
  await git('remote', 'add', 'origin', join(base, 'origin.git'));
  await put('.gitignore', 'generated.log\n');
  await put('.glirastes/tool-semantics.json', '{}\n');
  await put('src/route.ts', 'export {}\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'feat: tasks route');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('managed job git guard', () => {
  it('skips a run after a bot commit or without open gaps', () => {
    const developer = { sha: 'a'.repeat(40), author: 'Developer', message: 'feat: tasks route\n' };

    expect(loopGuard(developer, 3)).toBeUndefined();
    expect(loopGuard(developer, 0)).toBe('no_gaps');
    expect(loopGuard({ ...developer, author: BOT_NAME }, 3)).toBe('last_commit_by_bot');
    expect(loopGuard({ ...developer, message: `Merge pull request #7\n\nchore(glirastes): describe tools ${BOT_MARKER}` }, 3))
      .toBe('last_commit_by_bot');
  });

  it('names every changed path outside the allowlist', () => {
    const allowed = {
      files: new Set(['.glirastes/tool-semantics.json', 'src/app/api/tasks/contract.ts']),
      directories: ['src/generated/glirastes/'],
    };

    expect(pathViolations([
      '.glirastes/tool-semantics.json',
      'src/generated/glirastes/tools.generated.ts',
      'src/app/api/tasks/contract.ts',
      '.glirastes/tool-policy.json',
      'src/app/api/tasks/route.ts',
      '.github/workflows/glirastes-tools.yml',
    ], allowed)).toEqual([
      '.glirastes/tool-policy.json',
      'src/app/api/tasks/route.ts',
      '.github/workflows/glirastes-tools.yml',
    ]);
  });

  it('reads changes and ignores from git and commits exactly the given paths as the bot', async () => {
    const repository = new GitRepository(root, isolated);
    await put('.glirastes/tool-semantics.json', '{"tools":{}}\n');
    await put('src/app/api/tasks/contract.ts', 'export const input = {};\n');
    await put('src/route.ts', 'export const changed = true;\n');
    await put('generated.log', 'log\n');

    expect(await repository.changedPaths())
      .toEqual(['.glirastes/tool-semantics.json', 'src/app/api/tasks/contract.ts', 'src/route.ts']);
    expect([...await repository.ignored(['generated.log', 'src/route.ts'])]).toEqual(['generated.log']);

    const sha = await repository.commit(
      ['.glirastes/tool-semantics.json', 'src/app/api/tasks/contract.ts'],
      `chore(glirastes): describe tools ${BOT_MARKER}`,
    );
    await repository.push('feature/tasks');

    expect(await repository.head()).toEqual({ sha, author: BOT_NAME, message: `chore(glirastes): describe tools ${BOT_MARKER}` });
    expect(await repository.changedPaths()).toEqual(['src/route.ts']);
    expect(await isolated('git', ['--git-dir', join(base, 'origin.git'), 'rev-parse', 'refs/heads/feature/tasks'], { cwd: base }))
      .toMatchObject({ stdout: `${sha}\n` });
    await expect(repository.commit(['src/route.ts'], 'chore: unmarked')).rejects.toEqual(new GitCommandError('git_commit_unmarked'));
  });

  it('opens the pull request through the GitHub CLI and names a failure by code', async () => {
    const exec = vi.fn<Exec>(async () => ({ code: 0, stdout: 'https://github.com/acme/app/pull/12\n', stderr: '' }));
    const repository = new GitRepository(root, exec);

    await expect(repository.openPullRequest({ base: 'main', head: 'glirastes/tools-abc', title: 't', body: 'b' }))
      .resolves.toBe('https://github.com/acme/app/pull/12');
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['gh', [
      'pr', 'create', '--base', 'main', '--head', 'glirastes/tools-abc', '--title', 't', '--body', 'b',
    ]]);
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'gh: not logged in' });
    await expect(repository.openPullRequest({ base: 'main', head: 'x', title: 't', body: 'b' }))
      .rejects.toEqual(new GitCommandError('pull_request_failed'));
  });
});
