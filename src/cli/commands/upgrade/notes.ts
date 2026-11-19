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

export const UpgradeNoteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    kind: z.enum(UPGRADE_NOTE_KINDS),
    summary: z.string().min(1).max(300),
    howTo: z.string().min(1).max(2000),
    skill: z.string().regex(/^[a-z0-9][a-z0-9-]*(#[A-Za-z0-9][A-Za-z0-9_.-]*)?$/),
    affectedWhen: DetectSchema.optional(),
    adoptedWhen: DetectSchema.optional(),
    surface: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type UpgradeNote = z.infer<typeof UpgradeNoteSchema>;

const ReleasedFileSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
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
  const SEMVER_FILE = /^\d+\.\d+\.\d+\.json$/;
  for (const f of entries) {
    if (f.endsWith('.json') && !SEMVER_FILE.test(f) && !IGNORED_JSON.has(f)) {
      throw new UpgradeNotesError(
        `Invalid upgrade note. ${f}: unexpected file, expected <semver>.json`,
      );
    }
  }
  const releasedFiles = entries
    .filter((f) => SEMVER_FILE.test(f))
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
  return result;
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

export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const parts = v.split(/[-+]/)[0]!.split('.');
    if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
      throw new Error(`Invalid version '${v}': expected <major>.<minor>.<patch>.`);
    }
    return parts.map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
