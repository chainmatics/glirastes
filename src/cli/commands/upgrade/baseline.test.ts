import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  ensureBaseline,
  readBaseline,
  withDeferred,
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
        'zeta-note': { decision: 'deferred', version: '0.18.0' },
        'alpha-note': { decision: 'deferred', version: '0.18.0' },
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

  it('writes and reads back a prerelease baseline', async () => {
    await ensureBaseline(root, '0.19.0-rc.1');
    expect((await readBaseline(root))!.reviewedThrough).toBe('0.19.0-rc.1');
  });

  it('ensureBaseline refuses an invalid version and writes nothing', async () => {
    await expect(ensureBaseline(root, 'workspace:*')).rejects.toThrow(/workspace:\*/);
    expect(await readBaseline(root)).toBeUndefined();
  });

  it('writeBaseline refuses a baseline that does not match the schema', async () => {
    await expect(
      writeBaseline(root, { schemaVersion: 1, reviewedThrough: 'latest', decisions: {} }),
    ).rejects.toThrow(/reviewedThrough/);
    expect(await readBaseline(root)).toBeUndefined();
  });

  it('ignores adopted and declined entries written by a pre-release build', async () => {
    await mkdir(join(root, '.glirastes'));
    await writeFile(
      file(),
      JSON.stringify({
        schemaVersion: 1,
        reviewedThrough: '0.18.0',
        decisions: {
          'kept-note': { decision: 'deferred', version: '0.18.0' },
          'old-adopted': { decision: 'adopted', version: '0.18.0' },
          'old-declined': { decision: 'declined', version: '0.18.0' },
        },
      }),
    );

    expect(await readBaseline(root)).toEqual({
      schemaVersion: 1,
      reviewedThrough: '0.18.0',
      decisions: { 'kept-note': { decision: 'deferred', version: '0.18.0' } },
    });
  });

  it('still rejects an unknown decision value', async () => {
    await mkdir(join(root, '.glirastes'));
    await writeFile(
      file(),
      JSON.stringify({
        schemaVersion: 1,
        reviewedThrough: '0.18.0',
        decisions: { 'some-note': { decision: 'maybe', version: '0.18.0' } },
      }),
    );
    await expect(readBaseline(root)).rejects.toThrow(/decisions/);
  });

  it('writeBaseline refuses an adopted or declined entry', async () => {
    await expect(
      writeBaseline(root, {
        schemaVersion: 1,
        reviewedThrough: '0.18.0',
        decisions: { 'some-note': { decision: 'adopted', version: '0.18.0' } },
      } as never),
    ).rejects.toThrow(/decision/);
  });

  it('withDeferred sets exactly the given deferred notes', () => {
    const before: SdkBaseline = {
      schemaVersion: 1,
      reviewedThrough: '0.17.0',
      decisions: { 'old-note': { decision: 'deferred', version: '0.18.0' } },
    };
    const after = withDeferred(before, '0.19.0', [{ id: 'new-note', version: '0.19.0' }]);

    expect(after).toEqual({
      schemaVersion: 1,
      reviewedThrough: '0.19.0',
      decisions: { 'new-note': { decision: 'deferred', version: '0.19.0' } },
    });
    expect(before.decisions['old-note']).toEqual({ decision: 'deferred', version: '0.18.0' });
  });
});
