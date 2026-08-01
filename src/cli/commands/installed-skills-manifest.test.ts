import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_RELATIVE_PATH,
  classifyInstalledSkill,
  hashSkillDirectory,
  hostRecord,
  readInstalledSkillsManifest,
  withHostRecord,
  writeInstalledSkillsManifest,
  type InstallHost,
  type InstalledSkillsManifest,
} from './installed-skills-manifest.js';

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'glirastes-manifest-'));
}

async function writeSkill(
  rootDir: string,
  target: string,
  name: string,
  files: Record<string, string>,
): Promise<string[]> {
  const written: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(rootDir, target, name, relative);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    written.push(join(target, name, relative));
  }
  return written;
}

/** Install one skill for one host and record it, as the installer would. */
async function record(
  rootDir: string,
  host: InstallHost,
  target: string,
  name: string,
  files: Record<string, string>,
): Promise<InstalledSkillsManifest> {
  const written = await writeSkill(rootDir, target, name, files);
  const manifest = withHostRecord(
    await readInstalledSkillsManifest(rootDir),
    {
      host,
      target,
      mode: 'copy',
      skills: {
        [name]: {
          files: written,
          contentHash: await hashSkillDirectory(join(rootDir, target, name)),
        },
      },
    },
    '0.4.0',
  );
  await writeInstalledSkillsManifest(rootDir, manifest);
  return manifest;
}

describe('installed skills manifest', () => {
  it('records host, target, mode and one hashed entry per skill', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'a-skill', {
      'SKILL.md': '# a\n',
      'references/detail.md': 'detail\n',
    });

    const raw = JSON.parse(
      await readFile(join(rootDir, MANIFEST_RELATIVE_PATH), 'utf8'),
    ) as InstalledSkillsManifest;

    expect(raw.schemaVersion).toBe(1);
    expect(raw.installs).toHaveLength(1);
    expect(raw.installs[0]?.host).toBe('claude');
    expect(raw.installs[0]?.target).toBe('.claude/skills');
    expect(raw.installs[0]?.mode).toBe('copy');
    expect(Object.keys(raw.installs[0]!.skills)).toEqual(['a-skill']);
  });

  it('hashes independently of file order and line endings', async () => {
    const lf = await makeRoot();
    const crlf = await makeRoot();

    await writeSkill(lf, '.claude/skills', 's', {
      'SKILL.md': 'one\ntwo\n',
      'references/b.md': 'b\n',
    });
    // Same content, written in the opposite order and with CRLF endings.
    await writeSkill(crlf, '.claude/skills', 's', {
      'references/b.md': 'b\r\n',
      'SKILL.md': 'one\r\ntwo\r\n',
    });

    expect(await hashSkillDirectory(join(lf, '.claude/skills/s')))
      .toBe(await hashSkillDirectory(join(crlf, '.claude/skills/s')));
  });

  it('separates a different skill by its content', async () => {
    const rootDir = await makeRoot();
    await writeSkill(rootDir, '.claude/skills', 'one', { 'SKILL.md': 'one\n' });
    await writeSkill(rootDir, '.claude/skills', 'two', { 'SKILL.md': 'two\n' });

    expect(await hashSkillDirectory(join(rootDir, '.claude/skills/one')))
      .not.toBe(await hashSkillDirectory(join(rootDir, '.claude/skills/two')));
  });

  it('classifies an untouched skill as unchanged', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'kept', {
      'SKILL.md': 'kept\n',
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', 'kept'))
      .toBe('unchanged');
  });

  it('classifies an edited skill as modified so a refresh leaves it alone', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'edited', {
      'SKILL.md': 'original\n',
    });
    await writeFile(
      join(rootDir, '.claude/skills/edited/SKILL.md'),
      'the operator changed this\n',
      'utf8',
    );

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', 'edited'))
      .toBe('modified');
  });

  it('classifies a deleted skill as missing', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'gone', {
      'SKILL.md': 'gone\n',
    });
    await rm(join(rootDir, '.claude/skills/gone'), { recursive: true });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', 'gone'))
      .toBe('missing');
  });

  it('classifies a skill the manifest never recorded as unmanaged', async () => {
    const rootDir = await makeRoot();
    await writeSkill(rootDir, '.claude/skills', 'hand-written', {
      'SKILL.md': 'authored by the operator\n',
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(
      await classifyInstalledSkill(rootDir, manifest, 'claude', 'hand-written'),
    ).toBe('unmanaged');
  });

  it('treats an absent manifest as managing nothing', async () => {
    const rootDir = await makeRoot();
    const manifest = await readInstalledSkillsManifest(rootDir);

    expect(manifest).toBeNull();
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', 'anything'))
      .toBe('unmanaged');
  });

  it('rejects a manifest that is not the expected shape', async () => {
    const rootDir = await makeRoot();
    await mkdir(join(rootDir, '.glirastes'), { recursive: true });
    await writeFile(
      join(rootDir, MANIFEST_RELATIVE_PATH),
      JSON.stringify({ schemaVersion: 99 }),
      'utf8',
    );

    await expect(readInstalledSkillsManifest(rootDir)).rejects.toThrow();
  });
});

describe('several hosts side by side', () => {
  it('keeps one host record per host', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'shared', {
      'SKILL.md': 'shared\n',
    });
    await record(rootDir, 'codex', '.agents/skills', 'shared', {
      'SKILL.md': 'shared\n',
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(manifest?.installs.map((install) => install.host))
      .toEqual(['claude', 'codex']);
    expect(hostRecord(manifest, 'claude')?.target).toBe('.claude/skills');
    expect(hostRecord(manifest, 'codex')?.target).toBe('.agents/skills');
  });

  it('does not let one host erase what another installed', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'kept', {
      'SKILL.md': 'kept\n',
    });
    await record(rootDir, 'gemini', '.gemini/skills', 'other', {
      'SKILL.md': 'other\n',
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', 'kept'))
      .toBe('unchanged');
    expect(await classifyInstalledSkill(rootDir, manifest, 'gemini', 'other'))
      .toBe('unchanged');
  });

  it('classifies per host, not across hosts', async () => {
    const rootDir = await makeRoot();
    await record(rootDir, 'claude', '.claude/skills', 'both', {
      'SKILL.md': 'both\n',
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    // Installed for claude only: codex has no record of it.
    expect(await classifyInstalledSkill(rootDir, manifest, 'codex', 'both'))
      .toBe('unmanaged');
  });
});
