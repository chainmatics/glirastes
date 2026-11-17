import type { PiiDetector, PiiEntity } from '../../types.js';

/**
 * Stable, content-free codes of the protected-text privacy boundary. A code
 * never carries user text, a detected value, a mapping or a provider body, so
 * it may be logged, traced and shown to the user.
 */
export type PrivacyErrorCode =
  | 'privacy_detector_unavailable'
  | 'privacy_detector_invalid_result'
  | 'privacy_scope_invalid'
  | 'privacy_mapping_unavailable'
  | 'privacy_mapping_deleted'
  | 'privacy_mapping_conflict'
  | 'privacy_key_unavailable'
  | 'privacy_store_not_persistent'
  | 'privacy_remote_detector_rejected'
  | 'privacy_binary_content_blocked'
  | 'privacy_attachment_blocked'
  | 'privacy_provider_option_blocked'
  | 'privacy_tool_schema_blocked'
  | 'privacy_output_leak'
  | 'privacy_unsupported_content'
  | 'privacy_tool_failed'
  | 'privacy_tool_outcome_unknown'
  | 'provider_not_allowed'
  | 'provider_capability_missing'
  | 'provider_unavailable';

const MESSAGES: Record<PrivacyErrorCode, string> = {
  privacy_detector_unavailable: 'The privacy detector is unavailable.',
  privacy_detector_invalid_result: 'The privacy detector returned an invalid result.',
  privacy_scope_invalid: 'The privacy scope is incomplete or invalid.',
  privacy_mapping_unavailable: 'The privacy mapping store is unavailable.',
  privacy_mapping_deleted: 'The privacy mapping of this conversation was deleted.',
  privacy_mapping_conflict: 'The privacy mapping changed concurrently.',
  privacy_key_unavailable: 'A privacy mapping key is unavailable.',
  privacy_store_not_persistent: 'The protected profile requires a persistent mapping store.',
  privacy_remote_detector_rejected: 'A remote detector is not accepted in the protected profile.',
  privacy_binary_content_blocked: 'Binary content is blocked by the privacy policy.',
  privacy_attachment_blocked: 'Attachments are blocked by the privacy policy.',
  privacy_provider_option_blocked: 'A provider option is not allowed in the protected profile.',
  privacy_tool_schema_blocked: 'A tool schema contains protected values.',
  privacy_output_leak: 'The model output contained a protected original value.',
  privacy_unsupported_content: 'The request contains content the privacy boundary cannot check.',
  privacy_tool_failed: 'The tool failed.',
  privacy_tool_outcome_unknown: 'The tool outcome is unknown; reconcile before retrying.',
  provider_not_allowed: 'The selected model provider is not allowed.',
  provider_capability_missing: 'The selected model lacks a required capability.',
  provider_unavailable: 'The selected model provider is not configured on the server.',
};

/** A privacy stop. Its message is fixed per code and never contains content. */
export class PrivacyError extends Error {
  readonly code: PrivacyErrorCode;
  constructor(code: PrivacyErrorCode) {
    super(MESSAGES[code]);
    this.name = 'PrivacyError';
    this.code = code;
  }
  toJSON(): { name: string; code: PrivacyErrorCode } {
    return { name: this.name, code: this.code };
  }
}

export function isPrivacyError(error: unknown): error is PrivacyError {
  return error instanceof PrivacyError
    || (typeof error === 'object' && error !== null
      && (error as { name?: unknown }).name === 'PrivacyError'
      && typeof (error as { code?: unknown }).code === 'string'
      && (error as { code: string }).code in MESSAGES);
}

/** What callbacks and logs receive in the protected profile: no message, no stack, no cause. */
export interface SafeErrorSummary {
  name: string;
  code: string;
}

/**
 * Reduces any error to a content-free summary. Unknown errors become
 * `unknown_error`; only privacy codes and an allowlisted `name` survive.
 */
export function toSafeError(error: unknown): SafeErrorSummary {
  if (isPrivacyError(error)) return { name: 'PrivacyError', code: error.code };
  const name = typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : 'Error';
  const safeName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
  if (safeName === 'AbortError') return { name: safeName, code: 'aborted' };
  return { name: safeName, code: 'unknown_error' };
}

/** Result of one strict detection: never "clean" because of a failure. */
export type DetectionResult =
  | { status: 'ok'; entities: PiiEntity[] }
  | { status: 'unavailable'; code: 'privacy_detector_unavailable' | 'privacy_detector_invalid_result' };

export interface StrictDetectorOptions {
  /** Deadline per call; a slower detector is unavailable, never clean. Default 2000 ms. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

/** Marks a detector that sends text off the host. Strict construction rejects it. */
export const REMOTE_DETECTOR = Symbol.for('glirastes.privacy.remoteDetector');

export function isRemoteDetector(detector: PiiDetector): boolean {
  return Boolean((detector as unknown as Record<symbol, unknown>)[REMOTE_DETECTOR]);
}

function validEntities(text: string, value: unknown): PiiEntity[] | null {
  if (!Array.isArray(value)) return null;
  const entities: PiiEntity[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entity = raw as Partial<PiiEntity>;
    if (
      typeof entity.type !== 'string'
      || !Number.isInteger(entity.start)
      || !Number.isInteger(entity.end)
      || typeof entity.text !== 'string'
    ) return null;
    const start = entity.start as number;
    const end = entity.end as number;
    if (start < 0 || end <= start || end > text.length) return null;
    if (text.slice(start, end) !== entity.text) return null;
    entities.push({
      type: entity.type,
      start,
      end,
      text: entity.text,
      score: typeof entity.score === 'number' ? entity.score : 1,
    });
  }
  return entities;
}

/**
 * Runs a detector under a deadline and validates its result. A throw, a
 * timeout, an abort, a malformed result or an offset that does not match the
 * text all yield `unavailable`. Zero entities from a successful run are `ok`.
 */
export async function detectStrict(
  detector: PiiDetector,
  text: string,
  locales: string[],
  options: StrictDetectorOptions = {},
): Promise<DetectionResult> {
  const deadlineMs = options.deadlineMs ?? 2000;
  if (options.signal?.aborted) return { status: 'unavailable', code: 'privacy_detector_unavailable' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => detector.detect(text, locales)).then(
        (value) => ({ kind: 'value' as const, value }),
        () => ({ kind: 'failed' as const }),
      ),
      new Promise<{ kind: 'failed' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'failed' }), deadlineMs);
        onAbort = () => resolve({ kind: 'failed' });
        options.signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (outcome.kind === 'failed') return { status: 'unavailable', code: 'privacy_detector_unavailable' };
    const entities = validEntities(text, outcome.value);
    if (!entities) return { status: 'unavailable', code: 'privacy_detector_invalid_result' };
    return { status: 'ok', entities };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Throwing form of {@link detectStrict} for the protected path. */
export async function detectOrThrow(
  detector: PiiDetector,
  text: string,
  locales: string[],
  options?: StrictDetectorOptions,
): Promise<PiiEntity[]> {
  const result = await detectStrict(detector, text, locales, options);
  if (result.status !== 'ok') throw new PrivacyError(result.code);
  return result.entities;
}
