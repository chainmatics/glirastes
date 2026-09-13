import { access, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installSkills } from './install-skills.js';
import {
  MANIFEST_RELATIVE_PATH,
  classifyInstalledSkill,
  readInstalledSkillsManifest,
} from './installed-skills-manifest.js';

const packageRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const foundationSkills = [
  'integrating-glirastes-nextjs',
  'maintaining-glirastes-tools',
  'building-glirastes-chat-ui',
] as const;
const setupSkill = 'setting-up-glirastes';

/** A temp project that looks like a Next.js app, so the stack is detectable. */
async function nextAppRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-install-'));
  await writeFile(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { next: '^16.0.0' } }),
    'utf8',
  );
  return rootDir;
}

async function skillSource(name: string): Promise<string> {
  return readFile(join(packageRoot, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('foundation agent skills', () => {
  it.each(foundationSkills)(
    '%s uses portable frontmatter and a trigger-only description',
    async (name) => {
      const source = await skillSource(name);
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';

      expect(frontmatter.split('\n').map((line) => line.split(':')[0]))
        .toEqual(['name', 'description']);
      expect(frontmatter).toContain('description: Use when');
    },
  );

  it('teaches source-derived local generation and optional sync instead of hand-authored annotations', async () => {
    const sources = await Promise.all([
      skillSource('integrating-glirastes-nextjs'),
      skillSource('maintaining-glirastes-tools'),
    ]);
    const combined = sources.join('\n');

    expect(combined).toContain('source-derived generator');
    expect(combined).toContain('glirastes sync');
    expect(combined).toContain('resolvePrincipal');
    expect(combined).not.toMatch(/ai-tool\.ts|@AiTool|@AiModule|@AiParam/);
  });

  it('keeps STT local and uses the single-stream controller', async () => {
    const source = await skillSource('building-glirastes-chat-ui');

    expect(source).toContain('visible interim transcript');
    expect(source).toContain('one microphone stream');
    expect(source).toContain('edit before sending');
    expect(source).not.toContain('LangGraphAiChat');
    expect(source).not.toMatch(/\bTTS\b|duplex voice/i);
  });

  it('installs only foundation-supported skills for the all profile', async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    try {
      await installSkills({
        parts: ['framework', 'tools', 'chat-ui'],
        dryRun: true,
        rootDir: packageRoot,
        target: '.tmp-skills',
      });
    } finally {
      console.log = originalLog;
    }

    const report = output.join('\n');
    for (const skill of foundationSkills) {
      expect(report).toContain(skill);
    }
    expect(report).not.toContain('integrating-glirastes-nestjs');
    expect(report).not.toContain(
      'integrating-glirastes-nextjs-with-nestjs-backend',
    );
  });

  it('keeps one canonical setup workflow for autonomous and interview mode', async () => {
    const source = await skillSource(setupSkill);

    expect(source).toContain('Autonomous mode');
    expect(source).toContain('Interview mode');
    expect(source).toContain('glirastes setup scan');
    expect(source).toContain('glirastes sync');
    expect(source).toContain('Standalone');
    expect(source).toContain('OpenRouter');
    expect(source).toContain('explicit consent');
    expect(source).toContain('Never send');
    expect(source).toContain('Never add decorators');
    expect(source).not.toMatch(/Create an @AiTool|Add @AiModule/);
  });

  it.each([
    ['codex', '.agents/skills'],
    ['claude', '.claude/skills'],
    ['gemini', '.gemini/skills'],
  ] as const)(
    'installs the optional setup skill for the %s host',
    async (host, expectedTarget) => {
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => output.push(values.join(' '));
      try {
        await installSkills({
          parts: ['framework', 'tools', 'chat-ui'],
          includeSetupSkills: true,
          host,
          dryRun: true,
          rootDir: packageRoot,
        });
      } finally {
        console.log = originalLog;
      }

      const report = output.join('\n');
      expect(report).toContain(expectedTarget);
      expect(report).toContain(setupSkill);
      expect(report).toContain(`Hosts:`);
      expect(report).toContain(host);
    },
  );

  it('requires an explicit host when setup skills are accepted', async () => {
    await expect(installSkills({
      parts: ['tools'],
      includeSetupSkills: true,
      dryRun: true,
      rootDir: packageRoot,
    })).rejects.toThrow('Choose at least one setup host');
  });

  it('keeps dry-run side-effect free', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-skills-dry-run-'));
    const target = 'agent-skills';
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        parts: ['tools'],
        includeSetupSkills: true,
        host: 'codex',
        dryRun: true,
        rootDir,
        target,
      });
    } finally {
      console.log = originalLog;
    }

    await expect(access(join(rootDir, target))).rejects.toThrow();
  });

  it('includes canonical skills in the published package allowlist', async () => {
    const packageJson = JSON.parse(await readFile(
      join(packageRoot, 'package.json'),
      'utf8',
    )) as { files?: string[] };

    expect(packageJson.files).toContain('skills');
    expect(packageJson.files).not.toContain('!dist/cli/commands');
    expect(packageJson.files).toContain('!dist/cli/commands/check-upgrade.*');
  });

  it('names only React surfaces that actually exist in the chat UI skill', async () => {
    const skill = await skillSource('building-glirastes-chat-ui');
    const named = new Set(
      [...skill.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)]
        .map((match) => match[1]!)
        .filter((name) => /^(use[A-Z]|[A-Z])/.test(name)),
    );
    expect(named.size).toBeGreaterThan(20);

    async function readTree(dir: string): Promise<string> {
      const entries = await readdir(dir, { withFileTypes: true });
      const parts = await Promise.all(entries.map(async (entry) => {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) return readTree(absolute);
        if (/\.tsx?$/.test(entry.name)) return readFile(absolute, 'utf8');
        return '';
      }));
      return parts.join('\n');
    }

    const surface = await readTree(join(packageRoot, 'src/react'));
    const missing = [...named].filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(surface),
    );

    // A skill that names an export nobody ships sends the reader looking for
    // something that was renamed or never existed.
    expect(missing).toEqual([]);
  });

  it('records what it installed so a refresh can tell it from authored work', async () => {
    const rootDir = await nextAppRoot();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        parts: ['framework', 'tools', 'chat-ui'],
      });
    } finally {
      console.log = originalLog;
    }

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(manifest).not.toBeNull();
    expect(manifest?.installs).toHaveLength(1);
    expect(manifest?.installs[0]?.host).toBe('claude');
    expect(manifest?.installs[0]?.target).toBe('.claude/skills');
    expect(manifest?.installs[0]?.mode).toBe('copy');
    expect(Object.keys(manifest?.installs[0]?.skills ?? {}).sort())
      .toEqual([...foundationSkills].sort());

    for (const name of foundationSkills) {
      expect(await classifyInstalledSkill(rootDir, manifest, 'claude', name))
        .toBe('unchanged');
    }
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', setupSkill))
      .toBe('unmanaged');
  });

  it('reports an edited skill as modified rather than silently replacing it', async () => {
    const rootDir = await nextAppRoot();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        parts: ['framework', 'tools', 'chat-ui'],
      });
    } finally {
      console.log = originalLog;
    }

    await writeFile(
      join(rootDir, '.claude/skills/maintaining-glirastes-tools/SKILL.md'),
      'the operator rewrote this\n',
      'utf8',
    );

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(
      await classifyInstalledSkill(rootDir, manifest, 'claude', 'maintaining-glirastes-tools'),
    ).toBe('modified');
    expect(
      await classifyInstalledSkill(rootDir, manifest, 'claude', 'integrating-glirastes-nextjs'),
    ).toBe('unchanged');
  });

  it('writes no manifest on a dry run', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-install-'));
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        stack: 'all',
        dryRun: true,
      });
    } finally {
      console.log = originalLog;
    }

    await expect(access(join(rootDir, MANIFEST_RELATIVE_PATH)))
      .rejects.toThrow();
  });

  it('ships no skill directory without a described SKILL.md', async () => {
    const skillsDir = join(packageRoot, 'skills');
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories.length).toBeGreaterThan(0);

    const described = await Promise.all(directories.map(async (name) => {
      const source = await readFile(
        join(skillsDir, name, 'SKILL.md'),
        'utf8',
      ).catch(() => '');
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
      const hasField = (field: string): boolean =>
        new RegExp(`^${field}:\\s*\\S`, 'm').test(frontmatter);
      return {
        name,
        described: hasField('name') && hasField('description'),
      };
    }));

    expect(described.filter((entry) => !entry.described).map((e) => e.name))
      .toEqual([]);
  });
});
