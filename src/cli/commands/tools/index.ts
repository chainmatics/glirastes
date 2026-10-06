import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineOptions,
  type ToolsPipelineResult,
} from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { runToolsDescribe } from './describe.js';
import { runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsResolve } from './resolve.js';
import { runToolsStatus } from './status.js';

export interface ToolsCommandDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  runPipeline?: (options: ToolsPipelineOptions) => Promise<ToolsPipelineResult>;
  watch?: ToolsIo['watch'];
  signal?: AbortSignal;
}

export const TOOLS_USAGE = [
  'Usage: glirastes tools refresh [--root <dir>] [--mode write|frozen|integrity] [--keep-going] [--adopt <inventory>] [--watch] [--json]',
  '         derive tools from the code (writes locally, checks in CI, verifies in Docker; --watch keeps refreshing)',
  '       glirastes tools check [--root <dir>] [--strict] [--integrity-only] [--json]',
  '         verify the committed tool outputs without writing, models or network',
  '       glirastes tools status [--root <dir>] [--json]',
  '         show what your chat can do',
  '       glirastes tools resolve --print [--root <dir>] [--json]',
  '         print the open stage-1 findings as a work list for your coding agent',
  '       glirastes tools describe --print [<tool>...|--all] [--write-contracts] [--root <dir>]',
  '         print descriptions, schemas, synonyms and examples to write as a work list for your coding agent',
  '       glirastes tools eval [--root <dir>] [--top <n>] [--strict] [--json]',
  '         check that every example sentence finds its tool (no model, CI-ready)',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
export async function runToolsCommand(argv: string[], deps: ToolsCommandDependencies = {}): Promise<number> {
  const io: ToolsIo = {
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    log: deps.log ?? ((line) => { console.log(line); }),
    error: deps.error ?? ((line) => { console.error(line); }),
    runPipeline: deps.runPipeline ?? runToolsPipeline,
    ...(deps.watch ? { watch: deps.watch } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  const [subcommand, ...rest] = argv;
  const json = rest.includes('--json');
  try {
    switch (subcommand) {
      case 'refresh':
        return await runToolsRefresh(rest, io);
      case 'check':
        return await runToolsCheck(rest, io);
      case 'status':
        return await runToolsStatus(rest, io);
      case 'resolve':
        return await runToolsResolve(rest, io);
      case 'describe':
        return await runToolsDescribe(rest, io);
      case 'eval':
        return await runToolsEval(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ToolsUsageError) {
      io.error(`${error.message}\n${TOOLS_USAGE}`);
      return 2;
    }
    if (error instanceof ToolsPipelineFailure) {
      io.log(json ? formatToolsJson(error.result) : formatToolsHuman(error.result));
      return 1;
    }
    if (isFoundationDiagnosticError(error)) {
      if (json) io.log(JSON.stringify(error.toJSON()));
      else io.error(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
