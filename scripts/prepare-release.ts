/**
 * Prepares a release commit: merges every `upgrade-notes/unreleased/*.json`
 * into `upgrade-notes/<version>.json` as `{ version, notes }`, deletes the
 * merged files (`.gitkeep` stays), refreshes
 * `upgrade-notes/api-surface.released.json` and bumps the version in
 * `package.json` and `src/runtime/sdk-version.ts`.
 *
 *   bun run release:prepare <version>
 *
 * Refuses, and changes nothing, on a dirty Git tree, a version that is not
 * semver, an invalid unreleased note, or an existing `<version>.json` that
 * already holds notes. Everything is checked before the first write.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { UpgradeNoteSchema, compareVersions, isSemver, type UpgradeNote } from '../src/cli/commands/upgrade/notes.js';
import { computeApiSurface } from './api-surface.js';

export class PrepareReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareReleaseError';
  }
}

type Surface = (root: string) => Promise<string[]>;

export interface PrepareReleaseOptions {
  root: string;
  version: string;
  /** Computes the public API surface; the real one by default (tests pass a fake). */
  surface?: Surface;
}

const SURFACE_FILE = join('upgrade-notes', 'api-surface.released.json');
const SDK_VERSION_FILE = join('src', 'runtime', 'sdk-version.ts');
const SDK_VERSION_RE = /export const SDK_VERSION = '[^']*';/;
const PKG_VERSION_RE = /("version"\s*:\s*)"[^"]*"/;

function gitStatus(root: string): string {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  } catch (cause) {
    throw new PrepareReleaseError(`Cannot read the Git status of ${root}: ${(cause as Error).message}`);
  }
}

async function readNotesFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (cause) {
    throw new PrepareReleaseError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }
}

export async function prepareRelease(options: PrepareReleaseOptions): Promise<{ notesFile: string; merged: string[] }> {
  const { root, version } = options;
  const surface = options.surface ?? computeApiSurface;
  if (!isSemver(version)) {
    throw new PrepareReleaseError(`'${version}' is not a semver version (e.g. 0.19.0 or 0.19.0-rc.1, without a leading v).`);
  }
  if (gitStatus(root).trim() !== '') {
    throw new PrepareReleaseError('The working tree has uncommitted changes; commit or stash them first.');
  }

  const pkgPath = join(root, 'package.json');
  const pkg = await readFile(pkgPath, 'utf8');
  const current = (JSON.parse(pkg) as { version?: unknown }).version;
  if (typeof current !== 'string' || !PKG_VERSION_RE.test(pkg) || !isSemver(current)) {
    throw new PrepareReleaseError('package.json has no semver "version" field.');
  }
  if (compareVersions(version, current) <= 0) {
    throw new PrepareReleaseError(`${version} is not above the current version ${current}.`);
  }

  const notesDir = join(root, 'upgrade-notes');
  const notesFile = join(notesDir, `${version}.json`);
  if (existsSync(notesFile)) {
    const parsed = z
      .object({ version: z.literal(version), notes: z.array(UpgradeNoteSchema) })
      .strict()
      .safeParse(await readNotesFile(notesFile));
    if (!parsed.success) {
      throw new PrepareReleaseError(`upgrade-notes/${version}.json is not a valid notes file for ${version}; fix or delete it.`);
    }
    if (parsed.data.notes.length > 0) {
      throw new PrepareReleaseError(`upgrade-notes/${version}.json already holds notes; this version looks released.`);
    }
  }

  const unreleasedDir = join(notesDir, 'unreleased');
  const files = existsSync(unreleasedDir)
    ? (await readdir(unreleasedDir)).filter((file) => file.endsWith('.json')).sort()
    : [];
  const notes: UpgradeNote[] = [];
  for (const file of files) {
    const rel = `upgrade-notes/unreleased/${file}`;
    const parsed = UpgradeNoteSchema.safeParse(await readNotesFile(join(unreleasedDir, file)));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      throw new PrepareReleaseError(`${rel} is not a valid upgrade note (${issues.join('; ')}).`);
    }
    if (notes.some((note) => note.id === parsed.data.id)) {
      throw new PrepareReleaseError(`${rel} repeats the note id "${parsed.data.id}".`);
    }
    notes.push(parsed.data);
  }
  notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const sdkVersionPath = join(root, SDK_VERSION_FILE);
  const sdkVersionSource = existsSync(sdkVersionPath) ? await readFile(sdkVersionPath, 'utf8') : '';
  if (!SDK_VERSION_RE.test(sdkVersionSource)) {
    throw new PrepareReleaseError(`${SDK_VERSION_FILE} has no "export const SDK_VERSION = '…';" line.`);
  }
  const keys = await surface(root);

  // Every check passed: write.
  await writeFile(notesFile, `${JSON.stringify({ version, notes }, null, 2)}\n`);
  for (const file of files) await unlink(join(unreleasedDir, file));
  await writeFile(join(root, SURFACE_FILE), `${JSON.stringify(keys, null, 2)}\n`);
  await writeFile(pkgPath, pkg.replace(PKG_VERSION_RE, `$1"${version}"`));
  await writeFile(sdkVersionPath, sdkVersionSource.replace(SDK_VERSION_RE, `export const SDK_VERSION = '${version}';`));
  return { notesFile, merged: notes.map((note) => note.id) };
}

/**
 * Compares the committed `api-surface.released.json` with the surface of the
 * current source. Returns `+ key` / `- key` lines; empty when they match.
 */
export async function checkApiSurface(options: { root: string; surface?: Surface }): Promise<string[]> {
  const surface = options.surface ?? computeApiSurface;
  const released = JSON.parse(await readFile(join(options.root, SURFACE_FILE), 'utf8')) as string[];
  const current = await surface(options.root);
  const before = new Set(released);
  const now = new Set(current);
  return [
    ...current.filter((key) => !before.has(key)).map((key) => `+ ${key}`),
    ...released.filter((key) => !now.has(key)).map((key) => `- ${key}`),
  ];
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const version = process.argv[2];
  if (version === undefined || process.argv.length > 3) {
    console.error('Usage: bun run release:prepare <version>');
    process.exit(2);
  }
  try {
    const { notesFile, merged } = await prepareRelease({ root, version });
    console.log(`Wrote ${notesFile} (${merged.length} note(s): ${merged.join(', ') || 'none'}).`);
    console.log(`Refreshed ${SURFACE_FILE} and set the version to ${version} in package.json and ${SDK_VERSION_FILE}.`);
    console.log('Next: update CHANGELOG.md, run the gate, then commit everything in one release commit.');
  } catch (error) {
    if (!(error instanceof PrepareReleaseError)) throw error;
    console.error(`release:prepare: ${error.message} Nothing was changed.`);
    process.exit(1);
  }
}
