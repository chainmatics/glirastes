import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SDK_VERSION } from '../../../runtime/sdk-version.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from '../tools/args.js';
import { readInstalledSkillsManifest } from '../installed-skills-manifest.js';
import { planSkillsUpdate, type KeptSkill } from '../skills-auto-update.js';
import { BASELINE_PATH, readBaseline, withDeferred, writeBaseline, type SdkBaseline } from './baseline.js';
import { evaluateNote, scanApp, type AppScan } from './detect.js';
import {
  compareVersions,
  findPackageUpgradeNotesDir,
  isSemver,
  loadUpgradeNoteSet,
  type UpgradeNoteKind,
} from './notes.js';

export interface ReportItem {
  id: string;
  version: string;
  kind: UpgradeNoteKind;
  summary: string;
  howTo: string;
  skill: string;
  status: 'adopted' | 'affected' | 'not-affected' | 'unclear';
  evidence: Array<{ file: string; line: number }>;
  /** Deferred at the last `glirastes upgrade ack --defer`; stays listed until an ack no longer names it. */
  deferred?: true;
}

export interface UpgradeReport {
  from: string;
  to: string;
  must: ReportItem[];
  should: ReportItem[];
  recommended: ReportItem[];
  offer: ReportItem[];
  /** Breaking notes whose affectedWhen found no evidence. Informational, never blocks ack. */
  checkedNotAffected: ReportItem[];
  keptSkills: KeptSkill[];
  unclassified: Array<{ version: string; changelogHeading: string }>;
  upToDate: boolean;
  /** No `.glirastes/sdk-baseline.json` yet; `from` was derived. */
  baselineMissing: boolean;
  /** The baseline is ahead of the installed SDK (a downgrade). */
  baselineAhead: boolean;
}

export interface UpgradeReportOptions {
  rootDir: string;
  sdkVersion?: string;
  notesDir?: string;
  changelogPath?: string;
  /** Overrides `reviewedThrough` for this run only. */
  from?: string;
  /** Where shipped skills come from (tests). */
  skillsDir?: string;
  /** Edited skills already planned by the caller (`tools refresh`); spares a second hash pass. */
  keptSkills?: ReadonlyArray<KeptSkill>;
  /** Replaces the app scan (tests). */
  scan?: (root: string) => Promise<AppScan>;
}

const HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/;

async function changelogHeadings(path: string): Promise<Array<{ version: string; heading: string }>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const result: Array<{ version: string; heading: string }> = [];
  for (const line of text.split('\n')) {
    const match = HEADING.exec(line);
    if (match && isSemver(match[1]!)) result.push({ version: match[1]!, heading: line.trimEnd() });
  }
  return result;
}

async function installedSkillsVersion(rootDir: string): Promise<string | undefined> {
  try {
    return (await readInstalledSkillsManifest(rootDir))?.sdkVersion;
  } catch {
    return undefined;
  }
}

async function keptEditedSkills(options: UpgradeReportOptions, sdkVersion: string): Promise<KeptSkill[]> {
  const plan = await planSkillsUpdate({
    rootDir: options.rootDir,
    sdkVersion,
    ...(options.skillsDir ? { skillsDir: options.skillsDir } : {}),
  });
  return (plan?.kept ?? []).filter((kept) => kept.reason === 'behind');
}

export async function createUpgradeReport(options: UpgradeReportOptions): Promise<UpgradeReport> {
  const to = options.sdkVersion ?? SDK_VERSION;
  const baseline = await readBaseline(options.rootDir);
  const baselineMissing = baseline === undefined;
  const from =
    options.from ?? baseline?.reviewedThrough ?? (await installedSkillsVersion(options.rootDir)) ?? to;
  const baselineAhead = compareVersions(from, to) > 0;

  const empty: UpgradeReport = {
    from,
    to,
    must: [],
    should: [],
    recommended: [],
    offer: [],
    checkedNotAffected: [],
    keptSkills: [],
    unclassified: [],
    upToDate: true,
    baselineMissing,
    baselineAhead,
  };
  if (baselineAhead) return empty;

  const notesDir = options.notesDir ?? findPackageUpgradeNotesDir();
  const changelogPath = options.changelogPath ?? join(dirname(notesDir), 'CHANGELOG.md');
  const deferred = baseline?.decisions ?? {};
  const { notes: allNotes, releasedVersions } = await loadUpgradeNoteSet(notesDir, to);
  const inRange = (version: string) => compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
  // A deferred note stays visible after ack moved reviewedThrough past it.
  const notes = allNotes.filter(
    (note) =>
      inRange(note.version) ||
      (deferred[note.id] !== undefined && compareVersions(note.version, to) <= 0),
  );
  // Reading the whole app tree is only worth it when a note could match.
  const scan = notes.length > 0 ? await (options.scan ?? scanApp)(options.rootDir) : undefined;

  const report: UpgradeReport = { ...empty, checkedNotAffected: [] };
  for (const note of notes) {
    const { status, evidence } = evaluateNote(note, scan!);
    const item: ReportItem = {
      id: note.id,
      version: note.version,
      kind: note.kind,
      summary: note.summary,
      howTo: note.howTo,
      skill: note.skill,
      status,
      evidence,
      ...(deferred[note.id] ? { deferred: true as const } : {}),
    };
    const relevant = status === 'affected' || status === 'unclear';
    if (note.kind === 'breaking' && relevant) report.must.push(item);
    else if (note.kind === 'deprecated' && relevant) report.should.push(item);
    else if (note.kind === 'recommended' && relevant) report.recommended.push(item);
    else if (note.kind === 'optional' && status !== 'adopted') report.offer.push(item);
    else if (note.kind === 'breaking' && status === 'not-affected') report.checkedNotAffected.push(item);
  }

  const classified = new Set([...releasedVersions, ...allNotes.map((note) => note.version)]);
  report.unclassified = (await changelogHeadings(changelogPath))
    .filter(
      ({ version }) =>
        compareVersions(version, from) > 0 && compareVersions(version, to) <= 0 && !classified.has(version),
    )
    .map(({ version, heading }) => ({ version, changelogHeading: heading }));

  report.keptSkills = options.keptSkills
    ? options.keptSkills.filter((kept) => kept.reason === 'behind')
    : await keptEditedSkills(options, to);
  report.upToDate =
    report.must.length + report.should.length + report.recommended.length + report.offer.length === 0 &&
    report.keptSkills.length === 0 &&
    report.unclassified.length === 0;
  return report;
}

/** Must items not deferred: what `--fail-on breaking` and doctor treat as open. */
export function openMustItems(report: UpgradeReport): ReportItem[] {
  return report.must.filter((item) => !item.deferred);
}

function line(item: ReportItem): string {
  const evidence = item.evidence.length > 0 ? ` (${item.evidence.map((e) => `${e.file}:${e.line}`).join(', ')})` : '';
  const deferred = item.deferred ? ' [deferred]' : '';
  return `- [${item.id}] ${item.summary}${evidence}${deferred} → ${item.skill}`;
}

export function formatUpgradeReport(report: UpgradeReport, options: { brief?: boolean }): string {
  const lines: string[] = [];
  if (report.baselineAhead) {
    lines.push(`Glirastes ${report.to}: baseline is ahead of the installed version (reviewed through ${report.from}). Nothing pending.`);
    return lines.join('\n');
  }
  lines.push(`Glirastes upgrade review: ${report.from} → ${report.to}`);
  if (report.baselineMissing) lines.push(`no baseline, reviewed as ${report.from}`);
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push('', `${title}:`, ...items);
  };
  const checked = () =>
    section(
      'Checked, no evidence found',
      report.checkedNotAffected.map((item) => `- [${item.id}] ${item.summary}`),
    );
  if (report.upToDate) {
    lines.push('Nothing to review.');
    if (!options.brief) checked();
    return lines.join('\n');
  }
  section('Must (breaking)', report.must.map(line));
  section('Should', [
    ...report.should.map(line),
    ...report.keptSkills.map(
      (kept) => `- [skill:${kept.name}] edited ${kept.host} skill is behind this SDK; merge the shipped changes by hand`,
    ),
  ]);
  section('Recommended', report.recommended.map(line));
  if (options.brief) {
    const counts: string[] = [];
    if (report.offer.length > 0) counts.push(`${report.offer.length} optional item(s)`);
    if (report.unclassified.length > 0) counts.push(`${report.unclassified.length} version(s) without notes`);
    if (counts.length > 0) lines.push('', `Also ${counts.join(' and ')}. Run \`glirastes upgrade report\` for details.`);
  } else {
    section('Optional, only if wanted', report.offer.map(line));
    section(
      'Unclassified (no upgrade notes, read the changelog)',
      report.unclassified.map((u) => `- ${u.changelogHeading}`),
    );
    checked();
    lines.push(
      '',
      'This report never changes your code. When the review is done, run `glirastes upgrade ack`; `glirastes upgrade ack --defer <id>` keeps an item listed.',
    );
  }
  return lines.join('\n');
}

export function summarizeUpgradeReport(report: UpgradeReport): string | null {
  if (report.upToDate) return null;
  const should = report.should.length + report.keptSkills.length;
  const unclassified =
    report.unclassified.length > 0
      ? `, ${report.unclassified.length} ${report.unclassified.length === 1 ? 'version' : 'versions'} without notes`
      : '';
  const deferred = report.must.filter((item) => item.deferred).length;
  const must = `${report.must.length} must${deferred > 0 ? ` (${deferred} deferred)` : ''}`;
  return (
    `Glirastes ${report.from} → ${report.to}: ${must}, ${should} should, ` +
    `${report.recommended.length} recommended, ${report.offer.length} optional${unclassified}. Run \`glirastes upgrade report\`.`
  );
}

export interface UpgradeIo {
  cwd?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  sdkVersion?: string;
  notesDir?: string;
  changelogPath?: string;
  skillsDir?: string;
}

export const UPGRADE_USAGE = [
  'Usage: glirastes upgrade report [--json] [--brief] [--from <version>] [--fail-on breaking] [--root <dir>]',
  '         show what changed in the SDK since this app was last reviewed (never changes your code; --brief lists must, should and recommended items and counts the rest)',
  '       glirastes upgrade ack [--defer <note-id>]... [--force] [--root <dir>]',
  '         mark everything up to the installed SDK as reviewed; each --defer keeps that note listed until an ack no longer names it',
  '         ack refuses while a breaking item is detected as affected and not deferred; --force acknowledges anyway',
].join('\n');

export const UPGRADE_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  report: {
    flags: ['--json', '--brief'],
    values: ['--from', '--fail-on', '--root'],
  },
  // `--defer` repeats; takeDeferIds reads it before parseToolArgs sees the rest.
  ack: { flags: ['--force'], values: ['--defer', '--root'] },
};

/** Takes every `--defer <id>` out of `argv`; the flag repeats, which `parseToolArgs` does not support. */
function takeDeferIds(argv: ReadonlyArray<string>): { ids: string[]; rest: string[] } {
  const ids: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--defer') {
      rest.push(argv[index]!);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ToolsUsageError('--defer needs a note id.');
    ids.push(value);
    index += 1;
  }
  return { ids, rest };
}

export async function runUpgradeCommand(argv: ReadonlyArray<string>, io: UpgradeIo = {}): Promise<number> {
  const log = io.log ?? ((l: string) => console.log(l));
  const error = io.error ?? ((l: string) => console.error(l));
  const first = argv[0];
  const sub = first === undefined || first.startsWith('--') ? 'report' : first;
  const rest = sub === first ? argv.slice(1) : argv;
  const spec = UPGRADE_SUBCOMMANDS[sub];
  if (!spec) {
    error(`Unknown upgrade subcommand '${sub}'.\n${UPGRADE_USAGE}`);
    return 2;
  }
  let args: ReturnType<typeof parseToolArgs>;
  let deferIds: string[] = [];
  try {
    const taken = sub === 'ack' ? takeDeferIds(rest) : { ids: [], rest: [...rest] };
    deferIds = taken.ids;
    args = parseToolArgs(taken.rest, spec);
  } catch (cause) {
    if (!(cause instanceof ToolsUsageError)) throw cause;
    error(`${cause.message}\n${UPGRADE_USAGE}`);
    return 2;
  }
  const rootDir = resolve(args.values.get('--root') ?? io.cwd ?? process.cwd());
  const sdkVersion = io.sdkVersion ?? SDK_VERSION;
  const reportOptions: UpgradeReportOptions = {
    rootDir,
    sdkVersion,
    ...(io.notesDir ? { notesDir: io.notesDir } : {}),
    ...(io.changelogPath ? { changelogPath: io.changelogPath } : {}),
    ...(io.skillsDir ? { skillsDir: io.skillsDir } : {}),
  };

  try {
    if (sub === 'report') {
      const failOn = args.values.get('--fail-on');
      if (failOn !== undefined && failOn !== 'breaking') {
        error(`--fail-on only accepts 'breaking'.\n${UPGRADE_USAGE}`);
        return 2;
      }
      const from = args.values.get('--from');
      if (from !== undefined && !isSemver(from)) {
        error(`--from needs a version like 0.17.0, got '${from}'.\n${UPGRADE_USAGE}`);
        return 2;
      }
      const report = await createUpgradeReport({
        ...reportOptions,
        ...(from ? { from } : {}),
      });
      log(
        args.flags.has('--json')
          ? JSON.stringify(report, null, 2)
          : formatUpgradeReport(report, { brief: args.flags.has('--brief') }),
      );
      return failOn === 'breaking' && openMustItems(report).length > 0 ? 1 : 0;
    }

    // ack
    if (!isSemver(sdkVersion)) {
      error(`glirastes upgrade: the installed version '${sdkVersion}' is not semver; ${BASELINE_PATH} was not changed.`);
      return 1;
    }
    const report = await createUpgradeReport(reportOptions);
    const baseline: SdkBaseline = (await readBaseline(rootDir)) ?? {
      schemaVersion: 1,
      reviewedThrough: report.from,
      decisions: {},
    };
    const deferred: Array<{ id: string; version: string }> = [];
    if (deferIds.length > 0) {
      const notesDir = reportOptions.notesDir ?? findPackageUpgradeNotesDir();
      const { notes } = await loadUpgradeNoteSet(notesDir, sdkVersion);
      for (const id of new Set(deferIds)) {
        const target = notes.find((note) => note.id === id);
        if (!target) {
          error(`Unknown upgrade note '${id}'. Run glirastes upgrade report --json to list note ids; ${BASELINE_PATH} was not changed.`);
          return 1;
        }
        deferred.push({ id, version: target.version });
      }
    }
    const deferredIds = new Set(deferred.map((entry) => entry.id));
    const blocking = report.must.filter((item) => item.status === 'affected' && !deferredIds.has(item.id));
    if (blocking.length > 0 && !args.flags.has('--force')) {
      error(
        `Cannot acknowledge: ${blocking.length} breaking item(s) affect this app (${blocking
          .map((item) => item.id)
          .join(', ')}). Adopt them, keep them listed with --defer <id>, or pass --force.`,
      );
      return 1;
    }
    const reviewedThrough =
      compareVersions(sdkVersion, baseline.reviewedThrough) > 0 ? sdkVersion : baseline.reviewedThrough;
    await writeBaseline(rootDir, withDeferred(baseline, reviewedThrough, deferred));
    const kept = deferred.length > 0 ? `; deferred ${deferred.map((entry) => entry.id).join(', ')}` : '';
    log(`Reviewed through ${reviewedThrough}${kept}.`);
    return 0;
  } catch (cause) {
    error(`glirastes upgrade failed: ${(cause as Error).message}`);
    return 1;
  }
}
