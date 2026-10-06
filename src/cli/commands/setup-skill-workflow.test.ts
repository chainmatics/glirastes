import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPackageSkillsDir } from './install-skills.js';

describe('bundled local-first setup workflow', () => {
  it('derives tools with refresh and works through the agent work lists before wiring the chat', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/SKILL.md'), 'utf8');
    expect(source).toContain('glirastes setup inspect --json');
    expect(source.indexOf('glirastes tools refresh')).toBeGreaterThan(0);
    expect(source.indexOf('glirastes tools refresh')).toBeLessThan(source.indexOf('glirastes tools resolve --print'));
    expect(source.indexOf('glirastes tools resolve --print')).toBeLessThan(source.indexOf('glirastes tools describe --print'));
    expect(source).toContain('Standalone');
    expect(source).toContain('existing coding agent');
    expect(source).not.toContain('glirastes setup scan');
    expect(source).not.toContain('glirastes setup sync --artifact');
    expect(source).not.toContain('Ask the user to choose exactly one mode');
  });

  it('documents complete local bootstrap artifacts and does not confuse digest metadata with prompt content', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/references/artifact-contract.md'), 'utf8');
    for (const required of ['FoundationExecutionInventorySchema', 'targetAppKey', 'sections', 'appBehavior', 'responseStyle', 'server-verified']) {
      expect(source).toContain(required);
    }
    expect(source).toContain('Preserve');
  });

  it('keeps the Next.js companion local-first with real server authorization', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'integrating-glirastes-nextjs/SKILL.md'), 'utf8');
    for (const required of ['setting-up-glirastes', 'Standalone', 'createLocalRuntimeSource', 'resolvePrincipal', 'navigation', 'filter']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('In the Platform interviewer');
    expect(source).not.toContain('glirastes scan --sync');
  });

  it('maintains local code changes without making platform sync mandatory', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'maintaining-glirastes-tools/SKILL.md'), 'utf8');
    for (const required of ['Standalone', 'navigation', 'filter', 'glirastes setup --dry-run', 'glirastes doctor', 'restart']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('Platform interviewer');
    expect(source).not.toContain('Never duplicate Platform semantics');
    expect(source).not.toContain('Setup/Doctor alone do not currently guarantee this handler check');
  });

  it('uses the drop-in endpoint instead of requesting a second transport', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'building-glirastes-chat-ui/SKILL.md'), 'utf8');
    expect(source).toContain('creates its transport internally');
    const examples = source.match(/<VercelAiChat\b[^>]*\/>/g) ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(example).toContain('endpoint=');
    expect(source).not.toContain('| `transport` | required;');
    expect(source).not.toContain('| `primary`, `primarySoft` |');
  });
});
