import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UpgradeNotesError,
  compareVersions,
  findPackageUpgradeNotesDir,
  loadUpgradeNotes,
} from './notes.js';

const note = (over: Record<string, unknown> = {}) => ({
  id: 'first-note',
  kind: 'recommended',
  summary: 'Summary',
  howTo: 'Do the thing',
  skill: 'glirastes-setup#chat',
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'upgrade-notes-'));
  await mkdir(join(dir, 'unreleased'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const write = (rel: string, body: unknown) =>
  writeFile(join(dir, rel), JSON.stringify(body));

describe('surface entries', () => {
  it('accept exact keys, a trailing .* and a * subpath', async () => {
    await write('unreleased/first-note.json', note({
      surface: ['glirastes/react#ComposerConfig', 'glirastes/react#ComposerConfig.*', '*#ComposerConfig.*', 'locale#sendButton'],
    }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).resolves.toHaveLength(1);
  });

  it.each(['glirastes/react#Composer*', 'glirastes/react#*', 'glirastes/*#ComposerConfig', 'ComposerConfig', 'glirastes/react#A.*.b'])(
    'reject %s',
    async (entry) => {
      await write('unreleased/first-note.json', note({ surface: [entry] }));
      await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/surface/);
    },
  );
});

describe('loadUpgradeNotes', () => {
  it('loads released and unreleased notes, tagging unreleased with the sdk version', async () => {
    await write('0.18.0.json', { version: '0.18.0', notes: [note()] });
    await write('unreleased/second-note.json', note({ id: 'second-note' }));
    const notes = await loadUpgradeNotes(dir, '0.19.0');
    expect(notes.map((n) => [n.id, n.version])).toEqual([
      ['first-note', '0.18.0'],
      ['second-note', '0.19.0'],
    ]);
  });

  it('rejects a duplicate id across files', async () => {
    await write('0.18.0.json', { version: '0.18.0', notes: [note()] });
    await write('unreleased/dup.json', note());
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(
      /0\.18\.0\.json[\s\S]*dup\.json|dup\.json[\s\S]*0\.18\.0\.json/,
    );
  });

  it('rejects an invalid regex in patterns', async () => {
    await write(
      'unreleased/bad.json',
      note({ affectedWhen: { patterns: ['('] } }),
    );
    const err = await loadUpgradeNotes(dir, '0.19.0').catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeNotesError);
    expect(err.message).toContain('patterns[0]');
    expect(err.message).toContain('bad.json');
  });

  it('rejects kind "info"', async () => {
    await write('unreleased/x.json', note({ kind: 'info' }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/kind/);
  });

  it('rejects id "A_b"', async () => {
    await write('unreleased/x.json', note({ id: 'A_b' }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/x\.json: id:/);
  });

  it('rejects unknown keys, oversize summary and bad skill', async () => {
    await write('unreleased/a.json', note({ extra: 1 }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(UpgradeNotesError);
    await rm(join(dir, 'unreleased/a.json'));
    await write('unreleased/b.json', note({ summary: 'x'.repeat(301) }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/summary/);
    await rm(join(dir, 'unreleased/b.json'));
    await write('unreleased/c.json', note({ skill: 'Bad Name' }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/skill/);
  });

  it('rejects a released file whose version does not match its name', async () => {
    await write('0.18.0.json', { version: '0.17.0', notes: [note()] });
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/version/);
  });

  it('tolerates an unreleased dir that only holds .gitkeep', async () => {
    await writeFile(join(dir, 'unreleased', '.gitkeep'), '');
    expect(await loadUpgradeNotes(dir, '0.19.0')).toEqual([]);
  });
});

describe('loader strictness', () => {
  it('rejects a stray top-level json file, ignoring non-json and api-surface.released.json', async () => {
    await writeFile(join(dir, 'README.md'), '');
    await write('api-surface.released.json', {});
    expect(await loadUpgradeNotes(dir, '0.19.0')).toEqual([]);
    await write('notes.json', {});
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/notes\.json/);
  });

  it('throws UpgradeNotesError for a missing notes dir', async () => {
    await expect(loadUpgradeNotes(join(dir, 'nope'), '0.19.0')).rejects.toThrow(UpgradeNotesError);
  });

  it('rejects an empty Detect', async () => {
    await write('unreleased/e.json', note({ affectedWhen: {} }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/at least one/);
    await write('unreleased/e.json', note({ adoptedWhen: { imports: [] } }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).rejects.toThrow(/at least one/);
  });
});

describe('compareVersions', () => {
  it('throws on non-numeric versions instead of returning NaN results', () => {
    expect(() => compareVersions('v0.17.0', '0.18.0')).toThrow(/Invalid version/);
    expect(() => compareVersions('0.18.0', 'latest')).toThrow(/Invalid version/);
  });

  it('orders 0.9.0 < 0.10.0 < 0.10.1', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.10.1')).toBeLessThan(0);
    expect(compareVersions('0.10.1', '0.10.1')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.9')).toBeGreaterThan(0);
  });
});

describe('compareVersions with prereleases', () => {
  it('orders a prerelease below its final release', () => {
    expect(compareVersions('0.19.0-rc.1', '0.19.0')).toBeLessThan(0);
    expect(compareVersions('0.19.0', '0.19.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.19.0-rc.1', '0.18.9')).toBeGreaterThan(0);
    expect(compareVersions('0.19.0-rc.1', '0.19.0-rc.1')).toBe(0);
  });

  it('compares prerelease identifiers per semver', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
    }
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('loads a released file for a prerelease version', async () => {
    await writeFile(join(dir, '0.19.0-rc.1.json'), JSON.stringify({ version: '0.19.0-rc.1', notes: [] }));
    await expect(loadUpgradeNotes(dir, '0.19.0')).resolves.toEqual([]);
  });
});

describe('findPackageUpgradeNotesDir', () => {
  it('locates the repo upgrade-notes directory', () => {
    expect(findPackageUpgradeNotesDir()).toMatch(/upgrade-notes$/);
  });
});
