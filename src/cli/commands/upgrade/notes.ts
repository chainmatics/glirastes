import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const UPGRADE_NOTE_KINDS = [
  'breaking',
  'deprecated',
  'recommended',
  'optional',
] as const;

export type UpgradeNoteKind = (typeof UPGRADE_NOTE_KINDS)[number];

const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
/** Semantic version 2.0.0, prerelease and build metadata included (e.g. `0.19.0-rc.1`). */
export const SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
);

export function isSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

const patternSchema = z.string().refine(
  (src) => {
    try {
      new RegExp(src, 'm');
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid regular expression' },
);

const DetectSchema = z
  .object({
    imports: z.array(z.string().min(1)).optional(),
    symbols: z.array(z.string().min(1)).optional(),
    patterns: z.array(patternSchema).optional(),
  })
  .strict()
  .refine(
    (d) => [d.imports, d.symbols, d.patterns].some((a) => a !== undefined && a.length > 0),
    { message: 'Detect must contain at least one non-empty imports, symbols or patterns list' },
  );

export type Detect = z.infer<typeof DetectSchema>;

/**
 * A `surface` entry names the API-surface keys a note covers
 * (`<subpath>#<Name>` or `<subpath>#<Type>.<member>`, see scripts/api-surface.ts):
 * - exact: `glirastes/react#ComposerConfig` covers only that key;
 * - trailing `.*`: `glirastes/react#ComposerConfig.*` covers `ComposerConfig`
 *   and every `ComposerConfig.<member>`, never `ComposerConfigX`;
 * - `*` subpath: `*#ComposerConfig.*` covers that symbol in every subpath (one
 *   type re-exported from `glirastes/server/http`, `/server/nextjs`, …).
 * No other wildcard: `Composer*` or `glirastes/*#X` are rejected.
 */
const SURFACE_ENTRY_RE = /^(?:\*|[^*#\s]+)#[^*#\s]+(?:\.\*)?$/;

export function surfaceCovers(entry: string, key: string): boolean {
  const hash = entry.indexOf('#');
  const keyHash = key.indexOf('#');
  if (hash < 0 || keyHash < 0) return entry === key;
  const subpath = entry.slice(0, hash);
  if (subpath !== '*' && subpath !== key.slice(0, keyHash)) return false;
  const symbol = entry.slice(hash + 1);
  const keySymbol = key.slice(keyHash + 1);
  if (!symbol.endsWith('.*')) return keySymbol === symbol;
  const base = symbol.slice(0, -2);
  return keySymbol === base || keySymbol.startsWith(`${base}.`);
}

export const UpgradeNoteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    kind: z.enum(UPGRADE_NOTE_KINDS),
    summary: z.string().min(1).max(300),
    howTo: z.string().min(1).max(2000),
    skill: z.string().regex(/^[a-z0-9][a-z0-9-]*(#[A-Za-z0-9][A-Za-z0-9_.-]*)?$/),
    affectedWhen: DetectSchema.optional(),
    adoptedWhen: DetectSchema.optional(),
    // Only keys added or removed since api-surface.released.json (the snapshot is name-level);
    // a changed signature of an existing key is described in `howTo`.
    surface: z
      .array(
        z.string().regex(SURFACE_ENTRY_RE, {
          message: 'Surface entry must be <subpath>#<Name>, optionally ending in .* or with * as the subpath',
        }),
      )
      .optional(),
  })
  .strict();

export type UpgradeNote = z.infer<typeof UpgradeNoteSchema>;

const ReleasedFileSchema = z
  .object({
    version: z.string().regex(SEMVER_RE),
    notes: z.array(UpgradeNoteSchema),
  })
  .strict();

const IGNORED_JSON = new Set(['api-surface.released.json']);

export class UpgradeNotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeNotesError';
  }
}

function describeIssues(file: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path
      .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${String(p)}`))
      .join('');
    return `${file}: ${path || '(root)'}: ${issue.message}`;
  });
  return `Invalid upgrade note. ${lines.join('; ')}`;
}

async function readJson(path: string, file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new UpgradeNotesError(
      `Invalid upgrade note. ${file}: cannot read JSON: ${(cause as Error).message}`,
    );
  }
}

export async function loadUpgradeNotes(
  notesDir: string,
  sdkVersion: string,
): Promise<Array<UpgradeNote & { version: string }>> {
  return (await loadUpgradeNoteSet(notesDir, sdkVersion)).notes;
}

/** All notes plus every released version that has a notes file (even `notes: []`). */
export async function loadUpgradeNoteSet(
  notesDir: string,
  sdkVersion: string,
): Promise<{ notes: Array<UpgradeNote & { version: string }>; releasedVersions: string[] }> {
  const releasedVersions: string[] = [];
  const result: Array<UpgradeNote & { version: string }> = [];
  const seen = new Map<string, string>();

  const add = (note: UpgradeNote, version: string, file: string) => {
    const previous = seen.get(note.id);
    if (previous) {
      throw new UpgradeNotesError(
        `Duplicate upgrade note id "${note.id}" in ${previous} and ${file}`,
      );
    }
    seen.set(note.id, file);
    result.push({ ...note, version });
  };

  let entries: string[];
  try {
    entries = await readdir(notesDir);
  } catch (cause) {
    throw new UpgradeNotesError(
      `Cannot read upgrade notes directory ${notesDir}: ${(cause as Error).message}`,
    );
  }
  const isReleasedFile = (f: string) => f.endsWith('.json') && isSemver(f.slice(0, -5));
  for (const f of entries) {
    if (f.endsWith('.json') && !isReleasedFile(f) && !IGNORED_JSON.has(f)) {
      throw new UpgradeNotesError(
        `Invalid upgrade note. ${f}: unexpected file, expected <semver>.json`,
      );
    }
  }
  const releasedFiles = entries
    .filter(isReleasedFile)
    .sort((a, b) => compareVersions(a.slice(0, -5), b.slice(0, -5)));
  for (const file of releasedFiles) {
    const parsed = ReleasedFileSchema.safeParse(
      await readJson(join(notesDir, file), file),
    );
    if (!parsed.success) throw new UpgradeNotesError(describeIssues(file, parsed.error));
    if (parsed.data.version !== file.slice(0, -5)) {
      throw new UpgradeNotesError(
        `Invalid upgrade note. ${file}: version: "${parsed.data.version}" does not match the file name`,
      );
    }
    releasedVersions.push(parsed.data.version);
    for (const note of parsed.data.notes) add(note, parsed.data.version, file);
  }

  const unreleasedDir = join(notesDir, 'unreleased');
  if (existsSync(unreleasedDir)) {
    const files = (await readdir(unreleasedDir)).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const rel = `unreleased/${file}`;
      const parsed = UpgradeNoteSchema.safeParse(
        await readJson(join(unreleasedDir, file), rel),
      );
      if (!parsed.success) throw new UpgradeNotesError(describeIssues(rel, parsed.error));
      add(parsed.data, sdkVersion, rel);
    }
  }
  return { notes: result, releasedVersions };
}

/** Locate the `upgrade-notes/` directory shipped with this package. */
export function findPackageUpgradeNotesDir(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'upgrade-notes');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the bundled 'upgrade-notes/' directory. Reinstall glirastes or check your node_modules.",
  );
}

/**
 * Semver precedence: a prerelease sorts below its release (`0.19.0-rc.1 <
 * 0.19.0`), prerelease identifiers compare numerically when both are numeric,
 * numeric below alphanumeric, and a shorter list below a longer one. Build
 * metadata is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } => {
    const m = SEMVER_RE.exec(v);
    if (!m) throw new Error(`Invalid version '${v}': expected <major>.<minor>.<patch>[-<prerelease>].`);
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  };
  const sign = (d: number) => (d < 0 ? -1 : d > 0 ? 1 : 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return sign(d);
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return sign(pb.pre.length - pa.pre.length);
  const numeric = /^\d+$/;
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]!;
    const y = pb.pre[i]!;
    if (x === y) continue;
    const xn = numeric.test(x);
    const yn = numeric.test(y);
    if (xn && yn) return sign(Number(x) - Number(y));
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return sign(pa.pre.length - pb.pre.length);
}
