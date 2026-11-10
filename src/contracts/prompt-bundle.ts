import { z } from 'zod';
import { findForbiddenPlatformContentPath } from './content-boundary.js';
import { RevisionSignatureSchema } from './revisions.js';

const uuid = z.uuid();
const identifier = z.string().trim().min(1).max(200);
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);
const timestamp = z.iso.datetime({ offset: true });

const CapabilityFragmentSchema = z.object({
  id: identifier,
  content: z.string().trim().min(1).max(100_000),
}).strict();

export const PromptBundleSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: uuid,
  appId: uuid,
  revisionId: uuid,
  revision: z.number().int().positive(),
  parentRevisionId: uuid.optional(),
  bundleDigest: digest,
  sections: z.object({
    planner: z.string().trim().min(1).max(100_000),
    appBehavior: z.string().trim().min(1).max(100_000),
    responseStyle: z.string().trim().min(1).max(100_000),
    capabilityFragments: z.array(CapabilityFragmentSchema).default([]),
  }).strict(),
  createdAt: timestamp,
  signature: RevisionSignatureSchema,
}).strict();

/**
 * Signed desired-state pin for one prompt bundle. The Platform signs the
 * binding; the bundle contents stay in the customer-controlled registry and are
 * proven by the content digest.
 */
// Moved to revisions.ts, which the deployment bundle also lives in; re-exported
// here so existing import paths keep working.
export {
  SignedPromptBindingSchema,
  type SignedPromptBinding,
} from './revisions.js';

export const PromptRevisionMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: uuid,
  appId: uuid,
  revision: z.number().int().positive(),
  bundleDigest: digest,
  artifactRef: z.string().trim().min(1).max(2_048),
  plannerDigest: digest,
  groupDigests: z.record(identifier, digest),
  parentRevisionId: uuid.optional(),
  createdAt: timestamp,
}).strict().superRefine((metadata, context) => {
  const forbiddenPath = findForbiddenPlatformContentPath(metadata);
  if (forbiddenPath) {
    context.addIssue({
      code: 'custom',
      message: 'Prompt revision metadata contains prohibited content',
      path: forbiddenPath,
    });
  }
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function canonicalPromptBundleJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export type PromptBundle = z.infer<typeof PromptBundleSchema>;
export type PromptRevisionMetadata = z.infer<
  typeof PromptRevisionMetadataSchema
>;
