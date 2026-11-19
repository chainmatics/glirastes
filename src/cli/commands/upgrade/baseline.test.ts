import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  ensureBaseline,
  readBaseline,
  recordDecision,
  writeBaseline,
  type SdkBaseline,
} from './baseline.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sdk-baseline-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const file = () => join(root, BASELINE_PATH);

describe('sdk baseline', () => {
  it('uses the committed path under .glirastes', () => {
    expect(BASELINE_PATH).toBe('.glirastes/sdk-baseline.json');
  });

  it('round-trips with sorted decision keys', async () => {
    const baseline: SdkBaseline = {
      schemaVersion: 1,
      reviewedThrough: '0.17.0',
      decisions: {
        'zeta-note': { decision: 'declined', version: '0.18.0' },
        'alpha-note': { decision: 'adopted', version: '0.18.0' },
      },
    };
    await writeBaseline(root, baseline);

    const raw = await readFile(file(), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.indexOf('"alpha-note"')).toBeLessThan(raw.indexOf('"zeta-note"'));
    expect(JSON.parse(raw)).toEqual(baseline);
    expect(await readBaseline(root)).toEqual(baseline);
  });

  it('returns undefined when the file does not exist', async () => {
    expect(await readBaseline(root)).toBeUndefined();
  });

  it('ensureBaseline creates the file when missing', async () => {
    const created = await ensureBaseline(root, '0.18.0');
    expect(created).toEqual({ schemaVersion: 1, reviewedThrough: '0.18.0', decisions: {} });
    expect(await readBaseline(root)).toEqual(created);
  });

  it('ensureBaseline does not overwrite an existing file', async () => {
    await mkdir(join(root, '.glirastes'));
    await writeFile(
      file(),
      JSON.stringify({
        schemaVersion: 1,
        reviewedThrough: '0.17.0',
        decisions: { 'some-note': { decision: 'deferred', version: '0.18.0' } },
      }),
    );

    const kept = await ensureBaseline(root, '0.18.0');
    expect(kept.reviewedThrough).toBe('0.17.0');
    expect(kept.decisions['some-note']).toEqual({ decision: 'deferred', version: '0.18.0' });
  });

  it('rejects schemaVersion 2 with a clear error', async () => {
    await mkdir(join(root, '.glirastes'));
    await writeFile(
      file(),
      JSON.stringify({ schemaVersion: 2, reviewedThrough: '0.18.0', decisions: {} }),
    );

    const error = await readBaseline(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('.glirastes/sdk-baseline.json');
    expect((error as Error).message).toMatch(/resolve the merge conflict|delete the file/);
  });

  it('rejects invalid JSON with a clear error naming the file', async () => {
    await mkdir(join(root, '.glirastes'));
    await writeFile(file(), '<<<<<<< HEAD\n{}\n');

    const error = await readBaseline(root).catch((e: unknown) => e);
    expect((error as Error).message).toContain('.glirastes/sdk-baseline.json');
    expect((error as Error).message).toMatch(/resolve the merge conflict|delete the file/);
  });

  it('recordDecision replaces an earlier decision', () => {
    const before: SdkBaseline = {
      schemaVersion: 1,
      reviewedThrough: '0.17.0',
      decisions: { 'some-note': { decision: 'deferred', version: '0.18.0' } },
    };
    const after = recordDecision(before, 'some-note', 'adopted', '0.18.1');

    expect(after.decisions['some-note']).toEqual({ decision: 'adopted', version: '0.18.1' });
    expect(before.decisions['some-note']).toEqual({ decision: 'deferred', version: '0.18.0' });
    expect(after).not.toBe(before);
  });
});
