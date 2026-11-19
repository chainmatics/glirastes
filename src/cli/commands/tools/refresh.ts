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
import { updateAgentHint } from '../init-scaffold.js';
import { createUpgradeReport, summarizeUpgradeReport } from '../upgrade/report.js';

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
    await applySkillsUpdate(root, plan);
    if (!json) for (const line of formatSkillsUpdate(plan)) io.log(line);
    return plan;
  } catch (error) {
    io.error(`Installed skills were not updated: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    return null;
  }
}

/** `GLIRASTES_UPGRADE_HINT=0` keeps the upgrade summary out of `tools refresh` and `tools check`. */
export const UPGRADE_HINT_ENV = 'GLIRASTES_UPGRADE_HINT';

export function upgradeHintDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[UPGRADE_HINT_ENV]?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off' || value === 'no';
}

export interface UpgradeHint {
  line: string | null;
  error?: string;
}

/**
 * One line about pending SDK follow-ups, from the app at `root` (never from
 * cwd). Read-only; a report problem is returned, never thrown, so the hint
 * can not fail a refresh or a build.
 */
export async function computeUpgradeHint(root: string, io: ToolsIo): Promise<UpgradeHint> {
  if (upgradeHintDisabled(io.env)) return { line: null };
  try {
    const report = await createUpgradeReport({ rootDir: root, ...io.upgrade });
    return { line: summarizeUpgradeReport(report) };
  } catch (error) {
    return { line: null, error: (error instanceof Error ? error.message : String(error)).split('\n')[0]! };
  }
}

/** Prints the hint (or its error) for humans; `--json` callers embed it instead. */
export function printUpgradeHint(hint: UpgradeHint, io: ToolsIo): void {
  if (hint.error) io.error(`glirastes upgrade: ${hint.error}`);
  else if (hint.line) io.log(hint.line);
}

export function withUpgradeJson(raw: string, hint: UpgradeHint): string {
  return JSON.stringify({
    ...(JSON.parse(raw) as Record<string, unknown>),
    upgrade: { line: hint.line, ...(hint.error ? { error: hint.error } : {}) },
  });
}

/** Rewrites an outdated Glirastes block in AGENTS.md / CLAUDE.md; never fails the refresh. */
async function updateAgentInstructions(root: string, io: ToolsIo, json: boolean): Promise<void> {
  try {
    const changed = await updateAgentHint(root, io.env);
    if (!json && changed.length > 0) io.log(`Updated the Glirastes block in ${changed.join(', ')}.`);
  } catch (error) {
    io.error(`The agent instructions were not updated: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
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
    if (skills) {
      await updateInstalledSkills(root, io, false);
      await updateAgentInstructions(root, io, false);
    }
    printUpgradeHint(await computeUpgradeHint(root, io), io);
    return watchRefresh(root, io);
  }
  const skillsPlan = skills ? await updateInstalledSkills(root, io, json) : null;
  if (skills) await updateAgentInstructions(root, io, json);
  const keepGoing = args.flags.has('--keep-going') && mode === 'write';
  const adoptInventoryPath = args.values.get('--adopt');
  const result = await io.runPipeline({
    root,
    mode,
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  const upgrade = await computeUpgradeHint(root, io);
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
