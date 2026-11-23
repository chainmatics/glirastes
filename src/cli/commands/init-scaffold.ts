import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TOOLS_PATHS } from '../../codegen/tools/config.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { writeArtifactSetAtomically } from './atomic-artifact-write.js';
import { detectWorkspaceSources } from './workspace-sources.js';
import { AUDIO_WORKLET_COMMAND, audioWorkletGitignoreEntry, withAudioWorkletGitignoreEntry } from './stt/worklet.js';

/**
 * What `glirastes init` writes deterministically before the coding agent
 * starts (spec 4.3, 4.6, 4.8): the tools configuration with the app id that
 * Platform pairing later adopts, the prompt bundle every refresh needs, the
 * predev/prebuild scripts (with the voice worklet copy for apps that serve
 * `public/`) and a short hint in the agent instructions.
 * Existing files and scripts are never replaced; the worklet copy is chained
 * in front of an existing predev/prebuild script.
 */
export interface InitScaffold {
  /** The one app id of this app; tool ids derive from it. */
  appId: string;
  /** App-relative files init writes (or would write in a dry run). */
  written: string[];
  /** What the developer or the agent still has to do by hand. */
  notes: string[];
  /**
   * The edits to the developer's own files, one line each (a package.json
   * script added or changed, the .gitignore entry), so a dry run shows them.
   */
  changes: string[];
}

export const AGENT_HINT_START = '<!-- glirastes:tools -->';
export const AGENT_HINT_END = '<!-- /glirastes:tools -->';
const AGENT_HINT = [
  AGENT_HINT_START,
  '## Glirastes tools',
  '',
  'After changing API routes, pages, URL filters or client actions, run `glirastes tools refresh`.',
  'Work through `glirastes tools resolve --print` (skill `maintaining-glirastes-tools`) and',
  '`glirastes tools describe --print` (skill `describing-glirastes-tools`), then run',
  '`glirastes tools refresh` and `glirastes tools eval` again and commit `.glirastes` with the code.',
  'Never edit `.glirastes/tool-policy.json` or generated files yourself; Glirastes never calls a model.',
  'Before changing code that uses glirastes, run `glirastes upgrade report` (skill `upgrading-glirastes`).',
  "Propose must and should items with reasons, offer optional items only, and change nothing without the developer's consent.",
  'When the developer confirms the review, run `glirastes upgrade ack` (`--defer <id>` keeps an item listed).',
  AGENT_HINT_END,
  '',
].join('\n');

const IDENTITY_FILES = [
  TOOLS_PATHS.config,
  TOOLS_PATHS.promptBundle,
  TOOLS_PATHS.receipt,
  '.glirastes/platform-connection.json',
] as const;

const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['predev', 'glirastes tools refresh --keep-going'],
  ['prebuild', 'glirastes tools refresh'],
];

/**
 * Frameworks that serve `public/` at the site root, so `glirastes stt worklet`
 * (default `--out public`) puts the voice input's audio worklet at
 * `/audio-worklet-processor.js`. Cheap and idempotent, so init chains it for
 * every such app: voice is one config flag away, and without the file it fails.
 */
const PUBLIC_DIR_FRAMEWORKS = ['next', 'vite', 'react-scripts'] as const;

interface PackageJson {
  name?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function identityConflict(found: ReadonlyArray<readonly [string, string]>): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-SETUP-021',
    operation: 'setup.init',
    message: `The local Glirastes files name different apps (${found.map(([path]) => path).join(', ')}). `
      + 'Tool ids derive from the app id, so init never changes it silently; keep one app id in all of them.',
    remediation: 'keep-one-app-id',
  });
}

/** The app id the local files agree on, or undefined for a fresh app. */
export async function localAppIdentity(root: string): Promise<string | undefined> {
  const found: Array<readonly [string, string]> = [];
  for (const path of IDENTITY_FILES) {
    const raw = await readText(join(root, path));
    if (raw === undefined) continue;
    try {
      const appId = (JSON.parse(raw) as { appId?: unknown }).appId;
      if (typeof appId === 'string') found.push([path, appId]);
    } catch {
      // An unreadable file names no identity; refresh reports it.
    }
  }
  const ids = new Set(found.map(([, appId]) => appId));
  if (ids.size > 1) throw identityConflict(found);
  return found[0]?.[1];
}

function targetAppKey(name: unknown): string {
  const key = typeof name === 'string'
    ? name.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200)
    : '';
  return key || 'app';
}

function nextSources(root: string, dependencies: Record<string, string>): unknown[] {
  const sources: unknown[] = [];
  if (existsSync(join(root, 'src/app/api'))) sources.push('next-app');
  else if (existsSync(join(root, 'app/api'))) sources.push({ kind: 'next-app', apiDir: 'app/api' });
  else sources.push('next-app');
  sources.push('next-pages');
  if ('nuqs' in dependencies) sources.push('url-filters');
  sources.push('react-actions');
  return sources;
}

function promptBundle(appId: string, key: string): unknown {
  return {
    schemaVersion: 1,
    appId,
    artifactRef: `local://${key}/prompts`,
    sections: {
      planner: 'Use the available tools for what the user asks. Ask one short question when the target is unclear, and never invent data a tool did not return.',
      appBehavior: `You are the assistant of ${key}. Act only through the tools of this app and with the rights of the signed-in user.`,
      responseStyle: "Answer briefly in the user's language. Summarize tool results instead of repeating them.",
      capabilityFragments: {},
    },
  };
}

function indentationOf(raw: string): string | number {
  return /^( +|\t)"/m.exec(raw)?.[1] ?? 2;
}

/** Writes nothing that exists already; returns what it wrote (or would write with dryRun). */
export async function scaffoldToolsInputs(options: {
  root: string;
  host: 'codex' | 'claude';
  dryRun?: boolean;
  createAppId?: () => string;
}): Promise<InitScaffold> {
  const root = resolve(options.root);
  if (existsSync(join(root, '.glirastes')) && (await lstat(join(root, '.glirastes'))).isSymbolicLink()) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-020',
      operation: 'setup.agent',
      message: 'Review linked setup or skill folders before installing.',
      remediation: 'review-setup-write-paths',
    });
  }
  const packageRaw = await readText(join(root, 'package.json'));
  const packageJson = (packageRaw ? JSON.parse(packageRaw) : {}) as PackageJson;
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const appId = await localAppIdentity(root) ?? (options.createAppId ?? randomUUID)();
  const key = targetAppKey(packageJson.name);
  const writes: Array<{ path: string; content: string }> = [];
  const notes: string[] = [];
  const changes: string[] = [];
  const add = (path: string, content: string) => writes.push({ path, content });

  if (!existsSync(join(root, TOOLS_PATHS.config))) {
    if ('next' in dependencies) {
      add(TOOLS_PATHS.config, `${JSON.stringify({
        schemaVersion: 1,
        appId,
        targetAppKey: key,
        locale: 'en',
        sources: nextSources(root, dependencies),
      }, null, 2)}\n`);
      notes.push('Set "locale" in .glirastes/tools.json to the language of the app (e.g. "de-DE").');
    } else {
      const workspaces = await detectWorkspaceSources(root, packageJson);
      if (workspaces.sources.length > 0) {
        add(TOOLS_PATHS.config, `${JSON.stringify({
          schemaVersion: 1,
          appId,
          targetAppKey: key,
          locale: 'en',
          sources: workspaces.sources,
        }, null, 2)}\n`);
        notes.push(`Sources found in the workspaces for .glirastes/tools.json: ${workspaces.described.join(', ')}.`);
        notes.push(...workspaces.notes);
        notes.push('Set "locale" in .glirastes/tools.json to the language of the app (e.g. "de-DE").');
      } else if (workspaces.declared) {
        notes.push(`No supported app found in the workspaces (${workspaces.patterns.join(', ')}): integrating-glirastes-web describes .glirastes/tools.json for this stack.`);
      } else {
        notes.push('No Next.js app: integrating-glirastes-web describes .glirastes/tools.json for this stack.');
      }
    }
  }
  if (!existsSync(join(root, TOOLS_PATHS.promptBundle))) {
    add(TOOLS_PATHS.promptBundle, `${JSON.stringify(promptBundle(appId, key), null, 2)}\n`);
  }

  // The host's instruction file, plus the other one when it exists; a link
  // (CLAUDE.md -> AGENTS.md) is followed so its target gets the hint once.
  const hostFile = options.host === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const hint = await resolveHintTargets(root, [hostFile, 'AGENTS.md', 'CLAUDE.md'], hostFile);
  notes.push(...hint.notes);
  const hintTargets = hint.targets;
  // Insert only (as released): an existing block, edited or not, stays; `glirastes install` updates it.
  for (const target of hintTargets) {
    const current = await readText(join(root, target)) ?? '';
    if (current.includes(AGENT_HINT_START)) continue;
    const separator = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    add(target, `${current}${separator}${AGENT_HINT}`);
  }

  if (packageRaw !== undefined) {
    const scripts = { ...packageJson.scripts };
    const servesPublicDir = PUBLIC_DIR_FRAMEWORKS.some((name) => name in dependencies);
    let changed = false;
    for (const [name, command] of SCRIPTS) {
      const existing = scripts[name];
      if (existing === undefined) {
        scripts[name] = servesPublicDir ? `${AUDIO_WORKLET_COMMAND} && ${command}` : command;
        changes.push(`package.json: add ${JSON.stringify(name)}: ${JSON.stringify(scripts[name])}`);
        changed = true;
        continue;
      }
      if (!existing.includes('glirastes tools refresh')) {
        notes.push(`package.json already has a ${name} script; add "${command}" to it.`);
      }
      // Chained in front, never replacing the developer's own step.
      if (servesPublicDir && !existing.includes(AUDIO_WORKLET_COMMAND)) {
        scripts[name] = `${AUDIO_WORKLET_COMMAND} && ${existing}`;
        changes.push(`package.json: ${JSON.stringify(name)}: ${JSON.stringify(existing)} -> ${JSON.stringify(scripts[name])}`);
        changed = true;
      }
    }
    // The copy is a build output: list it in an existing .gitignore, never create one.
    const gitignore = servesPublicDir ? await readText(join(root, '.gitignore')) : undefined;
    const ignored = gitignore === undefined ? undefined : withAudioWorkletGitignoreEntry(gitignore);
    if (ignored !== undefined) {
      add('.gitignore', ignored);
      changes.push(`.gitignore: add ${audioWorkletGitignoreEntry()}`);
    }
    if (!servesPublicDir && 'react' in dependencies) {
      notes.push(`Voice input needs the audio worklet served at /audio-worklet-processor.js: add "${AUDIO_WORKLET_COMMAND} --out <static folder>" to the script that builds the app.`);
    }
    if (changed) {
      add('package.json', `${JSON.stringify({ ...packageJson, scripts }, null, indentationOf(packageRaw))}\n`);
    }
  }

  if (!options.dryRun && writes.length > 0) {
    await mkdir(join(root, '.glirastes'), { recursive: true });
    // package.json and the agent instructions are the developer's own files:
    // the replacement keeps their permissions.
    await writeArtifactSetAtomically(writes.map((write) => ({
      path: join(root, write.path),
      content: write.content,
      preserveMode: true,
    })));
  }
  return { appId, written: writes.map((write) => write.path).sort(), notes, changes };
}

/**
 * The instruction files that carry the hint: the host's own file, plus the
 * others when they exist. A link (CLAUDE.md -> AGENTS.md) is followed so its
 * target gets the hint once.
 */
async function resolveHintTargets(
  root: string,
  files: ReadonlyArray<string>,
  hostFile: string | undefined,
): Promise<{ targets: Set<string>; notes: string[] }> {
  const targets = new Set<string>();
  const notes: string[] = [];
  // Compared against the real root, so a root reached through a link (macOS /var -> /private/var) still matches.
  const realRoot = existsSync(root) ? await realpath(root) : root;
  for (const file of files) {
    const absolute = join(root, file);
    if (!existsSync(absolute) && file !== hostFile) continue;
    const target = existsSync(absolute) ? relative(realRoot, await realpath(absolute)) : file;
    if (target.startsWith('..') || isAbsolute(target)) {
      notes.push(`${file} points outside the app; add the Glirastes tools hint there yourself.`);
      continue;
    }
    targets.add(target);
  }
  return { targets, notes };
}

const LF_BLOCK = AGENT_HINT.slice(0, AGENT_HINT.lastIndexOf(AGENT_HINT_END) + AGENT_HINT_END.length);

/**
 * The instruction text with the current Glirastes block (`glirastes install`):
 * every marker span that differs is replaced (compared without line-ending
 * differences, written in the file's own line ending), text outside the
 * markers stays byte for byte. A file without a block is returned unchanged;
 * a start marker without an end marker is left alone and counted.
 */
function withAgentHint(current: string): { text: string; unterminated: number } {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const block = LF_BLOCK.split('\n').join(eol);
  if (!current.includes(AGENT_HINT_START)) return { text: current, unterminated: 0 };
  let text = '';
  let cursor = 0;
  let unterminated = 0;
  for (;;) {
    const start = current.indexOf(AGENT_HINT_START, cursor);
    if (start < 0) break;
    const endMarker = current.indexOf(AGENT_HINT_END, start);
    if (endMarker < 0) { unterminated += 1; break; }
    const end = endMarker + AGENT_HINT_END.length;
    const same = current.slice(start, end).replace(/\r\n/g, '\n') === LF_BLOCK;
    text += current.slice(cursor, start) + (same ? current.slice(start, end) : block);
    cursor = end;
  }
  return { text: text + current.slice(cursor), unterminated };
}

/**
 * Brings existing Glirastes blocks in AGENTS.md / CLAUDE.md up to this SDK
 * (`glirastes install`, an explicit step; `tools refresh` never touches them).
 * Only the text between the markers changes; a file without the block is left
 * alone, init inserts it. Returns the changed app-relative files.
 */
export async function updateAgentHint(
  root: string,
  warn: (line: string) => void = (line) => { console.error(line); },
): Promise<string[]> {
  const { targets } = await resolveHintTargets(root, ['AGENTS.md', 'CLAUDE.md'], undefined);
  const writes: Array<{ path: string; content: string; preserveMode: true }> = [];
  for (const target of targets) {
    const current = await readText(join(root, target));
    if (current === undefined) continue;
    const next = withAgentHint(current);
    if (next.unterminated > 0) warn(`${target} has a "${AGENT_HINT_START}" marker without "${AGENT_HINT_END}"; the block was not updated there.`);
    if (next.text !== current) writes.push({ path: join(root, target), content: next.text, preserveMode: true });
  }
  if (writes.length > 0) await writeArtifactSetAtomically(writes);
  return writes.map((write) => relative(root, write.path)).sort();
}
