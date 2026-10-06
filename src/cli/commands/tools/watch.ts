import { watch as watchFiles } from 'node:fs';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';

export interface ToolsWatcher {
  close(): void;
}

/** Reports every changed path below the app root, app-relative. */
export type ToolsWatchFactory = (root: string, onChange: (path: string) => void) => ToolsWatcher;

/** Folders whose changes never change a tool, at any depth. */
const IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.next', '.turbo', '.vercel', '.tool-fixtures',
]);

/**
 * Build output, directly in the app or its `src` folder only: a feature
 * folder of that name deeper down is app code the generator scans (Task 6).
 */
const OUTPUT_FOLDERS: ReadonlySet<string> = new Set(['dist', 'build', 'out', 'coverage']);

/** Inputs under .glirastes that change tools; every other file there belongs to the generator or the CLI. */
const WATCHED_INPUTS: ReadonlySet<string> = new Set([
  TOOLS_PATHS.config, TOOLS_PATHS.policy, TOOLS_PATHS.resolutions, TOOLS_PATHS.semantics, TOOLS_PATHS.promptBundle,
]);

/** Whether a change at this app-relative path can change the tools; generated files never retrigger. */
export function isWatchedPath(path: string, generatedModule: string): boolean {
  const normalized = path.split('\\').join('/').replace(/^\.\//, '');
  if (normalized === '' || normalized === generatedModule) return false;
  const segments = normalized.split('/');
  if (segments[0] === '.glirastes') return WATCHED_INPUTS.has(normalized);
  if (segments.some((segment) => IGNORED_FOLDERS.has(segment))) return false;
  const top = segments[0] === 'src' ? 1 : 0;
  if (segments.length > top + 1 && OUTPUT_FOLDERS.has(segments[top]!)) return false;
  const name = segments.at(-1)!;
  return !name.startsWith('.') && !name.endsWith('~');
}

export const defaultToolsWatch: ToolsWatchFactory = (root, onChange) => {
  const watcher = watchFiles(root, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename.toString());
  });
  return { close: () => { watcher.close(); } };
};

/**
 * `tools refresh --watch` (spec 4.2, 4.8): refresh once, then again after
 * each burst of relevant changes. Runs never overlap; a change during a run
 * schedules exactly one more. Resolves when the signal aborts.
 */
export async function watchToolsRefresh(options: {
  root: string;
  generatedModule: string;
  run: () => Promise<void>;
  signal: AbortSignal;
  watch?: ToolsWatchFactory;
  debounceMs?: number;
}): Promise<void> {
  const debounceMs = options.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let pending = false;
  const runNow = (): void => {
    if (options.signal.aborted) return;
    if (running) {
      pending = true;
      return;
    }
    running = options.run().finally(() => {
      running = undefined;
      if (pending) {
        pending = false;
        schedule();
      }
    });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      runNow();
    }, debounceMs);
  };
  runNow();
  await running;
  if (options.signal.aborted) return;
  const watcher = (options.watch ?? defaultToolsWatch)(options.root, (path) => {
    if (isWatchedPath(path, options.generatedModule)) schedule();
  });
  await new Promise<void>((resolveStop) => {
    options.signal.addEventListener('abort', () => resolveStop(), { once: true });
  });
  watcher.close();
  if (timer) clearTimeout(timer);
  await running;
}
