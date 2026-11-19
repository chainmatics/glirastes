import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SEMVER_RE } from './notes.js';

export const BASELINE_PATH = '.glirastes/sdk-baseline.json';

export const UPGRADE_DECISIONS = ['adopted', 'declined', 'deferred'] as const;

export type UpgradeDecision = (typeof UPGRADE_DECISIONS)[number];

const SEMVER = SEMVER_RE;

const BaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedThrough: z.string().regex(SEMVER),
    decisions: z.record(
      z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
      z
        .object({
          decision: z.enum(UPGRADE_DECISIONS),
          version: z.string().regex(SEMVER),
        })
        .strict(),
    ),
  })
  .strict();

export type SdkBaseline = z.infer<typeof BaselineSchema>;

const FIX_HINT =
  'Resolve the merge conflict or fix the file by hand, or delete the file to reset it.';

function baselineFile(root: string): string {
  return join(root, BASELINE_PATH);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Reads the per-app baseline. Returns undefined only when the file does not exist. */
export async function readBaseline(root: string): Promise<SdkBaseline | undefined> {
  let raw: string;
  try {
    raw = await readFile(baselineFile(root), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `${BASELINE_PATH} is not valid JSON (${(cause as Error).message}). ${FIX_HINT}`,
    );
  }

  const parsed = BaselineSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${BASELINE_PATH} does not match the expected schema (${details}). ${FIX_HINT}`);
  }
  return parsed.data;
}

/**
 * Writes the baseline atomically with recursively sorted keys. A baseline that
 * does not match the schema (e.g. a version that is not semver) is refused
 * before anything is written.
 */
export async function writeBaseline(root: string, baseline: SdkBaseline): Promise<void> {
  const parsed = BaselineSchema.safeParse(baseline);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Refusing to write ${BASELINE_PATH}: ${details}.`);
  }
  const file = baselineFile(root);
  await mkdir(join(root, '.glirastes'), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(sortKeys(baseline), null, 2)}\n`);
    await rename(tmp, file);
  } catch (cause) {
    await unlink(tmp).catch(() => undefined);
    throw cause;
  }
}

/**
 * Returns the existing baseline, or creates one reviewed through `version` when
 * missing. A `version` that is not semver is refused and nothing is written.
 */
export async function ensureBaseline(root: string, version: string): Promise<SdkBaseline> {
  const existing = await readBaseline(root);
  if (existing) return existing;
  if (!SEMVER.test(version)) {
    throw new Error(`Not creating ${BASELINE_PATH}: '${version}' is not a semver version.`);
  }
  const created: SdkBaseline = { schemaVersion: 1, reviewedThrough: version, decisions: {} };
  await writeBaseline(root, created);
  return created;
}

/** Pure: returns a new baseline with the decision for `noteId` set. */
export function recordDecision(
  baseline: SdkBaseline,
  noteId: string,
  decision: UpgradeDecision,
  version: string,
): SdkBaseline {
  return {
    ...baseline,
    decisions: { ...baseline.decisions, [noteId]: { decision, version } },
  };
}
