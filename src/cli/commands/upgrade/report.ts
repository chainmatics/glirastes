import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SDK_VERSION } from '../../../runtime/sdk-version.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from '../tools/args.js';
import { readInstalledSkillsManifest } from '../installed-skills-manifest.js';
import { planSkillsUpdate, type KeptSkill } from '../skills-auto-update.js';
import { BASELINE_PATH, readBaseline, withDeferred, writeBaseline, type SdkBaseline } from './baseline.js';
import { evaluateNote, scanApp, type AppScan } from './detect.js';
import { createOffersList, formatOffersList } from './offers.js';
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
  /** Deferred with `glirastes upgrade ack --defer`; stays listed until `--undefer` or until detection settles the note. */
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

export function formatUpgradeReport(report: UpgradeReport): string {
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
    checked();
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
  'Usage: glirastes upgrade report [--json] [--from <version>] [--fail-on breaking] [--root <dir>]',
  '         show what changed in the SDK since this app was last reviewed (never changes your code)',
  '       glirastes upgrade ack [--defer <note-id>]... [--undefer <note-id>]... [--force] [--root <dir>]',
  '         mark everything up to the installed SDK as reviewed; --defer keeps a note listed in later reports, --undefer drops that again',
  '         deferrals last until --undefer or until the note is detected as adopted or not affected',
  '         ack refuses while a breaking item is affected or unclear and not deferred; --force acknowledges anyway',
  '         (the intended path for an item already implemented in code that detection cannot recognize)',
  '       glirastes upgrade offers [--json] [--since <version>] [--root <dir>]',
  '         list every optional feature up to the installed SDK that the app does not use yet, also after ack (never changes your code)',
].join('\n');

export const UPGRADE_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  report: {
    flags: ['--json'],
    values: ['--from', '--fail-on', '--root'],
  },
  // `--defer` and `--undefer` repeat; takeRepeated reads them before parseToolArgs sees the rest.
  ack: { flags: ['--force'], values: ['--defer', '--undefer', '--root'] },
  offers: { flags: ['--json'], values: ['--since', '--root'] },
};

/** Takes every `<flag> <id>` out of `argv`; the flag repeats, which `parseToolArgs` does not support. */
function takeRepeated(argv: ReadonlyArray<string>, flag: string): { ids: string[]; rest: string[] } {
  const ids: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) {
      rest.push(argv[index]!);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ToolsUsageError(`${flag} needs a note id.`);
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
  let undeferIds: string[] = [];
  try {
    let remaining = [...rest];
    if (sub === 'ack') {
      const defer = takeRepeated(remaining, '--defer');
      const undefer = takeRepeated(defer.rest, '--undefer');
      deferIds = defer.ids;
      undeferIds = undefer.ids;
      remaining = undefer.rest;
      const both = deferIds.find((id) => undeferIds.includes(id));
      if (both) throw new ToolsUsageError(`'${both}' is passed to both --defer and --undefer.`);
    }
    args = parseToolArgs(remaining, spec);
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
    if (sub === 'offers') {
      const since = args.values.get('--since');
      if (since !== undefined && !isSemver(since)) {
        error(`--since needs a version like 0.17.0, got '${since}'.\n${UPGRADE_USAGE}`);
        return 2;
      }
      const list = await createOffersList({
        rootDir,
        sdkVersion,
        ...(reportOptions.notesDir ? { notesDir: reportOptions.notesDir } : {}),
        ...(since ? { since } : {}),
      });
      log(args.flags.has('--json') ? JSON.stringify(list, null, 2) : formatOffersList(list));
      return 0;
    }

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
          : formatUpgradeReport(report),
      );
      return failOn === 'breaking' && openMustItems(report).length > 0 ? 1 : 0;
    }

    // ack
    if (!isSemver(sdkVersion)) {
      error(`glirastes upgrade: the installed version '${sdkVersion}' is not semver; ${BASELINE_PATH} was not changed.`);
      return 1;
    }
    const notesDir = reportOptions.notesDir ?? findPackageUpgradeNotesDir();
    const { notes } = await loadUpgradeNoteSet(notesDir, sdkVersion);
    for (const id of [...deferIds, ...undeferIds]) {
      if (!notes.some((note) => note.id === id)) {
        error(`Unknown upgrade note '${id}'. Run glirastes upgrade report --json to list note ids; ${BASELINE_PATH} was not changed.`);
        return 1;
      }
    }
    // One scan serves the report and the deferral check.
    const baselineNow = await readBaseline(rootDir);
    const needsScan = deferIds.length > 0 || Object.keys(baselineNow?.decisions ?? {}).length > 0;
    let scanned: AppScan | undefined;
    const scan = async (root: string) => (scanned ??= await scanApp(root));
    const report = await createUpgradeReport({ ...reportOptions, notesDir, scan });
    const baseline: SdkBaseline = baselineNow ?? { schemaVersion: 1, reviewedThrough: report.from, decisions: {} };

    // Deferrals accumulate; one ends by --undefer or once detection settles the note.
    const deferred = new Map<string, string>();
    for (const [id, entry] of Object.entries(baseline.decisions)) deferred.set(id, entry.version);
    for (const id of deferIds) deferred.set(id, notes.find((note) => note.id === id)!.version);
    for (const id of undeferIds) {
      if (!deferred.delete(id)) log(`Not deferred: ${id} was not deferred.`);
    }
    // A deferral of a note this SDK no longer ships would stay invisible forever.
    for (const id of [...deferred.keys()]) {
      if (!notes.some((note) => note.id === id)) deferred.delete(id);
    }
    if (needsScan && deferred.size > 0) {
      const appScan = await scan(rootDir);
      for (const id of [...deferred.keys()]) {
        const { status } = evaluateNote(notes.find((candidate) => candidate.id === id)!, appScan);
        if (status !== 'adopted' && status !== 'not-affected') continue;
        deferred.delete(id);
        if (deferIds.includes(id)) log(`Not deferred: ${id} is already adopted or not affected.`);
      }
    }

    // Fail closed: a breaking item that is affected or unclear needs a deferral.
    const blocking = report.must.filter((item) => !deferred.has(item.id));
    if (blocking.length > 0 && !args.flags.has('--force')) {
      error(
        `Cannot acknowledge: ${blocking.length} breaking item(s) are affected or unclear (${blocking
          .map((item) => item.id)
          .join(', ')}). Adopt them, or keep them listed with --defer <id>. `
          + 'If an item is already implemented but detection cannot tell, verify the change in the code, then run glirastes upgrade ack --force.',
      );
      return 1;
    }
    const reviewedThrough =
      compareVersions(sdkVersion, baseline.reviewedThrough) > 0 ? sdkVersion : baseline.reviewedThrough;
    const entries = [...deferred].map(([id, version]) => ({ id, version }));
    await writeBaseline(rootDir, withDeferred(baseline, reviewedThrough, entries));
    const kept = entries.length > 0 ? `; deferred ${entries.map((entry) => entry.id).sort().join(', ')}` : '';
    log(`Reviewed through ${reviewedThrough}${kept}.`);
    const open = report.offer.filter((item) => !deferred.has(item.id)).length;
    if (open > 0) {
      log(`${open} optional ${open === 1 ? 'feature leaves' : 'features leave'} this report; \`glirastes upgrade offers\` lists them any time.`);
    }
    return 0;
  } catch (cause) {
    error(`glirastes upgrade failed: ${(cause as Error).message}`);
    return 1;
  }
}
