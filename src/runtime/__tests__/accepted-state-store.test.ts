import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EnvironmentControl } from '../../contracts/environment-control.js';
import { canonicalRuntimeJson, RuntimeRevisionVerifier } from '../../sync/signature-verifier.js';
import { RuntimeSyncManager } from '../../sync/sync-manager.js';
import { AcceptedStateStore } from '../accepted-state-store.js';

const tenantId = '019fbc00-0000-7000-8000-0000000000a1';
const targetAppId = '019fbc00-0000-7000-8000-0000000000a2';
const environmentA = '019fbc00-0000-7000-8000-0000000000a3';
const environmentB = '019fbc00-0000-7000-8000-0000000000a4';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });

function control(environmentId: string, sequence: number, assistant: 'enabled' | 'halted'): EnvironmentControl {
  const unsigned = {
    kind: 'environment-control' as const, schemaVersion: 1 as const, tenantId, targetAppId, environmentId,
    sequence, assistant, reasonCode: 'operator-halt', issuedAt: '2026-11-26T09:00:00.000Z',
  };
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519', keyId: 'runtime-key',
      value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
    },
  };
}

const bundle = (value: EnvironmentControl) => ({
  cursor: '2026-11-26T09:00:00.000Z', activeSnapshotComplete: true, deployments: [], revocations: [], control: value,
});

describe('AcceptedStateStore', () => {
  it('discards a save of a dropped environment that lands after the next bind', async () => {
    const store = new AcceptedStateStore();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const managerA = new RuntimeSyncManager({
      environmentId: environmentA, targetAppId, store: store.bind(environmentA),
      verifier: new RuntimeRevisionVerifier({ getKey: async () => { await slow; return jwk; } }),
    });
    const inFlight = managerA.apply(bundle(control(environmentA, 7, 'enabled')));

    store.clear();
    const viewB = store.bind(environmentB);
    release();
    await inFlight;

    expect(store.control()).toBeUndefined();
    expect(await viewB.load()).toBeNull();

    const managerB = new RuntimeSyncManager({
      environmentId: environmentB, targetAppId, store: viewB,
      verifier: new RuntimeRevisionVerifier({ getKey: async () => jwk }),
    });
    const haltB = control(environmentB, 2, 'halted');
    expect((await managerB.apply(bundle(haltB))).control).toBe('accepted');
    expect(store.control()).toEqual(haltB);
  });
});
