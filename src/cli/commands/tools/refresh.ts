import { resolve } from 'node:path';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { agentWorkNotes, formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--keep-going', '--json'], values: ['--root', '--mode', '--adopt'] });
  const modeFlag = args.values.get('--mode');
  if (modeFlag !== undefined && !isToolsMode(modeFlag)) {
    throw new ToolsUsageError('--mode must be write, frozen or integrity.');
  }
  const mode = resolveToolsMode({ ...(modeFlag !== undefined ? { flag: modeFlag } : {}), env: io.env });
  const keepGoing = args.flags.has('--keep-going') && mode === 'write';
  const adoptInventoryPath = args.values.get('--adopt');
  const result = await io.runPipeline({
    root: resolve(io.cwd, args.values.get('--root') ?? '.'),
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
