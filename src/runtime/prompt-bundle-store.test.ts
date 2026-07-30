import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalPromptBundleJson,
  type PromptBundle,
  type SignedPromptBinding,
} from '../contracts/index.js';
import { PromptBundleStore } from './prompt-bundle-store.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'runtime-key';
const APP_ID = '019fb003-0000-7000-8000-000000000001';
const OTHER_APP_ID = '019fb003-0000-7000-8000-000000000002';
const BUNDLE_ID = '019fb003-0000-7000-8000-000000000003';
const REVISION_ONE = '019fb003-0000-7000-8000-000000000004';
const REVISION_TWO = '019fb003-0000-7000-8000-000000000005';

const keys = {
  getKey: vi.fn(async (requestedKeyId: string) => (
    requestedKeyId === keyId
      ? (publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
      : null
  )),
};

const signatureFor = (unsigned: unknown) => ({
  algorithm: 'Ed25519' as const,
  keyId,
  value: sign(
    null,
    Buffer.from(canonicalPromptBundleJson(unsigned)),
    privateKey,
  ).toString('base64url'),
});

const sectionsDigest = (sections: unknown) => (
  `sha256:${createHash('sha256')
    .update(canonicalPromptBundleJson(sections))
    .digest('base64url')}`
);

function promptBundle(overrides: {
  appId?: string;
  revisionId?: string;
  revision?: number;
  responseStyle?: string;
  parentRevisionId?: string;
} = {}): PromptBundle {
  const sections = {
    planner: 'Decompose the request, then stop when the goal is met.',
    appBehavior: 'You manage tasks for one workspace.',
    responseStyle: overrides.responseStyle ?? 'Answer briefly in German.',
    capabilityFragments: [],
  };
  const unsigned = {
    schemaVersion: 1 as const,
    bundleId: BUNDLE_ID,
    appId: overrides.appId ?? APP_ID,
    revisionId: overrides.revisionId ?? REVISION_ONE,
    revision: overrides.revision ?? 1,
    ...(overrides.parentRevisionId
      ? { parentRevisionId: overrides.parentRevisionId }
      : {}),
    bundleDigest: sectionsDigest(sections),
    sections,
    createdAt: '2026-07-30T10:00:00.000Z',
  };
  return { ...unsigned, signature: signatureFor(unsigned) } as PromptBundle;
}

function binding(bundle: PromptBundle, overrides: {
  appId?: string;
  bundleDigest?: string;
  revision?: number;
  artifactRef?: string;
} = {}): SignedPromptBinding {
  const unsigned = {
    schemaVersion: 1 as const,
    appId: overrides.appId ?? bundle.appId,
    revisionId: bundle.revisionId,
    revision: overrides.revision ?? bundle.revision,
    bundleDigest: overrides.bundleDigest ?? bundle.bundleDigest,
    artifactRef: overrides.artifactRef ?? `local://prompts/${bundle.revisionId}`,
    activatedAt: '2026-07-30T10:05:00.000Z',
  };
  return { ...unsigned, signature: signatureFor(unsigned) } as SignedPromptBinding;
}

describe('PromptBundleStore', () => {
  let registry: { fetch: ReturnType<typeof vi.fn> };
  let store: PromptBundleStore;
  const artifacts = new Map<string, PromptBundle>();

  const publish = (bundle: PromptBundle) => {
    const pin = binding(bundle);
    artifacts.set(pin.artifactRef, bundle);
    return pin;
  };

  beforeEach(() => {
    artifacts.clear();
    keys.getKey.mockClear();
    registry = {
      fetch: vi.fn(async (artifactRef: string) => {
        const bundle = artifacts.get(artifactRef);
        if (!bundle) throw new Error('artifact missing');
        return bundle;
      }),
    };
    store = new PromptBundleStore({
      appId: APP_ID,
      registry,
      keys,
    });
  });

  it('activates a verified bundle and exposes only its sections', async () => {
    const pin = publish(promptBundle());

    const staged = await store.stage(pin);
    await store.activate(staged);

    expect(store.current()).toEqual({
      revisionId: REVISION_ONE,
      revision: 1,
      bundleDigest: pin.bundleDigest,
      sections: {
        planner: 'Decompose the request, then stop when the goal is met.',
        appBehavior: 'You manage tasks for one workspace.',
        responseStyle: 'Answer briefly in German.',
        capabilityFragments: [],
      },
    });
    expect(Object.isFrozen(store.current().sections)).toBe(true);
  });

  it('has no unsigned or stale fallback before a verified activation', () => {
    expect(() => store.current()).toThrow(/no verified prompt bundle/i);
    expect(() => store.pinForTurn('turn-1')).toThrow(
      /no verified prompt bundle/i,
    );
  });

  it('rejects a bundle whose digest does not match its sections', async () => {
    const bundle = promptBundle();
    const tampered = {
      ...bundle,
      sections: { ...bundle.sections, responseStyle: 'Answer in English.' },
    } as PromptBundle;
    const pin = binding(bundle);
    artifacts.set(pin.artifactRef, tampered);

    await expect(store.stage(pin)).rejects.toThrow(/digest/i);
    expect(() => store.current()).toThrow();
  });

  it('rejects an invalid bundle or binding signature', async () => {
    const bundle = promptBundle();
    const pin = publish(bundle);
    artifacts.set(pin.artifactRef, {
      ...bundle,
      signature: { ...bundle.signature, value: 'AAAA'.repeat(16) },
    } as PromptBundle);
    await expect(store.stage(pin)).rejects.toThrow(/signature/i);

    artifacts.set(pin.artifactRef, bundle);
    await expect(store.stage({
      ...pin,
      signature: { ...pin.signature, value: 'AAAA'.repeat(16) },
    })).rejects.toThrow(/signature/i);
  });

  it('rejects an unknown signing key instead of trusting the artifact', async () => {
    const bundle = promptBundle();
    const pin = publish(bundle);
    artifacts.set(pin.artifactRef, {
      ...bundle,
      signature: { ...bundle.signature, keyId: 'rotated-away' },
    } as PromptBundle);

    await expect(store.stage(pin)).rejects.toThrow(/key/i);
  });

  it('rejects a bundle or binding addressed to another app', async () => {
    const foreign = promptBundle({ appId: OTHER_APP_ID });
    const foreignPin = binding(foreign);
    artifacts.set(foreignPin.artifactRef, foreign);
    await expect(store.stage(foreignPin)).rejects.toThrow(/app/i);

    const bundle = promptBundle();
    const pin = publish(bundle);
    await expect(store.stage(
      binding(bundle, { appId: OTHER_APP_ID }),
    )).rejects.toThrow(/app/i);
  });

  it('rejects a binding that disagrees with the fetched bundle identity', async () => {
    const bundle = promptBundle();
    const pin = publish(bundle);
    artifacts.set(pin.artifactRef, bundle);

    await expect(store.stage(
      binding(bundle, { bundleDigest: `sha256:${'A'.repeat(43)}` }),
    )).rejects.toThrow(/digest/i);
    await expect(store.stage(binding(bundle, { revision: 7 })))
      .rejects.toThrow(/revision/i);
  });

  it('rejects an oversized artifact before verification work', async () => {
    const small = new PromptBundleStore({
      appId: APP_ID,
      registry,
      keys,
      maxBundleBytes: 32,
    });
    const pin = publish(promptBundle());

    await expect(small.stage(pin)).rejects.toThrow(/too large/i);
  });

  it('rejects a stale revision once a newer one is active', async () => {
    const second = promptBundle({ revisionId: REVISION_TWO, revision: 2 });
    const secondPin = publish(second);
    await store.activate(await store.stage(secondPin));

    const firstPin = publish(promptBundle());
    await expect(store.stage(firstPin)).rejects.toThrow(/stale/i);
    expect(store.current().revision).toBe(2);
  });

  it('keeps the active bundle intact when a later activation fails', async () => {
    const first = promptBundle();
    await store.activate(await store.stage(publish(first)));

    const broken = promptBundle({ revisionId: REVISION_TWO, revision: 2 });
    const brokenPin = binding(broken, {
      bundleDigest: `sha256:${'B'.repeat(43)}`,
    });
    artifacts.set(brokenPin.artifactRef, broken);

    await expect(store.stage(brokenPin)).rejects.toThrow();
    expect(store.current().revisionId).toBe(REVISION_ONE);
  });

  it('pins a running turn while new turns receive the activated revision', async () => {
    const first = promptBundle();
    await store.activate(await store.stage(publish(first)));
    const running = store.pinForTurn('turn-1');

    const second = promptBundle({
      revisionId: REVISION_TWO,
      revision: 2,
      responseStyle: 'Answer briefly in English.',
      parentRevisionId: REVISION_ONE,
    });
    await store.activate(await store.stage(publish(second)));

    expect(store.pinForTurn('turn-1')).toEqual(running);
    expect(running.sections.responseStyle).toBe('Answer briefly in German.');
    const next = store.pinForTurn('turn-2');
    expect(next.revisionId).toBe(REVISION_TWO);
    expect(next.sections.responseStyle).toBe('Answer briefly in English.');
  });

  it('never contacts the registry or key provider during a turn', async () => {
    await store.activate(await store.stage(publish(promptBundle())));
    registry.fetch.mockClear();
    keys.getKey.mockClear();

    store.pinForTurn('turn-1');
    store.current();
    store.pinForTurn('turn-1');
    store.releaseTurn('turn-1');

    expect(registry.fetch).not.toHaveBeenCalled();
    expect(keys.getKey).not.toHaveBeenCalled();
  });

  it('rolls back to the previously verified pin without refetching', async () => {
    await store.activate(await store.stage(publish(promptBundle())));
    const second = promptBundle({ revisionId: REVISION_TWO, revision: 2 });
    await store.activate(await store.stage(publish(second)));
    registry.fetch.mockClear();
    keys.getKey.mockClear();

    store.rollback();

    expect(store.current().revisionId).toBe(REVISION_ONE);
    expect(registry.fetch).not.toHaveBeenCalled();
    expect(keys.getKey).not.toHaveBeenCalled();
    expect(store.pinForTurn('turn-after-rollback').revision).toBe(1);
  });

  it('refuses a rollback without a previously verified pin', async () => {
    await store.activate(await store.stage(publish(promptBundle())));

    expect(() => store.rollback()).toThrow(/previous/i);
    expect(store.current().revisionId).toBe(REVISION_ONE);
  });

  it('allows a rolled-back revision to be activated again', async () => {
    await store.activate(await store.stage(publish(promptBundle())));
    const secondPin = publish(
      promptBundle({ revisionId: REVISION_TWO, revision: 2 }),
    );
    await store.activate(await store.stage(secondPin));
    store.rollback();

    await store.activate(await store.stage(secondPin));

    expect(store.current().revisionId).toBe(REVISION_TWO);
  });
});
