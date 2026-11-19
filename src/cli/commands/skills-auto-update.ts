import { lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { SDK_VERSION } from '../../runtime/sdk-version.js';
import {
  HOST_SKILL_TARGETS,
  copyDirRecursive,
  findPackageSkillsDir,
  listAvailableSkills,
  listSkillFiles,
  pathExists,
  removeAtomic,
} from './install-skills.js';
import {
  hashSkillDirectory,
  readInstalledSkillsManifest,
  writeInstalledSkillsManifest,
  type InstallHost,
  type InstalledHostRecord,
  type InstalledSkillsManifest,
} from './installed-skills-manifest.js';
import { ensureBaseline } from './upgrade/baseline.js';
import { selectionOfInstalledSkills } from './installer-parts.js';

/** `GLIRASTES_SKILLS_AUTO_UPDATE=0` keeps `tools refresh` and `tools check` away from the installed skills. */
export const SKILLS_AUTO_UPDATE_ENV = 'GLIRASTES_SKILLS_AUTO_UPDATE';

export function skillsAutoUpdateDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[SKILLS_AUTO_UPDATE_ENV]?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off' || value === 'no';
}

export type SkillChangeKind = 'refresh' | 'add' | 'remove';

export interface SkillChange {
  host: InstallHost;
  name: string;
  kind: SkillChangeKind;
  mode: InstalledHostRecord['mode'];
}

/** An edited copy the update leaves alone although the SDK ships different content. */
export interface KeptSkill {
  host: InstallHost;
  name: string;
  /** `behind`: still shipped, edited; `unshipped`: the SDK dropped it, the edited copy stays as the app's own skill. */
  reason: 'behind' | 'unshipped';
}

export interface SkillsUpdatePlan {
  fromVersion: string;
  sdkVersion: string;
  changes: SkillChange[];
  kept: KeptSkill[];
  /** Manifest after the update; equal to the current one when nothing is stale. */
  next: InstalledSkillsManifest;
  /** The update would rewrite `.glirastes/installed-skills.json`. */
  manifestChanged: boolean;
  /** Per host: how to replace edited copies by hand. */
  replaceCommands: Partial<Record<InstallHost, string>>;
}

export interface SkillsUpdateOptions {
  rootDir: string;
  /** Defaults to the skills shipped with this package. */
  skillsDir?: string;
  /** Defaults to SDK_VERSION. */
  sdkVersion?: string;
}

interface PlannedOp extends SkillChange {
  source?: string;
  dest: string;
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

async function shippedEntry(rootDir: string, dest: string, source: string, contentHash: string) {
  const prefix = toPosix(relative(rootDir, dest));
  const files = (await listSkillFiles(source, source)).map((file) => posix.join(prefix, file));
  return { files, contentHash };
}

async function isSymbolicLink(path: string): Promise<boolean> {
  return (await lstat(path)).isSymbolicLink();
}

async function hashOrNull(dir: string): Promise<string | null> {
  try {
    return await hashSkillDirectory(dir);
  } catch {
    return null;
  }
}

function replaceCommand(rootDir: string, record: InstalledHostRecord): string {
  const defaultTarget = HOST_SKILL_TARGETS[record.host].project;
  const target = resolve(rootDir, record.target) === resolve(rootDir, defaultTarget)
    ? ''
    : ` --target ${record.target}`;
  return `glirastes install --host ${record.host}${target}${record.mode === 'symlink' ? ' --symlink' : ''} --force`;
}

/** What `tools refresh` would do to the installed skills; reads only. `null` without a manifest. */
export async function planSkillsUpdate(options: SkillsUpdateOptions): Promise<SkillsUpdatePlan | null> {
  const rootDir = resolve(options.rootDir);
  const manifest = await readInstalledSkillsManifest(rootDir);
  if (!manifest) return null;
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const skillsDir = options.skillsDir ?? findPackageSkillsDir();
  const shipped = new Map((await listAvailableSkills(skillsDir)).map((skill) => [skill.name, skill.source]));
  const shippedHashes = new Map<string, string>();
  const shippedHash = async (name: string): Promise<string> => {
    let hash = shippedHashes.get(name);
    if (!hash) {
      hash = await hashSkillDirectory(shipped.get(name)!);
      shippedHashes.set(name, hash);
    }
    return hash;
  };

  const ops: PlannedOp[] = [];
  const kept: KeptSkill[] = [];
  const replaceCommands: SkillsUpdatePlan['replaceCommands'] = {};
  const installs: InstalledHostRecord[] = [];

  for (const record of manifest.installs) {
    const targetAbs = resolve(rootDir, record.target);
    const skills: InstalledHostRecord['skills'] = {};
    const op = (name: string, kind: SkillChangeKind, source?: string) => {
      ops.push({ host: record.host, name, kind, mode: record.mode, dest: join(targetAbs, name), ...(source ? { source } : {}) });
    };

    for (const [name, entry] of Object.entries(record.skills)) {
      const dest = join(targetAbs, name);
      const source = shipped.get(name);
      if (!(await pathExists(dest))) {
        // Deleted by the operator: never restored, forgotten once the SDK drops it too.
        if (source) skills[name] = entry;
        continue;
      }

      if (record.mode === 'symlink' && await isSymbolicLink(dest)) {
        // A link edits nothing of its own; it is current when it resolves to the shipped skill.
        if (!source) {
          op(name, 'remove');
          continue;
        }
        const linked = await realpath(dest).catch(() => null);
        const hash = await shippedHash(name);
        if (linked !== await realpath(source)) op(name, 'refresh', source);
        skills[name] = await shippedEntry(rootDir, dest, source, hash);
        continue;
      }

      const onDisk = await hashOrNull(dest);
      if (!source) {
        if (onDisk === entry.contentHash) op(name, 'remove');
        else kept.push({ host: record.host, name, reason: 'unshipped' });
        continue;
      }
      const hash = await shippedHash(name);
      if (onDisk === hash) {
        skills[name] = await shippedEntry(rootDir, dest, source, hash);
      } else if (onDisk === entry.contentHash) {
        op(name, 'refresh', source);
        skills[name] = await shippedEntry(rootDir, dest, source, hash);
      } else {
        // Edited: kept as is. Only an edit of an older version is behind.
        skills[name] = entry;
        if (entry.contentHash !== hash) {
          kept.push({ host: record.host, name, reason: 'behind' });
          replaceCommands[record.host] = replaceCommand(rootDir, record);
        }
      }
    }

    for (const name of selectionOfInstalledSkills(Object.keys(record.skills))) {
      const source = shipped.get(name);
      if (!source || name in record.skills) continue;
      const dest = join(targetAbs, name);
      // A folder glirastes never installed is not ours to replace.
      if (await pathExists(dest)) continue;
      op(name, 'add', source);
      skills[name] = await shippedEntry(rootDir, dest, source, await shippedHash(name));
    }

    if (Object.keys(skills).length > 0) {
      installs.push({ ...record, skills: Object.fromEntries(Object.entries(skills).sort(([a], [b]) => (a < b ? -1 : 1))) });
    }
  }

  const next: InstalledSkillsManifest = { schemaVersion: 1, sdkVersion, installs };
  const normalize = (value: InstalledSkillsManifest) => JSON.stringify({
    ...value,
    installs: value.installs.map((install) => ({
      ...install,
      skills: Object.fromEntries(Object.entries(install.skills).sort(([a], [b]) => (a < b ? -1 : 1))),
    })),
  });
  return {
    fromVersion: manifest.sdkVersion,
    sdkVersion,
    changes: ops,
    kept,
    next,
    manifestChanged: normalize(next) !== normalize(manifest),
    replaceCommands,
  };
}

/** Apply a plan: replace, add and remove unedited skills, then write the manifest. Never prompts. */
export async function applySkillsUpdate(rootDir: string, plan: SkillsUpdatePlan): Promise<void> {
  for (const change of plan.changes as PlannedOp[]) {
    if (change.kind !== 'add') await removeAtomic(change.dest);
    if (change.kind === 'remove') continue;
    await mkdir(resolve(change.dest, '..'), { recursive: true });
    if (change.mode === 'symlink') await symlink(change.source!, change.dest, 'dir');
    else await copyDirRecursive(change.source!, change.dest);
  }
  // The first auto-update of an app that never had a baseline: what it last
  // reviewed is what the skills were installed for, before the manifest moves on.
  if (plan.fromVersion) await ensureBaseline(resolve(rootDir), plan.fromVersion);
  if (plan.manifestChanged) await writeInstalledSkillsManifest(resolve(rootDir), plan.next);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function keptNames(kept: ReadonlyArray<KeptSkill>): string {
  const byHost = new Map<InstallHost, string[]>();
  for (const skill of kept) byHost.set(skill.host, [...(byHost.get(skill.host) ?? []), skill.name]);
  return [...byHost].map(([host, names]) => `${host}: ${names.join(', ')}`).join('; ');
}

/** Lines `tools refresh` prints after an update; empty when there was nothing to say. */
export function formatSkillsUpdate(plan: SkillsUpdatePlan): string[] {
  const lines: string[] = [];
  const count = (kind: SkillChangeKind) => plan.changes.filter((change) => change.kind === kind).length;
  const behind = plan.kept.filter((skill) => skill.reason === 'behind');
  const unshipped = plan.kept.filter((skill) => skill.reason === 'unshipped');
  if (plan.manifestChanged || plan.changes.length > 0) {
    const parts = [
      count('refresh') > 0 ? `${count('refresh')} refreshed` : '',
      count('add') > 0 ? `${count('add')} added` : '',
      count('remove') > 0 ? `${count('remove')} removed` : '',
    ].filter(Boolean);
    const keptText = behind.length > 0
      ? `${parts.length > 0 ? ', ' : ''}${plural(behind.length, 'edited copy', 'edited copies')} kept (${keptNames(behind)})`
      : '';
    lines.push(`Skills updated to ${plan.sdkVersion}: ${parts.length > 0 || keptText ? `${parts.join(', ')}${keptText}` : 'all current'}.`);
  } else if (behind.length > 0) {
    lines.push(`Skills at ${plan.sdkVersion}: ${plural(behind.length, 'edited copy', 'edited copies')} kept at an older version (${keptNames(behind)}).`);
  }
  if (behind.length > 0) {
    const commands = [...new Set(Object.values(plan.replaceCommands))].join(' or ');
    lines.push(`  Edited skills are never overwritten: merge the update from node_modules/glirastes/skills/<name>, or replace them with ${commands}.`);
  }
  if (unshipped.length > 0) {
    lines.push(`  No longer shipped, kept because edited: ${keptNames(unshipped)}. They are now the app's own skills.`);
  }
  return lines;
}

export interface SkillsStaleness {
  /** Unedited copies or the manifest are behind this SDK: `tools refresh` would write. */
  stale: boolean;
  lines: string[];
  warnings: string[];
}

/** Read-only verdict for `tools check` and `doctor`; `null` without a manifest. */
export async function inspectSkillsStaleness(options: SkillsUpdateOptions): Promise<SkillsStaleness | null> {
  const plan = await planSkillsUpdate(options);
  if (!plan) return null;
  const lines: string[] = [];
  const warnings: string[] = [];
  const copyChanges = plan.changes.filter((change) => change.mode === 'copy');
  const linkChanges = plan.changes.filter((change) => change.mode === 'symlink');
  if (plan.manifestChanged) {
    const names = copyChanges.map((change) => `${change.name} (${change.kind})`);
    const version = plan.fromVersion !== plan.sdkVersion ? ` (recorded for ${plan.fromVersion})` : '';
    lines.push(`Installed skills are out of date with glirastes ${plan.sdkVersion}${version}`
      + `${names.length > 0 ? `: ${names.join(', ')}` : ''}. Run glirastes tools refresh and commit `
      + '.glirastes/installed-skills.json with the skill folders.');
  }
  if (linkChanges.length > 0) {
    warnings.push(`Symlinked skills do not resolve to this SDK (${linkChanges.map((change) => change.name).join(', ')}); `
      + 'glirastes tools refresh relinks them on a developer machine.');
  }
  const behind = plan.kept.filter((skill) => skill.reason === 'behind');
  if (behind.length > 0) {
    warnings.push(`Edited skills differ from glirastes ${plan.sdkVersion} and are kept (${keptNames(behind)}); `
      + `merge the update or replace them with ${[...new Set(Object.values(plan.replaceCommands))].join(' or ')}.`);
  }
  return { stale: plan.manifestChanged, lines, warnings };
}
