import { mkdir, readdir, copyFile, stat, symlink, lstat, unlink, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colors, header, separator } from '../../codegen/format.js';

export interface InstallSkillsOptions {
  /** Where to install (default `.claude/skills`, or `~/.claude/skills` if `global` is set) */
  target?: string;
  /** Install into the user's home (`~/.claude/skills`) instead of the project. Mutually exclusive with `target`. */
  global?: boolean;
  /** Stack filter — only install skills relevant to this stack */
  stack?: 'nextjs' | 'nestjs' | 'nextjs+nestjs' | 'all';
  /** Use symlinks instead of copying — auto-updates with the SDK on `npm install` */
  symlink?: boolean;
  /** Overwrite existing skill directories at the target */
  force?: boolean;
  /** Print what would happen without writing anything */
  dryRun?: boolean;
  /** Project root — defaults to cwd */
  rootDir?: string;
}

interface SkillDescriptor {
  name: string;
  /** Source absolute path (where the skill lives in this package) */
  source: string;
}

const STACK_SKILL_MAP: Record<string, ReadonlyArray<string>> = {
  nextjs: [
    'integrating-glirastes-nextjs',
    'maintaining-glirastes-tools',
    'building-glirastes-chat-ui',
  ],
  nestjs: [
    'integrating-glirastes-nestjs',
    'maintaining-glirastes-tools',
    'building-glirastes-chat-ui',
  ],
  'nextjs+nestjs': [
    'integrating-glirastes-nextjs-with-nestjs-backend',
    'integrating-glirastes-nestjs',
    'maintaining-glirastes-tools',
    'building-glirastes-chat-ui',
  ],
  all: [
    'integrating-glirastes-nextjs',
    'integrating-glirastes-nestjs',
    'integrating-glirastes-nextjs-with-nestjs-backend',
    'maintaining-glirastes-tools',
    'building-glirastes-chat-ui',
  ],
};

/**
 * Locate the `skills/` directory shipped with this package.
 * Walks up from this module's location until a `skills/` sibling is found.
 */
function findPackageSkillsDir(): string {
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
  if (opts.global && opts.target) {
    throw new Error(
      "Pass either --global or --target, not both. --global writes to '~/.claude/skills'; --target overrides the destination.",
    );
  }

  const rootDir = resolve(opts.rootDir ?? process.cwd());
  const defaultTarget = opts.global ? join(homedir(), '.claude', 'skills') : '.claude/skills';
  const targetSpec = opts.target ?? defaultTarget;
  // Treat absolute paths and `~`-prefixed paths verbatim; resolve relative paths against rootDir.
  const expanded = targetSpec.startsWith('~/') ? join(homedir(), targetSpec.slice(2)) : targetSpec;
  const targetAbs = resolve(rootDir, expanded);
  const skillsDir = findPackageSkillsDir();
  const stack = opts.stack ?? 'all';
  const allowList = STACK_SKILL_MAP[stack];
  if (!allowList) {
    throw new Error(
      `Unknown --stack value: '${stack}'. Use one of: nextjs | nestjs | nextjs+nestjs | all.`,
    );
  }

  const available = await listAvailableSkills(skillsDir);
  const selected = available.filter((s) => allowList.includes(s.name));

  if (selected.length === 0) {
    throw new Error(
      `No matching skills found for --stack=${stack}. Available: ${available.map((s) => s.name).join(', ')}`,
    );
  }

  console.log(header('Install Glirastes agent skills'));
  console.log(`  ${dim('Source:')}  ${relative(rootDir, skillsDir) || skillsDir}`);
  console.log(
    `  ${dim('Target:')}  ${relative(rootDir, targetAbs) || targetAbs}` +
      (opts.global ? dim(' (global, ~/.claude/skills)') : ''),
  );
  console.log(`  ${dim('Stack:')}   ${stack}`);
  console.log(
    `  ${dim('Mode:')}    ${opts.symlink ? 'symlink' : 'copy'}${opts.dryRun ? ' (dry run)' : ''}`,
  );
  console.log('');

  if (!opts.dryRun) {
    await mkdir(targetAbs, { recursive: true });
  }

  let installed = 0;
  let skipped = 0;
  let overwritten = 0;

  for (const skill of selected) {
    const dest = join(targetAbs, skill.name);
    const exists = await pathExists(dest);

    if (exists && !opts.force) {
      console.log(
        `  ${tag(colors.yellow, 'skip')}     ${skill.name} ${dim('(exists; use --force to overwrite)')}`,
      );
      skipped += 1;
      continue;
    }

    if (opts.dryRun) {
      const verb = exists ? 'overwrite' : 'install';
      console.log(
        `  ${tag(colors.cyan, 'would ' + verb)} ${skill.name} ${dim(opts.symlink ? '(symlink)' : '(copy)')}`,
      );
      if (exists) overwritten += 1;
      else installed += 1;
      continue;
    }

    if (exists && opts.force) {
      await removeAtomic(dest);
      overwritten += 1;
    } else {
      installed += 1;
    }

    if (opts.symlink) {
      await symlink(skill.source, dest, 'dir');
      console.log(`  ${tag(colors.green, 'symlink')}  ${skill.name}`);
    } else {
      await copyDirRecursive(skill.source, dest);
      console.log(`  ${tag(colors.green, 'copied')}   ${skill.name}`);
    }
  }

  console.log('');
  console.log(separator());
  console.log(
    `  ${colors.bold}Result:${colors.reset} ${installed} installed, ${overwritten} overwritten, ${skipped} skipped` +
      (opts.dryRun ? dim(' (dry run — no files written)') : ''),
  );

  if (skipped > 0 && !opts.force) {
    console.log('');
    console.log(`  ${dim('Re-run with --force to overwrite skipped skills.')}`);
  }
}
