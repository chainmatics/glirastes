import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agenticContentProblem } from '../codegen/tools/agentic.js';

/**
 * The repository as the managed skill runner sees it (spec 4.6): read inside
 * the checkout only, never through a symlink, never a git-ignored or denied
 * file, with secrets redacted and a byte budget; write only the agentic data
 * files and the new `contract.ts` files the work list names. There is no
 * shell and no network behind any of these operations.
 */

export const READ_FILE_LIMIT_BYTES = 64 * 1024;
export const READ_RUN_LIMIT_BYTES = 400 * 1024;
const LIST_LIMIT = 1000;
const GREP_MATCH_LIMIT = 100;
const GREP_LINE_LIMIT = 200;
const GREP_FILE_LIMIT_BYTES = 1024 * 1024;
const WRITE_JSON_LIMIT_BYTES = 512 * 1024;

export type WorkspaceRefusalCode =
  | 'path_invalid'
  | 'path_denied'
  | 'path_ignored'
  | 'path_symlink'
  | 'path_missing'
  | 'read_budget_exhausted'
  | 'write_not_allowed'
  | 'write_exists'
  | 'write_invalid_json'
  | 'write_too_large'
  | 'write_content_refused';

export class WorkspaceRefusal extends Error {
  constructor(readonly code: WorkspaceRefusalCode) {
    super(code);
    this.name = 'WorkspaceRefusal';
  }
}

/** Directory names the runner never enters, at any depth (compared in lower case). */
const DENIED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.secrets', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.vercel', '.output', 'coverage', '.cache', '.venv', '__pycache__',
]);

/** File names the runner never reads or lists. */
const DENIED_FILES: ReadonlyArray<RegExp> = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(?:\.yml)?$/i,
  /^\.netrc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx|crt|cer|der|keystore|jks)$/i,
];

/** Connection, receipt and state files of Glirastes itself. */
const DENIED_GLIRASTES_FILES = new Set([
  '.glirastes/platform-connection.json',
  '.glirastes/platform-tool-bindings.json',
  '.glirastes/setup-receipt.json',
  '.glirastes/setup-wizard-state.json',
  '.glirastes/installed-skills.json',
]);

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\bgl_[A-Za-z0-9]{32}\b/g, '[redacted key]'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`]+/gi, '[redacted connection string]'],
  [
    /((?:password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["'`])[^"'`\n]{8,}\2/gi,
    '$1$2[redacted]$2',
  ],
];

export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export interface WorkspaceOptions {
  root: string;
  /** Paths (relative, POSIX) among the given ones that git ignores. */
  isIgnored: (paths: ReadonlyArray<string>) => Promise<ReadonlySet<string>>;
  /** Existing files the job may rewrite: the agentic data files. */
  writableFiles: ReadonlyArray<string>;
  /** Files the job may create once, e.g. `contract.ts` next to a handler. */
  creatableFiles: ReadonlyArray<string>;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

function normalize(path: string): string {
  if (path === '' || path === '.') return '';
  if (typeof path !== 'string' || path.length > 500 || path.includes('\0')) {
    throw new WorkspaceRefusal('path_invalid');
  }
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    throw new WorkspaceRefusal('path_invalid');
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new WorkspaceRefusal('path_invalid');
  return segments.join('/');
}

export function deniedPath(path: string): boolean {
  if (path === '') return false;
  // Case-insensitive file systems (macOS, Windows) reach `.git` as `.GIT`.
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const name = segments[segments.length - 1]!;
  return segments.some((segment) => DENIED_DIRECTORIES.has(segment))
    || DENIED_FILES.some((pattern) => pattern.test(name))
    || DENIED_GLIRASTES_FILES.has(lower);
}

export class Workspace {
  private read = 0;
  private readonly created = new Set<string>();
  private readonly changed = new Set<string>();

  constructor(private readonly options: WorkspaceOptions) {}

  get bytesRead(): number {
    return this.read;
  }

  /** Every path this run wrote, relative to the root. */
  get written(): ReadonlySet<string> {
    return this.changed;
  }

  async listFiles(dir = '', recursive = false): Promise<string[]> {
    const start = await this.accessible(dir, true);
    const found: string[] = [];
    const queue = [start];
    while (queue.length > 0 && found.length < LIST_LIMIT) {
      const current = queue.shift()!;
      const entries = await readdir(join(this.options.root, current), { withFileTypes: true });
      const candidates = entries
        .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
        .map((entry) => ({ path: current === '' ? entry.name : `${current}/${entry.name}`, directory: entry.isDirectory() }))
        .filter((entry) => !deniedPath(entry.path))
        .sort((left, right) => left.path.localeCompare(right.path));
      const ignored = await this.options.isIgnored(candidates.map((entry) => entry.path));
      for (const entry of candidates) {
        if (ignored.has(entry.path) || found.length >= LIST_LIMIT) continue;
        found.push(entry.directory ? `${entry.path}/` : entry.path);
        if (entry.directory && recursive) queue.push(entry.path);
      }
    }
    return found;
  }

  async readFile(path: string): Promise<{ path: string; content: string; truncated: boolean; bytes: number }> {
    const relative = await this.accessible(path, false);
    const raw = await readFile(join(this.options.root, relative));
    const slice = raw.subarray(0, READ_FILE_LIMIT_BYTES);
    if (this.read + slice.length > READ_RUN_LIMIT_BYTES) throw new WorkspaceRefusal('read_budget_exhausted');
    this.read += slice.length;
    return { path: relative, content: redactSecrets(slice.toString('utf8')), truncated: raw.length > slice.length, bytes: slice.length };
  }

  async grep(text: string, dir = ''): Promise<GrepMatch[]> {
    if (typeof text !== 'string' || text.length < 2 || text.length > 200) throw new WorkspaceRefusal('path_invalid');
    const files = (await this.listFiles(dir, true)).filter((path) => !path.endsWith('/'));
    const matches: GrepMatch[] = [];
    for (const path of files) {
      if (matches.length >= GREP_MATCH_LIMIT) break;
      const stats = await lstat(join(this.options.root, path));
      if (stats.size > GREP_FILE_LIMIT_BYTES) continue;
      const raw = await readFile(join(this.options.root, path));
      if (raw.includes(0)) continue;
      const lines = raw.toString('utf8').split('\n');
      for (let index = 0; index < lines.length && matches.length < GREP_MATCH_LIMIT; index += 1) {
        if (!lines[index]!.includes(text)) continue;
        const line = redactSecrets(lines[index]!).slice(0, GREP_LINE_LIMIT);
        if (this.read + line.length > READ_RUN_LIMIT_BYTES) throw new WorkspaceRefusal('read_budget_exhausted');
        this.read += line.length;
        matches.push({ path, line: index + 1, text: line });
      }
    }
    return matches;
  }

  async writeFile(path: string, content: string): Promise<{ path: string; bytes: number }> {
    const relative = normalize(path);
    const rewrite = this.options.writableFiles.includes(relative);
    const create = this.options.creatableFiles.includes(relative);
    if (!rewrite && !create) throw new WorkspaceRefusal('write_not_allowed');
    if (typeof content !== 'string') throw new WorkspaceRefusal('write_invalid_json');
    const bytes = Buffer.byteLength(content);
    if (bytes > (relative.endsWith('.json') ? WRITE_JSON_LIMIT_BYTES : READ_FILE_LIMIT_BYTES)) {
      throw new WorkspaceRefusal('write_too_large');
    }
    let value: unknown = content;
    if (relative.endsWith('.json')) {
      try {
        value = JSON.parse(content);
      } catch {
        throw new WorkspaceRefusal('write_invalid_json');
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new WorkspaceRefusal('write_invalid_json');
      }
    }
    if (agenticContentProblem(value)) throw new WorkspaceRefusal('write_content_refused');
    const existing = await this.status(relative);
    if (existing === 'symlink') throw new WorkspaceRefusal('path_symlink');
    if (create && !rewrite && existing === 'file' && !this.created.has(relative)) {
      throw new WorkspaceRefusal('write_exists');
    }
    await this.assertNoSymlinkParents(relative);
    await writeFile(join(this.options.root, relative), content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    if (create && existing === 'missing') this.created.add(relative);
    this.changed.add(relative);
    return { path: relative, bytes };
  }

  private async accessible(path: string, directory: boolean): Promise<string> {
    const relative = normalize(path);
    if (deniedPath(relative)) throw new WorkspaceRefusal('path_denied');
    await this.assertNoSymlinkParents(relative);
    const status = await this.status(relative);
    if (status === 'symlink') throw new WorkspaceRefusal('path_symlink');
    if (status !== (directory ? 'directory' : 'file')) throw new WorkspaceRefusal('path_missing');
    if (relative !== '' && (await this.options.isIgnored([relative])).has(relative)) {
      throw new WorkspaceRefusal('path_ignored');
    }
    return relative;
  }

  private async assertNoSymlinkParents(relative: string): Promise<void> {
    const segments = relative.split('/').slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const status = await this.status(segments.slice(0, index).join('/'));
      if (status === 'symlink') throw new WorkspaceRefusal('path_symlink');
      if (status === 'missing') throw new WorkspaceRefusal('path_missing');
    }
  }

  private async status(relative: string): Promise<'file' | 'directory' | 'symlink' | 'missing'> {
    try {
      const stats = await lstat(join(this.options.root, relative));
      if (stats.isSymbolicLink()) return 'symlink';
      return stats.isDirectory() ? 'directory' : 'file';
    } catch {
      return 'missing';
    }
  }
}
