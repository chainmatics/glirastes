/**
 * The model-call facades of the SDK. Every language-model call of a server
 * path goes through one of these functions, and the egress check
 * (`scripts/check-model-egress.ts`) refuses a direct `ai` call anywhere else.
 *
 * Each call states its protection explicitly:
 * - a privacy boundary (or anything with its `wrapModel`) wraps the model
 *   before the call, so the request is checked as a whole;
 * - `null` declares the call outside the protected-text profile (a handler
 *   without `privacy`). That is a visible decision at the call site, not a
 *   silent default.
 */
import {
  generateObject as aiGenerateObject,
  generateText as aiGenerateText,
  streamText as aiStreamText,
} from 'ai';
import { PrivacyError } from './detection-result.js';
import { isPrivacyWrappedModel } from './model-boundary.js';

/** Something that wraps a model with the privacy boundary of one scope. */
export interface ModelCallProtection {
  wrapModel<M>(model: M): M;
}

type StreamTextParams = Parameters<typeof aiStreamText>[0];
type GenerateTextParams = Parameters<typeof aiGenerateText>[0];

function protect<P extends { model: unknown }>(params: P, protection: ModelCallProtection | null): P {
  if (protection === null) return params;
  if (typeof protection?.wrapModel !== 'function') throw new PrivacyError('privacy_scope_invalid');
  const model = protection.wrapModel(params.model);
  // A wrapper that hands the model back unchanged would send it unprotected.
  if (!isPrivacyWrappedModel(model)) throw new PrivacyError('privacy_unsupported_content');
  return { ...params, model };
}

export function protectedStreamText<P extends StreamTextParams>(
  params: P,
  protection: ModelCallProtection | null,
): ReturnType<typeof aiStreamText> {
  return aiStreamText(protect(params, protection) as StreamTextParams);
}

export function protectedGenerateText<P extends GenerateTextParams>(
  params: P,
  protection: ModelCallProtection | null,
): ReturnType<typeof aiGenerateText> {
  return aiGenerateText(protect(params, protection) as GenerateTextParams);
}

/**
 * `generateObject` with the protection applied. The schema, its
 * descriptions and the produced object pass the same boundary; the caller
 * rehydrates the object for display with `session.rehydrateJson`.
 */
export function protectedGenerateObject(
  params: Parameters<typeof aiGenerateObject>[0],
  protection: ModelCallProtection | null,
): ReturnType<typeof aiGenerateObject> {
  return aiGenerateObject(protect(params as { model: unknown }, protection) as never);
}
