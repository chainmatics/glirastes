import { resolve } from 'node:path';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { resolveSttModelDir, STT_ATTRIBUTION_TEXT } from '../../../server/stt-local/models.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from '../tools/args.js';
import { pullSttModels, type SttPullDependencies } from './pull.js';

export type { SttPullDependencies, SttPullResult } from './pull.js';
export { pullSttModels } from './pull.js';

/** Every `glirastes stt` subcommand with its flags and values; the shipped skills are linted against it. */
export const STT_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  pull: { flags: ['--json'], values: ['--dir', '--mirror'] },
};

export const STT_USAGE = [
  'Usage: glirastes stt pull [--dir <path>] [--mirror <url>] [--json]',
  '         download the sha256-pinned local speech models (Parakeet TDT 0.6b v3 int8, Silero VAD) for glirastes/server/stt-local',
].join('\n');

export async function runSttCommand(
  argv: readonly string[],
  d: SttPullDependencies & { log?: (line: string) => void; error?: (line: string) => void } = {},
): Promise<number> {
  const log = d.log ?? ((line: string) => { console.log(line); });
  const error = d.error ?? ((line: string) => { console.error(line); });
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'pull') {
    error(STT_USAGE);
    return 2;
  }
  const json = rest.includes('--json');
  try {
    const args = parseToolArgs(rest, STT_SUBCOMMANDS.pull!);
    const dirFlag = args.values.get('--dir');
    const dir = dirFlag !== undefined ? resolve(dirFlag) : resolveSttModelDir(d.env ?? process.env);
    const mirror = args.values.get('--mirror');
    const result = await pullSttModels({ dir, ...(mirror !== undefined ? { mirror } : {}) }, d);
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
      return 1;
    }
    throw caught;
  }
}
