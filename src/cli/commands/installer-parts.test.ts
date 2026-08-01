import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSTALLER_PARTS,
  detectStack,
  proposeParts,
  resolvePartSkills,
} from './installer-parts.js';

async function projectWith(dependencies: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-parts-'));
  await writeFile(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies }),
    'utf8',
  );
  return rootDir;
}

describe('stack detection', () => {
  it('detects Next.js from the dependency that proves it', async () => {
    expect(await detectStack(await projectWith({ next: '^16.0.0' })))
      .toBe('nextjs');
  });

  it('detects Next.js when it is only a devDependency', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-parts-'));
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: 'fixture', devDependencies: { next: '16.0.0' } }),
      'utf8',
    );
    expect(await detectStack(rootDir)).toBe('nextjs');
  });

  it('detects nothing in a project without a known framework', async () => {
    expect(await detectStack(await projectWith({ express: '^5.0.0' })))
      .toBeNull();
  });

  it('detects nothing when there is no package.json at all', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-parts-'));
    expect(await detectStack(rootDir)).toBeNull();
  });
});

describe('proposed parts', () => {
  it('proposes the framework part only when a stack was detected', () => {
    expect(proposeParts('nextjs')).toContain('framework');
    expect(proposeParts(null)).not.toContain('framework');
  });

  it('always proposes tool maintenance', () => {
    expect(proposeParts('nextjs')).toContain('tools');
    expect(proposeParts(null)).toContain('tools');
  });

  it('leaves the setup part to an explicit choice', () => {
    expect(proposeParts('nextjs')).not.toContain('setup');
    expect(proposeParts(null)).not.toContain('setup');
  });
});

describe('part resolution', () => {
  it('resolves each part independently to its own skills', () => {
    expect(resolvePartSkills(['framework'], { stack: 'nextjs' }))
      .toEqual(['integrating-glirastes-nextjs']);
    expect(resolvePartSkills(['chat-ui'], { stack: 'nextjs' }))
      .toEqual(['building-glirastes-chat-ui']);
    expect(resolvePartSkills(['tools'], { stack: 'nextjs' }))
      .toEqual(['maintaining-glirastes-tools']);
    expect(resolvePartSkills(['setup'], { stack: 'nextjs' }))
      .toEqual(['setting-up-glirastes']);
  });

  it('yields no skills for a part that was declined', () => {
    expect(resolvePartSkills([], { stack: 'nextjs' })).toEqual([]);
  });

  it('resolves the framework part to nothing when no stack was detected', () => {
    expect(resolvePartSkills(['framework', 'tools'], { stack: null }))
      .toEqual(['maintaining-glirastes-tools']);
  });

  it('never repeats a skill selected through two parts', () => {
    const resolved = resolvePartSkills(
      ['framework', 'framework', 'tools'],
      { stack: 'nextjs' },
    );
    expect(resolved).toEqual([
      'integrating-glirastes-nextjs',
      'maintaining-glirastes-tools',
    ]);
  });

  it('names the valid parts when given one that does not exist', () => {
    expect(() => resolvePartSkills(
      ['guardrails' as (typeof INSTALLER_PARTS)[number]],
      { stack: 'nextjs' },
    )).toThrow(/guardrails/);
    expect(() => resolvePartSkills(
      ['guardrails' as (typeof INSTALLER_PARTS)[number]],
      { stack: 'nextjs' },
    )).toThrow(/framework/);
  });
});
