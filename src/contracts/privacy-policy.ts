/**
 * The Platform-managed privacy policy (protected-text profile).
 *
 * The Platform configures, versions and signs this block as part of the
 * runtime policy revision; the runner pins it per turn and enforces it
 * locally. Every field is content-free: ids, enums, numbers and digests.
 * Secrets, the mapping database, the keyring, identity sources and the
 * speech service address stay in the consumer's environment and never
 * appear here.
 *
 * Shared with the Platform through `__vectors__/privacy-policy.v1.json`.
 */
import { z } from 'zod';

/** Block versions this SDK understands; the runner reports them as a capability. */
export const PRIVACY_POLICY_SCHEMA_VERSIONS = [1] as const;

export const PRIVACY_PROFILES = ['off', 'protected-text/v1'] as const;

/** Image types a screenshot may have when the policy names none. */
export const DEFAULT_PRIVACY_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;

export const PrivacyEntryIdSchema = z.string().regex(SLUG);
export const PrivacyDigestSchema = z.string().regex(DIGEST);
export const PrivacyImageTypeSchema = z.enum(DEFAULT_PRIVACY_IMAGE_TYPES);
export const PrivacyScreenshotModeSchema = z.enum(['blocked', 'allow-original']);

export const PrivacyProviderApprovalSchema = z.object({
  entryId: PrivacyEntryIdSchema,
  /** `providerBindingDigest` of the approved, non-secret provider target. */
  bindingDigest: PrivacyDigestSchema,
}).strict();

const ProtectedTextBlockSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.literal('protected-text/v1'),
  screenshots: z.object({
    mode: PrivacyScreenshotModeSchema,
    /** Absent: `DEFAULT_PRIVACY_IMAGE_TYPES`. */
    imageTypes: z.array(PrivacyImageTypeSchema).min(1).max(3).optional(),
  }).strict(),
  providers: z.object({
    allowed: z.array(PrivacyProviderApprovalSchema).min(1).max(32),
    defaultEntryId: PrivacyEntryIdSchema,
    /** An authorized user may choose among `allowed`; never a free URL or model. */
    userChoice: z.boolean(),
    /**
     * OpenRouter upstream providers. Absent: no upstream restriction beyond
     * the strict routing the SDK always sets. Never empty.
     */
    openRouterOnly: z.array(z.string().regex(SLUG)).min(1).max(16).optional(),
  }).strict(),
  mapping: z.object({
    idleTtlSeconds: z.number().int().min(60).max(86_400),
    absoluteTtlSeconds: z.number().int().min(300).max(604_800),
  }).strict(),
  speech: z.object({
    /** Stage 1: speech is transcribed by the consumer's own service only. */
    localOnly: z.literal(true),
    maxDurationSeconds: z.number().int().min(5).max(600),
  }).strict(),
}).strict().superRefine((block, context) => {
  const ids = block.providers.allowed.map((entry) => entry.entryId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Provider entry ids are unique', path: ['providers', 'allowed'] });
  }
  if (!ids.includes(block.providers.defaultEntryId)) {
    context.addIssue({ code: 'custom', message: 'The default provider is one of the allowed entries', path: ['providers', 'defaultEntryId'] });
  }
  if (block.mapping.idleTtlSeconds > block.mapping.absoluteTtlSeconds) {
    context.addIssue({ code: 'custom', message: 'The idle lifetime is at most the absolute lifetime', path: ['mapping', 'idleTtlSeconds'] });
  }
  for (const [key, list] of [['imageTypes', block.screenshots.imageTypes], ['openRouterOnly', block.providers.openRouterOnly]] as const) {
    if (list && new Set(list).size !== list.length) {
      context.addIssue({ code: 'custom', message: 'List values are unique', path: [key] });
    }
  }
});

const OffBlockSchema = z.object({
  schemaVersion: z.literal(1),
  /** An explicit, signed decision to switch the Platform profile off. */
  profile: z.literal('off'),
}).strict();

export const PrivacyPolicyBlockSchema = z.union([ProtectedTextBlockSchema, OffBlockSchema]);

export type PrivacyPolicyBlock = z.infer<typeof PrivacyPolicyBlockSchema>;
export type ProtectedTextPolicyBlock = z.infer<typeof ProtectedTextBlockSchema>;
export type PrivacyProviderApproval = z.infer<typeof PrivacyProviderApprovalSchema>;
export type PrivacyImageType = z.infer<typeof PrivacyImageTypeSchema>;

export function isProtectedPolicy(block: PrivacyPolicyBlock | undefined | null): block is ProtectedTextPolicyBlock {
  return block?.profile === 'protected-text/v1';
}

// ---------------------------------------------------------------------------
// Provider binding (what an approval is bound to)
// ---------------------------------------------------------------------------

/**
 * The non-secret, security-relevant properties of one provider entry. Its
 * digest (`providerBindingDigest`) is what the Platform approves together
 * with the entry id: re-pointing the same id at another endpoint, model or a
 * more permissive routing changes the digest. Secret values and secret names
 * are never part of it, so rotating a key keeps the approval.
 */
export const ProviderBindingSchema = z.object({
  v: z.literal(1),
  adapter: PrivacyEntryIdSchema,
  adapterProtocol: z.string().regex(SLUG),
  /** `normalizeProviderEndpoint` of the base URL. */
  endpoint: z.string().min(1).max(512),
  modelId: z.string().min(1).max(200),
  routing: z.object({
    allowFallbacks: z.boolean().optional(),
    dataCollection: z.enum(['allow', 'deny']).optional(),
    zdr: z.boolean().optional(),
    only: z.array(z.string().regex(SLUG)).max(16).optional(),
  }).strict(),
  capabilities: z.object({ images: z.boolean() }).strict(),
}).strict();

export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;

/** Lowercase scheme and host, no userinfo, query, fragment or trailing slash. */
export function normalizeProviderEndpoint(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '');
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${path}`;
}

/** What the setup artifact reports per selectable provider entry. */
export const PrivacyProviderReportSchema = z.object({
  id: PrivacyEntryIdSchema,
  label: z.string().trim().min(1).max(80),
  adapter: PrivacyEntryIdSchema,
  bindingDigest: PrivacyDigestSchema,
}).strict();

export type PrivacyProviderReport = z.infer<typeof PrivacyProviderReportSchema>;

// ---------------------------------------------------------------------------
// Local merge: the consumer may only tighten
// ---------------------------------------------------------------------------

/** What the consumer configures locally. Every field may only make the policy stricter. */
export interface LocalPrivacyPolicy {
  /** Require the protected profile even when the Platform says `off` or nothing. */
  required?: boolean;
  screenshots?: { mode?: 'blocked' | 'allow-original'; imageTypes?: readonly PrivacyImageType[] };
  /** Entry ids the consumer offers at all; absent: every local entry. */
  providerEntryIds?: readonly string[];
  openRouterOnly?: readonly string[];
  mapping?: { idleTtlSeconds?: number; absoluteTtlSeconds?: number };
  speech?: { maxDurationSeconds?: number };
}

export const PRIVACY_LOCAL_RESTRICTION_CODES = [
  'local_profile_required',
  'local_screenshots_stricter',
  'local_image_types_narrower',
  'local_providers_narrower',
  'local_openrouter_narrower',
  'local_ttl_shorter',
  'local_speech_shorter',
] as const;

export type PrivacyLocalRestrictionCode = typeof PRIVACY_LOCAL_RESTRICTION_CODES[number];

export interface EffectivePrivacyPolicy {
  profile: 'protected-text/v1';
  /** `platform`: a signed block applies; `local`: only the consumer requires the profile. */
  source: 'platform' | 'local';
  screenshots: { mode: 'blocked' | 'allow-original'; imageTypes: PrivacyImageType[] };
  providers: {
    /** Approved entries whose local binding matches. `null`: no Platform approval applies (local source). */
    allowed: PrivacyProviderApproval[] | null;
    /** `null` when the default is not usable: resolving it fails, there is no substitute. */
    defaultEntryId: string | null;
    userChoice: boolean;
    /** Upstream restriction; an empty list blocks every OpenRouter entry. */
    openRouterOnly?: string[];
  };
  mapping: { idleTtlSeconds: number; absoluteTtlSeconds: number };
  speech: { localOnly: true; maxDurationSeconds: number };
  localRestrictions: PrivacyLocalRestrictionCode[];
  /** Approved entries whose local binding is missing or differs (content-free ids). */
  unmatchedEntryIds: string[];
}

export const PRIVACY_LOCAL_DEFAULTS = Object.freeze({
  idleTtlSeconds: 3_600,
  absoluteTtlSeconds: 86_400,
  maxDurationSeconds: 60,
});

const SCREENSHOT_RANK = { blocked: 0, 'allow-original': 1 } as const;

/** The consumer's provider registry as the merge sees it: ids and binding digests, never secrets. */
export interface LocalPrivacyProviders {
  /** Entry id → `providerBindingDigest` of every local entry. */
  bindings: Readonly<Record<string, string>>;
  /** The registry's own default, used when no Platform block applies. */
  defaultEntryId?: string;
}

/**
 * The policy a turn enforces. Without a protected Platform block and
 * without a local requirement the result is `null` (profile off). Local
 * values only ever tighten: stricter screenshot mode, intersected lists,
 * shorter lifetimes. An empty intersection blocks; there is no substitute.
 */
export function mergePrivacyPolicy(
  platform: PrivacyPolicyBlock | undefined | null,
  local: LocalPrivacyPolicy,
  providers: LocalPrivacyProviders = { bindings: {} },
): EffectivePrivacyPolicy | null {
  const localBindings = providers.bindings;
  const fromPlatform = isProtectedPolicy(platform);
  if (!fromPlatform && !local.required) return null;
  const restrictions = new Set<PrivacyLocalRestrictionCode>();
  if (!fromPlatform) restrictions.add('local_profile_required');

  // Screenshots
  const platformMode = fromPlatform ? platform.screenshots.mode : 'blocked';
  const localMode = local.screenshots?.mode ?? platformMode;
  const platformTypes = fromPlatform ? platform.screenshots.imageTypes ?? DEFAULT_PRIVACY_IMAGE_TYPES : DEFAULT_PRIVACY_IMAGE_TYPES;
  const imageTypes = local.screenshots?.imageTypes
    ? platformTypes.filter((type) => local.screenshots!.imageTypes!.includes(type))
    : [...platformTypes];
  if (imageTypes.length < platformTypes.length) restrictions.add('local_image_types_narrower');
  // No image type left: nothing can be sent, so screenshots are blocked.
  const mode = imageTypes.length === 0 || SCREENSHOT_RANK[localMode] < SCREENSHOT_RANK[platformMode] ? 'blocked' : platformMode;
  if (mode !== platformMode) restrictions.add('local_screenshots_stricter');

  // Providers
  const offered = (id: string) => !local.providerEntryIds || local.providerEntryIds.includes(id);
  let allowed: PrivacyProviderApproval[] | null = null;
  const unmatched: string[] = [];
  let defaultEntryId: string | null = null;
  let userChoice = true;
  if (fromPlatform) {
    allowed = [];
    for (const approval of platform.providers.allowed) {
      if (!Object.hasOwn(localBindings, approval.entryId) || localBindings[approval.entryId] !== approval.bindingDigest) {
        unmatched.push(approval.entryId);
        continue;
      }
      if (!offered(approval.entryId)) {
        restrictions.add('local_providers_narrower');
        continue;
      }
      allowed.push({ ...approval });
    }
    defaultEntryId = allowed.some((a) => a.entryId === platform.providers.defaultEntryId) ? platform.providers.defaultEntryId : null;
    userChoice = platform.providers.userChoice;
  } else {
    const fallback = providers.defaultEntryId;
    defaultEntryId = fallback !== undefined && Object.hasOwn(localBindings, fallback) && offered(fallback) ? fallback : null;
  }

  // OpenRouter upstream restriction
  const platformOnly = fromPlatform ? platform.providers.openRouterOnly : undefined;
  let openRouterOnly: string[] | undefined;
  if (platformOnly && local.openRouterOnly) {
    openRouterOnly = platformOnly.filter((slug) => local.openRouterOnly!.includes(slug));
    if (openRouterOnly.length < platformOnly.length) restrictions.add('local_openrouter_narrower');
  } else if (platformOnly) {
    openRouterOnly = [...platformOnly];
  } else if (local.openRouterOnly) {
    openRouterOnly = [...local.openRouterOnly];
    if (fromPlatform) restrictions.add('local_openrouter_narrower');
  }

  // Lifetimes and speech
  const base = fromPlatform
    ? { idle: platform.mapping.idleTtlSeconds, absolute: platform.mapping.absoluteTtlSeconds, speech: platform.speech.maxDurationSeconds }
    : { idle: PRIVACY_LOCAL_DEFAULTS.idleTtlSeconds, absolute: PRIVACY_LOCAL_DEFAULTS.absoluteTtlSeconds, speech: PRIVACY_LOCAL_DEFAULTS.maxDurationSeconds };
  const absolute = Math.min(base.absolute, local.mapping?.absoluteTtlSeconds ?? Infinity);
  const idle = Math.min(base.idle, local.mapping?.idleTtlSeconds ?? Infinity, absolute);
  if (fromPlatform && (absolute < base.absolute || idle < base.idle)) restrictions.add('local_ttl_shorter');
  const maxDurationSeconds = Math.min(base.speech, local.speech?.maxDurationSeconds ?? Infinity);
  if (fromPlatform && maxDurationSeconds < base.speech) restrictions.add('local_speech_shorter');

  return {
    profile: 'protected-text/v1',
    source: fromPlatform ? 'platform' : 'local',
    screenshots: { mode, imageTypes },
    providers: { allowed, defaultEntryId, userChoice, ...(openRouterOnly ? { openRouterOnly } : {}) },
    mapping: { idleTtlSeconds: idle, absoluteTtlSeconds: absolute },
    speech: { localOnly: true, maxDurationSeconds },
    localRestrictions: PRIVACY_LOCAL_RESTRICTION_CODES.filter((code) => restrictions.has(code)),
    unmatchedEntryIds: unmatched,
  };
}

// ---------------------------------------------------------------------------
// Loosening: which changes need a security approval
// ---------------------------------------------------------------------------

export const PRIVACY_LOOSENING_CODES = [
  'block_removed',
  'profile_off',
  'screenshots_allow_original',
  'image_types_added',
  'provider_binding_added',
  'default_provider_changed',
  'user_choice_enabled',
  'openrouter_only_removed',
  'openrouter_only_widened',
  'mapping_ttl_extended',
  'speech_duration_extended',
] as const;

export type PrivacyLooseningCode = typeof PRIVACY_LOOSENING_CODES[number];

/**
 * Compares a candidate block with the authoritative published predecessor.
 * Every returned code makes the publication security-critical. A first
 * protected block and every tightening return nothing. Run it on every
 * path that can change the effective policy: saving a draft, publishing a
 * configuration, the direct policy API and rollback.
 */
export function privacyLoosening(
  previous: PrivacyPolicyBlock | undefined | null,
  next: PrivacyPolicyBlock | undefined | null,
): PrivacyLooseningCode[] {
  if (!isProtectedPolicy(previous)) return [];
  if (!next) return ['block_removed'];
  if (!isProtectedPolicy(next)) return ['profile_off'];
  const codes = new Set<PrivacyLooseningCode>();
  if (previous.screenshots.mode === 'blocked' && next.screenshots.mode === 'allow-original') codes.add('screenshots_allow_original');
  const previousTypes = previous.screenshots.imageTypes ?? DEFAULT_PRIVACY_IMAGE_TYPES;
  const nextTypes = next.screenshots.imageTypes ?? DEFAULT_PRIVACY_IMAGE_TYPES;
  if (nextTypes.some((type) => !previousTypes.includes(type))) codes.add('image_types_added');
  const approved = new Set(previous.providers.allowed.map((a) => `${a.entryId}\u0000${a.bindingDigest}`));
  if (next.providers.allowed.some((a) => !approved.has(`${a.entryId}\u0000${a.bindingDigest}`))) codes.add('provider_binding_added');
  if (next.providers.defaultEntryId !== previous.providers.defaultEntryId) codes.add('default_provider_changed');
  if (!previous.providers.userChoice && next.providers.userChoice) codes.add('user_choice_enabled');
  const previousOnly = previous.providers.openRouterOnly;
  const nextOnly = next.providers.openRouterOnly;
  if (previousOnly && !nextOnly) codes.add('openrouter_only_removed');
  if (previousOnly && nextOnly && nextOnly.some((slug) => !previousOnly.includes(slug))) codes.add('openrouter_only_widened');
  if (next.mapping.idleTtlSeconds > previous.mapping.idleTtlSeconds || next.mapping.absoluteTtlSeconds > previous.mapping.absoluteTtlSeconds) {
    codes.add('mapping_ttl_extended');
  }
  if (next.speech.maxDurationSeconds > previous.speech.maxDurationSeconds) codes.add('speech_duration_extended');
  return PRIVACY_LOOSENING_CODES.filter((code) => codes.has(code));
}

// ---------------------------------------------------------------------------
// Runtime status (heartbeat) and decision events
// ---------------------------------------------------------------------------

export const PRIVACY_RUNTIME_STATES = [
  /** No protected policy applies (none published and none required locally). */
  'off',
  /** The pinned policy is enforced. */
  'enforced',
  /** A protected policy cannot be enforced here (store, keyring or provider binding missing); AI traffic is blocked. */
  'refused',
  /** A signed revision would lower the privacy floor and was rejected. */
  'downgrade-rejected',
  /** Managed mode without a verified policy yet; AI traffic is blocked. */
  'awaiting-policy',
] as const;

export const PRIVACY_RUNTIME_REASONS = [
  'store_missing',
  'keyring_missing',
  'provider_binding_missing',
  'provider_default_unusable',
  'policy_revoked',
  'policy_downgrade',
  'accepted_state_missing',
] as const;

/** Content-free privacy state a runner reports in its heartbeat (`technicalMetadata.privacy`). */
export const PrivacyRuntimeStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(PRIVACY_RUNTIME_STATES),
  policyRevisionId: z.uuid().nullable(),
  /** Digest of the signed block the runner pinned, or `null` without one. */
  publishedPolicyDigest: PrivacyDigestSchema.nullable(),
  /** Digest of the policy the runner enforces after local tightening. */
  effectivePolicyDigest: PrivacyDigestSchema.nullable(),
  localRestrictions: z.array(z.enum(PRIVACY_LOCAL_RESTRICTION_CODES)).max(PRIVACY_LOCAL_RESTRICTION_CODES.length),
  reasons: z.array(z.enum(PRIVACY_RUNTIME_REASONS)).max(PRIVACY_RUNTIME_REASONS.length),
}).strict();

export type PrivacyRuntimeStatus = z.infer<typeof PrivacyRuntimeStatusSchema>;

/**
 * Codes a `privacy.decisions` event may count. Refusal codes come from the
 * protected-text boundary; the positive codes are emitted only where the
 * protection actually ran. Counts prove that the runtime reported
 * protected calls, not that no other path sent anything: the egress
 * inventory and the capture tests stay separate evidence.
 */
export const PRIVACY_DECISION_CODES = [
  'turn_protected',
  'model_call_protected',
  'tool_call_rehydrated',
  'privacy_detector_unavailable',
  'privacy_detector_invalid_result',
  'privacy_scope_invalid',
  'privacy_mapping_unavailable',
  'privacy_mapping_deleted',
  'privacy_mapping_expired',
  'privacy_mapping_conflict',
  'privacy_key_unavailable',
  'privacy_store_not_persistent',
  'privacy_remote_detector_rejected',
  'privacy_binary_content_blocked',
  'privacy_attachment_blocked',
  'privacy_provider_option_blocked',
  'privacy_tool_schema_blocked',
  'privacy_output_leak',
  'privacy_output_incomplete',
  'privacy_unsupported_content',
  'privacy_tool_failed',
  'privacy_tool_outcome_unknown',
  'privacy_not_configured',
  'privacy_policy_unavailable',
  'privacy_policy_revoked',
  'privacy_policy_downgrade',
  'provider_not_allowed',
  'provider_capability_missing',
  'provider_unavailable',
] as const;

export type PrivacyDecisionCode = typeof PRIVACY_DECISION_CODES[number];

export const PRIVACY_DECISION_MAX_COUNT = 1_000_000;
export const PRIVACY_DECISION_MAX_WINDOW_MS = 3_600_000;
