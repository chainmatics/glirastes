import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { compareCodeUnits } from '../canonical.js';
import { matchesExcludePattern, type PolicyExcludeRule } from '../exclusions.js';
import { toolFinding } from '../findings.js';
import { linkHidesFiles } from './app-files.js';
import type { ExcludedTool, ToolFinding } from '../types.js';

const PAGE_FILE = /^page\.(?:tsx|ts|jsx|js|mdx|md)$/;
const MAX_ENTRIES = 20_000;
const MAX_PAGES = 5_000;

export interface PageEntry {
  /** Route spelling: `/tasks/:taskId`. */
  path: string;
  params: string[];
  /** App-relative POSIX path of the page file. */
  file: string;
  /**
   * The export of `file` that renders the page (`default` for a default
   * export), when `file` is a component module rather than a page file, as
   * for react-router routes. Absent: the whole file is the page.
   */
  component?: string;
}

export type PageTree =
  | { complete: true; pages: PageEntry[]; excluded: ExcludedTool[]; findings: ToolFinding[] }
  | { complete: false; reason: string };

export interface PageTreeOptions {
  appDir?: string;
  /** Folder names left out of the path, e.g. `[locale]`. */
  stripSegments?: ReadonlyArray<string>;
}

/** Stable key of a page in exclusions and policy patterns: `PAGE /tasks`. */
export function pageStableKey(path: string): string {
  return `PAGE ${path}`;
}

/** `src/app` when it exists, else `app`. */
export function defaultAppDir(root: string): string | undefined {
  if (existsSync(join(root, 'src/app'))) return 'src/app';
  return existsSync(join(root, 'app')) ? 'app' : undefined;
}

const DEFAULT_PAGE_RULES: ReadonlyArray<{ reason: string; words: ReadonlySet<string> }> = [
  {
    reason: 'auth-page',
    words: new Set(['auth', 'login', 'logout', 'signin', 'sign-in', 'signout', 'sign-out', 'signup', 'sign-up']),
  },
  { reason: 'callback-page', words: new Set(['callback', 'callbacks', 'oauth', 'sso']) },
  { reason: 'mcp-page', words: new Set(['mcp']) },
];

interface RawPage {
  file: string;
  segments: string[];
}

function toPath(raw: RawPage, strip: ReadonlySet<string>): {
  path: string;
  params: string[];
  reason?: string;
} {
  const params: string[] = [];
  const parts: string[] = [];
  let reason: string | undefined;
  for (const segment of raw.segments) {
    if (/^\(\.{1,3}\)/.test(segment) || /^\(\.\.\)/.test(segment)) {
      reason ??= 'intercepting-page';
      const rest = segment.replace(/^\((?:\.{1,3}|\.\.)\)/, '');
      if (rest) parts.push(rest);
      continue;
    }
    if (/^\(.+\)$/.test(segment) || segment.startsWith('@') || strip.has(segment)) continue;
    const catchAll = /^\[\[?\.\.\.(.+?)\]?\]$/.exec(segment);
    if (catchAll) {
      reason ??= 'catch-all-page';
      parts.push(`*${catchAll[1]}`);
      continue;
    }
    const dynamic = /^\[(.+)\]$/.exec(segment);
    if (dynamic) {
      params.push(dynamic[1]!);
      parts.push(`:${dynamic[1]}`);
      continue;
    }
    parts.push(segment);
  }
  return { path: `/${parts.join('/')}`, params, ...(reason ? { reason } : {}) };
}

function defaultReason(path: string): string | undefined {
  const words = path.split('/').filter((segment) => segment && !segment.startsWith(':') && !segment.startsWith('*'))
    .map((segment) => segment.toLowerCase());
  return DEFAULT_PAGE_RULES.find((rule) => words.some((word) => rule.words.has(word)))?.reason;
}

/**
 * Why an app path is not offered to the chat: a default rule (sign-in,
 * callback, MCP) or a policy exclusion (`PAGE /path`, `* /path`). Pages and
 * `defineQueryFilters` views outside the page tree follow the same rules.
 */
export function pathExclusion(
  path: string,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): { reason: string; origin: 'default' | 'policy' } | undefined {
  const rule = defaultReason(path);
  if (rule) return { reason: rule, origin: 'default' };
  const policy = policyExcludes.find((entry) => matchesExcludePattern(entry.match, { method: 'PAGE', path }));
  return policy ? { reason: policy.reason, origin: 'policy' } : undefined;
}

/**
 * Pages of a Next.js app router tree as navigation destinations. Route
 * groups, parallel-route slots and strip segments leave the path; `_private`
 * folders and the top-level `api` folder are not pages. Every page ends as a
 * destination or as a reasoned exclusion.
 */
export async function enumeratePages(
  root: string,
  options: PageTreeOptions,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): Promise<PageTree> {
  const appDir = options.appDir ?? defaultAppDir(root);
  if (!appDir || !existsSync(join(root, appDir))) return { complete: true, pages: [], excluded: [], findings: [] };
  const appRoot = join(root, appDir);
  const raws: RawPage[] = [];
  let visited = 0;
  const walk = async (directory: string, segments: string[]): Promise<string | undefined> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ENTRIES) return 'The app tree is too large to enumerate pages.';
      const absolute = join(directory, entry.name);
      const local = relative(root, absolute).split(sep).join('/');
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) {
        if (await linkHidesFiles(absolute, PAGE_FILE.test(entry.name))) {
          return `${local} is a link; pages behind it cannot be enumerated.`;
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) continue;
        if (segments.length === 0 && entry.name === 'api') continue;
        const failure = await walk(absolute, [...segments, entry.name]);
        if (failure) return failure;
      } else if (entry.isFile() && PAGE_FILE.test(entry.name)) {
        raws.push({ file: local, segments });
        if (raws.length > MAX_PAGES) return 'The app has too many pages to enumerate.';
      }
    }
    return undefined;
  };
  const failure = await walk(appRoot, []);
  if (failure) return { complete: false, reason: failure };

  const strip = new Set(options.stripSegments ?? []);
  const pages = new Map<string, PageEntry>();
  const excluded = new Map<string, ExcludedTool>();
  const findings: ToolFinding[] = [];
  for (const raw of raws.sort((left, right) => compareCodeUnits(left.file, right.file))) {
    const { path, params, reason } = toPath(raw, strip);
    const stableKey = pageStableKey(path);
    const exclusion = reason ? { reason, origin: 'default' as const } : pathExclusion(path, policyExcludes);
    if (exclusion) {
      excluded.set(stableKey, { stableKey, ...exclusion });
      continue;
    }
    const existing = pages.get(path);
    if (existing) {
      findings.push(toolFinding('page-path-duplicated', 'warning', stableKey,
        `${raw.file} and ${existing.file} both render ${path}; navigation uses ${existing.file}.`));
      continue;
    }
    pages.set(path, { path, params, file: raw.file });
  }
  return {
    complete: true,
    pages: [...pages.values()].sort((left, right) => compareCodeUnits(left.path, right.path)),
    excluded: [...excluded.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
  };
}
