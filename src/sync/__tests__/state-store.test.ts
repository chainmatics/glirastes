import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('loads a state file written before environment control existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glirastes-lkg-'));
    dirs.push(dir);
    const path = join(dir, 'runtime-state.json');
    await writeFile(path, `${JSON.stringify(emptyState)}\n`, 'utf8');
    const loaded = await new FileRuntimeStateStore(path).load();
    expect(loaded).toEqual(emptyState);
    expect(loaded?.control).toBeUndefined();
  });

  it('persists an accepted control and a local halt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glirastes-lkg-'));
    dirs.push(dir);
    const path = join(dir, 'runtime-state.json');
    const state: RuntimeSyncState = {
      ...emptyState,
      control: {
        accepted: {
          kind: 'environment-control',
          schemaVersion: 1,
          tenantId: '019fbc00-0000-7000-8000-0000000000a1',
          targetAppId: '019fbc00-0000-7000-8000-0000000000a2',
          environmentId: '019fbc00-0000-7000-8000-0000000000a3',
          sequence: 2,
          assistant: 'enabled',
          budgetCeiling: { maxToolCalls: 2 },
          reasonCode: 'operator-tighten',
          issuedAt: '2026-11-26T09:00:00.000Z',
          signature: { algorithm: 'Ed25519', keyId: 'runtime-key', value: 'signed-value' },
        },
        localHalt: {
          kind: 'local',
          assistant: 'halted',
          reasonCode: 'control_unverifiable',
          sequence: 2,
          detectedAt: '2026-11-26T09:01:00.000Z',
        },
      },
    };
    await new FileRuntimeStateStore(path).saveAtomic(state);
    expect(await new FileRuntimeStateStore(path).load()).toEqual(state);
  });
});
