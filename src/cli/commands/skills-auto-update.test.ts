import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolsPipelineResult } from '../../codegen/tools/pipeline.js';
import { SDK_VERSION } from '../../runtime/sdk-version.js';
import { createDoctorReport, formatDoctorReport } from './doctor.js';
import { findPackageSkillsDir, installSkills } from './install-skills.js';
import {
  MANIFEST_RELATIVE_PATH,
  hashSkillDirectory,
  readInstalledSkillsManifest,
  writeInstalledSkillsManifest,
} from './installed-skills-manifest.js';
import { planSkillsUpdate } from './skills-auto-update.js';
import { runToolsCommand } from './tools/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function nextApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-skills-auto-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { next: '^16.0.0' } }));
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(join(root, '.glirastes/tools.json'), JSON.stringify({
    schemaVersion: 1,
    appId: '019fa9a9-d5f7-7ec3-a3c7-8899de500001',
    targetAppKey: 'fixture',
    locale: 'en',
    sources: ['next-app'],
  }));
  return root;
}

/** An app whose skills were installed by an older SDK: the manifest records old hashes and version. */
async function installedByOlderSdk(options: { symlink?: boolean } = {}): Promise<string> {
  const root = await nextApp();
  await installSkills({ rootDir: root, host: 'claude', quiet: true, ...(options.symlink ? { symlink: true } : {}) });
  const manifest = (await readInstalledSkillsManifest(root))!;
  await writeInstalledSkillsManifest(root, { ...manifest, sdkVersion: '0.0.1' });
  return root;
}

/** Make an installed copy look like the older SDK's unedited version of it. */
async function ageSkill(root: string, name: string): Promise<void> {
  const dir = join(root, '.claude/skills', name);
  await appendFile(join(dir, 'SKILL.md'), '\nOlder wording.\n');
  const manifest = (await readInstalledSkillsManifest(root))!;
  const install = manifest.installs[0]!;
  install.skills[name]!.contentHash = await hashSkillDirectory(dir);
  await writeInstalledSkillsManifest(root, manifest);
}

function io(root: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const result: ToolsPipelineResult = {
    mode: 'write',
    changes: { added: [], changed: [], removed: [], unchanged: [] },
    findings: [],
    excluded: [],
    outputs: {},
    driftPaths: [],
    wrote: false,
  };
  return {
    out,
    err,
    deps: {
      cwd: root,
      env,
      log: (line: string) => { out.push(line); },
      error: (line: string) => { err.push(line); },
      runPipeline: async () => result,
    },
  };
}

const shipped = (name: string) => readFile(join(findPackageSkillsDir(), name, 'SKILL.md'), 'utf8');
const installed = (root: string, name: string) => readFile(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8');

describe('skills update on tools refresh', () => {
  it('refreshes unedited skills and records the new SDK version and hashes', async () => {
    const root = await installedByOlderSdk();
    await ageSkill(root, 'maintaining-glirastes-tools');
    await ageSkill(root, 'describing-glirastes-tools');
    const h = io(root);

    expect(await runToolsCommand(['refresh'], h.deps)).toBe(0);

    expect(await installed(root, 'maintaining-glirastes-tools')).toBe(await shipped('maintaining-glirastes-tools'));
    expect(await installed(root, 'describing-glirastes-tools')).toBe(await shipped('describing-glirastes-tools'));
    const manifest = (await readInstalledSkillsManifest(root))!;
    expect(manifest.sdkVersion).toBe(SDK_VERSION);
    expect(manifest.installs[0]!.skills['maintaining-glirastes-tools']!.contentHash)
      .toBe(await hashSkillDirectory(join(findPackageSkillsDir(), 'maintaining-glirastes-tools')));
    expect(h.out.join('\n')).toContain(`Skills updated to ${SDK_VERSION}: 2 refreshed.`);

    const again = io(root);
    await runToolsCommand(['refresh'], again.deps);
    expect(again.out.join('\n')).not.toContain('Skills');
  });

  it('keeps an edited copy and names it with the command that replaces it', async () => {
    const root = await installedByOlderSdk();
    await ageSkill(root, 'maintaining-glirastes-tools');
    await ageSkill(root, 'describing-glirastes-tools');
    const edited = join(root, '.claude/skills/describing-glirastes-tools/SKILL.md');
    await appendFile(edited, '\nOur team convention.\n');
    const before = await readFile(edited, 'utf8');
    const h = io(root);

    await runToolsCommand(['refresh'], h.deps);

    expect(await readFile(edited, 'utf8')).toBe(before);
    const output = h.out.join('\n');
    expect(output).toContain('1 refreshed, 1 edited copy kept (claude: describing-glirastes-tools)');
    expect(output).toContain('glirastes install --host claude --force');
    expect((await readInstalledSkillsManifest(root))!.sdkVersion).toBe(SDK_VERSION);
  });

  it('adds a newly shipped skill of a selected part and removes an unedited skill the SDK no longer ships', async () => {
    const root = await installedByOlderSdk();
    await rm(join(root, '.claude/skills/describing-glirastes-tools'), { recursive: true });
    const manifest = (await readInstalledSkillsManifest(root))!;
    delete manifest.installs[0]!.skills['describing-glirastes-tools'];
    const retired = join(root, '.claude/skills/retired-glirastes-skill');
    await mkdir(retired, { recursive: true });
    await writeFile(join(retired, 'SKILL.md'), 'old\n');
    manifest.installs[0]!.skills['retired-glirastes-skill'] = {
      files: ['.claude/skills/retired-glirastes-skill/SKILL.md'],
      contentHash: await hashSkillDirectory(retired),
    };
    await writeInstalledSkillsManifest(root, manifest);
    const h = io(root);

    await runToolsCommand(['refresh'], h.deps);

    expect(await installed(root, 'describing-glirastes-tools')).toBe(await shipped('describing-glirastes-tools'));
    await expect(lstat(retired)).rejects.toThrow();
    const skills = (await readInstalledSkillsManifest(root))!.installs[0]!.skills;
    expect(Object.keys(skills)).toContain('describing-glirastes-tools');
    expect(Object.keys(skills)).not.toContain('retired-glirastes-skill');
    // Parts that were never selected stay out.
    await expect(lstat(join(root, '.claude/skills/setting-up-glirastes'))).rejects.toThrow();
    expect(h.out.join('\n')).toContain('1 added, 1 removed');
  });

  it('relinks symlinked skills instead of copying them', async () => {
    const root = await installedByOlderSdk({ symlink: true });
    const link = join(root, '.claude/skills/maintaining-glirastes-tools');
    const stale = join(root, 'old-sdk-skill');
    await cp(join(findPackageSkillsDir(), 'maintaining-glirastes-tools'), stale, { recursive: true });
    await rm(link);
    await symlink(stale, link, 'dir');
    const h = io(root);

    await runToolsCommand(['refresh'], h.deps);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join(findPackageSkillsDir(), 'maintaining-glirastes-tools'));
    expect(h.out.join('\n')).toContain('1 refreshed');
  });

  it('leaves an app without a manifest untouched', async () => {
    const root = await nextApp();
    const h = io(root);

    expect(await runToolsCommand(['refresh'], h.deps)).toBe(0);

    await expect(lstat(join(root, '.claude'))).rejects.toThrow();
    await expect(lstat(join(root, MANIFEST_RELATIVE_PATH))).rejects.toThrow();
    expect(h.out.join('\n')).not.toContain('Skills');
  });

  it.each([
    ['--no-skills', ['refresh', '--no-skills'], {}],
    ['GLIRASTES_SKILLS_AUTO_UPDATE=0', ['refresh'], { GLIRASTES_SKILLS_AUTO_UPDATE: '0' }],
    ['check mode', ['refresh'], { CI: 'true' }],
  ] as const)('does not touch skills with %s', async (_label, argv, env) => {
    const root = await installedByOlderSdk();
    await ageSkill(root, 'maintaining-glirastes-tools');
    const before = await installed(root, 'maintaining-glirastes-tools');
    const h = io(root, { ...env });

    await runToolsCommand([...argv], h.deps);

    expect(await installed(root, 'maintaining-glirastes-tools')).toBe(before);
    expect((await readInstalledSkillsManifest(root))!.sdkVersion).toBe('0.0.1');
  });

  it('reports an unreadable manifest without failing the refresh', async () => {
    const root = await nextApp();
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(join(root, MANIFEST_RELATIVE_PATH), '{"schemaVersion":1}');
    const h = io(root);

    expect(await runToolsCommand(['refresh'], h.deps)).toBe(0);
    expect(h.err.join('\n')).toContain('Installed skills were not updated');
  });
});

describe('skills in tools check', () => {
  it('fails on stale unedited skills and never writes', async () => {
    const root = await installedByOlderSdk();
    await ageSkill(root, 'maintaining-glirastes-tools');
    const manifestBefore = await readFile(join(root, MANIFEST_RELATIVE_PATH), 'utf8');
    const h = io(root);

    expect(await runToolsCommand(['check'], h.deps)).toBe(1);

    const output = h.out.join('\n');
    expect(output).toContain(`out of date with glirastes ${SDK_VERSION} (recorded for 0.0.1): maintaining-glirastes-tools (refresh)`);
    expect(output).toContain('Run glirastes tools refresh');
    expect(await readFile(join(root, MANIFEST_RELATIVE_PATH), 'utf8')).toBe(manifestBefore);
  });

  it('fails when only the recorded SDK version is behind', async () => {
    const root = await installedByOlderSdk();
    expect(await runToolsCommand(['check'], io(root).deps)).toBe(1);
  });

  it('passes current skills and only warns about an edited copy', async () => {
    const root = await installedByOlderSdk();
    await ageSkill(root, 'maintaining-glirastes-tools');
    await appendFile(join(root, '.claude/skills/maintaining-glirastes-tools/SKILL.md'), '\nlocal\n');
    await runToolsCommand(['refresh'], io(root).deps);
    const h = io(root);

    expect(await runToolsCommand(['check'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Edited skills differ from glirastes');
  });

  it('skips skills with --no-skills, the opt-out variable and --integrity-only', async () => {
    const root = await installedByOlderSdk();
    expect(await runToolsCommand(['check', '--no-skills'], io(root).deps)).toBe(0);
    expect(await runToolsCommand(['check'], io(root, { GLIRASTES_SKILLS_AUTO_UPDATE: 'false' }).deps)).toBe(0);
    expect(await runToolsCommand(['check', '--integrity-only'], io(root).deps)).toBe(0);
  });

  it('plans nothing for current skills', async () => {
    const root = await nextApp();
    await installSkills({ rootDir: root, host: 'claude', quiet: true });
    const manifest = (await readInstalledSkillsManifest(root))!;
    await writeInstalledSkillsManifest(root, { ...manifest, sdkVersion: SDK_VERSION });

    const plan = (await planSkillsUpdate({ rootDir: root }))!;
    expect(plan.changes).toEqual([]);
    expect(plan.manifestChanged).toBe(false);
  });
});

describe('skills in doctor', () => {
  it('warns about stale skills only when the app installed them', async () => {
    const root = await installedByOlderSdk();
    const report = await createDoctorReport({ rootDir: root, env: {} });
    expect(report.checks.find((item) => item.name === 'agent-skills'))
      .toMatchObject({ status: 'warn', remediation: 'refresh-agent-skills' });
    expect(formatDoctorReport(report)).toContain('Installed agent skills');

    const bare = await createDoctorReport({ rootDir: await nextApp(), env: {} });
    expect(bare.checks.some((item) => item.name === 'agent-skills')).toBe(false);
  });
});
