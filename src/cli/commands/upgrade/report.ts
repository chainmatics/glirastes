import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SDK_VERSION } from '../../../runtime/sdk-version.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from '../tools/args.js';
import { readInstalledSkillsManifest } from '../installed-skills-manifest.js';
import { planSkillsUpdate, type KeptSkill } from '../skills-auto-update.js';
import {
  BASELINE_PATH,
  ensureBaseline,
  readBaseline,
  recordDecision,
  UPGRADE_DECISIONS,
  writeBaseline,
  type SdkBaseline,
  type UpgradeDecision,
} from './baseline.js';
import { evaluateNote, scanApp, type AppScan } from './detect.js';
import {
  compareVersions,
  findPackageUpgradeNotesDir,
  loadUpgradeNotes,
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
  decision?: UpgradeDecision;
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
  /** Include adopted and declined notes. */
  all?: boolean;
  /** Where shipped skills come from (tests). */
  skillsDir?: string;
  /** Edited skills already planned by the caller (`tools refresh`); spares a second hash pass. */
  keptSkills?: ReadonlyArray<KeptSkill>;
  /** Replaces the app scan (tests). */
  scan?: (root: string) => Promise<AppScan>;
}

const HEADING = /^## \[(\d+\.\d+\.\d+)\]/;

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
    if (match) result.push({ version: match[1]!, heading: line.trimEnd() });
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
  const decisions = baseline?.decisions ?? {};
  const allNotes = await loadUpgradeNotes(notesDir, to);
  const inRange = (version: string) => compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
  // A deferred note stays visible after ack moved reviewedThrough past it.
  const notes = allNotes.filter(
    (note) =>
      inRange(note.version) ||
      (decisions[note.id]?.decision === 'deferred' && compareVersions(note.version, to) <= 0),
  );
  // Reading the whole app tree is only worth it when a note could match.
  const scan = notes.length > 0 ? await (options.scan ?? scanApp)(options.rootDir) : undefined;

  const report: UpgradeReport = { ...empty, checkedNotAffected: [] };
  for (const note of notes) {
    const { status, evidence } = evaluateNote(note, scan!);
    const decision = decisions[note.id]?.decision;
    if (!options.all && (decision === 'adopted' || decision === 'declined')) continue;
    const item: ReportItem = {
      id: note.id,
      version: note.version,
      kind: note.kind,
      summary: note.summary,
      howTo: note.howTo,
      skill: note.skill,
      status,
      evidence,
      ...(decision ? { decision } : {}),
    };
    const relevant = status === 'affected' || status === 'unclear';
    if (note.kind === 'breaking' && relevant) report.must.push(item);
    else if (note.kind === 'deprecated' && relevant) report.should.push(item);
    else if (note.kind === 'recommended' && relevant) report.recommended.push(item);
    else if (note.kind === 'optional' && status !== 'adopted') report.offer.push(item);
    else if (note.kind === 'breaking' && status === 'not-affected') report.checkedNotAffected.push(item);
  }

  const classified = new Set(allNotes.map((note) => note.version));
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

function line(item: ReportItem): string {
  const evidence = item.evidence.length > 0 ? ` (${item.evidence.map((e) => `${e.file}:${e.line}`).join(', ')})` : '';
  const decision = item.decision ? ` [${item.decision}]` : '';
  return `- [${item.id}] ${item.summary}${evidence}${decision} → ${item.skill}`;
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
  if (!options.brief) {
    section('Recommended', report.recommended.map(line));
    section('Optional, only if wanted', report.offer.map(line));
    section(
      'Unclassified (no upgrade notes, read the changelog)',
      report.unclassified.map((u) => `- ${u.changelogHeading}`),
    );
    checked();
    lines.push(
      '',
      'This report never changes your code. Record outcomes with `glirastes upgrade decide <id> adopted|declined|deferred`, then `glirastes upgrade ack`.',
    );
  }
  return lines.join('\n');
}

export function summarizeUpgradeReport(report: UpgradeReport): string | null {
  if (report.upToDate) return null;
  const should = report.should.length + report.keptSkills.length;
  return (
    `Glirastes ${report.from} → ${report.to}: ${report.must.length} must, ${should} should, ` +
    `${report.recommended.length} recommended, ${report.offer.length} optional. Run \`glirastes upgrade report\`.`
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
  'Usage: glirastes upgrade report [--json] [--all] [--brief] [--from <version>] [--fail-on breaking] [--root <dir>]',
  '         show what changed in the SDK since this app was last reviewed (never changes your code; --brief lists only must and should items)',
  '       glirastes upgrade decide <note-id> <adopted|declined|deferred> [--root <dir>]',
  '         record what you decided for one note in .glirastes/sdk-baseline.json',
  '       glirastes upgrade ack [--force] [--root <dir>]',
  '         mark everything up to the installed SDK as reviewed',
].join('\n');

export const UPGRADE_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  report: {
    flags: ['--json', '--all', '--brief'],
    values: ['--from', '--fail-on', '--root'],
  },
  decide: { flags: [], values: ['--root'], positionals: 2 },
  ack: { flags: ['--force'], values: ['--root'] },
};

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
  try {
    args = parseToolArgs(rest, spec);
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
      if (from !== undefined && !/^\d+\.\d+\.\d+([-+].*)?$/.test(from)) {
        error(`--from needs a version like 0.17.0, got '${from}'.\n${UPGRADE_USAGE}`);
        return 2;
      }
      const report = await createUpgradeReport({
        ...reportOptions,
        ...(from ? { from } : {}),
        all: args.flags.has('--all'),
      });
      log(
        args.flags.has('--json')
          ? JSON.stringify(report, null, 2)
          : formatUpgradeReport(report, { brief: args.flags.has('--brief') }),
      );
      return failOn === 'breaking' && report.must.length > 0 ? 1 : 0;
    }

    if (sub === 'decide') {
      const [id, decision] = args.positionals;
      if (!id || !decision) {
        error(`decide needs a note id and a decision.\n${UPGRADE_USAGE}`);
        return 2;
      }
      if (!(UPGRADE_DECISIONS as ReadonlyArray<string>).includes(decision)) {
        error(`Unknown decision '${decision}'. Use ${UPGRADE_DECISIONS.join(', ')}.`);
        return 1;
      }
      const notes = await loadUpgradeNotes(reportOptions.notesDir ?? findPackageUpgradeNotesDir(), sdkVersion);
      const target = notes.find((note) => note.id === id);
      if (!target) {
        error(`Unknown upgrade note '${id}'. Run glirastes upgrade report --all to list note ids.`);
        return 1;
      }
      const baseline = await baselineOrNew(reportOptions);
      await writeBaseline(rootDir, recordDecision(baseline, id, decision as UpgradeDecision, target.version));
      log(`Recorded ${decision} for ${id} in ${BASELINE_PATH}.`);
      return 0;
    }

    // ack
    const report = await createUpgradeReport(reportOptions);
    const baseline: SdkBaseline = (await readBaseline(rootDir)) ?? {
      schemaVersion: 1,
      reviewedThrough: report.from,
      decisions: {},
    };
    const undecided = report.must.filter((item) => !baseline.decisions[item.id]);
    if (undecided.length > 0 && !args.flags.has('--force')) {
      error(
        `Cannot acknowledge: ${undecided.length} breaking item(s) have no decision (${undecided
          .map((item) => item.id)
          .join(', ')}). Run glirastes upgrade decide, or pass --force.`,
      );
      return 1;
    }
    const reviewedThrough =
      compareVersions(sdkVersion, baseline.reviewedThrough) > 0 ? sdkVersion : baseline.reviewedThrough;
    await writeBaseline(rootDir, { ...baseline, reviewedThrough });
    log(`Reviewed through ${reviewedThrough}.`);
    return 0;
  } catch (cause) {
    error(`glirastes upgrade failed: ${(cause as Error).message}`);
    return 1;
  }
}

/** The existing baseline, or a new one reviewed through the derived `from`, written to disk. */
async function baselineOrNew(options: UpgradeReportOptions): Promise<SdkBaseline> {
  const existing = await readBaseline(options.rootDir);
  if (existing) return existing;
  const from =
    (await installedSkillsVersion(options.rootDir)) ?? options.sdkVersion ?? SDK_VERSION;
  return ensureBaseline(options.rootDir, from);
}
