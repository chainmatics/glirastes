import { watch as watchFiles } from 'node:fs';
import { posix } from 'node:path';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';

export interface ToolsWatcher {
  close(): void;
}

/**
 * Reports every changed path below the app root, app-relative, and a fault of
 * the watcher itself (`onError`, e.g. ENOSPC); it may also throw while starting.
 */
export type ToolsWatchFactory = (
  root: string,
  onChange: (path: string) => void,
  onError: (error: Error) => void,
) => ToolsWatcher;

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
  TOOLS_PATHS.mcpToolNames,
]);

/**
 * Names `writeArtifactSetAtomically` gives the staged and backup copy of every
 * output it replaces (`<output>.glirastes-stage-<id>`, `<output>.glirastes-backup-<id>`).
 */
const ATOMIC_WRITE_INFIXES: ReadonlyArray<string> = ['.glirastes-stage-', '.glirastes-backup-'];

const appRelative = (path: string): string => {
  const normalized = posix.normalize(path.split('\\').join('/'));
  return normalized === '.' ? '' : normalized;
};

/** Whether a change at this app-relative path can change the tools; generated files never retrigger. */
export function isWatchedPath(path: string, generatedModule: string): boolean {
  const normalized = appRelative(path);
  if (normalized === '' || normalized === appRelative(generatedModule)) return false;
  const segments = normalized.split('/');
  if (segments[0] === '.glirastes') return WATCHED_INPUTS.has(normalized);
  if (segments.some((segment) => IGNORED_FOLDERS.has(segment))) return false;
  const top = segments[0] === 'src' ? 1 : 0;
  if (segments.length > top + 1 && OUTPUT_FOLDERS.has(segments[top]!)) return false;
  const name = segments.at(-1)!;
  if (ATOMIC_WRITE_INFIXES.some((infix) => name.includes(infix))) return false;
  return !name.startsWith('.') && !name.endsWith('~');
}

export const defaultToolsWatch: ToolsWatchFactory = (root, onChange, onError) => {
  const watcher = watchFiles(root, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename.toString());
  });
  watcher.on('error', onError);
  return { close: () => { watcher.close(); } };
};

/**
 * `tools refresh --watch` (spec 4.2, 4.8): refresh once, then again after
 * each burst of relevant changes. Runs never overlap; a change during a run
 * schedules exactly one more. A run that throws is handed to `onError` and the
 * watch goes on. Resolves when the signal aborts; rejects with E-TOOLS-030 when
 * the watcher cannot start or fails, after it is closed and nothing more runs.
 */
export async function watchToolsRefresh(options: {
  root: string;
  generatedModule: string;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
  signal: AbortSignal;
  watch?: ToolsWatchFactory;
  debounceMs?: number;
}): Promise<void> {
  const debounceMs = options.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let pending = false;
  let stopped = false;
  let watcherFault: Error | undefined;
  let resolveStop: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    resolveStop();
  };
  const execute = async (): Promise<void> => {
    try {
      await options.run();
    } catch (error) {
      options.onError(error);
    }
  };
  const runNow = (): void => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = execute().finally(() => {
      running = undefined;
      if (pending) {
        pending = false;
        schedule();
      }
    });
  };
  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      runNow();
    }, debounceMs);
  };
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    if (options.signal.aborted) stop();
    runNow();
    await running;
    if (stopped) return;
    let watcher: ToolsWatcher | undefined;
    try {
      watcher = (options.watch ?? defaultToolsWatch)(
        options.root,
        (path) => { if (isWatchedPath(path, options.generatedModule)) schedule(); },
        (error) => {
          if (stopped) return;
          watcherFault = error;
          stop();
        },
      );
    } catch (error) {
      watcherFault = error instanceof Error ? error : new Error(String(error));
      stop();
    }
    await stopping;
    watcher?.close();
    await running;
  } finally {
    options.signal.removeEventListener('abort', stop);
  }
  if (watcherFault) {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-030',
      operation: 'tools.refresh.watch',
      message: `Cannot watch the app for changes (${watcherFault.message}). Run glirastes tools refresh without --watch, or raise the system limit for file watchers.`,
      remediation: 'run-tools-refresh-without-watch',
    });
  }
}
