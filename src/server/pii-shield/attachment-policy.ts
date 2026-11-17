import { PrivacyError } from './detection-result.js';

/**
 * How screenshots reach the model in the protected profile.
 * - `blocked` (default): no image leaves the host; history images are withheld.
 * - `allow-original`: images go unredacted to the selected vision-capable
 *   model. This is a documented exception from the protection of image
 *   content, not an image redaction. Text stays protected either way.
 */
export type ScreenshotMode = 'blocked' | 'allow-original';

export const SCREENSHOT_MODES: readonly ScreenshotMode[] = ['blocked', 'allow-original'];

/** Image types `allow-original` may send. Anything else is withheld. */
export const DEFAULT_ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export interface AttachmentPolicyInput {
  /** The integrator's ceiling for the app/environment. Default `blocked`. */
  app?: ScreenshotMode;
  /** An optional, stricter tenant rule (never widens the app rule). */
  tenant?: ScreenshotMode;
  /**
   * The mode an authorized user chose. Applied only within the app and tenant
   * rules; a browser-supplied flag can never lift a stricter rule.
   */
  user?: ScreenshotMode;
  allowedImageTypes?: readonly string[];
}

/** Immutable per-turn decision. A rule change applies from the next turn on. */
export interface AttachmentPolicySnapshot {
  readonly screenshots: ScreenshotMode;
  readonly allowedImageTypes: readonly string[];
  /** Content-free provenance for audits: which rule decided. */
  readonly decidedBy: 'app' | 'tenant' | 'user' | 'default' | 'policy';
}

const RANK: Record<ScreenshotMode, number> = { blocked: 0, 'allow-original': 1 };

function valid(mode: unknown): mode is ScreenshotMode {
  return mode === 'blocked' || mode === 'allow-original';
}

/**
 * The most restrictive of app, tenant and user rule. An unknown value is
 * treated as `blocked`, so a malformed setting can never open the path.
 */
export function resolveAttachmentPolicy(input: AttachmentPolicyInput = {}): AttachmentPolicySnapshot {
  const candidates: Array<[AttachmentPolicySnapshot['decidedBy'], ScreenshotMode]> = [
    ['app', valid(input.app) ? input.app : 'blocked'],
  ];
  if (input.tenant !== undefined) candidates.push(['tenant', valid(input.tenant) ? input.tenant : 'blocked']);
  if (input.user !== undefined) candidates.push(['user', valid(input.user) ? input.user : 'blocked']);
  let decided = candidates[0]!;
  for (const candidate of candidates) {
    if (RANK[candidate[1]] < RANK[decided[1]]) decided = candidate;
  }
  return Object.freeze({
    screenshots: decided[1],
    allowedImageTypes: Object.freeze([...(input.allowedImageTypes ?? DEFAULT_ALLOWED_IMAGE_TYPES)]),
    decidedBy: input.app === undefined && decided[0] === 'app' ? 'default' : decided[0],
  });
}

export const BLOCKED_ATTACHMENTS: AttachmentPolicySnapshot = resolveAttachmentPolicy();

/**
 * Narrows a turn's attachment rule to the effective privacy policy: the
 * stricter mode and only image types both allow. The policy never widens
 * the local rule.
 */
export function constrainAttachmentPolicy(
  snapshot: AttachmentPolicySnapshot,
  policy: { mode: ScreenshotMode; imageTypes: readonly string[] },
): AttachmentPolicySnapshot {
  const policyMode: ScreenshotMode = valid(policy.mode) ? policy.mode : 'blocked';
  const types = snapshot.allowedImageTypes.filter((type) => policy.imageTypes.includes(type.toLowerCase()));
  const stricter = RANK[policyMode] < RANK[snapshot.screenshots];
  const screenshots: ScreenshotMode = stricter || types.length === 0 ? 'blocked' : snapshot.screenshots;
  return Object.freeze({
    screenshots,
    allowedImageTypes: Object.freeze(types),
    decidedBy: screenshots !== snapshot.screenshots ? 'policy' : snapshot.decidedBy,
  });
}

export interface FilePartLike {
  mediaType?: string;
  data?: unknown;
  url?: unknown;
}

/** Inline image data (bytes, base64 or a data: URL); never a remote URL. */
function isInlineData(data: unknown): boolean {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return true;
  if (data instanceof URL) return data.protocol === 'data:';
  if (typeof data === 'string') return !/^[a-z][a-z0-9+.-]*:\/\//i.test(data) || data.startsWith('data:');
  return false;
}

/**
 * Whether one file part may reach a model with `visionCapable`. Returns the
 * stop code otherwise: PDFs, audio, other types, remote URLs and
 * non-vision models are always withheld.
 */
export function attachmentDecision(
  part: FilePartLike,
  policy: AttachmentPolicySnapshot,
  visionCapable: boolean,
): { allowed: true } | { allowed: false; code: 'privacy_attachment_blocked' | 'provider_capability_missing' } {
  if (policy.screenshots !== 'allow-original') return { allowed: false, code: 'privacy_attachment_blocked' };
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType.toLowerCase() : '';
  if (!policy.allowedImageTypes.includes(mediaType)) return { allowed: false, code: 'privacy_attachment_blocked' };
  const data = part.data !== undefined ? part.data : part.url;
  if (!isInlineData(data)) return { allowed: false, code: 'privacy_attachment_blocked' };
  if (!visionCapable) return { allowed: false, code: 'provider_capability_missing' };
  return { allowed: true };
}

export function assertAttachmentAllowed(part: FilePartLike, policy: AttachmentPolicySnapshot, visionCapable: boolean): void {
  const decision = attachmentDecision(part, policy, visionCapable);
  if (!decision.allowed) throw new PrivacyError(decision.code);
}

/** User-facing status text (German and English) for the effective rule. */
export function screenshotStatusText(policy: AttachmentPolicySnapshot, locale = 'de'): string {
  const de = locale.toLowerCase().startsWith('de');
  if (policy.screenshots === 'allow-original') {
    return de
      ? 'Text geschützt; Screenshots werden im Original übertragen'
      : 'Text protected; screenshots are sent unredacted';
  }
  return de ? 'Text geschützt; Screenshots sind gesperrt' : 'Text protected; screenshots are blocked';
}
