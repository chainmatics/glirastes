import { resolve } from 'node:path';
import { loadToolsConfig } from '../../../codegen/tools/config.js';
import { requiredLanguages } from '../../../codegen/tools/semantics.js';
import { buildDescribeWorklist } from '../../../codegen/tools/worklist.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';

export const DESCRIBE_ARGS = {
  flags: ['--print', '--all', '--write-contracts', '--json'],
  values: ['--root'],
  positionals: 500,
} as const;

/**
 * Prints the stage-2 work list (descriptions, typed schemas, synonyms,
 * example sentences) for the developer's coding agent. Reads the code like
 * `tools check`: never writes, no model, no network.
 */
export async function runToolsDescribe(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, DESCRIBE_ARGS);
  if (!args.flags.has('--print')) {
    throw new ToolsUsageError('tools describe prints a work list for your coding agent; Glirastes never runs a model. Use --print.');
  }
  if (args.flags.has('--all') && args.positionals.length > 0) {
    throw new ToolsUsageError('Name tools or use --all, not both.');
  }
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  const known = new Set((result.tools ?? []).flatMap((tool) => [tool.definitionId, tool.stableKey]));
  const unknown = args.positionals.filter((name) => !known.has(name));
  if (unknown.length > 0 && (result.tools ?? []).length > 0) {
    throw new ToolsUsageError(`Unknown tool ${unknown.join(', ')}; glirastes tools status lists the names.`);
  }
  const list = buildDescribeWorklist(result, {
    root,
    locale: config.locale,
    languages: requiredLanguages(config.locale),
    tools: args.positionals,
    all: args.flags.has('--all'),
    writeContracts: args.flags.has('--write-contracts') || config.enrich.writeContracts === true,
  });
  io.log(JSON.stringify(list, null, 2));
  return 0;
}
