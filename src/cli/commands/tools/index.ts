import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineOptions,
  type ToolsPipelineResult,
} from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError, type ToolArgsSpec } from './args.js';
import { CHECK_ARGS, runToolsCheck } from './check.js';
import { DESCRIBE_ARGS, runToolsDescribe } from './describe.js';
import { ENRICH_ARGS, runToolsEnrich, type EnrichDependencies } from './enrich.js';
import { EVAL_ARGS, runToolsEval } from './eval.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { POLICY_SUBCOMMANDS, POLICY_USAGE, runToolsPolicy } from './policy.js';
import { REFRESH_ARGS, runToolsRefresh } from './refresh.js';
import { RESOLVE_ARGS, runToolsResolve } from './resolve.js';
import { runToolsStatus, STATUS_ARGS } from './status.js';
import { runToolsVerify, VERIFY_ARGS } from './verify.js';

/**
 * Every `glirastes tools` subcommand with its flags, values and positional
 * arguments; `tools policy` has its own table. The shipped skills are linted
 * against these tables, so a skill can never teach a command that does not exist.
 */
export const TOOLS_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  refresh: REFRESH_ARGS,
  check: CHECK_ARGS,
  status: STATUS_ARGS,
  resolve: RESOLVE_ARGS,
  describe: DESCRIBE_ARGS,
  eval: EVAL_ARGS,
  verify: VERIFY_ARGS,
  enrich: ENRICH_ARGS,
};
export { POLICY_SUBCOMMANDS };

export interface ToolsCommandDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  runPipeline?: (options: ToolsPipelineOptions) => Promise<ToolsPipelineResult>;
  watch?: ToolsIo['watch'];
  signal?: AbortSignal;
  /** `tools enrich --managed`: git, network and the provider loader (tests inject them). */
  enrich?: EnrichDependencies;
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
  '       glirastes tools policy <show|disable|enable|confirm|relax|raise|roles|describe|exclude|include|accept|reset> ...',
  '         change the local tool policy (glirastes tools policy for details)',
  '       glirastes tools verify <tool>...|--all [--root <dir>]',
  '         confirm agent-written contracts and descriptions after review',
  '       glirastes tools enrich --managed [--first-run] [--base <branch>] [--root <dir>] [--json]',
  '         Pro, in CI only: run the managed job that describes the open tools and commits as glirastes-bot',
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
      case 'policy':
        return await runToolsPolicy(rest, io);
      case 'verify':
        return await runToolsVerify(rest, io);
      case 'enrich':
        return await runToolsEnrich(rest, io, deps.enrich);
      default:
        io.error(TOOLS_USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ToolsUsageError) {
      io.error(`${error.message}\n${subcommand === 'policy' ? POLICY_USAGE : TOOLS_USAGE}`);
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
