import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkApiSurface, prepareRelease } from '../scripts/prepare-release.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let root: string;

function git(...args: string[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    stdio: 'ignore',
  });
}

function note(id: string) {
  return { id, kind: 'recommended', summary: `${id} summary`, howTo: `${id} how`, skill: 'some-skill' };
}

const surface = async () => ['glirastes#A', 'glirastes#B'];

/** A committed temp copy of the release-relevant files, never the real repo. */
async function seed(unreleased: Record<string, unknown>, extra: Record<string, string> = {}) {
  await mkdir(join(root, 'upgrade-notes', 'unreleased'), { recursive: true });
  await mkdir(join(root, 'src', 'runtime'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'glirastes', version: '0.18.1', scripts: { test: 'vitest run' } }, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'src', 'runtime', 'sdk-version.ts'),
    "/** Kept equal to package.json#version by a test; bump both on release. */\nexport const SDK_VERSION = '0.18.1';\n",
  );
  await writeFile(join(root, 'upgrade-notes', 'api-surface.released.json'), '[\n  "glirastes#A"\n]\n');
  await writeFile(join(root, 'upgrade-notes', 'unreleased', '.gitkeep'), '');
  for (const [file, content] of Object.entries(unreleased)) {
    await writeFile(join(root, 'upgrade-notes', 'unreleased', file), JSON.stringify(content));
  }
  for (const [file, content] of Object.entries(extra)) {
    await writeFile(join(root, file), content);
  }
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
}

async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else files[rel] = await readFile(join(root, rel), 'utf8');
    }
  };
  await walk('');
  return files;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prepare-release-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('prepareRelease', () => {
  it('merges unreleased notes, keeps .gitkeep, refreshes the surface and bumps both versions', async () => {
    await seed({ 'b-note.json': note('b-note'), 'a-note.json': note('a-note') });

    const result = await prepareRelease({ root, version: '0.19.0', surface });

    expect(result.merged).toEqual(['a-note', 'b-note']);
    expect(JSON.parse(await readFile(join(root, 'upgrade-notes', '0.19.0.json'), 'utf8'))).toEqual({
      version: '0.19.0',
      notes: [note('a-note'), note('b-note')],
    });
    expect(await readdir(join(root, 'upgrade-notes', 'unreleased'))).toEqual(['.gitkeep']);
    expect(JSON.parse(await readFile(join(root, 'upgrade-notes', 'api-surface.released.json'), 'utf8'))).toEqual([
      'glirastes#A',
      'glirastes#B',
    ]);
    const pkg = await readFile(join(root, 'package.json'), 'utf8');
    expect(JSON.parse(pkg)).toEqual({ name: 'glirastes', version: '0.19.0', scripts: { test: 'vitest run' } });
    expect(pkg.endsWith('}\n')).toBe(true);
    expect(await readFile(join(root, 'src', 'runtime', 'sdk-version.ts'), 'utf8')).toContain(
      "export const SDK_VERSION = '0.19.0';",
    );
  });

  it('writes an empty notes file when nothing is unreleased (prereleases need one too)', async () => {
    await seed({});
    await prepareRelease({ root, version: '0.19.0-rc.1', surface });
    expect(JSON.parse(await readFile(join(root, 'upgrade-notes', '0.19.0-rc.1.json'), 'utf8'))).toEqual({
      version: '0.19.0-rc.1',
      notes: [],
    });
  });

  it('accepts an existing notes file without notes', async () => {
    await seed({ 'a-note.json': note('a-note') }, {});
    await writeFile(join(root, 'upgrade-notes', '0.19.0.json'), JSON.stringify({ version: '0.19.0', notes: [] }));
    git('add', '-A');
    git('commit', '-q', '-m', 'empty notes');
    await prepareRelease({ root, version: '0.19.0', surface });
    expect(JSON.parse(await readFile(join(root, 'upgrade-notes', '0.19.0.json'), 'utf8')).notes).toEqual([
      note('a-note'),
    ]);
  });

  it.each([
    ['a dirty tree', async () => {
      await writeFile(join(root, 'stray.txt'), 'x');
    }, /uncommitted changes/],
    ['an existing notes file with notes', async () => {
      await writeFile(join(root, 'upgrade-notes', '0.19.0.json'), JSON.stringify({ version: '0.19.0', notes: [note('x-note')] }));
      git('add', '-A');
      git('commit', '-q', '-m', 'notes');
    }, /0\.19\.0\.json already holds notes/],
    ['an invalid unreleased note', async () => {
      await writeFile(join(root, 'upgrade-notes', 'unreleased', 'bad.json'), JSON.stringify({ id: 'bad-note' }));
      git('add', '-A');
      git('commit', '-q', '-m', 'bad');
    }, /unreleased\/bad\.json/],
    ['an existing notes file whose notes are not a list', async () => {
      await writeFile(join(root, 'upgrade-notes', '0.19.0.json'), JSON.stringify({ version: '0.19.0', notes: {} }));
      git('add', '-A');
      git('commit', '-q', '-m', 'odd notes');
    }, /0\.19\.0\.json is not a valid notes file/],
  ])('refuses %s and changes nothing', async (_name, arrange, message) => {
    await seed({ 'a-note.json': note('a-note') });
    await arrange();
    const before = await snapshot();
    await expect(prepareRelease({ root, version: '0.19.0', surface })).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['0.18.1', '0.18.0', '0.18.1-rc.1'])('refuses %s, which is not above the current 0.18.1', async (version) => {
    await seed({ 'a-note.json': note('a-note') });
    const before = await snapshot();
    await expect(prepareRelease({ root, version, surface })).rejects.toThrow(/not above the current version 0\.18\.1/);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a version that is not semver', async () => {
    await seed({});
    await expect(prepareRelease({ root, version: 'v0.19.0', surface })).rejects.toThrow(/semver/);
    expect(existsSync(join(root, 'upgrade-notes', 'v0.19.0.json'))).toBe(false);
  });

  it('is wired as bun run release:prepare', async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['release:prepare']).toBe('bun scripts/prepare-release.ts');
  });
});

describe('checkApiSurface', () => {
  it('passes when the snapshot matches and names added and removed keys otherwise', async () => {
    await seed({});
    expect(await checkApiSurface({ root, surface: async () => ['glirastes#A'] })).toEqual([]);
    expect(await checkApiSurface({ root, surface })).toEqual(['+ glirastes#B']);
    expect(await checkApiSurface({ root, surface: async () => [] })).toEqual(['- glirastes#A']);
  });
});
