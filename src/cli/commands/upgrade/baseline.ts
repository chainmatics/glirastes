import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SEMVER_RE } from './notes.js';

export const BASELINE_PATH = '.glirastes/sdk-baseline.json';

const SEMVER = SEMVER_RE;
const NOTE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;

/**
 * `decisions` only holds notes deferred at `glirastes upgrade ack --defer`.
 * Pre-release builds also wrote `adopted` and `declined`; reading drops those
 * entries (detection decides adoption now), writing refuses them.
 */
const LEGACY_DECISIONS = ['adopted', 'declined'] as const;

function baselineSchema(decision: z.ZodType<string>) {
  return z
    .object({
      schemaVersion: z.literal(1),
      reviewedThrough: z.string().regex(SEMVER),
      decisions: z.record(
        z.string().regex(NOTE_ID),
        z.object({ decision, version: z.string().regex(SEMVER) }).strict(),
      ),
    })
    .strict();
}

const BaselineSchema = baselineSchema(z.literal('deferred'));
const ReadableBaselineSchema = baselineSchema(z.enum(['deferred', ...LEGACY_DECISIONS]));

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

  const parsed = ReadableBaselineSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${BASELINE_PATH} does not match the expected schema (${details}). ${FIX_HINT}`);
  }
  const decisions: SdkBaseline['decisions'] = {};
  for (const [id, entry] of Object.entries(parsed.data.decisions)) {
    if (entry.decision === 'deferred') decisions[id] = { decision: 'deferred', version: entry.version };
  }
  return { ...parsed.data, decisions };
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

/**
 * Pure: the baseline after `glirastes upgrade ack`. The deferred list is
 * replaced, so a note stays deferred only while every ack names it again.
 */
export function withDeferred(
  baseline: SdkBaseline,
  reviewedThrough: string,
  deferred: ReadonlyArray<{ id: string; version: string }>,
): SdkBaseline {
  return {
    ...baseline,
    reviewedThrough,
    decisions: Object.fromEntries(
      deferred.map(({ id, version }) => [id, { decision: 'deferred' as const, version }]),
    ),
  };
}
