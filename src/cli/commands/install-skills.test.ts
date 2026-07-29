import { readFile } from 'node:fs/promises';
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
});
