import { z } from 'zod';
import { RUNTIME_METRIC_LABEL_PATTERN } from './events.js';

export const EVAL_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const EVAL_ATTESTATION_MAX_TOTAL = 100_000;

const digest = z.string().regex(/^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/);

/**
 * What a customer's CI reports about its own eval suite: digests and counts
 * only, never cases, inputs, outputs, prompts or model names. The Platform keys
 * the eval gate on `setupArtifactDigest` and `promptDigest`.
 */
export const EvalAttestationRequestSchema = z.object({
  schemaVersion: z.literal(EVAL_ATTESTATION_SCHEMA_VERSION),
  /** `.glirastes/setup-artifact.json#discoveryDigest`. */
  setupArtifactDigest: digest,
  /** `.glirastes/setup-artifact.json#prompts.bundleDigest`, the deployment's promptDigest. */
  promptDigest: digest,
  suiteDigest: digest,
  result: z.enum(['pass', 'fail']),
  total: z.number().int().min(1).max(EVAL_ATTESTATION_MAX_TOTAL),
  failed: z.number().int().min(0).max(EVAL_ATTESTATION_MAX_TOTAL),
  ranAt: z.iso.datetime({ offset: true }),
  ciRunRef: z.string().regex(RUNTIME_METRIC_LABEL_PATTERN).optional(),
}).strict().superRefine((body, context) => {
  if (body.failed > body.total) {
    context.addIssue({ code: 'custom', path: ['failed'], message: 'failed must not exceed total' });
  }
  if ((body.result === 'pass') !== (body.failed === 0)) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'result is pass exactly when failed is 0' });
  }
});

export const EvalAttestationResponseSchema = z.object({
  attestationId: z.string().min(1).max(200),
  recordedAt: z.iso.datetime({ offset: true }),
});

export type EvalAttestationRequest = z.infer<typeof EvalAttestationRequestSchema>;
export type EvalAttestationResponse = z.infer<typeof EvalAttestationResponseSchema>;
