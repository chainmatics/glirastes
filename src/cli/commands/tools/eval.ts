import { resolve } from 'node:path';
import { loadToolsConfig, TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { DEFAULT_ROUTING_TOP, evaluateRouting, type RoutingEvaluation } from '../../../codegen/tools/routing-eval.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';
import { readToolOutput } from './status.js';

export const EVAL_ARGS = { flags: ['--json', '--strict'], values: ['--root', '--top'] } as const;

export function formatRoutingEvaluation(evaluation: RoutingEvaluation): string {
  const { summary } = evaluation;
  const lines = [
    `Routing check (top ${evaluation.top}): ${summary.passed} of ${summary.sentences} example sentence${summary.sentences === 1 ? '' : 's'} find their tool.`,
  ];
  for (const tool of evaluation.tools) {
    for (const failure of tool.failures) {
      const rank = failure.rank === null ? 'not found' : `rank ${failure.rank}`;
      const above = failure.competitors.length > 0 ? `; ahead: ${failure.competitors.join(', ')}` : '';
      const module = failure.moduleMismatch ? '; the first hit is in another module' : '';
      lines.push(`  ! ${tool.tool}  ${JSON.stringify(failure.sentence)}: ${rank}${above}${module}  (routing-ambiguous)`);
    }
  }
  if (summary.failed > 0) {
    lines.push('  Next: let your coding agent sharpen these descriptions with glirastes tools describe --print.');
  }
  if (summary.withoutExamples.length > 0) {
    lines.push(`Without example sentences (${summary.withoutExamples.length}): ${summary.withoutExamples.join(', ')}`,
      '  Next: glirastes tools describe --print adds them to the work list.');
  }
  return lines.join('\n');
}

/**
 * Deterministic routing check over the committed outputs (spec 4.2, 4.7):
 * no model, no network, no writes. Ambiguous tools are reported; `--strict`
 * (or `ci.strict` in tools.json) turns them into a failing exit code.
 */
export async function runToolsEval(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, EVAL_ARGS);
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const topValue = args.values.get('--top');
  const top = topValue === undefined ? DEFAULT_ROUTING_TOP : Number(topValue);
  if (!Number.isInteger(top) || top < 1 || top > 20) throw new ToolsUsageError('--top must be a whole number from 1 to 20.');
  const strict = args.flags.has('--strict') || loadToolsConfig(root).ci.strict === true;
  const artifact = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema, 'tools.eval');
  const contracts = await readToolOutput(root, TOOLS_PATHS.contracts, ToolContractsFileSchema, 'tools.eval');
  const evaluation = evaluateRouting({ artifact, contracts: contracts.tools, top });
  io.log(args.flags.has('--json') ? JSON.stringify(evaluation) : formatRoutingEvaluation(evaluation));
  return strict && evaluation.summary.failed > 0 ? 1 : 0;
}
