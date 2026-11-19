import { resolve } from 'node:path';
import { loadToolsConfig } from '../../../codegen/tools/config.js';
import { parseToolArgs } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { computeUpgradeHint, printUpgradeHint, withUpgradeJson } from './refresh.js';
import { inspectSkillsStaleness, skillsAutoUpdateDisabled, type SkillsStaleness } from '../skills-auto-update.js';

export const CHECK_ARGS = { flags: ['--strict', '--integrity-only', '--json', '--no-skills'], values: ['--root'] } as const;

async function checkSkills(root: string): Promise<SkillsStaleness | null> {
  try {
    return await inspectSkillsStaleness({ rootDir: root });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { stale: false, lines: [], warnings: [`Installed skills could not be checked: ${reason}`] };
  }
}

/** Frozen refresh: never writes, never calls a model, never uses the network. */
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, CHECK_ARGS);
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const config = loadToolsConfig(root);
  const strict = args.flags.has('--strict') || config.ci.strict === true;
  const integrityOnly = args.flags.has('--integrity-only');
  const result = await io.runPipeline({ root, mode: integrityOnly ? 'integrity' : 'frozen' });
  const json = args.flags.has('--json');
  // Stale unedited skills fail like stale tool outputs: refresh would rewrite them. Edited copies only warn.
  // A deploy (--integrity-only) does not depend on agent skills.
  const skills = integrityOnly || args.flags.has('--no-skills') || skillsAutoUpdateDisabled(io.env)
    ? null
    : await checkSkills(root);
  // A deploy (--integrity-only) does not depend on the SDK follow-ups either.
  const upgrade = integrityOnly ? null : await computeUpgradeHint(root, io);
  if (json) {
    const raw = skills
      ? JSON.stringify({ ...(JSON.parse(formatToolsJson(result)) as Record<string, unknown>), skills })
      : formatToolsJson(result);
    io.log(upgrade ? withUpgradeJson(raw, upgrade) : raw);
  } else {
    io.log(formatToolsHuman(result));
    for (const line of [...skills?.lines ?? [], ...skills?.warnings ?? []]) io.log(line);
    if (upgrade) printUpgradeHint(upgrade, io);
  }
  if (skills?.stale) return 1;
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
