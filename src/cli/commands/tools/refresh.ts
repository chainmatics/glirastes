import { resolve } from 'node:path';
import { generatedModulePath, loadToolsConfig } from '../../../codegen/tools/config.js';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { agentWorkNotes, formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { watchToolsRefresh } from './watch.js';

export const REFRESH_ARGS = {
  flags: ['--keep-going', '--json', '--watch'],
  values: ['--root', '--mode', '--adopt'],
} as const;

/** Until Ctrl+C: one refresh per burst of changes; a failing refresh, expected or not, is printed and the watch goes on. */
async function watchRefresh(root: string, io: ToolsIo): Promise<number> {
  const config = loadToolsConfig(root);
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  const signal = io.signal ?? controller.signal;
  if (!io.signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  io.log('Watching the app for tool changes. Stop with Ctrl+C.');
  try {
    await watchToolsRefresh({
      root,
      generatedModule: generatedModulePath(config),
      signal,
      ...(io.watch ? { watch: io.watch } : {}),
      onError: (error) => {
        io.error(`The refresh failed unexpectedly, watching goes on: ${error instanceof Error ? error.message : String(error)}`);
      },
      run: async () => {
        try {
          const result = await io.runPipeline({ root, mode: 'write', keepGoing: true });
          const notes = agentWorkNotes(result);
          io.log(notes.length > 0 ? `${formatToolsHuman(result)}\n\n${notes.join('\n')}` : formatToolsHuman(result));
        } catch (error) {
          if (error instanceof ToolsPipelineFailure) io.log(formatToolsHuman(error.result));
          else if (isFoundationDiagnosticError(error)) io.error(`${error.code}: ${error.message}`);
          else throw error;
        }
      },
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return 0;
}

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, REFRESH_ARGS);
  const modeFlag = args.values.get('--mode');
  if (modeFlag !== undefined && !isToolsMode(modeFlag)) {
    throw new ToolsUsageError('--mode must be write, frozen or integrity.');
  }
  const mode = resolveToolsMode({ ...(modeFlag !== undefined ? { flag: modeFlag } : {}), env: io.env });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  if (args.flags.has('--watch')) {
    if (mode !== 'write') throw new ToolsUsageError('--watch refreshes in write mode only; CI and Docker builds check once.');
    if (args.flags.has('--json') || args.values.has('--adopt')) throw new ToolsUsageError('--watch cannot be combined with --json or --adopt.');
    return watchRefresh(root, io);
  }
  const keepGoing = args.flags.has('--keep-going') && mode === 'write';
  const adoptInventoryPath = args.values.get('--adopt');
  const result = await io.runPipeline({
    root,
    mode,
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  if (args.flags.has('--json')) {
    io.log(formatToolsJson(result));
    return 0;
  }
  const notes = agentWorkNotes(result);
  io.log(notes.length > 0 ? `${formatToolsHuman(result)}\n\n${notes.join('\n')}` : formatToolsHuman(result));
  return 0;
}
