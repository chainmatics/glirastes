import { execFile } from 'node:child_process';

/**
 * The git side of the managed job (spec 4.6): loop guard, path allowlist and
 * the bot commit. Commands run through an injectable `exec` without a shell;
 * the model never reaches any of them.
 */

export const BOT_NAME = 'glirastes-bot';
export const BOT_EMAIL = 'glirastes-bot@noreply.chainmatics.net';
export const BOT_MARKER = '[glirastes-tools]';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  file: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export const execFileRunner: Exec = (file, args, options) => new Promise((resolve) => {
  execFile(file, [...args], { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export class GitCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GitCommandError';
  }
}

export interface HeadCommit {
  sha: string;
  author: string;
  message: string;
}

export type LoopGuardReason = 'last_commit_by_bot' | 'no_gaps';

/** No run when the last commit is a bot commit or nothing is open (spec 4.6). */
export function loopGuard(head: HeadCommit, openItems: number): LoopGuardReason | undefined {
  if (head.author === BOT_NAME || head.message.includes(BOT_MARKER)) return 'last_commit_by_bot';
  if (openItems === 0) return 'no_gaps';
  return undefined;
}

export interface PathAllowlist {
  /** Exact repository paths. */
  files: ReadonlySet<string>;
  /** Directory prefixes ending in `/`, e.g. the generated module's directory. */
  directories: ReadonlyArray<string>;
}

/** Changed paths outside the allowlist; empty when the change may be committed. */
export function pathViolations(changed: ReadonlyArray<string>, allowed: PathAllowlist): string[] {
  return changed.filter((path) => !allowed.files.has(path)
    && !allowed.directories.some((directory) => path.startsWith(directory)));
}

export class GitRepository {
  constructor(
    private readonly root: string,
    private readonly exec: Exec = execFileRunner,
  ) {}

  async head(): Promise<HeadCommit> {
    const output = await this.git(['log', '-1', '--format=%H%x00%an%x00%B'], 'git_head_unreadable');
    const [sha = '', author = '', message = ''] = output.split('\0');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitCommandError('git_head_unreadable');
    return { sha, author, message: message.trimEnd() };
  }

  /** Every changed, added, deleted or untracked path (both sides of a rename). */
  async changedPaths(): Promise<string[]> {
    const output = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'git_status_unreadable');
    const entries = output.split('\0').filter((entry) => entry !== '');
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      paths.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') {
        index += 1;
        if (entries[index] !== undefined) paths.push(entries[index]!);
      }
    }
    return [...new Set(paths)].sort();
  }

  async ignored(paths: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    if (paths.length === 0) return new Set();
    const result = await this.exec('git', ['-c', 'core.quotePath=false', 'check-ignore', '--', ...paths], { cwd: this.root });
    // 1: none of the paths is ignored.
    if (result.code !== 0 && result.code !== 1) throw new GitCommandError('git_ignore_unreadable');
    return new Set(result.stdout.split('\n').filter((path) => path !== ''));
  }

  async switchToNewBranch(name: string): Promise<void> {
    await this.git(['switch', '-c', name], 'git_branch_failed');
  }

  /** The bot commit of exactly these paths; returns its sha. */
  async commit(paths: ReadonlyArray<string>, message: string): Promise<string> {
    if (!message.includes(BOT_MARKER)) throw new GitCommandError('git_commit_unmarked');
    await this.git(['add', '--all', '--', ...paths], 'git_add_failed');
    await this.git([
      '-c', `user.name=${BOT_NAME}`,
      '-c', `user.email=${BOT_EMAIL}`,
      'commit', '--quiet', '-m', message,
    ], 'git_commit_failed');
    return (await this.head()).sha;
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], 'git_push_failed');
  }

  /** Opens a pull request through the GitHub CLI of the runner; returns its URL. */
  async openPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<string> {
    const result = await this.exec('gh', [
      'pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title, '--body', input.body,
    ], { cwd: this.root });
    if (result.code !== 0) throw new GitCommandError('pull_request_failed');
    return result.stdout.trim();
  }

  private async git(args: ReadonlyArray<string>, code: string): Promise<string> {
    const result = await this.exec('git', args, { cwd: this.root });
    if (result.code !== 0) throw new GitCommandError(code);
    return result.stdout;
  }
}
