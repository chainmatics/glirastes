import { resolve } from 'node:path';
import { generatedModulePath, loadToolsConfig } from '../../../codegen/tools/config.js';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { agentWorkNotes, formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { watchToolsRefresh } from './watch.js';
import {
  applySkillsUpdate,
  formatSkillsUpdate,
  planSkillsUpdate,
  skillsAutoUpdateDisabled,
  type SkillsUpdatePlan,
} from '../skills-auto-update.js';
import { computeUpgradeHint, printUpgradeHint, withUpgradeJson } from '../upgrade/hint.js';

export const REFRESH_ARGS = {
  flags: ['--keep-going', '--json', '--watch', '--no-skills'],
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

/**
 * Brings installed agent skills up to this SDK (write mode only). A skills
 * problem never fails the refresh that predev and prebuild depend on.
 */
async function updateInstalledSkills(root: string, io: ToolsIo, json: boolean): Promise<SkillsUpdatePlan | null> {
  try {
    const plan = await planSkillsUpdate({ rootDir: root });
    if (!plan) return null;
    for (const warning of await applySkillsUpdate(root, plan)) io.error(warning);
    if (!json) for (const line of formatSkillsUpdate(plan)) io.log(line);
    return plan;
  } catch (error) {
    io.error(`Installed skills were not updated: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    return null;
  }
}

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, REFRESH_ARGS);
  const modeFlag = args.values.get('--mode');
  if (modeFlag !== undefined && !isToolsMode(modeFlag)) {
    throw new ToolsUsageError('--mode must be write, frozen or integrity.');
  }
  const mode = resolveToolsMode({ ...(modeFlag !== undefined ? { flag: modeFlag } : {}), env: io.env });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const json = args.flags.has('--json');
  const skills = mode === 'write' && !args.flags.has('--no-skills') && !skillsAutoUpdateDisabled(io.env);
  if (args.flags.has('--watch')) {
    if (mode !== 'write') throw new ToolsUsageError('--watch refreshes in write mode only; CI and Docker builds check once.');
    if (json || args.values.has('--adopt')) throw new ToolsUsageError('--watch cannot be combined with --json or --adopt.');
    if (skills) await updateInstalledSkills(root, io, false);
    printUpgradeHint(await computeUpgradeHint(root, io), io);
    return watchRefresh(root, io);
  }
  const skillsPlan = skills ? await updateInstalledSkills(root, io, json) : null;
  const keepGoing = args.flags.has('--keep-going') && mode === 'write';
  const adoptInventoryPath = args.values.get('--adopt');
  const result = await io.runPipeline({
    root,
    mode,
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  // Integrity (Docker builds) depends on nothing but the committed outputs.
  const upgrade = mode === 'integrity'
    ? { line: null }
    : await computeUpgradeHint(root, io, skillsPlan ? { keptSkills: skillsPlan.kept } : {});
  if (json) {
    const raw = skillsPlan ? withSkillsJson(formatToolsJson(result), skillsPlan) : formatToolsJson(result);
    io.log(withUpgradeJson(raw, upgrade));
    return 0;
  }
  const notes = agentWorkNotes(result);
  io.log(notes.length > 0 ? `${formatToolsHuman(result)}\n\n${notes.join('\n')}` : formatToolsHuman(result));
  printUpgradeHint(upgrade, io);
  return 0;
}

function withSkillsJson(raw: string, plan: SkillsUpdatePlan): string {
  return JSON.stringify({
    ...(JSON.parse(raw) as Record<string, unknown>),
    skills: {
      sdkVersion: plan.sdkVersion,
      changes: plan.changes.map(({ host, name, kind }) => ({ host, name, kind })),
      kept: plan.kept,
    },
  });
}
