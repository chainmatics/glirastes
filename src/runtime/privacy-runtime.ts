import {
  isProtectedPolicy,
  mergePrivacyPolicy,
  type EffectivePrivacyPolicy,
  type LocalPrivacyPolicy,
  type PrivacyPolicyBlock,
  type PrivacyRuntimeStatus,
} from '../contracts/privacy-policy.js';
import type { SecurityRevocation } from '../contracts/revisions.js';
import type { ProviderRegistry } from '../server/pii-shield/provider-registry.js';
import type { StrictPiiShield } from '../server/pii-shield/strict-shield.js';
import { PrivacyError } from '../server/pii-shield/detection-result.js';
import { effectivePrivacyPolicyDigest, privacyPolicyDigest } from '../sync/privacy-digest.js';

/**
 * The privacy infrastructure of this runtime. The shield carries the
 * persistent mapping store and keyring (it refuses to start without them);
 * the registry's bindings are what a signed approval list is matched with.
 * Only ids, digests and the default entry are read here, never a secret.
 */
export interface GlirastesPrivacyOptions {
  shield: Pick<StrictPiiShield, 'profile'>;
  providers?: Pick<ProviderRegistry, 'bindings' | 'defaultEntryId'>;
  /** The local policy; it may only tighten a signed block (see `ChatPrivacyConfig.policy`). */
  local?: LocalPrivacyPolicy;
}

/** The pinned policy revision a status or gate is evaluated for. */
export interface PinnedPrivacyPolicy {
  revisionId: string;
  privacy?: PrivacyPolicyBlock;
}

/** The effective policy of a pinned revision with this runtime's configuration; `null` when off. */
export function effectivePrivacyPolicyFor(
  pinned: PinnedPrivacyPolicy | undefined,
  privacy: GlirastesPrivacyOptions,
): EffectivePrivacyPolicy | null {
  const providers = privacy.providers;
  return mergePrivacyPolicy(
    pinned?.privacy ?? null,
    { required: true, ...privacy.local },
    { bindings: providers?.bindings() ?? {}, ...(providers ? { defaultEntryId: providers.defaultEntryId } : {}) },
  );
}

/**
 * The content-free status a runner reports for one pinned policy revision.
 * A protected block is `refused` when this runtime has no privacy
 * infrastructure, no approved provider binding matches, the approved
 * default is unusable, the revision is revoked, or (managed, with
 * `acceptedStateDurable: false`) the accepted state and its privacy floor
 * would not survive a restart.
 */
export function privacyRuntimeStatus(
  pinned: PinnedPrivacyPolicy | undefined,
  privacy: GlirastesPrivacyOptions | undefined,
  revocations: ReadonlyArray<SecurityRevocation> = [],
  /** Managed runtime: whether a durable state store holds the accepted state. Unset outside the managed path. */
  acceptedStateDurable?: boolean,
): PrivacyRuntimeStatus {
  const block = pinned?.privacy;
  const signed = Boolean(block && pinned);
  const base = {
    schemaVersion: 1 as const,
    policyRevisionId: signed ? pinned!.revisionId : null,
    publishedPolicyDigest: block ? privacyPolicyDigest(block) : null,
  };
  // Revocation invalidates permission to run unprotected too. Check before
  // any off/no-infrastructure early return.
  if (pinned && revocations.some((revocation) => revocation.policyRevisionIds.includes(pinned.revisionId))) {
    return { ...base, state: 'refused', effectivePolicyDigest: null, localRestrictions: [], reasons: ['policy_revoked'] };
  }
  if (!privacy) {
    return isProtectedPolicy(block)
      ? { ...base, state: 'refused', effectivePolicyDigest: null, localRestrictions: [], reasons: ['store_missing'] }
      : { ...base, state: 'off', effectivePolicyDigest: null, localRestrictions: [], reasons: [] };
  }
  const effective = effectivePrivacyPolicyFor(pinned, privacy);
  if (!effective) return { ...base, state: 'off', effectivePolicyDigest: null, localRestrictions: [], reasons: [] };
  const reasons: PrivacyRuntimeStatus['reasons'] = [];
  if (effective.source === 'platform') {
    if (!privacy.providers || (effective.providers.allowed?.length ?? 0) === 0) reasons.push('provider_binding_missing');
    if (effective.providers.defaultEntryId === null) reasons.push('provider_default_unusable');
  }
  if (acceptedStateDurable === false && isProtectedPolicy(block)) reasons.push('accepted_state_missing');
  return {
    ...base,
    state: reasons.length > 0 ? 'refused' : 'enforced',
    effectivePolicyDigest: reasons.length > 0 ? null : effectivePrivacyPolicyDigest(effective),
    localRestrictions: [...effective.localRestrictions],
    reasons,
  };
}

/**
 * The privacy check of one turn before its privacy turn opens. Throws
 * `privacy_policy_unavailable` while a connected runtime has no verified
 * deployment, `privacy_policy_revoked` for a revoked pinned revision and
 * `privacy_not_configured` for a protected block this runtime cannot
 * enforce. A runtime without privacy configuration only refuses a
 * protected block (the handler does that itself).
 */
export function assertPrivacyTurn(input: {
  pinned: PinnedPrivacyPolicy | undefined;
  privacy: GlirastesPrivacyOptions | undefined;
  revocations: ReadonlyArray<SecurityRevocation>;
  /** Connected to an environment whose policy decides, but nothing verified yet. */
  awaitingPolicy: boolean;
  /** Managed runtime: whether a durable state store holds the accepted state. */
  acceptedStateDurable?: boolean;
}): void {
  if (input.privacy && input.awaitingPolicy) throw new PrivacyError('privacy_policy_unavailable');
  const status = privacyRuntimeStatus(input.pinned, input.privacy, input.revocations, input.acceptedStateDurable);
  if (status.reasons.includes('policy_revoked')) throw new PrivacyError('privacy_policy_revoked');
  if (status.state === 'refused') throw new PrivacyError('privacy_not_configured');
}
