import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installSkills } from './install-skills.js';

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

  it('teaches scan and sync instead of hand-authored tool annotations', async () => {
    const sources = await Promise.all([
      skillSource('integrating-glirastes-nextjs'),
      skillSource('maintaining-glirastes-tools'),
    ]);
    const combined = sources.join('\n');

    expect(combined).toContain('glirastes scan');
    expect(combined).toContain('glirastes:sync');
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
        stack: 'all',
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
    expect(source).toContain('glirastes setup sync');
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
    'installs the optional setup skill for exactly one %s host',
    async (host, expectedTarget) => {
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => output.push(values.join(' '));
      try {
        await installSkills({
          stack: 'all',
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
      expect(report).toContain(`Host:`);
      expect(report).toContain(host);
    },
  );

  it('requires an explicit host when setup skills are accepted', async () => {
    await expect(installSkills({
      stack: 'all',
      includeSetupSkills: true,
      dryRun: true,
      rootDir: packageRoot,
    })).rejects.toThrow('Choose exactly one setup host');
  });

  it('keeps dry-run side-effect free', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-skills-dry-run-'));
    const target = 'agent-skills';
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        stack: 'all',
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
});
