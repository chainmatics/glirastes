import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeSyncState } from '../state-store.js';
import {
  FileRuntimeStateStore,
  MemoryRuntimeStateStore,
} from '../state-store.js';

const dirs: string[] = [];
const emptyState: RuntimeSyncState = {
  cursor: null,
  stable: null,
  canary: null,
  pending: [],
  revocations: [],
  updatedAt: '2026-07-28T20:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

describe('runtime state stores', () => {
  it('supports a zero-setup in-memory last-known-good cache', async () => {
    const store = new MemoryRuntimeStateStore();
    expect(await store.load()).toBeNull();
    await store.saveAtomic(emptyState);
    expect(await store.load()).toEqual(emptyState);
  });

  it('persists state through an atomic file replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glirastes-lkg-'));
    dirs.push(dir);
    const path = join(dir, 'runtime-state.json');
    const store = new FileRuntimeStateStore(path);
    await store.saveAtomic(emptyState);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(emptyState);
    expect(await new FileRuntimeStateStore(path).load()).toEqual(emptyState);
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow();
  });
});
