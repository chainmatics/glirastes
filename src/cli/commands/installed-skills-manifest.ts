import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { z } from 'zod';

/**
 * Where the manifest lives, relative to the consumer's project root.
 *
 * It sits under `.glirastes/` rather than beside the installed skills so that it
 * is host-independent and does not pollute the host's skill directory.
 */
export const MANIFEST_RELATIVE_PATH = '.glirastes/installed-skills.json';

export const InstalledSkillEntrySchema = z.object({
  /** Project-relative paths written for this skill. */
  files: z.array(z.string().min(1)),
  /** Hash of the skill directory as installed. */
  contentHash: z.string().min(1),
}).strict();

export const InstalledSkillsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.enum(['codex', 'claude', 'gemini']),
  /** Project-relative directory the skills were installed into. */
  target: z.string().min(1),
  mode: z.enum(['copy', 'symlink']),
  /** Version of the SDK that performed the install. */
  sdkVersion: z.string().min(1),
  skills: z.record(z.string().min(1), InstalledSkillEntrySchema),
}).strict();

export type InstalledSkillsManifest = z.infer<
  typeof InstalledSkillsManifestSchema
>;

/**
 * How an on-disk skill relates to what the manifest recorded.
 *
 * - `unchanged` — safe to upgrade silently.
 * - `modified` — the operator edited it; leave it alone unless forced.
 * - `missing` — recorded but no longer on disk.
 * - `unmanaged` — never installed by us; never touch it.
 */
export type InstalledSkillState =
  | 'unchanged'
  | 'modified'
  | 'missing'
  | 'unmanaged';

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

/**
 * Hash a skill directory so the result survives checkout differences that carry
 * no meaning: file order and line endings. A change the operator actually made
 * to the text still changes the hash.
 */
export async function hashSkillDirectory(dir: string): Promise<string> {
  const files = await collectFiles(dir);
  const entries = await Promise.all(files.map(async (absolute) => ({
    // Normalise separators so a manifest written on Windows matches one written
    // on macOS for the same content.
    path: relative(dir, absolute).split(sep).join(posix.sep),
    content: (await readFile(absolute, 'utf8')).replace(/\r\n/g, '\n'),
  })));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function writeInstalledSkillsManifest(
  rootDir: string,
  manifest: InstalledSkillsManifest,
): Promise<void> {
  const parsed = InstalledSkillsManifestSchema.parse(manifest);
  const absolute = join(rootDir, MANIFEST_RELATIVE_PATH);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/**
 * Read the manifest, or `null` when the project has none. A manifest that exists
 * but does not parse is an error: silently treating it as absent would let a
 * refresh overwrite skills it has no record of.
 */
export async function readInstalledSkillsManifest(
  rootDir: string,
): Promise<InstalledSkillsManifest | null> {
  const absolute = join(rootDir, MANIFEST_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
  return InstalledSkillsManifestSchema.parse(JSON.parse(raw));
}

export async function classifyInstalledSkill(
  rootDir: string,
  manifest: InstalledSkillsManifest | null,
  name: string,
): Promise<InstalledSkillState> {
  const entry = manifest?.skills[name];
  if (!manifest || !entry) return 'unmanaged';

  const dir = join(rootDir, manifest.target, name);
  let actual: string;
  try {
    actual = await hashSkillDirectory(dir);
  } catch {
    return 'missing';
  }
  return actual === entry.contentHash ? 'unchanged' : 'modified';
}
