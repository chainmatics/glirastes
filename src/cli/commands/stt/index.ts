import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { resolveSttModelDir, STT_ATTRIBUTION_TEXT } from '../../../server/stt-local/models.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from '../tools/args.js';
import { pullSttModels, type SttPullDependencies } from './pull.js';
import { provideAudioWorklet, withAudioWorkletGitignoreEntry } from './worklet.js';

export type { SttPullDependencies, SttPullResult } from './pull.js';
export { pullSttModels } from './pull.js';
export { AUDIO_WORKLET_COMMAND, AUDIO_WORKLET_FILE, provideAudioWorklet } from './worklet.js';

/** Every `glirastes stt` subcommand with its flags and values; the shipped skills are linted against it. */
export const STT_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  pull: { flags: ['--json'], values: ['--dir', '--mirror'] },
  worklet: { flags: ['--json', '--no-gitignore'], values: ['--out', '--root'] },
};

export const STT_USAGE = [
  'Usage: glirastes stt pull [--dir <path>] [--mirror <url>] [--json]',
  '         download the sha256-pinned local speech models (Parakeet TDT 0.6b v3 int8, Silero VAD) for glirastes/server/stt-local',
  '       glirastes stt worklet [--out <dir>] [--root <path>] [--no-gitignore] [--json]',
  '         copy the audio worklet voice input needs into public/ (or --out), served at /audio-worklet-processor.js;',
  '         lists the copy in an existing .gitignore (never creates one) unless --no-gitignore',
].join('\n');

export async function runSttCommand(
  argv: readonly string[],
  d: SttPullDependencies & {
    /** For tests: the worklet file to copy instead of the packaged one. */
    workletSource?: string;
    log?: (line: string) => void;
    error?: (line: string) => void;
    /** Calls `abort` on Ctrl-C or a stop signal; returns the unsubscribe. Default SIGINT and SIGTERM. */
    interrupts?: (abort: () => void) => () => void;
  } = {},
): Promise<number> {
  const log = d.log ?? ((line: string) => { console.log(line); });
  const error = d.error ?? ((line: string) => { console.error(line); });
  const [subcommand, ...rest] = argv;
  if (subcommand === 'worklet') return runWorklet(rest, d.workletSource, log, error);
  if (subcommand !== 'pull') {
    error(STT_USAGE);
    return 2;
  }
  const json = rest.includes('--json');
  // An interrupt aborts the running download, whose partial file is then removed.
  const controller = new AbortController();
  const unsubscribe = (d.interrupts ?? onStopSignals)(() => { controller.abort(); });
  try {
    const args = parseToolArgs(rest, STT_SUBCOMMANDS.pull!);
    const dirFlag = args.values.get('--dir');
    const dir = dirFlag !== undefined ? resolve(dirFlag) : resolveSttModelDir(d.env ?? process.env);
    const mirror = args.values.get('--mirror');
    const result = await pullSttModels({ dir, signal: controller.signal, ...(mirror !== undefined ? { mirror } : {}) }, d);
    if (json) {
      log(JSON.stringify({ ...result, attribution: STT_ATTRIBUTION_TEXT }));
    } else {
      for (const file of result.files) log(`${file.status} ${file.path} (${file.bytes} bytes)`);
      log(`Model directory: ${result.dir}`);
      log(STT_ATTRIBUTION_TEXT);
    }
    return 0;
  } catch (caught) {
    if (caught instanceof ToolsUsageError) {
      error(`${caught.message}\n${STT_USAGE}`);
      return 2;
    }
    if (isFoundationDiagnosticError(caught)) {
      if (json) log(JSON.stringify(caught.toJSON()));
      else error(`${caught.code}: ${caught.message}\n${caught.remediation}`);
      return controller.signal.aborted ? 130 : 1;
    }
    throw caught;
  } finally {
    unsubscribe();
  }
}

async function runWorklet(
  rest: readonly string[],
  source: string | undefined,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  const json = rest.includes('--json');
  try {
    const args = parseToolArgs(rest, STT_SUBCOMMANDS.worklet!);
    const root = resolve(args.values.get('--root') ?? process.cwd());
    const out = args.values.get('--out');
    const result = await provideAudioWorklet({
      root,
      ...(out !== undefined ? { out } : {}),
      ...(source !== undefined ? { source } : {}),
    });
    const shown = relative(root, result.path).split(sep).join('/');
    const gitignore = args.flags.has('--no-gitignore') ? 'skipped' : await ignoreCopy(root, shown);
    if (json) log(JSON.stringify({ path: shown, status: result.status, gitignore }));
    else {
      log(`${result.status === 'written' ? 'Wrote' : 'Up to date:'} ${shown}`);
      if (gitignore === 'added') log(`Added /${shown} to .gitignore`);
    }
    return 0;
  } catch (caught) {
    if (caught instanceof ToolsUsageError) {
      error(`${caught.message}\n${STT_USAGE}`);
      return 2;
    }
    if (isFoundationDiagnosticError(caught)) {
      if (json) log(JSON.stringify(caught.toJSON()));
      else error(`${caught.code}: ${caught.message}\n${caught.remediation}`);
      return 1;
    }
    throw caught;
  }
}

/**
 * Lists the copy in the root's existing .gitignore, as init does; never
 * creates one. `none`: no .gitignore, or the copy lies outside the root.
 */
async function ignoreCopy(root: string, shown: string): Promise<'added' | 'listed' | 'none'> {
  if (shown.startsWith('../') || isAbsolute(shown)) return 'none';
  const path = join(root, '.gitignore');
  let current: string;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  const next = withAudioWorkletGitignoreEntry(current, shown);
  if (next === undefined) return 'listed';
  await writeFile(path, next);
  return 'added';
}

function onStopSignals(abort: () => void): () => void {
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  return () => {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  };
}
