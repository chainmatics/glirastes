import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { findPackageSkillsDir } from '../install-skills.js';
import { POLICY_SUBCOMMANDS, TOOLS_SUBCOMMANDS } from '../tools/index.js';
import type { ToolArgsSpec } from '../tools/args.js';

/** Top-level commands a skill may tell an agent to run (src/cli/index.ts). */
const COMMANDS = new Set(['init', 'setup', 'connect', 'sync', 'doctor', 'install', 'tools']);
const SECTIONS = ['## Boundaries', '## Workflow', '## Commands', '## Verification'] as const;
const KNOWN_PATHS = new Set<string>([
  ...Object.values(TOOLS_PATHS),
  '.glirastes/platform-connection.json',
  '.glirastes/installed-skills.json',
  '.glirastes/mcp-tool-names.json',
  // Chat entity and command overrides, read by createChatInteractionsHandler (P07b).
  '.glirastes/chat-interactions.json',
]);
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/--force\b/, 'never teaches --force'],
  [/sk-or-v1-\w/, 'never shows a key'],
  [/OPENROUTER_API_KEY=\S/, 'never writes a key value'],
  [/@AiTool|@AiModule|@AiParam/, 'never teaches decorators'],
  [/glirastes (?:generate|scan --sync)\b/, 'never teaches removed commands'],
];

export interface SkillCommand {
  line: string;
  argv: string[];
}

/** Splits a command line like a shell would for quoted words; no expansion. */
export function commandWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/** The runnable lines of the `## Commands` bash block. */
export function skillCommands(source: string): SkillCommand[] {
  const section = source.split(/^## /m).find((part) => part.startsWith('Commands\n'));
  const block = section ? /```bash\n([\s\S]*?)```/.exec(section)?.[1] : undefined;
  return (block ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => ({ line, argv: commandWords(line) }));
}

function argsProblem(argv: ReadonlyArray<string>, spec: ToolArgsSpec): string | undefined {
  let positionals = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (spec.flags.includes(word)) continue;
    if (spec.values.includes(word)) {
      index += 1;
      if (argv[index] === undefined) return `${word} needs a value`;
      continue;
    }
    if (word.startsWith('--')) return `unknown option ${word}`;
    positionals += 1;
  }
  return positionals > (spec.positionals ?? 0) ? 'too many arguments' : undefined;
}

function commandProblem(argv: ReadonlyArray<string>): string | undefined {
  if (argv[0] !== 'glirastes') return 'starts with something other than glirastes';
  const command = argv[1];
  if (!command || !COMMANDS.has(command)) return `unknown command ${command ?? ''}`;
  if (command !== 'tools') return undefined;
  const sub = argv[2];
  if (sub === 'policy') {
    const policy = argv[3];
    const spec = policy && Object.hasOwn(POLICY_SUBCOMMANDS, policy) ? POLICY_SUBCOMMANDS[policy] : undefined;
    return spec ? argsProblem(argv.slice(4), spec) : `unknown tools policy subcommand ${policy ?? ''}`;
  }
  const spec = sub && Object.hasOwn(TOOLS_SUBCOMMANDS, sub) ? TOOLS_SUBCOMMANDS[sub] : undefined;
  return spec ? argsProblem(argv.slice(3), spec) : `unknown tools subcommand ${sub ?? ''}`;
}

/** Everything a shipped SKILL.md must satisfy; empty when the skill is consistent with the CLI. */
export function lintSkill(name: string, source: string): string[] {
  const problems: string[] = [];
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
  if (!frontmatter) return ['has no frontmatter'];
  const fields = frontmatter.split('\n').map((line) => line.split(':')[0]);
  if (fields.join(',') !== 'name,description') problems.push('frontmatter has exactly name and description');
  if (!frontmatter.includes(`name: ${name}\n`)) problems.push(`frontmatter names ${name}`);
  if (!/^description: Use when \S/m.test(frontmatter)) problems.push('description starts with "Use when"');
  let previous = -1;
  for (const section of SECTIONS) {
    const index = source.indexOf(`\n${section}\n`);
    if (index < 0) problems.push(`has a "${section}" section`);
    else if (index < previous) problems.push(`"${section}" follows the sections before it`);
    previous = Math.max(previous, index);
  }
  const commands = skillCommands(source);
  if (commands.length === 0) problems.push('the Commands section has a bash block with at least one command');
  for (const command of commands) {
    const problem = commandProblem(command.argv);
    if (problem) problems.push(`command "${command.line}": ${problem}`);
  }
  for (const match of source.matchAll(/glirastes tools ([a-z-]+)(?: ([a-z-]+))?/g)) {
    const [, sub, policy] = match;
    if (sub === 'policy') {
      if (policy && !Object.hasOwn(POLICY_SUBCOMMANDS, policy)) problems.push(`mentions unknown glirastes tools policy ${policy}`);
    } else if (!Object.hasOwn(TOOLS_SUBCOMMANDS, sub!)) {
      problems.push(`mentions unknown glirastes tools ${sub}`);
    }
  }
  for (const match of source.matchAll(/\.glirastes\/[A-Za-z0-9._/-]*[A-Za-z0-9]/g)) {
    const path = match[0];
    if (!KNOWN_PATHS.has(path) && path !== '.glirastes/build' && !path.startsWith('.glirastes/build/')) {
      problems.push(`mentions unknown file ${path}`);
    }
  }
  if (!source.includes('never calls a model')) problems.push('states that Glirastes never calls a model');
  for (const [pattern, rule] of FORBIDDEN) {
    if (pattern.test(source)) problems.push(rule);
  }
  if (source.split('\n').length > 400) problems.push('stays under 400 lines');
  return problems;
}

export async function readSkill(name: string): Promise<string> {
  return readFile(join(findPackageSkillsDir(), name, 'SKILL.md'), 'utf8');
}
