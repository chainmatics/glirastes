import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { compareCodeUnits } from '../canonical.js';
import { programFileName, vueScriptOf } from './vue-sfc.js';

export const MAX_APP_SOURCE_FILES = 20_000;
export const MAX_APP_SOURCE_BYTES = 2_000_000;

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|vue)$/;
/** `a.test.tsx`, `a.spec.ts`, `Button.stories.tsx`: test and story files, not app code. */
const TEST_FILE = /\.(?:test|spec|stories)\.[^.]+$/;
/**
 * Dependencies and test folders never register app handlers, at any depth: a
 * client action or navigation bridge that exists only in a test harness must
 * not enable a tool.
 */
const SKIPPED_ANYWHERE = new Set(['node_modules', '__tests__']);
/**
 * Build output, generated code, coverage, end-to-end suites, story builds and
 * static assets sit directly in the scanned folder, where tools put them. A
 * feature folder with such a name deeper down, e.g. `src/app/(app)/build/` or
 * `src/features/e2e/`, is app code and is scanned.
 */
const SKIPPED_AT_SCAN_ROOT = new Set([
  'dist', 'build', 'out', 'coverage', 'generated', 'e2e', 'storybook-static', 'public',
]);

export interface AppSourceFile {
  /** App-relative POSIX path. */
  path: string;
  /** The name in the TypeScript program: `<file>.vue.ts` for a `.vue` file (see vue-sfc.ts). */
  absolute: string;
  /** For a `.vue` file only its script blocks, at their original offsets. */
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

/** A source file the scan reads: not a declaration file, not a test or story. */
function isScannedSource(name: string): boolean {
  return SOURCE_FILE.test(name) && !name.endsWith('.d.ts') && !TEST_FILE.test(name);
}

/**
 * Whether a link could hide files a walk must enumerate: a folder, or a file
 * the walk would read. A link to anything else (`CLAUDE.md -> AGENTS.md`, an
 * image, a link that points nowhere) holds no source and is ignored.
 */
export async function linkHidesFiles(absolute: string, wantedFile: boolean): Promise<boolean> {
  if (wantedFile) return true;
  try {
    return (await stat(absolute)).isDirectory();
  } catch (error) {
    return !['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

/**
 * Bounded walk over the app's own source files. A linked folder, a linked
 * source file, an oversized file or too many files make the scan incomplete
 * instead of silently skipping code that could register a UI action. Links to
 * anything else are ignored.
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
      if (entry.name.startsWith('.') || SKIPPED_ANYWHERE.has(entry.name)) continue;
      if (directory === start && SKIPPED_AT_SCAN_ROOT.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (await linkHidesFiles(absolute, isScannedSource(entry.name))) {
          return `${appRelative(root, absolute)} is a link; its sources cannot be enumerated.`;
        }
        continue;
      }
      if (entry.isDirectory()) {
        const failure = await walk(absolute);
        if (failure) return failure;
        continue;
      }
      if (!entry.isFile() || !isScannedSource(entry.name)) continue;
      visited += 1;
      if (visited > MAX_APP_SOURCE_FILES) return 'The app has too many source files to enumerate UI actions.';
      if ((await lstat(absolute)).size > MAX_APP_SOURCE_BYTES) {
        return `${appRelative(root, absolute)} is too large to read.`;
      }
      const text = await readFile(absolute, 'utf8');
      const script = entry.name.endsWith('.vue') ? vueScriptOf(text) : { ok: true as const, text };
      if (!script.ok) {
        if (options.matches(text)) return `${appRelative(root, absolute)} ${script.reason}`;
        continue;
      }
      if (options.matches(script.text)) {
        files.push({ path: appRelative(root, absolute), absolute: programFileName(absolute), source: script.text });
      }
    }
    return undefined;
  };
  const failure = await walk(start);
  return failure ? { complete: false, reason: failure } : { complete: true, files };
}
