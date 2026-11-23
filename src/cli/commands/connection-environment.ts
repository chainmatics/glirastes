import { execFile } from 'node:child_process';
import { constants, existsSync, realpath as realpathCallback } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  loadToolsConfig,
  normalizeSources,
  TOOLS_PATHS,
  type ToolsConfig,
} from '../../codegen/tools/config.js';
import {
  PlatformConnectionDescriptorSchema,
  type PlatformConnectionDescriptor,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/foundation-diagnostic.js';
import { DEFAULT_CONTROL_PLANE_URL } from '../../runtime/runtime-mode.js';
import {
  type AtomicArtifactWriteHooks,
  writeArtifactSetAtomically,
} from './atomic-artifact-write.js';
import {
  connectionDescriptorPath,
  renderConnectionDescriptor,
  validateConnectionTargetPath,
} from './connection-descriptor.js';

const execFileAsync = promisify(execFile);
// The OS realpath(3): it also returns the on-disk letter case.
const realpathNative = promisify(realpathCallback.native);
// Written by `connect`; the URL only for a self-hosted or local Platform.
const writtenVariableNames = [
  'GLIRASTES_CONTROL_PLANE_URL',
  'GLIRASTES_API_KEY',
  'GLIRASTES_STATE_ENVIRONMENT_ID',
] as const;
// Written by older `connect` runs; the runtime now asks the Platform for them.
export const OBSOLETE_CONNECTION_VARIABLES = [
  'GLIRASTES_APP_ID',
  'GLIRASTES_ENVIRONMENT_ID',
  'GLIRASTES_RUNNER_KEY',
] as const;
const variableNames = [
  ...writtenVariableNames,
  ...OBSOLETE_CONNECTION_VARIABLES,
] as const;

type ConnectionVariable = typeof variableNames[number];

/**
 * Where the connection key is kept:
 * - `nextjs-local`: `.env.local` of a Next.js app (connect owns the
 *   connection variables in it and drops the obsolete ones),
 * - `custom`: a file chosen with `--dotenv` or `connection.envFile` of
 *   `tools.json` (connect touches only the key line, and the URL line for a
 *   self-hosted Platform),
 * - no file: the key lives in the process environment only.
 */
export type ConnectionEnvironmentKind = 'nextjs-local' | 'custom';

export interface ConnectionEnvironmentPreflightOptions {
  projectRoot: string;
  /** Next.js keeps the key in `.env.local` unless a file is chosen. */
  framework?: 'nextjs';
  /** A chosen secret file (absolute or project-relative); wins over the framework default. */
  environmentPath?: string;
  descriptorPath?: string;
  /**
   * The Control Plane `connect` pairs with. When set, the existing secret
   * file is checked before pairing: no duplicate connection variables, and
   * no URL line a custom file would have to keep pointing elsewhere.
   */
  intendedBaseUrl?: string;
  /** Test seam: ignore check only (treated as a repository, nothing tracked). */
  isGitIgnored?: (path: string, projectRoot: string) => Promise<boolean>;
  /** Test seam for the Git checks; `inspectGitPath` by default. */
  inspectGitPath?: (relativePath: string, projectRoot: string) => Promise<GitPathStatus>;
}

export interface SecretStagingOptions {
  /** Fallback staging area; `os.tmpdir()` by default. */
  temporaryDirectory?: string;
  /** Test seam: the git dir of the repository owning a directory. */
  gitDirectoryOf?: (directory: string) => Promise<string | undefined>;
  /** Test seam: whether a file renames from one directory into another (EXDEV probe). */
  canRenameInto?: (fromDirectory: string, toDirectory: string) => Promise<boolean>;
}

export interface ConnectionEnvironmentTargets {
  projectRoot: string;
  /** Absent when the key is kept in the process environment only. */
  environmentPath?: string;
  environmentKind?: ConnectionEnvironmentKind;
  descriptorPath: string;
}

export interface MaterializeConnectionEnvironmentOptions
  extends ConnectionEnvironmentPreflightOptions, SecretStagingOptions {
  connection: PlatformConnectionDescriptor;
  apiKey: string;
  /** Explicitly persist the managed privacy binding, requiring durable bootstrap. */
  privacy?: boolean;
  atomicWriteHooks?: AtomicArtifactWriteHooks;
}

/**
 * The framework of the app as `tools.json` declares it (spec 7): Next.js when a
 * `next-*` source is configured. Only Next.js has a default secret file
 * (`.env.local`); other stacks choose one with `--dotenv` or keep the key in
 * the process environment.
 */
export function connectFrameworkOf(config: ToolsConfig): 'nextjs' | undefined {
  return normalizeSources(config).some((source) => source.kind.startsWith('next-')) ? 'nextjs' : undefined;
}

interface PackageDependencies {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ConnectionSecretSelection {
  framework?: 'nextjs';
  /** Absolute path of a chosen secret file (flag first, then `tools.json`). */
  environmentPath?: string;
}

/**
 * The secret file of `connect`, `sync` and `doctor`: the `--dotenv` flag,
 * else `connection.envFile` of `tools.json`, else `.env.local` for Next.js,
 * else none. Next.js: a `next-*` source in `tools.json` or a `next`
 * dependency in `package.json`.
 */
export function selectConnectionSecret(options: {
  projectRoot: string;
  envFile?: string;
  tools?: ToolsConfig;
  packageJson?: PackageDependencies;
}): ConnectionSecretSelection {
  // Next.js when tools.json has a `next-*` source OR package.json depends on
  // `next`: a Next app may configure only e.g. `openapi` and `react-actions`.
  const framework = (options.tools && connectFrameworkOf(options.tools))
    || options.packageJson?.dependencies?.next !== undefined
    || options.packageJson?.devDependencies?.next !== undefined
    ? 'nextjs'
    : undefined;
  const chosen = options.envFile?.trim() || options.tools?.connection?.envFile;
  return {
    ...(framework ? { framework } : {}),
    ...(chosen ? { environmentPath: resolve(options.projectRoot, chosen) } : {}),
  };
}

/** `selectConnectionSecret` from the files of the project. */
export async function readConnectionSecretSelection(options: {
  projectRoot: string;
  envFile?: string;
}): Promise<ConnectionSecretSelection> {
  const projectRoot = resolve(options.projectRoot);
  const tools = existsSync(resolve(projectRoot, TOOLS_PATHS.config))
    ? loadToolsConfig(projectRoot)
    : undefined;
  let packageJson: PackageDependencies | undefined;
  try {
    const parsed = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')) as unknown;
    packageJson = parsed && typeof parsed === 'object' ? parsed as PackageDependencies : undefined;
  } catch {
    packageJson = undefined;
  }
  return selectConnectionSecret({ projectRoot, envFile: options.envFile, tools, packageJson });
}

/** True for any Control Plane but the hosted default. */
export function isSelfHostedControlPlane(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') !== DEFAULT_CONTROL_PLANE_URL;
}

/** What Git says about one project-relative path. */
export interface GitPathStatus {
  /** False when the project is not inside any Git repository: nothing can be committed. */
  repository: boolean;
  ignored: boolean;
  tracked: boolean;
}

function gitError(code: `E-CONNECT-${string}`, message: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code,
    operation: 'connect',
    message,
    remediation: 'make-git-available',
  });
}

function hasDotGitAbove(path: string): boolean {
  let current = resolve(path);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// Variables that select another repository, work tree, index or config than
// the one Git discovers from `cwd` (`git rev-parse --local-env-vars`, plus
// namespace and the discovery ceiling). An exported `GIT_DIR` would otherwise make
// the file's directory the top level and the checks fail open.
const REPOSITORY_SELECTING_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
] as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REPOSITORY_SELECTING_VARIABLES) delete env[name];
  return env;
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = gitEnvironment(),
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 1024 * 1024 });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string };
    if (typeof failure.code === 'number') return { stdout: failure.stdout ?? '', exitCode: failure.code };
    throw error;
  }
}

/**
 * Asks Git whether a path is ignored and whether it (in any letter case) is
 * tracked. Outside any repository nothing can be committed, so the path is
 * accepted. A `.git` that Git cannot read (git missing, unsafe ownership) is
 * an error: the ignore rules cannot be checked.
 */
export async function inspectGitPath(relativePath: string, projectRoot: string): Promise<GitPathStatus> {
  const target = resolve(projectRoot, relativePath);
  const status = await inspectOwningRepository(target);
  // A repository only the caller's GIT_DIR / GIT_WORK_TREE reach (a yadm or
  // vcsh dotfile repository) can track the file too: either one refuses.
  if (!status.tracked && await trackedByCallerRepository(target)) {
    return { ...status, repository: true, tracked: true };
  }
  return status;
}

/** `inspectGitPath` against the repository Git discovers from the file's directory. */
async function inspectOwningRepository(target: string): Promise<GitPathStatus> {
  // The repository that owns the file answers (a nested repository or a
  // submodule), so Git runs in the file's directory with its bare name.
  const cwd = dirname(target);
  const name = basename(target);
  let inside: { stdout: string; exitCode: number };
  try {
    inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  } catch {
    if (hasDotGitAbove(cwd)) {
      throw gitError(
        'E-CONNECT-GIT-UNAVAILABLE',
        'Git is not available, but the project is inside a Git repository; the ignore rules of the secret file cannot be checked.',
      );
    }
    return { repository: false, ignored: false, tracked: false };
  }
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    if (hasDotGitAbove(cwd)) {
      throw gitError(
        'E-CONNECT-GIT-UNAVAILABLE',
        'Git cannot read the repository of this project; the ignore rules of the secret file cannot be checked.',
      );
    }
    return { repository: false, ignored: false, tracked: false };
  }
  const ignore = await git(['check-ignore', '--quiet', '--', name], cwd);
  if (ignore.exitCode > 1) {
    throw gitError('E-CONNECT-GIT-UNAVAILABLE', 'Git could not check the ignore rules of the secret file.');
  }
  // Case-insensitive: on macOS and Windows `backend.env` and a tracked
  // `Backend.env` are the same file. Also catches a tracked file deleted on disk.
  const tracked = await git(['ls-files', '-z', '--', `:(literal,icase)${name}`], cwd);
  if (tracked.exitCode !== 0) {
    throw gitError('E-CONNECT-GIT-UNAVAILABLE', 'Git could not list the tracked files of the project.');
  }
  return {
    repository: true,
    ignored: ignore.exitCode === 0,
    tracked: tracked.stdout.length > 0 || await tracksUnicodeCaseAlias(name, cwd),
  };
}

/**
 * `icase` folds ASCII only, while the filesystem also folds `café.env` and
 * `CAFÉ.env`: compares the name with the tracked names of its one directory
 * (`pathspec` lists that directory; the file's own one by default).
 */
async function tracksUnicodeCaseAlias(
  name: string,
  cwd: string,
  pathspec = ':(glob)*',
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const listed = await git(['ls-files', '-z', '--', pathspec], cwd, env);
  if (listed.exitCode !== 0) {
    throw gitError('E-CONNECT-GIT-UNAVAILABLE', 'Git could not list the tracked files of the project.');
  }
  const folded = (value: string) => {
    const normalized = value.normalize('NFC');
    return [normalized.toLocaleLowerCase(), normalized.toLocaleUpperCase()];
  };
  const [lower, upper] = folded(name);
  return listed.stdout.split('\0').some((entry) => {
    if (!entry) return false;
    const [entryLower, entryUpper] = folded(basename(entry));
    return entryLower === lower || entryUpper === upper;
  });
}

function callerRepositoryUnusable(message: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-CONNECT-GIT-UNAVAILABLE',
    operation: 'connect',
    message,
    remediation: 'fix-or-unset-git-dir',
  });
}

/**
 * Whether the repository the caller's own environment selects tracks the
 * file. `GIT_DIR` / `GIT_WORK_TREE` reach repositories that discovery never
 * finds (a bare `dot.git` with `$HOME` as work tree); the owning-repository
 * check removes them, so this asks Git once more with the unmodified
 * environment and cwd of the caller, as the caller's own `git add` would.
 * Fails closed: an exported `GIT_DIR` that Git cannot open, or a repository
 * without a work tree here, stops connect with a message naming `GIT_DIR`
 * instead of passing as "not tracked". `GIT_WORK_TREE` alone, with no
 * repository around the cwd, selects nothing.
 */
async function trackedByCallerRepository(target: string): Promise<boolean> {
  if (!process.env.GIT_DIR && !process.env.GIT_WORK_TREE) return false;
  const env = { ...process.env };
  const cwd = process.cwd();
  let gitDirectory: { stdout: string; exitCode: number };
  try {
    gitDirectory = await git(['rev-parse', '--absolute-git-dir'], cwd, env);
  } catch {
    throw callerRepositoryUnusable('Git is not available to check the repository that GIT_DIR or GIT_WORK_TREE select.');
  }
  if (gitDirectory.exitCode !== 0) {
    if (!process.env.GIT_DIR) return false;
    throw callerRepositoryUnusable(
      'GIT_DIR is set, but Git cannot open it as a repository, so connect cannot check whether that repository tracks the secret file. Unset GIT_DIR and GIT_WORK_TREE for this command, or point them at a valid repository.',
    );
  }
  const top = await git(['rev-parse', '--show-toplevel'], cwd, env);
  const topLevel = top.exitCode === 0 ? top.stdout.trim() : '';
  const realTop = topLevel ? await realpathNative(topLevel).catch(() => undefined) : undefined;
  if (!realTop) {
    throw callerRepositoryUnusable(
      'GIT_DIR selects a repository without a work tree here, so connect cannot check whether it tracks the secret file. Set GIT_WORK_TREE as well, or unset GIT_DIR for this command.',
    );
  }
  const realTarget = join(await realpathNative(dirname(target)).catch(() => dirname(target)), basename(target));
  if (!isInside(realTarget, realTop)) return false;
  const path = relative(realTop, realTarget).split(sep).join('/');
  const tracked = await git(['ls-files', '-z', '--', `:(top,literal,icase)${path}`], cwd, env);
  if (tracked.exitCode !== 0) {
    throw callerRepositoryUnusable('Git could not list the tracked files of the repository that GIT_DIR or GIT_WORK_TREE select.');
  }
  if (tracked.stdout.length > 0) return true;
  const directory = posix.dirname(path);
  const escaped = directory.replace(/[*?[\\\]]/g, '\\$&');
  return tracksUnicodeCaseAlias(
    posix.basename(path),
    cwd,
    directory === '.' ? ':(top,glob)*' : `:(top,glob)${escaped}/*`,
    env,
  );
}

/** The git dir of the repository that owns a directory (worktrees and submodules included). */
async function owningGitDirectory(directory: string): Promise<string | undefined> {
  try {
    const result = await git(['rev-parse', '--absolute-git-dir'], directory);
    const gitDirectory = result.stdout.trim();
    return result.exitCode === 0 && gitDirectory ? gitDirectory : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real on-disk name of a path: an existing file through `realpath`, a
 * new one through the real name of its directory. On a case-insensitive
 * filesystem `backend.env` resolves to an existing `Backend.env`.
 */
async function onDiskPath(path: string): Promise<string> {
  // The nearest existing ancestor resolves; missing parts keep their name.
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpathNative(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** The name a staged copy of a secret file would get beside it. */
export function stagingProbeName(relativePath: string): string {
  return `${relativePath}.glirastes-stage-00000000-0000-0000-0000-000000000000`;
}

// A rename into the target directory that fails with one of these is a
// permission problem of that directory, not another filesystem.
const NOT_WRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

class TargetDirectoryNotWritable extends Error {}

/**
 * Renames an empty probe from one directory into the other; false on EXDEV or
 * any other failure, except a target directory without write permission
 * (`TargetDirectoryNotWritable`).
 */
async function defaultCanRenameInto(fromDirectory: string, toDirectory: string): Promise<boolean> {
  const name = `.glirastes-rename-probe-${randomUUID()}`;
  const source = join(fromDirectory, name);
  const target = join(toDirectory, name);
  let renaming = false;
  try {
    await (await open(source, 'wx', 0o600)).close();
    renaming = true;
    await rename(source, target);
    await rm(target, { force: true });
    return true;
  } catch (error) {
    await rm(source, { force: true }).catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    if (renaming && NOT_WRITABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw new TargetDirectoryNotWritable();
    }
    return false;
  }
}

function targetDirectoryNotWritable(targets: ConnectionEnvironmentTargets): FoundationDiagnosticError {
  const relativePath = relative(targets.projectRoot, targets.environmentPath!);
  const directory = relative(targets.projectRoot, dirname(targets.environmentPath!)) || '.';
  return new FoundationDiagnosticError({
    code: 'E-CONNECT-PATH-NOT-WRITABLE',
    operation: 'connect',
    message: `connect cannot write into ${directory}, the directory of the env file (no write permission or a read-only filesystem). Make that directory writable for this user, or choose another env file with --dotenv <path>.`,
    remediation: 'make-env-file-directory-writable',
    path: relativePath,
  });
}

const STAGING_PREFIX = 'glirastes-connect-staging-';
const STALE_STAGING_MS = 60 * 60 * 1000;

/** Best effort: drops staging directories a killed connect left in a place connect owns. */
async function removeStaleStaging(directory: string): Promise<void> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
      const path = join(directory, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > STALE_STAGING_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Not readable: nothing to clean.
  }
}

/**
 * True when a staging directory under `directory` can never be added to a
 * repository: no work tree around it, or Git ignores the staging directory
 * there (a `TMPDIR` inside a monorepo, beside the project).
 */
async function gitIgnoresStagingIn(directory: string, fileName: string): Promise<boolean> {
  let inside: { stdout: string; exitCode: number };
  try {
    inside = await git(['rev-parse', '--is-inside-work-tree'], directory);
  } catch {
    return !hasDotGitAbove(directory);
  }
  if (inside.exitCode !== 0) return !hasDotGitAbove(directory);
  // Inside a git dir (`--is-inside-work-tree` prints false): never added.
  if (inside.stdout.trim() !== 'true') return true;
  // Ask about the names the write really uses: a rule that happens to match
  // some other name must not count for the staged copy or the backup.
  const staged = `${STAGING_PREFIX}000000/${stagingProbeName(fileName)}`;
  const names = [staged, staged.replace('.glirastes-stage-', '.glirastes-backup-')];
  for (const name of names) {
    if ((await git(['check-ignore', '--quiet', '--', name], directory)).exitCode !== 0) return false;
  }
  return true;
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Where the staged copy and the backup of the secret live during the write. */
export interface SecretStaging {
  /** A private 0700 directory connect created (and removes), or undefined: beside the file. */
  directory?: string;
  release(): Promise<void>;
}

/**
 * Picks where the secret is staged, before pairing and again for the write.
 * A staged copy must rename into the target directory (same filesystem,
 * proven by a probe rename, not by `st_dev`) and must never sit where Git
 * could pick it up after a crash:
 * 1. a private directory in the git dir of the repository that owns the file,
 * 2. a private directory under the temporary directory, when that is outside
 *    the project and not in a Git work tree (or Git ignores the staging
 *    directory there),
 * 3. beside the file, when Git ignores the staging name or there is no
 *    repository; otherwise connect refuses.
 */
export async function prepareSecretStaging(
  targets: ConnectionEnvironmentTargets,
  options: SecretStagingOptions & Pick<ConnectionEnvironmentPreflightOptions, 'inspectGitPath' | 'isGitIgnored'> = {},
): Promise<SecretStaging> {
  const environmentPath = targets.environmentPath!;
  const targetDirectory = dirname(environmentPath);
  // Before any staging place is tried: a directory connect cannot write into
  // is not "another filesystem", and the remedy is a different one.
  try {
    await access(targetDirectory, constants.W_OK);
  } catch (error) {
    if (NOT_WRITABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw targetDirectoryNotWritable(targets);
    }
  }
  const canRenameInto = options.canRenameInto ?? defaultCanRenameInto;
  const realRoot = await realpathNative(targets.projectRoot);
  const candidates: string[] = [];
  const gitDirectory = await (options.gitDirectoryOf ?? owningGitDirectory)(targetDirectory);
  if (gitDirectory) candidates.push(gitDirectory);
  try {
    const temporary = await realpathNative(options.temporaryDirectory ?? tmpdir());
    if (!isInside(temporary, realRoot) && await gitIgnoresStagingIn(temporary, basename(environmentPath))) candidates.push(temporary);
  } catch {
    // Missing or unreadable temporary directory: not an option.
  }
  for (const parent of candidates) {
    await removeStaleStaging(parent);
    let directory: string;
    try {
      directory = await mkdtemp(join(parent, STAGING_PREFIX));
    } catch {
      continue;
    }
    let renames: boolean;
    try {
      renames = await canRenameInto(directory, targetDirectory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof TargetDirectoryNotWritable) throw targetDirectoryNotWritable(targets);
      throw error;
    }
    if (renames) {
      return { directory, release: () => rm(directory, { recursive: true, force: true }) };
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  const relativePath = relative(targets.projectRoot, environmentPath);
  const inspect = gitInspector(options);
  const probes = await Promise.all([
    stagingProbeName(relativePath),
    stagingProbeName(relativePath).replace('.glirastes-stage-', '.glirastes-backup-'),
  ].map((name) => inspect(name, targets.projectRoot)));
  if (probes.some((probe) => probe.repository && (!probe.ignored || probe.tracked))) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-STAGING-NOT-IGNORED',
      operation: 'connect',
      message: `No private staging place shares a filesystem with the env file, and Git does not ignore its staging copy ${stagingProbeName(relativePath)}. Ignore "*.glirastes-stage-*" and "*.glirastes-backup-*", or choose an env file on the filesystem of the repository.`,
      remediation: 'ignore-connection-staging-files',
      path: relativePath,
    });
  }
  return { release: async () => undefined };
}

function gitInspector(
  options: Pick<ConnectionEnvironmentPreflightOptions, 'inspectGitPath' | 'isGitIgnored'>,
): (relativePath: string, projectRoot: string) => Promise<GitPathStatus> {
  return options.inspectGitPath ?? (options.isGitIgnored
    ? async (path: string, root: string): Promise<GitPathStatus> => ({
        repository: true,
        ignored: await options.isGitIgnored!(join(root, path), root),
        tracked: false,
      })
    : inspectGitPath);
}

function pathInvalid(message: string, path: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-CONNECT-PATH-INVALID',
    operation: 'connect',
    message,
    remediation: 'choose-project-local-env-file',
    path,
  });
}

export async function preflightConnectionEnvironment(
  options: ConnectionEnvironmentPreflightOptions,
): Promise<ConnectionEnvironmentTargets> {
  const projectRoot = resolve(options.projectRoot);
  const descriptorPath = await validateConnectionTargetPath(
    projectRoot,
    options.descriptorPath ?? connectionDescriptorPath(projectRoot),
  );
  const environmentKind: ConnectionEnvironmentKind | undefined = options.environmentPath !== undefined
    ? 'custom'
    : options.framework === 'nextjs' ? 'nextjs-local' : undefined;
  if (!environmentKind) return { projectRoot, descriptorPath };

  const typedPath = await validateConnectionTargetPath(
    projectRoot,
    resolve(projectRoot, options.environmentPath ?? '.env.local'),
  );
  // Every further check uses the real on-disk names, so a differently cased
  // alias cannot pass the Git checks for a file it is not.
  const realRoot = await realpathNative(projectRoot);
  const realTarget = await validateConnectionTargetPath(realRoot, await onDiskPath(typedPath));
  const relativePath = relative(realRoot, realTarget);
  const environmentPath = join(projectRoot, relativePath);
  const realDescriptor = await onDiskPath(descriptorPath);
  if (
    relativePath === ''
    || realTarget.toLowerCase() === realDescriptor.toLowerCase()
    || realTarget.toLowerCase() === resolve(realRoot, '.glirastes').toLowerCase()
  ) {
    throw pathInvalid('The env file must be a file of its own inside the project.', relativePath);
  }
  const parent = await stat(dirname(environmentPath)).catch(() => undefined);
  if (!parent?.isDirectory()) {
    throw pathInvalid('The directory of the env file does not exist.', relativePath);
  }
  const existing = await stat(environmentPath).catch(() => undefined);
  if (existing && !existing.isFile()) {
    throw pathInvalid('The env file path is not a regular file.', relativePath);
  }

  const inspect = gitInspector(options);
  const status = await inspect(relativePath, projectRoot);
  if (status.repository && (!status.ignored || status.tracked)) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-SECRET-TRACKED',
      operation: 'connect',
      message: environmentKind === 'custom'
        ? status.tracked
          ? `The env file ${relativePath} is tracked by Git; the connection key must never be committed.`
          : `The env file ${relativePath} is not ignored by Git; the connection key must never be committed.`
        : status.tracked
          ? 'The local connection secret target is tracked by Git.'
          : 'The local connection secret target is not ignored by Git.',
      remediation: environmentKind === 'custom'
        ? 'ignore-connection-env-file'
        : 'ignore-env-local',
      path: relativePath,
    });
  }

  if (options.intendedBaseUrl !== undefined) {
    // Fail before pairing: a key the file cannot take is never issued.
    renderEnvironment(await readOptional(environmentPath), {
      kind: environmentKind,
      baseUrl: options.intendedBaseUrl,
      apiKey: 'gl_preflight',
    });
  }
  return { projectRoot, environmentPath, environmentKind, descriptorPath };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

interface EnvironmentLine {
  text: string;
  eol: string;
}

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)\s*=(.*)$/;

function unquoted(raw: string): string {
  const value = raw.trim();
  return (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1).trim()
    : value;
}

/** True when the text holds the closing quote (a double quote may be escaped). */
function closesQuote(text: string, quote: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === quote) return true;
  }
  return false;
}

/**
 * Sets the connection variables in an env file and leaves every other byte
 * alone: other variables, comments, blank lines, each line's own ending and
 * whether the file ends in a newline.
 */
function renderEnvironment(
  existing: string,
  options: { kind: ConnectionEnvironmentKind; baseUrl: string; apiKey: string; stateEnvironmentId?: string },
): string {
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = existing === '' || /\r?\n$/.test(existing);
  const parts = existing === '' ? [] : existing.split(/(\r?\n)/);
  const lines: Array<EnvironmentLine | undefined> = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index]!, eol: parts[index + 1] ?? '' });
  }
  if (hadFinalNewline && lines.at(-1)?.text === '' && lines.at(-1)?.eol === '') lines.pop();

  // `.env.local` is connect's own file: it owns every connection variable in
  // it. In a chosen file connect owns only the key and, for a self-hosted
  // Platform, the URL; obsolete variables stay and `doctor` points at them.
  const owned: ReadonlyArray<ConnectionVariable> = options.kind === 'nextjs-local'
    ? variableNames
    : writtenVariableNames;
  const found = new Map<ConnectionVariable, number>();
  // Lines inside a multi-line quoted value are content, not assignments.
  let openQuote: string | undefined;
  for (const [index, line] of lines.entries()) {
    const text = line?.text ?? '';
    if (openQuote) {
      const inner = text.match(ASSIGNMENT)?.[2] as ConnectionVariable | undefined;
      if (inner && variableNames.includes(inner)) {
        throw new FoundationDiagnosticError({
          code: 'E-CONNECT-ENV-UNSUPPORTED',
          operation: 'connect',
          message: 'The env file has a connection variable inside a multi-line quoted value; connect cannot edit it safely.',
          remediation: 'simplify-connection-env-file',
          identifier: inner,
        });
      }
      if (closesQuote(text, openQuote)) openQuote = undefined;
      continue;
    }
    const match = text.match(ASSIGNMENT);
    const value = match?.[3]?.trim() ?? '';
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined;
    if (quote && !closesQuote(value.slice(1), quote)) openQuote = quote;
    const name = match?.[2] as ConnectionVariable | undefined;
    if (!name || !owned.includes(name)) continue;
    if (openQuote) {
      throw new FoundationDiagnosticError({
        code: 'E-CONNECT-ENV-UNSUPPORTED',
        operation: 'connect',
        message: 'The env file has a multi-line quoted connection variable; connect cannot edit it safely.',
        remediation: 'simplify-connection-env-file',
        identifier: name,
      });
    }
    if (found.has(name)) {
      throw new FoundationDiagnosticError({
        code: 'E-CONNECT-ENV-DUPLICATE',
        operation: 'connect',
        message: 'The local secret file contains a duplicate connection variable.',
        remediation: 'deduplicate-connection-variables',
        identifier: name,
      });
    }
    found.set(name, index);
  }

  const selfHosted = isSelfHostedControlPlane(options.baseUrl);
  const values: Partial<Record<ConnectionVariable, string>> = {
    ...(selfHosted ? { GLIRASTES_CONTROL_PLANE_URL: options.baseUrl } : {}),
    GLIRASTES_API_KEY: options.apiKey,
    ...(options.stateEnvironmentId ? { GLIRASTES_STATE_ENVIRONMENT_ID: options.stateEnvironmentId } : {}),
  };
  const urlIndex = found.get('GLIRASTES_CONTROL_PLANE_URL');
  if (options.kind === 'custom' && !selfHosted && urlIndex !== undefined) {
    // A chosen file keeps its lines; a URL pointing elsewhere would send the
    // new key to another Platform, so the developer decides about that line.
    const current = unquoted(lines[urlIndex]!.text.match(ASSIGNMENT)![3]!);
    if (current.replace(/\/+$/, '') !== DEFAULT_CONTROL_PLANE_URL) {
      throw new FoundationDiagnosticError({
        code: 'E-CONNECT-ENV-PLANE-CONFLICT',
        operation: 'connect',
        message: 'The env file sets GLIRASTES_CONTROL_PLANE_URL to another Control Plane than the one being paired.',
        remediation: 'align-env-file-control-plane',
        identifier: 'GLIRASTES_CONTROL_PLANE_URL',
      });
    }
  }

  for (const name of owned) {
    const value = values[name];
    const index = found.get(name);
    if (value === undefined) {
      // An app-wide re-pairing must not silently erase retained privacy authority.
      if (name === 'GLIRASTES_STATE_ENVIRONMENT_ID') continue;
      // Not needed (any more): drop the line an older connect wrote.
      if (index !== undefined && options.kind === 'nextjs-local') lines[index] = undefined;
      continue;
    }
    if (index === undefined) {
      lines.push({ text: `${name}=${value}`, eol: '' });
      continue;
    }
    const line = lines[index]!;
    const prefix = options.kind === 'custom' ? line.text.match(ASSIGNMENT)![1]! : '';
    lines[index] = { text: `${prefix}${name}=${value}`, eol: line.eol };
  }
  const kept = lines.filter((line): line is EnvironmentLine => line !== undefined);
  return kept.map((line, index) => {
    const last = index === kept.length - 1;
    if (last) return `${line.text}${hadFinalNewline ? line.eol || newline : ''}`;
    return `${line.text}${line.eol || newline}`;
  }).join('');
}

export async function materializeConnectionEnvironment(
  options: MaterializeConnectionEnvironmentOptions,
): Promise<{ descriptorPath: string; environmentPath?: string }> {
  const targets = await preflightConnectionEnvironment({
    ...options,
    intendedBaseUrl: undefined,
  });
  const connection = PlatformConnectionDescriptorSchema.parse(options.connection);
  if (!/^gl_[A-Za-z0-9]{32,128}$/.test(options.apiKey)) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-CREDENTIAL-INVALID',
      operation: 'connect',
      message: 'The one-time connection credential is invalid.',
      remediation: 'restart-browser-pairing',
    });
  }

  if (options.privacy && (!connection.environmentId || !targets.environmentPath)) {
    throw new FoundationDiagnosticError({code: 'E-CONNECT-PRIVACY-BINDING-REQUIRED', operation: 'connect',
      message: 'Managed privacy requires an environment-bound pairing and an ignored dotenv target.', remediation: 'restart-browser-pairing'});
  }
  const descriptor = {
    path: targets.descriptorPath,
    content: renderConnectionDescriptor(connection),
  };
  if (!targets.environmentPath || !targets.environmentKind) {
    // No secret file: the caller hands the key to the developer once.
    await writeArtifactSetAtomically([descriptor], options.atomicWriteHooks);
    return { descriptorPath: targets.descriptorPath };
  }

  const existing = await readOptional(targets.environmentPath);
  // The key is the only variable a connected app needs; app, environment
  // and runner the runtime asks the Platform (`/v1/runtime/connection`).
  const secretBuffer = Buffer.from(renderEnvironment(existing, {
    kind: targets.environmentKind,
    baseUrl: connection.baseUrl,
    apiKey: options.apiKey,
    ...(options.privacy && connection.environmentId ? {stateEnvironmentId: connection.environmentId} : {}),
  }));
  // Staged copy and backup of the secret live in a private 0700 directory
  // (git dir or temporary directory) or, only when Git ignores the name,
  // beside the file. Never where Git could pick them up after a crash.
  let staging: SecretStaging | undefined;
  try {
    staging = await prepareSecretStaging(targets, options);
    // The secret file first: a crash between the two never leaves a
    // descriptor ("connected") without the key that belongs to it.
    await writeArtifactSetAtomically([
      {
        path: targets.environmentPath,
        content: secretBuffer,
        // A chosen file is the developer's (e.g. a shared backend `.env` at
        // 0644): it keeps its mode. A new file, and `.env.local`, are 0600.
        preserveMode: targets.environmentKind === 'custom',
        ...(staging.directory ? { stagingDir: staging.directory, backupDir: staging.directory } : {}),
      },
      descriptor,
    ], options.atomicWriteHooks);
  } finally {
    secretBuffer.fill(0);
    await staging?.release().catch(() => undefined);
  }
  return {
    descriptorPath: targets.descriptorPath,
    environmentPath: targets.environmentPath,
  };
}
