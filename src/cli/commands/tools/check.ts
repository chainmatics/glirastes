import { resolve } from 'node:path';
import { loadToolsConfig } from '../../../codegen/tools/config.js';
import { parseToolArgs } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

/** Frozen refresh: never writes, never calls a model, never uses the network. */
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--strict', '--integrity-only', '--json'], values: ['--root'] });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const strict = args.flags.has('--strict') || config.ci.strict === true;
  const result = await io.runPipeline({ root, mode: args.flags.has('--integrity-only') ? 'integrity' : 'frozen' });
  const json = args.flags.has('--json');
  io.log(json ? formatToolsJson(result) : formatToolsHuman(result));
  const attention = result.findings.filter((finding) => finding.severity === 'needs_attention');
  if (strict && attention.length > 0) {
    if (!json) io.log(`Strict check: ${attention.length} tool finding(s) need attention.`);
    return 1;
  }
  // ci.requireEnrichment (spec 4.7, default off): template prose or field names fail the check.
  const weak = config.ci.requireEnrichment === true
    ? (result.tools ?? []).filter((tool) => tool.enabled
      && (tool.descriptionOrigin === 'template' || tool.schemaQuality === 'field-names'))
    : [];
  if (weak.length > 0) {
    if (!json) {
      io.log(`Enrichment required: ${weak.length} tool(s) have only a template description or field names `
        + `(${weak.map((tool) => tool.definitionId).join(', ')}). Run glirastes tools describe --print.`);
    }
    return 1;
  }
  return 0;
}
