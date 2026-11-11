import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** A source entry of `.glirastes/tools.json`, with every path relative to the repository root. */
export type WorkspaceSource = string | { kind: string; [key: string]: string };

export interface WorkspaceDetection {
  /** Whether the root package.json declares workspaces at all. */
  declared: boolean;
  /** The workspace patterns as declared, for messages. */
  patterns: string[];
  sources: WorkspaceSource[];
  /** One line per detected app: `nest apps/api/src`. */
  described: string[];
  notes: string[];
}

interface PackageManifest {
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readManifest(path: string): Promise<PackageManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as PackageManifest : undefined;
  } catch {
    return undefined;
  }
}

function declaredPatterns(workspaces: unknown): string[] {
  const list = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === 'object' && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : [];
  return list.filter((entry): entry is string => typeof entry === 'string');
}

/** Only patterns that stay under the root: no negation, no `..`, no absolute path. */
function safeSegments(pattern: string): string[] | undefined {
  if (pattern.startsWith('!') || isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern)) return undefined;
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments;
}

async function expand(root: string, pattern: string): Promise<string[]> {
  const segments = safeSegments(pattern);
  if (!segments) return [];
  let current = [''];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of current) {
      if (segment === '*' || segment === '**') {
        let entries;
        try {
          entries = await readdir(join(root, base), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            next.push(base === '' ? entry.name : `${base}/${entry.name}`);
          }
        }
      } else {
        next.push(base === '' ? segment : `${base}/${segment}`);
      }
    }
    current = next;
  }
  return current;
}

async function insideRoot(root: string, directory: string): Promise<boolean> {
  try {
    if ((await lstat(join(root, directory))).isSymbolicLink()) return false;
    const resolved = relative(await realpath(root), await realpath(join(root, directory)));
    return resolved !== '' && !resolved.startsWith('..') && !isAbsolute(resolved) && !resolved.split(sep).includes('..');
  } catch {
    return false;
  }
}

/** Whether `srcDir` holds a file with an `@Controller` from `@nestjs/common` (bounded walk). */
async function hasNestController(root: string, srcDir: string): Promise<boolean> {
  let visited = 0;
  const walk = async (directory: string): Promise<boolean> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (await walk(path)) return true;
      } else if (/\.(?:ts|js)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        visited += 1;
        if (visited > 400) return false;
        const text = await readFile(join(root, path), 'utf8');
        if (/@Controller\s*\(/.test(text) && text.includes('@nestjs/common')) return true;
      }
    }
    return false;
  };
  try {
    return await walk(srcDir);
  } catch {
    return false;
  }
}

/**
 * Looks into the workspace packages of a repository root for apps the tools
 * generator reads: a NestJS `src` with controllers and a Next.js app. Every
 * path in the result is relative to the root and stays inside it.
 */
export async function detectWorkspaceSources(root: string, rootManifest: PackageManifest): Promise<WorkspaceDetection> {
  const patterns = declaredPatterns(rootManifest.workspaces);
  const result: WorkspaceDetection = { declared: patterns.length > 0, patterns, sources: [], described: [], notes: [] };
  if (!result.declared) return result;

  const directories = new Set<string>();
  for (const pattern of patterns) {
    for (const directory of await expand(root, pattern)) {
      if (await insideRoot(root, directory)) directories.add(directory);
    }
  }
  const nest: WorkspaceSource[] = [];
  const next: WorkspaceSource[] = [];
  let pagesTaken = false;
  for (const directory of [...directories].sort()) {
    const manifest = await readManifest(join(root, directory, 'package.json'));
    const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
    const srcDir = existsSync(join(root, directory, 'src')) ? `${directory}/src` : undefined;
    if (srcDir && ('@nestjs/core' in dependencies || '@nestjs/common' in dependencies || await hasNestController(root, srcDir))
      && !('next' in dependencies)) {
      nest.push({ kind: 'nest', srcDir });
      result.described.push(`nest ${srcDir}`);
      continue;
    }
    if (!('next' in dependencies)) continue;
    const appDir = [`${directory}/src/app`, `${directory}/app`].find((candidate) => existsSync(join(root, candidate)));
    const apiDir = appDir && existsSync(join(root, appDir, 'api')) ? `${appDir}/api` : undefined;
    if (apiDir) {
      next.push({ kind: 'next-app', apiDir });
      result.described.push(`next-app ${apiDir}`);
    }
    if (!appDir) continue;
    if (pagesTaken) {
      result.notes.push(`${directory} is a second Next.js app: only one app can provide pages, URL filters and client actions, so add those for it by hand if needed.`);
      continue;
    }
    pagesTaken = true;
    const sourceRoot = srcDir ?? directory;
    next.push({ kind: 'next-pages', appDir, srcDir: sourceRoot });
    result.described.push(`next-pages ${appDir}`);
    if ('nuqs' in dependencies) {
      next.push({ kind: 'url-filters', appDir, srcDir: sourceRoot });
      result.described.push(`url-filters ${appDir}`);
    }
    next.push({ kind: 'react-actions', srcDir: sourceRoot });
    result.described.push(`react-actions ${sourceRoot}`);
  }
  result.sources = [...nest, ...next];
  return result;
}
