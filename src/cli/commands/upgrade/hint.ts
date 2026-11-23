import type { ToolsIo } from '../tools/format.js';
import { createUpgradeReport, summarizeUpgradeReport, type UpgradeReportOptions } from './report.js';

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
export async function computeUpgradeHint(
  root: string,
  io: ToolsIo,
  extra: Pick<UpgradeReportOptions, 'keptSkills'> = {},
): Promise<UpgradeHint> {
  if (upgradeHintDisabled(io.env)) return { line: null };
  try {
    const report = await createUpgradeReport({ rootDir: root, ...io.upgrade, ...extra });
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
