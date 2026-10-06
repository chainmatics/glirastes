import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TOOLS_PATHS } from '../../codegen/tools/config.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { writeArtifactSetAtomically } from './atomic-artifact-write.js';

/**
 * What `glirastes init` writes deterministically before the coding agent
 * starts (spec 4.3, 4.6, 4.8): the tools configuration with the app id that
 * Platform pairing later adopts, the prompt bundle every refresh needs, the
 * predev/prebuild scripts and a short hint in the agent instructions.
 * Existing files and scripts are never replaced.
 */
export interface InitScaffold {
  /** The one app id of this app; tool ids derive from it. */
  appId: string;
  /** App-relative files init writes (or would write in a dry run). */
  written: string[];
  /** What the developer or the agent still has to do by hand. */
  notes: string[];
}

export const AGENT_HINT_START = '<!-- glirastes:tools -->';
const AGENT_HINT = [
  AGENT_HINT_START,
  '## Glirastes tools',
  '',
  'After changing API routes, pages, URL filters or client actions, run `glirastes tools refresh`.',
  'Work through `glirastes tools resolve --print` (skill `maintaining-glirastes-tools`) and',
  '`glirastes tools describe --print` (skill `describing-glirastes-tools`), then run',
  '`glirastes tools refresh` and `glirastes tools eval` again and commit `.glirastes` with the code.',
  'Never edit `.glirastes/tool-policy.json` or generated files yourself; Glirastes never calls a model.',
  '<!-- /glirastes:tools -->',
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
      notes.push('No Next.js app: integrating-glirastes-web describes .glirastes/tools.json for this stack.');
    }
  }
  if (!existsSync(join(root, TOOLS_PATHS.promptBundle))) {
    add(TOOLS_PATHS.promptBundle, `${JSON.stringify(promptBundle(appId, key), null, 2)}\n`);
  }

  // The host's instruction file, plus the other one when it exists; a link
  // (CLAUDE.md -> AGENTS.md) is followed so its target gets the hint once.
  const hostFile = options.host === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const hintTargets = new Set<string>();
  for (const file of [hostFile, 'AGENTS.md', 'CLAUDE.md']) {
    const absolute = join(root, file);
    if (!existsSync(absolute) && file !== hostFile) continue;
    const target = existsSync(absolute) ? relative(root, await realpath(absolute)) : file;
    if (target.startsWith('..') || isAbsolute(target)) {
      notes.push(`${file} points outside the app; add the Glirastes tools hint there yourself.`);
      continue;
    }
    hintTargets.add(target);
  }
  for (const target of hintTargets) {
    const current = await readText(join(root, target)) ?? '';
    if (current.includes(AGENT_HINT_START)) continue;
    const separator = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    add(target, `${current}${separator}${AGENT_HINT}`);
  }

  if (packageRaw !== undefined) {
    const scripts = { ...packageJson.scripts };
    let changed = false;
    for (const [name, command] of SCRIPTS) {
      const existing = scripts[name];
      if (existing === undefined) {
        scripts[name] = command;
        changed = true;
      } else if (!existing.includes('glirastes tools refresh')) {
        notes.push(`package.json already has a ${name} script; add "${command}" to it.`);
      }
    }
    if (changed) {
      add('package.json', `${JSON.stringify({ ...packageJson, scripts }, null, indentationOf(packageRaw))}\n`);
    }
  }

  if (!options.dryRun && writes.length > 0) {
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeArtifactSetAtomically(writes.map((write) => ({ path: join(root, write.path), content: write.content })));
  }
  return { appId, written: writes.map((write) => write.path).sort(), notes };
}
