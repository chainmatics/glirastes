import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli as runCliEntry } from './index.js';
import { installSkills } from './commands/install-skills.js';
import {
  classifyInstalledSkill,
  hostRecord,
  readInstalledSkillsManifest,
} from './commands/installed-skills-manifest.js';
import {
  detectStack,
  proposeParts,
} from './commands/installer-parts.js';
import {
  runSetupWizard,
  type WizardDependencies,
  type WizardIo,
} from './commands/setup-wizard.js';

/** A project that looks like what an operator would actually run this in. */
async function freshNextApp(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-e2e-'));
  await writeFile(
    join(rootDir, 'package.json'),
    JSON.stringify({
      name: 'fresh-nextjs-app',
      dependencies: { next: '^16.0.0', react: '^19.0.0' },
    }, null, 2),
    'utf8',
  );
  await mkdir(join(rootDir, 'src/app'), { recursive: true });
  await writeFile(
    join(rootDir, 'src/app/page.tsx'),
    'export default function Page() { return null; }\n',
    'utf8',
  );
  return rootDir;
}

/** Drive the real CLI entry point, quietly, against a fixture. */
async function runCli(args: string[], rootDir: string): Promise<void> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runCliEntry([...args, '--root', rootDir]);
  } finally {
    console.log = originalLog;
  }
}

function silentIo(): WizardIo & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    isInteractive: false,
    log: (message) => { lines.push(message); },
    ask: async () => { throw new Error('must not prompt'); },
  };
}

/**
 * Everything past the assessment is stubbed — the control plane and the host
 * agent are not ours to run here. Skill installation is real.
 */
function deps(rootDir: string): WizardDependencies {
  return {
    installSkills: async ({ hosts, parts }) => {
      await installSkills({ rootDir, hosts, parts });
    },
    discover: async () => ({ executionCount: 7 }),
    assessmentArtifactExists: async () => true,
    hasProviderCredential: () => false,
    validate: async () => {},
    sync: async () => ({ runId: 'run-e2e' }),
  };
}

describe('a fresh app reaches a synced setup run', () => {
  it('completes with no external account and no prompting', async () => {
    const rootDir = await freshNextApp();
    const stack = await detectStack(rootDir);
    expect(stack).toBe('nextjs');

    const result = await runSetupWizard({
      rootDir,
      io: silentIo(),
      hosts: ['claude'],
      parts: proposeParts(stack),
      assessmentMode: 'interview',
      deps: deps(rootDir),
    });

    expect(result.runId).toBe('run-e2e');

    const manifest = await readInstalledSkillsManifest(rootDir);
    // The setup skill is there without having been asked for: interview mode is
    // carried out by it, so the mode implies the part.
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}).sort())
      .toEqual([
        'building-glirastes-chat-ui',
        'describing-glirastes-tools',
        'integrating-glirastes-nextjs',
        'maintaining-glirastes-tools',
        'migrating-to-glirastes',
        'setting-up-glirastes',
      ]);
    await access(join(
      rootDir,
      '.claude/skills/integrating-glirastes-nextjs/SKILL.md',
    ));
  });

  it('leaves the files the project already had untouched', async () => {
    const rootDir = await freshNextApp();
    const before = await readFile(join(rootDir, 'src/app/page.tsx'), 'utf8');

    await runSetupWizard({
      rootDir,
      io: silentIo(),
      hosts: ['claude'],
      parts: proposeParts('nextjs'),
      assessmentMode: 'interview',
      deps: deps(rootDir),
    });

    expect(await readFile(join(rootDir, 'src/app/page.tsx'), 'utf8'))
      .toBe(before);
  });
});

describe('parts install independently', () => {
  it('writes nothing for a part that was declined', async () => {
    const rootDir = await freshNextApp();
    await installSkills({ rootDir, host: 'claude', parts: ['tools'] });

    await access(join(rootDir, '.claude/skills/maintaining-glirastes-tools'));
    await expect(access(join(
      rootDir,
      '.claude/skills/building-glirastes-chat-ui',
    ))).rejects.toThrow();
    await expect(access(join(
      rootDir,
      '.claude/skills/integrating-glirastes-nextjs',
    ))).rejects.toThrow();
  });

  it('serves several hosts in one run, each with its own record', async () => {
    const rootDir = await freshNextApp();
    await installSkills({
      rootDir,
      hosts: ['claude', 'codex'],
      parts: ['tools'],
    });

    await access(join(
      rootDir,
      '.claude/skills/maintaining-glirastes-tools/SKILL.md',
    ));
    await access(join(
      rootDir,
      '.agents/skills/maintaining-glirastes-tools/SKILL.md',
    ));

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(manifest?.installs.map((install) => install.host))
      .toEqual(['claude', 'codex']);
    for (const host of ['claude', 'codex'] as const) {
      expect(await classifyInstalledSkill(
        rootDir,
        manifest,
        host,
        'maintaining-glirastes-tools',
      )).toBe('unchanged');
    }
  });

  it('installing for one host leaves another host alone', async () => {
    const rootDir = await freshNextApp();
    await installSkills({ rootDir, hosts: ['codex'], parts: ['tools'] });
    await installSkills({ rootDir, hosts: ['claude'], parts: ['chat-ui'] });

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(Object.keys(hostRecord(manifest, 'codex')?.skills ?? {}))
      .toEqual(['describing-glirastes-tools', 'maintaining-glirastes-tools']);
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}))
      .toEqual(['building-glirastes-chat-ui']);
  });

  it('accepts several hosts from one --host flag', async () => {
    const rootDir = await freshNextApp();
    await runCli(
      ['install', '--without-setup-skills', '--host', 'claude,codex'],
      rootDir,
    );

    await access(join(
      rootDir,
      '.claude/skills/maintaining-glirastes-tools/SKILL.md',
    ));
    await access(join(
      rootDir,
      '.agents/skills/maintaining-glirastes-tools/SKILL.md',
    ));
  });

  it('installs into each host directory', async () => {
    for (const [host, dir] of [
      ['claude', '.claude/skills'],
      ['codex', '.agents/skills'],
      ['gemini', '.gemini/skills'],
    ] as const) {
      const rootDir = await freshNextApp();
      await installSkills({ rootDir, host, parts: ['tools'] });
      await access(join(rootDir, dir, 'maintaining-glirastes-tools/SKILL.md'));
    }
  });
});

describe('refreshing an install', () => {
  it('upgrades what nobody touched and leaves an edited skill alone', async () => {
    const rootDir = await freshNextApp();
    await installSkills({ rootDir, host: 'claude', parts: ['tools', 'chat-ui'] });

    const editedPath = join(
      rootDir,
      '.claude/skills/maintaining-glirastes-tools/SKILL.md',
    );
    await writeFile(editedPath, 'the operator rewrote this\n', 'utf8');

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => { lines.push(String(message)); };
    try {
      await installSkills({ rootDir, host: 'claude', parts: ['tools', 'chat-ui'] });
    } finally {
      console.log = originalLog;
    }

    const printed = lines.join('\n');
    expect(printed).toContain('maintaining-glirastes-tools');
    expect(printed).toMatch(/edited since install/);
    expect(printed).toMatch(/refresh.*building-glirastes-chat-ui/s);

    // The edit survived; the untouched skill was refreshed in place.
    expect(await readFile(editedPath, 'utf8'))
      .toBe('the operator rewrote this\n');

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(await classifyInstalledSkill(
      rootDir,
      manifest,
      'claude',
      'building-glirastes-chat-ui',
    )).toBe('unchanged');
    // A skipped skill stays in the manifest rather than dropping out of it.
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}))
      .toContain('maintaining-glirastes-tools');
  });

  it('replaces an edited skill on --force and says it did', async () => {
    const rootDir = await freshNextApp();
    await installSkills({ rootDir, host: 'claude', parts: ['tools'] });

    const editedPath = join(
      rootDir,
      '.claude/skills/maintaining-glirastes-tools/SKILL.md',
    );
    await writeFile(editedPath, 'the operator rewrote this\n', 'utf8');

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => { lines.push(String(message)); };
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        parts: ['tools'],
        force: true,
      });
    } finally {
      console.log = originalLog;
    }

    expect(lines.join('\n')).toMatch(/replace.*maintaining-glirastes-tools/s);
    expect(await readFile(editedPath, 'utf8'))
      .not.toBe('the operator rewrote this\n');
  });

  it('never touches a skill it did not install', async () => {
    const rootDir = await freshNextApp();
    const ownPath = join(rootDir, '.claude/skills/our-own-skill/SKILL.md');
    await mkdir(join(ownPath, '..'), { recursive: true });
    await writeFile(
      ownPath,
      '---\nname: our-own-skill\ndescription: ours\n---\n',
      'utf8',
    );

    await installSkills({ rootDir, host: 'claude', parts: ['tools'] });

    expect(await readFile(ownPath, 'utf8')).toContain('name: our-own-skill');
    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(Object.keys(hostRecord(manifest, 'claude')?.skills ?? {}))
      .not.toContain('our-own-skill');
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', 'our-own-skill'))
      .toBe('unmanaged');
  });
});
