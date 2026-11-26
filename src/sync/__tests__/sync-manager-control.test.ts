import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentControl } from '../../contracts/environment-control.js';
import { canonicalRuntimeJson, RuntimeRevisionVerifier } from '../signature-verifier.js';
import { MemoryRuntimeStateStore } from '../state-store.js';
import { RuntimeEnvironmentControlError, RuntimeSyncManager } from '../sync-manager.js';

const tenantId = '019fbc00-0000-7000-8000-0000000000a1';
const targetAppId = '019fbc00-0000-7000-8000-0000000000a2';
const environmentId = '019fbc00-0000-7000-8000-0000000000a3';
const otherEnvironmentId = '019fbc00-0000-7000-8000-0000000000a4';
const keyId = 'runtime-key';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keys = {
  getKey: async (requested: string) => (
    requested === keyId ? publicKey.export({ format: 'jwk' }) : null
  ),
};

function control(
  sequence: number,
  assistant: 'enabled' | 'halted',
  overrides: Partial<Omit<EnvironmentControl, 'signature'>> = {},
): EnvironmentControl {
  const unsigned = {
    kind: 'environment-control' as const,
    schemaVersion: 1 as const,
    tenantId,
    targetAppId,
    environmentId,
    sequence,
    assistant,
    reasonCode: assistant === 'halted' ? 'operator-halt' : 'operator-resume',
    issuedAt: '2026-11-26T09:00:00.000Z',
    ...overrides,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey)
        .toString('base64url'),
    },
  };
}

function bundle(extra: Record<string, unknown> = {}) {
  return {
    cursor: '2026-11-26T09:00:00.000Z',
    activeSnapshotComplete: true,
    deployments: [],
    revocations: [],
    ...extra,
  };
}

function setup(options: {
  keys?: { getKey: (keyId: string) => Promise<unknown> };
  store?: MemoryRuntimeStateStore;
} = {}) {
  const store = options.store ?? new MemoryRuntimeStateStore();
  const onControlRejected = vi.fn();
  const manager = new RuntimeSyncManager({
    environmentId,
    targetAppId,
    store,
    verifier: new RuntimeRevisionVerifier((options.keys ?? keys) as typeof keys),
    onControlRejected,
  });
  return { store, manager, onControlRejected };
}

describe('RuntimeSyncManager environment control', () => {
  it('accepts a higher sequence and persists it', async () => {
    const { store, manager } = setup();
    const halt = control(1, 'halted');
    const result = await manager.apply(bundle({ control: halt }));
    expect(result.control).toBe('accepted');
    expect((await store.load())?.control).toEqual({ accepted: halt, localHalt: null });

    const resume = control(2, 'enabled', { rateLimit: { maxTurnsPerMinutePerPrincipal: 5 } });
    expect((await manager.apply(bundle({ control: resume }))).control).toBe('accepted');
    expect((await store.load())?.control?.accepted).toEqual(resume);
  });

  it('ignores an equal or lower sequence so an old enabled cannot be replayed', async () => {
    const { store, manager } = setup();
    const halt = control(5, 'halted');
    await manager.apply(bundle({ control: halt }));
    expect((await manager.apply(bundle({ control: control(5, 'halted') }))).control).toBe('stale');
    expect((await manager.apply(bundle({ control: control(4, 'enabled') }))).control).toBe('stale');
    expect((await store.load())?.control?.accepted).toEqual(halt);
  });

  it('keeps the accepted control when the Platform sends null', async () => {
    const { store, manager } = setup();
    const halt = control(1, 'halted');
    await manager.apply(bundle({ control: halt }));
    expect((await manager.apply(bundle({ control: null }))).control).toBe('kept');
    expect((await store.load())?.control?.accepted).toEqual(halt);
  });

  it('halts locally on a signed control for another environment or app', async () => {
    for (const overrides of [{ environmentId: otherEnvironmentId }, { targetAppId: otherEnvironmentId }]) {
      const { store, manager, onControlRejected } = setup();
      const result = await manager.apply(bundle({ control: control(1, 'enabled', overrides) }));
      expect(result.control).toBe('unverifiable');
      expect((await store.load())?.control).toEqual({
        accepted: null,
        localHalt: expect.objectContaining({ reasonCode: 'control_unverifiable', sequence: 0 }),
      });
      expect(onControlRejected).toHaveBeenCalledWith('control_scope_mismatch');
    }
  });

  it('halts locally on a signed control of another tenant than the accepted one', async () => {
    const { store, manager } = setup();
    await manager.apply(bundle({ control: control(1, 'enabled') }));
    expect((await manager.apply(bundle({
      control: control(2, 'enabled', { tenantId: otherEnvironmentId }),
    }))).control).toBe('unverifiable');
    expect((await store.load())?.control?.localHalt?.sequence).toBe(1);
  });

  it('halts locally when the same sequence arrives with different content', async () => {
    const { store, manager, onControlRejected } = setup();
    await manager.apply(bundle({ control: control(3, 'halted') }));
    const conflicting = control(3, 'enabled');
    expect((await manager.apply(bundle({ control: conflicting }))).control).toBe('unverifiable');
    expect(onControlRejected).toHaveBeenCalledWith('control_sequence_conflict');
    const state = await store.load();
    expect(state?.control?.accepted?.assistant).toBe('halted');
    expect(state?.control?.localHalt?.sequence).toBe(3);
    // The conflict never lifts by itself on a repeat of the accepted control.
    expect((await manager.apply(bundle({ control: control(3, 'halted') }))).control).toBe('stale');
    expect((await store.load())?.control?.localHalt).not.toBeNull();
  });

  it('lifts a halt from a failed verification when the accepted control verifies again', async () => {
    let keyAvailable = true;
    const { store, manager } = setup({
      keys: { getKey: async (requested) => (keyAvailable ? keys.getKey(requested) : null) },
    });
    const accepted = control(3, 'enabled');
    await manager.apply(bundle({ control: accepted }));
    keyAvailable = false;
    expect((await manager.apply(bundle({ control: accepted }))).control).toBe('unverifiable');
    expect((await store.load())?.control?.localHalt).toMatchObject({ sequence: 3, failedSequence: 3 });

    keyAvailable = true;
    expect((await manager.apply(bundle({ control: accepted }))).control).toBe('accepted');
    expect((await store.load())?.control).toEqual({ accepted, localHalt: null });
  });

  it('serialises overlapping syncs so an older enabled cannot overwrite a newer halt', async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let calls = 0;
    const { store, manager } = setup({
      keys: {
        getKey: async (requested) => {
          calls += 1;
          if (calls === 1) await slow;
          return keys.getKey(requested);
        },
      },
    });
    const older = manager.apply(bundle({ control: control(1, 'enabled') }));
    const newer = manager.apply(bundle({ control: control(2, 'halted') }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSlow();
    await Promise.all([older, newer]);
    expect((await store.load())?.control?.accepted).toEqual(control(2, 'halted'));
  });

  it('re-checks the stored control before saving when another writer got there first', async () => {
    const store = new MemoryRuntimeStateStore();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const first = setup({
      store,
      keys: { getKey: async (requested) => { await slow; return keys.getKey(requested); } },
    });
    const second = setup({ store });
    const older = first.manager.apply(bundle({ control: control(1, 'enabled') }));
    await second.manager.apply(bundle({ control: control(2, 'halted') }));
    releaseSlow();
    expect((await older).control).toBe('stale');
    expect((await store.load())?.control?.accepted).toEqual(control(2, 'halted'));
  });

  it('halts locally with control_unverifiable on an invalid signature', async () => {
    const { store, manager, onControlRejected } = setup();
    await manager.apply(bundle({ control: control(3, 'enabled') }));
    const forged = { ...control(4, 'halted'), assistant: 'enabled' };
    const result = await manager.apply(bundle({ control: forged }));
    expect(result.control).toBe('unverifiable');
    const state = await store.load();
    expect(state?.control?.accepted?.sequence).toBe(3);
    expect(state?.control?.localHalt).toEqual({
      kind: 'local',
      assistant: 'halted',
      reasonCode: 'control_unverifiable',
      sequence: 3,
      failedSequence: 4,
      detectedAt: expect.any(String),
    });
    expect(onControlRejected).toHaveBeenCalledWith('control_unverifiable');
  });

  it('halts locally on a schema-invalid control and on an unknown signing key', async () => {
    const { store, manager } = setup();
    expect((await manager.apply(bundle({ control: { assistant: 'enabled' } }))).control)
      .toBe('unverifiable');
    expect((await store.load())?.control?.localHalt?.sequence).toBe(0);

    const unknownKey = { ...control(1, 'enabled'), signature: { ...control(1, 'enabled').signature, keyId: 'other' } };
    const second = setup();
    expect((await second.manager.apply(bundle({ control: unknownKey }))).control).toBe('unverifiable');
  });

  it('stays halted until a valid control with a higher sequence arrives', async () => {
    const { store, manager } = setup();
    await manager.apply(bundle({ control: control(3, 'enabled') }));
    await manager.apply(bundle({ control: { ...control(4, 'enabled'), sequence: 9 } }));
    expect((await manager.apply(bundle({ control: control(3, 'enabled') }))).control).toBe('stale');
    expect((await manager.apply(bundle({ control: null }))).control).toBe('kept');
    expect((await store.load())?.control?.localHalt).not.toBeNull();

    expect((await manager.apply(bundle({ control: control(4, 'enabled') }))).control).toBe('accepted');
    expect((await store.load())?.control).toEqual({ accepted: control(4, 'enabled'), localHalt: null });
  });

  it('fails the sync without halting when the key lookup itself fails', async () => {
    const { store, manager } = setup({
      keys: { getKey: async () => { throw new Error('Runtime JWKS request failed (503)'); } },
    });
    await expect(manager.apply(bundle({ control: control(1, 'halted') }))).rejects.toThrow(/JWKS/);
    expect(await store.load()).toBeNull();
  });

  it('behaves exactly as before when the Platform sends no control field', async () => {
    const { store, manager, onControlRejected } = setup();
    const result = await manager.apply(bundle());
    expect(result.control).toBe('absent');
    expect(await store.load()).toEqual({
      cursor: '2026-11-26T09:00:00.000Z',
      stable: null,
      canary: null,
      pending: [],
      revocations: [],
      updatedAt: '2026-11-26T09:00:00.000Z',
    });
    expect(onControlRejected).not.toHaveBeenCalled();
  });

  it('exposes a content-free error for rejected controls', () => {
    const error = new RuntimeEnvironmentControlError('control_unverifiable');
    expect(error.code).toBe('control_unverifiable');
    expect(error.message).not.toMatch(/operator|halt-/);
  });
});
