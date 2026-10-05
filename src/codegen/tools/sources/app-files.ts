import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { compareCodeUnits } from '../canonical.js';

export const MAX_APP_SOURCE_FILES = 20_000;
export const MAX_APP_SOURCE_BYTES = 2_000_000;

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
/** Dependencies, build output and generated code never register app handlers. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'generated',
]);

export interface AppSourceFile {
  /** App-relative POSIX path. */
  path: string;
  absolute: string;
  source: string;
}

export type AppSourceScan =
  | { complete: true; files: AppSourceFile[] }
  | { complete: false; reason: string };

/** `src` when the app has one, else the app root. */
export function defaultSourceDir(root: string): string {
  return existsSync(join(root, 'src')) ? 'src' : '.';
}

function appRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * Bounded walk over the app's own source files. A link, an oversized file
 * or too many files make the scan incomplete instead of silently skipping
 * code that could register a UI action.
 */
export async function scanAppSources(root: string, options: {
  srcDir?: string;
  matches(source: string): boolean;
}): Promise<AppSourceScan> {
  const files: AppSourceFile[] = [];
  let visited = 0;
  const start = join(root, options.srcDir ?? defaultSourceDir(root));
  if (!existsSync(start)) return { complete: true, files: [] };
  const walk = async (directory: string): Promise<string | undefined> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) return `${appRelative(root, absolute)} is a link; its sources cannot be enumerated.`;
      if (entry.isDirectory()) {
        const failure = await walk(absolute);
        if (failure) return failure;
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      visited += 1;
      if (visited > MAX_APP_SOURCE_FILES) return 'The app has too many source files to enumerate UI actions.';
      if ((await lstat(absolute)).size > MAX_APP_SOURCE_BYTES) {
        return `${appRelative(root, absolute)} is too large to read.`;
      }
      const source = await readFile(absolute, 'utf8');
      if (options.matches(source)) files.push({ path: appRelative(root, absolute), absolute, source });
    }
    return undefined;
  };
  const failure = await walk(start);
  return failure ? { complete: false, reason: failure } : { complete: true, files };
}
