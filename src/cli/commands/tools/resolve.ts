import { resolve } from 'node:path';
import { buildResolveWorklist } from '../../../codegen/tools/worklist.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';

export const RESOLVE_ARGS = { flags: ['--print', '--json'], values: ['--root'] } as const;

/**
 * Prints the stage-1 work list for the developer's coding agent. Reads the
 * code like `tools check` (frozen: never writes, no model, no network).
 */
export async function runToolsResolve(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, RESOLVE_ARGS);
  if (!args.flags.has('--print')) {
    throw new ToolsUsageError('tools resolve prints a work list for your coding agent; Glirastes never runs a model. Use --print.');
  }
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  io.log(JSON.stringify(buildResolveWorklist(result), null, 2));
  return 0;
}
