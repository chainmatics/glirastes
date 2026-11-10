import { mkdir, readdir, copyFile, readFile, stat, symlink, lstat, unlink, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colors, header, separator } from '../../codegen/format.js';
import {
  classifyInstalledSkill,
  hashSkillDirectory,
  hostRecord,
  readInstalledSkillsManifest,
  withHostRecord,
  writeInstalledSkillsManifest,
  type InstallHost,
  type InstalledHostRecord,
} from './installed-skills-manifest.js';
import {
  detectStack,
  proposeParts,
  resolvePartSkills,
  type InstallerPart,
} from './installer-parts.js';

export interface InstallSkillsOptions {
  /** Where to install; overrides the selected host's project/global default. */
  target?: string;
  /** Install into the selected host's user directory. Mutually exclusive with `target`. */
  global?: boolean;
  /** A single local agent host. Kept for callers that only serve one. */
  host?: InstallHost;
  /**
   * Several local agent hosts at once. Each gets its own directory and its own
   * manifest record; installing for one never disturbs another.
   */
  hosts?: ReadonlyArray<InstallHost>;
  /** Explicit consent to include the optional local setup skill. */
  includeSetupSkills?: boolean;
  /**
   * Which parts to install. Omitted, the selection is derived from the
   * project's detected stack. This is an argument, not a command-line flag:
   * the wizard asks and passes the answer here.
   */
  parts?: ReadonlyArray<InstallerPart>;
  /** Use symlinks instead of copying — auto-updates with the SDK on `npm install` */
  symlink?: boolean;
  /** Overwrite existing skill directories at the target */
  force?: boolean;
  /** Print what would happen without writing anything */
  dryRun?: boolean;
  /** Project root — defaults to cwd */
  rootDir?: string;
  /** Suppress installer progress when embedded in a machine-readable workflow. */
  quiet?: boolean;
}

interface SkillDescriptor {
  name: string;
  /** Source absolute path (where the skill lives in this package) */
  source: string;
}

const HOST_SKILL_TARGETS = {
  codex: {
    project: '.agents/skills',
    global: join(homedir(), '.agents', 'skills'),
  },
  claude: {
    project: '.claude/skills',
    global: join(homedir(), '.claude', 'skills'),
  },
  gemini: {
    project: '.gemini/skills',
    global: join(homedir(), '.gemini', 'skills'),
  },
} as const;

/** Project-relative paths of every file written for one installed skill. */
async function listSkillFiles(
  rootDir: string,
  skillDir: string,
): Promise<string[]> {
  const entries = await readdir(skillDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(skillDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSkillFiles(rootDir, absolute));
    } else if (entry.isFile()) {
      files.push(relative(rootDir, absolute).split(sep).join(posix.sep));
    }
  }
  return files.sort();
}

/** Version of the glirastes package these skills came from. */
async function readSdkVersion(): Promise<string> {
  const manifestPath = join(findPackageSkillsDir(), '..', 'package.json');
  try {
    const parsed = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as { version?: string };
    return parsed.version?.trim() || '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

/**
 * Locate the `skills/` directory shipped with this package.
 * Walks up from this module's location until a `skills/` sibling is found.
 */
export function findPackageSkillsDir(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'skills');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the bundled 'skills/' directory. Reinstall glirastes or check your node_modules.",
  );
}

async function listAvailableSkills(skillsDir: string): Promise<SkillDescriptor[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(skillsDir, entry.name);
    const skillFile = join(source, 'SKILL.md');
    try {
      const stats = await stat(skillFile);
      if (!stats.isFile()) continue;
    } catch {
      continue;
    }
    skills.push({ name: entry.name, source });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function removeAtomic(target: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink() || info.isFile()) {
    await unlink(target);
  } else {
    await rm(target, { recursive: true, force: true });
  }
}

function dim(text: string): string {
  return `${colors.dim}${text}${colors.reset}`;
}
function tag(color: string, label: string): string {
  return `${color}${label}${colors.reset}`;
}

export async function installSkills(opts: InstallSkillsOptions): Promise<void> {
  const log = opts.quiet ? (_message?: string) => {} : console.log;
  if (opts.includeSetupSkills && !opts.host && !opts.hosts?.length) {
    throw new Error(
      'Choose at least one setup host: codex, claude, or gemini.',
    );
  }
  if (opts.global && opts.target) {
    throw new Error(
      'Pass either --global or --target, not both.',
    );
  }

  const rootDir = resolve(opts.rootDir ?? process.cwd());
  const hosts = resolveHosts(opts);
  if (opts.target && hosts.length > 1) {
    throw new Error(
      'Pass --target with a single host; several hosts each need their own '
      + 'directory.',
    );
  }
  const skillsDir = findPackageSkillsDir();

  // Callers either name the parts, or get the selection derived from the
  // project. There is no flag for this — the wizard asks.
  const stackContext = await detectStack(rootDir);
  const parts: InstallerPart[] = opts.parts
    ? [...opts.parts]
    : proposeParts(stackContext);
  if (opts.includeSetupSkills && !parts.includes('setup')) {
    parts.push('setup');
  }
  const allowList = resolvePartSkills(parts, { stack: stackContext });

  const available = await listAvailableSkills(skillsDir);
  const selected = available.filter((s) => allowList.includes(s.name));

  if (selected.length === 0) {
    throw new Error(
      `No skills resolved from parts: ${parts.join(', ')}. Available: ${available.map((s) => s.name).join(', ')}`,
    );
  }

  log(header('Install Glirastes agent skills'));
  log(`  ${dim('Source:')}  ${relative(rootDir, skillsDir) || skillsDir}`);
  log(`  ${dim('Hosts:')}   ${hosts.join(', ')}`);
  log(`  ${dim('Parts:')}   ${parts.join(', ')}`);
  log(
    `  ${dim('Mode:')}    ${opts.symlink ? 'symlink' : 'copy'}${opts.dryRun ? ' (dry run)' : ''}`,
  );
  log('');

  let installed = 0;
  let skipped = 0;
  let overwritten = 0;
  let manifest = await readInstalledSkillsManifest(rootDir);
  const sdkVersion = await readSdkVersion();

  for (const host of hosts) {
    const hostTargets = HOST_SKILL_TARGETS[host];
    const defaultTarget = opts.global ? hostTargets.global : hostTargets.project;
    const targetSpec = opts.target ?? defaultTarget;
    // Treat absolute paths and `~`-prefixed paths verbatim; resolve relative paths against rootDir.
    const expanded = targetSpec.startsWith('~/') ? join(homedir(), targetSpec.slice(2)) : targetSpec;
    const targetAbs = resolve(rootDir, expanded);

    if (hosts.length > 1) {
      log(
        `  ${colors.bold}${host}${colors.reset} ${dim(relative(rootDir, targetAbs) || targetAbs)}`,
      );
    } else {
      log(
        `  ${dim('Target:')}  ${relative(rootDir, targetAbs) || targetAbs}` +
          (opts.global ? dim(' (global)') : ''),
      );
    }

    if (!opts.dryRun) {
      await mkdir(targetAbs, { recursive: true });
    }

    const recorded: InstalledHostRecord['skills'] = {};
    const previousForHost = hostRecord(manifest, host);

    for (const skill of selected) {
      const dest = join(targetAbs, skill.name);
      const exists = await pathExists(dest);
      const state = exists
        ? await classifyInstalledSkill(rootDir, manifest, host, skill.name)
        : 'missing';

      // A skill we installed and nobody touched is ours to upgrade. One the
      // operator edited, or one we never installed, is not — say so and move on.
      if (exists && state !== 'unchanged' && !opts.force) {
        const reason = state === 'modified'
          ? 'edited since install; use --force to replace it'
          : 'not installed by glirastes; use --force to replace it';
        log(
          `  ${tag(colors.yellow, 'skip')}     ${skill.name} ${dim(`(${reason})`)}`,
        );
        skipped += 1;
        // Carry the previous record forward so a skip does not drop the skill
        // out of the manifest.
        const carried = previousForHost?.skills[skill.name];
        if (carried) recorded[skill.name] = carried;
        continue;
      }

      if (opts.dryRun) {
        const verb = exists ? 'overwrite' : 'install';
        log(
          `  ${tag(colors.cyan, 'would ' + verb)} ${skill.name} ${dim(opts.symlink ? '(symlink)' : '(copy)')}`,
        );
        if (exists) overwritten += 1;
        else installed += 1;
        continue;
      }

      if (exists) {
        await removeAtomic(dest);
        overwritten += 1;
        if (state === 'unchanged') {
          log(
            `  ${tag(colors.cyan, 'refresh')}  ${skill.name} ${dim('(unchanged since install)')}`,
          );
        } else {
          log(
            `  ${tag(colors.yellow, 'replace')}  ${skill.name} ${dim(`(was ${state}; --force)`)}`,
          );
        }
      } else {
        installed += 1;
      }

      if (opts.symlink) {
        await symlink(skill.source, dest, 'dir');
        log(`  ${tag(colors.green, 'symlink')}  ${skill.name}`);
      } else {
        await copyDirRecursive(skill.source, dest);
        log(`  ${tag(colors.green, 'copied')}   ${skill.name}`);
      }

      recorded[skill.name] = {
        files: await listSkillFiles(rootDir, dest),
        contentHash: await hashSkillDirectory(dest),
      };
    }

    // Record per host, so installing for one never erases what another has.
    if (!opts.dryRun && Object.keys(recorded).length > 0) {
      manifest = withHostRecord(manifest, {
        host,
        target: relative(rootDir, targetAbs) || '.',
        mode: opts.symlink ? 'symlink' : 'copy',
        skills: recorded,
      }, sdkVersion);
      await writeInstalledSkillsManifest(rootDir, manifest);
    }
  }

  log('');
  log(separator());
  log(
    `  ${colors.bold}Result:${colors.reset} ${installed} installed, ${overwritten} overwritten, ${skipped} skipped` +
      (opts.dryRun ? dim(' (dry run — no files written)') : ''),
  );

  if (skipped > 0 && !opts.force) {
    log('');
    log(`  ${dim('Re-run with --force to overwrite skipped skills.')}`);
  }
}

/** One host stays the default; `hosts` accepts several without repeating work. */
function resolveHosts(opts: InstallSkillsOptions): InstallHost[] {
  const requested = opts.hosts ?? (opts.host ? [opts.host] : []);
  const unique = [...new Set(requested)];
  if (unique.length === 0) return ['claude'];
  return unique;
}
