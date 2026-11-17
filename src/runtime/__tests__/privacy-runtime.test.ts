import { describe, expect, it } from 'vitest';
import {
  PrivacyRuntimeStatusSchema,
  type PrivacyPolicyBlock,
} from '../../contracts/privacy-policy.js';
import type { SecurityRevocation } from '../../contracts/revisions.js';
import { findForbiddenPlatformContentPath } from '../../contracts/content-boundary.js';
import { isPrivacyError } from '../../server/pii-shield/detection-result.js';
import {
  assertPrivacyTurn,
  effectivePrivacyPolicyFor,
  privacyRuntimeStatus,
  type GlirastesPrivacyOptions,
} from '../privacy-runtime.js';

const DIGEST = `sha256:${'A'.repeat(43)}`;
const OTHER = `sha256:${'B'.repeat(43)}`;
const REVISION = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3908';

const block: PrivacyPolicyBlock = {
  schemaVersion: 1,
  profile: 'protected-text/v1',
  screenshots: { mode: 'blocked' },
  providers: { allowed: [{ entryId: 'main', bindingDigest: DIGEST }], defaultEntryId: 'main', userChoice: false },
  mapping: { idleTtlSeconds: 3600, absoluteTtlSeconds: 86400 },
  speech: { localOnly: true, maxDurationSeconds: 60 },
};

function privacy(bindings: Record<string, string> = { main: DIGEST }, local?: GlirastesPrivacyOptions['local']): GlirastesPrivacyOptions {
  return {
    shield: { profile: 'protected-text/v1' } as GlirastesPrivacyOptions['shield'],
    providers: { bindings: () => bindings, defaultEntryId: 'main' } as GlirastesPrivacyOptions['providers'],
    ...(local ? { local } : {}),
  };
}

const revoked = [{ policyRevisionIds: [REVISION] }] as unknown as SecurityRevocation[];

function codeOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return isPrivacyError(error) ? error.code : `not-privacy:${String(error)}`;
  }
}

describe('privacyRuntimeStatus', () => {
  it('is off without a block and without a local requirement', () => {
    expect(privacyRuntimeStatus(undefined, undefined)).toMatchObject({ state: 'off', reasons: [], policyRevisionId: null });
  });

  it('refuses a protected block on a runtime without privacy infrastructure', () => {
    const status = privacyRuntimeStatus({ revisionId: REVISION, privacy: block }, undefined);
    expect(status).toMatchObject({ state: 'refused', reasons: ['store_missing'], policyRevisionId: REVISION, effectivePolicyDigest: null });
    expect(status.publishedPolicyDigest).toMatch(/^sha256:/);
  });

  it('enforces a block whose approved binding matches, with both digests', () => {
    const status = privacyRuntimeStatus({ revisionId: REVISION, privacy: block }, privacy());
    expect(status).toMatchObject({ state: 'enforced', reasons: [] });
    expect(status.effectivePolicyDigest).toMatch(/^sha256:/);
    expect(PrivacyRuntimeStatusSchema.safeParse(status).success).toBe(true);
    expect(findForbiddenPlatformContentPath(status)).toBeNull();
  });

  it('refuses when no local binding matches the approval', () => {
    const status = privacyRuntimeStatus({ revisionId: REVISION, privacy: block }, privacy({ main: OTHER }));
    expect(status).toMatchObject({ state: 'refused', reasons: ['provider_binding_missing', 'provider_default_unusable'] });
  });

  it('refuses when the approved default is not offered locally', () => {
    const twoEntries: PrivacyPolicyBlock = {
      ...block,
      providers: { allowed: [{ entryId: 'main', bindingDigest: DIGEST }, { entryId: 'alt', bindingDigest: OTHER }], defaultEntryId: 'main', userChoice: true },
    } as PrivacyPolicyBlock;
    const status = privacyRuntimeStatus(
      { revisionId: REVISION, privacy: twoEntries },
      privacy({ main: DIGEST, alt: OTHER }, { providerEntryIds: ['alt'] }),
    );
    expect(status).toMatchObject({ state: 'refused', reasons: ['provider_default_unusable'], localRestrictions: ['local_providers_narrower'] });
  });

  it('refuses a revoked pinned revision', () => {
    expect(privacyRuntimeStatus({ revisionId: REVISION, privacy: block }, privacy(), revoked))
      .toMatchObject({ state: 'refused', reasons: ['policy_revoked'] });
  });

  it('reports local tightening and changes the effective digest', () => {
    const plain = privacyRuntimeStatus({ revisionId: REVISION, privacy: block }, privacy());
    const tighter = privacyRuntimeStatus({ revisionId: REVISION, privacy: block }, privacy(undefined, { mapping: { idleTtlSeconds: 60 } }));
    expect(tighter.localRestrictions).toEqual(['local_ttl_shorter']);
    expect(tighter.effectivePolicyDigest).not.toBe(plain.effectivePolicyDigest);
    expect(tighter.publishedPolicyDigest).toBe(plain.publishedPolicyDigest);
  });

  it('enforces the local profile without a block (local source, no provider check)', () => {
    const status = privacyRuntimeStatus(undefined, privacy({}));
    expect(status).toMatchObject({ state: 'enforced', policyRevisionId: null, publishedPolicyDigest: null, localRestrictions: ['local_profile_required'] });
  });

  it('is off for a local required:false and an off block', () => {
    const off = { schemaVersion: 1, profile: 'off' } as PrivacyPolicyBlock;
    expect(privacyRuntimeStatus({ revisionId: REVISION, privacy: off }, privacy(undefined, { required: false })).state).toBe('off');
    expect(effectivePrivacyPolicyFor({ revisionId: REVISION, privacy: off }, privacy(undefined, { required: false }))).toBeNull();
  });
});

describe('assertPrivacyTurn', () => {
  const pinned = { revisionId: REVISION, privacy: block };

  it('passes for an enforced policy', () => {
    expect(codeOf(() => assertPrivacyTurn({ pinned, privacy: privacy(), revocations: [], awaitingPolicy: false }))).toBeUndefined();
  });

  it('blocks while a connected runtime has no verified policy', () => {
    expect(codeOf(() => assertPrivacyTurn({ pinned: undefined, privacy: privacy(), revocations: [], awaitingPolicy: true })))
      .toBe('privacy_policy_unavailable');
  });

  it('blocks a revoked revision with its own code', () => {
    expect(codeOf(() => assertPrivacyTurn({ pinned, privacy: privacy(), revocations: revoked, awaitingPolicy: false })))
      .toBe('privacy_policy_revoked');
  });

  it('blocks a policy this runtime cannot enforce', () => {
    expect(codeOf(() => assertPrivacyTurn({ pinned, privacy: privacy({ main: OTHER }), revocations: [], awaitingPolicy: false })))
      .toBe('privacy_not_configured');
    expect(codeOf(() => assertPrivacyTurn({ pinned, privacy: undefined, revocations: [], awaitingPolicy: false })))
      .toBe('privacy_not_configured');
  });

  it('leaves a runtime without privacy and without a protected block alone', () => {
    expect(codeOf(() => assertPrivacyTurn({ pinned: undefined, privacy: undefined, revocations: [], awaitingPolicy: true }))).toBeUndefined();
  });
});
