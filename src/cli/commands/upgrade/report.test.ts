import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_PATH, readBaseline, writeBaseline } from './baseline.js';
import {
  createUpgradeReport,
  formatUpgradeReport,
  runUpgradeCommand,
  summarizeUpgradeReport,
} from './report.js';

let root: string;
let notesDir: string;
let changelogPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'upgrade-report-'));
  notesDir = join(root, '.notes', 'upgrade-notes');
  changelogPath = join(root, '.notes', 'CHANGELOG.md');
  await mkdir(notesDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

function note(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, summary: `${id} summary`, howTo: `${id} how`, skill: 'some-skill', ...extra };
}

async function writeNotes(version: string, notes: unknown[]) {
  await writeFile(join(notesDir, `${version}.json`), JSON.stringify({ version, notes }));
}

async function baseline(reviewedThrough: string, deferred: string[] = []) {
  await writeBaseline(root, {
    schemaVersion: 1,
    reviewedThrough,
    decisions: Object.fromEntries(deferred.map((id) => [id, { decision: 'deferred', version: '0.19.0' }])),
  });
}

/** An app file that imports glirastes, so `affectedWhen: { imports: ['glirastes'] }` matches. */
async function appUsesGlirastes() {
  await writeFile(join(root, 'app.ts'), "import { x } from 'glirastes';\n");
}

const affected = { affectedWhen: { imports: ['glirastes'] } };

async function seedAllKinds() {
  await writeNotes('0.19.0', [
    note('break-one', 'breaking'),
    note('deprecate-one', 'deprecated'),
    note('recommend-one', 'recommended'),
    note('optional-one', 'optional'),
  ]);
}

const opts = (extra = {}) => ({ rootDir: root, sdkVersion: '0.19.0', notesDir, changelogPath, ...extra });

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd: root,
      log: (l: string) => out.push(l),
      error: (l: string) => err.push(l),
      sdkVersion: '0.19.0',
      notesDir,
      changelogPath,
    },
  };
}

describe('createUpgradeReport', () => {
  it('groups notes into must/should/recommended/offer per Design', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts());
    expect(report.must.map((i) => i.id)).toEqual(['break-one']);
    expect(report.should.map((i) => i.id)).toEqual(['deprecate-one']);
    expect(report.recommended.map((i) => i.id)).toEqual(['recommend-one']);
    expect(report.offer.map((i) => i.id)).toEqual(['optional-one']);
    expect(report.from).toBe('0.18.0');
    expect(report.to).toBe('0.19.0');
    expect(report.upToDate).toBe(false);
    expect(report.must[0]).toMatchObject({ version: '0.19.0', kind: 'breaking', status: 'unclear', skill: 'some-skill' });
  });

  it('marks deferred items and keeps them listed', async () => {
    await seedAllKinds();
    await baseline('0.18.0', ['recommend-one']);
    const report = await createUpgradeReport(opts());
    expect(report.must.map((i) => i.deferred)).toEqual([undefined]);
    expect(report.recommended.map((i) => [i.id, i.deferred])).toEqual([['recommend-one', true]]);
  });

  it('shows notes a pre-release build recorded as adopted or declined', async () => {
    await seedAllKinds();
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(
      join(root, BASELINE_PATH),
      JSON.stringify({
        schemaVersion: 1,
        reviewedThrough: '0.18.0',
        decisions: {
          'break-one': { decision: 'adopted', version: '0.19.0' },
          'deprecate-one': { decision: 'declined', version: '0.19.0' },
        },
      }),
    );
    const report = await createUpgradeReport(opts());
    expect(report.must.map((i) => i.id)).toEqual(['break-one']);
    expect(report.should.map((i) => i.id)).toEqual(['deprecate-one']);
  });

  it('missing baseline: from = installed-skills.json#sdkVersion, else the sdk version (upToDate)', async () => {
    await seedAllKinds();
    const none = await createUpgradeReport(opts());
    expect(none.from).toBe('0.19.0');
    expect(none.upToDate).toBe(true);

    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(
      join(root, '.glirastes/installed-skills.json'),
      JSON.stringify({ schemaVersion: 1, sdkVersion: '0.18.0', installs: [] }),
    );
    const withManifest = await createUpgradeReport(opts());
    expect(withManifest.from).toBe('0.18.0');
    expect(withManifest.must).toHaveLength(1);
  });

  it('range excludes notes at or below reviewedThrough', async () => {
    await writeNotes('0.18.0', [note('old-break', 'breaking')]);
    await writeNotes('0.19.0', [note('new-break', 'breaking')]);
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts());
    expect(report.must.map((i) => i.id)).toEqual(['new-break']);
  });

  it('versions in range without notes are unclassified with their CHANGELOG heading', async () => {
    await writeNotes('0.19.0', [note('new-break', 'breaking')]);
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [0.19.0] - 2026-12-01\n\n## [0.18.5] - 2026-11-25\n\n## [0.18.0] - 2026-11-19\n',
    );
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts());
    expect(report.unclassified).toEqual([{ version: '0.18.5', changelogHeading: '## [0.18.5] - 2026-11-25' }]);
  });

  it('a version with an empty notes file counts as classified', async () => {
    await writeNotes('0.18.5', []);
    await writeNotes('0.19.0', [note('new-break', 'breaking')]);
    await writeFile(changelogPath, '## [0.19.0] - x\n\n## [0.18.5] - y\n\n## [0.18.0] - z\n');
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts());
    expect(report.unclassified).toEqual([]);
  });

  it('kept edited skills appear under should', async () => {
    await writeNotes('0.19.0', []);
    await baseline('0.19.0');
    const skillsDir = join(root, 'shipped');
    await mkdir(join(skillsDir, 'alpha'), { recursive: true });
    await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), 'new shipped content');
    await mkdir(join(root, '.claude/skills/alpha'), { recursive: true });
    await writeFile(join(root, '.claude/skills/alpha/SKILL.md'), 'old content');
    await writeFile(
      join(root, '.glirastes/installed-skills.json'),
      JSON.stringify({
        schemaVersion: 1,
        sdkVersion: '0.18.0',
        installs: [
          {
            host: 'claude',
            target: '.claude/skills',
            mode: 'copy',
            skills: { alpha: { files: ['.claude/skills/alpha/SKILL.md'], contentHash: 'deadbeef' } },
          },
        ],
      }),
    );
    const report = await createUpgradeReport(opts({ skillsDir }));
    expect(report.keptSkills).toEqual([{ host: 'claude', name: 'alpha', reason: 'behind' }]);
    expect(report.upToDate).toBe(false);
    expect(formatUpgradeReport(report, {})).toContain('alpha');
  });

  it('downgrade: installed below reviewedThrough has nothing pending', async () => {
    await seedAllKinds();
    await baseline('0.20.0');
    const report = await createUpgradeReport(opts());
    expect(report.upToDate).toBe(true);
    expect(report.must).toEqual([]);
    expect(formatUpgradeReport(report, {})).toContain('baseline is ahead of the installed version');
  });

  it('a prerelease review does not hide the final release notes', async () => {
    await writeNotes('0.19.0', [note('final-break', 'breaking')]);
    await baseline('0.19.0-rc.1');
    const report = await createUpgradeReport(opts());
    expect(report.baselineAhead).toBe(false);
    expect(report.must.map((i) => i.id)).toEqual(['final-break']);
  });

  it('a prerelease --from is accepted', async () => {
    await writeNotes('0.19.0', [note('final-break', 'breaking')]);
    await baseline('0.19.0');
    const a = io();
    expect(await runUpgradeCommand(['report', '--from', '0.19.0-rc.1'], a.io)).toBe(0);
    expect(a.out.join('\n')).toContain('[final-break]');
  });

  it('--from overrides reviewedThrough', async () => {
    await writeNotes('0.18.0', [note('old-break', 'breaking')]);
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts({ from: '0.17.0' }));
    expect(report.from).toBe('0.17.0');
    expect(report.must.map((i) => i.id)).toEqual(['old-break']);
  });
});

describe('--brief', () => {
  it('lists must, should and recommended items, optional only as a count', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const text = formatUpgradeReport(await createUpgradeReport(opts()), { brief: true });
    expect(text).toContain('[break-one]');
    expect(text).toContain('[deprecate-one]');
    expect(text).toContain('[recommend-one]');
    expect(text).not.toContain('[optional-one]');
    expect(text).toContain('1 optional item');
  });

  it('prints recommended items when they are the only ones', async () => {
    await writeNotes('0.19.0', [note('recommend-one', 'recommended')]);
    await baseline('0.18.0');
    const text = formatUpgradeReport(await createUpgradeReport(opts()), { brief: true });
    expect(text).toContain('Recommended:');
    expect(text).toContain('[recommend-one]');
  });
});

describe('checked, not affected', () => {
  const guarded = () =>
    writeNotes('0.19.0', [
      note('break-guarded', 'breaking', { affectedWhen: { patterns: ['Never[I]nThisApp'] } }),
      note('deprecate-guarded', 'deprecated', { affectedWhen: { patterns: ['Never[I]nThisApp'] } }),
    ]);

  it('lists not-affected breaking items in the JSON, not in must', async () => {
    await guarded();
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts());
    expect(report.must).toEqual([]);
    expect(report.checkedNotAffected.map((i) => [i.id, i.status])).toEqual([['break-guarded', 'not-affected']]);
  });

  it('the full report names ack --defer, not decide', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const full = formatUpgradeReport(await createUpgradeReport(opts()), {});
    expect(full).toContain('glirastes upgrade ack --defer <id>');
    expect(full).not.toContain('decide');
  });

  it('the full report prints one line per item; hint and --brief do not', async () => {
    await guarded();
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts());
    const full = formatUpgradeReport(report, {});
    expect(full).toContain('Checked, no evidence found:');
    expect(full).toContain('- [break-guarded] break-guarded summary');
    expect(formatUpgradeReport(report, { brief: true })).not.toContain('break-guarded');
    expect(summarizeUpgradeReport(report)).toBeNull();
  });

  it('does not block ack', async () => {
    await guarded();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0');
  });
});

describe('summarizeUpgradeReport', () => {
  it('summary line', async () => {
    await seedAllKinds();
    await baseline('0.17.3');
    const report = await createUpgradeReport(opts());
    expect(summarizeUpgradeReport(report)).toBe(
      'Glirastes 0.17.3 → 0.19.0: 1 must, 1 should, 1 recommended, 1 optional. Run `glirastes upgrade report`.',
    );
  });

  it('counts versions without notes when present', async () => {
    await seedAllKinds();
    await writeFile(changelogPath, '## [0.19.0] - a\n\n## [0.18.2] - b\n\n## [0.18.1] - c\n\n## [0.17.3] - d\n');
    await baseline('0.17.3');
    const report = await createUpgradeReport(opts());
    expect(summarizeUpgradeReport(report)).toBe(
      'Glirastes 0.17.3 → 0.19.0: 1 must, 1 should, 1 recommended, 1 optional, 2 versions without notes. Run `glirastes upgrade report`.',
    );
  });

  it('labels deferred must items in the count', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking'), note('break-two', 'breaking')]);
    await baseline('0.18.0', ['break-one']);
    expect(summarizeUpgradeReport(await createUpgradeReport(opts()))).toBe(
      'Glirastes 0.18.0 → 0.19.0: 2 must (1 deferred), 0 should, 0 recommended, 0 optional. Run `glirastes upgrade report`.',
    );
  });

  it('is null when up to date', async () => {
    await writeNotes('0.19.0', []);
    await baseline('0.19.0');
    expect(summarizeUpgradeReport(await createUpgradeReport(opts()))).toBeNull();
  });
});

describe('runUpgradeCommand', () => {
  it('report exits 0 with must items; --fail-on breaking exits 1', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['report'], a.io)).toBe(0);
    expect(a.out.join('\n')).toContain('[break-one]');
    expect(a.out.join('\n')).toContain('Optional, only if wanted');
    const b = io();
    expect(await runUpgradeCommand(['report', '--fail-on', 'breaking'], b.io)).toBe(1);
  });

  it('--json output matches UpgradeReport shape', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['report', '--json'], a.io)).toBe(0);
    const parsed = JSON.parse(a.out.join('\n'));
    for (const key of ['from', 'to', 'must', 'should', 'recommended', 'offer', 'keptSkills', 'unclassified', 'upToDate']) {
      expect(parsed).toHaveProperty(key);
    }
  });

  it('report without .glirastes dir prints no baseline line, exit 0', async () => {
    await seedAllKinds();
    const a = io();
    expect(await runUpgradeCommand(['report'], a.io)).toBe(0);
    expect(a.out.join('\n')).toContain('no baseline, reviewed as 0.19.0');
  });

  it('corrupt baseline names the file and exits 1', async () => {
    await seedAllKinds();
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(join(root, BASELINE_PATH), '{nope');
    const a = io();
    expect(await runUpgradeCommand(['report'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('sdk-baseline.json');
  });

  it('decide is not a subcommand', async () => {
    await seedAllKinds();
    const a = io();
    expect(await runUpgradeCommand(['decide', 'break-one', 'adopted'], a.io)).toBe(2);
    expect(a.err.join('\n')).not.toContain('upgrade decide');
  });

  it('report no longer accepts --all', async () => {
    await seedAllKinds();
    const a = io();
    expect(await runUpgradeCommand(['report', '--all'], a.io)).toBe(2);
  });

  it('usage states the ack rule', async () => {
    const a = io();
    await runUpgradeCommand(['frobnicate'], a.io);
    const usage = a.err.join('\n');
    expect(usage).toContain('glirastes upgrade ack [--defer <note-id>]... [--undefer <note-id>]... [--force]');
    expect(usage).toMatch(/refuses while a breaking item is affected or unclear and not deferred/);
    expect(usage).not.toContain('decide');
  });

  it('ack refuses while an affected breaking item is not deferred; --force advances reviewedThrough', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', affected)]);
    await appUsesGlirastes();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('break-one');
    expect(a.err.join('\n')).toContain('--defer');
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.18.0');
    expect(await runUpgradeCommand(['ack', '--force'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0');
  });

  it('ack refuses while an unclear breaking item is not deferred (fail closed)', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('break-one');
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.18.0');
    expect(await runUpgradeCommand(['ack', '--defer', 'break-one'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0');
  });

  it('ack passes a breaking item checked as not affected without a deferral', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', { affectedWhen: { patterns: ['Never[I]nThisApp'] } })]);
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
  });

  it('ack does not block on a breaking item detected as adopted', async () => {
    await writeNotes('0.19.0', [
      note('break-one', 'breaking', { ...affected, adoptedWhen: { patterns: ['newApi\\('] } }),
    ]);
    await writeFile(join(root, 'app.ts'), "import { newApi } from 'glirastes';\nnewApi();\n");
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
  });

  it('ack --defer accepts an affected breaking item, which stays under must after ack', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', affected), note('recommend-one', 'recommended')]);
    await appUsesGlirastes();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack', '--defer', 'break-one'], a.io)).toBe(0);
    expect(await readBaseline(root)).toEqual({
      schemaVersion: 1,
      reviewedThrough: '0.19.0',
      decisions: { 'break-one': { decision: 'deferred', version: '0.19.0' } },
    });
    const report = await createUpgradeReport(opts());
    expect(report.must.map((i) => [i.id, i.deferred])).toEqual([['break-one', true]]);
    expect(report.recommended).toEqual([]);
    expect(report.upToDate).toBe(false);
  });

  it('ack records several --defer ids', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack', '--defer', 'break-one', '--defer', 'optional-one'], a.io)).toBe(0);
    expect(Object.keys((await readBaseline(root))!.decisions).sort()).toEqual(['break-one', 'optional-one']);
  });

  it('a plain ack keeps existing deferrals, and --defer adds to them', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', affected), note('recommend-one', 'recommended')]);
    await appUsesGlirastes();
    await baseline('0.19.0', ['break-one']);
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect(Object.keys((await readBaseline(root))!.decisions)).toEqual(['break-one']);
    expect(await runUpgradeCommand(['ack', '--defer', 'recommend-one'], a.io)).toBe(0);
    expect(Object.keys((await readBaseline(root))!.decisions).sort()).toEqual(['break-one', 'recommend-one']);
  });

  it('ack drops a deferral once the note is detected as adopted or not affected', async () => {
    await writeNotes('0.19.0', [
      note('break-one', 'breaking', { ...affected, adoptedWhen: { patterns: ['newApi\\('] } }),
      note('break-two', 'breaking', { affectedWhen: { patterns: ['oldApi\\('] } }),
      note('recommend-one', 'recommended'),
    ]);
    await writeFile(join(root, 'app.ts'), "import { newApi } from 'glirastes';\nnewApi();\n");
    await baseline('0.19.0', ['break-one', 'break-two', 'recommend-one']);
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect(Object.keys((await readBaseline(root))!.decisions)).toEqual(['recommend-one']);
  });

  it('ack --undefer removes a deferral; an undeferred affected breaking item blocks again', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', affected), note('recommend-one', 'recommended')]);
    await appUsesGlirastes();
    await baseline('0.19.0', ['break-one', 'recommend-one']);
    const a = io();
    expect(await runUpgradeCommand(['ack', '--undefer', 'recommend-one'], a.io)).toBe(0);
    expect(Object.keys((await readBaseline(root))!.decisions)).toEqual(['break-one']);
    expect(await runUpgradeCommand(['ack', '--undefer', 'break-one'], a.io)).toBe(1);
    expect(Object.keys((await readBaseline(root))!.decisions)).toEqual(['break-one']);
  });

  it('the ack refusal names --force as the path for an item implemented but not detected', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', affected)]);
    await appUsesGlirastes();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(1);
    expect(a.err).toEqual([
      'Cannot acknowledge: 1 breaking item(s) are affected or unclear (break-one). Adopt them, or keep them listed with --defer <id>. '
        + 'If an item is already implemented but detection cannot tell, verify the change in the code, then run glirastes upgrade ack --force.',
    ]);
  });

  it('ack says when a --defer is dropped as settled and when an --undefer id was not deferred', async () => {
    await writeNotes('0.19.0', [
      note('break-guarded', 'breaking', { affectedWhen: { patterns: ['Never[I]nThisApp'] } }),
      note('recommend-one', 'recommended'),
    ]);
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack', '--defer', 'break-guarded', '--undefer', 'recommend-one'], a.io)).toBe(0);
    expect(a.out).toEqual([
      'Not deferred: recommend-one was not deferred.',
      'Not deferred: break-guarded is already adopted or not affected.',
      'Reviewed through 0.19.0.',
    ]);
    expect((await readBaseline(root))!.decisions).toEqual({});
  });

  it('ack drops a deferral whose note no longer exists', async () => {
    await writeNotes('0.19.0', [note('recommend-one', 'recommended')]);
    await baseline('0.19.0', ['gone-note', 'recommend-one']);
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect(Object.keys((await readBaseline(root))!.decisions)).toEqual(['recommend-one']);
  });

  it('ack rejects the same id in --defer and --undefer', async () => {
    await seedAllKinds();
    const a = io();
    expect(await runUpgradeCommand(['ack', '--defer', 'break-one', '--undefer', 'break-one'], a.io)).toBe(2);
  });

  it.each(['--defer', '--undefer'])('ack %s rejects an unknown note id with a fixed message and writes nothing', async (flag) => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack', flag, 'nope-nope'], a.io)).toBe(1);
    expect(a.err).toEqual([
      "Unknown upgrade note 'nope-nope'. Run glirastes upgrade report --json to list note ids; .glirastes/sdk-baseline.json was not changed.",
    ]);
    expect(await readBaseline(root)).toEqual({ schemaVersion: 1, reviewedThrough: '0.18.0', decisions: {} });
  });

  it('ack --defer needs a value', async () => {
    const a = io();
    expect(await runUpgradeCommand(['ack', '--defer'], a.io)).toBe(2);
  });

  it('ack with an invalid installed version warns and writes nothing', async () => {
    await writeNotes('0.19.0', []);
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], { ...a.io, sdkVersion: 'workspace' })).toBe(1);
    expect(a.err.join('\n')).toContain('workspace');
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.18.0');
  });

  it('ack records a prerelease sdk version', async () => {
    await writeNotes('0.19.0', []);
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], { ...a.io, sdkVersion: '0.19.0-rc.1' })).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0-rc.1');
  });

  it('--fail-on breaking ignores deferred must items, which stay listed', async () => {
    await seedAllKinds();
    await baseline('0.18.0', ['break-one']);
    const a = io();
    expect(await runUpgradeCommand(['report', '--fail-on', 'breaking'], a.io)).toBe(0);
    expect(a.out.join('\n')).toContain('[break-one]');
    expect(a.out.join('\n')).toContain('[deferred]');
  });

  it('ack never moves reviewedThrough backwards', async () => {
    await seedAllKinds();
    await baseline('0.20.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.20.0');
    expect(JSON.parse(await readFile(join(root, BASELINE_PATH), 'utf8')).reviewedThrough).toBe('0.20.0');
  });

  it('rejects an invalid --from with exit 2, even with --fail-on breaking', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    for (const bad of ['v0.17.0', 'latest']) {
      const a = io();
      expect(await runUpgradeCommand(['report', '--from', bad, '--fail-on', 'breaking'], a.io)).toBe(2);
      expect(a.err.join('\n')).toContain('Usage');
    }
  });

  it('a refused ack does not create a baseline', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking', affected)]);
    await appUsesGlirastes();
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(
      join(root, '.glirastes/installed-skills.json'),
      JSON.stringify({ schemaVersion: 1, sdkVersion: '0.18.0', installs: [] }),
    );
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(1);
    expect(await readBaseline(root)).toBeUndefined();
  });

  it('rejects unknown subcommands and flags with exit 2', async () => {
    const a = io();
    expect(await runUpgradeCommand(['frobnicate'], a.io)).toBe(2);
    expect(await runUpgradeCommand(['report', '--wat'], a.io)).toBe(2);
  });
});

describe('app scan cost', () => {
  it('does not scan the app when no note is in range, and scans when one is', async () => {
    await baseline('0.19.0');
    await writeNotes('0.19.0', [note('break-one', 'breaking')]);
    const scan = vi.fn(async () => ({ files: [] }) as never);
    const none = await createUpgradeReport(opts({ scan }));
    expect(none.upToDate).toBe(true);
    expect(scan).not.toHaveBeenCalled();

    await baseline('0.18.0');
    await createUpgradeReport(opts({ scan }));
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('uses the kept skills the caller already planned', async () => {
    await baseline('0.19.0');
    const report = await createUpgradeReport(opts({ keptSkills: [{ host: 'claude', name: 'x', reason: 'behind' }] }));
    expect(report.keptSkills).toEqual([{ host: 'claude', name: 'x', reason: 'behind' }]);
  });
});
