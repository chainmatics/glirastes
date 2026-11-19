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

async function baseline(reviewedThrough: string, decisions: Record<string, string> = {}) {
  await writeBaseline(root, {
    schemaVersion: 1,
    reviewedThrough,
    decisions: Object.fromEntries(
      Object.entries(decisions).map(([id, d]) => [id, { decision: d, version: '0.19.0' }]),
    ) as never,
  });
}

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

  it('hides adopted and declined decisions, shows deferred', async () => {
    await seedAllKinds();
    await baseline('0.18.0', { 'break-one': 'adopted', 'deprecate-one': 'declined', 'recommend-one': 'deferred' });
    const report = await createUpgradeReport(opts());
    expect(report.must).toEqual([]);
    expect(report.should).toEqual([]);
    expect(report.recommended.map((i) => i.decision)).toEqual(['deferred']);
  });

  it('--all shows them with decision', async () => {
    await seedAllKinds();
    await baseline('0.18.0', { 'break-one': 'adopted', 'deprecate-one': 'declined' });
    const report = await createUpgradeReport(opts({ all: true }));
    expect(report.must[0]).toMatchObject({ id: 'break-one', decision: 'adopted' });
    expect(report.should[0]).toMatchObject({ id: 'deprecate-one', decision: 'declined' });
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

  it('--from overrides reviewedThrough', async () => {
    await writeNotes('0.18.0', [note('old-break', 'breaking')]);
    await baseline('0.18.0');
    const report = await createUpgradeReport(opts({ from: '0.17.0' }));
    expect(report.from).toBe('0.17.0');
    expect(report.must.map((i) => i.id)).toEqual(['old-break']);
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

  it('decide rejects an unknown note id', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['decide', 'nope-nope', 'adopted'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('nope-nope');
    expect((await readBaseline(root))!.decisions).toEqual({});
  });

  it('decide rejects an unknown decision', async () => {
    await seedAllKinds();
    const a = io();
    expect(await runUpgradeCommand(['decide', 'break-one', 'maybe'], a.io)).toBe(1);
  });

  it('decide records the note version and creates a baseline when missing', async () => {
    await seedAllKinds();
    const a = io();
    expect(await runUpgradeCommand(['decide', 'break-one', 'declined'], a.io)).toBe(0);
    expect(await readBaseline(root)).toEqual({
      schemaVersion: 1,
      reviewedThrough: '0.19.0',
      decisions: { 'break-one': { decision: 'declined', version: '0.19.0' } },
    });
  });

  it('ack refuses while a must item has no decision; --force advances reviewedThrough', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(1);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.18.0');
    expect(await runUpgradeCommand(['ack', '--force'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0');
  });

  it('ack advances once the must item is decided', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    await runUpgradeCommand(['decide', 'break-one', 'adopted'], a.io);
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0');
  });

  it('a deferred breaking item stays under must after ack moves past its version', async () => {
    await seedAllKinds();
    await baseline('0.18.0');
    const a = io();
    expect(await runUpgradeCommand(['decide', 'break-one', 'deferred'], a.io)).toBe(0);
    expect(await runUpgradeCommand(['ack'], a.io)).toBe(0);
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0');
    const report = await createUpgradeReport(opts());
    expect(report.must.map((i) => [i.id, i.decision])).toEqual([['break-one', 'deferred']]);
    expect(report.recommended).toEqual([]);
    expect(report.upToDate).toBe(false);
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
    await seedAllKinds();
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
