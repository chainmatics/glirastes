/**
 * Digests of the privacy policy and of provider bindings. They use the same
 * canonical JSON as signed runtime revisions (`canonicalRuntimeJson`), so the
 * Platform computes identical values (shared golden vectors). A digest is a
 * plain SHA-256 of content-free policy data; it is not a secret and not keyed.
 */
import { createHash } from 'node:crypto';
import {
  PrivacyPolicyBlockSchema,
  ProviderBindingSchema,
  type EffectivePrivacyPolicy,
  type PrivacyPolicyBlock,
  type ProviderBinding,
} from '../contracts/privacy-policy.js';
import { canonicalRuntimeJson } from './signature-verifier.js';

/** `sha256:<base64url>` of the canonical JSON of a value. */
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalRuntimeJson(value)).digest('base64url')}`;
}

/** Digest of a signed privacy block, as the Platform publishes it. Throws for an invalid block. */
export function privacyPolicyDigest(block: PrivacyPolicyBlock): string {
  return canonicalDigest(PrivacyPolicyBlockSchema.parse(block));
}

/**
 * Digest of the policy a runner enforces after local tightening. The local
 * restriction codes are reported separately and are not part of it.
 */
export function effectivePrivacyPolicyDigest(policy: EffectivePrivacyPolicy): string {
  const { localRestrictions: _restrictions, unmatchedEntryIds: _unmatched, ...enforced } = policy;
  return canonicalDigest(enforced);
}

/**
 * Digest of a provider entry's non-secret target. The Platform approves an
 * entry id together with this digest; re-pointing the id at another
 * endpoint, model or a more permissive routing changes it. Throws for an
 * invalid binding.
 */
export function providerBindingDigest(binding: ProviderBinding): string {
  return canonicalDigest(ProviderBindingSchema.parse(binding));
}
