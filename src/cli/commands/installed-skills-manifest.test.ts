import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_RELATIVE_PATH,
  classifyInstalledSkill,
  hashSkillDirectory,
  readInstalledSkillsManifest,
  writeInstalledSkillsManifest,
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

describe('installed skills manifest', () => {
  it('records host, target, mode and one hashed entry per skill', async () => {
    const rootDir = await makeRoot();
    const files = await writeSkill(rootDir, '.claude/skills', 'a-skill', {
      'SKILL.md': '# a\n',
      'references/detail.md': 'detail\n',
    });

    await writeInstalledSkillsManifest(rootDir, {
      schemaVersion: 1,
      host: 'claude',
      target: '.claude/skills',
      mode: 'copy',
      sdkVersion: '0.4.0',
      skills: {
        'a-skill': {
          files,
          contentHash: await hashSkillDirectory(
            join(rootDir, '.claude/skills/a-skill'),
          ),
        },
      },
    });

    const raw = JSON.parse(
      await readFile(join(rootDir, MANIFEST_RELATIVE_PATH), 'utf8'),
    ) as Record<string, unknown>;

    expect(raw.schemaVersion).toBe(1);
    expect(raw.host).toBe('claude');
    expect(raw.target).toBe('.claude/skills');
    expect(raw.mode).toBe('copy');
    expect(Object.keys(raw.skills as object)).toEqual(['a-skill']);
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
    const files = await writeSkill(rootDir, '.claude/skills', 'kept', {
      'SKILL.md': 'kept\n',
    });
    await writeInstalledSkillsManifest(rootDir, {
      schemaVersion: 1,
      host: 'claude',
      target: '.claude/skills',
      mode: 'copy',
      sdkVersion: '0.4.0',
      skills: {
        kept: {
          files,
          contentHash: await hashSkillDirectory(
            join(rootDir, '.claude/skills/kept'),
          ),
        },
      },
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'kept'))
      .toBe('unchanged');
  });

  it('classifies an edited skill as modified so a refresh leaves it alone', async () => {
    const rootDir = await makeRoot();
    const files = await writeSkill(rootDir, '.claude/skills', 'edited', {
      'SKILL.md': 'original\n',
    });
    await writeInstalledSkillsManifest(rootDir, {
      schemaVersion: 1,
      host: 'claude',
      target: '.claude/skills',
      mode: 'copy',
      sdkVersion: '0.4.0',
      skills: {
        edited: {
          files,
          contentHash: await hashSkillDirectory(
            join(rootDir, '.claude/skills/edited'),
          ),
        },
      },
    });

    await writeFile(
      join(rootDir, '.claude/skills/edited/SKILL.md'),
      'the operator changed this\n',
      'utf8',
    );

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'edited'))
      .toBe('modified');
  });

  it('classifies a deleted skill as missing', async () => {
    const rootDir = await makeRoot();
    const files = await writeSkill(rootDir, '.claude/skills', 'gone', {
      'SKILL.md': 'gone\n',
    });
    await writeInstalledSkillsManifest(rootDir, {
      schemaVersion: 1,
      host: 'claude',
      target: '.claude/skills',
      mode: 'copy',
      sdkVersion: '0.4.0',
      skills: {
        gone: {
          files,
          contentHash: await hashSkillDirectory(
            join(rootDir, '.claude/skills/gone'),
          ),
        },
      },
    });
    await rm(join(rootDir, '.claude/skills/gone'), { recursive: true });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'gone'))
      .toBe('missing');
  });

  it('classifies a skill the manifest never recorded as unmanaged', async () => {
    const rootDir = await makeRoot();
    await writeSkill(rootDir, '.claude/skills', 'hand-written', {
      'SKILL.md': 'authored by the operator\n',
    });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(rootDir, manifest, 'hand-written'))
      .toBe('unmanaged');
  });

  it('treats an absent manifest as managing nothing', async () => {
    const rootDir = await makeRoot();
    const manifest = await readInstalledSkillsManifest(rootDir);

    expect(manifest).toBeNull();
    expect(await classifyInstalledSkill(rootDir, manifest, 'anything'))
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
