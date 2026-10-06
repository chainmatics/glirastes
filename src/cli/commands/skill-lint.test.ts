import { describe, expect, it } from 'vitest';
import { lintSkill, readSkill, skillCommands } from './__tests__/skill-lint.js';

/** Shipped skills that follow the P05 contract; each skill task adds its name. */
const LINTED_SKILLS: string[] = ['setting-up-glirastes', 'integrating-glirastes-nextjs'];

const VALID = [
  '---',
  'name: example-skill',
  'description: Use when an example needs a skill.',
  '---',
  '',
  '# Example',
  '',
  'Glirastes never calls a model; the coding agent does the work.',
  '',
  '## Boundaries',
  '',
  'Never edit `.glirastes/tool-policy.json`.',
  '',
  '## Workflow',
  '',
  '1. Run `glirastes tools refresh`.',
  '',
  '## Commands',
  '',
  '```bash',
  '# refresh first',
  'glirastes tools refresh',
  'glirastes tools describe --print <tool>',
  'glirastes tools policy raise <tool> write --reason "writes through a helper"',
  '```',
  '',
  '## Verification',
  '',
  '- `glirastes tools check` passes.',
  '',
].join('\n');

describe('skill lint', () => {
  it('accepts a skill that matches the CLI and reads its commands', () => {
    expect(lintSkill('example-skill', VALID)).toEqual([]);
    expect(skillCommands(VALID).map((command) => command.argv)).toEqual([
      ['glirastes', 'tools', 'refresh'],
      ['glirastes', 'tools', 'describe', '--print', '<tool>'],
      ['glirastes', 'tools', 'policy', 'raise', '<tool>', 'write', '--reason', 'writes through a helper'],
    ]);
  });

  it.each([
    ['an unknown subcommand', VALID.replace('glirastes tools refresh\n', 'glirastes tools generate\n'), 'command "glirastes tools generate": unknown tools subcommand generate'],
    ['an unknown flag', VALID.replace('--print <tool>', '--prints <tool>'), 'unknown option --prints'],
    ['an unknown policy subcommand', VALID.replace('policy raise', 'policy lower'), 'unknown tools policy subcommand lower'],
    ['a stale inline command', VALID.replace('Run `glirastes tools refresh`', 'Run `glirastes tools sync`'), 'mentions unknown glirastes tools sync'],
    ['an unknown file', VALID.replace('tool-policy.json`', 'tool-rules.json`'), 'mentions unknown file .glirastes/tool-rules.json'],
    ['a missing section', VALID.replace('## Verification', '## Checks'), 'has a "## Verification" section'],
    ['the missing model statement', VALID.replace('Glirastes never calls a model', 'Glirastes helps'), 'states that Glirastes never calls a model'],
    ['a forced reinstall', `${VALID}\nRun glirastes install --force.\n`, 'never teaches --force'],
    ['a wrong name', VALID.replace('name: example-skill', 'name: other-skill'), 'frontmatter names example-skill'],
  ])('reports %s', (_label, source, problem) => {
    expect(lintSkill('example-skill', source).join('\n')).toContain(problem);
  });

  it.each(LINTED_SKILLS)('%s matches the CLI, the files and the boundaries', async (name) => {
    expect(lintSkill(name, await readSkill(name))).toEqual([]);
  });
});
